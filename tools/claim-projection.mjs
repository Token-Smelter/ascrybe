// Deterministic projection from immutable documentary claims and the A1 argument substrate.
//
// Claim bytes remain an input plane. This module only adds assertions and receipts whose identities
// are frozen by projection schema; ontology, referent, query, and display choices are downstream.
import { sha256, stableStringify } from './lib.mjs';
import { ARGUMENT_MENTION_SUBSTRATE_SCHEMA } from './argument-mentions.mjs';

export const CLAIM_PROJECTION_SCHEMA_VERSION = 'claim-projection@1';
export const CLAIM_ASSERTION_SCHEMA = 'estate-map/claim-assertion/v1';
export const CLAIM_PROJECTION_RECEIPT_SCHEMA = 'estate-map/claim-projection-receipt/v1';
export const SOURCE_STALENESS_RECEIPT_SCHEMA = 'estate-map/source-staleness-receipt/v1';
export const MIGRATION_PROVENANCE_RECEIPT_SCHEMA = 'estate-map/migration-provenance-receipt/v1';
export const CLAIM_PROJECTION_BUNDLE_SCHEMA = 'estate-map/claim-projection-bundle/v1';
export const GRAPH_COMMIT_SCHEMA = 'estate-map/graph-commit/v1';

export const CLAIM_PROJECTION_DISPOSITIONS = Object.freeze([
  'fully_projected', 'projected_with_literal_argument', 'unresolved_argument_mentions',
  'non_referential_assertion', 'rejected_projection', 'terminal_incomplete',
]);

const dispositions = new Set(CLAIM_PROJECTION_DISPOSITIONS);
const favorableDispositions = new Set([
  'fully_projected', 'projected_with_literal_argument', 'non_referential_assertion',
]);
const assertionFreeDispositions = new Set(['unresolved_argument_mentions', 'terminal_incomplete']);
const sourceStates = new Set(['current', 'deleted', 'inaccessible']);
const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const exactArray = values => [...new Set(values)].sort();
const clean = value => String(value ?? '').trim();
const exactEqual = (left, right) => canonical(left) === canonical(right);

export class ClaimProjectionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimProjectionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new ClaimProjectionError(code, message, detail);
}

function assertProjectionVersion(version) {
  if (version !== CLAIM_PROJECTION_SCHEMA_VERSION) {
    fail('UNSUPPORTED_PROJECTION_SCHEMA', `unsupported projection schema ${version || '<missing>'}`);
  }
}

function normalizedBindings(argumentMentions = []) {
  if (!Array.isArray(argumentMentions)) fail('INVALID_ARGUMENT_BINDINGS', 'argument_mentions must be an array');
  return argumentMentions.map((binding, index) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !clean(binding.role)) {
      fail('INVALID_ARGUMENT_BINDING', `argument binding ${index} requires a role`);
    }
    const hasMention = Object.hasOwn(binding, 'mention_id');
    const hasLiteral = Object.hasOwn(binding, 'literal');
    const unknown = Object.keys(binding).filter(key => !['role', 'mention_id', 'literal'].includes(key));
    if (hasMention === hasLiteral || unknown.length || (hasMention && !clean(binding.mention_id))) {
      fail('INVALID_ARGUMENT_BINDING', `argument binding ${index} must contain exactly one mention_id or literal`, { unknown });
    }
    return Object.freeze(hasMention
      ? { role: binding.role, mention_id: binding.mention_id }
      : { role: binding.role, literal: binding.literal });
  }).sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

/** The complete and closed ClaimAssertion identity function. */
export function claimAssertionId({
  basis_claim_id, argument_mentions, projection_schema_version = CLAIM_PROJECTION_SCHEMA_VERSION,
}) {
  if (!clean(basis_claim_id)) fail('MISSING_BASIS_CLAIM', 'assertion identity requires basis_claim_id');
  assertProjectionVersion(projection_schema_version);
  return hashId('claim-assertion', {
    basis_claim_id,
    argument_mentions: normalizedBindings(argument_mentions),
    projection_schema_version,
  });
}

