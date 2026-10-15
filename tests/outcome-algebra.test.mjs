import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOutputCap,
  assertPreflight,
  createBoundRegistry,
  declareBound,
  maxRegionsForTree,
  preflightBounds,
  UNIT_OUTCOMES,
} from '../tools/outcome-algebra.mjs';

const scopeBound = {
  id: 'max_regions_per_document', kind: 'scope', measures: 'regions visited per document',
  checked: 'pre_dispatch', action: 'clamp', salvage_granularity: 'region',
  completeness: 'unresolved_due_to_bound', replay_may_dispatch: false,
};

test('a bound must declare its full behaviour', () => {
  assert.ok(declareBound(scopeBound).digest);
  for (const missing of ['measures', 'checked', 'action', 'salvage_granularity', 'completeness', 'replay_may_dispatch']) {
    const spec = { ...scopeBound };
    delete spec[missing];
    assert.throws(() => declareBound(spec), error => error.name === 'OutcomeAlgebraError', `missing ${missing} must be rejected`);
  }
});

test('a scope bound may never declare abort; spend and custody bounds may', () => {
  assert.throws(
    () => declareBound({ ...scopeBound, action: 'abort' }),
    error => error.code === 'SCOPE_BOUND_MAY_NOT_ABORT',
  );
  const spend = declareBound({
    id: 'max_known_cost_usd', kind: 'spend', measures: 'reported provider cost',
    checked: 'post_return', action: 'abort', salvage_granularity: 'run',
    completeness: 'fleet_stop', replay_may_dispatch: false,
  });
  assert.equal(spend.action, 'abort');
});

test('maxRegionsForTree computes the authorized tree size', () => {
  assert.equal(maxRegionsForTree({ max_depth: 2, max_children_per_region: 6 }), 43); // 1 + 6 + 36
  assert.equal(maxRegionsForTree({ max_depth: 0, max_children_per_region: 6 }), 1);
  assert.equal(maxRegionsForTree({ max_depth: 1, max_children_per_region: 2 }), 3);
});

test('preflight rejects the exact contradiction that aborted the paid pilot', () => {
  // depth 2 x 6 children authorizes 43 regions, but the pilot capped regions at 24 and planning at 8.
  const result = preflightBounds({
    max_depth: 2, max_children_per_region: 6,
    max_regions_per_document: 24, max_planning_calls_per_document: 8,
  });
  assert.equal(result.ok, false);
  const codes = result.violations.map(v => v.code);
  assert.ok(codes.includes('REGION_CAP_BELOW_AUTHORIZED_TREE'));
  assert.ok(codes.includes('PLANNING_CAP_BELOW_REGION_CAP'));
});

test('preflight catches prompt, answer, timeout and budget incoherence', () => {
  const result = preflightBounds({
    atomic_primary_bytes: 131072, max_prompt_bytes: 131072,
    max_answer_bytes: 8 * 1024 * 1024, max_event_bytes: 4 * 1024 * 1024,
    call_timeout_ms: 180000, observed_latency_ms_p95: 155000,
    max_calls: 5, max_regions_per_document: 43,
  });
  const codes = result.violations.map(v => v.code);
  assert.ok(codes.includes('ATOMIC_EXCEEDS_PROMPT_CEILING'));
  assert.ok(codes.includes('ANSWER_CEILING_ABOVE_TRANSPORT'));
  assert.ok(codes.includes('TIMEOUT_MARGIN_TOO_THIN'), 'a 180s timeout against 155s observed p95 must be rejected');
  assert.ok(codes.includes('CALL_BUDGET_BELOW_REGION_CAP'));
});

test('a coherent bound set passes and assertPreflight is fail-closed', () => {
  const coherent = {
    max_depth: 2, max_children_per_region: 6,
    max_regions_per_document: 43, max_planning_calls_per_document: 43,
    atomic_primary_bytes: 49152, max_prompt_bytes: 131072,
    max_answer_bytes: 1048576, max_event_bytes: 67108864,
    call_timeout_ms: 600000, observed_latency_ms_p95: 155000,
    max_calls: 180,
  };
  assert.equal(preflightBounds(coherent).ok, true);
  assert.equal(assertPreflight(coherent).ok, true);
  assert.throws(
    () => assertPreflight({ max_depth: 2, max_children_per_region: 6, max_regions_per_document: 24 }),
    error => error.code === 'BOUND_PREFLIGHT_FAILED',
  );
});

test('output cap retains every purchased item and never truncates to first N', () => {
  const items = Array.from({ length: 65 }, (_, i) => ({ i }));
  const capped = applyOutputCap({ items, max_items: 64 });
  assert.equal(capped.outcome, 'overflow');
  assert.equal(capped.retained.length, 65, 'all 65 purchased items survive');
  assert.deepEqual(capped.retained, items);
  assert.equal(capped.overflow.returned, 65);
  assert.equal(capped.overflow.selection_bias_avoided, true);
  const under = applyOutputCap({ items: items.slice(0, 10), max_items: 64 });
  assert.equal(under.outcome, 'ok');
  assert.equal(under.overflow, null);
});

test('registry rejects duplicates and exposes a stable digest', () => {
  const a = createBoundRegistry([scopeBound]);
  const b = createBoundRegistry([{ ...scopeBound }]);
  assert.equal(a.digest, b.digest);
  assert.throws(() => createBoundRegistry([scopeBound, scopeBound]), error => error.code === 'DUPLICATE_BOUND');
  assert.ok(UNIT_OUTCOMES.includes('unresolved_due_to_bound'));
});
