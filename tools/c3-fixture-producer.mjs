// Identity-bearing C3a falsifier fixtures assembled through the live C1/C2 producers.
// These fixtures are deliberately small enough for transactional failure and rebuild proofs.
import {
  buildAssertionSupersessionLedger, buildAssertionSupersessionReceipt,
  buildServingAssertionPlane, groundedAssertionId, identityHeadForResolution,
  GROUNDED_ASSERTION_SCHEMA, GROUNDED_ASSERTION_SCHEMA_VERSION,
} from './serving-assertions.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityVerificationRegistry, resolveIdentityComponents,
} from './referent-identity.mjs';
import {
  buildGraphCommit, claimAssertionId, CLAIM_ASSERTION_SCHEMA,
  CLAIM_PROJECTION_RECEIPT_SCHEMA, CLAIM_PROJECTION_SCHEMA_VERSION,
} from './claim-projection.mjs';
import { ARGUMENT_BINDING_COVERAGE_SCHEMA, buildMention } from './argument-mentions.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { buildRelationProjectionPolicy } from './c3-serving-projection.mjs';

const materializationId = 'materialization:c3-identity-fixture';
const canonical = value => stableStringify(value).trim();
const hashId = (prefix, body) => `${prefix}:${sha256(canonical(body))}`;

function emptyProjection(claims = [], assertions = [], receipts = []) {
  return {
    schema: 'estate-map/claim-projection-bundle/v1',
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    materialization_id: materializationId,
    documentary_claims: claims,
    lineage_facts: {},
    claim_plane_projection_digest: sha256(stableStringify(claims)),
    assertions,
    claim_projection_receipts: receipts,
    argument_binding_coverage_receipts: [],
    source_staleness_receipts: [],
    migration_provenance_receipts: [],
    digest: 'fixture:claim-projection',
  };
}

function identityAliasRecords(left, right, label) {
  const basisClaimId = `claim:identity-alias:${label}`;
  const argumentMentions = [
    { role: 'subject', mention_id: left.mention.mention_id },
    { role: 'object', mention_id: right.mention.mention_id },
  ];
  const assertionId = claimAssertionId({ basis_claim_id: basisClaimId,
    argument_mentions: argumentMentions });
  const receipt = projectionReceipt(basisClaimId, [assertionId]);
  return {
    assertion: {
      schema: CLAIM_ASSERTION_SCHEMA, assertion_id: assertionId, basis_claim_id: basisClaimId,
      argument_mentions: argumentMentions, projection_receipt_id: receipt.receipt_id,
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    },
    receipt,
  };
}

function aliasConstraint(left, right, alias, verificationRegistry) {
  return buildAutomaticIdentityConstraint({
    left: left.mention.mention_id,
    right: right.mention.mention_id,
    basis: { kind: 'source_cited_alias', alias_assertion_id: alias.assertion.assertion_id },
    basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
    basis_assertion_ids: [alias.assertion.assertion_id],
    source_status: 'current', materialization_id: materializationId,
  }, verificationRegistry);
}

function relationAssertion({ assertionLabel, predicateConceptId, subjectReferentId, objectReferentId,
  basisReceiptId }) {
  const body = {
    schema: GROUNDED_ASSERTION_SCHEMA,
    assertion_origin: 'identity_receipt',
    basis_evidence_ids: [],
    basis_receipt_ids: [basisReceiptId],
    assertion_schema_version: GROUNDED_ASSERTION_SCHEMA_VERSION,
    predicate_concept_id: predicateConceptId,
    arguments: [
      { role: 'subject', referent_id: subjectReferentId },
      { role: 'object', referent_id: objectReferentId },
    ],
    polarity: 'affirmed',
    modality: 'descriptive',
    quantifier: 'one',
    scope: ['fixture'],
    conditions: [],
    source_status: 'current',
    decision_status: 'none',
    epistemic_authority: 'deterministic_derivation',
    valid_time: { start: '2026-08-07', end: null },
    recorded_time: '2026-08-07T00:00:00.000Z',
    support_set_ids: [`support-set:${assertionLabel}`],
    materialization_id: materializationId,
  };
  return { ...body, assertion_id: groundedAssertionId(body) };
}

