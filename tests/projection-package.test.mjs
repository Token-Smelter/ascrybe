import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectionPackage, loadProjectionPackage, packageDisclosure, verifyProjectionPackage }
  from '../tools/projection-package.mjs';

const CLAIM_MAP_DIGEST = 'a'.repeat(64);

function fixture() {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'package-'));
  const shards = join(root, 'shards');
  mkdirSync(shards, { recursive: true });
  writeFileSync(join(shards, 'claims.jsonl'), '{"claim_id":"c1"}\n');
  writeFileSync(join(shards, 'manifest.json'), JSON.stringify({
    schema: 'estate-map/claim-evidence-shards/v1',
    source_map_digest: CLAIM_MAP_DIGEST,
    project: { id: 'fixture', sha: '1'.repeat(40) },
    coverage: { semantic_claims: 12 },
    files: { claims: { path: 'claims.jsonl', bytes: 18, count: 1, sha256: 'b'.repeat(64) } },
  }));
  const codeGraph = join(root, 'adjacency.json');
  writeFileSync(codeGraph, JSON.stringify({ nodes: {}, edges: [] }));
  const receipt = join(root, 'projection-run-receipt.json');
  writeFileSync(receipt, JSON.stringify({
    schema: 'estate-map/projection-run-receipt/v1',
    projection_id: 'estate-projection:' + 'c'.repeat(64),
    claim_map_digest: CLAIM_MAP_DIGEST,
    code_graph_digest: 'd'.repeat(64),
    source_pins: { alpha: '2'.repeat(40), beta: '3'.repeat(40) },
    counts: { nodes: 7, edges: 9 },
  }));
  return { root, shards, codeGraph, receipt, out: join(root, 'bundle') };
}

test('a package states what it carries rather than implying it was cleaned', () => {
  const held = packageDisclosure({
    shard_manifest: { project: { id: 'fixture' }, coverage: { semantic_claims: 12 } },
    remap_receipt: { counts: { doc_documents: 5 } },
    source_pins: { beta: 'x', alpha: 'y' },
  });
  assert.deepEqual(held.repositories, ['alpha', 'beta']);
  assert.equal(held.claims, 12);
  assert.equal(held.documents, 5);
  // The bundle is the estate. A package that did not say so is the failure this field exists for.
  assert.equal(held.includes_verbatim_quotes, true);
  assert.equal(held.includes_source_paths, true);
  assert.equal(held.includes_mapped_source, false);
});

test('packing refuses inputs that could not have produced the receipt', () => {
  const { root, shards, codeGraph, receipt, out } = fixture();
  try {
    const manifest = JSON.parse(readFileSync(join(shards, 'manifest.json'), 'utf8'));
    manifest.source_map_digest = 'e'.repeat(64);
    writeFileSync(join(shards, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => buildProjectionPackage({ repository: process.cwd(), claim_map_shards: shards,
      code_graph: codeGraph, projection_receipt: receipt, out, allow_dirty: true }),
    error => error.code === 'PROJECTION_PACKAGE_INPUTS_MISMATCHED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verification catches a corrupted, missing, or undeclared file', () => {
  const { root, shards, codeGraph, receipt, out } = fixture();
  try {
    buildProjectionPackage({ repository: process.cwd(), claim_map_shards: shards, code_graph: codeGraph,
      projection_receipt: receipt, out, allow_dirty: true });
    assert.deepEqual(verifyProjectionPackage(out).mismatched, []);

    writeFileSync(join(out, 'code-graph', 'adjacency.json'), '{"nodes":{},"edges":[1]}');
    assert.deepEqual(verifyProjectionPackage(out).mismatched,
      [{ path: 'code-graph/adjacency.json', reason: 'digest' }]);

    // A file that rode along undeclared travelled with the estate and nobody said so.
    writeFileSync(join(out, 'code-graph', 'stowaway.json'), '{}');
    const held = verifyProjectionPackage(out).mismatched;
    assert.ok(held.some(row => row.path === 'code-graph/stowaway.json' && row.reason === 'undeclared'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loading reports whether the projection was reproduced, not merely staged', async () => {
  const { root, shards, codeGraph, receipt, out } = fixture();
  try {
    const manifest = buildProjectionPackage({ repository: process.cwd(), claim_map_shards: shards,
      code_graph: codeGraph, projection_receipt: receipt, out, allow_dirty: true });

    const agreeing = await loadProjectionPackage({ bundle: out, runtime_config: 'unused' },
      { repositoryCommit: manifest.packaged_at_ascrybe_commit,
        projectEstateMap: async () => ({ projection_id: manifest.expects.projection_id,
          counts: { nodes: 7, edges: 9 }, staged: { status: 'ready' }, selected: null }) });
    assert.equal(agreeing.reproduced, true);

    // Staging succeeded here too. Only the identity comparison tells the recipient it is not the
    // graph that was sent, which is why it is the headline rather than an aside.
    const diverging = await loadProjectionPackage({ bundle: out, runtime_config: 'unused' },
      { repositoryCommit: manifest.packaged_at_ascrybe_commit,
        projectEstateMap: async () => ({ projection_id: 'estate-projection:' + 'f'.repeat(64),
          counts: { nodes: 7, edges: 9 }, staged: { status: 'ready' }, selected: null }) });
    assert.equal(diverging.reproduced, false);
    assert.equal(diverging.expected_projection_id, manifest.expects.projection_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loading refuses a checkout that could not reproduce the package', async () => {
  const { root, shards, codeGraph, receipt, out } = fixture();
  try {
    buildProjectionPackage({ repository: process.cwd(), claim_map_shards: shards, code_graph: codeGraph,
      projection_receipt: receipt, out, allow_dirty: true });
    await assert.rejects(() => loadProjectionPackage({ bundle: out, runtime_config: 'unused' },
      { repositoryCommit: '9'.repeat(40), projectEstateMap: async () => { throw new Error('must not run'); } }),
    error => error.code === 'PROJECTION_PACKAGE_VERSION_DRIFT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
