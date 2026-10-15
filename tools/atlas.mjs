#!/usr/bin/env node
// ESTATE ATLAS — the honest, evaluable estate map.
//
// WHY THIS EXISTS ALONGSIDE render.mjs. render.mjs is a PROGRESSIVE explorer: its
// landing projection aggregates the estate into <=80 drawn nodes (see
// DEFAULT_PROJECTION_LIMITS in render.mjs) and its whole-estate recipe bounds to
// MAX_BOUNDS.aggregateNodes=150 (projection.mjs). That is a deliberate legibility
// choice, and it is exactly the choice the operator refused: a view that quietly
// stops drawing nodes to stay fast cannot be used to JUDGE the estate, because you
// cannot tell a sparse estate from a truncated render.
//
// The atlas takes the opposite posture, on purpose:
//
//   1. DEFAULT VIEW IS EVERYTHING. The root frame draws every node the graph
//      carries. No cap, no sampling, no cluster-collapse, no lazy load. If that
//      makes the browser chug, it chugs — that is a true report about the estate.
//      Every performance affordance here is OPT-IN and starts OFF.
//   2. CONTAINMENT IS COMPUTED, NOT ASSERTED. Every node gets a total containment
//      path (domain -> repository -> kind). Descending into X shows exactly the
//      nodes whose path is prefixed by X's path, each carrying the attribution
//      string that JUSTIFIES its membership. Any node whose path does not extend
//      the frame path is drawn with a violation ring AND counted on screen.
//   3. CENSUS AT EVERY LEVEL. nodes / edges / orphans / components /
//      largest-component share are computed per frame from the induced subgraph
//      and rendered in the header of the level being viewed.
//   4. DETERMINISTIC SHAPE. Placement comes from layout.mjs (pure function of the
//      graph, no RNG, no physics), so a change in the picture is a change in the
//      estate.
//   5. NOTHING IS DROPPED SILENTLY. Edges whose endpoints the graph does not carry
//      are counted as `dangling`; edges leaving the frame are counted as
//      `boundary`; self-loops are counted separately. drawn + boundary + selfLoops
//      + dangling reconciles against the graph's own edge-record total, and the
//      reconciliation is printed and rendered.
//
// Read-only posture is inherited: this module writes through readonly-guard's
// guardedFs, so it can never write inside a registered scan root.

import guardedFs from './readonly-guard.mjs';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from './lib.mjs';
import { layoutBrowserSource } from './layout.mjs';
import { presentationRecordIndex, selectPresentation } from './presentation-records.mjs';

const require = createRequire(import.meta.url);
const CYTOSCAPE_SOURCE = fsSync
  .readFileSync(path.join(path.dirname(require.resolve('cytoscape')), 'cytoscape.min.js'), 'utf8')
  .replace(/<\/script/gi, '<\\/script');

const HELP = `Usage: node tools/estate-map/atlas.mjs <graph.json> [--out estate-atlas.html] [--census-json <path>]

Render the FULL estate atlas: every node in the graph, drawn by default, with
containment drill-down, per-level census, and deterministic structure-driven layout.

  <graph.json>        canonical (or annotated) estate graph
  --out <path>        output HTML (default: estate-atlas.html beside the graph)
  --census-json <p>   also write the machine-readable per-frame census
  --top <n>           how many domains to print a census for on stdout (default 10)`;

export const ATLAS_SCHEMA = 'estate-map/atlas/v1';

// The containment ladder. Each axis MUST be a TOTAL function node -> key: every
// node has a value at every axis (with an explicit "not recorded" key rather than
// a hole), which is what makes the frames a genuine PARTITION and therefore makes
// the containment guarantee checkable instead of aspirational.
export const CONTAINMENT_AXES = Object.freeze([
  Object.freeze({ id: 'domain', label: 'Domain' }),
  Object.freeze({ id: 'repository', label: 'Repository' }),
  Object.freeze({ id: 'kind', label: 'Kind' }),
]);

const FRAME_SEP = '\u241f';
export const frameId = keys => 'frame:' + keys.join(FRAME_SEP);
export const ROOT_FRAME = frameId([]);

const strings = values => [...new Set(values.filter(v => typeof v === 'string' && v.trim()))].sort();

/**
 * Domain membership, read from the SAME sources projection.mjs reads
 * (node.domain / node.domains, plus grounded `service_card` overlays), so the
 * atlas and the explorer cannot disagree about what a domain contains.
 * Returns Map<nodeId,{domain,attribution}> keeping the lexicographically first
 * domain when a node carries several — deterministic, and the multiplicity is
 * reported separately rather than silently collapsed.
 */
export function domainMembership(graph) {
  const byNode = new Map();
  const push = (nodeId, domain, attribution) => {
    if (!nodeId || !domain) return;
    const list = byNode.get(nodeId) || [];
    list.push({ domain, attribution });
    byNode.set(nodeId, list);
  };
  for (const node of graph.nodes || []) {
    const values = strings([...(Array.isArray(node.domains) ? node.domains : []), ...(typeof node.domain === 'string' ? [node.domain] : [])]);
    for (const domain of values) push(node.id, domain, 'canonical node.domain field');
  }
  for (const overlay of graph.overlays || []) {
    if (overlay.annotation_kind !== 'service_card') continue;
    const domain = typeof overlay.body?.domain === 'string' ? overlay.body.domain.trim() : '';
    if (!domain || !(overlay.grounded_in || []).length) continue;
    const witness = overlay.grounded_in[0];
    const where = witness && witness.file ? `${witness.file}:${witness.line ?? '?'}` : 'grounded overlay';
    push(overlay.subject, domain, `overlay ${overlay.annotation_kind} witnessed at ${where}`);
  }
  const result = new Map();
  for (const [nodeId, list] of byNode) {
    list.sort((a, b) => a.domain.localeCompare(b.domain));
    result.set(nodeId, { ...list[0], multiplicity: list.length, allDomains: strings(list.map(item => item.domain)) });
  }
  return result;
}

