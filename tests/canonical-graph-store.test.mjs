import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDependencyIndex, canonicalObject, CanonicalGraphStore, downstreamCone,
  selectReusableObjects, semanticObjectId, validateDependencyIndex, verifySelectedGraphEquivalence,
} from '../tools/canonical-graph-store.mjs';
import { claimAssertionId } from '../tools/claim-projection.mjs';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import {
  buildAutomaticIdentityConstraint, buildReferent, buildResolutionReceipt,
} from '../tools/referent-identity.mjs';
import {
  buildAssertionSupersessionReceipt, servingAssertionId,
} from '../tools/serving-assertions.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

function resolveScratchRoot(environment = process.env) {
  return environment.ASCRYBE_SCRATCH_DIR || environment.TMPDIR || tmpdir();
}
const scratch = resolveScratchRoot();
const roots = [];
function temporaryRoot(label) {
  const root = mkdtempSync(join(scratch, `estate-map-${label}-`));
  roots.push(root); return root;
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const claim = (id, value = id) => ({
  schema: 'estate-map/documentary-claim/v3.3', id, semantic: { exact: value },
});
const sourceHead = 'source:fixture@1';
const heads = {
  source: sourceHead, identity: '', ontology: '',
  argument_substrate: 'argument-substrate:fixture@1', claim_plane: 'claim-plane:fixture@1',
};

function writeState(store, {
  records, additions = records, historical = [], parent = null, superseded = [],
  supersessionReceipts = [], tombstones = [], validationContract = 'fixture-contract@1',
  segmentSchema = undefined,
}) {
  const added = additions.map(record => store.writeObject(record));
  for (const record of historical) store.writeObject(record);
  const index = buildDependencyIndex({
    records, historical_records: historical, external_heads: heads,
    validation_contract: validationContract,
  });
  const indexObject = store.writeObject(index);
  const references = added.length ? [store.writeSegment(added
    .map(row => ({ semantic_id: row.semantic_id, object_digest: row.digest }))
    .sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)),
  { schema_version: segmentSchema })] : [];
  const commit = store.writeCommit({
    parent_graph_commit_id: parent,
    source_head: sourceHead,
    added_object_digests: added.map(row => row.digest),
    superseded_object_ids: superseded,
    assertion_supersession_receipt_ids: supersessionReceipts,
    tombstones,
    segment_references: references,
    claim_projection_receipts: [],
    dependency_index_digest: indexObject.digest,
  });
  return { commit, index, added, references };
}

function assertion(_label, claimId) {
  const body = { basis_claim_id: claimId, argument_mentions: [] };
  return { schema: 'estate-map/claim-assertion/v1', assertion_id: claimAssertionId(body),
    basis_claim_id: claimId, projection_receipt_id: null, argument_mentions: [] };
}

function projectionReceipt(claimId, assertionIds = [], disposition = 'fully_projected') {
  const body = {
    schema: 'estate-map/claim-projection-receipt/v1', basis_claim_id: claimId,
    disposition, assertion_ids: assertionIds, argument_binding_receipt_ids: [], findings: [],
    projection_schema_version: 'claim-projection@1', materialization_id: 'materialization:fixture',
  };
  return { ...body, receipt_id: `claim-projection-receipt:${sha256(stableStringify(body).trim())}` };
}

function supersessionReceipt(oldId, newId, basisReceiptId) {
  return buildAssertionSupersessionReceipt({
    old_assertion_id: oldId, new_assertion_id: newId, cause: 'rebinding',
    basis_receipt_ids: [basisReceiptId], materialization_id: 'materialization:fixture',
  });
}

test('scratch root falls back when variables are absent and preserves the managed override', () => {
  assert.equal(resolveScratchRoot({}), tmpdir());
  assert.equal(resolveScratchRoot({ ASCRYBE_SCRATCH_DIR: '/managed', TMPDIR: '/ambient' }), '/managed');
});

test('canonical objects use exact deterministic bytes, digest-only paths, and idempotent immutable writes', () => {
  const store = new CanonicalGraphStore(temporaryRoot('objects'));
  const record = claim('claim:a', { z: 1, a: ['exact'] });
  const first = store.writeObject(record), second = store.writeObject(structuredClone(record));
  assert.deepEqual(first, second);
  const path = store.objectPath(first.digest);
  assert.match(path, /objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/u);
  assert.equal(sha256(readFileSync(path)), first.digest);
  assert.deepEqual(store.readObject(first.digest), record);
});

