// Install a built skill bundle into a project that will consume it.
//
// The build was fixed long ago; the INSTALL never was, and copying by hand is what produced the
// failure the builder's own header describes -- an installed copy two contract versions stale with
// nothing to notice. Three `cp` commands typed from memory have no target convention, no way to
// retire the previous install, and no check that what landed can run.
//
// So this refuses more than it does. It will not invent a skills directory in a project that has
// no convention for one, will not delete a directory it cannot identify as a previous install of
// this skill, and will not report success until the installed entry points actually load and fail
// closed on their own.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { stableStringify } from './lib.mjs';

export const SKILL_INSTALL_RECORD_SCHEMA = 'ascrybe/skill-install/v1';
export const DEFAULT_SKILLS_DIR = join('.pi', 'agent', 'skills');
export const SKILL_NAME = 'ascrybe';
// Installs this replaces. A directory under one of these names still has to prove it is ours.
export const RETIRED_SKILL_NAMES = Object.freeze(['estate-map']);

/** Every file beneath a directory, so a reported total is the total. */
function countFiles(root) {
  return readdirSync(root, { withFileTypes: true }).reduce((held, entry) => held
    + (entry.isDirectory() ? countFiles(join(root, entry.name)) : 1), 0);
}

function installError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

/**
 * Whether a directory is a previous install of THIS skill, rather than something a project happens
 * to keep under the same name. Deleting the second is not this command's business.
 */
export function priorInstallOf(path, { read = p => readFileSync(p, 'utf8') } = {}) {
  const skill = join(path, 'SKILL.md');
  if (!existsSync(skill)) return { ours: false, reason: 'no SKILL.md' };
  const text = read(skill);
  const name = /^name:\s*(\S+)\s*$/mu.exec(text)?.[1];
  if (!name || ![SKILL_NAME, ...RETIRED_SKILL_NAMES].includes(name)) {
    return { ours: false, reason: `SKILL.md declares name: ${name ?? '(none)'}` };
  }
  return { ours: true, name };
}

/** The skills directory to install into, or the reason there is not one. */
export function resolveSkillsDir({ into, skills_dir: skillsDir = null }) {
  // A named directory is obeyed wherever it is -- the refusal below is about GUESSING a location,
  // and once someone names one there is nothing left to guess. It must exist, though: a path that
  // does not is far more often a typo than an instruction, and creating it puts the skill
  // somewhere nothing reads while reporting success.
  if (skillsDir) {
    const named = resolve(skillsDir);
    if (!existsSync(named)) {
      throw installError('SKILL_INSTALL_SKILLS_DIR_ABSENT',
        `--skills-dir ${named} does not exist; create it if that is really where skills live here`,
        { skills_dir: named });
    }
    if (!statSync(named).isDirectory()) {
      throw installError('SKILL_INSTALL_SKILLS_DIR_NOT_A_DIRECTORY', `--skills-dir ${named} is not a directory`,
        { skills_dir: named });
    }
    return named;
  }
  const held = resolve(into, DEFAULT_SKILLS_DIR);
  if (existsSync(held)) return held;
  // Creating `.pi/agent/skills` in a project with no `.pi/agent` invents a convention the project
  // never adopted, and the skill would sit somewhere nothing reads.
  if (existsSync(dirname(held))) return held;
  throw installError('SKILL_INSTALL_NO_SKILLS_DIR',
    `${into} has no ${DEFAULT_SKILLS_DIR}; pass --skills-dir to say where skills live in this project`,
    { into, looked_for: held });
}

/**
 * Prove the installed bundle runs from where it landed.
 *
 * Not a connection test: an installer cannot assume a database or a config. Invoking each entry
 * point with an empty config exercises the whole path that matters here -- the file is present, its
 * imports resolve from the install location, argument parsing runs -- and requires it to refuse
 * rather than proceed. Both of the defects a human reviewer caught in the last bundle were of this
 * shape, and nothing mechanical was looking.
 */
export function verifyInstalledEntryPoints(path, entryPoints, { run = spawnSync } = {}) {
  const checked = [];
  for (const entry of entryPoints) {
    const target = join(path, entry);
    if (!existsSync(target)) throw installError('SKILL_INSTALL_ENTRY_MISSING', `installed bundle has no ${entry}`);
    const held = run(process.execPath, [target, '--runtime-config', ''], { encoding: 'utf8' });
    const said = `${held.stdout ?? ''}${held.stderr ?? ''}`;
    if (held.status === 0 || !said.includes('ARGUMENT_INVALID')) {
      throw installError('SKILL_INSTALL_ENTRY_UNRUNNABLE',
        `${entry} did not load and refuse from its install location; it exited ${held.status} saying ${said.trim().slice(0, 200)}`,
        { entry, status: held.status });
    }
    checked.push(entry);
  }
  return checked;
}

export function installSkillBundle({ bundle, into, skills_dir: skillsDir = null, repository = null,
  name = SKILL_NAME }, { run = spawnSync } = {}) {
  const source = resolve(bundle);
  const manifest = JSON.parse(readFileSync(join(source, 'bundle.json'), 'utf8'));
  const target = join(resolveSkillsDir({ into: resolve(into), skills_dir: skillsDir }), name);

  const retired = [];
  for (const candidate of [name, ...RETIRED_SKILL_NAMES]) {
    const path = join(dirname(target), candidate);
    if (!existsSync(path) || !statSync(path).isDirectory()) continue;
    const held = priorInstallOf(path);
    if (!held.ours) {
      throw installError('SKILL_INSTALL_TARGET_NOT_OURS',
        `${path} exists but is not an install of this skill (${held.reason}); move it aside rather than `
        + 'letting an installer delete it', { path, reason: held.reason });
    }
    rmSync(path, { recursive: true, force: true });
    retired.push(candidate);
  }

  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  // The contract digest catches a bundle describing a different surface. It cannot say which
  // Ascrybe produced this copy, which is the first question when one drifts.
  const commit = repository
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim() : null;
  const record = {
    schema: SKILL_INSTALL_RECORD_SCHEMA,
    skill: name,
    installed_from_ascrybe_commit: commit,
    surface_contract: manifest.surface_contract,
    contract_digest: manifest.contract_digest,
    retired_previous_installs: retired,
    requires: manifest.requires,
  };
  writeFileSync(join(target, 'INSTALL.json'), stableStringify(record));
  const checked = verifyInstalledEntryPoints(target, manifest.entry_points ?? [], { run });
  // Count files, not top-level entries. `readdirSync().length` reported 5 for an eighteen-file
  // install -- the same ambiguity `bundle.json` had, reintroduced one commit after fixing it.
  return Object.freeze({ ...record, path: target, verified_entry_points: checked,
    files: countFiles(target) });
}
