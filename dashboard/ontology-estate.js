// The whole-estate view: what was in scope, what was read and grounded, what was not, and the domains and themes the generator
// proposed across sources. Every number comes from /api/estate exactly as served; nothing is inferred here.
const BYTES = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);
const N = n => Number(n ?? 0).toLocaleString('en-US');
const RULE_TEXT = {
  'not_read:unsupported_binary_or_media': 'Images, audio, video, fonts and binaries (not interpreted)',
  'not_read:unsupported_document_format': 'PDF, Word, spreadsheet and similar documents (not parsed)',
  'not_read:archived_snapshot_directory': 'Archived snapshot directories (not read)',
  'not_read:homogeneous_bulk_subtree': 'Large collections of one data format (counted, not read file by file)',
  'not_read:homogeneous_bulk_directory': 'Large directories of one data format (counted, not read)',
  'not_read:file_over_read_limit': 'Files over the size limit',
  'not_read:data_file_over_read_limit': 'Data files over the size limit',
  'not_read:bulk_tabular_data': 'Large tables',
  'not_read:unknown_format': 'Formats the reader does not support',
  'not_read:log_or_record_stream': 'Logs and record streams',
  'not_read:non_regular_entry': 'Submodules and other non-file entries',
  'not_read:empty_file': 'Empty files',
  'excluded:dependency_or_build_directory': 'Dependency and build directories (excluded)',
  'excluded:generated_lock_or_minified': 'Lock files and minified output (excluded)',
  'withheld:credential_like_name': 'Files named like credentials (withheld)',
  'withheld:sensitive_domain_inventory_only': 'Sources declared inventory-only (listed, contents never sent)',
};