test('object corruption, path/digest mismatch, changed bytes under one semantic ID, and unknown schema fail closed', () => {
  const corrupt = new CanonicalGraphStore(temporaryRoot('corrupt'));
  const written = corrupt.writeObject(claim('claim:a'));
  writeFileSync(corrupt.objectPath(written.digest), '{}\n');
  assert.throws(() => corrupt.readObject(written.digest), error => error.code === 'OBJECT_DIGEST_MISMATCH');

  const mismatched = new CanonicalGraphStore(temporaryRoot('path'));
  const held = mismatched.writeObject(claim('claim:path'));
  const otherDigest = sha256('different-path');
  const otherPath = mismatched.objectPath(otherDigest);
  mkdirSync(dirname(otherPath), { recursive: true });
  copyFileSync(mismatched.objectPath(held.digest), otherPath);
  assert.throws(() => mismatched.readObject(otherDigest), error => error.code === 'OBJECT_DIGEST_MISMATCH');

  const changed = new CanonicalGraphStore(temporaryRoot('changed'));
  changed.writeObject(claim('claim:same', 'before'));
  assert.throws(() => changed.writeObject(claim('claim:same', 'after')),
    error => error.code === 'SEMANTIC_ID_BYTES_CHANGED');
  assert.throws(() => new CanonicalGraphStore(changed.root).writeObject(claim('claim:same', 'after')),
    error => error.code === 'SEMANTIC_ID_BYTES_CHANGED');
  assert.throws(() => changed.writeObject({ schema: 'estate-map/unknown/v1', id: 'unknown:1' }),
    error => error.code === 'UNKNOWN_OBJECT_SCHEMA');
});

test('forged producer identities are rejected at object intake', () => {
  const store = new CanonicalGraphStore(temporaryRoot('forged-intake'));
  const raw = assertion('raw', 'claim:intake');
  const serving = {
    schema: 'estate-map/serving-assertion/v1', assertion_id: raw.assertion_id,
    selected_arguments: [], identity_head: null, raw_argument_bindings: [], raw_assertion: raw,
    materialization_id: 'materialization:fixture',
  };
  serving.serving_assertion_id = servingAssertionId(serving);
  const forged = [
    { ...raw, assertion_id: 'claim-assertion:forged' },
    { ...serving, serving_assertion_id: 'serving-assertion:forged' },
  ];
  const codes = forged.map(record => {
    try { store.writeObject(record); return null; }
    catch (error) { return error.code; }
  });
  assert.deepEqual(codes, ['INVALID_PRODUCER_IDENTITY', 'INVALID_PRODUCER_IDENTITY']);
});

test('identity-constraint store intake reruns basis truth against the exact selected closure', () => {
  const endpoint = (label, role) => {
    const evidence = buildEvidencePointer({
      source_version_id: 'source-version:canonical-reference',
      pointer: {
        kind: 'structured_record', record_id: `canonical-reference:${label}`,
        schema_id: 'estate-map/source-established-canonical-reference/v1',
        field_path: '$.canonical_reference', exact_value: 'canonical:payments',
        digest: sha256('canonical:payments'),
      },
    });
    return buildMention({
      evidence_pointer: evidence, surface: 'canonical:payments', role,
      provenance_class: 'production_document', namespace: 'registry:canonical',
      source_status: 'current', context_digest: evidence.pointer.digest,
      disposition: 'identity_candidate',
    });
  };
  const left = endpoint('left', 'subject'), right = endpoint('right', 'object');
  const constraint = canonicalReference => buildAutomaticIdentityConstraint({
    left: left.mention.mention_id, right: right.mention.mention_id,
    basis: { kind: 'source_established_canonical_reference', canonical_reference: canonicalReference,
      source_version_id: 'source-version:canonical-reference' },
    basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
    source_status: 'current', materialization_id: 'materialization:store-basis-truth',
  });
  const records = [left.evidence, right.evidence, left.mention, right.mention];
  const byId = new Map(records.map(record => [semanticObjectId(record), record]));
  const store = new CanonicalGraphStore(temporaryRoot('constraint-basis-truth'));
  const valid = constraint('canonical:payments');
  const written = store.writeObject(valid, {
    validation_lookup: id => byId.get(id) || null,
  });
  let changed;
  try {
    store.writeObject(constraint('canonical:normalized-payments'), {
      validation_lookup: id => byId.get(id) || null,
    });
  } catch (error) {
    changed = { code: error.code, producer_code: error.detail.producer_code };
  }
  assert.deepEqual({ valid: written.semantic_id, changed }, {
    valid: valid.constraint_id,
    changed: { code: 'INVALID_PRODUCER_IDENTITY',
      producer_code: 'CANONICAL_REFERENCE_BASIS_MISMATCH' },
  });
});

