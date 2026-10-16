// Immutable, append-only, content-addressed documentary-claim ledger (DESIGN §16.12).
//
// This is a SEPARATE authority plane from the deterministic observation ledger. It stores only
// ratified documentary claims (adjudication-schema `claim` records) and enforces the promotion
// boundary: a documentary/neural claim NEVER becomes a deterministic observation except through a
// reviewed mechanized check that lives elsewhere. It has no provider, producer, or model path.
//
// Discipline mirrors the observation ledger (neural-census.mjs / l1-adjudicate.mjs): snapshot
// binding, content-addressed ids, deep-freeze, append-only id-dedupe, conservation, typed errors.
import { validateRecord } from './adjudication-schema.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const CLAIM_LEDGER_SCHEMA = 'estate-map/documentary-claim-ledger/v1';
export const CLAIM_LEDGER_NAMESPACE = 'documentary-claim';
export const OBSERVATION_NAMESPACE = 'deterministic-observation';

export class ClaimLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimLedgerError';
    this.code = code;
    this.detail = detail;
  }
}

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Creates a snapshot-bound documentary-claim ledger. Every appended claim must be a valid
 * `claim` record bound to the ledger's snapshot; appends are idempotent by content-addressed id.
 */
export function createDocumentaryClaimLedger({ snapshot } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.source_sha || !snapshot.corpus_digest) {
    throw new ClaimLedgerError('INVALID_SNAPSHOT', 'documentary-claim ledger requires a snapshot { source_sha, corpus_digest }', { snapshot });
  }
  const boundSnapshot = Object.freeze({ source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest });
  const entries = [];
  const byId = new Map();
  const counters = { attempts: 0, appended: 0, deduped: 0, rejected: 0 };

  const rejectAppend = (code, message, detail) => { counters.rejected += 1; throw new ClaimLedgerError(code, message, detail); };

  const append = record => {
    counters.attempts += 1;
    // The observation plane is deterministic-only; a documentary claim may never masquerade as one.
    if (record && typeof record === 'object' && record.record_kind && record.record_kind !== 'claim') {
      rejectAppend('WRONG_PLANE', `documentary-claim ledger only stores claims, got ${record.record_kind}`, { record_kind: record.record_kind });
    }
    let validated;
    try { validated = validateRecord(record, { expectedKind: 'claim' }); }
    catch (error) { rejectAppend('INVALID_CLAIM', error.message, { cause: error.message }); }
    const sem = validated.semantic;
    if (sem.namespace === OBSERVATION_NAMESPACE || sem.plane === 'observation' || Object.hasOwn(sem, 'observation_id') || sem.promoted === true) {
      rejectAppend('PROMOTION_BOUNDARY_VIOLATION', 'a documentary claim may not enter the deterministic observation plane', { id: validated.id });
    }
    if (sem.source_sha !== boundSnapshot.source_sha || sem.corpus_digest !== boundSnapshot.corpus_digest) {
      rejectAppend('SNAPSHOT_MISMATCH', 'claim is not bound to this ledger snapshot', { id: validated.id, expected: boundSnapshot, got: { source_sha: sem.source_sha, corpus_digest: sem.corpus_digest } });
    }
    if (byId.has(validated.id)) { counters.deduped += 1; return { status: 'deduped', id: validated.id, position: byId.get(validated.id).position }; }
    const content_hash = sha256(stableStringify(validated));
    const prev_content_hash = entries.length ? entries[entries.length - 1].content_hash : null;
    const entry = deepFreeze({ namespace: CLAIM_LEDGER_NAMESPACE, position: entries.length, content_hash, prev_content_hash, record: validated });
    entries.push(entry);
    byId.set(validated.id, entry);
    counters.appended += 1;
    return { status: 'appended', id: validated.id, position: entry.position, content_hash };
  };

  const appendAll = records => {
    if (!Array.isArray(records)) throw new ClaimLedgerError('INVALID_BATCH', 'appendAll expects an array of claim records');
    return records.map(append);
  };

  // The promotion boundary is a hard wall: there is no code path from claim to observation here.
  const promoteToObservation = () => rejectAppend('PROMOTION_BOUNDARY_VIOLATION', 'documentary claims are never promoted into deterministic observations');

  const assertConservation = () => {
    const stored = entries.length;
    if (stored !== byId.size) throw new ClaimLedgerError('CONSERVATION_FAILED', `stored rows ${stored} != unique ids ${byId.size}`, { stored, unique: byId.size });
    if (counters.appended !== stored) throw new ClaimLedgerError('CONSERVATION_FAILED', `appended counter ${counters.appended} != stored ${stored}`, { ...counters, stored });
    const positions = entries.map(entry => entry.position);
    if (positions.some((position, index) => position !== index)) throw new ClaimLedgerError('CONSERVATION_FAILED', 'append positions are not a dense 0..n sequence', { positions });
    let prev = null;
    for (const entry of entries) {
      if (entry.prev_content_hash !== prev) throw new ClaimLedgerError('CONSERVATION_FAILED', 'content-hash chain is broken', { position: entry.position });
      prev = entry.content_hash;
    }
    return { namespace: CLAIM_LEDGER_NAMESPACE, snapshot: boundSnapshot, ...counters, stored };
  };

  return Object.freeze({
    schema: CLAIM_LEDGER_SCHEMA,
    namespace: CLAIM_LEDGER_NAMESPACE,
    snapshot: boundSnapshot,
    append,
    appendAll,
    promoteToObservation,
    assertConservation,
    get: id => byId.get(id)?.record ?? null,
    has: id => byId.has(id),
    list: () => entries.map(entry => entry.record),
    entries: () => entries.slice(),
    size: () => entries.length,
    counters: () => ({ ...counters }),
  });
}
