#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { parseArgs, sha256, stableStringify, writeJson, writeJsonLines } from './lib.mjs';
import { EVIDENCE_CLASSES, EVIDENCE_CLASS_ORDER, buildEvidenceIndex, recordsFor, witnessText } from './evidence.mjs';
import { refusalCensus } from './query.mjs';
import { renderRefusal, routeRefusal, routingSummary } from './refusal-routing.mjs';
import { buildInterpretationIndex, enumerateSlices, graphDigest, reproduceSlice } from './interpretation-layer.mjs';

export const AGENT_PROJECTION_PRODUCER = 'deterministic/agent-projection@1';
export const BRIEF_SCHEMA = 'estate-map/estate-brief/v1';
export const COMMUNITY_SUMMARY_SCHEMA = 'estate-map/community-summary/v1';
export const RESOURCE_MANIFEST_SCHEMA = 'estate-map/resource-manifest/v1';
export const ASSEMBLED_SUBJECT_SCHEMA = 'estate-map/assembled-subject/v1';
export const RESOURCE_URI_SCHEME = 'estate';
export const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00Z';

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export const COMMUNITY_PROSE_POLICY = Object.freeze({
  authored_here: 'deterministic_composition_only',
  model_prose: 'carried_from_interpretation_layer_only',
  carried_records_are_revalidated: 'slice witness must reproduce against THIS graph digest (gate C3)',
});

/** Why a community got no summary. Frozen: an unlisted reason cannot be emitted. */
export const COMMUNITY_REFUSAL_REASONS = Object.freeze([
  'no_member_resolves_to_a_graph_node',
  'no_member_carries_a_witness',
  'members_below_summary_floor',
  'no_relation_or_shared_basis_among_members',
  'carried_interpretation_does_not_reproduce',
]);

/** Community sources, in composition order. Level 0 is the estate; level 2 hangs off level 1. */
export const COMMUNITY_SOURCES = Object.freeze([
  Object.freeze({ id: 'documented-domain', level: 1, basis: 'graph.overlays[annotation_kind=service_card].body.domain', about: 'a bounded context canon actually documents' }),
  Object.freeze({ id: 'entity-family', level: 1, basis: 'graph.entity_layer[record_kind=entity_type] + [record_kind=relationship]', about: 'the schema-declared entity model' }),
  Object.freeze({ id: 'structural-group', level: 1, basis: 'graph.overlays[annotation_kind=structural_group].body.group', about: 'a fact about file layout, NEVER a business domain' }),
  Object.freeze({ id: 'slice', level: 2, basis: 'interpretation-layer.mjs#enumerateSlices', about: 'one reproducible graph slice from the shipped enumerators' }),
]);
const SOURCE_LEVEL = Object.freeze(Object.fromEntries(COMMUNITY_SOURCES.map(entry => [entry.id, entry.level])));

/** Fewer members than this and there is nothing to summarise that listing them would not say. */
export const SUMMARY_MEMBER_FLOOR = 2;
/** How many exemplars a summary may name before it stops being a summary. */
export const EXEMPLAR_CAP = 6;

const list = value => (Array.isArray(value) ? value.filter(Boolean) : []);
const uniqueSorted = values => [...new Set(values.filter(value => value !== undefined && value !== null && value !== '').map(String))].sort();
const rows = map => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
const countBy = values => { const map = new Map(); for (const value of values) map.set(value, (map.get(value) || 0) + 1); return map; };
const histogramText = values => rows(countBy(values)).map(([key, count]) => `${key}:${count}`).join(' · ');
const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%');

// ---------------------------------------------------------------------------
// 1. SUBJECT INDEX + ALIASES — defect (b).
// ---------------------------------------------------------------------------

/**
 * Aliases for one graph node. The estate's families genuinely disagree about how to name the
 * same thing — `capability:batch` the node, `batch` the capability type, `entity:batch` the entity,
 * `batch` the entity name — and a consumer that must learn which spelling each family uses has
 * not been given an index. Aliases are DERIVED from the node's own fields; nothing is guessed.
 */
export function nodeAliases(node) {
  if (!node) return [];
  const aliases = [node.id];
  if (node.name) aliases.push(node.name);
  if (node.kind === 'capability') aliases.push(`entity:${node.name}`, `capability:${node.name}`);
  // NOT the envelope NAMESPACE. Aliasing `parcel_order.accepted` to `parcel_order` was tried and
  // reverted: it made the namespace subject resolve to a very large subject and edge set, which is
  // defect (c) — the signal drowned in bulk — reintroduced by the fix for defect (b). A
  // namespace is a QUERY over subjects, not a subject; ask for the full kind name or the node id.
  if (node.kind === 'route' && node.owner) aliases.push(node.owner);
  if (node.kind === 'repo' || node.kind === 'service' || node.kind === 'coverage') aliases.push(node.repo);
  return uniqueSorted(aliases);
}

/**
 * The subject -> everything index. Keys are every alias any family uses for a subject; values
 * are the canonical subject ids that alias reaches. One alias may reach several subjects (the
 * plugin name `widget-engine` names a repo node AND owns routes), so the value is a LIST and the
 * caller is told, rather than one being silently picked.
 */
export function buildSubjectIndex(graph) {
  const evidence = buildEvidenceIndex(graph);
  const nodesById = new Map(list(graph.nodes).map(node => [node.id, node]));
  const aliasToSubjects = new Map();
  const addAlias = (alias, subject) => {
    if (!alias || !subject) return;
    const key = String(alias).toLowerCase();
    const bucket = aliasToSubjects.get(key) || new Set();
    bucket.add(subject);
    aliasToSubjects.set(key, bucket);
  };
  for (const node of nodesById.values()) for (const alias of nodeAliases(node)) addAlias(alias, node.id);
  // Entity-layer subjects are entity NAMES, not node ids; they are first-class subjects in their
  // own right (`entity:parcel_order` has no graph node at all — that is expected).
  for (const record of list(graph.entity_layer)) {
    if (record.record_kind === 'entity_type') { addAlias(record.entity, record.id); addAlias(record.id, record.id); addAlias(record.label, record.id); }
  }
  for (const record of list(graph.interpretation_layer)) {
    if (record.record_kind === 'concept') { addAlias(record.id, record.id); addAlias(record.label, record.id); addAlias(record.concept, record.id); }
  }
  // Manifest wiring keys by owning plugin and by declared subject string; both are how a reader
  // asks the question ("what did widget-engine declare?", "who declares parcel_order_management?").
  for (const record of list(graph.manifest_wiring)) { addAlias(record.owner, `wiring-owner:${record.owner}`); addAlias(record.subject, record.id); }
  const edgesBySubject = new Map();
  for (const edge of list(graph.edges)) {
    const targets = edge.to ? [edge.to] : list(edge.candidates);
    for (const [id, direction] of [[edge.from, 'out'], ...targets.map(target => [target, 'in'])]) {
      if (!id) continue;
      const bucket = edgesBySubject.get(id) || [];
      bucket.push({ direction, edge });
      edgesBySubject.set(id, bucket);
    }
  }
  return { evidence, nodesById, aliasToSubjects, edgesBySubject, graph };
}

/**
 * Resolve a caller's term to canonical subject id(s). Returns the term unchanged as a single
 * candidate when nothing matches, so `assembleSubject` can report an honest empty rather than
 * throwing — "nothing is known about X" is a real answer and the map should be able to give it.
 */
export function resolveSubject(index, term) {
  const raw = String(term ?? '').trim();
  const exact = index.nodesById.has(raw) ? [raw] : [];
  const viaAlias = [...(index.aliasToSubjects.get(raw.toLowerCase()) || new Set())].sort();
  const resolved = uniqueSorted([...exact, ...viaAlias]);
  return { term: raw, resolved, matched: resolved.length > 0, ambiguous: resolved.length > 1 };
}

const witnessRow = witness => ({ repo: witness.repo || '', file: witness.file || 'unknown', line: witness.line ?? null, provenance_class: witness.provenance_class || null, cite: witnessText(witness) });

/**
 * ONE CALL RETURNS EVERYTHING KNOWN ABOUT A SUBJECT. The single most-requested fix.
 *
 * Every returned item has the SAME five load-bearing fields — `family`, `record_kind`,
 * `evidence_class`, `statement`, `witnesses` — regardless of which of the eleven record families
 * it came from, so a consumer writes ONE reader. The family-specific record is preserved
 * verbatim under `record` for a consumer that wants it, but nothing in the normalised envelope
 * requires reading it.
 */
