// Neural documentary-claim extractor (slice 4 of intent-779029e6, DESIGN §16.12.1).
//
// This is the FIRST producer that reads an artifact WITH A MODEL. It emits ratified
// documentary-claim/v2 records (via adjudication-schema `createRecord('claim', …)`) whose
// subject_refs / predicate_family / object_or_value / polarity / modality / quantifier / scope /
// valid_time are the model's REAL, VARYING inference from the text — never the deterministic
// parser's constants. Each claim RETAINS THE VERBATIM SOURCE EXCERPT on its provenance: the excerpt
// is sliced from the REAL artifact content at the cited line range (source of truth), NOT from the
// model's paraphrase, so a human or the adjudicator can inspect the exact text the claim came from.
//
// EPISTEMIC CONSTITUTION. Source > docs > model prose. The claim's `object_or_value` is the model's
// reading, but `provenance.source_excerpts` is the verbatim source; the two are kept distinct so a
// reviewer can always check the model against the text.
//
// PROMOTION BOUNDARY. Emitted claims are ordinary documentary-claim/v2 records destined for the
// quarantined documentary-claim ledger. They never enter the deterministic observation plane.
//
// MODEL ACCESS. The extractor reaches the model ONLY through invokeModelRunner(runner, …); a runner
// must be injected by the caller. No runner => the ordinary/test path cannot extract neurally.
import { CLAIM_MODALITIES, CLAIM_SCHEMA_VERSION, CLAIM_SCOPE_FIELDS, createRecord } from './adjudication-schema.mjs';
import { claimAttemptKey } from './census-keys.mjs';
import { invokeModelRunner, isTimeoutOutcome } from './neural-census-producers.mjs';
import { assertInferencePromptWithinLimit, INFERENCE_CUSTODY_POLICY, interruptedInferenceCustody, openInferenceCircuit } from './inference-custody.mjs';
import { parseCensusModelJson } from './neural-json.mjs';
import { mapWithRunnerPool, normalizeRunnerPool } from './neural-runner-pool.mjs';
import { combineModelStats, modelStatsDelta, modelStatsSnapshot } from './model-usage.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const NEURAL_EXTRACTOR_VERSION = 'slice-4/neural-claim-extractor@1';
export const NEURAL_GENRE_ADAPTER = 'documentation';
// Documents at or under this byte size are extracted in ONE model call (unchanged behavior). A doc
// over this threshold is split into heading/paragraph-aligned chunks (never mid-line) and extracted
// per chunk, then merged — large design docs (100–180 KB) produced huge, slow, timeout-prone prompts.
export const DEFAULT_MAX_DOC_BYTES = 24000;
export const MAX_CLAIMS_PER_EXTRACTION_UNIT = 64;

/**
 * Split a document into extraction chunks on markdown heading / paragraph boundaries, NEVER mid-line.
 * Returns `[{ content, startLine }]` where startLine is the 1-based REAL document line number of the
 * chunk's first line — so a claim the model cites by document line resolves to the real source span
 * and its excerpt is sliced from the real text. A doc at/under maxDocBytes is a single chunk
 * (`[{ content, startLine: 1 }]`), preserving the prior single-call behavior exactly.
 */
export function chunkDocument(content, { maxDocBytes = DEFAULT_MAX_DOC_BYTES } = {}) {
  const whole = text(content);
  if (!Number.isFinite(maxDocBytes) || maxDocBytes <= 0 || Buffer.byteLength(whole, 'utf8') <= maxDocBytes) {
    return [{ content: whole, startLine: 1 }];
  }
  const lines = contentLines(whole);
  const chunks = [];
  let current = [];
  let currentStart = 1;
  let currentBytes = 0;
  const flush = nextStart => {
    if (current.length) chunks.push({ content: current.join('\n'), startLine: currentStart });
    current = [];
    currentBytes = 0;
    currentStart = nextStart;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // include the newline
    const isHeading = /^#{1,6}\s/.test(line);
    // Prefer to START a new chunk at a heading once the current chunk has real content, so chunks
    // align to section boundaries. Also flush when the next line would overflow the cap. Either way
    // the break is BETWEEN whole lines — never inside a line.
    if (current.length && ((isHeading && currentBytes > 0) || currentBytes + lineBytes > maxDocBytes)) {
      flush(lineNo);
    }
    if (current.length === 0) currentStart = lineNo;
    current.push(line);
    currentBytes += lineBytes;
  }
  flush(lines.length + 1);
  return chunks.length ? chunks : [{ content: whole, startLine: 1 }];
}

