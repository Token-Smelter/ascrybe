import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeDependencyRelations, traversableRelations,
} from '../tools/code-dependency-relations.mjs';
import envelopeExtractor from '../tools/extractors/envelopes.mjs';

const codePlaneHead = 'code-plane:relation-fixture';
const moduleCandidate = (repo, file, index) => ({
  fact_id: `code-fact:module-${index}`,
  fact_kind: 'module',
  record: { kind: 'module', repo, file, line: 1, language: 'javascript' },
  mention: { mention_id: `mention:module-${index}` },
});

function fixtureGraph() {
  return {
    nodes: [
      { id: 'module:app:src/a.js', kind: 'module' },
      { id: 'module:app:src/b.js', kind: 'module' },
      { id: 'package:left-pad', kind: 'package' },
      { id: 'route:app:GET:health', kind: 'route', repo: 'app',
        witnesses: [{ repo: 'app', file: 'src/routes.js', line: 7 }] },
      { id: 'repo:app', kind: 'repo', repo: 'app',
        witnesses: [{ repo: 'app', file: '.', line: 1 }] },
    ],
    edges: [
      { id: 'imports:a-to-b', kind: 'imports', status: 'resolved',
        from: 'module:app:src/a.js', to: 'module:app:src/b.js',
        witnesses: [{ file: 'src/a.js', line: 3 }] },
      { id: 'consumes:a-to-pkg', kind: 'consumes_package', status: 'external_producer',
        from: 'module:app:src/a.js', to: 'package:left-pad', witnesses: [] },
      { id: 'imports:ambiguous', kind: 'imports', status: 'ambiguous',
        from: 'module:app:src/b.js', to: null,
        candidates: ['module:app:src/x.js', 'module:app:src/y.js'], witnesses: [] },
      { id: 'weird:edge', kind: 'imports', status: 'never_heard_of_it',
        from: 'module:app:src/a.js', to: 'module:app:src/b.js', witnesses: [] },
      { id: 'exposes:repo-to-route', kind: 'exposes_route', status: 'resolved',
        from: 'repo:app', to: 'route:app:GET:health',
        witnesses: [{ repo: 'app', file: 'src/routes.js', line: 7 }] },
    ],
  };
}

const symbolCandidate = () => ({
  fact_id: 'code-fact:symbol-1',
  fact_kind: 'symbol',
  record: { kind: 'symbol', repo: 'app', file: 'src/a.js', line: 12, name: 'runJob',
    symbol_kind: 'function', scope_path: ['runJob'] },
  mention: { mention_id: 'mention:symbol-1' },
});
const routeCandidate = () => ({
  fact_id: 'code-fact:route-1',
  fact_kind: 'http_route',
  record: { kind: 'http_route', repo: 'app', file: 'src/routes.js', line: 7,
    owner: 'core', framework: 'express', method: 'GET', declared_route: '/health' },
  mention: { mention_id: 'mention:route-1' },
});
const repoCandidate = () => ({
  fact_id: 'code-fact:repo-1',
  fact_kind: 'repo',
  record: { kind: 'repo', repo: 'app', file: '.', line: 1, name: 'app', root: '.' },
  mention: { mention_id: 'mention:repo-1' },
});

