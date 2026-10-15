// Shared file-extraction adapter — the ONE place a (repository, path, extractor) pair is turned
// into extraction-unit records, used by the ordinary `ascrybe extract` CLI (tools/extract.mjs,
// extractEstate() and every one of its callers, including tools/semantic-map-run.mjs's paid claims
// run) and by `ascrybe update` (tools/delta-update-run.mjs). Before this module, the two calling
// paths each built their own registry: extract.mjs called extractor.scan() directly inline, and
// delta-update-run.mjs's own extractorRoute() duplicated redaction and ctx construction and hashed
// only `extractor.scan.toString()` — the extractor function's own source text, which misses every
// helper it imports or closes over, and misses tree-sitter grammar/query bytes read by computed
// path rather than import (see moduleClosureDigest below, and tools/extraction-cache.mjs's
// sourceClosure() for the precedent this mirrors at whole-estate scope).
//
// This module owns three things:
//   1. ONE redaction/document-classification pass per file (withholdSecrets/redactLines,
//      documentModeFor) — never re-run per matching extractor, so per-file diagnostics (secret
//      counts, document mode) are not inflated by how many extractors route to a file.
//   2. ONE extractor-contract builder (buildExtractionRegistry) whose implementation_digest is the
//      extractor's own module file PLUS its transitive local-import closure PLUS (for any
//      tree-sitter-backed extractor) every query byte in tools/treesitter/queries — not
//      Function.toString().
//   3. ONE reuse/full-mode kernel (planFileScopeExtraction) wrapping tools/delta/planner.mjs's
//      planDeltaUnits: "full" mode disables BOTH cache read and cache write and ignores any parent
//      inventory, identically for both callers — this is the single implementation of
//      docs/delta-updatable-estate-maps.md's "`--mode full` disables deterministic unit reuse".
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDocument } from './document-mode.mjs';
import extractorsList, { extractorModuleFiles } from './extractors/index.mjs';
import { normalizePath, sha256, stableStringify } from './lib.mjs';
import { planDeltaUnits } from './delta/planner.mjs';

const canonical = value => stableStringify(value).trim();

// Shared identity_contract name for every file-scope unit this adapter builds, on both call paths
// — so the same (content, extractor-contract) pair always produces the same payload_unit_id
// regardless of which caller built the registry.
export const FILE_EXTRACTION_IDENTITY_CONTRACT = 'estate-map/file-extraction-identity/v1';

// Preserve source witnesses; do not infer authority from naming conventions alone.
export function createScanInvocationRecorder() {
  const events = [];
  return Object.freeze({
    /** Called immediately BEFORE extractor.scan() runs. Returns the mutable event record so the
     * caller can attach the throw/return outcome once scan() settles. */
    recordInvocation({ repository, normalized_path: normalizedPath, extractor_id: extractorId }) {
      const event = {
        repository, normalized_path: normalizedPath, extractor_id: extractorId, outcome: 'pending', at: Date.now(),
      };
      events.push(event);
      return event;
    },
    recordOutcome(event, { outcome, error, fact_count: factCount }) {
      event.outcome = outcome;
      if (error !== undefined) event.error = error;
      if (factCount !== undefined) event.fact_count = factCount;
    },
    get count() { return events.length; },
    get events() { return events.map(event => ({ ...event })); },
  });
}

