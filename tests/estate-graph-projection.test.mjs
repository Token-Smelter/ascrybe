import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { cpSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  buildUnifiedEstateProjection, ensureEstateProjectionSchema, ESTATE_SCHEMA_NAMES,
  estateSlot, promoteEstateProjection, pruneEstateProjections, sourcePins, stageEstateProjection,
  WRITE_ESTATE_EDGES_STATEMENT, WRITE_ESTATE_NODES_STATEMENT,
} from '../tools/estate-graph-projection.mjs';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { mergeFacts } from '../tools/merge.mjs';
import { remapCodePlane } from '../scripts/remap.mjs';

const catalogFixture = fileURLToPath(new URL('./fixtures/catalog-coverage/estate', import.meta.url));

function claimMap() {
  const claim = {
    claim_id: 'estate-claim:one', claim_key: 'docs/design.md:4:one',
    statement: 'The map exposes exact provenance.', claim_kind: 'accepted_design',
    source_status: 'current', decision_status: 'accepted', valid_time: null,
    source: { path: 'docs/design.md', line: 4, quote: 'exact provenance',
      blob_oid: 'blob:one', content_sha256: 'a'.repeat(64) },
    proof_plan: { mode: 'all_required', obligations: [{ kind: 'code_symbol_declared' }] },
  };
  const evidence = {
    evidence_id: 'claim-evidence:one', kind: 'code_symbol_census', state: 'supported',
    matches: [{ fact_id: 'fact:one', exact_record_digest: 'b'.repeat(64), surface: 'queryGraph',
      repository: 'fixture', file: 'src/query.mjs', line: 12, declaration_kind: 'function' }],
  };
  const result = {
    result_id: 'claim-obligation-result:one', claim_id: claim.claim_id,
    obligation_id: 'claim-obligation:one', obligation_kind: 'code_symbol_declared',
    state: 'supported', evidence_ids: [evidence.evidence_id], reason: 'declaration exists',
  };
  const receipt = {
    receipt_id: 'claim-adjudication-receipt:one', claim_id: claim.claim_id,
    project_sha: '1'.repeat(40), documentary_evidence_id: evidence.evidence_id,
    obligation_result_ids: [result.result_id], verdict: 'supported', realization: 'partial',
    supporting_evidence_tiers: ['declared'], evidence_ids: [evidence.evidence_id],
  };
  return {
    schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
    project: { id: 'fixture', sha: '1'.repeat(40) },
    claims: [claim], evidence: [evidence], obligation_results: [result],
    adjudication_receipts: [receipt], supersession_receipts: [],
    edges: [{ edge_id: 'estate-map-edge:one', relation: 'about',
      from: claim.claim_id, to: 'fact:one', basis_receipt_id: receipt.receipt_id }],
    coverage: { semantic_claims: 1, terminal_receipts: 1 }, policy: {},
  };
}

function codeGraph() {
  return {
    schema: 'estate-map/remap-code-graph/v1',
    provenance: { source_head: '1'.repeat(40) },
    nodes: {
      'doc:docs/design.md': { k: 'entity', l: 'docs/design.md', ns: 'document', r: 'document' },
      'doc:docs/INDEX.md': { k: 'entity', l: 'docs/INDEX.md', ns: 'document', r: 'document' },
      'referent:query': { k: 'entity', l: 'queryGraph', ns: 'fixture/src/query.mjs', r: 'symbol' },
      'referent:plugin': { k: 'entity', l: 'work-dispatch', ns: 'plugins/work-dispatch/plugin.yaml', r: 'yaml_document' },
      'referent:capability': { k: 'entity', l: 'brew', ns: '["fixture","capability"]', r: 'capability_flow' },
      'referent:envelope': { k: 'entity', l: 'brew.started', ns: '["fixture","envelope"]', r: 'envelope_flow' },
      'referent:potion': { k: 'entity', l: 'builtin/single-task', ns: '["fixture","example.recipe/v1"]', r: 'yaml_document' },
    },
    identity_bindings: [{
      fact_id: 'fact:one', fact_kind: 'symbol', mention_id: 'mention:one',
      referent_id: 'referent:query', surface: 'queryGraph', repository: 'fixture',
      file: 'src/query.mjs', line: 12, declaration_kind: 'function',
    }],
    relations: [{ relation: 'documented_in', from: 'doc:docs/design.md', to: 'referent:query' }],
    adj: {}, counts: {},
  };
}

