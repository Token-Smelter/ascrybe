import test from 'node:test';
import assert from 'node:assert/strict';
import { layeredLayout, structuralDepths, structuralEnds } from '../dashboard/layered-layout.js';

const structural = (from, to, parent_end = 'from') =>
  ({ id: `${from}->${to}`, from, to, relation: 'contains', role: 'structural', parent_end });
const flow = (from, to) => ({ id: `${from}~${to}`, from, to, relation: 'emits', role: 'flow', parent_end: null });

test('the parent end is read from the projection rather than from edge direction', () => {
  assert.deepEqual(structuralEnds(structural('a', 'b', 'from')), { parent: 'a', child: 'b' });
  // Direction reversed, parent unchanged: the projection records which end owns the other.
  assert.deepEqual(structuralEnds(structural('a', 'b', 'to')), { parent: 'b', child: 'a' });
  assert.equal(structuralEnds(flow('a', 'b')), null);
  assert.equal(structuralEnds({ from: 'a', to: 'b', role: 'annotation' }), null);
});

test('depth is the longest path, so a node sits below every parent it has', () => {
  // b is a child of the root and also of a, which is itself a child of the root.
  const { depth } = structuralDepths(['root', 'a', 'b'],
    [{ parent: 'root', child: 'a' }, { parent: 'root', child: 'b' }, { parent: 'a', child: 'b' }]);
  assert.deepEqual([depth.get('root'), depth.get('a'), depth.get('b')], [0, 1, 2]);
});

test('a structural cycle terminates instead of hanging the layout', () => {
  const { depth } = structuralDepths(['a', 'b', 'c'],
    [{ parent: 'a', child: 'b' }, { parent: 'b', child: 'c' }, { parent: 'c', child: 'a' }]);
  assert.equal([...depth.values()].every(Number.isFinite), true);
});

test('a parent and its many children become ranked bands rather than one unreadable row', () => {
  const kinds = ['Module', 'Document', 'Envelope'];
  const nodes = [{ id: 'root', kind: 'SourceCommit', label: 'root' },
    ...Array.from({ length: 120 }, (_, index) =>
      ({ id: `child:${index}`, kind: kinds[index % kinds.length], label: `child ${index}` }))];
  const edges = nodes.slice(1).map(node => structural('root', node.id));
  const placed = layeredLayout({ nodes, edges });

  const rootY = placed.get('root').y;
  const children = nodes.slice(1).map(node => placed.get(node.id));
  // Blocks wrap onto further rows when a layer would run wider than it is readable, so the
  // property is that kinds do not interleave along any one line -- not that a kind owns a span of
  // x across the whole layer, which wrapping deliberately breaks.
  const rows = new Map();
  for (const node of nodes.slice(1)) {
    const point = placed.get(node.id);
    if (!rows.has(point.y)) rows.set(point.y, new Map());
    const line = rows.get(point.y);
    if (!line.has(node.kind)) line.set(node.kind, []);
    line.get(node.kind).push(point.x);
  }
  const disjoint = spans => spans.every((xs, index, all) =>
    all.slice(index + 1).every(other => Math.max(...xs) < Math.min(...other) || Math.min(...xs) > Math.max(...other)));
  assert.deepEqual({
    placed: placed.size,
    finite: [...placed.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
    childrenBelowParent: children.every(point => point.y > rootY),
    // The failure this replaces: 120 siblings strung across a single row nobody can read.
    wrapped: new Set(children.map(point => point.y)).size > 1,
    kindsSeparated: [...rows.values()].every(line => disjoint([...line.values()])),
  }, { placed: 121, finite: true, childrenBelowParent: true, wrapped: true, kindsSeparated: true });
});

test('flow edges do not move anything: structure alone decides position', () => {
  const nodes = ['root', 'a', 'b'].map(id => ({ id, kind: 'Module', label: id }));
  const edges = [structural('root', 'a'), structural('root', 'b')];
  const withFlow = layeredLayout({ nodes, edges: [...edges, flow('a', 'b'), flow('b', 'a')] });
  const without = layeredLayout({ nodes, edges });
  assert.deepEqual([...without].map(([id, point]) => [id, point.x, point.y]),
    [...withFlow].map(([id, point]) => [id, point.x, point.y]));
});

test('nodes no structural edge reaches are still placed, below the structure', () => {
  const nodes = [{ id: 'root', kind: 'Project', label: 'root' }, { id: 'a', kind: 'Module', label: 'a' },
    { id: 'loose', kind: 'Claim', label: 'loose' }, { id: 'loose2', kind: 'Claim', label: 'loose2' }];
  const placed = layeredLayout({ nodes, edges: [structural('root', 'a'), flow('loose', 'loose2')] });
  assert.deepEqual({
    placed: placed.size,
    finite: [...placed.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
    belowStructure: placed.get('loose').y > placed.get('a').y && placed.get('loose2').y > placed.get('a').y,
  }, { placed: 4, finite: true, belowStructure: true });
});

test('layout is deterministic and a pinned node keeps the position it was dragged to', () => {
  const nodes = Array.from({ length: 20 }, (_, index) =>
    ({ id: `n:${index}`, kind: index % 2 ? 'Module' : 'Document', label: `n ${index}` }));
  const edges = nodes.slice(1).map((node, index) => structural(`n:${index % 3}`, node.id));
  const first = layeredLayout({ nodes, edges });
  const repeat = layeredLayout({ nodes, edges });
  const anchored = layeredLayout({ nodes, edges,
    positions: new Map([['n:7', { x: 1234, y: -567 }]]), pinned: new Set(['n:7']) });
  assert.deepEqual({
    deterministic: [...first].every(([id, point]) => repeat.get(id).x === point.x && repeat.get(id).y === point.y),
    pinnedHeld: anchored.get('n:7').x === 1234 && anchored.get('n:7').y === -567,
  }, { deterministic: true, pinnedHeld: true });
});

test('an empty graph and a graph with no edges are both placeable', () => {
  assert.equal(layeredLayout({ nodes: [] }).size, 0);
  const bare = layeredLayout({ nodes: [{ id: 'only', kind: 'Module', label: 'only' }] });
  assert.equal(Number.isFinite(bare.get('only').x) && Number.isFinite(bare.get('only').y), true);
});
