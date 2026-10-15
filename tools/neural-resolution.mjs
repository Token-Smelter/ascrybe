// Source-grounded resolution / adjudication stage (slice 4 of intent-779029e6, DESIGN §16.12.1).
// This is the DECONFLICTION the census exists for: it turns a comparison RELATION into a
// post-evidence RESOLUTION by READING THE CITED SOURCES of every side.
//
// TWO DISTINCT VOCABULARIES (never collapsed):
//   * comparison relations (ten): equivalent_proposition … incomparable  (surface relationship)
//   * resolutions (eleven): supported … unverifiable                     (post-evidence diagnosis)
// A resolution record carries BOTH the originating comparison relation and its assigned resolution,
// as separate fields, so the two axes stay independent (DESIGN §16.12.1: "must not be collapsed").
//
// SOURCE > MODEL PROSE. The adjudicator is handed the VERBATIM cited source excerpts of each side
// (retained by the neural extractor). It must decide from those spans — model agreement is NOT
// evidence. The rationale must quote a specific source span. Pair conflict, each claim's grounding
// against its own source, and scope/time/modality/referent context are recorded independently.
//
// QUARANTINE + PROMOTION BOUNDARY. Resolutions are immutable, content-addressed, snapshot-bound
// records in their OWN plane. They never enter the deterministic observation plane; the store
// rejects any body that tags itself as an observation. A staged resolution_key gates reuse.
//
// MODEL ACCESS. Reached ONLY through invokeModelRunner(runner, …); a runner must be injected.
import { COMPARISON_RELATIONS } from './comparison-relation-classifier.mjs';
import { relationFromCaseKind } from './documentation-claim-census.mjs';
import { resolutionKey } from './census-keys.mjs';
import { invokeModelRunner, isTimeoutOutcome } from './neural-census-producers.mjs';
import { assertInferencePromptWithinLimit, INFERENCE_CUSTODY_POLICY, interruptedInferenceCustody, openInferenceCircuit } from './inference-custody.mjs';
import { parseCensusModelJson } from './neural-json.mjs';
import { mapWithRunnerPool, normalizeRunnerPool } from './neural-runner-pool.mjs';
import { combineModelStats, modelStatsDelta, modelStatsSnapshot } from './model-usage.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const RESOLUTION_SCHEMA = 'estate-map/documentary-resolution/v2';
export const RESOLUTION_NAMESPACE = 'documentary-resolution';
export const OBSERVATION_NAMESPACE = 'deterministic-observation';
// The eleven ratified post-evidence resolution states (contract order, DESIGN §16.12.1).
export const ELEVEN_RESOLUTIONS = Object.freeze([
  'supported', 'refuted', 'inconsistent', 'underdetermined', 'stale', 'superseded',
  'implemented', 'not_implemented', 'intentionally_waived', 'ill_typed', 'unverifiable',
]);
export const PAIR_CONFLICT_STATES = Object.freeze(['conflict', 'no_conflict', 'underdetermined']);
export const SIDE_GROUNDING_STATES = Object.freeze(['supported', 'refuted', 'underdetermined', 'unverifiable']);
export const CONTEXT_AXES = Object.freeze(['scope', 'time', 'modality', 'referent']);
export const CONTEXT_AXIS_STATES = Object.freeze(['same', 'different', 'overlapping', 'unknown']);
export const EVIDENCE_PROTOCOL_VERSION = 'slice-4/source-grounded-adjudication@2';
export const VERIFIER_CONTRACT_VERSION = 'slice-4/split-conflict-grounding-context@2';
export const RESOLUTION_ADJUDICATOR_VERSION = 'slice-4/neural-resolution-adjudicator@2';

export class ResolutionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ResolutionError';
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
const isBlank = value => value === undefined || value === null || String(value).trim() === '';
const text = value => String(value ?? '');

