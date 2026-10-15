#!/usr/bin/env node
// Slice 4 (FIRST NEURAL slice) of the documentation-claim census (DESIGN §16.12.1, intent-779029e6).
// This entrypoint turns ON the neural path and adds the RESOLUTION/adjudication stage. It wires:
//
//   produceCorpus (deterministic, MODEL-FREE inventory)
//     -> extractNeuralClaims          (NEURAL: model reads artifacts -> documentary-claim/v2 records
//                                       with real, varying fields + retained verbatim source excerpts)
//     -> documentary-claim ledger      (slice 1: quarantined, snapshot-bound, append-only)
//     -> proposition index             (slice 2: normalize + bucket)
//     -> ten-relation classifier       (slice 2: classify every candidate PAIR)
//     -> DisagreementCase store         (slice 1: hyperedge case per disagreeing pair)
//     -> source-grounded resolution     (NEURAL: adjudicator reads BOTH sides' cited sources and
//                                        assigns one of the ELEVEN resolutions with a source-citing
//                                        rationale)
//     -> census report                  (this slice)
//
// IT IMPORTS THE LANDED SLICE-1/2/3 MODULES (censusFromClaims does ledger->index->classifier->cases);
// it does NOT re-invent them. The only new stages are the two NEURAL ones (extractor + resolver).
//
// MODEL PATH IS OPT-IN. A model is reached ONLY when this entrypoint is invoked with `--neural` (or a
// runner is injected by a test). Every model call goes through invokeModelRunner(runner, …); there is
// no ambient runner, so the ordinary build + the unit-test suite make no real model call.
//
// PROMOTION BOUNDARY. Neural claims live only in the documentary-claim ledger; resolutions live only
// in the resolution store. Neither ever enters the deterministic observation plane.
//
// BOUNDED PROOF vs COMPLETION. --max-artifacts / --max-resolutions cap the run's own model spend so
// the bounded proof is small and fast. The wizard runs the full-repo completion pass afterward with
// the caps raised. Model ids, call counts, and cost are recorded in the report.
import fs from './readonly-guard.mjs';
import { assertWritable, registerScanRoot } from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from './lib.mjs';
import { produceCorpus } from './neural-census.mjs';
import { censusFromClaims } from './documentation-claim-census.mjs';
import { extractNeuralClaims, DEFAULT_MAX_DOC_BYTES } from './neural-claim-extractor.mjs';
import { resolveDisagreementCases, ELEVEN_RESOLUTIONS } from './neural-resolution.mjs';
import { COMPARISON_RELATIONS } from './comparison-relation-classifier.mjs';
import { requireModel, DEFAULT_CALL_TIMEOUT_MS } from './neural-model-runner.mjs';
import { isUnpricedBillingStatus } from './inference-custody.mjs';

export const NEURAL_CENSUS_SCHEMA = 'estate-map/neural-documentation-claim-census/v1';
export const DEFAULT_RESOLVED_SAMPLE_SIZE = 5;
// Robustness defaults for a real bounded/full run (slice 4c).
export const DEFAULT_CALL_RETRIES = 0;                       // accepted inference is never auto-retried; targeted repair only
export const DEFAULT_EXCLUDE_GLOBS = Object.freeze(['_recovered-from-transcripts/**']); // transcript-dump noise
export const DEFAULT_EXCLUDE_OVER_BYTES = 500000;            // hard per-file cap (drops the ~977 KB backlog); NOT the chunk threshold
// Runner kinds (slice 4d). 'rpc' = persistent warm `pi --mode rpc` process (no per-call cold-start);
// 'oneshot' = the legacy spawn-pi-per-call path, kept as a fallback. Default is 'rpc'.
export const RUNNER_KINDS = Object.freeze(['oneshot', 'rpc']);
export const DEFAULT_RUNNER_KIND = 'rpc';
// Bounded concurrency (slice 4e). N warm `pi --mode rpc` processes run in parallel per stage to cut
// wall-time ~N× over the sequential (slice 4d) pass. The default is CONSERVATIVE: these are STEADY
// warm processes (not per-call cold-start floods), but each is a real resource (a live pi + provider
// connection), so the default stays modest and N is hard-capped. N=1 reproduces the exact sequential
// slice-4d behavior (regression-safe).
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 64;
export const clampConcurrency = value => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_CONCURRENCY, n);
};
export { DEFAULT_MAX_DOC_BYTES };

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

