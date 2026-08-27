import { sha256, stableStringify } from './lib.mjs';

export const IDENTITY_CANDIDATE_GENERATOR_SCHEMA = 'estate-map/identity-candidate-generation/v1';
export const IDENTITY_CANDIDATE_BATCH_RECEIPT_SCHEMA = 'estate-map/identity-candidate-batch-receipt/v1';
export const IDENTITY_CANDIDATE_SELECTION_POLICY = 'exact-basis-component-id-ascending/v1';
const canonical = value => stableStringify(value).trim();
const present = value => value !== undefined && value !== null && String(value).trim() !== '';

const refusedKindReasons = Object.freeze({
  aws_usage: 'usage_reference_not_declaration', capability_refusal: 'typed_extractor_refusal',
  config_key: 'declared_config_identity_deferred', config_value_template: 'partially_dynamic_value',
  config_value_url: 'url_text_not_identity', coverage: 'scan_diagnostic', dep: 'dependency_reference',
  derived_value_producer: 'derived_field_witness_only', envelope_dynamic_site: 'dynamic_envelope_reference',
  envelope_kind_mention: 'surface_mention_only', http_client: 'http_call_reference',
  http_route_refusal: 'typed_extractor_refusal', import: 'import_reference',
  literal_value: 'literal_observation', manifest_comment: 'prose_observation',
  manifest_key_alias: 'alias_evidence_only', manifest_key_presence: 'key_presence_observation',
  manifest_key_validation: 'validation_wiring_observation',
  namespace: 'parser_namespace_observation_without_identity_contract', path_expression: 'path_expression_observation',
  persistence_target: 'persistence_witness_only', predicate_literal: 'predicate_literal_observation',
  reference: 'source_reference', sql_dml: 'statement_reference',
  sql_migration: 'migration_operation_reference', sqlite_comment: 'ddl_prose_observation',
  sqlite_id_column: 'parent_table_identity_unwitnessed', sqlite_ref: 'foreign_key_relation_evidence',
  tf_ref: 'terraform_reference_edge',
  tf_workspace: 'generated_state_not_authored_declaration', throw_site: 'diagnostic_site',
  tool_registration: 'registration_wiring_observation', tool_registration_refusal: 'typed_extractor_refusal', ts_path_alias: 'alias_evidence_only',
  yaml_parse_refusal: 'typed_extractor_refusal', yaml_record_refusal: 'typed_extractor_refusal',
});

export const SUPPORTED_IDENTITY_CANDIDATE_CLASSES = Object.freeze([
  Object.freeze({ fact_kind: 'http_route', substrate: 'declared route with exact owner', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'module', substrate: 'exact parsed source file at its component-relative path', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'package_manifest', substrate: 'parser-backed package declaration', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'repo', substrate: 'scanned-manifest component declaration', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'sql_object', substrate: 'parser-backed SQL object declaration', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'sqlite_table', substrate: 'parser-backed SQLite table declaration', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'symbol', substrate: 'parser-backed symbol declaration scoped by repository, exact file, and declaration kind', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'tf_declaration', substrate: 'parser-backed Terraform declaration', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'tf_module_call', substrate: 'parser-backed Terraform module call', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'tf_resource', substrate: 'parser-backed Terraform resource address', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'yaml_record', substrate: 'top-level $schema or $id string declaration', basis_kind: 'parser_backed_schema' }),
  Object.freeze({ fact_kind: 'capability_flow', substrate: 'manifest-declared provided capability', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'envelope_flow', substrate: 'manifest-declared published envelope kind', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'yaml_document', substrate: 'plugin manifest name, typed document api_version and declared id, or exact untyped YAML file path', basis_kind: 'declared_namespace_identity' }),
  Object.freeze({ fact_kind: 'json_document', substrate: 'exact parsed JSON configuration file at its component-relative path', basis_kind: 'declared_namespace_identity' }),
]);

function parserBasis(parserId, schemaId, declaredIdentifier) {
  return { kind: 'parser_backed_schema', parser_id: parserId, schema_id: schemaId,
    declared_identifier: declaredIdentifier };
}

