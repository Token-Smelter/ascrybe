import test from 'node:test';
import assert from 'node:assert/strict';
import extractor from '../tools/extractors/treesitter-js.mjs';
import { COLLECTION_CAP, MAX_VALUE_NODES } from '../tools/extractors/literal-values.mjs';

function literals(file, source) {
  const ctx = { repo: 'fixture', file, parseErrors: [],
    fact: (kind, line, data) => ({ kind, repo: 'fixture', file, line, ...data }) };
  return extractor.scan(source.split(/\r?\n/u), ctx).filter(fact => fact.kind === 'literal_value');
}

const entry = (entries, key) => entries.find(row => row.key === key);

test('a value nested inside a configuration object is evaluated, not stored as raw text', () => {
  // These used to collapse to one `unevaluated` blob capped at 400 characters, so a runbook
  // claiming a 60-minute token could not be checked against a config declaring 720.
  const [fact] = literals('lib/config.ts', [
    'export const config = {',
    "  region: 'us-west-2',",
    '  production: {',
    "    domainName: 'api.example.com',",
    '    tokenExpiration: {',
    '      accessToken: 720,',
    '      idToken: 720,',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  const production = entry(fact.entries, 'production');
  assert.equal(production.value_kind, 'object');
  const expiration = entry(production.entries, 'tokenExpiration');
  assert.equal(expiration.value_kind, 'object');
  assert.deepEqual(entry(expiration.entries, 'accessToken'), { key: 'accessToken',
    value_kind: 'number', value: '720', line: 6 });
});

test('every nested value carries the line it was written on', () => {
  const [fact] = literals('lib/config.ts', [
    'const config = {',
    '  outer: {',
    "    inner: 'value',",
    '  },',
    '};',
  ].join('\n'));
  assert.equal(entry(entry(fact.entries, 'outer').entries, 'inner').line, 3);
});

test('same-line repeated keys receive distinct deterministic occurrences', async () => {
  const [fact] = literals('lib/repeated-preferences.ts', 'const preferences = { tone: null, tone: null };');
  const { addressLiteralLeaves } = await import('../tools/estate-graph-projection.mjs');
  assert.deepEqual(addressLiteralLeaves(fact), [
    { key_path: 'preferences.tone', value: 'null', value_kind: 'null', line: 1,
      key_path_occurrence: 1, key_path_multiplicity: 2 },
    { key_path: 'preferences.tone', value: 'null', value_kind: 'null', line: 1,
      key_path_occurrence: 2, key_path_multiplicity: 2 },
  ]);
});

test('deep narrow nesting is evaluated all the way down, not refused for its depth', () => {
  // The case a depth bound punishes hardest and a budget does not: one branch, many levels. It
  // costs one value per level, so refusing it never bought anything.
  const levels = 20;
  const source = ['const deep = {',
    ...Array.from({ length: levels }, (_, index) => `${'  '.repeat(index + 1)}k${index}: {`),
    `${'  '.repeat(levels + 1)}leaf: 1,`,
    ...Array.from({ length: levels }, (_, index) => `${'  '.repeat(levels - index)}},`), '};'].join('\n');
  const [fact] = literals('lib/deep.ts', source);
  let row = fact;
  for (let index = 0; index < levels; index += 1) {
    row = (row.entries || []).find(child => child.key === `k${index}`);
    assert.ok(row, `level ${index} must be evaluated`);
    assert.equal(row.value_kind, 'object');
  }
  assert.deepEqual((row.entries || []).find(child => child.key === 'leaf'),
    { key: 'leaf', value_kind: 'number', value: '1', line: levels + 2 });
});

test('a value dropped because the budget ran out says which reason, never nothing', () => {
  // Wide beats deep for cost, so the budget is what actually bounds output. Whatever it drops is
  // named: exhaustion must not be indistinguishable from a value nobody examined.
  // Sized from the constants, never hardcoded: a fixture pinned to one cap value stops exercising
  // the boundary the moment the cap moves, and looks green while testing nothing. The collection
  // cap clamps width, so the budget is reached through values per entry rather than entry count.
  const perEntry = Math.ceil(MAX_VALUE_NODES / COLLECTION_CAP) + 8;
  const chain = (index) => `${'{ n: '.repeat(perEntry)}${index}${' }'.repeat(perEntry)}`;
  const wide = Array.from({ length: COLLECTION_CAP }, (_, index) => `  k${index}: ${chain(index)},`);
  const [fact] = literals('lib/wide.ts', ['const many = {', ...wide, '};'].join('\n'));
  const flatten = row => (row?.entries || row?.items || []).flatMap(child => [child, ...flatten(child)]);
  const dropped = flatten(fact).filter(row => row.budget_exhausted);
  assert.ok(dropped.length, 'the budget must bite on a wide structure');
  assert.equal(dropped.every(row => row.value_kind === 'unevaluated'), true);
  assert.equal(flatten(fact).some(row => row.depth_exceeded), false);
});

test('a collection over the size cap reports its true length', () => {
  const length = COLLECTION_CAP + 72;
  const [fact] = literals('lib/big.ts',
    `const many = [${Array.from({ length }, (_, index) => index).join(', ')}];`);
  assert.equal(fact.entry_count, length);
  assert.equal(fact.truncated, true);
  assert.equal(fact.items.length, COLLECTION_CAP);
});

test('every evaluated leaf becomes an addressable value keyed by its author path', async () => {
  // The whole tree used to live on one node as a JSON string, so the map contained the answer to
  // "what does production set this to" and could not be asked for it -- a query had to substring
  // match a 33KB blob and parse it client-side.
  const { literalLeaves } = await import('../tools/estate-graph-projection.mjs');
  const fact = { kind: 'literal_value', name: 'config', entries: [
    { key: 'region', value_kind: 'string', value: 'us-west-2', line: 2 },
    { key: 'production', value_kind: 'object', line: 3, entries: [
      { key: 'tokenExpiration', value_kind: 'object', line: 4, entries: [
        { key: 'accessToken', value_kind: 'number', value: '720', line: 5 }] }] },
    { key: 'github', value_kind: 'unevaluated', text: '{ ... }', line: 9 },
    { key: 'hosts', value_kind: 'array', line: 10, items: [
      { value_kind: 'string', value: 'a.example.com', line: 11 }] },
  ] };
  assert.deepEqual(literalLeaves(fact), [
    { key_path: 'config.region', value: 'us-west-2', value_kind: 'string', line: 2 },
    { key_path: 'config.production.tokenExpiration.accessToken', value: '720', value_kind: 'number', line: 5 },
    { key_path: 'config.hosts.[0]', value: 'a.example.com', value_kind: 'string', line: 11 },
  ]);
});

test('an unevaluated entry mints no address, because it answers no question', async () => {
  const { literalLeaves } = await import('../tools/estate-graph-projection.mjs');
  const leaves = literalLeaves({ kind: 'literal_value', name: 'c',
    entries: [{ key: 'k', value_kind: 'unevaluated', text: 'compute()', line: 1 }] });
  assert.deepEqual(leaves, []);
});
