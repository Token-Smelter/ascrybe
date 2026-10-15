#!/usr/bin/env node
// Build a separately labelled analytical composite from an immutable failed extraction and an
// explicitly authorized provider-repair run. This never rewrites the primary run's gate result.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimQualityMetricsV32, reduceClaimsV32 } from './claim-v32.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const PROVIDER_REPAIR_COMPOSITE_SCHEMA = 'estate-map/provider-repair-composite/v1';
const canonical = value => stableStringify(value).trim();
const unitOf = claim => claim?.semantic?.provenance?.unit_id ?? claim?.extraction?.unit_id ?? null;

export class ProviderRepairMergeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ProviderRepairMergeError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, message, detail = {}) => { throw new ProviderRepairMergeError(code, message, detail); };
const same = (left, right) => canonical(left) === canonical(right);
const round = (value, places) => Number(Number(value).toFixed(places));
const sum = (left, right, key) => Number(left?.[key] || 0) + Number(right?.[key] || 0);

function verifyWideDigest(artifact, label) {
  if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.claims)) {
    fail('INVALID_INPUT_ARTIFACT', `${label} is not a wide-context extraction artifact`);
  }
  const { digest, ...body } = artifact;
  const expected = sha256(canonical({ ...body, claims: artifact.claims.map(claim => claim.id) }));
  if (digest !== expected) fail('INPUT_DIGEST_MISMATCH', `${label} artifact digest does not verify`);
}

function receiptIndex(rows, label) {
  const header = rows.find(row => row?.type === 'header');
  if (!header?.fingerprint) fail('CHECKPOINT_HEADER_MISSING', `${label} checkpoint has no fingerprint header`);
  const starts = new Map(), completions = new Map();
  for (const row of rows) {
    if (row?.type !== 'entry') continue;
    if (row.stage === 'wide-context-started') {
      if (starts.has(row.key)) fail('DUPLICATE_START_RECEIPT', `${label} repeats start key ${row.key}`);
      starts.set(row.key, row);
    }
    if (row.stage === 'wide-context-completion') {
      if (completions.has(row.key)) fail('DUPLICATE_COMPLETION_RECEIPT', `${label} repeats completion key ${row.key}`);
      completions.set(row.key, row);
    }
  }
  if (starts.size !== completions.size || [...starts.keys()].some(key => !completions.has(key))) {
    fail('CHECKPOINT_CUSTODY_GAP', `${label} does not have one completion for every start`, {
      starts: starts.size, completions: completions.size,
    });
  }
  const byWindow = new Map();
  for (const [key, start] of starts) {
    const tag = String(start.value?.tag || '');
    if (!tag.startsWith('extract:window:')) fail('CHECKPOINT_TAG_INVALID', `${label} start ${key} has no extraction window tag`);
    const windowId = tag.slice('extract:'.length);
    if (byWindow.has(windowId)) fail('DUPLICATE_WINDOW_RECEIPT', `${label} repeats ${windowId}`);
    byWindow.set(windowId, { start, completion: completions.get(key) });
  }
  return { header, starts, completions, byWindow };
}

function mergeUnitMap(primary, repair, repairIds, name) {
  const left = primary || {}, right = repair || {};
  for (const id of repairIds) {
    if (Object.hasOwn(left, id)) fail('PRIMARY_ALREADY_HAS_REPAIR_RESULT', `${name} already contains ${id}`);
    if (!Object.hasOwn(right, id)) fail('REPAIR_RESULT_MISSING', `${name} lacks ${id}`);
  }
  const extra = Object.keys(right).filter(id => !repairIds.has(id));
  if (extra.length) fail('REPAIR_SCOPE_EXPANDED', `${name} contains non-preregistered repair windows`, { extra });
  return Object.fromEntries([...Object.entries(left), ...Object.entries(right)]
    .sort(([a], [b]) => a.localeCompare(b)));
}

