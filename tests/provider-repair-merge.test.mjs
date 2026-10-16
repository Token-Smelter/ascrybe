import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProviderRepair } from '../tools/merge-provider-repair.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const canonical = value => stableStringify(value).trim();
const window = id => ({ id, snapshot: { source_sha: 's', corpus_digest: 'c' } });
const claim = (id, unit, proposition) => ({
  id, proposition_key: proposition, evidence_key: `e-${id}`,
  semantic: {
    subject: { resolution_status: 'local', candidate_refs: [], canonical_ref: null, binding: { kind: 'explicit' } },
    relation_family: 'other', support_sets: [], irreducible_multi_span: false,
    provenance: { unit_id: unit, source_sha: 's', corpus_digest: 'c' },
  },
  extraction: { model_identifier: 'model', prompt_digest: `prompt-${unit}`, unit_id: unit },
  locator_stats: { proposed: 2, resolved: 2, failed: 0 },
});
function metrics(id, { selectedWindows, selectedDocuments, primaryBytes }) {
  return {
    proposed_claims: 1, promoted_claims: 1, proposed_locators: 2, resolved_locators: 2, failed_locators: 0,
    raw_claims: 1, rejected_claims: 0, overflow_units: 0, truncated_units: 0, wire_repaired_lines: 0,
    claims_by_unit: { [id]: 1 }, proposals_by_unit: { [id]: 1 }, rejections_by_unit: { [id]: 0 },
    locator_metrics_by_unit: { [id]: { proposed_claims: 1, promoted_claims: 1, proposed_locators: 2, resolved_locators: 2, failed_locators: 0 } },
    truncated_by_unit: { [id]: false }, wire_repairs_by_unit: { [id]: 0 }, rejection_codes: [],
    corpus_primary_bytes: 100, selected_primary_bytes: primaryBytes, primary_bytes: primaryBytes,
    selected_windows: selectedWindows, selected_documents: selectedDocuments,
  };
}
function seal(body) {
  return { ...body, digest: sha256(canonical({ ...body, claims: body.claims.map(row => row.id) })) };
}
function started(key, id, prompt) {
  return { type: 'entry', stage: 'wide-context-started', key, value: { tag: `extract:${id}`, prompt_digest: prompt } };
}
function completed(key, outcome, { accepted = true, usage = { input_tokens: 1, output_tokens: 1, cost: 0.01 } } = {}) {
  return { type: 'entry', stage: 'wide-context-completion', key, value: { result: { outcome, accepted, usage } } };
}

function fixture() {
  const a = 'window:a', b = 'window:b', catalog = [window(a), window(b)];
  const base = { snapshot: { source_sha: 's', corpus_digest: 'c' }, segmentation: { windows: 2 }, window_catalog: catalog, window_conservation: [] };
  const primary = seal({
    ...base, extractor: 'wide-context-extractor@10', extraction_contract: 'v10', status: 'incomplete',
    queue: { total: 2, by_state: { done: 1, quarantined: 1 }, stopped: null },
    budget: { accounted_calls: 2, known_cost_usd: 0.1, max_known_cost_usd: 0.4, unpriced_attempts: 0 },
    metrics: metrics(a, { selectedWindows: 2, selectedDocuments: 2, primaryBytes: 100 }), claims: [claim('c-a', a, 'p-a')],
  });
  const repair = seal({
    ...base, extractor: 'wide-context-extractor@11-provider-repair', extraction_contract: 'v11', status: 'complete',
    queue: { total: 1, by_state: { done: 1 }, stopped: null },
    budget: { accounted_calls: 1, known_cost_usd: 0.02, max_known_cost_usd: 0.2, unpriced_attempts: 0 },
    metrics: metrics(b, { selectedWindows: 1, selectedDocuments: 1, primaryBytes: 40 }), claims: [claim('c-b', b, 'p-b')],
  });
  const header = { type: 'header', fingerprint: { source_sha: 's', corpus_digest: 'c' } };
  const primaryCheckpoint = [header, started('ka', a, 'pa'), completed('ka', 'ok'), started('kb', b, 'pb'),
    completed('kb', 'error:provider', { usage: { input_tokens: 0, output_tokens: 0, cost: 0 } })];
  const repairCheckpoint = [header, started('kr', b, 'pb'), completed('kr', 'ok')];
  return { a, b, primary, repair, primaryCheckpoint, repairCheckpoint };
}

test('targeted provider repair produces complete but non-promotable analytical coverage', () => {
  const held = fixture();
  const result = mergeProviderRepair({
    primary: held.primary, repair: held.repair, repair_window_ids: [held.b],
    primary_checkpoint: held.primaryCheckpoint, repair_checkpoint: held.repairCheckpoint,
  });
  assert.equal(result.status, 'complete_composite_analysis');
  assert.equal(result.promotion_eligible, false);
  assert.deepEqual(result.coverage, { unique_windows: 2, primary_successful_windows: 1, repaired_windows: 1, complete: true });
  assert.deepEqual(result.queue, { unique_units: 2, by_state: { done: 2 }, inference_attempts: 3, primary_attempts: 2, repair_attempts: 1, orphaned_started: 0 });
  assert.equal(result.budget.known_cost_usd, 0.12);
  assert.equal(result.claims.length, 2);
  assert.equal(result.lineage.prompt_equivalence[0].byte_identical, true);
});

test('targeted repair refuses changed prompt bytes', () => {
  const held = fixture();
  held.repairCheckpoint[1].value.prompt_digest = 'changed';
  assert.throws(() => mergeProviderRepair({
    primary: held.primary, repair: held.repair, repair_window_ids: [held.b],
    primary_checkpoint: held.primaryCheckpoint, repair_checkpoint: held.repairCheckpoint,
  }), error => error.code === 'PROMPT_DIGEST_MISMATCH');
});

test('targeted repair refuses an unpriced source run', () => {
  const held = fixture();
  held.repair = seal({ ...held.repair, budget: { ...held.repair.budget, unpriced_attempts: 1 }, digest: undefined });
  assert.throws(() => mergeProviderRepair({
    primary: held.primary, repair: held.repair, repair_window_ids: [held.b],
    primary_checkpoint: held.primaryCheckpoint, repair_checkpoint: held.repairCheckpoint,
  }), error => error.code === 'UNPRICED_ATTEMPT');
});
