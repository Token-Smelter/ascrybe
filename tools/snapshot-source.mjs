// Import only screened regular files into private Git custody; never stage through the source's index.
import { execFileSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isWithin } from './path-within.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { artifactRoot } from './artifact-state.mjs';
import { dispositionOf } from './ontology/estate-inventory.mjs';
import { screenUnit } from './ontology/estate-discovery.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const refuse = message => { throw new Error(`SNAPSHOT_REFUSED: ${message}`); };
const inside = (child, parent) => isWithin(parent, child);
const fixedIdentity = { GIT_AUTHOR_NAME: 'Snapshot importer', GIT_AUTHOR_EMAIL: 'snapshot@example.invalid', GIT_COMMITTER_NAME: 'Snapshot importer', GIT_COMMITTER_EMAIL: 'snapshot@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

export function snapshotSource({ root, id, authorizedRoots = [], stateRoot = artifactRoot({ repository }), forceGit = false, beforeConsistencyCheck = () => {} }) {
  if (!/^[a-z][a-z0-9_-]*$/u.test(id || '')) refuse('source id must be a manifest id');
  const source = realpathSync(root);
  if (!authorizedRoots.some(r => realpathSync(r) === source)) refuse('source root must be explicitly authorized (exact physical root)');
  if (!lstatSync(source).isDirectory()) refuse('source must be a directory');
  let inGit = false;
  try { inGit = execFileSync('git', ['-C', source, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { /* ordinary directory */ }
  if (inGit && !forceGit) refuse('already a Git work tree; use a normal Git source or explicitly force import');
  const state = artifactRoot({ repository, environment: { ...process.env, ASCRYBE_ARTIFACT_ROOT: stateRoot } });
  if (inside(state, source)) refuse('snapshot state must be outside the source');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (inside(realpathSync(state), source)) refuse('snapshot state resolves inside the source');
  const snapshots = join(state, 'snapshots');
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  if (lstatSync(snapshots).isSymbolicLink() || inside(realpathSync(snapshots), source)) refuse('snapshot custody must not alias the source');
  const repo = join(snapshots, `${id}.git`), lock = `${repo}.lock`;
  if (existsSync(repo) && lstatSync(repo).isSymbolicLink()) refuse('snapshot repository must not be a symlink');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { refuse('snapshot lock exists; inspect the prior importer before removing it'); }
  const env = { ...process.env, ...fixedIdentity, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/u.test(key)) delete env[key];
  const git = (args, input) => execFileSync('git', [`--git-dir=${repo}`, `--work-tree=${source}`, ...args], { env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    const existing = existsSync(repo);
    const binding = join(repo, 'snapshot-source.json');
    if (existing && !existsSync(binding)) refuse('existing repository is not a bound snapshot import');
    if (!existing) execFileSync('git', ['init', '--bare', repo], { env, stdio: 'pipe' });
    if (existsSync(binding) && JSON.parse(readFileSync(binding, 'utf8')).root !== source) refuse('source id is already bound to another root');
    writeFileSync(binding, JSON.stringify({ root: source, source_kind: 'snapshot_import' }), { mode: 0o600 });
    const exclude = join(repo, 'info', 'exclude');
    if (!existsSync(exclude)) writeFileSync(exclude, '', { mode: 0o600 });
    const collect = (store = false) => {
      const files = [], dispositions = [];
      const walk = (directory, prefix = '') => {
        const names = readdirSync(directory).sort();
        if (!names.length && prefix) dispositions.push({ path: prefix, disposition: 'not_read', rule: 'empty_directory_not_representable' });
        for (const name of names) {
          const path = prefix ? `${prefix}/${name}` : name, absolute = join(directory, name), stat = lstatSync(absolute);
          const rule = dispositionOf({ path: stat.isDirectory() ? `${path}/_` : path, size: stat.size, mode: '100644', type: 'blob', policy: 'interpret' });
          if (['excluded', 'withheld'].includes(rule.disposition)) { dispositions.push({ path, disposition: rule.disposition, rule: rule.rule }); continue; }
          // --no-index allows a private info/exclude even with a bare index-less repository.
          let ignored = false;
          try { git(['check-ignore', '--no-index', '-z', '--stdin'], `${path}\0`); ignored = true; } catch (error) { if (error.status !== 1) throw error; }
          if (ignored) { dispositions.push({ path, disposition: 'excluded', rule: 'git_ignore' }); continue; }
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { dispositions.push({ path, disposition: 'not_read', rule: stat.isSymbolicLink() ? 'symlink' : 'special_file' }); continue; }
          if (stat.isDirectory()) { walk(absolute, path); continue; }
          if (rule.disposition !== 'supported') { dispositions.push({ path, disposition: rule.disposition, rule: rule.rule }); continue; }
          const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          let body;
          try {
            const opened = fstatSync(fd);
            if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) refuse('source changed during import');
            body = readFileSync(fd);
            const after = fstatSync(fd);
            if (body.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) refuse('source changed during import');
          } finally { closeSync(fd); }
          const screened = body.includes(0) ? 'binary_content' : screenUnit(body.toString('utf8'));
          if (screened) { dispositions.push({ path, disposition: 'withheld', rule: screened }); continue; }
          const oid = git(['hash-object', ...(store ? ['-w'] : []), '--stdin'], body);
          files.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644', oid });
          dispositions.push({ path, disposition: 'imported', rule: 'screened_regular_file' });
        }
      };
      walk(source);
      return { files, dispositions };
    };
    const first = collect(true);
    env.GIT_INDEX_FILE = join(lock, 'index');
    git(['read-tree', '--empty']);
    if (first.files.length) git(['update-index', '-z', '--index-info'], first.files.map(f => `${f.mode} ${f.oid}\t${f.path}\0`).join(''));
    const tree = git(['write-tree']);
    let previous = null;
    try { previous = git(['rev-parse', '--verify', 'refs/heads/snapshots']); } catch { /* first snapshot */ }
    const reused = previous !== null && git(['rev-parse', `${previous}^{tree}`]) === tree;
    const pin = reused ? previous : git(['commit-tree', tree, ...(previous ? ['-p', previous] : [])], 'Import screened source snapshot\n');
    beforeConsistencyCheck();
    const second = collect();
    if (JSON.stringify(first) !== JSON.stringify(second)) refuse('source changed during import; snapshot ref was not advanced');
    git(['update-ref', 'refs/heads/snapshots', pin, previous || '0'.repeat(40)]);
    const descriptor = { id, root: repo, ref: pin, policy: 'interpret', source_kind: 'snapshot_import', snapshot: { tree, authored_history: false } };
    const result = { schema: 'estate-map/source-snapshot/v1', source: descriptor, previous_pin: previous, reused, dispositions: first.dispositions };
    const receiptPath = join(repo, `snapshot-${pin}.json`);
    if (!existsSync(receiptPath)) writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, id: { type: 'string' }, 'authorize-root': { type: 'string', multiple: true }, 'state-root': { type: 'string' }, 'force-git': { type: 'boolean' } } });
    if (!values.root || !values.id) throw new Error('snapshot requires --root <folder> --id <source-id> --authorize-root <same folder> [--state-root <private directory>] [--force-git]');
    console.log(JSON.stringify(snapshotSource({ root: values.root, id: values.id, authorizedRoots: values['authorize-root'], stateRoot: values['state-root'], forceGit: values['force-git'] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
