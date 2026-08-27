// Canonical, model-free record envelopes for Step-3 campaign artifacts.
// Implements progressive-map-generation Step-3 §§4.2, 5.1–5.4, 6.2–6.7, 11.2, 12.2.
import { sha256, stableStringify } from './lib.mjs';

export const ADJUDICATION_SCHEMA_VERSION = 'estate-map/adjudication-record/v1';
// The ratified documentary-claim contract version (DESIGN §16.12.1). It is an input to
// claim_attempt_key, so bumping it invalidates staged claim attempts.
export const CLAIM_SCHEMA_VERSION = 'estate-map/documentary-claim/v2';
export const RECORD_KINDS = Object.freeze([
  'campaign_contract', 'candidate_packet', 'normalized_proposition', 'claim_candidate',
  'action_request', 'execution_receipt', 'side_verification_receipt',
  'verification_aggregate', 'ratification_receipt', 'replay_receipt',
  'resolution_record', 'obligation_record',
  'claim', 'concept', 'relation', 'alignment', 'evidence', 'resolution',
]);

// FOLLOW-UP (DEFERRED, not half-migrated): the carried task to namespace these bare tokens to
// census_* is DEFERRED this slice with a typed reason. Renaming them here would break the landed
// producers/consumers that read/emit the bare tokens on the SAME snapshot with no shim:
//   - neural-census.mjs:116        `record.record_kind === 'claim'`
//   - neural-census.mjs (funnel)   `record.record_kind === 'alignment' | 'resolution' | 'evidence'`
//   - neural-census-producers.mjs  `createRecord('claim', ...)`, `record.record_kind === 'claim'`
//   - campaign.mjs                 `type: 'claim'` rows
// A clean rename requires migrating every producer + consumer + their fixtures atomically, which is
// its own migration slice; doing only the enum here would be exactly the half-migration this slice
// forbids. Tracked to the extraction-wiring slice where the producers are rewritten anyway.
// FOLLOW-UP-CODE: CENSUS_RECORD_KIND_NAMESPACING (defer-reason: would break landed bare-token
// producers/consumers; requires atomic producer+consumer migration).
export const NEURAL_CENSUS_RECORD_KINDS = Object.freeze([
  'claim', 'concept', 'relation', 'alignment', 'evidence', 'resolution',
]);
// Snapshot-binding + model provenance envelope shared by every neural-census record kind.
// This is the observation-ledger discipline (source_sha/corpus_digest/snapshot_sha binding
// plus generator/prompt/model provenance), NOT the semantic "claim contract".
const NEURAL_CENSUS_PROVENANCE_FIELDS = Object.freeze([
  'source_sha', 'corpus_digest', 'generator_digest', 'prompt_digest', 'model_identifier',
  'producer_version',
]);
// The sibling census kinds (concept/relation/alignment/evidence/resolution) retain the prior
// generic semantic envelope until their own ledger slices land. Only the `claim` kind carries
// the ratified documentary-claim contract below — there is exactly one live *claim* contract.
const NEURAL_CENSUS_SIBLING_SEMANTIC_FIELDS = Object.freeze([
  'spans', 'subject', 'predicate', 'polarity', 'modality', 'quantifier', 'scope', 'lineage',
]);

// Ratified documentary-claim contract (DESIGN §16.12.1 / preregistration §4). This REPLACES the
// old Task-2b scaffolding claim contract (subject/predicate/scope-string/modality-old/lineage).
export const CLAIM_MODALITIES = Object.freeze([
  'descriptive', 'normative', 'constitutive', 'predictive', 'historical', 'interpretive',
]);
export const CLAIM_SCOPE_FIELDS = Object.freeze([
  'repository', 'component', 'environment', 'version_or_branch', 'actor',
]);
const CLAIM_RATIFIED_FIELDS = Object.freeze([
  'subject_refs', 'predicate_family', 'object_or_value', 'polarity', 'modality', 'quantifier',
  'scope', 'valid_time', 'provenance',
]);
// The documentary-claim ledger stamps these; a caller-supplied value in the semantic plane is a
// provenance-injection attempt and is rejected at the contract boundary (mirrors the ledger's
// self-controlled position/audit discipline).
export const LEDGER_CONTROLLED_FIELDS = Object.freeze([
  'ledger_seq', 'ledger_position', 'prev_content_hash', 'appended_at',
]);

