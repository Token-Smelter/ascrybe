#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { classifyRecord, estateVocabulary } from './analyze-connectivity.mjs';
import { loadDatabaseSync } from './sqlite.mjs';

const HELP=`Usage:
  node tools/estate-map/query.mjs <graph> <command> [argument] [--depth N]
  node tools/estate-map/query.mjs --db <estate.db> <command> [arguments] [--depth N] [--top N]
  node tools/estate-map/query.mjs diff <old-graph.json> <new-graph.json> [--json]
Commands:
  node <id-or-name>       Show node and neighbors
  who-calls <route|repo>  Show inbound HTTP call candidates
  blast-radius <node>     Traverse graph (default depth 2)
  routes <repo>           List exposed routes
  capabilities [type]     Capability contracts: who provides, who requires, who calls
  wiring [status]         Manifest declarations vs wiring reality (wired /
                          declared_unwired / undeterminable)
  topics                  List SNS topics and publishers
  coverage                Show scan coverage
  refusals [reason]       Census of refusal records carried by the graph, by reason code
  queues [discovery.json] Five-queue diagnostic vector read off the persisted graph
  components              List connected components (requires --db)
  communities             List deterministic communities (requires --db)
  central [--top N]       Rank central nodes (requires --db)
  reach <node-id>         Directed reachability, optionally --depth K (requires --db)
  path <src> <dst>        Directed shortest path (requires --db)
  diff                    Compare two canonical graphs`;
const ANALYTICS_COMMANDS=new Set(['components','communities','central','reach','path']);
const BUILD_FIRST='build the index first: node tools/estate-map/index.mjs --graph <graph.json> --out <estate.db>';
const cite=w=>(w||[]).map(v=>`${v.repo}/${v.file}:${v.line}`).join(', ');
/**
 * Census of the refusal records CARRIED BY THE GRAPH. Reads graph.refusals only — never a
 * derivation run — so calling this on a persisted estate-graph.annotated.json is the
 * round-trip proof that a refusal is durable data and not a line in a report.
 */
export function refusalCensus(graph,reasonFilter){
  const records=(graph.refusals||[]).filter(record=>!reasonFilter||record.reason===reasonFilter||`${record.reason}:${record.reason_detail}`===reasonFilter);
  const byReason=new Map(),byState=new Map(),byShape=new Map(),byRule=new Map(),subjects=new Map();
  for(const record of records){
    const key=record.reason==='no_applicable_rule_for_node_kind'&&record.reason_detail?`${record.reason}:${record.reason_detail}`:record.reason;
    byState.set(record.state,(byState.get(record.state)||0)+1);
    byRule.set(record.rule,(byRule.get(record.rule)||0)+1);
    if(record.state!=='refused')continue;
    byReason.set(key,(byReason.get(key)||0)+1);
    byShape.set(record.evidence?.shape||'unknown',(byShape.get(record.evidence?.shape||'unknown')||0)+1);
    const list=subjects.get(key)||[];if(list.length<5){list.push(record.subject);subjects.set(key,list);}
  }
  const rows=map=>[...map].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  return{
    total_records:records.length,
    standing_refusals:byState.get('refused')||0,
    refused_subjects:new Set(records.filter(record=>record.state==='refused').map(record=>record.subject)).size,
    by_reason:rows(byReason).map(([reason,count])=>({reason,count,examples:subjects.get(reason)||[]})),
    by_state:rows(byState).map(([state,count])=>({state,count})),
    by_rule:rows(byRule).map(([rule,count])=>({rule,count})),
    by_evidence_shape:rows(byShape).map(([shape,count])=>({shape,count})),
  };
}
// ---------------------------------------------------------------------------
// The five diagnostic queues (DESIGN.md §3.1), read OFF THE PERSISTED ARTIFACTS.
//
// WHY THIS LIVES IN query.mjs. DESIGN.md §3.2's stopping rule compares queue-depth
// VECTORS across iterations. A vector computed from a pipeline's in-memory state is
// unusable for that: the next iteration is a different process with no such state.
// Putting the vector on the read-back path makes it a function of bytes on disk, so
// any later process — or a human with the graph and nothing else — recomputes the
// identical vector.
//
// HONEST SCOPE. THREE of the five queues are carried by the graph itself
// (`undomained` from graph.overlays vs graph.nodes; `unresolved_b` and `ambiguous_c`
// by classifying graph.unresolved). The other TWO are NOT: discover-entities.mjs
// writes no graph nodes by design ("Read-only: no graph nodes written"), so
// `discovered_undocumented` and `documented_unwitnessed` are read from the sibling
// persisted discovery-report.json. That is still disk, not pipeline memory, but it is
// a second artifact and this function says so rather than pretending otherwise.
export const QUEUE_KEYS=Object.freeze(['undomained','discovered_undocumented','unresolved_b','documented_unwitnessed','ambiguous_c']);
export const QUEUE_SOURCES=Object.freeze({
  undomained:'graph.nodes minus graph.overlays[].subject carrying body.domain',
  discovered_undocumented:'discovery-report.json headline.discovered_undocumented',
  unresolved_b:'graph.unresolved classified by analyze-connectivity.classifyRecord -> category b',
  documented_unwitnessed:'discovery-report.json headline.documented_unwitnessed',
  ambiguous_c:'graph.unresolved classified by analyze-connectivity.classifyRecord -> category c',
});

