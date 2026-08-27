#!/usr/bin/env node
// Export a remap output as ONE self-contained HTML file: no server, no fetches, data embedded
// as compact integer-indexed arrays, rendering strictly lazy (search first, expand on click).
// Usage: node scripts/export-static-map.mjs --map <map dir> --out <file.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--map') held.map = resolve(value);
    else if (flag === '--out') held.out = resolve(value);
    else if (flag === '--mode') held.mode = value;
    else if (flag === '--focus') held.focus = value;
    else if (flag === '--depth') held.depth = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!held.map || !held.out) throw new Error('--map and --out are required');
  return held;
}

export function exportStaticMap({ map, out, mode = 'full', focus = null, depth = 1 }) {
  const graph = JSON.parse(readFileSync(join(map, 'adjacency.json'), 'utf8'));
  // Lite mode embeds only the connected subgraph so the artifact stays small enough for
  // constrained transports; isolated entities are counted, named as omitted, never implied absent.
  let ids = Object.keys(graph.nodes);
  let omitted = 0;
  let focusStart = null;
  if (focus) {
    // Focused snapshot: breadth-first neighbourhood of the first exact-label-or-path match,
    // capped at 400 nodes so the artifact stays small on constrained transports.
    const needle = focus.toLowerCase();
    // Highest-degree match wins: a path substring also matches every symbol inside that file,
    // and focusing a leaf when the user named a hub would silently show almost nothing.
    const matches = ids.filter(id => (graph.nodes[id].l || '').toLowerCase().includes(needle)
      || (graph.nodes[id].ns || '').toLowerCase().includes(needle));
    if (!matches.length) throw new Error(`--focus matched no entity: ${focus}`);
    const start = matches.reduce((best, id) =>
      (graph.adj[id]?.length || 0) > (graph.adj[best]?.length || 0) ? id : best);
    focusStart = start;
    const keep = new Set([start]);
    let frontier = [start];
    for (let level = 0; level < depth && keep.size < 400; level += 1) {
      const next = [];
      for (const id of frontier) {
        for (const [, other] of graph.adj[id] || []) {
          if (keep.size >= 400) break;
          if (!keep.has(other)) { keep.add(other); next.push(other); }
        }
      }
      frontier = next;
    }
    omitted = ids.length - keep.size;
    ids = ids.filter(id => keep.has(id));
  } else if (mode === 'lite') {
    const linked = new Set();
    for (const [from, rows] of Object.entries(graph.adj)) {
      if (rows.length) { linked.add(from); for (const [, to] of rows) linked.add(to); }
    }
    omitted = ids.length - linked.size;
    ids = ids.filter(id => linked.has(id));
  }
  const indexById = new Map(ids.map((id, index) => [id, index]));
  // Compact payload: parallel arrays, integer edges, edge-kind dictionary.
  const labels = ids.map(id => graph.nodes[id].l || '');
  const namespaces = ids.map(id => graph.nodes[id].ns || '');
  const kinds = ids.map(id => graph.nodes[id].r || '');
  const kindDict = [];
  const kindIndex = new Map();
  const edges = [];
  const seen = new Set();
  for (const [from, rows] of Object.entries(graph.adj)) {
    for (const [type, to] of rows) {
      const a = indexById.get(from), b = indexById.get(to);
      if (a === undefined || b === undefined) continue;
      const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!kindIndex.has(type)) { kindIndex.set(type, kindDict.length); kindDict.push(type); }
      edges.push([a, b, kindIndex.get(type)]);
    }
  }
  // Directory dictionary: namespaces repeat their directories thousands of times.
  const dirDict = [];
  const dirIndex = new Map();
  const nsPacked = namespaces.map(ns => {
    const cut = ns.lastIndexOf('/');
    const dir = cut < 0 ? '' : ns.slice(0, cut);
    const base = cut < 0 ? ns : ns.slice(cut + 1);
    if (!dirIndex.has(dir)) { dirIndex.set(dir, dirDict.length); dirDict.push(dir); }
    return [dirIndex.get(dir), base];
  });
  const payload = { labels, ns: nsPacked, dirDict, kinds, edges, kindDict,
    omitted, mode, focusIndex: focus ? indexById.get(focusStart) : null,
    provenance: graph.provenance, counts: graph.counts };
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ascrybe — self-contained</title>
<style>
:root{--ink:#0a0d12;--ink2:#121824;--line:#212b3a;--line2:#2f3d55;--text:#e8eef7;--muted:#8494ad;--dim:#5b6a83;--entity:#7fd1c1;--hot:#e0a35c}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--ink);color:var(--text);overflow:hidden;display:flex;flex-direction:column;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:9px 16px;border-bottom:1px solid var(--line);background:var(--ink2);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
h1{margin:0;font-size:14px;letter-spacing:.15em;text-transform:uppercase}
#stats{color:var(--muted);font-size:12px}
main{flex:1;display:flex;min-height:0}
#wrap{flex:1;position:relative;min-width:0}canvas{display:block;width:100%;height:100%;cursor:grab}
aside{width:400px;border-left:1px solid var(--line);background:var(--ink2);display:flex;flex-direction:column;min-height:0}
.bar{padding:9px 12px;border-bottom:1px solid var(--line)}
input{width:100%;background:var(--ink);border:1px solid var(--line2);color:var(--text);padding:8px 10px;border-radius:3px;font:12px/1.4 ui-monospace,monospace}
input:focus{outline:none;border-color:var(--entity)}
.panel{flex:1;overflow:auto;padding:12px}
h2{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.hit{padding:7px 9px;border:1px solid var(--line);border-radius:3px;margin-bottom:5px;cursor:pointer;font:12px/1.4 ui-monospace,monospace}
.hit:hover{border-color:var(--entity)}.hit .p{color:var(--dim);font-size:11px;margin-top:2px}
.note{color:var(--dim);font-size:11px;line-height:1.5;margin-top:12px;border-top:1px solid var(--line);padding-top:9px}
.hud{position:absolute;left:12px;bottom:12px;font:11px/1.5 ui-monospace,monospace;color:var(--dim);background:rgba(10,13,18,.85);padding:7px 10px;border:1px solid var(--line);border-radius:3px}
</style></head><body>
<header><h1>Ascrybe</h1><span id="stats"></span></header>
<main><div id="wrap"><canvas id="c"></canvas>
<div class="hud">search → click a result → click nodes to expand · drag pan · wheel zoom</div></div>
<aside><div class="bar"><input id="q" placeholder="search 16k entities by name or path…" autocomplete="off"></div>
<div class="panel" id="panel"><h2>Start</h2><div class="note">Everything is embedded in this one
file — nothing loads from a server. The canvas stays empty until you search and place an entity;
expansion follows real receipted edges only.</div></div></aside></main>
<script>
const D=${JSON.stringify(payload)};
D.namespaces=D.ns.map(([d,b])=>D.dirDict[d]?D.dirDict[d]+'/'+b:b);
const adj=new Map();
for(const [a,b,k] of D.edges){(adj.get(a)||adj.set(a,[]).get(a)).push([b,k]);(adj.get(b)||adj.set(b,[]).get(b)).push([a,k]);}
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),panel=document.getElementById('panel');
const N=new Map(),L=[];let view={x:0,y:0,k:1},sel=null,drag=null,pan=null;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short=s=>s.length>34?s.slice(0,33)+'…':s;
function fit(){const r=cv.getBoundingClientRect(),d=window.devicePixelRatio||1;cv.width=r.width*d;cv.height=r.height*d;ctx.setTransform(d,0,0,d,0,0);}
window.addEventListener('resize',fit);fit();
document.getElementById('stats').textContent=
  D.labels.length.toLocaleString()+' connected entities · '+D.edges.length.toLocaleString()+' edges · mapped '
  +D.provenance.source_head.slice(0,7)+' · code plane'
  +(D.omitted?' · '+D.omitted.toLocaleString()+' isolated entities omitted from this snapshot':'');
function addNode(i,at){if(N.has(i))return N.get(i);const r=cv.getBoundingClientRect();
  const n={i,x:(at?at.x:r.width/2)+(Math.random()-.5)*90,y:(at?at.y:r.height/2)+(Math.random()-.5)*90,vx:0,vy:0,expanded:false};
  N.set(i,n);return n;}
function addLink(a,b,k){if(L.some(l=>(l.a===a&&l.b===b)||(l.a===b&&l.b===a)))return;L.push({a,b,k});}
function tick(){const arr=[...N.values()];for(const n of arr){n.vx*=.86;n.vy*=.86;}
  for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){const a=arr[i],b=arr[j];
    let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy||1;if(d2>90000)continue;const f=1800/d2,d=Math.sqrt(d2);
    a.vx-=dx/d*f;a.vy-=dy/d*f;b.vx+=dx/d*f;b.vy+=dy/d*f;}
  for(const l of L){const a=N.get(l.a),b=N.get(l.b);if(!a||!b)continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,f=(d-120)*.012;
    a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;}
  const r=cv.getBoundingClientRect();
  for(const n of arr){n.vx+=(r.width/2-n.x)*.0012;n.vy+=(r.height/2-n.y)*.0012;if(n!==drag){n.x+=n.vx;n.y+=n.vy;}}}
