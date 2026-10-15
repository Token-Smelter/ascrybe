
export const EVIDENCE_VIEW_STYLES = `
.class-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.08em;white-space:nowrap}
.class-chip b{font-size:12px;line-height:1}
.ev-section{margin:14px 0;padding:10px 10px 10px 12px;border-radius:8px;background:#101c28}
.ev-section>header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.ev-section>p.caption{margin:0 0 8px;font-size:11px;line-height:1.45;color:#a9bccf}
.ev-card{margin:7px 0;padding:8px 9px;border-radius:6px;background:#15222f;overflow-wrap:anywhere}
.ev-card>h4{margin:0 0 4px;font-size:12.5px}
.ev-card dl.kv{grid-template-columns:118px 1fr;margin:4px 0 0;font-size:11.5px}
.witness{display:flex;align-items:center;gap:6px;margin-top:4px}
.witness code{flex:1;padding:3px 6px;border-radius:4px;background:#0b1520;border:1px solid #2b4054;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#d8e8f6;overflow-wrap:anywhere}
.witness button{padding:2px 7px;font-size:10.5px}
.prov{padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;background:#0b1520;border:1px solid #33465a;color:#bed0e0}
.tables{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;background:#0a121b}
.table-tabs{display:flex;gap:5px;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid var(--line);background:#101d29}
.table-tabs button[aria-selected=true]{border-color:var(--accent);background:#123247;font-weight:700}
.table-tabs button small{margin-left:5px;color:#9fb3c7}
.table-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px 12px;border-bottom:1px solid #26384a}
.table-controls input[type=search]{min-width:230px}
.table-scroll{flex:1;overflow:auto;padding:0 12px 12px}
.table-scroll table{border-collapse:collapse;width:100%;font-size:11.5px}
.table-scroll th{position:sticky;top:0;z-index:1;text-align:left;padding:7px 8px;background:#152536;border-bottom:1px solid #3a5169;cursor:pointer;white-space:nowrap}
.table-scroll th[aria-sort]:after{content:" \\2195";color:#6d88a3}
.table-scroll th[aria-sort=ascending]:after{content:" \\2191";color:var(--accent)}
.table-scroll th[aria-sort=descending]:after{content:" \\2193";color:var(--accent)}
.table-scroll td{padding:6px 8px;border-bottom:1px solid #1d2c3b;vertical-align:top;max-width:360px;overflow-wrap:anywhere}
.table-scroll tbody tr{cursor:pointer}
.table-scroll tbody tr:hover{background:#16283a}
.table-scroll tbody tr[aria-selected=true]{background:#1b354a;outline:2px solid var(--accent);outline-offset:-2px}
.table-scroll td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfe2f3}
.table-foot{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid #26384a;background:#101d29}
/* One search reaches EVERY family, so the panel has to be tall enough to SHOW more than the
   first one — a 360px box that fits only graph nodes hides the whole point of the box. */
.results{width:min(480px,92vw);max-height:min(70vh,720px)}
.results h4{position:sticky;top:0;margin:0;padding:6px 9px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#8fa6bc;background:#0d1926;border-bottom:1px solid #26384a}
.gap-note{margin:8px 0;padding:8px 9px;border-left:3px solid #eab308;background:#241f0d;font-size:11.5px;line-height:1.45}
aside h2{overflow-wrap:anywhere}

`;

/** Built once, lazily: the whole point is that the browser reads the same bytes the CLI does. */
function evidenceIndexOf() {
  if (!window.__evidenceIndex) window.__evidenceIndex = buildEvidenceIndex(graph);
  return window.__evidenceIndex;
}

const evidenceSearchCache = new Map();
function searchTextOf(item) {
  let value = evidenceSearchCache.get(item.id + item.family);
  if (value === undefined) { value = recordSearchText(item); evidenceSearchCache.set(item.id + item.family, value); }
  return value;
}

