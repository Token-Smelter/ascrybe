const normalize = value => String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
const values = answer => [...new Set((answer?.answer_units ?? []).map(unit => normalize(unit.value)))].sort();

export { normalize };

export function scoreExact({ key, answer }) {
  const expected = [...new Set((key.answer_units ?? []).map(normalize))].sort();
  const returned = values(answer);
  const expectedSet = new Set(expected);
  const returnedSet = new Set(returned);
  const matches = returned.filter(value => expectedSet.has(value));
  const falseUnits = returned.filter(value => !expectedSet.has(value));
  const precision = returned.length ? matches.length / returned.length : 0;
  const recall = expected.length ? matches.length / expected.length : (returned.length ? 0 : 1);
  const unitsByValue = new Map();
  for (const unit of answer?.answer_units ?? []) {
    const value = normalize(unit.value);
    const prior = unitsByValue.get(value);
    if (!prior || Number(unit.confidence) > Number(prior.confidence)) unitsByValue.set(value, unit);
  }
  const confidentlyWrong = [...unitsByValue].filter(([value, unit]) =>
    !expectedSet.has(value) && Number(unit.confidence) >= 0.8).length;
  const citations = new Map((answer?.citations ?? []).map(citation => [citation.citation_id, citation]));
  const witnesses = key.accepted_witnesses ?? [];
  const citedCorrectly = [...unitsByValue].filter(([value, unit]) => expectedSet.has(value) &&
    unit.citation_ids.some(id => witnesses.some(witness => {
      const citation = citations.get(id);
      return citation?.path === witness.path && citation.line_start === witness.line_start && citation.line_end === witness.line_end &&
        citation.quote === witness.quote;
    }))).length;
  return {
    scorer: 'exact-normalized/v1', expected, returned, matches, false_units: falseUnits,
    correctness: Number(expected.length === returned.length && expected.every((value, index) => value === returned[index])),
    precision, recall, exact_citation_rate: witnesses.length ? citedCorrectly / Math.max(expected.length, returned.length) : 0,
    confidently_wrong_rate: returned.length ? confidentlyWrong / returned.length : 0,
  };
}

export function scoreAnswer({ key, answer, judge }) {
  if (key.answer_kind === 'prose') {
    if (!judge) throw new Error('prose scoring requires blind judge');
    return judge({ key, answer });
  }
  return scoreExact({ key, answer });
}
