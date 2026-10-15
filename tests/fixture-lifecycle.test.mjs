import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureScope, fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';

const test = fixtureTest(import.meta.url);
const base = () => mkdtempSync(join(tmpdir(), 'fixture-regression-'));
const scopeFor = name => fixtureScope({ source: import.meta.url, name });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });

// These scopes exercise the real removal path, not a registry with no allocations.
test('normal completion reclaims every allocated root but not a similarly named sibling', async () => {
  const scope = scopeFor('normal completion');
  const sibling = mkdtempSync(join(tmpdir(), 'invented-'));
  writeFileSync(join(sibling, 'sentinel'), 'untouched');
  const roots = Array.from({ length: 3 }, () => scope.allocate(join(tmpdir(), 'invented-')));
  await scope.finish();
  assert.deepEqual([roots.map(existsSync), readFileSync(join(sibling, 'sentinel'), 'utf8')], [[false, false, false], 'untouched']);
});

test('an assertion failure archives raw bytes and correlation before reclaiming its root', () => {
  const parent = base();
  const script = join(parent, 'failure.mjs');
  writeFileSync(script, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureTest, mkdtempSync } from ${JSON.stringify(new URL('./helpers/fixture-lifecycle.mjs', import.meta.url).href)};
fixtureTest(import.meta.url)('invented failing case', () => {
  const root = mkdtempSync(join(process.env.TMPDIR, 'invented-failure-'));
  writeFileSync(join(root, 'journal.jsonl'), '{"raw":"unchanged"}\\n');
  assert.fail('intentional regression failure');
});`);
  const archive = scopeFor('failure subprocess receipts').receiptDir;
  const env = { ...process.env, TMPDIR: process.env.TMPDIR || tmpdir(), ASCRYBE_SCRATCH_DIR: process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), ASCRYBE_FIXTURE_ARCHIVE_DIR: archive };
  // A fresh runner must not inherit the enclosing runner's internal execution context.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', script], { env, encoding: 'utf8' });
  writeFileSync(join(parent, 'subprocess.log'), `${result.stdout}\n${result.stderr}`);
  assert.ok(readdirSync(archive).length, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const receipt = join(archive, readdirSync(archive)[0]);
  const manifest = JSON.parse(readFileSync(join(receipt, 'manifest-0.json')));
  const raw = readFileSync(join(receipt, 'evidence-0', 'journal.jsonl'));
  assert.deepEqual([result.status, existsSync(manifest.root), manifest.case, manifest.source.endsWith('/failure.mjs'),
    manifest.files[0].sha256, raw.toString()],
  [1, false, 'invented failing case', true, createHash('sha256').update(raw).digest('hex'), '{"raw":"unchanged"}\n']);
});

test('unresolved owned children and cancellation retain roots until completion is known', () => {
  const scope = scopeFor('owned child');
  const root = scope.allocate(join(tmpdir(), 'invented-'));
  writeFileSync(join(root, 'journal.jsonl'), '{"pending":true}\n');
  const release = scope.child('invented worker');
  const pending = scope.finish({ failed: true });
  release();
  const cancelled = scope.finish({ cancelled: true });
  const existed = existsSync(root);
  const completed = scope.finish();
  const archived = readFileSync(join(completed[0].evidence, 'journal.jsonl'), 'utf8');
  assert.deepEqual([pending[0].event, cancelled[0].event, existed, completed[0].event, existsSync(root), archived],
    ['retained', 'retained', true, 'reclaimed', false, '{"pending":true}\n']);
});

test('symlinks inside an owned fixture never traverse or remove an outside target', () => {
  const parent = base(), scope = scopeFor('symlink boundary');
  const sibling = join(parent, 'outside');
  writeFileSync(sibling, 'outside bytes');
  const root = scope.allocate(join(tmpdir(), 'invented-'));
  symlinkSync(sibling, join(root, 'link'));
  const result = scope.finish({ failed: true });
  assert.deepEqual([result[0].event, existsSync(root), readFileSync(sibling, 'utf8')], ['reclaimed', false, 'outside bytes']);
});

test('a replaced root is kept without following its replacement symlink', () => {
  const parent = base(), scope = scopeFor('root identity');
  const root = scope.allocate(join(tmpdir(), 'invented-'));
  const moved = `${root}-moved`, outside = join(parent, 'outside');
  writeFileSync(outside, 'outside bytes');
  renameSync(root, moved);
  symlinkSync(outside, root);
  const held = scope.finish();
  const untouched = readFileSync(outside, 'utf8');
  unlinkSync(root);
  renameSync(moved, root);
  const done = scope.finish();
  assert.deepEqual([held[0].event, untouched, done[0].event, existsSync(root)], ['retained', 'outside bytes', 'reclaimed', false]);
});

test('linked worktrees use normal git removal and keep a dirty worktree and its owning repository', () => {
  const scope = scopeFor('linked worktree');
  const repo = scope.allocate(join(tmpdir(), 'invented-repo-'));
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Create fixture');
  const linked = scope.allocate(join(tmpdir(), 'invented-linked-'));
  git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
  writeFileSync(join(linked, 'untracked'), 'keep until resolved');
  const held = scope.finish();
  const bothExist = [repo, linked].every(existsSync);
  git(linked, 'add', 'untracked');
  git(linked, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Resolve fixture child');
  const done = scope.finish();
  assert.deepEqual([held.map(row => row.event), bothExist, done.map(row => row.event), [repo, linked].map(existsSync)],
    [['retained', 'retained'], true, ['reclaimed', 'reclaimed'], [false, false]]);
});

test('nested allocations are refused before creation even across scopes with unresolved children', () => {
  const owner = scopeFor('outer ownership'), child = scopeFor('nested ownership');
  const root = owner.allocate(join(tmpdir(), 'invented-outer-'));
  const release = child.child('unresolved child');
  const releaseOwner = owner.child('unresolved owner work');
  const ownerHeld = owner.finish();
  let refusal;
  try { child.allocate(join(root, 'nested-')); } catch (error) { refusal = error.message; }
  child.finish();
  const contents = readdirSync(root);
  release();
  child.finish();
  releaseOwner();
  owner.finish();
  assert.deepEqual([ownerHeld[0].event, refusal, contents], ['retained', 'nested fixture allocation refused', []]);
});

for (const alteration of ['symlinked intermediate', 'replaced owner']) {
  test(`linked removal keeps roots when metadata has a ${alteration}`, () => {
    const scope = scopeFor(alteration), outside = base();
    const repo = scope.allocate(join(tmpdir(), 'invented-repo-'));
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Create fixture');
    const linked = scope.allocate(join(tmpdir(), 'invented-linked-'));
    git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
    const moved = `${repo}-moved`, metadata = join(outside, 'metadata');
    if (alteration === 'symlinked intermediate') {
      renameSync(join(repo, '.git', 'worktrees'), metadata);
      symlinkSync(metadata, join(repo, '.git', 'worktrees'));
      writeFileSync(join(metadata, readdirSync(metadata)[0], 'commondir'), join(repo, '.git'));
      // Keep the owner intact even under the pre-fix remover so the test can restore metadata.
      mkdirSync(join(repo, 'worktrees'));
      writeFileSync(join(repo, 'worktrees', 'pending'), 'owned fixture barrier');
    } else {
      renameSync(repo, moved);
      mkdirSync(repo);
      renameSync(join(moved, '.git'), join(repo, '.git'));
    }
    const held = scope.finish();
    const linkedPresent = existsSync(linked);
    if (alteration === 'symlinked intermediate') {
      unlinkSync(join(repo, '.git', 'worktrees'));
      renameSync(metadata, join(repo, '.git', 'worktrees'));
      unlinkSync(join(repo, 'worktrees', 'pending'));
      rmdirSync(join(repo, 'worktrees'));
    } else {
      renameSync(join(repo, '.git'), join(moved, '.git'));
      rmdirSync(repo);
      renameSync(moved, repo);
    }
    const done = scope.finish();
    assert.deepEqual([held.map(row => row.event), linkedPresent, [repo, linked].map(existsSync), done.every(row => row.event === 'reclaimed')],
      [['retained', 'retained'], true, [false, false], true]);
  });
}

test('concurrent tests retain separate allocation and case identities', { concurrency: true }, async t => {
  await Promise.all(['first', 'second'].map(name => t.test(name, async () => {
    const scope = scopeFor(name);
    const root = scope.allocate(join(tmpdir(), 'invented-concurrent-'));
    await new Promise(resolve => setImmediate(resolve));
    scope.finish();
    const rows = readFileSync(join(scope.receiptDir, 'roots.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual([rows.map(row => row.case), rows[0].root, existsSync(root)], [[name, name], root, false]);
  })));
});
