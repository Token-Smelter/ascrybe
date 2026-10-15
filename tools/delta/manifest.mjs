// Estate Build Manifest v1 (docs/delta-updatable-estate-maps.md "Estate Build Manifest v1") — file
// scope only. Assembles a planner's output (tools/delta/planner.mjs planDeltaUnits) into the
// complete manifest, enforcing every conservation identity from the design's "Equivalence,
// conservation, observability, and rollout" disjoint-set table as an explicit, non-throwing check
// so a seeded violation is recorded rather than crashing assembly — the manifest it produces is
// always written, but marked diagnostic-only and never promotable.
import { sha256, stableStringify } from '../lib.mjs';
import {
  identityError, buildScopeDigest, fileCurrentScopeBinding, buildMembershipBinding,
  semanticContentDigest, buildId as computeBuildId,
} from './identity.mjs';
import { DISPOSITION_KINDS } from './extraction-unit.mjs';
import { validateUnitTotality } from './planner.mjs';
import { scopeRefusalSentinel } from './scope-refusals.mjs';

export const ESTATE_BUILD_MANIFEST_SCHEMA = 'estate-map/estate-build-manifest/v1';
const canonical = value => stableStringify(value).trim();
const pathKey = entry => `${entry.repository}\u0000${entry.normalized_path}`;

/**
 * expected_units = produced ⊎ reused_exact ⊎ migrated ⊎ refused
 * "A manifest with ... a nonterminal expected unit ... is diagnostic-only."
 */
export function checkUnitTotality(expectedUnits, receipts) {
  try { validateUnitTotality({ expected_units: expectedUnits, receipts }); return Object.freeze({ id: 'unit_totality', ok: true }); }
  catch (error) { return Object.freeze({ id: 'unit_totality', ok: false, violation_code: error.code, violation: error.message }); }
}

/**
 * inventoried_paths = added ⊎ unchanged ⊎ modified (⊎ renamed_target, folded into added; rename
 * continuity is not implemented — tools/delta/scope-refusals.mjs)
 * parent_paths = unchanged ⊎ modified ⊎ deleted (⊎ renamed_source, folded into deleted)
 */
export function validatePathPartitions(diff) {
  for (const [name, list] of [['added', diff.added], ['unchanged', diff.unchanged], ['modified', diff.modified], ['deleted', diff.deleted]]) {
    const keys = list.map(pathKey);
    if (new Set(keys).size !== keys.length) {
      throw identityError('DELTA_CONSERVATION_VIOLATION_PATH_PARTITION', `${name} contains a duplicate path`, { group: name });
    }
  }
  const inventoried = [...diff.added, ...diff.unchanged, ...diff.modified].map(pathKey);
  if (new Set(inventoried).size !== inventoried.length) {
    throw identityError('DELTA_CONSERVATION_VIOLATION_PATH_PARTITION', 'inventoried_paths (added/unchanged/modified) are not disjoint');
  }
  const parentPaths = [...diff.unchanged, ...diff.modified, ...diff.deleted].map(pathKey);
  if (new Set(parentPaths).size !== parentPaths.length) {
    throw identityError('DELTA_CONSERVATION_VIOLATION_PATH_PARTITION', 'parent_paths (unchanged/modified/deleted) are not disjoint');
  }
  return true;
}
export function checkPathPartitions(diff) {
  try { validatePathPartitions(diff); return Object.freeze({ id: 'path_partitions', ok: true }); }
  catch (error) { return Object.freeze({ id: 'path_partitions', ok: false, violation_code: error.code, violation: error.message }); }
}

/** |build observation IDs| = |unique build observation IDs|, over every admissible (non-refused) unit's records. */
export function validateObservationIdUniqueness(receipts) {
  const ids = [];
  for (const receipt of receipts) {
    if (receipt?.disposition?.kind === 'refused') continue;
    for (const record of receipt?.output?.records ?? []) ids.push(record.observation_id);
  }
  if (new Set(ids).size !== ids.length) {
    throw identityError('DELTA_CONSERVATION_VIOLATION_OBSERVATION_ID_DUPLICATE',
      'build observation IDs are not unique', { count: ids.length, unique: new Set(ids).size });
  }
  return ids;
}
export function checkObservationIdUniqueness(receipts) {
  try { const ids = validateObservationIdUniqueness(receipts); return Object.freeze({ id: 'observation_id_uniqueness', ok: true, count: ids.length }); }
  catch (error) { return Object.freeze({ id: 'observation_id_uniqueness', ok: false, violation_code: error.code, violation: error.message }); }
}

