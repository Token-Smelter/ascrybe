#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import { assertWritable, registerScanRoot } from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stableStringify } from './lib.mjs';
import { produceCorpus } from './neural-census.mjs';
import { produceDocumentationClaims } from './neural-census-producers.mjs';
import { createDocumentaryClaimLedger } from './documentary-claim-ledger.mjs';
import { buildPropositionIndex, distribution } from './proposition-index.mjs';
import {
  classifyIndex, classifyRelation, COMPARISON_RELATIONS,
} from './comparison-relation-classifier.mjs';
import {
  createDisagreementCaseStore, renderContradictsProjection,
} from './disagreement-case-store.mjs';

export const CENSUS_SCHEMA = 'estate-map/documentation-claim-census/v1';

// A DisagreementCase is assembled for every comparison relation EXCEPT the two that are not a
// disagreement: `incomparable` (no comparison basis) and `equivalent_proposition` (the same
// proposition asserted twice — agreement, not tension).
export const NON_DISAGREEMENT_RELATIONS = Object.freeze(['incomparable', 'equivalent_proposition']);
export const DISAGREEMENT_RELATIONS = Object.freeze(
  COMPARISON_RELATIONS.filter(relation => !NON_DISAGREEMENT_RELATIONS.includes(relation)),
);

// The relation is carried in the case_kind so the rendering projection can recover it WITHOUT the
// case having to store propositions (which would breach the promotion boundary). The projection
// reads it back out; the A10 test verifies that recovered relation against the classifier's actual
// assignment over the real propositions.
const CASE_KIND_PREFIX = 'doc_claim_comparison:';
export const caseKindForRelation = relation => `${CASE_KIND_PREFIX}${relation}`;
export function relationFromCaseKind(caseKind) {
  const value = String(caseKind ?? '');
  if (!value.startsWith(CASE_KIND_PREFIX)) return null;
  const relation = value.slice(CASE_KIND_PREFIX.length);
  return COMPARISON_RELATIONS.includes(relation) ? relation : null;
}

// direct_conflict is the one relation whose participants actually CONTRADICT; other disagreement
// relations are divergences/ambiguities that stay `unresolved` (still drawable) until evidence
// discharges them. State comes from the ratified CASE_STATES vocabulary.
const stateForRelation = relation => (relation === 'direct_conflict' ? 'contradicted' : 'unresolved');

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

const claimProvenance = claim => {
  const sem = claim?.semantic ?? {};
  const prov = sem.provenance ?? {};
  const documentId = prov.document_id ?? sem.source_path ?? null;
  const spans = Array.isArray(prov.spans) && prov.spans.length ? prov.spans : (Array.isArray(sem.spans) ? sem.spans : []);
  return { documentId, spans };
};

/**
 * Assemble the DisagreementCase hyperedges from the classifier's ACTUAL relation assignments over a
 * proposition index. Pure/deterministic: iterates the index's candidate pairs in its deterministic
 * order, classifies each with the real ten-relation classifier, and — for every non-incomparable /
 * non-equivalent relation — adds a snapshot-bound hyperedge case binding the two real claims and
 * their document provenance. Returns the store, the per-relation case histogram, and the list of
 * (relation, case_id, claim pair) assemblies for downstream projection/verification.
 */
export function assembleDisagreementCases(claims, index, { snapshot }) {
  if (!snapshot || !snapshot.source_sha || !snapshot.corpus_digest) {
    throw new Error('assembleDisagreementCases requires a snapshot { source_sha, corpus_digest }');
  }
  const claimsById = new Map(claims.map(claim => [claim.id, claim]));
  const store = createDisagreementCaseStore({ snapshot });
  const byRelation = Object.fromEntries(COMPARISON_RELATIONS.map(relation => [relation, 0]));
  const assemblies = [];
  for (const { a, b } of index.candidatePairs()) {
    const relation = classifyRelation(a, b);
    byRelation[relation] += 1;
    if (NON_DISAGREEMENT_RELATIONS.includes(relation)) continue;
    const claimA = claimsById.get(a.claim_id);
    const claimB = claimsById.get(b.claim_id);
    if (!claimA || !claimB) continue; // a case must bind real claim records
    const provA = claimProvenance(claimA);
    const provB = claimProvenance(claimB);
    const documents = [...new Set([provA.documentId, provB.documentId].filter(Boolean))];
    const spans = [...provA.spans, ...provB.spans];
    const body = {
      case_kind: caseKindForRelation(relation),
      state: stateForRelation(relation),
      documents,
      claims: [a.claim_id, b.claim_id],
      provenance: { document_ids: documents, spans },
    };
    const { id } = store.add(body);
    assemblies.push({ relation, case_id: id, claims: [a.claim_id, b.claim_id] });
  }
  const casesByRelation = Object.fromEntries(DISAGREEMENT_RELATIONS.map(relation => [relation, 0]));
  for (const record of store.list()) {
    const relation = relationFromCaseKind(record.semantic.case_kind);
    if (relation && casesByRelation[relation] !== undefined) casesByRelation[relation] += 1;
  }
  return {
    store,
    disagreement_pairs_by_relation: Object.freeze(byRelation),
    cases_by_relation: Object.freeze(casesByRelation),
    cases_total: store.size(),
    assemblies,
  };
}

