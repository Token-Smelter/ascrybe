#!/usr/bin/env node
// Active C2 sensitivity check: remove one exact production guard in an isolated managed-scratch
// module copy and prove the focused test turns red. Repository and operator store bytes are read-only.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();

const mutations = [
  {
    id: 'object_digest', pattern: 'object corruption, path/digest mismatch',
    old: "    if (!existsSync(path) || !statSync(path).isFile()) fail('MISSING_OBJECT', `missing object ${digest}`);\n    const bytes = readFileSync(path);\n    if (sha256(bytes) !== digest) fail('OBJECT_DIGEST_MISMATCH', `object path and bytes disagree for ${digest}`);\n",
    replacement: "    if (!existsSync(path) || !statSync(path).isFile()) fail('MISSING_OBJECT', `missing object ${digest}`);\n    const bytes = readFileSync(path);\n",
  },
  {
    id: 'semantic_id_bytes', pattern: 'object corruption, path/digest mismatch',
    old: "    if (prior && prior !== held.digest) {\n      fail('SEMANTIC_ID_BYTES_CHANGED', `semantic object ${held.semantic_id} was assigned changed bytes`);\n    }\n",
    replacement: '',
  },
  {
    id: 'duplicate_semantic_id', pattern: 'duplicate semantic IDs and explicit dangling',
    old: "    if (byId.has(held.semantic_id)) fail('DUPLICATE_SEMANTIC_ID', `duplicate semantic object ${held.semantic_id}`);\n",
    replacement: '',
  },
  {
    id: 'producer_identity_intake', pattern: 'forged producer identities are rejected at object intake',
    old: "    validateProducerIdentity(record, semanticId => {\n      const digest = semanticDigests.get(semanticId);\n      return digest ? this.readObject(digest) : null;\n    });\n",
    replacement: '',
  },
  {
    id: 'segment_integrity', pattern: 'segments are deterministic, restart-readable',
    old: "    if (manifest.schema !== SEGMENT_MANIFEST_SCHEMA || segmentId !== `segment:${sha256(canonicalBytes(body))}`\n      || segmentId !== reference.segment_id || sha256(bytes) !== manifest.content_digest\n      || sha256(Buffer.concat([Buffer.from(`${manifest.schema_version}\\0`, 'utf8'), bytes])) !== segmentDigest) {\n      fail('SEGMENT_INTEGRITY_MISMATCH', `segment ${segmentDigest} bytes or manifest changed`);\n    }\n",
    replacement: '',
  },
  {
    id: 'segment_reused', pattern: 'replay rejects a segment reused',
    old: "        if (usedSegments.has(reference.segment_id)) fail('SEGMENT_REUSED', `segment ${reference.segment_id} appears twice in one chain`);\n",
    replacement: '',
  },
  {
    id: 'commit_segment_mismatch', pattern: 'replay rejects commit additions',
    old: "      if (!exactEqual(segmentDigests, commit.added_object_digests)) {\n        fail('COMMIT_SEGMENT_MISMATCH', `GraphCommit ${commit.graph_commit_id} segment rows differ from added objects`);\n      }\n",
    replacement: '',
  },
  {
    id: 'missing_parent', pattern: 'GraphCommit parent replay is restart-readable',
    old: "    if (!existsSync(path)) fail('MISSING_GRAPH_COMMIT', `missing GraphCommit ${commitId}`);\n",
    replacement: '',
  },
  {
    id: 'commit_cycle', pattern: 'defensive GraphCommit cycle guard',
    old: "      if (seenCommits.has(current)) fail('GRAPH_COMMIT_CYCLE', `GraphCommit chain cycles at ${current}`);\n",
    replacement: "      if (seenCommits.has(current)) return { selected_object_map: {} };\n",
  },
  {
    id: 'dangling_dependency', pattern: 'duplicate semantic IDs and explicit dangling',
    old: "      if (!target) fail('DANGLING_DEPENDENCY_EDGE', `${held.semantic_id} depends on missing ${semanticId}`);\n      return { kind: 'object', semantic_id: semanticId, object_digest: target.digest };\n",
    replacement: "      if (!target) return { kind: 'external_head', head_type: 'source', head_id: heads.source };\n      return { kind: 'object', semantic_id: semanticId, object_digest: target.digest };\n",
  },
  {
    id: 'dependency_omission', pattern: 'dependency indexes commit exact content',
    old: "    if (selected.size !== index.entries.length) fail('DEPENDENCY_INDEX_OMISSION', 'dependency index does not cover the exact selected object map');\n",
    replacement: '',
  },
  {
    id: 'reuse_contract', pattern: 'reuse denies an unchanged dependent',
    old: '    return prior && exactEqual(prior, entry);\n',
    replacement: '    return prior && prior.object_digest === entry.object_digest;\n',
  },
  {
    id: 'serving_identity_edges', pattern: 'serving assertion identity provenance reaches',
    old: "      for (const row of record.selected_arguments || []) {\n        add(row.resolution_receipt_id); add(row.referent_id);\n        addAll(row.conflict_ids); addAll(row.blocking_constraint_ids);\n      }\n",
    replacement: '',
  },
  {
    id: 'commit_incomplete_set', pattern: 'selected terminal-incomplete receipts prevent',
    old: "      if (commit.claim_projection_status !== expectedStatus\n        || !exactEqual(commit.incomplete_claim_projection_receipt_ids, expectedReceiptIds)\n        || !exactEqual(commit.incomplete_claim_ids, expectedClaimIds)) {\n        fail('COMMIT_INCOMPLETE_SET_MISMATCH',\n          `GraphCommit ${commit.graph_commit_id} disagrees with selected terminal-incomplete receipts`);\n      }\n",
    replacement: '',
  },
  {
    id: 'supersession_receipt', pattern: 'supersession requires one exact receipt',
    old: "        if (!selected.has(semanticId) || !receiptByOld.has(semanticId)) {\n          fail('SUPERSESSION_WITHOUT_RECEIPT', `cannot supersede ${semanticId} without one exact receipt`);\n        }\n",
    replacement: '',
  },
  {
    id: 'tombstone_state', pattern: 'supersession requires one exact receipt',
    old: "        if (tombstoned.has(semanticId)) fail('DOUBLE_TOMBSTONE', `${semanticId} was tombstoned twice`);\n        if (!selected.has(semanticId) || commit.superseded_object_ids.includes(semanticId)) {\n          fail('INVALID_TOMBSTONE', `cannot tombstone absent or superseded ${semanticId}`);\n        }\n",
    replacement: '',
  },
  {
    id: 'resurrected_tombstone', pattern: 'replay rejects resurrection',
    old: "        if (tombstoned.has(semanticId)) fail('RESURRECTED_TOMBSTONE', `GraphCommit resurrects ${semanticId}`);\n",
    replacement: '',
  },
  {
    id: 'clean_equivalence', pattern: 'clean and incremental divergence',
    old: "  if (!exactEqual(actual?.selected_object_map, expected?.selected_object_map)\n    || !exactEqual(actual?.dependency_index, expected?.dependency_index)\n    || actual?.logical_graph_digest !== expected?.logical_graph_digest) {\n    fail('CLEAN_INCREMENTAL_DIVERGENCE', 'selected objects, dependencies, or logical graph digest diverged');\n  }\n",
    replacement: '',
  },
];

