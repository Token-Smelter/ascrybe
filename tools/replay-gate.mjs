#!/usr/bin/env node
// Preregistered readiness gate: replay the EXACT Phase 3 windows that failed, under the new
// contract, at their real size. Fresh documents cannot test this — against a 2.2% base rate a
// handful of new windows shows zero failures most of the time even if nothing improved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXTRACTOR_VERSION, runWideContextExtraction } from './wide-context-extractor.mjs';
import { createInferenceBudget } from './custodied-inference.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { installGracefulStop } from './graceful-stop.mjs';
import { requireModel } from './neural-model-runner.mjs';

const execFileAsync = promisify(execFile);
const canonical = value => stableStringify(value).trim();
export const REPLAY_GATE_SCHEMA = 'estate-map/replay-readiness-gate/v1';

// Declared BEFORE the run. A gate written after seeing results is not a gate.
export const GATE_THRESHOLDS = Object.freeze({
  max_truncated_units: 0,
  max_overflow_units: 0,
  max_failed_units: 0,
  min_locator_resolution_rate: 0.90,
  min_claims_per_window: 1,
  max_late_line_failure_increase: 0.15,
});

export const CONTROL_THRESHOLDS = Object.freeze({
  max_truncated_units: 0,
  max_overflow_units: 0,
  max_failed_units: 0,
  min_25_document_pooled_promotion_rate: 0.85,
  min_staged_full_pooled_promotion_rate: 0.90,
});

export function summarizeGatePopulation({ result, window_ids = [] }) {
  const metrics = result.metrics || {};
  const wanted = [...new Set(window_ids)];
  const perWindow = wanted.map(windowId => {
    const promoted = Number(metrics.claims_by_unit?.[windowId] || 0);
    const proposed = Number(metrics.proposals_by_unit?.[windowId] || 0);
    const rejected = Number(metrics.rejections_by_unit?.[windowId] || 0);
    const locators = metrics.locator_metrics_by_unit?.[windowId] || {};
    return {
      window_id: windowId,
      proposed,
      promoted,
      rejected,
      promotion_rate: proposed ? Number((promoted / proposed).toFixed(4)) : null,
      proposed_locators: Number(locators.proposed_locators || 0),
      resolved_locators: Number(locators.resolved_locators || 0),
      truncated: Boolean(metrics.truncated_by_unit?.[windowId]),
      returned: Object.hasOwn(metrics.claims_by_unit || {}, windowId),
    };
  });
  const totals = perWindow.reduce((sum, row) => ({
    proposed: sum.proposed + row.proposed,
    promoted: sum.promoted + row.promoted,
    rejected: sum.rejected + row.rejected,
    proposed_locators: sum.proposed_locators + row.proposed_locators,
    resolved_locators: sum.resolved_locators + row.resolved_locators,
    truncated: sum.truncated + Number(row.truncated),
  }), { proposed: 0, promoted: 0, rejected: 0, proposed_locators: 0, resolved_locators: 0, truncated: 0 });
  const rates = perWindow.map(row => row.promotion_rate).filter(Number.isFinite);
  return Object.freeze({
    windows: wanted.length,
    returned_windows: perWindow.filter(row => row.returned).length,
    ...totals,
    pooled_promotion_rate: totals.proposed ? Number((totals.promoted / totals.proposed).toFixed(4)) : null,
    macro_window_promotion_rate: rates.length
      ? Number((rates.reduce((sum, rate) => sum + rate, 0) / rates.length).toFixed(4)) : null,
    locator_resolution_rate: totals.proposed_locators
      ? Number((totals.resolved_locators / totals.proposed_locators).toFixed(4)) : null,
    per_window: perWindow,
  });
}

