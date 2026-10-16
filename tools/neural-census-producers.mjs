// Task-2b producer and adjudication plane. It never invokes a provider or writes the scanned estate.
import { createRecord } from './adjudication-schema.mjs';
import { sha256, stableStringify } from './lib.mjs';
export { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';

export const ALIGNMENT_CATEGORIES = Object.freeze([
  'exact_proposition', 'partial_compatible', 'subject_only_existence',
  'scope_mismatch', 'polarity_conflict', 'unresolved_referent',
]);
export const ACTION_NAMES = Object.freeze([
  'exact_span_retrieval', 'symbol_reference_search', 'assignment_mutation_trace',
  'bounded_call_path_inspection', 'configuration_environment_resolution',
  'manifest_schema_declaration_comparison', 'test_vs_production_provenance_classification',
  'closed_world_search',
]);

export class ProducerInputRefusal extends Error {
  constructor(reason_code, detail = {}) {
    super(`producer input refused: ${reason_code}`);
    this.name = 'ProducerInputRefusal';
    this.code = 'NEURAL_CENSUS_TYPED_REFUSAL';
    this.reason_code = reason_code;
    this.detail = detail;
  }
}
export class ActionRefusal extends Error {
  constructor(reason_code, detail = {}) {
    super(`action refused: ${reason_code}`);
    this.name = 'ActionRefusal';
    this.code = 'NEURAL_CENSUS_ACTION_REFUSAL';
    this.reason_code = reason_code;
    this.detail = detail;
  }
}
export class ModelInvocationDisabledError extends Error {
  constructor() {
    super('model invocation is disabled: no ModelRunner was supplied. The neural path is reachable ONLY via an explicit census invocation that injects a runner (real or mock).');
    this.name = 'ModelInvocationDisabledError';
    this.code = 'NEURAL_CENSUS_MODEL_DISABLED';
  }
}

const PROHIBITED_INPUTS = Object.freeze({
  deterministic_observation_graph: 'DETERMINISTIC_OBSERVATION_GRAPH_FORBIDDEN',
  prior_neural_claims: 'PRIOR_NEURAL_CLAIMS_FORBIDDEN',
  prior_resolution_prose: 'PRIOR_RESOLUTION_PROSE_FORBIDDEN',
  sibling_producer_output: 'SIBLING_PRODUCER_OUTPUT_FORBIDDEN',
});
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const text = value => String(value ?? '');
const normalized = value => text(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const semantic = record => record?.semantic || record;
const spanPath = span => span?.file || span?.path;

/**
 * The single guarded model gateway (slice 4, DESIGN §16.12.1). This is the ONLY place the
 * documentation-claim census reaches a model, and it stays fail-closed by construction:
 *
 *   - Called with NO runner (the ordinary build + every unit test that does not opt in): it throws
 *     ModelInvocationDisabledError. There is no ambient/default runner, so an ordinary build can
 *     never call a model — the disabled state is the DEFAULT, not a flag that must be remembered.
 *   - Called with an explicit ModelRunner (only the --neural census entrypoint, or a MOCK injected
 *     by a test): it delegates to `runner.complete(request)`.
 *
 * A ModelRunner is any object exposing `async complete({ prompt, tag }) -> { text, json?, usage,
 * model, outcome }`. See neural-model-runner.mjs for the real Pi-CLI runner (grounded in the landed
 * campaign.mjs invocation path) and the deterministic zero-spend mock used by tests.
 */
// Paid inference is single-attempt at this boundary. A timeout may follow provider acceptance and
// billing even when no terminal usage event arrives; automatically repeating it can multiply spend
// while reporting zero. Only proven pre-dispatch spawn/connect/write recovery belongs inside the
// runner. Any post-handoff timeout/provider/content failure is a durable incomplete outcome.
const isTimeoutOutcome = outcome => /timeout/i.test(String(outcome || ''));
export async function invokeModelRunner(runner = null, request = null, { callRetries = 0 } = {}) {
  if (!runner || typeof runner.complete !== 'function') throw new ModelInvocationDisabledError();
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new ProducerInputRefusal('MISSING_MODEL_PROMPT');
  }
  const result = await runner.complete({ prompt: request.prompt, tag: request.tag ?? 'neural-census' });
  return {
    ...result,
    attempts: result.attempts ?? 1,
    retry_policy: result.retry_policy || (isTimeoutOutcome(result.outcome) && Number(callRetries) > 0
      ? 'accepted-timeout-retry-suppressed'
      : 'single-attempt'),
  };
}
export { isTimeoutOutcome };

/**
 * Validates the sealed producer boundary. Text within raw content is deliberately not interpreted
 * as instructions; only object fields name authority-bearing inputs.
 */
export function acceptBlindProducerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProducerInputRefusal('INVALID_PRODUCER_INPUT');
  for (const [field, reason] of Object.entries(PROHIBITED_INPUTS)) {
    if (Object.hasOwn(input, field)) throw new ProducerInputRefusal(reason, { field });
  }
  for (const field of Object.keys(input)) {
    if (!['corpus', 'raw_corpus', 'task_condition'].includes(field)) throw new ProducerInputRefusal('UNRECOGNIZED_PRODUCER_INPUT', { field });
  }
  if (!input.corpus || !Array.isArray(input.corpus.entries) || !Array.isArray(input.raw_corpus)) {
    throw new ProducerInputRefusal('MISSING_CORPUS_OR_RAW_CONTENT');
  }
  const paths = new Set(input.corpus.entries.map(entry => entry.path));
  for (const item of input.raw_corpus) {
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string' || !paths.has(item.path)) {
      throw new ProducerInputRefusal('RAW_CONTENT_NOT_IN_CORPUS', { path: item?.path });
    }
  }
  return deepFreeze({
    corpus: input.corpus,
    raw_corpus: input.raw_corpus.map(item => ({ path: item.path, content: item.content, start_line: Number.isInteger(item.start_line) ? item.start_line : 1 })),
    task_condition: input.task_condition === undefined ? null : text(input.task_condition),
  });
}

