// AC4-MANIFEST-CONSERVATION: a complete Estate Build Manifest carries the design's required
// fields, and the conservation identities hold as disjoint sets keyed by exact identity
// (expected_units = produced + reused_exact + migrated + refused; inventoried vs parent path
// partitions; unique observation IDs). A seeded violation of any identity is rejected with a typed
// code and the build is marked diagnostic-only, never complete. Invented fixture names throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../tools/lib.mjs';
import { planDeltaUnits } from '../tools/delta/planner.mjs';
import { assembleEstateBuildManifest, ESTATE_BUILD_MANIFEST_SCHEMA } from '../tools/delta/manifest.mjs';

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
function registry() {
  return [{
    extractor: declarationsExtractor, matches: path => path.endsWith('.mjs'),
    produce: entry => [{
      observation_kind: 'symbol', producer_local_key: entry.normalized_path, output_schema: 'invented-declarations@1',
      normalized_record: { path: entry.normalized_path },
    }],
  }];
}
const source = Object.freeze({
  pin_manifest_digest: sha256('pins'), materialization_receipt_digest: sha256('materialization'),
  pins: { 'amber-ledger': 'a'.repeat(40) },
});
const plannerBlock = Object.freeze({ version: 'invented-delta-planner@1', producer_registry_digest: sha256('registry'), parent_build_id: null });

function buildManifest(currentInventory, parentInventory = []) {
  const plan = planDeltaUnits({ parent_inventory: parentInventory, current_inventory: currentInventory, registry: registry() });
  return { plan, manifest: assembleEstateBuildManifest({ source, plan, planner: plannerBlock, configuration_digest: sha256('config'), runtime_digest: sha256('runtime'), policy_digest: sha256('policy') }) };
}

test('a valid plan produces a complete, promotable manifest carrying the design-required fields', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const { manifest } = buildManifest([ledger]);
  assert.equal(manifest.schema, ESTATE_BUILD_MANIFEST_SCHEMA);
  for (const field of ['build_id', 'execution_id', 'source', 'inventory', 'memberships', 'planner', 'units', 'records', 'downstream', 'completeness', 'semantic_content_digest', 'execution_provenance_digest', 'manifest_digest']) {
    assert.ok(field in manifest, `manifest is missing required field ${field}`);
  }
  assert.equal(manifest.completeness.status, 'complete');
  assert.equal(manifest.promotable, true);
  assert.equal(manifest.units.expected.length, 1);
  assert.deepEqual(manifest.units.produced, manifest.units.expected);
  assert.deepEqual(manifest.units.reused_exact, []);
  assert.deepEqual(manifest.units.refused, []);
});

test('expected_units = produced ⊎ reused_exact ⊎ migrated ⊎ refused (seeded violation: duplicate disposition)', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const { plan, manifest } = buildManifest([ledger]);
  const seededPlan = { ...plan, receipts: [...plan.receipts, plan.receipts[0]] };
  const seeded = assembleEstateBuildManifest({ source, plan: seededPlan, planner: plannerBlock, configuration_digest: sha256('config'), runtime_digest: sha256('runtime'), policy_digest: sha256('policy') });
  assert.equal(seeded.completeness.status, 'diagnostic');
  assert.equal(seeded.promotable, false);
  assert.ok(seeded.completeness.violations.some(violation => violation.code === 'DELTA_PLANNER_DUPLICATE_DISPOSITION'));
  assert.notEqual(seeded.manifest_digest, manifest.manifest_digest);
});

test('inventoried vs parent path partitions (seeded violation: a path counted twice in one partition)', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const { plan } = buildManifest([ledger]);
  const seededDiff = { ...plan.diff, added: [...plan.diff.added, ...plan.diff.added] };
  const seededPlan = { ...plan, diff: seededDiff };
  const seeded = assembleEstateBuildManifest({ source, plan: seededPlan, planner: plannerBlock, configuration_digest: sha256('config'), runtime_digest: sha256('runtime'), policy_digest: sha256('policy') });
  assert.equal(seeded.completeness.status, 'diagnostic');
  assert.equal(seeded.promotable, false);
  assert.ok(seeded.completeness.violations.some(violation => violation.code === 'DELTA_CONSERVATION_VIOLATION_PATH_PARTITION'));
});

test('unique observation IDs (seeded violation: two receipts share one observation_id)', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const gateway = fileEntry('amber-ledger', 'src/gateway.mjs', 'const GatewayEntry = 1;');
  const { plan } = buildManifest([ledger, gateway]);
  const collidedRecord = { ...plan.receipts[1].output.records[0], observation_id: plan.receipts[0].output.records[0].observation_id };
  const collidedReceipt = { ...plan.receipts[1], output: { ...plan.receipts[1].output, records: [collidedRecord] } };
  const seededPlan = { ...plan, receipts: [plan.receipts[0], collidedReceipt] };
  const seeded = assembleEstateBuildManifest({ source, plan: seededPlan, planner: plannerBlock, configuration_digest: sha256('config'), runtime_digest: sha256('runtime'), policy_digest: sha256('policy') });
  assert.equal(seeded.completeness.status, 'diagnostic');
  assert.equal(seeded.promotable, false);
  assert.ok(seeded.completeness.violations.some(violation => violation.code === 'DELTA_CONSERVATION_VIOLATION_OBSERVATION_ID_DUPLICATE'));
});

test('falsifier: add-then-delete leaves no retired record in the current build', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const obsolete = fileEntry('amber-ledger', 'src/obsolete.mjs', 'const Obsolete = 1;');
  const { manifest: added } = buildManifest([ledger, obsolete], []);
  assert.equal(added.units.expected.length, 2);
  const { manifest: afterDelete } = buildManifest([ledger], [ledger, obsolete]);
  assert.equal(afterDelete.units.expected.length, 1);
  assert.equal(afterDelete.inventory.deleted_since_parent.length, 1);
  assert.equal(afterDelete.inventory.deleted_since_parent[0].normalized_path, 'src/obsolete.mjs');
  const survivingPaths = afterDelete.inventory.files.map(file => file.normalized_path);
  assert.ok(!survivingPaths.includes('src/obsolete.mjs'), 'a deleted path must not remain in the current build inventory');
});

test('falsifier: a rename is delete-plus-add by default (no continuity, both observation_ids present)', () => {
  const bytes = 'const RenamedEntry = 1;';
  const before = fileEntry('amber-ledger', 'src/old-name.mjs', bytes);
  const after = fileEntry('amber-ledger', 'src/new-name.mjs', bytes);
  const { plan, manifest } = buildManifest([after], [before]);
  assert.equal(plan.diff.added.length, 1);
  assert.equal(plan.diff.deleted.length, 1);
  assert.equal(plan.diff.rename_candidates.length, 1, 'an advisory rename candidate is recorded, but never consulted for identity');
  assert.equal(manifest.inventory.renamed_since_parent.length, 0, 'rename continuity is not implemented; the manifest never claims a supersession');
  assert.equal(manifest.units.produced.length, 1, 'the new path is produced fresh, never reused across the rename');
});
