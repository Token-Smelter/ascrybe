#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { PROVENANCE_CLASSES, classifiedProvenance, classifyExcludedPath, classifyProvenance, compareWitnessProvenance, factKey, normalizedUrlPath, parseArgs, provenance, provenanceClassCounts, routeRegex, sha256, stableStringify, writeJson } from './lib.mjs';
import { PYTHON_STDLIB_MODULES, isNodeBuiltinSpecifier } from './platform-vocabulary.mjs';
import { deriveManifestWiring, manifestWiringCensus } from './manifest-wiring.mjs';
import { FIRST_CLASS_DIAGNOSTIC_STATES, runConservationGates } from './conservation.mjs';
import { SUPPORTED_DIAGNOSTIC_PROJECTIONS } from './projection.mjs';
import { buildPresentationRecords } from './presentation-records.mjs';

const HELP=`Usage: node tools/estate-map/merge.mjs <facts-dir> [--out <dir>] [--allow-partial]
Merge JSONL facts into a deterministic source-witnessed estate graph. Partial extraction manifests are refused unless --allow-partial is explicit.`;
const slug=value=>String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const COMMON_TOKENS=new Set(['api','app','application','aws','function','group','lambda','service','svc','target','test','tests','worker']);
const tokens=value=>String(value).replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(token=>token.length>2&&!COMMON_TOKENS.has(token));
const packageKey=(value,kind='')=>{
  const normalized=String(value).trim().replace(/\\/g,'/').toLowerCase();
  return kind==='project'?normalized.split('/').pop().replace(/\.csproj$/,''):normalized;
};
const topicRef=value=>String(value).trim().toLowerCase();
// AC-KOTLIN-RESOLUTION: well-known external/SDK namespace roots. An import
// FQN whose package matches one of these (or a dotted child of one) is
// classified 'external' rather than plain 'unresolved' when it has zero
// intra-project candidates — it is recognizably infrastructure/dependency,
// not a broken/incomplete reference. Either way the fact is kept (pushed to
// `unresolved`), never dropped.
const KOTLIN_EXTERNAL_PACKAGE_ROOTS=['kotlin','kotlinx','java','javax','android','androidx','com.google','com.squareup','dagger','retrofit2','okhttp3','io.reactivex','rx','junit','org.junit','org.jetbrains'];
const isExternalKotlinPackage=pkg=>KOTLIN_EXTERNAL_PACKAGE_ROOTS.some(root=>pkg===root||pkg.startsWith(`${root}.`));
const topicTargetAliases=value=>{const target=topicRef(value);return target.startsWith('arn:')?[target,target.slice(target.lastIndexOf(':')+1)]:[target];};
const uniqueByRepo=values=>[...new Map(values.map(value=>[value.f.repo,value])).values()].sort((a,b)=>a.f.repo.localeCompare(b.f.repo));
const witnessesFor=(source,matches,extras=[])=>[provenance(source),...extras.map(provenance),...matches.map(match=>provenance(match.f))];
const isTestRepo=repo=>/(?:^|[-_.])(tests?|automation|e2e)(?:$|[-_.])/i.test(repo);
const normalizeModulePath=value=>{
  const normalized=path.posix.normalize(value||'.');
  return normalized==='.'?'.':normalized.replace(/^\.\//,'').replace(/\/$/,'');
};
const modulePathIdPart=value=>{
  const normalized=normalizeModulePath(value);
  return normalized==='.'?'root':normalized.split('/').map(segment=>encodeURIComponent(segment)).join('/');
};
const moduleKey=(repo,modulePath)=>`${repo}:${normalizeModulePath(modulePath)}`;
const resourceKey=fact=>`${moduleKey(fact.repo,fact.module_path)}:${fact.address}`;
const moduleId=(repo,modulePath)=>`tf_module:${slug(repo)}:${modulePathIdPart(modulePath)}`;
const resourceId=fact=>`tf:${slug(fact.repo)}:${normalizeModulePath(fact.module_path)==='.'?'':`${modulePathIdPart(fact.module_path)}:`}${fact.address}`;
const ENVIRONMENT_SEGMENT=/^(?:dev|qa|stage|staging|uat|prod|production|sandbox|shared|common)$/i;
const infraClass=tfType=>{
  if(/^aws_iam_/.test(tfType))return'identity';
  if(/^(?:aws_lb|aws_alb|aws_api_gateway|aws_cloudfront|aws_route53_)/.test(tfType))return'edge';
  if(/^(?:aws_vpc|aws_subnet|aws_security_group|aws_route)/.test(tfType))return'network';
  if(/^(?:aws_ssm_parameter|aws_secretsmanager_)/.test(tfType))return'config';
  if(/^aws_cloudwatch_/.test(tfType))return'observability';
  if(/^(?:aws_lambda_function|aws_ecs_|aws_autoscaling_)/.test(tfType))return'compute';
  if(/^(?:aws_sns_|aws_sqs_)/.test(tfType))return'messaging';
  if(/^(?:aws_s3_|aws_dynamodb_|aws_rds_|aws_dms_)/.test(tfType))return'storage';
  return'other';
};
const staticTail=value=>{
  const text=String(value||'');
  if(!text.includes('${'))return null;
  const tail=text.split(/\$\{[^}]*\}/g).at(-1)?.trim();
  if(!tail)return null;
  const segments=tail.split('/').filter(Boolean);
  return segments.length>=2||tail.length>=8?tail:null;
};
const tailMatches=(declared,observed)=>{
  const tail=staticTail(declared);
  return tail&&String(observed||'').toLowerCase().endsWith(tail.toLowerCase())?tail:null;
};
const orgPrefixesFor=names=>[...new Set(names.flatMap(value=>{
  const name=String(value||'');const prefixes=[];
  const scope=name.match(/^(@[^/]+\/)/);if(scope)prefixes.push(scope[1].toLowerCase());
  const dotted=name.match(/^([A-Z][A-Za-z0-9]*)\./);if(dotted)prefixes.push(`${dotted[1]}.`.toLowerCase());
  const short=name.match(/^((?:[a-z]+\d+|[a-z]{2,3})-)/);if(short)prefixes.push(short[1].toLowerCase());
  return prefixes;
}))].sort();

export async function readFacts(dir){
  let factsDir=dir;
  try { if((await fs.stat(path.join(dir,'facts'))).isDirectory())factsDir=path.join(dir,'facts'); } catch {}
  const files=(await fs.readdir(factsDir)).filter(value=>value.endsWith('.jsonl')).sort();
  const facts=[];
  for(const file of files)for(const line of (await fs.readFile(path.join(factsDir,file),'utf8')).split(/\r?\n/))if(line)facts.push(JSON.parse(line));
  return facts.sort((a,b)=>factKey(a).localeCompare(factKey(b)));
}

