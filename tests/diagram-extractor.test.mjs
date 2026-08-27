import test from 'node:test';
import assert from 'node:assert/strict';
import diagrams from '../tools/extractors/diagrams.mjs';

// The harness classifies each file and puts the decision on ctx; the extractor stamps what it is
// given. Classification itself is tested in document-mode.test.mjs.
const scan = (markdown, document = undefined) => {
  const ctx = { repo: 'fixture', file: 'design.md', document,
    fact: (kind, line, data) => ({ kind, line, ...data }) };
  return diagrams.scan(markdown.split('\n'), ctx);
};

test('a drawn edge is recorded as documented, never as an observation', () => {
  const facts = scan(['```mermaid', 'flowchart LR', '  TaskOrch -->|publishes| Envelope', '```'].join('\n'));
  const edge = facts.find(fact => fact.kind === 'diagram_relation');
  assert.deepEqual({
    from: edge.from_identifier, to: edge.to_identifier,
    // The author's own word, not the code vocabulary: the two agreeing is the finding.
    label: edge.relation_label, assertion: edge.assertion, shape: edge.diagram_shape,
  }, { from: 'TaskOrch', to: 'Envelope', label: 'publishes', assertion: 'documented', shape: 'flow' });
});

test('node labels and identifiers are both kept, and diagram keywords are never nodes', () => {
  const facts = scan(['```mermaid', 'flowchart TD', '  subgraph Core', '  ROOT["Atomic root"] --> Store[(Database)]', '  end', '```'].join('\n'));
  const nodes = facts.filter(fact => fact.kind === 'diagram_node');
  assert.deepEqual(nodes.map(node => [node.node_identifier, node.node_label]),
    [['ROOT', 'Atomic root'], ['Store', 'Database']]);
  assert.equal(nodes.some(node => ['subgraph', 'end', 'Core'].includes(node.node_identifier)), false);
});

test('sequence messages are relations and comments are not scanned', () => {
  const facts = scan(['```mermaid', 'sequenceDiagram', '  participant W as Worker',
    '  W->>Bus: emit(work_order.accepted)', '  %% A --> B should be ignored', '```'].join('\n'));
  const edge = facts.find(fact => fact.kind === 'diagram_relation');
  assert.deepEqual([edge.from_identifier, edge.to_identifier, edge.relation_label, edge.diagram_shape],
    ['W', 'Bus', 'emit(work_order.accepted)', 'sequence']);
  assert.equal(facts.some(fact => fact.from_identifier === 'A'), false);
  assert.equal(facts.find(fact => fact.node_identifier === 'W').node_label, 'Worker');
});

test('the drawing itself is the primary fact and every assertion binds to it', () => {
  const facts = scan(['# Doc', '', '```mermaid', 'flowchart LR', '  A -->|calls| B', '```'].join('\n'));
  const diagram = facts.find(fact => fact.kind === 'diagram');
  const edge = facts.find(fact => fact.kind === 'diagram_relation');
  assert.deepEqual({
    // Verbatim, so a reader can render or re-parse the drawing without the document.
    text: diagram.diagram_text,
    span: [diagram.line, diagram.line_end, diagram.line_count],
    // Identifiers are diagram-local shorthand; the fence address is what everything binds to.
    boundToDrawing: edge.diagram_address === diagram.diagram_address,
    address: diagram.diagram_address,
  }, {
    text: 'flowchart LR\n  A -->|calls| B',
    span: [4, 5, 2],
    boundToDrawing: true,
    address: 'design.md:4',
  });
});

test('a drawing inherits the standing of the document that drew it', () => {
  const fence = ['```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n');
  const held = document => scan(fence, document).find(fact => fact.kind === 'diagram_relation');
  const spec = held({ mode: 'specification', basis: 'path', archived: false, adjudication_frame: 'code' });
  // The same drawing in research explores an option; refuting it against code would say nothing.
  const research = held({ mode: 'research', basis: 'path', archived: false, adjudication_frame: 'world' });
  const unstamped = held(undefined);
  assert.deepEqual({
    spec: [spec.document_mode, spec.adjudication_frame],
    research: [research.document_mode, research.adjudication_frame],
    // An unclassified source leaves the standing null rather than assuming one.
    unstamped: [unstamped.document_mode, unstamped.adjudication_frame],
  }, { spec: ['specification', 'code'], research: ['research', 'world'], unstamped: [null, null] });
});

test('the longest arrow form wins, so a label is not eaten by a shorter match', () => {
  const facts = scan(['```mermaid', 'flowchart LR', '  R1 -->|104 kinds| OUT[["209 records"]]',
    '  A -.-> B', '  C ==> D', '  E ---> F', '```'].join('\n'));
  assert.deepEqual(facts.filter(fact => fact.kind === 'diagram_relation')
    .map(edge => [edge.from_identifier, edge.arrow, edge.relation_label, edge.to_identifier]), [
    // An alternation trying --> before ---> left the extra dash to be read as the target.
    ['R1', '-->', '104 kinds', 'OUT'],
    ['A', '-.->', null, 'B'],
    ['C', '==>', null, 'D'],
    ['E', '--->', null, 'F'],
  ]);
});

test('only diagram fences are scanned, and every fact locates its own fence', () => {
  const facts = scan(['# Doc', '```js', 'const a = b;', '```', 'prose A --> B outside a fence',
    '```mermaid', 'graph LR', '  A --> B', '```'].join('\n'));
  assert.equal(facts.filter(fact => fact.kind === 'diagram_relation').length, 1);
  const edge = facts.find(fact => fact.kind === 'diagram_relation');
  assert.deepEqual([edge.line, edge.diagram_start_line, edge.diagram_syntax], [8, 7, 'mermaid']);
});
