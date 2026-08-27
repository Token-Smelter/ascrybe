import fs from './readonly-guard.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from './readonly-guard.mjs';

// '.estate-map' is this tool's own documented output directory (see
// README.md Phase 0); excluding it by name keeps a re-scan of an estate that
// already carries derived output from treating its own prior run as source.
// 'bin' is deliberately NOT in this list. In compiled ecosystems (C#/Java) `bin/` is build
// output, but in the Node/TypeScript ecosystem `bin/` at a package root is SOURCE by
// convention: npm's `bin` field points at checked-in scripts, and `cdk init` scaffolds every
// CDK app's entrypoint as `bin/<app>.ts`. Excluding it wholesale made the map structurally
// blind to the entrypoint of any CDK application — the one file that says which stacks get
// deployed. Compiled siblings inside such a directory are still excluded by the `.d.ts`
// suffix rule and de-duplicated by merge.mjs's `source_over_generated_sibling` resolution.
export const DEFAULT_EXCLUDED_DIRS = Object.freeze(['.git','node_modules','obj','dist','build','out','.next','.nuxt','vendor','Pods','Carthage','DerivedData','.gradle','.idea','target','coverage','__pycache__','.venv','venv','.terraform','.cache','.npm','.yarn','.pnpm-store','.estate-map']);
export const DEFAULT_EXCLUDED_EXTENSIONS = Object.freeze(['.map','.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.gz','.tgz','.tar','.7z','.jar','.war','.class','.dll','.exe','.so','.dylib','.a','.o','.woff','.woff2','.ttf','.eot','.mp3','.mp4','.mov','.avi','.sqlite','.db']);
export const DEFAULT_MAX_FILE_BYTES = 1024*1024;
export const SKIP_DIRS = new Set(DEFAULT_EXCLUDED_DIRS);

// ---------------------------------------------------------------------------
// Scan-scope exclusions (default-on, explicitly overridable)
// ---------------------------------------------------------------------------
//
// WHY: a scan that walks vendored dependency trees, generated build output and
// duplicate worktree checkouts measures those trees, not the estate. Measured
// on a real 27-component estate, 56,947 of 60,174 graph nodes (94.6%) came
// from exactly those three categories, and the graph's single largest
// connected component was 98.65% one scanned Python virtualenv.
//
// CONTRACT (all of these are load-bearing):
//   * Categories are named GENERICALLY by what a directory IS (vendored
//     dependency / build artifact / duplicate worktree / tool-or-VCS
//     metadata). No product, company or repository name appears here.
//   * Every rule is DECLARED in this one table, so the active set is
//     inspectable (see describeScopeExclusions) rather than buried in
//     traversal code.
//   * The set is DEFAULT-ON and can be turned off per call
//     (`defaultScopeExclusions:false`, CLI `--no-default-scope-exclusions`),
//     which reproduces exactly the prior behaviour: only the legacy
//     DEFAULT_EXCLUDED_DIRS names plus the legacy `*.min.js` file rule apply.
//   * It COMPOSES WITH `.estate-mapignore` (estate-relative prefix
//     exclusion) rather than replacing it: both are consulted, independently.
//   * It is name/pattern based only: no file contents are read, no process is
//     spawned, no Git state is consulted, and nothing is executed. Matching is
//     deterministic and offline.
// Category names deliberately match tools/estate-map/analyze-connectivity.mjs's
// scan-scope vocabulary so exclusion accounting and connectivity attribution
// speak the same language.
export const SCOPE_EXCLUSION_CATEGORIES = Object.freeze({
  vendored_dependency: Object.freeze({
    description: 'third-party code installed into the tree by a package manager',
    dir_names: Object.freeze(['node_modules','bower_components','vendor','third_party','Pods','Carthage','site-packages','venv','.venv','virtualenv','.npm','.yarn','.pnpm-store']),
    dir_patterns: Object.freeze(['^\\.venv[-._].*$','^venv[-._].*$','^virtualenv[-._].*$']),
    file_suffixes: Object.freeze([]),
  }),
  build_artifact: Object.freeze({
    description: 'generated output produced from source by a build/compile/bundle step',
    // 'bin' removed: see the DEFAULT_EXCLUDED_DIRS note above. In Node/TS estates `bin/`
    // holds checked-in entrypoint SOURCE (npm `bin` field, `cdk init`'s bin/<app>.ts), not
    // build output. Generated content inside it is still caught by the `.d.ts` file suffix.
    dir_names: Object.freeze(['obj','dist','build','out','target','coverage','.next','.nuxt','DerivedData','__pycache__','.gradle','.terraform','.cache','.tmp']),
    dir_patterns: Object.freeze(['^cdk\\.out.*$']),
    file_suffixes: Object.freeze(['.min.js','.bundle.js','.d.ts']),
  }),
  duplicate_worktree: Object.freeze({
    description: 'an additional checkout of source already scanned at its primary path',
    dir_names: Object.freeze(['worktrees','.worktrees']),
    dir_patterns: Object.freeze([]),
    file_suffixes: Object.freeze([]),
  }),
  tool_or_vcs_metadata: Object.freeze({
    description: 'version-control, editor, or this tool\'s own output metadata — never source',
    dir_names: Object.freeze(['.git','.idea','.estate-map']),
    dir_patterns: Object.freeze([]),
    file_suffixes: Object.freeze([]),
  }),
});
// Legacy rules that were already active BEFORE the scope-exclusion set existed.
// These stay active even when the default set is disabled, so `disabled` means
// "reproduce prior behaviour", not "scan absolutely everything".
const LEGACY_FILE_SUFFIXES = Object.freeze(['.min.js']);
const compiledScopeRules = (() => {
  const dirs = [], files = [];
  for (const [category, spec] of Object.entries(SCOPE_EXCLUSION_CATEGORIES)) {
    for (const name of spec.dir_names) dirs.push({ category, rule: name, match: value => value === name });
    for (const pattern of spec.dir_patterns) { const regex = new RegExp(pattern); dirs.push({ category, rule: pattern, match: value => regex.test(value) }); }
    for (const suffix of spec.file_suffixes) files.push({ category, rule: `*${suffix}`, legacy: LEGACY_FILE_SUFFIXES.includes(suffix), match: value => value.endsWith(suffix) });
  }
  return { dirs, files };
})();

