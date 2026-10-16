// Explicit, typed refusals for every capability docs/delta-updatable-estate-maps.md describes
// that this file-scope slice does NOT implement. Per the task's scope-honesty requirement:
// none of these may be silently absent, faked as empty-but-verified, or partially implemented.
// Each is either an explicit typed refusal (functions below, callable and tested) or a named
// absence recorded in the run receipt (tools/delta/manifest.mjs `scope_refusals`) and in
// docs/delta-file-scope-implementation-status.md.
import { sha256, stableStringify } from '../lib.mjs';

const canonical = value => stableStringify(value).trim();

export const SCOPE_REFUSALS = Object.freeze([
  Object.freeze({
    capability: 'repository_scope_units',
    reason_code: 'DELTA_REPOSITORY_SCOPE_NOT_IMPLEMENTED',
    reason: 'repository-scope extraction units (identity kind "repository") are not implemented in this file-scope slice',
  }),
  Object.freeze({
    capability: 'global_scope_units',
    reason_code: 'DELTA_GLOBAL_SCOPE_NOT_IMPLEMENTED',
    reason: 'global-scope extraction units (identity kind "global") are not implemented in this file-scope slice',
  }),
  Object.freeze({
    capability: 'deterministic_migrations',
    reason_code: 'DELTA_MIGRATION_NOT_IMPLEMENTED',
    reason: 'deterministic migration/converter receipts are not implemented; a breaking extractor change always re-extracts or refuses, never migrates',
  }),
  Object.freeze({
    capability: 'rename_continuity',
    reason_code: 'DELTA_RENAME_CONTINUITY_NOT_IMPLEMENTED',
    reason: 'a rename is delete-plus-add only; no rename matcher or supersedes receipt is implemented',
  }),
  Object.freeze({
    capability: 'paid_answer_campaign_reuse',
    reason_code: 'DELTA_PAID_ANSWER_REUSE_NOT_IMPLEMENTED',
    reason: 'paid-answer/campaign reuse and paid_request_identity are not implemented; this slice is deterministic file-scope extraction only',
  }),
  // `ascrybe update` now exists (bin/ascrybe.mjs's COMMANDS table, tools/delta-update-run.mjs) and
  // is a real, tested caller of this library — the OLD `ascrybe_update_cli_verb` refusal below
  // would be dishonest to keep. What still does NOT exist behind that verb is any projection
  // binding, staging, CAS, or promotion: `--promote` is refused (see requestAscrybeUpdateProjectionPublish
  // in tools/delta-update-run.mjs), and this command never changes what a selected/working
  // generation serves. That is the capability this entry now names.
  Object.freeze({
    capability: 'ascrybe_update_projection_publish',
    reason_code: 'DELTA_UPDATE_PROJECTION_PUBLISH_NOT_IMPLEMENTED',
    reason: 'the `ascrybe update` operator command exists and runs the file-scope delta planner, manifest assembly, and equivalence oracle, but never binds a projection, stages a generation, or promotes; --promote is a typed refusal',
  }),
]);

const BY_CAPABILITY = new Map(SCOPE_REFUSALS.map(entry => [entry.capability, entry]));

export function scopeRefusal(capability) {
  const entry = BY_CAPABILITY.get(capability);
  if (!entry) throw new Error(`unknown scope-refusal capability: ${capability}`);
  return entry;
}

/** Throws the typed refusal for `capability`. Used by call sites that must refuse rather than fake. */
export function refuseScope(capability, detail) {
  const entry = scopeRefusal(capability);
  const error = new Error(entry.reason);
  error.code = entry.reason_code;
  error.capability = capability;
  if (detail !== undefined) error.detail = detail;
  throw error;
}

/**
 * A deterministic, inspectable 64-hex sentinel for a manifest field the design types as a digest
 * (e.g. downstream.campaign_receipt_digest, semantic_content_digest's global_outputs/claim_outputs)
 * that this slice cannot honestly compute because the capability producing it is out of scope.
 * This is NEVER `sha256(canonical([]))` or another value that could be misread as "verified empty";
 * it commits to the refusal reason itself, so two absent capabilities never collide by accident.
 */
export function scopeRefusalSentinel(capability) {
  const entry = scopeRefusal(capability);
  return sha256(canonical({ status: 'absent', reason_code: entry.reason_code, capability }));
}

export const requestRepositoryScopeUnit = detail => refuseScope('repository_scope_units', detail);
export const requestGlobalScopeUnit = detail => refuseScope('global_scope_units', detail);
export const requestDeterministicMigration = detail => refuseScope('deterministic_migrations', detail);
export const requestRenameContinuity = detail => refuseScope('rename_continuity', detail);
export const requestPaidAnswerReuse = detail => refuseScope('paid_answer_campaign_reuse', detail);
export const requestAscrybeUpdateProjectionPublish = detail => refuseScope('ascrybe_update_projection_publish', detail);