export function createEstateView({ h, words, go, state }) {
  const S = { est: null, source: null };
  const load = est => { S.est = est; };
  const concept = acc => state.concepts.get(acc)?.concept;
  const sources = () => S.est.manifest?.sources ?? Object.keys(S.est.coverage.by_source).map(id => ({ id }));
  const stat = (label, value, note) => h('div', { class: 'stat' }, h('dd', {}, value), h('dt', {}, label), note ? h('p', { class: 'stat__note' }, note) : null);

  function summary() {
    const inv = S.est.inventory?.by_source ?? {}, cov = S.est.coverage.totals;
    const rows = Object.values(inv);
    const files = rows.reduce((n, x) => n + x.files, 0), bytes = rows.reduce((n, x) => n + x.bytes, 0);
    const disp = k => rows.reduce((n, x) => n + (x.by_disposition[k]?.files ?? 0), 0);
    return h('div', { class: 'card' }, h('h2', {}, 'Estate coverage'),
      h('p', { class: 'definition' }, `${N(files)} files (${BYTES(bytes)}) in ${rows.length} sources were inventoried before any model call. ${N(disp('supported'))} are supported text, ${N(disp('not_read'))} were not read, ${N(disp('excluded'))} were excluded and ${N(disp('withheld'))} were withheld.`),
      h('dl', { class: 'stats' },
        stat('Units cut from supported files', N(cov.units_total), 'Every line of a supported file is in exactly one unit.'),
        stat('Read by the model', N(cov.units_read), `${N(cov.units_screened_out)} withheld by the privacy screen`),
        stat('Cited by a concept', N(cov.units_cited_by_concepts)),
        stat('Grounded to typed subjects', N(cov.units_grounded), 'A stated sample, not every unit'),
        stat('Unknown outcome', N(cov.units_unknown_outcome), 'Sent with no recorded answer; cost unknown'),
        stat('Unparseable answer', N(cov.units_parse_failure), 'Answered, but not readable after the retry bound'),
        stat('Grounding failed', N(cov.units_ground_failed), 'Counted, never skipped silently')),
      h('p', { class: 'muted' }, 'Read means the unit was part of a batch the model answered. Grounded means its subjects were tied to quoted passages. These are different counters. Nothing on this page is accepted or runtime-verified.'));
  }

  const PROV = { product_source: 'Product source', tests: 'Tests', tooling: 'Tooling and scripts', operational_docs: 'Operational reports and logs', documentation: 'Documentation', configuration_infra: 'Configuration and infrastructure', research_or_data_pages: 'Research and data pages', other: 'Other' };
  const pct = v => `${Math.round((v ?? 0) * 100)}%`;
  const provText = share => Object.entries(share ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${PROV[k] ?? k} ${pct(v)}`).join(', ');

  // Two separate coverage statements: what was read, and what the domain map was built from.
  function notices() {
    const dg = S.est.diagnostics;
    if (!dg) return null;
    const cov = dg.domain_input_coverage, rows = Object.values(cov);
    const concepts = rows.reduce((n, c) => n + c.concepts, 0), shown = rows.reduce((n, c) => n + c.shown_to_domain_step, 0);
    return h('div', { class: 'notices' },
      h('section', { class: 'notice' }, h('h2', {}, 'Source coverage'), h('p', {}, `The model read ${N(S.est.coverage.totals.units_read)} of ${N(S.est.coverage.totals.units_ready)} units that passed the privacy screen (${pct(S.est.coverage.totals.units_read / S.est.coverage.totals.units_ready)}), which is ${pct(S.est.coverage.totals.units_read / S.est.coverage.totals.units_total)} of all ${N(S.est.coverage.totals.units_total)} supported units. No whole source was omitted; the impact of the ${N(S.est.coverage.totals.units_unknown_outcome + (S.est.coverage.totals.units_other_failure ?? 0))} unread units is unknown until they are inspected.`),
        h('p', { class: 'muted' }, 'This says what was read. It does not say the estate is understood.')),
      h('section', { class: 'notice notice--warn' }, h('h2', {}, 'Domain input coverage (heuristic diagnostic)'), h('p', {}, `The domain map was built from ${N(shown)} of the ${N(concepts)} concepts (${pct(shown / concepts)}). For the largest sources it saw 5–20% of the concepts and 8–24% of the evidence passages.`),
        h('p', { class: 'muted' }, `The other ${N(concepts - shown)} concepts are kept and listed under Definitions; they are not part of any domain. ${S.est.diagnostics.near_duplicates.clusters} groups of near-duplicate concepts were already proposed as identity candidates; none is merged. The evidence-source tags and path signals below are path-shape heuristics: they describe where evidence sits, not what a domain means, and a path no rule recognises is counted as unclassified.`)));
  }

  function sourceTable() {
    const inv = S.est.inventory?.by_source ?? {}, cov = S.est.coverage.by_source;
    return h('div', { class: 'card' }, h('h2', {}, 'Sources'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'review-table' },
        h('thead', {}, h('tr', {}, ['Source', 'What it is', 'Pinned at', 'Files', 'Supported', 'Units read', 'Grounded', 'Not read or withheld', 'Used for domains', 'Evidence comes from'].map(x => h('th', {}, x)))),
        h('tbody', {}, sources().map(src => {
          const i = inv[src.id], c = cov[src.id];
          const notRead = i ? (i.by_disposition.not_read?.bytes ?? 0) + (i.by_disposition.withheld?.bytes ?? 0) + (i.by_disposition.excluded?.bytes ?? 0) : 0;
          return h('tr', { class: S.source === src.id ? 'is-on' : '' },
            h('td', {}, h('button', { type: 'button', class: 'linkish', onclick: () => { S.source = S.source === src.id ? null : src.id; state.rerender(); } }, src.id)),
            h('td', {}, src.policy === 'inventory_only' ? `${words(src.role ?? '')} (listed only)` : words(src.role ?? '')),
            h('td', { class: 'mono' }, String(src.ref ?? '').slice(0, 10)), h('td', {}, N(i?.files)), h('td', {}, N(i?.supported_files)),
            h('td', {}, c ? `${N(c.units_read)} of ${N(c.units_total)}` : '—'), h('td', {}, c ? N(c.units_grounded) : '—'), h('td', {}, i ? BYTES(notRead) : '—'),
            h('td', {}, S.est.diagnostics?.domain_input_coverage[src.id] ? `${pct(S.est.diagnostics.domain_input_coverage[src.id].share_concepts_shown)} of ${N(S.est.diagnostics.domain_input_coverage[src.id].concepts)} concepts` : '—'),
            h('td', {}, provText(S.est.diagnostics?.evidence_by_provenance?.[src.id] ? Object.fromEntries(Object.entries(S.est.diagnostics.evidence_by_provenance[src.id]).map(([k, v]) => [k, v / Object.values(S.est.diagnostics.evidence_by_provenance[src.id]).reduce((a, b) => a + b, 0)])) : {})));
        })))));
  }

  function gaps() {
    const inv = S.est.inventory?.by_source ?? {}, byRule = new Map();
    for (const x of Object.values(inv)) for (const [rule, v] of Object.entries(x.by_rule)) { if (rule.startsWith('supported:')) continue; const a = byRule.get(rule) ?? { files: 0, bytes: 0 }; a.files += v.files; a.bytes += v.bytes; byRule.set(rule, a); }
    const screen = Object.entries(S.est.coverage.units_withheld_by_screen ?? {});
    const failures = Object.entries(S.est.coverage.failures ?? {}).filter(([, n]) => n);
    const differing = sources().filter(s => s.ref_matches_local_head_now === false);
    return h('details', { class: 'drawer' }, h('summary', {}, 'What is not covered'),
      h('div', { class: 'drawer__body' },
        h('h3', {}, 'Files not read, excluded or withheld'),
        h('table', { class: 'review-table' }, h('thead', {}, h('tr', {}, ['Why', 'Files', 'Size'].map(x => h('th', {}, x)))),
          h('tbody', {}, [...byRule].sort((a, b) => b[1].bytes - a[1].bytes).map(([rule, v]) => h('tr', {}, h('td', {}, RULE_TEXT[rule] ?? words(rule)), h('td', {}, N(v.files)), h('td', {}, BYTES(v.bytes)))))),
        h('h3', {}, 'Units withheld by the privacy screen'), screen.length ? h('ul', { class: 'plain' }, screen.map(([r, n]) => h('li', {}, `${words(r)}: ${N(n)}`))) : h('p', { class: 'muted' }, 'None.'),
        h('h3', {}, 'Cost'), h('p', {}, (() => { const c = S.est.coverage.cost_accounting; return c ? `Known: $${Number(c.known_completed_usd).toFixed(2)} for answered calls (API-price equivalent, not a bill), plus $${Number(c.known_failed_answers_usd).toFixed(2)} for unparseable answers. ${c.unknown_outcome_requests} request(s) have an unknown outcome and an unknown cost, which is not counted as zero.` : 'Not recorded.'; })()),
        h('h3', {}, 'Map batches that were not read'),
        (S.est.coverage.map_gaps ?? []).length ? h('div', { class: 'table-wrap' }, h('table', { class: 'review-table' }, h('thead', {}, h('tr', {}, ['Source', 'Batch', 'What happened', 'Units', 'Share of source', 'Files'].map(x => h('th', {}, x)))),
          h('tbody', {}, S.est.coverage.map_gaps.map(g => h('tr', {}, h('td', {}, g.source_id), h('td', { class: 'mono' }, g.batch), h('td', {}, g.outcome), h('td', {}, N(g.units.length)), h('td', {}, `${(g.share_of_source_units * 100).toFixed(1)}%`),
            h('td', {}, g.files.slice(0, 3).join(', ') + (g.files.length > 3 ? ` and ${g.files.length - 3} more` : ''))))))) : h('p', { class: 'muted' }, 'None.'),
        h('h3', {}, 'Failed model calls'), failures.length ? h('ul', { class: 'plain' }, failures.map(([k, n]) => h('li', {}, `${words(k)} stage: ${N(n)}`))) : h('p', { class: 'muted' }, 'None recorded.'),
        h('h3', {}, 'Pins that differ from the checkouts today'), differing.length ? h('p', {}, `${differing.map(s => s.id).join(', ')}. These are read at the frozen commit, which is the baseline; no checkout was changed.`) : h('p', { class: 'muted' }, 'None.'),
        h('h3', {}, 'Not inspected'), h('ul', { class: 'plain' }, [
          h('li', {}, 'Provider dashboards and deployed state were not inspected. Nothing here claims what is deployed.'),
          h('li', {}, 'Legal and finance sources are inventory-only: their files are counted and typed by path and format, and their contents were not sent to any model.'),
          h('li', {}, 'PDF, Word, spreadsheet and image contents are not parsed.'),
          h('li', {}, 'The whole-code graph is evidence context from an earlier run; it was not re-mapped here.')])));
  }

  function domains() {
    const d = S.est.domains;
    if (!S.source) {
      const bySource = Map.groupBy(d.domains, x => x.source_id);
      return h('div', { class: 'card' }, h('h2', {}, 'Candidate domains by source'),
        h('p', { class: 'muted' }, 'The generator grouped each source\'s concepts into areas. These are interpretations of the sources, not source text, and none is accepted. Choose a source to read its domains and concepts.'),
        h('ul', { class: 'plain domain-index' }, [...bySource].map(([id, rows]) => h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => { S.source = id; state.rerender(); } }, `${id} (${rows.length})`),
          h('span', { class: 'muted' }, `: ${rows.map(r => r.label).slice(0, 6).join('; ')}${rows.length > 6 ? '; …' : ''}`)))));
    }
    const list = d.domains.filter(x => x.source_id === S.source);
    return h('div', { class: 'card' }, h('h2', {}, `Candidate domains in ${S.source}`),
      h('p', {}, h('button', { type: 'button', class: 'linkish', onclick: () => { S.source = null; state.rerender(); } }, 'Back to all sources')),
      h('div', { class: 'domains' }, list.map(x => h('section', { class: 'domain' },
        h('h3', {}, x.label), (() => { const dr = S.est.diagnostics?.domains.find(y => y.domain_id === x.domain_id); return dr ? h('p', {}, h('span', { class: 'pill' }, READING[dr.reading] ?? dr.reading), dr.no_direct_source_evidence ? [' ', h('span', { class: 'pill' }, 'Evidence is in documents, which may be instruction files an agent loads; it is not tied to a code declaration')] : null, dr.thin ? [' ', h('span', { class: 'pill' }, 'Thin: few concepts or passages')] : null, ' ', h('span', { class: 'pill' }, 'Heuristic tag')) : null; })(), h('p', { class: 'muted' }, `${x.concepts.length} concept${x.concepts.length === 1 ? '' : 's'}${x.concepts_shown_of_total ? ` (the model saw ${x.concepts_shown_of_total.split('/')[0]} of ${x.concepts_shown_of_total.split('/')[1]} concepts of this source)` : ''}`), h('p', {}, x.definition),
        h('ul', { class: 'plain' }, x.concepts.slice(0, 10).map(acc => { const c = concept(acc); return h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => go('concept', acc) }, c?.label ?? acc.split('/').at(-1)), c ? h('span', { class: 'muted' }, ` · ${c.semantic_category}`) : null); })),
        x.concepts.length > 10 ? h('p', { class: 'muted' }, `and ${x.concepts.length - 10} more in Definitions`) : null,
        (x.relations ?? []).length ? h('p', { class: 'muted' }, x.relations.map(r => `${words(r.type)} → ${d.domains.find(y => y.domain_id === r.to)?.label ?? r.to}`).join('; ')) : null))));
  }

  function themes() {
    const t = S.est.domains.themes, labelOf = id => { const x = S.est.domains.domains.find(d => d.domain_id === id); return x ? `${x.label} (${x.source_id})` : id; };
    return h('div', { class: 'card' }, h('h2', {}, 'Themes and paths across sources'),
      h('p', { class: 'muted' }, 'Each theme groups domains from at least two sources. A path is an ordered chain of domains the generator found connected. These are proposals read from domain definitions, not verified runtime paths.'),
      t.themes.length ? t.themes.map(x => h('div', { class: 'entry' }, h('h3', {}, x.label), h('p', {}, x.definition), h('ul', { class: 'plain' }, x.domains.map(id => h('li', {}, labelOf(id)))))) : h('p', { class: 'muted' }, 'No theme was proposed.'),
      t.paths.length ? [h('h3', {}, 'Paths'), t.paths.map(p => h('div', { class: 'entry' }, h('p', {}, h('strong', {}, p.label)), h('p', {}, p.steps.map(labelOf).join(' → ')), h('p', { class: 'muted' }, p.reason)))] : null);
  }

  const READING = { evidence_mostly_tests_tooling_reports: 'Evidence mostly in tests, tooling or reports', product_or_system: 'Evidence mostly in product source', documentation_or_configuration: 'Evidence mostly in documentation or configuration', no_evidence: 'No evidence located' };
  function render() { return h('article', { class: 'reveal estate' }, notices(), summary(), sourceTable(), gaps(), themes(), paths(), domains()); }

  function paths() {
    const dg = S.est.diagnostics;
    if (!dg) return null;
    return h('div', { class: 'card' }, h('h2', {}, 'How well the proposed paths are supported'),
      h('p', { class: 'muted' }, 'Heuristic, bounded diagnostic. Each step is a domain; a step line shows its source and how many of its concepts rest on a code declaration (the rest rest on documents, which is support of a different kind, not lesser: a markdown file can be an instruction an agent loads and follows, and this view does not show whether any was loaded or applied). No concept-to-concept link evidence exists for any hand-off, because cross-source alignment was not run.'),
      dg.paths.map(p => h('div', { class: 'entry' }, h('p', {}, h('strong', {}, p.label)),
        h('ol', { class: 'plain' }, p.steps.map((s, i) => h('li', {}, `${s.label} (${s.source_id}) — ${s.direct_source_evidence} of ${s.concepts} concepts rest on a code declaration; ${READING[s.reading] ?? s.reading}`,
          p.edges[i] ? h('div', { class: 'muted' }, `then: ${p.edges[i].cross_source ? 'crosses to another source' : 'same source'}; ${p.edges[i].shared_identifiers} exact shared identifier(s) found in the two steps' evidence. This is a screening signal only: finding none does not show there is no real hand-off, and a shared generic identifier does not verify one.`) : null))))));
  }
  return { load, render, state: S };
}
