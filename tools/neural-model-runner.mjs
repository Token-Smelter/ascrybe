// Clean ModelRunner interface for the documentation-claim census NEURAL path (slice 4 of
// intent-779029e6, DESIGN §16.12.1). This is the first slice that invokes a model.
//
// A ModelRunner is any object exposing:
//     async complete({ prompt, tag }) -> { text, json?, usage:{cost,input_tokens,output_tokens}, model, outcome }
//     model  (string)  — the model identifier the runner drives
//     kind   (string)  — 'pi-cli' | 'mock'
//     stats() -> { kind, calls, cost, models:[...], per_call:[...] }
//
// TWO runners ship:
//   - createPiModelRunner: the REAL in-environment path. It is grounded in the landed campaign
//     invocation mechanism (tools/estate-map/campaign.mjs `callModel`, which spawns the `pi` CLI
//     with `--model … -p … --no-tools --no-session --mode json`). It requests one accepted attempt;
//     automatic paid retries are forbidden at this boundary. We do NOT re-invent that spawn;
//     we reuse the exact landed function via a LAZY import, so importing this module (e.g. from a
//     unit test) pulls in NONE of the spawn machinery and can never accidentally call a model.
//   - createMockModelRunner: a deterministic, ZERO-SPEND runner for tests. Tests inject it so the
//     ordinary build + the unit-test suite make no real model call.
//
// Model strings route through the `a routed gateway` the routed gateway gateway (never `anthropic/*`), matching
// the prior campaign roster (campaign.mjs PROPOSER_MODEL). anthropic/* is refused fail-closed here.
import { parseCensusModelJson } from './neural-json.mjs';
import {
  assertInferencePromptWithinLimit,
  classifyBillingStatus as billingStatus,
  DEFAULT_MAX_INFERENCE_ANSWER_BYTES,
  DEFAULT_MAX_INFERENCE_EVENT_BYTES,
  emptyInferenceUsage as emptyUsage,
  summarizeInferenceCalls as summarizeCalls,
} from './inference-custody.mjs';

// No default model. A stage's model is configuration, and a constant here would be a silent
// substitute for a decision nobody made -- the same shape as an unset reasoning level letting a
// provider choose, which multiplied a corpus run's cost by five. A caller that does not name a
// model gets a refusal, not a guess.
export function requireModel(name, role = 'model') {
  const held = String(name ?? '').trim();
  if (!held) {
    const error = new Error(`${role} requires a model name from configuration; there is no default`);
    error.code = 'ASCRYBE_MODEL_UNCONFIGURED';
    throw error;
  }
  return held;
}

export class ModelRunnerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ModelRunnerError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The REAL runner. Grounded in the landed Pi-CLI invocation path: it reuses campaign.mjs `callModel`
 * (single accepted attempt + timeout + JSONL parse), imported LAZILY so this file has no import-time dependency
 * on the spawn machinery. Reachable only when a census invocation explicitly constructs it.
 */
// Per-call timeout default is 180s. Accepted timeouts are terminal, so prompt/region sizing must
// keep ordinary completions comfortably below this ceiling. Configurable via --call-timeout-ms.
export const DEFAULT_CALL_TIMEOUT_MS = 180000;
export function createPiModelRunner({ model = null, thinking = null, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, scratchDir = null, maxAttempts = 1, maxOutputBytes = DEFAULT_MAX_INFERENCE_EVENT_BYTES, maxAnswerBytes = DEFAULT_MAX_INFERENCE_ANSWER_BYTES } = {}) {
  requireModel(model, 'createPiModelRunner');
  const id = String(model || '').trim();
  if (!id) throw new ModelRunnerError('MISSING_MODEL', 'createPiModelRunner requires a model identifier');
  if (/^anthropic\//.test(id)) {
    throw new ModelRunnerError('FORBIDDEN_MODEL', `model "${id}" is a forbidden anthropic/* model; route opus via the a routed gateway the routed gateway gateway`, { model: id });
  }
  let callModelImpl = null;
  const per_call = [];
  return {
    kind: 'pi-cli',
    model: id,
    async complete({ prompt, tag = 'neural-census' } = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new ModelRunnerError('MISSING_PROMPT', 'complete requires a non-empty prompt');
      if (!callModelImpl) ({ callModel: callModelImpl } = await import('./campaign.mjs'));
      const res = await callModelImpl({ model: id, prompt, thinking, timeoutMs, scratchDir, tag, maxAttempts, maxOutputBytes, maxAnswerBytes });
      const usage = { ...emptyUsage(), ...(res.usage || {}) };
      const accepted = Object.hasOwn(res, 'accepted') ? res.accepted : !/spawn_error|process_unavailable/i.test(String(res.outcome || ''));
      const billing_status = res.billing_status || billingStatus({ outcome: res.outcome, usage, accepted });
      per_call.push({ tag, model: res.model || id, outcome: res.outcome, accepted, billing_status, cost: Number(usage.cost || 0), cost_reported: usage.cost_reported === true, input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), total_tokens: Number(usage.total_tokens || 0), latency_ms: Number(res.latency_ms || 0) });
      return { text: res.text || '', json: res.json ?? parseCensusModelJson(res.text || ''), usage, model: res.model || id, outcome: res.outcome, accepted, billing_status, attempts: res.attempts ?? 1, retry_policy: res.retry_policy ?? 'single-attempt' };
    },
    stats() { return summarizeCalls(per_call, 'pi-cli'); },
  };
}

