import test from 'node:test';
import assert from 'node:assert/strict';
import { assertionSubject, buildAssertion, entitySubject, groundSubject, relationSubject,
  unresolvedReferences, unresolvedSubject } from '../tools/assertion.mjs';

const source = { document: 'design.md', line: 12, section_path: 'Design / Flow', quote: 'A --> B' };
const nature = { producer: 'diagrams', modality: 'descriptive', document_mode: 'specification', adjudication_frame: 'code' };

test('a relationship can be the subject, with endpoints that ground to nothing yet', () => {
  const held = buildAssertion({
    subject: relationSubject({ from: unresolvedSubject({ text: 'R1', scope: 'design.md:9' }),
      predicate: 'publishes', to: entitySubject('referent:envelope') }),
    source, nature,
  });
  assert.deepEqual({
    kind: held.subject.kind,
    predicate: held.subject.predicate,
    // The verbatim identifier is what the document actually wrote; it is never replaced.
    from: [held.subject.from.kind, held.subject.from.text],
    to: held.subject.to.id,
    unresolved: unresolvedReferences(held).map(row => [row.path.join('.'), row.text]),
  }, {
    kind: 'relation', predicate: 'publishes',
    from: ['unresolved', 'R1'], to: 'referent:envelope',
    unresolved: [['from', 'R1']],
  });
});

test('an assertion can be the subject, so claim-to-claim needs no new structure', () => {
  const first = buildAssertion({ subject: entitySubject('referent:api'), source, nature });
  const about = buildAssertion({
    subject: relationSubject({ from: assertionSubject(first.assertion_id), predicate: 'superseded_by',
      to: assertionSubject('assertion:later') }),
    source: { ...source, line: 40 }, nature: { ...nature, modality: 'normative' },
  });
  assert.deepEqual([about.subject.from.kind, about.subject.from.id, about.subject.predicate],
    ['assertion', first.assertion_id, 'superseded_by']);
});

test('identity is content-derived, and the three trust axes are recorded independently', () => {
  const one = buildAssertion({ subject: entitySubject('referent:api'), source, nature });
  const same = buildAssertion({ subject: entitySubject('referent:api'), source, nature });
  const elsewhere = buildAssertion({ subject: entitySubject('referent:api'), source: { ...source, line: 13 }, nature });
  assert.equal(one.assertion_id, same.assertion_id);
  assert.notEqual(one.assertion_id, elsewhere.assertion_id);
  // A normative statement in a research note read from a drawing has a value on all three at
  // once, and none of them implies the others.
  const research = buildAssertion({ subject: entitySubject('referent:api'), source,
    nature: { producer: 'diagrams', modality: 'normative', document_mode: 'research', adjudication_frame: 'world' } });
  assert.deepEqual([research.nature.modality, research.nature.document_mode, research.nature.adjudication_frame],
    ['normative', 'research', 'world']);
});

test('grounding is a separate record that never rewrites what the document said', () => {
  const held = buildAssertion({
    subject: relationSubject({ from: unresolvedSubject({ text: 'R1' }), predicate: 'calls',
      to: unresolvedSubject({ text: 'U' }) }),
    source, nature,
  });
  const grounding = groundSubject({ assertion_id: held.assertion_id, path: ['from'],
    resolved_to: 'referent:recipe-engine',
    receipt: { producer: 'semantic-reference-linker', basis: 'label_match', confidence: 0.9 } });
  assert.deepEqual({
    binds: grounding.assertion_id === held.assertion_id,
    at: grounding.subject_path,
    to: grounding.resolved_to,
    receipted: [grounding.receipt.producer, grounding.receipt.basis],
    // The assertion is unchanged: a reader still sees the raw identifier and can ignore the join.
    stillVerbatim: held.subject.from.text,
  }, {
    binds: true, at: ['from'], to: 'referent:recipe-engine',
    receipted: ['semantic-reference-linker', 'label_match'], stillVerbatim: 'R1',
  });
  assert.throws(() => groundSubject({ assertion_id: held.assertion_id, resolved_to: 'referent:x', receipt: {} }),
    /receipt naming its producer and basis/u);
});

test('an assertion without a subject, source line, or producer is refused', () => {
  assert.throws(() => buildAssertion({ subject: { kind: 'nonsense' }, source, nature }), /valid subject/u);
  assert.throws(() => buildAssertion({ subject: entitySubject('x'), source: { document: 'd.md' }, nature }), /positive integer line/u);
  assert.throws(() => buildAssertion({ subject: entitySubject('x'), source, nature: {} }), /producer/u);
  assert.throws(() => unresolvedSubject({ text: '  ' }), /verbatim text/u);
});