/** Build the neural census report. Pure. Carries claims, the relation histogram (now with non-zero
 *  divergences expected), DisagreementCase counts, resolutions-by-type, per-side source excerpts for
 *  a sample of resolved cases, and model / calls / cost. */
export function buildNeuralCensusReport({ snapshot, extraction, index, classification, disagreement, resolution, model, caps, sampleSize = DEFAULT_RESOLVED_SAMPLE_SIZE, estateRoot = null, corpusTotals = null, walltimeMs = null, excludedPaths = [], exclusionConfig = null, concurrency = null }) {
  const sampled = resolution.resolutions.slice(0, Math.max(0, sampleSize)).map(record => ({
    case_id: record.semantic.case_id,
    comparison_relation: record.semantic.comparison_relation,
    resolution: record.semantic.resolution,
    pair_conflict: record.semantic.pair_conflict,
    side_grounding: record.semantic.side_grounding,
    context_relation: record.semantic.context_relation,
    context_note: record.semantic.context_note,
    rationale: record.semantic.rationale,
    quoted_spans: record.semantic.quoted_spans,
    // Per-side verbatim cited sources, so a reader can inspect the exact text each side rested on.
    sides: record.semantic.sides.map(side => ({
      claim_id: side.claim_id,
      document_id: side.document_id,
      excerpts: side.excerpts,
    })),
  }));
  const divergenceRelations = ['scope_divergence', 'temporal_divergence', 'modality_divergence', 'conformance_gap_candidate'];
  const nonZeroDivergences = Object.fromEntries(divergenceRelations
    .map(relation => [relation, classification.histogram[relation] || 0])
    .filter(([, count]) => count > 0));
  return {
    schema: NEURAL_CENSUS_SCHEMA,
    // Which model-invocation transport ran: 'pi-rpc' (persistent warm process) or 'pi-cli' (one-shot);
    // 'mixed'/'mock' when stages differ or a test injected a mock. Makes cold-start elimination measurable.
    runner_kind: model?.kind ?? null,
    generated_by:
      'NEURAL documentation-claim census (extractNeuralClaims -> documentary-claim ledger -> proposition ' +
      'index -> ten-relation classifier -> DisagreementCase store -> source-grounded eleven-state resolution)',
    neural_extraction: 'ENABLED via explicit census invocation (--neural / injected runner); every model call routed through invokeModelRunner(runner)',
    epistemic_constitution: 'source > docs > model prose; model agreement is NOT evidence; a missing witness is not falsity; resolutions cite verbatim source spans',
    promotion_boundary: 'neural claims (documentary-claim ledger) and resolutions (resolution store) never mutate the deterministic observation/structural plane',
    snapshot,
    caps,
    // Bounded concurrency (slice 4e): the pool size N in flight per stage and the OBSERVED peak
    // number of documents/cases processed concurrently (a mock-transport test asserts peak == N).
    // N=1 is the sequential regression path.
    concurrency,
    extraction_max_in_flight: extraction.max_in_flight ?? null,
    resolution_max_in_flight: resolution.max_in_flight ?? null,
    // Extraction
    artifacts_examined: extraction.artifacts_examined,
    claims_extracted: index.claimCount,
    claims_skipped: extraction.skipped.length,
    claim_attempt_keys: extraction.attempts.length,
    extraction_skipped_detail: extraction.skipped,
    // Per-document chunk counts (large docs are split on heading/paragraph boundaries; small docs = 1).
    document_chunk_counts: extraction.chunk_counts || [],
    resolutions_skipped_detail: resolution.skipped,
    // Working-corpus exclusion: which paths were dropped from the examined set and WHY.
    excluded_paths: excludedPaths,
    exclusion_config: exclusionConfig,
    // Comparison
    proposition_count: index.propositions.length,
    bucket_count: index.bucketCount,
    candidate_pairs_compared: classification.comparedPairs,
    naive_n_choose_2_baseline: index.naivePairCount,
    relation_histogram: classification.histogram,
    non_zero_divergence_relations: nonZeroDivergences,
    relations: COMPARISON_RELATIONS,
    // Disagreement
    disagreement_cases_total: disagreement.cases_total,
    disagreement_cases_by_relation: disagreement.cases_by_relation,
    // Resolution (the deconfliction)
    resolutions_total: resolution.resolutions_total,
    resolutions_by_type: resolution.by_resolution,
    resolutions_skipped: resolution.skipped.length,
    resolution_vocabulary: ELEVEN_RESOLUTIONS,
    sampled_resolved_cases: sampled,
    // Model / calls / cost — attributed PER STAGE (extraction vs resolution), each naming its model id.
    model,
    estate_root: estateRoot,
    corpus_totals: corpusTotals,
    walltime_ms: walltimeMs,
  };
}