function draw(){const r=cv.getBoundingClientRect();ctx.clearRect(0,0,r.width,r.height);
  ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.k,view.k);ctx.lineWidth=1;
  ctx.strokeStyle='rgba(127,209,193,.4)';
  for(const l of L){const a=N.get(l.a),b=N.get(l.b);if(!a||!b)continue;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  for(const n of N.values()){ctx.beginPath();ctx.arc(n.x,n.y,8,0,6.284);
    ctx.fillStyle=D.kinds[n.i]==='module'?'#7fd1c1':D.kinds[n.i]==='http_route'?'#e0a35c':'#8ea2c8';
    ctx.fill();if(n===sel){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1;}
    if(view.k>.55){ctx.fillStyle='#cdd8e8';ctx.font='11px ui-monospace,monospace';
      ctx.fillText(short(D.labels[n.i]),n.x+12,n.y+3);}}
  ctx.restore();}
(function loop(){tick();draw();requestAnimationFrame(loop);})();
setTimeout(()=>{fit();
  if(!N.size){
    let seed=D.focusIndex;
    if(seed==null){let best=-1;for(const [i,rows] of adj){if(rows.length>best){best=rows.length;seed=i;}}}
    if(seed!=null){const n=addNode(seed,null);sel=n;expand(n);detail(n);}
  }},120);
