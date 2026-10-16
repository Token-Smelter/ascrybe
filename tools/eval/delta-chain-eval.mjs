#!/usr/bin/env node
// [STATEFUL-CHAIN] evaluator: executes ONE declared, ordered, multi-step chain (A -> B -> C -> ...)
// against ONE OWNED per-unit extraction cache that is seeded EXACTLY ONCE, from the chain's first
// step, and then genuinely CARRIED FORWARD hop to hop: step i+1 reuses the REAL cache state step i's
// own extraction actually left behind — never a fresh cache, never a fresh reseed of the
// intermediate state from a separate full run.
//
// HONESTY NOTE — this is a DIFFERENT artifact from tools/eval/delta-shape-eval.mjs's
// `change_shape: 'chained_update'` cases. Those are TWO INDEPENDENT isolated parent/child pairs,
// each given its OWN fresh parent-seeded cache (runChangeShapeCase allocates one unconditionally,
// every call) — useful evidence that a single delta step works correctly in isolation, but NOT
// evidence that state survives a real second hop, because the second pair's "parent" cache is
// reseeded from scratch rather than continuing the first pair's own cache. Never read one as proof
// of the other; this module is what proves genuine carried-forward state.
//
// Chain case manifest input — a NEW, versioned schema distinct from delta-shape-eval's `cases`:
//
//   {
//     "schema": "estate-map/delta-chain-eval-case/v1",
//     "name": "<invented chain name>",
//     "repositories": { "<repo>": { "path": "<real local Git checkout path>" }, ... },
//     "catalog_globs": [],
//     "steps": [
//       { "label": "A", "refs": { "<repo>": "<git ref/sha>" } },
//       { "label": "B", "refs": { "<repo>": "<git ref/sha>" } },
//       { "label": "C", "refs": { "<repo>": "<git ref/sha>" } }
//       // 3+ steps required: at least one A->B hop plus one B->C hop.
//     ]
//   }
//
// Execution, per case:
//   1. Materialize step 0 ("A") and SEED ONE owned cache_root by running the REAL ordinary
//      extraction path (tools/extract.mjs extractEstate()) over it — exactly once, ever, for this
//      chain (`seed_count` in the result is always 1).
//   2. For every subsequent step i (>=1): BEFORE running anything, validate that the SAME cache
//      still carries THIS chain's own state at EXACTLY step i-1 — chain identity, chain position,
//      adjacent pin set, and producer/config identity (validateChainState) — refusing to proceed on
//      any mismatch (a fresh/wrong/reset cache is never silently accepted as continued state).
//   3. Run the CHAIN ARM: extractEstate() over step i, reusing the SAME cache_root the previous step
//      actually left behind (never a fresh one).
//   4. Run an ISOLATED FORCED-FULL REFERENCE for step i's child alone: extractEstate() with the SAME
//      cache_root path but `mode: 'full'`, which structurally disables BOTH read AND write
//      (tools/file-extraction-adapter.mjs planFileScopeExtraction) — explicit, checked evidence this
//      arm cannot read or warm the chain cache (`reference_touched_chain_cache` must be `false`).
//   5. Score this hop with the SAME shared case scorer (tools/eval/case-scorer.mjs) every isolated
//      case and control uses: record/graph equality against the reference, expected-vs-actual reuse
//      (derived from the PRECEDING step's own real receipts, never a self-reported count), actual
//      scan-invocation evidence, and input completeness.
//   6. Record the new chain-state marker (this step's own pins) and continue.
//
// `steps[i].cache_entries_before` equalling `steps[i-1].cache_entries_after` is the DIRECT,
// filesystem-level proof that hop i+1 continued the SAME cache object hop i actually left behind —
// a silent cache reset at any step breaks this equality (see tests/delta-chain-eval.test.mjs).
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { extractEstate } from '../extract.mjs';
import { materializeExactGitTree } from '../git-tree-source.mjs';
import { buildExtractionRegistry } from '../file-extraction-adapter.mjs';
import { sha256, stableStringify } from '../lib.mjs';
import { admissibleRecordsFromReceipts, scoreCase } from './case-scorer.mjs';
import { mergeStage, resolveRef, scratchBase } from './delta-shape-eval.mjs';

const canonical = value => stableStringify(value).trim();

export const CHAIN_CASE_SCHEMA = 'estate-map/delta-chain-eval-case/v1';
export const CHAIN_RESULT_SCHEMA = 'estate-map/delta-chain-eval-result/v1';
export const CHAIN_CACHE_STATE_SCHEMA = 'estate-map/delta-chain-cache-state/v1';
const CHAIN_STATE_FILE = '_CHAIN_STATE.json';

