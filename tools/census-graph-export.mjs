#!/usr/bin/env node
// READ-ONLY explorer graph export for the HTML claim explorer. Two paths, both read-only and both
// emitting the same nodes+edges JSON shape the template (`claim-explorer-template.html`) consumes:
//
//   DETERMINISTIC (default, MODEL-FREE): produceDocumentationClaims -> proposition index ->
//     ten-relation classifier. This is the model-free control path; it makes NO provider/model call.
//
//   NEURAL (opt-in, injected runner): neuralCensusFromCorpus (extraction + source-grounded
//     eleven-state resolution). Nodes are the NEURAL claims and carry their retained VERBATIM source
//     excerpt + document + provenance_class; edges are the classified relations (now including the
//     divergence relations only neural extraction produces); and each edge whose DisagreementCase was
//     RESOLVED carries the eleven-state resolution + the adjudicator's rationale + quoted spans + both
//     sides' cited source excerpts, so the explorer can show WHY a pair is (or isn't) a real conflict.
//
// The neural path reaches a model ONLY through an injected runner/pool (or, for the CLI, an explicit
// `--neural` that builds a POOL of persistent RPC runners — createPiRpcRunner, the same warm-pool
// stack the census entrypoint uses — selectable via `--runner oneshot|rpc` (default rpc) and
// `--concurrency N`). Ordinary import + the unit tests use a mock runner and make no real model call.
// No repo write: JSON is printed to stdout (redirect it outside the repo).
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { produceCorpus } from './neural-census.mjs';
import { produceDocumentationClaims } from './neural-census-producers.mjs';
import { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';
import { buildPropositionIndex } from './proposition-index.mjs';
import { classifyRelation } from './comparison-relation-classifier.mjs';
import { neuralCensusFromCorpus, RUNNER_KINDS, DEFAULT_RUNNER_KIND, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_CALL_RETRIES, clampConcurrency } from './neural-documentation-census.mjs';
import { createPiModelRunner, createPiRpcRunner, requireModel } from './neural-model-runner.mjs';
import { extractNeuralClaims, DEFAULT_MAX_DOC_BYTES, NEURAL_EXTRACTOR_VERSION } from './neural-claim-extractor.mjs';
import { censusFromClaims } from './documentation-claim-census.mjs';
import { resolveDisagreementCases, RESOLUTION_ADJUDICATOR_VERSION } from './neural-resolution.mjs';
import { createExtractionArtifact, readExtractionArtifact, validateExtractionArtifact } from './extraction-artifact.mjs';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { sha256, stableStringify } from './lib.mjs';

const RARE = new Set(['direct_conflict', 'compatible_partial', 'terminology_conflict', 'equivalent_proposition',
  'scope_divergence', 'temporal_divergence', 'modality_divergence', 'conformance_gap_candidate']);

const NODE_CAP = 150;
const EDGE_CAP = 480;
const RA_PER_NODE = 4;

const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '\u2026' : t);
const pairKey = (a, b) => `${a}\u0000${b}`;
const sem = record => (record && record.semantic) || record || {};

/**
 * Compact per-stage usage/cost block for meta, built from the census report's per-stage model
 * stats (stageDeltaPool output: {calls, cost, per_call:[{cost,input_tokens,output_tokens,...}]}).
 * Token sums are derived from per_call; if the report is absent the gap is recorded explicitly
 * rather than fabricating numbers.
 */
function buildUsageMeta(report) {
  const model = report?.model;
  if (!model) return { available: false, note: 'census core did not report per-stage model stats' };
  const stage = s => {
    if (!s) return null;
    const sums = (s.per_call || []).reduce((acc, c) => {
      acc.input_tokens += Number(c.input_tokens || 0);
      acc.output_tokens += Number(c.output_tokens || 0);
      return acc;
    }, { input_tokens: 0, output_tokens: 0 });
    return { model: s.model ?? null, kind: s.kind ?? null, calls: s.calls ?? 0, cost_usd: Number(s.cost ?? 0), cost_status: s.cost_status ?? 'complete', unpriced_attempts: Number(s.unpriced_attempts || 0), ...sums };
  };
  const extraction = stage(model.extraction);
  const resolution = stage(model.resolution);
  return {
    extraction, resolution,
    total: {
      calls: model.calls ?? ((extraction?.calls || 0) + (resolution?.calls || 0)),
      cost_usd: Number(model.cost ?? 0),
      cost_status: (extraction?.unpriced_attempts || 0) + (resolution?.unpriced_attempts || 0) > 0 ? 'lower_bound' : 'complete',
      unpriced_attempts: (extraction?.unpriced_attempts || 0) + (resolution?.unpriced_attempts || 0),
      input_tokens: (extraction?.input_tokens || 0) + (resolution?.input_tokens || 0),
      output_tokens: (extraction?.output_tokens || 0) + (resolution?.output_tokens || 0),
    },
  };
}

