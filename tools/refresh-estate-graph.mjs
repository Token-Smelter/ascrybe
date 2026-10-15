#!/usr/bin/env node
// The supported update procedure, as ONE command (operator directive): given new pins and a prior
// run's retained answer journal(s), produce the new graph -- deterministic full code re-extraction
// (cheap; `ascrybe update`'s cached/reused code-fact extraction is not wired into this path, see
// note below), documentary-answer reuse from the named journals (paying only for changed windows),
// --require-model coverage (always on: this verb's whole point is a map that is provably pure in
// exactly one model, never a silent mix), and deterministic binding + projection -- and write ONE
// receipt naming what was reused versus paid.
//
// This composes four already-shipped, independently-tested primitives rather than reimplementing
// any of them: `runSemanticMap()` (tools/semantic-map-run.mjs) for extraction/binding,
// `remapCodePlane()` (scripts/remap.mjs) to derive the structural code graph from that SAME
// extraction, `writeOfflineProjectionArtifact()` (tools/delta/build-offline-projection.mjs) for the
// projection artifact, and `projectEstateMap()` (tools/project-estate-map.mjs) for the OPTIONAL
// staging step -- staging never promotes from this verb; promotion is a separate, deliberate, later
// action.
//
// NAMED, NOT WIRED (state which, per the operator's ask): `ascrybe update`'s per-file cache reuse
// (tools/delta-update-run.mjs, tools/delta/planner.mjs) is a SEPARATE code path from
// `runSemanticMap()`'s own `extractEstate()` call -- this verb always re-extracts code from scratch.
// That re-extraction is deterministic and its own cost is CPU/time, not model spend, so leaving it
// unwired is the simpler, already-reliable choice for now; wiring `ascrybe update`'s cached code
// facts into the binding step directly is real future work, not silently assumed done.
//
// CODE GRAPH: DEFAULT ON, EXPLICIT OFF (fixed; this verb previously silently defaulted the code
// graph to null regardless of caller intent). By default this verb also runs `remapCodePlane()`
// over the SAME extract+merge output `runSemanticMap()` just produced, so the projection it writes
// carries a real, non-null `code_graph_digest` and Module/Route/etc. structural population -- a
// documentary claim map alone is not "the full software graph" this verb promises by default.
// `documentary_only: true` is the one legitimate way to skip it, and the receipt's `mode` field
// says which happened -- a full-mode run can never report complete with a null code graph by
// accident; only a documentary-only run explicitly asks for one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSemanticMap } from './semantic-map-run.mjs';
import { writeOfflineProjectionArtifact } from './delta/build-offline-projection.mjs';
import { projectEstateMap } from './project-estate-map.mjs';
import { remapCodePlane } from '../scripts/remap.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const REFRESH_ESTATE_GRAPH_SCHEMA = 'estate-map/refresh-estate-graph-receipt/v1';
const canonical = value => stableStringify(value).trim();

function refreshError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  if (detail !== null) error.detail = detail;
  return error;
}

/**
 * Run the supported update procedure once: extract (full, deterministic), reuse documentary
 * answers from the named journals, bind, require single-model coverage, project, and optionally
 * stage (never promote) to a named test estate. Every step is a call into an already-shipped,
 * already-tested primitive; this function's only job is the composition and the combined receipt.
 */
