#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { loadDatabaseSync } from './sqlite.mjs';

const HELP=`Usage: node tools/estate-map/index.mjs --graph <graph.json> [--out <estate.db>]
Build the derived SQLite query index. The default output is estate.db beside the graph.`;
const SAMPLE_CAP=200;
const byId=(a,b)=>a.id.localeCompare(b.id)||stableStringify(a).localeCompare(stableStringify(b));
export function assignEdgeStorageIds(edges){
  const totals=new Map();for(const edge of edges)totals.set(edge.id,(totals.get(edge.id)||0)+1);
  const occurrences=new Map();return edges.slice().sort(byId).map(edge=>{if(totals.get(edge.id)===1)return{edge,storageId:edge.id};const content=sha256(stableStringify(edge)).slice(0,16),key=`${edge.id}#${content}`,ordinal=(occurrences.get(key)||0)+1;occurrences.set(key,ordinal);return{edge,storageId:`${key}:${String(ordinal).padStart(4,'0')}`};});
}
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.has(key)));
const json=value=>stableStringify(value).trim();

function graphTopology(graph){
  const ids=graph.nodes.map(node=>node.id).sort();
  const known=new Set(ids);
  const outgoing=new Map(ids.map(id=>[id,[]]));
  const incoming=new Map(ids.map(id=>[id,[]]));
  const undirected=new Map(ids.map(id=>[id,new Set()]));
  for(const edge of graph.edges.slice().sort(byId)){
    if(!known.has(edge.from)||!known.has(edge.to))continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
    undirected.get(edge.from).add(edge.to);
    undirected.get(edge.to).add(edge.from);
  }
  for(const values of outgoing.values())values.sort();
  for(const values of incoming.values())values.sort();
  return{ids,outgoing,incoming,undirected};
}

function connectedComponents(ids,undirected){
  const parent=new Map(ids.map(id=>[id,id]));
  const find=id=>{let root=id;while(parent.get(root)!==root)root=parent.get(root);while(parent.get(id)!==id){const next=parent.get(id);parent.set(id,root);id=next;}return root;};
  const union=(a,b)=>{const ra=find(a),rb=find(b);if(ra===rb)return;parent.set(ra,ra.localeCompare(rb)<0?ra:rb);parent.set(rb,ra.localeCompare(rb)<0?ra:rb);};
  for(const id of ids)for(const neighbor of undirected.get(id))union(id,neighbor);
  const groups=new Map();for(const id of ids){const root=find(id);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(id);}
  const ordered=[...groups.values()].sort((a,b)=>a[0].localeCompare(b[0]));
  const membership=new Map();
  const components=ordered.map((members,index)=>{const component_id=`component:${String(index+1).padStart(4,'0')}`;for(const id of members)membership.set(id,component_id);return{component_id,size:members.length};});
  return{components,membership};
}

function communities(ids,undirected,nodesById){
  const labels=new Map(ids.map(id=>[id,id]));
  for(let iteration=0;iteration<50;iteration++){
    let changed=false;
    for(const id of ids){
      const neighbors=[...undirected.get(id)].sort();if(!neighbors.length)continue;
      const counts=new Map();for(const neighbor of neighbors){const label=labels.get(neighbor);counts.set(label,(counts.get(label)||0)+1);}
      const best=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
      if(best!==labels.get(id)){labels.set(id,best);changed=true;}
    }
    if(!changed)break;
  }
  const groups=new Map();for(const id of ids){const label=labels.get(id);if(!groups.has(label))groups.set(label,[]);groups.get(label).push(id);}
  const ordered=[...groups.values()].sort((a,b)=>a[0].localeCompare(b[0]));
  const membership=new Map();
  const rows=ordered.map((members,index)=>{
    const community_id=`community:${String(index+1).padStart(4,'0')}`;for(const id of members)membership.set(id,community_id);
    const kinds=new Map();for(const id of members){const kind=nodesById.get(id).kind;kinds.set(kind,(kinds.get(kind)||0)+1);}
    const topKinds=[...kinds].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([kind,count])=>({kind,count}));
    return{community_id,size:members.length,top_kinds_json:JSON.stringify(topKinds),label_hint:topKinds[0]?.kind||'unknown'};
  });
  return{communities:rows,membership};
}

function sampledBrandes(ids,outgoing){
  const score=new Map(ids.map(id=>[id,0]));
  const sources=ids.slice(0,SAMPLE_CAP);
  for(const source of sources){
    const stack=[],predecessors=new Map(ids.map(id=>[id,[]])),sigma=new Map(ids.map(id=>[id,0])),distance=new Map(ids.map(id=>[id,-1]));
    sigma.set(source,1);distance.set(source,0);const queue=[source];
    for(let cursor=0;cursor<queue.length;cursor++){
      const vertex=queue[cursor];stack.push(vertex);
      for(const neighbor of outgoing.get(vertex)){
        if(distance.get(neighbor)<0){distance.set(neighbor,distance.get(vertex)+1);queue.push(neighbor);}
        if(distance.get(neighbor)===distance.get(vertex)+1){sigma.set(neighbor,sigma.get(neighbor)+sigma.get(vertex));predecessors.get(neighbor).push(vertex);}
      }
    }
    const dependency=new Map(ids.map(id=>[id,0]));
    while(stack.length){const vertex=stack.pop();for(const predecessor of predecessors.get(vertex)){const contribution=(sigma.get(predecessor)/sigma.get(vertex))*(1+dependency.get(vertex));dependency.set(predecessor,dependency.get(predecessor)+contribution);}if(vertex!==source)score.set(vertex,score.get(vertex)+dependency.get(vertex));}
  }
  const scale=sources.length&&sources.length<ids.length?ids.length/sources.length:1;
  for(const id of ids)score.set(id,score.get(id)*scale);
  return score;
}

