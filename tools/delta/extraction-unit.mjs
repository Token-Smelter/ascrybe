// Extraction Unit Receipt v1 (file scope) — docs/delta-updatable-estate-maps.md
// "Extraction Unit Receipt v1". This module builds a `produced` receipt from a producer's raw
// output, reseals a receipt under a different disposition without touching its records (the
// mechanism `reused_exact` and `refused` both use), and independently recomputes every formula
// field from a receipt's own bytes so a stored/cached receipt can be proven exact rather than
// trusted.
import { sha256, stableStringify } from '../lib.mjs';
import {
  EXTRACTION_UNIT_RECEIPT_SCHEMA, identityError, fileObservationIdentityScope,
  repositoryQualifiedInputReceipt, inputReceiptDigest, fileScopePayload,
  extractorContractDependencies, producerContractDigest, producerContentDigest, payloadUnitId,
  observationId, recordDigest, recordsDigest, sortRecords, receiptDigest,
} from './identity.mjs';

const canonical = value => stableStringify(value).trim();

export const DISPOSITION_KINDS = Object.freeze(['produced', 'reused_exact', 'migrated', 'refused']);

const EXTRACTOR_DECLARATION_FIELDS = Object.freeze([
  'id', 'routing_contract_digest', 'output_contract', 'identity_contract',
  'implementation_digest', 'configuration_digest', 'runtime_digest',
]);

function normalizeExtractorDeclaration(extractor) {
  const missing = EXTRACTOR_DECLARATION_FIELDS.filter(field => !extractor?.[field]);
  if (missing.length) {
    throw identityError('DELTA_EXTRACTOR_DECLARATION_INCOMPLETE',
      `extractor declaration is missing: ${missing.join(', ')}`, { missing });
  }
  return Object.freeze(Object.fromEntries(EXTRACTOR_DECLARATION_FIELDS.map(field => [field, extractor[field]])));
}

function contractDependenciesFor(extractorDeclaration) {
  return extractorContractDependencies({
    extractor_id: extractorDeclaration.id,
    routing_contract_digest: extractorDeclaration.routing_contract_digest,
    output_contract: extractorDeclaration.output_contract,
    identity_contract: extractorDeclaration.identity_contract,
    implementation_digest: extractorDeclaration.implementation_digest,
    configuration_digest: extractorDeclaration.configuration_digest,
    runtime_digest: extractorDeclaration.runtime_digest,
  });
}

/** The scope + declared inputs shared by every disposition of one file/extractor unit. */
export function fileUnitScopeAndInputs({
  repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256,
}) {
  const scope = fileScopePayload({ repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256 });
  const inputs = [repositoryQualifiedInputReceipt({
    repository, role: 'primary',
    identity: { kind: 'blob', normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256 },
  })];
  return { scope, inputs };
}

/** Compute one unit's full identity (scope, inputs, extractor contract, unit_id) without
 * producing any records. Used by the planner to enumerate the expected unit set and to attempt
 * cache reuse before ever calling a producer. */
export function fileUnitIdentity({
  repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256, extractor,
}) {
  const { scope, inputs } = fileUnitScopeAndInputs({ repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256 });
  const extractorDeclaration = normalizeExtractorDeclaration(extractor);
  const contractDependencies = contractDependenciesFor(extractorDeclaration);
  const unitId = payloadUnitId({ payload_scope: scope, extractor_contract_dependencies: contractDependencies });
  return Object.freeze({
    scope, inputs, extractor: extractorDeclaration, extractor_contract_dependencies: contractDependencies, unit_id: unitId,
  });
}

function sealReceipt(bodyWithoutDigest) {
  return Object.freeze({ ...bodyWithoutDigest, receipt_digest: receiptDigest(bodyWithoutDigest) });
}

function emptyDisposition(kind, overrides = {}) {
  return Object.freeze({
    kind, source_receipt_digest: null, compatibility_receipt_digest: null, migration_receipt_digest: null, ...overrides,
  });
}

/**
 * Build a `produced` file-scope Extraction Unit Receipt v1. `records` are the producer's raw
 * output: [{observation_kind, producer_local_key, output_schema, normalized_record}]. Every
 * identity/digest field is recomputed here — nothing is accepted as a literal from the caller.
 */
