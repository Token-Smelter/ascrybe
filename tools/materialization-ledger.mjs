// Shared identities and policy for incrementally materialized computations.
//
// The smallest instance is one inference retry: the logical computation stays stable, every paid
// attempt is immutable, and the first valid completion becomes the selected result. The same shape
// extends to estate updates: stable inputs and dependency digests identify what may be reused while
// changed dependencies invalidate only their downstream materializations.
import { sha256, stableStringify } from './lib.mjs';

export const MATERIALIZATION_LEDGER_SCHEMA = 'estate-map/materialized-computation-ledger/v1';
export const MATERIALIZATION_ATTEMPT_CUSTODY_POLICY = 'content-addressed-materialization-attempt-ledger@1';
export const FIRST_VALID_SELECTION_POLICY = 'first-valid-completion@1';
export const DEFAULT_MAX_MATERIALIZATION_ATTEMPTS = 1;
export const MAX_MATERIALIZATION_ATTEMPTS = 8;

const canonical = value => stableStringify(value).trim();

export class MaterializationLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'MaterializationLedgerError';
    this.code = code;
    this.detail = detail;
  }
}

const finite = (value, fallback) => value == null ? fallback : Number(value);

export function normalizeAttemptPolicy(policy = {}) {
  const maxAttempts = finite(policy.max_attempts, DEFAULT_MAX_MATERIALIZATION_ATTEMPTS);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_MATERIALIZATION_ATTEMPTS) {
    throw new MaterializationLedgerError('INVALID_MAX_ATTEMPTS',
      `max_attempts must be an integer from 1 through ${MAX_MATERIALIZATION_ATTEMPTS}`,
      { max_attempts: policy.max_attempts });
  }
  const retryable = policy.retryable_outcomes == null ? [] : policy.retryable_outcomes;
  if (!Array.isArray(retryable) || retryable.some(value => typeof value !== 'string' || !value.trim())) {
    throw new MaterializationLedgerError('INVALID_RETRYABLE_OUTCOMES',
      'retryable_outcomes must be an array of nonblank exact outcome strings');
  }
  const retryableOutcomes = [...new Set(retryable.map(value => value.trim()))].sort();
  if (maxAttempts > 1 && retryableOutcomes.length === 0) {
    throw new MaterializationLedgerError('EMPTY_RETRYABLE_OUTCOMES',
      'max_attempts above one requires at least one explicitly retryable outcome');
  }
  const backoffMs = finite(policy.backoff_ms, 0);
  const backoffMultiplier = finite(policy.backoff_multiplier, 2);
  const maxBackoffMs = finite(policy.max_backoff_ms, Math.max(backoffMs, 30000));
  const jitterRatio = finite(policy.jitter_ratio, 0);
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new MaterializationLedgerError('INVALID_RETRY_BACKOFF', 'backoff_ms must be non-negative');
  }
  if (!Number.isFinite(backoffMultiplier) || backoffMultiplier < 1) {
    throw new MaterializationLedgerError('INVALID_RETRY_MULTIPLIER', 'backoff_multiplier must be at least one');
  }
  if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < backoffMs) {
    throw new MaterializationLedgerError('INVALID_MAX_RETRY_BACKOFF',
      'max_backoff_ms must be finite and at least backoff_ms');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.5) {
    throw new MaterializationLedgerError('INVALID_RETRY_JITTER', 'jitter_ratio must be from 0 through 0.5');
  }
  return Object.freeze({
    max_attempts: maxAttempts,
    retryable_outcomes: Object.freeze(retryableOutcomes),
    backoff_ms: Math.round(backoffMs),
    backoff_multiplier: backoffMultiplier,
    max_backoff_ms: Math.round(maxBackoffMs),
    jitter_ratio: jitterRatio,
  });
}

export function materializationIdentity({
  stage, logical_key, prompt, dependencies = {},
  custody_policy = MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
} = {}) {
  if (typeof stage !== 'string' || !stage.trim()) {
    throw new MaterializationLedgerError('MATERIALIZATION_STAGE_REQUIRED', 'materialization stage is required');
  }
  if (typeof logical_key !== 'string' || !logical_key.trim()) {
    throw new MaterializationLedgerError('MATERIALIZATION_KEY_REQUIRED', 'logical materialization key is required');
  }
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new MaterializationLedgerError('INVALID_MATERIALIZATION_DEPENDENCIES', 'dependencies must be an object');
  }
  const inputDigest = sha256(String(prompt || ''));
  const dependencyDigest = sha256(canonical(dependencies));
  const body = {
    schema: MATERIALIZATION_LEDGER_SCHEMA,
    custody_policy,
    stage: stage.trim(),
    logical_key: logical_key.trim(),
    input_digest: inputDigest,
    dependency_digest: dependencyDigest,
  };
  return Object.freeze({
    ...body,
    materialization_id: `materialization:${sha256(canonical(body))}`,
    dependencies: Object.freeze({ ...dependencies }),
  });
}

