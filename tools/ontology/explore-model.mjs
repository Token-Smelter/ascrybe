// Derived, read-only model for the explorer page. It reindexes what the generation, the estate view and the reconciliation already
// say. Groupings are the model's proposals. Evidence class is derived at read time from the recorded standing, so a comment or a
// document is not indexed as observed code, and a concept with no located evidence is held. Nothing here is accepted.
import { conceptEvidenceGate, evidenceRowClass, standingIndexForGate } from './evidence-standing.mjs';
const STANDINGS = ['source_observed', 'mixed', 'documentary_claim', 'comment_claim', 'no_located_evidence'];
const FORMS = ['responsibility', 'policy', 'practice', 'strategy', 'type', 'theme'];
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

// `view` is the full discovery view model: relations and concept detail are complete here, unlike the lean page payload.
export function exploreModel({ view, estate = null, reconcile = null, predicates = null, chains = null }) {
  const sources = view.collections.map(c => c.collection_id);
  const srcIdx = new Map(sources.map((s, i) => [s, i]));
  const index = new Map();
  const concepts = [], schemes = [], conceptEvidence = [], conceptGates = [];
  const artifactKind = new Map((view.artifacts ?? []).map(a => [a.artifact_id, a.kind]));
  view.collections.forEach((c, si) => {
    for (const sc of c.schemes) {
      const schemeIdx = schemes.length;
      schemes.push({ accession: sc.accession, label: sc.label, definition: sc.definition, boundary: sc.boundary, source: si });
      for (const k of sc.concepts) {
        index.set(k.accession, concepts.length);
        // [accession, label, form, standing, source, scheme, assertions, evidence, blockers, stale support]
        conceptEvidence.push(k.evidence.map(e => ({ evidence_id: e.evidence_id, repository: e.repository, path: e.path, commit_sha: e.commit_sha, blob_oid: e.blob_oid, start_line: e.start_line, end_line: e.end_line })));
        const classes = (k.evidence ?? []).map(e => evidenceRowClass(e, artifactKind.get(e.artifact_id)));
        const gate = k.status != null && Object.hasOwn(k, 'evidence_class')
          ? { status: k.status, evidence_class: k.evidence_class ?? null }
          : conceptEvidenceGate({ standing: k.standing, evidence: k.evidence, storedStatus: k.status, artifactKindOf: id => artifactKind.get(id) ?? null });
        conceptGates.push({ status: gate.status, evidence_class: gate.evidence_class });
        concepts.push([k.accession, k.label, FORMS.indexOf(k.semantic_category), standingIndexForGate(STANDINGS.indexOf(k.standing?.summary), gate, classes), si, schemeIdx,
          k.assertions.length, k.evidence.length, k.blockers.length, k.currentness?.support_stale ?? 0]);
      }
    }
  });
  const idx = list => (list ?? []).map(a => index.get(a)).filter(i => i !== undefined);
  const domains = [], domainIdx = new Map();
  const addDomain = (set, d, extra) => {
    domainIdx.set(d.domain_id, domains.length);
    domains.push({ id: d.domain_id, set, label: d.label, source: srcIdx.get(d.source_id) ?? -1, definition: d.definition, kind: d.kind ?? null, members: idx(d.members ?? d.concepts), ...extra });
  };
  if (reconcile) for (const d of reconcile.domains) addDomain('reconciled', d, {});
  const heuristic = new Map((estate?.diagnostics?.domains ?? []).map(d => [d.domain_id, d]));
  if (estate) for (const d of estate.domains.domains) {
    const g = heuristic.get(d.domain_id);
    addDomain('original', d, { path_shape: g ? { reading: g.reading, share: g.provenance_share, thin: g.thin, evidence_passages: g.evidence_passages } : null });
  }
  const themesOf = list => list.map(t => ({ label: t.label, definition: t.definition, domains: (t.domains ?? []).map(id => domainIdx.get(id)).filter(i => i !== undefined) }));
  const themes = { reconciled: reconcile ? themesOf(reconcile.themes) : [], original: estate ? themesOf(estate.domains.themes.themes) : [] };
  const paths = [];
  const addPaths = (list, set) => { for (const p of list ?? []) paths.push({ label: p.label, reason: p.reason, set, steps: p.steps.map(id => domainIdx.get(id)).filter(i => i !== undefined) }); };
  if (reconcile) addPaths(reconcile.paths, 'reconciled');
  if (estate) addPaths(estate.domains.themes.paths, 'original');

  const relations = [], records = [];
  for (const c of view.collections) for (const r of c.relations) {
    const a = index.get(r.from), b = index.get(r.to);
    if (a === undefined || b === undefined) continue;
    relations.push([a, b, r.type, clip(r.definition, 400), r.evidence?.length ?? 0]);
    records.push({ relation_id: r.relation_id, origin: r.origin, type: r.type, definition: r.definition, from: a, to: b, evidence: r.evidence ?? [] });
  }
  const unplaced = (reconcile?.unplaced ?? []).map(r => [index.get(r.accession), r.disposition, r.reason]).filter(r => r[0] !== undefined);
  // A sidecar of proposed groupings. Original wording stays primary and nothing is merged by it.
  const predicateProposals = predicates ? { schema: predicates.schema, model: predicates.model_config, note: predicates.note ?? null,
    canonical: predicates.canonical.map(c => ({ id: c.canonical_id, original_types: c.original_types, uses: c.uses })),
    by_text: Object.fromEntries(predicates.mappings.map(m => [m.original_text, [m.canonical_id, m.direction, clip(m.reason, 300)]])) } : null;
  const model = { schema: 'estate-map/ontology-explore/v2', proposal: true, accepted: false, generation_id: view.generation_id,
    predicate_proposals: predicateProposals,
    chains: chains ? { source_pin: chains.source_pin, basis: chains.basis, static_only: chains.static_only, totals: chains.totals,
      rows: chains.chains.map(c => ({ name: c.name, kind: c.kind, makers: c.makers, takers: c.takers, n: c.n, refs: c.refs.slice(0, 8) })) } : null,
    pins: { generation_id: view.generation_id, view_schema: view.schema, model: view.model_config ?? null, sources: (estate?.manifest?.sources ?? []).map(s => ({ id: s.id, ref: s.ref, ref_origin: s.ref_origin })) },
    forms: FORMS.map(f => ({ id: f, meaning: view.legend.categories[f]?.meaning ?? '', predicates: view.legend.categories[f]?.constitutive ?? [] })),
    standings: STANDINGS, sources, schemes, concepts, concept_gates: conceptGates, domains, themes, paths, relations, unplaced, counts: view.counts,
    coverage: estate ? { totals: estate.coverage.totals, by_source: estate.coverage.by_source, withheld: estate.coverage.units_withheld_by_screen } : null,
    reconcile: reconcile ? { coverage: reconcile.summary.coverage, clusters: reconcile.clusters, cluster_totals: reconcile.summary.clusters, traces: reconcile.traces, model_config: reconcile.model_config } : null,
    findings: view.findings.map(f => ({ kind: f.kind, concept: index.get(f.concept_accession) ?? -1, path: f.path, status: f.status, quote: clip(f.member_quote, 200) })) };
  // Relation passages are served one relation at a time, so the page payload stays small.
  Object.defineProperty(model, 'relation_records', { value: records, enumerable: false });
  Object.defineProperty(model, 'concept_evidence', { value: conceptEvidence, enumerable: false });
  return model;
}

// Gap and conflict notes carry quoted passages, so the page fetches them only when the triage view opens.
export function exploreTriage({ view }) {
  const rows = [];
  view.collections.forEach((c, si) => {
    for (const [type, list] of [['gap', c.gaps], ['conflict', c.unresolved]]) for (const g of list) {
      const e = g.evidence?.[0];
      rows.push({ type, kind: g.kind, source: si, description: clip(g.description, 500), path: e?.path ?? null, start_line: e?.start_line ?? null,
        end_line: e?.end_line ?? null, standing: e?.standing ?? null, quote: clip(e?.quote, 240), refs: g.evidence?.length ?? 0 });
    }
  });
  return rows;
}
