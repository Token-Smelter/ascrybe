// Offline diagnostics over an existing estate generation, its domains and its coverage. No model is called. It measures what the
// domain map was built from, where the evidence comes from (product source, tests, tooling, documentation), which concepts are
// near-duplicates by already-reviewed identity candidates, which domains lack direct source evidence, and whether the proposed cross-source
// paths have any exact evidence linking their steps. Provenance classes come from path shape alone; none names a domain.
export const DIAGNOSTICS_SCHEMA = 'estate-map/ontology-estate-diagnostics/v1';
const CLASS_ORDER = ['product_source', 'tests', 'tooling', 'operational_docs', 'documentation', 'configuration_infra', 'research_or_data_pages', 'unclassified'];

/** Where a path sits: decided by directory and file-name shape, not by what the file is about. */
export function provenanceOf(path) {
  const p = String(path).toLowerCase(), parts = p.split('/'), file = parts.at(-1), dirs = parts.slice(0, -1);
  const has = re => dirs.some(d => re.test(d));
  if (has(/^(tests?|__tests__|spec|specs|e2e|androidtest|uitests?|fixtures?|mocks?|testing|__mocks__)$/u) || /(\.|_|-)(test|spec|tests)\.[a-z0-9]+$/u.test(file) || /^test_/u.test(file) || /tests?\.(swift|kt|java)$/u.test(file)) return 'tests';
  if (has(/^(scripts?|tools?|tooling|\.github|\.circleci|ci|workflows|bin|build-logic|buildsrc|fastlane)$/u) || /^(makefile|dockerfile)$/u.test(file) || /\.(sh|bash|zsh)$/u.test(file)) return 'tooling';
  if (has(/^(reports?|retros?|retrospectives?|operational|runbooks?|postmortems?|audits?|reviews?|logs?|parcel-orders?|handoffs?|sessions?)$/u) || /(report|audit|review|log|handoff|retro)[^/]*\.(md|html|txt)$/u.test(file)) return 'operational_docs';
  if (has(/^(research|runs|sources|market|corpus)$/u) || /\.html?$/u.test(file) && has(/^(research|runs|sources)$/u)) return 'research_or_data_pages';
  if (/\.(md|mdx|rst|adoc|txt)$/u.test(file) || has(/^(docs?|documentation|design|specs?|adr|decisions?|ai-docs)$/u)) return 'documentation';
  if (has(/^(infra|infrastructure|cdk|terraform|deploy|deployment|config|configs|k8s|helm)$/u) || /\.(ya?ml|toml|ini|json|plist|xcconfig|gradle|kts|pbxproj|tf)$/u.test(file)) return 'configuration_infra';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|swift|kt|java|m|mm|php|go|rs|rb|cs|sql|css|scss|html?)$/u.test(file)) return 'product_source';
  return 'unclassified';
}

