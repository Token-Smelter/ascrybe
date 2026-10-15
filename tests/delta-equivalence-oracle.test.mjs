// AC5-EQUIVALENCE-ORACLE: a delta build and a full build over the same immutable fixture inputs
// produce equal semantic content (equal semantic_content_digest and equal observation-id/
// record-digest multisets) while being permitted to differ in execution provenance. A seeded
// divergence produces a typed DELTA_FULL_MISMATCH refusal retained as a diagnostic, never
// promotable. Invented fixture names throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../tools/lib.mjs';
import { planDeltaUnits } from '../tools/delta/planner.mjs';
import { assembleEstateBuildManifest } from '../tools/delta/manifest.mjs';
import { compareFullAndDeltaBuilds } from '../tools/delta/equivalence.mjs';
import { tryReuseUnit, writeUnitCacheEntry } from '../tools/delta/unit-cache.mjs';
import { buildProducedFileUnitReceipt } from '../tools/delta/extraction-unit.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const declarationsExtractor = Object.freeze({
  id: 'invented-declarations', routing_contract_digest: sha256('routing-declarations'), output_contract: 'invented-declarations@1',
  identity_contract: 'invented-declaration-identity@1', implementation_digest: sha256('impl-declarations-v1'),
  configuration_digest: sha256('config-v1'), runtime_digest: sha256('runtime-v1'),
});
function fileEntry(repository, normalizedPath, bytes) {
  return {
    repository, normalized_path: normalizedPath, blob_oid: `blob-${sha256(bytes).slice(0, 12)}`, content_sha256: sha256(bytes),
  };
}
function registry(divergent = false) {
  return [{
    extractor: declarationsExtractor, matches: path => path.endsWith('.mjs'),
    produce: entry => [{
      observation_kind: 'symbol', producer_local_key: entry.normalized_path, output_schema: 'invented-declarations@1',
      normalized_record: { path: entry.normalized_path, divergent },
    }],
  }];
}
const source = Object.freeze({
  pin_manifest_digest: sha256('pins'), materialization_receipt_digest: sha256('materialization'),
  pins: { 'amber-ledger': 'a'.repeat(40) },
});
const plannerBlock = Object.freeze({ version: 'invented-delta-planner@1', producer_registry_digest: sha256('registry'), parent_build_id: null });

function build(currentInventory, { parentInventory = [], cacheRoot = null, divergent = false } = {}) {
  const plan = planDeltaUnits({ parent_inventory: parentInventory, current_inventory: currentInventory, registry: registry(divergent), cache_root: cacheRoot });
  const manifest = assembleEstateBuildManifest({
    source, plan, planner: plannerBlock, configuration_digest: sha256('config'), runtime_digest: sha256('runtime'), policy_digest: sha256('policy'),
  });
  return { plan, manifest };
}

test('a delta build (per-unit reuse) and a full build (nothing cached) produce equal semantic content', () => {
  const cacheRoot = scratchDir('delta-equivalence-');
  try {
    const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
    const gateway = fileEntry('amber-ledger', 'src/gateway.mjs', 'const GatewayEntry = 1;');

    // Full mode: nothing cached, both units are freshly produced.
    const full = build([ledger, gateway]);

    // Delta mode: pre-populate the per-unit cache (as a prior build would have), then plan again
    // with the SAME immutable inputs so both units reuse exactly.
    for (const receipt of full.plan.receipts) writeUnitCacheEntry(cacheRoot, receipt);
    const delta = build([ledger, gateway], { parentInventory: [ledger, gateway], cacheRoot });
    assert.ok(delta.plan.receipts.every(receipt => receipt.disposition.kind === 'reused_exact'), 'the delta build must actually exercise reuse for this to be a meaningful oracle run');

    const result = compareFullAndDeltaBuilds({ full, delta });
    assert.equal(result.status, 'equivalent');
    assert.equal(result.promotable, true);
    assert.equal(full.manifest.semantic_content_digest, delta.manifest.semantic_content_digest);
    // Execution provenance is permitted (expected) to differ: full produced, delta reused.
    assert.notEqual(full.manifest.execution_provenance_digest, delta.manifest.execution_provenance_digest);
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});

test('a seeded divergence between full and delta output produces a typed, non-promotable DELTA_FULL_MISMATCH', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const full = build([ledger]);
  const delta = build([ledger], { divergent: true }); // same inputs, deliberately different producer output
  assert.equal(full.manifest.inventory.files_digest, delta.manifest.inventory.files_digest, 'the seed must keep the same immutable inputs');
  const result = compareFullAndDeltaBuilds({ full, delta });
  assert.equal(result.status, 'delta_full_mismatch');
  assert.equal(result.code, 'DELTA_FULL_MISMATCH');
  assert.equal(result.promotable, false);
  assert.equal(result.diagnostic.semantic_content_digest_equal, false);
  assert.ok(result.diagnostic.only_in_full.length > 0 || result.diagnostic.only_in_delta.length > 0);
});

test('equivalence over different immutable inputs is refused rather than silently compared', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const gateway = fileEntry('amber-ledger', 'src/gateway.mjs', 'const GatewayEntry = 1;');
  const full = build([ledger]);
  const delta = build([ledger, gateway]);
  assert.throws(() => compareFullAndDeltaBuilds({ full, delta }), error => error.code === 'DELTA_EQUIVALENCE_INPUT_INVALID');
});

test('falsifier: changing extractor bytes without a version label moves implementation_digest and blocks reuse', () => {
  const cacheRoot = scratchDir('delta-equivalence-');
  try {
    const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
    const original = buildProducedFileUnitReceipt({
      ...ledger, extractor: declarationsExtractor,
      records: [{ observation_kind: 'symbol', producer_local_key: 'LedgerEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'LedgerEntry' } }],
    });
    writeUnitCacheEntry(cacheRoot, original);

    const bumpedExtractor = { ...declarationsExtractor, implementation_digest: sha256('impl-declarations-v2-unlabeled') };
    const bumped = buildProducedFileUnitReceipt({
      ...ledger, extractor: bumpedExtractor,
      records: [{ observation_kind: 'symbol', producer_local_key: 'LedgerEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'LedgerEntry' } }],
    });
    assert.notEqual(bumped.unit_id, original.unit_id, 'implementation_digest is part of extractor_contract_dependencies, so payload_unit_id must move');

    const reuse = tryReuseUnit(cacheRoot, { unit_id: bumped.unit_id, inputs: bumped.inputs });
    assert.equal(reuse.status, 'miss', 'the old cache entry lives under the OLD unit_id and cannot satisfy the new one');
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});
