// The ontology as a graph the normal graph application can draw. Every node it returns has the same shape as a graph node, with ids in
// the `ontology:` namespace, so the existing canvas, layout, folded bundles, inspector and trail work unchanged. These nodes and
// edges are a proposal: they are not part of the observed graph and nothing here is reviewed. Graph nodes appear only as the
// real ids a binding supplies, and a locator that finds evidence never makes a graph node the identity of a concept.
import { DISPOSITION_TEXT } from './coverage-artifact.mjs';
const FORM_LABEL = { responsibility: 'Responsibility', policy: 'Rule or constraint', practice: 'Procedure', strategy: 'Option among alternatives', type: 'Kind of thing', theme: 'Theme' };
const STAND_LABEL = ['Source-observed', 'Source and documents', 'Documents only', 'Code comments only', 'No located evidence'];
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}\u2026` : s ?? '');
const PAGE = 30;
const STATUS = 'proposed, not reviewed';

export function createOntologyMap({ explored, details, binding, coverage, queries, view, projection, lens = 'themes', coverageNote = null, loop = null }) {
  const C = explored.concepts, D = explored.domains, M = explored;
  const out = Array.from({ length: C.length }, () => []), inn = Array.from({ length: C.length }, () => []);
  M.relations.forEach((r, i) => { out[r[0]].push(i); inn[r[1]].push(i); });
  const domainOf = new Int32Array(C.length).fill(-1);
  D.forEach((d, i) => { if (d.set === 'reconciled') for (const m of d.members) domainOf[m] = i; });
  const groups = [...M.themes.reconciled.map(t => ({ ...t, theme: true })), { label: 'Not placed in a theme', definition: 'Domains the model did not include in any theme. Retained and reachable; absence from a theme is not a judgement.', domains: [], rest: true }];
  const listed = new Set(M.themes.reconciled.flatMap(t => t.domains));
  groups.at(-1).domains = D.map((d, i) => (d.set === 'reconciled' && !listed.has(i) ? i : -1)).filter(i => i >= 0);
  const groupOfDomain = new Map(groups.flatMap((g, gi) => g.domains.map(d => [d, gi])));
  const sum = (ids) => { const s = [0, 0, 0, 0, 0]; for (const i of ids) if (C[i][3] >= 0) s[C[i][3]] += 1; return s; };
  const basis = s => `${s[0] + s[1]} with source-observed support, ${s[2]} documents only, ${s[3]} comments only, ${s[4]} none located`;

  const gid = i => `ontology:group:${lens}:${i}`;
  // The canvas lays nodes out in fixed columns, so a drawn label is short; the full name stays in the node's properties.
  const node = (id, kind, label, properties, extra = {}) => ({ id, kind, label: clip(label, 18), properties: { status: STATUS, ...(label.length > 18 ? { name: label } : {}), ...properties }, ...extra });
  const edge = (from, to, relation, role, properties = {}) => ({ id: `ontology:e:${from}|${relation}|${to}`, from, to, relation, role, parent_end: role === 'structural' ? 'from' : undefined, properties });
  const realNode = (id, kind, label, properties = {}) => ({ id, kind, label, properties });

  const rootNode = () => node('ontology:root', 'OntologyRoot', 'Ontology (proposal)', { reviewed: false, concepts: C.length, domains: D.filter(d => d.set === 'reconciled').length, graph_projection: projection?.projection_id ?? null,
    note: 'Derived from source by a model and not reviewed. Raw source nodes are reachable from here, and the coverage node counts how much of the graph is.' });
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const coverageNode = () => node('ontology:coverage', 'OntologyCoverage', `Reach ${pct(coverage.share)}`, {
    reviewed: false, admitted_graph_nodes: coverage.admitted, reached: coverage.reached, not_reached: coverage.admitted - coverage.reached, share_label: coverage.label,
    by_disposition: coverage.counts, unplaced_reasons: coverage.unplacedReasons,
    note: 'Every admitted graph node, claim records included, is listed beneath this node so it can be opened. Only nodes a cited passage anchors, owns or participates with count as reached; that is a navigation reach, not a semantic score. Inventory files and discovery units are other denominators and are not graph nodes.' });
  const groupNode = i => { const g = groups[i], ids = g.domains.flatMap(d => D[d].members); return node(gid(i), 'OntologyGroup', g.label, { reviewed: false, definition: g.definition, domains: g.domains.length, concepts: ids.length, evidence_basis: basis(sum(ids)) }); };
  const domainNode = i => { const d = D[i]; return node(`ontology:domain:${i}`, 'OntologyDomain', d.label, { reviewed: false, source: M.sources[d.source], model_label: d.kind, definition: clip(d.definition, 700), concepts: d.members.length, evidence_basis: basis(sum(d.members)) }); };
  const conceptNode = i => {
    const c = C[i], k = details.get(c[0]);
    return node(`ontology:concept:${i}`, 'OntologyConcept', c[1], { reviewed: false, inferred_kind: `${FORM_LABEL[M.forms[c[2]]?.id] ?? 'Unclassified'} (set by the mapper, not reviewed)`, evidence_basis: STAND_LABEL[c[3]] ?? 'Unknown',
      cited_passages: c[7], source: M.sources[c[4]], domain: D[domainOf[i]]?.label ?? 'not placed in a domain', definition: clip(k?.definition, 700), human_decision_record: 'none captured (this does not show that no person decided)' });
  };

  const page = (rows, offset, limit) => rows.slice(offset, offset + limit);
  const grp = (relation, dir, role, kind, total, load) => ({ relation, direction: dir, role, kind, count: total, load });

  // Each node describes its neighbourhood as counted groups; a group loads a bounded page of rows on demand.
  async function describe(id) {
    const [, type, a, b, c] = id.split(':');
    if (id === 'ontology:root') {
      return { node: rootNode(), groups: [
        grp('contains', 'out', 'structural', 'OntologyGroup', groups.length, async (o, n) => page(groups.map((_, i) => i), o, n).map(i => ({ node: groupNode(i), edge: edge(id, gid(i), 'contains', 'structural') }))),
        grp('contains', 'out', 'structural', 'OntologyCoverage', 1, async () => [{ node: coverageNode(), edge: edge(id, 'ontology:coverage', 'contains', 'structural') }]),
        ...(loop ? [grp('contains', 'out', 'structural', 'OntologyProposal', 1, async () => [{ node: loopNode(), edge: edge(id, 'ontology:loop', 'contains', 'structural') }])] : []),
      ] };
    }
    if (id === 'ontology:loop' || type === 'loop') { const l = await describeLoop(id); if (l) return l; }
    if (type === 'group') {
      const g = groups[Number(b)];
      if (!g) return null;
      return { node: groupNode(Number(b)), groups: [
        grp('contains', 'in', 'structural', 'OntologyRoot', 1, async () => [{ node: rootNode(), edge: edge('ontology:root', id, 'contains', 'structural') }]),
        grp('contains', 'out', 'structural', 'OntologyDomain', g.domains.length, async (o, n) => page(g.domains, o, n).map(d => ({ node: domainNode(d), edge: edge(id, `ontology:domain:${d}`, 'contains', 'structural') }))),
      ] };
    }
    if (type === 'domain') {
      const d = D[Number(a)];
      if (!d || d.set !== 'reconciled') return null;
      const gi = groupOfDomain.get(Number(a));
      return { node: domainNode(Number(a)), groups: [
        ...(gi !== undefined ? [grp('contains', 'in', 'structural', 'OntologyGroup', 1, async () => [{ node: groupNode(gi), edge: edge(gid(gi), id, 'contains', 'structural') }])] : []),
        grp('contains', 'out', 'structural', 'OntologyConcept', d.members.length, async (o, n) => page(d.members, o, n).map(m => ({ node: conceptNode(m), edge: edge(id, `ontology:concept:${m}`, 'contains', 'structural') }))),
      ] };
    }
    if (type === 'concept') {
      const i = Number(a);
      if (!C[i]) return null;
      const groupsOut = [];
      if (domainOf[i] >= 0) groupsOut.push(grp('contains', 'in', 'structural', 'OntologyDomain', 1, async () => [{ node: domainNode(domainOf[i]), edge: edge(`ontology:domain:${domainOf[i]}`, id, 'contains', 'structural') }]));
      // Typed relationships keep the mapper's exact predicate and direction.
      for (const [dir, list] of [['out', out[i]], ['in', inn[i]]]) if (list.length) {
        groupsOut.push(grp('related (typed)', dir, 'flow', 'OntologyConcept', list.length, async (o, n) => page(list, o, n).map(ri => {
          const r = M.relations[ri], other = dir === 'out' ? r[1] : r[0];
          const props = { definition: r[3], cited_passages: r[4], relation_index: ri, status: STATUS };
          return { node: conceptNode(other), edge: { ...edge(dir === 'out' ? id : `ontology:concept:${other}`, dir === 'out' ? `ontology:concept:${other}` : id, r[2], 'flow', props), id: `ontology:rel:${ri}` } };
        })));
      }
      if (binding) {
        const found = binding.anchorsFor([i], { limit: 24 });
        if (found.total_anchors) groupsOut.push(grp('cited in (exact content match)', 'out', 'evidence', 'Document', found.total_anchors, async (o, n) => binding.anchorsFor([i], { limit: n, offset: o }).anchors
          .map(x => ({ node: realNode(x.node_id, 'Document', x.node_id.replace(/^doc:/u, '')), edge: edge(id, x.node_id, 'cited in (exact content match)', 'evidence', { passages: x.passages }) }))));
        if (found.located_nodes.total) groupsOut.push(grp('anchored in the quoted lines', 'out', 'evidence', 'LocatedNode', found.located_nodes.total, async () => found.located_nodes.nodes
          .map(x => ({ node: realNode(x.node_id, x.kind, x.label || x.node_id), edge: edge(id, x.node_id, 'anchored in the quoted lines', 'evidence', { passages: x.passages }) }))));
      }
      // Proposed anchors from a coverage loop sit beside the sealed ones under their own relation name, so the two cannot be confused.
      for (const [r, list] of (loopBindingsFor.get(C[i][0]) ?? new Map())) groupsOut.push(grp(`proposed anchor, round ${r} (not reviewed)`, 'out', 'evidence', 'LocatedNode', list.length, async (o, n) => page(list, o, n).map(b => ({ node: realNode(b.node_id, b.node_kind, b.node_label), edge: edge(id, b.node_id, `proposed anchor, round ${r} (not reviewed)`, 'evidence', { quote: clip(b.evidence?.quote, 200), file: b.evidence?.file, lines: `${b.evidence?.start_line}-${b.evidence?.end_line}`, status: STATUS }) }))));
      return { node: conceptNode(i), groups: groupsOut };
    }
    if (id === 'ontology:coverage') {
      const ds = coverage.dispositions();
      return { node: coverageNode(), groups: [
        grp('contains', 'in', 'structural', 'OntologyRoot', 1, async () => [{ node: rootNode(), edge: edge('ontology:root', id, 'contains', 'structural') }]),
        grp('contains', 'out', 'structural', 'OntologyCoverage', ds.length, async (o, n) => page(ds, o, n).map(([d, cnt]) => ({ node: dispositionNode(d, cnt), edge: edge(id, `ontology:cov:${d}`, 'contains', 'structural') }))),
      ] };
    }
    if (type === 'cov' && a && !b) {
      const cnt = coverage.counts[a];
      if (!cnt) return null;
      const repos = coverage.repositories(a);
      return { node: dispositionNode(a, cnt), groups: [
        grp('contains', 'in', 'structural', 'OntologyCoverage', 1, async () => [{ node: coverageNode(), edge: edge('ontology:coverage', id, 'contains', 'structural') }]),
        grp('contains', 'out', 'structural', 'OntologyCoverage', repos.length, async (o, n) => page(repos, o, n).map(([r, k]) => ({ node: repoNode(a, r, k), edge: edge(id, `ontology:cov:${a}:${r}`, 'contains', 'structural') }))),
      ] };
    }
    if (type === 'cov' && a && b) {
      const cnt = coverage.repositories(a).find(([r]) => r === b)?.[1];
      if (!cnt) return null;
      const rowsOf = async (o, n) => (await coverage.page(a, b, o, n)).map(r => ({
        node: realNode(r.node_id, r.kind, `${r.kind}: ${clip(r.file ?? r.node_id, 60)}${r.line ? `:${r.line}` : ''}`, { coverage: a, reason: r.reason ?? null }),
        edge: edge(id, r.node_id, 'lists', 'evidence', { disposition: a, reason: r.reason ?? null, via: r.via ?? r.owner ?? r.cited_by ?? null }) }));
      return { node: repoNode(a, b, cnt), groups: [
        grp('contains', 'in', 'structural', 'OntologyCoverage', 1, async () => [{ node: dispositionNode(a, coverage.counts[a]), edge: edge(`ontology:cov:${a}`, id, 'contains', 'structural') }]),
        grp('lists', 'out', 'evidence', 'GraphNode', cnt, rowsOf),
      ] };
    }
    return null;
  }
  // ---- coverage loop: a proposal layer, drawn apart from the sealed ontology ------------------------------------------------------------
  const conceptByAccession = new Map(C.map((c, i) => [c[0], i]));
  const loopBindingsFor = new Map();
  for (const r of loop ?? []) for (const b of r.bindings) {
    if (!conceptByAccession.has(b.concept)) continue;
    const perRound = loopBindingsFor.get(b.concept) ?? loopBindingsFor.set(b.concept, new Map()).get(b.concept);
    (perRound.get(r.round) ?? perRound.set(r.round, []).get(r.round)).push(b);
  }
  const n = x => Number(x).toLocaleString('en-US');
  const reachText = (c, which) => { const v = which === 'before' ? c.before : c.after_with_proposal_layer; return `${n(v.reached)} of ${n(coverage.admitted)} (${(v.share * 100).toFixed(2)}%)`; };
  const proposalNode = (id, label, properties) => node(id, 'OntologyProposal', label, { reviewed: false, layer: 'proposal on top of the sealed ontology, not accepted', ...properties });
  const loopNode = () => proposalNode('ontology:loop', 'Coverage loop', { rounds: loop.map(r => ({ round: r.round, reach_before: reachText(r.coverage, 'before'), reach_after_with_proposals: reachText(r.coverage, 'after') })), share_label: loop.at(-1).coverage.label,
    note: 'Rounds of an offline loop that read unreached parts of the graph and proposed new concepts and anchors. Everything here is a proposal. The sealed ontology and the graph are unchanged.' });
  const roundNode = r => proposalNode(`ontology:loop:${r.round}`, `Round ${r.round}`, { reach_before: reachText(r.coverage, 'before'), reach_after_with_proposals: reachText(r.coverage, 'after'), proposal_anchors_applied: r.coverage.proposal_anchors_applied, share_label: r.coverage.label,
    frontier_families: r.frontier.families, causes_before_model: r.frontier.causes_before_model, causes_after_model: r.causes_after_model, schema_completeness: r.measures.schema_completeness, grounding_completeness: r.measures.grounding_completeness, unresolved: r.measures.unresolved,
    concepts_before_after_compression: `${r.complexity.before.concepts} \u2192 ${r.complexity.after.concepts}`, cost_usd: r.cost?.usd, status: r.status });
  const propNode = (r, k) => { const p = r.proposals[k]; return proposalNode(`ontology:loop:${r.round}:concept:${k}`, p.label, { name: p.label, proposed_kind: p.semantic_category, definition: clip(p.definition, 700), inclusion: clip(p.inclusion, 400), exclusion: clip(p.exclusion, 400), instance_conditions: p.instance_conditions,
    witness: p.witness ? `${p.witness.file}:${p.witness.start_line}-${p.witness.end_line}: ${clip(p.witness.quote, 200)}` : null }); };
  const groupNodeLoop = (r, k) => { const g = r.groups[k]; return proposalNode(`ontology:loop:${r.round}:group:${k}`, g.canonical.label, { name: g.canonical.label, relation_to_existing: g.relation.replaceAll('_', ' '), definition: clip(g.canonical.definition, 600), reason: clip(g.reason, 500), members: g.members.length, instance_properties: g.canonical.instance_properties }); };
  async function describeLoop(id) {
    if (!loop) return null;
    const parts = id.split(':'), r = loop.find(x => String(x.round) === parts[2]);
    if (id === 'ontology:loop') {
      return { node: loopNode(), groups: [grp('contains', 'in', 'structural', 'OntologyRoot', 1, async () => [{ node: rootNode(), edge: edge('ontology:root', id, 'contains', 'structural') }]),
        grp('contains', 'out', 'structural', 'OntologyProposal', loop.length, async (o, k) => page(loop, o, k).map(x => ({ node: roundNode(x), edge: edge(id, `ontology:loop:${x.round}`, 'contains', 'structural') })))] };
    }
    if (!r) return null;
    const rid = `ontology:loop:${r.round}`;
    if (parts.length === 3) {
      return { node: roundNode(r), groups: [grp('contains', 'in', 'structural', 'OntologyProposal', 1, async () => [{ node: loopNode(), edge: edge('ontology:loop', rid, 'contains', 'structural') }]),
        grp('proposes concept', 'out', 'structural', 'OntologyProposal', r.proposals.length, async (o, k) => page(r.proposals.map((_, i) => i), o, k).map(i => ({ node: propNode(r, i), edge: edge(rid, `${rid}:concept:${i}`, 'proposes concept', 'structural') }))),
        grp('groups proposals', 'out', 'structural', 'OntologyProposal', r.groups.length, async (o, k) => page(r.groups.map((_, i) => i), o, k).map(i => ({ node: groupNodeLoop(r, i), edge: edge(rid, `${rid}:group:${i}`, 'groups proposals', 'structural') })))] };
    }
    if (parts[3] === 'concept') {
      const p = r.proposals[Number(parts[4])];
      if (!p) return null;
      const bound = r.bindings.filter(b => b.concept === p.proposal_id);
      return { node: propNode(r, Number(parts[4])), groups: [grp('proposes concept', 'in', 'structural', 'OntologyProposal', 1, async () => [{ node: roundNode(r), edge: edge(rid, id, 'proposes concept', 'structural') }]),
        grp('would anchor (proposal)', 'out', 'evidence', 'LocatedNode', bound.length, async (o, k) => page(bound, o, k).map(b => ({ node: realNode(b.node_id, b.node_kind, b.node_label), edge: edge(id, b.node_id, 'would anchor (proposal)', 'evidence', { quote: clip(b.evidence?.quote, 200), file: b.evidence?.file, lines: `${b.evidence?.start_line}-${b.evidence?.end_line}`, status: STATUS }) })))] };
    }
    if (parts[3] === 'group') {
      const g = r.groups[Number(parts[4])];
      if (!g) return null;
      const members = g.members.map(pid => r.proposals.findIndex(p => p.proposal_id === pid)).filter(i => i >= 0);
      const existing = conceptByAccession.get(g.existing_id);
      return { node: groupNodeLoop(r, Number(parts[4])), groups: [grp('groups proposals', 'in', 'structural', 'OntologyProposal', 1, async () => [{ node: roundNode(r), edge: edge(rid, id, 'groups proposals', 'structural') }]),
        grp('groups member (proposal)', 'out', 'flow', 'OntologyProposal', members.length, async (o, k) => page(members, o, k).map(i => ({ node: propNode(r, i), edge: edge(id, `${rid}:concept:${i}`, 'groups member (proposal)', 'flow') }))),
        ...(existing !== undefined ? [grp(`${g.relation.replaceAll('_', ' ')} (proposal)`, 'out', 'flow', 'OntologyConcept', 1, async () => [{ node: conceptNode(existing), edge: edge(id, `ontology:concept:${existing}`, `${g.relation.replaceAll('_', ' ')} (proposal)`, 'flow') }])] : [])] };
    }
    return null;
  }

  const dispositionNode = (d, cnt) => { const [name, text] = DISPOSITION_TEXT[d] ?? [d.replaceAll('_', ' '), '']; return node(`ontology:cov:${d}`, 'OntologyCoverage', `${name} (${cnt.toLocaleString('en-US')})`, { reviewed: false, counted_as_reached: coverage.isReached(d), description: text, share_label: coverage.label,
    ...(d === 'unplaced' ? { reasons: coverage.unplacedReasons } : {}) }); };
  const repoNode = (d, r, cnt) => node(`ontology:cov:${d}:${r}`, 'OntologyCoverage', `${r} (${cnt.toLocaleString('en-US')})`, { reviewed: false, counted_as_reached: coverage.isReached(d), disposition: d, repository: r });

  return Object.freeze({
    overview: () => ({ nodes: [rootNode(), ...groups.map((_, i) => groupNode(i)), coverageNode()], edges: [...groups.map((_, i) => edge('ontology:root', gid(i), 'contains', 'structural')), edge('ontology:root', 'ontology:coverage', 'contains', 'structural')] }),
    isOntologyId: id => typeof id === 'string' && id.startsWith('ontology:'),
    // The same result a graph node query returns: the node, a bounded set of neighbours per group, and a counted bundle for the rest.
    async node(id, { quota = PAGE } = {}) {
      const d = await describe(id);
      if (!d) return null;
      const neighbors = [], bundles = [], withheld = {};
      for (const g of d.groups) {
        const rows = await g.load(0, quota);
        neighbors.push(...rows);
        bundles.push({ role: g.role, relation: g.relation, direction: g.direction, kind: g.kind, count: g.count, next_queries: [] });
        if (g.count > rows.length) withheld[g.kind] = (withheld[g.kind] ?? 0) + g.count - rows.length;
      }
      return { node: d.node, neighbors, bundles, truncated: Object.keys(withheld).length > 0, withheld_by_kind: withheld };
    },
    async neighbors(id, { relation, direction, offset = 0, limit = PAGE }) {
      const d = await describe(id);
      const g = d?.groups.find(x => x.relation === relation && x.direction === direction);
      if (!g) return null;
      const rows = await g.load(offset, Math.min(Math.max(Number(limit) || PAGE, 1), 60));
      return { adjacent_nodes: rows.map(r => r.node), edges: rows.map(r => r.edge), total: g.count, truncated: offset + rows.length < g.count };
    },
    search(term, limit = 30) {
      const t = String(term ?? '').toLowerCase().trim();
      if (!t) return [];
      const hits = [];
      groups.forEach((g, i) => { if (g.label.toLowerCase().includes(t)) hits.push({ id: gid(i), kind: 'OntologyGroup', label: g.label }); });
      D.forEach((d, i) => { if (d.set === 'reconciled' && d.label.toLowerCase().includes(t)) hits.push({ id: `ontology:domain:${i}`, kind: 'OntologyDomain', label: d.label }); });
      for (let i = 0; i < C.length && hits.length < limit; i++) if (C[i][1].toLowerCase().includes(t)) hits.push({ id: `ontology:concept:${i}`, kind: 'OntologyConcept', label: C[i][1] });
      return hits.slice(0, limit);
    },
    coverageSummary: () => ({ admitted: coverage.admitted, reached: coverage.reached, share: coverage.share, label: coverage.label, counts: coverage.counts, unplaced_reasons: coverage.unplacedReasons, by_plane: coverage.byPlane, denominators: coverage.denominators, note: coverageNote }),
    explain: id => coverage.explain(id),
  });
}