const text = value => String(value ?? '');
const normalized = value => text(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const contentLines = content => text(content).split(/\r?\n/);

const numberedContent = (content, startLine = 1) =>
  contentLines(content).map((line, index) => `${startLine + index}: ${line}`).join('\n');

/**
 * Build a resolver mapping a 1-based DOCUMENT line number to the nearest preceding markdown heading
 * text. This mirrors the deterministic producer's section tracking (produceDocumentationClaims, which
 * derives `neighbourhood` from the heading a claim sits under and thereby gets 16 distinct
 * neighbourhoods from doc sections). It is how a NEURAL claim's subject_neighbourhood gains real,
 * fine-grained granularity: distinct document sections yield distinct neighbourhoods, so the
 * proposition index buckets them apart instead of collapsing every claim into ONE bucket. `startLine`
 * is the real document line number of `content`'s first line. A line before the first heading resolves
 * to 'documentation' (the same default the deterministic producer uses).
 */
export function buildSectionResolver(content, startLine = 1) {
  const lines = contentLines(content);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^#{1,6}\s+/.test(trimmed)) headings.push({ line: startLine + index, section: trimmed.replace(/^#+\s*/, '').trim() });
  }
  return lineNo => {
    let section = 'documentation';
    for (const heading of headings) {
      if (heading.line <= lineNo) section = heading.section;
      else break;
    }
    return section;
  };
}

/** Build the extraction prompt for one documentation artifact. Instructs the model to INFER, per
 *  claim, the varying documentary-claim/v2 fields and to cite the source line range. */
export function buildExtractionPrompt({ path, content, startLine = 1 }) {
  return [
    'You are a neural documentary-claim extractor for a repository documentation census.',
    'Read the DOCUMENT below and extract each DISTINCT documentary CLAIM it asserts about the',
    'repository/system (what it is, must be, does, forbids, will do, or once did).',
    'For EACH claim return an object with EXACTLY these fields (infer each from the text — never a constant):',
    '  subject: the specific entity/component the claim is about (a real name/term from the text)',
    '  subject_kind: one of component|module|file|config|environment|actor|concept',
    '  predicate_family: a short snake_case predicate (e.g. is_immutable, requires, routes_via, binds_to, depends_on)',
    '  object_or_value: the substance the predicate asserts',
    '  polarity: "affirmed" or "negated" (negated when the claim denies/forbids/prohibits/"must not")',
    `  modality: one of ${CLAIM_MODALITIES.join('|')} (normative=must/shall/required; descriptive=is/does; constitutive=defines; predictive=will; historical=was/did; interpretive=means)`,
    '  quantifier: universal|existential|unspecified',
    '  scope: object {repository,component,environment,version_or_branch,actor}; use null for any field the text does not state',
    '  valid_time: object {from,until}; ISO date/version or null when not stated',
    '  source_lines: object {start,end} — the 1-based DOCUMENT line range this claim is derived from',
    'Return ONLY JSON: {"claims":[ … ]}. No prose, no markdown fences.',
    '',
    `DOCUMENT ${path}:`,
    numberedContent(content, startLine),
  ].join('\n');
}

const normalizeModality = value => (CLAIM_MODALITIES.includes(text(value)) ? text(value) : 'descriptive');
const NEGATED_TOKENS = new Set(['negated', 'denied', 'refuted', 'forbidden', 'prohibited', 'false']);
const normalizePolarity = value => (NEGATED_TOKENS.has(text(value).toLowerCase()) ? 'negated' : 'affirmed');
const normalizeQuantifier = value => (text(value).trim() || 'unspecified');
const normalizeScope = scope => {
  const source = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  return Object.fromEntries(CLAIM_SCOPE_FIELDS.map(field => [field, source[field] ?? null]));
};
const normalizeValidTime = validTime => {
  const source = validTime && typeof validTime === 'object' && !Array.isArray(validTime) ? validTime : {};
  return { from: source.from ?? null, until: source.until ?? null };
};

