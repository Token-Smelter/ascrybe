#!/usr/bin/env node
// [EVAL-HARNESS] A diff-evaluation harness for the shared per-unit extraction cache
// (tools/file-extraction-adapter.mjs, tools/extract.mjs, tools/delta-update-run.mjs). Given an
// EXTERNAL, PINNED change-shape case manifest (never committed to this repository — the
// operator's two private estates supply their own real paths/pins/results later, in the owning
// session; see docs/before-a-pr.md), this module runs, for each case:
//
//   1. Materialize the PARENT and CHILD refs ONCE each, through the SAME verified,
//      blob-by-blob-validated Git tree materialization tools/materialize-estate.mjs uses
//      (tools/git-tree-source.mjs materializeExactGitTree) — never a live checkout/stash of the
//      caller's repository, never a raw in-memory git-plumbing read standing in for real files on
//      disk.
//   2. A parent-seeded cache: a FRESH cache_root, warmed by running the REAL ordinary extraction
//      path (tools/extract.mjs extractEstate()) over the materialized PARENT estate once —
//      isolated per case, never reused across cases or from a prior evaluator run.
//   3. A DELTA build: extractEstate() over the materialized CHILD estate, reusing ONLY that
//      parent-seeded cache.
//   4. A forced-uncached FULL build: extractEstate() over the SAME materialized CHILD estate with
//      no cache (the reference the delta build's ACTUAL output is checked against).
//   5. A downstream STRICT merge (tools/merge.mjs mergeFacts(..., {allowPartial:false})) over each
//      of extractEstate()'s own complete facts+_MANIFEST.json output — never a hand-reconstructed
//      subset of records, never an allowPartial/missing-manifest bypass. extractEstate() is the
//      ONE producer of repository/coverage facts and the scanned-file manifest on both call paths
//      (tools/extract.mjs's ordinary CLI and this harness); this harness never patches a
//      substitute repo/coverage record into a gap.
//
// Every stage records wall-clock timing, actual scan-call counts (tools/extract.mjs's own
// _CACHE_TELEMETRY.json — a real per-run receipt, never inferred after the fact), included/excluded
// paths (tools/extract.mjs's own _MANIFEST.json scope_exclusions block), actual rebuilt/reused unit
// ids vs the expected set (derived from validated, non-refused parent receipts — a refused parent
// unit is never reuse-eligible), and missing/extra/stale records at the observation_id/record_digest
// grain. Every case and the whole run carry an explicit pass/fail/incomplete verdict; the CLI exit
// code reflects it. Extraction and merge are the only pipeline stages this harness exercises; it
// makes no claim/binding/projection/quality-coverage assertion.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { extractEstate, discoverRepositories } from '../extract.mjs';
import { materializeExactGitTree } from '../git-tree-source.mjs';
import { buildExtractionRegistry, planFileScopeExtraction, prepareFileEntry } from '../file-extraction-adapter.mjs';
import { diffInventories } from '../delta/planner.mjs';
import { readUnitCacheEntry } from '../delta/unit-cache.mjs';
import { relabelDisposition } from '../delta/extraction-unit.mjs';
import { mergeFacts } from '../merge.mjs';
import { normalizePath, readEstateMapIgnore, walk } from '../lib.mjs';
import { admissibleRecordsFromReceipts, recordDiff, scoreCase } from './case-scorer.mjs';

const now = () => Date.now();

/** The change-shape strata this harness knows how to classify a case under. Selection/freeze must
 * happen BEFORE observing delta results: a case manifest declares its `change_shape` up front;
 * this module never infers or reclassifies one after running. */
export const CANONICAL_CHANGE_SHAPES = Object.freeze([
  'content_edit', 'add', 'delete', 'rename', 'multi_file', 'docs_only', 'ignored_or_unrouted_only', 'large_change', 'chained_update',
]);

// HONESTY NOTE (do not read one as proof of the other): a `chained_update` case here is TWO
// INDEPENDENT isolated parent/child pairs (each `runChangeShapeCase` call below allocates its own
// fresh parent-seeded cache — see step 2 in the module docstring, unconditionally, for every case).
// Running two such cases back to back (hop1's child ref as hop2's parent ref) proves each hop is
// individually correct; it does NOT prove state actually carried from hop1's real extraction into
// hop2, because hop2 reseeds a brand-new cache from hop1's child ref rather than reusing hop1's own
// cache. tools/eval/delta-chain-eval.mjs runChainCase is the artifact that proves genuine carried-
// forward state across an ordered A->B->C sequence under ONE owned, once-seeded cache.
// A change_shape that claims a positive, code-invalidating edit. `ignored_or_unrouted_only` is
// deliberately excluded — it is the honest control for zero routed change, not a case that must
// route.
const POSITIVE_EDIT_SHAPES = Object.freeze(['content_edit', 'add', 'delete', 'rename', 'multi_file', 'large_change', 'chained_update']);

/** Report which canonical strata a case manifest actually covers — never fabricate coverage for a
 * missing one. */
export function summarizeCoverage(cases) {
  const present = new Set(cases.map(entry => entry.change_shape));
  return Object.freeze({
    present: CANONICAL_CHANGE_SHAPES.filter(shape => present.has(shape)),
    missing: CANONICAL_CHANGE_SHAPES.filter(shape => !present.has(shape)),
    unrecognized: [...present].filter(shape => !CANONICAL_CHANGE_SHAPES.includes(shape)).sort(),
  });
}

// Exported so tools/eval/delta-chain-eval.mjs (a genuinely different artifact — see the HONESTY
// NOTE above) can share the exact same scratch-root and ref-resolution behavior instead of
// re-implementing it.
export function scratchBase(workDirRoot) {
  const base = workDirRoot || process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return base;
}

