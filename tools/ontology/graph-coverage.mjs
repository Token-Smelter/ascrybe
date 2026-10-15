// Offline reach of a projected source graph by an ontology generation. For every admitted graph node it records whether a cited passage
// anchors the node, whether the node is an owned part of, or only participates with, an anchored node, or whether nothing reaches it. No
// model is called and nothing is assigned to make a number larger.
//
// What each disposition does and does not say:
//  - proposed_subject: a node a proposal binds, with a typed predicate, to a concept; counted apart from evidence anchors and from the sealed ontology.
//  - evidence_anchored: the node's own line lies inside the quoted lines of a passage that supports a concept (a support evidence row, or an
//    affirming assertion's occurrence) in the same repository and file, at the commit the graph was built from. That is an association with
//    a cited passage. It is not a statement that the node is the subject, type or identity the concept names.
//  - anchored_entity: an entity the graph's own identity relation binds to an evidence-anchored observation. Still the entity under a cited
//    passage, not the concept's subject.
//  - owned_detail: reached from one of those over an OWNERSHIP relation (the target is part of the source's own declaration or structure)
//    within the policy depth. Document and section hierarchy is never walked: a cited README or section does not own the uncited rest of it.
//  - participates_with_grounded: one step over a PARTICIPATION relation (a message a module emits, a capability it requires). Shared things
//    are not owned, and nothing is walked onward from them.
//  - cited_document_locator: a document whose file is cited. A navigational locator, never a seed and never counted as reached.
//  - locator_root: a repository or commit root, never a semantic parent.
//  - unplaced: nothing in the generation reaches it, with the reason; policy limits are reported apart from nodes with no route at all.
// Every proportion built from these is an evidence-anchor and navigation reach, not a semantic correctness score.
export const COVERAGE_POLICY = Object.freeze({
  schema: 'estate-map/graph-coverage-policy/v2',
  max_depth: 3,
  // owner -> owned: the target is part of the source's own declaration, structure or verification record
  ownership_relations: ['declares_symbol', 'declares_table', 'declares_sql_object', 'declares_resource', 'declares_config', 'declares_service', 'declares_value',
    'registers_route', 'provides_capability', 'contains', 'has_obligation_result', 'adjudicated_by', 'derived_from', 'supported_by', 'unresolved_against', 'evidenced_by'],
  // one hop, never walked onward: the source takes part in something it does not own
  participation_relations: ['emits', 'consumes', 'publishes_envelope', 'requires_capability', 'exposes_route', 'member_of', 'about', 'realized_by'],
  identity_relations: ['identifies'],
  derived_relations: ['read_from'],
  never_walked: ['imports', 'depends_on', 'calls_capability', 'observed_in', 'references', 'relates_assertion', 'asserted_in', 'consumes_package', 'publishes_to', 'tf_ref', 'uses_infra', 'has_source_commit'],
  // containment from these is hierarchy of a file or a repository, not ownership by what a passage cited
  contains_never_from: ['Repository', 'SourceCommit', 'Project', 'RepositoryCoverage', 'Document', 'DocumentSection'],
  locator_root_kinds: ['Repository', 'SourceCommit', 'Project', 'RepositoryCoverage'],
  claim_layer_kinds: ['Claim', 'Evidence', 'AdjudicationReceipt', 'ObligationResult'],
});

export const DISPOSITIONS = Object.freeze(['evidence_anchored', 'anchored_entity', 'proposed_subject', 'owned_detail', 'participates_with_grounded', 'cited_document_locator', 'locator_root', 'unplaced']);
const REACHED = new Set(['evidence_anchored', 'anchored_entity', 'proposed_subject', 'owned_detail', 'participates_with_grounded']);
export const isReached = disposition => REACHED.has(disposition);

const splitRepoPath = (value, repos) => { const s = String(value ?? ''); const i = s.indexOf('/'); return i > 0 && repos.has(s.slice(0, i)) ? [s.slice(0, i), s.slice(i + 1)] : [null, null]; };

/** Support evidence and affirming assertions as exact repository/file/line/commit anchors. Counterexamples and denials never anchor. */
export function anchorsOfGeneration(generation) {
  const anchors = [];
  for (const c of generation.collections) for (const e of c.evidence) {
    if (e.role !== 'support' || !Number.isInteger(e.start_line)) continue;
    anchors.push({ repo: e.repository, file: e.path, commit: e.commit_sha ?? null, start: e.start_line, end: Number.isInteger(e.end_line) ? e.end_line : e.start_line, concept: e.concept_accession, via: 'evidence', ref: e.evidence_id });
  }
  for (const a of generation.assertions) {
    const o = a.occurrence;
    if (a.polarity === 'deny' || !o || !Number.isInteger(o.start_line)) continue;
    anchors.push({ repo: o.repository, file: o.path, commit: o.commit_sha ?? null, start: o.start_line, end: Number.isInteger(o.end_line) ? o.end_line : o.start_line, concept: a.concept_accession, via: 'assertion', ref: a.assertion_id });
  }
  return anchors;
}