// --- Redaction (single implementation; transcribed from the pre-adapter tools/extract.mjs, now
// the ONE copy tools/extract.mjs and tools/delta-update-run.mjs both import). ---------------------
//
// Redaction replaces the VALUE and keeps the line: blanking the whole line unbalances any object
// literal a redacted assignment sits inside. It keys on the VALUE'S SHAPE, not the identifier: a
// secret is a string, so a number/boolean/null-valued `accessToken` is left alone, and a reference
// like `process.env.STRIPE_KEY` is kept because it names WHERE a credential comes from without
// containing one.
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|api[_-]?key|token)["']?\s*[=:]\s*)(["'`][^"'`]*["'`]|[^\s,;}]+)/gi;
const EMBEDDED_LITERAL = /^["'`].*["'`]$/s;
const REDACTED = "'[redacted]'";
export function withholdSecrets(line) {
  let withheld = 0;
  const safe = line.replace(SECRET_ASSIGNMENT, (whole, assignment, value) => {
    if (!EMBEDDED_LITERAL.test(value)) return whole;
    withheld += 1;
    return `${assignment}${REDACTED}`;
  });
  return { line: safe, withheld };
}

const SAMPLE_CAP = 100;

/** Redact one file's RAW text exactly once. Returns safe lines plus a bounded sample of the
 * 1-indexed line numbers that were withheld, so a caller can attribute counts/samples per file
 * without re-running redaction per extractor. */
export function redactLines(text) {
  const lines = text.split(/\r?\n/);
  let secretCount = 0;
  const secretLineNumbers = [];
  const safeLines = lines.map((line, index) => {
    const held = withholdSecrets(line);
    if (!held.withheld) return line;
    secretCount += held.withheld;
    if (secretLineNumbers.length < SAMPLE_CAP) secretLineNumbers.push(index + 1);
    return held.line;
  });
  return { safeLines, secretCount, secretLineNumbers };
}

/** What a document IS, decided once per file (same classifier tools/extract.mjs always used).
 * Returns null for a non-Markdown file — matching the pre-adapter `.mdx?$` gate exactly. */
export function documentModeFor(normalizedPath, text) {
  if (!/\.mdx?$/i.test(normalizedPath)) return null;
  const held = classifyDocument({ path: normalizedPath, text });
  return { mode: held.mode, basis: held.basis, archived: held.archived, adjudication_frame: held.adjudication_frame };
}

// --- Per-extractor transitive dependency closure (implementation_digest) --------------------------
const ADAPTER_FILE = fileURLToPath(import.meta.url);
const DOCUMENT_MODE_FILE = fileURLToPath(new URL('./document-mode.mjs', import.meta.url));

/** Walk an extractor module's OWN local (relative-import) closure — the extractor's own file
 * (which contains every helper function defined in it; Function.toString() on just `scan` cannot
 * see those) plus every `.mjs` it imports, transitively. A module outside the closure root throws
 * rather than being silently skipped. Exported (not just used internally) so a test can point it
 * at a disposable scratch tree and prove an edited HELPER (not just the entry file) changes the
 * digest — the exact gap Function.toString() has. */
export function moduleClosureDigest(entryAbsolutePath) {
  const entry = resolve(entryAbsolutePath);
  // Extractors live at <root>/extractors/<name>.mjs; <root> is also where tools/treesitter/ lives.
  // A scratch fixture mirrors this shape (<scratchRoot>/extractors/<name>.mjs) so the same function
  // is exercised by both real extractors and tests.
  const root = dirname(dirname(entry));
  const visited = new Set();
  const pending = [entry];
  while (pending.length) {
    const path = resolve(pending.pop());
    if (visited.has(path)) continue;
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`file-extraction-adapter: module closure escaped its root: ${path}`);
    }
    if (!existsSync(path)) throw new Error(`file-extraction-adapter: local module dependency is unavailable: ${path}`);
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu)) {
      let dependency = resolve(dirname(path), match[1]);
      if (!dependency.endsWith('.mjs')) dependency = `${dependency}.mjs`;
      pending.push(dependency);
    }
  }
  // Tree-sitter query files are read by computed path at module load, never by `import` — the
  // import walk above structurally cannot see them (tools/extraction-cache.mjs's sourceClosure()
  // names the same gap for the whole-estate cache). Any extractor whose closure reaches the shared
  // loader depends on every query file, because which one it reads is chosen by parsed language at
  // runtime, not statically visible here.
  const usesTreesitterLoader = [...visited].some(path => path.endsWith(`${sep}treesitter${sep}loader.mjs`));
  const queriesRoot = join(root, 'treesitter', 'queries');
  const queryFiles = usesTreesitterLoader && existsSync(queriesRoot)
    ? readdirSync(queriesRoot).filter(name => name.endsWith('.scm')).sort().map(name => join(queriesRoot, name))
    : [];
  const sources = [...visited, ...queryFiles]
    .map(path => [relative(root, path).split(sep).join('/'), sha256(readFileSync(path))])
    .sort(([left], [right]) => left.localeCompare(right));
  return { digest: sha256(canonical(sources)), files: sources.map(([path]) => path) };
}

const implementationDigestCache = new Map();
function implementationDigestFor(kind) {
  if (implementationDigestCache.has(kind)) return implementationDigestCache.get(kind);
  const modulePath = extractorModuleFiles[kind];
  if (!modulePath) throw new Error(`file-extraction-adapter: no module file recorded for extractor "${kind}"`);
  const { digest } = moduleClosureDigest(modulePath);
  implementationDigestCache.set(kind, digest);
  return digest;
}