export function materializationAttemptIdentity(materialization, attempt) {
  if (!materialization?.materialization_id) {
    throw new MaterializationLedgerError('INVALID_MATERIALIZATION_IDENTITY', 'attempt identity requires a materialization');
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_MATERIALIZATION_ATTEMPTS) {
    throw new MaterializationLedgerError('INVALID_ATTEMPT_NUMBER', 'attempt number is out of range', { attempt });
  }
  const body = {
    schema: MATERIALIZATION_LEDGER_SCHEMA,
    materialization_id: materialization.materialization_id,
    attempt,
  };
  return Object.freeze({
    ...body,
    attempt_id: `attempt:${sha256(canonical(body))}`,
  });
}

export function retryDelayMs({ policy, failed_attempt, next_attempt_id }) {
  const normalized = normalizeAttemptPolicy(policy);
  if (!Number.isInteger(failed_attempt) || failed_attempt < 1) {
    throw new MaterializationLedgerError('INVALID_FAILED_ATTEMPT', 'failed_attempt must be positive');
  }
  const exponential = Math.min(
    normalized.max_backoff_ms,
    normalized.backoff_ms * (normalized.backoff_multiplier ** Math.max(0, failed_attempt - 1)),
  );
  if (!exponential || !normalized.jitter_ratio) return Math.round(exponential);
  const digest = sha256(String(next_attempt_id || ''));
  const unit = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  const jitter = 1 + ((unit * 2) - 1) * normalized.jitter_ratio;
  return Math.min(normalized.max_backoff_ms, Math.max(0, Math.round(exponential * jitter)));
}

export function retryEligibility({ result, validation_ok = false, attempt, policy }) {
  const normalized = normalizeAttemptPolicy(policy);
  if (validation_ok) return Object.freeze({ retry: false, reason: 'valid_completion' });
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new MaterializationLedgerError('INVALID_ATTEMPT_NUMBER', 'retry eligibility requires a positive attempt');
  }
  if (attempt >= normalized.max_attempts) return Object.freeze({ retry: false, reason: 'attempt_limit' });
  const outcome = String(result?.outcome || '');
  if (!normalized.retryable_outcomes.includes(outcome)) {
    return Object.freeze({ retry: false, reason: 'outcome_not_retryable' });
  }
  if (result?.accepted == null || result?.billing_status === 'acceptance_unknown') {
    return Object.freeze({ retry: false, reason: 'acceptance_unknown' });
  }
  return Object.freeze({ retry: true, reason: 'explicit_transient_outcome' });
}

export function assertAttemptCapacity({ logical_units, max_calls, max_known_cost_usd, cost_reserve_per_call_usd, policy }) {
  const normalized = normalizeAttemptPolicy(policy);
  const units = Number(logical_units);
  const calls = Number(max_calls);
  const costCap = Number(max_known_cost_usd);
  const reserve = Number(cost_reserve_per_call_usd || 0);
  if (!Number.isInteger(units) || units < 1) {
    throw new MaterializationLedgerError('INVALID_LOGICAL_UNIT_COUNT', 'logical_units must be positive');
  }
  const requiredCalls = units * normalized.max_attempts;
  if (!Number.isInteger(calls) || calls < requiredCalls) {
    throw new MaterializationLedgerError('RETRY_CALL_CAP_INSUFFICIENT',
      `max_calls ${calls} cannot reserve ${normalized.max_attempts} attempt(s) for ${units} logical unit(s)`,
      { logical_units: units, max_attempts_per_unit: normalized.max_attempts, required_calls: requiredCalls, max_calls: calls });
  }
  const requiredCost = Number((requiredCalls * reserve).toFixed(6));
  if (normalized.max_attempts > 1 && reserve <= 0) {
    throw new MaterializationLedgerError('RETRY_COST_RESERVE_REQUIRED',
      'cost_reserve_per_call_usd must be positive when retries are authorized',
      { max_attempts_per_unit: normalized.max_attempts, cost_reserve_per_call_usd: reserve });
  }
  if (reserve > 0 && (!Number.isFinite(costCap) || costCap < requiredCost)) {
    throw new MaterializationLedgerError('RETRY_COST_CAP_INSUFFICIENT',
      `max_known_cost_usd ${costCap} is below the reserved retry envelope ${requiredCost}`,
      { required_calls: requiredCalls, cost_reserve_per_call_usd: reserve, required_cost_usd: requiredCost, max_known_cost_usd: costCap });
  }
  return Object.freeze({ logical_units: units, max_attempts_per_unit: normalized.max_attempts, required_calls: requiredCalls, required_cost_usd: requiredCost });
}
