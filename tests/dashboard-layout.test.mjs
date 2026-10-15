import test from 'node:test';
import assert from 'node:assert/strict';
import { settleLayout, stableHash } from '../dashboard/layout.js';

function graph({ nodeCount, edgeCount }) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({ id: `node:${index}` }));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    from: `node:${index % nodeCount}`,
    to: `node:${(index * 7 + 3) % nodeCount}`,
    relation: index % 3 === 0 ? 'contains' : 'supported_by',
  }));
  return { nodes, edges };
}

test('estate-scale layout stays finite and bounded so the view transform is computable', () => {
  const positions = settleLayout(graph({ nodeCount: 100, edgeCount: 768 }));
  const points = [...positions.values()];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  assert.deepEqual({
    placed: positions.size,
    finite: points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
    spanned: Math.max(...xs) - Math.min(...xs) > 50 && Math.max(...ys) - Math.min(...ys) > 50,
    bounded: points.every(point => Math.abs(point.x) <= 4000 && Math.abs(point.y) <= 4000),
  }, { placed: 100, finite: true, spanned: true, bounded: true });
});

test('layout is deterministic and reuses prior coordinates for already-placed nodes', () => {
  const held = graph({ nodeCount: 12, edgeCount: 20 });
  const first = settleLayout(held);
  const repeat = settleLayout(held);
  const anchored = settleLayout({
    nodes: [...held.nodes, { id: 'node:new' }], edges: held.edges, positions: first, iterations: 0,
  });
  assert.deepEqual({
    deterministic: [...first].every(([id, point]) =>
      repeat.get(id).x === point.x && repeat.get(id).y === point.y),
    preserved: anchored.get('node:0').x === first.get('node:0').x,
    placedNew: Number.isFinite(anchored.get('node:new').x),
    hashStable: stableHash('node:0') === stableHash('node:0'),
  }, { deterministic: true, preserved: true, placedNew: true, hashStable: true });
});

test('degenerate graphs cannot produce non-finite coordinates', () => {
  const coincident = settleLayout({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'a' }],
    positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }]]),
  });
  const poisoned = settleLayout({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'missing' }],
    positions: new Map([['a', { x: Number.NaN, y: Infinity }]]),
  });
  assert.deepEqual([...coincident.values(), ...poisoned.values()]
    .every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), true);
});
