import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { anchorsOfGeneration, computeCoverage, summariseCoverage, guardAnchorsByPin } from '../tools/ontology/graph-coverage.mjs';

async function* of(rows) { for (const r of rows) yield r; }
const node = (node_id, kind, properties, plane = 'observation') => ({ node_id, kind, plane, properties });
const edge = (relation, from, to) => ({ relation, from, to });
const PIN = 'a'.repeat(40);

const nodes = [
  node('repo', 'Repository', { repository: 'shop' }),
  node('commit', 'SourceCommit', {}),
  node('modA', 'Module', { repository: 'shop', file: 'src/a.js' }),
  node('fnA', 'Symbol', { namespace: 'shop/src/a.js' }),
  node('factA', 'CodeFact', { repository: 'shop', file: 'src/a.js', line: 10 }),
  node('fieldA', 'LiteralValue', { repository: 'shop', file: 'src/a.js', line: 40 }),
  node('modB', 'Module', { repository: 'shop', file: 'src/b.js' }),
  node('factB', 'CodeFact', { repository: 'shop', file: 'src/b.js', line: 3 }),
  node('docR', 'Document', { path: 'shop/README.md' }),
  node('secOne', 'DocumentSection', { repository: 'shop', file: 'README.md', line: 1 }),
  node('secTwo', 'DocumentSection', { repository: 'shop', file: 'README.md', line: 20 }),
  node('claimTail', 'Claim', { source_path: 'shop/README.md', source_line: 30 }, 'documentary'),
  node('msg', 'Envelope', { repository: 'shop', file: 'src/a.js' }),
  node('otherUser', 'Module', { repository: 'shop', file: 'src/c.js' }),
  node('deep1', 'Symbol', { namespace: 'shop/src/a.js' }), node('deep2', 'Symbol', { namespace: 'shop/src/a.js' }), node('deep3', 'Symbol', { namespace: 'shop/src/a.js' }), node('deep4', 'Symbol', { namespace: 'shop/src/a.js' }),
];
const edges = [
  edge('contains', 'repo', 'modA'), edge('contains', 'repo', 'modB'), edge('contains', 'commit', 'modA'),
  edge('contains', 'docR', 'secOne'), edge('contains', 'docR', 'secTwo'), edge('contains', 'docR', 'claimTail'),
  edge('identifies', 'factA', 'fnA'), edge('declares_symbol', 'modA', 'fnA'), edge('declares_value', 'fnA', 'fieldA'),
  edge('imports', 'modA', 'modB'), edge('observed_in', 'factB', 'commit'),
  edge('emits', 'fnA', 'msg'), edge('consumes', 'otherUser', 'msg'),
  edge('declares_symbol', 'fieldA', 'deep1'), edge('declares_symbol', 'deep1', 'deep2'), edge('declares_symbol', 'deep2', 'deep3'), edge('declares_symbol', 'deep3', 'deep4'),
];
const ev = (extra) => ({ role: 'support', repository: 'shop', commit_sha: PIN, concept_accession: 'c1', evidence_id: 'e1', ...extra });
const generation = { collections: [{ evidence: [
  ev({ path: 'src/a.js', start_line: 9, end_line: 12 }),
  ev({ role: 'counterexample', path: 'src/b.js', start_line: 3, end_line: 3, evidence_id: 'e2' }),
  ev({ path: 'README.md', start_line: 2, end_line: 2, concept_accession: 'c2', evidence_id: 'e3' })] }],
  assertions: [{ polarity: 'deny', occurrence: { repository: 'shop', path: 'src/b.js', start_line: 3, end_line: 3, commit_sha: PIN }, concept_accession: 'c3', assertion_id: 'a1' }] };
const run = (overrides = {}) => computeCoverage({ nodes: of(nodes), edges: of(edges), anchors: anchorsOfGeneration(generation), repositories: ['shop'], graphPins: { shop: PIN }, ...overrides });

test('a cited line anchors the node it contains and its owned structure follows; no flood through a file, a commit or an import', async () => {
  const d = id => run().then(r => r.state.get(id).d);
  const r = await run();
  const dd = id => r.state.get(id).d;
  assert.deepEqual([dd('factA'), dd('fnA'), dd('fieldA'), dd('modA'), dd('modB'), dd('factB'), dd('repo'), dd('commit')],
    ['evidence_anchored', 'anchored_entity', 'owned_detail', 'unplaced', 'unplaced', 'unplaced', 'locator_root', 'locator_root']);
  void d;
});

test('a cited README is a locator: its uncited sections and claims stay unplaced, and only the section holding the quoted line is anchored', async () => {
  const r = await run(), d = id => r.state.get(id).d;
  assert.deepEqual([d('docR'), d('secOne'), d('secTwo'), d('claimTail'), r.state.get('secTwo').reason, r.state.get('claimTail').reason], ['cited_document_locator', 'evidence_anchored', 'unplaced', 'unplaced', 'file_cited_elsewhere_in_it', 'claim_layer_unreached']);
});

test('participation is one hop and ends there; a shared message reaches its emitter side but not other consumers', async () => {
  const r = await run(), d = id => r.state.get(id).d;
  assert.deepEqual([d('msg'), d('otherUser'), r.state.get('otherUser').reason], ['participates_with_grounded', 'unplaced', 'file_not_cited']);
});

test('nodes beyond the walk depth are reported as policy-limited, not as having no route', async () => {
  const r = await run();
  assert.deepEqual([r.state.get('deep2').d, r.state.get('deep3').reason], ['owned_detail', 'policy_depth_limit']);
});

test('anchors read at another commit than the graph, or in a repository with no graph commit, are not applied', async () => {
  const wrong = await run({ graphPins: { shop: 'b'.repeat(40) } });
  const none = await run({ graphPins: {} });
  assert.deepEqual([wrong.state.get('factA').d, wrong.anchors_applied, wrong.anchors_dropped.pin_mismatch, none.anchors_dropped.no_graph_pin > 0, guardAnchorsByPin([], { shop: PIN }).kept.length],
    ['unplaced', 0, 2, true, 0]);
  await assert.rejects(() => computeCoverage({ nodes: of(nodes), edges: of(edges), anchors: [], repositories: ['shop'] }), /graphPins is required/);
});

test('counterexamples and denials never anchor, and summaries count every admitted node once with the reach labelled as navigation', async () => {
  const r = await run();
  const s = summariseCoverage(r);
  assert.deepEqual([r.state.get('factB').d, s.admitted_nodes, Object.values(s.by_disposition).reduce((a, b) => a + b, 0), /not a semantic correctness score/.test(s.reach_share_label), s.by_plane.documentary.unplaced > 0],
    ['unplaced', nodes.length, nodes.length, true, true]);
});

test('coverage shards return a bounded page and explain one node without loading the graph', async () => {
  const { writeCoverageShards, coveragePage, coverageExplain } = await import('../tools/ontology/graph-coverage-store.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const result = await run();
  const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
  await writeCoverageShards(dir, result);
  const page = await coveragePage(dir, { disposition: 'unplaced', repository: 'shop', limit: 2 });
  const why = await coverageExplain(dir, 'fnA');
  assert.deepEqual([page.rows.length, page.matching > 2, why.d, why.via[0].identified_by, (await coverageExplain(dir, 'nope'))], [2, true, 'anchored_entity', 'factA', null]);
});
