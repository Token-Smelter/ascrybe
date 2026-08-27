#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { factKey, parseArgs, stableStringify } from './lib.mjs';

export const CONSERVATION_SCHEMA='estate-map/conservation-gates/v1';
export const DERIVABILITY_RECORD_TYPES=Object.freeze(['BUG','REFUSAL','SCOPE']);
export const DERIVABILITY_CLASSIFICATIONS=Object.freeze({
  BUG:'evidence_exists_edge_omitted',
  REFUSAL:'evidence_lacks_required_membership',
  SCOPE:'relevant_evidence_not_examined',
});

// This is the closed list of diagnostic states the canonical graph stamps today. Projection
// coverage is checked against this list at every merge, so adding a state here without adding a
// selectable read surface fails the build even when the current corpus happens to contain zero
// subjects in that state.
export const FIRST_CLASS_DIAGNOSTIC_STATES=Object.freeze([
  Object.freeze({id:'envelope.emitted_never_consumed',subject_kind:'envelope_kind',field:'orphan',value:'emitted_never_consumed'}),
  Object.freeze({id:'envelope.consumed_never_emitted',subject_kind:'envelope_kind',field:'orphan',value:'consumed_never_emitted'}),
  Object.freeze({id:'envelope.isolated',subject_kind:'envelope_kind',field:'orphan',value:'isolated'}),
  Object.freeze({id:'domain_prepass.assigned',family:'domain_prepass_receipts',field:'status',value:'assigned'}),
  Object.freeze({id:'domain_prepass.ambiguous',family:'domain_prepass_receipts',field:'status',value:'ambiguous'}),
  Object.freeze({id:'domain_prepass.no_anchor',family:'domain_prepass_receipts',field:'status',value:'no_anchor'}),
  Object.freeze({id:'domain_prepass.ineligible_subject',family:'domain_prepass_receipts',field:'status',value:'ineligible_subject'}),
  Object.freeze({id:'domain_prepass.fixture_only',family:'domain_prepass_receipts',field:'status',value:'fixture_only'}),
  // Step-3 WP1-3 record families are persisted receipts, not graph nodes. Keeping these
  // registered here makes an unprojected campaign sidecar fail conservation even at n=0.
  Object.freeze({id:'adjudication.candidate_packet_prepared',family:'adjudication_records',field:'record_kind',value:'candidate_packet'}),
  Object.freeze({id:'adjudication.requires_model',family:'adjudication_records',field:'semantic.status',value:'requires_model'}),
  // Cartography Spine v0 diagnostic states. The cartography view compiler is a separate
  // digest-bound DAG stage (pipeline.mjs `cartography`) that materializes its own cartographic
  // records; these states register its connectivity/orphan and integrity diagnostics with the
  // global projection-coverage gate so a cartography projection that ever ships an unselectable
  // diagnostic state fails the build. The covering selectable surface is `cartography-spine`
  // in projection.mjs. At n=0 subjects in the annotated graph they remain covered, not gaps.
  Object.freeze({id:'cartography.orphan_module_import',family:'cartography_diagnostics',field:'projection_id',value:'module-import'}),
  Object.freeze({id:'cartography.orphan_event_flow',family:'cartography_diagnostics',field:'projection_id',value:'event-flow'}),
  Object.freeze({id:'cartography.unaccounted_integrity',family:'cartography_diagnostics',field:'diagnostic',value:'unaccounted'}),
]);

const FACT_KINDS_BY_NODE_KIND=Object.freeze({
  repo:['repo'],service:['repo'],tf_module:['tf_resource','tf_declaration','tf_module_call','tf_workspace'],
  environment:['tf_resource','tf_declaration','tf_module_call','tf_workspace'],tf_resource:['tf_resource'],
  route:['http_route'],package:['dep'],external_internal_package:['dep'],config_key:['config_key'],
  sql_object:['sql_object'],coverage:['coverage'],module:['module'],swift_framework:['import'],
  envelope_kind:['envelope_flow'],capability:['capability_flow'],
});
const witnessKey=value=>`${value?.repo||''}\0${value?.file||''}\0${value?.line||''}`;
const edgeTargets=edge=>edge.to?[edge.to]:(edge.candidates||[]);
const edgeHasFactWitness=(edge,fact)=>(edge.witnesses||[]).some(witness=>witnessKey(witness)===witnessKey(fact));
const edgeTouches=(edge,subject)=>edge.from===subject||edgeTargets(edge).includes(subject);
const edgeConnectsCanonical=(edge,nodeIds)=>nodeIds.has(edge.from)&&edgeTargets(edge).some(target=>nodeIds.has(target));

