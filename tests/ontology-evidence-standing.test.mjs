import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoveryViewModel } from '../tools/ontology/discovery.mjs';
import { evidenceGraph } from '../tools/ontology/evidence-graph.mjs';
import { exploreModel } from '../tools/ontology/explore-model.mjs';
import { createOntologyMap } from '../tools/ontology/ontology-map.mjs';
import { createGraphView } from '../dashboard/ontology-graph.js';
import { graphDetailForNode } from '../dashboard/graph-detail.js';

// Invented harbor estate. Historical rows still say source_observed for a comment and a
// document; the sealed generation status stays proposed. Read-time projection must not treat
// those as observed code, and must hold a concept with no located evidence.
const PIN = 'c'.repeat(40);
const commentRow = {
  artifact_id: 'slip-01', repository: 'harbor', path: 'dock/slip.mjs', commit_sha: PIN,
  start_line: 1, end_line: 1, quote: '// tide windows close at dusk', locator: 'exact',
  standing: 'source_observed', span_class: 'comment', role: 'support', concept_accession: 'c:comment',
};
const documentRow = {
  artifact_id: 'note-01', repository: 'harbor', path: 'docs/tide-note.md', commit_sha: PIN,
  start_line: 2, end_line: 2, quote: 'Slips close at dusk.', locator: 'exact',
  standing: 'source_observed', span_class: null, role: 'support', concept_accession: 'c:doc',
};
const codeRow = {
  artifact_id: 'slip-02', repository: 'harbor', path: 'dock/gate.mjs', commit_sha: PIN,
  start_line: 4, end_line: 4, quote: 'export function closeSlip() {', locator: 'exact',
  standing: 'source_observed', span_class: 'code', role: 'support', concept_accession: 'c:code',
};
const concept = (accession, label, category) => ({
  accession, version_id: `v:${accession}`, scheme_accession: 's:harbor', semantic_category: category,
  label, definition: `${label} defined.`, inclusion: 'Included.', exclusion: 'Excluded.',
  domain: [], invariants: [], aliases: [], origin: 'synthesized', status: 'proposed',
});
function sealedGeneration() {
  const concepts = [
    concept('c:none', 'Uncited slip rule', 'policy'),
    concept('c:comment', 'Dusk window note', 'policy'),
    concept('c:doc', 'Tide notice', 'policy'),
    concept('c:code', 'Close the slip', 'responsibility'),
  ];
  return {
    schema: 'estate-map/ontology-discovery-generation/v4',
    generation_id: 'ontology-discovery-generation:harbor',
    context_id: 'ctx-harbor', prior_generation_id: null, status: 'proposed',
    acceptance: { decision_id: null, accepted: false },
    implemented_checks: [], model_config: {}, counts: {}, unsupported: [],
    neighbor_review: [], acceptance_blockers: [], findings: [],
    concept_standing: [
      { accession: 'c:none', standing: { summary: 'no_located_evidence', standings_present: [] } },
      { accession: 'c:comment', standing: { summary: 'source_observed', standings_present: ['source_observed'] } },
      { accession: 'c:doc', standing: { summary: 'source_observed', standings_present: ['source_observed'] } },
      { accession: 'c:code', standing: { summary: 'source_observed', standings_present: ['source_observed'] } },
    ],
    source_artifacts: [
      { artifact_id: 'slip-01', collection_id: 'harbor', kind: 'code', repository: 'harbor', path: 'dock/slip.mjs', commit_sha: PIN },
      { artifact_id: 'note-01', collection_id: 'harbor', kind: 'document_claim', repository: 'harbor', path: 'docs/tide-note.md', commit_sha: PIN },
      { artifact_id: 'slip-02', collection_id: 'harbor', kind: 'code', repository: 'harbor', path: 'dock/gate.mjs', commit_sha: PIN },
    ],
    referents: [
      { referent_id: 'r:comment', collection_id: 'harbor', kind: 'code_construct', name: 'dusk comment', denotes: 'dusk comment', basis: 'read_in_source', coverage: { status: 'related' }, occurrence: commentRow },
      { referent_id: 'r:doc', collection_id: 'harbor', kind: 'passage', name: 'tide notice', denotes: 'tide notice', basis: 'stated_in_document', coverage: { status: 'related' }, occurrence: documentRow },
      { referent_id: 'r:code', collection_id: 'harbor', kind: 'code_construct', name: 'closeSlip', denotes: 'closeSlip', basis: 'read_in_source', coverage: { status: 'related' }, occurrence: codeRow },
    ],
    assertions: [],
    collections: [{
      collection_id: 'harbor', collection_context_id: 'cc-harbor', mode: 'fresh',
      schemes: [{ accession: 's:harbor', label: 'Harbor', definition: 'd', boundary: 'b' }],
      concepts, relations: [], gaps: [], unresolved: [], changes: [], candidates: [],
      evidence: [commentRow, documentRow, codeRow],
      coverage: { artifacts: [] }, unresolved_artifact_ids: [], expansion_statuses: [],
    }],
  };
}

