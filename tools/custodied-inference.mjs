// Generic paid-unit executor. Legacy callers retain one durable dispatch; materialized callers use
// immutable bounded attempts plus one selected/terminal logical result. Every consumer supplies
// content-bound keys and a deterministic validator.
import { sha256 } from './lib.mjs';
import {
  assertInferencePromptWithinLimit,
  INFERENCE_CUSTODY_POLICY,
  interruptedInferenceCustody,
  openInferenceCircuit,
} from './inference-custody.mjs';
import { modelStatsDelta, modelStatsSnapshot } from './model-usage.mjs';
import {
  FIRST_VALID_SELECTION_POLICY,
  MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
  MATERIALIZATION_LEDGER_SCHEMA,
  materializationAttemptIdentity,
  materializationIdentity,
  normalizeAttemptPolicy,
  retryDelayMs,
  retryEligibility,
} from './materialization-ledger.mjs';

export class InferenceBudgetError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'InferenceBudgetError';
    this.code = code;
    this.detail = detail;
    // Reaching a declared spend/call bound before dispatch is an explicit coverage gap, not a
    // provider-wide failure. Invalid budget configuration remains an invariant-wide stop.
    this.unit_outcome = /(?:CAP_REACHED|RESERVATION_CAP_REACHED)$/.test(code)
      ? 'unresolved_due_to_bound' : 'fleet_stop';
  }
}