export function buildSourceStalenessReceipt({
  prior_supporting_source_version_id, from_state = 'current', to_state,
  transition_source_version_id = null, materialization_id,
  projection_schema_version = CLAIM_PROJECTION_SCHEMA_VERSION,
}) {
  assertProjectionVersion(projection_schema_version);
  if (!clean(prior_supporting_source_version_id) || !['deleted', 'inaccessible'].includes(to_state)) {
    fail('INVALID_STALENESS_TRANSITION', 'staleness requires a prior supporting version and deleted/inaccessible transition');
  }
  if (from_state !== 'current') fail('INVALID_STALENESS_TRANSITION', 'the frozen mapping only accepts current-to-stale transitions');
  const body = {
    schema: SOURCE_STALENESS_RECEIPT_SCHEMA,
    prior_supporting_source_version_id,
    transition_source_version_id,
    transition: `${from_state}_to_${to_state}`,
    from_state,
    to_state,
    materialization_id,
    projection_schema_version,
  };
  return Object.freeze({ ...body, receipt_id: hashId('source-staleness-receipt', body) });
}

export function buildMigrationProvenanceReceipt({
  basis_claim_id, source_version, capture_basis, materialization_id,
  projection_schema_version = CLAIM_PROJECTION_SCHEMA_VERSION,
}) {
  assertProjectionVersion(projection_schema_version);
  if (!clean(basis_claim_id) || !clean(source_version?.source_version_id)
    || !clean(source_version?.captured_at) || !clean(capture_basis)) {
    fail('INVALID_MIGRATION_PROVENANCE', 'migration provenance requires claim, source version, captured_at, and immutable capture basis');
  }
  const body = {
    schema: MIGRATION_PROVENANCE_RECEIPT_SCHEMA,
    basis_claim_id,
    source_version_id: source_version.source_version_id,
    captured_at: source_version.captured_at,
    capture_basis,
    materialization_id,
    projection_schema_version,
  };
  return Object.freeze({ ...body, receipt_id: hashId('migration-provenance-receipt', body) });
}

function sourceVersionMap(sourceVersions) {
  const rows = Array.isArray(sourceVersions) ? sourceVersions : Object.values(sourceVersions || {});
  const byId = new Map();
  for (const row of rows) {
    if (!clean(row?.source_version_id) || !sourceStates.has(row.state) || !clean(row.captured_at)) {
      fail('INVALID_SOURCE_VERSION', 'source versions require id, frozen state, and captured_at', { source_version: row });
    }
    if (byId.has(row.source_version_id)) fail('DUPLICATE_SOURCE_VERSION', `duplicate source version ${row.source_version_id}`);
    byId.set(row.source_version_id, row);
  }
  return byId;
}

function selectedRecordedTimeVersion(supported) {
  return supported.slice().sort((left, right) => left.captured_at.localeCompare(right.captured_at)
    || left.source_version_id.localeCompare(right.source_version_id))[0];
}