function materializeStep(chainSpec, step, workDir, label) {
  const estateRoot = join(workDir, `estate-${label}`);
  mkdirSync(estateRoot, { recursive: true });
  const pins = {};
  for (const [repositoryName, declaration] of Object.entries(chainSpec.repositories)) {
    const ref = step.refs?.[repositoryName];
    if (!ref) throw new Error(`chain step "${step.label ?? label}" does not declare a ref for repository "${repositoryName}"`);
    const sha = resolveRef(declaration.path, ref);
    materializeExactGitTree({
      repository: declaration.path, sha, target: join(estateRoot, repositoryName), project_id: repositoryName,
    });
    pins[repositoryName] = sha;
  }
  return Object.freeze({ estateRoot, pins });
}

/** A stable digest of the CURRENT producer registry identity (every extractor contract, including
 * its implementation/configuration/runtime digests) — the "producer/config identity" adjacent-step
 * validation compares against. Computed from a throwaway registry (never used for real extraction
 * here); deterministic and content-derived, so it equals whatever extractEstate()'s OWN internal
 * registry build would compute for the same catalog_globs. */
function producerRegistryDigest(catalogGlobs = []) {
  const registry = buildExtractionRegistry({ catalog_globs: catalogGlobs });
  return sha256(canonical(registry.map(route => route.extractor)));
}

