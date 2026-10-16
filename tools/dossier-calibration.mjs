#!/usr/bin/env node
// One paid, checkpointed stage per dossier calibration version: atomic extraction OR relation linking.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepassDocument, buildMentionNamespace } from './source-prepass.mjs';
import { ATOMIC_RECONCILIATION_VERSION, buildJointPackets, buildReconciliationCandidates, runTargetedReconciliation } from './context-reconciliation.mjs';
import { GENERIC_RELATION_LINKER_VERSION, runRelationLinking } from './relation-linker.mjs';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget } from './custodied-inference.mjs';
import { createPiRpcRunner, requireModel } from './neural-model-runner.mjs';
import { writeContextMapArtifacts } from './context-map-artifacts.mjs';
import { parseModelJsonStream } from './neural-json.mjs';
import { sha256, stableStringify } from './lib.mjs';

const execFileAsync=promisify(execFile),canonical=value=>stableStringify(value).trim(),norm=value=>String(value??'').toLocaleLowerCase();
export const DOSSIER_SPEC_SCHEMA='estate-map/dossier-calibration-spec/v1';
export const DOSSIER_CALIBRATION_SCHEMA='estate-map/dossier-reconciliation-calibration/v1';

function verifyDigest(value,code){const{digest,...body}=value||{};if(typeof digest!=='string'||sha256(canonical(body))!==digest)throw new Error(code);return digest;}
function relationText(relation){return canonical({subject:relation.semantic?.subject?.surface,predicate:relation.semantic?.predicate_family,object:relation.semantic?.object_or_value,evidence:(relation.semantic?.support_sets||[]).flatMap(set=>(set.locators||[]).map(locator=>locator.text))}).toLocaleLowerCase()}
function identifyRoles(relations,roles){return Object.fromEntries(Object.entries(roles||{}).map(([role,terms])=>{const matches=relations.filter(relation=>(terms||[]).every(term=>relationText(relation).includes(norm(term))));return[role,matches.map(relation=>relation.id)]}))}
function locatorMetrics(result){
  const relations=result.relations||[],packets=result.packet_results||[],links=result.links||[];
  const rejected=packets.flatMap(packet=>packet.rejected||[]),rejectedLinks=packets.flatMap(packet=>packet.rejected_links||[]);
  const proposed=relations.reduce((n,row)=>n+Number(row.locator_stats?.proposed||0),0)+rejected.reduce((n,row)=>n+Number(row.locator_stats?.proposed||0),0)
    +links.reduce((n,row)=>n+Number(row.locator_stats?.proposed??row.support_locators?.length??0),0)+rejectedLinks.reduce((n,row)=>n+Number(row.locator_stats?.proposed||0),0);
  const resolved=relations.reduce((n,row)=>n+Number(row.locator_stats?.resolved||0),0)+rejected.reduce((n,row)=>n+Number(row.locator_stats?.resolved||0),0)
    +links.reduce((n,row)=>n+Number(row.locator_stats?.resolved??row.support_locators?.length??0),0)+rejectedLinks.reduce((n,row)=>n+Number(row.locator_stats?.resolved||0),0);
  return{proposed,resolved,rate:proposed?Number((resolved/proposed).toFixed(4)):0,rejected_relations:rejected.length,rejected_links:rejectedLinks.length};
}

export function gradeDossierCalibration({result,spec,stage}){
  const relations=result.relations||[],links=result.links||[],texts=relations.map(relationText),roles=identifyRoles(relations,spec.gold_roles);
  const termCoverage=Object.fromEntries(spec.query_terms.map(term=>[term,texts.some(text=>text.includes(norm(term)))]));
  const metrics=locatorMetrics(result),roleRows=Object.entries(roles),allRoles=roleRows.every(([,ids])=>ids.length===1),roleId=role=>roles[role]?.[0]||null;
  const expectedLinks=(spec.expected_links||[]).map(expected=>({...expected,from_relation_id:roleId(expected.from_role),to_relation_id:roleId(expected.to_role),met:Boolean(roleId(expected.from_role)&&roleId(expected.to_role)&&links.some(link=>link.kind===expected.kind&&link.from_relation_id===roleId(expected.from_role)&&link.to_relation_id===roleId(expected.to_role)))}));
  const checks={
    run_complete:result.status==='complete',no_recursion:result.recursion?.activated===false,
    minimum_predicates:new Set(relations.map(row=>row.semantic?.predicate_family).filter(Boolean)).size>=Number(spec.minimum_predicates||3),
    every_query_term_accounted_for:Object.values(termCoverage).every(Boolean),gold_roles_unique:allRoles,
    no_rejected_relations:metrics.rejected_relations===0,no_rejected_links:metrics.rejected_links===0,
    locator_resolution_rate_at_least_0_90:metrics.rate>=.9,
    exact_locator_authority:relations.every(row=>row.schema==='estate-map/documentary-claim/v3.2'&&row.locator_stats?.failed===0),
    stage_link_contract:stage==='atomic'?links.length===0:expectedLinks.length>0&&expectedLinks.every(row=>row.met),
  };
  return Object.freeze({pass:Object.values(checks).every(Boolean),checks,term_coverage:termCoverage,gold_roles:roles,expected_links:expectedLinks,
    relation_count:relations.length,predicate_count:new Set(relations.map(row=>row.semantic?.predicate_family).filter(Boolean)).size,link_count:links.length,locator_metrics:metrics});
}