// Every extractor's configuration_digest carries this: an edit to the shared redaction/document-
// classification code this adapter runs before any extractor sees a line is an output-affecting
// dependency of EVERY extractor, not just the one whose own file changed.
const PREPROCESSING_POLICY_DIGEST = sha256(canonical({
  adapter: sha256(readFileSync(ADAPTER_FILE)),
  document_mode: sha256(readFileSync(DOCUMENT_MODE_FILE)),
}));

/** Build the real-extractor route registry: one route per tools/extractors/index.mjs entry, with a
 * fully-declared extractor_contract_dependencies (docs/delta-updatable-estate-maps.md). Both
 * tools/extract.mjs and tools/delta-update-run.mjs call this — the "one adapter with production
 * extractors" this task requires. `produce(file)` expects `file.safeLines` (from
 * redactLines/prepareFileEntry) — never re-derives redaction itself. */
export function buildExtractionRegistry({ catalog_globs: catalogGlobs = [] } = {}) {
  const configurationDigest = sha256(canonical({
    catalog_globs: [...catalogGlobs].sort(), preprocessing_policy_digest: PREPROCESSING_POLICY_DIGEST,
  }));
  const runtimeDigest = sha256(canonical({ node_version: process.version }));
  // Fresh recorder per registry build — both extractEstate() (once per run) and
  // tools/eval/delta-shape-eval.mjs's controls (once per control attempt) build a fresh registry,
  // so a recorder's count is scoped to exactly the attempt it was built for.
  const scanRecorder = createScanInvocationRecorder();
  const routes = extractorsList.map(extractor => {
    const contract = Object.freeze({
      id: extractor.kind,
      routing_contract_digest: sha256(canonical({ file_pattern: extractor.filePattern.toString() })),
      output_contract: `estate-map/extracted-fact/${extractor.kind}@1`,
      identity_contract: FILE_EXTRACTION_IDENTITY_CONTRACT,
      implementation_digest: implementationDigestFor(extractor.kind),
      configuration_digest: configurationDigest,
      runtime_digest: runtimeDigest,
    });
    return Object.freeze({
      extractor: contract,
      matches: normalizedPath => extractor.filePattern.test(normalizedPath),
      produce: file => {
        if (!Array.isArray(file.safeLines)) {
          throw new Error('file-extraction-adapter: produce() requires file.safeLines — call prepareFileEntry()/redactLines() first');
        }
        const documentPath = file.documentPath ?? file.normalized_path;
        const ctx = {
          repo: file.repository, file: file.normalized_path, document_path: documentPath,
          catalog_globs: catalogGlobs, document: file.documentMode ?? null, parseErrors: [],
          fact: (kind, line, data) => ({
            kind, repo: file.repository, file: file.normalized_path, document_path: documentPath, line, ...data,
          }),
        };
        // [ACTUAL-SCANS] THE production extractor.scan() callsite: recorded BEFORE the call, with
        // the throw/return outcome attached once it settles. This is the ONE place in the whole
        // shared path a real extractor function is ever invoked.
        const event = scanRecorder.recordInvocation({
          repository: file.repository, normalized_path: file.normalized_path, extractor_id: contract.id,
        });
        let facts;
        try {
          facts = extractor.scan(file.safeLines, ctx);
        } catch (error) {
          scanRecorder.recordOutcome(event, { outcome: 'threw', error: error.message });
          throw error;
        }
        scanRecorder.recordOutcome(event, { outcome: 'returned', fact_count: facts.length });
        return facts.map((fact, index) => ({
          observation_kind: fact.kind, producer_local_key: `record-${index}`,
          output_schema: contract.output_contract, normalized_record: fact,
        }));
      },
    });
  });
  // Exposed as a non-enumerable property on the returned array so `Array.isArray(registry)` and
  // every existing `registry.filter(...)`/`registry.length` caller is unaffected — this is purely
  // additive telemetry access, not a new required shape.
  Object.defineProperty(routes, 'scanInvocations', { value: scanRecorder, enumerable: false });
  return routes;
}

// --- File preparation (redaction + document mode, once per file) ---------------------------------

/** A content-addressed, VCS-independent stand-in for a Git blob id: extract.mjs's filesystem walk
 * has no Git repository to name a real blob oid against (docs/delta-updatable-estate-maps.md's
 * file payload_scope names blob_oid as part of identity, but nothing in that formula requires it
 * to be Git-derived). Prefixed so it is never mistaken for — or accidentally equal to — a real Git
 * object id. */
export const contentBlobOid = contentSha256 => `content:${contentSha256}`;

