import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactHeadroom, HEADROOM_WARNING, STRING_CEILING, wholeFileJson } from '../tools/whole-file-json.mjs';

const scratch = () => mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'wholefile-'));
// Sparse: the guard reads the size, so the branch is provable without writing half a gigabyte.
const sized = (root, name, bytes, body = '{"a":1}') => {
  const path = join(root, name);
  writeFileSync(path, body);
  if (bytes > body.length) truncateSync(path, bytes);
  return path;
};

test('an artifact past the string ceiling is refused, naming itself and the numbers', () => {
  const root = scratch();
  try {
    const path = sized(root, 'huge.json', constants.MAX_STRING_LENGTH + 1);
    assert.throws(() => wholeFileJson(path, { label: 'code graph' }), error =>
      error.code === 'ASCRYBE_ARTIFACT_TOO_LARGE'
      && error.detail.label === 'code graph'
      && error.detail.bytes > error.detail.ceiling
      // The message must not imply the limit is configurable, because it is not.
      && /not a limit that can be raised/u.test(error.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the ceiling decision is a pure function of size', () => {
  // The real code graph for a 1,154-document estate: 403,750,181 of 536,870,888 bytes.
  const real = artifactHeadroom(403_750_181);
  const over = artifactHeadroom(STRING_CEILING + 1);
  const small = artifactHeadroom(2_048);
  assert.deepEqual({
    real: [real.exceeds, real.approaching, Number(real.fraction.toFixed(2))],
    over: [over.exceeds, over.approaching],
    small: [small.exceeds, small.approaching],
  }, {
    real: [false, true, 0.75],
    over: [true, false],
    small: [false, false],
  });
});

test('an ordinary artifact parses without warning', () => {
  const root = scratch();
  try {
    const path = sized(root, 'small.json', 0, '{"schema":"x"}');
    const warnings = [];
    const held = wholeFileJson(path, { onWarning: row => warnings.push(row) });
    assert.deepEqual([held, warnings.length, HEADROOM_WARNING], [{ schema: 'x' }, 0, 0.7]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
