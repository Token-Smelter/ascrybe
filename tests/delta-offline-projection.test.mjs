// tools/delta/build-offline-projection.mjs: buildUnifiedEstateProjection() is a pure function, so
// this is the "produce a stageable projection offline" path -- it never opens a database
// connection, never stages a working generation, and never promotes. Every fixture name is
// invented (CONTRIBUTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOfflineProjectionArtifact, OFFLINE_PROJECTION_RECEIPT_SCHEMA, writeOfflineProjectionArtifact,
} from '../tools/delta/build-offline-projection.mjs';
import { buildUnifiedEstateProjection } from '../tools/estate-graph-projection.mjs';
import { writeClaimMapShards } from '../tools/claim-map-shards.mjs';
import { stableCanonicalSha256 } from '../tools/lib.mjs';

function claimMap() {
  const claim = {
    claim_id: 'estate-claim:one', claim_key: 'docs/design.md:4:one',
    statement: 'The map exposes exact provenance.', claim_kind: 'accepted_design',
    source_status: 'current', decision_status: 'accepted', valid_time: null,
    source: { path: 'docs/design.md', line: 4, quote: 'exact provenance',
      blob_oid: 'blob:one', content_sha256: 'a'.repeat(64) },
    proof_plan: { mode: 'all_required', obligations: [{ kind: 'code_symbol_declared' }] },
  };
  return {
    schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
    project: { id: 'invented-estate', sha: '1'.repeat(40) },
    claims: [claim], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [], coverage: { semantic_claims: 1, terminal_receipts: 0 }, policy: {},
  };
}

test('the offline projection artifact is exactly what buildUnifiedEstateProjection would return', () => {
  const map = claimMap();
  const direct = buildUnifiedEstateProjection({ claim_map: map });
  const { projection, receipt } = buildOfflineProjectionArtifact({ claim_map: map });
  assert.equal(projection.content_digest, direct.content_digest);
  assert.equal(projection.projection_id, direct.projection_id);
  assert.equal(receipt.schema, OFFLINE_PROJECTION_RECEIPT_SCHEMA);
  assert.equal(receipt.content_digest, direct.content_digest);
  assert.deepEqual(receipt.counts, direct.counts);
});

test('writing the artifact to disk round-trips to the same content digest and never imports a database client', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'offline-projection-'));
  try {
    const claimMapPath = join(root, 'claim-map.json');
    writeFileSync(claimMapPath, JSON.stringify(claimMap()));
    const outputDir = join(root, 'out');
    const { receipt } = await writeOfflineProjectionArtifact({ claim_map_path: claimMapPath, output_dir: outputDir });

    assert.ok(existsSync(join(outputDir, 'projection-nodes.jsonl')));
    assert.ok(existsSync(join(outputDir, 'projection-edges.jsonl')));
    const written = JSON.parse(readFileSync(join(outputDir, 'offline-projection-receipt.json'), 'utf8'));
    assert.equal(written.receipt_digest, receipt.receipt_digest);
    assert.equal(written.content_digest, receipt.content_digest);

    const nodeLines = readFileSync(join(outputDir, 'projection-nodes.jsonl'), 'utf8').trim().split('\n');
    assert.ok(nodeLines.length > 0);
    assert.ok(JSON.parse(nodeLines[0]).node_id);

    const source = readFileSync(new URL('../tools/delta/build-offline-projection.mjs', import.meta.url), 'utf8');
    assert.equal(source.includes('c3-serving-projection.mjs') || source.includes('Neo4j'), false,
      'the offline builder must never import a database client');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A real 1.59M-edge corpus threw `RangeError: Invalid string length` from exactly this pattern:
// `rows.map(JSON.stringify).join('\n')` materializes every row into ONE string before writing.
// This never needs a fixture anywhere near that scale: injecting a writer proves the CALL SHAPE
// (the raw rows array reaches the writer untouched) rather than re-triggering the crash directly.
test('node and edge rows reach the writer as a raw array, never pre-joined into one string', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'offline-projection-injected-'));
  try {
    const claimMapPath = join(root, 'claim-map.json');
    writeFileSync(claimMapPath, JSON.stringify(claimMap()));
    const calls = [];
    const spyWriter = async (path, rows) => { calls.push({ path, rows }); };
    await writeOfflineProjectionArtifact({
      claim_map_path: claimMapPath, output_dir: join(root, 'out'), write_json_lines: spyWriter,
    });
    assert.equal(calls.length, 2, 'exactly one write call for nodes, one for edges');
    for (const { rows } of calls) {
      assert.ok(Array.isArray(rows), 'the writer receives the rows array itself');
      assert.equal(typeof rows, 'object', 'never a pre-joined string');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('build-offline-projection.mjs never reintroduces Array.map(...).join(...) to write rows', () => {
  const source = readFileSync(new URL('../tools/delta/build-offline-projection.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.map\([^)]*\)\.join\(/u,
    'writing node/edge rows must stream through tools/lib.mjs#writeJsonLines, never join them into one string');
});

test('two runs of the same inputs produce byte-identical projection output (pure function, no clock/random dependency)', () => {
  const map = claimMap();
  const first = buildOfflineProjectionArtifact({ claim_map: map });
  const second = buildOfflineProjectionArtifact({ claim_map: map });
  assert.equal(first.projection.content_digest, second.projection.content_digest);
  assert.equal(first.receipt.receipt_digest, second.receipt.receipt_digest);
});

test('--claim-map-shards produces the exact same projection as --claim-map, for a claim map too large to read as one string', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'offline-projection-shards-'));
  try {
    const { digest, ...body } = claimMap();
    const map = { ...body, digest: stableCanonicalSha256(body) };
    const claimMapPath = join(root, 'claim-map.json');
    writeFileSync(claimMapPath, JSON.stringify(map));
    const wholeFileOut = join(root, 'out-whole');
    const { receipt: wholeFileReceipt } = await writeOfflineProjectionArtifact({ claim_map_path: claimMapPath, output_dir: wholeFileOut });

    const shardsDir = join(root, 'shards');
    await writeClaimMapShards({ map, output_dir: shardsDir });
    const shardsOut = join(root, 'out-shards');
    const { receipt: shardsReceipt } = await writeOfflineProjectionArtifact({ claim_map_shards_dir: shardsDir, output_dir: shardsOut });

    assert.equal(shardsReceipt.content_digest, wholeFileReceipt.content_digest);
    assert.equal(shardsReceipt.projection_id, wholeFileReceipt.projection_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--claim-map and --claim-map-shards are mutually exclusive, and one of them is required', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'offline-projection-input-'));
  try {
    await assert.rejects(
      () => writeOfflineProjectionArtifact({ output_dir: join(root, 'out') }),
      { code: 'OFFLINE_PROJECTION_INPUT_INVALID' });
    await assert.rejects(
      () => writeOfflineProjectionArtifact({
        claim_map_path: join(root, 'a.json'), claim_map_shards_dir: join(root, 'b'), output_dir: join(root, 'out'),
      }),
      { code: 'OFFLINE_PROJECTION_INPUT_INVALID' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