/** Extract one side's cited sources (verbatim excerpts + spans) from a claim record. */
export function sideFromClaim(claim) {
  const sem = claim?.semantic ?? claim ?? {};
  const prov = sem.provenance ?? {};
  const spans = Array.isArray(prov.spans) && prov.spans.length ? prov.spans : (Array.isArray(sem.spans) ? sem.spans : []);
  const rawExcerpts = Array.isArray(prov.source_excerpts) && prov.source_excerpts.length
    ? prov.source_excerpts
    : spans.map(span => ({ file: span.file ?? span.path ?? null, start: span.start ?? span.line ?? null, end: span.end ?? span.line ?? null, text: span.excerpt ?? span.text ?? '' }));
  const excerpts = rawExcerpts.filter(excerpt => text(excerpt.text).trim());
  return {
    claim_id: claim?.id ?? null,
    document_id: prov.document_id ?? sem.source_path ?? null,
    subject: sem.subject_refs?.[0]?.ref ?? null,
    predicate_family: sem.predicate_family ?? null,
    object_or_value: sem.object_or_value ?? null,
    polarity: sem.polarity ?? null,
    modality: sem.modality ?? null,
    quantifier: sem.quantifier ?? null,
    scope: sem.scope ?? null,
    valid_time: sem.valid_time ?? null,
    excerpts,
  };
}

/** Build the source-grounded adjudication prompt handing the model each side's verbatim sources. */
export function buildAdjudicationPrompt({ relation, sides }) {
  const sideBlocks = sides.map((side, index) => [
    `SIDE ${index + 1} (claim ${side.claim_id}, document ${side.document_id}):`,
    `  subject: ${text(side.subject)}   predicate: ${text(side.predicate_family)}`,
    `  object/value: ${text(side.object_or_value)}`,
    `  polarity: ${text(side.polarity)}   modality: ${text(side.modality)}   quantifier: ${text(side.quantifier)}`,
    `  scope: ${stableStringify(side.scope ?? {})}   valid_time: ${stableStringify(side.valid_time ?? {})}`,
    '  CITED SOURCE (verbatim — decide from THIS, not from prose):',
    ...side.excerpts.map(excerpt => `    [${excerpt.file}:${excerpt.start}-${excerpt.end}] ${excerpt.text}`),
  ].join('\n')).join('\n\n');
  return [
    'You are a SOURCE-GROUNDED adjudicator for a repository documentation-claim census.',
    `The claims below were flagged with the comparison relation "${relation}". That relation is only a`,
    'SURFACE relationship. Your job is the post-evidence RESOLUTION, decided ONLY from the verbatim',
    'cited source of each side. Model agreement is NOT evidence; the source text is. A missing witness',
    'is not falsity. Keep three questions separate:',
    `1. pair_conflict: ${PAIR_CONFLICT_STATES.join('|')}. Conflict means the claims cannot both hold in`,
    '   the same context; use underdetermined when the cited evidence cannot decide.',
    `2. side_grounding: classify EACH claim as ${SIDE_GROUNDING_STATES.join('|')} according to whether`,
    '   its structured claim faithfully represents its own cited source. Never infer grounding from the other side.',
    `3. context_relation: classify scope/time/modality/referent independently as ${CONTEXT_AXIS_STATES.join('|')}.`,
    `Assign EXACTLY ONE resolution from: ${ELEVEN_RESOLUTIONS.join(', ')}.`,
    'Return ONLY JSON with exactly this shape:',
    '{"resolution":"…","rationale":"…","pair_conflict":"conflict|no_conflict|underdetermined",',
    ' "side_grounding":[{"claim_id":"…","state":"supported|refuted|underdetermined|unverifiable",',
    ' "rationale":"…","quoted_spans":["…"]}],',
    ' "context_relation":{"scope":"same|different|overlapping|unknown","time":"same|different|overlapping|unknown",',
    ' "modality":"same|different|overlapping|unknown","referent":"same|different|overlapping|unknown"},',
    ' "context_note":"…","quoted_spans":["…verbatim substring you relied on…"]}',
    'side_grounding MUST contain exactly one entry for every SIDE claim_id shown below, with no extras.',
    'The rationale MUST quote the specific source span text you relied on.',
    '',
    sideBlocks,
  ].join('\n');
}

const assertNotObservation = semantic => {
  if (semantic.namespace === OBSERVATION_NAMESPACE || semantic.plane === 'observation' || Object.hasOwn(semantic, 'observation_id') || semantic.promoted === true) {
    throw new ResolutionError('PROMOTION_BOUNDARY_VIOLATION', 'a neural resolution may not enter the deterministic observation plane', { case_id: semantic.case_id });
  }
};

const normalizeContextRelation = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (stableStringify(keys) !== stableStringify([...CONTEXT_AXES].sort())) return null;
  const normalized = {};
  for (const axis of CONTEXT_AXES) {
    if (!CONTEXT_AXIS_STATES.includes(text(value[axis]))) return null;
    normalized[axis] = text(value[axis]);
  }
  return normalized;
};

