// Cartography Spine v0 — the LAST and LEAST intelligent stage (answer, non-negotiable).
//
// This renderer SELECTS persisted view-model records and DRAWS them. It performs NO grouping,
// counting, membership inference, edge routing, component computation, label generation, or
// difference computation. Every number it prints is read verbatim from a view-model field
// (node_count, exact_edge_count, orphan_count, assignment_breakdown, conservation.*). The only
// arithmetic here is turning a persisted count into a CSS pixel/percent width — pure
// presentation, never a decision about what the estate means. This module deliberately imports
// nothing from model.mjs / tiles.mjs (verified by estateMapCartographyRenderer.test.mjs).

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (part, whole) => whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '0%';

// A clickable scope element ALWAYS carries its exact persisted scope address (test G).
const scopeChip = (view) => `<span class="scope" data-scope-address="${esc(view.view_address)}" data-scope-id="${esc(view.scope_id)}">`
  + `${esc(view.label)} <em>[${esc(view.scope_kind)}]</em> <b>${view.node_count}</b></span>`;

function statusRail(breakdown, total) {
  const order = ['assigned', 'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only', 'unaccounted'];
  const segs = order.map(state => {
    const count = breakdown[state] || 0;
    const alarm = state === 'unaccounted' && count > 0 ? ' alarm' : '';
    return `<span class="seg seg-${state}${alarm}" style="width:${pct(count, total)}" title="${state}: ${count}">${state}: ${count}</span>`;
  }).join('');
  return `<div class="rail" role="img" aria-label="assignment status rail">${segs}</div>`;
}

function orphanBadges(orphans) {
  return Object.entries(orphans).map(([projection, o]) =>
    `<span class="orphan">orphans (${esc(projection)}): ${o.orphan_count} · components: ${o.connected_components}</span>`).join(' ');
}

// Nested disposition ledger (answer Q4 / AC-HONEST-ZERO). Selects the pre-computed
// disposition_ledger record; performs NO counting. Shows BOTH permanent denominators, the
// deterministic zero as a precision statement, ineligible/fixture ALONGSIDE and expandable by
// exclusion_reason+rule+version, and build-over-build progress as state transitions.
function dispositionLedger(model) {
  const L = model.disposition_ledger;
  const d = L.assignment_disposition;
  const dispRow = (label, key) => `<span class="disp disp-${key}" title="${key}: ${d[key]}">${esc(label)}: <b>${d[key]}</b></span>`;
  const exclusions = L.exclusions.map(g =>
    `<details class="excl"><summary>${esc(g.assignment_state)} · ${esc(g.exclusion_reason)} · rule ${esc(g.rule || 'n/a')}@${esc(g.version || 'n/a')} — <b>${g.count}</b></summary>`
    + `<div class="members">${g.node_ids.slice(0, 40).map(esc).join(', ')}${g.node_ids.length > 40 ? ` <em>+${g.node_ids.length - 40} more</em>` : ''}</div></details>`).join('');
  const transitions = L.transitions.length
    ? `<div class="transitions">${L.transitions.slice(0, 30).map(t => `<span class="trans">${esc(t.transition)}${t.node_id ? `: ${esc(t.node_id)}` : ''}</span>`).join(' ')}</div>`
    : '<div class="note">baseline build — no state transitions yet</div>';
  return `<div class="ledger">`
    + `<div class="ledger-head"><span class="denominator epistemic">EPISTEMIC ACCOUNTING — ${esc(L.epistemic_accounting.statement)}</span>`
    + `<span class="denominator coverage">DOMAIN MAP COVERAGE — ${esc(L.domain_map_coverage.statement)}</span></div>`
    + `<div class="precision">${esc(L.deterministic_zero.statement)}</div>`
    + `<div class="disp-row">${dispRow('documented_anchor', 'documented_anchor')}${dispRow('deterministic_rule_assignment', 'deterministic_rule_assignment')}`
    + `${dispRow('ratified_neural_assignment', 'ratified_neural_assignment')}${dispRow('ambiguous', 'ambiguous')}${dispRow('no_anchor', 'no_anchor')}</div>`
    + `<div class="alongside">OUTSIDE CURRENT DOMAIN ASSIGNMENT — ineligible_subject: <b>${L.alongside.ineligible_subject}</b> · fixture_only: <b>${L.alongside.fixture_only}</b> · unaccounted: <b>${L.alongside.unaccounted}</b></div>`
    + (exclusions ? `<div class="exclusions"><h3>Excluded subjects (expandable by exclusion_reason + rule + version)</h3>${exclusions}</div>` : '')
    + `<h3>Build-over-build progress (state transitions)</h3>${transitions}</div>`;
}

