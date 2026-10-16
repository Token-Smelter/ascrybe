import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stratifiedSample, buildLabelingPacket, buildLabelingPrompt, parseLabelResponse, compareLabel,
  summarizeComparisons, wilsonInterval,
} from '../tools/ontology/held-out-evaluation.mjs';
import { OntologyError } from '../tools/ontology/schemas.mjs';

function membership(conceptId, outcome, id, witnesses = []) {
  return { membership_id: `ontology-membership:${id}`, concept_id: conceptId, outcome, witnesses,
    subject_ref: { projection_id: 'estate-projection:fixture', node_id: `subject:${id}` } };
}

test('stratifiedSample takes up to perStratum items per (concept, outcome) and is stable for a fixed seed', () => {
  const memberships = [
    membership('AR-0001', 'member', '1'), membership('AR-0001', 'member', '2'), membership('AR-0001', 'member', '3'),
    membership('AR-0001', 'abstain', '4'),
  ];
  const first = stratifiedSample(memberships, { perStratum: 2, seed: 'fixed' });
  const second = stratifiedSample(memberships, { perStratum: 2, seed: 'fixed' });
  assert.equal(first.filter(m => m.outcome === 'member').length, 2);
  assert.equal(first.filter(m => m.outcome === 'abstain').length, 1);
  assert.deepEqual(first.map(m => m.membership_id), second.map(m => m.membership_id));
});

test('stratifiedSample fails closed on a non-positive perStratum', () => {
  assert.throws(() => stratifiedSample([], { perStratum: 0 }), OntologyError);
});

test('buildLabelingPacket carries the concept and witnesses but never the mechanical outcome, confidence, or trace', () => {
  const concept = { concept_id: 'AR-0001', stable_key: 'capability-provider', preferred_label: 'Capability provider',
    definition: 'An estate entity from which at least one projected provides_capability relation originates.',
    does_not_claim: 'that the capability works' };
  const held = { ...membership('AR-0001', 'member', '1', [{ kind: 'projected_edge', edge_id: 'e1', relation: 'provides_capability' }]),
    confidence: 'certain', evaluation: { result: 'matched', trace: [{ clause: 'out provides_capability', result: true }] } };
  const packet = buildLabelingPacket(concept, held);
  assert.equal('outcome' in packet, false);
  assert.equal('confidence' in packet, false);
  assert.equal('evaluation' in packet, false);
  const prompt = buildLabelingPrompt(packet);
  assert.ok(prompt.includes('provides_capability'));
  assert.ok(prompt.includes(concept.does_not_claim));
});

test('buildLabelingPrompt names the subject node_id (CORRECTED: it built subject_ref into the packet and then never rendered it)', () => {
  const concept = { concept_id: 'AR-0002', stable_key: 'route-handler', preferred_label: 'Route handler',
    definition: 'An estate entity from which at least one projected exposes_route relation originates.',
    does_not_claim: 'reachability in a live deployment' };
  const held = membership('AR-0002', 'member', '1', [
    { kind: 'projected_edge', edge_id: 'e1', relation: 'exposes_route', from: 'subject:1', to: 'route:1' },
  ]);
  const prompt = buildLabelingPrompt(buildLabelingPacket(concept, held));
  assert.ok(prompt.includes('subject:1'));
});

test('parseLabelResponse fails closed on malformed JSON and on an outcome outside the closed vocabulary', () => {
  assert.throws(() => parseLabelResponse('not json'), OntologyError);
  assert.throws(() => parseLabelResponse('{"outcome":"yes","reason":"because"}'), OntologyError);
  assert.throws(() => parseLabelResponse('{"outcome":"member"}'), OntologyError);
  assert.deepEqual(parseLabelResponse('{"outcome":"abstain","reason":"insufficient evidence"}'),
    { outcome: 'abstain', reason: 'insufficient evidence' });
});

test('compareLabel and summarizeComparisons report agreement rate without treating either side as ground truth', () => {
  const agreeing = compareLabel(membership('AR-0001', 'member', '1'), { outcome: 'member', reason: 'matches' });
  const disagreeing = compareLabel(membership('AR-0001', 'member', '2'), { outcome: 'abstain', reason: 'insufficient' });
  const summary = summarizeComparisons([agreeing, disagreeing]);
  assert.equal(summary['AR-0001'].total, 2);
  assert.equal(summary['AR-0001'].agreement_rate, 0.5);
  assert.equal(summary['AR-0001'].by_mechanical_outcome.member.agreement_rate, 0.5);
  assert.equal(summary['AR-0001'].confidence_interval_95.method, 'wilson-95');
});

test('wilsonInterval widens as the sample shrinks and always contains the observed rate', () => {
  const small = wilsonInterval(8, 10);
  const large = wilsonInterval(80, 100);
  assert.ok((small.upper - small.lower) > (large.upper - large.lower));
  assert.ok(small.lower <= 0.8 && 0.8 <= small.upper);
});

test('wilsonInterval fails closed on an impossible successes/total pair', () => {
  assert.throws(() => wilsonInterval(5, 3), OntologyError);
  assert.throws(() => wilsonInterval(1, 0), OntologyError);
});
