#!/usr/bin/env node
// Usage accounting that survives checkpoint/resume. Each completed work unit stores the exact
// runner.stats() delta incurred while producing it; aggregate output therefore includes pre-crash
// and post-resume calls once each instead of silently dropping historical spend.
//
// The tier report reads those records after the fact. It does not dispatch, cap, or reroute:
// a tier target is an alarm on known-cost share, not a budget the runner consults.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEstateMapRuntimeConfig, MODEL_TIER_NAMES } from './ascrybe-config.mjs';
import { isUnpricedBillingStatus } from './inference-custody.mjs';

const empty = (model = null) => ({ model, kind: 'unknown', calls: 0, cost: 0, cost_status: 'complete', unpriced_attempts: 0, models: model ? [model] : [], per_call: [] });
const isUnpriced = call => isUnpricedBillingStatus(call?.billing_status);

export function modelStatsSnapshot(runner) {
  if (!runner || typeof runner.stats !== 'function') return empty(runner?.model ?? null);
  const stats = runner.stats() || {};
  return { ...empty(runner.model ?? null), ...stats, per_call: Array.isArray(stats.per_call) ? stats.per_call.slice() : [] };
}

export function modelStatsDelta(before, after, model = null) {
  const prior = before || empty(model);
  const current = after || empty(model);
  const per_call = current.per_call.slice(prior.per_call.length);
  const unpricedAttempts = Math.max(
    per_call.filter(isUnpriced).length,
    Math.max(0, Number(current.unpriced_attempts || 0) - Number(prior.unpriced_attempts || 0)),
  );
  return {
    model: model ?? current.model ?? null,
    kind: current.kind ?? prior.kind ?? 'unknown',
    calls: Number(current.calls || 0) - Number(prior.calls || 0),
    cost: Number((Number(current.cost || 0) - Number(prior.cost || 0)).toFixed(6)),
    cost_status: unpricedAttempts ? 'lower_bound' : 'complete',
    unpriced_attempts: unpricedAttempts,
    models: [...new Set(per_call.map(call => call.model).filter(Boolean))],
    per_call,
  };
}

export function combineModelStats(parts, model = null) {
  const valid = (parts || []).filter(Boolean);
  const per_call = valid.flatMap(part => part.per_call || []).sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
  const kinds = [...new Set(valid.map(part => part.kind).filter(Boolean))];
  const models = [...new Set(valid.flatMap(part => part.models || []).concat(model ? [model] : []).filter(Boolean))];
  const unpricedAttempts = Math.max(
    per_call.filter(isUnpriced).length,
    valid.reduce((sum, part) => sum + Number(part.unpriced_attempts || 0), 0),
  );
  return {
    model,
    kind: kinds.length === 1 ? kinds[0] : (kinds.length ? 'mixed' : 'unknown'),
    calls: valid.reduce((sum, part) => sum + Number(part.calls || 0), 0),
    cost: Number(valid.reduce((sum, part) => sum + Number(part.cost || 0), 0).toFixed(6)),
    cost_status: unpricedAttempts ? 'lower_bound' : 'complete',
    unpriced_attempts: unpricedAttempts,
    models,
    per_call,
  };
}

export const MODEL_TIER_USAGE_SCHEMA = 'estate-map/model-tier-usage/v1';

export class ModelTierUsageError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ModelTierUsageError';
    this.code = code;
    this.detail = detail;
  }
}

function usageFail(code, message, detail) {
  throw new ModelTierUsageError(code, message, detail);
}

const money = value => Number(Number(value).toFixed(6));
const rawRatio = (part, whole) => whole > 0 ? part / whole : null;
const ratio = (part, whole) => whole > 0 ? Number((part / whole).toFixed(6)) : null;

function callRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    usageFail('MODEL_TIER_USAGE_RECORD_INVALID', 'per_call entries must be objects');
  }
  return entry;
}

function collectPerCallRecords(input) {
  if (Array.isArray(input)) return input.flatMap(entry => collectPerCallRecords(entry));
  if (input && typeof input === 'object') {
    if (Array.isArray(input.per_call)) return input.per_call.map(callRecord);
    if (input.model_stats && typeof input.model_stats === 'object' && input.model_stats !== input) {
      return collectPerCallRecords(input.model_stats);
    }
    return [callRecord(input)];
  }
  usageFail('MODEL_TIER_USAGE_RECORD_INVALID', 'usage input must be per-call records or a model-stats object with per_call');
}