test('unified projection connects document, claim, evidence, code fact, and Referent', () => {
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: codeGraph() });
  const edge = relation => state.edges.find(row => row.relation === relation);
  assert.deepEqual({
    claims: state.counts.nodes_by_kind.Claim,
    documents: state.counts.nodes_by_kind.Document,
    referents: state.counts.nodes_by_kind.Referent,
    binaryOrder: state.nodes.findIndex(row => row.node_id === 'doc:docs/INDEX.md')
      < state.nodes.findIndex(row => row.node_id === 'doc:docs/design.md'),
    factDegree: state.nodes.find(row => row.node_id === 'fact:one').degree,
    domainKinds: ['referent:plugin', 'referent:capability', 'referent:envelope', 'referent:potion']
      .map(id => state.nodes.find(row => row.node_id === id).kind),
    symbolKind: state.nodes.find(row => row.node_id === 'referent:query').kind,
    about: [edge('about').from, edge('about').to],
    identifies: [edge('identifies').from, edge('identifies').to],
    selectedDigestBound: state.projection_id.startsWith('estate-projection:'),
  }, {
    claims: 1, documents: 2, referents: undefined, binaryOrder: true, factDegree: 3,
    domainKinds: ['Plugin', 'Capability', 'Envelope', 'DeclaredDocument'],
    symbolKind: 'Symbol',
    about: ['estate-claim:one', 'fact:one'],
    identifies: ['fact:one', 'referent:query'],
    selectedDigestBound: true,
  });
});

test('projection derives relation roles, node planes, and distinct structural descent', () => {
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: codeGraph() });
  const node = id => state.nodes.find(row => row.node_id === id);
  const commit = node(`source-commit:${'1'.repeat(40)}`);
  const document = node('doc:docs/design.md');
  assert.deepEqual({
    roles: state.relation_registry.roles_by_relation,
    unclassified: [state.relation_registry.unclassified_relations, state.relation_registry.unclassified_kinds],
    planes: ['project:fixture', 'fact:one', 'estate-claim:one', 'claim-adjudication-receipt:one'].map(id => node(id).plane),
    edgeRole: state.edges.find(row => row.relation === 'documented_in').role,
    // The commit contains the document, the code fact and the declared entities directly; the
    // claim is reached only through its document, so it is a descendant and not a child.
    commit: [commit.structural_children, commit.structural_descendants],
    document: [document.structural_children, document.structural_descendants],
    claim: [node('estate-claim:one').structural_children, node('estate-claim:one').structural_descendants],
    // A documented_in edge raises total degree but not structural degree.
    symbolDegree: [node('referent:query').degree, node('referent:query').structural_degree],
  }, {
    roles: { about: 'annotation', adjudicated_by: 'annotation', contains: 'structural', documented_in: 'annotation',
      evidenced_by: 'annotation', has_obligation_result: 'annotation', has_source_commit: 'structural',
      identifies: 'annotation' },
    unclassified: [[], []],
    planes: ['entity', 'observation', 'documentary', 'adjudication'],
    edgeRole: 'annotation',
    commit: [6, 7], document: [1, 1], claim: [0, 0],
    symbolDegree: [2, 0],
  });
});

test('an unregistered relation is projected, counted as unclassified, and named', () => {
  const graph = codeGraph();
  graph.relations.push({ relation: 'twinned_with', from: 'referent:plugin', to: 'referent:capability' });
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual({
    role: state.edges.find(row => row.relation === 'twinned_with').role,
    named: state.relation_registry.unclassified_relations,
    counted: state.relation_registry.edges_by_role.unclassified,
    pluginStructural: state.nodes.find(row => row.node_id === 'referent:plugin').structural_degree,
  }, { role: 'unclassified', named: ['twinned_with'], counted: 1, pluginStructural: 1 });
});

