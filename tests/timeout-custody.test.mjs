import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeModelRunner } from '../tools/neural-census-producers.mjs';
import { createPiRpcRunner } from '../tools/neural-model-runner.mjs';
import { combineModelStats, modelStatsDelta, modelStatsSnapshot } from '../tools/model-usage.mjs';
import { callModel } from '../tools/campaign.mjs';

function timeoutRunner() {
  let calls = 0;
  return {
    model: 'mock/timeout',
    async complete() {
      calls += 1;
      return {
        text: '', json: null, outcome: 'timeout', accepted: true,
        billing_status: 'accepted_usage_unknown', usage: { cost: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    },
    callCount: () => calls,
  };
}

function fakeTransport({ withUsage }) {
  return () => {
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          if (withUsage) emit({
            type: 'message_end',
            message: {
              role: 'assistant', model: 'mock/rpc', stopReason: null,
              content: [{ type: 'text', text: '{"partial":true}' }],
              usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } },
            },
          });
          // Deliberately no agent_end: turn reaches timeout after provider acceptance.
        });
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

function oversizedOutputTransport(counter) {
  return () => {
    counter.processes += 1;
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          emit({ type: 'agent_end', padding: 'x'.repeat(1_000), messages: [{ role: 'assistant', model: 'mock/rpc', stopReason: null, content: [{ type: 'text', text: '{"ok":true}' }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.01 } } }] });
        });
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

function verboseStreamingTransport() {
  return () => {
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          for (let i = 0; i < 10; i += 1) emit({ type: 'message_update', payload: 'x'.repeat(5_000) });
          emit({ type: 'agent_end', messages: [{ role: 'assistant', model: 'mock/rpc', stopReason: null, content: [{ type: 'text', text: '{"ok":true}' }], usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0.02 } } }] });
        });
        if (command.type === 'new_session') queueMicrotask(() => emit({ type: 'response', command: 'new_session', id: command.id, success: true, data: {} }));
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

function crashAfterWriteTransport(counter) {
  return () => {
    counter.processes += 1;
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const listener of [...closeListeners]) listener({ reason: 'simulated crash' });
    };
    return {
      get closed() { return closed; },
      write(command) { if (command.type === 'prompt') queueMicrotask(close); },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {}, close: async () => close(),
    };
  };
}

function largeAnswerTransport() {
  return () => {
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          emit({ type: 'agent_end', messages: [{ role: 'assistant', model: 'mock/rpc', stopReason: null, content: [{ type: 'text', text: 'x'.repeat(1_000) }], usage: { input: 4, output: 1_000, totalTokens: 1_004, cost: { total: 0.1 } } }] });
        });
        if (command.type === 'new_session') queueMicrotask(() => emit({ type: 'response', command: 'new_session', id: command.id, success: true, data: {} }));
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

function unparseableTransport(counter) {
  return () => {
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          counter.prompts += 1;
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          emit({ type: 'agent_end', messages: [{ role: 'assistant', model: 'mock/rpc', stopReason: null, content: [{ type: 'text', text: 'not json' }], usage: { input: 4, output: 2, totalTokens: 6, cost: { total: 0.1 } } }] });
        });
        if (command.type === 'new_session') queueMicrotask(() => emit({ type: 'response', command: 'new_session', id: command.id, success: true, data: {} }));
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

function providerErrorTransport() {
  return () => {
    const lineListeners = new Set(), closeListeners = new Set();
    let closed = false;
    const emit = event => { const raw = JSON.stringify(event); for (const listener of [...lineListeners]) listener(event, raw); };
    return {
      get closed() { return closed; },
      write(command) {
        if (command.type === 'prompt') queueMicrotask(() => {
          emit({ type: 'response', command: 'prompt', id: command.id, success: true });
          emit({ type: 'agent_end', messages: [{
            role: 'assistant', model: 'mock/rpc', stopReason: 'error',
            errorMessage: `provider_transport_failure:${'x'.repeat(4_000)}`,
            content: [{ type: 'text', text: '{"partial":' }],
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
          }] });
        });
        if (command.type === 'new_session') queueMicrotask(() => emit({ type: 'response', command: 'new_session', id: command.id, success: true, data: {} }));
      },
      onLine(listener) { lineListeners.add(listener); return () => lineListeners.delete(listener); },
      onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
      kill() {},
      async close() { if (closed) return; closed = true; for (const listener of [...closeListeners]) listener({ reason: 'closed' }); },
    };
  };
}

test('oversized prompt refuses before model dispatch', async () => {
  let calls = 0;
  await assert.rejects(
    callModel({ model: 'mock/oversized', prompt: 'x'.repeat(128 * 1024 + 1), runner: async () => { calls += 1; return {}; } }),
    error => error?.code === 'INFERENCE_PROMPT_TOO_LARGE',
  );
  assert.equal(calls, 0);
});

