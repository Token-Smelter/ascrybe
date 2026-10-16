import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOntologyMap } from '../tools/ontology/ontology-map.mjs';
import { openCoverage, noCoverage } from '../tools/ontology/coverage-artifact.mjs';

const members = Array.from({ length: 40 }, (_, i) => i);
const explored = {
  forms: [{ id: 'policy' }], standings: ['source_observed'], sources: ['shop'],
  concepts: members.map(i => [`c:${i}`, `Concept ${i}`, 0, 0, 0, 0, 1, 2, 0, 0]),
  domains: [{ id: 'd:0', set: 'reconciled', label: 'Checkout', source: 0, definition: 'x', kind: 'process', members }],
  themes: { reconciled: [{ label: 'Buying', definition: 'y', domains: [0] }], original: [] },
  relations: [[0, 1, 'is-checked-before', 'order matters', 1]],
};
const binding = { anchorsFor: (ids, { limit = 12, offset = 0 } = {}) => (ids[0] === 0
  ? { total_anchors: 1, anchors: [{ node_id: 'doc:shop/a.md', passages: 2, concepts: 1 }].slice(offset, offset + limit), located_nodes: { total: 1, nodes: [{ node_id: 'code-fact:1', kind: 'CodeFact', label: 'total', passages: 1 }] } }
  : { total_anchors: 0, anchors: [], located_nodes: { total: 0, nodes: [] } }) };

