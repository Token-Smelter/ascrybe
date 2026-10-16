import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';

const test = fixtureTest(import.meta.url);

function fixture() {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'public-authority-'));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'docs'));
  for (const name of ['check-design-authority.mjs', 'generate-design-authority-history-bridge.mjs', 'design-authority-contract.mjs']) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  }
  for (const name of ['AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'USAGE.md', 'docs/architecture.md']) writeFileSync(join(root, name), '# Parcel library\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  commit(root);
  execFileSync(process.execPath, ['scripts/generate-design-authority-history-bridge.mjs'], { cwd: root, stdio: 'pipe' });
  return root;
}
function commit(root) {
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Record published documents'], { cwd: root, stdio: 'pipe' });
}
const check = root => spawnSync(process.execPath, ['scripts/check-design-authority.mjs'], { cwd: root, encoding: 'utf8' });

test('public authority checks committed document bytes and provenance', () => {
  const result = check(fixture());
  assert.deepEqual({ status: result.status, mode: result.stdout.includes('public-git') }, { status: 0, mode: true });
});

test('public authority rejects an edited governed document', () => {
  const root = fixture(); writeFileSync(join(root, 'docs/architecture.md'), '# Changed architecture\n');
  assert.match(check(root).stderr, /governed document bytes differ/u);
});

test('public authority rejects an added document missing from its ledger', () => {
  const root = fixture(); writeFileSync(join(root, 'docs/new.md'), '# New document\n');
  assert.match(check(root).stderr, /published document coverage differs/u);
});

test('public authority rejects a corrupted ledger binding', () => {
  const root = fixture(); const path = join(root, 'DESIGN-AUTHORITY-LEDGER.json');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Published documentation only', 'Different scope'));
  assert.match(check(root).stderr, /ledger or snapshot binding differs/u);
});

test('rebinding refuses uncommitted document bytes', () => {
  const root = fixture(); writeFileSync(join(root, 'README.md'), '# Changed overview\n');
  const result = spawnSync(process.execPath, ['scripts/generate-design-authority-history-bridge.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(result.stderr, /commit document before rebinding/u);
});

test('exported trees disclose that snapshot validation does not verify history', () => {
  const root = fixture(); renameSync(join(root, '.git'), join(root, 'held-git'));
  const result = check(root);
  assert.deepEqual({ status: result.status, disclosed: result.stdout.includes('history not verified') }, { status: 0, disclosed: true });
});