// The active exclusion set, as data. Used by --print-scope-exclusions and
// recorded in the run manifest so a reader can see WHAT was excluded and WHY
// without reading traversal code.
export function describeScopeExclusions({ defaultScopeExclusions = true, excludedDirs = DEFAULT_EXCLUDED_DIRS } = {}) {
  const baseline = new Set(excludedDirs);
  const categories = Object.fromEntries(Object.entries(SCOPE_EXCLUSION_CATEGORIES).map(([category, spec]) => [category, {
    description: spec.description,
    dir_names: spec.dir_names.filter(name => defaultScopeExclusions || baseline.has(name)),
    dir_patterns: defaultScopeExclusions ? [...spec.dir_patterns] : [],
    file_suffixes: spec.file_suffixes.filter(suffix => defaultScopeExclusions || LEGACY_FILE_SUFFIXES.includes(suffix)),
  }]));
  return {
    enabled: Boolean(defaultScopeExclusions),
    opt_out: '--no-default-scope-exclusions (extract.mjs) / { defaultScopeExclusions: false } (walk)',
    composes_with: ['.estate-mapignore (estate-relative prefix exclusion)', 'linked-worktree negative-only detection'],
    categories,
  };
}

// Classify a DIRECTORY name against the active set. Returns null when the
// directory is in scope. A name in the legacy DEFAULT_EXCLUDED_DIRS list is
// excluded whether or not the default set is enabled (prior behaviour); the
// returned category still names WHY, so accounting is complete either way.
export function classifyExcludedDirName(name, { defaultScopeExclusions = true, excludedDirs = DEFAULT_EXCLUDED_DIRS } = {}) {
  const baseline = new Set(excludedDirs);
  for (const rule of compiledScopeRules.dirs) {
    if (!rule.match(name)) continue;
    if (defaultScopeExclusions || baseline.has(name)) return { category: rule.category, rule: rule.rule, source: baseline.has(name) ? 'baseline' : 'scope-default' };
  }
  return baseline.has(name) ? { category: 'uncategorized_legacy', rule: name, source: 'baseline' } : null;
}

