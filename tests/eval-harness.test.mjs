import assert from 'node:assert/strict';
import { executeArm, renderPrompt, validTranscript, validateFinal } from '../tools/eval/protocol.mjs';
import { createArmContext, publicQuestion, validateQuestion } from '../tools/eval/isolation.mjs';
import { parseModelJson } from '../tools/eval/pi-model-runner.mjs';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveKey, gitRepository } from '../tools/eval/derive-keys.mjs';
import { judgeProse } from '../tools/eval/blind-judge.mjs';
import { armOrder, runEvaluation, sealedKeyMap } from '../tools/eval/run.mjs';
import { report, spending } from '../tools/eval/cli.mjs';
import { accountedUsage, aggregatePairs } from '../tools/eval/aggregate.mjs';
import { createJournal, readJournal } from '../tools/eval/journal.mjs';
import { runModelInFreshProcess } from '../tools/eval/model-process.mjs';
import { scoreExact } from '../tools/eval/score.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Fixture repositories are disposable, so any writable directory serves. the host runtime module worker sessions
// export ASCRYBE_SCRATCH_DIR, but this suite must also run in a plain checkout: a test that throws
// on a missing ambient variable is not hermetic, and proving hermetic measurement is what it is for.
const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
const protocol = { target_commit: 'a'.repeat(40), system_prompt: 'neutral', turn_budget: 12, final_answer_schema: { type: 'object' } };
const question = {
  question_id: 'q1', key_id: 'opaque-key', prompt: 'Which selected record?', answer_kind: 'set',
  stratum: 'map-covered', stratum_evidence: { producer_citations: [] },
  derivation: { adapter: 'yaml-records', specification: { collection_path: ['records'], where: { category: 'selected' }, project: 'name' } },
};
const witness = { path: 'records.yaml', line_start: 2, line_end: 2, quote: 'north' };
const key = { key_id: question.key_id, answer_kind: 'set', answer_units: ['north'], accepted_witnesses: [witness] };
const final = (value, confidence = 0.5) => ({ answer_kind: 'set', answer_units: [{ unit_id: 'u', value, confidence, citation_ids: ['c'] }], citations: [{ citation_id: 'c', ...witness }], abstained: false, abstention_reason: null, limitations: [] });
const modelRunner = new URL('./fixtures/eval-model-runner.mjs', import.meta.url).href;
const armTools = (filesystem, graph, both = graph) => ({
  filesystem: { schema: { stub_final: filesystem }, tools: {} },
  graph: { schema: { stub_final: graph }, tools: {} },
  both: { schema: { stub_final: both }, tools: {} },
});

const config = (seed = 7) => ({ protocol, seed, bootstrap_samples: 100, strata: ['map-covered'] });

async function evaluation(filesystem, graph, { seed = 7, both = graph } = {}) {
  return runEvaluation({ config: config(seed), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(filesystem, graph, both), model_runner: modelRunner });
}

const score = correctness => ({ correctness, exact_citation_rate: correctness, confidently_wrong_rate: 0 });
const completePair = ({ question_id = 'q1', stratum = 'map-covered' } = {}) => ({
  question_id, stratum, repetitions: [
    { repetition: 1, filesystem: { score: score(0) }, graph: { score: score(1) }, both: { score: score(1) } },
    { repetition: 2, filesystem: { score: score(0) }, graph: { score: score(1) }, both: { score: score(1) } },
  ],
});

function independentlySeededOrder(seed, repetition) {
  return armOrder({ seed, question_id: question.question_id, repetition });
}

test('publicQuestion admits only the closed prompt-safe question projection', () => {
  const visible = publicQuestion(question);
  assert.deepEqual(visible, { question_id: 'q1', prompt: 'Which selected record?', answer_kind: 'set' });
  assert.throws(() => validateQuestion({ ...question, answer_key: 'north' }), /unsupported fields/u);
  assert.throws(() => validateQuestion({ ...question, stratum_evidence: { answer_key: 'north' } }), /stratum_evidence is invalid/u);
  const prompt = renderPrompt(createArmContext({ question, arm: 'graph', toolSchema: {}, nonce: 'q1' }), protocol);
  assert.equal(JSON.stringify(prompt).includes('opaque-key'), false);
  assert.equal(JSON.stringify(prompt).includes('producer_citations'), false);
});

