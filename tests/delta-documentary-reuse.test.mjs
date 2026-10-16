// tools/delta/documentary-reuse.mjs: paid-answer reuse for the documentary claims layer, proven
// against the REAL production admission path (tools/semantic-claim-extractor.mjs
// extractSemanticClaims()) -- never a hand-rolled substitute. Every fixture name is invented
// (CONTRIBUTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSemanticClaims } from '../tools/semantic-claim-extractor.mjs';
import {
  backfillJournalModel, loadAnswerJournal, mergeParentAnswers, offlineNoDispatchRunner, planDocumentaryReuse,
} from '../tools/delta/documentary-reuse.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

// A deterministic stand-in "model": one claim per document, named after the document's own
// content, so two windows with different bytes always propose visibly different claims and two
// windows with identical bytes always propose identical ones -- exactly the signal reuse depends
// on being trustworthy.
function respondingRunner({ calls, refuseIfDigestIn = null } = {}) {
  return {
    async complete({ prompt }) {
      if (calls) calls.push(prompt);
      const digest = prompt; // identity is fine for a fixture-scale test
      if (refuseIfDigestIn?.has(digest)) throw new Error('a covered window must never be live-dispatched');
      const quoted = prompt.match(/CLAIM:(.+)/u)?.[1]?.trim() ?? 'fallback';
      return {
        outcome: 'ok',
        json: { claims: [{ statement: `The project states ${quoted}.`, claim_kind: 'current_capability',
          source_status: 'current', decision_status: 'accepted', line: 3, quote: quoted }] },
        usage: { cost: 0.001, input_tokens: 10, output_tokens: 10 },
      };
    },
  };
}

function tree(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
}

const manifestFor = files => ({ files: Object.keys(files).map(path => ({ path })) });

