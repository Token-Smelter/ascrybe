import { createHash } from 'node:crypto';
import { executeArm, finalAnswerSchemaSupported, tokenUsage, validateFinal } from './protocol.mjs';
import { validateQuestion } from './isolation.mjs';
import { scoreAnswer } from './score.mjs';
import { judgeProse } from './blind-judge.mjs';
import { aggregatePairs } from './aggregate.mjs';
import { retryModelCall } from './retry.mjs';

export const ARMS = Object.freeze(['filesystem', 'graph', 'both']);
export const executionId = ({ seed, question_id, repetition, arm }) => createHash('sha256')
  .update(JSON.stringify({ seed, question_id, repetition, arm })).digest('hex');

export function armOrder({ seed, question_id, repetition }) {
  // Sorting independent keyed digests gives all six orders without privileging either treatment.
  return [...ARMS].sort((left, right) => createHash('sha256')
    .update(JSON.stringify({ seed, question_id, repetition, purpose: 'arm-order', arm: left })).digest('hex')
    .localeCompare(createHash('sha256')
      .update(JSON.stringify({ seed, question_id, repetition, purpose: 'arm-order', arm: right })).digest('hex')));
}

export function validateQuestionSet(questions) {
  if (!Array.isArray(questions)) throw new Error('evaluation questions must be an array');
  const ids = new Set();
  for (const question of questions) {
    validateQuestion(question);
    if (ids.has(question.question_id)) throw new Error(`duplicate evaluation question_id: ${question.question_id}`);
    ids.add(question.question_id);
  }
}

export function executionPlan({ config, questions }) {
  validateQuestionSet(questions);
  return new Map(questions.flatMap(question => [1, 2].flatMap(repetition => {
    const order = armOrder({ seed: config.seed, question_id: question.question_id, repetition });
    return ARMS.map(arm => {
      const anonymous_order = order.indexOf(arm) + 1;
      const execution_id = executionId({ seed: config.seed, question_id: question.question_id, repetition, arm });
      return [execution_id, { execution_id, question_id: question.question_id, repetition, arm,
        anonymous_order, answer_kind: question.answer_kind }];
    });
  })));
}

function validExecution(execution, expected, final_answer_schema) {
  if (!expected || !execution || typeof execution !== 'object'
    || ['execution_id', 'question_id', 'repetition', 'arm', 'anonymous_order'].some(key => execution[key] !== expected[key])
    || execution.attempt !== 1) return false;
  if (!validateFinal(execution.answer, expected.answer_kind, final_answer_schema)) return false;
  if (!execution.termination || typeof execution.termination.reason !== 'string' || !execution.termination.reason) return false;
  return Boolean(execution.usage && Number.isFinite(execution.usage.tokens_consumed)
    && Number.isFinite(execution.elapsed_monotonic_ms));
}

function validReusedExecution(execution, expected, final_answer_schema) {
  return validExecution(execution, expected, final_answer_schema) && ['correctness', 'exact_citation_rate', 'confidently_wrong_rate']
    .every(name => Number.isFinite(execution.score?.[name]));
}

function validateConfig(config) {
  if (!Number.isInteger(config?.protocol?.turn_budget) || config.protocol.turn_budget < 1) throw new Error('configured turn budget required');
  if (!finalAnswerSchemaSupported(config.protocol.final_answer_schema)) throw new Error('configured final answer schema is unsupported');
  if (!Array.isArray(config.strata) || config.strata.length === 0) throw new Error('declared strata required');
  const seed = config?.seed;
  if (typeof seed === 'string' ? seed.trim().length === 0 : !Number.isFinite(seed)) throw new Error('a non-empty finite evaluation seed is required');
  if (config.repetitions !== undefined && config.repetitions !== 2) throw new Error('evaluation requires exactly two repetitions');
}

