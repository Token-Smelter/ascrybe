// Layered layout for a graph whose structure is already known.
//
// The projection records which end of every structural edge is the parent. The force layout
// discarded that and rediscovered positions by simulation, which turns a node and its 120
// `contains` children into a ring, and turns the overview's structural spine into a hairball with
// the flow edges tangled through it. Both shapes lost the distinction between containment and
// flow -- the distinction the projection exists to record.
//
// So structure decides position and flow decides nothing. A node's depth comes from the
// structural parent relation; within a depth, nodes are grouped into blocks by kind, because a
// hundred siblings in one row is a line nobody can read while the same hundred in kind-blocks is
// a census. Flow edges are then drawn OVER that fixed frame, which is what makes a flow edge
// legible as a departure from the containment it crosses.
//
// Layout is a pure function of ids, kinds and structural edges: the same graph lays out the same
// way, and the arithmetic is verifiable without a DOM.
// Relative so the module resolves the same way in the browser and under node --test.
import { settleLayout } from './layout.js';

const FRAME = 4000;
const LAYER_GAP = 150;
const COLUMN_GAP = 132;
const ROW_GAP = 58;
const BLOCK_GAP = 78;
// A layer wider than this wraps into further rows rather than running off into a strip whose
// aspect ratio makes every node too small to read once the view is fitted.
const MAX_ROW_WIDTH = 2600;

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clampFrame = value => Math.max(-FRAME, Math.min(FRAME, finite(value)));
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The parent and child of a structural edge, or null for any other role. `parent_end` names the
 * parent end; an edge that lost it is read as parent-at-from, which is how the projection writes
 * containment.
 */
export function structuralEnds(edge) {
  if ((edge?.role ?? '') !== 'structural') return null;
  return edge.parent_end === 'to'
    ? { parent: edge.to, child: edge.from }
    : { parent: edge.from, child: edge.to };
}

/**
 * Depth of every node under the structural spine. Longest path from the roots, so a node sits
 * below every parent it has rather than below the first one found. The relaxation is capped at
 * one pass per node: a structural cycle should not exist, but a layout that hangs because one
 * does is worse than a layout that stops improving.
 */
