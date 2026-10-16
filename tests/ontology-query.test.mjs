import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import {
  OntologyQueries, OntologyQueryError, ontologyQuerySurfaceContract,
} from '../tools/ontology/ontology-query.mjs';

function fakeClient() {
  return new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
}

const GENERATION_ROW = [
  'estate-interpretation:aaa', 'selected', 'estate-projection:widgets', 'evidence-context:widgets',
  'e'.repeat(64), 'p'.repeat(64), 'r'.repeat(64), 'h'.repeat(64),
];

function membershipRowFixture(overrides = {}) {
  const base = {
    membership_id: 'ontology-membership:widget-1', concept_id: 'ontology-concept:ascrybe:AR-0001',
    concept_version_id: 'v1', subject_projection_id: 'estate-projection:widgets',
    subject_node_id: 'referent:namespace:widget-router', subject_record_digest: 'd'.repeat(64),
    outcome: 'member', method: 'deterministic_rule', confidence: 'certain', reason_code: null,
    evaluation_json: JSON.stringify({ result: 'matched' }), witnesses_json: JSON.stringify([{ kind: 'projected_edge' }]),
    witness_provenance_json: JSON.stringify({ production: 1 }), defeaters_json: JSON.stringify([]),
    ...overrides,
  };
  return [base.membership_id, base.concept_id, base.concept_version_id, base.subject_projection_id,
    base.subject_node_id, base.subject_record_digest, base.outcome, base.method, base.confidence,
    base.reason_code, base.evaluation_json, base.witnesses_json, base.witness_provenance_json, base.defeaters_json];
}

test('ontologyQuerySurfaceContract is deterministic and covers every design v2 section 9 command', () => {
  const a = ontologyQuerySurfaceContract();
  const b = ontologyQuerySurfaceContract();
  assert.equal(a.digest, b.digest);
  for (const command of ['members', 'concepts-of', 'why', 'conflicts', 'drift', 'generalization-report']) {
    assert.ok(command in a.commands, `missing command ${command}`);
  }
});

test('OntologyQueries requires an explicit Neo4jHttpClient instance', () => {
  assert.throws(() => new OntologyQueries({ client: {} }), OntologyQueryError);
});

test('members refuses a base/interpretation mismatch (design v2 section 9)', async () => {
  const client = fakeClient();
  client.query = async () => [GENERATION_ROW];
  const queries = new OntologyQueries({ client });
  await assert.rejects(
    () => queries.members({ interpretation_id: 'estate-interpretation:aaa', concept_id: 'ontology-concept:ascrybe:AR-0001',
      expected_base_projection_id: 'estate-projection:some-other-projection' }),
    error => error instanceof OntologyQueryError && error.code === 'ONTOLOGY_QUERY_BASE_MISMATCH',
  );
});

test('members refuses when the interpretation is not staged', async () => {
  const client = fakeClient();
  client.query = async () => [];
  const queries = new OntologyQueries({ client });
  await assert.rejects(
    () => queries.members({ interpretation_id: 'estate-interpretation:missing', concept_id: 'ontology-concept:ascrybe:AR-0001' }),
    error => error instanceof OntologyQueryError && error.code === 'ONTOLOGY_QUERY_GENERATION_MISSING',
  );
});

test('members returns membership rows and filters by min_confidence', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) return [GENERATION_ROW];
    if (statement.includes('MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id})')) {
      return [
        membershipRowFixture({ confidence: 'certain' }),
        membershipRowFixture({ membership_id: 'ontology-membership:widget-2', confidence: 'plausible' }),
      ];
    }
    return [];
  };
  const queries = new OntologyQueries({ client });
  const all = await queries.members({ interpretation_id: 'estate-interpretation:aaa', concept_id: 'ontology-concept:ascrybe:AR-0001' });
  assert.equal(all.data.length, 2);
  assert.equal(all.generation.interpretation_id, 'estate-interpretation:aaa');
  const certainOnly = await queries.members({ interpretation_id: 'estate-interpretation:aaa', concept_id: 'ontology-concept:ascrybe:AR-0001', min_confidence: 'certain' });
  assert.equal(certainOnly.data.length, 1);
  assert.equal(certainOnly.data[0].confidence, 'certain');
});

test('members refuses an unrecognized min_confidence value', async () => {
  const client = fakeClient();
  client.query = async statement => (statement.includes('InterpretationGeneration') ? [GENERATION_ROW] : []);
  const queries = new OntologyQueries({ client });
  await assert.rejects(
    () => queries.members({ interpretation_id: 'estate-interpretation:aaa', concept_id: 'ontology-concept:ascrybe:AR-0001', min_confidence: 'somewhat' }),
    error => error instanceof OntologyQueryError && error.code === 'ONTOLOGY_QUERY_CONFIDENCE_INVALID',
  );
});

