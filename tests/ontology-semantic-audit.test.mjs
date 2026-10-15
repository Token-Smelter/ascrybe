import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEMANTIC_INTENT_QUESTIONS, REALIZATION_JUDGMENT_CONCEPTS, getSemanticQuestion, buildBlindPacket, buildBlindPrompt,
  compareBlindLabel, confusionCounts, precisionFromMemberStratum, estimateRecall,
  REALIZATION_LABELS, buildRealizationPrompt, parseRealizationResponse, deriveOutcomeFromRealization,
  parsePluginEntryPointPaths, buildEntityExcerptText,
} from '../tools/ontology/semantic-audit.mjs';

const CONCEPT = Object.freeze({
  concept_id: 'ontology-concept:acme:AR-0002', stable_key: 'route-handler', preferred_label: 'Route handler',
  definition: 'An estate entity from which at least one exposes_route or registers_route relation originates.',
  does_not_claim: 'that the route is reachable at runtime',
});
const MEMBERSHIP = Object.freeze({ membership_id: 'ontology-membership:invented-1', concept_id: CONCEPT.concept_id, outcome: 'member' });

test('every sealed stable_key in the Phase 1 catalog is covered, either by a plain-language question or the shared realization judgment', () => {
  const stableKeys = [
    'capability-provider', 'route-handler', 'envelope-publisher', 'envelope-consumer', 'capability-caller',
    'persistence-adapter', 'external-http-client', 'route-and-event-boundary',
    'documentary-design-rule', 'documented-current-capability', 'declaration-supported-claim',
    'documentary-only-supported-claim', 'unresolved-proof-obligation-claim', 'partially-realized-claim',
    'unknown-realization-claim',
  ];
  for (const key of stableKeys) {
    assert.ok(SEMANTIC_INTENT_QUESTIONS[key], `missing SEMANTIC_INTENT_QUESTIONS entry for ${key}`);
    if (!REALIZATION_JUDGMENT_CONCEPTS.includes(key)) assert.ok(SEMANTIC_INTENT_QUESTIONS[key].includes('?'), `missing question for ${key}`);
  }
});

test('getSemanticQuestion fails closed for an unknown stable_key', () => {
  assert.throws(() => getSemanticQuestion('not-a-real-concept'));
});

test('buildBlindPacket refuses a concept/membership mismatch', () => {
  const wrongMembership = { ...MEMBERSHIP, concept_id: 'ontology-concept:acme:AR-9999' };
  assert.throws(() => buildBlindPacket({ concept: CONCEPT, membership: wrongMembership, sourceExcerpt: 'x', sourceKind: 'entity_file' }));
});

test('buildBlindPacket refuses an empty source excerpt', () => {
  assert.throws(() => buildBlindPacket({ concept: CONCEPT, membership: MEMBERSHIP, sourceExcerpt: '   ', sourceKind: 'entity_file' }));
});

test('buildBlindPrompt never mentions the rule, witnesses, or the mechanical outcome', () => {
  const packet = buildBlindPacket({
    concept: CONCEPT, membership: MEMBERSHIP, sourceKind: 'entity_file',
    sourceExcerpt: 'export function handleWidgetRoute(req, res) { res.json(listWidgets()); }',
  });
  const prompt = buildBlindPrompt(packet);
  for (const forbidden of ['witness', 'rule_digest', 'clause', 'trace', 'evaluator', 'mechanical', 'member_id', CONCEPT.definition, CONCEPT.does_not_claim]) {
    assert.ok(!prompt.includes(forbidden), `prompt leaked forbidden term: ${forbidden}`);
  }
  assert.ok(prompt.includes(CONCEPT_QUESTION_FOR('route-handler')));
  assert.ok(prompt.includes('handleWidgetRoute'));
});

function CONCEPT_QUESTION_FOR(stableKey) { return SEMANTIC_INTENT_QUESTIONS[stableKey]; }

test('compareBlindLabel joins a label back to its mechanical membership without exposing it in the packet', () => {
  const comparison = compareBlindLabel(MEMBERSHIP, { outcome: 'not_member', reason: 'no route decorator present' });
  assert.equal(comparison.mechanical_outcome, 'member');
  assert.equal(comparison.judge_outcome, 'not_member');
  assert.equal(comparison.membership_id, MEMBERSHIP.membership_id);
});

