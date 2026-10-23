import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planInvocation } from '../bin/ascrybe.mjs';
import { validateEstateMapRuntimeConfig } from '../tools/ascrybe-config.mjs';
import { reportModelTierUsage, runModelTierUsageCli } from '../tools/model-usage.mjs';

function role(name, thinking, concurrency = 2) {
  return {
    runner: 'pi', name, thinking, concurrency, window_bytes: 4000, timeout_ms: 600000,
    max_event_bytes: 536870912, max_answer_bytes: 4194304,
  };
}

function fixture() {
  return {
    schema: 'estate-map/runtime-config/v1',
    models: {
      documentary_claims: role('example-provider/ledger-reader', 'off', 4),
      code_claims: role('example-provider/graph-reader', 'low', 3),
      evaluation_arm: role('example-provider/review-arm', 'high', 2),
      evaluation_judge: role('example-provider/review-judge', 'high', 2),
    },
    neo4j: {
      uri_env: 'ASCRYBE_NEO4J_URI', username_env: 'ASCRYBE_NEO4J_USERNAME',
      password_env: 'ASCRYBE_NEO4J_PASSWORD',
    },
    projection: { batch_size: 500, default_view: 'selected' },
    dashboard: { host: '127.0.0.1', port: 8790, neighbor_limit: 120, overview_limit: 100 },
  };
}

function codes(inputs) {
  return inputs.map(input => {
    try { validateEstateMapRuntimeConfig(input); return null; }
    catch (error) { return error.code; }
  });
}

function priced(model, cost) {
  return { tag: `${model}:${cost}`, model, billing_status: 'reported', cost, cost_reported: true,
    input_tokens: 10, output_tokens: 2, total_tokens: 12 };
}

const root = fileURLToPath(new URL('..', import.meta.url));
const callsFixture = fileURLToPath(new URL('./fixtures/model-tier-usage/calls.json', import.meta.url));
const configFixture = fileURLToPath(new URL('./fixtures/model-tier-usage/config.json', import.meta.url));
const ambiguousFixture = fileURLToPath(new URL('./fixtures/model-tier-usage/config-ambiguous.json', import.meta.url));

test('a config without model tiers validates with those keys absent', () => {
  const config = validateEstateMapRuntimeConfig(fixture());
  assert.equal(Object.hasOwn(config, 'model_tiers'), false);
  assert.equal(Object.hasOwn(config, 'tier_targets'), false);
  assert.equal(config.models.documentary_claims.name, 'example-provider/ledger-reader');
  assert.equal(config.models.documentary_claims.concurrency, 4);
});

test('partial tiers are accepted and targets stay off the model roles', () => {
  const input = fixture();
  input.model_tiers = { small: 'documentary_claims', large: 'evaluation_judge' };
  input.tier_targets = { small: 0.25 };
  const config = validateEstateMapRuntimeConfig(input);
  assert.deepEqual(config.model_tiers, { small: 'documentary_claims', large: 'evaluation_judge' });
  assert.equal(Object.hasOwn(config.model_tiers, 'medium'), false);
  assert.deepEqual(config.tier_targets, { small: 0.25 });
  assert.equal(config.models.documentary_claims.tier, undefined);
  assert.equal(config.models.documentary_claims.concurrency, 4);
});

test('unknown tiers, unknown roles, and extra fields are typed refusals', () => {
  const unknownTier = fixture();
  unknownTier.model_tiers = { tiny: 'code_claims' };
  const extra = fixture();
  extra.model_tiers = { small: 'documentary_claims', note: 'not a tier' };
  const unknownRole = fixture();
  unknownRole.model_tiers = { small: 'missing_role' };
  const notObject = fixture();
  notObject.model_tiers = ['documentary_claims'];
  assert.deepEqual(codes([unknownTier, extra, unknownRole, notObject]), [
    'RUNTIME_CONFIG_UNKNOWN_FIELD', 'RUNTIME_CONFIG_UNKNOWN_FIELD',
    'RUNTIME_CONFIG_MODEL_TIER_ROLE_INVALID', 'RUNTIME_CONFIG_INVALID',
  ]);
  try { validateEstateMapRuntimeConfig(unknownRole); }
  catch (error) {
    assert.equal(error.detail.tier, 'small');
    assert.equal(error.detail.role, 'missing_role');
  }
});

