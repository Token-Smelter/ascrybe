import assert from 'node:assert/strict';
import test from 'node:test';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { EstateGraphQueries } from '../tools/estate-graph-query.mjs';
import { buildCodeDependencyRelations, traversableRelations } from '../tools/code-dependency-relations.mjs';
import { buildUnifiedEstateProjection } from '../tools/estate-graph-projection.mjs';
import envelopeExtractor from '../tools/extractors/envelopes.mjs';
import { filterBenchmarkRows } from '../tools/eval/graph-arm.mjs';

const projection = ['estate-projection:test', 'selected', '1'.repeat(40), 'content', 'claim', 'code', 4, 4, 3, 3];
function queries(handler) {
  const client = new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
  client.query = async (statement, parameters) => statement.includes('EstateProjectionHead') ? [projection] : handler(statement, parameters);
  return new EstateGraphQueries({ client });
}

function projectedDocument(path) {
  const state = buildUnifiedEstateProjection({
    claim_map: { schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
      project: { id: 'producer-fixture', sha: '1'.repeat(40) },
      claims: [{ claim_id: 'estate-claim:raw-document', claim_key: `${path}:1`, statement: 'raw path',
        claim_kind: 'accepted_design', source_status: 'current', decision_status: 'accepted', valid_time: null,
        source: { path, line: 1, quote: 'raw path', blob_oid: 'blob:raw', content_sha256: 'a'.repeat(64) },
        proof_plan: null }], evidence: [], obligation_results: [], adjudication_receipts: [],
      supersession_receipts: [], edges: [], coverage: {}, policy: {} },
  });
  return state.nodes.find(node => node.kind === 'Document');
}

function manifestConsumerRows() {
  const declarations = [
    ['publisher', 'publishes_envelopes:\n  - kind: work_order.accepted'],
    ['subscriber', 'subscribes_envelopes:\n  - kind: work_order.accepted'],
  ];
  const candidates = declarations.flatMap(([name, source]) => {
    const file = `plugins/${name}/plugin.yaml`;
    const facts = envelopeExtractor.scan(source.split('\n'), { repo: 'app', file,
      fact(kind, line, record) { return { kind, repo: 'app', file, line, ...record }; },
    }).filter(fact => fact.kind === 'envelope_flow');
    return [
      { fact_id: `manifest:${name}`, fact_kind: 'yaml_document',
        record: { repo: 'app', file, doc_name: name }, mention: { mention_id: `manifest:${name}` } },
      { fact_id: `flow:${name}`, fact_kind: 'envelope_flow', record: { ...facts[0], owner: name },
        mention: { mention_id: `flow:${name}` } },
    ];
  });
  const relations = buildCodeDependencyRelations({ merge_graph: { nodes: [], edges: [] },
    code_plane_head: 'code-plane:producer-fixture', identity_candidates: candidates }).relations;
  const walkable = traversableRelations({ relations, mention_resolutions: candidates.map(candidate => ({
    mention_id: candidate.mention.mention_id,
    referent_id: candidate.fact_kind === 'yaml_document' ? `plugin:app:${candidate.record.doc_name}`
      : `envelope:${candidate.record.envelope_kind}`,
    resolution_receipt_id: `resolution:${candidate.fact_id}`,
  })) });
  const sourceCommit = '1'.repeat(40);
  const projection = buildUnifiedEstateProjection({
    claim_map: { schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
      project: { id: 'producer-fixture', sha: sourceCommit }, claims: [], evidence: [], obligation_results: [],
      adjudication_receipts: [], supersession_receipts: [], edges: [] },
    code_graph: { schema: 'estate-map/remap-code-graph/v1', provenance: { source_head: sourceCommit },
      nodes: Object.fromEntries(candidates.map(candidate => [candidate.fact_kind === 'yaml_document'
        ? `plugin:app:${candidate.record.doc_name}` : `envelope:${candidate.record.envelope_kind}`, {
        k: 'entity', l: candidate.fact_kind === 'yaml_document' ? candidate.record.doc_name : candidate.record.envelope_kind,
        ns: candidate.record.file, r: candidate.fact_kind,
      }])), identity_bindings: [], relations: walkable, adj: {}, counts: {} },
  });
  const nodes = new Map(projection.nodes.map(node => [node.node_id, node]));
  return projection.edges.filter(edge => ['publishes_envelope', 'subscribes_envelope'].includes(edge.relation)).map(edge => {
    const participant = nodes.get(edge.from);
    return [edge.edge_id, edge.relation, participant.node_id, participant.kind, participant.label,
      JSON.stringify(participant.properties), edge.from, edge.to, JSON.stringify(edge.properties)];
  });
}

