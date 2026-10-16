import { strict as assert } from 'node:assert';
import test from 'node:test';

import { bindObligations } from '../tools/semantic-claim-extractor.mjs';

// Every name below is invented (an example widget-tracking estate); nothing here describes a
// mapped repository (AGENTS.md / CONTRIBUTING.md / docs/before-a-pr.md).
//
// Regression coverage for the operator finding, 2026-09-26: a backtick span used to be decomposed
// into every IDENTIFIER-shaped substring it contained, so a citation like
// `src/widgets/index.mjs:10-20` yielded a bindable bare token "index", a bare filename like
// `README.md` yielded "README", and a CLI flag like `--dry-run` yielded "dry" and "run" -- each
// then matched whatever unrelated declaration happened to carry that exact name uniquely,
// elsewhere in the whole estate.

const treePaths = ['src/widgets/index.mjs', 'src/widgets/service.mjs', 'README.md'];

function bind({ statement, quote = '', symbolIndex }) {
  return bindObligations({
    claim: { statement, claim_kind: 'current_capability', source: { path: 'doc.md', line: 1 } },
    quote, root: '/repo', symbolIndex, treePaths, checks: [], verifierPaths: [],
  });
}

const boundSymbols = obligations => obligations
  .filter(row => row.kind === 'code_symbol_declared')
  .map(row => row.symbol);

test('a path fragment inside a backtick citation does not bind as an identifier, even if it collides uniquely elsewhere', () => {
  // "index" is lifted from ".../index.mjs" -- the citation names src/widgets/index.mjs, not a
  // symbol called "index" -- but some UNRELATED file happens to uniquely declare a symbol "index".
  const symbolIndex = new Map([['index', [{ file: 'tools/unrelated/verify.mjs', symbol_kind: 'const', line: 4 }]]]);
  const statement = 'The router is implemented in `src/widgets/index.mjs:10-20`.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('a bare filename inside a backtick citation does not bind as an identifier', () => {
  const symbolIndex = new Map([['README', [{ file: 'tools/unrelated/readme-parser.mjs', symbol_kind: 'const', line: 1 }]]]);
  const statement = 'See `README.md` for the full design.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('a CLI flag inside a backtick citation does not bind either of its word fragments as identifiers', () => {
  const symbolIndex = new Map([
    ['dry', [{ file: 'tools/unrelated/laundry.mjs', symbol_kind: 'const', line: 1 }]],
    ['run', [{ file: 'tools/unrelated/marathon.mjs', symbol_kind: 'const', line: 1 }]],
  ]);
  const statement = 'Invoke the tool with `--dry-run` to preview changes.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('multi-token prose inside backticks does not bind any identifier', () => {
  const symbolIndex = new Map([['authorization', [{ file: 'tools/unrelated/auth.mjs', symbol_kind: 'const', line: 1 }]]]);
  const statement = 'See `full authorization composition` for the pattern.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('a whole backtick span that is a genuine bare identifier still binds, unchanged', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/service.mjs', symbol_kind: 'function', line: 5 }]]]);
  const statement = 'The `widgetService` function handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), ['widgetService']);
});

test('a claim citing a specific file+line range refuses a same-named declaration found in a DIFFERENT file', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/OTHER.mjs', symbol_kind: 'function', line: 5 }]]]);
  const statement = 'The `widgetService` function at `src/widgets/service.mjs:1-20` handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('a claim citing a specific file+line range refuses a declaration in the RIGHT file but the WRONG line', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/service.mjs', symbol_kind: 'function', line: 500 }]]]);
  const statement = 'The `widgetService` function at `src/widgets/service.mjs:1-20` handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), []);
});

test('a claim citing a specific file+line range accepts a declaration inside that exact file and range', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/service.mjs', symbol_kind: 'function', line: 12 }]]]);
  const statement = 'The `widgetService` function at `src/widgets/service.mjs:1-20` handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), ['widgetService']);
});

test('a claim with no file citation at all is unconstrained by the file/line rule (uniqueness floor still applies)', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/service.mjs', symbol_kind: 'function', line: 12 }]]]);
  const statement = 'The `widgetService` function handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), ['widgetService']);
});

test('a declaration with no recorded line falls back to a file-only match when a citation exists', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/service.mjs', symbol_kind: 'function', line: null }]]]);
  const statement = 'The `widgetService` function at `src/widgets/service.mjs:1-20` handles widget lookups.';
  assert.deepEqual(boundSymbols(bind({ statement, symbolIndex })), ['widgetService']);
});

test('onRefusal is called with a typed, countable reason when a candidate is refused for a file/line mismatch', () => {
  const symbolIndex = new Map([['widgetService', [{ file: 'src/widgets/OTHER.mjs', symbol_kind: 'function', line: 5 }]]]);
  const statement = 'The `widgetService` function at `src/widgets/service.mjs:1-20` handles widget lookups.';
  const refusals = [];
  bindObligations({
    claim: { statement, claim_kind: 'current_capability', source: { path: 'doc.md', line: 1 } },
    quote: '', root: '/repo', symbolIndex, treePaths, checks: [], verifierPaths: [],
    onRefusal: refusal => refusals.push(refusal),
  });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].symbol, 'widgetService');
  assert.equal(refusals[0].reason, 'FILE_LINE_MISMATCH');
});
