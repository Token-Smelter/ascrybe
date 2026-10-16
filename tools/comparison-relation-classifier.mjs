// Deterministic, rule-based ten-relation comparison classifier for the documentation-claim census
// (DESIGN §16.12.1, preregistration §4.1). Slice 2 of intent-779029e6. Answers adjudication A6.
//
// A6 / SUPERSESSION. The old referent-alignment cascade in neural-census-producers.mjs
// (alignReferentOnly, the six ALIGNMENT_CATEGORIES) can express only 6 of the 10 ratified
// comparison relations — it has no seat for scope_divergence, temporal_divergence,
// modality_divergence, conformance_gap_candidate, referent_ambiguity, or terminology_conflict as
// distinct outcomes, and it compares a claim to a single referent rather than classifying a claim
// PAIR. This module supersedes that cascade: its output space is exactly the ten ratified relations,
// each with a documented decision rule grounded in the amended-contract fields (polarity, modality,
// scope sub-fields, valid_time). A pair the rules cannot assign falls through to `incomparable`
// EXPLICITLY; nothing is ever silently dropped.
//
// COMPARISON, NOT RESOLUTION. The ten comparison relations are DISTINCT from the eleven post-evidence
// resolutions (supported/refuted/…). This module assigns a comparison relation only; it never
// resolves, gathers evidence, calls a provider, or touches the estate. It reads only two normalized
// propositions (see proposition-index.mjs) that were derived from real slice-1 claim records.
import { bucketKey } from './proposition-index.mjs';

// The exactly-ten ratified comparison relations (contract order).
export const COMPARISON_RELATIONS = Object.freeze([
  'equivalent_proposition', 'compatible_partial', 'direct_conflict', 'scope_divergence',
  'temporal_divergence', 'modality_divergence', 'conformance_gap_candidate', 'referent_ambiguity',
  'terminology_conflict', 'incomparable',
]);

// One-line decision rule per relation, grounded in amended-contract fields. Kept beside the code so
// the rule and the branch that implements it cannot drift.
export const RELATION_DECISION_RULES = Object.freeze({
  incomparable: 'bucket keys differ (not candidates), OR objects are disjoint with resolved/consistent referents — no comparison basis. Explicit fall-through; never a silent drop.',
  direct_conflict: 'same or overlapping object, OPPOSED polarity (affirmed vs negated). Grounded in `polarity`.',
  conformance_gap_candidate: 'equal object, same polarity, modality pair is exactly {normative, descriptive} — a documented requirement paired with a factual statement. Grounded in `modality`.',
  modality_divergence: 'equal object, same polarity, differing exact `modality` within one compatible-modality class (and not the conformance pair). Grounded in `modality`.',
  scope_divergence: 'equal object, same polarity, same modality, differing precise `scope` sub-fields (environment / version_or_branch / actor / repository) within one scope band. Grounded in `scope`.',
  temporal_divergence: 'equal object, same polarity, same modality, same scope, differing `valid_time` interval within one validity band. Grounded in `valid_time`.',
  terminology_conflict: 'equal/overlapping object, same polarity, at least one referent unresolved, subject terms are surface VARIANTS of one another (alias/acronym/prefix). Grounded in subject_refs + object surface.',
  referent_ambiguity: 'at least one referent unresolved and subject terms differ without being variants — cannot pin whether the two claims share a subject. Grounded in subject_refs.',
  equivalent_proposition: 'equal object, same polarity, same modality, same scope, same validity, aligned subject — the same proposition asserted twice.',
  compatible_partial: 'overlapping (not identical) object, same polarity — compatible, partially-overlapping claims that neither conflict nor coincide.',
});

const OPPOSED = 'negated';

// Object-token relationship between two propositions: equal | overlap | disjoint. `equal` when the
// normalized object keys match; `overlap` when the token sets share ≥50% of the smaller set (but are
// not equal); `disjoint` otherwise (no meaningful shared substance). Deterministic set arithmetic.
function objectRelationship(a, b) {
  if (a.object_key === b.object_key) return 'equal';
  const left = new Set(a.object_tokens);
  const right = new Set(b.object_tokens);
  if (!left.size || !right.size) return 'disjoint';
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  if (intersection === 0) return 'disjoint';
  return intersection / Math.min(left.size, right.size) >= 0.5 ? 'overlap' : 'disjoint';
}