/** The class badge. Hue + border style + glyph + ALL-CAPS name, so it survives greyscale. */
function evidenceChip(classId) {
  const meta = EVIDENCE_CLASSES[classId] || EVIDENCE_CLASSES.extracted;
  const chip = document.createElement('span');
  chip.className = 'class-chip';
  chip.dataset.evidenceClass = meta.id;
  chip.style.color = meta.color;
  chip.style.border = `2px ${meta.border} ${meta.color}`;
  chip.style.background = `${meta.color}14`;
  chip.title = meta.caption;
  chip.append(text('b', meta.glyph), text('span', meta.label));
  return chip;
}

/** One witness, verbatim and copyable. This is a static artifact, so the text IS the link. */
function witnessRow(witness) {
  const row = document.createElement('div');
  row.className = 'witness';
  const value = witnessText(witness);
  const code = text('code', value);
  code.dataset.witness = value;
  row.append(code);
  if (witness.provenance_class) { const badge = text('span', witness.provenance_class, 'prov'); badge.dataset.provenanceClass = witness.provenance_class; row.append(badge); }
  const copy = action('Copy', () => navigator.clipboard?.writeText(value));
  copy.setAttribute('aria-label', `Copy ${value}`);
  row.append(copy);
  return row;
}

function appendWitnesses(root, witnesses, emptyNote) {
  const items = witnesses || [];
  if (!items.length) { root.append(text('p', emptyNote || 'No file:line witness on this record.', 'muted')); return 0; }
  for (const witness of items) root.append(witnessRow(witness));
  return items.length;
}

/** One normalised record, rendered as a card that reaches its own witnesses. */
function recordCard(item, { expanded = false } = {}) {
  const card = document.createElement('article');
  card.className = 'ev-card';
  card.dataset.recordId = item.id;
  card.dataset.recordFamily = item.family;
  card.dataset.evidenceClass = item.evidenceClass;
  card.append(text('h4', item.title));
  const meta = text('div', `${item.family.replaceAll('_', ' ')}${item.subtitle ? ` · ${item.subtitle}` : ''}`, 'muted');
  card.append(meta);
  const entries = Object.entries(item.values).filter(([key, value]) => value !== '' && value != null && key !== 'witness');
  if (entries.length) card.append(kv(expanded ? entries : entries.slice(0, 8)));
  appendWitnesses(card, item.witnesses, item.evidenceClass === 'interpretation'
    ? 'No file:line witness by construction — this class is evidenced by a reproducible slice witness (spec + members + graph digest), shown above.'
    : 'This record carries no file:line witness.');
  if (item.danglingSubjects?.length) card.append(text('p', `Names ${item.danglingSubjects.length} subject(s) absent from this graph: ${item.danglingSubjects.join(', ')}`, 'gap-note'));
  return card;
}

/** A class-grouped block. Records of different evidentiary weight are NEVER interleaved. */
function classSection(root, classId, items, { heading = null } = {}) {
  if (!items.length) return;
  const meta = EVIDENCE_CLASSES[classId];
  const section = document.createElement('section');
  section.className = 'ev-section';
  section.dataset.evidenceSection = classId;
  section.style.borderLeft = `4px ${meta.border} ${meta.color}`;
  const header = document.createElement('header');
  header.append(evidenceChip(classId), text('span', `${items.length} record${items.length === 1 ? '' : 's'}`, 'muted'));
  if (heading) header.append(text('strong', heading));
  section.append(header, text('p', meta.caption, 'caption'));
  for (const item of items.slice(0, 60)) section.append(recordCard(item));
  if (items.length > 60) section.append(text('p', `${items.length - 60} further ${classId} record(s) not shown here — open the tables for the full set.`, 'muted'));
  root.append(section);
}

/**
 * The keys a subject is known by across the record families. A node is named by its id; an
 * entity by both `entity:x` and `x`; a capability node by its id and its bare type name. The
 * families disagree about which spelling they use, so the view asks for all of them rather
 * than picking one and silently missing the rest.
 */
function subjectKeys(raw, data) {
  const keys = [raw?.id, data?.id, raw?.name, raw?.entity, raw?.concept].filter(Boolean);
  if (raw?.kind === 'capability' && raw.name) keys.push(`capability:${raw.name}`);
  if (raw?.kind === 'envelope_kind' && raw.name) keys.push(raw.name);
  if (data?.entity) keys.push(data.entity, `entity:${data.entity}`);
  if (typeof data?.id === 'string' && data.id.startsWith('entity:')) keys.push(data.id.slice('entity:'.length));
  return [...new Set(keys)];
}