export function gradeControlPromotion({ result, control }) {
  const population = summarizeGatePopulation({ result, window_ids: control });
  const failed = (result.queue?.by_state?.quarantined || 0)
    + (result.queue?.by_state?.acceptance_unknown || 0)
    + (result.budget?.unpriced_attempts || 0);
  const hardChecks = {
    every_window_returned: population.returned_windows === population.windows,
    no_truncated_units: population.truncated <= CONTROL_THRESHOLDS.max_truncated_units,
    no_overflow_units: Number(result.metrics?.overflow_units || 0) <= CONTROL_THRESHOLDS.max_overflow_units,
    no_failed_units: failed <= CONTROL_THRESHOLDS.max_failed_units,
    complete_status: result.status === 'complete',
  };
  const hardPass = Object.values(hardChecks).every(Boolean);
  const rate = population.pooled_promotion_rate ?? 0;
  const decision = !hardPass || rate < CONTROL_THRESHOLDS.min_25_document_pooled_promotion_rate
    ? 'stop'
    : rate < CONTROL_THRESHOLDS.min_staged_full_pooled_promotion_rate
      ? 'authorize_25_documents_only' : 'authorize_staged_25_75_remainder';
  return Object.freeze({
    pass: hardPass && decision !== 'stop',
    hard_checks: hardChecks,
    thresholds: CONTROL_THRESHOLDS,
    population,
    decision,
    metric_role: 'address_contract_conformance_not_semantic_quality',
  });
}

export function gradeReplay({ result, replayed }) {
  const metrics = result.metrics || {};
  const failed = (result.queue?.by_state?.quarantined || 0) + (result.budget?.unpriced_attempts || 0);
  const allClaimsByUnit = metrics.claims_by_unit || {};
  const replayClaimsByUnit = Object.fromEntries(replayed
    .filter(windowId => Object.hasOwn(allClaimsByUnit, windowId))
    .map(windowId => [windowId, allClaimsByUnit[windowId]]));
  const perWindow = Object.entries(replayClaimsByUnit);
  const population = summarizeGatePopulation({ result, window_ids: replayed });
  const checks = {
    every_window_returned_claims: perWindow.length === replayed.length
      && perWindow.every(([, count]) => count >= GATE_THRESHOLDS.min_claims_per_window),
    no_truncated_units: (metrics.truncated_units || 0) <= GATE_THRESHOLDS.max_truncated_units,
    no_overflow_units: (metrics.overflow_units || 0) <= GATE_THRESHOLDS.max_overflow_units,
    no_failed_units: failed <= GATE_THRESHOLDS.max_failed_units,
    locator_resolution: (population.locator_resolution_rate ?? 0) >= GATE_THRESHOLDS.min_locator_resolution_rate,
    complete_status: result.status === 'complete',
  };
  return Object.freeze({
    pass: Object.values(checks).every(Boolean),
    checks,
    thresholds: GATE_THRESHOLDS,
    replayed_windows: replayed.length,
    claims_by_unit: replayClaimsByUnit,
    locator_resolution_rate: population.locator_resolution_rate,
    truncated_units: metrics.truncated_units || 0,
    rejected_claims: metrics.rejected_claims || 0,
    reduced_claims: metrics.reduced_claims || 0,
    usd_per_kb: metrics.usd_per_kb ?? null,
    claims_per_kb: metrics.claims_per_kb ?? null,
  });
}