test('duplicate semantic IDs and explicit dangling dependency references fail before commit', () => {
  assert.throws(() => buildDependencyIndex({
    records: [claim('claim:duplicate'), claim('claim:duplicate')], external_heads: heads,
    validation_contract: 'fixture@1',
  }), error => error.code === 'DUPLICATE_SEMANTIC_ID');
  const dangling = assertion('claim-assertion:dangling', 'claim:absent');
  assert.throws(() => buildDependencyIndex({
    records: [dangling], external_heads: heads, validation_contract: 'fixture@1',
  }), error => error.code === 'DANGLING_DEPENDENCY_EDGE');
});

test('segments are deterministic, restart-readable, immutable, and reject truncation, reorder, and overwrite', () => {
  const rows = [claim('claim:a'), claim('claim:b')];
  const store = new CanonicalGraphStore(temporaryRoot('segments'));
  const written = rows.map(row => store.writeObject(row));
  const ordered = written.map(row => ({ semantic_id: row.semantic_id, object_digest: row.digest }));
  const first = store.writeSegment(ordered), second = store.writeSegment(structuredClone(ordered));
  assert.deepEqual(first, second);
  assert.deepEqual(new CanonicalGraphStore(store.root).readSegment(first), ordered);

  const segmentPath = join(store.root, 'segments', `${first.segment_digest}.jsonl`);
  const original = readFileSync(segmentPath, 'utf8');
  writeFileSync(segmentPath, original.slice(0, -1));
  assert.throws(() => store.readSegment(first), error =>
    ['SEGMENT_INTEGRITY_MISMATCH', 'SEGMENT_TRUNCATED'].includes(error.code));

  const reorderedStore = new CanonicalGraphStore(temporaryRoot('segment-reorder'));
  const reorderedWritten = rows.map(row => reorderedStore.writeObject(row));
  const reference = reorderedStore.writeSegment(reorderedWritten.map(row => ({
    semantic_id: row.semantic_id, object_digest: row.digest,
  })));
  const reorderedPath = join(reorderedStore.root, 'segments', `${reference.segment_digest}.jsonl`);
  const lines = readFileSync(reorderedPath, 'utf8').trimEnd().split('\n').reverse();
  writeFileSync(reorderedPath, `${lines.join('\n')}\n`);
  assert.throws(() => reorderedStore.readSegment(reference), error => error.code === 'SEGMENT_INTEGRITY_MISMATCH');

  const overwriteStore = new CanonicalGraphStore(temporaryRoot('segment-overwrite'));
  const overwriteWritten = rows.map(row => overwriteStore.writeObject(row));
  const overwriteReference = overwriteStore.writeSegment(overwriteWritten.map(row => ({
    semantic_id: row.semantic_id, object_digest: row.digest,
  })));
  const overwritePath = join(overwriteStore.root, 'segments', `${overwriteReference.segment_digest}.manifest.json`);
  const manifest = JSON.parse(readFileSync(overwritePath, 'utf8'));
  manifest.row_count += 1;
  writeFileSync(overwritePath, stableStringify(manifest));
  assert.throws(() => overwriteStore.readSegment(overwriteReference), error =>
    ['SEGMENT_INTEGRITY_MISMATCH', 'SEGMENT_ROW_MISMATCH'].includes(error.code));
});

