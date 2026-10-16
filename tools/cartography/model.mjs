// Cartography Spine v0 — the deterministic VIEW COMPILER.
//
// CORE PRINCIPLE (answer, non-negotiable): the renderer is the last and least intelligent
// stage. This module materializes every cartographic record — scope records, physical +
// semantic memberships, edge bundles, connectivity/orphan diagnostics, layout slots, and
// build-to-build changes — as persisted data. The renderer (render.mjs) and the LLM tile
// serializer (tiles.mjs) only SELECT and draw these records. No grouping, counting, edge
// routing, component computation, or membership inference happens outside this compiler.
//
// CONSERVATION FIRST (answer Q6 build order 1): buildViewModel throws a loud
// CartographyConservationError if a single estate node is UNACCOUNTED (no assignment state
// and not a documented anchor) or if the edge inventory does not close. A silent drop is a
// defect; a visible count is a feature.

import crypto from 'node:crypto';
import { stableStringify } from '../lib.mjs';
import {
  CARTOGRAPHY_SCHEMA, CARTOGRAPHY_VIEW_MODEL_VERSION, CARTOGRAPHY_LAYOUT_RULE_VERSION,
  CARTOGRAPHY_GROUPING_RULE_VERSION, CARTOGRAPHY_EVENT_CONTRACT_SCHEMA,
  CARTOGRAPHY_BUNDLE_PROJECTION_SCHEMA, CARTOGRAPHY_EVIDENCE_SUMMARY_SCHEMA,
  CARTOGRAPHY_CONTRACT_SLICE_RULE,
  CANON_RECEIPT, PLUGIN_CONTEXTS, ASSIGNMENT_STATES, CONNECTIVITY_PROJECTIONS,
  DISPLAY_FAMILIES, PROVENANCE_CLASSES, PROVENANCE_LENSES, DEFAULT_PROVENANCE_LENS,
  BUDGET_PROFILES, relationFamily, edgeProvenanceClass, eventEdgeRole,
  contextSlugForDomain, slug,
} from './canon.mjs';

export class CartographyConservationError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'CartographyConservationError';
    this.code = 'ASCRYBE_CARTOGRAPHY_UNACCOUNTED';
    this.report = report;
  }
}

const digest = value => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
const short = value => digest(value).slice(0, 12);
const byId = (a, b) => String(a).localeCompare(String(b));

// ---------------------------------------------------------------------------
// Physical placement: every node gets exactly ONE primary parent under the physical lens.
// This is the outer frame (answer Q1). Unclassifiable nodes go to a real `unplaced` scope,
// never dropped — physical placement therefore never yields UNACCOUNTED.
// ---------------------------------------------------------------------------
const PLUGIN_BY_SUB = new Map(PLUGIN_CONTEXTS.map(entry => [entry.plugin, entry]));

function nodeLocation(node) {
  const parts = String(node.id || '').split(':');
  const component = node.repo || (parts.length > 1 ? parts[1] : '') || '';
  const rel = parts.length > 2 ? parts.slice(2).join(':') : ((node.witnesses || [])[0]?.file || '');
  return { component, rel, sub: rel.split('/')[0] || '' };
}

// Returns { scope_id, zone } where zone is the L1 fixed-zone id the scope hangs under.
export function physicalScope(node) {
  const kind = node.kind;
  const { component, sub } = nodeLocation(node);
  if (kind === 'environment') return { scope_id: `scope:environment:${slug(node.name || node.id)}`, zone: 'delivery' };
  if (kind === 'tf_module' || kind === 'tf_resource') return { scope_id: 'scope:delivery', zone: 'delivery' };
  if (component === 'terraform') return { scope_id: 'scope:delivery', zone: 'delivery' };
  if (component === 'plugins') {
    if (PLUGIN_BY_SUB.has(sub)) return { scope_id: `scope:plugin:${sub}`, zone: `plugin:${sub}` };
    return { scope_id: `scope:path:plugins/${slug(sub) || 'root'}`, zone: 'engineering' };
  }
  if (component === 'src') return { scope_id: 'scope:substrate', zone: 'substrate' };
  if (component === 'client') return { scope_id: 'scope:client', zone: 'client' };
  if (component === 'scripts' || component === 'tools' || component === 'test' || component === 'test-fixtures') {
    return { scope_id: 'scope:engineering', zone: 'engineering' };
  }
  if (kind === 'repo' || kind === 'service') return { scope_id: `scope:path:${slug(node.name || component || node.id)}`, zone: 'engineering' };
  if (component) return { scope_id: `scope:path:${slug(component)}`, zone: 'engineering' };
  return { scope_id: 'scope:unplaced', zone: 'unplaced' };
}

// Preserve source witnesses; do not infer authority from naming conventions alone.
const PREPASS_MODEL_PREFIX = 'deterministic/domain-prepass@1';

function documentedDomains(graph) {
  const map = new Map();
  for (const record of graph.overlays || []) {
    if (record.annotation_kind !== 'service_card') continue;
    const domain = record.body?.domain;
    if (!domain) continue;
    if (String(record.model || '').startsWith(PREPASS_MODEL_PREFIX)) continue; // prepass-derived, not a documented anchor
    map.set(record.subject, domain);
  }
  return map;
}

export function assignmentIndex(graph) {
  const receipts = graph.domain_prepass_receipts || [];
  const bySubject = new Map(receipts.map(r => [r.subject, r]));
  const anchors = documentedDomains(graph);
  const states = new Map();
  const unaccounted = [];
  for (const node of graph.nodes || []) {
    const receipt = bySubject.get(node.id);
    if (receipt) {
      states.set(node.id, { state: receipt.status, basis: `domain_prepass:${receipt.rule_id}@${receipt.rule_version}`, domain: receipt.domain || null,
        candidates: (receipt.candidates || []).slice().sort(byId), reason: receipt.reason || null, exclusion_reason: receipt.exclusion_reason || null });
      continue;
    }
    if (anchors.has(node.id)) {
      states.set(node.id, { state: 'assigned', basis: 'documented_anchor', domain: anchors.get(node.id), candidates: [], reason: null, exclusion_reason: null });
      continue;
    }
    // Neither a receipt subject nor a documented anchor: the estate node is UNACCOUNTED.
    // This is the loud failure the answer demands (Q6 build order 1 / acceptance test A).
    states.set(node.id, { state: 'unaccounted', basis: 'none', domain: null, candidates: [], reason: null, exclusion_reason: null });
    unaccounted.push(node.id);
  }
  return { states, unaccounted, anchors };
}

// ---------------------------------------------------------------------------
// Scope records — the NEW persisted collection (answer Q1). Physical scopes own the primary
// parent; bounded-context + aggregate cores + diagnostic scopes are secondary lenses.
// ---------------------------------------------------------------------------
function scopeRecord(fields) {
  return {
    schema: CARTOGRAPHY_SCHEMA,
    scope_id: fields.scope_id,
    scope_kind: fields.scope_kind,
    label: fields.label,
    lens: fields.lens, // 'physical' | 'semantic' | 'diagnostic'
    parent_scope_id: fields.parent_scope_id ?? null,
    membership_basis: fields.membership_basis,
    membership_predicate: fields.membership_predicate,
    source_receipt: fields.source_receipt,
    layout_zone: fields.layout_zone ?? null,
    child_scope_ids: fields.child_scope_ids ?? [],
  };
}

