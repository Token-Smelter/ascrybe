// parseGitmodulesText is the one pure function tests/git-tree-source.test.mjs and
// tests/delta-update-submodules.test.mjs both exercise only indirectly (through real fixture
// commits); this file covers its parsing edge cases directly. resolveSubmoduleRepository and
// submoduleCommitPresent need real repositories to mean anything, so they stay covered by those
// integration tests rather than duplicated here. Invented names throughout (CONTRIBUTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitmodulesText } from '../tools/git-submodule-resolution.mjs';

test('parses a single declared submodule\u2019s path -> name', () => {
  const map = parseGitmodulesText('[submodule "status-digest"]\n\tpath = status-digest\n\turl = ../status-digest.git\n');
  assert.deepEqual([...map.entries()], [['status-digest', 'status-digest']]);
});

test('the declared NAME and its checkout PATH may differ', () => {
  const map = parseGitmodulesText('[submodule "vendor-sdk"]\n\tpath = third_party/sdk\n\turl = ../sdk.git\n');
  assert.deepEqual([...map.entries()], [['third_party/sdk', 'vendor-sdk']]);
});

test('parses multiple declared submodules', () => {
  const text = [
    '[submodule "a"]', '\tpath = vendor/a', '\turl = ../a.git',
    '[submodule "b"]', '\tpath = vendor/b', '\turl = ../b.git',
  ].join('\n');
  const map = parseGitmodulesText(text);
  assert.deepEqual([...map.entries()].sort(), [['vendor/a', 'a'], ['vendor/b', 'b']]);
});

test('ignores comments and blank lines', () => {
  const text = '# a comment\n\n[submodule "a"]\n; another comment\n\tpath = vendor/a\n\turl = ../a.git\n';
  const map = parseGitmodulesText(text);
  assert.deepEqual([...map.entries()], [['vendor/a', 'a']]);
});

test('a line outside any [submodule ...] section is ignored, never attributed to a stale name', () => {
  const text = 'path = vendor/orphan\n[submodule "a"]\n\tpath = vendor/a\n\turl = ../a.git\n';
  const map = parseGitmodulesText(text);
  assert.deepEqual([...map.entries()], [['vendor/a', 'a']]);
});

test('a non-submodule section clears the current name, so a trailing path line after it is not misattributed', () => {
  const text = '[submodule "a"]\n\tpath = vendor/a\n[core]\n\tpath = should-not-count\n';
  const map = parseGitmodulesText(text);
  assert.deepEqual([...map.entries()], [['vendor/a', 'a']]);
});

test('absent or empty text is an empty declaration map, exactly like a tree with no submodules at all', () => {
  assert.deepEqual([...parseGitmodulesText('').entries()], []);
  assert.deepEqual([...parseGitmodulesText(null).entries()], []);
  assert.deepEqual([...parseGitmodulesText(undefined).entries()], []);
});

// A degenerate, invalid .gitmodules (two `path =` lines in one section) never occurs in a real
// tree; the map is keyed by PATH (what a gitlink entry's own path looks up), so both simply become
// separate entries naming the same submodule -- no special "last wins" rule is needed or applied.
test('two path lines in one degenerate section each map to the same declared name', () => {
  const text = '[submodule "a"]\n\tpath = vendor/a-old\n\tpath = vendor/a-new\n';
  const map = parseGitmodulesText(text);
  assert.deepEqual([...map.entries()].sort(), [['vendor/a-new', 'a'], ['vendor/a-old', 'a']]);
});