export function resolveRef(repositoryPath, ref) {
  return execFileSync('git', ['-C', repositoryPath, 'rev-parse', ref], { encoding: 'utf8' }).trim();
}

/**
 * Materialize ONE named state (`parent` or `child`) of a case's declared repositories: one exact,
 * blob-validated Git tree per repository (tools/git-tree-source.mjs materializeExactGitTree — the
 * SAME verified materialization tools/materialize-estate.mjs uses), laid out as sibling directories
 * under one estate root so tools/extract.mjs's ordinary component discovery finds them. This never
 * reads or mutates the caller-supplied repository's working tree: only `git rev-parse` (read-only)
 * and the local Git object database are touched.
 */
function materializeState(caseSpec, refKey, workDir, label) {
  const estateRoot = join(workDir, `estate-${label}`);
  mkdirSync(estateRoot, { recursive: true });
  const pins = {};
  for (const [repositoryName, declaration] of Object.entries(caseSpec.repositories)) {
    const sha = resolveRef(declaration.path, declaration[refKey]);
    materializeExactGitTree({ repository: declaration.path, sha, target: join(estateRoot, repositoryName), project_id: repositoryName });
    pins[repositoryName] = sha;
  }
  return Object.freeze({ estateRoot, pins });
}

/** Every current file across every repository a materialized estate's `extractEstate({collectPlans:
 * true})` run actually scanned — the real per-unit plan's own `current_files`, concatenated, never
 * a separately re-walked list. */
function combinedCurrentFiles(plans) {
  return plans.flatMap(entry => entry.plan.current_files);
}
function combinedExpectedUnits(plans) {
  return plans.flatMap(entry => entry.plan.expected_units);
}
function combinedReceipts(plans) {
  return plans.flatMap(entry => entry.plan.receipts);
}

function admissibleRecords(plans) {
  return admissibleRecordsFromReceipts(combinedReceipts(plans));
}

function dispositionCounts(plans) {
  const counts = { produced: 0, reused_exact: 0, migrated: 0, refused: 0 };
  for (const receipt of combinedReceipts(plans)) counts[receipt.disposition.kind] = (counts[receipt.disposition.kind] || 0) + 1;
  return counts;
}
// Preserve source witnesses; do not infer authority from naming conventions alone.
function actualScanInvocations(plans) {
  return plans.reduce((sum, entry) => sum + (entry.scan_invocations ?? 0), 0);
}

function readManifest(extractOutDir) {
  return JSON.parse(readFileSync(join(extractOutDir, '_MANIFEST.json'), 'utf8'));
}

/** A materialized estate's complete extraction-scope input — the SAME shared file adapter
 * (tools/file-extraction-adapter.mjs prepareFileEntry) and component/scan-scope discovery
 * (tools/extract.mjs discoverRepositories, tools/lib.mjs walk) the ordinary extractEstate() call
 * itself uses. Used ONLY by the cache-mechanism controls below, which must manipulate a
 * `cache_root` directly (forge/corrupt a receipt) rather than go through extractEstate()'s own
 * facts+manifest output. */
async function estateCurrentInventory(estateRoot) {
  const ignorePrefixes = await readEstateMapIgnore(estateRoot);
  const discovered = await discoverRepositories(estateRoot, { ignorePrefixes });
  const ready = (discovered.selections || discovered.repos.map(value => ({ ...value, status: 'ready' }))).filter(value => value.status === 'ready');
  const inventory = [];
  for (const item of ready) {
    const { files } = await walk(item.path, { ignorePrefixes, estateRelativeRoot: item.name });
    for (const absolute of files) {
      const file = normalizePath(relative(item.path, absolute));
      const text = await readFile(absolute, 'utf8');
      const documentPath = normalizePath(relative(estateRoot, absolute));
      inventory.push(prepareFileEntry({ repository: item.name, normalized_path: file, text, document_path: documentPath }));
    }
  }
  return inventory;
}

/**
 * Run one downstream merge over an extraction run's OWN complete output (facts/<repo>.jsonl +
 * _MANIFEST.json, exactly as extractEstate() wrote them — never a hand-assembled subset).
 * `allowPartial` is never set: a real gap (missing repo/coverage facts, an incomplete manifest) must
 * fail here, not be waved through. On failure, the FULL conservation report and typed exit code are
 * retained — never reduced to `error.message` alone, which is the exact defect this rewrite fixes.
 */
export async function mergeStage(extractOutDir, workDir, label) {
  const out = join(workDir, `merge-out-${label}`);
  try {
    const graph = await mergeFacts(extractOutDir, out, { allowPartial: false });
    return Object.freeze({
      status: 'ok', digest: readFileSync(join(out, 'digest.txt'), 'utf8').trim(),
      nodes: graph.nodes.length, edges: graph.edges.length,
    });
  } catch (error) {
    return Object.freeze({
      status: 'error', error: error.message, exit_code: error.exitCode ?? null,
      // RETAINED, never discarded: the empirical lead this rewrite fixes was an evaluator that
      // caught this error and kept only `error.message`, throwing away exactly the detail a
      // conservation failure needs to be diagnosable.
      conservation_gates: error.conservationGates ?? null,
    });
  }
}

/**
 * Run one change-shape case end to end. `caseSpec = {name, change_shape, repositories: {repo:
 * {path, parent_ref, child_ref}}, catalog_globs?}`. `repositories[*].path` must be a real,
 * already-materialized Git checkout the caller supplies (this harness never checks one out,
 * stashes, or edits config — docs/multi-repository-documentary-campaigns.md's live-checkout
 * boundary); it reads that checkout's Git OBJECT DATABASE only (`git rev-parse`, then
 * materializeExactGitTree's local object reads), never its working tree.
 */
