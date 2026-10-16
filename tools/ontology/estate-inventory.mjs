// Whole-scope inventory and semantic-unit chunking for ontology discovery. Every file of every declared source at its
// frozen ref gets exactly one disposition, with its rule, before any model call. Nothing here reads a file by its
// first N characters: a supported file is either cut into units that together cover every line, or it carries an
// explicit reason it was not read. Rules are deterministic and scope-based; none names a domain.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fail } from './schemas.mjs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGitmodulesText, resolveSubmoduleRepository, submoduleCommitPresent, DEFAULT_MAX_SUBMODULE_DEPTH } from '../git-submodule-resolution.mjs';

export const INVENTORY_SCHEMA = 'estate-map/ontology-estate-inventory/v1';
export const UNIT_TARGET_BYTES = 3_500;
export const UNIT_MAX_BYTES = 6_000;
export const MAX_READ_FILE_BYTES = 512 * 1024;
export const HOMOGENEOUS_DIRECTORY_FILES = 200;
export const BULK_SUBTREE_FILES = 1000;
export const DATA_FILE_BYTES = 96 * 1024;

const EXCLUDED_COMPONENTS = new Set(['node_modules', '.git', 'Pods', 'build', 'dist', 'DerivedData', '__pycache__', '.venv', 'venv', 'vendor', 'worktrees', '.gradle', '.next',
  '.terraform', 'cdk.out', 'coverage', '.idea', '.vscode', '.cache', '.estate']);
const CREDENTIAL_NAMES = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|.*\.(pem|key|p12|pfx|keystore|jks|mobileprovision))$/iu;
const GENERATED_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|Podfile\.lock|Cargo\.lock|poetry\.lock|[^/]+\.min\.(js|css)|[^/]+\.map)$/iu;
const FAMILIES = Object.freeze({
  code: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'kt', 'kts', 'java', 'swift', 'm', 'mm', 'h', 'hpp', 'c', 'cc', 'cpp', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'bru', 'gradle', 'cs', 'scala', 'dart', 'lua'],
  structured: ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'sql', 'graphql', 'proto', 'tf', 'plist', 'xml', 'pbxproj', 'strings', 'xcconfig', 'entitlements', 'storyboard', 'csv', 'tsv', 'env.example', 'example'],
  document: ['md', 'mdx', 'rst', 'txt', 'adoc', 'html', 'htm', 'css', 'scss', 'less'],
});
const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([family, exts]) => exts.map(e => [e, family])));
const UNSUPPORTED_DOCUMENT = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'rtf', 'pages', 'numbers', 'key']);
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'ico', 'mp3', 'mp4', 'mov', 'webm', 'wav', 'm4a', 'aac', 'ttf', 'otf', 'woff', 'woff2', 'dylib', 'a', 'so', 'bin', 'db', 'sqlite', 'zip', 'gz', 'tar', 'tgz', 'psd', 'ai', 'xcassets', 'car', 'lottie']);
const BULK_TABULAR_BYTES = 64 * 1024;
const ARCHIVE_COMPONENT = /^_?(archives?|backups?)$/iu;
const DATA_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'xml', 'plist', 'csv', 'tsv']);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'], ...options });
const extOf = path => { const base = path.split('/').at(-1); const m = base.match(/\.([A-Za-z0-9]+)$/u); return m ? m[1].toLowerCase() : base.startsWith('.') ? base.slice(1).toLowerCase() : ''; };