function admissibleReceipts(receipts) {
  return receipts.filter(receipt => DISPOSITION_KINDS.includes(receipt?.disposition?.kind) && receipt.disposition.kind !== 'refused');
}

/**
 * Assemble the complete Estate Build Manifest from one planner run. `source` = {pin_manifest_digest,
 * materialization_receipt_digest, pins: {repository: source_pin}}. `planner` = {version,
 * producer_registry_digest, parent_build_id}. `configuration_digest`/`runtime_digest`/
 * `policy_digest` are the caller's declared build-scope dependency digests.
 *
 * This ALWAYS returns a manifest object (never throws on a conservation violation): every identity
 * check runs non-fatally and is recorded in `completeness`. `completeness.status` is `'complete'`
 * only when every check passed; otherwise it is `'diagnostic'` and `promotable` is `false` — the
 * seeded-violation contract this module exists to prove.
 */
export function assembleEstateBuildManifest({
  source, plan, planner, configuration_digest: configurationDigest, runtime_digest: runtimeDigest, policy_digest: policyDigest,
}) {
  if (!source?.pins) throw identityError('DELTA_MANIFEST_INPUT_INVALID', 'source.pins is required');
  if (!plan?.diff || !Array.isArray(plan.expected_units) || !Array.isArray(plan.receipts)) {
    throw identityError('DELTA_MANIFEST_INPUT_INVALID', 'plan.diff, plan.expected_units, and plan.receipts are required');
  }

  const checks = [
    checkUnitTotality(plan.expected_units, plan.receipts),
    checkPathPartitions(plan.diff),
    checkObservationIdUniqueness(plan.receipts),
  ];
  const conservationResult = Object.freeze({
    schema: 'estate-map/delta-conservation-result/v1', checks, status: checks.every(check => check.ok) ? 'complete' : 'violated',
  });

  const partitions = { produced: [], reused_exact: [], migrated: [], refused: [] };
  for (const receipt of plan.receipts) {
    const kind = receipt?.disposition?.kind;
    if (partitions[kind]) partitions[kind].push(receipt.unit_id);
  }
  const admissible = admissibleReceipts(plan.receipts);

  const normalizedInventory = plan.current_files
    .map(file => ({
      repository: file.repository, normalized_path: file.normalized_path,
      source_pin: source.pins[file.repository] ?? null, blob_oid: file.blob_oid, content_sha256: file.content_sha256,
    }))
    .sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
  const routingContracts = [...new Set(plan.receipts.map(receipt => receipt.extractor?.routing_contract_digest).filter(Boolean))].sort();
  const extractorContracts = [...new Map(plan.receipts.map(receipt => [canonical(receipt.extractor), receipt.extractor])).values()]
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));

  const buildScopeDigestValue = buildScopeDigest({
    canonical_pins: source.pins, normalized_inventory: normalizedInventory, routing_contracts: routingContracts,
    extractor_contracts: extractorContracts, configuration_digest: configurationDigest, runtime_digest: runtimeDigest, policy_digest: policyDigest,
  });

  const memberships = admissible.map(receipt => {
    const currentScopeBinding = fileCurrentScopeBinding({
      repository: receipt.scope.repository, normalized_path: receipt.scope.normalized_path,
      current_source_pin: source.pins[receipt.scope.repository], blob_oid: receipt.scope.blob_oid, content_sha256: receipt.scope.content_sha256,
    });
    const bindingDigest = buildMembershipBinding({
      build_scope_digest: buildScopeDigestValue, payload_unit_id: receipt.unit_id, current_scope_binding: currentScopeBinding,
    });
    return { payload_unit_id: receipt.unit_id, current_scope_binding: currentScopeBinding, binding_digest: bindingDigest };
  }).sort((left, right) => left.payload_unit_id.localeCompare(right.payload_unit_id));

  const observationRecordPairs = [];
  const kindCounts = {};
  for (const receipt of admissible) {
    for (const record of receipt.output.records) {
      observationRecordPairs.push([record.observation_id, record.record_digest]);
      kindCounts[record.identity.observation_kind] = (kindCounts[record.identity.observation_kind] || 0) + 1;
    }
  }
  observationRecordPairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const observationIds = observationRecordPairs.map(pair => pair[0]);

  const files = plan.current_files.map(file => ({
    repository: file.repository, normalized_path: file.normalized_path, source_pin: source.pins[file.repository] ?? null,
    blob_oid: file.blob_oid, content_sha256: file.content_sha256,
  })).sort((left, right) => pathKey(left).localeCompare(pathKey(right)));

  const inventory = {
    files, files_digest: sha256(canonical(files)),
    deleted_since_parent: plan.diff.deleted.map(entry => ({ repository: entry.repository, normalized_path: entry.normalized_path })),
    renamed_since_parent: [], // rename continuity is not implemented (tools/delta/scope-refusals.mjs); always empty by design, never inferred.
  };

  const unitsBlock = {
    expected: plan.expected_units.map(unit => unit.unit_id).sort(),
    produced: partitions.produced.sort(), reused_exact: partitions.reused_exact.sort(),
    migrated: partitions.migrated.sort(), refused: partitions.refused.sort(),
    receipts_digest: sha256(canonical([...plan.receipts].sort((left, right) => left.receipt_digest.localeCompare(right.receipt_digest)).map(receipt => receipt.receipt_digest))),
  };

  const recordsBlock = {
    observation_ids_digest: sha256(canonical(observationIds)),
    observation_record_pairs_digest: sha256(canonical(observationRecordPairs)),
    kind_counts: kindCounts,
  };

  // Repository-scope units, global-scope units, deterministic migration, rename continuity, and
  // paid-answer/campaign reuse are all out of scope (tools/delta/scope-refusals.mjs). Empty
  // global_unit_receipts is a STRUCTURAL fact (this planner never routes to a global-scope
  // extractor), not a computed-and-verified-empty claim; the digests below are typed absence
  // sentinels, never a value that could be misread as "verified empty output".
  const downstream = {
    global_unit_receipts: [],
    campaign_receipt_digest: scopeRefusalSentinel('paid_answer_campaign_reuse'),
    // `ascrybe update` exists (tools/delta-update-run.mjs) but never binds a projection; that
    // absence, not the CLI verb itself, is what this sentinel now names.
    projection_input_digest: scopeRefusalSentinel('ascrybe_update_projection_publish'),
  };

  const sortedMembershipBindings = memberships.map(membership => membership.binding_digest).sort();
  const semanticContentDigestValue = semanticContentDigest({
    build_scope_digest: buildScopeDigestValue,
    sorted_build_membership_bindings: sortedMembershipBindings,
    observation_record_pairs: observationRecordPairs,
    global_outputs: scopeRefusalSentinel('global_scope_units'),
    claim_outputs: scopeRefusalSentinel('paid_answer_campaign_reuse'),
    projection_content_digest: scopeRefusalSentinel('ascrybe_update_projection_publish'),
    conservation_result: conservationResult,
  });
  const buildIdValue = computeBuildId(semanticContentDigestValue);

  const executionProvenanceDigest = sha256(canonical({
    dispositions: [...plan.receipts].sort((left, right) => left.unit_id.localeCompare(right.unit_id))
      .map(receipt => ({ unit_id: receipt.unit_id, disposition: receipt.disposition, receipt_digest: receipt.receipt_digest })),
  }));
  const executionId = `build-execution:${executionProvenanceDigest}`;

  const status = conservationResult.status === 'complete' ? 'complete' : 'diagnostic';
  const completeness = {
    status, conservation_receipt_digest: sha256(canonical(conservationResult)),
    violations: checks.filter(check => !check.ok).map(check => ({ check: check.id, code: check.violation_code, detail: check.violation })),
  };

  const body = {
    schema: ESTATE_BUILD_MANIFEST_SCHEMA,
    build_id: buildIdValue,
    execution_id: executionId,
    source,
    inventory,
    memberships,
    planner,
    units: unitsBlock,
    records: recordsBlock,
    downstream,
    completeness,
    semantic_content_digest: semanticContentDigestValue,
    execution_provenance_digest: executionProvenanceDigest,
  };
  return Object.freeze({
    ...body, manifest_digest: sha256(canonical(body)),
    // Additive field beyond the design's literal JSON shape: a manifest whose completeness.status
    // is anything but 'complete' is never promotable input to projection, staging, or CAS. This
    // implementation exposes that gate explicitly rather than requiring every caller to recompute
    // `completeness.status === 'complete'` for itself.
    promotable: status === 'complete',
  });
}
