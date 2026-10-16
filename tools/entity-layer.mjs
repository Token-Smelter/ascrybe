#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import {
  ENTITY_CARDINALITIES,
  ENTITY_CONFLICT_REASONS,
  ENTITY_LAYER_FILE_SUFFIX,
  ENTITY_LAYER_SCHEMA,
  ENTITY_RECORD_KINDS,
  ENTITY_REFUSAL_REASONS,
  ENTITY_RELATIONS,
  validateEntityLayerRecord,
} from './annotate.mjs';
import { parseArgs } from './lib.mjs';
import { loadEntityAnalysisConfig, validateEntityAnalysisConfig, unconfiguredEntityAnalysis } from './entity-analysis-config.mjs';

const HELP = `Usage:
  node tools/estate-map/entity-layer.mjs <graph.json> <out.entity-layer.jsonl> [options]

OUTPUT NAMING IS REQUIRED, NOT COSMETIC. <out> MUST end in '${ENTITY_LAYER_FILE_SUFFIX}'.
\`annotate.mjs merge\` routes overlay files by FILENAME SUFFIX and by nothing else: a file
of valid entity-layer records under any other name is read as an annotation overlay and
rejected. This producer refuses to write such a file rather than leaving the rejection to
be discovered at merge time.

Options:
  --facts <dir>       facts directory from extract.mjs (default: <graph-dir>/../facts)
  --model <path>      estate-relative path of the shipped entity model
                      (default: no model; declare entity_analysis.model_path)
  --estate <dir>      estate root, used to read --model (default: cwd)
  --discovery <path>  discover-entities.mjs discovery-report.json (optional corroboration)
  --census <path>     write the census as JSON
  --json              print the census to stdout as JSON

Derives entity types, typed relationships with cardinality, envelope attachments, refusals
and cross-source conflicts from SCHEMA DDL plus independent corroboration. Schema only: no
row of any database is ever read. Deterministic, offline, no model calls.`;

// The schema, the record kinds and every frozen vocabulary live in annotate.mjs, which owns
// the merged artifact's shapes; they are re-exported here so a consumer of the derivation
// does not need to know which module holds the schema.
export {
  ENTITY_CARDINALITIES, ENTITY_CONFLICT_REASONS, ENTITY_LAYER_FILE_SUFFIX, ENTITY_LAYER_SCHEMA,
  ENTITY_RECORD_KINDS, ENTITY_REFUSAL_REASONS, ENTITY_RELATIONS,
};
export const ENTITY_LAYER_PRODUCER = 'deterministic/entity-layer@1';
export const DEFAULT_MODEL_PATH = null;

// Preserve source witnesses; do not infer authority from naming conventions alone.
const READ_MODEL_SUFFIX = /(?:_summary|_index|_projection|_current|_meta|_cursor|_cursors|_inbox|_outbox|_dedupe|_log|_journal|_ledger|_state|_watermarks|_markers|_deliveries|_fences|_consumed|_new)$/;

// Preserve source witnesses; do not infer authority from naming conventions alone.
const INFRASTRUCTURE_TABLE = /^(?:outbox|inbox|dead_letter_queue|resource_leases)$/;

// Preserve source witnesses; do not infer authority from naming conventions alone.
const PROJECTION_OF = /^(.+?)_(?:summary|index|projection)$/;

// Preserve source witnesses; do not infer authority from naming conventions alone.
const IRREGULAR_SINGULARS = Object.freeze({ criteria: 'criterion', indices: 'index' });

// An estate-declared alias resolves only when its target is itself promoted.
const ID_ALIASES = Object.freeze({});