/** Read the full-text content of every processed `docs` corpus entry. Reads only; never writes. */
async function readDocsRawCorpus(root, corpus) {
  const raw = [];
  for (const entry of corpus.entries) {
    if (entry.provenance_class !== 'docs' || entry.disposition !== 'processed') continue;
    const content = await fs.readFile(path.join(root, entry.path), 'utf8');
    raw.push({ path: entry.path, content, start_line: 1 });
  }
  return raw;
}

// ─────────────────────────────── DETERMINISTIC (model-free) ────────────────────────────────

/**
 * Build the bounded nodes+edges subgraph from the deterministic, model-free census. Pure. Buckets
 * are selected for relation variety; `incomparable` edges are omitted and `referent_ambiguity` is
 * throttled per node. Each node also carries the verbatim SOURCE line it was parsed from so the
 * explorer can show sourcing material (operator: "I don't see sourcing materials").
 */
export function buildDeterministicGraph({ corpus, raw, allClaims }) {
  const rawLinesByPath = new Map(raw.map(file => [file.path, String(file.content).split(/\r?\n/)]));
  // Stable short id at the claim's own level so normalizeClaimToProposition carries a unique claim_id.
  const wrapped = allClaims.map((c, i) => ({ ...c, id: 'c' + i }));
  const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
  const index = buildPropositionIndex(wrapped, { snapshot });

  const scored = [];
  for (const b of index.buckets) {
    if (b.size < 2 || b.size > 12) continue;
    const edges = [];
    for (let i = 0; i < b.propositions.length; i++)
      for (let j = i + 1; j < b.propositions.length; j++) {
        const rel = classifyRelation(b.propositions[i], b.propositions[j]);
        if (rel !== 'incomparable') edges.push([b.propositions[i].claim_id, b.propositions[j].claim_id, rel]);
      }
    if (!edges.length) continue;
    const rareCount = edges.filter(e => RARE.has(e[2])).length;
    scored.push({ b, edges, rareCount });
  }
  scored.sort((x, y) => y.rareCount - x.rareCount || (x.b.size - y.b.size));

  const nodeIds = new Set();
  const chosen = [];
  for (const s of scored) {
    if (nodeIds.size >= NODE_CAP) break;
    for (const p of s.b.propositions) nodeIds.add(p.claim_id);
    chosen.push(s);
  }
  const idNum = cid => parseInt(cid.slice(1), 10);
  const propById = new Map();
  for (const b of index.buckets) for (const p of b.propositions) if (nodeIds.has(p.claim_id)) propById.set(p.claim_id, { p, bucket: b.key });
  const sourceExcerpt = claimSem => {
    const span = (claimSem.provenance?.spans || claimSem.spans || [])[0];
    if (!span) return { text: '', ref: null };
    const lines = rawLinesByPath.get(span.file ?? span.path) || [];
    const line = Number(span.start ?? span.line);
    return { text: Number.isInteger(line) ? (lines[line - 1] ?? '') : '', ref: `${span.file ?? span.path}:${line}` };
  };
  const nodes = [];
  for (const cid of nodeIds) {
    const { p, bucket } = propById.get(cid);
    const s = sem(allClaims[idNum(cid)]);
    const excerpt = sourceExcerpt(s);
    nodes.push({
      id: cid,
      neighbourhood: p.subject_neighbourhood,
      predicate: p.predicate_family,
      modality: p.modality,
      polarity: p.polarity,
      quantifier: p.quantifier,
      label: trunc(p.statement, 46),
      statement: p.statement,
      document: s.provenance?.document_id ?? s.source_path ?? '(unknown)',
      provenance_class: s.provenance_class ?? '(unknown)',
      source_excerpt: excerpt.text,
      source_excerpt_ref: excerpt.ref,
      bucket,
    });
  }
  const raCount = new Map();
  const edges = [];
  outer: for (const s of chosen) {
    for (const [a, b, rel] of s.edges) {
      if (edges.length >= EDGE_CAP) break outer;
      if (rel === 'referent_ambiguity') {
        const ca = raCount.get(a) || 0, cb = raCount.get(b) || 0;
        if (ca >= RA_PER_NODE || cb >= RA_PER_NODE) continue;
        raCount.set(a, ca + 1); raCount.set(b, cb + 1);
      }
      edges.push({ source: a, target: b, rel });
    }
  }
  const relHist = {};
  for (const e of edges) relHist[e.rel] = (relHist[e.rel] || 0) + 1;

  return {
    meta: {
      mode: 'deterministic',
      source_sha: corpus.source_sha,
      total_claims: allClaims.length,
      total_buckets: index.bucketCount,
      total_candidate_pairs: index.candidatePairCount,
      naive_pairs: index.naivePairCount,
      sample_nodes: nodes.length,
      sample_edges: edges.length,
      sample_relation_histogram: relHist,
      corpus_totals: corpus.totals,
      note: 'Bounded sample of the deterministic, model-free census. Buckets selected for relation variety; incomparable edges omitted; referent_ambiguity throttled per node. Full census: ' + allClaims.length + ' claims / ' + index.candidatePairCount + ' candidate pairs.',
    },
    nodes,
    edges,
  };
}

