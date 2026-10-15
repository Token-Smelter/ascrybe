// Per-unit extraction cache reuse (docs/delta-updatable-estate-maps.md, Extraction Unit Receipt v1
// "A cache hit requires receipt self-digest, exact declared scope-input identities, all payload
// digests, output partition completeness, and the applicable producer contract; reuse additionally
// requires a new scope-discriminated current-build membership binding.").
//
// This replaces tools/extraction-cache.mjs's whole-estate-Git-head keying
// (tools/extraction-cache.mjs:58-85 buildExtractionCacheBinding/extractionCacheBindingForInputs)
// with a key scoped to exactly one payload_unit_id, so a change to one file invalidates only the
// units routed to it. It deliberately does not touch tools/extraction-cache.mjs itself: that
// module is a live producer for tools/code-grounded-assertions.mjs's paid-claim cache and is out
// of this task's scope (no promotion/CAS/GC/retention behavior changes).
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { stableStringify } from '../lib.mjs';
import { identityError } from './identity.mjs';
import { recomputeAndValidateReceipt, relabelDisposition } from './extraction-unit.mjs';

const canonical = value => stableStringify(value).trim();
const RECEIPT_FILE = 'receipt.json';
const REUSABLE_DISPOSITIONS = Object.freeze(['produced', 'reused_exact', 'migrated']);

function unitCacheKey(unitId) {
  const match = /^unit:([0-9a-f]{64})$/u.exec(unitId || '');
  if (!match) throw identityError('DELTA_UNIT_ID_INVALID', 'unit_id must be "unit:<64-hex>"');
  return match[1];
}
function unitDir(cacheRoot, unitId) {
  return join(resolve(cacheRoot), unitCacheKey(unitId));
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireLock(lockPath, timeoutMs, retryMs) {
  const started = Date.now();
  while (true) {
    try { mkdirSync(lockPath); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw identityError('CACHE_UNIT_LOCK_TIMEOUT', `unit cache lock timed out after ${timeoutMs}ms`);
      sleep(retryMs);
    }
  }
}
/** Move a corrupt/invalid cache object aside by its own path; never edit it in place. */
function quarantine(dir) {
  const target = `${dir}.quarantined.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try { renameSync(dir, target); return target; } catch { rmSync(dir, { recursive: true, force: true }); return null; }
}

/**
 * Read and fully validate a stored unit receipt. Never trusts stored digests: recomputes every
 * formula field from the receipt's own declared bytes (tools/delta/extraction-unit.mjs
 * recomputeAndValidateReceipt). A truncated, edited, or otherwise corrupt entry is quarantined and
 * reported as a miss — it is never repaired in place and never silently accepted.
 */
export function readUnitCacheEntry(cacheRoot, unitId) {
  const dir = unitDir(cacheRoot, unitId);
  const receiptPath = join(dir, RECEIPT_FILE);
  if (!existsSync(receiptPath)) return { status: 'miss', reason: 'absent' };
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch (error) { return { status: 'miss', reason: 'cache_corrupt', detail: error.message, quarantined_to: quarantine(dir) }; }
  try { recomputeAndValidateReceipt(receipt); }
  catch (error) { return { status: 'miss', reason: 'cache_corrupt', code: error.code, quarantined_to: quarantine(dir) }; }
  if (receipt.unit_id !== unitId) return { status: 'miss', reason: 'cache_corrupt', quarantined_to: quarantine(dir) };
  if (!REUSABLE_DISPOSITIONS.includes(receipt.disposition?.kind)) return { status: 'miss', reason: 'not_reusable_disposition' };
  if (receipt.output?.complete !== true) return { status: 'miss', reason: 'incomplete_output' };
  return { status: 'hit', receipt };
}

/**
 * Publish exactly one validated receipt under its own unit_id. An entry that already exists is
 * never overwritten in place: if it is itself valid, this is a no-op; if it is corrupt,
 * readUnitCacheEntry has already quarantined it and this writes a fresh one.
 */
export function writeUnitCacheEntry(cacheRoot, receipt, {
  lock_timeout_ms: lockTimeoutMs = 30_000, lock_retry_ms: lockRetryMs = 25,
} = {}) {
  recomputeAndValidateReceipt(receipt);
  const root = resolve(cacheRoot);
  mkdirSync(root, { recursive: true });
  const dir = unitDir(root, receipt.unit_id);
  const lockPath = `${dir}.lock`;
  acquireLock(lockPath, lockTimeoutMs, lockRetryMs);
  try {
    if (existsSync(join(dir, RECEIPT_FILE))) {
      const existing = readUnitCacheEntry(root, receipt.unit_id);
      if (existing.status === 'hit') return Object.freeze({ path: dir, written: false });
      // existing entry was corrupt and is already quarantined by the read above; fall through.
    }
    const staging = `${dir}.${process.pid}.${Date.now()}.staging`;
    mkdirSync(staging, { recursive: true });
    try {
      writeFileSync(join(staging, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
      renameSync(staging, dir);
      return Object.freeze({ path: dir, written: true });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Attempt exact reuse of one unit against the CURRENT, freshly recomputed `unit_id`/`inputs` for
 * that file/extractor pair. Returns `{status:'hit', receipt, original_receipt}` where `receipt`
 * carries disposition `reused_exact` and IDENTICAL `output`/records to `original_receipt` (the
 * original producer's provenance and record_digest are preserved byte-for-byte — see
 * tools/delta/extraction-unit.mjs relabelDisposition), or `{status:'miss', reason}` when the
 * object is absent, corrupt, or the exact declared inputs no longer match.
 */
export function tryReuseUnit(cacheRoot, { unit_id: unitId, inputs }) {
  const entry = readUnitCacheEntry(cacheRoot, unitId);
  if (entry.status !== 'hit') return entry;
  const stored = entry.receipt;
  if (canonical(stored.inputs) !== canonical(inputs)) {
    return { status: 'miss', reason: 'input_mismatch' };
  }
  const reused = relabelDisposition(stored, {
    kind: 'reused_exact', source_receipt_digest: stored.receipt_digest,
    compatibility_receipt_digest: null, migration_receipt_digest: null,
  });
  return { status: 'hit', receipt: reused, original_receipt: stored };
}