test('[design §17] every merge edge yields exactly one relation record or one typed refusal', () => {
  const candidates = [moduleCandidate('app', 'src/a.js', 1), moduleCandidate('app', 'src/b.js', 2),
    routeCandidate(), repoCandidate(), symbolCandidate()];
  const held = buildCodeDependencyRelations({
    merge_graph: fixtureGraph(), code_plane_head: codePlaneHead, identity_candidates: candidates,
  });
  const containment = held.relations.find(row => row.source_edge_id === 'containment:code-fact:symbol-1');
  assert.deepEqual({
    kind: containment.edge_kind,
    from: containment.from_code_mention_id,
    to: containment.to_code_mention_id,
    status: containment.status,
    witness: containment.witnesses,
    reported: [held.report.containment_relations, held.report.merge_relations],
  }, {
    kind: 'declares_symbol',
    from: 'mention:module-1',
    to: 'mention:symbol-1',
    status: 'resolved',
    witness: [{ repo: 'app', file: 'src/a.js', line: 12 }],
    reported: [1, 4],
  });
  const imports = held.relations.find(row => row.source_edge_id === 'imports:a-to-b');
  const external = held.relations.find(row => row.source_edge_id === 'consumes:a-to-pkg');
  const ambiguous = held.relations.find(row => row.source_edge_id === 'imports:ambiguous');
  const exposes = held.relations.find(row => row.source_edge_id === 'exposes:repo-to-route');
  assert.deepEqual({
    conservation: held.report.merge_relations + held.refusals.length,
    refusal: held.refusals[0].refusal,
    exact_kind: imports.edge_kind,
    both_anchored: [imports.from_code_mention_id, imports.to_code_mention_id],
    // Witness-locator anchoring: the repo and route endpoints join their exact candidates.
    route_edge_anchored: [exposes.from_code_mention_id, exposes.to_code_mention_id],
    external_status: external.status,
    external_to_anchor: external.to_code_mention_id,
    ambiguous_candidates: ambiguous.candidate_to_node_ids,
    witnesses_verbatim: imports.witnesses,
    report: [held.report.edges, held.report.relations, held.report.refusals,
      held.report.anchored_both, held.report.anchored_one],
  }, {
    conservation: 5,
    // relations = 4 merge-projected + 1 containment; anchored_both gains the containment pair.

    refusal: 'unknown_edge_status',
    exact_kind: 'imports',
    both_anchored: ['mention:module-1', 'mention:module-2'],
    route_edge_anchored: ['mention:repo-1', 'mention:route-1'],
    external_status: 'external',
    external_to_anchor: null,
    ambiguous_candidates: ['module:app:src/x.js', 'module:app:src/y.js'],
    witnesses_verbatim: [{ file: 'src/a.js', line: 3 }],
    report: [5, 5, 1, 3, 2],
  });
});

test('manifest envelope ownership preserves the extractor direction', () => {
  const flowCandidate = ({ file, owner, source, index }) => {
    const facts = envelopeExtractor.scan(source.trim().split('\n'), {
      repo: 'app', file,
      fact(kind, line, record) { return { kind, repo: 'app', file, line, ...record }; },
    }).filter(fact => fact.kind === 'envelope_flow');
    assert.equal(facts.length, 1);
    return { fact_id: `code-fact:envelope-${index}`, fact_kind: 'envelope_flow',
      record: { ...facts[0], owner }, mention: { mention_id: `mention:envelope-${index}` } };
  };
  const candidates = [
    { fact_id: 'code-fact:publisher-manifest', fact_kind: 'yaml_document',
      record: { repo: 'app', file: 'plugins/publisher/plugin.yaml', doc_name: 'publisher' },
      mention: { mention_id: 'mention:publisher-manifest' } },
    { fact_id: 'code-fact:subscriber-manifest', fact_kind: 'yaml_document',
      record: { repo: 'app', file: 'plugins/subscriber/plugin.yaml', doc_name: 'subscriber' },
      mention: { mention_id: 'mention:subscriber-manifest' } },
    flowCandidate({ file: 'plugins/publisher/plugin.yaml', owner: 'publisher', index: 1,
      source: 'publishes_envelopes:\n  - kind: work_order.accepted' }),
    flowCandidate({ file: 'plugins/subscriber/plugin.yaml', owner: 'subscriber', index: 2,
      source: 'subscribes_envelopes:\n  - kind: work_order.accepted' }),
  ];
  const held = buildCodeDependencyRelations({ merge_graph: { nodes: [], edges: [] },
    code_plane_head: codePlaneHead, identity_candidates: candidates });
  assert.deepEqual(held.relations.map(relation => [relation.from_node_id, relation.edge_kind])
    .sort((left, right) => left[0].localeCompare(right[0])), [
    ['plugin:app:publisher', 'publishes_envelope'],
    ['plugin:app:subscriber', 'subscribes_envelope'],
  ]);
});

