import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync,
} from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { stableCanonicalSha256, stableStringify } from './lib.mjs';

export const CLAIM_MAP_SHARD_MANIFEST_SCHEMA = 'estate-map/claim-evidence-shards/v1';
const canonical = value => stableStringify(value).trim();
const shardKeys = Object.freeze([
  'adjudication_receipts', 'claims', 'edges', 'evidence',
  'obligation_results', 'supersession_receipts',
]);

export class ClaimMapShardError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimMapShardError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new ClaimMapShardError(code, message, detail);
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function writeShard(root, key, rows) {
  const path = `${key}.jsonl`;
  const stream = createWriteStream(join(root, path), { encoding: 'utf8', mode: 0o600 });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      hash.update(line); bytes += Buffer.byteLength(line);
      await writeLine(stream, line);
    }
    stream.end(); await once(stream, 'finish');
  } catch (error) { stream.destroy(); throw error; }
  return Object.freeze({ path, count: rows.length, bytes, sha256: hash.digest('hex') });
}

async function writeManifest(root, metadata, files) {
  const manifestBody = {
    schema: CLAIM_MAP_SHARD_MANIFEST_SCHEMA,
    source_schema: metadata.schema,
    source_map_digest: metadata.digest,
    project: metadata.project,
    policy: metadata.policy,
    coverage: metadata.coverage,
    files,
  };
  const manifest = Object.freeze({ ...manifestBody,
    manifest_digest: stableCanonicalSha256(manifestBody) });
  await new Promise((resolvePromise, reject) => {
    const stream = createWriteStream(join(root, 'manifest.json'), { encoding: 'utf8', mode: 0o600 });
    stream.once('error', reject); stream.end(`${canonical(manifest)}\n`, resolvePromise);
  });
  return manifest;
}

/** Write bounded-line claim-map shards while retaining the exact original map digest. */
export async function writeClaimMapShards({ map, output_dir: outputDir }) {
  if (map?.schema !== 'estate-map/claim-evidence-map/v1' || !map.digest) {
    fail('CLAIM_MAP_SHARD_INPUT_INVALID', 'sharding requires one digested claim-evidence map');
  }
  const { digest, ...body } = map;
  if (stableCanonicalSha256(body) !== digest) {
    fail('CLAIM_MAP_SHARD_SOURCE_DIGEST_MISMATCH', 'claim map differs from its declared digest');
  }
  const root = resolve(outputDir);
  mkdirSync(root, { recursive: true });
  const files = {};
  for (const key of shardKeys) {
    if (!Array.isArray(map[key])) fail('CLAIM_MAP_SHARD_INPUT_INVALID', `claim map ${key} must be an array`);
    files[key] = await writeShard(root, key, map[key]);
  }
  return writeManifest(root, map, files);
}

async function inspectExistingShard(root, key) {
  const path = resolve(root, `${key}.jsonl`);
  if (!existsSync(path)) fail('CLAIM_MAP_SHARD_PATH_INVALID', `claim-map shard ${key} is absent`);
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  const text = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: text, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    try { JSON.parse(line); }
    catch { fail('CLAIM_MAP_SHARD_JSON_INVALID', `claim-map shard ${key} contains invalid JSON`); }
    count += 1;
  }
  return Object.freeze({ path: `${key}.jsonl`, count, bytes, sha256: hash.digest('hex') });
}

/** Finalize externally streamed JSONL shards without loading their arrays into memory. */
export async function finalizeClaimMapShards({ output_dir: outputDir, source_metadata: metadata }) {
  if (metadata?.schema !== 'estate-map/claim-evidence-map/v1' || !metadata.digest
    || !metadata.project || !metadata.policy || !metadata.coverage) {
    fail('CLAIM_MAP_SHARD_INPUT_INVALID', 'shard finalization requires exact source metadata');
  }
  const root = resolve(outputDir);
  const files = {};
  for (const key of shardKeys) files[key] = await inspectExistingShard(root, key);
  return writeManifest(root, metadata, files);
}

