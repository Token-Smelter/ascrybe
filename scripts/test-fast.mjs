#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function scratchDirectories() {
  return [...new Set([process.env.ASCRYBE_SCRATCH_DIR, process.env.TMPDIR, tmpdir()].filter(Boolean).map(dir => resolve(dir)))];
}

function scratchNames(dir) {
  try { return readdirSync(dir); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function scratchSnapshot() {
  return scratchDirectories().map(dir => [dir, new Set(scratchNames(dir))]);
}

// Counts only. Names and directories stay out of the log: a scratch parent can hold unrelated roots.
export function scratchDelta(before) {
  const created = [];
  const removed = [];
  for (const [dir, prior] of before) {
    const now = new Set(scratchNames(dir));
    for (const name of now) if (!prior.has(name)) created.push(name);
    for (const name of prior) if (!now.has(name)) removed.push(name);
  }
  const prefixes = {};
  let unclassified = 0;
  for (const name of created) {
    const prefix = name.replace(/[A-Za-z0-9]{6}$/u, '');
    if (/^[a-z0-9][a-z0-9-]{0,80}$/u.test(prefix)) prefixes[prefix] = (prefixes[prefix] || 0) + 1;
    else unclassified += 1;
  }
  return { created: created.length, removed_preexisting: removed.length, prefixes, unclassified };
}

export function main() {
  const selected = fastTestFiles();
  console.log(`FAST TEST SCOPE: ${selected.length} tracked/self-contained files`);
  const deferred = fullAssetTestFiles(resolve(root, 'tests'));
  console.log(`FULL-ASSET TEST FILES DEFERRED: ${deferred.length ? deferred.join(', ') : 'none in this distribution'}`);
  const before = scratchSnapshot();
  const result = spawnSync(process.execPath, ['--test', ...selected], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  const delta = scratchDelta(before);
  const preexisting = before.reduce((count, [, names]) => count + names.size, 0);
  console.log(`SCRATCH_MEASURE preexisting=${preexisting} new=${delta.created} removed_preexisting=${delta.removed_preexisting} unclassified=${delta.unclassified} prefixes=${JSON.stringify(delta.prefixes)}`);
  const status = result.status ?? 1;
  // A shared scratch directory also receives roots from concurrent, unrelated processes, so a
  // leak fails the run only where the directory is known to be private to it (for example CI).
  const strict = process.env.ASCRYBE_SCRATCH_STRICT === '1';
  process.exitCode = strict && status === 0 && delta.created !== 0 ? 1 : status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