test('projection preserves remap document paths as canonical provenance', () => {
  const graph = codeGraph();
  graph.nodes['doc:benchmark'] = { k: 'entity', l: 'documents/../benchmarks/answer-key.md', ns: 'document', r: 'document' };
  const projection = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual(projection.nodes.filter(node => node.kind === 'Document')
    .map(node => [node.node_id, node.properties.path]), [
      ['doc:benchmark', 'benchmarks/answer-key.md'],
      ['doc:docs/INDEX.md', 'docs/INDEX.md'],
      ['doc:docs/design.md', 'docs/design.md'],
    ]);
});

test('projection gives Evidence nodes canonical source provenance', () => {
  const map = claimMap();
  map.evidence.push(
    { evidence_id: 'evidence:documentary', kind: 'documentary_source', state: 'supported',
      source: { path: 'benchmarks/answer-key.md', quote: 'fixture answer' } },
    { evidence_id: 'evidence:source-text', kind: 'source_text', state: 'supported',
      path: 'benchmarks/answer-key.md', line: 1, quote: 'fixture answer' },
  );
  const projection = buildUnifiedEstateProjection({ claim_map: map });
  assert.deepEqual(projection.nodes.filter(node => node.kind === 'Evidence').map(node => [node.node_id, node.properties.source_path]), [
    ['claim-evidence:one', null],
    ['evidence:documentary', 'benchmarks/answer-key.md'],
    ['evidence:source-text', 'benchmarks/answer-key.md'],
  ]);
});

test('projection gives newly extracted observations stable nodes and queryable relations', () => {
  const graph = codeGraph();
  graph.extracted_facts = [
    { kind: 'catalog_entry', repo: 'fixture', file: 'catalogs/checks.json', line: 1,
      entry_key_path: 'fast', scalar_fields: { command: 'node test' }, content_digest: 'a'.repeat(64) },
    { kind: 'manifest_empty_declaration', repo: 'fixture', file: 'plugin.yaml', line: 4,
      declaration_key: 'requires_capabilities', declaration_empty: true, shape: 'sequence' },
    { kind: 'declaration_comment', repo: 'fixture', file: 'tools.ts', line: 1,
      declaration: 'tools', text: 'Agent-facing tools.' },
    { kind: 'tool_registration', repo: 'fixture', file: 'tools.ts', line: 5,
      name: 'declare_ward' },
    { kind: 'tool_registration_refusal', repo: 'fixture', file: 'tools.ts', line: 9,
      reason: 'tool_name_is_not_a_string_literal' },
  ];
  const projection = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  const projected = projection.nodes.filter(node => ['CatalogEntry', 'EmptyDeclaration', 'DeclarationComment', 'ToolRegistration', 'ExtractionRefusal']
    .includes(node.kind));
  assert.deepEqual({ kinds: projected.map(node => node.kind).sort(), ids: projected.every(node => /^extracted-fact:[0-9a-f]{64}$/u.test(node.node_id)),
    observed: projection.edges.filter(edge => edge.relation === 'observed_in').length,
    additions: projection.projection_additions }, {
    kinds: ['CatalogEntry', 'DeclarationComment', 'EmptyDeclaration', 'ExtractionRefusal', 'ToolRegistration'], ids: true, observed: 5,
    additions: { node_kinds: ['Assertion', 'CatalogEntry', 'DeclarationComment', 'Diagram', 'DiagramRelation', 'DocumentSection', 'EmptyDeclaration', 'ExtractionRefusal', 'ToolRegistration'], relation_names: ['asserted_in', 'contains', 'observed_in', 'read_from', 'relates_assertion'] },
  });
});

