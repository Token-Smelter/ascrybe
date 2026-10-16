import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtractionPrompt, extractSemanticClaims, windowDocument } from '../tools/semantic-claim-extractor.mjs';
import { sha256 } from '../tools/lib.mjs';

test('a malformed proposal keeps conservation balanced', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'DESIGN.md'), '# Design\n\nThe runner verifies the digest.\n');

    const runner = { complete: async () => ({
      outcome: 'ok',
      json: { claims: [
        // One well-formed proposal, and two the model got wrong in different ways.
        { statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
          source_status: 'current', decision_status: 'accepted', line: 3,
          quote: 'The runner verifies the digest.' },
        ['not', 'an', 'object'],
        'also not an object',
      ] },
      usage: { cost: 0, input_tokens: 1, output_tokens: 1 },
    }) };

    const held = await extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) },
      materialized_root: estate,
      tree_manifest: { files: [{ path: 'DESIGN.md' }] },
      document_paths: ['DESIGN.md'],
      code_facts: [], checks: [], runner,
      journal_dir: join(root, 'journal'),
    });

    const c = held.receipt.conservation;
    const refusals = held.receipt.refusals;
    // An array is typeof 'object' and a string is not, so the two malformed shapes are refused
    // for different and more precise reasons. What matters is that both are refused ABOUT a
    // proposal while having no statement to show.
    const statementless = refusals.filter(row => row.scope === 'proposal' && row.proposed_statement === null);
    assert.deepEqual({
      balanced: c.admitted_claims + c.refused_proposals === c.proposed_claims,
      proposed: c.proposed_claims,
      admitted: c.admitted_claims,
      refusedProposals: c.refused_proposals,
      statementlessButCounted: statementless.length,
      // Counting the old way would have missed exactly these and thrown.
      oldCount: refusals.filter(row => row.proposed_statement !== null).length,
    }, {
      balanced: true,
      proposed: 3,
      admitted: 1,
      refusedProposals: 2,
      statementlessButCounted: 2,
      oldCount: 0,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a run whose provider reports no cost reports unknown, not zero', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-cost-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'DESIGN.md'), '# Design\n\nThe runner verifies the digest.\n');

    const answer = usage => ({
      outcome: 'ok',
      json: { claims: [{ statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
        source_status: 'current', decision_status: 'accepted', line: 3,
        quote: 'The runner verifies the digest.' }] },
      usage,
    });
    const run = async usage => extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) },
      materialized_root: estate,
      tree_manifest: { files: [{ path: 'DESIGN.md' }] },
      document_paths: ['DESIGN.md'],
      code_facts: [], checks: [],
      runner: { complete: async () => answer(usage) },
      journal_dir: join(root, `journal-${Math.abs(JSON.stringify(usage ?? null).length)}`),
    });

    const silent = await run({ input_tokens: 1, output_tokens: 1 });
    assert.equal(silent.receipt.conservation.reported_cost_usd, null,
      'a provider reporting no cost must not be recorded as costing nothing');
    assert.ok(silent.receipt.conservation.model_calls > 0, 'the calls were still made');

    const priced = await run({ cost: 0.25, input_tokens: 1, output_tokens: 1 });
    assert.equal(priced.receipt.conservation.reported_cost_usd, 0.25);

    // A genuinely free call is a reported zero and stays distinguishable from silence. A
    // subscription-billed model reports exactly this, so the zero has to survive as a zero.
    const free = await run({ cost: 0, cost_reported: true, input_tokens: 1, output_tokens: 1 });
    assert.equal(free.receipt.conservation.reported_cost_usd, 0);

    // `emptyInferenceUsage()` is `{cost: 0, cost_reported: false}`. A number is present and means
    // nothing; reading it as a reported zero is the defect this whole check exists to prevent.
    const placeholder = await run({ cost: 0, cost_reported: false, input_tokens: 1, output_tokens: 1 });
    assert.equal(placeholder.receipt.conservation.reported_cost_usd, null,
      'an unreported cost carrying a placeholder zero is still unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('a window carrying a null byte is refused, not thrown', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-nul-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'CLEAN.md'), '# Clean\n\nThe runner verifies the digest.\n');
    writeFileSync(join(estate, 'BINARY.md'), `# Binary\n\nThe runner holds a ${'\u0000'} byte here.\n`);

    let dispatched = 0;
    const held = await extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) },
      materialized_root: estate,
      tree_manifest: { files: [{ path: 'CLEAN.md' }, { path: 'BINARY.md' }] },
      document_paths: ['CLEAN.md', 'BINARY.md'],
      code_facts: [], checks: [],
      runner: { complete: async () => {
        dispatched += 1;
        return { outcome: 'ok', usage: { cost: 0.25, cost_reported: true },
          json: { claims: [{ statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
            source_status: 'current', decision_status: 'accepted', line: 3,
            quote: 'The runner verifies the digest.' }] } };
      } },
      journal_dir: join(root, 'journal'),
    });

    const conservation = held.receipt.conservation;
    assert.equal(conservation.uncalled_windows, 1, 'the null-byte window is counted');
    assert.equal(dispatched, conservation.model_calls, 'a refused window is never dispatched');
    assert.ok(conservation.model_calls >= 1, 'the clean document still ran');
    // Nothing silently vanishes: the window appears as a refusal with its own reason.
    assert.ok(held.receipt.refusals.some(row => row.document === 'BINARY.md' && row.scope === 'window'));
    // The spend denominator is what was actually paid for, not what was attempted.
    assert.equal(conservation.reported_cost_usd, 0.25 * conservation.model_calls);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A runner MAY report `dispatched: false` to mean an outcome touched no live provider (an
// offline/plan-only runner refusing a window with no retained answer) -- distinct from a live call
// that happened to fail. Before this field existed, every non-journal-hit answer counted as a
// "call" regardless of what the plugged-in runner actually did, so a zero-spend offline run still
// reported a nonzero model_calls count.
test('a runner-reported dispatched:false outcome counts as an offline refusal, never a model call', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-dispatched-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'DESIGN.md'), '# Design\n\nThe runner verifies the digest.\n');

    const held = await extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) },
      materialized_root: estate,
      tree_manifest: { files: [{ path: 'DESIGN.md' }] },
      document_paths: ['DESIGN.md'], code_facts: [], checks: [],
      runner: { complete: async () => ({ outcome: 'pre_dispatch_refused:offline', accepted: false,
        json: null, text: '', usage: null, dispatched: false }) },
      journal_dir: join(root, 'journal'),
    });

    assert.equal(held.receipt.conservation.model_calls, 0, 'a dispatched:false outcome must never inflate model_calls');
    assert.equal(held.receipt.conservation.offline_refusals, 1);
    assert.equal(held.claims.length, 0, 'no claim is fabricated for a window nothing answered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Omitting `dispatched` entirely (every runner that predates this field) must behave exactly as
// before: a live call, counted under model_calls.
test('a runner that never sets dispatched is still counted as a model call, unchanged', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-dispatched-default-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'DESIGN.md'), '# Design\n\nThe runner verifies the digest.\n');

    const held = await extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) },
      materialized_root: estate,
      tree_manifest: { files: [{ path: 'DESIGN.md' }] },
      document_paths: ['DESIGN.md'], code_facts: [], checks: [],
      runner: { complete: async () => ({ outcome: 'ok',
        json: { claims: [{ statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
          source_status: 'current', decision_status: 'accepted', line: 3,
          quote: 'The runner verifies the digest.' }] },
        usage: { cost: 0.01, cost_reported: true } }) },
      journal_dir: join(root, 'journal'),
    });

    assert.equal(held.receipt.conservation.model_calls, 1);
    assert.equal(held.receipt.conservation.offline_refusals, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Reused answers cost nothing NOW, but were paid for by whichever run dispatched them first --
// folding both into one total makes a delta run that reused almost everything look as expensive as
// the run that originally paid for it, and hides the number a caller deciding whether to run a
// delta update actually needs.
test('marginal (this run) and reused (already paid) cost are reported separately from the combined total', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-cost-split-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'FRESH.md'), '# Fresh\n\nThe runner verifies the digest.\n');
    writeFileSync(join(estate, 'REUSED.md'), '# Reused\n\nThe cache never lies about its state.\n');

    const journalDir = join(root, 'journal');
    mkdirSync(journalDir, { recursive: true });
    const [reusedWindow] = windowDocument({ path: 'REUSED.md', content: '# Reused\n\nThe cache never lies about its state.\n' });
    const reusedPrompt = buildExtractionPrompt({ window: reusedWindow });
    appendFileSync(join(journalDir, 'extraction-calls.jsonl'), `${JSON.stringify({
      prompt_digest: sha256(reusedPrompt), outcome: 'ok', model: 'invented-provider/primary-5',
      usage: { cost: 0.02, cost_reported: true },
      answer: { claims: [{ statement: 'The cache never lies about its state.', claim_kind: 'current_capability',
        source_status: 'current', decision_status: 'accepted', line: 3, quote: 'The cache never lies about its state.' }] },
    })}\n`);

    const runner = { model: 'invented-provider/primary-6', complete: async () => ({ outcome: 'ok',
      json: { claims: [{ statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
        source_status: 'current', decision_status: 'accepted', line: 3, quote: 'The runner verifies the digest.' }] },
      usage: { cost: 0.005, cost_reported: true } }) };

    const held = await extractSemanticClaims({
      project: { id: 'fixture', sha: '1'.repeat(40) }, materialized_root: estate,
      tree_manifest: { files: [{ path: 'FRESH.md' }, { path: 'REUSED.md' }] },
      document_paths: ['FRESH.md', 'REUSED.md'], code_facts: [], checks: [], runner, journal_dir: journalDir,
    });

    const c = held.receipt.conservation;
    assert.deepEqual(
      { total: c.reported_cost_usd, marginal: c.marginal_cost_usd, reused: c.reused_cost_usd },
      { total: 0.025, marginal: 0.005, reused: 0.02 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A real gap this project found: a one-off script silently absorbed a large share of REUSED answers
// from a different model than the one it claimed to be building with, because it never checked which
// model actually answered a reused window. The product path must report this prominently by default,
// and refuse outright when a caller asks for a pure single-model map.
test('model_coverage reports a reused answer from a different model, and require_model refuses it', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'extract-model-coverage-'));
  try {
    const estate = join(root, 'estate');
    mkdirSync(estate, { recursive: true });
    writeFileSync(join(estate, 'FRESH.md'), '# Fresh\n\nThe runner verifies the digest.\n');
    writeFileSync(join(estate, 'REUSED.md'), '# Reused\n\nThe cache never lies about its state.\n');

    const [reusedWindow] = windowDocument({ path: 'REUSED.md', content: '# Reused\n\nThe cache never lies about its state.\n' });
    const seedEntry = `${JSON.stringify({
      prompt_digest: sha256(buildExtractionPrompt({ window: reusedWindow })), outcome: 'ok',
      model: 'invented-provider/primary-5', usage: { cost: 0.02, cost_reported: true },
      answer: { claims: [{ statement: 'The cache never lies about its state.', claim_kind: 'current_capability',
        source_status: 'current', decision_status: 'accepted', line: 3, quote: 'The cache never lies about its state.' }] },
    })}\n`;
    const seedJournal = dir => { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'extraction-calls.jsonl'), seedEntry); };

    const runner = { model: 'invented-provider/primary-6', complete: async () => ({ outcome: 'ok',
      json: { claims: [{ statement: 'The runner verifies the digest.', claim_kind: 'current_capability',
        source_status: 'current', decision_status: 'accepted', line: 3, quote: 'The runner verifies the digest.' }] },
      usage: { cost: 0.005, cost_reported: true } }) };
    const args = {
      project: { id: 'fixture', sha: '1'.repeat(40) }, materialized_root: estate,
      tree_manifest: { files: [{ path: 'FRESH.md' }, { path: 'REUSED.md' }] },
      document_paths: ['FRESH.md', 'REUSED.md'], code_facts: [], checks: [], runner,
    };

    const reportDir = join(root, 'journal-report');
    seedJournal(reportDir);
    const held = await extractSemanticClaims({ ...args, journal_dir: reportDir });
    assert.deepEqual(held.receipt.conservation.model_coverage, {
      expected_model: 'invented-provider/primary-6',
      answered_by_expected_model: 1, answered_by_other_model: 1, answered_by_unknown_model: 0,
    });

    const strictDir = join(root, 'journal-strict');
    seedJournal(strictDir);
    await assert.rejects(
      () => extractSemanticClaims({ ...args, journal_dir: strictDir, require_model: true }),
      { code: 'SEMANTIC_EXTRACTION_MODEL_COVERAGE' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
