import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolutionRecord, validateAdjudicationAnswer, RESOLUTION_SCHEMA } from '../tools/neural-resolution.mjs';

const snapshot = { source_sha: 'source-sha', corpus_digest: 'corpus-digest' };
const sides = [
  { claim_id: 'claim-a', document_id: 'a.md', excerpts: [{ file: 'a.md', start: 1, end: 1, text: 'A binds port 1.' }] },
  { claim_id: 'claim-b', document_id: 'b.md', excerpts: [{ file: 'b.md', start: 1, end: 1, text: 'A binds port 2.' }] },
];
const answer = {
  resolution: 'inconsistent',
  rationale: 'The sources assert "port 1" and "port 2" for the same subject.',
  pair_conflict: 'conflict',
  side_grounding: [
    { claim_id: 'claim-a', state: 'supported', rationale: 'The source says "port 1".', quoted_spans: ['port 1'] },
    { claim_id: 'claim-b', state: 'supported', rationale: 'The source says "port 2".', quoted_spans: ['port 2'] },
  ],
  context_relation: { scope: 'same', time: 'same', modality: 'same', referent: 'same' },
  context_note: 'Same scope and referent.',
  quoted_spans: ['port 1', 'port 2'],
};

test('v2 answer keeps pair conflict, grounding, and context independent', () => {
  const validated = validateAdjudicationAnswer(answer, sides);
  assert.equal(validated.ok, true);
  const record = createResolutionRecord({ case_id: 'case-1', comparison_relation: 'direct_conflict', ...validated.value, sides, model_identifier: 'mock' }, { snapshot });
  assert.equal(record.schema, RESOLUTION_SCHEMA);
  assert.equal(record.semantic.pair_conflict, 'conflict');
  assert.equal(record.semantic.side_grounding.length, 2);
  assert.deepEqual(record.semantic.context_relation, answer.context_relation);
  assert.equal(Object.hasOwn(record.semantic, 'real_issue'), false);
});

test('v2 answer refuses missing or fabricated epistemic fields', () => {
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, pair_conflict: undefined }, sides), { ok: false, reason: 'invalid_pair_conflict' });
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, side_grounding: answer.side_grounding.slice(0, 1) }, sides), { ok: false, reason: 'incomplete_side_grounding' });
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, context_relation: { ...answer.context_relation, time: 'probably' } }, sides), { ok: false, reason: 'invalid_context_relation' });
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, side_grounding: [...answer.side_grounding, { ...answer.side_grounding[0] }] }, sides), { ok: false, reason: 'invalid_side_grounding_claims' });
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, quoted_spans: ['not in either source'] }, sides), { ok: false, reason: 'missing_or_inexact_quoted_spans' });
  assert.deepEqual(validateAdjudicationAnswer({ ...answer, side_grounding: [{ ...answer.side_grounding[0], quoted_spans: ['not in a source'] }, answer.side_grounding[1]] }, sides), { ok: false, reason: 'missing_or_inexact_side_grounding_quotes' });
});