// A stats envelope can say lower_bound without a matching per_call row. Preserve that fact.
// Do not invent a call or assign the gap to a tier: the model is unknown.
function envelopeAccounting(input) {
  let lower = false;
  let unpriced = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const envelope = Array.isArray(value.per_call) || (value.model_stats && typeof value.model_stats === 'object');
    if (envelope) {
      if (value.cost_status === 'lower_bound') lower = true;
      const attempts = Number(value.unpriced_attempts);
      if (Number.isFinite(attempts) && attempts > unpriced) unpriced = attempts;
    }
    if (value.model_stats && typeof value.model_stats === 'object' && value.model_stats !== value) visit(value.model_stats);
  };
  visit(input);
  return { lower, unpriced };
}

// Unpriced billing stores a placeholder cost, sometimes non-zero. That number is not spend.
// A present non-finite cost is the same kind of gap: do not replace it with zero and call the
// total complete. A missing cost on a priced status stays the existing Number(cost || 0) reading.
function classifyCall(call) {
  const unpriced = isUnpricedBillingStatus(call?.billing_status);
  const raw = call?.cost;
  const amount = Number(raw);
  const finite = Number.isFinite(amount);
  const missing = raw == null || raw === '';
  if (unpriced) return { unpriced: true, known: 0, priced: false, lowerBound: true };
  if (!finite && !missing) return { unpriced: false, known: 0, priced: false, lowerBound: true };
  return {
    unpriced: false,
    known: finite ? amount : 0,
    priced: true,
    lowerBound: call?.cost_status === 'lower_bound',
  };
}

function summarizeCalls(calls) {
  let known = 0;
  let priced = 0;
  let unpriced = 0;
  let lower = 0;
  const models = new Set();
  for (const call of calls) {
    const row = classifyCall(call);
    known += row.known;
    if (row.priced) priced += 1;
    if (row.unpriced) unpriced += 1;
    if (row.lowerBound) lower += 1;
    if (typeof call?.model === 'string' && call.model) models.add(call.model);
  }
  return { calls: calls.length, known, priced, unpriced, lower, models: [...models].sort() };
}

function runtimeConfig(value) {
  if (value?.config?.models && value.digest) return value.config;
  return value ?? {};
}

function tierBindings(config) {
  const models = config.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    usageFail('MODEL_TIER_USAGE_CONFIG_INVALID', 'report requires config.models');
  }
  const declared = config.model_tiers ?? {};
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    usageFail('MODEL_TIER_USAGE_CONFIG_INVALID', 'model_tiers must be an object');
  }
  const targets = config.tier_targets ?? {};
  const bindings = [];
  const byModel = new Map();
  for (const tier of MODEL_TIER_NAMES) {
    if (!Object.hasOwn(declared, tier)) continue;
    const role = declared[tier];
    const model = models[role]?.name;
    if (typeof model !== 'string' || !model) {
      usageFail('MODEL_TIER_USAGE_CONFIG_INVALID', `model_tiers.${tier} does not resolve to a model`, { tier, role });
    }
    const group = byModel.get(model) ?? [];
    group.push(tier);
    byModel.set(model, group);
    let target = null;
    if (targets && Object.hasOwn(targets, tier)) {
      target = targets[tier];
      if (typeof target !== 'number' || !Number.isFinite(target)) {
        usageFail('MODEL_TIER_USAGE_CONFIG_INVALID', `tier_targets.${tier} is not a finite number`, { tier });
      }
    }
    bindings.push({ tier, role, model, target });
  }
  for (const [model, group] of byModel) {
    if (group.length < 2) continue;
    usageFail('MODEL_TIER_USAGE_AMBIGUOUS',
      `model_tiers ${group.join(' and ')} resolve to the same model ${model}`,
      { tiers: group.slice(), model });
  }
  return bindings;
}

// The alarm compares the unrounded share: a share just above its target can display as the target.
function overTarget(target, knownShare, rawShare, partial) {
  if (target == null) return null;
  return Object.freeze({
    fired: rawShare != null && rawShare > target,
    partial,
    known_cost_share: knownShare,
    target,
  });
}