async function assertCompleteExtraction(factsDir,allowPartial){
  const candidates=[path.join(factsDir,'_MANIFEST.json'),path.join(path.dirname(factsDir),'_MANIFEST.json')];let manifest=null;
  for(const file of candidates)try{manifest=JSON.parse(await fs.readFile(file,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!manifest)return{scopeGaps:[]};
  const entries=manifest.repositories||[],incomplete=entries.filter(value=>!['complete','skipped'].includes(value.status));let factsRoot=factsDir;try{if((await fs.stat(path.join(factsDir,'facts'))).isDirectory())factsRoot=path.join(factsDir,'facts');}catch{}
  const factFiles=new Set((await fs.readdir(factsRoot)).filter(value=>value.endsWith('.jsonl')).map(value=>value.slice(0,-6))),missing=entries.filter(value=>value.status==='complete'&&!factFiles.has(value.repo)).map(value=>({...value,status:'missing'})),partial=[...incomplete,...missing];
  if(partial.length&&!allowPartial){const error=new Error(`Refusing partial facts: ${partial.map(value=>`${value.repo}=${value.status||'missing'}`).join(', ')}. Re-run extraction or pass --allow-partial.`);error.exitCode=2;throw error;}
  return{scopeGaps:partial};
}

export async function mergeFacts(factsDir,out,{allowPartial=false}={}){
  const extractionScope=await assertCompleteExtraction(factsDir,allowPartial);
  const facts=await readFacts(factsDir);
  const fact_kind_inventory=[...facts.reduce((counts,fact)=>counts.set(fact.kind,(counts.get(fact.kind)||0)+1),new Map())]
    .map(([kind,count])=>({kind,count}))
    .sort((a,b)=>a.kind.localeCompare(b.kind));
  const nodes=new Map(),edges=[],unresolved=[],ambiguities=[];
  const addNode=(id,kind,name,repo,witness,extra={})=>{if(!nodes.has(id))nodes.set(id,{id,kind,name,repo,witnesses:witness?[witness]:[],...extra});return id;};
  const addAmbiguous=(edge,fact)=>{
    edge.candidates=[...new Set(edge.candidates)].sort();
    edges.push(edge);
    ambiguities.push({edge_id:edge.id,kind:edge.kind,candidates:edge.candidates,witnesses:edge.witnesses});
    if(fact)unresolved.push({...fact,status:'ambiguous',candidates:edge.candidates});
  };
  const addUnmatched=(kind,fact)=>{
    const record={...fact,status:'unresolved',association_kind:kind};
    unresolved.push(record);
    ambiguities.push({edge_id:`unmatched:${kind}:${repos.get(fact.repo)}:${slug(fact.file)}:${fact.line}`,kind,status:'unmatched',candidates:[],witnesses:[provenance(fact)]});
  };

  const repoFacts=facts.filter(fact=>fact.kind==='repo');
  const repos=new Map();
  // Estate-relative component roots, read from the EXPLICIT `root` field
  // extract.mjs emits on each repo fact. A component identifier is not a
  // path, so the root is never derived from the component's name — except as
  // a VISIBLE backward-compatibility fallback for facts produced by an older
  // extract that emitted no `root` (recorded on the repo node as
  // estate_root_source and warned about once, rather than silently guessed).
  const repoEstateRoots=new Map();
  const estateRootFallbacks=[];
  for(const fact of repoFacts){
    const declared=typeof fact.root==='string'&&fact.root.trim()?fact.root:null;
    if(!declared)estateRootFallbacks.push(fact.repo);
    repoEstateRoots.set(fact.repo,{root:normalizeModulePath(declared??fact.repo),source:declared?'repo_fact_root':'fallback_component_name'});
  }
  if(estateRootFallbacks.length)console.warn(`estate-map merge: ${estateRootFallbacks.length} repo fact(s) carry no estate-relative 'root' field; falling back to the component name for estate-wide path resolution (re-run extract.mjs to remove this fallback): ${[...new Set(estateRootFallbacks)].sort().join(', ')}`);
  const estateRootFor=repo=>repoEstateRoots.get(repo)?.root??normalizeModulePath(repo);
  for(const fact of repoFacts){
    const rootInfo=repoEstateRoots.get(fact.repo);
    const repoId=addNode(`repo:${slug(fact.repo)}`,'repo',fact.name,fact.repo,provenance(fact),{head_sha:fact.head_sha,estate_root:rootInfo.root,estate_root_source:rootInfo.source});
    repos.set(fact.repo,repoId);
    const serviceId=addNode(`service:${slug(fact.repo)}`,'service',fact.name,fact.repo,provenance(fact));
    edges.push({id:`declares_service:${repoId}:${serviceId}`,kind:'declares_service',from:repoId,to:serviceId,status:'resolved',witnesses:[provenance(fact)]});
  }

  const resourceFacts=facts.filter(fact=>fact.kind==='tf_resource');
  const resourceIds=new Map();
  const moduleFacts=[...resourceFacts,...facts.filter(fact=>['tf_declaration','tf_module_call','tf_workspace'].includes(fact.kind))];
  const modules=new Map();
  for(const fact of moduleFacts){
    const key=moduleKey(fact.repo,fact.module_path);
    if(!modules.has(key))modules.set(key,{f:fact,id:addNode(moduleId(fact.repo,fact.module_path),'tf_module',normalizeModulePath(fact.module_path),fact.repo,provenance(fact),{module_path:normalizeModulePath(fact.module_path)})});
  }
  const environments=new Map();
  for(const {f:fact,id} of [...modules.values()].sort((a,b)=>a.id.localeCompare(b.id))){
    const pathEnvironments=normalizeModulePath(fact.module_path).split('/').filter(segment=>ENVIRONMENT_SEGMENT.test(segment));
    const workspace=facts.find(value=>value.kind==='tf_workspace'&&moduleKey(value.repo,value.module_path)===moduleKey(fact.repo,fact.module_path));
    const environment=(workspace?.environment||(pathEnvironments.length===1?pathEnvironments[0]:null))?.toLowerCase();
    if(!environment)continue;
    const environmentId=`environment:${slug(fact.repo)}:${slug(environment)}`;
    if(!environments.has(`${fact.repo}:${environment}`))environments.set(`${fact.repo}:${environment}`,addNode(environmentId,'environment',environment,fact.repo,provenance(workspace||fact),{environment}));
    edges.push({id:`member_of_environment:${id}:${environmentId}`,kind:'member_of',relation:'module_environment',from:id,to:environmentId,status:'resolved',witnesses:[provenance(fact),provenance(workspace||fact)]});
  }
  for(const fact of resourceFacts){
    const id=addNode(resourceId(fact),'tf_resource',fact.address,fact.repo,provenance(fact),{tf_type:fact.tf_type,infra_class:infraClass(fact.tf_type),module_path:normalizeModulePath(fact.module_path)});
    resourceIds.set(resourceKey(fact),id);
    edges.push({id:`declares_resource:${repos.get(fact.repo)}:${id}`,kind:'declares_resource',from:repos.get(fact.repo),to:id,status:'resolved',witnesses:[provenance(fact)]});
    const module=modules.get(moduleKey(fact.repo,fact.module_path));
    edges.push({id:`member_of_module:${id}:${module.id}`,kind:'member_of',relation:'resource_module',from:id,to:module.id,status:'resolved',witnesses:[provenance(fact),provenance(module.f)]});
  }

  // HTTP ROUTES. `fact.route` is the MOUNTED path: for the plugin idiom the
  // extractor reconstructs `/api/plugins/<owner>/<declared>` from the real
  // registration in src/substrate/pluginContext.mjs and keeps the quoted
  // `declared_route` beside it, so the node id cannot collide across plugins
  // (six plugins declare `/health`).
  //
  // Every route node carries a `provenance_class` (lib.mjs#classifyProvenance).
  // The estate's only route nodes used to be five mini-estate FIXTURES, and a
  // reviewer had no way to tell them from production without reading paths;
  // fixtures are still carried — classified, not dropped.
  const routeFacts=facts.filter(fact=>fact.kind==='http_route');
  const routes=[];
  // F7 (orientation-test-report.md §7.2). A SYNTHESIZED field must carry the
  // site that justifies it. `derived_value_producer` facts name where a derived
  // value is really produced (extractors/http.mjs emits one for `mount_prefix`
  // at src/substrate/pluginContext.mjs:368); the join below attaches that
  // file:line to every route node whose mount was reconstructed rather than
  // quoted. When no producer fact exists in the repo the node carries an
  // explicit typed refusal instead of a silently missing field — a derived
  // value with no witness must SAY it has no witness.
  const derivedProducers=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='derived_value_producer').sort((a,b)=>factKey(a).localeCompare(factKey(b)))){
    const key=`${fact.repo}\u0000${fact.derived_field}`;
    if(!derivedProducers.has(key))derivedProducers.set(key,fact);
  }
  const derivedWitness=(repo,field)=>{
    const producer=derivedProducers.get(`${repo}\u0000${field}`);
    return producer
      ?{witness:provenance(producer),expression:producer.expression||null,refusal:null}
      :{witness:null,expression:null,refusal:`no_derived_value_producer_fact_for_${field}_in_repo`};
  };
  for(const fact of routeFacts){
    const mount=fact.declared_route?derivedWitness(fact.repo,'mount_prefix'):null;
    const id=addNode(`route:${slug(fact.repo)}:${fact.method}:${slug(fact.route)}`,'route',`${fact.method} ${fact.route}`,fact.repo,provenance(fact),{
      method:fact.method,route:fact.route,provenance_class:classifyProvenance(fact.repo,fact.file),
      ...(fact.framework?{framework:fact.framework}:{}),
      ...(fact.declared_route?{declared_route:fact.declared_route,mount_prefix:fact.mount_prefix,mount_basis:fact.mount_basis,
        mount_basis_witness:mount.witness,mount_basis_expression:mount.expression,mount_basis_witness_refusal:mount.refusal}:{}),
      ...(fact.owner?{owner:fact.owner}:{}),
      ...(fact.auth!==undefined?{auth:fact.auth,auth_basis:fact.auth_basis}:{}),
    });
    routes.push({f:fact,id});
    edges.push({id:`exposes_route:${repos.get(fact.repo)}:${id}`,kind:'exposes_route',from:repos.get(fact.repo),to:id,status:'resolved',witnesses:[provenance(fact)]});
  }
  // A registration site the extractor could not ground (non-literal method or
  // path, no derivable owning plugin) is a REFUSAL carried as data, never a
  // silent skip and never a guessed route. It mints no node, so it cannot
  // move any diagnostic queue.
  const routeRefusals=facts.filter(fact=>fact.kind==='http_route_refusal').map(fact=>({
    id:`route_refusal:${slug(fact.repo)}:${slug(fact.file)}:${fact.line}`,
    framework:fact.framework,reason:fact.reason,reason_detail:fact.reason_detail,examined:fact.examined,
    witnesses:[classifiedProvenance(fact)],
  })).sort((a,b)=>a.id.localeCompare(b.id));

  // Internal package producers come from repository identity and concrete manifests.
  const producers=new Map();
  const addProducer=(name,fact,kind)=>{const key=packageKey(name,kind);if(!key)return;const values=producers.get(key)||[];values.push({f:fact,id:repos.get(fact.repo)});producers.set(key,values);};
  for(const fact of repoFacts)addProducer(fact.name||fact.repo,fact);
  const manifestFacts=facts.filter(fact=>fact.kind==='package_manifest');
  for(const fact of manifestFacts)addProducer(fact.package_name,fact,fact.manifest_kind);
  const orgPrefixes=orgPrefixesFor([...repoFacts.map(fact=>fact.name||fact.repo),...manifestFacts.map(fact=>fact.package_name)]);
  for(const fact of facts.filter(fact=>fact.kind==='dep')){
    addNode(`package:${slug(fact.dep_name)}`,'package',fact.dep_name,fact.repo,provenance(fact),{dep_kind:fact.dep_kind});
    const matches=uniqueByRepo((producers.get(packageKey(fact.dep_name,fact.dep_kind))||[]).filter(match=>match.f.repo!==fact.repo));
    if(matches.length){
      const edge={id:`consumes_package:${repos.get(fact.repo)}:${slug(fact.dep_name)}:${slug(fact.file)}:${fact.line}`,kind:'consumes_package',from:repos.get(fact.repo),to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,matches)};
      if(matches.length===1)edges.push(edge);else{edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
    }else if(orgPrefixes.some(prefix=>fact.dep_name.toLowerCase().startsWith(prefix))){
      const stubId=addNode(`external_internal_package:${slug(fact.dep_name)}`,'external_internal_package',fact.dep_name,fact.repo,provenance(fact),{dep_kind:fact.dep_kind,producer_status:'external'});
      edges.push({id:`consumes_package:${repos.get(fact.repo)}:${slug(fact.dep_name)}:${slug(fact.file)}:${fact.line}`,kind:'consumes_package',from:repos.get(fact.repo),to:stubId,status:'external_producer',witnesses:[provenance(fact)]});
    }
    const compatibilityMatch=repoFacts.find(repo=>repo.repo!==fact.repo&&fact.dep_name===repo.repo);
    if(compatibilityMatch)edges.push({id:`shares_dependency:${repos.get(fact.repo)}:${repos.get(compatibilityMatch.repo)}:${slug(fact.file)}:${fact.line}`,kind:'shares_dependency',from:repos.get(fact.repo),to:repos.get(compatibilityMatch.repo),status:'resolved',witnesses:[provenance(fact),provenance(compatibilityMatch)]});
  }

  // Terraform deployment resources associate only through distinguishing service tokens.
  const deploymentResource=/(?:lambda_function|lb_target_group|ecs_(?:service|task_definition)|apigateway|api_gateway|cloudfront_distribution)$/;
  for(const fact of resourceFacts.filter(fact=>deploymentResource.test(fact.tf_type))){
    const resourceTokens=tokens(fact.name);
    if(!resourceTokens.length)continue;
    const matches=repoFacts.filter(repo=>repo.repo!==fact.repo&&tokens(repo.name||repo.repo).some(token=>resourceTokens.includes(token))).map(repo=>({f:repo,id:repos.get(repo.repo)}));
    const candidates=uniqueByRepo(matches);
    const kind=fact.tf_type==='aws_lb_target_group'?'routes_to':'deploys';
    if(!candidates.length){unresolved.push({...fact,status:'unresolved',association_kind:kind});continue;}
    const edge={id:`${kind}:${resourceIds.get(resourceKey(fact))}:${resourceTokens.join('-')}`,kind,from:resourceIds.get(resourceKey(fact)),to:candidates.length===1?candidates[0].id:null,status:candidates.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,candidates)};
    if(candidates.length===1)edges.push(edge);else{edge.candidates=candidates.map(match=>match.id);addAmbiguous(edge,fact);}
  }

  const declaredConfigs=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='config_key'&&fact.role==='declared')){
    const modulePrefix=normalizeModulePath(fact.module_path)==='.'?'':`${modulePathIdPart(fact.module_path)}:`;
    const id=addNode(`config:${slug(fact.repo)}:${modulePrefix}${slug(fact.key_name)}`,'config_key',fact.key_name,fact.repo,provenance(fact),{module_path:normalizeModulePath(fact.module_path)});
    const values=declaredConfigs.get(fact.key_name)||[];values.push({f:fact,id});declaredConfigs.set(fact.key_name,values);
  }
  const readConfigs=facts.filter(fact=>fact.kind==='config_key'&&fact.role==='read');
  const allDeclaredConfigs=[...declaredConfigs.values()].flat();
  for(const fact of readConfigs){
    let matches=(declaredConfigs.get(fact.key_name)||[]).filter(match=>match.f.repo!==fact.repo).sort((a,b)=>a.id.localeCompare(b.id));
    let matchedSegment=null;
    if(!matches.length){
      const tailCandidates=allDeclaredConfigs.map(match=>({match,tail:tailMatches(match.f.key_name,fact.key_name)})).filter(value=>value.tail&&value.match.f.repo!==fact.repo);
      const longest=Math.max(0,...tailCandidates.map(value=>value.tail.length));
      matches=tailCandidates.filter(value=>value.tail.length===longest).map(value=>value.match).sort((a,b)=>a.id.localeCompare(b.id));
      matchedSegment=tailCandidates.find(value=>value.tail.length===longest)?.tail||null;
    }
    if(!matches.length){unresolved.push({...fact,status:'unresolved'});continue;}
    const edge={id:`reads_config:${repos.get(fact.repo)}:${slug(fact.key_name)}:${slug(fact.file)}:${fact.line}`,kind:'reads_config',from:repos.get(fact.repo),to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,matches),...(matchedSegment?{matched_segment:matchedSegment}:{})};
    if(matches.length===1)edges.push(edge);else{edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
  }

  const declarations=facts.filter(fact=>fact.kind==='tf_declaration');
  const moduleCalls=facts.filter(fact=>fact.kind==='tf_module_call');
  const resourceById=new Map(resourceFacts.map(fact=>[resourceIds.get(resourceKey(fact)),fact]));
  for(const fact of facts.filter(fact=>fact.kind==='tf_ref')){
    const from=resourceIds.get(`${moduleKey(fact.repo,fact.module_path)}:${fact.from}`);
    let to=null,resolutionFact=null,resolutionKind='resource';
    if(/^(?:var|local)\./.test(fact.to)){
      const [referenceKind,name]=fact.to.split('.');
      const declarationKind=referenceKind==='var'?'variable':referenceKind;
      resolutionFact=declarations.find(value=>value.repo===fact.repo&&normalizeModulePath(value.module_path)===normalizeModulePath(fact.module_path)&&value.declaration_kind===declarationKind&&value.name===name);
      resolutionKind='declaration';
    }else if(fact.to.startsWith('module.')){
      const [,callName,outputName]=fact.to.split('.');
      const call=moduleCalls.find(value=>value.repo===fact.repo&&normalizeModulePath(value.module_path)===normalizeModulePath(fact.module_path)&&value.name===callName&&value.source&&value.source.startsWith('.'));
      const targetPath=call&&normalizeModulePath(path.posix.join(normalizeModulePath(call.module_path),call.source));
      resolutionFact=call&&declarations.find(value=>value.repo===fact.repo&&normalizeModulePath(value.module_path)===targetPath&&value.declaration_kind==='output'&&value.name===outputName);
      if(resolutionFact)to=modules.get(moduleKey(fact.repo,targetPath))?.id||null;
      resolutionKind='module_output';
    }else to=resourceIds.get(`${moduleKey(fact.repo,fact.module_path)}:${fact.to}`);
    if(from&&(to||resolutionFact)){
      const target=to||modules.get(moduleKey(fact.repo,fact.module_path))?.id;
      edges.push({id:`tf_ref:${from}:${slug(fact.to)}:${target}`,kind:'tf_ref',from,to:target,status:'resolved',resolution_kind:resolutionKind,witnesses:[provenance(fact),...(resolutionFact?[provenance(resolutionFact)]:to&&resourceById.get(to)?[provenance(resourceById.get(to))]:[])]});
      const fromFact=resourceById.get(from),toFact=resourceById.get(to);
      if(toFact&&['compute','edge'].includes(infraClass(fromFact.tf_type))&&['identity','network','config'].includes(infraClass(toFact.tf_type)))edges.push({id:`uses_infra:${from}:${to}`,kind:'uses_infra',from,to,status:'resolved',witnesses:[provenance(fromFact),provenance(fact),provenance(toFact)]});
    }else{
      // WHAT WAS EXAMINED, recorded on the record itself. A module-scoped
      // Terraform address whose target this module NEVER DECLARES cannot
      // resolve no matter how good the resolver is; conflating that with a
      // resolver defect sends repair effort at a reference the source really
      // does leave dangling. merge knows which of the two it is because it
      // just searched the declaration sets; the graph-only analyzer does not.
      const reason=!from?'source_resource_not_declared'
        :/^(?:var|local)\./.test(fact.to)?'declaration_not_found_in_module'
        :fact.to.startsWith('module.')?'module_output_not_found'
        :'target_address_not_declared_in_module';
      unresolved.push({...fact,status:'unresolved',unresolved_reason:reason});
    }
  }

  const topics=resourceFacts.filter(fact=>fact.tf_type==='aws_sns_topic').map(fact=>({f:fact,id:resourceIds.get(resourceKey(fact))}));
  const topicAliases=topic=>[topic.f.name,topic.f.address,topic.f.attributes?.name].filter(Boolean).map(topicRef);
  for(const fact of facts.filter(fact=>fact.kind==='aws_usage'&&fact.service==='sns'&&fact.op==='publish')){
    const targets=topicTargetAliases(fact.target_name_or_expr);
    let matches=topics.filter(topic=>!targets.includes('dynamic')&&topicAliases(topic).some(alias=>targets.includes(alias)));
    let matchedSegment=null;
    if(!matches.length&&!targets.includes('dynamic')){
      const tailCandidates=topics.flatMap(topic=>topicAliases(topic).map(alias=>({topic,tail:tailMatches(alias,fact.target_name_or_expr)}))).filter(value=>value.tail);
      const longest=Math.max(0,...tailCandidates.map(value=>value.tail.length));
      matches=[...new Map(tailCandidates.filter(value=>value.tail.length===longest).map(value=>[value.topic.id,value.topic])).values()];
      matchedSegment=tailCandidates.find(value=>value.tail.length===longest)?.tail||null;
    }
    matches=matches.sort((a,b)=>a.id.localeCompare(b.id));
    if(!matches.length){addUnmatched('publishes_to',fact);continue;}
    const edge={id:`publishes_to:${repos.get(fact.repo)}:${slug(fact.target_name_or_expr)}:${slug(fact.file)}:${fact.line}`,kind:'publishes_to',from:repos.get(fact.repo),to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,matches),...(matchedSegment?{matched_segment:matchedSegment}:{})};
    if(matches.length===1)edges.push(edge);else{edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
  }

  const configUrls=facts.filter(fact=>['config_value_url','config_value_template'].includes(fact.kind));
  const clientFacts=facts.filter(fact=>fact.kind==='http_client');
  const repoHints=repo=>{
    const reads=readConfigs.filter(fact=>fact.repo===repo);
    return [
      ...configUrls.filter(fact=>fact.repo===repo||reads.some(read=>read.key_name===fact.key||tailMatches(fact.key,read.key_name))).map(fact=>({fact,value:fact.url||fact.static_tail,matchedSegment:reads.map(read=>tailMatches(fact.key,read.key_name)).find(Boolean)||null})),
      ...clientFacts.filter(fact=>fact.repo===repo&&fact.client_action==='base').map(fact=>({fact,value:fact.url_or_path,matchedSegment:null})),
      ...reads.map(fact=>({fact,value:fact.key_name,matchedSegment:allDeclaredConfigs.map(match=>tailMatches(match.f.key_name,fact.key_name)).filter(Boolean).sort((a,b)=>b.length-a.length||a.localeCompare(b))[0]||null})),
    ];
  };
  const hintScore=(value,repo)=>{
    let host='';try{host=new URL(value).hostname.toLowerCase();}catch{host=String(value).toLowerCase();}
    const repoSlug=slug(repo);if(host.includes(repoSlug))return 2;
    return tokens(repo).some(token=>tokens(host).includes(token))?1:0;
  };
  const matchingRoutes=(client,hints,{allowUnhinted=false}={})=>{
    const directPath=normalizedUrlPath(client.url_or_path);
    const effectiveHints=/^https?:\/\//i.test(client.url_or_path)?[{fact:client,value:client.url_or_path}]:hints;
    const candidatePaths=new Set([directPath]);
    if(!/^https?:\/\//i.test(client.url_or_path))for(const hint of effectiveHints)try{const basePath=new URL(hint.value).pathname.replace(/\/$/,'');if(basePath)candidatePaths.add(`${basePath}${directPath}`.replace(/\/{2,}/g,'/'));}catch{}
    let matches=routes.filter(route=>route.f.repo!==client.repo&&[...candidatePaths].some(candidatePath=>routeRegex(route.f.route).test(candidatePath))&&(!client.method||client.method===route.f.method));
    if(effectiveHints.length){
      const scored=matches.map(route=>({route,score:Math.max(...effectiveHints.map(hint=>hintScore(hint.value,route.f.repo))),hint:effectiveHints.slice().sort((a,b)=>hintScore(b.value,route.f.repo)-hintScore(a.value,route.f.repo))[0]})).filter(item=>item.score>0);
      const best=Math.max(0,...scored.map(item=>item.score));
      matches=scored.filter(item=>item.score===best).map(item=>({...item.route,hint:item.hint.fact,matchedSegment:item.hint.matchedSegment,score:item.score}));
    }else if(!allowUnhinted)matches=[];
    return matches.sort((a,b)=>a.id.localeCompare(b.id));
  };

  for(const fact of clientFacts.filter(fact=>fact.client_action!=='base'&&!isTestRepo(fact.repo))){
    const matches=matchingRoutes(fact,repoHints(fact.repo));
    if(!matches.length){addUnmatched('http_call_candidate',fact);continue;}
    const hintFacts=[...new Map(matches.filter(match=>match.hint&&match.hint!==fact).map(match=>[factKey(match.hint),match.hint])).values()];
    const matchedSegment=matches.map(match=>match.matchedSegment).filter(Boolean).sort((a,b)=>b.length-a.length||a.localeCompare(b))[0];
    const edge={id:`http_call_candidate:${repos.get(fact.repo)}:${slug(normalizedUrlPath(fact.url_or_path))}:${slug(fact.file)}:${fact.line}`,kind:'http_call_candidate',from:repos.get(fact.repo),to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,matches,hintFacts),...(matchedSegment?{matched_segment:matchedSegment}:{})};
    if(matches.length===1)edges.push(edge);else{edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
  }

  for(const fact of clientFacts.filter(fact=>fact.client_action!=='base'&&isTestRepo(fact.repo))){
    const matches=uniqueByRepo(matchingRoutes(fact,repoHints(fact.repo),{allowUnhinted:true}));
    if(!matches.length){addUnmatched('tests_against',fact);continue;}
    const hintFacts=[...new Map(matches.filter(match=>match.hint&&match.hint!==fact).map(match=>[factKey(match.hint),match.hint])).values()];
    const edge={id:`tests_against:${repos.get(fact.repo)}:${slug(normalizedUrlPath(fact.url_or_path))}:${slug(fact.file)}:${fact.line}`,kind:'tests_against',from:repos.get(fact.repo),to:matches.length===1?repos.get(matches[0].f.repo):null,status:matches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,matches,hintFacts)};
    if(matches.length===1)edges.push(edge);else{edge.candidates=[...new Set(matches.map(match=>repos.get(match.f.repo)))];addAmbiguous(edge,fact);}
  }

  for(const fact of facts.filter(fact=>fact.kind==='sql_object'))addNode(`sql:${slug(fact.repo)}:${slug(fact.object)}`,'sql_object',fact.object,fact.repo,provenance(fact),{object_kind:fact.object_kind});
  for(const fact of facts.filter(fact=>fact.kind==='coverage'))addNode(`coverage:${slug(fact.repo)}`,'coverage',fact.repo,fact.repo,provenance(fact),{files_scanned:fact.files_scanned,files_skipped:fact.files_skipped,parse_errors:fact.parse_errors});

  // JS/TS/TSX module graph (AC-IMPORT-RESOLUTION): 'module' nodes plus a
  // deterministic import-edge resolution pass. Resolution is fact-only —
  // candidates are matched against the set of 'module' facts this toolkit
  // actually extracted, never a live filesystem check, so re-running merge
  // alone (without re-extracting) always yields the same answer.
  const moduleNodeIdPart=value=>value.split('/').map(segment=>encodeURIComponent(segment)).join('/');
  const moduleNodeId=(repo,file)=>`module:${slug(repo)}:${moduleNodeIdPart(file)}`;
  const declarationScopeNotNameable=fact=>fact.kind==='symbol'&&(!Array.isArray(fact.scope_path)||!fact.scope_path.length
    ||fact.scope_path.some(part=>part===undefined||part===null||String(part).trim()===''));
  const declarationScopeRefusalsByModule=new Map();
  for(const fact of facts.filter(declarationScopeNotNameable)){
    const key=`${fact.repo}:${fact.file}`;
    declarationScopeRefusalsByModule.set(key,(declarationScopeRefusalsByModule.get(key)||0)+1);
  }
  const modulesByPath=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='module')){
    const key=`${fact.repo}:${fact.file}`;
    const id=addNode(moduleNodeId(fact.repo,fact.file),'module',fact.file,fact.repo,provenance(fact),{
      language:fact.language,
      declaration_scope_not_nameable_count:declarationScopeRefusalsByModule.get(key)||0,
      ...(fact.package!==undefined?{package:fact.package}:{}),
    });
    modulesByPath.set(key,{id,f:fact});
  }
  const JS_EXTENSION_ORDER=['.ts','.tsx','.js','.jsx','.mjs','.cjs'];
  const JS_INDEX_BASENAMES=JS_EXTENSION_ORDER.map(ext=>`index${ext}`);
  const resolveModuleCandidates=(repo,basePath)=>{
    const normalized=path.posix.normalize(basePath);
    const candidates=[normalized,...JS_EXTENSION_ORDER.map(ext=>`${normalized}${ext}`),...JS_INDEX_BASENAMES.map(name=>path.posix.join(normalized,name))];
    return [...new Set(candidates)].map(candidate=>modulesByPath.get(`${repo}:${candidate}`)).filter(Boolean).sort((a,b)=>a.id.localeCompare(b.id));
  };
  // CROSS-COMPONENT RELATIVE IMPORTS (AC-XCOMPONENT-RESOLUTION).
  //
  // A relative specifier is a FILESYSTEM PATH. Component membership is a
  // grouping/presentation attribute of this tool, not a resolution boundary:
  // `plugins/<x>/server/index.mjs` importing `../../../src/foo.mjs` names a
  // real file that lives in a SIBLING component, and resolving only within
  // the importing file's own component discarded every such import (measured:
  // 1,289 records / 509 disconnected source nodes on the dashboard estate).
  //
  // The estate index is keyed by ESTATE-RELATIVE path, built from each
  // component's EXPLICIT emitted root (see repoEstateRoots above) joined with
  // the module fact's component-relative file. It is a FALLBACK, consulted
  // only when same-component resolution found nothing, so a local import can
  // never be hijacked by a same-named file in a sibling component.
  //
  // A path that normalizes ABOVE the estate root is refused outright: nothing
  // outside the scanned estate is ever a resolution target.
  const escapesEstateRoot=estatePath=>estatePath==='..'||estatePath.startsWith('../');
  const modulesByEstatePath=new Map();
  for(const entry of modulesByPath.values()){
    const root=estateRootFor(entry.f.repo);
    const estatePath=path.posix.normalize(root==='.'?entry.f.file:path.posix.join(root,entry.f.file));
    if(escapesEstateRoot(estatePath))continue;
    if(!modulesByEstatePath.has(estatePath))modulesByEstatePath.set(estatePath,entry);
  }
  const resolveModuleCandidatesEstate=estateBasePath=>{
    const normalized=path.posix.normalize(estateBasePath);
    if(escapesEstateRoot(normalized))return [];
    const candidates=[normalized,...JS_EXTENSION_ORDER.map(ext=>`${normalized}${ext}`),...JS_INDEX_BASENAMES.map(name=>path.posix.join(normalized,name))];
    return [...new Set(candidates)].map(candidate=>modulesByEstatePath.get(candidate)).filter(Boolean).sort((a,b)=>a.id.localeCompare(b.id));
  };
  // Honest attribution for a relative import that resolved to nothing: a
  // specifier that leaves the estate, or whose target the scan-scope
  // exclusion set deliberately removed, is NOT a "should have resolved"
  // defect — there is no node to reach by design. Recorded on the unresolved
  // record so the connectivity analyzer categorizes it without re-deriving
  // component roots.
  // A specifier naming a NON-SOURCE ASSET (`./index.css`, `./logo.svg`) is
  // correct code that no source extractor will ever produce a module fact for:
  // the JS extractor's filePattern covers .ts/.tsx/.js/.jsx/.mjs/.cjs only. It
  // is not a missing edge, so it is annotated as its own reason rather than
  // being counted as "should have resolved".
  const NON_SOURCE_ASSET_EXTENSIONS=new Set(['.css','.scss','.sass','.less','.svg','.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.woff','.woff2','.ttf','.eot','.otf','.md','.mdx','.txt','.csv','.wasm','.glsl','.frag','.vert','.graphql','.gql','.html','.vue','.svelte','.yaml','.yml']);
  const estateDirectoriesWithModules=new Set();
  for(const estatePath of modulesByEstatePath.keys())estateDirectoriesWithModules.add(path.posix.dirname(estatePath));
  const relativeImportUnresolvedAnnotation=(estateBasePath,specifier=null)=>{
    if(estateBasePath===null)return {};
    if(escapesEstateRoot(estateBasePath))return {estate_target_path:estateBasePath,unresolved_reason:'escapes_estate_root'};
    const exclusion=classifyExcludedPath(estateBasePath);
    if(exclusion)return {estate_target_path:estateBasePath,unresolved_reason:'excluded_by_scan_scope',excluded_by_scan_scope:exclusion};
    const extension=path.posix.extname(String(specifier??estateBasePath)).toLowerCase();
    if(NON_SOURCE_ASSET_EXTENSIONS.has(extension))return {estate_target_path:estateBasePath,unresolved_reason:'non_source_asset',asset_extension:extension};
    // DANGLING vs UNREACHED, decided from facts alone: if the target's own
    // directory produced module facts then the scan DID cover it and the named
    // file simply is not there — a source-side dangling reference, not a
    // resolver defect. If the directory produced no module facts at all the
    // scan never reached it and the resolver verdict is genuinely open.
    const directory=path.posix.dirname(estateBasePath);
    return {estate_target_path:estateBasePath,unresolved_reason:'no_module_fact',target_directory_scanned:estateDirectoriesWithModules.has(directory)};
  };
  // SOURCE-OVER-GENERATED-SIBLING (JS/TS extension tie).
  //
  // Measured problem: 9,465 of 10,662 ambiguous records (88.8%) on a real
  // estate were a tie between a TypeScript source file and a compiled
  // JavaScript file COMMITTED NEXT TO IT (`lib/environment.ts` +
  // `lib/environment.js`, from `import './environment'`). JS_EXTENSION_ORDER
  // is an enumeration order, not a precedence, so merge saw 2 candidates and
  // emitted no edge at all.
  //
  // The rule is general, not a path list: among the candidate MODULE FACTS
  // (real `{kind:'module', repo, file, language}` records emitted by
  // extract.mjs -> treesitter-js), a candidate whose extension is a compiled
  // JavaScript output extension is dropped IFF another candidate with the
  // IDENTICAL path stem (same directory, same basename) is a TypeScript
  // source file. Same-stem TS/JS coexistence is the signature of committed
  // compiled output; the TypeScript file is the source of truth the import
  // means.
  //
  // Deliberately NARROW, so no false edge is manufactured:
  //   * different stems (`foo.ts` vs `foo/index.js`, or two alias targets in
  //     different directories) are a GENUINE ambiguity and stay ambiguous;
  //   * a tie among several TypeScript sources stays ambiguous;
  //   * a tie among several JavaScript files with no TS sibling stays
  //     ambiguous;
  //   * if the preference would eliminate every candidate, the original set
  //     is returned unchanged.
  const TS_SOURCE_EXTENSIONS=new Set(['.ts','.tsx']);
  const GENERATED_JS_EXTENSIONS=new Set(['.js','.jsx','.mjs','.cjs']);
  const jsModuleStem=file=>String(file).replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/,'');
  const preferSourceOverGeneratedSibling=matches=>{
    if(matches.length<2)return {matches,superseded:[]};
    const described=matches.map(match=>({match,ext:path.posix.extname(match.f.file).toLowerCase(),stem:jsModuleStem(match.f.file)}));
    const sourceStems=new Set(described.filter(value=>TS_SOURCE_EXTENSIONS.has(value.ext)).map(value=>value.stem));
    if(!sourceStems.size)return {matches,superseded:[]};
    const kept=described.filter(value=>!(GENERATED_JS_EXTENSIONS.has(value.ext)&&sourceStems.has(value.stem)));
    if(!kept.length||kept.length===described.length)return {matches,superseded:[]};
    return {matches:kept.map(value=>value.match),superseded:described.filter(value=>!kept.includes(value)).map(value=>value.match.id).sort()};
  };
  const aliasesByRepo=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='ts_path_alias')){const values=aliasesByRepo.get(fact.repo)||[];values.push(fact);aliasesByRepo.set(fact.repo,values);}
  const aliasMatchesFor=(repo,specifier)=>(aliasesByRepo.get(repo)||[]).filter(alias=>{
    const wildcard=alias.pattern.endsWith('*');
    const prefix=wildcard?alias.pattern.slice(0,-1):alias.pattern;
    return wildcard?specifier.startsWith(prefix):specifier===alias.pattern;
  });
  const resolveAliasCandidates=(repo,specifier)=>{
    const results=new Map();
    for(const alias of aliasMatchesFor(repo,specifier)){
      const wildcard=alias.pattern.endsWith('*');
      const suffix=wildcard?specifier.slice(alias.pattern.length-1):'';
      for(const target of alias.targets){
        const resolvedTarget=wildcard?target.replace(/\*$/,suffix):target;
        for(const candidate of resolveModuleCandidates(repo,path.posix.join(alias.base_dir,resolvedTarget)))results.set(candidate.id,candidate);
      }
    }
    return [...results.values()].sort((a,b)=>a.id.localeCompare(b.id));
  };
  // typeof-guard: Swift's 'import' facts carry `module`, not `specifier`, so
  // the typeof check excludes them from this JS/TS-specifier-shaped loop.
  // Python's 'import' facts DO carry a string `specifier` (including
  // relative specifiers starting with '.'), so the typeof guard alone is
  // NOT enough -- a Python relative import would otherwise be misresolved
  // against JS/TS file-extension candidates here. Python's own resolver
  // (AC-PYTHON-RESOLUTION, below) runs separately, so .py facts are
  // excluded from this loop by file extension.
  for(const fact of facts.filter(fact=>fact.kind==='import'&&typeof fact.specifier==='string'&&!fact.file.endsWith('.py'))){
    const fromModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!fromModule)continue;
    const isRelative=fact.specifier.startsWith('.');
    const isAliased=!isRelative&&aliasMatchesFor(fact.repo,fact.specifier).length>0;
    if(!isRelative&&!isAliased)continue; // bare/package specifier: `depends_on` (orphan-closure block below) binds those to the declared package
    // A `?query` / `#fragment` suffix is a LOADER argument, not part of the
    // path: Node resolves `./x.mjs?guard=prod` to `./x.mjs` and re-evaluates
    // it. Resolving the raw string found no module fact and reported a
    // "should have resolved" defect for correct code.
    const resolvableSpecifier=isRelative?fact.specifier.replace(/[?#].*$/,''):fact.specifier;
    const specifierSuffixStripped=resolvableSpecifier!==fact.specifier;
    const relativeBase=isRelative?path.posix.join(path.posix.dirname(fact.file),resolvableSpecifier):null;
    const estateBase=isRelative?path.posix.normalize(path.posix.join(estateRootFor(fact.repo),relativeBase)):null;
    let rawMatches=isRelative
      ?resolveModuleCandidates(fact.repo,relativeBase)
      :resolveAliasCandidates(fact.repo,fact.specifier);
    // Same-component resolution takes precedence; the estate-wide index is
    // consulted only when it produced nothing.
    let resolutionScope=null;
    if(isRelative&&!rawMatches.length){
      const estateMatches=resolveModuleCandidatesEstate(estateBase);
      if(estateMatches.length){rawMatches=estateMatches;resolutionScope='estate_relative_path';}
    }
    const {matches,superseded}=preferSourceOverGeneratedSibling(rawMatches);
    const edge={id:`imports:${fromModule.id}:${slug(fact.specifier)}:${slug(fact.file)}:${fact.line}`,kind:'imports',from:fromModule.id,to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':matches.length===0?'unresolved':'ambiguous',witnesses:matches.length===1?witnessesFor(fact,[matches[0]]):[provenance(fact)],...(resolutionScope?{resolution_scope:resolutionScope}:{}),...(specifierSuffixStripped?{resolution_kind:'loader_query_suffix_stripped',resolvable_specifier:resolvableSpecifier}:{}),...(superseded.length?{resolution_kind:'source_over_generated_sibling',superseded_candidates:superseded}:{})};
    if(matches.length===1)edges.push(edge);
    else if(matches.length>1){edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
    else unresolved.push({...fact,status:'unresolved',...relativeImportUnresolvedAnnotation(estateBase,resolvableSpecifier)});
  }

  // Swift module graph (AC-SWIFT-RESOLUTION): unlike JS/TS, a single Swift
  // MODULE has NO per-file import statements between its own files -- every
  // top-level declaration in a module is visible file-to-file without an
  // import. `import Foo` names an external MODULE/framework dependency, not
  // a file, so intra-module file-to-file coupling can only be recovered by
  // resolving 'reference' facts (type names used in inheritance, property/
  // parameter/return type annotations, generics, casts -- see
  // treesitter-swift.mjs) against a project-wide symbol table of declared
  // top-level types/functions. This produces two edge kinds distinct from
  // JS's specifier-based `imports` edges:
  //   - `imports_framework`: always external -- a framework import is never
  //     locally resolvable, and per AC-SWIFT-RESOLUTION it is KEPT (not
  //     dropped) as an edge to an external module dependency node.
  //   - `references`: resolved/ambiguous/external per the count of files
  //     (excluding the referencing file itself) that declare the
  //     referenced name -- exactly 1 => resolved, 0 => external, >1 =>
  //     ambiguous with candidates. Never guessed.
  const swiftFrameworkNodeId=moduleName=>`swift_framework:${slug(moduleName)}`;
  for(const fact of facts.filter(fact=>fact.kind==='import'&&fact.import_kind==='framework')){
    const fromModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(fromModule?.f.language!=='swift')continue;
    const frameworkId=addNode(swiftFrameworkNodeId(fact.module),'swift_framework',fact.module,fact.repo,provenance(fact));
    edges.push({id:`imports_framework:${fromModule.id}:${slug(fact.module)}:${slug(fact.file)}:${fact.line}`,kind:'imports_framework',from:fromModule.id,to:frameworkId,status:'external',witnesses:[provenance(fact)]});
  }

  // Symbol table scoped per repo -- the estate-map tool's coarsest grain. A
  // real Swift MODULE/target is finer-grained than a whole repo, so two
  // same-named top-level declarations in different targets within one repo
  // will show up as `ambiguous` here; that is a deliberate, documented limit
  // of this repo-grained approximation, not a bug. `extension` declarations
  // are DELIBERATELY EXCLUDED: an extension doesn't declare a new top-level
  // type, it adds members to one declared elsewhere, and real Swift code
  // routinely puts an extension of type `Foo` in a different file from
  // `Foo`'s own declaration (e.g. `Foo+CoreDataProperties.swift`) --
  // including extensions here would make every reference to a commonly-
  // extended type falsely ambiguous.
  const swiftSymbolTable=new Map(); // repo -> name -> Map(file -> declaring symbol fact)
  for(const fact of facts.filter(fact=>fact.kind==='symbol'&&['class','struct','enum','protocol','function'].includes(fact.symbol_kind))){
    const declaringModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(declaringModule?.f.language!=='swift')continue;
    const byRepo=swiftSymbolTable.get(fact.repo)||new Map();
    const byName=byRepo.get(fact.name)||new Map();
    if(!byName.has(fact.file))byName.set(fact.file,fact);
    byRepo.set(fact.name,byName);
    swiftSymbolTable.set(fact.repo,byRepo);
  }
  for(const fact of facts.filter(fact=>fact.kind==='reference')){
    const fromModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(fromModule?.f.language!=='swift')continue;
    const declMap=swiftSymbolTable.get(fact.repo)?.get(fact.name)||new Map();
    const allDeclaringFiles=[...declMap.keys()].sort();
    if(!allDeclaringFiles.length){
      // 0 matches anywhere in this repo's symbol table -> a builtin/stdlib/
      // framework type (or simply not declared in the scanned tree):
      // external, per AC-SWIFT-RESOLUTION. Emitted as a real edge (not
      // dropped) for visibility, and recorded in `unresolved` for audit.
      edges.push({id:`references:${fromModule.id}:${slug(fact.name)}:${slug(fact.file)}:${fact.line}`,kind:'references',from:fromModule.id,to:null,status:'external',witnesses:[provenance(fact)]});
      unresolved.push({...fact,status:'external'});
      continue;
    }
    const crossFileDeclaringFiles=allDeclaringFiles.filter(file=>file!==fact.file);
    if(!crossFileDeclaringFiles.length)continue; // the only declaration is this very file: a same-file self-reference, not a cross-file coupling -- no edge.
    const candidates=crossFileDeclaringFiles.map(file=>({f:declMap.get(file),id:modulesByPath.get(`${fact.repo}:${file}`)?.id})).filter(match=>match.id);
    const edge={id:`references:${fromModule.id}:${slug(fact.name)}:${slug(fact.file)}:${fact.line}`,kind:'references',from:fromModule.id,to:candidates.length===1?candidates[0].id:null,status:candidates.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,candidates)};
    if(candidates.length===1)edges.push(edge);
    else{edge.candidates=candidates.map(match=>match.id);addAmbiguous(edge,fact);}
  }

  // Kotlin import-FQN resolution (AC-KOTLIN-RESOLUTION): a fact-only pass,
  // same discipline as the JS/TS resolver above — no live filesystem check,
  // no guessing. A file's fully-qualified symbols are its declared package
  // (from the 'module' fact) plus each of its top-level 'symbol' facts'
  // names. An explicit `import a.b.C` FQN resolves to whichever module(s)
  // declare `C` in package `a.b`: 0 matches against a known external/SDK
  // root (kotlin/androidx/java/*, see KOTLIN_EXTERNAL_PACKAGE_ROOTS) ⇒
  // 'external'; 0 matches otherwise ⇒ 'unresolved' — EITHER WAY kept in
  // `unresolved`, never dropped; exactly 1 ⇒ resolved 'imports' edge; >1 ⇒
  // ambiguous via the same addAmbiguous() ledger the rest of merge.mjs uses.
  // A wildcard `import a.b.*` resolves to package `a.b` directly: every
  // module declaring that package is a genuine target (not an unknowable
  // choice among candidates), so it enumerates one resolved edge per
  // matching module — the "resolve to all matching modules in that package"
  // branch of the spec, since the fact set always makes that enumeration
  // tractable (never falls back to a package-level stub edge).
  const kotlinModulesByPath=new Map();
  for(const[key,entry]of modulesByPath)if(entry.f.language==='kotlin'||entry.f.language==='kotlin-script')kotlinModulesByPath.set(key,entry);
  const kotlinPackageToModules=new Map();
  for(const entry of kotlinModulesByPath.values()){
    const key=`${entry.f.repo}\0${entry.f.package||''}`;
    const values=kotlinPackageToModules.get(key)||[];values.push(entry);kotlinPackageToModules.set(key,values);
  }
  const kotlinFqnToModules=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='symbol')){
    const entry=kotlinModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!entry)continue;
    const fqn=entry.f.package?`${entry.f.package}.${fact.name}`:fact.name;
    const key=`${fact.repo}\0${fqn}`;
    const values=kotlinFqnToModules.get(key)||[];values.push(entry);kotlinFqnToModules.set(key,values);
  }
  for(const fact of facts.filter(fact=>fact.kind==='import')){
    const fromModule=kotlinModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!fromModule)continue; // not a Kotlin import fact (JS/TS imports handled above)
    const fqnBase=fact.is_wildcard?fact.specifier.slice(0,-2):fact.specifier;
    const candidates=(fact.is_wildcard
      ?kotlinPackageToModules.get(`${fact.repo}\0${fqnBase}`)
      :kotlinFqnToModules.get(`${fact.repo}\0${fqnBase}`))||[];
    const filtered=[...new Map(candidates.filter(candidate=>candidate.id!==fromModule.id).map(candidate=>[candidate.id,candidate])).values()];
    if(!filtered.length){
      unresolved.push({...fact,status:isExternalKotlinPackage(fqnBase)?'external':'unresolved'});
      continue;
    }
    if(fact.is_wildcard){
      for(const candidate of filtered.sort((a,b)=>a.id.localeCompare(b.id))){
        edges.push({id:`imports:${fromModule.id}:${slug(fact.specifier)}:${slug(fact.file)}:${fact.line}:${candidate.id}`,kind:'imports',from:fromModule.id,to:candidate.id,status:'resolved',resolution_kind:'wildcard_package',witnesses:witnessesFor(fact,[candidate])});
      }
      continue;
    }
    const edge={id:`imports:${fromModule.id}:${slug(fact.specifier)}:${slug(fact.file)}:${fact.line}`,kind:'imports',from:fromModule.id,to:filtered.length===1?filtered[0].id:null,status:filtered.length===1?'resolved':'ambiguous',witnesses:filtered.length===1?witnessesFor(fact,[filtered[0]]):[provenance(fact)]};
    if(filtered.length===1)edges.push(edge);
    else{
      // KOTLIN_AMBIGUOUS_CANDIDATE_CAP: real large multi-module Android
      // estates can redeclare the exact same package+symbol name across
      // dozens of independent Gradle modules (this repo's own module
      // boundaries are invisible to a single-repo fact model, so every
      // same-named redeclaration looks like one giant ambiguity) — up to
      // ~160 candidates per import observed against the real sw-android
      // source. The status stays 'ambiguous' regardless (never guessed);
      // this caps only how many candidate ids are ENUMERATED in the graph
      // (same SAMPLE_CAP-style bounded-evidence precedent extract.mjs
      // already uses for parse-error/secret samples), with the true total
      // preserved via candidate_count/candidates_truncated so nothing is
      // silently hidden. Without this cap, a handful of real high-fan-out
      // imports multiply into millions of candidate-id array entries and
      // stableStringify's JSON.stringify(...,null,2) throws
      // 'RangeError: Invalid string length' before any file is written.
      const KOTLIN_AMBIGUOUS_CANDIDATE_CAP=25;
      const sortedCandidateIds=filtered.map(match=>match.id).sort((a,b)=>a.localeCompare(b));
      edge.candidates=sortedCandidateIds.length>KOTLIN_AMBIGUOUS_CANDIDATE_CAP?sortedCandidateIds.slice(0,KOTLIN_AMBIGUOUS_CANDIDATE_CAP):sortedCandidateIds;
      if(sortedCandidateIds.length>KOTLIN_AMBIGUOUS_CANDIDATE_CAP){edge.candidate_count=sortedCandidateIds.length;edge.candidates_truncated=true;}
      addAmbiguous(edge,fact);
    }
  }

  // C# type-reference resolution (AC-CSHARP-RESOLUTION): C# is like
  // Swift/Kotlin, not JS/TS — `using X.Y;` names a NAMESPACE, not a file,
  // and multiple files routinely share one namespace with no `using`
  // between them at all. File-to-file coupling is recovered by resolving
  // 'reference' facts (base-list/field/property/param/return-type usages,
  // see treesitter-csharp.mjs) against a project-wide namespace+type symbol
  // table, using each referencing file's in-scope namespaces: its own
  // declared namespace(s) (from 'namespace' facts) plus its plain
  // (non-static, non-aliased) `using` targets — including any REPO-WIDE
  // `global using` target, which C# scopes to every file in the project,
  // not just the file that declares it. A qualified reference
  // (`Some.Namespace.Type`) bypasses in-scope-namespace resolution
  // entirely: its own dotted prefix names the namespace explicitly, exactly
  // as real C# name lookup works. Same discipline as the Swift/Kotlin
  // passes above: 1 declaring file (excluding the referencing file itself)
  // => resolved edge; 0 anywhere => external (System/Microsoft/NuGet or
  // simply not declared in the scanned tree) — KEPT as a real edge, never
  // dropped, mirroring treesitter-swift.mjs's single 'external' status
  // (no separate kotlin-style external/unresolved split, since C#'s
  // resolvable-root set is unbounded — arbitrary NuGet namespaces — unlike
  // Kotlin's small closed set of SDK roots); >1 => ambiguous with candidates
  // (capped, same CAP-and-truncate precedent as the Kotlin resolver, for
  // large real estates). Never guessed.
  const csharpModulesByPath=new Map();
  for(const[key,entry]of modulesByPath)if(entry.f.language==='csharp')csharpModulesByPath.set(key,entry);

  const csharpOwnNamespacesByFile=new Map(); // 'repo:file' -> Set(fqn) of namespaces declared IN this file
  for(const fact of facts.filter(fact=>fact.kind==='namespace')){
    const entry=csharpModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!entry)continue;
    const key=`${fact.repo}:${fact.file}`;
    const values=csharpOwnNamespacesByFile.get(key)||new Set();
    values.add(fact.name);
    csharpOwnNamespacesByFile.set(key,values);
  }

  const csharpUsingNamespacesByFile=new Map(); // 'repo:file' -> Set(fqn) of plain/global (non-static, non-aliased) using targets declared IN this file
  const csharpGlobalUsingsByRepo=new Map(); // repo -> Set(fqn) of `global using` targets, in scope for EVERY file in the repo
  for(const fact of facts.filter(fact=>fact.kind==='import'&&!fact.is_static&&!fact.alias)){
    const entry=csharpModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!entry)continue; // not a C# import fact (JS/Kotlin/Swift imports handled by their own passes above)
    const key=`${fact.repo}:${fact.file}`;
    const values=csharpUsingNamespacesByFile.get(key)||new Set();
    values.add(fact.target);
    csharpUsingNamespacesByFile.set(key,values);
    if(fact.is_global){
      const repoValues=csharpGlobalUsingsByRepo.get(fact.repo)||new Set();
      repoValues.add(fact.target);
      csharpGlobalUsingsByRepo.set(fact.repo,repoValues);
    }
  }
  const csharpInScopeNamespaces=(repo,file)=>{
    const own=csharpOwnNamespacesByFile.get(`${repo}:${file}`);
    const scope=new Set(own&&own.size?own:['']);
    for(const ns of(csharpUsingNamespacesByFile.get(`${repo}:${file}`)||[]))scope.add(ns);
    for(const ns of(csharpGlobalUsingsByRepo.get(repo)||[]))scope.add(ns);
    return scope;
  };

  const CSHARP_SYMBOL_KINDS=new Set(['class','struct','interface','enum','record']);
  const csharpSymbolTable=new Map(); // 'repo\0namespace\0TypeName' -> [{id,file,f}]
  for(const fact of facts.filter(fact=>fact.kind==='symbol'&&CSHARP_SYMBOL_KINDS.has(fact.symbol_kind))){
    const entry=csharpModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!entry)continue;
    const key=`${fact.repo}\0${fact.namespace||''}\0${fact.name}`;
    const values=csharpSymbolTable.get(key)||[];
    values.push({id:entry.id,file:fact.file,f:fact});
    csharpSymbolTable.set(key,values);
  }

  const CSHARP_AMBIGUOUS_CANDIDATE_CAP=25;
  for(const fact of facts.filter(fact=>fact.kind==='reference')){
    const fromModule=csharpModulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!fromModule)continue; // not a C# reference fact (Swift 'reference' facts handled by the pass above)
    const lastDot=fact.name.lastIndexOf('.');
    const explicitNamespace=lastDot>=0?fact.name.slice(0,lastDot):null;
    const typeName=lastDot>=0?fact.name.slice(lastDot+1):fact.name;
    const candidateNamespaces=explicitNamespace!==null?[explicitNamespace]:[...csharpInScopeNamespaces(fact.repo,fact.file)];
    const seen=new Set(),allMatches=[];
    for(const ns of candidateNamespaces){
      for(const candidate of(csharpSymbolTable.get(`${fact.repo}\0${ns}\0${typeName}`)||[])){
        if(seen.has(candidate.id))continue;
        seen.add(candidate.id);allMatches.push(candidate);
      }
    }
    if(!allMatches.length){
      // 0 matches anywhere in this repo's symbol table -> external (System/
      // Microsoft/NuGet, or simply not declared in the scanned tree).
      // Emitted as a real edge (not dropped) for visibility, and recorded in
      // `unresolved` for audit.
      edges.push({id:`references:${fromModule.id}:${slug(fact.name)}:${slug(fact.file)}:${fact.line}`,kind:'references',from:fromModule.id,to:null,status:'external',witnesses:[provenance(fact)]});
      unresolved.push({...fact,status:'external'});
      continue;
    }
    const crossFileMatches=allMatches.filter(candidate=>candidate.file!==fact.file);
    if(!crossFileMatches.length)continue; // the only declaration is this very file: a same-file self-reference, not a cross-file coupling -- no edge.
    crossFileMatches.sort((a,b)=>a.id.localeCompare(b.id));
    const edge={id:`references:${fromModule.id}:${slug(fact.name)}:${slug(fact.file)}:${fact.line}`,kind:'references',from:fromModule.id,to:crossFileMatches.length===1?crossFileMatches[0].id:null,status:crossFileMatches.length===1?'resolved':'ambiguous',witnesses:witnessesFor(fact,crossFileMatches)};
    if(crossFileMatches.length===1)edges.push(edge);
    else{
      const sortedCandidateIds=crossFileMatches.map(match=>match.id).sort((a,b)=>a.localeCompare(b));
      edge.candidates=sortedCandidateIds.length>CSHARP_AMBIGUOUS_CANDIDATE_CAP?sortedCandidateIds.slice(0,CSHARP_AMBIGUOUS_CANDIDATE_CAP):sortedCandidateIds;
      if(sortedCandidateIds.length>CSHARP_AMBIGUOUS_CANDIDATE_CAP){edge.candidate_count=sortedCandidateIds.length;edge.candidates_truncated=true;}
      addAmbiguous(edge,fact);
    }
  }

  // Python module graph (AC-PYTHON-RESOLUTION): resolves absolute dotted
  // imports against inferred source roots and relative imports by walking
  // up per dot count. For `from a.b import c`, an existing a/b/c.py or
  // a/b/c/__init__.py is the import target; otherwise c is treated as an
  // attribute and resolution falls back to a.b. This mirrors Python's
  // submodule-first import behavior without executing source. Never guesses: exactly one
  // candidate file ⇒ resolved edge; zero ⇒ unresolved (stdlib/third-party
  // — kept in graph.unresolved, never dropped); more than one ⇒ ambiguous
  // with explicit candidates, same discipline as every other edge kind
  // above.
  const pythonPackageDirsByRepo=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='module'&&fact.file.endsWith('.py')&&fact.is_package)){
    const dirs=pythonPackageDirsByRepo.get(fact.repo)||new Set();
    dirs.add(path.posix.dirname(fact.file));
    pythonPackageDirsByRepo.set(fact.repo,dirs);
  }
  const isPythonPackageDir=(repo,dir)=>pythonPackageDirsByRepo.get(repo)?.has(dir)||false;
  const pythonSourceRootFor=(repo,packageDir)=>{
    let dir=packageDir;
    while(true){
      const parent=dir==='.'?null:path.posix.dirname(dir);
      if(parent===null)return'.';
      if(!isPythonPackageDir(repo,parent))return parent;
      dir=parent;
    }
  };
  const pythonSourceRootsByRepo=new Map();
  for(const[repo,dirs]of pythonPackageDirsByRepo)pythonSourceRootsByRepo.set(repo,new Set(['.',...[...dirs].map(dir=>pythonSourceRootFor(repo,dir))]));
  const resolvePythonModuleAtPath=(repo,targetPath,{allowFile=true,allowPackage=true}={})=>{
    const normalized=path.posix.normalize(targetPath);
    const candidates=[allowFile&&normalized!=='.'?`${normalized}.py`:null,allowPackage?path.posix.join(normalized,'__init__.py'):null];
    return candidates.filter(Boolean).map(candidate=>modulesByPath.get(`${repo}:${candidate}`)).filter(Boolean);
  };
  const resolvePythonAbsolute=(repo,dottedSpecifier)=>{
    const relPath=dottedSpecifier.split('.').join('/');
    const roots=pythonSourceRootsByRepo.get(repo)||new Set(['.']);
    const results=new Map();
    for(const root of roots)for(const match of resolvePythonModuleAtPath(repo,path.posix.join(root,relPath)))results.set(match.id,match);
    return[...results.values()].sort((a,b)=>a.id.localeCompare(b.id));
  };
  const resolvePythonRelative=(repo,importingFile,specifier)=>{
    const dots=(specifier.match(/^\.+/)||[''])[0].length;
    const suffix=specifier.slice(dots);
    let dir=path.posix.dirname(importingFile);
    for(let i=0;i<dots-1;i++){
      if(dir==='.')return[]; // cannot ascend above the repository root
      dir=path.posix.dirname(dir);
    }
    const targetPath=suffix?path.posix.join(dir,suffix.split('.').join('/')):dir;
    return resolvePythonModuleAtPath(repo,targetPath,{allowFile:Boolean(suffix),allowPackage:true}).sort((a,b)=>a.id.localeCompare(b.id));
  };
  const resolvePythonImport=(fact)=>{
    const resolve=(specifier)=>fact.import_kind==='relative-from'
      ?resolvePythonRelative(fact.repo,fact.file,specifier)
      :resolvePythonAbsolute(fact.repo,specifier);
    const isFromImport=fact.import_kind==='from-import'||fact.import_kind==='relative-from';
    if(!isFromImport||!fact.imported_name||fact.imported_name==='*')return resolve(fact.specifier);
    const separator=fact.specifier.endsWith('.')?'':'.';
    const importedMatches=resolve(`${fact.specifier}${separator}${fact.imported_name}`);
    return importedMatches.length>0?importedMatches:resolve(fact.specifier);
  };
  for(const fact of facts.filter(fact=>fact.kind==='import'&&fact.file.endsWith('.py'))){
    const fromModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!fromModule)continue;
    const matches=resolvePythonImport(fact);
    const importedName=fact.imported_name?`:${slug(fact.imported_name)}`:'';
    const edge={id:`imports:${fromModule.id}:py:${slug(fact.specifier)}${importedName}:${slug(fact.file)}:${fact.line}`,kind:'imports',from:fromModule.id,to:matches.length===1?matches[0].id:null,status:matches.length===1?'resolved':matches.length===0?'unresolved':'ambiguous',witnesses:matches.length===1?witnessesFor(fact,[matches[0]]):[provenance(fact)]};
    if(matches.length===1)edges.push(edge);
    else if(matches.length>1){edge.candidates=matches.map(match=>match.id);addAmbiguous(edge,fact);}
    else unresolved.push({...fact,status:'unresolved'});
  }

  // ENVELOPE FLOW (envelope_flow facts -> first-class `envelope_kind` nodes).
  //
  // This estate's real coupling is the bus, not the import graph: components
  // emit and consume envelopes and never import each other. The kind is
  // modelled as a NODE rather than as component->component edges because
  //   (a) an emitted-never-consumed / consumed-never-emitted kind is exactly
  //       the defect worth surfacing, and an orphan has no second endpoint to
  //       hang a direct edge on;
  //   (b) fan-in/fan-out becomes plain node degree instead of an O(n*m) mesh;
  //   (c) a wildcard subscription (`brew.*`) names no single peer;
  //   (d) it matches the existing vocabulary, where `reads_config` and
  //       `publishes_to` already point AT the resource node.
  // Rationale + measurements: tools/estate-map/examples/
  // envelope-flow-report-2026-07-25.md §3.
  // MANIFEST SUBSCRIPTION KEYS (defect D15 / instrument fix I4). The loader
  // accepts two keys and validates one. Both halves are read as FACTS off the
  // real loader module (extractors/envelopes.mjs emits `manifest_key_validation`
  // for each `validateEnvelopeEntries(manifest.<key>, …)` call and
  // `manifest_key_alias` for the `a || b` fallback), so the citation carried
  // in the graph is the loader's real file:line on this branch rather than a
  // number transcribed into a comment.
  const validatedManifestKeys=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='manifest_key_validation')){
    if(!validatedManifestKeys.has(fact.manifest_key))validatedManifestKeys.set(fact.manifest_key,{validator:fact.validator,at:classifiedProvenance(fact)});
  }
  const manifestKeyAliases=facts.filter(fact=>fact.kind==='manifest_key_alias')
    .map(fact=>({preferred_key:fact.preferred_key,fallback_key:fact.fallback_key,at:classifiedProvenance(fact)}))
    .sort((a,b)=>`${a.preferred_key}\0${a.fallback_key}\0${a.at.repo}\0${a.at.file}`.localeCompare(`${b.preferred_key}\0${b.fallback_key}\0${b.at.repo}\0${b.at.file}`));

  const envelopeFacts=facts.filter(fact=>fact.kind==='envelope_flow');
  const envelopeKindIds=new Map();
  const envelopeKindNode=name=>{
    const existing=envelopeKindIds.get(name);
    if(existing)return existing;
    const id=`envelope_kind:${slug(name)}`;
    envelopeKindIds.set(name,id);
    return id;
  };
  // The site a flow fact attaches to: the module node for that exact file when
  // one exists (the JS/TS producers + consumers), otherwise the component
  // node (plugin manifests are YAML, which yields no module fact).
  const envelopeSiteId=fact=>modulesByPath.get(`${fact.repo}:${fact.file}`)?.id||repos.get(fact.repo);
  const literalEnvelopeFacts=envelopeFacts.filter(fact=>fact.status!=='wildcard');
  // WITNESS PROVENANCE (instrument defect I3, acceptance-test-report §5).
  //
  // `addNode` keeps the FIRST witness it is handed, and readFacts sorts facts
  // by `(kind, repo, file, line)` — so `client/e2e/…` beat `src/app.mjs` and
  // the map's answer for `session.spawned` was a Playwright spec while the
  // real emitter went unmentioned. Envelope-kind nodes therefore build their
  // witness list HERE: every site is kept and CLASSIFIED, and the list is
  // ordered production-first so the node summary leads with a real producer.
  // Nothing is dropped — a kind declared only in a test is a finding the map
  // must still be able to state, which is why this classifies where
  // entity-layer.mjs#isTestFact excludes.
  const envelopeWitnesses=new Map();
  for(const fact of literalEnvelopeFacts){
    const list=envelopeWitnesses.get(fact.envelope_kind)||[];
    list.push(classifiedProvenance(fact));
    envelopeWitnesses.set(fact.envelope_kind,list);
  }
  for(const [kind,list] of [...envelopeWitnesses].sort((a,b)=>a[0].localeCompare(b[0]))){
    const seen=new Set();
    const witnesses=list.sort(compareWitnessProvenance).filter(item=>{
      const key=`${item.repo}\0${item.file}\0${item.line}`;
      if(seen.has(key))return false;seen.add(key);return true;
    });
    const counts=provenanceClassCounts(witnesses);
    const id=addNode(envelopeKindNode(kind),'envelope_kind',kind,witnesses[0].repo,null,{});
    const node=nodes.get(id);
    node.witnesses=witnesses;
    node.witness_class_counts=counts;
    node.primary_witness_class=witnesses[0].provenance_class;
  }
  const envelopeKindNames=[...envelopeKindIds.keys()].sort();
  const wildcardMatches=pattern=>{
    const prefix=`${pattern.slice(0,-1)}`; // 'brew.*' -> 'brew.'
    return envelopeKindNames.filter(name=>name.startsWith(prefix));
  };
  for(const fact of envelopeFacts){
    const from=envelopeSiteId(fact);
    if(!from){unresolved.push({...fact,status:'unresolved',association_kind:fact.direction==='emit'?'emits':'consumes'});continue;}
    const edgeKind=fact.direction==='emit'?'emits':'consumes';
    // A wildcard subscription really does receive every kind under the
    // prefix, so it fans out to each kind discovered elsewhere. Nothing is
    // invented: with no matching kind the record stays unresolved.
    const targets=fact.status==='wildcard'?wildcardMatches(fact.envelope_kind):[fact.envelope_kind];
    const resolved=targets.filter(name=>envelopeKindIds.has(name));
    if(!resolved.length){addUnmatched(edgeKind,fact);continue;}
    for(const name of resolved){
      edges.push({
        id:`${edgeKind}:${from}:${slug(name)}:${slug(fact.file)}:${fact.line}`,
        kind:edgeKind,
        from,
        to:envelopeKindIds.get(name),
        status:'resolved',
        idiom:fact.idiom,
        // The class of the SITE this edge was read from, so an edge-level
        // query ("which components really consume this kind?") can separate
        // production traffic from test scaffolding without re-deriving paths.
        provenance_class:classifyProvenance(fact.repo,fact.file),
        ...(fact.manifest_key?{manifest_key:fact.manifest_key,manifest_key_validated:validatedManifestKeys.has(fact.manifest_key),manifest_key_validation:validatedManifestKeys.get(fact.manifest_key)||null}:{}),
        ...(fact.status==='wildcard'?{match_pattern:fact.envelope_kind,resolution_kind:'wildcard_subscription'}:{}),
        ...(fact.subscriber_id?{subscriber_id:fact.subscriber_id}:{}),
        witnesses:[provenance(fact)],
      });
    }
  }
  // Orphan classification, stamped on the kind node so the map has somewhere
  // to show it: a kind every producer emits and nobody reads, or one a
  // consumer waits on that no producer in the estate ever sends.
  for(const[name,id]of envelopeKindIds){
    const node=nodes.get(id);
    if(!node)continue;
    const emitters=edges.filter(edge=>edge.kind==='emits'&&edge.to===id);
    const consumers=edges.filter(edge=>edge.kind==='consumes'&&edge.to===id);
    node.emit_site_count=emitters.length;
    node.consume_site_count=consumers.length;
    node.declared_publisher=emitters.some(edge=>edge.idiom==='manifest_publishes');
    // Both manifest subscription idioms count as a DECLARED subscription: the
    // loader honours either key. Which key was written stays visible on the
    // edge (`manifest_key`) and in graph.manifest_subscription_keys.
    node.declared_subscriber=consumers.some(edge=>String(edge.idiom||'').startsWith('manifest_subscribes'));
    if(!consumers.length)node.orphan=FIRST_CLASS_DIAGNOSTIC_STATES.find(state=>state.id==='envelope.emitted_never_consumed').value;
    else if(!emitters.length)node.orphan=FIRST_CLASS_DIAGNOSTIC_STATES.find(state=>state.id==='envelope.consumed_never_emitted').value;
    if(!emitters.length&&!consumers.length)node.orphan=FIRST_CLASS_DIAGNOSTIC_STATES.find(state=>state.id==='envelope.isolated').value;
    void name;
  }

  // CAPABILITY CONTRACTS AND CALLS (capability_flow facts -> first-class
  // `capability` nodes).
  //
  // Instrument defect J1 (acceptance-test-round2.md §5.1): the round-2 map arm
  // self-reported that it "could not answer" the RFC's central mechanism claim
  // because "the generated graph has no capability-call node/edge or signature
  // layer". Envelope kinds and HTTP routes were already nodes; the OTHER
  // inter-plugin coupling mechanism this estate really uses was absent.
  //
  // The capability TYPE is the node, for the same four reasons the envelope
  // kind is (see above): a required-never-provided or provided-never-called
  // capability is exactly the defect worth surfacing and an orphan has no
  // second endpoint; fan-in is node degree; and it matches the vocabulary where
  // `reads_config` already points AT the declared resource.
  //
  // WITNESS PROVENANCE, production-first, exactly as envelope kinds do it: the
  // estate's `test_echo` and `episodic_memory` capabilities are also registered
  // by test fixtures, and a node whose leading witness was a fixture would
  // repeat instrument defect I3 in a new layer.
  const capabilityFacts=facts.filter(fact=>fact.kind==='capability_flow');
  const capabilityIds=new Map();
  const capabilityWitnesses=new Map();
  for(const fact of capabilityFacts){
    const list=capabilityWitnesses.get(fact.capability_type)||[];
    list.push(classifiedProvenance(fact));
    capabilityWitnesses.set(fact.capability_type,list);
  }
  for(const [type,list] of [...capabilityWitnesses].sort((a,b)=>a[0].localeCompare(b[0]))){
    const seen=new Set();
    const witnesses=list.sort(compareWitnessProvenance).filter(item=>{
      const key=`${item.repo}\0${item.file}\0${item.line}`;
      if(seen.has(key))return false;seen.add(key);return true;
    });
    const id=addNode(`capability:${slug(type)}`,'capability',type,witnesses[0].repo,null,{});
    capabilityIds.set(type,id);
    const node=nodes.get(id);
    node.witnesses=witnesses;
    node.witness_class_counts=provenanceClassCounts(witnesses);
    node.primary_witness_class=witnesses[0].provenance_class;
  }
  const CAPABILITY_EDGE_KIND={provide:'provides_capability',require:'requires_capability',call:'calls_capability'};
  const capabilitySiteId=fact=>modulesByPath.get(`${fact.repo}:${fact.file}`)?.id||repos.get(fact.repo);
  for(const fact of capabilityFacts){
    const from=capabilitySiteId(fact);
    const edgeKind=CAPABILITY_EDGE_KIND[fact.direction];
    if(!from||!edgeKind){unresolved.push({...fact,status:'unresolved',association_kind:edgeKind||'capability_flow'});continue;}
    edges.push({
      id:`${edgeKind}:${from}:${slug(fact.capability_type)}:${slug(fact.file)}:${fact.line}`,
      kind:edgeKind,from,to:capabilityIds.get(fact.capability_type),status:'resolved',
      idiom:fact.idiom,source:fact.source,
      provenance_class:classifyProvenance(fact.repo,fact.file),
      ...(fact.owner?{owner:fact.owner}:{}),
      ...(fact.version?{declared_version:fact.version}:{}),
      ...(fact.optional!==undefined?{optional:fact.optional}:{}),
      // N1's mechanism carried on the edge that binds the handle: a `require`
      // wrapped in `try { … } catch { … null }` makes an ABSENT provider
      // indistinguishable from an empty answer.
      ...(fact.binding?{binding:fact.binding}:{}),
      ...(fact.receiver?{receiver:fact.receiver,bound_at_line:fact.bound_at_line}:{}),
      witnesses:[provenance(fact)],
    });
  }
  // A registration/invocation site the extractor could not ground (non-literal
  // capability type, an unbound `.request(` receiver, no derivable owning
  // plugin) is a REFUSAL carried as data. It mints no node, so it cannot move
  // any diagnostic queue — the route-refusal contract, one layer over.
  const capabilityRefusals=facts.filter(fact=>fact.kind==='capability_refusal').map(fact=>({
    id:`capability_refusal:${slug(fact.repo)}:${slug(fact.file)}:${fact.line}`,
    direction:fact.direction,reason:fact.reason,reason_detail:fact.reason_detail,examined:fact.examined,
    witnesses:[classifiedProvenance(fact)],
  })).sort((a,b)=>a.id.localeCompare(b.id));
  for(const [type,id] of capabilityIds){
    const node=nodes.get(id);
    if(!node)continue;
    const of=(kind,predicate=()=>true)=>edges.filter(edge=>edge.kind===kind&&edge.to===id&&predicate(edge));
    const providers=of('provides_capability',edge=>edge.source==='code');
    const requirers=of('requires_capability',edge=>edge.source==='code');
    const callers=of('calls_capability');
    node.provide_site_count=providers.length;
    node.require_site_count=requirers.length;
    node.call_site_count=callers.length;
    // The PROVIDER is the plugin whose code registers the handler —
    // src/substrate/capabilityRegistry.mjs:37 stores exactly that `pluginName`.
    // Two plugins registering the same type is a real conflict the registry
    // throws on at load; the node records both rather than picking one.
    node.providers=[...new Set(providers.map(edge=>edge.owner).filter(Boolean))].sort();
    node.declared_providers=[...new Set(of('provides_capability',edge=>edge.source==='manifest').map(edge=>edge.owner).filter(Boolean))].sort();
    node.consumers=[...new Set(requirers.map(edge=>edge.owner).filter(Boolean))].sort();
    node.optional_for=[...new Set(of('requires_capability',edge=>edge.source==='manifest'&&edge.optional).map(edge=>edge.owner).filter(Boolean))].sort();
    if(!providers.length)node.orphan='required_never_provided';
    else if(!requirers.length&&!callers.length)node.orphan='provided_never_required';
    else if(!callers.length)node.orphan='required_never_called';
    void type;
  }

  // ---------------------------------------------------------------------------
  // ORPHAN-CLOSURE EDGES.
  //
  // Measured on this estate at 1789aaf6: 259 of 2,289 nodes had degree 0 —
  // `module` 141, `package` 79, `coverage` 26, `config_key` 11, `sql_object` 2.
  // Four of those five classes were isolated BY CONSTRUCTION, not by a hard
  // resolution problem: the merge minted the node from a fact and then never
  // emitted the edge the SAME fact already witnesses.
  //
  //   * `package`     — `consumes_package` points repo -> PRODUCER REPO (or an
  //                     `external_internal_package` stub). The `package:` node
  //                     itself was never an endpoint of anything, so all 79
  //                     were orphans by construction.
  //   * `coverage`    — minted, never linked to the component it measured.
  //   * `sql_object`  — minted, never linked to the component that declares it.
  //   * `config_key`  — only ever reached by a CROSS-REPO `reads_config` match,
  //                     so a key nothing in another component reads is isolated
  //                     even though its own declaration site is witnessed.
  //
  // Every edge below is derived from a fact the extractor ALREADY emitted and
  // carries that fact's `file:line` witness. Nothing is inferred: where the
  // facts genuinely cannot support an edge (per-module coverage attribution,
  // a bare specifier naming no declared dependency) a refusal record is
  // emitted instead, naming what was examined — an orphan with a stated reason
  // beats an orphan.
  const orphanRefusals=[];
  const addOrphanRefusal=(record)=>{orphanRefusals.push(record);};

  // A dependency NAME as written in a manifest and the same dependency as
  // written in an import specifier differ only by case and separator on every
  // ecosystem this tool reads (`d3-drag` / `d3_drag`, `AWSSDK.Core` /
  // `awssdk.core`). Both sides are folded through ONE normalizer so the match
  // is exact-after-normalization, never a fuzzy or prefix match.
  const depMatchKey=value=>String(value||'').trim().toLowerCase().replace(/\\/g,'/').replace(/[_.]/g,'-');
  const depFacts=facts.filter(fact=>fact.kind==='dep');
  const packageDeclarationsByKey=new Map();
  for(const fact of depFacts){
    const key=depMatchKey(fact.dep_name);
    if(!key)continue;
    const list=packageDeclarationsByKey.get(key)||[];list.push(fact);packageDeclarationsByKey.set(key,list);
  }
  // repo -> package: the manifest entry IS the declaration, witnessed at the
  // manifest line the dependencies extractor already recorded.
  for(const fact of depFacts){
    const packageId=`package:${slug(fact.dep_name)}`,repoId=repos.get(fact.repo);
    if(!nodes.has(packageId)||!repoId)continue;
    edges.push({id:`declares_dependency:${repoId}:${slug(fact.dep_name)}:${slug(fact.file)}:${fact.line}`,kind:'declares_dependency',from:repoId,to:packageId,status:'resolved',
      dep_kind:fact.dep_kind,version_range:fact.version_range??null,provenance_class:classifyProvenance(fact.repo,fact.file),witnesses:[provenance(fact)]});
  }
  // module -> package: the BARE import specifier the JS/TS/Python resolvers
  // deliberately skip ("consumes_package already covers package-level
  // association" — it does not; it covers REPO-level association) resolved
  // against the declared dependency set. Only ecosystems whose specifier root
  // maps to a manifest name WITHOUT guessing participate: JS/TS (`@scope/name`
  // or the first path segment) and Python (the first dotted segment). C#
  // `using` namespaces and Kotlin FQNs are NOT mapped — a namespace is not a
  // package id on those ecosystems and deriving one would be a guess, so they
  // are refused by reason code instead.
  const JS_MODULE_EXTENSIONS=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs']);
  const bareSpecifierPackageRoot=(file,specifier)=>{
    const extension=path.posix.extname(String(file)).toLowerCase(),value=String(specifier);
    if(JS_MODULE_EXTENSIONS.has(extension)){
      if(value.startsWith('node:'))return {root:null,reason:'node_builtin_specifier'};
      const segments=value.split('/').filter(Boolean);
      if(!segments.length)return {root:null,reason:'empty_specifier'};
      if(value.startsWith('@'))return segments.length>1?{root:`${segments[0]}/${segments[1]}`,reason:null}:{root:null,reason:'scope_without_package_name'};
      return {root:segments[0],reason:null};
    }
    if(extension==='.py'){const root=value.split('.')[0];return root?{root,reason:null}:{root:null,reason:'empty_specifier'};}
    return {root:null,reason:`no_package_root_rule_for_extension:${extension||'(none)'}`};
  };
  const dependsOnRefusalReasons=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='import'&&typeof fact.specifier==='string'&&!fact.specifier.startsWith('.'))){
    const fromModule=modulesByPath.get(`${fact.repo}:${fact.file}`);
    if(!fromModule)continue;
    const {root,reason}=bareSpecifierPackageRoot(fact.file,fact.specifier);
    if(!root){dependsOnRefusalReasons.set(reason,(dependsOnRefusalReasons.get(reason)||0)+1);continue;}
    const declarations=packageDeclarationsByKey.get(depMatchKey(root));
    if(!declarations?.length){dependsOnRefusalReasons.set('specifier_root_matches_no_declared_dependency',(dependsOnRefusalReasons.get('specifier_root_matches_no_declared_dependency')||0)+1);continue;}
    const packageIds=[...new Set(declarations.map(declaration=>`package:${slug(declaration.dep_name)}`))].filter(id=>nodes.has(id)).sort();
    if(!packageIds.length)continue;
    const edge={id:`depends_on:${fromModule.id}:${slug(root)}:${slug(fact.file)}:${fact.line}`,kind:'depends_on',from:fromModule.id,
      to:packageIds.length===1?packageIds[0]:null,status:packageIds.length===1?'resolved':'ambiguous',
      specifier:fact.specifier,package_root:root,import_kind:fact.import_kind||null,
      provenance_class:classifyProvenance(fact.repo,fact.file),
      witnesses:[provenance(fact),...declarations.slice(0,2).map(provenance)]};
    if(packageIds.length===1)edges.push(edge);else{edge.candidates=packageIds;addAmbiguous(edge,null);}
  }
  for(const [reason,count] of [...dependsOnRefusalReasons].sort((a,b)=>a[0].localeCompare(b[0])))
    addOrphanRefusal({id:`orphan_refusal:depends_on:${reason}`,subject:null,subject_kind:'import',reason:'bare_specifier_not_mapped_to_declared_package',reason_detail:reason,
      examined:[`${count} bare import specifier(s)`],sites:count,witnesses:[]});

  // coverage -> repo. The coverage fact's SUBJECT is the component it scanned;
  // that is the edge the fact supports and the only one it supports.
  for(const fact of facts.filter(fact=>fact.kind==='coverage')){
    const coverageId=`coverage:${slug(fact.repo)}`,repoId=repos.get(fact.repo);
    if(!nodes.has(coverageId)||!repoId)continue;
    edges.push({id:`covers:${coverageId}:${repoId}`,kind:'covers',from:coverageId,to:repoId,status:'resolved',
      files_scanned:fact.files_scanned,files_skipped:fact.files_skipped,parse_error_count:(fact.parse_errors||[]).length,witnesses:[provenance(fact)]});
    // The brief's premise — "a `covers` edge should be derivable from the
    // coverage artifact's own file paths" — does not hold against the real
    // fact: `coverage` carries files_scanned / files_skipped COUNTS and a
    // parse-error list, never the scanned path list. A per-module `covers`
    // edge would require re-walking the estate, which merge must never do.
    addOrphanRefusal({id:`orphan_refusal:coverage_per_module:${coverageId}`,subject:coverageId,subject_kind:'coverage',
      reason:'coverage_fact_carries_no_per_file_paths',
      reason_detail:'the coverage fact records files_scanned/files_skipped counts and parse_errors[], not the scanned path list, so a per-module covers edge is not derivable from facts alone',
      examined:['fact.files_scanned','fact.files_skipped','fact.parse_errors[].file'],sites:1,witnesses:[provenance(fact)]});
  }

  // repo -> sql_object. Same shape: the declaration site is the witness.
  for(const fact of facts.filter(fact=>fact.kind==='sql_object')){
    const objectId=`sql:${slug(fact.repo)}:${slug(fact.object)}`,repoId=repos.get(fact.repo);
    if(!nodes.has(objectId)||!repoId)continue;
    edges.push({id:`declares_sql_object:${repoId}:${slug(fact.object)}:${slug(fact.file)}:${fact.line}`,kind:'declares_sql_object',from:repoId,to:objectId,status:'resolved',
      object_kind:fact.object_kind,provenance_class:classifyProvenance(fact.repo,fact.file),witnesses:[provenance(fact)]});
  }

  // repo -> config_key. `reads_config` is CROSS-REPO by design (a component
  // reading its own declaration is not an estate relationship), which left
  // every declared key with no external reader isolated. The declaration edge
  // is a different claim and is always available.
  for(const fact of facts.filter(fact=>fact.kind==='config_key'&&fact.role==='declared')){
    const modulePrefix=normalizeModulePath(fact.module_path)==='.'?'':`${modulePathIdPart(fact.module_path)}:`;
    const configId=`config:${slug(fact.repo)}:${modulePrefix}${slug(fact.key_name)}`,repoId=repos.get(fact.repo);
    if(!nodes.has(configId)||!repoId)continue;
    edges.push({id:`declares_config:${repoId}:${slug(fact.key_name)}:${slug(fact.file)}:${fact.line}`,kind:'declares_config',from:repoId,to:configId,status:'resolved',
      module_path:normalizeModulePath(fact.module_path),provenance_class:classifyProvenance(fact.repo,fact.file),witnesses:[provenance(fact)]});
  }

  // MODULE ORPHAN SPLIT. A module with degree 0 after every resolver has run
  // is FOUR very different things and the map must not blur them. The first
  // measured taxonomy — "has imports" vs "has none" — was WRONG, and its own
  // output said so: 68 of 89 landed in `unresolved_imports_only` and reading
  // the recorded specifiers showed most were `node:readline` / `node:fs`
  // only. That is not a resolver defect; nothing in the estate can ever be on
  // the other end of `node:fs`. The reason codes below separate a real work
  // list from three kinds of correct absence:
  //
  //   * `only_platform_builtin_imports` — every specifier is a Node built-in
  //     or a Python stdlib module. No in-estate node exists BY DESIGN.
  //   * `only_undeclared_external_imports` — every specifier is a bare package
  //     name no scanned manifest declares. On a single-repository estate the
  //     dominant cause is structural: `extract.mjs` treats each immediate
  //     child of the estate root as a component, so the ROOT's own
  //     `package.json` belongs to no component and is never scanned — which
  //     is why `@mariozechner/pi-coding-agent` resolves to nothing here.
  //   * `unresolved_relative_imports` — a relative specifier failed. THIS is
  //     the resolver work list, and the record names the failing specifiers.
  //   * `genuinely_unreferenced_module` — no import fact at all and nothing
  //     in-estate imports it. A real FINDING (dead file, leaf config,
  //     standalone script), not an instrument failure.
  //
  // Degree uses the SAME rule analyze-connectivity.mjs uses — only an edge
  // with a resolved `to` endpoint connects anything — so the census and the
  // headline isolated-node count can never disagree.
  const moduleDegree=new Map();
  for(const edge of edges){
    if(edge.from==null||edge.to==null)continue;
    moduleDegree.set(edge.from,(moduleDegree.get(edge.from)||0)+1);
    moduleDegree.set(edge.to,(moduleDegree.get(edge.to)||0)+1);
  }
  const importFactsByModule=new Map();
  for(const fact of facts.filter(fact=>fact.kind==='import')){
    const key=`${fact.repo}\0${fact.file}`;const list=importFactsByModule.get(key)||[];list.push(fact);importFactsByModule.set(key,list);
  }
  const isPlatformBuiltinSpecifier=(file,specifier)=>{
    const value=String(specifier||'');
    if(path.posix.extname(String(file)).toLowerCase()==='.py')return PYTHON_STDLIB_MODULES.has(value.split('.')[0]);
    return isNodeBuiltinSpecifier(value);
  };
  const isolatedModules=[...nodes.values()].filter(node=>node.kind==='module'&&!moduleDegree.get(node.id)).sort((a,b)=>a.id.localeCompare(b.id));
  for(const node of isolatedModules){
    const importFacts=importFactsByModule.get(`${node.repo}\0${node.name}`)||[];
    const specifiers=[...new Set(importFacts.map(fact=>typeof fact.specifier==='string'?fact.specifier:fact.module).filter(Boolean))].sort();
    const relativeSpecifiers=specifiers.filter(value=>value.startsWith('.'));
    const nonBuiltin=specifiers.filter(value=>!isPlatformBuiltinSpecifier(node.name,value));
    const reason=!specifiers.length?'genuinely_unreferenced_module'
      :relativeSpecifiers.length?'unresolved_relative_imports'
      :!nonBuiltin.length?'only_platform_builtin_imports'
      :'only_undeclared_external_imports';
    const detail={
      genuinely_unreferenced_module:'no import fact on this module and no in-estate module imports it',
      unresolved_relative_imports:`${relativeSpecifiers.length} relative specifier(s) on this module resolved to no scanned module`,
      only_platform_builtin_imports:`all ${specifiers.length} specifier(s) name a platform built-in (node: / python stdlib), which has no in-estate node by design`,
      only_undeclared_external_imports:`${nonBuiltin.length} bare specifier(s) name no scanned manifest's declared dependency; on a single-repository estate the root manifest is outside every component and is never scanned`,
    }[reason];
    addOrphanRefusal({
      id:`orphan_refusal:module:${node.id}`,subject:node.id,subject_kind:'module',reason,reason_detail:detail,
      examined:(reason==='unresolved_relative_imports'?relativeSpecifiers:reason==='only_undeclared_external_imports'?nonBuiltin:specifiers).slice(0,20),
      sites:importFacts.length,witnesses:(node.witnesses||[]).slice(0,1),
    });
  }
  orphanRefusals.sort((a,b)=>a.id.localeCompare(b.id));
  const orphan_closure_census={
    edges_by_kind:Object.fromEntries(['declares_dependency','depends_on','covers','declares_sql_object','declares_config'].map(kind=>[kind,edges.filter(edge=>edge.kind===kind).length])),
    refusals:orphanRefusals.length,
    refusals_by_reason:Object.fromEntries([...orphanRefusals.reduce((map,record)=>map.set(record.reason,(map.get(record.reason)||0)+1),new Map())].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))),
    isolated_modules:isolatedModules.length,
    isolated_modules_by_reason:Object.fromEntries([...orphanRefusals.filter(record=>record.subject_kind==='module').reduce((map,record)=>map.set(record.reason,(map.get(record.reason)||0)+1),new Map())].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))),
  };

  // MANIFEST DECLARATIONS vs WIRING REALITY (instrument defect K3). Derived
  // from the same fact stream by manifest-wiring.mjs; carries no new subject,
  // mints no node and cannot drain a queue.
  const manifest_wiring=deriveManifestWiring(facts);
  const manifest_wiring_census=manifestWiringCensus(manifest_wiring);

  // Census blocks: derived counts a reader can check without re-deriving the
  // graph. They carry no new subjects, mint no node and drain no queue.
  const envelopeKindNodes=[...nodes.values()].filter(node=>node.kind==='envelope_kind');
  const capabilityNodes=[...nodes.values()].filter(node=>node.kind==='capability');
  const routeNodes=[...nodes.values()].filter(node=>node.kind==='route');
  const countClasses=values=>Object.fromEntries(PROVENANCE_CLASSES.map(name=>[name,values.filter(value=>value===name).length]));
  const envelope_witness_census={
    kinds:envelopeKindNodes.length,
    witnesses_by_class:countClasses(envelopeKindNodes.flatMap(node=>(node.witnesses||[]).map(item=>item.provenance_class))),
    primary_witness_by_class:countClasses(envelopeKindNodes.map(node=>node.primary_witness_class)),
    kinds_without_production_witness:envelopeKindNodes.filter(node=>!(node.witness_class_counts?.production)).length,
  };
  const manifestKeySites=facts.filter(fact=>fact.kind==='envelope_flow'&&fact.manifest_key);
  const manifest_subscription_keys={
    accepted_alias_declarations:manifestKeyAliases,
    keys:[...new Set([...Object.keys(Object.fromEntries(manifestKeySites.map(fact=>[fact.manifest_key,1]))),...validatedManifestKeys.keys()])].sort().map(key=>({
      manifest_key:key,
      direction:manifestKeySites.find(fact=>fact.manifest_key===key)?.direction||null,
      declaration_sites:manifestKeySites.filter(fact=>fact.manifest_key===key).length,
      declaring_components:[...new Set(manifestKeySites.filter(fact=>fact.manifest_key===key).map(fact=>`${fact.repo}/${fact.file}`))].sort(),
      loader_validated:validatedManifestKeys.has(key),
      loader_validation:validatedManifestKeys.get(key)||null,
    })),
  };
  const route_census={
    routes:routeNodes.length,
    by_provenance_class:countClasses(routeNodes.map(node=>node.provenance_class)),
    by_framework:Object.fromEntries([...routeNodes.reduce((map,node)=>map.set(node.framework||'unspecified',(map.get(node.framework||'unspecified')||0)+1),new Map())].sort((a,b)=>a[0].localeCompare(b[0]))),
    with_auth_marker:routeNodes.filter(node=>node.auth).length,
    refusals:routeRefusals.length,
  };
  const capability_census={
    capabilities:capabilityNodes.length,
    by_provenance_class:countClasses(capabilityNodes.map(node=>node.primary_witness_class)),
    provided:capabilityNodes.filter(node=>node.providers.length).length,
    provided_by_more_than_one_plugin:capabilityNodes.filter(node=>node.providers.length>1).map(node=>node.name).sort(),
    with_call_sites:capabilityNodes.filter(node=>node.call_site_count).length,
    orphans:Object.fromEntries([...capabilityNodes.reduce((map,node)=>node.orphan?map.set(node.orphan,(map.get(node.orphan)||0)+1):map,new Map())].sort((a,b)=>a[0].localeCompare(b[0]))),
    refusals:capabilityRefusals.length,
    refusals_by_reason:Object.fromEntries([...capabilityRefusals.reduce((map,record)=>map.set(record.reason,(map.get(record.reason)||0)+1),new Map())].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))),
  };
  let graph={schema_version:1,fact_kind_inventory,nodes:[...nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)),edges:edges.sort((a,b)=>a.id.localeCompare(b.id)),unresolved:unresolved.sort((a,b)=>factKey(a).localeCompare(factKey(b))),route_refusals:routeRefusals,capability_refusals:capabilityRefusals,orphan_refusals:orphanRefusals,orphan_closure_census,manifest_wiring,envelope_witness_census,manifest_subscription_keys,route_census,capability_census,manifest_wiring_census};
  const conservationGates=runConservationGates({facts,graph,surfaces:SUPPORTED_DIAGNOSTIC_PROJECTIONS,scopeGaps:extractionScope.scopeGaps});
  if(!conservationGates.passed){
    const error=new Error(`Estate-map conservation gates failed: BUG=${conservationGates.census.bugs}, PROJECTION=${conservationGates.census.projection_gaps}`);
    error.exitCode=3;error.conservationGates=conservationGates;throw error;
  }
  // Presentation values are build-time graph data. Consumers select these records rather than
  // re-deriving labels/families while constructing a view.
  graph={...graph,conservation_gates:conservationGates,presentation_records:buildPresentationRecords(graph)};
  const canonical=stableStringify(graph);
  await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'estate-graph.json'),canonical);
  await fs.writeFile(path.join(out,'digest.txt'),sha256(canonical)+'\n');
  await writeJson(path.join(out,'ambiguity-ledger.json'),ambiguities.sort((a,b)=>a.edge_id.localeCompare(b.edge_id)));
  return graph;
}

if(import.meta.url===`file://${process.argv[1]}`){
  const {positional,options}=parseArgs(process.argv.slice(2));
  if(options.help||!positional[0]){console.log(HELP);process.exit(options.help?0:1);}
  const facts=path.resolve(positional[0]),out=path.resolve(options.out||path.dirname(facts));
  mergeFacts(facts,out,{allowPartial:Boolean(options['allow-partial'])}).then(graph=>console.log(`Wrote ${graph.nodes.length} nodes and ${graph.edges.length} edges to ${out}`)).catch(error=>{console.error(error.message);process.exit(error.exitCode||1);});
}
