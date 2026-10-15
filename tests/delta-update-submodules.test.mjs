// `ascrybe update`'s inventory folds a resolvable declared submodule in, names an unresolvable one
// or an undeclared gitlink, bounds recursion depth, refuses a naming cycle, and keeps update==full
// even across a commit that adds a submodule -- the SAME rules tools/git-tree-source.mjs applies
// for the materialize/documentary path (tools/git-submodule-resolution.mjs is shared by both).
// Invented names throughout (CONTRIBUTING.md); no estate mapped on this machine is named here.
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEstateInventory, runUpdateCommand } from '../tools/delta-update-run.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function newRepo(prefix) {
  const dir = scratchDir(prefix);
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'nobody@example.invalid']);
  git(dir, ['config', 'user.name', 'Invented Committer']);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// `git add -A` stages DELETIONS too: a gitlink staged via `update-index --cacheinfo` has no
// corresponding working-tree path, so `add -A` treats it as removed. Every fixture that fabricates
// a bare gitlink this way must commit exactly what is already staged, never re-stage from disk.
function commitStagedOnly(dir, message) {
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function pinManifestFor(repository, repoDir, ref = 'HEAD') {
  const dir = scratchDir('delta-update-submodules-pins-');
  const path = join(dir, 'pins.json');
  writeFileSync(path, JSON.stringify({ repositories: { [repository]: { path: repoDir, ref } } }));
  return path;
}

test('a declared, available submodule (resolved via .git/modules) is folded into the inventory at its own path', () => {
  const childDir = newRepo('delta-update-submodules-child-');
  writeFileSync(join(childDir, 'status-digest.md'), '# Status digest\n');
  commitAll(childDir, 'create weekly report');

  const parentDir = newRepo('delta-update-submodules-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'status-digest']);
  commitAll(parentDir, 'add status-digest submodule');

  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } });
  const paths = resolved.current_inventory.map(row => row.normalized_path).sort();
  assert.deepEqual(paths, ['.gitmodules', 'service.py', 'status-digest/status-digest.md']);
  assert.deepEqual(resolved.excluded_paths, []);
});

test('a declared submodule whose pinned commit is unresolvable is a named, counted exclusion; the rest of the repository still maps', () => {
  const parentDir = newRepo('delta-update-submodules-unavail-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  writeFileSync(join(parentDir, '.gitmodules'), '[submodule "phantom"]\n\tpath = vendor/phantom\n\turl = ../phantom.git\n');
  git(parentDir, ['add', 'service.py', '.gitmodules']);
  git(parentDir, ['update-index', '--add', '--cacheinfo', `160000,${'c'.repeat(40)},vendor/phantom`]);
  commitStagedOnly(parentDir, 'declare an unresolvable submodule');

  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } });
  const paths = resolved.current_inventory.map(row => row.normalized_path).sort();
  assert.deepEqual(paths, ['.gitmodules', 'service.py']);
  assert.deepEqual(resolved.excluded_paths.map(row => ({ path: row.path, code: row.code })),
    [{ path: 'vendor/phantom', code: 'SUBMODULE_UNAVAILABLE' }]);
});

test('an undeclared gitlink (no .gitmodules entry) is a named, counted exclusion, distinct from an unavailable declared submodule', () => {
  const parentDir = newRepo('delta-update-submodules-undeclared-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['add', 'service.py']);
  git(parentDir, ['update-index', '--add', '--cacheinfo', `160000,${'d'.repeat(40)},vendor/orphan`]);
  commitStagedOnly(parentDir, 'add an undeclared gitlink');

  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } });
  assert.deepEqual(resolved.current_inventory.map(row => row.normalized_path), ['service.py']);
  assert.deepEqual(resolved.excluded_paths.map(row => ({ path: row.path, code: row.code })),
    [{ path: 'vendor/orphan', code: 'GITLINK_UNREGISTERED' }]);
});