/** Node ids the persisted graph already assigns a domain (canon seeds + derived overlays). */
export function domainedSubjects(graph){
  return new Set((graph.overlays||[]).filter(record=>record?.body?.domain).map(record=>record.subject));
}

/**
 * Classify every `graph.unresolved` record into the a/b/c/d vocabulary using the SHIPPED
 * classifier. `symbolRepos` is optional: without it, cross-repo symbol records that the
 * facts index would prove in-estate fall to category (a) instead of (b), so the driver
 * passes the facts index from the same extract run.
 */
export function classifyUnresolved(graph,symbolRepos=null){
  const vocabulary=estateVocabulary(graph);
  return (graph.unresolved||[]).map(record=>({record,...classifyRecord(record,vocabulary,symbolRepos)}));
}

export function queueVector(graph,{discovery=null,symbolRepos=null}={}){
  const domained=domainedSubjects(graph);
  const classified=classifyUnresolved(graph,symbolRepos);
  const inCategory=letter=>classified.filter(entry=>entry.category===letter);
  const headline=discovery?.headline||null;
  const vector={
    undomained:(graph.nodes||[]).filter(node=>!domained.has(node.id)).length,
    discovered_undocumented:headline?headline.discovered_undocumented:null,
    unresolved_b:inCategory('b').length,
    documented_unwitnessed:headline?headline.documented_unwitnessed:null,
    ambiguous_c:inCategory('c').length,
  };
  const familyRoll=entries=>[...entries.reduce((map,entry)=>map.set(entry.family,(map.get(entry.family)||0)+1),new Map())]
    .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([family,count])=>({family,count}));
  return {
    vector,
    complete:Object.values(vector).every(value=>value!==null),
    sources:QUEUE_SOURCES,
    totals:{nodes:(graph.nodes||[]).length,edges:(graph.edges||[]).length,unresolved_population:(graph.unresolved||[]).length,domained:domained.size},
    families:{unresolved_b:familyRoll(inCategory('b')),ambiguous_c:familyRoll(inCategory('c'))},
    entries:{
      unresolved_b:inCategory('b').map(entry=>({family:entry.family,why:entry.why,repo:entry.record.repo,file:entry.record.file,line:entry.record.line,kind:entry.record.kind,name:entry.record.name??null,specifier:entry.record.specifier??null})),
      ambiguous_c:inCategory('c').map(entry=>({family:entry.family,why:entry.why,repo:entry.record.repo,file:entry.record.file,line:entry.record.line,kind:entry.record.kind,name:entry.record.name??null,candidates:entry.record.candidates||[]})),
    },
  };
}

