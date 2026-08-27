import { tokenUsage } from './protocol.mjs';

function anonymizedUnits(answer) {
  return (answer.answer_units ?? []).map(({ unit_id, value, confidence, citation_ids }) =>
    ({ unit_id, value, confidence, citation_ids: [...(citation_ids ?? [])] }));
}

function citationRecords(answer) {
  return (answer.citations ?? []).map(({ citation_id, path, line_start, line_end, quote }) =>
    ({ citation_id, path, line_start, line_end, quote }));
}

function assessments(response, units, field, valid) {
  const records = response?.[field];
  if (!Array.isArray(records) || records.length !== units.length) throw new Error(`judge returned invalid ${field}`);
  const byUnit = new Map();
  for (const record of records) {
    if (!record || typeof record.unit_id !== 'string' || byUnit.has(record.unit_id) || !valid(record)) {
      throw new Error(`judge returned invalid ${field}`);
    }
    byUnit.set(record.unit_id, record);
  }
  if (byUnit.size !== units.length || units.some(unit => !byUnit.has(unit.unit_id))) {
    throw new Error(`judge returned invalid ${field}`);
  }
  return byUnit;
}

export async function judgeProse({ key, answer, runner }) {
  if (key.answer_kind !== 'prose') throw new Error('blind judge accepts prose keys only');
  const answer_units = anonymizedUnits(answer);
  const request = {
    task: 'score one anonymized answer against one rubric',
    rubric: key.rubric,
    source_excerpts: key.source_excerpts ?? [],
    answer_units,
    citation_records: citationRecords(answer),
  };
  const runnerResponse = await runner.run(request);
  const response = runnerResponse?.result ?? runnerResponse;
  if (!Number.isFinite(response?.earned_points) || !Number.isFinite(response?.available_points)
    || response.available_points <= 0 || response.earned_points < 0
    || response.earned_points > response.available_points) {
    throw new Error('judge returned invalid score');
  }
  const citation = assessments(response, answer_units, 'citation_assessments', record => typeof record.supported === 'boolean');
  const factual = assessments(response, answer_units, 'factual_assessments', record =>
    ['supported', 'unsupported_or_false', 'not_assessable'].includes(record.disposition));
  const exact_citation_rate = answer_units.length ? answer_units.filter(unit => unit.citation_ids.length > 0
    && citation.get(unit.unit_id).supported).length / answer_units.length : 0;
  const confidently_wrong_rate = answer_units.length ? answer_units.filter(unit => Number(unit.confidence) >= 0.8
    && factual.get(unit.unit_id).disposition === 'unsupported_or_false').length / answer_units.length : 0;
  return {
    scorer: 'blind-prose-judge/v1', correctness: response.available_points ? response.earned_points / response.available_points : 0,
    exact_citation_rate, confidently_wrong_rate,
    earned_points: response.earned_points, available_points: response.available_points, judge_event: response,
    judge_usage: tokenUsage(runnerResponse?.usage),
    judge_stderr: runnerResponse?.result !== undefined && runnerResponse.stderr ? String(runnerResponse.stderr).slice(-8_192) : null,
  };
}

export { anonymizedUnits };