// Snapshot the cumulative stats() of every runner in a pool (one array entry per pooled runner).
function poolStatsSnapshot(pool) {
  return pool.map(runner => runner.stats());
}

// Per-stage delta across a POOL of runners: sum calls + cost and concatenate the per_call tail of
// each runner between the before/after snapshots. Works for a pool of one (the N=1 sequential path,
// where the delta isolates that stage's calls on the single shared runner) or N distinct runners.
// The concatenated per_call list is sorted by tag so the report is byte-stable regardless of which
// pooled runner happened to process which document.
function stageDeltaPool(beforeArr, afterArr, modelId) {
  const per_call = [];
  let calls = 0;
  let cost = 0;
  const kinds = new Set();
  for (let i = 0; i < afterArr.length; i += 1) {
    const before = beforeArr[i] || { calls: 0, cost: 0, per_call: [], kind: afterArr[i].kind };
    const after = afterArr[i];
    kinds.add(after.kind);
    calls += after.calls - before.calls;
    cost += (after.cost || 0) - (before.cost || 0);
    for (const call of after.per_call.slice(before.per_call.length)) per_call.push(call);
  }
  per_call.sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
  const stageModels = [...new Set(per_call.map(call => call.model))];
  const unpriced_attempts = per_call.filter(call => isUnpricedBillingStatus(call.billing_status)).length;
  return {
    model: modelId,
    kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
    calls,
    cost: Number(cost.toFixed(6)),
    cost_status: unpriced_attempts ? 'lower_bound' : 'complete',
    unpriced_attempts,
    models: stageModels.length ? stageModels : [modelId],
    per_call,
  };
}

/** Assemble the report's model section attributing calls + cost PER STAGE and naming both model ids.
 *  Operates over per-stage runner POOLS (a pool of one is the N=1 path). */
function buildPerStageModel({ extractPool, resolvePool, beforeExtract, afterExtract, beforeResolve, afterResolve, extractionStats = null, resolutionStats = null }) {
  // Prefer per-work-unit stats carried in checkpoint entries: they preserve historical spend across
  // process restarts. Pool deltas remain the backward-compatible fallback for callers without them.
  const extraction = extractionStats || stageDeltaPool(beforeExtract, afterExtract, extractPool[0].model);
  const resolution = resolutionStats || stageDeltaPool(beforeResolve, afterResolve, resolvePool[0].model);
  return {
    extraction,
    resolution,
    extraction_model: extractPool[0].model,
    resolution_model: resolvePool[0].model,
    kind: extraction.kind === resolution.kind ? extraction.kind : 'mixed',
    calls: extraction.calls + resolution.calls,
    cost: Number((extraction.cost + resolution.cost).toFixed(6)),
    cost_status: Number(extraction.unpriced_attempts || 0) + Number(resolution.unpriced_attempts || 0) > 0 ? 'lower_bound' : 'complete',
    unpriced_attempts: Number(extraction.unpriced_attempts || 0) + Number(resolution.unpriced_attempts || 0),
    models: [...new Set([extractPool[0].model, resolvePool[0].model])],
  };
}

/**
 * Pure-ish core: given an already-produced corpus + raw docs content and injected runners, run the
 * full extract -> index -> classify -> resolve flow and return the report plus live stores for tests.
 * Deterministic given deterministic runners. No estate access, no file writes here.
 *
 * PER-STAGE MODEL SPLIT (slice 4b): extraction and resolution use SEPARATE runners so each stage can
 * run a different model. Pass `extractionRunner` + `resolutionRunner`; a single `runner` is accepted
 * as the shared fallback for both (back-compat). The extraction runner is passed to extractNeuralClaims
 * and the resolution runner to resolveDisagreementCases.
 */