/** Derived structural group (directory-position overlay), used to LABEL an undomained node without claiming it is a domain. */
export function structuralMembership(graph) {
  const byNode = new Map();
  for (const overlay of graph.overlays || []) {
    if (overlay.annotation_kind !== 'structural_group') continue;
    const group = typeof overlay.body?.group === 'string' ? overlay.body.group.trim() : '';
    if (!group || !(overlay.grounded_in || []).length) continue;
    const witness = overlay.grounded_in[0];
    byNode.set(overlay.subject, {
      group,
      attribution: `derived structure · ${overlay.body?.rule || 'unknown rule'} · witnessed at ${witness?.file || 'overlay'}`,
    });
  }
  return byNode;
}

/**
 * The containment path of every node: one cell per axis, each with the key, the
 * human label, and the ATTRIBUTION — the sentence that justifies the node being
 * in that cell. The attribution is what makes requirement 2 checkable by eye:
 * the reader does not have to trust that a child belongs to the parent, they can
 * read the reason and the witness.
 */
export function containmentPaths(graph) {
  const presentation = presentationRecordIndex(graph);
  const domains = domainMembership(graph);
  const structural = structuralMembership(graph);
  const paths = new Map();
  for (const node of graph.nodes || []) {
    const membership = domains.get(node.id);
    const structure = structural.get(node.id);
    const domainRecord = selectPresentation(presentation, `atlas:${node.id}:domain`, 'label');
    const domainCell = membership
      ? { axis: 'domain', key: `domain:${membership.domain}`, label: domainRecord.value, attribution: membership.attribution, class: 'documented' }
      : structure
        ? { axis: 'domain', key: `structure:${structure.group}`, label: domainRecord.value, attribution: structure.attribution, class: 'derived' }
        : { axis: 'domain', key: 'domain:__undocumented__', label: domainRecord.value, attribution: domainRecord.reason, class: 'none' };
    const repo = node.repo || 'unknown repository';
    const kind = node.kind || 'evidence';
    const repoRecord = selectPresentation(presentation, `atlas:${node.id}:repository`, 'label');
    const kindRecord = selectPresentation(presentation, `atlas:${node.id}:kind`, 'label');
    paths.set(node.id, [
      domainCell,
      { axis: 'repository', key: `repo:${repo}`, label: repoRecord.value, attribution: node.repo ? `canonical node.repo = ${repo}` : repoRecord.reason, class: node.repo ? 'documented' : 'none' },
      { axis: 'kind', key: `kind:${kind}`, label: kindRecord.value, attribution: `canonical node.kind = ${kind}`, class: 'documented' },
    ]);
  }
  return paths;
}

/**
 * Expand the graph's edges into drawable records, one per (edge, resolved target)
 * pair, matching projection.mjs#rawEdgeRecords semantics. Edge endpoints the graph
 * does not carry are NOT dropped silently: they are returned as `dangling` and the
 * count is surfaced in the UI and on stdout.
 */
export function edgeRecords(graph) {
  const byId = new Set((graph.nodes || []).map(node => node.id));
  const drawn = [];
  const dangling = [];
  for (const [index, edge] of (graph.edges || []).entries()) {
    const canonicalId = edge.id || `edge:${index}`;
    const targets = edge.to ? [edge.to] : Array.isArray(edge.candidates) ? edge.candidates : [];
    if (!targets.length) {
      dangling.push({ canonicalId, from: edge.from, to: null, reason: 'edge carries no resolved target' });
      continue;
    }
    for (const target of targets) {
      if (!byId.has(edge.from) || !byId.has(target)) {
        dangling.push({ canonicalId, from: edge.from, to: target, reason: byId.has(edge.from) ? 'target node absent from graph' : 'source node absent from graph' });
        continue;
      }
      drawn.push({ id: `${canonicalId}::${target}`, canonicalId, source: edge.from, target, kind: edge.kind || 'relationship', status: edge.status || 'resolved' });
    }
  }
  drawn.sort((a, b) => a.id.localeCompare(b.id));
  dangling.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId) || String(a.to).localeCompare(String(b.to)));
  return { drawn, dangling };
}

/**
 * Census of one frame, computed on the subgraph INDUCED by the frame's members.
 * Every number the operator asked for, plus the reconciliation terms that prove
 * nothing vanished.
 */
