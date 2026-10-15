import test from 'node:test';
import assert from 'node:assert/strict';
import { windowDocument } from '../tools/semantic-claim-extractor.mjs';

const filler = (bytes) => 'x'.repeat(bytes);
const bytes = (window) => Buffer.byteLength(window.content, 'utf8');

test('a window starts where the author started a section, never mid-section', () => {
  const content = ['# Design', 'one', '## Rollout', 'two', '## Risks', 'three'].join('\n');
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 20 });
  assert.deepEqual(windows.map(window => [window.start_line, window.section_path]), [
    [1, 'Design'], [3, 'Design / Rollout'], [5, 'Design / Risks'],
  ]);
});

test('packing continues to the bound rather than stopping at the first section worth sending', () => {
  const content = Array.from({ length: 10 }, (_, index) =>
    `## Section ${index}\n${filler(180)}`).join('\n');
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 4000 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].sections_in_window, 10);
});

test('no window exceeds the bound, counting the newlines that rejoin its sections', () => {
  const content = Array.from({ length: 40 }, (_, index) =>
    `## Section ${index}\n${filler(180)}`).join('\n');
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 1000 });
  assert.ok(windows.length > 1);
  for (const window of windows) assert.ok(bytes(window) <= 1000, `${bytes(window)} > 1000`);
});

test('a section too large for one window says which part of how many it is', () => {
  const content = `# Design\n${filler(500)}\n${filler(500)}\n${filler(500)}`;
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 700 });
  assert.ok(windows.length > 1);
  for (const window of windows) {
    assert.equal(window.section_path, 'Design');
    assert.equal(window.section_parts, windows.length);
  }
  assert.deepEqual(windows.map(window => window.section_part), windows.map((_, index) => index + 1));
});

test('a whole section carries no part marking, so a fragment is distinguishable from a section', () => {
  const windows = windowDocument({ path: 'design.md', content: '# Design\nshort', maxBytes: 4000 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].section_part, undefined);
});

test('setext headings divide a document, as they do for the section extractor', () => {
  const content = ['Design', '======', 'one', 'Rollout', '-------', 'two'].join('\n');
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 20 });
  assert.deepEqual(windows.map(window => window.section_path), ['Design', 'Design / Rollout']);
});

test('what precedes the first heading is its own window, not the first section', () => {
  // A status line or a standing declaration lives above the first heading, and appending it to
  // section one attributes it to a section its author did not write it under.
  const content = ['Status: RATIFIED', '# Design', 'one'].join('\n');
  const windows = windowDocument({ path: 'design.md', content, maxBytes: 12 });
  assert.deepEqual(windows.map(window => [window.section_path, window.start_line]),
    [['(preamble)', 1], ['Design', 2]]);
});

test('a document declaring no headings keeps the byte rule', () => {
  const content = Array.from({ length: 6 }, () => filler(50)).join('\n');
  const windows = windowDocument({ path: 'notes.md', content, maxBytes: 100 });
  assert.ok(windows.length > 1);
  for (const window of windows) assert.equal(window.section_path, undefined);
});

test('a non-Markdown file keeps the byte rule, because a comment is not a section break', () => {
  const content = ['# Design', filler(200), '# Rollout', filler(200)].join('\n');
  const windows = windowDocument({ path: 'config.yaml', content, maxBytes: 150 });
  assert.ok(windows.length >= 3);
  for (const window of windows) assert.equal(window.section_path, undefined);
});

test('a window holding several sections names them all rather than mislabelling them as the first', () => {
  // Labelling a four-section window with the first section's path is worse than saying nothing:
  // a claim from the fourth section is recorded under the first, and which section supplies the
  // false label moves with the byte bound.
  const content = ['# Accepted design', 'Use OAuth.', '# Rejected alternatives', 'No shared keys.'].join('\n');
  const [window] = windowDocument({ path: 'design.md', content, maxBytes: 4000 });
  assert.equal(window.sections_in_window, 2);
  assert.equal(window.section_path, null);
  assert.deepEqual(window.sections.map(row => [row.section_path, row.start_line, row.end_line]), [
    ['Accepted design', 1, 2], ['Rejected alternatives', 3, 4],
  ]);
});
