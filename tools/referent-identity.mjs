// Deterministic, append-only referent identity over exact Phase A mentions.
//
// Candidate components are assembled without assigning referents, every complete component is
// validated, and only then are conflict-free components resolved. Surface normalization never
// creates an identity edge.
import { sha256, stableStringify } from './lib.mjs';
import {
  buildEvidencePointer, buildMention, EVIDENCE_POINTER_SCHEMA, MENTION_SCHEMA,
} from './argument-mentions.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_RECEIPT_SCHEMA,
} from './claim-projection.mjs';
import { identityCandidateDecision } from './identity-candidate-generator.mjs';

export const REFERENT_SCHEMA = 'estate-map/referent/v1';
export const IDENTITY_CONSTRAINT_SCHEMA = 'estate-map/identity-constraint/v1';
export const RESOLUTION_RECEIPT_SCHEMA = 'estate-map/resolution-receipt/v1';
export const IDENTITY_CONFLICT_SCHEMA = 'estate-map/identity-conflict/v1';
export const IDENTITY_RESOLUTION_SCHEMA = 'estate-map/identity-resolution/v1';
export const IDENTITY_LIFECYCLE_RECORD_SCHEMA = 'estate-map/identity-lifecycle-record/v1';
export const IDENTITY_LEDGER_SCHEMA = 'estate-map/identity-ledger/v1';
export const FORGE_LOCATOR_IDENTITY_SCHEMA = 'estate-map/forge-locator-identity/v1';
export const LOCATOR_ASSERTION_SCHEMA = 'estate-map/locator-assertion/v1';
export const IDENTITY_VERIFICATION_REGISTRY_SCHEMA = 'estate-map/identity-verification-registry/v1';
export const IDENTITY_DECLARATION_WITNESS_SCHEMA = 'estate-map/identity-declaration-witness/v1';
export const REVIEWED_RESOLUTION_RECEIPT_SCHEMA = 'estate-map/reviewed-resolution-receipt/v1';
export const REVIEWED_RESOLUTION_DEPENDENCY_SCHEMA = 'estate-map/reviewed-resolution-dependency/v1';
export const COMPONENT_IDENTITY_DECISION_SCHEMA = 'estate-map/component-identity-decision/v1';
export const COMPONENT_NAMESPACE_KEY_SCHEMA = 'estate-map/component-namespace-key/v1';

export const IDENTITY_KINDS = Object.freeze([
  'source_native', 'deterministic_namespace', 'resolved_opaque',
]);
export const REFERENT_LIFECYCLE_STATES = Object.freeze([
  'active', 'merged', 'split', 'tombstoned',
]);
export const IDENTITY_CONSTRAINT_DISPOSITIONS = Object.freeze([
  'must_link', 'cannot_link', 'unresolved',
]);
export const RESOLUTION_DISPOSITIONS = Object.freeze([
  'resolved', 'split', 'unresolved', 'rejected_noise', 'fixture_or_example',
  'terminal_incomplete',
]);
export const IDENTITY_LIFECYCLE_EVENTS = Object.freeze([
  'merge', 'split', 'rename', 'successor', 'transfer', 'deprecation',
]);
export const AUTOMATIC_IDENTITY_BASES = Object.freeze([
  'source_established_canonical_reference',
  'connector_native_id',
  'pinned_forge_repository_locator',
  'parser_backed_schema',
  'declared_namespace_identity',
  'exact_defined_term_identity',
  'source_cited_alias',
  'prior_reviewed_resolution',
]);

const automaticBases = new Set(AUTOMATIC_IDENTITY_BASES);
const identityKinds = new Set(IDENTITY_KINDS);
const lifecycleStates = new Set(REFERENT_LIFECYCLE_STATES);
const constraintDispositions = new Set(IDENTITY_CONSTRAINT_DISPOSITIONS);
const resolutionDispositions = new Set(RESOLUTION_DISPOSITIONS);
const lifecycleEvents = new Set(IDENTITY_LIFECYCLE_EVENTS);
const sourceStatuses = new Set(['current', 'historical', 'aspirational', 'deprecated', 'disputed']);
const constraintKinds = new Set(['identity', 'namespace', 'type', 'incompatible_time']);
const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const clean = value => String(value ?? '').trim();
const exactArray = values => [...new Set(values || [])].sort();
const exactEqual = (left, right) => canonical(left) === canonical(right);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export class ReferentIdentityError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ReferentIdentityError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new ReferentIdentityError(code, message, detail);
}

function requireId(value, label) {
  if (!clean(value)) fail('MISSING_IDENTITY_FIELD', `${label} is required`);
  return value;
}

function validateStringArray(values, label) {
  if (!Array.isArray(values) || values.some(value => !clean(value))) {
    fail('INVALID_IDENTITY_ID_SET', `${label} must be an array of non-empty ids`);
  }
  return exactArray(values);
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value || {}).filter(key => !allowed.includes(key));
  if (unknown.length) fail('UNKNOWN_IDENTITY_FIELD', `${label} contains unsupported fields`, { unknown });
}

function validateValidTime(validTime) {
  if (validTime == null) return null;
  if (typeof validTime !== 'object' || Array.isArray(validTime)) {
    fail('INVALID_VALID_TIME', 'valid_time must be an object or null');
  }
  rejectUnknown(validTime, ['start', 'end'], 'valid_time');
  const start = validTime.start == null ? null : clean(validTime.start);
  const end = validTime.end == null ? null : clean(validTime.end);
  if ((validTime.start != null && !start) || (validTime.end != null && !end)) {
    fail('INVALID_VALID_TIME', 'valid_time bounds must be non-empty strings');
  }
  if (start && end && start > end) fail('INVALID_VALID_TIME', 'valid_time start follows end');
  return deepFreeze({ start, end });
}

const automaticBasisContracts = Object.freeze({
  source_established_canonical_reference: ['canonical_reference', 'source_version_id'],
  connector_native_id: ['connector', 'native_id', 'native_version_id'],
  pinned_forge_repository_locator: ['forge_host', 'namespace', 'repository_locator', 'source_version_id'],
  parser_backed_schema: ['parser_id', 'schema_id', 'declared_identifier', 'source_version_id'],
  declared_namespace_identity: ['namespace_key', 'declared_identifier', 'source_version_id'],
  exact_defined_term_identity: ['namespace_key', 'exact_term', 'definition_evidence_id'],
  source_cited_alias: ['alias_assertion_id'],
  prior_reviewed_resolution: ['receipt_id', 'dependency_ids', 'dependencies_valid'],
});

function validatedAutomaticBasis(basis) {
  if (!basis || typeof basis !== 'object' || Array.isArray(basis) || !automaticBases.has(basis.kind)) {
    fail('UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS', `unsupported automatic identity basis ${basis?.kind || '<missing>'}`);
  }
  const required = automaticBasisContracts[basis.kind];
  rejectUnknown(basis, ['kind', ...required], 'automatic identity basis');
  const missing = required.filter(key => !Object.hasOwn(basis, key));
  if (missing.length) fail('INCOMPLETE_AUTOMATIC_IDENTITY_BASIS', 'automatic identity basis is not independently testable', { missing });
  for (const key of required) {
    if (key === 'dependencies_valid') {
      if (basis[key] !== true) fail('STALE_REVIEWED_RESOLUTION', 'prior reviewed resolution dependencies must remain valid');
    } else if (key === 'dependency_ids') {
      validateStringArray(basis[key], 'dependency_ids');
    } else if (!clean(basis[key])) {
      fail('INCOMPLETE_AUTOMATIC_IDENTITY_BASIS', `automatic identity basis requires ${key}`);
    }
  }
  return deepFreeze(structuredClone(basis));
}

const identityVerificationRegistryState = new WeakMap();
// Component decisions are runtime verifier outputs, like IdentityVerificationRegistry itself.
// Structural bytes are content-addressed, but bytes alone cannot prove that the key was recompiled
// from exact declaration evidence. The private binding prevents a caller-authored lookalike from
// gaining admission authority.
const verifiedComponentIdentityDecisionState = new WeakMap();

function exactRecordIndex(rows, idField, label) {
  if (!Array.isArray(rows)) fail('INVALID_IDENTITY_VERIFICATION_REGISTRY', `${label} must be an array`);
  const index = new Map();
  for (const row of rows) {
    const id = requireId(row?.[idField], `${label}.${idField}`);
    if (index.has(id)) {
      fail('DUPLICATE_IDENTITY_VERIFICATION_RECORD', `${label} contains duplicate ${id}`);
    }
    index.set(id, row);
  }
  return index;
}

function validateEvidenceRecord(pointer) {
  if (pointer?.schema !== EVIDENCE_POINTER_SCHEMA) {
    fail('INVALID_IDENTITY_EVIDENCE', `evidence ${pointer?.evidence_id || '<missing>'} has an invalid schema`);
  }
  let expected;
  try {
    expected = buildEvidencePointer({
      source_version_id: pointer.source_version_id,
      access_policy_id: pointer.access_policy_id,
      pointer: pointer.pointer,
    });
  } catch (error) {
    fail('INVALID_IDENTITY_EVIDENCE',
      `evidence ${pointer.evidence_id || '<missing>'} differs from its producer`, {
        producer_code: error?.code || null,
      });
  }
  if (!exactEqual(pointer, expected)) {
    fail('INVALID_IDENTITY_EVIDENCE',
      `evidence ${pointer.evidence_id || '<missing>'} differs from its producer`);
  }
}