export function createInferenceBudget({
  max_calls, max_known_cost_usd, max_unpriced_attempts = 3, cost_reserve_per_call_usd = 0,
}) {
  const callCap = Number(max_calls);
  const costCap = Number(max_known_cost_usd);
  const unpricedCap = Number(max_unpriced_attempts);
  const callCostReserve = Number(cost_reserve_per_call_usd || 0);
  if (!Number.isInteger(callCap) || callCap < 1) throw new InferenceBudgetError('INVALID_CALL_CAP', 'max_calls must be a positive integer');
  if (!Number.isFinite(costCap) || costCap <= 0) throw new InferenceBudgetError('INVALID_COST_CAP', 'max_known_cost_usd must be positive');
  if (!Number.isInteger(unpricedCap) || unpricedCap < 0) throw new InferenceBudgetError('INVALID_UNPRICED_CAP', 'max_unpriced_attempts must be a non-negative integer');
  if (!Number.isFinite(callCostReserve) || callCostReserve < 0) throw new InferenceBudgetError('INVALID_CALL_COST_RESERVE', 'cost_reserve_per_call_usd must be non-negative');
  const accounted = new Set(), reserved = new Set(), reservationWaiters = new Set();
  let accountedCalls = 0, knownCost = 0, unpricedAttempts = 0;
  let stopped = null;

  const notifyReservationWaiters = () => {
    const waiters = [...reservationWaiters];
    reservationWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  const beforeDispatch = (key, { continuation = false } = {}) => {
    if (accounted.has(key) || reserved.has(key)) return;
    if (stopped && !(continuation && stopped.reason === 'unpriced_attempt_cap_exceeded')) {
      throw new InferenceBudgetError(stopped.code, stopped.message, { ...stopped.detail, budget: snapshot() });
    }
    if (knownCost >= costCap) throw new InferenceBudgetError('KNOWN_COST_CAP_REACHED', `known cost $${knownCost.toFixed(6)} reached cap $${costCap.toFixed(6)}`, { known_cost_usd: knownCost, max_known_cost_usd: costCap });
    const projectedReservedCost = Number((knownCost + (reserved.size + 1) * callCostReserve).toFixed(6));
    if (callCostReserve && projectedReservedCost > costCap) {
      throw new InferenceBudgetError('KNOWN_COST_RESERVATION_CAP_REACHED',
        `known cost plus in-flight reserve $${projectedReservedCost.toFixed(6)} exceeds cap $${costCap.toFixed(6)}`,
        { known_cost_usd: knownCost, in_flight: reserved.size, cost_reserve_per_call_usd: callCostReserve, max_known_cost_usd: costCap });
    }
    if (accountedCalls + reserved.size + 1 > callCap) throw new InferenceBudgetError('CALL_CAP_REACHED', `call cap ${callCap} reached`, { accounted_calls: accountedCalls, in_flight: reserved.size, max_calls: callCap });
    reserved.add(key);
  };

  // A pessimistic in-flight reservation can temporarily consume the remaining dollar headroom.
  // That is scheduling contention, not a terminal bound: wait for one owned call to produce a
  // durable usage receipt, then evaluate the real headroom. `beforeDispatch` stays synchronous for
  // preflight callers; paid executors use this waiting form.
  const waitBeforeDispatch = async (key, options = {}) => {
    while (true) {
      try { beforeDispatch(key, options); return; }
      catch (error) {
        const transientReservationContention = error?.code === 'KNOWN_COST_RESERVATION_CAP_REACHED'
          && reserved.size > 0 && knownCost + callCostReserve <= costCap;
        if (!transientReservationContention) throw error;
        await new Promise(resolve => reservationWaiters.add(resolve));
      }
    }
  };

  const account = (key, stats) => {
    if (accounted.has(key)) return;
    reserved.delete(key);
    accounted.add(key);
    // Count the dispatches WE authorized, not what the runner reports. Cost still comes from
    // provider usage, but a runner that under-reports its call count must not be able to slip past
    // the call cap.
    accountedCalls += Math.max(1, Number(stats?.calls || 0));
    knownCost = Number((knownCost + Number(stats?.cost || 0)).toFixed(6));
    unpricedAttempts += Number(stats?.unpriced_attempts || 0);
    // Accounting a completion must never throw: other workers may already have returned purchased
    // answers that still need deterministic validation and a final materialization record. Record a
    // sticky stop here and enforce it at the next dispatch boundary. An already-authorized retry of
    // the same logical materialization may cross an unpriced-attempt stop; new logical work may not.
    if (unpricedAttempts > unpricedCap && !stopped) {
      stopped = {
        reason: 'unpriced_attempt_cap_exceeded',
        code: 'UNPRICED_ATTEMPT_LIMIT_EXCEEDED',
        message: `inference budget stopped: ${unpricedAttempts} unpriced attempts exceeds cap ${unpricedCap}`,
        detail: { key, stats },
      };
    }
    if (knownCost > costCap && !stopped) {
      stopped = {
        reason: 'known_cost_cap_exceeded_after_completion',
        code: 'KNOWN_COST_LIMIT_EXCEEDED_AFTER_COMPLETION',
        message: 'inference budget exceeded known-cost cap after durable completion',
        detail: { key, stats },
      };
    }
    notifyReservationWaiters();
  };

  const snapshot = () => Object.freeze({
    max_calls: callCap,
    max_known_cost_usd: costCap,
    cost_reserve_per_call_usd: callCostReserve,
    accounted_calls: accountedCalls,
    in_flight_reservations: reserved.size,
    known_cost_usd: knownCost,
    cost_status: unpricedAttempts ? 'lower_bound' : 'complete',
    unpriced_attempts: unpricedAttempts,
    max_unpriced_attempts: unpricedCap,
    promotion_blocked: unpricedAttempts > 0,
    stopped,
  });
  return Object.freeze({ beforeDispatch, waitBeforeDispatch, account, snapshot });
}

const normalizedValidation = value => {
  if (value === true) return { ok: true, value: null };
  if (value === false || value == null) return { ok: false, reason: 'validator returned false' };
  if (typeof value === 'object' && typeof value.ok === 'boolean') return value;
  return { ok: true, value };
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));

function unitOutcomeFor(value) {
  return value?.result?.accepted == null || value?.result?.billing_status === 'acceptance_unknown'
    ? 'acceptance_unknown' : 'provider_failure';
}

async function assessCompletion(value, validate) {
  if (value?.result?.outcome !== 'ok') {
    return Object.freeze({ ok: false, reason: 'incomplete paid result', validation: null });
  }
  let validation;
  try { validation = normalizedValidation(await validate(value.result)); }
  catch (error) {
    validation = {
      ok: false,
      reason: error.message,
      error_code: error.code || null,
      detail: error.detail || null,
    };
  }
  return Object.freeze({ ok: validation.ok, reason: validation.ok ? null : 'invalid paid result', validation });
}

