import fs from './readonly-guard.mjs';
import path from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const RECONCILIATION_EDGE_SCHEMA = 'estate-map/reconciliation-edge/v1';
export const RECONCILIATION_EDGE_VERSION = 1;
export const RECONCILIATION_EDGES_FILE = 'reconciliation-edges.jsonl';
export const CENSUS_VECTOR_FILE = 'latest-census-vector.json';
export const ACTIVE_VECTOR_FILE = 'latest-active-vector.json';
export const RECONCILIATION_STATES = Object.freeze(['implements', 'contradicts', 'undocumented', 'unverifiable', 'confirmed_dead']);

const readJsonl = async file => {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

const appendJsonl = async (file, rows) => {
  if (!rows.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
};

const stateOrNull = (state, label) => {
  if (state !== null && !RECONCILIATION_STATES.includes(state)) throw new Error(`${label} must be null or a reconciliation state`);
};

export function validateReconciliationEdge(record, label = 'reconciliation_edge') {
  const required = ['schema', 'version', 'edge_id', 'subject', 'queue', 'previous_state', 'current_state', 'witnesses', 'corpus_digest', 'adjudication', 'resolution', 'transition_history', 'recorded_at'];
  const missing = required.filter(field => record?.[field] === undefined);
  if (missing.length) throw new Error(`${label} is missing required field(s): ${missing.join(', ')}`);
  if (record.schema !== RECONCILIATION_EDGE_SCHEMA) throw new Error(`${label}.schema must be ${RECONCILIATION_EDGE_SCHEMA}`);
  if (record.version !== RECONCILIATION_EDGE_VERSION) throw new Error(`${label}.version must be ${RECONCILIATION_EDGE_VERSION}`);
  if (typeof record.edge_id !== 'string' || !record.edge_id) throw new Error(`${label}.edge_id must be a non-empty string`);
  if (!record.subject || typeof record.subject.queue_entry_digest !== 'string' || !record.subject.queue_entry_digest) throw new Error(`${label}.subject.queue_entry_digest must be a non-empty string`);
  if (record.queue !== record.subject.queue) throw new Error(`${label}.queue must match subject.queue`);
  stateOrNull(record.previous_state, `${label}.previous_state`);
  stateOrNull(record.current_state, `${label}.current_state`);
  if (!Array.isArray(record.witnesses)) throw new Error(`${label}.witnesses must be an array`);
  if (typeof record.corpus_digest !== 'string' || !record.corpus_digest) throw new Error(`${label}.corpus_digest must be a non-empty string`);
  if (!record.adjudication?.adjudication_key || !record.adjudication?.verdict) throw new Error(`${label}.adjudication must identify accepted ledger provenance`);
  if (record.resolution?.status !== 'resolved' || record.resolution?.delta !== -1) throw new Error(`${label}.resolution must be a resolved -1 queue drain`);
  if (!Array.isArray(record.transition_history) || !record.transition_history.length) throw new Error(`${label}.transition_history must be non-empty`);
  return record;
}

export async function readReconciliationEdges(stateDir) {
  return readJsonl(path.join(stateDir, RECONCILIATION_EDGES_FILE));
}

/**
 * Append accepted drains as immutable edge revisions. A later revision retains the complete
 * prior transition history; old JSONL rows also remain, so neither an old state nor the fact
 * it was superseded can disappear through a projection refresh.
 */
export async function appendReconciliationEdges(stateDir, plans, { now = new Date().toISOString() } = {}) {
  const existing = await readReconciliationEdges(stateDir);
  const byId = new Map();
  const acceptedKeys = new Set();
  for (const edge of existing) {
    validateReconciliationEdge(edge);
    byId.set(edge.edge_id, edge);
    acceptedKeys.add(edge.adjudication.adjudication_key);
  }
  const appended = [];
  for (const plan of plans) {
    if (acceptedKeys.has(plan.adjudication_key)) continue;
    const edgeId = sha256(stableStringify({ queue: plan.queue, queue_entry_digest: plan.queue_entry_digest }));
    const prior = byId.get(edgeId);
    const previousState = prior?.current_state ?? plan.previous_state ?? null;
    const event = {
      at: now,
      previous_state: previousState,
      current_state: plan.current_state ?? null,
      corpus_digest: plan.corpus_digest,
      adjudication_key: plan.adjudication_key,
      verdict: plan.verdict,
    };
    const edge = validateReconciliationEdge({
      schema: RECONCILIATION_EDGE_SCHEMA,
      version: RECONCILIATION_EDGE_VERSION,
      edge_id: edgeId,
      subject: { queue: plan.queue, queue_entry_digest: plan.queue_entry_digest, label: plan.subject },
      queue: plan.queue,
      previous_state: previousState,
      current_state: plan.current_state ?? null,
      witnesses: plan.witnesses || [],
      corpus_digest: plan.corpus_digest,
      adjudication: {
        adjudication_key: plan.adjudication_key,
        claim_type: plan.claim_type,
        verdict: plan.verdict,
        adjudicator: plan.adjudicator,
        adjudicator_family: plan.adjudicator_family,
        ledger_schema: plan.ledger_schema,
      },
      resolution: { status: 'resolved', delta: -1 },
      transition_history: [...(prior?.transition_history || []), event],
      recorded_at: now,
    });
    appended.push(edge);
    byId.set(edgeId, edge);
    acceptedKeys.add(plan.adjudication_key);
  }
  await appendJsonl(path.join(stateDir, RECONCILIATION_EDGES_FILE), appended);
  return { existing, appended, edges: [...existing, ...appended] };
}

/** ACTIVE is a pure projection of persisted resolved edges, never a ledger-row exclusion. */
export function projectActiveVector(census, edges, corpusDigest) {
  const active = { ...census };
  const drained = [];
  const seenSubjects = new Set();
  for (const edge of edges) {
    validateReconciliationEdge(edge);
    if (edge.corpus_digest !== corpusDigest || edge.resolution.status !== 'resolved') continue;
    const subjectKey = `${edge.queue}\0${edge.subject.queue_entry_digest}`;
    if (seenSubjects.has(subjectKey) || !Number.isInteger(active[edge.queue]) || active[edge.queue] <= 0) continue;
    seenSubjects.add(subjectKey);
    active[edge.queue] += edge.resolution.delta;
    drained.push({ edge_id: edge.edge_id, queue: edge.queue, subject: edge.subject.label, verdict: edge.adjudication.verdict });
  }
  return { census: { ...census }, active, drained, resolved_edge_count: drained.length };
}
