// Deterministic sampling and prompt construction for independent held-out semantic evaluation
// (design v2 section 10: "labels from an operator plus a non-proposing model family, disagreement
// recorded"; operator correction, 2026-09-25: "don't use mechanical replay as quality proof").
//
// This module makes ZERO model calls. Sampling, prompt text, response parsing and comparison are
// pure functions; dispatching the built prompt to a model is the caller's job, in a PRIVATE driver
// never committed here -- a real prompt necessarily quotes real witness content (file paths, line
// numbers, claim statements), which is exactly the estate-derived data this repository must never
// carry (AGENTS.md, docs/before-a-pr.md).
//
// The label comparison is explicitly NOT precision/recall against ground truth: an independently
// labeling model is not ground truth either (design v2 section 10: "The map's own agreement is
// never ground truth"). It is agreement/disagreement, meant to be read by a human, not averaged
// into a pass/fail without inspection.
import { sha256 } from '../lib.mjs';
import { canonical, fail } from './schemas.mjs';

export const LABEL_SCHEMA = 'estate-map/ontology-held-out-label/v1';
export const PACKET_SCHEMA = 'estate-map/ontology-held-out-packet/v1';
export const OUTCOME_LABELS = Object.freeze(['member', 'not_member', 'abstain']);
const WILSON_Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion -- the same `{method: 'wilson-95', lower, upper}`
 * shape the design's own generalization schema uses (design v2 section 7.5), chosen there for the
 * reason it is chosen here: it stays sane at small n and at a rate near 0 or 1, unlike a naive
 * normal approximation. This computes an interval on the AGREEMENT rate, never on a precision or
 * recall figure -- there is no ground truth here to compute those against (design v2 section 10).
 */
export function wilsonInterval(successes, total, z = WILSON_Z_95) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total <= 0 || successes > total) {
    fail('HELD_OUT_INTERVAL_INVALID', 'wilsonInterval requires 0 <= successes <= total and total > 0');
  }
  const rate = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total))) / denominator;
  return Object.freeze({ method: 'wilson-95', lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) });
}

/**
 * Deterministic pseudo-random stratified sample: for every (concept_id, outcome) stratum present
 * in `memberships`, up to `perStratum` items, ranked by sha256({seed, membership_id}) rather than
 * insertion or membership_id order -- reproducible for a fixed seed without favoring whichever
 * digest happens to sort first lexically. A stratum with fewer than `perStratum` members yields all
 * of them; a concept whose only real signal is a tiny member count (e.g. capability-caller's 7)
 * is not diluted by an artificially large ask.
 */
export function stratifiedSample(memberships, { perStratum, seed = 'ontology-held-out/v1' }) {
  if (!Number.isInteger(perStratum) || perStratum < 1) {
    fail('HELD_OUT_SAMPLE_INVALID', 'perStratum must be a positive integer');
  }
  const strata = new Map();
  for (const membership of memberships) {
    const key = `${membership.concept_id}\u0000${membership.outcome}`;
    const list = strata.get(key) ?? [];
    list.push(membership);
    strata.set(key, list);
  }
  const sampled = [];
  for (const list of strata.values()) {
    const ranked = list
      .map(membership => ({ membership, rank: sha256(canonical({ seed, membership_id: membership.membership_id })) }))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    sampled.push(...ranked.slice(0, perStratum).map(row => row.membership));
  }
  return sampled;
}

/**
 * A labeling packet: everything an independent judge needs, and nothing the mechanical evaluation
 * decided. Deliberately excludes `outcome`, `confidence`, and `evaluation.trace.result` -- a judge
 * handed the answer cannot meaningfully judge it.
 */
export function buildLabelingPacket(concept, membership) {
  if (concept?.concept_id !== membership?.concept_id) {
    fail('HELD_OUT_PACKET_INVALID', 'packet concept does not match membership.concept_id');
  }
  return Object.freeze({
    schema: PACKET_SCHEMA,
    concept: Object.freeze({
      concept_id: concept.concept_id, stable_key: concept.stable_key, preferred_label: concept.preferred_label,
      definition: concept.definition, does_not_claim: concept.does_not_claim,
    }),
    subject_ref: membership.subject_ref,
    witnesses: membership.witnesses,
  });
}

