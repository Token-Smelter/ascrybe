const $ = selector => document.querySelector(selector);
const SVG_NS = 'http://www.w3.org/2000/svg';
const GROUPS = [
  ['platform', 'Platform'], ['service', 'Service'], ['datastore', 'Datastore'], ['provider', 'Provider'],
];
const state = { snapshot: null, selected: null, mode: 'graph', loading: false };

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function svg(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}
function sourceLine(ref) {
  const line = element('span', '', 'evidence-line');
  line.append(element('b', `${ref.standing || 'source'} · ${ref.date || 'date unknown'}`));
  line.append(element('code', `${ref.path}${ref.lines ? `:${ref.lines}` : ''} · ${ref.commit_sha || 'un-pinned'}`));
  if (ref.detail) line.append(element('span', ref.detail));
  return line;
}
function section(parent, heading, content) {
  parent.append(element('h3', heading));
  if (Array.isArray(content)) {
    if (!content.length) return parent.append(element('p', 'Unknown · no evidence has been attached.'));
    for (const node of content) parent.append(node);
  } else parent.append(element('p', content || 'Unknown · not established by the available source.'));
}
function componentById(id) { return state.snapshot?.components.find(component => component.id === id); }
function renderInspector(result) {
  const { component: item, observed } = result;
  const parent = $('#fork-inspector'); parent.replaceChildren();
  parent.append(element('h2', item.label));
  parent.append(element('div', `${item.group} · ${item.id}`, 'inspector-subtitle'));
  const dl = element('dl', null, 'inspector-status');
  for (const [key, value] of [
    ['Approved decision', item.approved_decision_ids.length ? 'Recorded' : 'None linked'],
    ['Implementation verified', item.implementation_verified ? 'Yes · see proof' : 'No'],
    ['Observed graph', observed.state === 'graph_observed' ? 'Native component fact' :
      observed.state === 'repository_locator' ? 'Repository locator only' :
        observed.state === 'source_locator' ? 'Source file locator only' : 'Pending / not matched'],
    ['Evidence freshness', item.evidence_freshness || 'unknown'],
  ]) { const cell = element('div'); cell.append(element('dt', key), element('dd', value)); dl.append(cell); }
  parent.append(dl);
  section(parent, 'Current evidence', item.current_claim);
  if (item.current_evidence?.length) {
    parent.append(sourceLine(item.current_evidence[0]));
    if (item.current_evidence.length > 1) {
      const extra = element('details', null, 'inspector-more');
      extra.append(element('summary', `${item.current_evidence.length - 1} more source reference(s)`));
      for (const ref of item.current_evidence.slice(1)) extra.append(sourceLine(ref));
      parent.append(extra);
    }
  }
  if (item.predicted_consequence) {
    section(parent, 'Derived prediction · build readback not run', item.predicted_consequence);
  }
  if (['graph_observed', 'repository_locator', 'source_locator'].includes(observed.state)) {
    const graphEvidence = observed.nodes.map(node => {
      const row = element('span', '', 'evidence-line');
      row.append(element('b', node.association === 'repository_locator'
        ? 'Repository locator only · no native component fact'
        : node.association === 'source_locator' ? 'Source file locator only · no native component fact'
          : `${node.kind} · graph-observed, not implementation-verified`));
      row.append(element('code', `${node.node_id} · ${observed.projection_id}`));
      if (node.properties?.source_commit) row.append(element('span', `Source ${node.properties.source_commit}`));
      return row;
    });
    section(parent, 'Bound graph records', graphEvidence);
    if (observed.reason) parent.append(element('p', observed.reason));
  } else section(parent, 'Observed layer', observed.reason || 'Graph evidence is not matched yet.');
  parent.append(element('h3', 'Approved intent'));
  if (item.approved_decision_ids.length) {
    const details = element('details', null, 'inspector-more');
    details.append(element('summary', `${item.approved_decision_ids.length} recorded decision(s) · ${item.approved_decision_ids.join(', ')} · show text and pins`));
    for (const id of item.approved_decision_ids) {
      const decision = state.snapshot.decisions.find(row => row.id === id);
      if (!decision) continue;
      details.append(element('p', `${id} · ${decision.text}`));
      details.append(sourceLine({ ...decision.source_ref, standing: 'recorded decision' }));
    }
    parent.append(details);
  } else parent.append(element('p', 'No recorded decision linked to this surface.'));
  section(parent, 'Proposed treatment', item.proposed_treatment?.text || 'No treatment recorded.');
  if (item.proposed_treatment?.source_ref) parent.append(sourceLine({ ...item.proposed_treatment.source_ref, standing: 'proposed only' }));
  section(parent, 'Unknown or stale provider state', item.provider_state?.detail || 'Provider state has not been checked.');
  section(parent, 'Needed work', item.needed_work || 'Work not yet described.');
  if (item.verification_refs?.length) section(parent, 'Implementation proof', item.verification_refs.map(sourceLine));
  for (const [heading, ids] of [['Related by root cause (not dependency)', item.related_by_shared_root_cause || []],
    ['Dependencies', item.dependencies], ['Affected components', item.affected_components]]) {
    parent.append(element('h3', heading));
    if (!ids.length) { parent.append(element('p', 'None recorded; absence has not been proven.')); continue; }
    for (const id of ids) {
      const target = componentById(id);
      const button = element('button', target?.label || id, 'inspector-dep');
      button.type = 'button'; button.addEventListener('click', () => selectComponent(id)); parent.append(button);
    }
  }
}

