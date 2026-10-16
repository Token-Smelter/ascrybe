// Delta planner (docs/delta-updatable-estate-maps.md "Delta planner, publication, recovery, and
// collection", steps 1-2) — file scope only. Diffs a parent inventory against the current one into
// added/unchanged/modified/deleted, resolves routing against a caller-supplied extractor registry,
// and enumerates the exhaustive expected unit set. Repository- and global-scope units, and
// deterministic migration, are out of scope (tools/delta/scope-refusals.mjs); a rename is always
// delete-plus-add (tools/delta/scope-refusals.mjs requestRenameContinuity), matching
// docs/delta-updatable-estate-maps.md: "A rename is always delete-plus-add because normalized_path
// is part of observation_id."
import { identityError } from './identity.mjs';
import {
  DISPOSITION_KINDS, buildProducedFileUnitReceipt, buildRefusedFileUnitReceipt, fileUnitIdentity,
} from './extraction-unit.mjs';
import { tryReuseUnit, writeUnitCacheEntry } from './unit-cache.mjs';

const fileKey = entry => `${entry.repository}\u0000${entry.normalized_path}`;
const byFileKey = (left, right) => fileKey(left).localeCompare(fileKey(right));

/**
 * inventoried_paths = added_paths ⊎ unchanged_paths ⊎ modified_paths (renamed_target_paths folded
 * into added, since rename continuity is not implemented)
 * parent_paths = unchanged_paths ⊎ modified_paths ⊎ deleted_paths (renamed_source_paths folded
 * into deleted, for the same reason)
 */
export function diffInventories(parentInventory, currentInventory) {
  const parentByKey = new Map(parentInventory.map(entry => [fileKey(entry), entry]));
  const currentByKey = new Map(currentInventory.map(entry => [fileKey(entry), entry]));
  const added = [];
  const unchanged = [];
  const modified = [];
  for (const [key, current] of currentByKey) {
    const parent = parentByKey.get(key);
    if (!parent) { added.push(current); continue; }
    if (parent.blob_oid === current.blob_oid && parent.content_sha256 === current.content_sha256) unchanged.push(current);
    else modified.push(current);
  }
  const deleted = [...parentByKey.entries()].filter(([key]) => !currentByKey.has(key)).map(([, entry]) => entry);
  // Advisory only. "A rename is always delete-plus-add by default": this list is never consulted
  // to preserve an observation_id or skip re-extraction; it exists purely so a reader can see what
  // the planner treated as an unrelated delete plus an unrelated add.
  const renameCandidates = [];
  for (const addedEntry of added) {
    for (const deletedEntry of deleted) {
      if (addedEntry.repository === deletedEntry.repository && addedEntry.content_sha256 === deletedEntry.content_sha256) {
        renameCandidates.push(Object.freeze({ from: deletedEntry, to: addedEntry }));
      }
    }
  }
  return Object.freeze({
    added: added.sort(byFileKey), unchanged: unchanged.sort(byFileKey), modified: modified.sort(byFileKey),
    deleted: deleted.sort(byFileKey), rename_candidates: Object.freeze(renameCandidates),
  });
}

/**
 * Every expected unit must carry exactly one terminal disposition from
 * {produced, reused_exact, migrated, refused}, and every receipt must belong to the expected set.
 * Fails closed with a typed error code on the first violation found; never returns a partial or
 * best-effort verdict.
 */
