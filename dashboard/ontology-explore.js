// Explorer for a proposed ontology: overview, then domain, then concept, then quoted source. Everything shown is a proposal read
// from /api/explore; the page records nothing and invents no status. A connection that is not in the data is shown as unknown.
const N = n => Number(n ?? 0).toLocaleString('en-US');
const PCT = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');
const FORM = { responsibility: 'Responsibility', policy: 'Rule or constraint', practice: 'Procedure', strategy: 'Option among alternatives', type: 'Kind of thing', theme: 'Theme' };
const FORM_HELP = {
  responsibility: 'What code or configuration does.', policy: 'A rule, boundary, permission or obligation that governs subjects.',
  practice: 'A process or procedure that people or tools carry out.', strategy: 'An option described among alternatives. It does not say who chose it, or that anyone did.',
  type: 'A kind of thing whose instances are subjects.', theme: 'An aesthetic, narrative or meaning that sources describe.',
};
const STAND = ['Source-observed', 'Source and documents', 'Documents only', 'Code comments only', 'No located evidence'];
const STAND_CLASS = ['o', 'm', 'd', 'c', 'n'];
const BASIS = { read_in_source: 'text observed in source', stated_in_source_comment: 'text observed in a source comment', stated_in_document: 'stated by a document', referenced_by_document: 'a document points at it without containing it' };
const KIND = { conceptual_domain: 'Subject area', responsibility: 'Responsibility', process: 'Process', actor: 'Actor', scope: 'Scope' };
const DISP = { not_returned: 'The model did not place or list it', unassigned: 'The model returned it as unassigned', batch_failed: 'Its batch could not be read' };
const FINDING = { datastore: 'Same-named datastore', network: 'Network call', sdk_forwarding: 'Shared integration', shared_vendor_destination: 'Same vendor named', asset_copy: 'Asset copy', none_located: 'No connection located', unresolved_lead: 'Lead could not be pinned' };

const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const a = (href, ...kids) => h('a', { href }, ...kids);
const tag = (text, cls) => h('span', { class: `tag ${cls ?? ''}` }, text);
const words = s => String(s ?? '').replaceAll('_', ' ').replaceAll('-', ' ');
const main = document.getElementById('main');
// A peer configured as a loopback address is reached on the host name this page was reached by, so a LAN reader gets a working link.
const peerBase = url => { try { const u = new URL(url); if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) u.hostname = location.hostname; return u.origin; } catch { return String(url).replace(/\/$/u, ''); } };
const show = (...nodes) => main.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));
let M = null, S = null;

// ---- derived indexes -------------------------------------------------------------------------------------------------
function derive() {
  const C = M.concepts, D = M.domains;
  S = { conceptDomain: { reconciled: new Int32Array(C.length).fill(-1), original: new Int32Array(C.length).fill(-1) }, out: C.map(() => []), inn: C.map(() => []), stats: new Map(), index: null };
  D.forEach((d, i) => { for (const m of d.members) S.conceptDomain[d.set][m] = i; S.stats.set(i, tally(d.members)); });
  M.relations.forEach((r, i) => { S.out[r[0]].push(i); S.inn[r[1]].push(i); });
  S.index = C.map((c, i) => `${c[1]} ${D[S.conceptDomain.reconciled[i]]?.label ?? ''} ${M.schemes[c[5]].label}`.toLowerCase());
}
function tally(ids) {
  const t = { n: ids.length, stand: [0, 0, 0, 0, 0], form: [0, 0, 0, 0, 0, 0] };
  for (const i of ids) { const c = M.concepts[i]; if (c[3] >= 0) t.stand[c[3]] += 1; if (c[2] >= 0) t.form[c[2]] += 1; }
  return t;
}
const concept = i => M.concepts[i];
const cHref = i => `#/concept/${i}`;
const dHref = i => `#/domain/${i}`;
const src = i => M.sources[i];

// ---- shared pieces -----------------------------------------------------------------------------------------------------
function bar(t) {
  const el = h('div', { class: 'bar', role: 'img', 'aria-label': STAND.map((s, i) => `${s} ${t.stand[i]}`).join(', ') });
  t.stand.forEach((n, i) => { if (n) { const seg = h('i', { class: STAND_CLASS[i] }); seg.style.flexGrow = n; seg.style.flexBasis = 0; el.append(seg); } });
  return el;
}
const key = () => h('div', { class: 'key', 'aria-label': 'Evidence basis colours' }, STAND.map((s, i) => h('span', { class: STAND_CLASS[i] }, s)));
const standLine = t => { const s = t.stand; const parts = []; if (s[0] + s[1]) parts.push(`${N(s[0] + s[1])} with source-observed support`); if (s[2]) parts.push(`${N(s[2])} documents only`); if (s[3]) parts.push(`${N(s[3])} comments only`); if (s[4]) parts.push(`${N(s[4])} no located evidence`); return parts.join(' · '); };
const crumbs = items => h('p', { class: 'crumbs' }, items.flatMap((it, i) => [i ? h('span', { 'aria-hidden': 'true' }, '›') : null, it.href ? a(it.href, it.text) : h('span', {}, it.text)]));
const seg = (options, value, on) => h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => on(v) }, label)));
const setNav = name => document.querySelectorAll('[data-nav]').forEach(l => (l.dataset.nav === name ? l.setAttribute('aria-current', 'page') : l.removeAttribute('aria-current')));
const sortRows = (rows, by, dir) => [...rows].sort((x, y) => (typeof x[by] === 'string' ? x[by].localeCompare(y[by]) : x[by] - y[by]) * dir);

function setting(label, value, note) { return [h('dt', {}, label), h('dd', {}, value, note ? h('small', {}, note) : null)]; }

// ---- bounded graph -------------------------------------------------------------------------------------------------------
// Three columns: what points at the focus, the focus, what it points at. Arrows are drawn from the subject of the predicate to its object.
function wrap(text, width, lines = 2) {
  const out = []; let cur = '';
  for (const part of String(text).split(/(?<=[ -])/)) {
    if ((cur + part).length > width && cur) { out.push(cur.trimEnd()); cur = part; } else cur += part;
  }
  out.push(cur.trimEnd());
  if (out.length > lines) { const keep = out.slice(0, lines); keep[lines - 1] = `${keep[lines - 1].slice(0, width - 1)}…`; return keep; }
  return out.map(l => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}
const SVG = 'http://www.w3.org/2000/svg';
const s = (tagName, attrs, ...kids) => { const el = document.createElementNS(SVG, tagName); for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v); for (const kid of kids) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid)); return el; };
const textLines = (lines, x, y, anchor, lh = 17) => s('text', { x, y: y - ((lines.length - 1) * lh) / 2, 'text-anchor': anchor }, ...lines.map((l, i) => s('tspan', { x, dy: i ? lh : 0 }, l)));

