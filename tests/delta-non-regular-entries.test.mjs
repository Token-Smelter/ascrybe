// AC6-SCOPE-HONESTY, extended: a gitlink or symlink was never eligible to become a file-scope unit
// (turning one into a unit would misrepresent it, CONTRIBUTING.md "exactness beats completeness"),
// but the repo's own rule is that an absence must be counted and named, never silent. `ascrybe
// update` previously dropped non-regular tree entries with no record anywhere. It now writes every
// one to non-regular-entries.json (repository, path, mode, target): the target commit for a
// gitlink, the link text for a symlink. Every name here is invented (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEstateInventory, runUpdateCommand } from '../tools/delta-update-run.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function initRepo(dir) {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'nobody@example.invalid']);
  git(dir, ['config', 'user.name', 'Invented Committer']);
}
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const FAKE_SUBMODULE_COMMIT = 'a'.repeat(40); // an invented commit sha; never resolved, never fetched

/** A repo with one regular file, one real symlink, and one fabricated gitlink (a commit-type tree
 * entry, the same shape a real submodule leaves -- no live submodule/network needed to prove it). */
function buildRepoWithNonRegularEntries() {
  const repoDir = scratchDir('non-regular-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'app.mjs'), 'export function ownSource() { return 1; }\n');
  symlinkSync('app.mjs', join(repoDir, 'app-link.mjs'));
  git(repoDir, ['add', 'app.mjs', 'app-link.mjs']);
  // Fabricate a gitlink exactly as a real submodule would leave one, without a live submodule.
  git(repoDir, ['update-index', '--add', '--cacheinfo', `160000,${FAKE_SUBMODULE_COMMIT},vendored-widget`]);
  git(repoDir, ['commit', '--quiet', '-m', 'add a regular file, a symlink, and a gitlink']);
  const sha = git(repoDir, ['rev-parse', 'HEAD']).trim();
  return { repoDir, sha };
}

test('ascrybe update counts and names every non-regular tree entry, never silently dropping it', () => {
  const { repoDir, sha } = buildRepoWithNonRegularEntries();
  const root = scratchDir('non-regular-run-');
  const pinManifestPath = join(root, 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { widgets: { path: repoDir, ref: sha } } }));
  const outputDir = join(root, 'out');

  const result = runUpdateCommand(['--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outputDir]);
  assert.equal(result.exit_code, 0, JSON.stringify(result));

  const nonRegularPath = join(outputDir, 'non-regular-entries.json');
  assert.ok(existsSync(nonRegularPath), 'a repo with non-regular entries must write non-regular-entries.json, not stay silent');
  const nonRegular = JSON.parse(readFileSync(nonRegularPath, 'utf8'));
  assert.deepEqual(nonRegular, [
    { repository: 'widgets', path: 'app-link.mjs', mode: '120000', target: 'app.mjs' },
    { repository: 'widgets', path: 'vendored-widget', mode: '160000', target: FAKE_SUBMODULE_COMMIT },
  ]);

  // The regular file alone (test 2's fixture, byte-identical app.mjs, no symlink/gitlink) produces
  // the SAME unit count -- proving the symlink and gitlink contributed zero units, not merely that
  // the count is "plausible".
  const manifest = JSON.parse(readFileSync(join(outputDir, 'estate-build-manifest.json'), 'utf8'));
  assert.ok(manifest.units.expected.length > 0);
  assert.equal(manifest.units.expected.length, regularOnlyUnitCount());
});

// Each case owns its filesystem inputs; a cached path would outlive its owning test.
function runRegularOnlyFixture() {
  const repoDir = scratchDir('all-regular-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'app.mjs'), 'export function ownSource() { return 1; }\n');
  const sha = commit(repoDir, 'add one regular file only');
  const root = scratchDir('all-regular-run-');
  const pinManifestPath = join(root, 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { widgets: { path: repoDir, ref: sha } } }));
  const outputDir = join(root, 'out');
  const result = runUpdateCommand(['--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outputDir]);
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  const manifest = JSON.parse(readFileSync(join(outputDir, 'estate-build-manifest.json'), 'utf8'));
  return { outputDir, manifest };
}
function regularOnlyUnitCount() { return runRegularOnlyFixture().manifest.units.expected.length; }

test('a repository with no non-regular entries writes no non-regular-entries.json at all', () => {
  const { outputDir } = runRegularOnlyFixture();
  assert.equal(existsSync(join(outputDir, 'non-regular-entries.json')), false);
});

// tools/git-submodule-resolution.mjs (fix/submodule-support) folds a declared, resolvable
// submodule's OWN files into the inventory by recursion, distinct from an undeclared gitlink
// (above), which never recurses. That merge combined two independent rewrites of listTree()/
// repositoryInventory() -- this proves the synthesis actually holds: the submodule's gitlink TREE
// ENTRY (at its own path in the parent) is still named in non-regular-entries.json exactly like
// any other gitlink, even though its files are simultaneously present as ordinary file-scope
// units. Naming the entry and materializing what it points to are not mutually exclusive.
test('a declared, resolvable submodule is BOTH named in non-regular-entries.json AND has its files in the inventory', () => {
  const childDir = scratchDir('non-regular-submodule-child-');
  initRepo(childDir);
  writeFileSync(join(childDir, 'child.txt'), 'child content\n');
  commit(childDir, 'create child');

  const parentDir = scratchDir('non-regular-submodule-parent-');
  initRepo(parentDir);
  writeFileSync(join(parentDir, 'service.py'), 'def run():\n    return None\n');
  git(parentDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childDir, 'vendor/child']);
  commit(parentDir, 'add a declared submodule');
  const parentSha = git(parentDir, ['rev-parse', 'HEAD']).trim();
  const childSha = git(join(parentDir, 'vendor', 'child'), ['rev-parse', 'HEAD']).trim();

  const root = scratchDir('non-regular-submodule-run-');
  const pinManifestPath = join(root, 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { coordinator: { path: parentDir, ref: parentSha } } }));
  const outputDir = join(root, 'out');
  const result = runUpdateCommand(['--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outputDir]);
  assert.equal(result.exit_code, 0, JSON.stringify(result));

  const nonRegular = JSON.parse(readFileSync(join(outputDir, 'non-regular-entries.json'), 'utf8'));
  assert.deepEqual(nonRegular, [
    { repository: 'coordinator', path: 'vendor/child', mode: '160000', target: childSha },
  ]);

  const resolved = resolveEstateInventory({ repositories: { coordinator: { path: parentDir, ref: parentSha } } });
  assert.ok(resolved.current_inventory.some(row => row.normalized_path === 'vendor/child/child.txt'),
    'the submodule\'s own file must be a real inventory entry, not merely named as non-regular');
  assert.deepEqual(resolved.non_regular_entries,
    [{ repository: 'coordinator', path: 'vendor/child', mode: '160000', target: childSha }]);
});