/** Kind-specific identity, so a route reads as a route and a capability as a capability. */
function kindDetail(root, raw) {
  if (raw?.kind === 'route') {
    root.append(text('h3', 'Route'));
    root.append(kv([['Method', raw.method], ['Path', raw.route], ['Declared', raw.declared_route], ['Owner', raw.owner], ['Auth', raw.auth], ['Auth basis', raw.auth_basis], ['Mount prefix', raw.mount_prefix], ['Mount basis', raw.mount_basis], ['Framework', raw.framework], ['Provenance', raw.provenance_class]]));
  } else if (raw?.kind === 'capability') {
    root.append(text('h3', 'Capability'));
    root.append(kv([['Providers', (raw.providers || []).join(', ')], ['Declared providers', (raw.declared_providers || []).join(', ')], ['Consumers', (raw.consumers || []).join(', ')], ['Optional for', (raw.optional_for || []).join(', ')], ['provide() sites', raw.provide_site_count], ['require() sites', raw.require_site_count], ['request() sites', raw.call_site_count], ['Primary witness class', raw.primary_witness_class]]));
  } else if (raw?.kind === 'envelope_kind') {
    appendEnvelopeSites(root, raw);
  }
}

/**
 * Emit and consume sites for one envelope kind, each with its provenance class. The class
 * comes off the witness where the extractor recorded one; where it did not, the view says so
 * instead of defaulting the site to production.
 */
function appendEnvelopeSites(root, raw) {
  const sites = { emits: [], consumes: [], other: [] };
  for (const edge of graph.edges || []) {
    const targets = edge.to ? [edge.to] : (edge.candidates || []);
    if (!targets.includes(raw.id) && edge.from !== raw.id) continue;
    const bucket = edge.kind === 'emits' ? 'emits' : edge.kind === 'consumes' ? 'consumes' : 'other';
    sites[bucket].push(edge);
  }
  root.append(text('h3', 'Envelope traffic'));
  for (const [label, edges] of [['Emit sites', sites.emits], ['Consume sites', sites.consumes], ['Other relationships', sites.other]]) {
    if (!edges.length) continue;
    const box = document.createElement('div');
    box.dataset.envelopeSites = label;
    box.append(text('b', `${label} (${edges.length})`));
    for (const edge of edges.slice(0, 40)) {
      const entry = document.createElement('div');
      entry.className = 'ev-card';
      entry.append(text('h4', `${edge.from} → ${(edge.to || (edge.candidates || []).join(', ')) || '?'}`));
      entry.append(text('div', `${edge.kind} · ${edge.status || 'resolved'}`, 'muted'));
      const witnesses = edge.witnesses || [];
      if (witnesses.length) for (const witness of witnesses) entry.append(witnessRow(witness));
      else entry.append(text('p', 'This edge carries no witness in the embedded graph.', 'muted'));
      if (!witnesses.some(witness => witness.provenance_class)) entry.append(text('p', 'No provenance_class on these witnesses — the edge family does not carry one, so none is assumed.', 'gap-note'));
      box.append(entry);
    }
    if (edges.length > 40) box.append(text('p', `${edges.length - 40} further site(s) not shown.`, 'muted'));
    root.append(box);
  }
  if (!sites.emits.length && !sites.consumes.length && !sites.other.length) root.append(text('p', 'No emit or consume relationship reaches this envelope kind in the embedded graph.', 'muted'));
}

/**
 * The core of AC-INSPECTOR: everything the estate has to say about one subject, sorted into
 * evidence classes and never blended.
 */