function graph({ focus, left, right, leftTitle, rightTitle }) {
  const narrow = main.clientWidth < 640;
  const cap = narrow ? 6 : 7;
  const L = left.slice(0, cap), R = right.slice(0, cap);
  const wrapEl = h('div', { class: 'graphwrap' });
  let svg;
  const node = (x, y, w, hgt, item, isFocus) => {
    const g = s('g', { class: isFocus ? 'node focus' : 'node' }, s('rect', { x, y, width: w, height: hgt, rx: 3 }), textLines(wrap(item.label, narrow ? 40 : 28), x + w / 2, y + hgt / 2 + 5, 'middle'));
    if (item.title) g.append(s('title', {}, item.title));
    if (item.href) { const link = s('a', { href: item.href }); link.append(g); return link; }
    return g;
  };
  if (!narrow) {
    const W = 1000, nw = 210, fx = 395, rowH = 64, rows = Math.max(L.length, R.length, 1), H = 34 + rows * rowH;
    svg = s('svg', { class: 'graph', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Connections of the selected item' });
    const fy = 34 + (rows * rowH) / 2 - 24;
    svg.append(s('defs', {}, s('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6b7280' }))));
    svg.append(s('text', { class: 'colhead', x: 0, y: 14 }, leftTitle), s('text', { class: 'colhead', x: W, y: 14, 'text-anchor': 'end' }, rightTitle));
    const place = (items, x, isLeft) => items.forEach((it, i) => {
      const y = 34 + i * rowH + ((rows - items.length) * rowH) / 2, cy = y + 24;
      const x1 = isLeft ? x + nw : fx + nw, x2 = isLeft ? fx : x, ty = fy + 24 + (i - (items.length - 1) / 2) * 6;
      svg.append(s('line', { class: 'edge', x1, y1: isLeft ? cy : ty, x2, y2: isLeft ? ty : cy, 'marker-end': 'url(#ah)' }));
      const lines = wrap(it.edge, 20), t = isLeft ? 0.4 : 0.6, mx = x1 + (x2 - x1) * t, my = (isLeft ? cy : ty) + ((isLeft ? ty : cy) - (isLeft ? cy : ty)) * t;
      svg.append(s('g', { class: 'elabel' }, s('rect', { x: mx - 63, y: my - 9 - (lines.length - 1) * 8, width: 126, height: 18 + (lines.length - 1) * 16 }), textLines(lines, mx, my + 4, 'middle', 16)));
      svg.append(node(x, y, nw, 48, it));
    });
    // Arrow direction: an incoming edge ends at the focus, an outgoing edge starts there.
    place(L, 0, true); place(R, W - nw, false);
    svg.append(node(fx, fy, nw, 48, focus, true));
  } else {
    const W = 360, rowH = 84, H = (L.length + R.length) * rowH + 90;
    svg = s('svg', { class: 'graph', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Connections of the selected item' });
    let y = 6;
    const label = text => svg.append(s('text', { class: 'colhead', x: 8, y: y + 12 }, text));
    if (L.length) { label(leftTitle); y += 20; }
    for (const it of L) { svg.append(node(6, y, 348, 44, it)); svg.append(s('text', { x: 18, y: y + 66 }, `↓ ${wrap(it.edge, 36, 1)[0]}`)); y += rowH; }
    svg.append(node(6, y, 348, 44, focus, true)); y += 64;
    if (R.length) { label(rightTitle); y += 20; }
    for (const it of R) { svg.append(s('text', { x: 18, y: y + 4 }, `↓ ${wrap(it.edge, 36, 1)[0]}`)); svg.append(node(6, y + 14, 348, 44, it)); y += rowH; }
    svg.setAttribute('viewBox', `0 0 ${W} ${y + 4}`);
  }
  wrapEl.append(svg);
  const hidden = left.length - L.length + right.length - R.length;
  return h('div', {}, wrapEl, hidden > 0 ? h('p', { class: 'muted' }, `Showing the strongest ${cap} per side. ${N(hidden)} more are in the table.`) : null);
}

function connections({ title, focus, rows, leftTitle, rightTitle, columns }) {
  const box = h('div', {});
  let mode = 'table';
  const draw = () => {
    box.replaceChildren(h('div', { class: 'bar-row' }, h('h2', {}, title), seg([['table', 'Table'], ['graph', 'Graph']], mode, v => { mode = v; draw(); })));
    if (!rows.length) return box.append(h('p', { class: 'empty' }, 'No connections in the data. That means none were observed, not that none exist.'));
    if (mode === 'graph') box.append(graph({ focus, left: rows.filter(r => r.dir === 'in'), right: rows.filter(r => r.dir === 'out'), leftTitle, rightTitle }));
    else box.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : '' }, c.name)))), h('tbody', {}, rows.slice(0, 200).map(r => h('tr', {}, columns.map(c => h('td', { class: c.num ? 'num' : '' }, c.cell(r)))))))), rows.length > 200 ? h('p', { class: 'muted' }, `First 200 of ${N(rows.length)} shown.`) : null);
  };
  draw();
  return box;
}

// ---- groupings ---------------------------------------------------------------------------------------------------------------
function groupsFor(lens) {
  const D = M.domains;
  const withRest = (themes, set) => {
    const listed = new Set(themes.flatMap(t => t.domains)), rest = D.map((d, i) => (d.set === set && !listed.has(i) ? i : -1)).filter(i => i >= 0);
    return [...themes.map(t => ({ ...t, theme: true })), { label: 'Not placed in a theme', definition: 'Domains the model did not include in any cross-source theme. They are retained and searchable; absence from a theme is not a judgement about them.', domains: rest, rest: true }];
  };
  if (lens === 'themes') return withRest(M.themes.reconciled, 'reconciled');
  if (lens === 'original') return withRest(M.themes.original, 'original');
  return M.sources.map((id, i) => ({ label: id, definition: `Domains proposed for the ${id} source.`, domains: D.map((d, j) => (d.set === 'reconciled' && d.source === i ? j : -1)).filter(j => j >= 0), source: i })).filter(g => g.domains.length);
}
const groupConcepts = g => [...new Set(g.domains.flatMap(i => M.domains[i].members))];
const LENS = {
  themes: ['Themes', 'The model grouped its reconciled domains into a few cross-source themes. These are proposals; most domains sit outside any theme, so use Sources or Search to reach them.'],
  sources: ['By source', 'Every reconciled domain under the repository its concepts were read from. No model judgement about grouping is involved.'],
  original: ['First-pass domains', 'The first mapping run grouped concepts into fewer, broader domains and themes. Kept as an alternative lens; the path-shape reading on its domains is a heuristic about where evidence sits, not about what a domain means.'],
};

function coveragePanel() {
  const T = M.coverage?.totals, rc = M.reconcile?.coverage;
  const stat = (label, value, note) => h('div', {}, h('dt', {}, label), h('dd', {}, value, note ? h('small', {}, note) : null));
  return h('details', { class: 'panel coverage' }, h('summary', {}, `Coverage and what is not shown: ${N(M.concepts.length)} concepts retained, ${N(M.domains.filter(d => d.set === 'reconciled').length)} proposed domains`),
    h('dl', {},
      stat('Concepts retained', N(M.concepts.length), 'All are searchable. None is accepted or rejected.'),
      rc ? stat('Placed in a domain', `${N(rc.returned.assigned)} (${PCT(rc.returned.assigned, rc.concepts_given_to_model)})`, `${N(M.unplaced.length)} not placed: see Triage.`) : null,
      T ? stat('Source units read', `${N(T.units_read)} of ${N(T.units_total)}`, `${N(T.units_screened_out)} withheld by screening, ${N(T.units_map_failed + T.units_unknown_outcome + T.units_other_failure)} failed or unknown.`) : null,
      T ? stat('Units cited by a concept', N(T.units_cited_by_concepts), `${N(T.units_grounded)} were checked against code; the rest are read but not grounded.`) : null,
      stat('Runtime verification', 'None', 'Everything is read from source files. Whether it holds at runtime is unknown.'),
      stat('Source-graph layer', 'Not loaded here', 'Links from concepts to extracted code entities are unknown in this viewer, not absent.')));
}