// Classify a FILE name against the active set (suffix rules only; extension
// exclusion stays with DEFAULT_EXCLUDED_EXTENSIONS).
export function classifyExcludedFileName(name, { defaultScopeExclusions = true } = {}) {
  for (const rule of compiledScopeRules.files) {
    if (!rule.match(name)) continue;
    if (defaultScopeExclusions || rule.legacy) return { category: rule.category, rule: rule.rule, source: rule.legacy ? 'baseline' : 'scope-default' };
  }
  return null;
}
// Classify an estate-relative PATH against the active exclusion set: every
// directory segment is tested as a directory name, and the final segment is
// tested both as a directory name (a specifier can denote a directory whose
// index file would be the target) and as a file name. Returns the first
// matching classification (with the concrete `segment` that matched) or null
// when nothing on the path was excluded from the scan.
//
// WHY this exists separately from classifyExcludedDirName/FileName: an
// unresolved relative import must be attributed honestly. A specifier whose
// target the scan-scope set deliberately removed (`../../node_modules/x`,
// `./types.d.ts`) has no node BY DESIGN and is not a resolution defect; the
// resolver needs a path-grained answer to say so.
export function classifyExcludedPath(estateRelativePath, { defaultScopeExclusions = true, excludedDirs = DEFAULT_EXCLUDED_DIRS } = {}) {
  const segments = normalizePath(String(estateRelativePath || '')).split('/').filter(segment => segment && segment !== '.' && segment !== '..');
  if (!segments.length) return null;
  const options = { defaultScopeExclusions, excludedDirs };
  for (let i = 0; i < segments.length - 1; i++) {
    const match = classifyExcludedDirName(segments[i], options);
    if (match) return { ...match, segment: segments[i] };
  }
  const last = segments[segments.length - 1];
  const asDir = classifyExcludedDirName(last, options);
  if (asDir) return { ...asDir, segment: last };
  const asFile = classifyExcludedFileName(last, { defaultScopeExclusions });
  return asFile ? { ...asFile, segment: last } : null;
}
// ---------------------------------------------------------------------------
// WITNESS PROVENANCE CLASS (path-derived, deterministic, offline)
// ---------------------------------------------------------------------------
//
// WHY. A witness is a `repo/file:line`, and a reader asking "who really emits
// `session.spawned`?" needs to know whether that line is a PRODUCTION producer
// or a Playwright fixture. Before this existed, the estate map's envelope-kind
// nodes carried whichever fact sorted first by `(repo, file, line)` — and
// `client/e2e/...` sorts before `src/...`, so the map's answer for
// `session.spawned` was an e2e spec while `src/app.mjs` went unmentioned. A
// reviewer had to hand-filter the graph before using it, which spends exactly
// the budget the instrument exists to save.
//
// CONTRACT.
//   * NOTHING IS DROPPED. A test/fixture/docs witness is CLASSIFIED, never
//     excluded: a kind declared only in a test is itself a finding the map
//     must be able to state. This is deliberately weaker than
//     entity-layer.mjs#isTestFact, which EXCLUDES test DDL because promoting
//     it would invent entities; here the same paths are labelled instead.
//   * PATH ONLY. No file contents are read, no heuristics over identifiers.
//     The class is a pure function of the estate-relative path, so two runs
//     agree and a reader can verify the class by looking at the path.
//   * ORDER IS PART OF THE CONTRACT. `fixture` is tested before `test`
//     because `client/e2e/work-explorer/fixtures/*.ts` is both, and the more
//     specific true statement is the one worth carrying.
export const PROVENANCE_CLASSES = Object.freeze(['production','test','fixture','docs']);
export const PROVENANCE_CLASS_RANK = Object.freeze(Object.fromEntries(PROVENANCE_CLASSES.map((value,index)=>[value,index])));
// `test-fixtures/` is this repo's real top-level fake-plugin tree
// (test-fixtures/plugins/test-plugin/server/index.mjs registers routes).
const FIXTURE_SEGMENT=/(?:^|\/)(?:fixtures?|__fixtures__|__mocks__|mocks|test-fixtures)(?:\/|$)/i;
const TEST_SEGMENT=/(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)(?:\/|$)/i;
const TEST_FILENAME=/\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const DOCS_SEGMENT=/(?:^|\/)(?:docs?|design|examples?)(?:\/|$)/i;
const DOCS_FILENAME=/\.mdx?$/i;
/** Estate-relative path for a witness: the component name joined onto its component-relative file. */
export const witnessPath=(repo,file)=>normalizePath(repo?`${repo}/${file||''}`:String(file||''));
export function classifyProvenance(repo,file){
  const estatePath=witnessPath(repo,file);
  if(FIXTURE_SEGMENT.test(estatePath))return'fixture';
  if(TEST_SEGMENT.test(estatePath)||TEST_FILENAME.test(estatePath))return'test';
  if(DOCS_SEGMENT.test(estatePath)||DOCS_FILENAME.test(estatePath))return'docs';
  return'production';
}
/** A witness with its class attached. Never mutates the input. */
export const classifiedProvenance=fact=>({repo:fact.repo,file:fact.file,line:fact.line,provenance_class:classifyProvenance(fact.repo,fact.file)});
/** Production first, then a stable (repo,file,line) order inside each class. */
export const compareWitnessProvenance=(a,b)=>
  (PROVENANCE_CLASS_RANK[a.provenance_class]??PROVENANCE_CLASSES.length)-(PROVENANCE_CLASS_RANK[b.provenance_class]??PROVENANCE_CLASSES.length)
  ||a.repo.localeCompare(b.repo)||a.file.localeCompare(b.file)||a.line-b.line;