/** Keeps only anchors read at the commit the graph was built from. A repository with no recorded graph commit cannot be checked, so none of its anchors is used. */
export function guardAnchorsByPin(anchors, graphPins) {
  const kept = [], dropped = { pin_mismatch: 0, no_graph_pin: 0, no_anchor_commit: 0 };
  for (const a of anchors) {
    const pin = graphPins?.[a.repo];
    if (!pin) dropped.no_graph_pin += 1; else if (!a.commit) dropped.no_anchor_commit += 1; else if (a.commit !== pin) dropped.pin_mismatch += 1; else kept.push(a);
  }
  return { kept, dropped };
}

/**
 * nodes: iterable of {node_id, kind, plane, properties}; edges: iterable of {relation, from, to}. Both are consumed once, in order, so a
 * caller can stream them from disk. graphPins names the commit the graph was built from per repository; anchors read at any other commit are
 * not applied. Returns per-node states and the counts needed to read them honestly.
 */
export async function computeCoverage({ nodes, edges, anchors, repositories, graphPins, bindings = [], policy = COVERAGE_POLICY }) {
  if (!graphPins) throw new Error('graphPins is required: anchors are only applied where the graph and the passage name the same commit');
  const { kept, dropped } = guardAnchorsByPin(anchors, graphPins);
  const repos = new Set(repositories);
  const info = new Map();
  const filesWithNodes = new Map();
  for await (const n of nodes) {
    const p = n.properties ?? {};
    let repo = p.repository ?? null, file = p.file ?? p.document_path ?? null;
    let line = p.line != null && Number.isInteger(Number(p.line)) ? Number(p.line) : (p.source_line != null && Number.isInteger(Number(p.source_line)) ? Number(p.source_line) : null);
    if (!repo || !file) {
      const [r, f] = splitRepoPath(p.path ?? p.namespace ?? p.document ?? p.source_path, repos);
      if (r) { repo ??= r; file ??= f; }
    }
    if (repo && file && file.startsWith(`${repo}/`)) file = file.slice(repo.length + 1);
    if (n.kind === 'Evidence' || n.kind === 'AdjudicationReceipt' || n.kind === 'ObligationResult') line = null;
    info.set(n.node_id, { k: n.kind, r: repo, f: file, l: line, pl: n.plane, lb: n.label == null ? null : String(n.label).slice(0, 160) });
    if (repo && file && line != null) { const key = `${repo}\u0000${file}`; (filesWithNodes.get(key) ?? filesWithNodes.set(key, []).get(key)).push([line, n.node_id, n.kind]); }
  }
  // A section runs from its heading to the line before the next heading of the same file.
  const spanEnd = new Map();
  for (const rows of filesWithNodes.values()) {
    const sections = rows.filter(r => r[2] === 'DocumentSection').sort((a, b) => a[0] - b[0]);
    sections.forEach((s, i) => spanEnd.set(s[1], i + 1 < sections.length ? sections[i + 1][0] - 1 : Infinity));
  }
  const anchorsByFile = new Map();
  for (const a of kept) { const key = `${a.repo}\u0000${a.file}`; (anchorsByFile.get(key) ?? anchorsByFile.set(key, []).get(key)).push(a); }

  const state = new Map();
  const anchoredBy = new Map();
  for (const [id, n] of info) {
    if (policy.locator_root_kinds.includes(n.k)) { state.set(id, { d: 'locator_root' }); continue; }
    if (!n.r || !n.f) continue;
    const list = anchorsByFile.get(`${n.r}\u0000${n.f}`);
    if (!list) continue;
    if (n.k === 'Document') { state.set(id, { d: 'cited_document_locator', cited_by: list.slice(0, 3).map(a => a.concept) }); continue; }
    if (n.l == null) continue;
    const hi = n.k === 'DocumentSection' ? spanEnd.get(id) ?? n.l : n.l;
    const hit = list.filter(a => a.start <= hi && a.end >= n.l);
    if (hit.length) anchoredBy.set(id, hit.slice(0, 3));
  }
  const seeds = [];
  for (const [id, hit] of anchoredBy) { state.set(id, { d: 'evidence_anchored', via: hit.map(a => ({ concept: a.concept, by: a.via, ref: a.ref })) }); seeds.push(id); }

  // A proposed typed instance binding names a graph node exactly. It seeds the walk as a labelled proposal, never as an evidence anchor, and never over a stronger state.
  for (const b of bindings) { if (info.has(b.node_id) && !state.has(b.node_id)) { state.set(b.node_id, { d: 'proposed_subject', via: [{ concept: b.concept, predicate: b.predicate, ref: b.ref }] }); seeds.push(b.node_id); } }
  const owned = new Map(), identifies = new Map(), derived = new Map(), participates = new Map(), unwalked = [], excluded = {};
  const count = (key) => { excluded[key] = (excluded[key] ?? 0) + 1; };
  for await (const e of edges) {
    const r = e.relation, fromKind = info.get(e.from)?.k;
    if (policy.identity_relations.includes(r)) { (identifies.get(e.from) ?? identifies.set(e.from, []).get(e.from)).push(e.to); continue; }
    if (policy.derived_relations.includes(r)) { (derived.get(e.to) ?? derived.set(e.to, []).get(e.to)).push(e.from); continue; }
    if (policy.participation_relations.includes(r)) { (participates.get(e.from) ?? participates.set(e.from, []).get(e.from)).push([r, e.to]); continue; }
    if (policy.ownership_relations.includes(r)) {
      if (r === 'contains' && policy.contains_never_from.includes(fromKind)) { count(`contains from ${fromKind} (hierarchy, not ownership)`); continue; }
      (owned.get(e.from) ?? owned.set(e.from, []).get(e.from)).push([r, e.to]); continue;
    }
    count(r);
    if (r !== 'observed_in' && r !== 'has_source_commit' && r !== 'asserted_in') unwalked.push([r, e.from, e.to]);
  }
  for (const id of [...anchoredBy.keys()]) for (const t of identifies.get(id) ?? []) if (!state.has(t)) { state.set(t, { d: 'anchored_entity', via: [{ identified_by: id, relation: 'identifies', concepts: anchoredBy.get(id).map(a => a.concept) }] }); seeds.push(t); }

  // Bounded ownership walk from nodes anchored by a cited passage. Participation is one hop and ends there.
  let frontier = seeds.map(id => [id, 0]);
  const owners = new Map(), atLimit = [];
  while (frontier.length) {
    const next = [];
    for (const [id, depth] of frontier) {
      const out = [...(owned.get(id) ?? []), ...(derived.get(id) ?? []).map(t => ['read_from', t])];
      if (depth >= policy.max_depth) { for (const [, t] of out) atLimit.push(t); continue; }
      for (const [r, t] of out) {
        (owners.get(t) ?? owners.set(t, new Set()).get(t)).add(id);
        if (state.has(t)) continue;
        state.set(t, { d: 'owned_detail', via: [{ owner: id, relation: r, depth: depth + 1 }] });
        next.push([t, depth + 1]);
      }
    }
    frontier = next;
  }
  for (const [t, o] of owners) { const s = state.get(t); if (s?.d === 'owned_detail') s.owners_reached = o.size; }
  const reachedNow = [...state].filter(([, s]) => REACHED.has(s.d)).map(([id]) => id);
  for (const id of reachedNow) for (const [r, t] of participates.get(id) ?? []) if (!state.has(t)) state.set(t, { d: 'participates_with_grounded', via: [{ participant_of: id, relation: r }] });

  // Unreached nodes, with the reason. Policy limits are separated from nodes that have no route at all.
  const limited = new Set(atLimit), viaUnwalked = new Map();
  for (const [r, from, to] of unwalked) if (REACHED.has(state.get(from)?.d) && !state.has(to) && !viaUnwalked.has(to)) viaUnwalked.set(to, r);
  const citedFiles = new Set(anchorsByFile.keys());
  for (const [id, n] of info) {
    if (state.has(id)) continue;
    let reason;
    if (limited.has(id)) reason = 'policy_depth_limit';
    else if (viaUnwalked.has(id)) reason = `reachable_only_via_unwalked_relation:${viaUnwalked.get(id)}`;
    else if (n.k === 'ExtractionRefusal') reason = 'extraction_refusal';
    else if (policy.claim_layer_kinds.includes(n.k)) reason = 'claim_layer_unreached';
    else if (n.r && n.f && citedFiles.has(`${n.r}\u0000${n.f}`)) reason = 'file_cited_elsewhere_in_it';
    else if (n.r && n.f) reason = 'file_not_cited';
    else reason = 'no_locator_and_no_grounded_owner';
    state.set(id, { d: 'unplaced', reason });
  }
  return { info, state, excluded_relations: excluded, anchors_total: anchors.length, anchors_applied: kept.length, anchors_dropped: dropped, anchored_nodes: anchoredBy.size };
}

/** Aggregates the per-node states into the numbers a page prints. */
export function summariseCoverage({ info, state }) {
  const by = keyFn => { const m = {}; for (const [id, s] of state) { const k = keyFn(id, s); const row = m[k] ??= Object.fromEntries(DISPOSITIONS.map(d => [d, 0])); row[s.d] += 1; } return m; };
  const total = Object.fromEntries(DISPOSITIONS.map(d => [d, 0])); for (const s of state.values()) total[s.d] += 1;
  const reasons = {}; for (const s of state.values()) if (s.d === 'unplaced') reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  const reached = [...state.values()].filter(s => REACHED.has(s.d)).length;
  return { admitted_nodes: state.size, by_disposition: total, reached_nodes: reached,
    reach_share_of_admitted_nodes: +(reached / (state.size || 1)).toFixed(4),
    reach_share_label: 'share of admitted graph nodes anchored by a cited passage or owned by/participating with one; an evidence-anchor and navigation reach, not a semantic correctness score',
    unplaced_reasons: reasons, by_kind: by(id => info.get(id).k), by_repository: by(id => info.get(id).r ?? '(no repository locator)'), by_plane: by(id => info.get(id).pl ?? '(none)') };
}