/** Validate a model answer without inventing any missing epistemic state. */
export function validateAdjudicationAnswer(parsed, sides) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'answer_not_object' };
  if (!ELEVEN_RESOLUTIONS.includes(text(parsed.resolution))) return { ok: false, reason: 'invalid_resolution' };
  if (isBlank(parsed.rationale)) return { ok: false, reason: 'missing_rationale' };
  if (!PAIR_CONFLICT_STATES.includes(text(parsed.pair_conflict))) return { ok: false, reason: 'invalid_pair_conflict' };
  const contextRelation = normalizeContextRelation(parsed.context_relation);
  if (!contextRelation) return { ok: false, reason: 'invalid_context_relation' };
  if (!Array.isArray(parsed.side_grounding)) return { ok: false, reason: 'missing_side_grounding' };
  const expectedIds = sides.map(side => side.claim_id);
  if (expectedIds.some(isBlank) || new Set(expectedIds).size !== expectedIds.length) return { ok: false, reason: 'invalid_side_claim_ids' };
  const allSource = sides.flatMap(side => side.excerpts || []).map(excerpt => text(excerpt.text)).join('\n');
  const topQuotes = Array.isArray(parsed.quoted_spans) ? parsed.quoted_spans.filter(value => !isBlank(value)).map(text) : [];
  if (!topQuotes.length || topQuotes.some(quote => !allSource.includes(quote))) return { ok: false, reason: 'missing_or_inexact_quoted_spans' };
  const sideById = new Map(sides.map(side => [side.claim_id, side]));
  const byId = new Map();
  for (const grounding of parsed.side_grounding) {
    const claimId = text(grounding?.claim_id);
    if (!expectedIds.includes(claimId) || byId.has(claimId)) return { ok: false, reason: 'invalid_side_grounding_claims' };
    if (!SIDE_GROUNDING_STATES.includes(text(grounding?.state)) || isBlank(grounding?.rationale)) {
      return { ok: false, reason: 'invalid_side_grounding_state' };
    }
    const source = (sideById.get(claimId)?.excerpts || []).map(excerpt => text(excerpt.text)).join('\n');
    const quotes = Array.isArray(grounding.quoted_spans) ? grounding.quoted_spans.filter(value => !isBlank(value)).map(text) : [];
    if (!quotes.length || quotes.some(quote => !source.includes(quote))) return { ok: false, reason: 'missing_or_inexact_side_grounding_quotes' };
    byId.set(claimId, { claim_id: claimId, state: text(grounding.state), rationale: text(grounding.rationale), quoted_spans: quotes });
  }
  if (byId.size !== expectedIds.length) return { ok: false, reason: 'incomplete_side_grounding' };
  return {
    ok: true,
    value: {
      resolution: text(parsed.resolution), rationale: text(parsed.rationale), pair_conflict: text(parsed.pair_conflict),
      side_grounding: expectedIds.map(id => byId.get(id)), context_relation: contextRelation,
      context_note: text(parsed.context_note), quoted_spans: topQuotes,
    },
  };
}

/**
 * Create an immutable, content-addressed, snapshot-bound resolution record. Validates the two
 * distinct vocabularies, requires a rationale, requires at least one cited side, and enforces the
 * promotion boundary. Not a provider call — the model answer is passed in as fields.
 */
