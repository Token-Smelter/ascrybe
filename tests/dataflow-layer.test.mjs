import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_RESOLUTION_DEPTH, extractFlowSkeletons } from '../tools/dataflow-layer.mjs';

const file = 'tests/fixtures/dataflow-layer/characterization.mjs';
const source = readFileSync(new URL('./fixtures/dataflow-layer/characterization.mjs', import.meta.url), 'utf8');
const result = extractFlowSkeletons(source, { file });
const skeleton = name => result.skeletons.find(item => item.function_name === name);

test('dataflow skeleton characterization preserves guarded writes, exits, sources, and one-hop calls', () => {
  const guarded = skeleton('guarded');
  const skipped = skeleton('skipped');
  const caller = skeleton('caller');
  assert.deepEqual(guarded.guards, [{ condition: 'enabled', dominates_sites: [2], family: 'enclosing', kind: 'if_consequence', line: 2, polarity: 'requires' }]);
  assert.deepEqual(skipped.guards, [{ condition: 'skip', dominates_sites: [7], family: 'early_exit', kind: 'early_exit_return', line: 6, polarity: 'skips_when' }]);
  assert.deepEqual(guarded.sources.filter(item => item.name === 'records'), [{ line: 1, name: 'records', origin: 'parameter', text: 'records' }]);
  assert.deepEqual(caller.sites.filter(item => item.resolution.length), [{ idiom: 'S1-compound-add', line: 11, resolution: [{ call_line: 11, callee: 'writer', declared_line: 14, hop: 1 }], text: 'writer(value)', value_text: 'value', via_nested_closure: false }]);
});

test('dataflow preserves the declared two-hop resolution boundary', () => {
  assert.equal(MAX_RESOLUTION_DEPTH, 2);
  assert.equal(skeleton('beyondFirst'), undefined);
});

test('dataflow records a witnessed refusal at the literal two-hop bound', () => {
  const refusal = result.refusals.find(item => item.reason === 'resolution_depth_exceeded');
  assert.ok(refusal, 'the fixture must exceed the declared deterministic bound');
  assert.equal(refusal.file, file);
  assert.equal(refusal.line, 19);
  assert.match(refusal.detail, /declared bound of 2 hops/);
});

test('dataflow joins same-line calls and declarations by parser identity', () => {
  const source = 'function alpha() { total += 1; } function beta() { total += 2; } function caller() { alpha(); beta(); }';
  const caller = extractFlowSkeletons(source, { file: 'fixture/same-line.mjs' }).skeletons.find(item => item.function_name === 'caller');
  assert.deepEqual(caller.sites.map(site => site.resolution[0].callee), ['alpha', 'beta']);
});

test('dataflow skeleton elements retain file:line witnesses and verbatim source text', () => {
  for (const item of result.skeletons) {
    assert.equal(item.file, file);
    for (const site of item.sites) {
      assert.ok(Number.isInteger(site.line));
      assert.ok(source.split('\n')[site.line - 1].includes(site.text));
    }
    for (const guard of item.guards) {
      assert.ok(Number.isInteger(guard.line));
      assert.ok(source.split('\n')[guard.line - 1].includes(guard.condition));
    }
    for (const sourceItem of item.sources.filter(candidate => candidate.origin !== 'unresolved_in_scope')) {
      assert.ok(Number.isInteger(sourceItem.line));
      assert.ok(source.includes(sourceItem.text));
    }
  }
});