function namespaceBasis(namespaceKey, declaredIdentifier) {
  return { kind: 'declared_namespace_identity', namespace_key: namespaceKey,
    declared_identifier: declaredIdentifier };
}

function candidate(surface, basis, candidateClass) {
  return Object.freeze({ disposition: 'supported', surface: String(surface), candidate_basis: Object.freeze(basis),
    candidate_class: candidateClass });
}

function skipped(reason) {
  return Object.freeze({ disposition: 'skipped', reason });
}

/** Closed producer-record compiler. It never consults a path, line, value allowlist, or outcome count. */
export function identityCandidateDecision(record) {
  if (!record || !present(record.kind)) return skipped('fact_kind_missing');
  if (!present(record.repo) || !present(record.file) || !Number.isInteger(record.line) || record.line < 1) {
    return skipped('exact_source_locator_incomplete');
  }
  switch (record.kind) {
    case 'yaml_record':
      if (!['$schema', '$id'].includes(record.key_path) || record.value_type !== 'string' || !present(record.value)) {
        return skipped('yaml_record_not_top_level_schema_identifier');
      }
      return candidate(record.value, parserBasis('yaml-catalog@1', record.value, record.key_path),
        'yaml_record:top_level_schema_identifier');
    case 'sqlite_table': {
      const localId = present(record.qualified_name) ? record.qualified_name : record.table;
      if (!present(localId)) return skipped('sqlite_table_declaration_incomplete');
      return candidate(localId, parserBasis('sqlite-ddl@1', canonical([record.repo, record.file]), localId),
        'sqlite_table:exact_file_declaration');
    }
    case 'sql_object':
      if (!present(record.object) || !present(record.object_kind)) return skipped('sql_object_declaration_incomplete');
      return candidate(record.object, parserBasis('sql@1', canonical([record.repo, record.file, record.object_kind]), record.object),
        'sql_object:parser_declaration');
    case 'symbol': {
      if (!present(record.name) || !present(record.symbol_kind)) return skipped('symbol_declaration_incomplete');
      // Identity is the declaration's name path within its file (Repo.create),
      // not its bare name. The extractor emits scope_path only when every
      // enclosing scope is nameable; a declaration inside a function body,
      // arrow, loop, or block has none and is refused here. That removes the
      // whole same-name collision class: two loop counters never contend for
      // one identity because neither is a candidate.
      if (!Array.isArray(record.scope_path) || !record.scope_path.length
        || record.scope_path.some(part => !present(part))) {
        return skipped('declaration_scope_not_nameable');
      }
      const localId = record.scope_path.join('.');
      return candidate(localId,
        parserBasis('tree-sitter-symbol-query@2', canonical([record.repo, record.file]), localId),
        'symbol:parser_declaration');
    }
    case 'tf_declaration':
      if (!present(record.name) || !present(record.declaration_kind)) return skipped('terraform_declaration_incomplete');
      return candidate(record.name, parserBasis('hcl@1', canonical([record.repo, record.module_path, record.declaration_kind]), record.name),
        'tf_declaration:parser_declaration');
    case 'tf_module_call':
      if (!present(record.name)) return skipped('terraform_module_call_incomplete');
      return candidate(record.name, parserBasis('hcl@1', canonical([record.repo, record.module_path, 'module']), record.name),
        'tf_module_call:parser_declaration');
    case 'tf_resource':
      if (!present(record.address)) return skipped('terraform_resource_address_missing');
      return candidate(record.address, parserBasis('hcl@1', canonical([record.repo, record.module_path, 'resource']), record.address),
        'tf_resource:parser_declaration');
    case 'module':
      // Files are the navigation containers of the estate and the endpoints of the resolved
      // import graph (design section 17, 2026-08-13). Identity is the exact component-relative
      // path within its repository; language is the parse witness, never an identity input.
      if (!present(record.language)) return skipped('module_language_unwitnessed');
      return candidate(record.file,
        namespaceBasis(canonical([record.repo, 'module']), record.file),
        'module:parsed_source_file');
    case 'http_route':
      if (!present(record.declared_route) || !present(record.owner)) return skipped('route_declaration_unwitnessed');
      return candidate(record.declared_route,
        namespaceBasis(canonical([record.owner, record.framework, record.method]), record.declared_route),
        'http_route:owned_declaration');
    case 'package_manifest':
      if (!present(record.package_name)) return skipped('package_name_missing');
      return candidate(record.package_name,
        namespaceBasis(canonical([record.repo, record.file, record.manifest_kind]), record.package_name),
        'package_manifest:package_declaration');
    case 'repo': {
      const localId = present(record.root) ? record.root : record.repo;
      return candidate(localId, namespaceBasis('scanned-manifest-component', localId),
        'repo:scanned_component');
    }
    // The estate declares its own domain vocabulary: plugins name themselves, manifests declare the
    // capabilities they provide and the envelopes they publish, and typed documents carry an
    // api_version with a declared id. Identity follows those declarations exactly. A reference is
    // never a declaration: requiring a capability, consuming an envelope, or mentioning a kind at a
    // code site remains a relation, so usage can never mint the thing it uses.
    case 'capability_flow':
      if (record.direction !== 'provide') return skipped('capability_reference_not_declaration');
      if (!present(record.capability_type) || !present(record.owner)) {
        return skipped('capability_declaration_incomplete');
      }
      return candidate(record.capability_type,
        namespaceBasis(canonical([record.repo, 'capability']), record.capability_type),
        'capability_flow:manifest_declaration');
    case 'envelope_flow':
      if (record.idiom !== 'manifest_publishes') return skipped('envelope_reference_not_declaration');
      if (!present(record.envelope_kind)) return skipped('envelope_declaration_incomplete');
      return candidate(record.envelope_kind,
        namespaceBasis(canonical([record.repo, 'envelope']), record.envelope_kind),
        'envelope_flow:manifest_declaration');
    case 'manifest_route_declaration': return skipped('route_declared_in_manifest_resolved_through_http_route');
    case 'yaml_document': {
      // A plugin manifest declares its own name; a typed document declares api_version plus id.
      // A non-plugin document with neither typed field is addressable only by its exact file path.
      const pluginManifest = /(^|\/)plugin\.yaml$/u.test(String(record.file));
      if (pluginManifest) {
        if (!present(record.doc_name)) return skipped('plugin_manifest_name_unwitnessed');
        return candidate(record.doc_name,
          namespaceBasis(canonical([record.repo, 'plugin']), record.doc_name),
          'yaml_document:plugin_manifest');
      }
      const typedPair = present(record.doc_id) && present(record.api_version);
      if (!typedPair) {
        return candidate(record.file,
          namespaceBasis(canonical([record.repo, 'yaml-document']), record.file),
          'yaml_document:untyped_path_declaration');
      }
      if (!/^[a-z][\w.-]*\/v\d+$/iu.test(String(record.api_version))) {
        return skipped('document_identity_contract_unpinned');
      }
      return candidate(record.doc_id,
        namespaceBasis(canonical([record.repo, record.api_version]), record.doc_id),
        'yaml_document:typed_declared_document');
    }
    case 'json_document':
      return candidate(record.file,
        namespaceBasis(canonical([record.repo, 'json-document']), record.file),
        'json_document:parsed_configuration_file');
    default: return skipped(refusedKindReasons[record.kind] || 'fact_kind_not_identity_eligible');
  }
}