test('deriveKey_uses_committed_fixture_without_graph_surface', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-fixture-'));
  cpSync(join(root, 'tests/fixtures/eval-repository'), directory, { recursive: true });
  for (const args of [['init'], ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'Add fixture']]) {
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  let graphCalls = 0;
  const repository = gitRepository({ directory, commit });
  const result = await deriveKey({ question, config: { source: 'fixture' }, repository, target_commit: commit,
    graph: { query() { graphCalls += 1; throw new Error('graph must not be consulted'); } } });
  assert.deepEqual(result.key.answer_units, ['north']);
  assert.equal(graphCalls, 0);
  assert.equal(result.receipt.target_commit, commit);
  assert.equal(result.receipt.inputs[0].path, 'records.yaml');
});

test('runEvaluation_reports_favourable_when_graph_is_correct', async () => {
  const result = await evaluation(final('wrong'), final('north'));
  assert.equal(result.aggregate.label, 'favourable');
  const firstRepetition = result.pairs[0].repetitions[0];
  assert.equal(firstRepetition.filesystem.turns_used, firstRepetition.graph.turns_used);
  assert.equal(firstRepetition.filesystem.turns_used, firstRepetition.both.turns_used);
  assert.notEqual(firstRepetition.filesystem.transcript, firstRepetition.graph.transcript);
});

test('runEvaluation_reports_null_when_arms_tie', async () => {
  const result = await evaluation(final('north'), final('north'));
  assert.equal(result.aggregate.label, 'null');
});

test('runEvaluation_reports_unfavourable_when_graph_is_confidently_wrong', async () => {
  const result = await evaluation(final('north'), final('wrong', 0.9));
  assert.equal(result.aggregate.label, 'unfavourable');
});

test('runEvaluation rejects missing or mismatched sealed keys before model dispatch', async () => {
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question], keys: new Map(),
    arm_tools: armTools(final('north'), final('north')), model_runner: 'file:///must-not-run.mjs' }),
  /missing sealed key for question/u);
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question],
    keys: new Map([[key.key_id, { ...key, answer_kind: 'prose' }]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: 'file:///must-not-run.mjs' }),
  /answer_kind does not match/u);
  assert.throws(() => sealedKeyMap([key, key]), /duplicate sealed key_id/u);
});

test('runEvaluation rejects duplicate question IDs before any arm checkpoint', async () => {
  let checkpoints = 0;
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question, { ...question, prompt: 'A distinct duplicate' }],
    keys: new Map([[key.key_id, key]]), arm_tools: armTools(final('north'), final('north')),
    model_runner: 'file:///must-not-run.mjs', checkpoint: () => { checkpoints += 1; } }),
  /duplicate evaluation question_id: q1/u);
  assert.equal(checkpoints, 0);
});

test('runEvaluation creates a fresh process for every paired execution and rejects callback reuse', async () => {
  const result = await evaluation(final('north'), final('north'));
  const executions = result.pairs[0].repetitions.flatMap(pair => [pair.filesystem, pair.graph, pair.both]);
  const executionIds = executions.map(execution => execution.execution_id);
  assert.equal(new Set(executionIds).size, 6);
  assert.equal(new Set(executions.map(execution => execution.transcript[0].emission.worker_pid)).size, 6);
  const sameSeed = await evaluation(final('north'), final('north'));
  assert.deepEqual(sameSeed.pairs[0].repetitions.flatMap(pair => [pair.filesystem.execution_id, pair.graph.execution_id, pair.both.execution_id]).sort(), [...executionIds].sort());
  let backendCalls = 0;
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: modelRunner,
    modelCall() { backendCalls += 1; return { final: final('north') }; } }), /modelCall callbacks are prohibited/);
  assert.equal(backendCalls, 0);
});