function usageRow({ role, model, summary, callShare, costShare, rawCostShare, shareStatus, target, partial }) {
  return Object.freeze({
    role,
    model,
    models: Object.freeze(summary.models),
    calls: summary.calls,
    call_share: callShare,
    cost: money(summary.known),
    cost_share: costShare,
    cost_status: summary.lower > 0 ? 'lower_bound' : 'complete',
    cost_share_status: shareStatus,
    priced_calls: summary.priced,
    unpriced_calls: summary.unpriced,
    lower_bound_calls: summary.lower,
    target,
    over_target: overTarget(target, costShare, rawCostShare, partial),
  });
}

export function reportModelTierUsage(input, configInput) {
  const records = collectPerCallRecords(input);
  const config = runtimeConfig(configInput);
  const bindings = tierBindings(config);
  const modelToTier = new Map(bindings.map(binding => [binding.model, binding.tier]));
  const buckets = new Map(bindings.map(binding => [binding.tier, []]));
  const untiered = [];
  for (const call of records) {
    const tier = modelToTier.get(call?.model);
    if (tier) buckets.get(tier).push(call);
    else untiered.push(call);
  }
  const envelope = envelopeAccounting(input);
  const classified = records.map(classifyCall);
  const observedUnpriced = classified.filter(row => row.unpriced).length;
  const unassignedUnpriced = Math.max(0, envelope.unpriced - observedUnpriced);
  const sharesPartial = classified.some(row => row.lowerBound) || envelope.lower || unassignedUnpriced > 0;
  const shareStatus = sharesPartial ? 'partial' : 'complete';
  const totalCalls = records.length;
  const totalKnown = classified.reduce((sum, row) => sum + row.known, 0);
  const tiers = {};
  for (const binding of bindings) {
    const summary = summarizeCalls(buckets.get(binding.tier));
    tiers[binding.tier] = usageRow({
      role: binding.role,
      model: binding.model,
      summary,
      callShare: ratio(summary.calls, totalCalls),
      costShare: ratio(summary.known, totalKnown),
      rawCostShare: rawRatio(summary.known, totalKnown),
      shareStatus,
      target: binding.target,
      partial: sharesPartial,
    });
  }
  const untieredSummary = summarizeCalls(untiered);
  return Object.freeze({
    schema: MODEL_TIER_USAGE_SCHEMA,
    partial: sharesPartial,
    shares_status: shareStatus,
    spend_account: sharesPartial ? 'partial_known_cost' : 'complete_known_cost',
    totals: Object.freeze({
      calls: totalCalls,
      known_cost: money(totalKnown),
      cost_status: sharesPartial ? 'lower_bound' : 'complete',
      cost_share_status: shareStatus,
      priced_calls: classified.filter(row => row.priced).length,
      unpriced_calls: observedUnpriced,
      lower_bound_calls: classified.filter(row => row.lowerBound).length,
      unassigned_unpriced_attempts: unassignedUnpriced,
    }),
    tiers: Object.freeze(tiers),
    untiered: usageRow({
      role: null,
      model: null,
      summary: untieredSummary,
      callShare: ratio(untieredSummary.calls, totalCalls),
      costShare: ratio(untieredSummary.known, totalKnown),
      shareStatus,
      target: null,
      partial: sharesPartial,
    }),
  });
}

export function runModelTierUsageCli(argv, { readFile = readFileSync } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) usageFail('MODEL_TIER_USAGE_ARGUMENT_INVALID', `unexpected argument ${token}`);
    const key = token.slice(2);
    if (key !== 'runtime-config' && key !== 'calls') {
      usageFail('MODEL_TIER_USAGE_ARGUMENT_INVALID', `unknown argument ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usageFail('MODEL_TIER_USAGE_ARGUMENT_INVALID', `${token} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!options['runtime-config'] || !options.calls) {
    usageFail('MODEL_TIER_USAGE_ARGUMENT_INVALID', 'usage: model-usage --runtime-config <path> --calls <per-call.json>');
  }
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  let parsed;
  try { parsed = JSON.parse(readFile(options.calls, 'utf8')); }
  catch (error) {
    usageFail('MODEL_TIER_USAGE_READ_FAILED', `cannot read per-call records ${options.calls}`, { cause: error.code || error.message });
  }
  return reportModelTierUsage(parsed, runtime.config);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runModelTierUsageCli(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(`FAIL ${error.code || 'MODEL_TIER_USAGE_FAILED'}: ${error.message}`);
    if (error.detail && typeof error.detail === 'object') console.error(JSON.stringify({ detail: error.detail }));
    process.exitCode = 1;
  }
}
