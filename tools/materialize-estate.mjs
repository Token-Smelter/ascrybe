#!/usr/bin/env node
// Build an estate root from the repositories the runtime config declares, one exact Git tree each.
//
// WHY THIS IS A VERB AND NOT A SHELL LOOP. `extract` and `merge` already take a multi-repository
// estate: extract treats every immediate child of the estate root as a component. What had no
// owner was the step before them -- turning N declared repositories into that root at exact
// commits -- and, more importantly, the artifact it produces. A multi-repository estate has no
// single source commit, so its identity is the ordered {repository: sha} pin map; the projection
// checks that digest and read-span resolves each fact's bytes against its own repository's pin.
// Nothing on the command surface could produce that map, so every multi-repository run so far
// began by writing a script.
//
// A repository Ascrybe cannot read exactly is refused by name and the estate continues without
// it. Aborting the whole run for one member would trade every exact repository for none, and an
// absence that is counted and named is the honest outcome; a repository quietly mapped from a
// dirty worktree would not be. An estate where NOTHING materialized is a failure, not a refusal.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEstateMapRuntimeConfig } from './ascrybe-config.mjs';
import { sourcePins } from './source-pin-identity.mjs';
import { materializeExactGitTree } from './git-tree-source.mjs';
import { parseArgs } from './lib.mjs';

export const ESTATE_PINS_SCHEMA = 'estate-map/estate-pins/v1';

const HELP = `Usage: ascrybe materialize --estate <dir> --pins <file>

Materializes every repository in the runtime config's source_repositories into <dir>, one exact
Git tree per repository at its current head, and writes the pin map <dir> was built from.

  --estate <dir>   where the repositories are materialized; must be absent or empty
  --pins <file>    where the ${ESTATE_PINS_SCHEMA} manifest is written`;

// Code-point order, not host-locale collation: an estate's key order must not depend on the
// machine.
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function headCommit(repository) {
  // Git's stderr is captured rather than inherited: the failure it describes becomes the refusal's
  // message, and printing it twice makes a named refusal look like an unhandled crash.
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD^{commit}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** One REFUSED line per repository, so a multi-line git failure cannot break the run report. */
const oneLine = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

/**
 * One exact tree per declared repository. Each is pinned to its OWN head: a repository is a
 * separate history, so there is no commit that means anything across all of them.
 */
export function materializeEstate({ repositories, estate }) {
  const names = Object.keys(repositories || {}).sort(compare);
  if (!names.length) throw new Error('source_repositories declares no repository to materialize');
  // A name reaches join() below, and the exported function is a boundary the config validator does
  // not stand behind.
  const unsafe = names.filter(name => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name));
  if (unsafe.length) throw new Error(`source_repositories names are not simple identifiers: ${unsafe.join(', ')}`);
  const root = resolve(estate);
  // A NON-EMPTY estate root is an operator error, not a repository that cannot be read exactly.
  // Left to the per-repository catch it became a GIT_MATERIALIZATION_TARGET_NOT_EMPTY refusal, so
  // a second run into the same root exited green having written a pin map that named only the
  // repositories it happened to rebuild -- while extract went on to map every child directory
  // present. The digest that IS the estate's identity then described less than what was mapped.
  if (existsSync(root) && (!statSync(root).isDirectory() || readdirSync(root).length)) {
    throw new Error(`estate root must be absent or empty: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  const pins = {};
  const refusals = [];
  const gitlinks = [];
  for (const name of names) {
    const target = join(root, name);
    try {
      const sha = headCommit(repositories[name]);
      // Every OTHER declared member is offered first for a declared submodule's own repository --
      // one already-known repository is a better answer than digging through .git/modules.
      const held = materializeExactGitTree({ repository: repositories[name], sha, target, project_id: name,
        source_repositories: repositories });
      pins[name] = sha;
      for (const link of held.manifest.gitlinks ?? []) gitlinks.push({ repository: name, ...link });
    } catch (error) {
      // Materialization writes blobs before it validates them, so a refusal can arrive with bytes
      // already on disk. Leaving them would hand extract a repository the pin map does not name --
      // the same divergence the estate-root precondition above exists to prevent.
      rmSync(target, { recursive: true, force: true });
      refusals.push({ repository: name, code: error.code || 'GIT_TREE_MATERIALIZATION_FAILED',
        message: oneLine(error.message) });
    }
  }
  return Object.freeze({
    schema: ESTATE_PINS_SCHEMA,
    estate_root: root,
    pins,
    refusals,
    // Every gitlink encountered anywhere across the estate's materialized repositories -- named and
    // counted here too, not only inside each repository's own git-tree-source manifest, because
    // this is the ONE receipt an operator reading `ascrybe materialize`'s output actually sees.
    gitlinks,
    // Derived through the same function the projection will use, so the number an operator reads
    // here cannot disagree with the one a projection checks.
    source_identity: Object.keys(pins).length ? sourcePins({ source_pins: pins }).digest : null,
  });
}

/**
 * Read a written pin map back as the source identity a later stage declares. The manifest is
 * checked against ITSELF: every neighbouring artifact carries a digest of its own body, and a
 * pin map that did not would let a hand-edited sha through while the console line an operator
 * read said something else.
 */
export function readEstatePins(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (manifest?.schema !== ESTATE_PINS_SCHEMA) {
    throw new Error(`${path} is not an ${ESTATE_PINS_SCHEMA} manifest`);
  }
  if (!manifest.pins || typeof manifest.pins !== 'object' || Array.isArray(manifest.pins)) {
    throw new Error(`${path} does not carry a {repository: sha} pin map`);
  }
  const identity = sourcePins({ source_pins: manifest.pins });
  if (manifest.source_identity !== identity.digest) {
    throw new Error(`${path} declares source_identity ${manifest.source_identity}, but its pins digest to ${identity.digest}`);
  }
  return Object.freeze({ pins: identity.pins, digest: identity.digest,
    refusals: Object.freeze([...(manifest.refusals ?? [])]) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); process.exit(0); }
  try {
    for (const required of ['estate', 'pins', 'runtime-config']) {
      if (!options[required]) throw new Error(`--${required} is required\n\n${HELP}`);
    }
    // Checked BEFORE the run, not after it. The pin map is written as the last statement of work
    // that can take an hour, and it is the only artifact of that hour; an unwritable path found
    // then costs the whole run.
    const pinsPath = resolve(options.pins);
    if (!existsSync(dirname(pinsPath))) throw new Error(`--pins names a directory that does not exist: ${dirname(pinsPath)}`);
    const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
    const manifest = materializeEstate({
      repositories: runtime.config.source_repositories, estate: options.estate,
    });
    for (const [repository, sha] of Object.entries(manifest.pins)) console.log(`MATERIALIZED ${repository} ${sha}`);
    for (const refusal of manifest.refusals) console.log(`REFUSED ${refusal.repository} ${refusal.code} ${refusal.message}`);
    writeFileSync(pinsPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`RESULT repositories=${Object.keys(manifest.pins).length} refused=${manifest.refusals.length} source_identity=${manifest.source_identity}`);
    // An estate of nothing is not a run that succeeded with refusals; it is a run that produced no
    // estate. The manifest is still written, because the refusals are the finding.
    if (!manifest.source_identity) throw new Error('no repository materialized; the estate has no source identity');
  } catch (error) {
    console.error(`FAIL materialize: ${error.message}`);
    process.exitCode = 1;
  }
}
