import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { buildUnifiedEstateProjection } from '../tools/estate-graph-projection.mjs';
import { EstateGraphQueries } from '../tools/estate-graph-query.mjs';
import { createFilesystemArm } from '../tools/eval/filesystem-arm.mjs';
import { createBothArm } from '../tools/eval/both-arm.mjs';
import { createGraphArm, GRAPH_COMMANDS, OUTPUT_LIMIT_BYTES } from '../tools/eval/graph-arm.mjs';
import { executePi, runWithPi } from '../tools/eval/pi-model-runner.mjs';
import { tokenUsage } from '../tools/eval/protocol.mjs';
import { evaluationAccessPolicy, evaluationConfig, questionDifficulty, TRACKED_FINAL_ANSWER_SCHEMA } from '../tools/eval/cli.mjs';
import { EventEmitter } from 'node:events';

const root = resolve(new URL('..', import.meta.url).pathname);
const fixture = resolve(root, 'tests/fixtures/eval-repository');
const secretWords = /credential|password|opaque-key|answer_key/iu;

function schemaText(arm) { return JSON.stringify(arm.schema); }

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim();
}

function committedFixtureRepository() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  const repository = mkdtempSync(join(scratch, 'eval-adapter-fixture-'));
  cpSync(fixture, repository, { recursive: true });
  git(repository, ['init', '-q']);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'Add evaluation fixture']);
  return { repository, sourceCommit: git(repository, ['rev-parse', 'HEAD']) };
}

function projectedDocumentRows(sourceCommit) {
  const projection = buildUnifiedEstateProjection({
    claim_map: {
      schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
      project: { id: 'fixture', sha: sourceCommit }, claims: [], evidence: [],
      obligation_results: [], adjudication_receipts: [], supersession_receipts: [], edges: [],
    },
    code_graph: {
      schema: 'estate-map/remap-code-graph/v1', provenance: { source_head: sourceCommit },
      // scripts/remap.mjs emits documentary nodes with this l/ns/r shape.
      nodes: {
        'doc:ordinary': { k: 'entity', l: 'records.yaml', ns: 'document', r: 'document' },
        'doc:benchmark': { k: 'entity', l: 'benchmarks/answer-key.md', ns: 'document', r: 'document' },
      }, identity_bindings: [], relations: [], adj: {}, counts: {},
    },
  });
  return Object.fromEntries(projection.nodes.filter(node => node.kind === 'Document').map(node => [node.node_id, [
    node.node_id, node.label, JSON.stringify(node.properties), node.degree,
  ]]));
}

// Ancestry is the only query that puts its `other` node on its own indented line; the justification
// walk keeps it inline. Matching on that keeps the fixture from answering the wrong question.
const isAncestryQuery = statement => statement.includes('\n          (other:EstateNode');