test('confusionCounts classifies a mixed set of comparisons correctly', () => {
  const comparisons = [
    { mechanical_outcome: 'member', judge_outcome: 'member' },   // TP
    { mechanical_outcome: 'member', judge_outcome: 'not_member' }, // FP
    { mechanical_outcome: 'not_member', judge_outcome: 'member' }, // FN
    { mechanical_outcome: 'not_member', judge_outcome: 'not_member' }, // TN
    { mechanical_outcome: 'abstain', judge_outcome: 'member' }, // FN
    { mechanical_outcome: 'abstain', judge_outcome: 'abstain' }, // TN
  ];
  assert.deepEqual(confusionCounts(comparisons), { tp: 1, fp: 1, fn: 2, tn: 2 });
});

test('precisionFromMemberStratum is the exact Wilson interval over the member-stratum judge-agreement rate', () => {
  const memberStratum = [
    { judge_outcome: 'member' }, { judge_outcome: 'member' }, { judge_outcome: 'member' }, { judge_outcome: 'not_member' },
  ];
  const result = precisionFromMemberStratum(memberStratum);
  assert.equal(result.tp, 3);
  assert.equal(result.total, 4);
  assert.equal(result.point_estimate, 0.75);
  assert.ok(result.confidence_interval_95.lower < 0.75 && result.confidence_interval_95.upper > 0.75);
});

test('precisionFromMemberStratum returns nulls for an empty stratum rather than dividing by zero', () => {
  const result = precisionFromMemberStratum([]);
  assert.equal(result.point_estimate, null);
  assert.equal(result.confidence_interval_95, null);
});

test('estimateRecall reweights by exact population size, not raw sample counts', () => {
  // Member stratum: sampled 10, all agree (rule precision within-stratum is perfect).
  // Not-member stratum: sampled 10 of a population of 1000, judge says "member" (a miss) in 1 of them.
  // Abstain stratum: sampled 10 of a population of 100, judge never says "member".
  const memberSample = Array.from({ length: 10 }, () => ({ judge_outcome: 'member' }));
  const notMemberSample = Array.from({ length: 10 }, (_, i) => ({ judge_outcome: i === 0 ? 'member' : 'not_member' }));
  const abstainSample = Array.from({ length: 10 }, () => ({ judge_outcome: 'abstain' }));
  const result = estimateRecall({
    memberSample, notMemberSample, abstainSample,
    populationSizes: { member: 10, not_member: 1000, abstain: 100 },
    seed: 'test-seed-1',
  });
  // tpHat = 1.0*10 = 10; fnHat = 0.1*1000 + 0*100 = 100; recall = 10/110
  assert.ok(Math.abs(result.point_estimate - 10 / 110) < 1e-9);
  assert.ok(result.confidence_interval_95.lower <= result.point_estimate);
  assert.ok(result.confidence_interval_95.upper >= result.point_estimate);
});

test('estimateRecall is deterministic for a fixed seed', () => {
  const memberSample = [{ judge_outcome: 'member' }, { judge_outcome: 'not_member' }];
  const notMemberSample = [{ judge_outcome: 'not_member' }, { judge_outcome: 'member' }];
  const abstainSample = [{ judge_outcome: 'abstain' }];
  const args = { memberSample, notMemberSample, abstainSample, populationSizes: { member: 5, not_member: 50, abstain: 20 }, seed: 'fixed-seed' };
  const a = estimateRecall(args);
  const b = estimateRecall(args);
  assert.deepEqual(a.confidence_interval_95, b.confidence_interval_95);
});

test('estimateRecall rejects a non-integer population size', () => {
  assert.throws(() => estimateRecall({
    memberSample: [], notMemberSample: [], abstainSample: [],
    populationSizes: { member: 1.5, not_member: 10, abstain: 10 },
  }));
});

test('buildRealizationPrompt asks for a closed-vocabulary realization judgment, never the rule fields', () => {
  const prompt = buildRealizationPrompt({ source_excerpt: 'export function handleWidgetRoute() {}' });
  for (const label of REALIZATION_LABELS) assert.ok(prompt.includes(label));
  for (const forbidden of ['witness', 'rule_digest', 'mechanical', 'unclear', 'is it unclear']) {
    assert.ok(!prompt.toLowerCase().includes(forbidden.toLowerCase()), `prompt leaked forbidden term: ${forbidden}`);
  }
});

