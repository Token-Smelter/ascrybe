import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocatorIndex, resolvePassage, resolveGeneration } from '../tools/ontology/graph-locator.mjs';

const node = (id, kind, label, props) => JSON.stringify({ node_id: id, kind, label, properties: props });
async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'graph-')), 'nodes.jsonl');
  writeFileSync(path, [
    node('n1', 'CodeFact', 'openLedger', { repository: 'orders', file: 'src/ledger.js', line: 12 }),
    node('n2', 'CodeFact', 'closeLedger', { repository: 'orders', file: 'src/ledger.js', line: 40 }),
    node('n3', 'Symbol', 'openLedger', { namespace: 'orders/src/ledger.js', path: null }),
    node('n4', 'CodeFact', 'other', { repository: 'billing', file: 'src/ledger.js', line: 12 }),
  ].join('\n'));
  return buildLocatorIndex(path, { graphPins: { orders: 'aaa' } });
}

test('only a node whose own locator lies inside the quoted lines of the same file is a reference; a namespace match is not', async () => {
  const index = await fixture();
  const hit = resolvePassage(index, { repository: 'orders', path: 'src/ledger.js', start_line: 10, end_line: 14, commit_sha: 'aaa' });
  const miss = resolvePassage(index, { repository: 'orders', path: 'src/ledger.js', start_line: 20, end_line: 30, commit_sha: 'aaa' });
  const otherRepo = resolvePassage(index, { repository: 'billing', path: 'src/ledger.js', start_line: 12, end_line: 12, commit_sha: 'bbb' });
  assert.deepEqual([hit.map(r => r.node_id), miss.length, otherRepo[0].node_id, index.nodes_with_locator], [['n1'], 0, 'n4', 3]);
});

test('pin consistency is true, false or unknown and is never assumed', async () => {
  const index = await fixture();
  const at = commit_sha => resolvePassage(index, { repository: 'orders', path: 'src/ledger.js', start_line: 12, end_line: 12, commit_sha })[0].pin_consistent;
  const unknown = resolvePassage(index, { repository: 'billing', path: 'src/ledger.js', start_line: 12, end_line: 12, commit_sha: 'zzz' })[0].pin_consistent;
  assert.deepEqual([at('aaa'), at('different'), unknown], [true, false, null]);
});

test('a generation resolves only evidence rows that have references and reports the rest as unchecked rather than empty', async () => {
  const index = await fixture();
  const generation = { generation_id: 'g', collections: [{ evidence: [
    { evidence_id: 'e1', repository: 'orders', path: 'src/ledger.js', start_line: 40, end_line: 40, commit_sha: 'aaa' },
    { evidence_id: 'e2', repository: 'orders', path: 'docs/readme.md', start_line: 1, end_line: 3, commit_sha: 'aaa' }] }] };
  const r = resolveGeneration(index, generation);
  assert.deepEqual([Object.keys(r.refs), r.evidence_rows, r.evidence_rows_with_refs, r.per_repository.orders.graph_pin], [['e1'], 2, 1, 'aaa']);
});