const byAccession = (generation, accession) => generation.collections.flatMap(c => c.schemes.flatMap(s => s.concepts)).find(c => c.accession === accession);
const graphConcept = (graph, accession) => graph.nodes.find(n => n.type === 'concept' && n.accession === accession);
const graphSubject = (graph, referentId) => graph.nodes.find(n => n.type === 'subject' && n.referent_id === referentId);

// The same harbor rows, moved into affirmative non-constitutive describes assertions. Collection
// evidence is empty. Historical summaries still say source_observed.
function describesAssertion(referentId, accession, row) {
  const occurrence = { ...row };
  delete occurrence.role;
  delete occurrence.concept_accession;
  return {
    assertion_id: `ontology-assertion:${accession}`, referent_id: referentId, predicate: 'describes',
    polarity: 'affirm', constitutive: false, membership: false, concept_accession: accession,
    concept_version_id: `v:${accession}`, occurrence, status: 'proposed',
  };
}
function assertionOnlyGeneration() {
  const generation = sealedGeneration();
  generation.assertions = [
    describesAssertion('r:comment', 'c:comment', commentRow),
    describesAssertion('r:doc', 'c:doc', documentRow),
    describesAssertion('r:code', 'c:code', codeRow),
  ];
  generation.collections[0].evidence = [];
  return generation;
}

test('a sealed generation is not rewritten when no located evidence is read as held', () => {
  const generation = sealedGeneration();
  const before = structuredClone(generation);
  const view = discoveryViewModel(generation);
  const graph = evidenceGraph({ generations: [generation] });
  assert.deepEqual(generation, before);
  assert.equal(generation.collections[0].concepts.find(c => c.accession === 'c:none').status, 'proposed');
  const viewed = byAccession(view, 'c:none');
  const drawn = graphConcept(graph, 'c:none');
  assert.equal(viewed.status, 'held');
  assert.equal(String(viewed.status).includes('proposed'), false);
  assert.equal(drawn.status, 'held');
  assert.equal(drawn.proposal, false);
  assert.equal(String(drawn.status).includes('proposed'), false);
});

test('comment-only and document-only concepts are claims, not observed code, in the read model and evidence graph', () => {
  const generation = sealedGeneration();
  const view = discoveryViewModel(generation);
  const graph = evidenceGraph({ generations: [generation] });
  for (const accession of ['c:comment', 'c:doc']) {
    const viewed = byAccession(view, accession);
    const drawn = graphConcept(graph, accession);
    assert.equal(viewed.evidence_class, 'claim');
    assert.notEqual(viewed.evidence_class, 'observed code');
    assert.equal(drawn.evidence_class, 'claim');
    assert.notEqual(drawn.evidence_class, 'observed code');
    assert.notEqual(drawn.side, 'observed');
    assert.equal(viewed.status, 'proposed');
  }
  const code = graphConcept(graph, 'c:code');
  assert.equal(code.evidence_class, 'observed code');
  assert.equal(code.side, 'observed');
  assert.equal(code.status, 'proposed');
  assert.equal(code.proposal, true);
  assert.equal(graphSubject(graph, 'r:comment').evidence_class, 'claim');
  assert.notEqual(graphSubject(graph, 'r:comment').group, 'observed');
  assert.equal(graphSubject(graph, 'r:doc').evidence_class, 'claim');
  assert.notEqual(graphSubject(graph, 'r:doc').group, 'observed');
  assert.equal(graphSubject(graph, 'r:code').evidence_class, 'observed code');
  assert.equal(graphSubject(graph, 'r:code').group, 'observed');
});