/** The disposition of one path, from its path, size and mode alone. `siblings` is the count of same-extension files in its directory. */
export function dispositionOf({ path, size, mode, type, policy, siblings = 0, subtree = 0 }) {
  if (type === 'commit' || mode === '160000') return { disposition: 'not_read', rule: 'non_regular_entry', detail: 'a gitlink or submodule entry; its contents are not part of this source' };
  if (!['100644', '100755'].includes(mode)) return { disposition: 'not_read', rule: 'non_regular_entry', detail: 'not a regular file' };
  const parts = path.split('/');
  const ext = extOf(path);
  if (policy === 'inventory_only') return { disposition: 'withheld', rule: 'sensitive_domain_inventory_only', detail: 'the source is declared inventory-only by scope policy; contents were not sent to any model' };
  if (parts.slice(0, -1).some(p => EXCLUDED_COMPONENTS.has(p))) return { disposition: 'excluded', rule: 'dependency_or_build_directory', detail: parts.find(p => EXCLUDED_COMPONENTS.has(p)) };
  if (CREDENTIAL_NAMES.test(path)) return { disposition: 'withheld', rule: 'credential_like_name', detail: 'a file name that commonly holds credentials' };
  if (GENERATED_NAMES.test(path)) return { disposition: 'excluded', rule: 'generated_lock_or_minified', detail: ext };
  if (parts.slice(0, -1).some(p => ARCHIVE_COMPONENT.test(p))) return { disposition: 'not_read', rule: 'archived_snapshot_directory', detail: parts.find(p => ARCHIVE_COMPONENT.test(p)) };
  if (['log', 'jsonl', 'ndjson'].includes(ext)) return { disposition: 'not_read', rule: 'log_or_record_stream', detail: ext };
  if (UNSUPPORTED_DOCUMENT.has(ext)) return { disposition: 'not_read', rule: 'unsupported_document_format', detail: ext };
  if (MEDIA.has(ext)) return { disposition: 'not_read', rule: 'unsupported_binary_or_media', detail: ext };
  const family = FAMILY_OF.get(ext) ?? (ext === '' ? 'extensionless' : null);
  if (!family) return { disposition: 'not_read', rule: 'unknown_format', detail: ext || '(none)' };
  if (['log', 'jsonl', 'ndjson'].includes(ext)) return { disposition: 'not_read', rule: 'log_or_record_stream', detail: ext };
  if (subtree >= BULK_SUBTREE_FILES) return { disposition: 'not_read', rule: 'homogeneous_bulk_subtree', detail: `${subtree} files of one format under one directory` };
  if (siblings >= HOMOGENEOUS_DIRECTORY_FILES) return { disposition: 'not_read', rule: 'homogeneous_bulk_directory', detail: `${siblings} files of one format in one directory` };
  if (DATA_EXTENSIONS.has(ext) && size > DATA_FILE_BYTES) return { disposition: 'not_read', rule: 'data_file_over_read_limit', detail: `${size} bytes exceeds ${DATA_FILE_BYTES} for a data format` };
  if (size > MAX_READ_FILE_BYTES) return { disposition: 'not_read', rule: 'file_over_read_limit', detail: `${size} bytes exceeds ${MAX_READ_FILE_BYTES}` };
  if ((ext === 'csv' || ext === 'tsv') && size > BULK_TABULAR_BYTES) return { disposition: 'not_read', rule: 'bulk_tabular_data', detail: ext };
  if (size === 0) return { disposition: 'not_read', rule: 'empty_file', detail: '' };
  return { disposition: 'supported', rule: 'supported_text', detail: family === 'extensionless' ? 'extensionless' : family, family: family === 'extensionless' ? 'code' : family };
}

