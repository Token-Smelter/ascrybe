#!/usr/bin/env node
// Explicit C2 builder boundary. The operator supplies the store root; no repository path is a
// default. Generated canonical objects remain local/ignored and are never written to runs/recall.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDependencyIndex, CanonicalGraphStore, semanticObjectId,
} from './canonical-graph-store.mjs';

export function deterministicComponentBatches({ records, producer_dependencies, batch_count = 3 }) {
  if (!Number.isInteger(batch_count) || batch_count < 1) throw new Error('batch_count must be positive');
  const index = buildDependencyIndex({
    records,
    external_heads: {
      source: producer_dependencies.source_head,
      identity: producer_dependencies.identity_head || '',
      ontology: producer_dependencies.ontology_head || '',
      argument_substrate: producer_dependencies.argument_substrate_head || '',
      claim_plane: producer_dependencies.claim_plane_head || '',
      code_plane: producer_dependencies.code_plane_head || '',
    },
    validation_contract: producer_dependencies.validation_contract,
  });
  const parent = new Map(index.entries.map(entry => [entry.semantic_id, entry.semantic_id]));
  const find = id => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    let held = id;
    while (parent.get(held) !== held) {
      const next = parent.get(held); parent.set(held, current); held = next;
    }
    return current;
  };
  const union = (left, right) => {
    const a = find(left), b = find(right);
    if (a === b) return;
    if (a.localeCompare(b) < 0) parent.set(b, a); else parent.set(a, b);
  };
  for (const entry of index.entries) for (const dependency of entry.dependencies) {
    if (dependency.kind === 'object' && parent.has(dependency.semantic_id)) {
      union(entry.semantic_id, dependency.semantic_id);
    }
  }
  const components = new Map();
  for (const id of parent.keys()) {
    const root = find(id), held = components.get(root) || [];
    held.push(id); components.set(root, held);
  }
  const groups = [...components.values()].map(ids => ids.sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
  const count = Math.min(batch_count, groups.length);
  const assignments = Array.from({ length: count }, () => []), sizes = Array(count).fill(0);
  for (const group of groups) {
    let selected = 0;
    for (let index_ = 1; index_ < count; index_++) if (sizes[index_] < sizes[selected]) selected = index_;
    assignments[selected].push(...group); sizes[selected] += group.length;
  }
  const recordById = new Map(records.map(record => [semanticObjectId(record), record]));
  return assignments.map(ids => ids.sort().map(id => recordById.get(id)));
}

export function buildC2Store({ root, records, producer_dependencies, batches = [records] }) {
  const store = new CanonicalGraphStore(root);
  const selected = [], selectedIds = new Set(), selectedRecordById = new Map();
  let parent = null;
  for (const batch of batches) {
    const additions = batch.slice().sort((left, right) =>
      semanticObjectId(left).localeCompare(semanticObjectId(right)));
    for (const record of additions) {
      const id = semanticObjectId(record);
      if (selectedIds.has(id)) throw new Error(`incremental batch repeats semantic object ${id}`);
      selectedIds.add(id); selected.push(record); selectedRecordById.set(id, record);
    }
    // Producer verification may need records later in semantic-ID order (for example, an
    // identity-constraint sorts before its endpoint Mentions). Validate against the exact selected
    // batch closure without changing object, segment, or commit ordering.
    const written = additions.map(record => store.writeObject(record, {
      validation_lookup: semanticId => selectedRecordById.get(semanticId) || null,
    }));
    const dependencyIndex = buildDependencyIndex({
      records: selected,
      external_heads: {
        source: producer_dependencies.source_head,
        identity: producer_dependencies.identity_head || '',
        ontology: producer_dependencies.ontology_head || '',
        argument_substrate: producer_dependencies.argument_substrate_head || '',
        claim_plane: producer_dependencies.claim_plane_head || '',
        code_plane: producer_dependencies.code_plane_head || '',
      },
      validation_contract: producer_dependencies.validation_contract,
    });
    const indexObject = store.writeObject(dependencyIndex);
    const segment = store.writeSegment(written.map(row => ({
      semantic_id: row.semantic_id, object_digest: row.digest,
    })).sort((left, right) => left.semantic_id.localeCompare(right.semantic_id)));
    const projectionReceipts = selected.filter(row => row.schema === 'estate-map/claim-projection-receipt/v1');
    const commit = store.writeCommit({
      parent_graph_commit_id: parent,
      source_head: producer_dependencies.source_head,
      identity_head: producer_dependencies.identity_head,
      ontology_head: producer_dependencies.ontology_head,
      added_object_digests: written.map(row => row.digest),
      segment_references: [segment],
      claim_projection_receipts: projectionReceipts,
      dependency_index_digest: indexObject.digest,
    });
    parent = commit.graph_commit_id;
  }
  if (!parent) throw new Error('C2 store build requires at least one non-empty batch');
  store.advanceReadableHead(parent);
  return Object.freeze({ store, head: parent, replay: store.replay(parent) });
}

export function buildC2DeclaredStore(root, input) {
  if (!input || !Array.isArray(input.semantic_records) || !input.producer_dependencies) {
    throw new Error('C2_INPUT_REQUIRED: declare semantic_records and producer_dependencies');
  }
  return buildC2Store({ root, records: input.semantic_records, producer_dependencies: input.producer_dependencies });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const inputPath = process.argv[3];
  if (!target || !inputPath || process.argv.length !== 4) {
    console.error('usage: node tools/c2-build-graph-store.mjs <store-directory> <input.json>');
    process.exitCode = 2;
  } else {
    try {
      const result = buildC2DeclaredStore(target, JSON.parse(readFileSync(inputPath, 'utf8')));
      console.log(`PASS C2 store: ${Object.keys(result.replay.selected_object_map).length} semantic objects; head ${result.head}; logical digest ${result.replay.logical_graph_digest}`);
    } catch (error) {
      console.error(`FAIL C2 store: ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  }
}
