import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForkPlanningView, validateForkOverlay } from '../tools/fork-planning-view.mjs';

const fixturePath = new URL('./fixtures/fork-planning-overlay.json', import.meta.url);
const fixture = () => JSON.parse(readFileSync(fixturePath, 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
async function withServer(options, run) {
  const server = createForkPlanningView(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function graphFixture(projectionId = 'estate-projection:widget-proof') {
  const dir = mkdtempSync(join(tmpdir(), 'fork-view-widget-'));
  const nodes = [{ node_id: 'module:widget-shell', kind: 'Module', label: 'Widget shell', properties: { namespace: 'widget/src/shell.mjs', source_commit: '2'.repeat(40) } },
    { node_id: 'module:widget-service', kind: 'Module', label: 'Widget service', properties: { namespace: 'widget/src/service.mjs' } }];
  const edges = [{ from: 'module:widget-shell', to: 'module:widget-service', relation: 'calls' }];
  const nodesText = `${nodes.map(JSON.stringify).join('\n')}\n`, edgesText = `${edges.map(JSON.stringify).join('\n')}\n`;
  const nodesPath = join(dir, 'nodes.jsonl'), edgesPath = join(dir, 'edges.jsonl'), manifest = join(dir, 'graph.json');
  writeFileSync(nodesPath, nodesText); writeFileSync(edgesPath, edgesText);
  writeFileSync(manifest, JSON.stringify({ schema: 'estate-map/fork-planning-graph-source/v1', projection_id: projectionId,
    nodes_path: nodesPath, edges_path: edgesPath, nodes_sha256: hash(nodesText), edges_sha256: hash(edgesText) }));
  return { manifest, nodesPath, overlayPath: fixturePath.pathname };
}

test('invented scenario loads with observed layer explicitly pending when no graph is supplied', async () => {
  await withServer({ overlay_path: fixturePath.pathname }, async origin => {
    const data = await fetch(`${origin}/api/fork-planning`).then(res => res.json());
    assert.deepEqual({ components: data.components.length, decisions: data.decisions.length, state: data.graph.state,
      verified: data.components.some(c => c.implementation_verified) },
    { components: 4, decisions: 2, state: 'pending', verified: false });
  });
});

test('actual graph artifact binds exact component IDs and read-only adjacent edges', async () => {
  const graph = graphFixture();
  await withServer({ overlay_path: graph.overlayPath, graph_manifest: graph.manifest }, async origin => {
    const [view, detail] = await Promise.all([
      fetch(`${origin}/api/fork-planning`).then(res => res.json()),
      fetch(`${origin}/api/fork-planning/component?id=widget-shell`).then(res => res.json()),
    ]);
    assert.deepEqual({ state: view.graph.state, matches: view.graph.matched_nodes,
      node: detail.observed.nodes[0].node_id, edge: detail.observed.edges[0].relation,
      separateVerifiedField: detail.component.implementation_verified },
    { state: 'matched', matches: 2, node: 'module:widget-shell', edge: 'calls', separateVerifiedField: false });
  });
});

test('ambiguous graph refs fail closed instead of attributing one node to two components', async () => {
  const graph = graphFixture();
  const overlay = fixture(); overlay.components[2].graph_refs = [{ node_id: 'module:widget-shell' }];
  const path = join(mkdtempSync(join(tmpdir(), 'fork-view-overlay-')), 'scenario.json');
  writeFileSync(path, JSON.stringify(overlay));
  await withServer({ overlay_path: path, graph_manifest: graph.manifest }, async origin => {
    const view = await fetch(`${origin}/api/fork-planning`).then(res => res.json());
    assert.deepEqual({ state: view.graph.state, matches: view.graph.matched_nodes, reason: view.graph.reason },
      { state: 'pending', matches: 0, reason: 'FORK_VIEW_GRAPH_REF_AMBIGUOUS' });
  });
});

test('shared Repository anchors locate multiple planning components without claiming native component facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-view-locator-'));
  const overlay = fixture();
  for (const component of overlay.components.slice(0, 2)) component.graph_refs = [{ node_id: 'repository:widgets', kind: 'Repository', association: 'repository_locator' }];
  const scenario = join(dir, 'scenario.json'); writeFileSync(scenario, JSON.stringify(overlay));
  const nodesText = `${JSON.stringify({ node_id: 'repository:widgets', kind: 'Repository', label: 'widgets', properties: { namespace: 'widgets' } })}\n`;
  const edgesText = '';const nodesPath = join(dir, 'nodes.jsonl'), edgesPath = join(dir, 'edges.jsonl');
  writeFileSync(nodesPath, nodesText);writeFileSync(edgesPath, edgesText);
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schema: 'estate-map/fork-planning-graph-source/v1', projection_id: overlay.expected_projection_id,
    nodes_path: nodesPath, edges_path: edgesPath, nodes_sha256: hash(nodesText), edges_sha256: hash(edgesText) }));
  await withServer({ overlay_path: scenario, graph_manifest: manifest }, async origin => {
    const [view, detail] = await Promise.all([
      fetch(`${origin}/api/fork-planning`).then(res => res.json()),
      fetch(`${origin}/api/fork-planning/component?id=widget-shell`).then(res => res.json()),
    ]);
    assert.deepEqual({ state: view.graph.state, nodes: view.graph.matched_nodes,
      located: view.graph.locator_components, native: view.graph.native_components,
      inspector: detail.observed.state, association: detail.observed.nodes[0].association },
    { state: 'matched', nodes: 1, located: 2, native: 0,
      inspector: 'repository_locator', association: 'repository_locator' });
  });
});

