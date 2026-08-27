import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaimProjection, buildGraphCommit, buildMigrationProvenanceReceipt,
  buildSourceStalenessReceipt, claimAssertionId, CLAIM_PROJECTION_SCHEMA_VERSION,
  verifyClaimProjection, verifyGraphCommit, verifyPhaseAExit, verifyStatusDerivation,
} from '../tools/claim-projection.mjs';
import { buildArgumentMentionSubstrate, sourceVersionIdForInventory } from '../tools/argument-mentions.mjs';
import { buildPropositionObligationInventory } from '../tools/proposition-obligations.mjs';
import { inventoryMarkdown } from '../tools/recursive-contracts.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const capturedAt = '2026-08-06T12:00:00.000Z';
const materializationId = 'materialization:a2-test';

function heldFixture({ sourceState = 'current', withStaleness = false } = {}) {
  const content = '# Rule\n\nThe router sends payload to AuditService.\n';
  const inventory = inventoryMarkdown({ path: 'docs/rule.md', content, source_sha: 'source:fixture', corpus_digest: 'corpus:fixture' });
  const obligationInventory = buildPropositionObligationInventory({ inventories: [inventory] });
  const unit = obligationInventory.units.find(row => row.locator.text.includes('router sends'));
  const subjectStart = unit.locator.text.indexOf('router');
  const prefix = unit.locator.text.slice(0, subjectStart);
  const sourceLocator = {
    file: unit.locator.file,
    start: unit.locator.start,
    end: unit.locator.start,
    byte_start: unit.locator.byte_start + Buffer.byteLength(prefix, 'utf8'),
    byte_end: unit.locator.byte_start + Buffer.byteLength(prefix + 'router', 'utf8'),
    text: 'router',
    text_digest: sha256('router'),
    block_id: unit.locator.block_id,
    block_address: unit.locator.block_address,
  };
  const claim = {
    schema: 'estate-map/documentary-claim/v3.3',
    id: 'claim-v33:fixture',
    proposition_key: 'proposition:fixture',
    core_proposition_key: 'core:fixture',
    evidence_key: 'evidence:fixture',
    repair_findings: [],
    semantic: {
      subject: { surface: 'router', source_locator: sourceLocator },
      predicate_family: 'sends',
      object_or_value: 'payload',
      polarity: 'affirmed',
      modality: 'descriptive',
      quantifier: 'one',
      scope: {},
      valid_time: {},
      projection_eligible: true,
      support_sets: [{ mode: 'all_required', locators: [{ ...unit.locator, role: 'primary', id: 'locator:fixture' }] }],
    },
    extraction: { unit_id: 'window:fixture' },
    extraction_provenance: [{ claim_id: 'claim-v33:fixture', unit_id: 'window:fixture' }],
  };
  const argumentSubstrate = buildArgumentMentionSubstrate({
    inventory: obligationInventory,
    inventories: [inventory],
    claims: [claim],
    materialization_id: materializationId,
  });
  const sourceVersion = {
    source_version_id: sourceVersionIdForInventory(inventory),
    resource_id: 'git-path:docs/rule.md',
    captured_at: capturedAt,
    state: sourceState,
  };
  const migration = buildMigrationProvenanceReceipt({
    basis_claim_id: claim.id,
    source_version: sourceVersion,
    capture_basis: 'fixture:immutable-capture',
    materialization_id: materializationId,
  });
  const staleness = withStaleness ? [buildSourceStalenessReceipt({
    prior_supporting_source_version_id: sourceVersion.source_version_id,
    to_state: sourceState,
    transition_source_version_id: 'source-version:transition',
    materialization_id: materializationId,
  })] : [];
  const claimSources = { [claim.id]: [sourceVersion.source_version_id] };
  const lineage = { [claim.id]: { lineage_status: 'valid', lineage_finding_ids: [], findings: [] } };
  const projection = buildClaimProjection({
    admitted_claims: [claim],
    argument_substrate: argumentSubstrate,
    source_versions: [sourceVersion],
    claim_source_version_ids: claimSources,
    source_staleness_receipts: staleness,
    migration_provenance_receipts: [migration],
    lineage_facts: lineage,
    materialization_id: materializationId,
  });
  return { claim, argumentSubstrate, sourceVersion, migration, staleness, claimSources, lineage, projection };
}