/** Frozen status/time derivation. No ambient clock, filesystem metadata, or model output is read. */
export function deriveClaimProjectionFields({
  basis_claim_id, support_source_version_ids, source_versions,
  source_staleness_receipts = [], migration_provenance_receipts = [],
  projection_schema_version = CLAIM_PROJECTION_SCHEMA_VERSION,
}) {
  assertProjectionVersion(projection_schema_version);
  const byId = sourceVersionMap(source_versions);
  const supportIds = exactArray(support_source_version_ids || []);
  if (!supportIds.length) fail('CLAIM_WITHOUT_SOURCE_VERSION', `claim ${basis_claim_id} has no supporting source version`);
  const supported = supportIds.map(id => byId.get(id)
    || fail('UNKNOWN_SOURCE_VERSION', `claim ${basis_claim_id} cites unknown source version ${id}`));
  const current = supported.filter(row => row.state === 'current');
  const stale = supported.filter(row => row.state !== 'current');
  const stalenessByVersion = new Map(source_staleness_receipts.map(receipt => [receipt.prior_supporting_source_version_id, receipt]));
  const missingStaleness = !current.length ? stale.filter(row => {
    const receipt = stalenessByVersion.get(row.source_version_id);
    return !receipt || receipt.schema !== SOURCE_STALENESS_RECEIPT_SCHEMA
      || receipt.to_state !== row.state || receipt.from_state !== 'current'
      || receipt.transition !== `current_to_${row.state}`
      || receipt.projection_schema_version !== projection_schema_version;
  }) : [];
  const selected = selectedRecordedTimeVersion(supported);
  const migration = migration_provenance_receipts.find(receipt => receipt.basis_claim_id === basis_claim_id
    && receipt.source_version_id === selected.source_version_id
    && receipt.captured_at === selected.captured_at
    && receipt.schema === MIGRATION_PROVENANCE_RECEIPT_SCHEMA
    && receipt.projection_schema_version === projection_schema_version);
  const findings = [];
  if (missingStaleness.length) findings.push(Object.freeze({
    code: 'STALE_SOURCE_RECEIPT_MISSING',
    source_version_ids: missingStaleness.map(row => row.source_version_id).sort(),
  }));
  if (!migration) findings.push(Object.freeze({
    code: 'MIGRATION_PROVENANCE_RECEIPT_MISSING',
    source_version_id: selected.source_version_id,
  }));
  return Object.freeze({
    complete: findings.length === 0,
    source_status: current.length ? 'current' : 'historical',
    decision_status: 'none',
    recorded_time: migration ? selected.captured_at : null,
    source_staleness_receipt_ids: current.length ? [] : stale.map(row => stalenessByVersion.get(row.source_version_id)?.receipt_id).filter(Boolean).sort(),
    migration_provenance_receipt_id: migration?.receipt_id || null,
    findings,
  });
}

function fieldValue(claim, fieldPath) {
  const parts = String(fieldPath || '').split('.').filter(Boolean);
  let value = claim;
  for (const part of parts) {
    if (value == null || !Object.hasOwn(value, part)) fail('UNKNOWN_CLAIM_FIELD', `claim ${claim.id} has no ${fieldPath}`);
    value = value[part];
  }
  return value;
}

function supportSetId(claim, set, index) {
  return hashId('support-set', {
    claim_id: claim.id,
    index,
    mode: set.mode,
    locators: (set.locators || []).map(locator => ({ role: locator.role, id: locator.id })),
    spans: set.spans || [],
  });
}

function lineageFor(claimId, lineageFacts) {
  const row = lineageFacts instanceof Map ? lineageFacts.get(claimId) : lineageFacts?.[claimId];
  return row || { lineage_status: 'unverified', lineage_finding_ids: [], findings: [] };
}

function bindingState(claim, obligations, bindings, mentionIds) {
  const argumentMentions = [], bindingReceiptIds = [], findings = [];
  let disposition = obligations.length ? 'fully_projected' : 'non_referential_assertion';
  for (const obligation of obligations.slice().sort((a, b) => a.obligation_id.localeCompare(b.obligation_id))) {
    const receiptRows = bindings.get(obligation.obligation_id) || [];
    if (receiptRows.length !== 1) {
      findings.push({ code: 'ARGUMENT_BINDING_RECEIPT_CARDINALITY', obligation_id: obligation.obligation_id, count: receiptRows.length });
      disposition = 'terminal_incomplete';
      continue;
    }
    const receipt = receiptRows[0];
    bindingReceiptIds.push(receipt.receipt_id);
    if (receipt.disposition === 'bound_to_exact_mention') {
      if (receipt.selected_mention_ids.length !== 1 || !mentionIds.has(receipt.selected_mention_ids[0])) {
        findings.push({ code: 'BOUND_MENTION_INTEGRITY', obligation_id: obligation.obligation_id });
        disposition = 'terminal_incomplete';
      } else argumentMentions.push({ role: obligation.role, mention_id: receipt.selected_mention_ids[0] });
    } else if (receipt.disposition === 'literal_argument') {
      argumentMentions.push({ role: obligation.role, literal: fieldValue(claim, obligation.field_path) });
      if (disposition === 'fully_projected') disposition = 'projected_with_literal_argument';
    } else if (receipt.disposition === 'no_referential_argument') {
      if (disposition === 'fully_projected') disposition = 'non_referential_assertion';
    } else if (receipt.disposition === 'ambiguous_mentions') {
      findings.push(...(receipt.findings || []), { code: 'ARGUMENT_MENTIONS_UNRESOLVED', obligation_id: obligation.obligation_id });
      if (disposition !== 'terminal_incomplete') disposition = 'unresolved_argument_mentions';
    } else if (receipt.disposition === 'rejected_binding') {
      findings.push(...(receipt.findings || []), { code: 'ARGUMENT_BINDING_REJECTED', obligation_id: obligation.obligation_id });
      if (disposition !== 'terminal_incomplete') disposition = 'rejected_projection';
    } else {
      findings.push(...(receipt.findings || []), { code: 'ARGUMENT_BINDING_TERMINAL', obligation_id: obligation.obligation_id });
      disposition = 'terminal_incomplete';
    }
  }
  return {
    argument_mentions: normalizedBindings(argumentMentions),
    binding_receipt_ids: exactArray(bindingReceiptIds),
    findings,
    disposition,
  };
}

