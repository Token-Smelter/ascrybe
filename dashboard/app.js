import { graphDetailForEdge, graphDetailForNode, graphDetailText } from '/graph-detail.js';
import { layeredLayout } from '/layered-layout.js';
import { bundlesFor } from '/bundles.js';

const svg = document.querySelector('#graph');
const viewport = document.querySelector('#viewport');
const edgeLayer = document.querySelector('#edges');
const nodeLayer = document.querySelector('#nodes');
const inspector = document.querySelector('#inspector');
const searchInput = document.querySelector('#graph-search');
const searchResults = document.querySelector('#search-results');
const resultTemplate = document.querySelector('#search-result-template');
const graphDetail = document.querySelector('#graph-detail');
const graphDetailType = document.querySelector('#graph-detail-type');
const graphDetailTitle = document.querySelector('#graph-detail-title');
const graphDetailFields = document.querySelector('#graph-detail-fields');

const state = {
  view: 'selected',
  nodes: new Map(),
  edges: new Map(),
  positions: new Map(),
  selectedId: null,
  pathOrigin: null,
  transform: { x: 0, y: 0, scale: 1 },
  drag: null,
  projection: null,
  userAdjusted: false,
  trail: [],
  pinned: new Set(),
  nodeDrag: null,
  expand: 'structural',
  kindQuota: 30,
  bundles: new Map(),
};

const kindShape = {
  Claim: 'rounded', Referent: 'circle', Document: 'document', Evidence: 'diamond',
  CodeFact: 'square', AdjudicationReceipt: 'hexagon', SupersessionReceipt: 'hexagon',
  ObligationResult: 'diamond', SourceCommit: 'double', Project: 'double', Bundle: 'bundle',
};

function api(path, parameters = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set('view', state.view);
  for (const [key, value] of Object.entries(parameters)) if (value != null && value !== '') {
    url.searchParams.set(key, value);
  }
  return fetch(url).then(async response => {
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.message || response.statusText), body);
    return body;
  });
}

function mergeGraph(graph) {
  for (const node of graph.nodes || []) state.nodes.set(node.id, node);
  for (const edge of graph.edges || []) state.edges.set(edge.id, edge);
}

function layoutGraph() {
  state.positions = layeredLayout({
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    positions: state.positions,
    pinned: state.pinned,
  });
}

// A quadratic bow whose depth grows with span but is capped, so a long flow edge stays inside the
// frame the layers define instead of swinging the fitted view out to meet it.
function arcPath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.hypot(dx, dy) || 1;
  const bow = Math.min(90, span * 0.18);
  return `M${from.x} ${from.y} Q${(from.x + to.x) / 2 - (dy / span) * bow} `
    + `${(from.y + to.y) / 2 + (dx / span) * bow} ${to.x} ${to.y}`;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

let graphDetailSource = null;

function renderGraphDetail(detail) {
  graphDetailType.textContent = detail.type;
  graphDetailTitle.textContent = detail.title;
  graphDetailFields.replaceChildren();
  for (const field of detail.fields) {
    const row = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = field.label;
    const description = document.createElement('dd'); description.textContent = field.value;
    row.append(term, description); graphDetailFields.append(row);
  }
}

function positionGraphDetail(anchor, source) {
  const point = Number.isFinite(anchor?.clientX) && Number.isFinite(anchor?.clientY)
    ? { x: anchor.clientX, y: anchor.clientY }
    : (() => {
      const bounds = source.getBoundingClientRect();
      return { x: bounds.right, y: bounds.bottom };
    })();
  const gap = 14;
  const width = graphDetail.offsetWidth;
  const height = graphDetail.offsetHeight;
  const left = Math.max(gap, Math.min(point.x + gap,
    window.innerWidth - width - gap));
  const top = Math.max(gap, Math.min(point.y + gap,
    window.innerHeight - height - gap));
  graphDetail.style.left = `${left}px`;
  graphDetail.style.top = `${top}px`;
}

function showGraphDetail(detail, anchor) {
  const source = anchor.currentTarget || anchor;
  graphDetailSource = source;
  renderGraphDetail(detail);
  graphDetail.hidden = false;
  positionGraphDetail(anchor, source);
}

