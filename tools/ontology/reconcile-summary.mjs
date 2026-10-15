// Deterministic summary of a reconciliation against the generation it read. No model call. It separates what was shown to the model
// from what the model returned, and measures canonical proposals against the active concepts instead of calling them a reduction.
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const count = (rows, key) => rows.reduce((acc, r) => { const k = key(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n += 1; return n / (a.size + b.size - n || 1); };

export function reconcileSummary({ generation, secondaryDomains, reconciliation }) {
  const concepts = generation.collections.flatMap(c => c.concepts.map(k => ({ accession: k.accession, source_id: c.collection_id })));
  const disp = reconciliation.dispositions.rows, byAcc = new Map(disp.map(r => [r.accession, r]));
  const sources = [...new Set(concepts.map(c => c.source_id))];
  const primaryDomains = reconciliation.domains.source_domains;
  const sizes = primaryDomains.map(d => d.concepts.length);

  const coverage = {
    concepts_given_to_model: concepts.length, // every retained concept was placed in a batch; this is input, not a result
    returned: count(disp, r => r.disposition),
    assigned_share: disp.filter(r => r.disposition === 'assigned').length / concepts.length,
    by_source: Object.fromEntries(sources.map(s => [s, count(disp.filter(r => r.source_id === s), r => r.disposition)])),
    note: 'Assignment means the model placed the concept in a domain. It is not validated semantic coverage, and no decisive quote for a domain claim has been checked.',
  };

  const sizeBands = { one: sizes.filter(n => n === 1).length, two_to_three: sizes.filter(n => n >= 2 && n <= 3).length, four_to_nine: sizes.filter(n => n >= 4 && n <= 9).length, ten_or_more: sizes.filter(n => n >= 10).length };
  const perSource = Object.fromEntries(sources.map(s => { const mine = primaryDomains.filter(d => d.source_id === s); return [s, { domains: mine.length, concepts_assigned: mine.reduce((n, d) => n + d.concepts.length, 0), median_concepts_per_domain: median(mine.map(d => d.concepts.length)), carried_unmerged: mine.filter(d => d.carried_unmerged).length }]; }));
  const fragmentation = { primary_source_domains: primaryDomains.length, secondary_source_domains: secondaryDomains.domains.length, median_concepts_per_domain: median(sizes), size_bands: sizeBands, per_source: perSource,
    note: 'A larger number of source domains is not an improvement by itself. Many small domains may be over-fragmentation of the same subjects.' };

  // How each earlier domain's concepts were distributed by the new pass, with both definitions side by side.
  const primarySets = primaryDomains.map(d => ({ d, set: new Set(d.concepts) }));
  const comparison = secondaryDomains.domains.map(g => {
    const set = new Set(g.concepts), spread = new Map();
    for (const a of set) { const r = byAcc.get(a); if (r?.domain_id) spread.set(r.domain_id, (spread.get(r.domain_id) ?? 0) + 1); }
    const top = [...spread].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => { const l = primarySets.find(x => x.d.domain_id === id); return { domain_id: id, label: l.d.label, kind: l.d.kind, definition: l.d.definition, shared_concepts: n, jaccard: Number(jaccard(set, l.set).toFixed(3)) }; });
    return { secondary_domain_id: g.domain_id, source_id: g.source_id, label: g.label, definition: g.definition, concepts_shown_to_secondary_step: g.concepts.length, spread_over_primary_domains: spread.size,
      unassigned_by_primary: [...set].filter(a => byAcc.get(a)?.disposition !== 'assigned').length, nearest_primary_domains: top };
  });

  // Canonical proposals against the active concepts. Only the heads are active; the other members are candidates that were never active.
  const proposals = reconciliation.clusters.canonical, heads = new Set(proposals.map(c => c.head_accession));
  const memberTotal = proposals.reduce((n, c) => n + c.members.length, 0);
  const withHead = proposals.filter(c => c.members.includes(c.head_accession));
  const clusters = { clusters_resolved: reconciliation.clusters.resolved, active_concepts_in_those_clusters: heads.size, active_concepts_total: concepts.length,
    members_considered: memberTotal, canonical_proposals: proposals.length, proposals_by_relation: count(proposals, c => c.relation),
    members_by_relation: proposals.reduce((a, c) => ({ ...a, [c.relation]: (a[c.relation] ?? 0) + c.members.length }), {}),
    proposals_containing_the_active_head: withHead.length, proposals_without_the_active_head: proposals.length - withHead.length,
    single_member_proposals: proposals.filter(c => c.members.length === 1).length, disagreements_with_earlier_judgements: reconciliation.clusters.disagreements.length,
    if_every_proposal_were_accepted: { active_concepts_would_be: concepts.length - heads.size + proposals.length, change_from_active: proposals.length - heads.size },
    note: 'These are proposals, none accepted. Only the head of each cluster is an active concept, so a proposal that groups candidates with a head does not lower the active count; proposals without the head are new vocabulary. Accepting every proposal would not reduce the vocabulary, and it is reported as such.' };

  return { schema: 'estate-map/reconcile-summary/v1', base_generation_id: generation.generation_id, model_config: reconciliation.model_config, coverage, fragmentation, comparison, clusters };
}

// A lean model for the page: the interpretation, its counts, and the hand-off traces. Concept detail stays in the generation view.
export function reconcileViewModel({ generation, reconciliation, summary, traces = [], calls = null }) {
  const label = new Map(generation.collections.flatMap(c => c.concepts.map(k => [k.accession, k.label])));
  const domains = reconciliation.domains.source_domains.map(d => ({ domain_id: d.domain_id, source_id: d.source_id, label: d.label, kind: d.kind, definition: d.definition, concept_count: d.concepts.length,
    sample_concepts: d.concepts.slice(0, 6).map(a => ({ accession: a, label: label.get(a) ?? a })), members: d.concepts, carried_unmerged: d.carried_unmerged }));
  const proposalsByHead = Map.groupBy(reconciliation.clusters.canonical, c => c.head_accession);
  const clusters = [...proposalsByHead].sort((a, b) => b[1][0].cluster_size - a[1][0].cluster_size).slice(0, 30).map(([head, groups]) => ({ head_accession: head, head_label: label.get(head) ?? head, source_id: groups[0].source_id, cluster_size: groups[0].cluster_size,
    proposals: groups.map(g => ({ label: g.canonical?.label ?? null, relation: g.relation, members: g.members.length, contains_head: g.members.includes(head), reason: g.reason })) }));
  const gaps = reconciliation.dispositions.rows.filter(r => r.disposition !== 'assigned');
  const gapSummary = Object.entries(gaps.reduce((a, r) => { const k = `${r.source_id}|${r.disposition}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})).map(([k, n]) => ({ source_id: k.split('|')[0], disposition: k.split('|')[1], concepts: n }));
  const reasons = gaps.filter(r => r.reason).slice(0, 25).map(r => ({ accession: r.accession, label: label.get(r.accession) ?? r.accession, source_id: r.source_id, disposition: r.disposition, reason: r.reason }));
  const lean = t => ({ trace_id: t.trace_id, label: t.label, findings: t.findings.map(f => ({ ...f, refs: (f.refs ?? []).slice(0, 8) })),
    pins: [t.a, t.b].map(s => ({ repo: s.repo, ok: s.ok, path: s.path ?? null, start_line: s.start_line ?? null, end_line: s.end_line ?? null, commit_sha: s.commit_sha ?? null, search_only: Boolean(s.search_only), problem: s.problem ?? null })),
    terms_searched: t.terms_searched ?? null, static_only: true });
  return { schema: 'estate-map/reconcile-view/v1', proposal: true, accepted: false, base_generation_id: reconciliation.base_generation_id, model_config: reconciliation.model_config, calls,
    summary: { coverage: summary.coverage, fragmentation: summary.fragmentation, clusters: summary.clusters, comparison: summary.comparison },
    domains, themes: reconciliation.domains.themes.themes, paths: reconciliation.domains.themes.paths, clusters, gaps: gapSummary, gap_reasons: reasons, unplaced: gaps.map(r => ({ accession: r.accession, disposition: r.disposition, reason: r.reason ?? null })), failures: reconciliation.failures, traces: traces.map(lean) };
}