// Bounded restarts apply only before prompt dispatch (spawn/connect/write failure). Once a prompt
// may have left this process, timeout/crash/provider/content failure is terminal and recorded;
// silently repeating accepted inference can multiply spend while hiding it from usage accounting.
export const DEFAULT_RPC_MAX_CALL_RESTARTS = 2;
export const DEFAULT_RPC_NEW_SESSION_TIMEOUT_MS = 15000;
export const MAX_PROVIDER_DIAGNOSTIC_CHARS = 2048;
export const PI_RPC_RUNNER_IMPLEMENTATION = 'neural-model-runner/pi-rpc@2-provider-diagnostics';

function boundedProviderDiagnostic(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= MAX_PROVIDER_DIAGNOSTIC_CHARS
    ? text : `${text.slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS - 1)}…`;
}

function providerDiagnostics(parsed) {
  return Object.freeze({
    provider_stop_reason: boundedProviderDiagnostic(parsed?.stopReason),
    provider_error_message: boundedProviderDiagnostic(parsed?.errorMessage),
  });
}

/**
 * The PERSISTENT RPC runner (slice 4d). A drop-in ModelRunner that holds ONE warm
 * `pi --mode rpc --model <id> --no-tools --no-context-files --no-extensions --no-skills` process,
 * eliminating the per-call cold-start (~40s) that made even 15 docs blow past 30 min.
 *
 *   .complete({prompt,tag}): send {id,type:'prompt',message}; read the LF-framed NDJSON event stream
 *     (correlating the prompt-response by id), accumulate assistant text + usage to the turn-end
 *     (agent_end) event; then send {type:'new_session'} to RESET context before returning — so each
 *     call is CONTEXT-INDEPENDENT (document N never sees document N-1). Returns the SAME shape as
 *     createPiModelRunner (text, json, usage, model, outcome).
 *   .stats(): { kind:'pi-rpc', calls, cost, models, per_call:[{...,latency_ms}] }.
 *   .shutdown(): graceful shutdown of the warm process at run end.
 *
 * The real spawn (neural-rpc-transport.mjs) is imported LAZILY, so importing this module pulls in no
 * child_process machinery. Tests inject `transportFactory` (a fake NDJSON endpoint) for zero spend.
 * Inherits PI_CODING_AGENT_DIR via the transport's inherited env (SSE agent-dir routing preserved).
 */
