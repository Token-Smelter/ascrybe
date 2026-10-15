import { spawn } from 'node:child_process';
import { evaluationChildEnvironment } from './child-environment.mjs';

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

function configuredModel(request) {
  const model = request?.model;
  if (model?.runner !== 'pi' || typeof model.name !== 'string' || !model.name) throw new Error('Pi model configuration is required');
  return model;
}

function promptForArm(request) {
  const schema = request.context?.tool_schema;
  return [
    'You are an evaluation agent. Return exactly one JSON object and no Markdown.',
    'For a tool turn return {"tool_call":{"name":"...","arguments":{...}}}.',
    'For your final turn return {"final":<the supplied answer-contract object>}.',
    'Use exactly one allowed tool call or one final answer. You may abstain. Do not assume access to files, network, shell, credentials, answer keys, or prior conversations.',
    `System instruction: ${request.prompt?.system ?? ''}`,
    `Question and contract: ${JSON.stringify(request.prompt?.user ?? {})}`,
    `Allowed tool schema: ${JSON.stringify(schema ?? {})}`,
    `Prior events: ${JSON.stringify(request.events ?? [])}`,
  ].join('\n');
}

function promptForJudge(request) {
  return [
    'You are a blind evaluation judge. Return exactly one JSON object and no Markdown.',
    'Return {"earned_points":number,"available_points":number,"citation_assessments":[{"unit_id":string,"supported":boolean}],"factual_assessments":[{"unit_id":string,"disposition":"supported|unsupported_or_false|not_assessable"}],"findings":[]}.',
    'Score only the supplied anonymized answer against the rubric, source excerpts, and citation records. Return exactly one citation and factual assessment for every answer unit.',
    JSON.stringify(request.judge_request),
  ].join('\n');
}

// Models are instructed to emit exactly one bare JSON object, and they do not reliably comply:
// the same model returns clean JSON on one execution and a fenced or prose-wrapped block on the
// next. Recovering the object from its own output is not fabrication — the bytes are the model's.
// Aborting instead would discard every paid execution in a run over a formatting whim.
// Every balanced object in the emission, in order. A model that emits a TRUNCATED object followed
// by a complete one is common enough to have destroyed a full paid run: taking only the first
// balanced span finds nothing, because the truncated leader never closes. Scanning from every
// opening brace lets the recoverable instruction behind a malformed leader still be found.
function balancedObjects(text) {
  const found = [];
  for (let origin = text.indexOf('{'); origin >= 0; origin = text.indexOf('{', origin + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = origin; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) { found.push(text.slice(origin, index + 1)); break; }
      }
    }
    if (found.length >= 8) break;
  }
  return found;
}

export function parseModelJson(text) {
  const attempts = [];
  attempts.push(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  if (fenced) attempts.push(fenced[1]);
  // Models also emit several objects back to back, one per line, sometimes repeating the same call.
  // First-brace-to-last-brace would span all of them and never parse, so take the FIRST balanced
  // object: it is the model's first instruction and the only one the protocol acts on.
  attempts.push(...balancedObjects(text));
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));
  // Scanning from every brace can also surface a NESTED fragment of a malformed leader, which
  // parses cleanly but is not an emission the protocol can act on. Prefer a candidate that carries
  // a real instruction; fall back to the first parseable object only if none qualifies.
  const parsed = [];
  for (const attempt of attempts) {
    const candidate = attempt.trim();
    if (!candidate) continue;
    try { parsed.push(JSON.parse(candidate)); } catch { /* try the next recovery */ }
  }
  const actionable = parsed.find(value => value && typeof value === 'object'
    && (value.tool_call !== undefined || value.final !== undefined));
  if (actionable) return actionable;
  if (parsed.length) return parsed[0];
  throw new Error(`model output was not JSON: ${text.slice(0, 200)}`);
}