test('replay rejects a segment reused across one commit chain and replay rejects commit additions absent from its segments', () => {
  const store = new CanonicalGraphStore(temporaryRoot('segment-reused'));
  const root = writeState(store, { records: [claim('claim:segment-reused')] });
  const child = store.writeCommit({
    parent_graph_commit_id: root.commit.graph_commit_id, source_head: sourceHead,
    added_object_digests: root.added.map(row => row.digest), segment_references: root.references,
    claim_projection_receipts: [], dependency_index_digest: canonicalObject(root.index).digest,
  });
  assert.throws(() => store.replay(child.graph_commit_id), error => error.code === 'SEGMENT_REUSED');

  const mismatchStore = new CanonicalGraphStore(temporaryRoot('segment-mismatch'));
  const record = claim('claim:segment-mismatch');
  const added = mismatchStore.writeObject(record);
  const index = buildDependencyIndex({
    records: [record], external_heads: heads, validation_contract: 'fixture-contract@1',
  });
  const indexObject = mismatchStore.writeObject(index);
  const commit = mismatchStore.writeCommit({
    source_head: sourceHead, added_object_digests: [added.digest], segment_references: [],
    claim_projection_receipts: [], dependency_index_digest: indexObject.digest,
  });
  assert.throws(() => mismatchStore.replay(commit.graph_commit_id),
    error => error.code === 'COMMIT_SEGMENT_MISMATCH');
});

test('segment identity ignores store path and creation time but preserves row order', () => {
  const records = [claim('claim:a'), claim('claim:b')];
  const left = new CanonicalGraphStore(temporaryRoot('ambient-left'));
  const right = new CanonicalGraphStore(temporaryRoot('ambient-right'));
  const leftRows = records.map(row => left.writeObject(row));
  const rightRows = records.map(row => right.writeObject(row));
  const map = rows => rows.map(row => ({ semantic_id: row.semantic_id, object_digest: row.digest }));
  assert.deepEqual(left.writeSegment(map(leftRows)), right.writeSegment(map(rightRows)));
  assert.throws(() => left.writeSegment(map(leftRows).reverse()), error => error.code === 'INVALID_SEGMENT_ORDER');
});

test('GraphCommit parent replay is restart-readable and missing parent or dependency index fails closed', () => {
  const store = new CanonicalGraphStore(temporaryRoot('commits'));
  const root = writeState(store, { records: [claim('claim:a')] });
  const child = writeState(store, {
    records: [claim('claim:a'), claim('claim:b')], additions: [claim('claim:b')],
    parent: root.commit.graph_commit_id,
  });
  store.advanceReadableHead(child.commit.graph_commit_id);
  const reopened = new CanonicalGraphStore(store.root).readReadableHead();
  assert.deepEqual(Object.keys(reopened.selected_object_map), ['claim:a', 'claim:b']);

  const absent = store.writeCommit({
    parent_graph_commit_id: `graph-commit:${'0'.repeat(64)}`, source_head: sourceHead,
    added_object_digests: [], segment_references: [], claim_projection_receipts: [],
    dependency_index_digest: canonicalObject(root.index).digest,
  });
  assert.throws(() => store.replay(absent.graph_commit_id), error => error.code === 'MISSING_GRAPH_COMMIT');

  const missingIndexStore = new CanonicalGraphStore(temporaryRoot('missing-index'));
  const missing = missingIndexStore.writeCommit({
    source_head: sourceHead, added_object_digests: [], segment_references: [],
    claim_projection_receipts: [], dependency_index_digest: 'f'.repeat(64),
  });
  assert.throws(() => missingIndexStore.replay(missing.graph_commit_id), error => error.code === 'MISSING_OBJECT');
});

test('defensive GraphCommit cycle guard rejects a stubbed cyclic producer chain', () => {
  const store = new CanonicalGraphStore(temporaryRoot('cycle'));
  store.readCommit = id => ({ graph_commit_id: id, parent_graph_commit_id: id });
  assert.throws(() => store.replay(`graph-commit:${'1'.repeat(64)}`), error => error.code === 'GRAPH_COMMIT_CYCLE');
});

