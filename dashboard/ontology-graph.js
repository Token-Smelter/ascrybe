// The evidence-chain graph. It renders /api/graph exactly as served: concepts and the quoted subjects that
// assert to them, joined by the assertions and proposed links that were sealed. Columns come from where each
// item's evidence stands (stated in a document, or declared in source), not from any domain vocabulary.
const COLUMNS = [
  { id: 'statement-subject', title: 'Stated or recorded', hint: 'Passages, decisions and rules in documents' },
  { id: 'statement-concept', title: 'Concepts from statements', hint: 'Evidence is what documents say' },
  { id: 'observed-concept', title: 'Concepts from source', hint: 'Evidence is what source declares' },
  { id: 'observed-subject', title: 'Declared in source', hint: 'Code, configuration and declarations' },
];
const ICONS = {
  document: 'M5 3h8l4 4v14H5z M13 3v4h4 M8 11h6 M8 15h6',
  decision: 'M12 3l8 9-8 9-8-9z',
  rule: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  code: 'M9 7l-5 5 5 5 M15 7l5 5-5 5',
  concept: 'M12 4a8 8 0 100 16 8 8 0 000-16z',
  unknown: 'M12 4a8 8 0 100 16 8 8 0 000-16z M9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5 M12 17v.5',
};
const PRESENCE = { located: 'Located', no_located_evidence: 'No located evidence', proposed_link: 'Proposed link', none_recorded: 'None recorded' };