export function buildLabelingPrompt(packet) {
  const witnessLines = packet.witnesses.length
    ? packet.witnesses.map((witness, index) => `${index + 1}. ${JSON.stringify(witness)}`).join('\n')
    : '(no witnesses were found for this subject)';
  return [
    `Concept: ${packet.concept.preferred_label} (${packet.concept.stable_key})`,
    `Definition: ${packet.concept.definition}`,
    `Does NOT claim: ${packet.concept.does_not_claim}`,
    '',
    // CORRECTED (operator, 2026-09-26, against real held-out answers): this prompt built
    // `packet.subject_ref` into the packet and then never rendered it. Every disagreement on
    // route-handler/envelope-consumer/envelope-publisher/capability-provider said some form of
    // "does not identify which entity is the subject" -- the judge was never TOLD which node_id
    // in the witnesses below (`from`/`to`) was the one being judged.
    `Subject being judged: node_id ${packet.subject_ref.node_id}`,
    '',
    'Evidence available (the only evidence you may use):',
    witnessLines,
    '',
    'Judge independently whether the SUBJECT ABOVE is a member of this concept, given ONLY the',
    'evidence below. Respond with exactly one JSON object and nothing else:',
    '{"outcome": "member"|"not_member"|"abstain", "reason": "<one sentence>"}',
    'Choose "abstain" if the evidence is insufficient to decide either way. Do not assume anything',
    'about the subject beyond what the evidence above states.',
  ].join('\n');
}

/** Fail-closed parse of a model's raw text response into a validated `{outcome, reason}` label. */
export function parseLabelResponse(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '').trim()); }
  catch { fail('HELD_OUT_LABEL_INVALID', 'label response is not valid JSON'); }
  if (!OUTCOME_LABELS.includes(parsed?.outcome)) {
    fail('HELD_OUT_LABEL_INVALID', `label outcome ${JSON.stringify(parsed?.outcome)} is not in the closed vocabulary`);
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    fail('HELD_OUT_LABEL_INVALID', 'label response is missing a reason');
  }
  return Object.freeze({ outcome: parsed.outcome, reason: parsed.reason.trim() });
}

/** Compares one independent label to the mechanical membership it was sampled from. */
export function compareLabel(membership, label) {
  return Object.freeze({
    schema: LABEL_SCHEMA,
    membership_id: membership.membership_id,
    concept_id: membership.concept_id,
    mechanical_outcome: membership.outcome,
    independent_outcome: label.outcome,
    agreement: membership.outcome === label.outcome,
    independent_reason: label.reason,
  });
}

/**
 * Per-concept agreement rate and a breakdown by mechanical outcome. Not precision/recall: there is
 * no ground truth here, only two judgments (design v2 section 10). A low agreement rate means the
 * two disagree and a human should read the disagreements, not that either is "wrong".
 */
export function summarizeComparisons(comparisons) {
  const byConcept = {};
  for (const comparison of comparisons) {
    const bucket = byConcept[comparison.concept_id] ??= { total: 0, agreements: 0, by_mechanical_outcome: {} };
    bucket.total += 1;
    if (comparison.agreement) bucket.agreements += 1;
    const outcomeBucket = bucket.by_mechanical_outcome[comparison.mechanical_outcome] ??= { total: 0, agreements: 0 };
    outcomeBucket.total += 1;
    if (comparison.agreement) outcomeBucket.agreements += 1;
  }
  for (const bucket of Object.values(byConcept)) {
    bucket.agreement_rate = bucket.total ? bucket.agreements / bucket.total : null;
    bucket.confidence_interval_95 = bucket.total ? wilsonInterval(bucket.agreements, bucket.total) : null;
    for (const outcomeBucket of Object.values(bucket.by_mechanical_outcome)) {
      outcomeBucket.agreement_rate = outcomeBucket.total ? outcomeBucket.agreements / outcomeBucket.total : null;
      outcomeBucket.confidence_interval_95 = outcomeBucket.total ? wilsonInterval(outcomeBucket.agreements, outcomeBucket.total) : null;
    }
  }
  return byConcept;
}