function mergeRejectionCodes(primary = [], repair = []) {
  const counts = new Map();
  for (const [code, count] of [...primary, ...repair]) counts.set(code, (counts.get(code) || 0) + Number(count || 0));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Combine analytical coverage while retaining both immutable run identities and gate outcomes.
 * Checkpoint rows are required because prompt-byte equivalence and dispatch custody are not
 * inferable from the reduced claim artifacts alone.
 */
export function mergeProviderRepair({
  primary, repair, repair_window_ids, primary_checkpoint, repair_checkpoint,
  primary_file_sha256 = null, repair_file_sha256 = null,
  primary_checkpoint_sha256 = null, repair_checkpoint_sha256 = null,
}) {
  verifyWideDigest(primary, 'primary');
  verifyWideDigest(repair, 'repair');
  const ids = new Set(repair_window_ids || []);
  if (!ids.size || ids.size !== (repair_window_ids || []).length) {
    fail('REPAIR_WINDOW_SET_INVALID', 'repair window ids must be a non-empty unique array');
  }
  if (!same(primary.snapshot, repair.snapshot)) fail('SNAPSHOT_MISMATCH', 'primary and repair snapshots differ');
  if (!same(primary.segmentation, repair.segmentation)
    || !same(primary.window_catalog, repair.window_catalog)
    || !same(primary.window_conservation, repair.window_conservation)) {
    fail('SEGMENTATION_MISMATCH', 'primary and repair do not share identical source segmentation lineage');
  }
  if (primary.status === 'complete' || Number(primary.queue?.by_state?.quarantined || 0) !== ids.size) {
    fail('PRIMARY_NOT_FAILED_AS_DECLARED', 'primary must remain incomplete with exactly the declared repair count quarantined');
  }
  if (repair.status !== 'complete' || Number(repair.queue?.by_state?.done || 0) !== ids.size
    || Object.keys(repair.queue?.by_state || {}).some(state => state !== 'done')) {
    fail('REPAIR_NOT_COMPLETE', 'repair must contain only completed units');
  }
  if (primary.budget?.unpriced_attempts || repair.budget?.unpriced_attempts) {
    fail('UNPRICED_ATTEMPT', 'composite refuses unpriced inference attempts');
  }

  const primaryReceipts = receiptIndex(primary_checkpoint || [], 'primary');
  const repairReceipts = receiptIndex(repair_checkpoint || [], 'repair');
  if (primaryReceipts.starts.size !== Number(primary.budget?.accounted_calls)
    || repairReceipts.starts.size !== Number(repair.budget?.accounted_calls)) {
    fail('RECEIPT_BUDGET_MISMATCH', 'checkpoint starts do not equal accounted calls');
  }
  if (repairReceipts.byWindow.size !== ids.size
    || [...repairReceipts.byWindow.keys()].some(id => !ids.has(id))) {
    fail('REPAIR_SCOPE_EXPANDED', 'repair checkpoint does not exactly match declared windows');
  }

  const promptEquivalence = [];
  for (const id of [...ids].sort()) {
    const failed = primaryReceipts.byWindow.get(id), replacement = repairReceipts.byWindow.get(id);
    if (!failed || !replacement) fail('REPAIR_RECEIPT_MISSING', `missing primary or repair receipt for ${id}`);
    const failedResult = failed.completion.value?.result || {};
    const repairedResult = replacement.completion.value?.result || {};
    if (failedResult.outcome !== 'error:provider' || failedResult.accepted !== true
      || Number(failedResult.usage?.input_tokens || 0) !== 0
      || Number(failedResult.usage?.output_tokens || 0) !== 0
      || Number(failedResult.usage?.cost || 0) !== 0) {
      fail('PRIMARY_FAILURE_NOT_ZERO_TOKEN_PROVIDER', `${id} was not the declared zero-token provider failure`);
    }
    if (repairedResult.outcome !== 'ok' || repairedResult.accepted !== true) {
      fail('REPAIR_RECEIPT_NOT_SUCCESSFUL', `${id} repair receipt is not an accepted success`);
    }
    const primaryPrompt = failed.start.value?.prompt_digest;
    const repairPrompt = replacement.start.value?.prompt_digest;
    if (!primaryPrompt || primaryPrompt !== repairPrompt) {
      fail('PROMPT_DIGEST_MISMATCH', `${id} repair changed model-visible prompt bytes`);
    }
    promptEquivalence.push({ window_id: id, prompt_digest: primaryPrompt, byte_identical: true });
  }

  const primaryClaimWindows = new Set(primary.claims.map(unitOf));
  const repairClaimWindows = new Set(repair.claims.map(unitOf));
  if ([...ids].some(id => primaryClaimWindows.has(id))
    || [...repairClaimWindows].some(id => !ids.has(id))
    || [...ids].some(id => !repairClaimWindows.has(id))) {
    fail('CLAIM_SCOPE_MISMATCH', 'claim provenance does not partition cleanly between primary and repair windows');
  }

  const claims = reduceClaimsV32([...primary.claims, ...repair.claims]);
  const quality = claimQualityMetricsV32(claims);
  const left = primary.metrics || {}, right = repair.metrics || {};
  const proposedClaims = sum(left, right, 'proposed_claims');
  const promotedClaims = sum(left, right, 'promoted_claims');
  const proposedLocators = sum(left, right, 'proposed_locators');
  const resolvedLocators = sum(left, right, 'resolved_locators');
  const selectedBytes = Number(left.selected_primary_bytes ?? left.primary_bytes ?? 0);
  const accountedCalls = sum(primary.budget, repair.budget, 'accounted_calls');
  const knownCost = round(sum(primary.budget, repair.budget, 'known_cost_usd'), 6);
  const sourceRuns = [
    {
      role: 'failed_primary', extractor: primary.extractor, extraction_contract: primary.extraction_contract,
      artifact_digest: primary.digest, file_sha256: primary_file_sha256,
      checkpoint_sha256: primary_checkpoint_sha256, status: primary.status,
      queue: primary.queue, budget: primary.budget,
    },
    {
      role: 'targeted_provider_repair', extractor: repair.extractor, extraction_contract: repair.extraction_contract,
      artifact_digest: repair.digest, file_sha256: repair_file_sha256,
      checkpoint_sha256: repair_checkpoint_sha256, status: repair.status,
      queue: repair.queue, budget: repair.budget,
    },
  ];
  const body = {
    schema: PROVIDER_REPAIR_COMPOSITE_SCHEMA,
    status: 'complete_composite_analysis',
    promotion_eligible: false,
    promotion_blocker: 'The immutable primary run failed its operational gate; a targeted repair restores analytical coverage but cannot rewrite that grade.',
    snapshot: primary.snapshot,
    lineage: {
      source_runs: sourceRuns,
      repair_window_ids: [...ids].sort(),
      prompt_equivalence: promptEquivalence,
      primary_gate_status_preserved: true,
    },
    segmentation: primary.segmentation,
    window_catalog: primary.window_catalog,
    window_conservation: primary.window_conservation,
    coverage: {
      unique_windows: Number(left.selected_windows || 0),
      primary_successful_windows: Object.keys(left.claims_by_unit || {}).length,
      repaired_windows: ids.size,
      complete: Object.keys(left.claims_by_unit || {}).length + ids.size === Number(left.selected_windows || 0),
    },
    queue: {
      unique_units: Number(left.selected_windows || 0),
      by_state: { done: Number(left.selected_windows || 0) },
      inference_attempts: accountedCalls,
      primary_attempts: Number(primary.budget?.accounted_calls || 0),
      repair_attempts: Number(repair.budget?.accounted_calls || 0),
      orphaned_started: 0,
    },
    budget: {
      accounted_calls: accountedCalls,
      known_cost_usd: knownCost,
      cost_status: 'complete',
      unpriced_attempts: 0,
      source_run_caps_usd: round(sum(primary.budget, repair.budget, 'max_known_cost_usd'), 6),
    },
    metrics: {
      ...quality,
      proposed_claims: proposedClaims,
      promoted_claims: promotedClaims,
      proposed_locators: proposedLocators,
      resolved_locators: resolvedLocators,
      failed_locators: sum(left, right, 'failed_locators'),
      locator_resolution_rate: proposedLocators ? round(resolvedLocators / proposedLocators, 4) : null,
      claim_promotion_rate: proposedClaims ? round(promotedClaims / proposedClaims, 4) : null,
      promoted_locator_resolution_rate: claims.length ? 1 : null,
      source_run_raw_claims: sum(left, right, 'raw_claims'),
      composite_input_claims: primary.claims.length + repair.claims.length,
      reduced_claims: claims.length,
      rejected_claims: sum(left, right, 'rejected_claims'),
      overflow_units: sum(left, right, 'overflow_units'),
      truncated_units: sum(left, right, 'truncated_units'),
      wire_repaired_lines: sum(left, right, 'wire_repaired_lines'),
      claims_by_unit: mergeUnitMap(left.claims_by_unit, right.claims_by_unit, ids, 'claims_by_unit'),
      proposals_by_unit: mergeUnitMap(left.proposals_by_unit, right.proposals_by_unit, ids, 'proposals_by_unit'),
      rejections_by_unit: mergeUnitMap(left.rejections_by_unit, right.rejections_by_unit, ids, 'rejections_by_unit'),
      locator_metrics_by_unit: mergeUnitMap(left.locator_metrics_by_unit, right.locator_metrics_by_unit, ids, 'locator_metrics_by_unit'),
      truncated_by_unit: mergeUnitMap(left.truncated_by_unit, right.truncated_by_unit, ids, 'truncated_by_unit'),
      wire_repairs_by_unit: mergeUnitMap(left.wire_repairs_by_unit, right.wire_repairs_by_unit, ids, 'wire_repairs_by_unit'),
      rejection_codes: mergeRejectionCodes(left.rejection_codes, right.rejection_codes),
      corpus_primary_bytes: Number(left.corpus_primary_bytes || 0),
      selected_primary_bytes: selectedBytes,
      selected_windows: Number(left.selected_windows || 0),
      selected_documents: Number(left.selected_documents || 0),
      primary_bytes: selectedBytes,
      calls_per_kb: selectedBytes ? round(accountedCalls / (selectedBytes / 1024), 4) : null,
      usd_per_kb: selectedBytes ? round(knownCost / (selectedBytes / 1024), 6) : null,
      claims_per_kb: selectedBytes ? round(claims.length / (selectedBytes / 1024), 4) : null,
    },
    claims,
  };
  if (!body.coverage.complete) fail('COMPOSITE_COVERAGE_INCOMPLETE', 'primary success and repair windows do not conserve the selected population');
  return Object.freeze({ ...body, digest: sha256(canonical({ ...body, claims: claims.map(claim => claim.id) })) });
}

async function readJson(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function readCheckpoint(file) {
  return (await fs.readFile(path.resolve(file), 'utf8')).split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { fail('CHECKPOINT_PARSE_ERROR', `${file}:${index + 1}: ${error.message}`); }
  });
}
async function fileSha(file) { return sha256(await fs.readFile(path.resolve(file))); }

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) options[argv[index].replace(/^--/, '')] = argv[index + 1];
  for (const name of ['primary', 'repair', 'repair-windows', 'primary-checkpoint', 'repair-checkpoint', 'output']) {
    if (!options[name]) throw new Error(`missing --${name}`);
  }
  const [primary, repair, repairIds, primaryRows, repairRows, primaryFileSha, repairFileSha, primaryCheckpointSha, repairCheckpointSha] = await Promise.all([
    readJson(options.primary), readJson(options.repair), readJson(options['repair-windows']),
    readCheckpoint(options['primary-checkpoint']), readCheckpoint(options['repair-checkpoint']),
    fileSha(options.primary), fileSha(options.repair), fileSha(options['primary-checkpoint']), fileSha(options['repair-checkpoint']),
  ]);
  const composite = mergeProviderRepair({
    primary, repair, repair_window_ids: repairIds, primary_checkpoint: primaryRows, repair_checkpoint: repairRows,
    primary_file_sha256: primaryFileSha, repair_file_sha256: repairFileSha,
    primary_checkpoint_sha256: primaryCheckpointSha, repair_checkpoint_sha256: repairCheckpointSha,
  });
  const output = path.resolve(options.output), temporary = `${output}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(composite, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({
    output, status: composite.status, promotion_eligible: composite.promotion_eligible,
    coverage: composite.coverage, budget: composite.budget,
    metrics: {
      claims: composite.metrics.claims,
      claim_promotion_rate: composite.metrics.claim_promotion_rate,
      locator_resolution_rate: composite.metrics.locator_resolution_rate,
      truncated_units: composite.metrics.truncated_units,
      wire_repaired_lines: composite.metrics.wire_repaired_lines,
      selected_primary_bytes: composite.metrics.selected_primary_bytes,
      claims_per_kb: composite.metrics.claims_per_kb,
      usd_per_kb: composite.metrics.usd_per_kb,
    },
    digest: composite.digest,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
