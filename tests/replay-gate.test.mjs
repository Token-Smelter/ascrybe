import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeControlPromotion, gradeReplay, summarizeGatePopulation } from '../tools/replay-gate.mjs';

test('replay grading ignores additional control windows when checking replay coverage', () => {
  const result = {
    status: 'complete',
    queue: { by_state: { done: 2 } },
    budget: { unpriced_attempts: 0 },
    metrics: {
      claims_by_unit: { 'window:replay': 3, 'window:control': 4 },
      proposals_by_unit: { 'window:replay': 3, 'window:control': 8 },
      rejections_by_unit: { 'window:replay': 0, 'window:control': 4 },
      locator_metrics_by_unit: {
        'window:replay': { proposed_locators: 6, resolved_locators: 6 },
        'window:control': { proposed_locators: 16, resolved_locators: 8 },
      },
      truncated_by_unit: { 'window:replay': false, 'window:control': false },
      locator_resolution_rate: 1,
      truncated_units: 0,
    },
  };
  const grade = gradeReplay({ result, replayed: ['window:replay'] });
  assert.equal(grade.checks.every_window_returned_claims, true);
  assert.deepEqual(grade.claims_by_unit, { 'window:replay': 3 });
  assert.equal(grade.replayed_windows, 1);
  assert.equal(grade.pass, true);
});

test('control grading is machine-readable and population-scoped', () => {
  const result = {
    status: 'complete', queue: { by_state: { done: 2 } }, budget: { unpriced_attempts: 0 },
    metrics: {
      claims_by_unit: { a: 9, b: 8, replay: 1 },
      proposals_by_unit: { a: 10, b: 10, replay: 100 },
      rejections_by_unit: { a: 1, b: 2, replay: 99 },
      locator_metrics_by_unit: {
        a: { proposed_locators: 20, resolved_locators: 19 },
        b: { proposed_locators: 20, resolved_locators: 18 },
      },
      truncated_by_unit: { a: false, b: false },
    },
  };
  const population = summarizeGatePopulation({ result, window_ids: ['a', 'b'] });
  assert.equal(population.pooled_promotion_rate, 0.85);
  assert.equal(population.macro_window_promotion_rate, 0.85);
  const grade = gradeControlPromotion({ result, control: ['a', 'b'] });
  assert.equal(grade.decision, 'authorize_25_documents_only');
  assert.equal(grade.metric_role, 'address_contract_conformance_not_semantic_quality');
});
