import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { prepassDocument, buildMentionNamespace } from '../tools/source-prepass.mjs';
import { buildPropositionObligationInventory } from '../tools/proposition-obligations.mjs';
import { acceptCandidateJsonlAtProviderBoundary, runCandidateCharacterization } from '../tools/candidate-characterization.mjs';
import { createMockModelRunner } from '../tools/neural-model-runner.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const canonical = value => stableStringify(value).trim();
const content = '# Rule\n\nThe router must not use a fallback.\n';
const snapshot = { source_sha: 'source', corpus_digest: sha256(canonical([{ path: 'rule.md', digest: sha256(content) }])) };
const prepass = prepassDocument({ path: 'rule.md', content, ...snapshot });
const inventories = [prepass.inventory];
const namespace = buildMentionNamespace([prepass]);
const blockByAddress = new Map(prepass.inventory.blocks.map(block => [block.address, block]));
const inventory = buildPropositionObligationInventory({ inventories });
const candidate = inventory.obligations.find(row => row.obligation_kind === 'prohibition');

const validAnswer = () => [
  JSON.stringify({ k: 'head', outcome: 'characterized', reason: 'complete' }),
  JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: 's001', family: 'prohibition',
    predicate: 'must not use', object: 'a fallback', polarity: 'affirmed', modality: 'normative', quantifier: 'all' }),
  JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted', reason: 'claim emitted' }),
  JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
].join('\n');

test('candidate JSONL reaches the stage validator as an accepted provider answer', () => {
  assert.deepEqual(acceptCandidateJsonlAtProviderBoundary(validAnswer()), { wire: 'candidate-characterization-jsonl@8' });
  assert.equal(acceptCandidateJsonlAtProviderBoundary(''), null);
});

test('candidate characterization injects adjacent context as exact required evidence', async () => {
  const localContent = '# Context\n\nForeign projects submit a pinned receiver. Receiver-owned policy plus `intake_router@1.0` resolves that submission before execution.\n';
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'anaphora.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'main_clause'
    && row.locator.text.startsWith('Receiver-owned policy'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-context-'));
  let observedPrompt = '';
  const result = await runCandidateCharacterization({
    inventory: localInventory, inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      observedPrompt = prompt;
      const row = prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(item => item?.candidate === 'c001' && item.focus_text);
      const subject = row.subject_handles[0];
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: subject.subject_ref,
          family: 'capability', predicate: 'resolves', object: 'a foreign-project submission before execution',
          polarity: 'affirmed', modality: 'descriptive', quantifier: 'all' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.match(observedPrompt, /ADJACENT_CONTEXT_START\n# Context\nForeign projects submit a pinned receiver\./);
  assert.match(observedPrompt, /# Context/);
  assert.match(observedPrompt, /"surface":"Receiver-owned policy plus `intake_router@1.0`"/);
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 1);
  const locators = result.claims[0].semantic.support_sets[0].locators;
  assert.equal(locators.length, 3);
  assert.equal(locators.filter(locator => locator.role === 'primary').length, 2);
  assert.ok(locators.some(locator => locator.role === 'primary'
    && locator.text.trim() === 'Foreign projects submit a pinned receiver.'));
  assert.ok(locators.some(locator => locator.role === 'context' && locator.text === '# Context'));
});

async function run(handler, name, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `candidate-${name}-`));
  return runCandidateCharacterization({
    inventory, inventories, namespace, blockByAddress, snapshot,
    checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [candidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(handler, { model: 'mock/candidate' }),
    bounds: {
      max_calls: 2, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 2,
      retryable_outcomes: ['error:provider'], retry_backoff_ms: 0,
      retry_backoff_multiplier: 1, retry_backoff_max_ms: 0, retry_jitter_ratio: 0,
      ...overrides,
    },
  });
}

test('candidate characterization injects exact evidence and emits a complete verified receipt', async () => {
  const result = await run(async () => ({ text: validAnswer() }), 'success');
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].schema, 'estate-map/documentary-claim/v3.3');
  assert.ok(result.claims[0].semantic.support_sets[0].locators
    .some(locator => locator.text === candidate.locator.text && locator.role === 'primary'));
  assert.equal(result.metrics.complete_candidate_receipts, true);
  assert.equal(result.metrics.candidate_claim_links_valid, true);
  assert.deepEqual(result.coverage_receipts[0].admitted_claim_ids, [result.claims[0].id]);
  assert.equal(result.coverage_receipts[0].disposition, 'emitted');
  assert.equal(result.coverage_receipts[0].verification_status, 'validated_exact_source');
});

test('provider retry is a new immutable attempt inside the same explicit materialization', async () => {
  let calls = 0;
  const result = await run(async () => ++calls === 1
    ? { outcome: 'error:provider', text: '', accepted: true }
    : { text: validAnswer() }, 'retry');
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.materializations[0].attempt_count, 2);
  assert.equal(result.materializations[0].selected_attempt, 2);
  assert.equal(result.materializations[0].history[0].selected, false);
  assert.equal(result.materializations[0].history[1].selected, true);
});