// Runtime (production) event backbone (answer Q1 / AC-PROVENANCE-AXIS). Selects the persisted
// edge_bundle_projection records and draws SOLID bundles from the Runtime lens only. Line width
// derives from distinct PRODUCTION contracts (not raw incidence); the label states both contract
// and incidence counts; the remainder chip opens the corresponding provenance lens. The renderer
// only SELECTS a projection and reads its fields — it never filters or counts edges itself.
function runtimeEventBackbone(model) {
  const projections = model.edge_bundle_projections.filter(p => p.relation_family === 'event_incidence' && p.counts_by_provenance.production.total > 0);
  const rows = projections.map(p => {
    const prod = p.counts_by_provenance.production;
    const width = Math.min(24, 2 + p.distinct_contract_count * 2);
    const chip = `+${p.counts_by_provenance.test.total} test · +${p.counts_by_provenance.fixture.total} fixture · +${p.counts_by_provenance.docs.total} docs · +${p.counts_by_provenance.unknown.total} unknown`;
    return `<div class="bundle runtime" data-bundle-uid="${esc(p.bundle_uid)}">`
      + `<span class="solid" style="height:${width}px"></span>`
      + `${esc(p.source_scope_id)} → ${esc(p.target_scope_id)} `
      + `<b>${p.distinct_contract_count} production envelopes</b> · ${prod.emits} emits · ${prod.consumes} consumes `
      + `<a class="remainder" href="${esc(p.expansion_address)}">${esc(chip)}</a></div>`;
  }).join('');
  const strip = model.test_only_contracts.length
    ? `<div class="test-only">TEST-ONLY CONTRACTS — ${model.test_only_contracts.length} envelope kind${model.test_only_contracts.length === 1 ? '' : 's'} have no production incidence: `
      + `${model.test_only_contracts.slice(0, 20).map(esc).join(', ')}${model.test_only_contracts.length > 20 ? ` <em>+${model.test_only_contracts.length - 20} more</em>` : ''}</div>`
    : '<div class="note">no test-only contracts</div>';
  return `<div class="bundles runtime-backbone"><h3>Runtime event backbone (production lens — DEFAULT)</h3>`
    + `${rows || '<div class="empty">no production event contracts</div>'}${strip}</div>`;
}

