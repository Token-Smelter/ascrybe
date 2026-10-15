import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1Concepts, validateConceptVersion, referencedRelations } from '../tools/ontology/concept-registry.mjs';
import { CONFIDENCE_POLICY_DIGEST } from '../tools/ontology/membership-evaluator.mjs';
import { OntologyError } from '../tools/ontology/schemas.mjs';

test('buildPhase1Concepts seals 8 architectural-role and 7 epistemic-standing concepts, each self-verifying', () => {
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST });
  assert.equal(concepts.filter(c => c.concept_kind === 'architectural-role').length, 8);
  assert.equal(concepts.filter(c => c.concept_kind === 'epistemic-standing').length, 7);
  concepts.forEach(concept => assert.doesNotThrow(() => validateConceptVersion(concept)));
  assert.equal(new Set(concepts.map(c => c.concept_id)).size, concepts.length);
});

test('capability-provider keeps accession AR-0001, matching the design walkthrough rather than the section 4a table order', () => {
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST });
  const ar1 = concepts.find(c => c.concept_id.endsWith(':AR-0001'));
  assert.equal(ar1.stable_key, 'capability-provider');
});

test('architectural-role concepts default to open-world abstention and epistemic-standing concepts to closed-world not_member', () => {
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST });
  for (const concept of concepts) {
    const expected = concept.concept_kind === 'architectural-role' ? 'open_world_abstain' : 'closed_world_not_member';
    assert.equal(concept.membership_rule.negative_semantics, expected, concept.concept_id);
  }
});

test('referencedRelations names exactly the relations the architectural-role rules use, including the registers_route correction and the synthesized owns_fact relation', () => {
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST })
    .filter(c => c.concept_kind === 'architectural-role');
  const relations = referencedRelations(concepts);
  for (const expected of ['provides_capability', 'exposes_route', 'registers_route', 'publishes_envelope',
    'emits', 'consumes', 'calls_capability', 'requires_capability', 'declares_table', 'owns_fact']) {
    assert.ok(relations.has(expected), `expected relation set to include ${expected}`);
  }
});

test('architectural-role concepts are eligible only for Module/Plugin/Referent, never the full entity-plane kind list', () => {
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST })
    .filter(c => c.concept_kind === 'architectural-role');
  for (const concept of concepts) {
    assert.deepEqual([...concept.scope.eligible_node_kinds].sort(), ['Module', 'Plugin', 'Referent']);
  }
});

test('buildPhase1Concepts fails closed without a policy digest', () => {
  assert.throws(() => buildPhase1Concepts({}), OntologyError);
});
