import { createHash } from 'node:crypto';
import { createArmContext, assertIsolatedContext } from './isolation.mjs';
import { runModelInFreshProcess } from './model-process.mjs';
import { retryModelCall } from './retry.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finalKinds = new Set(['set', 'scalar', 'prose']);

function conversationRequest({ context, prompt, events, turn, execution, model }) {
  return Object.freeze({
    execution: Object.freeze({ ...execution }),
    context,
    prompt: structuredClone(prompt),
    events: Object.freeze(structuredClone(events)),
    turn,
    model: structuredClone(model ?? null),
    fresh_context: true,
  });
}

function modelEmission(response) {
  return response?.emission ?? response;
}

export function tokenUsage(usage = {}) {
  // Pi's JSON-mode assistant producer emits input/output/totalTokens and cost.total. Keep the
  // prior provider_* aliases for adapters that normalize another runner's envelope.
  const input = Number(usage.provider_input_tokens ?? usage.input_tokens ?? usage.input ?? 0);
  const output = Number(usage.provider_output_tokens ?? usage.output_tokens ?? usage.output ?? 0);
  const total = Number(usage.totalTokens ?? usage.total_tokens);
  const providerInput = Math.max(0, Number.isFinite(input) ? input : 0);
  const providerOutput = Math.max(0, Number.isFinite(output) ? output : 0);
  const cost = usage.reported_cost_usd ?? usage.cost_usd ?? usage.cost?.total;
  return {
    provider_input_tokens: providerInput,
    provider_output_tokens: providerOutput,
    tokens_consumed: Math.max(0, Number.isFinite(total) ? total : providerInput + providerOutput),
    // A missing provider total is unavailable, not a license to apply estimate rates as actual.
    reported_cost_usd: Number.isFinite(Number(cost)) ? Number(cost) : null,
  };
}

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function positiveInteger(value) { return Number.isInteger(value) && value >= 1; }

export function validTranscriptEvent(event) {
  if (!record(event) || typeof event.type !== 'string') return false;
  if (event.type === 'model_emission') return exactKeys(event, ['type', 'turn', 'emission', 'usage', 'started_at', 'stderr', 'retry_attempts'])
    && positiveInteger(event.turn) && record(event.emission) && record(event.usage)
    && typeof event.started_at === 'string' && (typeof event.stderr === 'string' || event.stderr === null)
    && Array.isArray(event.retry_attempts);
  if (event.type === 'tool_result') return exactKeys(event, ['type', 'turn', 'tool', 'result'])
    && positiveInteger(event.turn) && typeof event.tool === 'string';
  if (event.type === 'tool_error') return (exactKeys(event, ['type', 'turn', 'tool', 'tool_error'])
      || exactKeys(event, ['type', 'turn', 'tool', 'tool_error', 'message']))
    && positiveInteger(event.turn) && (typeof event.tool === 'string' || event.tool === null)
    && typeof event.tool_error === 'string' && (event.message === undefined || typeof event.message === 'string');
  if (event.type === 'model_error') return exactKeys(event, ['type', 'turn', 'model_error', 'error_class', 'attempts', 'message', 'stderr', 'retry_attempts'])
    && positiveInteger(event.turn) && typeof event.model_error === 'string' && typeof event.error_class === 'string'
    && positiveInteger(event.attempts) && typeof event.message === 'string'
    && (typeof event.stderr === 'string' || event.stderr === null) && Array.isArray(event.retry_attempts);
  return false;
}

export function validTranscript(transcript) {
  return Array.isArray(transcript) && transcript.every(validTranscriptEvent);
}

function relativePath(value) {
  return typeof value === 'string' && value && !value.includes('\0') && !value.startsWith('/')
    && !value.split('/').includes('..');
}

const SCHEMA_FIELDS = new Set(['$schema', '$id', 'type', 'const', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'required', 'properties', 'additionalProperties', 'items']);

export function finalAnswerSchemaSupported(schema) {
  if (!record(schema) || Object.keys(schema).some(key => !SCHEMA_FIELDS.has(key))) return false;
  if (schema.type !== undefined && !(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)
    || (Array.isArray(schema.type) && schema.type.every(type => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))))) return false;
  if (schema.properties !== undefined && (!record(schema.properties)
    || !Object.values(schema.properties).every(finalAnswerSchemaSupported))) return false;
  if (schema.items !== undefined && !finalAnswerSchemaSupported(schema.items)) return false;
  return true;
}

