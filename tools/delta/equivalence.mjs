// Full-vs-delta equivalence oracle (docs/delta-updatable-estate-maps.md "Equivalence, conservation,
// observability, and rollout", shadow-qualification phase) — file scope only. Given a full-mode
// build and a delta-mode build over the SAME immutable fixture inputs, proves equal semantic
// content while permitting different execution provenance; a divergence is a typed
// `DELTA_FULL_MISMATCH` refusal retained as a diagnostic, never a promotion.
import { identityError } from './identity.mjs';

export const DELTA_FULL_MISMATCH_CODE = 'DELTA_FULL_MISMATCH';

/** The observation_id/record_digest multiset over one build's admissible (non-refused) records. */
export function observationRecordMultiset(plan) {
  const pairs = [];
  for (const receipt of plan.receipts) {
    if (receipt.disposition.kind === 'refused') continue;
    for (const record of receipt.output.records) pairs.push(`${record.observation_id}\u0000${record.record_digest}`);
  }
  return pairs.sort();
}

/**
 * `full`/`delta` are each `{manifest, plan}` from tools/delta/manifest.mjs
 * assembleEstateBuildManifest and tools/delta/planner.mjs planDeltaUnits. Never re-derives "same
 * immutable inputs" itself beyond the cheap files_digest guard below — that precondition is the
 * caller's responsibility, matching the design's `--equivalence required` contract of running both
 * modes from the same immutable source.
 */
export function compareFullAndDeltaBuilds({ full, delta }) {
  if (!full?.manifest || !full?.plan || !delta?.manifest || !delta?.plan) {
    throw identityError('DELTA_EQUIVALENCE_INPUT_INVALID', 'full.{manifest,plan} and delta.{manifest,plan} are required');
  }
  if (full.manifest.inventory.files_digest !== delta.manifest.inventory.files_digest) {
    throw identityError('DELTA_EQUIVALENCE_INPUT_INVALID',
      'full and delta builds do not share the same immutable file inventory; equivalence is not meaningful over different inputs');
  }

  const fullMultiset = observationRecordMultiset(full.plan);
  const deltaMultiset = observationRecordMultiset(delta.plan);
  const semanticEqual = full.manifest.semantic_content_digest === delta.manifest.semantic_content_digest;
  const multisetEqual = fullMultiset.length === deltaMultiset.length
    && fullMultiset.every((pair, index) => pair === deltaMultiset[index]);

  if (semanticEqual && multisetEqual) {
    return Object.freeze({ status: 'equivalent', promotable: true });
  }
  const fullSet = new Set(fullMultiset);
  const deltaSet = new Set(deltaMultiset);
  return Object.freeze({
    status: 'delta_full_mismatch',
    code: DELTA_FULL_MISMATCH_CODE,
    promotable: false,
    diagnostic: Object.freeze({
      semantic_content_digest_equal: semanticEqual,
      observation_record_multiset_equal: multisetEqual,
      full_semantic_content_digest: full.manifest.semantic_content_digest,
      delta_semantic_content_digest: delta.manifest.semantic_content_digest,
      only_in_full: fullMultiset.filter(pair => !deltaSet.has(pair)),
      only_in_delta: deltaMultiset.filter(pair => !fullSet.has(pair)),
    }),
  });
}
