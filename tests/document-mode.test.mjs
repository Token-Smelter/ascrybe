import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCorpus, classifyDocument } from '../tools/document-mode.mjs';

test('a document declaring its own kind outranks every inference', () => {
  const held = classifyDocument({ path: 'research/findings.md', text: '---\ndocument_mode: specification\n---\n# Findings\n' });
  assert.deepEqual([held.mode, held.basis, held.adjudicable], ['specification', 'declared', true]);
});

test('research is never adjudicable however it is recognized, and archived material never is', () => {
  const byPath = classifyDocument({ path: 'nes/research/parent-preferences/findings.md', text: '# Notes\n' });
  const byStructure = classifyDocument({ path: 'notes/exploration.md', text: '## Hypothesis\nParents prefer shorter stories.\n' });
  const archivedSpec = classifyDocument({ path: 'design/archive/api-contract.md', text: '## Interface\n' });
  assert.deepEqual({
    path: [byPath.mode, byPath.basis, byPath.adjudicable],
    structure: [byStructure.mode, byStructure.basis, byStructure.adjudicable],
    archived: [archivedSpec.mode, archivedSpec.archived, archivedSpec.adjudicable],
  }, {
    path: ['research', 'path', false],
    structure: ['research', 'structure', false],
    // The mode still describes the content; being archived only removes its standing as a
    // current assertion.
    archived: ['specification', true, false],
  });
});

test('intent and external records are separated from assertions about the built system', () => {
  const plan = classifyDocument({ path: 'sw/docs/plans/q3-migration.md', text: '# Q3\n' });
  const ticket = classifyDocument({ path: 'component-b/knowledge-base/tickets/5579.md', text: '# 5579\n' });
  const deepResearch = classifyDocument({ path: 'docs/deep-research-subscription-wellness/notes.md', text: '# Notes\n' });
  assert.deepEqual({
    // A plan asserts intent; refuting it against code would refute every unbuilt intention.
    plan: [plan.mode, plan.adjudicable],
    // A ticket is about a customer's experience, not about the system.
    ticket: [ticket.mode, ticket.adjudicable],
    research: [deepResearch.mode, deepResearch.adjudicable],
  }, { plan: ['plan', false], ticket: ['record', false], research: ['research', false] });
});

test('each mode names the frame that could refute it, not merely whether code could', () => {
  const frame = (path, text = '') => classifyDocument({ path, text }).adjudication_frame;
  assert.deepEqual({
    spec: frame('docs/architecture/api.md'),
    plan: frame('sw/docs/plans/q3.md'),
    // A research finding is refutable — by the world, which this estate does not hold. Saying
    // `false` here would have claimed it was unfalsifiable.
    research: frame('research/findings.md'),
    ticket: frame('support/tickets/1.md'),
    log: frame('logs/session.md'),
    // Archived material describes something real but is no longer a current assertion.
    archivedSpec: frame('design/archive/api.md'),
  }, {
    spec: 'code', plan: 'execution', research: 'world', ticket: 'external_system',
    log: 'none', archivedSpec: 'none',
  });
});

test('an unrecognized document stays unclassified rather than being guessed into a mode', () => {
  const held = classifyDocument({ path: 'misc/untitled.md', text: 'Some prose with no structure.\n' });
  assert.deepEqual([held.mode, held.basis, held.evidence, held.adjudicable], ['unclassified', 'none', null, false]);
});

test('a corpus report counts modes, bases, and what may be adjudicated', () => {
  const corpus = {
    'docs/architecture/api.md': '# API\n## Requirements\n',
    'research/market-analyses/scan.md': '# Scan\n',
    'reports/IMPL-REPORT-wo-1.md': '# Report\n',
    'notes/scratch.md': 'unstructured\n',
  };
  const held = classifyCorpus({ root: '/estate', documents: Object.keys(corpus),
    read: path => corpus[path.replace('/estate/', '')] });
  assert.deepEqual({ by_mode: held.by_mode, adjudicable: held.adjudicable, documents: held.documents },
    { by_mode: { specification: 1, research: 1, report: 1, unclassified: 1 }, adjudicable: 1, documents: 4 });
});
