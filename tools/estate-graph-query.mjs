#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient } from './c3-serving-projection.mjs';
import {
  loadEstateMapRuntimeConfig, neo4jConnectionFromConfig,
} from './ascrybe-config.mjs';
import { estateSlot, readEstateProjectionHeads } from './estate-projection-heads.mjs';
import { NODE_PLANE_REGISTRY, NODE_PLANES, RELATION_REGISTRY, RELATION_ROLES,
  relationRole as relationRoleOf } from './estate-graph-roles.mjs';

const NODE_PLANES_BY_KIND = Object.keys(NODE_PLANE_REGISTRY);
const RELATION_ROLE_NAMES = Object.keys(RELATION_REGISTRY);

export const ESTATE_GRAPH_QUERY_RESULT_SCHEMA = 'estate-map/query-result/v1';

// A skill is a copy of instructions about this surface, and a copy drifts. Version numbers alone
// do not catch drift — the retired predecessor skill carried one and still documented a pipeline
// that no longer existed. What makes a pin enforceable is the surface stating what it implements,
// so a caller can compare rather than assume. The contract names the command set, the arguments
// each command accepts, and a digest over both: a command added, removed, or given a new argument
// changes the digest, and any skill or plugin declaring the old one is detectably stale.
export const ESTATE_QUERY_CONTRACT_VERSION = 'ascrybe/query-surface/v4';
export const ESTATE_QUERY_CONTRACT = Object.freeze({
  'projection-status': [],
  stats: ['view'],
  concepts: ['limit', 'view'],
  overview: ['limit', 'view'],
  search: ['term', 'kinds', 'limit', 'kind-quota', 'view'],
  node: ['id', 'limit', 'expand', 'kind-quota', 'view'],
  neighbors: ['id', 'relation', 'direction', 'limit', 'view'],
  consumers: ['id', 'limit', 'view'],
  path: ['from', 'to', 'depth', 'view'],
  provenance: ['id', 'depth', 'limit', 'view'],
  'read-span': ['id', 'before', 'after', 'view'],
});

/** What this build implements, for a caller holding a declared expectation to compare against. */
export function querySurfaceContract({ estate = null, cypher = true } = {}) {
  const commands = Object.fromEntries(Object.entries(ESTATE_QUERY_CONTRACT)
    .map(([command, args]) => [command, [...args].sort()])
    .sort(([left], [right]) => codePointOrder(left, right)));
  // The commands are only half of what a skill documents; the other half is what the graph
  // CONTAINS. Adding Assertion nodes and relates_assertion edges changed nothing about the
  // command set, so a digest over commands alone reported a matching contract while the skill
  // described a data model that no longer existed. Node kinds and relation roles belong in the
  // digest for the same reason the arguments do.
  const data_model = { node_kinds: [...NODE_PLANES_BY_KIND].sort(codePointOrder),
    relation_roles: Object.fromEntries([...RELATION_ROLE_NAMES].sort(codePointOrder)
      .map(relation => [relation, relationRoleOf(relation)])) };
  const body = { contract: ESTATE_QUERY_CONTRACT_VERSION, commands, cypher_surface: cypher, data_model };
  return Object.freeze({ schema: 'estate-map/query-contract/v1', ...body, estate,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
}
const clean = value => String(value ?? '').trim();
const READ_SPAN_DEFAULT_BEFORE = 20;
const READ_SPAN_DEFAULT_AFTER = 40;
const READ_SPAN_MAX_LINES = 400;
const READ_SPAN_MAX_BYTES = 64 * 1024;
// Documents rank ahead of what is written inside them. A document's label IS its path, so a
// reader searching a path is naming the document; the claims that merely mention it are the
// answer to a different question. The documentary kinds were absent from this table entirely,
// which put all 140,458 of them behind every code kind, and the 111,499 claims then filled any
// limit before a Document could appear -- searching a document's own path returned forty claims
// and not the document.
const SEARCH_KIND_PRECEDENCE = Object.freeze([
  'Document', 'DocumentSection', 'Diagram',
  'CodeFact', 'Symbol', 'Module', 'Route', 'Table',
  'Assertion', 'Claim', 'Evidence', 'AdjudicationReceipt', 'ObligationResult',
]);
const SEARCH_KIND_RANK = `CASE n.kind ${SEARCH_KIND_PRECEDENCE
  .map((kind, index) => `WHEN '${kind}' THEN ${index}`)
  .join(' ')} ELSE ${SEARCH_KIND_PRECEDENCE.length} END`;

// Provenance answers "what justifies this?", so it walks justification edges only. Structural
// containment and documentary occurrence are deliberately excluded: they are ambient, enormous
// (one commit contains every claim; common surfaces occur in hundreds of documents), and would
// turn a bounded justification walk into a whole-graph scan. The exclusion is disclosed on every
// provenance result rather than hidden in the traversal.
export const PROVENANCE_RELATIONS = Object.freeze([
  'about', 'adjudicated_by', 'contradicted_by', 'depends_on', 'derived_from', 'evidenced_by',
  'has_obligation_result', 'identifies', 'justified_by', 'realized_by', 'refines',
  'superseded_by', 'supported_by', 'unresolved_against',
]);
export const PROVENANCE_TARGET_KINDS = Object.freeze([
  'AdjudicationReceipt', 'CodeFact', 'Document', 'Evidence', 'SourceCommit', 'SupersessionReceipt',
]);
const PROVENANCE_FRONTIER_LIMIT = 32;
const PROVENANCE_NEIGHBOR_LIMIT = 48;
const TRAVERSAL_DEFAULT_LIMIT = 40;
const TRAVERSAL_MAX_LIMIT = 200;
const CONSUMER_RELATIONS = Object.freeze(['consumes', 'subscribes_envelope']);
const PUBLISHER_RELATIONS = Object.freeze(['emits', 'publishes_envelope']);
const SAFE_RELATION = /^[a-z][a-z0-9_]*$/u;
const TRAVERSAL_DIRECTIONS = new Set(['in', 'out', 'both']);
// The entry view must be a topology, not a ranking. Selecting the globally highest-degree nodes
// returns hubs whose neighbors fall outside the cut, so the client receives unconnected points.
// Overview therefore expands outward from the project anchor and admits a node only through an
// edge to an already-selected node, with per-kind quotas so one populous kind cannot fill the view.
// The quota is applied per kind inside each parent's query, so a parent with thousands of children
// of one kind still offers its other kinds: a flat top-N fetch from the commit showed only the
// largest modules and never reached the plugins.
// Every view ranks by plane, then by structural descent, then by structural degree. Plane and the
// structural counts are projected from the relation registry, so the same ordering applies at the
// estate anchor and at any depth: entities before observations before prose before receipts, and
// within a plane the node that contains more of the estate first. Kind names never enter ranking.
const PLANE_RANK = column => `CASE ${column} ${NODE_PLANES.map((plane, index) => `WHEN '${plane}' THEN ${index}`).join(' ')} ELSE ${NODE_PLANES.length} END`;
const ROLE_RANK = column => `CASE ${column} ${RELATION_ROLES.map((role, index) => `WHEN '${role}' THEN ${index}`).join(' ')} ELSE ${RELATION_ROLES.length} END`;
const STRUCTURE_COLUMNS = alias => `${alias}.plane, ${alias}.structural_children, ${alias}.structural_descendants`;
const NODE_EXPANSIONS = Object.freeze(['structural', 'all']);
// Entities the estate declares, as projected node kinds. Concept ranking asks about these rather
// than about a single generic entity label, so a plugin and a local symbol are never pooled.
export const ENTITY_NODE_KINDS = Object.freeze([
  'Capability', 'DeclaredDocument', 'Envelope', 'Infrastructure', 'Module', 'Package',
  'Plugin', 'Referent', 'Repository', 'Route', 'SchemaRecord', 'Symbol', 'Table',
]);

export class EstateGraphQueryError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EstateGraphQueryError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new EstateGraphQueryError(code, message, detail);
}

function boundedInteger(value, label, fallback, maximum) {
  const held = value == null ? fallback : Number(value);
  if (!Number.isInteger(held) || held < 1 || held > maximum) {
    fail('ESTATE_QUERY_BOUND_INVALID', `${label} must be from 1 through ${maximum}`);
  }
  return held;
}

function graphNodeId(value, label = 'id') {
  if (typeof value !== 'string' || value.length === 0) fail('ESTATE_QUERY_NODE_ID_MISSING', `${label} requires id`);
  // Projection producers preserve source paths verbatim in Document IDs, including spaces,
  // percent signs, and non-ASCII text. IDs only ever reach Cypher as parameters, so restricting
  // their printable grammar would reject records the projection itself advertised. NUL is the
  // one value neither the producers nor the command boundary can safely represent.
  if (value.includes('\0')) fail('ESTATE_QUERY_NODE_ID_UNSAFE', `${label} id contains NUL`, { id: value });
  return value;
}

function codePointOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRelation(value) {
  if (value == null) return null;
  const held = clean(value);
  if (!SAFE_RELATION.test(held)) {
    fail('ESTATE_QUERY_RELATION_INVALID', 'relation must be one exact projected relation name', { relation: value });
  }
  return held;
}

function traversalDirection(value) {
  const held = value == null ? 'both' : clean(value);
  if (!TRAVERSAL_DIRECTIONS.has(held)) fail('ESTATE_QUERY_DIRECTION_INVALID', 'direction must be in, out, or both', { direction: value });
  return held;
}

function parseProperties(value) {
  if (!value) return {};
  try { return JSON.parse(value); }
  catch { return { projection_property_parse_error: true }; }
}

function nodeFromRow(row, offset = 0) {
  return {
    id: row[offset], kind: row[offset + 1], label: row[offset + 2],
    properties: parseProperties(row[offset + 3]),
  };
}

function structuredNode(row, offset = 0) {
  return { ...nodeFromRow(row, offset), plane: row[offset + 4] ?? null,
    structural_children: row[offset + 5] ?? null, structural_descendants: row[offset + 6] ?? null };
}

function nextQueryAffordances(node) {
  const next_queries = [{ command: 'neighbors', arguments: { id: node.id, direction: 'both' } }];
  if (node.kind === 'Envelope') next_queries.unshift({ command: 'consumers', arguments: { id: node.id } });
  // A CodeFact is directly resolvable by read-span. Other kinds may be resolvable through an
  // identifies edge, but exposing that as a guarantee would turn a refusal into a false promise.
  if (node.kind === 'CodeFact') next_queries.push({ command: 'read-span', arguments: { id: node.id } });
  return next_queries;
}

function afford(node) {
  return { ...node, next_queries: nextQueryAffordances(node) };
}

function projectionSummary(row) {
  return {
    projection_id: row[0], status: row[1], source_commit: row[2],
    content_digest: row[3], claim_map_digest: row[4], code_graph_digest: row[5],
    processed_nodes: row[6] || 0, total_nodes: row[7] || 0,
    processed_edges: row[8] || 0, total_edges: row[9] || 0,
    projection_version: row[10] ?? null,
    source_pins: row[11] ? JSON.parse(row[11]) : null,
  };
}

function spanBound(value, label, fallback) {
  const bound = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(bound) || bound < 0) {
    fail('ESTATE_QUERY_BOUND_INVALID', `${label} must be a non-negative integer`);
  }
  return bound;
}

