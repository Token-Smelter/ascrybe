import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { benchmarkPathExcluded, defaultExternalBenchmarkPolicy, isExcludedBenchmarkPath, validateBenchmarkPolicy } from './benchmark-policy.mjs';

export const OUTPUT_LIMIT_BYTES = 64 * 1024;

function positiveInteger(value, fallback, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  return parsed;
}
function bounded(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return bytes <= OUTPUT_LIMIT_BYTES ? value : { error: 'EVAL_TOOL_OUTPUT_LIMIT', bytes, maximum_bytes: OUTPUT_LIMIT_BYTES };
}
function schema() {
  return Object.freeze({ version: 'evaluation-filesystem-arm/v1', allowed_tool_names: ['find', 'grep', 'read'], tools: [
    { name: 'find', description: 'List at most 500 repository-relative paths matching a glob.', input: { glob: 'string' } },
    { name: 'grep', description: 'Search repository text within an optional path glob and return at most 200 file/line matches.', input: { pattern: 'string', regex: 'boolean?', glob: 'string? (default **/*)' } },
    { name: 'read', description: 'Read at most 400 lines from one repository-relative path.', input: { path: 'string', start_line: 'integer?', end_line: 'integer?' } },
  ] });
}
function safeRelativePath(root, requested) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new Error('repository-relative path required');
  const candidate = resolve(root, requested);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error('path escapes checkout');
  return candidate;
}
async function regularFile(root, requested) {
  const candidate = safeRelativePath(root, requested);
  const [metadata, canonical] = await Promise.all([lstat(candidate), realpath(candidate)]);
  if (!metadata.isFile() || !canonical.startsWith(`${root}${sep}`)) throw new Error('path is not a regular checkout file');
  return candidate;
}
function globToExpression(glob) {
  const input = String(glob ?? '**/*'); let expression = '';
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '*' && input[index + 1] === '*') {
      index += 1;
      if (input[index + 1] === '/') { index += 1; expression += '(?:.*/)?'; } else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${expression}$`, 'u');
}
async function walk(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.evals') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, files);
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
  }
  return files;
}
export function createFilesystemArm({ checkout, benchmark_policy = defaultExternalBenchmarkPolicy() }) {
  const root = resolve(checkout);
  const policy = validateBenchmarkPolicy(benchmark_policy);
  const excluded = path => {
    if (typeof path !== 'string' || path.includes('\0')) return false;
    const normalized = relative(root, resolve(root, path)).split(sep).join('/');
    return isExcludedBenchmarkPath(normalized, policy);
  };
  const files = async () => (await walk(root)).filter(path => !excluded(path)).sort();
  return Object.freeze({ schema: schema(), tools: Object.freeze({
    async find({ glob = '**/*' } = {}) {
      const matches = (await files()).filter(path => globToExpression(glob).test(path)).slice(0, 500);
      return bounded({ paths: matches, truncated: matches.length === 500 });
    },
    async grep({ pattern, regex = false, glob = '**/*' } = {}) {
      if (typeof pattern !== 'string' || !pattern) throw new Error('grep pattern required');
      if (typeof glob !== 'string' || !glob) throw new Error('grep glob must be a non-empty string');
      let matcher; try { matcher = regex ? new RegExp(pattern, 'gu') : null; } catch { throw new Error('grep regular expression is invalid'); }
      const scope = globToExpression(glob);
      const matches = [];
      for (const path of (await files()).filter(candidate => scope.test(candidate))) {
        if (matches.length >= 200) break;
        const source = await readFile(await regularFile(root, path), 'utf8'); if (source.includes('\0')) continue;
        for (const [index, line] of source.split(/\r?\n/u).entries()) {
          const found = matcher ? (matcher.lastIndex = 0, matcher.test(line)) : line.includes(pattern);
          if (found) matches.push({ path, line: index + 1, text: line });
          if (matches.length >= 200) break;
        }
      }
      return bounded({ matches, truncated: matches.length === 200 });
    },
    async read({ path, start_line = 1, end_line } = {}) {
      if (excluded(path)) throw benchmarkPathExcluded(path);
      const start = positiveInteger(start_line, 1, Number.MAX_SAFE_INTEGER, 'start_line');
      const end = end_line == null ? start + 399 : positiveInteger(end_line, start, Number.MAX_SAFE_INTEGER, 'end_line');
      if (end < start || end - start >= 400) throw new Error('read range must contain at most 400 lines');
      const source = await readFile(await regularFile(root, path), 'utf8'); const all = source.split(/\r?\n/u); const lines = all.slice(start - 1, end);
      return bounded({ path, start_line: start, end_line: start + lines.length - 1, text: lines.join('\n'), truncated: start + lines.length - 1 < all.length });
    },
  }) });
}
