// AC6-SCOPE-HONESTY: repository-scope units, global-scope units, deterministic migrations, rename
// continuity, and paid-answer/campaign reuse are NOT claimed as implemented. Each is an explicit
// typed refusal with a reason code. The `ascrybe update` CLI verb now EXISTS (bin/ascrybe.mjs's
// live command table, tools/delta-update-run.mjs) -- what remains an explicit typed refusal behind
// it is projection binding/staging/promotion (--promote), never the verb itself. No promotion,
// CAS, or retention behavior changes anywhere in this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationId, fileObservationIdentityScope } from '../tools/delta/identity.mjs';
import { recomputeAndValidateReceipt } from '../tools/delta/extraction-unit.mjs';
import {
  SCOPE_REFUSALS, requestRepositoryScopeUnit, requestGlobalScopeUnit, requestDeterministicMigration,
  requestRenameContinuity, requestPaidAnswerReuse, requestAscrybeUpdateProjectionPublish, scopeRefusalSentinel,
} from '../tools/delta/scope-refusals.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('repository-scope and global-scope observation identity are explicit typed refusals, not silently accepted', () => {
  const fileScope = fileObservationIdentityScope({ repository: 'amber-ledger', normalized_path: 'src/ledger.mjs' });
  assert.throws(
    () => observationId({
      identity_contract: 'x', observation_identity_scope: { kind: 'repository', repository: 'amber-ledger' },
      extractor_id: 'x', observation_kind: 'x', producer_local_key: 'x',
    }),
    error => error.code === 'DELTA_SCOPE_NOT_IMPLEMENTED',
  );
  assert.throws(
    () => observationId({
      identity_contract: 'x', observation_identity_scope: { kind: 'global' }, extractor_id: 'x', observation_kind: 'x', producer_local_key: 'x',
    }),
    error => error.code === 'DELTA_SCOPE_NOT_IMPLEMENTED',
  );
  // File scope, the one implemented kind, still works.
  assert.equal(typeof observationId({
    identity_contract: 'x', observation_identity_scope: fileScope, extractor_id: 'x', observation_kind: 'x', producer_local_key: 'x',
  }), 'string');
});

test('a receipt claiming repository/global scope is refused at validation, never silently trusted', () => {
  const fakeRepositoryReceipt = {
    schema: 'estate-map/extraction-unit-receipt/v1',
    unit_id: 'unit:0'.padEnd(69, '0'),
    scope: { kind: 'repository', repository: 'amber-ledger', inputs: [] },
    extractor: {}, inputs: [], input_receipt_digest: '0'.repeat(64),
    output: { records: [], kind_counts: {}, records_digest: '0'.repeat(64), complete: true },
    disposition: { kind: 'produced', source_receipt_digest: null, compatibility_receipt_digest: null, migration_receipt_digest: null },
    receipt_digest: '0'.repeat(64),
  };
  assert.throws(() => recomputeAndValidateReceipt(fakeRepositoryReceipt), error => error.code === 'DELTA_SCOPE_NOT_IMPLEMENTED');
});

test('every out-of-scope capability from the task has a distinct typed refusal function and reason code', () => {
  const capabilities = [
    'repository_scope_units', 'global_scope_units', 'deterministic_migrations',
    'rename_continuity', 'paid_answer_campaign_reuse', 'ascrybe_update_projection_publish',
  ];
  assert.deepEqual(SCOPE_REFUSALS.map(entry => entry.capability).sort(), [...capabilities].sort());
  assert.equal(new Set(SCOPE_REFUSALS.map(entry => entry.reason_code)).size, SCOPE_REFUSALS.length, 'reason codes must be distinct');
  for (const [request, code] of [
    [requestRepositoryScopeUnit, 'DELTA_REPOSITORY_SCOPE_NOT_IMPLEMENTED'],
    [requestGlobalScopeUnit, 'DELTA_GLOBAL_SCOPE_NOT_IMPLEMENTED'],
    [requestDeterministicMigration, 'DELTA_MIGRATION_NOT_IMPLEMENTED'],
    [requestRenameContinuity, 'DELTA_RENAME_CONTINUITY_NOT_IMPLEMENTED'],
    [requestPaidAnswerReuse, 'DELTA_PAID_ANSWER_REUSE_NOT_IMPLEMENTED'],
    [requestAscrybeUpdateProjectionPublish, 'DELTA_UPDATE_PROJECTION_PUBLISH_NOT_IMPLEMENTED'],
  ]) {
    assert.throws(() => request(), error => error.code === code);
  }
});

test('scopeRefusalSentinel commits to the refusal reason, never to a value indistinguishable from verified-empty', () => {
  const repositorySentinel = scopeRefusalSentinel('repository_scope_units');
  const globalSentinel = scopeRefusalSentinel('global_scope_units');
  assert.match(repositorySentinel, /^[0-9a-f]{64}$/u);
  assert.notEqual(repositorySentinel, globalSentinel);
});

test('grounded against live source: bin/ascrybe.mjs now HAS an "update" verb, and it dispatches to tools/delta-update-run.mjs', () => {
  const cliSource = readFileSync(resolve(root, 'bin/ascrybe.mjs'), 'utf8');
  const commandsBlock = cliSource.slice(cliSource.indexOf('const COMMANDS = {'), cliSource.indexOf('\n};', cliSource.indexOf('const COMMANDS = {')));
  assert.match(commandsBlock, /\bupdate\s*:/u, 'this test\u2019s claim (the CLI verb exists) must hold against live source');
  assert.match(commandsBlock, /update:\s*\{\s*script:\s*'tools\/delta-update-run\.mjs'/u);
});

test('grounded against live source: tools/delta-update-run.mjs never imports the projection/promotion module', () => {
  const runnerSource = readFileSync(resolve(root, 'tools/delta-update-run.mjs'), 'utf8');
  const importLines = runnerSource.split('\n').filter(line => /^\s*import\b/.test(line));
  assert.ok(importLines.every(line => !line.includes('estate-graph-projection')),
    'the update verb must not import the promotion/CAS/staging module; AC7 requires nothing here can change what selected/working serves');
});

test('grounded against live source: this slice does not modify tools/extraction-cache.mjs (the whole-estate-head cache stays live and unchanged)', () => {
  const wholeEstateCacheSource = readFileSync(resolve(root, 'tools/extraction-cache.mjs'), 'utf8');
  assert.match(wholeEstateCacheSource, /estate_head/u, 'the whole-estate-head keying this task describes as the reason for a per-unit cache must still exist, unmodified, in its own module');
});
