import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildSkillBundle, importClosure, verifySkillBundle } from '../scripts/build-skill-bundle.mjs';
import { ESTATE_QUERY_CONTRACT_VERSION, querySurfaceContract } from '../tools/estate-graph-query.mjs';

const scratch = () => mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'skill-bundle-'));

test('the bundle carries the read surface and nothing that can write a projection', () => {
  const root = scratch();
  try {
    const held = buildSkillBundle({ out: join(root, 'bundle') });
    const names = held.bundled_files.map(file => file.split('/').pop());
    assert.deepEqual({
      // A write-path module in a read-only bundle is the failure the build refuses outright.
      write: names.filter(name => ['estate-graph-projection.mjs', 'extract.mjs', 'merge.mjs',
        'documented-assertions.mjs', 'assertion-relations.mjs'].includes(name)),
      // Both CLIs and the roles registry they read planes from.
      read: ['estate-graph-query.mjs', 'estate-graph-cypher.mjs', 'estate-graph-roles.mjs']
        .every(name => names.includes(name)),
      stamped: held.surface_contract,
      entries: held.entry_points.every(entry => existsSync(join(held.out, entry))),
      // Named, never valued: no credential leaves this repository in a bundle.
      credentials: JSON.stringify(held.requires).includes('password'),
    }, { write: [], read: true, stamped: ESTATE_QUERY_CONTRACT_VERSION, entries: true, credentials: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an import spanning lines is still followed', () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'leaf.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'entry.mjs'), "import {\n  value,\n} from './leaf.mjs';\nexport default value;\n");
    // A single-line pattern missed a multi-line specifier list, and the bundle it produced was
    // missing a module it needed — visible only when the bundle ran somewhere else.
    assert.deepEqual(importClosure(['entry.mjs'], root).sort(), ['entry.mjs', 'leaf.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nothing in the bundle names a path on the machine that built them', () => {
  const root = scratch();
  try {
    const held = buildSkillBundle({ out: join(root, 'bundle') });
    // Scanning only SKILL.md was the weaker check: a prose comment in a bundled module named a
    // home directory, and this test could not see it because it never looked past the
    // instructions. A published bundle discloses whatever any of its bytes say, comments
    // included, so every file it ships is in scope.
    const offenders = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        const text = readFileSync(path, 'utf8');
        for (const [index, line] of text.split('\n').entries()) {
          if (/\/(?:home|Users)\/[A-Za-z0-9._-]+\//u.test(line)) {
            offenders.push(`${relative(held.out, path)}:${index + 1}: ${line.trim().slice(0, 80)}`);
          }
        }
      }
    };
    walk(held.out);
    assert.deepEqual(offenders, [], `bundle names paths on the build machine:\n${offenders.join('\n')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verification fails when a bundle describes a surface it is no longer talking to', () => {
  const root = scratch();
  try {
    const held = buildSkillBundle({ out: join(root, 'bundle') });
    const contract = querySurfaceContract();
    assert.equal(verifySkillBundle({ path: held.out, contract }).ok, true);
    // Same commands, changed data model: the failure a command-only digest could not see.
    const drifted = verifySkillBundle({ path: held.out, contract: { ...contract, digest: '0'.repeat(64) } });
    assert.deepEqual([drifted.ok, drifted.reason], [false, 'same contract version, different surface digest']);
    const older = verifySkillBundle({ path: held.out, contract: { ...contract, contract: 'estate-map/query-surface/v1' } });
    assert.deepEqual([older.ok, older.reason], [false, 'contract version differs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