// ---- views ---------------------------------------------------------------------------------------------------------------------
function viewOverview(q) {
  setNav('overview');
  const lens = q.get('lens') ?? 'themes', groups = groupsFor(lens);
  const cards = groups.map((g, i) => {
    const ids = groupConcepts(g), t = tally(ids), srcs = [...new Set(g.domains.map(d => M.domains[d].source))].filter(x => x >= 0);
    return h('a', { class: 'cardlink', href: `#/group/${lens}/${i}` }, h('div', { class: `card ${g.rest ? 'card--quiet' : ''}` }, h('h3', {}, g.label), h('p', { class: 'def' }, g.definition), bar(t),
      h('p', { class: 'facts' }, `${N(g.domains.length)} domains · ${N(ids.length)} concepts${srcs.length ? ` · ${srcs.length} source${srcs.length > 1 ? 's' : ''}` : ''}`), h('p', { class: 'facts' }, standLine(t))));
  });
  show(h('h1', {}, 'What is in this estate'), h('p', { class: 'lede' }, 'Start from a grouping, open a domain, then a concept, then the quoted source. Every concept stays reachable by search whatever grouping it falls under.'),
    coveragePanel(),
    h('div', { class: 'bar-row' }, seg(Object.entries(LENS).map(([k, v]) => [k, v[0]]), lens, v => { location.hash = `#/?lens=${v}`; }), key()),
    h('p', { class: 'lens-note' }, LENS[lens][1]), h('div', { class: 'cards' }, cards.map(c => c)));
}

function domainTable(domainIds, { sort = 'n', dir = -1 } = {}) {
  const rows = domainIds.map(i => ({ i, d: M.domains[i], label: M.domains[i].label, n: M.domains[i].members.length, src: src(M.domains[i].source) ?? '', t: S.stats.get(i), obs: (S.stats.get(i).stand[0] + S.stats.get(i).stand[1]) / (M.domains[i].members.length || 1) }));
  const box = h('div', {});
  const draw = () => {
    const cols = [['label', 'Domain'], ['src', 'Source'], ['n', 'Concepts'], ['obs', 'Evidence basis']];
    box.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([k, name]) => h('th', { class: k === 'n' ? 'num' : '', 'aria-sort': sort === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' }, h('button', { type: 'button', onclick: () => { dir = sort === k ? -dir : (k === 'label' || k === 'src' ? 1 : -1); sort = k; draw(); } }, name + (sort === k ? (dir > 0 ? ' ↑' : ' ↓') : '')))))),
      h('tbody', {}, sortRows(rows, sort, dir).map(r => h('tr', {}, h('td', {}, a(dHref(r.i), r.label), r.d.kind && r.d.set === 'reconciled' ? h('div', { class: 'src' }, `Model-labelled: ${KIND[r.d.kind] ?? words(r.d.kind)}`) : null),
        h('td', {}, r.src), h('td', { class: 'num' }, N(r.n)), h('td', {}, bar(r.t), h('div', { class: 'src' }, `${PCT(r.t.stand[0] + r.t.stand[1], r.n)} with source-observed support`))))))));
  };
  draw();
  return box;
}

function viewGroup(lens, gi) {
  setNav('overview');
  const g = groupsFor(lens)[gi];
  if (!g) return notFound();
  const ids = groupConcepts(g), t = tally(ids);
  const srcs = [...new Set(g.domains.map(d => M.domains[d].source))].filter(x => x >= 0);
  show(crumbs([{ text: 'Overview', href: `#/?lens=${lens}` }, { text: g.label }]), h('h1', {}, g.label),
    h('p', { class: 'lede' }, g.definition), g.theme ? h('p', { class: 'note' }, 'A theme is the model\'s proposed grouping across sources. It is not an accepted part of the ontology.') : null,
    h('p', { class: 'muted' }, `${N(g.domains.length)} domains · ${N(ids.length)} concepts · ${srcs.map(src).join(', ') || 'no source'}`), h('div', { class: 'bar-row' }, bar(t), key()), h('p', { class: 'muted' }, standLine(t)),
    h('h2', {}, 'Domains'), domainTable(g.domains));
}

function conceptList(ids, { pageSize = 60, group = 'form', context } = {}) {
  // Filters and depth are kept per page so returning from the graph lands where the reader left.
  const memory = `filters:${location.hash}`;
  const st = { form: '', stand: '', text: '', group, shown: pageSize, ...JSON.parse(sessionStorage.getItem(memory) ?? 'null') };
  const box = h('div', {}), listBox = h('div', {});
  const filtered = () => ids.filter(i => { const c = concept(i); return (!st.form || FORM_ID(c[2]) === st.form) && (st.stand === '' || String(c[3]) === st.stand) && (!st.text || S.index[i].includes(st.text)); });
  const draw = () => {
    sessionStorage.setItem(memory, JSON.stringify(st));
    const list = filtered();
    const buckets = new Map();
    if (st.group === 'flat') buckets.set('', list); else for (const i of list) { const c = concept(i), k = st.group === 'form' ? (FORM[FORM_ID(c[2])] ?? 'Unclassified') : M.schemes[c[5]].label; (buckets.get(k) ?? buckets.set(k, []).get(k)).push(i); }
    let budget = st.shown;
    const parts = [h('p', { class: 'muted' }, `${N(list.length)} of ${N(ids.length)} concepts match.`)];
    for (const [k, items] of [...buckets].sort((x, y) => y[1].length - x[1].length)) {
      if (budget <= 0) break;
      const take = items.slice(0, budget); budget -= take.length;
      const sc = st.group === 'component' ? M.schemes[concept(items[0])[5]] : null;
      parts.push(k ? h('h3', {}, `${k} (${N(items.length)})`) : null, sc?.definition ? h('p', { class: 'src' }, sc.definition) : null,
        h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, take.map(i => conceptRow(i, st.group))))));
    }
    if (list.length > st.shown) parts.push(h('button', { class: 'more', type: 'button', onclick: () => { st.shown += pageSize; draw(); } }, `Show ${Math.min(pageSize, list.length - st.shown)} more`));
    listBox.replaceChildren(...parts);
  };
  const sel = (label, options, key) => h('label', {}, label, h('select', { onchange: e => { st[key] = e.target.value; st.shown = pageSize; draw(); } }, options.map(([v, t]) => h('option', { value: v, selected: v === st[key] }, t))));
  const text = h('input', { type: 'search', placeholder: 'Filter these concepts', 'aria-label': 'Filter these concepts', value: st.text, oninput: e => { st.text = e.target.value.toLowerCase(); st.shown = pageSize; draw(); } });
  text.style.padding = '0.35rem 0.5rem'; text.style.border = '1px solid #6b7280'; text.style.borderRadius = '4px';
  box.append(h('div', { class: 'filters' }, text,
    sel('Kind', [['', 'All kinds'], ...Object.entries(FORM).map(([k, v]) => [k, v])], 'form'), sel('Evidence', [['', 'Any evidence'], ...STAND.map((l, i) => [String(i), l])], 'stand'),
    sel('Group by', [['form', 'Kind'], ['component', 'Component'], ['flat', 'None']], 'group')), listBox);
  draw();
  return box;
}
const FORM_ID = i => ['responsibility', 'policy', 'practice', 'strategy', 'type', 'theme'][i];
function conceptRow(i, group) {
  const c = concept(i);
  return h('tr', {}, h('td', {}, a(cHref(i), c[1]), group === 'component' ? null : h('div', { class: 'src' }, M.schemes[c[5]].label)),
    h('td', {}, group === 'form' ? null : tag(FORM[FORM_ID(c[2])] ?? 'Unclassified')), h('td', {}, tag(STAND[c[3]] ?? 'Unknown evidence')), h('td', { class: 'num' }, `${N(c[7])} passages`));
}