const inputDigest = input => sha256(stableStringify({ corpus_digest: input.corpus.corpus_digest, raw_corpus: input.raw_corpus }));
const request = (producer, input, extra = {}) => deepFreeze({
  producer,
  source_sha: input.corpus.source_sha,
  corpus_digest: input.corpus.corpus_digest,
  raw_content_digest: inputDigest(input),
  ...extra,
});

/** Produces a sealed, cold whole-estate payload; it is not a provider call or a claim. */
export function produceWholeEstateHypothesisCensus(input) {
  const accepted = acceptBlindProducerInput(input);
  const byProvenance = Object.fromEntries(['production', 'test', 'fixture', 'docs'].map(kind => [kind,
    accepted.corpus.entries.filter(entry => entry.provenance_class === kind).length]));
  return request('whole_estate_hypothesis_census', accepted, { files_examined: accepted.raw_corpus.length, by_provenance: byProvenance });
}

/** Produces a sealed, cold task-conditioned payload without receiving another producer's output. */
export function produceColdTaskConditionedProbe(input) {
  const accepted = acceptBlindProducerInput(input);
  if (!accepted.task_condition) throw new ProducerInputRefusal('MISSING_TASK_CONDITION');
  return request('cold_task_conditioned_probe', accepted, {
    task_condition_digest: sha256(accepted.task_condition),
    files_examined: accepted.raw_corpus.length,
  });
}

const sentenceLines = content => content.split(/\r?\n/);
const claimText = line => line.replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/, '').trim();
const isClaimLine = line => /\b(?:must|shall|is|are|remains|cannot|never|only|requires?)\b/i.test(line) && claimText(line).length > 12;