test('the explorer and flat ontology map derive the same three gates without a new generation', () => {
  const generation = sealedGeneration();
  const view = discoveryViewModel(generation);
  const explored = exploreModel({ view, reconcile: {
    domains: [{ domain_id: 'd:1', source_id: 'harbor', label: 'Docks', kind: 'process', definition: 'x', members: ['c:none', 'c:comment', 'c:doc', 'c:code'] }],
    themes: [{ label: 'Harbor', definition: 'y', domains: ['d:1'] }], paths: [], unplaced: [],
    summary: { coverage: {}, clusters: {} }, clusters: [], traces: [],
  } });
  const gate = accession => explored.concept_gates[explored.concepts.findIndex(row => row[0] === accession)];
  assert.deepEqual(gate('c:none'), { status: 'held', evidence_class: null });
  assert.equal(gate('c:comment').evidence_class, 'claim');
  assert.equal(gate('c:doc').evidence_class, 'claim');
  assert.notEqual(gate('c:comment').evidence_class, 'observed code');
  assert.notEqual(explored.concepts.find(row => row[0] === 'c:comment')[3], 0);
  assert.notEqual(explored.concepts.find(row => row[0] === 'c:doc')[3], 0);
  const coverage = { admitted: 0, reached: 0, share: 0, label: 'no reach is claimed', counts: {}, unplacedReasons: {}, dispositions: () => [], repositories: () => [], page: async () => [], explain: async () => null, isReached: () => false, byPlane: {}, denominators: {} };
  const map = createOntologyMap({ explored, details: new Map(), binding: null, coverage, queries: {}, view: 'working', projection: { projection_id: 'p' } });
  return Promise.all([0, 1, 2].map(i => map.node(`ontology:concept:${i}`))).then(found => {
    assert.equal(found[0].node.properties.status, 'held');
    assert.equal(String(found[0].node.properties.status).includes('proposed'), false);
    assert.equal(found[1].node.properties.evidence_class, 'claim');
    assert.equal(found[2].node.properties.evidence_class, 'claim');
    assert.notEqual(found[1].node.properties.evidence_class, 'observed code');
    const detail = graphDetailForNode(found[1].node);
    assert.equal(detail.fields.find(field => field.label === 'evidence class')?.value, 'claim');
    assert.equal(graphDetailForNode(found[0].node).fields.find(field => field.label === 'status')?.value, 'held');
  });
});

function h(tag, props = {}, ...children) {
  const node = { tag, props: props ?? {}, children: children.flat(Infinity).filter(child => child != null && child !== false) };
  node.append = (...items) => { node.children.push(...items.flat(Infinity).filter(child => child != null && child !== false)); };
  return node;
}
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(textOf).join(' ');
}
function findId(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['data-id'] === id) return node;
  for (const child of node.children ?? []) {
    const found = findId(child, id);
    if (found) return found;
  }
  return null;
}
function columnOf(root, id) {
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'section' && node.props?.class === 'col' && findId(node, id)) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return textOf((found[0]?.children ?? []).find(child => child?.props?.class === 'col__title'));
}

