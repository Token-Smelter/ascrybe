// File-scope identity vocabulary from docs/delta-updatable-estate-maps.md ("Immutable
// contracts" / "Identity vocabulary"). Every function here is a literal transcription of one
// formula in that section; nothing is copied from a parent receipt and nothing is inferred from
// the current build state. Only the `file` observation-identity scope is implemented — see
// tools/delta/scope-refusals.mjs for the explicit, typed refusal of `repository` and `global`
// scope, which this file-scope slice deliberately does not implement.
import { sha256, stableStringify } from '../lib.mjs';

export const EXTRACTION_UNIT_RECEIPT_SCHEMA = 'estate-map/extraction-unit-receipt/v1';

const canonical = value => stableStringify(value).trim();

export function identityError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

const FILE_SCOPE_KIND = 'file';
// Named per docs/delta-updatable-estate-maps.md's observation_identity_scope union. Only `file`
// is implemented; see tools/delta/scope-refusals.mjs.
export const UNIMPLEMENTED_SCOPE_KINDS = Object.freeze(['repository', 'global']);

function requireFileScopeKind(kind, where) {
  if (kind === FILE_SCOPE_KIND) return;
  if (UNIMPLEMENTED_SCOPE_KINDS.includes(kind)) {
    throw identityError('DELTA_SCOPE_NOT_IMPLEMENTED',
      `${where} refuses ${kind}-scope: only file-scope identity is implemented`, { kind });
  }
  throw identityError('DELTA_SCOPE_UNKNOWN', `${where} received an unrecognized scope kind`, { kind });
}

/** observation_identity_scope (file variant): {kind: "file", repository, normalized_path}. */
export function fileObservationIdentityScope({ repository, normalized_path: normalizedPath }) {
  if (!repository || !normalizedPath) {
    throw identityError('DELTA_OBSERVATION_SCOPE_INVALID',
      'file observation_identity_scope requires repository and normalized_path');
  }
  return Object.freeze({ kind: FILE_SCOPE_KIND, repository, normalized_path: normalizedPath });
}

/**
 * repository_qualified_input_receipt = {repository, role, identity, digest}
 * digest = SHA-256(canonical(identity))
 */
export function repositoryQualifiedInputReceipt({ repository, role, identity }) {
  if (!repository || !role || !identity || typeof identity !== 'object') {
    throw identityError('DELTA_INPUT_RECEIPT_INVALID',
      'repository_qualified_input_receipt requires repository, role, and an identity object');
  }
  return Object.freeze({ repository, role, identity, digest: sha256(canonical(identity)) });
}

/**
 * The sort backing input_receipt_digest = SHA-256(canonical(sort(repository_qualified_input_receipts))).
 * "the sort is canonical over that complete tuple and duplicate tuples are refused."
 */
export function sortInputReceipts(receipts) {
  if (!Array.isArray(receipts)) {
    throw identityError('DELTA_INPUT_RECEIPT_LIST_INVALID', 'inputs must be an array of repository_qualified_input_receipt');
  }
  const keyed = receipts.map(receipt => ({ receipt, key: canonical(receipt) }));
  const seen = new Set();
  for (const { key } of keyed) {
    if (seen.has(key)) {
      throw identityError('DELTA_DUPLICATE_INPUT_RECEIPT', 'duplicate repository_qualified_input_receipt tuples are refused');
    }
    seen.add(key);
  }
  return keyed.sort((left, right) => left.key.localeCompare(right.key)).map(entry => entry.receipt);
}

/**
 * input_receipt_digest = SHA-256(canonical(sort(inputs)))
 * "always computed from the complete inputs array by the formula above -- never copied from a
 * parent receipt."
 */
export function inputReceiptDigest(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw identityError('DELTA_INPUT_RECEIPT_EMPTY', 'input_receipt_digest requires a non-empty complete inputs array');
  }
  return sha256(canonical(sortInputReceipts(inputs)));
}

/**
 * observation_id = "observation:" + SHA-256(canonical({
 *   identity_contract, observation_identity_scope, extractor_id, observation_kind, producer_local_key
 * }))
 */