/** Lists every tree entry of `source` at `ref` with its disposition. Exact: sizes come from the object store. */
export function inventorySource(source) {
  const listing = git(source.root, ['ls-tree', '-r', '-l', '-z', source.ref]).split('\0').filter(Boolean).map(line => {
    const separator = line.indexOf('\t');
    const meta = line.slice(0, separator), path = line.slice(separator + 1);
    const [mode, type, oid, size] = meta.trim().split(/\s+/u);
    return { path, mode, type, oid, size: size === '-' ? 0 : Number(size) };
  });
  const perDirectory = new Map();
  for (const e of listing) { const key = `${e.path.split('/').slice(0, -1).join('/')}\u0000${extOf(e.path)}`; perDirectory.set(key, (perDirectory.get(key) ?? 0) + 1); }
  // A directory subtree holding a thousand files of one format is a collection, not a set of documents: counted at every depth.
  const perSubtree = new Map();
  for (const e of listing) { const dirs = e.path.split('/').slice(0, -1); for (let d = 1; d <= Math.min(dirs.length, 6); d += 1) { const key = `${dirs.slice(0, d).join('/')}\u0000${extOf(e.path)}`; perSubtree.set(key, (perSubtree.get(key) ?? 0) + 1); } }
  const subtreeOf = e => { const dirs = e.path.split('/').slice(0, -1); let best = 0; for (let d = 1; d <= Math.min(dirs.length, 6); d += 1) best = Math.max(best, perSubtree.get(`${dirs.slice(0, d).join('/')}\u0000${extOf(e.path)}`) ?? 0); return best; };
  return listing.map(e => ({ source_id: source.id, ...e, ext: extOf(e.path),
    ...dispositionOf({ ...e, policy: source.policy, siblings: perDirectory.get(`${e.path.split('/').slice(0, -1).join('/')}\u0000${extOf(e.path)}`), subtree: subtreeOf(e) }) }));
}

const KEYWORD_START = /^(export\s|function\s|async\s|class\s|interface\s|type\s|enum\s|struct\s|extension\s|protocol\s|func\s|fun\s|object\s|def\s|public\s|private\s|internal\s|final\s|abstract\s|import\s|const\s|let\s|var\s|@\w|#\s|##\s|###\s|CREATE\s|ALTER\s|resource\s|module\s|package\s|\w[\w-]*:\s*$)/u;

/** Splits text into line-aligned units. A cut is preferred at a heading or top-level construct after a blank line, then at a
 * blank line, then at a line start; the units together cover every line exactly once. */
export function chunkText(body, { target = UNIT_TARGET_BYTES, max = UNIT_MAX_BYTES } = {}) {
  const lines = body.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  const units = [];
  let start = 0, bytes = 0, best = -1, bestScore = 0;
  const flush = end => { if (end > start) units.push({ start_line: start + 1, end_line: end, text: lines.slice(start, end).join('\n') }); start = end; bytes = 0; best = -1; bestScore = 0; };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (bytes >= target * 0.5) {
      const blankBefore = i > start && lines[i - 1].trim() === '';
      const score = KEYWORD_START.test(line) && (blankBefore || /^#{1,3}\s/u.test(line)) ? 3 : blankBefore && /^\S/u.test(line) ? 2 : blankBefore ? 1 : 0;
      if (score >= bestScore && score > 0) { best = i; bestScore = score; }
    }
    bytes += Buffer.byteLength(line) + 1;
    if (bytes >= target && best > start) { const cut = best; const keep = lines.slice(cut, i + 1).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0); flush(cut); bytes = keep; best = -1; bestScore = 0; }
    else if (bytes >= max) { flush(i + 1); }
  }
  flush(lines.length);
  return units;
}

export const unitKindOf = (family, ext) => (family === 'document' ? (ext === 'css' || ext === 'scss' || ext === 'less' ? 'structured_source' : 'document_claim')
  : family === 'structured' ? 'structured_source' : 'code');

/** Reads each supported file once at its pin and cuts it. Units carry the exact text digest; the unit list for a file is
 * a partition of its lines. Returns `{ units, unreadable }`: a file whose blob cannot be read at the pin is reported. */
/** Blob bodies for many oids in one git process. */
export function readBlobs(root, oids) {
  const unique = [...new Set(oids)], out = new Map();
  if (!unique.length) return out;
  const raw = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: `${unique.join('\n')}\n`, maxBuffer: 2_000_000_000, stdio: ['pipe', 'pipe', 'ignore'] });
  let at = 0;
  while (at < raw.length) {
    const eol = raw.indexOf(10, at);
    const [oid, type, size] = raw.toString('utf8', at, eol).split(' ');
    if (type === 'missing') { at = eol + 1; continue; }
    const n = Number(size);
    out.set(oid, raw.subarray(eol + 1, eol + 1 + n));
    at = eol + 1 + n + 1;
  }
  return out;
}

