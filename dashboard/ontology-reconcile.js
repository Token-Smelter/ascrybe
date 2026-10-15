// The reconciled view: a second interpretation of the same retained concepts, kept apart from the original generation. Every number
// comes from /api/reconcile as served. Nothing here is accepted, and no source chain is shown unless it was located at a pinned commit.
const N = n => Number(n ?? 0).toLocaleString('en-US');
const PCT = v => `${(v * 100).toFixed(1)}%`;
const USD = v => `$${Number(v ?? 0).toFixed(2)}`;
const KIND = { conceptual_domain: 'Subject area', responsibility: 'Responsibility', process: 'Process', actor: 'Actor', scope: 'Scope', unspecified: 'Unspecified' };
const RELATION = { same_concept: 'Same concept', refinement: 'Refinement', alias: 'Alias', distinct: 'Distinct', unplaced: 'Not placed' };
const FINDING = {
  datastore: 'Datastore', network: 'Network call', sdk_forwarding: 'Shared integration', shared_vendor_destination: 'Same vendor named', asset_copy: 'Asset copy',
  none_located: 'No connection located', unresolved_lead: 'Lead could not be pinned',
};
const FINDING_NOTE = {
  writes_to_and_reads_from_same_named_collection: 'One side writes and the other reads a store with the same name or the same table setting.',
  same_table_setting_by_configuration_mapping: 'The reader\'s table setting maps to the environment variable the other side reads.',
  callable_defined_on_one_side_and_invoked_by_name_on_the_other: 'A function is defined on one side and called by that name on the other.',
  both_sides_name_the_same_vendor: 'Both sides use the same outside service, each with its own credential.',
  identical_file_content_in_both_trees: 'Files with identical bytes exist in both trees.',
  no_shared_term_found: 'Nothing the first side names was found in the other tree.',
  terms_found_but_no_structural_link: 'Matches are plain string matches with no read, write or call around them.',
  no_identical_file_content: 'No file has identical bytes in both trees.',
  pin_not_verified: 'A lead could not be confirmed at the pinned commit.',
};