function fixtureGraphQueries({ repository, sourceCommit, secret }) {
  const documents = projectedDocumentRows(sourceCommit);
  const ordinary = ['fact:ordinary', 'CodeFact', 'ordinary source',
    '{"repository":"fixture","file":"records.yaml","line":2}'];
  const benchmark = ['fact:benchmark', 'CodeFact', secret,
    '{"repository":"fixture","file":"benchmarks/answer-key.md","line":1}'];
  const benchmarkClaim = ['claim:benchmark', 'Claim', secret,
    '{"source_path":"benchmarks/answer-key.md","statement":"FAKE_BENCHMARK_ANSWER_KEY_SECRET","source_quote":"FAKE_BENCHMARK_ANSWER_KEY_SECRET"}'];
  const benchmarkDocumentaryEvidence = ['evidence:benchmark-documentary', 'Evidence', 'benchmarks/answer-key.md',
    '{"evidence_kind":"documentary_source","details_json":"{\\"kind\\":\\"documentary_source\\",\\"source\\":{\\"path\\":\\"benchmarks/answer-key.md\\",\\"quote\\":\\"FAKE_BENCHMARK_ANSWER_KEY_SECRET\\"}}"}'];
  const benchmarkSourceTextEvidence = ['evidence:benchmark-source-text', 'Evidence', 'benchmarks/answer-key.md:1',
    '{"evidence_kind":"source_text","source_path":"benchmarks/answer-key.md","details_json":"{\\"kind\\":\\"source_text\\",\\"path\\":\\"benchmarks/answer-key.md\\",\\"quote\\":\\"FAKE_BENCHMARK_ANSWER_KEY_SECRET\\"}"}'];
  const client = new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
  client.query = async (statement, parameters) => {
    if (statement.includes('EstateProjectionHead')) return [[
      'estate-projection:fixture', 'selected', sourceCommit, 'content:fixture', 'claim-map:fixture', 'code-graph:fixture', 3, 3, 2, 2,
      'unified-serving-projection@2',
    ]];
    if (statement.includes('n.search_text')) return [ordinary, benchmark, benchmarkClaim, benchmarkDocumentaryEvidence, benchmarkSourceTextEvidence];
    if (statement.includes("MATCH (d:EstateNode {projection_id: $projection_id, kind: 'Document'})")) {
      return [documents['doc:ordinary'], documents['doc:benchmark']];
    }
    if (statement.includes("relation: 'documented_in'")) return [
      ['entity:ordinary', 'ordinary source', '{"namespace":"records.yaml"}', 1],
      ['entity:benchmark', secret, '{"namespace":"benchmarks/answer-key.md"}', 1],
    ];
    if (statement.includes('RETURN e.node_id')) return [];
    if (statement.includes('bundle_count')) return [['annotation', 'related_to', 'out', 'CodeFact', 2]];
    if (statement.includes('RETURN n.node_id, n.kind, n.label, n.properties_json')) {
      if (parameters.node_id === 'fact:benchmark') return [benchmark];
      if (parameters.node_id === 'claim:benchmark') return [benchmarkClaim];
      if (parameters.node_id === 'evidence:benchmark-documentary') return [benchmarkDocumentaryEvidence];
      if (parameters.node_id === 'evidence:benchmark-source-text') return [benchmarkSourceTextEvidence];
      return [ordinary];
    }
    if (statement.includes('shortestPath')) return [[
      [ordinary, benchmarkClaim],
      [['edge:path', 'about', 'fact:ordinary', 'claim:benchmark', '{}']],
    ]];
    if (statement.includes('RETURN n.node_id')) return [['claim:ordinary']];
    // Ancestry walks toward containers only; here the claim's container is the excluded document,
    // and the commit above it is reachable only THROUGH that excluded document.
    if (isAncestryQuery(statement)) {
      if (!statement.includes('<-[r:ESTATE_EDGE')) return [];
      if (parameters.node_id === 'claim:ordinary') {
        return [['edge:ancestry', 'contains', 'doc:benchmark', 'claim:ordinary', 'doc:benchmark',
          'Document', documents['doc:benchmark'][1], documents['doc:benchmark'][2]]];
      }
      if (parameters.node_id === 'doc:benchmark') {
        return [['edge:ancestry-commit', 'contains', 'commit:fixture', 'doc:benchmark',
          'commit:fixture', 'SourceCommit', 'fixture', '{}']];
      }
      return [];
    }
    if (statement.includes('r.relation IN $relations')) return [
      ['edge:provenance', 'about', 'claim:ordinary', 'doc:benchmark', 'doc:benchmark', 'Document',
        documents['doc:benchmark'][1], documents['doc:benchmark'][2]],
    ];
    if (statement.includes('RETURN r.edge_id')) return [
      ['edge:benchmark', 'related_to', 'fact:ordinary', 'fact:benchmark', ...benchmark, '{}'],
      ['edge:ordinary', 'related_to', 'fact:ordinary', 'fact:neighbor', 'fact:neighbor', 'CodeFact', 'ordinary neighbor',
        '{"repository":"fixture","file":"records.yaml","line":3}', '{}'],
    ];
    throw new Error(`unexpected fixture graph query: ${statement}`);
  };
  return new EstateGraphQueries({ client, source_repositories: { fixture: repository } });
}

