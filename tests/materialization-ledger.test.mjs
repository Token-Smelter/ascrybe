import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MaterializationLedgerError,
  assertAttemptCapacity,
  materializationAttemptIdentity,
  materializationIdentity,
  normalizeAttemptPolicy,
  retryDelayMs,
  retryEligibility,
} from '../tools/materialization-ledger.mjs';

const policy = normalizeAttemptPolicy({
  max_attempts: 3,
  retryable_outcomes: ['timeout:process_unavailable', 'error:provider', 'error:provider'],
  backoff_ms: 100,
  backoff_multiplier: 2,
  max_backoff_ms: 500,
  jitter_ratio: 0.2,
});

test('materialization identities are stable and dependency-sensitive', () => {
  const one = materializationIdentity({
    stage: 'extract', logical_key: 'window:1', prompt: 'same bytes',
    dependencies: { source_snapshot: 'abc', window_digest: 'def' },
  });
  const same = materializationIdentity({
    stage: 'extract', logical_key: 'window:1', prompt: 'same bytes',
    dependencies: { source_snapshot: 'abc', window_digest: 'def' },
  });
  const changed = materializationIdentity({
    stage: 'extract', logical_key: 'window:1', prompt: 'same bytes',
    dependencies: { source_snapshot: 'abc', window_digest: 'changed' },
  });
  assert.equal(one.materialization_id, same.materialization_id);
  assert.notEqual(one.materialization_id, changed.materialization_id);
  assert.notEqual(one.dependency_digest, changed.dependency_digest);
  assert.notEqual(materializationAttemptIdentity(one, 1).attempt_id, materializationAttemptIdentity(one, 2).attempt_id);
});

test('attempt policy is exact, normalized, and bounded', () => {
  assert.deepEqual(policy.retryable_outcomes, ['error:provider', 'timeout:process_unavailable']);
  assert.throws(
    () => normalizeAttemptPolicy({ max_attempts: 2, retryable_outcomes: [] }),
    error => error instanceof MaterializationLedgerError && error.code === 'EMPTY_RETRYABLE_OUTCOMES',
  );
  assert.throws(
    () => normalizeAttemptPolicy({ max_attempts: 9, retryable_outcomes: ['error:provider'] }),
    error => error.code === 'INVALID_MAX_ATTEMPTS',
  );
});

test('retry eligibility is fail-closed on outcome, acceptance, validity, and limit', () => {
  assert.deepEqual(
    retryEligibility({ result: { outcome: 'error:provider', accepted: true }, attempt: 1, policy }),
    { retry: true, reason: 'explicit_transient_outcome' },
  );
  assert.equal(retryEligibility({ result: { outcome: 'output_limit', accepted: true }, attempt: 1, policy }).retry, false);
  assert.deepEqual(
    retryEligibility({ result: { outcome: 'error:provider', accepted: null, billing_status: 'acceptance_unknown' }, attempt: 1, policy }),
    { retry: false, reason: 'acceptance_unknown' },
  );
  assert.deepEqual(
    retryEligibility({ result: { outcome: 'error:provider', accepted: true }, validation_ok: true, attempt: 1, policy }),
    { retry: false, reason: 'valid_completion' },
  );
  assert.deepEqual(
    retryEligibility({ result: { outcome: 'error:provider', accepted: true }, attempt: 3, policy }),
    { retry: false, reason: 'attempt_limit' },
  );
});

test('retry delay is deterministic and bounded', () => {
  const a = retryDelayMs({ policy, failed_attempt: 2, next_attempt_id: 'attempt:x' });
  const b = retryDelayMs({ policy, failed_attempt: 2, next_attempt_id: 'attempt:x' });
  assert.equal(a, b);
  assert.ok(a >= 160 && a <= 240);
  assert.ok(retryDelayMs({ policy, failed_attempt: 99, next_attempt_id: 'attempt:y' }) <= 500);
});

test('capacity reserves every authorized attempt before dispatch', () => {
  assert.deepEqual(
    assertAttemptCapacity({
      logical_units: 10, max_calls: 30, max_known_cost_usd: 3,
      cost_reserve_per_call_usd: 0.1, policy,
    }),
    { logical_units: 10, max_attempts_per_unit: 3, required_calls: 30, required_cost_usd: 3 },
  );
  assert.throws(
    () => assertAttemptCapacity({ logical_units: 10, max_calls: 29, max_known_cost_usd: 3, cost_reserve_per_call_usd: 0.1, policy }),
    error => error.code === 'RETRY_CALL_CAP_INSUFFICIENT',
  );
  assert.throws(
    () => assertAttemptCapacity({ logical_units: 10, max_calls: 30, max_known_cost_usd: 2.99, cost_reserve_per_call_usd: 0.1, policy }),
    error => error.code === 'RETRY_COST_CAP_INSUFFICIENT',
  );
  assert.throws(
    () => assertAttemptCapacity({ logical_units: 10, max_calls: 30, max_known_cost_usd: 3, cost_reserve_per_call_usd: 0, policy }),
    error => error.code === 'RETRY_COST_RESERVE_REQUIRED',
  );
});