function l1Landscape(model, viewsByScope, title, emphasizeEvents) {
  const estate = viewsByScope.get('scope:estate');
  const zones = model.scopes.filter(s => s.parent_scope_id === 'scope:estate');
  const notShown = model.conservation.edge_projection.not_shown_by_family;
  const active = model.conservation.edge_projection;
  const scopeById = new Map(model.scopes.map(s => [s.scope_id, s]));
  const cards = zones.map(scope => {
    const view = viewsByScope.get(scope.scope_id);
    if (!view) return '';
    // Inner cores are the SEMANTIC bounded-context cores only (the plugin's verified domain
    // members). Physical sub-partitions (path scopes) are summarized as a count, not enumerated,
    // so the L1 silhouette stays recognizable in seconds (answer Q5 fixed-zone geometry).
    const coreIds = scope.child_scope_ids.filter(id => scopeById.get(id)?.scope_kind === 'bounded_context');
    const cores = coreIds.map(id => viewsByScope.get(id)).filter(Boolean)
      .map(c => `<div class="core">${scopeChip(c)}<div class="predicate">${esc(c.membership_predicate)}</div>`
        + `${statusRail(c.assignment_breakdown, Math.max(c.node_count, 1))}${orphanBadges(c.orphans)}</div>`).join('');
    const subCount = scope.child_scope_ids.length - coreIds.length;
    const subLine = subCount > 0 ? `<div class="predicate">${subCount} nested sub-scope${subCount === 1 ? '' : 's'} (descend to enumerate)</div>` : '';
    return `<div class="card zone-${esc(scope.layout_zone)}">${scopeChip(view)}`
      + `<div class="predicate">${esc(view.membership_predicate)}</div>`
      + statusRail(view.assignment_breakdown, Math.max(view.node_count, 1))
      + orphanBadges(view.orphans) + subLine
      + (cores ? `<div class="cores">${cores}</div>` : '') + `</div>`;
  }).join('');
  const eventBundles = model.edge_bundles.filter(b => b.relation_family === 'event_incidence');
  const eventList = emphasizeEvents
    ? `<div class="bundles"><h3>Event backbone (rolled through substrate spine)</h3>`
      + eventBundles.map(b => `<div class="bundle" data-bundle-id="${esc(b.bundle_id)}">${esc(b.source_scope_id)} → ${esc(b.target_scope_id)} `
        + `<b>${b.relation_family}</b> ×${b.exact_edge_count} <a href="${esc(b.expansion_address)}">expand</a></div>`).join('') + `</div>`
    : '';
  const notShownLine = Object.entries(notShown).sort().map(([f, c]) => `${esc(f)}: ${c}`).join(' · ');
  // The DEFAULT L1 view leads with the nested disposition ledger and the Runtime (production)
  // event backbone; the event-flow overlay keeps the rolled substrate list for comparison.
  const ledger = emphasizeEvents ? '' : dispositionLedger(model);
  const backbone = emphasizeEvents ? eventList : runtimeEventBackbone(model);
  return `<section id="view-${emphasizeEvents ? 'root-event-flow' : 'root-default'}" class="view">`
    + `<h2>${esc(title)}</h2>`
    + `<div class="conservation">estate nodes: <b>${model.conservation.estate_node_total}</b> · edges: <b>${model.conservation.edge_total}</b> · `
    + `active projection (event incidence): <b>${active.active_edge_count}</b> · not shown here: <b>${active.not_shown_edge_count}</b> `
    + `<span class="not-shown">[${notShownLine}] — see coupling matrix</span></div>`
    + ledger
    + statusRail(estate.assignment_breakdown, Math.max(estate.node_count, 1))
    + `<div class="landscape">${cards}</div>${backbone}</section>`;
}

function couplingMatrix(model, viewsByScope) {
  const families = [...new Set(model.coupling.cells.map(c => c.relation_family))].sort();
  const scopes = model.coupling.l1_scopes;
  const label = id => esc(viewsByScope.get(id)?.label || id);
  const tabs = families.map(family => {
    const cellByKey = new Map(model.coupling.cells.filter(c => c.relation_family === family).map(c => [`${c.source_scope_id}\u0000${c.target_scope_id}`, c.exact_edge_count]));
    const header = `<tr><th>src \\ dst</th>${scopes.map(s => `<th>${label(s)}</th>`).join('')}</tr>`;
    const rows = scopes.map(src => `<tr><th>${label(src)}</th>`
      + scopes.map(dst => { const v = cellByKey.get(`${src}\u0000${dst}`) || 0; return `<td class="${v ? 'nz' : 'z'}">${v}</td>`; }).join('') + `</tr>`).join('');
    return `<div class="dsm-tab" data-family="${esc(family)}"><h3>${esc(family)}</h3><table class="dsm">${header}${rows}</table></div>`;
  }).join('');
  return `<section id="view-root-coupling-matrix" class="view"><h2>L1 directional coupling DSM (relation-family tabs)</h2>${tabs}</section>`;
}