function safeSourcePath(value) {
  const path = clean(value);
  const normalized = posix.normalize(path);
  if (!path || path.includes('\0') || path.includes('\\') || posix.isAbsolute(path)
    || normalized !== path || path === '..' || path.startsWith('../')) {
    fail('ESTATE_QUERY_SOURCE_PATH_INVALID', 'CodeFact file is not a safe Git tree path', { file: value });
  }
  return path;
}

function gitRead(repository, args) {
  try {
    return execFileSync('git', ['-C', repository, ...args], { maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    fail('ESTATE_QUERY_GIT_READ_FAILED', `git ${args.join(' ')} failed`, {
      repository, stderr: error.stderr?.toString().trim() || error.message,
    });
  }
}

function committedBlob({ repository, sourceCommit, file }) {
  const requestedCommit = clean(sourceCommit);
  if (!/^[0-9a-f]{40}$/u.test(requestedCommit)) {
    fail('ESTATE_QUERY_SOURCE_COMMIT_INVALID', 'projection source_commit must be a full SHA-1 commit', { source_commit: sourceCommit });
  }
  const commit = gitRead(repository, ['rev-parse', `${requestedCommit}^{commit}`]).toString('utf8').trim();
  if (commit !== requestedCommit) {
    fail('ESTATE_QUERY_SOURCE_COMMIT_MISMATCH', 'projection source_commit resolved to a different commit', {
      source_commit: requestedCommit, resolved_commit: commit,
    });
  }
  const objectFormat = gitRead(repository, ['rev-parse', '--show-object-format']).toString('utf8').trim();
  if (objectFormat !== 'sha1') {
    fail('ESTATE_QUERY_GIT_OBJECT_FORMAT_UNSUPPORTED', 'read-span supports SHA-1 Git repositories only', { object_format: objectFormat });
  }
  const treeRecords = gitRead(repository, ['ls-tree', '-z', '-l', commit, '--', file])
    .toString('utf8').split('\0').filter(Boolean);
  if (!treeRecords.length) {
    fail('ESTATE_QUERY_SOURCE_PATH_MISSING', 'CodeFact file is absent at the projection source_commit', {
      file, source_commit: commit,
    });
  }
  if (treeRecords.length !== 1) {
    fail('ESTATE_QUERY_SOURCE_ENTRY_AMBIGUOUS', 'CodeFact file resolved to more than one tree entry', { file, source_commit: commit });
  }
  const separator = treeRecords[0].indexOf('\t');
  const [mode, type, blobOid, sizeText] = treeRecords[0].slice(0, separator).trim().split(/\s+/u);
  const treePath = treeRecords[0].slice(separator + 1);
  if (separator < 0 || treePath !== file || type !== 'blob' || !['100644', '100755'].includes(mode)
    || !/^[0-9a-f]{40}$/u.test(blobOid) || !/^\d+$/u.test(sizeText)) {
    fail('ESTATE_QUERY_SOURCE_ENTRY_UNSUPPORTED', 'CodeFact file is not a regular Git blob at the projection source_commit', {
      file, source_commit: commit,
    });
  }
  const bytes = gitRead(repository, ['cat-file', 'blob', blobOid]);
  const observedOid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (observedOid !== blobOid || bytes.length !== Number(sizeText)) {
    fail('ESTATE_QUERY_BLOB_BINDING_MISMATCH', 'Git blob bytes differ from the pinned tree entry', {
      file, source_commit: commit, expected_blob_oid: blobOid, observed_blob_oid: observedOid,
      expected_bytes: Number(sizeText), observed_bytes: bytes.length,
    });
  }
  return { bytes, blob: { oid: blobOid, bytes: bytes.length, object_format: objectFormat,
    content_sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function splitSourceLines(bytes) {
  if (!bytes.length) return [];
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 10) {
    lines.push(bytes.subarray(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

export class EstateGraphQueries {
  constructor({ client, default_view = 'selected', neighbor_limit = 120, overview_limit = 100,
    source_repositories = {}, estate = null }) {
    if (!(client instanceof Neo4jHttpClient)) fail('ESTATE_QUERY_CLIENT_REQUIRED', 'query surface requires an explicit Neo4j client');
    if (!['selected', 'working'].includes(default_view)) fail('ESTATE_QUERY_VIEW_INVALID', 'default view must be selected or working');
    this.client = client;
    this.defaultView = default_view;
    this.neighborLimit = boundedInteger(neighbor_limit, 'neighbor limit', 120, 1_000);
    this.overviewLimit = boundedInteger(overview_limit, 'overview limit', 100, 500);
    this.sourceRepositories = Object.freeze({ ...source_repositories });
    // One database serves every estate; this surface reads exactly one of them.
    this.estate = estate;
  }

  async projection(view = this.defaultView) {
    if (!['selected', 'working'].includes(view)) fail('ESTATE_QUERY_VIEW_INVALID', 'view must be selected or working');
    const rows = await this.client.query(`
      MATCH (h:EstateProjectionHead {slot: $slot})
      MATCH (p:EstateProjection {projection_id: h.projection_id})
      RETURN p.projection_id, p.status, p.source_commit, p.content_digest,
             p.claim_map_digest, p.code_graph_digest,
             p.processed_nodes, p.total_nodes, p.processed_edges, p.total_edges, p.projection_version,
             p.source_pins_json
    `, { slot: estateSlot(view, this.estate) });
    if (!rows.length) fail('ESTATE_QUERY_PROJECTION_MISSING', `no ${view} projection is available`);
    return projectionSummary(rows[0]);
  }

  result(query, projection, data, metadata = {}) {
    return Object.freeze({
      schema: ESTATE_GRAPH_QUERY_RESULT_SCHEMA,
      query,
      projection,
      ...metadata,
      data,
    });
  }

  async projectionStatus() {
    const heads = await readEstateProjectionHeads(this.client, { estate: this.estate });
    return Object.freeze({ schema: ESTATE_GRAPH_QUERY_RESULT_SCHEMA,
      query: 'projection-status', projection: null, data: heads });
  }

  async stats({ view } = {}) {
    const projection = await this.projection(view);
    const [nodes, edges] = await Promise.all([
      this.client.query(`
        MATCH (n:EstateNode {projection_id: $projection_id})
        RETURN n.kind, count(n) ORDER BY n.kind
      `, { projection_id: projection.projection_id }),
      this.client.query(`
        MATCH ()-[r:ESTATE_EDGE {projection_id: $projection_id}]->()
        RETURN r.relation, count(r) ORDER BY r.relation
      `, { projection_id: projection.projection_id }),
    ]);
    return this.result('stats', projection, {
      nodes_by_kind: Object.fromEntries(nodes),
      edges_by_relation: Object.fromEntries(edges),
    });
  }

  async search({ term, view, limit = 40, kinds = [], kind_quota: requestedQuota = null } = {}) {
    const query = clean(term).toLowerCase();
    const bound = boundedInteger(limit, 'search limit', 40, 200);
    const projection = await this.projection(view);
    if (!query) return this.result('search', projection, [], { term: query, truncated: false });
    const acceptedKinds = Array.isArray(kinds) ? kinds.map(clean).filter(Boolean) : [];
    const rows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id})
      WHERE n.search_text CONTAINS $term
        AND (size($kinds) = 0 OR n.kind IN $kinds)
      RETURN n.node_id, n.kind, n.label, n.properties_json
      ORDER BY CASE WHEN toLower(n.label) = $term THEN 0 ELSE 1 END,
               ${SEARCH_KIND_RANK}, n.label, n.node_id
      LIMIT $limit
    `,
    // Read a wider band than we intend to return: a quota applied to exactly `bound` rows can
    // only delete, never promote, so the kinds it makes room for must already be in hand.
    { projection_id: projection.projection_id, term: query, kinds: acceptedKinds, limit: bound * 4 + 1 });
    // The same rule the node view takes: no single kind may consume the whole budget. Ranking
    // alone is not enough when one kind outnumbers the rest by two orders of magnitude.
    const quota = requestedQuota === null
      ? Math.max(3, Math.ceil(bound / 4))
      : boundedInteger(requestedQuota, 'kind quota', Math.max(3, Math.ceil(bound / 4)), bound);
    const shown = new Map();
    const withheld = {};
    const kept = [];
    for (const row of rows) {
      const seen = shown.get(row[1]) || 0;
      if (seen >= quota) { withheld[row[1]] = (withheld[row[1]] || 0) + 1; continue; }
      shown.set(row[1], seen + 1);
      kept.push(row);
    }
    return this.result('search', projection, kept.slice(0, bound).map(row => afford(nodeFromRow(row))), {
      term: query, truncated: rows.length > bound * 4 || kept.length > bound, kind_quota: quota,
      withheld_by_kind: Object.fromEntries(Object.entries(withheld).sort(([left], [right]) => codePointOrder(left, right))),
    });
  }

  async readSpan({ id, view, before = READ_SPAN_DEFAULT_BEFORE, after = READ_SPAN_DEFAULT_AFTER } = {}) {
    const nodeId = clean(id);
    const requestedBefore = spanBound(before, 'before line count', READ_SPAN_DEFAULT_BEFORE);
    const requestedAfter = spanBound(after, 'after line count', READ_SPAN_DEFAULT_AFTER);
    if (!nodeId) fail('ESTATE_QUERY_NODE_ID_MISSING', 'read-span requires id');
    const projection = await this.projection(view);
    const nodeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
      RETURN n.node_id, n.kind, n.label, n.properties_json
    `, { projection_id: projection.projection_id, node_id: nodeId });
    if (!nodeRows.length) fail('ESTATE_QUERY_NODE_MISSING', `node ${nodeId} is absent from the projection`);
    const anchor = nodeFromRow(nodeRows[0]);
    let fact = anchor;
    if (anchor.kind !== 'CodeFact') {
      const factRows = await this.client.query(`
        MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
          -[:ESTATE_EDGE {projection_id: $projection_id, relation: 'identifies'}]-
          (fact:EstateNode {projection_id: $projection_id, kind: 'CodeFact'})
        RETURN fact.node_id, fact.kind, fact.label, fact.properties_json
        ORDER BY fact.node_id
      `, { projection_id: projection.projection_id, node_id: nodeId });
      if (!factRows.length) {
        fail('ESTATE_QUERY_SPAN_UNRESOLVED', 'read-span could not resolve the node through identifies to a CodeFact', {
          node_id: nodeId, missing: 'CodeFact reachable by identifies',
        });
      }
      if (factRows.length > 1) {
        fail('ESTATE_QUERY_SPAN_AMBIGUOUS', 'read-span resolved more than one CodeFact and will not guess', {
          node_id: nodeId, code_fact_ids: factRows.map(row => row[0]),
        });
      }
      fact = nodeFromRow(factRows[0]);
    }
    const missing = ['repository', 'file', 'line'].filter(field => fact.properties[field] == null || clean(fact.properties[field]) === '');
    if (missing.length) {
      fail('ESTATE_QUERY_SPAN_UNRESOLVED', 'resolved CodeFact lacks source location properties', {
        node_id: nodeId, code_fact_id: fact.id, missing,
      });
    }
    const repository = clean(fact.properties.repository);
    const repositoryPath = this.sourceRepositories[repository];
    if (!repositoryPath) {
      fail('ESTATE_QUERY_REPOSITORY_UNCONFIGURED', 'read-span has no configured filesystem path for the CodeFact repository', {
        node_id: nodeId, code_fact_id: fact.id, repository, missing: `source_repositories.${repository}`,
      });
    }
    const line = Number(fact.properties.line);
    if (!Number.isSafeInteger(line) || line < 1) {
      fail('ESTATE_QUERY_SPAN_UNRESOLVED', 'resolved CodeFact line must be a positive integer', {
        node_id: nodeId, code_fact_id: fact.id, missing: 'line',
      });
    }
    const file = safeSourcePath(fact.properties.file);
    // A multi-repo estate pins each repository separately, so the fact's own repository selects
    // the commit its bytes must come from. A single-repo projection keeps using its source commit.
    const pinned = projection.source_pins?.[repository];
    if (projection.source_pins && !pinned) {
      fail('ESTATE_QUERY_SOURCE_PIN_MISSING', 'projection has no source pin for the CodeFact repository', {
        node_id: nodeId, code_fact_id: fact.id, repository,
      });
    }
    const sourceCommit = pinned ?? projection.source_commit;
    const { bytes, blob } = committedBlob({ repository: repositoryPath, sourceCommit, file });
    const lines = splitSourceLines(bytes);
    if (line > lines.length) {
      fail('ESTATE_QUERY_SOURCE_LINE_MISSING', 'CodeFact line is absent at the projection source_commit', {
        file, line, source_commit: sourceCommit, total_lines: lines.length,
      });
    }
    const boundedBefore = Math.min(requestedBefore, READ_SPAN_MAX_LINES - 1);
    const boundedAfter = Math.min(requestedAfter, READ_SPAN_MAX_LINES - 1 - boundedBefore);
    const desiredStart = Math.max(1, line - boundedBefore);
    const desiredEnd = Math.min(lines.length, line + boundedAfter);
    const anchorLine = lines[line - 1];
    if (anchorLine.length > READ_SPAN_MAX_BYTES) {
      fail('ESTATE_QUERY_SPAN_LINE_TOO_LARGE', 'CodeFact anchor line exceeds the read-span byte ceiling', {
        file, line, maximum_bytes: READ_SPAN_MAX_BYTES, line_bytes: anchorLine.length,
      });
    }
    const selected = [anchorLine];
    let start = line - 1;
    let end = line;
    let size = anchorLine.length;
    for (let index = line - 2; index >= desiredStart - 1; index -= 1) {
      if (size + lines[index].length > READ_SPAN_MAX_BYTES) break;
      selected.unshift(lines[index]); size += lines[index].length; start = index;
    }
    for (let index = line; index < desiredEnd; index += 1) {
      if (size + lines[index].length > READ_SPAN_MAX_BYTES) break;
      selected.push(lines[index]); size += lines[index].length; end = index + 1;
    }
    const span = Buffer.concat(selected);
    const returnedRange = { start_line: start + 1, end_line: end, lines: selected.length, bytes: span.length };
    const requestedRange = { start_line: Math.max(1, line - requestedBefore), end_line: line + requestedAfter,
      before: requestedBefore, after: requestedAfter };
    const truncated = boundedBefore !== requestedBefore || boundedAfter !== requestedAfter
      || returnedRange.start_line !== desiredStart || returnedRange.end_line !== desiredEnd;
    return this.result('read-span', projection, {
      node_id: nodeId, code_fact_id: fact.id, file, line, repository, source_commit: projection.source_commit,
      blob, requested_range: requestedRange, returned_range: returnedRange, truncated,
      span_sha256: createHash('sha256').update(span).digest('hex'),
      bytes_base64: span.toString('base64'), text: span.toString('utf8'),
    });
  }

  async overview({ view, limit = this.overviewLimit } = {}) {
    const bound = boundedInteger(limit, 'overview limit', this.overviewLimit, 500);
    const projection = await this.projection(view);
    this.requireRoles(projection, 'overview');
    const anchorRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id})
      WITH n ORDER BY CASE n.kind WHEN 'Project' THEN 0 WHEN 'SourceCommit' THEN 1 ELSE 2 END,
                     coalesce(n.structural_degree, n.degree) DESC, n.node_id
      LIMIT 1
      RETURN n.node_id, n.kind, n.label, n.properties_json, ${STRUCTURE_COLUMNS('n')}
    `, { projection_id: projection.projection_id });
    if (!anchorRows.length) {
      return this.result('overview', projection, { nodes: [], edges: [] }, { truncated: false });
    }
    const kindCap = Math.max(3, Math.ceil(bound / 4));
    const selected = new Map();
    const kindCounts = new Map();
    const admit = row => {
      const node = structuredNode(row);
      selected.set(node.id, node);
      kindCounts.set(node.kind, (kindCounts.get(node.kind) || 0) + 1);
      return node.id;
    };
    // Descent follows structural edges from parent to child only, so the view is the estate's
    // composition tree cut at the limit. Flow and annotation edges among the admitted nodes are
    // still returned below; they are not allowed to pull new nodes into the cut.
    let frontier = [admit(anchorRows[0])];
    while (selected.size < bound && frontier.length) {
      const next = [];
      for (const current of frontier) {
        if (selected.size >= bound) break;
        const rows = await this.client.query(`
          MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
            -[r:ESTATE_EDGE {projection_id: $projection_id, role: 'structural'}]-(other:EstateNode {projection_id: $projection_id})
          WHERE (r.parent_end = 'from' AND startNode(r) = n) OR (r.parent_end = 'to' AND endNode(r) = n)
          WITH DISTINCT other
          ORDER BY ${PLANE_RANK('other.plane')}, other.structural_descendants DESC, other.structural_degree DESC, other.node_id
          WITH other.kind AS kind, collect(other)[0..$kind_cap] AS ranked
          UNWIND ranked AS other
          RETURN other.node_id, other.kind, other.label, other.properties_json, ${STRUCTURE_COLUMNS('other')}
          ORDER BY ${PLANE_RANK('other.plane')}, other.structural_descendants DESC, other.structural_degree DESC, other.node_id
          LIMIT $limit
        `, { projection_id: projection.projection_id, node_id: current, kind_cap: kindCap, limit: bound });
        for (const row of rows) {
          if (selected.size >= bound) break;
          if (selected.has(row[0]) || (kindCounts.get(row[1]) || 0) >= kindCap) continue;
          next.push(admit(row));
        }
      }
      frontier = next;
    }
    const nodes = [...selected.values()];
    const ids = nodes.map(node => node.id);
    const edgeRows = ids.length ? await this.client.query(`
      MATCH (a:EstateNode {projection_id: $projection_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]->
        (b:EstateNode {projection_id: $projection_id})
      WHERE a.node_id IN $ids AND b.node_id IN $ids AND r.role IN ['structural', 'flow']
      RETURN r.edge_id, r.relation, a.node_id, b.node_id, r.properties_json, r.role, r.parent_end
      ORDER BY r.edge_id
    `, { projection_id: projection.projection_id, ids }) : [];
    return this.result('overview', projection, {
      nodes,
      edges: edgeRows.map(row => ({ id: row[0], relation: row[1], from: row[2], to: row[3],
        properties: parseProperties(row[4]), role: row[5], parent_end: row[6] ?? null })),
    }, {
      truncated: projection.total_nodes > nodes.length,
      traversal: {
        anchor_node_id: ids[0],
        selection: 'structural descent from the estate anchor',
        expansion_role: 'structural',
        edge_roles: ['structural', 'flow'],
        ranking: ['plane', 'structural_descendants', 'structural_degree', 'node_id'],
        neighbor_limit: bound,
        kind_cap: kindCap,
      },
    });
  }

  async concepts({ view, limit = 12 } = {}) {
    const bound = boundedInteger(limit, 'concept limit', 12, 50);
    const projection = await this.projection(view);
    const [documents, asserted, documented, structural] = await Promise.all([
      this.client.query(`
        MATCH (d:EstateNode {projection_id: $projection_id, kind: 'Document'})
          -[r:ESTATE_EDGE {projection_id: $projection_id, relation: 'contains'}]->
          (c:EstateNode {projection_id: $projection_id, kind: 'Claim'})
        WITH d, count(c) AS claims
        ORDER BY claims DESC, d.node_id
        LIMIT $limit
        RETURN d.node_id, d.label, d.properties_json, claims
      `, { projection_id: projection.projection_id, limit: bound }),
      this.client.query(`
        MATCH (c:EstateNode {projection_id: $projection_id, kind: 'Claim'})
          -[r:ESTATE_EDGE {projection_id: $projection_id}]->
          (f:EstateNode {projection_id: $projection_id, kind: 'CodeFact'})
        WHERE r.relation IN ['about', 'realized_by']
        MATCH (f)-[:ESTATE_EDGE {projection_id: $projection_id, relation: 'identifies'}]->
          (e:EstateNode {projection_id: $projection_id})
        WHERE e.kind IN $entity_kinds
        WITH e, count(DISTINCT c) AS claims
        ORDER BY claims DESC, e.node_id
        LIMIT $limit
        RETURN e.node_id, e.label, e.properties_json, claims
      `, { projection_id: projection.projection_id, limit: bound, entity_kinds: ENTITY_NODE_KINDS }),
      this.client.query(`
        MATCH (e:EstateNode {projection_id: $projection_id})
          -[r:ESTATE_EDGE {projection_id: $projection_id, relation: 'documented_in'}]-
          (d:EstateNode {projection_id: $projection_id, kind: 'Document'})
        WHERE e.kind IN $entity_kinds
        WITH e, count(DISTINCT d) AS documents
        ORDER BY documents DESC, e.node_id
        LIMIT $limit
        RETURN e.node_id, e.label, e.properties_json, documents
      `, { projection_id: projection.projection_id, limit: bound, entity_kinds: ENTITY_NODE_KINDS }),
      this.client.query(`
        MATCH (e:EstateNode {projection_id: $projection_id})
          -[r:ESTATE_EDGE {projection_id: $projection_id}]-(other:EstateNode {projection_id: $projection_id})
        WHERE e.kind IN $entity_kinds AND r.relation IN $relations
        WITH e, count(r) AS connections
        ORDER BY connections DESC, e.node_id
        LIMIT $limit
        RETURN e.node_id, e.label, e.properties_json, connections
      `, {
        projection_id: projection.projection_id, limit: bound,
        entity_kinds: ENTITY_NODE_KINDS,
        relations: ['declares_symbol', 'declares_table', 'depends_on', 'exposes_route',
          'imports', 'registers_route', 'requires_capability', 'provides_capability',
          'publishes_envelope', 'calls_capability', 'member_of'],
      }),
    ]);
    const namespaced = row => ({ id: row[0], label: row[1],
      namespace: parseProperties(row[2]).namespace || null });
    return this.result('concepts', projection, {
      documents_by_claims: documents.map(row => ({ id: row[0], label: row[1],
        properties: parseProperties(row[2]), claims: row[3] })),
      entities_by_claims: asserted.map(row => ({ ...namespaced(row), claims: row[3] })),
      entities_by_structure: structural.map(row => ({ ...namespaced(row), connections: row[3] })),
      entities_by_surface_mention: documented.map(row => ({ ...namespaced(row), documents: row[3] })),
    }, {
      measure: 'exact counts over projected edges; no clustering, ranking heuristic, or similarity',
      surface_mention_caveat: 'surface mentions are byte-exact token occurrences and include ambient vocabulary (common words that are also symbol names); they are not subject matter',
    });
  }

  // Roles are projected, not inferred at query time. A generation written before the registry has
  // no role column; answering a structural question from it would silently return nothing, so the
  // role-driven views refuse it by name while every other query keeps working.
  requireRoles(projection, query) {
    if (projection.projection_version === 'unified-serving-projection@1' || projection.projection_version == null) {
      fail('ESTATE_QUERY_ROLES_UNAVAILABLE', `${query} requires a projection that carries relation roles`, {
        projection_id: projection.projection_id, projection_version: projection.projection_version,
      });
    }
  }

  async node({ id, view, limit = this.neighborLimit, expand = 'structural' , kind_quota: requestedQuota = null } = {}) {
    const nodeId = graphNodeId(id, 'node query');
    const bound = boundedInteger(limit, 'neighbor limit', this.neighborLimit, 1_000);
    if (!NODE_EXPANSIONS.includes(expand)) fail('ESTATE_QUERY_EXPAND_INVALID', 'expand must be structural or all', { expand });
    const projection = await this.projection(view);
    this.requireRoles(projection, 'node');
    const nodeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
      RETURN n.node_id, n.kind, n.label, n.properties_json, ${STRUCTURE_COLUMNS('n')}
    `, { projection_id: projection.projection_id, node_id: nodeId });
    if (!nodeRows.length) fail('ESTATE_QUERY_NODE_MISSING', `node ${nodeId} is absent from the projection`);
    // The drill-down is the same operation at every depth: structural and flow neighbours are
    // returned as nodes, ranked so the node's own composition comes first; annotation edges are
    // returned as complete per-relation bundles whose counts are never truncated. `expand: all`
    // is the atom view — every relation as rows — with annotation still ordered last.
    const roles = expand === 'structural' ? ['structural', 'flow'] : [...RELATION_ROLES, 'unclassified'];
    const edgeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]-(other:EstateNode {projection_id: $projection_id})
      WHERE coalesce(r.role, 'unclassified') IN $roles
      WITH n, r, other, ${ROLE_RANK('r.role')} AS role_rank, ${PLANE_RANK('other.plane')} AS plane_rank,
           CASE WHEN r.role = 'structural' AND ((r.parent_end = 'from' AND startNode(r) = n) OR (r.parent_end = 'to' AND endNode(r) = n)) THEN 0 ELSE 1 END AS child_rank
      RETURN r.edge_id, r.relation, startNode(r).node_id, endNode(r).node_id,
             other.node_id, other.kind, other.label, other.properties_json, r.properties_json, r.role,
             ${STRUCTURE_COLUMNS('other')}, r.parent_end
      ORDER BY role_rank, child_rank, plane_rank, other.structural_descendants DESC, r.relation, other.kind, other.label, r.edge_id
      LIMIT $limit
    `, { projection_id: projection.projection_id, node_id: nodeId, roles, limit: bound * 4 + 1 });
    // One dominant kind must not consume the whole budget. A document with 233 claims and one
    // section spent all 120 rows on claims; the section survived only because it happened to
    // outrank them on descendants, and a document whose claims sorted higher would have shown no
    // structure at all while looking complete. Drawing 119 of 233 identical siblings also says
    // nothing the counted bundle does not already say better, so the remainder stays folded.
    // The overview has applied this quota since it was written; the node view had not.
    // How many of one kind is a judgement, not a constant. The default only guarantees that no
    // kind can crowd out the rest; a caller that wants the mass unfolded raises it.
    const kindQuota = requestedQuota === null
      ? Math.max(3, Math.ceil(bound / 4))
      : boundedInteger(requestedQuota, 'kind quota', Math.max(3, Math.ceil(bound / 4)), bound);
    const shownByKind = new Map();
    const quotaRows = [];
    const withheld = {};
    for (const row of edgeRows) {
      const kind = row[5];
      const shown = shownByKind.get(kind) || 0;
      if (shown >= kindQuota) { withheld[kind] = (withheld[kind] || 0) + 1; continue; }
      shownByKind.set(kind, shown + 1);
      quotaRows.push(row);
    }
    const bundleRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]-(other:EstateNode {projection_id: $projection_id})
      WITH coalesce(r.role, 'unclassified') AS role, r.relation AS relation,
           CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction, other.kind AS kind, count(r) AS bundle_count
      RETURN role, relation, direction, kind, bundle_count
      ORDER BY role, relation, direction, kind
    `, { projection_id: projection.projection_id, node_id: nodeId });
    const neighbors = quotaRows.slice(0, bound).map(row => ({
      // Which end is the parent is a fact the projection already recorded; a client that must
      // guess it cannot draw containment as containment.
      edge: { id: row[0], relation: row[1], from: row[2], to: row[3], properties: parseProperties(row[8]),
        role: row[9] ?? 'unclassified', parent_end: row[13] ?? null },
      node: afford({ ...nodeFromRow(row, 4), plane: row[10] ?? null, structural_children: row[11] ?? null, structural_descendants: row[12] ?? null }),
    }));
    return this.result('node', projection, {
      node: afford(structuredNode(nodeRows[0])),
      neighbors,
      bundles: bundleRows.map(row => ({
        role: row[0], relation: row[1], direction: row[2], kind: row[3], count: Number(row[4]),
        next_queries: [{ command: 'neighbors', arguments: { id: nodeId, relation: row[1], direction: row[2] } }],
      })),
    }, { expand, neighbor_roles: roles, truncated: edgeRows.length > bound * 4 || quotaRows.length > bound,
      // Disclosed rather than silent: a row a quota withheld is still in the bundle counts, and
      // saying which kinds were capped is what keeps a bounded view from reading as a complete one.
      kind_quota: kindQuota,
      withheld_by_kind: Object.fromEntries(Object.entries(withheld).sort(([left], [right]) => codePointOrder(left, right))) });
  }

  async neighbors({ id, relation, direction, limit = TRAVERSAL_DEFAULT_LIMIT, view } = {}) {
    const nodeId = graphNodeId(id, 'neighbors');
    const exact = exactRelation(relation);
    const requestedDirection = traversalDirection(direction);
    const bound = boundedInteger(limit, 'neighbors limit', TRAVERSAL_DEFAULT_LIMIT, TRAVERSAL_MAX_LIMIT);
    const projection = await this.projection(view);
    const nodeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
      RETURN n.node_id, n.kind, n.label, n.properties_json
      LIMIT 2
    `, { projection_id: projection.projection_id, node_id: nodeId });
    if (!nodeRows.length) fail('ESTATE_QUERY_NODE_MISSING', `node ${nodeId} is absent from the projection`);
    if (nodeRows.length !== 1) fail('ESTATE_QUERY_NODE_AMBIGUOUS', `node ${nodeId} resolved more than once`);
    const edgeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]-(other:EstateNode {projection_id: $projection_id})
      WHERE ($relation IS NULL OR r.relation = $relation)
        AND ($direction = 'both'
          OR ($direction = 'out' AND startNode(r).node_id = $node_id)
          OR ($direction = 'in' AND endNode(r).node_id = $node_id))
      RETURN r.edge_id, r.relation, startNode(r).node_id, endNode(r).node_id,
             other.node_id, other.kind, other.label, other.properties_json, r.properties_json,
             r.role, r.parent_end
      ORDER BY r.relation, startNode(r).node_id, endNode(r).node_id, r.edge_id
      LIMIT $limit
    `, { projection_id: projection.projection_id, node_id: nodeId, relation: exact,
      direction: requestedDirection, limit: bound + 1 });
    const retained = edgeRows.slice(0, bound);
    const adjacent = new Map();
    const edges = retained.map(row => {
      const node = afford(nodeFromRow(row, 4)); adjacent.set(node.id, node);
      return { id: row[0], relation: row[1], from: row[2], to: row[3], properties: parseProperties(row[8]),
        role: row[9] ?? 'unclassified', parent_end: row[10] ?? null };
    });
    return this.result('neighbors', projection, {
      focal_node: afford(nodeFromRow(nodeRows[0])),
      adjacent_nodes: [...adjacent.values()].sort((left, right) => codePointOrder(left.id, right.id)),
      edges,
    }, { relation: exact, direction: requestedDirection, truncated: edgeRows.length > bound });
  }

  async consumers({ id, limit = TRAVERSAL_DEFAULT_LIMIT, view } = {}) {
    const nodeId = graphNodeId(id, 'consumers');
    const bound = boundedInteger(limit, 'consumers limit', TRAVERSAL_DEFAULT_LIMIT, TRAVERSAL_MAX_LIMIT);
    const projection = await this.projection(view);
    const nodeRows = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
      RETURN n.node_id, n.kind, n.label, n.properties_json
      LIMIT 2
    `, { projection_id: projection.projection_id, node_id: nodeId });
    if (!nodeRows.length) fail('ESTATE_QUERY_NODE_MISSING', `Envelope ${nodeId} is absent from the projection`);
    if (nodeRows.length !== 1) fail('ESTATE_QUERY_NODE_AMBIGUOUS', `Envelope ${nodeId} resolved more than once`);
    const envelope = nodeFromRow(nodeRows[0]);
    if (envelope.kind !== 'Envelope') fail('ESTATE_QUERY_NODE_KIND_INVALID', 'consumers requires an Envelope node ID', {
      node_id: nodeId, kind: envelope.kind,
    });
    const countRows = await this.client.query(`
      MATCH (participant:EstateNode {projection_id: $projection_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]->
        (envelope:EstateNode {projection_id: $projection_id, node_id: $node_id, kind: 'Envelope'})
      WHERE r.relation IN $relations
      RETURN r.relation, count(r)
      ORDER BY r.relation
    `, { projection_id: projection.projection_id, node_id: nodeId,
      relations: [...PUBLISHER_RELATIONS, ...CONSUMER_RELATIONS] });
    const rows = await this.client.query(`
      MATCH (participant:EstateNode {projection_id: $projection_id})
        -[r:ESTATE_EDGE {projection_id: $projection_id}]->
        (envelope:EstateNode {projection_id: $projection_id, node_id: $node_id, kind: 'Envelope'})
      WHERE r.relation IN $relations
      RETURN r.edge_id, r.relation, participant.node_id, participant.kind, participant.label,
             participant.properties_json, startNode(r).node_id, endNode(r).node_id, r.properties_json
      ORDER BY r.relation, participant.kind, participant.label, participant.node_id, r.edge_id
      LIMIT $limit
    `, { projection_id: projection.projection_id, node_id: nodeId,
      relations: [...PUBLISHER_RELATIONS, ...CONSUMER_RELATIONS], limit: bound + 1 });
    const retained = rows.slice(0, bound);
    const group = relations => retained.filter(row => relations.includes(row[1])).map(row => ({
      relation: row[1], node: afford(nodeFromRow(row, 2)),
      edge: { id: row[0], relation: row[1], from: row[6], to: row[7], properties: parseProperties(row[8]) },
    }));
    const publishers = group(PUBLISHER_RELATIONS);
    const consumers = group(CONSUMER_RELATIONS);
    const byRelation = (relations, entries) => countRows.filter(row => relations.includes(row[0])).map(([relation, count]) => {
      const members = entries.filter(entry => entry.relation === relation);
      // One participant reached by many edges is one participant. Repeating its node object per
      // edge inflated the response past a bounded agent's byte ceiling without adding a fact;
      // edges below still carry every edge and both endpoints.
      const nodes = [...new Map(members.map(member => [member.node.id, member.node])).values()];
      return { relation, count: Number(count), returned_count: members.length,
        distinct_node_count: nodes.length, nodes, edges: members.map(member => member.edge) };
    });
    const publisherCount = countRows.filter(row => PUBLISHER_RELATIONS.includes(row[0])).reduce((total, row) => total + Number(row[1]), 0);
    const consumerCount = countRows.filter(row => CONSUMER_RELATIONS.includes(row[0])).reduce((total, row) => total + Number(row[1]), 0);
    return this.result('consumers', projection, {
      envelope: afford(envelope),
      publishers: byRelation(PUBLISHER_RELATIONS, publishers), consumers: byRelation(CONSUMER_RELATIONS, consumers),
      publisher_count: publisherCount, consumer_count: consumerCount,
      has_zero_publishers: publisherCount === 0, has_zero_consumers: consumerCount === 0,
    }, { truncated: rows.length > bound });
  }

  async path({ from, to, view, depth = 6 } = {}) {
    const start = graphNodeId(from, 'path'), end = graphNodeId(to, 'path');
    const bound = boundedInteger(depth, 'path depth', 6, 12);
    const projection = await this.projection(view);
    const rows = await this.client.query(`
      MATCH (a:EstateNode {projection_id: $projection_id, node_id: $from})
      MATCH (b:EstateNode {projection_id: $projection_id, node_id: $to})
      MATCH p = shortestPath((a)-[:ESTATE_EDGE*..${bound}]-(b))
      RETURN [n IN nodes(p) | [n.node_id, n.kind, n.label, n.properties_json]],
             [r IN relationships(p) | [r.edge_id, r.relation, startNode(r).node_id,
                                        endNode(r).node_id, r.properties_json]]
    `, { projection_id: projection.projection_id, from: start, to: end });
    const row = rows[0];
    return this.result('path', projection, row ? {
      nodes: row[0].map(node => nodeFromRow(node)),
      edges: row[1].map(edge => ({ id: edge[0], relation: edge[1], from: edge[2], to: edge[3],
        properties: parseProperties(edge[4]) })),
    } : null, { max_depth: bound });
  }

  async provenance({ id, view, depth = 6, limit = 12 } = {}) {
    const nodeId = clean(id);
    const maxDepth = boundedInteger(depth, 'provenance depth', 6, 12);
    const bound = boundedInteger(limit, 'provenance limit', 12, 50);
    if (!nodeId) fail('ESTATE_QUERY_NODE_ID_MISSING', 'provenance requires a node ID');
    const projection = await this.projection(view);
    const start = await this.client.query(`
      MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id}) RETURN n.node_id
    `, { projection_id: projection.projection_id, node_id: nodeId });
    if (!start.length) fail('ESTATE_QUERY_NODE_MISSING', `node ${nodeId} is absent from the projection`);

    // Bounded breadth-first justification walk. Each step is one indexed neighbor query with an
    // explicit cap, so cost is bounded by depth x frontier x neighbors rather than by graph size.
    const predecessor = new Map([[nodeId, null]]);
    const nodesById = new Map();
    const targets = [];
    let frontier = [nodeId];
    let expandedNodes = 0;
    let frontierTruncated = false;
    for (let level = 0; level < maxDepth && frontier.length && targets.length <= bound; level += 1) {
      const nextFrontier = [];
      for (const current of frontier) {
        if (targets.length > bound) break;
        expandedNodes += 1;
        const rows = await this.client.query(`
          MATCH (n:EstateNode {projection_id: $projection_id, node_id: $node_id})
            -[r:ESTATE_EDGE {projection_id: $projection_id}]-(other:EstateNode {projection_id: $projection_id})
          WHERE r.relation IN $relations
          RETURN r.edge_id, r.relation, startNode(r).node_id, endNode(r).node_id,
                 other.node_id, other.kind, other.label, other.properties_json
          ORDER BY other.degree, r.relation, other.node_id
          LIMIT $limit
        `, {
          projection_id: projection.projection_id, node_id: current,
          relations: PROVENANCE_RELATIONS, limit: PROVENANCE_NEIGHBOR_LIMIT,
        });
        for (const row of rows) {
          const neighborId = row[4];
          if (predecessor.has(neighborId)) continue;
          predecessor.set(neighborId, { from: current,
            edge: { id: row[0], relation: row[1], from: row[2], to: row[3] } });
          nodesById.set(neighborId, nodeFromRow(row, 4));
          if (PROVENANCE_TARGET_KINDS.includes(row[5]) && targets.length <= bound) {
            targets.push(neighborId);
          }
          if (nextFrontier.length < PROVENANCE_FRONTIER_LIMIT) nextFrontier.push(neighborId);
          else frontierTruncated = true;
        }
      }
      frontier = nextFrontier;
    }

    const data = targets.slice(0, bound).map(targetId => {
      const pathNodeIds = [targetId];
      const edges = [];
      let cursor = predecessor.get(targetId);
      while (cursor) {
        edges.unshift(cursor.edge);
        pathNodeIds.unshift(cursor.from);
        cursor = predecessor.get(cursor.from);
      }
      return { target: nodesById.get(targetId), path_node_ids: pathNodeIds, edges };
    });
    return this.result('provenance', projection, data, {
      truncated: targets.length > bound || frontierTruncated,
      max_depth: maxDepth,
      traversal: {
        relations: PROVENANCE_RELATIONS,
        target_kinds: PROVENANCE_TARGET_KINDS,
        expanded_nodes: expandedNodes,
        frontier_limit: PROVENANCE_FRONTIER_LIMIT,
        neighbor_limit: PROVENANCE_NEIGHBOR_LIMIT,
        excluded_relations: ['contains', 'documented_in'],
        exclusion_reason: 'structural containment and documentary occurrence are ambient, not justification',
      },
    });
  }
}

function parseCli(argv) {
  const options = {};
  let command = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') && !command) { command = token; continue; }
    if (!token.startsWith('--')) fail('ESTATE_QUERY_ARGUMENT_INVALID', `unexpected argument ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('ESTATE_QUERY_ARGUMENT_INVALID', `${token} requires a value`);
    options[key] = value; index += 1;
  }
  if (!command || !options.runtime_config) {
    fail('ESTATE_QUERY_ARGUMENT_INVALID', 'usage: estate-graph-query --runtime-config <path> <command> [options]');
  }
  return { command, options };
}

