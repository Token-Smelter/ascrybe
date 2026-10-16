#!/usr/bin/env node
// Exact identity-candidate census over a C4 extract payload.
//
// Usage:
//   node scripts/build-identity-candidate-census.mjs \
//     --extract-dir <extract-dir> --merge-graph <estate-graph.json> [--out <file>]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeGroundedAssertions } from '../tools/code-grounded-assertions.mjs';
import { stableStringify } from '../tools/lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { console.error(`FAIL identity-candidate-census: ${message}`); process.exit(1); };
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const rowDigest = row => sha256(canonical(row));
const present = value => value !== undefined && value !== null && String(value).trim() !== '';
const nameableScopePath = value => Array.isArray(value) && value.length > 0
  && value.every(part => present(part));
const sorted = values => [...values].sort((left, right) => left.localeCompare(right));

// Path-class heuristic for review only; never an identity or admission input.
const FIXTURE_PATH = /(^|\/)(tests?|__tests__|fixtures?|e2e|examples?|mocks?|__mocks__)(\/|$)/iu;
const pathClass = row => (FIXTURE_PATH.test(String(row.file ?? '')) ? 'fixture_or_test_path' : 'production_like_path');
const WILDCARD = /[*#>?]/u;

const dependency = (id, status, source_path = null) => Object.freeze({ id, status, source_path });
const sourceDependency = path => dependency(
  `source:${path}@sha256:${sha256(readFileSync(resolve(root, path)))}`,
  'resolved',
  path,
);
const pendingDependency = id => dependency(id, 'unpinned');

const COMPILERS = Object.freeze({
  capability_flow: {
    id: 'estate-map/compiler/capability-flow-declaration', version: '1.0.0',
    rule: 'direction==provide with a declared capability_type and owner; identity is the declared capability type within the repository capability namespace. A required or called capability is a reference, never a declaration.',
    basis_fields: ['$.direction', '$.owner', '$.capability_type'],
    dependencies: [sourceDependency('tools/extractors/capabilities.mjs'),
      dependency('contract:capability-identity@1', 'resolved')],
    test: row => row.direction === 'provide' && present(row.capability_type) && present(row.owner),
    refusal: row => (row.direction !== 'provide'
      ? 'capability_reference_not_declaration'
      : 'capability_declaration_incomplete'),
  },
  envelope_flow: {
    id: 'estate-map/compiler/envelope-publisher-declaration', version: '1.0.0',
    rule: "idiom=='manifest_publishes' with a literal non-wildcard envelope_kind; identity is the declared kind within the repository envelope namespace. A code-site emit or consume is a reference, never a declaration.",
    basis_fields: ['$.idiom', '$.envelope_kind'],
    dependencies: [sourceDependency('tools/extractors/envelopes.mjs'),
      dependency('contract:envelope-identity@1', 'resolved')],
    test: row => row.idiom === 'manifest_publishes'
      && present(row.envelope_kind) && !WILDCARD.test(String(row.envelope_kind)),
    refusal: row => (row.idiom !== 'manifest_publishes' ? 'envelope_reference_not_declaration'
      : 'envelope_declaration_incomplete'),
  },
  http_route: {
    id: 'estate-map/compiler/http-route-declaration', version: '1.0.0',
    rule: 'owner non-null && declared_route present; identity inputs limited to owner+framework+method+$.declared_route',
    basis_fields: ['$.owner', '$.framework', '$.method', '$.declared_route'],
    dependencies: [sourceDependency('tools/extractors/http.mjs')],
    test: row => present(row.declared_route) && present(row.owner),
    refusal: () => 'route_declaration_unwitnessed',
  },
  manifest_route_declaration: {
    id: 'estate-map/compiler/manifest-route-declaration', version: '1.0.0',
    rule: 'a manifest route declaration names a route the implementation also declares; identity resolves through the implemented http_route, so this row contributes evidence rather than a separate entity',
    basis_fields: ['$.owner', '$.method', '$.path'],
    dependencies: [sourceDependency('tools/extractors/capabilities.mjs'),
      dependency('contract:manifest-route-resolves-through-http-route@1', 'resolved')],
    test: () => false,
    refusal: () => 'route_declared_in_manifest_resolved_through_http_route',
  },
  module: {
    id: 'estate-map/compiler/module-declaration', version: '1.0.0',
    rule: 'exact parsed source file at its component-relative path; language is the parse witness; duplicate repo+file paths refuse every member',
    basis_fields: ['$.repo', '$.file'],
    dependencies: [
      sourceDependency('tools/extractors/treesitter-js.mjs'),
      sourceDependency('tools/extractors/treesitter-python.mjs'),
      sourceDependency('tools/extractors/treesitter-kotlin.mjs'),
      sourceDependency('tools/extractors/treesitter-swift.mjs'),
      sourceDependency('tools/extractors/treesitter-csharp.mjs'),
    ],
    test: row => present(row.language),
    refusal: () => 'module_language_unwitnessed',
  },
  package_manifest: {
    id: 'estate-map/compiler/package-manifest-declaration', version: '1.0.0',
    rule: 'all rows (corpus-scoped package namespace)', basis_fields: ['$.manifest_kind', '$.package_name'],
    dependencies: [sourceDependency('tools/extractors/dependencies.mjs')], test: () => true, refusal: () => 'unreachable',
  },
  repo: {
    id: 'estate-map/compiler/repository-declaration', version: '1.0.0',
    rule: 'all rows (scanned-manifest component namespace)', basis_fields: ['$.repo', '$.root'],
    dependencies: [], test: () => true, refusal: () => 'unreachable',
  },
  sql_object: {
    id: 'estate-map/compiler/sql-object-declaration', version: '1.0.0',
    rule: 'all rows; provenance partition applies', basis_fields: ['$.repo', '$.file', '$.object_kind', '$.object'],
    dependencies: [sourceDependency('tools/extractors/sql.mjs')], test: () => true, refusal: () => 'unreachable',
  },
  symbol: {
    id: 'estate-map/compiler/symbol-declaration', version: '1.0.0',
    rule: 'parser-emitted declaration with exact repository, file, declaration kind, name, and a wholly nameable enclosing scope path; a non-nameable scope is observed but never identity-bearing',
    basis_fields: ['$.repo', '$.file', '$.symbol_kind', '$.scope_path'],
    dependencies: [
      sourceDependency('tools/extractors/treesitter-js.mjs'),
      sourceDependency('tools/extractors/treesitter-python.mjs'),
      sourceDependency('tools/extractors/treesitter-kotlin.mjs'),
      sourceDependency('tools/extractors/treesitter-swift.mjs'),
      sourceDependency('tools/extractors/treesitter-csharp.mjs'),
    ],
    test: row => present(row.repo) && present(row.file) && present(row.symbol_kind) && present(row.name)
      && nameableScopePath(row.scope_path),
    refusal: row => (!present(row.repo) || !present(row.file) || !present(row.symbol_kind) || !present(row.name)
      ? 'symbol_declaration_incomplete' : 'declaration_scope_not_nameable'),
  },
  sqlite_table: {
    id: 'estate-map/compiler/sqlite-table-declaration', version: '1.0.0',
    rule: 'exact-file-version declaration scope; local ID is qualified_name when present, otherwise table; all members of a duplicate equivalence-key group refuse',
    basis_fields: ['$.repo', '$.file', '$.qualified_name', '$.table'],
    dependencies: [sourceDependency('tools/extractors/sqlite-ddl.mjs')],
    declaration_source_version: {
      grain: 'exact_file_at_pinned_source_head',
      fields: ['source_head', '$.repo', '$.file'],
      id_algorithm: 'file-version:sha256(canonical({source_head,repo,file}))',
    },
    declaration_scope_fields: ['$.repo', '$.file'],
    local_id_fields: ['$.qualified_name when non-null', '$.table otherwise'],
    duplicate_key_equivalence: ['declaration_source_version_id', '$.repo', '$.file', 'local_id'],
    duplicate_refusal: 'refuse every member with duplicate_declaration_key',
    test: () => true,
    refusal: () => 'unreachable',
  },
  tf_declaration: {
    id: 'estate-map/compiler/terraform-declaration', version: '1.0.0', rule: 'all rows',
    basis_fields: ['$.repo', '$.module_path', '$.declaration_kind', '$.name'], dependencies: [sourceDependency('tools/extractors/hcl.mjs')],
    test: () => true, refusal: () => 'unreachable',
  },
  tf_module_call: {
    id: 'estate-map/compiler/terraform-module-call', version: '1.0.0', rule: 'all rows (module-instance grain)',
    basis_fields: ['$.repo', '$.module_path', '$.name'], dependencies: [sourceDependency('tools/extractors/hcl.mjs')],
    test: () => true, refusal: () => 'unreachable',
  },
  tf_resource: {
    id: 'estate-map/compiler/terraform-resource', version: '1.0.0', rule: 'all rows (declared $.address)',
    basis_fields: ['$.repo', '$.module_path', '$.address'], dependencies: [sourceDependency('tools/extractors/hcl.mjs')],
    test: () => true, refusal: () => 'unreachable',
  },
  yaml_document: {
    id: 'estate-map/compiler/yaml-document-declaration', version: '1.0.0',
    rule: 'a plugin manifest declares its own name; a typed document declares api_version plus doc_id; every non-plugin document without that pair declares its identity mechanically by exact component-relative file path in the repository yaml-document namespace. Invalid declared typed pairs refuse.',
    basis_fields: ['$.repo', '$.file', '$.api_version', '$.doc_id', '$.doc_name'],
    dependencies: [sourceDependency('tools/extractors/yaml-catalog.mjs'),
      dependency('contract:yaml-document-identity@1', 'resolved')],
    duplicate_key_equivalence: ['$.repo', 'plugin $.doc_name or typed $.api_version+$.doc_id or untyped $.file'],
    duplicate_refusal: 'refuse every member with duplicate_declaration_key',
    test: row => {
      const pluginManifest = /(^|\/)plugin\.yaml$/u.test(String(row.file));
      const typedPair = present(row.doc_id) && present(row.api_version);
      return pluginManifest ? present(row.doc_name)
        : !typedPair || /^[a-z][\w.-]*\/v\d+$/iu.test(String(row.api_version));
    },
    refusal: row => {
      if (/(^|\/)plugin\.yaml$/u.test(String(row.file))) return 'plugin_manifest_name_unwitnessed';
      return present(row.doc_id) && present(row.api_version)
        ? 'document_identity_contract_unpinned' : 'unreachable';
    },
  },
  json_document: {
    id: 'estate-map/compiler/json-document-declaration', version: '1.0.0',
    rule: 'exact parsed JSON configuration file at its component-relative path in the repository json-document namespace; duplicate repo+file paths refuse every member',
    basis_fields: ['$.repo', '$.file'],
    dependencies: [sourceDependency('tools/extractors/config.mjs')],
    duplicate_key_equivalence: ['$.repo', '$.file'],
    duplicate_refusal: 'refuse every member with duplicate_declaration_key',
    test: () => true,
    refusal: () => 'unreachable',
  },
});

const REFUSED_KIND_REASONS = Object.freeze({
  aws_usage: 'usage_reference_not_declaration', capability_refusal: 'typed_extractor_refusal',
  config_key: 'declared_config_identity_deferred', config_value_template: 'partially_dynamic_value',
  config_value_url: 'url_text_not_identity', coverage: 'scan_diagnostic', dep: 'dependency_reference',
  derived_value_producer: 'derived_field_witness_only', envelope_dynamic_site: 'dynamic_envelope_reference',
  envelope_kind_mention: 'surface_mention_only', http_client: 'http_call_reference',
  http_route_refusal: 'typed_extractor_refusal', manifest_comment: 'prose_observation',
  manifest_key_alias: 'alias_evidence_only', manifest_key_presence: 'key_presence_observation',
  manifest_key_validation: 'validation_wiring_observation', sql_dml: 'statement_reference',
  sql_migration: 'migration_operation_reference', sqlite_comment: 'ddl_prose_observation',
  sqlite_id_column: 'parent_table_identity_unwitnessed', sqlite_ref: 'foreign_key_relation_evidence',
  tf_ref: 'terraform_reference_edge', tf_workspace: 'generated_state_not_authored_declaration',
  yaml_record: 'yaml_leaf_observation', yaml_record_refusal: 'typed_extractor_refusal',
});

const getField = (row, fieldPath) => row[fieldPath.replace(/^\$\./u, '')];
const fileVersionId = (row, sourceHead) => `file-version:${sha256(canonical({
  source_head: sourceHead, repo: row.repo, file: row.file,
}))}`;
const sqliteLocalId = row => present(row.qualified_name) ? String(row.qualified_name) : String(row.table);
const sqliteDuplicateKey = (row, sourceHead) => canonical([
  fileVersionId(row, sourceHead), row.repo, row.file, sqliteLocalId(row),
]);

function exactRows(extractDir) {
  const factsDir = existsSync(join(extractDir, 'facts')) ? join(extractDir, 'facts') : extractDir;
  const files = readdirSync(factsDir).filter(name => name.endsWith('.jsonl')).sort();
  if (!files.length) throw new Error(`no facts *.jsonl under ${factsDir}`);
  const rows = files.flatMap(file => readFileSync(join(factsDir, file), 'utf8').split(/\r?\n/u)
    .filter(Boolean).map((line, index) => ({
      output_name: file,
      output_path: `facts/${file}`,
      record_selector: `jsonl:${index + 1}`,
      exact_record_bytes: line,
      row: JSON.parse(line),
    })));
  return { files, rows };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === '--extract-dir' && value) args.extractDir = resolve(value);
    else if (flag === '--extract-manifest' && value) args.extractManifest = resolve(value);
    else if (flag === '--merge-graph' && value) args.mergeGraph = resolve(value);
    else if (flag === '--source-head' && value) args.sourceHead = value;
    else if (flag === '--out' && value) args.out = resolve(value);
    else fail(`unknown or valueless argument: ${flag}`);
  }
  if (!args.extractDir) fail('--extract-dir is required');
  args.extractManifest ||= join(args.extractDir, '_MANIFEST.json');
  if (!args.sourceHead) throw new Error('SOURCE_PIN_REQUIRED: pass --source-head');
  if (!args.mergeGraph) fail('--merge-graph is required');
  return args;
}

