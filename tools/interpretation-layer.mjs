#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import {
  INTERPRETATION_DOC_SOURCES,
  INTERPRETATION_EVIDENCE_CLASS,
  INTERPRETATION_ID_PREFIX,
  INTERPRETATION_LAYER_FILE_SUFFIX,
  INTERPRETATION_LAYER_SCHEMA,
  INTERPRETATION_REFUSAL_REASONS,
  INTERPRETATION_RELATIONS,
  INTERPRETATION_SHAPE_EVIDENCE_KINDS,
  validateInterpretationRecord,
} from './annotate.mjs';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { buildCompactProjectionIndex, createProjectionRecipe, evaluateProjectionRecipe } from './projection.mjs';
import { resolveWitness } from './l1-adjudicate.mjs';
import { parseDddMapping } from './ddd-overlays.mjs';

const HELP = `Usage:
  node tools/estate-map/interpretation-layer.mjs slices   <graph.json> [--out <file>] [--json]
  node tools/estate-map/interpretation-layer.mjs packets  <graph.json> <slices.jsonl> [--out <f>]
  node tools/estate-map/interpretation-layer.mjs apply    <graph.json> <slices.jsonl> <proposals.jsonl>
                                                          --out <layer.interpretation-layer.jsonl>
                                                          [--estate <dir>] [--discovery <report.json>]
                                                          [--canon-ddd <path>] [--census <path>]
                                                          [--rejections <path>] [--now <iso>] [--model <id>]
  node tools/estate-map/interpretation-layer.mjs report   <layer.interpretation-layer.jsonl> [--json]

slices   DETERMINISTIC. Enumerate candidate slices of the assembled graph through the SHIPPED
         projection/query machinery. Each slice carries its reproducible spec, its exact member
         ids and the graph digest. No model call.
packets  DETERMINISTIC. Render one shape packet per slice — the histograms, hubs, shared edge
         kinds, envelope/capability incidence and NAME VOCABULARY the shape reader may use. The
         vocabulary shown here is the SAME set gate I5 checks against. No model call.
apply    Validate model-authored interpretations through gates I1-I6, emit the record family via
         the SHIPPED validateInterpretationRecord, and emit an unverifiable record for every
         documented concept that matched no slice. Refusals are recorded, never dropped.
report   Census a persisted interpretation layer: concepts, relationships, bindings, refusals by
         reason, doc coverage.

OUTPUT NAMING IS REQUIRED. <out> for 'apply' MUST end in '${INTERPRETATION_LAYER_FILE_SUFFIX}':
annotate.mjs merge routes by filename suffix and by nothing else.`;

export const PRODUCER = 'interpretation-layer@1';
export const ENUMERATOR_PRODUCER = 'deterministic/slice-enumerator@1';
export const SLICE_SCHEMA = 'estate-map/graph-slice/v1';
export const DEFAULT_MODEL = 'unspecified-model';
/**
 * A slice smaller than this names itself already (two modules are two modules), and one larger
 * than this exceeds the shipped raw projection bound, which would make membership an artifact of
 * where the bound truncated rather than of the spec. Both limits are recorded per skipped
 * candidate rather than applied silently.
 */
export const MIN_SLICE_MEMBERS = 4;
export const MAX_SLICE_MEMBERS = 80;

// ---------------------------------------------------------------------------
// 1. THE GRAPH DIGEST the slice witness binds to.
// ---------------------------------------------------------------------------

/**
 * Digest of exactly the STRUCTURE the enumerators read: node ids, edge tuples, the structural
 * group overlay subjects and the entity-layer entities. Deliberately NOT `merge.mjs`'s
 * `digest.txt`, which digests the whole `estate-graph.json` byte artifact — the interpretation
 * layer reads `estate-graph.annotated.json`, a different artifact, so that digest would never
 * verify against the file the enumerators actually consumed.
 *
 * `graph.interpretation_layer` is EXCLUDED on purpose: this layer's own output is merged into the
 * same artifact, and including it would change the digest at merge time and make every record
 * fail its own I3 gate on read-back.
 */
export function graphDigest(graph) {
  const nodes = (graph?.nodes || []).map(node => String(node.id)).sort();
  const edges = (graph?.edges || [])
    .map(edge => [String(edge.id), String(edge.kind), String(edge.from), edge.to ? String(edge.to) : null, (edge.candidates || []).map(String).sort()])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const structuralSubjects = (graph?.overlays || [])
    .filter(overlay => overlay?.annotation_kind === 'structural_group')
    .map(overlay => `${overlay.subject}\0${overlay.body?.group || ''}`)
    .sort();
  const entities = (graph?.entity_layer || [])
    .filter(record => record?.record_kind === 'entity_type')
    .map(record => String(record.entity))
    .sort();
  return sha256(stableStringify({ edges, entities, nodes, structural_subjects: structuralSubjects }));
}

// ---------------------------------------------------------------------------
// 2. SHAPE INDEX — the adjacency the gates and the packets both read.
// ---------------------------------------------------------------------------

const endpointsOf = edge => [edge.from, ...(edge.to ? [edge.to] : (edge.candidates || []))].filter(Boolean);
const addTo = (map, key, value) => { const set = map.get(key) || new Set(); set.add(value); map.set(key, set); };

export function buildShapeIndex(graph) {
  const byId = new Map((graph?.nodes || []).map(node => [node.id, node]));
  const adjacency = new Map(), incidentKinds = new Map(), outKinds = new Map(), inKinds = new Map(), neighboursByKind = new Map();
  for (const edge of graph?.edges || []) {
    const [from, ...targets] = endpointsOf(edge);
    if (!byId.has(from)) continue;
    for (const target of targets) {
      if (!byId.has(target)) continue;
      addTo(adjacency, from, target); addTo(adjacency, target, from);
      addTo(incidentKinds, from, edge.kind); addTo(incidentKinds, target, edge.kind);
      addTo(outKinds, `${from}\0${edge.kind}`, target); addTo(inKinds, `${target}\0${edge.kind}`, from);
      addTo(neighboursByKind, `${from}\0${edge.kind}`, target);
      addTo(neighboursByKind, `${target}\0${edge.kind}`, from);
    }
  }
  const degree = new Map([...byId.keys()].map(id => [id, (adjacency.get(id) || new Set()).size]));
  return { adjacency, byId, degree, inKinds, incidentKinds, neighboursByKind, outKinds };
}

// ---------------------------------------------------------------------------
// 3. SLICE ENUMERATORS (deterministic).
//
// Each entry names the SHIPPED machinery it reads, because "reproducible" means a later process
// re-runs the same shipped code path and not a re-implementation of it.
// ---------------------------------------------------------------------------