function hideGraphDetail(source = null) {
  if (source && graphDetailSource !== source) return;
  if (source && (document.activeElement === source || source.matches(':hover'))) return;
  graphDetail.hidden = true;
  graphDetailSource = null;
}

function bindGraphDetail(element, detail) {
  element.addEventListener('pointerenter', event => showGraphDetail(detail, event));
  element.addEventListener('pointerleave', () => hideGraphDetail(element));
  element.addEventListener('focus', () => showGraphDetail(detail, element));
  element.addEventListener('blur', () => hideGraphDetail(element));
}

function shapeFor(node) {
  const shape = kindShape[node.kind] || 'circle';
  if (shape === 'rounded') return svgElement('rect', { x: -27, y: -12, width: 54, height: 24, rx: 8, class: 'node-shape' });
  if (shape === 'bundle') {
    // A bundle is a folded group of neighbours, drawn as a stacked pill carrying its count so the
    // canvas shows that more exists here without drawing every member.
    const group = svgElement('g');
    group.append(svgElement('rect', { x: -24, y: -8, width: 54, height: 22, rx: 11, class: 'node-shape bundle-shadow' }),
      svgElement('rect', { x: -27, y: -11, width: 54, height: 22, rx: 11, class: 'node-shape' }));
    const count = svgElement('text', { x: 0, y: 4, class: 'bundle-count', 'text-anchor': 'middle' });
    count.textContent = node.properties?.count == null ? '…' : String(node.properties.count);
    group.append(count);
    return group;
  }
  if (shape === 'square') return svgElement('rect', { x: -9, y: -9, width: 18, height: 18, rx: 2, class: 'node-shape' });
  if (shape === 'document') return svgElement('path', { d: 'M-13-15 H7 L14-8 V15 H-13 Z M7-15 V-8 H14', class: 'node-shape' });
  if (shape === 'diamond') return svgElement('path', { d: 'M0-13 L13 0 L0 13 L-13 0 Z', class: 'node-shape' });
  if (shape === 'hexagon') return svgElement('path', { d: 'M-12-7 L0-14 L12-7 L12 7 L0 14 L-12 7 Z', class: 'node-shape' });
  if (shape === 'double') {
    const group = svgElement('g');
    group.append(svgElement('circle', { r: 14, class: 'node-shape' }), svgElement('circle', { r: 9, class: 'node-shape' }));
    return group;
  }
  return svgElement('circle', { r: node.kind === 'Referent' ? 12 : 9, class: 'node-shape' });
}