function validateMentionRecord(mention, evidenceById) {
  if (mention?.schema !== MENTION_SCHEMA) {
    fail('INVALID_IDENTITY_MENTION', `mention ${mention?.mention_id || '<missing>'} has an invalid schema`);
  }
  const evidence = evidenceById.get(mention.evidence_id);
  if (!evidence) {
    fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
      `mention ${mention.mention_id} evidence ${mention.evidence_id} does not resolve exactly once`);
  }
  let expected;
  try {
    expected = buildMention({
      evidence_pointer: evidence,
      surface: mention.surface,
      role: mention.role,
      mention_producer_version: mention.mention_producer_version,
      claim_id: mention.claim_id,
      proposition_key: mention.proposition_key,
      candidate_obligation_id: mention.candidate_obligation_id,
      provenance_class: mention.provenance_class,
      namespace: mention.namespace,
      source_status: mention.source_status,
      context_digest: mention.context_digest,
      disposition: mention.disposition,
    }).mention;
  } catch (error) {
    fail('INVALID_IDENTITY_MENTION',
      `mention ${mention.mention_id || '<missing>'} differs from its producer`, {
        producer_code: error?.code || null,
      });
  }
  if (!exactEqual(mention, expected)) {
    fail('INVALID_IDENTITY_MENTION',
      `mention ${mention.mention_id || '<missing>'} differs from its producer`);
  }
}

function validateProjectionReceiptRecord(receipt) {
  if (receipt?.schema !== CLAIM_PROJECTION_RECEIPT_SCHEMA) {
    fail('INVALID_IDENTITY_ASSERTION_RECEIPT',
      `receipt ${receipt?.receipt_id || '<missing>'} is not a ClaimProjectionReceipt`);
  }
  const { receipt_id: receiptId, ...body } = receipt;
  if (receiptId !== hashId('claim-projection-receipt', body)) {
    fail('INVALID_IDENTITY_ASSERTION_RECEIPT',
      `receipt ${receiptId || '<missing>'} differs from its producer`);
  }
}

function validateClaimAssertionRecord(assertion, receiptById) {
  if (assertion?.schema !== CLAIM_ASSERTION_SCHEMA
    || assertion.assertion_id !== claimAssertionId(assertion)) {
    fail('INVALID_IDENTITY_BASIS_ASSERTION',
      `assertion ${assertion?.assertion_id || '<missing>'} differs from its producer`);
  }
  const receipt = receiptById.get(assertion.projection_receipt_id);
  if (!receipt) {
    fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
      `assertion ${assertion.assertion_id} projection receipt does not resolve exactly once`);
  }
  validateProjectionReceiptRecord(receipt);
  if (!receipt.assertion_ids.includes(assertion.assertion_id)
    || receipt.basis_claim_id !== assertion.basis_claim_id) {
    fail('INVALID_IDENTITY_BASIS_ASSERTION',
      `assertion ${assertion.assertion_id} is not selected by its exact projection receipt`);
  }
}

/** A documentary declaration witness exists only where the current EvidencePointer cannot carry
 * the parser/compiler field itself. Code declarations are always recompiled from exact record
 * bytes and never need this adapter. */
export function buildIdentityDeclarationWitness({
  mention_id, candidate_basis, compiler_id, source_fact_evidence_id = null,
}) {
  requireId(mention_id, 'declaration witness mention_id');
  requireId(compiler_id, 'declaration witness compiler_id');
  const basis = structuredClone(candidate_basis);
  if (!basis || !['parser_backed_schema', 'declared_namespace_identity'].includes(basis.kind)) {
    fail('INVALID_IDENTITY_DECLARATION_WITNESS',
      'declaration witness requires a parser-backed or declared-namespace candidate basis');
  }
  const expectedFields = basis.kind === 'parser_backed_schema'
    ? ['kind', 'parser_id', 'schema_id', 'declared_identifier']
    : ['kind', 'namespace_key', 'declared_identifier'];
  rejectUnknown(basis, expectedFields, 'declaration witness candidate_basis');
  if (expectedFields.some(field => !clean(basis[field]))) {
    fail('INVALID_IDENTITY_DECLARATION_WITNESS',
      'declaration witness candidate basis must be complete');
  }
  const body = {
    schema: IDENTITY_DECLARATION_WITNESS_SCHEMA,
    mention_id,
    candidate_basis: basis,
    compiler_id,
    source_fact_evidence_id: source_fact_evidence_id == null ? null
      : requireId(source_fact_evidence_id, 'source_fact_evidence_id'),
  };
  return deepFreeze({ ...body, witness_id: hashId('identity-declaration-witness', body) });
}

export function buildReviewedResolutionDependency({ dependency_id, exact_record }) {
  requireId(dependency_id, 'reviewed dependency_id');
  const body = {
    schema: REVIEWED_RESOLUTION_DEPENDENCY_SCHEMA,
    dependency_id,
    exact_record: structuredClone(exact_record),
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body.exact_record)) });
}

export function buildReviewedResolutionReceipt({
  endpoint_mention_ids, dependencies, selected_head_ids, review_authority_id,
}) {
  const endpoints = validateStringArray(endpoint_mention_ids, 'endpoint_mention_ids');
  if (endpoints.length !== 2) {
    fail('INVALID_REVIEWED_RESOLUTION', 'reviewed resolution requires exactly two endpoint mentions');
  }
  if (!Array.isArray(dependencies) || !dependencies.length) {
    fail('INVALID_REVIEWED_RESOLUTION', 'reviewed resolution requires a non-empty dependency closure');
  }
  const dependencyRows = dependencies.map(row => {
    const expected = buildReviewedResolutionDependency(row);
    if (!exactEqual(row, expected)) {
      fail('INVALID_REVIEWED_RESOLUTION_DEPENDENCY',
        `reviewed dependency ${row?.dependency_id || '<missing>'} differs from its producer`);
    }
    return { dependency_id: row.dependency_id, digest: row.digest };
  }).sort((left, right) => left.dependency_id.localeCompare(right.dependency_id));
  if (new Set(dependencyRows.map(row => row.dependency_id)).size !== dependencyRows.length) {
    fail('DUPLICATE_REVIEWED_RESOLUTION_DEPENDENCY',
      'reviewed resolution dependency IDs must be unique');
  }
  const body = {
    schema: REVIEWED_RESOLUTION_RECEIPT_SCHEMA,
    endpoint_mention_ids: endpoints,
    dependency_ids: dependencyRows.map(row => row.dependency_id),
    dependency_digests: dependencyRows,
    dependency_closure_digest: sha256(canonical(dependencyRows)),
    selected_head_ids: validateStringArray(selected_head_ids, 'selected_head_ids'),
    review_authority_id: requireId(review_authority_id, 'review_authority_id'),
  };
  return deepFreeze({ ...body, receipt_id: hashId('reviewed-resolution-receipt', body) });
}

/** Build one exact runtime registry for basis truth verification. It is not a persisted semantic
 * object; its public digest commits only to the canonical producer-record IDs, while private maps
 * remain inaccessible and are rebuilt whenever a boundary receives raw records. */
export function buildIdentityVerificationRegistry({
  mentions = [], evidence_pointers = [], assertions = [], receipts = [],
  declaration_witnesses = [], forge_locator_identities = [], reviewed_dependencies = [],
} = {}) {
  const evidenceById = exactRecordIndex(evidence_pointers, 'evidence_id', 'evidence_pointers');
  for (const pointer of evidenceById.values()) validateEvidenceRecord(pointer);
  const mentionById = exactRecordIndex(mentions, 'mention_id', 'mentions');
  for (const mention of mentionById.values()) validateMentionRecord(mention, evidenceById);
  const receiptById = exactRecordIndex(receipts, 'receipt_id', 'receipts');
  const assertionById = exactRecordIndex(assertions, 'assertion_id', 'assertions');
  for (const assertion of assertionById.values()) validateClaimAssertionRecord(assertion, receiptById);
  const declarationWitnessById = exactRecordIndex(
    declaration_witnesses, 'witness_id', 'declaration_witnesses');
  const declarationWitnessesByMention = new Map();
  for (const witness of declarationWitnessById.values()) {
    const expected = buildIdentityDeclarationWitness(witness);
    if (!exactEqual(witness, expected) || !mentionById.has(witness.mention_id)) {
      fail('INVALID_IDENTITY_DECLARATION_WITNESS',
        `declaration witness ${witness.witness_id || '<missing>'} differs from its producer or mention`);
    }
    const held = declarationWitnessesByMention.get(witness.mention_id) || [];
    held.push(witness);
    declarationWitnessesByMention.set(witness.mention_id, held);
  }
  const dependencyById = exactRecordIndex(reviewed_dependencies, 'dependency_id', 'reviewed_dependencies');
  for (const dependency of dependencyById.values()) {
    const expected = buildReviewedResolutionDependency(dependency);
    if (!exactEqual(dependency, expected)) {
      fail('INVALID_REVIEWED_RESOLUTION_DEPENDENCY',
        `reviewed dependency ${dependency.dependency_id} differs from its producer`);
    }
  }
  const forgeByDigest = exactRecordIndex(forge_locator_identities, 'digest', 'forge_locator_identities');
  for (const record of forgeByDigest.values()) verifyForgeLocatorIdentity(record);
  const body = {
    schema: IDENTITY_VERIFICATION_REGISTRY_SCHEMA,
    mention_ids: [...mentionById.keys()].sort(),
    evidence_ids: [...evidenceById.keys()].sort(),
    assertion_ids: [...assertionById.keys()].sort(),
    receipt_ids: [...receiptById.keys()].sort(),
    declaration_witness_ids: [...declarationWitnessById.keys()].sort(),
    forge_locator_digests: [...forgeByDigest.keys()].sort(),
    reviewed_dependency_ids: [...dependencyById.keys()].sort(),
  };
  const registry = deepFreeze({ ...body, digest: sha256(canonical(body)) });
  identityVerificationRegistryState.set(registry, {
    evidenceById, mentionById, assertionById, receiptById, declarationWitnessesByMention,
    forgeByDigest, dependencyById,
  });
  return registry;
}