/** Deterministic export over a real estate. Read-only, model-free. */
export async function exportDeterministicGraph(root) {
  const estate = await fs.realpath(root);
  const corpus = await produceCorpus(estate);
  const raw = await readDocsRawCorpus(estate, corpus);
  const allClaims = produceDocumentationClaims({
    corpus: { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest, entries: corpus.entries },
    raw_corpus: raw,
  });
  return buildDeterministicGraph({ corpus, raw, allClaims });
}

// ───────────────────────────────── NEURAL (opt-in, runner) ─────────────────────────────────

/**
 * Build the explorer graph from a NEURAL census result (the object neuralCensusFromCorpus returns).
 * Pure. Nodes are the neural claims (with their verbatim source excerpt + document + provenance_class)
 * and edges are the classified relations; every edge whose DisagreementCase was RESOLVED carries the
 * eleven-state resolution + rationale + quoted spans + both sides' cited source excerpts.
 */
export function buildNeuralGraph({ corpus, extraction, index, disagreement, resolution, nodeCap = NODE_CAP, edgeCap = EDGE_CAP }) {
  const claimsById = new Map(extraction.claims.map(claim => [claim.id, claim]));
  const bucketByClaim = new Map();
  for (const bucket of index.buckets) for (const p of bucket.propositions) bucketByClaim.set(p.claim_id, bucket.key);

  const includedProps = index.propositions.slice(0, nodeCap);
  const includedIds = new Set(includedProps.map(p => p.claim_id));

  const sourceExcerpt = s => {
    const excerpts = s.provenance?.source_excerpts || [];
    return {
      text: excerpts.map(e => e.text).filter(Boolean).join('\n'),
      ref: excerpts.map(e => `${e.file}:${e.start}-${e.end}`).join(', ') || null,
    };
  };
  const nodes = includedProps.map(p => {
    const s = sem(claimsById.get(p.claim_id));
    const excerpt = sourceExcerpt(s);
    return {
      id: p.claim_id,
      neighbourhood: p.subject_neighbourhood,
      predicate: p.predicate_family,
      modality: p.modality,
      polarity: p.polarity,
      quantifier: p.quantifier,
      label: trunc(p.statement, 46),
      statement: p.statement,
      document: s.provenance?.document_id ?? s.source_path ?? '(unknown)',
      provenance_class: s.provenance_class ?? '(unknown)',
      source_excerpt: excerpt.text,
      source_excerpt_ref: excerpt.ref,
      // Lossless semantics for downstream canonical projections and full-semantic adjudicator replay.
      claim_semantics: {
        subject_refs: s.subject_refs,
        object_or_value: s.object_or_value,
        scope: s.scope,
        valid_time: s.valid_time,
      },
      bucket: bucketByClaim.get(p.claim_id) ?? null,
    };
  });

  // Map an ordered claim pair -> its DisagreementCase id -> its resolution record.
  const caseByPair = new Map();
  for (const a of disagreement.assemblies) caseByPair.set(pairKey(a.claims[0], a.claims[1]), a.case_id);
  const resolutionByCase = new Map(resolution.resolutions.map(r => [sem(r).case_id, r]));

  const edges = [];
  let resolvedEdges = 0;
  for (const { a, b } of index.candidatePairs()) {
    if (edges.length >= edgeCap) break;
    if (!includedIds.has(a.claim_id) || !includedIds.has(b.claim_id)) continue;
    const rel = classifyRelation(a, b);
    if (rel === 'incomparable') continue;
    const edge = { source: a.claim_id, target: b.claim_id, rel };
    const res = resolutionByCase.get(caseByPair.get(pairKey(a.claim_id, b.claim_id)));
    if (res) {
      const rs = sem(res);
      edge.case_id = rs.case_id;
      edge.resolution = rs.resolution;
      edge.resolution_rationale = rs.rationale;
      edge.pair_conflict = rs.pair_conflict;
      edge.side_grounding = rs.side_grounding;
      edge.context_relation = rs.context_relation;
      edge.context_note = rs.context_note;
      edge.quoted_spans = rs.quoted_spans;
      edge.sides = rs.sides.map(side => ({
        claim_id: side.claim_id,
        document_id: side.document_id,
        excerpts: side.excerpts.map(e => ({ file: e.file, start: e.start, end: e.end, text: e.text })),
      }));
      resolvedEdges += 1;
    }
    edges.push(edge);
  }
  const relHist = {};
  for (const e of edges) relHist[e.rel] = (relHist[e.rel] || 0) + 1;

  return {
    meta: {
      mode: 'neural',
      source_sha: corpus.source_sha,
      total_claims: extraction.claims.length,
      total_buckets: index.bucketCount,
      total_candidate_pairs: index.candidatePairCount,
      naive_pairs: index.naivePairCount,
      sample_nodes: nodes.length,
      sample_edges: edges.length,
      // Bounded concurrency (slice 4f): the extraction pool size N and the OBSERVED peak number of
      // documents processed concurrently (a mock-transport test asserts peak == N). N=1 = sequential.
      concurrency: extraction.concurrency ?? null,
      extraction_max_in_flight: extraction.max_in_flight ?? null,
      resolved_edges: resolvedEdges,
      disagreement_cases_total: disagreement.cases_total,
      resolutions_total: resolution.resolutions_total,
      resolution_incomplete_paid_units: (resolution.skipped || []).filter(item => item?.inference_complete === false).length,
      extraction_model: extraction.model,
      resolution_model: resolution.model,
      sample_relation_histogram: relHist,
      corpus_totals: corpus.totals,
      note: 'Neural census export. Nodes carry the verbatim source excerpt the model read; edges carry classified relations including divergences; resolved DisagreementCases carry the eleven-state resolution + rationale + both sides\u2019 quoted source spans.',
    },
    nodes,
    edges,
  };
}