function render() {
  hideGraphDetail();
  layoutGraph();
  edgeLayer.replaceChildren();
  nodeLayer.replaceChildren();
  for (const edge of state.edges.values()) {
    const from = state.positions.get(edge.from), to = state.positions.get(edge.to);
    if (!from || !to) continue;
    const detail = graphDetailForEdge(edge, state.nodes);
    const role = edge.role ?? 'unclassified';
    const shared = {
      class: `edge${edge.from === state.selectedId || edge.to === state.selectedId ? ' is-highlighted' : ''}`,
      tabindex: '0', role: 'img', 'aria-label': graphDetailText(detail),
      'aria-describedby': 'graph-detail',
      'data-relation': edge.relation,
      'data-role': role,
      'data-bundle': String(Boolean(edge.bundle)),
      'data-from': edge.from,
      'data-to': edge.to,
      'marker-end': ['superseded_by', 'identifies', 'adjudicated_by'].includes(edge.relation) ? 'url(#arrow)' : '',
    };
    // Structure placed these nodes, so a structural edge is a straight line between a parent and
    // the child it owns. Everything else crosses that frame rather than forming it, and is bowed
    // aside so it reads as a departure instead of disappearing into the containment beneath it.
    const line = role === 'structural'
      ? svgElement('line', { ...shared, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
      : svgElement('path', { ...shared, d: arcPath(from, to) });
    const title = svgElement('title'); title.textContent = edge.relation; line.append(title);
    bindGraphDetail(line, detail);
    edgeLayer.append(line);
  }
  // Labelling every node at once produces overlapping text that hides the graph. Label the
  // selection, its immediate neighbours, and the most connected nodes in view; the rest reveal
  // their label on hover or selection.
  const degrees = new Map();
  for (const edge of state.edges.values()) {
    degrees.set(edge.from, (degrees.get(edge.from) || 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) || 0) + 1);
  }
  const labelled = new Set([...state.nodes.keys()]
    .sort((left, right) => (degrees.get(right) || 0) - (degrees.get(left) || 0))
    .slice(0, 18));
  if (state.selectedId) {
    labelled.add(state.selectedId);
    for (const edge of state.edges.values()) {
      if (edge.from === state.selectedId) labelled.add(edge.to);
      if (edge.to === state.selectedId) labelled.add(edge.from);
    }
  }
  for (const node of state.nodes.values()) {
    const point = state.positions.get(node.id);
    const detail = graphDetailForNode(node);
    const group = svgElement('g', {
      class: `node${node.id === state.selectedId ? ' is-selected' : ''}`,
      transform: `translate(${point.x} ${point.y})`, tabindex: '0', role: 'button',
      'aria-label': graphDetailText(detail), 'aria-describedby': 'graph-detail',
      'data-kind': node.kind, 'data-verdict': node.properties?.verdict || '',
    });
    group.append(shapeFor(node));
    const label = svgElement('text', {
      x: 16, y: 4,
      class: `node-label${labelled.has(node.id) ? '' : ' is-secondary'}`,
    });
    const full = String(node.label ?? node.id ?? '');
    const shown = node.kind === 'Document' ? full.split('/').pop() : full;
    label.textContent = shown.length > 34 ? `${shown.slice(0, 31)}\u2026` : shown;
    if (node.kind === 'Bundle') label.setAttribute('x', 32);
    const title = svgElement('title');
    title.textContent = `${node.kind}: ${full}`;
    group.append(label, title);
    if (state.pinned.has(node.id)) group.classList.add('is-pinned');
    group.addEventListener('pointerdown', event => startNodeDrag(event, node.id, group));
    group.addEventListener('click', event => {
      event.stopPropagation();
      if (state.nodeDrag?.moved) return;
      if (node.kind === 'Bundle') expandBundle(node.id); else selectNode(node.id);
    });
    group.addEventListener('dblclick', event => {
      event.stopPropagation();
      state.pinned.delete(node.id);
      group.classList.remove('is-pinned');
    });
    group.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (node.kind === 'Bundle') expandBundle(node.id); else selectNode(node.id);
    });
    bindGraphDetail(group, detail);
    nodeLayer.append(group);
  }
}

function setConnection(kind, label) {
  const element = document.querySelector('#connection-status');
  element.className = kind;
  element.lastChild.textContent = label;
}

function updateProjectionStatus(projection) {
  state.projection = projection;
  document.querySelector('#projection-status').textContent = `${state.view} · ${projection.status}`;
  document.querySelector('#coverage-status').textContent = `${projection.processed_nodes}/${projection.total_nodes} nodes · ${projection.processed_edges}/${projection.total_edges} edges`;
  document.querySelector('#source-status').textContent = projection.source_commit || '';
}

function propertyValue(value) {
  if (value == null) return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function structureLabel(node) {
  const parts = [node.kind];
  if (node.plane) parts.push(node.plane);
  if (Number.isFinite(node.structural_children)) {
    parts.push(`${node.structural_children} ${node.structural_children === 1 ? 'child' : 'children'}`);
    if (node.structural_descendants > node.structural_children) parts.push(`${node.structural_descendants} in tree`);
  }
  return parts.join(' · ');
}

function renderInspector(node, neighbors = [], bundles = []) {
  state.selectedId = node.id;
  inspector.hidden = false;
  document.querySelector('#inspector-kind').textContent = structureLabel(node);
  document.querySelector('#inspector-label').textContent = node.label;
  const properties = document.querySelector('#inspector-properties');
  properties.replaceChildren();
  const rows = { node_id: node.id, ...node.properties };
  for (const [key, value] of Object.entries(rows)) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = key.replaceAll('_', ' ');
    const detail = document.createElement('dd');
    const code = document.createElement('code'); code.textContent = propertyValue(value);
    detail.append(code); wrapper.append(term, detail); properties.append(wrapper);
  }
  document.querySelector('#neighbor-count').textContent = `${neighbors.length} shown`;
  const summary = document.querySelector('#neighbor-summary');
  summary.replaceChildren();
  const counts = new Map();
  for (const row of neighbors) counts.set(row.edge.relation, (counts.get(row.edge.relation) || 0) + 1);
  for (const [relation, count] of [...counts].sort()) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = `${relation} · ${count}`;
    button.addEventListener('click', () => highlightRelation(relation));
    summary.append(button);
  }
  const folded = document.querySelector('#bundle-summary');
  folded.replaceChildren();
  document.querySelector('#bundle-section').hidden = bundles.length === 0;
  for (const bundle of bundles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.role = bundle.role;
    button.textContent = `${bundle.relation} ${bundle.direction === 'in' ? '←' : '→'} ${bundle.count} ${bundle.kind}`;
    button.title = `${bundle.role} relation, folded. Click to unfold onto the canvas.`;
    button.addEventListener('click', () => expandBundle(bundle.id));
    folded.append(button);
  }
  render();
}

