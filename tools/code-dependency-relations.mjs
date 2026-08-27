// Typed dependency-relation projection (unified design section 5; C4 design section 17).
//
// Every exact merge-graph edge becomes exactly one CodeDependencyRelation record carrying the
// exact producer edge kind, endpoint mention ids where an identity candidate exists, verbatim
// witnesses, and the merge-time status. Relations are navigation: they are incapable of creating
// or merging a Referent, and a relation is traversable only when both endpoints hold
// receipt-backed Referents. Nothing here is inferred; unmappable endpoints stay explicit.
import { sha256, stableStringify } from './lib.mjs';

export const CODE_DEPENDENCY_RELATION_SCHEMA = 'estate-map/code-dependency-relation/v1';
export const CODE_DEPENDENCY_RELATION_REPORT_SCHEMA = 'estate-map/code-dependency-relation-report/v1';
export const CODE_DEPENDENCY_RELATION_STATUSES = Object.freeze([
  'resolved', 'ambiguous', 'unresolved', 'external',
]);

const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const compare = (left, right) => left.localeCompare(right);

function fail(message) { throw new Error(message); }

/** Merge-time edge statuses collapse onto the closed section-5 vocabulary, never silently. */
function relationStatus(edgeStatus) {
  switch (edgeStatus) {
    case 'resolved': return 'resolved';
    case 'ambiguous': return 'ambiguous';
    case 'external_producer': return 'external';
    case 'unmatched': return 'unresolved';
    default: return edgeStatus === undefined ? 'unresolved' : null;
  }
}

// Node kinds whose merge witness (exact repo+file+line) joins one identity candidate. tf_module
// and package nodes are deliberately absent: their witnesses point at whichever fact minted the
// node, so a locator join would be ambiguous — a wrong anchor is worse than none.
const NODE_KIND_TO_FACT_KIND = Object.freeze({
  route: 'http_route', sql_object: 'sql_object', tf_resource: 'tf_resource', repo: 'repo',
  capability: 'capability_flow', envelope_kind: 'envelope_flow',
});

// A merge node lists every site that witnessed it, in producer order, and the first of those is
// often a usage rather than the declaration: `capability:brew` witnesses a `requires_capability`
// line before the manifest that provides it. Anchoring on the first witness would therefore bind a
// domain entity to a site that merely mentions it. Every witness is considered instead, and the
// anchor is accepted only when the matching candidates agree on one identity basis — which is the
// normal case for a capability or envelope declared in several manifests, and refused when two
// genuinely different declarations would otherwise collide.
const DECLARED_DOMAIN_FACT_KINDS = Object.freeze(['capability_flow', 'envelope_flow']);

/**
 * Project exact merge-graph edges into relation records. `identity_candidates` are the real
 * candidate rows from the code plane. Module endpoints anchor by exact node id
 * (`module:<repo>:<file>`); route/table/resource/repo endpoints anchor through their witness
 * locator joined to exactly one candidate record. An endpoint without an unambiguous exact
 * anchor stays null with its node id preserved.
 */