/**
 * The rendering projection (adjudication A10). Renders a stored DisagreementCase into the
 * relation / CONTRADICTS view: the relation recovered from the case, and the derived binary
 * CONTRADICTS edges (emitted ONLY for the contradiction relation — a scope/temporal divergence is
 * not a contradiction). Because the projection's behaviour depends on the relation, a projection
 * that diverges from the classifier's actual relation assignment is observable and testable
 * (see documentationClaimCensusSlice3.test.mjs — the projection is verified against real classifier
 * output over real produced claims, never hand-synthesized cases).
 */
export function renderDisagreementRelationView(caseRecord) {
  if (!caseRecord?.semantic) throw new Error('cannot render a non-case');
  const relation = relationFromCaseKind(caseRecord.semantic.case_kind);
  const isContradiction = relation === 'direct_conflict';
  const contradicts_edges = isContradiction ? renderContradictsProjection(caseRecord) : [];
  return deepFreeze({
    case_id: caseRecord.id,
    relation,
    state: caseRecord.semantic.state,
    is_contradiction: isContradiction,
    participants: caseRecord.semantic.claims.slice(),
    contradicts_edges,
  });
}

const SHAKEDOWN_STATEMENT =
  'PLUMBING SHAKEDOWN ON LOWER-BOUND DETERMINISTIC DATA. This census ran the deterministic, MODEL-FREE ' +
  'documentation-claim parser (produceDocumentationClaims) end-to-end through the documentary-claim ledger, ' +
  'the proposition index, the ten-relation classifier, and the DisagreementCase store. Its purpose is to ' +
  'prove the PLUMBING runs end-to-end. It does NOT exercise the divergence machinery: the deterministic ' +
  'parser stamps CONSTANT polarity/scope/valid_time and a single predicate_family, so the divergence ' +
  'relations (scope_divergence, temporal_divergence, modality_divergence, conformance_gap_candidate) are ' +
  'structurally near zero and the buckets are degenerate. Exercising the divergence machinery requires ' +
  'neural extraction, which remains disabled this slice (ModelInvocationDisabledError intact). Treat every ' +
  'count below as a LOWER BOUND; re-run once neural extraction lands before drawing any substantive ' +
  'conclusion about disagreement volume.';

const EXPOSURE_BOOKKEEPING =
  'EXPOSURE BOOKKEEPING. Running this documentation-claim census over this repository EXPOSES it as an ' +
  'experiment subject. This repository must NOT serve as a held-out evaluation unit in the future ' +
  'decision-grade multi-repo experiment (DESIGN §16.12.3 arms); it is now a plumbing-shakedown subject and ' +
  'is disqualified from the held-out set.';

/** Build the census report object from the deterministic pipeline outputs. Pure. */
export function buildCensusReport({ snapshot, index, classification, disagreement, ledgerConservation, meta = {} }) {
  const choose2 = n => (n * (n - 1)) / 2;
  const reductionFactor = index.candidatePairCount > 0
    ? Number((index.naivePairCount / index.candidatePairCount).toFixed(2)) : null;
  const largestSize = index.bucketSizes.length ? Math.max(...index.bucketSizes) : 0;
  return {
    schema: CENSUS_SCHEMA,
    generated_by:
      'deterministic MODEL-FREE documentation-claim census (produceDocumentationClaims -> claim ledger -> ' +
      'proposition index -> ten-relation classifier -> DisagreementCase store); NO provider/model call',
    neural_extraction: 'DISABLED (ModelInvocationDisabledError intact); no provider/model call, no resolution/verification engine, no probes, no neural extraction in this pipeline',
    snapshot,
    claim_count: index.claimCount,
    proposition_count: index.propositions.length,
    bucket_count: index.bucketCount,
    bucket_size_distribution: distribution(index.bucketSizes),
    largest_bucket_size: largestSize,
    largest_bucket_candidate_pairs: choose2(largestSize),
    candidate_pairs_compared: classification.comparedPairs,
    candidate_pairs_from_index: index.candidatePairCount,
    naive_n_choose_2_baseline: index.naivePairCount,
    pair_reduction_factor: reductionFactor,
    relation_histogram: classification.histogram,
    disagreement_cases_total: disagreement.cases_total,
    disagreement_cases_by_relation: disagreement.cases_by_relation,
    ledger: ledgerConservation,
    relations: COMPARISON_RELATIONS,
    shakedown_statement: SHAKEDOWN_STATEMENT,
    exposure_bookkeeping: EXPOSURE_BOOKKEEPING,
    ...meta,
  };
}

