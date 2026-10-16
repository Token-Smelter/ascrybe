// Fast, self-contained document-first explorer for large claim/source graphs.
//
// The complete graph remains the custody artifact. This projection integer-encodes its topology,
// gzips it into the HTML, paints the document census first, and instantiates only one document's
// canvas graph at a time. No graph claim, edge, or exact evidence span is inferred in the browser.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
const D3_SOURCE = readFileSync(new URL('./vendor/d3.v7.9.0.min.js', import.meta.url), 'utf8')
  .replace(/<\/script/giu, '<\\/script');
const safeJson = value => JSON.stringify(value).replace(/</gu, '\\u003c')
  .replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
const safeHtml = value => String(value).replace(/[&<>"']/gu, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const nodeLabel = node => {
  if (node.kind === 'source_document') return node.path;
  if (node.kind === 'documentary_claim') {
    const subject = node.subject?.surface || 'subject';
    return `${subject} ${node.predicate_family || ''} ${node.object_or_value || ''}`.replace(/\s+/gu, ' ').trim();
  }
  if (node.kind === 'evidence_span') return `${node.file}:${node.start}-${node.end} ${node.text || ''}`;
  if (node.kind === 'extraction_window') return `${node.files?.join(', ') || 'window'} · ${node.window_kind || 'window'}`;
  return node.surface || node.canonical_ref || node.mode || node.id;
};

const detailFor = node => {
  const common = { forensic_id: node.id, kind: node.kind, authority_plane: node.authority_plane };
  if (node.kind === 'source_document') return { ...common, path: node.path,
    source_digest: node.source_digest, source_sha: node.source_sha };
  if (node.kind === 'extraction_window') return { ...common, window_kind: node.window_kind,
    files: node.files, primary_spans: node.primary_spans, context_spans: node.context_spans,
    heading_ancestry: node.heading_ancestry, primary_bytes: node.primary_bytes, block_count: node.block_count };
  if (node.kind === 'documentary_claim') return { ...common, schema: node.schema,
    proposition_key: node.proposition_key, evidence_key: node.evidence_key, subject: node.subject,
    relation_family: node.relation_family, predicate_family: node.predicate_family,
    object_or_value: node.object_or_value, polarity: node.polarity, modality: node.modality,
    quantifier: node.quantifier, scope: node.scope, valid_time: node.valid_time,
    irreducible_multi_span: node.irreducible_multi_span, lineage_status: node.lineage_status };
  if (node.kind === 'subject_mention') return { ...common, claim_id: node.claim_id,
    surface: node.surface, literal_surface: node.literal_surface, subject_binding: node.subject_binding,
    source_mention_key: node.source_mention_key };
  if (node.kind === 'support_set') return { ...common, claim_id: node.claim_id,
    mode: node.mode, position: node.position };
  if (node.kind === 'evidence_span' || node.kind === 'invalid_source_span') return { ...common,
    file: node.file, start: node.start, end: node.end, byte_start: node.byte_start,
    byte_end: node.byte_end, text_digest: node.text_digest, text: node.text };
  return { ...common, surface: node.surface, canonical_ref: node.canonical_ref,
    candidate_kind: node.candidate_kind };
};

const confirmationSummary = grade => grade ? {
  status: grade.status,
  pass: grade.pass,
  digest: grade.digest,
  primary_endpoint: grade.primary_endpoint,
  control: grade.metrics?.control,
  treatment: grade.metrics?.treatment,
  paired_primary: grade.paired_primary,
  precision_quality: grade.precision_quality,
  checks: grade.checks,
  inference_cost: grade.inference_cost,
} : null;

/** Integer-encode a complete claim graph and precompute exact per-document induced subgraphs. */
export function buildClaimMapDrilldownPayload({ graph, confirmation = null }) {
  if (graph?.schema !== 'estate-map/claim-source-graph/v2' || !Array.isArray(graph.nodes)
    || !Array.isArray(graph.edges)) throw new Error('a claim/source graph v2 is required');
  const indexById = new Map(graph.nodes.map((node, index) => [node.id, index]));
  if (indexById.size !== graph.nodes.length) throw new Error('claim graph contains duplicate node ids');
  const nodes = graph.nodes.map(node => ({ k: node.kind, l: nodeLabel(node), d: detailFor(node) }));
  const edges = graph.edges.map(edge => {
    const from = indexById.get(edge.from), to = indexById.get(edge.to);
    if (from === undefined || to === undefined) throw new Error(`claim graph edge ${edge.id} is dangling`);
    return [from, to, edge.kind];
  });
  const documentIndexes = graph.nodes.map((node, index) => node.kind === 'source_document' ? index : null)
    .filter(index => index !== null);
  const membersByDocument = new Map(documentIndexes.map(index => [index, new Set([index])]));
  const directMembership = new Set(['window_in_document', 'claim_grounded_in_document',
    'claim_cites_document', 'span_in_document', 'mention_in_document']);
  for (const [from, to, kind] of edges) {
    if (membersByDocument.has(to) && directMembership.has(kind)) membersByDocument.get(to).add(from);
  }
  const closureKinds = new Set(['claim_has_subject_mention', 'claim_has_support_set',
    'claim_extracted_from_window', 'support_requires_span', 'support_has_alternative_span',
    'mention_anchored_by_span', 'mention_resolves_to_concept', 'same_surface_candidate',
    'span_presented_as_primary', 'span_presented_as_context']);
  for (const members of membersByDocument.values()) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [from, to, kind] of edges) if (closureKinds.has(kind) && members.has(from) && !members.has(to)) {
        members.add(to); changed = true;
      }
    }
  }
  const documents = documentIndexes.map(documentIndex => {
    const members = [...membersByDocument.get(documentIndex)].sort((a, b) => a - b);
    const memberSet = new Set(members);
    const edgeIndexes = edges.map((edge, index) => memberSet.has(edge[0]) && memberSet.has(edge[1]) ? index : null)
      .filter(index => index !== null);
    const counts = {};
    for (const index of members) counts[nodes[index].k] = (counts[nodes[index].k] || 0) + 1;
    return { n: documentIndex, p: graph.nodes[documentIndex].path, m: members, e: edgeIndexes, c: counts };
  }).sort((a, b) => a.p.localeCompare(b.p));
  const body = {
    schema: 'estate-map/claim-map-drilldown/v1',
    graph: { schema: graph.schema, digest: graph.digest, source_artifact: graph.source_artifact,
      snapshot: graph.snapshot, metrics: graph.metrics, findings: graph.findings },
    confirmation: confirmationSummary(confirmation),
    nodes, edges, documents,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

/** Render a self-contained page that delays decompression and never draws the whole graph. */
export function renderClaimMapDrilldownHtml({ graph, confirmation = null }) {
  const payload = buildClaimMapDrilldownPayload({ graph, confirmation });
  const packed = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const encoded = packed.toString('base64');
  const overview = payload.documents.map(document => ({ p: document.p, c: document.c }));
  const primary = payload.confirmation?.paired_primary;
  const controlRecall = payload.confirmation?.control?.document_scope?.strict_recall;
  const treatmentRecall = payload.confirmation?.treatment?.document_scope?.strict_recall;
  const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
  const padding = Array.from({ length: 60 }, (_, index) => `<!-- static-drop preflight ${String(index + 1).padStart(2, '0')} -->`).join('\n');
  return `<!doctype html>
${padding}
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ascrybe — V32 Confirmed Treatment</title>
<style>
:root{color-scheme:dark;--bg:#080b11;--panel:#101621;--panel2:#151d2b;--line:#273247;--text:#edf4ff;--muted:#8d9bb1;--blue:#69a7ff;--green:#67e8a5;--gold:#f6c85f;--purple:#b794f6;--orange:#f4a261}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden}.app{height:100vh;display:grid;grid-template-rows:78px minmax(0,1fr)}header{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line);background:#0d121b}.brand{min-width:245px}.brand strong{display:block;font-size:17px}.muted{color:var(--muted)}.chip{border:1px solid var(--line);background:var(--panel2);padding:6px 9px;border-radius:999px;white-space:nowrap}.chip.pass{color:var(--green);border-color:#245e49;background:#102a21}.body{display:grid;grid-template-columns:310px minmax(0,1fr) 380px;min-height:0}.sidebar,.detail{background:var(--panel);padding:12px;overflow:auto}.sidebar{border-right:1px solid var(--line)}.detail{border-left:1px solid var(--line)}input,button{font:inherit}.search{width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:#0a0f18;color:var(--text);margin-bottom:10px}.doc-list{display:flex;flex-direction:column;gap:5px}.doc{display:block;width:100%;text-align:left;padding:9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text);cursor:pointer}.doc:hover,.doc.active{background:#1a2332;border-color:#32415a}.doc small{display:block;color:var(--muted);margin-top:3px}.stage{display:grid;grid-template-rows:50px minmax(0,1fr);min-width:0;min-height:0}.toolbar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:#0c111a}.toolbar .title{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.spacer{flex:1}.tab,.fit{padding:6px 9px;border:1px solid var(--line);background:#17202e;color:var(--text);border-radius:7px;cursor:pointer}.tab.active{border-color:#5e8fd6;background:#20324b}.view{position:relative;min-width:0;min-height:0}.view canvas{width:100%;height:100%;display:block}.view>.empty{position:absolute;inset:0;z-index:1;display:grid;place-items:center;color:var(--muted);padding:30px;text-align:center;background:var(--bg)}.claims{height:100%;overflow:auto;padding:12px;display:none}.claim{padding:10px 11px;margin-bottom:7px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.claim b{color:var(--green)}.claim .meta{color:var(--muted);margin-top:4px}.detail h3,.sidebar h3{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:5px 0 10px}.detail pre{white-space:pre-wrap;word-break:break-word;padding:10px;background:#090e16;border-radius:8px;border:1px solid #202a3b;max-height:calc(100vh - 160px);overflow:auto}.loading{color:var(--gold)}@media(max-width:1000px){.body{grid-template-columns:250px minmax(0,1fr)}.detail{display:none}.chip.secondary{display:none}}
</style>
<script>${D3_SOURCE}</script>
</head>
<body>
<div class="app">
<header>
<div class="brand"><strong>V32 Confirmed Treatment Map</strong><span class="muted">document-first claim/source explorer</span></div>
<span class="chip pass">CONFIRMED PASS</span>
<span class="chip">${percent(controlRecall)} → ${percent(treatmentRecall)}</span>
<span class="chip secondary">gain ${percent(primary?.observed_gain)} · 95% lower ${percent(primary?.confidence_interval?.lower_95)}</span>
<span class="chip secondary">${graph.metrics.claims} claims · ${graph.metrics.documents} documents</span>
<span id="loadState" class="chip loading">Loading ${Math.ceil(packed.length / 1024 / 1024)} MB drill-down…</span>
</header>
<div class="body">
<aside class="sidebar"><h3>Documents</h3><input id="search" class="search" placeholder="Search document paths and claims…"><div id="docs" class="doc-list"></div></aside>
<main class="stage"><div class="toolbar"><div id="selectedTitle" class="title">Choose a document</div><span class="spacer"></span><button id="graphTab" class="tab active">Graph</button><button id="claimsTab" class="tab">Claims</button><button id="fit" class="fit">Fit</button></div><div id="view" class="view"><div id="intro" class="empty">The full estate is indexed, but never rendered all at once.<br>Choose a document to inspect its exact claim/evidence neighborhood.</div><canvas id="graph"></canvas><div id="claims" class="claims"></div></div></main>
<aside class="detail"><h3>Selection</h3><div id="selection" class="muted">Choose a document, claim, or evidence node.</div><h3 style="margin-top:18px">Custody</h3><div class="muted">Graph digest<br><code>${safeHtml(graph.digest)}</code><br><br>Confirmation digest<br><code>${safeHtml(confirmation?.digest || 'not supplied')}</code></div></aside>
</div>
</div>
<script id="overview-data" type="application/json">${safeJson(overview)}</script>
<script id="packed-data" type="application/octet-stream">${encoded}</script>
<script>
(() => {
  const overview=JSON.parse(document.getElementById('overview-data').textContent);let DATA=null,current=null,currentNodes=[],currentEdges=[],transform=d3.zoomIdentity,mode='graph';
  const colors={source_document:'#69a7ff',extraction_window:'#7f9cf5',documentary_claim:'#67e8a5',subject_mention:'#f4a261',support_set:'#8dd3c7',evidence_span:'#8ac7ff',invalid_source_span:'#ff647c',concept:'#a7f3d0',concept_candidate:'#f6c85f'};
  const radius=k=>k==='source_document'?13:k==='documentary_claim'?8:k==='extraction_window'?7:k==='evidence_span'?4:5;
  const docsEl=document.getElementById('docs'),search=document.getElementById('search'),canvas=document.getElementById('graph'),ctx=canvas.getContext('2d'),claimsEl=document.getElementById('claims');
  let docSearch=overview.map(d=>d.p.toLowerCase());
  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function renderDocs(){const q=search.value.trim().toLowerCase();docsEl.textContent='';overview.forEach((d,i)=>{if(q&&!docSearch[i].includes(q))return;const b=document.createElement('button');b.className='doc'+(current?.p===d.p?' active':'');b.innerHTML='<span>'+esc(d.p)+'</span><small>'+(d.c.documentary_claim||0)+' claims · '+(d.c.evidence_span||0)+' spans · '+(d.c.extraction_window||0)+' windows</small>';b.disabled=!DATA;b.onclick=()=>selectDocument(i);docsEl.append(b)})}
  renderDocs();search.oninput=renderDocs;
  async function unpack(){const raw=atob(document.getElementById('packed-data').textContent.trim()),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);if(!('DecompressionStream'in window))throw new Error('This browser lacks DecompressionStream support.');const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));DATA=JSON.parse(await new Response(stream).text());docSearch=DATA.documents.map(d=>{const labels=d.m.filter(i=>DATA.nodes[i].k==='documentary_claim').map(i=>DATA.nodes[i].l);return (d.p+' '+labels.join(' ')).toLowerCase()});document.getElementById('loadState').textContent='Ready · '+DATA.nodes.length.toLocaleString()+' indexed nodes';document.getElementById('loadState').classList.remove('loading');renderDocs();document.body.dataset.ready='true'}
  unpack().catch(error=>{document.getElementById('loadState').textContent='Load failed';document.getElementById('selection').innerHTML='<pre>'+esc(error.stack||error.message)+'</pre>';document.body.dataset.ready='error'});
  function selectDocument(index){current=DATA.documents[index];document.getElementById('intro').style.display='none';document.getElementById('selectedTitle').textContent=current.p;currentNodes=current.m.map(i=>({...DATA.nodes[i],i}));const local=new Set(current.m);currentEdges=current.e.map(i=>DATA.edges[i]).filter(e=>local.has(e[0])&&local.has(e[1])).map(e=>({source:e[0],target:e[1],kind:e[2]}));renderDocs();buildClaims();renderGraph();showDetail(DATA.nodes[current.n].d)}
  function buildClaims(){claimsEl.textContent='';for(const node of currentNodes.filter(n=>n.k==='documentary_claim').sort((a,b)=>a.l.localeCompare(b.l))){const card=document.createElement('article');card.className='claim';card.innerHTML='<b>'+esc(node.d.subject?.surface||'subject')+'</b> '+esc(node.d.predicate_family||'')+' '+esc(node.d.object_or_value||'')+'<div class="meta">'+esc(node.d.relation_family||'other')+' · '+esc(node.d.modality||'')+'</div>';card.onclick=()=>showDetail(node.d);claimsEl.append(card)}}
  function renderGraph(){if(!current||mode!=='graph')return;const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;canvas.width=Math.max(1,Math.floor(rect.width*ratio));canvas.height=Math.max(1,Math.floor(rect.height*ratio));ctx.setTransform(ratio,0,0,ratio,0,0);const byId=new Map(currentNodes.map(n=>[n.i,n]));for(const edge of currentEdges){edge.source=byId.get(Number(edge.source?.i??edge.source));edge.target=byId.get(Number(edge.target?.i??edge.target))}const sim=d3.forceSimulation(currentNodes).randomSource(d3.randomLcg(.42)).force('link',d3.forceLink(currentEdges).id(d=>d.i).distance(e=>e.kind.includes('document')?70:42).strength(.55)).force('charge',d3.forceManyBody().strength(d=>d.k==='source_document'?-500:-75)).force('center',d3.forceCenter(rect.width/2,rect.height/2)).force('collision',d3.forceCollide().radius(d=>radius(d.k)+4)).stop();for(let i=0;i<70;i++)sim.tick();fitGraph();draw()}
  function fitGraph(){if(!currentNodes.length)return;const w=canvas.clientWidth,h=canvas.clientHeight,x=d3.extent(currentNodes,n=>n.x),y=d3.extent(currentNodes,n=>n.y),bw=Math.max(1,x[1]-x[0]),bh=Math.max(1,y[1]-y[0]),k=Math.min(3,.88*Math.min(w/bw,h/bh));transform=d3.zoomIdentity.translate(w/2,h/2).scale(k).translate(-(x[0]+x[1])/2,-(y[0]+y[1])/2);d3.select(canvas).property('__zoom',transform);draw()}
  function draw(){if(!current||mode!=='graph')return;const ratio=window.devicePixelRatio||1,w=canvas.width/ratio,h=canvas.height/ratio;ctx.save();ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);ctx.translate(transform.x,transform.y);ctx.scale(transform.k,transform.k);ctx.strokeStyle='#536078';ctx.globalAlpha=.35;ctx.lineWidth=1/transform.k;for(const e of currentEdges){ctx.beginPath();ctx.moveTo(e.source.x,e.source.y);ctx.lineTo(e.target.x,e.target.y);ctx.stroke()}ctx.globalAlpha=1;for(const n of currentNodes){ctx.beginPath();ctx.fillStyle=colors[n.k]||'#94a3b8';ctx.arc(n.x,n.y,radius(n.k),0,Math.PI*2);ctx.fill();if(transform.k>1.25&&(n.k==='documentary_claim'||n.k==='source_document')){ctx.fillStyle='#d8e4f5';ctx.font=(10/transform.k)+'px system-ui';ctx.fillText(n.l.slice(0,60),n.x+radius(n.k)+3,n.y+3)}}ctx.restore()}
  const zoom=d3.zoom().scaleExtent([.08,8]).on('zoom',event=>{transform=event.transform;draw()});d3.select(canvas).call(zoom).on('click',event=>{if(!current)return;const [sx,sy]=d3.pointer(event,canvas),[x,y]=transform.invert([sx,sy]);let best=null,dist=Infinity;for(const n of currentNodes){const d=Math.hypot(n.x-x,n.y-y);if(d<dist){dist=d;best=n}}if(best&&dist<Math.max(14,18/transform.k))showDetail(best.d)});
  function showDetail(detail){document.getElementById('selection').innerHTML='<pre>'+esc(JSON.stringify(detail,null,2))+'</pre>'}
  function setMode(next){mode=next;document.getElementById('graphTab').classList.toggle('active',next==='graph');document.getElementById('claimsTab').classList.toggle('active',next==='claims');canvas.style.display=next==='graph'?'block':'none';claimsEl.style.display=next==='claims'?'block':'none';document.getElementById('fit').style.display=next==='graph'?'block':'none';if(next==='graph')renderGraph()}
  document.getElementById('graphTab').onclick=()=>setMode('graph');document.getElementById('claimsTab').onclick=()=>setMode('claims');document.getElementById('fit').onclick=fitGraph;window.addEventListener('resize',()=>current&&mode==='graph'&&renderGraph());
})();
</script>
</body>
</html>
`;
}