/** Parses actual documentation lines into immutable, provenance-bound claim records. */
export function produceDocumentationClaims(input, { producer_version = 'task-2b/documentation-parser@1' } = {}) {
  const accepted = acceptBlindProducerInput(input);
  const entries = new Map(accepted.corpus.entries.map(entry => [entry.path, entry]));
  const records = [];
  for (const file of accepted.raw_corpus) {
    const entry = entries.get(file.path);
    if (entry?.provenance_class !== 'docs') continue;
    let section = 'documentation';
    for (const [index, raw] of sentenceLines(file.content).entries()) {
      const line = raw.trim();
      if (/^#{1,6}\s+/.test(line)) { section = line.replace(/^#+\s*/, ''); continue; }
      if (!isClaimLine(line)) continue;
      const lineNumber = file.start_line + index;
      const statement = claimText(line);
      const neighbourhood = normalized(section) || 'documentation';
      const span = { file: file.path, path: file.path, line: lineNumber, start: lineNumber, end: lineNumber };
      // Shape-map the deterministic regex output into the ratified documentary-claim contract
      // (DESIGN §16.12.1). This is NOT a proposition index or relation classifier: the referent
      // is emitted UNRESOLVED (kind: 'unresolved') and carries its subject neighbourhood so the
      // later alignment slice can resolve it. No cross-claim semantics are computed here.
      records.push(createRecord('claim', {
        source_sha: accepted.corpus.source_sha,
        snapshot_sha: accepted.corpus.source_sha,
        corpus_digest: accepted.corpus.corpus_digest,
        generator_digest: sha256('task-2b/documentation-parser@1'),
        prompt_digest: sha256('no-model/documentation-parser'),
        model_identifier: 'not-run/deterministic-documentation-parser',
        producer_version,
        subject_refs: [{ ref: neighbourhood, kind: 'unresolved', neighbourhood }],
        predicate_family: 'documentation_states',
        object_or_value: statement,
        polarity: 'affirmed',
        modality: /\b(must|shall|cannot|never|only|requires?)\b/i.test(statement) ? 'normative' : 'descriptive',
        quantifier: /\b(all|every|each|no)\b/i.test(statement) ? 'universal' : 'unspecified',
        scope: { repository: null, component: 'documentation', environment: null, version_or_branch: accepted.corpus.source_sha, actor: null },
        valid_time: { from: null, until: null },
        provenance: { document_id: file.path, revision_id: accepted.corpus.source_sha, spans: [span] },
        spans: [span],
        source_path: file.path,
        source_text: statement,
        origin: 'documentation_claim_producer',
        disposition: { kind: 'open' },
        materiality: 'unclassified',
        provenance_class: entry.provenance_class,
      }));
    }
  }
  return deepFreeze(records);
}

// Reads the ratified documentary-claim fields (subject_refs[0]/predicate_family/scope object).
const alignField = (value, field) => {
  if (!value) return '';
  if (field === 'subject') { const first = Array.isArray(value.subject_refs) ? value.subject_refs[0] : null; return normalized(first?.ref ?? first ?? ''); }
  if (field === 'predicate') return normalized(value.predicate_family);
  if (field === 'scope') return normalized(value.scope && typeof value.scope === 'object' ? value.scope.component : value.scope);
  return normalized(value[field]);
};

// SUPERSEDED (adjudication A6, DESIGN §16.12.1). This 6-way referent-alignment cascade can express
// only 6 of the 10 ratified comparison relations and compares a claim to a single referent rather
// than classifying a claim PAIR. The documentation-claim census uses the ten-relation classifier in
// comparison-relation-classifier.mjs (classifyRelation) over the proposition index instead. This
// function is retained only for the landed Task-2b referent-alignment tests; do not extend it.
export function alignReferentOnly(claim, referent) {
  const left = semantic(claim), right = referent ? semantic(referent) : null;
  const compared = Object.fromEntries(['subject', 'predicate', 'polarity', 'scope', 'modality', 'quantifier']
    .map(field => [field, { claim: alignField(left, field), referent: alignField(right, field) }]));
  let category;
  if (!right || !compared.subject.referent) category = 'unresolved_referent';
  else if (compared.subject.claim !== compared.subject.referent) category = 'unresolved_referent';
  else if (compared.polarity.claim && compared.polarity.referent && compared.polarity.claim !== compared.polarity.referent) category = 'polarity_conflict';
  else if (compared.predicate.claim === 'exists' || compared.predicate.referent === 'exists') category = 'subject_only_existence';
  else if (compared.predicate.claim !== compared.predicate.referent) category = 'subject_only_existence';
  else if (compared.scope.claim !== compared.scope.referent) category = 'scope_mismatch';
  else if (['modality', 'quantifier'].some(field => compared[field].claim !== compared[field].referent)) category = 'partial_compatible';
  else category = 'exact_proposition';
  return deepFreeze({
    category,
    claim_id: claim?.id || null,
    referent_id: referent?.id || null,
    compared,
  });
}

export function freezeActionSnapshot(input) {
  const accepted = acceptBlindProducerInput(input);
  return deepFreeze({
    source_sha: accepted.corpus.source_sha,
    corpus_digest: accepted.corpus.corpus_digest,
    corpus: accepted.corpus,
    raw_corpus: accepted.raw_corpus,
  });
}
const rawFile = (snapshot, path) => snapshot.raw_corpus.find(item => item.path === path) || null;
const allLines = snapshot => snapshot.raw_corpus.flatMap(item => sentenceLines(item.content).map((line, index) => ({ path: item.path, line: item.start_line + index, text: line })));
const digestResult = result => sha256(stableStringify(result));
const receipt = (snapshot, operation, observation) => deepFreeze({
  snapshot_sha: snapshot.source_sha,
  corpus_digest: snapshot.corpus_digest,
  literal_operation: operation,
  result_digest: digestResult(observation),
});
const requireString = (value, field) => { if (!text(value).trim()) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { field }); return text(value); };
const matching = (snapshot, expression) => allLines(snapshot).filter(item => expression.test(item.text));