export function createResolutionRecord(body, { snapshot } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResolutionError('INVALID_RESOLUTION', 'resolution body must be an object');
  // Promotion boundary at the INPUT: a caller may not smuggle a resolution into the observation plane.
  if (body.namespace === OBSERVATION_NAMESPACE || body.plane === 'observation' || body.promoted === true || Object.hasOwn(body, 'observation_id')) {
    throw new ResolutionError('PROMOTION_BOUNDARY_VIOLATION', 'a neural resolution may not enter the deterministic observation plane', { case_id: body.case_id });
  }
  const snap = snapshot || body.snapshot;
  if (!snap || isBlank(snap.source_sha) || isBlank(snap.corpus_digest)) throw new ResolutionError('MISSING_SNAPSHOT', 'resolution must be snapshot-bound { source_sha, corpus_digest }');
  if (isBlank(body.case_id)) throw new ResolutionError('MISSING_CASE_ID', 'resolution requires the case_id it resolves');
  if (!COMPARISON_RELATIONS.includes(body.comparison_relation)) throw new ResolutionError('INVALID_RELATION', `comparison_relation must be one of the ten comparison relations, got ${body.comparison_relation}`);
  if (!ELEVEN_RESOLUTIONS.includes(body.resolution)) throw new ResolutionError('INVALID_RESOLUTION_STATE', `resolution must be one of the eleven resolutions, got ${body.resolution}`);
  if (isBlank(body.rationale)) throw new ResolutionError('MISSING_RATIONALE', 'resolution requires a source-citing rationale');
  const sides = Array.isArray(body.sides) ? body.sides : [];
  if (!sides.length) throw new ResolutionError('MISSING_SIDES', 'resolution requires the cited sides it read');
  if (!PAIR_CONFLICT_STATES.includes(body.pair_conflict)) throw new ResolutionError('INVALID_PAIR_CONFLICT', `pair_conflict must be one of ${PAIR_CONFLICT_STATES.join('|')}`);
  const contextRelation = normalizeContextRelation(body.context_relation);
  if (!contextRelation) throw new ResolutionError('INVALID_CONTEXT_RELATION', 'context_relation must classify scope/time/modality/referent');
  const grounding = validateAdjudicationAnswer({
    resolution: body.resolution, rationale: body.rationale, pair_conflict: body.pair_conflict,
    side_grounding: body.side_grounding, context_relation: body.context_relation,
    context_note: body.context_note, quoted_spans: body.quoted_spans,
  }, sides);
  if (!grounding.ok) throw new ResolutionError('INVALID_SIDE_GROUNDING', grounding.reason);
  const resolution_key = resolutionKey({
    claim_or_case_id: body.case_id,
    evidence_manifest: sides.map(side => ({ claim_id: side.claim_id, document_id: side.document_id, excerpts: side.excerpts })),
    evidence_protocol_version: EVIDENCE_PROTOCOL_VERSION,
    verifier_contract_version: VERIFIER_CONTRACT_VERSION,
  });
  const semantic = {
    case_id: body.case_id,
    comparison_relation: body.comparison_relation,
    resolution: body.resolution,
    pair_conflict: body.pair_conflict,
    side_grounding: grounding.value.side_grounding,
    context_relation: contextRelation,
    context_note: text(body.context_note),
    rationale: text(body.rationale),
    quoted_spans: Array.isArray(body.quoted_spans) ? body.quoted_spans.map(text) : [],
    sides: sides.map(side => ({
      claim_id: side.claim_id ?? null,
      document_id: side.document_id ?? null,
      excerpts: (side.excerpts ?? []).map(excerpt => ({ file: excerpt.file ?? null, start: excerpt.start ?? null, end: excerpt.end ?? null, text: text(excerpt.text) })),
    })),
    disposition: { kind: 'resolved' },
    plane: 'documentary-claim',
    quarantine: 'documentary-claim-plane',
    model_identifier: text(body.model_identifier) || 'unknown-model',
    prompt_digest: text(body.prompt_digest) || sha256('no-prompt'),
    generator_digest: text(body.generator_digest) || sha256(RESOLUTION_ADJUDICATOR_VERSION),
    evidence_protocol_version: EVIDENCE_PROTOCOL_VERSION,
    verifier_contract_version: VERIFIER_CONTRACT_VERSION,
    resolution_key,
    snapshot: { source_sha: snap.source_sha, corpus_digest: snap.corpus_digest },
  };
  assertNotObservation(semantic);
  const id = `${RESOLUTION_NAMESPACE}:${sha256(stableStringify(semantic))}`;
  return deepFreeze({ schema: RESOLUTION_SCHEMA, namespace: RESOLUTION_NAMESPACE, id, semantic });
}

