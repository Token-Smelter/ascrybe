import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClaimMapShards, verifyClaimMapShards, writeClaimMapShards } from '../tools/claim-map-shards.mjs';
import { stableCanonicalSha256 } from '../tools/lib.mjs';

const roots = [];
test.after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

function mapFixture() {
  const body = {
    schema: 'estate-map/claim-evidence-map/v1',
    project: { id: 'fixture', sha: '1'.repeat(40) },
    policy: { denominator: 'all' },
    adjudication_receipts: [{ receipt_id: 'receipt:one', claim_id: 'claim:one' }],
    claims: [{ claim_id: 'claim:one', statement: 'One claim' }],
    edges: [{ edge_id: 'edge:one', relation: 'supported_by', from: 'claim:one', to: 'evidence:one' }],
    evidence: [{ evidence_id: 'evidence:one', kind: 'source' }],
    obligation_results: [{ result_id: 'result:one', claim_id: 'claim:one' }],
    supersession_receipts: [],
    coverage: { semantic_claims: 1, terminal_receipts: 1 },
  };
  return { ...body, digest: stableCanonicalSha256(body) };
}

function temporaryRoot() {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'claim-shards-'));
  roots.push(root); return root;
}

test('claim-map shards round-trip to the exact source map digest without one whole-map string', async () => {
  const map = mapFixture();
  const root = temporaryRoot();
  const manifest = await writeClaimMapShards({ map, output_dir: root });
  const loaded = await loadClaimMapShards(root);
  assert.deepEqual({
    digest: loaded.digest,
    claims: loaded.claims,
    fileCount: Object.keys(manifest.files).length,
    manifestBound: /^[0-9a-f]{64}$/u.test(manifest.manifest_digest),
  }, {
    digest: map.digest,
    claims: map.claims,
    fileCount: 6,
    manifestBound: true,
  });
});

test('claim-map shard verifier rejects byte mutation without source-map reconstruction', async () => {
  const root = temporaryRoot();
  await writeClaimMapShards({ map: mapFixture(), output_dir: root });
  appendFileSync(join(root, 'claims.jsonl'), '{}\n');
  await assert.rejects(() => verifyClaimMapShards(root),
    error => error.code === 'CLAIM_MAP_SHARD_CONTENT_MISMATCH');
});
