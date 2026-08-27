import test from 'node:test';
import assert from 'node:assert/strict';
import extractors, { textExtensionRegistrationReceipt } from '../tools/extractors/index.mjs';
import { textExtensions } from '../tools/lib.mjs';

// An extractor whose filePattern matches nothing the walk admits is dead code that still passes
// its own unit tests. The diagram and document-structure producers shipped that way: they matched
// markdown, the walk had no .md, and a corpus of 615 mermaid documents produced zero facts in the
// pipeline while producing them correctly when called directly.
test('every registered extractor can be reached by some file the walk admits', () => {
  const admitted = [...textExtensions, '.md'].map(extension => `example${extension}`)
    .concat(['plugin.yaml', 'package.json', 'requirements.txt', 'pyproject.toml', 'environment']);
  const unreachable = extractors
    .filter(extractor => !admitted.some(file => extractor.filePattern.test(file)))
    .map(extractor => extractor.kind);
  assert.deepEqual(unreachable, [],
    `these extractors match no admitted file and would silently produce nothing: ${unreachable.join(', ')}`);
});

test('an extension is admitted only with a recorded reason', () => {
  const recorded = new Set(textExtensionRegistrationReceipt.extensions.map(row => row.extension));
  for (const extension of ['.md', '.mdx', '.yaml', '.yml']) {
    assert.equal(recorded.has(extension), true, `${extension} is scanned but records no reason`);
  }
});