async function runMaterializedInference({
  checkpoint, stage, key, tag, prompt, runner, budget, validate, inspectOnly,
  receipt_context, attempt_policy, materialization_dependencies, on_attempt,
}) {
  const policy = normalizeAttemptPolicy(attempt_policy);
  const materialization = materializationIdentity({
    stage,
    logical_key: key,
    prompt,
    dependencies: materialization_dependencies || {},
    custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
  });
  const startedStage = `${stage}-attempt-started`;
  const completionStage = `${stage}-attempt-completion`;
  const retryStage = `${stage}-retry-scheduled`;
  const finalStage = `${stage}-materialization`;
  const history = [];
  const emit = event => {
    history.push(Object.freeze(event));
    try { on_attempt?.(Object.freeze(event)); } catch { /* telemetry cannot break paid custody */ }
  };
  const attemptIdentity = attempt => materializationAttemptIdentity(materialization, attempt);
  const account = (attemptId, value) => budget?.account(`${stage}:${key}:${attemptId}`, value.model_stats);
  const summary = final => Object.freeze({
    schema: MATERIALIZATION_LEDGER_SCHEMA,
    custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
    materialization_id: materialization.materialization_id,
    logical_key: key,
    input_digest: materialization.input_digest,
    dependency_digest: materialization.dependency_digest,
    dependencies: materialization.dependencies,
    selection_policy: FIRST_VALID_SELECTION_POLICY,
    attempt_policy: policy,
    status: final.status,
    attempt_count: final.attempt_count,
    retry_count: Math.max(0, Number(final.attempt_count || 0) - 1),
    selected_attempt: final.selected_attempt ?? null,
    selected_attempt_id: final.selected_attempt_id ?? null,
    terminal_attempt: final.terminal_attempt ?? null,
    terminal_attempt_id: final.terminal_attempt_id ?? null,
    terminal_reason: final.terminal_reason ?? null,
    terminal_outcome: final.terminal_outcome ?? null,
    failure_outcomes: Array.isArray(final.failure_outcomes) ? final.failure_outcomes.slice() : [],
    history: history.slice(),
  });
  const incomplete = (value, assessment, attempt, attemptId, final) => ({
    ...value,
    validated: null,
    materialization: summary(final),
    incomplete: {
      stage,
      key,
      tag,
      reason: assessment.reason,
      outcome: value.result?.outcome ?? null,
      unit_outcome: assessment.validation?.terminal_incomplete ? 'quarantined' : unitOutcomeFor(value),
      recorded: true,
      materialization_id: materialization.materialization_id,
      attempt,
      attempt_id: attemptId,
      attempt_limit: policy.max_attempts,
      validation: assessment.validation?.ok === false ? assessment.validation : undefined,
    },
  });
  const finalValue = ({ status, attempt, attemptId, assessment, failureOutcomes }) => ({
    schema: MATERIALIZATION_LEDGER_SCHEMA,
    custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
    materialization_id: materialization.materialization_id,
    logical_key: key,
    input_digest: materialization.input_digest,
    dependency_digest: materialization.dependency_digest,
    dependencies: materialization.dependencies,
    selection_policy: FIRST_VALID_SELECTION_POLICY,
    attempt_policy: policy,
    status,
    attempt_count: attempt,
    retry_count: Math.max(0, attempt - 1),
    selected_attempt: status === 'selected' ? attempt : null,
    selected_attempt_id: status === 'selected' ? attemptId : null,
    terminal_attempt: status === 'terminal_incomplete' ? attempt : null,
    terminal_attempt_id: status === 'terminal_incomplete' ? attemptId : null,
    terminal_reason: status === 'terminal_incomplete' ? assessment.reason : null,
    terminal_outcome: status === 'terminal_incomplete' ? failureOutcomes.at(-1) || null : null,
    failure_outcomes: failureOutcomes.slice(),
    finalized_at: new Date().toISOString(),
  });

  const existingFinal = checkpoint.get(finalStage, key);
  if (existingFinal) {
    if (existingFinal.materialization_id !== materialization.materialization_id
      || existingFinal.input_digest !== materialization.input_digest
      || existingFinal.dependency_digest !== materialization.dependency_digest) {
      throw new InferenceBudgetError('MATERIALIZATION_IDENTITY_MISMATCH',
        `stored materialization identity does not match ${tag}`,
        { expected: materialization, stored: existingFinal });
    }
    let firstValidAttempt = null;
    for (let attempt = 1; attempt <= Number(existingFinal.attempt_count || 0); attempt += 1) {
      const attemptId = attemptIdentity(attempt).attempt_id;
      const value = checkpoint.get(completionStage, attemptId);
      if (!value) throw new InferenceBudgetError('MATERIALIZATION_COMPLETION_MISSING',
        `materialization ${tag} names attempt ${attempt} without a completion`, { attempt, attempt_id: attemptId });
      account(attemptId, value);
      const assessment = await assessCompletion(value, validate);
      if (assessment.ok && firstValidAttempt === null) firstValidAttempt = attempt;
      emit({
        materialization_id: materialization.materialization_id,
        logical_key: key,
        attempt,
        attempt_id: attemptId,
        outcome: value.result?.outcome ?? null,
        validation_ok: assessment.ok,
        selected: existingFinal.status === 'selected' && existingFinal.selected_attempt_id === attemptId,
        fresh: false,
      });
    }
    const terminalAttempt = existingFinal.status === 'selected'
      ? Number(existingFinal.selected_attempt) : Number(existingFinal.terminal_attempt);
    const terminalId = attemptIdentity(terminalAttempt).attempt_id;
    const value = checkpoint.get(completionStage, terminalId);
    const assessment = await assessCompletion(value, validate);
    if (existingFinal.status === 'selected') {
      if (!assessment.ok || existingFinal.selected_attempt_id !== terminalId
        || firstValidAttempt !== terminalAttempt) {
        throw new InferenceBudgetError('MATERIALIZATION_SELECTION_INVALID',
          `stored selection is not the first valid completion for ${tag}`,
          { materialization: existingFinal, assessment, first_valid_attempt: firstValidAttempt });
      }
      return {
        ...value,
        validated: assessment.validation.value,
        incomplete: null,
        materialization: summary(existingFinal),
      };
    }
    if (existingFinal.status !== 'terminal_incomplete' || existingFinal.terminal_attempt_id !== terminalId
      || firstValidAttempt !== null) {
      throw new InferenceBudgetError('MATERIALIZATION_TERMINAL_INVALID',
        `stored terminal materialization is malformed for ${tag}`, { materialization: existingFinal });
    }
    return incomplete(value, assessment, terminalAttempt, terminalId, existingFinal);
  }

  const failureOutcomes = [];
  for (let attempt = 1; attempt <= policy.max_attempts; attempt += 1) {
    const attemptId = attemptIdentity(attempt).attempt_id;
    let value = checkpoint.get(completionStage, attemptId);
    let fresh = false;
    if (!value) {
      if (inspectOnly) {
        throw new InferenceInspectOnlyError({
          stage,
          key,
          tag,
          materialization_id: materialization.materialization_id,
          attempt,
          attempt_id: attemptId,
        });
      }
      const started = checkpoint.get(startedStage, attemptId);
      if (started) {
        const interrupted = interruptedInferenceCustody({ model: runner.model, tag, kind: runner.kind || 'unknown' });
        value = {
          ...interrupted,
          completed_at: new Date().toISOString(),
          receipt_context: started.receipt_context ?? receipt_context,
          materialization_id: materialization.materialization_id,
          logical_key: key,
          attempt,
          attempt_id: attemptId,
        };
        await checkpoint.put(completionStage, attemptId, value);
      } else {
        if (attempt > 1) {
          const scheduled = checkpoint.get(retryStage, attemptId);
          if (!scheduled) throw new InferenceBudgetError('RETRY_SCHEDULE_MISSING',
            `attempt ${attempt} for ${tag} has no durable retry schedule`, { attempt, attempt_id: attemptId });
          const remaining = Date.parse(scheduled.not_before) - Date.now();
          if (remaining > 0) await sleep(remaining);
        }
        const continuation = attempt > 1;
        if (budget?.waitBeforeDispatch) {
          await budget.waitBeforeDispatch(`${stage}:${key}:${attemptId}`, { continuation });
        } else budget?.beforeDispatch(`${stage}:${key}:${attemptId}`, { continuation });
        await checkpoint.put(startedStage, attemptId, {
          schema: MATERIALIZATION_LEDGER_SCHEMA,
          custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
          materialization_id: materialization.materialization_id,
          logical_key: key,
          input_digest: materialization.input_digest,
          dependency_digest: materialization.dependency_digest,
          dependencies: materialization.dependencies,
          selection_policy: FIRST_VALID_SELECTION_POLICY,
          attempt,
          attempt_id: attemptId,
          tag: `${tag}#attempt=${attempt}`,
          logical_tag: tag,
          model: runner.model,
          prompt_digest: materialization.input_digest,
          inference_custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
          started_at: new Date().toISOString(),
          receipt_context,
        });
        const before = modelStatsSnapshot(runner);
        const result = await runner.complete({ prompt, tag: `${tag}#attempt=${attempt}` });
        const model_stats = modelStatsDelta(before, modelStatsSnapshot(runner), runner.model);
        value = {
          result,
          model_stats,
          completed_at: new Date().toISOString(),
          receipt_context,
          materialization_id: materialization.materialization_id,
          logical_key: key,
          attempt,
          attempt_id: attemptId,
        };
        await checkpoint.put(completionStage, attemptId, value);
        fresh = true;
      }
    }

    account(attemptId, value);
    const assessment = await assessCompletion(value, validate);
    const eligibility = retryEligibility({ result: value.result, validation_ok: assessment.ok, attempt, policy });
    if (!assessment.ok) failureOutcomes.push(value.result?.outcome ?? null);
    emit({
      materialization_id: materialization.materialization_id,
      logical_key: key,
      attempt,
      attempt_id: attemptId,
      outcome: value.result?.outcome ?? null,
      validation_ok: assessment.ok,
      retryable: eligibility.retry,
      retry_reason: eligibility.reason,
      selected: assessment.ok,
      fresh,
    });

    if (assessment.ok) {
      const final = finalValue({ status: 'selected', attempt, attemptId, assessment, failureOutcomes });
      await checkpoint.put(finalStage, key, final);
      return {
        ...value,
        validated: assessment.validation.value,
        incomplete: null,
        materialization: summary(final),
      };
    }

    if (eligibility.retry) {
      const nextAttempt = attempt + 1;
      const nextAttemptId = attemptIdentity(nextAttempt).attempt_id;
      const delayMs = retryDelayMs({ policy, failed_attempt: attempt, next_attempt_id: nextAttemptId });
      const existingSchedule = checkpoint.get(retryStage, nextAttemptId);
      if (!existingSchedule) {
        const scheduledAt = new Date();
        await checkpoint.put(retryStage, nextAttemptId, {
          schema: MATERIALIZATION_LEDGER_SCHEMA,
          custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
          materialization_id: materialization.materialization_id,
          logical_key: key,
          cause_attempt: attempt,
          cause_attempt_id: attemptId,
          cause_outcome: value.result?.outcome ?? null,
          next_attempt: nextAttempt,
          next_attempt_id: nextAttemptId,
          delay_ms: delayMs,
          scheduled_at: scheduledAt.toISOString(),
          not_before: new Date(scheduledAt.getTime() + delayMs).toISOString(),
        });
      }
      const scheduled = checkpoint.get(retryStage, nextAttemptId);
      const remaining = Date.parse(scheduled.not_before) - Date.now();
      if (remaining > 0) await sleep(remaining);
      continue;
    }

    const final = finalValue({ status: 'terminal_incomplete', attempt, attemptId, assessment, failureOutcomes });
    await checkpoint.put(finalStage, key, final);
    const failed = incomplete(value, assessment, attempt, attemptId, final);
    if (fresh && !assessment.validation?.terminal_incomplete) {
      openInferenceCircuit(`${stage} stopped after ${assessment.reason} ${tag}`, {
        stage,
        key,
        tag,
        result: value.result,
        model_stats: value.model_stats,
        unit_outcome: unitOutcomeFor(value),
        materialization: failed.materialization,
      });
    }
    return failed;
  }
  throw new InferenceBudgetError('MATERIALIZATION_ATTEMPT_LOOP_EXHAUSTED',
    `materialization attempt loop exhausted without a terminal record for ${tag}`);
}