const isBlank = value => value === undefined || value === null || value === '';

function assertClaimSemantic(semantic) {
  const missingProvenance = NEURAL_CENSUS_PROVENANCE_FIELDS.concat('snapshot_sha').filter(field => isBlank(semantic[field]));
  if (missingProvenance.length) throw new Error(`documentary claim is missing required binding/provenance field(s): ${missingProvenance.join(', ')}`);
  const reserved = LEDGER_CONTROLLED_FIELDS.filter(field => Object.hasOwn(semantic, field));
  if (reserved.length) throw new Error(`documentary claim may not carry caller-supplied ledger provenance: ${reserved.sort().join(', ')}`);
  const missing = CLAIM_RATIFIED_FIELDS.filter(field => isBlank(semantic[field]));
  if (missing.length) throw new Error(`documentary claim is missing ratified field(s): ${missing.join(', ')}`);
  if (!Array.isArray(semantic.subject_refs) || !semantic.subject_refs.length) throw new Error('documentary claim requires non-empty subject_refs');
  if (typeof semantic.predicate_family !== 'string' || !semantic.predicate_family) throw new Error('documentary claim requires a predicate_family string');
  if (typeof semantic.polarity !== 'string' || !semantic.polarity) throw new Error('documentary claim requires a polarity string');
  if (!CLAIM_MODALITIES.includes(semantic.modality)) throw new Error(`documentary claim modality must be one of ${CLAIM_MODALITIES.join('|')}`);
  if (typeof semantic.quantifier !== 'string' || !semantic.quantifier) throw new Error('documentary claim requires a quantifier string');
  const scope = semantic.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('documentary claim scope must be an object');
  const missingScope = CLAIM_SCOPE_FIELDS.filter(field => !Object.hasOwn(scope, field));
  if (missingScope.length) throw new Error(`documentary claim scope is missing sub-field(s): ${missingScope.join(', ')}`);
  const unknownScope = Object.keys(scope).filter(field => !CLAIM_SCOPE_FIELDS.includes(field));
  if (unknownScope.length) throw new Error(`documentary claim scope has unknown sub-field(s): ${unknownScope.sort().join(', ')}`);
  const validTime = semantic.valid_time;
  if (!validTime || typeof validTime !== 'object' || Array.isArray(validTime) || !Object.hasOwn(validTime, 'from') || !Object.hasOwn(validTime, 'until')) {
    throw new Error('documentary claim valid_time must be an object with {from, until}');
  }
  const provenance = semantic.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('documentary claim provenance must be an object');
  if (isBlank(provenance.document_id)) throw new Error('documentary claim provenance requires document_id');
  if (isBlank(provenance.revision_id)) throw new Error('documentary claim provenance requires revision_id');
  if (!Array.isArray(provenance.spans) || !provenance.spans.length) throw new Error('documentary claim provenance requires non-empty spans');
  if (!semantic.disposition || typeof semantic.disposition !== 'object' || Array.isArray(semantic.disposition) || typeof semantic.disposition.kind !== 'string' || !semantic.disposition.kind) {
    throw new Error('documentary claim requires typed disposition.kind');
  }
}

// These fields describe execution/audit, not semantic meaning. They never affect a stable
// identity, including when nested in a producer-provided payload.
export const SEMANTICALLY_EXCLUDED_FIELDS = Object.freeze([
  'audit', 'audit_timestamp', 'created_at', 'generated_at', 'ingested_at', 'observed_at',
  'updated_at', 'latency_ms', 'cost', 'cost_usd', 'token_count', 'tokens',
]);
const ENVELOPE_FIELDS = new Set(['schema_version', 'record_kind', 'id', 'semantic', 'audit']);