export function buildCodeDependencyRelations({
  merge_graph: mergeGraph, code_plane_head: codePlaneHead, identity_candidates: candidates = [],
}) {
  if (!Array.isArray(mergeGraph?.edges) || !Array.isArray(mergeGraph?.nodes)) {
    fail('dependency relations require the exact merge graph with nodes and edges');
  }
  if (!codePlaneHead) fail('dependency relations require the exact code plane head');
  const nodeById = new Map(mergeGraph.nodes.map(node => [node.id, node]));
  if (nodeById.size !== mergeGraph.nodes.length) fail('merge graph contains duplicate node ids');
  const moduleAnchors = new Map();
  for (const candidate of candidates) {
    if (candidate.fact_kind !== 'module') continue;
    const key = `module:${candidate.record.repo}:${candidate.record.file}`;
    if (moduleAnchors.has(key)) fail(`duplicate module identity candidate for ${key}`);
    moduleAnchors.set(key, {
      mention_id: candidate.mention.mention_id, fact_id: candidate.fact_id,
    });
  }
  const locatorAnchors = new Map();
  for (const candidate of candidates) {
    const factKind = candidate.fact_kind;
    if (!Object.values(NODE_KIND_TO_FACT_KIND).includes(factKind)) continue;
    const key = canonical([candidate.record.repo, candidate.record.file,
      candidate.record.line, factKind]);
    locatorAnchors.set(key, locatorAnchors.has(key) ? null : {
      mention_id: candidate.mention.mention_id, fact_id: candidate.fact_id,
    });
  }
  const basisByLocator = new Map();
  for (const candidate of candidates) {
    if (!DECLARED_DOMAIN_FACT_KINDS.includes(candidate.fact_kind)) continue;
    basisByLocator.set(canonical([candidate.record.repo, candidate.record.file,
      candidate.record.line, candidate.fact_kind]), {
      mention_id: candidate.mention.mention_id, fact_id: candidate.fact_id,
      basis: canonical(candidate.candidate_basis),
    });
  }
  const anchor = nodeId => {
    const direct = moduleAnchors.get(nodeId);
    if (direct) return direct;
    const node = nodeById.get(nodeId);
    const factKind = node ? NODE_KIND_TO_FACT_KIND[node.kind] : null;
    if (!factKind) return null;
    if (DECLARED_DOMAIN_FACT_KINDS.includes(factKind)) {
      const matches = [];
      for (const witness of node.witnesses || []) {
        if (!witness?.file || !Number.isInteger(witness?.line)) continue;
        const held = basisByLocator.get(canonical([witness.repo ?? node.repo, witness.file,
          witness.line, factKind]));
        if (held) matches.push(held);
      }
      if (!matches.length) return null;
      return matches.every(row => row.basis === matches[0].basis)
        ? { mention_id: matches[0].mention_id, fact_id: matches[0].fact_id } : null;
    }
    const witness = node?.witnesses?.[0];
    if (!witness?.file || !Number.isInteger(witness?.line)) return null;
    return locatorAnchors.get(canonical([witness.repo ?? node.repo, witness.file,
      witness.line, factKind])) || null;
  };
  const relations = [];
  const refusals = [];
  const seen = new Set();
  for (const edge of mergeGraph.edges) {
    const status = relationStatus(edge.status);
    if (status === null) {
      refusals.push(Object.freeze({
        edge_id: edge.id, refusal: 'unknown_edge_status', observed_status: edge.status,
      }));
      continue;
    }
    if (!edge.id || seen.has(edge.id)) {
      refusals.push(Object.freeze({
        edge_id: edge.id || null, refusal: edge.id ? 'duplicate_edge_id' : 'missing_edge_id',
      }));
      continue;
    }
    seen.add(edge.id);
    const fromAnchor = edge.from ? anchor(edge.from) : null;
    const toAnchor = edge.to ? anchor(edge.to) : null;
    const body = {
      schema: CODE_DEPENDENCY_RELATION_SCHEMA,
      code_plane_head: codePlaneHead,
      source_edge_id: edge.id,
      edge_kind: edge.kind,
      from_node_id: edge.from ?? null,
      to_node_id: edge.to ?? null,
      from_code_mention_id: fromAnchor?.mention_id ?? null,
      to_code_mention_id: toAnchor?.mention_id ?? null,
      from_fact_id: fromAnchor?.fact_id ?? null,
      to_fact_id: toAnchor?.fact_id ?? null,
      candidate_to_node_ids: Object.freeze([...(edge.candidates || [])].sort(compare)),
      status,
      direction: 'from_to',
      witnesses: Object.freeze(structuredClone(edge.witnesses || [])),
      // A wildcard subscription expands to one edge per matched kind. Losing the pattern made
      // expanded edges indistinguishable from literal flow facts, so a reader answering a
      // literal-facts question was misled by edges the producer derived rather than witnessed.
      ...(edge.resolution_kind ? { resolution_kind: edge.resolution_kind, match_pattern: edge.match_pattern ?? null } : {}),
      relation_plane: 'technical_dependency',
    };
    relations.push(Object.freeze({ ...body, relation_id: hashId('code-dependency-relation', body) }));
  }
  const mergeRelationCount = relations.length;
  // Containment: a declaration is inside its exact file. Both endpoints are real candidates from
  // the same producer facts (repo+file join), so these are derived deterministically, never from
  // the merge graph. A declaration in a file that produced no module candidate stays uncontained.
  const CONTAINMENT_EDGE_KINDS = Object.freeze({
    symbol: 'declares_symbol', http_route: 'registers_route', sqlite_table: 'declares_table',
    sql_object: 'declares_sql_object',
  });
  for (const candidate of candidates) {
    const edgeKind = CONTAINMENT_EDGE_KINDS[candidate.fact_kind];
    if (!edgeKind) continue;
    const moduleAnchor = moduleAnchors.get(`module:${candidate.record.repo}:${candidate.record.file}`);
    if (!moduleAnchor) continue;
    const body = {
      schema: CODE_DEPENDENCY_RELATION_SCHEMA,
      code_plane_head: codePlaneHead,
      source_edge_id: `containment:${candidate.fact_id}`,
      edge_kind: edgeKind,
      from_node_id: `module:${candidate.record.repo}:${candidate.record.file}`,
      to_node_id: null,
      from_code_mention_id: moduleAnchor.mention_id,
      to_code_mention_id: candidate.mention.mention_id,
      from_fact_id: moduleAnchor.fact_id,
      to_fact_id: candidate.fact_id,
      candidate_to_node_ids: Object.freeze([]),
      status: 'resolved',
      direction: 'from_to',
      witnesses: Object.freeze([{ repo: candidate.record.repo, file: candidate.record.file,
        line: candidate.record.line }]),
      relation_plane: 'technical_dependency',
    };
    relations.push(Object.freeze({ ...body, relation_id: hashId('code-dependency-relation', body) }));
  }
  // Declared ownership. A manifest states which plugin provides a capability, publishes an
  // envelope, and exposes a route through its `owner` field, so the plugin's structure comes from
  // the estate's own declarations rather than from directory-path inference. Without these edges a
  // plugin exists as an entity nothing structural connects to.
  const pluginAnchors = new Map();
  const pluginByManifest = new Map();
  for (const candidate of candidates) {
    if (candidate.fact_kind !== 'yaml_document') continue;
    if (!/(^|\/)plugin\.yaml$/u.test(String(candidate.record.file))) continue;
    const held = {
      mention_id: candidate.mention.mention_id, fact_id: candidate.fact_id,
      file: candidate.record.file, repo: candidate.record.repo, name: candidate.record.doc_name,
    };
    pluginAnchors.set(candidate.record.doc_name, held);
    // Some declarations name their owner explicitly; others are simply written inside the
    // manifest. Where the declaration lives is itself a fact, so a manifest-resident declaration
    // is attributed to that manifest's plugin without inferring anything from directory naming.
    pluginByManifest.set(canonical([candidate.record.repo, candidate.record.file]), held);
  }
  const OWNERSHIP_EDGE_KINDS = Object.freeze({
    capability_flow: 'provides_capability', http_route: 'exposes_route',
  });
  // The envelope extractor emits `emit` for publishes_envelopes and `consume` for
  // subscribes_envelopes/subscribes_to (tools/extractors/envelopes.mjs). Preserve that
  // producer direction: treating all manifest declarations as publishes makes a subscriber
  // look like a publisher in the read-only consumers query.
  const ownershipEdgeKind = candidate => candidate.fact_kind === 'envelope_flow'
    ? ({ emit: 'publishes_envelope', consume: 'subscribes_envelope' })[candidate.record.direction]
    : OWNERSHIP_EDGE_KINDS[candidate.fact_kind];
  const ownershipCount = { start: relations.length };
  for (const candidate of candidates) {
    const edgeKind = ownershipEdgeKind(candidate);
    if (!edgeKind) continue;
    const owner = candidate.record.owner;
    const pluginAnchor = (owner ? pluginAnchors.get(owner) : null)
      || pluginByManifest.get(canonical([candidate.record.repo, candidate.record.file]));
    if (!pluginAnchor) continue;
    const body = {
      schema: CODE_DEPENDENCY_RELATION_SCHEMA,
      code_plane_head: codePlaneHead,
      source_edge_id: `declared-ownership:${candidate.fact_id}`,
      edge_kind: edgeKind,
      from_node_id: `plugin:${pluginAnchor.repo}:${pluginAnchor.name}`,
      to_node_id: null,
      from_code_mention_id: pluginAnchor.mention_id,
      to_code_mention_id: candidate.mention.mention_id,
      from_fact_id: pluginAnchor.fact_id,
      to_fact_id: candidate.fact_id,
      candidate_to_node_ids: Object.freeze([]),
      status: 'resolved',
      direction: 'from_to',
      witnesses: Object.freeze([{ repo: candidate.record.repo, file: candidate.record.file,
        line: candidate.record.line }]),
      relation_plane: 'technical_dependency',
    };
    relations.push(Object.freeze({ ...body, relation_id: hashId('code-dependency-relation', body) }));
  }
  const ownershipRelations = relations.length - ownershipCount.start;
  relations.sort((left, right) => compare(left.relation_id, right.relation_id));
  // Conservation: every merge edge yields exactly one relation record or one typed refusal, and
  // containment adds exactly one record per contained declaration with a module anchor.
  if (mergeRelationCount + refusals.length !== mergeGraph.edges.length) {
    fail('dependency-relation conservation failed: edges != relations + refusals');
  }
  const byKind = new Map();
  for (const relation of relations) {
    const key = `${relation.edge_kind}\u0000${relation.status}`;
    byKind.set(key, (byKind.get(key) || 0) + 1);
  }
  const reportBody = {
    schema: CODE_DEPENDENCY_RELATION_REPORT_SCHEMA,
    code_plane_head: codePlaneHead,
    edges: mergeGraph.edges.length,
    relations: relations.length,
    merge_relations: mergeRelationCount,
    containment_relations: relations.length - mergeRelationCount - ownershipRelations,
    declared_ownership_relations: ownershipRelations,
    refusals: refusals.length,
    anchored_both: relations.filter(row => row.from_code_mention_id && row.to_code_mention_id).length,
    anchored_one: relations.filter(row => (row.from_code_mention_id === null)
      !== (row.to_code_mention_id === null)).length,
    anchored_none: relations.filter(row => !row.from_code_mention_id && !row.to_code_mention_id).length,
    by_kind_and_status: Object.freeze(Object.fromEntries([...byKind.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([key, count]) => [key.replace('\u0000', ' | '), count]))),
  };
  return Object.freeze({
    relations: Object.freeze(relations),
    refusals: Object.freeze(refusals.sort((a, b) => compare(String(a.edge_id), String(b.edge_id)))),
    report: Object.freeze({ ...reportBody, report_digest: sha256(canonical(reportBody)) }),
  });
}

