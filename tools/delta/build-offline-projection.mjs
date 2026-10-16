#!/usr/bin/env node
// An offline, stageable projection: `tools/estate-graph-projection.mjs` `buildUnifiedEstateProjection()`
// is a pure function of a claim-evidence map and an optional code graph -- it never opens a
// database connection. This CLI is that same pure function driven from disk, so a delta candidate's
// projection can be built and compared BY CONTENT DIGEST without ever calling
// `stageEstateProjection()`/`promoteEstateProjection()` and without touching what a `selected` or
// `working` generation serves. It is the "produce a stageable projection offline" path
// docs/delta-updatable-estate-maps.md's rollout calls for: compare two projection content digests
// before anyone decides whether either should ever be staged for real.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify, writeJsonLines } from '../lib.mjs';
import { buildUnifiedEstateProjection } from '../estate-graph-projection.mjs';
import { loadClaimMapShards } from '../claim-map-shards.mjs';

export const OFFLINE_PROJECTION_RECEIPT_SCHEMA = 'estate-map/offline-projection-receipt/v1';
const canonical = value => stableStringify(value).trim();

function buildError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Pure: build the projection and its receipt in memory. No filesystem, no database. */
export function buildOfflineProjectionArtifact({ claim_map: claimMap, code_graph: codeGraph = null }) {
  const projection = buildUnifiedEstateProjection({ claim_map: claimMap, code_graph: codeGraph });
  const body = {
    schema: OFFLINE_PROJECTION_RECEIPT_SCHEMA,
    projection_id: projection.projection_id,
    content_digest: projection.content_digest,
    project: projection.project,
    source_artifacts: projection.source_artifacts,
    counts: projection.counts,
  };
  const receipt = Object.freeze({ ...body, receipt_digest: sha256(canonical(body)) });
  return Object.freeze({ projection, receipt });
}

export async function writeOfflineProjectionArtifact({
  claim_map_path: claimMapPath, claim_map_shards_dir: claimMapShardsDir = null,
  code_graph_path: codeGraphPath = null, output_dir: outputDir,
  write_json_lines: writeLines = writeJsonLines,
}) {
  if ((!claimMapPath && !claimMapShardsDir) || (claimMapPath && claimMapShardsDir) || !outputDir) {
    throw buildError('OFFLINE_PROJECTION_INPUT_INVALID',
      'exactly one of a claim-map path or a claim-map shards directory, and an output directory, are required');
  }
  // Shards avoid materializing the entire map as one string, which can exceed V8's
  // string-size ceiling before JSON.parse runs. Whole-file input remains for small maps.
  const claimMap = claimMapShardsDir
    ? await loadClaimMapShards(resolve(claimMapShardsDir))
    : JSON.parse(readFileSync(resolve(claimMapPath), 'utf8'));
  const codeGraph = codeGraphPath ? JSON.parse(readFileSync(resolve(codeGraphPath), 'utf8')) : null;
  const { projection, receipt } = buildOfflineProjectionArtifact({ claim_map: claimMap, code_graph: codeGraph });
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  await writeLines(join(output, 'projection-nodes.jsonl'), projection.nodes);
  await writeLines(join(output, 'projection-edges.jsonl'), projection.edges);
  writeFileSync(join(output, 'offline-projection-receipt.json'), `${canonical({ ...receipt, built_at: new Date().toISOString() })}\n`);
  return Object.freeze({ output, receipt });
}

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw buildError('OFFLINE_PROJECTION_ARGUMENT_INVALID', `${flag} requires a value`);
    if (flag === '--claim-map') held.claim_map_path = resolve(value);
    else if (flag === '--claim-map-shards') held.claim_map_shards_dir = resolve(value);
    else if (flag === '--code-graph') held.code_graph_path = resolve(value);
    else if (flag === '--output') held.output_dir = resolve(value);
    else throw buildError('OFFLINE_PROJECTION_ARGUMENT_INVALID', `unknown argument: ${flag}`);
  }
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, receipt } = await writeOfflineProjectionArtifact(parse(process.argv.slice(2)));
    console.log(`PASS offline projection ${receipt.projection_id}`);
    console.log(`PASS content_digest ${receipt.content_digest}`);
    console.log(`PASS nodes=${receipt.counts.nodes} edges=${receipt.counts.edges} -> ${output}`);
  } catch (error) {
    console.error(`FAIL offline projection: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
