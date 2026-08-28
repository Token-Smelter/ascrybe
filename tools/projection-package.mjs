// A projection package: everything one Ascrybe user needs to rebuild another's graph, and nothing
// that would let them rebuild it WRONG and not notice.
//
// The package ships the projection's INPUTS, not the projection. A recipient who re-derives and
// lands on the same projection_id has proof the whole pipeline agreed; a recipient handed the
// finished rows would only have proof that nobody edited the file. Since projection identity is
// content-derived, that match is meaningful across machines and across estate names.
//
// What it does NOT carry: credentials, the runtime config's local paths, the Neo4j store (shared
// with unrelated estates), and the mapped source itself. What it DOES carry is the estate --
// verbatim quotes, file paths, symbol names. That is the point of the thing and the reason the
// disclosure below is printed rather than buried.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const PROJECTION_PACKAGE_SCHEMA = 'ascrybe/projection-package/v1';

const clean = value => String(value ?? '').trim();

function packageError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

const digestOf = path => sha256(readFileSync(path));

/** Every file under a directory, estate-relative, sorted so a manifest is byte-stable. */
export function filesUnder(root, base = root) {
  const held = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) held.push(...filesUnder(path, base));
    else if (entry.isFile()) held.push(relative(base, path));
  }
  return held.sort();
}

/**
 * What a recipient is being handed, in the terms that decide whether it may be sent at all.
 *
 * This is not a summary for the manifest's sake. A projection package is the estate: refusing to
 * state that plainly is how a bundle gets called "sanitized" because its CONFIG was sanitized.
 */
export function packageDisclosure({ shard_manifest: shardManifest, remap_receipt: remapReceipt = null,
  source_pins: sourcePins = null }) {
  const repositories = sourcePins ? Object.keys(sourcePins).sort() : [clean(shardManifest?.project?.id)].filter(Boolean);
  return Object.freeze({
    repositories,
    documents: Number(remapReceipt?.counts?.doc_documents ?? 0) || null,
    claims: Number(shardManifest?.coverage?.semantic_claims ?? 0) || null,
    // Claims carry the exact quote they were read from, and the code graph carries paths and
    // declaration names. Neither is derivable-but-harmless: both are the estate's own text.
    includes_verbatim_quotes: true,
    includes_source_paths: true,
    includes_mapped_source: false,
  });
}

function ascrybeCommit(repository, { allow_dirty: allowDirty }) {
  const at = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim();
  if (dirty && !allowDirty) {
    throw packageError('PROJECTION_PACKAGE_TREE_DIRTY',
      `packaging from a modified checkout would stamp ${at} on a bundle that commit did not produce, `
      + 'and the recipient re-derives against exactly that commit. Commit first, or pass --allow-dirty '
      + 'to record the drift in the manifest.');
  }
  return { commit: at, dirty: Boolean(dirty) };
}

export function buildProjectionPackage({ repository, claim_map_shards: shardsDir, code_graph: codeGraphPath,
  projection_receipt: projectionReceiptPath, remap_receipt: remapReceiptPath = null,
  semantic_receipt: semanticReceiptPath = null, out, allow_dirty: allowDirty = false }) {
  for (const [label, path] of [['--claim-map-shards', shardsDir], ['--code-graph', codeGraphPath],
    ['--projection-receipt', projectionReceiptPath], ['--out', out]]) {
    if (!clean(path)) throw packageError('PROJECTION_PACKAGE_ARGUMENT_INVALID', `${label} is required`);
  }
  const shardManifest = JSON.parse(readFileSync(join(shardsDir, 'manifest.json'), 'utf8'));
  const projectionReceipt = JSON.parse(readFileSync(projectionReceiptPath, 'utf8'));
  const remapReceipt = remapReceiptPath ? JSON.parse(readFileSync(remapReceiptPath, 'utf8')) : null;
  if (!clean(projectionReceipt.projection_id)) {
    throw packageError('PROJECTION_PACKAGE_RECEIPT_INVALID',
      'the projection receipt must name the projection_id the recipient is expected to reproduce');
  }
  if (projectionReceipt.claim_map_digest !== shardManifest.source_map_digest) {
    throw packageError('PROJECTION_PACKAGE_INPUTS_MISMATCHED',
      `the receipt was produced from claim map ${projectionReceipt.claim_map_digest} but these shards `
      + `carry ${shardManifest.source_map_digest}; the recipient could never reproduce it.`,
      { receipt: projectionReceipt.claim_map_digest, shards: shardManifest.source_map_digest });
  }

  const root = resolve(out);
  mkdirSync(join(root, 'claim-evidence-shards'), { recursive: true });
  mkdirSync(join(root, 'code-graph'), { recursive: true });
  mkdirSync(join(root, 'receipts'), { recursive: true });
  for (const name of filesUnder(shardsDir)) {
    const target = join(root, 'claim-evidence-shards', name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(shardsDir, name), target);
  }
  copyFileSync(codeGraphPath, join(root, 'code-graph', 'adjacency.json'));
  copyFileSync(projectionReceiptPath, join(root, 'receipts', 'projection-run-receipt.json'));
  if (remapReceiptPath) copyFileSync(remapReceiptPath, join(root, 'receipts', 'remap-receipt.json'));
  if (semanticReceiptPath) copyFileSync(semanticReceiptPath, join(root, 'receipts', 'semantic-map-run-receipt.json'));

  const { commit, dirty } = ascrybeCommit(repository, { allow_dirty: allowDirty });
  const files = filesUnder(root).map(path => ({
    path, bytes: statSync(join(root, path)).size, sha256: digestOf(join(root, path)),
  }));
  const manifest = {
    schema: PROJECTION_PACKAGE_SCHEMA,
    packaged_at_ascrybe_commit: commit,
    packaged_from_modified_checkout: dirty,
    project: shardManifest.project,
    source_pins: projectionReceipt.source_pins ?? null,
    // What re-derivation must land on for the package to have transported anything.
    expects: {
      projection_id: projectionReceipt.projection_id,
      claim_map_digest: projectionReceipt.claim_map_digest,
      code_graph_digest: projectionReceipt.code_graph_digest,
      nodes: projectionReceipt.counts?.nodes ?? null,
      edges: projectionReceipt.counts?.edges ?? null,
    },
    discloses: packageDisclosure({ shard_manifest: shardManifest, remap_receipt: remapReceipt,
      source_pins: projectionReceipt.source_pins ?? null }),
    files,
  };
  writeFileSync(join(root, 'MANIFEST.json'), stableStringify(manifest));
  return Object.freeze(manifest);
}