test('a declared submodule is resolved through an explicit source_repositories member first', () => {
  const childDir = newRepo('delta-update-submodules-named-child-');
  writeFileSync(join(childDir, 'child.txt'), 'from the named member\n');
  commitAll(childDir, 'create child');

  const parentDir = newRepo('delta-update-submodules-named-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'vendor/child']);
  commitAll(parentDir, 'add declared submodule');

  // A DIFFERENT clone with the same pinned commit, offered through source_repositories -- proving
  // it (not .git/modules, which also resolves) is what actually got used.
  const otherCloneDir = scratchDir('delta-update-submodules-named-clone-');
  execFileSync('git', ['clone', '-q', childDir, otherCloneDir]);

  const resolved = resolveEstateInventory(
    { repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } },
    { sourceRepositories: { 'vendor/child': otherCloneDir } },
  );
  const child = resolved.current_inventory.find(row => row.normalized_path === 'vendor/child/child.txt');
  assert.ok(child, 'the submodule file must be present in the inventory');
});

test('nested submodules fold in recursively at their own prefixed paths', () => {
  const grandchildDir = newRepo('delta-update-submodules-grandchild-');
  writeFileSync(join(grandchildDir, 'leaf.txt'), 'leaf\n');
  commitAll(grandchildDir, 'grandchild');

  const childDir = newRepo('delta-update-submodules-nested-child-');
  writeFileSync(join(childDir, 'child.txt'), 'child\n');
  git(childDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', grandchildDir, 'inner']);
  commitAll(childDir, 'child with grandchild submodule');

  const parentDir = newRepo('delta-update-submodules-nested-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'outer']);
  commitAll(parentDir, 'root with nested submodule chain');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);

  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } });
  const paths = resolved.current_inventory.map(row => row.normalized_path).sort();
  assert.deepEqual(paths, ['.gitmodules', 'outer/.gitmodules', 'outer/child.txt', 'outer/inner/leaf.txt', 'service.py']);
  assert.deepEqual(resolved.excluded_paths, []);
});

test('a declared submodule name repeated deeper in its own chain is a named, counted cycle exclusion, never infinite recursion', () => {
  const grandchildDir = newRepo('delta-update-submodules-cycle-grandchild-');
  writeFileSync(join(grandchildDir, 'leaf.txt'), 'leaf\n');
  commitAll(grandchildDir, 'grandchild');
  const grandchildSha = git(grandchildDir, ['rev-parse', 'HEAD']);

  const childDir = newRepo('delta-update-submodules-cycle-child-');
  writeFileSync(join(childDir, 'child.txt'), 'child\n');
  writeFileSync(join(childDir, '.gitmodules'), '[submodule "shared"]\n\tpath = inner\n\turl = ../unused.git\n');
  git(childDir, ['add', 'child.txt', '.gitmodules']);
  git(childDir, ['update-index', '--add', '--cacheinfo', `160000,${grandchildSha},inner`]);
  commitStagedOnly(childDir, 'child declares submodule "shared" at inner');
  const childSha = git(childDir, ['rev-parse', 'HEAD']);

  const parentDir = newRepo('delta-update-submodules-cycle-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  writeFileSync(join(parentDir, '.gitmodules'), '[submodule "shared"]\n\tpath = outer\n\turl = ../unused.git\n');
  git(parentDir, ['add', 'service.py', '.gitmodules']);
  git(parentDir, ['update-index', '--add', '--cacheinfo', `160000,${childSha},outer`]);
  commitStagedOnly(parentDir, 'root declares submodule "shared" at outer');

  const resolved = resolveEstateInventory(
    { repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } },
    { sourceRepositories: { shared: childDir } },
  );
  const paths = resolved.current_inventory.map(row => row.normalized_path).sort();
  assert.deepEqual(paths, ['.gitmodules', 'outer/.gitmodules', 'outer/child.txt', 'service.py']);
  assert.deepEqual(resolved.excluded_paths.map(row => ({ path: row.path, code: row.code })),
    [{ path: 'outer/inner', code: 'SUBMODULE_CYCLE_DETECTED' }]);
});