export function buildProducedFileUnitReceipt({
  repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256,
  extractor, records,
}) {
  const { scope, inputs } = fileUnitScopeAndInputs({ repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256 });
  const extractorDeclaration = normalizeExtractorDeclaration(extractor);
  const contractDependencies = contractDependenciesFor(extractorDeclaration);
  const inputReceiptDigestValue = inputReceiptDigest(inputs);
  const unitId = payloadUnitId({ payload_scope: scope, extractor_contract_dependencies: contractDependencies });
  const producerContractDigestValue = producerContractDigest(contractDependencies);
  const producerContentDigestValue = producerContentDigest(scope);
  const observationScope = fileObservationIdentityScope({ repository, normalized_path: normalizedPath });

  if (!Array.isArray(records)) throw identityError('DELTA_UNIT_OUTPUT_INVALID', 'produced records must be an array (possibly empty)');
  const seen = new Set();
  const fullRecords = records.map(raw => {
    if (!raw?.observation_kind || raw.producer_local_key === undefined || raw.producer_local_key === null || raw.producer_local_key === '') {
      throw identityError('DELTA_RECORD_INPUT_INVALID', 'each record requires observation_kind and a non-empty producer_local_key');
    }
    if (!raw.output_schema) throw identityError('DELTA_RECORD_INPUT_INVALID', 'each record requires output_schema');
    const observationIdValue = observationId({
      identity_contract: extractorDeclaration.identity_contract,
      observation_identity_scope: observationScope,
      extractor_id: extractorDeclaration.id,
      observation_kind: raw.observation_kind,
      producer_local_key: raw.producer_local_key,
    });
    if (seen.has(observationIdValue)) {
      throw identityError('DELTA_DUPLICATE_OBSERVATION_ID', `duplicate observation_id within one unit: ${observationIdValue}`, { observation_id: observationIdValue });
    }
    seen.add(observationIdValue);
    const recordDigestValue = recordDigest({
      output_schema: raw.output_schema, observation_id: observationIdValue, normalized_record: raw.normalized_record,
      producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
      input_receipt_digest: inputReceiptDigestValue,
    });
    return Object.freeze({
      identity: Object.freeze({
        observation_identity_scope: observationScope, observation_kind: raw.observation_kind, producer_local_key: raw.producer_local_key,
      }),
      observation_id: observationIdValue,
      output_schema: raw.output_schema,
      normalized_record: raw.normalized_record,
      producer_contract_digest: producerContractDigestValue,
      producer_content_digest: producerContentDigestValue,
      input_receipt_digest: inputReceiptDigestValue,
      record_digest: recordDigestValue,
      payload_digest: sha256(canonical(raw.normalized_record)),
    });
  });

  const kindCounts = {};
  for (const record of fullRecords) kindCounts[record.identity.observation_kind] = (kindCounts[record.identity.observation_kind] || 0) + 1;

  const output = Object.freeze({
    records: sortRecords(fullRecords), kind_counts: Object.freeze(kindCounts), records_digest: recordsDigest(fullRecords), complete: true,
  });

  return sealReceipt({
    schema: EXTRACTION_UNIT_RECEIPT_SCHEMA,
    unit_id: unitId,
    scope,
    extractor: extractorDeclaration,
    inputs,
    input_receipt_digest: inputReceiptDigestValue,
    output,
    disposition: emptyDisposition('produced'),
  });
}

/**
 * A `refused` receipt: "No usable output exists; a typed reason and affected scope are
 * recorded." `disposition.reason_code`/`disposition.reason` are additive fields this
 * implementation adds to carry that typed reason — the design's illustrative JSON only shows the
 * `produced` disposition shape, which has no reason slot; see PR body for this call-out.
 */
export function buildRefusedFileUnitReceipt({
  repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256,
  extractor, reason_code: reasonCode, reason,
}) {
  if (!reasonCode || !reason) throw identityError('DELTA_REFUSAL_REASON_REQUIRED', 'a refused unit requires reason_code and reason');
  const { scope, inputs } = fileUnitScopeAndInputs({ repository, normalized_path: normalizedPath, blob_oid: blobOid, content_sha256: contentSha256 });
  const extractorDeclaration = normalizeExtractorDeclaration(extractor);
  const contractDependencies = contractDependenciesFor(extractorDeclaration);
  const inputReceiptDigestValue = inputReceiptDigest(inputs);
  const unitId = payloadUnitId({ payload_scope: scope, extractor_contract_dependencies: contractDependencies });
  const output = Object.freeze({ records: [], kind_counts: Object.freeze({}), records_digest: recordsDigest([]), complete: false });
  return sealReceipt({
    schema: EXTRACTION_UNIT_RECEIPT_SCHEMA,
    unit_id: unitId,
    scope,
    extractor: extractorDeclaration,
    inputs,
    input_receipt_digest: inputReceiptDigestValue,
    output,
    disposition: emptyDisposition('refused', { reason_code: reasonCode, reason }),
  });
}

/**
 * Reseal an existing receipt under a new disposition WITHOUT touching `output`/records. This is
 * the mechanism that keeps a reused record's original producer provenance and original
 * record_digest: the bytes this returns for `scope`/`extractor`/`inputs`/`output` are identical to
 * the source receipt, byte for byte; only `disposition` (and therefore `receipt_digest`, which
 * commits to the whole body) changes.
 */
export function relabelDisposition(receipt, disposition) {
  const { receipt_digest: _drop, ...body } = receipt;
  return sealReceipt({ ...body, disposition });
}

/**
 * Independently recompute every formula field in `receipt` from its own declared bytes and throw
 * on the first mismatch. This is the fail-closed check a cache read or a planner reuse decision
 * must pass before trusting a stored receipt — it never trusts a receipt's own claimed digests.
 */
