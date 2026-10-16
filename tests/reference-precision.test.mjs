import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureReferencePrecision, precisionPrompt, sampleReferences, wilsonInterval } from '../tools/reference-precision.mjs';

test('sampling is seeded and reproducible, and the interval is honest at small n', () => {
  const references = Array.from({ length: 50 }, (_, index) => ({ document: 'a.md', line: index + 1, quote: `q${index}`, referent_id: `r${index}` }));
  const first = sampleReferences(references, { size: 10, seed: 'x' }).map(row => row.referent_id);
  assert.deepEqual(sampleReferences(references, { size: 10, seed: 'x' }).map(row => row.referent_id), first);
  assert.notDeepEqual(sampleReferences(references, { size: 10, seed: 'y' }).map(row => row.referent_id), first);
  const [low, high] = wilsonInterval(9, 10);
  // A perfect small sample must not claim certainty.
  assert.equal(low > 0.55 && high < 1, true);
  assert.deepEqual(wilsonInterval(0, 0), [0, 1]);
});

test('the judge sees the span, its context, and one entity — never that a linker proposed it', () => {
  const prompt = precisionPrompt({ quote: 'the media encoder', context: 'Billing calls the media encoder nightly.',
    entity: { surface: 'MediaEncoder', kind: 'symbol', namespace: 'parcel/encode.mjs' } });
  assert.equal(prompt.includes('MediaEncoder'), true);
  assert.equal(/propos|linker|candidate|accepted|semantic_reference/iu.test(prompt), false);
});

test('precision is reported beside the totals a single number could otherwise hide', async () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'refprec-'));
  try {
    writeFileSync(join(root, 'a.md'), 'line one\nBilling calls the media encoder nightly.\nline three\n');
    const references = [
      { document: 'a.md', line: 2, quote: 'the media encoder', referent_id: 'referent:encoder' },
      { document: 'a.md', line: 2, quote: 'Billing', referent_id: 'referent:unrelated' },
    ];
    const entities = { 'referent:encoder': { surface: 'MediaEncoder', kind: 'symbol' },
      'referent:unrelated': { surface: 'quarterly-tax-worksheet', kind: 'module' } };
    const out = join(root, 'out');
    const report = await measureReferencePrecision({ estate_root: root, references, entities,
      model: 'fake/model', output: out, sample_size: 2, seed: 's',
      execute: async ({ prompt }) => ({ text: prompt.includes('MediaEncoder')
        ? '{"refers": true, "why": "the span names the encoder"}'
        : '{"refers": false, "why": "incidental overlap"}', usage: { cost: { total: 0.001 } } }) });
    assert.deepEqual({ judged: report.judged, supported: report.supported, precision: report.precision,
      totalsKept: report.references_total, cost: report.cost_usd },
    { judged: 2, supported: 1, precision: 0.5, totalsKept: 2, cost: 0.002 });
    assert.equal(readFileSync(join(out, 'verdicts.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