/** Per-class counts over a witness list, always carrying every class (0 included). */
export const provenanceClassCounts=witnesses=>Object.fromEntries(PROVENANCE_CLASSES.map(value=>[value,witnesses.filter(item=>item.provenance_class===value).length]));

export const textExtensions = new Set(['.cs','.csproj','.js','.jsx','.mjs','.cjs','.ts','.tsx','.py','.json','.tf','.sql','.txt','.in','.toml']);
export const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export const stableStringify = value => JSON.stringify(stable(value), null, 2) + '\n';

// SHA-256 of stableStringify(value).trim() without materializing one giant string. This emits the
// exact sorted, two-space JSON bytes used by the existing canonical helpers; buffering is bounded
// to 1 MiB of characters so graph-scale states cannot exceed V8's maximum string length.
export function stableCanonicalSha256(value) {
  const hash = crypto.createHash('sha256');
  let chunks = [], characters = 0;
  const indents = [''];
  const indent = depth => {
    while (indents.length <= depth) indents.push(`${indents.at(-1)}  `);
    return indents[depth];
  };
  const flush = () => {
    if (chunks.length) hash.update(chunks.join(''));
    chunks = []; characters = 0;
  };
  const append = text => {
    chunks.push(text); characters += text.length;
    if (characters >= 1024 * 1024) flush();
  };
  const omittedObjectValue = held => ['undefined', 'function', 'symbol'].includes(typeof held);
  const write = (held, depth, arrayValue = false) => {
    if (Array.isArray(held)) {
      append('[');
      if (held.length) {
        append('\n');
        for (let index = 0; index < held.length; index += 1) {
          if (index) append(',\n');
          append(indent(depth + 1));
          write(held[index], depth + 1, true);
        }
        append(`\n${indent(depth)}`);
      }
      append(']');
      return;
    }
    if (held && typeof held === 'object') {
      const keys = Object.keys(held).sort().filter(key => !omittedObjectValue(held[key]));
      append('{');
      if (keys.length) {
        append('\n');
        keys.forEach((key, index) => {
          if (index) append(',\n');
          append(`${indent(depth + 1)}${JSON.stringify(key)}: `);
          write(held[key], depth + 1);
        });
        append(`\n${indent(depth)}`);
      }
      append('}');
      return;
    }
    const encoded = JSON.stringify(held);
    append(encoded === undefined ? (arrayValue ? 'null' : 'undefined') : encoded);
  };
  write(value, 0);
  flush();
  return hash.digest('hex');
}

// Write `${stableStringify(value).trim()}\n` to a file without materializing one giant string.
// The traversal deliberately mirrors stableCanonicalSha256 above byte for byte; both emit the
// exact sorted, two-space canonical JSON, one into a hash and one into a write stream.
export async function writeStableCanonical(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const stream = createWriteStream(file, { encoding: 'utf8' });
  try {
    let chunks = [], characters = 0;
    const indents = [''];
    const indent = depth => {
      while (indents.length <= depth) indents.push(`${indents.at(-1)}  `);
      return indents[depth];
    };
    const flush = async () => {
      if (chunks.length) await writeChunk(stream, chunks.join(''));
      chunks = []; characters = 0;
    };
    const pending = [];
    const append = text => { chunks.push(text); characters += text.length; };
    const omittedObjectValue = held => ['undefined', 'function', 'symbol'].includes(typeof held);
    const write = async (held, depth, arrayValue = false) => {
      if (characters >= 1024 * 1024) await flush();
      if (Array.isArray(held)) {
        append('[');
        if (held.length) {
          append('\n');
          for (let index = 0; index < held.length; index += 1) {
            if (index) append(',\n');
            append(indent(depth + 1));
            await write(held[index], depth + 1, true);
          }
          append(`\n${indent(depth)}`);
        }
        append(']');
        return;
      }
      if (held && typeof held === 'object') {
        const keys = Object.keys(held).sort().filter(key => !omittedObjectValue(held[key]));
        append('{');
        if (keys.length) {
          append('\n');
          for (const [index, key] of keys.entries()) {
            if (index) append(',\n');
            append(`${indent(depth + 1)}${JSON.stringify(key)}: `);
            await write(held[key], depth + 1);
          }
          append(`\n${indent(depth)}`);
        }
        append('}');
        return;
      }
      const encoded = JSON.stringify(held);
      append(encoded === undefined ? (arrayValue ? 'null' : 'undefined') : encoded);
    };
    await write(value, 0);
    append('\n');
    await flush();
    stream.end();
    await once(stream, 'finish');
  } catch (error) { stream.destroy(); throw error; }
}