function domainLinks(di) {
  const d = M.domains[di], set = d.set, cd = S.conceptDomain[set], agg = new Map(), inner = { n: 0 };
  const bump = (other, dir, pred) => { const k = `${dir}|${other}`; const e = agg.get(k) ?? { other, dir, n: 0, preds: new Map() }; e.n += 1; e.preds.set(pred, (e.preds.get(pred) ?? 0) + 1); agg.set(k, e); };
  for (const m of d.members) {
    for (const ri of S.out[m]) { const r = M.relations[ri], o = cd[r[1]]; if (o === di) inner.n += 1; else if (o >= 0) bump(o, 'out', r[2]); }
    for (const ri of S.inn[m]) { const r = M.relations[ri], o = cd[r[0]]; if (o >= 0 && o !== di) bump(o, 'in', r[2]); }
  }
  const rows = [...agg.values()].sort((x, y) => y.n - x.n).map(e => { const top = [...e.preds].sort((x, y) => y[1] - x[1])[0]; return { ...e, top: top[0], other_d: M.domains[e.other] }; });
  return { rows, inner: inner.n };
}

function viewDomain(di) {
  setNav('overview');
  const d = M.domains[di];
  if (!d) return notFound();
  const t = S.stats.get(di), links = domainLinks(di);
  const paths = M.paths.filter(p => p.steps.includes(di));
  const themeOf = M.themes[d.set].findIndex(th => th.domains.includes(di));
  const lens = d.set === 'original' ? 'original' : 'themes';
  const crumbList = [{ text: 'Overview', href: '#/' }, themeOf >= 0 ? { text: M.themes[d.set][themeOf].label, href: `#/group/${lens}/${themeOf}` } : { text: src(d.source) }, { text: d.label }];
  const thin = d.members.length === 1;
  show(crumbs(crumbList), h('h1', {}, d.label),
    h('div', { class: 'tags' }, tag(`Source: ${src(d.source)}`), d.kind ? tag(`Model-labelled: ${KIND[d.kind] ?? words(d.kind)}`) : null, tag(d.set === 'original' ? 'First-pass domain' : 'Proposed domain'), thin ? tag('Single concept') : null),
    h('p', { class: 'lede' }, d.definition), h('p', { class: 'src' }, 'The definition and the kind label were written by the model. The kind label is not derived from where the evidence sits.'),
    h('div', { class: 'bar-row' }, h('strong', {}, `${N(d.members.length)} concepts`), bar(t), key()), h('p', { class: 'muted' }, standLine(t)),
    graphEntry('domain', di),
    d.path_shape ? h('p', { class: 'note' }, `Path-shape heuristic (where evidence files sit, not what the domain means): ${words(d.path_shape.reading)}${d.path_shape.thin ? '. Thin on direct source evidence' : ''}.`) : null,
    h('h2', {}, 'Responsibilities and components'), h('p', { class: 'muted' }, 'Concepts in this domain. Group them by kind of statement or by the component group they were mapped under.'), conceptList(d.members),
    connections({ title: 'Connected domains', focus: { label: d.label }, leftTitle: 'Point at this domain', rightTitle: 'This domain points at',
      rows: links.rows.map(r => ({ dir: r.dir, label: r.other_d.label, href: dHref(r.other), edge: `${N(r.n)}× ${r.top}`, title: `${r.n} concept relations, most common predicate "${r.top}"`, n: r.n, top: r.top })),
      columns: [{ name: 'Direction', cell: r => (r.dir === 'out' ? 'This points at' : 'Points at this') }, { name: 'Domain', cell: r => a(r.href, r.label) }, { name: 'Relations', num: true, cell: r => N(r.n) }, { name: 'Most common predicate', cell: r => r.top }] }),
    h('p', { class: 'src' }, `${N(links.inner)} relations stay inside this domain. Edges are aggregated from concept-to-concept relations that cite source; the predicate is the model's exact wording.`),
    paths.length ? [h('h2', {}, 'Cross-source paths through this domain'), paths.map(pathCard)] : null);
}

function pathCard(p) {
  return h('div', { class: 'panel' }, h('strong', {}, p.label), h('ol', {}, p.steps.map(i => h('li', {}, a(dHref(i), M.domains[i].label), ` (${src(M.domains[i].source)})`))), h('p', { class: 'muted' }, p.reason), h('p', { class: 'src' }, 'A proposed path. Whether data really flows this way is not verified here.'));
}

function relationRows(ci) {
  const rows = [];
  for (const ri of S.out[ci]) { const r = M.relations[ri]; rows.push({ ri, dir: 'out', other: r[1], pred: r[2], def: r[3], ev: r[4] }); }
  for (const ri of S.inn[ci]) { const r = M.relations[ri]; rows.push({ ri, dir: 'in', other: r[0], pred: r[2], def: r[3], ev: r[4] }); }
  return rows;
}

async function viewConcept(ci) {
  setNav('overview');
  const c = concept(ci);
  if (!c) return notFound();
  const dom = S.conceptDomain.reconciled[ci], d = M.domains[dom], sc = M.schemes[c[5]];
  const form = FORM_ID(c[2]);
  const flags = [];
  if (c[3] === 4) flags.push('No evidence was located for this concept.'); else if (c[3] === 2 || c[3] === 3) flags.push('Supported by documents or comments only; no source-observed code or configuration is cited.');
  if (c[8]) flags.push(`${c[8]} blocker${c[8] > 1 ? 's' : ''} from implemented checks.`);
  if (c[9]) flags.push(`${c[9]} cited passage${c[9] > 1 ? 's are' : ' is'} stale against the current source.`);
  if (dom < 0) flags.push('The model did not place this concept in any domain.');
  const rels = relationRows(ci);
  const sections = [crumbs([{ text: 'Overview', href: '#/' }, dom >= 0 ? { text: d.label, href: dHref(dom) } : { text: 'Not placed' }, { text: sc.label }, { text: c[1] }]),
    h('h1', {}, c[1]), h('div', { class: 'tags' }, tag(`Source: ${src(c[4])}`), tag(FORM[form] ?? 'Unclassified kind'), tag(STAND[c[3]] ?? 'Unknown evidence')),
    flags.length ? h('div', { class: 'status' }, h('strong', {}, 'Needs a look: '), flags.join(' ')) : h('div', { class: 'status status--plain' }, 'No issue raised by the recorded checks. That is not approval.'),
    graphEntry('concept', ci),
    h('h2', {}, 'What kind of statement this is'),
    h('dl', { class: 'facts-grid' }, setting('Inferred kind', FORM[form] ?? 'Unclassified', `${FORM_HELP[form] ?? ''} Assigned by the mapper from the sources; not reviewed.`),
      setting('Evidence basis', STAND[c[3]] ?? 'Unknown', `${N(c[7])} cited passages, ${N(c[6])} assertions. Standing is recorded on each cited source.`),
      setting('Authority record of a human choice', 'None captured', 'This data holds no approval or sign-off for the concept. It does not show that no person made the choice: a source passage below may quote one, and every concept definition here is unreviewed. A rule or procedure in a document is not by itself a recorded choice.'),
      setting('Component', sc.label, sc.definition), dom >= 0 ? setting('Proposed domain', a(dHref(dom), d.label), d.definition) : setting('Proposed domain', 'Not placed', 'See Triage.'))];
  const detail = h('div', {}, h('p', { class: 'loading' }, 'Loading definition and source chain'));
  sections.push(detail,
    connectionsConcept(ci, c, rels));
  show(...sections);
  try {
    const k = await (await fetch(`/api/concept?accession=${encodeURIComponent(c[0])}`)).json();
    if (!k) return detail.replaceChildren(h('p', { class: 'empty' }, 'Detail for this concept is not available.'));
    detail.replaceChildren(...conceptDetail(k));
  } catch { detail.replaceChildren(h('p', { class: 'empty' }, 'Detail could not be loaded.')); }
}