function clearBundles() {
  for (const id of state.bundles.keys()) { state.nodes.delete(id); state.edges.delete(`edge:${id}`); }
  state.bundles.clear();
}

async function expandBundle(id) {
  const bundle = state.bundles.get(id);
  if (!bundle) return;
  try {
    setConnection('', 'Unfolding');
    const result = await api('/api/neighbors', { id: bundle.owner, relation: bundle.relation, direction: bundle.direction, limit: 60 });
    const graph = { nodes: result.data.adjacent_nodes.filter(node => node.kind === bundle.kind), edges: [] };
    const admitted = new Set(graph.nodes.map(node => node.id));
    for (const edge of result.data.edges) if (admitted.has(edge.from) || admitted.has(edge.to)) graph.edges.push(edge);
    mergeGraph(graph);
    state.nodes.delete(id); state.edges.delete(`edge:${id}`); state.bundles.delete(id);
    if (result.truncated) {
      const remaining = { ...bundle, count: Math.max(0, bundle.count - graph.nodes.length) };
      if (remaining.count > 0) addBundle(remaining);
    }
    const selected = state.nodes.get(state.selectedId);
    if (selected) renderInspector(selected, neighborsOf(selected.id), [...state.bundles.values()].filter(held => held.owner === selected.id));
    else render();
    setConnection('is-connected', 'Connected');
  } catch (error) { showError(error, `unfold ${bundle.relation}`); }
}

function neighborsOf(id) {
  const rows = [];
  for (const edge of state.edges.values()) {
    if (edge.bundle) continue;
    const otherId = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    const other = otherId && state.nodes.get(otherId);
    if (other) rows.push({ edge, node: other });
  }
  return rows;
}

function addBundle(bundle) {
  state.bundles.set(bundle.id, bundle);
  state.nodes.set(bundle.id, { id: bundle.id, kind: 'Bundle', label: `${bundle.relation} · ${bundle.kind}`,
    properties: { relation: bundle.relation, direction: bundle.direction, kind: bundle.kind, role: bundle.role, count: bundle.count } });
  state.edges.set(`edge:${bundle.id}`, { id: `edge:${bundle.id}`, relation: bundle.relation, bundle: true,
    from: bundle.direction === 'out' ? bundle.owner : bundle.id, to: bundle.direction === 'out' ? bundle.id : bundle.owner, properties: {} });
}

// Navigating somewhere and adding to what you are already looking at are different acts, and the
// interface treated them as one: every selection merged, nothing was ever removed, and a search
// followed by one drill left 145 nodes on a canvas fitted to scale 0.14 -- unreadable, and made
// of three unrelated neighbourhoods. `Expand neighborhood` called exactly the same function as
// clicking a node, so it did nothing and could not.
function mergeNeighborhood(payload, { focus = false } = {}) {
  const graph = { nodes: [payload.node], edges: [] };
  for (const row of payload.neighbors) {
    graph.nodes.push(row.node); graph.edges.push(row.edge);
  }
  if (focus) {
    // Keep the pinned nodes: a reader who placed something by hand meant it to stay.
    const kept = new Set([...state.pinned, payload.node.id, ...graph.nodes.map(node => node.id)]);
    for (const id of [...state.nodes.keys()]) if (!kept.has(id)) state.nodes.delete(id);
    for (const [id, edge] of [...state.edges]) {
      if (!state.nodes.has(edge.from) || !state.nodes.has(edge.to)) state.edges.delete(id);
    }
    state.positions.clear();
  }
  mergeGraph(graph);
  clearBundles();
  const bundles = bundlesFor(payload);
  for (const bundle of bundles) addBundle(bundle);
  return bundles;
}

