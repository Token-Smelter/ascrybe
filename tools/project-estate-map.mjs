#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { wholeFileJson } from './whole-file-json.mjs';
import { constants as bufferConstants } from 'node:buffer';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient } from './c3-serving-projection.mjs';
import { loadClaimMapShards } from './claim-map-shards.mjs';
import {
  buildUnifiedEstateProjection, promoteEstateProjection, pruneEstateProjections,
  readEstateProjectionHeads, stageEstateProjection,
} from './estate-graph-projection.mjs';
import {
  loadEstateMapRuntimeConfig, neo4jConnectionFromConfig,
} from './ascrybe-config.mjs';

/**
 * A whole claim map is read into one string, and a real one does not fit in one. The map for a
 * 1,154-document estate is 644,632,920 bytes against a 536,870,888-byte ceiling, so this path
 * fails with an opaque RangeError roughly a hundred megabytes past the limit and says nothing
 * about the sharded reader that streams instead. Refuse with directions rather than crash.
 */
export function readWholeClaimMap(path) {
  const bytes = statSync(path).size;
  if (bytes >= bufferConstants.MAX_STRING_LENGTH) {
    const error = new Error(`claim map is ${bytes.toLocaleString()} bytes and cannot be read whole `
      + `(this runtime holds at most ${bufferConstants.MAX_STRING_LENGTH.toLocaleString()}). Shard it first — `
      + 'node scripts/finalize-claim-map-shards.mjs <shard-directory> <source-metadata.json> — '
      + 'then pass --claim-map-shards.');
    error.code = 'ESTATE_PROJECTION_CLAIM_MAP_TOO_LARGE';
    error.detail = { path, bytes, ceiling: bufferConstants.MAX_STRING_LENGTH };
    throw error;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Growth toward the ceiling is reported while it is still avoidable, not discovered at the wall. */
function warnHeadroom({ label, bytes, ceiling, fraction }) {
  console.warn(`HEADROOM ${label} is ${bytes.toLocaleString()} of ${ceiling.toLocaleString()} bytes `
    + `(${(fraction * 100).toFixed(0)}% of what a single string can hold); it will need a streaming reader.`);
}

function argumentError(message) {
  const error = new Error(message); error.code = 'ESTATE_PROJECTION_ARGUMENT_INVALID'; return error;
}

function parse(argv) {
  const held = { promote: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--promote') { held.promote = true; continue; }
    if (flag === '--retain-superseded') {
      const held_value = argv[index + 1];
      if (!held_value) throw argumentError('--retain-superseded requires a value');
      index += 1;
      held.retain_superseded = Number(held_value);
      continue;
    }
    if (!['--runtime-config', '--claim-map', '--claim-map-shards', '--code-graph'].includes(flag)) {
      throw argumentError(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw argumentError(`${flag} requires a value`);
    index += 1;
    held[flag.slice(2).replaceAll('-', '_')] = resolve(value);
  }
  if (!held.runtime_config || Boolean(held.claim_map) === Boolean(held.claim_map_shards)) {
    throw argumentError('--runtime-config and exactly one of --claim-map or --claim-map-shards are required');
  }
  return held;
}

export async function projectEstateMap({ runtime_config: runtimeConfigPath,
  claim_map: claimMapPath = null, claim_map_shards: claimMapShards = null,
  code_graph: codeGraphPath = null, promote = false, retain_superseded: retain = 1 },
  environment = process.env) {
  const runtime = loadEstateMapRuntimeConfig(runtimeConfigPath);
  const claimMap = claimMapShards
    ? await loadClaimMapShards(claimMapShards)
    : readWholeClaimMap(resolve(claimMapPath));
  const codeGraph = codeGraphPath
    ? wholeFileJson(resolve(codeGraphPath), { label: 'code graph', onWarning: warnHeadroom })
    : null;
  const state = buildUnifiedEstateProjection({ claim_map: claimMap, code_graph: codeGraph });
  const client = new Neo4jHttpClient(neo4jConnectionFromConfig(runtime, environment));
  const estate = runtime.config.projection.estate;
  const before = await readEstateProjectionHeads(client, { estate });
  const staged = await stageEstateProjection({
    client, state, estate,
    batch_size: runtime.config.projection.batch_size,
    expected_working_projection_id: before.working?.projection_id || null,
  });
  const selected = !promote ? null
    : staged.status === 'already_selected'
      ? Object.freeze({ projection_id: state.projection_id, status: 'selected',
        content_digest: staged.content_digest, promotion: 'idempotent_existing_selection' })
      : await promoteEstateProjection({
        client, projection_id: state.projection_id, estate,
        expected_selected_projection_id: before.selected?.projection_id || null,
      });
  const pruned = selected ? await pruneEstateProjections({ client, retain_superseded: retain, estate }) : null;
  return Object.freeze({
    schema: 'estate-map/projection-run-receipt/v1',
    projection_id: state.projection_id,
    source_commit: state.project.sha,
    claim_map_digest: state.source_artifacts.claim_map_digest,
    code_graph_digest: state.source_artifacts.code_graph_digest,
    counts: state.counts,
    staged,
    selected,
    pruned,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await projectEstateMap(parse(process.argv.slice(2)));
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(`FAIL estate projection: ${error.stack || error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
