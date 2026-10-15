// [COMMON-SCORER]: tools/eval/case-scorer.mjs's scoreCase() exercised directly against hand-built
// record/receipt inputs — fast, hermetic, no Git/extraction needed. tests/delta-shape-eval.test.mjs
// and tests/delta-chain-eval.test.mjs additionally exercise this SAME function through the real
// production extraction path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admissibleRecordsFromReceipts, recordDiff, scoreCase,
} from '../tools/eval/case-scorer.mjs';

const record = (observationId, recordDigest) => ({ observation_id: observationId, record_digest: recordDigest });

test('[COMMON-SCORER] an attempt with no objectives supplied passes trivially, and every objective reports inapplicable rather than a fabricated pass', () => {
  const score = scoreCase({ label: 'empty' });
  assert.equal(score.verdict, 'pass');
  assert.deepEqual(score.reasons, []);
  for (const objective of Object.values(score.objectives)) assert.equal(objective.applicable, false);
});

test('[COMMON-SCORER] equal records with no reuse claim pass correctness; reuse stays inapplicable', () => {
  const reference = [record('obs-1', 'digest-1'), record('obs-2', 'digest-2')];
  const candidate = [record('obs-1', 'digest-1'), record('obs-2', 'digest-2')];
  const score = scoreCase({ referenceRecords: reference, candidateRecords: candidate });
  assert.equal(score.verdict, 'pass');
  assert.equal(score.objectives.correctness.applicable, true);
  assert.equal(score.objectives.correctness.pass, true);
  assert.equal(score.objectives.reuse.applicable, false);
});

test('[COMMON-SCORER] missing eligible reuse fails the reuse objective EVEN THOUGH outputs match exactly (a silent full rebuild is not free to pass)', () => {
  const reference = [record('obs-1', 'digest-1')];
  const candidate = [record('obs-1', 'digest-1')]; // byte-identical output — a correct, but silently-rebuilt-from-scratch, candidate.
  const score = scoreCase({
    referenceRecords: reference, candidateRecords: candidate,
    expectedReusableUnitIds: ['unit:eligible-1'], actualReusedUnitIds: [], // nothing was actually reused, though something was eligible.
  });
  assert.equal(score.objectives.correctness.pass, true, 'output content is genuinely correct');
  assert.equal(score.objectives.reuse.pass, false, 'the reuse objective must fail regardless of correct output');
  assert.deepEqual(score.objectives.reuse.reuse_expected_not_actual, ['unit:eligible-1']);
  assert.equal(score.verdict, 'fail', 'overall verdict must be fail even though records matched');
});

test('[COMMON-SCORER] a stale reuse-all candidate (same observation_id, different record_digest) fails correctness', () => {
  const reference = [record('obs-1', 'current-digest')];
  const candidate = [record('obs-1', 'stale-old-digest')]; // blind reuse-all served the OLD digest.
  const score = scoreCase({ referenceRecords: reference, candidateRecords: candidate });
  assert.equal(score.objectives.correctness.pass, false);
  assert.deepEqual(score.objectives.correctness.stale, ['obs-1']);
  assert.equal(score.verdict, 'fail');
  assert.ok(score.reasons.some(reason => reason.includes('correctness objective failed')));
});

test('[COMMON-SCORER] a deleted record\u2019s stale output surviving as EXTRA fails correctness', () => {
  const reference = [record('obs-1', 'digest-1')]; // the honest reference no longer has the deleted record.
  const candidate = [record('obs-1', 'digest-1'), record('obs-deleted', 'digest-stale')];
  const score = scoreCase({ referenceRecords: reference, candidateRecords: candidate });
  assert.equal(score.objectives.correctness.pass, false);
  assert.deepEqual(score.objectives.correctness.extra, ['obs-deleted']);
  assert.equal(score.verdict, 'fail');
});

test('[COMMON-SCORER] actual scan-invocation evidence diverging from independently derived expected work fails the invocation objective', () => {
  const score = scoreCase({ scanInvocations: { actual: 4, expected: 1 } });
  assert.equal(score.objectives.invocation_evidence.pass, false);
  assert.equal(score.objectives.invocation_evidence.direction, 'over');
  assert.equal(score.verdict, 'fail');
});

test('[COMMON-SCORER] input completeness false fails that objective independently of correctness/reuse', () => {
  const score = scoreCase({ inputComplete: false });
  assert.equal(score.objectives.input_completeness.pass, false);
  assert.equal(score.verdict, 'fail');
});

test('[COMMON-SCORER] admissibleRecordsFromReceipts excludes refused receipts and flattens every produced/reused record', () => {
  const receipts = [
    { disposition: { kind: 'produced' }, output: { records: [record('obs-1', 'd1')] } },
    { disposition: { kind: 'refused' }, output: { records: [record('obs-x', 'dx')] } },
    { disposition: { kind: 'reused_exact' }, output: { records: [record('obs-2', 'd2')] } },
  ];
  const rows = admissibleRecordsFromReceipts(receipts);
  assert.deepEqual(rows.map(row => row.observation_id).sort(), ['obs-1', 'obs-2']);
});

test('[COMMON-SCORER] recordDiff distinguishes missing/extra/stale at the observation_id/record_digest grain', () => {
  const reference = [record('obs-missing', 'd1'), record('obs-stale', 'd-old')];
  const candidate = [record('obs-stale', 'd-new'), record('obs-extra', 'd2')];
  const diff = recordDiff(reference, candidate);
  assert.deepEqual(diff.missing, ['obs-missing']);
  assert.deepEqual(diff.extra, ['obs-extra']);
  assert.deepEqual(diff.stale, ['obs-stale']);
});
