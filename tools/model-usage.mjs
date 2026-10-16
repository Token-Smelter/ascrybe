// Usage accounting that survives checkpoint/resume. Each completed work unit stores the exact
// runner.stats() delta incurred while producing it; aggregate output therefore includes pre-crash
// and post-resume calls once each instead of silently dropping historical spend.
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
