import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { serializeFlatRelationAnswer } from '../tools/flat-relation-lines.mjs';
import { installGracefulStop } from '../tools/graceful-stop.mjs';
import { runWideContextExtraction } from '../tools/wide-context-extractor.mjs';
import { CheckpointTelemetry, loadWideContextTelemetryContext } from '../tools/checkpoint-telemetry.mjs';
import {
  buildRunnerCommand, classifyRunnerCompletion, hostPreflight, resumeOutputState,
  shouldRequestSoftLoadPause, updateLoadAudit,
} from '../tools/tui-run-controller.mjs';

const bounds = {
  window_bytes: 48 * 1024, overlap_bytes: 4096, max_claims_per_unit: 64,
  max_calls: 10, max_known_cost_usd: 2, max_unpriced_attempts: 0,
  call_timeout_ms: 600000, max_answer_bytes: 1048576, max_event_bytes: 67108864,
};

function fakeRunner({ onCall = null, firstProviderFailure = false } = {}) {
  const calls = [];
  return {
    kind: 'fake', model: 'fake/extract',
    async complete({ prompt, tag }) {
      if (firstProviderFailure && calls.length === 0) {
        calls.push({ tag, model: this.model, outcome: 'error:provider', cost: 0, calls: 1, billing_status: 'not_billable' });
        onCall?.(calls.length);
        return { text: '', json: null, outcome: 'error:provider', model: this.model, usage: { cost: 0 }, accepted: true, billing_status: 'not_billable' };
      }
      const match = /\[(b\d{3}) PRIMARY ([^:]+):\d+-\d+\][^\n]*\n([^\n]+)/.exec(prompt);
      assert.ok(match, 'prompt exposes a primary source block');
      const occurrence = prompt.split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(row => row?.subject_occurrence);
      assert.ok(occurrence, 'prompt exposes a subject occurrence');
      const source = occurrence.surface;
      calls.push({ tag, model: this.model, outcome: 'ok', cost: 0.01, calls: 1, billing_status: 'reported' });
      onCall?.(calls.length);
      const locator = { block_token: occurrence.block, quote: source, occurrence: occurrence.occurrence };
      const text = serializeFlatRelationAnswer({ claims: [{
        subject_mention: { surface: source, source_locator: locator },
        subject_binding: 'explicit', subject_occurrence: occurrence.subject_occurrence,
        relation_family: 'other',
        predicate_family: 'states', object_or_value: 'a test fact', polarity: 'affirmed',
        modality: 'descriptive', quantifier: 'one', scope: {}, valid_time: {},
        support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: locator }] }],
      }] });
      return { text, outcome: 'ok', model: this.model, usage: { cost: 0.01 }, accepted: true, billing_status: 'reported' };
    },
    stats() {
      return { kind: 'fake', calls: calls.length, cost: calls.reduce((sum, call) => sum + call.cost, 0), unpriced_attempts: 0, per_call: calls.slice() };
    },
    count: () => calls.length,
  };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-controller-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const estate = path.join(dir, 'estate');
  await fs.mkdir(estate);
  const documents = [
    { path: 'a.md', content: '# A\n\nAlpha is enabled.\n' },
    { path: 'b.md', content: '# B\n\nBeta is enabled.\n' },
    { path: 'c.md', content: '# C\n\nGamma is enabled.\n' },
  ];
  for (const row of documents) await fs.writeFile(path.join(estate, row.path), row.content);
  const manifest = {
    schema: 'estate-map/wide-context-manifest/v1', source_sha: 'fixture-sha', documents: documents.map(({ path: file }) => ({ path: file })),
    models: { extraction: 'fake/extract', extraction_thinking: null }, bounds,
  };
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { dir, estate, documents, manifestPath, snapshot: { source_sha: 'fixture-sha', corpus_digest: 'fixture-digest' } };
}

test('host preflight is proportional to CPUs and fails closed above its threshold', () => {
  assert.deepEqual(hostPreflight({ load1: 3, cpuCount: 8 }), {
    pass: true, load_1m: 3, cpu_count: 8, max_load_1m: 6, utilization: 0.375,
  });
  assert.equal(hostPreflight({ load1: 6.01, cpuCount: 8 }).pass, false);
  assert.equal(hostPreflight({ load1: 4.01, cpuCount: 64, maxLoad: 4 }).pass, false);
});