export function unitsForSource(source, entries, { onFile } = {}) {
  const units = [], unreadable = [];
  const blobs = readBlobs(source.root, entries.filter(x => x.disposition === 'supported').map(x => x.oid));
  for (const e of entries.filter(x => x.disposition === 'supported')) {
    const buffer = blobs.get(e.oid);
    if (!buffer) { unreadable.push({ path: e.path, oid: e.oid, reason: 'blob not readable at the pin' }); continue; }
    const body = buffer.toString('utf8');
    if (body.includes('\u0000')) { unreadable.push({ path: e.path, oid: e.oid, reason: 'contains NUL bytes' }); continue; }
    const cut = chunkText(body);
    cut.forEach((u, index) => units.push({ unit_id: `u-${sha256(`${source.id}\u0000${e.path}\u0000${u.start_line}\u0000${sha256(u.text)}`).slice(0, 16)}`, source_id: source.id, path: e.path, oid: e.oid,
      ext: e.ext, family: e.family ?? e.detail, kind: unitKindOf(e.detail, e.ext), index, of: cut.length, start_line: u.start_line, end_line: u.end_line, bytes: Buffer.byteLength(u.text), content_sha256: sha256(u.text) }));
    onFile?.(e, cut);
  }
  return { units, unreadable };
}

/** Per-source, per-extension and per-rule counts and bytes: the outline the reader sees before any inference. */
export function summarizeInventory(entries, units = []) {
  const tally = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); const x = m.get(k) ?? { files: 0, bytes: 0 }; x.files += 1; x.bytes += r.size ?? r.bytes ?? 0; m.set(k, x); } return Object.fromEntries([...m].sort((a, b) => b[1].bytes - a[1].bytes)); };
  const sources = [...new Set(entries.map(e => e.source_id))];
  return Object.fromEntries(sources.map(id => {
    const mine = entries.filter(e => e.source_id === id), mineUnits = units.filter(u => u.source_id === id);
    return [id, { files: mine.length, bytes: mine.reduce((n, e) => n + e.size, 0), by_disposition: tally(mine, e => e.disposition), by_rule: tally(mine, e => `${e.disposition}:${e.rule}`),
      by_extension: Object.fromEntries(Object.entries(tally(mine, e => e.ext || '(none)')).slice(0, 14)),
      supported_files: mine.filter(e => e.disposition === 'supported').length, units: mineUnits.length, unit_bytes: mineUnits.reduce((n, u) => n + u.bytes, 0) }];
  }));
}