export class InferenceInspectOnlyError extends Error {
  constructor(detail = {}) {
    super('inspect-only replay reached a unit with no stored completion; nothing was written or dispatched');
    this.name = 'InferenceInspectOnlyError';
    this.code = 'INFERENCE_WOULD_DISPATCH';
    this.detail = detail;
  }
}

// `inspectOnly` exists because a "zero-spend" diagnostic that replays a PRODUCTION journal is not
// actually inert: the start receipt is fsynced BEFORE the runner is called, so a diagnostic runner
// that throws still leaves an orphaned start indistinguishable from a real in-flight call, which
// later reads as acceptance_unknown and poisons the run's cost status. In inspect-only mode we
// never write and never dispatch.
export async function runCustodiedInference({
  checkpoint, stage, key, tag, prompt, runner, budget, validate, inspectOnly = false,
  receipt_context = null,
  attempt_policy = null, materialization_dependencies = null, on_attempt = null,
}) {
  if (!checkpoint?.get || !checkpoint?.put) throw new InferenceBudgetError('MISSING_CHECKPOINT', 'custodied inference requires a checkpoint journal');
  if (!runner?.complete || !runner?.stats) throw new InferenceBudgetError('INVALID_RUNNER', 'custodied inference requires runner.complete() and runner.stats()');
  assertInferencePromptWithinLimit(prompt);
  if (attempt_policy) {
    return runMaterializedInference({
      checkpoint, stage, key, tag, prompt, runner, budget, validate, inspectOnly,
      receipt_context, attempt_policy, materialization_dependencies, on_attempt,
    });
  }
  const completionStage = `${stage}-completion`;
  const startedStage = `${stage}-started`;

  // A FRESH failure stops the run: something is wrong right now and continuing would spend more on
  // a broken configuration. A RECORDED failure from an earlier run must NOT re-stop the run on
  // every resume — otherwise one bad receipt is unrecoverable except by deleting evidence of real
  // spend. Replay skips it as an explicit incomplete unit and the taint travels with the result.
  const validateValue = async (value, { fresh }) => {
    const fail = (reason, extra) => {
      const acceptanceUnknown = value.result?.accepted == null
        || value.result?.billing_status === 'acceptance_unknown';
      const unitOutcome = acceptanceUnknown ? 'acceptance_unknown' : 'provider_failure';
      if (fresh) openInferenceCircuit(`${stage} stopped after ${reason} ${tag}`, {
        stage, key, tag, result: value.result, model_stats: value.model_stats,
        unit_outcome: unitOutcome, ...extra,
      });
      return {
        ...value,
        validated: null,
        incomplete: {
          stage, key, tag, reason, outcome: value.result?.outcome ?? null,
          unit_outcome: unitOutcome, recorded: true, ...extra,
        },
      };
    };
    if (value.result?.outcome !== 'ok') return fail('incomplete paid result', {});
    let validation;
    try { validation = normalizedValidation(await validate(value.result)); }
    catch (error) { validation = { ok: false, reason: error.message, error_code: error.code || null, detail: error.detail || null }; }
    if (!validation.ok) return fail('invalid paid result', { validation });
    return { ...value, validated: validation.value, incomplete: null };
  };

  const cached = checkpoint.get(completionStage, key);
  if (cached) {
    budget?.account(`${stage}:${key}`, cached.model_stats);
    return validateValue(cached, { fresh: false });
  }

  if (inspectOnly) throw new InferenceInspectOnlyError({ stage, key, tag });

  const started = checkpoint.get(startedStage, key);
  if (started) {
    const value = interruptedInferenceCustody({ model: runner.model, tag, kind: runner.kind || 'unknown' });
    const recorded = {
      ...value, completed_at: new Date().toISOString(),
      receipt_context: started.receipt_context ?? receipt_context,
    };
    await checkpoint.put(completionStage, key, recorded);
    budget?.account(`${stage}:${key}`, recorded.model_stats);
    return validateValue(recorded, { fresh: false });
  }

  if (budget?.waitBeforeDispatch) await budget.waitBeforeDispatch(`${stage}:${key}`);
  else budget?.beforeDispatch(`${stage}:${key}`);
  await checkpoint.put(startedStage, key, {
    tag,
    model: runner.model,
    prompt_digest: sha256(prompt),
    inference_custody_policy: INFERENCE_CUSTODY_POLICY,
    started_at: new Date().toISOString(),
    receipt_context,
  });
  const before = modelStatsSnapshot(runner);
  const result = await runner.complete({ prompt, tag });
  const model_stats = modelStatsDelta(before, modelStatsSnapshot(runner), runner.model);
  const value = { result, model_stats, completed_at: new Date().toISOString(), receipt_context };
  await checkpoint.put(completionStage, key, value);
  budget?.account(`${stage}:${key}`, model_stats);
  return validateValue(value, { fresh: true });
}
