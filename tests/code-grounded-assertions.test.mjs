import test from 'node:test';
import { extractorAvailabilityReceipt } from '../tools/extractors/index.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodeGroundedAssertions, CODE_FACT_PROJECTION_RECEIPT_SCHEMA,
} from '../tools/code-grounded-assertions.mjs';
import { groundedAssertionId } from '../tools/serving-assertions.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const sourceHead = '90ec8527ca8fa5957dc52e91d25414ff5980e1fd';
const manifest = {
  corpus_manifest_digest: 'corpus:fixture',
  // Completeness is the gate, so the fixture mirrors whatever the registry currently registers
  // rather than pinning a count that a new extractor would falsify.
  extractor_availability: { available: extractorAvailabilityReceipt.available.map((_, index) => ({ index })) },
  extractor_exclusions: [],
  scanned_manifest: { scanner_source_closure_digest: 'closure:fixture' },
};

function fixture(facts) {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'c4-adapter-'));
  const factKindInventory = [...facts.reduce((counts, fact) => {
    counts.set(fact.kind, (counts.get(fact.kind) || 0) + 1); return counts;
  }, new Map())].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind));
  const mergeGraph = { fact_kind_inventory: factKindInventory };
  const factsDir = join(root, 'facts');
  mkdirSync(factsDir);
  writeFileSync(join(factsDir, 'component.jsonl'), `${facts.map(row => JSON.stringify(row)).join('\n')}\n`);
  return {
    root,
    build: () => buildCodeGroundedAssertions({
      facts_dir: root,
      extract_manifest: manifest,
      merge_graph: mergeGraph,
      merge_graph_digest: sha256(stableStringify(mergeGraph)),
      source_head: sourceHead,
      recorded_time: '2026-08-02T11:19:50-07:00',
    }),
  };
}

test('code mentions claim no provenance the producer did not determine', () => {
  // Design section 16: the prior constant 'production_document' asserted a
  // classification nothing computed, labelling e2e fixtures and test doubles as
  // production. This producer determines no provenance; the witnessing path is
  // retained on every fact so consumers classify at read time.
  const held = fixture([
    { kind: 'sqlite_table', repo: 'api', file: 'src/schema.sql', line: 3, table: 'jobs' },
    { kind: 'sqlite_table', repo: 'api', file: 'e2e/fixtures/mock.sql', line: 5, table: 'fake_jobs' },
  ]);
  try {
    const plane = held.build();
    assert.deepEqual({
      candidates: plane.identity_candidates.length,
      provenance: [...new Set(plane.identity_candidates.map(row => row.mention.provenance_class))],
      paths_retained: plane.identity_candidates.map(row => row.record.file).sort(),
    }, {
      candidates: 2,
      provenance: ['unclassified'],
      paths_retained: ['e2e/fixtures/mock.sql', 'src/schema.sql'],
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('every runtime fact becomes one grounded observation, evidence pointer, and typed receipt', () => {
  const held = fixture([
    { kind: 'sqlite_table', repo: 'api', file: 'schema.sql', line: 3, table: 'jobs' },
    { kind: 'http_route', repo: 'api', file: 'routes.mjs', line: 7, route: '/jobs' },
  ]);
  try {
    const plane = held.build();
    assert.deepEqual({
      inventory: plane.inventory.fact_kind_inventory,
      assertions: plane.grounded_assertions.length,
      evidence: plane.grounding_registry.evidence_pointers.length,
      receipts: plane.projection_receipts.length,
      dispositions: [...new Set(plane.projection_receipts.map(row => row.disposition))],
      schemas: [...new Set(plane.projection_receipts.map(row => row.schema))],
    }, {
      inventory: [{ kind: 'http_route', count: 1 }, { kind: 'sqlite_table', count: 1 }],
      assertions: 2, evidence: 2, receipts: 2,
      dispositions: ['excluded_from_semantic_projection'], schemas: [CODE_FACT_PROJECTION_RECEIPT_SCHEMA],
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('grounded identity is producer-valid and changes with exact fact content', () => {
  const first = fixture([{ kind: 'yaml_record', repo: 'worker', file: 'config.yaml', line: 2, value: 'a' }]);
  const second = fixture([{ kind: 'yaml_record', repo: 'worker', file: 'config.yaml', line: 2, value: 'b' }]);
  try {
    const left = first.build().grounded_assertions[0];
    const right = second.build().grounded_assertions[0];
    assert.deepEqual({
      producer_valid: left.assertion_id === groundedAssertionId(left),
      content_sensitive: left.assertion_id !== right.assertion_id,
    }, { producer_valid: true, content_sensitive: true });
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test('project-card schema records become explicit identity candidates without losing the exact record', () => {
  const held = fixture([
    { kind: 'yaml_record', repo: 'design', file: 'canon/schemas/project_card.v1.yaml', line: 21,
      key_path: '$schema', value: 'http://json-schema.org/draft-07/schema#', value_type: 'string' },
    { kind: 'yaml_record', repo: 'design', file: 'orchestrator/schemas/project_card.v2.yaml', line: 2,
      key_path: '$id', value: 'https://example.invalid/schemas/project_card.v2.yaml', value_type: 'string' },
  ]);
  try {
    const plane = held.build();
    assert.equal(plane.identity_candidates.length, 2);
    assert.deepEqual(plane.identity_candidates.map(row => row.record.key_path).sort(), ['$id', '$schema']);
    for (const candidate of plane.identity_candidates) {
      const assertion = plane.grounded_assertions.find(row => row.arguments
        .some(binding => binding.mention_id === candidate.mention.mention_id));
      assert.deepEqual(assertion.arguments.find(binding => binding.role === 'object').literal, candidate.record);
    }
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('structured evidence digest recomputes from the canonical exact record', () => {
  const held = fixture([{ kind: 'envelope_flow', repo: 'bus', file: 'events.mjs', line: 9, direction: 'emit' }]);
  try {
    const pointer = held.build().grounding_registry.evidence_pointers[0].pointer;
    assert.equal(pointer.digest, sha256(stableStringify(pointer.exact_value).trim()));
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});