export function identityCandidateDecisions(records) {
  const decisions = records.map(identityCandidateDecision);
  const symbolGroups = new Map();
  records.forEach((record, index) => {
    if (record.kind !== 'symbol' || decisions[index].disposition !== 'supported') return;
    const key = canonical([record.repo, record.file, record.scope_path.join('.')]);
    const held = symbolGroups.get(key) || [];
    held.push(index);
    symbolGroups.set(key, held);
  });
  for (const indices of symbolGroups.values()) {
    if (indices.length > 1) for (const index of indices) decisions[index] = skipped('duplicate_declaration_key');
  }
  const moduleGroups = new Map();
  records.forEach((record, index) => {
    if (record.kind !== 'module' || decisions[index].disposition !== 'supported') return;
    const key = canonical([record.repo, record.file]);
    const held = moduleGroups.get(key) || [];
    held.push(index);
    moduleGroups.set(key, held);
  });
  for (const indices of moduleGroups.values()) {
    if (indices.length > 1) for (const index of indices) decisions[index] = skipped('duplicate_declaration_key');
  }
  // A capability type and an envelope kind name one shared thing the estate declares; a manifest
  // declaration and a code-side provision are two witnesses to it, which exact-basis grouping
  // merges into one entity. The duplicate guard applies where one declaration key must be unique:
  // plugin names, typed document IDs, and the mechanical exact-file YAML document identity.
  for (const [kind, keyOf] of [
    ['yaml_document', record => {
      if (/(^|\/)plugin\.yaml$/u.test(String(record.file))) return `plugin\0${record.doc_name}`;
      if (present(record.api_version) && present(record.doc_id)) return `typed\0${record.api_version}\0${record.doc_id}`;
      return `path\0${record.file}`;
    }],
    ['json_document', record => `path\0${record.file}`],
  ]) {
    const declared = new Map();
    records.forEach((record, index) => {
      if (record.kind !== kind || decisions[index].disposition !== 'supported') return;
      const key = keyOf(record);
      if (!present(key)) return;
      const held = declared.get(canonical([record.repo, key])) || [];
      held.push(index);
      declared.set(canonical([record.repo, key]), held);
    });
    for (const indices of declared.values()) {
      if (indices.length > 1) for (const index of indices) decisions[index] = skipped('duplicate_declaration_key');
    }
  }
  const sqliteGroups = new Map();
  records.forEach((record, index) => {
    if (record.kind !== 'sqlite_table' || decisions[index].disposition !== 'supported') return;
    const localId = present(record.qualified_name) ? record.qualified_name : record.table;
    const key = canonical([record.repo, record.file, localId]);
    const held = sqliteGroups.get(key) || [];
    held.push(index);
    sqliteGroups.set(key, held);
  });
  for (const indices of sqliteGroups.values()) {
    if (indices.length > 1) for (const index of indices) decisions[index] = skipped('duplicate_declaration_key');
  }
  return Object.freeze(decisions);
}