const sliceExcerpt = (lines, start, end, startLine) => {
  const first = Math.max(startLine, Number(start));
  const last = Math.max(first, Number(end ?? start));
  return lines.slice(first - startLine, last - startLine + 1).join('\n');
};

/**
 * Map ONE model-proposed claim into a ratified documentary-claim/v2 record. Returns
 * { ok:true, record } or { ok:false, reason } — a malformed proposal is SKIPPED (recorded), never
 * fabricated. The verbatim excerpt is sliced from the REAL artifact content at the cited lines.
 */
export function buildNeuralClaimRecord({ proposed, file, content, startLine = 1, section, snapshot, model, promptDigest, generatorDigest, producerVersion = NEURAL_EXTRACTOR_VERSION }) {
  if (!proposed || typeof proposed !== 'object') return { ok: false, reason: 'not_an_object' };
  const subject = text(proposed.subject).trim();
  const predicate = text(proposed.predicate_family).trim();
  const object = text(proposed.object_or_value).trim();
  if (!subject || !predicate || !object) return { ok: false, reason: 'missing_core_field' };
  const start = Number(proposed.source_lines?.start);
  const end = Number(proposed.source_lines?.end ?? proposed.source_lines?.start);
  if (!Number.isInteger(start) || start < startLine) return { ok: false, reason: 'invalid_source_lines' };
  const lines = contentLines(content);
  const excerpt = sliceExcerpt(lines, start, end, startLine);
  if (!excerpt.trim()) return { ok: false, reason: 'empty_excerpt' };
  const neighbourhood = normalized(section) || 'documentation';
  const span = { file, path: file, line: start, start, end: Number.isInteger(end) ? end : start, excerpt };
  const record = createRecord('claim', {
    source_sha: snapshot.source_sha,
    snapshot_sha: snapshot.source_sha,
    corpus_digest: snapshot.corpus_digest,
    generator_digest: generatorDigest,
    prompt_digest: promptDigest,
    model_identifier: model,
    producer_version: producerVersion,
    subject_refs: [{ ref: subject, kind: text(proposed.subject_kind).trim() || 'concept', neighbourhood }],
    predicate_family: predicate,
    object_or_value: object,
    polarity: normalizePolarity(proposed.polarity),
    modality: normalizeModality(proposed.modality),
    quantifier: normalizeQuantifier(proposed.quantifier),
    scope: normalizeScope(proposed.scope),
    valid_time: normalizeValidTime(proposed.valid_time),
    provenance: {
      document_id: file,
      revision_id: snapshot.source_sha,
      spans: [span],
      // Verbatim source excerpt retained so the exact text the claim came from is inspectable.
      source_excerpts: [{ file, start, end: Number.isInteger(end) ? end : start, text: excerpt }],
    },
    spans: [span],
    source_path: file,
    source_text: excerpt,
    origin: 'neural_documentation_claim_extractor',
    disposition: { kind: 'open' },
    materiality: 'unclassified',
    provenance_class: 'docs',
  });
  return { ok: true, record };
}

/**
 * Extract neural documentary claims across the docs artifacts of a corpus. Reads only `docs`
 * artifacts, sorted deterministically, capped at maxArtifacts. Per artifact it calls a runner ONCE
 * per chunk, gated by a content-hash claim_attempt_key (an artifact whose attempt key was already
 * seen this run is not re-extracted). Returns the claim records plus per-artifact attempt keys,
 * skipped proposals, and the model identifier.
 *
 * BOUNDED CONCURRENCY (slice 4e). Pass `runnerPool` (an array of N warm runners) — or the legacy
 * single `runner` (a pool of one, the exact N=1 sequential path) — and up to N documents are
 * processed CONCURRENTLY, each on its own runner. A runner handles one document at a time (its
 * chunks are extracted serially, with the runner issuing new_session between its own calls), so
 * independence is preserved and no runner ever interleaves two documents. Results are MERGED IN
 * DOCUMENT (sorted-path) ORDER regardless of completion order, so the claim set + ordering are
 * byte-identical to the sequential (N=1) run and reproducible.
 */