function memberList(ids, cap = 40) {
  // Presentation-only truncation with a VISIBLE remainder count + expansion note (never a
  // silent drop): the compiler's group record carries every id; the renderer draws the
  // canonical first N by stable address and states the exact omitted count.
  const shown = ids.slice(0, cap).map(esc).join(', ');
  const more = ids.length > cap ? ` <em>+${ids.length - cap} more (expand group to enumerate)</em>` : '';
  return `<div class="members">${shown}${more}</div>`;
}
function unknownFrontier(model, viewsByScope) {
  const uf = model.unknown_frontier;
  const amb = uf.ambiguous_groups.map(g => `<div class="ugroup ambiguous"><b>${g.count}</b> ambiguous nodes · candidates: `
    + `${g.candidates.map(c => `<span class="cand">${esc(c)}</span>`).join(' ')} · reason: ${esc(g.reason || 'n/a')}`
    + memberList(g.node_ids) + `</div>`).join('');
  const noAnchor = uf.no_anchor_groups.map(g => `<div class="ugroup no_anchor"><b>${g.count}</b> no_anchor · ${esc(g.physical_scope_id)} · kind ${esc(g.node_kind)}`
    + memberList(g.node_ids) + `</div>`).join('');
  const ineligible = uf.ineligible_subject_groups.map(g => `<div class="ugroup ineligible"><b>${g.count}</b> ineligible_subject · ${esc(g.physical_scope_id)} · kind ${esc(g.node_kind)}</div>`).join('');
  const fixture = uf.fixture_only_groups.map(g => `<div class="ugroup fixture"><b>${g.count}</b> fixture_only · ${esc(g.physical_scope_id)} · kind ${esc(g.node_kind)}</div>`).join('');
  return `<section id="view-unknown-frontier" class="view"><h2>Unknown Frontier</h2>`
    + `<p class="note">Unknowns are uncertain, not negligible. No context fill; no candidate treated as parent; every node physically locatable.</p>`
    + `<h3>Ambiguous (by candidate-set signature + reason)</h3>${amb || '<div class="empty">none</div>'}`
    + `<h3>No anchor (by physical scope → node kind)</h3>${noAnchor || '<div class="empty">none</div>'}`
    + `<h3>Ineligible subject (canon §1.2 non-domains)</h3>${ineligible || '<div class="empty">none</div>'}`
    + `<h3>Fixture only (synthetic / test)</h3>${fixture || '<div class="empty">none</div>'}</section>`;
}

function contextInterior(model, viewsByScope) {
  const chosen = model.descent?.chosen?.scope_id;
  const contextView = chosen ? viewsByScope.get(chosen) : null;
  if (!contextView) return `<section id="view-context-interior" class="view"><h2>Context Interior</h2><div class="empty">no assigned context to descend into</div></section>`;
  const aggregates = model.scopes.filter(s => s.parent_scope_id === chosen && s.scope_kind === 'aggregate');
  const cards = aggregates.map(agg => {
    const v = viewsByScope.get(agg.scope_id);
    const status = v.membership_status === 'membership not yet established'
      ? `<span class="mne">membership not yet established</span>` : `<b>${v.node_count}</b> members`;
    return `<div class="agg">${scopeChip(v)} — ${status}<div class="predicate">${esc(v.membership_predicate)}</div></div>`;
  }).join('');
  return `<section id="view-context-interior" class="view"><h2>Context Interior — ${esc(contextView.label)}</h2>`
    + `<p class="note">Chosen deterministically: highest distinct incident envelope_kind count among assigned members.</p>`
    + statusRail(contextView.assignment_breakdown, Math.max(contextView.node_count, 1))
    + orphanBadges(contextView.orphans)
    + `<div class="aggregates">${cards || '<div class="empty">no canon aggregates</div>'}</div></section>`;
}

function componentContract(model, viewsByScope) {
  // L3 emitters → named envelope → consumers, selected from persisted event_contract_slices
  // (answer Q7). The center Envelope-spine column is now POPULATED with the production contract
  // slices — envelope_kind is the identity-bearing, addressable event unit, not a generic bus.
  const production = model.event_contract_slices.filter(s => s.projection_id === 'production');
  const emitters = production.filter(s => s.emitter_scopes.length);
  const consumers = production.filter(s => s.consumer_scopes.length);
  const emitCol = emitters.map(s => `<div class="bundle" data-envelope="${esc(s.envelope_node_id)}">`
    + `${s.emitter_scopes.map(esc).join(', ')} → <b>${esc(s.envelope_name)}</b> ×${s.counts.emit_incidence_count}</div>`).join('');
  const consumeCol = consumers.map(s => `<div class="bundle" data-envelope="${esc(s.envelope_node_id)}">`
    + `<b>${esc(s.envelope_name)}</b> → ${s.consumer_scopes.map(esc).join(', ')} ×${s.counts.consume_incidence_count}</div>`).join('');
  const spineCol = production.map(s => `<div class="contract-slice" data-envelope="${esc(s.envelope_node_id)}" data-address="${esc(s.logical_address)}">`
    + `<b>${esc(s.envelope_name)}</b><div class="predicate">${s.counts.distinct_emitter_count} emitter scope(s) · ${s.counts.distinct_consumer_count} consumer scope(s)</div>`
    + `<div class="predicate">emit ×${s.counts.emit_incidence_count} · consume ×${s.counts.consume_incidence_count}</div>`
    + `<div class="addr">${esc(s.logical_address)}</div></div>`).join('');
  const col = (title, body) => `<div class="col"><h3>${esc(title)}</h3>${body || '<div class="empty">none</div>'}</div>`;
  return `<section id="view-component-contract" class="view"><h2>Component & Contract — event backbone (emitters → named envelope → consumers)</h2>`
    + `<p class="note">Runtime (production) contract slices; test/fixture/docs incidences carried in the corresponding provenance projections.</p>`
    + `<div class="three-col">${col('Emitters → envelope', emitCol)}${col('Envelope spine (contracts)', spineCol)}${col('Envelope → consumers', consumeCol)}</div></section>`;
}

