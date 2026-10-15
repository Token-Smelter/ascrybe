import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceGraph, GRAPH_SCHEMA } from '../tools/ontology/evidence-graph.mjs';
import { createCandidateViewServer } from '../tools/ontology/candidate-view.mjs';

// An invented estate: a document records a decision that selects a strategy; source configures a responsibility.
const occ = (artifact, standing, quote, path, extra = {}) => ({ artifact_id: artifact, repository: 'lantern', path, commit_sha: 'a'.repeat(40), start_line: 3, end_line: 3, quote, locator: 'exact', standing, span_class: null, ...extra });
const concept = (accession, label, category, standing) => ({ accession, version_id: `v:${accession}`, label, semantic_category: category, definition: `${label} defined.`, inclusion: 'Inclusion.', exclusion: 'Exclusion.', origin: 'synthesized' });
function generation({ withImplements = true, extraConcept = false } = {}) {
  const strategy = concept('c:strategy', 'Keep keepers apart', 'strategy'), responsibility = concept('c:resp', 'Store keeper records', 'responsibility'), lone = concept('c:lone', 'Unlinked policy', 'policy');
  const docQuote = 'D1: keepers and visitors use separate ledgers.', codeQuote = 'partitionKey: "keeperId"';
  const referents = [
    { referent_id: 'r:decision', collection_id: 'notes', kind: 'decision', name: 'D1 separate ledgers', denotes: 'D1', basis: 'stated_in_document', coverage: { status: 'related' }, occurrence: occ('a1', 'documentary_claim', docQuote, 'notes/decisions.md') },
    { referent_id: 'r:code', collection_id: 'notes', kind: 'code_construct', name: 'keeper table', denotes: 'keeper table', basis: 'read_in_source', coverage: { status: 'related' }, occurrence: occ('a2', 'source_observed', codeQuote, 'ledger/store.mjs') },
    { referent_id: 'r:rule', collection_id: 'notes', kind: 'rule', name: 'Lone rule', denotes: 'Lone rule', basis: 'stated_in_document', coverage: { status: 'related' }, occurrence: occ('a1', 'documentary_claim', 'Never share one ledger.', 'notes/decisions.md') },
  ];
  const assertion = (id, ref, predicate, accession, o) => ({ assertion_id: id, referent_id: ref, predicate, polarity: 'affirm', concept_version_id: `v:${accession}`, concept_accession: accession, constitutive: ['selects', 'implements'].includes(predicate), membership: ['selects', 'implements'].includes(predicate), occurrence: o, status: 'proposed' });
  const assertions = [assertion('x1', 'r:decision', 'selects', 'c:strategy', referents[0].occurrence), assertion('x3', 'r:rule', 'defines', 'c:lone', referents[2].occurrence)];
  if (withImplements) assertions.push(assertion('x2', 'r:code', 'implements', 'c:resp', referents[1].occurrence));
  const support = (c, o) => ({ concept_accession: c, role: 'support', evidence_id: `e:${c}`, ...o });
  const concepts = [strategy, responsibility, lone, ...(extraConcept ? [concept('c:extra', 'Another responsibility', 'responsibility')] : [])];
  return { generation_id: 'ontology-discovery-generation:g1', context_id: 'ctx', status: 'proposed', acceptance: { decision_id: null, accepted: false }, findings: [],
    concept_standing: [{ accession: 'c:strategy', standing: { summary: 'documentary_claim' } }, { accession: 'c:resp', standing: { summary: 'source_observed' } }, { accession: 'c:lone', standing: { summary: 'documentary_claim' } },
      { accession: 'c:extra', standing: { summary: 'source_observed' } }],
    source_artifacts: [{ artifact_id: 'a1', kind: 'document_claim', graph_node_ids: [] }, { artifact_id: 'a2', kind: 'code', graph_node_ids: [] }],
    collections: [{ collection_id: 'notes', mode: 'fresh', concepts, relations: [], gaps: [], evidence: [support('c:strategy', occ('a1', 'documentary_claim', docQuote, 'notes/decisions.md')), support('c:resp', occ('a2', 'source_observed', codeQuote, 'ledger/store.mjs')),
      support('c:lone', occ('a1', 'documentary_claim', 'Never share one ledger.', 'notes/decisions.md'))] }],
    referents, assertions };
}
const endpoint = (g, accession, label) => ({ generation_id: g.generation_id, collection_id: 'notes', collection_context_id: 'cc', pins: ['lantern@aaa'], accession, version_id: `v:${accession}`, label, semantic_category: 'x', standing: 'x',
  evidence: [{ evidence_id: 'e', quote: 'q', repository: 'lantern', path: 'p', commit_sha: 'a'.repeat(40), start_line: 1, end_line: 1, standing: 'documentary_claim', verified_at_pin: true }] });
