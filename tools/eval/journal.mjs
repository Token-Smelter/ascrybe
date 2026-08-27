import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import finalAnswerSchema from './schemas/final-answer.schema.json' with { type: 'json' };
import { validTranscriptEvent, validateFinal } from './protocol.mjs';

export const JOURNAL_SCHEMA = 'estate-map/eval-journal/v2';
const TYPES = new Set(['header', 'arm_event', 'execution', 'judge_attempt', 'score', 'finalized']);
const ARMS = new Set(['filesystem', 'graph', 'both']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digestRecord({ schema, type, payload, previous_sha256 }) {
  return sha256(canonical({ schema, type, payload, previous_sha256 }));
}

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactKeys(value, keys) { return record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function nonEmptyString(value) { return typeof value === 'string' && Boolean(value); }
function positiveInteger(value) { return Number.isInteger(value) && value >= 1; }

function usageShape(usage) {
  return exactKeys(usage, ['provider_input_tokens', 'provider_output_tokens', 'tokens_consumed', 'reported_cost_usd'])
    && ['provider_input_tokens', 'provider_output_tokens', 'tokens_consumed'].every(field => Number.isFinite(usage[field]) && usage[field] >= 0)
    && (usage.reported_cost_usd === null || Number.isFinite(usage.reported_cost_usd));
}

function answerShape(answer) {
  return nonEmptyString(answer?.answer_kind) && validateFinal(answer, answer.answer_kind, finalAnswerSchema);
}

function modelAttemptShape(event) {
  if (event?.type !== 'model_attempt' || !positiveInteger(event.attempt) || !['success', 'error'].includes(event.outcome)) return false;
  const turn = event.turn === undefined || positiveInteger(event.turn);
  if (!turn) return false;
  if (event.outcome === 'success') return exactKeys(event, event.turn === undefined
    ? ['type', 'attempt', 'outcome'] : ['type', 'attempt', 'outcome', 'turn']);
  return exactKeys(event, event.turn === undefined
    ? ['type', 'attempt', 'outcome', 'error_class', 'error_code', 'message', 'stderr', 'delay_ms']
    : ['type', 'attempt', 'outcome', 'error_class', 'error_code', 'message', 'stderr', 'delay_ms', 'turn'])
    && typeof event.error_class === 'string' && (event.error_code === null || typeof event.error_code === 'string')
    && typeof event.message === 'string' && (event.stderr === null || typeof event.stderr === 'string')
    && Number.isFinite(event.delay_ms) && event.delay_ms >= 0;
}

function executionChecks(execution) {
  return {
    keys: exactKeys(execution, ['arm', 'prompt_sha256', 'turns_used', 'transcript', 'termination', 'answer', 'usage',
      'elapsed_monotonic_ms', 'execution_id', 'question_id', 'repetition', 'anonymous_order', 'attempt']),
    identity: nonEmptyString(execution?.execution_id) && nonEmptyString(execution?.question_id) && ARMS.has(execution?.arm),
    prompt: /^[0-9a-f]{64}$/u.test(execution?.prompt_sha256) && positiveInteger(execution?.turns_used),
    placement: positiveInteger(execution?.repetition) && positiveInteger(execution?.anonymous_order)
      && execution.anonymous_order <= ARMS.size && positiveInteger(execution?.attempt),
    transcript: Array.isArray(execution?.transcript) && execution.transcript.every(validTranscriptEvent),
    answer: answerShape(execution?.answer),
    termination: record(execution?.termination) && nonEmptyString(execution.termination.reason),
    usage: usageShape(execution?.usage),
    elapsed: Number.isFinite(execution?.elapsed_monotonic_ms) && execution.elapsed_monotonic_ms >= 0,
  };
}

function executionShape(execution) { return Object.values(executionChecks(execution)).every(Boolean); }

function scoreShape(score) {
  return record(score) && ['correctness', 'exact_citation_rate', 'confidently_wrong_rate'].every(name =>
    Number.isFinite(score[name]) && score[name] >= 0 && score[name] <= 1)
    && ['judge_invalid', 'model_unavailable'].every(name => score[name] === undefined || typeof score[name] === 'boolean')
    && (score.judge_usage === undefined || usageShape(score.judge_usage));
}

function armEventPayload(payload) {
  return exactKeys(payload, ['execution_id', 'arm', 'event']) && nonEmptyString(payload.execution_id) && ARMS.has(payload.arm)
    && (validTranscriptEvent(payload.event) || modelAttemptShape(payload.event));
}

function judgeAttemptPayload(payload) {
  return exactKeys(payload, ['execution_id', 'event']) && nonEmptyString(payload.execution_id) && modelAttemptShape(payload.event);
}

function executionPayload(payload) { return exactKeys(payload, ['execution']) && executionShape(payload.execution); }
function scorePayload(payload) { return exactKeys(payload, ['execution_id', 'score']) && nonEmptyString(payload.execution_id) && scoreShape(payload.score); }
function headerPayload(payload) { return record(payload) && Object.keys(payload).length > 0; }

function finalizedPayload(payload) {
  const fields = ['bundle_sha256', 'harness_sha256', 'behavioral_source_sha256', 'runtime_config_sha256',
    'runtime_config_digest', 'journal_sha256', 'tool_schemas_sha256'];
  return exactKeys(payload, fields)
    && fields.every(field => typeof payload[field] === 'string' && /^[0-9a-f]{64}$/u.test(payload[field]));
}

function payloadShape(type, payload) {
  if (type === 'header') return headerPayload(payload);
  if (type === 'arm_event') return armEventPayload(payload);
  if (type === 'execution') return executionPayload(payload);
  if (type === 'judge_attempt') return judgeAttemptPayload(payload);
  if (type === 'score') return scorePayload(payload);
  return finalizedPayload(payload);
}

function completeExecution(execution, score) {
  return executionShape(execution) && scoreShape(score);
}

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('evaluation journal record must be an object');
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'payload,previous_sha256,record_sha256,schema,type' || record.schema !== JOURNAL_SCHEMA || !TYPES.has(record.type)) {
    throw new Error('evaluation journal contains a corrupt or unsupported record');
  }
  if (!payloadShape(record.type, record.payload)) {
    const detail = record.type === 'execution' ? `: ${JSON.stringify(executionChecks(record.payload?.execution))}` : '';
    throw new Error(`evaluation journal ${record.type} payload is corrupt or unsupported${detail}`);
  }
  if ((record.previous_sha256 !== null && !/^[0-9a-f]{64}$/u.test(record.previous_sha256))
    || !/^[0-9a-f]{64}$/u.test(record.record_sha256)
    || record.record_sha256 !== digestRecord(record)) {
    throw new Error('evaluation journal hash record is corrupt or unsupported');
  }
  return record;
}