function findNodes(graph,term){const q=term.toLowerCase();return graph.nodes.filter(n=>n.id.toLowerCase()===q||n.name.toLowerCase()===q||n.id.toLowerCase().includes(q)||n.name.toLowerCase().includes(q));}
export function runQuery(graph,command,arg,options={}){let lines=[];
  if(command==='node'){for(const n of findNodes(graph,arg||'')){lines.push(`${n.id} [${n.kind}] ${n.name}`);lines.push(`  provenance: ${cite(n.witnesses)}`);for(const e of graph.edges.filter(e=>e.from===n.id||e.to===n.id||e.candidates?.includes(n.id)))lines.push(`  ${e.kind} ${e.from} -> ${e.to||e.candidates.join(' | ')} (${e.status}) [${cite(e.witnesses)}]`);}}
  else if(command==='who-calls'){const ids=new Set(findNodes(graph,arg||'').map(n=>n.id));for(const e of graph.edges.filter(e=>e.kind==='http_call_candidate'&&(ids.has(e.to)||e.candidates?.some(v=>ids.has(v)))))lines.push(`${e.from} -> ${e.to||e.candidates.join(' | ')} (${e.status}) [${cite(e.witnesses)}]`);}
  else if(command==='blast-radius'){const start=findNodes(graph,arg||'');const seen=new Set(start.map(n=>n.id));let frontier=[...seen];const depth=Number(options.depth||2);for(let d=0;d<depth;d++){const next=[];for(const e of graph.edges)if(frontier.includes(e.from)||frontier.includes(e.to)||e.candidates?.some(v=>frontier.includes(v))){lines.push(`${e.kind}: ${e.from} -> ${e.to||e.candidates?.join(' | ')||'?'} (${e.status}) [${cite(e.witnesses)}]`);for(const id of [e.from,e.to,...(e.candidates||[])])if(id&&!seen.has(id)){seen.add(id);next.push(id);}}frontier=next;}lines.unshift(`Blast radius: ${[...seen].sort().join(', ')}`);}
  else if(command==='routes'){
    // Production first: the estate's only route nodes used to be five test
    // fixtures, so a reader who took the first rows at face value read the
    // tool's own mini-estate as the answer. The class is on the node
    // (lib.mjs#classifyProvenance); fixtures are still listed, labelled.
    const rank=node=>node.provenance_class==='production'?0:1;
    const matching=graph.nodes.filter(n=>n.kind==='route'&&(!arg||n.repo===arg)).sort((a,b)=>rank(a)-rank(b)||a.name.localeCompare(b.name));
    for(const n of matching){
      const detail=[n.owner?`owner ${n.owner}`:null,n.auth?`auth ${n.auth}`:n.auth_basis?`auth undeclared (${n.auth_basis})`:null,n.provenance_class||null].filter(Boolean).join(' · ');
      lines.push(`${n.repo} ${n.name}${detail?`  [${detail}]`:''} [${cite(n.witnesses)}]`);
    }
    const refusals=(graph.route_refusals||[]).filter(record=>!arg||record.witnesses.some(witness=>witness.repo===arg));
    if(refusals.length){lines.push(`refused route registrations: ${refusals.length}`);for(const record of refusals)lines.push(`  ${record.reason}  ${cite(record.witnesses)}`);}
  }
  else if(command==='capabilities'){
    // THE QUESTION THE ROUND-2 MAP ARM COULD NOT ANSWER (acceptance-test-round2.md
    // §5.1 / J1): "which capabilities exist, who provides them, who calls them".
    // Production first, for the reason `routes` is: the estate's test fixtures
    // register two of these types too, and a reader taking the first rows at
    // face value must not read a fixture as the answer.
    const rank=node=>node.primary_witness_class==='production'?0:1;
    const matching=graph.nodes.filter(node=>node.kind==='capability'&&(!arg||node.name===arg||node.name.includes(arg)))
      .sort((a,b)=>rank(a)-rank(b)||a.name.localeCompare(b.name));
    if(!matching.length&&!(graph.capability_refusals||[]).length)return'No matches';
    for(const node of matching){
      const detail=[
        node.providers?.length?`provided by ${node.providers.join(', ')}`:'NO CODE PROVIDER',
        node.consumers?.length?`required by ${node.consumers.join(', ')}`:null,
        `${node.call_site_count||0} call site(s)`,
        node.optional_for?.length?`optional for ${node.optional_for.join(', ')}`:null,
        node.orphan||null,
        node.primary_witness_class||null,
      ].filter(Boolean).join(' · ');
      lines.push(`${node.name}  [${detail}]`);
      lines.push(`    registered at ${cite(node.witnesses.slice(0,3))}`);
      for(const edge of graph.edges.filter(e=>e.kind==='calls_capability'&&e.to===node.id))
        lines.push(`    call ${edge.owner||edge.from} via ${edge.receiver} [${cite(edge.witnesses)}]`);
    }
    const refusals=(graph.capability_refusals||[]).filter(record=>!arg||record.reason===arg);
    if(refusals.length){
      lines.push(`refused capability sites: ${refusals.length}`);
      for(const record of refusals)lines.push(`  ${record.direction} ${record.reason}  ${cite(record.witnesses)}`);
    }
  }
  else if(command==='wiring'){
    const records=(graph.manifest_wiring||[]).filter(record=>!arg||record.wiring_status===arg||record.declaration_family===arg||record.owner===arg);
    if(!records.length)return (graph.manifest_wiring||[]).length?'No matches':'No manifest-wiring records in this graph. Re-run merge.mjs over a facts directory that includes plugin manifests.';
    const census=graph.manifest_wiring_census;
    if(census)lines.push(`manifest declarations: ${census.declarations} · wired ${census.by_status.wired} · declared_unwired ${census.by_status.declared_unwired} · undeterminable ${census.by_status.undeterminable}`);
    for(const record of records){
      lines.push(`${record.wiring_status.toUpperCase().padEnd(16)} ${record.declaration_family} ${record.owner} · ${record.subject}${record.optional?' (optional)':''}${record.binding?` · binding ${record.binding}`:''}`);
      lines.push(`    declared at ${cite([record.declaration])}`);
      if(record.wiring_witnesses.length)lines.push(`    wired at ${cite(record.wiring_witnesses.slice(0,3))}`);
      if(record.reason)lines.push(`    ${record.reason}: ${record.reason_detail}`);
      for(const item of record.examined)lines.push(`    examined ${item.relation} ${item.target} -> ${item.value}`);
    }
  }
  else if(command==='topics'){for(const n of graph.nodes.filter(n=>n.kind==='tf_resource'&&n.tf_type==='aws_sns_topic')){lines.push(`${n.name} [${cite(n.witnesses)}]`);for(const e of graph.edges.filter(e=>e.kind==='publishes_to'&&e.to===n.id))lines.push(`  publisher ${e.from} [${cite(e.witnesses)}]`);}}
  else if(command==='coverage'){for(const n of graph.nodes.filter(n=>n.kind==='coverage'))lines.push(`${n.repo}: scanned=${n.files_scanned} skipped=${n.files_skipped} errors=${n.parse_errors.length} [${cite(n.witnesses)}]`);}
  else if(command==='refusals'){
    const census=refusalCensus(graph,arg);
    if(!census.total_records)return`No refusal records in this graph. Merge a *.refusals.jsonl ledger with: node tools/estate-map/annotate.mjs merge <graph-dir> <overlays-dir>`;
    lines.push(`refusal records: ${census.total_records} (standing ${census.standing_refusals} over ${census.refused_subjects} distinct node(s))`);
    lines.push('by state:');for(const row of census.by_state)lines.push(`  ${String(row.count).padStart(6)}  ${row.state}`);
    lines.push('by reason (standing refusals only):');for(const row of census.by_reason)lines.push(`  ${String(row.count).padStart(6)}  ${row.reason}\n            e.g. ${row.examples.slice(0,2).join(', ')}`);
    lines.push('by rule:');for(const row of census.by_rule)lines.push(`  ${String(row.count).padStart(6)}  ${row.rule}`);
    lines.push('by evidence shape:');for(const row of census.by_evidence_shape)lines.push(`  ${String(row.count).padStart(6)}  ${row.shape}`);
  }
  else if(command==='queues'){
    const report=options.queueReport||queueVector(graph);
    lines.push(`nodes=${report.totals.nodes} edges=${report.totals.edges} unresolved_population=${report.totals.unresolved_population}`);
    for(const key of QUEUE_KEYS)lines.push(`  ${String(report.vector[key]??'(unavailable)').padStart(6)}  ${key}\n            source: ${report.sources[key]}`);
    if(!report.complete)lines.push('  NOTE: pass a discovery-report.json to fill discovered_undocumented / documented_unwitnessed.');
    lines.push('unresolved (b) families:');for(const row of report.families.unresolved_b)lines.push(`  ${String(row.count).padStart(6)}  ${row.family}`);
    lines.push('ambiguous (c) families:');for(const row of report.families.ambiguous_c)lines.push(`  ${String(row.count).padStart(6)}  ${row.family}`);
  }
  else if(ANALYTICS_COMMANDS.has(command))throw new Error(BUILD_FIRST);
  else throw new Error(`Unknown command: ${command}`);return lines.length?lines.join('\n'):'No matches';}

