import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSemanticClaims } from '../tools/semantic-claim-extractor.mjs';

// Seventeen proposals that were not objects broke the conservation invariant after all 6,815
// windows of a corpus had already been paid for. Each counted toward the proposed total, was
// refused as proposal_not_an_object, and then went uncounted among refusals -- because the check
// asked whether a statement survived rather than what the refusal was ABOUT. A malformed proposal
// is refused about a specific proposal and has no statement to show.
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
    // proposal while having no statement to show -- the exact combination the old check could
    // not count, and the reason a paid corpus run died at the finish line.
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

// A provider that reports no cost read as a run that cost nothing: 2,860 paid calls summed to
// $0.00 through `Number(usage?.cost || 0)`, and that zero is what a corpus run gets priced from.
// Unknown must stay unknown, the way the eval protocol already keeps it.
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
