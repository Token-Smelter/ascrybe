import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1Concepts } from '../tools/ontology/concept-registry.mjs';
import {
  evaluateMembership, validateMembership, CONFIDENCE_POLICY_DIGEST,
} from '../tools/ontology/membership-evaluator.mjs';
import { OntologyError } from '../tools/ontology/schemas.mjs';

const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST });
const capabilityProvider = concepts.find(c => c.stable_key === 'capability-provider');
const unknownRealization = concepts.find(c => c.stable_key === 'unknown-realization-claim');

const context = { evidenceContextId: 'evidence-context:fixture', projectionId: 'estate-projection:fixture', generationId: 'estate-interpretation:fixture' };

function entitySubject(edges = {}) {
  return {
    node_id: 'referent:namespace:widget-router',
    record_digest: 'd'.repeat(64),
    view: { edges: { out: new Map(Object.entries(edges)), in: new Map() }, fields: {} },
    witnessMeta: null,
  };
}

function claimSubject(fields) {
  return {
    node_id: 'estate-claim:widget-router-claim',
    record_digest: 'e'.repeat(64),
    view: { edges: { out: new Map(), in: new Map() }, fields },
    witnessMeta: { claim_id: 'estate-claim:widget-router-claim', receipt_id: 'claim-adjudication-receipt:widget-router',
      source_path: 'design/widgets.md', source_line: 12 },
  };
}

test('evaluateMembership returns member with a certain-confidence projected_edge witness when a structural rule matches with a production witness', () => {
  const subject = entitySubject({ provides_capability: [{ to: 'capability:widget-service', to_kind: 'Capability', relation: 'provides_capability', edge_id: 'code-dependency-relation:1', record_digest: 'f'.repeat(64), from_fact_id: null, to_fact_id: null, source_witnesses: [{ repo: 'acme', file: 'src/widgetService.ts', line: 1, provenance_class: 'production' }] }] });
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject, ...context });
  assert.doesNotThrow(() => validateMembership(membership));
  assert.equal(membership.outcome, 'member');
  assert.equal(membership.confidence, 'certain');
  assert.equal(membership.witnesses[0].kind, 'projected_edge');
});

// Operator decision, 2026-09-26: an architectural role describes PRODUCTION architecture. A subject
// whose only matching evidence is test/fixture code is not_member, reason TEST_OR_FIXTURE_ONLY --
// but the witness is RETAINED, not deleted, so a reader can still see what structurally matched.
test('evaluateMembership downgrades a structural match to not_member/TEST_OR_FIXTURE_ONLY when every witness is test-or-fixture, retaining the witness', () => {
  const subject = entitySubject({ provides_capability: [{ to: 'capability:widget-service', to_kind: 'Capability', relation: 'provides_capability', edge_id: 'code-dependency-relation:1', record_digest: 'f'.repeat(64), from_fact_id: null, to_fact_id: null, source_witnesses: [{ repo: 'acme', file: 'test/widgetService.test.ts', line: 1, provenance_class: 'test' }] }] });
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject, ...context });
  assert.doesNotThrow(() => validateMembership(membership));
  assert.equal(membership.outcome, 'not_member');
  assert.equal(membership.evaluation.result, 'matched_scope_excluded');
  assert.equal(membership.evaluation.reason_code, 'TEST_OR_FIXTURE_ONLY');
  assert.equal(membership.witnesses.length, 1, 'the matched witness is retained, not deleted');
  assert.equal(membership.witnesses[0].kind, 'projected_edge');
});

test('evaluateMembership keeps member when at least one witness among several is production, even if others are test-only', () => {
  const subject = entitySubject({ provides_capability: [
    { to: 'capability:widget-service', to_kind: 'Capability', relation: 'provides_capability', edge_id: 'code-dependency-relation:1', record_digest: 'f'.repeat(64), from_fact_id: null, to_fact_id: null, source_witnesses: [{ repo: 'acme', file: 'test/widgetService.test.ts', line: 1, provenance_class: 'test' }] },
    { to: 'capability:widget-service-2', to_kind: 'Capability', relation: 'provides_capability', edge_id: 'code-dependency-relation:2', record_digest: 'a'.repeat(64), from_fact_id: null, to_fact_id: null, source_witnesses: [{ repo: 'acme', file: 'src/widgetService.ts', line: 5, provenance_class: 'production' }] },
  ] });
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject, ...context });
  assert.equal(membership.outcome, 'member');
  assert.equal(membership.witnesses.length, 2, 'both witnesses are retained regardless of provenance mix');
});

test('evaluateMembership abstains with INVENTORY_INCOMPLETE, not not_member, when an open-world structural rule finds nothing', () => {
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject: entitySubject(), ...context });
  assert.equal(membership.outcome, 'abstain');
  assert.equal(membership.evaluation.reason_code, 'INVENTORY_INCOMPLETE');
  assert.deepEqual(membership.witnesses, []);
  assert.equal(membership.confidence, null);
});

test('evaluateMembership returns not_member for a closed-world epistemic-standing rule when the observed field differs', () => {
  const membership = evaluateMembership({ conceptVersion: unknownRealization, subject: claimSubject({ realization: 'partial' }), ...context });
  assert.equal(membership.outcome, 'not_member');
  assert.equal(membership.witnesses[0].kind, 'claim');
});

test('evaluateMembership returns member with likely confidence for a closed-world rule matching a claim witness', () => {
  const membership = evaluateMembership({ conceptVersion: unknownRealization, subject: claimSubject({ realization: 'unknown' }), ...context });
  assert.equal(membership.outcome, 'member');
  assert.equal(membership.confidence, 'likely');
});

test('a claim witness carries the observed field value the rule actually read, not only opaque ids (CORRECTED: a bare id/source gave a held-out judge nothing to check)', () => {
  const membership = evaluateMembership({ conceptVersion: unknownRealization, subject: claimSubject({ realization: 'unknown' }), ...context });
  assert.equal(membership.witnesses[0].observed_fields.realization, 'unknown');
});

test('a projected_edge witness carries the target node\'s kind, not only its opaque id (CORRECTED: real held-out answers said "does not identify that fact as an HttpClientCall")', () => {
  const subject = entitySubject({ provides_capability: [{ to: 'capability:widget-service', to_kind: 'Capability', relation: 'provides_capability', edge_id: 'code-dependency-relation:1', record_digest: 'f'.repeat(64), from_fact_id: null, to_fact_id: null, source_witnesses: [] }] });
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject, ...context });
  assert.equal(membership.witnesses[0].to_kind, 'Capability');
});

test('evaluateMembership fails closed when the subject, context, or concept version is incomplete', () => {
  assert.throws(() => evaluateMembership({ conceptVersion: capabilityProvider, subject: entitySubject(), evidenceContextId: null, projectionId: 'p', generationId: 'g' }), OntologyError);
  assert.throws(() => evaluateMembership({ conceptVersion: {}, subject: entitySubject(), ...context }), OntologyError);
});

test('validateMembership fails closed on a tampered digest and on an abstain record without a reason_code', () => {
  const membership = evaluateMembership({ conceptVersion: capabilityProvider, subject: entitySubject(), ...context });
  assert.throws(() => validateMembership({ ...membership, evaluation: { ...membership.evaluation, reason_code: null } }), OntologyError);
  const lastChar = membership.membership_id.at(-1);
  const tampered = { ...membership, membership_id: `${membership.membership_id.slice(0, -1)}${lastChar === '0' ? '1' : '0'}` };
  assert.throws(() => validateMembership(tampered), OntologyError);
});