export async function runChangeShapeCase(caseSpec, { workDirRoot, catalogGlobs = caseSpec.catalog_globs || [] } = {}) {
  if (!caseSpec?.name || !caseSpec?.change_shape || !caseSpec?.repositories || !Object.keys(caseSpec.repositories).length) {
    throw new Error('a case requires name, change_shape, and a non-empty repositories map');
  }
  if (!CANONICAL_CHANGE_SHAPES.includes(caseSpec.change_shape)) {
    throw new Error(`change_shape "${caseSpec.change_shape}" is not one of: ${CANONICAL_CHANGE_SHAPES.join(', ')}`);
  }
  const base = scratchBase(workDirRoot);
  const workDir = mkdtempSync(join(base, `delta-shape-eval-${caseSpec.name}-`));
  const timings = {};
  let t = now();

  const parentState = materializeState(caseSpec, 'parent_ref', workDir, 'parent');
  timings.materialize_parent_ms = now() - t; t = now();
  const childState = materializeState(caseSpec, 'child_ref', workDir, 'child');
  timings.materialize_child_ms = now() - t; t = now();

  // ISOLATED, freshly-created cache — never reused across cases or from a prior evaluator run.
  const cacheRoot = join(workDir, 'parent-seeded-cache');

  const parentSeedOut = join(workDir, 'extract-parent-seed');
  const parentSeed = await extractEstate(parentState.estateRoot, parentSeedOut, { catalog_globs: catalogGlobs, cache: { root: cacheRoot, mode: 'reuse' }, collectPlans: true });
  timings.parent_seed_ms = now() - t; t = now();

  const childDeltaOut = join(workDir, 'extract-child-delta');
  const childDelta = await extractEstate(childState.estateRoot, childDeltaOut, { catalog_globs: catalogGlobs, cache: { root: cacheRoot, mode: 'reuse' }, collectPlans: true });
  timings.child_delta_ms = now() - t; t = now();

  // Forced-uncached reference: mode 'full' unconditionally nulls cache_root inside
  // planFileScopeExtraction, so this arm neither reads nor warms `cacheRoot`.
  const childReferenceOut = join(workDir, 'extract-child-reference');
  const childReference = await extractEstate(childState.estateRoot, childReferenceOut, { catalog_globs: catalogGlobs, cache: { root: null, mode: 'full' }, collectPlans: true });
  timings.child_reference_ms = now() - t; t = now();

  // Real Git change shape: the diff between what the parent-seed run and the forced-uncached
  // child-reference run ACTUALLY scanned — never a separately re-derived file list.
  const diff = diffInventories(combinedCurrentFiles(parentSeed.plans), combinedCurrentFiles(childReference.plans));

  // Expected reusable units are derived ONLY from validated, non-refused parent receipts plus the
  // child's current expected-unit set — never from the delta plan's own self-reported disposition
  // counts, and never crediting a refused/error parent unit as reuse-eligible.
  const parentValidUnitIds = new Set(
    combinedReceipts(parentSeed.plans)
      .filter(receipt => receipt.disposition.kind === 'produced' || receipt.disposition.kind === 'reused_exact')
      .map(receipt => receipt.unit_id),
  );
  const childExpectedUnits = combinedExpectedUnits(childDelta.plans);
  const expectedReusableUnitIds = childExpectedUnits.filter(unit => parentValidUnitIds.has(unit.unit_id)).map(unit => unit.unit_id).sort();
  const actualReusedUnitIds = combinedReceipts(childDelta.plans).filter(receipt => receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id).sort();
  const reuseExpectedNotActual = expectedReusableUnitIds.filter(id => !actualReusedUnitIds.includes(id));
  const reuseActualNotExpected = actualReusedUnitIds.filter(id => !expectedReusableUnitIds.includes(id));

  // ROUTED CHANGE SHAPE. Case preparation must record the raw Git change (diff, above) AND the
  // routed changed-unit membership under the pinned registry — a changed file only invalidates
  // code when a non-excluded extractor actually routes to it. A shell-only (or otherwise unrouted)
  // edit with no matching extractor is a no-routed-change CONTROL, never evidence that changed code
  // failed to invalidate anything. A DELETED file has no current expected unit (it no longer exists
  // in the child), so its own routing membership is read from the PARENT's expected units instead —
  // a delete of a routed file is still a routed change.
  const addedOrModifiedKeys = new Set([...diff.added, ...diff.modified].map(entry => `${entry.repository}\u0000${entry.normalized_path}`));
  const deletedKeys = new Set(diff.deleted.map(entry => `${entry.repository}\u0000${entry.normalized_path}`));
  const parentExpectedUnits = combinedExpectedUnits(parentSeed.plans);
  const routedChangedUnits = [
    ...childExpectedUnits.filter(unit => addedOrModifiedKeys.has(`${unit.repository}\u0000${unit.normalized_path}`)),
    ...parentExpectedUnits.filter(unit => deletedKeys.has(`${unit.repository}\u0000${unit.normalized_path}`)),
  ];
  const rawChangedPaths = diff.added.length + diff.modified.length + diff.deleted.length;
  const routing = Object.freeze({
    raw_changed_paths: rawChangedPaths,
    routed_changed_units: routedChangedUnits.length,
    classification: rawChangedPaths === 0 ? 'no_raw_change' : routedChangedUnits.length > 0 ? 'routed_change' : 'no_routed_change',
  });
  const routedChangeRequired = POSITIVE_EDIT_SHAPES.includes(caseSpec.change_shape);
  // The complementary check: a case explicitly labelled as the no-routed-change CONTROL that turns
  // out to have routed changes after all is a mislabelled case, not a silently-accepted control.
  const unroutedControlMislabelled = caseSpec.change_shape === 'ignored_or_unrouted_only' && routing.classification === 'routed_change';
  const routingInconclusive = (routedChangeRequired && routing.classification !== 'routed_change') || unroutedControlMislabelled;

  // Actual reconstructed facts compared, NOT a self-reported digest alone: real observation_id/
  // record_digest multisets from extractEstate()'s own receipts.
  const referenceRecords = admissibleRecords(childReference.plans);
  const deltaRecords = admissibleRecords(childDelta.plans);
  const { missing, extra, stale } = recordDiff(referenceRecords, deltaRecords);
  const recordsEqual = missing.length === 0 && extra.length === 0 && stale.length === 0;

  // The full downstream graph: STRICT merge over extractEstate()'s own complete facts+manifest for
  // both arms — the fix for the empirical lead (zero repo/zero coverage records, allowPartial
  // masking it). A healthy case must produce equal merged graphs with real repository incident
  // edges, not just equal raw records.
  const mergeDelta = await mergeStage(childDeltaOut, workDir, 'delta');
  const mergeReference = await mergeStage(childReferenceOut, workDir, 'reference');
  timings.merge_ms = now() - t;

  // [ACTUAL-SCANS] REAL production extractor.scan() invocation counts, not disposition-derived.
  const scanInvocationsActual = actualScanInvocations(childDelta.plans);
  const scanInvocationsReference = actualScanInvocations(childReference.plans);
  // Expected work: only the units NOT validly reuse-eligible must ever call scan() at all.
  const expectedScanInvocations = childExpectedUnits.length - expectedReusableUnitIds.length;

  const parentSeedManifest = readManifest(parentSeedOut);
  const deltaManifest = readManifest(childDeltaOut);
  const referenceManifest = readManifest(childReferenceOut);
  const scanComplete = manifest => manifest.repositories.every(entry => entry.status === 'complete')
    && manifest.closed_world_absence?.status === 'permitted';
  const inputComplete = scanComplete(deltaManifest) && scanComplete(referenceManifest);

  const mergeOk = mergeDelta.status === 'ok' && mergeReference.status === 'ok';
  const mergeDigestEqual = mergeOk && mergeDelta.digest === mergeReference.digest;
  const canonicalEqual = recordsEqual && mergeDigestEqual;

  // [COMMON-SCORER] The ONE case scorer — record/graph equality, expected-vs-observed reuse
  // (missing eligible reuse fails the reuse objective even though records above already compare
  // equal), actual scan-invocation evidence, and input completeness.
  const score = scoreCase({
    label: caseSpec.name,
    referenceRecords, candidateRecords: deltaRecords, mergeOk, mergeDigestEqual,
    expectedReusableUnitIds, actualReusedUnitIds,
    scanInvocations: { actual: scanInvocationsActual, expected: expectedScanInvocations },
    inputComplete,
  });

  let verdict = score.verdict;
  const verdictReasons = [...score.reasons];
  if (verdict === 'pass' && routingInconclusive) verdict = 'incomplete';
  if (routedChangeRequired && routing.classification !== 'routed_change') verdictReasons.push(`change_shape "${caseSpec.change_shape}" declares a positive code edit but routed_changed_units is 0 (no_routed_change control, not code-invalidation evidence)`);
  if (unroutedControlMislabelled) verdictReasons.push('change_shape "ignored_or_unrouted_only" is mislabelled: this case actually has routed changed units, so it is not the no-routed-change control it claims to be');

  return Object.freeze({
    schema: 'estate-map/delta-shape-eval-case-result/v2',
    case: { name: caseSpec.name, change_shape: caseSpec.change_shape },
    verdict, verdict_reasons: Object.freeze(verdictReasons),
    scorer: score,
    identities: {
      runner: 'tools/eval/delta-shape-eval.mjs',
      config: { catalog_globs: [...catalogGlobs].sort() },
      source: { parent_pins: parentState.pins, child_pins: childState.pins },
    },
    scope_exclusions: { parent: parentSeedManifest.scope_exclusions, child: referenceManifest.scope_exclusions },
    input_complete: inputComplete,
    scope: { diff: { added: diff.added.length, unchanged: diff.unchanged.length, modified: diff.modified.length, deleted: diff.deleted.length } },
    routing,
    units: {
      expected: childExpectedUnits.length,
      actual_dispositions: dispositionCounts(childDelta.plans),
      reference_dispositions: dispositionCounts(childReference.plans),
      expected_reusable_count: expectedReusableUnitIds.length,
      actual_reused_count: actualReusedUnitIds.length,
      reuse_expected_not_actual: reuseExpectedNotActual,
      reuse_actual_not_expected: reuseActualNotExpected,
    },
    scan_calls: { actual: scanInvocationsActual, reference: scanInvocationsReference, decreased: scanInvocationsActual < scanInvocationsReference },
    scan_invocations: {
      actual: scanInvocationsActual, reference: scanInvocationsReference, expected: expectedScanInvocations,
      matches_expected: scanInvocationsActual === expectedScanInvocations,
    },
    records: { missing, extra, stale },
    canonical_equal: canonicalEqual,
    merge: { delta: mergeDelta, reference: mergeReference, digest_equal: mergeDigestEqual },
    scan_call_telemetry: {
      parent_seed: JSON.parse(readFileSync(join(parentSeedOut, '_CACHE_TELEMETRY.json'), 'utf8')),
      child_delta: JSON.parse(readFileSync(join(childDeltaOut, '_CACHE_TELEMETRY.json'), 'utf8')),
      child_reference: JSON.parse(readFileSync(join(childReferenceOut, '_CACHE_TELEMETRY.json'), 'utf8')),
    },
    stage_timings_ms: timings,
    work_dir: workDir,
  });
}