function rows(records) {
  return records.map(record => {
    const semanticId = record.serving_assertion_id || record.assertion_id || record.referent_id
      || record.receipt_id || record.id;
    return { semantic_id: semanticId, digest: sha256(canonical(record)), record };
  });
}

function commitFor(records, parent = null) {
  const selectedRows = rows(records);
  return {
    commit: buildGraphCommit({
      parent_graph_commit_id: parent,
      source_head: 'source-head:c3-identity-fixture',
      identity_head: 'identity-head:c3-identity-fixture',
      ontology_head: 'ontology-revision:c3-identity-fixture',
      added_object_digests: selectedRows.map(row => row.digest),
      segment_references: [],
      claim_projection_receipts: [],
      dependency_index_digest: sha256('dependency-index:c3-identity-fixture'),
    }),
    rows: selectedRows,
  };
}

/** Producer-authentic Referents, GroundedAssertions, ServingAssertions, and GraphCommits. */
export function buildC3IdentityFixture() {
  const mentionPairs = ['left-a', 'left-b', 'right-a', 'right-b'].map((label, index) => buildMention({
    evidence_pointer: {
      source_version_id: 'source-version:c3-identity-fixture',
      pointer: {
        kind: 'document_span',
        file: 'fixtures/c3-identity.md',
        start: index + 1,
        end: index + 1,
        byte_start: index * 8,
        byte_end: index * 8 + Buffer.byteLength(label),
        exact_text: label,
        digest: sha256(label),
      },
    },
    surface: label,
    role: label.startsWith('left') ? 'subject' : 'object',
    provenance_class: 'fixture',
  }));
  const mentionIds = mentionPairs.map(pair => pair.mention.mention_id);
  const identityAliases = [
    identityAliasRecords(mentionPairs[0], mentionPairs[1], 'left'),
    identityAliasRecords(mentionPairs[2], mentionPairs[3], 'right'),
  ];
  const identityVerificationRegistry = buildIdentityVerificationRegistry({
    mentions: mentionPairs.map(row => row.mention),
    evidence_pointers: mentionPairs.map(row => row.evidence),
    assertions: identityAliases.map(row => row.assertion),
    receipts: identityAliases.map(row => row.receipt),
  });
  const identityConstraints = [
    aliasConstraint(mentionPairs[0], mentionPairs[1], identityAliases[0],
      identityVerificationRegistry),
    aliasConstraint(mentionPairs[2], mentionPairs[3], identityAliases[1],
      identityVerificationRegistry),
  ];
  const identityResolution = resolveIdentityComponents({
    mention_ids: mentionIds,
    identity_constraints: identityConstraints,
    materialization_id: materializationId,
    identity_verification_registry: identityVerificationRegistry,
  });
  const referents = identityResolution.referents;
  const left = identityResolution.mention_resolutions.find(row => row.mention_id === mentionIds[0]).referent_id;
  const right = identityResolution.mention_resolutions.find(row => row.mention_id === mentionIds[2]).referent_id;
  const basisReceipt = identityResolution.resolution_receipts[0];
  const first = relationAssertion({
    assertionLabel: 'first',
    predicateConceptId: 'concept:depends-on',
    subjectReferentId: left,
    objectReferentId: right,
    basisReceiptId: basisReceipt.receipt_id,
  });
  const second = relationAssertion({
    assertionLabel: 'second',
    predicateConceptId: 'concept:maintains',
    subjectReferentId: right,
    objectReferentId: left,
    basisReceiptId: basisReceipt.receipt_id,
  });
  const groundingRegistry = { evidence_pointers: [], receipts: [basisReceipt] };
  const servingPlane = buildServingAssertionPlane({
    admitted_claims: [],
    claim_projection: emptyProjection(),
    grounded_assertions: [first, second],
    grounding_registry: groundingRegistry,
    identity_resolution: identityResolution,
    identity_constraints: identityConstraints,
    identity_verification_registry: identityVerificationRegistry,
    identity_receipt_history: {
      resolution_receipts: identityResolution.resolution_receipts,
      referent_identity_keys: [],
    },
    identity_head: identityHeadForResolution(identityResolution),
    materialization_id: materializationId,
  });
  const servingByAssertion = new Map(servingPlane.serving_assertions
    .map(record => [record.assertion_id, record]));
  const commonRecords = [
    ...mentionPairs.flatMap(pair => [pair.evidence, pair.mention]),
    ...referents,
    ...identityResolution.resolution_receipts,
  ];
  const baseRecords = [
    ...commonRecords,
    first,
    servingByAssertion.get(first.assertion_id),
  ];
  const finalRecords = [
    ...commonRecords,
    first,
    second,
    servingByAssertion.get(first.assertion_id),
    servingByAssertion.get(second.assertion_id),
  ];
  const base = commitFor(baseRecords);
  const final = commitFor(finalRecords, base.commit.graph_commit_id);
  const policy = buildRelationProjectionPolicy({
    eligible_predicate_concept_ids: ['concept:depends-on', 'concept:maintains'],
    accepted_source_statuses: ['current'],
    accepted_decision_statuses: ['none'],
    accepted_polarities: ['affirmed'],
    accepted_modalities: ['descriptive'],
    argument_cardinality: {
      subject_roles: ['subject'], object_roles: ['object'], exact_total: 2,
    },
    deduplication_key: ['object_referent_id', 'predicate_id', 'subject_referent_id'],
  });
  return Object.freeze({
    policy,
    referent_ids: [left, right].sort(),
    first_assertion_id: first.assertion_id,
    second_assertion_id: second.assertion_id,
    base: { commit: base.commit, records: base.rows },
    final: { commit: final.commit, records: final.rows },
  });
}

