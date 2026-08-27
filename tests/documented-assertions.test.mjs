import test from 'node:test';
import assert from 'node:assert/strict';
import { documentedAssertions, sectionAt, sectionIndex } from '../tools/documented-assertions.mjs';
import { unresolvedReferences } from '../tools/assertion.mjs';

const sectionFact = (file, path, line, end, depth) => ({ kind: 'document_section', file,
  section_path: path, line, line_end: end, section_depth: depth });

test('a drawn edge becomes a relation assertion with both endpoints unresolved', () => {
  const held = documentedAssertions([
    sectionFact('design.md', 'Design', 1, 20, 1),
    sectionFact('design.md', 'Design / Flow', 4, 12, 2),
    { kind: 'diagram_relation', file: 'design.md', line: 6, from_identifier: 'TaskOrch',
      to_identifier: 'Envelope', relation_label: 'publishes', arrow: '-->',
      diagram_address: 'design.md:5', diagram_shape: 'flow', diagram_syntax: 'mermaid',
      document_mode: 'specification', adjudication_frame: 'code', document_archived: false },
  ]);
  const assertion = held.assertions[0];
  assert.deepEqual({
    subject: [assertion.subject.kind, assertion.subject.from.text, assertion.subject.predicate, assertion.subject.to.text],
    // The deepest section containing the line, not the outermost.
    section: assertion.source.section_path,
    standing: [assertion.nature.document_mode, assertion.nature.adjudication_frame],
    unresolved: unresolvedReferences(assertion).map(row => row.path.join('.')),
  }, {
    subject: ['relation', 'TaskOrch', 'publishes', 'Envelope'],
    section: 'Design / Flow',
    standing: ['specification', 'code'],
    unresolved: ['from', 'to'],
  });
});

test('an unlabelled edge keeps the arrow as its predicate rather than inventing one', () => {
  const held = documentedAssertions([{ kind: 'diagram_relation', file: 'd.md', line: 2,
    from_identifier: 'A', to_identifier: 'B', relation_label: null, arrow: '-.->',
    diagram_address: 'd.md:1', document_mode: 'research', adjudication_frame: 'world' }]);
  assert.equal(held.assertions[0].subject.predicate, '-.->');
  assert.equal(held.assertions[0].nature.adjudication_frame, 'world');
});

test('the drawing itself asserts its own existence, independent of grounding anything inside it', () => {
  const held = documentedAssertions([{ kind: 'diagram', file: 'd.md', line: 3, line_end: 9,
    line_count: 7, diagram_address: 'd.md:3', diagram_shape: 'sequence', diagram_syntax: 'mermaid',
    document_mode: 'report', adjudication_frame: 'execution' }]);
  const assertion = held.assertions[0];
  assert.deepEqual([assertion.subject.kind, assertion.subject.text, assertion.evidence.diagram_shape],
    ['unresolved', 'd.md:3', 'sequence']);
});

test('counts report where assertions can be refuted and how many stay ungrounded', () => {
  const held = documentedAssertions([
    { kind: 'diagram_relation', file: 'a.md', line: 1, from_identifier: 'A', to_identifier: 'B',
      arrow: '-->', diagram_address: 'a.md:1', document_mode: 'specification', adjudication_frame: 'code' },
    { kind: 'diagram_relation', file: 'b.md', line: 1, from_identifier: 'C', to_identifier: 'D',
      arrow: '-->', diagram_address: 'b.md:1', document_mode: 'research', adjudication_frame: 'world' },
  ]);
  assert.deepEqual(held.counts, {
    total: 2, by_adjudication_frame: { code: 1, world: 1 }, by_producer: { diagrams: 2 },
    with_section: 0, unresolved_subjects: 2,
  });
  assert.equal(sectionAt(new Map([['a.md', sectionIndex([sectionFact('a.md', 'X', 1, 5, 1)])]]), 'a.md', 3), 'X');
});