test('tier targets must be finite unit shares of declared tiers and sum to at most 1', () => {
  const base = fixture();
  base.model_tiers = { small: 'documentary_claims', medium: 'code_claims' };
  const high = structuredClone(base); high.tier_targets = { small: 1.1 };
  const negative = structuredClone(base); negative.tier_targets = { small: -0.01 };
  const notFinite = structuredClone(base); notFinite.tier_targets = { small: Number.NaN };
  const infinite = structuredClone(base); infinite.tier_targets = { medium: Number.POSITIVE_INFINITY };
  const text = structuredClone(base); text.tier_targets = { small: '0.2' };
  const sum = structuredClone(base); sum.tier_targets = { small: 0.6, medium: 0.6 };
  const undeclared = structuredClone(base); undeclared.tier_targets = { large: 0.2 };
  const unknown = structuredClone(base); unknown.tier_targets = { tiny: 0.2 };
  assert.deepEqual(codes([high, negative, notFinite, infinite, text, sum, undeclared, unknown]), [
    'RUNTIME_CONFIG_TIER_TARGET_INVALID', 'RUNTIME_CONFIG_TIER_TARGET_INVALID',
    'RUNTIME_CONFIG_TIER_TARGET_INVALID', 'RUNTIME_CONFIG_TIER_TARGET_INVALID',
    'RUNTIME_CONFIG_TIER_TARGET_INVALID', 'RUNTIME_CONFIG_TIER_TARGET_SUM',
    'RUNTIME_CONFIG_TIER_TARGET_UNDECLARED', 'RUNTIME_CONFIG_UNKNOWN_FIELD',
  ]);
  const exact = structuredClone(base);
  exact.tier_targets = { small: 0.1, medium: 0.2 };
  exact.model_tiers = { ...exact.model_tiers, large: 'evaluation_arm' };
  exact.tier_targets = { small: 0.1, medium: 0.2, large: 0.7 };
  assert.deepEqual(validateEstateMapRuntimeConfig(exact).tier_targets,
    { small: 0.1, medium: 0.2, large: 0.7 });
  const full = structuredClone(base);
  full.tier_targets = { small: 1 };
  assert.equal(validateEstateMapRuntimeConfig(full).tier_targets.small, 1);
  const halves = structuredClone(base);
  halves.tier_targets = { small: 0.5, medium: 0.5 };
  assert.deepEqual(validateEstateMapRuntimeConfig(halves).tier_targets, { small: 0.5, medium: 0.5 });
  // 0.33 + 0.56 + 0.11 is a true decimal total of 1 that addition lands one ulp above 1.
  const unitNoise = structuredClone(base);
  unitNoise.model_tiers = { ...unitNoise.model_tiers, large: 'evaluation_arm' };
  unitNoise.tier_targets = { small: 0.33, medium: 0.56, large: 0.11 };
  assert.deepEqual(validateEstateMapRuntimeConfig(unitNoise).tier_targets,
    { small: 0.33, medium: 0.56, large: 0.11 });
  const boundary = JSON.parse(readFileSync(configFixture, 'utf8'));
  boundary.tier_targets = { small: 0.5, medium: 0.5000001 };
  assert.throws(() => validateEstateMapRuntimeConfig(boundary), error => {
    assert.equal(error.code, 'RUNTIME_CONFIG_TIER_TARGET_SUM');
    assert.ok(error.detail.sum > 1);
    assert.equal(error.detail.targets.small, 0.5);
    assert.equal(error.detail.targets.medium, 0.5000001);
    assert.notEqual(Number(error.detail.sum.toFixed(6)), error.detail.sum);
    return true;
  });
});

test('two tiers on the same exact model are refused by name, including different thinking levels', () => {
  const input = fixture();
  input.models.code_claims = role('example-provider/ledger-reader', 'high', 3);
  input.model_tiers = { small: 'documentary_claims', medium: 'code_claims' };
  try {
    validateEstateMapRuntimeConfig(input);
    assert.fail('same model must not validate');
  } catch (error) {
    assert.equal(error.code, 'RUNTIME_CONFIG_MODEL_TIER_AMBIGUOUS');
    assert.deepEqual(error.detail.tiers, ['small', 'medium']);
    assert.equal(error.detail.model, 'example-provider/ledger-reader');
    assert.match(error.message, /small and medium/u);
    assert.match(error.message, /example-provider\/ledger-reader/u);
    assert.match(error.message, /thinking/u);
  }
});

