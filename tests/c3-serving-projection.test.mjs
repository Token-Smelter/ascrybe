import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectionVerificationDetail, buildRelationProjectionPolicy, buildServingProjection,
  compareServingContentDigests, ensureServingProjectionSchema, induceRelationGraph,
  NEO4J_PROJECTION_VERIFY_STATEMENT, Neo4jHttpClient, parseNeo4jConnectionTarget,
  planProjectionRetention, projectionIdsMatch,
  validateServingProjection, verifyRelationProjectionPolicy,
} from '../tools/c3-serving-projection.mjs';
import {
  buildC3IdentityFixture, buildC3SupersessionFixture,
} from '../tools/c3-fixture-producer.mjs';
import { sha256, stableCanonicalSha256, stableStringify } from '../tools/lib.mjs';

function fixtureState(which = 'final', overrides = {}) {
  const held = buildC3IdentityFixture();
  const selected = held[which];
  return {
    held,
    state: buildServingProjection({
      graph_commit_id: selected.commit.graph_commit_id,
      commit: selected.commit,
      records: selected.records,
      relation_policy: held.policy,
      ...overrides,
    }),
  };
}

test('connection target requires explicit credentials and an explicit HTTP origin', () => {
  for (const input of [
    {},
    { uri: 'http://127.0.0.1:9999', username: 'neo4j' },
    { uri: 'neo4j://127.0.0.1:9999', username: 'neo4j', password: 'held' },
    { uri: 'http://127.0.0.1', username: 'neo4j', password: 'held' },
    { uri: 'http://neo4j:held@127.0.0.1:9999', username: 'neo4j', password: 'held' },
  ]) assert.throws(() => parseNeo4jConnectionTarget(input), error =>
    ['EXPLICIT_NEO4J_CONNECTION_REQUIRED', 'INVALID_NEO4J_CONNECTION_TARGET'].includes(error.code));
  assert.equal(parseNeo4jConnectionTarget({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  }).origin, 'http://127.0.0.1:9999');
});

test('connection guard refuses both protected production ports', () => {
  assert.deepEqual(['http://127.0.0.1:7687', 'http://127.0.0.1:7474'].map(uri => {
    try { parseNeo4jConnectionTarget({ uri, username: 'neo4j', password: 'held' }); return null; }
    catch (error) { return error.code; }
  }), ['PROTECTED_NEO4J_PORT', 'PROTECTED_NEO4J_PORT']);
});

test('RelationProjectionPolicy identity freezes every policy field', () => {
  const { policy } = buildC3IdentityFixture();
  assert.equal(verifyRelationProjectionPolicy(policy), true);
  const changed = structuredClone(policy);
  changed.accepted_modalities = ['aspirational'];
  assert.throws(() => verifyRelationProjectionPolicy(changed),
    error => error.code === 'RELATION_POLICY_IDENTITY_MISMATCH');
});

test('C2 commit projects reified assertions with predicate, roled arguments, support, and drill-down metadata', () => {
  const { state } = fixtureState();
  const assertions = state.nodes.filter(node => node.kind === 'Assertion');
  const byType = Object.groupBy(state.edges, edge => edge.type);
  assert.deepEqual({
    assertions: assertions.length,
    predicates: byType.PREDICATE.length,
    arguments: byType.ARGUMENT.length,
    supports: byType.SUPPORTED_BY.length,
    resolutions: byType.RESOLVES_TO.length,
    exactResolutionReceipts: byType.RESOLVES_TO.every(edge => edge.properties.resolution_receipt_id
      && state.nodes.some(node => node.node_id === edge.properties.resolution_receipt_id)),
    exactRoles: [...new Set(byType.ARGUMENT.map(edge => edge.properties.role))].sort(),
    hasCommit: state.nodes.some(node => node.kind === 'GraphCommit'
      && node.node_id === state.graph_commit_id),
    referents: state.nodes.filter(node => node.kind === 'Referent').length,
    receipts: state.nodes.filter(node => node.kind.endsWith('Receipt')).length,
  }, {
    assertions: 2,
    predicates: 2,
    arguments: 4,
    supports: 2,
    resolutions: 4,
    exactResolutionReceipts: true,
    exactRoles: ['object', 'subject'],
    hasCommit: true,
    referents: 2,
    receipts: 4,
  });
});

test('resolved mentions traverse to Referents only through their exact resolution receipt', () => {
  const { state } = fixtureState();
  const missing = structuredClone(state);
  missing.edges.splice(missing.edges.findIndex(edge => edge.type === 'RESOLVES_TO'), 1);
  assert.throws(() => validateServingProjection(missing),
    error => error.code === 'MISSING_MENTION_RESOLUTION_EDGE');

  const forged = structuredClone(state);
  forged.edges.find(edge => edge.type === 'RESOLVES_TO').properties.resolution_receipt_id = 'receipt:invented';
  assert.throws(() => validateServingProjection(forged),
    error => error.code === 'MENTION_RESOLUTION_EDGE_MISMATCH');
});