test('neighbors emits directed bounded records and rejects unsafe graph inputs before traversal', async () => {
  const seen = [];
  const graph = queries(async (statement, parameters) => {
    seen.push({ statement, parameters });
    if (statement.includes('LIMIT 2')) return [['envelope:work_order.accepted', 'Envelope', 'work_order.accepted', '{}']];
    return [
      ['edge:consume', 'consumes', 'plugin:consumer', 'envelope:work_order.accepted', 'plugin:consumer', 'Plugin', 'consumer', '{}', '{}'],
      ['edge:publish', 'publishes_envelope', 'plugin:publisher', 'envelope:work_order.accepted', 'plugin:publisher', 'Plugin', 'publisher', '{}', '{}'],
      ['edge:overflow', 'consumes', 'plugin:other', 'envelope:work_order.accepted', 'plugin:other', 'Plugin', 'other', '{}', '{}'],
    ];
  });
  const result = await graph.neighbors({ id: 'envelope:work_order.accepted', direction: 'in', limit: 2 });
  assert.deepEqual(result.data.edges.map(edge => [edge.relation, edge.from, edge.to]), [
    ['consumes', 'plugin:consumer', 'envelope:work_order.accepted'],
    ['publishes_envelope', 'plugin:publisher', 'envelope:work_order.accepted'],
  ]);
  assert.equal(result.truncated, true);
  assert.equal(seen.at(-1).parameters.direction, 'in');
  await assert.rejects(() => graph.neighbors({ id: 'x\0y' }), error => error.code === 'ESTATE_QUERY_NODE_ID_UNSAFE');
  await assert.rejects(() => graph.neighbors({ id: 'node:one', relation: 'x OR 1=1' }), error => error.code === 'ESTATE_QUERY_RELATION_INVALID');
  await assert.rejects(() => graph.neighbors({ id: 'node:one', direction: 'sideways' }), error => error.code === 'ESTATE_QUERY_DIRECTION_INVALID');
});

test('projected raw document IDs execute the traversal advertised by search', async () => {
  const document = projectedDocument('docs/100% café guide.md');
  const row = [document.node_id, document.kind, document.label, JSON.stringify(document.properties)];
  const graph = queries(async statement => {
    if (statement.includes('n.search_text')) return [row];
    if (statement.includes('LIMIT 2')) return [row];
    return [];
  });
  const search = await graph.search({ term: 'café' });
  const neighbors = search.data[0].next_queries.find(query => query.command === 'neighbors');
  assert.deepEqual(neighbors.arguments, { id: document.node_id, direction: 'both' });
  assert.equal((await graph.neighbors(neighbors.arguments)).data.focal_node.id, document.node_id);
});

test('neighbors uses explicit code-point ID order', async () => {
  const graph = queries(async statement => {
    if (statement.includes('LIMIT 2')) return [['envelope:work_order.accepted', 'Envelope', 'work_order.accepted', '{}']];
    return [
      ['edge:é', 'consumes', 'doc:é', 'envelope:work_order.accepted', 'doc:é', 'Document', 'é', '{}', '{}'],
      ['edge:a', 'consumes', 'doc:a', 'envelope:work_order.accepted', 'doc:a', 'Document', 'a', '{}', '{}'],
      ['edge:%', 'consumes', 'doc:%', 'envelope:work_order.accepted', 'doc:%', 'Document', '%', '{}', '{}'],
      ['edge:Z', 'consumes', 'doc:Z', 'envelope:work_order.accepted', 'doc:Z', 'Document', 'Z', '{}', '{}'],
    ];
  });
  const result = await graph.neighbors({ id: 'envelope:work_order.accepted', limit: 10 });
  assert.deepEqual(result.data.adjacent_nodes.map(node => node.id), ['doc:%', 'doc:Z', 'doc:a', 'doc:é']);
});

test('consumers groups publisher and subscriber rows derived from the real manifest producer', async () => {
  const rows = manifestConsumerRows();
  const graph = queries(async statement => {
    if (statement.includes('LIMIT 2')) return [['envelope:work_order.accepted', 'Envelope', 'work_order.accepted', '{}']];
    if (statement.includes('count(r)')) return [...new Map(rows.map(row => [row[1], 0]))].map(([relation]) =>
      [relation, rows.filter(row => row[1] === relation).length]);
    return rows;
  });
  const result = await graph.consumers({ id: 'envelope:work_order.accepted' });
  assert.deepEqual({ publishers: result.data.publishers.map(group => [group.relation, group.count]),
    consumers: result.data.consumers.map(group => [group.relation, group.count]),
    zero: [result.data.has_zero_publishers, result.data.has_zero_consumers] }, {
    publishers: [['publishes_envelope', 1]], consumers: [['subscribes_envelope', 1]], zero: [false, false],
  });
  const nonEnvelope = queries(async statement => statement.includes('LIMIT 2') ? [['node:wrong', 'Claim', 'wrong', '{}']] : []);
  await assert.rejects(() => nonEnvelope.consumers({ id: 'node:wrong' }), error => error.code === 'ESTATE_QUERY_NODE_KIND_INVALID');
});