function validateChain(records) {
  let previous = null;
  for (const record of records) {
    if (record.previous_sha256 !== previous) throw new Error('evaluation journal hash chain is corrupt');
    previous = record.record_sha256;
  }
}

function parseJournal(source) {
  if (!source || !source.endsWith('\n')) throw new Error('evaluation journal is partial or corrupt');
  const records = source.slice(0, -1).split('\n').map(line => {
    try { return validRecord(JSON.parse(line)); } catch (error) { throw new Error(`evaluation journal is partial or corrupt: ${error.message}`); }
  });
  if (!records.length || records[0].type !== 'header' || records.filter(record => record.type === 'header').length !== 1) {
    throw new Error('evaluation journal lacks exactly one header');
  }
  try { validateChain(records); } catch (error) { throw new Error(`evaluation journal is partial or corrupt: ${error.message}`); }
  const finalizations = records.filter(record => record.type === 'finalized');
  if (finalizations.length > 1) throw new Error('evaluation journal has duplicate finalization');
  if (finalizations.length && records.at(-1).type !== 'finalized') {
    throw new Error('evaluation journal has records after finalization');
  }
  return records;
}

function journalWriter(handle, path, previous_sha256) {
  let previous = previous_sha256;
  return {
    async append(type, payload) {
      const body = { schema: JOURNAL_SCHEMA, type, payload, previous_sha256: previous };
      const record = validRecord({ ...body, record_sha256: digestRecord(body) });
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
      previous = record.record_sha256;
      return record;
    },
    async digest() {
      await handle.sync();
      return sha256(await readFile(path));
    },
    async close() { await handle.close(); },
  };
}

export async function createJournal({ path, immutable }) {
  const handle = await open(path, 'wx');
  const journal = journalWriter(handle, path, null);
  await journal.append('header', immutable);
  return journal;
}

export async function resumeJournal({ path, immutable }) {
  const records = await readJournal(path);
  if (canonical(records[0].payload) !== canonical(immutable)) {
    throw new Error('evaluation --resume immutable inputs or digests do not match journal header');
  }
  const handle = await open(path, 'a');
  return { records, journal: journalWriter(handle, path, records.at(-1).record_sha256) };
}

export async function readJournal(path) {
  return parseJournal(await readFile(path, 'utf8'));
}

export async function finalizedJournalDigest(path) {
  const source = await readFile(path, 'utf8');
  const records = parseJournal(source);
  if (records.at(-1).type !== 'finalized') throw new Error('evaluation journal is not finalized');
  const boundary = source.lastIndexOf('\n', source.length - 2);
  return sha256(source.slice(0, boundary + 1));
}

function journalExecutions(records) {
  const executions = new Map(); const scores = new Map();
  for (const record of records) {
    if (record.type === 'execution') {
      const execution = record.payload.execution;
      if (!execution?.execution_id || executions.has(execution.execution_id) || !executionShape(execution)) {
        throw new Error('evaluation journal has duplicate or invalid execution');
      }
      executions.set(execution.execution_id, execution);
    }
    if (record.type === 'score') {
      if (!record.payload.execution_id || scores.has(record.payload.execution_id)) throw new Error('evaluation journal has duplicate or invalid score');
      scores.set(record.payload.execution_id, record.payload.score);
    }
  }
  for (const id of scores.keys()) if (!executions.has(id)) throw new Error('evaluation journal score has no completed execution');
  return { executions, scores };
}

export function completedExecutions(records) {
  const { executions, scores } = journalExecutions(records);
  const complete = new Map();
  for (const [id, execution] of executions) if (scores.has(id)) {
    const score = scores.get(id);
    if (!completeExecution(execution, score)) throw new Error('evaluation journal has incomplete execution or score payload');
    complete.set(id, { ...execution, score });
  }
  return complete;
}

export function pendingExecutions(records) {
  const { executions, scores } = journalExecutions(records);
  return new Map([...executions].filter(([id]) => !scores.has(id)));
}
