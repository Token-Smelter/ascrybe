import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256, stableStringify } from '../tools/lib.mjs';
import {
  buildTrancheBlindReview, operationalTrancheGrade, scoreTrancheBlindReview,
  sealTrancheGold, verifyTrancheGold, verifyTranchePopulation,
} from '../tools/tranche-evaluation.mjs';

const canonical = value => stableStringify(value).trim();
function population() {
  const body = {
    schema: 'estate-map/document-extraction-tranche/v1',
    status: 'frozen_before_inference_pending_source_gold',
    snapshot: { source_sha: 'sha', corpus_digest: 'digest' },
    selection: { documents: 1, windows: 2 },
    documents: [{ file: 'a.md', representative_window_id: 'w1', window_ids: ['w1', 'w2'] }],
    window_ids: ['w1', 'w2'],
    source_frames: [{ window_id: 'w1', file: 'a.md', blocks: [{ address: 'a.md@0', text: 'The router deterministically rejects stale results.' }] }],
    disclosure_scan: { pass: true, findings: [] },
  };
  return { ...body, digest: sha256(canonical(body)) };
}
const draft = {
  reviewer: 'blind', frozen_source_only: true, matching_policy: 'exact',
  decision_rule: { strict_recall_floor: 0.4 },
  opportunities: [{ id: 'o1', window_id: 'w1', file: 'a.md', block_address: 'a.md@0',
    subject_surface: 'router', source_quote: 'The router deterministically rejects stale results.',
    proposition: 'The router rejects stale results.' }],
};

test('tranche population and source-first gold are digest-bound with complete representative coverage', () => {
  const held = population();
  assert.equal(verifyTranchePopulation(held), true);
  const gold = sealTrancheGold({ population: held, draft });
  assert.equal(gold.status, 'frozen_before_inference');
  assert.equal(verifyTrancheGold({ population: held, gold }), true);
  assert.throws(() => verifyTrancheGold({ population: held, gold: { ...gold, reviewer: 'changed' } }),
    error => error.code === 'TRANCHE_GOLD_DIGEST_MISMATCH');
});

test('tranche gold refuses non-exact quotes and incomplete source-frame coverage', () => {
  const held = population();
  assert.throws(() => sealTrancheGold({ population: held, draft: { ...draft, opportunities: [] } }),
    error => error.code === 'TRANCHE_GOLD_COVERAGE_INCOMPLETE');
  const bad = { ...draft.opportunities[0], source_quote: 'The router approximately rejects stale results.' };
  assert.throws(() => sealTrancheGold({ population: held, draft: { ...draft, opportunities: [bad] } }),
    error => error.code === 'TRANCHE_GOLD_QUOTE_NOT_EXACT');
});

function artifact(override = {}) {
  const claim = {
    id: 'claim:1', extraction: { unit_id: 'w2' },
    extraction_provenance: [{ unit_id: 'w2' }, { unit_id: 'w1' }], semantic: {
      provenance: { unit_id: 'w2' },
      subject: { surface: 'router', literal_surface: 'router', identity_surface: 'router',
        binding: { kind: 'explicit' }, source_locator: { text: 'The router deterministically rejects stale results.', block: { address: 'a.md@0' } } },
      relation_family: 'constraint', predicate_family: 'rejects', object_or_value: 'stale results',
      polarity: 'affirmed', modality: 'descriptive', quantifier: 'all', scope: {}, valid_time: {},
      support_sets: [{ locators: [{ role: 'primary', block: { address: 'a.md@0' }, file: 'a.md', start: 1, end: 1,
        text: 'The router deterministically rejects stale results.' }] }],
    },
  };
  return { digest: 'artifact:digest', status: 'complete', extractor: 'wide-context-extractor@10',
    extraction_contract: 'v10', snapshot: { source_sha: 'sha', corpus_digest: 'digest' },
    queue: { by_state: { done: 2 }, stopped: null }, budget: { unpriced_attempts: 0 },
    metrics: { selected_windows: 2, truncated_units: 0 }, claims: [claim], ...override };
}