export function buildClaimProjection({
  admitted_claims, argument_substrate, source_versions, claim_source_version_ids,
  source_staleness_receipts = [], migration_provenance_receipts = [], lineage_facts = {},
  materialization_id, projection_schema_version = CLAIM_PROJECTION_SCHEMA_VERSION,
}) {
  assertProjectionVersion(projection_schema_version);
  if (!Array.isArray(admitted_claims) || !argument_substrate
    || argument_substrate.schema !== ARGUMENT_MENTION_SUBSTRATE_SCHEMA) {
    fail('INVALID_PROJECTION_INPUT', 'claim projection requires admitted claims and the A1 argument substrate');
  }
  const claims = admitted_claims.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(claims.map(claim => claim.id)).size !== claims.length) fail('DUPLICATE_ADMITTED_CLAIM', 'admitted claim IDs must be unique');
  const obligationsByClaim = new Map();
  for (const row of argument_substrate.assertion_argument_obligations || []) {
    const held = obligationsByClaim.get(row.basis_claim_id) || [];
    held.push(row);
    obligationsByClaim.set(row.basis_claim_id, held);
  }
  const bindings = new Map();
  for (const row of argument_substrate.argument_binding_coverage_receipts || []) {
    const held = bindings.get(row.obligation_id) || [];
    held.push(row);
    bindings.set(row.obligation_id, held);
  }
  const mentionIds = new Set((argument_substrate.mentions || []).map(row => row.mention_id));
  const assertions = [], receipts = [];
  for (const claim of claims) {
    const sourceIds = claim_source_version_ids instanceof Map
      ? claim_source_version_ids.get(claim.id) : claim_source_version_ids?.[claim.id];
    const derived = deriveClaimProjectionFields({
      basis_claim_id: claim.id,
      support_source_version_ids: sourceIds,
      source_versions,
      source_staleness_receipts,
      migration_provenance_receipts,
      projection_schema_version,
    });
    const bound = bindingState(claim, obligationsByClaim.get(claim.id) || [], bindings, mentionIds);
    let disposition = derived.complete ? bound.disposition : 'terminal_incomplete';
    const findings = [...derived.findings, ...bound.findings];
    const favorable = ['fully_projected', 'projected_with_literal_argument', 'non_referential_assertion'].includes(disposition);
    const assertionId = favorable ? claimAssertionId({
      basis_claim_id: claim.id,
      argument_mentions: bound.argument_mentions,
      projection_schema_version,
    }) : null;
    const receiptBody = {
      schema: CLAIM_PROJECTION_RECEIPT_SCHEMA,
      basis_claim_id: claim.id,
      disposition,
      assertion_ids: assertionId ? [assertionId] : [],
      argument_binding_receipt_ids: bound.binding_receipt_ids,
      findings,
      projection_schema_version,
      materialization_id,
    };
    const receipt = Object.freeze({ ...receiptBody, receipt_id: hashId('claim-projection-receipt', receiptBody) });
    receipts.push(receipt);
    if (!assertionId) continue;
    const lineage = lineageFor(claim.id, lineage_facts);
    assertions.push(Object.freeze({
      schema: CLAIM_ASSERTION_SCHEMA,
      assertion_id: assertionId,
      basis_claim_id: claim.id,
      proposition_key: claim.proposition_key,
      core_proposition_key: claim.core_proposition_key,
      evidence_key: claim.evidence_key,
      repair_findings: claim.repair_findings || [],
      lineage_status: lineage.lineage_status,
      lineage_finding_ids: lineage.lineage_finding_ids || [],
      predicate_lexeme: claim.semantic?.predicate_family ?? null,
      polarity: claim.semantic?.polarity ?? null,
      modality: claim.semantic?.modality ?? null,
      quantifier: claim.semantic?.quantifier ?? null,
      scope: claim.semantic?.scope ?? {},
      conditions: claim.semantic?.conditions ?? [],
      valid_time: claim.semantic?.valid_time ?? {},
      recorded_time: derived.recorded_time,
      source_status: derived.source_status,
      decision_status: derived.decision_status,
      argument_mentions: bound.argument_mentions,
      support_set_ids: (claim.semantic?.support_sets || []).map((set, index) => supportSetId(claim, set, index)),
      source_staleness_receipt_ids: derived.source_staleness_receipt_ids,
      migration_provenance_receipt_id: derived.migration_provenance_receipt_id,
      projection_receipt_id: receipt.receipt_id,
      projection_schema_version,
    }));
  }
  const claimPlaneDigest = sha256(stableStringify(claims));
  const lineagePlane = Object.fromEntries(claims.map(claim => [claim.id, lineageFor(claim.id, lineage_facts)]));
  const body = {
    schema: CLAIM_PROJECTION_BUNDLE_SCHEMA,
    projection_schema_version,
    materialization_id,
    documentary_claims: claims,
    lineage_facts: lineagePlane,
    claim_plane_projection_digest: claimPlaneDigest,
    assertions: assertions.sort((a, b) => a.assertion_id.localeCompare(b.assertion_id)),
    claim_projection_receipts: receipts.sort((a, b) => a.basis_claim_id.localeCompare(b.basis_claim_id)),
    argument_binding_coverage_receipts: (argument_substrate.argument_binding_coverage_receipts || []).slice(),
    source_staleness_receipts: source_staleness_receipts.slice(),
    migration_provenance_receipts: migration_provenance_receipts.slice(),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyClaimProjection({
  admitted_claims, projection, expected_claim_plane_digest = null, expected_lineage_facts = null,
}) {
  const claims = admitted_claims.slice().sort((a, b) => a.id.localeCompare(b.id));
  const admittedIds = new Set(claims.map(row => row.id));
  if (!exactEqual(projection.documentary_claims, claims)) fail('CLAIM_BYTES_CHANGED', 'projected documentary claim plane differs byte-for-byte');
  const digest = sha256(stableStringify(claims));
  if (projection.claim_plane_projection_digest !== digest || (expected_claim_plane_digest && digest !== expected_claim_plane_digest)) {
    fail('CLAIM_PLANE_DIGEST_CHANGED', 'claim-plane projection digest changed', { expected: expected_claim_plane_digest || digest, actual: projection.claim_plane_projection_digest });
  }
  if (expected_lineage_facts && !exactEqual(projection.lineage_facts, expected_lineage_facts)) {
    fail('LINEAGE_FACTS_CHANGED', 'projected lineage facts differ byte-for-byte');
  }
  const receiptRows = new Map();
  const receiptIds = new Set();
  for (const receipt of projection.claim_projection_receipts || []) {
    if (!admittedIds.has(receipt.basis_claim_id)) fail('UNADMITTED_PROJECTION_RECEIPT', `receipt cites unadmitted claim ${receipt.basis_claim_id}`);
    const held = receiptRows.get(receipt.basis_claim_id) || [];
    held.push(receipt);
    receiptRows.set(receipt.basis_claim_id, held);
    if (receipt.projection_schema_version !== projection.projection_schema_version || !dispositions.has(receipt.disposition)) {
      fail('INVALID_PROJECTION_RECEIPT', `invalid projection receipt for ${receipt.basis_claim_id}`);
    }
    const assertionCount = Array.isArray(receipt.assertion_ids) ? receipt.assertion_ids.length : -1;
    if ((favorableDispositions.has(receipt.disposition) && assertionCount !== 1)
      || (assertionFreeDispositions.has(receipt.disposition) && assertionCount !== 0)) {
      fail('DISPOSITION_ASSERTION_CARDINALITY_MISMATCH',
        `projection receipt ${receipt.receipt_id} disposition ${receipt.disposition} has ${assertionCount} assertions`);
    }
    if (receipt.disposition === 'rejected_projection' && (!(receipt.findings || []).length || receipt.assertion_ids.length)) {
      fail('INVALID_REJECTED_PROJECTION', `rejected projection ${receipt.receipt_id} requires findings and no assertion`);
    }
  }
  for (const claim of claims) {
    const rows = receiptRows.get(claim.id) || [];
    if (rows.length !== 1) fail('PROJECTION_RECEIPT_CARDINALITY', `claim ${claim.id} has ${rows.length} projection receipts`);
  }
  for (const receipt of projection.claim_projection_receipts || []) {
    const { receipt_id: receiptId, ...receiptBody } = receipt;
    if (!clean(receiptId) || receiptIds.has(receiptId)
      || receiptId !== hashId('claim-projection-receipt', receiptBody)) {
      fail('INVALID_PROJECTION_RECEIPT_ID', `projection receipt for ${receipt.basis_claim_id} has invalid or duplicate identity`);
    }
    receiptIds.add(receiptId);
  }
  const bindingIds = new Set((projection.argument_binding_coverage_receipts || []).map(row => row.receipt_id));
  const assertionById = new Map((projection.assertions || []).map(row => [row.assertion_id, row]));
  if (assertionById.size !== (projection.assertions || []).length) fail('DUPLICATE_ASSERTION_ID', 'assertion IDs must be unique');
  for (const receipt of projection.claim_projection_receipts || []) {
    for (const id of receipt.argument_binding_receipt_ids || []) if (!bindingIds.has(id)) {
      fail('MISSING_ARGUMENT_BINDING_RECEIPT', `projection receipt ${receipt.receipt_id} cites missing ${id}`);
    }
    for (const id of receipt.assertion_ids || []) {
      const assertion = assertionById.get(id);
      if (!assertion || assertion.basis_claim_id !== receipt.basis_claim_id || assertion.projection_receipt_id !== receipt.receipt_id) {
        fail('ASSERTION_REFERENTIAL_INTEGRITY', `projection receipt ${receipt.receipt_id} cites invalid assertion ${id}`);
      }
    }
  }
  for (const assertion of projection.assertions || []) {
    if (!admittedIds.has(assertion.basis_claim_id)
      || assertion.projection_schema_version !== projection.projection_schema_version
      || assertion.assertion_id !== claimAssertionId(assertion)) {
      fail('INVALID_CLAIM_ASSERTION', `assertion ${assertion.assertion_id} has invalid identity or basis`);
    }
    const receipt = (projection.claim_projection_receipts || [])
      .find(row => row.receipt_id === assertion.projection_receipt_id);
    if (!receipt || !receipt.assertion_ids.includes(assertion.assertion_id)) {
      fail('UNRECEIPTED_ASSERTION', `assertion ${assertion.assertion_id} is not cited by its projection receipt`);
    }
  }
  return Object.freeze({ claims: claims.length, receipts: receiptRows.size, assertions: assertionById.size, claim_plane_projection_digest: digest });
}

export function verifyStatusDerivation({ projection, source_versions, claim_source_version_ids }) {
  const sourceById = sourceVersionMap(source_versions);
  const staleness = projection.source_staleness_receipts || [];
  const migrations = projection.migration_provenance_receipts || [];
  const assertions = new Map((projection.assertions || []).map(row => [row.basis_claim_id, row]));
  for (const receipt of projection.claim_projection_receipts || []) {
    const ids = claim_source_version_ids instanceof Map
      ? claim_source_version_ids.get(receipt.basis_claim_id) : claim_source_version_ids?.[receipt.basis_claim_id];
    const expected = deriveClaimProjectionFields({
      basis_claim_id: receipt.basis_claim_id,
      support_source_version_ids: ids,
      source_versions: [...sourceById.values()],
      source_staleness_receipts: staleness,
      migration_provenance_receipts: migrations,
      projection_schema_version: projection.projection_schema_version,
    });
    const assertion = assertions.get(receipt.basis_claim_id);
    if (!expected.complete) {
      if (receipt.disposition !== 'terminal_incomplete' || assertion) {
        fail('INVALID_TERMINAL_STATUS_PROJECTION', `claim ${receipt.basis_claim_id} must be terminal_incomplete without assertion`);
      }
      continue;
    }
    if (assertion && (assertion.source_status !== expected.source_status
      || assertion.decision_status !== expected.decision_status
      || assertion.recorded_time !== expected.recorded_time
      || !exactEqual(assertion.source_staleness_receipt_ids, expected.source_staleness_receipt_ids)
      || assertion.migration_provenance_receipt_id !== expected.migration_provenance_receipt_id)) {
      fail('STATUS_TIME_DERIVATION_MISMATCH', `claim ${receipt.basis_claim_id} assertion violates frozen status/time mapping`);
    }
  }
  return true;
}

export function buildGraphCommit({
  parent_graph_commit_id = null, source_head, identity_head = null, ontology_head = null,
  added_object_digests = [], superseded_object_ids = [], assertion_supersession_receipt_ids = [],
  tombstones = [], segment_references = [], claim_projection_receipts, dependency_index_digest,
}) {
  const incomplete = (claim_projection_receipts || []).filter(row => row.disposition === 'terminal_incomplete');
  const segments = segment_references.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || Object.keys(reference).some(key => !['segment_id', 'segment_digest'].includes(key))
      || !clean(reference.segment_id) || !/^[0-9a-f]{64}$/u.test(reference.segment_digest || '')) {
      fail('INVALID_GRAPH_COMMIT_SEGMENT', 'GraphCommit segment references require exact segment_id and SHA-256 digest');
    }
    return { segment_id: reference.segment_id, segment_digest: reference.segment_digest };
  }).sort((left, right) => left.segment_id.localeCompare(right.segment_id));
  if (new Set(segments.map(row => row.segment_id)).size !== segments.length) {
    fail('DUPLICATE_GRAPH_COMMIT_SEGMENT', 'GraphCommit segment references must be unique');
  }
  const body = {
    schema: GRAPH_COMMIT_SCHEMA,
    parent_graph_commit_id,
    source_head,
    identity_head,
    ontology_head,
    added_object_digests: exactArray(added_object_digests),
    superseded_object_ids: exactArray(superseded_object_ids),
    assertion_supersession_receipt_ids: exactArray(assertion_supersession_receipt_ids),
    tombstones: exactArray(tombstones),
    segment_references: segments,
    claim_projection_status: incomplete.length ? 'incomplete' : 'complete',
    incomplete_claim_projection_receipt_ids: incomplete.map(row => row.receipt_id).sort(),
    incomplete_claim_ids: incomplete.map(row => row.basis_claim_id).sort(),
    dependency_index_digest,
  };
  return Object.freeze({ ...body, graph_commit_id: hashId('graph-commit', body) });
}

