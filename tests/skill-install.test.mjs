import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillBundle } from '../scripts/build-skill-bundle.mjs';
import { installSkillBundle, priorInstallOf, resolveSkillsDir, verifyInstalledEntryPoints,
  DEFAULT_SKILLS_DIR } from '../tools/skill-install.mjs';

const scratch = () => mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'skill-install-'));
const project = root => {
  const held = join(root, 'project');
  mkdirSync(join(held, DEFAULT_SKILLS_DIR), { recursive: true });
  return held;
};

// The defects a human reviewer caught -- a config nothing supplies, a path not in the bundle --
// were both "does the installed copy actually work", and nothing mechanical was asking. This is
// that question: build into a temp directory and run what landed, with nothing else supplied.
test('an installed bundle loads from where it landed and refuses without a config', () => {
  const root = scratch();
  try {
    const into = project(root);
    const bundle = buildSkillBundle({ out: join(root, 'dist') });
    const held = installSkillBundle({ bundle: bundle.out, into, repository: process.cwd() });
    assert.deepEqual(held.verified_entry_points, ['bin/estate-query.mjs', 'bin/estate-cypher.mjs']);
    assert.equal(held.surface_contract, bundle.surface_contract);
    assert.ok(existsSync(join(held.path, 'SKILL.md')));
    // Which Ascrybe produced this copy is the first question when one drifts, and the contract
    // digest cannot answer it.
    const record = JSON.parse(readFileSync(join(held.path, 'INSTALL.json'), 'utf8'));
    assert.match(record.installed_from_ascrybe_commit, /^[0-9a-f]{40}$/u);
    assert.equal(record.requires.runtime_config, 'ASCRYBE_CONFIG');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an entry point that does not refuse fails the install', () => {
  // A bundle that connected, or crashed, or exited 0 on an empty config would pass a file-count
  // check and be useless or dangerous. Drive the checker with each of those shapes.
  const path = join(scratch(), 'nowhere');
  mkdirSync(join(path, 'bin'), { recursive: true });
  writeFileSync(join(path, 'bin', 'entry.mjs'), '');
  for (const outcome of [{ status: 0, stdout: 'connected' }, { status: 1, stdout: 'Cannot find module' }]) {
    assert.throws(() => verifyInstalledEntryPoints(path, ['bin/entry.mjs'], { run: () => outcome }),
      error => error.code === 'SKILL_INSTALL_ENTRY_UNRUNNABLE');
  }
  assert.deepEqual(
    verifyInstalledEntryPoints(path, ['bin/entry.mjs'],
      { run: () => ({ status: 1, stdout: '{"error":"ESTATE_QUERY_ARGUMENT_INVALID"}' }) }),
    ['bin/entry.mjs']);
});

test('the retired name is replaced, and a directory that is not ours is not', () => {
  const root = scratch();
  try {
    const into = project(root);
    const skills = join(into, DEFAULT_SKILLS_DIR);
    // A hand-copied install under the old name: exactly what was found in a consuming repository.
    mkdirSync(join(skills, 'estate-map'), { recursive: true });
    writeFileSync(join(skills, 'estate-map', 'SKILL.md'), '---\nname: estate-map\n---\n');
    const bundle = buildSkillBundle({ out: join(root, 'dist') });
    const held = installSkillBundle({ bundle: bundle.out, into, repository: process.cwd() });
    assert.deepEqual(held.retired_previous_installs, ['estate-map']);
    assert.equal(existsSync(join(skills, 'estate-map')), false);

    // Someone else's directory that happens to share the name is not an installer's to delete.
    mkdirSync(join(skills, 'estate-map'), { recursive: true });
    writeFileSync(join(skills, 'estate-map', 'SKILL.md'), '---\nname: someone-elses\n---\n');
    assert.throws(() => installSkillBundle({ bundle: bundle.out, into, repository: process.cwd() }),
      error => error.code === 'SKILL_INSTALL_TARGET_NOT_OURS');
    assert.equal(existsSync(join(skills, 'estate-map', 'SKILL.md')), true, 'it must still be there');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a project with no skills convention is refused rather than given one', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'bare'), { recursive: true });
    assert.throws(() => resolveSkillsDir({ into: join(root, 'bare') }),
      error => error.code === 'SKILL_INSTALL_NO_SKILLS_DIR');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The refusal above is about GUESSING a location. Once someone names one there is nothing left to
// guess, so any existing directory is obeyed wherever it sits -- inside the project or not.
test('a named skills directory is obeyed anywhere, provided it exists', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'bare'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    assert.equal(resolveSkillsDir({ into: join(root, 'bare'), skills_dir: join(root, 'elsewhere') }),
      join(root, 'elsewhere'));

    // A path that does not exist is far more often a typo than an instruction, and creating it
    // would put the skill somewhere nothing reads while reporting success.
    assert.throws(() => resolveSkillsDir({ into: join(root, 'bare'), skills_dir: join(root, 'typo') }),
      error => error.code === 'SKILL_INSTALL_SKILLS_DIR_ABSENT');

    writeFileSync(join(root, 'a-file'), '');
    assert.throws(() => resolveSkillsDir({ into: join(root, 'bare'), skills_dir: join(root, 'a-file') }),
      error => error.code === 'SKILL_INSTALL_SKILLS_DIR_NOT_A_DIRECTORY');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installing into a named directory outside the project works end to end', () => {
  const root = scratch();
  try {
    const into = join(root, 'bare');
    const skills = join(root, 'custom-skills');
    mkdirSync(into, { recursive: true });
    mkdirSync(skills, { recursive: true });
    const bundle = buildSkillBundle({ out: join(root, 'dist') });
    const held = installSkillBundle({ bundle: bundle.out, into, skills_dir: skills, repository: process.cwd() });
    assert.equal(held.path, join(skills, 'ascrybe'));
    assert.deepEqual(held.verified_entry_points, ['bin/estate-query.mjs', 'bin/estate-cypher.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a directory is only a prior install if it says it is this skill', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'a'), { recursive: true });
    assert.equal(priorInstallOf(join(root, 'a')).ours, false);
    writeFileSync(join(root, 'a', 'SKILL.md'), '---\nname: ascrybe\n---\n');
    assert.equal(priorInstallOf(join(root, 'a')).ours, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