export function assembleSubject(graph, term, options = {}) {
  const index = options.index || buildSubjectIndex(graph);
  const resolution = resolveSubject(index, term);
  const keys = resolution.matched ? resolution.resolved : [String(term ?? '')];
  const aliasKeys = uniqueSorted([
    ...keys,
    ...keys.flatMap(key => nodeAliases(index.nodesById.get(key))),
    // An entity id and its bare name are the same subject to the reader; the families disagree.
    ...keys.map(key => key.replace(/^entity:/, '')),
  ]);
  const records = recordsFor(index.evidence, aliasKeys).map(item => ({
    family: item.family,
    record_kind: item.values?.record || item.family,
    id: item.id,
    evidence_class: item.evidenceClass,
    evidence_label: EVIDENCE_CLASSES[item.evidenceClass].label,
    statement: item.subtitle ? `${item.title} — ${item.subtitle}` : item.title,
    fields: item.values,
    witnesses: item.witnesses.map(witnessRow),
    record: item.raw,
  }));
  const seenEdges = new Set();
  const edges = keys.flatMap(key => (index.edgesBySubject.get(key) || []))
    .filter(entry => { const id = `${entry.direction}\0${entry.edge.id}`; if (seenEdges.has(id)) return false; seenEdges.add(id); return true; })
    .map(entry => ({
      direction: entry.direction,
      kind: entry.edge.kind,
      other: entry.direction === 'out' ? (entry.edge.to || null) : entry.edge.from,
      candidates: list(entry.edge.candidates),
      status: entry.edge.status || null,
      provenance_class: entry.edge.provenance_class || null,
      witnesses: list(entry.edge.witnesses).map(witnessRow),
      record: entry.edge,
    }))
    .sort((a, b) => a.direction.localeCompare(b.direction) || a.kind.localeCompare(b.kind) || String(a.other).localeCompare(String(b.other)));
  const nodes = keys.map(key => index.nodesById.get(key)).filter(Boolean);
  const byFamily = {};
  for (const item of records) byFamily[item.family] = (byFamily[item.family] || 0) + 1;
  const byClass = {};
  for (const item of records) byClass[item.evidence_class] = (byClass[item.evidence_class] || 0) + 1;
  return {
    schema: ASSEMBLED_SUBJECT_SCHEMA,
    producer: AGENT_PROJECTION_PRODUCER,
    subject: {
      term: resolution.term,
      resolved: resolution.resolved,
      matched: resolution.matched,
      ambiguous: resolution.ambiguous,
      aliases: aliasKeys,
      kinds: uniqueSorted(nodes.map(node => node.kind)),
      names: uniqueSorted(nodes.map(node => node.name)),
    },
    nodes,
    edges,
    records,
    counts: { nodes: nodes.length, edges: edges.length, records: records.length, by_family: byFamily, by_evidence_class: byClass },
    // A subject with records but no witness anywhere is exactly the kind of thing an agent must
    // not quote as a fact; saying so costs one boolean and prevents a whole class of over-claim.
    has_witness: records.some(item => item.witnesses.length) || edges.some(item => item.witnesses.length),
  };
}

// Preserve source witnesses; do not infer authority from naming conventions alone.

const communityRefusal = ({ id, source, reason, detail, examined, generatedAt }) => ({
  schema: COMMUNITY_SUMMARY_SCHEMA,
  producer: AGENT_PROJECTION_PRODUCER,
  record_kind: 'community_refusal',
  id,
  source,
  reason,
  reason_detail: detail,
  examined,
  generated_at: generatedAt,
});

/** Raw candidate communities, before any gate. Pure; ordering is fixed. */
function candidateCommunities(graph, slices) {
  const candidates = [];
  const domains = new Map();
  for (const overlay of list(graph.overlays)) {
    if (overlay.annotation_kind === 'service_card' && overlay.body?.domain) {
      const bucket = domains.get(overlay.body.domain) || { members: [], witnesses: [], summaries: [] };
      bucket.members.push(overlay.subject);
      bucket.witnesses.push(...list(overlay.grounded_in));
      bucket.summaries.push(overlay.body.summary);
      domains.set(overlay.body.domain, bucket);
    }
  }
  for (const [domain, bucket] of [...domains].sort((a, b) => a[0].localeCompare(b[0]))) {
    candidates.push({
      id: `community:documented-domain:${slugify(domain)}`,
      source: 'documented-domain', title: domain,
      basis: 'canon bounded-context table, parsed by ddd-overlays.mjs',
      members: uniqueSorted(bucket.members), witnesses: bucket.witnesses, parent: 'community:estate',
    });
  }
  const groups = new Map();
  for (const overlay of list(graph.overlays)) {
    if (overlay.annotation_kind === 'structural_group' && overlay.body?.group) {
      const bucket = groups.get(overlay.body.group) || { members: [], witnesses: [], rules: [] };
      bucket.members.push(overlay.subject);
      bucket.witnesses.push(...list(overlay.grounded_in));
      bucket.rules.push(overlay.body.rule);
      groups.set(overlay.body.group, bucket);
    }
  }
  for (const [group, bucket] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    candidates.push({
      id: `community:structural-group:${slugify(group)}`,
      source: 'structural-group', title: group,
      basis: `structural-grouping.mjs rules ${uniqueSorted(bucket.rules).join(', ')} — a fact about file layout, NOT a business domain`,
      members: uniqueSorted(bucket.members), witnesses: bucket.witnesses, parent: 'community:estate',
    });
  }
  const entities = list(graph.entity_layer).filter(record => record.record_kind === 'entity_type');
  if (entities.length) {
    candidates.push({
      id: 'community:entity-family:schema-declared',
      source: 'entity-family', title: 'Schema-declared entity model',
      basis: 'entity-layer.mjs promotion rules over the estate SQLite DDL',
      members: uniqueSorted(entities.map(record => record.id)),
      witnesses: entities.flatMap(record => list(record.witnesses)), parent: 'community:estate',
    });
  }
  for (const slice of list(slices)) {
    candidates.push({
      id: `community:slice:${slice.id.replace(/^slice:/, '')}`,
      source: 'slice', title: slice.id.replace(/^slice:/, ''),
      basis: `${slice.enumerator} via ${slice.uses}`,
      members: uniqueSorted(slice.members), witnesses: [], slice, parent: null,
    });
  }
  return candidates;
}

const slugify = value => String(value).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/**
 * Compose ONE community summary, or refuse. The gates, in order — every one of them is a
 * question about the GRAPH, never about the prose:
 *
 *   C1 members resolve   — at least SUMMARY_MEMBER_FLOOR members are real graph nodes or
 *                          entity-layer records. A summary of ids that name nothing is fiction.
 *   C2 witnessed         — at least one member carries a real file:line, so the summary can be
 *                          checked by opening something.
 *   C3 carried prose     — an interpretation concept is attached ONLY if its slice witness
 *                          reproduces against THIS graph's digest. A concept coined against a
 *                          different graph is not evidence about this one.
 *   C4 has a relation    — the members share an internal edge, a shared basis fact, or a shared
 *                          declared relationship. Without one, "these things exist" is all that
 *                          is true, and that is not a summary.
 */