test('the shipped example declares distinct invented tier models and report-only targets', () => {
  const example = validateEstateMapRuntimeConfig(JSON.parse(
    readFileSync(new URL('../ascrybe.config.example.json', import.meta.url), 'utf8')));
  const names = Object.values(example.model_tiers).map(roleName => example.models[roleName].name);
  assert.deepEqual(Object.keys(example.model_tiers), ['small', 'medium', 'large']);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => name.startsWith('<example-provider/')));
  const sum = Object.values(example.tier_targets).reduce((total, value) => total + value, 0);
  assert.ok(sum <= 1);
  assert.equal(example.models.documentary_claims.tier, undefined);
});

test('priced calls map to declared tiers, and a zero denominator is null rather than a fabricated share', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims', medium: 'code_claims' },
    tier_targets: { small: 0.2, medium: 0.5 },
  });
  const calls = [
    priced('example-provider/ledger-reader', 0.25),
    priced('example-provider/ledger-reader', 0.25),
    priced('example-provider/graph-reader', 0.5),
    priced('example-provider/other', 1),
  ];
  const before = structuredClone(calls);
  const report = reportModelTierUsage(calls, config);
  assert.deepEqual(calls, before);
  assert.equal(report.schema, 'estate-map/model-tier-usage/v1');
  assert.equal(report.partial, false);
  assert.equal(report.shares_status, 'complete');
  assert.equal(report.spend_account, 'complete_known_cost');
  assert.equal(report.totals.calls, 4);
  assert.equal(report.totals.known_cost, 2);
  assert.equal(report.totals.cost_status, 'complete');
  assert.equal(report.totals.cost_share_status, 'complete');
  assert.equal(report.tiers.small.calls, 2);
  assert.equal(report.tiers.small.call_share, 0.5);
  assert.equal(report.tiers.small.cost, 0.5);
  assert.equal(report.tiers.small.cost_share, 0.25);
  assert.equal(report.tiers.small.cost_status, 'complete');
  assert.equal(report.tiers.medium.calls, 1);
  assert.equal(report.tiers.medium.cost, 0.5);
  assert.equal(report.tiers.medium.cost_share, 0.25);
  assert.equal(report.untiered.calls, 1);
  assert.equal(report.untiered.cost, 1);
  assert.equal(report.untiered.cost_share, 0.5);
  assert.deepEqual(report.untiered.models, ['example-provider/other']);
  assert.equal(Object.hasOwn(report.tiers, 'large'), false);
  assert.equal(report.tiers.small.calls + report.tiers.medium.calls + report.untiered.calls, calls.length);
  assert.equal(report.tiers.small.over_target.fired, true);
  assert.equal(report.tiers.small.over_target.partial, false);
  assert.equal(report.tiers.small.over_target.known_cost_share, 0.25);
  assert.equal(report.tiers.medium.over_target.fired, false);
  const empty = reportModelTierUsage([], config);
  assert.equal(empty.totals.calls, 0);
  assert.equal(empty.totals.cost_status, 'complete');
  assert.equal(empty.tiers.small.call_share, null);
  assert.equal(empty.tiers.small.cost_share, null);
  assert.equal(empty.untiered.call_share, null);
  assert.equal(empty.untiered.cost_share, null);
  assert.equal(empty.tiers.small.over_target.fired, false);
  assert.equal(empty.spend_account, 'complete_known_cost');
});

test('an undeclared tier leaves its model untiered and a call thinking field does not split a tier', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims' },
  });
  const report = reportModelTierUsage([
    { ...priced('example-provider/ledger-reader', 0.2), thinking: 'xhigh' },
    priced('example-provider/graph-reader', 0.3),
  ], config);
  assert.equal(Object.hasOwn(report.tiers, 'medium'), false);
  assert.equal(report.tiers.small.calls, 1);
  assert.equal(report.tiers.small.cost, 0.2);
  assert.equal(report.untiered.calls, 1);
  assert.deepEqual(report.untiered.models, ['example-provider/graph-reader']);
  assert.equal(JSON.stringify(report).includes('"thinking"'), false);
});