async function main() {
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('PAID_GATE_CLOSED');
  const args = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i += 1) { if (!args[i].startsWith('--')) throw new Error(`unexpected ${args[i]}`); o[args[i].slice(2)] = args[++i]; }
  for (const required of ['manifest', 'failed-units', 'checkpoint', 'output']) if (!o[required]) throw new Error(`--${required} required`);

  const estate = await fs.realpath(path.resolve(o.estate || 'estate'));
  const expectedSha = (await fs.readFile(new URL('../ESTATE_SHA', import.meta.url), 'utf8')).trim();
  const sourceSha = (await execFileAsync('git', ['-C', estate, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sourceSha !== expectedSha) throw new Error('SOURCE_SHA_MISMATCH');

  const failedUnits = JSON.parse(await fs.readFile(path.resolve(o['failed-units']), 'utf8'));
  const replayed = [...new Set(failedUnits
    .filter(row => row.outcome === (o['outcome-class'] || 'ok:unparseable'))
    .map(row => String(row.tag || '').replace(/^extract:/, ''))
    .filter(Boolean))];
  if (!replayed.length) throw new Error('NO_UNITS_TO_REPLAY');

  // 0.877 on the worst-case tail is not the corpus rate. A seeded random control measures the rate
  // a full run would actually see, and is selected BEFORE the run so it cannot be cherry-picked.
  const controlCount = Number(o['control-windows'] || 0);
  const manifest = JSON.parse(await fs.readFile(path.resolve(o.manifest), 'utf8'));
  const relatives = manifest.documents || manifest.files || manifest;
  const documents = [];
  for (const entry of relatives) {
    const relative = typeof entry === 'string' ? entry : entry.path;
    documents.push({ path: relative, content: await fs.readFile(path.join(estate, relative), 'utf8') });
  }
  const snapshot = {
    source_sha: sourceSha,
    corpus_digest: sha256(canonical(documents.map(d => ({ path: d.path, digest: sha256(d.content) })))),
  };
  const bounds = JSON.parse(await fs.readFile(path.resolve(o.bounds), 'utf8'));
  const maxCost = Number(o['max-cost'] || 3);
  const budget = createInferenceBudget({ max_calls: 64, max_known_cost_usd: maxCost, max_unpriced_attempts: 0 });

  let control = [];
  if (controlCount > 0) {
    const { segmentCorpus } = await import('./wide-context-windows.mjs');
    const all = segmentCorpus({ documents, snapshot, window_bytes: bounds.window_bytes, overlap_bytes: bounds.overlap_bytes })
      .windows.map(window => window.id).filter(id => !replayed.includes(id)).sort();
    let seed = Number(o.seed || 20260804);
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pool = all.slice();
    for (let i = 0; i < controlCount && pool.length; i += 1) control.push(...pool.splice(Math.floor(next() * pool.length), 1));
  }
  const targets = [...replayed, ...control];

  const stop = installGracefulStop();
  let result;
  try {
    result = await runWideContextExtraction({
      root: estate, documents, snapshot,
      bounds: { ...bounds, max_calls: targets.length, max_known_cost_usd: maxCost, max_unpriced_attempts: 0 },
      checkpointPath: path.resolve(o.checkpoint),
      model: requireModel(o.model, 'replay --model'), thinking: o.thinking || 'high',
      concurrency: Number(o.concurrency || 4), budget, window_ids: targets, signal: stop.signal,
    });
  } finally { stop.dispose(); }

  const grade = gradeReplay({ result, replayed });
  const controlGrade = gradeControlPromotion({ result, control });
  const body = {
    schema: REPLAY_GATE_SCHEMA, extractor: EXTRACTOR_VERSION,
    purpose: 'replay the exact Phase 3 units that failed to parse, under the flat contract',
    replayed_window_ids: replayed.sort(), control_window_ids: control.sort(), snapshot, grade,
    control_grade: controlGrade,
    budget: result.budget, status: result.status, metrics: result.metrics,
  };
  const artifact = { ...body, digest: sha256(canonical(body)) };
  const requestedOutput = path.resolve(o.output);
  const output = result.status === 'paused' ? `${requestedOutput}.paused-${Date.now()}.json` : requestedOutput;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  if (o['claims-output']) await fs.mkdir(path.dirname(path.resolve(o['claims-output'])), { recursive: true });
  if (o['claims-output']) await fs.writeFile(path.resolve(o['claims-output']), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, grade, budget: result.budget, status: result.status }));
  process.exitCode = result.status === 'paused' ? 75 : grade.pass ? 0 : 3;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