test('remap forwards the exact extractor stream into the unified projection', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'remap-extracted-facts-'));
  try {
    const estate = join(root, 'estate');
    const work = join(root, 'work');
    const remap = join(root, 'remap');
    cpSync(join(catalogFixture, 'fixture'), join(estate, 'fixture'), { recursive: true });
    await extractEstate(estate, join(work, 'extract'), {
      repo: 'fixture', strict: true,
      catalog_globs: ['catalogs/**/*.json', 'catalogs/**/*.yaml'],
    });
    await mergeFacts(join(work, 'extract'), join(work, 'merge'));
    remapCodePlane({ work, sha: '1'.repeat(40), out: remap });

    const sourceFacts = readFileSync(join(work, 'extract', 'facts', 'fixture.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(JSON.parse);
    const graph = JSON.parse(readFileSync(join(remap, 'adjacency.json'), 'utf8'));
    const projection = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
    const observedKinds = ['catalog_entry', 'catalog_entry_refusal', 'declaration_comment',
      'manifest_empty_declaration', 'tool_registration', 'tool_registration_refusal'];
    const expectedObserved = sourceFacts.filter(fact => observedKinds.includes(fact.kind));
    assert.deepEqual({
      source: expectedObserved.map(fact => fact.kind).sort(),
      forwarded: graph.extracted_facts,
      count: graph.counts.extracted_facts,
      streamDigest: /^[0-9a-f]{64}$/u.test(graph.provenance.extracted_fact_stream_digest || ''),
      projected: projection.edges.filter(edge => edge.relation === 'observed_in').length,
    }, {
      source: ['catalog_entry', 'catalog_entry', 'catalog_entry', 'catalog_entry',
        'catalog_entry_refusal', 'catalog_entry_refusal', 'declaration_comment',
        'declaration_comment', 'declaration_comment',
        'manifest_empty_declaration', 'tool_registration', 'tool_registration_refusal'],
      forwarded: sourceFacts,
      count: sourceFacts.length,
      streamDigest: true,
      projected: expectedObserved.length,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a multi-repo estate binds a composite pin map whose digest is its source identity', () => {
  const pins = { 'component-a': 'a'.repeat(40), 'component-b': 'b'.repeat(40) };
  const digest = sourcePins({ source_pins: pins }).digest;
  const claim = claimMap();
  claim.project = { id: 'sw', sha: digest };
  claim.claims = []; claim.evidence = []; claim.obligation_results = [];
  claim.adjudication_receipts = []; claim.edges = [];
  const graph = codeGraph();
  graph.provenance = { source_pins: pins, code_plane_head: 'code-plane:sw' };
  graph.relations = [];
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  assert.deepEqual({
    recorded: state.source_pins,
    // Order of declaration must not change identity.
    stable: sourcePins({ source_pins: { 'component-b': 'b'.repeat(40), 'component-a': 'a'.repeat(40) } }).digest === digest,
    singleRepoUnchanged: sourcePins({ source_head: '1'.repeat(40) }).digest,
  }, { recorded: pins, stable: true, singleRepoUnchanged: '1'.repeat(40) });

  graph.provenance = { source_pins: { 'component-a': 'c'.repeat(40) }, code_plane_head: 'code-plane:sw' };
  assert.throws(() => buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph }),
    error => error.code === 'UNIFIED_PROJECTION_SOURCE_MISMATCH');
  assert.throws(() => sourcePins({ source_pins: { 'component-a': 'not-a-sha' } }),
    error => error.code === 'UNIFIED_PROJECTION_SOURCE_PIN_INVALID');
});

test('a projected assertion cites the section containing it, not only its line', () => {
  const claim = claimMap();
  claim.claims = []; claim.evidence = []; claim.obligation_results = [];
  claim.adjudication_receipts = []; claim.edges = [];
  const graph = codeGraph();
  graph.relations = [];
  // Sections and diagram facts arrive in one stream; building assertions per fact could not see
  // the sections, so every assertion in a 4,326-node projection cited no section at all.
  graph.extracted_facts = [
    { kind: 'document_section', repo: 'fixture', file: 'docs/design.md', line: 1, line_end: 40,
      section_path: 'Design', section_depth: 1 },
    { kind: 'document_section', repo: 'fixture', file: 'docs/design.md', line: 4, line_end: 12,
      section_path: 'Design / Flow', section_depth: 2 },
    { kind: 'diagram_relation', repo: 'fixture', file: 'docs/design.md', line: 6,
      from_identifier: 'TaskOrch', to_identifier: 'Envelope', relation_label: 'publishes', arrow: '-->',
      diagram_address: 'docs/design.md:5', diagram_shape: 'flow', diagram_syntax: 'mermaid',
      document_mode: 'specification', adjudication_frame: 'code', document_archived: false },
  ];
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const assertion = state.nodes.find(row => row.kind === 'Assertion');
  const edges = state.edges.filter(row => row.from === assertion.node_id).map(row => row.relation).sort();
  assert.deepEqual({
    label: assertion.label,
    // The deepest section containing the line, so the claim survives the line numbers moving.
    section: assertion.properties.section_path,
    subject: [assertion.properties.subject_kind, assertion.properties.from_text, assertion.properties.to_text],
    frame: assertion.properties.adjudication_frame,
    edges,
  }, {
    label: 'TaskOrch publishes Envelope',
    section: 'Design / Flow',
    subject: ['relation', 'TaskOrch', 'Envelope'],
    frame: 'code',
    edges: ['asserted_in', 'read_from'],
  });
});

test('what the corpus says about its own claims is reachable by traversal', () => {
  const claim = claimMap();
  claim.claims = []; claim.evidence = []; claim.obligation_results = [];
  claim.adjudication_receipts = []; claim.edges = [];
  const graph = codeGraph();
  graph.relations = [];
  graph.nodes['doc:two.md'] = { k: 'entity', l: 'two.md', ns: 'document', r: 'document' };
  const drawn = (file, line, label) => ({ kind: 'diagram_relation', repo: 'fixture', file, line,
    from_identifier: 'Billing', to_identifier: 'Ledger', relation_label: label, arrow: '-->',
    diagram_address: `${file}:1`, diagram_shape: 'flow', diagram_syntax: 'mermaid',
    document_mode: 'specification', adjudication_frame: 'code', document_archived: false });
  graph.extracted_facts = [drawn('docs/design.md', 4, 'retries'), drawn('two.md', 9, 'does not retry')];
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const relation = state.nodes.find(row => row.kind === 'Assertion' && row.properties.producer === 'assertion-relations');
  const related = state.edges.filter(row => row.relation === 'relates_assertion' && row.from === relation.node_id);
  assert.deepEqual({
    // A superseded or contradicted design is reachable by traversal rather than by reading every
    // revision, and the relation names the rule that produced it.
    // Ordering within a pair is by assertion id so the record is reproducible, not by which
    // document was read first; both predicates appear either way.
    label: [relation.label.includes('retries'), relation.label.includes('does not retry')],
    predicate: relation.properties.predicate,
    crossDocument: relation.properties.cross_document,
    ruleStated: relation.properties.rule.length > 0,
    // Both claims it relates, each reached from the relation itself.
    endpoints: related.map(row => row.properties.role).sort(),
  }, {
    label: [true, true],
    predicate: 'direct_conflict',
    crossDocument: true,
    ruleStated: true,
    endpoints: ['left', 'right'],
  });
});

test('unified projection refuses different claim and code source commits', () => {
  const graph = codeGraph(); graph.provenance.source_head = '2'.repeat(40);
  assert.throws(() => buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph }),
    error => error.code === 'UNIFIED_PROJECTION_SOURCE_MISMATCH');
});

