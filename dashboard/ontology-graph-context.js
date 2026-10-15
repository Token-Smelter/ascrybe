// Joins the normal graph application to an ontology served by the same host. The ontology is the graph's first view: the host answers
// the application's own overview, node and neighbour queries with `ontology:` nodes, and the existing canvas, layout, folded bundles,
// inspector and trail draw them. This module only switches lenses, adds the inspector sections the graph does not have, and keeps
// the way back to the ontology. Everything it shows from the ontology is a proposal and nothing in it is reviewed.
const words = s => String(s ?? '').replaceAll('_', ' ');
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) { if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
};
const getJson = async url => {
  const response = await fetch(url), body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message || response.statusText), body);
  return body;
};
const peerBase = url => { try { const u = new URL(url); if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) u.hostname = location.hostname; return u.origin; } catch { return String(url).replace(/\/$/u, ''); } };
// A return target must stay inside this application.
const safeReturn = value => (typeof value === 'string' && /^\/explore(#.*)?$/u.test(value) ? value : '/explore');
let pairParam = null;
const pairQuery = () => (pairParam ? `&pair=${encodeURIComponent(pairParam)}` : '');

export async function probe() {
  try {
    const info = await getJson('/api/ontology/binding');
    document.head.append(el('link', { rel: 'stylesheet', href: '/ontology-graph-context.css' }));
    return info;
  } catch { return null; }
}

// Opens on the ontology unless the reader asked for the source or arrived on a direct link to a source node.
export const initialLens = hasArrival => (new URLSearchParams(location.search).get('lens') === 'source' || hasArrival ? 'source' : 'ontology');

export async function attach(app, info, arrivalId) {
  const query = new URLSearchParams(location.search);
  pairParam = query.get('pair');
  const back = safeReturn(query.get('ret'));
  // A second bar under the rail carries the lens, the way back and the estate, so the application's own rail keeps its room.
  const rail = document.createElement('span');
  const bar = el('div', { class: 'ontology-bar' });
  document.querySelector('.command-rail')?.after(bar);
  document.body.classList.add('has-ontology-bar');
  const lensButtons = ['ontology', 'source'].map(lens => el('button', { type: 'button', class: 'lens-button', 'data-lens': lens, 'aria-pressed': String(app.state.lens === lens),
    onclick: async () => { app.state.lens = lens; app.state.trail = []; app.renderTrail(); paint(); await app.loadOverview(); if (lens === 'ontology') await app.selectNode('ontology:root', { push: false, focus: false }); } }, lens === 'ontology' ? 'Ontology' : 'Source detail'));
  const paint = () => lensButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lens === app.state.lens)));
  const w = info.workspace;
  bar.append(el('div', { class: 'lens-switch', role: 'group', 'aria-label': 'Lens' }, lensButtons),
    el('a', { class: 'ontology-link', href: back }, 'Explorer'),
    w && (w.label || w.peers.length) ? el('span', { class: 'ontology-pairs' }, el('strong', {}, w.label ?? 'this estate'), w.peers.map(p => el('a', { href: `${peerBase(p.url)}/explore` }, p.label))) : null);
  installInspector(app, info);

  const ctx = (query.get('ctx') ?? '').match(/^(domain|concept):(\d+)$/u);
  if (arrivalId && app.state.lens === 'source') {
    // A direct link to a source node keeps the way back to the ontology.
    const bar = el('p', { class: 'source-breadcrumb' }, 'Source detail. ', el('button', { type: 'button', onclick: () => { location.href = `/graph?view=${encodeURIComponent(app.state.view)}${pairQuery()}`; } }, 'Back to the ontology map'));
    document.querySelector('.graph-stage')?.append(bar);
    await app.selectNode(arrivalId);
  } else if (ctx) await app.selectNode(`ontology:${ctx[1]}:${ctx[2]}`);
  else if (app.state.lens === 'ontology') await app.selectNode('ontology:root', { push: false, focus: false });
}