function executeFixtureGraph(queries) {
  const option = (args, name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  return async (_command, argv) => {
    const command = argv[5]; const args = argv.slice(6);
    let result;
    if (command === 'search') result = await queries.search({ view: 'selected', term: option(args, '--term'),
      limit: option(args, '--limit'), kinds: option(args, '--kinds')?.split(',') ?? [] });
    else if (command === 'node') result = await queries.node({ view: 'selected', id: option(args, '--id'), limit: option(args, '--limit'),
      expand: option(args, '--expand') });
    else if (command === 'concepts') result = await queries.concepts({ view: 'selected', limit: option(args, '--limit') });
    else if (command === 'path') result = await queries.path({ view: 'selected', from: option(args, '--from'), to: option(args, '--to'),
      depth: option(args, '--depth') });
    else if (command === 'provenance') result = await queries.provenance({ view: 'selected', id: option(args, '--id'),
      depth: option(args, '--depth'), limit: option(args, '--limit') });
    else if (command === 'read-span') result = await queries.readSpan({ view: 'selected', id: option(args, '--id'),
      before: option(args, '--before'), after: option(args, '--after') });
    else throw new Error(`unsupported fixture graph command: ${command}`);
    return { stdout: JSON.stringify(result) };
  };
}

test('filesystem arm is checkout-bounded and cannot invoke graph stubs', async () => {
  let graphCalls = 0;
  const graph = { async query() { graphCalls += 1; throw new Error('filesystem arm reached graph'); } };
  const arm = createFilesystemArm({ checkout: fixture, graph,
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } });
  assert.deepEqual(Object.keys(arm.tools).sort(), ['find', 'grep', 'read']);
  assert.equal(secretWords.test(schemaText(arm)), false);
  assert.deepEqual((await arm.tools.find({ glob: '**/*' })).paths, ['README.md', 'records.yaml']);
  assert.deepEqual((await arm.tools.grep({ pattern: 'north' })).matches.map(match => match.line), [2]);
  assert.deepEqual((await arm.tools.grep({ pattern: 'fixture', glob: '*.yaml' })).matches, []);
  assert.deepEqual((await arm.tools.grep({ pattern: 'fixture', glob: '*.md' })).matches.map(match => match.path), ['README.md']);
  assert.deepEqual((await arm.tools.grep({ pattern: 'FAKE_BENCHMARK_ANSWER_KEY_SECRET' })).matches, []);
  assert.equal((await arm.tools.read({ path: 'records.yaml', start_line: 2, end_line: 2 })).text, '  - name: north');
  await assert.rejects(() => arm.tools.read({ path: 'benchmarks/answer-key.md' }), error => error.code === 'EVAL_BENCHMARK_PATH_EXCLUDED');
  await assert.rejects(() => arm.tools.read({ path: 'benchmarks/other/../answer-key.md' }), error => error.code === 'EVAL_BENCHMARK_PATH_EXCLUDED');
  await assert.rejects(() => arm.tools.read({ path: '../records.yaml' }), /escapes checkout/);
  assert.equal(graphCalls, 0);
});

