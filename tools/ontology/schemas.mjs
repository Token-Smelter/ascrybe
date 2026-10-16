// Shared schema-string constants and the fail-closed error/hash conventions every ontology
// module uses. This is the one place a schema string or the canonical-hashing rule is defined,
// so five copies cannot drift the way estate-graph-roles.mjs warns a duplicated relation list
// would (see that file's header).
//
// The ontology sidecar reuses the repository's own identity convention rather than inventing a
// second one: `${prefix}:${sha256(canonical(body))}`, the same rule claim-evidence-map.mjs's
// `immutableRecord` and referent-identity.mjs's `hashId` already use. See docs/before-a-pr.md and
// CONTRIBUTING.md's "omission must fail, not default" invariant, which every `fail()` call here
// exists to uphold: a malformed context, rule, or record throws rather than silently degrades.
import { sha256, stableStringify } from '../lib.mjs';

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export const canonical = value => stableStringify(value).trim();

export class OntologyError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'OntologyError';
    this.code = code;
    this.detail = detail;
  }
}

export function fail(code, message, detail = {}) {
  throw new OntologyError(code, message, detail);
}

/** `${prefix}:${sha256(canonical({schema, ...body}))}`, frozen, with the id field appended last. */
export function immutableRecord(schema, prefix, body, idField) {
  const record = Object.freeze({ schema, ...body });
  return Object.freeze({ ...record, [idField]: `${prefix}:${sha256(canonical(record))}` });
}

/** True when `record`'s own id field is exactly the digest its remaining canonical body hashes to. */
export function digestMatches(record, idField, prefix) {
  const { [idField]: id, ...body } = record;
  return id === `${prefix}:${sha256(canonical(body))}`;
}

// Preserve source witnesses; do not infer authority from naming conventions alone.
export const EVIDENCE_CONTEXT_SCHEMA = 'estate-map/evidence-context/v1';
export const CONCEPT_VERSION_SCHEMA = 'estate-map/ontology-concept-version/v1';
export const MEMBERSHIP_SCHEMA = 'estate-map/ontology-membership/v1';
export const REFUSAL_SCHEMA = 'estate-map/ontology-refusal/v1';
export const GENERATION_SCHEMA = 'estate-map/interpretation-generation/v1';
export const PATTERN_SCHEMA = 'estate-map/ontology-pattern/v1';
export const CONFIDENCE_POLICY_SCHEMA = 'estate-map/ontology-confidence-policy/v1';
export const EVALUATION_REPORT_SCHEMA = 'estate-map/ontology-phase1-evaluation/v1';