function appendEvidenceForSubject(root, raw, data) {
  const index = evidenceIndexOf();
  const keys = subjectKeys(raw, data);
  const memberKeys = (data?.memberIds || []).slice(0, 400);
  const own = recordsFor(index, keys);
  const byClass = new Map(EVIDENCE_CLASS_ORDER.map(name => [name, []]));
  for (const item of own) byClass.get(item.evidenceClass).push(item);

  root.append(text('h3', 'Layers that touched this'));
  if (!own.length) root.append(text('p', 'No annotation, derivation, claim, entity record or refusal in this graph names this subject.', 'muted'));
  for (const name of EVIDENCE_CLASS_ORDER) {
    if (name === 'refusal') continue;
    classSection(root, name, byClass.get(name));
  }
  root.append(text('h3', 'Refusals naming this'));
  const refusals = byClass.get('refusal');
  if (refusals.length) classSection(root, 'refusal', refusals);
  else root.append(text('p', 'No refusal record names this subject.', 'muted'));

  if (memberKeys.length) {
    const memberRecords = recordsFor(index, memberKeys).filter(item => !own.includes(item));
    const summary = {};
    for (const item of memberRecords) summary[item.family] = (summary[item.family] || 0) + 1;
    const entries = Object.entries(summary).sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      const details = document.createElement('details');
      details.dataset.memberEvidence = 'true';
      details.append(text('summary', `Evidence on this group\u2019s ${memberKeys.length} member(s): ${memberRecords.length} record(s)`));
      details.append(kv(entries.map(([family, count]) => [family.replaceAll('_', ' '), count])));
      root.append(details);
    }
  }
}

/** Inspect one normalised record directly (from a table row or a search hit). */
function inspectRecord(item) {
  state.inspected = { kind: 'record', item };
  els.title.textContent = item.title;
  els.subtitle.textContent = `${item.family.replaceAll('_', ' ')}${item.subtitle ? ` · ${item.subtitle}` : ''}`;
  const root = els.inspector;
  root.textContent = '';
  const header = document.createElement('div');
  header.append(evidenceChip(item.evidenceClass));
  root.append(header, text('p', EVIDENCE_CLASSES[item.evidenceClass].caption, 'caption muted'));
  root.append(recordCard(item, { expanded: true }));
  if (item.subjects.length) {
    root.append(text('h3', 'Subjects this record names'));
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const subject of item.subjects.slice(0, 24)) {
      const button = action(subject, () => inspectSubjectId(subject));
      button.dataset.inspectSubject = subject;
      actions.append(button);
    }
    root.append(actions);
  }
  const raw = document.createElement('details');
  raw.dataset.rawRecord = item.id;
  raw.append(text('summary', 'Canonical record (verbatim)'), text('pre', JSON.stringify(item.raw, null, 2)));
  root.append(raw);
}

/** Inspect a subject by id, whether or not it is drawn in the current projection. */
function inspectSubjectId(id) {
  const raw = byId.get(id);
  if (raw) {
    const drawn = (state.projection.nodes || []).find(node => node.id === id);
    if (drawn && cy && cy.getElementById(id).length) { select(drawn); return; }
    renderSelection({ ...raw, id: raw.id });
    return;
  }
  const aggregate = (state.projection.nodes || []).find(node => node.id === id);
  if (aggregate) { renderSelection(aggregate); return; }
  const index = evidenceIndexOf();
  const named = recordsFor(index, [id]);
  els.title.textContent = id;
  els.subtitle.textContent = 'subject named by records, not a node in this graph';
  els.inspector.textContent = '';
  els.inspector.append(text('p', 'This identifier is named by the records below but is not a node in the canonical graph — reported, not invented.', 'gap-note'));
  appendEvidenceForSubject(els.inspector, { id }, { id });
  if (!named.length) els.inspector.append(text('p', 'Nothing in this graph names it.', 'muted'));
}

// ---------------------------------------------------------------------------
// TABLES
// ---------------------------------------------------------------------------
const TABLE_PAGE = 200;

function tableSpec(id) { return TABLE_SPECS.find(spec => spec.id === id) || TABLE_SPECS[0]; }

function tableRecords(spec) {
  const index = evidenceIndexOf();
  return spec.families.flatMap(family => index.byFamily.get(family) || []);
}