test('parseRealizationResponse fails closed on a label outside the closed vocabulary', () => {
  assert.throws(() => parseRealizationResponse(JSON.stringify({ realization: 'sort_of', reason: 'x' })));
  assert.throws(() => parseRealizationResponse(JSON.stringify({ realization: 'implemented' })));
  const parsed = parseRealizationResponse(JSON.stringify({ realization: 'partial', reason: 'half done' }));
  assert.equal(parsed.realization, 'partial');
});

test('deriveOutcomeFromRealization: does_not_address is the only answer that makes the two unknown/unresolved concepts true', () => {
  for (const stableKey of ['unresolved-proof-obligation-claim', 'unknown-realization-claim']) {
    assert.equal(deriveOutcomeFromRealization(stableKey, 'does_not_address'), 'member');
    assert.equal(deriveOutcomeFromRealization(stableKey, 'implemented'), 'not_member');
    assert.equal(deriveOutcomeFromRealization(stableKey, 'partial'), 'not_member');
    assert.equal(deriveOutcomeFromRealization(stableKey, 'not_implemented'), 'not_member');
  }
});

test('deriveOutcomeFromRealization: partial is the only answer that makes partially-realized-claim true', () => {
  assert.equal(deriveOutcomeFromRealization('partially-realized-claim', 'partial'), 'member');
  for (const label of ['implemented', 'not_implemented', 'does_not_address']) {
    assert.equal(deriveOutcomeFromRealization('partially-realized-claim', label), 'not_member');
  }
});

test('deriveOutcomeFromRealization fails closed for a concept outside the realization-judgment set', () => {
  assert.throws(() => deriveOutcomeFromRealization('route-handler', 'partial'));
});

test('every REALIZATION_JUDGMENT_CONCEPTS entry derives from every REALIZATION_LABELS value without throwing', () => {
  for (const stableKey of REALIZATION_JUDGMENT_CONCEPTS) {
    for (const label of REALIZATION_LABELS) assert.doesNotThrow(() => deriveOutcomeFromRealization(stableKey, label));
  }
});

test('parsePluginEntryPointPaths finds entry_point/main/server keys and strips a leading ./', () => {
  const manifest = [
    'name: widget-plugin',
    'version: 1.0.0',
    'entry_point: ./server/index.mjs',
    'description: a widget plugin',
  ].join('\n');
  assert.deepEqual(parsePluginEntryPointPaths(manifest), ['server/index.mjs']);
});

test('parsePluginEntryPointPaths returns no paths for a manifest naming none, and de-duplicates repeats', () => {
  assert.deepEqual(parsePluginEntryPointPaths('name: widget-plugin\nversion: 1.0.0'), []);
  const repeated = 'entry_point: ./a.mjs\nmain: ./a.mjs\nserver: ./b.mjs';
  assert.deepEqual(parsePluginEntryPointPaths(repeated), ['a.mjs', 'b.mjs']);
});

test('buildEntityExcerptText bundles extra files identically regardless of any external factor (pure function of kind/content)', () => {
  const withoutBundle = buildEntityExcerptText({ kind: 'Module', path: 'src/widget.mjs', content: 'export const widget = 1;' });
  assert.ok(withoutBundle.includes('src/widget.mjs'));
  assert.ok(withoutBundle.includes('export const widget = 1;'));
  assert.ok(!withoutBundle.includes('bundled file'));

  const withBundle = buildEntityExcerptText({
    kind: 'Plugin', path: 'plugins/widget/plugin.yaml', content: 'entry_point: ./server/index.mjs',
    extraFiles: [{ path: 'plugins/widget/server/index.mjs', content: 'export function start() {}' }],
  });
  assert.ok(withBundle.includes('plugin.yaml'));
  assert.ok(withBundle.includes('bundled file'));
  assert.ok(withBundle.includes('export function start() {}'));
});

test('buildEntityExcerptText refuses missing primary content', () => {
  assert.throws(() => buildEntityExcerptText({ kind: 'Module', path: 'src/widget.mjs', content: undefined }));
});
