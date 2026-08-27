// Read-only invariant for the estate map.
//
// WHY THIS EXISTS. Every extractor in this directory reads a SCANNED TREE (the
// "estate") and writes derived artifacts somewhere. Two tools shipped with an
// output default INSIDE the tree they scan:
//
//   discover-entities.mjs  --out    defaulted to <estate-root>/.estate-map/entity-discovery
//   loop-driver.mjs        --state  defaulted to <estate-root>/.estate-map/loop
//
// That is not hypothetical damage. A `.estate-map/` directory (including a 32 MB
// map.html and an OPERATION-LOG.md) already existed inside a NEIGHBOURING estate
// before the 2026-07-26 portability probe started, because an earlier run took the
// defaults and wrote into a repository this tool had no authority over. A foreign
// estate is EVIDENCE. Writing into it corrupts the measurement (a later scan reads
// the earlier scan's leavings) and mutates a tree nobody authorized it to touch.
//
// TWO MECHANISMS, DELIBERATELY SEPARATE:
//
//   1. defaultOutputRoot() — no output default may land inside a scanned tree.
//      This removes the FOOT-GUN.
//   2. assertWritable() / guardedFs — every write in tools/estate-map/** goes
//      through a proxy that refuses a path under a registered scan root and throws
//      with code ASCRYBE_READONLY_VIOLATION. This removes the CLASS.
//
// (1) alone is not enough: an operator can still pass `--out <estate>/x` by hand,
// and a future tool can still invent a new estate-relative default. (2) alone is
// not enough: with no safe default, every invocation needs an explicit flag and
// the common path stays dangerous. Both are required.
//
// NO BYPASS. There is intentionally no `--allow-write-inside-scan-root` escape
// hatch and no env override that disarms the guard. An escape hatch is what a
// future run reaches for at 2am to make a red gate green, which is precisely the
// failure this file exists to make impossible. If output belongs somewhere, that
// somewhere is outside the tree being measured.
import fsPromises from 'node:fs/promises';
import { createWriteStream as nodeCreateWriteStream, realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const READONLY_VIOLATION_CODE = 'ASCRYBE_READONLY_VIOLATION';

// Scan roots may be registered in-process (a tool parsed its own estate argument)
// or inherited from the environment. The env channel is what the multi-estate
// harness uses: it exports the foreign estate root before spawning EVERY tool, so
// even a tool that never parses an estate root — merge, annotate, index, query —
// is covered without each one growing an --estate flag it does not otherwise need.
export const SCAN_ROOT_ENV = 'ASCRYBE_SCAN_ROOT';
// Where output goes when a tool has no explicit --out. Deliberately user-scoped and
// durable rather than $TMPDIR: loop-driver's refusal state machine carries
// first_observed_at across iterations, so a state dir that evaporates on reboot
// would silently reset every refusal age to zero.
export const OUT_ROOT_ENV = 'ASCRYBE_OUT_ROOT';

const registered = new Map();

const asAbsolute = value => path.resolve(String(value));

function envScanRoots() {
  const raw = process.env[SCAN_ROOT_ENV];
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).map(value => [asAbsolute(value), `env:${SCAN_ROOT_ENV}`]);
}

/**
 * Resolve symlinks as far as the path actually exists, then re-attach the
 * not-yet-existing tail. Without this, `<estate>/link-to-elsewhere/out.json`
 * and `/tmp/link-to-estate/out.json` both defeat a plain string-prefix check —
 * the first by false positive, the second by false negative.
 */