/**
 * Run the ONE redaction + document-classification pass for one file and attach the results to the
 * entry the delta identity/planner machinery expects (repository, normalized_path, blob_oid,
 * content_sha256), so it can go straight into planFileScopeExtraction's current_inventory.
 * `content_sha256` is always over the RAW (pre-redaction) bytes — matching
 * docs/delta-updatable-estate-maps.md's blob-identity meaning and tools/delta-update-run.mjs's
 * existing Git-blob content_sha256 — redaction is a declared extractor INPUT TRANSFORM, carried by
 * configuration_digest, never a change to the file's own content identity.
 */
export function prepareFileEntry({ repository, normalized_path: normalizedPath, blob_oid: blobOid, text, document_path: documentPath }) {
  const contentSha256 = sha256(text);
  const { safeLines, secretCount, secretLineNumbers } = redactLines(text);
  const documentMode = documentModeFor(normalizedPath, text);
  return Object.freeze({
    repository, normalized_path: normalizePath(normalizedPath),
    blob_oid: blobOid ?? contentBlobOid(contentSha256),
    content_sha256: contentSha256,
    documentPath: documentPath ? normalizePath(documentPath) : normalizePath(normalizedPath),
    safeLines, documentMode,
    redaction: Object.freeze({ secretCount, secretLineNumbers }),
  });
}

// --- Reuse kernel: the ONE place "full mode disables reuse" is implemented --------------------

/**
 * Plan file-scope extraction over `current_inventory` (an array of prepareFileEntry() results, or
 * any object with the same {repository, normalized_path, blob_oid, content_sha256, safeLines,
 * documentMode?, documentPath?} shape). `mode: 'full'` — the explicit full/reference mode both
 * callers expose — forcibly disables reuse: it ignores `cache_root` (no read, no write) AND
 * `parent_inventory` (every current file is planned as newly added), identically for the ordinary
 * extract CLI and `ascrybe update`. `mode: 'reuse'` (the default/normal-invocation contract) reads
 * and writes `cache_root` when one is given, and is a pure recompute-everything no-op when
 * `cache_root` is null (unchanged from before this adapter existed).
 */
export function planFileScopeExtraction({
  current_inventory: currentInventory, parent_inventory: parentInventory = [],
  cache_root: cacheRoot = null, mode = 'reuse', registry,
}) {
  if (!['reuse', 'full'].includes(mode)) {
    throw new Error(`file-extraction-adapter: mode must be "reuse" or "full" (got "${mode}")`);
  }
  if (!Array.isArray(registry) || !registry.length) throw new Error('file-extraction-adapter: a non-empty registry is required');
  const effectiveCacheRoot = mode === 'full' ? null : cacheRoot;
  const effectiveParentInventory = mode === 'full' ? [] : parentInventory;
  const plan = planDeltaUnits({
    parent_inventory: effectiveParentInventory, current_inventory: currentInventory, registry, cache_root: effectiveCacheRoot,
  });
  return Object.freeze({ plan, registry, cache_root: effectiveCacheRoot, mode });
}

/** Cache/disposition/scan-count telemetry for one plan — kept OUT of the facts/manifest a build
 * emits (PARITY: "cache telemetry is separate"). `scan_calls` counts units that actually called an
 * extractor's `scan()` (disposition `produced` or `refused` — a refusal still ran `produce()`,
 * it just threw); `reused_exact` units never called `scan()` at all. */
export function extractionTelemetry(plan, {
  cache_root: cacheRoot = null, mode = 'reuse', actual_scan_invocations: actualScanInvocations = null,
} = {}) {
  const byDisposition = { produced: 0, reused_exact: 0, migrated: 0, refused: 0 };
  const byRepository = {};
  for (const receipt of plan.receipts) {
    const kind = receipt.disposition.kind;
    byDisposition[kind] = (byDisposition[kind] || 0) + 1;
    const repo = receipt.scope.repository;
    byRepository[repo] ??= { produced: 0, reused_exact: 0, migrated: 0, refused: 0 };
    byRepository[repo][kind] = (byRepository[repo][kind] || 0) + 1;
  }
  return Object.freeze({
    schema: 'estate-map/file-extraction-telemetry/v1',
    cache_root: cacheRoot, mode,
    total_units: plan.receipts.length,
    by_disposition: byDisposition,
    by_repository: byRepository,
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    scan_calls: byDisposition.produced + byDisposition.refused,
    // [ACTUAL-SCANS] The REAL production extractor.scan() invocation count for this plan, grounded
    // at the callsite (tools/file-extraction-adapter.mjs's own `produce()`), not inferred from any
    // receipt's disposition. `null` when the caller did not supply a scan-invocation delta.
    actual_scan_invocations: actualScanInvocations,
  });
}
