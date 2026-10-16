#!/usr/bin/env node
// Deterministic Task-2a data plane. This module only reads an estate and writes an
// explicit manifest outside it; it deliberately has no provider, producer, or evaluator path.
import fs from './readonly-guard.mjs';
import { defaultOutputRoot, registerScanRoot } from './readonly-guard.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyExcludedDirName, classifyProvenance, isIgnoredPath, normalizePath, parseArgs, readEstateMapIgnore, sha256, stableStringify } from './lib.mjs';

const execFileAsync = promisify(execFile);
export const CORPUS_SCHEMA = 'estate-map/neural-census-corpus/v1';
export const DISPOSITIONS = Object.freeze(['processed', 'excluded_with_reason', 'failed', 'unavailable']);
export const READ_DEPTHS = Object.freeze(['inventory_only', 'signature_level', 'full_text']);
export const ELIGIBLE_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.ini', '.java', '.js', '.json', '.json5', '.jsx', '.md', '.mjs',
  '.mts', '.py', '.sh', '.sql', '.tf', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const ELIGIBLE_BASENAMES = new Set(['Dockerfile', 'Makefile', 'README', 'LICENSE']);

export class CorpusError extends Error {
  constructor(code, message, detail = {}) { super(message); this.name = 'CorpusError'; this.code = code; this.detail = detail; }
}
export class ConservationError extends Error {
  constructor(code, message, report) { super(message); this.name = 'ConservationError'; this.code = code; this.report = report; }
}
export class CampaignMismatchError extends Error {
  constructor(reason, claimId) { super(`claim ${claimId} cannot be reused: ${reason}`); this.name = 'CampaignMismatchError'; this.code = 'NEURAL_CENSUS_NO_CARRY'; this.reason = reason; }
}

const comparePath = (left, right) => left.path.localeCompare(right.path);
const eligibleFile = name => ELIGIBLE_EXTENSIONS.has(path.extname(name).toLowerCase()) || ELIGIBLE_BASENAMES.has(name);
const typedReason = (code, detail = {}) => ({ code, ...detail });