export function computeAnalytics(graph){
  const topology=graphTopology(graph),nodesById=new Map(graph.nodes.map(node=>[node.id,node]));
  const componentData=connectedComponents(topology.ids,topology.undirected);
  const communityData=communities(topology.ids,topology.undirected,nodesById);
  const betweenness=sampledBrandes(topology.ids,topology.outgoing);
  const metrics=topology.ids.map(node_id=>({node_id,degree:topology.incoming.get(node_id).length+topology.outgoing.get(node_id).length,in_degree:topology.incoming.get(node_id).length,out_degree:topology.outgoing.get(node_id).length,betweenness_approx:betweenness.get(node_id),component_id:componentData.membership.get(node_id),community_id:communityData.membership.get(node_id)}));
  return{metrics,components:componentData.components,communities:communityData.communities};
}

export async function buildIndex(graphFile,outFile){
  const DatabaseSync=await loadDatabaseSync();
  const graph=JSON.parse(await fs.readFile(graphFile,'utf8'));
  const nodes=graph.nodes.slice().sort(byId),edges=graph.edges.slice().sort(byId),storedEdges=assignEdgeStorageIds(edges);
  const analytics=computeAnalytics({nodes,edges});
  await fs.mkdir(path.dirname(outFile),{recursive:true});await fs.rm(outFile,{force:true});
  const db=new DatabaseSync(outFile);
  try{
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo TEXT, name TEXT NOT NULL, extra_json TEXT NOT NULL);
      CREATE TABLE edges(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT, src TEXT NOT NULL, dst TEXT, extra_json TEXT NOT NULL);
      CREATE TABLE witnesses(owner_id TEXT NOT NULL, owner_type TEXT NOT NULL, repo TEXT, file TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE TABLE metrics(node_id TEXT PRIMARY KEY, degree INTEGER NOT NULL, in_degree INTEGER NOT NULL, out_degree INTEGER NOT NULL, betweenness_approx REAL NOT NULL, component_id TEXT NOT NULL, community_id TEXT NOT NULL);
      CREATE TABLE components(component_id TEXT PRIMARY KEY, size INTEGER NOT NULL);
      CREATE TABLE communities(community_id TEXT PRIMARY KEY, size INTEGER NOT NULL, top_kinds_json TEXT NOT NULL, label_hint TEXT NOT NULL);
      CREATE VIRTUAL TABLE nodes_fts USING fts5(id,name,content='nodes',content_rowid='rowid');
      CREATE INDEX edges_src_idx ON edges(src); CREATE INDEX edges_dst_idx ON edges(dst); CREATE INDEX witnesses_owner_idx ON witnesses(owner_id,owner_type);
      CREATE INDEX metrics_degree_idx ON metrics(degree DESC,node_id); CREATE INDEX metrics_betweenness_idx ON metrics(betweenness_approx DESC,node_id);`);
    const insertNode=db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?)'),insertEdge=db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?)'),insertWitness=db.prepare('INSERT INTO witnesses VALUES(?,?,?,?,?)');
    const insertMetric=db.prepare('INSERT INTO metrics VALUES(?,?,?,?,?,?,?)'),insertComponent=db.prepare('INSERT INTO components VALUES(?,?)'),insertCommunity=db.prepare('INSERT INTO communities VALUES(?,?,?,?)');
    db.exec('BEGIN');
    for(const node of nodes){insertNode.run(node.id,node.kind,node.repo??null,node.name,json(without(node,new Set(['id','kind','repo','name','witnesses']))));for(const witness of (node.witnesses||[]).slice().sort((a,b)=>a.repo.localeCompare(b.repo)||a.file.localeCompare(b.file)||a.line-b.line))insertWitness.run(node.id,'node',witness.repo??'',witness.file,witness.line);}
    for(const {edge,storageId} of storedEdges){insertEdge.run(storageId,edge.kind,edge.status??null,edge.from,edge.to??null,json({...without(edge,new Set(['id','kind','status','from','to','witnesses'])),...(storageId!==edge.id?{canonical_id:edge.id}:{})}));for(const witness of (edge.witnesses||[]).slice().sort((a,b)=>a.repo.localeCompare(b.repo)||a.file.localeCompare(b.file)||a.line-b.line))insertWitness.run(storageId,'edge',witness.repo??'',witness.file,witness.line);}
    for(const row of analytics.metrics)insertMetric.run(row.node_id,row.degree,row.in_degree,row.out_degree,row.betweenness_approx,row.component_id,row.community_id);
    for(const row of analytics.components)insertComponent.run(row.component_id,row.size);
    for(const row of analytics.communities)insertCommunity.run(row.community_id,row.size,row.top_kinds_json,row.label_hint);
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild'); COMMIT");
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
  return{nodes:nodes.length,edges:edges.length,...analytics};
}

if(import.meta.url===`file://${process.argv[1]}`){
  const {options}=parseArgs(process.argv.slice(2));
  if(options.help||!options.graph){console.log(HELP);process.exit(options.help?0:1);}
  const graphFile=path.resolve(options.graph),outFile=path.resolve(options.out||path.join(path.dirname(graphFile),'estate.db'));
  buildIndex(graphFile,outFile).then(result=>console.log(`Indexed ${result.nodes} nodes and ${result.edges} edges to ${outFile}`)).catch(error=>{console.error(error.message);process.exit(1);});
}