test('runEvaluation rejects an absent or invalid seed before model calls', async () => {
  for (const seed of [undefined, '', '   ', Number.NaN]) {
    let calls = 0;
    await assert.rejects(() => runEvaluation({ config: { ...config(), seed }, questions: [question], keys: new Map([[key.key_id, key]]),
      arm_tools: armTools(final('north'), final('north')), model_runner: modelRunner,
      modelCall() { calls += 1; return { final: final('north') }; } }), /evaluation seed/);
    assert.equal(calls, 0);
  }
});

test('runEvaluation rejects semantically mismatched or incomplete resumed executions before a model call', async () => {
  const prior = await evaluation(final('north'), final('north'));
  const execution = structuredClone(prior.pairs[0].repetitions[0].filesystem);
  const completed = new Map([[execution.execution_id, { ...execution, anonymous_order: 99 }]]);
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: modelRunner, completed }),
  /mismatched or incomplete deterministic execution/u);
  const incomplete = new Map([[execution.execution_id, { ...execution, score: { correctness: 1 } }]]);
  await assert.rejects(() => runEvaluation({ config: config(), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: modelRunner, completed: incomplete }),
  /mismatched or incomplete deterministic execution/u);
});

test('runEvaluation resumes a fsynced arm execution by scoring it without rerunning the arm', async () => {
  const prior = await evaluation(final('north'), final('north'));
  const all = prior.pairs.flatMap(pair => pair.repetitions.flatMap(repetition =>
    [repetition.filesystem, repetition.graph, repetition.both]));
  const pendingExecution = structuredClone(all[0]);
  delete pendingExecution.score;
  const completed = new Map(all.slice(1).map(execution => [execution.execution_id, execution]));
  const result = await runEvaluation({ config: config(), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: 'file:///must-not-run.mjs', completed,
    pending: new Map([[pendingExecution.execution_id, pendingExecution]]) });
  const resumed = result.pairs.flatMap(pair => pair.repetitions.flatMap(repetition =>
    [repetition.filesystem, repetition.graph, repetition.both])).find(execution => execution.execution_id === pendingExecution.execution_id);
  assert.equal(resumed.termination.reason, 'final');
  assert.equal(resumed.score.correctness, 1);
});