test('Neo4j projection schema and writers preserve generation isolation', async () => {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  let poll = 0;
  // The creation request times out exactly as it does over an estate-scale projection; readiness
  // must therefore be established from database state rather than from the response.
  client.query = async statement => {
    if (statement.includes('estate_node_structure')) {
      const error = new Error('Neo4j request failed at the explicit target');
      error.code = 'NEO4J_REQUEST_FAILED';
      throw error;
    }
    if (!statement.startsWith('SHOW INDEXES')) return [];
    poll += 1;
    return ESTATE_SCHEMA_NAMES.map(name => [name,
      name === 'estate_node_structure' && poll === 1 ? 'POPULATING' : 'ONLINE']);
  };
  const schema = await ensureEstateProjectionSchema(client, { waitMs: 0 });
  assert.deepEqual({
    schemas: schema.names.length,
    nodeScoped: /projection_id: \$projection_id/u.test(WRITE_ESTATE_NODES_STATEMENT),
    edgeScoped: /projection_id: \$projection_id/u.test(WRITE_ESTATE_EDGES_STATEMENT),
    polls: poll,
    recordedTimeout: schema.creation_errors.map(row => row.name),
  }, { schemas: 7, nodeScoped: true, edgeScoped: true, polls: 2,
    recordedTimeout: ['estate_node_structure'] });
});

