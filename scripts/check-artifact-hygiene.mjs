#!/usr/bin/env node
// Reject oversized or generated payloads before they enter history.
//
// Two blobs in this repository exceed GitHub's 100 MB hard limit (232 MB and 125 MB), and ten
// exceed its 50 MB warning threshold. Their presence made the published history unpushable, which
// forced a rewrite, which forked the published line from the local one -- twice. Nothing detected
// it at commit time; it surfaced only when publishing failed months later.
//
// This check runs against the INDEX (what is about to be committed) and against tracked files, so
// the failure lands on the commit that introduces it, naming the file and the rule it broke.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// GitHub rejects >100MB outright and warns >50MB. The ceiling sits below the warning so a file
// approaching the limit is caught while it is still easy to move, not at the moment of rejection.
export const MAX_TRACKED_BYTES = 10 * 1024 * 1024;
export const GENERATED_SUFFIXES = Object.freeze(['.json', '.html', '.jsonl', '.tar.gz']);
export const GENERATED_ROOTS = Object.freeze(['analysis/archive/', 'analysis/current-evidence/', 'analysis/review-packages/']);
// The custody pattern: manifests describe payloads by path + digest and are deliberately tracked.
export const CUSTODY_EXEMPT = Object.freeze(['analysis/run-manifests/']);

function gitPaths(args) {
  const output = execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return output.toString('utf8').split('\0').filter(Boolean);
}

function stagedFiles() {
  return gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM']);
}

export function trackedFiles() {
  return gitPaths(['ls-files', '-z']);
}

function sizeOf(path) {
  try { return statSync(resolve(path)).size; } catch { return 0; }
}

export function violations(paths, sizeLookup = sizeOf) {
  const found = [];
  for (const path of paths) {
    if (CUSTODY_EXEMPT.some(prefix => path.startsWith(prefix))) continue;
    const bytes = sizeLookup(path);
    if (bytes > MAX_TRACKED_BYTES) {
      found.push({ path, bytes, rule: `exceeds ${MAX_TRACKED_BYTES / 1048576} MB tracked-file ceiling` });
      continue;
    }
    const generatedRoot = GENERATED_ROOTS.find(root => path.startsWith(root));
    if (generatedRoot && GENERATED_SUFFIXES.some(suffix => path.endsWith(suffix))) {
      found.push({ path, bytes, rule: `generated payload under ${generatedRoot} must live in ignored custody` });
    }
  }
  return found;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv[0] && argv[0] !== '--tracked')) {
    throw new Error('usage: node scripts/check-artifact-hygiene.mjs [--tracked]');
  }
  const scope = argv[0] === '--tracked' ? 'tracked' : 'staged';
  const files = scope === 'tracked' ? trackedFiles() : stagedFiles();
  const found = violations(files);
  if (!found.length) {
    console.log(`artifact hygiene: PASS (${files.length} ${scope} file(s) checked)`);
    return 0;
  }
  console.error('artifact hygiene: FAIL');
  for (const row of found) {
    console.error(`  ${(row.bytes / 1048576).toFixed(1)} MB  ${row.path}`);
    console.error(`      ${row.rule}`);
  }
  console.error('\nGenerated output belongs in ignored custody with a tracked manifest under');
  console.error('analysis/run-manifests/ recording its path, size and digest. See .gitignore.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('check-artifact-hygiene.mjs')) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`artifact hygiene: ${error.message}`); process.exitCode = 1; }
}
