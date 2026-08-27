import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocTokenIndex } from '../tools/doc-code-occurrences.mjs';

const roots = [];
test.after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'doc-index-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.md'), '# A\nqueryGraph appears here\n');
  writeFileSync(join(root, 'docs', 'b.md'), '# B\nqueryGraph also appears here\n');
  return root;
}

test('document token index honors the exact configured documentary denominator', () => {
  const index = buildDocTokenIndex({ docs_root: fixture(), document_paths: ['docs/a.md'] });
  assert.deepEqual({ documents: index.documents, postings: index.postings.get('queryGraph') }, {
    documents: ['docs/a.md'], postings: [[0, 2]],
  });
});

test('document token index normalizes caller order but refuses duplicates and escaping paths', () => {
  const root = fixture();
  const unsorted = buildDocTokenIndex({ docs_root: root, document_paths: ['docs/b.md', 'docs/a.md'] });
  assert.deepEqual({
    normalized: unsorted.documents,
    refusals: [
      ['docs/a.md', 'docs/a.md'],
      ['../outside.md'],
    ].map(document_paths => {
      try { buildDocTokenIndex({ docs_root: root, document_paths }); return null; }
      catch (error) { return error.message; }
    }),
  }, {
    normalized: ['docs/a.md', 'docs/b.md'],
    refusals: ['document_paths must be unique', 'document_paths must be paths below docs_root'],
  });
});