const DIRECTION = { forward: 'same direction as the original', inverse: 'reads in the opposite direction from the original', symmetric: 'works the same both ways' };
function proposalFor(pred) {
  const P = M.predicate_proposals, m = P?.by_text[pred];
  if (!m) return null;
  const c = P.canonical.find(x => x.id === m[0]);
  return { id: m[0], direction: m[1], reason: m[2], c };
}
function proposalSetting(pred) {
  if (!M.predicate_proposals) return setting('Proposed standard predicate', 'Not loaded', 'No predicate mapping was supplied to this viewer.');
  const p = proposalFor(pred);
  if (!p || p.id === 'unmapped') return setting('Proposed standard predicate', 'None proposed', 'The mapping pass left this wording unmapped. The original wording above is all there is.');
  return setting('Proposed standard predicate', `${p.id} (${DIRECTION[p.direction] ?? p.direction})`, `Unreviewed model proposal; no mapping is accepted. ${p.reason ?? ''} It groups ${N(p.c?.original_types)} wordings used ${N(p.c?.uses)} times, and some merges are coarse, so the original wording stays primary and no edge is merged by it.`);
}

// One relationship: which concept is the subject, the predicate exactly as the mapper wrote it, and the passages cited for it.
async function viewRelation(ri) {
  setNav('overview');
  const r = M.relations[ri];
  if (!r) return notFound();
  const [from, to, pred] = r, uses = M.relations.reduce((n, x) => n + (x[2] === pred ? 1 : 0), 0);
  const detail = h('div', {}, h('p', { class: 'loading' }, 'Loading cited passages'));
  show(crumbs([{ text: 'Overview', href: '#/' }, { text: concept(from)[1], href: cHref(from) }, { text: `Relationship: ${pred}` }]), h('h1', {}, 'Relationship between two concepts'),
    h('div', { class: 'stmt-big' }, a(cHref(from), concept(from)[1]), tag(pred, 'tag--solid'), h('span', { class: 'arrow' }, '→'), a(cHref(to), concept(to)[1])),
    h('dl', { class: 'facts-grid' }, setting('Reads as', `"${concept(from)[1]}" ${pred} "${concept(to)[1]}"`, 'Direction runs from the first concept (subject) to the second (object).'),
      setting('Predicate wording', pred, `The mapper's own text, kept as written. ${uses === 1 ? 'Only this relation uses' : `${N(uses)} relations use`} this exact wording. ${M.predicate_proposals ? 'A proposed standard predicate is shown below it, unreviewed.' : 'No canonical predicate mapping exists yet.'} Similar wordings are never merged.`),
      proposalSetting(pred), setting('Why the mapper says so', r[3] || 'No explanation recorded.', 'A model-written explanation, not reviewed.')), detail);
  try {
    const rec = await (await fetch(`/api/explore/relation?i=${ri}`)).json();
    const endpoint = async (ci, role) => {
      const k = await (await fetch(`/api/concept?accession=${encodeURIComponent(concept(ci)[0])}`)).json();
      return [h('h3', {}, `${role}: ${concept(ci)[1]}`), h('p', { class: 'src' }, `Passages cited for the concept as a whole (${N(k?.evidence.length ?? 0)}). They are not necessarily the ones that support this relationship.`),
        k?.evidence.length ? moreList(k.evidence.map(e => h('li', {}, tag(STAND_NAME(e.standing)), occurrence(e))), 3) : h('p', { class: 'empty' }, 'No passage located. Unknown, not absent.')];
    };
    detail.replaceChildren(h('h2', {}, `Cited for this relationship (${N(rec.evidence.length)})`),
      rec.evidence.length ? moreList(rec.evidence.map(e => h('li', {}, h('div', { class: 'stmt' }, tag(words(e.role ?? 'support')), tag(STAND_NAME(e.standing))), occurrence(e))), 6) : h('p', { class: 'empty' }, 'No passage is cited for this relationship.'),
      h('h2', {}, 'The two ends'), ...await endpoint(from, 'Subject'), ...await endpoint(to, 'Object'),
      h('p', { class: 'note' }, 'Source-graph entities appear on a passage only where the record supplies them. None is inferred from names or namespaces.'));
  } catch { detail.replaceChildren(h('p', { class: 'empty' }, 'Cited passages could not be loaded.')); }
}

function list(title, items) { return items?.length ? [h('dt', {}, title), h('dd', {}, h('ul', {}, items.map(x => h('li', {}, x))))] : []; }
function conceptDetail(k) {
  const instances = k.assertions.filter(x => x.membership && x.polarity !== 'deny'), denials = k.assertions.filter(x => x.polarity === 'deny'), other = k.assertions.filter(x => !x.membership && x.polarity !== 'deny');
  const stmt = x => h('li', {}, h('div', { class: 'stmt' }, tag(x.predicate, 'tag--solid'), h('span', { class: 'arrow' }, x.polarity === 'deny' ? 'is denied for' : x.membership ? 'has instance' : 'about'), h('span', {}, x.referent ?? x.denotes ?? 'unnamed subject'), x.referent_kind ? tag(x.referent_kind) : null),
    x.basis ? h('p', { class: 'src' }, `Subject basis (display label, not a stored entity kind): ${BASIS[x.basis] ?? words(x.basis)}.`) : null,
    x.denotes && x.denotes !== x.referent ? h('p', { class: 'src' }, `Denotes: ${x.denotes}`) : null, x.occurrence ? occurrence(x.occurrence) : null);
  const chain = (title, note, rows) => rows.length ? [h('h3', {}, `${title} (${N(rows.length)})`), h('p', { class: 'src' }, note), moreList(rows.map(stmt))] : [];
  return [h('h2', {}, 'Definition'), h('p', { class: 'src' }, `Definition version ${k.version_id.slice(-8)}. This is the wording of the concept itself, separate from what sources say about particular subjects.`),
    h('dl', { class: 'facts-grid' }, setting('Definition', k.definition), setting('Includes', k.inclusion), setting('Excludes', k.exclusion), list('Invariants', k.invariants), list('A subject counts as an instance when', k.instance_conditions),
      k.aliases?.length ? setting('Also called', k.aliases.join(', ')) : [], setting('Defining predicates', (k.constitutive_predicates ?? []).join(', ') || 'None recorded', 'Predicates a subject must carry to be an instance of this kind.')),
    h('h2', {}, 'Source chain'), h('p', { class: 'muted' }, 'Concept, what the source says about a subject, then the quoted passage with file and lines. Predicates are the mapper\'s exact words; direction runs from the concept to the subject.'),
    ...chain('Subjects the sources treat as instances', 'Instance properties live here, not in the definition.', instances), ...chain('Other statements', 'The concept described in relation to a subject, without claiming membership.', other),
    ...chain('Denials', 'Passages that say a subject is not an instance.', denials),
    h('h3', {}, `Cited passages (${N(k.evidence.length)})`), k.evidence.length ? moreList(k.evidence.map(e => h('li', {}, tag(STAND_NAME(e.standing)), occurrence(e)))) : h('p', { class: 'empty' }, 'No passage located. Unknown, not absent.'),
    h('p', { class: 'note' }, 'Implementation link: not established by this view. It shows quoted source only; no code entity is linked and nothing was verified at runtime.')];
}
const STAND_NAME = s => ({ source_observed: 'Source-observed', documentary_claim: 'Document', comment_claim: 'Code comment', third_party_reference: 'Third-party reference' }[s] ?? words(s));
// The normal graph is entered from here. The return target keeps the reader's place in this explorer.
const graphBase = () => `/graph?view=${encodeURIComponent(M.graph.view)}`;
const here = () => encodeURIComponent(`/explore${location.hash}`);
const graphHref = (nodeId, kind, i) => `${graphBase()}&pair=${encodeURIComponent(M.graph.pair)}${kind ? `&ctx=${kind}:${i}` : ''}&ret=${here()}${nodeId ? `#${encodeURIComponent(nodeId)}` : ''}`;