export function validateUnitTotality({ expected_units: expectedUnits, receipts }) {
  const expectedIds = expectedUnits.map(unit => (typeof unit === 'string' ? unit : unit.unit_id));
  if (new Set(expectedIds).size !== expectedIds.length) {
    throw identityError('DELTA_PLANNER_DUPLICATE_EXPECTED_UNIT', 'expected unit set contains a duplicate unit_id');
  }
  const expectedSet = new Set(expectedIds);
  const countByUnit = new Map();
  for (const receipt of receipts) {
    const kind = receipt?.disposition?.kind;
    if (!DISPOSITION_KINDS.includes(kind)) {
      throw identityError('DELTA_PLANNER_NONTERMINAL_DISPOSITION',
        `receipt for ${receipt?.unit_id ?? '(unknown unit)'} has a nonterminal or missing disposition`, { unit_id: receipt?.unit_id, kind });
    }
    countByUnit.set(receipt.unit_id, (countByUnit.get(receipt.unit_id) || 0) + 1);
  }
  for (const [unitId, count] of countByUnit) {
    if (count > 1) {
      throw identityError('DELTA_PLANNER_DUPLICATE_DISPOSITION',
        `unit ${unitId} has ${count} receipts; exactly one terminal disposition is required`, { unit_id: unitId, count });
    }
  }
  const receiptUnitIds = new Set(countByUnit.keys());
  const missing = expectedIds.filter(id => !receiptUnitIds.has(id));
  if (missing.length) {
    throw identityError('DELTA_PLANNER_MISSING_DISPOSITION',
      `expected unit(s) absent from receipts: ${missing.join(', ')}`, { missing });
  }
  const extra = [...receiptUnitIds].filter(id => !expectedSet.has(id));
  if (extra.length) {
    throw identityError('DELTA_PLANNER_UNEXPECTED_UNIT',
      `receipt(s) exist for unit(s) outside the expected set: ${extra.join(', ')}`, { extra });
  }
  return true;
}

/**
 * `registry` is an array of `{extractor, matches(normalized_path), produce(fileEntry)}` routes.
 * `produce` returns an array of raw records (see extraction-unit.mjs buildProducedFileUnitReceipt),
 * or `{refused: true, reason_code, reason}` when no usable output exists, or may throw (caught and
 * turned into a `refused` receipt carrying the thrown `error.code`/`error.message`).
 *
 * When `cache_root` is given, exact per-unit reuse (tools/delta/unit-cache.mjs) is attempted
 * before every fresh `produce` call, and every freshly produced receipt is published back to the
 * cache for the next plan.
 */
export function planDeltaUnits({
  parent_inventory: parentInventory = [], current_inventory: currentInventory, registry, cache_root: cacheRoot = null,
}) {
  if (!Array.isArray(currentInventory)) throw identityError('DELTA_PLANNER_INPUT_INVALID', 'current_inventory is required');
  if (!Array.isArray(registry) || !registry.length) throw identityError('DELTA_PLANNER_INPUT_INVALID', 'a non-empty extractor registry is required');

  const diff = diffInventories(parentInventory, currentInventory);
  const currentFiles = [...diff.added, ...diff.unchanged, ...diff.modified].sort(byFileKey);

  const expectedUnits = [];
  const receipts = [];
  for (const file of currentFiles) {
    const routes = registry.filter(route => route.matches(file.normalized_path));
    for (const route of routes) {
      const identity = fileUnitIdentity({ ...file, extractor: route.extractor });
      expectedUnits.push({
        unit_id: identity.unit_id, repository: file.repository, normalized_path: file.normalized_path, extractor_id: route.extractor.id,
      });

      let receipt = null;
      if (cacheRoot) {
        const reuse = tryReuseUnit(cacheRoot, { unit_id: identity.unit_id, inputs: identity.inputs });
        if (reuse.status === 'hit') receipt = reuse.receipt;
      }
      if (!receipt) {
        let outcome;
        let thrown = null;
        try { outcome = route.produce(file); }
        catch (error) { thrown = error; }
        if (thrown) {
          receipt = buildRefusedFileUnitReceipt({
            ...file, extractor: route.extractor, reason_code: thrown.code || 'DELTA_PRODUCER_THREW', reason: thrown.message,
          });
        } else if (outcome && outcome.refused) {
          receipt = buildRefusedFileUnitReceipt({
            ...file, extractor: route.extractor, reason_code: outcome.reason_code, reason: outcome.reason,
          });
        } else {
          receipt = buildProducedFileUnitReceipt({ ...file, extractor: route.extractor, records: outcome || [] });
          if (cacheRoot) writeUnitCacheEntry(cacheRoot, receipt);
        }
      }
      receipts.push(receipt);
    }
  }
  validateUnitTotality({ expected_units: expectedUnits, receipts });
  return Object.freeze({ diff, current_files: currentFiles, expected_units: expectedUnits, receipts });
}
