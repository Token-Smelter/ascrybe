import { posix } from 'node:path';
import { stableCanonicalSha256, stableStringify, sha256 } from './lib.mjs';
import { sourcePins } from './source-pin-identity.mjs';
export { sourcePins };
import { validateClaimMapShardManifest } from './claim-map-shards.mjs';
import { Neo4jHttpClient } from './c3-serving-projection.mjs';
// Head addressing and head reads live in their own module so a read-only client can import them
// without the builder; re-exported here because callers of the builder expect them.
import { estateSlot, readEstateProjectionHeads } from './estate-projection-heads.mjs';
export { estateSlot, readEstateProjectionHeads };
import { nodePlane, relationRole, structuralEndpoints, UNCLASSIFIED } from './estate-graph-roles.mjs';
import { documentedAssertions } from './documented-assertions.mjs';
import { assertionRelations } from './assertion-relations.mjs';

export const ESTATE_GRAPH_PROJECTION_SCHEMA = 'estate-map/unified-serving-projection/v1';
export const ESTATE_GRAPH_PROJECTION_VERSION = 'unified-serving-projection@2';
const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
// Neo4j ORDER BY uses code-point order, not host-locale collation. Projection manifests must use
// the same order or paged exact-ID verification diverges at uppercase/lowercase boundaries.
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export class EstateGraphProjectionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EstateGraphProjectionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new EstateGraphProjectionError(code, message, detail);
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const held of Object.values(value)) immutable(held);
  return Object.freeze(value);
}

function safeJson(value) {
  return value == null ? null : canonical(value);
}

// Projection identity must be a function of graph CONTENT, so that re-projecting an unchanged map
// recognizes the existing generation instead of building a new one. `scripts/remap.mjs` stamps
// provenance.mapped_at with the wall clock of its run, so hashing the code graph verbatim gave two
// byte-identical maps different identities and forced a full rebuild on every re-projection. When
// the map really changes, source_head and code_plane_head in the same provenance block move with it.
function codeGraphIdentityDigest(codeGraph) {
  if (!codeGraph) return null;
  const { provenance, ...rest } = codeGraph;
  if (!provenance || typeof provenance !== 'object') return stableCanonicalSha256(codeGraph);
  const { mapped_at: _volatile, ...stableProvenance } = provenance;
  return stableCanonicalSha256({ ...rest, provenance: stableProvenance });
}

function verifiedProjectionIdentity({ source_commit, claim_map_digest, code_graph: codeGraph }) {
  if (!codeGraph || codeGraph.schema !== 'estate-map/remap-code-graph/v1') {
    stateError('UNIFIED_PROJECTION_CODE_GRAPH_INVALID', 'projection coverage requires a remap code graph');
  }
  if (sourcePins(codeGraph.provenance)?.digest !== source_commit) {
    stateError('UNIFIED_PROJECTION_SOURCE_MISMATCH', 'claim and code artifacts must name the same source identity');
  }
  return Object.freeze({ source_commit, claim_map_digest,
    code_graph_digest: codeGraphIdentityDigest(codeGraph) });
}

/** Verify external projection inputs before an evaluation derives coverage from them. */
export function verifiedProjectionInputs({ claim_map: claimMap, code_graph: codeGraph }) {
  if (claimMap?.schema !== 'estate-map/claim-evidence-map/v1'
    || !/^[0-9a-f]{64}$/u.test(claimMap.digest || '') || !clean(claimMap.project?.sha)) {
    stateError('UNIFIED_PROJECTION_CLAIM_MAP_INVALID', 'projection requires a digested claim-evidence map');
  }
  const { digest: claimMapDigest, ...claimMapBody } = claimMap;
  if (stableCanonicalSha256(claimMapBody) !== claimMapDigest) {
    stateError('UNIFIED_PROJECTION_CLAIM_MAP_DIGEST_MISMATCH', 'claim-evidence map differs from its declared digest');
  }
  return verifiedProjectionIdentity({ source_commit: claimMap.project.sha,
    claim_map_digest: claimMapDigest, code_graph: codeGraph });
}

/** Verify projection identity from an already byte-verified claim-map shard manifest. */
export function verifiedProjectionShardInputs({ claim_map_manifest: manifest, code_graph: codeGraph }) {
  validateClaimMapShardManifest(manifest);
  return verifiedProjectionIdentity({ source_commit: manifest.project.sha,
    claim_map_digest: manifest.source_map_digest, code_graph: codeGraph });
}

// The estate declares distinct kinds of thing, and the entry view can only surface a plugin or a
// capability if the projection keeps that distinction. Entity kind follows the producer fact kind;
// anything unrecognized stays a generic Referent rather than being guessed at.
export const ENTITY_KINDS = Object.freeze({
  capability_flow: 'Capability',
  envelope_flow: 'Envelope',
  http_route: 'Route',
  module: 'Module',
  package_manifest: 'Package',
  repo: 'Repository',
  sql_object: 'Table',
  sqlite_table: 'Table',
  symbol: 'Symbol',
  tf_declaration: 'Infrastructure',
  tf_module_call: 'Infrastructure',
  tf_resource: 'Infrastructure',
  yaml_record: 'SchemaRecord',
});

// Declarations the estate makes at its top level. Everything else is reached through the thing
// that declares it: a symbol through its module, a route through the plugin that exposes it.
const TOP_LEVEL_DECLARATION_KINDS = new Set([
  'Capability', 'DeclaredDocument', 'Envelope', 'Infrastructure', 'Module', 'Package',
  'Plugin', 'Repository', 'SchemaRecord',
]);

export const FACT_CONTAINERS = Object.freeze(['commit', 'document', 'section', 'diagram']);