function contractFor(node,fact){
  const incidence=(...edgeKinds)=>({kind:'incidence',edgeKinds});
  const terminal=reason=>({kind:'terminal',reason});
  switch(node.kind){
    case'repo':case'service':return incidence('declares_service');
    case'tf_resource':return incidence('declares_resource','member_of');
    case'environment':return incidence('member_of');
    case'route':return incidence('exposes_route');
    case'package':return incidence('declares_dependency');
    case'external_internal_package':return incidence('consumes_package');
    case'config_key':return incidence('declares_config');
    case'sql_object':return incidence('declares_sql_object');
    case'coverage':return incidence('covers');
    case'swift_framework':return incidence('imports_framework');
    case'envelope_kind':return incidence(fact.direction==='emit'?'emits':'consumes');
    case'capability':return incidence({provide:'provides_capability',require:'requires_capability',call:'calls_capability'}[fact.direction]||'capability_flow');
    case'tf_module':return fact.kind==='tf_resource'?incidence('member_of'):terminal('fact_declares_module_scope_but_no_relation_target');
    case'module':return terminal('fact_declares_source_file_identity_but_no_dependency_relation');
    default:return null;
  }
}

/**
 * Reconstruct the fact that minted each canonical node from the node's leading witness. This is
 * deliberately graph-driven: one package node may be mentioned by many dependency facts, but only
 * the first call to addNode minted it. Auditing facts indiscriminately would count duplicate facts
 * as duplicate conservation failures and would not measure the representation that was built.
 */
export function deriveMintRecords(facts,graph){
  const factsByWitness=new Map();
  for(const fact of facts){const key=witnessKey(fact),list=factsByWitness.get(key)||[];list.push(fact);factsByWitness.set(key,list);}
  return(graph.nodes||[]).map(node=>{
    const compatibleKinds=FACT_KINDS_BY_NODE_KIND[node.kind];
    if(!compatibleKinds)return{node,fact:null,contract:null,problem:'unregistered_node_kind'};
    let fact=null;
    for(const witness of node.witnesses||[]){
      fact=(factsByWitness.get(witnessKey(witness))||[]).find(candidate=>compatibleKinds.includes(candidate.kind)
        &&(node.kind!=='config_key'||candidate.role==='declared')
        &&(node.kind!=='swift_framework'||candidate.import_kind==='framework')
        &&(node.kind!=='envelope_kind'||candidate.status!=='wildcard'));
      if(fact)break;
    }
    if(!fact)return{node,fact:null,contract:null,problem:'mint_fact_not_found_in_examined_facts'};
    return{node,fact,contract:contractFor(node,fact),problem:null};
  }).sort((a,b)=>a.node.id.localeCompare(b.node.id));
}