export function validateClaimMapShardManifest(manifest) {
  if (manifest?.schema !== CLAIM_MAP_SHARD_MANIFEST_SCHEMA
    || manifest.source_schema !== 'estate-map/claim-evidence-map/v1'
    || !/^[0-9a-f]{64}$/u.test(manifest.source_map_digest || '')
    || typeof manifest.project?.id !== 'string' || !manifest.project.id
    || !/^[0-9a-f]{40}$/u.test(manifest.project?.sha || '')
    || !manifest.policy || !manifest.coverage) {
    fail('CLAIM_MAP_SHARD_MANIFEST_INVALID', 'claim-map shard manifest is incomplete');
  }
  const { manifest_digest: digest, ...body } = manifest;
  if (stableCanonicalSha256(body) !== digest) {
    fail('CLAIM_MAP_SHARD_MANIFEST_DIGEST_MISMATCH', 'claim-map shard manifest digest differs');
  }
  if (Object.keys(manifest.files || {}).sort().join('\0') !== shardKeys.slice().sort().join('\0')) {
    fail('CLAIM_MAP_SHARD_MANIFEST_INVALID', 'claim-map shard file set differs from its closed contract');
  }
  for (const key of shardKeys) {
    const entry = manifest.files[key];
    if (entry?.path !== `${key}.jsonl` || !Number.isInteger(entry.count) || entry.count < 0
      || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256 || '')) {
      fail('CLAIM_MAP_SHARD_MANIFEST_INVALID', `claim-map shard ${key} metadata is invalid`);
    }
  }
  return true;
}

/** Verify a shard set and return its source-map identity without reconstructing the full map. */
export async function verifyClaimMapShards(rootPath) {
  const root = resolve(rootPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
  catch (error) {
    fail('CLAIM_MAP_SHARD_MANIFEST_READ_FAILED', 'cannot read claim-map shard manifest', {
      cause: error.code || error.message,
    });
  }
  validateClaimMapShardManifest(manifest);
  for (const key of shardKeys) {
    const observed = await inspectExistingShard(root, key);
    const expected = manifest.files[key];
    if (canonical(observed) !== canonical(expected)) {
      fail('CLAIM_MAP_SHARD_CONTENT_MISMATCH', `claim-map shard ${key} count, bytes, or digest differs`, {
        expected, actual: observed,
      });
    }
  }
  return Object.freeze(manifest);
}

async function readShard(root, key, entry) {
  const path = resolve(root, entry.path);
  if (path !== resolve(root, `${key}.jsonl`) || !existsSync(path)) {
    fail('CLAIM_MAP_SHARD_PATH_INVALID', `claim-map shard ${key} is absent or escapes its root`);
  }
  const fileBytes = statSync(path).size;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const rows = [];
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const line of lines) {
    const exact = `${line}\n`;
    hash.update(exact); bytes += Buffer.byteLength(exact);
    try { rows.push(JSON.parse(line)); }
    catch { fail('CLAIM_MAP_SHARD_JSON_INVALID', `claim-map shard ${key} contains invalid JSON`); }
  }
  const digest = hash.digest('hex');
  if (rows.length !== entry.count || bytes !== entry.bytes || fileBytes !== entry.bytes
    || digest !== entry.sha256) {
    fail('CLAIM_MAP_SHARD_CONTENT_MISMATCH', `claim-map shard ${key} count, bytes, or digest differs`, {
      expected: entry, actual: { count: rows.length, bytes: fileBytes, sha256: digest },
    });
  }
  return rows;
}

/** Load a corpus-scale claim map without ever materializing its full JSON text. */
export async function loadClaimMapShards(rootPath) {
  const root = resolve(rootPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
  catch (error) {
    fail('CLAIM_MAP_SHARD_MANIFEST_READ_FAILED', 'cannot read claim-map shard manifest', {
      cause: error.code || error.message,
    });
  }
  validateClaimMapShardManifest(manifest);
  const arrays = {};
  for (const key of shardKeys) arrays[key] = await readShard(root, key, manifest.files[key]);
  const body = {
    schema: manifest.source_schema,
    project: manifest.project,
    policy: manifest.policy,
    ...arrays,
    coverage: manifest.coverage,
  };
  if (stableCanonicalSha256(body) !== manifest.source_map_digest) {
    fail('CLAIM_MAP_SHARD_SOURCE_DIGEST_MISMATCH',
      'reconstructed claim map differs from its exact source digest');
  }
  return Object.freeze({ ...body, digest: manifest.source_map_digest });
}