export function observationId({
  identity_contract: identityContract, observation_identity_scope: observationIdentityScope,
  extractor_id: extractorId, observation_kind: observationKind, producer_local_key: producerLocalKey,
}) {
  requireFileScopeKind(observationIdentityScope?.kind, 'observationId');
  if (!identityContract || !extractorId || !observationKind
    || producerLocalKey === undefined || producerLocalKey === null || producerLocalKey === '') {
    throw identityError('DELTA_OBSERVATION_IDENTITY_INCOMPLETE',
      'observation_id requires identity_contract, observation_identity_scope, extractor_id, observation_kind, and a non-empty producer_local_key');
  }
  const identity = {
    identity_contract: identityContract, observation_identity_scope: observationIdentityScope,
    extractor_id: extractorId, observation_kind: observationKind, producer_local_key: producerLocalKey,
  };
  return `observation:${sha256(canonical(identity))}`;
}

/** payload_scope (file variant): {kind, repository, normalized_path, blob_oid, content_sha256}. */
export function fileScopePayload({
  repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256,
}) {
  if (!repository || !normalizedPath || !blobOid || !/^[0-9a-f]{64}$/u.test(contentSha256 || '')) {
    throw identityError('DELTA_PAYLOAD_SCOPE_INVALID',
      'file payload_scope requires repository, normalized_path, blob_oid, and a 64-hex content_sha256');
  }
  return Object.freeze({
    kind: FILE_SCOPE_KIND, repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256,
  });
}

const EXTRACTOR_CONTRACT_FIELDS = Object.freeze([
  'extractor_id', 'routing_contract_digest', 'output_contract', 'identity_contract',
  'implementation_digest', 'configuration_digest', 'runtime_digest',
]);

/**
 * extractor_contract_dependencies = {
 *   extractor_id, routing_contract_digest, output_contract, identity_contract,
 *   implementation_digest, configuration_digest, runtime_digest
 * }
 */
export function extractorContractDependencies(fields) {
  const missing = EXTRACTOR_CONTRACT_FIELDS.filter(field => !fields?.[field]);
  if (missing.length) {
    throw identityError('DELTA_EXTRACTOR_CONTRACT_INCOMPLETE',
      `extractor_contract_dependencies is missing: ${missing.join(', ')}`, { missing });
  }
  return Object.freeze(Object.fromEntries(EXTRACTOR_CONTRACT_FIELDS.map(field => [field, fields[field]])));
}

/** producer_contract_digest = SHA-256(canonical(extractor_contract_dependencies)) */
export function producerContractDigest(extractorContractDependenciesValue) {
  return sha256(canonical(extractorContractDependenciesValue));
}

/** producer_content_digest = SHA-256(canonical(payload_scope)) */
export function producerContentDigest(payloadScope) {
  return sha256(canonical(payloadScope));
}

/**
 * payload_unit_id = "unit:" + SHA-256(canonical({payload_scope, extractor_contract_dependencies}))
 */
export function payloadUnitId({ payload_scope: payloadScope, extractor_contract_dependencies: extractorContractDependenciesValue }) {
  if (!payloadScope || !extractorContractDependenciesValue) {
    throw identityError('DELTA_UNIT_ID_INPUT_INVALID', 'payload_unit_id requires payload_scope and extractor_contract_dependencies');
  }
  return `unit:${sha256(canonical({ payload_scope: payloadScope, extractor_contract_dependencies: extractorContractDependenciesValue }))}`;
}

/**
 * record_digest = SHA-256(canonical({
 *   output_schema, observation_id, normalized_record,
 *   producer_contract_digest, producer_content_digest, input_receipt_digest
 * }))
 */
export function recordDigest({
  output_schema: outputSchema, observation_id: observationIdValue, normalized_record: normalizedRecord,
  producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
  input_receipt_digest: inputReceiptDigestValue,
}) {
  for (const [key, value] of Object.entries({
    output_schema: outputSchema, observation_id: observationIdValue, producer_contract_digest: producerContractDigestValue,
    producer_content_digest: producerContentDigestValue, input_receipt_digest: inputReceiptDigestValue,
  })) {
    if (!value) throw identityError('DELTA_RECORD_DIGEST_INPUT_INVALID', `record_digest is missing ${key}`);
  }
  if (normalizedRecord === undefined) throw identityError('DELTA_RECORD_DIGEST_INPUT_INVALID', 'record_digest is missing normalized_record');
  return sha256(canonical({
    output_schema: outputSchema, observation_id: observationIdValue, normalized_record: normalizedRecord,
    producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
    input_receipt_digest: inputReceiptDigestValue,
  }));
}