export function summarizeCommunity(graph, candidate, context) {
  const { index, shape, generatedAt } = context;
  const memberNodes = candidate.members.map(id => index.nodesById.get(id)).filter(Boolean);
  const entityRecords = list(graph.entity_layer).filter(record => candidate.members.includes(record.id));
  const resolved = memberNodes.length + entityRecords.length;
  const examined = [
    { relation: 'members_declared', target: candidate.id, value: String(candidate.members.length) },
    { relation: 'members_resolving_to_a_record', target: 'graph.nodes + graph.entity_layer', value: String(resolved) },
  ];
  if (resolved < SUMMARY_MEMBER_FLOOR) {
    return communityRefusal({
      id: candidate.id, source: candidate.source, generatedAt,
      reason: resolved === 0 ? 'no_member_resolves_to_a_graph_node' : 'members_below_summary_floor',
      detail: `${resolved} of ${candidate.members.length} declared member(s) resolve to a record; the summary floor is ${SUMMARY_MEMBER_FLOOR}`,
      examined,
    });
  }
  // BASIS witnesses first. For a documented domain the candidate's witnesses are the overlay's
  // `grounded_in`, whose FIRST entry is the canon line that asserts the mapping; a member node's
  // own witness is a file that merely happens to be in the domain. Leading with the member
  // witness made a "canon witness" column cite a test fixture.
  const memberWitnesses = [...list(candidate.witnesses), ...memberNodes.flatMap(node => list(node.witnesses)), ...entityRecords.flatMap(record => list(record.witnesses))];
  examined.push({ relation: 'witnesses_carried_by_members', target: 'node.witnesses + record.witnesses + overlay.grounded_in', value: String(memberWitnesses.length) });
  if (!memberWitnesses.length) {
    return communityRefusal({
      id: candidate.id, source: candidate.source, generatedAt,
      reason: 'no_member_carries_a_witness',
      detail: 'no member of this community carries a file:line, so nothing in a summary could be checked by opening a file',
      examined,
    });
  }
  const memberSet = new Set(candidate.members);
  const internal = [], outbound = [];
  for (const id of candidate.members) {
    for (const entry of index.edgesBySubject.get(id) || []) {
      const other = entry.direction === 'out' ? entry.edge.to : entry.edge.from;
      if (!other) continue;
      (memberSet.has(other) ? internal : outbound).push({ ...entry, other });
    }
  }
  const relationships = list(graph.entity_layer).filter(record => record.record_kind === 'relationship'
    && memberSet.has(`entity:${record.from}`) && memberSet.has(`entity:${record.to}`));
  // C4's four admissible relations, in the order they are cheapest to check. Each is a
  // COMPUTED property of the graph, so the gate can actually fire; "the enumerator selected
  // them" is deliberately NOT one of them, because that is a restatement of the spec rather
  // than a relation among the members — the interpretation layer's own
  // `name_would_restate_the_enumerator` refusal is the same distinction.
  const neighbourSets = candidate.members.map(id => new Set((index.edgesBySubject.get(id) || [])
    .map(entry => (entry.direction === 'out' ? entry.edge.to : entry.edge.from)).filter(Boolean)));
  const commonNeighbours = neighbourSets.length
    ? [...(neighbourSets[0] || new Set())].filter(candidateId => !memberSet.has(candidateId) && neighbourSets.every(set => set.has(candidateId))).sort()
    : [];
  const witnessFiles = uniqueSorted(memberNodes.map(node => { const first = list(node.witnesses)[0]; return first ? `${first.repo}/${first.file}` : null; }));
  const sharedWitnessFile = memberNodes.length > 1 && witnessFiles.length === 1;
  // A documented domain is the ONE partition a human asserted: canon's bounded-context table
  // states the grouping, so the grouping itself is the evidence.
  const documentedPartition = candidate.source === 'documented-domain';
  examined.push(
    { relation: 'internal_edges', target: 'graph.edges with both endpoints in the community', value: String(internal.length) },
    { relation: 'declared_relationships', target: 'graph.entity_layer[record_kind=relationship]', value: String(relationships.length) },
    { relation: 'common_neighbours', target: 'nodes adjacent to EVERY member', value: commonNeighbours.length ? commonNeighbours.slice(0, EXEMPLAR_CAP).join(', ') : 'none' },
    { relation: 'shared_declaring_file', target: witnessFiles.slice(0, EXEMPLAR_CAP).join(', ') || 'none', value: sharedWitnessFile ? 'yes' : 'no' },
    { relation: 'documented_partition', target: candidate.basis, value: documentedPartition ? 'yes' : 'no' },
  );
  if (!internal.length && !relationships.length && !commonNeighbours.length && !sharedWitnessFile && !documentedPartition) {
    return communityRefusal({
      id: candidate.id, source: candidate.source, generatedAt,
      reason: 'no_relation_or_shared_basis_among_members',
      detail: 'the members share no edge, no declared relationship, no common neighbour, no declaring file and no documented partition; the only true sentence about them is that the spec selected them',
      examined,
    });
  }
  // C3 — carried model prose, revalidated. A concept whose slice does not reproduce here is
  // recorded as an examined negative rather than silently dropped: the reader is entitled to
  // know that the interpretation layer named this shape and the name did not survive the check.
  const carried = [];
  const digest = shape.digest;
  for (const record of list(graph.interpretation_layer)) {
    if (record.record_kind !== 'concept') continue;
    const witness = record.slice_witness;
    if (!witness || `community:slice:${String(witness.slice_id).replace(/^slice:/, '')}` !== candidate.id) continue;
    const reproduced = witness.graph_digest === digest && sameMembers(reproduceSlice(graph, witness.spec, { index: shape.interpretation }).members, witness.members);
    examined.push({ relation: 'carried_interpretation', target: record.id, value: reproduced ? 'slice reproduces against this graph digest' : 'slice does NOT reproduce against this graph digest' });
    if (reproduced) carried.push({ id: record.id, label: record.label, concept: record.concept, coheres_because: record.coheres_because, confidence: record.confidence ?? null, evidence_class: 'interpretation', provenance: 'carried_llm_annotation', slice_id: witness.slice_id });
  }
  const kindHistogram = histogramText(memberNodes.map(node => String(node.kind)));
  const componentHistogram = histogramText(memberNodes.map(node => String(node.repo || 'unknown')));
  const outboundKinds = histogramText(outbound.map(entry => entry.edge.kind));
  const counterparts = uniqueSorted(outbound.map(entry => entry.other)).slice(0, EXEMPLAR_CAP);
  const refusalsNaming = list(graph.refusals).filter(record => memberSet.has(record.subject) && record.state === 'refused');
  const unclassified = list(graph.structural_unclassified).filter(record => memberSet.has(record.subject));
  const exemplars = memberNodes
    .slice()
    .sort((a, b) => (shape.degree.get(b.id) || 0) - (shape.degree.get(a.id) || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, EXEMPLAR_CAP)
    .map(node => ({ id: node.id, kind: node.kind, name: node.name || node.id, degree: shape.degree.get(node.id) || 0, witness: list(node.witnesses).slice(0, 1).map(witnessText)[0] || null }));
  const witnesses = dedupeWitnesses(memberWitnesses).slice(0, EXEMPLAR_CAP);
  return {
    schema: COMMUNITY_SUMMARY_SCHEMA,
    producer: AGENT_PROJECTION_PRODUCER,
    record_kind: 'community_summary',
    id: candidate.id,
    source: candidate.source,
    level: SOURCE_LEVEL[candidate.source],
    parent: candidate.parent,
    title: candidate.title,
    basis: candidate.basis,
    evidence_class: candidate.source === 'slice' ? 'interpretation' : 'derived',
    // The four sentences a GraphRAG community summary must answer, each a composition of the
    // counted facts above and nothing else.
    what_it_is: `${candidate.title}: ${resolved} member record(s) grouped by ${candidate.basis}.`,
    coheres_because: [
      internal.length ? `${internal.length} edge(s) run between members` : null,
      relationships.length ? `${relationships.length} schema-declared relationship(s) relate members` : null,
      commonNeighbours.length ? `every member is adjacent to ${commonNeighbours.slice(0, 3).join(', ')}` : null,
      sharedWitnessFile ? `every member is declared in ${witnessFiles[0]}` : null,
      documentedPartition ? 'canon asserts this partition' : null,
    ].filter(Boolean).join('; '),
    members: { count: candidate.members.length, resolved, by_kind: kindHistogram, by_component: componentHistogram, exemplars, ids: candidate.members },
    talks_to: { internal_edges: internal.length, outbound_edges: outbound.length, outbound_edge_kinds: outboundKinds, common_neighbours: commonNeighbours.slice(0, EXEMPLAR_CAP), counterparts },
    unresolved: {
      standing_refusals_naming_members: refusalsNaming.length,
      refusal_reasons: histogramText(refusalsNaming.map(record => record.reason)),
      structurally_unclassified_members: unclassified.length,
      members_without_witness: memberNodes.filter(node => !list(node.witnesses).length).length,
    },
    carried_interpretations: carried,
    witnesses: witnesses.map(witnessRow),
    examined,
    generated_at: generatedAt,
  };
}

const sameMembers = (a, b) => a.length === b.length && a.every((value, position) => value === b[position]);
/**
 * De-duplicate witnesses PRESERVING RECORD ORDER, and never sorting.
 *
 * This is load-bearing, not a style choice. Producers order `witnesses` / `grounded_in`
 * meaningfully: a ddd-overlay's FIRST grounded_in is the canon line that asserts the mapping and
 * its second is the manifest line; an entity_type's first witness is its DDL site. Sorting the
 * list alphabetically put `client/e2e/.../fixture.ts` ahead of `design/canon/ddd-mapping.md`, so a
 * "canon witness" column cited a TEST FIXTURE — a correct-looking citation pointing at the wrong
 * class of file, which is precisely the drifted-citation failure the orientation test penalises.
 * Record order is deterministic because merge.mjs already sorts the records themselves.
 */
function dedupeWitnesses(witnesses) {
  const seen = new Set(), out = [];
  for (const witness of witnesses) {
    const key = witnessText(witness);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(witness);
  }
  return out;
}

/**
 * The whole community set, composed HIERARCHICALLY: an estate root, level-1 communities whose
 * basis is a documented or derived partition, and level-2 slices attached to the level-1
 * community that holds the most of their members. The attachment is a MEASURED majority, and a
 * slice whose members do not concentrate anywhere stays at the root rather than being filed
 * somewhere convenient.
 */
export function deriveCommunities(graph, options = {}) {
  const generatedAt = options.now || DEFAULT_GENERATED_AT;
  const index = options.index || buildSubjectIndex(graph);
  const interpretation = options.interpretationIndex || buildInterpretationIndex(graph);
  const slices = options.slices || enumerateSlices(graph, { index: interpretation }).slices;
  const degree = interpretation.shape.degree;
  const shape = { degree, digest: graphDigest(graph), interpretation };
  const candidates = candidateCommunities(graph, slices);
  const results = candidates.map(candidate => ({ candidate, record: summarizeCommunity(graph, candidate, { index, shape, generatedAt }) }));
  const summaries = results.filter(entry => entry.record.record_kind === 'community_summary').map(entry => entry.record);
  const refusals = results.filter(entry => entry.record.record_kind === 'community_refusal').map(entry => entry.record);
  const parents = summaries.filter(summary => summary.level === 1);
  const membership = new Map(parents.map(parent => [parent.id, new Set(parent.members.ids)]));
  for (const summary of summaries) {
    if (summary.level !== 2) continue;
    const scored = parents
      .map(parent => ({ id: parent.id, overlap: summary.members.ids.filter(member => membership.get(parent.id).has(member)).length }))
      .filter(entry => entry.overlap * 2 > summary.members.ids.length)
      .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id));
    summary.parent = scored.length ? scored[0].id : 'community:estate';
    summary.parent_basis = scored.length
      ? `${scored[0].overlap} of ${summary.members.ids.length} members are also members of ${scored[0].id} (strict majority)`
      : 'no level-1 community holds a strict majority of these members; attached to the estate root';
  }
  const root = {
    schema: COMMUNITY_SUMMARY_SCHEMA,
    producer: AGENT_PROJECTION_PRODUCER,
    record_kind: 'community_summary',
    id: 'community:estate',
    source: 'estate',
    level: 0,
    parent: null,
    title: 'The estate',
    basis: 'the merged canonical graph',
    evidence_class: 'derived',
    what_it_is: `${list(graph.nodes).length} node(s) and ${list(graph.edges).length} edge(s) across ${uniqueSorted(list(graph.nodes).map(node => node.repo)).length} component(s), partitioned into ${parents.length} level-1 and ${summaries.filter(item => item.level === 2).length} level-2 communities.`,
    members: { count: list(graph.nodes).length, resolved: list(graph.nodes).length, by_kind: histogramText(list(graph.nodes).map(node => String(node.kind))), by_component: histogramText(list(graph.nodes).map(node => String(node.repo || 'unknown'))), exemplars: [], ids: [] },
    talks_to: { internal_edges: list(graph.edges).length, outbound_edges: 0, outbound_edge_kinds: histogramText(list(graph.edges).map(edge => edge.kind)), counterparts: [] },
    unresolved: {
      standing_refusals_naming_members: list(graph.refusals).filter(record => record.state === 'refused').length,
      refusal_reasons: histogramText(list(graph.refusals).filter(record => record.state === 'refused').map(record => record.reason)),
      structurally_unclassified_members: list(graph.structural_unclassified).length,
      members_without_witness: list(graph.nodes).filter(node => !list(node.witnesses).length).length,
    },
    carried_interpretations: [],
    witnesses: [],
    examined: [{ relation: 'composed_from', target: 'level-1 communities', value: String(parents.length) }],
    generated_at: generatedAt,
  };
  const ordered = [root, ...summaries].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  return {
    communities: ordered,
    refusals: refusals.sort((a, b) => a.id.localeCompare(b.id)),
    census: {
      producer: AGENT_PROJECTION_PRODUCER,
      graph_digest: shape.digest,
      candidates: candidates.length + 1,
      summarised: ordered.length,
      refused: refusals.length,
      refusal_rate: percent(refusals.length, candidates.length + 1),
      by_level: rows(countBy(ordered.map(item => item.level))).map(([level, count]) => ({ count, level })),
      by_source: rows(countBy(ordered.map(item => item.source))).map(([source, count]) => ({ count, source })),
      refused_by_reason: rows(countBy(refusals.map(item => item.reason))).map(([reason, count]) => ({ count, reason })),
      carried_interpretations: ordered.reduce((sum, item) => sum + item.carried_interpretations.length, 0),
      prose_policy: COMMUNITY_PROSE_POLICY,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. RESOURCE MANIFEST — defect (d). MCP `resources/list` + `resourceTemplates`.
// ---------------------------------------------------------------------------

/**
 * What the map can answer, as data an agent can read before asking anything. Modelled on MCP's
 * resources: every entry carries `uri`, `title`, `description`, `mimeType`, plus a `shape` field
 * this tool adds because an agent that knows the media type still does not know the record
 * shape. Templates use RFC 6570 level-1 expansion, which is what MCP `resourceTemplates` use.
 *
 * INVARIANT (tested): every `uri` here resolves through `readResource`, and every
 * `uriTemplate` resolves for at least one real value drawn from this graph. A manifest that
 * advertises an unbacked URI is a worse failure than no manifest.
 */
export function buildResourceManifest(graph, options = {}) {
  const generatedAt = options.now || DEFAULT_GENERATED_AT;
  const communities = options.communities || null;
  const counts = {
    nodes: list(graph.nodes).length,
    edges: list(graph.edges).length,
    entities: list(graph.entity_layer).filter(record => record.record_kind === 'entity_type').length,
    relationships: list(graph.entity_layer).filter(record => record.record_kind === 'relationship').length,
    refusals: list(graph.refusals).filter(record => record.state === 'refused').length,
    communities: communities ? communities.communities.length : null,
    domain_prepass: Object.fromEntries(['assigned', 'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only'].map(status => [status, list(graph.domain_prepass_receipts).filter(record => record.status === status).length])),
    adjudication_records: list(graph.adjudication_records).length,
  };
  const resource = (uri, title, description, shape) => ({ uri, title, description, mimeType: 'application/json', shape });
  const resources = [
    { uri: `${RESOURCE_URI_SCHEME}://brief`, title: 'Estate brief', description: `The llms.txt-shaped orientation briefing: entity model, envelope flows, capability edges, documented domains, surprises, and WHAT THIS MAP CANNOT TELL YOU. Read this first; it is the compression of ${counts.nodes} nodes into a few thousand tokens.`, mimeType: 'text/markdown', shape: 'markdown document' },
    resource(`${RESOURCE_URI_SCHEME}://manifest`, 'Resource manifest', 'This document. Lists every question the map can answer and the URI that answers it.', 'resource manifest'),
    resource(`${RESOURCE_URI_SCHEME}://communities`, 'Community summaries', `Pregenerated summaries for every community, composed hierarchically (level 0 estate, level 1 documented/derived partitions, level 2 reproducible slices) so a global question is answerable without the full graph.`, 'array of estate-map/community-summary/v1'),
    resource(`${RESOURCE_URI_SCHEME}://communities/refused`, 'Community refusals', 'Communities for which no defensible summary exists, with the reason code and what was examined. Refusal is the honest output, not a gap in the artifact.', 'array of estate-map/community-summary/v1 record_kind=community_refusal'),
    resource(`${RESOURCE_URI_SCHEME}://entities`, 'Entity model', `The ${counts.entities} schema-declared entities with root table, promotion rule, corroboration and DDL witness.`, 'array of estate-map/entity-layer/v1 record_kind=entity_type'),
    resource(`${RESOURCE_URI_SCHEME}://entities/relationships`, 'Entity relationships', `The ${counts.relationships} relationships with cardinality, basis and status; a name match with no REFERENCES clause is status=shape_only and says so.`, 'array of estate-map/entity-layer/v1 record_kind=relationship'),
    resource(`${RESOURCE_URI_SCHEME}://entities/conflicts`, 'Entity conflicts', 'Where the SQLite schema and the shipped UI model disagree about the entity model, both claims with both witnesses.', 'array of estate-map/entity-layer/v1 record_kind=conflict'),
    resource(`${RESOURCE_URI_SCHEME}://capabilities`, 'Capability contracts', 'Every capability type: who provides it, who requires it, who calls it, and whether it is orphaned.', 'array of graph node kind=capability'),
    resource(`${RESOURCE_URI_SCHEME}://envelopes`, 'Envelope kinds', 'Every envelope kind with emit/consume site counts, declared publisher/subscriber flags and witness provenance classes.', 'array of graph node kind=envelope_kind'),
    resource(`${RESOURCE_URI_SCHEME}://routes`, 'HTTP surface', 'Every route with method, mounted path, mount basis, owner and auth setting.', 'array of graph node kind=route'),
    resource(`${RESOURCE_URI_SCHEME}://wiring`, 'Manifest declarations vs wiring reality', 'Every manifest declaration assessed wired / declared_unwired / undeterminable, with what was searched.', 'array of manifest wiring records'),
    resource(`${RESOURCE_URI_SCHEME}://domains`, 'Documented domains', 'The canon bounded contexts and which nodes carry them, with the canon line that asserts the mapping.', 'array of estate-map/annotation overlays annotation_kind=service_card'),
    resource(`${RESOURCE_URI_SCHEME}://domain-prepass`, 'Domain prepass receipts', `Persisted DPA-1@2 decisions: ${counts.domain_prepass.assigned} assigned, ${counts.domain_prepass.ambiguous} ambiguous, ${counts.domain_prepass.no_anchor} no-anchor, ${counts.domain_prepass.ineligible_subject} ineligible_subject, ${counts.domain_prepass.fixture_only} fixture_only.`, 'array of estate-map/domain-prepass-receipt/v1'),
    resource(`${RESOURCE_URI_SCHEME}://adjudication`, 'Deterministic adjudication records', `Persisted campaign packets and receipts: ${counts.adjudication_records} record(s). Model-disabled runs retain requires_model receipts rather than fabricated conclusions.`, 'array of estate-map/adjudication-record/v1'),
    resource(`${RESOURCE_URI_SCHEME}://refusals`, 'Refusal census', `All ${counts.refusals} standing refusals rolled up by reason code, state, rule and evidence shape. THIS IS THE MAP'S OWN LIST OF ITS OPEN OBLIGATIONS: each code routes to one of the seven states in tools/estate-map/refusal-routing.mjs, and only closed_world_absent is settled — inside the finite universe it names.`, 'refusal census object'),
    resource(`${RESOURCE_URI_SCHEME}://surprises`, 'Surprises', 'The findings a reader would not predict: entities with no root table, declared-unwired manifests, cross-context publications, source conflicts, kinds with no production witness.', 'array of surprise records'),
    resource(`${RESOURCE_URI_SCHEME}://census`, 'Counts', 'Every census the graph carries, in one object: routes, capabilities, wiring, envelope witnesses, node/edge kinds.', 'census object'),
  ].sort((a, b) => a.uri.localeCompare(b.uri));
  const resourceTemplates = [
    { uriTemplate: `${RESOURCE_URI_SCHEME}://subject/{subject_id}`, title: 'Everything known about one subject', description: 'ONE call returns node, edges, annotations from every layer, refusals naming it, entity facts, interpretations and dataflow claims — normalised so a consumer writes one reader instead of six. Accepts a node id, an entity id or name, an interpretation id, a capability or envelope name, or a plugin name.', mimeType: 'application/json', shape: ASSEMBLED_SUBJECT_SCHEMA },
    { uriTemplate: `${RESOURCE_URI_SCHEME}://community/{community_id}`, title: 'One community summary', description: 'The pregenerated summary for one community, or its refusal record if no defensible summary exists.', mimeType: 'application/json', shape: COMMUNITY_SUMMARY_SCHEMA },
    { uriTemplate: `${RESOURCE_URI_SCHEME}://refusals/{reason}`, title: 'Refusals by reason code', description: 'The refusal census filtered to one reason code, so an agent can ask "which class of question is still open, and what settles it" rather than "is this missing".', mimeType: 'application/json', shape: 'refusal census object' },
    { uriTemplate: `${RESOURCE_URI_SCHEME}://wiring/{status}`, title: 'Manifest declarations by wiring status', description: 'wired | declared_unwired | undeterminable.', mimeType: 'application/json', shape: 'array of manifest wiring records' },
  ].sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
  return {
    schema: RESOURCE_MANIFEST_SCHEMA,
    producer: AGENT_PROJECTION_PRODUCER,
    generated_at: generatedAt,
    graph_digest: graphDigest(graph),
    counts,
    entry_point: `${RESOURCE_URI_SCHEME}://brief`,
    reading_order: [`${RESOURCE_URI_SCHEME}://brief`, `${RESOURCE_URI_SCHEME}://communities`, `${RESOURCE_URI_SCHEME}://subject/{subject_id}`, `${RESOURCE_URI_SCHEME}://refusals`],
    resources,
    resourceTemplates,
  };
}

/** Resolve one manifest URI against the graph. Every manifest entry MUST land here. */
export function readResource(graph, uri, options = {}) {
  const context = options.context || {};
  const raw = String(uri || '');
  if (!raw.startsWith(`${RESOURCE_URI_SCHEME}://`)) throw new Error(`not an ${RESOURCE_URI_SCHEME}:// uri: ${raw}`);
  const [head, ...rest] = raw.slice(`${RESOURCE_URI_SCHEME}://`.length).split('/');
  // Template arguments are percent-encoded by any well-behaved client, and every id vocabulary in
  // this map contains `:` (`capability:batch`, `community:slice:E1-...`). Decoding here is what
  // makes `estate://community/community%3Aslice%3A...` resolve instead of silently returning null.
  const tail = decodeURIComponent(rest.join('/'));
  const entityRecords = kind => list(graph.entity_layer).filter(record => record.record_kind === kind);
  if (head === 'brief') return context.brief ?? null;
  if (head === 'manifest') return context.manifest || buildResourceManifest(graph, options);
  if (head === 'communities' && !tail) return (context.communities || deriveCommunities(graph, options)).communities;
  if (head === 'communities' && tail === 'refused') return (context.communities || deriveCommunities(graph, options)).refusals;
  if (head === 'community') {
    const set = context.communities || deriveCommunities(graph, options);
    return [...set.communities, ...set.refusals].find(item => item.id === tail) || null;
  }
  if (head === 'subject') return assembleSubject(graph, tail, options);
  if (head === 'entities' && !tail) return entityRecords('entity_type');
  if (head === 'entities' && tail === 'relationships') return entityRecords('relationship');
  if (head === 'entities' && tail === 'conflicts') return entityRecords('conflict');
  if (head === 'capabilities') return list(graph.nodes).filter(node => node.kind === 'capability');
  if (head === 'envelopes') return list(graph.nodes).filter(node => node.kind === 'envelope_kind');
  if (head === 'routes') return list(graph.nodes).filter(node => node.kind === 'route');
  if (head === 'wiring') return tail ? list(graph.manifest_wiring).filter(record => record.wiring_status === tail) : list(graph.manifest_wiring);
  if (head === 'domains') return list(graph.overlays).filter(overlay => overlay.annotation_kind === 'service_card');
  if (head === 'domain-prepass') return list(graph.domain_prepass_receipts);
  if (head === 'adjudication') return list(graph.adjudication_records);
  if (head === 'refusals') return refusalCensus(graph, tail || undefined);
  if (head === 'surprises') return findSurprises(graph);
  if (head === 'census') return {
    node_kinds: rows(countBy(list(graph.nodes).map(node => node.kind))).map(([kind, count]) => ({ count, kind })),
    edge_kinds: rows(countBy(list(graph.edges).map(edge => edge.kind))).map(([kind, count]) => ({ count, kind })),
    routes: graph.route_census || null,
    capabilities: graph.capability_census || null,
    manifest_wiring: graph.manifest_wiring_census || null,
    envelope_witnesses: graph.envelope_witness_census || null,
  };
  throw new Error(`unknown resource uri: ${raw}`);
}

// ---------------------------------------------------------------------------
// 4. SURPRISES — the section of the brief a reader cannot predict.
// ---------------------------------------------------------------------------

/**
 * A surprise is a fact the graph already carries that CONTRADICTS the obvious expectation. Each
 * one is derived from a specific query, never selected by taste, and each carries its witness or
 * its provenance class. The frozen list is what makes this section diffable: a new surprise
 * appears because the estate changed, not because a generator felt differently.
 */
export function findSurprises(graph) {
  const out = [];
  const entities = list(graph.entity_layer).filter(record => record.record_kind === 'entity_type');
  for (const record of entities.filter(item => item.instance_table === false)) {
    out.push({
      id: `surprise:no-root-table:${record.entity}`, rule: 'S1-entity-without-root-table', evidence_class: 'derived',
      statement: `Entity '${record.entity}' has NO root table (instance_table=false, root_table=null); its schema evidence is '${record.schema_evidence}'. Looking for a table named after it will fail.`,
      witnesses: list(record.witnesses).map(witnessRow),
    });
  }
  for (const record of list(graph.manifest_wiring).filter(item => item.wiring_status === 'declared_unwired')) {
    out.push({
      id: `surprise:declared-unwired:${record.id}`, rule: 'S2-declared-unwired', evidence_class: 'derived',
      statement: `${record.owner} DECLARES ${record.declaration_family} '${record.subject}' in its manifest, and the declaring plugin contains no binding idiom for it (${record.reason}).`,
      witnesses: [witnessRow(record.declaration)],
    });
  }
  for (const record of list(graph.entity_layer).filter(item => item.record_kind === 'conflict')) {
    out.push({
      id: `surprise:conflict:${record.id}`, rule: 'S3-source-conflict', evidence_class: 'derived',
      statement: `Sources disagree about '${record.about}' (${record.reason}). ${record.claim_a.source}: ${record.claim_a.statement} | ${record.claim_b.source}: ${record.claim_b.statement}`,
      witnesses: [...list(record.claim_a.witnesses), ...list(record.claim_b.witnesses)].map(witnessRow),
    });
  }
  // Cross-context publication: an envelope kind whose derived domain came from a plugin in one
  // bounded context while another context's plugin also declares it. The derivation already
  // records the conflict; surfacing it is the point.
  const nodeName = id => list(graph.nodes).find(node => node.id === id)?.name || id;
  for (const record of list(graph.refusals).filter(item => item.state === 'refused' && item.reason === 'publisher_domain_conflict')) {
    out.push({
      id: `surprise:cross-context:${record.subject}`, rule: 'S4-cross-context-publication', evidence_class: 'refusal',
      statement: `Envelope kind '${nodeName(record.subject)}' is declared by plugins in MORE THAN ONE documented bounded context, so no single domain could be derived: ${record.reason_detail}`,
      witnesses: list(record.evidence?.witnesses).map(witnessRow),
    });
  }
  const census = graph.capability_census;
  if (census?.orphans) {
    for (const [orphan, count] of Object.entries(census.orphans).sort()) {
      if (!count) continue;
      out.push({
        id: `surprise:capability-orphan:${orphan}`, rule: 'S5-capability-orphan', evidence_class: 'derived',
        statement: `${count} capability type(s) are '${orphan.replace(/_/g, ' ')}' — the registry has a half-edge nobody completes.`,
        witnesses: [],
      });
    }
  }
  const envelopeCensus = graph.envelope_witness_census;
  if (envelopeCensus?.kinds_without_production_witness) {
    out.push({
      id: 'surprise:envelope-test-only', rule: 'S6-kind-without-production-witness', evidence_class: 'derived',
      statement: `${envelopeCensus.kinds_without_production_witness} of ${envelopeCensus.kinds} envelope kinds have NO production witness at all — they are witnessed only in test, fixture or docs. Reading the kind list as the runtime vocabulary overstates it.`,
      witnesses: [],
    });
  }
  const provided = list(graph.capability_census?.provided_by_more_than_one_plugin);
  for (const capability of provided) {
    out.push({
      id: `surprise:multi-provider:${capability}`, rule: 'S7-capability-multi-provider', evidence_class: 'derived',
      statement: `Capability '${capability}' is provided by MORE THAN ONE plugin; "the provider" is not a well-formed question for it.`,
      witnesses: list(list(graph.nodes).find(node => node.kind === 'capability' && node.name === capability)?.witnesses).map(witnessRow),
    });
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// 5. THE BRIEF — llms.txt-shaped, deterministic, honest about its own compression.
// ---------------------------------------------------------------------------

/**
 * A token count that a later process reproduces exactly. It is NOT a tokenizer: this tool has no
 * model dependency and inventing one would make the artifact non-regenerable on a machine with a
 * different tokenizer version. It is the standard chars/4 approximation, LABELLED as an
 * approximation everywhere it is printed, plus the raw counts a reader can re-derive.
 */
export function estimateTokens(text) {
  const characters = String(text).length;
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return { characters, words, approx_tokens: Math.ceil(characters / 4), method: 'characters/4 (approximation; this tool ships no tokenizer)' };
}

/**
 * The merge stage carries this inventory from extract/facts. Only positive observed counts
 * belong here: a graph without a kind cannot establish that the extractor class is absent.
 */
export function factKindInventory(graph) {
  const counts = new Map();
  for (const record of list(graph.fact_kind_inventory)) {
    const kind = typeof record?.kind === 'string' ? record.kind.trim() : '';
    const count = Number(record?.count);
    if (!kind || !Number.isFinite(count) || count <= 0) continue;
    counts.set(kind, (counts.get(kind) || 0) + count);
  }
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind));
}

const bullet = (statement, citation) => `- ${statement}${citation ? ` — ${citation}` : ''}`;
const citeList = (witnesses, cap = 2) => dedupeWitnesses(witnesses).slice(0, cap).map(witnessText).join(', ');

export function buildEstateBrief(graph, options = {}) {
  const generatedAt = options.now || DEFAULT_GENERATED_AT;
  const index = options.index || buildSubjectIndex(graph);
  const communities = options.communities || deriveCommunities(graph, { ...options, index, now: generatedAt });
  const manifest = options.manifest || buildResourceManifest(graph, { ...options, communities, now: generatedAt });
  const digest = manifest.graph_digest;
  const nodes = list(graph.nodes), edges = list(graph.edges);
  const entities = list(graph.entity_layer).filter(record => record.record_kind === 'entity_type');
  const relationships = list(graph.entity_layer).filter(record => record.record_kind === 'relationship');
  const capabilities = nodes.filter(node => node.kind === 'capability');
  const envelopes = nodes.filter(node => node.kind === 'envelope_kind');
  const surprises = findSurprises(graph);
  const census = refusalCensus(graph);
  const factKinds = factKindInventory(graph);
  const domains = communities.communities.filter(item => item.source === 'documented-domain');
  const structural = communities.communities.filter(item => item.source === 'structural-group');
  const core = entities.length + relationships.length + capabilities.length;
  const lines = [];

  lines.push(`# Estate brief — ${options.title || 'this estate'}`, '');
  lines.push(`> **Read this first.** It is a COMPRESSION of a ${nodes.length}-node, ${edges.length}-edge evidence graph into a few thousand tokens, generated deterministically by \`${AGENT_PROJECTION_PRODUCER}\`. Every claim below carries a \`repo/file:line\` witness or names its provenance class. What it drops is stated in §7; what it has NOT established — and the next supported check for each — is §6.`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Graph digest | \`${digest}\` |`);
  lines.push(`| Generated at | ${generatedAt} |`);
  if (options.base) lines.push(`| Base of record | ${options.base} |`);
  lines.push(`| Regenerate | \`node tools/estate-map/agent-projection.mjs brief <graph>/estate-graph.annotated.json --out <file>\` |`);
  lines.push(`| Machine-readable index | \`${manifest.entry_point}\` … see \`estate://manifest\` (${manifest.resources.length} resources, ${manifest.resourceTemplates.length} templates) |`, '');

  lines.push('## 0. What this estate is, in one table', '');
  lines.push('| Layer | Count | What it is | Provenance |', '|---|---:|---|---|');
  lines.push(`| Entities | ${entities.length} | schema-declared business objects | DETERMINISTIC DERIVATION from SQLite DDL |`);
  lines.push(`| Entity relationships | ${relationships.length} | cardinality the schema proves | DETERMINISTIC DERIVATION |`);
  lines.push(`| Capabilities | ${capabilities.length} | the cross-plugin call contract | EXTRACTED FACT |`);
  lines.push(`| Envelope kinds | ${envelopes.length} | the bus vocabulary | EXTRACTED FACT |`);
  lines.push(`| HTTP routes | ${nodes.filter(node => node.kind === 'route').length} | the network surface | EXTRACTED FACT |`);
  lines.push(`| Modules | ${nodes.filter(node => node.kind === 'module').length} | files — the BULK, not the signal | EXTRACTED FACT |`);
  const routing = routingSummary(census.by_reason, 'domain');
  lines.push(`| Standing refusals | ${census.standing_refusals} | unresolved questions over ${census.refused_subjects} subjects — ${routing.open} still OPEN, ${routing.terminal} closed-world (§6) | REFUSAL |`, '');
  lines.push(`**Signal-to-bulk.** The orienting core is ${core} records (${entities.length} entities + ${relationships.length} relationships + ${capabilities.length} capabilities) against ${nodes.length} nodes: **${percent(core, nodes.length)}** of the graph. That ratio is why this brief exists.`, '');

  lines.push('## 1. The entity model', '');
  lines.push('Promoted only with schema evidence AND an independent corroboration; a name match with no `REFERENCES` clause is never called schema-declared.', '');
  lines.push('| Entity | Root table | Own table | Rule | Corroborated by | DDL witness |', '|---|---|---|---|---|---|');
  for (const record of entities.slice().sort((a, b) => a.entity.localeCompare(b.entity))) {
    lines.push(`| \`${record.entity}\` | ${record.root_table ? `\`${record.root_table}\`` : '**none**' } | ${record.instance_table ? 'yes' : '**no**'} | ${record.rule} | ${uniqueSorted(list(record.corroboration).map(item => item.source)).join(', ')} | ${citeList(list(record.witnesses), 1) || '—'} |`);
  }
  lines.push('');
  lines.push('**Relationships with cardinality** (status `schema_declared` = a real `REFERENCES`; `shape_only` = a name match; `read_model_evidence` = a projection table is the only site that states it):', '');
  lines.push('| From | Relation | To | Cardinality | Basis | Status | Via | Witness |', '|---|---|---|---|---|---|---|---|');
  for (const record of relationships.slice().sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.via.localeCompare(b.via))) {
    lines.push(`| ${record.from} | ${record.relation} | ${record.to} | ${record.cardinality} | ${record.basis} | ${record.status} | \`${record.via}\` | ${citeList(list(record.witnesses), 1) || '—'} |`);
  }
  lines.push('');

  lines.push('## 2. Envelope flows and capability edges', '');
  const busiest = envelopes.slice().sort((a, b) => ((b.emit_site_count || 0) + (b.consume_site_count || 0)) - ((a.emit_site_count || 0) + (a.consume_site_count || 0)) || String(a.name).localeCompare(String(b.name))).slice(0, 12);
  // WHO publishes and WHO subscribes comes from the MANIFEST DECLARATIONS, not from the site
  // counts: a site count says how many places touch the kind, never which plugin owns the
  // contract. Conflating the two is how "who consumes this kind" gets answered with a test file.
  const declarers = (kind, family) => uniqueSorted(list(graph.manifest_wiring)
    .filter(record => record.declaration_family === family && record.subject === kind)
    .map(record => record.owner));
  lines.push('**The busiest envelope kinds.** `emit`/`consume` are extracted SITE counts (any file, including tests); publisher/subscriber are MANIFEST DECLARATIONS (which plugin owns the contract). A kind with declared publishers but no declared subscriber is published to nobody a manifest names.', '');
  lines.push('| Kind | emit | consume | declared publisher(s) | declared subscriber(s) | primary witness class | Witness |', '|---|---:|---:|---|---|---|---|');
  for (const node of busiest) {
    lines.push(`| \`${node.name}\` | ${node.emit_site_count || 0} | ${node.consume_site_count || 0} | ${declarers(node.name, 'publishes_envelope').join(', ') || '—'} | ${declarers(node.name, 'subscribes_envelope').join(', ') || '—'} | ${node.primary_witness_class || '—'} | ${citeList(list(node.witnesses), 1) || '—'} |`);
  }
  lines.push('');
  lines.push('**Capability contracts** — who provides, who requires, who calls. `declared by` is the MANIFEST `provides_capabilities:` claim; `code provider` is a real `capabilities.provide(` site. A capability declared but never provided in code, or required by a consumer that is NOT in `optional for`, is a HARD dependency edge — that join is the whole of “which plugins can be removed”.', '');
  lines.push('| Capability | declared by | code provider(s) | Consumer(s) | provide() | require() | request() | Optional for | Witness |', '|---|---|---|---|---:|---:|---:|---|---|');
  for (const node of capabilities.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    lines.push(`| \`${node.name}\` | ${list(node.declared_providers).join(', ') || '—'} | ${list(node.providers).join(', ') || '**NO CODE PROVIDER**'} | ${list(node.consumers).join(', ') || '—'} | ${node.provide_site_count || 0} | ${node.require_site_count || 0} | ${node.call_site_count || 0} | ${list(node.optional_for).join(', ') || '—'} | ${citeList(list(node.witnesses), 1) || '—'} |`);
  }
  lines.push('');

  lines.push('## 3. The documented-domain map', '');
  if (domains.length) {
    lines.push('Canon documents these bounded contexts; every membership below is witnessed at the canon line that asserts it. **Everything else in the estate has no documented domain** and is grouped structurally instead (§4) — a structural group is a fact about file layout and is NEVER a business domain.', '');
    lines.push('| Domain | Members | Talks to (edge kinds) | Refusals naming members | Canon witness |', '|---|---:|---|---:|---|');
    for (const domain of domains) {
      lines.push(`| ${domain.title} | ${domain.members.resolved} | ${domain.talks_to.outbound_edge_kinds || '—'} | ${domain.unresolved.standing_refusals_naming_members} | ${domain.witnesses.slice(0, 1).map(item => item.cite).join('') || '—'} |`);
    }
  } else {
    lines.push('**No documented domain overlays are present in this graph.** Nothing here is inferred to fill the gap.');
  }
  lines.push('');

  lines.push('## 4. Communities you can ask about without loading the graph', '');
  lines.push(`${communities.communities.length} pregenerated summaries (level 0 estate · level 1 documented/derived partitions · level 2 reproducible slices), ${communities.refusals.length} refused. Read one with \`estate://community/{community_id}\`.`, '');
  lines.push('| Level | Community | Members | Internal edges | Basis |', '|---:|---|---:|---:|---|');
  for (const item of communities.communities.filter(entry => entry.level <= 1)) {
    lines.push(`| ${item.level} | \`${item.id}\` | ${item.members.resolved} | ${item.talks_to.internal_edges} | ${item.basis} |`);
  }
  lines.push('');
  if (structural.length) lines.push(`Structural groups (layout facts, not domains): ${structural.map(item => `\`${item.title}\` (${item.members.resolved})`).join(' · ')}.`, '');

  lines.push('## 5. Genuine surprises', '');
  lines.push('Each is a fact the graph carries that contradicts the obvious expectation. Derived by a named rule, never selected by taste.', '');
  const surpriseGroups = new Map();
  for (const surprise of surprises) surpriseGroups.set(surprise.rule, [...(surpriseGroups.get(surprise.rule) || []), surprise]);
  for (const [rule, group] of [...surpriseGroups].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`**${rule}** (${group.length}):`);
    for (const surprise of group.slice(0, EXEMPLAR_CAP)) lines.push(bullet(surprise.statement, surprise.witnesses.length ? surprise.witnesses.slice(0, 1).map(item => item.cite).join('') : `provenance: ${EVIDENCE_CLASSES[surprise.evidence_class].label}`));
    if (group.length > EXEMPLAR_CAP) lines.push(`- …and ${group.length - EXEMPLAR_CAP} more; all of them at \`estate://surprises\`.`);
    lines.push('');
  }

  // §6 IS THE OPEN-OBLIGATION SECTION, NOT AN ABSENCE LIST.
  // The heading, the roll-up and every row route through refusal-routing.mjs, so a reader sees
  // "this question is still open, here is the next supported check" instead of a code plus a
  // gloss phrased as a settled fact about the estate. Only `closed_world_absent` reads CLOSED,
  // and even that prints the universe it exhausted plus the broader claim that stays open.
  lines.push('## 6. OPEN OBLIGATIONS — what this map has NOT established, and where to look next', '');
  lines.push(`This section is generated from the refusal census, not written. ${census.standing_refusals} standing refusals over ${census.refused_subjects} subjects, routed onto the seven states in \`tools/estate-map/refusal-routing.mjs\`: **${routing.open} still OPEN**, ${routing.terminal} \`closed_world_absent\`. A refusal proves the question was ASKED. Only \`closed_world_absent\` is settled — and only inside the finite universe it names, never as a fact about the estate.`, '');
  lines.push('| Routing state | Refusals | Reads as |', '|---|---:|---|');
  for (const row of routing.by_state.filter(entry => entry.count > 0)) {
    lines.push(`| \`${row.state}\` | ${row.count} | ${row.terminal ? 'CLOSED, inside the named universe only' : 'OPEN — carries a next supported check'} |`);
  }
  if (routing.unrouted) lines.push(`| (unrouted) | ${routing.unrouted} | code outside the four frozen vocabularies; read the record |`);
  lines.push('');
  lines.push('| Reason code | Count | Routing state | What holds now, and the next supported check | Example subject |', '|---|---:|---|---|---|');
  for (const row of census.by_reason) {
    const routed = routeRefusal({ family: 'domain', reason: row.reason });
    lines.push(`| \`${row.reason}\` | ${row.count} | \`${routed ? routed.state : 'unrouted'}\` | ${renderRefusal({ family: 'domain', reason: row.reason })} | \`${row.examples[0] || '—'}\` |`);
  }
  lines.push('');
  lines.push('**Fact-kind inventory of this build.** This is the merged `extract/facts` census, not a frozen absence list. Every row is observed in this graph; this brief makes no claim that an unlisted extractor class is absent.', '');
  if (factKinds.length) {
    lines.push('| Fact kind | Records |', '|---|---:|');
    for (const item of factKinds) lines.push(`| \`${item.kind}\` | ${item.count} |`);
  } else {
    lines.push('No `fact_kind_inventory` is present in this graph, so this brief makes no extractor-coverage absence claim.');
  }
  lines.push('');
  if (communities.refusals.length) {
    lines.push(`**Communities refused** (${communities.refusals.length}): ${rows(countBy(communities.refusals.map(item => item.reason))).map(([reason, count]) => `\`${reason}\` × ${count}`).join(' · ')}. Full records at \`estate://communities/refused\`.`, '');
  }

  lines.push('## 7. What this compression dropped', '');
  const dropped = [
    { what: `${nodes.filter(node => node.kind === 'module').length} module nodes`, why: 'file position is bulk, not orientation', where: '`estate://subject/{subject_id}`, or the community that holds them' },
    { what: `${list(graph.overlays).filter(item => item.annotation_kind === 'structural_group').length} structural-group annotations`, why: 'summarised as counts in §4', where: '`estate://community/{community_id}`' },
    { what: `${communities.communities.filter(item => item.level === 2).length} level-2 slice summaries`, why: 'listed only by count here', where: '`estate://communities`' },
    { what: `${census.total_records - census.standing_refusals} non-standing refusal records`, why: 'superseded or withdrawn refusals are history, not current absence', where: 'the canonical graph `refusals[]`' },
    { what: `${list(graph.unresolved).length} unresolved association records`, why: 'each is a dynamic expression the extractor declined to guess', where: '`estate://census`, graph `unresolved[]`' },
    { what: `${Math.max(0, census.by_reason.reduce((sum, row) => sum + row.count, 0) - census.by_reason.length)} individual refusal records`, why: '§6 rolls them up by reason code', where: '`estate://refusals/{reason}`' },
  ];
  lines.push('| Dropped | Why | Where it still lives |', '|---|---|---|');
  for (const item of dropped) lines.push(`| ${item.what} | ${item.why} | ${item.where} |`);
  lines.push('');
  lines.push(`**This brief is not the map.** It is a lossy projection of \`estate-graph.annotated.json\` @ \`${digest}\`. Where it disagrees with the graph, the graph wins; where the graph disagrees with source, SOURCE WINS.`, '');

  const body = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  // The token count is MEASURED on the body and then appended, so the number printed is the
  // number of the text it describes plus this one footer line. Computing it in-line would be
  // circular; putting it only in a sidecar file would fail "token count reported" for a reader
  // who has the brief and nothing else.
  const measured = estimateTokens(body);
  const markdown = `${body}\n---\n\n**Budget.** Body above: ${measured.approx_tokens} approx tokens (${measured.characters} characters, ${measured.words} words), by ${measured.method}. This footer adds ~40. Machine-readable in \`estate-brief.stats.json\`.\n`;
  return {
    schema: BRIEF_SCHEMA,
    producer: AGENT_PROJECTION_PRODUCER,
    generated_at: generatedAt,
    graph_digest: digest,
    markdown,
    tokens: estimateTokens(markdown),
    stats: {
      nodes: nodes.length, edges: edges.length, entities: entities.length, relationships: relationships.length,
      capabilities: capabilities.length, envelope_kinds: envelopes.length, surprises: surprises.length,
      standing_refusals: census.standing_refusals, refusal_reason_codes: census.by_reason.length,
      communities: communities.communities.length, communities_refused: communities.refusals.length,
      fact_kinds: factKinds.length, fact_records: factKinds.reduce((sum, item) => sum + item.count, 0),
      core_share_of_nodes: percent(core, nodes.length),
    },
  };
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