test('runEvaluation checkpoints actual arm and score payloads accepted by the journal', async () => {
  const checkpoints = [];
  const result = await runEvaluation({ config: config(), questions: [question], keys: new Map([[key.key_id, key]]),
    arm_tools: armTools(final('north'), final('north')), model_runner: modelRunner,
    checkpoint: event => checkpoints.push(structuredClone(event)) });
  assert.equal(result.aggregate.label, 'null');
  assert.equal(checkpoints.some(event => event.type === 'arm_event' && event.event.type === 'model_attempt'), true);
  assert.equal(checkpoints.some(event => event.type === 'arm_event' && event.event.type === 'model_emission'), true);
  const directory = mkdtempSync(join(scratch, 'eval-produced-journal-'));
  let journal;
  try {
    journal = await createJournal({ path: join(directory, 'journal.jsonl'), immutable: { source: 'producer-test' } });
    for (const [index, checkpoint] of checkpoints.entries()) {
      const { type, ...payload } = checkpoint;
      try { await journal.append(type, payload); }
      catch (error) { throw new Error(`journal rejected checkpoint ${index} (${type}): ${error.message}`); }
    }
    await journal.close(); journal = null;
    assert.equal((await readJournal(join(directory, 'journal.jsonl'))).length, checkpoints.length + 1);
  } finally {
    await journal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runEvaluation follows the independently seeded arm order', async () => {
  let seed = 0;
  while (independentlySeededOrder(seed, 1).join() === independentlySeededOrder(seed, 2).join()) seed += 1;
  const result = await evaluation(final('north'), final('north'), { seed });
  const observed = result.pairs[0].repetitions.map(pair => [pair.filesystem, pair.graph, pair.both]
    .sort((left, right) => left.anonymous_order - right.anonymous_order).map(execution => execution.arm));
  assert.deepEqual(observed, [independentlySeededOrder(seed, 1), independentlySeededOrder(seed, 2)]);
  assert.deepEqual(result.pairs[0].repetitions.flatMap(pair => [pair.filesystem, pair.graph, pair.both]
    .sort((left, right) => left.anonymous_order - right.anonymous_order).map(execution => execution.anonymous_order)), [1, 2, 3, 1, 2, 3]);
});

test('aggregatePairs rejects studies missing a repetition or declared stratum', () => {
  const plan = [{ question_id: 'q1', stratum: 'map-covered' }];
  const missingRepetition = completePair();
  missingRepetition.repetitions.pop();
  const incomplete = aggregatePairs({ pairs: [missingRepetition], plan, declared_strata: ['map-covered'], seed: 7, bootstrap_samples: 100 });
  assert.equal(incomplete.label, 'invalid experiment');
  assert.ok(incomplete.invalid_reasons.some(reason => reason.code === 'missing_repetition'));
  const missingStratum = aggregatePairs({ pairs: [completePair()], plan, declared_strata: ['map-covered', 'known-gap'], seed: 7, bootstrap_samples: 100 });
  assert.equal(missingStratum.label, 'invalid experiment');
  assert.ok(missingStratum.invalid_reasons.some(reason => reason.code === 'missing_declared_stratum'));
});

test('aggregate labels require the unfavorable interval endpoint to be entirely adverse', () => {
  const plan = [{ question_id: 'q1', stratum: 'map-covered' }, { question_id: 'q2', stratum: 'map-covered' }];
  const pair = (question_id, values) => ({ question_id, stratum: 'map-covered', repetitions: [1, 2].map(repetition => ({ repetition,
    filesystem: { score: { correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } },
    graph: { score: { correctness: 0, exact_citation_rate: values.graphCitation ?? 0, confidently_wrong_rate: 0 } },
    both: { score: { correctness: 0, exact_citation_rate: values.citation ?? 0, confidently_wrong_rate: values.wrong ?? 0 } },
  })) });
  const wrongCrossesZero = aggregatePairs({ pairs: [pair('q1', { wrong: 1 }), pair('q2', {})], plan,
    declared_strata: ['map-covered'], seed: 3, bootstrap_samples: 400 });
  assert.equal(wrongCrossesZero.effects.both_minus_filesystem.confidently_wrong_rate.interval[0], 0);
  assert.equal(wrongCrossesZero.label, 'null');
  const citationCrossesThreshold = aggregatePairs({ pairs: [pair('q1', { citation: -0.1 }), pair('q2', {})], plan,
    declared_strata: ['map-covered'], seed: 3, bootstrap_samples: 400 });
  assert.equal(citationCrossesThreshold.effects.both_minus_filesystem.exact_citation_rate.interval[1], 0);
  assert.equal(citationCrossesThreshold.label, 'null');
});

test('aggregate retains asymmetric unavailable arms in invalidity effects', () => {
  const unavailable = { termination: { reason: 'model_unavailable' }, score: { correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } };
  const available = { termination: { reason: 'final' }, score: { correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } };
  const aggregate = aggregatePairs({ pairs: [{ question_id: 'q1', stratum: 'map-covered', repetitions: [
    { repetition: 1, filesystem: available, graph: available, both: unavailable },
    { repetition: 2, filesystem: available, graph: available, both: available },
  ] }], plan: [{ question_id: 'q1', stratum: 'map-covered' }], declared_strata: ['map-covered'],
  seed: 3, bootstrap_samples: 100 });
  assert.equal(aggregate.effects.both_minus_filesystem.invalidity.point, 0.5);
  assert.equal(aggregate.effects.graph_minus_filesystem.invalidity.point, 0);
  assert.equal(aggregate.by_stratum['map-covered'].both_minus_graph.invalidity.point, 0.5);
});

test('aggregate preserves unavailable spend and excludes it from paired effects', () => {
  const execution = cost => ({ termination: { reason: 'final' }, usage: { reported_cost_usd: cost },
    score: { correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } });
  const aggregate = aggregatePairs({ pairs: [{ question_id: 'q1', stratum: 'map-covered', repetitions: [
    { repetition: 1, filesystem: execution(0.01), graph: execution(0.02), both: execution(null) },
    { repetition: 2, filesystem: execution(0.01), graph: execution(0.02), both: execution(null) },
  ] }], plan: [{ question_id: 'q1', stratum: 'map-covered' }], declared_strata: ['map-covered'],
  seed: 3, bootstrap_samples: 100 });
  const spend = aggregate.effects.both_minus_filesystem.spend;
  assert.equal(aggregate.descriptive.overall.both_minus_filesystem.spend.both, null);
  assert.equal(aggregate.descriptive.overall.both_minus_filesystem.spend.filesystem, 0.01);
  assert.equal(aggregate.descriptive.overall.both_minus_filesystem.spend.point, null);
  assert.deepEqual(spend, { point: null, interval: [null, null], valid_pair_count: 0 });
});

test('judge usage contributes to paired token and spend metrics', () => {
  const execution = { usage: { provider_input_tokens: 11, provider_output_tokens: 5, tokens_consumed: 16, reported_cost_usd: 0.03 },
    score: { judge_usage: { provider_input_tokens: 7, provider_output_tokens: 3, tokens_consumed: 10, reported_cost_usd: 0.02 } } };
  assert.deepEqual(accountedUsage(execution), { provider_input_tokens: 18, provider_output_tokens: 8,
    tokens_consumed: 26, reported_cost_usd: 0.05 });
  const pairs = [{ question_id: 'q1', stratum: 'map-covered', repetitions: [1, 2].map(repetition => ({ repetition,
    filesystem: { ...execution, termination: { reason: 'final' }, answer: { abstained: false }, score: { ...execution.score, correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } },
    graph: { ...execution, termination: { reason: 'final' }, answer: { abstained: false }, score: { ...execution.score, correctness: 0, exact_citation_rate: 0, confidently_wrong_rate: 0 } },
    both: { ...execution, termination: { reason: 'final' }, answer: { abstained: false }, score: { ...execution.score, correctness: 1, exact_citation_rate: 1, confidently_wrong_rate: 0 } },
  })) }];
  const aggregate = aggregatePairs({ pairs, plan: [{ question_id: 'q1', stratum: 'map-covered' }],
    declared_strata: ['map-covered'], seed: 1, bootstrap_samples: 20 });
  assert.equal(aggregate.descriptive.overall.both_minus_filesystem.tokens_consumed.both, 26);
  assert.equal(aggregate.descriptive.overall.both_minus_filesystem.spend.both, 0.05);
});

test('judgeProse derives citation and confident-wrong metrics without arm identity', async () => {
  let request;
  const score = await judgeProse({ key: { answer_kind: 'prose', rubric: { points: 1 } },
    answer: { answer_units: [
      { unit_id: 'x', value: 'unsupported proposition', confidence: 0.9, citation_ids: ['c'] },
      { unit_id: 'y', value: 'supported proposition', confidence: 0.4, citation_ids: ['c'] },
    ], citations: [{ citation_id: 'c', path: 'records.yaml', line_start: 2, line_end: 2, quote: 'north' }] },
    runner: { async run(value) {
      request = value;
      return { result: { earned_points: 1, available_points: 1,
        citation_assessments: [{ unit_id: 'x', supported: false }, { unit_id: 'y', supported: true }],
        factual_assessments: [{ unit_id: 'x', disposition: 'unsupported_or_false' }, { unit_id: 'y', disposition: 'supported' }] },
      usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 0.02 } }, stderr: 'judge diagnostic' };
    } } });
  assert.equal(score.correctness, 1);
  assert.equal(score.exact_citation_rate, 0.5);
  assert.equal(score.confidently_wrong_rate, 0.5);
  assert.equal(score.judge_stderr, 'judge diagnostic');
  assert.deepEqual(score.judge_usage, { provider_input_tokens: 7, provider_output_tokens: 3,
    tokens_consumed: 10, reported_cost_usd: 0.02 });
  assert.deepEqual(request.citation_records, [{ citation_id: 'c', path: 'records.yaml', line_start: 2, line_end: 2, quote: 'north' }]);
  assert.equal(JSON.stringify(request).includes('filesystem'), false);
  assert.equal(JSON.stringify(request).includes('graph'), false);
  assert.equal(JSON.stringify(request).includes('arm'), false);
});