test('the evidence-graph UI holds a concept with no located evidence and shows comment-only and document-only concepts as claims', () => {
  globalThis.requestAnimationFrame = () => 0;
  const graph = evidenceGraph({ generations: [sealedGeneration()] });
  const view = createGraphView({
    h, svg: h, words: value => String(value ?? '').replaceAll('_', ' '), short: value => String(value ?? ''),
    quoteBlock: row => row.quote, pinText: row => row.path, stamp: value => value,
  });
  view.load(graph);
  const detail = { replaceChildren(node) { this.child = node; } };
  const rail = { replaceChildren() {} };
  const show = accession => {
    const node = graphConcept(graph, accession);
    view.applyRoute(['focus', node.id]);
    view.render(detail, rail);
    return { column: columnOf(detail.child, node.id), text: textOf(findId(detail.child, node.id)), inspector: textOf(detail.child) };
  };
  const held = show('c:none');
  assert.match(held.text + held.inspector, /\bheld\b/);
  assert.doesNotMatch(held.text, /proposed/);
  for (const accession of ['c:comment', 'c:doc']) {
    const shown = show(accession);
    assert.equal(shown.column, 'Concepts from statements');
    assert.notEqual(shown.column, 'Concepts from source');
    assert.match(shown.text + shown.inspector, /\bclaim\b/);
    assert.doesNotMatch(`${shown.column} ${shown.text}`, /observed code/);
  }
  const code = show('c:code');
  assert.equal(code.column, 'Concepts from source');
  assert.match(code.text + code.inspector, /observed code/);
});

test('assertion-only comment and document evidence is a claim, not observed code, in the read model and rendered graph', async () => {
  const generation = assertionOnlyGeneration();
  const before = structuredClone(generation);
  const view = discoveryViewModel(generation);
  const graph = evidenceGraph({ generations: [generation] });
  assert.deepEqual(generation, before);
  assert.equal(generation.assertions.find(a => a.concept_accession === 'c:comment').occurrence.standing, 'source_observed');
  assert.equal(generation.collections[0].evidence.length, 0);
  for (const accession of ['c:comment', 'c:doc']) {
    const viewed = byAccession(view, accession);
    const drawn = graphConcept(graph, accession);
    const occurrence = viewed.assertions[0].occurrence;
    assert.equal(viewed.evidence.length, 0);
    assert.equal(viewed.evidence_class, 'claim');
    assert.notEqual(viewed.evidence_class, 'observed code');
    assert.equal(occurrence.evidence_class, 'claim');
    assert.notEqual(occurrence.standing, 'source_observed');
    assert.equal(drawn.evidence_class, 'claim');
    assert.notEqual(drawn.evidence_class, 'observed code');
    assert.notEqual(drawn.side, 'observed');
    assert.equal(viewed.status, 'proposed');
  }
  assert.equal(byAccession(view, 'c:comment').assertions[0].occurrence.standing, 'comment_claim');
  assert.equal(byAccession(view, 'c:doc').assertions[0].occurrence.standing, 'documentary_claim');
  const code = graphConcept(graph, 'c:code');
  assert.equal(code.evidence_class, 'observed code');
  assert.equal(code.side, 'observed');
  assert.equal(graphSubject(graph, 'r:comment').evidence_class, 'claim');
  assert.notEqual(graphSubject(graph, 'r:comment').group, 'observed');
  assert.equal(graphSubject(graph, 'r:doc').evidence_class, 'claim');
  assert.equal(graphSubject(graph, 'r:code').evidence_class, 'observed code');
  const explored = exploreModel({ view, reconcile: {
    domains: [{ domain_id: 'd:1', source_id: 'harbor', label: 'Docks', kind: 'process', definition: 'x', members: ['c:comment', 'c:doc', 'c:code'] }],
    themes: [{ label: 'Harbor', definition: 'y', domains: ['d:1'] }], paths: [], unplaced: [],
    summary: { coverage: {}, clusters: {} }, clusters: [], traces: [],
  } });
  const gate = accession => explored.concept_gates[explored.concepts.findIndex(row => row[0] === accession)];
  assert.equal(gate('c:comment').evidence_class, 'claim');
  assert.equal(gate('c:doc').evidence_class, 'claim');
  assert.notEqual(explored.concepts.find(row => row[0] === 'c:comment')[3], 0);
  assert.notEqual(explored.concepts.find(row => row[0] === 'c:doc')[3], 0);
  const coverage = { admitted: 0, reached: 0, share: 0, label: 'no reach is claimed', counts: {}, unplacedReasons: {}, dispositions: () => [], repositories: () => [], page: async () => [], explain: async () => null, isReached: () => false, byPlane: {}, denominators: {} };
  const map = createOntologyMap({ explored, details: new Map(), binding: null, coverage, queries: {}, view: 'working', projection: { projection_id: 'p' } });
  const mapped = await Promise.all([1, 2, 3].map(i => map.node(`ontology:concept:${i}`)));
  assert.equal(mapped[0].node.properties.evidence_class, 'claim');
  assert.equal(mapped[1].node.properties.evidence_class, 'claim');
  assert.notEqual(mapped[0].node.properties.evidence_class, 'observed code');
  assert.equal(mapped[2].node.properties.evidence_class, 'observed code');
  assert.equal(graphDetailForNode(mapped[0].node).fields.find(field => field.label === 'evidence class')?.value, 'claim');
  globalThis.requestAnimationFrame = () => 0;
  const ui = createGraphView({
    h, svg: h, words: value => String(value ?? '').replaceAll('_', ' '), short: value => String(value ?? ''),
    quoteBlock: row => row.quote, pinText: row => row.path, stamp: value => value,
  });
  ui.load(graph);
  const detail = { replaceChildren(node) { this.child = node; } };
  const rail = { replaceChildren() {} };
  const show = accession => {
    const node = graphConcept(graph, accession);
    ui.applyRoute(['focus', node.id]);
    ui.render(detail, rail);
    return { column: columnOf(detail.child, node.id), text: textOf(findId(detail.child, node.id)), inspector: textOf(detail.child) };
  };
  for (const accession of ['c:comment', 'c:doc']) {
    const shown = show(accession);
    assert.equal(shown.column, 'Concepts from statements');
    assert.notEqual(shown.column, 'Concepts from source');
    assert.match(shown.text + shown.inspector, /\bclaim\b/);
    assert.doesNotMatch(`${shown.column} ${shown.text}`, /observed code/);
  }
  const shownCode = show('c:code');
  assert.equal(shownCode.column, 'Concepts from source');
  assert.match(shownCode.text + shownCode.inspector, /observed code/);
});