async function selectNode(id, { push = true, focus = true } = {}) {
  try {
    setConnection('', 'Querying');
    const result = await api('/api/node', { id, expand: state.expand, kind_quota: state.kindQuota });
    const bundles = mergeNeighborhood(result.data, { focus });
    renderInspector(result.data.node, result.data.neighbors, bundles);
    updateProjectionStatus(result.projection);
    centerOn(id);
    if (push) {
      state.trail.push({ id, label: result.data.node.label, kind: result.data.node.kind });
      history.pushState({ nodeId: id, depth: state.trail.length }, '', `#${encodeURIComponent(id)}`);
    }
    renderTrail();
    setConnection('is-connected', 'Connected');
  } catch (error) { showError(error, `node ${id}`); }
}

// Drilling in is only useful when it is reversible, so every selection becomes a step that can be
// walked back: the Back control, any earlier breadcrumb, the browser's own history, or Alt+Left.
function renderTrail() {
  const trail = document.querySelector('#trail');
  document.querySelector('#go-back').hidden = state.trail.length === 0;
  trail.replaceChildren();
  const root = document.createElement('button');
  root.type = 'button';
  root.textContent = 'Estate';
  root.setAttribute('aria-current', String(state.trail.length === 0));
  root.addEventListener('click', returnToOverview);
  trail.append(root);
  const visible = state.trail.slice(-3);
  if (state.trail.length > visible.length) {
    const gap = document.createElement('span');
    gap.textContent = '\u2026';
    trail.append(gap);
  }
  visible.forEach((entry, index) => {
    const separator = document.createElement('span');
    separator.textContent = '\u203a';
    const step = document.createElement('button');
    const depth = state.trail.length - visible.length + index + 1;
    step.type = 'button';
    step.textContent = entry.label;
    step.title = `${entry.kind}: ${entry.label}`;
    step.setAttribute('aria-current', String(depth === state.trail.length));
    step.addEventListener('click', () => walkTrailTo(depth));
    trail.append(separator, step);
  });
}

function walkTrailTo(depth) {
  if (depth >= state.trail.length) return;
  state.trail = state.trail.slice(0, depth);
  const entry = state.trail.at(-1);
  if (entry) selectNode(entry.id, { push: false }); else returnToOverview();
}

function goBack() {
  if (!state.trail.length) return;
  walkTrailTo(state.trail.length - 1);
}

function returnToOverview() {
  state.trail = [];
  renderTrail();
  loadOverview();
}

async function loadConcepts() {
  try {
    const result = await api('/api/concepts', { limit: 12 });
    const sections = [
      ['#concepts-documents', result.data.documents_by_claims, row => `${row.claims} claims`],
      ['#concepts-asserted', result.data.entities_by_claims, row => `${row.claims} claims`],
      ['#concepts-structural', result.data.entities_by_structure, row => `${row.connections} links`],
      ['#concepts-documented', result.data.entities_by_surface_mention, row => `${row.documents} docs`],
    ];
    for (const [selector, rows, measure] of sections) {
      const list = document.querySelector(selector);
      list.replaceChildren();
      for (const row of rows) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const label = document.createElement('span');
        label.textContent = row.label;
        label.title = row.namespace ? `${row.namespace} · ${row.label}` : row.label;
        const count = document.createElement('b');
        count.textContent = measure(row);
        button.append(label, count);
        button.addEventListener('click', () => selectNode(row.id));
        item.append(button);
        list.append(item);
      }
    }
  } catch (error) { showError(error, 'concepts'); }
}

// Direct manipulation: a node can be dragged to a chosen place and stays there while the rest of
// the graph relaxes around it. Double-click releases it back to the layout.
function startNodeDrag(event, id, group) {
  event.stopPropagation();
  const point = state.positions.get(id);
  if (!point) return;
  group.setPointerCapture(event.pointerId);
  state.nodeDrag = { id, group, pointerId: event.pointerId, moved: false,
    originX: point.x, originY: point.y, startX: event.clientX, startY: event.clientY };
}