// --- Controls (positive/negative), matching docs/delta-updatable-estate-maps.md's falsifier
// discipline: each must fail/pass for the EXPECTED reason, not pass by construction. Every control
// below manipulates a `cache_root` directly (seeding/forging/corrupting entries) and therefore
// drives the shared file-scope kernel (tools/file-extraction-adapter.mjs planFileScopeExtraction)
// itself, exercising the SAME production scoring path (recordDiff against a forced-uncached
// reference) the main case above uses — never a separate self-declared-passed function. ------------

function controlRegistryAndStates(caseSpec, opts, workDir) {
  const registry = buildExtractionRegistry({ catalog_globs: opts?.catalogGlobs || caseSpec.catalog_globs || [] });
  const parentState = materializeState(caseSpec, 'parent_ref', workDir, 'control-parent');
  const childState = materializeState(caseSpec, 'child_ref', workDir, 'control-child');
  return { registry, parentState, childState };
}

/** Reuse-NONE control: run the delta arm against a cache that was never seeded (a fresh, empty
 * directory). The SAME shared scorer must report: correctness objective PASSES (facts equal the
 * reference) while the REUSE OBJECTIVE FAILS — zero units reused even though every unchanged unit
 * was eligible. `passed` is derived from that scorer verdict, never a private local boolean. */
