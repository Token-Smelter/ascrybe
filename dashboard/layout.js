// Deterministic bounded force-directed layout.
//
// The earlier integrator applied a spring force proportional to raw distance with no clamp, so a
// pair pushed apart by repulsion produced an ever larger attraction, which overshot, oscillated,
// and reached Infinity inside the iteration budget. Non-finite coordinates then produced a
// non-finite transform, which browsers discard, leaving the whole graph stacked at the origin.
//
// This version follows Fruchterman-Reingold: forces are expressed against one ideal edge length,
// every displacement is capped by a cooling temperature, and coordinates are clamped to a finite
// frame. Layout is a pure function of node ids and edges, so the same graph always lays out the
// same way and the arithmetic can be verified without a DOM.
const FRAME = 4000;

export function stableHash(value) {
  let held = 2166136261;
  for (const character of String(value)) {
    held ^= character.charCodeAt(0);
    held = Math.imul(held, 16777619);
  }
  return held >>> 0;
}

function seedPosition(id, index, count, ideal) {
  const angle = ((stableHash(id) % 3600) / 3600) * Math.PI * 2 + index / Math.max(count, 1);
  const radius = ideal * (0.6 + ((stableHash(`${id}:radius`) % 1000) / 1000) * 2.2);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clampFrame = value => Math.max(-FRAME, Math.min(FRAME, finite(value)));

/**
 * @param {{nodes: {id: string}[], edges: {from: string, to: string, relation?: string}[],
 *          positions?: Map<string, {x: number, y: number}>, iterations?: number}} input
 * @returns {Map<string, {x: number, y: number}>} finite coordinates for every node
 */
export function settleLayout({ nodes, edges, positions = new Map(), iterations = null,
  pinned = new Set() }) {
  const count = nodes.length;
  if (!count) return new Map();
  const ideal = Math.max(60, Math.min(220, Math.sqrt((FRAME * FRAME) / (count * 12))));
  const held = new Map();
  nodes.forEach((node, index) => {
    const prior = positions.get(node.id);
    const seed = prior && Number.isFinite(prior.x) && Number.isFinite(prior.y)
      ? { x: prior.x, y: prior.y }
      : seedPosition(node.id, index, count, ideal);
    held.set(node.id, { x: clampFrame(seed.x), y: clampFrame(seed.y), dx: 0, dy: 0 });
  });
  const live = edges.filter(edge => held.has(edge.from) && held.has(edge.to) && edge.from !== edge.to);
  const steps = iterations ?? Math.min(220, 80 + count);
  let temperature = ideal * 1.6;
  const cooling = temperature / (steps + 1);

  for (let step = 0; step < steps; step += 1) {
    for (const point of held.values()) { point.dx = 0; point.dy = 0; }

    for (let left = 0; left < count; left += 1) {
      const a = held.get(nodes[left].id);
      for (let right = left + 1; right < count; right += 1) {
        const b = held.get(nodes[right].id);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          // Coincident nodes have no direction; separate them deterministically instead of
          // dividing by zero.
          dx = ((stableHash(nodes[left].id) % 200) - 100) / 100;
          dy = ((stableHash(nodes[right].id) % 200) - 100) / 100;
          distance = Math.max(0.01, Math.hypot(dx, dy));
        }
        const repulsion = Math.min((ideal * ideal) / distance, ideal * 4);
        const ux = dx / distance;
        const uy = dy / distance;
        a.dx += ux * repulsion; a.dy += uy * repulsion;
        b.dx -= ux * repulsion; b.dy -= uy * repulsion;
      }
    }

    for (const edge of live) {
      const a = held.get(edge.from);
      const b = held.get(edge.to);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const attraction = Math.min((distance * distance) / ideal, ideal * 4);
      const ux = dx / distance;
      const uy = dy / distance;
      a.dx -= ux * attraction; a.dy -= uy * attraction;
      b.dx += ux * attraction; b.dy += uy * attraction;
    }

    for (const [id, point] of held) {
      // A node the user placed by hand is an anchor, not a suggestion: forces move everything else
      // around it instead of dragging it back.
      if (pinned.has(id)) { point.dx = 0; point.dy = 0; continue; }
      point.dx += -point.x * 0.012;
      point.dy += -point.y * 0.012;
      const displacement = Math.hypot(point.dx, point.dy);
      if (displacement > 0.0001) {
        const limited = Math.min(displacement, temperature) / displacement;
        point.x = clampFrame(point.x + point.dx * limited);
        point.y = clampFrame(point.y + point.dy * limited);
      }
    }
    temperature = Math.max(cooling, temperature - cooling);
  }

  return new Map([...held].map(([id, point]) => [id, { x: point.x, y: point.y }]));
}