function filteredTableRecords(spec) {
  const query = state.table.query.trim().toLowerCase();
  let rows = tableRecords(spec);
  for (const [key, value] of Object.entries(state.table.facets)) if (value) rows = rows.filter(item => String(item.values[key] ?? '') === value);
  if (query) rows = rows.filter(item => searchTextOf(item).includes(query));
  const sortKey = state.table.sort || spec.sort || spec.columns[0].key;
  const direction = state.table.dir || 1;
  return rows.slice().sort((a, b) => {
    const left = a.values[sortKey], right = b.values[sortKey];
    const numeric = typeof left === 'number' && typeof right === 'number';
    const compare = numeric ? left - right : String(left ?? '').localeCompare(String(right ?? ''));
    return (compare || a.id.localeCompare(b.id)) * direction;
  });
}

function renderTableTabs() {
  const tabs = $('tableTabs');
  tabs.textContent = '';
  for (const spec of evidenceIndexOf().tables) {
    const button = text('button', spec.label);
    button.dataset.tableTab = spec.id;
    button.setAttribute('aria-selected', String(spec.id === state.table.id));
    button.append(text('small', String(spec.count)));
    button.onclick = () => setTable(spec.id);
    tabs.append(button);
  }
}

function renderTableControls(spec) {
  const controls = $('tableControls');
  controls.textContent = '';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'tableFilter';
  search.placeholder = `Filter ${spec.label.toLowerCase()}…`;
  search.setAttribute('aria-label', `Filter ${spec.label}`);
  search.value = state.table.query;
  search.oninput = () => { state.table.query = search.value; state.table.page = 0; renderTableBody(spec); };
  controls.append(search);
  const rows = tableRecords(spec);
  for (const facet of spec.facets || []) {
    const counts = new Map();
    for (const item of rows) { const value = String(item.values[facet] ?? ''); if (value) counts.set(value, (counts.get(value) || 0) + 1); }
    if (!counts.size) continue;
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.dataset.tableFacet = facet;
    select.setAttribute('aria-label', `Filter by ${facet}`);
    select.append(new Option(`All ${facet.replaceAll('_', ' ')}`, ''));
    for (const [value, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 200)) select.append(new Option(`${value} (${count})`, value));
    select.value = state.table.facets[facet] || '';
    select.onchange = () => { state.table.facets[facet] = select.value; state.table.page = 0; renderTableBody(spec); renderTableControls(spec); };
    label.append(text('span', facet.replaceAll('_', ' ')), select);
    controls.append(label);
  }
  const reset = action('Reset filters', () => { state.table.query = ''; state.table.facets = {}; state.table.page = 0; renderTable(); });
  reset.dataset.tableReset = 'true';
  controls.append(reset);
}