/** Whether the bytes arrived intact. Says nothing about whether they rebuild anything. */
export function verifyProjectionPackage(bundle) {
  const root = resolve(bundle);
  const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'));
  if (manifest.schema !== PROJECTION_PACKAGE_SCHEMA) {
    throw packageError('PROJECTION_PACKAGE_SCHEMA_UNSUPPORTED', `expected ${PROJECTION_PACKAGE_SCHEMA}`);
  }
  const declared = new Map(manifest.files.map(row => [row.path, row]));
  const present = new Set(filesUnder(root).filter(path => path !== 'MANIFEST.json'));
  const mismatched = [];
  for (const [path, row] of declared) {
    if (!present.has(path)) { mismatched.push({ path, reason: 'absent' }); continue; }
    if (digestOf(join(root, path)) !== row.sha256) mismatched.push({ path, reason: 'digest' });
  }
  // A file nobody declared is not a harmless extra: it travelled with the estate and no one said so.
  for (const path of present) if (!declared.has(path)) mismatched.push({ path, reason: 'undeclared' });
  return Object.freeze({ manifest, files_checked: declared.size, mismatched: Object.freeze(mismatched) });
}

/**
 * Rebuild a package's projection here, and report whether it came out the same.
 *
 * The comparison is the product. Staging succeeds either way; what a recipient needs to know is
 * whether the graph they now hold is the graph that was sent, and only the projection_id says so.
 */
export async function loadProjectionPackage({ bundle, runtime_config: runtimeConfigPath,
  promote = false, allow_version_drift: allowVersionDrift = false, repository = null },
  { projectEstateMap, repositoryCommit = null } = {}) {
  const verified = verifyProjectionPackage(bundle);
  if (verified.mismatched.length) {
    throw packageError('PROJECTION_PACKAGE_CORRUPT',
      `${verified.mismatched.length} of ${verified.files_checked} files did not match the manifest`,
      { mismatched: verified.mismatched });
  }
  const expected = verified.manifest.expects;
  const here = repositoryCommit ?? (repository
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim() : null);
  // Re-derivation only proves agreement when both sides ran the same code. A different commit can
  // still produce a graph -- it just cannot produce THIS one, and a mismatch would then be
  // indistinguishable from corruption.
  if (here && here !== verified.manifest.packaged_at_ascrybe_commit && !allowVersionDrift) {
    throw packageError('PROJECTION_PACKAGE_VERSION_DRIFT',
      `this package was built at Ascrybe ${verified.manifest.packaged_at_ascrybe_commit} and this `
      + `checkout is ${here}; check out that commit, or pass --allow-version-drift to rebuild anyway `
      + 'and read the projection_id comparison as advisory rather than proof.',
      { packaged_at: verified.manifest.packaged_at_ascrybe_commit, here });
  }
  const root = resolve(bundle);
  const receipt = await projectEstateMap({
    runtime_config: runtimeConfigPath,
    claim_map_shards: join(root, 'claim-evidence-shards'),
    code_graph: join(root, 'code-graph', 'adjacency.json'),
    promote,
  });
  const reproduced = receipt.projection_id === expected.projection_id;
  return Object.freeze({
    schema: 'ascrybe/projection-package-load-receipt/v1',
    reproduced,
    expected_projection_id: expected.projection_id,
    projection_id: receipt.projection_id,
    packaged_at_ascrybe_commit: verified.manifest.packaged_at_ascrybe_commit,
    loaded_at_ascrybe_commit: here,
    counts: { expected: { nodes: expected.nodes, edges: expected.edges }, here: receipt.counts },
    discloses: verified.manifest.discloses,
    staged: receipt.staged,
    selected: receipt.selected,
  });
}