export const factKey = fact => [fact.kind,fact.repo,fact.file,String(fact.line).padStart(9,'0'),JSON.stringify(stable(fact))].join('\0');
export const normalizePath = value => value.split(path.sep).join('/');
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive:true }); await fs.writeFile(file, stableStringify(value)); }
async function writeChunk(stream,chunk){if(!stream.write(chunk))await once(stream,'drain');}
export async function writeJsonLines(file,values){
  await fs.mkdir(path.dirname(file),{recursive:true});const stream=createWriteStream(file,{encoding:'utf8'});
  try{for(const value of values)await writeChunk(stream,JSON.stringify(value)+'\n');stream.end();await once(stream,'finish');}catch(error){stream.destroy();throw error;}
}
export async function writeJsonArray(file,values){
  await fs.mkdir(path.dirname(file),{recursive:true});const stream=createWriteStream(file,{encoding:'utf8'});
  try{await writeChunk(stream,'[\n');let first=true;for(const value of values){await writeChunk(stream,(first?'':'\n,')+JSON.stringify(stable(value)));first=false;}await writeChunk(stream,'\n]\n');stream.end();await once(stream,'finish');}catch(error){stream.destroy();throw error;}
}
// Bounded, native-read-only classifier for a directory's `.git` FILE (never a
// `.git` directory, which is ordinary VCS metadata handled by the excluded-dir
// list below). A linked Git worktree marks its checkout root with a `.git`
// file whose sole content is `gitdir: <path>/.git/worktrees/<name>`, pointing
// back into the primary repository's administrative area. That pointer is
// NEGATIVE-ONLY evidence: it identifies a directory to EXCLUDE (the linked
// worktree is a full duplicate checkout of source already scanned at its
// primary location), never a signal to include, create a component, or
// otherwise trust file contents. Detection reads at most
// MAX_GITDIR_POINTER_BYTES bytes and never spawns `git` or any other process.
// Returns the resolved worktree-admin directory when `absolute` is a valid
// linked-worktree checkout root, or `null` for: no `.git` file, a `.git`
// directory (ordinary repository), an oversized or unreadable `.git` file, a
// `.git` file that does not parse as a single `gitdir: <path>` line, or a
// `.git` file whose target does not resolve under a `.git/worktrees/<name>`
// path (this also covers ORDINARY non-worktree `.git` files, e.g. a
// submodule's `gitdir: ../.git/modules/<name>` pointer, which must not be
// treated as worktree exclusion). Structural presence of the admin
// directory's `gitdir`/`commondir`/`HEAD`/`index` files is not sufficient:
// each is validated against its real Git-producer SHAPE (a parseable
// backpointer/commondir line, a ref-or-oid HEAD, a DIRC-magic index header),
// and the primary common `.git` the pointer resolves to must itself carry
// meaningful repository state (a valid HEAD and a `[core]`-sectioned
// config) -- so a fabricated admin directory with arbitrary nonempty bytes
// in self-consistent-looking files fails open rather than pruning the
// candidate as a duplicate.
const MAX_GITDIR_POINTER_BYTES = 1024;
// A real Git config file's `[core]` section is always written FIRST by
// `git init`; later `git remote add` / branch-tracking entries are
// APPENDED after it. A long-lived, actively-developed repo's config can
// legitimately grow well past a few KB (many remotes/branch entries), so
// checking for `[core]` requires reading only a small, fixed PREFIX of the
// file -- never the whole thing, and never gated by the file's total size.
const CONFIG_HEAD_BYTES = 512;
const GITDIR_POINTER_PATTERN = /^gitdir:[ \t]+([^\r\n]+?)[ \t]*(?:\r?\n)?$/;
const WORKTREE_ADMIN_PATTERN = /\/\.git\/worktrees\/[^/]+$/;
// Real Git HEAD files hold exactly one of two shapes: a symbolic ref
// (`ref: refs/heads/<name>`) or a detached-HEAD object id (40 lowercase hex
// chars for SHA-1, 64 for SHA-256). Arbitrary nonempty bytes -- e.g. a
// fabricated HEAD written by hand -- match neither shape and must fail open.
const HEAD_REF_PATTERN = /^ref: refs\/\S+$/;
const HEAD_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A real Git config file (e.g. the common repository's `.git/config`,
// written by `git init`) always opens with a `[core]` section, optionally
// preceded by blank lines or `#`/`;` comments. This is meaningful
// common-repository state -- structurally distinct from a fabricated empty
// or arbitrary-bytes file -- read only to invalidate, never to include.
const CONFIG_CORE_SECTION_PATTERN = /^(?:[ \t]*(?:[#;][^\r\n]*)?\r?\n)*[ \t]*\[core\]/i;
// Real Git index files (`.git/index`, and per-worktree `.git/worktrees/<n>/index`)
// open with a 12-byte header: 4-byte `DIRC` signature, 4-byte big-endian
// version (2, 3, or 4), 4-byte entry count. Reading only these 12 bytes
// (never the whole file, which can be arbitrarily large) is enough to reject
// arbitrary fabricated bytes without ever parsing tracked-file content.
const GIT_INDEX_MAGIC = Buffer.from('DIRC', 'ascii');
const GIT_INDEX_HEADER_BYTES = 12;
const GIT_INDEX_VERSIONS = new Set([2, 3, 4]);
async function readBoundedMetadataFile(file, maxBytes = MAX_GITDIR_POINTER_BYTES) {
  let stat;
  try { stat = await fs.lstat(file); } catch { return null; }
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}
function singleMetadataLine(content) {
  if (content === null || !/^[^\r\n]+(?:\r?\n)?$/.test(content)) return null;
  return content.replace(/\r?\n$/, '');
}
function isValidHeadContent(content) {
  const line = singleMetadataLine(content);
  return line !== null && (HEAD_REF_PATTERN.test(line) || HEAD_OID_PATTERN.test(line));
}
async function hasValidRepositoryHead(gitdir) {
  return isValidHeadContent(await readBoundedMetadataFile(path.join(gitdir, 'HEAD')));
}
// Bounded native read of AT MOST the first `length` bytes of a file, via a
// file handle rather than fs.readFile, so a file of arbitrary real-world
// size (a large config with many remotes, a multi-hundred-KB index) is
// never loaded in full -- only a fixed-size prefix is inspected. Returns
// fewer bytes than `length` when the file itself is shorter (never an
// error: a short file is simply read in full).
async function readBoundedPrefixBytes(file, length) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const toRead = Math.min(length, stat.size);
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    return buffer.subarray(0, bytesRead);
  } catch { return null; }
  finally { await handle.close(); }
}
async function hasMeaningfulConfig(gitdir) {
  const header = await readBoundedPrefixBytes(path.join(gitdir, 'config'), CONFIG_HEAD_BYTES);
  return header !== null && CONFIG_CORE_SECTION_PATTERN.test(header.toString('utf8'));
}
// Exact-length bounded native read of a file's first `length` bytes, used
// where the header has a fixed byte layout (the Git index's 12-byte DIRC
// header) and a short read means the header itself is malformed/truncated.
async function readBoundedHeaderBytes(file, length) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < length) return null;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return bytesRead === length ? buffer : null;
  } catch { return null; }
  finally { await handle.close(); }
}
async function hasValidIndexHeader(file) {
  const header = await readBoundedHeaderBytes(file, GIT_INDEX_HEADER_BYTES);
  if (!header || !header.subarray(0, 4).equals(GIT_INDEX_MAGIC)) return false;
  return GIT_INDEX_VERSIONS.has(header.readUInt32BE(4));
}
export async function linkedWorktreeGitdir(absolute) {
  const gitPath = path.join(absolute, '.git');
  const content = await readBoundedMetadataFile(gitPath);
  const match = content === null ? null : GITDIR_POINTER_PATTERN.exec(content);
  if (!match) return null;
  const gitdir = path.resolve(absolute, match[1]);
  if (!WORKTREE_ADMIN_PATTERN.test(normalizePath(gitdir))) return null;
  try { if (!(await fs.lstat(gitdir)).isDirectory()) return null; } catch { return null; }

  // A suffix-shaped directory is not enough: real linked-worktree admin state
  // points back to this exact checkout marker and to its primary `.git`, and
  // carries the HEAD/index files Git uses for the checkout. Validate that
  // producer shape with bounded native reads so malformed or fabricated
  // pointers fail open (the candidate remains scannable). Structural
  // presence of `HEAD`/`index` is not enough on its own -- a fabricated
  // admin directory can carry arbitrary nonempty bytes in both -- so their
  // CONTENT must match the real Git-produced shape (ref/oid HEAD; DIRC-magic
  // index header) before this pointer is trusted as exclusion evidence.
  const backpointer = singleMetadataLine(await readBoundedMetadataFile(path.join(gitdir, 'gitdir')));
  const commondir = singleMetadataLine(await readBoundedMetadataFile(path.join(gitdir, 'commondir')));
  if (!backpointer || !commondir) return null;
  if (!(await hasValidRepositoryHead(gitdir))) return null;
  if (!(await hasValidIndexHeader(path.join(gitdir, 'index')))) return null;

  const commonGitdir = path.resolve(gitdir, commondir);
  const expectedCommonGitdir = path.dirname(path.dirname(gitdir));
  if (path.basename(commonGitdir) !== '.git' || commonGitdir !== expectedCommonGitdir) return null;
  // The pointer's own admin bytes can be forged in isolation, but a real
  // linked worktree's primary `.git` carries its OWN meaningful
  // common-repository state -- a valid HEAD and a `[core]`-sectioned config
  // -- that a fabricated common-gitdir path (pointing at an empty or
  // nonexistent directory dressed up to look like `.git`) will not have.
  // This is still negative-only evidence: it can only fail the exclusion,
  // never grant inclusion or grouping.
  if (!(await hasValidRepositoryHead(commonGitdir))) return null;
  if (!(await hasMeaningfulConfig(commonGitdir))) return null;
  try {
    const [markerRealpath, backpointerRealpath] = await Promise.all([
      fs.realpath(gitPath),
      fs.realpath(path.resolve(gitdir, backpointer)),
    ]);
    if (markerRealpath !== backpointerRealpath) return null;
  } catch { return null; }
  return gitdir;
}