const numericOption=(value,fallback,{minimum=0}={})=>{const number=value===undefined?fallback:Number(value);if(!Number.isInteger(number)||number<minimum)throw new Error(`Expected an integer >= ${minimum}, received ${value}`);return number;};
const edgeRow=row=>({id:row.id,kind:row.kind,src:row.src,dst:row.dst,status:row.status});
function graphRows(db){return db.prepare('SELECT id,kind,status,src,dst FROM edges WHERE dst IS NOT NULL ORDER BY id').all();}
function traversal(db,start,maxDepth=Infinity,stopAt=null){
  const exists=db.prepare('SELECT 1 FROM nodes WHERE id=?').get(start);if(!exists)throw new Error(`Unknown node: ${start}`);
  const edges=graphRows(db),outgoing=new Map();for(const edge of edges){if(!outgoing.has(edge.src))outgoing.set(edge.src,[]);outgoing.get(edge.src).push(edge);}
  const distance=new Map([[start,0]]),previous=new Map(),queue=[start];
  for(let cursor=0;cursor<queue.length;cursor++){const current=queue[cursor],depth=distance.get(current);if(current===stopAt)break;if(depth>=maxDepth)continue;for(const edge of outgoing.get(current)||[])if(!distance.has(edge.dst)){distance.set(edge.dst,depth+1);previous.set(edge.dst,{node:current,edge});queue.push(edge.dst);}}
  return{distance,previous};
}
function queryComponents(db){
  const components=db.prepare('SELECT component_id,size FROM components ORDER BY component_id').all().map(row=>({...row,nodes:[]}));const byComponent=new Map(components.map(row=>[row.component_id,row]));
  for(const row of db.prepare('SELECT node_id,component_id FROM metrics ORDER BY component_id,node_id').all())byComponent.get(row.component_id).nodes.push(row.node_id);
  return{components};
}
function queryCommunities(db){
  const communities=db.prepare('SELECT community_id,size,top_kinds_json,label_hint FROM communities ORDER BY community_id').all().map(row=>({...row,top_kinds:JSON.parse(row.top_kinds_json),nodes:[]}));for(const row of communities)delete row.top_kinds_json;
  const byCommunity=new Map(communities.map(row=>[row.community_id,row]));for(const row of db.prepare('SELECT node_id,community_id FROM metrics ORDER BY community_id,node_id').all())byCommunity.get(row.community_id).nodes.push(row.node_id);
  return{communities};
}
function queryCentral(db,options){const top=numericOption(options.top,20,{minimum:1});const nodes=db.prepare(`SELECT n.id,n.kind,n.repo,n.name,m.degree,m.in_degree,m.out_degree,m.betweenness_approx,m.component_id,m.community_id
  FROM metrics m JOIN nodes n ON n.id=m.node_id ORDER BY m.betweenness_approx DESC,m.degree DESC,n.id LIMIT ?`).all(top);return{top,nodes};}