test('staging recognizes an already-selected identical generation instead of rewriting it', async () => {
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: codeGraph() });
  const statements = [];
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  client.query = async statement => {
    statements.push(statement);
    if (statement.startsWith('SHOW INDEXES')) return ESTATE_SCHEMA_NAMES.map(name => [name, 'ONLINE']);
    if (!statement.includes('EstateProjectionHead')) return [];
    return [
      ['selected', state.projection_id, 'selected', state.project.sha, state.content_digest,
        state.source_artifacts.claim_map_digest, state.source_artifacts.code_graph_digest,
        state.counts.nodes, state.counts.nodes, state.counts.edges, state.counts.edges],
      ['working', null, null, null, null, null, null, 0, 0, 0, 0],
    ];
  };
  const staged = await stageEstateProjection({ client, state });
  assert.deepEqual({
    status: staged.status,
    rewroteRows: statements.some(statement => statement.includes('MERGE (n:EstateNode')),
  }, { status: 'already_selected', rewroteRows: false });
});

test('retention removes only generations behind the selected head and its kept ancestors', async () => {
  const deletions = [];
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  const remaining = new Map([['estate-projection:old', 2], ['estate-projection:ancient', 1]]);
  client.query = async (statement, parameters) => {
    if (statement.includes('EstateProjectionHead')) {
      return [
        ['selected', 'estate-projection:current', 'selected', 'sha', 'digest', null, null, 1, 1, 1, 1],
        ['working', null, null, null, null, null, null, 0, 0, 0, 0],
      ];
    }
    if (statement.includes('WHERE NOT p.projection_id IN $protected')) {
      return [['estate-projection:prior'], ['estate-projection:old'], ['estate-projection:ancient']];
    }
    if (statement.includes('DETACH DELETE')) {
      deletions.push(parameters.projection_id);
      const left = remaining.get(parameters.projection_id) || 0;
      remaining.set(parameters.projection_id, Math.max(0, left - 1));
      return [[left ? 20_000 : 0]];
    }
    return [[1]];
  };
  const pruned = await pruneEstateProjections({ client, retain_superseded: 1 });
  assert.deepEqual({
    pruned: pruned.pruned_projection_ids,
    retained: pruned.retained,
    selectedTouched: deletions.includes('estate-projection:current'),
    keptAncestorTouched: deletions.includes('estate-projection:prior'),
    removedNodes: pruned.removed_nodes,
  }, {
    pruned: ['estate-projection:old', 'estate-projection:ancient'],
    retained: ['estate-projection:current', 'estate-projection:prior'],
    selectedTouched: false,
    keptAncestorTouched: false,
    removedNodes: 60_000,
  });
});

test('retention scopes candidates to one estate and protects every head in the database', async () => {
  const statements = [];
  const client = new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
  client.query = async (statement, parameters) => {
    statements.push({ statement, parameters });
    if (statement.includes('EstateProjectionHead {slot: slot}') || statement.includes('UNWIND [$selected_slot')) {
      return [['sw:selected', 'estate-projection:sw-live', 'selected', '1'.repeat(40), 'c', 'cm', 'cg', 1, 1, 1, 1],
        ['sw:working', null, null, null, null, null, null, 0, 0, 0, 0]];
    }
    if (statement.includes('MATCH (h:EstateProjectionHead)')) {
      // Another estate's live head must survive a prune it did not ask for.
      return [['estate-projection:sw-live'], ['estate-projection:host-runtime-live']];
    }
    if (statement.includes('MATCH (p:EstateProjection)')) return [['estate-projection:sw-old', 'superseded', '2026-01-01']];
    return [[0]];
  };
  const held = await pruneEstateProjections({ client, retain_superseded: 0, estate: 'sw' });
  const candidateQuery = statements.find(row => row.statement.includes('MATCH (p:EstateProjection)'));
  assert.deepEqual({
    estateScoped: candidateQuery.parameters.estate,
    protectsOtherEstateHead: candidateQuery.parameters.protected.includes('estate-projection:host-runtime-live'),
    pruned: held.pruned_projection_ids,
    slots: [estateSlot('selected', 'sw'), estateSlot('working', null)],
  }, {
    estateScoped: 'sw',
    protectsOtherEstateHead: true,
    pruned: ['estate-projection:sw-old'],
    slots: ['sw:selected', 'working'],
  });
});