function installInspector(app, info) {
  const section = el('section', { class: 'relation-section ontology-related', hidden: true });
  const reach = el('section', { class: 'relation-section ontology-related', hidden: true });
  document.querySelector('#bundle-section')?.after(section, reach);
  const heading = (title, count) => el('div', { class: 'section-heading' }, el('h2', {}, title), count == null ? null : el('span', {}, `${count}`));
  const note = text => el('p', { class: 'ontology-note' }, text);

  async function relatedConcepts(node, view) {
    section.replaceChildren(heading('Related ontology concepts'), note('Looking up concepts that cite this file'));
    try {
      const found = await getJson(`/api/ontology/by-node?view=${encodeURIComponent(view)}${pairQuery()}&id=${encodeURIComponent(node.id)}`);
      section.replaceChildren(heading('Related ontology concepts', found.total),
        note('Proposals that cite this exact file content. Unreviewed; a citation locates evidence, it does not define the concept.'),
        found.total ? el('ul', { class: 'ontology-list' }, found.concepts.map(c => el('li', {}, el('button', { type: 'button', class: 'link-button', onclick: () => app.selectNode(`ontology:concept:${c.i}`) }, c.label), el('small', {}, `${words(c.form)} \u00b7 ${words(c.standing)}`)))) : note('No ontology concept cites this file.'),
        found.total > found.concepts.length ? note(`${found.total - found.concepts.length} more are not listed here.`) : null);
    } catch (error) { section.replaceChildren(heading('Related ontology concepts'), el('p', { class: 'ontology-refusal', role: 'alert' }, error.message)); }
  }

  const passage = o => el('li', {}, el('p', { class: 'ontology-note' }, `${o.repository} \u00b7 ${o.path}${o.start_line ? `:${o.start_line}${o.end_line && o.end_line !== o.start_line ? `-${o.end_line}` : ''}` : ''} \u00b7 ${words(o.standing)}`),
    o.quote ? el('blockquote', { class: 'ontology-quote' }, o.quote) : null,
    o.graph?.status === 'bound' ? el('button', { type: 'button', class: 'link-button', onclick: () => app.selectNode(o.graph.node_id) }, 'Open this file in the graph (exact content match)') : o.graph ? note(`Not located in the graph as a file: ${o.graph.reason ?? words(o.graph.status)}`) : null,
    ...(o.graph?.located?.length ? [el('details', {}, el('summary', {}, `${o.graph.located.length} graph nodes anchored in the quoted lines`), el('ul', { class: 'ontology-list' }, o.graph.located.map(r => el('li', {}, el('button', { type: 'button', class: 'link-button', onclick: () => app.selectNode(r.node_id) }, r.label || r.node_id), el('small', {}, words(r.kind))))))] : []));

  // A relationship: the exact predicate, both ends, and the passages cited for it. Opened from the concept it hangs on.
  async function relationship(box, edge, view) {
    box.replaceChildren(note('Loading the cited passages'));
    try {
      const rec = await getJson(`/api/explore/relation?i=${edge.properties.relation_index}&view=${encodeURIComponent(view)}${pairQuery()}`);
      box.replaceChildren(note(`Predicate exactly as the mapper wrote it: "${rec.type}". ${edge.properties.definition || ''}`),
        el('h3', {}, `Cited for this relationship (${rec.evidence.length})`), el('ul', { class: 'ontology-passages' }, rec.evidence.map(passage)),
        el('p', { class: 'ontology-note' }, el('a', { href: `/explore#/relation/${edge.properties.relation_index}` }, 'Both endpoints, proposed standard predicate and all cited passages in the explorer')));
    } catch (error) { box.replaceChildren(el('p', { class: 'ontology-refusal', role: 'alert' }, error.message)); }
  }

  async function ontologyNode(node, view) {
    const [, type, a] = node.id.split(':');
    const kids = [heading('About this ontology node'), note('A proposal from the mapper, not reviewed. It is not part of the observed graph. Source nodes are reached from its evidence and from the coverage node.')];
    if (type === 'concept' || type === 'domain') kids.push(el('p', {}, el('a', { href: `/explore#/${type}/${a}` }, 'Open in the ontology explorer')));
    if (type === 'concept') {
      const list = el('ul', { class: 'ontology-list' });
      kids.push(el('h3', {}, 'Typed relationships'), list);
      for (const direction of ['out', 'in']) {
        try {
          const found = await getJson(`/api/neighbors?id=${encodeURIComponent(node.id)}&relation=${encodeURIComponent('related (typed)')}&direction=${direction}&limit=25&view=${encodeURIComponent(view)}${pairQuery()}`);
          found.data.edges.forEach((edge, n) => {
            const other = found.data.adjacent_nodes[n], box = el('div', { class: 'ontology-relation-box' });
            list.append(el('li', {}, el('strong', {}, direction === 'out' ? `\u2192 ${edge.relation}` : `${edge.relation} \u2190`), ' ', el('button', { type: 'button', class: 'link-button', onclick: () => app.selectNode(other.id) }, other.label),
              el('button', { type: 'button', class: 'link-button', onclick: () => relationship(box, edge, view) }, `Passages (${edge.properties.cited_passages})`), box));
          });
        } catch { /* a concept with no such relations has no group */ }
      }
      if (!list.children.length) list.replaceWith(note('No typed relationships recorded for this concept.'));
    }
    section.replaceChildren(...kids);
  }

  const DISPOSITION = { evidence_anchored: 'Evidence-anchored', anchored_entity: 'Anchored entity', owned_detail: 'Owned detail', participates_with_grounded: 'Participates with anchored', cited_document_locator: 'Cited document (locator only)', locator_root: 'Locator root', unplaced: 'Unplaced' };
  async function reachOf(node, view) {
    reach.hidden = false;
    reach.replaceChildren(heading('Ontology reach of this node'), note('Looking up how the ontology reaches this node'));
    try {
      const found = await getJson(`/api/ontology/coverage-explain?view=${encodeURIComponent(view)}${pairQuery()}&id=${encodeURIComponent(node.id)}`);
      const row = found.row;
      reach.replaceChildren(heading('Ontology reach of this node'),
        row ? el('p', {}, el('strong', {}, DISPOSITION[row.d] ?? words(row.d)), row.reason ? `: ${words(row.reason)}` : '') : note('This node is not in the coverage artifact.'),
        ...(row?.via?.length ? [el('ul', { class: 'ontology-list' }, row.via.map(v => el('li', {}, v.i !== undefined ? el('button', { type: 'button', class: 'link-button', onclick: () => app.selectNode(`ontology:concept:${v.i}`) }, v.label) : words(v.accession ?? 'a concept'), el('small', {}, words([v.by, v.relation, v.depth ? `depth ${v.depth}` : null].filter(Boolean).join(' \u00b7 '))))))] : []),
        note(`${found.summary.label} A reach is where evidence and ownership lead, not what the node means.`));
    } catch (error) { reach.replaceChildren(heading('Ontology reach of this node'), el('p', { class: 'ontology-refusal', role: 'alert' }, error.message)); }
  }

  document.addEventListener('ascrybe:node-selected', event => {
    const { node, view } = event.detail;
    section.hidden = true; reach.hidden = true;
    if (!node.id.startsWith('ontology:')) reachOf(node, view);
    if (node.id.startsWith('ontology:')) { section.hidden = false; ontologyNode(node, view); } else if (node.kind === 'Document') { section.hidden = false; relatedConcepts(node, view); }
  });
  void info;
}