function queryReach(db,start,options){
  if(!start)throw new Error('reach requires <node-id>');const depth=numericOption(options.depth,2,{minimum:0});const {distance,previous}=traversal(db,start,depth);
  const nodes=[...distance].sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0])).map(([id,distance])=>({id,distance}));
  const edges=[...previous.values()].map(value=>edgeRow(value.edge)).sort((a,b)=>a.id.localeCompare(b.id));return{start,depth,nodes,edges};
}
function queryPath(db,src,dst){
  if(!src||!dst)throw new Error('path requires <src> <dst>');const {distance,previous}=traversal(db,src,Infinity,dst);if(!distance.has(dst))return{src,dst,found:false,distance:null,nodes:[],edges:[]};
  const nodes=[dst],edges=[];let current=dst;while(current!==src){const step=previous.get(current);edges.push(edgeRow(step.edge));current=step.node;nodes.push(current);}nodes.reverse();edges.reverse();return{src,dst,found:true,distance:edges.length,nodes,edges};
}
function queryIndexedNode(db,term=''){
  const q=`%${term.toLowerCase()}%`;const nodes=db.prepare(`SELECT id,kind,repo,name,extra_json FROM nodes WHERE lower(id)=lower(?) OR lower(name)=lower(?) OR lower(id) LIKE ? OR lower(name) LIKE ? ORDER BY id`).all(term,term,q,q).map(row=>({...row,extra:JSON.parse(row.extra_json)}));
  for(const row of nodes)delete row.extra_json;return{nodes};
}
function queryIndexedRoutes(db,repo){return{routes:db.prepare(`SELECT id,repo,name,extra_json FROM nodes WHERE kind='route' AND (? IS NULL OR repo=?) ORDER BY name,id`).all(repo??null,repo??null).map(row=>{const result={id:row.id,repo:row.repo,name:row.name,...JSON.parse(row.extra_json)};delete result.extra_json;return result;})};}
function queryWhoCalls(db,term=''){
  const ids=new Set(queryIndexedNode(db,term).nodes.map(row=>row.id));
  const calls=db.prepare(`SELECT id,kind,status,src,dst,extra_json FROM edges WHERE kind='http_call_candidate' ORDER BY id`).all().map(row=>{
    const candidates=JSON.parse(row.extra_json).candidates||[];
    return{...edgeRow(row),...(candidates.length?{candidates}: {})};
  }).filter(row=>ids.has(row.dst)||row.candidates?.some(candidate=>ids.has(candidate)));
  return{term,calls};
}
export function runDbQuery(db,command,args=[],options={}){
  if(command==='components')return queryComponents(db);
  if(command==='communities')return queryCommunities(db);
  if(command==='central')return queryCentral(db,options);
  if(command==='reach')return queryReach(db,args[0],options);
  if(command==='path')return queryPath(db,args[0],args[1]);
  if(command==='node')return queryIndexedNode(db,args[0]);
  if(command==='routes')return queryIndexedRoutes(db,args[0]);
  if(command==='who-calls')return queryWhoCalls(db,args[0]);
  throw new Error(`Command not available through --db: ${command}`);
}