export function createReconcileView({ h, words, go, state }) {
  const S = { r: null, open: new Set() };
  const load = r => { S.r = r; S.earlier = new Map(); for (const c of r.summary.comparison) for (const n of c.nearest_primary_domains) (S.earlier.get(n.domain_id) ?? S.earlier.set(n.domain_id, []).get(n.domain_id)).push({ ...c, jaccard: n.jaccard, shared: n.shared_concepts }); };
  const stat = (label, value, note) => h('div', { class: 'stat' }, h('dd', {}, value), h('dt', {}, label), note ? h('p', { class: 'stat__note' }, note) : null);
  const short = sha => (sha ?? '').slice(0, 8);

  function header() {
    const r = S.r, m = r.model_config, c = r.calls;
    return h('div', { class: 'notices' },
      h('section', { class: 'notice notice--warn' }, h('h2', {}, 'A second interpretation, proposed and not accepted'),
        h('p', {}, `The same ${N(r.summary.coverage.concepts_given_to_model)} retained concepts were grouped again by ${m.requested} (thinking requested ${m.thinking}; the effort the route actually applied is unverified). The original generation ${short(r.base_generation_id)} is unchanged and remains the record. Nothing below is accepted or verified at runtime.`),
        h('p', { class: 'muted' }, c ? `${N(c.completed_calls)} completed calls, ${USD(c.cost_usd)} API-price equivalent (not a bill; account allocation unverified)${c.calls_with_unknown_cost ? `; ${c.calls_with_unknown_cost} with unknown cost` : ''}; ${N(c.unreadable_answers ?? 0)} unreadable answers (${USD(c.unreadable_answers_cost_usd)}) are counted separately. Stages: ${Object.entries(c.by_stage).map(([k, v]) => `${words(k)} ${v.calls}`).join(', ')}.` : 'Call counts are not available.')),
      h('section', { class: 'notice' }, h('h2', {}, 'How to read this'),
        h('p', {}, 'A markdown file can act like code when an agent loads it: it may define a rule or procedure that governs operation. This view records what a file states and where; it does not show that any agent loaded it, applied it, or was governed by it, and it does not treat a document as a passive claim by default.'),
        h('p', {}, 'Domains, themes and cluster proposals are interpretations by a model, not source text. The page separates what the model was shown from what it returned, and shows chains between systems only where a source location was found and re-read at its pinned commit.')));
  }

  function coverage() {
    const c = S.r.summary.coverage, f = S.r.summary.fragmentation, r = c.returned;
    return h('div', { class: 'card' }, h('h2', {}, 'Domain input and what came back'),
      h('p', { class: 'definition' }, `Every retained concept was given to the model (${N(c.concepts_given_to_model)} of ${N(c.concepts_given_to_model)}). That is input coverage. What the model returned is a separate count.`),
      h('dl', { class: 'stats' },
        stat('Placed in a domain', N(r.assigned), `${PCT(c.assigned_share)} of the input`),
        stat('Left unassigned, with a reason', N(r.unassigned ?? 0)),
        stat('Not returned by the model', N(r.not_returned ?? 0), 'The answer neither placed nor listed them'),
        stat('Batch answer failed', N(r.batch_failed ?? 0), 'Left as an explicit gap; not purchased again'),
        stat('Source domains proposed', N(f.primary_source_domains), `The earlier map had ${N(f.secondary_source_domains)}`)),
      h('p', { class: 'muted' }, c.note),
      h('p', { class: 'muted' }, `More domains is not an improvement by itself: ${N(f.size_bands.one)} domains hold one concept, ${N(f.size_bands.two_to_three)} hold two or three, and ${N(f.size_bands.ten_or_more)} hold ten or more (median ${N(f.median_concepts_per_domain)}). Small domains may be one subject split apart.`));
  }

  function conceptButton(c) { return h('button', { type: 'button', class: 'linkish', onclick: () => go('concept', c.accession) }, c.label); }

  function domainEntry(d) {
    const earlier = (S.earlier.get(d.domain_id) ?? []).sort((a, b) => b.shared - a.shared).slice(0, 3);
    return h('details', { class: 'entry', ...(S.open.has(d.domain_id) ? { open: '' } : {}), ontoggle: e => { e.target.open ? S.open.add(d.domain_id) : S.open.delete(d.domain_id); } },
      h('summary', {}, h('strong', {}, d.label), ' ', h('span', { class: 'pill' }, KIND[d.kind] ?? d.kind), ' ', h('span', { class: 'muted' }, `${d.source_id}, ${N(d.concept_count)} concepts`)),
      h('p', {}, d.definition),
      h('ul', { class: 'plain' }, d.sample_concepts.map(c => h('li', {}, conceptButton(c)))),
      d.concept_count > d.sample_concepts.length ? h('p', { class: 'muted' }, `and ${N(d.concept_count - d.sample_concepts.length)} more in Definitions`) : null,
      earlier.length ? h('div', {}, h('h3', {}, 'Where the earlier map put these concepts'),
        h('ul', { class: 'plain' }, earlier.map(e => h('li', {}, `${e.label}: ${N(e.shared)} shared concepts`, h('span', { class: 'muted' }, ` — earlier definition: ${e.definition}`))))) : h('p', { class: 'muted' }, 'None of the earlier map\'s domains shared concepts with this one; the earlier map saw only its top 120 concepts per source.'));
  }

  function sourceGroup(key, source, rows) {
    return h('details', { class: 'group', ...(S.open.has(key) ? { open: '' } : {}), ontoggle: e => { e.target.open ? S.open.add(key) : S.open.delete(key); } },
      h('summary', {}, `${source}: ${rows.length} domain${rows.length === 1 ? '' : 's'}`, h('span', { class: 'muted' }, ` — ${rows.slice(0, 3).map(d => d.label).join('; ')}${rows.length > 3 ? '; …' : ''}`)), rows.map(domainEntry));
  }

  function themes() {
    const r = S.r, byId = new Map(r.domains.map(d => [d.domain_id, d])), used = new Set(r.themes.flatMap(t => t.domains));
    const unthemed = r.domains.filter(d => !used.has(d.domain_id));
    return h('div', { class: 'card' }, h('h2', {}, 'Estate themes and their source domains'),
      h('p', { class: 'muted' }, 'A theme groups source domains from at least two sources. Open a domain to read its definition, its concepts, and how it compares with the earlier map. The theme step saw only domain labels and definitions, not source text.'),
      r.themes.map(t => h('section', { class: 'entry' }, h('h3', {}, t.label), h('p', {}, t.definition),
        [...Map.groupBy(t.domains.map(id => byId.get(id)).filter(Boolean), d => d.source_id)].map(([source, rows]) => sourceGroup(`${t.label}|${source}`, source, rows)))),
      unthemed.length ? h('section', { class: 'entry' }, h('h3', {}, `Source domains not placed in any theme (${N(unthemed.length)})`), h('p', { class: 'muted' }, 'Kept as proposed; the theme step did not use them.'),
        [...Map.groupBy(unthemed, d => d.source_id)].map(([source, rows]) => sourceGroup(`unthemed|${source}`, source, rows))) : null);
  }

  function perSource() {
    const f = S.r.summary.fragmentation, c = S.r.summary.coverage.by_source;
    return h('div', { class: 'card' }, h('h2', {}, 'By source'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'review-table' }, h('thead', {}, h('tr', {}, ['Source', 'Concepts given', 'Placed', 'Not placed', 'Domains', 'Median per domain'].map(x => h('th', {}, x)))),
        h('tbody', {}, Object.entries(f.per_source).map(([id, p]) => { const d = c[id] ?? {}, total = Object.values(d).reduce((a, b) => a + b, 0);
          return h('tr', {}, h('td', {}, id), h('td', {}, N(total)), h('td', {}, N(d.assigned ?? 0)), h('td', {}, N(total - (d.assigned ?? 0))), h('td', {}, N(p.domains)), h('td', {}, N(p.median_concepts_per_domain))); })))));
  }

  function clusters() {
    const c = S.r.summary.clusters, by = c.proposals_by_relation, mem = c.members_by_relation;
    return h('div', { class: 'card' }, h('h2', {}, 'Near-duplicate clusters: proposals, not a reduction'),
      h('p', { class: 'definition' }, `${N(c.clusters_resolved)} of the larger identity clusters were re-read against their definitions and quoted support. Each cluster has one active concept (its head) and earlier candidates that were never active. ${N(c.canonical_proposals)} canonical proposals resulted, ${N(c.proposals_without_the_active_head)} of them without the active head.`),
      h('dl', { class: 'stats' },
        stat('Active concepts in these clusters', N(c.active_concepts_in_those_clusters), `of ${N(c.active_concepts_total)} active`),
        stat('Members considered', N(c.members_considered)),
        stat('Same concept or alias', `${N(mem.same_concept ?? 0)} members`, `${N(by.same_concept ?? 0)} proposals`),
        stat('Refinements', `${N(mem.refinement ?? 0)} members`, `${N(by.refinement ?? 0)} proposals`),
        stat('Distinct', `${N(mem.distinct ?? 0)} members`, `${N(by.distinct ?? 0)} proposals`),
        stat('Disagree with earlier judgement', N(c.disagreements_with_earlier_judgements))),
      h('p', { class: 'muted' }, c.note),
      h('p', { class: 'muted' }, `Accepting every proposal would make the active vocabulary ${N(c.if_every_proposal_were_accepted.active_concepts_would_be)} (${c.if_every_proposal_were_accepted.change_from_active >= 0 ? '+' : ''}${N(c.if_every_proposal_were_accepted.change_from_active)}). Nothing is accepted.`),
      h('h3', {}, 'The largest clusters'),
      S.r.clusters.slice(0, 12).map(k => h('div', { class: 'entry' }, h('p', {}, h('strong', {}, k.head_label), h('span', { class: 'muted' }, ` — ${k.source_id}, ${N(k.cluster_size)} members`)),
        h('ul', { class: 'plain' }, k.proposals.map(p => h('li', {}, `${RELATION[p.relation] ?? p.relation}: ${p.label ?? 'not placed'} (${N(p.members)} member${p.members === 1 ? '' : 's'}${p.contains_head ? ', includes the active concept' : ''})`))))));
  }

  function chains() {
    const t = S.r.traces;
    const located = t.filter(x => x.findings.some(f => ['datastore', 'network', 'sdk_forwarding', 'asset_copy'].includes(f.kind)));
    return h('div', { class: 'card' }, h('h2', {}, 'Source connections between systems'),
      h('p', { class: 'definition' }, `${N(located.length)} of ${N(t.length)} traced hand-offs have a located connection. Each was found by searching the pinned source trees, expanding the enclosing function, and re-reading the lines at the commit. A static match shows code that lines up. It does not show the connection is deployed or runs.`),
      h('p', { class: 'muted' }, 'Kinds are kept apart. A shared collection name is not a shared database, a callable name is not a deployed function, and a policy that constrains an asset is not a network call. Where nothing was located, the entry says what is missing.'),
      t.map(x => h('section', { class: 'entry' }, h('h3', {}, x.label),
        x.pins.map(p => h('p', { class: 'muted' }, p.ok ? `${p.repo}: ${p.search_only ? 'searched the whole pinned tree' : `${p.path}:${p.start_line}-${p.end_line}`} at ${short(p.commit_sha)}` : `${p.repo}: ${p.problem}`)),
        x.findings.map(f => h('div', {}, h('p', {}, h('span', { class: 'pill' }, FINDING[f.kind] ?? f.kind), ' ', FINDING_NOTE[f.relation] ?? words(f.relation)),
          f.collections ? h('p', {}, `Named: ${f.collections.join(', ')}`) : null, f.callables ? h('p', {}, `Named: ${f.callables.join(', ')}`) : null,
          f.physical_store ? h('p', { class: 'muted' }, `Physical store: ${f.physical_store}`) : null,
          (f.refs ?? []).length ? h('ul', { class: 'plain' }, f.refs.map(ref => h('li', { class: 'mono' }, `${ref.repo}: ${ref.path}${ref.start_line ? `:${ref.start_line}${ref.end_line && ref.end_line !== ref.start_line ? `-${ref.end_line}` : ''}` : ''}${ref.symbol ? ` (${ref.symbol})` : ''}`))) : null,
          h('p', { class: 'muted' }, `Missing: ${f.missing}`))))));
  }

  function gaps() {
    const r = S.r;
    return h('div', { class: 'card' }, h('h2', {}, 'Dispositions that are not assignments'),
      h('p', { class: 'muted' }, 'Every concept the model did not place keeps its original definition and is listed here, with the model\'s reason where it gave one.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'review-table' }, h('thead', {}, h('tr', {}, ['Source', 'Disposition', 'Concepts'].map(x => h('th', {}, x)))),
        h('tbody', {}, r.gaps.map(g => h('tr', {}, h('td', {}, g.source_id), h('td', {}, words(g.disposition)), h('td', {}, N(g.concepts))))))),
      r.gap_reasons.length ? [h('h3', {}, 'Examples with the model\'s reason'), h('ul', { class: 'plain' }, r.gap_reasons.slice(0, 12).map(x => h('li', {}, conceptButton(x), h('span', { class: 'muted' }, ` — ${x.reason}`))))] : null,
      Object.values(r.failures).some(x => x.length) ? h('p', { class: 'muted' }, `Failed requests: ${Object.entries(r.failures).filter(([, v]) => v.length).map(([k, v]) => `${words(k)} ${v.length}`).join(', ')}. A failed request is a gap, not a result.`) : null);
  }

  function render() { return h('article', { class: 'reveal estate' }, header(), coverage(), themes(), perSource(), clusters(), chains(), gaps()); }
  return { load, render, state: S };
}