const link = (g, over = {}) => ({ link_id: 'ontology-link:1', relation: 'related', cross_kind: null, uncertainty: 'medium', reason: 'The document selects it; the source configures a table. The source does not show the choice is used.', derived: false,
  a_endpoint: endpoint(g, 'c:strategy', 'Keep keepers apart'), b_endpoint: endpoint(g, 'c:resp', 'Store keeper records'), source_observation: null, retrieval: [{ source: 'lexical', score: 0.1 }], model: { requested: 'm', scaffold: 's' }, request_digest: 'd', judged_model: 'm', ...over });
const alignmentOf = (g, links = [link(g)], subjectLinks = []) => ({ alignment_id: 'ontology-alignment:t', links, subject_links: subjectLinks });

test('a statement, its concept, an associating link and a source implementation form a chain whose steps keep their own status', () => {
  const g = generation(), graph = evidenceGraph({ generations: [g], alignment: alignmentOf(g) });
  const chain = graph.chains[0];
  const byKey = Object.fromEntries(chain.steps.map(s => [s.key, s]));
  assert.deepEqual([graph.schema === GRAPH_SCHEMA, chain.steps.map(s => `${s.key}:${s.status}`), chain.realisation, chain.implementation_established,
    byKey.stated.node_ids.map(id => graph.nodes.find(n => n.id === id).display_kind), byKey.realised.node_ids.map(id => graph.nodes.find(n => n.id === id).display_kind), byKey.link.note.includes('does not establish')],
  [true, ['stated:located', 'concept:located', 'link:proposed_link', 'observed_concept:located', 'realised:located', 'runtime:none_recorded'], 'associated_only', false, ['Decision'], ['Code'], true]);
});

test('missing implementation stays unknown and is never inferred from a linked concept', () => {
  const g = generation({ withImplements: false }), graph = evidenceGraph({ generations: [g], alignment: alignmentOf(g) });
  const realised = graph.chains[0].steps.find(s => s.key === 'realised');
  assert.deepEqual([realised.status, realised.node_ids.length, realised.edge_ids.length, graph.chains[0].realisation, graph.edges.some(e => e.type === 'assertion' && e.predicate === 'implements')], ['no_located_evidence', 0, 0, 'unknown', false]);
});

test('colocated concepts with no link produce no chain', () => {
  const g = generation(), graph = evidenceGraph({ generations: [g], alignment: null });
  assert.deepEqual([graph.chains.length, graph.default_chain, graph.counts.concepts, graph.counts.assertions], [0, null, 3, 3]);
});

test('a link whose endpoint is not in the generations is listed as broken and not drawn', () => {
  const g = generation();
  const missingConcept = link(g, { link_id: 'ontology-link:2', b_endpoint: endpoint(g, 'c:gone', 'Vanished') });
  const subjectLink = { subject_link_id: 'ontology-subject-link:1', link_id: 'ontology-link:1', relation: 'specifies', from_side: 'a', uncertainty: 'low', reason: 'x',
    a_endpoint: { collection_id: 'notes', referent_id: 'r:decision', name: 'D1', kind: 'decision', quote: 'q', commit_sha: 'a'.repeat(40), repository: 'lantern', path: 'p', start_line: 1, end_line: 1, standing: 'documentary_claim' },
    b_endpoint: { collection_id: 'notes', referent_id: 'r:missing', name: 'Gone', kind: 'code_construct', quote: 'q', commit_sha: 'a'.repeat(40), repository: 'lantern', path: 'p', start_line: 1, end_line: 1, standing: 'source_observed' } };
  const graph = evidenceGraph({ generations: [g], alignment: alignmentOf(g, [link(g), missingConcept], [subjectLink]) });
  assert.deepEqual([graph.broken.map(b => `${b.kind}:${b.reason}`).sort(), graph.edges.filter(e => e.type === 'concept_link').length, graph.edges.filter(e => e.type === 'subject_link').length],
    [['concept_link:b_concept_not_in_generations', 'subject_link:b_subject_not_in_generations'], 1, 0]);
});