function matchesSchema(value, schema) {
  if (!finalAnswerSchemaSupported(schema)) return false;
  if (schema.const !== undefined && !Object.is(value, schema.const)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some(candidate => Object.is(candidate, value)))) return false;
  if (schema.type !== undefined) {
    const matchesType = type => ({ object: record(value), array: Array.isArray(value), string: typeof value === 'string',
      number: Number.isFinite(value), integer: Number.isInteger(value), boolean: typeof value === 'boolean', null: value === null })[type] === true;
    if (!(Array.isArray(schema.type) ? schema.type.some(matchesType) : matchesType(schema.type))) return false;
  }
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength)
    || (schema.maxLength !== undefined && value.length > schema.maxLength))) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems)
      || (schema.maxItems !== undefined && value.length > schema.maxItems)
      || (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length)
      || (schema.items !== undefined && !value.every(item => matchesSchema(item, schema.items)))) return false;
  }
  if (record(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties !== undefined && (!record(schema.properties)
      || Object.entries(schema.properties).some(([key, child]) => Object.hasOwn(value, key) && !matchesSchema(value[key], child)))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  }
  return true;
}

export function validateFinal(answer, kind, final_answer_schema = {}) {
  if (!record(answer) || answer.answer_kind !== kind || !finalKinds.has(kind)
    || !Array.isArray(answer.answer_units) || !Array.isArray(answer.citations)
    || typeof answer.abstained !== 'boolean' || !Array.isArray(answer.limitations)) return false;
  const units = new Set(); const citations = new Set();
  for (const unit of answer.answer_units) {
    if (!record(unit) || typeof unit.unit_id !== 'string' || !unit.unit_id || units.has(unit.unit_id)
      || typeof unit.value !== 'string' || !unit.value.trim() || !Number.isFinite(unit.confidence)
      || unit.confidence < 0 || unit.confidence > 1 || !Array.isArray(unit.citation_ids)
      || unit.citation_ids.some(id => typeof id !== 'string' || !id)) return false;
    units.add(unit.unit_id);
  }
  for (const citation of answer.citations) {
    if (!record(citation) || typeof citation.citation_id !== 'string' || !citation.citation_id
      || citations.has(citation.citation_id) || !relativePath(citation.path)
      || !Number.isInteger(citation.line_start) || citation.line_start < 1
      || !Number.isInteger(citation.line_end) || citation.line_end < citation.line_start
      || (citation.quote !== null && typeof citation.quote !== 'string')
      || (citation.graph_node_ids !== undefined && (!Array.isArray(citation.graph_node_ids)
        || citation.graph_node_ids.some(id => typeof id !== 'string' || !id)))) return false;
    citations.add(citation.citation_id);
  }
  if (answer.answer_units.some(unit => new Set(unit.citation_ids).size !== unit.citation_ids.length
    || unit.citation_ids.some(id => !citations.has(id)))) return false;
  if (answer.abstained ? (answer.answer_units.length !== 0 || typeof answer.abstention_reason !== 'string' || !answer.abstention_reason.trim())
    : (answer.answer_units.length === 0 || answer.abstention_reason !== null)) return false;
  if (answer.limitations.some(limitation => typeof limitation !== 'string')) return false;
  return matchesSchema(answer, final_answer_schema);
}

export function renderPrompt(context, protocol) {
  return {
    system: protocol.system_prompt,
    user: { question: context.question, target_commit: protocol.target_commit, answer_contract: protocol.final_answer_schema, turn_budget: protocol.turn_budget },
  };
}

// A provider hiccup, an expired-then-refreshed OAuth token, or one unparseable emission used to
// abort the entire study and discard every already-paid execution. The model call is therefore
// retried a bounded number of times with backoff; only a persistently unreachable model ends the
// execution, and it ends THAT execution alone with a typed reason the aggregate can see.
async function modelTurn({ model_runner, request, attempts = 3, checkpoint }) {
  const result = await retryModelCall({ call: () => runModelInFreshProcess({ model_runner, request }), attempts,
    checkpoint });
  return result.error ? result : { response: result.result, attempts_used: result.attempts_used, attempts: result.attempts };
}