function moveNodeDrag(event) {
  const drag = state.nodeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = (event.clientX - drag.startX) / state.transform.scale;
  const dy = (event.clientY - drag.startY) / state.transform.scale;
  if (!drag.moved && Math.hypot(dx, dy) < 3 / state.transform.scale) return;
  drag.moved = true;
  state.positions.set(drag.id, { x: drag.originX + dx, y: drag.originY + dy });
  state.pinned.add(drag.id);
  drag.group.classList.add('is-pinned');
  drag.group.setAttribute('transform', `translate(${drag.originX + dx} ${drag.originY + dy})`);
  redrawEdgesFor(drag.id);
}

function endNodeDrag() {
  if (!state.nodeDrag) return;
  const moved = state.nodeDrag.moved;
  state.nodeDrag = null;
  if (moved) render();
}

function redrawEdgesFor(id) {
  const point = state.positions.get(id);
  for (const line of edgeLayer.children) {
    if (line.dataset.from === id) { line.setAttribute('x1', point.x); line.setAttribute('y1', point.y); }
    if (line.dataset.to === id) { line.setAttribute('x2', point.x); line.setAttribute('y2', point.y); }
  }
}

// Expansion adds nodes around the selection, so the view follows the selection rather than
// leaving newly revealed neighbors outside the viewport.
function centerOn(id) {
  const point = state.positions.get(id);
  const box = svg.getBoundingClientRect();
  if (!point || box.width < 2) return;
  state.transform.x = box.width / 2 - point.x * state.transform.scale;
  state.transform.y = box.height / 2 - point.y * state.transform.scale;
  applyTransform();
}

function highlightRelation(relation) {
  for (const edge of edgeLayer.children) edge.classList.toggle('is-highlighted', edge.dataset.relation === relation);
}

async function traceProvenance() {
  if (!state.selectedId) return;
  try {
    const result = await api('/api/provenance', { id: state.selectedId });
    for (const path of result.data) {
      for (const edge of path.edges) if (!state.edges.has(edge.id)) state.edges.set(edge.id, edge);
    }
    const targets = result.data.map(path => path.target);
    for (const target of targets) state.nodes.set(target.id, target);
    render();
    const message = document.querySelector('#path-message');
    message.hidden = false;
    message.textContent = targets.length
      ? `${targets.length} provenance endpoint${targets.length === 1 ? '' : 's'} added to the graph.`
      : 'No provenance endpoint was reachable within the bounded depth.';
  } catch (error) { showError(error); }
}

async function setOrResolvePath() {
  if (!state.selectedId) return;
  const message = document.querySelector('#path-message');
  if (!state.pathOrigin) {
    state.pathOrigin = state.selectedId;
    message.hidden = false;
    message.textContent = 'Path origin set. Select another node and choose Find path.';
    document.querySelector('#set-path-origin').textContent = 'Find path';
    return;
  }
  if (state.pathOrigin === state.selectedId) {
    state.pathOrigin = null;
    message.hidden = true;
    document.querySelector('#set-path-origin').textContent = 'Set path origin';
    return;
  }
  try {
    const result = await api('/api/path', { from: state.pathOrigin, to: state.selectedId });
    if (result.data) mergeGraph(result.data);
    render();
    message.hidden = false;
    message.textContent = result.data ? `${result.data.edges.length}-edge receipted path added.` : 'No bounded path found.';
    state.pathOrigin = null;
    document.querySelector('#set-path-origin').textContent = 'Set path origin';
  } catch (error) { showError(error); }
}

// An error is not an empty graph. Conflating them hid the real failure behind "no projection",
// so the exact stage and message are shown instead.
function showError(error, stage = 'graph') {
  setConnection('is-error', 'Query failed');
  const banner = document.querySelector('#graph-error');
  document.querySelector('#graph-error-stage').textContent = `${stage} failed`;
  document.querySelector('#graph-error-message').textContent =
    `${error?.name || 'Error'}: ${error?.message || 'unknown failure'}`;
  banner.hidden = false;
  console.error(`[estate-map] ${stage} failed`, error);
}

function clearError() {
  document.querySelector('#graph-error').hidden = true;
}