export const SLICE_ENUMERATORS = Object.freeze([
  Object.freeze({ id: 'E1-envelope-flow-neighborhood', uses: 'projection.mjs#evaluateProjectionRecipe (neighborhood, 1 hop, both directions)', about: 'one envelope kind with real emit AND consume traffic, plus every module on either side of it' }),
  Object.freeze({ id: 'E2-capability-closure', uses: 'projection.mjs#evaluateProjectionRecipe (neighborhood, 2 hops, both directions)', about: 'one capability type and the provide/require/call closure around it' }),
  Object.freeze({ id: 'E3-entity-members', uses: 'projection.mjs#buildCompactProjectionIndex().entityView', about: 'one schema-declared entity and the modules that witness it plus its attached envelope kinds' }),
  Object.freeze({ id: 'E4-structural-group', uses: 'projection.mjs#buildCompactProjectionIndex().aggregates.structure', about: 'one derived structural group and its members' }),
  Object.freeze({ id: 'E5-route-family', uses: 'graph.nodes query on kind=route grouped by mount_prefix', about: 'the HTTP surface mounted under one prefix' }),
  Object.freeze({ id: 'E6-high-degree-hub', uses: 'projection.mjs#evaluateProjectionRecipe (neighborhood, 1 hop, both directions) over the top-degree nodes', about: 'one high-degree hub and its immediate neighbourhood' }),
  Object.freeze({ id: 'E7-connected-component', uses: 'undirected connected components of graph.edges, excluding the giant component', about: 'a connected component below the giant one' }),
]);
const ENUMERATOR_IDS = new Set(SLICE_ENUMERATORS.map(entry => entry.id));

