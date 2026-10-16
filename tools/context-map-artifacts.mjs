#!/usr/bin/env node
// Build one inspectable graph plus a paired interactive D3 visualization from every calibration.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepassDocument } from './source-prepass.mjs';
import { inventoryIndex } from './recursive-contracts.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const CONTEXT_MAP_SCHEMA = 'estate-map/context-map/v1';
const canonical = value => stableStringify(value).trim();
const idFor = (prefix, body) => `${prefix}:${sha256(canonical(body))}`;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const D3_SOURCE = readFileSync(new URL('./vendor/d3.v7.9.0.min.js', import.meta.url), 'utf8')
  .replace(/<\/script/gi, '<\\/script');

const atomicWrite = async (file, value) => {
  const absolute = path.resolve(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await fs.writeFile(temporary, value, 'utf8');
  await fs.rename(temporary, absolute);
  return absolute;
};

function rawProposalPackets(calibration) {
  const records = calibration.custody?.checkpoint_records || [];
  const stage = calibration.linker_version
    ? 'context-relation-linking-completion'
    : calibration.reconciliation_version === 'context-atomic-reconciliation@1'
      ? 'context-atomic-reconciliation-completion'
      : 'context-reconciliation-completion';
  return records.filter(record => record.stage === stage).map(record => ({
    relations: Array.isArray(record?.value?.result?.json?.relations) ? record.value.result.json.relations : [],
    links: Array.isArray(record?.value?.result?.json?.links) ? record.value.result.json.links : [],
  }));
}

/** Build a deterministic inspection graph whether calibration passed or failed. */
export async function buildContextMap({ calibration, estate }) {
  if (!calibration?.source_document || !calibration?.snapshot?.source_sha) throw new Error('calibration lacks source_document/snapshot');
  const sourcePath = path.join(estate, calibration.source_document);
  const content = await fs.readFile(sourcePath, 'utf8');
  const actualCorpusDigest = sha256(canonical([{ path: calibration.source_document, digest: sha256(content) }]));
  if (actualCorpusDigest !== calibration.snapshot.corpus_digest) throw new Error(`CALIBRATION_SOURCE_MISMATCH: ${actualCorpusDigest} != ${calibration.snapshot.corpus_digest}`);
  const prepass = prepassDocument({ path: calibration.source_document, content, ...calibration.snapshot });
  const index = inventoryIndex([prepass.inventory]);
  const nodes = new Map(), edges = new Map();
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return node.id; };
  const addEdge = body => {
    const edge = { ...body, id: idFor('map-edge', body) };
    edges.set(edge.id, edge);
    return edge.id;
  };

  const documentId = idFor('map-document', { path: calibration.source_document, snapshot: calibration.snapshot });
  addNode({ id: documentId, kind: 'source_document', label: path.basename(calibration.source_document), path: calibration.source_document,
    authority_plane: 'source', source_sha: calibration.snapshot.source_sha, source_digest: sha256(content) });
  const addEvidenceSpan = (locator, parentId, edgeKind) => {
    const spanBody = { file: locator.file, start: locator.start, end: locator.end, byte_start: locator.byte_start,
      byte_end: locator.byte_end, text_digest: locator.text_digest };
    const spanId = idFor('map-evidence-span', spanBody);
    addNode({ id: spanId, kind: 'evidence_span', label: `${path.basename(locator.file || '')}:${locator.start}-${locator.end}`,
      authority_plane: 'source', source_excerpt: locator.text, ...spanBody });
    addEdge({ kind: edgeKind, from: parentId, to: spanId, authority_plane: 'source', role: locator.role });
    addEdge({ kind: 'span_in_document', from: spanId, to: documentId, authority_plane: 'source' });
    if (locator.block?.block_id) addEdge({ kind: 'span_in_block', from: spanId, to: locator.block.block_id, authority_plane: 'source' });
    return spanId;
  };
  const candidate = calibration.candidate;
  addNode({ id: candidate.id, kind: 'candidate', label: calibration.title || calibration.calibration_id || 'Joint reconciliation candidate', authority_plane: candidate.authority_plane,
    producer: candidate.producer, signal_count: candidate.signals.length, exact_span_count: candidate.exact_spans.length, data: candidate });

  const packetForRelation = new Map(), packetForLink = new Map();
  for (const packet of calibration.result?.packet_results || []) {
    for (const relation of packet.relations || []) packetForRelation.set(relation.id, packet.packet_id);
    for (const link of packet.links || []) packetForLink.set(link.id, packet.packet_id);
  }
  for (const [ordinal, packetId] of (calibration.joint_packet?.packet_ids || []).entries()) {
    addNode({ id: packetId, kind: 'extraction_window', label: `Joint packet ${ordinal + 1}`,
      authority_plane: 'deterministic_structure', ordinal, data: (calibration.joint_packet.block_catalogs || []).find(row => row.packet_id === packetId) || null });
    addEdge({ kind: 'candidate_has_window', from: candidate.id, to: packetId, authority_plane: 'deterministic_structure' });
    addEdge({ kind: 'window_in_document', from: packetId, to: documentId, authority_plane: 'deterministic_structure' });
  }

  const selectedAddresses = new Set(candidate.block_addresses || []);
  for (const address of [...selectedAddresses].sort()) {
    const block = index.byAddress.get(address);
    if (!block) continue;
    addNode({
      id: block.id, kind: 'source_block', label: clean(block.text).slice(0, 90) || `${block.type} ${block.start}-${block.end}`,
      authority_plane: 'source', file: block.file, start: block.start, end: block.end,
      block_type: block.type, heading_ancestry: block.heading_ancestry, source_excerpt: block.text, digest: block.digest,
    });
    addEdge({ kind: 'block_in_document', from: block.id, to: documentId, authority_plane: 'deterministic_structure' });
    addEdge({ kind: 'candidate_selects_block', from: candidate.id, to: block.id, authority_plane: 'deterministic_structure' });
    for (const catalog of calibration.joint_packet?.block_catalogs || []) {
      if ((catalog.entries || []).some(entry => entry.file === block.file && entry.start === block.start && entry.end === block.end && entry.digest === block.digest)) {
        addEdge({ kind: 'window_has_block', from: catalog.packet_id, to: block.id, authority_plane: 'deterministic_structure' });
      }
    }
  }

  for (const term of calibration.query_terms || []) {
    const normalized = term.toLocaleLowerCase();
    const termId = idFor('map-query-term', { term: normalized });
    addNode({ id: termId, kind: 'query_term', label: term, authority_plane: 'operator_authorized_query' });
    addEdge({ kind: 'candidate_requests_term', from: candidate.id, to: termId, authority_plane: 'operator_authorized_query' });
    for (const span of candidate.exact_spans.filter(row => row.normalized_surface === normalized)) {
      if (selectedAddresses.has(span.block_address)) addEdge({ kind: 'term_occurs_in_block', from: termId, to: span.block_id,
        authority_plane: 'deterministic_structure', file: span.file, start: span.start, end: span.end });
    }
  }

  for (const observation of prepass.structured_observations.filter(row => selectedAddresses.has(row.block_address))) {
    addNode({ id: observation.id, kind: 'structured_observation', label: `${observation.field_path} = ${clean(observation.value).slice(0, 50)}`,
      authority_plane: observation.authority_plane, producer: observation.producer, evidence_class: observation.evidence_class, data: observation });
    addEdge({ kind: 'observation_in_block', from: observation.id, to: observation.block_id, authority_plane: 'deterministic_structure' });
  }

  const accepted = calibration.result?.relations || [];
  for (const relation of accepted) {
    addNode({ id: relation.id, kind: 'accepted_relation', label: relation.semantic?.predicate_family || relation.id,
      authority_plane: relation.authority_plane || 'reconciled_documentary_claim', producer: relation.producer, data: relation });
    addEdge({ kind: 'relation_from_candidate', from: relation.id, to: candidate.id, authority_plane: 'custody' });
    if (packetForRelation.has(relation.id)) addEdge({ kind: 'relation_from_window', from: relation.id,
      to: packetForRelation.get(relation.id), authority_plane: 'custody' });
    const subject = relation.semantic?.subject || {};
    const mentionId = idFor('map-subject-mention', { relation_id: relation.id, locator_id: subject.source_locator?.id, surface: subject.surface });
    addNode({ id: mentionId, kind: 'subject_mention', label: subject.surface || 'subject', authority_plane: 'documentary_claim', data: subject });
    addEdge({ kind: 'relation_has_subject', from: relation.id, to: mentionId, authority_plane: 'documentary_claim' });
    if (subject.source_locator?.block?.block_id) addEdge({ kind: 'mention_anchored_in_block', from: mentionId, to: subject.source_locator.block.block_id,
      authority_plane: 'source', locator_id: subject.source_locator.id });
    if (subject.canonical_ref) {
      const conceptId = idFor('map-concept', { canonical_ref: subject.canonical_ref });
      addNode({ id: conceptId, kind: 'concept', label: subject.canonical_ref, authority_plane: 'documentary_identity' });
      addEdge({ kind: 'mention_resolves_to_concept', from: mentionId, to: conceptId, authority_plane: 'documentary_identity', basis: subject.canonical_basis });
    }
    for (const set of relation.semantic?.support_sets || []) {
      const setId = idFor('map-support-set', { relation_id: relation.id, mode: set.mode, locator_ids: set.locators.map(locator => locator.id) });
      addNode({ id: setId, kind: 'support_set', label: set.mode, authority_plane: 'documentary_claim' });
      addEdge({ kind: 'relation_has_support_set', from: relation.id, to: setId, authority_plane: 'documentary_claim' });
      for (const locator of set.locators || []) {
        addNode({ id: locator.id, kind: 'evidence_locator', label: clean(locator.text).slice(0, 90), authority_plane: 'source', data: locator });
        addEdge({ kind: 'support_set_has_locator', from: setId, to: locator.id, authority_plane: 'source', role: locator.role });
        addEvidenceSpan(locator, setId, 'support_set_has_evidence_span');
        if (locator.block?.block_id) addEdge({ kind: 'locator_in_block', from: locator.id, to: locator.block.block_id, authority_plane: 'source' });
      }
    }
  }

  for (const relationLink of calibration.result?.links || []) {
    addNode({ id: relationLink.id, kind: 'relation_link', label: relationLink.kind,
      authority_plane: relationLink.authority_plane, producer: relationLink.producer, data: relationLink });
    addEdge({ kind: 'link_from_relation', from: relationLink.from_relation_id, to: relationLink.id, authority_plane: relationLink.authority_plane });
    addEdge({ kind: 'link_to_relation', from: relationLink.id, to: relationLink.to_relation_id, authority_plane: relationLink.authority_plane });
    if (packetForLink.has(relationLink.id)) addEdge({ kind: 'link_from_window', from: relationLink.id,
      to: packetForLink.get(relationLink.id), authority_plane: 'custody' });
    for (const locator of relationLink.support_locators || []) {
      addNode({ id: locator.id, kind: 'evidence_locator', label: clean(locator.text).slice(0, 90), authority_plane: 'source', data: locator });
      addEdge({ kind: 'link_supported_by_locator', from: relationLink.id, to: locator.id, authority_plane: 'source', role: locator.role });
      addEvidenceSpan(locator, relationLink.id, 'link_supported_by_evidence_span');
      if (locator.block?.block_id) addEdge({ kind: 'locator_in_block', from: locator.id, to: locator.block.block_id, authority_plane: 'source' });
    }
  }

  const rawPackets = rawProposalPackets(calibration);
  for (const [packetIndex, packet] of (calibration.result?.packet_results || []).entries()) {
    const proposed = rawPackets[packetIndex] || { relations: [], links: [] };
    for (const rejection of packet.rejected || []) {
      const proposal = proposed.relations[rejection.index] || null;
      const rejectionId = idFor('map-rejection', { packet_id: packet.packet_id, index: rejection.index, code: rejection.code, proposal });
      addNode({ id: rejectionId, kind: 'rejected_relation', label: `Rejected: ${proposal?.predicate_family || `relation ${rejection.index + 1}`}`,
        authority_plane: 'validation_finding', code: rejection.code, detail: rejection.detail, data: { rejection, proposal } });
      addEdge({ kind: 'rejection_from_candidate', from: rejectionId, to: candidate.id, authority_plane: 'validation_finding' });
      addEdge({ kind: 'rejection_from_window', from: rejectionId, to: packet.packet_id, authority_plane: 'custody' });
    }
    for (const rejection of packet.rejected_links || []) {
      const proposal = proposed.links[rejection.index] || null;
      const rejectionId = idFor('map-link-rejection', { packet_id: packet.packet_id, index: rejection.index, code: rejection.code, proposal });
      addNode({ id: rejectionId, kind: 'rejected_link', label: `Rejected link: ${proposal?.kind || rejection.index + 1}`,
        authority_plane: 'validation_finding', code: rejection.code, detail: rejection.detail, data: { rejection, proposal } });
      addEdge({ kind: 'link_rejection_from_candidate', from: rejectionId, to: candidate.id, authority_plane: 'validation_finding' });
      addEdge({ kind: 'link_rejection_from_window', from: rejectionId, to: packet.packet_id, authority_plane: 'custody' });
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edgeList = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  // d3.forceLink throws on the first edge whose endpoint id is absent, which blanks the entire
  // canvas rather than dropping one edge. Fail closed here instead of shipping an unrenderable map.
  const known = new Set(nodeList.map(node => node.id));
  const dangling = edgeList.filter(edge => !known.has(edge.from) || !known.has(edge.to))
    .map(edge => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to }));
  if (dangling.length) {
    const error = new Error(`CONTEXT_MAP_DANGLING_EDGES: ${dangling.length} edge endpoint(s) reference unknown nodes`);
    error.code = 'CONTEXT_MAP_DANGLING_EDGES';
    error.detail = { dangling: dangling.slice(0, 20) };
    throw error;
  }
  const counts = Object.fromEntries([...new Set(nodeList.map(node => node.kind))].sort().map(kind => [kind, nodeList.filter(node => node.kind === kind).length]));
  const body = {
    schema: CONTEXT_MAP_SCHEMA,
    snapshot: calibration.snapshot,
    calibration: { schema: calibration.schema, id: calibration.calibration_id || null, title: calibration.title || null,
      digest: calibration.digest, model: calibration.model, reconciliation_version: calibration.reconciliation_version,
      linker_version: calibration.linker_version || null, grade: calibration.grade, budget: calibration.budget },
    status: calibration.grade?.pass ? 'validated' : 'calibration_failed',
    authority_boundary: 'source and deterministic observations remain distinct from documentary and reconciled claims',
    metrics: { nodes: nodeList.length, edges: edgeList.length, by_kind: counts, accepted_relations: accepted.length,
      rejected_relations: nodeList.filter(node => node.kind === 'rejected_relation').length,
      accepted_links: nodeList.filter(node => node.kind === 'relation_link').length,
      rejected_links: nodeList.filter(node => node.kind === 'rejected_link').length },
    nodes: nodeList,
    edges: edgeList,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

function safeJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
function safeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

function renderableGraph(map) {
  const claimGraph = map.schema === 'estate-map/claim-source-graph/v2';
  const byKind = map.metrics?.by_kind || Object.fromEntries([...new Set(map.nodes.map(node => node.kind))]
    .sort().map(kind => [kind, map.nodes.filter(node => node.kind === kind).length]));
  const status = map.status || (map.metrics?.lineage_complete ? 'validated' : 'lineage_findings');
  const nodes = map.nodes.map(node => ({
    ...node,
    label: node.label || node.path || node.surface || node.predicate_family || node.proposition_key || node.kind,
  }));
  return {
    graph: { ...map, status, nodes, metrics: { ...map.metrics, nodes: nodes.length, edges: map.edges.length, by_kind: byKind } },
    title: claimGraph ? 'Claim / Source Graph' : 'Context Reconciliation Map',
    subtitle: `${map.snapshot?.source_sha?.slice(0, 12) || 'unknown source'} · ${claimGraph ? map.source_artifact?.schema || 'unknown artifact' : map.calibration?.model || 'unknown model'}`,
    status,
  };
}

/** Complete interactive HTML; vendored D3 and graph bytes are embedded for offline custody. */
export function renderContextMapHtml(map) {
  const view = renderableGraph(map);
  const embedded = safeJson(view.graph);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ascrybe — ${safeHtml(view.title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0d12;--panel:#121722;--line:#2a3447;--text:#e8edf7;--muted:#8f9bb0;--accent:#68d5ff;--bad:#ff647c;--good:#67e8a5}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden}.app{display:grid;grid-template-rows:64px 1fr;height:100vh}.top{display:flex;align-items:center;gap:14px;padding:10px 16px;background:#0f131c;border-bottom:1px solid #20283a}.title{font-weight:750;font-size:16px}.chip{padding:4px 9px;border-radius:999px;background:#20283a;color:var(--muted)}.chip.pass{background:#123326;color:var(--good)}.chip.fail{background:#3a1720;color:#ff9baa}.search{margin-left:auto;width:260px;background:#171d29;border:1px solid #2b3549;color:var(--text);padding:8px 10px;border-radius:8px}.body{display:grid;grid-template-columns:240px minmax(0,1fr) 360px;min-height:0}.side{background:var(--panel);border-right:1px solid #20283a;padding:14px;overflow:auto}.detail{border-right:0;border-left:1px solid #20283a}.side h3{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:4px 0 10px}.legend-row{display:flex;gap:8px;align-items:center;margin:7px 0}.dot{width:10px;height:10px;border-radius:50%}.check{display:flex;gap:8px;align-items:center;margin:7px 0;color:#c8d1e0}.stats{display:grid;grid-template-columns:1fr auto;gap:5px 12px;color:var(--muted);margin-bottom:16px}.canvas{position:relative;min-width:0}.canvas svg{width:100%;height:100%;display:block}.hint{position:absolute;bottom:12px;left:14px;color:#68758d;background:#0b0d12cc;padding:6px 9px;border-radius:6px}.detail pre{white-space:pre-wrap;word-break:break-word;background:#0b0f17;padding:10px;border-radius:8px;color:#bac5d8;max-height:calc(100vh - 150px);overflow:auto}.detail .empty{color:var(--muted)}button{background:#1c2535;border:1px solid #34415a;color:var(--text);padding:6px 9px;border-radius:7px;cursor:pointer}.edge{stroke:#536078;stroke-opacity:.48}.node text{fill:#cbd5e5;font-size:10px;pointer-events:none;text-shadow:0 1px 3px #000}.node circle{stroke:#090b10;stroke-width:1.5}.node.dim,.edge.dim{opacity:.07}.node.hit circle{stroke:#fff;stroke-width:3}.edge.hit{stroke:var(--accent);stroke-opacity:1;stroke-width:2.5}.error{padding:24px;color:#ff9baa}
</style>
<script>${D3_SOURCE}</script></head>
<body><div class="app"><header class="top"><div><div class="title">${safeHtml(view.title)}</div><div style="color:var(--muted)">${safeHtml(view.subtitle)}</div></div><span class="chip ${view.status === 'validated' ? 'pass' : 'fail'}">${safeHtml(view.status)}</span><span class="chip">${view.graph.metrics.nodes} nodes</span><span class="chip">${view.graph.metrics.edges} edges</span><button id="fit">Fit</button><input id="search" class="search" placeholder="Search labels, source, predicates…"></header>
<div class="body"><aside class="side"><h3>Node layers</h3><div id="filters"></div><h3 style="margin-top:20px">Metrics</h3><div class="stats" id="stats"></div><h3>Authority</h3><div style="color:var(--muted)">Solid source/block links are deterministic. Claims, concepts, and rejected proposals remain visibly separate.</div></aside><main class="canvas"><svg id="graph" viewBox="0 0 1400 850"></svg><div class="hint">Drag nodes · wheel to zoom · click for provenance</div></main><aside class="side detail"><h3>Selected node</h3><div id="selection" class="empty">Click any node.</div></aside></div></div>
<script id="graph-data" type="application/json">${embedded}</script>
<script>
(() => { if(!window.d3){document.querySelector('.canvas').innerHTML='<div class="error">D3 failed to load. Graph data remains embedded in this HTML.</div>';return;} const G=JSON.parse(document.getElementById('graph-data').textContent);const MUTED=new Set(['structured_observation']);const ALWAYS_LABEL=new Set(['accepted_relation','relation_link','rejected_relation','rejected_link','candidate','source_document','extraction_window','query_term','concept','documentary_claim']);const colors={source_document:'#69a7ff',source_block:'#5d7ca8',extraction_window:'#7f9cf5',query_term:'#f6c85f',candidate:'#b794f6',structured_observation:'#53d7c0',documentary_claim:'#67e8a5',accepted_relation:'#67e8a5',relation_link:'#e7a7ff',subject_mention:'#f4a261',concept:'#a7f3d0',concept_candidate:'#f6c85f',support_set:'#8dd3c7',evidence_locator:'#c2e7ff',evidence_span:'#8ac7ff',invalid_source_span:'#ff647c',rejected_relation:'#ff647c',rejected_link:'#ff8e5d'};const radii={source_document:16,candidate:18,extraction_window:13,documentary_claim:15,accepted_relation:15,relation_link:12,rejected_relation:15,rejected_link:13,query_term:10,source_block:9,structured_observation:8,subject_mention:9,concept:11,concept_candidate:10,support_set:7,evidence_locator:7,evidence_span:7,invalid_source_span:9};const nodes=G.nodes.map(d=>({...d}));const links=G.edges.map(d=>({...d,source:d.from,target:d.to}));const byId=new Map(nodes.map(d=>[d.id,d]));const svg=d3.select('#graph'),root=svg.append('g'),canvasEl=document.querySelector('.canvas');let VW=1400,VH=850;function sizeSvg(){VW=Math.max(320,canvasEl.clientWidth||1400);VH=Math.max(320,canvasEl.clientHeight||850);svg.attr('viewBox','0 0 '+VW+' '+VH)}sizeSvg();svg.append('defs').append('marker').attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX',18).attr('refY',0).attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto').append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#536078');const link=root.append('g').selectAll('line').data(links).join('line').attr('class','edge').attr('marker-end','url(#arrow)');link.append('title').text(d=>d.kind);const node=root.append('g').selectAll('g').data(nodes).join('g').attr('class','node').call(d3.drag().on('start',dragStart).on('drag',dragged).on('end',dragEnd));node.append('circle').attr('r',d=>radii[d.kind]||8).attr('fill',d=>colors[d.kind]||'#94a3b8');node.append('text').attr('x',d=>(radii[d.kind]||8)+5).attr('y',3).text(d=>d.label?.slice(0,54)||d.kind);function applyLabels(){node.select('text').attr('display',d=>(ALWAYS_LABEL.has(d.kind)||zoomScale>=1.5)&&enabled.has(d.kind)?null:'none')}node.append('title').text(d=>d.label||d.id);const simulation=d3.forceSimulation(nodes).randomSource(d3.randomLcg(.42)).force('link',d3.forceLink(links).id(d=>d.id).distance(d=>d.kind.includes('block')?90:130).strength(.5)).force('charge',d3.forceManyBody().strength(d=>MUTED.has(d.kind)?-220:-620)).force('center',d3.forceCenter(VW/2,VH/2)).force('collision',d3.forceCollide().radius(d=>(radii[d.kind]||8)+22)).on('tick',render);function render(){link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('transform',d=>'translate('+d.x+','+d.y+')')}simulation.stop();const ticks=Math.min(420,Math.max(80,Math.floor(336000/Math.max(800,nodes.length))));for(let i=0;i<ticks;i+=1)simulation.tick();render();let zoomScale=1;const zoom=d3.zoom().scaleExtent([.02,6]).on('zoom',e=>{zoomScale=e.transform.k;root.attr('transform',e.transform);applyLabels()});svg.call(zoom);function fit(duration){const shown=nodes.filter(d=>enabled.has(d.kind)&&Number.isFinite(d.x));if(!shown.length)return;const xs=shown.map(d=>d.x),ys=shown.map(d=>d.y);const w=Math.max(1,Math.max(...xs)-Math.min(...xs)),h=Math.max(1,Math.max(...ys)-Math.min(...ys));const k=Math.min(6,.88*Math.min(VW/w,VH/h));const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;svg.transition().duration(duration).call(zoom.transform,d3.zoomIdentity.translate(VW/2,VH/2).scale(k).translate(-cx,-cy))}document.getElementById('fit').onclick=()=>fit(450);const kinds=[...new Set(nodes.map(d=>d.kind))].sort();const enabled=new Set(kinds.filter(k=>!MUTED.has(k)));const filters=d3.select('#filters');kinds.forEach(k=>{const row=filters.append('label').attr('class','check');row.append('input').attr('type','checkbox').property('checked',enabled.has(k)).on('change',function(){this.checked?enabled.add(k):enabled.delete(k);apply();fit(450)});row.append('span').attr('class','dot').style('background',colors[k]||'#94a3b8');row.append('span').text(k+' ('+nodes.filter(n=>n.kind===k).length+')')});const stats=d3.select('#stats');Object.entries(G.metrics.by_kind).forEach(([k,v])=>{stats.append('span').text(k);stats.append('strong').text(v)});let query='';document.getElementById('search').addEventListener('input',e=>{query=e.target.value.toLowerCase().trim();apply()});apply();fit(0);window.addEventListener('resize',()=>{sizeSvg();fit(0)});function apply(){const visible=new Set(nodes.filter(n=>enabled.has(n.kind)).map(n=>n.id));applyLabels();node.attr('display',d=>enabled.has(d.kind)?null:'none');link.attr('display',d=>visible.has(d.source.id)&&visible.has(d.target.id)?null:'none');node.classed('dim',d=>!visible.has(d.id)||(query&&!JSON.stringify(d).toLowerCase().includes(query))).classed('hit',d=>query&&visible.has(d.id)&&JSON.stringify(d).toLowerCase().includes(query));link.classed('dim',d=>!visible.has(d.source.id)||!visible.has(d.target.id)).classed('hit',d=>query&&(JSON.stringify(d).toLowerCase().includes(query)||JSON.stringify(d.source).toLowerCase().includes(query)||JSON.stringify(d.target).toLowerCase().includes(query)))}node.on('click',(e,d)=>{e.stopPropagation();const adjacent=links.filter(l=>l.source.id===d.id||l.target.id===d.id).map(l=>({kind:l.kind,other:(l.source.id===d.id?l.target:l.source).label|| (l.source.id===d.id?l.target:l.source).id}));document.getElementById('selection').innerHTML='<div style="font-weight:700;margin-bottom:8px">'+escapeHtml(d.label||d.kind)+'</div><pre>'+escapeHtml(JSON.stringify({...d,adjacent_edges:adjacent},null,2))+'</pre>'});svg.on('click',()=>document.getElementById('selection').innerHTML='<div class="empty">Click any node.</div>');function dragStart(e,d){if(!e.active)simulation.alphaTarget(.3).restart();d.fx=d.x;d.fy=d.y}function dragged(e,d){d.fx=e.x;d.fy=e.y}function dragEnd(e,d){if(!e.active)simulation.alphaTarget(0);d.fx=null;d.fy=null}function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}})();
</script></body></html>\n`;
}

export async function writeContextMapArtifacts({ calibration, estate, mapPath, htmlPath }) {
  if (!mapPath || !htmlPath) throw new Error('paired mapPath and htmlPath are required');
  const map = await buildContextMap({ calibration, estate });
  const writtenMap = await atomicWrite(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const writtenHtml = await atomicWrite(htmlPath, renderContextMapHtml(map));
  return Object.freeze({ map: writtenMap, html: writtenHtml, digest: map.digest, metrics: map.metrics, status: map.status });
}

async function main() {
  const args=process.argv.slice(2), positional=[], options={};
  for(let i=0;i<args.length;i+=1){if(args[i].startsWith('--'))options[args[i].slice(2)]=args[++i];else positional.push(args[i]);}
  const [calibrationPath]=positional;
  if(!calibrationPath||!options.estate||!options.map||!options.html) throw new Error('usage: context-map-artifacts.mjs <calibration.json> --estate <root> --map <map.json> --html <map.html>');
  const calibration=JSON.parse(await fs.readFile(path.resolve(calibrationPath),'utf8'));
  const estate=await fs.realpath(path.resolve(options.estate));
  const result=await writeContextMapArtifacts({calibration,estate,mapPath:options.map,htmlPath:options.html});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