const HELP = `Usage:
  node tools/estate-map/agent-projection.mjs brief       <graph.annotated.json> [--out <file.md>] [--stats <file.json>] [--generated-at <iso>] [--base <ref>] [--title <name>]
  node tools/estate-map/agent-projection.mjs communities <graph.annotated.json> [--out <file.jsonl>] [--refusals <file.jsonl>] [--census <file.json>] [--generated-at <iso>]
  node tools/estate-map/agent-projection.mjs manifest    <graph.annotated.json> [--out <file.json>] [--generated-at <iso>]
  node tools/estate-map/agent-projection.mjs subject     <graph.annotated.json> <subject-id-or-name>
  node tools/estate-map/agent-projection.mjs resource    <graph.annotated.json> <estate://uri>
  node tools/estate-map/agent-projection.mjs all         <graph.annotated.json> --out-dir <dir> [--generated-at <iso>] [--base <ref>]

The brief, the community summaries and the manifest are BUILD-TIME artifacts: deterministic,
regenerable and diffable. --generated-at defaults to ${DEFAULT_GENERATED_AT} so two runs over the
same graph are byte-identical.`;

async function readGraph(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }

export async function produceAll(graphFile, outDir, options = {}) {
  const graph = await readGraph(graphFile);
  const now = options.now || DEFAULT_GENERATED_AT;
  const index = buildSubjectIndex(graph);
  const communities = deriveCommunities(graph, { index, now });
  const manifest = buildResourceManifest(graph, { communities, now });
  const brief = buildEstateBrief(graph, { index, communities, manifest, now, base: options.base, title: options.title });
  await fs.mkdir(path.resolve(outDir), { recursive: true });
  const at = name => path.join(path.resolve(outDir), name);
  await fs.writeFile(at('estate-brief.md'), brief.markdown);
  await writeJson(at('estate-brief.stats.json'), { generated_at: now, graph_digest: brief.graph_digest, producer: AGENT_PROJECTION_PRODUCER, stats: brief.stats, tokens: brief.tokens });
  await writeJsonLines(at('community-summaries.jsonl'), communities.communities);
  await writeJsonLines(at('community-refusals.jsonl'), communities.refusals);
  await writeJson(at('community-census.json'), communities.census);
  await writeJson(at('resource-manifest.json'), manifest);
  return { brief, communities, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, graphFile, argument] = positional;
  if (options.help || !command || !graphFile) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const now = options['generated-at'] || DEFAULT_GENERATED_AT;
    if (command === 'all') {
      if (!options['out-dir']) throw new Error('all requires --out-dir <dir>');
      const { brief, communities, manifest } = await produceAll(graphFile, options['out-dir'], { now, base: options.base, title: options.title });
      console.log(`brief: ${brief.tokens.approx_tokens} approx tokens (${brief.tokens.characters} chars, ${brief.tokens.words} words) · ${communities.communities.length} community summaries, ${communities.refusals.length} refused · ${manifest.resources.length} resources + ${manifest.resourceTemplates.length} templates → ${path.resolve(options['out-dir'])}`);
      process.exit(0);
    }
    const graph = await readGraph(graphFile);
    if (command === 'brief') {
      const brief = buildEstateBrief(graph, { now, base: options.base, title: options.title });
      if (options.out) await fs.writeFile(path.resolve(options.out), brief.markdown); else process.stdout.write(brief.markdown);
      if (options.stats) await writeJson(path.resolve(options.stats), { generated_at: now, graph_digest: brief.graph_digest, producer: AGENT_PROJECTION_PRODUCER, stats: brief.stats, tokens: brief.tokens });
      if (options.out) console.log(`${brief.tokens.approx_tokens} approx tokens (${brief.tokens.characters} chars) → ${path.resolve(options.out)}`);
    } else if (command === 'communities') {
      const result = deriveCommunities(graph, { now });
      if (options.out) await writeJsonLines(path.resolve(options.out), result.communities);
      if (options.refusals) await writeJsonLines(path.resolve(options.refusals), result.refusals);
      if (options.census) await writeJson(path.resolve(options.census), result.census);
      if (!options.out && !options.refusals && !options.census) process.stdout.write(stableStringify(result.census));
      else console.log(`${result.communities.length} summarised · ${result.refusals.length} refused (${result.census.refusal_rate})`);
    } else if (command === 'manifest') {
      const manifest = buildResourceManifest(graph, { now });
      if (options.out) { await writeJson(path.resolve(options.out), manifest); console.log(`${manifest.resources.length} resources + ${manifest.resourceTemplates.length} templates → ${path.resolve(options.out)}`); }
      else process.stdout.write(stableStringify(manifest));
    } else if (command === 'subject') {
      if (!argument) throw new Error('subject requires <subject-id-or-name>');
      process.stdout.write(stableStringify(assembleSubject(graph, argument)));
    } else if (command === 'resource') {
      if (!argument) throw new Error('resource requires <estate://uri>');
      const value = readResource(graph, argument, { now });
      process.stdout.write(typeof value === 'string' ? value : stableStringify(value));
    } else throw new Error(`Unknown command: ${command}`);
  } catch (error) { console.error(error.message); process.exit(1); }
}

export { sha256 };