export function exactBasisKey(candidate) {
  return sha256(canonical(candidate.candidate_basis));
}

/** N-ary grouping retains every member. Singletons remain explicit groups for closed disposition. */
export function groupIdentityCandidatesByExactBasis(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = exactBasisKey(candidate);
    const held = groups.get(key) || [];
    held.push(candidate);
    groups.set(key, held);
  }
  return Object.freeze([...groups.entries()].map(([exactBasisDigest, members]) => Object.freeze({
    component_id: `identity-candidate-component:${exactBasisDigest}`,
    exact_basis_digest: exactBasisDigest,
    disposition: members.length === 1 ? 'singleton_requires_explicit_join_disposition' : 'nary_exact_basis_component',
    members: Object.freeze(members.slice().sort((left, right) =>
      left.mention.mention_id.localeCompare(right.mention.mention_id))),
  })).sort((left, right) => left.component_id.localeCompare(right.component_id)));
}

export function selectIdentityCandidateBatch({ groups, selection, source_head: sourceHead,
  code_plane_head: codePlaneHead, census_digest: censusDigest }) {
  if (!Array.isArray(groups) || !selection || !['batch', 'all'].includes(selection.mode)) {
    throw new Error('identity candidate selection requires enumerated groups and explicit batch or all mode');
  }
  if (!present(sourceHead) || !present(codePlaneHead) || !present(censusDigest)) {
    throw new Error('identity candidate selection requires exact source, code-plane, and census heads');
  }
  const totalComponents = groups.length;
  const totalCandidates = groups.reduce((sum, group) => sum + group.members.length, 0);
  let cursor = 0;
  let batchIndex = null;
  let batchSize = null;
  let end = totalComponents;
  if (selection.mode === 'batch') {
    cursor = selection.cursor;
    batchIndex = selection.batch_index;
    batchSize = selection.batch_size;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > totalComponents
      || !Number.isInteger(batchIndex) || batchIndex < 0
      || !Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('batch selection requires a non-negative cursor/batch index and positive batch size');
    }
    end = cursor;
    let selectedCount = 0;
    while (end < totalComponents && (end === cursor || selectedCount < batchSize)) {
      selectedCount += groups[end].members.length;
      end += 1;
    }
  } else if (Object.keys(selection).some(key => !['mode'].includes(key))) {
    throw new Error('all selection mode accepts no cursor, batch, seed, or value filter');
  }
  const selectedGroups = groups.slice(cursor, end);
  const beforeGroups = groups.slice(0, cursor);
  const deferredGroups = groups.slice(end);
  const selectedCandidates = selectedGroups.flatMap(group => group.members);
  const candidateRows = groups.flatMap((group, componentIndex) => group.members.map(candidate => Object.freeze({
    component_id: group.component_id,
    fact_id: candidate.fact_id,
    mention_id: candidate.mention.mention_id,
    evaluation_state: componentIndex >= cursor && componentIndex < end
      ? 'selected_for_evaluation' : 'not_evaluated_in_this_batch',
    schedule_state: componentIndex < cursor ? 'before_cursor' : componentIndex >= end ? 'deferred' : 'selected',
  })));
  const componentCensus = groups.map(group => ({ component_id: group.component_id,
    exact_basis_digest: group.exact_basis_digest,
    candidate_fact_ids: group.members.map(row => row.fact_id).sort(),
    candidate_mention_ids: group.members.map(row => row.mention.mention_id).sort() }));
  const body = {
    schema: IDENTITY_CANDIDATE_BATCH_RECEIPT_SCHEMA,
    source_head: sourceHead,
    code_plane_head: codePlaneHead,
    census_digest: censusDigest,
    component_census_digest: sha256(canonical(componentCensus)),
    selection_policy: IDENTITY_CANDIDATE_SELECTION_POLICY,
    selection_mode: selection.mode,
    seed: null,
    configured_batch_size: batchSize,
    batch_index: batchIndex,
    cursor,
    next_cursor: end,
    total_components: totalComponents,
    total_candidates: totalCandidates,
    selected_component_ids: selectedGroups.map(group => group.component_id),
    selected_candidate_count: selectedCandidates.length,
    selected_candidate_fact_ids: selectedCandidates.map(row => row.fact_id).sort(),
    prefix_component_count: beforeGroups.length,
    prefix_candidate_count: beforeGroups.reduce((sum, group) => sum + group.members.length, 0),
    deferred_component_count: deferredGroups.length,
    deferred_candidate_count: deferredGroups.reduce((sum, group) => sum + group.members.length, 0),
    not_evaluated_in_this_batch_count: totalCandidates - selectedCandidates.length,
    candidate_rows: candidateRows,
    complete: end === totalComponents,
  };
  return Object.freeze({
    selected_groups: Object.freeze(selectedGroups),
    selected_candidates: Object.freeze(selectedCandidates),
    receipt: Object.freeze({ ...body,
      receipt_id: `identity-candidate-batch-receipt:${sha256(canonical(body))}` }),
  });
}

export function identityCandidateGenerationReport({ facts, candidates, skipped }) {
  const countRows = rows => Object.fromEntries([...rows.reduce((counts, row) => {
    const key = canonical([row.fact_kind, row.reason || row.candidate_class]);
    const held = counts.get(key) || { fact_kind: row.fact_kind,
      ...(row.reason ? { reason: row.reason } : { candidate_class: row.candidate_class }), count: 0 };
    held.count += 1;
    counts.set(key, held);
    return counts;
  }, new Map()).values()].sort((left, right) => canonical(left).localeCompare(canonical(right)))
    .map((row, index) => [String(index), row]));
  const body = {
    schema: IDENTITY_CANDIDATE_GENERATOR_SCHEMA,
    enumeration: 'live_exact_fact_stream_without_path_line_value_allowlists',
    producer_facts: facts,
    candidates: candidates.length,
    skipped: skipped.length,
    supported_classes: SUPPORTED_IDENTITY_CANDIDATE_CLASSES,
    supported_observations: Object.values(countRows(candidates)),
    skipped_observations: Object.values(countRows(skipped)),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}