export function verifyGraphCommit({ graph_commit, claim_projection_receipts }) {
  const fields = [
    'schema', 'parent_graph_commit_id', 'source_head', 'identity_head', 'ontology_head',
    'added_object_digests', 'superseded_object_ids', 'assertion_supersession_receipt_ids',
    'tombstones', 'segment_references', 'claim_projection_status',
    'incomplete_claim_projection_receipt_ids', 'incomplete_claim_ids',
    'dependency_index_digest', 'graph_commit_id',
  ];
  if (!graph_commit || graph_commit.schema !== GRAPH_COMMIT_SCHEMA
    || Object.keys(graph_commit).some(key => !fields.includes(key))
    || fields.some(key => !Object.hasOwn(graph_commit, key))
    || !clean(graph_commit.source_head) || !clean(graph_commit.dependency_index_digest)
    || !['complete', 'incomplete'].includes(graph_commit.claim_projection_status)
    || !Array.isArray(graph_commit.segment_references)) {
    fail('INVALID_GRAPH_COMMIT', 'GraphCommit differs from its closed replay contract');
  }
  for (const field of ['added_object_digests', 'superseded_object_ids',
    'assertion_supersession_receipt_ids', 'incomplete_claim_projection_receipt_ids',
    'incomplete_claim_ids', 'tombstones']) {
    if (!Array.isArray(graph_commit[field]) || !exactEqual(graph_commit[field], exactArray(graph_commit[field]))) {
      fail('INVALID_GRAPH_COMMIT_ORDER', `GraphCommit ${field} must be a sorted unique ID set`);
    }
  }
  let priorSegment = null;
  for (const reference of graph_commit.segment_references) {
    if (!reference || !clean(reference.segment_id)
      || !/^[0-9a-f]{64}$/u.test(reference.segment_digest || '')
      || !exactEqual(Object.keys(reference).sort(), ['segment_digest', 'segment_id'])
      || (priorSegment && priorSegment.localeCompare(reference.segment_id) >= 0)) {
      fail('INVALID_GRAPH_COMMIT_SEGMENT', 'GraphCommit segment references are malformed, duplicate, or unordered');
    }
    priorSegment = reference.segment_id;
  }
  if (Array.isArray(claim_projection_receipts)) {
    const incomplete = claim_projection_receipts.filter(row => row.disposition === 'terminal_incomplete');
    const expectedReceipts = incomplete.map(row => row.receipt_id).sort();
    const expectedClaims = incomplete.map(row => row.basis_claim_id).sort();
    const expectedStatus = incomplete.length ? 'incomplete' : 'complete';
    if (graph_commit.claim_projection_status !== expectedStatus
      || !exactEqual(graph_commit.incomplete_claim_projection_receipt_ids, expectedReceipts)
      || !exactEqual(graph_commit.incomplete_claim_ids, expectedClaims)) {
      fail('GRAPH_COMMIT_INCOMPLETE_SET_MISMATCH', 'GraphCommit does not record the exact incomplete receipt and claim sets');
    }
  } else if ((graph_commit.claim_projection_status === 'complete'
      && (graph_commit.incomplete_claim_projection_receipt_ids.length || graph_commit.incomplete_claim_ids.length))
    || (graph_commit.claim_projection_status === 'incomplete'
      && (!graph_commit.incomplete_claim_projection_receipt_ids.length
        || graph_commit.incomplete_claim_projection_receipt_ids.length !== graph_commit.incomplete_claim_ids.length))) {
    fail('GRAPH_COMMIT_INCOMPLETE_SET_MISMATCH', 'GraphCommit incompleteness marker and exact sets disagree');
  }
  const { graph_commit_id: graphCommitId, ...body } = graph_commit;
  if (graphCommitId !== hashId('graph-commit', body)) {
    fail('INVALID_GRAPH_COMMIT_ID', 'GraphCommit identity differs from its exact canonical body');
  }
  return true;
}

export function verifyPhaseAExit({
  admitted_claims, projection, graph_commit, source_versions, claim_source_version_ids,
  expected_claim_plane_digest = null, expected_lineage_facts = null,
}) {
  const conservation = verifyClaimProjection({ admitted_claims, projection, expected_claim_plane_digest, expected_lineage_facts });
  verifyStatusDerivation({ projection, source_versions, claim_source_version_ids });
  verifyGraphCommit({ graph_commit, claim_projection_receipts: projection.claim_projection_receipts });
  const blocking = projection.claim_projection_receipts.filter(row => ['rejected_projection', 'terminal_incomplete'].includes(row.disposition));
  if (blocking.length || graph_commit.claim_projection_status !== 'complete') {
    fail('PHASE_A_EXIT_INCOMPLETE', `Phase A exit has ${blocking.length} rejected or terminal projection receipts`, {
      disposition_counts: Object.fromEntries([...new Set(blocking.map(row => row.disposition))]
        .map(disposition => [disposition, blocking.filter(row => row.disposition === disposition).length])),
      examples: blocking.slice(0, 5).map(row => ({
        basis_claim_id: row.basis_claim_id,
        disposition: row.disposition,
        findings: row.findings,
      })),
    });
  }
  return conservation;
}