test('failed candidate validation never advances a prior readable head', () => {
  const store = new CanonicalGraphStore(temporaryRoot('atomic-head'));
  const root = writeState(store, { records: [claim('claim:a')] });
  store.advanceReadableHead(root.commit.graph_commit_id);
  const invalid = store.writeCommit({
    parent_graph_commit_id: root.commit.graph_commit_id, source_head: sourceHead,
    added_object_digests: [], segment_references: [], claim_projection_receipts: [],
    dependency_index_digest: 'e'.repeat(64),
  });
  assert.throws(() => store.advanceReadableHead(invalid.graph_commit_id));
  assert.equal(store.readReadableHead().graph_commit_id, root.commit.graph_commit_id);
});

test('selected terminal-incomplete receipts prevent premature complete head advance', () => {
  const store = new CanonicalGraphStore(temporaryRoot('premature-complete'));
  const baseClaim = claim('claim:prior-readable');
  const root = writeState(store, { records: [baseClaim] });
  store.advanceReadableHead(root.commit.graph_commit_id);
  const incompleteClaim = claim('claim:incomplete');
  const receipt = projectionReceipt(incompleteClaim.id, [], 'terminal_incomplete');
  const child = writeState(store, {
    records: [baseClaim, incompleteClaim, receipt], additions: [incompleteClaim, receipt],
    parent: root.commit.graph_commit_id,
  });
  let replayCode = null;
  let advanceCode = null;
  try { store.replay(child.commit.graph_commit_id); } catch (error) { replayCode = error.code; }
  try { store.advanceReadableHead(child.commit.graph_commit_id); } catch (error) { advanceCode = error.code; }
  assert.deepEqual({ replayCode, advanceCode, readable: store.readReadableHead().graph_commit_id }, {
    replayCode: 'COMMIT_INCOMPLETE_SET_MISMATCH',
    advanceCode: 'COMMIT_INCOMPLETE_SET_MISMATCH',
    readable: root.commit.graph_commit_id,
  });
});

test('dependency indexes commit exact content, invalidate only the downstream cone, and gate reuse by pinned contract', () => {
  const base = [claim('claim:a'), claim('claim:b'), claim('claim:c')];
  const index = buildDependencyIndex({ records: base, external_heads: heads, validation_contract: 'contract@1' });
  const changedContract = buildDependencyIndex({ records: base, external_heads: heads, validation_contract: 'contract@2' });
  assert.deepEqual(downstreamCone(index, ['claim:b']), ['claim:b']);
  assert.deepEqual(selectReusableObjects({ previous_index: index, next_index: index }), ['claim:a', 'claim:b', 'claim:c']);
  assert.deepEqual(selectReusableObjects({ previous_index: index, next_index: changedContract }), []);

  const omitted = structuredClone(index);
  omitted.entries.pop();
  const { index_id: _id, ...body } = omitted;
  omitted.index_id = `dependency-index:${sha256(Buffer.from(stableStringify(body)))}`;
  assert.throws(() => validateDependencyIndex(omitted, {
    selected_map: new Map(base.map(row => {
      const held = canonicalObject(row); return [semanticObjectId(row), held.digest];
    })),
  }), error => error.code === 'DEPENDENCY_INDEX_OMISSION');
});

test('reuse denies an unchanged dependent when its dependency digest changes', () => {
  const before = claim('claim:dependency', 'before');
  const after = claim('claim:dependency', 'after');
  const dependent = assertion('dependent', before.id);
  const previous = buildDependencyIndex({
    records: [before, dependent], external_heads: heads, validation_contract: 'contract@1',
  });
  const next = buildDependencyIndex({
    records: [after, dependent], external_heads: heads, validation_contract: 'contract@1',
  });
  assert.equal(selectReusableObjects({ previous_index: previous, next_index: next })
    .includes(dependent.assertion_id), false);
});

