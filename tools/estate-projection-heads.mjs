// Reading which projection is selected, without the machinery that builds one.
//
// The query surfaces need exactly two things from the projection layer: how a head is addressed
// for an estate, and what the heads currently point at. Both lived in the module that also builds
// projections, so importing them dragged in the claim-map shard reader, the assertion producers,
// and the extractor registry behind them — a read-only client could not be assembled without the
// entire write path. "Read-only" was a convention rather than a property of the module graph.
//
// Splitting these out makes the boundary real: a consumer that only reads a projection imports
// this file and the Neo4j client, and nothing that could stage or promote a generation comes with
// it. The builder imports this module in turn, so there is one definition of a head, not two.
import { Neo4jHttpClient } from './c3-serving-projection.mjs';

const clean = value => String(value ?? '').trim();

export class EstateProjectionHeadError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EstateProjectionHeadError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new EstateProjectionHeadError(code, message, detail);
}

/**
 * One database serves every estate. Rows are isolated by projection_id; the only shared name was
 * the head slot, so a head is addressed by estate. An estate declaring no id keeps the unqualified
 * slots it already has, which is what a single-estate deployment upgrading in place must see.
 */
export function estateSlot(view, estate = null) {
  if (!['selected', 'working'].includes(view)) fail('ESTATE_PROJECTION_VIEW_INVALID', 'view must be selected or working');
  const held = clean(estate);
  if (!held) return view;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(held)) {
    fail('ESTATE_PROJECTION_ESTATE_INVALID', 'estate id must be a simple identifier', { estate });
  }
  return `${held}:${view}`;
}

export async function readEstateProjectionHeads(client, { estate = null } = {}) {
  if (!(client instanceof Neo4jHttpClient)) fail('ESTATE_PROJECTION_CLIENT_REQUIRED', 'an explicit Neo4j HTTP client is required');
  const rows = await client.query(`
    UNWIND [$selected_slot, $working_slot] AS slot
    OPTIONAL MATCH (h:EstateProjectionHead {slot: slot})
    OPTIONAL MATCH (p:EstateProjection {projection_id: h.projection_id})
    RETURN slot, h.projection_id, p.status, p.source_commit, p.content_digest,
           p.claim_map_digest, p.code_graph_digest,
           p.processed_nodes, p.total_nodes, p.processed_edges, p.total_edges
    ORDER BY slot
  `, { selected_slot: estateSlot('selected', estate), working_slot: estateSlot('working', estate) });
  const view = slot => (String(slot).endsWith(':working') || slot === 'working' ? 'working' : 'selected');
  return Object.freeze(Object.fromEntries(rows.map(row => [view(row[0]), {
    projection_id: row[1] || null,
    status: row[2] || null,
    source_commit: row[3] || null,
    content_digest: row[4] || null,
    claim_map_digest: row[5] || null,
    code_graph_digest: row[6] || null,
    processed_nodes: row[7] || 0,
    total_nodes: row[8] || 0,
    processed_edges: row[9] || 0,
    total_edges: row[10] || 0,
  }])));
}
