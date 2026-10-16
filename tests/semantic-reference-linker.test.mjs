import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentWindows, linkReferences, parseProposals, prunedCatalog, referentCatalog, validateProposal } from '../tools/semantic-reference-linker.mjs';

test('proposals are validated against window bytes and catalog, never repaired', () => {
  const window = { line_start: 10, line_end: 12, text: 'The iOS app ships weekly.\nThe iOS app is reviewed.\nBilling uses ledger-sync.' };
  const ids = new Set(['referent:apps', 'referent:ledger']);
  assert.deepEqual({
    good: validateProposal({ proposal: { q: 'Billing uses ledger-sync', t: 'referent:ledger' }, window, catalogIds: ids }),
    ambiguous: validateProposal({ proposal: { q: 'The iOS app', t: 'referent:apps' }, window, catalogIds: ids }).rejected,
    absent: validateProposal({ proposal: { q: 'the Android app', t: 'referent:apps' }, window, catalogIds: ids }).rejected,
    unknown: validateProposal({ proposal: { q: 'Billing uses ledger-sync', t: 'referent:nope' }, window, catalogIds: ids }).rejected,
    malformed: validateProposal({ proposal: { t: 'referent:apps' }, window, catalogIds: ids }).rejected,
  }, {
    good: { quote: 'Billing uses ledger-sync', target: 'referent:ledger', line: 12 },
    ambiguous: 'quote_ambiguous_in_window',
    absent: 'quote_not_in_window',
    unknown: 'unknown_target',
    malformed: 'malformed_proposal',
  });
});

test('a full run writes validated references, typed rejections, and receipts with cost', async () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'semref-'));
  try {
    writeFileSync(join(root, 'about.md'),
      '# Platform\n## Clients\nParcelworks ships an iOS app.\nBilling flows through ledger-sync nightly.\n');
    writeFileSync(join(root, 'graph.json'), JSON.stringify({ nodes: {
      'referent:apps': { k: 'entity', l: 'parcel-client-apps', r: 'module', ns: 'parcel' },
      'referent:ledger': { k: 'entity', l: 'ledger-sync', r: 'module', ns: 'parcel' },
      'doc:x': { k: 'entity', l: 'x.md', ns: 'document', r: 'document' },
    } }));
    const out = join(root, 'out');
    const summary = await linkReferences({
      estate_root: root, documents: ['about.md'], code_graph: join(root, 'graph.json'),
      model: 'fake/model', output: out,
      execute: async ({ prompt }) => {
        assert.equal(prompt.includes('referent:apps\tmodule\tparcel-client-apps'), true);
        assert.equal(prompt.includes('doc:x'), false);
        return { text: [
          '{"q": "ships an iOS app", "t": "referent:apps"}',
          '{"q": "ledger-sync", "t": "referent:ledger"}',
          '{"q": "not in the window", "t": "referent:apps"}',
          'garbage line',
        ].join('\n'), usage: { cost: { total: 0.0123 } } };
      },
    });
    const references = readFileSync(join(out, 'references.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    // Each reference is also an assertion in the shared model: the entity it names, the section
    // it was read from, and the standing of the document that said it.
    const first = references[0].assertion;
    assert.deepEqual({
      subject: [first.subject.kind, first.subject.id],
      section: first.source.section_path,
      standing: [first.nature.document_mode, first.nature.adjudication_frame],
      receipted: first.evidence.match_basis,
      bound: references[0].assertion_id === first.assertion_id,
    }, {
      subject: ['entity', 'referent:apps'],
      section: 'Platform / Clients',
      standing: ['unclassified', 'none'],
      receipted: 'semantic',
      bound: true,
    });
    const rejections = readFileSync(join(out, 'rejections.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual({
      refs: references.map(row => [row.referent_id, row.line, row.match_basis]),
      receiptBound: references.every(row => row.receipt_id === summary.receipts[0].receipt_id),
      rejected: rejections.map(row => row.rejected),
      unparseable: summary.receipts[0].unparseable,
      cost: summary.cost_usd,
    }, {
      refs: [['referent:apps', 3, 'semantic'], ['referent:ledger', 4, 'semantic']],
      receiptBound: true,
      rejected: ['quote_not_in_window'],
      unparseable: 1,
      cost: 0.0123,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catalog pruning keeps what a document could name and still floors at real entities', () => {
  const catalog = [
    { id: 'referent:apps', surface: 'parcel-client-apps', kind: 'module' },
    { id: 'referent:encoder', surface: 'MediaEncoder', kind: 'symbol' },
    { id: 'referent:unrelated', surface: 'quarterly-tax-worksheet', kind: 'module' },
    { id: 'referent:short', surface: 'db', kind: 'module' },
  ];
  const text = 'Billing calls the media encoder from parcel-client-apps.';
  const held = prunedCatalog(catalog, text, 3);
  assert.deepEqual({
    // Exact substring and separator-folded prose both reach their entity.
    matched: held.slice(0, 2).map(entry => entry.id).sort(),
    // The floor fills remaining slots rather than sending an empty catalog.
    filled: held.length,
    capped: prunedCatalog(catalog, text, 1).length,
  }, { matched: ['referent:apps', 'referent:encoder'], filled: 3, capped: 1 });
});

test('windows stay line-aligned and cover every line exactly once', () => {
  const text = Array.from({ length: 300 }, (_, index) => `line ${index + 1} ${'x'.repeat(30)}`).join('\n');
  const windows = documentWindows(text, 1000);
  assert.equal(windows[0].line_start, 1);
  assert.equal(windows.at(-1).line_end, 300);
  for (let index = 1; index < windows.length; index += 1) {
    assert.equal(windows[index].line_start, windows[index - 1].line_end + 1);
  }
});

test('paid inference requires the explicit gate', async () => {
  await assert.rejects(() => linkReferences({ estate_root: '/nowhere', documents: [], code_graph: '/nowhere',
    model: 'real/model', output: '/nowhere', environment: {} }), /ASCRYBE_ENABLE_PAID_INFERENCE/u);
});