export const EXTRACTED_FACT_KINDS = Object.freeze({
  // A drawing and the edges read out of it are documentary assertions, never observations. They
  // are projected so a reader can ask what a document claims, and kept in their own kinds so no
  // adjudicator can mistake a drawn arrow for a witnessed relation.
  diagram: { node_kind: 'Diagram', contained_by: 'section',
    // A drawing is named by where it was drawn.
    label: fact => `${fact.diagram_shape} diagram ${fact.diagram_address}` },
  diagram_relation: { node_kind: 'DiagramRelation', contained_by: 'diagram',
    // A drawn edge by what the author wrote on it.
    label: fact => `${fact.from_identifier} ${fact.relation_label || fact.arrow} ${fact.to_identifier}` },
  // A section is where a document says something, which is what lets a claim cite more than a
  // line number. It belongs to the section above it, and a top-level section to its document.
  document_section: { node_kind: 'DocumentSection', contained_by: 'section',
    label: fact => fact.section_path },
  catalog_entry: { node_kind: 'CatalogEntry', contained_by: 'commit',
    label: fact => fact.entry_key_path },
  catalog_entry_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  declaration_comment: { node_kind: 'DeclarationComment', contained_by: 'commit',
    label: fact => fact.declaration },
  manifest_empty_declaration: { node_kind: 'EmptyDeclaration', contained_by: 'commit',
    label: fact => fact.declaration_key },
  tool_registration: { node_kind: 'ToolRegistration', contained_by: 'commit',
    label: fact => fact.name },
  tool_registration_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  // Three more refusal kinds named exactly like the seven already declared here, missed the same
  // way an unregistered kind is always missed: the extractor shipped, the refusal fact carries a
  // `reason` like every sibling refusal, and nothing forced this table to keep pace with it.
  capability_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  http_route_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  manifest_completeness_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  literal_value: { node_kind: 'LiteralValue', contained_by: 'commit',
    label: fact => `${fact.name} = ${fact.value_text ?? fact.value_kind}` },
  predicate_literal: { node_kind: 'PredicateLiteral', contained_by: 'commit',
    label: fact => fact.surface ?? fact.pattern ?? fact.name },
  // Where a program declares its own failure, which is the answer to "what can this throw".
  throw_site: { node_kind: 'ThrowSite', contained_by: 'commit',
    label: fact => fact.thrown ?? fact.surface ?? 'throw' },
  path_expression: { node_kind: 'PathExpression', contained_by: 'commit',
    label: fact => fact.expression ?? fact.surface },
  reference: { node_kind: 'Reference', contained_by: 'commit',
    label: fact => fact.surface ?? fact.name },
  yaml_record: { node_kind: 'YamlRecord', contained_by: 'commit',
    label: fact => fact.record_key ?? fact.key_path ?? fact.file },
  // THE DEPLOYED SURFACE. Infrastructure a component declares, uses, or is bound to by
  // environment is what tells a reader which parts of an estate are shared and which belong to one
  // product. All of it was extracted and none of it projected, so the map could describe code and
  // documents while saying nothing about what either runs on.
  aws_resource_declaration: { node_kind: 'AwsResource', contained_by: 'commit',
    label: fact => `${fact.resource_type ?? 'resource'} ${fact.resource_name ?? fact.logical_id ?? ''}`.trim() },
  aws_usage: { node_kind: 'AwsUsage', contained_by: 'commit',
    label: fact => `${fact.service ?? 'aws'} ${fact.operation ?? fact.resource_name ?? ''}`.trim() },
  aws_env_binding: { node_kind: 'EnvironmentBinding', contained_by: 'commit',
    label: fact => `${fact.variable ?? fact.name} -> ${fact.resource_name ?? fact.value ?? '?'}` },
  aws_usage_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  service_hostname: { node_kind: 'ServiceHostname', contained_by: 'commit',
    label: fact => fact.host ?? fact.hostname ?? fact.value },
  config_value_url: { node_kind: 'ConfiguredUrl', contained_by: 'commit',
    label: fact => `${fact.key ?? fact.name ?? 'url'} = ${fact.url ?? fact.value ?? ''}` },
  http_client: { node_kind: 'HttpClientCall', contained_by: 'commit',
    label: fact => `${fact.method ?? 'call'} ${fact.target ?? fact.url ?? fact.surface ?? ''}`.trim() },
  http_client_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  persistence_target: { node_kind: 'PersistenceTarget', contained_by: 'commit',
    label: fact => `${fact.store ?? fact.kind_hint ?? 'store'} ${fact.target ?? fact.name ?? ''}`.trim() },
  string_constant: { node_kind: 'StringConstant', contained_by: 'commit',
    label: fact => `${fact.name ?? 'constant'} = ${fact.value ?? ''}` },
  dep: { node_kind: 'Dependency', contained_by: 'commit',
    label: fact => `${fact.name}${fact.version ? `@${fact.version}` : ''}` },
  ts_path_alias: { node_kind: 'PathAlias', contained_by: 'commit',
    label: fact => `${fact.alias} -> ${fact.target ?? ''}` },
  envelope_kind_mention: { node_kind: 'EnvelopeMention', contained_by: 'commit',
    label: fact => fact.envelope_kind ?? fact.kind_name ?? fact.surface },
  inline_script: { node_kind: 'InlineScript', contained_by: 'commit',
    label: fact => `inline script ${fact.file}:${fact.line}` },
  inline_script_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  diagram_node: { node_kind: 'DiagramNode', contained_by: 'diagram',
    label: fact => fact.identifier ?? fact.label ?? fact.node_id },
  // The relational surface, which is where a product's data model actually lives.
  sqlite_table: { node_kind: 'SqliteTable', contained_by: 'commit',
    label: fact => fact.table ?? fact.name },
  sqlite_id_column: { node_kind: 'SqliteIdColumn', contained_by: 'commit',
    label: fact => `${fact.table ?? ''}.${fact.column ?? ''}` },
  sqlite_ref: { node_kind: 'SqliteReference', contained_by: 'commit',
    label: fact => `${fact.from_table ?? ''} -> ${fact.to_table ?? ''}` },
  sqlite_comment: { node_kind: 'SqliteComment', contained_by: 'commit',
    label: fact => fact.text ?? fact.comment ?? '' },
  sql_migration: { node_kind: 'SqlMigration', contained_by: 'commit',
    label: fact => fact.name ?? fact.file },
  tf_ref: { node_kind: 'TerraformReference', contained_by: 'commit',
    label: fact => `${fact.from ?? ''} -> ${fact.to ?? fact.target ?? ''}` },
  yaml_record_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  yaml_parse_refusal: { node_kind: 'ExtractionRefusal', contained_by: 'commit',
    label: fact => fact.reason },
  // How much of a repository was read at all: the denominator every completeness claim needs.
  coverage: { node_kind: 'RepositoryCoverage', contained_by: 'commit',
    label: fact => `${fact.repo}: ${fact.files_scanned} scanned, ${fact.files_skipped} skipped` },
});

export function validateFactKindRegistry(registry) {
  for (const [factKind, entry] of Object.entries(registry)) {
    if (!clean(entry?.node_kind) || typeof entry?.label !== 'function' || !FACT_CONTAINERS.includes(entry?.contained_by)) {
      stateError('UNIFIED_PROJECTION_FACT_KIND_UNDECLARED',
        `extracted fact kind ${factKind} must declare node_kind, label and one of contained_by: ${FACT_CONTAINERS.join(', ')}`,
        { fact_kind: factKind });
    }
  }
  return registry;
}
validateFactKindRegistry(EXTRACTED_FACT_KINDS);

const EXTRACTED_FACT_RELATION = 'observed_in';
export const EXTRACTED_FACT_PROJECTION_ADDITIONS = Object.freeze({
  node_kinds: Object.freeze([...new Set([...Object.values(EXTRACTED_FACT_KINDS).map(entry => entry.node_kind), 'Assertion', 'LiteralLeaf'])].sort(compare)),
  relation_names: Object.freeze([EXTRACTED_FACT_RELATION, 'asserted_in', 'contains', 'declares_value', 'read_from', 'relates_assertion'].sort(compare)),
});

/**
 * The estate-relative path of the document a fact was read from -- the space Document nodes are
 * addressed in.
 *
 * A fact records `file` relative to its own repository; a Document is addressed relative to the
 * estate. Those coincide only when the estate IS one repository rooted at the estate root, which
 * is why a single-repository estate joined perfectly and hid the gap entirely. In a
 * multi-repository estate the two spaces differ, and the map between them lives in the extract
 * manifest, which does not travel into the code graph -- so there is nothing here to rebuild it
 * from, and the container is refused rather than guessed. Facts carrying `document_path` state
 * the address themselves and need none of this.
 */
export function documentPathOf(fact, { multi_repository: multiRepository = false } = {}) {
  return clean(fact?.document_path) || (multiRepository ? null : clean(fact?.file)) || null;
}

/**
 * Where each fact's container can be found: sections by the span they cover, diagrams by the
 * fence address they were read from. Built over the whole stream because a container and the
 * thing it contains arrive as separate facts.
 */
export function containmentIndex(facts, { multi_repository: multiRepository = false,
  address_form: addressForm = 'estate' } = {}) {
  const address = fact => (addressForm === 'repository'
    ? clean(fact?.file) || null
    : documentPathOf(fact, { multi_repository: multiRepository }));
  const sections = new Map();
  const diagrams = new Map();
  const documents = new Map();
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object' || !EXTRACTED_FACT_KINDS[fact.kind]) continue;
    const document = address(fact);
    const factId = `extracted-fact:${sha256(canonical(fact))}`;
    documents.set(factId, document);
    if (!document) continue;
    if (fact.kind === 'document_section') {
      if (!sections.has(document)) sections.set(document, []);
      sections.get(document).push({ id: factId, line: Number(fact.line) || 0,
        line_end: Number(fact.line_end) || 0, depth: Number(fact.section_depth) || 0 });
    }
    if (fact.kind === 'diagram') diagrams.set(`${document}\u0000${fact.diagram_address}`, factId);
  }
  // Deepest first, so a line resolves to the most specific section that covers it rather than to
  // the outermost one, which every line in the document shares.
  for (const rows of sections.values()) {
    rows.sort((left, right) => right.depth - left.depth || compare(left.id, right.id));
  }
  return { sections, diagrams, documents };
}

/**
 * The container of one fact, or the reason there is none. A refusal is a recorded outcome: the
 * fact still reaches the commit so nothing becomes unreachable, and the count of refusals is
 * reported, because a silent fallback is precisely how this class of defect regenerates.
 */
export function factContainer(fact, factId, index, documentExists) {
  const entry = EXTRACTED_FACT_KINDS[fact.kind];
  if (entry.contained_by === 'commit') return { relation: EXTRACTED_FACT_RELATION, parent: 'commit', via: 'commit' };
  const document = index.documents.get(factId) ?? null;
  if (!document) return { refusal: 'document_path_unavailable' };
  if (entry.contained_by === 'diagram') {
    const held = index.diagrams.get(`${document}\u0000${fact.diagram_address}`);
    return held ? { relation: 'contains', parent: held, via: 'diagram' } : { refusal: 'diagram_absent' };
  }
  if (entry.contained_by === 'section') {
    const line = Number(fact.line) || 0;
    // A section never contains itself; its own heading line is covered by its ancestors only.
    const section = (index.sections.get(document) ?? [])
      .find(row => row.id !== factId && line >= row.line && line <= row.line_end);
    if (section) return { relation: 'contains', parent: section.id, via: 'section' };
  }
  const documentId = `doc:${document}`;
  return documentExists(documentId)
    ? { relation: 'contains', parent: documentId, via: 'document' }
    : { refusal: 'document_absent' };
}

