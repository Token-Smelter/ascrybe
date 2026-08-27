#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import { classifyDocument } from './document-mode.mjs';
import { defaultOutputRoot, registerScanRoot } from './readonly-guard.mjs';
import path from 'node:path';
import extractors, { extractorAvailabilityReceipt, extractorExclusionReceipts, textExtensionRegistrationReceipt } from './extractors/index.mjs';
import { classifyExcludedDirName, describeScopeExclusions, factKey, isIgnoredPath, linkedWorktreeGitdir, normalizePath, parseArgs, readEstateMapIgnore, sha256, stableStringify, walk, writeJson, writeJsonArray, writeJsonLines } from './lib.mjs';

const HELP=`Usage: node tools/estate-map/extract.mjs <estate-dir> [--repo <name>] [--out <dir>] [--no-default-scope-exclusions] [--print-scope-exclusions]
Read immediate-child directory components and emit deterministic JSONL facts. No source code is executed.

  --no-default-scope-exclusions  Disable the default-on scan-scope exclusion set
                                 (vendored dependencies, build artifacts, duplicate
                                 worktrees) and reproduce the prior scan behaviour.
  --print-scope-exclusions       Print the ACTIVE exclusion set as JSON and exit.`;
const secretPattern=/(?:password|passwd|secret|api[_-]?key|token)["']?\s*[=:]\s*(?:["'][^"']+["']|[^\s,}]+)/i;
const SAMPLE_CAP=100;
const compare=(a,b)=>a.localeCompare(b);

async function repositoryTarget(repoPath,visited){
  const stat=await fs.stat(repoPath);if(!stat.isDirectory())throw new Error('not a directory');
  const real=await fs.realpath(repoPath);if(visited.has(real))throw new Error('duplicate or cyclic repository target');
  visited.add(real);return real;
}

// Component discovery is filesystem-only: it never inspects `.git`, never
// requires a Git repository, and never shells out to `git`. An estate's
// CLONE_MANIFEST.md (an ordinary Markdown table, not Git metadata) takes
// priority when present and has usable rows; otherwise every immediate-child
// directory or symlink of the estate root becomes a component, preserving
// top-level directory hierarchy as the unit of aggregation rather than
// claiming any Git repository boundary. This is what keeps nested source
// (e.g. a container directory with no `.git` of its own, holding one or more
// real projects beneath it) from disappearing: each container becomes one
// component and its full subtree is scanned by walk(), arbitrarily deep.
// The only Git-derived signal consulted here is negative-only: a top-level
// candidate that is itself a linked-worktree checkout (see
// lib.mjs#linkedWorktreeGitdir) is excluded, never selected as a component.
export async function discoverRepositories(estate,{ignorePrefixes,defaultScopeExclusions=true}={}) {
  // A top-level component CANDIDATE is classified by the SAME scope-exclusion
  // set walk() applies to nested directories, so `worktrees/` or a `.venv-x/`
  // sitting directly under the estate root is excluded at the same grain.
  const excludedComponent=name=>classifyExcludedDirName(name,{defaultScopeExclusions});
  const manifest=path.join(estate,'CLONE_MANIFEST.md'),diagnostics=[],visited=new Set();
  const prefixes=ignorePrefixes||await readEstateMapIgnore(estate);
  try {
    const text=await fs.readFile(manifest,'utf8');
    const rows=text.split(/\r?\n/).filter(line=>line.trimStart().startsWith('|')).map(line=>line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.trim()));
    const headerIndex=rows.findIndex(row=>row.some(cell=>cell.toLowerCase()==='local directory'));
    if(headerIndex>=0){
      const header=rows[headerIndex].map(cell=>cell.toLowerCase()),localIndex=header.indexOf('local directory'),repoIndex=header.indexOf('repository'),statusIndex=header.indexOf('status'),repos=[],selections=[];let selectedRows=0;
      for(const row of rows.slice(headerIndex+1)){
        if(row.every(cell=>/^:?-{3,}:?$/.test(cell))||row.length<=Math.max(localIndex,repoIndex))continue;
        const localName=path.basename(row[localIndex]||row[repoIndex]||''),name=row[repoIndex]||localName;if(!localName||!name)continue;
        const repoPath=path.join(estate,localName),manifestStatus=statusIndex>=0?row[statusIndex]?.toLowerCase():'';
        if(/^(?:failed|unavailable|skipped)$/.test(manifestStatus)){const status=manifestStatus==='skipped'?'skipped':'failed',error=`manifest status: ${manifestStatus}`;selections.push({name,path:repoPath,status,error});diagnostics.push({repo:name,path:repoPath,diagnostic:status==='skipped'?'repository skipped':'repository unavailable',error});continue;}
        selectedRows++;
        const manifestExclusion=excludedComponent(localName);
        if(manifestExclusion){const error=`excluded directory name (scan scope: ${manifestExclusion.category})`;selections.push({name,path:repoPath,status:'skipped',error});diagnostics.push({repo:name,path:repoPath,diagnostic:'repository skipped',error,scope_exclusion:manifestExclusion});continue;}
        if(isIgnoredPath(localName,prefixes)){selections.push({name,path:repoPath,status:'skipped',error:'excluded by .estate-mapignore'});diagnostics.push({repo:name,path:repoPath,diagnostic:'repository skipped',error:'excluded by .estate-mapignore'});continue;}
        try{await repositoryTarget(repoPath,visited);if(await linkedWorktreeGitdir(repoPath))throw new Error('linked worktree checkout');repos.push({name,path:repoPath});selections.push({name,path:repoPath,status:'ready'});}catch(error){const duplicate=/duplicate or cyclic|linked worktree/.test(error.message),status=duplicate?'skipped':'failed';selections.push({name,path:repoPath,status,error:error.message});diagnostics.push({repo:name,path:repoPath,diagnostic:duplicate?'repository skipped':'repository unavailable',error:error.message});}
      }
      if(selectedRows)return {repos:repos.sort((a,b)=>compare(a.name,b.name)),diagnostics,selections};
    }
  }catch(error){if(error.code!=='ENOENT')diagnostics.push({path:manifest,diagnostic:'manifest unreadable',error:error.message});}
  const entries=(await fs.readdir(estate,{withFileTypes:true})).sort((a,b)=>compare(a.name,b.name)),repos=[];
  for(const entry of entries){
    const repoPath=path.join(estate,entry.name);if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
    // Same VCS-metadata/dependency/build/cache/generated exclusion applied
    // inside walk() also applies to a top-level component CANDIDATE, not
    // just to directories nested within one: an estate root that is itself
    // a Git working tree has its own `.git` as an immediate child, and an
    // estate re-scanned after a prior run carries its own `.estate-map`
    // output as one -- neither is ever source, so neither is ever a
    // component, at any position.
    const exclusion=excludedComponent(entry.name);
    if(exclusion){diagnostics.push({repo:entry.name,path:repoPath,diagnostic:'repository skipped',error:`excluded directory name (scan scope: ${exclusion.category})`,scope_exclusion:exclusion});continue;}
    if(isIgnoredPath(entry.name,prefixes)){diagnostics.push({repo:entry.name,path:repoPath,diagnostic:'repository skipped',error:'excluded by .estate-mapignore'});continue;}
    try{await repositoryTarget(repoPath,visited);if(await linkedWorktreeGitdir(repoPath))throw new Error('linked worktree checkout');repos.push({name:entry.name,path:repoPath});}catch(error){if(/duplicate or cyclic|linked worktree/.test(error.message))diagnostics.push({repo:entry.name,path:repoPath,diagnostic:'repository skipped',error:error.message});}
  }
  return {repos,diagnostics};
}
// `.git` is optional read-only enrichment metadata here, never a gate on
// component inclusion: a component with no `.git` at all (the common case
// for a plain container directory under the new VCS-independent contract)
// simply reports head_sha 'unknown' against file '.', rather than claiming
// a '.git/HEAD' witness that does not exist.
async function headSha(root) {
  const gitPath=path.join(root,'.git');
  try { let gitDir=gitPath;const stat=await fs.stat(gitPath);if(stat.isFile()){const text=await fs.readFile(gitPath,'utf8');gitDir=path.resolve(root,text.replace(/^gitdir:\s*/,'').trim());}
    const head=(await fs.readFile(path.join(gitDir,'HEAD'),'utf8')).trim();if(!head.startsWith('ref:'))return {head_sha:head,file:'.git/HEAD'};const ref=head.slice(5);try{return {head_sha:(await fs.readFile(path.join(gitDir,ref),'utf8')).trim(),file:'.git/HEAD'};}catch{const packed=await fs.readFile(path.join(gitDir,'packed-refs'),'utf8');return {head_sha:packed.split('\n').find(v=>v.endsWith(` ${ref}`))?.split(' ')[0]||'unknown',file:'.git/HEAD'};}
  }catch{return {head_sha:'unknown',file:'.'};}
}
function language(file){return({'.cs':'csharp','.tf':'terraform','.js':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.tsx':'typescript','.py':'python','.sql':'sql'}[path.extname(file).toLowerCase()]||null);}
const diagnosticKey=value=>JSON.stringify(value);

// Step-3 §14.4: this is a content-addressed statement about the exact finite input
// universe, not a replacement for the diagnostic `files_scanned` coverage count.
export function createScannedManifest({ entries, blockers = [], scannerConfig, scannerSourceClosureDigest }) {
  const canonicalEntries = [...entries].map(entry => ({
    path: normalizePath(entry.path), content_digest: entry.content_digest,
    disposition: entry.disposition || 'scanned', source_identity: entry.source_identity || null,
  })).sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalEntries.some(entry => !entry.path || !entry.content_digest || entry.disposition !== 'scanned')) {
    throw new Error('scanned_manifest entries require normalized path, content digest, and scanned disposition');
  }
  if (new Set(canonicalEntries.map(entry => entry.path)).size !== canonicalEntries.length) throw new Error('scanned_manifest has duplicate paths');
  const canonicalBlockers = [...blockers].map(blocker => ({ path: normalizePath(blocker.path || ''), reason: String(blocker.reason || 'unknown') }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  const body = {
    schema: 'estate-map/scanned-manifest/v1', entries: canonicalEntries, n: canonicalEntries.length,
    unreadable_or_skipped_in_scope: canonicalBlockers, scanner_configuration_digest: sha256(stableStringify(scannerConfig)),
    scanner_source_closure_digest: scannerSourceClosureDigest,
  };
  return { ...body, corpus_manifest_digest: sha256(stableStringify(body)) };
}

export function closedWorldAbsenceStatus(manifest) {
  if (!manifest || manifest.schema !== 'estate-map/scanned-manifest/v1') return { status: 'blocked', code: 'manifest_missing' };
  if (manifest.n !== manifest.entries?.length) return { status: 'blocked', code: 'manifest_count_mismatch' };
  if (manifest.entries.some(entry => !entry.content_digest)) return { status: 'blocked', code: 'manifest_content_digest_missing' };
  if ((manifest.unreadable_or_skipped_in_scope || []).length) return { status: 'blocked', code: 'in_scope_scan_incomplete', blockers: manifest.unreadable_or_skipped_in_scope };
  return { status: 'permitted', code: 'complete_manifest', corpus_manifest_digest: manifest.corpus_manifest_digest };
}

const scannerSourceClosure = async () => {
  const extractorNames = (await fs.readdir(new URL('./extractors/', import.meta.url))).filter(name => name.endsWith('.mjs')).sort();
  const sourceNames = ['extract.mjs', 'lib.mjs', ...extractorNames.map(name => `extractors/${name}`)];
  const sources = await Promise.all(sourceNames.map(async name => [name, sha256(await fs.readFile(new URL(`./${name}`, import.meta.url)))]));
  return sha256(stableStringify({ sources, extractor_availability: extractorAvailabilityReceipt }));
};

export async function extractEstate(estate,out,{repo,strict=false,defaultScopeExclusions=true,catalog_globs: catalogGlobs=[]}={}) {
  if (!Array.isArray(catalogGlobs)) throw new Error('catalog_globs must be an array');
  // The single chokepoint where a scan root becomes known. Registering HERE (rather than in
  // the CLI block) covers every caller: the CLI, loop-driver's iteration, and the
  // multi-estate harness. From this point on, any write under `estate` by any estate-map
  // tool in this process fails with ASCRYBE_READONLY_VIOLATION.
  registerScanRoot(estate,{registeredBy:'extract.mjs estate argument'});
  const ignorePrefixes=await readEstateMapIgnore(estate);
  const discovered=await discoverRepositories(estate,{ignorePrefixes,defaultScopeExclusions}),selected=(discovered.selections||discovered.repos.map(value=>({...value,status:'ready'}))).filter(value=>!repo||value.name===repo);if(!selected.length)throw new Error(`No repositories found${repo?` matching ${repo}`:''}`);
  const all=selected.filter(value=>value.status==='ready'),factsDir=path.join(out,'facts');await fs.mkdir(factsDir,{recursive:true});const diagnostics=[...discovered.diagnostics],statuses=selected.filter(value=>value.status!=='ready').map(value=>({repo:value.name,path:value.path,status:value.status,error:value.error}));
  const manifestEntries=[];
  const manifestBlockers=statuses.map(value=>({ path: normalizePath(path.relative(estate, value.path)) || value.repo, reason: `${value.status}: ${value.error || 'component not scanned'}` }));
  for(const item of all){
    const status={repo:item.name,status:'failed'};statuses.push(status);
    try{
      const {files,skipped,skipCounts,skipSamples,scopeExclusions}=await walk(item.path,{ignorePrefixes,estateRelativeRoot:item.name,defaultScopeExclusions});const counts={},parseErrors=[],facts=[],secretSamples=[];let parseErrorCount=0,secretCount=0;
      for(const absolute of files){
        const file=normalizePath(path.relative(item.path,absolute)),lang=language(file);if(lang)counts[lang]=(counts[lang]||0)+1;
        let text;try{text=await fs.readFile(absolute,'utf8');}catch(error){parseErrorCount++;manifestBlockers.push({ path: normalizePath(path.relative(estate, absolute)), reason: `unreadable: ${error.message}` });if(parseErrors.length<SAMPLE_CAP)parseErrors.push({file,error:error.message});continue;}
        manifestEntries.push({ path: normalizePath(path.relative(estate, absolute)), content_digest: sha256(text), source_identity: { repo: item.name, component_root: normalizePath(path.relative(estate, item.path)) || '.' } });
        const lines=text.split(/\r?\n/),safeLines=lines.map((line,index)=>{if(!secretPattern.test(line))return line;secretCount++;if(secretSamples.length<SAMPLE_CAP)secretSamples.push({file,line:index+1});return'';});
        const extractorErrors=[];
        // What a document IS, decided once per file by the harness so every extractor can stamp
        // its facts with the standing of the source rather than each one classifying separately.
        const documentMode=/\.mdx?$/i.test(file)?(()=>{const held=classifyDocument({path:file,text});return{mode:held.mode,basis:held.basis,archived:held.archived,adjudication_frame:held.adjudication_frame};})():null;
        // `file` is relative to its own repository; a Document is addressed relative to the
        // estate. Those coincide only when the estate IS one repository rooted at the estate root,
        // and the map between them lives in this manifest and never travels into the code graph --
        // so a projection could not join a section to its document in a multi-repository estate and
        // had nothing to say so. The fact carries its own document address instead.
        const documentPath=normalizePath(path.relative(estate,absolute));
        const ctx={repo:item.name,file,document_path:documentPath,catalog_globs:catalogGlobs,document:documentMode,parseErrors:extractorErrors,fact:(kind,line,data)=>({kind,repo:item.name,file,document_path:documentPath,line,...data})};
        for(const extractor of extractors)if(extractor.filePattern.test(file))try{facts.push(...extractor.scan(safeLines,ctx));}catch(error){extractorErrors.push({file,extractor:extractor.kind,error:error.message});}
        parseErrorCount+=extractorErrors.length;for(const error of extractorErrors)if(parseErrors.length<SAMPLE_CAP)parseErrors.push(error);
      }
      const primary_langs=Object.entries(counts).sort((a,b)=>b[1]-a[1]||compare(a[0],b[0])).map(([name,count])=>({name,count}));
      const head=await headSha(item.path);
      // `root` is the component's ESTATE-RELATIVE directory (POSIX, '.' for a
      // component sitting at the estate root itself). It is emitted
      // EXPLICITLY because a component's identifier (`repo`) is NOT a path:
      // a CLONE_MANIFEST row can name a component differently from the
      // directory it lives in, and `name` can differ from `repo` again.
      // Downstream resolution (merge.mjs's estate-wide relative-import index)
      // must join a module's file onto this emitted root, never onto the
      // component's name.
      const root=normalizePath(path.relative(estate,item.path))||'.';
      facts.push({kind:'repo',repo:item.name,file:head.file,line:1,name:item.name,root,head_sha:head.head_sha,primary_langs});
      facts.push({kind:'coverage',repo:item.name,file:'.',line:1,files_scanned:files.length,files_skipped:skipped,skip_counts:skipCounts,scope_exclusion_counts:scopeExclusions.counts,parse_error_count:parseErrorCount,parse_errors:parseErrors.sort((a,b)=>compare(diagnosticKey(a),diagnosticKey(b)))});
      if(skipped)diagnostics.push({repo:item.name,diagnostic:'files skipped',count:skipped,counts:skipCounts,samples:skipSamples});
      if(Object.keys(scopeExclusions.counts).length)diagnostics.push({repo:item.name,diagnostic:'scan scope exclusions',counts:scopeExclusions.counts,rules:scopeExclusions.rules,samples:scopeExclusions.samples});
      status.scope_exclusion_counts=scopeExclusions.counts;
      if(secretCount)diagnostics.push({repo:item.name,diagnostic:'secret-like values quarantined',count:secretCount,samples:secretSamples});
      facts.sort((a,b)=>compare(factKey(a),factKey(b)));await writeJsonLines(path.join(factsDir,`${item.name}.jsonl`),facts);status.status='complete';status.facts=facts.length;status.files_scanned=files.length;
    }catch(error){
      status.error=error.message;
      const componentPath=normalizePath(path.relative(estate,item.path))||item.name;
      manifestBlockers.push({path:componentPath,reason:`repository extraction failed: ${error.message}`});
      diagnostics.push({repo:item.name,path:item.path,diagnostic:'repository extraction failed',error:error.message});
    }
  }
  diagnostics.sort((a,b)=>compare(diagnosticKey(a),diagnosticKey(b)));
  await writeJsonArray(path.join(out,'diagnostics.json'),diagnostics);
  // Exclusion accounting in the run manifest: the ACTIVE rule set plus the
  // measured per-category and per-repository counts. A reader can see the
  // scope reduction (and reproduce the prior scan with the opt-out) instead of
  // silently losing most of the graph.
  const scopeTotals={};
  for(const value of statuses)for(const[category,count]of Object.entries(value.scope_exclusion_counts||{}))scopeTotals[category]=(scopeTotals[category]||0)+count;
  const scannerConfig={ default_scope_exclusions: defaultScopeExclusions, catalog_globs: [...catalogGlobs].sort(), ignore_prefixes: [...ignorePrefixes].sort(), scope_exclusions: describeScopeExclusions({defaultScopeExclusions}), text_extension_registration: textExtensionRegistrationReceipt };
  const scannedManifest=createScannedManifest({ entries: manifestEntries, blockers: manifestBlockers, scannerConfig, scannerSourceClosureDigest: await scannerSourceClosure() });
  const manifest={schema_version:1,extractor_availability:extractorAvailabilityReceipt,extractor_exclusions:extractorExclusionReceipts,text_extension_registration:textExtensionRegistrationReceipt,scope_exclusions:{...describeScopeExclusions({defaultScopeExclusions}),excluded_totals_by_category:scopeTotals,excluded_total:Object.values(scopeTotals).reduce((sum,count)=>sum+count,0)},repositories:statuses.sort((a,b)=>compare(a.repo,b.repo)),scanned_manifest:scannedManifest,corpus_manifest_digest:scannedManifest.corpus_manifest_digest,closed_world_absence:closedWorldAbsenceStatus(scannedManifest)};await writeJson(path.join(out,'_MANIFEST.json'),manifest);
  const failed=statuses.filter(value=>value.status==='failed');if(strict&&failed.length){const error=new Error(`Extraction failed for ${failed.length} repository(s): ${failed.map(value=>value.repo).join(', ')}`);error.code='PARTIAL_EXTRACTION';throw error;}
  return {repositories:all.length,diagnostics:diagnostics.length};
}
if(import.meta.url===`file://${process.argv[1]}`){
  const {positional,options}=parseArgs(process.argv.slice(2));
  const defaultScopeExclusions=!options['no-default-scope-exclusions'];
  if(options['print-scope-exclusions']){console.log(JSON.stringify(describeScopeExclusions({defaultScopeExclusions}),null,2));process.exit(0);}
  if(options.help||!positional[0]){console.log(HELP);process.exit(options.help?0:1);}
  // The old default, `<cwd>/estate-map-output`, is safe only when cwd happens to sit
  // outside the estate -- running `extract.mjs .` from inside a repo wrote its own output
  // into the tree it was scanning. defaultOutputRoot is unconditionally outside.
  const estate=path.resolve(positional[0]),out=options.out?path.resolve(options.out):defaultOutputRoot(estate,'extract');
  extractEstate(estate,out,{repo:options.repo,strict:options.strict,defaultScopeExclusions}).then(result=>console.log(`Extracted ${result.repositories} repositories to ${out} (scan-scope exclusions ${defaultScopeExclusions?'ON':'OFF'})`)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