test('retention refuses to run without a selected or working head', async () => {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  client.query = async () => [
    ['selected', null, null, null, null, null, null, 0, 0, 0, 0],
    ['working', null, null, null, null, null, null, 0, 0, 0, 0],
  ];
  await assert.rejects(() => pruneEstateProjections({ client }),
    error => error.code === 'ESTATE_PROJECTION_RETENTION_UNSAFE');
});

test('promotion advances selected only through the ready-candidate transaction', async () => {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  client.begin = async () => ({ transaction_url: 'held', commit_url: 'held/commit' });
  client.commit = async (_transaction, statements) => {
    assert.match(statements[0].statement, /status: 'ready'/u);
    return [{ data: [{ row: ['estate-projection:ready', 'digest:ready'] }] }];
  };
  client.rollback = async () => {};
  assert.deepEqual(await promoteEstateProjection({
    client, projection_id: 'estate-projection:ready', expected_selected_projection_id: null,
  }), {
    projection_id: 'estate-projection:ready', status: 'selected', content_digest: 'digest:ready',
  });
});

const codeGraphAt = mappedAt => ({
  schema: 'estate-map/remap-code-graph/v1',
  provenance: { source_head: '1'.repeat(40), code_plane_head: 'plane:one', mapped_at: mappedAt },
  nodes: { 'entity:one': { kind: 'module' } },
});

test('re-mapping an unchanged estate projects the same code-graph identity', () => {
  const digestOf = graph => buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph })
    .source_artifacts.code_graph_digest;
  assert.equal(digestOf(codeGraphAt('2026-01-01T00:00:00Z')), digestOf(codeGraphAt('2026-08-16T22:00:00Z')));
});

test('a changed estate still projects a different code-graph identity', () => {
  const unchanged = buildUnifiedEstateProjection({
    claim_map: claimMap(), code_graph: codeGraphAt('2026-01-01T00:00:00Z'),
  }).source_artifacts.code_graph_digest;
  const moved = codeGraphAt('2026-01-01T00:00:00Z');
  moved.provenance = { ...moved.provenance, code_plane_head: 'plane:two' };
  assert.notEqual(buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: moved })
    .source_artifacts.code_graph_digest, unchanged);
});