test('every node and edge is a proposal; source check, review and evidence kind are separate and nothing is runtime verified', () => {
  const g = generation(), graph = evidenceGraph({ generations: [g], alignment: alignmentOf(g) });
  const assertionEdge = graph.edges.find(e => e.type === 'assertion' && e.predicate === 'selects');
  const kinds = Object.fromEntries(graph.edges.filter(e => e.type === 'assertion').map(e => [e.predicate, e.evidence_kind.id]));
  assert.deepEqual([graph.status.accepted, graph.status.decision_id, graph.status.review_recording,
    [...graph.nodes, ...graph.edges].every(x => x.proposal === true && x.review.state === 'not_reviewed' && x.review.decision_id === null && x.review.recording_enabled === false),
    graph.edges.every(e => e.runtime_verified === false), assertionEdge.validation.source_quote_located, kinds, assertionEdge.meaning],
  [false, null, 'not_enabled', true, true, true, { selects: 'document_says', defines: 'document_says', implements: 'source_declares' }, 'The decision records a choice of this option.']);
});

test('a retained subject id is shown as an interpretation unless an exact graph node id is recorded', () => {
  const g = generation();
  g.source_artifacts[1].graph_node_ids = [{ node_id: 'Module:exact', kind: 'Module' }];
  const graph = evidenceGraph({ generations: [g], alignment: null });
  const byId = Object.fromEntries(graph.nodes.filter(n => n.type === 'subject').map(n => [n.referent_id, n.graph_node_ids.map(x => x.node_id)]));
  assert.deepEqual(byId, { 'r:decision': [], 'r:code': ['Module:exact'], 'r:rule': [] });
});

test('the candidate server serves the graph and the page assets read-only', async () => {
  const g = generation();
  const full = { ...g, counts: {}, implemented_checks: [], neighbor_review: [], acceptance_blockers: [], rejected: [], unsupported: [], withheld: [], prior_generation_id: null, model_config: {} };
  full.collections[0].changes = []; full.collections[0].unresolved = []; full.collections[0].coverage = { artifacts: [] };
  full.collections[0].schemes = []; full.collections[0].candidates = []; full.collections[0].schemes = [];
  const server = createCandidateViewServer({ generation: { ...full, schema: 'estate-map/ontology-discovery-generation/v4', collections: full.collections.map(c => ({ ...c, schemes: [{ accession: 's', label: 'S', definition: 'd', boundary: 'b' }], concepts: c.concepts.map(k => ({ ...k, scheme_accession: 's', domain: [], invariants: [], aliases: [], status: 'proposed' })) })) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const graph = await (await fetch(`${base}/api/graph`)).json();
    const js = await fetch(`${base}/ontology-graph.js`), post = await fetch(`${base}/api/graph`, { method: 'POST' });
    assert.deepEqual([graph.schema, graph.status.accepted, js.status, js.headers.get('content-type').startsWith('text/javascript'), post.status], [GRAPH_SCHEMA, false, 200, true, 405]);
  } finally { server.close(); }
});

test('the candidate page styles carry no rotation, uppercase labels, ruled paper or type below 14px', () => {
  const css = readFileSync(new URL('../dashboard/ontology-candidate.css', import.meta.url), 'utf8');
  const sizes = [...css.matchAll(/font(?:-size)?\s*:[^;{}]*?(\d+(?:\.\d+)?)(px|rem)/g)].map(m => (m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])));
  assert.deepEqual([/rotate\(/.test(css), /text-transform:\s*uppercase/.test(css), /repeating-linear-gradient|radial-gradient/.test(css), Math.min(...sizes) >= 14, /font-variant:\s*small-caps/.test(css)], [false, false, false, true, false]);
});
