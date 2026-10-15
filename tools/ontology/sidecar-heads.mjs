// Reading which interpretation generation is selected for a base projection, without the machinery
// that builds or stages one -- the same split estate-projection-heads.mjs draws for the raw graph,
// mirrored here (design v2 section 6: "Working/selected interpretation heads are per base
// projection... promotion is explicit and compare-and-set; rollback moves only the interpretation
// head").
//
// One difference from the raw pattern, deliberate: the raw head is addressed by ESTATE, because
// one estate has exactly one current raw projection and the estate name is what would otherwise
// collide across estates sharing one database. An interpretation head is addressed by BASE
// PROJECTION ID instead -- design v2's own words, and the more precise key: a projection_id is
// already estate- and commit-exact and globally unique, and a single estate can legitimately carry
// interpretation heads for more than one base projection at once (a baseline and a target context,
// held side by side, exactly as Phase 1's evidence-context isolation already requires).
import { Neo4jHttpClient } from '../c3-serving-projection.mjs';

const clean = value => String(value ?? '').trim();

export class SidecarHeadError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SidecarHeadError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new SidecarHeadError(code, message, detail);
}

/** `${base_projection_id}:${view}` -- the interpretation-head analogue of estateSlot(). */
export function interpretationSlot(view, baseProjectionId) {
  if (!['selected', 'working'].includes(view)) fail('SIDECAR_HEAD_VIEW_INVALID', 'view must be selected or working');
  const held = clean(baseProjectionId);
  if (!held.startsWith('estate-projection:')) {
    fail('SIDECAR_HEAD_PROJECTION_INVALID', 'base_projection_id must be an estate-projection: id', { base_projection_id: baseProjectionId });
  }
  return `${held}:${view}`;
}

export async function readInterpretationHeads(client, { base_projection_id: baseProjectionId }) {
  if (!(client instanceof Neo4jHttpClient)) fail('SIDECAR_HEAD_CLIENT_REQUIRED', 'an explicit Neo4j HTTP client is required');
  const rows = await client.query(`
    UNWIND [$selected_slot, $working_slot] AS slot
    OPTIONAL MATCH (h:InterpretationHead {slot: slot})
    OPTIONAL MATCH (g:InterpretationGeneration {interpretation_id: h.interpretation_id})
    RETURN slot, h.interpretation_id, g.status, g.base_projection_id, g.evidence_context_id,
           g.ontology_policy_digest, g.generation_content_digest,
           g.processed_memberships, g.total_memberships
    ORDER BY slot
  `, {
    selected_slot: interpretationSlot('selected', baseProjectionId),
    working_slot: interpretationSlot('working', baseProjectionId),
  });
  const view = slot => (String(slot).endsWith(':working') ? 'working' : 'selected');
  return Object.freeze(Object.fromEntries(rows.map(row => [view(row[0]), {
    interpretation_id: row[1] || null,
    status: row[2] || null,
    base_projection_id: row[3] || null,
    evidence_context_id: row[4] || null,
    policy_digest: row[5] || null,
    generation_content_digest: row[6] || null,
    processed_memberships: row[7] || 0,
    total_memberships: row[8] || 0,
  }])));
}