// .estate-mapignore: an optional estate-root file of estate-relative PATH
// PREFIXES, one per line, `#`-prefixed and blank lines ignored. A path is
// excluded when it equals a prefix or starts with `<prefix>/`. Independent of
// Git ignore syntax (no globs, no negation) and deliberately cannot escape
// the estate root: `..` segments, absolute paths, and empty-after-normalize
// lines are rejected line-by-line rather than failing the whole file.
export async function readEstateMapIgnore(estateRoot) {
  let text;
  try { text = await fs.readFile(path.join(estateRoot, '.estate-mapignore'), 'utf8'); } catch { return []; }
  const prefixes = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = normalizePath(line).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) continue;
    prefixes.push(normalized);
  }
  return [...new Set(prefixes)].sort((a, b) => a.localeCompare(b));
}
export function isIgnoredPath(estateRelativePath, ignorePrefixes) {
  if (!ignorePrefixes || !ignorePrefixes.length) return false;
  const normalized = normalizePath(estateRelativePath);
  return ignorePrefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export async function walk(root,{excludedDirs=DEFAULT_EXCLUDED_DIRS,excludedExtensions=DEFAULT_EXCLUDED_EXTENSIONS,maxFileBytes=DEFAULT_MAX_FILE_BYTES,sampleCap=100,ignorePrefixes=[],estateRelativeRoot='',defaultScopeExclusions=true}={}) {
  const files=[];let skipped=0;const skipCounts={},skipSamples=[];const extensionSet=new Set(excludedExtensions);
  const scopeOptions={defaultScopeExclusions,excludedDirs};
  // Exclusion accounting: counts per generic category plus per concrete rule,
  // so a run reports WHAT was excluded and WHY instead of silently shrinking
  // the graph. Samples are bounded by the same sampleCap as skip samples.
  const scopeExclusions={counts:{},rules:{},samples:[]};
  const record=(reason,file)=>{skipped++;skipCounts[reason]=(skipCounts[reason]||0)+1;if(skipSamples.length<sampleCap)skipSamples.push({reason,file:normalizePath(path.relative(root,file))});};
  const recordScope=(classification,absolute)=>{
    const {category,rule,source}=classification;
    scopeExclusions.counts[category]=(scopeExclusions.counts[category]||0)+1;
    const key=`${category}:${rule}`;scopeExclusions.rules[key]=(scopeExclusions.rules[key]||0)+1;
    if(scopeExclusions.samples.length<sampleCap)scopeExclusions.samples.push({category,rule,source,path:normalizePath(path.relative(root,absolute))});
  };
  const estateRelative=absolute=>{const relative=normalizePath(path.relative(root,absolute));return estateRelativeRoot?`${estateRelativeRoot}/${relative}`:relative;};
  const ignored=absolute=>isIgnoredPath(estateRelative(absolute),ignorePrefixes);
  async function excludeWorktreeContainer(container,classification) {
    let entries;
    try { entries=(await fs.readdir(container,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)); }
    catch { record('excluded-directory',container); recordScope(classification,container); return; }
    if (!entries.length) { record('excluded-directory',container); recordScope(classification,container); return; }
    for (const entry of entries) {
      const absolute=path.join(container,entry.name);
      if (entry.isDirectory()&&await linkedWorktreeGitdir(absolute)) { record('linked-worktree',absolute); recordScope({category:'duplicate_worktree',rule:'linked-worktree .git pointer',source:'negative-only-git-evidence'},absolute); }
      else { record('excluded-directory',absolute); recordScope(classification,absolute); }
    }
  }
  async function visit(dir) {
    const entries=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute=path.join(dir,entry.name),extension=path.extname(entry.name).toLowerCase();
      if (entry.isSymbolicLink()) { record('symlink',absolute); continue; }
      if (entry.isDirectory()) {
        const excludedDir=classifyExcludedDirName(entry.name,scopeOptions);
        // A worktree CONTAINER (`worktrees/`, `.worktrees/`) holds one
        // checkout per child. Its children are enumerated -- but never
        // descended into -- so the stronger negative-only Git evidence (a
        // linked-worktree `.git` pointer) is still recorded per checkout where
        // it exists. Every child is excluded either way; only the reported
        // reason differs, and the most specific true reason is kept.
        if (excludedDir&&excludedDir.category==='duplicate_worktree'){
          if (await linkedWorktreeGitdir(absolute)) { record('linked-worktree',absolute); recordScope({category:'duplicate_worktree',rule:'linked-worktree .git pointer',source:'negative-only-git-evidence'},absolute); }
          else await excludeWorktreeContainer(absolute,excludedDir);
        }
        else if (excludedDir){if(entry.name==='.terraform'){const environment=path.join(absolute,'environment');try{if((await fs.stat(environment)).size<=maxFileBytes)files.push(environment);}catch{}}record('excluded-directory',absolute);recordScope(excludedDir,absolute);}
        // .estate-mapignore composes with (never replaces) the scope set: an
        // ignore prefix still excludes a directory the scope set admits.
        else if (ignored(absolute)) { record('estate-mapignore',absolute); recordScope({category:'estate_mapignore',rule:'.estate-mapignore prefix',source:'ignore-file'},absolute); }
        else if (await linkedWorktreeGitdir(absolute)) { record('linked-worktree',absolute); recordScope({category:'duplicate_worktree',rule:'linked-worktree .git pointer',source:'negative-only-git-evidence'},absolute); }
        else await visit(absolute);
      }
      else if (entry.isFile()) {
        if (ignored(absolute)) { record('estate-mapignore',absolute); recordScope({category:'estate_mapignore',rule:'.estate-mapignore prefix',source:'ignore-file'},absolute); continue; }
        const excludedFile=classifyExcludedFileName(entry.name,scopeOptions);
        if(excludedFile||extensionSet.has(extension)){record('excluded-file',absolute);if(excludedFile)recordScope(excludedFile,absolute);continue;}
        const stat=await fs.stat(absolute);if(stat.size>maxFileBytes){record('skipped-large',absolute);continue;}
        if (textExtensions.has(extension) || ['package.json','requirements.txt','pyproject.toml'].includes(entry.name) || (entry.name==='environment'&&path.basename(dir)==='.terraform')) files.push(absolute); else record('unsupported-file',absolute);
      }
    }
  }
  await visit(root); return { files, skipped,skipCounts,skipSamples,scopeExclusions };
}

export function provenance(fact) { return { repo:fact.repo,file:fact.file,line:fact.line }; }
export function parseArgs(argv) {
  const positional=[]; const options={};
  for (let i=0;i<argv.length;i++) { const arg=argv[i]; if (arg.startsWith('--')) { const key=arg.slice(2); if (['help','json','seams','allow-partial','strict','no-default-scope-exclusions','print-scope-exclusions'].includes(key)) options[key]=true; else options[key]=argv[++i]; } else positional.push(arg); }
  return { positional, options };
}
export function routeRegex(route) {
  const escaped=route.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\\\{[^}]+\\\}/g,'[^/]+').replace(/:[A-Za-z_][\w]*/g,'[^/]+');
  return new RegExp(`^${escaped}/?$`,'i');
}
export function normalizedUrlPath(value) { try { return new URL(value).pathname; } catch { return value.startsWith('/') ? value.split('?')[0] : `/${value.split('?')[0]}`; } }
