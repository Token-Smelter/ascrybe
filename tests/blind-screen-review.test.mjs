import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptBlindReviewJsonlAtProviderBoundary, buildBlindScreenReviewPackets, validateBlindScreenReviewAnswer } from '../tools/blind-screen-review.mjs';

const claim = (id, block = 'doc.md@1') => ({
  review_claim_id: id,
  window_ids: ['w1'], evidence_files: ['doc.md'], evidence_blocks: [block],
  subject: { surface: 'Router' }, predicate_family: 'routes', object_or_value: 'task',
  evidence: [{ file: 'doc.md', block_address: block, text: 'Router routes task.' }],
});

const packet = {
  blinded: true,
  status: 'awaiting_review',
  opportunity_frame: [{
    opportunity: { id: 'o1', source_quote: 'Router routes task.', proposition: 'Router routes task.' },
    arms: {
      A: { frames: { sealed_block: { candidate_claims: [claim('a1')] }, document_scope: { candidate_claims: [claim('a1'), claim('a2', 'doc.md@2')] } } },
      B: { frames: { sealed_block: { candidate_claims: [] }, document_scope: { candidate_claims: [claim('b1', 'doc.md@2')] } } },
    },
  }],
  precision_frame: [
    { blind_arm: 'A', claim: claim('a1') },
    { blind_arm: 'B', claim: claim('b1') },
  ],
};

test('blind review JSONL is accepted at the provider boundary for stage validation', () => {
  assert.deepEqual(acceptBlindReviewJsonlAtProviderBoundary('{"k":"head"}\n{"k":"end"}'), { wire: 'v28-blind-screen-review-jsonl@9' });
  assert.equal(acceptBlindReviewJsonlAtProviderBoundary(''), null);
});

test('blind screen packet keeps opportunity and precision work bounded', () => {
  const plan = buildBlindScreenReviewPackets({ packet, precision_packet_size: 20 });
  assert.equal(plan.units.length, 2);
  assert.equal(plan.units[0].kind, 'opportunity');
  assert.equal(plan.units[0].payload.arms.A.document_scope_claims[0].in_sealed_block_frame, true);
  assert.equal(plan.units[0].payload.arms.A.document_scope_claims[1].in_sealed_block_frame, false);
  assert.equal(plan.units[0].payload.arms.A.document_scope_claims.length, 2);
  assert.equal('evidence' in plan.units[0].payload.arms.A.document_scope_claims[0], false);
  assert.equal(plan.units[0].payload.arms.A.document_scope_claims[0].claim_ref, 'A0001');
  assert.equal(plan.units[0].payload.arms.B.document_scope_claims[0].claim_ref, 'B0001');
  assert.equal('review_claim_id' in plan.units[0].payload.arms.A.document_scope_claims[0], false);
  assert.match(plan.units[0].prompt, /Claim refs are short, tool-owned, and ARM-LOCAL/);
  assert.match(plan.units[1].prompt, /echo the exact arm from that grade's own input row/);
  assert.deepEqual(plan.units[1].rows.map(row => row.review_ref), ['P001', 'P002']);
  assert.doesNotMatch(plan.units[1].prompt, /"review_claim_id"|"a1"|"b1"/);
  assert.match(plan.units[1].prompt, /"arm":"A","id":"P001"/);
});

test('blind opportunity validation requires both frames for both anonymous arms', () => {
  const unit = buildBlindScreenReviewPackets({ packet }).units[0];
  const lines = [
    { k: 'head', outcome: 'graded' },
    { k: 'grade', arm: 'A', frame: 'sealed_block', grade: 'recovered', claim_refs: ['A0001'] },
    { k: 'grade', arm: 'A', frame: 'document_scope', grade: 'recovered', claim_refs: ['A0002'] },
    { k: 'grade', arm: 'B', frame: 'sealed_block', grade: 'missed', claim_refs: [] },
    { k: 'grade', arm: 'B', frame: 'document_scope', grade: 'partial', claim_refs: ['B0001'] },
    { k: 'end', count: 4 },
  ].map(JSON.stringify).join('\n');
  const validated = validateBlindScreenReviewAnswer({ response: { text: lines }, unit });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.value.grades.map(row => row.claim_ids), [['a1'], ['a2'], [], ['b1']]);
  assert.equal(validated.value.grades.some(row => 'claim_refs' in row), false);
  assert.equal(validateBlindScreenReviewAnswer({ response: { text: lines.split('\n').slice(1).join('\n') }, unit }).ok, true);
  const duplicate = lines.replace('"frame":"document_scope"', '"frame":"sealed_block"');
  const failed = validateBlindScreenReviewAnswer({ response: { text: duplicate }, unit });
  assert.equal(failed.ok, false);
  assert.equal(failed.terminal_incomplete, true);

  const crossArm = lines.replace('"claim_refs":["A0002"]', '"claim_refs":["B0001"]');
  assert.equal(validateBlindScreenReviewAnswer({ response: { text: crossArm }, unit }).ok, false);
  const unsealed = lines.replace('"claim_refs":["A0001"]', '"claim_refs":["A0002"]');
  assert.equal(validateBlindScreenReviewAnswer({ response: { text: unsealed }, unit }).ok, false);
});

test('blind precision validation rejects missing or mismatched arm grades', () => {
  const unit = buildBlindScreenReviewPackets({ packet }).units[1];
  const lines = [
    { k: 'head', outcome: 'graded' },
    { k: 'grade', arm: 'A', id: 'P001', entailed: true, subject_binding_correct: true, severe_error: false },
    { k: 'grade', arm: 'B', id: 'P002', entailed: true, subject_binding_correct: true, severe_error: false },
    { k: 'end' },
  ].map(JSON.stringify).join('\n');
  const validated = validateBlindScreenReviewAnswer({ response: { text: lines }, unit });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.value.grades.map(row => row.id), ['a1', 'b1']);
  assert.equal(validateBlindScreenReviewAnswer({ response: { text: lines.replace('"arm":"B"', '"arm":"A"') }, unit }).ok, false);
  assert.equal(validateBlindScreenReviewAnswer({ response: { text: lines.split('\n').slice(0, -1).join('\n') }, unit }).ok, false);
});
