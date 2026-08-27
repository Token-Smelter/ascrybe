import { strict as assert } from 'node:assert';
import test from 'node:test';

import { bindObligations } from '../tools/semantic-claim-extractor.mjs';

// Every case below uses a symbol index in which the token resolves UNIQUELY. Uniqueness is what the
// old rule relied on, so these tests isolate shape as the sole discriminator.
const symbolIndex = new Map([
  ['work', [{ file: 'tools/queue.mjs', symbol_kind: 'function' }]],
  ['bindObligations', [{ file: 'tools/semantic-claim-extractor.mjs', symbol_kind: 'function' }]],
]);

const bind = statement => bindObligations({
  claim: { statement, claim_kind: 'current_capability', source: { path: 'doc.md', line: 1 } },
  quote: '',
  root: '/repo',
  symbolIndex,
  treePaths: [],
  checks: [],
  verifierPaths: [],
});

const boundSymbols = obligations => obligations
  .filter(row => row.kind === 'code_symbol_declared')
  .map(row => row.symbol);

test('a bare prose word does not bind merely because it names a unique symbol', () => {
  assert.deepEqual(boundSymbols(bind('The queue accepts work without delay.')), []);
});

test('backticking a bare word binds it, because quoting declares it names code', () => {
  assert.deepEqual(boundSymbols(bind('The queue accepts `work` without delay.')), ['work']);
});

test('a camelCase token binds without needing backticks', () => {
  assert.deepEqual(boundSymbols(bind('The extractor calls bindObligations per claim.')), ['bindObligations']);
});