export function auditFactRepresentation(facts,graph){
  const records=[],derivability=[],nodeIds=new Set((graph.nodes||[]).map(node=>node.id));
  for(const mint of deriveMintRecords(facts,graph)){
    const base={schema:CONSERVATION_SCHEMA,subject:mint.node.id,subject_kind:mint.node.kind};
    if(mint.problem||!mint.contract){
      const detail=mint.problem||'node kind has no fact-to-representation contract';
      records.push({...base,record_kind:'scope_gap',fact_kind:mint.fact?.kind||null,fact_key:mint.fact?factKey(mint.fact):null,expected_incidence:[],observed_edges:[],terminal_reason:null,detail});
      derivability.push({...base,record_type:'SCOPE',classification:DERIVABILITY_CLASSIFICATIONS.SCOPE,detail,examined:['graph.nodes[].witnesses','facts/*.jsonl'],witnesses:mint.node.witnesses||[]});
      continue;
    }
    const fact= mint.fact;
    const factIdentity={fact_kind:fact.kind,fact_key:factKey(fact)};
    if(mint.contract.kind==='terminal'){
      records.push({...base,...factIdentity,record_kind:'terminal',expected_incidence:[],observed_edges:[],terminal_reason:mint.contract.reason,detail:'minting fact carries subject identity, not a second relation endpoint'});
      continue;
    }
    const observedByKind=new Map();
    for(const kind of mint.contract.edgeKinds){
      const matches=(graph.edges||[]).filter(edge=>edge.kind===kind&&edgeTouches(edge,mint.node.id)&&edgeConnectsCanonical(edge,nodeIds)&&edgeHasFactWitness(edge,fact));
      observedByKind.set(kind,matches);
    }
    const missing=mint.contract.edgeKinds.filter(kind=>!observedByKind.get(kind).length);
    const observed=[...new Set([...observedByKind.values()].flat().map(edge=>edge.id))].sort();
    if(!missing.length){
      records.push({...base,...factIdentity,record_kind:'incidence',expected_incidence:mint.contract.edgeKinds,observed_edges:observed,terminal_reason:null,detail:'every relation carried by the minting fact is represented by a witnessed incident edge'});
      continue;
    }
    const detail=`minting fact witnesses ${missing.join(', ')} incidence, but no such witnessed edge is incident to ${mint.node.id}`;
    records.push({...base,...factIdentity,record_kind:'bug',expected_incidence:mint.contract.edgeKinds,missing_incidence:missing,observed_edges:observed,terminal_reason:null,detail});
    derivability.push({...base,record_type:'BUG',classification:DERIVABILITY_CLASSIFICATIONS.BUG,detail,examined:mint.contract.edgeKinds.map(kind=>`graph.edges[kind=${kind}] incident to subject with mint-fact witness`),witnesses:[{repo:fact.repo,file:fact.file,line:fact.line}]});
  }
  return{records,derivability};
}

const fieldValue=(record,field)=>field.split('.').reduce((value,key)=>value&&typeof value==='object'?value[key]:undefined,record);

export function auditProjectionCoverage(graph,{states=FIRST_CLASS_DIAGNOSTIC_STATES,surfaces=[]}={}){
  const records=[];
  for(const state of states){
    const matching=state.family
      ? (graph[state.family]||[]).filter(record=>fieldValue(record,state.field)===state.value)
      : (graph.nodes||[]).filter(node=>node.kind===state.subject_kind&&fieldValue(node,state.field)===state.value);
    const coveredBy=surfaces.filter(surface=>surface.selectable===true&&(surface.states||[]).includes(state.id));
    records.push({schema:CONSERVATION_SCHEMA,record_kind:coveredBy.length?'covered':'projection_gap',diagnostic_state:state.id,
      selector:state.family?{family:state.family,field:state.field,value:state.value}:{subject_kind:state.subject_kind,field:state.field,value:state.value},selectable_surfaces:coveredBy.map(surface=>surface.id).sort(),
      affected_subjects:matching.length,affected_subject_ids:matching.map(node=>node.subject||node.id).sort(),
      detail:coveredBy.length?'diagnostic state has a supported selectable projection':'first-class diagnostic state has no supported selectable projection'});
  }
  return records;
}