/** Rebuild the minimal exact registry needed for one canonical-store constraint from semantic-ID
 * lookup. Runtime-only declaration witnesses are deliberately unnecessary: parser/namespace
 * verification recompiles structured fact bytes and exact-occurrence bridges from the endpoints. */
export function buildIdentityVerificationRegistryFromLookup({
  constraint, lookup, declaration_witnesses = [], forge_locator_identities = [],
}) {
  if (typeof lookup !== 'function') {
    fail('INVALID_IDENTITY_VERIFICATION_REGISTRY', 'constraint registry lookup must be a function');
  }
  const requireLookup = (id, label) => {
    const record = lookup(id);
    if (!record) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD', `${label} ${id} does not resolve exactly once`);
    }
    return record;
  };
  const mentions = [constraint.left, constraint.right]
    .map(id => requireLookup(id, 'endpoint mention'));
  const evidenceById = new Map(mentions.map(mention => [mention.evidence_id,
    requireLookup(mention.evidence_id, 'endpoint evidence')]));
  if (constraint.basis?.definition_evidence_id
    && !evidenceById.has(constraint.basis.definition_evidence_id)) {
    evidenceById.set(constraint.basis.definition_evidence_id,
      requireLookup(constraint.basis.definition_evidence_id, 'definition evidence'));
  }
  const assertions = (constraint.basis_assertion_ids || [])
    .map(id => requireLookup(id, 'basis assertion'));
  const receipts = [];
  for (const assertion of assertions) {
    if (assertion.projection_receipt_id) {
      receipts.push(requireLookup(assertion.projection_receipt_id, 'assertion projection receipt'));
    }
  }
  const reviewedDependencies = [];
  if (constraint.basis?.kind === 'prior_reviewed_resolution') {
    receipts.push(requireLookup(constraint.basis.receipt_id, 'prior reviewed resolution'));
    for (const id of constraint.basis.dependency_ids) {
      reviewedDependencies.push(requireLookup(id, 'reviewed dependency'));
    }
  }
  return buildIdentityVerificationRegistry({
    mentions,
    evidence_pointers: [...evidenceById.values()],
    assertions,
    receipts: uniqueByRecordId(receipts, 'receipt_id'),
    declaration_witnesses,
    forge_locator_identities,
    reviewed_dependencies: reviewedDependencies,
  });
}

function uniqueByRecordId(rows, idField) {
  const byId = new Map();
  for (const row of rows) byId.set(row[idField], row);
  return [...byId.values()];
}

/** Build a Referent with no mutable name, type, membership, ownership, or classification fields. */
export function buildReferent({
  identity_kind, creation_receipt_id, lifecycle_state = 'active', identity_key = null,
  ...unknown
}) {
  rejectUnknown(unknown, [], 'Referent');
  if (!identityKinds.has(identity_kind)) fail('INVALID_IDENTITY_KIND', `unsupported identity_kind ${identity_kind}`);
  requireId(creation_receipt_id, 'creation_receipt_id');
  if (!lifecycleStates.has(lifecycle_state)) fail('INVALID_REFERENT_LIFECYCLE', `unsupported lifecycle_state ${lifecycle_state}`);
  let referentId;
  if (identity_kind === 'source_native') {
    const expected = ['connector', 'native_id', 'native_version_id'];
    rejectUnknown(identity_key, expected, 'source-native identity_key');
    if (expected.some(key => !clean(identity_key?.[key]))) {
      fail('INVALID_SOURCE_NATIVE_IDENTITY', 'source-native identity requires connector, native_id, and native_version_id');
    }
    referentId = hashId('referent:source-native', identity_key);
  } else if (identity_kind === 'deterministic_namespace') {
    const expected = ['namespace_key', 'local_id'];
    rejectUnknown(identity_key, expected, 'namespace identity_key');
    if (expected.some(key => !clean(identity_key?.[key]))) {
      fail('INVALID_NAMESPACE_IDENTITY', 'deterministic namespace identity requires namespace_key and local_id');
    }
    referentId = hashId('referent:namespace', identity_key);
  } else {
    if (identity_key != null) fail('OPAQUE_IDENTITY_REHASH_INPUT', 'resolved opaque identity derives only from its first accepted receipt');
    referentId = hashId('referent:opaque', { first_accepted_receipt_id: creation_receipt_id });
  }
  return deepFreeze({
    schema: REFERENT_SCHEMA,
    referent_id: referentId,
    identity_kind,
    creation_receipt_id,
    lifecycle_state,
  });
}

export function buildIdentityConstraint({
  left, right, disposition, basis, basis_evidence_ids = [], basis_assertion_ids = [],
  source_status, valid_time = null, authority, materialization_id,
  constraint_kind = 'identity',
}) {
  requireId(left, 'left');
  requireId(right, 'right');
  if (left === right) fail('SELF_IDENTITY_CONSTRAINT', 'identity constraint endpoints must differ');
  if (!constraintDispositions.has(disposition)) fail('INVALID_IDENTITY_DISPOSITION', `unsupported constraint disposition ${disposition}`);
  if (!constraintKinds.has(constraint_kind)) fail('INVALID_IDENTITY_CONSTRAINT_KIND', `unsupported constraint_kind ${constraint_kind}`);
  if (constraint_kind !== 'identity' && disposition !== 'cannot_link') {
    fail('INVALID_COMPATIBILITY_CONSTRAINT', `${constraint_kind} compatibility constraints must block with cannot_link`);
  }
  if (!sourceStatuses.has(source_status)) fail('INVALID_SOURCE_STATUS', `unsupported source_status ${source_status}`);
  requireId(authority, 'authority');
  requireId(materialization_id, 'materialization_id');
  const evidenceIds = validateStringArray(basis_evidence_ids, 'basis_evidence_ids');
  const assertionIds = validateStringArray(basis_assertion_ids, 'basis_assertion_ids');
  let heldBasis;
  if (disposition === 'must_link') heldBasis = validatedAutomaticBasis(basis);
  else {
    if (!basis || typeof basis !== 'object' || Array.isArray(basis) || !clean(basis.kind)) {
      fail('MISSING_CONSTRAINT_BASIS', 'cannot-link and unresolved constraints require an explicit basis');
    }
    heldBasis = deepFreeze(structuredClone(basis));
  }
  if (!evidenceIds.length && !assertionIds.length && heldBasis.kind !== 'prior_reviewed_resolution') {
    fail('UNGROUNDED_IDENTITY_CONSTRAINT', 'identity constraint requires basis evidence or assertion ids');
  }
  const body = {
    schema: IDENTITY_CONSTRAINT_SCHEMA,
    left,
    right,
    disposition,
    constraint_kind,
    basis: heldBasis,
    basis_evidence_ids: evidenceIds,
    basis_assertion_ids: assertionIds,
    source_status,
    valid_time: validateValidTime(valid_time),
    authority,
    materialization_id,
  };
  return deepFreeze({ ...body, constraint_id: hashId('identity-constraint', body) });
}

/** Convenience boundary for deterministic must-link creation. */
export function buildAutomaticIdentityConstraint(input, identityVerificationRegistry = null) {
  const constraint = buildIdentityConstraint({
    ...input,
    disposition: 'must_link',
    constraint_kind: 'identity',
    authority: input.authority || (input.basis?.kind === 'prior_reviewed_resolution'
      ? 'reviewed_resolution' : 'deterministic_derivation'),
  });
  if (identityVerificationRegistry) {
    verifyIdentityConstraint(constraint, identityVerificationRegistry);
  }
  return constraint;
}

function resolutionReceiptIdentity(body) {
  // selected_referent_id is an output of the accepted decision. Excluding it breaks the otherwise
  // circular first-receipt -> opaque-referent -> receipt relation while every decision input stays
  // in receipt identity.
  const { selected_referent_id: _selectedReferentId, ...identity } = body;
  return hashId('resolution-receipt', identity);
}

const NATIVE_IDENTITY_KEY_FIELDS = Object.freeze(['connector', 'native_id', 'native_version_id']);
const NAMESPACE_IDENTITY_KEY_FIELDS = Object.freeze(['namespace_key', 'local_id']);

/** One closed identity-key shape. The shape itself determines the Referent kind, so no caller may
 * declare a kind its key cannot support. */
function validatedComponentNamespaceKey(namespaceKey) {
  if (typeof namespaceKey !== 'object' || namespaceKey == null || Array.isArray(namespaceKey)) {
    return namespaceKey;
  }
  const common = ['schema', 'basis_kind'];
  const fields = namespaceKey.basis_kind === 'parser_backed_schema'
    ? [...common, 'parser_id', 'schema_id']
    : namespaceKey.basis_kind === 'declared_namespace_identity'
      ? [...common, 'namespace_key'] : [];
  if (!fields.length || namespaceKey.schema !== COMPONENT_NAMESPACE_KEY_SCHEMA) {
    fail('INVALID_IDENTITY_KEY', 'structured namespace_key has an unsupported schema or basis kind');
  }
  rejectUnknown(namespaceKey, fields, 'component namespace_key');
  if (fields.some(field => !clean(namespaceKey[field]))) {
    fail('INVALID_IDENTITY_KEY', 'structured namespace_key contains an empty compiler field');
  }
  return namespaceKey;
}