// A graph document is named only when the passage's file content and commit match the projection exactly. Anything else says why it is not located.
function graphLine(o) {
  const g = o.graph, ids = o.graph_node_ids ?? [];
  // Nodes whose own locator lies inside the quoted lines. They locate the passage; they are not what the passage is about.
  const located = g?.located?.length ? h('details', {}, h('summary', { class: 'src' }, `${g.located.length} graph node${g.located.length === 1 ? '' : 's'} anchored in the quoted lines (a locator association, not an entity)`),
    h('ul', {}, g.located.map(r => h('li', { class: 'src' }, a(graphHref(r.node_id), r.label || r.node_id), ` · ${words(r.kind)}`)))) : null;
  if (g?.status === 'bound') return h('div', {}, h('p', { class: 'src' }, 'Graph document, exact content match (blob_oid), file level: ', a(graphHref(g.node_id), g.node_id.replace(/^doc:/u, '')), ' — opens the normal graph.'), located);
  if (g) return h('div', {}, h('p', { class: 'src' }, `Not located in the graph as a file: ${g.reason ?? words(g.status)}`), located);
  return h('p', { class: 'src' }, ids.length ? `Source-graph entity (as supplied, pinned at commit ${String(o.commit_sha ?? 'unknown').slice(0, 8)}): ${ids.join(', ')}` : 'Source-graph entity: none supplied for this passage.');
}

// Entry into the normal graph for a domain or concept: how much of its cited evidence the graph holds, and why the rest is not located.
function graphEntry(kind, i) {
  if (!M.graph) return M.graph_unavailable ? h('div', { class: 'panel' }, h('strong', {}, 'In the normal graph'), h('p', { class: 'status' }, `The graph integration is unavailable for this estate: ${M.graph_unavailable}`), h('p', { class: 'muted' }, 'The ontology below is unaffected. Nothing is assumed about how its evidence sits in a graph.')) : null;
  const box = h('div', { class: 'panel' }, h('strong', {}, 'In the normal graph'), h('p', { class: 'muted' }, 'Checking which cited files the graph holds'));
  fetch(`/api/ontology/anchors?view=${encodeURIComponent(M.graph.view)}&pair=${encodeURIComponent(M.graph.pair)}&kind=${kind}&i=${i}&limit=0`).then(async r => ({ ok: r.ok, body: await r.json() })).then(({ ok, body }) => {
    if (!ok) return box.replaceChildren(h('strong', {}, 'In the normal graph'), h('p', { class: 'status' }, `Bindings refused: ${body.message}`));
    const c = body.coverage, unresolved = Object.entries(c.unresolved);
    box.replaceChildren(h('strong', {}, 'In the normal graph'),
      h('p', {}, `${N(c.passages_bound)} of ${N(c.passages)} cited passages sit in ${N(body.total_anchors)} file${body.total_anchors === 1 ? '' : 's'} that the graph holds (exact content match on blob_oid at the same path, file level). ${N(c.concepts_with_anchor)} of ${N(c.concepts)} concept${c.concepts === 1 ? '' : 's'} can be located.`),
      ...(unresolved.length ? [h('ul', {}, unresolved.map(([reason, n]) => h('li', {}, `${N(n)} not located: ${body.reasons[reason] ?? words(reason)}`)))] : []),
      ...(body.located_nodes?.total ? [h('p', { class: 'src' }, `${N(body.located_nodes.passages_with_refs)} passages also have ${N(body.located_nodes.total)} graph node${body.located_nodes.total === 1 ? '' : 's'} anchored in the quoted lines.`)] : []),
      body.total_anchors || body.located_nodes?.total ? h('p', {}, h('a', { class: 'more', href: graphHref(null, kind, i) }, 'Open in graph')) : h('p', { class: 'muted' }, 'Nothing to open: no cited file is in this graph. That is unknown, not a finding of no impact.'),
      h('p', { class: 'src' }, `Files are found by exact content to locate evidence. They do not define the ${kind}. Projection ${body.projection_id.slice(-8)}.`));
  }).catch(() => box.replaceChildren(h('strong', {}, 'In the normal graph'), h('p', { class: 'muted' }, 'The graph could not be reached.')));
  return box;
}

function occurrence(o) {
  return h('div', {}, h('p', { class: 'src' }, `${o.repository} · ${o.path}${o.start_line ? `:${o.start_line}${o.end_line && o.end_line !== o.start_line ? `-${o.end_line}` : ''}` : ''} · commit ${String(o.commit_sha ?? '').slice(0, 8)} · ${STAND_NAME(o.standing)}`),
    o.quote ? h('div', { class: 'quote' }, o.quote) : null,
    graphLine(o));
}
function moreList(items, size = 8) {
  const ul = h('ul', { class: 'chain' }); let shown = size;
  const draw = () => { ul.replaceChildren(...items.slice(0, shown), ...(items.length > shown ? [h('li', {}, h('button', { class: 'more', type: 'button', onclick: () => { shown += 20; draw(); } }, `Show more (${N(items.length - shown)} left)`))] : [])); };
  draw();
  return ul;
}

function connectionsConcept(ci, c, rels) {
  const label = i => concept(i)[1];
  return connections({ title: `Related concepts (${N(rels.length)})`, focus: { label: c[1] }, leftTitle: 'Point at this concept', rightTitle: 'This concept points at',
    rows: rels.map(r => ({ dir: r.dir, label: label(r.other), href: cHref(r.other), edge: r.pred, title: r.def, ...r })),
    columns: [{ name: 'Direction', cell: r => (r.dir === 'out' ? 'This concept →' : '→ This concept') }, { name: 'Predicate', cell: r => a(`#/relation/${r.ri}`, r.pred) }, ...(M.predicate_proposals ? [{ name: 'Proposed standard', cell: r => { const p = proposalFor(r.pred); return p && p.id !== 'unmapped' ? h('span', { class: 'muted' }, p.id) : '\u2014'; } }] : []), { name: 'Concept', cell: r => a(cHref(r.other), label(r.other)) },
      { name: 'Why the model says so', cell: r => r.def }, { name: 'Source', num: true, cell: r => a(`#/relation/${r.ri}`, `${N(r.ev)} passage${r.ev === 1 ? '' : 's'}`) }] });
}

// ---- search, triage, traces -----------------------------------------------------------------------------------------------------
function viewSearch(q) {
  setNav('');
  const text = (q.get('q') ?? '').toLowerCase().trim();
  const words_ = text.split(/\s+/).filter(Boolean);
  const hits = words_.length ? M.concepts.map((_, i) => i).filter(i => words_.every(w => S.index[i].includes(w))) : [];
  const domainHits = words_.length ? M.domains.map((d, i) => i).filter(i => words_.every(w => `${M.domains[i].label} ${M.domains[i].definition}`.toLowerCase().includes(w))) : [];
  show(h('h1', {}, `Search: ${q.get('q') ?? ''}`), h('p', { class: 'muted' }, 'Matches concept, domain and component names, and domain definitions. Quoted source text is not searched here.'),
    domainHits.length ? [h('h2', {}, `Domains (${N(domainHits.length)})`), domainTable(domainHits.slice(0, 40))] : null, h('h2', {}, `Concepts (${N(hits.length)})`), hits.length ? conceptList(hits, { group: 'flat' }) : h('p', { class: 'empty' }, 'No match.'));
}

