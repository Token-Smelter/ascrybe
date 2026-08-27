import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { EstateGraphQueries } from '../tools/estate-graph-query.mjs';
import { boundedCypherStatement, runCypher, validateCypherQuery, CYPHER_ROW_CAP } from '../tools/estate-graph-cypher.mjs';
import { createCypherArm } from '../tools/eval/cypher-arm.mjs';

const projectionRow = [
  'estate-projection:one', 'selected', '1'.repeat(40), 'content:one',
  'claim-map:one', 'code-graph:one', 10, 10, 20, 20, 'unified-serving-projection@2',
];

function fixtureQueries(handler) {
  const client = new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
  client.query = async () => [projectionRow];
  client.request = async (_url, { statements }) => {
    const { statement, parameters } = statements[0];
    return { payload: { results: [{ columns: ['id'], data: handler(statement, parameters).map(row => ({ row })) }] } };
  };
  return new EstateGraphQueries({ client });
}

test('the gateway refuses writes, procedures, multi-statements, and unscoped queries by type', () => {
  const scoped = "MATCH (n:EstateNode {projection_id: $projection_id}) RETURN n.label";
  const refusals = [
    ["MATCH (n:EstateNode {projection_id: $projection_id}) SET n.x = 1 RETURN n", 'ESTATE_CYPHER_READ_ONLY'],
    ["CREATE (n:EstateNode) RETURN n", 'ESTATE_CYPHER_READ_ONLY'],
    [`${scoped} // comment\n; MATCH (m) RETURN m`, 'ESTATE_CYPHER_MULTI_STATEMENT'],
    ["CALL db.labels() YIELD label RETURN label", 'ESTATE_CYPHER_PROCEDURE'],
    ["MATCH (n:EstateNode) RETURN n.label", 'ESTATE_CYPHER_UNSCOPED'],
    ["MATCH (n:EstateNode {projection_id: $projection_id}) WHERE n.label = 'x'", 'ESTATE_CYPHER_RETURN_REQUIRED'],
  ];
  for (const [query, code] of refusals) {
    assert.throws(() => validateCypherQuery(query), error => error.code === code, query);
  }
  // Keywords inside string literals and comments are data, not clauses.
  assert.equal(typeof validateCypherQuery(
    "MATCH (n:EstateNode {projection_id: $projection_id}) WHERE n.label CONTAINS 'CREATE TABLE' /* SET */ RETURN n.label"), 'string');
});

test('the gateway wraps the query for a disclosed row cap and injects the projection parameter', async () => {
  let seen;
  const queries = fixtureQueries((statement, parameters) => {
    seen = { statement, parameters };
    return Array.from({ length: CYPHER_ROW_CAP + 1 }, (_, index) => [index]);
  });
  const result = await runCypher({ queries,
    query: 'MATCH (n:EstateNode {projection_id: $projection_id}) RETURN n.node_id AS id',
    parameters: { term: 'x' } });
  assert.deepEqual({
    wrapped: seen.statement.startsWith('CALL { MATCH') && seen.statement.endsWith(`RETURN * LIMIT ${CYPHER_ROW_CAP + 1}`),
    projection: seen.parameters.projection_id,
    passthrough: seen.parameters.term,
    rows: result.rows.length,
    columns: result.columns,
    truncated: result.truncated,
    projection_bound: result.projection.projection_id,
  }, {
    wrapped: true, projection: 'estate-projection:one', passthrough: 'x',
    rows: CYPHER_ROW_CAP, columns: ['id'], truncated: true, projection_bound: 'estate-projection:one',
  });
  await assert.rejects(() => runCypher({ queries,
    query: 'MATCH (n:EstateNode {projection_id: $projection_id}) RETURN n',
    parameters: { projection_id: 'estate-projection:forged' } }),
  error => error.code === 'ESTATE_CYPHER_PARAMETERS_INVALID');
  assert.equal(boundedCypherStatement('RETURN 1', 5), 'CALL { RETURN 1 } RETURN * LIMIT 6');
});

test('pretty-printed JSON string cells come back compact without changing their value', async () => {
  const queries = fixtureQueries(() => [[' {"a": 1}', '{\n  "witnesses": [\n    {\n      "line": 4417\n    }\n  ]\n}', 'plain text {not json']]);
  const result = await runCypher({ queries, query: 'MATCH (n:EstateNode {projection_id: $projection_id}) RETURN n.properties_json' });
  assert.deepEqual(result.rows[0], [' {"a": 1}', '{"witnesses":[{"line":4417}]}', 'plain text {not json']);
});

test('the cypher arm exposes one query tool plus pinned read-span, filters benchmark rows, and surfaces typed refusals', async () => {
  const secret = 'FAKE_BENCHMARK_ANSWER_KEY_SECRET';
  const arm = createCypherArm({
    runtime_config_path: '/controller-only/runtime.json',
    cypher_script: '/controller-only/cypher.mjs',
    query_script: '/controller-only/query.mjs',
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] },
    execute: async (_node, argv) => {
      if (argv[0] === '/controller-only/cypher.mjs') {
        if (argv[argv.indexOf('--query') + 1].includes('refuse-me')) {
          const error = new Error('exit 1');
          error.stderr = '{"error":"ESTATE_CYPHER_READ_ONLY","message":"SET is not available","detail":null}\n';
          throw error;
        }
        return { stdout: JSON.stringify({ schema: 'estate-map/cypher-result/v1', query: 'cypher',
          projection: { projection_id: 'estate-projection:one' }, row_cap: 200, row_count: 2, truncated: false,
          rows: [
            [{ id: 'fact:ordinary', properties: { file: 'records.yaml' } }],
            [{ id: 'fact:benchmark', label: secret, properties: { file: 'benchmarks/answer-key.md' } }],
          ] }) };
      }
      throw new Error(`unexpected script: ${argv[0]}`);
    },
  });
  assert.deepEqual(arm.schema.allowed_tool_names, ['estate_cypher', 'estate_query']);
  assert.equal(/credential|password|shell/iu.test(JSON.stringify(arm.schema)), false);
  const result = await arm.tools.estate_cypher({ query: 'MATCH (n:EstateNode {projection_id: $projection_id}) RETURN n' });
  assert.deepEqual({
    rows: result.rows.flat().map(row => row.id),
    leaked: JSON.stringify(result).includes(secret),
    filter: result.benchmark_filter,
  }, { rows: ['fact:ordinary'], leaked: false, filter: { filtered_count: 1, excluded_path_prefixes: ['benchmarks'] } });
  const refusal = await arm.tools.estate_cypher({ query: 'refuse-me' });
  assert.equal(refusal.error, 'ESTATE_CYPHER_READ_ONLY');
  await assert.rejects(() => arm.tools.estate_query({ command: 'search', arguments: { term: 'x' } }),
    /only for read-span/u);
});

test('index-only mode removes read-span from the cypher arm entirely', () => {
  const arm = createCypherArm({
    runtime_config_path: '/controller-only/runtime.json',
    cypher_script: '/controller-only/cypher.mjs',
    query_script: '/controller-only/query.mjs',
    graph_mode: 'index-only',
    execute: async () => ({ stdout: '{}' }),
  });
  assert.deepEqual(arm.schema.allowed_tool_names, ['estate_cypher']);
});