// COUNT PROVENANCE (operator finding, 2026-07-27): a semantic-portability run caught the
// harness COUNTING REFUSALS AS KNOWLEDGE — a home entity family reported 403 where only 24
// were real entity types. Every number this file surfaces is therefore computed HERE from
// graph.nodes / graph.edges alone. The atlas reads NO `*_census`, `*_stats` or producer-
// supplied count field, so it cannot inherit an inflated total from a producer. Asserted by
// `atlas counts ignore producer-supplied census blocks` in test/tools/estateMapAtlas.test.mjs.
export function censusFor(memberIds, records) {
  const members = new Set(memberIds);
  const adjacency = new Map(memberIds.map(id => [id, new Set()]));
  let internal = 0;
  let boundary = 0;
  let selfLoops = 0;
  for (const record of records) {
    const hasSource = members.has(record.source);
    const hasTarget = members.has(record.target);
    if (!hasSource && !hasTarget) continue;
    if (hasSource && hasTarget) {
      if (record.source === record.target) { selfLoops++; continue; }
      internal++;
      adjacency.get(record.source).add(record.target);
      adjacency.get(record.target).add(record.source);
    } else {
      boundary++;
    }
  }
  // Components over the induced UNDIRECTED subgraph. Deterministic: seeds walk
  // memberIds in the caller's (sorted) order and neighbours are visited sorted.
  const seen = new Set();
  const sizes = [];
  let orphans = 0;
  for (const id of memberIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const queue = [id];
    let size = 0;
    while (queue.length) {
      const current = queue.shift();
      size++;
      for (const other of [...adjacency.get(current)].sort()) if (!seen.has(other)) { seen.add(other); queue.push(other); }
    }
    sizes.push(size);
    if (size === 1 && adjacency.get(id).size === 0) orphans++;
  }
  sizes.sort((a, b) => b - a);
  const nodes = memberIds.length;
  const largest = sizes[0] || 0;
  return {
    nodes,
    edges: internal,
    selfLoops,
    boundaryEdges: boundary,
    orphans,
    components: sizes.length,
    largestComponent: largest,
    largestComponentShare: nodes ? largest / nodes : 0,
    orphanShare: nodes ? orphans / nodes : 0,
  };
}

/**
 * The whole atlas model: every node, every edge record, the containment paths, and
 * a census for EVERY frame in the ladder (root, each domain, each domain/repo, each
 * domain/repo/kind). Precomputing the census in Node rather than in the browser is
 * deliberate: the numbers the operator reads on screen are then BYTE-IDENTICAL to
 * the numbers in the regeneration report, so the report cannot drift from the view.
 */