const singularize = table => {
  const lower = String(table).toLowerCase();
  if (IRREGULAR_SINGULARS[lower]) return IRREGULAR_SINGULARS[lower];
  const parts = lower.split('_');
  const last = parts[parts.length - 1];
  const irregular = IRREGULAR_SINGULARS[last];
  if (irregular) return [...parts.slice(0, -1), irregular].join('_');
  if (/(?:ss|us|is)$/.test(lower)) return lower;
  if (/ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
  if (/(?:ch|sh|x|s)es$/.test(lower)) return lower.slice(0, -2);
  if (/s$/.test(lower)) return lower.slice(0, -1);
  return lower;
};

const label = entity => entity.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const witness = fact => ({ repo: fact.repo, file: fact.file, line: fact.line });
const sortWitnesses = list => list.slice().sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
const dedupeWitnesses = list => {
  const seen = new Set();
  return sortWitnesses(list).filter(item => {
    const key = `${item.repo}\0${item.file}\0${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
// Preserve source witnesses; do not infer authority from naming conventions alone.
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?|spec|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const isTestFact = fact => TEST_PATH.test(fact.file);

/** Parse the shipped client model's frozen entity/edge vocabularies, with real line numbers. */
export function parseShippedModel(source, { repo, file, entityConfig = null }) {
  entityConfig = validateEntityAnalysisConfig(entityConfig);
  const lines = source.split(/\r?\n/);
  const readList = name => {
    const start = lines.findIndex(line => new RegExp(`export const ${name}\\s*=\\s*\\[`).test(line));
    if (start < 0) throw new Error(`entity-layer: ${file} does not declare ${name} — the shipped model moved or was renamed; fix the citation rather than guessing the vocabulary`);
    const entries = [];
    for (let index = start + 1; index < lines.length; index++) {
      if (/^\s*\]\s*as const;/.test(lines[index])) return { entries, declaredAt: { repo, file, line: start + 1 } };
      const match = lines[index].match(/^\s*'([a-z_]+)',?\s*$/);
      if (match) entries.push({ value: match[1], at: { repo, file, line: index + 1 } });
    }
    throw new Error(`entity-layer: ${file}'s ${name} list is unterminated`);
  };
  const kinds = readList(entityConfig?.model_entity_export ?? 'ENTITY_KINDS');
  const edges = readList(entityConfig?.model_edge_export ?? 'EDGE_KINDS');
  if (!kinds.entries.length || !edges.entries.length) throw new Error(`entity-layer: ${file} yielded an empty vocabulary`);
  return {
    repo, file,
    entityKinds: new Map(kinds.entries.map(entry => [entry.value, entry.at])),
    edgeKinds: new Map(edges.entries.map(entry => [entry.value, entry.at])),
  };
}

/**
 * Independent code-signal corroboration from discover-entities.mjs. `storage_shape` is
 * dropped on purpose (see the header): it is the same CREATE TABLE this module already read.
 */
export function corroborationFromDiscovery(discovery) {
  const byEntity = new Map();
  if (!discovery) return byEntity;
  // `clusters` is the report's real array (discovery-report.json carries
  // ambiguous_merges / canon / clusters / expectations / headline / reconciliation / scan /
  // schema / signature_classes and NOTHING named after a bucket) — verified by reading a
  // real report rather than assuming the headline's key names apply to the rows.
  const buckets = [discovery.clusters].filter(Array.isArray);
  for (const bucket of buckets) {
    for (const entry of bucket) {
      const classes = (entry.signature_classes || []).filter(name => name !== 'storage_shape');
      if (!classes.length) continue;
      const names = [entry.entity, ...(entry.aliases || [])].filter(name => typeof name === 'string');
      const first = (entry.witnesses || []).find(item => item && item.file);
      for (const name of names) {
        const key = singularize(name);
        const existing = byEntity.get(key) || { classes: new Set(), witnesses: [] };
        for (const item of classes) existing.classes.add(item);
        if (first) existing.witnesses.push({ repo: first.repo || 'unknown', file: first.file, line: first.line || 1 });
        byEntity.set(key, existing);
      }
    }
  }
  return byEntity;
}

// CAPABILITY -> ENTITY name rule (instrument fix J1). A capability type is a
// contract NAME, not a table, so the only groundable link to an entity is its
// name. Two forms reach one: the type IS the entity (`batch`), or the type is
// management OF the entity (`parcel_order_management` -> `parcel_order`,
// `criterion_management` -> `criterion`). `_management` is the estate's real
// suffix convention — seven of the eleven declared capability types use it.
// Anything else is REFUSED: `legitimacy_escrow`, `dispatch_models` and
// `project_routing` are about no entity this schema declares, and picking the
// nearest plausible one would be the guess this layer exists to avoid.
const CAPABILITY_ENTITY_SUFFIX = /_management$/;
export function capabilityEntityCandidates(type) {
  const lower = String(type || '').toLowerCase();
  const stem = lower.replace(CAPABILITY_ENTITY_SUFFIX, '');
  return [...new Set([lower, singularize(lower), stem, singularize(stem)])].filter(Boolean);
}

/** Envelope kinds carried by the graph, indexed by their leading namespace segment. */
function envelopeKindsByPrefix(graph) {
  const byPrefix = new Map();
  for (const node of graph.nodes || []) {
    if (node.kind !== 'envelope_kind') continue;
    const name = String(node.name || '');
    const prefix = name.split('.')[0];
    if (!prefix || prefix === name) continue;
    const first = (node.witnesses || [])[0];
    const existing = byPrefix.get(prefix) || [];
    existing.push({ kind: name, id: node.id, witness: first ? { repo: first.repo || 'unknown', file: first.file, line: first.line || 1 } : null });
    byPrefix.set(prefix, existing);
  }
  for (const list of byPrefix.values()) list.sort((a, b) => a.kind.localeCompare(b.kind));
  return byPrefix;
}

/** Group the schema facts into a table registry: one entry per real (non-test) table. */
export function tableRegistry(facts) {
  const tables = new Map();
  for (const fact of facts) {
    if (fact.kind !== 'sqlite_table' || isTestFact(fact)) continue;
    const key = String(fact.table).toLowerCase();
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    const existing = tables.get(key);
    const entry = existing || { table: key, declarations: [], primary_key: [], columns: new Map(), refs: [], check_enums: [] };
    entry.declarations.push(witness(fact));
    for (const item of fact.check_enums || []) entry.check_enums.push({ column: String(item.column).toLowerCase(), values: item.values.map(value => String(value).toLowerCase()), at: { repo: fact.repo, file: fact.file, line: item.line } });
    for (const column of fact.primary_key || []) if (!entry.primary_key.includes(column.toLowerCase())) entry.primary_key.push(column.toLowerCase());
    tables.set(key, entry);
  }
  for (const fact of facts) {
    if (isTestFact(fact)) continue;
    const key = String(fact.table || '').toLowerCase();
    const entry = tables.get(key);
    if (!entry) continue;
    if (fact.kind === 'sqlite_ref') {
      entry.refs.push({
        column: String(fact.column).toLowerCase(),
        target_table: String(fact.target_table).toLowerCase(),
        target_column: String(fact.target_column).toLowerCase(),
        form: fact.form, unique: Boolean(fact.unique_column), primary_key: Boolean(fact.primary_key_column),
        at: witness(fact), declared: true,
      });
      entry.columns.set(String(fact.column).toLowerCase(), { name: String(fact.column).toLowerCase(), at: witness(fact), unique: Boolean(fact.unique_column), primary_key: Boolean(fact.primary_key_column) });
    } else if (fact.kind === 'sqlite_id_column') {
      entry.columns.set(String(fact.column).toLowerCase(), { name: String(fact.column).toLowerCase(), at: witness(fact), unique: Boolean(fact.unique_column), primary_key: Boolean(fact.primary_key_column) });
    }
  }
  for (const entry of tables.values()) {
    entry.declarations = dedupeWitnesses(entry.declarations);
    entry.at = entry.declarations[0];
    entry.refs.sort((a, b) => a.column.localeCompare(b.column) || a.target_table.localeCompare(b.target_table));
    entry.check_enums.sort((a, b) => a.column.localeCompare(b.column) || a.at.file.localeCompare(b.at.file) || a.at.line - b.at.line);
  }
  return tables;
}



/**
 * Resolve `<role>_<entity>_id` to a promoted entity by taking the LONGEST entity-name suffix
 * that matches. `parent_package_id` resolves to `package` with role `parent`;
 * an explicitly configured `pkg` alias can resolve `root_pkg_id`. A column whose stem matches
 * nothing promoted resolves to null and is refused, never guessed at.
 */
export function resolveIdColumn(column, promoted, idAliases = ID_ALIASES) {
  const stem = column.replace(/_id$/, '');
  if (stem === 'id' || stem === column) return null;
  const parts = stem.split('_');
  for (let start = 0; start < parts.length; start++) {
    const candidate = parts.slice(start).join('_');
    const resolved = promoted.has(candidate) ? candidate : (promoted.has(idAliases[candidate]) ? idAliases[candidate] : null);
    if (resolved) return { entity: resolved, role: parts.slice(0, start).join('_') || null, alias: resolved === candidate ? null : candidate };
  }
  return null;
}

// Cardinality comes from UNIQUENESS ONLY, never from primary-key membership: a column that
// is one of several composite-key members admits many rows per value, and reading it as a
// has_one would turn every junction table into a 1:1. The extractor already resolves the one
// case where the two coincide (a single-column PRIMARY KEY is marked unique).
const cardinalityOf = column => (column.unique ? '1..1' : '1..N');

export function deriveEntityLayer({ facts, graph, model, discovery = null, entityConfig = null }) {
  entityConfig = validateEntityAnalysisConfig(entityConfig);
  const ID_ALIASES = entityConfig?.id_aliases ?? {};
  const prefixes = entityConfig?.read_model_prefixes ?? [];
  const READ_MODEL_PREFIX = prefixes.length ? new RegExp(`^(?:${prefixes.join('|')})`) : /$a/;
  const isReadModelTable = table => READ_MODEL_SUFFIX.test(table) || READ_MODEL_PREFIX.test(table) || INFRASTRUCTURE_TABLE.test(table);
  const entityExport = entityConfig?.model_entity_export ?? 'ENTITY_KINDS';
  const edgeExport = entityConfig?.model_edge_export ?? 'EDGE_KINDS';
  const tables = tableRegistry(facts);
  const discoveryByEntity = corroborationFromDiscovery(discovery);
  const envelopesByPrefix = envelopeKindsByPrefix(graph);
  const records = [];
  const refusals = [];
  const conflicts = [];

  // ---- CANDIDATES -------------------------------------------------------
  // Two sources of candidate names, both witnessed: a table whose singular reads like an
  // entity, and a kind the shipped client model declares.
  const candidates = new Map();
  const addCandidate = (entity, patch) => {
    const existing = candidates.get(entity) || { entity, tables: [], modelKind: null, rootTable: null, rootBasis: null, referencedIn: [] };
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    const keepRoot = existing.rootBasis === 'table_name' && patch.rootBasis === 'pk_identity';
    const merged = {
      ...existing,
      ...patch,
      tables: [...existing.tables, ...(patch.tables || [])],
      referencedIn: [...existing.referencedIn, ...(patch.referencedIn || [])],
    };
    if (keepRoot) { merged.rootTable = existing.rootTable; merged.rootBasis = existing.rootBasis; }
    candidates.set(entity, merged);
  };
  for (const table of [...tables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    addCandidate(singularize(table.table), { tables: [table], rootTable: table, rootBasis: 'table_name' });
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    if (table.primary_key.length === 1 && /_id$/.test(table.primary_key[0])) {
      const named = singularize(table.primary_key[0].replace(/_id$/, ''));
      const words = table.table.split('_').map(singularize);
      const compound = named.split('_');
      const namesTable = compound.every(part => words.includes(part));
      if (named !== singularize(table.table) && namesTable) addCandidate(named, { tables: [table], rootTable: table, rootBasis: 'pk_identity' });
    }
  }
  // Every `<entity>_id` column, wherever it appears, is a reference candidate.
  for (const table of tables.values()) {
    for (const column of table.columns.values()) {
      const stem = column.name.replace(/_id$/, '');
      if (!stem || stem === 'id') continue;
      const parts = stem.split('_');
      for (let start = 0; start < parts.length; start++) {
        const name = singularize(parts.slice(start).join('_'));
        const target = ID_ALIASES[name] || name;
        addCandidate(target, { referencedIn: [{ table, column }] });
      }
    }
  }
  for (const [kind, at] of model.entityKinds) addCandidate(singularize(kind), { modelKind: { kind, at } });

  // ---- PROMOTION --------------------------------------------------------
  const promoted = new Map();
  const decisions = [];
  for (const candidate of [...candidates.values()].sort((a, b) => a.entity.localeCompare(b.entity))) {
    const rootTable = candidate.rootTable && !isReadModelTable(candidate.rootTable.table) ? candidate.rootTable : null;
    // Schema evidence: a root table, OR the same `<entity>_id` column in >=2 distinct tables
    // across >=2 distinct files. The two-file floor is what stops a single table's own
    // column from attesting an entity nobody else references.
    const referencedTables = new Set(candidate.referencedIn.map(item => item.table.table));
    const referencedFiles = new Set(candidate.referencedIn.map(item => item.table.at?.file).filter(Boolean));
    const referenced = referencedTables.size >= 2 && referencedFiles.size >= 2;
    const schemaEvidence = rootTable ? 'root_table' : referenced ? 'referenced_id' : null;
    const corroboration = [];
    if (candidate.modelKind) corroboration.push({ source: 'shipped_model', detail: `${entityExport} declares '${candidate.modelKind.kind}'`, at: candidate.modelKind.at });
    const signal = discoveryByEntity.get(candidate.entity);
    if (signal?.classes.size) corroboration.push({ source: 'code_signal', detail: `discover-entities signature classes: ${[...signal.classes].sort().join(', ')}`, at: signal.witnesses[0] || null });
    const envelopes = envelopesByPrefix.get(candidate.entity) || [];
    if (envelopes.length) corroboration.push({ source: 'envelope_namespace', detail: `${envelopes.length} envelope kind(s) under '${candidate.entity}.'`, at: envelopes.find(item => item.witness)?.witness || null });
    const decision = { candidate, rootTable, schemaEvidence, corroboration, referencedTables, referencedFiles, envelopes };
    decisions.push(decision);
    if (candidate.rootTable && isReadModelTable(candidate.rootTable.table) && !referenced) { decision.refusal = 'read_model_or_infrastructure_table'; continue; }
    // Two DIFFERENT absences, kept apart because they route differently: a kind the shipped
    // UI renders but the schema never stores is a reconciliation item for the model's owner,
    // while a name that appears in one table's column and nowhere else is simply not
    // attested enough to be anything.
    if (!schemaEvidence) { decision.refusal = candidate.modelKind ? 'model_kind_without_schema_evidence' : 'insufficient_schema_evidence'; continue; }
    if (!corroboration.length) { decision.refusal = 'single_source_uncorroborated'; continue; }
    promoted.set(candidate.entity, decision);
  }
  const promotedNames = new Set(promoted.keys());

  // ---- ENTITY TYPE RECORDS ---------------------------------------------
  for (const [entity, decision] of [...promoted].sort((a, b) => a[0].localeCompare(b[0]))) {
    const witnesses = dedupeWitnesses([
      ...(decision.rootTable ? decision.rootTable.declarations : decision.candidate.referencedIn.map(item => item.column.at)),
      ...decision.corroboration.map(item => item.at).filter(Boolean),
    ]);
    records.push({
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'entity_type', id: `entity:${entity}`,
      producer: ENTITY_LAYER_PRODUCER,
      rule: decision.schemaEvidence === 'root_table' ? 'E1-root-table' : 'E2-referenced-identity',
      entity, label: label(entity),
      root_table: decision.rootTable ? decision.rootTable.table : null,
      schema_evidence: decision.schemaEvidence,
      // "Sized by instance-table presence" in the landing view: an entity with its own root
      // table has durable rows of its own; one attested only by other tables' foreign keys
      // is real but stored elsewhere (one order's state may live in run-directory JSON, not
      // SQLite), and the view must not imply otherwise.
      instance_table: Boolean(decision.rootTable),
      corroboration: decision.corroboration.map(item => ({ source: item.source, detail: item.detail })),
      witnesses,
    });
  }

  // ---- TABLE AUDIT -----------------------------------------------------
  // Every extracted non-test table either BACKS a promoted entity as its root table or gets
  // a refusal record NAMING why it does not. A silent drop with no record is exactly what
  // the refusal machinery exists to prevent, and it is how `envelopes` — the estate's
  // highest-volume table — went missing for a whole release without anything saying so.
  // The audit is a closed cover of `tables`: audited = backing + refused, always.
  const rootTableOwners = new Map();
  for (const [entity, decision] of promoted) if (decision.rootTable) rootTableOwners.set(decision.rootTable.table, entity);
  const decisionByEntity = new Map(decisions.map(decision => [decision.candidate.entity, decision]));
  const tableAudit = [];
  for (const table of [...tables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    const owner = rootTableOwners.get(table.table);
    if (owner) { tableAudit.push({ table: table.table, outcome: 'backs_entity', entity: owner }); continue; }
    const named = singularize(table.table);
    const decision = decisionByEntity.get(named) || null;
    const patterns = [['READ_MODEL_SUFFIX', READ_MODEL_SUFFIX], ['READ_MODEL_PREFIX', READ_MODEL_PREFIX], ['INFRASTRUCTURE_TABLE', INFRASTRUCTURE_TABLE]];
    const matched = patterns.find(([, pattern]) => pattern.test(table.table));
    let reason, detail, examined;
    if (matched) {
      reason = 'read_model_or_infrastructure_table';
      detail = `table '${table.table}' is a read model or bus plumbing, not an entity: it matches ${matched[0]}`;
      examined = [{ relation: 'table_name_pattern', target: matched[0], value: 'matched' }];
    } else if (decision?.refusal) {
      reason = decision.refusal;
      detail = `table '${table.table}' names candidate entity '${named}', which was refused as '${decision.refusal}'`;
      examined = [{ relation: 'candidate_entity', target: named, value: `refused: ${decision.refusal}` }];
    } else if (promoted.has(named)) {
      reason = 'table_superseded_by_other_root_table';
      detail = `entity '${named}' is promoted, but its root table is '${promoted.get(named).rootTable?.table ?? '(none)'}' rather than '${table.table}'`;
      examined = [{ relation: 'promoted_root_table', target: promoted.get(named).rootTable?.table ?? '(none)', value: 'a different table already roots this entity' }];
    } else {
      reason = 'table_names_no_promoted_entity';
      detail = `table '${table.table}' singularises to '${named}', which is not a promoted entity and raised no candidate decision`;
      examined = [{ relation: 'table_singular', target: named, value: 'not a promoted entity' }];
    }
    tableAudit.push({ table: table.table, outcome: 'no_entity', reason });
    refusals.push({
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'refusal', id: `refusal:table-audit:${table.table}`,
      producer: ENTITY_LAYER_PRODUCER, rule: 'E1-root-table',
      subject: table.table, subject_kind: 'table', reason, reason_detail: detail,
      examined, witnesses: table.declarations,
    });
  }

  // ---- RELATIONSHIPS ---------------------------------------------------
  // subject(T): which entity a table's rows BELONG to. Only three groundable answers.
  const subjectOf = table => {
    const projection = table.table.match(PROJECTION_OF);
    const bySingular = singularize(table.table);
    if (promotedNames.has(bySingular) && promoted.get(bySingular).rootTable?.table === table.table) return { entity: bySingular, basis: 'root_table', status: 'schema_declared' };
    if (table.primary_key.length === 1) {
      const named = singularize(table.primary_key[0].replace(/_id$/, ''));
      if (promotedNames.has(named)) return { entity: named, basis: 'pk_identity', status: 'schema_declared' };
    }
    if (projection) {
      const projected = singularize(projection[1]);
      if (promotedNames.has(projected)) return { entity: projected, basis: 'read_model_projection', status: 'read_model_evidence' };
    }
    return null;
  };

  const relationships = new Map();
  const addRelationship = (from, to, relation, cardinality, via, basis, status, witnesses, note) => {
    if (from === to && relation === 'has_one') return; // a 1:1 self-reference is not a hierarchy
    const id = `rel:${from}:${relation}:${to}:${via}`;
    if (relationships.has(id)) return;
    relationships.set(id, {
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'relationship', id, producer: ENTITY_LAYER_PRODUCER,
      rule: basis === 'declared_foreign_key' ? 'R1-declared-foreign-key' : basis === 'fk_shaped_column' ? 'R2-foreign-key-shaped-column' : basis === 'polymorphic_check_enum' ? 'R3-polymorphic-check-enum' : 'R4-link-table',
      from, to, relation, cardinality, via, basis, status, note: note || null,
      witnesses: dedupeWitnesses(witnesses),
    });
  };

  for (const table of [...tables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    const subject = subjectOf(table);
    const declaredByColumn = new Map(table.refs.map(ref => [ref.column, ref]));
    const entityColumns = [];
    for (const column of [...table.columns.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = declaredByColumn.get(column.name);
      // A DECLARED reference resolves through the TARGET TABLE, which is stronger than any
      // name rule: the schema itself says where the column points.
      const declaredEntity = ref ? (() => {
        const target = tables.get(ref.target_table);
        if (!target) return null;
        const bySingular = singularize(ref.target_table);
        if (promotedNames.has(bySingular)) return bySingular;
        const projection = ref.target_table.match(PROJECTION_OF);
        if (projection && promotedNames.has(singularize(projection[1]))) return singularize(projection[1]);
        return null;
      })() : null;
      const resolved = declaredEntity ? { entity: declaredEntity, role: column.name.replace(/_?id$/, '').replace(new RegExp(`_?${declaredEntity}$`), '') || null } : resolveIdColumn(column.name, promotedNames, ID_ALIASES);
      const polymorphic = /^item_id$|_item_id$/.test(column.name);
      if (resolved) entityColumns.push({ column, resolved, declared: Boolean(ref), ref });
      // A refusal is recorded when the table DOES belong to an entity (so a real relationship
      // is missing one end) or when the column is polymorphic (a named, general limitation
      // worth a record wherever it appears — `initiative_membership.item_id` is the canonical
      // case, and it has no entity subject at all). Every other unresolvable `*_id` column in a
      // subject-less plumbing table is counted in the census instead of minting ~100 records.
      else if ((subject || polymorphic) && column.name !== 'id' && !table.primary_key.includes(column.name)) {
        refusals.push({
          schema: ENTITY_LAYER_SCHEMA, record_kind: 'refusal', id: `refusal:id-column:${table.table}.${column.name}`,
          producer: ENTITY_LAYER_PRODUCER, rule: 'R2-foreign-key-shaped-column',
          subject: `${table.table}.${column.name}`, subject_kind: 'id_column',
          reason: polymorphic ? 'polymorphic_reference_not_resolvable_from_schema' : 'id_column_names_no_promoted_entity',
          reason_detail: `column '${column.name}' in table '${table.table}' is FK-shaped but its stem names no promoted entity`,
          examined: [{ relation: 'id_column_stem', target: column.name.replace(/_id$/, ''), value: 'not a promoted entity' }],
          witnesses: [column.at],
        });
      }
    }
    if (!subject) {
      // Preserve source witnesses; do not infer authority from naming conventions alone.
      const pkEntity = entityColumns.find(item => item.column.primary_key || table.primary_key.includes(item.column.name));
      if (!pkEntity) {
        if (entityColumns.length) refusals.push({
          schema: ENTITY_LAYER_SCHEMA, record_kind: 'refusal', id: `refusal:table:${table.table}`,
          producer: ENTITY_LAYER_PRODUCER, rule: 'R4-link-table',
          subject: table.table, subject_kind: 'table', reason: 'detail_table_without_entity_subject',
          reason_detail: `table '${table.table}' carries ${entityColumns.length} entity column(s) but its primary key names no promoted entity, so the other end of the relationship is not groundable`,
          examined: [{ relation: 'primary_key', target: table.primary_key.join(',') || '(none)', value: 'names no promoted entity' }],
          witnesses: table.declarations,
        });
        continue;
      }
      const compositePk = table.primary_key.length > 1;
      for (const item of entityColumns) {
        if (item === pkEntity) continue;
        const bothInPk = compositePk && table.primary_key.includes(item.column.name) && table.primary_key.includes(pkEntity.column.name);
        addRelationship(
          item.resolved.entity, pkEntity.resolved.entity,
          bothInPk ? 'relates_to' : (cardinalityOf(pkEntity.column) === '1..1' ? 'has_one' : 'has_many'),
          bothInPk ? 'N..N' : cardinalityOf(pkEntity.column),
          `${table.table}.${item.column.name}`, item.declared ? 'declared_foreign_key' : 'link_table',
          item.declared ? 'schema_declared' : 'shape_only',
          [item.column.at, ...table.declarations], `link table '${table.table}'${item.resolved.role ? ` · role ${item.resolved.role}` : ''}`,
        );
      }
      continue;
    }
    for (const item of entityColumns) {
      if (item.resolved.entity === subject.entity && !item.resolved.role) continue;
      addRelationship(
        item.resolved.entity, subject.entity,
        cardinalityOf(item.column) === '1..1' ? 'has_one' : 'has_many', cardinalityOf(item.column),
        `${table.table}.${item.column.name}`,
        item.declared ? 'declared_foreign_key' : 'fk_shaped_column',
        // A column with no REFERENCES clause is a NAME match, and a name match is never
        // `schema_declared` however solid the table's own identity is: SQLite is not
        // enforcing it. Read-model evidence is weaker still and says so.
        item.declared ? 'schema_declared' : subject.status === 'read_model_evidence' ? 'read_model_evidence' : 'shape_only',
        [item.column.at, ...table.declarations],
        item.resolved.role ? `role ${item.resolved.role}` : null,
      );
    }
  }

  // R3: a polymorphic link table whose `<x>_kind CHECK (<x>_kind IN (...))` ENUMERATES the
  // entities its `<x>_id` may point at. The enum is a schema fact, so the many-to-many is
  // derivable exactly where the bare `item_id` column is not — which is why
  // `initiative_membership.item_id` earns a refusal AND this rule earns four relationships
  // from the same table without either contradicting the other.
  for (const table of [...tables.values()].sort((a, b) => a.table.localeCompare(b.table))) {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    if (/_new$/.test(table.table)) continue;
    for (const enumeration of table.check_enums) {
      const stem = enumeration.column.replace(/_kind$/, '');
      if (stem === enumeration.column) continue;
      const idColumn = table.columns.get(`${stem}_id`);
      if (!idColumn) continue;
      const anchors = [...table.columns.values()]
        .map(column => ({ column, resolved: resolveIdColumn(column.name, promotedNames, ID_ALIASES) }))
        .filter(item => item.resolved && item.column.name !== idColumn.name);
      if (anchors.length !== 1) continue;
      const anchor = anchors[0];
      for (const value of enumeration.values) {
        const target = promotedNames.has(value) ? value : (promotedNames.has(singularize(value)) ? singularize(value) : null);
        if (!target || target === anchor.resolved.entity) continue;
        addRelationship(anchor.resolved.entity, target, 'relates_to', 'N..N',
          `${table.table}.${idColumn.name}`, 'polymorphic_check_enum', 'schema_declared',
          [enumeration.at, idColumn.at, ...table.declarations],
          `CHECK (${enumeration.column} IN …) enumerates '${value}'`);
      }
    }
  }

  // ---- ENVELOPE ATTACHMENT --------------------------------------------
  let attached = 0;
  const refusedEnvelopeKinds = [];
  for (const [prefix, kinds] of [...envelopesByPrefix].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Only explicit estate aliases may connect an abbreviated event prefix to
    // a promoted entity; similar spellings alone do not establish identity.
    const aliased = ID_ALIASES[prefix] || ID_ALIASES[singularize(prefix)] || null;
    const entity = promotedNames.has(prefix) ? prefix
      : promotedNames.has(singularize(prefix)) ? singularize(prefix)
        : aliased && promotedNames.has(aliased) ? aliased : null;
    for (const item of kinds) {
      if (!entity) { refusedEnvelopeKinds.push({ prefix, item }); continue; }
      attached++;
      records.push({
        schema: ENTITY_LAYER_SCHEMA, record_kind: 'envelope_attachment', id: `envelope:${item.kind}:${entity}`,
        producer: ENTITY_LAYER_PRODUCER, rule: 'V1-namespace-prefix',
        envelope_kind: item.kind, envelope_node: item.id, entity,
        witnesses: dedupeWitnesses([item.witness, ...(promoted.get(entity)?.rootTable?.declarations || [])].filter(Boolean)),
      });
    }
  }
  for (const { prefix, item } of refusedEnvelopeKinds) {
    refusals.push({
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'refusal', id: `refusal:envelope:${item.kind}`,
      producer: ENTITY_LAYER_PRODUCER, rule: 'V1-namespace-prefix',
      subject: item.kind, subject_kind: 'envelope_kind', reason: 'envelope_prefix_names_no_promoted_entity',
      reason_detail: `envelope kind '${item.kind}' has leading namespace '${prefix}', which names no promoted entity; the lifecycle it narrates is not derivable from the kind name alone and is refused rather than guessed`,
      examined: [{ relation: 'namespace_prefix', target: prefix, value: 'not a promoted entity' }],
      witnesses: item.witness ? [item.witness] : [],
    });
  }

  // ---- CAPABILITY ATTACHMENT ------------------------------------------
  // Instrument fix J1: the capability layer answers "which capabilities exist,
  // who provides them, who calls them". This block answers the FOURTH question
  // the brief adds — what each capability is ABOUT — and refuses wherever the
  // name does not reach a promoted entity.
  const capabilityNodes = (graph.nodes || []).filter(node => node.kind === 'capability')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  let capabilitiesAttached = 0;
  const refusedCapabilities = [];
  for (const node of capabilityNodes) {
    const candidates = capabilityEntityCandidates(node.name);
    const entity = candidates.find(candidate => promotedNames.has(candidate)) || null;
    const witnesses = dedupeWitnesses((node.witnesses || []).slice(0, 4).map(item => ({ repo: item.repo, file: item.file, line: item.line })));
    if (!entity || !witnesses.length) {
      refusedCapabilities.push({ node, candidates, witnesses });
      continue;
    }
    capabilitiesAttached++;
    records.push({
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'capability_attachment', id: `capability:${node.name}:${entity}`,
      producer: ENTITY_LAYER_PRODUCER, rule: 'C1-capability-type-name',
      capability: node.name, capability_node: node.id, entity,
      providers: [...(node.providers || [])].sort(),
      witnesses: dedupeWitnesses([...witnesses, ...(promoted.get(entity)?.rootTable?.declarations || [])]),
    });
  }
  for (const { node, candidates, witnesses } of refusedCapabilities) {
    refusals.push({
      schema: ENTITY_LAYER_SCHEMA, record_kind: 'refusal', id: `refusal:capability:${node.name}`,
      producer: ENTITY_LAYER_PRODUCER, rule: 'C1-capability-type-name',
      subject: node.name, subject_kind: 'capability', reason: 'capability_type_names_no_promoted_entity',
      reason_detail: `capability '${node.name}' names no promoted entity under the type-name rule (tried ${candidates.join(', ')}); the entity its contract is about is not derivable from the type name alone and is refused rather than guessed`,
      examined: [{ relation: 'capability_type_name', target: candidates.join(', '), value: 'no candidate is a promoted entity' }],
      witnesses,
    });
  }

  // ---- CONFLICTS ------------------------------------------------------
  const addConflict = (id, reason, about, claimA, claimB) => conflicts.push({
    schema: ENTITY_LAYER_SCHEMA, record_kind: 'conflict', id, producer: ENTITY_LAYER_PRODUCER,
    reason, about, claim_a: claimA, claim_b: claimB,
    witnesses: dedupeWitnesses([...claimA.witnesses, ...claimB.witnesses]),
  });

  // (a) The model and the schema name the same thing differently. The SOURCE WINS: the
  // canonical entity is the schema's, and the model's name is recorded as the other claim.
  for (const [kind, at] of [...model.entityKinds].sort((a, b) => a[0].localeCompare(b[0]))) {
    const schemaName = singularize(kind);
    if (schemaName === kind) continue;
    if (!promotedNames.has(schemaName)) continue;
    addConflict(`conflict:name:${kind}`, 'entity_name_disagreement', schemaName,
      { source: 'sqlite_schema', statement: `the entity's tables and identity columns name it '${schemaName}'`, witnesses: promoted.get(schemaName).rootTable?.declarations || [] },
      { source: 'shipped_model', statement: `${entityExport} names it '${kind}'`, witnesses: [at] });
  }
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  for (const [kind, at] of [...model.entityKinds].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (promotedNames.has(singularize(kind))) continue;
    const parts = kind.split('_');
    for (let start = 1; start < parts.length; start++) {
      const tail = singularize(parts.slice(start).join('_'));
      if (!promotedNames.has(tail)) continue;
      addConflict(`conflict:name:${kind}`, 'entity_name_disagreement', tail,
        { source: 'sqlite_schema', statement: `the entity's tables and identity columns name it '${tail}'`, witnesses: promoted.get(tail).rootTable?.declarations || [] },
        { source: 'shipped_model', statement: `${entityExport} names it '${kind}'`, witnesses: [at] });
      break;
    }
  }
  // (b) The model declares a kind the schema knows nothing about.
  for (const decision of decisions) {
    if (decision.refusal !== 'model_kind_without_schema_evidence' || !decision.candidate.modelKind) continue;
    addConflict(`conflict:model-only:${decision.candidate.entity}`, 'model_declares_entity_schema_has_no_table', decision.candidate.entity,
      { source: 'shipped_model', statement: `${entityExport} declares '${decision.candidate.modelKind.kind}'`, witnesses: [decision.candidate.modelKind.at] },
      { source: 'sqlite_schema', statement: `no CREATE TABLE and no '${decision.candidate.entity}_id' column exists in ${tables.size} non-test tables`, witnesses: [] });
  }
  // A cross-source conflict needs two available sources. An absent model is one
  // counted refusal, not a separate disagreement for every promoted entity.
  const modelDeclaresKinds = model.entityKinds.size > 0;
  for (const [entity, decision] of (modelDeclaresKinds ? [...promoted].sort((a, b) => a[0].localeCompare(b[0])) : [])) {
    if (decision.candidate.modelKind) continue;
    if ([...model.entityKinds.keys()].some(kind => kind.endsWith(`_${entity}`) || singularize(kind) === entity)) continue;
    addConflict(`conflict:schema-only:${entity}`, 'schema_declares_entity_model_has_no_kind', entity,
      { source: 'sqlite_schema', statement: `${decision.rootTable ? `CREATE TABLE ${decision.rootTable.table}` : `'${entity}_id' columns in ${decision.referencedTables.size} tables`} declares '${entity}'`, witnesses: decision.rootTable ? decision.rootTable.declarations : [] },
      { source: 'shipped_model', statement: `${entityExport} has no '${entity}' kind (${model.entityKinds.size} kinds declared)`, witnesses: [{ repo: model.repo, file: model.file, line: [...model.entityKinds.values()][0].line }] });
  }
  // (d) A self-lineage relationship the schema carries and the model has NO edge kind for.
  // Derive missing lineage coverage from witnessed relationships; do not invent edge kinds.
  const modelEdgeNames = new Set(model.edgeKinds.keys());
  for (const relationship of [...relationships.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (relationship.from !== relationship.to) continue;
    if (!/spawn|lineage|parent|child/.test(relationship.via)) continue;
    const covered = [...modelEdgeNames].some(name => relationship.via.includes(name) || /^(?:parent|nested_batch|membership)$/.test(name) && /parent/.test(relationship.via));
    if (covered) continue;
    addConflict(`conflict:edge-gap:${relationship.id}`, 'schema_relationship_has_no_model_edge_kind', relationship.from,
      { source: 'sqlite_schema', statement: `${relationship.via} declares a ${relationship.cardinality} ${relationship.from} -> ${relationship.to} lineage`, witnesses: relationship.witnesses },
      { source: 'shipped_model', statement: `${edgeExport} (${model.edgeKinds.size} kinds) has no lineage edge for it: ${[...modelEdgeNames].sort().join(', ')}`, witnesses: [[...model.edgeKinds.values()][0]] });
  }

  const all = [...records, ...relationships.values(), ...refusals, ...conflicts]
    .sort((a, b) => `${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  const relationshipRecords = [...relationships.values()];
  const census = {
    producer: ENTITY_LAYER_PRODUCER,
    tables_examined: tables.size,
    candidates: candidates.size,
    entities_promoted: promoted.size,
    entities_with_instance_table: [...promoted.values()].filter(decision => decision.rootTable).length,
    entities_refused: decisions.filter(decision => decision.refusal).length,
    refused_by_reason: countBy(decisions.filter(decision => decision.refusal).map(decision => decision.refusal)),
    relationships: relationshipRecords.length,
    relationships_by_cardinality: countBy(relationshipRecords.map(record => record.cardinality)),
    relationships_by_basis: countBy(relationshipRecords.map(record => record.basis)),
    envelope_kinds_seen: [...envelopesByPrefix.values()].reduce((total, list) => total + list.length, 0),
    envelope_kinds_attached: attached,
    envelope_kinds_refused: refusedEnvelopeKinds.length,
    capabilities_seen: capabilityNodes.length,
    capabilities_attached: capabilitiesAttached,
    capabilities_refused: refusedCapabilities.length,
    tables_backing_an_entity: tableAudit.filter(row => row.outcome === 'backs_entity').length,
    tables_backing_no_entity: tableAudit.filter(row => row.outcome === 'no_entity').length,
    tables_backing_no_entity_by_reason: countBy(tableAudit.filter(row => row.outcome === 'no_entity').map(row => row.reason)),
    conflicts: conflicts.length,
    conflicts_by_reason: countBy(conflicts.map(record => record.reason)),
    refusal_records: refusals.length,
    refusal_records_by_reason: countBy(refusals.map(record => record.reason)),
    entities: [...promoted.keys()].sort(),
    table_audit: tableAudit,
  };
  if (!entityConfig) census.configuration_dispositions = unconfiguredEntityAnalysis(['read_model_prefixes', 'identity_aliases']);
  return { records: all, census };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

async function readFacts(factsDir) {
  const entries = (await fs.readdir(factsDir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort();
  const facts = [];
  for (const name of entries) {
    for (const line of (await fs.readFile(path.join(factsDir, name), 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const fact = JSON.parse(line);
      if (fact.kind === 'sqlite_table' || fact.kind === 'sqlite_ref' || fact.kind === 'sqlite_id_column') facts.push(fact);
    }
  }
  return facts;
}

export async function produceEntityLayer(graphFile, outFile, {
  factsDir = null, estateRoot = process.cwd(), modelPath = DEFAULT_MODEL_PATH, discoveryFile = null, censusFile = null, entityConfig = null,
} = {}) {
  entityConfig = validateEntityAnalysisConfig(entityConfig);
  modelPath ??= entityConfig?.model_path ?? null;
  // J4: fail HERE, where the name is chosen, instead of at merge time where the
  // symptom is an unrelated `unknown field(s)` error from the overlay validator.
  if (!outFile.endsWith(ENTITY_LAYER_FILE_SUFFIX)) {
    throw new Error(`entity-layer: output '${path.basename(outFile)}' must end in '${ENTITY_LAYER_FILE_SUFFIX}'.\n  annotate.mjs merge routes overlay files by filename suffix ONLY; under any other name these records are read as annotation overlays and rejected by validateAnnotation.\n  Fix: write to '${path.basename(outFile).replace(/(?:\.jsonl)?$/, '')}${ENTITY_LAYER_FILE_SUFFIX}' instead.`);
  }
  const graph = JSON.parse(await fs.readFile(graphFile, 'utf8'));
  const facts = await readFacts(factsDir || path.join(path.dirname(graphFile), '..', 'facts'));
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const [repo, ...rest] = (modelPath ?? '').split('/');
  const resolvedModelPath = modelPath ? path.join(estateRoot, modelPath) : null;
  let model = null;
  let modelRefusal = null;
  try {
    if (!resolvedModelPath) throw Object.assign(new Error('model path is not configured'), { code: 'ENOENT' });
    const modelSource = await fs.readFile(resolvedModelPath, 'utf8');
    model = parseShippedModel(modelSource, { repo, file: rest.join('/'), entityConfig });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Degrade to an EMPTY model of the right SHAPE, not null. deriveEntityLayer and the
    // report writers iterate model.entityKinds / model.edgeKinds unconditionally, so a null
    // here just moves the crash one frame deeper (`reading 'entityKinds'`) — which is
    // exactly what the first version of this guard did.
    model = { entityKinds: new Map(), edgeKinds: new Map(), repo, file: rest.join('/') };
    modelRefusal = {
      refusal: modelPath ? 'shipped_model_absent' : 'shipped_model_unconfigured',
      ...(modelPath ? {} : { count: 1 }),
      evidence: 'absence',
      model_path: modelPath,
      resolved_path: resolvedModelPath,
      why: 'optional corroboration source not present on this estate; entity records are derived from facts+graph only',
    };
    console.warn(`entity-layer: no shipped model at ${modelPath} — degrading to facts+graph only (${modelRefusal.refusal}).`);
  }
  const discovery = discoveryFile ? JSON.parse(await fs.readFile(discoveryFile, 'utf8')) : null;
  const { records, census } = deriveEntityLayer({ facts, graph, model, discovery, entityConfig });
  if (modelRefusal) census.refusals = [...(census.refusals || []), modelRefusal];
  // Validate with the SHIPPED validator before writing. A malformed record that reached the
  // merged artifact would be caught by `annotate.mjs merge` anyway; failing here means the
  // producer never emits a file the schema owner would reject.
  records.forEach((record, index) => validateEntityLayerRecord(record, `${outFile}:${index + 1}`));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  // One record per line, matching domain-derivation.mjs#writeJsonl and
  // structural-grouping.mjs#writeJsonl byte for byte in shape. `stableStringify` is NOT used:
  // it pretty-prints, which breaks the one-record-per-line contract annotate.mjs#readJsonl
  // parses — the exact failure this producer hit on its first real run.
  await fs.writeFile(outFile, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  if (censusFile) { await fs.mkdir(path.dirname(censusFile), { recursive: true }); await fs.writeFile(censusFile, JSON.stringify(census, null, 2) + '\n', 'utf8'); }
  return { out: outFile, records, census };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length < 2) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  produceEntityLayer(path.resolve(positional[0]), path.resolve(positional[1]), {
    factsDir: options.facts ? path.resolve(options.facts) : null,
    estateRoot: options.estate ? path.resolve(options.estate) : process.cwd(),
    modelPath: options.model || DEFAULT_MODEL_PATH,
    entityConfig: loadEntityAnalysisConfig(options['runtime-config']),
    discoveryFile: options.discovery ? path.resolve(options.discovery) : null,
    censusFile: options.census ? path.resolve(options.census) : null,
  }).then(result => {
    if (options.json) { console.log(JSON.stringify(result.census, null, 2)); return; }
    const { census } = result;
    console.log(`Entity layer: ${census.entities_promoted} entity type(s) from ${census.tables_examined} tables · ${census.relationships} relationship(s) · ${census.envelope_kinds_attached}/${census.envelope_kinds_seen} envelope kinds attached · ${census.capabilities_attached}/${census.capabilities_seen} capabilities attached · ${census.conflicts} conflict(s) · ${census.refusal_records} refusal record(s)`);
    console.log(`Entities: ${census.entities.join(', ')}`);
    console.log(`Wrote ${result.records.length} record(s) to ${result.out}`);
  }).catch(error => { console.error(error.message); process.exit(1); });
}