function commitFor(projection) {
  return buildGraphCommit({
    source_head: 'source:fixture',
    claim_projection_receipts: projection.claim_projection_receipts,
    dependency_index_digest: 'dependency:fixture',
    added_object_digests: [projection.digest],
  });
}

function rehashProjectionReceipt(receipt) {
  const { receipt_id: _receiptId, ...body } = receipt;
  return {
    ...body,
    receipt_id: `claim-projection-receipt:${sha256(stableStringify(body).trim())}`,
  };
}

test('assertion identity is exactly claim, sorted exact bindings, and schema version', () => {
  const identity = {
    basis_claim_id: 'claim:one',
    argument_mentions: [
      { role: 'object', literal: 'value' },
      { role: 'subject', mention_id: 'mention:one' },
    ],
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
  };
  const expected = claimAssertionId(identity);
  assert.equal(claimAssertionId({
    ...identity,
    argument_mentions: identity.argument_mentions.slice().reverse(),
    referent_ids: ['referent:changed'],
    predicate_concept_id: 'concept:changed',
    ontology_head: 'ontology:changed',
    query_policy: 'policy:changed',
    display_type: 'ChangedType',
  }), expected);
  assert.notEqual(claimAssertionId({ ...identity, argument_mentions: [{ role: 'object', literal: 'changed' }] }), expected);
});

test('current source status and recorded time derive only from pinned source-version provenance', () => {
  const held = heldFixture();
  const assertion = held.projection.assertions[0];
  assert.deepEqual({ source_status: assertion.source_status, decision_status: assertion.decision_status, recorded_time: assertion.recorded_time }, {
    source_status: 'current', decision_status: 'none', recorded_time: capturedAt,
  });
  assert.equal(assertion.migration_provenance_receipt_id, held.migration.receipt_id);
  assert.equal(verifyStatusDerivation({
    projection: held.projection,
    source_versions: [held.sourceVersion],
    claim_source_version_ids: held.claimSources,
  }), true);
});

test('[falsifier: deleted-source status] deleted support requires staleness and rejects a current assertion', () => {
  const complete = heldFixture({ sourceState: 'deleted', withStaleness: true });
  assert.equal(complete.projection.assertions[0].source_status, 'historical');
  assert.deepEqual(complete.projection.assertions[0].source_staleness_receipt_ids, [complete.staleness[0].receipt_id]);
  const negated = structuredClone(complete.projection);
  negated.assertions[0].source_status = 'current';
  assert.throws(() => verifyStatusDerivation({
    projection: negated,
    source_versions: [complete.sourceVersion],
    claim_source_version_ids: complete.claimSources,
  }), error => error.code === 'STATUS_TIME_DERIVATION_MISMATCH');

  const missing = heldFixture({ sourceState: 'deleted', withStaleness: false });
  assert.equal(missing.projection.claim_projection_receipts[0].disposition, 'terminal_incomplete');
  assert.equal(missing.projection.assertions.length, 0);
});

test('projection has exactly one referentially valid receipt for every admitted claim', () => {
  const held = heldFixture();
  assert.deepEqual(verifyClaimProjection({
    admitted_claims: [held.claim], projection: held.projection, expected_lineage_facts: held.lineage,
  }), {
    claims: 1,
    receipts: 1,
    assertions: 1,
    claim_plane_projection_digest: held.projection.claim_plane_projection_digest,
  });
});

test('an assertion must be cited by its claim projection receipt', () => {
  const held = heldFixture();
  const changed = structuredClone(held.projection);
  const extra = {
    ...structuredClone(changed.assertions[0]),
    argument_mentions: [{ role: 'object', literal: 'unreceipted' }],
  };
  extra.assertion_id = claimAssertionId(extra);
  changed.assertions.push(extra);
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: changed }),
    error => error.code === 'UNRECEIPTED_ASSERTION');
});