test('an unpriced placeholder is not known cost, and every cost share stays partial', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims', medium: 'code_claims' },
    tier_targets: { small: 0.5, medium: 0.4 },
  });
  const report = reportModelTierUsage([
    priced('example-provider/ledger-reader', 0.4),
    { model: 'example-provider/graph-reader', billing_status: 'accepted_usage_unknown', cost: 99, cost_reported: false },
    { model: 'example-provider/other', billing_status: 'usage_reported_cost_unknown', cost: 5, cost_reported: false },
    { model: 'example-provider/review-arm', billing_status: 'acceptance_unknown', cost: 0, cost_reported: false },
  ], config);
  assert.equal(report.totals.calls, 4);
  assert.equal(report.totals.known_cost, 0.4);
  assert.equal(report.totals.cost_status, 'lower_bound');
  assert.equal(report.partial, true);
  assert.equal(report.shares_status, 'partial');
  assert.equal(report.spend_account, 'partial_known_cost');
  assert.equal(report.totals.cost_share_status, 'partial');
  assert.equal(report.tiers.small.cost, 0.4);
  assert.equal(report.tiers.small.cost_status, 'complete');
  assert.equal(report.tiers.small.cost_share, 1);
  assert.equal(report.tiers.small.cost_share_status, 'partial');
  assert.equal(report.tiers.medium.cost, 0);
  assert.equal(report.tiers.medium.cost_status, 'lower_bound');
  assert.equal(report.tiers.medium.cost_share, 0);
  assert.equal(report.tiers.medium.cost_share_status, 'partial');
  assert.equal(report.untiered.calls, 2);
  assert.equal(report.untiered.cost, 0);
  assert.equal(report.untiered.cost_status, 'lower_bound');
  assert.equal(report.untiered.cost_share_status, 'partial');
  assert.equal(report.tiers.small.calls + report.tiers.medium.calls + report.untiered.calls, 4);
  assert.equal(JSON.stringify(report).includes('99'), false);
  assert.equal(report.tiers.small.over_target.fired, true);
  assert.equal(report.tiers.small.over_target.partial, true);
  assert.equal(report.tiers.small.over_target.known_cost_share, 1);
  assert.equal(report.tiers.medium.over_target.fired, false);
  assert.equal(report.tiers.medium.over_target.partial, true);
  const onlyUnknown = reportModelTierUsage([
    { model: 'example-provider/ledger-reader', billing_status: 'acceptance_unknown', cost: 12, cost_reported: false },
  ], config);
  assert.equal(onlyUnknown.totals.known_cost, 0);
  assert.equal(onlyUnknown.totals.cost_status, 'lower_bound');
  assert.equal(onlyUnknown.tiers.small.cost_share, null);
  assert.equal(onlyUnknown.shares_status, 'partial');
  assert.equal(onlyUnknown.spend_account, 'partial_known_cost');
  assert.equal(onlyUnknown.tiers.small.over_target.fired, false);
  assert.equal(onlyUnknown.tiers.small.over_target.partial, true);
});

test('a lower_bound call keeps its floor in known cost and does not become complete spend', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims' },
    tier_targets: { small: 0.05 },
  });
  const report = reportModelTierUsage({
    cost_status: 'lower_bound',
    unpriced_attempts: 0,
    per_call: [{
      model: 'example-provider/ledger-reader', billing_status: 'reported', cost: 0.1,
      cost_reported: true, cost_status: 'lower_bound',
    }],
  }, config);
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.known_cost, 0.1);
  assert.equal(report.totals.cost_status, 'lower_bound');
  assert.equal(report.tiers.small.cost_status, 'lower_bound');
  assert.equal(report.tiers.small.cost_share, 1);
  assert.equal(report.tiers.small.cost_share_status, 'partial');
  assert.equal(report.shares_status, 'partial');
  assert.equal(report.spend_account, 'partial_known_cost');
  assert.equal(report.tiers.small.over_target.fired, true);
  assert.equal(report.tiers.small.over_target.partial, true);
});

test('an envelope lower_bound is preserved without inventing a call or a tier', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims' },
  });
  const report = reportModelTierUsage({
    cost_status: 'lower_bound',
    unpriced_attempts: 1,
    per_call: [priced('example-provider/ledger-reader', 0.2)],
  }, config);
  assert.equal(report.totals.calls, 1);
  assert.equal(report.tiers.small.calls, 1);
  assert.equal(report.untiered.calls, 0);
  assert.equal(report.totals.known_cost, 0.2);
  assert.equal(report.totals.cost_status, 'lower_bound');
  assert.equal(report.totals.unassigned_unpriced_attempts, 1);
  assert.equal(report.shares_status, 'partial');
  assert.equal(report.tiers.small.cost_share_status, 'partial');
});

