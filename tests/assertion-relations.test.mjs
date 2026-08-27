import test from 'node:test';
import assert from 'node:assert/strict';
import { assertionBucket, assertionRelations, classifyAssertionPair, comparableEndpoint, predicatePolarity } from '../tools/assertion-relations.mjs';
import { buildAssertion, relationSubject, unresolvedSubject } from '../tools/assertion.mjs';

const drawn = ({ from, predicate, to, document = 'a.md', line = 1, modality = 'descriptive', mode = 'specification' }) =>
  buildAssertion({
    subject: relationSubject({ from: unresolvedSubject({ text: from }), predicate, to: unresolvedSubject({ text: to }) }),
    source: { document, line, section_path: 'Design', quote: null },
    nature: { producer: 'diagrams', modality, document_mode: mode, adjudication_frame: 'code' },
  });

test('two assertions are comparable only when they name the same pair', () => {
  const one = drawn({ from: 'TaskOrch', predicate: 'publishes', to: 'Envelope' });
  const same = drawn({ from: 'task orch', predicate: 'emits', to: 'ENVELOPE' });
  const other = drawn({ from: 'TaskOrch', predicate: 'publishes', to: 'Route' });
  // Case and separators are normalized; the endpoints are never resolved, because resolution is a
  // later receipted step and two assertions about the same words are comparable regardless.
  assert.equal(assertionBucket(one), assertionBucket(same));
  assert.notEqual(assertionBucket(one), assertionBucket(other));
});

test('opposed polarity is a conflict; the same predicate twice is corroboration', () => {
  const holds = drawn({ from: 'Billing', predicate: 'calls', to: 'Ledger' });
  const denies = drawn({ from: 'Billing', predicate: 'does not call', to: 'Ledger' });
  const repeats = drawn({ from: 'Billing', predicate: 'calls', to: 'Ledger', document: 'b.md' });
  assert.deepEqual([predicatePolarity('does not call'), predicatePolarity('calls')], ['negated', 'affirmed']);
  assert.equal(classifyAssertionPair(holds, denies).relation, 'direct_conflict');
  assert.equal(classifyAssertionPair(holds, repeats).relation, 'equivalent_proposition');
});

test('a requirement paired with a statement of fact is a modality divergence, not a conflict', () => {
  const rule = drawn({ from: 'Billing', predicate: 'must retry', to: 'Ledger', modality: 'normative' });
  const fact = drawn({ from: 'Billing', predicate: 'retries', to: 'Ledger', modality: 'descriptive' });
  const held = classifyAssertionPair(rule, fact);
  assert.equal(held.relation, 'modality_divergence');
  // Same endpoints, different predicates, same modality: the corpus disagrees about how they
  // relate, which is a referent question rather than a contradiction.
  const differs = classifyAssertionPair(drawn({ from: 'Billing', predicate: 'calls', to: 'Ledger' }),
    drawn({ from: 'Billing', predicate: 'owns', to: 'Ledger' }));
  assert.equal(differs.relation, 'referent_ambiguity');
});

test('a relation carries both sides verbatim so a reader can check the call', () => {
  const held = assertionRelations([
    drawn({ from: 'Billing', predicate: 'calls', to: 'Ledger', document: 'one.md', line: 4 }),
    drawn({ from: 'Billing', predicate: 'does not call', to: 'Ledger', document: 'two.md', line: 9 }),
    drawn({ from: 'Search', predicate: 'calls', to: 'Index' }),
  ]);
  const relation = held.relations[0];
  assert.deepEqual({
    subject: [relation.subject.from.kind, relation.subject.predicate, relation.subject.to.kind],
    // Both documents, both predicates, and whether the disagreement crosses documents at all.
    left: [relation.evidence.left.document, relation.evidence.left.predicate],
    right: [relation.evidence.right.document, relation.evidence.right.predicate],
    cross: relation.evidence.cross_document,
    frame: relation.nature.adjudication_frame,
    ruleStated: relation.evidence.rule.length > 0,
    counts: [held.counts.buckets, held.counts.comparable_buckets, held.counts.pairs_compared, held.counts.relations],
  }, {
    subject: ['assertion', 'direct_conflict', 'assertion'],
    left: ['one.md', 'calls'], right: ['two.md', 'does not call'],
    cross: true, frame: 'corpus', ruleStated: true,
    // One bucket had two members; the lone X-Y pair was never compared.
    counts: [2, 1, 1, 1],
  });
});

test('a bare arrow is silent about how two things relate, not in disagreement', () => {
  // One diagram labels its edge, another draws the same transition without a label. That is one
  // diagram being terser, and calling it a disagreement was the largest source of false relations
  // measured on a real corpus.
  const labelled = drawn({ from: 'Billing', predicate: 'retries', to: 'Ledger', document: 'one.md' });
  const bare = drawn({ from: 'Billing', predicate: '-->', to: 'Ledger', document: 'two.md' });
  const held = classifyAssertionPair(labelled, bare);
  assert.equal(held.relation, 'compatible_partial');
  // compatible_partial is not emitted: a pair that says nothing new is not a finding.
  assert.equal(assertionRelations([labelled, bare]).relations.length, 0);
});

test('an endpoint too generic to name anything is recorded but never compared', () => {
  // Two diagrams both drawing A --> B are not discussing the same thing; comparing on such
  // endpoints manufactured 5,444 relations from single-letter collisions in a real corpus.
  const held = assertionRelations([
    drawn({ from: 'A', predicate: 'calls', to: 'B', document: 'one.md' }),
    drawn({ from: 'A', predicate: 'does not call', to: 'B', document: 'two.md' }),
  ]);
  assert.deepEqual([held.relations.length, held.counts.incomparable_assertions, held.counts.buckets],
    [0, 2, 0]);
  assert.equal(comparableEndpoint('R1'), null);
  assert.equal(comparableEndpoint('TaskOrch'), 'taskorch');
});

test('an oversized bucket is disclosed rather than silently skipped', () => {
  const many = Array.from({ length: 6 }, (_, index) =>
    drawn({ from: 'Billing', predicate: `calls ${index}`, to: 'Ledger', document: `d${index}.md` }));
  const held = assertionRelations(many, { max_bucket: 5 });
  assert.deepEqual([held.relations.length, held.counts.skipped_buckets.length, held.counts.skipped_buckets[0].members],
    [0, 1, 6]);
});