function entityKind(factKind, namespace) {
  if (factKind === 'yaml_document') {
    return /(^|\/)plugin\.yaml$/u.test(String(namespace || '')) ? 'Plugin' : 'DeclaredDocument';
  }
  return ENTITY_KINDS[factKind] || 'Referent';
}

function evidenceSourcePath(row) {
  const source = row?.source;
  if (typeof source === 'string') return source;
  if (source && typeof source.path === 'string') return source.path;
  for (const key of ['source_path', 'file', 'path', 'namespace']) {
    if (typeof row?.[key] === 'string') return row[key];
  }
  return null;
}

function summaryForEvidence(row) {
  if (row.kind === 'code_symbol_census') return `${row.matches?.length || 0} declaration matches`;
  if (row.kind === 'verification_execution') return `${(row.command || []).join(' ')} → ${row.exit_code}`;
  if (row.kind === 'documentary_source') return row.source?.path || row.kind;
  if (row.kind === 'source_text') return `${row.path || ''}:${row.line || ''}`;
  if (row.kind === 'open_question') return row.question || row.kind;
  return row.kind;
}

// Neo4j refuses an index key over roughly 8 KB, and a projection that mints one dies with every
// durable artifact already written. search_text is a FIND aid, not the record: the authoritative
// value stays whole in `properties`, so bounding the index key loses nothing a reader can ask for.
// The bound is per part, so one enormous value cannot crowd out the identifiers beside it.
const SEARCH_PART_LIMIT = 512;
const SEARCH_TEXT_LIMIT = 4096;

function graphRecord(kind, id, label, properties = {}, searchParts = []) {
  const bounded = [label, id, ...searchParts]
    .filter(clean)
    .map(part => String(part).slice(0, SEARCH_PART_LIMIT));
  const body = {
    node_id: id,
    kind,
    label: clean(label) || id,
    search_text: bounded.join(' ').toLowerCase().slice(0, SEARCH_TEXT_LIMIT),
    properties,
  };
  return Object.freeze({ ...body, record_digest: sha256(canonical(body)) });
}

function graphEdge(relation, from, to, properties = {}, declaredId = null) {
  const body = { relation, from, to, properties };
  return Object.freeze({ ...body, edge_id: declaredId || `estate-edge:${sha256(canonical(body))}`,
    record_digest: sha256(canonical(body)) });
}

/**
 * Every evaluated leaf of a literal declaration, addressed by the key path its author wrote.
 *
 * Only leaves that HAVE a value are emitted. An `unevaluated` entry records that the extractor
 * declined to evaluate an expression, which is worth keeping on the declaration and worthless as
 * an address: a node saying `config.github = <unevaluated>` answers no question anyone asks.
 */
export function literalLeaves(fact, cap = 4096) {
  if (fact?.kind !== 'literal_value') return [];
  const leaves = [];
  const walk = (node, path) => {
    if (leaves.length >= cap) return;
    const children = node.entries || node.items || null;
    if (children) {
      children.forEach((child, index) => {
        const step = child.key ?? `[${index}]`;
        walk(child, path ? `${path}.${step}` : String(step));
      });
      return;
    }
    if (node.value === undefined || node.value === null) return;
    leaves.push({ key_path: path, value: String(node.value),
      value_kind: node.value_kind ?? null, line: node.line ?? null });
  };
  walk(fact, clean(fact.name) || '');
  return leaves;
}

/**
 * Address evaluated leaves without changing the address of a path that occurs once.
 *
 * Object literals may repeat an authored key. The traversal order is the extractor's source
 * order, so it gives each repeated path a stable ordinal even when the source locations match.
 */
export function addressLiteralLeaves(fact, cap = 4096) {
  const leaves = literalLeaves(fact, cap);
  const multiplicity = new Map();
  for (const leaf of leaves) {
    multiplicity.set(leaf.key_path, (multiplicity.get(leaf.key_path) || 0) + 1);
  }
  const occurrence = new Map();
  return leaves.map(leaf => {
    const keyPathMultiplicity = multiplicity.get(leaf.key_path);
    const keyPathOccurrence = (occurrence.get(leaf.key_path) || 0) + 1;
    occurrence.set(leaf.key_path, keyPathOccurrence);
    return Object.freeze({ ...leaf, key_path_occurrence: keyPathOccurrence, key_path_multiplicity: keyPathMultiplicity });
  });
}

export function literalLeafId(factId, leaf) {
  const address = leaf.key_path_multiplicity === 1
    ? { factId, key_path: leaf.key_path }
    : { factId, key_path: leaf.key_path, occurrence: leaf.key_path_occurrence };
  return `literal-leaf:${sha256(canonical(address))}`;
}

function stateError(code, message, detail = {}) {
  fail(code, message, detail);
}

