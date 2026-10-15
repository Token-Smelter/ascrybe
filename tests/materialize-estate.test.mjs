import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeEstate, readEstatePins } from '../tools/materialize-estate.mjs';
import { sourcePins } from '../tools/source-pin-identity.mjs';
import { parseRemapArguments, remapCodePlane } from '../scripts/remap.mjs';

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim();
}

function repository(root, name, build) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q']);
  build(path);
  git(path, ['add', '-A']);
  git(path, ['commit', '-qm', `Create ${name}`]);
  return path;
}

/** Two readable repositories and one whose tree carries an UNDECLARED gitlink (a mode-160000 tree
 * entry naming a commit, with no `.gitmodules` entry for it -- Git will record one from the index
 * without resolving it, exactly what a raw `git update-index --cacheinfo 160000,...` fabricates). */
function estate() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'materialize-estate-'));
  const repositories = {
    'orders-api': repository(root, 'orders-api', path => writeFileSync(join(path, 'orders.py'), 'def place():\n    return None\n')),
    'web-storefront': repository(root, 'web-storefront', path => writeFileSync(join(path, 'index.js'), 'export const cart = [];\n')),
  };
  repositories['billing-ledger'] = repository(root, 'billing-ledger', path => {
    writeFileSync(join(path, 'ledger.sql'), 'select 1;\n');
  });
  git(repositories['billing-ledger'], ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sdk`]);
  git(repositories['billing-ledger'], ['commit', '-qm', 'Add an undeclared gitlink']);
  return { root, repositories };
}

/** A real, declared submodule (via `git submodule add`) whose own repository resolves through
 * `.git/modules/<name>` -- the fixture for the case that USED to be indistinguishable from an
 * undeclared gitlink and is no longer refused at all. */
function estateWithDeclaredSubmodule() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'materialize-estate-submodule-'));
  const childPath = join(root, 'status-digest-child');
  mkdirSync(childPath, { recursive: true });
  git(childPath, ['init', '-q']);
  writeFileSync(join(childPath, 'report.md'), '# Status digest\n');
  git(childPath, ['add', '-A']);
  git(childPath, ['commit', '-qm', 'Create weekly report']);
  const repositories = {
    'orders-api': repository(root, 'orders-api', path => writeFileSync(join(path, 'orders.py'), 'def place():\n    return None\n')),
  };
  repositories['coordinator'] = join(root, 'coordinator');
  mkdirSync(repositories.coordinator, { recursive: true });
  git(repositories.coordinator, ['init', '-q']);
  writeFileSync(join(repositories.coordinator, 'service.py'), 'def run():\n    return None\n');
  git(repositories.coordinator, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childPath, 'status-digest']);
  git(repositories.coordinator, ['add', '-A']);
  git(repositories.coordinator, ['commit', '-qm', 'Add status-digest submodule']);
  return { root, repositories };
}

test('an estate pins each repository to its own head and materializes its committed bytes', () => {
  const held = estate();
  try {
    const manifest = materializeEstate({
      repositories: { 'orders-api': held.repositories['orders-api'] },
      estate: join(held.root, 'estate'),
    });
    assert.deepEqual({
      pins: manifest.pins,
      materialized: readFileSync(join(held.root, 'estate', 'orders-api', 'orders.py'), 'utf8'),
    }, {
      pins: { 'orders-api': git(held.repositories['orders-api'], ['rev-parse', 'HEAD']) },
      materialized: 'def place():\n    return None\n',
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// One estate mapped in practice held thirteen repositories, one of which carried a gitlink Ascrybe
// could not resolve. A refusal that aborted the WHOLE repository would have traded twelve exact
// repositories for none, for one gitlink among many other files; a silent skip would have produced
// an estate whose membership nobody could reconstruct. Neither happens now: the gitlink itself is
// named and counted, and everything else in that repository -- and the rest of the estate --
// materializes.
test('a repository whose tree carries an undeclared gitlink is named, not refused, while everything else in it materializes', () => {
  const held = estate();
  try {
    const estateRoot = join(held.root, 'estate');
    const manifest = materializeEstate({ repositories: held.repositories, estate: estateRoot });
    assert.deepEqual({
      pinned: Object.keys(manifest.pins).sort(),
      refusals: manifest.refusals,
      gitlinks: manifest.gitlinks.map(row => ({ repository: row.repository, kind: row.kind, status: row.status })),
      ledgerFileMaterialized: readFileSync(join(estateRoot, 'billing-ledger', 'ledger.sql'), 'utf8'),
      vendorDirAbsent: !existsSync(join(estateRoot, 'billing-ledger', 'vendor')),
    }, {
      pinned: ['billing-ledger', 'orders-api', 'web-storefront'],
      refusals: [],
      gitlinks: [{ repository: 'billing-ledger', kind: 'undeclared_gitlink', status: 'unregistered' }],
      ledgerFileMaterialized: 'select 1;\n',
      vendorDirAbsent: true,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// A declared submodule whose own repository resolves locally and whose pinned commit is present
// materializes exactly, recursively, at its own path -- the general shape this fixture reproduces
// with invented names, not a specific mapped estate.
test('a declared, available submodule materializes recursively at its own path', () => {
  const held = estateWithDeclaredSubmodule();
  try {
    const estateRoot = join(held.root, 'estate');
    const manifest = materializeEstate({ repositories: held.repositories, estate: estateRoot });
    assert.deepEqual({
      pinned: Object.keys(manifest.pins).sort(),
      refusals: manifest.refusals,
      gitlinks: manifest.gitlinks.map(row => ({ repository: row.repository, kind: row.kind, status: row.status, resolved_via: row.resolved_via })),
      reportMaterialized: readFileSync(join(estateRoot, 'coordinator', 'status-digest', 'report.md'), 'utf8'),
    }, {
      pinned: ['coordinator', 'orders-api'],
      refusals: [],
      gitlinks: [{ repository: 'coordinator', kind: 'declared_submodule', status: 'materialized', resolved_via: 'git_modules_dir' }],
      reportMaterialized: '# Status digest\n',
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// A multi-repository estate's identity is the ordered pin map's digest, and nothing on the command
// surface could hand that to remap: the parameter existed, the flag did not, so every run of one
// began by writing a script that called the module directly.
test('remap derives its source head from a pin map, and refuses a second declaration of it', () => {
  const held = estate();
  // A genuinely unreadable repository (not a gitlink, which now materializes) still produces a
  // real per-repository refusal -- the property this test's comment documents.
  held.repositories['billing-ledger'] = join(held.root, 'does-not-exist');
  try {
    const manifest = materializeEstate({ repositories: held.repositories, estate: join(held.root, 'estate') });
    const pins = join(held.root, 'estate-pins.json');
    writeFileSync(pins, JSON.stringify(manifest));
    const parsed = parseRemapArguments(['--work', held.root, '--out', join(held.root, 'map'), '--source-pins', pins]);
    assert.deepEqual({
      sha: parsed.sha,
      source_pins: parsed.source_pins,
      // The absent members travel with the pins, so a map built from a partial estate can say
      // which repositories are missing from it.
      absent: parsed.source_pin_refusals.map(row => row.repository),
      both: (() => {
        try { parseRemapArguments(['--work', held.root, '--out', held.root, '--source-pins', pins, '--sha', 'b'.repeat(40)]); return null; }
        catch (error) { return error.message; }
      })(),
    }, {
      // The projection's own authority on what a multi-repository estate's source commit is.
      sha: sourcePins({ source_pins: manifest.pins }).digest,
      source_pins: { 'orders-api': manifest.pins['orders-api'], 'web-storefront': manifest.pins['web-storefront'] },
      absent: ['billing-ledger'],
      both: '--sha and --source-pins both declare the source identity; a multi-repository estate declares only the pins',
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// A second run into a populated estate root exited green having written a pin map that named only
// what it rebuilt, while extract went on to map every child directory present -- so the digest
// that IS the estate's identity described less than what was mapped. This is an operator error,
// not a repository Ascrybe cannot read exactly, so it fails hard instead of joining the refusals.
test('a populated estate root is refused outright rather than becoming a per-repository refusal', () => {
  const held = estate();
  try {
    const estateRoot = join(held.root, 'estate');
    materializeEstate({ repositories: { 'orders-api': held.repositories['orders-api'] }, estate: estateRoot });
    assert.throws(
      () => materializeEstate({ repositories: { 'web-storefront': held.repositories['web-storefront'] }, estate: estateRoot }),
      /estate root must be absent or empty/u);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// The pin map is the estate's source identity, so it is checked against itself the way every
// neighbouring artifact is. Without this a hand-edited sha is accepted silently, and the number an
// operator read on the console differs from the one remap stamps into provenance.
test('a pin map whose declared identity disagrees with its pins is refused on read', () => {
  const held = estate();
  try {
    const manifest = materializeEstate({
      repositories: { 'orders-api': held.repositories['orders-api'] },
      estate: join(held.root, 'estate'),
    });
    const tampered = join(held.root, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ ...manifest, pins: { 'orders-api': 'b'.repeat(40) } }));
    assert.throws(() => readEstatePins(tampered), /declares source_identity/u);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// The converse of refusing --sha alongside --source-pins, and the likelier mistake by far. A
// multi-repository estate remapped with one --sha produces a code graph with no pins, and read-span
// then seeks EVERY repository's bytes at one repository's commit. The estate's own extract manifest
// already knows how many members it read, so the guess is refusable rather than merely wrong.
test('a multi-repository work directory refuses a single --sha', () => {
  const held = estate();
  try {
    const work = join(held.root, 'work');
    mkdirSync(join(work, 'extract'), { recursive: true });
    writeFileSync(join(work, 'extract', '_MANIFEST.json'),
      JSON.stringify({ repositories: [{ repo: 'orders-api' }, { repo: 'web-storefront' }] }));
    assert.throws(
      () => remapCodePlane({ work, sha: 'a'.repeat(40), out: join(held.root, 'map') }),
      /pass --source-pins instead of --sha/u);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});