test('an explicit candidate follow-up label creates a new logical materialization', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-materialization-label-'));
  const execute = (name, materialization_label = null) => runCandidateCharacterization({
    inventory, inventories, namespace, blockByAddress, snapshot,
    checkpointPath: path.join(directory, `${name}.jsonl`),
    model: 'mock/candidate', candidate_ids: [candidate.id], concurrency: 1,
    materialization_label,
    runnerFactory: () => createMockModelRunner(async () => ({ text: validAnswer() }), { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  const initial = await execute('initial');
  const followup = await execute('followup', 'candidate-terminal-followup-1');
  assert.equal(followup.explicit_materialization_label, 'candidate-terminal-followup-1');
  assert.notEqual(initial.materializations[0].logical_key, followup.materializations[0].logical_key);
  assert.equal(initial.claims[0].semantic.provenance.unit_id, followup.claims[0].semantic.provenance.unit_id);
  assert.equal(initial.claims[0].extraction.prompt_digest, followup.claims[0].extraction.prompt_digest);
});

test('missing per-candidate completion is terminal-incomplete and promotes nothing', async () => {
  const incomplete = [
    JSON.stringify({ k: 'head', outcome: 'characterized', reason: 'cut off' }),
    JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: 's001', family: 'prohibition',
      predicate: 'must not use', object: 'a fallback', polarity: 'affirmed', modality: 'normative', quantifier: 'all' }),
  ].join('\n');
  const result = await run(async () => ({ text: incomplete }), 'incomplete');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.claims.length, 0);
  assert.equal(result.metrics.terminal_incomplete_candidates, 1);
  assert.equal(result.coverage_receipts[0].disposition, 'terminal_incomplete');
  assert.equal(result.queue.by_state.quarantined, 1);
});

test('a child obligation cannot select a sibling-clause unit handle', async () => {
  const localContent = '# Rule\n\nThe `router` rejects `fallback` and the `worker` stores `proof`.\n';
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'local.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'coordinated_clause'
    && row.locator.text.includes('worker'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-local-handle-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory,
    inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot,
    checkpointPath: path.join(directory, 'checkpoint.jsonl'), model: 'mock/candidate',
    candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      assert.match(prompt, /"surface":"worker"/);
      assert.doesNotMatch(prompt, /"surface":"router"/);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        // s001 exists in the unit inventory but is not in this candidate's closed handle set.
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: 's001', family: 'constraint',
          predicate: 'stores', object: 'proof', polarity: 'affirmed', modality: 'descriptive', quantifier: 'all' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.claims.length, 0);
  assert.equal(result.coverage_receipts[0].disposition, 'rejected_only');
});

test('schema scalar handles cannot inherit an explicitly referenced nested property', async () => {
  const localContent = [
    '# Target schema', '',
    '- id: <string>',
    '    type: <repo|service>',
    '    scope:',
    '      path: <string|null>',
    '      branch: <string|null>',
    '',
  ].join('\n');
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'target.yaml', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'schema_constraint'
    && row.support_locator.text.startsWith('- id:'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-schema-owner-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory, inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      const row = prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(item => item?.candidate === 'c001' && item.focus_text);
      const id = row.subject_handles.find(handle => handle.schema_path === 'id');
      const pathHandle = row.subject_handles.find(handle => handle.schema_path === 'id.scope.path');
      assert.ok(id);
      assert.ok(pathHandle);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: id.subject_ref,
          family: 'constraint', predicate: 'has scope.path of type', object: 'string or null',
          polarity: 'affirmed', modality: 'normative', quantifier: 'one' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.claims.length, 0);
  assert.equal(result.coverage_receipts[0].disposition, 'rejected_only');
  assert.ok(result.coverage_receipts[0].rejected_proposal_ids.length > 0);
});