test('direct campaign invocation suppresses unsafe retry requests', async () => {
  let calls = 0;
  const result = await callModel({
    model: 'mock/direct', prompt: 'paid prompt', maxAttempts: 3,
    runner: async () => {
      calls += 1;
      return { text: 'not json', outcome: 'ok', accepted: true, usage: { cost: 0.2, cost_reported: true, input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'ok:unparseable');
  assert.equal(result.attempts, 1);
  assert.equal(result.retry_policy, 'unsafe-retry-request-suppressed');
  assert.equal(result.billing_status, 'reported');
});

test('reported tokens without a reported price remain explicitly unpriced', async () => {
  const result = await callModel({
    model: 'mock/unpriced', prompt: 'paid prompt',
    runner: async () => ({ text: '{"ok":true}', outcome: 'ok', accepted: true, usage: { cost: 0, input_tokens: 2, output_tokens: 1, total_tokens: 3 } }),
  });
  assert.equal(result.billing_status, 'usage_reported_cost_unknown');
});

test('accepted timeout is never automatically retried even when callRetries is nonzero', async () => {
  const runner = timeoutRunner();
  const result = await invokeModelRunner(runner, { prompt: 'paid prompt', tag: 'timeout' }, { callRetries: 2 });
  assert.equal(runner.callCount(), 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.retry_policy, 'accepted-timeout-retry-suppressed');
  assert.equal(result.billing_status, 'accepted_usage_unknown');
});

test('verbose nonterminal reasoning events are not retained as semantic output', async t => {
  const runner = createPiRpcRunner({ model: 'mock/rpc', maxOutputBytes: 1_000, transportFactory: verboseStreamingTransport() });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'verbose-stream' });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.usage.cost, 0.02);
});

test('oversized RPC output aborts once and remains explicitly unpriced', async t => {
  const counter = { processes: 0 };
  const runner = createPiRpcRunner({ model: 'mock/rpc', maxCallRestarts: 2, maxOutputBytes: 200, transportFactory: oversizedOutputTransport(counter) });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'overflow' });
  assert.equal(result.outcome, 'output_limit');
  assert.equal(result.accepted, true);
  assert.equal(result.billing_status, 'accepted_usage_unknown');
  assert.equal(counter.processes, 1);
  assert.ok(result.output_bytes > result.max_output_bytes);
  assert.equal(runner.stats().cost_status, 'lower_bound');
});

test('post-write crash without an acceptance event is unknown and never retried', async t => {
  const counter = { processes: 0 };
  const runner = createPiRpcRunner({ model: 'mock/rpc', maxCallRestarts: 2, transportFactory: crashAfterWriteTransport(counter) });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'crash' });
  assert.equal(result.outcome, 'timeout:process_crash');
  assert.equal(result.accepted, null);
  assert.equal(result.billing_status, 'acceptance_unknown');
  assert.equal(counter.processes, 1);
  assert.equal(runner.stats().unpriced_attempts, 1);
});

test('semantic answer cap is separate from verbose transport-event cap', async t => {
  const runner = createPiRpcRunner({ model: 'mock/rpc', maxOutputBytes: 64 * 1024, maxAnswerBytes: 100, transportFactory: largeAnswerTransport() });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'large-answer' });
  assert.equal(result.outcome, 'output_limit');
  assert.equal(result.answer_bytes, 1_000);
  assert.equal(result.max_answer_bytes, 100);
  assert.equal(result.billing_status, 'reported_partial');
  assert.equal(result.usage.cost, 0.1);
});

test('accepted unparseable answer is persisted rather than automatically repurchased', async t => {
  const counter = { prompts: 0 };
  const runner = createPiRpcRunner({ model: 'mock/rpc', maxCallRestarts: 2, transportFactory: unparseableTransport(counter) });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'unparseable' });
  assert.equal(result.outcome, 'ok:unparseable');
  assert.equal(counter.prompts, 1);
  assert.equal(runner.stats().calls, 1);
  assert.equal(runner.stats().cost, 0.1);
});

test('provider stop reason and bounded error detail survive the RPC result boundary', async t => {
  const runner = createPiRpcRunner({ model: 'mock/rpc', transportFactory: providerErrorTransport() });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'provider-error' });
  assert.equal(result.outcome, 'error:provider');
  assert.equal(result.accepted, true);
  assert.equal(result.billing_status, 'reported');
  assert.equal(result.provider_stop_reason, 'error');
  assert.match(result.provider_error_message, /^provider_transport_failure:/);
  assert.ok(result.provider_error_message.endsWith('…'));
  assert.equal(result.provider_error_message.length, 2048);
});

test('RPC timeout salvages partial usage and marks reported cost', async t => {
  const runner = createPiRpcRunner({
    model: 'mock/rpc', timeoutMs: 20, maxCallRestarts: 0,
    transportFactory: fakeTransport({ withUsage: true }),
  });
  t.after(() => runner.shutdown());
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'partial' });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.accepted, true);
  assert.equal(result.billing_status, 'reported_partial');
  assert.equal(result.usage.cost, 0.25);
  assert.equal(result.usage.total_tokens, 15);
  const stats = runner.stats();
  assert.equal(stats.calls, 1);
  assert.equal(stats.cost, 0.25);
  assert.equal(stats.cost_status, 'complete');
  assert.equal(stats.unpriced_attempts, 0);
});

test('RPC accepted timeout without usage is explicit lower-bound spend', async t => {
  const runner = createPiRpcRunner({
    model: 'mock/rpc', timeoutMs: 20, maxCallRestarts: 0,
    transportFactory: fakeTransport({ withUsage: false }),
  });
  t.after(() => runner.shutdown());
  const before = modelStatsSnapshot(runner);
  const result = await runner.complete({ prompt: 'paid prompt', tag: 'unknown' });
  const delta = modelStatsDelta(before, modelStatsSnapshot(runner), runner.model);
  const combined = combineModelStats([delta], runner.model);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.accepted, true);
  assert.equal(result.billing_status, 'accepted_usage_unknown');
  const stats = runner.stats();
  assert.equal(stats.calls, 1);
  assert.equal(stats.cost, 0);
  assert.equal(stats.cost_status, 'lower_bound');
  assert.equal(stats.unpriced_attempts, 1);
  assert.equal(delta.cost_status, 'lower_bound');
  assert.equal(delta.unpriced_attempts, 1);
  assert.equal(combined.cost_status, 'lower_bound');
  assert.equal(combined.unpriced_attempts, 1);
});
