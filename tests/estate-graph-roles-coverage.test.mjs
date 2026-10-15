import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_PLANE_REGISTRY, RELATION_REGISTRY, UNCLASSIFIED, nodePlane, relationRole,
  structuralEndpoints,
} from '../tools/estate-graph-roles.mjs';
import {
  ENTITY_KINDS, EXTRACTED_FACT_PROJECTION_ADDITIONS,
} from '../tools/estate-graph-projection.mjs';

// Producer/registry drift is exactly what let 23 emitted node kinds and the emitted declares_value
// relation go unclassified while every test stayed green: nothing compared what the projection can
// actually emit against what the roles registry declares. These two lists are derived from the
// same producer registries the projection builds nodes from, never hand-copied, so adding a kind
// to EXTRACTED_FACT_KINDS or ENTITY_KINDS without updating estate-graph-roles.mjs fails here.

test('every node kind an extracted fact can emit has an explicit, non-unclassified plane', () => {
  const unclassified = EXTRACTED_FACT_PROJECTION_ADDITIONS.node_kinds
    .filter(kind => nodePlane(kind) === UNCLASSIFIED);
  assert.deepEqual(unclassified, []);
});

test('every relation the extracted-fact path can emit, including declares_value, has a role', () => {
  const unclassified = EXTRACTED_FACT_PROJECTION_ADDITIONS.relation_names
    .filter(relation => relationRole(relation) === UNCLASSIFIED);
  assert.deepEqual(unclassified, []);
  assert.ok(EXTRACTED_FACT_PROJECTION_ADDITIONS.relation_names.includes('declares_value'));
});

test('every identity-resolved entity kind the code plane can emit has an explicit plane', () => {
  // entityKind() in estate-graph-projection.mjs also falls back to 'Plugin' and 'DeclaredDocument'
  // for yaml_document facts, and to 'Referent' for anything ENTITY_KINDS does not name.
  const emittable = new Set([...Object.values(ENTITY_KINDS), 'Plugin', 'DeclaredDocument', 'Referent']);
  const unclassified = [...emittable].filter(kind => nodePlane(kind) === UNCLASSIFIED);
  assert.deepEqual(unclassified, []);
});

test('declares_value has structural parent/child semantics, not merely a role', () => {
  assert.equal(relationRole('declares_value'), 'structural');
  assert.equal(RELATION_REGISTRY.declares_value.parent, 'from');
  assert.deepEqual(
    structuralEndpoints({ relation: 'declares_value', from: 'extracted-fact:x', to: 'literal-leaf:y' }),
    ['extracted-fact:x', 'literal-leaf:y'],
  );
});

test('a genuinely unclassified relation or kind is still projected and named, not hidden', () => {
  // The registry's own contract: absence is `unclassified`, not an error and not a silent guess.
  assert.equal(relationRole('an_invented_relation_no_registry_declares'), UNCLASSIFIED);
  assert.equal(nodePlane('AnInventedKindNoRegistryDeclares'), UNCLASSIFIED);
  assert.ok(!(('an_invented_relation_no_registry_declares' in RELATION_REGISTRY)));
  assert.ok(!(('AnInventedKindNoRegistryDeclares' in NODE_PLANE_REGISTRY)));
});
