// Deterministic C1 serving assertions and append-only assertion supersession.
//
// The raw assertion plane is copied byte-for-byte into each serving record. Mention arguments may
// resolve only through the selected Phase B component and its exact receipt; absent, unresolved,
// or blocked selections remain mention-local. This module does not project relations or choose an
// identity, ontology, query, or display policy.
import { sha256, stableStringify } from './lib.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_DISPOSITIONS,
  CLAIM_PROJECTION_RECEIPT_SCHEMA, CLAIM_PROJECTION_SCHEMA_VERSION,
  verifyClaimProjection,
} from './claim-projection.mjs';
import {
  buildReferent, buildResolutionReceipt, IDENTITY_CONFLICT_SCHEMA,
  IDENTITY_RESOLUTION_SCHEMA, REFERENT_SCHEMA, RESOLUTION_RECEIPT_SCHEMA,
  verifyIdentityConstraint,
} from './referent-identity.mjs';
import {
  ARGUMENT_BINDING_COVERAGE_SCHEMA, buildEvidencePointer, EVIDENCE_POINTER_SCHEMA,
} from './argument-mentions.mjs';

export const GROUNDED_ASSERTION_SCHEMA = 'estate-map/grounded-assertion/v1';
export const GROUNDED_ASSERTION_SCHEMA_VERSION = 'grounded-assertion@1';
export const SERVING_ASSERTION_SCHEMA = 'estate-map/serving-assertion/v1';
export const SERVING_ASSERTION_PLANE_SCHEMA = 'estate-map/serving-assertion-plane/v1';
export const ASSERTION_SUPERSESSION_RECEIPT_SCHEMA = 'estate-map/assertion-supersession-receipt/v1';
export const ASSERTION_SUPERSESSION_LEDGER_SCHEMA = 'estate-map/assertion-supersession-ledger/v1';
export const FROZEN_REFERENCE_POLICY_RESULT_SCHEMA = 'estate-map/frozen-reference-policy-result/v1';
export const DEPENDENT_REFERENCE_RECONCILIATION_SCHEMA = 'estate-map/dependent-reference-reconciliation/v1';

export const ASSERTION_SUPERSESSION_CAUSES = Object.freeze([
  'rebinding', 'schema_version', 'claim_supersession',
]);
export const DEPENDENT_REFERENCE_KINDS = Object.freeze([
  'active_serving', 'relation', 'scenario',
]);

const groundedAssertionOrigins = new Set([
  'repository_metadata', 'structured_record', 'source_native_object', 'identity_receipt',
  'ontology_revision', 'scenario',
]);
const sourceStatuses = new Set([
  'current', 'historical', 'aspirational', 'deprecated', 'disputed',
]);
const decisionStatuses = new Set([
  'none', 'draft', 'proposed', 'accepted', 'rejected', 'implemented', 'superseded',
]);
const epistemicAuthorities = new Set([
  'source_explicit', 'deterministic_derivation', 'reviewed_resolution', 'induced_hypothesis',
]);
const referentIdentityKinds = new Set(['source_native', 'deterministic_namespace', 'resolved_opaque']);
const referentLifecycleStates = new Set(['active', 'merged', 'split', 'tombstoned']);
const supersessionCauses = new Set(ASSERTION_SUPERSESSION_CAUSES);
const referenceKinds = new Set(DEPENDENT_REFERENCE_KINDS);
const claimProjectionDispositions = new Set(CLAIM_PROJECTION_DISPOSITIONS);
const argumentBindingDispositions = new Set([
  'bound_to_exact_mention', 'ambiguous_mentions', 'literal_argument', 'terminal_incomplete',
]);
const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const clean = value => String(value ?? '').trim();
const exactArray = values => [...new Set(values || [])].sort();
const exactEqual = (left, right) => canonical(left) === canonical(right);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const held of Object.values(value)) deepFreeze(held);
  return Object.freeze(value);
}

export class ServingAssertionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ServingAssertionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new ServingAssertionError(code, message, detail);
}

function requireId(value, label) {
  if (!clean(value)) fail('MISSING_C1_ID', `${label} is required`);
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_C1_RECORD', `${label} must be an object`);
  }
  return value;
}

function requireClosedFields(value, required, allowed, label) {
  requireRecord(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail('INVALID_C1_RECORD_SHAPE', `${label} differs from its closed contract`, { unknown, missing });
  }
}

function validateExactIdArray(values, label, { nonempty = false } = {}) {
  if (!Array.isArray(values) || values.some(value => !clean(value))) {
    fail('INVALID_C1_ID_SET', `${label} must be an array of non-empty ids`);
  }
  const exact = exactArray(values);
  if ((nonempty && !exact.length) || !exactEqual(values, exact)) {
    fail('INVALID_C1_ID_SET', `${label} must be a sorted unique id set`);
  }
  return exact;
}