test('planDocumentaryReuse classifies an unchanged window as reusable and a changed one as new', async () => {
  const root = scratchDir('reuse-plan-');
  try {
    const baseRoot = join(root, 'base');
    const targetRoot = join(root, 'target');
    tree(baseRoot, { 'notes.md': '# Notes\n\nCLAIM: alpha ships today\n' });
    tree(targetRoot, {
      'notes.md': '# Notes\n\nCLAIM: alpha ships today\n', // byte-identical: unchanged
      'plan.md': '# Plan\n\nCLAIM: beta is proposed\n', // new document
    });
    const journalDir = join(root, 'base-journal');
    await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '1'.repeat(40) },
      materialized_root: baseRoot, tree_manifest: manifestFor({ 'notes.md': 1 }),
      document_paths: ['notes.md'], code_facts: [], checks: [],
      runner: respondingRunner(), journal_dir: journalDir,
    });

    const plan = planDocumentaryReuse({
      document_paths: ['notes.md', 'plan.md'], materialized_root: targetRoot,
      parent_journals: [{ label: 'base', path: join(journalDir, 'extraction-calls.jsonl') }],
    });
    assert.equal(plan.windows, 2);
    assert.equal(plan.reusable, 1);
    assert.equal(plan.new, 1);
    assert.equal(plan.reusable_windows[0].path, 'notes.md');
    assert.equal(plan.reusable_windows[0].reused_from, 'base');
    assert.equal(plan.new_windows[0].path, 'plan.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mergeParentAnswers imports a parent hit once and never overwrites an entry the run already has', async () => {
  const root = scratchDir('reuse-merge-');
  try {
    const baseRoot = join(root, 'base');
    tree(baseRoot, { 'notes.md': '# Notes\n\nCLAIM: alpha ships today\n' });
    const parentJournalDir = join(root, 'parent-journal');
    await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '1'.repeat(40) },
      materialized_root: baseRoot, tree_manifest: manifestFor({ 'notes.md': 1 }),
      document_paths: ['notes.md'], code_facts: [], checks: [],
      runner: respondingRunner(), journal_dir: parentJournalDir,
    });
    const parentPath = join(parentJournalDir, 'extraction-calls.jsonl');
    const ownPath = join(root, 'own', 'extraction-calls.jsonl');

    const first = mergeParentAnswers({ own_journal_path: ownPath, parent_journals: [{ label: 'base', path: parentPath }] });
    assert.equal(first.imported_by_parent.base, 1);
    const ownAfterFirst = loadAnswerJournal(ownPath);
    assert.equal(ownAfterFirst.size, 1);
    const [imported] = ownAfterFirst.values();
    assert.equal(imported.reused_from_parent, 'base');
    // The original answer bytes travel unchanged.
    const original = [...loadAnswerJournal(parentPath).values()][0];
    assert.deepEqual(imported.answer, original.answer);
    assert.equal(imported.answer_digest, original.answer_digest);

    // Idempotent: calling it again imports nothing new.
    const second = mergeParentAnswers({ own_journal_path: ownPath, parent_journals: [{ label: 'base', path: parentPath }] });
    assert.equal(second.imported_by_parent.base, 0);
    assert.equal(loadAnswerJournal(ownPath).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a window fully covered by a retained parent journal is never live-dispatched and admits the identical claim a full run produced', async () => {
  const root = scratchDir('reuse-equivalence-');
  try {
    const baseRoot = join(root, 'base');
    const targetRoot = join(root, 'target');
    // notes.md is byte-identical across epochs; plan.md only exists at target.
    const noteContent = '# Notes\n\nCLAIM: alpha ships today\n';
    tree(baseRoot, { 'notes.md': noteContent });
    tree(targetRoot, { 'notes.md': noteContent, 'plan.md': '# Plan\n\nCLAIM: beta is proposed\n' });

    // Base epoch's own retained campaign.
    const baseJournalDir = join(root, 'base-journal');
    const baseResult = await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '1'.repeat(40) },
      materialized_root: baseRoot, tree_manifest: manifestFor({ 'notes.md': 1 }),
      document_paths: ['notes.md'], code_facts: [], checks: [],
      runner: respondingRunner(), journal_dir: baseJournalDir,
    });

    // Reference: a FULL run at target that dispatches every window fresh.
    const fullJournalDir = join(root, 'full-journal');
    const fullResult = await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '2'.repeat(40) },
      materialized_root: targetRoot, tree_manifest: manifestFor({ 'notes.md': 1, 'plan.md': 1 }),
      document_paths: ['notes.md', 'plan.md'], code_facts: [], checks: [],
      runner: respondingRunner(), journal_dir: fullJournalDir,
    });

    // Delta candidate: reuse base's answer for notes.md, reuse target's own already-paid answer
    // for plan.md (standing in for "this delta run's one genuinely new dispatch, already paid"),
    // then re-run extraction with a runner that THROWS if it is ever actually called -- proving
    // every window in this scope is served from custody, not a live call.
    const deltaJournalDir = join(root, 'delta-journal');
    const merge = mergeParentAnswers({
      own_journal_path: join(deltaJournalDir, 'extraction-calls.jsonl'),
      parent_journals: [
        { label: 'base', path: join(baseJournalDir, 'extraction-calls.jsonl') },
        { label: 'target-already-paid', path: join(fullJournalDir, 'extraction-calls.jsonl') },
      ],
    });
    assert.equal(merge.imported_by_parent.base, 1);
    assert.equal(merge.imported_by_parent['target-already-paid'], 1);

    const throwingRunner = { async complete() { throw new Error('must not be dispatched: every window here has a retained answer'); } };
    const deltaResult = await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '2'.repeat(40) },
      materialized_root: targetRoot, tree_manifest: manifestFor({ 'notes.md': 1, 'plan.md': 1 }),
      document_paths: ['notes.md', 'plan.md'], code_facts: [], checks: [],
      runner: throwingRunner, journal_dir: deltaJournalDir,
    });

    assert.equal(deltaResult.receipt.conservation.model_calls, 0, 'nothing was live-dispatched');
    assert.deepEqual(
      deltaResult.claims.map(claim => ({ key: claim.claim_key, statement: claim.statement })),
      fullResult.claims.map(claim => ({ key: claim.claim_key, statement: claim.statement })),
      'the reuse-composed claim set exactly equals the full reference claim set',
    );
    // And the reused notes.md claim is the ORIGINAL base-epoch answer, not a relabelled one.
    const baseNoteClaim = baseResult.claims.find(claim => claim.source.path === 'notes.md');
    const deltaNoteClaim = deltaResult.claims.find(claim => claim.source.path === 'notes.md');
    assert.equal(deltaNoteClaim.statement, baseNoteClaim.statement);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a window with no retained answer anywhere is refused, never fabricated, under the offline runner', async () => {
  const root = scratchDir('reuse-offline-refusal-');
  try {
    const baseRoot = join(root, 'base');
    const targetRoot = join(root, 'target');
    const noteContent = '# Notes\n\nCLAIM: alpha ships today\n';
    tree(baseRoot, { 'notes.md': noteContent });
    tree(targetRoot, { 'notes.md': noteContent, 'plan.md': '# Plan\n\nCLAIM: beta is genuinely new\n' });

    const baseJournalDir = join(root, 'base-journal');
    await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '1'.repeat(40) },
      materialized_root: baseRoot, tree_manifest: manifestFor({ 'notes.md': 1 }),
      document_paths: ['notes.md'], code_facts: [], checks: [],
      runner: respondingRunner(), journal_dir: baseJournalDir,
    });

    const deltaJournalDir = join(root, 'delta-journal');
    mergeParentAnswers({
      own_journal_path: join(deltaJournalDir, 'extraction-calls.jsonl'),
      parent_journals: [{ label: 'base', path: join(baseJournalDir, 'extraction-calls.jsonl') }],
    });

    const result = await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '2'.repeat(40) },
      materialized_root: targetRoot, tree_manifest: manifestFor({ 'notes.md': 1, 'plan.md': 1 }),
      document_paths: ['notes.md', 'plan.md'], code_facts: [], checks: [],
      runner: offlineNoDispatchRunner(), journal_dir: deltaJournalDir,
    });

    assert.equal(result.claims.filter(claim => claim.source.path === 'notes.md').length, 1, 'the reused window still admits its claim');
    assert.equal(result.claims.filter(claim => claim.source.path === 'plan.md').length, 0, 'no claim is fabricated for the uncovered window');
    // The uncovered window went through offlineNoDispatchRunner, which never contacts a live
    // provider -- it must be counted as an offline refusal, never inflate model_calls.
    assert.equal(result.receipt.conservation.model_calls, 0, 'offlineNoDispatchRunner never counts as a live call');
    assert.equal(result.receipt.conservation.offline_refusals, 1, 'the one uncovered window is counted as an offline refusal');
    const refusal = result.receipt.refusals.find(row => row.document === 'plan.md');
    assert.equal(refusal.reason, 'model_call_pre_dispatch_refused:offline_no_new_dispatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model-scoped reuse refuses an entry recorded under a different model, and refuses an unlabeled legacy entry too', async () => {
  const root = scratchDir('reuse-model-scope-');
  try {
    const baseRoot = join(root, 'base');
    tree(baseRoot, { 'notes.md': '# Notes\n\nCLAIM: alpha ships today\n' });
    const journalDir = join(root, 'journal');
    await extractSemanticClaims({
      project: { id: 'invented-estate', sha: '1'.repeat(40) },
      materialized_root: baseRoot, tree_manifest: manifestFor({ 'notes.md': 1 }),
      document_paths: ['notes.md'], code_facts: [], checks: [],
      runner: { ...respondingRunner(), model: 'invented-provider/primary-5' }, journal_dir: journalDir,
    });
    const journalPath = join(journalDir, 'extraction-calls.jsonl');

    // The entry now records its own model (tools/semantic-claim-extractor.mjs writes it).
    const permissive = loadAnswerJournal(journalPath);
    assert.equal(permissive.size, 1, 'omitting expected_model is unchanged: permissive loading');
    const [entry] = permissive.values();
    assert.equal(entry.model, 'invented-provider/primary-5');

    const matching = loadAnswerJournal(journalPath, { expected_model: 'invented-provider/primary-5' });
    assert.equal(matching.size, 1, 'an entry recorded under the expected model loads');

    const mismatched = loadAnswerJournal(journalPath, { expected_model: 'invented-provider/primary-6' });
    assert.equal(mismatched.size, 0, 'an entry recorded under a DIFFERENT model is refused, never treated as reusable');

    // A legacy entry with no recorded model at all -- refused when the caller cares about scoping,
    // never silently assumed to match.
    writeFileSync(join(root, 'legacy.jsonl'), `${JSON.stringify({ prompt_digest: 'x', outcome: 'ok', answer: { claims: [] } })}\n`);
    const legacyScoped = loadAnswerJournal(join(root, 'legacy.jsonl'), { expected_model: 'invented-provider/primary-6' });
    assert.equal(legacyScoped.size, 0, 'an unlabeled legacy entry is refused under model-scoped loading');
    const legacyPermissive = loadAnswerJournal(join(root, 'legacy.jsonl'));
    assert.equal(legacyPermissive.size, 1, 'the same unlabeled entry still loads when the caller does not ask for model scoping');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backfillJournalModel makes an old journal\'s provenance explicit, once, and refuses to relabel a genuinely mixed file', () => {
  const root = scratchDir('reuse-backfill-');
  try {
    const path = join(root, 'legacy.jsonl');
    writeFileSync(path, [
      JSON.stringify({ prompt_digest: 'a', outcome: 'ok', answer: { claims: [] } }),
      JSON.stringify({ prompt_digest: 'b', outcome: 'ok', answer: { claims: [] } }),
    ].join('\n'));

    const first = backfillJournalModel({ path, model: 'invented-provider/primary-5' });
    assert.equal(first.backfilled, 2);
    const loaded = loadAnswerJournal(path, { expected_model: 'invented-provider/primary-5' });
    assert.equal(loaded.size, 2, 'both entries are now usable under model-scoped loading');

    // Idempotent: re-running with the SAME model changes nothing.
    const second = backfillJournalModel({ path, model: 'invented-provider/primary-5' });
    assert.equal(second.backfilled, 0);

    // A genuinely mixed file is refused, never silently overwritten.
    writeFileSync(join(root, 'mixed.jsonl'), [
      JSON.stringify({ prompt_digest: 'a', outcome: 'ok', answer: { claims: [] }, model: 'invented-provider/primary-5' }),
      JSON.stringify({ prompt_digest: 'b', outcome: 'ok', answer: { claims: [] }, model: 'invented-provider/primary-6' }),
    ].join('\n'));
    assert.throws(() => backfillJournalModel({ path: join(root, 'mixed.jsonl'), model: 'invented-provider/primary-5' }),
      /already names model/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('offlineNoDispatchRunner never resolves to a claim and never throws', async () => {
  const runner = offlineNoDispatchRunner({ model: 'invented/offline' });
  const result = await runner.complete({ prompt: 'anything' });
  assert.equal(result.outcome, 'pre_dispatch_refused:offline_no_new_dispatch');
  assert.equal(result.accepted, false);
  assert.equal(result.json, null);
  assert.equal(runner.model, 'invented/offline');
});

test('loadAnswerJournal skips a corrupt line and an unusable outcome without throwing', () => {
  const root = scratchDir('reuse-journal-load-');
  try {
    const path = join(root, 'j.jsonl');
    writeFileSync(path, [
      JSON.stringify({ prompt_digest: 'a', outcome: 'ok', answer: { claims: [] } }),
      'not json at all',
      JSON.stringify({ prompt_digest: 'b', outcome: 'provider_error', answer: null }),
      JSON.stringify({ prompt_digest: 'c', outcome: 'ok' }), // no answer
    ].join('\n'));
    const journal = loadAnswerJournal(path);
    assert.deepEqual([...journal.keys()], ['a']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadAnswerJournal returns an empty map for a missing file', () => {
  assert.equal(loadAnswerJournal('/nonexistent/path/does-not-exist.jsonl').size, 0);
});