const toW=(px,py)=>({x:(px-view.x)/view.k,y:(py-view.y)/view.k});
function pick(px,py){const w=toW(px,py);let best=null,bd=324;
  for(const n of N.values()){const d=(n.x-w.x)**2+(n.y-w.y)**2;if(d<bd){bd=d;best=n;}}return best;}
cv.addEventListener('mousedown',e=>{const n=pick(e.offsetX,e.offsetY);
  if(n)drag=n;else{pan={x:e.offsetX-view.x,y:e.offsetY-view.y};cv.style.cursor='grabbing';}});
cv.addEventListener('mousemove',e=>{if(drag){const w=toW(e.offsetX,e.offsetY);drag.x=w.x;drag.y=w.y;drag.vx=drag.vy=0;}
  else if(pan){view.x=e.offsetX-pan.x;view.y=e.offsetY-pan.y;}});
window.addEventListener('mouseup',()=>{drag=null;pan=null;cv.style.cursor='grab';});
cv.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.12:1/1.12,w=toW(e.offsetX,e.offsetY);
  view.k=Math.max(.15,Math.min(4,view.k*f));view.x=e.offsetX-w.x*view.k;view.y=e.offsetY-w.y*view.k;},{passive:false});
cv.addEventListener('click',e=>{const n=pick(e.offsetX,e.offsetY);if(n){sel=n;expand(n);detail(n);}});
function expand(n){if(n.expanded)return;n.expanded=true;
  for(const [o,k] of (adj.get(n.i)||[]).slice(0,40)){addNode(o,n);addLink(n.i,o,k);}}
function detail(n){const rows=(adj.get(n.i)||[]);
  panel.innerHTML='<h2>'+esc(D.kinds[n.i]||'entity')+'</h2>'
   +'<div style="font:12px/1.5 ui-monospace,monospace;word-break:break-all">'
   +'<div><b style="color:var(--muted)">name</b> '+esc(D.labels[n.i])+'</div>'
   +'<div><b style="color:var(--muted)">where</b> '+esc(D.namespaces[n.i])+'</div>'
   +'<div><b style="color:var(--muted)">degree</b> '+rows.length+'</div></div>'
   +'<h2 style="margin-top:14px">Connected ('+rows.length+')</h2>'
   +rows.slice(0,60).map(([o,k])=>'<div class="hit" data-i="'+o+'"><span style="color:var(--dim);font-size:10px">'
     +esc(D.kindDict[k])+'</span> <span style="color:var(--entity)">'+esc(short(D.labels[o]))+'</span>'
     +'<div class="p">'+esc(D.namespaces[o])+'</div></div>').join('');
  panel.querySelectorAll('.hit').forEach(el=>el.onclick=()=>{const i=Number(el.dataset.i);
    const node=addNode(i,sel);sel=node;expand(node);detail(node);});}
const q=document.getElementById('q');let timer=null;
q.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{
  const term=q.value.trim().toLowerCase();
  if(!term){panel.innerHTML='<h2>Start</h2>';return;}
  const hits=[];
  for(let i=0;i<D.labels.length&&hits.length<60;i++){
    if(D.labels[i].toLowerCase().includes(term)||D.namespaces[i].toLowerCase().includes(term))hits.push(i);}
  panel.innerHTML='<h2>'+hits.length+(hits.length>=60?'+':'')+' matches</h2>'
   +hits.map(i=>'<div class="hit" data-i="'+i+'"><span style="color:var(--entity)">'+esc(D.labels[i])+'</span>'
     +(adj.get(i)?' <span style="color:var(--hot);font-size:10px">'+adj.get(i).length+' edges</span>':'')
     +'<div class="p">'+esc(D.namespaces[i])+'</div></div>').join('');
  panel.querySelectorAll('.hit').forEach(el=>el.onclick=()=>{const i=Number(el.dataset.i);
    const node=addNode(i,null);sel=node;expand(node);detail(node);});
},160);});
</script></body></html>`;
  writeFileSync(out, html);
  console.log(`STATIC bytes=${Buffer.byteLength(html)} nodes=${ids.length} edges=${edges.length}`);
  return { bytes: Buffer.byteLength(html), nodes: ids.length, edges: edges.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { exportStaticMap(parse(process.argv.slice(2))); }
  catch (error) { console.error(`FAIL export: ${error.stack || error.message}`); process.exitCode = 1; }
}