test('serving assertion identity provenance reaches the downstream cone', () => {
  const evidence = id => ({ schema: 'estate-map/evidence-pointer/v1', evidence_id: id });
  const mention = (id, evidenceId) => ({
    schema: 'estate-map/mention/v1', mention_id: id, evidence_id: evidenceId,
  });
  const leftEvidence = evidence('evidence:left'), rightEvidence = evidence('evidence:right');
  const left = mention('mention:left', leftEvidence.evidence_id);
  const right = mention('mention:right', rightEvidence.evidence_id);
  const constraint = {
    schema: 'estate-map/identity-constraint/v1', constraint_id: 'identity-constraint:blocker',
    left: left.mention_id, right: right.mention_id, basis_evidence_ids: [], basis_assertion_ids: [],
  };
  const conflict = {
    schema: 'estate-map/identity-conflict/v1', conflict_id: 'identity-conflict:blocker',
    candidate_mention_ids: [left.mention_id, right.mention_id],
    blocking_constraint_id: constraint.constraint_id,
  };
  const resolution = {
    schema: 'estate-map/resolution-receipt/v1', receipt_id: 'resolution-receipt:bound',
    candidate_mention_ids: [left.mention_id, right.mention_id],
    selected_referent_id: 'referent:bound', identity_constraint_ids: [constraint.constraint_id],
    conflict_ids: [conflict.conflict_id], supersedes_receipt_id: null,
  };
  const referent = {
    schema: 'estate-map/referent/v1', referent_id: resolution.selected_referent_id,
    creation_receipt_id: resolution.receipt_id,
  };
  const raw = {
    schema: 'estate-map/grounded-assertion/v1', assertion_id: 'grounded-assertion:bound',
    basis_evidence_ids: [], basis_receipt_ids: [], arguments: [],
  };
  const serving = {
    schema: 'estate-map/serving-assertion/v1', serving_assertion_id: 'serving-assertion:bound',
    assertion_id: raw.assertion_id,
    selected_arguments: [{
      resolution_receipt_id: resolution.receipt_id, referent_id: referent.referent_id,
      conflict_ids: [conflict.conflict_id], blocking_constraint_ids: [constraint.constraint_id],
    }],
  };
  const index = buildDependencyIndex({
    records: [leftEvidence, rightEvidence, left, right, constraint, conflict, resolution, referent, raw, serving],
    external_heads: heads, validation_contract: 'contract@1',
  });
  const roots = [resolution.receipt_id, referent.referent_id, conflict.conflict_id, constraint.constraint_id];
  assert.deepEqual(Object.fromEntries(roots.map(id =>
    [id, downstreamCone(index, [id]).includes(serving.serving_assertion_id)])), {
    [resolution.receipt_id]: true,
    [referent.referent_id]: true,
    [conflict.conflict_id]: true,
    [constraint.constraint_id]: true,
  });
});

test('dependency cone follows explicit edges and never invalidates an unrelated object', () => {
  const a = claim('claim:a');
  const b = assertion('claim-assertion:b', 'claim:a');
  const c = claim('claim:c');
  const index = buildDependencyIndex({ records: [a, b, c], external_heads: heads, validation_contract: 'contract@1' });
  assert.deepEqual(downstreamCone(index, ['claim:a']), [b.assertion_id, 'claim:a']);
});