test('Referent nodes reject every name, label, title, display, or preferred property', () => {
  const { state } = fixtureState();
  const named = structuredClone(state);
  named.nodes.find(node => node.kind === 'Referent').properties.display_label = 'Invented entity';
  assert.throws(() => validateServingProjection(named),
    error => error.code === 'REFERENT_DISPLAY_PROPERTY_FORBIDDEN');
});

test('REL edges are live and carry exact policy, assertion, commit, revision, and version metadata', () => {
  const { held, state } = fixtureState();
  assert.deepEqual(state.relations.map(relation => ({
    assertion: relation.assertion_id,
    predicate: relation.predicate_id,
    commit: relation.graph_commit_id,
    revision: relation.ontology_revision_id,
    version: relation.projection_version,
    policy: relation.policy_id,
  })).sort((left, right) => left.assertion.localeCompare(right.assertion)),
  [held.first_assertion_id, held.second_assertion_id].sort().map(assertionId => {
    const relation = state.relations.find(row => row.assertion_id === assertionId);
    return {
      assertion: assertionId,
      predicate: relation.predicate_id,
      commit: state.graph_commit_id,
      revision: 'ontology-revision:c3-identity-fixture',
      version: state.projection_version,
      policy: held.policy.policy_id,
    };
  }));
});

test('REL without a selected assertion fails closed', () => {
  const held = buildC3IdentityFixture();
  assert.throws(() => buildServingProjection({
    graph_commit_id: held.final.commit.graph_commit_id,
    commit: held.final.commit,
    records: held.final.records,
    relation_policy: held.policy,
    relation_requests: [{ reference_id: 'reference:missing', assertion_id: 'assertion:missing' }],
  }), error => error.code === 'REL_SELECTED_ASSERTION_MISSING');
});

test('REL that violates the frozen policy fails closed', () => {
  const held = buildC3IdentityFixture();
  const restrictive = buildRelationProjectionPolicy({
    ...held.policy,
    eligible_predicate_concept_ids: ['concept:not-selected'],
  });
  assert.throws(() => buildServingProjection({
    graph_commit_id: held.final.commit.graph_commit_id,
    commit: held.final.commit,
    records: held.final.records,
    relation_policy: restrictive,
    relation_requests: [{
      reference_id: 'reference:policy-rejected', assertion_id: held.first_assertion_id,
    }],
  }), error => error.code === 'REL_POLICY_REJECTED' && error.detail.policy_field === 'predicate');
});

test('REL reconciliation asks C1 for the selected supersession tip before policy evaluation', () => {
  const held = buildC3SupersessionFixture();
  const policy = buildC3IdentityFixture().policy;
  assert.throws(() => buildServingProjection({
    graph_commit_id: held.selected.commit.graph_commit_id,
    commit: held.selected.commit,
    records: held.selected.records,
    relation_policy: policy,
    relation_requests: [{
      reference_id: 'reference:superseded', assertion_id: held.requested_assertion_id,
    }],
    supersession_ledger: held.ledger,
  }), error => error.code === 'REL_POLICY_REJECTED'
    && error.detail.requested_assertion_id === held.requested_assertion_id
    && error.detail.selected_tip_assertion_id === held.selected_tip_assertion_id);
});

test('REL reconciliation receipts name exactly one selected assertion per fixture edge', () => {
  const { state } = fixtureState();
  assert.deepEqual(state.relation_reconciliation_receipts.map(receipt => ({
    disposition: receipt.disposition,
    selected: receipt.selected_assertion_ids.length,
    referenced: state.relations.some(relation => relation.reconciliation_receipt_id === receipt.receipt_id),
  })), [
    { disposition: 'exact_selected_assertion', selected: 1, referenced: true },
    { disposition: 'exact_selected_assertion', selected: 1, referenced: true },
  ]);
});

test('excluded assertion or endpoint removes a previously live REL from traversal and transition mass', () => {
  const { state } = fixtureState();
  const live = induceRelationGraph(state);
  assert.equal(live.relations.length, 2);
  const relation = state.relations[0];
  const byAssertion = induceRelationGraph(state, {
    excluded_assertion_ids: [relation.assertion_id],
  });
  const byEndpoint = induceRelationGraph(state, {
    excluded_referent_ids: [relation.subject_referent_id],
  });
  assert.deepEqual({
    assertionTraversable: byAssertion.traversable_relation_ids.includes(relation.relation_id),
    endpointTraversable: byEndpoint.traversable_relation_ids.includes(relation.relation_id),
    endpointAbsorbsMass: byEndpoint.transition_mass_recipients.includes(relation.subject_referent_id),
  }, { assertionTraversable: false, endpointTraversable: false, endpointAbsorbsMass: false });
});