/** Build one query projection from canonical claim-map and remap artifacts. */
export function buildUnifiedEstateProjection({ claim_map: claimMap, code_graph: codeGraph = null }) {
  if (claimMap?.schema !== 'estate-map/claim-evidence-map/v1'
    || !clean(claimMap.digest) || !clean(claimMap.project?.id) || !clean(claimMap.project?.sha)) {
    stateError('UNIFIED_PROJECTION_CLAIM_MAP_INVALID', 'projection requires a digested claim-evidence map');
  }
  if (codeGraph && codeGraph.schema !== 'estate-map/remap-code-graph/v1') {
    stateError('UNIFIED_PROJECTION_CODE_GRAPH_INVALID', 'code graph schema is unsupported');
  }
  if (codeGraph && sourcePins(codeGraph.provenance)?.digest !== claimMap.project.sha) {
    stateError('UNIFIED_PROJECTION_SOURCE_MISMATCH', 'claim and code artifacts must name the same source identity');
  }

  // Containment outcomes are reported on the projection, so a hierarchy that failed to form is a
  // number rather than something a reader has to notice in the shape of the graph.
  let containmentReport = null;
  const nodes = new Map();
  const edges = new Map();
  const addNode = node => {
    const prior = nodes.get(node.node_id);
    if (prior && prior.record_digest !== node.record_digest) {
      stateError('UNIFIED_PROJECTION_NODE_COLLISION', `node ${node.node_id} has conflicting derivations`);
    }
    nodes.set(node.node_id, node);
  };
  const addEdge = edge => {
    const prior = edges.get(edge.edge_id);
    if (prior && prior.record_digest !== edge.record_digest) {
      stateError('UNIFIED_PROJECTION_EDGE_COLLISION', `edge ${edge.edge_id} has conflicting derivations`);
    }
    edges.set(edge.edge_id, edge);
  };

  const sourceId = `source-commit:${claimMap.project.sha}`;
  const projectId = `project:${claimMap.project.id}`;
  addNode(graphRecord('Project', projectId, claimMap.project.id, {
    project_id: claimMap.project.id, source_commit: claimMap.project.sha,
  }));
  addNode(graphRecord('SourceCommit', sourceId, claimMap.project.sha.slice(0, 12), {
    source_commit: claimMap.project.sha,
  }, [claimMap.project.sha]));
  addEdge(graphEdge('has_source_commit', projectId, sourceId));

  const receiptByClaim = new Map((claimMap.adjudication_receipts || []).map(row => [row.claim_id, row]));
  for (const claim of claimMap.claims || []) {
    const receipt = receiptByClaim.get(claim.claim_id);
    const documentId = `doc:${claim.source.path}`;
    addNode(graphRecord('Document', documentId, claim.source.path, {
      path: claim.source.path, blob_oid: claim.source.blob_oid,
      content_sha256: claim.source.content_sha256,
    }, [claim.source.path]));
    addNode(graphRecord('Claim', claim.claim_id, claim.statement, {
      claim_key: claim.claim_key,
      statement: claim.statement,
      claim_kind: claim.claim_kind,
      source_status: claim.source_status,
      decision_status: claim.decision_status,
      verdict: receipt?.verdict || null,
      realization: receipt?.realization || null,
      source_path: claim.source.path,
      source_line: claim.source.line,
      source_quote: claim.source.quote,
      section_path: claim.read_context?.section_path ?? null,
      valid_time_json: safeJson(claim.valid_time),
      proof_plan_json: safeJson(claim.proof_plan),
    }, [claim.claim_key, claim.source.path, claim.source.quote, receipt?.verdict, receipt?.realization]));
    addEdge(graphEdge('contains', sourceId, documentId));
    addEdge(graphEdge('contains', documentId, claim.claim_id));
  }

  for (const evidence of claimMap.evidence || []) {
    addNode(graphRecord('Evidence', evidence.evidence_id, summaryForEvidence(evidence), {
      evidence_kind: evidence.kind,
      evidence_state: evidence.state,
      source_path: evidenceSourcePath(evidence),
      details_json: safeJson(evidence),
    }, [evidence.kind, evidence.state, summaryForEvidence(evidence)]));
    if (evidence.kind === 'code_symbol_census') for (const match of evidence.matches || []) {
      addNode(graphRecord('CodeFact', match.fact_id, match.surface, {
        repository: match.repository,
        file: match.file,
        line: match.line,
        declaration_kind: match.declaration_kind,
        exact_record_digest: match.exact_record_digest,
      }, [match.surface, match.file, match.declaration_kind]));
      addEdge(graphEdge('contains', sourceId, match.fact_id));
    }
  }

  for (const result of claimMap.obligation_results || []) {
    addNode(graphRecord('ObligationResult', result.result_id,
      `${result.obligation_kind}: ${result.state}`, {
        claim_id: result.claim_id,
        obligation_id: result.obligation_id,
        obligation_kind: result.obligation_kind,
        state: result.state,
        reason: result.reason,
      }, [result.obligation_kind, result.state, result.reason]));
    addEdge(graphEdge('has_obligation_result', result.claim_id, result.result_id));
    for (const evidenceId of result.evidence_ids || []) {
      addEdge(graphEdge('evidenced_by', result.result_id, evidenceId));
    }
  }

  for (const receipt of claimMap.adjudication_receipts || []) {
    addNode(graphRecord('AdjudicationReceipt', receipt.receipt_id,
      `${receipt.verdict} · ${receipt.realization}`, {
        claim_id: receipt.claim_id,
        verdict: receipt.verdict,
        realization: receipt.realization,
        project_sha: receipt.project_sha,
        supporting_evidence_tiers_json: safeJson(receipt.supporting_evidence_tiers),
      }, [receipt.verdict, receipt.realization]));
    addEdge(graphEdge('adjudicated_by', receipt.claim_id, receipt.receipt_id));
  }

  for (const receipt of claimMap.supersession_receipts || []) {
    addNode(graphRecord('SupersessionReceipt', receipt.receipt_id, receipt.cause, {
      old_claim_id: receipt.old_claim_id,
      new_claim_id: receipt.new_claim_id,
      cause: receipt.cause,
    }, [receipt.cause]));
    addEdge(graphEdge('justified_by', receipt.old_claim_id, receipt.receipt_id));
    addEdge(graphEdge('justified_by', receipt.new_claim_id, receipt.receipt_id));
  }

  for (const edge of claimMap.edges || []) {
    addEdge(graphEdge(edge.relation, edge.from, edge.to, {
      basis_receipt_id: edge.basis_receipt_id || null,
      authority: 'claim-evidence-map',
    }, edge.edge_id));
  }

  if (codeGraph) {
    for (const [id, row] of Object.entries(codeGraph.nodes || {})) {
      const documentary = row.r === 'document' || id.startsWith('doc:');
      if (documentary && nodes.has(id)) continue;
      const kind = documentary ? 'Document' : entityKind(row.r, row.ns);
      const documentPath = documentary && typeof row.l === 'string' ? posix.normalize(row.l) : null;
      addNode(graphRecord(kind, id, row.l || id, {
        namespace: row.ns || null,
        fact_kind: row.r || null,
        // remap emits the document's repository-relative path as l. Preserve it as
        // canonical provenance; namespace is merely the generic "document" category.
        path: documentPath,
      }, [row.l, row.ns, row.r]));
      // The commit contains the declarations made in it. Without this edge the estate anchor
      // reaches documents and code facts but never a plugin or capability, so a traversal that
      // starts at the estate cannot arrive at the things the estate declares. Symbols, routes and
      // tables are deliberately excluded: their container is the module that declares them.
      if (!documentary && TOP_LEVEL_DECLARATION_KINDS.has(kind)) {
        addEdge(graphEdge('contains', sourceId, id));
      }
    }
    for (const binding of codeGraph.identity_bindings || []) {
      const priorFact = nodes.get(binding.fact_id);
      const bindingProperties = {
        repository: binding.repository || null,
        file: binding.file || null,
        line: binding.line || null,
        declaration_kind: binding.declaration_kind || null,
        fact_kind: binding.fact_kind || null,
      };
      if (priorFact) {
        if (priorFact.kind !== 'CodeFact'
          || ['repository', 'file', 'line', 'declaration_kind'].some(field =>
            priorFact.properties[field] != null && bindingProperties[field] != null
              && priorFact.properties[field] !== bindingProperties[field])) {
          stateError('UNIFIED_PROJECTION_NODE_COLLISION',
            `code fact ${binding.fact_id} has conflicting evidence and identity derivations`);
        }
        nodes.set(binding.fact_id, graphRecord('CodeFact', binding.fact_id,
          priorFact.label || binding.surface || binding.fact_id,
          { ...bindingProperties, ...priorFact.properties },
          [priorFact.search_text, binding.surface, binding.file, binding.fact_kind]));
      } else {
        addNode(graphRecord('CodeFact', binding.fact_id, binding.surface || binding.fact_id,
          bindingProperties, [binding.surface, binding.file, binding.fact_kind]));
      }
      addEdge(graphEdge('identifies', binding.fact_id, binding.referent_id, {
        mention_id: binding.mention_id || null,
        resolution_receipt_id: binding.resolution_receipt_id || null,
      }));
    }
    const assertionsByFact = new Map();
    for (const assertion of documentedAssertions(codeGraph.extracted_facts || []).assertions) {
      const key = `${assertion.source.document}\u0000${assertion.source.line}\u0000${assertion.nature.producer}\u0000${assertion.subject.kind}`;
      if (!assertionsByFact.has(key)) assertionsByFact.set(key, []);
      assertionsByFact.get(key).push(assertion);
    }
    // Where each fact's container is. Built over the whole stream for the same reason assertions
    // are: a section and the diagram inside it arrive as separate facts, and neither can find the
    // other one fact at a time.
    const multiRepository = Boolean(sourcePins(codeGraph.provenance)?.pins);
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    const documentFacts = (codeGraph.extracted_facts || []).filter(fact => fact?.kind === 'document');
    const addressForm = (() => {
      const byFile = documentFacts.filter(fact => nodes.has(`doc:${clean(fact.file)}`)).length;
      const byEstate = documentFacts.filter(fact => nodes.has(`doc:${documentPathOf(fact, { multi_repository: multiRepository })}`)).length;
      if (byFile === 0 && byEstate === 0) return 'estate';
      return byFile >= byEstate ? 'repository' : 'estate';
    })();
    const documentAddress = fact => (addressForm === 'repository'
      ? clean(fact.file) || null
      : documentPathOf(fact, { multi_repository: multiRepository }));
    let documentsFromStructure = 0;
    for (const fact of documentFacts) {
      const path = documentAddress(fact);
      if (!path) continue;
      const documentId = `doc:${path}`;
      if (nodes.has(documentId)) continue;
      addNode(graphRecord('Document', documentId, path, {
        path,
        // What the document is and what could refute it, carried even when nothing was extracted
        // from it -- which is exactly the case a reader needs told.
        document_mode: fact.document_mode ?? null,
        adjudication_frame: fact.adjudication_frame ?? null,
        archived: fact.document_archived ?? null,
        line_count: fact.line_count ?? null,
        heading_count: fact.heading_count ?? null,
        has_structure: fact.has_structure ?? null,
        claims_extracted: false,
      }, [path]));
      addEdge(graphEdge('contains', sourceId, documentId));
      documentsFromStructure += 1;
    }
    const containment = containmentIndex(codeGraph.extracted_facts || [],
      { multi_repository: multiRepository, address_form: addressForm });
    const containmentCounts = {};
    const unregisteredFactKinds = {};
    const containmentRefusals = {};
    // A fact whose kind has no EXTRACTED_FACT_KINDS entry is not automatically LOST: its raw
    // (repository, file, line, kind) may already be the witness an identity binding or a typed
    // dependency relation cites, and a `document` fact is represented structurally by the
    // Document loop above. Reconciling those routes here means the warning below distinguishes
    // "already reaches the graph some other way" from "no matched explicit route" instead of
    // reporting both as one undifferentiated number that a blanket exemption could then hide.
    // This is a bounded, source-derived finding, not proof that a `no_matched_explicit_route` row
    // has no indirect effect on the graph -- only that this reconciliation found none of the three
    // checked routes for it.
    const identityWitnessKeys = new Set((codeGraph.identity_bindings || [])
      .map(binding => canonical([binding.repository, binding.file, binding.line, binding.fact_kind])));
    const relationWitnessKeys = new Set();
    for (const relation of codeGraph.relations || []) {
      for (const witness of relation.witnesses || []) {
        relationWitnessKeys.add(canonical([witness.repo, witness.file, witness.line]));
      }
    }
    const unregisteredFactDispositions = {};
    const unregisteredContentSeen = new Map();
    containmentReport = { placed: containmentCounts, refused: containmentRefusals,
      // Extracted, carried the whole way here, and then not projected because no kind declared it.
      // Empty is the healthy state; a number here is work the extractors did that the graph threw
      // away, and it belongs in the receipt rather than in nobody's hands.
      unregistered_fact_kinds: unregisteredFactKinds,
      // Per-kind disposition of every unregistered row: how many are exact duplicates of a row
      // already counted, how many are witnessed by a CodeFact identity binding or a typed
      // dependency relation's cited site, how many are the structural-document route a `document`
      // fact takes, and how many matched none of those and remain a named, inspectable finding.
      unregistered_fact_dispositions: unregisteredFactDispositions,
      // Documents present because they were read rather than because they were claimed about.
      documents_from_structure: documentsFromStructure,
      // Which address space the projection resolved documents in, so a reader can tell.
      document_address_form: addressForm,
      document_address: multiRepository ? 'fact document_path (multi-repository estate)' : 'fact file (single-repository estate)' };
    for (const fact of codeGraph.extracted_facts || []) {
      if (!fact || typeof fact !== 'object') continue;
      if (!EXTRACTED_FACT_KINDS[fact.kind]) {
        unregisteredFactKinds[fact.kind] = (unregisteredFactKinds[fact.kind] || 0) + 1;
        const disposition = unregisteredFactDispositions[fact.kind]
          || (unregisteredFactDispositions[fact.kind] = { total: 0, duplicate_content_rows: 0,
            identity_or_relation_witness: 0, structural_document: 0, no_matched_explicit_route: 0 });
        disposition.total += 1;
        const contentDigest = sha256(canonical(fact));
        const seenForKind = unregisteredContentSeen.get(fact.kind) ?? new Set();
        unregisteredContentSeen.set(fact.kind, seenForKind);
        if (seenForKind.has(contentDigest)) {
          disposition.duplicate_content_rows += 1;
        } else {
          seenForKind.add(contentDigest);
          if (fact.kind === 'document') {
            disposition.structural_document += 1;
          } else if (identityWitnessKeys.has(canonical([fact.repo, fact.file, fact.line, fact.kind]))
            || relationWitnessKeys.has(canonical([fact.repo, fact.file, fact.line]))) {
            disposition.identity_or_relation_witness += 1;
          } else {
            disposition.no_matched_explicit_route += 1;
          }
        }
        continue;
      }
      const factId = `extracted-fact:${sha256(canonical(fact))}`;
      const declaration = EXTRACTED_FACT_KINDS[fact.kind];
      const kind = declaration.node_kind;
      const label = clean(declaration.label(fact)) || fact.kind;
      addNode(graphRecord(kind, factId, label, {
        fact_kind: fact.kind, repository: fact.repo || null, file: fact.file || null,
        document_path: containment.documents.get(factId) ?? null,
        line: fact.line || null, exact_fact_json: safeJson(fact),
      }, [fact.kind, fact.repo, fact.file, fact.entry_key_path, fact.name, fact.declaration_key, fact.declaration]));

      for (const leaf of addressLiteralLeaves(fact)) {
        const leafId = literalLeafId(factId, leaf);
        const shown = leaf.value.length > 200 ? `${leaf.value.slice(0, 200)}…` : leaf.value;
        addNode(graphRecord('LiteralLeaf', leafId, `${leaf.key_path} = ${shown}`, {
          fact_kind: fact.kind, repository: fact.repo || null, file: fact.file || null,
          declaration: fact.name ?? null, key_path: leaf.key_path,
          key_path_occurrence: leaf.key_path_occurrence, key_path_multiplicity: leaf.key_path_multiplicity,
          value: leaf.value, value_kind: leaf.value_kind, line: leaf.line ?? fact.line ?? null,
        }, [leaf.key_path, leaf.value, fact.file, fact.repo]));
        addEdge(graphEdge('declares_value', factId, leafId, {
          key_path: leaf.key_path,
          key_path_occurrence: leaf.key_path_occurrence,
          key_path_multiplicity: leaf.key_path_multiplicity,
        }));
      }

      // Exactly one structural parent per fact: the thing that contains it when the kind declares
      // a container and that container is present, and otherwise the commit -- with the reason
      // recorded, never absorbed.
      const held = factContainer(fact, factId, containment, id => nodes.has(id));
      // Count where the fact ACTUALLY landed, not what its kind declared. Reporting the
      // declaration made every section read as ':section' even when it fell through to its
      // document -- the difference between a hierarchy two deep and one deep.
      const outcome = held.refusal ? `${fact.kind}:${held.refusal}` : `${fact.kind}:${held.via}`;
      containmentCounts[outcome] = (containmentCounts[outcome] || 0) + 1;
      if (held.refusal) {
        containmentRefusals[outcome] = (containmentRefusals[outcome] || 0) + 1;
        addEdge(graphEdge(EXTRACTED_FACT_RELATION, factId, sourceId, { fact_kind: fact.kind,
          containment_refusal: held.refusal }));
      } else if (held.parent === 'commit') {
        addEdge(graphEdge(EXTRACTED_FACT_RELATION, factId, sourceId, { fact_kind: fact.kind }));
      } else {
        addEdge(graphEdge(held.relation, held.parent, factId, { fact_kind: fact.kind }));
      }

      // A documentary fact is also an ASSERTION: something a document claims, whose subject may
      // be a relation between endpoints that ground to nothing yet. Projecting the assertion as
      // its own node is what makes the claim traversable — a reader can reach what a document
      // says about a relationship without that relationship having to exist in the code plane.
      // The reified form is also what lets a later claim take THIS assertion as its subject.
      const subjectKind = fact.kind === 'diagram_relation' ? 'relation' : 'unresolved';
      const assertions = assertionsByFact.get(
        `${fact.file}\u0000${fact.line}\u0000diagrams\u0000${subjectKind}`) ?? [];
      for (const assertion of assertions) {
        addNode(graphRecord('Assertion', assertion.assertion_id,
          assertion.subject.kind === 'relation'
            ? `${assertion.subject.from.text ?? assertion.subject.from.id} ${assertion.subject.predicate} ${assertion.subject.to.text ?? assertion.subject.to.id}`
            : (assertion.subject.text ?? assertion.subject.id),
          {
            subject_kind: assertion.subject.kind,
            predicate: assertion.subject.predicate ?? null,
            // The verbatim endpoints as the document wrote them; grounding never rewrites these.
            from_text: assertion.subject.from?.text ?? null,
            to_text: assertion.subject.to?.text ?? null,
            document: assertion.source.document,
            source_line: assertion.source.line,
            section_path: assertion.source.section_path,
            producer: assertion.nature.producer,
            modality: assertion.nature.modality,
            document_mode: assertion.nature.document_mode,
            adjudication_frame: assertion.nature.adjudication_frame,
            archived: assertion.nature.archived,
            evidence_json: safeJson(assertion.evidence),
          },
          [assertion.subject.predicate, assertion.subject.from?.text, assertion.subject.to?.text,
            assertion.source.section_path]));
        // Preserve source witnesses; do not infer authority from naming conventions alone.
        const documentId = `doc:${containment.documents.get(factId) ?? assertion.source.document}`;
        if (nodes.has(documentId)) addEdge(graphEdge('asserted_in', assertion.assertion_id, documentId));
        else containmentRefusals['assertion:document_absent'] = (containmentRefusals['assertion:document_absent'] || 0) + 1;
        addEdge(graphEdge('read_from', assertion.assertion_id, factId, { producer: assertion.nature.producer }));
      }
    }

    // What the corpus says about its own claims. A relation between two assertions is itself an
    // assertion, so it projects as an Assertion node whose endpoints are the claims it relates —
    // which is what makes a superseded design reachable by traversal rather than by reading every
    // revision. The edge carries the rule that produced it so a reader can disagree with a stated
    // rule rather than an opaque judgement.
    const projected = new Set([...nodes.values()]
      .filter(node => node.kind === 'Assertion').map(node => node.node_id));
    const documentary = [...assertionsByFact.values()].flat();
    for (const relation of assertionRelations(documentary).relations) {
      const left = relation.subject.from.id; const right = relation.subject.to.id;
      // Only relate claims the projection actually holds; a relation to an absent node would be
      // a dangling edge, which the projection refuses outright.
      if (!projected.has(left) || !projected.has(right)) continue;
      addNode(graphRecord('Assertion', relation.assertion_id,
        `${relation.evidence.left.predicate} ${relation.subject.predicate} ${relation.evidence.right.predicate}`, {
          subject_kind: 'relation',
          predicate: relation.subject.predicate,
          producer: relation.nature.producer,
          adjudication_frame: relation.nature.adjudication_frame,
          document: relation.source.document,
          source_line: relation.source.line,
          section_path: relation.source.section_path,
          cross_document: relation.evidence.cross_document,
          rule: relation.evidence.rule,
          evidence_json: safeJson(relation.evidence),
        }, [relation.subject.predicate, relation.evidence.left.predicate, relation.evidence.right.predicate]));
      addEdge(graphEdge('relates_assertion', relation.assertion_id, left, { role: 'left', predicate: relation.subject.predicate }));
      addEdge(graphEdge('relates_assertion', relation.assertion_id, right, { role: 'right', predicate: relation.subject.predicate }));
    }
    if (Array.isArray(codeGraph.relations)) {
      for (const relation of codeGraph.relations) addEdge(graphEdge(
        relation.edge_kind || relation.relation || 'related_to',
        relation.from_referent_id || relation.from,
        relation.to_referent_id || relation.to,
        { source: 'code-dependency-relations', relation_id: relation.relation_id || null,
          from_fact_id: relation.from_fact_id ?? null, to_fact_id: relation.to_fact_id ?? null,
          ...(relation.resolution_kind ? { resolution_kind: relation.resolution_kind, match_pattern: relation.match_pattern ?? null } : {}),
          ...(relation.match_basis ? { match_basis: relation.match_basis } : {}),
          ...(relation.surface !== undefined ? { surface: relation.surface, occurrence_count: relation.occurrence_count ?? null } : {}),
          witnesses: Array.isArray(relation.witnesses) ? relation.witnesses.map(witness => ({
            repo: witness.repo ?? null, file: witness.file ?? null, line: witness.line ?? null })) : [] },
        relation.relation_id || null,
      ));
    } else {
      const seen = new Set();
      for (const [from, rows] of Object.entries(codeGraph.adj || {})) for (const [relation, to] of rows) {
        const key = canonical([relation, ...[from, to].sort(compare)]);
        if (seen.has(key)) continue;
        seen.add(key);
        addEdge(graphEdge(relation, from, to, { source: 'legacy-undirected-adjacency' }));
      }
    }
  }

  for (const edge of edges.values()) if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
    stateError('UNIFIED_PROJECTION_DANGLING_EDGE', `edge ${edge.edge_id} has an absent endpoint`, {
      from: edge.from, to: edge.to, relation: edge.relation,
    });
  }
  // Total degree is dominated by documentary occurrence: a symbol whose surface is a common word
  // ('all', 'path', 'one') collects thousands of ambient mention edges and outranks the components
  // the estate is actually built from. Structural degree counts only structural and flow edges so
  // ranking reflects composition and assertion rather than vocabulary collision.
  const degreeByNode = new Map();
  const structuralByNode = new Map();
  const childrenByParent = new Map();
  const roleCounts = new Map();
  const unclassifiedRelations = new Set();
  const edgeRows = [...edges.values()].map(edge => {
    const role = relationRole(edge.relation);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    if (role === UNCLASSIFIED) unclassifiedRelations.add(edge.relation);
    for (const endpoint of [edge.from, edge.to]) {
      degreeByNode.set(endpoint, (degreeByNode.get(endpoint) || 0) + 1);
      if (role === 'structural' || role === 'flow') {
        structuralByNode.set(endpoint, (structuralByNode.get(endpoint) || 0) + 1);
      }
    }
    const endpoints = structuralEndpoints(edge);
    if (endpoints) {
      const [parent, child] = endpoints;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, new Set());
      childrenByParent.get(parent).add(child);
    }
    const { record_digest: _priorDigest, edge_id, ...priorBody } = edge;
    const body = { ...priorBody, role, parent_end: endpoints ? (endpoints[0] === edge.from ? 'from' : 'to') : null };
    return Object.freeze({ ...body, edge_id, record_digest: sha256(canonical(body)) });
  }).sort((left, right) => compare(left.edge_id, right.edge_id));
  // Structural descendants are distinct: a route reached through both its plugin and its module
  // counts once. Sets are memoized per container; a structural cycle would be a producer defect,
  // so a node already on the walk contributes nothing rather than recursing forever.
  const descendantsByNode = new Map();
  const walking = new Set();
  const descendants = nodeId => {
    if (descendantsByNode.has(nodeId)) return descendantsByNode.get(nodeId);
    if (walking.has(nodeId)) return new Set();
    walking.add(nodeId);
    const reached = new Set();
    for (const child of childrenByParent.get(nodeId) || []) {
      reached.add(child);
      for (const grandchild of descendants(child)) reached.add(grandchild);
    }
    walking.delete(nodeId);
    reached.delete(nodeId);
    descendantsByNode.set(nodeId, reached);
    return reached;
  };
  const unclassifiedKinds = new Set();
  const nodeRows = [...nodes.values()].map(row => {
    const plane = nodePlane(row.kind);
    if (plane === UNCLASSIFIED) unclassifiedKinds.add(row.kind);
    const { record_digest: _priorDigest, ...priorBody } = row;
    const body = { ...priorBody, plane, degree: degreeByNode.get(row.node_id) || 0,
      structural_degree: structuralByNode.get(row.node_id) || 0,
      structural_children: childrenByParent.get(row.node_id)?.size || 0,
      structural_descendants: descendants(row.node_id).size };
    return Object.freeze({ ...body, record_digest: sha256(canonical(body)) });
  }).sort((left, right) => compare(left.node_id, right.node_id));
  const relationRegistry = {
    roles_by_relation: Object.fromEntries([...new Set(edgeRows.map(row => row.relation))].sort(compare)
      .map(relation => [relation, relationRole(relation)])),
    edges_by_role: Object.fromEntries([...roleCounts].sort(([left], [right]) => compare(left, right))),
    unclassified_relations: [...unclassifiedRelations].sort(compare),
    planes_by_kind: Object.fromEntries([...new Set(nodeRows.map(row => row.kind))].sort(compare)
      .map(kind => [kind, nodePlane(kind)])),
    unclassified_kinds: [...unclassifiedKinds].sort(compare),
  };
  const nodeKinds = Object.fromEntries(Object.entries(Object.groupBy(nodeRows, row => row.kind))
    .map(([kind, rows]) => [kind, rows.length]).sort(([left], [right]) => compare(left, right)));
  const edgeRelations = Object.fromEntries(Object.entries(Object.groupBy(edgeRows, row => row.relation))
    .map(([relation, rows]) => [relation, rows.length]).sort(([left], [right]) => compare(left, right)));
  const databaseManifest = {
    nodes: nodeRows.map(row => [row.node_id, row.record_digest]),
    edges: edgeRows.map(row => [row.edge_id, row.record_digest]),
  };
  const pins = codeGraph ? sourcePins(codeGraph.provenance) : null;
  const body = {
    schema: ESTATE_GRAPH_PROJECTION_SCHEMA,
    projection_version: ESTATE_GRAPH_PROJECTION_VERSION,
    project: claimMap.project,
    source_pins: pins?.pins ?? null,
    source_artifacts: {
      claim_map_digest: claimMap.digest,
      code_graph_digest: codeGraphIdentityDigest(codeGraph),
    },
    counts: {
      nodes: nodeRows.length, edges: edgeRows.length,
      nodes_by_kind: nodeKinds, edges_by_relation: edgeRelations,
      // What contained what, and what could not be placed. Reported rather than inferred from the
      // edge counts, so a hierarchy that failed to form is a number someone can read.
      containment: containmentReport,
    },
    database_manifest_digest: stableCanonicalSha256(databaseManifest),
    projection_additions: EXTRACTED_FACT_PROJECTION_ADDITIONS,
    relation_registry: relationRegistry,
    nodes: nodeRows,
    edges: edgeRows,
  };
  const contentDigest = stableCanonicalSha256(body);
  return immutable({ ...body, content_digest: contentDigest,
    projection_id: `estate-projection:${sha256(canonical({
      version: ESTATE_GRAPH_PROJECTION_VERSION,
      source_commit: claimMap.project.sha,
      content_digest: contentDigest,
    }))}` });
}

const SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ name: 'estate_projection_id_unique',
    statement: 'CREATE CONSTRAINT estate_projection_id_unique IF NOT EXISTS FOR (p:EstateProjection) REQUIRE p.projection_id IS UNIQUE' }),
  Object.freeze({ name: 'estate_projection_head_slot_unique',
    statement: 'CREATE CONSTRAINT estate_projection_head_slot_unique IF NOT EXISTS FOR (h:EstateProjectionHead) REQUIRE h.slot IS UNIQUE' }),
  Object.freeze({ name: 'estate_node_identity_unique',
    statement: 'CREATE CONSTRAINT estate_node_identity_unique IF NOT EXISTS FOR (n:EstateNode) REQUIRE (n.projection_id, n.node_id) IS UNIQUE' }),
  Object.freeze({ name: 'estate_node_kind',
    statement: 'CREATE INDEX estate_node_kind IF NOT EXISTS FOR (n:EstateNode) ON (n.projection_id, n.kind)' }),
  Object.freeze({ name: 'estate_node_structure',
    statement: 'CREATE INDEX estate_node_structure IF NOT EXISTS FOR (n:EstateNode) ON (n.projection_id, n.structural_degree)' }),
  Object.freeze({ name: 'estate_node_search',
    statement: 'CREATE INDEX estate_node_search IF NOT EXISTS FOR (n:EstateNode) ON (n.projection_id, n.search_text)' }),
  // Verification pages edges by identity. Without a relationship index every page scans the whole
  // relationship store, so the cost grows with retained history rather than with the generation
  // being verified.
  Object.freeze({ name: 'estate_edge_identity',
    statement: 'CREATE INDEX estate_edge_identity IF NOT EXISTS FOR ()-[r:ESTATE_EDGE]-() ON (r.projection_id, r.edge_id)' }),
]);
export const ESTATE_SCHEMA_NAMES = Object.freeze(SCHEMA_OBJECTS.map(row => row.name));

