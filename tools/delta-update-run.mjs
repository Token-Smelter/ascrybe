#!/usr/bin/env node
// `ascrybe update` — docs/delta-updatable-estate-maps.md "Operator command contract".
//
// This is the production caller that makes tools/delta/ load-bearing: it imports
// tools/delta/planner.mjs, tools/delta/manifest.mjs, tools/delta/equivalence.mjs, and
// tools/delta/scope-refusals.mjs, and plans a REAL extraction over a REAL Git-backed repository
// using PER-UNIT identity and PER-UNIT cache reuse (tools/delta/unit-cache.mjs, keyed by
// payload_unit_id) — never by whole-estate Git head. tools/extraction-cache.mjs's
// buildExtractionCacheBinding/extractionCacheBindingForInputs (whole-estate-head keying) is a
// separate, pre-existing, UNMODIFIED module used by tools/code-grounded-assertions.mjs's paid-claim
// cache; this command does not call it and does not gate on it.
//
// SHARED PATH. The extractor registry (redaction, document classification, ctx construction,
// extractor_contract_dependencies including a TRANSITIVE implementation_digest) is built by
// tools/file-extraction-adapter.mjs buildExtractionRegistry() — the SAME function tools/extract.mjs
// calls for the ordinary CLI/extractEstate() path. This replaced a prior version of this file that
// duplicated redaction/ctx construction by hand and hashed only `extractor.scan.toString()`,
// missing every helper the extractor imports or closes over. Ref resolution now happens ONCE per
// `ascrybe update` invocation (resolveEstateInventory below), shared by the primary (delta/full)
// arm and the full-mode equivalence-oracle arm, so a mutable ref (a branch, not a fixed SHA) cannot
// resolve to two different commits across the two arms of one "same immutable inputs" comparison —
// a prior version of this file called planEstateUpdate() twice, each independently re-resolving and
// re-fetching. repositoryInventory() also now applies the SAME name/pattern scan-scope exclusions
// (tools/lib.mjs classifyExcludedPath) the ordinary extract CLI applies via walk() — a prior version
// planned every git-tracked regular blob, including vendored dependencies and build artifacts.
//
// SCOPE PARITY (this revision). Two more divergences from the ordinary path are now closed:
//   - `.estate-mapignore` IS applied, read via Git plumbing (`git cat-file blob` on whatever OID
//     `git ls-tree` already reported for that path, if the ref tracks one) rather than a working-
//     tree read — same file, same tools/lib.mjs#parseEstateMapIgnoreLines rule, same
//     tools/lib.mjs#isIgnoredPath prefix match the ordinary walk() uses, applied per declared
//     repository at that repository's own root (this command has no single shared "estate root"
//     the way a materialized multi-repository estate does — each declared repository is its own
//     independent Git checkout+ref, so each gets its own `.estate-mapignore` read from its own
//     tree, which is the direct per-repository analogue of the ordinary single-repository case).
//   - `catalog_globs` now defaults to the resolved runtime config's own `catalog_globs` field
//     (`bin/ascrybe.mjs` marks this verb `config: true`, so it auto-injects `--runtime-config`
//     from the caller's `ascrybe.config.json`, exactly like every other estate-facing verb) —
//     closing the divergence a hardcoded `[]` default left open. No config file at that resolved
//     path is not an error (this command still needs no live estate to run); a present-but-invalid
//     one still refuses. `--catalog-globs <path>` names a standalone JSON array file directly and
//     overrides the runtime config — both share tools/ascrybe-config.mjs#validateCatalogGlobs.
//     Omitted entirely (no runtime config, no flag): `[]`, exactly as before either existed.
// Neither fix touches blob identity: this command still supplies the real Git blob OID as its file
// identity (docs/delta-updatable-estate-maps.md's file `payload_scope`), while the ordinary path's
// `prepareFileEntry` still computes `content:<sha256>` for its own cache keying — a deliberately
// separate axis from scope/routing parity (confirmed, coordinating with the ontology sidecar
// session, not to bear on entity node_id: tools/identity-candidate-generator.mjs and
// tools/referent-identity.mjs never reference either transport).
//
// SCOPE. This command implements the FILE-scope half of the design only, per
// docs/delta-file-scope-implementation-status.md:
//   - repository-scope units, global-scope units, deterministic migration, rename continuity, and
//     paid-answer/campaign reuse remain explicit typed refusals (tools/delta/scope-refusals.mjs).
//   - `--promote` is ALWAYS a typed refusal (requestAscrybeUpdateProjectionPublish below). This
//     command never stages a working generation, never runs CAS, never touches GC/lease/retention,
//     and never imports tools/estate-graph-projection.mjs — nothing here can change what a
//     `selected` or `working` generation serves.
//
// INVENTORY. A "repository" is read through Git plumbing only (`git ls-tree`, `git cat-file blob`)
// against an exact ref — never the working tree, never `git checkout`. It reproduces
// tools/extract.mjs's filesystem walk() scan-scope exclusions AND `.estate-mapignore` exactly
// (both applied in repositoryInventory() above); with `--catalog-globs` given the same array the
// ordinary path's runtime config declares, the two paths route the SAME files for the SAME input.
// What Git tracked at that ref is otherwise unfiltered — restricted to regular blobs (mode
// 100644/100755); a symlink or submodule/gitlink is never turned into a file-scope unit (that would
// misrepresent it, ./CONTRIBUTING.md "exactness beats completeness"), but an absence must be
// counted and named, never silent: every such entry is recorded in `non-regular-entries.json`
// (repository, path, mode, target) -- the target commit for a gitlink, the link text for a
// symlink. `blob_oid` is Git's own object id from `ls-tree`, never
// recomputed; `content_sha256` is an independent SHA-256 over the fetched blob bytes
// (docs/delta-updatable-estate-maps.md's file `payload_scope` names both).
//
// REGISTRY. Each entry of tools/extractors/index.mjs's real extractor array becomes one delta
// route: `matches()` is the extractor's own `filePattern`; `produce()` runs the SAME
// `extractor.scan(lines, ctx)` the whole-estate path runs, after the SAME secret redaction
// (transcribed from tools/extract.mjs) and the SAME tools/document-mode.mjs classification for
// `.md`/`.mdx`. `extractor_contract_dependencies.implementation_digest` hashes the extractor's own
// `filePattern`/`scan` source text, so an edit to an extractor's behavior invalidates every cached
// unit routed to it, exactly as docs/delta-updatable-estate-maps.md's "Extractor evolution" table
// requires ("Implementation digest moves; reuse requires proven compatibility or re-extraction").
//
// `producer_local_key` is index-based: none of tools/extractors/*.mjs authors a stable per-record
// key today (docs/delta-updatable-estate-maps.md: "If no unique key exists... it must not guess a
// match"). An index is deterministic across a rerun of the SAME bytes (extractor.scan is a pure
// function of its lines/ctx) but confers no continuity across an edit that reorders a file's facts
// — a named limitation, not a guessed one.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  classifyExcludedPath, isIgnoredPath, normalizePath, parseEstateMapIgnoreLines, sha256, stableStringify,
} from './lib.mjs';
import { validateCatalogGlobs, validateSourceRepositories } from './ascrybe-config.mjs';
import {
  DEFAULT_MAX_SUBMODULE_DEPTH, GITLINK_MODE, GITLINK_UNREGISTERED_CODE, SUBMODULE_CYCLE_CODE,
  SUBMODULE_DEPTH_EXCEEDED_CODE, SUBMODULE_UNAVAILABLE_CODE, parseGitmodulesText,
  resolveSubmoduleRepository, submoduleCommitPresent,
} from './git-submodule-resolution.mjs';
import { buildExtractionRegistry, extractionTelemetry, planFileScopeExtraction, prepareFileEntry } from './file-extraction-adapter.mjs';
import { assembleEstateBuildManifest } from './delta/manifest.mjs';
import { compareFullAndDeltaBuilds, DELTA_FULL_MISMATCH_CODE } from './delta/equivalence.mjs';
import { requestAscrybeUpdateProjectionPublish } from './delta/scope-refusals.mjs';

