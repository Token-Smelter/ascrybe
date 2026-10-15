// Preserve source witnesses; do not infer authority from naming conventions alone.
import { fail } from './schemas.mjs';
import { OUTCOME_LABELS, wilsonInterval } from './held-out-evaluation.mjs';

export const BLIND_PACKET_SCHEMA = 'estate-map/ontology-blind-packet/v1';
export const BLIND_LABEL_SCHEMA = 'estate-map/ontology-blind-label/v1';
const SOURCE_KINDS = Object.freeze(['entity_file', 'claim_quote']);

/**
 * One hand-authored, plain-language question per concept, written independently of `definition`
 * and `does_not_claim` -- restating the rule in different words would just reproduce the
 * consistency check under a new name. A concept missing here fails closed (`getSemanticQuestion`)
 * rather than silently falling back to the rule's own language.
 */
export const SEMANTIC_INTENT_QUESTIONS = Object.freeze({
  // CORRECTED (operator, 2026-09-26, against real blind-evaluation findings): "provide a callable
  // function" reads as almost any exported symbol -- the judge said "member" for a React component,
  // a `deepFreeze` utility, a fixture generator, none of which are what the sealed concept means.
  // capability-provider/-caller name a FORMAL registration/invocation mechanism (the estate's own
  // `Capability` node and `provides_capability`/`calls_capability` relations), not any callable
  // export. Phrased now to ask about that formal mechanism specifically, in estate-neutral terms.
  'capability-provider': 'Does this code formally REGISTER a capability -- e.g. declaring a named service, tool, or plugin API through the system\'s own capability-registration mechanism, so other code discovers and calls it by that registration -- as opposed to merely exporting a function, class, or component that other code could informally import and call directly?',
  'route-handler': 'Does this code handle an HTTP route: does it respond to an incoming web request?',
  'envelope-publisher': 'Does this code publish or emit an event message to other parts of the system?',
  'envelope-consumer': 'Does this code consume or react to an event message coming from another part of the system?',
  'capability-caller': 'Does this code call a capability THROUGH the system\'s own formal capability-invocation mechanism (looking up and invoking a registered service/tool/plugin API by its registration), as opposed to simply importing and calling an arbitrary function or component directly?',
  'persistence-adapter': 'Does this code read from or write to persistent storage, such as a database table?',
  'external-http-client': 'Does this code make an outgoing HTTP request to an external service?',
  'route-and-event-boundary': 'Does this code both handle an HTTP route and either publish or consume an event message?',
  'documentary-design-rule': 'Does this passage describe an accepted design decision or rule the team intends to follow, rather than a description of what already exists or a rejected/aspirational idea?',
  'documented-current-capability': 'Does this passage describe a capability that currently exists in the system, rather than a historical, proposed, or negative statement?',
  'declaration-supported-claim': 'Is there a real code declaration that matches what this passage claims?',
  'documentary-only-supported-claim': "Is this passage's claim supported only by the document itself, with no matching code declaration or executed verification available?",
  // CORRECTED (operator, 2026-09-26): the prior wording for the three meta-epistemic concepts
  // below ("is it unclear whether...") let the judge hedge to "abstain" meaning "I personally can't
  // tell", confusing the JUDGE's own uncertainty with the SUBJECT's realization status -- the thing
  // actually being asked about. These three now share ONE realization-judgment question (see
  // buildRealizationPrompt/deriveOutcomeFromRealization); this entry is retained only as the
  // human-readable label for that shared question, not sent to a judge directly.
  'unresolved-proof-obligation-claim': '(asked via the shared realization-judgment question, not this text -- see buildRealizationPrompt)',
  'partially-realized-claim': '(asked via the shared realization-judgment question, not this text -- see buildRealizationPrompt)',
  'unknown-realization-claim': '(asked via the shared realization-judgment question, not this text -- see buildRealizationPrompt)',
});

/** The three epistemic-standing concepts whose blind evaluation uses the realization-judgment flow
 * (buildRealizationPrompt / parseRealizationResponse / deriveOutcomeFromRealization) instead of the
 * generic member/not_member/abstain question. */
export const REALIZATION_JUDGMENT_CONCEPTS = Object.freeze([
  'unresolved-proof-obligation-claim', 'partially-realized-claim', 'unknown-realization-claim',
]);

export function getSemanticQuestion(stableKey) {
  const question = SEMANTIC_INTENT_QUESTIONS[stableKey];
  if (!question) fail('SEMANTIC_QUESTION_MISSING', `no plain-language question authored for stable_key ${stableKey}`);
  return question;
}

/**
 * A blind packet: a plain-language question and a raw source excerpt, nothing else. `membership_id`
 * is carried for bookkeeping only (rejoining a label to the mechanical outcome later) -- callers
 * must not render it or `concept_id` into the prompt text.
 */