function moduleDsm(model, viewsByScope) {
  // L4 module DSM for the chosen context's code_dependency bundles among its L1 ancestors.
  const rows = model.coupling.cells.filter(c => c.relation_family === 'code_dependency');
  const scopes = model.coupling.l1_scopes;
  const label = id => esc(viewsByScope.get(id)?.label || id);
  const cellByKey = new Map(rows.map(c => [`${c.source_scope_id}\u0000${c.target_scope_id}`, c.exact_edge_count]));
  const header = `<tr><th>src \\ dst</th>${scopes.map(s => `<th>${label(s)}</th>`).join('')}</tr>`;
  const body = scopes.map(src => `<tr><th>${label(src)}</th>`
    + scopes.map(dst => { const v = cellByKey.get(`${src}\u0000${dst}`) || 0; return `<td class="${v ? 'nz' : 'z'}">${v}</td>`; }).join('') + `</tr>`).join('');
  return `<section id="view-module-dsm" class="view"><h2>Module DSM (code dependency)</h2><table class="dsm">${header}${body}</table></section>`;
}

function nodeDossier(model, viewsByScope) {
  // L4 receipt dossier for a deterministically-chosen node (canonical first member of the
  // chosen context, else first assigned membership, else first membership).
  const chosen = model.descent?.chosen?.scope_id;
  const pick = model.memberships.find(m => m.semantic_scope_id === chosen)
    || model.memberships.find(m => m.assignment_state === 'assigned') || model.memberships[0];
  if (!pick) return `<section id="view-node-dossier" class="view"><h2>Node Dossier</h2><div class="empty">no nodes</div></section>`;
  const bundlesOut = model.edge_bundles.filter(b => b.source_scope_id === pick.primary_scope_id).slice(0, 10);
  // Select the pre-computed compiler-side evidence_summary for this node (answer Q2 / AC-EVIDENCE-INDEX).
  // The renderer SELECTS it; it does not build or count evidence.
  const ev = model.evidence_summaries.find(e => e.subject_id === pick.node_id);
  const provRows = ev ? Object.entries(ev.by_provenance).map(([cls, c]) =>
    `<span class="prov prov-${cls}">${esc(cls)}: ${c.occurrences} occ / ${c.unique_locations} loc</span>`).join(' ') : '';
  const previewRows = ev ? ev.canonical_preview.map(r =>
    `<div class="witness prov-${r.provenance_class}">${esc(r.repo)}/${esc(r.file)}:${r.line} <em>[${esc(r.provenance_class)}]</em></div>`).join('') : '';
  const channels = ev ? `<tr><th>evidence channels (kept separate)</th><td>`
    + `witnesses: ${ev.channels.witnesses_total} · grounded_in: ${ev.channels.grounded_in.length} · `
    + `derivation evidence: ${ev.channels.derivation_evidence.length} · examined edges: ${ev.channels.examined_edge_ids.length} · `
    + `evidence_pointers: ${ev.channels.evidence_pointers.length} · refusals: ${ev.channels.refusal_evidence.length}`
    + `${ev.decision_first ? ' <em>(decision receipt + grounded_in precede raw witnesses)</em>' : ''}</td></tr>` : '';
  const evidenceBlock = ev ? `<tr><th>evidence_summary</th><td>total occurrences <b>${ev.total_occurrences}</b> · unique locations <b>${ev.unique_locations}</b> · primary_witness_class ${esc(ev.primary_witness_class)}<br>${provRows}</td></tr>`
    + channels
    + `<tr><th>canonical_preview <em>(${ev.preview_included} of ${ev.total_occurrences}; ${ev.preview_omitted} omitted)</em></th><td>${previewRows || '—'}<div class="addr">continuation: ${esc(ev.continuation_address)}</div><div class="addr">member_set_digest: ${esc(ev.member_set_digest)}</div></td></tr>`
    : `<tr><th>evidence_summary</th><td class="empty">no persisted evidence summary for this subject</td></tr>`;
  return `<section id="view-node-dossier" class="view"><h2>Node & Receipt Dossier</h2>`
    + `<table class="dossier">`
    + `<tr><th>logical address</th><td>${esc(ev?.subject_logical_address || `estate://cartography/node/${pick.node_id}`)} <button class="copy" data-raw="${esc(pick.node_id)}">copy raw id</button></td></tr>`
    + `<tr><th>raw record id</th><td class="raw">${esc(pick.node_id)}</td></tr>`
    + `<tr><th>build-pinned address</th><td class="addr">estate://cartography@${esc(model.build_id)}/node/${esc(pick.node_id)}</td></tr>`
    + `<tr><th>kind</th><td>${esc(pick.node_kind)}</td></tr>`
    + `<tr><th>physical parent</th><td>${esc(pick.primary_scope_id)}</td></tr>`
    + `<tr><th>semantic scope</th><td>${esc(pick.semantic_scope_id || '—')}</td></tr>`
    + `<tr><th>assignment disposition</th><td>${esc(pick.assignment_disposition)} · state ${esc(pick.assignment_state)} (${esc(pick.assignment_basis)})${pick.domain ? ` → ${esc(pick.domain)}` : ''}</td></tr>`
    + evidenceBlock
    + `<tr><th>one-hop bundles (out)</th><td>${bundlesOut.map(b => `${esc(b.relation_family)}→${esc(b.target_scope_id)} ×${b.exact_edge_count}`).join('<br>') || '—'}</td></tr>`
    + `</table></section>`;
}