/** Append-only, content-addressed, snapshot-bound store of resolution records. */
export function createResolutionStore({ snapshot } = {}) {
  if (!snapshot || isBlank(snapshot.source_sha) || isBlank(snapshot.corpus_digest)) throw new ResolutionError('INVALID_SNAPSHOT', 'resolution store requires a snapshot { source_sha, corpus_digest }');
  const boundSnapshot = Object.freeze({ source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest });
  const entries = [];
  const byId = new Map();
  const byKey = new Map();
  const add = body => {
    const record = createResolutionRecord(body, { snapshot: body.snapshot || boundSnapshot });
    if (record.semantic.snapshot.source_sha !== boundSnapshot.source_sha || record.semantic.snapshot.corpus_digest !== boundSnapshot.corpus_digest) {
      throw new ResolutionError('SNAPSHOT_MISMATCH', 'resolution is not bound to this store snapshot', { id: record.id });
    }
    if (byId.has(record.id)) return { status: 'deduped', id: record.id };
    // Staged reuse gate: an identical resolution_key means the same case+evidence+protocol was
    // already resolved; keep the first and mark the repeat as reused rather than double-counting.
    if (byKey.has(record.semantic.resolution_key)) return { status: 'reused', id: byKey.get(record.semantic.resolution_key) };
    entries.push(record);
    byId.set(record.id, record);
    byKey.set(record.semantic.resolution_key, record.id);
    return { status: 'added', id: record.id };
  };
  return Object.freeze({
    schema: RESOLUTION_SCHEMA,
    namespace: RESOLUTION_NAMESPACE,
    snapshot: boundSnapshot,
    add,
    get: id => byId.get(id) ?? null,
    list: () => entries.slice(),
    size: () => entries.length,
    // The store is a hard wall: there is no code path from a resolution to a deterministic observation.
    promoteToObservation: () => { throw new ResolutionError('PROMOTION_BOUNDARY_VIOLATION', 'resolutions are never promoted into deterministic observations'); },
  });
}

/**
 * Resolve DisagreementCases with a source-grounded adjudicator model. Deterministic in case order.
 * For each case (capped at maxResolutions) it gathers every side's cited sources, calls a runner
 * ONCE, validates the resolution against the eleven-state vocabulary, and stores an immutable
 * resolution record. A malformed / out-of-vocabulary answer is SKIPPED (recorded), never fabricated.
 *
 * BOUNDED CONCURRENCY (slice 4e). Pass `runnerPool` (an array of N warm runners) — or the legacy
 * single `runner` (a pool of one, the exact N=1 sequential path) — and up to N cases are adjudicated
 * CONCURRENTLY, each on its own runner (a runner adjudicates one case at a time and issues new_session
 * between its own calls; it never interleaves two cases). The model calls run concurrently but the
 * store INSERTS run sequentially in case-id order (Phase 3), so dedupe/reuse/count semantics and the
 * stored ordering are byte-identical to the sequential (N=1) run and reproducible.
 */