test('single-treatment blind review is custody-bound and scores preregistered floors', () => {
  const held = population(), gold = sealTrancheGold({ population: held, draft });
  const result = artifact();
  const review = buildTrancheBlindReview({ population: held, gold, artifact: result, seed: 'fixed', sample_size: 1 });
  assert.equal(review.packet.schema, 'estate-map/document-tranche-blind-review/v2');
  assert.equal(review.packet.opportunity_frame.length, 1);
  assert.equal(review.packet.opportunity_frame[0].candidate_claims.length, 1);
  assert.deepEqual(review.packet.opportunity_frame[0].candidate_claims[0].window_ids, ['w1', 'w2']);
  assert.equal(review.packet.opportunity_frame[0].frames.sealed_block.candidate_claims.length, 1);
  assert.equal(review.packet.opportunity_frame[0].frames.document_scope.candidate_claims.length, 1);
  assert.equal(review.packet.precision_frame.length, 1);
  const reviewId = review.packet.precision_frame[0].claim.review_claim_id;
  const grades = { blinded: true, reviewer: 'blind', opportunity_grades: [
    { opportunity_id: 'o1', frame: 'sealed_block', grade: 'recovered' },
    { opportunity_id: 'o1', frame: 'document_scope', grade: 'recovered' },
  ], precision_grades: [
    { review_claim_id: reviewId, entailed: true, subject_binding_correct: true, severe_error: false },
  ] };
  const scored = scoreTrancheBlindReview({ population: held, gold, artifact: result,
    packet: review.packet, key: review.key, grades, rejection_audit: { pass: true } });
  assert.equal(scored.pass, true);
  assert.equal(scored.metrics.strict_recall, 1);
  assert.equal(scored.metrics.primary_recall_frame, 'document_scope');
  assert.equal(scored.metrics.recall_frames.sealed_block.strict_recall, 1);
  assert.equal(scored.metrics.precision, 1);
  assert.equal(scored.metrics.subject_binding_accuracy, 1);
  assert.throws(() => scoreTrancheBlindReview({ population: held, gold,
    artifact: { ...result, digest: 'changed' }, packet: review.packet, key: review.key, grades,
    rejection_audit: { pass: true } }), error => error.code === 'TRANCHE_REVIEW_CUSTODY_MISMATCH');
});

test('document-scope frame includes a same-document claim omitted by the sealed-block frame', () => {
  const held = population(), gold = sealTrancheGold({ population: held, draft });
  const result = artifact();
  const displaced = structuredClone(result.claims[0]);
  displaced.id = 'claim:document-restatement';
  displaced.extraction = { unit_id: 'w2' };
  displaced.extraction_provenance = [{ unit_id: 'w2' }];
  displaced.semantic.provenance = { unit_id: 'w2' };
  displaced.semantic.support_sets[0].locators[0].block.address = 'a.md@9';
  displaced.semantic.subject.source_locator.block.address = 'a.md@9';
  result.claims = [displaced];
  const review = buildTrancheBlindReview({ population: held, gold, artifact: result, seed: 'document-frame', sample_size: 1 });
  const frame = review.packet.opportunity_frame[0];
  assert.equal(frame.frames.sealed_block.candidate_claims.length, 0);
  assert.equal(frame.frames.document_scope.candidate_claims.length, 1);
});

test('operational tranche grade fails closed on quarantined provider units', () => {
  const held = population();
  const failed = artifact({ status: 'incomplete', queue: { by_state: { done: 1, quarantined: 1 }, stopped: null } });
  const grade = operationalTrancheGrade({ population: held, artifact: failed });
  assert.equal(grade.pass, false);
  assert.equal(grade.checks.no_quarantine, false);
  assert.equal(grade.checks.every_window_completed, false);
});

test('operational tranche grade binds a requested extraction contract to its exact extractor', () => {
  const held = population();
  const v15 = artifact({
    extractor: 'wide-context-extractor@15-precise-role-ownership', extraction_contract: 'v15',
  });
  assert.equal(operationalTrancheGrade({ population: held, artifact: v15, expected_contract: 'v15' }).pass, true);
  assert.equal(operationalTrancheGrade({ population: held, artifact: v15, expected_contract: 'v14' }).checks.exact_extractor, false);
  const v16 = artifact({
    extractor: 'wide-context-extractor@16-exact-unique-grounding', extraction_contract: 'v16',
  });
  assert.equal(operationalTrancheGrade({ population: held, artifact: v16, expected_contract: 'v16' }).pass, true);
});

test('operational tranche grade enforces a required controller load audit', () => {
  const held = population(), result = artifact();
  const good = { exit: { code: 0 }, load_audit: { circuit_events: [] } };
  assert.equal(operationalTrancheGrade({
    population: held, artifact: result, controller: good, require_load_audit: true,
  }).pass, true);
  const circuit = { exit: { code: 0 }, load_audit: { circuit_events: [{ overload_streak: 2 }] } };
  const failed = operationalTrancheGrade({
    population: held, artifact: result, controller: circuit, require_load_audit: true,
  });
  assert.equal(failed.pass, false);
  assert.equal(failed.checks.no_sustained_host_load_circuit, false);
});