function validatedIdentityKey(identityKey) {
  if (!identityKey || typeof identityKey !== 'object' || Array.isArray(identityKey)) {
    fail('INVALID_IDENTITY_KEY', 'identity_key must be an object');
  }
  const keys = Object.keys(identityKey).sort();
  for (const [fields, kind] of [
    [NATIVE_IDENTITY_KEY_FIELDS, 'source_native'],
    [NAMESPACE_IDENTITY_KEY_FIELDS, 'deterministic_namespace'],
  ]) {
    if (!exactEqual(keys, fields.slice().sort())) continue;
    if (kind === 'deterministic_namespace') {
      validatedComponentNamespaceKey(identityKey.namespace_key);
    }
    if (fields.some(field => !clean(identityKey[field]))) {
      fail('INVALID_IDENTITY_KEY', `${kind} identity_key requires non-empty ${fields.join(', ')}`);
    }
    return { identity_kind: kind, identity_key: deepFreeze(structuredClone(identityKey)) };
  }
  fail('INVALID_IDENTITY_KEY', 'identity_key is not a closed source-native or namespace key');
}

function identityKeyFromCompiledBasis(basis) {
  if (basis?.kind === 'parser_backed_schema') return deepFreeze({
    namespace_key: {
      schema: COMPONENT_NAMESPACE_KEY_SCHEMA,
      basis_kind: basis.kind,
      parser_id: requireId(basis.parser_id, 'candidate basis parser_id'),
      schema_id: requireId(basis.schema_id, 'candidate basis schema_id'),
    },
    local_id: requireId(basis.declared_identifier, 'candidate basis declared_identifier'),
  });
  if (basis?.kind === 'declared_namespace_identity') return deepFreeze({
    namespace_key: {
      schema: COMPONENT_NAMESPACE_KEY_SCHEMA,
      basis_kind: basis.kind,
      namespace_key: requireId(basis.namespace_key, 'candidate basis namespace_key'),
    },
    local_id: requireId(basis.declared_identifier, 'candidate basis declared_identifier'),
  });
  fail('INVALID_COMPONENT_IDENTITY_DECISION',
    `candidate basis ${basis?.kind || '<missing>'} cannot produce a deterministic namespace key`);
}

/**
 * A verifier-produced decision to mint one keyed Referent for an exact component (C4 design 4.1).
 * The resolver never derives this itself: identity keys are recomputed by the basis verifiers, and
 * this record carries them into resolution with their supporting constraint and evidence ids.
 */
export function buildComponentIdentityDecision({
  candidate_mention_ids, identity_kind, identity_key,
  identity_basis_constraint_ids = [], identity_basis_evidence_ids = [],
}) {
  const members = validateStringArray(candidate_mention_ids, 'candidate_mention_ids');
  if (!members.length) {
    fail('INVALID_COMPONENT_IDENTITY_DECISION', 'decision requires at least one candidate mention');
  }
  const held = validatedIdentityKey(identity_key);
  if (identity_kind !== held.identity_kind) {
    fail('INVALID_COMPONENT_IDENTITY_DECISION',
      `identity_kind ${identity_kind || '<missing>'} differs from the shape of its identity_key`);
  }
  const body = {
    schema: COMPONENT_IDENTITY_DECISION_SCHEMA,
    candidate_mention_ids: members,
    identity_kind,
    identity_key: held.identity_key,
    identity_basis_constraint_ids: validateStringArray(identity_basis_constraint_ids,
      'identity_basis_constraint_ids'),
    identity_basis_evidence_ids: validateStringArray(identity_basis_evidence_ids,
      'identity_basis_evidence_ids'),
  };
  return deepFreeze({ ...body, decision_id: hashId('component-identity-decision', body) });
}

export function buildResolutionReceipt({
  candidate_mention_ids, selected_referent_id = null, disposition,
  admitted_mention_ids = [], excluded_mention_ids = [], identity_constraint_ids = [],
  conflict_ids = [], supersedes_receipt_id = null, materialization_id, identity_key = null,
}) {
  if (!resolutionDispositions.has(disposition)) fail('INVALID_RESOLUTION_DISPOSITION', `unsupported resolution disposition ${disposition}`);
  requireId(materialization_id, 'materialization_id');
  const candidates = validateStringArray(candidate_mention_ids, 'candidate_mention_ids');
  const admitted = validateStringArray(admitted_mention_ids, 'admitted_mention_ids');
  const excluded = validateStringArray(excluded_mention_ids, 'excluded_mention_ids');
  const candidateSet = new Set(candidates);
  if ([...admitted, ...excluded].some(id => !candidateSet.has(id))
    || admitted.some(id => excluded.includes(id))
    || !exactEqual(exactArray([...admitted, ...excluded]), candidates)) {
    fail('INVALID_RESOLUTION_PARTITION', 'every candidate mention must be explicitly admitted or excluded exactly once');
  }
  if (disposition === 'resolved' && (!clean(selected_referent_id) || !admitted.length)) {
    fail('INVALID_RESOLVED_RECEIPT', 'resolved receipt requires a selected referent and admitted mentions');
  }
  if (disposition !== 'resolved' && selected_referent_id != null) {
    fail('INVALID_UNRESOLVED_RECEIPT', `${disposition} receipt cannot select a referent`);
  }
  const heldIdentityKey = identity_key == null ? null : validatedIdentityKey(identity_key).identity_key;
  if (heldIdentityKey && disposition !== 'resolved') {
    fail('INVALID_RESOLVED_RECEIPT', 'only a resolved receipt may bind a canonical identity key');
  }
  const body = {
    schema: RESOLUTION_RECEIPT_SCHEMA,
    candidate_mention_ids: candidates,
    selected_referent_id,
    disposition,
    admitted_mention_ids: admitted,
    excluded_mention_ids: excluded,
    identity_constraint_ids: validateStringArray(identity_constraint_ids, 'identity_constraint_ids'),
    conflict_ids: validateStringArray(conflict_ids, 'conflict_ids'),
    supersedes_receipt_id: supersedes_receipt_id == null ? null : requireId(supersedes_receipt_id, 'supersedes_receipt_id'),
    materialization_id,
    // Bound only when a keyed Referent is selected. Omitting the field entirely when absent keeps
    // every documentary and opaque receipt byte-identical to its pre-F2.3 identity.
    ...(heldIdentityKey ? { identity_key: heldIdentityKey } : {}),
  };
  return deepFreeze({ ...body, receipt_id: resolutionReceiptIdentity(body) });
}

function requiredVerificationRegistry(registry) {
  const state = identityVerificationRegistryState.get(registry);
  if (!state) {
    fail('IDENTITY_VERIFICATION_REGISTRY_REQUIRED',
      'basis truth verification requires a registry built by buildIdentityVerificationRegistry');
  }
  return state;
}

function endpointRecords(constraint, state) {
  return [constraint.left, constraint.right].map(mentionId => {
    const mention = state.mentionById.get(mentionId);
    if (!mention) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
        `constraint endpoint mention ${mentionId} does not resolve exactly once`);
    }
    const evidence = state.evidenceById.get(mention.evidence_id);
    if (!evidence) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
        `constraint endpoint ${mentionId} evidence ${mention.evidence_id} does not resolve exactly once`);
    }
    return { mention, evidence };
  });
}

function requireExactBasisSupport(constraint, evidenceIds, assertionIds = []) {
  const expectedEvidence = exactArray(evidenceIds);
  const expectedAssertions = exactArray(assertionIds);
  if (!exactEqual(constraint.basis_evidence_ids, expectedEvidence)
    || !exactEqual(constraint.basis_assertion_ids, expectedAssertions)) {
    fail('IDENTITY_BASIS_SUPPORT_MISMATCH',
      `constraint ${constraint.constraint_id} support sets differ from verifier-derived records`, {
        expected_evidence_ids: expectedEvidence,
        expected_assertion_ids: expectedAssertions,
      });
  }
}

function pointerExactValue(pointer) {
  if (pointer.kind === 'document_span') return pointer.exact_text;
  if (['repository_metadata', 'structured_record'].includes(pointer.kind)) return pointer.exact_value;
  return null;
}

function candidateBasisFromStructuredEvidence(evidence, mention = null) {
  const pointer = evidence.pointer;
  if (pointer.kind !== 'structured_record' || pointer.field_path !== '$'
    || pointer.schema_id !== 'estate-map/extracted-code-fact/v1') return null;
  if (pointer.digest !== sha256(canonical(pointer.exact_value))) {
    fail('IDENTITY_CANDIDATE_RECORD_DIGEST_MISMATCH',
      `identity candidate evidence ${evidence.evidence_id} record digest is not exact`);
  }
  const decision = identityCandidateDecision(pointer.exact_value);
  if (decision.disposition !== 'supported') {
    fail('IDENTITY_CANDIDATE_COMPILER_REFUSAL',
      `identity candidate evidence ${evidence.evidence_id} is refused by its live compiler`, {
        reason: decision.reason,
      });
  }
  if (mention && (mention.surface !== decision.surface
    || mention.namespace !== `${pointer.exact_value.repo}/${pointer.exact_value.file}`)) {
    fail('IDENTITY_BASIS_ENDPOINT_MISMATCH',
      `mention ${mention.mention_id} differs from its recompiled declaration`);
  }
  return { basis: decision.candidate_basis, surface: decision.surface, record: pointer.exact_value };
}

/** Recompile exact code-declaration evidence into the one deterministic key for a complete
 * component. Documentary members gain membership only through separately verified constraints;
 * they never supply or alter the key. The returned object is runtime-bound to this exact registry. */