function groupedDelta(oldItems,newItems){
  const key=item=>item.id||stableStringify(item).trim();const oldMap=new Map(oldItems.map(item=>[key(item),item])),newMap=new Map(newItems.map(item=>[key(item),item]));const result={};
  for(const [direction,source,other] of [['added',newMap,oldMap],['removed',oldMap,newMap]])for(const [id,item] of source)if(!other.has(id)){result[item.kind]??={added:[],removed:[]};result[item.kind][direction].push(id);}
  return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)).map(([kind,value])=>[kind,{added:value.added.sort(),removed:value.removed.sort()}]));
}
export function diffGraphs(oldGraph,newGraph,{oldDigest,newDigest}={}){
  const oldCoverage=new Map(oldGraph.nodes.filter(node=>node.kind==='coverage').map(node=>[node.repo,node]));const newCoverage=new Map(newGraph.nodes.filter(node=>node.kind==='coverage').map(node=>[node.repo,node]));const coverage={};
  for(const repo of [...new Set([...oldCoverage.keys(),...newCoverage.keys()])].sort()){const before=oldCoverage.get(repo),after=newCoverage.get(repo);const oldErrors=before?.parse_errors?.length||0,newErrors=after?.parse_errors?.length||0;coverage[repo]={files_scanned:(after?.files_scanned||0)-(before?.files_scanned||0),files_skipped:(after?.files_skipped||0)-(before?.files_skipped||0),parse_errors:newErrors-oldErrors};}
  return {digests:{old:oldDigest||sha256(stableStringify(oldGraph)),new:newDigest||sha256(stableStringify(newGraph))},nodes:groupedDelta(oldGraph.nodes,newGraph.nodes),edges:groupedDelta(oldGraph.edges,newGraph.edges),coverage};
}
export function formatDiff(diff){const lines=[`Digests: ${diff.digests.old} -> ${diff.digests.new}`];for(const area of ['nodes','edges']){lines.push(`${area[0].toUpperCase()+area.slice(1)}:`);const entries=Object.entries(diff[area]);if(!entries.length)lines.push('  no changes');for(const [kind,change] of entries){lines.push(`  ${kind}: +${change.added.length} -${change.removed.length}`);for(const id of change.added)lines.push(`    + ${id}`);for(const id of change.removed)lines.push(`    - ${id}`);}}lines.push('Coverage deltas:');for(const [repo,delta] of Object.entries(diff.coverage))lines.push(`  ${repo}: scanned ${delta.files_scanned>=0?'+':''}${delta.files_scanned}, skipped ${delta.files_skipped>=0?'+':''}${delta.files_skipped}, errors ${delta.parse_errors>=0?'+':''}${delta.parse_errors}`);return lines.join('\n');}