test('soft load pause is distinct from the sustained hard circuit', () => {
  const high = hostPreflight({ load1: 49, cpuCount: 64, maxLoad: 48 });
  assert.equal(shouldRequestSoftLoadPause({ running: true, softPreflight: high }), true);
  assert.equal(shouldRequestSoftLoadPause({ running: false, softPreflight: high }), false);
  assert.equal(shouldRequestSoftLoadPause({ running: true, pauseRequested: true, softPreflight: high }), false);
  assert.equal(shouldRequestSoftLoadPause({ running: true, hardCircuit: true, softPreflight: high }), false);
  assert.equal(shouldRequestSoftLoadPause({
    running: true, softPreflight: hostPreflight({ load1: 48, cpuCount: 64, maxLoad: 48 }),
  }), false);
});

test('load audit persists a sparse trajectory, peak, and circuit evidence', () => {
  const first = updateLoadAudit(null, hostPreflight({ load1: 3, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:00.000Z', minSampleIntervalMs: 5000,
  });
  const unsampled = updateLoadAudit(first, hostPreflight({ load1: 4, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:01.000Z', minSampleIntervalMs: 5000,
  });
  assert.equal(unsampled.sample_count, 1);
  assert.equal(unsampled.peak_load_1m, 4);
  const circuit = updateLoadAudit(unsampled, hostPreflight({ load1: 6.5, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:02.000Z', circuit: true, minSampleIntervalMs: 5000,
  });
  assert.equal(circuit.sample_count, 2);
  assert.equal(circuit.circuit_events.length, 1);
  assert.equal(circuit.peak_load_1m, 6.5);
});

test('load circuit ignores one transient excursion and opens on sustained sampled overload', () => {
  const ready = updateLoadAudit(null, hostPreflight({ load1: 3, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:00.000Z', armCircuit: true, minSampleIntervalMs: 5000,
  });
  const transient = updateLoadAudit(ready, hostPreflight({ load1: 7, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:05.000Z', armCircuit: true, minSampleIntervalMs: 5000,
  });
  assert.equal(transient.overload_streak, 1);
  assert.equal(transient.overload_pending, true);
  assert.equal(transient.circuit_events.length, 0);
  const recovered = updateLoadAudit(transient, hostPreflight({ load1: 5, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:06.000Z', armCircuit: true, minSampleIntervalMs: 5000,
  });
  assert.equal(recovered.overload_streak, 0);
  assert.equal(recovered.sample_count, 2, 'a sub-sample recovery resets the streak without fabricating a sample');
  const highAgain = updateLoadAudit(recovered, hostPreflight({ load1: 7, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:10.000Z', armCircuit: true, minSampleIntervalMs: 5000,
  });
  const sustained = updateLoadAudit(highAgain, hostPreflight({ load1: 6.5, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:15.000Z', armCircuit: true, minSampleIntervalMs: 5000,
  });
  assert.equal(sustained.overload_streak, 2);
  assert.equal(sustained.circuit_opened, true);
  assert.equal(sustained.circuit_events.length, 1);
  assert.equal(sustained.circuit_events[0].required_samples, 2);
  const afterRecovery = updateLoadAudit(sustained, hostPreflight({ load1: 5, cpuCount: 8, maxLoad: 6 }), {
    at: '2026-08-04T00:00:20.000Z', armCircuit: false, minSampleIntervalMs: 5000,
  });
  assert.equal(afterRecovery.overload_streak, 0);
  assert.equal(afterRecovery.circuit_opened, true, 'an opened circuit remains an auditable fact after load recovers');
  assert.equal(afterRecovery.circuit_events.length, 1, 'a sticky circuit does not duplicate its opening event');
});

test('controller builds explicit child argv without a shell or pattern-matched process target', () => {
  const built = buildRunnerCommand({
    job: 'extraction', manifest: 'm.json', bounds: 'b.json', checkpoint: 'c.jsonl',
    output: 'o.json', estate: 'estate', 'window-ids': 'w.json', concurrency: '4', 'max-cost': '3',
    contract: 'v8', 'worker-start-delay-ms': '5000', 'initial-worker-concurrency': '2',
  }, { cwd: '/tmp/repo' });
  assert.equal(built.command, process.execPath);
  assert.ok(built.args.includes('/tmp/repo/c.jsonl'));
  assert.ok(built.args.includes('/tmp/repo/w.json'));
  assert.deepEqual(built.args.slice(built.args.indexOf('--contract'), built.args.indexOf('--contract') + 2), ['--contract', 'v8']);
  assert.deepEqual(
    built.args.slice(built.args.indexOf('--worker-start-delay-ms'), built.args.indexOf('--worker-start-delay-ms') + 2),
    ['--worker-start-delay-ms', '5000'],
  );
  assert.deepEqual(
    built.args.slice(built.args.indexOf('--initial-worker-concurrency'), built.args.indexOf('--initial-worker-concurrency') + 2),
    ['--initial-worker-concurrency', '2'],
  );
  assert.equal(built.args.some(arg => /pkill|killall/.test(arg)), false);
});

test('resume replaces only a non-final output and refuses a completed artifact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-controller-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output.json');
  assert.equal(await resumeOutputState(output), 'missing');
  await fs.writeFile(output, JSON.stringify({ status: 'incomplete' }));
  assert.equal(await resumeOutputState(output), 'replaceable_nonfinal');
  await fs.writeFile(output, JSON.stringify({ status: 'paused' }));
  assert.equal(await resumeOutputState(output), 'replaceable_nonfinal');
  await fs.writeFile(output, JSON.stringify({ status: 'complete' }));
  assert.equal(await resumeOutputState(output), 'complete');
});

test('controller completion classification follows artifact lifecycle instead of child exit zero', () => {
  assert.deepEqual(classifyRunnerCompletion({
    code: 0,
    artifact: { status: 'complete', queue: { by_state: { done: 3 } } },
  }), {
    classification: 'complete', controller_code: 0, message: 'run completed',
    artifact_status: 'complete', pending_units: 0, quarantined_units: 0,
  });
  assert.deepEqual(classifyRunnerCompletion({
    code: 0, pauseRequested: true,
    artifact: { status: 'incomplete', queue: { by_state: { done: 1, quarantined: 1, pending: 2 } } },
  }), {
    classification: 'paused', controller_code: 75,
    message: 'run paused with 2 unit(s) pending; resume is safe',
    artifact_status: 'incomplete', pending_units: 2, quarantined_units: 1,
  });
  assert.deepEqual(classifyRunnerCompletion({
    code: 0,
    artifact: { status: 'incomplete', queue: { by_state: { done: 2, quarantined: 1 } } },
  }), {
    classification: 'failed', controller_code: 2,
    message: 'run finished incomplete with 1 quarantined unit(s)',
    artifact_status: 'incomplete', pending_units: 0, quarantined_units: 1,
  });
  assert.equal(classifyRunnerCompletion({ code: 0 }).classification, 'failed');
  assert.equal(classifyRunnerCompletion({ code: 75 }).classification, 'paused');
});

test('signal handling exposes one idempotent cooperative stop request', () => {
  const emitter = new EventEmitter();
  const stop = installGracefulStop({ emitter });
  emitter.emit('SIGINT');
  emitter.emit('SIGTERM');
  assert.equal(stop.signal.aborted, true);
  assert.equal(stop.signal.reason, 'SIGINT');
  stop.dispose();
  assert.equal(emitter.listenerCount('SIGINT'), 0);
  assert.equal(emitter.listenerCount('SIGTERM'), 0);
});

test('cooperative pause drains the paid unit in flight and resumes without repurchasing it', async t => {
  const held = await fixture(t);
  const checkpointPath = path.join(held.dir, 'checkpoint.jsonl');
  const controller = new AbortController();
  const firstRunner = fakeRunner({ onCall: () => controller.abort('operator pause') });
  const first = await runWideContextExtraction({
    documents: held.documents, snapshot: held.snapshot, bounds, checkpointPath,
    model: firstRunner.model, concurrency: 1, runnerFactory: () => firstRunner, signal: controller.signal,
  });
  assert.equal(first.status, 'paused');
  assert.equal(firstRunner.count(), 1);
  assert.deepEqual(first.queue.by_state, { done: 1, pending: 2 });

  const secondRunner = fakeRunner();
  const second = await runWideContextExtraction({
    documents: held.documents, snapshot: held.snapshot, bounds, checkpointPath,
    model: secondRunner.model, concurrency: 1, runnerFactory: () => secondRunner,
  });
  assert.equal(second.status, 'complete');
  assert.equal(secondRunner.count(), 2, 'the completed pre-pause unit is replayed from custody');
  assert.equal(second.budget.accounted_calls, 3);
  const rows = (await fs.readFile(checkpointPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.stage === 'wide-context-started').length, 3);
  assert.equal(rows.filter(row => row.stage === 'wide-context-completion').length, 3);
  assert.equal(rows.filter(row => row.stage === 'wide-context-started')
    .every(row => typeof row.value.started_at === 'string'
      && row.value.receipt_context?.worker_id != null), true,
  'new start receipts carry timestamped worker custody');
  assert.equal(rows.filter(row => row.stage === 'wide-context-completion')
    .every(row => typeof row.value.completed_at === 'string'
      && row.value.receipt_context?.worker_id != null), true,
  'new completion receipts carry timestamped worker custody');
});

test('live telemetry derives spend, claims, and rejection histogram from checkpoint bytes', async t => {
  const held = await fixture(t);
  const checkpointPath = path.join(held.dir, 'checkpoint.jsonl');
  const context = await loadWideContextTelemetryContext({ manifestPath: held.manifestPath, estateRoot: held.estate });
  assert.equal(context.contract, 'v10');
  const runner = fakeRunner();
  await runWideContextExtraction({
    documents: held.documents, snapshot: context.snapshot, bounds, checkpointPath,
    model: runner.model, concurrency: 1, runnerFactory: () => runner,
  });
  const telemetry = new CheckpointTelemetry({ context, maxKnownCostUsd: 2 });
  await telemetry.refresh(checkpointPath);
  const snapshot = telemetry.snapshot({ running: false, plannedUnits: 3 });
  assert.equal(snapshot.units.started, 3);
  assert.equal(snapshot.units.completed, 3);
  assert.equal(snapshot.units.orphaned_started, 0);
  assert.equal(snapshot.budget.known_cost_usd, 0.03);
  assert.equal(snapshot.budget.cap_remaining_usd, 1.97);
  assert.equal(snapshot.claims.promoted, 3);
  assert.equal(snapshot.claims.rejected, 0);
  assert.deepEqual(snapshot.claims.rejection_codes, []);
  await telemetry.refresh(checkpointPath);
  assert.equal(telemetry.snapshot().units.completed, 3, 'incremental refresh does not double-count');
});

test('controller telemetry supports byte-identical V24/V25 prompts and the prospective V25 identity', async t => {
  const held = await fixture(t);
  const [v20, v24, v25] = await Promise.all([
    loadWideContextTelemetryContext({
      manifestPath: held.manifestPath, estateRoot: held.estate, contract: 'v20',
    }),
    loadWideContextTelemetryContext({
      manifestPath: held.manifestPath, estateRoot: held.estate, contract: 'v24',
    }),
    loadWideContextTelemetryContext({
      manifestPath: held.manifestPath, estateRoot: held.estate, contract: 'v25',
    }),
  ]);
  assert.equal(v24.contract, 'v24');
  assert.equal(v25.contract, 'v25');
  assert.deepEqual(
    [...v24.windows.values()].map(row => row.promptDigest).sort(),
    [...v20.windows.values()].map(row => row.promptDigest).sort(),
    'controller telemetry retains the frozen V20 model-visible prompt bytes',
  );
  assert.deepEqual(
    [...v25.windows.values()].map(row => row.promptDigest).sort(),
    [...v24.windows.values()].map(row => row.promptDigest).sort(),
    'V25 changes runtime custody identity without changing V24 model-visible prompt bytes',
  );

  const checkpointPath = path.join(held.dir, 'v25.jsonl');
  const runner = fakeRunner();
  const result = await runWideContextExtraction({
    documents: held.documents, snapshot: v25.snapshot, bounds, checkpointPath,
    model: runner.model, concurrency: 1, runnerFactory: () => runner, contract: 'v25',
  });
  assert.equal(result.extraction_contract, 'v25');
  assert.equal(result.extractor, 'wide-context-extractor@25-provider-observability');
  assert.equal(result.extractor_runtime, 'wide-context-runtime@12-observable-lifecycle');
  const telemetry = new CheckpointTelemetry({ context: v25, maxKnownCostUsd: 2 });
  await telemetry.refresh(checkpointPath);
  const snapshot = telemetry.snapshot({ plannedUnits: 3 });
  assert.equal(snapshot.claims.promoted, result.metrics.promoted_claims,
    'controller and final V25 validation promote the same count');
  assert.equal(snapshot.claims.rejected, result.metrics.rejected_claims,
    'controller and final V25 validation reject the same count');
});

test('V26 retries one explicit provider failure and telemetry counts logical units separately from attempts', async t => {
  const held = await fixture(t);
  const [v24, v26] = await Promise.all([
    loadWideContextTelemetryContext({
      manifestPath: held.manifestPath, estateRoot: held.estate, contract: 'v24',
    }),
    loadWideContextTelemetryContext({
      manifestPath: held.manifestPath, estateRoot: held.estate, contract: 'v26',
    }),
  ]);
  assert.deepEqual(
    [...v26.windows.values()].map(row => row.promptDigest).sort(),
    [...v24.windows.values()].map(row => row.promptDigest).sort(),
    'V26 changes attempt custody without changing the frozen semantic contract',
  );
  const checkpointPath = path.join(held.dir, 'v26.jsonl');
  const v26Bounds = {
    ...bounds,
    max_calls: 6,
    cost_reserve_per_call_usd: 0.1,
    max_attempts_per_unit: 2,
    retryable_outcomes: ['error:provider'],
    retry_backoff_ms: 0,
    retry_backoff_max_ms: 0,
    retry_jitter_ratio: 0,
  };
  const runner = fakeRunner({ firstProviderFailure: true });
  const result = await runWideContextExtraction({
    documents: held.documents, snapshot: v26.snapshot, bounds: v26Bounds, checkpointPath,
    model: runner.model, concurrency: 1, runnerFactory: () => runner, contract: 'v26',
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.extractor, 'wide-context-extractor@26-materialized-retry-ledger');
  assert.equal(result.extractor_runtime, 'wide-context-runtime@13-materialized-attempt-ledger');
  assert.equal(result.inference.custody_policy, 'content-addressed-materialization-attempt-ledger@1');
  assert.equal(result.budget.accounted_calls, 4);
  assert.equal(result.materialization.logical_units, 3);
  assert.equal(result.materialization.selected_units, 3);
  assert.equal(result.materialization.attempts, 4);
  assert.equal(result.materialization.retries, 1);
  assert.equal(result.materialization.recovered_after_retry, 1);
  assert.deepEqual(result.materialization.outcome_histogram, [['error:provider', 1], ['ok', 3]]);

  const telemetry = new CheckpointTelemetry({ context: v26, maxKnownCostUsd: 2 });
  await telemetry.refresh(checkpointPath);
  const live = telemetry.snapshot({ plannedUnits: 3 });
  assert.equal(live.units.started, 3);
  assert.equal(live.units.completed, 3);
  assert.equal(live.attempts.started, 4);
  assert.equal(live.attempts.completed, 4);
  assert.equal(live.attempts.retry_schedules, 1);
  assert.equal(live.attempts.recovered, 1);
  assert.equal(live.budget.accounted_calls, 4);
  assert.equal(live.claims.promoted, result.metrics.promoted_claims,
    'the failed attempt is spend evidence, not a second logical claim result');

  const replayRunner = fakeRunner();
  const replay = await runWideContextExtraction({
    documents: held.documents, snapshot: v26.snapshot, bounds: v26Bounds, checkpointPath,
    model: replayRunner.model, concurrency: 1, runnerFactory: () => replayRunner, contract: 'v26',
  });
  assert.equal(replayRunner.count(), 0, 'selected materializations replay without another provider call');
  assert.equal(replay.budget.accounted_calls, 4);
  assert.equal(replay.materialization.recovered_after_retry, 1);
});

test('V26 refuses an underfunded retry envelope before creating a runner or checkpoint', async t => {
  const held = await fixture(t);
  const checkpointPath = path.join(held.dir, 'underfunded-v26.jsonl');
  let runnerFactories = 0;
  await assert.rejects(
    runWideContextExtraction({
      documents: held.documents, snapshot: held.snapshot,
      bounds: {
        ...bounds,
        max_calls: 5,
        cost_reserve_per_call_usd: 0.1,
        max_attempts_per_unit: 2,
        retryable_outcomes: ['error:provider'],
      },
      checkpointPath, model: 'fake/extract', concurrency: 1, contract: 'v26',
      runnerFactory: () => { runnerFactories += 1; return fakeRunner(); },
    }),
    error => error.code === 'RETRY_CALL_CAP_INSUFFICIENT'
      && error.detail?.required_calls === 6,
  );
  assert.equal(runnerFactories, 0);
  await assert.rejects(fs.stat(checkpointPath), error => error.code === 'ENOENT');
});
