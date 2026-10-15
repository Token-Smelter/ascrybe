// estate-map/evidence-context/v1 (design v2 section 2) -- an interpretation never exists "over an
// estate", it exists over an EXACT context: one base projection, one source identity, one coverage
// descriptor. Two contexts over the same commit with different paid-documentary coverage are
// different contexts, and a membership computed in one must never be read as if it applied to the
// other (design v2: "baseline memberships never carry into the target").
import { isSourceIdentity, sha256 } from '../lib.mjs';
import { canonical, digestMatches, fail, EVIDENCE_CONTEXT_SCHEMA } from './schemas.mjs';

const SOURCE_KINDS = Object.freeze(['single_repository_commit', 'ordered_source_pins']);

export function buildEvidenceContext({ estate, source_identity: sourceIdentity, base_projection: baseProjection, coverage }) {
  if (typeof estate !== 'string' || !estate) fail('EVIDENCE_CONTEXT_INVALID', 'evidence context requires a non-empty estate id');
  if (!SOURCE_KINDS.includes(sourceIdentity?.kind) || typeof sourceIdentity.digest !== 'string' || !sourceIdentity.digest) {
    fail('EVIDENCE_CONTEXT_INVALID', `evidence context source_identity.kind must be one of ${SOURCE_KINDS.join(', ')}, with a digest`);
  }
  // A 40-hex commit is a single_repository_commit; a 64-hex digest of ordered pins is the other
  // kind. docs/before-a-pr.md: "a validator that hard-coded 40 ... rejected the identity the
  // projection derives" for a multi-repository estate -- isSourceIdentity already accepts both
  // lengths, so this only refuses a digest that is neither.
  if (!isSourceIdentity(sourceIdentity.digest)) {
    fail('EVIDENCE_CONTEXT_INVALID', 'evidence context source_identity.digest is not a 40- or 64-hex identity');
  }
  if (typeof baseProjection?.projection_id !== 'string' || !baseProjection.projection_id.startsWith('estate-projection:')
    || typeof baseProjection.content_digest !== 'string' || !baseProjection.content_digest) {
    fail('EVIDENCE_CONTEXT_INVALID', 'evidence context base_projection requires projection_id and content_digest');
  }
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    fail('EVIDENCE_CONTEXT_INVALID', 'evidence context requires a coverage descriptor object');
  }
  const body = {
    schema: EVIDENCE_CONTEXT_SCHEMA,
    estate,
    source_identity: Object.freeze({ ...sourceIdentity }),
    base_projection: Object.freeze({ ...baseProjection }),
    coverage: Object.freeze(structuredClone(coverage)),
  };
  return Object.freeze({ ...body, context_id: `evidence-context:${sha256(canonical(body))}` });
}

export function validateEvidenceContext(context) {
  if (context?.schema !== EVIDENCE_CONTEXT_SCHEMA) fail('EVIDENCE_CONTEXT_INVALID', 'evidence context schema mismatch');
  if (!digestMatches(context, 'context_id', 'evidence-context')) {
    fail('EVIDENCE_CONTEXT_DIGEST_MISMATCH', 'evidence context id does not match its canonical body');
  }
}

/** Two contexts "blend" only if they resolve to the same context_id; anything else is refused by
 * construction rather than merged, which is the property design v2 section 4.3 requires. */
export function assertSameContext(a, b, detail) {
  if (a?.context_id !== b?.context_id) {
    fail('EVIDENCE_CONTEXT_MISMATCH', `${detail || 'operation'} spans two different evidence contexts`, {
      a: a?.context_id, b: b?.context_id,
    });
  }
}