// A coverage artifact on disk, invented: 11 admitted nodes, 3 reached, 8 unplaced.
const row = (n, d, extra = {}) => ({ node_id: `n:${n}`, kind: 'CodeFact', repository: 'shop', file: `src/f${n}.js`, line: n, d, ...extra });
function artifact() {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
  const all = [row(1, 'evidence_anchored', { via: [{ concept: 'c:0', by: 'evidence', ref: 'e1' }] }), row(2, 'evidence_anchored', { via: [{ concept: 'c:1', by: 'evidence', ref: 'e2' }] }), row(3, 'owned_detail', { owner: 'n:1', relation: 'declares_symbol', depth: 1 }),
    ...Array.from({ length: 8 }, (_, i) => row(10 + i, 'unplaced', { reason: i < 5 ? 'file_not_cited' : 'claim_layer_unreached' }))];
  const by = {};
  for (const r of all) (by[r.d] ??= []).push(r);
  for (const [d, rows] of Object.entries(by)) { mkdirSync(join(dir, 'shards', d), { recursive: true }); writeFileSync(join(dir, 'shards', d, 'shop.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  const byId = {};
  for (const r of all) (byId[createHash('sha1').update(r.node_id).digest('hex').slice(0, 2)] ??= []).push(r);
  mkdirSync(join(dir, 'by-id'));
  for (const [h, rows] of Object.entries(byId)) writeFileSync(join(dir, 'by-id', `${h}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'shard-index.json'), JSON.stringify({ dispositions: Object.fromEntries(Object.entries(by).map(([d, rows]) => [d, { shop: rows.length }])) }));
  writeFileSync(join(dir, 'graph-coverage-summary.json'), JSON.stringify({ base_generation_id: 'g-1', admitted_nodes: 11, reached_nodes: 3, reach_share_of_admitted_nodes: 3 / 11, reach_share_label: 'an evidence-anchor and navigation reach, not a semantic correctness score',
    by_disposition: Object.fromEntries(Object.entries(by).map(([d, rows]) => [d, rows.length])), unplaced_reasons: { file_not_cited: 5, claim_layer_unreached: 3 }, by_plane: {}, denominators: { admitted_graph_nodes: 11 } }));
  return dir;
}
const nodesByKind = async () => ({ data: { nodes: [] } });
const map = (coverage = openCoverage(artifact())) => createOntologyMap({ explored, details: new Map([['c:0', { definition: 'A concept' }]]), binding, coverage, queries: { nodesByKind }, view: 'working', projection: { projection_id: 'p' } });

test('the overview is ontology nodes in the graph shape, joined by structural containment', () => {
  const { nodes, edges } = map().overview();
  assert.ok(nodes.every(n => n.id.startsWith('ontology:') && n.properties.status.includes('proposed')));
  assert.ok(edges.every(e => e.role === 'structural' && e.parent_end === 'from' && e.relation === 'contains'));
  assert.deepEqual(nodes.map(n => n.kind), ['OntologyRoot', 'OntologyGroup', 'OntologyGroup', 'OntologyCoverage']);
});

test('a concept keeps the exact predicate and shows real graph ids, apart from the proposal', async () => {
  const found = await map().node('ontology:concept:0');
  const typed = found.neighbors.find(r => r.edge.relation === 'is-checked-before');
  assert.equal(typed.edge.role, 'flow');
  assert.equal(typed.edge.properties.relation_index, 0);
  const cited = found.neighbors.find(r => r.edge.relation === 'cited in (exact content match)');
  assert.deepEqual([cited.node.id, cited.node.kind], ['doc:shop/a.md', 'Document']);
  assert.ok(found.neighbors.some(r => r.node.id === 'code-fact:1' && r.edge.relation === 'anchored in the quoted lines'));
});

test('a large domain loads a bounded page with a counted bundle, and the rest is reachable by offset', async () => {
  const m = map(), first = await m.node('ontology:domain:0', { quota: 30 });
  assert.equal(first.neighbors.filter(r => r.node.kind === 'OntologyConcept').length, 30);
  assert.equal(first.bundles.find(b => b.kind === 'OntologyConcept').count, 40);
  const rest = await m.neighbors('ontology:domain:0', { relation: 'contains', direction: 'out', offset: 30, limit: 1000 });
  assert.deepEqual([rest.adjacent_nodes.length, rest.truncated], [10, false]);
});

test('the coverage node reports an evidence-anchor reach with its own label, over every admitted node', async () => {
  const found = await map().node('ontology:coverage');
  const props = found.node.properties;
  assert.deepEqual([props.admitted_graph_nodes, props.reached, props.not_reached], [11, 3, 8]);
  assert.match(props.share_label, /not a semantic correctness score/);
  const kids = found.neighbors.filter(r => r.edge.relation === 'contains' && r.node.kind === 'OntologyCoverage').map(r => [r.node.id, r.node.properties.counted_as_reached]);
  assert.deepEqual(kids.find(([id]) => id === 'ontology:cov:unplaced'), ['ontology:cov:unplaced', false]);
  assert.deepEqual(kids.find(([id]) => id === 'ontology:cov:evidence_anchored'), ['ontology:cov:evidence_anchored', true]);
});

test('every disposition opens by repository down to real node ids, with the reason or the owner', async () => {
  const m = map();
  const repos = await m.node('ontology:cov:unplaced');
  assert.ok(repos.neighbors.some(r => r.node.id === 'ontology:cov:unplaced:shop'));
  const listed = await m.node('ontology:cov:unplaced:shop');
  const nodes = listed.neighbors.filter(r => r.edge.relation === 'lists');
  assert.equal(nodes.length, 8);
  assert.equal(nodes[0].edge.properties.reason, 'file_not_cited');
  const page = await m.neighbors('ontology:cov:unplaced:shop', { relation: 'lists', direction: 'out', offset: 6, limit: 10 });
  assert.deepEqual(page.adjacent_nodes.map(n => n.id), ['n:16', 'n:17']);
  const detail = await m.node('ontology:cov:owned_detail:shop');
  assert.deepEqual(detail.neighbors.find(r => r.edge.relation === 'lists').edge.properties.via, 'n:1');
});

test('one node can be explained from its hashed shard, and an absent node is not invented', async () => {
  const c = openCoverage(artifact());
  assert.equal((await c.explain('n:1')).via[0].concept, 'c:0');
  assert.equal(await c.explain('n:999'), null);
  assert.equal((await c.page('unplaced', 'shop', 2, 2)).length, 2);
});

test('without an artifact no reach is claimed and the coverage node says so', async () => {
  const found = await map(noCoverage(11)).node('ontology:coverage');
  assert.equal(found.node.properties.reached, 0);
  assert.match(found.node.properties.share_label, /no reach is claimed/);
});

const loop = [{ round: 1, coverage: { before: { reached: 3, share: 0.27 }, after_with_proposal_layer: { reached: 4, share: 0.36 }, proposal_anchors_applied: 1, label: 'reach, not a semantic score' }, frontier: { families: 2, causes_before_model: { file_cited_elsewhere: 2 } }, measures: {}, cost: { usd: 0 },
  complexity: { before: { concepts: 1 }, after: { concepts: 1 } }, causes_after_model: {},
  proposals: [{ proposal_id: 'p:1', label: 'Proposed thing', semantic_category: 'type', definition: 'd', inclusion: 'i', exclusion: 'e', instance_conditions: [], witness: { file: 'a.js', start_line: 1, end_line: 2, quote: 'q' } }],
  bindings: [{ node_id: 'code-fact:9', node_kind: 'CodeFact', node_label: 'x', concept: 'p:1', evidence: { file: 'a.js', start_line: 1, end_line: 2, quote: 'q' } }, { node_id: 'code-fact:8', node_kind: 'CodeFact', node_label: 'y', concept: 'c:0', evidence: { file: 'b.js', start_line: 3, end_line: 3, quote: 'q2' } }],
  groups: [{ canonical: { label: 'Group', definition: 'gd', instance_properties: [] }, relation: 'variant_of_existing', members: ['p:1'], existing_id: 'c:0', reason: 'r' }] }];

test('a coverage loop is a proposal layer: apart from the sealed ontology, labelled, and never counted into the sealed coverage', async () => {
  const m = createOntologyMap({ explored, details: new Map(), binding, coverage: openCoverage(artifact()), queries: { nodesByKind }, view: 'working', projection: { projection_id: 'p' }, loop });
  const root = await m.node('ontology:root');
  assert.ok(root.neighbors.some(r => r.node.id === 'ontology:loop' && r.node.kind === 'OntologyProposal'));
  const round = await m.node('ontology:loop:1');
  assert.match(round.node.properties.reach_before, /3 of 11/);
  assert.match(round.node.properties.reach_after_with_proposals, /4 of 11/);
  assert.equal(round.node.properties.share_label, 'reach, not a semantic score');
  const concept = await m.node('ontology:loop:1:concept:0');
  assert.equal(concept.node.properties.reviewed, false);
  assert.deepEqual(concept.neighbors.filter(r => r.edge.relation === 'would anchor (proposal)').map(r => r.node.id), ['code-fact:9']);
  const group = await m.node('ontology:loop:1:group:0');
  assert.ok(group.neighbors.some(r => r.node.id === 'ontology:concept:0' && r.edge.relation === 'variant of existing (proposal)'));
  const sealed = await m.node('ontology:concept:0');
  const proposed = sealed.neighbors.find(r => r.edge.relation === 'proposed anchor, round 1 (not reviewed)');
  assert.equal(proposed.node.id, 'code-fact:8');
  assert.ok(!sealed.neighbors.some(r => r.edge.relation === 'cited in (exact content match)' && r.node.id === 'code-fact:8'));
  assert.equal((await m.node('ontology:coverage')).node.properties.reached, 3);
});

test('searching finds ontology nodes by name and an unknown id is not in the map', async () => {
  const m = map();
  assert.deepEqual(m.search('checkout').map(h => h.id), ['ontology:domain:0']);
  assert.equal(await m.node('ontology:concept:999'), null);
  assert.equal(await m.node('doc:shop/a.md'), null);
});