export function buildAtlas(graph) {
  const presentation = presentationRecordIndex(graph);
  const paths = containmentPaths(graph);
  const { drawn, dangling } = edgeRecords(graph);
  const nodes = (graph.nodes || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const prepassReceipts = graph.domain_prepass_receipts || [];
  const prepassBySubject = new Map(prepassReceipts.map(receipt => [receipt.subject, receipt]));
  if (Array.isArray(graph.domain_prepass_receipts)) {
    for (const node of nodes) if (!domainMembership(graph).has(node.id) && !prepassBySubject.has(node.id)) throw new Error(`missing persisted domain-prepass receipt for undomained node: ${node.id}`);
  }
  const frames = new Map();
  const ensure = keys => {
    const id = frameId(keys);
    if (!frames.has(id)) {
      frames.set(id, { id, depth: keys.length, keys: keys.slice(), memberIds: [], childIds: new Set(), label: null, axis: CONTAINMENT_AXES[keys.length]?.id || null });
    }
    return frames.get(id);
  };
  const root = ensure([]);
  root.label = 'Whole estate';
  for (const node of nodes) {
    const cells = paths.get(node.id) || [];
    root.memberIds.push(node.id);
    const keys = [];
    for (const cell of cells) {
      const parent = ensure(keys.slice());
      keys.push(cell.key);
      const frame = ensure(keys.slice());
      frame.label = frame.label || cell.label;
      frame.cellClass = frame.cellClass || cell.class;
      parent.childIds.add(frame.id);
      frame.memberIds.push(node.id);
    }
  }
  const ordered = [...frames.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  for (const frame of ordered) {
    frame.memberIds.sort();
    frame.childIds = [...frame.childIds].sort();
    frame.census = censusFor(frame.memberIds, drawn);
    frame.parentId = frame.depth ? frameId(frame.keys.slice(0, -1)) : null;
  }
  const totals = {
    graphNodes: (graph.nodes || []).length,
    graphEdges: (graph.edges || []).length,
    edgeRecords: drawn.length,
    danglingEdgeRecords: dangling.length,
    frames: ordered.length,
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    domainPrepass: Object.fromEntries(['assigned', 'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only'].map(status => [status, prepassReceipts.filter(receipt => receipt.status === status).length])),
    // The renderer draws every node. If this is ever nonzero the UI says so out loud.
    nodesOmitted: (graph.nodes || []).length - root.memberIds.length,
  };
  return {
    schema: ATLAS_SCHEMA,
    axes: CONTAINMENT_AXES,
    nodes: nodes.map(node => ({
      id: node.id,
      name: selectPresentation(presentation, `node:${node.id}`, 'label').value,
      kind: node.kind || 'evidence',
      repo: node.repo || null,
      path: (paths.get(node.id) || []).map(cell => cell.key),
      why: (paths.get(node.id) || []).map(cell => cell.attribution),
      witness: (node.witnesses || [])[0] ? `${(node.witnesses || [])[0].file}:${(node.witnesses || [])[0].line}` : null,
      domain_prepass: prepassBySubject.get(node.id) || null,
    })),
    edges: drawn,
    dangling,
    frames: ordered.map(({ childIds, ...frame }) => ({ ...frame, childIds })),
    totals,
  };
}

/**
 * Containment audit: for every frame, assert every member's path extends the frame
 * path. Returned as DATA (not thrown) so the UI can render a violation count and a
 * violation ring rather than the renderer deciding to hide the problem.
 */
export function containmentViolations(atlas) {
  const byId = new Map(atlas.nodes.map(node => [node.id, node]));
  const violations = [];
  for (const frame of atlas.frames) {
    for (const id of frame.memberIds) {
      const node = byId.get(id);
      const prefix = (node?.path || []).slice(0, frame.depth);
      if (prefix.length !== frame.depth || prefix.some((key, index) => key !== frame.keys[index])) {
        violations.push({ frameId: frame.id, nodeId: id, framePath: frame.keys, nodePath: node?.path || [] });
      }
    }
  }
  return violations;
}

const island = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderAtlas(graph) {
  const atlas = buildAtlas(graph);
  const violations = containmentViolations(atlas);
  const payload = island({ ...atlas, violations });
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estate Atlas</title><style>
:root{color-scheme:dark;--bg:#080f17;--panel:#0f1823;--panel2:#152232;--line:#31465c;--text:#eef5fc;--muted:#9fb3ca;--accent:#54c7ec;--warn:#f59e0b;--bad:#f43f5e;--ok:#4ade80}
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.04em;color:var(--accent)}
button{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}button[disabled]{opacity:.4;cursor:default}
.crumb{background:transparent;border:none;color:var(--accent);padding:2px 4px}
.crumb[aria-current="true"]{color:var(--text);font-weight:600}
.census{display:flex;gap:0;flex-wrap:wrap;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.cell{padding:5px 12px;border-right:1px solid var(--line);min-width:104px}
.cell:last-child{border-right:none}
.cell b{display:block;font-size:16px;line-height:1.2}
.cell span{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.cell.bad b{color:var(--bad)}.cell.warn b{color:var(--warn)}.cell.ok b{color:var(--ok)}
main{flex:1;display:flex;min-height:0}
#cy{flex:1;min-width:0;background:var(--bg)}
aside{width:390px;border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:10px 12px}
aside h2{font-size:13px;margin:0 0 2px}aside h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 6px}
.sub{color:var(--muted);font-size:11.5px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:11.5px}
th,td{text-align:left;padding:3px 5px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}
td.why{color:var(--muted)}
tr.violation td{background:rgba(244,63,94,.16)}
.pill{display:inline-block;padding:1px 6px;border-radius:99px;border:1px solid var(--line);font-size:10.5px;color:var(--muted)}
.pill.documented{border-color:var(--accent);color:var(--accent)}
.pill.derived{border-color:#a78bfa;color:#a78bfa}
.pill.none{border-color:var(--warn);color:var(--warn)}
.note{border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:4px;padding:6px 8px;color:var(--muted);font-size:11.5px;margin:8px 0}
.note.bad{border-left-color:var(--bad)}
label.toggle{display:inline-flex;gap:5px;align-items:center;color:var(--muted);font-size:11.5px}
#hint{color:var(--accent);font-size:11.5px;border:1px dashed var(--accent);border-radius:6px;padding:3px 9px}
#search{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 9px;font:inherit;min-width:230px}
#searchResults{position:absolute;top:100%;left:0;z-index:9;background:var(--panel2);border:1px solid var(--line);border-radius:6px;max-height:320px;overflow:auto;min-width:420px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#searchResults button{display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--line);border-radius:0;background:transparent;font-size:11.5px}
#searchResults button:hover{background:#1d3348}
#searchResults .sr-why{color:var(--muted);font-size:10.5px}
.hidden{display:none}
.viewlink{background:var(--panel2);color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:4px 9px;text-decoration:none}
</style></head><body>
<header>
  <div class="row"><strong class="brand">ESTATE ATLAS</strong><nav id="crumbs" class="row" aria-label="Containment path"></nav>
    <button id="up">Ascend</button><button id="fit">Fit</button>
    <span id="hint">Double-click any node or group box to descend into it · Ascend or click a breadcrumb to come back</span>
    <span style="flex:1"></span>
    <div style="position:relative"><input id="search" type="search" placeholder="Find a node and jump to it (/)" aria-label="Find a node" autocomplete="off"><div id="searchResults" class="hidden" role="listbox"></div></div>
    <label class="toggle"><input type="checkbox" id="perfEdges"> opt-in: hide edges (perf)</label>
    <label class="toggle"><input type="checkbox" id="perfLabels"> opt-in: hide labels (perf)</label>
  </div>
  <div class="census" id="census"></div>
  <div class="row" id="reconcile" style="color:var(--muted);font-size:11px"></div>
</header>
<main><div id="cy"></div><aside id="panel"></aside></main>
<script id="atlas-data" type="application/json">${payload}</script>
<script>${CYTOSCAPE_SOURCE}</script>
<script>
(function(){'use strict';
${layoutBrowserSource()}
var atlas=JSON.parse(document.getElementById('atlas-data').textContent);
var byId=new Map(atlas.nodes.map(function(n){return [n.id,n];}));
var frames=new Map(atlas.frames.map(function(f){return [f.id,f];}));
var violationsByFrame=new Map();
atlas.violations.forEach(function(v){var list=violationsByFrame.get(v.frameId)||[];list.push(v);violationsByFrame.set(v.frameId,list);});
var $=function(id){return document.getElementById(id);};
var FRAME_SEP='\u241f';
var frameId=function(keys){return 'frame:'+keys.join(FRAME_SEP);};
var state={frameId:atlas.frames[0].id,selected:null,hideEdges:false,hideLabels:false};
var cy=null;

function frame(){return frames.get(state.frameId);}
function text(tag,value,cls){var el=document.createElement(tag);if(cls)el.className=cls;el.textContent=value==null?'—':String(value);return el;}
function pct(value){return (value*100).toFixed(1)+'%';}

// Members of a frame are drawn as LEAVES; the next axis becomes the compound
// PARENT box. A child physically inside its parent's box IS the containment
// guarantee, rendered rather than asserted.
function groupKeyOf(node,depth){return node.path[depth]||null;}

function inFrameEdges(members){
  var set=new Set(members),out=[];
  for(var i=0;i<atlas.edges.length;i++){var e=atlas.edges[i];if(set.has(e.source)&&set.has(e.target))out.push({id:e.id,source:e.source,target:e.target,kind:e.kind,status:e.status});}
  return out;
}

function elements(){
  var f=frame(),members=f.memberIds,depth=f.depth;
  var parents=new Map();
  members.forEach(function(id){
    var key=groupKeyOf(byId.get(id),depth);
    if(!key)return;
    if(!parents.has(key))parents.set(key,[]);
    parents.get(key).push(id);
  });
  var edges=inFrameEdges(members);
  var split=splitSelfLoops(edges.map(function(e){return{source:e.source,target:e.target,count:1};}));
  var drawnEdges=edges.filter(function(e){return e.source!==e.target;});

  // Derive wrap width from packed area so a fixed narrow column cannot force
  // fit() to shrink a wide group into an unreadable view.
  var order=[...parents.keys()].sort(function(a,b){
    var d=parents.get(b).length-parents.get(a).length;return d||a.localeCompare(b);
  });
  // layout.mjs reserves ~190 units of arc per node so that 150x68 aggregate boxes
  // do not collide. Atlas leaves are 34-unit dots, so the raw spacing is ~6x wider
  // than it needs to be and fit() shrinks every node below one pixel on a
  // whole-estate render. Scaling the layout output preserves the SHAPE exactly
  // (a uniform scale is still a pure function of the graph, still deterministic)
  // while making the dots visible at fit.
  var POS_SCALE=0.35;
  var GAP=260,boxes=[],area=0,widest=0;
  order.forEach(function(key){
    var ids=parents.get(key).slice().sort();
    var idSet=new Set(ids);
    var localEdges=drawnEdges.filter(function(e){return idSet.has(e.source)&&idSet.has(e.target);})
      .map(function(e){return{source:e.source,target:e.target};});
    var local=computeTopologyLayout(ids.map(function(id){return{id:id};}),localEdges);
    var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    local.forEach(function(p,id){p.x*=POS_SCALE;p.y*=POS_SCALE;local.set(id,p);});
    local.forEach(function(p){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
    if(!isFinite(minX)){minX=0;maxX=0;minY=0;maxY=0;}
    var w=(maxX-minX)+GAP,h=(maxY-minY)+GAP;
    boxes.push({key:key,local:local,minX:minX,minY:minY,w:w,h:h});
    area+=w*h;widest=Math.max(widest,w);
  });
  // 1.7:1 landscape target — screens are wide and the inspector owns the right
  // third, the same reasoning layout.mjs applies to its rings.
  var WRAP=Math.max(widest,Math.sqrt(area*1.7));
  var positions=new Map(),cursorX=0,cursorY=0,rowHeight=0;
  boxes.forEach(function(box){
    if(cursorX>0&&cursorX+box.w>WRAP){cursorX=0;cursorY+=rowHeight;rowHeight=0;}
    var ox=cursorX-box.minX+GAP/2,oy=cursorY-box.minY+GAP/2;
    box.local.forEach(function(p,id){positions.set(id,{x:p.x+ox,y:p.y+oy});});
    cursorX+=box.w;rowHeight=Math.max(rowHeight,box.h);
  });

  var els=[];
  var childFrameOf=new Map();
  f.childIds.forEach(function(cid){var cf=frames.get(cid);childFrameOf.set(cf.keys[depth],cf);});
  order.forEach(function(key){
    var cf=childFrameOf.get(key);
    els.push({group:'nodes',data:{id:'group:'+key,label:(cf?cf.label:key)+'  ·  '+parents.get(key).length+' nodes',isGroup:1,frameId:cf?cf.id:null,cellClass:cf?(cf.cellClass||'documented'):'none'}});
  });
  var violating=new Set((violationsByFrame.get(f.id)||[]).map(function(v){return v.nodeId;}));
  members.forEach(function(id){
    var node=byId.get(id),key=groupKeyOf(node,depth),pos=positions.get(id)||{x:0,y:0};
    els.push({group:'nodes',position:{x:pos.x,y:pos.y},data:{
      id:id,parent:key?'group:'+key:undefined,label:node.name,kind:node.kind,
      violation:violating.has(id)?1:0,childFrame:key&&childFrameOf.get(key)?childFrameOf.get(key).id:null}});
  });
  if(!state.hideEdges)drawnEdges.forEach(function(e){els.push({group:'edges',data:{id:e.id,source:e.source,target:e.target,kind:e.kind,status:e.status}});});
  return {els:els,selfLoops:split.selfLoops,drawn:drawnEdges.length};
}

function styles(){
  return [
    {selector:'node',style:{shape:'ellipse',width:34,height:34,'background-color':'#1d3348','border-color':'#7ba0bd','border-width':2,label:'data(label)','font-size':17,color:'#cfe0f0','text-valign':'bottom','text-margin-y':5,'text-max-width':260,'text-wrap':'ellipsis','min-zoomed-font-size':7}},
    {selector:'node[?isGroup]',style:{shape:'round-rectangle','background-color':'#0d1a26','background-opacity':.65,'border-color':'#3d6a8c','border-width':3,label:'data(label)','font-size':58,color:'#9ed6ef','text-valign':'top','text-halign':'center','text-margin-y':-14,padding:'50px','text-max-width':2400,'min-zoomed-font-size':9}},
    {selector:'node[cellClass="derived"]',style:{'border-color':'#a78bfa','border-style':'dashed'}},
    {selector:'node[cellClass="none"]',style:{'border-color':'#f59e0b','border-style':'dotted'}},
    // A CONTAINMENT VIOLATION cannot be quietly rendered: thick rose ring, and it
    // is counted in the census bar as well.
    {selector:'node[violation=1]',style:{'border-color':'#f43f5e','border-width':10,shape:'diamond',width:64,height:64}},
    {selector:'node:selected',style:{'border-color':'#facc15','border-width':8}},
    {selector:'edge',style:{width:2,'line-color':'#3a5468','target-arrow-color':'#3a5468','target-arrow-shape':'triangle','arrow-scale':.55,'curve-style':'straight','opacity':.55}},
    {selector:'edge[kind="consumes"]',style:{'line-color':'#f472b6','target-arrow-color':'#f472b6'}},
    {selector:'edge[kind="emits"]',style:{'line-color':'#22d3ee','target-arrow-color':'#22d3ee'}},
    {selector:'edge[kind="imports"]',style:{'line-color':'#4a6b86','target-arrow-color':'#4a6b86'}},
    {selector:'.labels-off',style:{label:''}},
  ];
}

function renderCensus(built){
  var f=frame(),c=f.census,host=$('census');host.textContent='';
  var vcount=(violationsByFrame.get(f.id)||[]).length;
  var cells=[
    ['NODES',c.nodes.toLocaleString(),''],
    ['EDGES',c.edges.toLocaleString(),''],
    ['ORPHANS',c.orphans.toLocaleString()+'  ('+pct(c.orphanShare)+')',c.orphans?'warn':'ok'],
    ['LARGEST COMPONENT',c.largestComponent.toLocaleString()+'  ('+pct(c.largestComponentShare)+')',c.largestComponentShare>=.5?'ok':'warn'],
    ['COMPONENTS',c.components.toLocaleString(),''],
    ['SELF-LOOPS',c.selfLoops.toLocaleString(),''],
    ['LEAVING THIS LEVEL',c.boundaryEdges.toLocaleString(),''],
    ['CONTAINMENT VIOLATIONS',String(vcount),vcount?'bad':'ok'],
  ];
  cells.forEach(function(row){
    var cell=document.createElement('div');cell.className='cell '+row[2];
    cell.dataset.census=row[0];
    cell.append(text('b',row[1]),text('span',row[0]));
    host.append(cell);
  });
  var drawnNodes=cy?cy.nodes('[!isGroup]').length:f.memberIds.length;
  var omitted=f.memberIds.length-drawnNodes;
  var recon=$('reconcile');recon.textContent='';
  recon.append(text('span','Drawn '+drawnNodes.toLocaleString()+' of '+f.memberIds.length.toLocaleString()+' member nodes · omitted '+omitted.toLocaleString()
    +'  |  edge records in graph '+atlas.totals.edgeRecords.toLocaleString()
    +' = internal '+c.edges.toLocaleString()+' + self-loop '+c.selfLoops.toLocaleString()+' + leaving '+c.boundaryEdges.toLocaleString()
    +' + outside this level '+(atlas.totals.edgeRecords-c.edges-c.selfLoops-c.boundaryEdges).toLocaleString()
    +'  |  dangling edge records (endpoint absent from graph) '+atlas.totals.danglingEdgeRecords.toLocaleString()
    +(state.hideEdges?'  |  EDGES HIDDEN by opt-in perf toggle — counts above are unaffected':'')));
  recon.dataset.omitted=String(omitted);
}

function renderPanel(){
  var f=frame(),panel=$('panel');panel.textContent='';
  panel.append(text('h2',f.label||'Whole estate'));
  panel.append(text('p',f.depth?('Containment frame at depth '+f.depth+' · axis '+(atlas.axes[f.depth]?atlas.axes[f.depth].label:'leaf')):'Root frame · every node in the graph is drawn','sub'));
  if(atlas.totals.nodesOmitted)panel.append(text('div','MODEL OMISSION: '+atlas.totals.nodesOmitted+' graph nodes are missing from the atlas root frame.','note bad'));
  if(atlas.totals.danglingEdgeRecords)panel.append(text('div',atlas.totals.danglingEdgeRecords+' edge records reference a node the graph does not carry. They are counted, never drawn, and never silently discarded.','note'));
  var vlist=violationsByFrame.get(f.id)||[];
  if(vlist.length)panel.append(text('div','CONTAINMENT VIOLATION: '+vlist.length+' member(s) of this frame do not carry a path that extends it. They are drawn as rose diamonds.','note bad'));

  if(state.selected){
    var node=byId.get(state.selected);
    panel.append(text('h3','Selected'));
    panel.append(text('div',node.name));
    panel.append(text('p',node.id,'sub'));
    panel.append(text('h3','Why this node is here — containment chain'));
    var t=document.createElement('table');
    var head=document.createElement('tr');['Axis','Cell','Justification'].forEach(function(h){head.append(text('th',h));});t.append(head);
    node.path.forEach(function(key,i){
      var tr=document.createElement('tr');
      tr.append(text('td',atlas.axes[i].label),text('td',(frames.get(frameId(node.path.slice(0,i+1)))||{}).label||key),text('td',node.why[i],'why'));
      t.append(tr);
    });
    panel.append(t);
    if(node.witness)panel.append(text('p','witness · '+node.witness,'sub'));
  }

  panel.append(text('h3','Children of this frame ('+f.childIds.length+')'));
  if(!f.childIds.length)panel.append(text('p','Leaf frame — the next axis is the node itself.','sub'));
  else{
    var ct=document.createElement('table');
    var chead=document.createElement('tr');['Child','Nodes','Edges','Orphans','Largest'].forEach(function(h){chead.append(text('th',h));});ct.append(chead);
    f.childIds.map(function(id){return frames.get(id);}).sort(function(a,b){return b.census.nodes-a.census.nodes||a.id.localeCompare(b.id);}).forEach(function(cf){
      var tr=document.createElement('tr');tr.dataset.childFrame=cf.id;
      var cell=document.createElement('td');
      var btn=document.createElement('button');btn.className='crumb';btn.textContent=cf.label;btn.onclick=function(){descend(cf.id);};
      var pill=text('span',cf.cellClass==='documented'?'documented':cf.cellClass==='derived'?'derived structure':'not recorded','pill '+(cf.cellClass||'none'));
      cell.append(btn,document.createElement('br'),pill);
      tr.append(cell,text('td',cf.census.nodes),text('td',cf.census.edges),text('td',cf.census.orphans),text('td',pct(cf.census.largestComponentShare)));
      ct.append(tr);
    });
    panel.append(ct);
  }

  panel.append(text('h3','Members of this frame ('+f.memberIds.length+')'));
  panel.append(text('p','Every row below is drawn on the canvas. The justification column is the containment proof: it names the field or witnessed overlay that puts the node in this frame.','sub'));
  var mt=document.createElement('table');mt.dataset.members=f.id;
  var mhead=document.createElement('tr');['Node','Kind','Justification at this level'].forEach(function(h){mhead.append(text('th',h));});mt.append(mhead);
  var vset=new Set(vlist.map(function(v){return v.nodeId;}));
  f.memberIds.forEach(function(id){
    var node=byId.get(id),tr=document.createElement('tr');
    if(vset.has(id))tr.className='violation';
    tr.dataset.member=id;
    var justify=f.depth?node.why[f.depth-1]:node.why[0];
    tr.append(text('td',node.name),text('td',node.kind),text('td',justify,'why'));
    tr.onclick=function(){state.selected=id;if(cy){cy.elements().unselect();cy.getElementById(id).select();}renderPanel();};
    mt.append(tr);
  });
  panel.append(mt);
}

function renderCrumbs(){
  var host=$('crumbs');host.textContent='';
  var f=frame(),keys=[];
  var chain=[frames.get(frameId([]))];
  f.keys.forEach(function(key){keys.push(key);chain.push(frames.get(frameId(keys.slice())));});
  chain.forEach(function(node,i){
    if(!node)return;
    var b=document.createElement('button');b.className='crumb';b.textContent=node.label||'Whole estate';
    b.setAttribute('aria-current',String(i===chain.length-1));
    b.dataset.crumb=node.id;
    b.onclick=function(){state.frameId=node.id;state.selected=null;draw();};
    host.append(b);
    if(i<chain.length-1)host.append(text('span','›'));
  });
  $('up').disabled=!f.parentId;
}

function descend(id){if(!id||!frames.has(id))return;state.frameId=id;state.selected=null;draw();}

function draw(){
  var built=elements();
  if(cy)cy.destroy();
  cy=cytoscape({container:$('cy'),elements:built.els,style:styles(),layout:{name:'preset',fit:true,padding:60},
    wheelSensitivity:.2,textureOnViewport:true,pixelRatio:1,motionBlur:false});
  cy.on('tap','node',function(evt){var d=evt.target.data();if(d.isGroup)return;state.selected=d.id;renderPanel();});
  cy.on('dbltap','node',function(evt){
    var d=evt.target.data();
    descend(d.isGroup?d.frameId:d.childFrame);
  });
  if(state.hideLabels)cy.nodes('[!isGroup]').addClass('labels-off');
  renderCrumbs();renderCensus(built);renderPanel();
  // The drill gesture is not guessable, so it is stated permanently rather than
  // as a dismissable toast, and it names what is actually clickable HERE.
  $('hint').textContent=frame().childIds.length
    ? 'Double-click any node or group box to descend · Ascend or a breadcrumb comes back'
    : 'Deepest level — Ascend or a breadcrumb comes back';
}

function runSearch(){
  var query=$('search').value.trim().toLowerCase(),host=$('searchResults');
  host.textContent='';
  if(query.length<2){host.classList.add('hidden');return;}
  var hits=[];
  for(var i=0;i<atlas.nodes.length&&hits.length<40;i++){
    var node=atlas.nodes[i];
    if(node.name.toLowerCase().indexOf(query)>=0||node.id.toLowerCase().indexOf(query)>=0)hits.push(node);
  }
  if(!hits.length){
    var none=text('div','No node matches. The atlas searches the WHOLE graph, so no match means the graph does not carry it.','sr-why');
    none.style.padding='7px 9px';host.append(none);host.classList.remove('hidden');return;
  }
  hits.forEach(function(node){
    var b=document.createElement('button');
    var chain=node.path.map(function(key){var f=frames.get(frameId(node.path.slice(0,node.path.indexOf(key)+1)));return f?f.label:key;});
    b.append(text('div',node.name));
    b.append(text('div',chain.join('  ›  '),'sr-why'));
    b.onclick=function(){
      // Descend to the node's deepest frame, then select it.
      state.frameId=frameId(node.path.slice(0,atlas.axes.length-1));
      state.selected=node.id;
      $('search').value='';host.classList.add('hidden');
      draw();
      if(cy){cy.elements().unselect();var el=cy.getElementById(node.id);if(el.length){el.select();cy.center(el);}}
      renderPanel();
    };
    host.append(b);
  });
  host.classList.remove('hidden');
}
$('search').oninput=runSearch;
document.addEventListener('keydown',function(e){
  if(e.key==='/'&&document.activeElement!==$('search')){e.preventDefault();$('search').focus();}
  if(e.key==='Escape'){$('searchResults').classList.add('hidden');}
});

$('up').onclick=function(){var f=frame();if(f.parentId)descend(f.parentId);};
$('fit').onclick=function(){if(cy)cy.fit(undefined,60);};
$('perfEdges').onchange=function(){state.hideEdges=this.checked;draw();};
$('perfLabels').onchange=function(){state.hideLabels=this.checked;draw();};

// Automation handle: the canvas has no DOM nodes, so a spec needs the same entry
// points a human uses. Everything exposed here reads state already embedded in the
// page's JSON island.
window.__estateAtlas={get cy(){return cy;},get state(){return state;},atlas:atlas,descend:descend,frameCensus:function(id){return frames.get(id).census;}};
draw();
})();
</script></body></html>`;
}

/** Human-readable census lines, identical to what the UI renders (same source numbers). */
export function censusLines(atlas, { top = 10 } = {}) {
  const lines = [];
  const root = atlas.frames.find(frame => frame.depth === 0);
  const fmt = (frame, indent) => {
    const c = frame.census;
    const share = value => `${(value * 100).toFixed(1)}%`;
    return `${' '.repeat(indent)}${(frame.label || 'Whole estate').padEnd(42 - indent)} nodes=${String(c.nodes).padStart(6)} edges=${String(c.edges).padStart(6)} orphans=${String(c.orphans).padStart(5)} (${share(c.orphanShare).padStart(6)}) components=${String(c.components).padStart(5)} largest=${share(c.largestComponentShare).padStart(6)} leaving=${String(c.boundaryEdges).padStart(6)}`;
  };
  lines.push(fmt(root, 0));
  const byId = new Map(atlas.frames.map(frame => [frame.id, frame]));
  const domains = root.childIds.map(id => byId.get(id)).sort((a, b) => b.census.nodes - a.census.nodes || a.id.localeCompare(b.id));
  for (const domain of domains.slice(0, top)) {
    lines.push(fmt(domain, 2));
    const repos = domain.childIds.map(id => byId.get(id)).sort((a, b) => b.census.nodes - a.census.nodes || a.id.localeCompare(b.id));
    for (const repo of repos.slice(0, 5)) lines.push(fmt(repo, 4));
    if (repos.length > 5) lines.push(`      … ${repos.length - 5} more repository frames (all present in the artifact)`);
  }
  if (domains.length > top) lines.push(`  … ${domains.length - top} more domain frames (all present in the artifact)`);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  const graphFile = path.resolve(positional[0]);
  const outFile = path.resolve(options.out || path.join(path.dirname(graphFile), 'estate-atlas.html'));
  try {
    const graph = JSON.parse(await guardedFs.readFile(graphFile, 'utf8'));
    const atlas = buildAtlas(graph);
    const violations = containmentViolations(atlas);
    await guardedFs.mkdir(path.dirname(outFile), { recursive: true });
    await guardedFs.writeFile(outFile, renderAtlas(graph), 'utf8');
    if (options['census-json']) {
      const censusPath = path.resolve(options['census-json']);
      await guardedFs.mkdir(path.dirname(censusPath), { recursive: true });
      await guardedFs.writeFile(censusPath, JSON.stringify({ schema: ATLAS_SCHEMA, totals: atlas.totals, violations, frames: atlas.frames.map(({ memberIds, ...rest }) => ({ ...rest, memberCount: memberIds.length })) }, null, 2), 'utf8');
      console.log(`census json      ${censusPath}`);
    }
    console.log('');
    console.log('ESTATE ATLAS · census by containment level');
    console.log(''.padEnd(150, '─'));
    for (const line of censusLines(atlas, { top: Number(options.top) || 10 })) console.log(line);
    console.log(''.padEnd(150, '─'));
    console.log(`graph nodes ${atlas.totals.graphNodes} · drawn in root frame ${atlas.totals.graphNodes - atlas.totals.nodesOmitted} · omitted ${atlas.totals.nodesOmitted}`);
    console.log(`edge records ${atlas.totals.edgeRecords} · dangling (endpoint absent from graph) ${atlas.totals.danglingEdgeRecords}`);
    console.log(`frames ${atlas.totals.frames} · containment violations ${violations.length}`);
    console.log('');
    console.log(`ATLAS  ${outFile}`);
    if (violations.length) process.exitCode = 4;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