export function buildVerifiedComponentIdentityDecision({
  candidate_mention_ids, declaration_mention_ids, identity_constraints = [],
}, identityVerificationRegistry) {
  const state = requiredVerificationRegistry(identityVerificationRegistry);
  const members = validateStringArray(candidate_mention_ids, 'candidate_mention_ids');
  const declarations = validateStringArray(declaration_mention_ids, 'declaration_mention_ids');
  if (!members.length || !declarations.length
    || declarations.some(mentionId => !members.includes(mentionId))) {
    fail('INVALID_COMPONENT_IDENTITY_DECISION',
      'verified decision requires declaration mentions inside one non-empty component');
  }
  const compiled = declarations.map(mentionId => {
    const mention = state.mentionById.get(mentionId);
    if (!mention) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
        `component declaration mention ${mentionId} does not resolve exactly once`);
    }
    const evidence = state.evidenceById.get(mention.evidence_id);
    if (!evidence) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
        `component declaration ${mentionId} evidence does not resolve exactly once`);
    }
    const source = candidateBasisFromStructuredEvidence(evidence, mention);
    if (!source) {
      fail('IDENTITY_CANDIDATE_COMPILER_REFUSAL',
        `component declaration ${mentionId} lacks exact structured-record evidence`);
    }
    return { mention, evidence, source };
  });
  const basis = compiled[0].source.basis;
  if (compiled.some(row => !exactEqual(row.source.basis, basis))) {
    fail('COMPONENT_IDENTITY_BASIS_DISAGREEMENT',
      'one component contains declarations that compile to different deterministic keys');
  }
  const memberSet = new Set(members);
  for (const constraint of identity_constraints) {
    if (!memberSet.has(constraint.left) || !memberSet.has(constraint.right)) {
      fail('COMPONENT_IDENTITY_DECISION_SUPPORT_MISMATCH',
        `constraint ${constraint.constraint_id} falls outside the decision component`);
    }
    verifyIdentityConstraint(constraint);
    if (constraint.disposition !== 'must_link') {
      fail('BLOCKED_COMPONENT_IDENTITY_DECISION',
        `constraint ${constraint.constraint_id} blocks deterministic component identity`);
    }
    verifyIdentityConstraint(constraint, identityVerificationRegistry);
  }
  const evidenceIds = exactArray([
    ...compiled.map(row => row.evidence.evidence_id),
    ...identity_constraints.flatMap(row => row.basis_evidence_ids || []),
  ]);
  const decision = buildComponentIdentityDecision({
    candidate_mention_ids: members,
    identity_kind: 'deterministic_namespace',
    identity_key: identityKeyFromCompiledBasis(basis),
    identity_basis_constraint_ids: identity_constraints.map(row => row.constraint_id),
    identity_basis_evidence_ids: evidenceIds,
  });
  verifiedComponentIdentityDecisionState.set(decision, {
    identityVerificationRegistry,
    declaration_mention_ids: declarations,
    candidate_basis: basis,
  });
  return decision;
}

function exactOccurrenceBridge(endpoint, source, expectedBasis) {
  if (!source || !exactEqual(source.basis, expectedBasis)) return false;
  const pointer = endpoint.evidence.pointer;
  const sourceFile = `${source.record.repo}/${source.record.file}`;
  return pointer.kind === 'document_span' && pointer.file === sourceFile
    && pointer.start === source.record.line && pointer.end === source.record.line
    && pointer.exact_text === source.surface && endpoint.mention.surface === source.surface
    && endpoint.mention.namespace === sourceFile;
}

function pinnedDocumentaryParserDeclaration(endpoint, requiredKind, expectedBasis) {
  const pointer = endpoint.evidence.pointer;
  return requiredKind === 'parser_backed_schema'
    && expectedBasis.parser_id === 'pinned-yaml-top-level-declaration@1'
    && ['$schema', '$id'].includes(expectedBasis.declared_identifier)
    && pointer.kind === 'document_span' && pointer.exact_text === expectedBasis.schema_id
    && endpoint.mention.surface === pointer.exact_text
    && endpoint.mention.namespace === pointer.file;
}

function declarationBasisForEndpoint(endpoint, state, requiredKind, expectedBasis,
  directSources) {
  const direct = candidateBasisFromStructuredEvidence(endpoint.evidence, endpoint.mention);
  if (direct) {
    if (direct.basis.kind !== requiredKind) {
      fail('IDENTITY_BASIS_ENDPOINT_MISMATCH',
        `mention ${endpoint.mention.mention_id} compiles to ${direct.basis.kind}, not ${requiredKind}`);
    }
    return direct.basis;
  }
  const witnesses = (state.declarationWitnessesByMention.get(endpoint.mention.mention_id) || [])
    .filter(row => row.candidate_basis.kind === requiredKind
      && exactEqual(row.candidate_basis, expectedBasis));
  if (witnesses.length > 1) {
    fail('UNRESOLVED_IDENTITY_DECLARATION_WITNESS',
      `mention ${endpoint.mention.mention_id} has multiple congruent ${requiredKind} witnesses`);
  }
  const witness = witnesses[0] || null;
  if (witness?.source_fact_evidence_id) {
    const sourceEvidence = state.evidenceById.get(witness.source_fact_evidence_id);
    if (!sourceEvidence) {
      fail('UNRESOLVED_IDENTITY_BASIS_RECORD',
        `declaration witness source fact ${witness.source_fact_evidence_id} does not resolve`);
    }
    const source = candidateBasisFromStructuredEvidence(sourceEvidence);
    if (witness.compiler_id !== 'identity-candidate-exact-occurrence@1'
      || !exactOccurrenceBridge(endpoint, source, expectedBasis)) {
      fail('IDENTITY_DECLARATION_WITNESS_MISMATCH',
        `declaration witness ${witness.witness_id} does not prove one exact source occurrence`);
    }
    return witness.candidate_basis;
  }
  if (witness) {
    if (witness.compiler_id !== 'pinned-yaml-top-level-declaration@1'
      || !pinnedDocumentaryParserDeclaration(endpoint, requiredKind, expectedBasis)) {
      fail('IDENTITY_DECLARATION_WITNESS_MISMATCH',
        `documentary declaration witness ${witness.witness_id} is not compiler-congruent`);
    }
    return witness.candidate_basis;
  }
  // C2 stores the authoritative endpoint records, not runtime-only witness adapters. Rebuild a
  // cross-plane declaration directly when the peer endpoint's exact structured fact compiles to
  // this basis and the documentary endpoint is the same byte-exact source occurrence.
  if (directSources.some(source => exactOccurrenceBridge(endpoint, source, expectedBasis))
    || pinnedDocumentaryParserDeclaration(endpoint, requiredKind, expectedBasis)) {
    return expectedBasis;
  }
  fail('UNRESOLVED_IDENTITY_DECLARATION_WITNESS',
    `mention ${endpoint.mention.mention_id} lacks a compiler-congruent ${requiredKind} declaration`);
}

function verifySourceEstablishedCanonicalReference(constraint, endpoints) {
  const basis = constraint.basis;
  for (const { mention, evidence } of endpoints) {
    const pointer = evidence.pointer;
    if (pointer.kind !== 'structured_record'
      || pointer.schema_id !== 'estate-map/source-established-canonical-reference/v1'
      || pointer.field_path !== '$.canonical_reference'
      || pointer.exact_value !== basis.canonical_reference
      || mention.surface !== basis.canonical_reference
      || evidence.source_version_id !== basis.source_version_id) {
      fail('CANONICAL_REFERENCE_BASIS_MISMATCH',
        `mention ${mention.mention_id} does not denote the source-established canonical reference`);
    }
  }
  return { basis, evidenceIds: endpoints.map(row => row.evidence.evidence_id), assertionIds: [] };
}

function verifyConnectorNativeId(constraint, endpoints) {
  const basis = constraint.basis;
  for (const { mention, evidence } of endpoints) {
    const pointer = evidence.pointer;
    if (pointer.kind !== 'source_native_object' || pointer.connector !== basis.connector
      || pointer.native_id !== basis.native_id
      || pointer.native_version_id !== basis.native_version_id
      || mention.surface !== basis.native_id) {
      fail('CONNECTOR_NATIVE_ID_BASIS_MISMATCH',
        `mention ${mention.mention_id} does not denote the connector-native object`);
    }
  }
  return { basis, evidenceIds: endpoints.map(row => row.evidence.evidence_id), assertionIds: [] };
}

function verifyPinnedForgeRepositoryLocator(constraint, endpoints, state) {
  const basis = constraint.basis;
  const matches = [...state.forgeByDigest.values()].filter(record => {
    const parsed = new URL(record.source_url);
    return parsed.hostname.toLocaleLowerCase() === basis.forge_host.toLocaleLowerCase()
      && record.namespace.namespace_path === basis.namespace
      && record.repository_locator.repository_locator === basis.repository_locator
      && record.source_version_id === basis.source_version_id;
  });
  if (matches.length !== 1) {
    fail('FORGE_IDENTITY_BASIS_MISMATCH',
      'forge identity basis does not resolve exactly once through verifyForgeLocatorIdentity');
  }
  const record = matches[0];
  verifyForgeLocatorIdentity(record);
  const evidenceIds = exactArray(record.assertions.flatMap(row => row.basis_evidence_ids));
  if (!exactEqual(evidenceIds, exactArray(endpoints.map(row => row.evidence.evidence_id)))) {
    fail('FORGE_IDENTITY_BASIS_MISMATCH',
      'forge locator support does not equal both endpoint evidence pointers');
  }
  return { basis, evidenceIds, assertionIds: [] };
}

