import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepassDocument, buildMentionNamespace } from '../tools/source-prepass.mjs';
import { createWindowBlockCatalog } from '../tools/source-locator.mjs';
import { buildClaimV33 } from '../tools/claim-v33.mjs';
import { acceptRepairAuditJsonlAtProviderBoundary, buildRepairAuditPackets,
  runRepairClaimAudit, validateRepairAuditAnswer } from '../tools/repair-claim-audit.mjs';
import { createMockModelRunner } from '../tools/neural-model-runner.mjs';
import { sha256 } from '../tools/lib.mjs';

const content = 'The router rejects stale work.\n';
const snapshot = { source_sha: 'source', corpus_digest: 'corpus' };
const prepass = prepassDocument({ path: 'rule.md', content, ...snapshot });
const block = prepass.inventory.blocks[0];
const window = { id: 'window:audit', file: 'rule.md', primary_block_addresses: [block.address], context_block_addresses: [], snapshot };
const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
const namespace = buildMentionNamespace([prepass]);
const locator = { block_token: 'b001', quote: 'The router rejects stale work.', occurrence: null };
const claim = buildClaimV33({
  proposed: {
    subject_binding: 'explicit', subject_mention: { surface: 'The router', source_locator: locator },
    relation_family: 'constraint', predicate_family: 'rejects', object_or_value: 'stale work',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'all',
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: locator }] }],
  },
  window, catalog, namespace, model_identifier: 'generator', prompt_digest: sha256('generator'),
  repair_findings: [{ code: 'TEST_REPAIR' }],
});

test('repair audit JSONL is accepted at the provider boundary for stage validation', () => {
  assert.deepEqual(acceptRepairAuditJsonlAtProviderBoundary('{"k":"head"}\n{"k":"end"}'), { wire: 'repair-audit-jsonl@1' });
  assert.equal(acceptRepairAuditJsonlAtProviderBoundary('  '), null);
});

test('a new blind seed gives an explicit audit follow-up a new packet and review identity', () => {
  const original = buildRepairAuditPackets({ claims: [claim], seed: 'audit-attempt-1', packet_size: 1 });
  const followup = buildRepairAuditPackets({ claims: [claim], seed: 'audit-followup-2', packet_size: 1 });
  assert.notEqual(followup.packets[0].id, original.packets[0].id);
  assert.notEqual(Object.keys(followup.key)[0], Object.keys(original.key)[0]);
  assert.notEqual(followup.seed_digest, original.seed_digest);
});

test('repair audit uniquely repairs an observed Cyrillic-e mutation in a tool-owned blind id', () => {
  const blind = buildRepairAuditPackets({ claims: [claim], seed: 'confusable-id', packet_size: 1 });
  const packet = blind.packets[0];
  const id = packet.rows[0].review_id;
  assert.match(id, /e/u);
  const authoredId = id.replace('e', '\u0435');
  const validated = validateRepairAuditAnswer({ packet, response: { text: [
    JSON.stringify({ k: 'head', outcome: 'audited' }),
    JSON.stringify({ k: 'grade', id: authoredId, entailed: true,
      subject_binding_correct: true, severe_error: false }),
    JSON.stringify({ k: 'end' }),
  ].join('\n') } });
  assert.equal(validated.ok, true);
  assert.equal(validated.value.grades[0].id, id);
  assert.deepEqual(validated.value.grades[0].receipt_repair, {
    mode: 'unique_expected_cyrillic_e_to_latin_e', authored_id: authoredId,
  });
});

test('repair audit does not normalize an unknown blind id into a non-expected address', () => {
  const blind = buildRepairAuditPackets({ claims: [claim], seed: 'strict-id', packet_size: 1 });
  const validated = validateRepairAuditAnswer({ packet: blind.packets[0], response: { text: [
    JSON.stringify({ k: 'head', outcome: 'audited' }),
    JSON.stringify({ k: 'grade', id: 'r\u0435deadbeefdeadbee', entailed: true,
      subject_binding_correct: true, severe_error: false }),
    JSON.stringify({ k: 'end' }),
  ].join('\n') } });
  assert.equal(validated.ok, false);
  assert.equal(validated.terminal_incomplete, true);
});