if(import.meta.url===`file://${process.argv[1]}`){
  const {positional,options}=parseArgs(process.argv.slice(2));
  if(options.help){console.log(HELP);process.exit(0);}
  try{
    if(options.db){
      if(!positional[0])throw new Error('A query command is required with --db');const dbFile=path.resolve(options.db);try{await fs.access(dbFile);}catch{throw new Error(`${BUILD_FIRST} (database not found: ${dbFile})`);}
      const DatabaseSync=await loadDatabaseSync();
      const db=new DatabaseSync(dbFile,{readOnly:true});try{console.log(stableStringify(runDbQuery(db,positional[0],positional.slice(1),options)).trim());}finally{db.close();}
    }else if(positional[0]==='diff'){
      if(!positional[2])throw new Error('diff requires <old-graph.json> <new-graph.json>');const [oldText,newText]=await Promise.all([fs.readFile(path.resolve(positional[1]),'utf8'),fs.readFile(path.resolve(positional[2]),'utf8')]);const diff=diffGraphs(JSON.parse(oldText),JSON.parse(newText),{oldDigest:sha256(oldText),newDigest:sha256(newText)});console.log(options.json?stableStringify(diff).trim():formatDiff(diff));
    }else{
      const command=positional[1]||positional[0];if(ANALYTICS_COMMANDS.has(command))throw new Error(BUILD_FIRST);if(positional.length<2){console.log(HELP);process.exit(1);}const graph=JSON.parse(await fs.readFile(path.resolve(positional[0]),'utf8'));
      if(command==='refusals'&&options.json){console.log(stableStringify(refusalCensus(graph,positional[2])).trim());}
      else if(command==='queues'){
        const discovery=positional[2]?JSON.parse(await fs.readFile(path.resolve(positional[2]),'utf8')):null;
        const report=queueVector(graph,{discovery});
        console.log(options.json?stableStringify(report).trim():runQuery(graph,'queues',undefined,{...options,queueReport:report}));
      }
      else console.log(runQuery(graph,command,positional[2],options));
    }
  }catch(error){console.error(error.message);process.exit(1);}
}