/** Expand declared gitlinks using the shared local-only resolver. Location never supplies a pin. */
export function inventoryEstate(input) {
  validateManifest(input);
  const sources = input.sources.map(s => ({ ...s, ...(s.parents ? { parents: [...s.parents] } : {}) }));
  const identity = s => `${realpathSync(resolve(s.root, git(s.root, ['rev-parse', '--git-common-dir']).trim()))}\u0000${s.ref}`;
  const byIdentity = new Map(), byId = new Map(sources.map(s => [s.id, s]));
  const duplicates = new Map();
  for (const source of sources) {
    const key = identity(source), prior = byIdentity.get(key);
    if (prior) {
      if (prior.policy !== source.policy) fail('ESTATE_SOURCE_POLICY_CONFLICT', 'duplicate source pins have different policies');
      duplicates.set(source.id, prior.id);
    } else byIdentity.set(key, source);
  }
  const entries = [], units = [], unreadable = [], visited = new Set();
  const visit = (source, chain = []) => {
    if (visited.has(source.id)) return;
    visited.add(source.id);
    const mine = inventorySource(source);
    let declarations = new Map();
    try { declarations = parseGitmodulesText(git(source.root, ['show', `${source.ref}:.gitmodules`])); } catch { /* no pinned declarations */ }
    for (const entry of mine.filter(e => e.mode === '160000')) {
      const name = declarations.get(entry.path);
      const refuseLink = rule => Object.assign(entry, { disposition: 'not_read', rule, detail: 'gitlink contents unavailable at the declared pin' });
      if (!name) { refuseLink('GITLINK_UNREGISTERED'); continue; }
      if (chain.length >= DEFAULT_MAX_SUBMODULE_DEPTH) { refuseLink('SUBMODULE_DEPTH_EXCEEDED'); continue; }
      const resolved = resolveSubmoduleRepository({ parentRepository: source.root, name, path: entry.path,
        sourceRepositories: { ...Object.fromEntries(input.sources.map(s => [s.id, s.root])), ...input.source_repositories } });
      if (!resolved || !submoduleCommitPresent(resolved.repository, entry.oid)) { refuseLink('SUBMODULE_UNAVAILABLE'); continue; }
      const candidate = { root: resolved.repository, ref: entry.oid }, key = identity(candidate);
      if ([...chain, identity(source)].includes(key)) { refuseLink('SUBMODULE_CYCLE_DETECTED'); continue; }
      const parent = { source_id: source.id, path: entry.path, gitlink_pin: entry.oid };
      let child = byIdentity.get(key);
      if (child && child.policy !== source.policy) fail('ESTATE_SOURCE_POLICY_CONFLICT', 'submodule and explicit source policies differ');
      if (!child) {
        const id = `sub-${sha256(`${source.id}\u0000${entry.path}`).slice(0, 24)}`;
        if (byId.has(id)) fail('ESTATE_SOURCE_ID_COLLISION', id);
        child = { ...candidate, id, policy: source.policy, source_kind: 'git', parents: [] };
        sources.push(child); byIdentity.set(key, child); byId.set(id, child);
      }
      child.parents ??= [];
      if (!child.parents.some(p => p.source_id === parent.source_id && p.path === parent.path && p.gitlink_pin === parent.gitlink_pin)) child.parents.push(parent);
      Object.assign(entry, { disposition: 'child_source', rule: visited.has(child.id) ? 'submodule_already_inventoried' : 'submodule_pinned', detail: resolved.resolved_via, child_source_id: child.id });
      visit(child, [...chain, identity(source)]);
    }
    entries.push(...mine);
    if (source.policy === 'interpret') {
      const cut = unitsForSource(source, mine);
      units.push(...cut.units); unreadable.push(...cut.unreadable.map(u => ({ source_id: source.id, ...u })));
    }
  };
  for (const source of input.sources) if (!duplicates.has(source.id)) visit(byId.get(source.id));
  return { manifest: { ...input, sources: sources.filter(s => !duplicates.has(s.id)), duplicate_sources: [...duplicates].map(([source_id, canonical_source_id]) => ({ source_id, canonical_source_id, disposition: 'not_read', rule: 'duplicate_repository_pin' })) }, entries, units, unreadable };
}

export function validateManifest(manifest) {
  if (manifest?.schema !== 'estate-map/ontology-estate-manifest/v1' || !Array.isArray(manifest.sources) || !manifest.sources.length) fail('ESTATE_MANIFEST_INVALID', 'a manifest needs sources');
  const ids = new Set();
  for (const s of manifest.sources) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(s.id || '') || ids.has(s.id) || !/^[a-f0-9]{40}$/u.test(s.ref || '') || !s.root || !['interpret', 'inventory_only'].includes(s.policy)) fail('ESTATE_MANIFEST_INVALID', `source ${s.id} needs a unique id, a root, a full commit ref and a policy`);
    if (s.source_kind != null && !['git', 'snapshot_import'].includes(s.source_kind)) fail('ESTATE_MANIFEST_INVALID', `source ${s.id} has an unknown source kind`);
    if (s.source_kind === 'snapshot_import' && (!/^[a-f0-9]{40}$/u.test(s.snapshot?.tree || '') || s.snapshot.authored_history !== false)) fail('ESTATE_MANIFEST_INVALID', `source ${s.id} needs its snapshot tree and non-authored-history marker`);
    ids.add(s.id);
  }
  return manifest;
}