test('repair audit keeps a complete grade prefix non-promotable when the trailer is malformed', () => {
  const blind = buildRepairAuditPackets({ claims: [claim], seed: 'malformed-trailer', packet_size: 1 });
  const packet = blind.packets[0];
  const validated = validateRepairAuditAnswer({ packet, response: { text: [
    JSON.stringify({ k: 'head', outcome: 'audited' }),
    JSON.stringify({ k: 'grade', id: packet.rows[0].review_id, entailed: true,
      subject_binding_correct: true, severe_error: false }),
    '{"k":"end","count":1"}',
  ].join('\n') } });
  assert.equal(validated.ok, false);
  assert.equal(validated.terminal_incomplete, true);
  assert.equal(validated.salvage.status, 'non_promotable');
  assert.equal(validated.salvage.grades.length, 1);
  assert.equal(validated.salvage.validation.trailer_valid, false);
});

test('repair audit accepts the exact legacy numeric trailer for replay compatibility', () => {
  const blind = buildRepairAuditPackets({ claims: [claim], seed: 'legacy-trailer', packet_size: 1 });
  const packet = blind.packets[0];
  const validated = validateRepairAuditAnswer({ packet, response: { text: [
    JSON.stringify({ k: 'head', outcome: 'audited' }),
    JSON.stringify({ k: 'grade', id: packet.rows[0].review_id, entailed: true,
      subject_binding_correct: true, severe_error: false }),
    JSON.stringify({ k: 'end', count: 1 }),
  ].join('\n') } });
  assert.equal(validated.ok, true);
});

test('repair audit blinds repair metadata and exhaustively validates exact evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-audit-'));
  const handler = async ({ prompt }) => {
    assert.doesNotMatch(prompt, /TEST_REPAIR|claim-v33:/);
    const id = /"review_id":"([^"]+)"/.exec(prompt)[1];
    return { text: [
      JSON.stringify({ k: 'head', outcome: 'audited' }),
      JSON.stringify({ k: 'grade', id, entailed: true, subject_binding_correct: true, severe_error: false, note: 'Exact evidence states the claim.' }),
      JSON.stringify({ k: 'end' }),
    ].join('\n') };
  };
  const result = await runRepairClaimAudit({
    claims: [claim], documents: [{ path: 'rule.md', content }],
    checkpointPath: path.join(directory, 'checkpoint.jsonl'), model: 'mock/reviewer',
    runnerFactory: () => createMockModelRunner(handler, { model: 'mock/reviewer' }),
    concurrency: 1,
    bounds: { packet_size: 1, max_calls: 2, max_known_cost_usd: 1,
      cost_reserve_per_call_usd: 0.1, max_unpriced_attempts: 0,
      max_attempts_per_unit: 2, retryable_outcomes: ['error:provider'], retry_backoff_ms: 0 },
  });
  assert.equal(result.pass, true);
  assert.equal(result.metrics.graded, 1);
  assert.equal(result.metrics.exact_source_verification.rate, 1);
  assert.deepEqual(result.blinded_fields, ['repair_findings', 'original_claim_id', 'case_number', 'arm_label']);
});

test('repair audit refuses a spend cap at or above $25', async () => {
  await assert.rejects(() => runRepairClaimAudit({
    claims: [claim], documents: [{ path: 'rule.md', content }], checkpointPath: '/tmp/unused-audit.jsonl',
    model: 'mock/reviewer', runnerFactory: () => createMockModelRunner(async () => ({})),
    bounds: { max_known_cost_usd: 25 },
  }), /strictly below \$25/);
});
