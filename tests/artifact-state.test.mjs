import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  STATE_LAYOUT, artifactRoot, directoryReceipt, initializeState, migrateState, snapshotState, verifyState,
} from '../tools/artifact-state.mjs';

const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();

function fixture({ includeIgnore = false } = {}) {
  const base = mkdtempSync(join(scratch, 'artifact-state-'));
  const repository = join(base, 'repository');
  mkdirSync(repository);
  execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
  writeFileSync(join(repository, 'README.md'), 'fixture\n');
  if (includeIgnore) writeFileSync(join(repository, '.gitignore'), readFileSync(new URL('../.gitignore', import.meta.url)));
  execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-m', 'Add fixture'], { cwd: repository, stdio: 'pipe' });
  return { base, repository, environment: { ASCRYBE_ARTIFACT_ROOT: join(base, 'state') } };
}

test('artifactRoot uses XDG state and refuses Git-owned physical locations', () => {
  const { base, repository } = fixture();
  assert.equal(artifactRoot({ repository, environment: { XDG_STATE_HOME: join(base, 'xdg') } }), join(base, 'xdg', 'estate-map-runner'));
  assert.throws(() => artifactRoot({ repository, environment: { ASCRYBE_ARTIFACT_ROOT: join(repository, 'state') } }), /outside Git worktree/u);

  const alias = join(base, 'repository-alias');
  symlinkSync(repository, alias, 'dir');
  const escapedRoot = join(alias, 'new-state');
  assert.throws(() => artifactRoot({ repository, environment: { ASCRYBE_ARTIFACT_ROOT: escapedRoot } }), /outside Git worktree/u);
  assert.equal(existsSync(join(repository, 'new-state')), false);
});

test('initializeState creates only verified compatibility links', () => {
  const { repository, environment } = fixture();
  const initialized = initializeState({ repository, environment });
  assert.equal(initialized.root, environment.ASCRYBE_ARTIFACT_ROOT);
  for (const [legacy, location] of Object.entries(STATE_LAYOUT)) {
    assert.equal(lstatSync(join(repository, legacy)).isSymbolicLink(), true, legacy);
    assert.equal(existsSync(join(initialized.root, location)), true, location);
  }
  assert.deepEqual(verifyState({ repository, environment }).links['.evals'], join(initialized.root, 'evaluations'));
  assert.deepEqual(initializeState({ repository, environment }).links, Object.fromEntries(Object.keys(STATE_LAYOUT).map(key => [key, 'verified'])));
});

test('initializeState leaves generated compatibility links untracked', () => {
  const { repository, environment } = fixture({ includeIgnore: true });
  initializeState({ repository, environment });
  assert.equal(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: repository, encoding: 'utf8' }), '');
});

test('migrateState copies, verifies, and links external legacy custody without deleting it', () => {
  const { base, repository, environment } = fixture();
  const legacy = join(base, 'legacy');
  mkdirSync(join(legacy, 'runs'), { recursive: true });
  writeFileSync(join(legacy, 'runs', 'paid.jsonl'), 'irreplaceable bytes\n');
  const before = directoryReceipt(join(legacy, 'runs'));
  const migrated = migrateState({ repository, from: legacy, environment });
  assert.equal(migrated.migrated.length, 1);
  assert.deepEqual(directoryReceipt(join(legacy, 'runs')), before);
  assert.deepEqual(directoryReceipt(join(environment.ASCRYBE_ARTIFACT_ROOT, 'runs')), before);
  assert.equal(lstatSync(join(repository, 'runs')).isSymbolicLink(), true);
});

test('migrateState preserves source bytes and pre-existing destinations on failure', () => {
  const { base, repository, environment } = fixture();
  const legacy = join(base, 'legacy');
  mkdirSync(join(legacy, 'runs'), { recursive: true });
  writeFileSync(join(legacy, 'runs', 'paid.jsonl'), 'irreplaceable bytes\n');
  const before = directoryReceipt(join(legacy, 'runs'));
  assert.throws(() => migrateState({ repository, from: legacy, environment, beforeCopy() { throw new Error('injected copy failure'); } }), /injected copy failure/u);
  assert.deepEqual(directoryReceipt(join(legacy, 'runs')), before);

  const destination = join(environment.ASCRYBE_ARTIFACT_ROOT, 'runs');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'existing.txt'), 'existing destination\n');
  const destinationBefore = directoryReceipt(destination);
  assert.throws(() => migrateState({ repository, from: legacy, environment }), /already contains custody/u);
  assert.deepEqual(directoryReceipt(join(legacy, 'runs')), before);
  assert.deepEqual(directoryReceipt(destination), destinationBefore);
});

test('snapshotState preserves primary bytes and refuses a pre-existing destination', () => {
  const { base, repository, environment } = fixture();
  const state = initializeState({ repository, environment });
  writeFileSync(join(state.root, 'runs', 'paid.jsonl'), 'irreplaceable bytes\n');
  const before = directoryReceipt(state.root);
  const failingDestination = join(base, 'snapshot-failing');
  assert.throws(() => snapshotState({ repository, environment, destination: failingDestination, beforeCopy() { throw new Error('injected snapshot failure'); } }), /injected snapshot failure/u);
  assert.deepEqual(directoryReceipt(state.root), before);

  const existing = join(base, 'snapshot-existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep.txt'), 'existing destination\n');
  const destinationBefore = directoryReceipt(existing);
  assert.throws(() => snapshotState({ repository, environment, destination: existing }), /already exists/u);
  assert.deepEqual(directoryReceipt(state.root), before);
  assert.deepEqual(directoryReceipt(existing), destinationBefore);
});

test('snapshotState rejects a symlinked parent inside primary custody before creating a destination', () => {
  const { base, repository, environment } = fixture();
  const state = initializeState({ repository, environment });
  writeFileSync(join(state.root, 'runs', 'paid.jsonl'), 'irreplaceable bytes\n');
  const before = directoryReceipt(state.root);
  const alias = join(base, 'state-alias');
  symlinkSync(state.root, alias, 'dir');
  const destination = join(alias, 'snapshot');

  assert.throws(() => snapshotState({ repository, environment, destination }), /outside the primary artifact root/u);
  assert.equal(existsSync(join(state.root, 'snapshot')), false);
  assert.deepEqual(directoryReceipt(state.root), before);
});

test('snapshotState rechecks physical custody after destination creation', () => {
  const { base, repository, environment } = fixture();
  const state = initializeState({ repository, environment });
  writeFileSync(join(state.root, 'runs', 'paid.jsonl'), 'irreplaceable bytes\n');
  const before = directoryReceipt(state.root);
  const destination = join(base, 'snapshot-race');

  assert.throws(() => snapshotState({
    repository,
    environment,
    destination,
    afterCreate(path) {
      rmSync(path, { recursive: true, force: true });
      symlinkSync(state.root, path, 'dir');
    },
  }), /outside the primary artifact root/u);
  assert.deepEqual(directoryReceipt(state.root), before);
});
