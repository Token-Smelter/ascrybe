// AC-4: the whole paid-failure surface, exercised offline at zero cost.
//
// Each test below corresponds to a defect that actually stopped the paid pilot. They exist so that
// class of failure is met in CI, not at $0.07 a call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCheckpointJournal } from '../tools/checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from '../tools/custodied-inference.mjs';
import { createScriptedProvider, createNoRedispatchProvider, claimPayload } from '../tools/fake-provider.mjs';
import { applyOutputCap, preflightBounds } from '../tools/outcome-algebra.mjs';
import { createUnitQueue, runQueue } from '../tools/unit-queue.mjs';

async function harness(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `fp-${name}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const checkpoint = await openCheckpointJournal({ file: path.join(dir, 'c.jsonl'), fingerprint: { suite: name } });
  t.after(() => checkpoint.close());
  return { dir, checkpoint, budget: createInferenceBudget({ max_calls: 50, max_known_cost_usd: 5, max_unpriced_attempts: 3 }) };
}

const retryPolicy = Object.freeze({
  max_attempts: 2,
  retryable_outcomes: ['error:provider'],
  backoff_ms: 0,
  max_backoff_ms: 0,
});

async function journalEntries(file) {
  const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return records.filter(record => record.type === 'entry');
}

test('cap boundaries N-1, N, N+1 never discard purchased items', () => {
  for (const [count, expected] of [[63, 'ok'], [64, 'ok'], [65, 'overflow']]) {
    const { claims } = claimPayload({ count });
    const capped = applyOutputCap({ items: claims, max_items: 64 });
    assert.equal(capped.outcome, expected, `count ${count}`);
    assert.equal(capped.retained.length, count, `all ${count} purchased items retained`);
  }
});

test('one malformed item among many valid does not void the purchased unit', async t => {
  const { checkpoint, budget } = await harness(t, 'malformed');
  const runner = createScriptedProvider({ script: [{ kind: 'claims', count: 58, malformed_index: 12 }] });
  const completion = await runCustodiedInference({
    checkpoint, stage: 'x', key: 'k', tag: 't', prompt: 'p', runner, budget,
    validate: response => {
      const proposals = response.json.claims;
      const valid = proposals.filter(c => c.predicate_family);
      const rejected = proposals.filter(c => !c.predicate_family);
      return { ok: valid.length > 0, value: { valid: valid.length, rejected: rejected.length } };
    },
  });
  assert.equal(completion.incomplete, null);
  assert.equal(completion.validated.valid, 57, '57 valid claims survive the one bad sibling');
  assert.equal(completion.validated.rejected, 1);
});

test('timeout edges: just-before completes, just-after is recorded not retried', async t => {
  const { checkpoint, budget } = await harness(t, 'timeout');
  const fast = createScriptedProvider({ script: [{ kind: 'slow', ms: 5, json: { ok: true } }] });
  const ok = await runCustodiedInference({ checkpoint, stage: 's', key: 'fast', tag: 'fast', prompt: 'p', runner: fast, budget, validate: () => true });
  assert.equal(ok.result.outcome, 'ok');

  const timedOut = createScriptedProvider({ script: [{ kind: 'timeout', priced: false }] });
  await assert.rejects(
    runCustodiedInference({ checkpoint, stage: 's', key: 'slow', tag: 'slow', prompt: 'p', runner: timedOut, budget, validate: () => true }),
    error => error.code === 'INFERENCE_CIRCUIT_OPEN',
    'a fresh accepted timeout stops the run',
  );
  // Replay must NOT re-dispatch it.
  const guard = createNoRedispatchProvider(0);
  const replay = await runCustodiedInference({ checkpoint, stage: 's', key: 'slow', tag: 'slow', prompt: 'p', runner: guard, budget, validate: () => true });
  assert.equal(guard.count(), 0, 'a recorded timeout is never re-purchased');
  assert.equal(replay.incomplete.outcome, 'timeout');
});

test('crash after dispatch leaves acceptance_unknown and blocks blind replay', async t => {
  const { checkpoint, budget } = await harness(t, 'crash');
  const crasher = createScriptedProvider({ script: [{ kind: 'crash', at: 'after_dispatch' }] });
  await assert.rejects(
    runCustodiedInference({ checkpoint, stage: 's', key: 'c1', tag: 'c1', prompt: 'p', runner: crasher, budget, validate: () => true }),
    error => error.code === 'FAKE_CRASH',
  );
  const guard = createNoRedispatchProvider(0);
  const replay = await runCustodiedInference({ checkpoint, stage: 's', key: 'c1', tag: 'c1', prompt: 'p', runner: guard, budget, validate: () => true });
  assert.equal(guard.count(), 0, 'an interrupted unit is never blindly re-dispatched');
  assert.equal(replay.incomplete.outcome, 'interrupted:completion_unknown');
});

test('an explicit transient retry preserves attempt one and selects attempt two', async t => {
  const { checkpoint, budget } = await harness(t, 'materialized-retry');
  const runner = createScriptedProvider({ script: [
    { kind: 'provider_error' },
    { kind: 'ok', json: { recovered: true } },
  ] });
  const observed = [];
  const completion = await runCustodiedInference({
    checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'stable prompt', runner, budget,
    attempt_policy: retryPolicy,
    materialization_dependencies: { source_snapshot: 'snapshot-1', window_digest: 'window-1' },
    on_attempt: event => observed.push(event),
    validate: response => response.json?.recovered === true,
  });
  assert.equal(runner.calls().length, 2);
  assert.deepEqual(runner.calls().map(call => call.tag), ['unit-1#attempt=1', 'unit-1#attempt=2']);
  assert.equal(completion.materialization.status, 'selected');
  assert.equal(completion.materialization.selected_attempt, 2);
  assert.equal(completion.materialization.attempt_count, 2);
  assert.deepEqual(observed.map(event => [event.attempt, event.outcome, event.selected]), [
    [1, 'error:provider', false],
    [2, 'ok', true],
  ]);
  assert.equal(budget.snapshot().accounted_calls, 2, 'both immutable attempts count against the budget');

  const entries = await journalEntries(checkpoint.stats().path);
  const stages = entries.map(entry => entry.stage);
  assert.equal(stages.filter(stage => stage === 'm-attempt-started').length, 2);
  assert.equal(stages.filter(stage => stage === 'm-attempt-completion').length, 2);
  assert.equal(stages.filter(stage => stage === 'm-retry-scheduled').length, 1);
  assert.equal(stages.filter(stage => stage === 'm-materialization').length, 1);
  const first = entries.find(entry => entry.stage === 'm-attempt-completion' && entry.value.attempt === 1);
  assert.equal(first.value.result.outcome, 'error:provider', 'first failure remains durable and inspectable');
});

test('a selected materialization replays all accounting with zero redispatch', async t => {
  const { dir, checkpoint, budget } = await harness(t, 'materialized-replay');
  const args = {
    checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'stable prompt', budget,
    attempt_policy: retryPolicy,
    materialization_dependencies: { source_snapshot: 'snapshot-1' },
    validate: response => response.json?.recovered === true,
  };
  await runCustodiedInference({
    ...args,
    runner: createScriptedProvider({ script: [{ kind: 'provider_error' }, { kind: 'ok', json: { recovered: true } }] }),
  });
  await checkpoint.close();

  const reopened = await openCheckpointJournal({ file: path.join(dir, 'c.jsonl'), fingerprint: { suite: 'materialized-replay' } });
  const replayBudget = createInferenceBudget({ max_calls: 50, max_known_cost_usd: 5, max_unpriced_attempts: 3 });
  const guard = createNoRedispatchProvider(0);
  const replay = await runCustodiedInference({ ...args, checkpoint: reopened, budget: replayBudget, runner: guard });
  await reopened.close();
  assert.equal(guard.count(), 0);
  assert.equal(replay.materialization.selected_attempt, 2);
  assert.equal(replayBudget.snapshot().accounted_calls, 2, 'replay accounts every prior attempt, not only the selection');
  assert.equal(replay.materialization.history.length, 2);
  assert.equal(replay.materialization.history[0].outcome, 'error:provider');
});

test('retry exhaustion becomes one durable terminal materialization', async t => {
  const { checkpoint, budget } = await harness(t, 'materialized-exhaustion');
  const runner = createScriptedProvider({ script: [{ kind: 'provider_error' }] });
  await assert.rejects(
    runCustodiedInference({
      checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'p', runner, budget,
      attempt_policy: retryPolicy,
      validate: () => true,
    }),
    error => error.code === 'INFERENCE_CIRCUIT_OPEN' && error.detail?.materialization?.attempt_count === 2,
  );
  assert.equal(runner.calls().length, 2);
  const guard = createNoRedispatchProvider(0);
  const replay = await runCustodiedInference({
    checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'p', runner: guard, budget,
    attempt_policy: retryPolicy,
    validate: () => true,
  });
  assert.equal(guard.count(), 0);
  assert.equal(replay.materialization.status, 'terminal_incomplete');
  assert.equal(replay.materialization.attempt_count, 2);
});

test('semantic validation failure is not silently retried', async t => {
  const { checkpoint, budget } = await harness(t, 'materialized-validator');
  const runner = createScriptedProvider({ script: [{ kind: 'ok', json: { invalid: true } }, { kind: 'ok', json: { recovered: true } }] });
  await assert.rejects(
    runCustodiedInference({
      checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'p', runner, budget,
      attempt_policy: retryPolicy,
      validate: response => response.json?.recovered === true,
    }),
    error => error.code === 'INFERENCE_CIRCUIT_OPEN' && error.detail?.materialization?.attempt_count === 1,
  );
  assert.equal(runner.calls().length, 1);
});

test('interrupted materialized attempt records acceptance_unknown and never retries', async t => {
  const { checkpoint, budget } = await harness(t, 'materialized-crash');
  const crasher = createScriptedProvider({ script: [{ kind: 'crash', at: 'after_dispatch' }] });
  await assert.rejects(
    runCustodiedInference({
      checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'p', runner: crasher, budget,
      attempt_policy: retryPolicy, validate: () => true,
    }),
    error => error.code === 'FAKE_CRASH',
  );
  const guard = createNoRedispatchProvider(0);
  const replay = await runCustodiedInference({
    checkpoint, stage: 'm', key: 'unit-1', tag: 'unit-1', prompt: 'p', runner: guard, budget,
    attempt_policy: retryPolicy, validate: () => true,
  });
  assert.equal(guard.count(), 0);
  assert.equal(replay.incomplete.unit_outcome, 'acceptance_unknown');
  assert.equal(replay.materialization.status, 'terminal_incomplete');
  assert.equal(replay.materialization.attempt_count, 1);
});

test('every recorded failure state replays as a skip, never as a new purchase', async t => {
  const { checkpoint, budget } = await harness(t, 'replay');
  const failures = [
    ['timeout', { kind: 'timeout', priced: false }],
    ['output_limit', { kind: 'output_limit' }],
    ['unparseable', { kind: 'unparseable' }],
    ['provider_error', { kind: 'provider_error' }],
  ];
  for (const [key, directive] of failures) {
    const runner = createScriptedProvider({ script: [directive] });
    await assert.rejects(
      runCustodiedInference({ checkpoint, stage: 'r', key, tag: key, prompt: 'p', runner, budget, validate: () => true }),
      error => error.code === 'INFERENCE_CIRCUIT_OPEN',
      `${key} must stop the run when fresh`,
    );
  }
  const guard = createNoRedispatchProvider(0);
  for (const [key] of failures) {
    const replay = await runCustodiedInference({ checkpoint, stage: 'r', key, tag: key, prompt: 'p', runner: guard, budget, validate: () => true });
    assert.ok(replay.incomplete, `${key} replays as incomplete`);
  }
  assert.equal(guard.count(), 0, 'no recorded failure was ever re-purchased');
});

test('contradictory cap configurations are rejected before any dispatch', () => {
  const bad = preflightBounds({ max_depth: 2, max_children_per_region: 6, max_regions_per_document: 24, max_planning_calls_per_document: 8 });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.length >= 2);
});

test('maximum legal fan-out runs concurrently without fleet failure', async () => {
  const queue = createUnitQueue({ units: Array.from({ length: 43 }, (_, i) => ({ id: `u${i}` })) });
  await runQueue({ queue, concurrency: 32, process: async () => ({ outcome: 'ok' }) });
  const status = queue.status();
  assert.equal(status.by_state.done, 43);
  assert.equal(status.stopped, null);
});

test('an oversized indivisible unit terminates by bound, not by failure', async () => {
  const queue = createUnitQueue({ units: [{ id: 'huge', payload: { bytes: 900000, blocks: 1 } }] });
  await runQueue({
    queue, concurrency: 1,
    process: async unit => (unit.payload.blocks === 1 && unit.payload.bytes > 49152
      ? { outcome: 'unresolved_due_to_bound', findings: [{ code: 'INDIVISIBLE_OVERSIZED' }] }
      : { outcome: 'ok' }),
  });
  const status = queue.status();
  assert.equal(status.by_state.skipped_bound, 1);
  assert.equal(status.stopped, null, 'a bound is not a provider failure');
});
