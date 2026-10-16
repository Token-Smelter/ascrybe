import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCheckpointJournal } from '../tools/checkpoint-journal.mjs';
import { resolveDisagreementCases } from '../tools/neural-resolution.mjs';

const snapshot = { source_sha: 'sha-test', corpus_digest: 'digest-test' };
const fingerprint = { pipeline: 'test/v1', ...snapshot, models: ['mock'] };

function claim(id, document, statement) {
  return {
    id,
    semantic: {
      subject_refs: [{ ref: 'server' }], predicate_family: 'binds_port', object_or_value: statement,
      polarity: 'affirmed', modality: 'descriptive', scope: {}, valid_time: {},
      provenance: { document_id: document, source_excerpts: [{ file: document, start: 1, end: 1, text: statement }] },
    },
  };
}

function runner() {
  let calls = 0;
  return {
    model: 'mock-resolution',
    async complete() {
      calls += 1;
      return {
        json: {
          resolution: 'supported',
          rationale: 'Source says "binds port".',
          pair_conflict: 'no_conflict',
          side_grounding: [
            { claim_id: 'claim-a', state: 'supported', rationale: 'a says "binds port".', quoted_spans: ['binds port'] },
            { claim_id: 'claim-b', state: 'supported', rationale: 'b says "binds port".', quoted_spans: ['binds port'] },
          ],
          context_relation: { scope: 'same', time: 'same', modality: 'same', referent: 'same' },
          context_note: 'test',
          quoted_spans: ['binds port'],
        },
        text: '', usage: { cost: 0, input_tokens: 1, output_tokens: 1 }, outcome: 'ok', model: 'mock-resolution',
      };
    },
    stats: () => ({ kind: 'mock', calls, cost: 0, per_call: [] }),
    callCount: () => calls,
  };
}

const cases = [{ id: 'case-1', semantic: { case_kind: 'doc_claim_comparison:direct_conflict', claims: ['claim-a', 'claim-b'] } }];
const claimsById = new Map([
  ['claim-a', claim('claim-a', 'a.md', 'binds port 1')],
  ['claim-b', claim('claim-b', 'b.md', 'binds port 2')],
]);

test('resolution resumes from fsynced journal without another model call', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-checkpoint-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.jsonl');

  const firstJournal = await openCheckpointJournal({ file, fingerprint });
  const firstRunner = runner();
  const first = await resolveDisagreementCases({ cases, claimsById, runner: firstRunner, snapshot, checkpoint: firstJournal });
  await firstJournal.close();
  assert.equal(firstRunner.callCount(), 1);
  assert.equal(first.resolutions_total, 1);

  const secondJournal = await openCheckpointJournal({ file, fingerprint });
  const secondRunner = runner();
  const second = await resolveDisagreementCases({ cases, claimsById, runner: secondRunner, snapshot, checkpoint: secondJournal });
  assert.equal(secondRunner.callCount(), 0, 'cached raw result reused after reopen');
  assert.equal(second.resolutions_total, 1, 'cached result is still validated and stored deterministically');
  assert.equal(second.model_stats.calls, 1, 'pre-crash model-call accounting survives resume');
  assert.equal(secondJournal.stats().entries, 2, 'started + completed receipts are both durable');
  await secondJournal.close();
});

test('resolution resume refuses to repurchase an interrupted paid case', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-resolution-interrupted-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.jsonl');
  const firstJournal = await openCheckpointJournal({ file, fingerprint });
  let firstCalls = 0;
  const interrupted = {
    model: 'mock-resolution', kind: 'mock',
    async complete() { firstCalls += 1; throw new Error('simulated resolution process death'); },
    stats: () => ({ kind: 'mock', calls: firstCalls, cost: 0, models: ['mock-resolution'], per_call: [] }),
  };
  await assert.rejects(
    resolveDisagreementCases({ cases, claimsById, runner: interrupted, snapshot, checkpoint: firstJournal }),
    /simulated resolution process death/,
  );
  await firstJournal.close();
  assert.equal(firstCalls, 1);

  const secondJournal = await openCheckpointJournal({ file, fingerprint });
  const replacement = runner();
  await assert.rejects(
    resolveDisagreementCases({ cases, claimsById, runner: replacement, snapshot, checkpoint: secondJournal }),
    error => error?.code === 'INFERENCE_CIRCUIT_OPEN' && error?.detail?.result?.billing_status === 'acceptance_unknown',
  );
  assert.equal(replacement.callCount(), 0);
  await secondJournal.close();
  assert.match(await fs.readFile(file, 'utf8'), /acceptance_unknown/);
});

test('journal rejects a different run fingerprint', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-checkpoint-fp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.jsonl');
  const journal = await openCheckpointJournal({ file, fingerprint });
  await journal.close();
  await assert.rejects(
    openCheckpointJournal({ file, fingerprint: { ...fingerprint, source_sha: 'different' } }),
    /fingerprint mismatch/,
  );
});

test('journal truncates a torn final line and retains complete entries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-checkpoint-torn-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.jsonl');
  const journal = await openCheckpointJournal({ file, fingerprint });
  await journal.put('extraction', 'key-1', { claims: [{ id: 'kept' }] });
  await journal.close();
  await fs.appendFile(file, '{"type":"entry","stage":"extraction"');
  const resumed = await openCheckpointJournal({ file, fingerprint });
  assert.deepEqual(resumed.get('extraction', 'key-1'), { claims: [{ id: 'kept' }] });
  assert.equal(resumed.stats().entries, 1);
  await resumed.close();
});
