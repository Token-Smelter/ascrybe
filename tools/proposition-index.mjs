// Deterministic, pure, snapshot-bound proposition index for the documentation-claim census
// (DESIGN §16.12.1, preregistration §4). Slice 2 of intent-779029e6.
//
// WHAT THIS IS. It normalizes the ratified slice-1 documentary CLAIMS (the records
// produceDocumentationClaims emits and the documentary-claim ledger stores) into comparison-ready
// PROPOSITIONS, then groups those propositions into candidate-comparison BUCKETS keyed by
//
//     (subject_neighbourhood, predicate_family, scope, validity_interval, compatible_modality_class)
//
// so that ONLY same-bucket propositions ever become comparison candidates. This is the mechanism
// that keeps pairwise comparison sub-quadratic: comparisons are Σ C(bucket_size, 2), not the naive
// C(total_claims, 2).
//
// WHAT THIS IS NOT. No estate access, no provider/model call, no extraction wiring. Normalization
// reads ONLY the claim's own already-extracted semantic fields (it never re-reads the corpus). The
// promotion boundary is intact: propositions are a derived comparison view, never a deterministic
// observation and never written back into the observation plane.
//
// SCOPE / VALIDITY ARE OVERLAP-COMPATIBILITY BANDS, NOT EXACT VALUES. The design's candidacy rule
// (§16.12.1) requires "overlapping scope, overlapping validity interval, and compatible modality" —
// overlap, not identity. So the bucket key's `scope` component is a coarse scope BAND (the
// structural locus: repository + component) and its `validity_interval` component is a validity
// BAND (bounded vs unbounded), each an equivalence key realizing the "overlapping" candidacy rule.
// Precise scope sub-fields (environment / version_or_branch / actor) and precise validity intervals
// remain on the proposition and are what the relation classifier reads to detect scope_divergence /
// temporal_divergence WITHIN a bucket. If the bucket key used exact scope/validity, those two
// relations could never arise (divergent pairs would land in different buckets and never compare).
import { CLAIM_MODALITIES } from './adjudication-schema.mjs';
import { sha256, stableStringify } from './lib.mjs';

export class PropositionIndexError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PropositionIndexError';
    this.code = code;
    this.detail = detail;
  }
}

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// Compatible-modality classes (the `compatible_modality_class` bucket component). Only same-class
// propositions are comparison candidates. Rationale, documented per the design's "compatible
// modality" candidacy rule:
//   * assertive  — descriptive/normative/constitutive/historical all ASSERT something about the
//                  subject's actual state or governing rules, so a requirement ("must") and a fact
//                  ("does") about the same object are comparable (that comparability is exactly what
//                  makes conformance_gap_candidate and modality_divergence possible).
//   * projective — predictive claims are about FUTURE/projected state: a distinct comparability
//                  regime, compared only to other projective claims.
//   * interpretive — interpretive claims are about MEANING/reading: their own regime.
export const COMPATIBLE_MODALITY_CLASS = Object.freeze({
  descriptive: 'assertive',
  normative: 'assertive',
  constitutive: 'assertive',
  historical: 'assertive',
  predictive: 'projective',
  interpretive: 'interpretive',
});

const NEGATION_CUES = /\b(?:cannot|can't|never|not|no|none|without|must[ -]?not|shall[ -]?not|should[ -]?not|won'?t|doesn'?t|don'?t|didn'?t|isn'?t|aren'?t|refuses?|forbids?|forbidden|prohibits?|prohibited|disallow(?:s|ed)?|excludes?)\b/i;
// Cue words that carry modality/quantifier/polarity or are structural filler; excluded from the
// object token set so equivalence/overlap keys off the substantive predicate+object, not scaffolding.
const CUE_AND_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'be', 'been', 'being', 'was', 'were', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'and', 'or', 'as', 'that', 'this', 'these', 'those', 'it', 'its',
  'must', 'shall', 'should', 'may', 'can', 'will', 'would', 'not', 'no', 'never', 'only',
  'requires', 'require', 'required', 'cannot', 'all', 'every', 'each', 'any', 'remains', 'remain',
  'via', 'per', 'into', 'from', 'than', 'then', 'when', 'while', 'so', 'but', 'if', 'else',
]);

const text = value => String(value ?? '');
const tokenize = value => text(value).toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1 && !CUE_AND_STOPWORDS.has(token));