function validateArray(value, label) {
  if (!Array.isArray(value)) fail('INVALID_C1_ARRAY', `${label} must be an array`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function receiptIdentity(receipt) {
  return receipt?.receipt_id;
}

function normalizedGroundedBindings(bindings) {
  return validateArray(bindings, 'GroundedAssertion.arguments').map((binding, index) => {
    requireRecord(binding, `GroundedAssertion.arguments[${index}]`);
    const kinds = ['mention_id', 'referent_id', 'assertion_id', 'literal']
      .filter(key => Object.hasOwn(binding, key));
    const unknown = Object.keys(binding).filter(key => key !== 'role' && !kinds.includes(key));
    if (!clean(binding.role) || kinds.length !== 1 || unknown.length
      || (kinds[0] !== 'literal' && !clean(binding[kinds[0]]))) {
      fail('INVALID_GROUNDED_ASSERTION_ARGUMENT',
        `GroundedAssertion argument ${index} is not a closed binding`, { unknown });
    }
    return clone(binding);
  }).sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

/** The complete non-documentary GroundedAssertion identity from architecture section 3.7. */
export function groundedAssertionId({
  assertion_origin, basis_evidence_ids = [], basis_receipt_ids = [], arguments: bindings,
  assertion_schema_version,
}) {
  if (!groundedAssertionOrigins.has(assertion_origin)) {
    fail('INVALID_GROUNDED_ASSERTION_ORIGIN',
      `unsupported grounded assertion origin ${assertion_origin || '<missing>'}`);
  }
  if (assertion_schema_version !== GROUNDED_ASSERTION_SCHEMA_VERSION) {
    fail('INVALID_GROUNDED_ASSERTION_VERSION',
      `unsupported grounded assertion version ${assertion_schema_version || '<missing>'}`);
  }
  const evidenceIds = validateExactIdArray(basis_evidence_ids, 'basis_evidence_ids');
  const receiptIds = validateExactIdArray(basis_receipt_ids, 'basis_receipt_ids');
  const basisIds = exactArray([...evidenceIds, ...receiptIds]);
  if (!basisIds.length) fail('UNGROUNDED_ASSERTION', 'GroundedAssertion requires evidence or receipt basis');
  return hashId('grounded-assertion', {
    assertion_origin,
    basis_ids: basisIds,
    arguments: normalizedGroundedBindings(bindings),
    assertion_schema_version,
  });
}

function validateClaimProjectionReceipt(receipt) {
  const fields = [
    'schema', 'basis_claim_id', 'disposition', 'assertion_ids',
    'argument_binding_receipt_ids', 'findings', 'projection_schema_version',
    'materialization_id', 'receipt_id',
  ];
  requireClosedFields(receipt, fields, fields, 'ClaimProjectionReceipt');
  if (receipt.schema !== CLAIM_PROJECTION_RECEIPT_SCHEMA
    || receipt.projection_schema_version !== CLAIM_PROJECTION_SCHEMA_VERSION
    || !clean(receipt.basis_claim_id) || !clean(receipt.materialization_id)
    || !claimProjectionDispositions.has(receipt.disposition)
    || !Array.isArray(receipt.assertion_ids)
    || !Array.isArray(receipt.argument_binding_receipt_ids)
    || !Array.isArray(receipt.findings)) {
    fail('INVALID_CLAIM_PROJECTION_RECEIPT',
      `invalid ClaimProjectionReceipt ${receipt.receipt_id || '<missing>'}`);
  }
  const favorable = ['fully_projected', 'projected_with_literal_argument', 'non_referential_assertion']
    .includes(receipt.disposition);
  if ((favorable && receipt.assertion_ids.length !== 1)
    || (['unresolved_argument_mentions', 'terminal_incomplete'].includes(receipt.disposition)
      && receipt.assertion_ids.length !== 0)
    || (receipt.disposition === 'rejected_projection'
      && (receipt.assertion_ids.length !== 0 || receipt.findings.length === 0))) {
    fail('INVALID_CLAIM_PROJECTION_RECEIPT',
      `ClaimProjectionReceipt ${receipt.receipt_id || '<missing>'} violates disposition cardinality`);
  }
  const { receipt_id: receiptId, ...body } = receipt;
  if (receiptId !== hashId('claim-projection-receipt', body)) {
    fail('INVALID_CLAIM_PROJECTION_RECEIPT',
      `ClaimProjectionReceipt ${receiptId || '<missing>'} is not deterministic`);
  }
}

function validateEvidencePointer(pointer) {
  const fields = ['schema', 'source_version_id', 'access_policy_id', 'pointer', 'evidence_id'];
  requireClosedFields(pointer, fields, fields, 'EvidencePointer');
  if (pointer.schema !== EVIDENCE_POINTER_SCHEMA) {
    fail('INVALID_GROUNDING_EVIDENCE', `unsupported EvidencePointer schema ${pointer.schema || '<missing>'}`);
  }
  let expected;
  try {
    expected = buildEvidencePointer({
      source_version_id: pointer.source_version_id,
      access_policy_id: pointer.access_policy_id,
      pointer: pointer.pointer,
    });
  } catch (error) {
    fail('INVALID_GROUNDING_EVIDENCE', `EvidencePointer ${pointer.evidence_id || '<missing>'} differs from its producer`, {
      producer_code: error?.code || null,
    });
  }
  if (!exactEqual(pointer, expected)) {
    fail('INVALID_GROUNDING_EVIDENCE', `EvidencePointer ${pointer.evidence_id || '<missing>'} differs from its producer`);
  }
}

function validateArgumentBindingCoverageReceipt(receipt) {
  const fields = [
    'schema', 'obligation_id', 'disposition', 'selected_mention_ids',
    'rejected_candidate_mention_ids', 'findings', 'materialization_id', 'receipt_id',
  ];
  requireClosedFields(receipt, fields, fields, 'ArgumentBindingCoverageReceipt');
  if (receipt.schema !== ARGUMENT_BINDING_COVERAGE_SCHEMA
    || !clean(receipt.obligation_id) || !clean(receipt.materialization_id)
    || !argumentBindingDispositions.has(receipt.disposition)
    || !Array.isArray(receipt.selected_mention_ids)
    || !Array.isArray(receipt.rejected_candidate_mention_ids)
    || !Array.isArray(receipt.findings)) {
    fail('INVALID_ARGUMENT_BINDING_RECEIPT',
      `ArgumentBindingCoverageReceipt ${receipt.receipt_id || '<missing>'} differs from its producer`);
  }
  validateExactIdArray(receipt.selected_mention_ids, 'selected_mention_ids');
  validateExactIdArray(receipt.rejected_candidate_mention_ids, 'rejected_candidate_mention_ids');
  const expectedSelectionCount = receipt.disposition === 'bound_to_exact_mention' ? 1 : 0;
  if (receipt.selected_mention_ids.length !== expectedSelectionCount
    || receipt.rejected_candidate_mention_ids.length !== 0) {
    fail('INVALID_ARGUMENT_BINDING_RECEIPT',
      `ArgumentBindingCoverageReceipt ${receipt.receipt_id || '<missing>'} violates producer cardinality`);
  }
  const { receipt_id: receiptId, ...body } = receipt;
  if (receiptId !== hashId('argument-binding-receipt', body)) {
    fail('INVALID_ARGUMENT_BINDING_RECEIPT',
      `ArgumentBindingCoverageReceipt ${receiptId || '<missing>'} is not deterministic`);
  }
}

function validateSupportedReceipt(receipt, label = 'grounding receipt') {
  requireRecord(receipt, label);
  if (receipt.schema === CLAIM_PROJECTION_RECEIPT_SCHEMA) validateClaimProjectionReceipt(receipt);
  else if (receipt.schema === ARGUMENT_BINDING_COVERAGE_SCHEMA) validateArgumentBindingCoverageReceipt(receipt);
  else if (receipt.schema === RESOLUTION_RECEIPT_SCHEMA) validateResolutionReceipt(receipt);
  else fail('INVALID_GROUNDING_RECEIPT', `unsupported grounding receipt schema ${receipt.schema || '<missing>'}`);
}

function validateGroundingRegistry(registry, groundedAssertions) {
  const fields = ['evidence_pointers', 'receipts'];
  requireClosedFields(registry, fields, fields, 'GroundingRegistry');
  validateArray(registry.evidence_pointers, 'grounding_registry.evidence_pointers');
  validateArray(registry.receipts, 'grounding_registry.receipts');
  const evidenceById = new Map();
  for (const pointer of registry.evidence_pointers) {
    validateEvidencePointer(pointer);
    if (evidenceById.has(pointer.evidence_id)) {
      fail('DUPLICATE_GROUNDING_RECORD', `duplicate grounding record ${pointer.evidence_id}`);
    }
    evidenceById.set(pointer.evidence_id, pointer);
  }
  const receiptById = new Map();
  for (const receipt of registry.receipts) {
    validateSupportedReceipt(receipt);
    if (receiptById.has(receipt.receipt_id)) {
      fail('DUPLICATE_GROUNDING_RECORD', `duplicate grounding record ${receipt.receipt_id}`);
    }
    receiptById.set(receipt.receipt_id, receipt);
  }
  const usedEvidence = exactArray(groundedAssertions.flatMap(row => row.basis_evidence_ids || []));
  const usedReceipts = exactArray(groundedAssertions.flatMap(row => row.basis_receipt_ids || []));
  for (const id of usedEvidence) if (!evidenceById.has(id)) {
    fail('UNRESOLVED_GROUNDING_BASIS', `GroundedAssertion basis evidence ${id} does not resolve exactly once`);
  }
  for (const id of usedReceipts) if (!receiptById.has(id)) {
    fail('UNRESOLVED_GROUNDING_BASIS', `GroundedAssertion basis receipt ${id} does not resolve exactly once`);
  }
  if (!exactEqual([...evidenceById.keys()].sort(), usedEvidence)
    || !exactEqual([...receiptById.keys()].sort(), usedReceipts)) {
    fail('GROUNDING_REGISTRY_CONSERVATION_MISMATCH',
      'grounding registry must contain exactly the EvidencePointer and receipt rows used by GroundedAssertions');
  }
  return { evidenceById, receiptById };
}

const claimAssertionFields = Object.freeze([
  'schema', 'assertion_id', 'basis_claim_id', 'proposition_key', 'core_proposition_key',
  'evidence_key', 'repair_findings', 'lineage_status', 'lineage_finding_ids',
  'predicate_lexeme', 'polarity', 'modality', 'quantifier', 'scope', 'conditions',
  'valid_time', 'recorded_time', 'source_status', 'decision_status', 'argument_mentions',
  'support_set_ids', 'source_staleness_receipt_ids', 'migration_provenance_receipt_id',
  'projection_receipt_id', 'projection_schema_version',
]);

function validateClaimAssertion(assertion, projectionReceiptById) {
  requireClosedFields(assertion, claimAssertionFields, claimAssertionFields, 'ClaimAssertion');
  if (assertion.schema !== CLAIM_ASSERTION_SCHEMA
    || assertion.projection_schema_version !== CLAIM_PROJECTION_SCHEMA_VERSION
    || !clean(assertion.basis_claim_id)
    || assertion.assertion_id !== claimAssertionId(assertion)) {
    fail('INVALID_CLAIM_ASSERTION_INTAKE',
      `ClaimAssertion ${assertion.assertion_id || '<missing>'} has invalid deterministic identity`);
  }
  const receipt = projectionReceiptById.get(assertion.projection_receipt_id);
  if (!receipt || receipt.basis_claim_id !== assertion.basis_claim_id
    || !receipt.assertion_ids.includes(assertion.assertion_id)) {
    fail('UNGROUNDED_CLAIM_ASSERTION',
      `ClaimAssertion ${assertion.assertion_id} lacks its exact projection receipt`);
  }
}

const groundedAssertionRequiredFields = Object.freeze([
  'schema', 'assertion_id', 'assertion_origin', 'basis_evidence_ids', 'basis_receipt_ids',
  'assertion_schema_version', 'arguments', 'polarity', 'modality', 'quantifier', 'scope',
  'conditions', 'source_status', 'decision_status', 'epistemic_authority', 'valid_time',
  'recorded_time', 'support_set_ids', 'materialization_id',
]);
const groundedAssertionAllowedFields = Object.freeze([
  ...groundedAssertionRequiredFields, 'predicate_lexeme_id', 'predicate_concept_id', 'scenario_id',
]);

function validateGroundedAssertion(assertion) {
  requireClosedFields(assertion, groundedAssertionRequiredFields,
    groundedAssertionAllowedFields, 'GroundedAssertion');
  const predicates = ['predicate_lexeme_id', 'predicate_concept_id']
    .filter(key => Object.hasOwn(assertion, key) && clean(assertion[key]));
  if (assertion.schema !== GROUNDED_ASSERTION_SCHEMA || predicates.length !== 1
    || !sourceStatuses.has(assertion.source_status)
    || !decisionStatuses.has(assertion.decision_status)
    || !epistemicAuthorities.has(assertion.epistemic_authority)
    || !clean(assertion.materialization_id) || !clean(assertion.recorded_time)
    || !Array.isArray(assertion.scope) || !Array.isArray(assertion.conditions)
    || !Array.isArray(assertion.support_set_ids)) {
    fail('INVALID_GROUNDED_ASSERTION',
      `GroundedAssertion ${assertion.assertion_id || '<missing>'} differs from its closed schema`);
  }
  if ((assertion.assertion_origin === 'scenario') !== Boolean(clean(assertion.scenario_id))) {
    fail('INVALID_GROUNDED_ASSERTION', 'scenario_id exists exactly for scenario-origin assertions');
  }
  for (const binding of normalizedGroundedBindings(assertion.arguments)) {
    if (binding.assertion_id === assertion.assertion_id) {
      fail('SELF_ASSERTION_ARGUMENT', `assertion ${assertion.assertion_id} cannot cite itself`);
    }
  }
  const expected = groundedAssertionId(assertion);
  if (assertion.assertion_id !== expected) {
    fail('INVALID_GROUNDED_ASSERTION_ID',
      `GroundedAssertion ${assertion.assertion_id || '<missing>'} is not deterministic`);
  }
}

function validateAssertionIntake({ admitted_claims, claim_projection, grounded_assertions, grounding_registry }) {
  if (!Array.isArray(admitted_claims) || !Array.isArray(claim_projection?.assertions)
    || !Array.isArray(claim_projection?.claim_projection_receipts)
    || !Array.isArray(claim_projection?.argument_binding_coverage_receipts)
    || !Array.isArray(grounded_assertions)) {
    fail('INVALID_CLAIM_PROJECTION',
      'assertion intake requires admitted DocumentaryClaims, the Phase A projection, and GroundedAssertions');
  }
  const admittedIds = admitted_claims.map(row => requireId(row?.id, 'DocumentaryClaim.id'));
  if (new Set(admittedIds).size !== admittedIds.length) {
    fail('DUPLICATE_ADMITTED_CLAIM', 'admitted DocumentaryClaim IDs must be unique');
  }
  verifyClaimProjection({ admitted_claims, projection: claim_projection });
  const projectionReceiptById = new Map();
  for (const receipt of claim_projection.claim_projection_receipts) {
    validateClaimProjectionReceipt(receipt);
    if (projectionReceiptById.has(receipt.receipt_id)) {
      fail('DUPLICATE_CLAIM_PROJECTION_RECEIPT', `duplicate ${receipt.receipt_id}`);
    }
    projectionReceiptById.set(receipt.receipt_id, receipt);
  }
  const argumentBindingReceiptById = new Map();
  for (const receipt of claim_projection.argument_binding_coverage_receipts) {
    validateArgumentBindingCoverageReceipt(receipt);
    if (argumentBindingReceiptById.has(receipt.receipt_id)) {
      fail('DUPLICATE_ARGUMENT_BINDING_RECEIPT', `duplicate ${receipt.receipt_id}`);
    }
    argumentBindingReceiptById.set(receipt.receipt_id, receipt);
  }
  for (const assertion of claim_projection.assertions) {
    validateClaimAssertion(assertion, projectionReceiptById);
  }
  for (const assertion of grounded_assertions) validateGroundedAssertion(assertion);
  validateGroundingRegistry(grounding_registry, grounded_assertions);
  const rawAssertions = [...claim_projection.assertions, ...grounded_assertions];
  const assertionById = new Map();
  for (const assertion of rawAssertions) {
    requireId(assertion?.assertion_id, 'assertion_id');
    if (assertionById.has(assertion.assertion_id)) {
      fail('DUPLICATE_RAW_ASSERTION', `duplicate assertion ${assertion.assertion_id}`);
    }
    assertionById.set(assertion.assertion_id, assertion);
  }
  return {
    rawAssertions,
    assertionById,
    admittedClaimIds: new Set(admittedIds),
    projectionReceiptById,
    argumentBindingReceiptById,
  };
}

function validateResolutionReceipt(receipt) {
  if (receipt?.schema !== RESOLUTION_RECEIPT_SCHEMA) {
    fail('FORGED_RESOLUTION_RECEIPT', `resolution receipt ${receipt?.receipt_id || '<missing>'} has an invalid schema`);
  }
  const expected = buildResolutionReceipt({
    candidate_mention_ids: receipt.candidate_mention_ids,
    selected_referent_id: receipt.selected_referent_id,
    disposition: receipt.disposition,
    admitted_mention_ids: receipt.admitted_mention_ids,
    excluded_mention_ids: receipt.excluded_mention_ids,
    identity_constraint_ids: receipt.identity_constraint_ids,
    conflict_ids: receipt.conflict_ids,
    supersedes_receipt_id: receipt.supersedes_receipt_id,
    identity_key: receipt.identity_key ?? null,
    materialization_id: receipt.materialization_id,
  });
  if (!exactEqual(receipt, expected)) {
    fail('FORGED_RESOLUTION_RECEIPT', `resolution receipt ${receipt.receipt_id || '<missing>'} differs from its deterministic producer`);
  }
}

export function identityHeadForResolution(identityResolution) {
  requireId(identityResolution?.digest, 'identity resolution digest');
  return `identity-head:${identityResolution.digest}`;
}

function validateIdentityReceiptHistory(history, currentReceipts = []) {
  const fields = ['resolution_receipts', 'referent_identity_keys'];
  requireClosedFields(history, fields, fields, 'IdentityReceiptHistory');
  validateArray(history.resolution_receipts, 'identity_receipt_history.resolution_receipts');
  validateArray(history.referent_identity_keys, 'identity_receipt_history.referent_identity_keys');
  const receiptById = new Map();
  for (const receipt of history.resolution_receipts) {
    validateResolutionReceipt(receipt);
    if (receiptById.has(receipt.receipt_id)) {
      fail('DUPLICATE_IDENTITY_HISTORY_RECORD', `duplicate identity history receipt ${receipt.receipt_id}`);
    }
    receiptById.set(receipt.receipt_id, receipt);
  }
  for (const receipt of currentReceipts) if (!receiptById.has(receipt.receipt_id)) {
    fail('INCOMPLETE_IDENTITY_RECEIPT_HISTORY',
      `identity receipt history omits current receipt ${receipt.receipt_id}`);
  }
  // C4 design 4.1 last bullet: the identity key is admissible only when it is bound to, and
  // derivable from, the selecting resolution receipt. The sidecar may echo that key; it can never
  // introduce, alter, or outlive one, so it holds no admission authority.
  const identityKeyByReferent = new Map();
  for (const receipt of receiptById.values()) {
    if (receipt.disposition !== 'resolved' || receipt.identity_key == null) continue;
    const held = identityKeyByReferent.get(receipt.selected_referent_id);
    if (held && !exactEqual(held, receipt.identity_key)) {
      fail('IDENTITY_KEY_RECEIPT_DISAGREEMENT',
        `referent ${receipt.selected_referent_id} has conflicting receipt-bound identity keys`);
    }
    identityKeyByReferent.set(receipt.selected_referent_id, receipt.identity_key);
  }
  const sidecarReferentIds = new Set();
  for (const row of history.referent_identity_keys) {
    const rowFields = ['referent_id', 'identity_key'];
    requireClosedFields(row, rowFields, rowFields, 'referent identity key');
    requireId(row.referent_id, 'referent identity key referent_id');
    requireRecord(row.identity_key, 'referent identity_key');
    if (sidecarReferentIds.has(row.referent_id)) {
      fail('DUPLICATE_IDENTITY_HISTORY_RECORD', `duplicate identity key for ${row.referent_id}`);
    }
    sidecarReferentIds.add(row.referent_id);
    const derived = identityKeyByReferent.get(row.referent_id);
    if (!derived || !exactEqual(derived, row.identity_key)) {
      fail('IDENTITY_KEY_SIDECAR_UNBOUND',
        `identity key for ${row.referent_id} is not derivable from its selecting resolution receipt`);
    }
  }
  return { receiptById, identityKeyByReferent };
}

function identityBatchEvaluation(batchReceipt, identityResolution) {
  if (batchReceipt == null) return { receipt: null, pendingMentionIds: new Set() };
  requireRecord(batchReceipt, 'IdentityCandidateBatchReceipt');
  const { receipt_id: receiptId, ...body } = batchReceipt;
  if (batchReceipt.schema !== 'estate-map/identity-candidate-batch-receipt/v1'
    || receiptId !== `identity-candidate-batch-receipt:${sha256(canonical(body))}`
    || !Array.isArray(batchReceipt.candidate_rows)) {
    fail('INVALID_IDENTITY_BATCH_RECEIPT', 'identity batch receipt differs from its exact producer body');
  }
  const mentionIds = new Set();
  const selectedMentionIds = new Set();
  const pendingMentionIds = new Set();
  for (const row of batchReceipt.candidate_rows) {
    requireId(row.mention_id, 'identity batch mention_id');
    if (mentionIds.has(row.mention_id) || Object.hasOwn(row, 'disposition')) {
      fail('INVALID_IDENTITY_BATCH_PARTITION', 'identity batch candidate rows duplicate mentions or carry semantic dispositions');
    }
    mentionIds.add(row.mention_id);
    if (row.evaluation_state === 'selected_for_evaluation') selectedMentionIds.add(row.mention_id);
    else if (row.evaluation_state === 'not_evaluated_in_this_batch') pendingMentionIds.add(row.mention_id);
    else fail('INVALID_IDENTITY_BATCH_PARTITION', `unsupported identity evaluation state ${row.evaluation_state}`);
  }
  if (mentionIds.size !== batchReceipt.total_candidates
    || selectedMentionIds.size !== batchReceipt.selected_candidate_count
    || pendingMentionIds.size !== batchReceipt.not_evaluated_in_this_batch_count
    || [...selectedMentionIds].some(id => !identityResolution?.mention_ids.includes(id))
    || [...pendingMentionIds].some(id => identityResolution?.mention_ids.includes(id))) {
    fail('INVALID_IDENTITY_BATCH_PARTITION', 'identity batch selected/pending partition disagrees with the selected resolution');
  }
  return { receipt: batchReceipt, pendingMentionIds };
}

function identitySelection(identityResolution, identityConstraints, identityReceiptHistory,
  batchReceipt = null, identityVerificationRegistry = null) {
  const batch = identityBatchEvaluation(batchReceipt, identityResolution);
  const empty = {
    resolution: null,
    componentByMention: new Map(),
    receiptById: new Map(),
    conflictById: new Map(),
    referentIds: new Set(),
    batchReceipt: batch.receipt,
    pendingMentionIds: batch.pendingMentionIds,
  };
  validateArray(identityConstraints, 'identity_constraints');
  if (identityResolution == null) {
    const history = validateIdentityReceiptHistory(identityReceiptHistory);
    if (history.receiptById.size || history.identityKeyByReferent.size || identityConstraints.length) {
      fail('ORPHAN_IDENTITY_RECEIPT_HISTORY',
        'identity constraints and history require a selected identity resolution');
    }
    return empty;
  }
  const constraintById = new Map();
  for (const constraint of identityConstraints) {
    // Serving is boundary 4 of the one closed identity-constraint intake. Verify records before
    // comparing their IDs with the resolution, so a hash-valid unsupported basis cannot hide
    // behind an otherwise self-consistent selected-resolution envelope.
    try {
      verifyIdentityConstraint(constraint);
      if (constraint.disposition === 'must_link') {
        if (!identityVerificationRegistry) {
          fail('IDENTITY_VERIFICATION_REGISTRY_REQUIRED',
            'serving must_link validation requires the exact basis-truth registry');
        }
        verifyIdentityConstraint(constraint, identityVerificationRegistry);
      }
    } catch (error) {
      fail(error?.code || 'INVALID_IDENTITY_CONSTRAINT',
        `serving identity constraint ${constraint?.constraint_id || '<missing>'} failed verification`, {
          producer_code: error?.code || null,
        });
    }
    if (constraintById.has(constraint.constraint_id)) {
      fail('DUPLICATE_IDENTITY_CONSTRAINT', `duplicate identity constraint ${constraint.constraint_id}`);
    }
    constraintById.set(constraint.constraint_id, constraint);
  }
  const resolutionFields = [
    'schema', 'materialization_id', 'mention_ids', 'identity_constraint_ids', 'components',
    'conflicts', 'referents', 'resolution_receipts', 'mention_resolutions', 'digest',
  ];
  requireClosedFields(identityResolution, resolutionFields, resolutionFields, 'IdentityResolution');
  if (identityResolution.schema !== IDENTITY_RESOLUTION_SCHEMA) {
    fail('INVALID_IDENTITY_RESOLUTION', 'serving projection requires a Phase B identity-resolution record');
  }
  requireId(identityResolution.materialization_id, 'identity resolution materialization_id');
  const mentionIds = validateExactIdArray(identityResolution.mention_ids, 'identity_resolution.mention_ids');
  const constraintIds = validateExactIdArray(identityResolution.identity_constraint_ids,
    'identity_resolution.identity_constraint_ids');
  if (!exactEqual([...constraintById.keys()].sort(), constraintIds)) {
    fail('IDENTITY_CONSTRAINT_REGISTRY_MISMATCH',
      'serving constraint records must resolve the selected resolution constraint IDs exactly once');
  }
  for (const field of ['components', 'conflicts', 'referents', 'resolution_receipts', 'mention_resolutions']) {
    validateArray(identityResolution[field], `identity_resolution.${field}`);
  }
  const { digest: resolutionDigest, ...resolutionBody } = identityResolution;
  if (resolutionDigest !== sha256(canonical(resolutionBody))) {
    fail('INVALID_IDENTITY_RESOLUTION_DIGEST', 'Phase B identity-resolution digest differs from its exact rows');
  }

  const receiptById = new Map();
  for (const receipt of identityResolution.resolution_receipts) {
    validateResolutionReceipt(receipt);
    if (receipt.materialization_id !== identityResolution.materialization_id) {
      fail('IDENTITY_RESOLUTION_MATERIALIZATION_MISMATCH',
        `resolution receipt ${receipt.receipt_id} crosses materializations`);
    }
    if (receiptById.has(receipt.receipt_id)) {
      fail('DUPLICATE_RESOLUTION_RECEIPT', `duplicate resolution receipt ${receipt.receipt_id}`);
    }
    receiptById.set(receipt.receipt_id, receipt);
  }
  if (!exactEqual([...receiptById.keys()], [...receiptById.keys()].sort())) {
    fail('IDENTITY_RESOLUTION_ORDER_MISMATCH', 'resolution receipts are not in producer order');
  }
  const history = validateIdentityReceiptHistory(identityReceiptHistory,
    identityResolution.resolution_receipts);

  const conflictById = new Map();
  const conflictFields = [
    'schema', 'candidate_mention_ids', 'blocking_constraint_id', 'blocking_kind',
    'materialization_id', 'conflict_id',
  ];
  for (const conflict of identityResolution.conflicts) {
    requireClosedFields(conflict, conflictFields, conflictFields, 'IdentityConflict');
    requireId(conflict.conflict_id, 'conflict_id');
    validateExactIdArray(conflict.candidate_mention_ids, 'conflict.candidate_mention_ids', { nonempty: true });
    const { conflict_id: conflictId, ...conflictBody } = conflict;
    if (conflict.schema !== IDENTITY_CONFLICT_SCHEMA
      || conflict.materialization_id !== identityResolution.materialization_id
      || conflictId !== hashId('identity-conflict', conflictBody)) {
      fail('FORGED_IDENTITY_CONFLICT', `identity conflict ${conflictId} is not deterministic`);
    }
    if (conflictById.has(conflictId)) fail('DUPLICATE_IDENTITY_CONFLICT', `duplicate ${conflictId}`);
    conflictById.set(conflictId, conflict);
  }
  if (!exactEqual([...conflictById.keys()], [...conflictById.keys()].sort())) {
    fail('IDENTITY_RESOLUTION_ORDER_MISMATCH', 'identity conflicts are not in producer order');
  }

  const referentIds = new Set();
  const referentFields = [
    'schema', 'referent_id', 'identity_kind', 'creation_receipt_id', 'lifecycle_state',
  ];
  for (const referent of identityResolution.referents) {
    requireClosedFields(referent, referentFields, referentFields, 'Referent');
    if (referent.schema !== REFERENT_SCHEMA || !clean(referent.referent_id)
      || !clean(referent.creation_receipt_id) || !referentIdentityKinds.has(referent.identity_kind)
      || !referentLifecycleStates.has(referent.lifecycle_state)) {
      fail('INVALID_REFERENT', `referent ${referent.referent_id || '<missing>'} differs from its closed contract`);
    }
    const creationReceipt = history.receiptById.get(referent.creation_receipt_id);
    if (!creationReceipt || creationReceipt.disposition !== 'resolved'
      || creationReceipt.selected_referent_id !== referent.referent_id) {
      fail('MISSING_REFERENT_CREATION_PROVENANCE',
        `referent ${referent.referent_id} lacks a producer-valid selecting creation receipt`);
    }
    const identityKey = history.identityKeyByReferent.get(referent.referent_id) || null;
    if (referent.identity_kind === 'resolved_opaque' && identityKey != null) {
      fail('INVALID_REFERENT_IDENTITY_HISTORY',
        `opaque referent ${referent.referent_id} cannot carry an external identity key`);
    }
    if (referent.identity_kind !== 'resolved_opaque' && identityKey == null) {
      fail('MISSING_REFERENT_IDENTITY_KEY',
        `referent ${referent.referent_id} requires its producer identity key`);
    }
    let expectedReferent;
    try {
      expectedReferent = buildReferent({
        identity_kind: referent.identity_kind,
        creation_receipt_id: referent.creation_receipt_id,
        lifecycle_state: referent.lifecycle_state,
        identity_key: identityKey,
      });
    } catch (error) {
      fail('INVALID_REFERENT', `referent ${referent.referent_id} differs from its producer`, {
        producer_code: error?.code || null,
      });
    }
    if (!exactEqual(referent, expectedReferent)) {
      fail('INVALID_REFERENT', `referent ${referent.referent_id} differs from its producer`);
    }
    if (referentIds.has(referent.referent_id)) fail('DUPLICATE_REFERENT', `duplicate ${referent.referent_id}`);
    referentIds.add(referent.referent_id);
  }
  if (!exactEqual([...referentIds], [...referentIds].sort())) {
    fail('IDENTITY_RESOLUTION_ORDER_MISMATCH', 'referents are not in producer order');
  }

  const componentByMention = new Map();
  const expectedMentionResolutions = [];
  const usedReceiptIds = new Set();
  const usedConflictIds = new Set();
  const usedConstraintIds = new Set();
  const componentFields = [
    'candidate_mention_ids', 'status', 'blocking_constraint_ids', 'conflict_ids',
    'resolution_receipt_id', 'selected_referent_id',
  ];
  let priorComponentKey = null;
  for (const component of identityResolution.components) {
    requireClosedFields(component, componentFields, componentFields, 'IdentityResolution component');
    const candidates = validateExactIdArray(component.candidate_mention_ids,
      'component.candidate_mention_ids', { nonempty: true });
    validateExactIdArray(component.blocking_constraint_ids, 'component.blocking_constraint_ids');
    validateExactIdArray(component.conflict_ids, 'component.conflict_ids');
    if (priorComponentKey != null && priorComponentKey.localeCompare(candidates[0]) >= 0) {
      fail('IDENTITY_RESOLUTION_ORDER_MISMATCH', 'components are not in producer order');
    }
    priorComponentKey = candidates[0];
    const receipt = receiptById.get(component.resolution_receipt_id);
    if (!receipt || !exactEqual(candidates, receipt.candidate_mention_ids)) {
      fail('COMPONENT_RECEIPT_MISMATCH', 'selected identity component lacks its exact resolution receipt', {
        resolution_receipt_id: component.resolution_receipt_id,
      });
    }
    usedReceiptIds.add(receipt.receipt_id);
    for (const constraintId of receipt.identity_constraint_ids) usedConstraintIds.add(constraintId);
    for (const mentionId of candidates) {
      if (componentByMention.has(mentionId)) {
        fail('AMBIGUOUS_SELECTED_COMPONENT', `mention ${mentionId} occurs in multiple selected components`);
      }
      componentByMention.set(mentionId, component);
    }
    const conflicts = component.conflict_ids.map(id => conflictById.get(id));
    if (conflicts.some(conflict => !conflict) || !exactEqual(component.conflict_ids, receipt.conflict_ids)
      || conflicts.some(conflict => !exactEqual(conflict.candidate_mention_ids, candidates))) {
      fail('COMPONENT_CONFLICT_MISMATCH',
        `component ${component.resolution_receipt_id} does not preserve exact conflict provenance`);
    }
    for (const conflict of conflicts) usedConflictIds.add(conflict.conflict_id);
    const expectedBlockingIds = exactArray(conflicts.map(conflict => conflict.blocking_constraint_id));
    if (!exactEqual(component.blocking_constraint_ids, expectedBlockingIds)) {
      fail('COMPONENT_CONSTRAINT_MISMATCH',
        `component ${component.resolution_receipt_id} does not preserve blocking constraints`);
    }
    if (component.status === 'resolved') {
      if (receipt.disposition !== 'resolved'
        || component.selected_referent_id !== receipt.selected_referent_id
        || !referentIds.has(component.selected_referent_id)
        || conflicts.length) {
        fail('INVALID_SELECTED_RESOLUTION',
          `component ${component.resolution_receipt_id} is not a grounded selected resolution`);
      }
      for (const mentionId of receipt.admitted_mention_ids) expectedMentionResolutions.push({
        mention_id: mentionId,
        referent_id: receipt.selected_referent_id,
        resolution_receipt_id: receipt.receipt_id,
      });
    } else if (['unresolved', 'blocked'].includes(component.status)) {
      if (receipt.disposition !== 'unresolved' || component.selected_referent_id != null
        || receipt.selected_referent_id != null || receipt.admitted_mention_ids.length
        || (component.status === 'blocked') !== Boolean(conflicts.length)) {
        fail('INVALID_UNRESOLVED_COMPONENT',
          `component ${component.resolution_receipt_id} cannot select a referent`);
      }
    } else {
      fail('INVALID_COMPONENT_STATUS', `unsupported selected component status ${component.status}`);
    }
  }
  if (!exactEqual([...componentByMention.keys()].sort(), mentionIds)) {
    fail('IDENTITY_COMPONENT_PARTITION_MISMATCH',
      'selected components do not exactly partition identity_resolution.mention_ids');
  }
  if (!exactEqual([...usedReceiptIds].sort(), [...receiptById.keys()].sort())
    || !exactEqual([...usedConflictIds].sort(), [...conflictById.keys()].sort())
    || !exactEqual([...usedConstraintIds].sort(), constraintIds)) {
    fail('IDENTITY_RESOLUTION_CONSERVATION_MISMATCH',
      'components do not conserve exact receipt, conflict, and constraint sets');
  }

  const actualMentionResolutions = identityResolution.mention_resolutions.map(row => {
    const fields = ['mention_id', 'referent_id', 'resolution_receipt_id'];
    requireClosedFields(row, fields, fields, 'mention resolution');
    return row;
  });
  expectedMentionResolutions.sort((left, right) => left.mention_id.localeCompare(right.mention_id));
  if (!exactEqual(actualMentionResolutions, expectedMentionResolutions)) {
    fail('FORGED_MENTION_RESOLUTION',
      'mention-resolution rows disagree with selected components and receipts');
  }
  return { resolution: identityResolution, componentByMention, receiptById, conflictById, referentIds,
    batchReceipt: batch.receipt, pendingMentionIds: batch.pendingMentionIds };
}

function rawArguments(assertion) {
  const field = assertion.schema === CLAIM_ASSERTION_SCHEMA ? 'argument_mentions' : 'arguments';
  const rows = assertion[field];
  if (!Array.isArray(rows)) fail('INVALID_RAW_ASSERTION_ARGUMENTS', `assertion ${assertion.assertion_id} lacks ${field}`);
  return rows;
}

function selectedArgument(binding, assertionId, assertionIds, selection) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !clean(binding.role)) {
    fail('INVALID_RAW_ASSERTION_ARGUMENT', 'assertion arguments require a role');
  }
  const kinds = ['mention_id', 'referent_id', 'assertion_id', 'literal'].filter(key => Object.hasOwn(binding, key));
  if (kinds.length !== 1 || Object.keys(binding).some(key => key !== 'role' && !kinds.includes(key))) {
    fail('INVALID_RAW_ASSERTION_ARGUMENT', 'assertion argument must contain exactly one closed argument value');
  }
  const kind = kinds[0];
  if (kind === 'literal') return deepFreeze({ role: binding.role, argument_kind: 'literal', literal: clone(binding.literal) });
  requireId(binding[kind], kind);
  if (kind === 'assertion_id') {
    if (binding.assertion_id === assertionId) {
      fail('SELF_ASSERTION_ARGUMENT', `assertion ${assertionId} cannot cite itself`);
    }
    if (!assertionIds.has(binding.assertion_id)) {
      fail('MISSING_ASSERTION_ARGUMENT', `statement argument cites missing ${binding.assertion_id}`);
    }
    return deepFreeze({ role: binding.role, argument_kind: 'assertion', assertion_id: binding.assertion_id });
  }
  if (kind === 'referent_id') {
    if (!selection.referentIds.has(binding.referent_id)) {
      fail('MISSING_REFERENT_ARGUMENT', `direct argument cites missing Referent ${binding.referent_id}`);
    }
    return deepFreeze({ role: binding.role, argument_kind: 'referent', referent_id: binding.referent_id,
      resolution_basis: 'grounded_assertion_direct' });
  }
  const component = selection.componentByMention.get(binding.mention_id);
  if (!component) {
    if (selection.pendingMentionIds.has(binding.mention_id)) return deepFreeze({
      role: binding.role,
      argument_kind: 'mention',
      mention_id: binding.mention_id,
      resolution_state: 'not_evaluated_in_this_batch',
      evaluation_receipt_id: selection.batchReceipt.receipt_id,
      resolution_receipt_id: null,
      resolution_receipt: null,
      conflict_ids: [],
      conflicts: [],
    });
    if (selection.resolution) {
      fail('IDENTITY_MENTION_COVERAGE_MISMATCH',
        `selected identity resolution does not cover serving mention ${binding.mention_id}`);
    }
    return deepFreeze({
      role: binding.role,
      argument_kind: 'mention',
      mention_id: binding.mention_id,
      resolution_state: 'no_selected_resolution',
      resolution_receipt_id: null,
      resolution_receipt: null,
      conflict_ids: [],
      conflicts: [],
    });
  }
  const receipt = selection.receiptById.get(component.resolution_receipt_id);
  const conflicts = component.conflict_ids.map(id => selection.conflictById.get(id));
  if (component.status !== 'resolved') return deepFreeze({
    role: binding.role,
    argument_kind: 'mention',
    mention_id: binding.mention_id,
    resolution_state: component.status,
    resolution_receipt_id: receipt.receipt_id,
    resolution_receipt: clone(receipt),
    blocking_constraint_ids: clone(component.blocking_constraint_ids || []),
    conflict_ids: clone(component.conflict_ids),
    conflicts: clone(conflicts),
  });
  const mapping = selection.resolution.mention_resolutions.find(row => row.mention_id === binding.mention_id);
  if (!mapping || mapping.resolution_receipt_id !== receipt.receipt_id
    || mapping.referent_id !== receipt.selected_referent_id) {
    fail('REFERENT_RECEIPT_DISAGREEMENT', `mention ${binding.mention_id} disagrees with its selected receipt`);
  }
  return deepFreeze({
    role: binding.role,
    argument_kind: 'referent',
    raw_mention_id: binding.mention_id,
    referent_id: mapping.referent_id,
    resolution_state: 'resolved',
    resolution_receipt_id: receipt.receipt_id,
    resolution_receipt: clone(receipt),
    conflict_ids: [],
    conflicts: [],
  });
}

/** The complete selected ServingAssertion identity. */
export function servingAssertionId({ assertion_id, selected_arguments, identity_head = null,
  identity_batch_receipt_id: identityBatchReceiptId = null }) {
  requireId(assertion_id, 'assertion_id');
  validateArray(selected_arguments, 'ServingAssertion.selected_arguments');
  if (identity_head != null) requireId(identity_head, 'identity_head');
  if (identityBatchReceiptId != null) requireId(identityBatchReceiptId, 'identity_batch_receipt_id');
  return hashId('serving-assertion', {
    assertion_id,
    selected_arguments,
    identity_head,
    ...(identityBatchReceiptId ? { identity_batch_receipt_id: identityBatchReceiptId } : {}),
    serving_schema: SERVING_ASSERTION_SCHEMA,
  });
}

/** Build the additive selected serving view without mutating either input plane. */
export function buildServingAssertionPlane({
  admitted_claims, claim_projection, grounded_assertions = [], grounding_registry,
  identity_resolution = null, identity_constraints = [], identity_verification_registry = null,
  identity_receipt_history = {
    resolution_receipts: [], referent_identity_keys: [],
  }, identity_batch_receipt = null, identity_head = null, materialization_id,
}) {
  requireId(materialization_id, 'materialization_id');
  const intake = validateAssertionIntake({
    admitted_claims, claim_projection, grounded_assertions, grounding_registry,
  });

  const hasResolution = identity_resolution != null;
  const hasIdentityHead = identity_head != null;
  if (hasResolution !== hasIdentityHead) {
    fail('IDENTITY_SELECTION_PAIR_MISMATCH',
      'identity resolution and its deterministic identity head must both be absent or both be present');
  }
  const selection = identitySelection(identity_resolution, identity_constraints,
    identity_receipt_history, identity_batch_receipt, identity_verification_registry);
  if (hasResolution && identity_head !== identityHeadForResolution(identity_resolution)) {
    fail('IDENTITY_HEAD_COMMITMENT_MISMATCH',
      'identity head does not commit to the exact selected identity-resolution digest');
  }

  const rawAssertions = intake.rawAssertions;
  const assertionIds = new Set(intake.assertionById.keys());
  const servingAssertions = rawAssertions.map(assertion => {
    const raw = clone(assertion);
    const bindings = clone(rawArguments(assertion));
    const arguments_ = bindings.map(binding =>
      selectedArgument(binding, assertion.assertion_id, assertionIds, selection));
    return deepFreeze({
      schema: SERVING_ASSERTION_SCHEMA,
      serving_assertion_id: servingAssertionId({
        assertion_id: assertion.assertion_id, selected_arguments: arguments_, identity_head,
        identity_batch_receipt_id: identity_batch_receipt?.receipt_id || null,
      }),
      assertion_id: assertion.assertion_id,
      raw_argument_bindings: bindings,
      selected_arguments: arguments_,
      raw_assertion: raw,
      identity_head,
      identity_batch_receipt_id: identity_batch_receipt?.receipt_id || null,
      materialization_id,
    });
  }).sort((left, right) => left.assertion_id.localeCompare(right.assertion_id));
  const body = {
    schema: SERVING_ASSERTION_PLANE_SCHEMA,
    materialization_id,
    identity_head,
    identity_resolution_digest: identity_resolution?.digest || null,
    identity_batch_receipt: clone(identity_batch_receipt),
    claim_plane_projection_digest: claim_projection.claim_plane_projection_digest,
    raw_assertion_ids: [...assertionIds].sort(),
    serving_assertions: servingAssertions,
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyServingAssertionPlane(input) {
  const expected = buildServingAssertionPlane({
    admitted_claims: input.admitted_claims,
    claim_projection: input.claim_projection,
    grounded_assertions: input.grounded_assertions || [],
    grounding_registry: input.grounding_registry,
    identity_resolution: input.identity_resolution || null,
    identity_constraints: input.identity_constraints || [],
    identity_verification_registry: input.identity_verification_registry || null,
    identity_receipt_history: input.identity_receipt_history || {
      resolution_receipts: [], referent_identity_keys: [],
    },
    identity_batch_receipt: input.serving_plane.identity_batch_receipt || null,
    identity_head: input.serving_plane.identity_head,
    materialization_id: input.serving_plane.materialization_id,
  });
  if (!exactEqual(input.serving_plane, expected)) {
    fail('SERVING_ASSERTION_PLANE_MISMATCH', 'serving assertion plane changed raw semantics or selected resolution provenance');
  }
  const sourceIds = [...input.claim_projection.assertions, ...(input.grounded_assertions || [])]
    .map(row => row.assertion_id).sort();
  if (!exactEqual(input.serving_plane.raw_assertion_ids, sourceIds)
    || input.serving_plane.serving_assertions.length !== sourceIds.length) {
    fail('SERVING_ASSERTION_CONSERVATION', 'serving assertion cardinality or raw assertion identity set changed');
  }
  return deepFreeze({
    raw_assertions: sourceIds.length,
    serving_assertions: input.serving_plane.serving_assertions.length,
    raw_assertion_ids: sourceIds,
    claim_plane_projection_digest: input.claim_projection.claim_plane_projection_digest,
  });
}

export function buildAssertionSupersessionReceipt({
  old_assertion_id, new_assertion_id, cause, basis_receipt_ids, materialization_id,
}) {
  requireId(old_assertion_id, 'old_assertion_id');
  requireId(new_assertion_id, 'new_assertion_id');
  requireId(materialization_id, 'materialization_id');
  if (old_assertion_id === new_assertion_id) fail('SAME_ASSERTION_SUPERSESSION', 'supersession endpoints must differ');
  if (!supersessionCauses.has(cause)) fail('INVALID_ASSERTION_SUPERSESSION_CAUSE', `unsupported supersession cause ${cause}`);
  const basisIds = exactArray(basis_receipt_ids);
  if (!basisIds.length || basisIds.some(id => !clean(id))) {
    fail('UNGROUNDED_ASSERTION_SUPERSESSION', 'assertion supersession requires non-empty basis receipt ids');
  }
  const body = {
    schema: ASSERTION_SUPERSESSION_RECEIPT_SCHEMA,
    old_assertion_id,
    new_assertion_id,
    cause,
    basis_receipt_ids: basisIds,
    materialization_id,
  };
  return deepFreeze({ ...body, receipt_id: hashId('assertion-supersession-receipt', body) });
}

function validateSupersessionReceipt(receipt) {
  requireRecord(receipt, 'AssertionSupersessionReceipt');
  const expected = buildAssertionSupersessionReceipt({
    old_assertion_id: receipt.old_assertion_id,
    new_assertion_id: receipt.new_assertion_id,
    cause: receipt.cause,
    basis_receipt_ids: receipt.basis_receipt_ids,
    materialization_id: receipt.materialization_id,
  });
  if (!exactEqual(receipt, expected)) {
    fail('INVALID_ASSERTION_SUPERSESSION_ID', `supersession receipt ${receipt.receipt_id || '<missing>'} is not deterministic`);
  }
}

function validateSupersessionBasisReceipt(receipt, intake) {
  requireRecord(receipt, 'supersession basis receipt');
  let conserved;
  if (receipt.schema === CLAIM_PROJECTION_RECEIPT_SCHEMA) {
    validateClaimProjectionReceipt(receipt);
    conserved = intake.projectionReceiptById.get(receipt.receipt_id);
  } else if (receipt.schema === ARGUMENT_BINDING_COVERAGE_SCHEMA) {
    validateArgumentBindingCoverageReceipt(receipt);
    conserved = intake.argumentBindingReceiptById.get(receipt.receipt_id);
  } else {
    fail('INVALID_SUPERSESSION_BASIS_RECEIPT',
      `unsupported supersession basis receipt schema ${receipt.schema || '<missing>'}`);
  }
  if (!conserved || !exactEqual(receipt, conserved)) {
    fail('SUPERSESSION_BASIS_CONSERVATION_MISMATCH',
      `supersession basis receipt ${receipt.receipt_id} is not an exact conserved projection row`);
  }
}

function validateSupersessionConnection(receipt, basisRows, intake) {
  const oldAssertion = intake.assertionById.get(receipt.old_assertion_id);
  const newAssertion = intake.assertionById.get(receipt.new_assertion_id);
  if (receipt.cause === 'rebinding') {
    if (oldAssertion.schema !== CLAIM_ASSERTION_SCHEMA || newAssertion.schema !== CLAIM_ASSERTION_SCHEMA) {
      fail('GROUNDED_ASSERTION_REBINDING_UNSUPPORTED',
        `supersession ${receipt.receipt_id} cannot connect a GroundedAssertion endpoint through a documentary A1 rebinding receipt`);
    }
    const projectionReceipt = intake.projectionReceiptById.get(newAssertion.projection_receipt_id);
    if (!projectionReceipt || basisRows.some(row =>
      !projectionReceipt.argument_binding_receipt_ids.includes(row.receipt_id))) {
      fail('UNCONNECTED_ASSERTION_SUPERSESSION_BASIS',
        `rebinding basis for ${receipt.new_assertion_id} is not cited by its exact projection receipt`);
    }
    return;
  }
  if (basisRows.some(row => !intake.admittedClaimIds.has(row.basis_claim_id))) {
    fail('UNADMITTED_SUPERSESSION_BASIS_CLAIM',
      `supersession ${receipt.receipt_id} cites a basis receipt for an unadmitted claim`);
  }
  if (basisRows.some(row => !row.assertion_ids.includes(receipt.new_assertion_id))) {
    fail('UNCONNECTED_ASSERTION_SUPERSESSION_BASIS',
      `supersession basis for ${receipt.new_assertion_id} does not cite the new assertion`);
  }
}

function validateSupersessionGraph(intake, receipts, basisReceiptById) {
  const assertionIds = new Set(intake.assertionById.keys());
  const outgoing = new Map();
  const receiptIds = new Set();
  for (const receipt of receipts) {
    validateSupersessionReceipt(receipt);
    if (receiptIds.has(receipt.receipt_id)) fail('DUPLICATE_ASSERTION_SUPERSESSION_ID', `duplicate ${receipt.receipt_id}`);
    receiptIds.add(receipt.receipt_id);
    if (!assertionIds.has(receipt.old_assertion_id) || !assertionIds.has(receipt.new_assertion_id)) {
      fail('MISSING_ASSERTION_SUPERSESSION_ENDPOINT', `supersession ${receipt.receipt_id} cites a missing assertion`);
    }
    const basisRows = receipt.basis_receipt_ids.map(id => basisReceiptById.get(id));
    if (basisRows.some(row => !row)) {
      fail('UNGROUNDED_ASSERTION_SUPERSESSION', `supersession ${receipt.receipt_id} cites an unresolved basis receipt`);
    }
    const expectedSchema = receipt.cause === 'rebinding'
      ? ARGUMENT_BINDING_COVERAGE_SCHEMA : CLAIM_PROJECTION_RECEIPT_SCHEMA;
    if (basisRows.some(row => row.schema !== expectedSchema)) {
      fail('INCOMPATIBLE_ASSERTION_SUPERSESSION_BASIS',
        `supersession cause ${receipt.cause} requires ${expectedSchema}`);
    }
    validateSupersessionConnection(receipt, basisRows, intake);
    if (outgoing.has(receipt.old_assertion_id)) {
      fail('ASSERTION_SUPERSESSION_FORK', `assertion ${receipt.old_assertion_id} has multiple selected successors`);
    }
    outgoing.set(receipt.old_assertion_id, receipt);
  }
  for (const assertionId of assertionIds) {
    const seen = new Set([assertionId]);
    let selected = assertionId;
    while (outgoing.has(selected)) {
      selected = outgoing.get(selected).new_assertion_id;
      if (seen.has(selected)) fail('ASSERTION_SUPERSESSION_CYCLE', `supersession chain from ${assertionId} is cyclic`);
      seen.add(selected);
    }
  }
  return outgoing;
}

export function buildAssertionSupersessionLedger({
  admitted_claims, claim_projection, grounded_assertions = [], grounding_registry,
  basis_receipts, supersession_receipts = [], materialization_id,
}) {
  requireId(materialization_id, 'materialization_id');
  if (!Array.isArray(basis_receipts) || !Array.isArray(supersession_receipts)) {
    fail('INVALID_ASSERTION_SUPERSESSION_LEDGER', 'supersession ledger receipt inputs must be arrays');
  }
  const intake = validateAssertionIntake({
    admitted_claims, claim_projection, grounded_assertions, grounding_registry,
  });
  const assertionIds = new Set(intake.assertionById.keys());
  const basisReceiptById = new Map();
  for (const receipt of basis_receipts) {
    validateSupersessionBasisReceipt(receipt, intake);
    const id = requireId(receiptIdentity(receipt), 'basis receipt_id');
    if (basisReceiptById.has(id)) fail('DUPLICATE_SUPERSESSION_BASIS', `duplicate basis receipt ${id}`);
    basisReceiptById.set(id, receipt);
  }
  const outgoing = validateSupersessionGraph(intake, supersession_receipts, basisReceiptById);
  const usedBasisIds = exactArray(supersession_receipts.flatMap(row => row.basis_receipt_ids));
  if (!exactEqual([...basisReceiptById.keys()].sort(), usedBasisIds)) {
    fail('SUPERSESSION_BASIS_CONSERVATION_MISMATCH',
      'supersession basis registry must contain exactly the receipts cited by the ledger');
  }
  const selectedTips = [...assertionIds].sort().map(assertionId => {
    let selected = assertionId;
    while (outgoing.has(selected)) selected = outgoing.get(selected).new_assertion_id;
    return { assertion_id: assertionId, selected_tip_assertion_id: selected };
  });
  const body = {
    schema: ASSERTION_SUPERSESSION_LEDGER_SCHEMA,
    materialization_id,
    admitted_claims: clone(admitted_claims),
    claim_projection: clone(claim_projection),
    grounded_assertions: clone(grounded_assertions),
    grounding_registry: clone(grounding_registry),
    assertions: clone(intake.rawAssertions),
    basis_receipts: clone(basis_receipts),
    supersession_receipts: clone(supersession_receipts),
    selected_tips: selectedTips,
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

function validateSupersessionLedger(ledger) {
  const fields = [
    'schema', 'materialization_id', 'admitted_claims', 'claim_projection',
    'grounded_assertions', 'grounding_registry', 'assertions', 'basis_receipts',
    'supersession_receipts', 'selected_tips', 'digest',
  ];
  requireClosedFields(ledger, fields, fields, 'AssertionSupersessionLedger');
  if (ledger.schema !== ASSERTION_SUPERSESSION_LEDGER_SCHEMA
    || !clean(ledger.materialization_id)
    || !Array.isArray(ledger.admitted_claims) || !Array.isArray(ledger.assertions)
    || !Array.isArray(ledger.basis_receipts)
    || !Array.isArray(ledger.supersession_receipts) || !Array.isArray(ledger.selected_tips)) {
    fail('INVALID_ASSERTION_SUPERSESSION_LEDGER', 'supersession ledger differs from its closed schema');
  }
  const rebuilt = buildAssertionSupersessionLedger({
    admitted_claims: ledger.admitted_claims,
    claim_projection: ledger.claim_projection,
    grounded_assertions: ledger.grounded_assertions,
    grounding_registry: ledger.grounding_registry,
    basis_receipts: ledger.basis_receipts,
    supersession_receipts: ledger.supersession_receipts,
    materialization_id: ledger.materialization_id,
  });
  if (!exactEqual(ledger, rebuilt)) {
    fail('INVALID_ASSERTION_SUPERSESSION_LEDGER',
      'supersession ledger schema, rows, tips, materialization, or digest is not deterministic');
  }
  return rebuilt;
}

export function verifyAppendOnlyAssertionSupersession({ previous, next }) {
  validateSupersessionLedger(previous);
  validateSupersessionLedger(next);
  for (const field of ['assertions', 'basis_receipts', 'supersession_receipts']) {
    if (next[field].length < previous[field].length
      || !exactEqual(next[field].slice(0, previous[field].length), previous[field])) {
      fail('ASSERTION_SUPERSESSION_HISTORY_CHANGED', `${field} history was mutated, deleted, or reordered`);
    }
  }
  return true;
}

export function resolveAssertionSupersession({ assertion_id, ledger }) {
  requireId(assertion_id, 'assertion_id');
  validateSupersessionLedger(ledger);
  const assertionIds = new Set(ledger.assertions.map(row => row.assertion_id));
  if (!assertionIds.has(assertion_id)) fail('MISSING_ASSERTION_SUPERSESSION_ENDPOINT', `unknown assertion ${assertion_id}`);
  const outgoing = new Map(ledger.supersession_receipts
    .map(receipt => [receipt.old_assertion_id, receipt]));
  const assertionChain = [assertion_id];
  const receiptChain = [];
  while (outgoing.has(assertionChain.at(-1))) {
    const receipt = outgoing.get(assertionChain.at(-1));
    receiptChain.push(receipt.receipt_id);
    assertionChain.push(receipt.new_assertion_id);
  }
  return deepFreeze({
    requested_assertion_id: assertion_id,
    selected_tip_assertion_id: assertionChain.at(-1),
    assertion_chain: assertionChain,
    supersession_receipt_chain: receiptChain,
  });
}

export function buildFrozenReferencePolicyResult({
  reference_id, reference_kind, requested_assertion_id, selected_tip_assertion_id,
  policy_id, policy_version, qualifies, materialization_id,
}) {
  requireId(reference_id, 'reference_id');
  requireId(requested_assertion_id, 'requested_assertion_id');
  requireId(selected_tip_assertion_id, 'selected_tip_assertion_id');
  requireId(policy_id, 'policy_id');
  requireId(policy_version, 'policy_version');
  requireId(materialization_id, 'materialization_id');
  if (!referenceKinds.has(reference_kind) || reference_kind === 'scenario') {
    fail('INVALID_DEPENDENT_REFERENCE_KIND', 'frozen reprojection policy applies only to serving or relation references');
  }
  if (typeof qualifies !== 'boolean') fail('INVALID_FROZEN_POLICY_RESULT', 'qualifies must be boolean');
  const body = {
    schema: FROZEN_REFERENCE_POLICY_RESULT_SCHEMA,
    reference_id,
    reference_kind,
    requested_assertion_id,
    selected_tip_assertion_id,
    policy_id,
    policy_version,
    qualifies,
    materialization_id,
  };
  return deepFreeze({ ...body, result_id: hashId('frozen-reference-policy-result', body) });
}

function validateFrozenPolicyResult(result) {
  const expected = buildFrozenReferencePolicyResult({
    reference_id: result.reference_id,
    reference_kind: result.reference_kind,
    requested_assertion_id: result.requested_assertion_id,
    selected_tip_assertion_id: result.selected_tip_assertion_id,
    policy_id: result.policy_id,
    policy_version: result.policy_version,
    qualifies: result.qualifies,
    materialization_id: result.materialization_id,
  });
  if (!exactEqual(result, expected)) fail('FORGED_FROZEN_POLICY_RESULT', `policy result ${result.result_id || '<missing>'} is not deterministic`);
}

export function reconcileDependentReferences({
  references, supersession_ledger, frozen_policy_results = [], materialization_id,
}) {
  requireId(materialization_id, 'materialization_id');
  validateSupersessionLedger(supersession_ledger);
  const policyByReference = new Map();
  for (const result of frozen_policy_results) {
    validateFrozenPolicyResult(result);
    if (result.materialization_id !== materialization_id) {
      fail('FROZEN_POLICY_MATERIALIZATION_MISMATCH',
        `policy result ${result.result_id} crosses reconciliation materializations`);
    }
    if (policyByReference.has(result.reference_id)) fail('DUPLICATE_FROZEN_POLICY_RESULT', `multiple results for ${result.reference_id}`);
    policyByReference.set(result.reference_id, result);
  }
  const referenceIds = new Set();
  const reconciled = (references || []).map(reference => {
    requireId(reference?.reference_id, 'reference_id');
    requireId(reference?.assertion_id, 'reference assertion_id');
    if (!referenceKinds.has(reference.reference_kind)) {
      fail('INVALID_DEPENDENT_REFERENCE_KIND', `unsupported reference kind ${reference.reference_kind}`);
    }
    if (referenceIds.has(reference.reference_id)) fail('DUPLICATE_DEPENDENT_REFERENCE', `duplicate ${reference.reference_id}`);
    referenceIds.add(reference.reference_id);
    const chain = resolveAssertionSupersession({ assertion_id: reference.assertion_id, ledger: supersession_ledger });
    const superseded = chain.assertion_chain.length > 1;
    const policy = policyByReference.get(reference.reference_id) || null;
    if (policy && (policy.reference_kind !== reference.reference_kind
      || policy.requested_assertion_id !== reference.assertion_id
      || policy.selected_tip_assertion_id !== chain.selected_tip_assertion_id)) {
      fail('FROZEN_POLICY_TARGET_MISMATCH', `policy result for ${reference.reference_id} does not evaluate its complete chain`);
    }
    let selectedAssertionId = reference.assertion_id;
    let referenceState;
    if (reference.reference_kind === 'scenario') {
      referenceState = superseded ? 'pinned_historical' : 'pinned_current';
    } else if (!superseded) {
      referenceState = 'current';
    } else if (policy?.qualifies === true) {
      selectedAssertionId = chain.selected_tip_assertion_id;
      referenceState = 'current';
    } else {
      referenceState = 'historical';
    }
    return deepFreeze({
      reference_id: reference.reference_id,
      reference_kind: reference.reference_kind,
      original_assertion_id: reference.assertion_id,
      selected_assertion_id: selectedAssertionId,
      reference_state: referenceState,
      assertion_chain: clone(chain.assertion_chain),
      supersession_receipt_chain: clone(chain.supersession_receipt_chain),
      frozen_policy_result_id: policy?.result_id || null,
    });
  }).sort((left, right) => left.reference_id.localeCompare(right.reference_id));
  for (const referenceId of policyByReference.keys()) {
    if (!referenceIds.has(referenceId)) {
      fail('ORPHAN_FROZEN_POLICY_RESULT', `policy result cites unknown dependent reference ${referenceId}`);
    }
  }
  const body = {
    schema: DEPENDENT_REFERENCE_RECONCILIATION_SCHEMA,
    materialization_id,
    reconciled_references: reconciled,
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyDependentReferenceReconciliation(input) {
  const expected = reconcileDependentReferences({
    references: input.references,
    supersession_ledger: input.supersession_ledger,
    frozen_policy_results: input.frozen_policy_results || [],
    materialization_id: input.reconciliation.materialization_id,
  });
  if (!exactEqual(input.reconciliation, expected)) {
    fail('DEPENDENT_REFERENCE_RECONCILIATION_MISMATCH', 'dependent references do not match their complete supersession chains');
  }
  for (const row of input.reconciliation.reconciled_references) {
    if (row.assertion_chain.length > 1 && row.reference_state === 'current'
      && row.selected_assertion_id !== row.assertion_chain.at(-1)) {
      fail('SILENT_CURRENT_SUPERSEDED_ASSERTION', `reference ${row.reference_id} silently treats an old assertion as current`);
    }
    if (row.reference_kind === 'scenario' && row.assertion_chain.length > 1
      && (row.reference_state !== 'pinned_historical'
        || row.selected_assertion_id !== row.original_assertion_id)) {
      fail('SCENARIO_REFERENCE_REPINNED', `scenario ${row.reference_id} did not remain pinned historical`);
    }
  }
  return true;
}