test('supersession requires one exact receipt, keeps old bytes addressable, and tombstones reject absence or repetition', () => {
  const identityStore = new CanonicalGraphStore(temporaryRoot('referent-fixture'));
  const resolution = buildResolutionReceipt({
    candidate_mention_ids: [], disposition: 'unresolved', excluded_mention_ids: [],
    materialization_id: 'materialization:fixture',
  });
  const referent = buildReferent({
    identity_kind: 'resolved_opaque', creation_receipt_id: resolution.receipt_id,
  });
  const identity = writeState(identityStore, { records: [referent, resolution] });
  assert.deepEqual(Object.keys(identityStore.replay(identity.commit.graph_commit_id).selected_object_map),
    [referent.referent_id, resolution.receipt_id].sort());

  const store = new CanonicalGraphStore(temporaryRoot('supersession'));
  const oldClaim = claim('claim:old'), newClaim = claim('claim:new');
  const oldAssertion = assertion('claim-assertion:old', oldClaim.id);
  const newAssertion = assertion('claim-assertion:new', newClaim.id);
  const rootRecords = [oldClaim, oldAssertion];
  const root = writeState(store, { records: rootRecords });

  const withoutReceiptIndex = buildDependencyIndex({ records: [newClaim, newAssertion], historical_records: rootRecords,
    external_heads: heads, validation_contract: 'fixture-contract@1' });
  const withoutReceiptIndexObject = store.writeObject(withoutReceiptIndex);
  const added = [newClaim, newAssertion].map(row => store.writeObject(row));
  const segment = store.writeSegment(added.map(row => ({ semantic_id: row.semantic_id, object_digest: row.digest }))
    .sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)));
  const bad = store.writeCommit({
    parent_graph_commit_id: root.commit.graph_commit_id, source_head: sourceHead,
    added_object_digests: added.map(row => row.digest), superseded_object_ids: [oldAssertion.assertion_id],
    segment_references: [segment], claim_projection_receipts: [],
    dependency_index_digest: withoutReceiptIndexObject.digest,
  });
  assert.throws(() => store.replay(bad.graph_commit_id), error => error.code === 'SUPERSESSION_WITHOUT_RECEIPT');

  const basisReceipt = projectionReceipt(newClaim.id, [newAssertion.assertion_id]);
  const receipt = supersessionReceipt(oldAssertion.assertion_id, newAssertion.assertion_id,
    basisReceipt.receipt_id);
  const selected = [oldClaim, newClaim, newAssertion, basisReceipt, receipt];
  const valid = writeState(store, {
    records: selected, additions: [newClaim, newAssertion, basisReceipt, receipt], historical: rootRecords,
    parent: root.commit.graph_commit_id, superseded: [oldAssertion.assertion_id],
    supersessionReceipts: [receipt.receipt_id],
  });
  const replay = store.replay(valid.commit.graph_commit_id);
  assert.equal(replay.selected_object_map[oldAssertion.assertion_id], undefined);
  assert.deepEqual(store.readObject(canonicalObject(oldAssertion).digest), oldAssertion);

  const tombstoneStore = new CanonicalGraphStore(temporaryRoot('tombstone'));
  const tombstoneRoot = writeState(tombstoneStore, { records: [claim('claim:tombstone')] });
  const tombstone = writeState(tombstoneStore, {
    records: [], additions: [], historical: [claim('claim:tombstone')],
    parent: tombstoneRoot.commit.graph_commit_id, tombstones: ['claim:tombstone'],
  });
  assert.equal(tombstoneStore.replay(tombstone.commit.graph_commit_id).selected_object_map['claim:tombstone'], undefined);
  const doubled = writeState(tombstoneStore, {
    records: [], additions: [], historical: [claim('claim:tombstone')],
    parent: tombstone.commit.graph_commit_id, tombstones: ['claim:tombstone'],
  });
  assert.throws(() => tombstoneStore.replay(doubled.commit.graph_commit_id), error => error.code === 'DOUBLE_TOMBSTONE');
});

test('replay rejects resurrection of a tombstoned semantic object', () => {
  const store = new CanonicalGraphStore(temporaryRoot('resurrected-tombstone'));
  const record = claim('claim:resurrected');
  const root = writeState(store, { records: [record] });
  const tombstone = writeState(store, {
    records: [], additions: [], historical: [record], parent: root.commit.graph_commit_id,
    tombstones: [record.id],
  });
  const resurrected = writeState(store, {
    records: [record], additions: [record], parent: tombstone.commit.graph_commit_id,
    segmentSchema: 'graph-segment@resurrection-test',
  });
  assert.throws(() => store.replay(resurrected.commit.graph_commit_id),
    error => error.code === 'RESURRECTED_TOMBSTONE');
});

test('clean and incremental divergence is detected by independent selected maps', () => {
  const records = [claim('claim:a'), claim('claim:b')];
  const cleanStore = new CanonicalGraphStore(temporaryRoot('clean'));
  const clean = writeState(cleanStore, { records });
  const incrementalStore = new CanonicalGraphStore(temporaryRoot('incremental'));
  const first = writeState(incrementalStore, { records: [records[0]] });
  const second = writeState(incrementalStore, { records, additions: [records[1]], parent: first.commit.graph_commit_id });
  const cleanReplay = cleanStore.replay(clean.commit.graph_commit_id);
  const incrementalReplay = incrementalStore.replay(second.commit.graph_commit_id);
  assert.equal(verifySelectedGraphEquivalence(cleanReplay, incrementalReplay), true);
  const divergentStore = new CanonicalGraphStore(temporaryRoot('divergent'));
  const divergent = writeState(divergentStore, { records: [records[0]] });
  assert.throws(() => verifySelectedGraphEquivalence(cleanReplay,
    divergentStore.replay(divergent.commit.graph_commit_id)),
  error => error.code === 'CLEAN_INCREMENTAL_DIVERGENCE');
});