test('graph arm exposes bounded traversal commands and no filesystem surface', async () => {
  const calls = [];
  const arm = createGraphArm({
    runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
    execute: async (command, args) => { calls.push({ command, args }); return { stdout: JSON.stringify({ schema: 'estate-map/query-result/v1', query: args[5] }) }; },
  });
  assert.deepEqual(Object.keys(arm.tools), ['estate_query']);
  assert.deepEqual(GRAPH_COMMANDS, [
    'projection-status', 'stats', 'concepts', 'overview', 'search', 'node', 'neighbors', 'consumers', 'path', 'provenance', 'read-span',
  ]);
  assert.deepEqual(arm.schema.tools[0].input.command.enum, GRAPH_COMMANDS);
  assert.deepEqual(arm.schema.tools[0].input.arguments.by_command.search, { term: 'string', limit: 'integer? (1..200)', kinds: 'string[]?' });
  assert.equal(arm.schema.tools[0].input.arguments.by_command['read-span'].id, 'node ID from search or node');
  assert.equal(secretWords.test(schemaText(arm)), false);
  await arm.tools.estate_query({ command: 'search', arguments: { term: 'provider', kinds: ['Capability'], limit: 2 } });
  await arm.tools.estate_query({ command: 'neighbors', id: 'node:one', direction: 'in', relation: 'consumes', limit: 2 });
  await arm.tools.estate_query({ command: 'consumers', arguments: { id: 'envelope:one', limit: 2 } });
  await arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:one', before: 2, after: 4 } });
  await arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:zero', before: 0, after: 0 } });
  await arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:clamped', before: 1_000, after: 1_000 } });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0].args.slice(0, 6), ['/controller-only/query.mjs', '--runtime-config', '/controller-only/runtime.json', '--view', 'selected', 'search']);
  assert.deepEqual(calls[1].args.slice(5), ['neighbors', '--id', 'node:one', '--relation', 'consumes', '--direction', 'in', '--limit', '2']);
  assert.deepEqual(calls[2].args.slice(5), ['consumers', '--id', 'envelope:one', '--limit', '2']);
  assert.deepEqual(calls[3].args.slice(5), ['read-span', '--id', 'fact:one', '--before', '2', '--after', '4']);
  assert.deepEqual(calls[4].args.slice(5), ['read-span', '--id', 'fact:zero', '--before', '0', '--after', '0']);
  assert.deepEqual(calls[5].args.slice(5), ['read-span', '--id', 'fact:clamped', '--before', '1000', '--after', '1000']);
  await assert.rejects(() => arm.tools.estate_query({ command: 'read-span', arguments: { path: 'source.mjs' } }), /node id required/);
  await assert.rejects(() => arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:bad', before: -1 } }), /non-negative safe integer/);
  await assert.rejects(() => arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:bad', after: Number.MAX_SAFE_INTEGER + 1 } }), /non-negative safe integer/);
  await assert.rejects(() => arm.tools.estate_query({ command: 'cypher', arguments: { statement: 'MATCH (n)' } }), /unsupported graph command/);
  assert.equal(calls.length, 6);
  const source = readFileSync(resolve(root, 'tools/eval/graph-arm.mjs'), 'utf8');
  assert.equal(source.includes('node:fs'), false);
});

test('a Pi provider error or empty assistant message is transient, not a deterministic model failure', async () => {
  const request = { model: { runner: 'pi', name: 'provider/model' }, context: { tool_schema: { allowed_tool_names: ['find'] } },
    prompt: { system: 'neutral', user: { question: 'q' } }, events: [] };
  const providerError = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Codex unavailable after 1 retry round(s) over 600s: no account available"}}\n';
  const empty = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"  "}],"stopReason":"stop"}}\n';
  const malformed = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"not json"}],"stopReason":"stop"}}\n';
  const codes = [];
  for (const stdout of [providerError, empty, malformed]) {
    try { await runWithPi(request, { execute: async () => ({ stdout }) }); codes.push('ok'); }
    catch (error) { codes.push(error.code ?? 'deterministic'); }
  }
  assert.deepEqual(codes, ['EVAL_MODEL_TRANSIENT', 'EVAL_MODEL_TRANSIENT', 'deterministic']);
});

test('both arm is the exact bounded filesystem and graph schema union', () => {
  const filesystem = createFilesystemArm({ checkout: fixture,
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } });
  const graph = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
    execute: async () => ({ stdout: '{}' }) });
  const both = createBothArm({ filesystem, graph });
  assert.deepEqual(both.schema.allowed_tool_names, ['find', 'grep', 'read', 'estate_query']);
  assert.deepEqual(Object.keys(both.tools).sort(), ['estate_query', 'find', 'grep', 'read']);
  assert.deepEqual(both.schema.tools, [...filesystem.schema.tools, ...graph.schema.tools]);
  assert.equal(/shell|network|answer.?key/iu.test(JSON.stringify(both.schema)), false);
});