async function loadOverview() {
  state.nodes.clear(); state.edges.clear(); state.positions.clear(); state.selectedId = null; state.bundles.clear();
  inspector.hidden = true;
  clearError();
  let stage = 'overview request';
  try {
    setConnection('', 'Loading graph');
    const result = await api('/api/overview');
    stage = 'overview merge';
    mergeGraph(result.data);
    updateProjectionStatus(result.projection);
    document.querySelector('#empty-state').hidden = result.data.nodes.length !== 0;
    stage = `render (${result.data.nodes.length} nodes, ${result.data.edges.length} edges)`;
    render();
    stage = 'fit';
    fitGraph();
    setConnection('is-connected', 'Connected');
  } catch (error) { showError(error, stage); }
}

function fitGraph() {
  const points = [...state.positions.values()];
  if (!points.length) return reportView('no positions');
  const box = svg.getBoundingClientRect();
  // A fit computed against an unmeasured element leaves the graph origin in the corner. Retry on
  // the next frame instead of committing a transform derived from a zero-sized viewport.
  if (box.width < 2 || box.height < 2) {
    reportView(`viewport ${Math.round(box.width)}x${Math.round(box.height)} unmeasured; retrying`);
    requestAnimationFrame(fitGraph);
    return;
  }
  const xs = points.map(point => point.x).filter(Number.isFinite);
  const ys = points.map(point => point.y).filter(Number.isFinite);
  if (xs.length !== points.length || ys.length !== points.length) {
    state.transform = { x: box.width / 2, y: box.height / 2, scale: 1 };
    applyTransform();
    return reportView(`non-finite layout for ${points.length - xs.length} of ${points.length} nodes`);
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = Math.max(220, maxX - minX + 120), height = Math.max(180, maxY - minY + 120);
  // The floor exists to keep a tiny graph from filling the canvas, not to crop a large one; it
  // must stay below the scale an estate-sized topology needs or the first view loses nodes.
  const scale = Math.min(1.15, Math.max(.06, Math.min(box.width / width, box.height / height)));
  state.transform = { x: box.width / 2 - ((minX + maxX) / 2) * scale,
    y: box.height / 2 - ((minY + maxY) / 2) * scale, scale };
  applyTransform();
  reportView(`box ${Math.round(box.width)}x${Math.round(box.height)} · span ${Math.round(width)}x${Math.round(height)} · scale ${scale.toFixed(2)}`);
}

// The transform decides whether anything is visible, so its inputs are reported rather than assumed.
function reportView(detail) {
  const element = document.querySelector('#view-status');
  if (element) {
    element.textContent = `${state.nodes.size} nodes · ${detail} · t(${Math.round(state.transform.x)},${Math.round(state.transform.y)})`;
  }
}

function applyTransform() {
  const { x, y, scale } = state.transform;
  if (![x, y, scale].every(Number.isFinite)) {
    state.transform = { x: 0, y: 0, scale: 1 };
    viewport.setAttribute('transform', 'translate(0 0) scale(1)');
    return reportView('non-finite transform reset');
  }
  viewport.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
}

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const term = searchInput.value.trim();
  if (!term) { searchResults.hidden = true; searchResults.replaceChildren(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const result = await api('/api/search', { term, limit: 30 });
      searchResults.replaceChildren();
      for (const node of result.data) {
        const fragment = resultTemplate.content.cloneNode(true);
        const button = fragment.querySelector('button');
        fragment.querySelector('.search-result-kind').textContent = node.kind;
        fragment.querySelector('strong').textContent = node.label;
        button.addEventListener('click', () => {
          searchResults.hidden = true; searchInput.value = node.label; selectNode(node.id);
        });
        searchResults.append(fragment);
      }
      searchResults.hidden = false;
    } catch (error) { showError(error); }
  }, 180);
});