test('a coordinated focus retains governing negation and a clause-local actor handle', async () => {
  const localContent = [
    '# Rule', '',
    '10. **No fallback:** invalid, unknown, ambiguous, or expired wires return `unresolvable_wire`; no alias guessing, legacy fallback, normalization, or secondary lookup occurs.',
    '',
  ].join('\n');
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'scope.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'coordinated_clause'
    && row.locator.text === 'secondary lookup occurs.');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-scoped-focus-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory,
    inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot,
    checkpointPath: path.join(directory, 'checkpoint.jsonl'), model: 'mock/candidate',
    candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      const row = prompt.split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(item => item?.candidate === 'c001' && item.focus_text);
      assert.equal(row.focus_text, 'secondary lookup occurs.');
      assert.match(row.support_text, /no alias guessing, legacy fallback, normalization, or secondary lookup occurs/);
      const subject = row.subject_handles.find(handle => handle.surface === 'secondary lookup');
      assert.ok(subject);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: subject.subject_ref,
          family: 'constraint', predicate: 'occurs', object: 'for invalid, unknown, ambiguous, or expired wires',
          polarity: 'negated', modality: 'descriptive', quantifier: 'all' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].semantic.polarity, 'negated');
  assert.ok(result.claims[0].semantic.support_sets[0].locators
    .some(locator => locator.text === localCandidate.support_locator.text && locator.role === 'primary'));
  assert.equal(result.metrics.candidate_claim_links_valid, true);
  assert.deepEqual(result.coverage_receipts[0].admitted_claim_ids, [result.claims[0].id]);
});

test('a numbered-list ordinal focus inherits its exact item structural subject', async () => {
  const localContent = '# References\n\n3. **`design/canon/recipes.md`** — the current Pattern/Recipe/Batch model.\n';
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'ordinal.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'ordinal_membership');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-list-ordinal-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory, inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      const row = prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(item => item?.candidate === 'c001' && item.focus_text);
      assert.equal(row.focus_text.trim(), '3.');
      const subject = row.subject_handles.find(handle => handle.surface === 'design/canon/recipes.md');
      assert.ok(subject);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: subject.subject_ref,
          family: 'classification', predicate: 'is numbered list item', object: '3',
          polarity: 'affirmed', modality: 'constitutive', quantifier: 'one' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].semantic.subject.surface, 'design/canon/recipes.md');
  assert.equal(result.coverage_receipts[0].disposition, 'emitted');
});

test('candidate admission independently rejects a predicate phrase used as an actor', async () => {
  const localContent = '# Actor\n\nIterative Patterns keep topology but share one optional control plane for atomic iteration state, append-only history.\n';
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'actor.md', content: localContent, ...localSnapshot });
  const built = buildPropositionObligationInventory({ inventories: [localPrepass.inventory] });
  const unit = built.units.find(row => row.locator.text.includes('Iterative Patterns'));
  const phrase = 'share one optional control plane for atomic iteration';
  const localStart = unit.locator.text.indexOf(phrase);
  assert.ok(localStart >= 0);
  const byteStart = unit.locator.byte_start + Buffer.byteLength(unit.locator.text.slice(0, localStart));
  const unsafeHandle = {
    ref: 's001', id: 'candidate-subject-handle:unsafe-fixture', surface: phrase,
    handle_kind: 'predicate_actor', priority: 0,
    locator: { ...unit.locator, byte_start: byteStart,
      byte_end: byteStart + Buffer.byteLength(phrase), text: phrase, text_digest: sha256(phrase) },
  };
  const unsafeUnit = { ...unit, subject_handles: [unsafeHandle] };
  const unsafeInventory = { ...built,
    units: built.units.map(row => row.id === unit.id ? unsafeUnit : row) };
  const localCandidate = unsafeInventory.obligations.find(row => row.source_unit_id === unit.id
    && row.obligation_kind === 'main_clause');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-unsafe-actor-'));
  const result = await runCandidateCharacterization({
    inventory: unsafeInventory, inventories: [localPrepass.inventory],
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async () => ({ text: [
      JSON.stringify({ k: 'head', outcome: 'characterized' }),
      JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: 's001', family: 'other',
        predicate: 'shares', object: 'append-only history', polarity: 'affirmed',
        modality: 'descriptive', quantifier: 'one' }),
      JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
      JSON.stringify({ k: 'end', candidates: 1, relations: 1 }),
    ].join('\n') }), { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 0);
  assert.equal(result.coverage_receipts[0].disposition, 'rejected_only');
});