export function buildBlindPacket({ concept, membership, sourceExcerpt, sourceKind }) {
  if (concept?.concept_id !== membership?.concept_id) {
    fail('BLIND_PACKET_INVALID', 'packet concept does not match membership.concept_id');
  }
  if (typeof sourceExcerpt !== 'string' || !sourceExcerpt.trim()) {
    fail('BLIND_PACKET_INVALID', 'sourceExcerpt must be a non-empty string');
  }
  if (!SOURCE_KINDS.includes(sourceKind)) {
    fail('BLIND_PACKET_INVALID', `sourceKind must be one of ${SOURCE_KINDS.join(', ')}`);
  }
  return Object.freeze({
    schema: BLIND_PACKET_SCHEMA,
    membership_id: membership.membership_id,
    concept_id: concept.concept_id,
    stable_key: concept.stable_key,
    question: getSemanticQuestion(concept.stable_key),
    source_kind: sourceKind,
    source_excerpt: sourceExcerpt,
  });
}

export function buildBlindPrompt(packet) {
  return [
    packet.question,
    '',
    'Base your answer ONLY on the source excerpt below -- real project source, not a description of',
    'a rule or a summary of one.',
    '',
    'Source excerpt:',
    '"""',
    packet.source_excerpt,
    '"""',
    '',
    'Respond with exactly one JSON object and nothing else:',
    '{"outcome": "member"|"not_member"|"abstain", "reason": "<one sentence>"}',
    'Use "member" for yes, "not_member" for no, and "abstain" only if the excerpt genuinely does not',
    'let you tell either way.',
  ].join('\n');
}

// Manifest keys that commonly name a plugin/aggregate subject's primary code file, checked as
// whole-line `key: value` pairs (YAML-shaped, but read without a YAML parser -- only ever used to
// find a path to fetch, never to validate manifest structure). Kept short and generic: this is a
// widely-used convention (a plugin manifest naming its own entry point), not any one estate's
// specific schema.
const ENTRY_POINT_MANIFEST_KEYS = Object.freeze(['entry_point', 'main', 'server']);

/**
 * Finds candidate primary-code-file paths named by a plugin/aggregate manifest (operator
 * instruction, 2026-09-26: "a bounded bundle of the manifest plus entry-point/server files").
 * Pure string parsing, no I/O -- fetching the paths this returns is the caller's job. Returns at
 * most `limit` distinct, order-preserving paths with a leading `./` stripped.
 */
export function parsePluginEntryPointPaths(manifestText, { limit = 3 } = {}) {
  if (typeof manifestText !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const line of manifestText.split('\n')) {
    const match = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+?)\s*$/);
    if (!match || !ENTRY_POINT_MANIFEST_KEYS.includes(match[1])) continue;
    const path = match[2].replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    found.push(path);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * Assembles an entity's blind excerpt as a pure function of its OWN kind and already-fetched file
 * content -- never of which concept or mechanical outcome is being tested (operator instruction,
 * 2026-09-26: "never choose an excerpt from the rule's witnesses, or member samples get steered
 * toward agreement"). A Module/Referent gets its own file; a Plugin gets its manifest bundled with
 * whatever entry-point/server files the manifest itself names -- the SAME bundle regardless of
 * which sample (member, not_member, or abstain) it was drawn for.
 */
export function buildEntityExcerptText({ kind, path, content, extraFiles = [] }) {
  if (typeof content !== 'string') fail('ENTITY_EXCERPT_INVALID', 'buildEntityExcerptText requires the primary file\'s content');
  const parts = [`File: ${path}`, '', content];
  for (const extra of extraFiles) {
    if (extra?.content == null) continue;
    parts.push('', `--- bundled file (named by the manifest above): ${extra.path} ---`, extra.content);
  }
  return parts.join('\n');
}

/** Re-export so callers of this module do not also need to import held-out-evaluation.mjs. */
export { parseLabelResponse } from './held-out-evaluation.mjs';

// CORRECTED (operator, 2026-09-26): replaces a prior per-concept "is it unclear whether..."
// question for the three meta-epistemic concepts (see SEMANTIC_INTENT_QUESTIONS above) that
// confused the JUDGE's own uncertainty with the SUBJECT's realization status. One shared,
// closed-vocabulary realization judgment now grounds all three; membership is DERIVED
// mechanically from the answer (deriveOutcomeFromRealization), never asked for directly.
export const REALIZATION_LABELS = Object.freeze(['implemented', 'partial', 'not_implemented', 'does_not_address']);

export function buildRealizationPrompt(packet) {
  return [
    'Based ONLY on the source excerpt below, what is the realization status of the claim quoted in it?',
    '',
    'Source excerpt:',
    '"""',
    packet.source_excerpt,
    '"""',
    '',
    'Respond with exactly one JSON object and nothing else:',
    '{"realization": "implemented"|"partial"|"not_implemented"|"does_not_address", "reason": "<one sentence>"}',
    'implemented: the excerpt shows the claimed behavior fully implemented and working.',
    'partial: the excerpt shows some but not all of the claimed behavior implemented.',
    'not_implemented: the excerpt shows the claimed behavior does NOT exist (explicitly absent, stubbed, or contradicted).',
    'does_not_address: the excerpt does not contain enough information to judge implementation status either way.',
  ].join('\n');
}

/** Fail-closed parse of a realization-judgment response into a validated {realization, reason}. */
export function parseRealizationResponse(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '').trim()); }
  catch { fail('REALIZATION_LABEL_INVALID', 'realization response is not valid JSON'); }
  if (!REALIZATION_LABELS.includes(parsed?.realization)) {
    fail('REALIZATION_LABEL_INVALID', `realization ${JSON.stringify(parsed?.realization)} is not in the closed vocabulary`);
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    fail('REALIZATION_LABEL_INVALID', 'realization response is missing a reason');
  }
  return Object.freeze({ realization: parsed.realization, reason: parsed.reason.trim() });
}