test('a throwing arm tool costs a turn and does not abort the execution', async () => {
  // The default fixture finalizes on turn one and therefore never reaches a tool; this one calls a
  // tool first, which is the only way to exercise an invocation failure.
  const runner = new URL('./fixtures/eval-tool-caller.mjs', import.meta.url).href;
  let calls = 0;
  const result = await executeArm({
    question: { question_id: 'QT', key_id: 'k', prompt: 'q', answer_kind: 'prose', stratum: 'test' },
    arm: 'graph',
    protocol: { turn_budget: 3, system_prompt: 's', target_commit: 'c', final_answer_schema: {}, model: null },
    toolSchema: { allowed_tool_names: ['estate_query'] },
    tools: { estate_query: async () => { calls += 1; throw new Error('search term required'); } },
    model_runner: runner,
    execution: { execution_id: 'x' },
    nonce: 'n',
  });
  assert.ok(calls >= 1, 'the failing tool was actually invoked');
  assert.ok(result.transcript.some(event => event.tool_error === 'EVAL_TOOL_INVOCATION_FAILED'),
    'the invocation failure is recorded in the transcript');
  assert.equal(validTranscript(result.transcript), true);
});

test('tool policy transcript events carry the required null tool field', async () => {
  const result = await executeArm({ question, arm: 'graph', protocol,
    toolSchema: { allowed_tool_names: [], stub_final: final('north') }, tools: {},
    model_runner: new URL('./fixtures/eval-tool-caller.mjs', import.meta.url).href,
    execution: { execution_id: 'policy' }, nonce: 'policy' });
  const policy = result.transcript.find(event => event.tool_error === 'EVAL_TOOL_POLICY');
  assert.deepEqual(policy, { type: 'tool_error', turn: 1, tool: null, tool_error: 'EVAL_TOOL_POLICY' });
  assert.equal(validTranscript(result.transcript), true);
});