function realpathOfNearestExistingAncestor(target) {
  let current = asAbsolute(target);
  const tail = [];
  for (;;) {
    try { return tail.length ? path.join(realpathSync(current), ...tail) : realpathSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') return asAbsolute(target);
      const parent = path.dirname(current);
      if (parent === current) return asAbsolute(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

const contains = (root, target) => target === root || target.startsWith(root + path.sep);

export function registerScanRoot(root, { registeredBy = 'unknown' } = {}) {
  const resolved = realpathOfNearestExistingAncestor(root);
  if (!registered.has(resolved)) registered.set(resolved, registeredBy);
  return resolved;
}

export function clearScanRoots() { registered.clear(); }

export function scanRootsInEffect() {
  const all = new Map(registered);
  for (const [root, source] of envScanRoots()) {
    const resolved = realpathOfNearestExistingAncestor(root);
    if (!all.has(resolved)) all.set(resolved, source);
  }
  return [...all.entries()].map(([root, registeredBy]) => ({ root, registeredBy })).sort((a, b) => a.root.localeCompare(b.root));
}

/** The scan root a write target falls inside, or null. */
export function scanRootContaining(target) {
  const resolved = realpathOfNearestExistingAncestor(target);
  return scanRootsInEffect().find(entry => contains(entry.root, resolved)) || null;
}

export function assertWritable(target, { op = 'write', tool = path.basename(process.argv[1] || 'estate-map') } = {}) {
  const violated = scanRootContaining(target);
  if (!violated) return asAbsolute(target);
  const resolved = realpathOfNearestExistingAncestor(target);
  const error = new Error([
    `READ-ONLY VIOLATION: ${tool} tried to ${op} inside the estate it is scanning.`,
    `  target    ${resolved}`,
    `  scan root ${violated.root}  (registered by ${violated.registeredBy})`,
    '',
    'A scanned estate is EVIDENCE and is strictly read-only. Writing into it both',
    'mutates a tree this tool has no authority over and contaminates the next scan,',
    "which would read the previous scan's own output back as estate content.",
    '',
    `Fix: pass an explicit output path outside ${violated.root}, or leave the flag off`,
    `and accept the default under ${outputRootBase()}.`,
  ].join('\n'));
  error.code = READONLY_VIOLATION_CODE;
  error.target = resolved;
  error.scanRoot = violated.root;
  error.op = op;
  error.tool = tool;
  throw error;
}

export function outputRootBase() {
  if (process.env[OUT_ROOT_ENV]) return asAbsolute(process.env[OUT_ROOT_ENV]);
  if (process.env.XDG_STATE_HOME) return path.join(asAbsolute(process.env.XDG_STATE_HOME), 'estate-map');
  const home = os.homedir();
  if (home && home !== '/') return path.join(home, '.local', 'state', 'estate-map');
  return path.join(os.tmpdir(), 'estate-map');
}

/**
 * The default output directory for a scan of `scanRoot`. Outside the estate, and
 * STABLE for a given estate so successive iterations find their prior state. The
 * hash suffix keeps two estates with the same basename (a repo and its worktree)
 * from colliding.
 */
export function defaultOutputRoot(scanRoot, subdir = '') {
  const resolved = realpathOfNearestExistingAncestor(scanRoot);
  const slug = `${path.basename(resolved) || 'estate'}-${crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8)}`;
  const base = path.join(outputRootBase(), slug);
  const out = subdir ? path.join(base, subdir) : base;
  // Defence in depth: if somebody points ASCRYBE_OUT_ROOT inside the estate,
  // fail here rather than quietly producing a "safe default" that is not safe.
  return assertWritable(out, { op: 'use as default output directory', tool: 'readonly-guard' });
}

// Map of fs write operations to the argument positions that name a path. `open` is
// conditional: it writes only when the flags request it.
const WRITE_PATH_ARGS = Object.freeze({
  appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1], lchmod: [0], lchown: [0],
  link: [1], lutimes: [0], mkdir: [0], mkdtemp: [0], rename: [0, 1], rm: [0], rmdir: [0],
  symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0],
});
const WRITABLE_OPEN_FLAGS = /[wa+]/;

const pathOf = value => (value && typeof value === 'object' && typeof value.path === 'string' ? value.path
  : value instanceof URL ? value.pathname
    : typeof value === 'string' ? value : null);

function guardArgs(name, args, positions) {
  for (const position of positions) {
    const candidate = pathOf(args[position]);
    if (candidate !== null) assertWritable(candidate, { op: `fs.${name}` });
  }
}

/**
 * A drop-in replacement for the `node:fs/promises` default export. Reads pass
 * straight through; writes are checked first. Implemented as a Proxy rather than a
 * hand-written wrapper so a write method nobody has used yet cannot become an
 * unguarded hole the day somebody reaches for it.
 */
export const guardedFs = new Proxy(fsPromises, {
  get(target, property, receiver) {
    const original = Reflect.get(target, property, receiver);
    if (typeof original !== 'function') return original;
    const name = String(property);
    // `async` is load-bearing, not stylistic. `node:fs/promises` NEVER throws
    // synchronously -- it returns a rejected promise -- so a synchronous throw here would
    // break every caller that handles failure with `.catch()` rather than `try`, and would
    // turn a guarded write into an uncatchable crash in exactly the code paths that were
    // written to handle write failure gracefully.
    if (name === 'open') {
      return async function open(...args) {
        const flags = args[1] === undefined ? 'r' : String(args[1]);
        if (WRITABLE_OPEN_FLAGS.test(flags)) guardArgs(name, args, [0]);
        return original.apply(target, args);
      };
    }
    const positions = WRITE_PATH_ARGS[name];
    if (!positions) return original.bind(target);
    return async function guarded(...args) {
      guardArgs(name, args, positions);
      return original.apply(target, args);
    };
  },
});

export function createWriteStream(file, options) {
  assertWritable(pathOf(file) ?? file, { op: 'fs.createWriteStream' });
  return nodeCreateWriteStream(file, options);
}

export default guardedFs;