export function createPiRpcRunner({
  model = null,
  thinking = null,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  scratchDir = null,
  transportFactory = null,
  newSessionTimeoutMs = DEFAULT_RPC_NEW_SESSION_TIMEOUT_MS,
  maxCallRestarts = DEFAULT_RPC_MAX_CALL_RESTARTS,
  maxOutputBytes = DEFAULT_MAX_INFERENCE_EVENT_BYTES,
  maxAnswerBytes = DEFAULT_MAX_INFERENCE_ANSWER_BYTES,
  piCommand = 'pi',
  env = null,
  answerParser = null,
} = {}) {
  if (answerParser !== null && typeof answerParser !== 'function') throw new ModelRunnerError('INVALID_ANSWER_PARSER', 'answerParser must be a function');
  const parseAnswer = answerParser || parseCensusModelJson;
  const id = String(model || '').trim();
  if (!id) throw new ModelRunnerError('MISSING_MODEL', 'createPiRpcRunner requires a model identifier');
  if (/^anthropic\//.test(id)) {
    throw new ModelRunnerError('FORBIDDEN_MODEL', `model "${id}" is a forbidden anthropic/* model; route opus via the a routed gateway the routed gateway gateway`, { model: id });
  }

  const per_call = [];
  let conn = null;
  let extractPiResultImpl = null;
  let createTransportImpl = transportFactory;
  let reqSeq = 0;

  async function loadDeps() {
    if (!extractPiResultImpl) ({ extractPiResult: extractPiResultImpl } = await import('./campaign.mjs'));
    if (!createTransportImpl) ({ createPiRpcTransport: createTransportImpl } = await import('./neural-rpc-transport.mjs'));
  }

  async function ensureWarm() {
    if (conn && !conn.closed) return conn;
    await loadDeps();
    conn = await createTransportImpl({ model: id, thinking, env: env || process.env, piCommand });
    return conn;
  }

  async function teardown() {
    if (!conn) return;
    try { await conn.close?.(); } catch { /* best effort */ }
    try { conn.kill?.(); } catch {}
    conn = null;
  }

  async function restart() {
    await teardown();
    await ensureWarm();
  }

  // Run one prompt turn against the warm process. Resolves { status, buffer } where status is
  // 'ok' (agent_end reached), 'timeout' (turn budget exceeded), or 'rejected' (prompt refused
  // before acceptance). Rejects on process crash/EOF mid-turn.
  function runTurn(prompt) {
    return new Promise((resolve, reject) => {
      const reqId = `census-rpc-${++reqSeq}`;
      let buffer = '';
      let bufferBytes = 0;
      let accepted = null;
      let dispatched = false;
      let settled = false;
      let unsubLine = null;
      let unsubClose = null;
      let timer = null;
      const cleanup = () => { if (timer) clearTimeout(timer); try { unsubLine?.(); } catch {} try { unsubClose?.(); } catch {} };
      const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };

      unsubLine = conn.onLine((evt, raw) => {
        if (settled) return;
        const promptResponse = evt?.type === 'response' && evt.command === 'prompt' && evt.id === reqId;
        if (promptResponse && evt.success !== false) accepted = true;
        else if (evt?.type && evt.type !== 'response') accepted = true;
        // extractPiResult needs only terminal assistant/message events. Streaming reasoning/update
        // events can carry cumulative snapshots and grow quadratically; retaining them caused a
        // false 4 MiB overflow without bounding the semantic answer. Timeout still bounds streams.
        const retainForResult = evt?.type === 'agent_end'
          || (['message_end', 'turn_end'].includes(evt?.type) && evt?.message?.role === 'assistant');
        if (retainForResult && typeof raw === 'string') {
          const rawBuffer = Buffer.from(`${raw}\n`, 'utf8');
          const remaining = Math.max(0, maxOutputBytes - bufferBytes);
          if (remaining > 0) buffer += rawBuffer.subarray(0, remaining).toString('utf8');
          bufferBytes += rawBuffer.length;
          if (bufferBytes > maxOutputBytes) {
            try { conn.write({ type: 'abort' }); } catch { /* best effort abort */ }
            finish(resolve, { status: 'output_limit', buffer, accepted, dispatched, output_bytes: bufferBytes, max_output_bytes: maxOutputBytes });
            return;
          }
        }
        if (!evt || typeof evt.type !== 'string') return;
        if (promptResponse && evt.success === false) {
          finish(resolve, { status: 'rejected', buffer, accepted: false, error: evt.error || 'prompt rejected' });
          return;
        }
        // agent_end is turn-end for the whole run (extractPiResult reads its assistant messages).
        if (evt.type === 'agent_end') finish(resolve, { status: 'ok', buffer, accepted });
      });
      unsubClose = conn.onClose(() => finish(reject, new ModelRunnerError('RPC_PROCESS_CLOSED', 'pi rpc process closed during turn', { buffer, accepted: accepted === true ? true : (dispatched ? null : false), dispatched })));
      timer = setTimeout(() => {
        try { conn.write({ type: 'abort' }); } catch { /* best effort abort */ }
        finish(resolve, { status: 'timeout', buffer, accepted, dispatched });
      }, timeoutMs);

      try {
        // Set before write so a synchronous close during transport handoff is conservatively
        // classified as acceptance-unknown, never as safe-to-retry.
        dispatched = true;
        conn.write({ id: reqId, type: 'prompt', message: prompt });
      } catch (err) {
        dispatched = false;
        finish(reject, new ModelRunnerError('RPC_PROMPT_WRITE_FAILED', err.message || 'prompt write failed', { buffer, accepted: false, dispatched: false }));
      }
    });
  }

  // Reset conversation context between calls (independence crux). Resolves on the new_session
  // response; rejects on crash/timeout so the caller can restart the process (a fresh process is a
  // fresh session either way).
  function newSession() {
    return new Promise((resolve, reject) => {
      const reqId = `census-rpc-ns-${++reqSeq}`;
      let settled = false;
      let unsubLine = null;
      let unsubClose = null;
      let timer = null;
      const cleanup = () => { if (timer) clearTimeout(timer); try { unsubLine?.(); } catch {} try { unsubClose?.(); } catch {} };
      const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
      unsubLine = conn.onLine((evt) => {
        if (!evt || evt.type !== 'response' || evt.command !== 'new_session') return;
        if (evt.success === false) finish(reject, new ModelRunnerError('RPC_NEW_SESSION_FAILED', evt.error || 'new_session failed'));
        else finish(resolve, evt.data || {});
      });
      unsubClose = conn.onClose(() => finish(reject, new ModelRunnerError('RPC_PROCESS_CLOSED', 'pi rpc process closed during new_session')));
      timer = setTimeout(() => finish(reject, new ModelRunnerError('RPC_NEW_SESSION_TIMEOUT', 'new_session timed out')), newSessionTimeoutMs);
      try { conn.write({ id: reqId, type: 'new_session' }); }
      catch (err) { finish(reject, err); }
    });
  }

  // Reset context so the NEXT call is independent; if the reset itself fails, a full restart yields
  // an equally-fresh session.
  async function resetContext() {
    try { await newSession(); }
    catch { try { await restart(); } catch { /* next ensureWarm re-spawns */ } }
  }

  const push = (tag, outcome, startedMs, usage, model_, accepted = null) => {
    const billing_status = billingStatus({ outcome, usage, accepted });
    per_call.push({
      tag, model: model_ || id, outcome, accepted, billing_status,
      cost: Number(usage.cost || 0), cost_reported: usage.cost_reported === true, input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0), total_tokens: Number(usage.total_tokens || 0), latency_ms: Date.now() - startedMs,
    });
    return billing_status;
  };
  const emptyResult = (tag, outcome, startedMs, accepted = false) => {
    const usage = emptyUsage();
    const billing_status = push(tag, outcome, startedMs, usage, null, accepted);
    return { text: '', json: parseCensusModelJson(''), usage, model: id, outcome, accepted, billing_status };
  };

  return {
    kind: 'pi-rpc',
    model: id,
    async complete({ prompt, tag = 'neural-census' } = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new ModelRunnerError('MISSING_PROMPT', 'complete requires a non-empty prompt');
      assertInferencePromptWithinLimit(prompt);
      await loadDeps();
      const started = Date.now();
      let preAcceptRestarts = 0;
      while (true) {
        try { await ensureWarm(); }
        catch {
          preAcceptRestarts += 1;
          if (preAcceptRestarts > maxCallRestarts) return emptyResult(tag, 'timeout:process_unavailable', started, false);
          continue;
        }

        let turn;
        try { turn = await runTurn(prompt); }
        catch (error) {
          const accepted = error?.detail?.accepted ?? null;
          const buffer = error?.detail?.buffer || '';
          if (accepted === false && preAcceptRestarts < maxCallRestarts) {
            preAcceptRestarts += 1;
            try { await restart(); } catch {}
            continue;
          }
          const parsed = buffer ? extractPiResultImpl(buffer) : { text: '', usage: emptyUsage(), found: false, model: null };
          const usage = { ...emptyUsage(), ...(parsed.usage || {}) };
          const outcome = 'timeout:process_crash';
          const billing_status = push(tag, outcome, started, usage, parsed.model || id, accepted);
          await teardown();
          return {
            text: parsed.text || '', json: parseCensusModelJson(parsed.text || ''), usage,
            model: parsed.model || id, outcome, accepted, billing_status, ...providerDiagnostics(parsed),
          };
        }

        if (turn.status === 'timeout' || turn.status === 'output_limit') {
          // Salvage any terminal usage already present. Timeout/output overflow is NEVER retried:
          // either may follow provider acceptance and billing.
          const parsed = extractPiResultImpl(turn.buffer);
          const usage = { ...emptyUsage(), ...(parsed.usage || {}) };
          const outcome = turn.status;
          const billing_status = push(tag, outcome, started, usage, parsed.model || id, turn.accepted);
          await teardown();
          return {
            text: parsed.text || '', json: parseCensusModelJson(parsed.text || ''), usage,
            model: parsed.model || id, outcome, accepted: turn.accepted, billing_status,
            output_bytes: turn.output_bytes ?? null, max_output_bytes: turn.max_output_bytes ?? maxOutputBytes,
            ...providerDiagnostics(parsed),
          };
        }

        // Parse the accumulated event buffer with the SAME landed parser as the one-shot path.
        const parsed = turn.status === 'rejected'
          ? { text: '', usage: emptyUsage(), found: false, model: null, stopReason: 'error', errorMessage: turn.error }
          : extractPiResultImpl(turn.buffer);
        const usage = { ...emptyUsage(), ...(parsed.usage || {}) };
        const text = parsed.text || '';
        const answerBytes = Buffer.byteLength(text, 'utf8');
        const parsedJson = parseAnswer(text);
        let outcome = 'ok';
        if (turn.status === 'rejected') outcome = 'error:prompt_rejected';
        else if (parsed.stopReason === 'error') outcome = 'error:provider';
        else if (!parsed.found) outcome = 'ok:no_answer';
        else if (answerBytes > maxAnswerBytes) outcome = 'output_limit';
        else if (parsedJson === null) outcome = text ? 'ok:unparseable' : 'ok:empty';

        // Accepted provider/content failures are terminal. Persist them for targeted repair rather
        // than silently buying the same inference again.
        await resetContext();
        const billing_status = push(tag, outcome, started, usage, parsed.model || id, turn.accepted);
        return {
          text, json: outcome === 'output_limit' ? null : parsedJson, usage,
          model: parsed.model || id, outcome, accepted: turn.accepted, billing_status,
          answer_bytes: answerBytes, max_answer_bytes: maxAnswerBytes, ...providerDiagnostics(parsed),
        };
      }
    },
    stats() { return summarizeCalls(per_call, 'pi-rpc'); },
    async shutdown() { await teardown(); },
  };
}

