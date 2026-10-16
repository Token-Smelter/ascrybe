import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithin } from '../tools/path-within.mjs';

test('only a parent-directory segment leaves the parent; a child named with leading dots stays inside', () => {
  const cases = [['/a/src', '/a/src'], ['/a/src', '/a/src/..state'], ['/a/src', '/a/src/x/y'], ['/a/src', '/a/src/..'], ['/a/src', '/a/other'], ['/a/src', '/a/srcx']];
  assert.deepEqual(cases.map(([p, c]) => isWithin(p, c)), [true, true, true, false, false, false]);
});