function claim(id) {
  return { schema: 'estate-map/documentary-claim/v3.3', id, semantic: { fixture: id } };
}

function projectionReceipt(basisClaimId, assertionIds, bindingReceiptIds = []) {
  const body = {
    schema: CLAIM_PROJECTION_RECEIPT_SCHEMA,
    basis_claim_id: basisClaimId,
    disposition: 'fully_projected',
    assertion_ids: assertionIds,
    argument_binding_receipt_ids: bindingReceiptIds,
    findings: [],
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    materialization_id: `${materializationId}:supersession`,
  };
  return { ...body, receipt_id: hashId('claim-projection-receipt', body) };
}

function claimAssertion(basisClaimId, literal) {
  const arguments_ = [{ role: 'subject', literal }, { role: 'object', literal: `${literal}:object` }];
  const assertionId = claimAssertionId({ basis_claim_id: basisClaimId, argument_mentions: arguments_ });
  return {
    schema: CLAIM_ASSERTION_SCHEMA,
    assertion_id: assertionId,
    basis_claim_id: basisClaimId,
    proposition_key: `proposition:${basisClaimId}`,
    core_proposition_key: `core:${basisClaimId}`,
    evidence_key: `evidence:${basisClaimId}`,
    repair_findings: [],
    lineage_status: 'valid',
    lineage_finding_ids: [],
    predicate_lexeme: 'fixture_relation',
    polarity: 'affirmed',
    modality: 'descriptive',
    quantifier: 'one',
    scope: {},
    conditions: [],
    valid_time: {},
    recorded_time: '2026-08-07T00:00:00.000Z',
    source_status: 'current',
    decision_status: 'none',
    argument_mentions: arguments_,
    support_set_ids: [],
    source_staleness_receipt_ids: [],
    migration_provenance_receipt_id: null,
    projection_receipt_id: null,
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
  };
}

