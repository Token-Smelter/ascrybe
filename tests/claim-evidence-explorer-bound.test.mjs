import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderClaimEvidenceExplorer } from '../tools/claim-evidence-explorer.mjs';

// One claim past the render bound. The corpus that exposed this defect had 111,499.
const OVER_BOUND = 5001;

function map() {
  const claims = [];
  const receipts = [];
  for (let index = 0; index < OVER_BOUND; index += 1) {
    const claimId = `estate-claim:${String(index).padStart(6, '0')}`;
    claims.push({
      claim_id: claimId, claim_key: `docs/design.md:${index}:key`,
      statement: 'The map exposes exact provenance.', claim_kind: 'accepted_design',
      source_status: 'current', decision_status: 'accepted',
      source: { path: 'docs/design.md', line: index, quote: 'exact provenance' },
    });
    receipts.push({
      receipt_id: `claim-adjudication-receipt:${index}`, claim_id: claimId,
      verdict: 'supported', realization: 'partial', obligation_result_ids: [],
    });
  }
  return {
    project: { id: 'fixture', sha: '1'.repeat(40) },
    coverage: {
      semantic_claims: OVER_BOUND, terminal_receipts: OVER_BOUND, supersession_edges: 0,
      verdicts: { supported: OVER_BOUND, refuted: 0, underdetermined: 0, unverifiable: 0 },
    },
    policy: { closed_world_absence: 'explicit inventory only' },
    claims, adjudication_receipts: receipts,
    evidence: [], obligation_results: [], supersession_receipts: [], edges: [],
  };
}

test('a corpus past the render bound still produces a page, and says so', async () => {
  const { page } = await renderClaimEvidenceExplorer({ map: map(), output_dir: mkdtempSync(join(tmpdir(), 'explorer-')) });
  assert.match(readFileSync(page, 'utf8'), /Showing the first 5000 of 5001 claims/u);
});

test('the bounded page renders exactly the bound, not the whole corpus', async () => {
  const { page } = await renderClaimEvidenceExplorer({ map: map(), output_dir: mkdtempSync(join(tmpdir(), 'explorer-')) });
  assert.equal(readFileSync(page, 'utf8').split('<details class="claim"').length - 1, 5000);
});

test('the receipt records the complete corpus even though the page is bounded', async () => {
  const { receipt } = await renderClaimEvidenceExplorer({ map: map(), output_dir: mkdtempSync(join(tmpdir(), 'explorer-')) });
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).claims.length, OVER_BOUND);
});
