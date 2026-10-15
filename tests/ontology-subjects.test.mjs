import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnershipAdjacency, mergeAdjacency } from '../tools/ontology/subjects.mjs';

function fact(kind, nodeId, path, overrides = {}) {
  return { kind, node_id: nodeId, record_digest: `${nodeId}-digest`, repository: 'example-estate',
    file: path.split('/').slice(1).join('/'), line: 7, ...overrides };
}

test('buildOwnershipAdjacency resolves an owner only when exactly one entity subject claims the fact\'s exact path', () => {
  const entitySubjects = [
    { node_id: 'module:owned', kind: 'Module', namespace: 'example-estate/src/widgets/owned.mjs' },
    { node_id: 'module:unrelated', kind: 'Module', namespace: 'example-estate/src/widgets/unrelated.mjs' },
  ];
  const ownableFactsByPath = new Map([
    ['example-estate/src/widgets/owned.mjs', [fact('HttpClientCall', 'fact:owned-1', 'example-estate/src/widgets/owned.mjs')]],
  ]);
  const { adjacency, ownedFacts, ambiguousPaths, unownedPaths } = buildOwnershipAdjacency({ entitySubjects, ownableFactsByPath });
  assert.equal(ownedFacts, 1);
  assert.equal(ambiguousPaths, 0);
  assert.equal(unownedPaths, 0);
  const entries = adjacency.get('module:owned').get('owns_fact');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resolution, 'file_path_owner_match');
  assert.equal(entries[0].to, 'fact:owned-1');
});

test('buildOwnershipAdjacency abstains from resolving an ambiguous (multi-owner) or an unowned path', () => {
  const entitySubjects = [
    { node_id: 'module:a', kind: 'Module', namespace: 'example-estate/src/widgets/shared.mjs' },
    { node_id: 'module:b', kind: 'Plugin', namespace: 'example-estate/src/widgets/shared.mjs' },
  ];
  const ownableFactsByPath = new Map([
    ['example-estate/src/widgets/shared.mjs', [fact('ConfiguredUrl', 'fact:ambiguous-1', 'example-estate/src/widgets/shared.mjs')]],
    ['example-estate/src/widgets/orphan.mjs', [fact('SqliteTable', 'fact:orphan-1', 'example-estate/src/widgets/orphan.mjs')]],
  ]);
  const { adjacency, ownedFacts, ambiguousPaths, unownedPaths } = buildOwnershipAdjacency({ entitySubjects, ownableFactsByPath });
  assert.equal(ownedFacts, 0);
  assert.equal(ambiguousPaths, 1);
  assert.equal(unownedPaths, 1);
  assert.equal(adjacency.size, 0);
});

test('mergeAdjacency adds a synthesized relation bucket alongside a real one without clobbering it', () => {
  const real = new Map([['module:a', new Map([['provides_capability', [{ to: 'cap:1' }]]])]]);
  const synthetic = new Map([['module:a', new Map([['owns_fact', [{ to: 'fact:1' }]]])]]);
  mergeAdjacency(real, synthetic);
  assert.deepEqual(real.get('module:a').get('provides_capability'), [{ to: 'cap:1' }]);
  assert.deepEqual(real.get('module:a').get('owns_fact'), [{ to: 'fact:1' }]);
});
