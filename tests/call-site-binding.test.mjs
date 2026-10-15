import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bindCallSites } from '../tools/call-site-binding.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/call-site-binding/${name}`, import.meta.url), 'utf8');
const receipts = bindCallSites({
  'tests/fixtures/call-site-binding/imported.mjs': fixture('imported.mjs'),
  'tests/fixtures/call-site-binding/main.mjs': fixture('main.mjs'),
});
const inMain = receipts.filter(item => item.file.endsWith('/main.mjs'));

test('call-site-binding resolves lexical, named-import alias, and default-import declarations', () => {
  assert.deepEqual(inMain.filter(item => item.status === 'resolved').map(item => [
    item.call_site.line, item.declaration.file, item.declaration.line,
  ]), [
    [3, 'tests/fixtures/call-site-binding/main.mjs', 2],
    [4, 'tests/fixtures/call-site-binding/imported.mjs', 1],
    [5, 'tests/fixtures/call-site-binding/imported.mjs', 2],
  ]);
});

test('call-site-binding records typed refusals instead of guessing a dynamic or computed call', () => {
  assert.deepEqual(inMain.filter(item => item.status === 'unresolved').map(item => [
    item.call_site.line, item.reason,
  ]), [
    [7, 'shadowed_by_non_function_binding'],
    [8, 'computed_member'],
    [9, 'dynamic_dispatch'],
    [9, 'unbound_identifier'],
  ]);
  for (const receipt of receipts) {
    assert.ok(['resolved', 'ambiguous', 'unresolved'].includes(receipt.status));
    assert.equal(receipt.call_site.file, receipt.file);
    assert.ok(Number.isInteger(receipt.call_site.line));
    assert.ok(receipt.call_site.text.length > 0);
  }
});

test('call-site-binding refuses imports whose exported binding is assigned', () => {
  const result = bindCallSites({
    'tests/fixtures/call-site-binding/assigned-export/main.mjs': fixture('assigned-export/main.mjs'),
    'tests/fixtures/call-site-binding/assigned-export/target.mjs': fixture('assigned-export/target.mjs'),
  });
  const receipt = result.find(item => item.file.endsWith('/assigned-export/main.mjs'));
  assert.deepEqual([receipt?.status, receipt?.reason], ['unresolved', 'assigned_binding']);
});

test('call-site-binding refuses ambiguous declarations, re-exports, packages, CommonJS, and local methods', () => {
  const source = [
    "import { named } from './relay.mjs';",
    "import { indexed } from './dir';",
    "import { remote } from 'package';",
    "const legacy = require('./legacy');",
    'function duplicate() {}',
    'function duplicate() {}',
    'const local = {};',
    'duplicate(); named(); indexed(); remote(); legacy(); local.run();',
  ].join('\n');
  const result = bindCallSites({
    'fixture/main.mjs': source,
    'fixture/relay.mjs': "export { named } from './target.mjs';",
    'fixture/target.mjs': 'export function named() {}',
    'fixture/dir/index.mjs': 'export function indexed() {}',
  }).filter(item => item.file === 'fixture/main.mjs');
  const byLine = result.filter(item => item.call_site.line === 8);
  assert.equal(byLine.find(item => item.call_site.text === 'duplicate()').status, 'ambiguous');
  assert.deepEqual(byLine.filter(item => item.status === 'unresolved').map(item => item.reason).sort(), [
    'commonjs_interop', 'external_module', 'method_call_on_local', 're_export_chain',
  ]);
  assert.equal(byLine.find(item => item.call_site.text === 'indexed()').declaration.file, 'fixture/dir/index.mjs');
});

test('call-site-binding refuses every reviewed shadowing fixture', () => {
  const cases = [
    'parameter', 'destructured-require', 'local-over-import', 'catch', 'loop',
    'object-pattern', 'let', 'reassigned-function', 'arrow-parameter',
  ];
  for (const name of cases) {
    const file = `tests/fixtures/call-site-binding/shadowing/${name}.mjs`;
    const result = bindCallSites({ [file]: fixture(`shadowing/${name}.mjs`) });
    const receipt = result.find(item => item.call_site.text === 'helper()');
    assert.ok(receipt, `${name} must emit a helper() receipt`);
    assert.notEqual(receipt.status, 'resolved', `${name} must not resolve`);
  }
});

test('call-site-binding refuses pattern/default parameters, var bindings, and classes', () => {
  const source = [
    'function helper() {}',
    'function objectParameter({ helper = fallback } = {}) { helper(); }',
    'function arrayParameter([helper]) { helper(); }',
    'function local() { var helper; helper(); }',
    'class CallableOnlyWithNew {}',
    'CallableOnlyWithNew();',
  ].join('\n');
  const result = bindCallSites({ 'fixture/bindings.mjs': source });
  for (const receipt of result.filter(item => ['helper()', 'CallableOnlyWithNew()'].includes(item.call_site.text))) {
    assert.notEqual(receipt.status, 'resolved');
  }
});