// Derivation table (operator, 2026-09-26): a realization judgment settles all three concepts at
// once. "does_not_address" is the only answer that makes unresolved-proof-obligation-claim and
// unknown-realization-claim true -- both are about the evidence leaving the question open, which
// is exactly what that answer means. "partial" is the only answer that makes
// partially-realized-claim true. "implemented" and "not_implemented" are both settled findings, so
// they make all three false: a settled finding is not an unresolved obligation, and a full
// implementation or a confirmed absence is neither "partial" nor "unknown".
const REALIZATION_DERIVATION = Object.freeze({
  implemented: { 'unresolved-proof-obligation-claim': 'not_member', 'partially-realized-claim': 'not_member', 'unknown-realization-claim': 'not_member' },
  partial: { 'unresolved-proof-obligation-claim': 'not_member', 'partially-realized-claim': 'member', 'unknown-realization-claim': 'not_member' },
  not_implemented: { 'unresolved-proof-obligation-claim': 'not_member', 'partially-realized-claim': 'not_member', 'unknown-realization-claim': 'not_member' },
  does_not_address: { 'unresolved-proof-obligation-claim': 'member', 'partially-realized-claim': 'not_member', 'unknown-realization-claim': 'member' },
});

export function deriveOutcomeFromRealization(stableKey, realization) {
  if (!REALIZATION_LABELS.includes(realization)) fail('REALIZATION_LABEL_INVALID', `realization ${realization} is not in the closed vocabulary`);
  const row = REALIZATION_DERIVATION[realization];
  if (!(stableKey in row)) fail('REALIZATION_LABEL_INVALID', `${stableKey} is not one of the realization-judgment concepts`);
  return row[stableKey];
}

/** Joins an independent blind label back to the mechanical membership it was sampled from. */
export function compareBlindLabel(membership, label) {
  return Object.freeze({
    schema: BLIND_LABEL_SCHEMA,
    membership_id: membership.membership_id,
    concept_id: membership.concept_id,
    mechanical_outcome: membership.outcome,
    judge_outcome: label.outcome,
    judge_reason: label.reason,
  });
}

/**
 * TP/FP/FN/TN over a set of compared labels, treating "member" as the positive class on both
 * sides. FP and TN both require mechanical_outcome === 'member' or !== 'member' respectively by
 * definition, so this is only meaningful when `comparisons` is a stratified sample (one stratum
 * per mechanical outcome), not an arbitrary subset.
 */
export function confusionCounts(comparisons) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const comparison of comparisons) {
    if (!OUTCOME_LABELS.includes(comparison.mechanical_outcome) || !OUTCOME_LABELS.includes(comparison.judge_outcome)) {
      fail('BLIND_LABEL_INVALID', 'confusionCounts requires closed-vocabulary outcomes');
    }
    const mechPositive = comparison.mechanical_outcome === 'member';
    const judgePositive = comparison.judge_outcome === 'member';
    if (mechPositive && judgePositive) tp += 1;
    else if (mechPositive && !judgePositive) fp += 1;
    else if (!mechPositive && judgePositive) fn += 1;
    else tn += 1;
  }
  return Object.freeze({ tp, fp, fn, tn });
}

/**
 * Precision needs no population reweighting: TP and FP are both drawn entirely from the
 * mechanical-member stratum, so the sample rate within it IS the precision estimate, and the exact
 * Wilson interval over it is exactly correct (not an approximation), unlike recall below.
 */