/**
 * A deterministic, ZERO-SPEND mock runner for tests. `handler({ prompt, tag }) -> { json?, text?, usage? }`.
 * Whatever the handler returns is normalized to the ModelRunner return contract; cost is forced to 0
 * so a test can assert the whole neural flow spent nothing.
 */
export function createMockModelRunner(handler, { model = 'mock/deterministic-runner' } = {}) {
  if (typeof handler !== 'function') throw new ModelRunnerError('INVALID_MOCK_HANDLER', 'createMockModelRunner requires a handler function');
  const per_call = [];
  return {
    kind: 'mock',
    model,
    async complete({ prompt, tag = 'neural-census' } = {}) {
      const out = (await handler({ prompt, tag })) || {};
      const json = out.json !== undefined ? out.json : null;
      const text = out.text !== undefined ? out.text : (json !== null ? JSON.stringify(json) : '');
      const usage = { ...emptyUsage(), ...(out.usage || {}), cost: 0 };
      // The handler MAY return a non-ok outcome (e.g. 'timeout') so tests can exercise terminal
      // failure custody deterministically. Cost is forced to 0 (zero real spend).
      const outcome = out.outcome ? String(out.outcome) : 'ok';
      const accepted = out.accepted === undefined ? true : Boolean(out.accepted);
      const billing_status = out.billing_status || 'not_billable';
      per_call.push({ tag, model, outcome, accepted, billing_status, cost: 0, input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), total_tokens: Number(usage.total_tokens || 0) });
      return { text, json: json !== null ? json : parseCensusModelJson(text), usage, model, outcome, accepted, billing_status };
    },
    stats() { return summarizeCalls(per_call, 'mock'); },
  };
}