// Coerce a pool-or-runner argument to a runner array, or null when nothing usable was passed (mirrors
// neural-documentation-census.asPool/poolFrom so the explorer export uses the SAME pool semantics).
const asPool = value => {
  if (Array.isArray(value)) return value.length ? value.slice() : null;
  if (value && typeof value.complete === 'function') return [value];
  return null;
};
const poolFrom = (poolArg, singleArg) => asPool(poolArg) || asPool(singleArg);

async function selectedCorpus(root, corpusManifest = null) {
  const estate = await fs.realpath(root);
  const corpus = await produceCorpus(estate);
  let raw = await readDocsRawCorpus(estate, corpus);
  let manifestMeta = null;
  if (corpusManifest) {
    const patterns = corpusManifest.patterns.map(pattern => (pattern instanceof RegExp ? pattern : new RegExp(pattern)));
    const before = raw.length;
    raw = raw.filter(document => patterns.some(pattern => pattern.test(document.path)));
    manifestMeta = { path: corpusManifest.path ?? null, patterns: patterns.length, docs_before: before, docs_matched: raw.length };
  }
  const selected_docs_hash = sha256(stableStringify(raw.map(document => ({ path: document.path, content_hash: sha256(document.content) }))));
  return {
    estate,
    corpus,
    raw,
    snapshot: { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest },
    manifestMeta,
    selected_docs_hash,
  };
}

function buildStagePool({ existing, neural, runnerKind, model, thinking, scratchDir, size, builtRunners }) {
  if (existing) return existing;
  if (neural !== true) throw new Error('neural execution is OPT-IN: pass --neural or inject a runner');
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('paid inference gate is closed; complete free architecture gates, then set ASCRYBE_ENABLE_PAID_INFERENCE=1 explicitly');
  const makeRunner = () => (runnerKind === 'rpc'
    ? createPiRpcRunner({ model, thinking, scratchDir })
    : createPiModelRunner({ model, thinking, scratchDir }));
  return Array.from({ length: size }, () => { const runner = makeRunner(); builtRunners.push(runner); return runner; });
}

