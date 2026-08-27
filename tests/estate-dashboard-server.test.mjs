import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { EstateGraphQueries } from '../tools/estate-graph-query.mjs';
import { createEstateDashboardServer } from '../tools/estate-dashboard-server.mjs';

function fixtureQueries() {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  const queries = new EstateGraphQueries({ client });
  queries.overview = async ({ view }) => ({
    schema: 'estate-map/query-result/v1', query: 'overview',
    projection: { projection_id: 'estate-projection:test', status: view || 'selected' },
    data: { nodes: [{ id: 'project:test', kind: 'Project', label: 'test', properties: {} }], edges: [] },
  });
  queries.node = async ({ id, expand }) => ({ schema: 'estate-map/query-result/v1', query: 'node', expand: expand ?? 'structural',
    projection: { projection_id: 'estate-projection:test', status: 'selected' },
    data: { node: { id, kind: 'Plugin', label: id, properties: {} }, neighbors: [], bundles: [] } });
  queries.neighbors = async ({ id, relation, direction }) => ({ schema: 'estate-map/query-result/v1', query: 'neighbors',
    relation: relation ?? null, direction: direction ?? 'both',
    projection: { projection_id: 'estate-projection:test', status: 'selected' },
    data: { focal_node: { id, kind: 'Plugin', label: id, properties: {} }, adjacent_nodes: [], edges: [] } });
  return queries;
}

async function withServer(run) {
  const server = createEstateDashboardServer({ queries: fixtureQueries() });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('dashboard serves the graph application and bounded overview API', async () => {
  await withServer(async origin => {
    const [page, result] = await Promise.all([
      fetch(`${origin}/`).then(response => response.text()),
      fetch(`${origin}/api/overview?view=working`).then(response => response.json()),
    ]);
    assert.deepEqual({
      graphFirst: page.includes('id="graph"'),
      noScriptedCypher: page.includes('cypher'),
      query: result.query,
      projection: result.projection.status,
      firstKind: result.data.nodes[0].kind,
    }, { graphFirst: true, noScriptedCypher: false, query: 'overview',
      projection: 'working', firstKind: 'Project' });
  });
});

test('dashboard exposes node expansion and bounded relation neighbours for bundle drill-down', async () => {
  await withServer(async origin => {
    const [structural, atoms, bundle] = await Promise.all([
      fetch(`${origin}/api/node?id=plugin:one`).then(response => response.json()),
      fetch(`${origin}/api/node?id=plugin:one&expand=all`).then(response => response.json()),
      fetch(`${origin}/api/neighbors?id=plugin:one&relation=documented_in&direction=in`).then(response => response.json()),
    ]);
    assert.deepEqual([structural.expand, atoms.expand, bundle.query, bundle.relation, bundle.direction],
      ['structural', 'all', 'neighbors', 'documented_in', 'in']);
  });
});

test('dashboard rejects unknown API routes without serving the HTML fallback', async () => {
  await withServer(async origin => {
    const response = await fetch(`${origin}/api/arbitrary-cypher`);
    const body = await response.json();
    assert.deepEqual({ status: response.status, error: body.error }, {
      status: 404, error: 'ESTATE_DASHBOARD_ROUTE_MISSING',
    });
  });
});