test('Pi model runner receives the configured runtime role without reading evaluation material', async () => {
  let received;
  const response = await runWithPi({
    model: { runner: 'pi', name: 'provider/model', thinking: 'high', max_event_bytes: 12345 },
    context: { tool_schema: { allowed_tool_names: ['find'] } }, prompt: { system: 'neutral', user: { question: 'q' } }, events: [],
  }, { execute: async request => { received = request; return { stdout: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"tool_call\\":{\\"name\\":\\"find\\",\\"arguments\\":{\\"glob\\":\\"**/*\\"}}}"}],"usage":{"input":10050,"output":230,"cacheRead":4608,"cacheWrite":0,"reasoning":140,"totalTokens":14888,"cost":{"total":0.029727}}}}\n' }; } });
  assert.equal(received.args.includes('provider/model'), true);
  assert.equal(received.args.includes('json'), true);
  assert.equal(received.max_stdout_bytes, 12345);
  assert.deepEqual(response.emission, { tool_call: { name: 'find', arguments: { glob: '**/*' } } });
  assert.deepEqual(tokenUsage(response.usage), { provider_input_tokens: 10050, provider_output_tokens: 230,
    tokens_consumed: 14888, reported_cost_usd: 0.029727 });
  assert.equal(tokenUsage({ input: 3, output: 2 }).reported_cost_usd, null);
  const source = readFileSync(resolve(root, 'tools/eval/pi-model-runner.mjs'), 'utf8');
  assert.equal(source.includes('node:fs'), false);
  assert.equal(source.includes('.evals'), false);
});

test('both eval arms deny a committed answer key through the real graph producer', async () => {
  const secret = 'FAKE_BENCHMARK_ANSWER_KEY_SECRET';
  const held = committedFixtureRepository();
  try {
    const policy = { material: 'committed', excluded_path_prefixes: ['benchmarks'] };
    const filesystem = createFilesystemArm({ checkout: held.repository, benchmark_policy: policy });
    assert.equal(JSON.stringify(await filesystem.tools.find({ glob: '**/*' })).includes('answer-key.md'), false);
    assert.deepEqual((await filesystem.tools.grep({ pattern: secret })).matches, []);
    assert.equal((await filesystem.tools.read({ path: 'records.yaml', start_line: 2, end_line: 2 })).text, '  - name: north');
    await assert.rejects(() => filesystem.tools.read({ path: 'benchmarks/answer-key.md' }),
      error => error.code === 'EVAL_BENCHMARK_PATH_EXCLUDED');

    const graph = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
      benchmark_policy: policy, execute: executeFixtureGraph(fixtureGraphQueries({ ...held, secret })) });
    const search = await graph.tools.estate_query({ command: 'search', arguments: { term: 'source' } });
    assert.deepEqual(search.data.map(row => row.id), ['fact:ordinary']);
    assert.equal(JSON.stringify(search).includes(secret), false);
    assert.deepEqual(search.benchmark_filter, { filtered_count: 4, excluded_path_prefixes: ['benchmarks'] });
    const node = await graph.tools.estate_query({ command: 'node', arguments: { id: 'fact:ordinary' } });
    assert.deepEqual(node.data.neighbors.map(row => row.node.id), ['fact:neighbor']);
    assert.equal(JSON.stringify(node).includes(secret), false);
    // A filtered row leaves the bundle aggregate unreconcilable, so its count is withheld.
    assert.deepEqual([node.data.bundles[0].count, node.data.bundle_counts_available], [null, false]);
    const claim = await graph.tools.estate_query({ command: 'node', arguments: { id: 'claim:benchmark' } });
    assert.equal(JSON.stringify(claim).includes(secret), false);
    assert.deepEqual(claim.benchmark_filter, { filtered_count: 2, excluded_path_prefixes: ['benchmarks'] });
    for (const id of ['evidence:benchmark-documentary', 'evidence:benchmark-source-text']) {
      const evidence = await graph.tools.estate_query({ command: 'node', arguments: { id } });
      assert.equal(JSON.stringify(evidence).includes(secret), false);
      assert.equal(evidence.benchmark_filter.filtered_count > 0, true);
    }
    const concepts = await graph.tools.estate_query({ command: 'concepts' });
    assert.deepEqual(concepts.data.documents_by_claims.map(row => row.id), ['doc:ordinary']);
    assert.deepEqual(concepts.data.entities_by_surface_mention.map(row => row.id), ['entity:ordinary']);
    assert.equal(JSON.stringify(concepts).includes(secret), false);
    assert.deepEqual(concepts.benchmark_filter, { filtered_count: 2, excluded_path_prefixes: ['benchmarks'] });
    const path = await graph.tools.estate_query({ command: 'path', arguments: { from: 'fact:ordinary', to: 'claim:benchmark' } });
    assert.deepEqual(path.data.nodes.map(row => row.id), ['fact:ordinary']);
    assert.equal(JSON.stringify(path).includes(secret), false);
    assert.deepEqual(path.benchmark_filter, { filtered_count: 1, excluded_path_prefixes: ['benchmarks'] });
    const provenance = await graph.tools.estate_query({ command: 'provenance', arguments: { id: 'claim:ordinary' } });
    assert.deepEqual(provenance.data, []);
    assert.equal(JSON.stringify(provenance).includes(secret), false);
    // The containment chain is filtered like any other row. The step whose container is withheld is
    // dropped whole, and so is the step BELOW it, whose `from` still named the withheld document —
    // a surviving step would have cited the excluded path in a bare string.
    assert.deepEqual(provenance.ancestry, []);
    assert.deepEqual(provenance.benchmark_filter, { filtered_count: 2, excluded_path_prefixes: ['benchmarks'] });
    assert.equal((await graph.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:ordinary', before: 0, after: 0 } })).data.text,
      '  - name: north\n');
    const refusedSpan = await graph.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:benchmark' } });
    assert.deepEqual(refusedSpan, { error: 'EVAL_BENCHMARK_PATH_EXCLUDED', benchmark_filter: {
      filtered_count: 1, excluded_path_prefixes: ['benchmarks'],
    } });
  } finally {
    rmSync(held.repository, { recursive: true, force: true });
  }
});

test('index-only graph results remove read-span affordances from real projected CodeFact rows', async () => {
  const secret = 'FAKE_BENCHMARK_ANSWER_KEY_SECRET';
  const held = committedFixtureRepository();
  try {
    const arm = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
      graph_mode: 'index-only', benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] },
      execute: executeFixtureGraph(fixtureGraphQueries({ ...held, secret })) });
    const result = await arm.tools.estate_query({ command: 'search', arguments: { term: 'source' } });
    assert.deepEqual(result.data.map(row => row.id), ['fact:ordinary']);
    assert.deepEqual(result.data[0].next_queries, [{ command: 'neighbors', arguments: { id: 'fact:ordinary', direction: 'both' } }]);
    assert.equal(JSON.stringify(result).includes('read-span'), false);
  } finally {
    rmSync(held.repository, { recursive: true, force: true });
  }
});