function verifyCompiledDeclarationBasis(constraint, endpoints, state, kind) {
  const { source_version_id: sourceVersionId, ...basisCore } = constraint.basis;
  const directSources = endpoints.map(endpoint =>
    candidateBasisFromStructuredEvidence(endpoint.evidence, endpoint.mention)).filter(Boolean);
  const endpointBases = endpoints.map(endpoint =>
    declarationBasisForEndpoint(endpoint, state, kind, basisCore, directSources));
  if (endpointBases.some(endpointBasis => !exactEqual(endpointBasis, basisCore))) {
    fail(kind === 'parser_backed_schema' ? 'PARSER_IDENTITY_BASIS_MISMATCH'
      : 'DECLARED_NAMESPACE_BASIS_MISMATCH',
    `constraint ${constraint.constraint_id} differs from its endpoint compiler output`);
  }
  const endpointSourceVersions = exactArray(endpoints.map(row => row.evidence.source_version_id));
  if (!endpointSourceVersions.includes(sourceVersionId)) {
    fail('IDENTITY_BASIS_SOURCE_VERSION_MISMATCH',
      `constraint ${constraint.constraint_id} source version is not an endpoint source version`);
  }
  return { basis: constraint.basis,
    evidenceIds: endpoints.map(row => row.evidence.evidence_id), assertionIds: [] };
}

function verifyExactDefinedTerm(constraint, endpoints, state) {
  const basis = constraint.basis;
  const definition = state.evidenceById.get(basis.definition_evidence_id);
  if (!definition) {
    fail('EXACT_DEFINED_TERM_EVIDENCE_UNRESOLVED',
      `definition evidence ${basis.definition_evidence_id} does not resolve exactly once`);
  }
  if (!endpoints.some(row => row.evidence.evidence_id === basis.definition_evidence_id)
    || endpoints.some(({ mention, evidence }) => mention.surface !== basis.exact_term
      || mention.namespace !== basis.namespace_key
      || pointerExactValue(evidence.pointer) !== basis.exact_term)) {
    fail('EXACT_DEFINED_TERM_BASIS_MISMATCH',
      `constraint ${constraint.constraint_id} does not establish the exact term in one namespace`);
  }
  return { basis, evidenceIds: endpoints.map(row => row.evidence.evidence_id), assertionIds: [] };
}

function verifySourceCitedAlias(constraint, endpoints, state) {
  const assertionId = constraint.basis.alias_assertion_id;
  const assertion = state.assertionById.get(assertionId);
  if (!assertion) {
    fail('SOURCE_CITED_ALIAS_ASSERTION_UNRESOLVED',
      `alias assertion ${assertionId} does not resolve exactly once`);
  }
  validateClaimAssertionRecord(assertion, state.receiptById);
  const citedMentionIds = exactArray((assertion.argument_mentions || [])
    .filter(binding => binding?.mention_id).map(binding => binding.mention_id));
  const endpointMentionIds = exactArray(endpoints.map(row => row.mention.mention_id));
  if (!exactEqual(citedMentionIds, endpointMentionIds)) {
    fail('SOURCE_CITED_ALIAS_CONGRUENCE_FAILURE',
      `alias assertion ${assertionId} does not cite exactly both constraint endpoints`);
  }
  return { basis: constraint.basis,
    evidenceIds: endpoints.map(row => row.evidence.evidence_id), assertionIds: [assertionId] };
}

function verifyPriorReviewedResolution(constraint, endpoints, state) {
  const basis = constraint.basis;
  const receipt = state.receiptById.get(basis.receipt_id);
  if (!receipt || receipt.schema !== REVIEWED_RESOLUTION_RECEIPT_SCHEMA) {
    fail('STALE_REVIEWED_RESOLUTION',
      `reviewed resolution ${basis.receipt_id} and its closure do not resolve exactly once`);
  }
  const dependencies = receipt.dependency_ids.map(id => state.dependencyById.get(id));
  if (dependencies.some(row => !row)) {
    fail('STALE_REVIEWED_RESOLUTION',
      `reviewed resolution ${basis.receipt_id} has an unresolved dependency`);
  }
  const expected = buildReviewedResolutionReceipt({
    endpoint_mention_ids: receipt.endpoint_mention_ids,
    dependencies,
    selected_head_ids: receipt.selected_head_ids,
    review_authority_id: receipt.review_authority_id,
  });
  if (!exactEqual(receipt, expected)
    || !exactEqual(receipt.endpoint_mention_ids,
      exactArray(endpoints.map(row => row.mention.mention_id)))
    || !exactEqual(basis.dependency_ids, receipt.dependency_ids)) {
    fail('STALE_REVIEWED_RESOLUTION',
      `reviewed resolution ${basis.receipt_id} dependency closure changed`);
  }
  return { basis, evidenceIds: [], assertionIds: [] };
}

function verifyAutomaticBasisTruth(constraint, registry) {
  const state = requiredVerificationRegistry(registry);
  const endpoints = endpointRecords(constraint, state);
  let verified;
  switch (constraint.basis.kind) {
    case 'source_established_canonical_reference':
      verified = verifySourceEstablishedCanonicalReference(constraint, endpoints); break;
    case 'connector_native_id':
      verified = verifyConnectorNativeId(constraint, endpoints); break;
    case 'pinned_forge_repository_locator':
      verified = verifyPinnedForgeRepositoryLocator(constraint, endpoints, state); break;
    case 'parser_backed_schema':
      verified = verifyCompiledDeclarationBasis(constraint, endpoints, state,
        'parser_backed_schema'); break;
    case 'declared_namespace_identity':
      verified = verifyCompiledDeclarationBasis(constraint, endpoints, state,
        'declared_namespace_identity'); break;
    case 'exact_defined_term_identity':
      verified = verifyExactDefinedTerm(constraint, endpoints, state); break;
    case 'source_cited_alias':
      verified = verifySourceCitedAlias(constraint, endpoints, state); break;
    case 'prior_reviewed_resolution':
      verified = verifyPriorReviewedResolution(constraint, endpoints, state); break;
    default:
      fail('UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS',
        `unsupported automatic identity basis ${constraint.basis.kind}`);
  }
  requireExactBasisSupport(constraint, verified.evidenceIds, verified.assertionIds);
  if (!exactEqual(constraint.basis, verified.basis)) {
    fail('IDENTITY_BASIS_CANONICAL_BODY_MISMATCH',
      `constraint ${constraint.constraint_id} basis differs from verifier output`);
  }
  return verified.basis;
}

function validateConstraintIdentity(constraint) {
  const { constraint_id: constraintId, ...body } = constraint;
  if (constraint.schema !== IDENTITY_CONSTRAINT_SCHEMA
    || constraintId !== hashId('identity-constraint', body)) {
    fail('INVALID_IDENTITY_CONSTRAINT', `constraint ${constraintId || '<missing>'} has invalid identity`);
  }
}

/**
 * The single closed intake boundary for identity constraints (C4 design section 3.1).
 *
 * A recomputed content-addressed constraint_id is necessary but never sufficient: any caller can
 * hand-write a record carrying an inadmissible basis and hash it correctly. This rebuilds the
 * record through the same closed constructor the producer must use, so a basis the constructor
 * would refuse is rejected here — with UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS for a non-eight-basis
 * must_link — and any field the constructor normalizes differently is caught by exact comparison.
 *
 * Invoked before component adjacency is assembled, so a forged edge can never reach resolution.
 */
export function verifyIdentityConstraint(constraint, identityVerificationRegistry = null) {
  if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) {
    fail('INVALID_IDENTITY_CONSTRAINT', 'identity constraint must be an object');
  }
  validateConstraintIdentity(constraint);
  const rebuilt = buildIdentityConstraint({
    left: constraint.left,
    right: constraint.right,
    disposition: constraint.disposition,
    constraint_kind: constraint.constraint_kind,
    basis: constraint.basis,
    basis_evidence_ids: constraint.basis_evidence_ids,
    basis_assertion_ids: constraint.basis_assertion_ids,
    source_status: constraint.source_status,
    valid_time: constraint.valid_time,
    authority: constraint.authority,
    materialization_id: constraint.materialization_id,
  });
  if (!exactEqual(constraint, rebuilt)) {
    fail('INVALID_IDENTITY_CONSTRAINT',
      `constraint ${constraint.constraint_id} differs from its closed constructor output`);
  }
  if (constraint.disposition === 'must_link' && identityVerificationRegistry) {
    verifyAutomaticBasisTruth(constraint, identityVerificationRegistry);
  }
  return true;
}