/**
 * The pure, I/O-free core of the census. Wires ledger -> index -> classifier -> DisagreementCase
 * store over already-produced claim records and returns the report plus the live stores/index for
 * tests. Deterministic: identical claims => byte-identical report.
 */
export function censusFromClaims(claims, { snapshot }) {
  if (!snapshot || !snapshot.source_sha || !snapshot.corpus_digest) {
    throw new Error('censusFromClaims requires a snapshot { source_sha, corpus_digest }');
  }
  const ledger = createDocumentaryClaimLedger({ snapshot });
  ledger.appendAll(claims);
  const ledgerConservation = ledger.assertConservation();
  const index = buildPropositionIndex(claims, { snapshot });
  const classification = classifyIndex(index);
  const disagreement = assembleDisagreementCases(claims, index, { snapshot });
  const report = buildCensusReport({ snapshot, index, classification, disagreement, ledgerConservation });
  return { report, ledger, index, classification, disagreement };
}

/**
 * Read the full-text content of every processed `docs` corpus entry into the raw_corpus shape the
 * sealed producer boundary requires. Reads only; never writes.
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
 * The end-to-end entrypoint over a real estate corpus. Runs the whole deterministic, model-free
 * chain and writes the census report to an EXPLICIT outFile OUTSIDE the scanned estate (read-only
 * guard enforced). Returns the report. No provider/model path.
 */
export async function runDocumentationClaimCensus({ root, outFile }) {
  const peak = { rss: process.memoryUsage().rss };
  const sample = () => { const rss = process.memoryUsage().rss; if (rss > peak.rss) peak.rss = rss; };
  const estate = await fs.realpath(root);
  registerScanRoot(estate, { registeredBy: 'documentation-claim-census.mjs' });
  if (!outFile) throw new Error('runDocumentationClaimCensus requires an explicit outFile outside the scanned estate');
  const resolvedOut = assertWritable(path.resolve(outFile), { op: 'write census report', tool: 'documentation-claim-census.mjs' });

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
  const { report } = censusFromClaims(claims, { snapshot });
  sample();
  const walltimeMs = Number((now() - started).toFixed(3));

  const fullReport = {
    ...report,
    estate_root: estate,
    corpus_totals: corpus.totals,
    walltime_ms: walltimeMs,
    peak_rss_bytes: peak.rss,
    peak_rss_mb: Number((peak.rss / (1024 * 1024)).toFixed(1)),
    out_path: resolvedOut,
  };
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  await fs.writeFile(resolvedOut, stableStringify(fullReport));
  sample();
  fullReport.peak_rss_bytes = peak.rss;
  fullReport.peak_rss_mb = Number((peak.rss / (1024 * 1024)).toFixed(1));
  return fullReport;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const root = positional[0] || process.cwd();
  const out = options.out;
  if (!out) {
    console.error('usage: node documentation-claim-census.mjs [estate-root] --out <report.json>');
    console.error('  --out is REQUIRED and must resolve OUTSIDE the scanned estate (read-only guard enforced).');
    process.exit(2);
  }
  const report = await runDocumentationClaimCensus({ root, outFile: out });
  console.log(stableStringify({
    out_path: report.out_path,
    claim_count: report.claim_count,
    proposition_count: report.proposition_count,
    bucket_count: report.bucket_count,
    candidate_pairs_compared: report.candidate_pairs_compared,
    naive_n_choose_2_baseline: report.naive_n_choose_2_baseline,
    pair_reduction_factor: report.pair_reduction_factor,
    relation_histogram: report.relation_histogram,
    disagreement_cases_total: report.disagreement_cases_total,
    disagreement_cases_by_relation: report.disagreement_cases_by_relation,
    walltime_ms: report.walltime_ms,
    peak_rss_mb: report.peak_rss_mb,
    shakedown_statement: report.shakedown_statement,
    exposure_bookkeeping: report.exposure_bookkeeping,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error); process.exit(1); });
}