export async function refreshEstateGraph({
  repository, repositories = null, config_path: configPath, runtime_config_path: runtimeConfigPath,
  reuse_journals: reuseJournals = [], code_graph_path: codeGraphPath = null, output_dir: outputDir,
  stage_runtime_config_path: stageRuntimeConfigPath = null, scratch_dir: scratchDir = null,
  documentary_only: documentaryOnly = false,
}) {
  if ((!repository && !repositories) || !configPath || !runtimeConfigPath || !outputDir || !isAbsolute(outputDir)) {
    throw refreshError('REFRESH_INPUT_INVALID',
      'a repository or repositories map, project config, runtime config, and absolute output directory are required');
  }
  if (documentaryOnly && codeGraphPath) {
    throw refreshError('REFRESH_INPUT_INVALID',
      'documentary_only and an explicit code_graph_path both name what the projection\'s code graph should be; pick one');
  }
  const claimsOutput = resolve(outputDir, 'claims');
  const mapped = await runSemanticMap({
    repository, repositories, config_path: configPath, runtime_config_path: runtimeConfigPath,
    output_dir: claimsOutput, scratch_dir: scratchDir, reuse_journals: reuseJournals,
    require_model: true,
  });

  // Derive the structural code graph from the SAME extract+merge output runSemanticMap() just
  // produced, unless the caller either opted out explicitly or already supplied one to reuse. A
  // caller-supplied path is honored as-is (e.g. reusing a code graph a prior run already derived,
  // when the code plane provably has not changed) rather than re-derived pointlessly.
  let remapCounts = null;
  let derivedCodeGraphPath = codeGraphPath;
  if (!documentaryOnly && !codeGraphPath) {
    const remapOutput = resolve(outputDir, 'remap');
    const configBody = JSON.parse(readFileSync(configPath, 'utf8'));
    remapCounts = remapCodePlane({
      work: mapped.scratch_root, sha: mapped.receipt.project.sha, out: remapOutput,
      // A single-repository config has no `source_pins` field at all (tools/source-pin-identity.mjs:
      // its own commit IS its identity); passing `undefined` through is exactly the "no pins" case
      // remapCodePlane already handles, never a guess at one.
      source_pins: configBody.source_pins ?? null,
    });
    derivedCodeGraphPath = resolve(remapOutput, 'adjacency.json');
  }

  const projectionOutput = resolve(outputDir, 'projection');
  mkdirSync(projectionOutput, { recursive: true });
  const { receipt: projectionReceipt } = await writeOfflineProjectionArtifact({
    claim_map_shards_dir: resolve(claimsOutput, 'claim-evidence-shards'),
    code_graph_path: derivedCodeGraphPath, output_dir: projectionOutput,
  });

  let staged = null;
  if (stageRuntimeConfigPath) {
    staged = await projectEstateMap({
      runtime_config: stageRuntimeConfigPath,
      claim_map_shards: resolve(claimsOutput, 'claim-evidence-shards'),
      code_graph: derivedCodeGraphPath, promote: false,
    });
  }

  const conservation = mapped.receipt.extraction.conservation;
  const body = {
    schema: REFRESH_ESTATE_GRAPH_SCHEMA,
    project: mapped.receipt.project,
    // Explicit, not inferable from a null-vs-populated code_graph_digest alone: a reader must never
    // have to guess whether a null digest means "asked for and produced nothing" or "never asked".
    mode: documentaryOnly ? 'documentary_only' : 'full_software_graph',
    code_graph: derivedCodeGraphPath
      ? { present: true, path: derivedCodeGraphPath, digest: projectionReceipt.source_artifacts?.code_graph_digest ?? null,
          derived: remapCounts !== null, counts: remapCounts }
      : { present: false, path: null, digest: null, derived: false, counts: null },
    // "What was reused versus paid", named explicitly rather than left to be inferred from the
    // extraction receipt's own field names.
    windows: {
      total: conservation.windows,
      answered_by_reuse: conservation.reused_journal_answers,
      answered_by_new_dispatch: conservation.model_calls,
      offline_refusals: conservation.offline_refusals,
    },
    model_coverage: conservation.model_coverage,
    cost_usd: {
      total: conservation.reported_cost_usd,
      marginal_this_run: conservation.marginal_cost_usd,
      reused_already_paid: conservation.reused_cost_usd,
    },
    documentary_reuse: mapped.receipt.documentary_reuse,
    claim_evidence_coverage: mapped.receipt.claim_evidence.coverage,
    projection: {
      projection_id: projectionReceipt.projection_id,
      content_digest: projectionReceipt.content_digest,
      counts: projectionReceipt.counts,
    },
    staged,
    output: { claims: claimsOutput, projection: projectionOutput },
  };
  const receipt = Object.freeze({ ...body, receipt_digest: sha256(canonical(body)) });
  writeFileSync(resolve(outputDir, 'refresh-receipt.json'), `${canonical(receipt)}\n`);
  return Object.freeze({ receipt, mapped, projection_receipt: projectionReceipt, staged });
}

function parse(argv) {
  const held = { reuse_journals: [] };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    // Boolean: never consumes a following token (tools/semantic-map-run.mjs's own parse() applies
    // the same rule for --offline/--require-model).
    if (flag === '--documentary-only') { held.documentary_only = true; index += 1; continue; }
    const value = argv[index + 1];
    if (!value) throw refreshError('REFRESH_ARGS_INVALID', `${flag} requires a value`);
    if (flag === '--repository') held.repository = resolve(value);
    else if (flag === '--config') held.config_path = resolve(value);
    else if (flag === '--runtime-config') held.runtime_config_path = resolve(value);
    else if (flag === '--output-dir') held.output_dir = resolve(value);
    else if (flag === '--scratch-dir') held.scratch_dir = resolve(value);
    else if (flag === '--code-graph') held.code_graph_path = resolve(value);
    else if (flag === '--stage-runtime-config') held.stage_runtime_config_path = resolve(value);
    else if (flag === '--reuse-journal') {
      const split = value.indexOf('=');
      if (split < 1) throw refreshError('REFRESH_ARGS_INVALID', '--reuse-journal requires label=path[@model]');
      const label = value.slice(0, split);
      const rest = value.slice(split + 1);
      const at = rest.lastIndexOf('@');
      const path = at < 0 ? rest : rest.slice(0, at);
      const model = at < 0 ? undefined : rest.slice(at + 1);
      held.reuse_journals.push({ label, path: resolve(path), ...(model ? { model } : {}) });
    } else throw refreshError('REFRESH_ARGS_INVALID', `unknown argument: ${flag}`);
    index += 2;
  }
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await refreshEstateGraph(parse(process.argv.slice(2)));
    console.log(`PASS refresh ${result.receipt.project.id}@${result.receipt.project.sha} mode=${result.receipt.mode}`);
    console.log(`PASS code_graph present=${result.receipt.code_graph.present} digest=${result.receipt.code_graph.digest}`);
    console.log(`PASS windows total=${result.receipt.windows.total} reused=${result.receipt.windows.answered_by_reuse} `
      + `new=${result.receipt.windows.answered_by_new_dispatch} refused=${result.receipt.windows.offline_refusals}`);
    console.log(`PASS model_coverage ${JSON.stringify(result.receipt.model_coverage)}`);
    console.log(`PASS cost_usd ${JSON.stringify(result.receipt.cost_usd)}`);
    console.log(`PASS projection ${result.receipt.projection.projection_id} digest=${result.receipt.projection.content_digest}`);
    if (result.receipt.staged) console.log(`PASS staged ${JSON.stringify(result.receipt.staged.staged)}`);
  } catch (error) {
    console.error(`FAIL refresh estate graph: ${error.stack || error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