test('graph transport exceeds semantic cap and index-only hides read-span', async () => {
  let maxBuffer = 0;
  const arm = createGraphArm({
    runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
    execute: async (_command, _args, options) => {
      maxBuffer = options.maxBuffer;
      if (options.maxBuffer <= OUTPUT_LIMIT_BYTES + 1) throw new Error('stdout maxBuffer length exceeded');
      return { stdout: JSON.stringify({ data: { text: 'x'.repeat(OUTPUT_LIMIT_BYTES) } }) };
    },
  });
  const result = await arm.tools.estate_query({ command: 'overview' });
  assert.equal(maxBuffer > OUTPUT_LIMIT_BYTES, true);
  assert.equal(result.error, 'EVAL_TOOL_OUTPUT_LIMIT');
  const index = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs', graph_mode: 'index-only',
    execute: async () => ({ stdout: '{}' }) });
  assert.equal(index.schema.tools[0].input.command.enum.includes('read-span'), false);
  assert.equal(index.schema.tools[0].input.arguments.by_command['read-span'], undefined);
  await assert.rejects(() => index.tools.estate_query({ command: 'read-span', arguments: { id: 'good' } }), /unsupported graph command/);
  assert.deepEqual(index.schema.tools[0].input.command.enum, GRAPH_COMMANDS.filter(command => command !== 'read-span'));
});

