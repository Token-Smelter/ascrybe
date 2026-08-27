#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Which tests need materialized assets is a property of the tests, not a list beside them. The
// list this replaces had already drifted: v32-fixed-regression-profile.test.mjs uses the helper
// and was never declared, so it ran in the fast scope -- the drift the list existed to prevent,
// happening to the list. It also made a reduced distribution unusable, because a file that was
// never shipped is indistinguishable from one that was renamed.
//
// A test declares itself by importing `fullAssetTest`, which is the same fact the helper already
// uses to skip when its assets are absent. Deriving it means there is nothing to keep in sync.
export function fullAssetTestFiles(testsDir) {
  return readdirSync(testsDir)
    .filter(name => name.endsWith('.test.mjs'))
    .filter(name => readFileSync(join(testsDir, name), 'utf8').includes('fullAssetTest'))
    .sort();
}

export function fastTestFiles() {
  const testsDir = resolve(root, 'tests');
  const all = readdirSync(testsDir).filter(name => name.endsWith('.test.mjs')).sort();
  const exclusions = new Set(fullAssetTestFiles(testsDir));
  const selected = all.filter(name => !exclusions.has(name)).map(name => `tests/${name}`);
  // These proofs must be IN the fast scope whenever they are present. The guard is about scope
  // correctness -- a tracked mini proof silently excluded -- not about distribution completeness,
  // so a file that was never shipped has nothing to exclude and is reported rather than fatal.
  for (const required of [
    'tests/c4-mini-corpus.test.mjs',
    'tests/extraction-cache-mini-fixture.test.mjs',
  ]) {
    if (selected.includes(required)) continue;
    if (all.includes(required.slice('tests/'.length))) {
      throw new Error(`fast test scope omits required tracked mini proof ${required}`);
    }
    console.log(`MINI PROOF ABSENT FROM THIS DISTRIBUTION: ${required}`);
  }
  return Object.freeze(selected);
}

export function main() {
  const selected = fastTestFiles();
  console.log(`FAST TEST SCOPE: ${selected.length} tracked/self-contained files`);
  const deferred = fullAssetTestFiles(resolve(root, 'tests'));
  console.log(`FULL-ASSET TEST FILES DEFERRED: ${deferred.length ? deferred.join(', ') : 'none in this distribution'}`);
  const result = spawnSync(process.execPath, ['--test', ...selected], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
