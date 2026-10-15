// First-class hypergraph DisagreementCase store (DESIGN §16.12.1).
//
// A DisagreementCase is the DURABLE record. It binds MANY participants across distinct kinds
// (documents, observations, releases, supersession chains, evidence receipts, claims). A binary
// `CONTRADICTS` edge is NOT the stored form — it is only a derived rendering projection computed
// from a case on demand. Storing a binary contradiction would collapse the hyperedge and lose the
// multi-party structure the design requires; the store therefore REJECTS a stored `contradicts`
// field and only ever emits CONTRADICTS via renderContradictsProjection().
//
// Immutable, content-addressed, snapshot-bound, provenance-bound. No provider/model path.
import { sha256, stableStringify } from './lib.mjs';

export const DISAGREEMENT_CASE_SCHEMA = 'estate-map/disagreement-case/v1';
export const DISAGREEMENT_CASE_NAMESPACE = 'disagreement-case';
// The hyperedge participant kinds. Every case carries all six keys (arrays; may be empty).
export const CASE_REF_KINDS = Object.freeze([
  'documents', 'observations', 'releases', 'supersession_chains', 'evidence_receipts', 'claims',
]);
// A case whose evidence has not discharged it stays drawable in one of these states.
export const CASE_STATES = Object.freeze(['unresolved', 'contradicted', 'superseded', 'resolved']);

export class DisagreementCaseError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'DisagreementCaseError';
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

const isBlank = value => value === undefined || value === null || value === '';

/** Validates and canonicalises a case body into an immutable, content-addressed record. */
export function createDisagreementCase(body, { snapshot } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DisagreementCaseError('INVALID_CASE', 'disagreement case must be an object');
  if (isBlank(body.case_kind) || typeof body.case_kind !== 'string') throw new DisagreementCaseError('MISSING_CASE_KIND', 'disagreement case requires a case_kind string');
  if (Object.hasOwn(body, 'contradicts') || Object.hasOwn(body, 'contradicts_edge')) {
    throw new DisagreementCaseError('CONTRADICTS_MUST_BE_DERIVED', 'a binary CONTRADICTS edge is a rendering projection and must not be stored on a case');
  }
  if (!body.state || !CASE_STATES.includes(body.state)) throw new DisagreementCaseError('INVALID_STATE', `disagreement case state must be one of ${CASE_STATES.join('|')}`);
  const snap = snapshot || body.snapshot;
  if (!snap || isBlank(snap.source_sha) || isBlank(snap.corpus_digest)) throw new DisagreementCaseError('MISSING_SNAPSHOT', 'disagreement case must be snapshot-bound { source_sha, corpus_digest }');
  const refs = {};
  let participants = 0;
  const populatedKinds = new Set();
  for (const kind of CASE_REF_KINDS) {
    const value = body[kind] ?? [];
    if (!Array.isArray(value)) throw new DisagreementCaseError('INVALID_REFS', `case ${kind} must be an array`, { kind });
    refs[kind] = value.slice();
    participants += value.length;
    if (value.length) populatedKinds.add(kind);
  }
  // Hypergraph shape: a case must bind more than a single participant, otherwise it is a binary
  // edge in disguise. Either ≥2 participants overall, or participants across ≥2 distinct kinds.
  if (participants < 2 && populatedKinds.size < 2) {
    throw new DisagreementCaseError('NOT_A_HYPEREDGE', 'a disagreement case must bind multiple participants (≥2 refs, or refs across ≥2 kinds)', { participants, kinds: [...populatedKinds] });
  }
  const provenance = body.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || !Array.isArray(provenance.spans) || !provenance.spans.length) {
    throw new DisagreementCaseError('MISSING_PROVENANCE', 'disagreement case requires provenance with non-empty spans');
  }
  const semantic = {
    case_kind: body.case_kind,
    state: body.state,
    ...refs,
    provenance: { document_ids: Array.isArray(provenance.document_ids) ? provenance.document_ids.slice() : [], spans: provenance.spans.slice() },
    snapshot: { source_sha: snap.source_sha, corpus_digest: snap.corpus_digest },
  };
  const id = `${DISAGREEMENT_CASE_NAMESPACE}:${sha256(stableStringify(semantic))}`;
  return deepFreeze({ schema: DISAGREEMENT_CASE_SCHEMA, namespace: DISAGREEMENT_CASE_NAMESPACE, id, semantic });
}

/**
 * Derives binary CONTRADICTS edges from a stored hyperedge case. This is a PROJECTION: the edges
 * are computed on demand, never persisted. Each edge names the case it was derived from so the
 * renderer can always navigate back to the full multi-party record.
 */
export function renderContradictsProjection(caseRecord) {
  if (!caseRecord?.semantic) throw new DisagreementCaseError('INVALID_CASE', 'cannot project a non-case');
  const sem = caseRecord.semantic;
  const nodes = CASE_REF_KINDS.flatMap(kind => sem[kind].map(ref => ({ kind, ref })));
  const edges = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      edges.push({
        relation: 'CONTRADICTS',
        from: nodes[i],
        to: nodes[j],
        derived_from_case: caseRecord.id,
        derived: true,
      });
    }
  }
  return edges;
}

/** Append-only, content-addressed, snapshot-bound store of DisagreementCase records. */
export function createDisagreementCaseStore({ snapshot } = {}) {
  if (!snapshot || isBlank(snapshot.source_sha) || isBlank(snapshot.corpus_digest)) {
    throw new DisagreementCaseError('INVALID_SNAPSHOT', 'disagreement case store requires a snapshot { source_sha, corpus_digest }');
  }
  const boundSnapshot = Object.freeze({ source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest });
  const entries = [];
  const byId = new Map();

  const add = body => {
    const caseRecord = createDisagreementCase(body, { snapshot: body.snapshot || boundSnapshot });
    if (caseRecord.semantic.snapshot.source_sha !== boundSnapshot.source_sha || caseRecord.semantic.snapshot.corpus_digest !== boundSnapshot.corpus_digest) {
      throw new DisagreementCaseError('SNAPSHOT_MISMATCH', 'disagreement case is not bound to this store snapshot', { id: caseRecord.id });
    }
    if (byId.has(caseRecord.id)) return { status: 'deduped', id: caseRecord.id };
    entries.push(caseRecord);
    byId.set(caseRecord.id, caseRecord);
    return { status: 'added', id: caseRecord.id };
  };

  return Object.freeze({
    schema: DISAGREEMENT_CASE_SCHEMA,
    namespace: DISAGREEMENT_CASE_NAMESPACE,
    snapshot: boundSnapshot,
    add,
    addAll: bodies => bodies.map(add),
    get: id => byId.get(id) ?? null,
    list: () => entries.slice(),
    size: () => entries.length,
    // Binary CONTRADICTS is a rendering projection across the whole store; never a stored form.
    renderContradicts: () => entries.flatMap(renderContradictsProjection),
  });
}