document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== searchInput) { event.preventDefault(); searchInput.focus(); }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
  if (event.key === 'Escape') { searchResults.hidden = true; inspector.hidden = true; state.selectedId = null; render(); }
});
for (const button of document.querySelectorAll('.projection-button')) button.addEventListener('click', () => {
  state.view = button.dataset.view;
  for (const held of document.querySelectorAll('.projection-button')) held.classList.toggle('is-active', held === button);
  loadOverview();
});
for (const button of document.querySelectorAll('.expand-button')) button.addEventListener('click', () => {
  state.expand = button.dataset.expand;
  for (const held of document.querySelectorAll('.expand-button')) held.classList.toggle('is-active', held === button);
  if (state.selectedId) selectNode(state.selectedId, { push: false, focus: true });
});
document.querySelector('#reset-view').addEventListener('click', () => {
  state.positions.clear(); state.pinned.clear(); state.userAdjusted = false; render(); fitGraph();
});
document.querySelector('#go-back').addEventListener('click', goBack);
document.querySelector('#toggle-concepts').addEventListener('click', event => {
  const panel = document.querySelector('#concepts');
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-pressed', String(!panel.hidden));
  if (!panel.hidden) loadConcepts();
});
document.querySelector('#close-concepts').addEventListener('click', () => {
  document.querySelector('#concepts').hidden = true;
  document.querySelector('#toggle-concepts').setAttribute('aria-pressed', 'false');
});
window.addEventListener('popstate', event => {
  const depth = event.state?.depth ?? 0;
  if (depth < state.trail.length) walkTrailTo(depth);
});
document.querySelector('#close-inspector').addEventListener('click', () => { inspector.hidden = true; state.selectedId = null; render(); });
document.querySelector('#expand-node').addEventListener('click', () =>
  state.selectedId && selectNode(state.selectedId, { push: false, focus: false }));
document.querySelector('#trace-provenance').addEventListener('click', traceProvenance);
document.querySelector('#set-path-origin').addEventListener('click', setOrResolvePath);

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => { if (!state.userAdjusted) fitGraph(); }).observe(svg);
}
window.addEventListener('error', event => showError(event.error || new Error(event.message), 'script'));
window.addEventListener('unhandledrejection', event =>
  showError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), 'async'));

svg.addEventListener('wheel', event => {
  event.preventDefault();
  state.userAdjusted = true;
  const bounds = svg.getBoundingClientRect();
  const pointerX = event.clientX - bounds.left, pointerY = event.clientY - bounds.top;
  const nextScale = Math.min(3.2, Math.max(.18, state.transform.scale * Math.exp(-event.deltaY * .001)));
  const graphX = (pointerX - state.transform.x) / state.transform.scale;
  const graphY = (pointerY - state.transform.y) / state.transform.scale;
  state.transform.x = pointerX - graphX * nextScale;
  state.transform.y = pointerY - graphY * nextScale;
  state.transform.scale = nextScale;
  applyTransform();
}, { passive: false });
svg.addEventListener('pointerdown', event => {
  if (event.target.closest?.('.node')) return;
  state.userAdjusted = true;
  svg.setPointerCapture(event.pointerId);
  state.drag = { x: event.clientX, y: event.clientY, originX: state.transform.x, originY: state.transform.y };
});
svg.addEventListener('pointermove', event => {
  if (state.nodeDrag) return moveNodeDrag(event);
  if (!state.drag) return;
  state.transform.x = state.drag.originX + event.clientX - state.drag.x;
  state.transform.y = state.drag.originY + event.clientY - state.drag.y;
  applyTransform();
});
svg.addEventListener('pointerup', () => { endNodeDrag(); state.drag = null; });
svg.addEventListener('pointercancel', () => { endNodeDrag(); state.drag = null; });

renderTrail();
// Selections are pushed to the URL fragment; honour one on arrival so a node can be deep-linked.
const arrivalId = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null;
loadOverview().then(() => { if (arrivalId) return selectNode(arrivalId); });


// How many of one kind to draw before the rest stay folded. A fixed quota is a guess about a
// graph nobody has looked at yet; this makes it the reader's call, while the floor still keeps
// one kind from crowding out the others and the bundle still carries the true total.
const quotaInput = document.querySelector('#kind-quota');
const quotaValue = document.querySelector('#kind-quota-value');
if (quotaInput) {
  quotaInput.value = String(state.kindQuota);
  quotaValue.textContent = String(state.kindQuota);
  quotaInput.addEventListener('input', () => { quotaValue.textContent = quotaInput.value; });
  quotaInput.addEventListener('change', () => {
    state.kindQuota = Number(quotaInput.value);
    if (state.selectedId) selectNode(state.selectedId);
  });
}