function bindingReceipt(obligationId) {
  const body = {
    schema: ARGUMENT_BINDING_COVERAGE_SCHEMA,
    obligation_id: obligationId,
    disposition: 'bound_to_exact_mention',
    selected_mention_ids: [`mention:${obligationId}`],
    rejected_candidate_mention_ids: [],
    findings: [],
    materialization_id: `${materializationId}:supersession`,
  };
  return { ...body, receipt_id: hashId('argument-binding-receipt', body) };
}

/** A valid two-receipt C1 chain used to prove C3 asks C1 for the selected tip. */
export function buildC3SupersessionFixture() {
  const assertions = [
    claimAssertion('claim:c3-old', 'old'),
    claimAssertion('claim:c3-middle', 'middle'),
    claimAssertion('claim:c3-new', 'new'),
  ];
  const [oldAssertion, middleAssertion, newAssertion] = assertions;
  const rebinding = bindingReceipt('obligation:c3-old-middle');
  const claims = assertions.map(row => claim(row.basis_claim_id));
  const preliminaryReceipts = assertions.map(row => projectionReceipt(row.basis_claim_id, [row.assertion_id],
    row === middleAssertion ? [rebinding.receipt_id] : []));
  const receiptByAssertion = new Map(preliminaryReceipts
    .flatMap(receipt => receipt.assertion_ids.map(id => [id, receipt])));
  const projectedAssertions = assertions.map(row => ({
    ...row, projection_receipt_id: receiptByAssertion.get(row.assertion_id).receipt_id,
  })).sort((left, right) => left.assertion_id.localeCompare(right.assertion_id));
  const receipts = preliminaryReceipts.sort((left, right) => left.basis_claim_id.localeCompare(right.basis_claim_id));
  const projection = {
    ...emptyProjection(claims.sort((left, right) => left.id.localeCompare(right.id)), projectedAssertions, receipts),
    argument_binding_coverage_receipts: [rebinding],
  };
  const first = buildAssertionSupersessionReceipt({
    old_assertion_id: oldAssertion.assertion_id,
    new_assertion_id: middleAssertion.assertion_id,
    cause: 'rebinding',
    basis_receipt_ids: [rebinding.receipt_id],
    materialization_id: `${materializationId}:supersession-1`,
  });
  const newReceipt = receipts.find(receipt => receipt.assertion_ids.includes(newAssertion.assertion_id));
  const second = buildAssertionSupersessionReceipt({
    old_assertion_id: middleAssertion.assertion_id,
    new_assertion_id: newAssertion.assertion_id,
    cause: 'schema_version',
    basis_receipt_ids: [newReceipt.receipt_id],
    materialization_id: `${materializationId}:supersession-2`,
  });
  const ledger = buildAssertionSupersessionLedger({
    admitted_claims: projection.documentary_claims,
    claim_projection: projection,
    grounding_registry: { evidence_pointers: [], receipts: [] },
    basis_receipts: [rebinding, newReceipt],
    supersession_receipts: [first, second],
    materialization_id: `${materializationId}:supersession-ledger`,
  });
  const servingPlane = buildServingAssertionPlane({
    admitted_claims: projection.documentary_claims,
    claim_projection: projection,
    grounding_registry: { evidence_pointers: [], receipts: [] },
    materialization_id: `${materializationId}:supersession-serving`,
  });
  const selectedServing = servingPlane.serving_assertions.find(row => row.assertion_id === newAssertion.assertion_id);
  const selectedClaim = projection.documentary_claims.find(row => row.id === newAssertion.basis_claim_id);
  const selectedRecords = [selectedClaim, newReceipt, newAssertion, selectedServing];
  const selected = commitFor(selectedRecords);
  return Object.freeze({
    ledger,
    requested_assertion_id: oldAssertion.assertion_id,
    selected_tip_assertion_id: newAssertion.assertion_id,
    selected: { commit: selected.commit, records: selected.rows },
  });
}