export function buildScopes(graph, assign) {
  const scopes = new Map();
  const put = record => { if (!scopes.has(record.scope_id)) scopes.set(record.scope_id, record); return scopes.get(record.scope_id); };

  put(scopeRecord({
    scope_id: 'scope:estate', scope_kind: 'estate', label: 'Estate', lens: 'physical',
    parent_scope_id: null, membership_basis: 'root',
    membership_predicate: 'every estate node', source_receipt: CANON_RECEIPT, layout_zone: 'root',
  }));

  // Fixed L1 zone scopes (always present so the silhouette is stable even at count 0).
  for (const entry of PLUGIN_CONTEXTS) {
    put(scopeRecord({
      scope_id: `scope:plugin:${entry.plugin}`, scope_kind: 'plugin_scope', label: entry.plugin, lens: 'physical',
      parent_scope_id: 'scope:estate', membership_basis: 'physical_plugin_subtree',
      membership_predicate: `node physically located under plugins/${entry.plugin}`,
      source_receipt: CANON_RECEIPT, layout_zone: `plugin:${entry.plugin}`,
    }));
    put(scopeRecord({
      scope_id: `scope:context:${entry.context_slug}`, scope_kind: 'bounded_context', label: entry.context, lens: 'semantic',
      parent_scope_id: `scope:plugin:${entry.plugin}`, membership_basis: 'documented_domain_assignment',
      membership_predicate: `node assigned (documented or DPA-1@2) to domain "${entry.context}"`,
      source_receipt: CANON_RECEIPT, layout_zone: `context:${entry.context_slug}`,
    }));
    for (const aggregate of entry.aggregates) {
      put(scopeRecord({
        scope_id: `scope:aggregate:${entry.context_slug}:${slug(aggregate)}`, scope_kind: 'aggregate', label: aggregate, lens: 'semantic',
        parent_scope_id: `scope:context:${entry.context_slug}`, membership_basis: 'canon_catalog',
        membership_predicate: `node with a persisted module->aggregate membership receipt for "${aggregate}"`,
        source_receipt: CANON_RECEIPT, layout_zone: `aggregate:${entry.context_slug}:${slug(aggregate)}`,
      }));
    }
  }
  for (const [scope_id, label, kind, zone] of [
    ['scope:substrate', 'Substrate (event spine — non-domain)', 'substrate_scope', 'substrate'],
    ['scope:client', 'Browser client', 'client_scope', 'client'],
    ['scope:engineering', 'Engineering & tooling', 'engineering_scope', 'engineering'],
    ['scope:delivery', 'Delivery & infrastructure', 'delivery_scope', 'delivery'],
    ['scope:unplaced', 'Unplaced physical', 'path_scope', 'unplaced'],
  ]) {
    put(scopeRecord({
      scope_id, scope_kind: kind, label, lens: 'physical', parent_scope_id: 'scope:estate',
      membership_basis: 'physical_placement', membership_predicate: `node whose primary physical parent is ${scope_id}`,
      source_receipt: CANON_RECEIPT, layout_zone: zone,
    }));
  }

  // Diagnostic scopes (Unknown Frontier + status rail). Secondary lens; nodes keep their
  // physical primary parent (they remain physically locatable — answer Q3 / test C).
  for (const state of ASSIGNMENT_STATES) {
    put(scopeRecord({
      scope_id: `scope:diagnostic:${state}`, scope_kind: 'diagnostic_scope', label: `Assignment state: ${state}`, lens: 'diagnostic',
      parent_scope_id: 'scope:estate', membership_basis: 'assignment_state',
      membership_predicate: `node whose assignment state is ${state}`, source_receipt: CANON_RECEIPT, layout_zone: `diagnostic:${state}`,
    }));
  }

  // Dynamic physical scopes discovered from real nodes (path scopes, extra environments, any
  // assigned domain that resolves to no canonical context — kept honest, never dropped).
  for (const node of graph.nodes || []) {
    const phys = physicalScope(node);
    if (!scopes.has(phys.scope_id)) {
      // Dynamic physical partitions nest UNDER a fixed L1 zone (engineering / delivery), never
      // beside the ~8-10 fixed L1 cards, so the L1 silhouette + coupling DSM stay legible.
      const isEnv = phys.scope_id.startsWith('scope:environment:');
      put(scopeRecord({
        scope_id: phys.scope_id, scope_kind: isEnv ? 'environment_scope' : 'path_scope',
        label: phys.scope_id.replace(/^scope:(path|environment):/, ''), lens: 'physical',
        parent_scope_id: isEnv ? 'scope:delivery' : 'scope:engineering',
        membership_basis: 'lexical_path_prefix', membership_predicate: `node whose primary physical parent is ${phys.scope_id}`,
        source_receipt: { rule: 'deterministic-physical-partition', version: '1' }, layout_zone: 'engineering',
      }));
    }
    const info = assign.states.get(node.id);
    if (info && info.state === 'assigned' && info.domain) {
      const cslug = contextSlugForDomain(info.domain);
      const contextId = `scope:context:${cslug}`;
      if (!scopes.has(contextId)) {
        put(scopeRecord({
          scope_id: contextId, scope_kind: 'bounded_context', label: info.domain, lens: 'semantic',
          parent_scope_id: 'scope:estate', membership_basis: 'documented_domain_assignment',
          membership_predicate: `node assigned to domain "${info.domain}" (no canonical plugin binding)`,
          source_receipt: { rule: 'domain-assignment', version: '1' }, layout_zone: 'context:other',
        }));
      }
    }
  }

  // Populate child_scope_ids deterministically.
  const list = [...scopes.values()];
  for (const scope of list) {
    scope.child_scope_ids = list.filter(s => s.parent_scope_id === scope.scope_id).map(s => s.scope_id).sort(byId);
  }
  return new Map(list.sort((a, b) => byId(a.scope_id, b.scope_id)).map(s => [s.scope_id, s]));
}

