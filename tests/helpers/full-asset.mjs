import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeTest from 'node:test';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Some suites read materialized assets that are deliberately untracked: `estate/` is a 369 MB copy
 * of the target estate, and `runs/` holds recorded run outputs. They exist only where a run has
 * produced them, so a Git worktree or a fresh clone legitimately lacks them.
 *
 * Failing in that situation is wrong twice over. It reports a defect where there is only an absent
 * optional input, and — because every code-change Work Order executes in a prepared sibling worktree
 * — it made the project's own deterministic proof battery unpassable at every SHA, which is how two
 * Brews came to fail today for reasons unrelated to their diffs.
 *
 * So the suite skips with a stated reason instead. `scripts/test-fast.mjs` still excludes these
 * files from the fast scope; this makes them honest wherever the full suite is run.
 */
/**
 * True when every required asset is present. Some suites must also guard MODULE-SCOPE work — a
 * top-level read, a JSON import, or a corpus build — because that runs before any test registers,
 * so skipping the tests alone cannot prevent an import-time throw.
 */
export function fullAssetsPresent(...requiredPaths) {
  return requiredPaths.every(relative => existsSync(resolve(root, relative)));
}

export function fullAssetTest(...requiredPaths) {
  const missing = requiredPaths.filter(relative => !existsSync(resolve(root, relative)));
  if (!missing.length) return nodeTest;
  const reason = `requires untracked local assets absent here: ${missing.join(', ')}`;
  const skipped = (name, ...rest) => nodeTest(name, { skip: reason }, () => {});
  skipped.skip = nodeTest.skip;
  skipped.todo = nodeTest.todo;
  skipped.only = (name, ...rest) => nodeTest(name, { skip: reason }, () => {});
  return skipped;
}