/** Run only the paid extraction stage and return a complete, replayable claim artifact. */
export async function exportNeuralClaimsArtifact({ root, neural = false, runner = null, extractionRunner = null, extractionRunnerPool = null, runnerPool = null, runnerKind = DEFAULT_RUNNER_KIND, concurrency = DEFAULT_CONCURRENCY, extractionConcurrency = null, extractionModel = requireModel(options['extraction-model'], '--extraction-model'), thinking = null, scratchDir = null, maxArtifacts = Infinity, maxDocBytes = DEFAULT_MAX_DOC_BYTES, callRetries = DEFAULT_CALL_RETRIES, corpusManifest = null, checkpointPath = null }) {
  if (!RUNNER_KINDS.includes(runnerKind)) throw new Error(`unknown --runner "${runnerKind}"; expected one of ${RUNNER_KINDS.join(' | ')}`);
  if (neural === true && !checkpointPath) throw new Error('paid neural extraction requires --checkpoint for per-unit start/completion custody');
  const builtRunners = [];
  let checkpoint = null;
  try {
    const selected = await selectedCorpus(root, corpusManifest);
    const existing = poolFrom(extractionRunnerPool || runnerPool, extractionRunner || runner);
    const pool = buildStagePool({ existing, neural, runnerKind, model: extractionModel, thinking, scratchDir, size: clampConcurrency(extractionConcurrency ?? concurrency), builtRunners });
    if (checkpointPath) checkpoint = await openCheckpointJournal({
      file: checkpointPath,
      fingerprint: {
        pipeline: 'estate-map/neural-claim-extraction/v1',
        ...selected.snapshot,
        selected_docs_hash: selected.selected_docs_hash,
        extraction_model: pool[0].model,
        extractor_version: NEURAL_EXTRACTOR_VERSION,
        max_artifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : null,
        max_doc_bytes: maxDocBytes,
        call_retries: callRetries,
        inference_custody_policy: INFERENCE_CUSTODY_POLICY,
      },
    });
    const extraction = await extractNeuralClaims({
      corpus: { source_sha: selected.corpus.source_sha, corpus_digest: selected.corpus.corpus_digest, entries: selected.corpus.entries },
      raw_corpus: selected.raw,
      runnerPool: pool,
      snapshot: selected.snapshot,
      maxArtifacts,
      maxDocBytes,
      callRetries,
      checkpoint,
    });
    return createExtractionArtifact({
      snapshot: selected.snapshot,
      extraction,
      selection: {
        selected_docs_hash: selected.selected_docs_hash,
        selected_docs: selected.raw.length,
        corpus_manifest: selected.manifestMeta,
        max_artifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : null,
        max_doc_bytes: maxDocBytes,
        extraction_model: pool[0].model,
        checkpoint: checkpoint ? {
          entries: checkpoint.stats().entries,
          fingerprint_hash: checkpoint.stats().fingerprint_hash,
        } : null,
      },
    });
  } finally {
    await checkpoint?.close();
    for (const built of builtRunners) { try { await built.shutdown?.(); } catch { /* best effort */ } }
  }
}