export async function runEstateGraphQueryCli(argv, environment = process.env) {
  const { command, options } = parseCli(argv);
  const runtime = loadEstateMapRuntimeConfig(options.runtime_config);
  const client = new Neo4jHttpClient(neo4jConnectionFromConfig(runtime, environment));
  const queries = new EstateGraphQueries({
    client,
    default_view: runtime.config.projection.default_view,
    neighbor_limit: runtime.config.dashboard.neighbor_limit,
    overview_limit: runtime.config.dashboard.overview_limit,
    source_repositories: runtime.config.source_repositories,
    estate: runtime.config.projection.estate,
  });
  const common = { view: options.view };
  if (command === 'contract') return querySurfaceContract({ estate: runtime.config.projection.estate });
  if (command === 'projection-status') return queries.projectionStatus();
  if (command === 'stats') return queries.stats(common);
  if (command === 'concepts') return queries.concepts({ ...common, limit: options.limit });
  if (command === 'overview') return queries.overview({ ...common, limit: options.limit });
  if (command === 'search') return queries.search({ ...common, term: options.term, limit: options.limit,
    kinds: options.kinds ? options.kinds.split(',') : [], kind_quota: options.kind_quota });
  if (command === 'node') return queries.node({ ...common, id: options.id, limit: options.limit,
    expand: options.expand, kind_quota: options.kind_quota });
  if (command === 'neighbors') return queries.neighbors({ ...common, id: options.id, relation: options.relation,
    direction: options.direction, limit: options.limit });
  if (command === 'consumers') return queries.consumers({ ...common, id: options.id, limit: options.limit });
  if (command === 'path') return queries.path({ ...common, from: options.from, to: options.to, depth: options.depth });
  if (command === 'provenance') return queries.provenance({ ...common, id: options.id,
    depth: options.depth, limit: options.limit });
  if (command === 'read-span') return queries.readSpan({ ...common, id: options.id,
    before: options.before, after: options.after });
  fail('ESTATE_QUERY_COMMAND_UNKNOWN', `unknown query command ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runEstateGraphQueryCli(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ error: error.code || 'ESTATE_QUERY_FAILED',
      message: error.message, detail: error.detail || null }, null, 2));
    process.exitCode = 1;
  }
}
