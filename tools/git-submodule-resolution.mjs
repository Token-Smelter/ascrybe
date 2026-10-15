// A gitlink is a pinned reference to another repository, not a reason to refuse the tree that
// carries it (design: submodule support). This module is the ONE place both consumers of that
// design share the resolution rule, so `ascrybe update`'s inventory and the materialize/
// documentary path can never quietly diverge on what "the submodule's repository" means:
//
//   1. an explicitly declared member in source_repositories (the caller's own runtime config);
//   2. the parent's `<git-common-dir>/modules/<name>` (the standard location `git submodule
//      init`/`update` leaves a submodule's own admin directory, keyed by its .gitmodules name);
//   3. the checked-out submodule directory's own `.git` (present after a real `git submodule
//      update --checkout`, whether that `.git` is a file pointing back at #2 or an embedded repo).
//
// Resolving is not enough: the caller still checks the pinned commit is actually PRESENT in
// whatever repository this resolves to (submoduleCommitPresent) before treating it as available.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GITLINK_MODE = '160000';
export const DEFAULT_MAX_SUBMODULE_DEPTH = 8;

export const SUBMODULE_UNAVAILABLE_CODE = 'SUBMODULE_UNAVAILABLE';
export const GITLINK_UNREGISTERED_CODE = 'GITLINK_UNREGISTERED';
export const SUBMODULE_CYCLE_CODE = 'SUBMODULE_CYCLE_DETECTED';
export const SUBMODULE_DEPTH_EXCEEDED_CODE = 'SUBMODULE_DEPTH_EXCEEDED';

/**
 * Parses a `.gitmodules` BLOB'S TEXT (never a live path -- the caller reads it from the pinned
 * commit's tree, through whichever Git plumbing that caller already uses) into a Map of declared
 * checkout path -> submodule name. Sufficient for the shape `git submodule add` produces --
 * `[submodule "<name>"]` followed by indented `path`/`url` lines -- not a general Git-config-format
 * parser. A path absent from this map is an undeclared gitlink, never inferred as one anyway.
 */
export function parseGitmodulesText(text) {
  const nameByPath = new Map();
  let currentName = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[submodule\s+"(.*)"\]$/u.exec(line);
    if (section) { currentName = section[1]; continue; }
    if (line.startsWith('[')) { currentName = null; continue; }
    if (!currentName) continue;
    const pathLine = /^path\s*=\s*(.+)$/u.exec(line);
    if (pathLine) nameByPath.set(pathLine[1].trim(), currentName);
  }
  return nameByPath;
}

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Resolves a declared submodule's own repository, in the fixed order this module documents at its
 * top. Returns `null` (never throws) when none of the three locations exist -- the caller decides
 * what an unresolved submodule means; this function only ever answers "where, if anywhere."
 */
export function resolveSubmoduleRepository({ parentRepository, name, path, sourceRepositories = {} }) {
  if (Object.prototype.hasOwnProperty.call(sourceRepositories, name)) {
    return Object.freeze({ repository: resolve(sourceRepositories[name]), resolved_via: 'source_repositories' });
  }
  try {
    const commonDir = git(parentRepository, ['rev-parse', '--git-common-dir']).trim();
    const modulesDir = resolve(parentRepository, commonDir, 'modules', name);
    if (existsSync(modulesDir) && statSync(modulesDir).isDirectory()) {
      return Object.freeze({ repository: modulesDir, resolved_via: 'git_modules_dir' });
    }
  } catch { /* the parent may not have a real Git admin directory in a fixture; fall through */ }
  const checkoutPath = resolve(parentRepository, path);
  if (existsSync(join(checkoutPath, '.git'))) {
    return Object.freeze({ repository: checkoutPath, resolved_via: 'checkout_gitdir' });
  }
  return null;
}

/** Whether `sha` is actually present as a commit object in `repository` -- resolving to a real
 * directory is not the same as the pinned commit having ever been fetched into it. */
export function submoduleCommitPresent(repository, sha) {
  try { git(repository, ['cat-file', '-e', `${sha}^{commit}`]); return true; }
  catch { return false; }
}