test('a documentary fact hangs off what contains it, not off the commit', () => {
  const claim = claimMap();
  const graph = codeGraph();
  graph.relations = [];
  const file = 'docs/design.md';
  graph.extracted_facts = [
    { kind: 'document_section', repo: 'fixture', file, document_path: file, line: 1, line_end: 40,
      section_path: 'Design', section_depth: 1, heading_level: 1 },
    { kind: 'document_section', repo: 'fixture', file, document_path: file, line: 10, line_end: 25,
      section_path: 'Design / Constraints', section_depth: 2, heading_level: 2 },
    { kind: 'diagram', repo: 'fixture', file, document_path: file, line: 12,
      diagram_shape: 'flow', diagram_syntax: 'mermaid', diagram_address: `${file}:12` },
    { kind: 'diagram_relation', repo: 'fixture', file, document_path: file, line: 14,
      from_identifier: 'Billing', to_identifier: 'Ledger', relation_label: 'emits', arrow: '-->',
      diagram_address: `${file}:12`, diagram_shape: 'flow', diagram_syntax: 'mermaid' },
    // A kind that declares the commit keeps hanging off the commit.
    { kind: 'catalog_entry', repo: 'fixture', file: 'checks.yaml', document_path: 'checks.yaml',
      line: 3, entry_key_path: 'checks.build' },
  ];
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const byKind = kind => state.nodes.find(row => row.kind === kind);
  // `contains` runs parent to child; `observed_in` runs child to parent. The parent is whichever
  // end the relation says it is, which is exactly the fact the client used to have to guess.
  const parentOf = id => {
    const edge = state.edges.find(row => (row.relation === 'contains' && row.to === id)
      || (row.relation === 'observed_in' && row.from === id));
    return edge && { relation: edge.relation, parent: edge.relation === 'contains' ? edge.from : edge.to,
      properties: edge.properties };
  };
  const outer = state.nodes.find(row => row.kind === 'DocumentSection' && row.label === 'Design');
  const inner = state.nodes.find(row => row.kind === 'DocumentSection' && row.label === 'Design / Constraints');
  const drawing = byKind('Diagram');
  const drawn = byKind('DiagramRelation');
  const catalog = byKind('CatalogEntry');
  const commit = `source-commit:${claim.project.sha}`;

  assert.deepEqual({
    // The defect this replaces: every one of these attached straight to the commit, so a document
    // drilled to its claims and none of its own sections.
    outerSection: [parentOf(outer.node_id).relation, parentOf(outer.node_id).parent],
    innerSection: [parentOf(inner.node_id).relation, parentOf(inner.node_id).parent === outer.node_id],
    diagram: [parentOf(drawing.node_id).relation, parentOf(drawing.node_id).parent === inner.node_id],
    diagramRelation: [parentOf(drawn.node_id).relation, parentOf(drawn.node_id).parent === drawing.node_id],
    catalogEntry: [parentOf(catalog.node_id).relation, parentOf(catalog.node_id).parent],
    // Nothing documentary is left hanging on the commit.
    documentaryOnCommit: state.edges.filter(row => row.to === commit
      && ['document_section', 'diagram', 'diagram_relation'].includes(row.properties.fact_kind)).length,
    refused: state.counts.containment.refused,
  }, {
    outerSection: ['contains', `doc:${file}`],
    innerSection: ['contains', true],
    diagram: ['contains', true],
    diagramRelation: ['contains', true],
    catalogEntry: ['observed_in', commit],
    documentaryOnCommit: 0,
    refused: {},
  });
});

test('a container that cannot be resolved is reported, and the fact still reaches the commit', () => {
  const claim = claimMap();
  const graph = codeGraph();
  graph.relations = [];
  // A document nothing claims: the corpus has no Document node to hang a section on.
  graph.extracted_facts = [{ kind: 'document_section', repo: 'fixture', file: 'docs/unclaimed.md',
    document_path: 'docs/unclaimed.md', line: 1, line_end: 8, section_path: 'Notes', section_depth: 1 }];
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const section = state.nodes.find(row => row.kind === 'DocumentSection');
  const edge = state.edges.find(row => row.from === section.node_id && row.relation === 'observed_in');
  assert.deepEqual({
    reachable: [edge.relation, edge.to],
    // Recorded, not absorbed: a silent fallback is how the flat documentary plane happened.
    reason: edge.properties.containment_refusal,
    reported: state.counts.containment.refused,
  }, {
    reachable: ['observed_in', `source-commit:${claim.project.sha}`],
    reason: 'document_absent',
    reported: { 'document_section:document_absent': 1 },
  });
});

test('a claim map too large to hold is refused with directions, not a RangeError', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'claimmap-'));
  try {
    // Not actually 600MB: the guard reads the size, so a sparse file proves the branch without
    // writing the bytes. A real estate's map is 644,632,920 against a 536,870,888 ceiling, so
    // this path could never have worked and failed with nothing pointing at the sharded reader.
    const path = join(root, 'claim-evidence-map.json');
    writeFileSync(path, '{}');
    truncateSync(path, constants.MAX_STRING_LENGTH + 1);
    const { readWholeClaimMap } = await import('../tools/project-estate-map.mjs');
    assert.throws(() => readWholeClaimMap(path),
      error => error.code === 'ESTATE_PROJECTION_CLAIM_MAP_TOO_LARGE'
        && /--claim-map-shards/u.test(error.message)
        && error.detail.bytes > error.detail.ceiling);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
