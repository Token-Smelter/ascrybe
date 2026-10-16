import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('semantic map consumes source identity without a projection dependency', () => {
  const source = readFileSync(fileURLToPath(new URL('../tools/semantic-map-run.mjs', import.meta.url)), 'utf8');
  assert.equal(source.includes("from './source-pin-identity.mjs'")
    && !source.includes("from './estate-graph-projection.mjs'"), true);
});