export async function runReuseNoneControl(caseSpec, opts) {
  const workDir = mkdtempSync(join(scratchBase(opts?.workDirRoot), `reuse-none-${caseSpec.name}-`));
  const { registry, parentState, childState } = controlRegistryAndStates(caseSpec, opts, workDir);
  const parentInventory = await estateCurrentInventory(parentState.estateRoot);
  const childInventory = await estateCurrentInventory(childState.estateRoot);
  const neverSeeded = mkdtempSync(join(workDir, 'never-seeded-cache-'));
  const delta = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: neverSeeded, mode: 'reuse', registry });
  const reference = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });

  // Expected reusable units are computed from an ISOLATED parent extraction that never touches
  // `neverSeeded`, so this control can tell "nothing to prove" apart from "reuse genuinely failed".
  const parentPlan = planFileScopeExtraction({ current_inventory: parentInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });
  const parentValidUnitIds = new Set(parentPlan.plan.receipts.filter(receipt => receipt.disposition.kind === 'produced').map(receipt => receipt.unit_id));
  const expectedReusableUnitIds = delta.plan.expected_units.filter(unit => parentValidUnitIds.has(unit.unit_id)).map(unit => unit.unit_id).sort();
  if (!expectedReusableUnitIds.length) {
    return Object.freeze({ control: 'reuse_none', passed: null, reason: 'no unit is eligible for reuse in this case (nothing unchanged between parent and child) — supply a case with at least one unchanged routed unit to exercise this control' });
  }
  const actualReusedUnitIds = delta.plan.receipts.filter(receipt => receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id).sort();

  const score = scoreCase({
    label: `${caseSpec.name}:reuse_none`,
    referenceRecords: admissibleRecordsFromReceipts(reference.plan.receipts),
    candidateRecords: admissibleRecordsFromReceipts(delta.plan.receipts),
    expectedReusableUnitIds, actualReusedUnitIds,
  });
  // Meta-control success: the SAME scorer reports the reuse objective failing (every eligible unit
  // missed) while correctness still holds — a never-seeded cache is a reuse-objective gap, not a
  // correctness bug.
  const expectedFailureShape = score.verdict === 'fail' && !score.objectives.reuse.pass && score.objectives.correctness.pass;
  return Object.freeze({
    control: 'reuse_none',
    expected_outcome: 'the scorer\u2019s reuse objective fails (every eligible unit missed) while its correctness objective still passes',
    reused_count: actualReusedUnitIds.length, expected_reusable_count: expectedReusableUnitIds.length,
    correctness_holds: score.objectives.correctness.pass,
    scorer_verdict: score.verdict, scorer_reasons: score.reasons,
    passed: expectedFailureShape,
    reason: expectedFailureShape
      ? 'the scorer correctly reported a reuse-objective failure (0 reused of the eligible set) with correctness intact'
      : 'the scorer did not report the expected reuse-objective failure for a never-seeded cache',
  });
}

/** Reuse-ALL control (POSITIVE — kept under this name deliberately; it is never repurposed to
 * pretend it is the STALE negative below). Fully seed the cache from the parent state, then plan
 * the child delta over that cache. The SAME shared scorer must report BOTH objectives passing:
 * every VALIDATED reuse-eligible unit is actually served from cache (reuse objective), and the
 * served output still matches an honest forced-uncached reference (correctness objective).
 * `passed: null` (inconclusive, never fabricated) when this case has no eligible unchanged unit to
 * prove the mechanism against. */