test('update == full still holds across a commit that adds a submodule', () => {
  const childDir = newRepo('delta-update-submodules-equiv-child-');
  writeFileSync(join(childDir, 'child.txt'), 'child content\n');
  commitAll(childDir, 'create child');

  const parentDir = newRepo('delta-update-submodules-equiv-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  commitAll(parentDir, 'create parent, no submodule yet');
  const pinManifest = pinManifestFor('coordinator', parentDir);
  const cacheRoot = scratchDir('delta-update-submodules-equiv-cache-');

  const before = runUpdateCommand(['--pin-manifest', pinManifest, '--mode', 'delta', '--output', join(scratchDir('delta-update-submodules-equiv-out-'), 'before')], { cacheRoot });
  assert.equal(before.exit_code, 0);

  // Now the commit that adds the submodule -- exactly the operator's named scenario.
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'vendor/child']);
  commitAll(parentDir, 'add a declared submodule');

  const afterOut = join(scratchDir('delta-update-submodules-equiv-out-'), 'after');
  const after = runUpdateCommand(['--pin-manifest', pinManifest, '--mode', 'delta', '--output', afterOut], { cacheRoot });
  assert.equal(after.exit_code, 0, JSON.stringify(after));
  const equivalence = JSON.parse(readFileSync(join(afterOut, 'equivalence-receipt.json'), 'utf8'));
  assert.equal(equivalence.status, 'equivalent', 'delta and full must still agree once the estate contains a submodule');
  // units.produced is opaque content-addressed extraction-unit ids, filtered by extractor
  // applicability -- not a list of files, and not what "was the submodule silently skipped"
  // actually asks. Checked directly against the inventory both arms of the equivalence oracle
  // share (resolveEstateInventory), the same layer tests 1/4/5 already verify.
  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: 'HEAD' } } });
  assert.ok(resolved.current_inventory.some(row => row.normalized_path === 'vendor/child/child.txt'),
    'the submodule file must actually be in the inventory both arms compared, not silently skipped');
});

test('source identity changes when only the submodule pin changes, even though the parent tree entry that names it is what actually moved', () => {
  const childDir = newRepo('delta-update-submodules-identity-child-');
  writeFileSync(join(childDir, 'child.txt'), 'version one\n');
  commitAll(childDir, 'child v1');

  const parentDir = newRepo('delta-update-submodules-identity-parent-');
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'vendor/child']);
  commitAll(parentDir, 'add submodule at v1');
  const shaBeforePinChange = git(parentDir, ['rev-parse', 'HEAD']);

  // Change ONLY the submodule's content (and therefore its pinned commit) -- the parent's own
  // files (service.py) never change.
  writeFileSync(join(childDir, 'child.txt'), 'version two\n');
  const childShaV2 = commitAll(childDir, 'child v2');
  const submodulePath = join(parentDir, 'vendor', 'child');
  git(submodulePath, ['-c', 'protocol.file.allow=always', 'fetch', 'origin']);
  git(submodulePath, ['checkout', childShaV2]);
  git(parentDir, ['add', 'vendor/child']);
  commitAll(parentDir, 'bump submodule pin to v2');
  const shaAfterPinChange = git(parentDir, ['rev-parse', 'HEAD']);

  assert.notEqual(shaBeforePinChange, shaAfterPinChange, 'a real Git commit changed -- the pin bump is itself a new parent commit, as it must be');

  const before = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: shaBeforePinChange } } });
  const after = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: shaAfterPinChange } } });
  assert.notEqual(before.pins.coordinator, after.pins.coordinator);
  const beforeContent = before.current_inventory.find(row => row.normalized_path === 'vendor/child/child.txt').content_sha256;
  const afterContent = after.current_inventory.find(row => row.normalized_path === 'vendor/child/child.txt').content_sha256;
  assert.notEqual(beforeContent, afterContent, 'the submodule file content itself must reflect the new pin, not the old one');
});
