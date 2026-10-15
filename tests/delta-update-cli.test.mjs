// AC5-UPDATE-VERB: bin/ascrybe.mjs's `update` verb (tools/delta-update-run.mjs) requires
// --pin-manifest, --mode, and --output; defaults to --parent selected and --equivalence required;
// and --promote is always a typed refusal that publishes nothing. Invented names throughout
// (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInvocation } from '../bin/ascrybe.mjs';
import { runUpdateCommand } from '../tools/delta-update-run.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const dir = scratchDir('delta-update-cli-repo-');
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'nobody@example.invalid']);
  git(dir, ['config', 'user.name', 'Invented Committer']);
  writeFileSync(join(dir, 'network.tf'), 'resource "widget_queue" "orders" {\n  name = "orders-queue"\n}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'add invented network resource']);
  return dir;
}

function pinManifestFile(repoDir) {
  const dir = scratchDir('delta-update-cli-pins-');
  const path = join(dir, 'pins.json');
  writeFileSync(path, JSON.stringify({ repositories: { 'invented-estate': { path: repoDir, ref: 'HEAD' } } }));
  return path;
}

test('bin/ascrybe.mjs dispatches "update" to tools/delta-update-run.mjs', () => {
  const plan = planInvocation(['update', '--help'], { environment: {}, cwd: '/work', root: '/app' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.script, '/app/tools/delta-update-run.mjs');
});

test('missing --pin-manifest, --mode, or --output is a typed refusal, exit code 2', () => {
  const result = runUpdateCommand([]);
  assert.equal(result.exit_code, 2);
  assert.equal(result.reason_code, 'DELTA_UPDATE_ARGS_INVALID');
  assert.match(result.reason, /--pin-manifest/);
  assert.match(result.reason, /--mode/);
  assert.match(result.reason, /--output/);
});

test('an invalid --mode or --equivalence value is a typed refusal', () => {
  const badMode = runUpdateCommand(['--pin-manifest', 'x', '--mode', 'bogus', '--output', 'y']);
  assert.equal(badMode.exit_code, 2);
  assert.equal(badMode.reason_code, 'DELTA_UPDATE_ARGS_INVALID');

  const badEquivalence = runUpdateCommand(['--pin-manifest', 'x', '--mode', 'delta', '--output', 'y', '--equivalence', 'bogus']);
  assert.equal(badEquivalence.exit_code, 2);
  assert.equal(badEquivalence.reason_code, 'DELTA_UPDATE_ARGS_INVALID');
});

test('--equivalence certified is a typed refusal: this slice tracks no shadow-qualification closure', () => {
  const result = runUpdateCommand(['--pin-manifest', 'x', '--mode', 'delta', '--output', 'y', '--equivalence', 'certified']);
  assert.equal(result.exit_code, 2);
  assert.equal(result.reason_code, 'DELTA_UPDATE_EQUIVALENCE_CERTIFIED_NOT_IMPLEMENTED');
});

test('--parent-build is always refused: no build is ever retained by this command', () => {
  const result = runUpdateCommand(['--pin-manifest', 'x', '--mode', 'delta', '--output', 'y', '--parent-build', 'estate-build:deadbeef']);
  assert.equal(result.exit_code, 2);
  assert.equal(result.reason_code, 'DELTA_PARENT_BUILD_NOT_RETAINED');
});

test('AC5-UPDATE-VERB: --promote refuses with a typed reason code and publishes nothing', () => {
  const repoDir = makeRepo();
  const pinManifest = pinManifestFile(repoDir);
  const outputDir = join(scratchDir('delta-update-cli-out-'), 'nested', 'build');

  const result = runUpdateCommand([
    '--pin-manifest', pinManifest, '--mode', 'delta', '--output', outputDir, '--promote',
  ], { cacheRoot: scratchDir('delta-update-cli-cache-') });

  assert.equal(result.exit_code, 2);
  assert.equal(result.reason_code, 'DELTA_UPDATE_PROMOTE_NOT_IMPLEMENTED');
  assert.equal(existsSync(outputDir), false, '--promote must not create the output directory, let alone write a manifest into it');
});

test('--promote refuses even before argument validation would otherwise fail, and even alongside other flags', () => {
  const result = runUpdateCommand(['--promote']);
  assert.equal(result.exit_code, 2);
  assert.equal(result.reason_code, 'DELTA_UPDATE_PROMOTE_NOT_IMPLEMENTED');
});

test('a default (no --parent, no --equivalence) delta run seals a manifest, runs the required oracle, and exits 0', () => {
  const repoDir = makeRepo();
  const pinManifest = pinManifestFile(repoDir);
  const outputDir = join(scratchDir('delta-update-cli-out-'), 'build');
  const cacheRoot = scratchDir('delta-update-cli-cache-');

  const result = runUpdateCommand(['--pin-manifest', pinManifest, '--mode', 'delta', '--output', outputDir], { cacheRoot });

  assert.equal(result.exit_code, 0);
  assert.equal(result.status, 'staged');
  assert.ok(existsSync(join(outputDir, 'estate-build-manifest.json')), '--parent defaulting to "selected" must still seal a first build');
  assert.ok(existsSync(join(outputDir, 'equivalence-receipt.json')), '--equivalence defaulting to "required" must run the oracle even when unrequested');
  const equivalence = JSON.parse(readFileSync(join(outputDir, 'equivalence-receipt.json'), 'utf8'));
  assert.equal(equivalence.status, 'equivalent');
  const manifest = JSON.parse(readFileSync(join(outputDir, 'estate-build-manifest.json'), 'utf8'));
  assert.equal(manifest.build_id, result.build_id);
});

test('--mode full seals a manifest and never runs the equivalence oracle (nothing to compare against)', () => {
  const repoDir = makeRepo();
  const pinManifest = pinManifestFile(repoDir);
  const outputDir = join(scratchDir('delta-update-cli-out-'), 'build');

  const result = runUpdateCommand(['--pin-manifest', pinManifest, '--mode', 'full', '--output', outputDir], { cacheRoot: scratchDir('delta-update-cli-cache-') });

  assert.equal(result.exit_code, 0);
  assert.ok(existsSync(join(outputDir, 'estate-build-manifest.json')));
  assert.equal(existsSync(join(outputDir, 'equivalence-receipt.json')), false);
});

test('--parent-manifest lets a second run diff against an explicit prior sealed manifest', () => {
  const repoDir = makeRepo();
  const pinManifest = pinManifestFile(repoDir);
  const cacheRoot = scratchDir('delta-update-cli-cache-');
  const parentOut = join(scratchDir('delta-update-cli-out-'), 'parent');
  const first = runUpdateCommand(['--pin-manifest', pinManifest, '--mode', 'delta', '--output', parentOut], { cacheRoot });
  assert.equal(first.exit_code, 0);

  writeFileSync(join(repoDir, 'network.tf'), 'resource "widget_queue" "orders" {\n  name = "orders-queue-v2"\n}\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '--quiet', '-m', 'rename the invented orders queue']);
  const childOut = join(scratchDir('delta-update-cli-out-'), 'child');
  const second = runUpdateCommand([
    '--pin-manifest', pinManifest, '--mode', 'delta', '--output', childOut, '--parent-manifest', join(parentOut, 'estate-build-manifest.json'),
  ], { cacheRoot });
  assert.equal(second.exit_code, 0);
  const childManifest = JSON.parse(readFileSync(join(childOut, 'estate-build-manifest.json'), 'utf8'));
  assert.equal(childManifest.units.produced.length, 1, 'the one changed file must have re-produced');
  assert.equal(childManifest.planner.parent_build_id, JSON.parse(readFileSync(join(parentOut, 'estate-build-manifest.json'), 'utf8')).build_id);
});

// End-to-end through the real CLI process (bin/ascrybe.mjs -> tools/delta-update-run.mjs), not just
// the imported function, so the wiring itself is proven, not only the runner it dispatches to.
test('the real `ascrybe update --promote` process refuses and exits non-zero without writing anything', () => {
  const repoDir = makeRepo();
  const pinManifest = pinManifestFile(repoDir);
  const outputDir = join(scratchDir('delta-update-cli-proc-out-'), 'build');
  const spawned = spawnSync(process.execPath, [
    join(root, 'bin/ascrybe.mjs'), 'update', '--pin-manifest', pinManifest, '--mode', 'delta', '--output', outputDir, '--promote',
  ], { encoding: 'utf8' });
  assert.notEqual(spawned.status, 0);
  assert.match(spawned.stdout, /DELTA_UPDATE_PROMOTE_NOT_IMPLEMENTED/);
  assert.equal(existsSync(outputDir), false);
});