async function viewTriage(q) {
  setNav('triage');
  const facet = q.get('facet');
  const C = M.concepts, ids = f => C.map((_, i) => i).filter(i => f(C[i]));
  const singles = M.domains.map((d, i) => i).filter(i => M.domains[i].set === 'reconciled' && M.domains[i].members.length === 1);
  const facets = [
    { id: 'docs', title: 'Supported by documents or comments only', note: 'No source-observed code or configuration is cited. Often right for policy and brand material; worth a look for claims about behaviour.', ids: ids(c => c[3] === 2 || c[3] === 3), kind: 'concepts' },
    { id: 'noev', title: 'No located evidence', note: 'The cited passage could not be found in the source.', ids: ids(c => c[3] === 4), kind: 'concepts' },
    { id: 'unplaced', title: 'Not placed in any domain', note: 'The model did not place these concepts. Reasons are shown where recorded.', ids: M.unplaced.map(r => r[0]), kind: 'concepts', reason: new Map(M.unplaced.map(r => [r[0], DISP[r[1]] ?? words(r[1])])) },
    { id: 'stale', title: 'Cited source has changed', note: 'At least one cited passage no longer matches the current source.', ids: ids(c => c[9] > 0), kind: 'concepts' },
    { id: 'blocked', title: 'Blocked by an implemented check', note: 'A recorded check found a contradiction or overlap.', ids: ids(c => c[8] > 0), kind: 'concepts' },
    { id: 'single', title: 'Domains with a single concept', note: 'Possible fragmentation. A small domain is not wrong by itself.', ids: singles, kind: 'domains' },
    { id: 'dups', title: 'Possible duplicates', note: 'The model compared near-identical concepts and proposed which are the same, refinements or distinct. Largest groups only.', kind: 'clusters' },
    { id: 'gaps', title: 'Source gaps and conflicts', note: 'Places where the mapper recorded missing support or vocabularies that disagree.', kind: 'gaps' },
    { id: 'checks', title: 'Check findings', note: 'Output of implemented checks that need a person to read them.', kind: 'checks' },
  ];
  if (!facet) {
    return show(h('h1', {}, 'Triage'), h('p', { class: 'lede' }, 'Pick the kind of doubt you care about instead of reviewing every concept. Each list is a filter on recorded facts, not a confidence score, and nothing here needs to be accepted for the rest of the explorer to work.'),
      h('div', { class: 'cards' }, facets.map(f => { const n = f.ids ? f.ids.length : f.id === 'dups' ? M.reconcile?.clusters.length : f.id === 'checks' ? M.findings.length : null; return h('a', { class: 'cardlink', href: `#/triage?facet=${f.id}` }, h('div', { class: 'card' }, h('h3', {}, f.title), h('p', { class: 'def' }, f.note), n != null ? h('p', { class: 'facts' }, `${N(n)}${f.id === 'dups' ? ' largest shown' : ''}`) : h('p', { class: 'facts' }, 'Opens a list'))); })));
  }
  const f = facets.find(x => x.id === facet);
  if (!f) return notFound();
  const head = [crumbs([{ text: 'Triage', href: '#/triage' }, { text: f.title }]), h('h1', {}, f.title), h('p', { class: 'lede' }, f.note)];
  if (f.kind === 'concepts') {
    const rows = f.ids.map(i => h('tr', {}, h('td', {}, a(cHref(i), C[i][1]), h('div', { class: 'src' }, `${src(C[i][4])}${f.reason ? ` · ${f.reason.get(i)}` : ''}`)), h('td', {}, tag(FORM[FORM_ID(C[i][2])] ?? 'Unclassified')), h('td', {}, tag(STAND[C[i][3]]))));
    return show(...head, conceptList(f.ids, { group: 'flat' }), f.reason ? h('p', { class: 'src' }, 'Reasons are recorded for some concepts only; others are listed without one.') : null);
  }
  if (f.kind === 'domains') return show(...head, domainTable(f.ids));
  if (f.kind === 'clusters') return show(...head, h('p', { class: 'src' }, `${N(M.reconcile.cluster_totals.canonical_proposals)} proposals in all; none accepted.`), M.reconcile.clusters.map(cl => h('div', { class: 'panel' }, h('strong', {}, `Around "${cl.head_label}"`), h('span', { class: 'muted' }, ` · ${src2(cl.source_id)} · ${cl.cluster_size} near-duplicates`),
    h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, cl.proposals.map(p => h('tr', {}, h('td', {}, tag(({ same_concept: 'Same concept', refinement: 'Refinement', distinct: 'Distinct', unplaced: 'Not placed', alias: 'Alias' })[p.relation] ?? p.relation)), h('td', {}, p.label ?? 'No label'), h('td', { class: 'num' }, `${p.members} concepts`), h('td', {}, p.reason)))))))));
  if (f.kind === 'checks') return show(...head, h('dl', { class: 'facts-grid' }, setting('Diagnostic rows', N(M.findings.length), `${Object.entries(M.findings.reduce((o, x) => ({ ...o, [x.kind]: (o[x.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${N(n)} ${words(k)}`).join(', ')}. Informational rows, not a review queue.`),
    setting('Hard blockers from implemented checks', N(M.counts.acceptance_blockers_from_implemented_checks), 'A recorded subject conflict that blocks acceptance.'),
    setting('Blocking citation overlaps', N(M.counts.citation_overlaps), 'The overlap check found none that block. The member-counterexample rows are a different measure.')),
    h('p', { class: 'src' }, `These are three different counts and are not added. "Needing review" has no definition while review recording is off. Related but separate: ${N(M.counts.rejected)} refusals with reasons, ${N(M.counts.identity_candidates)} identity candidates.`), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, M.findings.map(x => h('tr', {}, h('td', {}, x.concept >= 0 ? a(cHref(x.concept), C[x.concept][1]) : '—'), h('td', {}, words(x.kind)), h('td', {}, x.quote), h('td', {}, x.path)))))));
  const body = h('div', {}, h('p', { class: 'loading' }, 'Loading'));
  show(...head, body);
  const rows = await (await fetch('/api/explore/triage')).json();
  let kind = '', source = '';
  const draw = () => {
    const list = rows.filter(r => (!kind || r.kind === kind) && (source === '' || String(r.source) === source));
    const kinds = [...new Set(rows.map(r => r.kind))];
    body.replaceChildren(h('div', { class: 'filters' }, h('label', {}, 'Kind', h('select', { onchange: e => { kind = e.target.value; draw(); } }, [['', 'All kinds'], ...kinds.map(k => [k, words(k)])].map(([v, t]) => h('option', { value: v, selected: v === kind }, t)))),
      h('label', {}, 'Source', h('select', { onchange: e => { source = e.target.value; draw(); } }, [['', 'All sources'], ...M.sources.map((s, i) => [String(i), s])].map(([v, t]) => h('option', { value: v, selected: v === source }, t))))),
      h('p', { class: 'muted' }, `${N(list.length)} of ${N(rows.length)}`), moreList(list.map(r => h('li', {}, h('div', { class: 'stmt' }, tag(r.type === 'gap' ? 'Source gap' : 'Conflict'), tag(words(r.kind)), h('span', { class: 'src' }, r.source >= 0 ? src(r.source) : '')), h('p', {}, r.description), r.path ? h('p', { class: 'src' }, `${r.path}${r.start_line ? `:${r.start_line}` : ''}${r.refs > 1 ? ` and ${r.refs - 1} more` : ''}`) : null, r.quote ? h('div', { class: 'quote' }, r.quote) : null)), 12));
  };
  draw();
}
const src2 = id => id;

// Message names emitted in one component and consumed in another, read statically from the code graph. Not a runtime claim.
const looksLikeTest = path => /(^|\/)(tests?|e2e|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/u.test(path);
function chainsSection(c) {
  return [h('h2', {}, `Static message flows (${N(c.totals.cross_component)})`), h('p', { class: 'muted' }, `Names a component emits and another consumes, joined in the code graph at one pinned commit (${String(c.source_pin).slice(0, 8)}). Static only: no runtime was observed. Many endpoints are test files; those are marked, using the path shape alone.`),
    moreList(c.rows.slice(0, 60).map(r => h('li', {}, h('div', { class: 'stmt' }, tag(r.name, 'tag--solid'), tag(words(r.kind)), h('span', { class: 'src' }, `${N(r.n)} references`)),
      h('p', { class: 'src' }, `Emitted from ${r.makers.join(', ')}; consumed in ${r.takers.join(', ')}.`),
      h('ul', {}, r.refs.slice(0, 4).map(x => h('li', { class: 'src' }, `${x.repo} \u00b7 ${x.path}:${x.start_line}${x.end_line && x.end_line !== x.start_line ? `-${x.end_line}` : ''}`, looksLikeTest(x.path) ? ' (looks like a test file)' : ''))))), 8)];
}

function viewTraces() {
  setNav('traces');
  const R = M.reconcile;
  show(h('h1', {}, 'Cross-source traces'), h('p', { class: 'lede' }, 'Where one source appears to hand data or assets to another. Each trace is a static read of pinned source. A missing link is shown as unknown: it means none was located, not that none exists.'),
    h('h2', {}, 'Proposed paths'), M.paths.filter(p => p.set === 'reconciled').map(pathCard),
    M.chains ? chainsSection(M.chains) : null,
    h('h2', {}, 'Source-pinned traces'), (R?.traces ?? []).map(t => h('div', { class: 'panel' }, h('h3', {}, t.label), h('p', { class: 'src' }, 'Static source read only; nothing was observed at runtime.'),
      h('h3', {}, 'Pins'), h('ul', {}, t.pins.map(p => h('li', {}, `${p.repo}${p.path ? ` · ${p.path}${p.start_line ? `:${p.start_line}-${p.end_line}` : ''}` : ''}${p.commit_sha ? ` · commit ${p.commit_sha.slice(0, 8)}` : ''}`, ' ', tag(p.ok ? 'Pinned' : 'Not verified'), p.problem ? ` ${p.problem}` : ''))),
      h('h3', {}, 'What was found'), t.findings.map(f => h('div', {}, h('div', { class: 'tags' }, tag(FINDING[f.kind] ?? words(f.kind)), tag(words(f.relation))),
        f.collections?.length ? h('p', {}, `Named: ${f.collections.join(', ')}`) : null, f.writer ? h('p', {}, `${f.writer} writes, ${f.reader} reads. ${f.physical_store ?? ''}`) : null,
        f.missing ? h('p', { class: 'status' }, h('strong', {}, 'Missing: '), f.missing) : null)))));
}

function notFound() { show(h('h1', {}, 'Not found'), h('p', {}, a('#/', 'Back to the overview'))); }

// ---- routing ---------------------------------------------------------------------------------------------------------------------------
async function route() {
  if (!M) return;
  const [path, query = ''] = location.hash.slice(1).split('?'), q = new URLSearchParams(query), seg = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  const resume = sessionStorage.getItem(`scroll:${location.hash}`);
  try {
    if (!seg.length) viewOverview(q);
    else if (seg[0] === 'group') viewGroup(seg[1], Number(seg[2]));
    else if (seg[0] === 'domain') viewDomain(Number(seg[1]));
    else if (seg[0] === 'concept') await viewConcept(Number(seg[1]));
    else if (seg[0] === 'relation') await viewRelation(Number(seg[1]));
    else if (seg[0] === 'search') viewSearch(q);
    else if (seg[0] === 'triage') await viewTriage(q);
    else if (seg[0] === 'traces') viewTraces();
    else notFound();
  } catch (e) { show(h('h1', {}, 'Something went wrong'), h('p', {}, String(e.message))); }
  if (resume) { sessionStorage.removeItem(`scroll:${location.hash}`); setTimeout(() => window.scrollTo(0, Number(resume)), 150); }
}
document.getElementById('search').addEventListener('submit', e => { e.preventDefault(); const v = document.getElementById('q').value.trim(); if (v) location.hash = `#/search?q=${encodeURIComponent(v)}`; });
window.addEventListener('hashchange', route);
// Leaving for the graph remembers the scroll position of this page, so the way back lands in the same place.
document.addEventListener('click', e => { const link = e.target.closest?.('a[href^="/graph"]'); if (link) sessionStorage.setItem(`scroll:${location.hash}`, String(window.scrollY)); });
const res = await fetch('/api/explore');
if (!res.ok) show(h('h1', {}, 'Explorer data unavailable'), h('p', {}, 'This viewer needs an estate-scale generation with the estate and reconciliation views.'));
else { M = await res.json(); derive(); about(); graphNav(); route(); }
function workspaceNav() {
  const w = M.workspace;
  if (!w || (!w.label && !w.peers.length)) return;
  document.querySelector('.top')?.append(h('nav', { class: 'pairs', 'aria-label': 'Estate and generation' }, h('span', { class: 'muted' }, 'Estate'), h('strong', {}, w.label ?? 'this estate'),
    w.peers.map(p => a(`${peerBase(p.url)}/explore`, p.label))));
}
function graphNav() {
  workspaceNav();
  if (M.graph) document.querySelector('.nav')?.append(h('a', { href: `/graph?view=${encodeURIComponent(M.graph.view)}&ret=${encodeURIComponent('/explore')}` }, 'Graph'));
}
function about() {
  const p = M.pins, el = document.getElementById('about');
  el.replaceChildren(h('details', {}, h('summary', {}, 'About this view: versions and pins'),
    h('p', {}, `Explorer data ${M.schema} over ${p.view_schema}${p.model ? `; mapped by ${p.model.requested}, thinking ${p.model.thinking}, scaffold ${p.model.scaffold}. Reasoning effort actually applied is unverified` : ''}. Generation ${p.generation_id.replace('ontology-discovery-generation:', '').slice(0, 12)}. Proposal: nothing accepted.`),
    p.sources.length ? h('p', { class: 'src' }, `Source pins (commit read): ${p.sources.map(x => `${x.id} ${String(x.ref ?? 'unpinned').slice(0, 8)}`).join(' · ')}`) : null,
    M.graph ? h('p', { class: 'src' }, `Graph ${M.graph.view} projection ${M.graph.projection_id.slice(-8)}, content digest ${String(M.graph.content_digest ?? 'unknown').slice(0, 8)}${M.graph.nodes_sha256 ? `, nodes sha256 ${M.graph.nodes_sha256.slice(0, 8)}` : ''}. File matches use blob_oid equality; a blob identifies file bytes, not the meaning of a cited range. ${M.graph.refs ? (M.graph.refs.loaded ? `Line anchors loaded for ${M.graph.refs.passages_with_refs} passages.` : 'Line anchors refused for this projection.') : 'No line anchors loaded.'}`) : null));
}