export function sealedKeyMap(keyRows) {
  if (!Array.isArray(keyRows)) throw new Error('sealed keys must be a JSONL row array');
  const keys = new Map();
  for (const key of keyRows) {
    if (!key || typeof key !== 'object' || Array.isArray(key) || typeof key.key_id !== 'string' || !key.key_id) {
      throw new Error('sealed key has no usable key_id');
    }
    if (keys.has(key.key_id)) throw new Error(`duplicate sealed key_id: ${key.key_id}`);
    keys.set(key.key_id, key);
  }
  return keys;
}

export function validateSealedKeys(questions, keys) {
  if (!(keys instanceof Map)) throw new Error('sealed keys must be indexed by key_id');
  for (const question of questions) {
    const key = keys.get(question.key_id);
    if (!key) throw new Error(`missing sealed key for question: ${question.question_id}`);
    if (key.answer_kind !== question.answer_kind) {
      throw new Error(`sealed key answer_kind does not match question: ${question.question_id}`);
    }
  }
}

function unavailableUsage() {
  return { provider_input_tokens: 0, provider_output_tokens: 0, tokens_consumed: 0, reported_cost_usd: null };
}

function modelUnavailableJudge(error, attempts, judge_usage) {
  return { scorer: 'blind-prose-judge/v1', correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0,
    model_unavailable: true, judge_usage, judge_event: { outcome: 'model_unavailable', attempts,
      message: String(error?.message ?? error).slice(0, 500) } };
}

function deterministicJudgeFailure(error, attempts, judge_usage) {
  return { scorer: 'blind-prose-judge/v1', correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0,
    judge_invalid: true, judge_usage, judge_event: { outcome: 'deterministic_judge_failure', attempts,
      message: String(error?.message ?? error).slice(0, 500) } };
}

async function scoreExecution({ key, execution, judge_runner, checkpoint }) {
  if (key.answer_kind !== 'prose') return scoreAnswer({ key, answer: execution.answer });
  const attemptEvents = [];
  let failure = null;
  let judgeUsage = unavailableUsage();
  let judgeCostComplete = true;
  const recordedJudgeUsage = () => ({ ...judgeUsage,
    reported_cost_usd: judgeCostComplete && Number.isFinite(judgeUsage.reported_cost_usd)
      ? judgeUsage.reported_cost_usd : null });
  const runner = { run: async request => {
    const retried = await retryModelCall({ call: () => judge_runner.run(request),
      attempts: 3, checkpoint: async event => {
        attemptEvents.push(event);
        await checkpoint?.({ type: 'judge_attempt', execution_id: execution.execution_id, event });
      } });
    if (retried.error) {
      judgeCostComplete = false;
      failure = { error: retried.error, error_class: retried.error_class, attempts: retried.attempts_used };
      return { earned_points: 0, available_points: 0 };
    }
    judgeUsage = tokenUsage(retried.result?.usage);
    if (attemptEvents.some(event => event.outcome === 'error') || !Number.isFinite(judgeUsage.reported_cost_usd)) {
      judgeCostComplete = false;
    }
    return retried.result;
  } };
  try {
    const score = await judgeProse({ key, answer: execution.answer, runner });
    if (failure) return failure.error_class === 'model_unavailable'
      ? modelUnavailableJudge(failure.error, failure.attempts, recordedJudgeUsage())
      : deterministicJudgeFailure(failure.error, failure.attempts, recordedJudgeUsage());
    return { ...score, judge_usage: recordedJudgeUsage(), retry_attempts: attemptEvents };
  } catch (error) {
    return failure?.error_class === 'model_unavailable'
      ? modelUnavailableJudge(failure.error, failure.attempts, recordedJudgeUsage())
      : deterministicJudgeFailure(error, attemptEvents, recordedJudgeUsage());
  }
}

