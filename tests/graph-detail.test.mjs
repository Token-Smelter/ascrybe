import test from 'node:test';
import assert from 'node:assert/strict';
import { graphDetailForEdge, graphDetailForNode } from '../dashboard/graph-detail.js';

test('node detail retains the full label and carried identifying properties', () => {
  const detail = graphDetailForNode({
    id: 'claim:shipping',
    kind: 'Claim',
    label: 'Shipping claim with a label longer than the graph canvas permits',
    properties: { verdict: 'supported', realization: 'checkout-service' },
  });
  assert.deepEqual(detail, {
    type: 'Node',
    title: 'Shipping claim with a label longer than the graph canvas permits',
    fields: [
      { label: 'Kind', value: 'Claim' },
      { label: 'Node ID', value: 'claim:shipping' },
      { label: 'verdict', value: 'supported' },
      { label: 'realization', value: 'checkout-service' },
    ],
  });
});

test('edge detail names its relation and directed endpoint labels', () => {
  const detail = graphDetailForEdge({
    relation: 'provides_capability', from: 'module:checkout', to: 'capability:shipping',
  }, new Map([
    ['module:checkout', { label: 'Checkout module' }],
    ['capability:shipping', { label: 'Shipping capability' }],
  ]));
  assert.deepEqual(detail, {
    type: 'Relation',
    title: 'provides_capability',
    fields: [
      { label: 'Relation', value: 'provides_capability' },
      { label: 'Source', value: 'Checkout module (module:checkout)' },
      { label: 'Target', value: 'Shipping capability (capability:shipping)' },
      { label: 'Direction', value: 'Checkout module (module:checkout) → Shipping capability (capability:shipping)' },
    ],
  });
});