test('the flat graph canvas classifies comment-only and document-only concepts as claims, not observed code', async () => {
  const detail = await import('../dashboard/graph-detail.js');
  assert.equal(typeof detail.ontologyCanvasKind, 'function');
  assert.equal(detail.ontologyCanvasKind({ kind: 'OntologyConcept', properties: { evidence_class: 'claim' } }), 'Claim');
  assert.equal(detail.ontologyCanvasKind({ kind: 'OntologyConcept', properties: { evidence_class: 'observed code' } }), 'CodeFact');
  assert.notEqual(detail.ontologyCanvasKind({ kind: 'OntologyConcept', properties: { evidence_class: 'claim' } }), 'CodeFact');
  const app = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const candidate = readFileSync(new URL('../dashboard/ontology-candidate.js', import.meta.url), 'utf8');
  const explorer = readFileSync(new URL('../dashboard/ontology-explore.js', import.meta.url), 'utf8');
  assert.match(app, /ontologyCanvasKind/);
  assert.match(candidate, /evidence_class/);
  assert.match(explorer, /concept_gates|evidence_class/);
});

test('a concept supported only by a comment and a document together is a claim, not unclassified', async () => {
  const { conceptEvidenceGate } = await import('../tools/ontology/evidence-standing.mjs');
  const evidence = [{ ...commentRow, standing: 'comment_claim' }, { ...documentRow, standing: 'documentary_claim' }];
  const gates = ['mixed', 'comment_claim', 'documentary_claim'].map(summary => conceptEvidenceGate({ standing: { summary }, evidence }));
  const withCode = conceptEvidenceGate({ standing: { summary: 'mixed' }, evidence: [...evidence, codeRow] });
  assert.deepEqual([gates.map(g => g.evidence_class), withCode.evidence_class], [['claim', 'claim', 'claim'], null]);
});