const canonicalValue = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical records cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (value[key] === undefined) throw new Error(`canonical record contains undefined field: ${key}`);
    return [key, canonicalValue(value[key])];
  }));
  throw new Error(`canonical records cannot contain ${typeof value}`);
};

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function assertNeuralCensusSemantic(recordKind, semantic) {
  if (!NEURAL_CENSUS_RECORD_KINDS.includes(recordKind)) return;
  if (recordKind === 'claim') { assertClaimSemantic(semantic); return; }
  const required = NEURAL_CENSUS_PROVENANCE_FIELDS.concat(NEURAL_CENSUS_SIBLING_SEMANTIC_FIELDS);
  const missing = required.filter(field => semantic[field] === undefined || semantic[field] === null || semantic[field] === '');
  if (missing.length) throw new Error(`neural census ${recordKind} is missing required provenance field(s): ${missing.join(', ')}`);
  if (!Array.isArray(semantic.spans) || !semantic.spans.length) throw new Error(`neural census ${recordKind} requires non-empty provenance spans`);
  if (!semantic.disposition || typeof semantic.disposition !== 'object' || Array.isArray(semantic.disposition) || typeof semantic.disposition.kind !== 'string' || !semantic.disposition.kind) {
    throw new Error(`neural census ${recordKind} requires typed disposition.kind`);
  }
}

/** Byte-stable UTF-8 JSON serialization. */
export function canonicalSerialize(value) {
  return `${stableStringify(canonicalValue(value))}\n`;
}

/** Remove audit-only values recursively before hashing semantic content. */
export function semanticProjection(value) {
  if (Array.isArray(value)) return value.map(semanticProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => (
    SEMANTICALLY_EXCLUDED_FIELDS.includes(key) ? [] : [[key, semanticProjection(value[key])]]
  )));
}

export function semanticHash(value) {
  return sha256(canonicalSerialize(semanticProjection(value)));
}

export function stableId(recordKind, semantic) {
  assertRecordKind(recordKind);
  return `${recordKind}:${semanticHash({ record_kind: recordKind, semantic })}`;
}

export function assertRecordKind(recordKind) {
  if (!RECORD_KINDS.includes(recordKind)) throw new Error(`unregistered adjudication record kind: ${recordKind}`);
}

/**
 * Creates the strict envelope used by every WP1 record family. Audit remains durable but is
 * deliberately excluded from id/hash calculations (spec §5.1 and §9.4 cost rule).
 */
export function createRecord(recordKind, semantic, audit = {}) {
  assertRecordKind(recordKind);
  const canonicalSemantic = canonicalValue(semantic);
  assertNeuralCensusSemantic(recordKind, canonicalSemantic);
  return deepFreeze({
    schema_version: ADJUDICATION_SCHEMA_VERSION,
    record_kind: recordKind,
    id: stableId(recordKind, canonicalSemantic),
    semantic: canonicalSemantic,
    audit: canonicalValue(audit),
  });
}

/** Strict envelope validation; unknown top-level fields are quarantine failures. */
export function validateRecord(record, { expectedKind = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('adjudication record must be an object');
  const unknown = Object.keys(record).filter(key => !ENVELOPE_FIELDS.has(key));
  if (unknown.length) throw new Error(`adjudication record has unknown field(s): ${unknown.sort().join(', ')}`);
  for (const key of ['schema_version', 'record_kind', 'id', 'semantic', 'audit']) {
    if (!(key in record)) throw new Error(`adjudication record is missing ${key}`);
  }
  if (record.schema_version !== ADJUDICATION_SCHEMA_VERSION) throw new Error(`unsupported adjudication schema: ${record.schema_version}`);
  assertRecordKind(record.record_kind);
  if (expectedKind && record.record_kind !== expectedKind) throw new Error(`expected ${expectedKind}, got ${record.record_kind}`);
  canonicalValue(record.semantic);
  canonicalValue(record.audit);
  assertNeuralCensusSemantic(record.record_kind, record.semantic);
  const expectedId = stableId(record.record_kind, record.semantic);
  if (record.id !== expectedId) throw new Error(`record id does not match canonical semantic content: expected ${expectedId}`);
  return record;
}

export function validateRecordList(records) {
  if (!Array.isArray(records)) throw new Error('record list must be an array');
  const seen = new Set();
  for (const record of records) {
    validateRecord(record);
    if (seen.has(record.id)) throw new Error(`duplicate adjudication record id: ${record.id}`);
    seen.add(record.id);
  }
  return records;
}