export const WRITE_ESTATE_NODES_STATEMENT = `
  UNWIND $rows AS row
  MERGE (n:EstateNode {projection_id: $projection_id, node_id: row.node_id})
  SET n.kind = row.kind, n.label = row.label, n.search_text = row.search_text,
      n.plane = row.plane, n.degree = row.degree, n.structural_degree = row.structural_degree,
      n.structural_children = row.structural_children,
      n.structural_descendants = row.structural_descendants,
      n.properties_json = row.properties_json, n.record_digest = row.record_digest
  RETURN count(n) AS written
`;

export const WRITE_ESTATE_EDGES_STATEMENT = `
  UNWIND $rows AS row
  MATCH (a:EstateNode {projection_id: $projection_id, node_id: row.from})
  MATCH (b:EstateNode {projection_id: $projection_id, node_id: row.to})
  MERGE (a)-[r:ESTATE_EDGE {projection_id: $projection_id, edge_id: row.edge_id}]->(b)
  SET r.relation = row.relation, r.role = row.role, r.parent_end = row.parent_end,
      r.properties_json = row.properties_json,
      r.record_digest = row.record_digest
  RETURN count(r) AS written
`;

function requireClient(client) {
  if (!(client instanceof Neo4jHttpClient)) fail('ESTATE_PROJECTION_CLIENT_REQUIRED', 'an explicit Neo4j HTTP client is required');
}