export async function runReuseAllControl(caseSpec, opts) {
  const workDir = mkdtempSync(join(scratchBase(opts?.workDirRoot), `reuse-all-${caseSpec.name}-`));
  const { registry, parentState, childState } = controlRegistryAndStates(caseSpec, opts, workDir);
  const parentInventory = await estateCurrentInventory(parentState.estateRoot);
  const childInventory = await estateCurrentInventory(childState.estateRoot);
  const cacheRoot = mkdtempSync(join(workDir, 'fully-seeded-cache-'));
  const parentSeeded = planFileScopeExtraction({ current_inventory: parentInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });
  const parentValidUnitIds = new Set(
    parentSeeded.plan.receipts.filter(receipt => receipt.disposition.kind === 'produced' || receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id),
  );
  const delta = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });
  const reference = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });
  const expected = delta.plan.expected_units.filter(unit => parentValidUnitIds.has(unit.unit_id)).map(unit => unit.unit_id).sort();
  const actual = delta.plan.receipts.filter(receipt => receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id).sort();
  if (!expected.length) {
    return Object.freeze({ control: 'reuse_all', passed: null, reason: 'no unit is eligible for reuse in this case (nothing unchanged between parent and child) — supply a case with at least one unchanged routed unit to exercise this control', expected_reusable_count: 0 });
  }
  const score = scoreCase({
    label: `${caseSpec.name}:reuse_all`,
    referenceRecords: admissibleRecordsFromReceipts(reference.plan.receipts),
    candidateRecords: admissibleRecordsFromReceipts(delta.plan.receipts),
    expectedReusableUnitIds: expected, actualReusedUnitIds: actual,
  });
  return Object.freeze({
    control: 'reuse_all',
    expected_outcome: 'every validated reuse-eligible unit is actually served from cache, and the served output still matches the reference',
    expected_reusable_count: expected.length, actual_reused_count: actual.length, missed_reuse: score.objectives.reuse.reuse_expected_not_actual,
    scorer_verdict: score.verdict, scorer_reasons: score.reasons,
    passed: score.verdict === 'pass',
    reason: score.verdict === 'pass' ? 'every reuse-eligible unit was actually reused and output matched the reference' : score.reasons.join('; '),
  });
}

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export async function runReuseAllStaleControl(caseSpec, opts) {
  const workDir = mkdtempSync(join(scratchBase(opts?.workDirRoot), `reuse-all-stale-${caseSpec.name}-`));
  const { registry, parentState, childState } = controlRegistryAndStates(caseSpec, opts, workDir);
  const parentInventory = await estateCurrentInventory(parentState.estateRoot);
  const childInventory = await estateCurrentInventory(childState.estateRoot);
  const diff = diffInventories(parentInventory, childInventory);
  if (!diff.modified.length && !diff.deleted.length) {
    return Object.freeze({ control: 'reuse_all_stale', passed: null, reason: 'no modified or deleted file in this case to demonstrate stale reuse — supply a case with at least one edited or removed file' });
  }
  // OWNED SANDBOX: a cache seeded from the parent, used ONLY to harvest receipts for the forged
  // candidate below — never passed to a real child plan, so production code never sees it.
  const sandboxCacheRoot = mkdtempSync(join(workDir, 'owned-stale-sandbox-cache-'));
  const parentSeeded = planFileScopeExtraction({ current_inventory: parentInventory, parent_inventory: [], cache_root: sandboxCacheRoot, mode: 'reuse', registry });

  const staleCandidateReceipts = parentSeeded.plan.receipts
    .filter(receipt => receipt.disposition.kind === 'produced' || receipt.disposition.kind === 'reused_exact')
    .map(receipt => relabelDisposition(receipt, {
      kind: 'reused_exact', source_receipt_digest: receipt.receipt_digest, compatibility_receipt_digest: null, migration_receipt_digest: null,
    }));

  // The HONEST reference: a real forced-uncached full extraction of the actual current child.
  const reference = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });

  const score = scoreCase({
    label: `${caseSpec.name}:reuse_all_stale`,
    referenceRecords: admissibleRecordsFromReceipts(reference.plan.receipts),
    candidateRecords: admissibleRecordsFromReceipts(staleCandidateReceipts),
  });
  const rejectedForRightReason = score.verdict === 'fail' && !score.objectives.correctness.pass
    && (score.objectives.correctness.missing.length > 0 || score.objectives.correctness.extra.length > 0 || score.objectives.correctness.stale.length > 0);
  return Object.freeze({
    control: 'reuse_all_stale',
    expected_outcome: 'a blind "reuse everything from parent regardless of child state" candidate is REJECTED by the scorer\u2019s correctness objective (stale/extra/missing records), never accepted as equal to the honest reference',
    scorer_verdict: score.verdict, scorer_reasons: score.reasons,
    missing: score.objectives.correctness.missing, extra: score.objectives.correctness.extra, stale: score.objectives.correctness.stale,
    passed: rejectedForRightReason,
    reason: rejectedForRightReason
      ? 'the scorer correctly rejected the blind reuse-all-stale candidate for the right reason (stale/extra/missing records against the honest reference)'
      : 'the blind reuse-all-stale candidate was NOT rejected — the scorer failed to catch stale/deleted output being served as current',
  });
}

/**
 * Dropped-record control: forge a cache entry that is INTERNALLY consistent (its own digests
 * recompute) but is MISSING one record relative to what the real producer emits — the gap
 * tools/delta/unit-cache.mjs's own validation cannot see (it proves a receipt is self-consistent,
 * never that it matches ground truth). The evaluator's comparison against the forced-uncached
 * reference (recordDiff, not receipt self-validation) must be what catches it.
 */
