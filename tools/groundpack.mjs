#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import extractors from './extractors/index.mjs';
import { discoverRepositories } from './extract.mjs';
import { normalizePath, parseArgs, readEstateMapIgnore, stableStringify, walk } from './lib.mjs';

const HELP=`Usage: node tools/estate-map/groundpack.mjs <estate-dir> <graph-dir> [--repo NAME] [--seams] [--out DIR]
Emit deterministic, secret-redacted grounding packs without executing estate code.`;
export const PACK_SIZE_CAP=16*1024;
const secretPattern=/(?:password|passwd|secret|api[_-]?key|token)["']?\s*[=:]\s*(?:["'][^"']+["']|[^\s,}]+)/i;
const entryNames=['Program.cs','Startup.cs','index.js','main.py'];
const compare=(a,b)=>String(a).localeCompare(String(b));
const cite=w=>`${w.repo}/${w.file}:${w.line}`;
const cleanLine=line=>secretPattern.test(line)?'[REDACTED-LINE]':line;
function truncateUtf8(text,maxBytes,marker='\n[TRUNCATED AT 16 KiB]'){
  if(Buffer.byteLength(text)<=maxBytes)return text;
  if(maxBytes<=Buffer.byteLength(marker))return marker.slice(0,maxBytes);
  const bytes=Buffer.from(text);let end=maxBytes-Buffer.byteLength(marker);
  while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8')+marker;
}
function capped(text){
  const marker='\n\n[TRUNCATED AT 16 KiB]\n';
  if(Buffer.byteLength(text)<=PACK_SIZE_CAP)return text;
  return truncateUtf8(text,PACK_SIZE_CAP,marker);
}
async function writePack(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,capped(text));}
function cappedSections(prefix,sections){
  const empty=[prefix,...sections.map(({title})=>`## ${title}\n`)].join('\n\n')+'\n';
  let remaining=PACK_SIZE_CAP-Buffer.byteLength(empty);
  if(remaining<0)throw new Error('Grounding pack section headings exceed size cap');
  const rendered=[];
  for(let index=0;index<sections.length;index++){
    const {title,body}=sections[index];
    const budget=Math.floor(remaining/(sections.length-index));
    const fitted=truncateUtf8(body,budget);
    rendered.push(`## ${title}\n${fitted}`);remaining-=Buffer.byteLength(fitted);
  }
  return [prefix,...rendered].join('\n\n')+'\n';
}
async function inspectRepo(root,repo,{ignorePrefixes,estateRelativeRoot}={}){
  // Groundpacks add source witnesses to the extracted graph. Share extract.mjs's
  // walk rather than maintaining a weaker, broader traversal whose reads would
  // escape the normalized estate digest bound by the canonical receipt.
  const {files}=await walk(root,{ignorePrefixes,estateRelativeRoot});
  const found=[],counts={},facts=[];const languages={'.cs':'csharp','.tf':'terraform','.js':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.tsx':'typescript','.py':'python','.sql':'sql'};
  for(const absolute of files){if(entryNames.includes(path.basename(absolute)))found.push(absolute);const language=languages[path.extname(absolute).toLowerCase()];if(language)counts[language]=(counts[language]||0)+1;}
  for(const absolute of files.sort(compare)){const file=normalizePath(path.relative(root,absolute)),matching=extractors.filter(extractor=>extractor.filePattern.test(file));if(!matching.length)continue;let lines;try{lines=(await fs.readFile(absolute,'utf8')).split(/\r?\n/).map(cleanLine);}catch{continue;}const ctx={repo,file,parseErrors:[],fact:(kind,line,data)=>({kind,repo,file,line,...data})};for(const extractor of matching)try{facts.push(...extractor.scan(lines,ctx));}catch{}}
  return {entry:found.sort(compare)[0],facts:facts.sort((a,b)=>compare(stableStringify(a),stableStringify(b))),langs:Object.entries(counts).sort((a,b)=>b[1]-a[1]||compare(a[0],b[0])).map(([name,count])=>({name,count}))};
}
function section(title,items,format){return {title,body:items.length?items.map(item=>`- ${format(item)}`).join('\n'):'- none'};}
function witnesses(item){return (item.witnesses||[]).map(cite).sort(compare).join(', ')||'no witness';}
function repoPack(graph,repo,source,detectedLangs=[],sourceFacts=[]){
  const repoNode=graph.nodes.find(node=>node.kind==='repo'&&node.repo===repo)||{};
  const coverage=graph.nodes.find(node=>node.kind==='coverage'&&node.repo===repo)||{};
  const nodes=graph.nodes.filter(node=>node.repo===repo);
  const ids=new Set(nodes.map(node=>node.id));
  const routes=sourceFacts.filter(fact=>fact.kind==='http_route');
  const tf=sourceFacts.filter(fact=>fact.kind==='tf_resource');
  const deps=sourceFacts.filter(fact=>fact.kind==='dep').sort((a,b)=>compare(a.dep_name,b.dep_name)).slice(0,25);
  const config=sourceFacts.filter(fact=>fact.kind==='config_key');
  const edges=graph.edges.filter(edge=>ids.has(edge.from)||ids.has(edge.to)||(edge.candidates||[]).some(id=>ids.has(id))).sort((a,b)=>compare(a.id,b.id));
  const aws=sourceFacts.filter(fact=>fact.kind==='aws_usage');
  const langs=(repoNode.primary_langs||detectedLangs).map(item=>`${item.name}:${item.count}`).join(', ')||'none detected';
  const prefix=[`# Grounding pack: ${repo}`,`- head_sha: ${repoNode.head_sha||'unknown'}`,`- languages: ${langs}`,`- coverage: scanned=${coverage.files_scanned??'unknown'} skipped=${coverage.files_skipped??'unknown'} parse_errors=${coverage.parse_errors?.length??'unknown'}`].join('\n');
  const sections=[section('Routes',routes.length?routes:nodes.filter(node=>node.kind==='route').sort((a,b)=>compare(a.id,b.id)),item=>item.kind==='http_route'?`${item.method} ${item.route} — ${item.repo}/${item.file}:${item.line}`:`${item.name} — ${witnesses(item)}`),section('Terraform resources',tf.length?tf:nodes.filter(node=>node.kind==='tf_resource').sort((a,b)=>compare(a.id,b.id)),item=>item.kind==='tf_resource'&&item.file?`${item.tf_type} ${item.address} — ${item.repo}/${item.file}:${item.line}`:`${item.tf_type||'resource'} ${item.name} — ${witnesses(item)}`),section('Dependencies (top 25)',deps.length?deps:nodes.filter(node=>['package','dep'].includes(node.kind)).sort((a,b)=>compare(a.name,b.name)).slice(0,25),item=>item.kind==='dep'?`${item.dep_name} ${item.version_range||''} — ${item.repo}/${item.file}:${item.line}`:`${item.name} — ${witnesses(item)}`),section('AWS usage',aws,fact=>`${fact.service||'aws'} ${fact.op||fact.kind} ${fact.target_name_or_expr||fact.target||''} — ${fact.repo}/${fact.file}:${fact.line}`),section('Config keys',config.length?config:nodes.filter(node=>node.kind==='config_key').sort((a,b)=>compare(a.id,b.id)),item=>item.kind==='config_key'&&item.file?`${item.key_name} (${item.role}) — ${item.repo}/${item.file}:${item.line}`:`${item.name} — ${witnesses(item)}`),section('Graph neighborhood',edges,edge=>`${edge.kind} ${edge.from} -> ${edge.to||(edge.candidates||[]).join(' | ')||'?'} (${edge.status}) — ${witnesses(edge)}`)];
  sections.push({title:'Entry point source',body:source?`\`${source.file}\`\n\n\`\`\`\n${source.lines.map(cleanLine).join('\n')}\n\`\`\``:'- none detected'});
  return cappedSections(prefix,sections);
}
function seamIdentity(fact){return stableStringify(fact);}
async function witnessContext(repoRoots,witness){
  const root=repoRoots.get(witness.repo);const file=root&&path.join(root,witness.file);let lines;try{lines=(await fs.readFile(file,'utf8')).split(/\r?\n/);}catch{return `### ${cite(witness)}\n[UNAVAILABLE]`;}
  const start=Math.max(1,witness.line-15),end=Math.min(lines.length,witness.line+15);
  return `### ${cite(witness)} (lines ${start}-${end})\n\n\`\`\`\n${lines.slice(start-1,end).map((line,index)=>`${String(start+index).padStart(5)} | ${cleanLine(line)}`).join('\n')}\n\`\`\``;
}
export async function generateGroundpacks(estateDir,graphDir,{repo,seams=false,out=path.join(graphDir,'packs')}={}){
  const graph=JSON.parse(await fs.readFile(path.join(graphDir,'estate-graph.json'),'utf8'));
  const repos=[...new Set(graph.nodes.filter(node=>node.kind==='repo').map(node=>node.repo))].filter(name=>!repo||name===repo).sort(compare);
  if(!repos.length)throw new Error(`No repositories found${repo?` matching ${repo}`:''}`);
  const ignorePrefixes=await readEstateMapIgnore(estateDir);
  const discovered=await discoverRepositories(estateDir,{ignorePrefixes});
  const repoRoots=new Map(discovered.repos.map(item=>[item.name,item.path]));
  const repoRootRelative=new Map(discovered.repos.map(item=>[item.name,normalizePath(path.relative(estateDir,item.path))||'.']));
  for(const name of repos)if(!repoRoots.has(name)){repoRoots.set(name,path.join(estateDir,name));repoRootRelative.set(name,name);}
  const files=[];
  for(const name of repos){const root=repoRoots.get(name);const inspected=await inspectRepo(root,name,{ignorePrefixes,estateRelativeRoot:repoRootRelative.get(name)});let source=null;if(inspected.entry){source={file:normalizePath(path.relative(root,inspected.entry)),lines:(await fs.readFile(inspected.entry,'utf8')).split(/\r?\n/).slice(0,40)};}const file=path.join(out,`${name}.md`);await writePack(file,repoPack(graph,name,source,inspected.langs,inspected.facts));files.push(file);}
  if(seams){
    let ledger=[];try{ledger=JSON.parse(await fs.readFile(path.join(graphDir,'ambiguity-ledger.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const facts=[...ledger,...(graph.unresolved||[])];const unique=[...new Map(facts.map(fact=>[seamIdentity(fact),fact])).values()].sort((a,b)=>compare(seamIdentity(a),seamIdentity(b)));
    let index=0;for(const fact of unique){const ws=(fact.witnesses?.length?fact.witnesses:[fact]).filter(w=>w.repo&&w.file&&Number.isInteger(w.line)).sort((a,b)=>compare(cite(a),cite(b)));const owner=fact.repo||ws[0]?.repo||'estate';if(repo&&owner!==repo&&!ws.some(w=>w.repo===repo))continue;index++;const contexts=[];for(const witness of ws)contexts.push(await witnessContext(repoRoots,witness));const text=`# Seam ${index}: ${fact.kind||'ambiguous fact'}\n\n## Fact\n\n\`\`\`json\n${stableStringify(fact).trim()}\n\`\`\`\n\n## Witness context\n\n${contexts.join('\n\n')||'- no source witness available'}\n`;const file=path.join(out,'seams',`${String(index).padStart(3,'0')}-${owner.replace(/[^A-Za-z0-9._-]/g,'-')}.md`);await writePack(file,text);files.push(file);}
  }
  return files;
}
if(import.meta.url===`file://${process.argv[1]}`){const {positional,options}=parseArgs(process.argv.slice(2));if(options.help||positional.length<2){console.log(HELP);process.exit(options.help?0:1);}try{const files=await generateGroundpacks(path.resolve(positional[0]),path.resolve(positional[1]),{repo:options.repo,seams:Boolean(options.seams),out:path.resolve(options.out||path.join(positional[1],'packs'))});console.log(`Wrote ${files.length} grounding pack(s)`);}catch(error){console.error(error.message);process.exit(1);}}