// ---------------------------------------------------------------------------
// Memberships — one row per node: physical primary parent + optional semantic context scope.
// ---------------------------------------------------------------------------
export function buildMemberships(graph, assign, scopes) {
  const rows = [];
  for (const node of (graph.nodes || []).slice().sort((a, b) => byId(a.id, b.id))) {
    const phys = physicalScope(node);
    const info = assign.states.get(node.id);
    let semantic = null;
    if (info && info.state === 'assigned' && info.domain) {
      const contextId = `scope:context:${contextSlugForDomain(info.domain)}`;
      if (scopes.has(contextId)) semantic = contextId;
    }
    const row = {
      node_id: node.id, node_kind: node.kind || 'unknown', label: node.name || node.id,
      primary_scope_id: phys.scope_id, primary_lens: 'physical',
      semantic_scope_id: semantic, assignment_state: info?.state || 'unaccounted',
      assignment_basis: info?.basis || 'none', domain: info?.domain || null,
      candidates: info?.candidates || [], reason: info?.reason || null, exclusion_reason: info?.exclusion_reason || null,
    };
    row.assignment_disposition = assignmentDispositionOf(row);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Edge bundles + not-shown accounting. Every edge maps to a relation family; endpoints map to
// their L1 scope; the bundle key is (source_scope, target_scope, relation_family). The L1
// active projection is event_incidence rolled through the substrate spine; every other edge is
// counted in a named not-shown bucket. Conservation closes: active + not_shown == edge total.
// ---------------------------------------------------------------------------
const edgeTargets = edge => edge.to ? [edge.to] : Array.isArray(edge.candidates) ? edge.candidates : [];

function scopeOfNode(nodeId, physicalByNode, nodeKindById) {
  // envelope_kind nodes live on the substrate event spine regardless of witness path.
  if (nodeKindById.get(nodeId) === 'envelope_kind') return 'scope:substrate';
  return physicalByNode.get(nodeId) || null;
}

// bundle_uid (answer Q5 DEFECT): the STABLE LOGICAL identity of a bundle — sha256 over
// (source_scope, target_scope, relation_family, projection_id, grouping_rule_version) ONLY.
// It deliberately EXCLUDES the member-edge set so adding one edge does NOT change the id.
// The sorted member-edge set lives in member_set_digest (content identity). This is the direct
// correction to v0, which hashed the complete member list into the bundle id.
const BASE_BUNDLE_PROJECTION = 'all';
function bundleUid(source_scope_id, target_scope_id, relation_family, projection_id = BASE_BUNDLE_PROJECTION) {
  return `bundle:${short({ s: source_scope_id, t: target_scope_id ?? null, f: relation_family, p: projection_id, g: CARTOGRAPHY_GROUPING_RULE_VERSION })}`;
}
function memberSetDigest(sortedMemberIds) {
  return digest(sortedMemberIds.slice().sort(byId));
}

export function buildEdgeBundles(graph, memberships) {
  const physicalByNode = new Map(memberships.map(m => [m.node_id, m.primary_scope_id]));
  const nodeKindById = new Map((graph.nodes || []).map(n => [n.id, n.kind]));
  const bundles = new Map();
  const unmapped = new Set();
  let totalEdges = 0;
  const addMember = (src, dst, family, memberId, meta) => {
    const key = `${src}\u0000${dst}\u0000${family}`;
    const bundle = bundles.get(key) || { source_scope_id: src, target_scope_id: dst, relation_family: family, members: [] };
    bundle.members.push({ member_id: memberId, ...meta });
    bundles.set(key, bundle);
  };
  for (const edge of (graph.edges || []).slice().sort((a, b) => byId(a.id, b.id))) {
    const family = relationFamily(edge.kind);
    if (family === 'other') unmapped.add(edge.kind);
    const provenance = edgeProvenanceClass(edge);
    const role = eventEdgeRole(edge.kind);
    const meta = { provenance, role, edge_id: edge.id, edge_kind: edge.kind, status: edge.status || null,
      idiom: edge.idiom || null, from: edge.from };
    for (const target of edgeTargets(edge)) {
      totalEdges += 1;
      const src = scopeOfNode(edge.from, physicalByNode, nodeKindById);
      const dst = scopeOfNode(target, physicalByNode, nodeKindById);
      addMember(src, dst, family, `${edge.id}->${target}`, { ...meta, target });
    }
    if (!edgeTargets(edge).length) {
      // targetless edge: still an inventory member accounted under its family's not-shown bucket.
      totalEdges += 1;
      const src = scopeOfNode(edge.from, physicalByNode, nodeKindById);
      addMember(src, '(targetless)', family, `${edge.id}->(targetless)`, { ...meta, target: null });
    }
  }
  // Reconcile the '(targetless)' sentinel key to a null target_scope_id record (as v0 did).
  const records = [];
  const memberMetaByUid = new Map();
  const entries = [...bundles.values()]
    .sort((a, b) => byId(`${a.source_scope_id}${a.target_scope_id}${a.relation_family}`, `${b.source_scope_id}${b.target_scope_id}${b.relation_family}`));
  for (const bundle of entries) {
    const targetScope = bundle.target_scope_id === '(targetless)' ? null : bundle.target_scope_id;
    const members = bundle.members.slice().sort((a, b) => byId(a.member_id, b.member_id));
    const ids = members.map(m => m.member_id);
    const bundle_uid = bundleUid(bundle.source_scope_id, targetScope, bundle.relation_family);
    memberMetaByUid.set(bundle_uid, members);
    records.push({
      schema: CARTOGRAPHY_SCHEMA,
      bundle_uid,
      bundle_id: bundle_uid, // v0 compat: bundle_id now equals the STABLE bundle_uid.
      projection_id: BASE_BUNDLE_PROJECTION,
      grouping_rule_version: CARTOGRAPHY_GROUPING_RULE_VERSION,
      source_scope_id: bundle.source_scope_id, target_scope_id: targetScope,
      relation_family: bundle.relation_family, exact_edge_count: ids.length, member_edge_ids: ids,
      member_set_digest: memberSetDigest(ids),
      expansion_address: `estate://cartography/bundle/${bundle_uid}`,
    });
  }
  return { bundles: records, edge_total: totalEdges, unmapped_edge_kinds: [...unmapped].sort(), memberMetaByUid };
}

// ---------------------------------------------------------------------------
// PROVENANCE-PARTITIONED edge-bundle projections (answer Q1). One record per (source scope,
// target scope, relation family) carrying counts_by_provenance (emits/consumes/total per class),
// distinct_contract_count, and member_edge_ids_by_provenance. The renderer SELECTS the Runtime
// (production) counts as the default and NEVER filters/counts edges itself.
// ---------------------------------------------------------------------------
export function buildEdgeBundleProjections(edgeResult, graph, buildId) {
  const nodeKindById = new Map((graph.nodes || []).map(n => [n.id, n.kind]));
  const records = [];
  for (const bundle of edgeResult.bundles) {
    const members = edgeResult.memberMetaByUid.get(bundle.bundle_uid) || [];
    const counts_by_provenance = {};
    const idsByProvenance = {};
    for (const cls of PROVENANCE_CLASSES) { counts_by_provenance[cls] = { emits: 0, consumes: 0, total: 0 }; idsByProvenance[cls] = []; }
    const productionContracts = new Set();
    for (const m of members) {
      const cls = counts_by_provenance[m.provenance] ? m.provenance : 'unknown';
      counts_by_provenance[cls].total += 1;
      if (m.role === 'emits') counts_by_provenance[cls].emits += 1;
      else if (m.role === 'consumes') counts_by_provenance[cls].consumes += 1;
      idsByProvenance[cls].push(m.member_id);
      // distinct contracts = distinct envelope_kind endpoints touched by a PRODUCTION event edge.
      if (cls === 'production' && bundle.relation_family === 'event_incidence') {
        for (const endpoint of [m.from, m.target]) {
          if (endpoint && nodeKindById.get(endpoint) === 'envelope_kind') productionContracts.add(endpoint);
        }
      }
    }
    for (const cls of PROVENANCE_CLASSES) idsByProvenance[cls] = idsByProvenance[cls].sort(byId);
    records.push({
      schema: CARTOGRAPHY_BUNDLE_PROJECTION_SCHEMA,
      bundle_uid: bundle.bundle_uid,
      source_scope_id: bundle.source_scope_id,
      target_scope_id: bundle.target_scope_id,
      relation_family: bundle.relation_family,
      distinct_contract_count: productionContracts.size,
      counts_by_provenance,
      member_edge_ids_by_provenance: idsByProvenance,
      member_set_digest: bundle.member_set_digest,
      logical_address: `estate://cartography/bundle/${bundle.bundle_uid}`,
      expansion_address: `estate://cartography@${buildId}/bundle/${bundle.bundle_uid}/runtime`,
    });
  }
  return records.sort((a, b) => byId(a.bundle_uid, b.bundle_uid));
}

// ---------------------------------------------------------------------------
// Connectivity + orphan diagnostics per scope per named projection. Orphan is always qualified
// by projection; containment edges are excluded from architectural orphan calc.
// ---------------------------------------------------------------------------
export function buildDiagnostics(graph, memberships) {
  const physicalByNode = new Map(memberships.map(m => [m.node_id, m.primary_scope_id]));
  const nodesByScope = new Map();
  for (const m of memberships) { const list = nodesByScope.get(m.primary_scope_id) || []; list.push(m.node_id); nodesByScope.set(m.primary_scope_id, list); }
  const records = [];
  for (const projection of CONNECTIVITY_PROJECTIONS) {
    const kinds = new Set(projection.edge_kinds);
    // Build adjacency restricted to this projection's edge kinds.
    const adjacency = new Map();
    const degree = new Map();
    for (const edge of graph.edges || []) {
      if (!kinds.has(edge.kind)) continue;
      for (const target of edgeTargets(edge)) {
        for (const [a, b] of [[edge.from, target], [target, edge.from]]) {
          const set = adjacency.get(a) || new Set(); set.add(b); adjacency.set(a, set);
          degree.set(a, (degree.get(a) || 0) + 1);
        }
      }
    }
    for (const [scopeId, nodeIds] of [...nodesByScope.entries()].sort((a, b) => byId(a[0], b[0]))) {
      const inScope = new Set(nodeIds);
      // Connected components within the scope under this projection.
      const seen = new Set();
      let components = 0;
      const orphans = [];
      for (const nodeId of [...nodeIds].sort(byId)) {
        if ((degree.get(nodeId) || 0) === 0) orphans.push(nodeId);
      }
      for (const nodeId of [...nodeIds].sort(byId)) {
        if (seen.has(nodeId)) continue;
        // Only count components among non-orphan, in-scope-connected nodes.
        if ((degree.get(nodeId) || 0) === 0) { seen.add(nodeId); continue; }
        components += 1;
        const stack = [nodeId];
        while (stack.length) {
          const cur = stack.pop();
          if (seen.has(cur)) continue; seen.add(cur);
          for (const nb of adjacency.get(cur) || []) if (inScope.has(nb) && !seen.has(nb)) stack.push(nb);
        }
      }
      let internal = 0, inbound = 0, outbound = 0;
      for (const edge of graph.edges || []) {
        if (!kinds.has(edge.kind)) continue;
        for (const target of edgeTargets(edge)) {
          const fromIn = inScope.has(edge.from), toIn = inScope.has(target);
          if (fromIn && toIn) internal += 1;
          else if (fromIn && !toIn) outbound += 1;
          else if (!fromIn && toIn) inbound += 1;
        }
      }
      records.push({
        schema: CARTOGRAPHY_SCHEMA, scope_id: scopeId, projection_id: projection.id, projection_label: projection.label,
        node_count: nodeIds.length, internal_edge_count: internal, inbound_edge_count: inbound, outbound_edge_count: outbound,
        connected_components: components, orphan_count: orphans.length, orphan_node_ids: orphans.sort(byId),
      });
    }
  }
  return records.sort((a, b) => byId(`${a.scope_id}${a.projection_id}`, `${b.scope_id}${b.projection_id}`));
}

// ---------------------------------------------------------------------------
// Layout slots — fixed L1 zones + persistent per-parent child slots. Reuses prior slots so a
// new child never reshuffles the world; removed children tombstone within the layout epoch.
// ---------------------------------------------------------------------------
export function buildLayoutSlots(scopes, memberships, priorViewModel, buildId) {
  const priorSlots = new Map((priorViewModel?.layout_slots || []).map(s => [`${s.view_id}\u0000${s.child_id}`, s]));
  const priorEpoch = priorViewModel?.layout_epoch || 1;
  const layoutEpoch = priorEpoch; // v0 uses a single stable epoch; compaction would bump it.
  const slots = [];
  const assignSlots = (view_id, childIds) => {
    const live = new Set(childIds);
    const used = new Set();
    // 1) existing children retain their slots
    for (const childId of childIds.slice().sort(byId)) {
      const prior = priorSlots.get(`${view_id}\u0000${childId}`);
      if (prior && Number.isInteger(prior.slot_index)) {
        slots.push({ schema: CARTOGRAPHY_SCHEMA, view_id, parent_scope_id: view_id, child_id: childId,
          slot_index: prior.slot_index, first_seen_build: prior.first_seen_build, last_seen_build: buildId,
          layout_epoch: layoutEpoch, layout_rule_version: CARTOGRAPHY_LAYOUT_RULE_VERSION, state: 'live' });
        used.add(prior.slot_index);
      }
    }
    // 2) new children get the next unused slot indices in canonical order
    let next = 0;
    const nextFree = () => { while (used.has(next)) next += 1; used.add(next); return next; };
    for (const childId of childIds.slice().sort(byId)) {
      if (slots.some(s => s.view_id === view_id && s.child_id === childId)) continue;
      const index = nextFree();
      slots.push({ schema: CARTOGRAPHY_SCHEMA, view_id, parent_scope_id: view_id, child_id: childId,
        slot_index: index, first_seen_build: buildId, last_seen_build: buildId,
        layout_epoch: layoutEpoch, layout_rule_version: CARTOGRAPHY_LAYOUT_RULE_VERSION, state: 'live' });
    }
    // 3) removed children tombstone within the epoch
    for (const [key, prior] of priorSlots) {
      if (!key.startsWith(`${view_id}\u0000`)) continue;
      if (live.has(prior.child_id)) continue;
      slots.push({ schema: CARTOGRAPHY_SCHEMA, view_id, parent_scope_id: view_id, child_id: prior.child_id,
        slot_index: prior.slot_index, first_seen_build: prior.first_seen_build, last_seen_build: prior.last_seen_build,
        layout_epoch: layoutEpoch, layout_rule_version: CARTOGRAPHY_LAYOUT_RULE_VERSION, state: 'tombstone' });
    }
  };
  // L1: children of estate. L2+: children of every scope with children (deterministic).
  for (const scope of [...scopes.values()].sort((a, b) => byId(a.scope_id, b.scope_id))) {
    if (scope.child_scope_ids.length) assignSlots(scope.scope_id, scope.child_scope_ids);
  }
  // Node-level slots inside physical leaf scopes (so adding one module only adds one slot).
  const nodesByScope = new Map();
  for (const m of memberships) { const list = nodesByScope.get(m.primary_scope_id) || []; list.push(m.node_id); nodesByScope.set(m.primary_scope_id, list); }
  for (const [scopeId, nodeIds] of [...nodesByScope.entries()].sort((a, b) => byId(a[0], b[0]))) assignSlots(scopeId, nodeIds);
  return { slots: slots.sort((a, b) => byId(`${a.view_id}${String(a.slot_index).padStart(6, '0')}${a.child_id}`, `${b.view_id}${String(b.slot_index).padStart(6, '0')}${b.child_id}`)), layout_epoch: layoutEpoch };
}

// ---------------------------------------------------------------------------
// Build-to-build change records: SOURCE (node/edge add/remove), SEMANTIC (assignment
// transition), VIEW (layout epoch). Consumes the prior view-model only.
// ---------------------------------------------------------------------------
export function buildChanges(graph, memberships, priorViewModel, layoutEpoch) {
  if (!priorViewModel) return [];
  const changes = [];
  const priorNodes = new Set((priorViewModel.memberships || []).map(m => m.node_id));
  const nowNodes = new Set(memberships.map(m => m.node_id));
  for (const id of [...nowNodes].filter(x => !priorNodes.has(x)).sort(byId)) changes.push({ schema: CARTOGRAPHY_SCHEMA, change_class: 'SOURCE', kind: 'add', node_id: id });
  for (const id of [...priorNodes].filter(x => !nowNodes.has(x)).sort(byId)) changes.push({ schema: CARTOGRAPHY_SCHEMA, change_class: 'SOURCE', kind: 'remove', node_id: id });
  const priorState = new Map((priorViewModel.memberships || []).map(m => [m.node_id, m.assignment_state]));
  for (const m of memberships.slice().sort((a, b) => byId(a.node_id, b.node_id))) {
    const before = priorState.get(m.node_id);
    if (before && before !== m.assignment_state) changes.push({ schema: CARTOGRAPHY_SCHEMA, change_class: 'SEMANTIC', kind: 'assignment_transition', node_id: m.node_id, from: before, to: m.assignment_state });
  }
  if ((priorViewModel.layout_epoch || 1) !== layoutEpoch) changes.push({ schema: CARTOGRAPHY_SCHEMA, change_class: 'VIEW', kind: 'layout_epoch', from: priorViewModel.layout_epoch || 1, to: layoutEpoch });
  return changes;
}

// ---------------------------------------------------------------------------
// Descent-context selection (answer Q6 step 5): the context with the highest count of distinct
// incident envelope_kind records among its assigned members; tie-break by assigned node count,
// then canonical context order. Deterministic and seedless. This is a projection over persisted
// records, computed here so the renderer only SELECTS the chosen chain.
// ---------------------------------------------------------------------------
export function selectDescentContext(graph, memberships) {
  const nodeKindById = new Map((graph.nodes || []).map(n => [n.id, n.kind]));
  const semanticMembers = new Map();
  for (const m of memberships) {
    if (!m.semantic_scope_id) continue;
    const list = semanticMembers.get(m.semantic_scope_id) || []; list.push(m.node_id); semanticMembers.set(m.semantic_scope_id, list);
  }
  const incidentEnvelopes = new Map(); // scope_id -> Set(envelope node ids)
  for (const edge of graph.edges || []) {
    if (edge.kind !== 'emits' && edge.kind !== 'consumes') continue;
    const endpoints = [edge.from, ...edgeTargets(edge)];
    const envelope = endpoints.find(e => nodeKindById.get(e) === 'envelope_kind');
    if (!envelope) continue;
    for (const endpoint of endpoints) {
      const membership = memberships.find(m => m.node_id === endpoint);
      const scopeId = membership?.semantic_scope_id;
      if (!scopeId) continue;
      const set = incidentEnvelopes.get(scopeId) || new Set(); set.add(envelope); incidentEnvelopes.set(scopeId, set);
    }
  }
  const contexts = [...new Set(memberships.filter(m => m.semantic_scope_id).map(m => m.semantic_scope_id))]
    .sort(byId)
    .map(scopeId => ({
      scope_id: scopeId,
      distinct_envelope_kinds: (incidentEnvelopes.get(scopeId) || new Set()).size,
      assigned_node_count: (semanticMembers.get(scopeId) || []).length,
    }));
  const canonicalOrder = new Map(PLUGIN_CONTEXTS.map((entry, index) => [`scope:context:${entry.context_slug}`, index]));
  contexts.sort((a, b) => (b.distinct_envelope_kinds - a.distinct_envelope_kinds)
    || (b.assigned_node_count - a.assigned_node_count)
    || ((canonicalOrder.get(a.scope_id) ?? 99) - (canonicalOrder.get(b.scope_id) ?? 99))
    || byId(a.scope_id, b.scope_id));
  return { chosen: contexts[0] || null, ranking: contexts };
}

// Unknown Frontier groupings (answer Q3 / Q6 step 4). Ambiguity groups by candidate-set
// signature + reason; no_anchor / ineligible_subject group by physical scope -> node kind.
// Grouping is a compiler responsibility: the renderer must never group.
export function buildUnknownFrontier(memberships) {
  const ambiguous = memberships.filter(m => m.assignment_state === 'ambiguous');
  const ambGroups = new Map();
  for (const m of ambiguous) {
    const signature = `${(m.candidates || []).join('|')}\u0000${m.reason || ''}`;
    const group = ambGroups.get(signature) || { signature, candidates: m.candidates || [], reason: m.reason || null, node_ids: [] };
    group.node_ids.push(m.node_id); ambGroups.set(signature, group);
  }
  const groupBy = (state) => {
    const map = new Map();
    for (const m of memberships.filter(x => x.assignment_state === state)) {
      const key = `${m.primary_scope_id}\u0000${m.node_kind}`;
      const group = map.get(key) || { physical_scope_id: m.primary_scope_id, node_kind: m.node_kind, node_ids: [] };
      group.node_ids.push(m.node_id); map.set(key, group);
    }
    return [...map.values()].map(g => ({ ...g, node_ids: g.node_ids.sort(byId), count: g.node_ids.length }))
      .sort((a, b) => byId(`${a.physical_scope_id}${a.node_kind}`, `${b.physical_scope_id}${b.node_kind}`));
  };
  return {
    ambiguous_groups: [...ambGroups.values()].map(g => ({ ...g, node_ids: g.node_ids.sort(byId), count: g.node_ids.length }))
      .sort((a, b) => byId(a.signature, b.signature)),
    no_anchor_groups: groupBy('no_anchor'),
    ineligible_subject_groups: groupBy('ineligible_subject'),
    fixture_only_groups: groupBy('fixture_only'),
  };
}

// L1 ancestor (child-of-estate) of any scope, for the top-level coupling DSM.
function l1Ancestor(scopeId, scopeById) {
  let cur = scopeById.get(scopeId);
  while (cur && cur.parent_scope_id && cur.parent_scope_id !== 'scope:estate') cur = scopeById.get(cur.parent_scope_id);
  return cur ? cur.scope_id : scopeId;
}

// L1 directional coupling matrix over top-level scopes, per display family (answer Q6 step 6).
export function buildCouplingMatrix(edgeBundles, scopes) {
  const scopeById = new Map(scopes instanceof Map ? scopes : scopes.map(s => [s.scope_id, s]));
  // L1 = the fixed physical-lens zones directly under the estate (the ~8-10 top-level scopes).
  // Diagnostic/semantic children of the estate are excluded so the DSM stays at estate scale.
  const l1Scopes = [...scopeById.values()].filter(s => s.parent_scope_id === 'scope:estate' && s.lens === 'physical').map(s => s.scope_id).sort(byId);
  const cells = new Map();
  for (const bundle of edgeBundles) {
    if (!bundle.target_scope_id) continue;
    const src = l1Ancestor(bundle.source_scope_id, scopeById);
    const dst = l1Ancestor(bundle.target_scope_id, scopeById);
    const key = `${src}\u0000${dst}\u0000${bundle.relation_family}`;
    cells.set(key, (cells.get(key) || 0) + bundle.exact_edge_count);
  }
  const matrix = [];
  for (const [key, count] of [...cells.entries()].sort((a, b) => byId(a[0], b[0]))) {
    const [source_scope_id, target_scope_id, relation_family] = key.split('\u0000');
    matrix.push({ schema: CARTOGRAPHY_SCHEMA, source_scope_id, target_scope_id, relation_family, exact_edge_count: count });
  }
  return { l1_scopes: l1Scopes, cells: matrix };
}

// ---------------------------------------------------------------------------
// EVENT CONTRACT SLICES (answer Q7 + Q1 — the highest-payoff change). One persisted record per
// (envelope_node_id, provenance projection). envelope_kind becomes the identity-bearing,
// addressable event unit: emitters → named envelope → consumers. Role-separated emit/consume
// edge ids, emitter/consumer scopes, incidence + distinct counts, status/idiom breakdowns,
// member_set_digest, derivation, and both logical + build-pinned addresses. This replaces v0's
// single undifferentiated substrate-bus count and populates the empty L3 spine column.
// ---------------------------------------------------------------------------
export function buildEventContractSlices(graph, memberships, buildId) {
  const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
  const physicalByNode = new Map(memberships.map(m => [m.node_id, m.primary_scope_id]));
  // Group event edges by (envelope, provenance).
  const groups = new Map();
  for (const edge of (graph.edges || [])) {
    const role = eventEdgeRole(edge.kind);
    if (!role) continue;
    const endpoints = [edge.from, ...edgeTargets(edge)];
    const envelope = endpoints.find(e => nodeById.get(e)?.kind === 'envelope_kind');
    if (!envelope) continue;
    const moduleEndpoint = edge.from === envelope ? (edgeTargets(edge)[0] || null) : edge.from;
    const provenance = edgeProvenanceClass(edge);
    const key = `${envelope}\u0000${provenance}`;
    const group = groups.get(key) || { envelope, provenance, members: [] };
    group.members.push({ edge_id: edge.id, role, module: moduleEndpoint,
      status: edge.status || null, idiom: edge.idiom || null });
    groups.set(key, group);
  }
  const records = [];
  for (const group of [...groups.values()].sort((a, b) => byId(`${a.envelope}${a.provenance}`, `${b.envelope}${b.provenance}`))) {
    const emit = group.members.filter(m => m.role === 'emits');
    const consume = group.members.filter(m => m.role === 'consumes');
    const emit_edge_ids = emit.map(m => m.edge_id).sort(byId);
    const consume_edge_ids = consume.map(m => m.edge_id).sort(byId);
    const emitter_scopes = [...new Set(emit.map(m => physicalByNode.get(m.module)).filter(Boolean))].sort(byId);
    const consumer_scopes = [...new Set(consume.map(m => physicalByNode.get(m.module)).filter(Boolean))].sort(byId);
    const status_breakdown = {};
    const idiom_breakdown = {};
    for (const m of group.members) {
      const s = m.status || 'unspecified'; status_breakdown[s] = (status_breakdown[s] || 0) + 1;
      const i = m.idiom || 'unspecified'; idiom_breakdown[i] = (idiom_breakdown[i] || 0) + 1;
    }
    const memberIds = [...emit_edge_ids, ...consume_edge_ids].sort(byId);
    const envelopeName = nodeById.get(group.envelope)?.name || group.envelope;
    records.push({
      schema: CARTOGRAPHY_EVENT_CONTRACT_SCHEMA,
      envelope_node_id: group.envelope,
      envelope_name: envelopeName,
      projection_id: group.provenance,
      build_id: buildId,
      emit_edge_ids, consume_edge_ids,
      emitter_scopes, consumer_scopes,
      counts: {
        emit_incidence_count: emit.length,
        consume_incidence_count: consume.length,
        distinct_emitter_count: emitter_scopes.length,
        distinct_consumer_count: consumer_scopes.length,
      },
      status_breakdown, idiom_breakdown,
      member_set_digest: digest(memberIds),
      derivation: { rule: CARTOGRAPHY_CONTRACT_SLICE_RULE, witness_edge_ids: memberIds },
      logical_address: `estate://cartography/event-contract/${group.envelope}`,
      address: `estate://cartography@${buildId}/event-contract/${group.envelope}/${group.provenance}`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// EVIDENCE SUMMARIES (answer Q2) — a COMPILER-SIDE bounded evidence index per addressable
// subject, NOT a renderer expand. Channels are kept epistemically SEPARATE (never flattened):
// estate witnesses, receipt subject_witnesses, annotation grounded_in, derivation evidence +
// examined_edge_ids, packet evidence_pointers, refusal evidence. canonical_preview uses the
// two-stage ordering rule; exact total/included/omitted/member_set_digest/continuation carried.
// For semantic-assignment subjects, decision receipts + grounded_in PRECEDE raw estate witnesses.
// ---------------------------------------------------------------------------
const EVIDENCE_PREVIEW_ORDER = ['production', 'docs', 'test', 'fixture', 'unknown'];
const PREVIEW_BUDGETS = { summary: 4, standard: 12, deep: 60 };
function witnessProvenance(w) {
  const v = w && w.provenance_class;
  return PROVENANCE_CLASSES.includes(v) ? v : 'unknown';
}
function canonicalWitnessRows(witnesses, buildId) {
  // Deterministic two-stage ordering: (1) one row from every nonempty bucket in
  // production→docs→test→fixture→unknown order; (2) round-robin over buckets, each sorted by
  // (repo,file,line,source_record_id,role).
  const buckets = new Map(EVIDENCE_PREVIEW_ORDER.map(c => [c, []]));
  for (const w of witnesses) {
    const cls = witnessProvenance(w);
    const row = { repo: w.repo || '', file: w.file || '', line: w.line ?? 0, provenance_class: cls,
      source_record_id: w.source_record_id || `${w.repo || ''}:${w.file || ''}:${w.line ?? 0}`,
      roles: w.roles || [] };
    row.witness_address = `estate://cartography@${buildId}/witness/${short(row)}`;
    (buckets.get(cls) || buckets.get('unknown')).push(row);
  }
  for (const c of EVIDENCE_PREVIEW_ORDER) {
    buckets.get(c).sort((a, b) => byId(
      `${a.repo}\u0000${a.file}\u0000${String(a.line).padStart(9, '0')}\u0000${a.source_record_id}\u0000${(a.roles || []).join(',')}`,
      `${b.repo}\u0000${b.file}\u0000${String(b.line).padStart(9, '0')}\u0000${b.source_record_id}\u0000${(b.roles || []).join(',')}`));
  }
  const ordered = [];
  const cursors = new Map(EVIDENCE_PREVIEW_ORDER.map(c => [c, 0]));
  // Stage 1: one from each nonempty bucket in order.
  for (const c of EVIDENCE_PREVIEW_ORDER) {
    const list = buckets.get(c);
    if (list.length) { ordered.push(list[0]); cursors.set(c, 1); }
  }
  // Stage 2: round-robin the remainder.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const c of EVIDENCE_PREVIEW_ORDER) {
      const list = buckets.get(c); const idx = cursors.get(c);
      if (idx < list.length) { ordered.push(list[idx]); cursors.set(c, idx + 1); progressed = true; }
    }
  }
  return ordered;
}
export function buildEvidenceSummaries(graph, assign, buildId) {
  const overlaysBySubject = new Map();
  for (const o of graph.overlays || []) {
    const list = overlaysBySubject.get(o.subject) || []; list.push(o); overlaysBySubject.set(o.subject, list);
  }
  const receiptsBySubject = new Map((graph.domain_prepass_receipts || []).map(r => [r.subject, r]));
  const refusalsBySubject = new Map();
  for (const r of graph.refusals || []) {
    const subj = r.subject || r.subject_id; if (!subj) continue;
    const list = refusalsBySubject.get(subj) || []; list.push(r); refusalsBySubject.set(subj, list);
  }
  const packetsBySubject = new Map();
  for (const p of graph.candidate_packets || []) {
    const subj = p.subject || p.subject_id; if (!subj) continue;
    const list = packetsBySubject.get(subj) || []; list.push(p); packetsBySubject.set(subj, list);
  }
  const records = [];
  for (const node of (graph.nodes || []).slice().sort((a, b) => byId(a.id, b.id))) {
    const witnesses = node.witnesses || [];
    const total = Number.isInteger(node._witnesses_total) ? node._witnesses_total : witnesses.length;
    const by_provenance = {};
    for (const cls of PROVENANCE_CLASSES) by_provenance[cls] = { occurrences: 0, unique_locations: 0 };
    const seenLoc = new Map(PROVENANCE_CLASSES.map(c => [c, new Set()]));
    for (const w of witnesses) {
      const cls = witnessProvenance(w);
      by_provenance[cls].occurrences += 1;
      seenLoc.get(cls).add(`${w.repo || ''}:${w.file || ''}:${w.line ?? 0}`);
    }
    for (const cls of PROVENANCE_CLASSES) by_provenance[cls].unique_locations = seenLoc.get(cls).size;
    const info = assign.states.get(node.id);
    const receipt = receiptsBySubject.get(node.id);
    const overlays = overlaysBySubject.get(node.id) || [];
    // Channel separation — epistemically different evidence kept in distinct fields.
    const channels = {
      witnesses_total: witnesses.length,
      subject_witnesses: [], // node subjects carry none; receipt subjects would populate this
      grounded_in: overlays.flatMap(o => (o.grounded_in || o.body?.grounded_in || [])),
      derivation_evidence: receipt ? (receipt.evidence || []) : [],
      examined_edge_ids: receipt ? (receipt.examined_edge_ids || []) : [],
      evidence_pointers: (packetsBySubject.get(node.id) || []).flatMap(p => p.evidence_pointers || []),
      refusal_evidence: (refusalsBySubject.get(node.id) || []).map(r => ({ rule: r.rule || r.rule_id || null,
        searched_scope: r.searched_scope || r.searched_over || null, code: r.code || r.reason || null })),
    };
    // For a semantic-assignment subject the decision receipt + grounded_in PRECEDE raw witnesses.
    const isSemanticAssignment = info && (info.state === 'assigned' || info.state === 'no_anchor' || info.state === 'ambiguous');
    const allRows = canonicalWitnessRows(witnesses, buildId);
    const previewBudgets = {};
    for (const profile of BUDGET_PROFILES) {
      const cap = PREVIEW_BUDGETS[profile.id] ?? PREVIEW_BUDGETS.deep;
      previewBudgets[profile.id] = allRows.slice(0, cap);
    }
    records.push({
      schema: CARTOGRAPHY_EVIDENCE_SUMMARY_SCHEMA,
      subject_id: node.id,
      subject_kind: node.kind || 'unknown',
      subject_logical_address: `estate://cartography/node/${node.id}`,
      subject_address: `estate://cartography@${buildId}/node/${node.id}`,
      total_occurrences: total,
      unique_locations: [...new Set(witnesses.map(w => `${w.repo || ''}:${w.file || ''}:${w.line ?? 0}`))].length,
      by_provenance,
      primary_witness_class: node.primary_witness_class || 'unknown',
      channels,
      decision_first: !!isSemanticAssignment,
      ordering_rule: 'provenance-coverage-then-canonical/v1',
      canonical_preview: previewBudgets.standard,
      preview_by_profile: previewBudgets,
      preview_included: previewBudgets.standard.length,
      preview_omitted: Math.max(0, total - previewBudgets.standard.length),
      member_set_digest: digest(allRows.map(r => r.witness_address).sort(byId)),
      continuation_address: `estate://cartography@${buildId}/node/${node.id}/witnesses?after=${previewBudgets.standard.length}`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// ASSIGNMENT DISPOSITION (answer Q4) — presentation projection that distinguishes documented_anchor
// / deterministic_rule_assignment / ratified_neural_assignment / ambiguous / no_anchor /
// ineligible_subject / fixture_only / unaccounted. v0's compiler recorded the basis but the
// renderer collapsed both assigned bases into one segment; this splits them for honest reporting.
// The canonical status vocabulary (ASSIGNMENT_STATES) is unchanged.
// ---------------------------------------------------------------------------
export function assignmentDispositionOf(membership) {
  const state = membership.assignment_state;
  const basis = membership.assignment_basis || 'none';
  if (state === 'assigned') {
    if (basis === 'documented_anchor') return 'documented_anchor';
    if (basis.startsWith('domain_prepass:')) return 'deterministic_rule_assignment';
    if (basis.startsWith('ratified_neural')) return 'ratified_neural_assignment';
    return 'deterministic_rule_assignment';
  }
  return state; // ambiguous | no_anchor | ineligible_subject | fixture_only | unaccounted
}
export function buildAssignmentDisposition(memberships) {
  const keys = ['documented_anchor', 'deterministic_rule_assignment', 'ratified_neural_assignment',
    'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only', 'unaccounted'];
  const disposition = Object.fromEntries(keys.map(k => [k, 0]));
  for (const m of memberships) {
    const d = assignmentDispositionOf(m);
    disposition[d] = (disposition[d] || 0) + 1;
  }
  return disposition;
}

// ---------------------------------------------------------------------------
// DISPOSITION LEDGER (answer Q4 — the honest zero). TWO permanent denominators: epistemic
// accounting (n/n subjects have an explicit disposition) AND domain-map coverage
// (documented/applicable-or-open). ineligible + fixture_only shown ALONGSIDE (never below the
// fold), each expandable by exclusion_reason + rule + version. The deterministic zero renders as
// a PRECISION result, not "0% coverage". Build-over-build progress is expressed as state
// transitions, never a net percentage.
// ---------------------------------------------------------------------------
function ruleVersionFromBasis(basis) {
  const m = /^domain_prepass:(.+)@(.+)$/.exec(basis || '');
  return m ? { rule: m[1], version: m[2] } : { rule: null, version: null };
}
export function buildDispositionLedger(memberships, disposition, changes, graph = {}) {
  const total = memberships.length;
  const accounted = memberships.filter(m => m.assignment_state !== 'unaccounted').length;
  const documented = disposition.documented_anchor;
  const ruleAssigned = disposition.deterministic_rule_assignment + disposition.ratified_neural_assignment;
  const applicable_or_open = disposition.documented_anchor + disposition.deterministic_rule_assignment
    + disposition.ratified_neural_assignment + disposition.ambiguous + disposition.no_anchor;
  const pct = whole => whole > 0 ? Math.round((documented / whole) * 1000) / 10 : 0;
  // Expandable exclusion groups (anti-denominator-engineering): every excluded subject stays
  // enumerable by exclusion_reason + rule id + version.
  const exclusionMap = new Map();
  for (const m of memberships) {
    if (m.assignment_state !== 'ineligible_subject' && m.assignment_state !== 'fixture_only') continue;
    const rv = ruleVersionFromBasis(m.assignment_basis);
    const reason = m.exclusion_reason || 'unspecified';
    const key = `${m.assignment_state}\u0000${reason}\u0000${rv.rule}\u0000${rv.version}`;
    const group = exclusionMap.get(key) || { assignment_state: m.assignment_state, exclusion_reason: reason,
      rule: rv.rule, version: rv.version, node_ids: [] };
    group.node_ids.push(m.node_id); exclusionMap.set(key, group);
  }
  const exclusions = [...exclusionMap.values()]
    .map(g => ({ ...g, node_ids: g.node_ids.sort(byId), count: g.node_ids.length }))
    .sort((a, b) => byId(`${a.assignment_state}${a.exclusion_reason}`, `${b.assignment_state}${b.exclusion_reason}`));
  // Build-over-build progress as STATE TRANSITIONS, not a net percentage.
  const TRANSITION = {
    'no_anchor\u0000assigned': 'no_anchor->ratified',
    'no_anchor\u0000ineligible_subject': 'no_anchor->confirmed_non_domain',
    'no_anchor\u0000ambiguous': 'no_anchor->ambiguous',
    'ambiguous\u0000assigned': 'ambiguous->ratified',
  };
  const transitions = [];
  for (const c of (changes || [])) {
    if (c.change_class !== 'SEMANTIC' || c.kind !== 'assignment_transition') continue;
    transitions.push({ node_id: c.node_id, from: c.from, to: c.to,
      transition: TRANSITION[`${c.from}\u0000${c.to}`] || `${c.from}->${c.to}` });
  }
  for (const c of (changes || [])) {
    if (c.change_class !== 'SOURCE') continue;
    transitions.push({ node_id: c.node_id, transition: c.kind === 'add' ? 'new_applicable_subject' : 'removed_applicable_subject' });
  }
  const ruleVersion = ruleVersionFromBasis(memberships.find(m => (m.assignment_basis || '').startsWith('domain_prepass:'))?.assignment_basis);
  const ruleLabel = ruleVersion.rule ? `${ruleVersion.rule}@${ruleVersion.version}` : 'DPA-1@2';
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const receiptsBySubject = new Map((graph.domain_prepass_receipts || []).map(r => [r.subject, r]));
  let unsupported_admitted = 0;
  for (const m of memberships) {
    if (m.assignment_state !== 'assigned') continue;
    if (!(m.assignment_basis || '').startsWith('domain_prepass:')) continue;
    const receipt = receiptsBySubject.get(m.node_id);
    const hasEvidence = !!receipt && Array.isArray(receipt.evidence) && receipt.evidence.length > 0;
    const examinedEdges = !!receipt && Array.isArray(receipt.examined_edge_ids) && receipt.examined_edge_ids.length > 0;
    if (!hasEvidence && !examinedEdges) unsupported_admitted += 1;
  }
  return {
    schema: CARTOGRAPHY_SCHEMA,
    epistemic_accounting: { accounted, total, statement: `${accounted} / ${total} subjects have an explicit disposition` },
    domain_map_coverage: {
      documented, applicable_or_open, coverage_pct: pct(applicable_or_open),
      open: disposition.ambiguous + disposition.no_anchor,
      open_pct: applicable_or_open > 0 ? Math.round(((disposition.ambiguous + disposition.no_anchor) / applicable_or_open) * 1000) / 10 : 0,
      rule_assigned: ruleAssigned,
      statement: `${documented} / ${applicable_or_open} applicable-or-open subjects documented = ${pct(applicable_or_open)}%`,
    },
    alongside: {
      ineligible_subject: disposition.ineligible_subject,
      fixture_only: disposition.fixture_only,
      unaccounted: disposition.unaccounted,
    },
    assignment_disposition: disposition,
    // The deterministic zero as a PRECISION statement, never "0% coverage".
    deterministic_zero: {
      rule: ruleLabel,
      new_assignments: disposition.deterministic_rule_assignment,
      left_open: disposition.no_anchor,
      unsupported_admitted,
      statement: `${ruleLabel} EXPANSION — ${disposition.deterministic_rule_assignment} new assignments / ${disposition.no_anchor} subjects correctly left open / ${unsupported_admitted} unsupported assignments admitted`,
    },
    exclusions,
    transitions: transitions.sort((a, b) => byId(a.node_id, b.node_id)),
  };
}

// ---------------------------------------------------------------------------
// Conservation gate — closes the node/edge model and throws loudly on UNACCOUNTED.
// ---------------------------------------------------------------------------
export function conservationReport(graph, memberships, assign, edgeResult, scopes) {
  const estateTotal = (graph.nodes || []).length;
  const byState = Object.fromEntries(ASSIGNMENT_STATES.map(s => [s, memberships.filter(m => m.assignment_state === s).length]));
  const physicalCounts = {};
  for (const m of memberships) physicalCounts[m.primary_scope_id] = (physicalCounts[m.primary_scope_id] || 0) + 1;
  const physicalTotal = Object.values(physicalCounts).reduce((a, b) => a + b, 0);
  const stateTotal = Object.values(byState).reduce((a, b) => a + b, 0);
  const activeFamily = 'event_incidence';
  const active = edgeResult.bundles.filter(b => b.relation_family === activeFamily);
  const notShown = edgeResult.bundles.filter(b => b.relation_family !== activeFamily);
  const activeCount = active.reduce((a, b) => a + b.exact_edge_count, 0);
  const notShownCount = notShown.reduce((a, b) => a + b.exact_edge_count, 0);
  const notShownByFamily = {};
  for (const b of notShown) notShownByFamily[b.relation_family] = (notShownByFamily[b.relation_family] || 0) + b.exact_edge_count;

  const failures = [];
  if (assign.unaccounted.length) failures.push({ code: 'UNACCOUNTED', detail: `${assign.unaccounted.length} estate node(s) have no assignment state and are not documented anchors`, node_ids: assign.unaccounted.slice(0, 50) });
  if (stateTotal !== estateTotal) failures.push({ code: 'STATE_TOTAL_MISMATCH', detail: `assignment states total ${stateTotal} != estate node total ${estateTotal}` });
  if (physicalTotal !== estateTotal) failures.push({ code: 'PHYSICAL_TOTAL_MISMATCH', detail: `physical membership total ${physicalTotal} != estate node total ${estateTotal}` });
  const multiParent = memberships.filter(m => Array.isArray(m.primary_scope_id));
  if (multiParent.length) failures.push({ code: 'MULTI_PRIMARY_PARENT', detail: `${multiParent.length} node(s) have more than one primary parent under the active lens` });
  if (activeCount + notShownCount !== edgeResult.edge_total) failures.push({ code: 'EDGE_TOTAL_MISMATCH', detail: `active(${activeCount}) + not_shown(${notShownCount}) != edge total ${edgeResult.edge_total}` });
  for (const m of memberships) if (!scopes.has(m.primary_scope_id)) failures.push({ code: 'MISSING_SCOPE', detail: `membership references unknown scope ${m.primary_scope_id}`, node_id: m.node_id });
  // Containment: a node may sit inside a bounded-context (semantic) core only if it is actually
  // assigned. An ambiguous / no_anchor / ineligible node claimed as a context member is a
  // containment violation and must fail the build, never be silently placed (test B/C).
  for (const m of memberships) {
    if (m.semantic_scope_id && m.assignment_state !== 'assigned') {
      failures.push({ code: 'CONTAINMENT_VIOLATION', detail: `node ${m.node_id} is in semantic scope ${m.semantic_scope_id} but its assignment state is ${m.assignment_state}`, node_id: m.node_id });
    }
  }

  return {
    schema: CARTOGRAPHY_SCHEMA, passed: failures.length === 0,
    estate_node_total: estateTotal, edge_total: edgeResult.edge_total,
    assignment_states: byState, assignment_state_total: stateTotal,
    physical_membership_total: physicalTotal, physical_counts: physicalCounts,
    edge_projection: { active_family: activeFamily, active_edge_count: activeCount, not_shown_edge_count: notShownCount, not_shown_by_family: notShownByFamily },
    unmapped_edge_kinds: edgeResult.unmapped_edge_kinds || [],
    unaccounted_node_ids: assign.unaccounted.slice().sort(byId),
    failures,
  };
}

// ---------------------------------------------------------------------------
// buildViewModel — the single shared view-model. THROWS on conservation failure before any
// downstream (human HTML or LLM tiles) can be produced.
// ---------------------------------------------------------------------------
export function buildViewModel(graph, { priorViewModel = null, generatedAt = '2026-07-28T00:00:00Z', estateDigest = null } = {}) {
  const buildIdSeed = { estate_digest: estateDigest, nodes: (graph.nodes || []).length, edges: (graph.edges || []).length, generated_at: generatedAt };
  const buildId = `build:${short(buildIdSeed)}`;
  const assign = assignmentIndex(graph);
  const scopes = buildScopes(graph, assign);
  const memberships = buildMemberships(graph, assign, scopes);
  const edgeResult = buildEdgeBundles(graph, memberships);
  const conservation = conservationReport(graph, memberships, assign, edgeResult, scopes);
  if (!conservation.passed) {
    throw new CartographyConservationError(`cartography conservation failed: ${conservation.failures.map(f => f.code).join(', ')}`, conservation);
  }
  const diagnostics = buildDiagnostics(graph, memberships);
  const { slots, layout_epoch } = buildLayoutSlots(scopes, memberships, priorViewModel, buildId);
  const changes = buildChanges(graph, memberships, priorViewModel, layout_epoch);
  const descent = selectDescentContext(graph, memberships);
  const coupling = buildCouplingMatrix(edgeResult.bundles, scopes);
  const unknown_frontier = buildUnknownFrontier(memberships);
  const edge_bundle_projections = buildEdgeBundleProjections(edgeResult, graph, buildId);
  const event_contract_slices = buildEventContractSlices(graph, memberships, buildId);
  // Test-only-contracts diagnostic strip (answer Q1): envelope kinds with NO production incidence.
  const envelopesWithProduction = new Set(event_contract_slices.filter(s => s.projection_id === 'production').map(s => s.envelope_node_id));
  const test_only_contracts = [...new Set(event_contract_slices
    .filter(s => (s.projection_id === 'test' || s.projection_id === 'fixture') && !envelopesWithProduction.has(s.envelope_node_id))
    .map(s => s.envelope_node_id))].sort(byId);
  const evidence_summaries = buildEvidenceSummaries(graph, assign, buildId);
  const assignment_disposition = buildAssignmentDisposition(memberships);
  const disposition_ledger = buildDispositionLedger(memberships, assignment_disposition, changes, graph);

  const model = {
    schema: CARTOGRAPHY_SCHEMA,
    view_model_version: CARTOGRAPHY_VIEW_MODEL_VERSION,
    layout_rule_version: CARTOGRAPHY_LAYOUT_RULE_VERSION,
    layout_epoch,
    taxonomy_epoch: 1,
    generated_at: generatedAt,
    estate_digest: estateDigest,
    canon_receipt: CANON_RECEIPT,
    conservation,
    scopes: [...scopes.values()],
    memberships,
    edge_bundles: edgeResult.bundles,
    display_families: DISPLAY_FAMILIES,
    provenance_lenses: PROVENANCE_LENSES,
    default_provenance_lens: DEFAULT_PROVENANCE_LENS,
    edge_bundle_projections,
    event_contract_slices,
    test_only_contracts,
    evidence_summaries,
    assignment_disposition,
    disposition_ledger,
    diagnostics,
    layout_slots: slots,
    changes,
    descent,
    coupling,
    unknown_frontier,
  };
  // build_id and digest are last so they cover the whole deterministic content.
  model.build_id = buildId;
  model.digest = digest({ ...model, build_id: undefined, digest: undefined });
  return model;
}

export { digest as cartographyDigest };