export function recomputeAndValidateReceipt(receipt) {
  if (!receipt || receipt.schema !== EXTRACTION_UNIT_RECEIPT_SCHEMA) {
    throw identityError('DELTA_UNIT_RECEIPT_INVALID', 'receipt has the wrong or missing schema');
  }
  if (receipt.scope?.kind !== 'file') {
    throw identityError('DELTA_SCOPE_NOT_IMPLEMENTED', 'only file-scope receipts are validated by this implementation', { kind: receipt.scope?.kind });
  }
  const extractorDeclaration = normalizeExtractorDeclaration(receipt.extractor);
  const contractDependencies = contractDependenciesFor(extractorDeclaration);
  const scope = fileScopePayload(receipt.scope);
  if (canonical(scope) !== canonical(receipt.scope)) throw identityError('DELTA_UNIT_RECEIPT_INVALID', 'scope does not match its own declared fields');

  const expectedUnitId = payloadUnitId({ payload_scope: scope, extractor_contract_dependencies: contractDependencies });
  if (expectedUnitId !== receipt.unit_id) throw identityError('DELTA_UNIT_ID_MISMATCH', 'unit_id does not recompute from scope and extractor contract');

  if (!Array.isArray(receipt.inputs)) throw identityError('DELTA_UNIT_RECEIPT_INVALID', 'inputs must be an array');
  // inputReceiptDigest() calls sortInputReceipts() internally, which throws on duplicate tuples.
  const expectedInputReceiptDigest = inputReceiptDigest(receipt.inputs);
  if (expectedInputReceiptDigest !== receipt.input_receipt_digest) {
    throw identityError('DELTA_INPUT_RECEIPT_DIGEST_MISMATCH', 'input_receipt_digest does not recompute from the declared inputs array');
  }
  for (const input of receipt.inputs) {
    if (sha256(canonical(input.identity)) !== input.digest) throw identityError('DELTA_INPUT_RECEIPT_DIGEST_MISMATCH', 'an input receipt digest does not recompute from its identity');
  }

  const expectedProducerContractDigest = producerContractDigest(contractDependencies);
  const expectedProducerContentDigest = producerContentDigest(scope);

  if (!receipt.output || !Array.isArray(receipt.output.records)) throw identityError('DELTA_UNIT_OUTPUT_INVALID', 'output.records must be an array');
  const seen = new Set();
  const observationScope = fileObservationIdentityScope(receipt.scope);
  for (const record of receipt.output.records) {
    const expectedObservationId = observationId({
      identity_contract: extractorDeclaration.identity_contract,
      observation_identity_scope: observationScope,
      extractor_id: extractorDeclaration.id,
      observation_kind: record.identity?.observation_kind,
      producer_local_key: record.identity?.producer_local_key,
    });
    if (expectedObservationId !== record.observation_id) throw identityError('DELTA_OBSERVATION_ID_MISMATCH', 'a record observation_id does not recompute');
    if (seen.has(record.observation_id)) throw identityError('DELTA_DUPLICATE_OBSERVATION_ID', 'duplicate observation_id within one unit', { observation_id: record.observation_id });
    seen.add(record.observation_id);
    if (record.producer_contract_digest !== expectedProducerContractDigest) throw identityError('DELTA_PRODUCER_CONTRACT_DIGEST_MISMATCH', 'record producer_contract_digest does not match the recomputed extractor contract');
    if (record.producer_content_digest !== expectedProducerContentDigest) throw identityError('DELTA_PRODUCER_CONTENT_DIGEST_MISMATCH', 'record producer_content_digest does not match the recomputed payload scope');
    if (record.input_receipt_digest !== expectedInputReceiptDigest) throw identityError('DELTA_INPUT_RECEIPT_DIGEST_MISMATCH', 'record input_receipt_digest does not match the unit input_receipt_digest');
    const expectedRecordDigest = recordDigest({
      output_schema: record.output_schema, observation_id: record.observation_id, normalized_record: record.normalized_record,
      producer_contract_digest: record.producer_contract_digest, producer_content_digest: record.producer_content_digest,
      input_receipt_digest: record.input_receipt_digest,
    });
    if (expectedRecordDigest !== record.record_digest) throw identityError('DELTA_RECORD_DIGEST_MISMATCH', 'record_digest does not recompute from its declared fields');
    if (sha256(canonical(record.normalized_record)) !== record.payload_digest) throw identityError('DELTA_PAYLOAD_DIGEST_MISMATCH', 'payload_digest does not recompute from normalized_record');
  }
  if (canonical(sortRecords(receipt.output.records)) !== canonical(receipt.output.records)) {
    throw identityError('DELTA_UNIT_OUTPUT_INVALID', 'output.records is not stored in its canonical sorted order');
  }
  if (recordsDigest(receipt.output.records) !== receipt.output.records_digest) {
    throw identityError('DELTA_RECORDS_DIGEST_MISMATCH', 'output.records_digest does not recompute from output.records');
  }

  const { receipt_digest: claimedReceiptDigest, ...body } = receipt;
  if (receiptDigest(body) !== claimedReceiptDigest) {
    throw identityError('DELTA_RECEIPT_DIGEST_MISMATCH', 'receipt_digest does not recompute from the receipt body');
  }
  return true;
}
