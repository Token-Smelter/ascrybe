import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnitQueue, runQueue } from '../tools/unit-queue.mjs';

const units = n => Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, payload: { i } }));

test('one bad unit quarantines itself and the fleet keeps running', async () => {
  // The pilot's global circuit would have stopped everything here. At 32-way that is fatal to scale.
  const queue = createUnitQueue({ units: units(8) });
  const seen = [];
  await runQueue({
    queue, concurrency: 4,
    process: async unit => {
      seen.push(unit.id);
      if (unit.id === 'u3') throw Object.assign(new Error('claim count 65 exceeds 64'), { code: 'OVERFLOW' });
      return { outcome: 'ok' };
    },
  });
  const status = queue.status();
  assert.equal(seen.length, 8, 'every unit was attempted despite one failure');
  assert.equal(status.by_state.done, 7);
  assert.equal(status.by_state.quarantined, 1);
  assert.equal(status.stopped, null, 'a single content failure must not stop the fleet');
});

test('a provider-wide failure rate does stop the fleet', async () => {
  const queue = createUnitQueue({ units: units(12), fleet_stop: { failure_rate: 0.5, min_samples: 4 } });
  await runQueue({
    queue, concurrency: 2,
    process: async () => ({ outcome: 'acceptance_unknown' }),
  });
  const status = queue.status();
  assert.ok(status.stopped, 'sustained acceptance_unknown must trip the fleet stop');
  assert.equal(status.stopped.reason, 'fleet_failure_rate_exceeded');
  assert.ok(status.by_state.pending > 0, 'remaining units are left unclaimed rather than dispatched');
});

test('typed worker exceptions participate in the fleet circuit instead of becoming content quarantines', async () => {
  const queue = createUnitQueue({ units: units(12), fleet_stop: { failure_rate: 0.5, min_samples: 4 } });
  await runQueue({
    queue, concurrency: 2,
    process: async () => {
      const error = new Error('provider unavailable');
      error.code = 'INFERENCE_CIRCUIT_OPEN';
      error.unit_outcome = 'provider_failure';
      throw error;
    },
  });
  const status = queue.status();
  assert.equal(status.stopped.reason, 'fleet_failure_rate_exceeded');
  assert.ok(status.by_state.pending > 0);
  assert.ok(queue.rows().filter(row => row.outcome === 'provider_failure').length >= 4);
});

test('an explicit fleet-stop exception halts immediately', async () => {
  const queue = createUnitQueue({ units: units(12), fleet_stop: { failure_rate: 0.9, min_samples: 10 } });
  await runQueue({
    queue, concurrency: 1,
    process: async () => {
      const error = new Error('budget circuit');
      error.unit_outcome = 'fleet_stop';
      throw error;
    },
  });
  const status = queue.status();
  assert.equal(status.stopped.reason, 'explicit_fleet_stop');
  assert.equal(status.by_state.pending, 11);
});

test('an expired lease becomes acceptance_unknown and is never blindly requeued', () => {
  let t = 1_000;
  const queue = createUnitQueue({ units: units(1), lease_ms: 100, clock: () => t });
  const claimed = queue.claim('w1');
  assert.equal(claimed.id, 'u1');
  t += 500; // lease expires
  assert.equal(queue.claim('w2'), null, 'an expired unit must NOT be handed to another worker');
  const row = queue.rows()[0];
  assert.equal(row.state, 'acceptance_unknown');
  assert.equal(row.outcome, 'acceptance_unknown');
  assert.equal(row.findings[0].code, 'LEASE_EXPIRED');
});

test('heartbeat extends a lease and a late result cannot overwrite custody', async () => {
  let t = 1_000;
  const queue = createUnitQueue({ units: units(1), lease_ms: 100, clock: () => t });
  queue.claim('w1');
  t += 80;
  assert.equal(queue.heartbeat('w1', 'u1'), true);
  t += 80;
  assert.equal(queue.rows()[0].state, 'leased', 'heartbeat kept the lease alive');
  t += 500;
  queue.status(); // triggers expiry
  const late = await queue.settle('w1', 'u1', 'ok', { value: { claims: 10 } });
  assert.equal(late.late, true);
  assert.equal(queue.rows()[0].outcome, 'acceptance_unknown', 'custody record survives a late success');
  assert.ok(queue.rows()[0].findings.some(f => f.code === 'LATE_RESULT_AFTER_LEASE_EXPIRY'));
});

test('dispatch keys are unique per attempt and leases are exclusive', async () => {
  const queue = createUnitQueue({ units: units(2) });
  const a = queue.claim('w1');
  const b = queue.claim('w2');
  assert.notEqual(a.id, b.id, 'two workers never receive the same unit');
  assert.notEqual(a.dispatch_key, b.dispatch_key);
  await assert.rejects(queue.settle('w2', a.id, 'ok'), error => error.code === 'LEASE_NOT_HELD');
});

test('bound-skipped units are terminal and distinct from failures', async () => {
  const queue = createUnitQueue({ units: units(3) });
  await runQueue({ queue, concurrency: 1, process: async unit => (unit.id === 'u2' ? { outcome: 'unresolved_due_to_bound' } : { outcome: 'ok' }) });
  const status = queue.status();
  assert.equal(status.by_state.skipped_bound, 1);
  assert.equal(status.by_state.done, 2);
  assert.equal(status.stopped, null, 'a scope bound is not a fleet failure');
});

test('worker launch ramp lets a cooperative circuit stop admission before the full fleet leases', async () => {
  const queue = createUnitQueue({ units: units(8) });
  const controller = new AbortController();
  const seen = [];
  await runQueue({
    queue, concurrency: 4, worker_start_delay_ms: 10, signal: controller.signal,
    process: async unit => {
      seen.push(unit.id);
      controller.abort('host load circuit');
      return { outcome: 'ok' };
    },
  });
  assert.deepEqual(seen, ['u1']);
  assert.deepEqual(queue.status().by_state, { done: 1, pending: 7 });
});

test('worker launch delay rejects invalid values before leasing work', async () => {
  const queue = createUnitQueue({ units: units(1) });
  await assert.rejects(
    runQueue({ queue, concurrency: 1, worker_start_delay_ms: -1, process: async () => ({ outcome: 'ok' }) }),
    error => error.code === 'INVALID_WORKER_START_DELAY',
  );
  assert.deepEqual(queue.status().by_state, { pending: 1 });
});

test('completion-gated admission treats configured concurrency as a ceiling', async () => {
  const queue = createUnitQueue({ units: units(6) });
  const seen = [];
  const workers = new Set();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const running = runQueue({
    queue, concurrency: 4, initial_worker_concurrency: 1,
    process: async (unit, worker) => {
      seen.push(unit.id);
      workers.add(worker);
      if (unit.id === 'u1') await firstGate;
      return { outcome: 'ok' };
    },
  });
  while (!seen.length) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['u1'], 'later workers wait for a completed admission sample');
  releaseFirst();
  await running;
  assert.equal(queue.status().by_state.done, 6);
  assert.ok(workers.size > 1, 'the ceiling opens after successful completions');
});

test('initial worker concurrency rejects values outside the configured ceiling', async () => {
  const queue = createUnitQueue({ units: units(1) });
  await assert.rejects(
    runQueue({ queue, concurrency: 2, initial_worker_concurrency: 3, process: async () => ({ outcome: 'ok' }) }),
    error => error.code === 'INVALID_INITIAL_WORKER_CONCURRENCY',
  );
  assert.deepEqual(queue.status().by_state, { pending: 1 });
});
