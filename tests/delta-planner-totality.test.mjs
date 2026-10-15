// AC3-PLANNER-TOTALITY: the delta planner emits an exhaustive expected unit set in which every
// expected unit carries exactly one terminal disposition from {produced, reused_exact, migrated,
// refused}. A fixture with a missing disposition, a duplicate disposition, or an expected unit
// absent from the receipts fails closed with a typed error code and produces no promotable build.
// Also covers the falsifier "add a second matching extractor: expected unit set grows; missing
// output blocks completeness." Invented fixture names throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../tools/lib.mjs';
import { buildProducedFileUnitReceipt, buildRefusedFileUnitReceipt } from '../tools/delta/extraction-unit.mjs';
import { diffInventories, planDeltaUnits, validateUnitTotality } from '../tools/delta/planner.mjs';

const declarationsExtractor = Object.freeze({
  id: 'invented-declarations', routing_contract_digest: sha256('routing-declarations'), output_contract: 'invented-declarations@1',
  identity_contract: 'invented-declaration-identity@1', implementation_digest: sha256('impl-declarations-v1'),
  configuration_digest: sha256('config-v1'), runtime_digest: sha256('runtime-v1'),
});
const referencesExtractor = Object.freeze({
  id: 'invented-references', routing_contract_digest: sha256('routing-references'), output_contract: 'invented-references@1',
  identity_contract: 'invented-reference-identity@1', implementation_digest: sha256('impl-references-v1'),
  configuration_digest: sha256('config-v1'), runtime_digest: sha256('runtime-v1'),
});

function fileEntry(repository, normalizedPath, bytes) {
  return {
    repository, normalized_path: normalizedPath, blob_oid: `blob-${sha256(bytes).slice(0, 12)}`, content_sha256: sha256(bytes),
  };
}
function declarationsRoute(produce) {
  return { extractor: declarationsExtractor, matches: path => path.endsWith('.mjs'), produce };
}

test('a missing disposition (expected unit absent from receipts) fails closed with a typed code', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const produced = buildProducedFileUnitReceipt({
    ...ledger, extractor: declarationsExtractor,
    records: [{ observation_kind: 'symbol', producer_local_key: 'LedgerEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'LedgerEntry' } }],
  });
  assert.throws(
    () => validateUnitTotality({ expected_units: [{ unit_id: produced.unit_id }, { unit_id: 'unit:missing' }], receipts: [produced] }),
    error => error.code === 'DELTA_PLANNER_MISSING_DISPOSITION',
  );
});

test('a duplicate disposition (two receipts for one unit) fails closed with a typed code', () => {
  const gateway = fileEntry('cobalt-gateway', 'src/router.mjs', 'const RouterEntry = 1;');
  const producedOnce = buildProducedFileUnitReceipt({
    ...gateway, extractor: declarationsExtractor,
    records: [{ observation_kind: 'symbol', producer_local_key: 'RouterEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'RouterEntry' } }],
  });
  const refused = buildRefusedFileUnitReceipt({ ...gateway, extractor: declarationsExtractor, reason_code: 'DELTA_TEST_REFUSAL', reason: 'seeded duplicate for the test' });
  assert.throws(
    () => validateUnitTotality({ expected_units: [{ unit_id: producedOnce.unit_id }], receipts: [producedOnce, refused] }),
    error => error.code === 'DELTA_PLANNER_DUPLICATE_DISPOSITION',
  );
});

test('a nonterminal disposition kind fails closed with a typed code', () => {
  const gateway = fileEntry('cobalt-gateway', 'src/router.mjs', 'const RouterEntry = 1;');
  const produced = buildProducedFileUnitReceipt({
    ...gateway, extractor: declarationsExtractor,
    records: [{ observation_kind: 'symbol', producer_local_key: 'RouterEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'RouterEntry' } }],
  });
  const nonterminal = { ...produced, disposition: { ...produced.disposition, kind: 'planning' } };
  assert.throws(
    () => validateUnitTotality({ expected_units: [{ unit_id: produced.unit_id }], receipts: [nonterminal] }),
    error => error.code === 'DELTA_PLANNER_NONTERMINAL_DISPOSITION',
  );
});

test('planDeltaUnits enumerates one expected unit per file/extractor pair and validates totality', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const registry = [declarationsRoute(entry => [{
    observation_kind: 'symbol', producer_local_key: 'LedgerEntry', output_schema: 'invented-declarations@1', normalized_record: { name: 'LedgerEntry' },
  }])];
  const plan = planDeltaUnits({ parent_inventory: [], current_inventory: [ledger], registry });
  assert.equal(plan.expected_units.length, 1);
  assert.equal(plan.receipts.length, 1);
  assert.equal(plan.receipts[0].disposition.kind, 'produced');
});

test('falsifier: adding a second matching extractor grows the expected unit set', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const oneExtractor = [declarationsRoute(() => [])];
  const twoExtractors = [
    declarationsRoute(() => []),
    { extractor: referencesExtractor, matches: path => path.endsWith('.mjs'), produce: () => [] },
  ];
  const onePlan = planDeltaUnits({ parent_inventory: [], current_inventory: [ledger], registry: oneExtractor });
  const twoPlan = planDeltaUnits({ parent_inventory: [], current_inventory: [ledger], registry: twoExtractors });
  assert.equal(onePlan.expected_units.length, 1);
  assert.equal(twoPlan.expected_units.length, 2);
  assert.notEqual(onePlan.expected_units[0].unit_id, twoPlan.expected_units.find(unit => unit.extractor_id === 'invented-references').unit_id);
});

test('falsifier: a missing receipt for an otherwise-expected unit blocks completeness', () => {
  const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
  const registry = [
    declarationsRoute(() => []),
    { extractor: referencesExtractor, matches: path => path.endsWith('.mjs'), produce: () => [] },
  ];
  const plan = planDeltaUnits({ parent_inventory: [], current_inventory: [ledger], registry });
  assert.equal(plan.expected_units.length, 2);
  // Simulate a planner defect that silently drops one unit's receipt.
  const droppedReceipts = plan.receipts.slice(0, 1);
  assert.throws(
    () => validateUnitTotality({ expected_units: plan.expected_units, receipts: droppedReceipts }),
    error => error.code === 'DELTA_PLANNER_MISSING_DISPOSITION',
  );
});

test('diffInventories partitions added/unchanged/modified/deleted with no overlap', () => {
  const parent = [
    fileEntry('amber-ledger', 'src/ledger.mjs', 'v1'),
    fileEntry('amber-ledger', 'src/obsolete.mjs', 'gone'),
  ];
  const current = [
    fileEntry('amber-ledger', 'src/ledger.mjs', 'v2'),
    fileEntry('amber-ledger', 'src/new-file.mjs', 'new'),
  ];
  const diff = diffInventories(parent, current);
  assert.deepEqual(diff.added.map(entry => entry.normalized_path), ['src/new-file.mjs']);
  assert.deepEqual(diff.modified.map(entry => entry.normalized_path), ['src/ledger.mjs']);
  assert.deepEqual(diff.unchanged, []);
  assert.deepEqual(diff.deleted.map(entry => entry.normalized_path), ['src/obsolete.mjs']);
});