export function derivabilityRefusals(graph,scopeGaps=[]){
  const records=[];
  // A coverage fact carries aggregate counts and parse failures. It never carries the scanned path
  // membership needed for coverage->module edges, so refusing that stronger relation is correct.
  for(const node of(graph.nodes||[]).filter(value=>value.kind==='coverage'))records.push({
    schema:CONSERVATION_SCHEMA,record_type:'REFUSAL',classification:DERIVABILITY_CLASSIFICATIONS.REFUSAL,
    subject:node.id,subject_kind:node.kind,detail:'per-module covers incidence is underivable because the fact carries counts, not scanned-path membership',
    examined:['fact.files_scanned','fact.files_skipped','fact.parse_errors[].file'],witnesses:node.witnesses||[],
  });
  for(const gap of scopeGaps)records.push({
    schema:CONSERVATION_SCHEMA,record_type:'SCOPE',classification:DERIVABILITY_CLASSIFICATIONS.SCOPE,
    subject:gap.repo||null,subject_kind:'repository_scope',detail:`repository evidence was not examined (${gap.status||'missing'})`,
    examined:['extraction _MANIFEST.json repositories[]','facts/*.jsonl presence'],witnesses:[],scope_status:gap.status||'missing',
  });
  return records;
}

export const CONSERVATION_METRIC_DEFINITIONS=Object.freeze([
  {path:'census.minted_subjects',predicate:'count(fact_representation records): one record per canonical graph node reconstructed from its mint witness',known_blind_cases:['nodes lacking a matching fact are counted but classified as SCOPE rather than attributed to a fact kind']},
  {path:'census.incidence',predicate:'count(fact_representation where record_kind = incidence and every required witnessed edge kind exists)',known_blind_cases:['does not assert semantic correctness beyond endpoint incidence, edge kind, and same-fact witness']},
  {path:'census.terminals',predicate:'count(fact_representation where the minting fact carries subject identity but no second relation endpoint)',known_blind_cases:['a later independent fact may still connect the terminal subject']},
  {path:'census.bugs',predicate:'count(fact_representation where evidence carries required incidence and at least one required witnessed edge kind is absent)',known_blind_cases:['only relation contracts registered for canonical node kinds are evaluated; unregistered kinds are SCOPE failures']},
  {path:'census.scope_gaps',predicate:'count(derivability records typed SCOPE)',known_blind_cases:['cannot enumerate evidence absent from both the extraction manifest and fact stream']},
  {path:'census.projection_gaps',predicate:'count(first-class diagnostic-state definitions with no selectable supported read surface)',known_blind_cases:['does not measure whether a bounded projection displays every affected subject simultaneously']},
  {path:'census.diagnostic_subjects_unreachable',predicate:'sum(affected_subjects) over diagnostic states with no selectable supported read surface',known_blind_cases:['one subject in multiple uncovered diagnostic states is counted once per state']},
  {path:'census.derivability_by_type.*',predicate:'count(typed derivability records grouped by BUG, REFUSAL, or SCOPE)',known_blind_cases:['REFUSAL records describe requested relations known to this gate, not every imaginable relation']},
]);

const metricPaths=(value,prefix,result)=>{
  if(typeof value==='number'&&Number.isFinite(value)){result.push(prefix);return;}
  if(Array.isArray(value)){for(const item of value)metricPaths(item,`${prefix}[]`,result);return;}
  if(value&&typeof value==='object')for(const[key,item]of Object.entries(value))metricPaths(item,prefix?`${prefix}.${key}`:key,result);
};
const definitionMatches=(definitionPath,actualPath)=>{
  const escaped=definitionPath.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','[^.]+');
  return new RegExp(`^${escaped}$`).test(actualPath);
};
export function assertMetricDefinitionCoverage(value,definitions,{roots=[]}={}){
  for(const definition of definitions){
    if(typeof definition.path!=='string'||!definition.path||typeof definition.predicate!=='string'||!definition.predicate)throw new Error('metric definition requires non-empty path and predicate');
    if(!Array.isArray(definition.known_blind_cases)||!definition.known_blind_cases.length)throw new Error(`metric definition ${definition.path} must publish known_blind_cases`);
  }
  const paths=[];
  for(const root of roots)metricPaths(value[root],root,paths);
  const missing=[...new Set(paths)].filter(metricPath=>!definitions.some(definition=>definitionMatches(definition.path,metricPath))).sort();
  if(missing.length)throw new Error(`Metrics lack machine-readable predicate definitions: ${missing.join(', ')}`);
  return{metrics:[...new Set(paths)].length,definitions:definitions.length};
}