function buildDiff(model, viewsByScope) {
  const byClass = { SOURCE: [], SEMANTIC: [], VIEW: [] };
  for (const c of model.changes) (byClass[c.change_class] || (byClass[c.change_class] = [])).push(c);
  const block = (cls) => `<div class="diffclass"><h3>${esc(cls)}</h3>` + (byClass[cls].length
    ? byClass[cls].map(c => `<div class="change ${esc(c.kind)}">${esc(c.kind)}: ${esc(c.node_id || `${c.from}→${c.to}`)}</div>`).join('')
    : '<div class="empty">no changes</div>') + `</div>`;
  return `<section id="view-build-diff" class="view"><h2>One-build diff (SOURCE / SEMANTIC / VIEW)</h2>`
    + (model.changes.length === 0 ? '<p class="note">No prior build supplied — baseline build.</p>' : '')
    + block('SOURCE') + block('SEMANTIC') + block('VIEW') + `</section>`;
}

const STYLE = `body{font:13px/1.4 system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
h1{padding:12px 16px;margin:0;background:#161b22;border-bottom:1px solid #30363d}
.view{padding:16px;border-bottom:2px solid #30363d}
h2{margin:0 0 8px;font-size:18px}h3{margin:12px 0 4px;font-size:14px;color:#8b949e}
.landscape{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px}
.core{margin-top:8px;padding:8px;border:1px dashed #3fb950;border-radius:6px;background:#0d1c11}
.scope{cursor:pointer;font-weight:600}.scope em{color:#8b949e;font-weight:400;font-size:11px}
.predicate{color:#8b949e;font-size:11px;margin:4px 0}
.rail{display:flex;height:16px;border-radius:4px;overflow:hidden;margin:4px 0;border:1px solid #30363d}
.seg{font-size:9px;color:#0d1117;text-align:center;white-space:nowrap;overflow:hidden}
.seg-assigned{background:#3fb950}.seg-ambiguous{background:#d29922}.seg-no_anchor{background:#6e7681}
.seg-ineligible_subject{background:#484f58}.seg-fixture_only{background:#8957e5}.seg-unaccounted.alarm{background:#f85149;color:#fff;font-weight:700}
.orphan{font-size:10px;color:#58a6ff;margin-right:8px}
.conservation{background:#161b22;padding:8px;border-radius:6px;margin-bottom:8px;font-size:12px}
.not-shown{color:#8b949e}
.dsm{border-collapse:collapse;font-size:11px}.dsm th,.dsm td{border:1px solid #30363d;padding:3px 6px;text-align:center}
.dsm td.nz{background:#1f6feb33;font-weight:700}.dsm td.z{color:#484f58}
.ugroup{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:6px;margin:4px 0}
.ugroup.ambiguous{border-color:#d29922}.ugroup.no_anchor{border-color:#6e7681}
.cand{background:#d2992233;border:1px solid #d29922;border-radius:10px;padding:1px 6px;font-size:11px}
.members{color:#8b949e;font-size:10px;margin-top:2px;word-break:break-all}
.three-col{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.col{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px}
.bundle{font-size:11px;padding:2px 0}.mne{color:#d29922;font-style:italic}
.empty{color:#6e7681;font-style:italic}.note{color:#8b949e;font-size:11px}
.dossier,.diffclass{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px}
.dossier th{text-align:right;color:#8b949e;padding-right:8px;vertical-align:top}
.change.add{color:#3fb950}.change.remove{color:#f85149}.change.assignment_transition{color:#d29922}
.ledger{background:#0d1c11;border:1px solid #3fb950;border-radius:8px;padding:10px;margin:8px 0}
.ledger-head{display:flex;flex-wrap:wrap;gap:12px;font-weight:700}
.denominator{padding:2px 8px;border-radius:4px}.denominator.epistemic{background:#1f6feb33}.denominator.coverage{background:#3fb95033}
.precision{margin:6px 0;color:#3fb950;font-weight:600}
.disp-row{display:flex;flex-wrap:wrap;gap:10px;margin:4px 0}.disp{font-size:11px}
.disp-documented_anchor b{color:#3fb950}.disp-deterministic_rule_assignment b{color:#58a6ff}.disp-ratified_neural_assignment b{color:#a371f7}
.disp-no_anchor b{color:#8b949e}.disp-ambiguous b{color:#d29922}
.alongside{color:#8b949e;font-size:11px;margin:4px 0}
.excl summary{cursor:pointer;font-size:11px;color:#8b949e}.transitions{font-size:10px}.trans{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1px 6px;margin-right:4px}
.runtime-backbone .bundle.runtime{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0}
.solid{display:inline-block;width:24px;background:#3fb950;border-radius:2px}
.remainder{color:#8b949e;font-size:10px}.test-only{margin-top:6px;color:#d29922;font-size:11px}
.contract-slice{background:#0d1c11;border:1px solid #3fb950;border-radius:6px;padding:6px;margin:3px 0;font-size:11px}
.addr{color:#6e7681;font-size:9px;word-break:break-all}.raw{color:#8b949e;word-break:break-all}
.copy{font-size:9px;background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;cursor:pointer}
.prov{font-size:10px;margin-right:6px}.prov-production{color:#3fb950}.prov-test{color:#d29922}.prov-fixture{color:#8957e5}.prov-docs{color:#58a6ff}.prov-unknown{color:#6e7681}
.witness{font-size:10px;color:#8b949e}`;

export function renderAtlas(model, humanViews) {
  const viewsByScope = new Map(humanViews.map(v => [v.scope_id, v]));
  const sections = [
    l1Landscape(model, viewsByScope, 'L1 Estate Landscape (default: Runtime projection + disposition ledger)', false),
    l1Landscape(model, viewsByScope, 'L1 Estate Landscape (event flow overlay — all provenance)', true),
    couplingMatrix(model, viewsByScope),
    unknownFrontier(model, viewsByScope),
    contextInterior(model, viewsByScope),
    componentContract(model, viewsByScope),
    moduleDsm(model, viewsByScope),
    nodeDossier(model, viewsByScope),
    buildDiff(model, viewsByScope),
  ].join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Estate Cartography Atlas — ${esc(model.build_id)}</title><style>${STYLE}</style></head>`
    + `<body><h1>Estate Cartography Atlas <small>${esc(model.build_id)} · view-model v${esc(model.view_model_version)} · `
    + `conservation ${model.conservation.passed ? 'PASSED' : 'FAILED'}</small></h1>${sections}</body></html>`;
}