async function selectComponent(id) {
  state.selected = id;
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  renderGraph(); renderTable();
  $('#fork-inspector').replaceChildren(element('p', 'Loading exact source and dependency context…'));
  try {
    const response = await fetch(`/api/fork-planning/component?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (state.selected === id) renderInspector(result);
  } catch (error) {
    $('#fork-inspector').replaceChildren(element('h2', 'Inspector unavailable'), element('p', `${error.message}. Check the local read-only server and retry.`));
  }
}

function visibleComponents() {
  const { snapshot } = state; if (!snapshot) return [];
  const treatment = $('#treatment-filter').value, freshness = $('#freshness-filter').value;
  const layer = $('#layer-filter').value, term = $('#component-search').value.toLowerCase().trim();
  return snapshot.components.filter(item => (treatment === 'all' || item.treatment === treatment)
    && (freshness === 'all' || item.evidence_freshness === freshness)
    && (layer !== 'observed' || item.graph_matches > 0)
    && (layer !== 'planned' || item.layer !== 'graph_observed')
    && (!term || `${item.label} ${item.id} ${item.group}`.toLowerCase().includes(term)));
}

function renderGraph() {
  const groups = $('#fork-groups'), nodes = $('#fork-nodes'), links = $('#fork-links');
  groups.replaceChildren(); nodes.replaceChildren(); links.replaceChildren();
  const visible = visibleComponents();
  $('#graph-empty').hidden = visible.length > 0;
  const columns = GROUPS.map(([id]) => visible.filter(item => item.group === id));
  const height = Math.max(650, 125 + Math.max(...columns.map(list => list.length), 1) * 74);
  $('#fork-graph').setAttribute('viewBox', `0 0 1200 ${height}`);
  const centers = new Map();
  columns.forEach((list, index) => {
    const x = 14 + index * 298;
    groups.append(svg('rect', { x, y: 10, width: 282, height: height - 22, rx: 6, class: 'fork-lane' }));
    groups.append(svg('text', { x: x + 16, y: 39, class: 'fork-lane-title' }, GROUPS[index][1]));
    list.forEach((item, row) => centers.set(item.id, { x: x + 14, y: 63 + row * 74 }));
  });
  for (const item of visible) for (const dep of item.dependencies || []) {
    const a = centers.get(dep), b = centers.get(item.id); if (!a || !b) continue;
    links.append(svg('path', { d: `M ${a.x + 254} ${a.y + 25} C ${a.x + 278} ${a.y + 25}, ${b.x - 18} ${b.y + 25}, ${b.x} ${b.y + 25}`, class: 'fork-link' }));
  }
  for (const item of visible) {
    const at = centers.get(item.id);
    const group = svg('g', { transform: `translate(${at.x} ${at.y})`, tabindex: 0, role: 'button',
      'aria-label': `${item.label}, ${item.group}, ${item.graph_matches ? 'component graph observed' : item.graph_locators ? 'source or repository locator only' : 'plan context only'}`,
      class: `fork-node${item.graph_matches ? ' is-observed' : item.graph_locators ? ' has-locator' : ''}${state.selected === item.id ? ' is-selected' : ''}` });
    group.append(svg('rect', { width: 254, height: 51 }), svg('circle', { cx: 13, cy: 17, r: 3.4, class: 'node-marker' }),
      svg('text', { x: 23, y: 20, class: 'node-name' }, item.label.length > 30 ? `${item.label.slice(0, 29)}…` : item.label),
      svg('text', { x: 13, y: 39, class: 'node-state' }, `${item.graph_matches ? 'observed' : item.graph_locators ? 'source/repo locator' : item.treatment} · ${item.evidence_freshness}`));
    group.addEventListener('click', () => selectComponent(item.id));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectComponent(item.id); } });
    nodes.append(group);
  }
}

function renderTable() {
  const body = $('#coverage-body'); body.replaceChildren();
  for (const item of visibleComponents()) {
    const tr = element('tr');
    const name = element('td'), button = element('button', item.label); button.type = 'button';
    button.setAttribute('aria-current', state.selected === item.id ? 'true' : 'false');
    button.addEventListener('click', () => selectComponent(item.id)); name.append(button);
    const fields = [item.group, item.graph_matches ? 'Native component fact' : item.graph_locators ? 'Source/repo locator only' : 'Pending / unknown',
      item.approved_decision_ids.length ? item.approved_decision_ids.join(', ') : 'None linked',
      item.implementation_verified ? 'Verified · see inspector' : 'Not verified', item.treatment];
    tr.append(name, ...fields.map(value => element('td', value))); body.append(tr);
  }
  const decisions = $('#decisions-list'); decisions.replaceChildren();
  for (const decision of state.snapshot?.decisions || []) {
    const li = element('li'); li.append(element('strong', `${decision.id} — ${decision.text}`));
    li.append(element('small', `${decision.source_ref.path} · ${decision.source_ref.commit_sha} · ${decision.source_ref.date}`));
    decisions.append(li);
  }
  const coverage = $('#coverage-status-list'); coverage.replaceChildren();
  for (const row of state.snapshot?.coverage_status || []) {
    const li = element('li'); li.append(element('strong', `${row.surface} — ${row.status}`));
    li.append(element('small', `${row.source_ref.path} · ${row.source_ref.commit_sha} · ${row.source_ref.date}`));
    coverage.append(li);
  }
}

function fillTreatmentOptions(items) {
  const select = $('#treatment-filter'), held = select.value; select.replaceChildren();
  const all = element('option', 'All treatments'); all.value = 'all'; select.append(all);
  for (const value of [...new Set(items.map(item => item.treatment))].sort()) {
    const option = element('option', value); option.value = value; select.append(option);
  }
  select.value = [...select.options].some(option => option.value === held) ? held : 'all';
}

async function load() {
  if (state.loading) return;
  state.loading = true; $('#refresh-graph').disabled = true;
  try {
    const response = await fetch('/api/fork-planning', { cache: 'no-store' });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || `HTTP ${response.status}`);
    state.snapshot = snapshot;
    $('#scenario-title').textContent = snapshot.scenario?.title || 'No private scenario loaded';
    $('#scenario-source').textContent = snapshot.scenario?.source_ref
      ? `Plan source: ${snapshot.scenario.source_ref.path} · ${snapshot.scenario.source_ref.commit_sha} · ${snapshot.scenario.source_ref.date}`
      : 'Supply a private overlay to browse recorded intent. No source assertion is inferred from an empty view.';
    const graph = snapshot.graph;
    $('#graph-state').textContent = graph.state === 'matched' ? 'Observed graph matched'
      : graph.state === 'mismatch' ? 'Projection mismatch' : 'Observed layer pending';
    $('#graph-state').className = `state-pill ${graph.state === 'matched' ? 'is-matched' : graph.state === 'mismatch' ? 'is-mismatch' : ''}`;
    const uninspected = (snapshot.coverage_status || []).filter(row => /unknown|not inspected|partially/i.test(row.status)).length;
    $('#graph-alert').textContent = graph.state === 'matched'
      ? `Graph matched · ${graph.native_components} native component facts, ${graph.locator_components} source/repo locators; a locator is not implementation proof. ${uninspected} of ${snapshot.coverage_status.length} source-inspection categories remain partial or unknown; provider dashboards unobserved.`
      : `${graph.state === 'mismatch' ? 'Mismatch:' : 'Pending:'} ${graph.reason}. Planned claims remain visible; nothing is inferred from missing graph data.`;
    $('#graph-alert').className = `graph-alert ${graph.state === 'matched' ? 'is-matched' : graph.state === 'mismatch' ? 'is-mismatch' : ''}`;
    $('#plan-status').textContent = `${snapshot.components.length} surfaces · ${snapshot.decisions.length} recorded decisions`;
    $('#plan-status').classList.toggle('is-warning', graph.state !== 'matched');
    $('#projection-id').textContent = snapshot.scenario?.expected_projection_id || 'Base projection not pinned';
    $('#coverage-count').textContent = `${snapshot.components.length} surfaces`;
    fillTreatmentOptions(snapshot.components);
    renderGraph(); renderTable();
    const fromUrl = decodeURIComponent(location.hash.slice(1));
    const selected = state.selected && componentById(state.selected) ? state.selected
      : fromUrl && componentById(fromUrl) ? fromUrl : null;
    if (selected) selectComponent(selected);
  } catch (error) {
    $('#graph-alert').textContent = `Unable to load the read-only view: ${error.message}. Retry when the private scenario is available.`;
    $('#graph-alert').className = 'graph-alert is-mismatch';
    $('#plan-status').textContent = 'Source layers unavailable'; $('#plan-status').classList.add('is-warning');
  } finally { state.loading = false; $('#refresh-graph').disabled = false; }
}

for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  for (const entry of document.querySelectorAll('[data-mode]')) entry.setAttribute('aria-pressed', String(entry === button));
  $('#graph-panel').hidden = state.mode !== 'graph'; $('#table-panel').hidden = state.mode !== 'table';
});
for (const id of ['layer-filter', 'treatment-filter', 'freshness-filter']) $(`#${id}`).addEventListener('change', () => { renderGraph(); renderTable(); });
$('#component-search').addEventListener('input', () => { renderGraph(); renderTable(); });
$('#refresh-graph').addEventListener('click', load);
if (new URLSearchParams(location.search).get('mode') === 'table') {
  document.querySelector('[data-mode="table"]').click();
}
load();