// Translate a `--exclude` glob into a matcher over estate-relative paths. A `dir/**` glob is a
// prefix rule (matches the directory itself and every descendant); a literal path with no wildcard
// is a prefix rule too; anything with `*`/`?` becomes an anchored regex (`*` = one path segment,
// `**` = any depth). Deliberately small (no full gitignore semantics): it exists so the neural
// entrypoint can drop transcript-dump directories reliably.
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}
export function buildExcludeMatcher(globs = []) {
  const rules = (globs || []).map(raw => {
    const glob = normalizePath(String(raw)).replace(/^\.\//, '').replace(/\/+$/, '');
    if (glob.endsWith('/**')) return { kind: 'prefix', value: glob.slice(0, -3) };
    if (/[*?]/.test(glob)) return { kind: 'regex', value: globToRegExp(glob) };
    return { kind: 'prefix', value: glob };
  }).filter(rule => rule.value);
  return relPath => {
    const normalized = normalizePath(relPath);
    return rules.some(rule => rule.kind === 'prefix'
      ? (normalized === rule.value || normalized.startsWith(`${rule.value}/`))
      : rule.value.test(normalized));
  };
}

async function walkEligible(root, current, entries, exclusions, scope) {
  let children;
  try { children = await fs.readdir(current, { withFileTypes: true }); }
  catch (error) {
    entries.push({ path: normalizePath(path.relative(root, current)), blob_hash: null, byte_size: null, provenance_class: 'production', read_depth: 'inventory_only', disposition: 'unavailable', reason: typedReason('directory_unavailable', { message: error.code || error.message }) });
    return;
  }
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, child.name);
    const relative = normalizePath(path.relative(root, absolute));
    if (child.isSymbolicLink()) {
      exclusions.push({ path: relative, reason: typedReason('symlink_not_followed') });
      continue;
    }
    if (child.isDirectory()) {
      const exclusion = classifyExcludedDirName(child.name);
      if (exclusion) { exclusions.push({ path: relative, reason: typedReason('directory_excluded', exclusion) }); continue; }
      // .estate-mapignore prefix exclusion — honored HERE on the neural corpus path (root-cause fix:
      // walkEligible previously never consulted the ignore file, so a `.estate-mapignore` listing
      // `_recovered-from-transcripts` was silently ignored and its transcript-dump noise scanned).
      if (scope.ignorePrefixes.length && isIgnoredPath(relative, scope.ignorePrefixes)) { exclusions.push({ path: relative, reason: typedReason('estate_mapignore', { rule: '.estate-mapignore prefix' }) }); continue; }
      if (scope.matchExclude(relative)) { exclusions.push({ path: relative, reason: typedReason('exclude_glob', { rule: 'configured --exclude glob' }) }); continue; }
      await walkEligible(root, absolute, entries, exclusions, scope);
      continue;
    }
    if (!child.isFile() || !eligibleFile(child.name)) continue;
    if (scope.ignorePrefixes.length && isIgnoredPath(relative, scope.ignorePrefixes)) {
      entries.push({ path: relative, blob_hash: null, byte_size: null, provenance_class: classifyProvenance('', relative), read_depth: 'inventory_only', disposition: 'excluded_with_reason', reason: typedReason('estate_mapignore', { rule: '.estate-mapignore prefix' }) });
      continue;
    }
    if (scope.matchExclude(relative)) {
      entries.push({ path: relative, blob_hash: null, byte_size: null, provenance_class: classifyProvenance('', relative), read_depth: 'inventory_only', disposition: 'excluded_with_reason', reason: typedReason('exclude_glob', { rule: 'configured --exclude glob' }) });
      continue;
    }
    let stat;
    try { stat = await fs.stat(absolute); }
    catch (error) {
      entries.push({ path: relative, blob_hash: null, byte_size: null, provenance_class: classifyProvenance('', relative), read_depth: 'inventory_only', disposition: 'unavailable', reason: typedReason('stat_failed', { message: error.code || error.message }) });
      continue;
    }
    // Hard per-file byte cap: a single oversized doc (e.g. the ~977 KB ORCHESTRATION-BACKLOG) is
    // recorded as excluded_with_reason and never read, rather than blowing up a model prompt.
    if (Number.isFinite(scope.excludeOverBytes) && stat.size > scope.excludeOverBytes) {
      entries.push({ path: relative, blob_hash: null, byte_size: stat.size, provenance_class: classifyProvenance('', relative), read_depth: 'inventory_only', disposition: 'excluded_with_reason', reason: typedReason('exceeds_byte_cap', { byte_size: stat.size, cap: scope.excludeOverBytes }) });
      continue;
    }
    try {
      const contents = await fs.readFile(absolute);
      entries.push({ path: relative, blob_hash: sha256(contents), byte_size: stat.size, provenance_class: classifyProvenance('', relative), read_depth: 'full_text', disposition: 'processed', reason: null });
    } catch (error) {
      entries.push({ path: relative, blob_hash: null, byte_size: stat.size, provenance_class: classifyProvenance('', relative), read_depth: 'inventory_only', disposition: 'failed', reason: typedReason('read_failed', { message: error.code || error.message }) });
    }
  }
}

export function validateCorpusEntry(entry) {
  if (!entry.path || entry.path.startsWith('../') || path.isAbsolute(entry.path)) throw new CorpusError('INVALID_PATH', 'corpus entry path must be normalized and estate-relative', { entry });
  if (!DISPOSITIONS.includes(entry.disposition)) throw new CorpusError('INVALID_DISPOSITION', `invalid corpus disposition: ${entry.disposition}`, { entry });
  if (!READ_DEPTHS.includes(entry.read_depth)) throw new CorpusError('INVALID_READ_DEPTH', `invalid read depth: ${entry.read_depth}`, { entry });
  if (!['production', 'test', 'fixture', 'docs'].includes(entry.provenance_class)) throw new CorpusError('INVALID_PROVENANCE_CLASS', 'invalid provenance class', { entry });
  if (['excluded_with_reason', 'failed', 'unavailable'].includes(entry.disposition) && (!entry.reason || typeof entry.reason.code !== 'string')) throw new CorpusError('MISSING_TYPED_REASON', 'non-processed corpus entry requires typed reason', { entry });
  if (entry.read_depth === 'inventory_only' && entry.disposition === 'processed') throw new CorpusError('READ_DEPTH_LIE', 'inventory-only artifact cannot be labelled processed/read', { entry });
  if (entry.disposition === 'processed' && (!/^[a-f0-9]{64}$/.test(entry.blob_hash) || !Number.isInteger(entry.byte_size) || entry.read_depth !== 'full_text')) throw new CorpusError('INVALID_PROCESSED_ENTRY', 'processed entry requires real hash, byte size, and full-text read depth', { entry });
}