const ACTIONS = Object.freeze({
  exact_span_retrieval(snapshot, request) {
    const file = rawFile(snapshot, requireString(request.file, 'file'));
    if (!file) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { file: request.file });
    const start = Number(request.start_line), end = Number(request.end_line ?? start);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { field: 'line_range' });
    const lines = sentenceLines(file.content).slice(start - file.start_line, end - file.start_line + 1);
    if (!lines.length) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { file: file.path, start, end });
    return { kind: 'exact_span', spans: [{ file: file.path, start, end, text: lines.join('\n') }] };
  },
  symbol_reference_search(snapshot, request) {
    const symbol = requireString(request.symbol, 'symbol');
    const hits = matching(snapshot, new RegExp(`\\b${escapeRegExp(symbol)}\\b`));
    return { kind: 'symbol_references', symbol, hits };
  },
  assignment_mutation_trace(snapshot, request) {
    const symbol = requireString(request.symbol, 'symbol');
    const hits = matching(snapshot, new RegExp(`(?:\\b${escapeRegExp(symbol)}\\s*=|(?:const|let|var)\\s+${escapeRegExp(symbol)}\\b|\\.${escapeRegExp(symbol)}\\s*=)`));
    return { kind: 'assignment_mutation_trace', symbol, hits };
  },
  bounded_call_path_inspection(snapshot, request) {
    const symbol = requireString(request.symbol, 'symbol'), limit = Number(request.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { field: 'limit' });
    const hits = matching(snapshot, new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`)).slice(0, limit);
    return { kind: 'bounded_call_path', symbol, limit, hits, truncated: matching(snapshot, new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`)).length > hits.length };
  },
  configuration_environment_resolution(snapshot, request) {
    const key = requireString(request.key, 'key');
    const hits = matching(snapshot, new RegExp(`(?:^|[\\s{,])['\"]?${escapeRegExp(key)}['\"]?\\s*[:=]\\s*([^\\s,#}]+)`));
    return { kind: 'configuration_environment_resolution', key, hits };
  },
  manifest_schema_declaration_comparison(snapshot, request) {
    const declaration = requireString(request.declaration, 'declaration');
    const manifest = rawFile(snapshot, requireString(request.manifest_file, 'manifest_file'));
    if (!manifest) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { file: request.manifest_file });
    const schemaFiles = snapshot.raw_corpus.filter(item => item.path !== manifest.path && /schema|manifest|package\.json/i.test(item.path));
    const manifest_mentions = sentenceLines(manifest.content).map((line, index) => ({ path: manifest.path, line: manifest.start_line + index, text: line })).filter(hit => hit.text.includes(declaration));
    const schema_mentions = schemaFiles.flatMap(item => sentenceLines(item.content).map((line, index) => ({ path: item.path, line: item.start_line + index, text: line })).filter(hit => hit.text.includes(declaration)));
    return { kind: 'manifest_schema_declaration_comparison', declaration, manifest_mentions, schema_mentions, matches: manifest_mentions.length > 0 && schema_mentions.length > 0 };
  },
  test_vs_production_provenance_classification(snapshot, request) {
    const file = requireString(request.file, 'file');
    const entry = snapshot.corpus.entries.find(item => item.path === file);
    if (!entry) throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { file });
    return { kind: 'provenance_classification', file, provenance_class: entry.provenance_class, classification: entry.provenance_class === 'production' ? 'production' : 'non_production' };
  },
  closed_world_search(snapshot, request) {
    const term = requireString(request.term, 'term');
    const hits = matching(snapshot, new RegExp(escapeRegExp(term), 'i'));
    return { kind: 'closed_world_search', term, searched_paths: snapshot.raw_corpus.map(item => item.path).sort(), hits, closed_world: true };
  },
});
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Executes a registry action against only the frozen snapshot. No accepted-without-observation state exists. */
export function executeEvidenceAction(snapshot, action, request = {}) {
  if (!snapshot || !Object.isFrozen(snapshot)) throw new ActionRefusal('SNAPSHOT_NOT_FROZEN');
  if (!Object.hasOwn(ACTIONS, action)) throw new ActionRefusal('UNSUPPORTED_PREDICATE', { action });
  if (request.witness_obligation && !request.file && !request.symbol && !request.key && !request.term && !request.declaration) {
    throw new ActionRefusal('UNDISCHARGEABLE_WITNESS_OBLIGATION', { obligation: request.witness_obligation });
  }
  const observation = ACTIONS[action](snapshot, request);
  if (!observation || !Array.isArray(observation.hits ?? observation.spans ?? observation.manifest_mentions ?? [])) {
    throw new ActionRefusal('EMPTY_SUCCESS_FORBIDDEN', { action });
  }
  const operation = `${action} ${stableStringify(request)}`;
  return deepFreeze({ observation, execution_receipt: receipt(snapshot, operation, observation) });
}

export function createEvaluatorProjection(records = []) {
  const claims = records.filter(record => record?.record_kind === 'claim').slice();
  const query = filters => claims.filter(record => {
    const value = semantic(record), spans = value.spans || [];
    return (!filters.origin || value.origin === filters.origin)
      && (!filters.state || value.disposition?.kind === filters.state)
      && (!filters.provenance || value.provenance_class === filters.provenance || spans.some(span => spanPath(span) === filters.provenance))
      && (!filters.materiality || value.materiality === filters.materiality)
      && (!filters.snapshot || value.snapshot_sha === filters.snapshot || value.source_sha === filters.snapshot);
  });
  return deepFreeze({
    query: filters => query(filters || {}).slice(),
    unresolvedClaims: () => query({}).filter(record => ['open', 'underdetermined', 'ill_typed'].includes(semantic(record).disposition?.kind)),
    provenanceFor: id => (claims.find(record => record.id === id) ? [...(semantic(claims.find(record => record.id === id)).spans || [])] : []),
  });
}