test('a matching Module file is a source locator, not a product-architecture fact', async () => {
  const graph = graphFixture();const overlay = fixture();
  overlay.components[0].graph_refs = [{ node_id: 'module:widget-shell', kind: 'Module', association: 'source_locator' }];
  const scenario = join(mkdtempSync(join(tmpdir(), 'fork-view-source-locator-')), 'scenario.json');
  writeFileSync(scenario, JSON.stringify(overlay));
  await withServer({ overlay_path: scenario, graph_manifest: graph.manifest }, async origin => {
    const [view, detail] = await Promise.all([
      fetch(`${origin}/api/fork-planning`).then(res => res.json()),
      fetch(`${origin}/api/fork-planning/component?id=widget-shell`).then(res => res.json()),
    ]);
    assert.deepEqual({ native_for_this_component: view.components[0].graph_matches,
      located: view.components[0].graph_locators,
      inspector: detail.observed.state, association: detail.observed.nodes[0].association },
    { native_for_this_component: 0, located: 1, inspector: 'source_locator', association: 'source_locator' });
  });
});

test('derived build prediction and shared root cause do not become observed proof or dependency', async () => {
  const overlay = fixture();
  overlay.components[0].predicted_consequence = 'An archive may contain the older config; build readback was not run.';
  overlay.components[0].related_by_shared_root_cause = ['widget-service'];
  const path = join(mkdtempSync(join(tmpdir(), 'fork-view-prediction-')), 'scenario.json');
  writeFileSync(path, JSON.stringify(overlay));
  await withServer({ overlay_path: path }, async origin => {
    const result = await fetch(`${origin}/api/fork-planning/component?id=widget-shell`).then(res => res.json());
    assert.deepEqual({ prediction: result.component.predicted_consequence,
      related: result.component.related_by_shared_root_cause, dependencies: result.component.dependencies,
      observed: result.observed.state, verified: result.component.implementation_verified },
    { prediction: overlay.components[0].predicted_consequence, related: ['widget-service'], dependencies: [],
      observed: 'pending', verified: false });
  });
});

test('projection mismatch keeps the claimed plan while refusing observed graph attachment', async () => {
  const graph = graphFixture('estate-projection:different');
  await withServer({ overlay_path: graph.overlayPath, graph_manifest: graph.manifest }, async origin => {
    const view = await fetch(`${origin}/api/fork-planning`).then(res => res.json());
    assert.deepEqual({ state: view.graph.state, components: view.components.length, matches: view.graph.matched_nodes },
      { state: 'mismatch', components: 4, matches: 0 });
  });
});

test('a content-digest mismatch blocks observed facts even when projection ids match', async () => {
  const graph = graphFixture();const overlay = fixture();
  overlay.expected_content_digest = 'a'.repeat(64);
  const scenario = join(mkdtempSync(join(tmpdir(), 'fork-view-content-')), 'scenario.json');
  writeFileSync(scenario, JSON.stringify(overlay));
  await withServer({ overlay_path: scenario, graph_manifest: graph.manifest }, async origin => {
    const view = await fetch(`${origin}/api/fork-planning`).then(res => res.json());
    assert.deepEqual({ state: view.graph.state, matches: view.graph.matched_nodes }, { state: 'mismatch', matches: 0 });
  });
});

test('tampered graph JSONL cannot be shown as observed evidence', async () => {
  const graph = graphFixture();
  writeFileSync(graph.nodesPath, 'not the pinned graph\n');
  await withServer({ overlay_path: graph.overlayPath, graph_manifest: graph.manifest }, async origin => {
    const view = await fetch(`${origin}/api/fork-planning`).then(res => res.json());
    assert.deepEqual({ state: view.graph.state, matches: view.graph.matched_nodes }, { state: 'pending', matches: 0 });
  });
});

test('a missing private scenario is browsable as an honest empty/pending state', async () => {
  await withServer({}, async origin => {
    const [page, view] = await Promise.all([
      fetch(origin).then(res => res.text()), fetch(`${origin}/api/fork-planning`).then(res => res.json()),
    ]);
    assert.deepEqual({ page: page.includes('fork-graph'), state: view.graph.state, components: view.components.length },
      { page: true, state: 'pending', components: 0 });
  });
});

test('overlay cannot publish a credential-shaped provider field', () => {
  const overlay = fixture(); overlay.components[0].api_key = 'secret value';
  assert.throws(() => validateForkOverlay(overlay), error => error.code === 'FORK_VIEW_SECRET_REFUSED');
});

test('an approved decision and implementation proof remain separate fields', () => {
  const overlay = fixture();
  assert.deepEqual({ decisions: overlay.components[1].approved_decision_ids.length,
    implementation_verified: validateForkOverlay(overlay).components[1].implementation_verified },
  { decisions: 1, implementation_verified: false });
});

test('claimed current evidence must disclose its standing rather than posing as observation', () => {
  const overlay = fixture(); delete overlay.components[0].current_evidence[0].standing;
  assert.throws(() => validateForkOverlay(overlay), error => error.code === 'FORK_VIEW_SOURCE_REF_INVALID');
});

test('unsupported write methods never mutate overlays or graph', async () => {
  await withServer({ overlay_path: fixturePath.pathname }, async origin => {
    const response = await fetch(`${origin}/api/fork-planning`, { method: 'POST', body: '{"approved":true}' });
    assert.equal(response.status, 405);
  });
});
