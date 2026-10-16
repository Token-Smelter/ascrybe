import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowSubjectOccurrences, prepassDocument } from '../tools/source-prepass.mjs';
import { createWindowBlockCatalog } from '../tools/source-locator.mjs';
import { segmentDocument } from '../tools/wide-context-windows.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: 'digest' };

test('backticked lower camel case is captured without widening prose symbols', () => {
  const content = [
    '# Symbols',
    '',
    '`selectReferenceFactor` and `referenceFactors` call buildFactorPattern.',
    '`status` stays prose-like; `PascalCase`, `snake_case`, `tools/verify.py`, and `callMe()` retain coverage.',
    '',
  ].join('\n');
  const pre = prepassDocument({ path: 'symbols.md', content, ...snapshot });
  const symbols = pre.mentions.filter(row => row.kind === 'symbol').map(row => row.surface);
  const { windows: [window] } = segmentDocument({ path: 'symbols.md', content, snapshot });
  const catalog = createWindowBlockCatalog({ window, inventories: [pre.inventory] });
  const occurrences = buildWindowSubjectOccurrences({ prepass: pre, catalog, limit: 120 });
  const lowerCamelSpans = occurrences.filter(row =>
    ['selectReferenceFactor', 'referenceFactors'].includes(row.surface)).map(row => ({
    surface: row.surface,
    exact: Buffer.from(content).subarray(row.byte_start, row.byte_end).toString('utf8'),
  }));
  assert.deepEqual({
    lower_camel: symbols.filter(value => ['selectReferenceFactor', 'referenceFactors'].includes(value)).sort(),
    unbackticked: symbols.includes('buildFactorPattern'),
    bare_backticked: symbols.includes('status'),
    existing_channels: ['PascalCase', 'snake_case', 'tools/verify.py', 'callMe()']
      .every(value => symbols.includes(value)),
    lower_camel_spans: lowerCamelSpans.sort((a, b) => a.surface.localeCompare(b.surface)),
    deterministic: pre.digest === prepassDocument({ path: 'symbols.md', content, ...snapshot }).digest,
  }, {
    lower_camel: ['referenceFactors', 'selectReferenceFactor'],
    unbackticked: false,
    bare_backticked: false,
    existing_channels: true,
    lower_camel_spans: [
      { surface: 'referenceFactors', exact: 'referenceFactors' },
      { surface: 'selectReferenceFactor', exact: 'selectReferenceFactor' },
    ],
    deterministic: true,
  });
});