// A finer surface subject term than the neighbourhood, so the classifier can tell a
// terminology_conflict (variant surface forms of one referent) from a referent_ambiguity
// (unresolved, plausibly different referents) WITHIN one neighbourhood bucket. Deterministic:
// prefer a resolved ref, else the first identifier-shaped token in the statement, else the
// neighbourhood.
const IDENTIFIER_TOKEN = /\b([A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Za-z]*[0-9]+[A-Za-z0-9]*)\b/;
function deriveSubjectTerm(sem, neighbourhood) {
  const first = Array.isArray(sem.subject_refs) ? sem.subject_refs[0] : null;
  const ref = text(first?.ref ?? first ?? '').trim();
  if (ref && ref.toLowerCase() !== text(neighbourhood).toLowerCase()) return ref.toLowerCase();
  const match = IDENTIFIER_TOKEN.exec(text(sem.object_or_value));
  if (match) return match[1].toLowerCase();
  return text(neighbourhood).toLowerCase();
}

// Polarity is a comparison-critical contract field the deterministic slice-1 parser under-derives
// (it stamps every claim 'affirmed'). Recover it deterministically from negation cues in the claim's
// OWN object text so a documented "must NOT X" is comparable to a "does X". This reads only the
// claim's already-extracted object_or_value — it is normalization of an extracted claim, not new
// extraction against the corpus.
function derivePolarity(sem) {
  const stated = text(sem.polarity).toLowerCase();
  if (stated === 'negated' || stated === 'denied' || stated === 'refuted') return 'negated';
  return NEGATION_CUES.test(text(sem.object_or_value)) ? 'negated' : 'affirmed';
}

const SCOPE_SUBFIELDS = Object.freeze(['repository', 'component', 'environment', 'version_or_branch', 'actor']);
const normalizeScope = scope => {
  const source = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  return Object.fromEntries(SCOPE_SUBFIELDS.map(field => [field, source[field] ?? null]));
};

const normalizeValidity = validTime => {
  const source = validTime && typeof validTime === 'object' && !Array.isArray(validTime) ? validTime : {};
  return { from: source.from ?? null, until: source.until ?? null };
};

/**
 * Normalize ONE slice-1 documentary claim record into a comparison-ready proposition. Pure and
 * deterministic: same claim in => byte-identical proposition out. Reads only the claim's semantic
 * fields; never touches the estate.
 */
export function normalizeClaimToProposition(claim) {
  const sem = claim && typeof claim === 'object' ? (claim.semantic || claim) : null;
  if (!sem || typeof sem !== 'object') throw new PropositionIndexError('INVALID_CLAIM', 'proposition normalization requires a claim record with a semantic body');
  if (!Array.isArray(sem.subject_refs) || !sem.subject_refs.length) throw new PropositionIndexError('INVALID_CLAIM', 'claim requires non-empty subject_refs');
  if (typeof sem.predicate_family !== 'string' || !sem.predicate_family) throw new PropositionIndexError('INVALID_CLAIM', 'claim requires a predicate_family');
  const first = sem.subject_refs[0];
  const neighbourhood = text(first?.neighbourhood ?? first?.ref ?? first ?? '').trim().toLowerCase() || 'unassigned';
  const subject_resolved = Boolean(first) && typeof first === 'object' && first.kind !== undefined && first.kind !== 'unresolved';
  const modality = CLAIM_MODALITIES.includes(sem.modality) ? sem.modality : 'descriptive';
  const scope = normalizeScope(sem.scope);
  const validity = normalizeValidity(sem.valid_time);
  const object_tokens = [...new Set(tokenize(sem.object_or_value))].sort();
  return deepFreeze({
    claim_id: claim.id ?? null,
    source_sha: sem.source_sha ?? null,
    corpus_digest: sem.corpus_digest ?? null,
    subject_neighbourhood: neighbourhood,
    subject_ref: text(first?.ref ?? first ?? '').trim().toLowerCase() || neighbourhood,
    subject_term: deriveSubjectTerm(sem, neighbourhood),
    subject_resolved,
    predicate_family: sem.predicate_family,
    polarity: derivePolarity(sem),
    modality,
    compatible_modality_class: COMPATIBLE_MODALITY_CLASS[modality] ?? 'other',
    quantifier: text(sem.quantifier) || 'unspecified',
    scope,
    // scope band = structural locus; precise sub-fields drive scope_divergence within the bucket.
    scope_band: stableStringify({ repository: scope.repository, component: scope.component }),
    validity,
    // validity band = bounded vs unbounded overlap class; precise interval drives temporal_divergence.
    validity_band: validity.from == null && validity.until == null ? 'unbounded' : 'bounded',
    object_tokens,
    object_key: object_tokens.join(' '),
    statement: text(sem.object_or_value),
  });
}

