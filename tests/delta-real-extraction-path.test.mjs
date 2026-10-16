// AC2-REAL-PATH-DELTA / AC3-REAL-EQUIVALENCE / AC4-FAIL-CLOSED-PRESERVED: this file exercises the
// REAL production extraction path (tools/delta-update-run.mjs -- the module bin/ascrybe.mjs's
// `update` verb dispatches to) end to end over a REAL temporary Git repository this test creates
// (`git init`, real commits), never a hand-built fixture plan. Dispositions below are counted from
// receipts the real planner emitted, not asserted against anything this test constructs by hand.
// Every file/resource name is invented (CONTRIBUTING.md); none names a repository this machine maps.
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../tools/lib.mjs';
import { planEstateUpdate, buildEstateManifestFromPlan } from '../tools/delta-update-run.mjs';
import { compareFullAndDeltaBuilds, DELTA_FULL_MISMATCH_CODE } from '../tools/delta/equivalence.mjs';
import { readUnitCacheEntry } from '../tools/delta/unit-cache.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

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

function pinManifestFor(repository, path, ref) {
  return { repositories: { [repository]: { path, ref } } };
}

// unit-cache.mjs's own cache-directory mapping (tools/delta/unit-cache.mjs unitDir/unitCacheKey):
// `unit:<64-hex>` lives directly under the cache root by its hex suffix.
function unitCacheDir(cacheRoot, unitId) {
  return join(cacheRoot, unitId.replace(/^unit:/, ''));
}

const REPO = 'invented-estate';
const NETWORK_TF = 'resource "widget_queue" "orders" {\n  name = "orders-queue"\n}\n';
const STORAGE_TF = 'resource "widget_queue" "receipts" {\n  name = "receipts-queue"\n}\n';