const isConformancePair = (m1, m2) => {
  const pair = new Set([m1, m2]);
  return pair.size === 2 && pair.has('normative') && pair.has('descriptive');
};

const scopeEqual = (a, b) => ['repository', 'component', 'environment', 'version_or_branch', 'actor']
  .every(field => (a.scope[field] ?? null) === (b.scope[field] ?? null));

const validityEqual = (a, b) => (a.validity.from ?? null) === (b.validity.from ?? null) && (a.validity.until ?? null) === (b.validity.until ?? null);

const canon = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Two subject terms are surface VARIANTS (likely one referent under different terminology) when they
// canonicalize equal (ws-bridge vs ws_bridge vs WsBridge), one is a prefix of the other (≥3 chars),
// or one is an acronym of the other's word parts. Distinguishes terminology_conflict from a genuine
// referent_ambiguity where the terms are simply different.
function termsAreVariants(t1, t2) {
  if (!t1 || !t2 || t1 === t2) return false;
  const c1 = canon(t1);
  const c2 = canon(t2);
  if (!c1 || !c2) return false;
  if (c1 === c2) return true;
  if (c1.length >= 3 && c2.length >= 3 && (c1.startsWith(c2) || c2.startsWith(c1))) return true;
  const acronymOf = (short, long) => {
    const parts = String(long).split(/[^a-z0-9]+/i).filter(Boolean);
    return parts.length >= 2 && parts.map(part => part[0].toLowerCase()).join('') === short.toLowerCase();
  };
  return acronymOf(canon(t1), t2) || acronymOf(canon(t2), t1);
}

const eitherUnresolved = (a, b) => !a.subject_resolved || !b.subject_resolved;

/**
 * Classify a candidate proposition PAIR into exactly one of the ten ratified comparison relations.
 * Pure and deterministic. Recomputes the bucket key so the classifier is self-contained: a pair from
 * two different buckets is `incomparable` (not candidates). Order is a documented total precedence so
 * exactly one relation is assigned and every relation is reachable.
 */
export function classifyRelation(a, b) {
  if (!a || !b) return 'incomparable';
  // Not comparison candidates unless they share a bucket.
  if (bucketKey(a) !== bucketKey(b)) return 'incomparable';

  const objRel = objectRelationship(a, b);
  const polarityOpposed = a.polarity !== b.polarity && (a.polarity === OPPOSED || b.polarity === OPPOSED);

  if (objRel === 'disjoint') {
    // Same neighbourhood + predicate but unrelated objects. Ambiguous only when we cannot even tell
    // the referents apart; otherwise there is simply no comparison basis.
    if (eitherUnresolved(a, b) && a.subject_term !== b.subject_term) return 'referent_ambiguity';
    return 'incomparable';
  }

  // objRel is 'equal' or 'overlap' from here.
  if (polarityOpposed) return 'direct_conflict';

  if (objRel === 'equal') {
    if (isConformancePair(a.modality, b.modality)) return 'conformance_gap_candidate';
    if (a.modality !== b.modality) return 'modality_divergence';
    if (!scopeEqual(a, b)) return 'scope_divergence';
    if (!validityEqual(a, b)) return 'temporal_divergence';
    if (eitherUnresolved(a, b) && termsAreVariants(a.subject_term, b.subject_term)) return 'terminology_conflict';
    if (eitherUnresolved(a, b) && a.subject_term !== b.subject_term) return 'referent_ambiguity';
    return 'equivalent_proposition';
  }

  // objRel === 'overlap', polarity not opposed.
  if (eitherUnresolved(a, b) && termsAreVariants(a.subject_term, b.subject_term)) return 'terminology_conflict';
  if (eitherUnresolved(a, b) && a.subject_term !== b.subject_term) return 'referent_ambiguity';
  return 'compatible_partial';
}

/** Classify every candidate pair a proposition index yields; returns a frozen ten-class histogram. */
export function classifyIndex(index) {
  const histogram = Object.fromEntries(COMPARISON_RELATIONS.map(relation => [relation, 0]));
  let comparedPairs = 0;
  for (const { a, b } of index.candidatePairs()) {
    const relation = classifyRelation(a, b);
    histogram[relation] += 1;
    comparedPairs += 1;
  }
  return Object.freeze({ histogram: Object.freeze(histogram), comparedPairs });
}