function readChainState(cacheRoot) {
  try {
    return JSON.parse(readFileSync(join(cacheRoot, CHAIN_STATE_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`chain cache state is unreadable/corrupt at ${cacheRoot}: ${error.message}`);
  }
}
// Exported for tests/delta-chain-eval.test.mjs to fabricate a mismatched chain-state marker
// directly, so validateChainState's guard itself can be proven against every mismatch shape
// without needing a full multi-repository chain run per failure mode.
export function writeChainState(cacheRoot, state) {
  writeFileSync(join(cacheRoot, CHAIN_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Validate that the cache about to be CONSUMED is genuinely the one THIS chain's PRECEDING step
 * actually left behind — exact chain identity, chain position, adjacent pin set, and producer/
 * config identity — before running the next hop. Throws a typed error on any mismatch rather than
 * silently proceeding: a fresh/wrong/reset cache must never be mistaken for continued state.
 * Exported and independently unit-tested (tests/delta-chain-eval.test.mjs) against fabricated
 * mismatches, so the guard itself is proven without needing a full multi-step run per failure mode.
 */
export function validateChainState(cacheRoot, expected) {
  const state = readChainState(cacheRoot);
  if (!state || state.schema !== CHAIN_CACHE_STATE_SCHEMA) {
    throw new Error(`chain cache at ${cacheRoot} carries no valid chain state — it was never seeded by this chain, or was silently replaced by a fresh cache`);
  }
  if (state.chain_name !== expected.chain_name) {
    throw new Error(`chain cache state belongs to chain "${state.chain_name}", not "${expected.chain_name}" — refusing to continue from a foreign chain's cache`);
  }
  if (state.step_index !== expected.previous_step_index) {
    throw new Error(`chain position mismatch: cache state is at step ${state.step_index}, expected step ${expected.previous_step_index} — the chain was not advanced in strict order`);
  }
  if (canonical(state.pins) !== canonical(expected.previous_pins)) {
    throw new Error(`adjacent pin identity failed: chain cache state's recorded pins do not match the actual preceding step's materialized pins (recorded=${JSON.stringify(state.pins)}, actual=${JSON.stringify(expected.previous_pins)})`);
  }
  if (state.producer_registry_digest !== expected.producer_registry_digest) {
    throw new Error('producer/config identity mismatch: the chain cache state was seeded under a different extractor/configuration digest than the one running now');
  }
  return state;
}

function combinedReceipts(plans) { return plans.flatMap(entry => entry.plan.receipts); }
function combinedExpectedUnits(plans) { return plans.flatMap(entry => entry.plan.expected_units); }
function dispositionCounts(receipts) {
  const counts = {
    produced: 0, reused_exact: 0, migrated: 0, refused: 0,
  };
  for (const receipt of receipts) counts[receipt.disposition.kind] = (counts[receipt.disposition.kind] || 0) + 1;
  return counts;
}
function validUnitIds(receipts) {
  return receipts.filter(receipt => receipt.disposition.kind === 'produced' || receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id);
}
function sumScanInvocations(plans) { return plans.reduce((sum, entry) => sum + (entry.scan_invocations ?? 0), 0); }
function readManifestFile(dir) { return JSON.parse(readFileSync(join(dir, '_MANIFEST.json'), 'utf8')); }
function manifestComplete(manifest) {
  return manifest.repositories.every(entry => entry.status === 'complete') && manifest.closed_world_absence?.status === 'permitted';
}
function cacheEntryCount(cacheRoot) {
  try { return readdirSync(cacheRoot).length; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

/**
 * Run ONE stateful chain case end to end. `chainSpec = {name, repositories: {repo: {path}},
 * steps: [{label?, refs: {repo: ref}}, ...], catalog_globs?}`. Requires at least 3 steps (one
 * seed plus two hops) so the sequence genuinely exercises A->B->C, not merely A->B.
 */
export async function runChainCase(chainSpec, { workDirRoot } = {}) {
  if (!chainSpec?.name || !chainSpec?.repositories || !Object.keys(chainSpec.repositories).length) {
    throw new Error('a chain case requires name and a non-empty repositories map');
  }
  if (!Array.isArray(chainSpec.steps) || chainSpec.steps.length < 3) {
    throw new Error('a chain case requires at least 3 steps (A, B, C) to exercise one A->B->C carried-state sequence');
  }
  const catalogGlobs = chainSpec.catalog_globs || [];
  const base = scratchBase(workDirRoot);
  const workDir = mkdtempSync(join(base, `delta-chain-eval-${chainSpec.name}-`));
  const registryDigest = producerRegistryDigest(catalogGlobs);

  // ONE owned cache for the ENTIRE chain — created exactly once, never recreated at any hop.
  const chainCacheRoot = join(workDir, 'chain-owned-cache');
  mkdirSync(chainCacheRoot, { recursive: true });

  const steps = [];
  let previousState = null;
  let seedCount = 0;

  for (let index = 0; index < chainSpec.steps.length; index += 1) {
    const step = chainSpec.steps[index];
    const label = step.label ?? String.fromCharCode(65 + index);
    const state = materializeStep(chainSpec, step, workDir, `step-${index}-${label}`);

    if (index === 0) {
      // Seed exactly once, from A.
      const outDir = join(workDir, `extract-step-${index}-seed`);
      const seeded = await extractEstate(state.estateRoot, outDir, {
        catalog_globs: catalogGlobs, cache: { root: chainCacheRoot, mode: 'reuse' }, collectPlans: true,
      });
      seedCount += 1;
      const receipts = combinedReceipts(seeded.plans);
      writeChainState(chainCacheRoot, {
        schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: chainSpec.name, step_index: index, label, pins: state.pins, producer_registry_digest: registryDigest,
      });
      steps.push(Object.freeze({
        step_index: index, label, pins: state.pins, role: 'seed', out_dir: outDir,
        cache_entries_after: cacheEntryCount(chainCacheRoot),
        dispositions: dispositionCounts(receipts),
        valid_unit_ids: validUnitIds(receipts),
      }));
      previousState = state;
      continue;
    }

    // [STATEFUL-CHAIN] Validate BEFORE consuming: the cache about to be reused must genuinely be
    // what the PRECEDING step actually left behind.
    validateChainState(chainCacheRoot, {
      chain_name: chainSpec.name, previous_step_index: index - 1, previous_pins: previousState.pins, producer_registry_digest: registryDigest,
    });

    const cacheEntriesBefore = cacheEntryCount(chainCacheRoot);
    // CHAIN ARM: reuses the SAME persistent cache — the actual state the previous hop left behind.
    const chainArmOut = join(workDir, `extract-step-${index}-chain`);
    const chainArm = await extractEstate(state.estateRoot, chainArmOut, {
      catalog_globs: catalogGlobs, cache: { root: chainCacheRoot, mode: 'reuse' }, collectPlans: true,
    });
    const cacheEntriesAfter = cacheEntryCount(chainCacheRoot);

    // ISOLATED FORCED-FULL REFERENCE for this hop's child alone. Same cacheRoot path, but
    // `mode: 'full'` structurally disables both read AND write — checked evidence this arm cannot
    // read or warm the chain cache.
    const referenceOut = join(workDir, `extract-step-${index}-reference`);
    const referenceEntriesBefore = cacheEntryCount(chainCacheRoot);
    const reference = await extractEstate(state.estateRoot, referenceOut, {
      catalog_globs: catalogGlobs, cache: { root: chainCacheRoot, mode: 'full' }, collectPlans: true,
    });
    const referenceEntriesAfter = cacheEntryCount(chainCacheRoot);

    const mergeChain = await mergeStage(chainArmOut, workDir, `chain-step-${index}`);
    const mergeReference = await mergeStage(referenceOut, workDir, `reference-step-${index}`);

    const chainReceipts = combinedReceipts(chainArm.plans);
    const referenceReceipts = combinedReceipts(reference.plans);
    const chainRecords = admissibleRecordsFromReceipts(chainReceipts);
    const referenceRecords = admissibleRecordsFromReceipts(referenceReceipts);

    const expectedUnits = combinedExpectedUnits(chainArm.plans);
    // Expected reuse for THIS hop is derived from the PRECEDING step's own actual receipts
    // (this chain's real prior extraction), never a self-reported disposition count.
    const priorValidUnitIds = new Set(steps[steps.length - 1].valid_unit_ids);
    const expectedReusableUnitIds = expectedUnits.filter(unit => priorValidUnitIds.has(unit.unit_id)).map(unit => unit.unit_id).sort();
    const actualReusedUnitIds = chainReceipts.filter(receipt => receipt.disposition.kind === 'reused_exact').map(receipt => receipt.unit_id).sort();

    const chainScanInvocations = sumScanInvocations(chainArm.plans);
    const referenceScanInvocations = sumScanInvocations(reference.plans);
    const expectedScanInvocations = expectedUnits.length - expectedReusableUnitIds.length;

    const mergeOk = mergeChain.status === 'ok' && mergeReference.status === 'ok';
    const mergeDigestEqual = mergeOk && mergeChain.digest === mergeReference.digest;
    const inputComplete = manifestComplete(readManifestFile(chainArmOut)) && manifestComplete(readManifestFile(referenceOut));

    // [COMMON-SCORER] The SAME shared scorer every isolated case and control uses.
    const previousLabel = steps[steps.length - 1].label;
    const score = scoreCase({
      label: `${chainSpec.name}:${previousLabel}->${label}`,
      referenceRecords, candidateRecords: chainRecords, mergeOk, mergeDigestEqual,
      expectedReusableUnitIds, actualReusedUnitIds,
      scanInvocations: { actual: chainScanInvocations, expected: expectedScanInvocations },
      inputComplete,
    });

    writeChainState(chainCacheRoot, {
      schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: chainSpec.name, step_index: index, label, pins: state.pins, producer_registry_digest: registryDigest,
    });

    steps.push(Object.freeze({
      step_index: index, label, pins: state.pins, role: 'hop', hop: `${previousLabel}->${label}`,
      out_dir: chainArmOut, reference_out_dir: referenceOut,
      cache_entries_before: cacheEntriesBefore, cache_entries_after: cacheEntriesAfter,
      reference_touched_chain_cache: referenceEntriesAfter !== referenceEntriesBefore,
      dispositions: dispositionCounts(chainReceipts),
      reference_dispositions: dispositionCounts(referenceReceipts),
      scan_invocations: { chain: chainScanInvocations, reference: referenceScanInvocations, expected: expectedScanInvocations },
      units: { expected: expectedUnits.length, expected_reusable: expectedReusableUnitIds.length, actual_reused: actualReusedUnitIds.length },
      merge: { chain: mergeChain, reference: mergeReference, digest_equal: mergeDigestEqual },
      scorer: score,
      valid_unit_ids: validUnitIds(chainReceipts),
    }));
    previousState = state;
  }

  const hopSteps = steps.filter(step => step.role === 'hop');
  const anyHopFailed = hopSteps.some(step => step.scorer.verdict === 'fail');
  const anyCacheDiscontinuity = hopSteps.some(step => {
    const previous = steps[steps.indexOf(step) - 1];
    return previous && step.cache_entries_before !== previous.cache_entries_after;
  });
  const anyReferenceTouchedCache = hopSteps.some(step => step.reference_touched_chain_cache);
  const verdict = hopSteps.length < 2 ? 'incomplete'
    : (anyHopFailed || anyCacheDiscontinuity || anyReferenceTouchedCache || seedCount !== 1) ? 'fail' : 'pass';
  const verdictReasons = [];
  if (hopSteps.length < 2) verdictReasons.push('fewer than 2 hops were run (A->B->C requires at least 2)');
  if (anyHopFailed) verdictReasons.push('one or more chain hops failed the shared case scorer — see each hop\u2019s scorer.reasons');
  if (anyCacheDiscontinuity) verdictReasons.push('cache entry count discontinuity between adjacent steps — the chain cache was silently reset or replaced');
  if (anyReferenceTouchedCache) verdictReasons.push('an isolated forced-full reference arm touched the chain cache — it must never read or warm it');
  if (seedCount !== 1) verdictReasons.push(`the chain cache was seeded ${seedCount} time(s); exactly 1 seed is required`);

  return Object.freeze({
    schema: CHAIN_RESULT_SCHEMA, chain: chainSpec.name, verdict, verdict_reasons: Object.freeze(verdictReasons),
    seed_count: seedCount, cache_root: chainCacheRoot,
    steps: Object.freeze(steps), work_dir: workDir,
  });
}