test('consumers returns one node per distinct participant while retaining every edge', async () => {
  const rows = [
    ['edge:1', 'publishes_envelope', 'module:server', 'Module', 'server/index.mjs', '{}', 'module:server', 'envelope:work_order.accepted', '{}'],
    ['edge:2', 'publishes_envelope', 'module:server', 'Module', 'server/index.mjs', '{}', 'module:server', 'envelope:work_order.accepted', '{}'],
  ];
  const graph = queries(async statement => {
    if (statement.includes('LIMIT 2')) return [['envelope:work_order.accepted', 'Envelope', 'work_order.accepted', '{}']];
    if (statement.includes('count(r)')) return [['publishes_envelope', rows.length]];
    return rows;
  });
  const group = (await graph.consumers({ id: 'envelope:work_order.accepted' })).data.publishers[0];
  assert.deepEqual({ nodes: group.nodes.map(node => node.id), distinct: group.distinct_node_count, returned: group.returned_count,
    edges: group.edges.map(edge => edge.id) },
  { nodes: ['module:server'], distinct: 1, returned: 2, edges: ['edge:1', 'edge:2'] });
});

test('benchmark filtering marks consumers counts unavailable from a real query result', async () => {
  const graph = queries(async statement => {
    if (statement.includes('LIMIT 2')) return [['envelope:work_order.accepted', 'Envelope', 'work_order.accepted', '{}']];
    if (statement.includes('count(r)')) return [['publishes_envelope', 2], ['subscribes_envelope', 1]];
    return [
      ['edge:publisher:visible', 'publishes_envelope', 'plugin:visible', 'Plugin', 'visible', '{"source_path":"src/visible.mjs"}',
        'plugin:visible', 'envelope:work_order.accepted', '{}'],
      ['edge:publisher:excluded', 'publishes_envelope', 'plugin:excluded', 'Plugin', 'excluded', '{"source_path":"benchmarks/answer-key.md"}',
        'plugin:excluded', 'envelope:work_order.accepted', '{}'],
      ['edge:consumer:visible', 'subscribes_envelope', 'plugin:consumer', 'Plugin', 'consumer', '{"source_path":"src/consumer.mjs"}',
        'plugin:consumer', 'envelope:work_order.accepted', '{}'],
    ];
  });
  const producerResult = await graph.consumers({ id: 'envelope:work_order.accepted' });
  assert.equal(producerResult.data.publisher_count, 2);
  const filtered = filterBenchmarkRows(producerResult, { material: 'committed', excluded_path_prefixes: ['benchmarks'] });
  assert.equal(filtered.filtered, 1);
  assert.deepEqual(filtered.value.data.publishers[0].nodes.map(node => node.id), ['plugin:visible']);
  assert.deepEqual(filtered.value.data.publishers[0].edges.map(edge => edge.id), ['edge:publisher:visible']);
  assert.deepEqual(filtered.value.data.publishers[0], {
    relation: 'publishes_envelope', count: null, returned_count: 1, distinct_node_count: 1,
    nodes: filtered.value.data.publishers[0].nodes, edges: filtered.value.data.publishers[0].edges,
  });
  assert.equal(filtered.value.data.consumers[0].count, null);
  assert.equal(filtered.value.data.consumers[0].returned_count, 1);
  assert.deepEqual({ publisher_count: filtered.value.data.publisher_count, consumer_count: filtered.value.data.consumer_count,
    has_zero_publishers: filtered.value.data.has_zero_publishers, has_zero_consumers: filtered.value.data.has_zero_consumers,
    counts_available: filtered.value.data.counts_available }, {
    publisher_count: null, consumer_count: null, has_zero_publishers: null, has_zero_consumers: null, counts_available: false,
  });
});

test('search affordances lead Envelope IDs to consumers and CodeFact IDs to read-span', async () => {
  const graph = queries(async () => [
    ['envelope:one', 'Envelope', 'one', '{}'],
    ['fact:one', 'CodeFact', 'one', '{}'],
  ]);
  const result = await graph.search({ term: 'one' });
  assert.deepEqual(result.data.map(node => node.next_queries.map(query => query.command)), [
    ['consumers', 'neighbors'], ['neighbors', 'read-span'],
  ]);
});