test('rejected projection requires findings and can never cite an assertion', () => {
  const held = heldFixture();
  const rejected = structuredClone(held.projection);
  rejected.claim_projection_receipts[0].disposition = 'rejected_projection';
  rejected.claim_projection_receipts[0].findings = [];
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: rejected }),
    error => error.code === 'INVALID_REJECTED_PROJECTION');
});

test('[falsifier: favorable disposition assertion cardinality] fully projected claim cannot disappear', () => {
  const held = heldFixture();
  const disappeared = structuredClone(held.projection);
  disappeared.assertions = [];
  disappeared.claim_projection_receipts[0].assertion_ids = [];
  disappeared.claim_projection_receipts[0] = rehashProjectionReceipt(disappeared.claim_projection_receipts[0]);
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: disappeared }),
    error => error.code === 'DISPOSITION_ASSERTION_CARDINALITY_MISMATCH');
});

test('[falsifier: unresolved disposition assertion cardinality] unresolved claim cannot cite an assertion', () => {
  const held = heldFixture();
  const unresolved = structuredClone(held.projection);
  unresolved.claim_projection_receipts[0].disposition = 'unresolved_argument_mentions';
  unresolved.claim_projection_receipts[0] = rehashProjectionReceipt(unresolved.claim_projection_receipts[0]);
  unresolved.assertions[0].projection_receipt_id = unresolved.claim_projection_receipts[0].receipt_id;
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: unresolved }),
    error => error.code === 'DISPOSITION_ASSERTION_CARDINALITY_MISMATCH');
});

test('[falsifier: claim conservation] changed custody bytes or receipt cardinality fail closed', () => {
  const held = heldFixture();
  const changed = structuredClone(held.projection);
  changed.documentary_claims[0].proposition_key = 'proposition:changed';
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: changed }),
    error => error.code === 'CLAIM_BYTES_CHANGED');
  const duplicate = structuredClone(held.projection);
  duplicate.claim_projection_receipts.push(structuredClone(duplicate.claim_projection_receipts[0]));
  assert.throws(() => verifyClaimProjection({ admitted_claims: [held.claim], projection: duplicate }),
    error => error.code === 'PROJECTION_RECEIPT_CARDINALITY');
});

test('GraphCommit records exact terminal sets and an incomplete head fails Phase A exit', () => {
  const held = heldFixture({ sourceState: 'deleted', withStaleness: false });
  const commit = commitFor(held.projection);
  const receipt = held.projection.claim_projection_receipts[0];
  assert.deepEqual({
    status: commit.claim_projection_status,
    receipts: commit.incomplete_claim_projection_receipt_ids,
    claims: commit.incomplete_claim_ids,
  }, { status: 'incomplete', receipts: [receipt.receipt_id], claims: [held.claim.id] });
  assert.equal(verifyGraphCommit({ graph_commit: commit, claim_projection_receipts: held.projection.claim_projection_receipts }), true);
  assert.throws(() => verifyPhaseAExit({
    admitted_claims: [held.claim],
    projection: held.projection,
    graph_commit: commit,
    source_versions: [held.sourceVersion],
    claim_source_version_ids: held.claimSources,
  }), error => error.code === 'PHASE_A_EXIT_INCOMPLETE');

  const dishonest = { ...commit, incomplete_claim_ids: [] };
  assert.throws(() => verifyGraphCommit({ graph_commit: dishonest, claim_projection_receipts: held.projection.claim_projection_receipts }),
    error => error.code === 'GRAPH_COMMIT_INCOMPLETE_SET_MISMATCH');
});

test('a complete projection and GraphCommit satisfy the Phase A structural exit', () => {
  const held = heldFixture();
  const result = verifyPhaseAExit({
    admitted_claims: [held.claim],
    projection: held.projection,
    graph_commit: commitFor(held.projection),
    source_versions: [held.sourceVersion],
    claim_source_version_ids: held.claimSources,
    expected_lineage_facts: held.lineage,
  });
  assert.equal(result.claims, 1);
});