export async function neuralCensusFromCorpus({ corpus, raw_corpus, runner = null, extractionRunner = null, resolutionRunner = null, extractionRunnerPool = null, resolutionRunnerPool = null, runnerPool = null, concurrency = null, snapshot, maxArtifacts = Infinity, maxResolutions = Infinity, sampleSize = DEFAULT_RESOLVED_SAMPLE_SIZE, maxDocBytes = DEFAULT_MAX_DOC_BYTES, callRetries = DEFAULT_CALL_RETRIES, excludedPaths = [], exclusionConfig = null, checkpoint = null }) {
  // Resolve each stage's runner POOL. Preference order: explicit per-stage pool -> shared pool ->
  // legacy single per-stage runner -> legacy shared single runner (a pool of one = the N=1 path).
  const extractPool = asPool(extractionRunnerPool || runnerPool) || asPool(extractionRunner || runner);
  const resolvePool = asPool(resolutionRunnerPool || runnerPool) || asPool(resolutionRunner || runner);
  if (!extractPool) throw new Error('neuralCensusFromCorpus requires an extraction ModelRunner or pool (extractionRunnerPool / runnerPool / extractionRunner / runner)');
  if (!resolvePool) throw new Error('neuralCensusFromCorpus requires a resolution ModelRunner or pool (resolutionRunnerPool / runnerPool / resolutionRunner / runner)');

  const beforeExtract = poolStatsSnapshot(extractPool);
  const extraction = await extractNeuralClaims({ corpus, raw_corpus, runnerPool: extractPool, snapshot, maxArtifacts, maxDocBytes, callRetries, checkpoint });
  const afterExtract = poolStatsSnapshot(extractPool);

  const { ledger, index, classification, disagreement } = censusFromClaims(extraction.claims, { snapshot });
  const claimsById = new Map(extraction.claims.map(claim => [claim.id, claim]));

  const beforeResolve = poolStatsSnapshot(resolvePool);
  const resolution = await resolveDisagreementCases({ cases: disagreement.store.list(), claimsById, runnerPool: resolvePool, snapshot, maxResolutions, callRetries, checkpoint });
  const afterResolve = poolStatsSnapshot(resolvePool);

  const caps = { max_artifacts: Number.isFinite(maxArtifacts) ? maxArtifacts : null, max_resolutions: Number.isFinite(maxResolutions) ? maxResolutions : null };
  const model = buildPerStageModel({ extractPool, resolvePool, beforeExtract, afterExtract, beforeResolve, afterResolve, extractionStats: extraction.model_stats, resolutionStats: resolution.model_stats });
  const reportedConcurrency = concurrency != null ? concurrency : Math.max(extractPool.length, resolvePool.length);
  const report = buildNeuralCensusReport({ snapshot, extraction, index, classification, disagreement, resolution, model, caps, sampleSize, excludedPaths, exclusionConfig, concurrency: reportedConcurrency });
  return { report, extraction, ledger, index, classification, disagreement, resolution };
}

// Coerce a pool-or-runner argument to a runner array, or null when nothing usable was passed.
function asPool(value) {
  if (Array.isArray(value)) return value.length ? value.slice() : null;
  if (value && typeof value.complete === 'function') return [value];
  return null;
}

// Resolve a stage pool from an injected pool argument first, then a single injected runner.
function poolFrom(poolArg, singleArg) {
  return asPool(poolArg) || asPool(singleArg);
}

/** Read the full-text content of every processed `docs` corpus entry into raw_corpus shape. Reads only. */
async function readDocsRawCorpus(root, corpus) {
  const raw = [];
  for (const entry of corpus.entries) {
    if (entry.provenance_class !== 'docs' || entry.disposition !== 'processed') continue;
    const content = await fs.readFile(path.join(root, entry.path), 'utf8');
    raw.push({ path: entry.path, content, start_line: 1 });
  }
  return raw;
}

/**
 * The end-to-end neural entrypoint over a real estate. Writes the census report to an EXPLICIT
 * outFile OUTSIDE the scanned estate (read-only guard enforced). The model path is OPT-IN: either
 * `neural: true` (constructs the real Pi-CLI runner) or an injected `runner` (tests). Otherwise it
 * throws — no model is ever called by default.
 */
