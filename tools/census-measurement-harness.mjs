#!/usr/bin/env node
// A6 empirical answer: measurement harness for the documentation-claim proposition index + ten-relation
// classifier (DESIGN §16.12.1). Slice 2 of intent-779029e6.
//
// WHAT IT DOES. Runs the DETERMINISTIC, MODEL-FREE slice-1 producer (produceDocumentationClaims — the
// regex parser) over THIS repo's real documentation corpus, normalizes the emitted claims into the
// proposition index, classifies every same-bucket candidate pair into the ten ratified comparison
// relations, and emits a report to an EXPLICIT --out path (never the repo root, enforced by the
// read-only guard). It reports claim/bucket counts, the bucket-size distribution, candidate pairs
// actually compared vs the naive n-choose-2 baseline, the ten-class relation histogram, walltime, and
// peak RSS, plus a plain tractability statement.
//
// HONESTY. The deterministic parser UNDER-EXTRACTS relative to a future neural pass (it stamps
// constant polarity/scope/valid_time, so most divergence relations are structurally rare here). Every
// report is therefore explicitly labelled a LOWER-BOUND on volume and records that it MUST be re-run
// once neural extraction lands. No provider/model is called anywhere; the estate is read-only.
import fs from './readonly-guard.mjs';
import { assertWritable, registerScanRoot } from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stableStringify } from './lib.mjs';
import { produceCorpus } from './neural-census.mjs';
import { produceDocumentationClaims } from './neural-census-producers.mjs';
import { buildPropositionIndex, distribution } from './proposition-index.mjs';
import { classifyIndex, COMPARISON_RELATIONS, RELATION_DECISION_RULES } from './comparison-relation-classifier.mjs';

export const MEASUREMENT_SCHEMA = 'estate-map/doc-census-measurement/v1';

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

/**
 * Read the full-text content of every `docs` corpus entry into the raw_corpus shape the sealed
 * producer boundary requires. Reads only; never writes. Skips non-processed entries.
 */
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
 * Run the full measurement over `root` and return the report object (also written to `outFile`).
 * Pure of any provider/model path. `outFile` must resolve OUTSIDE the scanned estate (guard-enforced).
 */
