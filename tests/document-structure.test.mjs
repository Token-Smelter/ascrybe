import test from 'node:test';
import assert from 'node:assert/strict';
import structure from '../tools/extractors/document-structure.mjs';

const scan = (markdown, document = undefined) => structure.scan(markdown.split('\n'),
  { repo: 'fixture', file: 'design.md', document, fact: (kind, line, data) => ({ kind, line, ...data }) });

test('a section owns its subsections rather than ending at the next heading', () => {
  const facts = scan(['# Design', '## Constraints', 'prose', '### Known limitations', 'more', '## Rollout', 'last'].join('\n'));
  const sections = facts.filter(fact => fact.kind === 'document_section');
  assert.deepEqual(sections.map(section => [section.section_path, section.line, section.line_end]), [
    ['Design', 1, 7],
    ['Design / Constraints', 2, 5],
    ['Design / Constraints / Known limitations', 4, 5],
    ['Design / Rollout', 6, 7],
  ]);
});

test('a heading inside a code fence is code, not structure', () => {
  const facts = scan(['# Real', '```bash', '# not a heading', 'echo hi', '```', '## Also real'].join('\n'));
  assert.deepEqual(facts.filter(fact => fact.kind === 'document_section').map(section => section.heading_text),
    ['Real', 'Also real']);
});

test('a numbered heading keeps its number apart from its title, and setext headings count', () => {
  const facts = scan(['Overview', '========', '### 4.2 Identity resolution', 'prose'].join('\n'));
  const sections = facts.filter(fact => fact.kind === 'document_section');
  assert.deepEqual(sections.map(section => [section.heading_style, section.heading_level, section.section_number, section.section_title]), [
    ['setext', 1, null, 'Overview'],
    ['atx', 3, '4.2', 'Identity resolution'],
  ]);
});

test('an unstructured document is a finding, and standing travels with structure', () => {
  const plain = scan('just prose, no headings at all\n').find(fact => fact.kind === 'document');
  assert.deepEqual([plain.has_structure, plain.heading_count, plain.max_heading_level], [false, 0, 0]);
  const research = scan('# Findings\nprose\n',
    { mode: 'research', adjudication_frame: 'world', archived: false });
  // A section of a research note is not a section of a specification; a reader resolving a claim
  // to its section needs to know which it is holding.
  assert.deepEqual(research.map(fact => [fact.kind, fact.document_mode, fact.adjudication_frame]),
    [['document', 'research', 'world'], ['document_section', 'research', 'world']]);
});
