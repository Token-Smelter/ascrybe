import test from 'node:test';
import assert from 'node:assert/strict';
import extractor from '../tools/extractors/treesitter-js.mjs';

function scan(file, source) {
  const parseErrors = [];
  const ctx = {
    repo: 'fixture', file, parseErrors,
    fact: (kind, line, data) => ({ kind, repo: 'fixture', file, line, ...data }),
  };
  return { facts: extractor.scan(source.split(/\r?\n/u), ctx), parseErrors };
}

const byKind = (facts, kind) => facts.filter(fact => fact.kind === kind);

test('inline script declarations retain exact original HTML lines and columns', () => {
  const source = [
    '<!doctype html>',
    '<html>',
    '<body data-example="<script>const attributeFake = 1;</script>">',
    '<!-- <script>const commentFake = 1;</script> -->',
    '<script defer type="text/javascript">',
    'function selectReferenceFactor(value) {',
    '  const factors = [',
    '    { name: "reference", value: 1 },',
    '  ];',
    '  return factors[value];',
    '}',
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
  const { facts, parseErrors } = scan('src/index.html', source);
  const symbols = byKind(facts, 'symbol');
  const literal = byKind(facts, 'literal_value').find(fact => fact.name === 'factors');
  assert.deepEqual({
    parseErrors,
    scripts: byKind(facts, 'inline_script').map(fact => ({ line: fact.line, span: fact.source_span,
      content: fact.content_span })),
    symbols: symbols.map(fact => ({ name: fact.name, line: fact.line, column: fact.column,
      span: fact.source_span })),
    literal: { line: literal.line, itemLine: literal.items[0].line, span: literal.source_span },
    fabricated: symbols.filter(fact => /Fake/u.test(fact.name)).length,
  }, {
    parseErrors: [],
    scripts: [{ line: 5, span: { file: 'src/index.html', start: { line: 5, column: 1 },
      end: { line: 12, column: 10 } }, content: { file: 'src/index.html',
      start: { line: 5, column: 38 }, end: { line: 12, column: 1 } } }],
    symbols: [
      { name: 'selectReferenceFactor', line: 6, column: 10,
        span: { file: 'src/index.html', start: 6, end: 6 } },
      { name: 'factors', line: 7, column: 9,
        span: { file: 'src/index.html', start: 7, end: 7 } },
    ],
    literal: { line: 7, itemLine: 8, span: { file: 'src/index.html', start: 7, end: 7 } },
    fabricated: 0,
  });
});

test('script type and source refusals are explicit while valid quoting variants parse', () => {
  const source = [
    '<script nonce=x type="application/json">const jsonFake = 1;</script>',
    '<script async src=app.js></script>',
    '<script src="other.js">const mixedFake = 1;</script>',
    '<script data-x=one type=module>export const moduleValue = 2;</script>',
    "<SCRIPT TYPE='application/javascript' data-x=two>const classicValue = 3;</SCRIPT>",
  ].join('\n');
  const { facts } = scan('variants.htm', source);
  assert.deepEqual({
    refusals: byKind(facts, 'inline_script_refusal').map(fact => ({ line: fact.line,
      refusal: fact.refusal, type: fact.script_type, hasSrc: fact.has_src })),
    parsed: byKind(facts, 'inline_script').map(fact => ({ line: fact.line, type: fact.script_type })),
    symbols: byKind(facts, 'symbol').map(fact => ({ name: fact.name, line: fact.line })),
  }, {
    refusals: [
      { line: 1, refusal: 'non_javascript_script_type', type: 'application/json', hasSrc: false },
      { line: 2, refusal: 'src_only_script_element', type: null, hasSrc: true },
      { line: 3, refusal: 'src_attribute_with_inline_content', type: null, hasSrc: true },
    ],
    parsed: [{ line: 4, type: 'module' }, { line: 5, type: 'application/javascript' }],
    symbols: [{ name: 'moduleValue', line: 4 }, { name: 'classicValue', line: 5 }],
  });
});

test('malformed and non-script input fail closed without fabricated code facts', () => {
  const source = [
    '<div>function documentFake() {}</div>',
    '<script>function validBlock() { return "<\\/script>"; }</script>',
    '<script>const = broken;</script>',
    '<script type="text/template">function templateFake() {}</script>',
    '<script>function unterminatedFake() {}',
  ].join('\n');
  const { facts } = scan('malformed.html', source);
  assert.deepEqual({
    symbols: byKind(facts, 'symbol').map(fact => ({ name: fact.name, line: fact.line })),
    refusals: byKind(facts, 'inline_script_refusal').map(fact => ({ line: fact.line,
      refusal: fact.refusal })),
    plainDocument: scan('plain.html', [
      '<h1>const notCode = 1;</h1>',
      '<textarea><script>const textareaFake = 1;</script></textarea>',
      '<style><script>const styleFake = 1;</script></style>',
    ].join('\n')).facts,
  }, {
    symbols: [{ name: 'validBlock', line: 2 }],
    refusals: [
      { line: 3, refusal: 'javascript_parse_error' },
      { line: 4, refusal: 'non_javascript_script_type' },
      { line: 5, refusal: 'unterminated_script_element' },
    ],
    plainDocument: [],
  });
});

test('malformed script start tag refuses the remaining ambiguous document', () => {
  const { facts } = scan('ambiguous.html', [
    '<script type==text/javascript>',
    '<script>function fabricatedAfterMalformedTag() {}</script>',
  ].join('\n'));
  assert.deepEqual(facts, [{
    kind: 'inline_script_refusal', repo: 'fixture', file: 'ambiguous.html', line: 1,
    disposition: 'refused', refusal: 'malformed_attribute_value', script_type: null,
    has_src: false, detail: null,
    source_span: { file: 'ambiguous.html', start: { line: 1, column: 1 },
      end: { line: 1, column: 31 } },
  }]);
});

// The pre-HTML byte-identity premise is deliberately superseded: symbol facts now
// carry the nameable declaration path used for identity. Every other JS-family
// record must still be exact, so this remains the drift guard for that surface.
test('direct JS-family extraction emits exact records carrying nameable scope paths', () => {
  const source = 'export const answer = 42;';
  const expectedLanguage = new Map([
    ['fixture.js', 'javascript'], ['fixture.mjs', 'javascript'],
    ['fixture.ts', 'typescript'], ['fixture.tsx', 'tsx'],
  ]);
  const outputs = Object.fromEntries([...expectedLanguage].map(([file, language]) => [file, scan(file, source).facts]));
  assert.deepEqual(outputs, Object.fromEntries([...expectedLanguage].map(([file, language]) => [file, [
    { kind: 'module', repo: 'fixture', file, line: 1, language, end_line: 1 },
    { kind: 'symbol', repo: 'fixture', file, line: 1, name: 'answer', symbol_kind: 'const', column: 14,
      scope_path: ['answer'] },
    { kind: 'literal_value', repo: 'fixture', file, line: 1, name: 'answer',
      declaration_kind: 'const', exported: true, scope: 'module', value_text: '42',
      value_kind: 'number', value: '42' },
  ]])));
});