test('self-referential table cells cannot transfer dossier actions onto the row key', async () => {
  const localContent = [
    '# Platform Recovery Program', '',
    '| Area | Authoritative dossier | This dossier\'s role |',
    '| --- | --- | --- |',
    '| Restart remediation | `design/incidents/restart/DESIGN.md` | References only; the router design in §3 reconciles with its `staged_dispatch_job` reconciler. |',
    '',
  ].join('\n');
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'table-owner.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'table_cell'
    && row.table_column_index === 2 && row.locator.text.startsWith('References only'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-table-owner-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory, inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      const row = prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(item => item?.candidate === 'c001' && item.focus_text);
      assert.equal(row.subject_handles.some(handle => handle.surface === 'Restart remediation'), false);
      const dossier = row.subject_handles.find(handle => handle.surface === 'This dossier');
      const router = row.subject_handles.find(handle => handle.surface === 'the router design in §3');
      assert.ok(dossier);
      assert.ok(router);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: dossier.subject_ref,
          family: 'dependency', predicate: 'references only', object: 'Restart remediation',
          polarity: 'affirmed', modality: 'descriptive', quantifier: 'one' }),
        JSON.stringify({ k: 'rel', i: 2, candidate: 'c001', subject_ref: router.subject_ref,
          family: 'dependency', predicate: 'reconciles with', object: 'its staged_dispatch_job reconciler',
          polarity: 'affirmed', modality: 'descriptive', quantifier: 'one' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 2 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.claims.length, 2);
  assert.deepEqual(new Set(result.claims.map(claim => claim.semantic.subject.surface)),
    new Set(['This dossier', 'the router design in §3']));
  assert.equal(result.coverage_receipts[0].disposition, 'emitted');
});

test('rank values cannot become table actors and the entity cell owns ordinal claims', async () => {
  const localContent = [
    '# Roadmap', '',
    '| Rank | Technique and research source | Cost |',
    '| --- | --- | --- |',
    '| **5** | **Specification-aware prefix monitor** from the failure study | M–H |',
    '',
  ].join('\n');
  const localSnapshot = { source_sha: 'source', corpus_digest: sha256(localContent) };
  const localPrepass = prepassDocument({ path: 'rank.md', content: localContent, ...localSnapshot });
  const localInventories = [localPrepass.inventory];
  const localInventory = buildPropositionObligationInventory({ inventories: localInventories });
  const localCandidate = localInventory.obligations.find(row => row.obligation_kind === 'main_clause'
    && row.locator.text.includes('Specification-aware prefix monitor'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'candidate-table-rank-'));
  const result = await runCandidateCharacterization({
    inventory: localInventory, inventories: localInventories,
    namespace: buildMentionNamespace([localPrepass]),
    blockByAddress: new Map(localPrepass.inventory.blocks.map(row => [row.address, row])),
    snapshot: localSnapshot, checkpointPath: path.join(directory, 'checkpoint.jsonl'),
    model: 'mock/candidate', candidate_ids: [localCandidate.id], concurrency: 1,
    runnerFactory: () => createMockModelRunner(async ({ prompt }) => {
      const row = prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(item => item?.candidate === 'c001' && item.focus_text);
      assert.equal(row.subject_handles.some(handle => handle.surface === '5'), false);
      const entity = row.subject_handles.find(handle => handle.surface === 'Specification-aware prefix monitor');
      assert.ok(entity);
      return { text: [
        JSON.stringify({ k: 'head', outcome: 'characterized' }),
        JSON.stringify({ k: 'rel', i: 1, candidate: 'c001', subject_ref: 's001', family: 'ordinal',
          predicate: 'has roadmap rank', object: '5', polarity: 'affirmed', modality: 'descriptive', quantifier: 'one' }),
        JSON.stringify({ k: 'rel', i: 2, candidate: 'c001', subject_ref: entity.subject_ref, family: 'ordinal',
          predicate: 'has roadmap rank', object: '5', polarity: 'affirmed', modality: 'descriptive', quantifier: 'one' }),
        JSON.stringify({ k: 'candidate_end', candidate: 'c001', disposition: 'emitted' }),
        JSON.stringify({ k: 'end', candidates: 1, relations: 2 }),
      ].join('\n') };
    }, { model: 'mock/candidate' }),
    bounds: { max_calls: 1, max_known_cost_usd: 1, cost_reserve_per_call_usd: 0.1,
      max_unpriced_attempts: 0, max_attempts_per_unit: 1, retryable_outcomes: [] },
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].semantic.subject.surface, 'Specification-aware prefix monitor');
  assert.equal(result.coverage_receipts[0].rejected_proposal_ids.length, 1);
});

test('candidate tests refuse a spend cap of $25 or more', async () => {
  await assert.rejects(() => run(async () => ({ text: validAnswer() }), 'cap', { max_known_cost_usd: 25 }), /strictly below \$25/);
});
