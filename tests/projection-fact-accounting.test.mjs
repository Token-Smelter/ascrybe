import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedEstateProjection, EXTRACTED_FACT_KINDS } from '../tools/estate-graph-projection.mjs';

// The builder's unregistered-kind warning used to count every fact whose kind lacks an
// EXTRACTED_FACT_KINDS entry as one undifferentiated number, indistinguishable from a fact the
// graph actually reaches by another route (a CodeFact identity binding, a typed dependency
// relation's witness, or the structural Document a `document` fact represents). These fixtures
// are invented; none names a real mapped estate.

function claimMap() {
  return {
    schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
    project: { id: 'fixture', sha: '1'.repeat(40) },
    claims: [], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [], coverage: {}, policy: {},
  };
}

function codeGraph() {
  return {
    schema: 'estate-map/remap-code-graph/v1',
    provenance: { source_head: '1'.repeat(40) },
    counts: {}, identity_bindings: [], relations: [], nodes: {}, adj: {},
    extracted_facts: [],
  };
}

test('a document fact reconciles as the structural-document route, not a bare loss count', () => {
  const graph = codeGraph();
  const file = 'design/notes.md';
  graph.extracted_facts = [
    { kind: 'document', repo: 'fixture', file, document_path: file, line: 1,
      line_count: 5, heading_count: 1, has_structure: true },
  ];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual({
    documentNode: Boolean(state.nodes.find(row => row.node_id === `doc:${file}`)),
    unregistered: state.counts.containment.unregistered_fact_kinds,
    disposition: state.counts.containment.unregistered_fact_dispositions,
  }, {
    documentNode: true,
    unregistered: { document: 1 },
    disposition: { document: { total: 1, duplicate_content_rows: 0,
      identity_or_relation_witness: 0, structural_document: 1, no_matched_explicit_route: 0 } },
  });
});

test('a fact whose raw site an identity binding witnesses reconciles as an alternate route', () => {
  const graph = codeGraph();
  graph.nodes = { 'referent:module-one': { k: 'entity', l: 'app.js', ns: 'fixture/src/app.js', r: 'module' } };
  graph.identity_bindings = [{
    fact_id: 'code-fact:one', fact_kind: 'module', mention_id: 'mention:one',
    referent_id: 'referent:module-one', repository: 'fixture', file: 'src/app.js', line: 1,
    declaration_kind: null, surface: 'app.js',
  }];
  graph.extracted_facts = [{ kind: 'module', repo: 'fixture', file: 'src/app.js', line: 1, language: 'javascript' }];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual(state.counts.containment.unregistered_fact_dispositions.module, {
    total: 1, duplicate_content_rows: 0, identity_or_relation_witness: 1,
    structural_document: 0, no_matched_explicit_route: 0,
  });
});

test('a fact witnessed only by a typed dependency relation reconciles as an alternate route', () => {
  const graph = codeGraph();
  graph.nodes = {
    'module:fixture:src/app.js': { k: 'entity', l: 'app.js', ns: 'fixture', r: 'module' },
    'module:fixture:src/lib.js': { k: 'entity', l: 'lib.js', ns: 'fixture', r: 'module' },
  };
  graph.relations = [{
    relation_id: 'code-dependency-relation:one', edge_kind: 'imports',
    from_referent_id: 'module:fixture:src/app.js', to_referent_id: 'module:fixture:src/lib.js',
    witnesses: [{ repo: 'fixture', file: 'src/app.js', line: 3 }],
  }];
  graph.extracted_facts = [{ kind: 'import', repo: 'fixture', file: 'src/app.js', line: 3, specifier: './lib.js' }];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual(state.counts.containment.unregistered_fact_dispositions.import, {
    total: 1, duplicate_content_rows: 0, identity_or_relation_witness: 1,
    structural_document: 0, no_matched_explicit_route: 0,
  });
});

test('a byte-identical repeat of an unmatched-kind fact is counted as a duplicate, not fresh loss', () => {
  const graph = codeGraph();
  const fact = { kind: 'an_invented_kind', repo: 'fixture', file: 'src/app.js', line: 9 };
  graph.extracted_facts = [fact, { ...fact }];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual(state.counts.containment.unregistered_fact_dispositions.an_invented_kind, {
    total: 2, duplicate_content_rows: 1, identity_or_relation_witness: 0,
    structural_document: 0, no_matched_explicit_route: 1,
  });
});

test('a fact with no matched explicit route is still counted and named, never exempted', () => {
  const graph = codeGraph();
  graph.extracted_facts = [{ kind: 'an_unrouted_kind', repo: 'fixture', file: 'src/app.js', line: 21 }];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual({
    unregistered: state.counts.containment.unregistered_fact_kinds.an_unrouted_kind,
    disposition: state.counts.containment.unregistered_fact_dispositions.an_unrouted_kind,
  }, {
    unregistered: 1,
    disposition: { total: 1, duplicate_content_rows: 0, identity_or_relation_witness: 0,
      structural_document: 0, no_matched_explicit_route: 1 },
  });
});

test('three previously unmatched refusal kinds are represented, not merely accounted', () => {
  for (const kind of ['capability_refusal', 'http_route_refusal', 'manifest_completeness_refusal']) {
    assert.ok(EXTRACTED_FACT_KINDS[kind], `${kind} must declare a node kind`);
  }
  const graph = codeGraph();
  graph.extracted_facts = [
    { kind: 'capability_refusal', repo: 'fixture', file: 'plugin.yaml', line: 4, reason: 'ambiguous_direction' },
    { kind: 'http_route_refusal', repo: 'fixture', file: 'routes.ts', line: 2, reason: 'framework_unrecognized' },
    { kind: 'manifest_completeness_refusal', repo: 'fixture', file: 'plugin.yaml', line: 1, reason: 'yaml_parse_threw' },
  ];
  const state = buildUnifiedEstateProjection({ claim_map: claimMap(), code_graph: graph });
  assert.deepEqual({
    refusals: state.nodes.filter(node => node.kind === 'ExtractionRefusal').length,
    unregistered: state.counts.containment.unregistered_fact_kinds,
  }, { refusals: 3, unregistered: {} });
});