/** Replay a frozen extraction through deterministic comparison and one adjudicator model. */
export async function exportNeuralGraphFromClaims({ root, claimsArtifact, neural = false, runner = null, resolutionRunner = null, resolutionRunnerPool = null, runnerPool = null, runnerKind = DEFAULT_RUNNER_KIND, concurrency = DEFAULT_CONCURRENCY, resolutionConcurrency = null, resolutionModel = requireModel(options['resolution-model'], '--resolution-model'), thinking = null, scratchDir = null, maxResolutions = Infinity, callRetries = DEFAULT_CALL_RETRIES, nodeCap = null, edgeCap = null, includeResolutions = false, checkpointPath = null }) {
  if (!RUNNER_KINDS.includes(runnerKind)) throw new Error(`unknown --runner "${runnerKind}"; expected one of ${RUNNER_KINDS.join(' | ')}`);
  if (neural === true && !checkpointPath) throw new Error('paid neural resolution requires --checkpoint for per-unit start/completion custody');
  const loaded = typeof claimsArtifact === 'string' ? await readExtractionArtifact(claimsArtifact) : { artifact: validateExtractionArtifact(claimsArtifact), path: null, file_sha256: null };
  const artifact = loaded.artifact;
  const estate = await fs.realpath(root);
  const corpus = await produceCorpus(estate);
  if (corpus.source_sha !== artifact.snapshot.source_sha || corpus.corpus_digest !== artifact.snapshot.corpus_digest) {
    throw new Error(`claims artifact snapshot mismatch: artifact ${artifact.snapshot.source_sha}/${artifact.snapshot.corpus_digest}, estate ${corpus.source_sha}/${corpus.corpus_digest}`);
  }
  const builtRunners = [];
  let checkpoint = null;
  try {
    const existing = poolFrom(resolutionRunnerPool || runnerPool, resolutionRunner || runner);
    const pool = buildStagePool({ existing, neural, runnerKind, model: resolutionModel, thinking, scratchDir, size: clampConcurrency(resolutionConcurrency ?? concurrency), builtRunners });
    if (checkpointPath) checkpoint = await openCheckpointJournal({
      file: checkpointPath,
      fingerprint: {
        pipeline: 'estate-map/frozen-claim-resolution/v1',
        artifact_digest: artifact.artifact_digest,
        resolution_model: pool[0].model,
        adjudicator_version: RESOLUTION_ADJUDICATOR_VERSION,
        max_resolutions: Number.isFinite(maxResolutions) ? maxResolutions : null,
        call_retries: callRetries,
        inference_custody_policy: INFERENCE_CUSTODY_POLICY,
      },
    });
    const extraction = artifact.extraction;
    const { index, disagreement } = censusFromClaims(extraction.claims, { snapshot: artifact.snapshot });
    const claimsById = new Map(extraction.claims.map(claim => [claim.id, claim]));
    const resolution = await resolveDisagreementCases({
      cases: disagreement.store.list(), claimsById, runnerPool: pool, snapshot: artifact.snapshot,
      maxResolutions, callRetries, checkpoint,
    });
    const graph = buildNeuralGraph({ corpus, extraction, index, disagreement, resolution, nodeCap: nodeCap ?? undefined, edgeCap: edgeCap ?? undefined });
    graph.meta.extraction_concurrency = extraction.concurrency ?? null;
    graph.meta.resolution_concurrency = pool.length;
    const extractionStats = extraction.model_stats || { model: extraction.model, kind: 'unknown', calls: 0, cost: 0, per_call: [] };
    const resolutionStats = resolution.model_stats || { model: pool[0].model, kind: 'unknown', calls: 0, cost: 0, per_call: [] };
    graph.meta.usage = buildUsageMeta({ model: {
      extraction: extractionStats,
      resolution: resolutionStats,
      calls: Number(extractionStats.calls || 0) + Number(resolutionStats.calls || 0),
      cost: Number(extractionStats.cost || 0) + Number(resolutionStats.cost || 0),
    } });
    graph.meta.extraction_replay = { artifact_digest: artifact.artifact_digest, path: loaded.path, file_sha256: loaded.file_sha256, claims_digest: artifact.claims_digest };
    graph.meta.corpus_manifest = artifact.selection?.corpus_manifest ?? null;
    graph.meta.checkpoint = checkpoint?.stats() ?? null;
    if (includeResolutions) graph.resolutions = resolution.resolutions.map(record => sem(record));
    return graph;
  } finally {
    await checkpoint?.close();
    for (const built of builtRunners) { try { await built.shutdown?.(); } catch { /* best effort */ } }
  }
}

/**
 * Neural export over a real estate. Model path is OPT-IN: pass an injected `runner` (shared) or
 * `extractionRunner` + `resolutionRunner`, or per-stage pools (`extractionRunnerPool` /
 * `resolutionRunnerPool`) / a shared `runnerPool` (tests); or `neural:true` to BUILD the runners.
 *
 * THROUGHPUT (slice 4f): the built neural path now uses the PERSISTENT RPC runner (createPiRpcRunner)
 * + a bounded-concurrency POOL — the SAME warm-pool stack the census entrypoint uses — instead of
 * cold-start one-shot runners. `runnerKind` selects the transport ('rpc' default warm process, or
 * 'oneshot' fallback) and `concurrency` (N, clamped) sets the pool size / max docs in flight per
 * stage. N=1 reproduces the sequential path. Pooled RPC runners spawn LAZILY (first .complete()), and
 * every runner WE build is shut down at run end. The emitted node/edge shape is unchanged.
 */
