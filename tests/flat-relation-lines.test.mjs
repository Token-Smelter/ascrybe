import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFlatRelationAnswer, repairUnescapedFlatQuotes, serializeFlatRelationAnswer,
} from '../tools/flat-relation-lines.mjs';

const claim = (surface, quote, mode = 'all_required') => ({
  subject_mention: { surface, source_locator: { block_token: 'b001', quote, context_before: null, context_after: null, occurrence: null } },
  predicate_family: 'states', object_or_value: quote, polarity: 'affirmed', modality: 'descriptive', quantifier: 'one',
  scope: {}, valid_time: {},
  support_sets: [{ mode, locators: [
    { role: 'primary', source_locator: { block_token: 'b001', quote, context_before: null, context_after: null, occurrence: null } },
    { role: 'context', source_locator: { block_token: 'b002', quote: `${quote} context`, context_before: null, context_after: null, occurrence: null } },
  ] }],
});

test('serialize/parse round-trips claims, evidence roles, and support mode', () => {
  const claims = [claim('alpha', 'the alpha rule is stated here'), claim('beta', 'the beta rule is stated here', 'alternative_support')];
  const answer = parseFlatRelationAnswer(serializeFlatRelationAnswer({ claims }));
  assert.equal(answer.rejected.length, 0);
  assert.equal(answer.proposals.length, 2);
  assert.deepEqual(answer.proposals.map(row => row.proposed.subject_mention.surface), ['alpha', 'beta']);
  assert.equal(answer.proposals[0].proposed.support_sets[0].mode, 'all_required');
  assert.equal(answer.proposals[1].proposed.support_sets[0].mode, 'alternative_support',
    'alternative_support survives the flat wire format');
  assert.deepEqual(answer.proposals[0].proposed.support_sets[0].locators.map(row => row.role), ['primary', 'context']);
});

test('flat wire preserves subject binding, occurrence selection, antecedent, and relation family', () => {
  const held = claim('DASHBOARD_PORT', 'the DASHBOARD_PORT rule is stated here');
  held.subject_binding = 'anaphoric';
  held.subject_occurrence = 's007';
  held.relation_family = 'configuration';
  held.subject_mention.antecedent_locator = { block_token: 'b002', quote: 'DASHBOARD_PORT', occurrence: 2 };
  const parsed = parseFlatRelationAnswer(serializeFlatRelationAnswer({ claims: [held] })).proposals[0].proposed;
  assert.equal(parsed.subject_binding, 'anaphoric');
  assert.equal(parsed.subject_occurrence, 's007');
  assert.equal(parsed.relation_family, 'configuration');
  assert.deepEqual(parsed.subject_mention.antecedent_locator, {
    block_token: 'b002', quote: 'DASHBOARD_PORT', context_before: null, context_after: null, occurrence: 2,
  });
});

test('every line-level defect is quarantined without harming its neighbours', () => {
  const good = serializeFlatRelationAnswer({ claims: [claim('alpha', 'the alpha rule is stated here')] });
  const lines = good.split('\n');
  const answer = parseFlatRelationAnswer([
    ...lines,
    '{"k":"rel","i":2,"subject":"orphaned"',
    '{"k":"ev","i":99,"role":"primary","block":"b001","quote":"no relation line"}',
    '{"k":"rel","i":3,"subject":"no evidence","subject_block":"b001","subject_quote":"x","predicate":"p","object":"o"}',
    '{"k":"note","i":4,"text":"unknown kind"}',
    '{"k":"rel","subject":"missing index"}',
  ].join('\n'));
  assert.equal(answer.proposals.length, 1, 'the intact claim survives every neighbouring defect');
  assert.deepEqual(answer.rejected.map(row => row.code).sort(), [
    'LINE_WITHOUT_RELATION_INDEX', 'MALFORMED_RELATION_LINE', 'ORPHAN_EVIDENCE_LINE',
    'RELATION_WITHOUT_EVIDENCE', 'UNKNOWN_LINE_KIND',
  ]);
});

test('a truncated answer is detected instead of parsing as a complete shorter answer', () => {
  const claims = [claim('alpha', 'the alpha rule is stated here'), claim('beta', 'the beta rule is stated here')];
  const full = serializeFlatRelationAnswer({ claims });
  assert.equal(parseFlatRelationAnswer(full).completeness.complete, true);

  const lines = full.split('\n');
  const cutMidStream = parseFlatRelationAnswer(lines.slice(0, 4).join('\n'));
  assert.equal(cutMidStream.completeness.complete, false, 'a response cut before the trailer is truncated');
  assert.match(cutMidStream.completeness.reason, /no \{"k":"end"\} trailer/);
  assert.ok(cutMidStream.proposals.length >= 1, 'claims that did arrive are still retained');

  const miscounted = parseFlatRelationAnswer([...lines.slice(0, -1), JSON.stringify({ k: 'end', count: 9 })].join('\n'));
  assert.equal(miscounted.completeness.complete, false, 'a trailer that disagrees with the body is truncated');
  assert.match(miscounted.completeness.reason, /declared 9 claims but 2 rel lines/);

  assert.equal(parseFlatRelationAnswer('{"k":"head","outcome":"extracted"}\n{"k":"end","count":0}').completeness.complete, true,
    'a lawful empty answer still declares completeness');
});

test('unescaped interior source quotes are recovered without changing their decoded bytes', () => {
  const quote = 'Semantic zoom makes one graph legible — "detail follows the camera." Always.';
  const valid = serializeFlatRelationAnswer({ claims: [claim('Semantic zoom', quote)] });
  const malformed = valid.replaceAll('\\"detail follows the camera.\\"', '"detail follows the camera."');
  const answer = parseFlatRelationAnswer(malformed);
  assert.equal(answer.completeness.complete, true, 'recovered rel lines still satisfy the trailer');
  assert.equal(answer.rejected.length, 0);
  assert.equal(answer.repairs.length, 3, 'the relation and both evidence lines are independently audited');
  assert.equal(answer.proposals[0].proposed.subject_mention.source_locator.quote, quote);
  assert.equal(answer.proposals[0].proposed.support_sets[0].locators[0].source_locator.quote, quote);
});

test('flat quote recovery refuses broader corruption and ambiguous duplicate structure', () => {
  assert.equal(repairUnescapedFlatQuotes('{"k":"ev","i":1,"quote":"bad\\** escape"}'), null,
    'invalid JSON escapes are not guessed');
  assert.equal(repairUnescapedFlatQuotes('{"k":"ev","i":1,"quote":"unterminated}'), null,
    'unterminated strings are not completed');
  assert.equal(repairUnescapedFlatQuotes('{"k":"ev","i":1,"quote":"source ","role":"fake","","role":"primary"}'), null,
    'duplicate schema-shaped properties are ambiguous');
  assert.equal(repairUnescapedFlatQuotes('{"k":"ev","i":1,"quote":"source "x"","invented":"field"}'), null,
    'unknown properties cannot be introduced by recovery');
});

test('an answer with no header is not a parseable answer', () => {
  assert.equal(parseFlatRelationAnswer('not json at all'), null);
  assert.equal(parseFlatRelationAnswer(''), null);
});