const slug = value => String(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const neighborhoodRecipe = (seed, hops) => createProjectionRecipe({
  kind: 'neighborhood', seeds: [seed], hops, direction: 'both', grouping: 'none', raw: true,
  bounds: { maxNodes: MAX_SLICE_MEMBERS, maxEdges: 160 }, ranking: 'id', view: 'graph',
});

/** Candidate specs, in a fixed order, before the size gate. Pure: no I/O. */
function candidateSpecs(graph, index) {
  const specs = [];
  const nodes = (graph.nodes || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // E1 — an envelope kind is a FLOW only if something emits it and something consumes it. A
  // declared-but-silent kind has no neighbourhood to interpret.
  for (const node of nodes.filter(item => item.kind === 'envelope_kind' && (item.emit_site_count || 0) > 0 && (item.consume_site_count || 0) > 0)) {
    specs.push({ enumerator: 'E1-envelope-flow-neighborhood', params: { seed: node.id }, projection: neighborhoodRecipe(node.id, 1) });
  }
  for (const node of nodes.filter(item => item.kind === 'capability')) {
    specs.push({ enumerator: 'E2-capability-closure', params: { seed: node.id }, projection: neighborhoodRecipe(node.id, 2) });
  }
  for (const entity of (index.entityView?.entities || []).slice().sort((a, b) => a.entity.localeCompare(b.entity))) {
    specs.push({ enumerator: 'E3-entity-members', params: { entity: entity.entity }, projection: null });
  }
  for (const aggregate of (index.aggregates?.structure?.nodes || []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const group = String(aggregate.id).replace(/^structure:/, '');
    if (group === '__none__') continue;
    specs.push({ enumerator: 'E4-structural-group', params: { group }, projection: null });
  }
  const prefixes = [...new Set(nodes.filter(item => item.kind === 'route').map(item => String(item.mount_prefix || '')))].filter(Boolean).sort();
  for (const prefix of prefixes) specs.push({ enumerator: 'E5-route-family', params: { mount_prefix: prefix }, projection: null });
  // E6 — the top-degree nodes. `hubCount` is part of the spec's ORDERING, not of any single
  // slice's membership, so it is not recorded in params: each hub slice is reproducible from its
  // own seed alone.
  const hubs = nodes.slice().sort((a, b) => (index.shape.degree.get(b.id) || 0) - (index.shape.degree.get(a.id) || 0) || String(a.id).localeCompare(String(b.id))).slice(0, 12);
  for (const node of hubs) specs.push({ enumerator: 'E6-high-degree-hub', params: { seed: node.id }, projection: neighborhoodRecipe(node.id, 1) });
  for (const representative of componentRepresentatives(graph, index.shape)) {
    specs.push({ enumerator: 'E7-connected-component', params: { representative }, projection: null });
  }
  return specs;
}

/** Undirected components, excluding the largest. Representative = lexicographically first member. */
function componentRepresentatives(graph, shape) {
  const seen = new Set(), components = [];
  for (const id of [...shape.byId.keys()].sort()) {
    if (seen.has(id)) continue;
    const stack = [id], members = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop();
      members.push(current);
      for (const next of [...(shape.adjacency.get(current) || new Set())].sort()) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    components.push(members.sort());
  }
  if (!components.length) return [];
  const giant = components.reduce((best, item) => item.length > best.length ? item : best, components[0]);
  return components.filter(item => item !== giant).map(item => item[0]).sort();
}

/**
 * Recompute a slice's members from its spec. THE falsifiability of the weaker evidentiary class:
 * a slice witness is only a witness because this function exists and is cheap to run.
 */
export function reproduceSlice(graph, spec, options = {}) {
  if (!ENUMERATOR_IDS.has(spec?.enumerator)) throw new Error(`unknown slice enumerator '${spec?.enumerator}'`);
  const index = options.index || buildInterpretationIndex(graph);
  const sorted = values => [...new Set(values.filter(Boolean).map(String))].sort();
  if (spec.projection) {
    const projection = evaluateProjectionRecipe(graph, index, spec.projection);
    return { members: sorted(projection.nodes.map(node => node.id)), total: projection.totalNodes };
  }
  if (spec.enumerator === 'E3-entity-members') {
    const entity = (index.entityView?.entities || []).find(item => item.entity === spec.params.entity);
    return { members: sorted(entity?.memberIds || []), total: (entity?.memberIds || []).length };
  }
  if (spec.enumerator === 'E4-structural-group') {
    const aggregate = (index.aggregates?.structure?.nodes || []).find(item => item.id === `structure:${spec.params.group}`);
    return { members: sorted(aggregate?.memberIds || []), total: aggregate?.count || 0 };
  }
  if (spec.enumerator === 'E5-route-family') {
    const members = (graph.nodes || []).filter(node => node.kind === 'route' && String(node.mount_prefix || '') === spec.params.mount_prefix).map(node => node.id);
    return { members: sorted(members), total: members.length };
  }
  const shape = index.shape, seen = new Set([spec.params.representative]), stack = [spec.params.representative];
  if (!shape.byId.has(spec.params.representative)) return { members: [], total: 0 };
  while (stack.length) {
    const current = stack.pop();
    for (const next of [...(shape.adjacency.get(current) || new Set())].sort()) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return { members: sorted([...seen]), total: seen.size };
}

/** The projection index plus the shape index, built once and shared by every phase. */
export function buildInterpretationIndex(graph) {
  const index = buildCompactProjectionIndex(graph);
  return { ...index, shape: buildShapeIndex(graph) };
}

export function enumerateSlices(graph, options = {}) {
  const index = options.index || buildInterpretationIndex(graph);
  const digest = graphDigest(graph);
  const slices = [], skipped = [];
  for (const spec of candidateSpecs(graph, index)) {
    const { members, total } = reproduceSlice(graph, spec, { index });
    const primary = spec.params.seed || spec.params.entity || spec.params.group || spec.params.mount_prefix || spec.params.representative;
    const base = { enumerator: spec.enumerator, primary, spec_hash: sha256(stableStringify(spec)) };
    if (total > MAX_SLICE_MEMBERS) { skipped.push({ ...base, reason: 'over_projection_bound', detail: `${total} candidate member(s) exceeds the shipped raw bound of ${MAX_SLICE_MEMBERS}; membership would be an artifact of truncation` }); continue; }
    if (members.length < MIN_SLICE_MEMBERS) { skipped.push({ ...base, reason: 'below_minimum_members', detail: `${members.length} member(s) is under the ${MIN_SLICE_MEMBERS}-member floor` }); continue; }
    slices.push({
      schema: SLICE_SCHEMA,
      id: `slice:${spec.enumerator}:${slug(primary)}`,
      producer: ENUMERATOR_PRODUCER,
      enumerator: spec.enumerator,
      uses: SLICE_ENUMERATORS.find(entry => entry.id === spec.enumerator).uses,
      spec, spec_hash: base.spec_hash,
      graph_digest: digest,
      members, member_count: members.length,
    });
  }
  // Two candidates can legitimately produce the SAME member set (a structural group that is also
  // a component). Keeping both would let one interpretation be counted twice, so the later id
  // is dropped and recorded — never merged into the first, which would hide the duplication.
  const byMembers = new Map(), unique = [];
  for (const slice of slices.sort((a, b) => a.id.localeCompare(b.id))) {
    const key = slice.members.join('\0');
    if (byMembers.has(key)) { skipped.push({ enumerator: slice.enumerator, primary: slice.spec.params.seed || slice.id, spec_hash: slice.spec_hash, reason: 'duplicate_member_set', detail: `identical member set to ${byMembers.get(key)}` }); continue; }
    byMembers.set(key, slice.id);
    unique.push(slice);
  }
  const rows = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byEnumerator = new Map(), skipReasons = new Map();
  for (const slice of unique) byEnumerator.set(slice.enumerator, (byEnumerator.get(slice.enumerator) || 0) + 1);
  for (const entry of skipped) skipReasons.set(entry.reason, (skipReasons.get(entry.reason) || 0) + 1);
  return {
    slices: unique,
    skipped,
    census: {
      producer: ENUMERATOR_PRODUCER,
      graph_digest: digest,
      nodes: (graph.nodes || []).length,
      slices: unique.length,
      members_total: unique.reduce((sum, slice) => sum + slice.member_count, 0),
      by_enumerator: rows(byEnumerator).map(([enumerator, count]) => ({ count, enumerator })),
      skipped_by_reason: rows(skipReasons).map(([reason, count]) => ({ count, reason })),
      enumerators: SLICE_ENUMERATORS.map(entry => ({ about: entry.about, id: entry.id, uses: entry.uses })),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. SHAPE PACKETS + the NAME VOCABULARY.
//
// The vocabulary the packet SHOWS the model is the identical set gate I5 CHECKS against
// (`sliceVocabulary` is called by both). That is deliberate: a gate that checks against a
// different set than the one the model was given is either unfair or vacuous.
// ---------------------------------------------------------------------------

const NAME_VOCABULARY_SOURCES = Object.freeze(['member_name', 'member_kind', 'edge_kind', 'envelope_kind', 'capability', 'structural_group', 'component', 'entity', 'doc_witness', 'structural_noun']);

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export const STRUCTURAL_NOUNS = Object.freeze({
  chain: 'edge_direction_split',
  closure: 'shared_capability',
  cluster: 'member_kind_histogram',
  family: 'member_kind_histogram',
  fanout: 'edge_direction_split',
  flow: 'shared_edge_kind',
  hub: 'degree_rank',
  layer: 'repo_spread',
  pipeline: 'edge_direction_split',
  ring: 'common_neighbour',
  spoke: 'degree_rank',
  surface: 'shared_edge_kind',
});

export function sliceVocabulary(graph, index, members) {
  const shape = index.shape, nodes = members.map(id => shape.byId.get(id)).filter(Boolean);
  const collect = values => [...new Set(values.filter(Boolean).map(String))].sort();
  const edgeKinds = collect(members.flatMap(id => [...(shape.incidentKinds.get(id) || new Set())]));
  const neighbours = collect(members.flatMap(id => [...(shape.adjacency.get(id) || new Set())]));
  const structuralByNode = new Map((graph.overlays || []).filter(item => item.annotation_kind === 'structural_group').map(item => [item.subject, item.body?.group]));
  const entityByMember = new Map((index.entityView?.entities || []).flatMap(entity => entity.memberIds.map(id => [id, entity.entity])));
  return {
    capability: collect([...members, ...neighbours].map(id => shape.byId.get(id)).filter(node => node?.kind === 'capability').map(node => node.name)),
    component: collect(nodes.map(node => node.repo)),
    edge_kind: edgeKinds,
    entity: collect(members.map(id => entityByMember.get(id))),
    envelope_kind: collect([...members, ...neighbours].map(id => shape.byId.get(id)).filter(node => node?.kind === 'envelope_kind').map(node => node.name)),
    member_kind: collect(nodes.map(node => node.kind)),
    member_name: collect(nodes.map(node => node.name || node.id)),
    structural_group: collect(members.map(id => structuralByNode.get(id))),
    structural_noun: Object.keys(STRUCTURAL_NOUNS),
  };
}

const histogram = values => {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
export const histogramString = values => histogram(values).map(([key, count]) => `${key}:${count}`).join(' · ');

export function buildSlicePackets(graph, slices, options = {}) {
  const index = options.index || buildInterpretationIndex(graph);
  const shape = index.shape;
  return slices.map(slice => {
    const nodes = slice.members.map(id => shape.byId.get(id)).filter(Boolean);
    const ranked = slice.members.slice().sort((a, b) => (shape.degree.get(b) || 0) - (shape.degree.get(a) || 0) || a.localeCompare(b));
    const commonNeighbours = slice.members.length
      ? [...(shape.adjacency.get(slice.members[0]) || new Set())].filter(candidate => slice.members.every(id => (shape.adjacency.get(id) || new Set()).has(candidate))).sort()
      : [];
    return {
      schema: 'estate-map/interpretation-packet/v1',
      slice_id: slice.id,
      enumerator: slice.enumerator,
      spec: slice.spec,
      spec_hash: slice.spec_hash,
      graph_digest: slice.graph_digest,
      member_count: slice.member_count,
      members: slice.members,
      shape: {
        member_kind_histogram: histogramString(nodes.map(node => String(node.kind || 'unknown'))),
        incident_edge_kind_histogram: histogramString(slice.members.flatMap(id => [...(shape.incidentKinds.get(id) || new Set())])),
        repo_spread: [...new Set(nodes.map(node => String(node.repo || 'unknown')))].sort().join(', '),
        top_by_degree: ranked.slice(0, 5).map(id => `${id} (degree ${shape.degree.get(id) || 0})`),
        common_neighbours: commonNeighbours.slice(0, 10),
        internal_edge_count: (graph.edges || []).filter(edge => { const ends = endpointsOf(edge); return ends.length > 1 && ends.every(id => slice.members.includes(id)); }).length,
      },
      name_vocabulary: sliceVocabulary(graph, index, slice.members),
    };
  });
}

// ---------------------------------------------------------------------------
// 5. GATE I4 — shape evidence, re-derived from the graph.
// ---------------------------------------------------------------------------

const kindNeighbours = (shape, id, kind) => shape.neighboursByKind.get(`${id}\0${kind}`) || new Set();

/** Re-derive ONE shape-evidence item. Returns `{ok, observed, why}`; never throws on model input. */
export function checkShapeEvidence(graph, index, members, item) {
  const shape = index.shape;
  const nodes = members.map(id => shape.byId.get(id)).filter(Boolean);
  if (item.kind === 'shared_edge_kind') {
    const missing = members.filter(id => !(shape.incidentKinds.get(id) || new Set()).has(item.value));
    return { observed: `${members.length - missing.length}/${members.length} member(s) incident to a '${item.value}' edge`, ok: missing.length === 0, why: missing.length ? `not incident to '${item.value}': ${missing.slice(0, 4).join(', ')}` : '' };
  }
  if (item.kind === 'member_kind_histogram') {
    const observed = histogramString(nodes.map(node => String(node.kind || 'unknown')));
    return { observed, ok: observed === item.value, why: observed === item.value ? '' : `claimed '${item.value}', graph says '${observed}'` };
  }
  if (item.kind === 'common_neighbour') {
    const missing = members.filter(id => id !== item.subject && !(shape.adjacency.get(id) || new Set()).has(item.subject));
    return { observed: `${members.length - missing.length}/${members.length} member(s) adjacent to ${item.subject}`, ok: shape.byId.has(item.subject) && missing.length === 0, why: !shape.byId.has(item.subject) ? `${item.subject} is not a node in this graph` : missing.length ? `not adjacent to ${item.subject}: ${missing.slice(0, 4).join(', ')}` : '' };
  }
  if (item.kind === 'degree_rank') {
    const ranked = members.slice().sort((a, b) => (shape.degree.get(b) || 0) - (shape.degree.get(a) || 0) || a.localeCompare(b));
    const position = ranked.indexOf(item.subject);
    const observed = position < 0 ? 'not a member of this slice' : `${position + 1}/${ranked.length}`;
    return { observed, ok: observed === item.value, why: observed === item.value ? '' : `claimed rank '${item.value}', graph says '${observed}'` };
  }
  if (item.kind === 'repo_spread') {
    const observed = [...new Set(nodes.map(node => String(node.repo || 'unknown')))].sort().join(', ');
    return { observed, ok: observed === item.value, why: observed === item.value ? '' : `claimed '${item.value}', graph says '${observed}'` };
  }
  if (item.kind === 'shared_envelope_kind' || item.kind === 'shared_capability') {
    const kinds = item.kind === 'shared_envelope_kind' ? ['emits', 'consumes', 'publishes_to'] : ['provides_capability', 'requires_capability', 'calls_capability'];
    const attached = members.filter(id => kinds.some(kind => kindNeighbours(shape, id, kind).has(item.subject)));
    const expected = shape.byId.get(item.subject);
    const wanted = item.kind === 'shared_envelope_kind' ? 'envelope_kind' : 'capability';
    if (expected?.kind !== wanted) return { observed: `${item.subject} is ${expected ? `kind '${expected.kind}'` : 'absent'}`, ok: false, why: `${item.kind} requires subject to be a ${wanted} node` };
    // Members that ARE the shared node itself trivially satisfy incidence; requiring every OTHER
    // member to be attached is the assertion with content.
    const others = members.filter(id => id !== item.subject);
    const missing = others.filter(id => !attached.includes(id));
    return { observed: `${others.length - missing.length}/${others.length} non-subject member(s) attached to ${item.subject} via ${kinds.join('/')}`, ok: missing.length === 0 && others.length > 0, why: missing.length ? `not attached to ${item.subject}: ${missing.slice(0, 4).join(', ')}` : others.length ? '' : 'the slice contains nothing but the subject' };
  }
  if (item.kind === 'shared_name_prefix') {
    const matching = nodes.filter(node => String(node.name || node.id).startsWith(item.subject)).length;
    const observed = `${matching}/${nodes.length}`;
    return { observed, ok: observed === item.value && matching > 0, why: observed === item.value ? (matching ? '' : `no member name starts with '${item.subject}'`) : `claimed ${item.value} member name(s) start with '${item.subject}', graph says ${observed}` };
  }
  if (item.kind === 'edge_direction_split') {
    const into = members.reduce((sum, id) => sum + (shape.inKinds.get(`${id}\0${item.subject}`) || new Set()).size, 0);
    const out = members.reduce((sum, id) => sum + (shape.outKinds.get(`${id}\0${item.subject}`) || new Set()).size, 0);
    const observed = `in=${into} out=${out}`;
    return { observed, ok: observed === item.value, why: observed === item.value ? '' : `claimed '${item.value}', graph says '${observed}'` };
  }
  return { observed: 'n/a', ok: false, why: `unknown shape-evidence kind '${item.kind}'` };
}

// ---------------------------------------------------------------------------
// 5b. GATE I7 — prose numeral backing.
// ---------------------------------------------------------------------------

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export function checkProseNumerals(prose, shapeEvidence, memberCount) {
  const allowed = new Set([String(memberCount)]);
  for (const item of shapeEvidence || []) for (const match of String(item.value ?? '').matchAll(/\d+/g)) allowed.add(match[0]);
  const problems = [];
  const scrubbed = String(prose || '').replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\S*[/\\]\S*/g, ' ');
  for (const match of scrubbed.matchAll(/\b(\d{1,3})\b/g)) {
    const value = match[1];
    if (Number(value) < 2 || allowed.has(value)) continue;
    problems.push(`the prose claims '${value}', which appears in no shape-evidence value and is not the member count (${memberCount})`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ---------------------------------------------------------------------------
// 6. GATE I5 — name discipline.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['and', 'for', 'from', 'into', 'its', 'not', 'per', 'that', 'the', 'their', 'this', 'via', 'with']);
export const normalizeToken = value => String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const significantTokens = value => [...new Set(normalizeToken(value).split(' ').filter(token => token.length >= 3 && !STOPWORDS.has(token)))].sort();

/**
 * Every significant token of the proposed name must be derivable from the slice's own vocabulary
 * (or from a doc witness the same proposal set binds). `where` must name the concrete vocabulary
 * item, so the basis is auditable rather than asserted.
 */
export function checkNameDiscipline(name, nameBasis, vocabulary, docTokens = new Set(), shapeEvidenceKinds = new Set()) {
  const problems = [], covered = new Set();
  for (const entry of nameBasis) {
    if (!NAME_VOCABULARY_SOURCES.includes(entry.source)) { problems.push(`name_basis source '${entry.source}' is not one of ${NAME_VOCABULARY_SOURCES.join(', ')}`); continue; }
    const token = normalizeToken(entry.token);
    if (entry.source === 'doc_witness') {
      if (!docTokens.has(token)) { problems.push(`name_basis token '${entry.token}' claims a doc witness, but no bound doc witness in this run contains it`); continue; }
      covered.add(token); continue;
    }
    if (entry.source === 'structural_noun') {
      const licence = STRUCTURAL_NOUNS[token];
      if (!licence) { problems.push(`'${entry.token}' is not in the frozen structural-noun vocabulary (${Object.keys(STRUCTURAL_NOUNS).join(', ')})`); continue; }
      if (entry.where !== licence) { problems.push(`structural noun '${token}' must cite its licensing evidence kind '${licence}' in 'where', not '${entry.where}'`); continue; }
      if (!shapeEvidenceKinds.has(licence)) { problems.push(`structural noun '${token}' is licensed only by a '${licence}' shape-evidence item, and this proposal carries none`); continue; }
      covered.add(token); continue;
    }
    const pool = vocabulary[entry.source] || [];
    if (!pool.includes(entry.where)) { problems.push(`name_basis where '${entry.where}' is not in the slice's ${entry.source} vocabulary`); continue; }
    if (!normalizeToken(entry.where).split(' ').some(part => part === token || part.includes(token))) { problems.push(`name_basis token '${entry.token}' does not occur in '${entry.where}'`); continue; }
    covered.add(token);
  }
  for (const token of significantTokens(name)) if (!covered.has(token)) problems.push(`name token '${token}' is not derived from anything in the slice: a name assembled from model memory is not admissible`);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// 7. DOCUMENTED CONCEPTS — the assertion side of a binding.
//
// Both sources are DETERMINISTIC parses of committed documents, each carrying the real line that
// asserts the concept: the canon entity types come from `discover-entities.mjs`'s reconciliation
// (which already resolves `design/canon/ontology.md`), and the DDD bounded contexts come from the
// SHIPPED `ddd-overlays.mjs#parseDddMapping`. Nothing here invents a documented concept.
// ---------------------------------------------------------------------------

const ONTOLOGY_WITNESS = Object.freeze({ repo: 'design', file: 'canon/ontology.md' });
const DDD_WITNESS = Object.freeze({ repo: 'design', file: 'canon/ddd-mapping.md' });
const splitWitnessPath = (value, fallback) => {
  const normalized = String(value || '').replace(/^\.\//, '');
  const match = /^([^/]+)\/(.+)$/.exec(normalized);
  return match ? { file: match[2], repo: match[1] } : { file: fallback.file, repo: fallback.repo };
};

export function documentedConcepts({ discovery = null, dddText = null } = {}) {
  const concepts = [];
  const reconciliation = discovery?.reconciliation || {};
  for (const group of ['matched', 'documented_unwitnessed']) {
    for (const row of reconciliation[group] || []) {
      const witness = splitWitnessPath(row.canon_witness?.file, ONTOLOGY_WITNESS);
      concepts.push({
        doc_source: 'canon_entity_type',
        documented_concept: String(row.canon_entity),
        witness: { ...witness, line: Number(row.canon_witness?.line || 0) },
        canon_classification: group,
      });
    }
  }
  if (dddText) {
    for (const context of parseDddMapping(dddText).contexts) {
      concepts.push({
        doc_source: 'ddd_bounded_context',
        documented_concept: context.domain,
        witness: { ...DDD_WITNESS, line: context.line },
        canon_classification: `bounded_context_of_plugin:${context.plugin}`,
      });
    }
  }
  const seen = new Set();
  return concepts.filter(item => {
    const key = `${item.doc_source}\0${item.documented_concept}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => a.doc_source.localeCompare(b.doc_source) || a.documented_concept.localeCompare(b.documented_concept));
}

// ---------------------------------------------------------------------------
// 8. APPLY — gates I1-I6, then the SHIPPED validator.
// ---------------------------------------------------------------------------

const reject = (rejections, gate, proposal, why) => { rejections.push({ gate, proposal_kind: proposal.kind, subject: proposal.slice_id || proposal.concept || proposal.from_concept || 'unknown', why }); };

export async function applyInterpretations(graph, { slices, proposals, docConcepts = [], estateRoot = process.cwd(), now = new Date().toISOString(), model = DEFAULT_MODEL, index = null } = {}) {
  const shared = index || buildInterpretationIndex(graph);
  const digest = graphDigest(graph);
  const sliceById = new Map(slices.map(slice => [slice.id, slice]));
  const records = [], rejections = [], conceptById = new Map();

  // ---- I1/I2/I3 run ONCE per cited slice: they are properties of the slice, not the proposal.
  const sliceVerdict = new Map();
  for (const slice of slices) {
    const unknown = slice.members.filter(id => !shared.shape.byId.has(id));
    if (unknown.length) { sliceVerdict.set(slice.id, { gate: 'I1-member-reality', why: `member(s) absent from graph.nodes: ${unknown.slice(0, 4).join(', ')}` }); continue; }
    if (slice.graph_digest !== digest) { sliceVerdict.set(slice.id, { gate: 'I3-digest-binding', why: `slice was computed against digest ${slice.graph_digest.slice(0, 12)} but this graph is ${digest.slice(0, 12)}` }); continue; }
    const replay = reproduceSlice(graph, slice.spec, { index: shared });
    if (replay.members.join('\0') !== slice.members.join('\0')) { sliceVerdict.set(slice.id, { gate: 'I2-slice-reproduction', why: `re-running the spec produced ${replay.members.length} member(s), not the ${slice.members.length} recorded` }); continue; }
    sliceVerdict.set(slice.id, null);
  }

  const witnessOf = slice => ({ enumerator: slice.enumerator, graph_digest: slice.graph_digest, member_count: slice.member_count, members: slice.members, slice_id: slice.id, spec: slice.spec, spec_hash: slice.spec_hash });
  const ordered = proposals.slice().sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.slice_id || a.concept || a.from_concept || '').localeCompare(String(b.slice_id || b.concept || b.from_concept || '')));

  // ---- Concepts and refusals: both are ABOUT a slice.
  for (const proposal of ordered.filter(item => item.kind === 'concept' || item.kind === 'refusal')) {
    const slice = sliceById.get(proposal.slice_id);
    if (!slice) { reject(rejections, 'I1-member-reality', proposal, `no enumerated slice with id '${proposal.slice_id}'`); continue; }
    const verdict = sliceVerdict.get(slice.id);
    if (verdict) { reject(rejections, verdict.gate, proposal, verdict.why); continue; }
    if (proposal.kind === 'refusal') {
      if (!INTERPRETATION_REFUSAL_REASONS.includes(proposal.reason)) { reject(rejections, 'schema', proposal, `refusal reason '${proposal.reason}' is outside the frozen vocabulary`); continue; }
      records.push({
        evidence_class: INTERPRETATION_EVIDENCE_CLASS, examined: proposal.examined, generated_at: now,
        id: `interpretation-refusal:${slice.id}`, kind: 'llm_annotation', model, producer: PRODUCER,
        reason: proposal.reason, reason_detail: proposal.reason_detail, record_kind: 'refusal',
        rule: 'I0-shape-reader-refusal', schema: INTERPRETATION_LAYER_SCHEMA, slice_witness: witnessOf(slice),
      });
      continue;
    }
    const vocabulary = sliceVocabulary(graph, shared, slice.members);
    const shapeProblems = [];
    for (const item of proposal.shape_evidence || []) {
      const check = checkShapeEvidence(graph, shared, slice.members, item);
      if (!check.ok) shapeProblems.push(`${item.kind}(${item.subject}): ${check.why}`);
    }
    if (!(proposal.shape_evidence || []).length) shapeProblems.push('no shape evidence offered');
    if (shapeProblems.length) { reject(rejections, 'I4-shape-evidence-grounding', proposal, shapeProblems.join(' | ')); continue; }
    const docTokens = new Set((proposal.doc_tokens || []).map(normalizeToken));
    const nameCheck = checkNameDiscipline(proposal.concept, proposal.name_basis || [], vocabulary, docTokens, new Set((proposal.shape_evidence || []).map(item => item.kind)));
    if (!nameCheck.ok) { reject(rejections, 'I5-name-discipline', proposal, nameCheck.problems.join(' | ')); continue; }
    const proseCheck = checkProseNumerals(proposal.coheres_because, proposal.shape_evidence, slice.member_count);
    if (!proseCheck.ok) { reject(rejections, 'I7-prose-numeral-backing', proposal, proseCheck.problems.join(' | ')); continue; }
    const id = `${INTERPRETATION_ID_PREFIX}${slug(proposal.concept)}`;
    if (conceptById.has(id)) { reject(rejections, 'schema', proposal, `duplicate concept id ${id}`); continue; }
    const record = {
      coheres_because: proposal.coheres_because, concept: proposal.concept,
      confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0.6,
      evidence_class: INTERPRETATION_EVIDENCE_CLASS, generated_at: now, id, kind: 'llm_annotation',
      label: proposal.label || proposal.concept, model, name_basis: proposal.name_basis,
      producer: PRODUCER, record_kind: 'concept', rule: 'I0-shape-reader-concept',
      schema: INTERPRETATION_LAYER_SCHEMA, shape_evidence: proposal.shape_evidence, slice_witness: witnessOf(slice),
    };
    conceptById.set(id, { record, slice });
    records.push(record);
  }

  // ---- Relationships: between two ACCEPTED concepts, with both slice witnesses.
  for (const proposal of ordered.filter(item => item.kind === 'relationship')) {
    const from = conceptById.get(proposal.from_concept), to = conceptById.get(proposal.to_concept);
    if (!from || !to) { reject(rejections, 'I1-member-reality', proposal, `relationship cites concept(s) that were not accepted: ${[!from && proposal.from_concept, !to && proposal.to_concept].filter(Boolean).join(', ')}`); continue; }
    if (!INTERPRETATION_RELATIONS.includes(proposal.relation)) { reject(rejections, 'schema', proposal, `relation '${proposal.relation}' is outside the frozen vocabulary`); continue; }
    const union = [...new Set([...from.slice.members, ...to.slice.members])].sort();
    const problems = [];
    for (const item of proposal.shape_evidence || []) {
      const check = checkShapeEvidence(graph, shared, union, item);
      if (!check.ok) problems.push(`${item.kind}(${item.subject}): ${check.why}`);
    }
    if (!(proposal.shape_evidence || []).length) problems.push('no shape evidence offered');
    if (problems.length) { reject(rejections, 'I4-shape-evidence-grounding', proposal, problems.join(' | ')); continue; }
    const proseCheck = checkProseNumerals(proposal.statement, proposal.shape_evidence, union.length);
    if (!proseCheck.ok) { reject(rejections, 'I7-prose-numeral-backing', proposal, proseCheck.problems.join(' | ')); continue; }
    records.push({
      confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0.6,
      evidence_class: INTERPRETATION_EVIDENCE_CLASS, from: proposal.from_concept, generated_at: now,
      id: `interpretation-relationship:${slug(proposal.relation)}:${slug(proposal.from_concept)}:${slug(proposal.to_concept)}`,
      kind: 'llm_annotation', model, producer: PRODUCER, record_kind: 'interpretation_relationship',
      relation: proposal.relation, rule: 'I0-shape-reader-relationship', schema: INTERPRETATION_LAYER_SCHEMA,
      shape_evidence: proposal.shape_evidence, slice_witnesses: [witnessOf(from.slice), witnessOf(to.slice)],
      statement: proposal.statement, to: proposal.to_concept,
    });
  }

  // ---- Bindings: BOTH witnesses, and I6 opens the doc witness at apply time.
  const docByName = new Map(docConcepts.map(item => [`${item.doc_source}\0${item.documented_concept}`, item]));
  const bound = new Set();
  for (const proposal of ordered.filter(item => item.kind === 'binding')) {
    const concept = conceptById.get(proposal.concept);
    if (!concept) { reject(rejections, 'I1-member-reality', proposal, `binding cites concept '${proposal.concept}', which was not accepted`); continue; }
    if (!INTERPRETATION_DOC_SOURCES.includes(proposal.doc_source)) { reject(rejections, 'schema', proposal, `doc_source '${proposal.doc_source}' is outside the frozen vocabulary`); continue; }
    const key = `${proposal.doc_source}\0${proposal.documented_concept}`;
    const documented = docByName.get(key);
    if (!documented && proposal.doc_source !== 'prose_text_span') { reject(rejections, 'I6-doc-witness-resolution', proposal, `'${proposal.documented_concept}' is not a documented concept of source ${proposal.doc_source} in the parsed catalogue`); continue; }
    const witness = documented ? { ...documented.witness } : { file: proposal.doc_witness?.file, line: proposal.doc_witness?.line, repo: proposal.doc_witness?.repo };
    const resolved = await resolveWitness(estateRoot, witness);
    if (!resolved.resolved) { reject(rejections, 'I6-doc-witness-resolution', proposal, `doc witness did not resolve: ${resolved.why}`); continue; }
    const quoted = String(proposal.quoted_doc || '').trim();
    if (!quoted || !resolved.text.includes(quoted)) { reject(rejections, 'I6-doc-witness-resolution', proposal, `quoted_doc ${JSON.stringify(quoted)} does not appear verbatim at ${witness.repo}/${witness.file}:${witness.line}, which reads ${JSON.stringify(resolved.text.trim().slice(0, 120))}`); continue; }
    bound.add(key);
    records.push({
      concept: proposal.concept, confidence: typeof proposal.confidence === 'number' ? proposal.confidence : 0.6,
      doc_source: proposal.doc_source, doc_witness: { ...witness, quoted_doc: quoted },
      documented_concept: proposal.documented_concept, evidence_class: INTERPRETATION_EVIDENCE_CLASS,
      generated_at: now, id: `interpretation-binding:${slug(proposal.doc_source)}:${slug(proposal.documented_concept)}:${slug(proposal.concept)}`,
      kind: 'llm_annotation', model, producer: PRODUCER, record_kind: 'doc_binding',
      rule: 'I0-shape-reader-binding', schema: INTERPRETATION_LAYER_SCHEMA, slice_witness: witnessOf(concept.slice),
    });
  }

  // ---- The unverifiable case, emitted DETERMINISTICALLY. A documented concept that matched no
  // slice is recorded as unverifiable; it is never force-matched to the nearest plausible slice.
  for (const documented of docConcepts) {
    const key = `${documented.doc_source}\0${documented.documented_concept}`;
    if (bound.has(key)) continue;
    const resolved = await resolveWitness(estateRoot, documented.witness);
    if (!resolved.resolved) { rejections.push({ gate: 'I6-doc-witness-resolution', proposal_kind: 'unverifiable_doc_concept', subject: documented.documented_concept, why: `doc witness did not resolve: ${resolved.why}` }); continue; }
    records.push({
      doc_source: documented.doc_source, doc_witness: { ...documented.witness, quoted_doc: resolved.text.trim() || documented.documented_concept },
      documented_concept: documented.documented_concept, evidence_class: INTERPRETATION_EVIDENCE_CLASS,
      examined: [
        { relation: 'slices_enumerated', target: `${slices.length} slice(s)`, value: 'no proposed concept was bound to this documented concept' },
        { relation: 'doc_source', target: documented.doc_source, value: documented.canon_classification },
      ],
      generated_at: now, id: `interpretation-unverifiable:${slug(documented.doc_source)}:${slug(documented.documented_concept)}`,
      model, producer: PRODUCER, reason_detail: `the documented concept '${documented.documented_concept}' matched no coherent slice of the assembled graph; recorded as unverifiable rather than force-matched`,
      record_kind: 'unverifiable_doc_concept', rule: 'I0-unmatched-documented-concept', schema: INTERPRETATION_LAYER_SCHEMA,
    });
  }

  // Every record goes through the SHIPPED validator before it is returned, so a schema violation
  // fails here rather than at merge time.
  const validated = records
    .map(record => validateInterpretationRecord(record, `${record.record_kind} ${record.id}`))
    .sort((a, b) => `${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  return { records: validated, rejections: rejections.sort((a, b) => a.gate.localeCompare(b.gate) || a.subject.localeCompare(b.subject)), census: censusOf(validated, { docConcepts, rejections, slices }) };
}

export function censusOf(records, { docConcepts = [], rejections = [], slices = [] } = {}) {
  const rows = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const of = kind => records.filter(record => record.record_kind === kind);
  const byReason = new Map(), byGate = new Map(), byDocSource = new Map(), boundBySource = new Map();
  for (const record of of('refusal')) byReason.set(record.reason, (byReason.get(record.reason) || 0) + 1);
  for (const entry of rejections) byGate.set(entry.gate, (byGate.get(entry.gate) || 0) + 1);
  for (const item of docConcepts) byDocSource.set(item.doc_source, (byDocSource.get(item.doc_source) || 0) + 1);
  for (const record of of('doc_binding')) boundBySource.set(record.doc_source, (boundBySource.get(record.doc_source) || 0) + 1);
  const canonTotal = docConcepts.filter(item => item.doc_source === 'canon_entity_type').length;
  const canonBound = new Set(of('doc_binding').filter(record => record.doc_source === 'canon_entity_type').map(record => record.documented_concept));
  return {
    producer: PRODUCER,
    evidence_class: INTERPRETATION_EVIDENCE_CLASS,
    slices_enumerated: slices.length,
    concepts: of('concept').length,
    relationships: of('interpretation_relationship').length,
    doc_bindings: of('doc_binding').length,
    unverifiable_doc_concepts: of('unverifiable_doc_concept').length,
    refusals: of('refusal').length,
    // The honest denominator: slices the reader ANSWERED, either way.
    refusal_rate: slices.length ? Number((of('refusal').length / slices.length).toFixed(3)) : 0,
    refusals_by_reason: rows(byReason).map(([reason, count]) => ({ count, reason })),
    rejections_by_gate: rows(byGate).map(([gate, count]) => ({ count, gate })),
    documented_concepts: rows(byDocSource).map(([source, count]) => ({ bound: boundBySource.get(source) || 0, count, source })),
    canon_entity_types: { bound: canonBound.size, total: canonTotal, unbound: canonTotal - canonBound.size, bound_names: [...canonBound].sort() },
    vocabulary: { refusal_reasons: [...INTERPRETATION_REFUSAL_REASONS], relations: [...INTERPRETATION_RELATIONS], shape_evidence_kinds: [...INTERPRETATION_SHAPE_EVIDENCE_KINDS] },
    unused_refusal_reasons: INTERPRETATION_REFUSAL_REASONS.filter(reason => !byReason.has(reason)),
  };
}

// ---------------------------------------------------------------------------
// 9. I/O + CLI.
// ---------------------------------------------------------------------------

const writeJsonl = async (file, records) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
};
const readJsonl = async file => (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
  try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`); }
});
const readJsonIfPresent = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
const readTextIfPresent = async file => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } };

export function summarize(census) {
  const lines = [`INTERPRETATION LAYER — ${census.concepts} concept(s), ${census.relationships} relationship(s), ${census.doc_bindings} doc-binding(s), ${census.refusals} refusal(s) over ${census.slices_enumerated} slice(s)`];
  lines.push(`evidence_class=${census.evidence_class}  (NOT file:line evidence — a slice witness is reproducible, not demonstrative)`);
  lines.push(`refusal rate ${(census.refusal_rate * 100).toFixed(1)}%  ·  a LOW rate here is a FINDING: a reader that never refuses is inventing structure`);
  if (census.refusals_by_reason.length) { lines.push('', 'REFUSED BY REASON'); for (const row of census.refusals_by_reason) lines.push(`  ${row.reason.padEnd(46)} ${String(row.count).padStart(4)}`); }
  if (census.rejections_by_gate.length) { lines.push('', 'REJECTED BY GATE (proposals the graph refuted)'); for (const row of census.rejections_by_gate) lines.push(`  ${row.gate.padEnd(46)} ${String(row.count).padStart(4)}`); }
  lines.push('', 'DOCUMENTED CONCEPTS');
  for (const row of census.documented_concepts) lines.push(`  ${row.source.padEnd(24)} ${String(row.bound).padStart(3)} bound / ${row.count} documented`);
  lines.push(`  canon entity types bound to real graph structure: ${census.canon_entity_types.bound}/${census.canon_entity_types.total} (${census.canon_entity_types.unbound} still unbound)`);
  if (census.unused_refusal_reasons.length) lines.push('', `UNUSED REFUSAL REASONS  ${census.unused_refusal_reasons.join(', ')}`);
  return lines.join('\n');
}

export async function produceSlices(graphPath, outPath, options = {}) {
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const result = enumerateSlices(graph, options);
  if (outPath) await writeJsonl(outPath, result.slices);
  if (options.skippedPath) await writeJsonl(options.skippedPath, result.skipped);
  return result;
}

export async function produceApply(graphPath, slicesPath, proposalsPath, outPath, options = {}) {
  if (!String(outPath).endsWith(INTERPRETATION_LAYER_FILE_SUFFIX)) {
    throw new Error(`refusing to write '${outPath}': the output MUST end in '${INTERPRETATION_LAYER_FILE_SUFFIX}' or annotate.mjs merge reads it as an annotation overlay and rejects every record`);
  }
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const slices = await readJsonl(slicesPath);
  const proposals = await readJsonl(proposalsPath);
  const estateRoot = path.resolve(options.estateRoot || process.cwd());
  const discovery = options.discoveryPath ? await readJsonIfPresent(options.discoveryPath) : null;
  const dddText = options.canonDddPath ? await readTextIfPresent(options.canonDddPath) : null;
  const docConcepts = documentedConcepts({ dddText, discovery });
  const result = await applyInterpretations(graph, { docConcepts, estateRoot, model: options.model, now: options.now, proposals, slices });
  await writeJsonl(outPath, result.records);
  if (options.rejectionsPath) await writeJsonl(options.rejectionsPath, result.rejections);
  if (options.censusPath) {
    await fs.mkdir(path.dirname(options.censusPath), { recursive: true });
    await fs.writeFile(options.censusPath, JSON.stringify(result.census, null, 2) + '\n', 'utf8');
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const command = positional[0];
    if (command === 'slices') {
      if (!positional[1]) throw new Error('slices requires <graph.json>');
      const out = options.out ? path.resolve(options.out) : null;
      const result = await produceSlices(path.resolve(positional[1]), out, { ...(options.skipped ? { skippedPath: path.resolve(options.skipped) } : {}) });
      console.log(options.json ? JSON.stringify(result.census, null, 2) : `${result.slices.length} slice(s) enumerated over digest ${result.census.graph_digest.slice(0, 12)}${out ? ` -> ${out}` : ''}\n${result.census.by_enumerator.map(row => `  ${row.enumerator.padEnd(34)} ${String(row.count).padStart(4)}`).join('\n')}\nskipped: ${result.census.skipped_by_reason.map(row => `${row.reason}=${row.count}`).join(' · ') || 'none'}`);
    } else if (command === 'packets') {
      if (!positional[1] || !positional[2]) throw new Error('packets requires <graph.json> <slices.jsonl>');
      const graph = JSON.parse(await fs.readFile(path.resolve(positional[1]), 'utf8'));
      const packets = buildSlicePackets(graph, await readJsonl(path.resolve(positional[2])));
      if (options.out) await writeJsonl(path.resolve(options.out), packets);
      console.log(`${packets.length} shape packet(s)${options.out ? ` -> ${path.resolve(options.out)}` : ''}`);
    } else if (command === 'apply') {
      if (!positional[1] || !positional[2] || !positional[3]) throw new Error('apply requires <graph.json> <slices.jsonl> <proposals.jsonl>');
      if (!options.out) throw new Error(`apply requires --out <layer${INTERPRETATION_LAYER_FILE_SUFFIX}>`);
      const result = await produceApply(path.resolve(positional[1]), path.resolve(positional[2]), path.resolve(positional[3]), path.resolve(options.out), {
        estateRoot: options.estate, model: options.model, now: options.now,
        ...(options.discovery ? { discoveryPath: path.resolve(options.discovery) } : {}),
        ...(options['canon-ddd'] ? { canonDddPath: path.resolve(options['canon-ddd']) } : {}),
        ...(options.census ? { censusPath: path.resolve(options.census) } : {}),
        ...(options.rejections ? { rejectionsPath: path.resolve(options.rejections) } : {}),
      });
      console.log(options.json ? JSON.stringify(result.census, null, 2) : summarize(result.census));
    } else if (command === 'report') {
      if (!positional[1]) throw new Error('report requires <layer.interpretation-layer.jsonl>');
      const records = (await readJsonl(path.resolve(positional[1]))).map(record => validateInterpretationRecord(record));
      const census = censusOf(records);
      console.log(options.json ? JSON.stringify(census, null, 2) : summarize(census));
    } else throw new Error(`Unknown command: ${command}`);
  } catch (error) { console.error(error.message); process.exit(1); }
}
