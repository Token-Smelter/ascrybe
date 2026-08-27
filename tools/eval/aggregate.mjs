import { createHash } from 'node:crypto';
const ARMS = Object.freeze(['filesystem', 'graph', 'both']);

const EFFECTS = Object.freeze(['both_minus_filesystem', 'graph_minus_filesystem', 'both_minus_graph']);
const EFFECT_PAIRS = Object.freeze({
  both_minus_filesystem: ['both', 'filesystem'],
  graph_minus_filesystem: ['graph', 'filesystem'],
  both_minus_graph: ['both', 'graph'],
});
const METRICS = Object.freeze(['correctness', 'exact_citation_rate', 'confidently_wrong_rate', 'abstention',
  'tokens_consumed', 'wall_clock_ms', 'invalidity', 'spend']);

function quantile(values, fraction) {
  const index = Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1));
  return [...values].sort((a, b) => a - b)[index];
}
function rng(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
}
function average(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function completeFiniteAverage(values) {
  return values.length && values.every(Number.isFinite) ? average(values) : null;
}
function stratifiedInterval(differences, seed, samples) {
  const random = rng(seed); const means = [];
  const strata = [...differences.keys()].sort();
  const questionCount = [...differences.values()].reduce((total, values) => total + values.length, 0);
  if (!questionCount) return [null, null];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (const stratum of strata) {
      const values = differences.get(stratum);
      for (let index = 0; index < values.length; index += 1) total += values[Math.floor(random() * values.length)];
    }
    means.push(total / questionCount);
  }
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

function invalidExperiment(reasons) {
  return { label: 'invalid experiment', invalid_pair_count: new Set(reasons.map(reason => reason.question_id).filter(Boolean)).size,
    invalid_reasons: reasons };
}
function studyProblems({ pairs, plan, declared_strata, repetitions }) {
  const problems = [];
  if (!Array.isArray(plan) || !plan.length) problems.push({ code: 'missing_question_plan' });
  if (!Array.isArray(declared_strata) || !declared_strata.length) problems.push({ code: 'missing_declared_strata' });
  if (repetitions !== 2) problems.push({ code: 'invalid_repetition_plan' });
  const declared = new Set(declared_strata);
  if (declared.size !== declared_strata?.length) problems.push({ code: 'duplicate_declared_stratum' });
  const planned = new Map();
  for (const question of plan ?? []) {
    if (!question?.question_id || !declared.has(question.stratum)) problems.push({ code: 'planned_question_missing_declared_stratum', question_id: question?.question_id });
    else if (planned.has(question.question_id)) problems.push({ code: 'duplicate_planned_question', question_id: question.question_id });
    else planned.set(question.question_id, question);
  }
  for (const stratum of declared) if (![...planned.values()].some(question => question.stratum === stratum)) problems.push({ code: 'missing_declared_stratum', stratum });
  const observed = new Map();
  for (const pair of pairs ?? []) {
    if (!planned.has(pair?.question_id)) { problems.push({ code: 'unplanned_pair', question_id: pair?.question_id }); continue; }
    if (observed.has(pair.question_id)) { problems.push({ code: 'duplicate_pair', question_id: pair.question_id }); continue; }
    observed.set(pair.question_id, pair);
    if (pair.stratum !== planned.get(pair.question_id).stratum) problems.push({ code: 'pair_stratum_mismatch', question_id: pair.question_id });
    const seen = new Set();
    if (!Array.isArray(pair.repetitions) || pair.repetitions.length !== repetitions) problems.push({ code: 'missing_repetition', question_id: pair.question_id });
    for (const repetition of pair.repetitions ?? []) {
      if (!Number.isInteger(repetition?.repetition) || repetition.repetition < 1 || repetition.repetition > repetitions || seen.has(repetition.repetition)) problems.push({ code: 'invalid_repetition', question_id: pair.question_id });
      seen.add(repetition?.repetition);
      for (const arm of ARMS) if (!repetition?.[arm]) problems.push({ code: 'missing_arm_execution', question_id: pair.question_id, repetition: repetition?.repetition, arm });
    }
  }
  for (const question of planned.values()) if (!observed.has(question.question_id)) problems.push({ code: 'missing_pair', question_id: question.question_id });
  return problems;
}

function isInvalid(execution) { return execution?.termination?.reason === 'model_unavailable'
  || Boolean(execution?.score?.model_unavailable) || Boolean(execution?.score?.judge_invalid); }
function invalidCode(execution) { return execution?.score?.judge_invalid ? 'deterministic_judge_failure' : 'model_unavailable'; }

export function accountedUsage(execution) {
  const usages = [execution?.usage];
  if (execution?.score?.judge_usage !== undefined) usages.push(execution.score.judge_usage);
  const values = usages.filter(value => value && typeof value === 'object');
  const number = field => values.reduce((total, value) => total + (Number.isFinite(value[field]) ? value[field] : 0), 0);
  const reported = values.map(value => value.reported_cost_usd);
  return {
    provider_input_tokens: number('provider_input_tokens'),
    provider_output_tokens: number('provider_output_tokens'),
    tokens_consumed: number('tokens_consumed'),
    reported_cost_usd: values.length && reported.every(Number.isFinite)
      ? reported.reduce((total, value) => total + value, 0) : null,
  };
}

function metric(execution, name) {
  if (name === 'abstention') return Number(Boolean(execution?.answer?.abstained));
  if (name === 'tokens_consumed') return accountedUsage(execution).tokens_consumed;
  if (name === 'wall_clock_ms') return Number(execution?.elapsed_monotonic_ms ?? 0);
  if (name === 'invalidity') return Number(isInvalid(execution));
  if (name === 'spend') return accountedUsage(execution).reported_cost_usd;
  return Number(execution?.score?.[name] ?? 0);
}
function effectSummary(executions, effect) {
  const [positive, negative] = EFFECT_PAIRS[effect];
  return Object.fromEntries(METRICS.map(name => {
    const positiveValues = executions[positive].map(row => metric(row, name));
    const negativeValues = executions[negative].map(row => metric(row, name));
    const positiveValue = name === 'spend' ? completeFiniteAverage(positiveValues) : average(positiveValues);
    const negativeValue = name === 'spend' ? completeFiniteAverage(negativeValues) : average(negativeValues);
    return [name, { [positive]: positiveValue, [negative]: negativeValue,
      point: positiveValue == null || negativeValue == null ? null : positiveValue - negativeValue,
      ...(name === 'spend' ? { available_execution_count: { [positive]: positiveValues.filter(Number.isFinite).length,
        [negative]: negativeValues.filter(Number.isFinite).length } } : {}) }];
  }));
}
function executionsByStratum(pairs, declared_strata) {
  const grouped = Object.fromEntries([...declared_strata, 'overall'].map(key => [key, Object.fromEntries(ARMS.map(arm => [arm, []]))]));
  for (const pair of pairs) for (const repetition of pair.repetitions) for (const arm of ARMS) {
    grouped[pair.stratum][arm].push(repetition[arm]); grouped.overall[arm].push(repetition[arm]);
  }
  return grouped;
}
function pairedDifferences(pairs, declared_strata, effect, name) {
  const grouped = new Map(declared_strata.map(stratum => [stratum, []]));
  const [positive, negative] = EFFECT_PAIRS[effect];
  for (const pair of pairs) {
    // Quality comparisons exclude an unavailable model endpoint, but invalidity is itself the
    // outcome being measured. Filtering it would make every invalidity contrast zero.
    const available = name === 'invalidity' ? pair.repetitions
      : pair.repetitions.filter(row => !isInvalid(row[positive]) && !isInvalid(row[negative]));
    const repetitions = name === 'spend' ? available.filter(row => Number.isFinite(metric(row[positive], name))
      && Number.isFinite(metric(row[negative], name))) : available;
    if (repetitions.length) grouped.get(pair.stratum).push(average(repetitions
      .map(row => metric(row[positive], name) - metric(row[negative], name))));
  }
  return grouped;
}
function intervalResult(pairs, declared_strata, seed, samples, effect, name) {
  const differences = pairedDifferences(pairs, declared_strata, effect, name);
  const values = [...differences.values()].flat();
  return { point: values.length ? average(values) : null,
    interval: stratifiedInterval(differences, `${seed}:${effect}:${name}`, samples), valid_pair_count: values.length };
}

export function aggregatePairs({ pairs, plan, declared_strata, seed, bootstrap_samples, repetitions = 2 }) {
  const problems = studyProblems({ pairs, plan, declared_strata, repetitions });
  if (problems.length) return invalidExperiment(problems);
  const grouped = executionsByStratum(pairs, declared_strata);
  const descriptive = { overall: Object.fromEntries(EFFECTS.map(effect => [effect, effectSummary(grouped.overall, effect)])),
    by_stratum: Object.fromEntries(declared_strata.map(stratum => [stratum, Object.fromEntries(EFFECTS.map(effect => [effect, effectSummary(grouped[stratum], effect)]))])) };
  const primary = 'both_minus_filesystem';
  const intervalMetrics = (selectedPairs, strata) => Object.fromEntries(EFFECTS.map(effect => [effect,
    Object.fromEntries(METRICS.map(name => [name,
      intervalResult(selectedPairs, strata, seed, bootstrap_samples, effect, name)]))]));
  const result = {
    primary_effect: primary,
    effects: intervalMetrics(pairs, declared_strata),
    by_stratum: Object.fromEntries(declared_strata.map(stratum => [stratum,
      intervalMetrics(pairs.filter(pair => pair.stratum === stratum), [stratum])])),
    descriptive,
    invalid_pair_count: pairs.filter(pair => pair.repetitions.some(row => ARMS.some(arm => isInvalid(row[arm])))).length,
    invalid_reasons: pairs.flatMap(pair => pair.repetitions.flatMap(row => ARMS.filter(arm => isInvalid(row[arm])).map(arm => ({
      code: invalidCode(row[arm]), question_id: pair.question_id, repetition: row.repetition, arm,
    })))),
  };
  // Compatibility fields name only the preregistered primary comparison.
  result.correctness = result.effects[primary].correctness;
  result.exact_citation = result.effects[primary].exact_citation_rate;
  result.confidently_wrong = result.effects[primary].confidently_wrong_rate;
  const [low, high] = result.correctness.interval;
  const citationLow = result.exact_citation.interval[0];
  const citationHigh = result.exact_citation.interval[1];
  const wrongHigh = result.confidently_wrong.interval[1];
  const wrongLow = result.confidently_wrong.interval[0];
  result.label = low != null && low > 0 && citationLow >= -0.05 && wrongHigh <= 0 ? 'favourable'
    : high != null && (high < 0 || wrongLow > 0 || (result.correctness.point <= 0 && citationHigh < -0.05)) ? 'unfavourable' : 'null';
  return result;
}