export function buildIdentityCandidateCensus({ extractDir, extractManifest, mergeGraph, sourceHead }) {
  const exact = exactRows(extractDir);
  const manifest = JSON.parse(readFileSync(extractManifest, 'utf8'));
  const graph = JSON.parse(readFileSync(mergeGraph, 'utf8'));
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractDir,
    extract_manifest: manifest,
    merge_graph: graph,
    merge_graph_digest: sha256(stableStringify(graph)),
    source_head: sourceHead,
    required_source_head: sourceHead,
    recorded_time: '1970-01-01T00:00:00.000Z',
  });
  const factIds = new Map(codePlane.inventory.records.map(record => [
    `${record.output_path}\u0000${record.record_selector}`, record.fact_id,
  ]));
  const kinds = new Map();
  const nonNameableDeclarationsByModule = new Map();
  for (const record of exact.rows) {
    if (record.row.kind === 'symbol' && !nameableScopePath(record.row.scope_path)) {
      const key = canonical([record.row.repo, record.row.file]);
      nonNameableDeclarationsByModule.set(key, (nonNameableDeclarationsByModule.get(key) || 0) + 1);
    }
      const row = record.row;
      const factId = factIds.get(`${record.output_path}\u0000${record.record_selector}`);
      if (!factId) throw new Error(`producer inventory omitted ${record.output_path} ${record.record_selector}`);
      const entry = kinds.get(row.kind) ?? kinds.set(row.kind, {
        fields: new Map(), classes: new Map(), records: [],
      }).get(row.kind);
      for (const key of Object.keys(row)) entry.fields.set(key, (entry.fields.get(key) || 0) + 1);
      const cls = pathClass(row);
      entry.classes.set(cls, (entry.classes.get(cls) || 0) + 1);
      entry.records.push({ ...record, fact_id: factId, row, path_class: cls, row_digest: rowDigest(row) });
  }

  const perKind = [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([kind, entry]) => {
    const compiler = COMPILERS[kind];
    const candidates = [], eligible = [], refused = new Map();
    const refuse = (reason, factId) => {
      const ids = refused.get(reason) || [];
      ids.push(factId);
      refused.set(reason, ids);
    };
    for (const record of entry.records) {
      if (!compiler) {
        refuse(REFUSED_KIND_REASONS[kind] || 'kind_not_identity_eligible', record.fact_id);
      } else if (!compiler.test(record.row)) {
        refuse(compiler.refusal(record.row), record.fact_id);
      } else {
        candidates.push(record);
      }
    }
    const pending = compiler?.dependencies.some(item => item.status !== 'resolved');
    if (pending) {
      for (const record of candidates) refuse(compiler.pending_refusal, record.fact_id);
    } else if (kind === 'module') {
      const groups = new Map();
      for (const record of candidates) {
        const key = canonical([record.row.repo, record.row.file]);
        const held = groups.get(key) || [];
        held.push(record);
        groups.set(key, held);
      }
      for (const records of groups.values()) {
        if (records.length > 1) for (const record of records) refuse('duplicate_declaration_key', record.fact_id);
        else eligible.push(records[0]);
      }
    } else if (kind === 'sqlite_table') {
      const groups = new Map();
      for (const record of candidates) {
        const key = sqliteDuplicateKey(record.row, sourceHead);
        const held = groups.get(key) || [];
        held.push(record);
        groups.set(key, held);
      }
      for (const records of groups.values()) {
        if (records.length > 1) for (const record of records) refuse('duplicate_declaration_key', record.fact_id);
        else eligible.push(records[0]);
      }
    } else if (kind === 'yaml_document' || kind === 'json_document') {
      const groups = new Map();
      for (const record of candidates) {
        const row = record.row;
        const yamlPlugin = kind === 'yaml_document' && /(^|\/)plugin\.yaml$/u.test(String(row.file));
        const yamlTyped = kind === 'yaml_document' && present(row.api_version) && present(row.doc_id);
        const key = yamlPlugin ? canonical([row.repo, 'plugin', row.doc_name])
          : yamlTyped ? canonical([row.repo, 'typed', row.api_version, row.doc_id])
            : canonical([row.repo, row.file]);
        const held = groups.get(key) || [];
        held.push(record);
        groups.set(key, held);
      }
      for (const records of groups.values()) {
        if (records.length > 1) for (const record of records) refuse('duplicate_declaration_key', record.fact_id);
        else eligible.push(records[0]);
      }
    } else {
      eligible.push(...candidates);
    }
    const inventoryIds = sorted(entry.records.map(record => record.fact_id));
    const eligibleIds = sorted(eligible.map(record => record.fact_id));
    const refusedByReason = Object.fromEntries([...refused.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, ids]) => [reason, sorted(ids)]));
    const refusedIds = sorted(Object.values(refusedByReason).flat());
    if (new Set([...eligibleIds, ...refusedIds]).size !== inventoryIds.length
      || canonical(sorted([...eligibleIds, ...refusedIds])) !== canonical(inventoryIds)) {
      throw new Error(`${kind}: compiler partition is not exact`);
    }
    const basisFields = compiler?.basis_fields || [];
    const basisValues = entry.records.map(record => ({
      fact_id: record.fact_id,
      fields: basisFields.map(fieldPath => [fieldPath, getField(record.row, fieldPath)]),
    })).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
    const measurements = {};
    if (kind === 'capability_flow') {
      measurements.null_owner_rows = entry.records.filter(({ row }) => !present(row.owner)).length;
      measurements.manifest_provide_rows = entry.records.filter(({ row }) => row.source === 'manifest' && row.direction === 'provide').length;
    }
    if (kind === 'envelope_flow') {
      const values = entry.records.map(record => record.row);
      measurements.manifest_key_rows_by_direction = values.filter(row => present(row.manifest_key))
        .reduce((held, row) => ({ ...held, [row.direction]: (held[row.direction] || 0) + 1 }), {});
      measurements.manifest_key_rows_by_idiom = values.filter(row => present(row.manifest_key))
        .reduce((held, row) => ({ ...held, [row.idiom]: (held[row.idiom] || 0) + 1 }), {});
      measurements.wildcard_manifest_key_rows = values.filter(row => present(row.manifest_key)
        && WILDCARD.test(String(row.envelope_kind ?? ''))).length;
    }
    if (kind === 'manifest_route_declaration') measurements.null_owner_rows = entry.records.filter(({ row }) => !present(row.owner)).length;
    if (kind === 'http_route') measurements.declared_route_and_owner_rows = entry.records
      .filter(({ row }) => present(row.declared_route) && present(row.owner)).length;
    if (kind === 'yaml_document') {
      measurements.doc_id_rows = entry.records.filter(({ row }) => present(row.doc_id)).length;
      measurements.doc_name_rows = entry.records.filter(({ row }) => present(row.doc_name)).length;
      measurements.neither_identity_field_rows = entry.records.filter(({ row }) => !present(row.doc_id) && !present(row.doc_name)).length;
      measurements.untyped_path_identity_rows = entry.records.filter(({ row }) =>
        !/(^|\/)plugin\.yaml$/u.test(String(row.file)) && !present(row.doc_id) && !present(row.api_version)).length;
    }
    if (kind === 'module') {
      const disclosureCounts = entry.records.map(({ row }) =>
        nonNameableDeclarationsByModule.get(canonical([row.repo, row.file])) || 0);
      measurements.declaration_scope_not_nameable_total = disclosureCounts.reduce((sum, count) => sum + count, 0);
      measurements.modules_with_declaration_scope_not_nameable = disclosureCounts.filter(count => count > 0).length;
      measurements.declaration_scope_not_nameable_count_distribution = Object.fromEntries(
        disclosureCounts.filter(count => count > 0).reduce((held, count) =>
          held.set(count, (held.get(count) || 0) + 1), new Map()).entries());
    }
    if (kind === 'sqlite_table') {
      measurements.qualified_name_values = sorted(entry.records.filter(({ row }) => present(row.qualified_name))
        .map(({ row }) => String(row.qualified_name)));
      const groups = new Map();
      for (const record of entry.records) {
        const key = sqliteDuplicateKey(record.row, sourceHead);
        const held = groups.get(key) || [];
        held.push(record.fact_id);
        groups.set(key, held);
      }
      measurements.duplicate_declaration_key_groups = [...groups.entries()].filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => ({ key_sha256: sha256(key), fact_ids: sorted(ids) }))
        .sort((left, right) => left.key_sha256.localeCompare(right.key_sha256));
    }
    return {
      kind,
      row_count: entry.records.length,
      fields: [...entry.fields.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      inventory_fact_ids: inventoryIds,
      payload_candidate_fact_ids: sorted(candidates.map(record => record.fact_id)),
      eligible_fact_ids: eligibleIds,
      refused_fact_ids_by_reason: refusedByReason,
      refused_counts_by_reason: Object.fromEntries(Object.entries(refusedByReason).map(([reason, ids]) => [reason, ids.length])),
      measured_candidate_count: candidates.length,
      currently_admissible_count: eligibleIds.length,
      basis_field_value_digest: `sha256:${sha256(canonical(basisValues))}`,
      provenance_class_counts: Object.fromEntries([...entry.classes.entries()].sort()),
      compiler_id: compiler?.id || 'estate-map/compiler/refuse-kind',
      compiler_version: compiler?.version || '1.0.0',
      contract_parser_dependency_ids: (compiler?.dependencies || []).map(item => item.id),
      dependency_status: Object.fromEntries((compiler?.dependencies || []).map(item => [item.id, item.status])),
      candidate_rule: compiler?.rule || null,
      candidate_status: !compiler ? 'refused_kind' : pending ? 'contract_pending' : 'admissible_partition',
      ...(Object.keys(measurements).length ? { measurements } : {}),
    };
  });

  const census = Object.freeze({
    schema: 'estate-map/identity-candidate-census/v2',
    disclaimer: 'Measurement only. Exact producer fact IDs are partitioned by the pinned compiler registry. Contract-pending rows have zero currently admissible IDs. Path provenance classes are review heuristics, never admission inputs. No favorable count target; zero admissible rows is valid.',
    source_head: sourceHead,
    code_plane_head: codePlane.code_plane_head,
    extract_manifest_sha256: sha256(readFileSync(extractManifest)),
    merge_graph_sha256: sha256(readFileSync(mergeGraph)),
    extract_dir_fact_files: exact.files,
    compiler_registry: Object.fromEntries(Object.entries(COMPILERS).map(([kind, compiler]) => [kind, {
      compiler_id: compiler.id,
      compiler_version: compiler.version,
      rule: compiler.rule,
      basis_field_paths: compiler.basis_fields,
      contract_parser_dependencies: compiler.dependencies,
      ...(compiler.declaration_source_version ? {
        declaration_source_version: compiler.declaration_source_version,
        declaration_scope_fields: compiler.declaration_scope_fields,
        local_id_fields: compiler.local_id_fields,
      } : {}),
      ...(compiler.duplicate_key_equivalence ? {
        duplicate_key_equivalence: compiler.duplicate_key_equivalence,
        duplicate_refusal: compiler.duplicate_refusal,
      } : {}),
    }])),
    total_rows: perKind.reduce((sum, row) => sum + row.row_count, 0),
    total_kinds: perKind.length,
    kinds: perKind,
  });
  return census;
}

function main() {
  const { extractDir, extractManifest, mergeGraph, sourceHead, out } = parseArgs(process.argv.slice(2));
  let census;
  try {
    census = buildIdentityCandidateCensus({ extractDir, extractManifest, mergeGraph, sourceHead });
  } catch (error) {
    fail(error.message);
  }
  const bytes = `${JSON.stringify(census, null, 2)}\n`;
  if (out) writeFileSync(out, bytes);
  else process.stdout.write(bytes);
  console.error(`PASS census: ${census.total_rows} rows over ${census.total_kinds} kinds`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