export async function runMeasurement({ root, outFile }) {
  const peak = { rss: process.memoryUsage().rss };
  const sample = () => { const rss = process.memoryUsage().rss; if (rss > peak.rss) peak.rss = rss; };
  const estate = await fs.realpath(root);
  registerScanRoot(estate, { registeredBy: 'census-measurement-harness.mjs' });
  if (!outFile) throw new Error('runMeasurement requires an explicit outFile outside the scanned estate');
  const resolvedOut = assertWritable(path.resolve(outFile), { op: 'write measurement report', tool: 'census-measurement-harness.mjs' });

  const started = now();
  const corpus = await produceCorpus(estate);
  sample();
  const rawCorpus = await readDocsRawCorpus(estate, corpus);
  sample();
  const claims = produceDocumentationClaims({
    corpus: { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest, entries: corpus.entries },
    raw_corpus: rawCorpus,
  });
  sample();
  const snapshot = { source_sha: corpus.source_sha, corpus_digest: corpus.corpus_digest };
  const index = buildPropositionIndex(claims, { snapshot });
  sample();
  const { histogram, comparedPairs } = classifyIndex(index);
  sample();
  const walltimeMs = Number((now() - started).toFixed(3));

  const bucketDist = distribution(index.bucketSizes);
  const reductionFactor = index.candidatePairCount > 0 ? Number((index.naivePairCount / index.candidatePairCount).toFixed(2)) : null;
  // Honesty: a single over-large bucket can dominate the compared-pair total (the deterministic
  // parser dumps unresolved-referent claims into one coarse neighbourhood). Report the largest
  // bucket's share so the reduction factor is not read as uniform.
  const largestSize = index.bucketSizes.length ? Math.max(...index.bucketSizes) : 0;
  const largestBucketPairs = (largestSize * (largestSize - 1)) / 2;
  const largest_bucket = {
    size: largestSize,
    candidate_pairs: largestBucketPairs,
    share_of_candidate_pairs: index.candidatePairCount > 0 ? Number((largestBucketPairs / index.candidatePairCount).toFixed(4)) : 0,
  };
  const tractable = index.candidatePairCount <= index.claimCount * 50; // sub-quadratic in practice
  const report = {
    schema: MEASUREMENT_SCHEMA,
    generated_by: 'deterministic model-free documentation-claim parser (produceDocumentationClaims); NO provider/model call',
    snapshot,
    estate_root: estate,
    corpus_totals: corpus.totals,
    claim_count: index.claimCount,
    bucket_count: index.bucketCount,
    bucket_size_distribution: bucketDist,
    candidate_pairs_compared: comparedPairs,
    candidate_pairs_from_index: index.candidatePairCount,
    naive_n_choose_2_baseline: index.naivePairCount,
    pair_reduction_factor: reductionFactor,
    largest_bucket,
    relation_histogram: histogram,
    relation_decision_rules: RELATION_DECISION_RULES,
    walltime_ms: walltimeMs,
    peak_rss_bytes: peak.rss,
    peak_rss_mb: Number((peak.rss / (1024 * 1024)).toFixed(1)),
    tractability_statement:
      `Over ${index.claimCount} deterministically-extracted claims the index built ${index.bucketCount} buckets and compared ` +
      `${comparedPairs} candidate pairs versus a naive ${index.naivePairCount}-pair baseline` +
      `${reductionFactor ? ` (${reductionFactor}x fewer)` : ''}, in ${walltimeMs} ms at ${Number((peak.rss / (1024 * 1024)).toFixed(1))} MB peak RSS. ` +
      `The bucketed index is ${tractable ? 'TRACTABLE' : 'NOT clearly tractable'} at this extraction volume; ` +
      `the largest single bucket (size ${largestSize}) accounts for ${(largest_bucket.share_of_candidate_pairs * 100).toFixed(1)}% of compared pairs.`,
    lower_bound_caveat:
      'LOWER BOUND ON VOLUME. The deterministic regex parser under-extracts relative to a future neural pass ' +
      '(it stamps constant polarity/scope/valid_time and one predicate_family), so both the claim volume and the ' +
      'divergence-relation counts here are floors. This measurement MUST be re-run once neural extraction lands ' +
      'before any tractability claim is treated as final.',
    relations: COMPARISON_RELATIONS,
  };

  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  await fs.writeFile(resolvedOut, stableStringify(report));
  sample();
  report.peak_rss_bytes = peak.rss;
  report.peak_rss_mb = Number((peak.rss / (1024 * 1024)).toFixed(1));
  report.out_path = resolvedOut;
  return report;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const root = positional[0] || process.cwd();
  const out = options.out;
  if (!out) {
    console.error('usage: node census-measurement-harness.mjs [estate-root] --out <report.json>');
    console.error('  --out is REQUIRED and must resolve OUTSIDE the scanned estate (read-only guard enforced).');
    process.exit(2);
  }
  const report = await runMeasurement({ root, outFile: out });
  console.log(stableStringify({
    out_path: report.out_path,
    claim_count: report.claim_count,
    bucket_count: report.bucket_count,
    bucket_size_distribution: report.bucket_size_distribution,
    candidate_pairs_compared: report.candidate_pairs_compared,
    naive_n_choose_2_baseline: report.naive_n_choose_2_baseline,
    pair_reduction_factor: report.pair_reduction_factor,
    relation_histogram: report.relation_histogram,
    walltime_ms: report.walltime_ms,
    peak_rss_mb: report.peak_rss_mb,
    tractability_statement: report.tractability_statement,
    lower_bound_caveat: report.lower_bound_caveat,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error); process.exit(1); });
}