/**
 * Traversability is a read-side decision, never a stored claim: a relation may be walked only
 * when its status is resolved and BOTH endpoint mentions hold receipt-backed Referents in the
 * supplied resolution. Ambiguous, unresolved, external, and half-anchored relations are visible
 * as records but never traversable (unified section 5 firewall).
 */
export function traversableRelations({ relations, mention_resolutions: resolutions }) {
  const referentByMention = new Map((resolutions || []).map(row => [row.mention_id, row]));
  return Object.freeze((relations || []).filter(relation => {
    if (relation.status !== 'resolved') return false;
    if (!relation.from_code_mention_id || !relation.to_code_mention_id) return false;
    const from = referentByMention.get(relation.from_code_mention_id);
    const to = referentByMention.get(relation.to_code_mention_id);
    return Boolean(from?.referent_id && from?.resolution_receipt_id
      && to?.referent_id && to?.resolution_receipt_id);
  }).map(relation => Object.freeze({
    relation_id: relation.relation_id,
    edge_kind: relation.edge_kind,
    from_referent_id: referentByMention.get(relation.from_code_mention_id).referent_id,
    to_referent_id: referentByMention.get(relation.to_code_mention_id).referent_id,
    from_code_mention_id: relation.from_code_mention_id,
    to_code_mention_id: relation.to_code_mention_id,
    // The exact sites that witnessed the edge travel with it. Without them a reader can reach the
    // right endpoints and still be unable to cite a line, which the serving projection turned
    // into an honest abstention on every flow question.
    from_fact_id: relation.from_fact_id ?? null,
    to_fact_id: relation.to_fact_id ?? null,
    witnesses: Object.freeze(structuredClone(relation.witnesses ?? [])),
    ...(relation.resolution_kind ? { resolution_kind: relation.resolution_kind, match_pattern: relation.match_pattern ?? null } : {}),
  })));
}