function renderTableBody(spec) {
  const rows = filteredTableRecords(spec);
  const scroll = $('tableScroll');
  scroll.textContent = '';
  const table = document.createElement('table');
  table.dataset.table = spec.id;
  const head = document.createElement('tr');
  head.append(text('th', 'Class'));
  const sortKey = state.table.sort || spec.sort || spec.columns[0].key;
  for (const column of spec.columns) {
    const cell = text('th', column.label);
    cell.dataset.sort = column.key;
    if (column.key === sortKey) cell.setAttribute('aria-sort', state.table.dir === -1 ? 'descending' : 'ascending');
    cell.onclick = () => { state.table.dir = sortKey === column.key ? -(state.table.dir || 1) : 1; state.table.sort = column.key; renderTableBody(spec); };
    head.append(cell);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const body = document.createElement('tbody');
  body.id = 'tableBody';
  const page = Math.max(0, Math.min(state.table.page, Math.floor(Math.max(0, rows.length - 1) / TABLE_PAGE)));
  state.table.page = page;
  for (const item of rows.slice(page * TABLE_PAGE, page * TABLE_PAGE + TABLE_PAGE)) {
    const row = document.createElement('tr');
    row.dataset.rowId = item.id;
    row.dataset.evidenceClass = item.evidenceClass;
    row.tabIndex = 0;
    const chipCell = document.createElement('td');
    chipCell.append(evidenceChip(item.evidenceClass));
    row.append(chipCell);
    for (const column of spec.columns) {
      const value = item.values[column.key];
      const cell = text('td', value === '' || value == null ? '—' : String(value));
      cell.dataset.column = column.key;
      if (column.key === 'witness' || column.key === 'declaration') cell.className = 'mono';
      row.append(cell);
    }
    const open = () => { for (const other of body.querySelectorAll('tr[aria-selected=true]')) other.removeAttribute('aria-selected'); row.setAttribute('aria-selected', 'true'); inspectRecord(item); };
    row.onclick = open;
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
    body.append(row);
  }
  table.append(thead, body);
  scroll.append(table);
  if (!rows.length) scroll.append(text('p', 'No record matches these filters. Reset them to see the whole family.', 'muted'));
  const foot = $('tableFoot');
  foot.textContent = '';
  const first = rows.length ? page * TABLE_PAGE + 1 : 0;
  const status = text('span', `Showing ${first}–${Math.min(rows.length, (page + 1) * TABLE_PAGE)} of ${rows.length} (family total ${tableRecords(spec).length})`);
  status.dataset.tableStatus = 'true';
  foot.append(status);
  if (rows.length > TABLE_PAGE) {
    const previous = action('Previous', () => { state.table.page = page - 1; renderTableBody(spec); });
    previous.disabled = page === 0;
    const next = action('Next', () => { state.table.page = page + 1; renderTableBody(spec); });
    next.disabled = (page + 1) * TABLE_PAGE >= rows.length;
    foot.append(previous, next);
  }
  for (const gap of evidenceIndexOf().gaps.filter(item => spec.families.includes(item.family))) foot.append(text('span', `Field gap — ${gap.gap} ${gap.consequence}`, 'gap-note'));
}

function renderTable() {
  const spec = tableSpec(state.table.id);
  renderTableTabs();
  renderTableControls(spec);
  renderTableBody(spec);
}

function setTable(id) {
  state.table.id = id;
  state.table.query = '';
  state.table.facets = {};
  state.table.sort = null;
  state.table.dir = 1;
  state.table.page = 0;
  renderTable();
}

/** Graph and tables are two workspaces over ONE selection; the inspector is shared. */
function setWorkspace(kind) {
  state.workspace = kind === 'tables' ? 'tables' : 'graph';
  const tables = state.workspace === 'tables';
  $('tables').classList.toggle('hidden', !tables);
  // The canvas chrome (legend, drill hint, status line, guidance card, matrix) is absolutely
  // positioned OVER the stage at a higher z-index than the tables, so leaving it visible both
  // floats graph commentary over a table and intercepts clicks meant for a table tab. Toggling
  // inline display keeps each element's own class-driven visibility intact on the way back.
  for (const id of ['legend', 'hint', 'statusLine', 'guidance', 'matrix']) $(id).style.display = tables ? 'none' : '';
  // The projection builder configures the GRAPH. In the tables workspace it is dead chrome
  // eating two rows of table height, so it collapses and comes back untouched on the way out.
  $('workbench').style.display = tables ? 'none' : '';
  $('workspaceGraph').setAttribute('aria-selected', String(!tables));
  $('workspaceTables').setAttribute('aria-selected', String(tables));
  $('workspaceGraph').classList.toggle('primary', !tables);
  $('workspaceTables').classList.toggle('primary', tables);
  document.body.dataset.workspace = state.workspace;
  if (tables) renderTable();
  else if (cy) requestAnimationFrame(() => cy.fit(cy.elements(':visible'), 70));
}

// ---------------------------------------------------------------------------
// SEARCH — one box across nodes, envelope kinds, route paths, claims and refusal reasons.
// ---------------------------------------------------------------------------
function runSearch() {
  const query = els.search.value.trim().toLowerCase();
  els.results.textContent = '';
  state.searchIds = [];
  if (!query) { els.results.classList.add('hidden'); updateLabels(); return; }
  const index = evidenceIndexOf();
  const nodes = graph.nodes
    .filter(node => `${node.id} ${node.name || ''} ${node.repo || ''} ${node.kind}`.toLowerCase().includes(query))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    // Deliberately few: node hits must not push the record families off the bottom of the list.
    .slice(0, 8);
  const records = index.records.filter(item => searchTextOf(item).includes(query));
  const grouped = new Map();
  for (const item of records) { const bucket = grouped.get(item.family) || []; if (bucket.length < 5) bucket.push(item); grouped.set(item.family, bucket); }

  const total = nodes.length + records.length;
  els.results.append(text('h4', `${total} match${total === 1 ? '' : 'es'}`));
  if (nodes.length) {
    els.results.append(text('h4', `Graph nodes (${nodes.length})`));
    for (const node of nodes) {
      const button = text('button', node.name || node.id);
      button.setAttribute('role', 'option');
      button.dataset.resultFamily = 'node';
      button.dataset.resultId = node.id;
      button.append(text('small', `${node.repo || 'unknown'} · ${node.kind}`));
      button.onclick = () => { closeSearch(node.name || node.id); inspectSubjectId(node.id); };
      els.results.append(button);
    }
  }
  for (const [family, items] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    const totalForFamily = records.filter(item => item.family === family).length;
    els.results.append(text('h4', `${family.replaceAll('_', ' ')} (${totalForFamily})`));
    for (const item of items) {
      const button = text('button', item.title);
      button.setAttribute('role', 'option');
      button.dataset.resultFamily = family;
      button.dataset.resultId = item.id;
      button.append(text('small', `${EVIDENCE_CLASSES[item.evidenceClass].label} · ${item.subtitle || item.id}`));
      button.onclick = () => { closeSearch(item.title); inspectRecord(item); };
      els.results.append(button);
    }
  }
  els.results.classList.toggle('hidden', total === 0);
  if (!total) { els.results.classList.remove('hidden'); els.results.append(text('p', 'No node, claim, route, capability, wiring record or refusal matches.', 'muted')); }
}

function closeSearch(label) {
  els.search.value = label;
  els.results.classList.add('hidden');
}

/** The evidence census: what the map holds, by class, stated on the landing inspector. */
function appendEvidenceCensus(root) {
  const index = evidenceIndexOf();
  root.append(text('h3', 'Evidence by class'));
  root.append(text('p', 'Different claims have different evidentiary weight. These are counted separately and never summed into one number.', 'muted'));
  for (const name of EVIDENCE_CLASS_ORDER) {
    const count = index.byClass[name] || 0;
    const row = document.createElement('div');
    row.className = 'ev-card';
    row.dataset.censusClass = name;
    const header = document.createElement('header');
    header.style.display = 'flex';
    header.style.gap = '8px';
    header.style.alignItems = 'center';
    header.append(evidenceChip(name), text('b', String(count)));
    row.append(header, text('p', EVIDENCE_CLASSES[name].caption, 'muted'));
    root.append(row);
  }
  root.append(text('h3', 'Record families'));
  root.append(kv(Object.entries(index.counts).sort((a, b) => b[1] - a[1]).map(([family, count]) => [family.replaceAll('_', ' '), count])));
  const open = action('Open tables', () => setWorkspace('tables'));
  open.className = 'primary';
  open.dataset.openTables = 'true';
  root.append(open);
  for (const gap of index.gaps) root.append(text('p', `${gap.family}: ${gap.gap} ${gap.consequence}`, 'gap-note'));
}

export function evidenceViewSource() {
  return [
    `const TABLE_PAGE=${TABLE_PAGE};`,
    `const evidenceSearchCache=new Map();`,
    evidenceIndexOf.toString(),
    searchTextOf.toString(),
    evidenceChip.toString(),
    witnessRow.toString(),
    appendWitnesses.toString(),
    recordCard.toString(),
    classSection.toString(),
    subjectKeys.toString(),
    kindDetail.toString(),
    appendEnvelopeSites.toString(),
    appendEvidenceForSubject.toString(),
    inspectRecord.toString(),
    inspectSubjectId.toString(),
    tableSpec.toString(),
    tableRecords.toString(),
    filteredTableRecords.toString(),
    renderTableTabs.toString(),
    renderTableControls.toString(),
    renderTableBody.toString(),
    renderTable.toString(),
    setTable.toString(),
    setWorkspace.toString(),
    runSearch.toString(),
    closeSearch.toString(),
    appendEvidenceCensus.toString(),
  ].join('\n');
}