test('declared question difficulty is structural, validated, and never an outcome', () => {
  assert.deepEqual(questionDifficulty({ difficulty: { hops: 2, fan_out: 15, witness_files: 3, token_disjoint: true } }),
    { hops: 2, fan_out: 15, witness_files: 3, token_disjoint: true });
  assert.equal(questionDifficulty({}), null);
  // A field naming an arm's behaviour is not a structural property of the question.
  assert.throws(() => questionDifficulty({ difficulty: { filesystem_failed: true } }), /unknown difficulty field/u);
  assert.throws(() => questionDifficulty({ difficulty: { hops: -1 } }), /non-negative integer/u);
  assert.throws(() => questionDifficulty({ difficulty: { token_disjoint: 'yes' } }), /must be a boolean/u);
});

test('evaluation config requires disclosed graph mode and benchmark policy', () => {
  assert.throws(() => evaluationAccessPolicy({ graph_mode: 'as-deployed' }), /benchmark_policy/u);
  assert.throws(() => evaluationAccessPolicy({ graph_mode: 'as-deployed', benchmark_policy: { material: 'committed', excluded_path_prefixes: [] } }), /requires excluded/u);
  const access = evaluationAccessPolicy({ graph_mode: 'index-only', benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } });
  assert.deepEqual(access, { graph_mode: 'index-only', graph_surface: 'commands',
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } });
  assert.equal(evaluationAccessPolicy({ graph_mode: 'as-deployed', graph_surface: 'cypher',
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } }).graph_surface, 'cypher');
  assert.throws(() => evaluationAccessPolicy({ graph_mode: 'as-deployed', graph_surface: 'sql',
    benchmark_policy: { material: 'committed', excluded_path_prefixes: ['benchmarks'] } }), /graph_surface/u);
  const effective = evaluationConfig({ protocol: {}, seed: 1 }, 'a'.repeat(40), {}, [{ stratum: 'one' }, { stratum: 'two' }]);
  assert.deepEqual(effective.strata, ['one', 'two']);
  assert.deepEqual(effective.protocol.final_answer_schema, TRACKED_FINAL_ANSWER_SCHEMA);
  const example = JSON.parse(readFileSync(resolve(root, 'examples/evaluation.config.example.json'), 'utf8'));
  assert.deepEqual(evaluationConfig(example, 'a'.repeat(40), {}, []).protocol.final_answer_schema, TRACKED_FINAL_ANSWER_SCHEMA);
  assert.throws(() => evaluationConfig({ protocol: { final_answer_schema: { type: 'object' } }, seed: 1 }, 'a'.repeat(40), {}, []),
    /must exactly match/u);
});

test('Pi harness reports its deliberate stdout overflow', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {};
  child.stdin = { end() { process.nextTick(() => child.stdout.emit('data', 'tool-output')); } };
  child.kill = () => process.nextTick(() => child.emit('close', 143));
  await assert.rejects(() => executePi({ args: [], input: '', max_stdout_bytes: 4, spawn_process: () => child }),
    /Pi output exceeded 4 bytes and was terminated by the harness/u);
});
