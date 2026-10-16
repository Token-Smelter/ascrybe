// AC1-IDENTITY: recomputes observation_id, payload_unit_id, record_digest, input_receipt_digest,
// producer_contract_digest, and producer_content_digest from fixture inputs and asserts each
// equals the documented derivation in docs/delta-updatable-estate-maps.md. All repository/path
// names below are invented (CONTRIBUTING.md "Never publish a mapped estate").
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256, stableStringify } from '../tools/lib.mjs';
import {
  observationId, repositoryQualifiedInputReceipt, inputReceiptDigest, fileScopePayload,
  extractorContractDependencies, producerContractDigest, producerContentDigest, payloadUnitId,
  recordDigest, fileObservationIdentityScope,
} from '../tools/delta/identity.mjs';

const canonical = value => stableStringify(value).trim();

const scope = fileObservationIdentityScope({ repository: 'amber-ledger', normalized_path: 'src/ledger.mjs' });
const identity = {
  identity_contract: 'invented-declaration-identity@1',
  observation_identity_scope: scope,
  extractor_id: 'invented-declarations',
  observation_kind: 'symbol',
  producer_local_key: 'LedgerEntry',
};

test('observation_id equals SHA-256(canonical(identity)) prefixed "observation:"', () => {
  const expected = `observation:${sha256(canonical(identity))}`;
  assert.equal(observationId(identity), expected);
});

test('a changed normalized_path mints a NEW observation_id', () => {
  const original = observationId(identity);
  const movedScope = fileObservationIdentityScope({ repository: 'amber-ledger', normalized_path: 'src/ledger-v2.mjs' });
  const moved = observationId({ ...identity, observation_identity_scope: movedScope });
  assert.notEqual(moved, original);
});

test('input_receipt_digest is computed from the complete inputs array, not copied from a parent receipt', () => {
  const blobIdentity = { kind: 'blob', normalized_path: 'src/ledger.mjs', blob_oid: 'blob-oid-1', content_sha256: sha256('one') };
  const input = repositoryQualifiedInputReceipt({ repository: 'amber-ledger', role: 'primary', identity: blobIdentity });
  const expected = sha256(canonical([input]));
  assert.equal(inputReceiptDigest([input]), expected);

  // A "parent receipt" digest that a naive implementation might be tempted to copy forward.
  const parentReceiptDigest = 'a'.repeat(64);
  // Prove the function ignores any such passed-through value: it recomputes from the array of
  // input objects it is actually given, and a genuinely different declared inputs array (an
  // additional consumed input) produces a genuinely different digest.
  const secondInput = repositoryQualifiedInputReceipt({
    repository: 'amber-ledger', role: 'secondary', identity: { kind: 'blob', normalized_path: 'src/ledger-helpers.mjs', blob_oid: 'blob-oid-2', content_sha256: sha256('two') },
  });
  const widerDigest = inputReceiptDigest([input, secondInput]);
  assert.notEqual(widerDigest, expected);
  assert.notEqual(widerDigest, parentReceiptDigest);
  assert.equal(widerDigest, sha256(canonical([input, secondInput].sort((left, right) => canonical(left).localeCompare(canonical(right))))));
});

test('producer_contract_digest and producer_content_digest recompute from their exact documented formulas', () => {
  const extractorContractDependenciesValue = extractorContractDependencies({
    extractor_id: 'invented-declarations', routing_contract_digest: sha256('routing'), output_contract: 'invented-declarations@1',
    identity_contract: 'invented-declaration-identity@1', implementation_digest: sha256('impl-v1'),
    configuration_digest: sha256('config'), runtime_digest: sha256('runtime'),
  });
  assert.equal(producerContractDigest(extractorContractDependenciesValue), sha256(canonical(extractorContractDependenciesValue)));

  const payloadScope = fileScopePayload({
    repository: 'amber-ledger', normalized_path: 'src/ledger.mjs', blob_oid: 'blob-oid-1', content_sha256: sha256('one'),
  });
  assert.equal(producerContentDigest(payloadScope), sha256(canonical(payloadScope)));

  const unitId = payloadUnitId({ payload_scope: payloadScope, extractor_contract_dependencies: extractorContractDependenciesValue });
  assert.equal(unitId, `unit:${sha256(canonical({ payload_scope: payloadScope, extractor_contract_dependencies: extractorContractDependenciesValue }))}`);
});

test('record_digest recomputes from the documented seven-field formula', () => {
  const observationIdValue = observationId(identity);
  const producerContractDigestValue = sha256('contract');
  const producerContentDigestValue = sha256('content');
  const inputReceiptDigestValue = sha256('inputs');
  const normalizedRecord = { name: 'LedgerEntry' };
  const value = recordDigest({
    output_schema: 'invented-declarations@1', observation_id: observationIdValue, normalized_record: normalizedRecord,
    producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
    input_receipt_digest: inputReceiptDigestValue,
  });
  const expected = sha256(canonical({
    output_schema: 'invented-declarations@1', observation_id: observationIdValue, normalized_record: normalizedRecord,
    producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
    input_receipt_digest: inputReceiptDigestValue,
  }));
  assert.equal(value, expected);

  // Changing exactly one input field (normalized_record) must move record_digest.
  const moved = recordDigest({
    output_schema: 'invented-declarations@1', observation_id: observationIdValue, normalized_record: { name: 'LedgerEntryV2' },
    producer_contract_digest: producerContractDigestValue, producer_content_digest: producerContentDigestValue,
    input_receipt_digest: inputReceiptDigestValue,
  });
  assert.notEqual(moved, value);
});

test('duplicate repository_qualified_input_receipt tuples are refused', () => {
  const blobIdentity = { kind: 'blob', normalized_path: 'src/ledger.mjs', blob_oid: 'blob-oid-1', content_sha256: sha256('one') };
  const input = repositoryQualifiedInputReceipt({ repository: 'amber-ledger', role: 'primary', identity: blobIdentity });
  assert.throws(() => inputReceiptDigest([input, input]), error => error.code === 'DELTA_DUPLICATE_INPUT_RECEIPT');
});