test('conceptsOf returns every concept a subject holds a membership for', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) return [GENERATION_ROW];
    if (statement.includes('subject_node_id: $node_id')) return [
      membershipRowFixture({ concept_id: 'ontology-concept:ascrybe:AR-0001' }),
      membershipRowFixture({ membership_id: 'ontology-membership:widget-1-b', concept_id: 'ontology-concept:ascrybe:AR-0002', outcome: 'not_member' }),
    ];
    return [];
  };
  const queries = new OntologyQueries({ client });
  const result = await queries.conceptsOf({ interpretation_id: 'estate-interpretation:aaa', node_id: 'referent:namespace:widget-router' });
  assert.deepEqual(result.data.map(row => [row.concept_id, row.outcome]),
    [['ontology-concept:ascrybe:AR-0001', 'member'], ['ontology-concept:ascrybe:AR-0002', 'not_member']]);
});

test('why returns one membership by id, parsing its JSON-encoded fields back into objects', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) return [GENERATION_ROW];
    if (statement.includes('membership_id: $membership_id')) return [membershipRowFixture()];
    return [];
  };
  const queries = new OntologyQueries({ client });
  const result = await queries.why({ interpretation_id: 'estate-interpretation:aaa', membership_id: 'ontology-membership:widget-1' });
  assert.deepEqual(result.data.evaluation, { result: 'matched' });
  assert.deepEqual(result.data.witnesses, [{ kind: 'projected_edge' }]);
});

test('why refuses an absent membership id', async () => {
  const client = fakeClient();
  client.query = async statement => (statement.includes('InterpretationGeneration') ? [GENERATION_ROW] : []);
  const queries = new OntologyQueries({ client });
  await assert.rejects(
    () => queries.why({ interpretation_id: 'estate-interpretation:aaa', membership_id: 'ontology-membership:missing' }),
    error => error instanceof OntologyQueryError && error.code === 'ONTOLOGY_QUERY_MEMBERSHIP_MISSING',
  );
});

test('conflicts returns only contested memberships', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) return [GENERATION_ROW];
    if (statement.includes("confidence: 'contested'")) return [membershipRowFixture({ confidence: 'contested', defeaters_json: JSON.stringify([{ kind: 'x' }]) })];
    return [];
  };
  const queries = new OntologyQueries({ client });
  const result = await queries.conflicts({ interpretation_id: 'estate-interpretation:aaa', concept_id: 'ontology-concept:ascrybe:AR-0001' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].confidence, 'contested');
});

test('drift attributes cause to a concept-version change over a policy or source change', async () => {
  const client = fakeClient();
  client.query = async (statement, parameters) => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) {
      return [parameters.interpretation_id === 'estate-interpretation:a'
        ? GENERATION_ROW
        : ['estate-interpretation:b', 'selected', 'estate-projection:widgets', 'evidence-context:widgets', 'e'.repeat(64), 'p'.repeat(64), 'r'.repeat(64), 'h2'.repeat(32)]];
    }
    if (statement.includes('MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id})')) {
      return parameters.interpretation_id === 'estate-interpretation:a'
        ? [['referent:namespace:widget-router', 'member', 'v1']]
        : [['referent:namespace:widget-router', 'member', 'v2']];
    }
    return [];
  };
  const queries = new OntologyQueries({ client });
  const result = await queries.drift({ concept_id: 'ontology-concept:ascrybe:AR-0001', interpretation_id_a: 'estate-interpretation:a', interpretation_id_b: 'estate-interpretation:b' });
  assert.equal(result.cause, 'definition');
});

test('drift reports which nodes changed outcome between two interpretations', async () => {
  const client = fakeClient();
  client.query = async (statement, parameters) => {
    if (statement.includes('MATCH (g:InterpretationGeneration')) return [GENERATION_ROW];
    if (statement.includes('MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id})')) {
      return parameters.interpretation_id === 'estate-interpretation:a'
        ? [['referent:namespace:widget-router', 'member', 'v1'], ['referent:namespace:widget-idle', 'abstain', 'v1']]
        : [['referent:namespace:widget-router', 'not_member', 'v1']];
    }
    return [];
  };
  const queries = new OntologyQueries({ client });
  const result = await queries.drift({ concept_id: 'ontology-concept:ascrybe:AR-0001', interpretation_id_a: 'estate-interpretation:a', interpretation_id_b: 'estate-interpretation:b' });
  assert.equal(result.cause, 'evidence');
  assert.equal(result.changed_count, 2);
  const byNode = Object.fromEntries(result.data.map(row => [row.node_id, row]));
  assert.deepEqual(byNode['referent:namespace:widget-router'], { node_id: 'referent:namespace:widget-router', outcome_a: 'member', outcome_b: 'not_member', changed: true });
  assert.deepEqual(byNode['referent:namespace:widget-idle'], { node_id: 'referent:namespace:widget-idle', outcome_a: 'abstain', outcome_b: null, changed: true });
});

test('generalizationReport always refuses -- Phase 1/2 computes no generalizations by design', async () => {
  const client = fakeClient();
  client.query = async () => { throw new Error('must not touch the database'); };
  const queries = new OntologyQueries({ client });
  await assert.rejects(
    () => queries.generalizationReport({ generalization_id: 'anything' }),
    error => error instanceof OntologyQueryError && error.code === 'ONTOLOGY_QUERY_NO_GENERALIZATIONS',
  );
});