export async function extractNeuralClaims({ corpus, raw_corpus, runner = null, runnerPool = null, snapshot, maxArtifacts = Infinity, model = null, maxDocBytes = DEFAULT_MAX_DOC_BYTES, callRetries = 0, checkpoint = null }) {
  const pool = normalizeRunnerPool(runnerPool, runner);
  if (pool.some(item => ['pi-rpc', 'pi-cli'].includes(item.kind)) && !checkpoint) throw new Error('paid extraction runner requires a durable checkpoint journal');
  if (!snapshot || !snapshot.source_sha || !snapshot.corpus_digest) throw new Error('extractNeuralClaims requires a snapshot { source_sha, corpus_digest }');
  if (!corpus || !Array.isArray(corpus.entries) || !Array.isArray(raw_corpus)) throw new Error('extractNeuralClaims requires { corpus.entries[], raw_corpus[] }');
  const entries = new Map(corpus.entries.map(entry => [entry.path, entry]));
  const docs = raw_corpus
    .filter(file => entries.get(file.path)?.provenance_class === 'docs')
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  const cap = Number.isFinite(maxArtifacts) ? Math.max(0, maxArtifacts) : docs.length;
  const selected = docs.slice(0, cap);
  const usedModel = model || pool[0].model || 'unknown-model';
  const generatorDigest = sha256(NEURAL_EXTRACTOR_VERSION);
  const attempts = [];
  const skipped = [];
  const chunk_counts = [];
  // Phase 1 (sequential, deterministic): compute per-doc attempt keys + reuse skips + chunk plans.
  // The reuse gate is stateful, so it runs BEFORE the concurrent phase to keep its skip-with-reason
  // decisions run-order-independent (concurrent completion order must never change which doc a
  // reused_claim_attempt_key was assigned to).
  const seenAttemptKeys = new Set();
  const workItems = [];
  for (const file of selected) {
    const content = text(file.content);
    const startLine = Number.isInteger(file.start_line) ? file.start_line : 1;
    // The staged extraction-reuse gate keys on the WHOLE-document content hash + path, so chunking a
    // large doc does not change reuse semantics for a small one.
    const wholePrompt = buildExtractionPrompt({ path: file.path, content, startLine });
    const attemptKey = claimAttemptKey({
      content_hash: sha256(content),
      section: file.path,
      genre_adapter: NEURAL_GENRE_ADAPTER,
      prompt_digest: sha256(wholePrompt),
      model_version: usedModel,
      claim_schema_version: CLAIM_SCHEMA_VERSION,
    });
    attempts.push({ path: file.path, claim_attempt_key: attemptKey });
    if (seenAttemptKeys.has(attemptKey)) { skipped.push({ path: file.path, reason: 'reused_claim_attempt_key' }); continue; }
    seenAttemptKeys.add(attemptKey);
    // Chunk the document (relative to the chunk-size threshold). A small doc is exactly one chunk
    // starting at line startLine; a large doc is several heading/paragraph-aligned chunks whose
    // startLine offsets keep every claim's cited source span/provenance real.
    const localChunks = chunkDocument(content, { maxDocBytes });
    const chunks = localChunks.map(chunk => ({ content: chunk.content, startLine: chunk.startLine + (startLine - 1) }));
    chunk_counts.push({ path: file.path, chunks: chunks.length });
    // Checkpoint key covers the existing attempt contract PLUS the actual chunk plan. A changed
    // prompt/content/model/schema/chunk size therefore misses safely instead of reusing stale claims.
    const checkpointKey = sha256(stableStringify({ inference_custody_policy: INFERENCE_CUSTODY_POLICY, attemptKey, chunks: chunks.map(chunk => ({ startLine: chunk.startLine, content_hash: sha256(chunk.content) })) }));
    workItems.push({ file, chunks, checkpointKey });
  }
  // Phase 2 (bounded-concurrent over the pool): one document per pooled runner at a time. Each doc's
  // chunks are extracted SERIALLY on the SAME runner (the runner issues new_session between its own
  // calls -> independence), so a runner never interleaves two documents. Per-doc results are returned
  // and merged in Phase 3 by document index, never by completion order.
  const perDoc = async (item, poolRunner) => {
    const { file, chunks, checkpointKey } = item;
    const cached = checkpoint?.get('extraction', checkpointKey);
    if (cached) return cached;
    const localClaims = [];
    const localSkipped = [];
    const localModelStats = [];
    // Section resolver over the WHOLE document (real doc line numbers), so each claim's
    // subject_neighbourhood is derived from the heading it sits under — fine-grained granularity that
    // keeps the proposition index from collapsing to one bucket at full-estate scale.
    const docStartLine = Number.isInteger(file.start_line) ? file.start_line : 1;
    const sectionAtLine = buildSectionResolver(text(file.content), docStartLine);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const prompt = buildExtractionPrompt({ path: file.path, content: chunk.content, startLine: chunk.startLine });
      assertInferencePromptWithinLimit(prompt);
      const promptDigest = sha256(prompt);
      const tag = chunks.length > 1 ? `extract:${file.path}#${chunkIndex}` : `extract:${file.path}`;
      const chunkKey = sha256(stableStringify({ inference_custody_policy: INFERENCE_CUSTODY_POLICY, checkpointKey, chunkIndex, promptDigest }));
      let chunkCompleted = checkpoint?.get('extraction-chunk', chunkKey);
      if (!chunkCompleted) {
        const started = checkpoint?.get('extraction-chunk-started', chunkKey);
        if (started) {
          // A durable start with no completion means the process died at an unknown point. It may
          // have reached/billed the provider, so resume refuses to repeat it automatically.
          const custody = interruptedInferenceCustody({ model: poolRunner.model, tag, kind: poolRunner.kind || 'unknown' });
          const skip = {
            path: file.path, reason: 'interrupted_call_unknown', chunk: chunkIndex,
            attempts: custody.result.attempts, retry_policy: custody.result.retry_policy, accepted: null,
            billing_status: custody.result.billing_status, reported_usage: null, inference_complete: false,
          };
          chunkCompleted = { claims: [], skipped: [skip], model_stats: custody.model_stats };
          await checkpoint?.put('extraction-chunk', chunkKey, chunkCompleted);
        } else {
          // Fsync the intent BEFORE invoking the provider. If the process dies during the call,
          // resume sees an ambiguous in-flight attempt and fails closed instead of repurchasing it.
          await checkpoint?.put('extraction-chunk-started', chunkKey, { tag, model: poolRunner.model, prompt_digest: promptDigest, inference_custody_policy: INFERENCE_CUSTODY_POLICY });
          const beforeStats = modelStatsSnapshot(poolRunner);
          const result = await invokeModelRunner(poolRunner, { prompt, tag }, { callRetries });
          const model_stats = modelStatsDelta(beforeStats, modelStatsSnapshot(poolRunner), poolRunner.model);
          const chunkClaims = [];
          const chunkSkipped = [];
          // An accepted timeout is a SKIP-with-custody, never an automatic retry: the chunk is
          // reported with billing status and the run remains explicitly incomplete.
          if (isTimeoutOutcome(result.outcome)) {
            chunkSkipped.push({
              path: file.path, reason: 'call_timeout', chunk: chunkIndex, attempts: result.attempts ?? 1,
              retry_policy: result.retry_policy ?? 'single-attempt', accepted: result.accepted ?? null,
              billing_status: result.billing_status ?? 'acceptance_unknown', reported_usage: result.usage ?? null,
              inference_complete: false,
            });
          } else {
            const parsed = result.json ?? parseCensusModelJson(result.text);
            const validPayload = Array.isArray(parsed?.claims) || Array.isArray(parsed);
            if (result.outcome !== 'ok' || !validPayload) {
              chunkSkipped.push({
                path: file.path, reason: 'model_call_incomplete', chunk: chunkIndex,
                outcome: result.outcome, accepted: result.accepted ?? null,
                billing_status: result.billing_status ?? 'acceptance_unknown', reported_usage: result.usage ?? null,
                inference_complete: false,
              });
            } else {
              const proposedClaims = Array.isArray(parsed?.claims) ? parsed.claims : parsed;
              if (proposedClaims.length > MAX_CLAIMS_PER_EXTRACTION_UNIT) {
                chunkSkipped.push({ path: file.path, reason: 'output_cardinality_exceeded', chunk: chunkIndex, claims: proposedClaims.length, max_claims: MAX_CLAIMS_PER_EXTRACTION_UNIT, inference_complete: false });
              } else {
                for (const proposed of proposedClaims) {
                  // Neighbourhood granularity: prefer the DOCUMENT SECTION heading the claim's cited line sits
                  // under (mirrors produceDocumentationClaims). When the claim precedes any heading, fall back to
                  // an explicit model-supplied section, then the model-inferred subject, then the 'documentation'
                  // default — so distinct subjects/sections land in distinct proposition-index buckets. The claim
                  // contract is unchanged; only subject_refs[0].neighbourhood gains granularity.
                  const claimStart = Number(proposed?.source_lines?.start);
                  const headingSection = Number.isInteger(claimStart) ? sectionAtLine(claimStart) : 'documentation';
                  const section = (headingSection && headingSection !== 'documentation' ? headingSection : '')
                    || text(proposed.section).trim()
                    || text(proposed.subject).trim()
                    || 'documentation';
                  const built = buildNeuralClaimRecord({ proposed, file: file.path, content: chunk.content, startLine: chunk.startLine, section, snapshot, model: usedModel, promptDigest, generatorDigest });
                  if (built.ok) chunkClaims.push(built.record);
                  else chunkSkipped.push({ path: file.path, reason: built.reason, chunk: chunkIndex, inference_complete: false });
                }
              }
            }
          }
          chunkCompleted = { claims: chunkClaims, skipped: chunkSkipped, model_stats };
          // Smallest paid durable unit: every completed chunk, including empty/invalid/timeout, is
          // fsynced before the next chunk starts.
          await checkpoint?.put('extraction-chunk', chunkKey, chunkCompleted);
        }
      }
      for (const claim of chunkCompleted.claims || []) localClaims.push(claim);
      for (const skip of chunkCompleted.skipped || []) localSkipped.push(skip);
      if (chunkCompleted.model_stats) localModelStats.push(chunkCompleted.model_stats);
      const incomplete = (chunkCompleted.skipped || []).find(skip => skip?.inference_complete === false);
      if (incomplete) openInferenceCircuit(`extraction stopped after incomplete paid unit ${tag}`, { stage: 'extraction', tag, path: file.path, chunk: chunkIndex, skip: incomplete, model_stats: chunkCompleted.model_stats });
    }
    const completed = {
      path: file.path,
      claims: localClaims,
      skipped: localSkipped,
      model_stats: combineModelStats(localModelStats, poolRunner.model),
    };
    await checkpoint?.put('extraction', checkpointKey, completed);
    return completed;
  };
  const { results, maxInFlight } = await mapWithRunnerPool(workItems, pool, perDoc);
  // Phase 3 (deterministic merge): concatenate per-document results in document (sorted-path) order.
  const claims = [];
  for (const result of results) {
    if (!result) continue;
    for (const claim of result.claims) claims.push(claim);
    for (const skip of result.skipped) skipped.push(skip);
  }
  const model_stats = combineModelStats(results.map(result => result?.model_stats), usedModel);
  return { claims, attempts, skipped, chunk_counts, model: usedModel, model_stats, artifacts_examined: selected.length, concurrency: pool.length, max_in_flight: maxInFlight };
}