export async function executeArm({ question, arm, protocol, toolSchema, tools, model_runner, execution, nonce, model_attempts = 3, checkpoint }) {
  if (!Number.isInteger(protocol.turn_budget) || protocol.turn_budget < 1) throw new Error('turn budget must come from configuration');
  if (typeof model_runner !== 'string') throw new Error('model_runner required for isolated executions');
  const context = createArmContext({ question, arm, toolSchema, nonce });
  assertIsolatedContext(context);
  const allowedTools = new Set(toolSchema.allowed_tool_names ?? Object.keys(tools));
  const prompt = renderPrompt(context, protocol);
  const conversation = { context, prompt, events: [] };
  const checkpointEvent = async event => checkpoint?.({ type: 'arm_event', execution_id: execution?.execution_id, arm, event });
  const started = process.hrtime.bigint();
  // Provider totals are an all-or-nothing measurement. Summing only the turns that happened to
  // report one would label a partial bill as actual spend.
  const usage = { ...tokenUsage(), reported_cost_usd: 0 };
  let hasUnreportedCost = false;
  const completed = value => {
    if (!validTranscript(value.transcript)) throw new Error('evaluation transcript does not match transcript.schema.json');
    return { ...value, usage: { ...usage, reported_cost_usd: hasUnreportedCost ? null : usage.reported_cost_usd } };
  };
  for (let turn = 1; turn <= protocol.turn_budget; turn += 1) {
    const turnResult = await modelTurn({ model_runner, attempts: model_attempts,
      request: conversationRequest({ ...conversation, turn, execution, model: protocol.model }),
      checkpoint: event => checkpointEvent({ ...event, turn }) });
    if (turnResult.error) {
      // An unsuccessful provider attempt has no provider total to include in actual spend.
      hasUnreportedCost = true;
      const unavailable = turnResult.error_class === 'model_unavailable';
      const event = { type: 'model_error', turn, model_error: unavailable ? 'EVAL_MODEL_UNAVAILABLE' : 'EVAL_MODEL_FAILURE',
        error_class: turnResult.error_class, attempts: turnResult.attempts_used,
        message: String(turnResult.error?.message ?? turnResult.error).slice(0, 500),
        stderr: turnResult.error?.stderr ?? null, retry_attempts: turnResult.attempts };
      conversation.events.push(event); await checkpointEvent(event);
      return completed({ arm, prompt_sha256: digest(prompt), turns_used: turn, transcript: conversation.events,
        termination: { reason: unavailable ? 'model_unavailable' : 'model_failure',
          attempts: turnResult.attempts_used, error_class: event.error_class },
        answer: abstention(question.answer_kind), usage,
        elapsed_monotonic_ms: Number(process.hrtime.bigint() - started) / 1e6 });
    }
    if (turnResult.attempts.some(event => event.outcome === 'error')) hasUnreportedCost = true;
    const response = turnResult.response;
    const emission = modelEmission(response);
    const turnUsage = tokenUsage(response?.usage);
    usage.provider_input_tokens += turnUsage.provider_input_tokens;
    usage.provider_output_tokens += turnUsage.provider_output_tokens;
    usage.tokens_consumed += turnUsage.tokens_consumed;
    if (Number.isFinite(turnUsage.reported_cost_usd)) usage.reported_cost_usd += turnUsage.reported_cost_usd;
    else hasUnreportedCost = true;
    const emissionEvent = { type: 'model_emission', turn, emission, usage: turnUsage, started_at: new Date().toISOString(),
      stderr: response?.stderr ? String(response.stderr).slice(-8_192) : null, retry_attempts: turnResult.attempts };
    conversation.events.push(emissionEvent); await checkpointEvent(emissionEvent);
    const finish = (termination, answer) => completed({ arm, prompt_sha256: digest(prompt), turns_used: turn, transcript: conversation.events,
      termination, answer, usage, elapsed_monotonic_ms: Number(process.hrtime.bigint() - started) / 1e6 });
    if (emission?.final !== undefined) {
      const valid = validateFinal(emission.final, question.answer_kind, protocol.final_answer_schema);
      return finish({ reason: valid ? 'final' : 'invalid_final' }, valid ? emission.final : abstention(question.answer_kind));
    }
    const call = emission?.tool_call;
    if (!call || Object.keys(emission).length !== 1 || !allowedTools.has(call.name) || !tools[call.name]) {
      const event = { type: 'tool_error', turn, tool: null, tool_error: 'EVAL_TOOL_POLICY' };
      conversation.events.push(event); await checkpointEvent(event);
      continue;
    }
    // A malformed tool call is the model's error to recover from, not grounds to abort the study.
    // The loop already treats a policy violation this way; an invalid argument must behave the same,
    // otherwise one bad call in one execution destroys an entire paid run. The failure is recorded
    // in the transcript so a reader can see the model spent a turn on it.
    let result;
    try {
      result = await tools[call.name](call.arguments ?? {});
    } catch (error) {
      const event = { type: 'tool_error', turn, tool: call.name, tool_error: 'EVAL_TOOL_INVOCATION_FAILED', message: String(error?.message ?? error) };
      conversation.events.push(event); await checkpointEvent(event);
      continue;
    }
    const event = { type: 'tool_result', turn, tool: call.name, result };
    conversation.events.push(event); await checkpointEvent(event);
  }
  return completed({ arm, prompt_sha256: digest(prompt), turns_used: protocol.turn_budget, transcript: conversation.events,
    termination: { reason: 'turn_limit' }, answer: abstention(question.answer_kind), usage,
    elapsed_monotonic_ms: Number(process.hrtime.bigint() - started) / 1e6 });
}

function abstention(answer_kind) {
  return { answer_kind, answer_units: [], citations: [], abstained: true, abstention_reason: 'no valid final answer', limitations: [] };
}