export function structuralDepths(ids, links) {
  const parentsOf = new Map(ids.map(id => [id, []]));
  for (const link of links) {
    if (!parentsOf.has(link.child) || !parentsOf.has(link.parent) || link.parent === link.child) continue;
    parentsOf.get(link.child).push(link.parent);
  }
  const depth = new Map(ids.map(id => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let moved = false;
    for (const id of ids) {
      const deepest = parentsOf.get(id).reduce((held, parent) => Math.max(held, depth.get(parent) + 1), 0);
      if (deepest > depth.get(id)) { depth.set(id, deepest); moved = true; }
    }
    if (!moved) break;
  }
  return { depth, parentsOf };
}

/** A kind's members as a grid roughly twice as wide as it is tall, which reads as a block. */
function gridOf(members) {
  const columns = Math.max(1, Math.min(members.length, Math.ceil(Math.sqrt(members.length * 2))));
  const rows = Math.ceil(members.length / columns);
  return { members, columns, rows,
    width: (columns - 1) * COLUMN_GAP, height: (rows - 1) * ROW_GAP };
}

/** Pack blocks left to right, wrapping when the row would grow past the readable width. */
function packRows(blocks) {
  const rows = [];
  let current = [];
  let width = 0;
  for (const block of blocks) {
    const added = current.length ? width + BLOCK_GAP + block.width : block.width;
    if (current.length && added > MAX_ROW_WIDTH) {
      rows.push({ blocks: current, width });
      current = []; width = 0;
    }
    width = current.length ? width + BLOCK_GAP + block.width : block.width;
    current.push(block);
  }
  if (current.length) rows.push({ blocks: current, width });
  return rows;
}

export function layeredLayout({ nodes, edges = [], positions = new Map(), pinned = new Set() }) {
  if (!nodes.length) return new Map();
  const ids = nodes.map(node => node.id);
  const kindOf = new Map(nodes.map(node => [node.id, String(node.kind ?? '')]));
  const labelOf = new Map(nodes.map(node => [node.id, String(node.label ?? node.id)]));
  const present = new Set(ids);
  const links = edges.map(structuralEnds).filter(Boolean)
    .filter(link => present.has(link.parent) && present.has(link.child));

  // A node no structural edge reaches is not placed by structure. Its relations are flow or
  // annotation, and a force settle over exactly those is the honest arrangement for a set with no
  // containment to show.
  const structured = new Set(links.flatMap(link => [link.parent, link.child]));
  const loose = ids.filter(id => !structured.has(id));

  const { depth, parentsOf } = structuralDepths(ids.filter(id => structured.has(id)), links);
  const byDepth = new Map();
  for (const [id, level] of depth) {
    if (!byDepth.has(level)) byDepth.set(level, []);
    byDepth.get(level).push(id);
  }

  const placed = new Map();
  let top = 0;
  for (const level of [...byDepth.keys()].sort((left, right) => left - right)) {
    // Order by where a node's parents already sit, so a child lands under them and the edges
    // between two layers cross as little as the grid allows. Kind and label break every tie, so
    // the result does not depend on map iteration order.
    const barycentre = new Map(byDepth.get(level).map(id => {
      const parents = (parentsOf.get(id) ?? []).map(parent => placed.get(parent)?.x).filter(Number.isFinite);
      return [id, parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : 0];
    }));
    const ordered = [...byDepth.get(level)].sort((left, right) =>
      barycentre.get(left) - barycentre.get(right)
      || compare(kindOf.get(left), kindOf.get(right))
      || compare(labelOf.get(left), labelOf.get(right))
      || compare(left, right));

    const groups = new Map();
    for (const id of ordered) {
      const kind = kindOf.get(id);
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(id);
    }
    const blocks = [...groups]
      .map(([kind, members]) => ({ kind, ...gridOf(members),
        anchor: members.reduce((sum, id) => sum + barycentre.get(id), 0) / members.length }))
      .sort((left, right) => left.anchor - right.anchor || compare(left.kind, right.kind));

    for (const row of packRows(blocks)) {
      let x = -row.width / 2;
      let tallest = 0;
      for (const block of row.blocks) {
        block.members.forEach((id, index) => {
          placed.set(id, {
            x: clampFrame(x + (index % block.columns) * COLUMN_GAP),
            y: clampFrame(top + Math.floor(index / block.columns) * ROW_GAP),
          });
        });
        x += block.width + BLOCK_GAP;
        tallest = Math.max(tallest, block.height);
      }
      top += tallest + LAYER_GAP;
    }
  }

  if (loose.length) {
    const settled = settleLayout({
      nodes: loose.map(id => ({ id })),
      edges: edges.filter(edge => (edge.role ?? '') !== 'structural'),
    });
    // The force settle spreads across its own 4,000-unit frame, so a handful of unstructured
    // nodes could span 8,000 units beside a structured layout two thousand wide -- and the view
    // then fits to the outliers, shrinking everything that matters to illegibility. Forty-five
    // nodes were being fitted at scale 0.14 for this reason, not because there were too many.
    // Normalize the band to the width structure actually used.
    const points = [...settled.values()];
    const spanX = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x));
    const spanY = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y));
    const structuredWidth = placed.size
      ? Math.max(...[...placed.values()].map(point => point.x)) - Math.min(...[...placed.values()].map(point => point.x))
      : 0;
    const width = Math.max(structuredWidth, COLUMN_GAP * Math.ceil(Math.sqrt(loose.length * 2)));
    const scaleX = spanX > 0 ? width / spanX : 0;
    const scaleY = spanY > 0 ? Math.min(width / 3, ROW_GAP * loose.length) / spanY : 0;
    const midX = spanX > 0 ? (Math.max(...points.map(p => p.x)) + Math.min(...points.map(p => p.x))) / 2 : 0;
    const minY = Math.min(...points.map(point => point.y));
    for (const id of loose) {
      const point = settled.get(id) ?? { x: 0, y: 0 };
      placed.set(id, {
        x: clampFrame((point.x - midX) * scaleX),
        y: clampFrame(top + LAYER_GAP + (point.y - minY) * scaleY),
      });
    }
  }

  // A node the reader dragged is an anchor, not a suggestion; structure rearranges around it.
  for (const id of pinned) {
    const prior = positions.get(id);
    if (prior) placed.set(id, { x: clampFrame(prior.x), y: clampFrame(prior.y) });
  }
  return placed;
}
