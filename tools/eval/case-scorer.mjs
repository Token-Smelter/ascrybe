// [COMMON-SCORER] The ONE case scorer: the single record/graph-equality, input-completeness,
// expected-vs-observed-reuse, and scan-invocation-evidence judge used by every ordinary isolated
// change-shape case (tools/eval/delta-shape-eval.mjs runChangeShapeCase), every stateful chain hop
// (tools/eval/delta-chain-eval.mjs runChainCase), and every control/negative case (reuse_none,
// reuse_all, reuse_all_stale, dropped_record, corruption) in both modules.
//
// A control's own `passed` field must be DERIVED from what THIS scorer actually returned for the
// objective that control exists to exercise -- never a private boolean a control computes for
// itself from local checks. Meta-control success ("this control behaved as required") means this
// scorer returned the EXPECTED failure reason for a deliberately-broken input, not that the broken
// artifact itself passed.
import { stableStringify } from '../lib.mjs';

const canonical = value => stableStringify(value).trim();

export const CASE_SCORER_SCHEMA = 'estate-map/delta-case-scorer-verdict/v1';

/** observation_id/record_digest set comparison -- the identity grain
 * docs/delta-updatable-estate-maps.md's identity vocabulary defines: two records that share an
 * observation_id but differ in record_digest are STALE, never merely "different". */
export function recordDiff(referenceRecords, candidateRecords) {
  const refByObs = new Map(referenceRecords.map(record => [record.observation_id, record]));
  const candByObs = new Map(candidateRecords.map(record => [record.observation_id, record]));
  const missing = [...refByObs.keys()].filter(id => !candByObs.has(id)).sort();
  const extra = [...candByObs.keys()].filter(id => !refByObs.has(id)).sort();
  const stale = [...refByObs.keys()].filter(id => candByObs.has(id) && refByObs.get(id).record_digest !== candByObs.get(id).record_digest).sort();
  return Object.freeze({ missing, extra, stale });
}

/** Every non-refused record across a receipt array -- the admissible fact set one extraction
 * attempt actually contributes. Shared by every caller that needs records from a receipt list
 * (an extractEstate() plan's receipts, a hand-assembled control receipt set, or a forged one). */
export function admissibleRecordsFromReceipts(receipts) {
  const rows = [];
  for (const receipt of receipts) {
    if (receipt.disposition.kind === 'refused') continue;
    for (const record of receipt.output.records) rows.push(record);
  }
  return rows;
}

function correctnessObjective({
  referenceRecords, candidateRecords, mergeOk, mergeDigestEqual,
}) {
  if (!referenceRecords && !candidateRecords && mergeOk === undefined && mergeDigestEqual === undefined) {
    return Object.freeze({ applicable: false, pass: true });
  }
  const diff = recordDiff(referenceRecords || [], candidateRecords || []);
  const recordsEqual = diff.missing.length === 0 && diff.extra.length === 0 && diff.stale.length === 0;
  const mergeApplicable = mergeOk !== undefined || mergeDigestEqual !== undefined;
  const mergePass = !mergeApplicable || (mergeOk !== false && mergeDigestEqual !== false);
  return Object.freeze({
    applicable: true,
    pass: recordsEqual && mergePass,
    missing: diff.missing,
    extra: diff.extra,
    stale: diff.stale,
    merge_ok: mergeOk ?? null,
    merge_digest_equal: mergeDigestEqual ?? null,
  });
}

/** A candidate must reuse EXACTLY the validated-eligible set: missing eligible reuse (a unit that
 * SHOULD have been served from cache but was recomputed instead) fails this objective even when
 * every record still matches the reference byte-for-byte -- a silent full rebuild is not free to
 * pass merely because its output happens to be correct. */
function reuseObjective({ expectedReusableUnitIds, actualReusedUnitIds }) {
  if (!expectedReusableUnitIds && !actualReusedUnitIds) return Object.freeze({ applicable: false, pass: true });
  const expected = expectedReusableUnitIds || [];
  const actual = actualReusedUnitIds || [];
  const missingReuse = expected.filter(id => !actual.includes(id));
  const unexpectedReuse = actual.filter(id => !expected.includes(id));
  return Object.freeze({
    applicable: true,
    pass: missingReuse.length === 0 && unexpectedReuse.length === 0,
    reuse_expected_not_actual: missingReuse,
    reuse_actual_not_expected: unexpectedReuse,
  });
}

/** Actual production extractor.scan() invocation evidence
 * (tools/file-extraction-adapter.mjs createScanInvocationRecorder) compared against independently
 * derived expected work -- never a count deduced from receipt dispositions alone. */
function invocationObjective({ scanInvocations }) {
  if (!scanInvocations) return Object.freeze({ applicable: false, pass: true });
  const { actual, expected } = scanInvocations;
  if (actual === undefined || expected === undefined) return Object.freeze({ applicable: false, pass: true });
  const direction = actual > expected ? 'over' : actual < expected ? 'under' : 'exact';
  return Object.freeze({
    applicable: true, pass: actual === expected, actual, expected, direction,
  });
}

function completenessObjective({ inputComplete }) {
  if (inputComplete === undefined) return Object.freeze({ applicable: false, pass: true });
  return Object.freeze({ applicable: true, pass: inputComplete === true });
}

/**
 * Score ONE case / chain-hop / control attempt. Every objective is OPTIONAL: omit a field (or
 * pass `undefined`) for an objective this attempt does not exercise, and it is marked
 * `applicable: false` rather than silently defaulting to a pass a caller could mistake for
 * evidence. `label` is a free-form identifier for the caller's own logging; the scorer does not
 * interpret it.
 */
export function scoreCase({
  label,
  referenceRecords, candidateRecords, mergeOk, mergeDigestEqual,
  expectedReusableUnitIds, actualReusedUnitIds,
  scanInvocations, inputComplete,
} = {}) {
  const objectives = Object.freeze({
    correctness: correctnessObjective({
      referenceRecords, candidateRecords, mergeOk, mergeDigestEqual,
    }),
    reuse: reuseObjective({ expectedReusableUnitIds, actualReusedUnitIds }),
    invocation_evidence: invocationObjective({ scanInvocations }),
    input_completeness: completenessObjective({ inputComplete }),
  });
  const reasons = [];
  if (!objectives.correctness.pass) {
    reasons.push('correctness objective failed: candidate diverges from the reference (missing/extra/stale records or a merge-digest mismatch)');
  }
  if (!objectives.reuse.pass) {
    reasons.push('reuse objective failed: an eligible reuse was not actually served, or a unit was reused without being a validated-eligible candidate');
  }
  if (!objectives.invocation_evidence.pass) {
    reasons.push(`invocation evidence failed: ${objectives.invocation_evidence.actual} actual scan invocation(s) against ${objectives.invocation_evidence.expected} expected (${objectives.invocation_evidence.direction}-invoked)`);
  }
  if (!objectives.input_completeness.pass) {
    reasons.push('input completeness objective failed: extraction input was not complete');
  }
  const verdict = reasons.length ? 'fail' : 'pass';
  return Object.freeze({
    schema: CASE_SCORER_SCHEMA,
    label: label ?? null,
    verdict,
    reasons: Object.freeze(reasons),
    objectives,
    // A stable digest of the scored inputs, so two independent runs of the same attempt can prove
    // they scored the SAME evidence, not merely reached the same verdict by coincidence.
    input_digest: canonical({
      expectedReusableUnitIds: expectedReusableUnitIds || null,
      actualReusedUnitIds: actualReusedUnitIds || null,
      scanInvocations: scanInvocations || null,
      inputComplete: inputComplete ?? null,
    }),
  });
}