test('call-site-binding refuses destructured names from function-expression initializers', () => {
  const [receipt] = bindCallSites({
    'fixture/destructured-function.mjs': 'const { helper } = function factory() {}; helper();',
  });
  assert.deepEqual([receipt.status, receipt.reason], ['unresolved', 'shadowed_by_non_function_binding']);
});

test('call-site-binding emits a refusal receipt for parse failures, unsupported grammars, and constructors', () => {
  const result = bindCallSites({
    'fixture/broken.mjs': 'const broken = ; helper();',
    'fixture/unknown.py': 'helper()',
    'fixture/new.mjs': 'new Helper()',
  });
  assert.equal(result.find(item => item.file === 'fixture/broken.mjs').reason, 'parse_failed');
  assert.equal(result.find(item => item.file === 'fixture/unknown.py').reason, 'unsupported_grammar');
  assert.equal(result.find(item => item.file === 'fixture/new.mjs').reason, 'new_expression');
});

test('call-site-binding receipt ids use byte offsets and Unicode scalar order', () => {
  const unicodeSource = 'const 😀 = 0; function a() {} a();';
  const result = bindCallSites({
    'fixture/𐀀.mjs': unicodeSource,
    'fixture/.mjs': 'function a() {} a();',
  });
  assert.deepEqual(result.map(item => item.file), ['fixture/.mjs', 'fixture/𐀀.mjs']);
  assert.ok(result.every(item => item.id.endsWith(`:${item.call_site.start}`)));
  const unicodeReceipt = result.find(item => item.file === 'fixture/𐀀.mjs');
  assert.equal(unicodeReceipt.call_site.start, Buffer.byteLength(unicodeSource.slice(0, unicodeSource.lastIndexOf('a();'))));
});

test('call-site-binding keeps switch and for lexical bindings inside their scopes', () => {
  const source = [
    'function helper() {}',
    'switch (0) { case 0: { const helper = 0; helper(); } }',
    'helper();',
    'for (let helper = 0; helper < 1; helper += 1) { helper(); }',
    'helper();',
    'for (const helper of [0]) { helper(); }',
    'helper();',
  ].join('\n');
  const result = bindCallSites({ 'fixture/lexical.mjs': source });
  assert.deepEqual(result.filter(item => item.call_site.text === 'helper()').map(item => item.status), [
    'unresolved', 'resolved', 'unresolved', 'resolved', 'unresolved', 'resolved',
  ]);
});

test('call-site-binding keeps an uninitialized var redeclaration but refuses an initialized one', () => {
  const result = bindCallSites({
    'fixture/function-var-redeclarations.mjs': [
      'function uninitialized() { function helper() {} var helper; return helper(); }',
      'function initialized() { function helper() {} var helper = 1; return helper(); }',
    ].join('\n'),
  });
  assert.deepEqual(result.map(receipt => [receipt.status, receipt.reason]), [
    ['resolved', undefined],
    ['unresolved', 'assigned_binding'],
  ]);
});

test('call-site-binding refuses augmented and update writes but not property writes', () => {
  const augmented = bindCallSites({ 'fixture/augmented.mjs': 'function helper() {} helper += 1; helper();' });
  const updated = bindCallSites({ 'fixture/updated.mjs': 'function helper() {} helper++; helper();' });
  const property = bindCallSites({ 'fixture/property.mjs': 'function helper() {} holder.helper = 1; helper();' });
  assert.equal(augmented.at(-1).reason, 'assigned_binding');
  assert.equal(updated.at(-1).reason, 'assigned_binding');
  assert.equal(property.at(-1).status, 'resolved');
});

test('call-site-binding emits unsupported-grammar receipts for computed and parenthesized calls', () => {
  const result = bindCallSites({ 'fixture/unknown.py': 'items[helper](); (helper)(); new Helper()' });
  assert.deepEqual(result.map(item => [item.call_site.text, item.reason]), [
    ['items[helper]()', 'unsupported_grammar'],
    ['(helper)()', 'unsupported_grammar'],
    ['new Helper()', 'new_expression'],
  ]);
});

test('call-site-binding is byte deterministic for identical source bytes', () => {
  const inputs = {
    'tests/fixtures/call-site-binding/imported.mjs': fixture('imported.mjs'),
    'tests/fixtures/call-site-binding/main.mjs': fixture('main.mjs'),
  };
  assert.equal(JSON.stringify(bindCallSites(inputs)), JSON.stringify(bindCallSites(inputs)));
});
