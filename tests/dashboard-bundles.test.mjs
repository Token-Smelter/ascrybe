import test from 'node:test';
import assert from 'node:assert/strict';
import { bundlesFor } from '../dashboard/bundles.js';

test('a bundle is drawn only for the residual the returned rows did not already show', () => {
  const payload = {
    node: { id: 'plugin:one' },
    neighbors: [
      { edge: { relation: 'provides_capability', from: 'plugin:one', to: 'capability:a' }, node: { id: 'capability:a', kind: 'Capability' } },
      { edge: { relation: 'provides_capability', from: 'plugin:one', to: 'capability:b' }, node: { id: 'capability:b', kind: 'Capability' } },
      { edge: { relation: 'contains', from: 'commit:one', to: 'plugin:one' }, node: { id: 'commit:one', kind: 'SourceCommit' } },
    ],
    bundles: [
      { role: 'structural', relation: 'provides_capability', direction: 'out', kind: 'Capability', count: 13 },
      { role: 'structural', relation: 'contains', direction: 'in', kind: 'SourceCommit', count: 1 },
      { role: 'annotation', relation: 'documented_in', direction: 'in', kind: 'Document', count: 74 },
      { role: 'annotation', relation: 'identifies', direction: 'in', kind: 'CodeFact', count: null },
    ],
  };
  assert.deepEqual(bundlesFor(payload).map(bundle => [bundle.relation, bundle.count, bundle.owner]), [
    ['provides_capability', 11, 'plugin:one'],
    ['documented_in', 74, 'plugin:one'],
    ['identifies', null, 'plugin:one'],
  ]);
});