function batches(rows, size) {
  const output = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

export async function ensureEstateProjectionSchema(client, {
  attempts = 90, waitMs = 2_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  requireClient(client);
  // Creating an index over an existing estate-scale projection can outlast a single HTTP request.
  // A timed-out creation is not proof of failure and a returned response is not proof of
  // readiness, so creation is idempotent and completion is established from database state.
  const creationErrors = [];
  for (const object of SCHEMA_OBJECTS) {
    try { await client.query(object.statement); }
    catch (error) { creationErrors.push({ name: object.name, code: error.code || error.name }); }
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await client.query('SHOW INDEXES YIELD name, state RETURN name, state');
    const state = new Map(rows.map(row => [row[0], row[1]]));
    const pending = ESTATE_SCHEMA_NAMES.filter(name => state.get(name) !== 'ONLINE');
    if (!pending.length) {
      return Object.freeze({ names: ESTATE_SCHEMA_NAMES.slice(), polls: attempt + 1,
        creation_errors: creationErrors });
    }
    if (attempt === attempts - 1) {
      fail('ESTATE_PROJECTION_INDEX_NOT_ONLINE', 'projection indexes did not come online', {
        pending: pending.map(name => ({ name, state: state.get(name) || 'absent' })),
        creation_errors: creationErrors,
        waited_ms: attempts * waitMs,
      });
    }
    await sleep(waitMs);
  }
  return Object.freeze({ names: ESTATE_SCHEMA_NAMES.slice(), polls: attempts,
    creation_errors: creationErrors });
}

async function startWorkingProjection(client, state, expectedWorkingProjectionId, estate = null) {
  const rows = await client.query(`
    MERGE (h:EstateProjectionHead {slot: $working_slot})
    ON CREATE SET h.projection_id = null
    WITH h WHERE coalesce(h.projection_id, '') = coalesce($expected_projection_id, '')
    MERGE (p:EstateProjection {projection_id: $projection_id})
    ON CREATE SET p.created_at = datetime()
    SET p.status = 'working', p.source_commit = $source_commit, p.projection_version = $projection_version,
        p.estate = $estate, p.source_pins_json = $source_pins_json,
        p.content_digest = $content_digest, p.database_manifest_digest = $database_manifest_digest,
        p.claim_map_digest = $claim_map_digest, p.code_graph_digest = $code_graph_digest,
        p.total_nodes = $total_nodes, p.total_edges = $total_edges,
        p.processed_nodes = 0, p.processed_edges = 0, p.error = null,
        h.projection_id = $projection_id, h.updated_at = datetime()
    RETURN count(h), p.projection_id
  `, {
    working_slot: estateSlot('working', estate),
    estate: clean(estate) || null,
    expected_projection_id: expectedWorkingProjectionId,
    projection_id: state.projection_id,
    source_commit: state.project.sha,
    projection_version: state.projection_version,
    source_pins_json: state.source_pins ? canonical(state.source_pins) : null,
    content_digest: state.content_digest,
    database_manifest_digest: state.database_manifest_digest,
    claim_map_digest: state.source_artifacts.claim_map_digest,
    code_graph_digest: state.source_artifacts.code_graph_digest,
    total_nodes: state.counts.nodes,
    total_edges: state.counts.edges,
  });
  if (rows[0]?.[0] !== 1 || rows[0]?.[1] !== state.projection_id) {
    fail('ESTATE_WORKING_HEAD_COMPARE_AND_SWAP_FAILED', 'working projection changed before staging');
  }
}

async function markProjectionFailed(client, projectionId, error) {
  try {
    await client.query(`
      MATCH (p:EstateProjection {projection_id: $projection_id})
      SET p.status = 'failed', p.error = $error, p.failed_at = datetime()
      RETURN p.projection_id
    `, { projection_id: projectionId, error: String(error?.message || error).slice(0, 2_048) });
  } catch { /* Preserve the original projection failure. */ }
}

async function verifyProjectionRows(client, state, pageSize = 5_000) {
  const verify = async ({ rows, kind, statement }) => {
    let after = '';
    let index = 0;
    while (index < rows.length) {
      const page = await client.query(statement, {
        projection_id: state.projection_id, after, limit: pageSize,
      });
      if (!page.length) fail('ESTATE_PROJECTION_CONTENT_MISMATCH', `${kind} verification ended early`, { index });
      for (const row of page) {
        const expected = rows[index];
        if (!expected || row[0] !== expected[0] || row[1] !== expected[1]) {
          fail('ESTATE_PROJECTION_CONTENT_MISMATCH', `${kind} differs from its exact manifest`, {
            index, expected: expected || null, actual: row,
          });
        }
        after = row[0];
        index += 1;
      }
    }
    const extra = await client.query(statement, {
      projection_id: state.projection_id, after, limit: 1,
    });
    if (extra.length) fail('ESTATE_PROJECTION_CONTENT_MISMATCH', `${kind} verification found extra rows`);
  };
  await verify({
    kind: 'node', rows: state.nodes.map(row => [row.node_id, row.record_digest]),
    statement: `
      MATCH (n:EstateNode {projection_id: $projection_id})
      WHERE n.node_id > $after
      RETURN n.node_id, n.record_digest ORDER BY n.node_id LIMIT $limit
    `,
  });
  await verify({
    kind: 'edge', rows: state.edges.map(row => [row.edge_id, row.record_digest]),
    statement: `
      MATCH ()-[r:ESTATE_EDGE {projection_id: $projection_id}]->()
      WHERE r.edge_id > $after
      RETURN r.edge_id, r.record_digest ORDER BY r.edge_id LIMIT $limit
    `,
  });
}

/** Stage a queryable working generation in bounded commits, then verify it without changing selected. */
export async function stageEstateProjection({
  client, state, batch_size: batchSize = 500, expected_working_projection_id: expectedWorking = null,
  estate = null,
}) {
  requireClient(client);
  if (state?.schema !== ESTATE_GRAPH_PROJECTION_SCHEMA) {
    fail('ESTATE_PROJECTION_STATE_INVALID', 'stage requires a unified serving projection state');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    fail('ESTATE_PROJECTION_BATCH_INVALID', 'batch size must be from 1 through 10000');
  }
  await ensureEstateProjectionSchema(client);
  // Projection identity is content-derived, so re-staging an already-selected generation would
  // rewrite proven rows and briefly relabel the selected view as working. Identical content is
  // recognized instead of rebuilt.
  const heads = await readEstateProjectionHeads(client, { estate });
  const selected = heads.selected;
  if (selected?.projection_id === state.projection_id && selected.status === 'selected'
    && selected.content_digest === state.content_digest
    && selected.processed_nodes === state.counts.nodes
    && selected.processed_edges === state.counts.edges) {
    return Object.freeze({ projection_id: state.projection_id, status: 'already_selected',
      processed_nodes: selected.processed_nodes, processed_edges: selected.processed_edges,
      content_digest: selected.content_digest });
  }
  await startWorkingProjection(client, state, expectedWorking, estate);
  let processedNodes = 0;
  let processedEdges = 0;
  try {
    for (const batch of batches(state.nodes, batchSize)) {
      await client.query(WRITE_ESTATE_NODES_STATEMENT, {
        projection_id: state.projection_id,
        rows: batch.map(row => ({
          node_id: row.node_id, kind: row.kind, label: row.label, search_text: row.search_text,
          plane: row.plane, degree: row.degree, structural_degree: row.structural_degree,
          structural_children: row.structural_children, structural_descendants: row.structural_descendants,
          properties_json: canonical(row.properties), record_digest: row.record_digest,
        })),
      });
      processedNodes += batch.length;
      await client.query(`
        MATCH (p:EstateProjection {projection_id: $projection_id})
        SET p.processed_nodes = $processed_nodes, p.updated_at = datetime()
        RETURN p.processed_nodes
      `, { projection_id: state.projection_id, processed_nodes: processedNodes });
    }
    for (const batch of batches(state.edges, batchSize)) {
      await client.query(WRITE_ESTATE_EDGES_STATEMENT, {
        projection_id: state.projection_id,
        rows: batch.map(row => ({
          edge_id: row.edge_id, from: row.from, to: row.to, relation: row.relation, role: row.role,
          parent_end: row.parent_end, properties_json: canonical(row.properties), record_digest: row.record_digest,
        })),
      });
      processedEdges += batch.length;
      await client.query(`
        MATCH (p:EstateProjection {projection_id: $projection_id})
        SET p.processed_edges = $processed_edges, p.updated_at = datetime()
        RETURN p.processed_edges
      `, { projection_id: state.projection_id, processed_edges: processedEdges });
    }
    await verifyProjectionRows(client, state);
    const ready = await client.query(`
      MATCH (p:EstateProjection {projection_id: $projection_id})
      WHERE p.processed_nodes = p.total_nodes AND p.processed_edges = p.total_edges
      SET p.status = 'ready', p.verified_at = datetime()
      RETURN p.projection_id, p.content_digest
    `, { projection_id: state.projection_id });
    if (ready[0]?.[0] !== state.projection_id || ready[0]?.[1] !== state.content_digest) {
      fail('ESTATE_PROJECTION_READY_FAILED', 'working projection could not be marked ready');
    }
    return Object.freeze({ projection_id: state.projection_id, status: 'ready',
      processed_nodes: processedNodes, processed_edges: processedEdges,
      content_digest: state.content_digest });
  } catch (error) {
    await markProjectionFailed(client, state.projection_id, error);
    throw error;
  }
}

/**
 * Delete generations the query surface can no longer select. Retention keeps the selected
 * generation and a bounded number of superseded ancestors so a projection can be rolled back;
 * everything older is removed in bounded batches, because an unpruned store makes every scan pay
 * for history that nothing can read.
 */
export async function pruneEstateProjections({ client, retain_superseded: retain = 1,
  batch_size: batchSize = 20_000, estate = null }) {
  requireClient(client);
  if (!Number.isInteger(retain) || retain < 0) {
    fail('ESTATE_PROJECTION_RETENTION_INVALID', 'retention must be a non-negative integer');
  }
  const heads = await readEstateProjectionHeads(client, { estate });
  const ownIds = [heads.selected?.projection_id, heads.working?.projection_id].filter(clean);
  if (!ownIds.length) {
    fail('ESTATE_PROJECTION_RETENTION_UNSAFE', 'refusing to prune without a selected or working head');
  }
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const headRows = await client.query(`
    MATCH (h:EstateProjectionHead) WHERE h.projection_id IS NOT NULL RETURN h.projection_id
  `);
  const protectedIds = [...new Set([...ownIds, ...headRows.map(row => row[0]).filter(clean)])];
  const rows = await client.query(`
    MATCH (p:EstateProjection)
    WHERE NOT p.projection_id IN $protected
      AND (($estate IS NULL AND p.estate IS NULL) OR p.estate = $estate)
    RETURN p.projection_id, p.status, coalesce(p.selected_at, p.verified_at, p.created_at) AS marked
    ORDER BY marked DESC, p.projection_id
  `, { protected: protectedIds, estate: clean(estate) || null });
  const candidates = rows.map(row => row[0]);
  const prunable = candidates.slice(retain);
  let removedNodes = 0;
  let removedProjections = 0;
  for (const projectionId of prunable) {
    for (;;) {
      const deleted = await client.query(`
        MATCH (n:EstateNode {projection_id: $projection_id})
        WITH n LIMIT $batch
        DETACH DELETE n
        RETURN count(n)
      `, { projection_id: projectionId, batch: batchSize });
      const count = deleted[0]?.[0] || 0;
      removedNodes += count;
      if (!count) break;
    }
    await client.query(`
      MATCH (p:EstateProjection {projection_id: $projection_id})
      DELETE p
      RETURN count(p)
    `, { projection_id: projectionId });
    removedProjections += 1;
  }
  return Object.freeze({ retained: [...ownIds, ...candidates.slice(0, retain)],
    protected_projection_ids: protectedIds, estate: clean(estate) || null,
    pruned_projection_ids: prunable, removed_nodes: removedNodes,
    removed_projections: removedProjections });
}

/** Atomically advance selected only after a complete working projection is ready. */
export async function promoteEstateProjection({ client, projection_id: projectionId,
  expected_selected_projection_id: expectedSelected = null, estate = null }) {
  requireClient(client);
  const transaction = await client.begin();
  try {
    const result = await client.commit(transaction, [{
      statement: `
        MATCH (p:EstateProjection {projection_id: $projection_id, status: 'ready'})
        MERGE (h:EstateProjectionHead {slot: $selected_slot})
        ON CREATE SET h.projection_id = null
        WITH p, h WHERE coalesce(h.projection_id, '') = coalesce($expected_projection_id, '')
        OPTIONAL MATCH (prior:EstateProjection {projection_id: h.projection_id})
        FOREACH (_ IN CASE WHEN prior IS NULL THEN [] ELSE [1] END | SET prior.status = 'superseded')
        SET h.projection_id = p.projection_id, h.updated_at = datetime(),
            p.status = 'selected', p.selected_at = datetime()
        WITH p, h
        OPTIONAL MATCH (working:EstateProjectionHead {slot: $working_slot})
        FOREACH (_ IN CASE WHEN working.projection_id = p.projection_id THEN [1] ELSE [] END |
          SET working.projection_id = null, working.updated_at = datetime())
        RETURN h.projection_id, p.content_digest
      `,
      parameters: { projection_id: projectionId, expected_projection_id: expectedSelected,
        selected_slot: estateSlot('selected', estate), working_slot: estateSlot('working', estate) },
      resultDataContents: ['row'],
    }]);
    const row = result[0]?.data?.[0]?.row || [];
    if (row[0] !== projectionId || !clean(row[1])) {
      fail('ESTATE_SELECTED_HEAD_COMPARE_AND_SWAP_FAILED', 'selected projection changed or candidate is not ready');
    }
    return Object.freeze({ projection_id: projectionId, status: 'selected', content_digest: row[1] });
  } catch (error) {
    await client.rollback(transaction);
    throw error;
  }
}