const tally = (rows, key) => rows.reduce((acc, r) => { const k = key(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const share = (counts, total) => Object.fromEntries(CLASS_ORDER.filter(c => counts[c]).map(c => [c, Number((counts[c] / Math.max(1, total)).toFixed(3))]));
const tokens = value => new Set((String(value).toLowerCase().match(/[a-z][a-z0-9]{3,}/gu) ?? []));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n += 1; return n / (a.size + b.size - n); };
const IDENT = /\b[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+){1,}\b|\b[a-z]+[A-Z][A-Za-z0-9]{5,}\b/gu;

export function estateDiagnostics({ generation, domains, coverage, domainCatalogue = 120, processShare = 0.6 }) {
  const concepts = generation.collections.flatMap(c => c.concepts.map(k => ({ ...k, source: c.collection_id })));
  const conceptBy = new Map(concepts.map(k => [k.accession, k]));
  const evidenceBy = Map.groupBy(generation.collections.flatMap(c => c.evidence.map(e => ({ ...e, source: c.collection_id }))), e => e.concept_accession);
  const assertionsBy = Map.groupBy(generation.assertions, a => a.concept_accession);
  const standing = new Map(generation.concept_standing.map(s => [s.accession, s.standing]));
  const candidatesBy = new Map(generation.collections.map(c => [c.collection_id, c.candidates]));
  const weight = k => (evidenceBy.get(k.accession)?.length ?? 0) + (assertionsBy.get(k.accession)?.length ?? 0);
  const provOf = k => { const rows = evidenceBy.get(k.accession) ?? []; const t = tally(rows, e => provenanceOf(e.path)); const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0]; return { counts: t, total: rows.length, main: top?.[0] ?? 'none' }; };

  // 1. What the domain step could see: the top-weighted concepts of each source, and what it placed.
  const placedBy = new Map();
  for (const d of domains.domains) for (const acc of d.concepts) placedBy.set(acc, d.domain_id);
  const bySource = {};
  for (const [source, rows] of Map.groupBy(concepts, k => k.source)) {
    const ranked = [...rows].sort((a, b) => weight(b) - weight(a)), seen = new Set(ranked.slice(0, domainCatalogue).map(k => k.accession));
    const evTotal = rows.reduce((n, k) => n + (evidenceBy.get(k.accession)?.length ?? 0), 0), evSeen = ranked.slice(0, domainCatalogue).reduce((n, k) => n + (evidenceBy.get(k.accession)?.length ?? 0), 0);
    const unitsCited = new Set(rows.flatMap(k => (evidenceBy.get(k.accession) ?? []).map(e => e.artifact_id)));
    const unitsSeen = new Set(ranked.slice(0, domainCatalogue).flatMap(k => (evidenceBy.get(k.accession) ?? []).map(e => e.artifact_id)));
    const prov = tally(rows, k => provOf(k).main);
    const cands = candidatesBy.get(source) ?? [];
    bySource[source] = { concepts: rows.length, shown_to_domain_step: seen.size, placed_in_a_domain: rows.filter(k => placedBy.has(k.accession)).length, not_shown: rows.length - seen.size,
      share_concepts_shown: Number((seen.size / rows.length).toFixed(3)), share_evidence_passages_covered: Number((evSeen / Math.max(1, evTotal)).toFixed(3)), share_cited_units_covered: Number((unitsSeen.size / Math.max(1, unitsCited.size)).toFixed(3)),
      concepts_by_main_provenance: prov, identity_candidates: cands.length, domains: domains.domains.filter(d => d.source_id === source).length };
  }

  // 2. Provenance of what was read and of what concepts rest on.
  const unitsBySource = {};
  for (const a of generation.source_artifacts) { const s = (unitsBySource[a.collection_id] ??= {}); const c = provenanceOf(a.path); s[c] = (s[c] ?? 0) + 1; }
  const evidenceProvenance = {};
  for (const [acc, rows] of evidenceBy) { const k = conceptBy.get(acc); if (!k) continue; const s = (evidenceProvenance[k.source] ??= {}); for (const e of rows) { const c = provenanceOf(e.path); s[c] = (s[c] ?? 0) + 1; } }

  // 3. Near-duplicate clusters from identity candidates that were already judged, plus an unreviewed lexical screen among active concepts.
  const clusters = [];
  for (const [source, cands] of candidatesBy) {
    const group = Map.groupBy(cands, c => c.relation_to_existing.existing_accession);
    for (const [head, members] of group) clusters.push({ source, head, size: members.length + 1, kinds: tally(members, m => m.relation_to_existing.kind) });
  }
  const sizeHist = tally(clusters, c => (c.size >= 20 ? '20+' : c.size >= 10 ? '10-19' : c.size >= 5 ? '5-9' : String(c.size)));
  const unreviewed = {};
  for (const [source, rows] of Map.groupBy(concepts, k => k.source)) {
    const sig = rows.map(k => ({ k, t: tokens(k.label) })), cap = Math.min(rows.length, 600);
    let pairs = 0;
    for (let i = 0; i < cap; i += 1) for (let j = i + 1; j < cap; j += 1) if (jaccard(sig[i].t, sig[j].t) >= 0.6 && sig[i].k.semantic_category === sig[j].k.semantic_category) pairs += 1;
    unreviewed[source] = { label_pairs_over_0_6_same_category: pairs, checked_concepts: cap, of: rows.length };
  }

  // 4. Domains: provenance mix, direct source evidence, and a rule-based product-versus-process reading.
  const domainRows = domains.domains.map(d => {
    const members = d.concepts.map(a => conceptBy.get(a)).filter(Boolean);
    const prov = {};
    for (const k of members) for (const [c, n] of Object.entries(provOf(k).counts)) prov[c] = (prov[c] ?? 0) + n;
    const total = Object.values(prov).reduce((a, b) => a + b, 0);
    const observed = members.filter(k => (standing.get(k.accession)?.summary ?? '') === 'source_observed' || (assertionsBy.get(k.accession) ?? []).some(a => a.predicate === 'implements')).length;
    const processN = (prov.tests ?? 0) + (prov.tooling ?? 0) + (prov.operational_docs ?? 0);
    return { domain_id: d.domain_id, source_id: d.source_id, label: d.label, concepts: members.length, evidence_passages: total, provenance_share: share(prov, total),
      members_with_direct_source_evidence: observed, reading: total === 0 ? 'no_evidence' : processN / total >= processShare ? 'evidence_mostly_tests_tooling_reports' : (prov.product_source ?? 0) / total >= 0.3 ? 'product_or_system' : 'documentation_or_configuration',
      thin: members.length < 4 || total < 8, no_direct_source_evidence: observed === 0 };
  });

  // 5. Themes and paths: do their steps have any exact shared identifier in their evidence quotes?
  const idsOfDomain = new Map();
  for (const d of domains.domains) {
    const set = new Set();
    for (const acc of d.concepts) for (const e of (evidenceBy.get(acc) ?? []).slice(0, 4)) for (const m of String(e.quote).matchAll(IDENT)) if (m[0].length >= 8) set.add(m[0].toLowerCase());
    idsOfDomain.set(d.domain_id, set);
  }
  const domainBy = new Map(domainRows.map(d => [d.domain_id, d]));
  const edgeEvidence = (a, b) => { const x = idsOfDomain.get(a) ?? new Set(), y = idsOfDomain.get(b) ?? new Set(); const shared = [...x].filter(i => y.has(i)); return { shared_identifiers: shared.length, examples: shared.slice(0, 5) }; };
  const paths = domains.themes.paths.map(p => ({ label: p.label, steps: p.steps.map(id => ({ domain_id: id, source_id: domainBy.get(id)?.source_id, label: domainBy.get(id)?.label, concepts: domainBy.get(id)?.concepts, reading: domainBy.get(id)?.reading, direct_source_evidence: domainBy.get(id)?.members_with_direct_source_evidence })),
    edges: p.steps.slice(1).map((id, i) => ({ from: p.steps[i], to: id, cross_source: domainBy.get(p.steps[i])?.source_id !== domainBy.get(id)?.source_id, ...edgeEvidence(p.steps[i], id), concept_link_evidence: 'none (no cross-source alignment was run)', note: 'A missing shared identifier does not show there is no real hand-off, and a shared generic identifier does not verify one.' })) }));
  const themes = domains.themes.themes.map(t => ({ label: t.label, domains: t.domains.length, sources: [...new Set(t.domains.map(id => domainBy.get(id)?.source_id))],
    domains_with_direct_source_evidence: t.domains.filter(id => (domainBy.get(id)?.members_with_direct_source_evidence ?? 0) > 0).length, process_domains: t.domains.filter(id => domainBy.get(id)?.reading === 'evidence_mostly_tests_tooling_reports').length }));
  return { schema: DIAGNOSTICS_SCHEMA, generation_id: generation.generation_id, rules: { domain_catalogue: domainCatalogue, process_share_threshold: processShare, provenance_classes: CLASS_ORDER,
    heuristic: true, note: 'Provenance classes come from path shape only and are a bounded heuristic: they describe where evidence sits, not what a domain means. A path no rule recognises is counted as unclassified. Evidence mostly in tests, tooling or reports does not make a domain an engineering-process domain (purchase behaviour shown through tests is still purchase behaviour), and a lack of source-declared evidence means the support is documentary, not that it is unworthy.' },
  domain_input_coverage: bySource, units_read_by_provenance: unitsBySource, evidence_by_provenance: evidenceProvenance,
  near_duplicates: { clusters: clusters.length, size_histogram: sizeHist, largest: clusters.sort((a, b) => b.size - a.size).slice(0, 8).map(c => ({ source: c.source, size: c.size, label: conceptBy.get(c.head)?.label })), unreviewed_label_screen: unreviewed },
  domains: domainRows, domain_readings: tally(domainRows, d => d.reading), thin_domains: domainRows.filter(d => d.thin).length, domains_without_direct_source_evidence: domainRows.filter(d => d.no_direct_source_evidence).length,
  themes, paths, coverage_totals: coverage?.totals ?? null };
}