export function runConservationGates({facts,graph,surfaces=[],scopeGaps=[],throwOnViolation=false}={}){
  const factAudit=auditFactRepresentation(facts||[],graph||{nodes:[],edges:[]});
  const projectionCoverage=auditProjectionCoverage(graph||{nodes:[]},{surfaces});
  const derivability=[...factAudit.derivability,...derivabilityRefusals(graph||{nodes:[]},scopeGaps)];
  const byType=Object.fromEntries(DERIVABILITY_RECORD_TYPES.map(type=>[type,derivability.filter(record=>record.record_type===type).length]));
  const census={
    minted_subjects:factAudit.records.length,
    incidence:factAudit.records.filter(record=>record.record_kind==='incidence').length,
    terminals:factAudit.records.filter(record=>record.record_kind==='terminal').length,
    bugs:factAudit.records.filter(record=>record.record_kind==='bug').length,
    scope_gaps:byType.SCOPE,
    projection_gaps:projectionCoverage.filter(record=>record.record_kind==='projection_gap').length,
    diagnostic_subjects_unreachable:projectionCoverage.filter(record=>record.record_kind==='projection_gap').reduce((sum,record)=>sum+record.affected_subjects,0),
    derivability_by_type:byType,
  };
  const report={schema:CONSERVATION_SCHEMA,passed:census.bugs===0&&census.projection_gaps===0&&factAudit.records.every(record=>record.record_kind!=='scope_gap'),
    census,metric_definitions:CONSERVATION_METRIC_DEFINITIONS,fact_representation:factAudit.records,projection_coverage:projectionCoverage,derivability_records:derivability};
  assertMetricDefinitionCoverage(report,CONSERVATION_METRIC_DEFINITIONS,{roots:['census']});
  if(throwOnViolation&&!report.passed){
    const error=new Error(`Estate-map conservation gates failed: BUG=${census.bugs}, SCOPE=${factAudit.records.filter(record=>record.record_kind==='scope_gap').length}, PROJECTION=${census.projection_gaps}`);
    error.code='ASCRYBE_CONSERVATION_FAILED';error.report=report;throw error;
  }
  return report;
}

async function readFacts(dir){
  let factsDir=dir;try{if((await fs.stat(path.join(dir,'facts'))).isDirectory())factsDir=path.join(dir,'facts');}catch{}
  const facts=[];for(const file of(await fs.readdir(factsDir)).filter(name=>name.endsWith('.jsonl')).sort())for(const line of(await fs.readFile(path.join(factsDir,file),'utf8')).split(/\r?\n/))if(line)facts.push(JSON.parse(line));
  return facts.sort((a,b)=>factKey(a).localeCompare(factKey(b)));
}

async function main(){
  const argv=process.argv.slice(2),noProjections=argv.includes('--no-projections'),{positional,options}=parseArgs(argv.filter(value=>value!=='--no-projections'));
  if(options.help||!positional[0]||!positional[1]){
    console.log('Usage: node tools/estate-map/conservation.mjs <facts-dir> <estate-graph.json> [--out <report.json>] [--no-projections]');
    process.exitCode=options.help?0:1;return;
  }
  const facts=await readFacts(path.resolve(positional[0]));
  const graph=JSON.parse(await fs.readFile(path.resolve(positional[1]),'utf8'));
  // main() is intentionally invoked without top-level await below. projection.mjs imports this
  // module's constants; waiting for that import while this module was still evaluating created a
  // circular top-level-await deadlock in the standalone auditor.
  const surfaces=noProjections?[]:(await import('./projection.mjs')).SUPPORTED_DIAGNOSTIC_PROJECTIONS;
  const report=runConservationGates({facts,graph,surfaces});
  if(options.out){await fs.mkdir(path.dirname(path.resolve(options.out)),{recursive:true});await fs.writeFile(path.resolve(options.out),stableStringify(report));}
  console.log(JSON.stringify({passed:report.passed,census:report.census},null,2));
  if(!report.passed)process.exitCode=1;
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(error.message);process.exitCode=1;});