export async function resolveDisagreementCases({ cases, claimsById, runner = null, runnerPool = null, snapshot, maxResolutions = Infinity, model = null, callRetries = 0, checkpoint = null }) {
  const pool = normalizeRunnerPool(runnerPool, runner);
  if (pool.some(item => ['pi-rpc', 'pi-cli'].includes(item.kind)) && !checkpoint) throw new ResolutionError('MISSING_CHECKPOINT', 'paid resolution runner requires a durable checkpoint journal');
  if (!snapshot || !snapshot.source_sha || !snapshot.corpus_digest) throw new ResolutionError('INVALID_SNAPSHOT', 'resolveDisagreementCases requires a snapshot');
  const claimLookup = claimsById instanceof Map ? claimsById : new Map(Object.entries(claimsById || {}));
  const store = createResolutionStore({ snapshot });
  const ordered = (cases || []).slice().sort((left, right) => text(left.id).localeCompare(text(right.id)));
  const cap = Number.isFinite(maxResolutions) ? Math.max(0, maxResolutions) : ordered.length;
  const selected = ordered.slice(0, cap);
  const usedModel = model || pool[0].model || 'unknown-model';
  const generatorDigest = sha256(RESOLUTION_ADJUDICATOR_VERSION);
  const skipped = [];
  const byResolution = Object.fromEntries(ELEVEN_RESOLUTIONS.map(state => [state, 0]));
  // Phase 1 (sequential, deterministic): resolve relation + sides for each case; pre-model skips.
  const workItems = [];
  for (const caseRecord of selected) {
    const relation = relationFromCaseKind(caseRecord.semantic?.case_kind);
    if (!relation) { skipped.push({ case_id: caseRecord.id, reason: 'unrecognized_case_kind' }); continue; }
    const sides = (caseRecord.semantic.claims || []).map(id => claimLookup.get(id)).filter(Boolean).map(sideFromClaim);
    if (sides.length < 2 || sides.some(side => !side.excerpts.length)) {
      skipped.push({ case_id: caseRecord.id, reason: 'missing_side_sources' });
      continue;
    }
    const prompt = buildAdjudicationPrompt({ relation, sides });
    assertInferencePromptWithinLimit(prompt);
    const promptDigest = sha256(prompt);
    const checkpointKey = sha256(stableStringify({ inference_custody_policy: INFERENCE_CUSTODY_POLICY, case_id: caseRecord.id, relation, sides, promptDigest, model: usedModel, generatorDigest, snapshot }));
    workItems.push({ caseRecord, relation, sides, prompt, promptDigest, checkpointKey });
  }
  // Phase 2 (bounded-concurrent over the pool): one case per pooled runner at a time. Results are
  // collected in work-item (case-id) order via the pool, never by completion order.
  const assertComplete = (item, result, model_stats) => {
    if (result.outcome !== 'ok') openInferenceCircuit(`resolution stopped after incomplete paid unit ${item.caseRecord.id}`, { stage: 'resolution', case_id: item.caseRecord.id, result, model_stats });
    const parsed = result.json ?? parseCensusModelJson(result.text);
    const validation = validateAdjudicationAnswer(parsed, item.sides);
    if (!validation.ok) openInferenceCircuit(`resolution stopped after invalid paid answer ${item.caseRecord.id}`, { stage: 'resolution', case_id: item.caseRecord.id, reason: validation.reason, result, model_stats });
  };
  const perCase = async (item, poolRunner) => {
    const cached = checkpoint?.get('resolution', item.checkpointKey);
    if (cached) {
      assertComplete(item, cached.result, cached.model_stats);
      return { item, result: cached.result, model_stats: cached.model_stats };
    }
    const tag = `resolve:${item.caseRecord.id}`;
    const started = checkpoint?.get('resolution-started', item.checkpointKey);
    if (started) {
      const { result, model_stats } = interruptedInferenceCustody({ model: poolRunner.model, tag, kind: poolRunner.kind || 'unknown' });
      await checkpoint?.put('resolution', item.checkpointKey, { result, model_stats });
      assertComplete(item, result, model_stats);
      return { item, result, model_stats };
    }
    await checkpoint?.put('resolution-started', item.checkpointKey, { tag, model: poolRunner.model, prompt_digest: item.promptDigest, inference_custody_policy: INFERENCE_CUSTODY_POLICY });
    const beforeStats = modelStatsSnapshot(poolRunner);
    const result = await invokeModelRunner(poolRunner, { prompt: item.prompt, tag }, { callRetries });
    const model_stats = modelStatsDelta(beforeStats, modelStatsSnapshot(poolRunner), poolRunner.model);
    await checkpoint?.put('resolution', item.checkpointKey, { result, model_stats });
    assertComplete(item, result, model_stats);
    return { item, result, model_stats };
  };
  const { results, maxInFlight } = await mapWithRunnerPool(workItems, pool, perCase);
  // Phase 3 (deterministic): validate + store INSERT sequentially in case-id order so dedupe/reuse
  // gates and the counted totals are identical regardless of the concurrent completion order.
  for (const entry of results) {
    if (!entry) continue;
    const { item, result } = entry;
    const caseRecord = item.caseRecord;
    // An accepted timeout is a skip-with-custody and unknown billing when usage is absent; never auto-retry.
    if (isTimeoutOutcome(result.outcome) || result.outcome !== 'ok') {
      skipped.push({
        case_id: caseRecord.id, reason: isTimeoutOutcome(result.outcome) ? 'call_timeout' : 'model_call_incomplete',
        outcome: result.outcome, attempts: result.attempts ?? 1,
        retry_policy: result.retry_policy ?? 'single-attempt', accepted: result.accepted ?? null,
        billing_status: result.billing_status ?? 'acceptance_unknown', reported_usage: result.usage ?? null,
        inference_complete: false,
      });
      continue;
    }
    const parsed = result.json ?? parseCensusModelJson(result.text);
    const validated = validateAdjudicationAnswer(parsed, item.sides);
    if (!validated.ok) { skipped.push({ case_id: caseRecord.id, reason: 'invalid_resolution_answer', detail: validated.reason, inference_complete: false }); continue; }
    const answer = validated.value;
    const { status } = store.add({
      case_id: caseRecord.id,
      comparison_relation: item.relation,
      ...answer,
      sides: item.sides,
      model_identifier: usedModel,
      prompt_digest: item.promptDigest,
      generator_digest: generatorDigest,
    });
    if (status === 'added') byResolution[answer.resolution] += 1;
  }
  const model_stats = combineModelStats(results.map(entry => entry?.model_stats), usedModel);
  return {
    store,
    resolutions: store.list(),
    model_stats,
    by_resolution: Object.freeze(byResolution),
    resolutions_total: store.size(),
    cases_considered: selected.length,
    skipped,
    model: usedModel,
    concurrency: pool.length,
    max_in_flight: maxInFlight,
  };
}