test('a reported partial price stays known cost, and a non-finite price is not a fabricated zero', () => {
  const config = validateEstateMapRuntimeConfig({
    ...fixture(),
    model_tiers: { small: 'documentary_claims', medium: 'code_claims' },
  });
  const partial = reportModelTierUsage([
    { model: 'example-provider/ledger-reader', billing_status: 'reported_partial', cost: 0.15, cost_reported: true },
  ], config);
  assert.equal(partial.totals.known_cost, 0.15);
  assert.equal(partial.totals.cost_status, 'complete');
  assert.equal(partial.shares_status, 'complete');
  const broken = reportModelTierUsage([
    { model: 'example-provider/graph-reader', billing_status: 'reported', cost: Number.NaN, cost_reported: true },
  ], config);
  assert.equal(broken.totals.known_cost, 0);
  assert.equal(broken.totals.cost_status, 'lower_bound');
  assert.equal(broken.tiers.medium.cost_share, null);
  assert.equal(Number.isNaN(broken.totals.known_cost), false);
});

test('the report refuses an ambiguous tier map instead of counting one call twice', () => {
  const calls = [priced('example-provider/ledger-reader', 0.2)];
  assert.throws(() => reportModelTierUsage(calls, {
    models: {
      documentary_claims: { name: 'example-provider/ledger-reader' },
      code_claims: { name: 'example-provider/ledger-reader' },
    },
    model_tiers: { small: 'documentary_claims', medium: 'code_claims' },
  }), error => error.code === 'MODEL_TIER_USAGE_AMBIGUOUS'
    && error.detail.model === 'example-provider/ledger-reader'
    && error.detail.tiers.includes('small') && error.detail.tiers.includes('medium'));
  assert.equal(calls.length, 1);
});

test('usage is an estate verb that reads config and does not own a pipeline route', () => {
  const plan = planInvocation(['usage', '--calls', 'calls.json'], { environment: {}, cwd: '/work', root: '/app' });
  assert.equal(plan.error, undefined);
  assert.equal(plan.script, '/app/tools/model-usage.mjs');
  assert.deepEqual(plan.args, ['--runtime-config', '/work/ascrybe.config.json', '--calls', 'calls.json']);
  for (const file of [
    'tools/pipeline.mjs', 'tools/neural-model-runner.mjs', 'tools/semantic-map-run.mjs',
    'tools/custodied-inference.mjs', 'tools/campaign.mjs',
  ]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(text.includes('model_tiers'), false, file);
    assert.equal(text.includes('tier_targets'), false, file);
  }
  const source = readFileSync(new URL('../tools/model-usage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|fetch\(|createPi|from '\.\/pipeline/u);
});

test('the usage CLI reports the committed fixture and refuses an ambiguous config by name', () => {
  const report = runModelTierUsageCli(['--runtime-config', configFixture, '--calls', callsFixture]);
  assert.equal(report.totals.calls, 5);
  assert.equal(report.totals.known_cost, 2);
  assert.equal(report.tiers.small.cost, 0.5);
  assert.equal(report.tiers.medium.cost_status, 'lower_bound');
  assert.equal(report.untiered.calls, 1);
  assert.equal(report.shares_status, 'partial');
  assert.equal(report.tiers.small.over_target.partial, true);
  assert.throws(() => runModelTierUsageCli(['--runtime-config', ambiguousFixture, '--calls', callsFixture]),
    error => error.code === 'RUNTIME_CONFIG_MODEL_TIER_AMBIGUOUS'
      && error.detail.tiers.includes('small') && error.detail.tiers.includes('large')
      && error.detail.model === 'example-provider/ledger-reader');
  const held = spawnSync(process.execPath, [new URL('../tools/model-usage.mjs', import.meta.url).pathname,
    '--runtime-config', configFixture, '--calls', callsFixture], { encoding: 'utf8' });
  assert.equal(held.status, 0);
  const printed = JSON.parse(held.stdout);
  assert.equal(printed.totals.known_cost, report.totals.known_cost);
  assert.equal(printed.untiered.calls, 1);
});