export async function exportNeuralGraph({ root, neural = false, runner = null, extractionRunner = null, resolutionRunner = null, extractionRunnerPool = null, resolutionRunnerPool = null, runnerPool = null, runnerKind = DEFAULT_RUNNER_KIND, concurrency = DEFAULT_CONCURRENCY, extractionConcurrency = null, resolutionConcurrency = null, extractionModel = requireModel(options['extraction-model'], '--extraction-model'), resolutionModel = requireModel(options['resolution-model'], '--resolution-model'), thinking = null, scratchDir = null, maxArtifacts = Infinity, maxResolutions = Infinity, nodeCap = null, edgeCap = null, includeResolutions = false, corpusManifest = null, checkpointPath = null }) {
  if (!RUNNER_KINDS.includes(runnerKind)) throw new Error(`unknown --runner "${runnerKind}"; expected one of ${RUNNER_KINDS.join(' | ')}`);
  if (neural === true && !checkpointPath) throw new Error('paid neural census requires --checkpoint for per-unit start/completion custody');
  // Per-stage pool sizes (extraction vs resolution volumes differ wildly — e.g. 50 extraction calls
  // vs 562 resolutions in the first bounded run); each defaults to the shared --concurrency.
  const extractSize = clampConcurrency(extractionConcurrency ?? concurrency);
  const resolveSize = clampConcurrency(resolutionConcurrency ?? concurrency);
  // Prefer injected per-stage pools -> shared pool -> legacy per-stage single runner -> shared single
  // runner (a pool of one = the N=1 sequential path). Tests inject a pool of fake-RPC runners here.
  let extractPool = poolFrom(extractionRunnerPool || runnerPool, extractionRunner || runner);
  let resolvePool = poolFrom(resolutionRunnerPool || runnerPool, resolutionRunner || runner);
  const builtRunners = [];
  let checkpoint = null;
  if (!extractPool || !resolvePool) {
    if (neural !== true) throw new Error('neural export is OPT-IN: pass --neural (CLI) / neural:true, or inject a runner. Without it no model is called.');
    if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('paid inference gate is closed; complete free architecture gates, then set ASCRYBE_ENABLE_PAID_INFERENCE=1 explicitly');
    const makeRunner = model => (runnerKind === 'rpc'
      ? createPiRpcRunner({ model, thinking, scratchDir })
      : createPiModelRunner({ model, thinking, scratchDir }));
    const buildPool = (model, size) => Array.from({ length: size }, () => { const r = makeRunner(model); builtRunners.push(r); return r; });
    if (!extractPool) extractPool = buildPool(extractionModel, extractSize);
    if (!resolvePool) resolvePool = buildPool(resolutionModel, resolveSize);
  }
  try {
    const estate = await fs.realpath(root);
    const corpus = await produceCorpus(estate);
    let raw = await readDocsRawCorpus(estate, corpus);
    // Truth-surface curation: an explicit committed manifest of include-regexes bounds WHICH docs
    // are extracted (and therefore mapped). The manifest is the auditable record of census scope -
    // "0 real conflicts" is only meaningful relative to a stated corpus.
    let manifestMeta = null;
    if (corpusManifest) {
      const patterns = corpusManifest.patterns.map(p => (p instanceof RegExp ? p : new RegExp(p)));
      const before = raw.length;
      raw = raw.filter(d => patterns.some(r => r.test(d.path)));
      manifestMeta = { path: corpusManifest.path ?? null, patterns: patterns.length, docs_before: before, docs_matched: raw.length };
    }
    const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
    if (checkpointPath) {
      const selectedDocsHash = sha256(stableStringify(raw.map(doc => ({ path: doc.path, content_hash: sha256(doc.content) }))));
      checkpoint = await openCheckpointJournal({
        file: checkpointPath,
        fingerprint: {
          pipeline: 'estate-map/census-pipeline-checkpoint-contract/v1',
          ...snapshot,
          selected_docs_hash: selectedDocsHash,
          extraction_model: extractPool[0].model,
          resolution_model: resolvePool[0].model,
          max_artifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : null,
          max_resolutions: Number.isFinite(maxResolutions) ? maxResolutions : null,
          inference_custody_policy: INFERENCE_CUSTODY_POLICY,
        },
      });
    }
    const { report, extraction, index, disagreement, resolution } = await neuralCensusFromCorpus({
      corpus: { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest, entries: corpus.entries },
      raw_corpus: raw, extractionRunnerPool: extractPool, resolutionRunnerPool: resolvePool,
      concurrency: Math.max(extractPool.length, resolvePool.length), snapshot, maxArtifacts, maxResolutions, checkpoint,
    });
    const graph = buildNeuralGraph({ corpus, extraction, index, disagreement, resolution, nodeCap: nodeCap ?? undefined, edgeCap: edgeCap ?? undefined });
    // Honest per-stage reporting (meta.concurrency remains the legacy max-of-pools for back-compat).
    graph.meta.extraction_concurrency = extractPool.length;
    graph.meta.resolution_concurrency = resolvePool.length;
    graph.meta.usage = buildUsageMeta(report);
    graph.meta.corpus_manifest = manifestMeta;
    graph.meta.checkpoint = checkpoint?.stats() ?? null;
    // The resolutions are the analytically valuable output; node sampling must not hide them.
    if (includeResolutions) graph.resolutions = resolution.resolutions.map(record => sem(record));
    return graph;
  } finally {
    // Fail closed if the durability barrier itself fails; a "successful" run with an unflushed
    // checkpoint would make crash-safety claims we cannot prove.
    await checkpoint?.close();
    // Graceful shutdown of any warm process(es) WE built (a persistent RPC runner holds a live pi).
    for (const built of builtRunners) { try { await built.shutdown?.(); } catch { /* best effort */ } }
  }
}