export async function loadCalibrationSource({estate,spec,expectedSha}){
  const sourceSha=(await execFileAsync('git',['-C',estate,'rev-parse','HEAD'])).stdout.trim();if(sourceSha!==expectedSha)throw new Error('SOURCE_SHA_MISMATCH');
  const content=await fs.readFile(path.join(estate,spec.source_document),'utf8');
  const snapshot={source_sha:sourceSha,corpus_digest:sha256(canonical([{path:spec.source_document,digest:sha256(content)}]))};
  const prepass=prepassDocument({path:spec.source_document,content,...snapshot}),prepasses=[prepass];
  const candidate=buildReconciliationCandidates({prepasses,query_terms:spec.query_terms,query_authorized:true}).find(row=>row.signals.some(signal=>signal.kind==='authorized_query'));
  if(!candidate)throw new Error('DOSSIER_CANDIDATE_NOT_FOUND');
  const joint=buildJointPackets({candidate,prepasses,snapshot,max_packet_bytes:Number(spec.max_packet_bytes||48*1024)});
  if(joint.recursion.activated||joint.packets.length!==1)throw new Error(`CALIBRATION_REQUIRES_SINGLE_PACKET:${joint.total_bytes}`);
  return{snapshot,prepasses,candidate,joint};
}

async function main(){
  if(process.env.ASCRYBE_ENABLE_PAID_INFERENCE!=='1')throw new Error('PAID_GATE_CLOSED');
  const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i+=1){if(!args[i].startsWith('--'))throw new Error(`unexpected argument ${args[i]}`);o[args[i].slice(2)]=args[++i]}
  const stage=o.stage;if(!['atomic','link'].includes(stage))throw new Error('--stage atomic|link required');if(!o.spec||!o.output||!o.checkpoint)throw new Error('--spec, --output, and --checkpoint required');
  const estate=await fs.realpath(path.resolve(o.estate||'estate')),specPath=path.resolve(o.spec),spec=JSON.parse(await fs.readFile(specPath,'utf8'));
  if(spec.schema!==DOSSIER_SPEC_SCHEMA||!spec.id||!spec.source_document||!Array.isArray(spec.query_terms)||spec.query_terms.length<2)throw new Error('INVALID_DOSSIER_SPEC');
  const specDigest=sha256(canonical(spec)),expectedSha=(await fs.readFile(new URL('../ESTATE_SHA',import.meta.url),'utf8')).trim();
  const source=await loadCalibrationSource({estate,spec,expectedSha}),model=requireModel(o.model, 'calibration --model'),thinking=o.thinking||'high',maxCost=Number(o['max-cost']||2);
  if(!Number.isFinite(maxCost)||maxCost<=0||maxCost>2)throw new Error('max-cost must be >0 and <=2');
  let base=null,relations=[];
  if(stage==='link'){
    if(!o.base)throw new Error('--base atomic calibration required');base=JSON.parse(await fs.readFile(path.resolve(o.base),'utf8'));verifyDigest(base,'BASE_DIGEST_MISMATCH');
    if(base.schema!==DOSSIER_CALIBRATION_SCHEMA||base.stage!=='atomic'||base.spec_digest!==specDigest||!base.grade?.pass)throw new Error('INVALID_ATOMIC_BASE');
    if(base.snapshot.source_sha!==source.snapshot.source_sha||base.snapshot.corpus_digest!==source.snapshot.corpus_digest||base.candidate.id!==source.candidate.id)throw new Error('BASE_LINEAGE_MISMATCH');
    relations=base.result.relations||[];
  }
  const version=stage==='atomic'?ATOMIC_RECONCILIATION_VERSION:GENERIC_RELATION_LINKER_VERSION,checkpointPath=path.resolve(o.checkpoint);
  const checkpoint=await openCheckpointJournal({file:checkpointPath,fingerprint:{schema:DOSSIER_CALIBRATION_SCHEMA,calibration_id:spec.id,stage,version,spec_digest:specDigest,source_sha:source.snapshot.source_sha,candidate_id:source.candidate.id,packet_id:source.joint.packets[0].id,base_digest:base?.digest||null,model,thinking,max_cost_usd:maxCost}});
  const budget=createInferenceBudget({max_calls:1,max_known_cost_usd:maxCost,max_unpriced_attempts:0});
  const runner=createPiRpcRunner({model,thinking,timeoutMs:15*60*1000,maxOutputBytes:64*1024*1024,maxAnswerBytes:2*1024*1024,answerParser:stage==='atomic'?parseModelJsonStream:null});
  let result,linking=null,failure=null;
  try{
    if(stage==='atomic')result=await runTargetedReconciliation({candidate:source.candidate,joint:source.joint,namespace:buildMentionNamespace(source.prepasses),runner,checkpoint,budget,mode:'atomic'});
    else{
      linking=await runRelationLinking({candidate:source.candidate,packet:source.joint.packets[0],relations,runner,checkpoint,budget,link_instructions:spec.link_instructions});
      const packetResult={packet_id:source.joint.packets[0].id,outcome:linking.status==='complete'?'linked':'incomplete',reason:linking.reason||'',relations,links:linking.links||[],rejected:[],rejected_links:linking.rejected_links||[],incomplete:linking.incomplete};
      result={schema:'estate-map/context-reconciliation/v1',version:`${base.result.version}+${linking.version}`,candidate_id:source.candidate.id,recursion:source.joint.recursion,packet_results:[packetResult],composition:null,relations,links:linking.links||[],status:linking.status};
    }
  }catch(error){
    // A purchased unit that fails validation is preserved and visualized, never retried or repaired.
    failure={code:error.code||error.name||'UNKNOWN',message:error.message,detail:error.detail?{stage:error.detail.stage||null,tag:error.detail.tag||null,outcome:error.detail.result?.outcome||null,answer_bytes:error.detail.result?.answer_bytes??null}:null};
    result={schema:'estate-map/context-reconciliation/v1',version,candidate_id:source.candidate.id,recursion:source.joint.recursion,packet_results:[],composition:null,relations:stage==='link'?relations:[],links:[],status:'incomplete'};
  }finally{await checkpoint.close();await runner.shutdown()}
  const grade=gradeDossierCalibration({result,spec,stage}),checkpointRaw=await fs.readFile(checkpointPath,'utf8'),output=path.resolve(o.output);
  const body={schema:DOSSIER_CALIBRATION_SCHEMA,calibration_id:spec.id,title:spec.title,stage,authorization:{standing_iterative_evaluation:true,max_calls:1,max_cost_usd:maxCost,automatic_retries:0},
    model,thinking,reconciliation_version:result.version,linker_version:stage==='link'?linking.version:null,spec_path:path.relative(process.cwd(),specPath),spec_digest:specDigest,
    base_calibration:base?{path:path.relative(process.cwd(),path.resolve(o.base)),digest:base.digest}:null,snapshot:source.snapshot,source_document:spec.source_document,query_terms:spec.query_terms,candidate:source.candidate,
    joint_packet:{total_bytes:source.joint.total_bytes,packet_ids:source.joint.packets.map(packet=>packet.id),block_catalogs:source.joint.packets.map(packet=>({packet_id:packet.id,catalog_digest:packet.catalog.digest,entries:packet.catalog.entries.map(entry=>({token:entry.token,file:entry.file,start:entry.start,end:entry.end,digest:entry.digest}))})),recursion:source.joint.recursion},
    result,linking,failure,grade,budget:budget.snapshot(),runner_stats:runner.stats(),custody:{checkpoint_path:checkpointPath,checkpoint_digest:sha256(checkpointRaw),checkpoint_records:checkpointRaw.split('\n').filter(Boolean).map(JSON.parse)}};
  const artifact={...body,digest:sha256(canonical(body))};await fs.mkdir(path.dirname(output),{recursive:true});const temporary=`${output}.${process.pid}.tmp`;await fs.writeFile(temporary,`${JSON.stringify(artifact,null,2)}\n`);await fs.rename(temporary,output);
  const stem=output.replace(/\.json$/i,''),visualization=await writeContextMapArtifacts({calibration:artifact,estate,mapPath:o.map||`${stem}-MAP.json`,htmlPath:o.html||`${stem}-MAP.html`});
  console.log(JSON.stringify({output,stage,grade,budget:artifact.budget,digest:artifact.digest,visualization}));process.exitCode=grade.pass?0:3;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(error=>{console.error(error.stack||error.message);process.exit(1)});