test('successful arm checkpoints retain bounded provider stderr', async () => {
  const result = await executeArm({ question, arm: 'graph', protocol,
    toolSchema: { stub_final: final('north') }, tools: {},
    model_runner: new URL('./fixtures/eval-stderr-runner.mjs', import.meta.url).href,
    execution: { execution_id: 'stderr' }, nonce: 'stderr' });
  assert.equal(result.transcript[0].stderr, 'provider diagnostic');
});

test('partial arm provider totals remain unavailable in either turn order', async () => {
  const runner = new URL('./fixtures/eval-cost-runner.mjs', import.meta.url).href;
  for (const reported_costs of [[0.01, null], [null, 0.01]]) {
    const result = await executeArm({ question, arm: 'graph', protocol,
      toolSchema: { allowed_tool_names: ['probe'], two_turn: true, reported_costs, stub_final: final('north') },
      tools: { probe: async () => ({ ok: true }) }, model_runner: runner,
      execution: { execution_id: `partial-${reported_costs[0]}` }, nonce: `partial-${reported_costs[0]}` });
    assert.equal(result.usage.reported_cost_usd, null);
  }
});

test('an unpriced retried arm attempt makes reported cost unavailable', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-retry-cost-'));
  try {
    const result = await executeArm({ question, arm: 'graph', protocol,
      toolSchema: { allowed_tool_names: ['probe'], two_turn: true, reported_costs: [0.01, 0.02],
        retry_marker: join(directory, 'first-attempt'), stub_final: final('north') },
      tools: { probe: async () => ({ ok: true }) },
      model_runner: new URL('./fixtures/eval-cost-runner.mjs', import.meta.url).href,
      execution: { execution_id: 'retried-cost' }, nonce: 'retried-cost', model_attempts: 2 });
    assert.equal(result.usage.reported_cost_usd, null);
    assert.equal(result.transcript[0].retry_attempts.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing judge totals make reported spend unavailable in the final report', async () => {
  const proseQuestion = { ...question, answer_kind: 'prose' };
  const proseFinal = { answer_kind: 'prose', answer_units: [{ unit_id: 'u', value: 'north', confidence: 0.5, citation_ids: [] }],
    citations: [], abstained: false, abstention_reason: null, limitations: [] };
  const costedArm = { schema: { stub_final: proseFinal, reported_costs: [0.01] }, tools: {} };
  const judge_runner = { async run() {
    return { result: { earned_points: 1, available_points: 1,
      citation_assessments: [{ unit_id: 'u', supported: true }],
      factual_assessments: [{ unit_id: 'u', disposition: 'supported' }] }, usage: { totalTokens: 1 } };
  } };
  const result = await runEvaluation({ config: config(), questions: [proseQuestion],
    keys: new Map([[key.key_id, { answer_kind: 'prose', rubric: { points: 1 } }]]),
    arm_tools: { filesystem: costedArm, graph: costedArm, both: costedArm },
    model_runner: new URL('./fixtures/eval-cost-runner.mjs', import.meta.url).href, judge_runner });
  const rows = result.pairs.flatMap(pair => pair.repetitions.flatMap(repetition =>
    [repetition.filesystem, repetition.graph, repetition.both]));
  const scores = rows.map(execution => execution.score);
  assert.equal(scores.every(score => score.correctness === 1 && score.exact_citation_rate === 0
    && score.confidently_wrong_rate === 0), true);
  assert.equal(scores.every(score => score.judge_usage.tokens_consumed === 1), true);
  const spend = spending(rows);
  assert.equal(spend.actual_usd, null);
  assert.equal(spend.actual_spend_status, 'unavailable-from-Pi-text-mode');
  assert.match(report(result, rows, spend), /actual unavailable/u);
});

test('typed model exhaustion is retried and is the only arm path labeled model_unavailable', async () => {
  const runner = new URL('./fixtures/eval-model-unavailable-runner.mjs', import.meta.url).href;
  const result = await executeArm({ question: { question_id: 'QT', key_id: 'k', prompt: 'q', answer_kind: 'set', stratum: 'test' }, arm: 'graph',
    protocol: { turn_budget: 3, system_prompt: 's', target_commit: 'c', final_answer_schema: {}, model: null },
    toolSchema: { allowed_tool_names: [] }, tools: {}, model_runner: runner, execution: { execution_id: 'x' },
    nonce: 'n', model_attempts: 2 });
  assert.equal(result.termination.reason, 'model_unavailable');
  assert.equal(result.termination.attempts, 2);
  assert.equal(result.transcript[0].retry_attempts.length, 2);
});

test('typed judge exhaustion uses the same bounded retry policy', async () => {
  const proseQuestion = { ...question, answer_kind: 'prose' };
  const proseFinal = { answer_kind: 'prose', answer_units: [{ unit_id: 'u', value: 'north', confidence: 0.5, citation_ids: [] }],
    citations: [], abstained: false, abstention_reason: null, limitations: [] };
  let calls = 0;
  const judge_runner = { async run() {
    calls += 1;
    const error = new Error('provider unavailable'); error.code = 'EVAL_MODEL_UNAVAILABLE'; throw error;
  } };
  const result = await runEvaluation({ config: config(), questions: [proseQuestion],
    keys: new Map([[key.key_id, { answer_kind: 'prose', rubric: { points: 1 } }]]),
    arm_tools: armTools(proseFinal, proseFinal), model_runner: modelRunner, judge_runner });
  const scores = result.pairs[0].repetitions.flatMap(repetition => [repetition.filesystem, repetition.graph, repetition.both]
    .map(execution => execution.score));
  assert.equal(scores.every(score => score.model_unavailable), true);
  assert.equal(scores.every(score => score.judge_event.attempts === 3), true);
  assert.equal(calls, 18);
});

test('validateFinal enforces the configured answer schema and citation integrity', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['answer_kind', 'answer_units', 'citations', 'abstained', 'abstention_reason', 'limitations'],
    properties: { answer_kind: { const: 'set' }, answer_units: { type: 'array' }, citations: { type: 'array' },
      abstained: { const: false }, abstention_reason: { const: null }, limitations: { type: 'array' } } };
  assert.equal(validateFinal(final('north'), 'set', schema), true);
  assert.equal(validateFinal({ ...final('north'), answer_units: [final('north').answer_units[0], final('north').answer_units[0]] }, 'set', schema), false);
  assert.equal(validateFinal({ ...final('north'), answer_units: [{ ...final('north').answer_units[0], citation_ids: ['missing'] }] }, 'set', schema), false);
  assert.equal(validateFinal({ ...final('north'), unreviewed: true }, 'set', schema), false);
  assert.equal(validateFinal(final('north'), 'set', { $ref: 'ignored-schema' }), false);
});

