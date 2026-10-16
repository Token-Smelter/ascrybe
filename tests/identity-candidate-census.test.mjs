import test from 'node:test';
import { extractorAvailabilityReceipt } from '../tools/extractors/index.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentityCandidateCensus } from '../scripts/build-identity-candidate-census.mjs';

const sourceHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixture(rows) {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'identity-census-'));
  const extractDir = join(root, 'extract');
  const factsDir = join(extractDir, 'facts');
  mkdirSync(factsDir, { recursive: true });
  writeFileSync(join(factsDir, 'component.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const manifestPath = join(extractDir, '_MANIFEST.json');
  writeFileSync(manifestPath, JSON.stringify({
    corpus_manifest_digest: 'fixture-corpus',
    scanned_manifest: { scanner_source_closure_digest: 'fixture-closure' },
    extractor_availability: { available: extractorAvailabilityReceipt.available.map((_, index) => ({ index })) },
    extractor_exclusions: [],
  }));
  const counts = [...rows.reduce((held, row) => held.set(row.kind, (held.get(row.kind) || 0) + 1), new Map())]
    .map(([kind, count]) => ({ kind, count })).sort((left, right) => left.kind.localeCompare(right.kind));
  const mergePath = join(root, 'estate-graph.json');
  writeFileSync(mergePath, JSON.stringify({ fact_kind_inventory: counts }));
  return {
    root,
    build: () => buildIdentityCandidateCensus({
      extractDir, extractManifest: manifestPath, mergeGraph: mergePath, sourceHead,
    }),
  };
}

test('census admits only complete parser-emitted symbol declarations', () => {
  const held = fixture([
    { kind: 'symbol', repo: 'app', file: 'src/a.ts', line: 1, name: 'Widget', symbol_kind: 'class', scope_path: ['Widget'] },
    { kind: 'symbol', repo: 'app', file: 'src/b.ts', line: 1, name: 'Widget', symbol_kind: 'class', scope_path: ['Widget'] },
    { kind: 'symbol', repo: 'app', file: 'src/a.ts', line: 2, name: 'Widget' },
    { kind: 'reference', repo: 'app', file: 'src/a.ts', line: 9, name: 'Widget' },
  ]);
  try {
    const census = held.build();
    const symbol = census.kinds.find(row => row.kind === 'symbol');
    const reference = census.kinds.find(row => row.kind === 'reference');
    assert.deepEqual({
      basis: census.compiler_registry.symbol.basis_field_paths,
      symbol_admissible: symbol.currently_admissible_count,
      symbol_incomplete: symbol.refused_counts_by_reason.symbol_declaration_incomplete,
      reference_status: reference.candidate_status,
      reference_admissible: reference.currently_admissible_count,
    }, {
      basis: ['$.repo', '$.file', '$.symbol_kind', '$.scope_path'],
      symbol_admissible: 2,
      symbol_incomplete: 1,
      reference_status: 'refused_kind',
      reference_admissible: 0,
    });
  } finally {
    rmSync(held.root, { recursive: true, force: true });
  }
});

test('census resolves manifest routes through the implemented route and refuses every SQLite duplicate-key member', () => {
  const held = fixture([
    { kind: 'manifest_route_declaration', repo: 'plugins', file: 'a/plugin.yaml', line: 2, owner: 'a', method: 'GET', path: '/x' },
    { kind: 'sqlite_table', repo: 'core', file: 'schema.mjs', line: 3, table: 'jobs' },
    { kind: 'sqlite_table', repo: 'core', file: 'schema.mjs', line: 9, table: 'jobs' },
    { kind: 'sqlite_table', repo: 'core', file: 'schema.mjs', line: 14, table: 'receipts' },
  ]);
  try {
    const census = held.build();
    const route = census.kinds.find(row => row.kind === 'manifest_route_declaration');
    const sqlite = census.kinds.find(row => row.kind === 'sqlite_table');
    assert.deepEqual({
      route_admissible: route.currently_admissible_count,
      route_refused: route.refused_counts_by_reason.route_declared_in_manifest_resolved_through_http_route,
      sqlite_admissible: sqlite.currently_admissible_count,
      sqlite_duplicate_refused: sqlite.refused_counts_by_reason.duplicate_declaration_key,
      sqlite_partition: sqlite.eligible_fact_ids.length
        + Object.values(sqlite.refused_fact_ids_by_reason).flat().length,
    }, {
      route_admissible: 0,
      route_refused: 1,
      sqlite_admissible: 1,
      sqlite_duplicate_refused: 2,
      sqlite_partition: 3,
    });
  } finally {
    rmSync(held.root, { recursive: true, force: true });
  }
});

test('census admits exact untyped YAML paths while keeping malformed declarations and YAML leaves refused', () => {
  const held = fixture([
    { kind: 'yaml_document', repo: 'app', file: 'checks/fast.yaml', line: 1, api_version: null, doc_id: null, doc_name: null },
    { kind: 'yaml_document', repo: 'app', file: 'checks/fast.yaml', line: 2, api_version: null, doc_id: null, doc_name: null },
    { kind: 'yaml_document', repo: 'app', file: 'checks/slow.yaml', line: 1, api_version: null, doc_id: null, doc_name: null },
    { kind: 'yaml_document', repo: 'app', file: 'checks/invalid.yaml', line: 1, api_version: 'v2', doc_id: 'not-a-versioned-family', doc_name: null },
    { kind: 'yaml_document', repo: 'app', file: 'plugins/missing/plugin.yaml', line: 1, api_version: null, doc_id: null, doc_name: null },
    { kind: 'yaml_record', repo: 'app', file: 'checks/slow.yaml', line: 2, key_path: 'delivery.timeout', value: '30', value_type: 'string' },
  ]);
  try {
    const census = held.build();
    const yaml = census.kinds.find(row => row.kind === 'yaml_document');
    const record = census.kinds.find(row => row.kind === 'yaml_record');
    assert.deepEqual({
      admissible: yaml.currently_admissible_count,
      duplicate_paths: yaml.refused_counts_by_reason.duplicate_declaration_key,
      invalid_typed: yaml.refused_counts_by_reason.document_identity_contract_unpinned,
      missing_plugin_name: yaml.refused_counts_by_reason.plugin_manifest_name_unwitnessed,
      yaml_leaf_refusal: record.refused_counts_by_reason.yaml_leaf_observation,
    }, {
      admissible: 1,
      duplicate_paths: 2,
      invalid_typed: 1,
      missing_plugin_name: 1,
      yaml_leaf_refusal: 1,
    });
  } finally {
    rmSync(held.root, { recursive: true, force: true });
  }
});