test('AC2-REAL-PATH-DELTA: a real delta build over a real git repo reuses every unit except the one changed file\u2019s, with original provenance and record_digest preserved', () => {
  const repoDir = scratchDir('delta-ac2-repo-');
  const cacheRoot = scratchDir('delta-ac2-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF);
  const parentSha = commit(repoDir, 'add invented network and storage resources');

  const parentBuild = planEstateUpdate({ pinManifest: pinManifestFor(REPO, repoDir, parentSha), mode: 'delta', cacheRoot });
  assert.equal(parentBuild.plan.receipts.length, 2, 'each invented .tf file routes to exactly one hcl unit');
  assert.ok(parentBuild.plan.receipts.every(receipt => receipt.disposition.kind === 'produced'), 'a first build has nothing to reuse');
  const originalByPath = new Map(parentBuild.plan.receipts.map(receipt => [receipt.scope.normalized_path, receipt]));
  const parentManifest = buildEstateManifestFromPlan({ ...parentBuild, pinManifestDigest: 'parent', parentBuildId: null });

  // Change exactly one file.
  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF.replace('receipts-queue', 'receipts-queue-v2'));
  const childSha = commit(repoDir, 'rename the invented receipts queue');

  const childBuild = planEstateUpdate({
    pinManifest: pinManifestFor(REPO, repoDir, childSha), mode: 'delta', cacheRoot, parentInventory: parentManifest.inventory.files,
  });
  const byPath = new Map(childBuild.plan.receipts.map(receipt => [receipt.scope.normalized_path, receipt]));

  // Dispositions counted from the real path's own output.
  const counts = childBuild.plan.receipts.reduce((acc, receipt) => {
    acc[receipt.disposition.kind] = (acc[receipt.disposition.kind] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { reused_exact: 1, produced: 1 });
  assert.equal(byPath.get('storage.tf').disposition.kind, 'produced', 'the changed file\u2019s unit must invalidate');
  assert.equal(byPath.get('network.tf').disposition.kind, 'reused_exact', 'the untouched file\u2019s unit must reuse');

  const reusedNetwork = byPath.get('network.tf');
  const originalNetwork = originalByPath.get('network.tf');
  assert.equal(reusedNetwork.disposition.source_receipt_digest, originalNetwork.receipt_digest, 'reuse must point back at the ORIGINAL receipt');
  assert.deepEqual(
    reusedNetwork.output.records.map(record => record.record_digest),
    originalNetwork.output.records.map(record => record.record_digest),
    'a reused record must retain its original record_digest, never a value the current producer minted',
  );
  assert.deepEqual(reusedNetwork.output.records, originalNetwork.output.records, 'reused output bytes must be byte-identical to the original producer\u2019s output');
});

test('AC3-REAL-EQUIVALENCE: a real delta build (with reuse) and a real full build over the same child commit agree on semantic content', () => {
  const repoDir = scratchDir('delta-ac3-repo-');
  const cacheRoot = scratchDir('delta-ac3-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF);
  const parentSha = commit(repoDir, 'add invented resources');
  const parentBuild = planEstateUpdate({ pinManifest: pinManifestFor(REPO, repoDir, parentSha), mode: 'delta', cacheRoot });
  const parentManifest = buildEstateManifestFromPlan({ ...parentBuild, pinManifestDigest: 'parent', parentBuildId: null });

  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF.replace('receipts-queue', 'receipts-queue-v2'));
  const childSha = commit(repoDir, 'update the invented receipts queue');
  const childPin = pinManifestFor(REPO, repoDir, childSha);

  const deltaBuild = planEstateUpdate({ pinManifest: childPin, mode: 'delta', cacheRoot, parentInventory: parentManifest.inventory.files });
  const deltaManifest = buildEstateManifestFromPlan({ ...deltaBuild, pinManifestDigest: 'child', parentBuildId: parentManifest.build_id });
  assert.ok(deltaBuild.plan.receipts.some(receipt => receipt.disposition.kind === 'reused_exact'), 'this comparison must exercise real reuse, not two identical full builds');

  const fullBuild = planEstateUpdate({ pinManifest: childPin, mode: 'full', cacheRoot: null });
  const fullManifest = buildEstateManifestFromPlan({ ...fullBuild, pinManifestDigest: 'child', parentBuildId: null });
  assert.ok(fullBuild.plan.receipts.every(receipt => receipt.disposition.kind === 'produced'), '--mode full must disable reuse entirely');

  assert.equal(deltaManifest.inventory.files_digest, fullManifest.inventory.files_digest, 'both builds must read the identical current inventory');
  assert.equal(deltaManifest.semantic_content_digest, fullManifest.semantic_content_digest);
  assert.notEqual(
    deltaManifest.execution_provenance_digest, fullManifest.execution_provenance_digest,
    'execution provenance (dispositions) is permitted, and expected, to differ',
  );

  const equivalence = compareFullAndDeltaBuilds({
    full: { manifest: fullManifest, plan: fullBuild.plan }, delta: { manifest: deltaManifest, plan: deltaBuild.plan },
  });
  assert.equal(equivalence.status, 'equivalent');
  assert.equal(equivalence.promotable, true);
});

test('AC3-REAL-EQUIVALENCE: a seeded divergence between a real delta build and a real full build is a typed, non-promotable DELTA_FULL_MISMATCH', () => {
  const repoDir = scratchDir('delta-ac3-mismatch-repo-');
  const cacheRoot = scratchDir('delta-ac3-mismatch-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF);
  const sha = commit(repoDir, 'add invented resources');
  const pinManifest = pinManifestFor(REPO, repoDir, sha);

  const deltaBuild = planEstateUpdate({ pinManifest, mode: 'delta', cacheRoot });
  const deltaManifest = buildEstateManifestFromPlan({ ...deltaBuild, pinManifestDigest: 'x', parentBuildId: null });
  const fullBuild = planEstateUpdate({ pinManifest, mode: 'full', cacheRoot: null });
  const fullManifest = buildEstateManifestFromPlan({ ...fullBuild, pinManifestDigest: 'x', parentBuildId: null });

  // Seed a divergence standing in for a missed-dependency/non-deterministic-producer bug
  // (docs/delta-updatable-estate-maps.md's falsifier table) -- NOT a claim that tools/extractors/*
  // are non-deterministic; the prior test already proves they agree byte for byte. Every other
  // structure here (plan, manifest, oracle) is the real one the extraction path produced.
  const seededPlan = {
    ...deltaBuild.plan,
    receipts: deltaBuild.plan.receipts.map(receipt => (
      receipt.scope.normalized_path === 'storage.tf'
        ? { ...receipt, output: { ...receipt.output, records: receipt.output.records.map(record => ({ ...record, record_digest: sha256('seeded-divergence') })) } }
        : receipt
    )),
  };
  const seededManifest = buildEstateManifestFromPlan({
    plan: seededPlan, pins: deltaBuild.pins, registry: deltaBuild.registry, pinManifestDigest: 'x', parentBuildId: null,
  });

  const equivalence = compareFullAndDeltaBuilds({
    full: { manifest: fullManifest, plan: fullBuild.plan }, delta: { manifest: seededManifest, plan: seededPlan },
  });
  assert.equal(equivalence.status, 'delta_full_mismatch');
  assert.equal(equivalence.code, DELTA_FULL_MISMATCH_CODE);
  assert.equal(equivalence.promotable, false, 'a mismatch must never be promotable');
  assert.notEqual(deltaManifest.semantic_content_digest, undefined); // sanity: the real (non-seeded) manifest was actually built
});

test('AC4-FAIL-CLOSED-PRESERVED: a deleted file leaves no retired record in the current build', () => {
  const repoDir = scratchDir('delta-ac4-delete-repo-');
  const cacheRoot = scratchDir('delta-ac4-delete-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  writeFileSync(join(repoDir, 'storage.tf'), STORAGE_TF);
  const parentSha = commit(repoDir, 'add invented resources');
  const parentBuild = planEstateUpdate({ pinManifest: pinManifestFor(REPO, repoDir, parentSha), mode: 'delta', cacheRoot });
  const parentManifest = buildEstateManifestFromPlan({ ...parentBuild, pinManifestDigest: 'parent', parentBuildId: null });

  rmSync(join(repoDir, 'storage.tf'));
  const childSha = commit(repoDir, 'remove the invented storage resource');
  const childBuild = planEstateUpdate({
    pinManifest: pinManifestFor(REPO, repoDir, childSha), mode: 'delta', cacheRoot, parentInventory: parentManifest.inventory.files,
  });

  assert.deepEqual(childBuild.plan.diff.deleted.map(entry => entry.normalized_path), ['storage.tf']);
  assert.ok(!childBuild.plan.receipts.some(receipt => receipt.scope.normalized_path === 'storage.tf'), 'no receipt for the deleted file');
  assert.ok(!childBuild.plan.expected_units.some(unit => unit.normalized_path === 'storage.tf'), 'no expected unit for the deleted file');
  const childManifest = buildEstateManifestFromPlan({ ...childBuild, pinManifestDigest: 'child', parentBuildId: parentManifest.build_id });
  assert.deepEqual(childManifest.inventory.deleted_since_parent, [{ repository: REPO, normalized_path: 'storage.tf' }]);
  assert.ok(!childManifest.inventory.files.some(file => file.normalized_path === 'storage.tf'), 'the current inventory names no retired record');
});

test('AC4-FAIL-CLOSED-PRESERVED: corrupting a cached record payload fails closed and recomputes rather than being trusted', () => {
  const repoDir = scratchDir('delta-ac4-payload-repo-');
  const cacheRoot = scratchDir('delta-ac4-payload-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  const sha = commit(repoDir, 'add invented network resource');
  const pinManifest = pinManifestFor(REPO, repoDir, sha);

  const build = planEstateUpdate({ pinManifest, mode: 'delta', cacheRoot });
  const unitId = build.plan.receipts[0].unit_id;
  const receiptPath = join(unitCacheDir(cacheRoot, unitId), 'receipt.json');
  const stored = JSON.parse(readFileSync(receiptPath, 'utf8'));
  stored.output.records[0] = { ...stored.output.records[0], normalized_record: { ...stored.output.records[0].normalized_record, name: 'corrupted-payload' } };
  writeFileSync(receiptPath, JSON.stringify(stored, null, 2));

  const corrupted = readUnitCacheEntry(cacheRoot, unitId);
  assert.equal(corrupted.status, 'miss');
  assert.equal(corrupted.reason, 'cache_corrupt');
  assert.equal(corrupted.code, 'DELTA_RECORD_DIGEST_MISMATCH');
  assert.ok(corrupted.quarantined_to, 'a corrupt object must be quarantined, never edited in place');

  const manifest = buildEstateManifestFromPlan({ ...build, pinManifestDigest: 'x', parentBuildId: null });
  const rerun = planEstateUpdate({ pinManifest, mode: 'delta', cacheRoot, parentInventory: manifest.inventory.files });
  assert.equal(rerun.plan.diff.unchanged.length, 1, 'the rerun must be a genuine reuse ATTEMPT: same commit, same inputs');
  assert.equal(rerun.plan.receipts[0].disposition.kind, 'produced', 'a corrupted cache entry must never be served as reused_exact');
  assert.ok(readdirSync(cacheRoot).some(name => name.includes('.quarantined.')), 'the quarantined object must remain on disk, never deleted-and-forgotten');
});

test('AC4-FAIL-CLOSED-PRESERVED: corrupting a cached receipt digest fails closed and recomputes rather than being trusted', () => {
  const repoDir = scratchDir('delta-ac4-receipt-repo-');
  const cacheRoot = scratchDir('delta-ac4-receipt-cache-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'network.tf'), NETWORK_TF);
  const sha = commit(repoDir, 'add invented network resource');
  const pinManifest = pinManifestFor(REPO, repoDir, sha);

  const build = planEstateUpdate({ pinManifest, mode: 'delta', cacheRoot });
  const unitId = build.plan.receipts[0].unit_id;
  const receiptPath = join(unitCacheDir(cacheRoot, unitId), 'receipt.json');
  const stored = JSON.parse(readFileSync(receiptPath, 'utf8'));
  stored.receipt_digest = sha256('tampered-receipt-digest');
  writeFileSync(receiptPath, JSON.stringify(stored, null, 2));

  const corrupted = readUnitCacheEntry(cacheRoot, unitId);
  assert.equal(corrupted.status, 'miss');
  assert.equal(corrupted.reason, 'cache_corrupt');
  assert.equal(corrupted.code, 'DELTA_RECEIPT_DIGEST_MISMATCH');
  assert.ok(corrupted.quarantined_to);

  const manifest = buildEstateManifestFromPlan({ ...build, pinManifestDigest: 'x', parentBuildId: null });
  const rerun = planEstateUpdate({ pinManifest, mode: 'delta', cacheRoot, parentInventory: manifest.inventory.files });
  assert.equal(rerun.plan.receipts[0].disposition.kind, 'produced');
  assert.ok(readdirSync(cacheRoot).some(name => name.includes('.quarantined.')));
});