export function validateEvaluationResult(result) {
  if (!result || result.schema !== 'evaluation-result/v2' || !Array.isArray(result.pairs)
    || !result.aggregate || typeof result.aggregate.label !== 'string') return false;
  return result.pairs.every(pair => typeof pair?.question_id === 'string' && typeof pair?.stratum === 'string'
    && Array.isArray(pair.repetitions)
    && pair.repetitions.every(repetition => Number.isInteger(repetition?.repetition)
      && ARMS.every(arm => repetition[arm] && typeof repetition[arm] === 'object')));
}

export async function runEvaluation({ config, questions, keys, model_runner, modelCall, arm_tools, judge_runner,
  createRunner, runners, completed = new Map(), pending = new Map(), checkpoint }) {
  validateConfig(config);
  validateQuestionSet(questions);
  validateSealedKeys(questions, keys);
  if (runners !== undefined || createRunner !== undefined || modelCall !== undefined) {
    throw new Error('runner factories and modelCall callbacks are prohibited; provide an injectable model_runner module');
  }
  if (typeof model_runner !== 'string' || !model_runner.startsWith('file:')) throw new Error('file URL model_runner required for isolated executions');
  for (const arm of ARMS) if (!arm_tools?.[arm]) throw new Error(`missing ${arm} arm tools`);
  const planned = executionPlan({ config, questions });
  for (const [id, execution] of completed) {
    if (!validReusedExecution(execution, planned.get(id), config.protocol.final_answer_schema)) {
      throw new Error('evaluation resume contains a mismatched or incomplete deterministic execution');
    }
  }
  for (const [id, execution] of pending) {
    if (completed.has(id) || !validExecution(execution, planned.get(id), config.protocol.final_answer_schema)) {
      throw new Error('evaluation resume contains a mismatched or incomplete deterministic execution');
    }
  }
  const createExecution = async ({ question, repetition, arm, anonymous_order }) => {
    const id = executionId({ seed: config.seed, question_id: question.question_id, repetition, arm });
    const expected = planned.get(id);
    if (expected?.anonymous_order !== anonymous_order) throw new Error('evaluation arm order does not match deterministic plan');
    const reused = completed.get(id) ?? pending.get(id);
    if (reused) return structuredClone(reused);
    const execution = { execution_id: id, question_id: question.question_id, repetition, arm, anonymous_order, attempt: 1 };
    const result = await executeArm({ question, arm, protocol: config.protocol, toolSchema: arm_tools[arm].schema,
      tools: arm_tools[arm].tools, model_runner, execution, nonce: id,
      checkpoint: event => checkpoint?.(event) });
    Object.assign(result, { execution_id: id, question_id: question.question_id, repetition, anonymous_order, attempt: 1 });
    await checkpoint?.({ type: 'execution', execution: result });
    return result;
  };
  const pairs = [];
  for (const question of questions) {
    const pair = { question_id: question.question_id, stratum: question.stratum, repetitions: [] };
    const key = keys.get(question.key_id);
    for (let repetition = 1; repetition <= 2; repetition += 1) {
      const order = armOrder({ seed: config.seed, question_id: question.question_id, repetition });
      const pairedExecution = { repetition };
      for (const [index, arm] of order.entries()) {
        const execution = await createExecution({ question, repetition, arm, anonymous_order: index + 1 });
        if (!execution.score) {
          execution.score = await scoreExecution({ key, execution, judge_runner,
            checkpoint: event => checkpoint?.(event) });
          await checkpoint?.({ type: 'score', execution_id: execution.execution_id, score: execution.score });
        }
        pairedExecution[arm] = execution;
      }
      pair.repetitions.push(pairedExecution);
    }
    pairs.push(pair);
  }
  const plan = questions.map(({ question_id, stratum }) => ({ question_id, stratum }));
  const result = { schema: 'evaluation-result/v2', seed: config.seed, pairs,
    aggregate: aggregatePairs({ pairs, plan, declared_strata: config.strata, seed: config.seed,
      bootstrap_samples: config.bootstrap_samples, repetitions: 2 }) };
  if (!validateEvaluationResult(result)) throw new Error('evaluation result does not match evaluation-result/v2');
  return result;
}