function parseJsonOutput(stdout) {
  const values = String(stdout || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw new Error('Pi JSON event stream was malformed'); }
  });
  const assistant = values.slice().reverse().map(event => event?.message ?? event?.messages?.at?.(-1))
    .find(message => message?.role === 'assistant');
  if (!assistant) throw new Error('Pi JSON event stream contained no assistant message');
  const text = (assistant.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n').trim();
  // Pi reports a provider failure as an assistant message with stopReason 'error' and no text
  // (e.g. "Codex unavailable ... no account available"). That is the provider speaking, not the
  // model: it is transient for retry purposes and, if it persists, a typed model_unavailable
  // outcome — never a deterministic model failure. Twelve consecutive executions once ended in
  // seconds because this was read as the model's own malformed output.
  if (assistant.stopReason === 'error' || (!text && assistant.errorMessage)) {
    const error = new Error(`Pi provider error: ${String(assistant.errorMessage || 'assistant message ended in error').slice(0, 500)}`);
    error.code = 'EVAL_MODEL_TRANSIENT';
    throw error;
  }
  if (!text) {
    const error = new Error('Pi assistant message contained no text');
    error.code = 'EVAL_MODEL_TRANSIENT';
    throw error;
  }
  return { value: parseModelJson(text), usage: assistant.usage ?? assistant.provider_usage ?? null };
}

export function executePi({ command = null, args, input, environment = process.env, spawn_process = spawn, max_stdout_bytes = MAX_STDOUT_BYTES }) {
  return new Promise((resolve, reject) => {
    const executable = command || environment.PI_COMMAND || 'pi';
    const child = spawn_process(executable, args, {
      cwd: process.cwd(), env: evaluationChildEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    // Killing the child on overflow makes a deliberate cap indistinguishable from an external kill:
    // it surfaced only as "Pi exited 143" and cost several runs to diagnose. Record the reason so
    // the rejection names the cap it hit, and honour the role's configured event ceiling.
    let overflowed = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!overflowed && Buffer.byteLength(stdout) > max_stdout_bytes) {
        overflowed = true;
        child.kill();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (overflowed) {
        reject(new Error(`Pi output exceeded ${max_stdout_bytes} bytes and was terminated by the harness`));
        return;
      }
      if (code === 0) resolve({ stdout, stderr });
      else {
        const stderrTail = stderr.slice(-8_192);
        const error = new Error(`Pi exited ${code}: ${stderrTail.slice(-2_048)}`);
        error.stderr = stderrTail;
        // Normalize only transport/provider diagnostics at this boundary. Semantic JSON and
        // scoring failures happen after a successful Pi process and remain deterministic.
        if (/No API key found for \S+/u.test(stderr)) error.code = 'EVAL_MODEL_UNAVAILABLE';
        else if (/\b(?:429|502|503|504|ECONNRESET|ETIMEDOUT)\b|rate limit|temporarily unavailable|connection reset/iu.test(stderr)) {
          error.code = 'EVAL_MODEL_TRANSIENT';
        }
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function runWithPi(request, { execute = executePi } = {}) {
  const model = configuredModel(request);
  const prompt = request?.kind === 'blind-judge' ? promptForJudge(request) : promptForArm(request);
  const args = ['--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-builtin-tools', '--print', '--mode', 'json', '--model', model.name];
  if (model.thinking) args.push('--thinking', model.thinking);
  const configuredCeiling = Number(model.max_event_bytes);
  const response = await execute({ args, input: prompt,
    max_stdout_bytes: Number.isFinite(configuredCeiling) && configuredCeiling > 0 ? configuredCeiling : MAX_STDOUT_BYTES });
  const parsed = parseJsonOutput(response.stdout);
  if (request?.kind === 'blind-judge') return { result: parsed.value, usage: parsed.usage, stderr: response.stderr || null };
  if (!parsed.value || typeof parsed.value !== 'object' || (!parsed.value.final && !parsed.value.tool_call)) throw new Error('Pi response must contain final or tool_call');
  return { emission: parsed.value, usage: parsed.usage, provider: { runner: 'pi', model: model.name }, stderr: response.stderr || null };
}

export async function run(request) {
  return runWithPi(request);
}