export function precisionFromMemberStratum(memberStratumComparisons) {
  const total = memberStratumComparisons.length;
  if (!total) return Object.freeze({ point_estimate: null, confidence_interval_95: null, tp: 0, total: 0 });
  const tp = memberStratumComparisons.filter(c => c.judge_outcome === 'member').length;
  return Object.freeze({ point_estimate: tp / total, confidence_interval_95: wilsonInterval(tp, total), tp, total });
}

// Deterministic seeded PRNG (mulberry32) and an exact Gamma(k, 1) sampler for integer k (sum of k
// i.i.d. Exponential(1) draws, -ln(U)) -- used to build a Beta(successes+1, failures+1) posterior
// draw per Monte Carlo iteration. Chosen over a normal approximation because a stratum can have a
// rate near 0 or a handful of samples, where a Beta posterior stays inside [0, 1] and a normal
// approximation would not.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(seed) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sampleGamma(shape, rng) {
  let sum = 0;
  for (let i = 0; i < shape; i += 1) sum += -Math.log(1 - rng());
  return sum;
}

function sampleBeta(successes, failures, rng) {
  const a = successes + 1, b = failures + 1; // uniform-prior (Bayes-Laplace) posterior
  const ga = sampleGamma(a, rng), gb = sampleGamma(b, rng);
  return ga / (ga + gb);
}

/**
 * Population-weighted recall estimate. Precision's positive/negative counts both come from the
 * mechanical-member stratum; recall's do not -- a false negative is a mechanically not_member OR
 * abstain sample the judge calls "member", and that stratum was deliberately over-sampled relative
 * to its true frequency (design intent: don't dilute rare-positive strata). Reweighting each
 * stratum's sampled member-rate by its EXACT population size (known from the Phase 1 build, not
 * estimated) corrects for that, and the Monte Carlo draw over independent Beta posteriors for each
 * of the three strata gives a interval on the resulting ratio, which has no closed-form Wilson
 * equivalent once three independent proportions are combined this way.
 */
export function estimateRecall({ memberSample, notMemberSample, abstainSample, populationSizes, draws = 5000, seed = 'ontology-semantic-audit/recall' }) {
  for (const size of [populationSizes?.member, populationSizes?.not_member, populationSizes?.abstain]) {
    if (!Number.isInteger(size) || size < 0) fail('BLIND_RECALL_INVALID', 'populationSizes must give non-negative integer sizes for member, not_member and abstain');
  }
  const rate = sample => sample.length ? sample.filter(c => c.judge_outcome === 'member').length / sample.length : 0;
  const successes = sample => sample.filter(c => c.judge_outcome === 'member').length;
  const strata = {
    member: { sample: memberSample, n: populationSizes.member },
    not_member: { sample: notMemberSample, n: populationSizes.not_member },
    abstain: { sample: abstainSample, n: populationSizes.abstain },
  };
  const rates = Object.fromEntries(Object.entries(strata).map(([key, { sample }]) => [key, rate(sample)]));
  const tpHat = rates.member * strata.member.n;
  const fnHat = rates.not_member * strata.not_member.n + rates.abstain * strata.abstain.n;
  const pointEstimate = (tpHat + fnHat) > 0 ? tpHat / (tpHat + fnHat) : null;

  const rng = mulberry32(seedFromString(seed));
  const draws_ = [];
  for (let i = 0; i < draws; i += 1) {
    const pMember = strata.member.sample.length ? sampleBeta(successes(strata.member.sample), strata.member.sample.length - successes(strata.member.sample), rng) : 0;
    const pNotMember = strata.not_member.sample.length ? sampleBeta(successes(strata.not_member.sample), strata.not_member.sample.length - successes(strata.not_member.sample), rng) : 0;
    const pAbstain = strata.abstain.sample.length ? sampleBeta(successes(strata.abstain.sample), strata.abstain.sample.length - successes(strata.abstain.sample), rng) : 0;
    const tp = pMember * strata.member.n;
    const fn = pNotMember * strata.not_member.n + pAbstain * strata.abstain.n;
    draws_.push((tp + fn) > 0 ? tp / (tp + fn) : 0);
  }
  draws_.sort((a, b) => a - b);
  const lowerIdx = Math.floor(0.025 * draws_.length);
  const upperIdx = Math.min(draws_.length - 1, Math.ceil(0.975 * draws_.length) - 1);

  return Object.freeze({
    point_estimate: pointEstimate,
    confidence_interval_95: draws_.length ? Object.freeze({ method: 'monte-carlo-beta-95', lower: draws_[lowerIdx], upper: draws_[upperIdx] }) : null,
    per_stratum: Object.fromEntries(Object.entries(strata).map(([key, { sample, n }]) => [key, {
      sample_size: sample.length, sample_member_rate: rate(sample), population_size: n,
    }])),
  });
}
