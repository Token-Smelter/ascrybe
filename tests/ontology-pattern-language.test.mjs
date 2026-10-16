import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpression, evaluateExpression, expressionDigest, MAX_EXPRESSION_DEPTH } from '../tools/ontology/pattern-language.mjs';
import { OntologyError } from '../tools/ontology/schemas.mjs';

function subjectView({ out = {}, fields = {} } = {}) {
  return {
    edges: { out: new Map(Object.entries(out)), in: new Map() },
    fields,
  };
}

test('validateExpression accepts every leaf and combinator shape the language defines', () => {
  const expression = {
    and: [
      { edge_exists: { direction: 'out', relation: 'exposes_route', target_kind: 'Route' } },
      { or: [
        { fact_kind_present: { kind: 'HttpClientCall' } },
        { field_equals: { field: 'claim_kind', value: 'current_capability' } },
        { field_in: { field: 'supporting_evidence_tiers', values: ['declared', 'executed'] } },
      ] },
      { not: { field_set_equals: { field: 'supporting_evidence_tiers', values: ['documentary'] } } },
    ],
  };
  assert.doesNotThrow(() => validateExpression(expression));
});

test('validateExpression fails closed on a malformed leaf, an unrecognized operator, and excess depth', () => {
  assert.throws(() => validateExpression({ edge_exists: { direction: 'sideways', relation: 'consumes' } }), OntologyError);
  assert.throws(() => validateExpression({ edge_exists: { direction: 'out' } }), OntologyError);
  assert.throws(() => validateExpression({ field_equals: { field: 'Claim_Kind', value: 'x' } }), OntologyError);
  assert.throws(() => validateExpression({ field_set_equals: { field: 'tiers', values: [] } }), OntologyError);
  assert.throws(() => validateExpression({ xor: [{ edge_exists: { direction: 'out', relation: 'emits' } }] }), OntologyError);
  assert.throws(() => validateExpression({ edge_exists: { direction: 'out', relation: 'emits' }, extra: 1 }), OntologyError);
  let deep = { edge_exists: { direction: 'out', relation: 'emits' } };
  for (let i = 0; i <= MAX_EXPRESSION_DEPTH; i += 1) deep = { not: deep };
  assert.throws(() => validateExpression(deep), OntologyError);
});

test('evaluateExpression matches an edge_exists leaf and carries the matching adjacency record as a witness', () => {
  const view = subjectView({ out: { exposes_route: [{ to: 'route:1', to_kind: 'Route', edge_id: 'e:1' }] } });
  const { matched, trace } = evaluateExpression({ edge_exists: { direction: 'out', relation: 'exposes_route', target_kind: 'Route' } }, view);
  assert.equal(matched, true);
  assert.equal(trace.length, 1);
  assert.deepEqual(trace[0].matches, [{ to: 'route:1', to_kind: 'Route', edge_id: 'e:1' }]);
});

test('evaluateExpression treats field_set_equals as exact set equality, not a subset or a superset match', () => {
  const supersetView = subjectView({ fields: { tiers: ['documentary', 'declared'] } });
  const subsetView = subjectView({ fields: { tiers: [] } });
  const exactView = subjectView({ fields: { tiers: ['documentary'] } });
  const expression = { field_set_equals: { field: 'tiers', values: ['documentary'] } };
  assert.equal(evaluateExpression(expression, supersetView).matched, false);
  assert.equal(evaluateExpression(expression, subsetView).matched, false);
  assert.equal(evaluateExpression(expression, exactView).matched, true);
});

test('evaluateExpression combines and/or/not with two-valued logic over multiple leaves', () => {
  const routeOnly = subjectView({ out: { exposes_route: [{ to: 'r', to_kind: 'Route', edge_id: 'e1' }] } });
  const routeAndEnvelope = subjectView({ out: {
    exposes_route: [{ to: 'r', to_kind: 'Route', edge_id: 'e1' }],
    emits: [{ to: 'env', to_kind: 'Envelope', edge_id: 'e2' }],
  } });
  const composite = {
    and: [
      { edge_exists: { direction: 'out', relation: 'exposes_route', target_kind: 'Route' } },
      { or: [{ edge_exists: { direction: 'out', relation: 'publishes_envelope' } }, { edge_exists: { direction: 'out', relation: 'emits' } }] },
    ],
  };
  assert.equal(evaluateExpression(composite, routeOnly).matched, false);
  assert.equal(evaluateExpression(composite, routeAndEnvelope).matched, true);
  assert.equal(evaluateExpression({ not: composite }, routeOnly).matched, true);
});

test('expressionDigest is stable across key order and rejects an invalid expression', () => {
  const a = { edge_exists: { relation: 'emits', direction: 'out' } };
  const b = { edge_exists: { direction: 'out', relation: 'emits' } };
  assert.equal(expressionDigest(a), expressionDigest(b));
  assert.throws(() => expressionDigest({ nope: {} }), OntologyError);
});