test('model JSON is recovered from fenced and prose-wrapped output', async () => {
  const bare = parseModelJson('{"final":{"answer_kind":"prose"}}');
  assert.equal(bare.final.answer_kind, 'prose');
  const fenced = parseModelJson('Here you go:\n```json\n{"tool_call":{"name":"estate_query"}}\n```\nhope that helps');
  assert.equal(fenced.tool_call.name, 'estate_query');
  const wrapped = parseModelJson('I will search. {"tool_call":{"name":"read_file"}} done.');
  assert.equal(wrapped.tool_call.name, 'read_file');
  const repeated = parseModelJson('{"tool_call":{"name":"first","arguments":{"note":"a } inside a JSON string"}}}{"tool_call":{"name":"second"}}');
  assert.equal(repeated.tool_call.name, 'first');
  assert.throws(() => parseModelJson('no object here at all'), /model output was not JSON/u);
});

test('model worker receives only the reviewed environment allowlist', async () => {
  const prior = process.env.ASCRYBE_NEO4J_PASSWORD;
  process.env.ASCRYBE_NEO4J_PASSWORD = 'must-not-cross';
  try {
    const result = await runModelInFreshProcess({
      model_runner: new URL('./fixtures/eval-environment-runner.mjs', import.meta.url).href,
      request: {},
    });
    assert.equal(result.environment.ASCRYBE_NEO4J_PASSWORD, undefined);
    assert.equal(typeof result.environment.PATH, 'string');
  } finally {
    if (prior === undefined) delete process.env.ASCRYBE_NEO4J_PASSWORD;
    else process.env.ASCRYBE_NEO4J_PASSWORD = prior;
  }
});