async function sourceSha(root) {
  try { return (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(); }
  catch { return 'unknown'; }
}

export async function produceCorpus(root, { source_sha = null, ignorePrefixes = null, excludeGlobs = [], excludeOverBytes = null } = {}) {
  const estate = await fs.realpath(root);
  registerScanRoot(estate, { registeredBy: 'neural-census.mjs corpus producer' });
  // Reliable exclusion on the neural path: honor `.estate-mapignore` (unless prefixes are supplied
  // explicitly), plus any caller-supplied `--exclude` globs and per-file byte cap.
  const resolvedIgnore = Array.isArray(ignorePrefixes) ? ignorePrefixes : await readEstateMapIgnore(estate);
  const scope = {
    ignorePrefixes: resolvedIgnore || [],
    matchExclude: buildExcludeMatcher(excludeGlobs || []),
    excludeOverBytes: Number.isFinite(excludeOverBytes) ? excludeOverBytes : Infinity,
  };
  const entries = [], exclusions = [];
  await walkEligible(estate, estate, entries, exclusions, scope);
  entries.sort(comparePath); exclusions.sort(comparePath);
  for (const entry of entries) validateCorpusEntry(entry);
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new CorpusError('DUPLICATE_PATH', 'corpus contains duplicate normalized paths');
  const body = {
    schema: CORPUS_SCHEMA,
    source_sha: source_sha || await sourceSha(estate),
    entries,
    exclusions,
    totals: {
      artifacts: entries.length,
      processed: entries.filter(entry => entry.disposition === 'processed').length,
      excluded_with_reason: entries.filter(entry => entry.disposition === 'excluded_with_reason').length,
      failed: entries.filter(entry => entry.disposition === 'failed').length,
      unavailable: entries.filter(entry => entry.disposition === 'unavailable').length,
      by_provenance_class: Object.fromEntries(['production', 'test', 'fixture', 'docs'].map(value => [value, entries.filter(entry => entry.provenance_class === value).length])),
      full_text: entries.filter(entry => entry.read_depth === 'full_text').length,
      inventory_only: entries.filter(entry => entry.read_depth === 'inventory_only').length,
    },
  };
  return { ...body, corpus_digest: sha256(stableStringify(body)) };
}

export function canonicalCorpusBytes(corpus) { return stableStringify(corpus); }

const idOf = value => value.id || value;
const claimRecords = records => records.filter(record => record.record_kind === 'claim');
const semantic = record => record.semantic || record;
const recordClaimId = record => semantic(record).claim_id || semantic(record).claim || null;

export function computeConservation({ corpus, records = [], documentAccounting = null, claimAccounting = null } = {}) {
  const documents = corpus.entries.filter(entry => entry.provenance_class === 'docs');
  const documentIds = new Set(documents.map(entry => entry.path));
  const accountedDocuments = documentAccounting || documents.map(entry => ({ path: entry.path, disposition: entry.disposition }));
  const accountedIds = new Set(accountedDocuments.map(item => item.path));
  const documentResidue = [...documentIds].filter(id => !accountedIds.has(id)).sort();
  const claims = claimRecords(records);
  const claimIds = new Set(claims.map(idOf));
  const accountedClaims = claimAccounting || claims;
  const claimResidue = [...claimIds].filter(id => !new Set(accountedClaims.map(idOf)).has(id)).sort();
  const docsByPath = new Map(documents.map(entry => [entry.path, entry]));
  const claimsByDocument = new Set(claims.map(record => semantic(record).source_path).filter(Boolean));
  const documents_with_claims = [...documentIds].filter(id => claimsByDocument.has(id)).length;
  const no_claim_documents = [...documentIds].filter(id => !claimsByDocument.has(id) && docsByPath.get(id).disposition === 'processed').length;
  const excluded_documents_with_reason = documents.filter(entry => entry.disposition === 'excluded_with_reason').length;
  const claimDispositions = Object.fromEntries([...new Set(claims.map(record => semantic(record).disposition.kind))].sort().map(kind => [kind, claims.filter(record => semantic(record).disposition.kind === kind).length]));
  const report = { documents: { documents_total: documents.length, documents_with_claims, no_claim_documents, excluded_documents_with_reason, residue: documentResidue }, claims: { claims_total: claims.length, dispositions: claimDispositions, residue: claimResidue } };
  const documentSum = documents_with_claims + no_claim_documents + excluded_documents_with_reason;
  const claimSum = Object.values(claimDispositions).reduce((sum, count) => sum + count, 0);
  if (documentResidue.length || documentSum !== documents.length) throw new ConservationError('DOCUMENT_CONSERVATION_FAILED', `document conservation failed; residue=${documentResidue.join(',') || documentSum - documents.length}`, report);
  if (claimResidue.length || claimSum !== claims.length) throw new ConservationError('CLAIM_CONSERVATION_FAILED', `claim conservation failed; residue=${claimResidue.join(',') || claimSum - claims.length}`, report);
  return report;
}

export function deriveClaimFunnel({ corpus, records = [] } = {}) {
  const claims = claimRecords(records);
  const ids = new Set(claims.map(idOf));
  const linked = kind => records.filter(record => record.record_kind === kind && ids.has(recordClaimId(record))).length;
  const stages = {
    corpus_artifacts: corpus.entries.length,
    processed: corpus.entries.filter(entry => entry.disposition === 'processed').length,
    excluded: corpus.entries.filter(entry => entry.disposition === 'excluded_with_reason').length,
    failed: corpus.entries.filter(entry => ['failed', 'unavailable'].includes(entry.disposition)).length,
    claims: claims.length,
    typed: claims.filter(record => { const value = semantic(record); return value.predicate_family && Array.isArray(value.subject_refs) && value.subject_refs.length && value.polarity; }).length,
    adjudicated: linked('resolution'),
    evidence_state: linked('evidence'),
    mechanized_candidates: records.filter(record => record.record_kind === 'alignment' && semantic(record).disposition?.kind === 'mechanized_candidate' && ids.has(recordClaimId(record))).length,
  };
  return { stages, denominators: { artifact_total: stages.corpus_artifacts, claim_total: stages.claims }, residue: { artifact_terminal: stages.corpus_artifacts - stages.processed - stages.excluded - stages.failed, typed_claims: stages.claims - stages.typed } };
}

export function assertDerivedFunnel(funnel, input) {
  const derived = deriveClaimFunnel(input);
  if (canonicalCorpusBytes(funnel) !== canonicalCorpusBytes(derived)) throw new CorpusError('FABRICATED_FUNNEL_STAGE', 'claim funnel must equal the population-derived funnel');
  return funnel;
}

export function admitClaimForCampaign(claim, campaign) {
  const value = semantic(claim);
  for (const [field, reason] of [['snapshot_sha', 'snapshot_mismatch'], ['corpus_digest', 'corpus_digest_mismatch'], ['campaign_id', 'campaign_id_mismatch']]) {
    if (value[field] !== campaign[field]) throw new CampaignMismatchError(reason, idOf(claim));
  }
  return claim;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log('Usage: node tools/estate-map/neural-census.mjs <estate-dir> --out <manifest.json>'); process.exitCode = options.help ? 0 : 1; return; }
  const estate = path.resolve(positional[0]);
  const out = options.out ? path.resolve(options.out) : defaultOutputRoot(estate, 'neural-census/corpus-manifest.json');
  const corpus = await produceCorpus(estate);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, canonicalCorpusBytes(corpus));
  console.log(JSON.stringify({ out, corpus_digest: corpus.corpus_digest, totals: corpus.totals }, null, 2));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