test('[unified §5 firewall] traversability requires resolved status and receipt-backed referents on both endpoints', () => {
  const candidates = [moduleCandidate('app', 'src/a.js', 1), moduleCandidate('app', 'src/b.js', 2)];
  const held = buildCodeDependencyRelations({
    merge_graph: fixtureGraph(), code_plane_head: codePlaneHead, identity_candidates: candidates,
  });
  const fullResolutions = [
    { mention_id: 'mention:module-1', referent_id: 'referent:namespace:aa',
      resolution_receipt_id: 'resolution-receipt:aa' },
    { mention_id: 'mention:module-2', referent_id: 'referent:namespace:bb',
      resolution_receipt_id: 'resolution-receipt:bb' },
  ];
  const walkable = traversableRelations({ relations: held.relations,
    mention_resolutions: fullResolutions });
  assert.deepEqual({
    walkable: walkable.map(row => [row.edge_kind, row.from_referent_id, row.to_referent_id]),
    witnessed: walkable.map(row => [row.witnesses.length > 0, row.witnesses.every(w => w.file && Number.isInteger(w.line))]),
    half_resolved: traversableRelations({ relations: held.relations,
      mention_resolutions: fullResolutions.slice(0, 1) }).length,
    receiptless: traversableRelations({ relations: held.relations,
      mention_resolutions: fullResolutions.map(row => ({ ...row, resolution_receipt_id: null })) }).length,
    none: traversableRelations({ relations: held.relations, mention_resolutions: [] }).length,
  }, {
    // Only the resolved module-to-module import walks; external and ambiguous never do.
    walkable: [['imports', 'referent:namespace:aa', 'referent:namespace:bb']],
    witnessed: [[true, true]],
    half_resolved: 0,
    receiptless: 0,
    none: 0,
  });
});

test('a wildcard-expanded relation keeps its pattern so literal and derived flow facts stay distinguishable', () => {
  const candidates = [moduleCandidate('app', 'src/a.js', 1), moduleCandidate('app', 'src/b.js', 2)];
  const graph = { nodes: fixtureGraph().nodes, edges: [
    { id: 'imports:a-to-b', kind: 'imports', status: 'resolved',
      from: 'module:app:src/a.js', to: 'module:app:src/b.js', witnesses: [{ file: 'src/a.js', line: 3 }] },
    { id: 'consumes:wildcard', kind: 'consumes', status: 'resolved',
      from: 'module:app:src/a.js', to: 'module:app:src/b.js',
      resolution_kind: 'wildcard_subscription', match_pattern: 'brew.*',
      witnesses: [{ file: 'src/a.js', line: 9 }] },
  ] };
  const held = buildCodeDependencyRelations({
    merge_graph: graph, code_plane_head: codePlaneHead, identity_candidates: candidates,
  });
  const expanded = held.relations.find(row => row.source_edge_id === 'consumes:wildcard');
  const literal = held.relations.find(row => row.source_edge_id === 'imports:a-to-b');
  const walkable = traversableRelations({ relations: held.relations, mention_resolutions: [
    { mention_id: 'mention:module-1', referent_id: 'referent:namespace:aa', resolution_receipt_id: 'receipt:1' },
    { mention_id: 'mention:module-2', referent_id: 'referent:namespace:bb', resolution_receipt_id: 'receipt:2' },
  ] });
  assert.deepEqual({
    expanded: [expanded.resolution_kind, expanded.match_pattern],
    literalHasNone: 'resolution_kind' in literal,
    carried: walkable.find(row => row.edge_kind === 'consumes')?.match_pattern,
  }, { expanded: ['wildcard_subscription', 'brew.*'], literalHasNone: false, carried: 'brew.*' });
});

test('[falsifier: relation powerlessness] relation bytes carry no identity fields and mutating them cannot reach resolution', () => {
  const candidates = [moduleCandidate('app', 'src/a.js', 1), moduleCandidate('app', 'src/b.js', 2)];
  const held = buildCodeDependencyRelations({
    merge_graph: fixtureGraph(), code_plane_head: codePlaneHead, identity_candidates: candidates,
  });
  const relation = held.relations[0];
  assert.deepEqual({
    // The record's closed field set contains no basis, constraint, disposition, or key field:
    // nothing a resolver consumes. Identity intake is a separate closed constructor path.
    fields: Object.keys(relation).sort(),
    plane: relation.relation_plane,
  }, {
    fields: ['candidate_to_node_ids', 'code_plane_head', 'direction', 'edge_kind',
      'from_code_mention_id', 'from_fact_id', 'from_node_id', 'relation_id', 'relation_plane',
      'schema', 'source_edge_id', 'status', 'to_code_mention_id', 'to_fact_id', 'to_node_id',
      'witnesses'].sort(),
    plane: 'technical_dependency',
  });
});
