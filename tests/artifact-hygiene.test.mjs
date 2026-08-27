import assert from 'node:assert/strict';
import test from 'node:test';
import { trackedFiles, violations } from '../scripts/check-artifact-hygiene.mjs';

test('tracked-tree hygiene enumerates the repository instead of the empty index diff', () => {
  const files = trackedFiles();
  assert.ok(files.length > 0);
  assert.ok(files.includes('README.md'));
});

test('tracked-tree hygiene applies generated-payload rules', () => {
  const found = violations(['analysis/current-evidence/result.json'], () => 1);
  assert.deepEqual(found, [{
    path: 'analysis/current-evidence/result.json',
    bytes: 1,
    rule: 'generated payload under analysis/current-evidence/ must live in ignored custody',
  }]);
});