test('blind judge rejects impossible points and cannot credit an uncited unit', async () => {
  const answer = { answer_units: [{ unit_id: 'u', value: 'claim', confidence: 0.9, citation_ids: [] }], citations: [] };
  const response = { earned_points: 1, available_points: 1,
    citation_assessments: [{ unit_id: 'u', supported: true }],
    factual_assessments: [{ unit_id: 'u', disposition: 'supported' }] };
  const score = await judgeProse({ key: { answer_kind: 'prose', rubric: {} }, answer,
    runner: { run: async () => response } });
  assert.equal(score.exact_citation_rate, 0);
  await assert.rejects(() => judgeProse({ key: { answer_kind: 'prose', rubric: {} }, answer,
    runner: { run: async () => ({ ...response, earned_points: 2 }) } }), /invalid score/u);
});

test('deterministic judge failure invalidates rather than scores a comparison', async () => {
  const proseQuestion = { ...question, answer_kind: 'prose' };
  const proseFinal = { answer_kind: 'prose', answer_units: [{ unit_id: 'u', value: 'north', confidence: 0.5, citation_ids: [] }],
    citations: [], abstained: false, abstention_reason: null, limitations: [] };
  const result = await runEvaluation({ config: config(), questions: [proseQuestion],
    keys: new Map([[key.key_id, { answer_kind: 'prose', rubric: {} }]]),
    arm_tools: armTools(proseFinal, proseFinal), model_runner: modelRunner,
    judge_runner: { run: async () => ({ earned_points: 2, available_points: 1 }) } });
  assert.equal(result.aggregate.invalid_pair_count, 1);
  assert.equal(result.aggregate.invalid_reasons.every(reason => reason.code === 'deterministic_judge_failure'), true);
});

test('exact scoring deduplicates equivalent values and requires an exact quote', () => {
  const answer = final('north');
  answer.answer_units.push({ ...answer.answer_units[0], unit_id: 'duplicate' });
  assert.equal(scoreExact({ key, answer }).exact_citation_rate, 1);
  answer.citations[0].quote = null;
  assert.equal(scoreExact({ key, answer }).exact_citation_rate, 0);
});