/**
 * The candidate-comparison bucket key. Named exactly per the ratified contract; `scope` carries the
 * scope band and `validity_interval` the validity band (see file header — overlap-compatibility, not
 * identity). Two propositions are comparison candidates IFF their bucket keys are equal.
 */
export function bucketKey(proposition) {
  return stableStringify({
    subject_neighbourhood: proposition.subject_neighbourhood,
    predicate_family: proposition.predicate_family,
    scope: proposition.scope_band,
    validity_interval: proposition.validity_band,
    compatible_modality_class: proposition.compatible_modality_class,
  });
}

/**
 * Build a deterministic, snapshot-bound proposition index over slice-1 claim records. Groups
 * propositions into buckets; only same-bucket propositions are comparison candidates. When a
 * snapshot is supplied, every claim must be bound to it (mirrors the documentary-claim ledger's
 * snapshot discipline). Returns an immutable index with bucket introspection + candidate-pair
 * generation. `candidatePairCount` is Σ C(bucket_size, 2); `naivePairCount` is C(total, 2).
 */
export function buildPropositionIndex(claims, { snapshot = null } = {}) {
  if (!Array.isArray(claims)) throw new PropositionIndexError('INVALID_INPUT', 'buildPropositionIndex expects an array of claim records');
  if (snapshot && (!snapshot.source_sha || !snapshot.corpus_digest)) {
    throw new PropositionIndexError('INVALID_SNAPSHOT', 'snapshot must be { source_sha, corpus_digest }');
  }
  const propositions = [];
  for (const claim of claims) {
    const proposition = normalizeClaimToProposition(claim);
    if (snapshot && (proposition.source_sha !== snapshot.source_sha || proposition.corpus_digest !== snapshot.corpus_digest)) {
      throw new PropositionIndexError('SNAPSHOT_MISMATCH', 'claim is not bound to the index snapshot', {
        claim_id: proposition.claim_id, expected: snapshot, got: { source_sha: proposition.source_sha, corpus_digest: proposition.corpus_digest },
      });
    }
    propositions.push(proposition);
  }
  // Deterministic bucket assignment. Bucket iteration order is the sorted key order so two runs over
  // the same claims agree byte-for-byte.
  const bucketMap = new Map();
  propositions.forEach((proposition, position) => {
    const key = bucketKey(proposition);
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key).push({ proposition, position });
  });
  const sortedKeys = [...bucketMap.keys()].sort();
  const buckets = sortedKeys.map(key => {
    const members = bucketMap.get(key)
      .slice()
      .sort((left, right) => (left.proposition.claim_id ?? '').localeCompare(right.proposition.claim_id ?? '') || left.position - right.position)
      .map(entry => entry.proposition);
    return deepFreeze({ key, size: members.length, propositions: members });
  });
  const total = propositions.length;
  const choose2 = n => (n * (n - 1)) / 2;
  const candidatePairCount = buckets.reduce((sum, bucket) => sum + choose2(bucket.size), 0);

  function* candidatePairs() {
    for (const bucket of buckets) {
      for (let i = 0; i < bucket.propositions.length; i += 1) {
        for (let j = i + 1; j < bucket.propositions.length; j += 1) {
          yield { bucket_key: bucket.key, a: bucket.propositions[i], b: bucket.propositions[j] };
        }
      }
    }
  }

  const sizes = buckets.map(bucket => bucket.size);

  return deepFreeze({
    snapshot: snapshot ? { source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest } : null,
    propositions: Object.freeze(propositions.slice()),
    buckets: Object.freeze(buckets),
    bucketCount: buckets.length,
    claimCount: total,
    candidatePairCount,
    naivePairCount: choose2(total),
    bucketSizes: Object.freeze(sizes.slice()),
    candidatePairs,
    bucketFor: proposition => bucketMap.get(bucketKey(proposition))?.map(entry => entry.proposition) ?? [],
  });
}

/** Min / median / p95 / max of a numeric list (integer percentile by nearest-rank). Empty => zeros. */
export function distribution(values) {
  if (!values.length) return { count: 0, min: 0, median: 0, p95: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = fraction => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { count: sorted.length, min: sorted[0], median, p95: rank(0.95), max: sorted[sorted.length - 1] };
}