function candidateComponents(mentionIds, constraints) {
  const adjacency = new Map(mentionIds.map(id => [id, new Set()]));
  for (const constraint of constraints) {
    if (constraint.disposition !== 'must_link') continue;
    adjacency.get(constraint.left).add(constraint.right);
    adjacency.get(constraint.right).add(constraint.left);
  }
  const visited = new Set();
  const components = [];
  for (const start of mentionIds) {
    if (visited.has(start)) continue;
    const pending = [start];
    const members = [];
    visited.add(start);
    while (pending.length) {
      const held = pending.pop();
      members.push(held);
      for (const neighbor of adjacency.get(held)) if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(members.sort());
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function validatedComponents(components, constraints) {
  return components.map(members => {
    const memberSet = new Set(members);
    const held = constraints.filter(row => memberSet.has(row.left) && memberSet.has(row.right));
    const blockers = held.filter(row => row.disposition !== 'must_link'
      || ['namespace', 'type', 'incompatible_time'].includes(row.constraint_kind));
    return { members, constraints: held, blockers };
  });
}

function existingResolution(component, priorReceipts) {
  const rows = priorReceipts.filter(receipt => receipt.disposition === 'resolved'
    && receipt.admitted_mention_ids.some(id => component.members.includes(id)));
  const selected = exactArray(rows.map(row => row.selected_referent_id));
  if (selected.length > 1) return { conflict: selected, receipt: null, selected_referent_id: null };
  const receipt = rows.slice().sort((left, right) => left.receipt_id.localeCompare(right.receipt_id))[0] || null;
  return { conflict: [], receipt, selected_referent_id: selected[0] || null };
}

/**
 * Resolve complete candidate components. The two map passes are intentional: every whole component
 * is validated and blockers are materialized before any transitive resolution is admitted.
 */
export function resolveIdentityComponents({
  mention_ids, identity_constraints, materialization_id, prior_resolution_receipts = [],
  prior_referents = [], identity_verification_registry = null,
  component_identity_decisions = [],
}) {
  const mentionIds = validateStringArray(mention_ids, 'mention_ids');
  requireId(materialization_id, 'materialization_id');
  const mentionSet = new Set(mentionIds);
  const constraints = (identity_constraints || []).slice().sort((a, b) => a.constraint_id.localeCompare(b.constraint_id));
  const constraintIds = new Set();
  for (const constraint of constraints) {
    // Structural replay runs first so a forged unsupported basis receives its exact B1 failure;
    // every otherwise-admissible must_link then requires full truth verification before adjacency.
    verifyIdentityConstraint(constraint);
    if (constraint.disposition === 'must_link') {
      requiredVerificationRegistry(identity_verification_registry);
      verifyIdentityConstraint(constraint, identity_verification_registry);
    }
    if (constraintIds.has(constraint.constraint_id)) fail('DUPLICATE_IDENTITY_CONSTRAINT', `duplicate ${constraint.constraint_id}`);
    constraintIds.add(constraint.constraint_id);
    if (!mentionSet.has(constraint.left) || !mentionSet.has(constraint.right)) {
      fail('IDENTITY_CONSTRAINT_OUTSIDE_COMPONENT_SET', `constraint ${constraint.constraint_id} cites an unknown mention`);
    }
  }
  const priorReceiptById = new Map(prior_resolution_receipts.map(row => [row.receipt_id, row]));
  const priorReferentById = new Map(prior_referents.map(row => [row.referent_id, row]));
  if (priorReceiptById.size !== prior_resolution_receipts.length || priorReferentById.size !== prior_referents.length) {
    fail('DUPLICATE_PRIOR_IDENTITY_RECORD', 'prior identity records must have unique ids');
  }

  const decisionByComponent = new Map();
  for (const decision of component_identity_decisions) {
    const expected = buildComponentIdentityDecision(decision);
    if (!exactEqual(decision, expected)) {
      fail('INVALID_COMPONENT_IDENTITY_DECISION',
        `component identity decision ${decision?.decision_id || '<missing>'} differs from its producer`);
    }
    const verification = verifiedComponentIdentityDecisionState.get(decision);
    if (!verification || verification.identityVerificationRegistry !== identity_verification_registry) {
      fail('IDENTITY_COMPONENT_DECISION_VERIFICATION_REQUIRED',
        `component identity decision ${decision.decision_id} was not issued against this exact registry`);
    }
    const key = canonical(decision.candidate_mention_ids);
    if (decisionByComponent.has(key)) {
      fail('DUPLICATE_COMPONENT_IDENTITY_DECISION',
        'one component cannot carry two identity decisions');
    }
    if (decision.candidate_mention_ids.some(id => !mentionSet.has(id))) {
      fail('COMPONENT_IDENTITY_DECISION_OUTSIDE_COMPONENT_SET',
        `decision ${decision.decision_id} cites an unknown mention`);
    }
    decisionByComponent.set(key, decision);
  }

  const candidates = candidateComponents(mentionIds, constraints);
  const validated = validatedComponents(candidates, constraints);
  const componentKeys = new Set(validated.map(component => canonical(component.members)));
  for (const key of decisionByComponent.keys()) if (!componentKeys.has(key)) {
    fail('COMPONENT_IDENTITY_DECISION_UNMATCHED',
      'every identity decision must name an exact resolved component member set');
  }
  const conflicts = [];
  const componentPlans = validated.map(component => {
    const existing = existingResolution(component, prior_resolution_receipts);
    const blockers = component.blockers.slice();
    if (existing.conflict.length) blockers.push({
      constraint_id: hashId('prior-referent-conflict', { members: component.members, referent_ids: existing.conflict }),
      constraint_kind: 'identity',
      disposition: 'cannot_link',
    });
    const componentConflicts = blockers.map(blocker => {
      const body = {
        schema: IDENTITY_CONFLICT_SCHEMA,
        candidate_mention_ids: component.members,
        blocking_constraint_id: blocker.constraint_id,
        blocking_kind: blocker.constraint_kind,
        materialization_id,
      };
      const conflict = deepFreeze({ ...body, conflict_id: hashId('identity-conflict', body) });
      conflicts.push(conflict);
      return conflict;
    });
    return { ...component, existing, conflicts: componentConflicts };
  });

  const receipts = [];
  const referents = new Map(prior_referents.map(row => [row.referent_id, row]));
  const mentionResolutions = [];
  const components = [];
  for (const component of componentPlans) {
    const constraintIds_ = component.constraints.map(row => row.constraint_id).sort();
    // A verifier-produced decision is what makes a valid singleton resolvable. Without one the
    // historical rule stands: a lone declaration never receives an opaque fallback Referent.
    const decision = component.conflicts.length ? null
      : decisionByComponent.get(canonical(component.members)) || null;
    if (!decision && component.members.length === 1 && !component.existing.selected_referent_id) {
      const receipt = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        disposition: 'unresolved',
        excluded_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        materialization_id,
      });
      receipts.push(receipt);
      components.push(deepFreeze({
        candidate_mention_ids: component.members,
        status: 'unresolved',
        blocking_constraint_ids: [],
        conflict_ids: [],
        resolution_receipt_id: receipt.receipt_id,
        selected_referent_id: null,
      }));
      continue;
    }
    if (component.conflicts.length) {
      const receipt = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        disposition: 'unresolved',
        excluded_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        conflict_ids: component.conflicts.map(row => row.conflict_id),
        supersedes_receipt_id: component.existing.receipt?.receipt_id || null,
        materialization_id,
      });
      receipts.push(receipt);
      components.push(deepFreeze({
        candidate_mention_ids: component.members,
        status: 'blocked',
        blocking_constraint_ids: component.conflicts.map(row => row.blocking_constraint_id).sort(),
        conflict_ids: component.conflicts.map(row => row.conflict_id).sort(),
        resolution_receipt_id: receipt.receipt_id,
        selected_referent_id: null,
      }));
      continue;
    }

    let selectedReferentId = component.existing.selected_referent_id;
    let receipt;
    if (decision) {
      // A keyed Referent derives its id from the canonical identity key alone, so it can be named
      // before its creation receipt exists without the opaque path's seed/rehash cycle.
      const keyedReferentId = buildReferent({
        identity_kind: decision.identity_kind,
        creation_receipt_id: 'resolution-receipt:pending-keyed-creation',
        identity_key: decision.identity_key,
      }).referent_id;
      if (selectedReferentId && selectedReferentId !== keyedReferentId) {
        fail('COMPONENT_IDENTITY_DECISION_CONFLICT',
          `decision ${decision.decision_id} contradicts the prior selected referent`);
      }
      receipt = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        selected_referent_id: keyedReferentId,
        disposition: 'resolved',
        admitted_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        supersedes_receipt_id: component.existing.receipt?.receipt_id || null,
        materialization_id,
        identity_key: decision.identity_key,
      });
      const referent = buildReferent({
        identity_kind: decision.identity_kind,
        creation_receipt_id: receipt.receipt_id,
        identity_key: decision.identity_key,
      });
      if (referent.referent_id !== keyedReferentId) {
        fail('KEYED_REFERENT_IDENTITY_DRIFT', 'keyed referent identity changed with its receipt');
      }
      selectedReferentId = referent.referent_id;
      referents.set(referent.referent_id, referent);
    } else if (selectedReferentId) {
      if (!priorReferentById.has(selectedReferentId)) {
        fail('MISSING_PRIOR_OPAQUE_REFERENT', `prior resolution selects missing referent ${selectedReferentId}`);
      }
      receipt = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        selected_referent_id: selectedReferentId,
        disposition: 'resolved',
        admitted_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        supersedes_receipt_id: component.existing.receipt.receipt_id,
        materialization_id,
      });
    } else {
      const seed = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        selected_referent_id: 'referent:pending-first-accepted-receipt',
        disposition: 'resolved',
        admitted_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        materialization_id,
      });
      const referent = buildReferent({
        identity_kind: 'resolved_opaque',
        creation_receipt_id: seed.receipt_id,
      });
      selectedReferentId = referent.referent_id;
      receipt = buildResolutionReceipt({
        candidate_mention_ids: component.members,
        selected_referent_id: selectedReferentId,
        disposition: 'resolved',
        admitted_mention_ids: component.members,
        identity_constraint_ids: constraintIds_,
        materialization_id,
      });
      if (receipt.receipt_id !== seed.receipt_id) fail('OPAQUE_RECEIPT_ID_CYCLE', 'selected referent changed receipt identity');
      referents.set(referent.referent_id, referent);
    }
    receipts.push(receipt);
    for (const mentionId of component.members) mentionResolutions.push(deepFreeze({
      mention_id: mentionId,
      referent_id: selectedReferentId,
      resolution_receipt_id: receipt.receipt_id,
    }));
    components.push(deepFreeze({
      candidate_mention_ids: component.members,
      status: 'resolved',
      blocking_constraint_ids: [],
      conflict_ids: [],
      resolution_receipt_id: receipt.receipt_id,
      selected_referent_id: selectedReferentId,
    }));
  }
  const body = {
    schema: IDENTITY_RESOLUTION_SCHEMA,
    materialization_id,
    mention_ids: mentionIds,
    identity_constraint_ids: constraints.map(row => row.constraint_id),
    components,
    conflicts: conflicts.sort((a, b) => a.conflict_id.localeCompare(b.conflict_id)),
    referents: [...referents.values()].sort((a, b) => a.referent_id.localeCompare(b.referent_id)),
    resolution_receipts: receipts.sort((a, b) => a.receipt_id.localeCompare(b.receipt_id)),
    mention_resolutions: mentionResolutions.sort((a, b) => a.mention_id.localeCompare(b.mention_id)),
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyIdentityResolution(input) {
  const expected = resolveIdentityComponents({
    mention_ids: input.mention_ids,
    identity_constraints: input.identity_constraints,
    materialization_id: input.resolution.materialization_id,
    prior_resolution_receipts: input.prior_resolution_receipts || [],
    prior_referents: input.prior_referents || [],
    identity_verification_registry: input.identity_verification_registry || null,
    component_identity_decisions: input.component_identity_decisions || [],
  });
  if (!exactEqual(input.resolution, expected)) {
    fail('IDENTITY_RESOLUTION_MISMATCH', 'identity resolution differs from whole-component validation');
  }
  return true;
}

export function buildIdentityLifecycleRecord({
  event, subject_referent_id, related_referent_ids = [], superseded_by_referent_id = null,
  basis_evidence_ids = [], basis_assertion_ids = [], basis_receipt_ids = [], valid_time,
  recorded_time, materialization_id,
}) {
  if (!lifecycleEvents.has(event)) fail('INVALID_IDENTITY_LIFECYCLE_EVENT', `unsupported lifecycle event ${event}`);
  requireId(subject_referent_id, 'subject_referent_id');
  requireId(recorded_time, 'recorded_time');
  requireId(materialization_id, 'materialization_id');
  const related = validateStringArray(related_referent_ids, 'related_referent_ids');
  const evidence = validateStringArray(basis_evidence_ids, 'basis_evidence_ids');
  const assertions = validateStringArray(basis_assertion_ids, 'basis_assertion_ids');
  const receipts = validateStringArray(basis_receipt_ids, 'basis_receipt_ids');
  if (!evidence.length && !assertions.length && !receipts.length) {
    fail('UNGROUNDED_IDENTITY_LIFECYCLE', 'identity lifecycle record requires evidence, assertions, or receipts');
  }
  if (['merge', 'successor', 'deprecation'].includes(event) && !clean(superseded_by_referent_id)) {
    fail('MISSING_EXPLICIT_SUPERSESSION', `${event} requires superseded_by_referent_id`);
  }
  if (event === 'split' && related.length < 2) fail('INVALID_IDENTITY_SPLIT', 'split requires at least two successor referents');
  const body = {
    schema: IDENTITY_LIFECYCLE_RECORD_SCHEMA,
    event,
    subject_referent_id,
    related_referent_ids: related,
    superseded_by_referent_id,
    basis_evidence_ids: evidence,
    basis_assertion_ids: assertions,
    basis_receipt_ids: receipts,
    valid_time: validateValidTime(valid_time),
    recorded_time,
    materialization_id,
  };
  return deepFreeze({ ...body, lifecycle_record_id: hashId('identity-lifecycle', body) });
}

export function buildIdentityLedger({ referents = [], constraints = [], receipts = [], lifecycle_records = [] } = {}) {
  const body = {
    schema: IDENTITY_LEDGER_SCHEMA,
    referents: referents.slice(),
    constraints: constraints.slice(),
    receipts: receipts.slice(),
    lifecycle_records: lifecycle_records.slice(),
  };
  for (const [label, rows, key] of [
    ['referents', body.referents, 'referent_id'],
    ['constraints', body.constraints, 'constraint_id'],
    ['receipts', body.receipts, 'receipt_id'],
    ['lifecycle_records', body.lifecycle_records, 'lifecycle_record_id'],
  ]) {
    if (new Set(rows.map(row => row[key])).size !== rows.length) fail('DUPLICATE_IDENTITY_LEDGER_ID', `${label} contain duplicate ids`);
  }
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

export function appendIdentityLedger(previous, additions = {}) {
  if (previous?.schema !== IDENTITY_LEDGER_SCHEMA) fail('INVALID_IDENTITY_LEDGER', 'append requires a prior identity ledger');
  return buildIdentityLedger({
    referents: [...previous.referents, ...(additions.referents || [])],
    constraints: [...previous.constraints, ...(additions.constraints || [])],
    receipts: [...previous.receipts, ...(additions.receipts || [])],
    lifecycle_records: [...previous.lifecycle_records, ...(additions.lifecycle_records || [])],
  });
}

export function verifyAppendOnlyIdentityLedger({ previous, next }) {
  for (const field of ['referents', 'constraints', 'receipts', 'lifecycle_records']) {
    if (next[field].length < previous[field].length
      || !exactEqual(next[field].slice(0, previous[field].length), previous[field])) {
      fail('IDENTITY_LEDGER_HISTORY_CHANGED', `${field} history was mutated, deleted, or reordered`);
    }
  }
  return true;
}

export function resolveSupersededReferent({ referent_id, lifecycle_records }) {
  requireId(referent_id, 'referent_id');
  const supersessions = new Map();
  for (const record of lifecycle_records || []) {
    if (!record.superseded_by_referent_id) continue;
    if (supersessions.has(record.subject_referent_id)
      && supersessions.get(record.subject_referent_id) !== record.superseded_by_referent_id) {
      fail('AMBIGUOUS_REFERENT_SUPERSESSION', `referent ${record.subject_referent_id} has multiple supersession targets`);
    }
    supersessions.set(record.subject_referent_id, record.superseded_by_referent_id);
  }
  const chain = [referent_id];
  while (supersessions.has(chain.at(-1))) {
    const next = supersessions.get(chain.at(-1));
    if (chain.includes(next)) fail('REFERENT_SUPERSESSION_CYCLE', 'referent supersession chain is cyclic');
    chain.push(next);
  }
  return deepFreeze({ requested_referent_id: referent_id, selected_referent_id: chain.at(-1), supersession_chain: chain });
}

/** Parse pinned forge locator identity without inferring account kind, ownership, fork, or mirror. */
export function buildForgeLocatorIdentity({
  url, source_version_id, basis_evidence_ids, source_status = 'current', valid_time = null,
  assertion_schema_version = 'forge-locator-assertion@1',
}) {
  requireId(source_version_id, 'source_version_id');
  if (!sourceStatuses.has(source_status)) fail('INVALID_SOURCE_STATUS', `unsupported source_status ${source_status}`);
  const evidenceIds = validateStringArray(basis_evidence_ids, 'basis_evidence_ids');
  if (!evidenceIds.length) fail('UNGROUNDED_FORGE_LOCATOR', 'forge locator requires pinned evidence');
  let parsed;
  try { parsed = new URL(url); }
  catch { fail('INVALID_FORGE_URL', 'forge locator requires a valid URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('INVALID_FORGE_URL', 'forge locator requires an HTTP(S) URL without credentials');
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (segments.length < 2 || segments.some(segment => !clean(segment) || segment === '.' || segment === '..')) {
    fail('INVALID_FORGE_REPOSITORY_LOCATOR', 'forge URL requires a namespace path and repository segment');
  }
  const repository = segments.at(-1).replace(/\.git$/u, '');
  const namespacePath = segments.slice(0, -1).join('/');
  if (!repository) fail('INVALID_FORGE_REPOSITORY_LOCATOR', 'forge repository segment is empty');
  const namespace = deepFreeze({
    namespace_key: `forge:${parsed.hostname.toLocaleLowerCase()}`,
    namespace_path: namespacePath,
  });
  const repositoryLocator = deepFreeze({
    namespace_key: namespace.namespace_key,
    namespace_path: namespace.namespace_path,
    repository_locator: repository,
  });
  const assertionBody = {
    schema: LOCATOR_ASSERTION_SCHEMA,
    assertion_schema_version,
    predicate: 'hosted_under',
    arguments: [
      { role: 'subject', repository_locator: repositoryLocator },
      { role: 'object', namespace_locator: namespace },
    ],
    basis_evidence_ids: evidenceIds,
    source_version_id,
    source_status,
    valid_time: validateValidTime(valid_time),
  };
  const assertion = deepFreeze({ ...assertionBody, assertion_id: hashId('locator-assertion', assertionBody) });
  const body = {
    schema: FORGE_LOCATOR_IDENTITY_SCHEMA,
    source_url: parsed.href,
    source_version_id,
    namespace,
    repository_locator: repositoryLocator,
    assertions: [assertion],
    account_kind: null,
    ownership: null,
    fork_status: null,
    mirror_status: null,
  };
  return deepFreeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyForgeLocatorIdentity(record) {
  const expected = buildForgeLocatorIdentity({
    url: record.source_url,
    source_version_id: record.source_version_id,
    basis_evidence_ids: record.assertions?.[0]?.basis_evidence_ids || [],
    source_status: record.assertions?.[0]?.source_status,
    valid_time: record.assertions?.[0]?.valid_time,
    assertion_schema_version: record.assertions?.[0]?.assertion_schema_version,
  });
  if (!exactEqual(record, expected)) {
    fail('FORGE_PATH_INFERENCE', 'forge path may establish only locator identity and hosted_under');
  }
  return true;
}