// ───────────────────────────────────────── CLI ─────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const booleans = new Set(['neural', 'help', 'full', 'include-resolutions', 'extract-only']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (booleans.has(key)) options[key] = true;
      else options[key] = argv[++i];
    } else positional.push(arg);
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const root = positional[0] || process.cwd();
  const toInt = value => (value === undefined ? Infinity : Number.parseInt(value, 10));
  const corpusManifest = options['corpus-manifest']
    ? { path: options['corpus-manifest'], patterns: JSON.parse(await fs.readFile(options['corpus-manifest'], 'utf8')).include }
    : null;
  if (options['extract-only'] && options['claims-in']) throw new Error('--extract-only and --claims-in are mutually exclusive');
  if (options['extract-only'] && !options.output) throw new Error('--extract-only requires --output <claims.json>');

  let result;
  if (options['extract-only']) {
    result = await exportNeuralClaimsArtifact({
      root, neural: options.neural === true,
      runnerKind: options.runner || DEFAULT_RUNNER_KIND,
      concurrency: options.concurrency !== undefined ? clampConcurrency(options.concurrency) : DEFAULT_CONCURRENCY,
      extractionConcurrency: options['extraction-concurrency'] !== undefined ? clampConcurrency(options['extraction-concurrency']) : null,
      extractionModel: options['extraction-model'] || requireModel(options['extraction-model'], '--extraction-model'),
      thinking: options.thinking || null,
      maxArtifacts: toInt(options['max-artifacts']),
      maxDocBytes: options['max-doc-bytes'] === undefined ? DEFAULT_MAX_DOC_BYTES : Number.parseInt(options['max-doc-bytes'], 10),
      callRetries: options['call-retries'] === undefined ? DEFAULT_CALL_RETRIES : Number.parseInt(options['call-retries'], 10),
      corpusManifest,
      checkpointPath: options.checkpoint || null,
    });
  } else if (options['claims-in']) {
    result = await exportNeuralGraphFromClaims({
      root, claimsArtifact: options['claims-in'], neural: options.neural === true,
      runnerKind: options.runner || DEFAULT_RUNNER_KIND,
      concurrency: options.concurrency !== undefined ? clampConcurrency(options.concurrency) : DEFAULT_CONCURRENCY,
      resolutionConcurrency: options['resolution-concurrency'] !== undefined ? clampConcurrency(options['resolution-concurrency']) : null,
      resolutionModel: options['resolution-model'] || requireModel(options['resolution-model'], '--resolution-model'),
      thinking: options.thinking || null,
      maxResolutions: toInt(options['max-resolutions']),
      callRetries: options['call-retries'] === undefined ? DEFAULT_CALL_RETRIES : Number.parseInt(options['call-retries'], 10),
      nodeCap: options.full ? Infinity : (options['node-cap'] !== undefined ? Number.parseInt(options['node-cap'], 10) : null),
      edgeCap: options.full ? Infinity : (options['edge-cap'] !== undefined ? Number.parseInt(options['edge-cap'], 10) : null),
      includeResolutions: Boolean(options.full || options['include-resolutions']),
      checkpointPath: options.checkpoint || null,
    });
  } else if (options.neural) {
    result = await exportNeuralGraph({
      root, neural: true,
      runnerKind: options.runner || DEFAULT_RUNNER_KIND,
      concurrency: options.concurrency !== undefined ? clampConcurrency(options.concurrency) : DEFAULT_CONCURRENCY,
      extractionModel: options['extraction-model'] || requireModel(options['extraction-model'], '--extraction-model'),
      resolutionModel: options['resolution-model'] || requireModel(options['resolution-model'], '--resolution-model'),
      thinking: options.thinking || null,
      maxArtifacts: toInt(options['max-artifacts']),
      maxResolutions: toInt(options['max-resolutions']),
      extractionConcurrency: options['extraction-concurrency'] !== undefined ? clampConcurrency(options['extraction-concurrency']) : null,
      resolutionConcurrency: options['resolution-concurrency'] !== undefined ? clampConcurrency(options['resolution-concurrency']) : null,
      nodeCap: options.full ? Infinity : (options['node-cap'] !== undefined ? Number.parseInt(options['node-cap'], 10) : null),
      edgeCap: options.full ? Infinity : (options['edge-cap'] !== undefined ? Number.parseInt(options['edge-cap'], 10) : null),
      includeResolutions: Boolean(options.full || options['include-resolutions']),
      corpusManifest,
      checkpointPath: options.checkpoint || null,
    });
  } else {
    result = await exportDeterministicGraph(root);
  }

  const serialized = `${JSON.stringify(result)}\n`;
  if (options.output) {
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    await fs.writeFile(temporary, serialized, 'utf8');
    await fs.rename(temporary, output);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