function replaceExactly(source, mutation) {
  const first = source.indexOf(mutation.old);
  if (first < 0 || source.indexOf(mutation.old, first + 1) >= 0) {
    throw new Error(`C2 negation ${mutation.id} no longer matches exactly one production guard`);
  }
  return `${source.slice(0, first)}${mutation.replacement}${source.slice(first + mutation.old.length)}`;
}

export function runC2SourceNegations() {
  const source = readFileSync(join(root, 'tools/canonical-graph-store.mjs'), 'utf8');
  const heldRoot = mkdtempSync(join(scratch, 'estate-map-c2-negation-'));
  try {
    for (const mutation of mutations) {
      const candidate = join(heldRoot, mutation.id);
      mkdirSync(join(candidate, 'tools'), { recursive: true });
      mkdirSync(join(candidate, 'tests'), { recursive: true });
      for (const name of [
        'claim-projection.mjs', 'argument-mentions.mjs', 'referent-identity.mjs',
        'serving-assertions.mjs', 'lib.mjs', 'readonly-guard.mjs',
      ]) {
        copyFileSync(join(root, 'tools', name), join(candidate, 'tools', name));
      }
      copyFileSync(join(root, 'tests/canonical-graph-store.test.mjs'),
        join(candidate, 'tests/canonical-graph-store.test.mjs'));
      writeFileSync(join(candidate, 'tools/canonical-graph-store.mjs'), replaceExactly(source, mutation));
      let turnedRed = false;
      try {
        execFileSync(process.execPath, [
          '--test', `--test-name-pattern=${mutation.pattern}`,
          'tests/canonical-graph-store.test.mjs',
        ], { cwd: candidate, encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
      } catch (error) {
        if (error.status != null && error.status !== 0) turnedRed = true;
        else throw error;
      }
      if (!turnedRed) throw new Error(`C2 production guard ${mutation.id} was removed but its focused test stayed green`);
      console.log(`PASS C2 source negation: ${mutation.id} removal turned focused test red`);
    }
    console.log(`PASS C2 source negations: ${mutations.length}/${mutations.length} exact production guards are test-sensitive`);
    return mutations.length;
  } finally {
    rmSync(heldRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runC2SourceNegations(); }
  catch (error) {
    console.error(`FAIL C2 source negations: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