export function createGraphView({ h, svg, words, short, quoteBlock, pinText, stamp }) {
  const S = { graph: null, nodes: new Map(), edges: new Map(), chain: null, focus: null, selected: null, query: '', collections: new Set(), expanded: new Set() };
  const iconFor = node => (node.type === 'concept' ? (node.category === 'policy' || node.category === 'strategy' ? 'rule' : 'concept')
    : node.kind === 'decision' ? 'decision' : node.group === 'observed' && ['code_construct', 'configuration_entry', 'build_step'].includes(node.kind) ? 'code' : 'document');
  const icon = name => svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', class: 'icon' }, svg('path', { d: ICONS[name] ?? ICONS.unknown, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const kindOf = node => (node.type === 'concept' ? `${node.category[0].toUpperCase()}${node.category.slice(1)} concept` : node.display_kind);
  const route = (kind, id = '') => { location.hash = `#graph${kind ? `/${kind}` : ''}${id ? `/${encodeURIComponent(id)}` : ''}`; };

  const put = (parent, ...items) => { parent.append(...items.flat(Infinity).filter(x => x != null && x !== false)); return parent; };

  function load(graph) {
    S.graph = graph;
    for (const n of graph.nodes) S.nodes.set(n.id, n);
    for (const e of graph.edges) S.edges.set(e.id, e);
    S.collections = new Set(graph.collections.map(c => c.collection_id));
    S.chain = graph.default_chain;
  }

  // The nodes shown: the focus (a chain, a concept or a subject) and its direct neighbours, capped per concept.
  function visible() {
    const g = S.graph, ids = new Set(), edgeIds = new Set(), hidden = new Map();
    const addEdge = e => { if (S.nodes.has(e.from) && S.nodes.has(e.to)) { ids.add(e.from); ids.add(e.to); edgeIds.add(e.id); } };
    const neighbours = (conceptId, cap) => {
      const mine = g.edges.filter(e => e.type === 'assertion' && e.to === conceptId && S.collections.has(S.nodes.get(e.from).collection_id));
      const rank = e => ({ selects: 0, defines: 0, implements: 0, subject_to: 1, constrains: 1, describes: 2 }[e.predicate] ?? 3);
      const sorted = [...mine].sort((a, b) => rank(a) - rank(b) || String(S.nodes.get(a.from).label).localeCompare(S.nodes.get(b.from).label));
      const open = S.expanded.has(conceptId) ? sorted.length : cap;
      sorted.slice(0, open).forEach(addEdge);
      if (sorted.length > open) hidden.set(conceptId, sorted.length - open);
    };
    const chain = S.chain ? g.chains.find(c => c.chain_id === S.chain) : null;
    if (S.focus && S.nodes.has(S.focus)) {
      const f = S.nodes.get(S.focus);
      ids.add(f.id);
      if (f.type === 'concept') {
        neighbours(f.id, 8);
        g.edges.filter(e => e.type === 'concept_link' && (e.from === f.id || e.to === f.id)).forEach(e => { addEdge(e); const other = e.from === f.id ? e.to : e.from; neighbours(other, 3); });
      } else {
        g.edges.filter(e => e.from === f.id || e.to === f.id).forEach(addEdge);
        g.edges.filter(e => e.type === 'assertion' && e.from === f.id).forEach(e => g.edges.filter(x => x.type === 'concept_link' && (x.from === e.to || x.to === e.to)).forEach(addEdge));
      }
    } else if (chain) {
      chain.node_ids.forEach(id => ids.add(id)); chain.edge_ids.forEach(id => edgeIds.add(id));
      [chain.statement_concept, chain.observed_concept].forEach(c => neighbours(c, 5));
    }
    return { ids, edgeIds, hidden, chain };
  }

  function layout(view) {
    const cols = new Map(COLUMNS.map(c => [c.id, []]));
    const colOf = n => {
      if (n.type === 'concept') {
        if (n.evidence_class === 'observed code') return 'observed-concept';
        if (n.evidence_class === 'claim' || n.status === 'held' || n.side !== 'observed') return 'statement-concept';
        return 'observed-concept';
      }
      return n.evidence_class === 'observed code' || n.group === 'observed' ? 'observed-subject' : 'statement-subject';
    };
    for (const id of view.ids) { const n = S.nodes.get(id); if (n && (n.type === 'concept' || S.collections.has(n.collection_id))) cols.get(colOf(n)).push(n); }
    return COLUMNS.map(c => ({ ...c, nodes: cols.get(c.id).sort((a, b) => String(a.label).localeCompare(b.label)) })).filter(c => c.nodes.length);
  }

  function nodeButton(n, view) {
    const concept = n.type === 'concept';
    const statusText = concept ? (n.currentness.state === 'supported' ? null : words(n.currentness.state)) : n.evidence_kind.label;
    const classText = n.evidence_class === 'claim' ? 'claim' : n.evidence_class === 'observed code' ? 'observed code' : null;
    return h('button', { type: 'button', class: `node node--${concept ? `concept node--${n.category}` : n.kind === 'decision' ? 'decision' : n.group}${S.selected === n.id ? ' is-selected' : ''}`, 'data-id': n.id,
      'aria-pressed': String(S.selected === n.id), onclick: () => { S.selected = n.id; render(); },
      ondblclick: () => route('focus', n.id) },
    h('span', { class: 'node__kind' }, icon(iconFor(n)), kindOf(n)),
    h('span', { class: 'node__name' }, n.label),
    n.status === 'held' ? h('span', { class: 'node__note' }, 'held') : null,
    classText ? h('span', { class: 'node__note' }, classText) : null,
    statusText ? h('span', { class: 'node__note' }, statusText) : null,
    !concept && n.basis === 'referenced_by_document' ? h('span', { class: 'node__note' }, 'Referenced, not read') : null,
    concept && view.hidden.has(n.id) ? h('span', { class: 'node__more', role: 'button', tabindex: '0', onclick: e => { e.stopPropagation(); S.expanded.add(n.id); render(); },
      onkeydown: e => { if (e.key === 'Enter') { e.stopPropagation(); S.expanded.add(n.id); render(); } } }, `Show ${view.hidden.get(n.id)} more subjects`) : null);
  }

  function placeholder(chain) {
    const missing = chain.steps.filter(s => s.status === 'no_located_evidence');
    return missing.map(s => h('div', { class: 'node node--unknown', role: 'note' }, h('span', { class: 'node__kind' }, icon('unknown'), s.title),
      h('span', { class: 'node__name' }, 'No located evidence'), h('span', { class: 'node__note' }, s.note)));
  }

  // Edges are measured from the rendered nodes, so labels and columns can change without a layout model.
  function drawEdges(canvas, svgEl, view) {
    const box = canvas.getBoundingClientRect();
    const at = id => { const el = canvas.querySelector(`[data-id="${CSS.escape(id)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }; };
    svgEl.setAttribute('width', canvas.scrollWidth); svgEl.setAttribute('height', canvas.scrollHeight);
    svgEl.replaceChildren(svg('defs', {}, ...['a', 'b'].map(k => svg('marker', { id: `arrow-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0,0 L10,5 L0,10 z', class: k === 'a' ? 'arrow' : 'arrow arrow--on' })))));
    let spread = 0;
    for (const id of view.edgeIds) {
      const e = S.edges.get(id); const a = at(e.from), b = at(e.to);
      if (!a || !b) continue;
      const left = a.x < b.x, same = Math.abs(a.x - b.x) < 8;
      const x1 = same ? a.x + a.w : left ? a.x + a.w : a.x, x2 = same ? b.x + b.w : left ? b.x : b.x + b.w;
      const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2, bend = same ? 56 + (spread += 6) % 30 : Math.max(40, Math.abs(x2 - x1) / 2);
      const sx = same ? 1 : left ? 1 : -1;
      const d = `M${x1},${y1} C${x1 + sx * bend},${y1} ${x2 - sx * bend},${y2} ${x2},${y2}`;
      const on = S.selected === id;
      const directed = e.type === 'assertion' || e.directed;
      const g = svg('g', { class: `edge edge--${e.type}${on ? ' is-selected' : ''}`, role: 'button', tabindex: '0', 'aria-label': `${e.label}: ${S.nodes.get(e.from)?.label ?? ''} to ${S.nodes.get(e.to)?.label ?? ''}`,
        onclick: () => { S.selected = id; render(); }, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); S.selected = id; render(); } } },
      svg('path', { d, class: 'edge__hit', fill: 'none' }),
      svg('path', { d, class: `edge__line${e.dashed ? ' is-dashed' : ''}`, fill: 'none', ...(directed ? { 'marker-end': `url(#arrow-${on ? 'b' : 'a'})` } : {}) }));
      const mx = (x1 + x2) / 2 + (same ? sx * bend * 0.75 : 0), my = (y1 + y2) / 2, label = String(e.label);
      g.append(svg('rect', { x: mx - label.length * 4.3 - 8, y: my - 12, width: label.length * 8.6 + 16, height: 24, rx: 12, class: 'edge__chip' }), svg('text', { x: mx, y: my + 5, class: 'edge__text', 'text-anchor': 'middle' }, label));
      svgEl.append(g);
    }
  }

  function chainSteps(chain) {
    return h('ol', { class: 'steps', 'aria-label': 'Evidence chain' }, chain.steps.map(s => h('li', { class: `step step--${s.status}` },
      h('span', { class: 'step__title' }, s.title),
      h('span', { class: 'pill' }, PRESENCE[s.status] ?? words(s.status)),
      s.note && s.status !== 'located' ? h('span', { class: 'step__note' }, s.note) : null)));
  }

  function inspector() {
    const sel = S.selected, box = h('aside', { class: 'inspector', 'aria-label': 'Selected item' });
    if (!sel) { put(box, h('h2', {}, 'Select a node or a line'), h('p', { class: 'muted' }, 'Choose a node or a labelled line in the graph to read what it means, the exact source excerpt, and how well it is supported.')); return box; }
    const node = S.nodes.get(sel), edge = S.edges.get(sel);
    const statusBlock = (validation, evidenceKind, runtime) => h('dl', { class: 'facts' },
      h('dt', {}, 'Source check'), h('dd', {}, validation?.source_quote_located ? 'The quoted text was found at the pinned location.' : 'The quote was not located at a pin.'),
      h('dt', {}, 'Review'), h('dd', {}, 'Not reviewed. Review recording is not enabled in this viewer, so nothing here is accepted or rejected.'),
      h('dt', {}, 'What the evidence is'), h('dd', {}, evidenceKind), h('dt', {}, 'Runtime check'), h('dd', {}, runtime ? 'Recorded.' : 'None recorded.'));
    const details = rows => h('details', { class: 'tech' }, h('summary', {}, 'How this was generated'), h('dl', { class: 'facts facts--mono' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    if (node?.type === 'concept') {
      const asserted = S.graph.edges.filter(e => e.type === 'assertion' && e.to === node.id);
      put(box, h('p', { class: 'eyebrow-less muted' }, `${kindOf(node)} · ${node.collection_id}`), h('h2', {}, node.label), h('p', {}, node.definition),
        h('p', { class: 'muted' }, ['Includes: ', node.inclusion]), h('p', { class: 'muted' }, ['Excludes: ', node.exclusion]),
        h('h3', {}, `Supporting excerpts (${node.support.length})`), node.support.length ? node.support.map(e => h('div', { class: 'excerpt' }, quoteBlock(e), h('p', { class: 'src' }, [pinText(e), ' · ', words(e.standing)]))) : h('p', { class: 'muted' }, 'No supporting excerpt is located at a pin.'),
        h('h3', {}, `Subjects asserted to it (${asserted.length})`),
        h('ul', { class: 'plain' }, asserted.slice(0, 12).map(e => h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => { S.selected = e.id; render(); } }, `${S.nodes.get(e.from).label} ${e.label}`)))),
        node.status === 'held' ? h('p', {}, 'Status: held. This concept is not proposed.') : null,
        node.evidence_class ? h('p', {}, `Classification: ${node.evidence_class}`) : null,
        statusBlock({ source_quote_located: node.support.some(e => e.validation.source_quote_located) }, `Concept standing: ${words(node.standing)}`, false),
        h('p', {}, h('button', { type: 'button', class: 'btn', onclick: () => route('focus', node.id) }, 'Focus the graph on this concept')),
        details([['Concept id', node.accession], ['Version', node.version_id], ['Generation', node.generation_id], ['Origin', node.origin]]));
    } else if (node) {
      const out = S.graph.edges.filter(e => e.from === node.id || e.to === node.id);
      put(box, h('p', { class: 'muted' }, `${node.display_kind} · ${node.collection_id}`), h('h2', {}, node.label),
        node.kind === 'decision' && node.group === 'statement' ? h('p', { class: 'muted' }, 'A decision recorded in the source document. Recording it here does not accept the generated assertions about it.') : null,
        node.source?.quote ? h('div', { class: 'excerpt' }, quoteBlock(node.source), h('p', { class: 'src' }, pinText(node.source))) : null,
        node.basis === 'referenced_by_document' ? h('p', { class: 'muted' }, 'Named in a document. The thing itself was not read, and ownership or permission is not established.') : null,
        node.instance_status ? h('p', { class: 'muted' }, 'Marked as not an instance of any concept. It can still define or describe one.') : null,
        h('h3', {}, `Connected by ${out.length} line${out.length === 1 ? '' : 's'}`),
        h('ul', { class: 'plain' }, out.slice(0, 12).map(e => h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => { S.selected = e.id; render(); } },
          e.from === node.id ? `${e.label} → ${S.nodes.get(e.to)?.label}` : `${S.nodes.get(e.from)?.label} ${e.label} → this`)))),
        statusBlock(node.source.validation, node.evidence_kind.label, false),
        h('p', {}, h('button', { type: 'button', class: 'btn', onclick: () => route('focus', node.id) }, 'Focus the graph on this subject')),
        details([['Subject id (an interpretation, not an observed graph object)', node.referent_id], ['Linked graph node', node.graph_node_ids.length ? node.graph_node_ids.map(x => x.node_id).join(', ') : 'none recorded'],
          ['Generation', node.generation_id], ['Coverage', words(node.coverage?.status)]]));
    } else if (edge) {
      const from = S.nodes.get(edge.from), to = S.nodes.get(edge.to);
      put(box, h('p', { class: 'muted' }, edge.type === 'assertion' ? 'Statement in the source' : edge.type === 'concept_link' ? 'Proposed link between concepts' : 'Proposed link between subjects'),
        h('h2', {}, `${from.label} ${edge.label} ${to.label}`),
        edge.meaning ? h('p', {}, ['What “', edge.label, '” means here: ', edge.meaning]) : null);
      if (edge.type === 'assertion') {
        put(box, h('div', { class: 'excerpt' }, quoteBlock(edge.source), h('p', { class: 'src' }, pinText(edge.source))), statusBlock(edge.validation, edge.evidence_kind.label, edge.runtime_verified),
          h('p', {}, h('button', { type: 'button', class: 'btn', onclick: () => route('focus', edge.to) }, 'Focus on the concept')));
      } else {
        put(box, h('p', {}, ['Uncertainty: ', h('strong', {}, edge.uncertainty), edge.evidence_nature ? ` · ${words(edge.evidence_nature)}` : '']), h('p', {}, edge.reason));
        if (edge.type === 'concept_link' && edge.relation === 'related' && !edge.cross_kind) put(box, h('p', { class: 'caution' }, 'This link records an association. It does not establish that the source implements the stated choice.'));
        if (edge.inclusion_basis) put(box, h('p', { class: 'muted' }, ['Inclusion basis, quoted from the broader definition: ', edge.inclusion_basis]));
        const ends = edge.type === 'concept_link' ? edge.endpoints.flatMap(e => e.evidence.map(x => ({ ...x, label: e.label }))) : edge.endpoints;
        put(box, h('h3', {}, 'Both ends, quoted'), ends.map(e => h('div', { class: 'excerpt' }, h('p', { class: 'src' }, e.label ?? e.name), quoteBlock(e), h('p', { class: 'src' }, [pinText(e), ' · ', words(e.standing ?? '')]))),
          statusBlock({ source_quote_located: ends.every(e => e.validation?.source_quote_located) }, 'Link between two interpretations; each end is a quoted source excerpt', edge.runtime_verified),
          details([['Link id', edge.link_id ?? edge.subject_link_id], ['Model', edge.model?.requested], ['Scaffold', edge.model?.scaffold], ['Judged by', edge.judged_model], ['Request', edge.request_digest],
            ['Found by', (edge.retrieval ?? []).map(r => r.source).join(' + ') || null], ['Context round', edge.context_round ? String(edge.context_round) : null]]));
      }
    }
    return box;
  }

  function toolbar() {
    const g = S.graph, q = S.query.trim().toLowerCase();
    const matches = q ? g.nodes.filter(n => S.collections.has(n.collection_id) && `${n.label} ${n.definition ?? ''} ${n.denotes ?? ''}`.toLowerCase().includes(q)).slice(0, 12) : [];
    const chainNote = c => (c.realisation === 'associated_only' ? 'Stated, and declared in source, joined by an association only' : c.realisation === 'link_proposes_implementation' ? 'The link proposes that source implements it' : 'No implementation located');
    const current = g.chains.find(c => c.chain_id === S.chain);
    return h('div', { class: 'toolbar' },
      h('label', { class: 'field', for: 'chain-select' }, h('span', {}, 'Evidence chain'),
        h('select', { id: 'chain-select', onchange: e => route('chain', e.target.value) }, g.chains.length ? g.chains.map(c => h('option', { value: c.chain_id, ...(c.chain_id === S.chain ? { selected: '' } : {}) }, c.title)) : [h('option', {}, 'No chain in this data')])),
      h('label', { class: 'field field--grow', for: 'graph-search' }, h('span', {}, 'Search concepts and subjects'), h('input', { id: 'graph-search', type: 'search', value: S.query, autocomplete: 'off',
        oninput: e => { S.query = e.target.value; const pos = e.target.selectionStart; render(); const el = document.getElementById('graph-search'); el.focus(); el.setSelectionRange(pos, pos); } })),
      h('div', { class: 'field' }, h('span', {}, 'Collections'), h('div', { class: 'chips', role: 'group', 'aria-label': 'Collections' }, g.collections.map(c => h('button', { type: 'button', class: `chip${S.collections.has(c.collection_id) ? ' is-on' : ''}`, 'aria-pressed': String(S.collections.has(c.collection_id)),
        onclick: () => { if (S.collections.has(c.collection_id)) S.collections.delete(c.collection_id); else S.collections.add(c.collection_id); render(); } }, c.collection_id)))),
      current && !q ? h('p', { class: 'muted toolbar__note' }, chainNote(current)) : null,
      q ? h('div', { class: 'matches' }, h('p', { class: 'muted' }, `${matches.length} match${matches.length === 1 ? '' : 'es'}`), h('ul', { class: 'results' }, matches.map(n => h('li', {}, h('button', { type: 'button', class: 'result', onclick: () => { S.query = ''; route('focus', n.id); } },
        h('span', { class: 'result__name' }, n.label), h('span', { class: 'result__meta' }, `${kindOf(n)} · ${n.collection_id}`)))))) : null);
  }

  function render(detail, rail) {
    detail = detail ?? S.detail; rail = rail ?? S.rail; S.detail = detail; S.rail = rail;
    const view = visible(), cols = layout(view);
    const chain = view.chain && !S.focus ? view.chain : null;
    const canvas = h('div', { class: 'canvas' }, cols.map(c => h('section', { class: 'col', 'aria-label': c.title }, h('h2', { class: 'col__title' }, c.title), h('p', { class: 'col__hint' }, c.hint),
      c.nodes.map(n => nodeButton(n, view)), c.id === 'observed-subject' && chain ? placeholder(chain) : null)));
    const overlay = svg('svg', { class: 'edges', 'aria-hidden': 'false' });
    const stage = h('div', { class: 'stage' }, canvas, overlay);
    const focusNode = S.focus ? S.nodes.get(S.focus) : null;
    const main = h('section', { class: 'graph', 'aria-label': 'Evidence graph' },
      h('div', { class: 'graph__head' }, h('h1', {}, chain ? chain.title : focusNode ? `Around ${focusNode.label}` : 'Evidence graph'),
        focusNode ? h('p', {}, h('button', { type: 'button', class: 'btn', onclick: () => route('chain', S.chain ?? '') }, 'Back to the evidence chain')) : null),
      chain ? chainSteps(chain) : h('p', { class: 'muted' }, 'Concepts in the middle, the passages and code that assert to them at the sides. A solid line is a statement found in the source; a dashed line is a link proposed by the generator. The graph scrolls sideways on narrow screens.'),
      h('div', { class: 'scroller', tabindex: '0', role: 'region', 'aria-label': 'Graph canvas, scrolls sideways' }, stage),
      h('p', { class: 'muted legend' }, 'Solid line: an assertion tied to a quoted passage. Dashed line: a proposed link. A box that says No located evidence marks something the data does not contain. The graph scrolls sideways on narrow screens.'),
      S.graph.broken.length ? h('p', { class: 'caution' }, `${S.graph.broken.length} link(s) refer to items that are not in the loaded generations and are not drawn.`) : null);
    const wrap = h('div', { class: 'graph-layout' }, h('div', { class: 'graph-main' }, toolbar(), main), inspector());
    detail.replaceChildren(wrap); rail.replaceChildren();
    requestAnimationFrame(() => drawEdges(stage, overlay, view));
  }

  function applyRoute(parts) {
    const [mode, ...rest] = parts, id = decodeURIComponent(rest.join('/'));
    S.focus = null;
    if (mode === 'chain' && S.graph.chains.some(c => c.chain_id === id)) { S.chain = id; S.selected = S.graph.chains.find(c => c.chain_id === id).statement_concept; }
    else if (mode === 'focus' && S.nodes.has(id)) { S.focus = id; S.selected = id; }
    else if (!S.selected && S.chain) S.selected = S.graph.chains.find(c => c.chain_id === S.chain)?.statement_concept ?? null;
  }
  return { load, render, applyRoute, state: S };
}