const canonical = value => stableStringify(value).trim();

export function updateError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// Redaction, document-mode classification, and the extractor registry itself now live in
// tools/file-extraction-adapter.mjs — the ONE copy this module and tools/extract.mjs both call.

// Test-only seam (see tests/delta-ref-resolution-once.test.mjs): the real implementation always
// spawns `git`. Swapping this out lets a test count invocations without monkeypatching
// node:child_process's module-namespace bindings.
let gitRunner = (gitDir, args) => execFileSync('git', ['-C', gitDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export function __setGitRunnerForTests(fn) { gitRunner = fn; }
export function __resetGitRunnerForTests() {
  gitRunner = (gitDir, args) => execFileSync('git', ['-C', gitDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function git(gitDir, args) { return gitRunner(gitDir, args); }

const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';

/** Every tree entry Git tracks at `ref`, split three ways: regular blobs (become file-scope
 * units), gitlinks (a declared, resolvable submodule's inventory is folded in below by recursion;
 * an undeclared or unresolvable one is named, never guessed at), and symlinks (never a unit --
 * exactness beats completeness, ./CONTRIBUTING.md -- but never silently dropped either: every one
 * is named in `non_regular_entries` below). */
function listTree(gitDir, ref) {
  const output = git(gitDir, ['ls-tree', '-r', '--full-tree', ref]);
  const entries = output.split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, , oid] = line.slice(0, tab).split(' ');
    return { mode, oid, path: normalizePath(line.slice(tab + 1)) };
  });
  return {
    files: entries.filter(entry => REGULAR_FILE_MODES.has(entry.mode)),
    gitlinks: entries.filter(entry => entry.mode === GITLINK_MODE),
    symlinks: entries.filter(entry => entry.mode === SYMLINK_MODE),
  };
}

/** A gitlink's `ls-tree` oid IS the target commit sha directly (no blob to read). A symlink's blob
 * content IS its link text. Any other non-regular mode (none observed in practice) falls back to
 * `null` rather than guessing what "target" means for it -- an honest absence, not a wrong value. */
function nonRegularEntryTarget(gitDir, entry) {
  if (entry.mode === GITLINK_MODE) return entry.oid;
  if (entry.mode === SYMLINK_MODE) return git(gitDir, ['cat-file', 'blob', entry.oid]).toString('utf8').trim();
  return null;
}

function withPrefix(path, prefix) { return prefix ? `${prefix}/${path}` : path; }

/** The SAME `.estate-mapignore` a live checkout's root would carry, read from Git plumbing instead:
 * find it in an already-fetched tree listing (no second `ls-tree`), fetch its blob if tracked, and
 * parse it with the identical rule `tools/lib.mjs#readEstateMapIgnore` applies. Absent entirely
 * (never tracked at this ref) is `[]`, exactly like a live checkout with no such file. */
function gitEstateMapIgnorePrefixes(gitDir, entries) {
  const found = entries.find(entry => entry.path === '.estate-mapignore');
  if (!found) return [];
  return parseEstateMapIgnoreLines(git(gitDir, ['cat-file', 'blob', found.oid]));
}

/** The SAME `.gitmodules` a live checkout's root would carry, read from Git plumbing instead: find
 * it in the already-fetched file listing, fetch its blob if tracked, and parse it with the shared
 * rule tools/git-submodule-resolution.mjs#parseGitmodulesText applies for the materialize path too
 * -- one implementation, one place it lives. Absent entirely is an empty declaration map, exactly
 * like a tree with no submodules at all. */
function gitmodulesDeclaration(gitDir, fileEntries) {
  const found = fileEntries.find(entry => entry.path === '.gitmodules');
  if (!found) return new Map();
  return parseGitmodulesText(git(gitDir, ['cat-file', 'blob', found.oid]));
}

/** One repository's content-addressed inventory at one ref, with the SAME name/pattern scan-scope
 * exclusions (tools/lib.mjs classifyExcludedPath) AND the SAME `.estate-mapignore` prefix
 * exclusions (tools/lib.mjs isIgnoredPath) the ordinary extract CLI's walk() applies — vendored
 * dependencies, build artifacts, duplicate worktrees, VCS/tool metadata, and anything the
 * repository's own `.estate-mapignore` names never become delta units, exactly as they never
 * become ordinary-scan units. `withContent` also runs the ONE shared redaction/document-
 * classification pass (tools/file-extraction-adapter.mjs prepareFileEntry) so `produce()` can run
 * extractors without re-deriving either; the pure diff/parent inventory never needs it. */
function repositoryInventory(repository, gitDir, ref, {
  withContent, sourceRepositories = {}, maxSubmoduleDepth = DEFAULT_MAX_SUBMODULE_DEPTH,
  depth = 0, visitedNames = [], pathPrefix = '',
}) {
  const { files: fileEntries, gitlinks: gitlinkEntries, symlinks: symlinkEntries } = listTree(gitDir, ref);
  const ignorePrefixes = gitEstateMapIgnorePrefixes(gitDir, fileEntries);
  const excludedPaths = [];
  const files = [];
  for (const entry of fileEntries) {
    const exclusion = classifyExcludedPath(entry.path);
    const prefixedPath = withPrefix(entry.path, pathPrefix);
    if (exclusion) { excludedPaths.push({ path: prefixedPath, ...exclusion }); continue; }
    if (isIgnoredPath(entry.path, ignorePrefixes)) {
      excludedPaths.push({ path: prefixedPath, category: 'estate_mapignore',
        rule: ignorePrefixes.find(prefix => entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
        source: '.estate-mapignore' });
      continue;
    }
    const text = git(gitDir, ['cat-file', 'blob', entry.oid]);
    const base = { repository, normalized_path: prefixedPath, blob_oid: entry.oid };
    files.push(withContent ? prepareFileEntry({ ...base, text, document_path: prefixedPath }) : { ...base, content_sha256: sha256(text) });
  }

  // Every symlink is named here and NEVER becomes a unit, unconditionally -- unlike a gitlink,
  // resolving something differently could never change that (tools/CONTRIBUTING.md "exactness
  // beats completeness"; see nonRegularEntryTarget()'s doc comment above).
  const nonRegular = symlinkEntries.map(entry => ({
    path: withPrefix(entry.path, pathPrefix), mode: entry.mode, target: nonRegularEntryTarget(gitDir, entry),
  }));

  if (gitlinkEntries.length) {
    const nameByPath = gitmodulesDeclaration(gitDir, fileEntries);
    for (const link of gitlinkEntries) {
      const declaredName = nameByPath.get(link.path) || null;
      const prefixedPath = withPrefix(link.path, pathPrefix);
      // The gitlink's OWN tree entry is never itself a file-scope unit, whether or not it resolves
      // and recurses below -- named here unconditionally, exactly like a symlink, alongside the
      // richer excluded_paths diagnostic (below) that says WHY it could or couldn't be expanded.
      nonRegular.push({ path: prefixedPath, mode: link.mode, target: nonRegularEntryTarget(gitDir, link) });
      if (!declaredName) {
        excludedPaths.push({ path: prefixedPath, category: 'gitlink', code: GITLINK_UNREGISTERED_CODE,
          target_commit: link.oid, source: 'git_tree_entry' });
        continue;
      }
      if (visitedNames.includes(declaredName)) {
        excludedPaths.push({ path: prefixedPath, category: 'gitlink', code: SUBMODULE_CYCLE_CODE,
          target_commit: link.oid, submodule_name: declaredName, source: '.gitmodules' });
        continue;
      }
      if (depth >= maxSubmoduleDepth) {
        excludedPaths.push({ path: prefixedPath, category: 'gitlink', code: SUBMODULE_DEPTH_EXCEEDED_CODE,
          target_commit: link.oid, submodule_name: declaredName, source: '.gitmodules' });
        continue;
      }
      const resolved = resolveSubmoduleRepository({
        parentRepository: gitDir, name: declaredName, path: link.path, sourceRepositories,
      });
      if (!resolved || !submoduleCommitPresent(resolved.repository, link.oid)) {
        excludedPaths.push({ path: prefixedPath, category: 'gitlink', code: SUBMODULE_UNAVAILABLE_CODE,
          target_commit: link.oid, submodule_name: declaredName, source: '.gitmodules' });
        continue;
      }
      const nested = repositoryInventory(repository, resolved.repository, link.oid, {
        withContent, sourceRepositories, maxSubmoduleDepth,
        depth: depth + 1, visitedNames: [...visitedNames, declaredName], pathPrefix: prefixedPath,
      });
      files.push(...nested.files);
      excludedPaths.push(...nested.excluded_paths);
      nonRegular.push(...nested.non_regular_entries);
    }
  }

  return {
    files, excluded_paths: excludedPaths.sort((left, right) => left.path.localeCompare(right.path)),
    non_regular_entries: nonRegular.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * Resolve every declared repository's ref to an exact pin and fetch its complete current
 * inventory ONCE. `sealUpdate` calls this a single time per `ascrybe update` invocation and reuses
 * the result for both the primary (delta/full) arm and the full-mode equivalence-oracle arm — a
 * prior version of this file called `planEstateUpdate` (which itself resolved+fetched) once per
 * arm, so a mutable ref could resolve to two different commits across one "same immutable inputs"
 * comparison, and every file was fetched from Git twice for no reason when equivalence ran.
 */
export function resolveEstateInventory(pinManifest, { sourceRepositories = {} } = {}) {
  if (!pinManifest?.repositories || typeof pinManifest.repositories !== 'object') {
    throw updateError('DELTA_UPDATE_PIN_MANIFEST_INVALID', 'pin-manifest requires a non-empty "repositories" map');
  }
  const currentInventory = [];
  const pins = {};
  const excludedPaths = [];
  const nonRegularEntries = [];
  for (const [repository, declaration] of Object.entries(pinManifest.repositories)) {
    if (!declaration?.path || !declaration?.ref) {
      throw updateError('DELTA_UPDATE_PIN_MANIFEST_INVALID', `repository "${repository}" requires "path" and "ref"`);
    }
    const resolvedPin = git(declaration.path, ['rev-parse', declaration.ref]).trim();
    pins[repository] = resolvedPin;
    const inventory = repositoryInventory(repository, declaration.path, resolvedPin, { withContent: true, sourceRepositories });
    currentInventory.push(...inventory.files);
    excludedPaths.push(...inventory.excluded_paths.map(item => ({ repository, ...item })));
    nonRegularEntries.push(...inventory.non_regular_entries.map(item => ({ repository, ...item })));
  }
  return Object.freeze({
    pins, current_inventory: currentInventory,
    excluded_paths: excludedPaths.sort((left, right) => left.path.localeCompare(right.path)),
    non_regular_entries: nonRegularEntries.sort((left, right) => left.path.localeCompare(right.path)),
  });
}

/**
 * Plan one build (delta or full) from a PRE-RESOLVED inventory (resolveEstateInventory()).
 * `mode: 'full'` forces an empty parent inventory AND a null cache root via
 * tools/file-extraction-adapter.mjs planFileScopeExtraction — this is the ONE implementation of
 * the "disables deterministic unit reuse" contract in docs/delta-updatable-estate-maps.md, shared
 * with the ordinary extract CLI.
 */
function planEstateUpdateFromResolved({
  resolved, parentInventory = [], cacheRoot = null, mode, catalogGlobs = [],
}) {
  const registry = buildExtractionRegistry({ catalog_globs: catalogGlobs });
  const extraction = planFileScopeExtraction({
    current_inventory: resolved.current_inventory, parent_inventory: parentInventory,
    cache_root: cacheRoot, mode: mode === 'full' ? 'full' : 'reuse', registry,
  });
  return Object.freeze({
    plan: extraction.plan, pins: resolved.pins, registry, excluded_paths: resolved.excluded_paths,
    non_regular_entries: resolved.non_regular_entries,
    telemetry: extractionTelemetry(extraction.plan, { cache_root: extraction.cache_root, mode: extraction.mode }),
  });
}

/**
 * Plan one build (delta or full) from a pin manifest's declared `{repository: {path, ref}}` map.
 * Resolves refs and fetches the inventory itself (single-arm convenience wrapper around
 * resolveEstateInventory + planEstateUpdateFromResolved); kept for direct callers/tests that plan
 * one arm at a time. `sealUpdate` below calls resolveEstateInventory itself instead, so its two
 * arms share one resolution.
 */
export function planEstateUpdate({
  pinManifest, parentInventory = [], cacheRoot = null, mode, catalogGlobs = [], sourceRepositories = {},
}) {
  const resolved = resolveEstateInventory(pinManifest, { sourceRepositories });
  return planEstateUpdateFromResolved({ resolved, parentInventory, cacheRoot, mode, catalogGlobs });
}

/** Assemble the Estate Build Manifest for one planEstateUpdate() result. */
export function buildEstateManifestFromPlan({
  plan, pins, registry, pinManifestDigest, parentBuildId = null, catalogGlobs = [],
}) {
  const source = {
    pin_manifest_digest: pinManifestDigest,
    // tools/materialize-estate.mjs's materialization receipts are out of this file-scope slice —
    // this command reads a Git-backed repository directly via plumbing, never a materialized
    // snapshot. A named absence, never a value that could be misread as a real receipt digest.
    materialization_receipt_digest: sha256(canonical({
      status: 'absent',
      reason: 'materialization receipts (tools/materialize-estate.mjs) are out of this file-scope slice; source is read directly via git plumbing',
    })),
    pins,
  };
  const planner = {
    version: 'estate-delta-planner@1',
    producer_registry_digest: sha256(canonical([...registry.map(route => route.extractor)]
      .sort((left, right) => left.id.localeCompare(right.id)))),
    parent_build_id: parentBuildId,
  };
  const configurationDigest = sha256(canonical({ catalog_globs: [...catalogGlobs].sort() }));
  const runtimeDigest = sha256(canonical({ node_version: process.version }));
  // Redaction/document-classification policy is now shared with the ordinary extract CLI
  // (tools/file-extraction-adapter.mjs) and already folds into every extractor's own
  // configuration_digest (see buildExtractionRegistry); this policyDigest additionally names the
  // scan-scope exclusion policy this module now applies (tools/lib.mjs classifyExcludedPath).
  const policyDigest = sha256(canonical({
    redaction_and_document_mode_policy: 'tools/file-extraction-adapter.mjs@1', scan_scope_exclusion_policy: 'tools/lib.mjs#classifyExcludedPath@1',
  }));
  return assembleEstateBuildManifest({
    source, plan, planner, configuration_digest: configurationDigest, runtime_digest: runtimeDigest, policy_digest: policyDigest,
  });
}

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
function sealUpdate({
  pinManifest, parentInventory, mode, equivalenceRequired, catalogGlobs, pinManifestDigest, parentBuildId, cacheRoot,
  sourceRepositories = {},
}) {
  const runFull = mode === 'full';
  // Refs resolved and blobs fetched EXACTLY ONCE per invocation, shared by both arms below — see
  // resolveEstateInventory's doc comment for why a prior version's per-arm resolution was wrong.
  const resolved = resolveEstateInventory(pinManifest, { sourceRepositories });
  const primary = planEstateUpdateFromResolved({
    resolved, parentInventory, cacheRoot, mode: runFull ? 'full' : 'delta', catalogGlobs,
  });
  const primaryManifest = buildEstateManifestFromPlan({
    ...primary, pinManifestDigest, parentBuildId, catalogGlobs,
  });
  let equivalence = null;
  let fullManifest = null;
  if (!runFull && (equivalenceRequired || mode === 'shadow')) {
    const full = planEstateUpdateFromResolved({
      resolved, parentInventory: [], cacheRoot: null, mode: 'full', catalogGlobs,
    });
    fullManifest = buildEstateManifestFromPlan({ ...full, pinManifestDigest, parentBuildId: null, catalogGlobs });
    equivalence = compareFullAndDeltaBuilds({
      full: { manifest: fullManifest, plan: full.plan }, delta: { manifest: primaryManifest, plan: primary.plan },
    });
  }
  return {
    manifest: primaryManifest, fullManifest, equivalence, mode,
    excluded_paths: resolved.excluded_paths, non_regular_entries: resolved.non_regular_entries,
    telemetry: primary.telemetry,
  };
}

// --- CLI ---------------------------------------------------------------------------------------

const HELP = `Usage: ascrybe update --pin-manifest <path> --mode delta|full|shadow --output <dir>
  [--parent selected] [--parent-manifest <path>] [--parent-build <build-id>]
  [--equivalence required|certified] [--cache-root <dir>] [--catalog-globs <path>] [--promote]

--pin-manifest, --mode, and --output are required. --pin-manifest is JSON:
  {"repositories": {"<name>": {"path": "<git-checkout>", "ref": "<git-ref-or-sha>"}}}

--cache-root <dir> reuses/publishes per-file/extractor units across invocations
(tools/file-extraction-adapter.mjs, shared with the ordinary extract CLI). Omitted: every unit is
recomputed, as before this flag existed. --mode full always ignores it (no read, no write) even
when given — the forced-uncached reference mode.

--parent defaults to "selected". This slice retains no selected/build store: pass
--parent-manifest <path> naming an explicit prior sealed estate-build-manifest.json to diff
against, or omit it entirely to treat the whole current inventory as added (first build).
--parent-build <build-id> is always a typed refusal (DELTA_PARENT_BUILD_NOT_RETAINED): no build is
ever retained by this command.

Default catalog_globs source: the resolved --runtime-config's own "catalog_globs" field (ascrybe.mjs
injects this automatically from the caller's ascrybe.config.json, same as every other estate-facing
verb) — no config file there is not an error, since this command still needs no live estate to run.
--catalog-globs <path> names a JSON file holding a "catalog_globs" array directly and overrides
whatever the runtime config says; both use the SAME validation rule
(tools/ascrybe-config.mjs#validateCatalogGlobs). Neither is required: with no runtime config and no
--catalog-globs, the result is [], exactly as before either existed.
.estate-mapignore is read via Git plumbing per declared repository and applied unconditionally —
no flag disables it, matching the ordinary extract CLI having no such flag either.

--equivalence defaults to "required" and is the only implemented value; "certified" is a typed
refusal (this slice tracks no shadow-qualification closure).

--promote is ALWAYS a typed refusal. This command never stages a working generation, never runs
CAS, and never changes what a selected/working generation serves.

Exit codes: 0 sealed manifest written and (when run) equivalence passed; 2 typed refusal (manifest,
if any, is retained as a non-promotable diagnostic); 3 is reserved for CAS conflict and is never
emitted by this command (it never runs CAS); 4 operational failure before a sealed candidate.`;

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--promote' || arg === '--help') { options[arg.slice(2)] = true; continue; }
    if (!arg.startsWith('--')) throw updateError('DELTA_UPDATE_ARGS_INVALID', `unexpected positional argument: ${arg}`);
    index += 1;
    if (index >= argv.length) throw updateError('DELTA_UPDATE_ARGS_INVALID', `${arg} requires a value`);
    options[arg.slice(2)] = argv[index];
  }
  return options;
}

/**
 * The DEFAULT catalog_globs source: whatever `catalog_globs` the resolved runtime config (usually
 * bin/ascrybe.mjs's auto-injected `--runtime-config`, pointing at the caller's own
 * ascrybe.config.json) declares -- the SAME array the ordinary extract/claims path already reads,
 * closing the divergence a hardcoded `[]` default left open. A config file absent at that resolved
 * path is NOT an error: this command still needs no live estate to run, and every existing direct
 * caller that never passes --runtime-config at all must keep working exactly as before this
 * function existed. A config file that IS present but unreadable or names an invalid catalog_globs
 * value is a real refusal, never a silent `[]`.
 */
function catalogGlobsFromRuntimeConfig(runtimeConfigPath) {
  if (!runtimeConfigPath) return [];
  let text;
  try { text = readFileSync(resolve(runtimeConfigPath), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw updateError('DELTA_UPDATE_RUNTIME_CONFIG_UNREADABLE', error.message);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw updateError('DELTA_UPDATE_RUNTIME_CONFIG_UNREADABLE', `runtime config is not valid JSON: ${error.message}`); }
  try { return validateCatalogGlobs(parsed.catalog_globs); }
  catch (error) { throw updateError(error.code || 'DELTA_UPDATE_CATALOG_GLOBS_INVALID', error.message); }
}

/** The DEFAULT source_repositories source, for submodule resolution's first-priority rule -- the
 * SAME resolved runtime config catalogGlobsFromRuntimeConfig reads, and the SAME reasoning: no
 * config file there is not an error, a present-but-invalid one is a real refusal. Declaring no
 * source_repositories at all (no runtime config, or one that omits the field) falls back to this
 * inventory's remaining two submodule-resolution steps only, exactly as before this field existed. */
function sourceRepositoriesFromRuntimeConfig(runtimeConfigPath) {
  if (!runtimeConfigPath) return {};
  let text;
  try { text = readFileSync(resolve(runtimeConfigPath), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw updateError('DELTA_UPDATE_RUNTIME_CONFIG_UNREADABLE', error.message);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw updateError('DELTA_UPDATE_RUNTIME_CONFIG_UNREADABLE', `runtime config is not valid JSON: ${error.message}`); }
  try { return validateSourceRepositories(parsed.source_repositories); }
  catch (error) { throw updateError(error.code || 'DELTA_UPDATE_SOURCE_REPOSITORIES_INVALID', error.message); }
}

function refusalResult(error, extra = {}) {
  return { exit_code: 2, status: 'refused', reason_code: error.code, reason: error.message, detail: error.detail ?? null, ...extra };
}
function operationalFailure(error) {
  return { exit_code: 4, status: 'operational_failure', reason_code: error.code || 'DELTA_UPDATE_OPERATIONAL_FAILURE', reason: error.message };
}

/** The full `ascrybe update` runner. Exported so tests exercise the exact CLI contract (arg
 * validation, --promote refusal, exit codes) without spawning a subprocess. */
export function runUpdateCommand(argv, { cacheRoot } = {}) {
  let options;
  try { options = parseCliArgs(argv); } catch (error) { return refusalResult(error); }
  if (options.help) { console.log(HELP); return { exit_code: 0, status: 'help' }; }

  // Checked FIRST and unconditionally: --promote must publish nothing, not even a sealed manifest.
  if (options.promote) {
    let underlying = null;
    try { requestAscrybeUpdateProjectionPublish({ requested_via: '--promote' }); } catch (error) { underlying = error.code; }
    return refusalResult(updateError(
      'DELTA_UPDATE_PROMOTE_NOT_IMPLEMENTED',
      'ascrybe update never promotes: staging, CAS, and what a selected/working generation serves are out of this slice\u2019s scope',
      { underlying_capability_code: underlying },
    ));
  }

  const missing = ['pin-manifest', 'mode', 'output'].filter(key => !options[key]);
  if (missing.length) {
    return refusalResult(updateError('DELTA_UPDATE_ARGS_INVALID', `missing required flag(s): ${missing.map(key => `--${key}`).join(', ')}`));
  }
  if (!['delta', 'full', 'shadow'].includes(options.mode)) {
    return refusalResult(updateError('DELTA_UPDATE_ARGS_INVALID', `--mode must be delta, full, or shadow (got "${options.mode}")`));
  }
  const equivalence = options.equivalence || 'required';
  if (!['required', 'certified'].includes(equivalence)) {
    return refusalResult(updateError('DELTA_UPDATE_ARGS_INVALID', `--equivalence must be required or certified (got "${equivalence}")`));
  }
  if (equivalence === 'certified') {
    return refusalResult(updateError(
      'DELTA_UPDATE_EQUIVALENCE_CERTIFIED_NOT_IMPLEMENTED',
      '--equivalence certified requires an enabled shadow-qualification closure this slice does not track; only "required" is implemented',
    ));
  }
  if (options['parent-build']) {
    return refusalResult(updateError(
      'DELTA_PARENT_BUILD_NOT_RETAINED',
      `--parent-build ${options['parent-build']} cannot be resolved: this slice retains no build store`,
    ));
  }
  const parent = options.parent || 'selected';
  if (parent !== 'selected') {
    return refusalResult(updateError('DELTA_UPDATE_ARGS_INVALID', `--parent must be "selected" (got "${parent}")`));
  }

  let pinManifest;
  try { pinManifest = JSON.parse(readFileSync(resolve(options['pin-manifest']), 'utf8')); }
  catch (error) { return operationalFailure(updateError('DELTA_UPDATE_PIN_MANIFEST_UNREADABLE', error.message)); }
  const pinManifestDigest = sha256(canonical(pinManifest));

  let parentInventory = [];
  let parentBuildId = null;
  if (options['parent-manifest']) {
    try {
      const parentManifest = JSON.parse(readFileSync(resolve(options['parent-manifest']), 'utf8'));
      parentInventory = parentManifest.inventory?.files ?? [];
      parentBuildId = parentManifest.build_id ?? null;
    } catch (error) { return operationalFailure(updateError('DELTA_UPDATE_PARENT_MANIFEST_UNREADABLE', error.message)); }
  }

  let catalogGlobs;
  if (options['catalog-globs']) {
    // An explicit override: a missing or invalid file here is always a refusal -- the caller named
    // this file on purpose.
    try { catalogGlobs = validateCatalogGlobs(JSON.parse(readFileSync(resolve(options['catalog-globs']), 'utf8'))); }
    catch (error) { return operationalFailure(updateError(error.code || 'DELTA_UPDATE_CATALOG_GLOBS_UNREADABLE', error.message)); }
  } else {
    try { catalogGlobs = catalogGlobsFromRuntimeConfig(options['runtime-config']); }
    catch (error) { return operationalFailure(error); }
  }

  let sourceRepositories;
  try { sourceRepositories = sourceRepositoriesFromRuntimeConfig(options['runtime-config']); }
  catch (error) { return operationalFailure(error); }

  let sealed;
  try {
    sealed = sealUpdate({
      pinManifest, parentInventory, mode: options.mode, equivalenceRequired: true, catalogGlobs,
      pinManifestDigest, parentBuildId, cacheRoot: cacheRoot ?? options['cache-root'] ?? null,
      sourceRepositories,
    });
  } catch (error) { return operationalFailure(error); }

  const outputRoot = resolve(options.output);
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'estate-build-manifest.json'), `${JSON.stringify(sealed.manifest, null, 2)}\n`);
  if (sealed.fullManifest) writeFileSync(join(outputRoot, 'full-estate-build-manifest.json'), `${JSON.stringify(sealed.fullManifest, null, 2)}\n`);
  if (sealed.equivalence) writeFileSync(join(outputRoot, 'equivalence-receipt.json'), `${JSON.stringify(sealed.equivalence, null, 2)}\n`);
  // PARITY: cache/disposition telemetry and excluded-path accounting are SEPARATE receipts, never
  // mixed into estate-build-manifest.json (whose content must match across cached/uncached runs
  // over the same inputs).
  if (sealed.telemetry) writeFileSync(join(outputRoot, 'cache-telemetry.json'), `${JSON.stringify(sealed.telemetry, null, 2)}\n`);
  if (sealed.excluded_paths?.length) writeFileSync(join(outputRoot, 'scope-exclusions.json'), `${JSON.stringify(sealed.excluded_paths, null, 2)}\n`);
  // A gitlink or symlink was never eligible to become a file-scope unit (that would misrepresent
  // it) -- but its absence is counted and named here, never silent, distinct from scope-exclusions
  // (files that COULD have been units but were filtered by name/pattern/.estate-mapignore).
  if (sealed.non_regular_entries?.length) writeFileSync(join(outputRoot, 'non-regular-entries.json'), `${JSON.stringify(sealed.non_regular_entries, null, 2)}\n`);

  if (sealed.equivalence && sealed.equivalence.status !== 'equivalent') {
    return refusalResult(
      updateError(DELTA_FULL_MISMATCH_CODE, 'delta and full builds diverge; the delta candidate is retained as a non-promotable diagnostic', sealed.equivalence.diagnostic),
      { manifest_written: true, output: outputRoot },
    );
  }
  if (!sealed.manifest.promotable) {
    return refusalResult(
      updateError('DELTA_UPDATE_MANIFEST_DIAGNOSTIC', 'the assembled manifest failed a conservation check and is diagnostic-only', sealed.manifest.completeness.violations),
      { manifest_written: true, output: outputRoot },
    );
  }
  return {
    exit_code: 0, status: sealed.mode === 'shadow' ? 'sealed_shadow' : 'staged', build_id: sealed.manifest.build_id, output: outputRoot,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = runUpdateCommand(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.exit_code);
}