export async function runDroppedRecordControl(caseSpec, opts) {
  const workDir = mkdtempSync(join(scratchBase(opts?.workDirRoot), `dropped-record-${caseSpec.name}-`));
  const { registry, parentState, childState } = controlRegistryAndStates(caseSpec, opts, workDir);
  const parentInventory = await estateCurrentInventory(parentState.estateRoot);
  const childInventory = await estateCurrentInventory(childState.estateRoot);
  const cacheRoot = mkdtempSync(join(workDir, 'dropped-record-cache-'));
  const parentSeeded = planFileScopeExtraction({ current_inventory: parentInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });

  // The forged unit must belong to a file that is genuinely UNCHANGED between parent and child, or
  // the child plan will recompute it under a different unit_id and never even look the forged
  // entry up — which would prove nothing about the gap this control exists to demonstrate.
  const unchangedPaths = new Set(diffInventories(parentInventory, childInventory).unchanged.map(entry => `${entry.repository}\u0000${entry.normalized_path}`));
  const multiRecordReceipt = parentSeeded.plan.receipts.find(receipt => receipt.output.records.length > 1
    && unchangedPaths.has(`${receipt.scope.repository}\u0000${receipt.scope.normalized_path}`));
  if (!multiRecordReceipt) {
    return Object.freeze({ control: 'dropped_record', passed: null, reason: 'no multi-record unit on an unchanged file in this case to forge — supply a case with a richer unchanged file to exercise this control' });
  }
  // Import the unit's own identity builder to forge a SELF-CONSISTENT but incomplete receipt.
  const { buildProducedFileUnitReceipt } = await import('../delta/extraction-unit.mjs');
  const shortenedRecords = multiRecordReceipt.output.records.slice(1).map(record => ({
    observation_kind: record.identity.observation_kind, producer_local_key: record.identity.producer_local_key,
    output_schema: record.output_schema, normalized_record: record.normalized_record,
  }));
  const forged = buildProducedFileUnitReceipt({
    repository: multiRecordReceipt.scope.repository, normalized_path: multiRecordReceipt.scope.normalized_path,
    blob_oid: multiRecordReceipt.scope.blob_oid, content_sha256: multiRecordReceipt.scope.content_sha256,
    extractor: multiRecordReceipt.extractor, records: shortenedRecords,
  });
  // writeUnitCacheEntry() is a protective no-op when a VALID entry already occupies this unit_id
  // (parentSeeded already wrote the real one) — correctly so for production use, but this control
  // needs to REPLACE it on disk to forge the gap. Write the raw file directly, exactly as an
  // out-of-band on-disk tamper would.
  const { mkdirSync: mkdirRaw, writeFileSync: writeReceiptRaw } = await import('node:fs');
  const { join: joinRaw } = await import('node:path');
  const forgedUnitDir = joinRaw(cacheRoot, forged.unit_id.replace(/^unit:/, ''));
  mkdirRaw(forgedUnitDir, { recursive: true });
  writeReceiptRaw(joinRaw(forgedUnitDir, 'receipt.json'), `${JSON.stringify(forged, null, 2)}\n`);
  // Confirm the forged entry passes unit-cache's OWN self-consistency validation — the gap this
  // control demonstrates is real, not a rejected/impossible input.
  const readBack = readUnitCacheEntry(cacheRoot, forged.unit_id);

  const delta = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });
  const reference = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });
  const score = scoreCase({
    label: `${caseSpec.name}:dropped_record`,
    referenceRecords: admissibleRecordsFromReceipts(reference.plan.receipts),
    candidateRecords: admissibleRecordsFromReceipts(delta.plan.receipts),
  });
  const caughtByEvaluator = !score.objectives.correctness.pass && score.objectives.correctness.missing.length > 0;
  return Object.freeze({
    control: 'dropped_record', expected_outcome: 'the shared scorer\u2019s correctness objective detects the missing record; unit-cache self-validation alone does not',
    forged_unit_id: forged.unit_id, forged_entry_passed_self_validation: readBack.status === 'hit',
    missing_records: score.objectives.correctness.missing,
    scorer_verdict: score.verdict, scorer_reasons: score.reasons,
    passed: readBack.status === 'hit' && caughtByEvaluator,
    reason: caughtByEvaluator ? 'the scorer\u2019s correctness objective caught the dropped record' : 'the dropped record went undetected — the scorer\u2019s correctness objective is not doing its job',
  });
}

/** Corruption control: tamper a cached receipt's own digest (not internally consistent). Real
 * unit-cache quarantine + fail-closed recompute must both fire, and correctness must still hold
 * because the unit is recomputed rather than served. */
