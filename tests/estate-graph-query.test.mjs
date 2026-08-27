import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { EstateGraphQueries } from '../tools/estate-graph-query.mjs';

function clientWith(handler) {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  client.query = handler;
  return client;
}

const projectionRow = [
  'estate-projection:one', 'selected', '1'.repeat(40), 'content:one',
  'claim-map:one', 'code-graph:one', 10, 10, 20, 20, 'unified-serving-projection@2',
];

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim();
}

function spanFixture() {
  // Prefer the platform scratch dir when a worker provides one, but never require it: a test that
  // fails purely because an environment variable is unset is not hermetic, and it makes the
  // repository's own battery unrunnable outside a dispatched worker.
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'estate-query-span-'));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '-q']);
  const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}\n`).join('');
  writeFileSync(join(repository, 'source.mjs'), content);
  git(repository, ['add', 'source.mjs']);
  git(repository, ['commit', '-qm', 'Add span fixture']);
  const sourceCommit = git(repository, ['rev-parse', 'HEAD']);
  writeFileSync(join(repository, 'source.mjs'), 'dirty working tree bytes\n');
  return { root, repository, sourceCommit };
}

function spanQueries({ sourceCommit, repository, handler }) {
  const client = clientWith(async (statement, parameters) => {
    if (statement.includes('EstateProjectionHead')) return [[
      'estate-projection:span', 'selected', sourceCommit, 'content:span', 'claim-map:span', 'code-graph:span', 1, 1, 1, 1,
    ]];
    return handler(statement, parameters);
  });
  return new EstateGraphQueries({ client, source_repositories: { fixture: repository } });
}

function applySearchOrder(statement, parameters, rows) {
  const order = statement.match(/ORDER BY\s+([\s\S]*?)\s+LIMIT \$limit/u)?.[1] || '';
  const exactMatchesFirst = order.includes('CASE WHEN toLower(n.label) = $term THEN 0 ELSE 1 END');
  const kindCase = order.match(/CASE n\.kind\s+([\s\S]*?)\s+ELSE\s+(\d+)\s+END/u);
  const kindRanks = new Map([...(kindCase?.[1].matchAll(/WHEN '([^']+)' THEN (\d+)/gu) || [])]
    .map(match => [match[1], Number(match[2])]));
  const fallbackKindRank = Number(kindCase?.[2] || 0);
  const deterministicTies = /END,\s*n\.label,\s*n\.node_id\s*$/u.test(order);
  const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    if (exactMatchesFirst) {
      const exact = Number(left.row[2].toLowerCase() !== parameters.term)
        - Number(right.row[2].toLowerCase() !== parameters.term);
      if (exact) return exact;
    }
    const kind = (kindRanks.get(left.row[1]) ?? fallbackKindRank)
      - (kindRanks.get(right.row[1]) ?? fallbackKindRank);
    if (kind) return kind;
    if (deterministicTies) {
      const label = lexical(left.row[2], right.row[2]);
      if (label) return label;
      const nodeId = lexical(left.row[0], right.row[0]);
      if (nodeId) return nodeId;
    }
    return left.index - right.index;
  }).slice(0, parameters.limit).map(entry => entry.row);
}

test('search returns bounded typed nodes with projection provenance', async () => {
  const seen = [];
  const client = clientWith(async (statement, parameters) => {
    seen.push({ statement, parameters });
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    return [['estate-claim:one', 'Claim', 'Exact provenance', '{"verdict":"supported"}']];
  });
  const queries = new EstateGraphQueries({ client });
  const result = await queries.search({ term: 'provenance', limit: 10 });
  assert.deepEqual({
    projection: result.projection.projection_id,
    query: result.query,
    node: result.data[0],
    parameterized: seen[1].parameters.term,
  }, {
    projection: 'estate-projection:one', query: 'search',
    node: { id: 'estate-claim:one', kind: 'Claim', label: 'Exact provenance',
      properties: { verdict: 'supported' },
      next_queries: [{ command: 'neighbors', arguments: { id: 'estate-claim:one', direction: 'both' } }] },
    parameterized: 'provenance',
  });
});

test('node query returns structural neighbours as rows and annotation as complete bundles', async () => {
  const issued = [];
  const client = clientWith(async (statement, parameters) => {
    issued.push({ statement, parameters });
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    if (statement.includes('bundle_count')) return [
      ['annotation', 'documented_in', 'in', 'Document', 74],
      ['structural', 'provides_capability', 'out', 'Capability', 13],
    ];
    if (statement.includes('ESTATE_EDGE')) return [['edge:one', 'provides_capability', 'plugin:one', 'capability:one',
      'capability:one', 'Capability', 'brew', '{}', '{}', 'structural', 'entity', 0, 0, 'to']];
    return [['plugin:one', 'Plugin', 'task-orchestration', '{}', 'entity', 13, 90]];
  });
  const queries = new EstateGraphQueries({ client, neighbor_limit: 20 });
  const result = await queries.node({ id: 'plugin:one' });
  const edgeQuery = issued.find(row => row.statement.includes('ESTATE_EDGE') && !row.statement.includes('bundle_count'));
  assert.deepEqual({
    node: [result.data.node.plane, result.data.node.structural_children, result.data.node.structural_descendants],
    neighbor: result.data.neighbors[0],
    bundles: result.data.bundles.map(bundle => [bundle.role, bundle.relation, bundle.direction, bundle.kind, bundle.count]),
    bundleQuery: result.data.bundles[0].next_queries,
    roles: edgeQuery.parameters.roles,
    expand: result.expand,
  }, {
    node: ['entity', 13, 90],
    neighbor: {
      // parent_end travels with the edge: a client that must infer which end owns the other cannot
      // draw containment as containment.
      edge: { id: 'edge:one', relation: 'provides_capability', from: 'plugin:one', to: 'capability:one',
        properties: {}, role: 'structural', parent_end: 'to' },
      node: { id: 'capability:one', kind: 'Capability', label: 'brew', properties: {}, plane: 'entity',
        structural_children: 0, structural_descendants: 0,
        next_queries: [{ command: 'neighbors', arguments: { id: 'capability:one', direction: 'both' } }] },
    },
    bundles: [['annotation', 'documented_in', 'in', 'Document', 74], ['structural', 'provides_capability', 'out', 'Capability', 13]],
    bundleQuery: [{ command: 'neighbors', arguments: { id: 'plugin:one', relation: 'documented_in', direction: 'in' } }],
    roles: ['structural', 'flow'],
    expand: 'structural',
  });
  const atoms = await queries.node({ id: 'plugin:one', expand: 'all' });
  assert.deepEqual(atoms.neighbor_roles, ['structural', 'flow', 'annotation', 'unclassified']);
});

test('role-driven views refuse a projection generation that carries no relation roles', async () => {
  const legacy = [...projectionRow.slice(0, 10), 'unified-serving-projection@1'];
  const client = clientWith(async statement => statement.includes('EstateProjectionHead') ? [legacy] : []);
  const queries = new EstateGraphQueries({ client });
  await assert.rejects(() => queries.node({ id: 'plugin:one' }), error => error.code === 'ESTATE_QUERY_ROLES_UNAVAILABLE');
  await assert.rejects(() => queries.overview({}), error => error.code === 'ESTATE_QUERY_ROLES_UNAVAILABLE');
  assert.equal((await queries.stats({})).query, 'stats');
});

test('overview returns a connected estate topology anchored at the project, not a degree ranking', async () => {
  const neighbors = {
    'project:estate': [['source-commit:one', 'SourceCommit', 'commit', '{}', 'entity', 2, 3]],
    'source-commit:one': [
      ['doc:design.md', 'Document', 'design.md', '{}', 'documentary', 1, 1],
      ['doc:index.md', 'Document', 'index.md', '{}', 'documentary', 0, 0],
    ],
  };
  const client = clientWith(async (statement, parameters) => {
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    if (statement.includes('WHEN \'Project\' THEN 0')) {
      return [['project:estate', 'Project', 'estate', '{}', 'entity', 1, 4]];
    }
    if (statement.includes('RETURN other.node_id')) return neighbors[parameters.node_id] || [];
    if (statement.includes('RETURN r.edge_id')) {
      return [['edge:one', 'has_source_commit', 'project:estate', 'source-commit:one', '{}', 'structural']];
    }
    return [];
  });
  const result = await new EstateGraphQueries({ client }).overview({ limit: 8 });
  assert.deepEqual({
    anchor: result.data.nodes[0].kind,
    kinds: result.data.nodes.map(node => node.kind),
    descent: result.data.nodes.map(node => node.structural_descendants),
    edges: result.data.edges.map(edge => edge.role),
    selection: result.traversal.selection,
  }, {
    anchor: 'Project',
    kinds: ['Project', 'SourceCommit', 'Document', 'Document'],
    descent: [4, 3, 1, 0],
    edges: ['structural'],
    selection: 'structural descent from the estate anchor',
  });
});

test('provenance walks bounded justification steps and discloses excluded ambient relations', async () => {
  const issued = [];
  const client = clientWith(async (statement, parameters) => {
    issued.push({ statement, parameters });
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    if (statement.includes('RETURN n.node_id') && !statement.includes('ESTATE_EDGE')) {
      return [['estate-claim:one']];
    }
    if (parameters.node_id === 'estate-claim:one') {
      return [['edge:one', 'derived_from', 'estate-claim:one', 'claim-evidence:one',
        'claim-evidence:one', 'Evidence', 'documentary source', '{}']];
    }
    return [];
  });
  const result = await new EstateGraphQueries({ client }).provenance({ id: 'estate-claim:one' });
  const neighborQuery = issued.find(row => row.statement.includes('ESTATE_EDGE'));
  assert.deepEqual({
    target: result.data[0].target.id,
    path: result.data[0].path_node_ids,
    variableLength: issued.some(row => /ESTATE_EDGE\*/u.test(row.statement)),
    relationFiltered: neighborQuery.parameters.relations.includes('derived_from')
      && !neighborQuery.parameters.relations.includes('documented_in'),
    excluded: result.traversal.excluded_relations,
  }, {
    target: 'claim-evidence:one',
    path: ['estate-claim:one', 'claim-evidence:one'],
    variableLength: false,
    relationFiltered: true,
    excluded: ['contains', 'documented_in'],
  });
});

test('path depth and result bounds fail before any Neo4j query', async () => {
  const queries = new EstateGraphQueries({ client: clientWith(async () => { throw new Error('unreachable'); }) });
  await assert.rejects(() => queries.path({ from: 'a', to: 'b', depth: 99 }),
    error => error.code === 'ESTATE_QUERY_BOUND_INVALID');
});

test('read-span returns committed CodeFact source lines rather than dirty working-tree bytes', async () => {
  const held = spanFixture();
  try {
    const queries = spanQueries({ ...held, handler: async statement => {
      if (statement.includes('RETURN n.node_id')) {
        return [['fact:one', 'CodeFact', 'line 3', '{"repository":"fixture","file":"source.mjs","line":3}']];
      }
      throw new Error(`unexpected query: ${statement}`);
    } });
    const result = await queries.readSpan({ id: 'fact:one', before: 1, after: 2 });
    assert.deepEqual({
      text: result.data.text, bytes: Buffer.from(result.data.bytes_base64, 'base64').toString('utf8'),
      file: result.data.file, line: result.data.line, sourceCommit: result.data.source_commit, range: result.data.returned_range,
      blob: result.data.blob.oid.length,
    }, {
      text: 'line 2\nline 3\nline 4\nline 5\n', bytes: 'line 2\nline 3\nline 4\nline 5\n',
      file: 'source.mjs', line: 3, sourceCommit: held.sourceCommit,
      range: { start_line: 2, end_line: 5, lines: 4, bytes: 28 }, blob: 40,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('read-span follows identifies from a non-CodeFact node', async () => {
  const held = spanFixture();
  try {
    const queries = spanQueries({ ...held, handler: async statement => {
      if (statement.includes('RETURN n.node_id')) {
        return [['symbol:one', 'Symbol', 'fixture symbol', '{}']];
      }
      if (statement.includes("relation: 'identifies'")) {
        return [['fact:two', 'CodeFact', 'line 7', '{"repository":"fixture","file":"source.mjs","line":7}']];
      }
      throw new Error(`unexpected query: ${statement}`);
    } });
    const result = await queries.readSpan({ id: 'symbol:one', before: 0, after: 0 });
    assert.deepEqual({ codeFact: result.data.code_fact_id, text: result.data.text },
      { codeFact: 'fact:two', text: 'line 7\n' });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('read-span refuses an unresolvable node rather than guessing a location', async () => {
  const queries = spanQueries({ sourceCommit: '1'.repeat(40), repository: '/not-used', handler: async statement => {
    if (statement.includes('RETURN n.node_id')) return [['symbol:unresolved', 'Symbol', 'unknown', '{}']];
    if (statement.includes("relation: 'identifies'")) return [];
    throw new Error(`unexpected query: ${statement}`);
  } });
  await assert.rejects(() => queries.readSpan({ id: 'symbol:unresolved' }),
    error => error.code === 'ESTATE_QUERY_SPAN_UNRESOLVED'
      && error.detail.missing === 'CodeFact reachable by identifies');
});

test('read-span clamps ceiling-exceeding context and discloses truncation', async () => {
  const held = spanFixture();
  try {
    const queries = spanQueries({ ...held, handler: async statement => {
      if (statement.includes('RETURN n.node_id')) {
        return [['fact:large', 'CodeFact', 'line 220', '{"repository":"fixture","file":"source.mjs","line":220}']];
      }
      throw new Error(`unexpected query: ${statement}`);
    } });
    const result = await queries.readSpan({ id: 'fact:large', before: 1_000, after: 1_000 });
    assert.deepEqual({ truncated: result.data.truncated, withinLineCeiling: result.data.returned_range.lines <= 400,
      requested: result.data.requested_range }, {
      truncated: true, withinLineCeiling: true,
      requested: { start_line: 1, end_line: 1220, before: 1000, after: 1000 },
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('search applies exact-match, complete kind precedence, and deterministic tie ranking', async () => {
  const candidates = [
    ['claim:exact', 'Claim', 'REQUIRED', '{}'],
    ['aaa:unknown', 'Other', 'required', '{}'],
    ['obligation:exact', 'ObligationResult', 'required', '{}'],
    ['receipt:exact', 'AdjudicationReceipt', 'required', '{}'],
    ['evidence:exact', 'Evidence', 'required', '{}'],
    ['table:exact', 'Table', 'required', '{}'],
    ['route:exact', 'Route', 'required', '{}'],
    ['module:exact', 'Module', 'required', '{}'],
    ['symbol:exact', 'Symbol', 'required', '{}'],
    ['fact:exact', 'CodeFact', 'required', '{}'],
    ['fact:z', 'CodeFact', 'required zeta', '{}'],
    ['fact:b', 'CodeFact', 'required alpha', '{}'],
    ['fact:a', 'CodeFact', 'required alpha', '{}'],
  ];
  const client = clientWith(async (statement, parameters) => {
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    return applySearchOrder(statement, parameters, candidates);
  });
  const result = await new EstateGraphQueries({ client }).search({ term: 'required' });
  assert.deepEqual(result.data.map(node => node.id), [
    'fact:exact',
    'symbol:exact',
    'module:exact',
    'route:exact',
    'table:exact',
    'claim:exact',
    'evidence:exact',
    'receipt:exact',
    'obligation:exact',
    'aaa:unknown',
    'fact:a',
    'fact:b',
    'fact:z',
  ]);
});

test('one dominant kind cannot spend the whole neighbour budget', async () => {
  // A document with 233 claims and one section spent all 120 rows on claims. The section survived
  // only because it outranked them on descendants; a document whose claims sorted higher would
  // have rendered with no structure at all while looking complete.
  const claims = Array.from({ length: 80 }, (_, index) =>
    [`edge:claim:${index}`, 'contains', 'doc:one', `claim:${index}`,
      `claim:${index}`, 'Claim', `claim ${index}`, '{}', '{}', 'structural', 'documentary', 0, 0, 'from']);
  const section = ['edge:section', 'contains', 'doc:one', 'section:one',
    'section:one', 'DocumentSection', 'Design', '{}', '{}', 'structural', 'documentary', 11, 11, 'from'];
  const client = clientWith(async statement => {
    if (statement.includes('EstateProjectionHead')) return [projectionRow];
    if (statement.includes('bundle_count')) return [['structural', 'contains', 'out', 'Claim', 233],
      ['structural', 'contains', 'out', 'DocumentSection', 1]];
    if (statement.includes('ESTATE_EDGE')) return [section, ...claims];
    return [['doc:one', 'Document', 'one.md', '{}', 'documentary', 81, 92]];
  });
  const queries = new EstateGraphQueries({ client, neighbor_limit: 40 });
  const result = await queries.node({ id: 'doc:one' });
  const drawn = result.data.neighbors.reduce((held, row) =>
    ({ ...held, [row.node.kind]: (held[row.node.kind] || 0) + 1 }), {});
  assert.deepEqual({
    drawn,
    quota: result.kind_quota,
    withheld: result.withheld_by_kind,
    // The bundle still carries the true total, so nothing is hidden -- only unfolded.
    bundleTotal: result.data.bundles.find(row => row.kind === 'Claim').count,
  }, {
    drawn: { DocumentSection: 1, Claim: 10 },
    quota: 10,
    withheld: { Claim: 70 },
    bundleTotal: 233,
  });
});