test('serving digest is stable across record order and streaming stays byte-compatible', () => {
  const held = buildC3IdentityFixture();
  const input = {
    graph_commit_id: held.final.commit.graph_commit_id,
    commit: held.final.commit,
    relation_policy: held.policy,
  };
  const forward = buildServingProjection({ ...input, records: held.final.records });
  const reverse = buildServingProjection({ ...input, records: held.final.records.slice().reverse() });
  const { content_digest: _digest, ...body } = forward;
  const priorDigest = sha256(stableStringify(body).trim());
  assert.deepEqual({
    order_stable: compareServingContentDigests(forward.content_digest, reverse.content_digest),
    prior_serializer: forward.content_digest === priorDigest,
    streaming_serializer: stableCanonicalSha256(body) === priorDigest,
  }, { order_stable: true, prior_serializer: true, streaming_serializer: true });
});

test('projection validation detects content mutation, access omission, dangling edges, and unreconciled REL assertions', () => {
  const { state } = fixtureState();
  const content = structuredClone(state);
  content.nodes[0].properties.changed = true;
  assert.throws(() => validateServingProjection(content),
    error => error.code === 'SERVING_CONTENT_DIGEST_MISMATCH');
  const access = structuredClone(state);
  access.nodes.find(node => node.kind === 'Referent').kind = 'EvidencePointer';
  assert.throws(() => validateServingProjection(access),
    error => error.code === 'PROJECTION_ACCESS_METADATA_MISSING');
  const dangling = structuredClone(state);
  dangling.edges[0].to = 'node:absent';
  assert.throws(() => validateServingProjection(dangling),
    error => error.code === 'PROJECTION_DANGLING_REFERENCE');
  const unreconciled = structuredClone(state);
  const relation = unreconciled.relations[0];
  const receipt = unreconciled.relation_reconciliation_receipts
    .find(row => row.receipt_id === relation.reconciliation_receipt_id);
  relation.assertion_id = receipt.receipt_id;
  relation.assertion_ids = [receipt.receipt_id];
  receipt.selected_assertion_ids = [receipt.receipt_id];
  assert.throws(() => validateServingProjection(unreconciled),
    error => error.code === 'REL_RECONCILIATION_MISMATCH');
});

test('zero-REL verification excludes the OPTIONAL MATCH null sentinel', () => {
  assert.match(NEO4J_PROJECTION_VERIFY_STATEMENT,
    /r IS NOT NULL AND \(r\.assertion_id IS NULL/u);
});

test('projection schema setup creates and awaits every required index before returning', async () => {
  const client = new Neo4jHttpClient({
    uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held',
  });
  const statements = [];
  client.query = async statement => { statements.push(statement); return []; };
  const setup = await ensureServingProjectionSchema(client);
  assert.deepEqual({
    names: setup.names,
    creates: statements.filter(statement => statement.startsWith('CREATE')).length,
    awaitedLast: statements.at(-1),
  }, {
    names: ['c3head_slot_unique', 'c3node_projection_node', 'c3receipt_id'],
    creates: 3,
    awaitedLast: 'CALL db.awaitIndexes(300)',
  });
});

test('projection ID verification rejects same-count substitutions and duplicates', () => {
  assert.deepEqual([
    projectionIdsMatch(['a', 'b'], ['b', 'a']),
    projectionIdsMatch(['a', 'b'], ['a', 'c']),
    projectionIdsMatch(['a', 'b'], ['a', 'a']),
  ], [true, false, false]);
});

test('verification divergence reports category counts and bounded offending IDs', () => {
  const { state } = fixtureState();
  const missing = state.nodes[0];
  const detail = buildProjectionVerificationDetail({
    state,
    actual_nodes: [
      ...state.nodes.slice(1).map(node => ({ node_id: node.node_id, kind: node.kind })),
      { node_id: 'unexpected:node', kind: 'Unexpected' },
    ],
    actual_edges: [],
  });
  assert.deepEqual({
    expectedKinds: detail.expected_counts.nodes_by_kind,
    actualUnexpected: detail.actual_counts.nodes_by_kind.Unexpected,
    missingNode: detail.offending_ids.missing_node_ids,
    unexpectedNode: detail.offending_ids.unexpected_node_ids,
    boundedEdges: detail.offending_ids.missing_edge_ids.length <= detail.sample_limit,
  }, {
    expectedKinds: Object.fromEntries(Object.entries(Object.groupBy(state.nodes, node => node.kind))
      .map(([kind, nodes]) => [kind, nodes.length]).sort(([left], [right]) => left.localeCompare(right))),
    actualUnexpected: 1,
    missingNode: [missing.node_id],
    unexpectedNode: ['unexpected:node'],
    boundedEdges: true,
  });
});

test('retention keeps the selected projection and one superseded ancestor', () => {
  const plan = planProjectionRetention({
    selected_projection_id: 'projection:current',
    retain_superseded: 1,
    receipts: [
      { projection_id: 'projection:current', previous_projection_id: 'projection:prior' },
      { projection_id: 'projection:prior', previous_projection_id: 'projection:old' },
      { projection_id: 'projection:old', previous_projection_id: null },
    ],
  });
  assert.deepEqual(plan, {
    selected_projection_id: 'projection:current',
    retain_superseded: 1,
    kept_projection_ids: ['projection:current', 'projection:prior'],
    prunable_projection_ids: ['projection:old'],
  });
});