export async function runCorruptionControl(caseSpec, opts) {
  const workDir = mkdtempSync(join(scratchBase(opts?.workDirRoot), `corruption-${caseSpec.name}-`));
  const { registry, parentState, childState } = controlRegistryAndStates(caseSpec, opts, workDir);
  const parentInventory = await estateCurrentInventory(parentState.estateRoot);
  const childInventory = await estateCurrentInventory(childState.estateRoot);
  const cacheRoot = mkdtempSync(join(workDir, 'corruption-cache-'));
  const parentSeeded = planFileScopeExtraction({ current_inventory: parentInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });
  // Same requirement as the dropped-record control: corrupt a unit belonging to a file that is
  // genuinely unchanged between parent and child, so the child plan actually attempts to reuse it
  // under the SAME unit_id and encounters the corruption.
  const unchangedPaths = new Set(diffInventories(parentInventory, childInventory).unchanged.map(entry => `${entry.repository}\u0000${entry.normalized_path}`));
  const target = parentSeeded.plan.receipts.find(receipt => unchangedPaths.has(`${receipt.scope.repository}\u0000${receipt.scope.normalized_path}`));
  if (!target) return Object.freeze({ control: 'corruption', passed: null, reason: 'no unchanged-file unit in this case to corrupt — supply a case with at least one unchanged file' });
  const before = readUnitCacheEntry(cacheRoot, target.unit_id);
  if (before.status !== 'hit') return Object.freeze({ control: 'corruption', passed: false, reason: 'setup failure: seeded unit did not read back as a hit' });

  const { readFileSync: readReceipt, writeFileSync: writeReceipt } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const unitDir = joinPath(cacheRoot, target.unit_id.replace(/^unit:/, ''));
  const receiptPath = joinPath(unitDir, 'receipt.json');
  const stored = JSON.parse(readReceipt(receiptPath, 'utf8'));
  stored.receipt_digest = 'tampered';
  writeReceipt(receiptPath, JSON.stringify(stored, null, 2));

  const afterCorrupt = readUnitCacheEntry(cacheRoot, target.unit_id);
  const delta = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: cacheRoot, mode: 'reuse', registry });
  const reference = planFileScopeExtraction({ current_inventory: childInventory, parent_inventory: [], cache_root: null, mode: 'full', registry });
  const score = scoreCase({
    label: `${caseSpec.name}:corruption`,
    referenceRecords: admissibleRecordsFromReceipts(reference.plan.receipts),
    candidateRecords: admissibleRecordsFromReceipts(delta.plan.receipts),
  });
  const quarantined = afterCorrupt.status === 'miss' && afterCorrupt.reason === 'cache_corrupt';
  return Object.freeze({
    control: 'corruption', expected_outcome: 'quarantine + fail-closed recompute; the shared scorer\u2019s correctness objective still passes',
    quarantined,
    recomputed_disposition: delta.plan.receipts.find(receipt => receipt.unit_id === target.unit_id)?.disposition.kind,
    correctness_holds: score.objectives.correctness.pass,
    scorer_verdict: score.verdict, scorer_reasons: score.reasons,
    passed: quarantined && score.verdict === 'pass',
    reason: quarantined
      ? (score.verdict === 'pass' ? 'corrupt entry quarantined and recomputed; the scorer confirms output still matches the reference' : 'corrupt entry was quarantined but the scorer detected a correctness regression after recompute')
      : 'a corrupt entry was NOT rejected',
  });
}

// --- CLI -----------------------------------------------------------------------------------------

function controlsVerdict(controls) {
  if (!controls) return 'pass';
  const values = Object.values(controls);
  if (values.some(control => control.passed === false)) return 'fail';
  if (values.some(control => control.passed === null || control.passed === undefined)) return 'incomplete';
  return 'pass';
}

export async function runCaseManifest(manifestPath, { workDirRoot, runControls = true } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  const cases = manifest.cases || [];
  const coverage = summarizeCoverage(cases);
  if (!cases.length) {
    return Object.freeze({
      schema: 'estate-map/delta-shape-eval-run/v2', verdict: 'incomplete',
      verdict_reasons: Object.freeze(['case manifest declares zero cases; an empty case manifest cannot report full evaluation success']),
      coverage, cases: [],
    });
  }
  const results = [];
  for (const caseSpec of cases) {
    const caseResult = await runChangeShapeCase(caseSpec, { workDirRoot });
    const controls = runControls ? {
      reuse_none: await runReuseNoneControl(caseSpec, { workDirRoot }),
      reuse_all: await runReuseAllControl(caseSpec, { workDirRoot }),
      reuse_all_stale: await runReuseAllStaleControl(caseSpec, { workDirRoot }),
      dropped_record: await runDroppedRecordControl(caseSpec, { workDirRoot }),
      corruption: await runCorruptionControl(caseSpec, { workDirRoot }),
    } : null;
    const controlsOutcome = controlsVerdict(controls);
    let combinedVerdict = caseResult.verdict;
    if (controlsOutcome === 'fail') combinedVerdict = 'fail';
    else if (controlsOutcome === 'incomplete' && combinedVerdict === 'pass') combinedVerdict = 'incomplete';
    results.push({ ...caseResult, controls, combined_verdict: combinedVerdict });
  }
  const anyFail = results.some(result => result.combined_verdict === 'fail');
  const anyIncomplete = results.some(result => result.combined_verdict === 'incomplete');
  const missingRequiredCoverage = coverage.missing.length > 0;
  const verdict = anyFail ? 'fail' : (anyIncomplete || missingRequiredCoverage) ? 'incomplete' : 'pass';
  const verdictReasons = [];
  if (anyFail) verdictReasons.push('one or more cases or controls failed — see each case\u2019s verdict_reasons/controls');
  if (missingRequiredCoverage) verdictReasons.push(`case manifest does not cover every canonical change shape: missing ${coverage.missing.join(', ')}`);
  if (anyIncomplete) verdictReasons.push('one or more cases or controls were inconclusive (see each case\u2019s verdict_reasons/controls)');
  return Object.freeze({ schema: 'estate-map/delta-shape-eval-run/v2', verdict, verdict_reasons: Object.freeze(verdictReasons), coverage, cases: results });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const manifestFlagIndex = args.indexOf('--case-manifest');
  const workDirFlagIndex = args.indexOf('--work-dir');
  if (manifestFlagIndex === -1 || !args[manifestFlagIndex + 1]) {
    console.error('Usage: node tools/eval/delta-shape-eval.mjs --case-manifest <path> [--work-dir <dir>]');
    process.exit(1);
  }
  const workDirRoot = workDirFlagIndex !== -1 ? resolve(args[workDirFlagIndex + 1]) : undefined;
  runCaseManifest(args[manifestFlagIndex + 1], { workDirRoot })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      // Exit status reflects the ACTUAL run verdict: 0 only for a full pass; 2 for an inconclusive/
      // incomplete run (missing coverage, an inconclusive control, an input-completeness gap) that
      // must never be reported as green; 1 for any real failure.
      process.exitCode = result.verdict === 'pass' ? 0 : result.verdict === 'incomplete' ? 2 : 1;
    })
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