export async function runNeuralDocumentationCensus({ root, outFile, neural = false, runner = null, extractionRunner = null, resolutionRunner = null, extractionRunnerPool = null, resolutionRunnerPool = null, runnerPool = null, concurrency = DEFAULT_CONCURRENCY, maxArtifacts = Infinity, maxResolutions = Infinity, extractionModel = null, resolutionModel = null, runnerKind = DEFAULT_RUNNER_KIND, thinking = null, scratchDir = null, sampleSize = DEFAULT_RESOLVED_SAMPLE_SIZE, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, callRetries = DEFAULT_CALL_RETRIES, maxDocBytes = DEFAULT_MAX_DOC_BYTES, excludeGlobs = DEFAULT_EXCLUDE_GLOBS, excludeOverBytes = DEFAULT_EXCLUDE_OVER_BYTES }) {
  const estate = await fs.realpath(root);
  registerScanRoot(estate, { registeredBy: 'neural-documentation-census.mjs' });
  if (!outFile) throw new Error('runNeuralDocumentationCensus requires an explicit outFile outside the scanned estate');
  const resolvedOut = assertWritable(path.resolve(outFile), { op: 'write neural census report', tool: 'neural-documentation-census.mjs' });
  if (!RUNNER_KINDS.includes(runnerKind)) throw new Error(`unknown --runner "${runnerKind}"; expected one of ${RUNNER_KINDS.join(' | ')}`);
  // PER-STAGE runner POOLS (slice 4e). An injected pool/runner is the fallback for both stages
  // This legacy combined entrypoint accepts injected runners for zero-spend compatibility only.
  // Real paid execution is checkpoint-mandatory and lives in census-graph-export.mjs.
  const extractPool = poolFrom(extractionRunnerPool || runnerPool, extractionRunner || runner);
  const resolvePool = poolFrom(resolutionRunnerPool || runnerPool, resolutionRunner || runner);
  if (!extractPool || !resolvePool) {
    if (neural === true) throw new Error('paid combined census entrypoint is disabled because it lacks a checkpoint argument; use census-graph-export.mjs --checkpoint');
    throw new Error('neural census is OPT-IN: inject a runner for zero-spend tests, or use the checkpointed census-graph-export paid path.');
  }

  const started = now();
  // Exclusion is applied HERE, on the neural entrypoint: `.estate-mapignore` is honored by produceCorpus
  // and the configured `--exclude` globs (default: transcript-dump dir) + per-file byte cap drop noise.
  const corpus = await produceCorpus(estate, { excludeGlobs, excludeOverBytes });
  const excludedPaths = [
    ...corpus.exclusions.map(item => ({ path: item.path, reason: item.reason })),
    ...corpus.entries.filter(entry => entry.disposition === 'excluded_with_reason').map(entry => ({ path: entry.path, reason: entry.reason })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const exclusionConfig = { exclude_globs: [...excludeGlobs], exclude_over_bytes: Number.isFinite(excludeOverBytes) ? excludeOverBytes : null, max_doc_bytes: maxDocBytes, call_timeout_ms: callTimeoutMs, call_retries: callRetries, honors_estate_mapignore: true };
  const rawCorpus = await readDocsRawCorpus(estate, corpus);
  const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
  const { report } = await neuralCensusFromCorpus({
    corpus: { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest, entries: corpus.entries },
    raw_corpus: rawCorpus, extractionRunnerPool: extractPool, resolutionRunnerPool: resolvePool,
    concurrency: Math.max(extractPool.length, resolvePool.length), snapshot, maxArtifacts, maxResolutions, sampleSize,
    maxDocBytes, callRetries, excludedPaths, exclusionConfig,
  });
  const walltimeMs = Number((now() - started).toFixed(3));

  const fullReport = { ...report, estate_root: estate, corpus_totals: corpus.totals, walltime_ms: walltimeMs, out_path: resolvedOut };
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  await fs.writeFile(resolvedOut, stableStringify(fullReport));
  return fullReport;
}

// Local arg parser: `--neural` is a boolean flag (the shared parseArgs would swallow the next token).
function parseNeuralArgs(argv) {
  const positional = [];
  const options = {};
  const booleans = new Set(['neural', 'help']);
  const repeatable = new Set(['exclude']); // --exclude <glob> may be given multiple times
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (booleans.has(key)) options[key] = true;
      else if (repeatable.has(key)) (options[key] = options[key] || []).push(argv[++i]);
      else options[key] = argv[++i];
    } else positional.push(arg);
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseNeuralArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Legacy combined entrypoint: real paid execution disabled; use census-graph-export.mjs --checkpoint.',
      '                     [--max-artifacts N] [--max-resolutions N] [--extraction-model <id>]',
      '                     [--resolution-model <id>] [--thinking <level>]',
      '',
      '  --neural            Refused here; checkpointed paid execution lives in census-graph-export.mjs.',
      '  --out               REQUIRED; must resolve OUTSIDE the scanned estate (read-only guard enforced).',
      '  --max-artifacts N   cap docs artifacts extracted (bounded proof; omit for the full completion pass).',
      '  --max-resolutions N cap DisagreementCases resolved (bounded proof).',
      '  --extraction-model  bulk extraction model (required; there is no default).',
      '  --resolution-model  resolution/adjudication model (required; there is no default).',
      `  --runner KIND       model transport: ${RUNNER_KINDS.join(' | ')} (default ${DEFAULT_RUNNER_KIND}). rpc = one warm pi process per model (no per-call cold-start); oneshot = spawn pi per call (fallback).`,
      `  --concurrency N     bounded concurrency: N warm runners per stage, up to N docs/cases in flight (default ${DEFAULT_CONCURRENCY}, cap ${MAX_CONCURRENCY}). N=1 = sequential. Cuts wall-time ~N× on a full-estate run.`,
      `  --call-timeout-ms N per-model-call timeout (default ${DEFAULT_CALL_TIMEOUT_MS}); accepted timeout is terminal and billing-custodied.`,
      `  --call-retries N    deprecated compatibility input (default ${DEFAULT_CALL_RETRIES}); accepted timeouts are never auto-retried.`,
      `  --max-doc-bytes N   chunk a doc larger than N bytes on heading/paragraph boundaries (default ${DEFAULT_MAX_DOC_BYTES}).`,
      `  --exclude <glob>    repeatable; drop matching estate-relative paths (default excludes ${DEFAULT_EXCLUDE_GLOBS.join(', ')}). Also honors .estate-mapignore.`,
      `  --exclude-over-bytes N  drop any single doc larger than N bytes (default ${DEFAULT_EXCLUDE_OVER_BYTES}).`,
    ].join('\n'));
    return;
  }
  const root = positional[0] || process.cwd();
  if (!options.out) {
    console.error('error: --out is REQUIRED and must resolve OUTSIDE the scanned estate.');
    process.exit(2);
  }
  const toInt = value => (value === undefined ? Infinity : Number.parseInt(value, 10));
  const toIntOr = (value, fallback) => (value === undefined ? fallback : Number.parseInt(value, 10));
  const report = await runNeuralDocumentationCensus({
    root,
    outFile: options.out,
    neural: options.neural === true,
    maxArtifacts: toInt(options['max-artifacts']),
    maxResolutions: toInt(options['max-resolutions']),
    extractionModel: requireModel(options['extraction-model'], '--extraction-model'),
    resolutionModel: requireModel(options['resolution-model'], '--resolution-model'),
    runnerKind: options.runner || DEFAULT_RUNNER_KIND,
    concurrency: options.concurrency !== undefined ? clampConcurrency(options.concurrency) : DEFAULT_CONCURRENCY,
    thinking: options.thinking || null,
    callTimeoutMs: toIntOr(options['call-timeout-ms'], DEFAULT_CALL_TIMEOUT_MS),
    callRetries: toIntOr(options['call-retries'], DEFAULT_CALL_RETRIES),
    maxDocBytes: toIntOr(options['max-doc-bytes'], DEFAULT_MAX_DOC_BYTES),
    excludeGlobs: options.exclude && options.exclude.length ? options.exclude : DEFAULT_EXCLUDE_GLOBS,
    excludeOverBytes: toIntOr(options['exclude-over-bytes'], DEFAULT_EXCLUDE_OVER_BYTES),
  });
  console.log(stableStringify({
    out_path: report.out_path,
    artifacts_examined: report.artifacts_examined,
    claims_extracted: report.claims_extracted,
    relation_histogram: report.relation_histogram,
    non_zero_divergence_relations: report.non_zero_divergence_relations,
    disagreement_cases_total: report.disagreement_cases_total,
    disagreement_cases_by_relation: report.disagreement_cases_by_relation,
    resolutions_total: report.resolutions_total,
    resolutions_by_type: report.resolutions_by_type,
    document_chunk_counts: report.document_chunk_counts,
    excluded_paths: report.excluded_paths,
    exclusion_config: report.exclusion_config,
    runner_kind: report.runner_kind,
    concurrency: report.concurrency,
    extraction_max_in_flight: report.extraction_max_in_flight,
    resolution_max_in_flight: report.resolution_max_in_flight,
    model: report.model,
    walltime_ms: report.walltime_ms,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