/**
 * records_digest = SHA-256(canonical(sorted(output.records)))
 *
 * The design does not pin a sort key. This implementation sorts by each record's own canonical
 * serialization (a total order over the exact record bytes), which is deterministic and does not
 * depend on any field the identity formulas do not already commit to.
 */
export function sortRecords(records) {
  return [...records].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}
export function recordsDigest(records) {
  return sha256(canonical(sortRecords(records)));
}

/** receipt_digest = SHA-256(canonical(receipt_body_without_receipt_digest)) */
export function receiptDigest(receiptBodyWithoutReceiptDigest) {
  return sha256(canonical(receiptBodyWithoutReceiptDigest));
}

/**
 * build_scope_digest = SHA-256(canonical({
 *   canonical_pins, normalized_inventory, routing_contracts,
 *   extractor_contracts, configuration_digest, runtime_digest, policy_digest
 * }))
 * "fully computable before payload selection or assembly, so no digest depends on itself
 * transitively."
 */
const BUILD_SCOPE_FIELDS = Object.freeze([
  'canonical_pins', 'normalized_inventory', 'routing_contracts', 'extractor_contracts',
  'configuration_digest', 'runtime_digest', 'policy_digest',
]);
export function buildScopeDigest(fields) {
  const missing = BUILD_SCOPE_FIELDS.filter(field => fields?.[field] === undefined);
  if (missing.length) {
    throw identityError('DELTA_BUILD_SCOPE_INPUT_INVALID', `build_scope_digest is missing: ${missing.join(', ')}`, { missing });
  }
  return sha256(canonical(Object.fromEntries(BUILD_SCOPE_FIELDS.map(field => [field, fields[field]]))));
}

/** current_scope_binding (file variant). */
export function fileCurrentScopeBinding({
  repository, normalized_path: normalizedPath, current_source_pin: currentSourcePin,
  blob_oid: blobOid, content_sha256: contentSha256,
}) {
  if (!repository || !normalizedPath || !currentSourcePin || !blobOid || !/^[0-9a-f]{64}$/u.test(contentSha256 || '')) {
    throw identityError('DELTA_CURRENT_SCOPE_BINDING_INVALID',
      'file current_scope_binding requires repository, normalized_path, current_source_pin, blob_oid, and content_sha256');
  }
  return Object.freeze({
    kind: FILE_SCOPE_KIND, repository, normalized_path: normalizedPath, current_source_pin: currentSourcePin,
    blob_oid: blobOid, content_sha256: contentSha256,
  });
}

/**
 * build_membership_binding = SHA-256(canonical({
 *   build_scope_digest, payload_unit_id, current_scope_binding
 * }))
 * "A payload identity is deliberately distinct from a current-build membership binding": this
 * digest is never used as a substitute for payload_unit_id and vice versa.
 */
export function buildMembershipBinding({
  build_scope_digest: buildScopeDigestValue, payload_unit_id: payloadUnitIdValue,
  current_scope_binding: currentScopeBinding,
}) {
  if (!buildScopeDigestValue || !payloadUnitIdValue || !currentScopeBinding) {
    throw identityError('DELTA_MEMBERSHIP_BINDING_INPUT_INVALID',
      'build_membership_binding requires build_scope_digest, payload_unit_id, and current_scope_binding');
  }
  return sha256(canonical({
    build_scope_digest: buildScopeDigestValue, payload_unit_id: payloadUnitIdValue, current_scope_binding: currentScopeBinding,
  }));
}

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
const SEMANTIC_CONTENT_FIELDS = Object.freeze([
  'build_scope_digest', 'sorted_build_membership_bindings', 'observation_record_pairs',
  'global_outputs', 'claim_outputs', 'projection_content_digest', 'conservation_result',
]);
export function semanticContentDigest(fields) {
  const missing = SEMANTIC_CONTENT_FIELDS.filter(field => fields?.[field] === undefined);
  if (missing.length) {
    throw identityError('DELTA_SEMANTIC_CONTENT_INPUT_INVALID', `semantic_content_digest is missing: ${missing.join(', ')}`, { missing });
  }
  return sha256(canonical(Object.fromEntries(SEMANTIC_CONTENT_FIELDS.map(field => [field, fields[field]]))));
}
export function buildId(semanticContentDigestValue) {
  if (!semanticContentDigestValue) throw identityError('DELTA_BUILD_ID_INPUT_INVALID', 'build_id requires semantic_content_digest');
  return `estate-build:${semanticContentDigestValue}`;
}
