#!/usr/bin/env node
// Run the estate-map pipeline against N estates in ONE invocation and report PER ESTATE.
//
// WHY THIS EXISTS. Every extractor in tools/estate-map/** was written against
// the home estate. Measuring the instrument on the home estate therefore measures
// the training set, not the instrument: the estate and the tool were co-developed, so the
// tool's idioms and the estate's idioms are the same idioms by construction. The one
// out-of-sample measurement anyone had taken (examples/portability-probe-2026-07-26.md)
// found ~29.6% of records survived the move to an independent estate, 1 of 6 knowledge
// families and 0 of 5 SEMANTIC families. That is the number that matters, and it was an
// occasional audit rather than a standing gate. This makes it a standing gate.
//
// THE AGGREGATE IS THE BUG. This harness never emits a single headline survival number
// across estates, and refuses to compute one. Home at ~100% and foreign at ~30% average to
// a number that describes neither estate and hides the only finding worth having. Every
// output is keyed by estate, and every estate carries an explicit sample label:
//
//   IN-SAMPLE      the estate the extractors were written against. CONTAMINATED BY
//                  CONSTRUCTION. A high score here is not evidence of generality.
//   OUT-OF-SAMPLE  an estate the extractors have never seen. This is the test set.
//
// REGRESSION, PRECISELY. The asymmetry this exists to catch is: a change that IMPROVES the
// home estate while DEGRADING any foreign estate. That is the signature of overfitting to
// the home estate's idioms, and it is invisible to any aggregate and to any home-only
// test suite. `--baseline <prior-report.json>` turns that definition into a check.
//
// READ-ONLY. Every child process is spawned with ASCRYBE_SCAN_ROOT set to the estate
// being scanned, so readonly-guard.mjs refuses any write under it even in tools that never
// learned to parse an --estate flag. Output goes to --out, which must be outside every
// estate. Foreign estates are EVIDENCE; this harness reads them and nothing else.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from './readonly-guard.mjs';
import { assertWritable, outputRootBase, registerScanRoot, SCAN_ROOT_ENV } from './readonly-guard.mjs';
import { stableStringify } from './lib.mjs';
import { unexpectedFailureRecord } from './portability.mjs';
import { CANONICAL_STAGE_REGISTRY, runCanonicalPipeline } from './pipeline.mjs';

/**
 * A local argument parser, deliberately NOT lib.mjs#parseArgs.
 *
 * `--estate` is REPEATABLE -- running against N estates in one invocation is the entire
 * point of this tool -- and lib.mjs#parseArgs assigns `options[key]=argv[++i]`, so a repeat
 * silently overwrites and `--estate a --estate b` would measure only `b`. It also treats
 * any flag outside a fixed boolean list as value-taking, so `--list-estates` would swallow
 * the next argument. Changing that shared parser to fix this tool would alter argument
 * handling for the twenty other tools that depend on its current behaviour.
 */
export function parseMultiEstateArgs(argv) {
  const booleans = new Set(['help', 'json', 'list-estates']);
  const repeatable = new Set(['estate']);
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (booleans.has(key)) { options[key] = true; continue; }
    const value = argv[index += 1];
    if (repeatable.has(key)) (options[key] ||= []).push(value);
    else options[key] = value;
  }
  return { positional, options };
}

export const MULTI_ESTATE_SCHEMA = 'estate-map/multi-estate-report/v1';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');

export const SAMPLE_LABELS = Object.freeze({
  IN_SAMPLE: 'IN-SAMPLE',
  OUT_OF_SAMPLE: 'OUT-OF-SAMPLE',
});
export const SAMPLE_LABEL_MEANING = Object.freeze({
  'IN-SAMPLE': 'the estate the extractors were written against; results are CONTAMINATED BY CONSTRUCTION and are not evidence of generality',
  'OUT-OF-SAMPLE': 'an estate the extractors have never seen; this is the only measurement that tests portability',
});

/**
 * The six knowledge families the 2026-07-26 portability probe counted, kept in ITS terms so
 * the numbers are directly comparable rather than a new metric that quietly redefines the
 * question. `semantic: true` marks the families that say something about the BUSINESS as
 * opposed to file layout -- the 0-of-5 figure in the probe's headline.
 *
 * Each family names where it is read FROM on the annotated graph. Those keys were confirmed
 * against a real artifact (Object.keys of a produced estate-graph.annotated.json), not from
 * a design doc: annotate.mjs:876 mints exactly overlays / refusals / structural_unclassified
 * / entity_layer / interpretation_layer / dataflow_layer onto the merged graph.
 */
export const KNOWLEDGE_FAMILIES = Object.freeze([
  { id: 'annotations', semantic: false, source: 'graph.overlays', why: 'domain + structural annotation overlays' },
  { id: 'claims', semantic: false, source: 'semantic-layer accepted claims', why: 'model-adjudicated claims; needs a model on BOTH arms to be comparable' },
  { id: 'entity_records', semantic: true, source: 'graph.entity_layer', why: 'entity records derived from facts + graph + shipped model' },
  { id: 'routes', semantic: true, source: 'graph.nodes[kind=route]', why: 'inbound HTTP surface' },
  { id: 'capabilities', semantic: true, source: 'graph.nodes[kind=capability]', why: 'capability registry' },
  { id: 'interpretations', semantic: false, source: 'graph.interpretation_layer', why: 'model interpretations; deterministic precursor is slices' },
]);

/**
 * The FIVE semantic families in the probe's "0 of 5" headline. Deliberately a separate list
 * from KNOWLEDGE_FAMILIES[].semantic: the probe counted domain and envelope and
 * manifest-wiring, which are graph populations rather than record families, and collapsing
 * the two lists would silently change the denominator the headline is quoted against.
 */
export const SEMANTIC_FAMILIES = Object.freeze([
  { id: 'domain', source: 'graph.overlays[domain]', why: 'bounded-context / domain assignment' },
  { id: 'entity', source: 'graph.entity_layer', why: 'entity records' },
  { id: 'capability', source: 'graph.nodes[kind=capability]', why: 'capability registry' },
  { id: 'envelope', source: 'graph.nodes[kind=envelope_kind]', why: 'envelope bus' },
  { id: 'manifest_wiring', source: 'graph.manifest_wiring', why: 'plugin.yaml declared wiring' },
]);

const HELP = `Usage: node tools/estate-map/multi-estate.mjs [options]

Runs the estate-map pipeline against SEVERAL estates in one invocation and emits a
PER-ESTATE report plus a cross-estate comparison. Never emits only an aggregate.

Options:
  --estate <path>[=<label>]  add an estate (repeatable). Omit to auto-DISCOVER.
  --home <path>              the IN-SAMPLE estate (default: this repo, ${REPO_ROOT})
  --out <dir>                report directory (default: under ${'$'}ASCRYBE_OUT_ROOT /
                             ${'$'}XDG_STATE_HOME / ~/.local/state/estate-map). MUST be
                             outside every scanned estate.
  --baseline <report.json>   prior report; enables REGRESSION detection
  --list-estates             print discovered candidates with provenance, then exit
  --max-estates <n>          cap auto-discovered foreign estates (default: 3)
  --registry <path>          project registry sqlite (default: $ASCRYBE_PROJECT_REGISTRY, else none)
  --json                     print the report JSON to stdout
  --help

REGRESSION is defined as: the home estate improves while ANY foreign estate degrades.
That asymmetry is the specific overfitting signature this harness exists to catch.

Every estate is scanned READ-ONLY. Children run with ${SCAN_ROOT_ENV}=<estate>, so any
write under the scanned tree fails with ASCRYBE_READONLY_VIOLATION.`;

/* ------------------------------------------------------------- discovery --- */

const REGISTRY_CANDIDATES = Object.freeze(process.env.ASCRYBE_PROJECT_REGISTRY ? [process.env.ASCRYBE_PROJECT_REGISTRY] : []);

/**
 * Enumerate estate candidates from the project registry AND the filesystem, recording WHERE
 * each candidate came from. Nothing here is a hardcoded estate list; if this function
 * returns nothing the harness says so rather than quietly falling back to a literal.
 *
 * The registry is copied to a scratch file before opening. Opening the live sqlite file
 * read-only still requires write access to its -shm sidecar under WAL, so "read-only mode"
 * is not actually read-only against a live registry -- copying is.
 */
export async function discoverEstates({ registryPath = null, scratchDir, homeRoot } = {}) {
  const candidates = new Map();
  const add = (root, provenance, extra = {}) => {
    const resolved = path.resolve(root);
    const existing = candidates.get(resolved);
    if (existing) { if (!existing.provenance.includes(provenance)) existing.provenance.push(provenance); return; }
    candidates.set(resolved, { root: resolved, provenance: [provenance], ...extra });
  };

  const registry = registryPath ? [registryPath] : REGISTRY_CANDIDATES;
  const notes = [];
  for (const source of registry) {
    let rows = [];
    try { rows = await readRegistryProjects(source, scratchDir); }
    catch (error) { notes.push(`project registry ${source}: unreadable (${error.code || error.message})`); continue; }
    if (!rows.length) { notes.push(`project registry ${source}: no rows`); continue; }
    notes.push(`project registry ${source}: ${rows.length} registered project(s)`);
    for (const row of rows) add(row.cwd, `registry:${path.basename(path.dirname(source))}`, { project_id: row.project_id, project_type: row.type });
    break;
  }

  // Filesystem sweep of the directory that holds the home estate. This is what finds
  // estates nobody registered, and it is why the harness does not depend on the registry
  // being populated.
  const developmentRoot = path.dirname(path.resolve(homeRoot).replace(/\/(main|feat|fix|docs|review)\/[^/]*$/, ''));
  for (const base of [...new Set([developmentRoot, path.dirname(path.resolve(homeRoot))])]) {
    let entries = [];
    try { entries = await fsPromises.readdir(base, { withFileTypes: true }); }
    catch (error) { notes.push(`filesystem ${base}: unreadable (${error.code})`); continue; }
    let found = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name);
      let gitEntry;
      try { gitEntry = await fsPromises.stat(path.join(candidate, '.git')); } catch { continue; }
      add(candidate, `filesystem:${base}`, { linked_worktree: !gitEntry.isDirectory() });
      found += 1;
    }
    notes.push(`filesystem ${base}: ${found} git working tree(s)`);
  }

  // An estate NESTED inside another estate is not an independent sample: scanning
  // acme/acme-cloud/acme-api measures a subtree of acme, and counting both would double-count the
  // same corpus and overstate how many independent estates were tested.
  const roots = [...candidates.values()].sort((a, b) => a.root.localeCompare(b.root));
  for (const candidate of roots) {
    const parent = roots.find(other => other.root !== candidate.root && candidate.root.startsWith(other.root + path.sep));
    candidate.nested_inside = parent ? parent.root : null;
    candidate.independent = !parent && !candidate.linked_worktree;
  }
  const linked = roots.filter(candidate => candidate.linked_worktree).length;
  if (linked) notes.push(`${linked} candidate(s) are linked git worktrees (another checkout of a repo already listed) and are NOT counted as independent estates`);
  return { candidates: roots, notes };
}

async function readRegistryProjects(dbPath, scratchDir) {
  await fsPromises.access(dbPath);
  const copyDir = path.join(scratchDir, 'registry-copy');
  await fsPromises.mkdir(copyDir, { recursive: true });
  const copy = path.join(copyDir, path.basename(dbPath));
  for (const suffix of ['', '-wal', '-shm']) {
    try { await fsPromises.copyFile(`${dbPath}${suffix}`, `${copy}${suffix}`); } catch { /* sidecars are optional */ }
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(copy, { readOnly: false });
  try { return db.prepare('SELECT project_id, type, state, cwd FROM projects ORDER BY project_id').all(); }
  finally { db.close(); }
}

/* ------------------------------------------------------------------ run --- */

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

function runPass({ id, args, cwd, estateRoot, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise(resolve => {
    const startedAt = nowMs();
    const child = spawn(process.execPath, args, {
      cwd,
      // The belt-and-braces read-only channel. A tool that never learned to parse an
      // estate argument (merge, annotate, index, query) still gets the scan root, so the
      // guard covers it without every tool growing a flag it does not otherwise need.
      env: { ...process.env, [SCAN_ROOT_ENV]: estateRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ id, exit_code: null, spawn_error: error.message, wall_ms: nowMs() - startedAt, stdout, stderr, timed_out: false });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        id, exit_code: code, spawn_error: null, wall_ms: nowMs() - startedAt, timed_out: timedOut,
        // Tails only. A full estate scan emits megabytes and the report must stay readable;
        // the artifacts on disk remain the authority for anything deeper.
        stdout: stdout.slice(-4000), stderr: stderr.slice(-4000),
        readonly_violation: /ASCRYBE_READONLY_VIOLATION/.test(stderr),
      });
    });
  });
}

const readJsonIfPresent = async file => {
  try { return JSON.parse(await fsPromises.readFile(file, 'utf8')); } catch { return null; }
};
const readJsonlIfPresent = async file => {
  try { return (await fsPromises.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
};

/** One estate, one full pass sequence. */
async function runEstateLegacy({ estate, outDir, toolDir = TOOL_DIR }) {
  const root = estate.root;
  const work = path.join(outDir, 'estates', estate.id);
  await fs.mkdir(work, { recursive: true });
  const tool = name => path.join(toolDir, name);
  const at = (...parts) => path.join(work, ...parts);
  const passes = [];
  const portability = [];
  const startedAt = nowMs();

  const pass = async (id, args, { requires = [] } = {}) => {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    for (const required of requires) {
      try { await fsPromises.access(required); }
      catch {
        const record = { id, exit_code: null, skipped: true, skipped_because: `required input absent: ${path.relative(work, required)}`, wall_ms: 0, stdout: '', stderr: '' };
        passes.push(record);
        return record;
      }
    }
    const result = await runPass({ id, args, cwd: REPO_ROOT, estateRoot: root });
    passes.push(result);
    if (result.exit_code !== 0) {
      // An unexpected non-zero exit is not allowed to be a silent hole in the census. It
      // becomes a typed record naming the tool, the estate and the phase -- the same
      // vocabulary the extractors use for a missing input.
      portability.push(unexpectedFailureRecord({
        tool: id, estateRoot: root, phase: `pass:${id}`,
        error: { code: result.timed_out ? 'ETIMEDOUT' : result.spawn_error ? 'ESPAWN' : `EXIT_${result.exit_code}`, message: (result.stderr || result.spawn_error || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${result.exit_code}`, stack: result.stderr },
      }));
    }
    return result;
  };

  await pass('extract', [tool('extract.mjs'), root, '--out', at('extract')]);
  await pass('merge', [tool('merge.mjs'), at('extract', 'facts'), '--out', at('graph')], { requires: [at('extract', 'facts')] });
  const graph = at('graph', 'estate-graph.json');
  await pass('ddd-overlays', [tool('ddd-overlays.mjs'), graph, at('overlays', 'ddd.jsonl')], { requires: [graph] });
  await pass('domain-derivation', [tool('domain-derivation.mjs'), graph, at('overlays', 'derived.jsonl'), '--census', at('census', 'derived.json'), '--refusals', at('overlays', 'derived.refusals.jsonl')], { requires: [graph] });
  await pass('structural-grouping', [tool('structural-grouping.mjs'), graph, at('overlays', 'structural.jsonl'), '--census', at('census', 'structural.json')], { requires: [graph] });
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  await pass('discover-entities', [tool('discover-entities.mjs'), root, '--out', at('discovery')]);
  const discoveryReport = at('discovery', 'discovery-report.json');
  const entityLayerArgs = [tool('entity-layer.mjs'), graph, at('overlays', 'entities.entity-layer.jsonl'), '--facts', at('extract', 'facts'), '--estate', root, '--census', at('census', 'entity.json')];
  if (await fsPromises.access(discoveryReport).then(() => true, () => false)) entityLayerArgs.push('--discovery', discoveryReport);
  await pass('entity-layer', entityLayerArgs, { requires: [graph] });
  await pass('annotate-merge', [tool('annotate.mjs'), 'merge', at('graph'), at('overlays')], { requires: [graph] });
  const annotated = at('graph', 'estate-graph.annotated.json');
  await pass('analyze-connectivity', [tool('analyze-connectivity.mjs'), '--graph', graph, '--facts', at('extract', 'facts'), '--out', at('connectivity.json')], { requires: [graph] });
  await pass('conservation', [tool('conservation.mjs'), at('extract', 'facts'), graph, '--out', at('conservation.json')], { requires: [graph] });
  await pass('interpretation-slices', [tool('interpretation-layer.mjs'), 'slices', annotated, '--out', at('slices.jsonl')], { requires: [annotated] });
  await pass('semantic-spans', [tool('semantic-layer.mjs'), 'spans', root, '--out', at('spans.jsonl')]);
  await pass('semantic-packets', [tool('semantic-layer.mjs'), 'packets', at('spans.jsonl'), '--out', at('packets.jsonl')], { requires: [at('spans.jsonl')] });
  await pass('loop-driver', [tool('loop-driver.mjs'), root, '--state', at('loop'), '--now', '2026-07-27T00:00:00Z']);

  const census = await censusOf({ work, annotated, graph });
  // Portability records are collected from EVERY producer that emits them, not just
  // discovery. entity-layer's census carries the `input_absent` record for the
  // shipped model that only the home estate has; dropping it was how a foreign
  // estate's zero looked like silence instead of a named, typed absence.
  for (const file of ['discovery/discovery-report.json', 'census/entity.json', 'census/derived.json']) {
    const report = await readJsonIfPresent(at(...file.split('/')));
    if (report?.portability) portability.push(...report.portability);
  }

  return {
    ...estate,
    wall_ms: nowMs() - startedAt,
    passes,
    census,
    portability_records: portability,
    crashes: passes.filter(item => !item.skipped && item.exit_code !== 0).map(item => ({ pass: item.id, exit_code: item.exit_code, timed_out: Boolean(item.timed_out), first_stderr_line: (item.stderr || '').split('\n').filter(Boolean)[0] || null })),
    readonly_violations: passes.filter(item => item.readonly_violation).map(item => item.id),
  };
}

// Multi-estate uses the same canonical DAG as the operator-facing one. Its
// per-estate comparison remains a subset view: model-dependent receipts stay typed rather
// than pretending that zero model records are comparable evidence.
export async function runEstate({ estate, outDir }) {
  const root = estate.root;
  const work = path.join(outDir, 'estates', estate.id);
  const startedAt = nowMs();
  let result;
  let canonicalError = null;
  try {
    result = await runCanonicalPipeline({ estateRoot: root, outDir: work, generatedAt: '2026-07-28T00:00:00Z' });
  } catch (error) {
    // Canonical publication rejects incomplete maps. Preserve that rejection as a typed
    // estate result instead of aborting the remaining portability sample.
    canonicalError = error;
    result = error.diagnostic || {
      outDir: work,
      manifestPath: null,
      graph: path.join(work, 'graph', 'estate-graph.json'),
      annotated: path.join(work, 'graph', 'estate-graph.annotated.json'),
      receipts: [],
      failure: { name: error.name, message: error.message },
    };
  }
  const artifactRoot = result.outDir || work;
  const census = await censusOf({ work: artifactRoot, annotated: result.annotated, graph: result.graph, canonical: true });
  const portability = [];
  for (const file of ['discovery/discovery-report.json', 'census/entity.json', 'census/derived.json']) {
    const report = await readJsonIfPresent(path.join(artifactRoot, file));
    if (report?.portability) portability.push(...report.portability);
  }
  const passes = result.receipts.map(receipt => ({
    id: receipt.id,
    exit_code: receipt.exit_code,
    skipped: receipt.status === 'stale',
    skipped_because: receipt.status === 'stale' ? receipt.reason : undefined,
    wall_ms: 0,
    stdout: receipt.stdout_tail || '',
    stderr: receipt.stderr_tail || '',
    readonly_violation: Boolean(receipt.readonly_violation),
    stage_status: receipt.status,
    stage_reason: receipt.reason || null,
  }));
  const nonSuccessStages = passes.filter(item => item.stage_status !== 'success');
  for (const failure of nonSuccessStages.filter(item => item.stage_status === 'failed')) {
    portability.push(unexpectedFailureRecord({
      tool: 'canonical-pipeline', estateRoot: root, phase: failure.id,
      error: { code: `STAGE_${failure.stage_status.toUpperCase()}`, message: failure.stage_reason || 'stage exited unsuccessfully' },
    }));
  }
  if (canonicalError) {
    portability.push(unexpectedFailureRecord({
      tool: 'canonical-pipeline', estateRoot: root, phase: 'canonical-completeness',
      error: { code: 'CANONICAL_REJECTED', message: result.failure?.message || canonicalError.message },
    }));
  }
  const stageCrashes = passes.filter(item => item.stage_status === 'failed').map(item => ({
    pass: item.id, exit_code: item.exit_code, timed_out: false,
    first_stderr_line: item.stage_reason || item.stderr.split('\n').filter(Boolean)[0] || null,
  }));
  if (canonicalError) stageCrashes.push({
    pass: 'canonical-completeness', exit_code: 1, timed_out: false,
    first_stderr_line: result.failure?.message || canonicalError.message,
  });
  return {
    ...estate,
    canonical_stage_ids: CANONICAL_STAGE_REGISTRY.map(item => item.id),
    non_success_stages: nonSuccessStages.map(item => ({ id: item.id, status: item.stage_status, reason: item.stage_reason })),
    manifest: result.manifestPath,
    failure_receipt: canonicalError ? result.manifestPath : null,
    wall_ms: nowMs() - startedAt,
    passes,
    census,
    portability_records: portability,
    crashes: stageCrashes,
    readonly_violations: passes.filter(item => item.readonly_violation).map(item => item.id),
  };
}

export async function censusOf({ work, annotated, graph, canonical = false }) {
  const at = (...parts) => path.join(work, ...parts);
  const firstExisting = async (...files) => {
    for (const file of files) if (await fsPromises.access(file).then(() => true, () => false)) return file;
    return files[0];
  };
  const annotatedGraph = await readJsonIfPresent(annotated) || await readJsonIfPresent(graph) || {};
  const nodes = annotatedGraph.nodes || [];
  const countKind = kind => nodes.filter(node => node.kind === kind).length;
  const overlays = annotatedGraph.overlays || [];
  const slices = await readJsonlIfPresent(await firstExisting(at('interpretation', 'slices.jsonl'), at('slices.jsonl')));
  const spans = await readJsonlIfPresent(await firstExisting(at('semantic', 'spans.jsonl'), at('spans.jsonl')));
  const packets = await readJsonlIfPresent(await firstExisting(at('semantic', 'packets.jsonl'), at('packets.jsonl')));
  const derivedRefusals = await readJsonlIfPresent(at('overlays', 'derived.refusals.jsonl'));
  const conservation = await readJsonIfPresent(at('conservation.json'));
  const connectivity = await readJsonIfPresent(at('connectivity.json'));
  const discovery = await readJsonIfPresent(at('discovery', 'discovery-report.json'));

  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const entityLayer = annotatedGraph.entity_layer || [];
  const entityRecordsByKind = {};
  for (const record of entityLayer) {
    const kind = record?.record_kind || 'unknown';
    entityRecordsByKind[kind] = (entityRecordsByKind[kind] || 0) + 1;
  }
  const entityTypes = entityRecordsByKind.entity_type || 0;

  const families = Object.fromEntries(KNOWLEDGE_FAMILIES.map(family => [family.id, ({
    annotations: overlays.length,
    claims: 0,
    entity_records: entityTypes,
    routes: countKind('route'),
    capabilities: countKind('capability'),
    interpretations: (annotatedGraph.interpretation_layer || []).length,
  })[family.id] ?? 0]));

  const semantic = {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    domain: overlays.filter(record => record?.body?.domain || record?.domain).length,
    // PROMOTED entities only. See the entity-layer split above: a family is "populated"
    // when the estate yielded entity KNOWLEDGE, never when it yielded a record saying it
    // could not.
    entity: entityTypes,
    capability: countKind('capability'),
    envelope: countKind('envelope_kind'),
    manifest_wiring: (annotatedGraph.manifest_wiring || []).length,
  };

  // Refusals BY CLASS, from every ledger that produces them. Refusals are the instrument's
  // most portable asset -- on the 2026-07-26 probe they were the one measure that went UP
  // on the foreign estate -- so they are counted, not summarised away.
  const refusalsByClass = {};
  const bump = (key, n = 1) => { if (n) refusalsByClass[key] = (refusalsByClass[key] || 0) + n; };
  bump('domain_derivation', derivedRefusals.length);
  bump('capability', (annotatedGraph.capability_refusals || []).length);
  bump('route', (annotatedGraph.route_refusals || []).length);
  bump('orphan', (annotatedGraph.orphan_refusals || []).length);
  bump('structural_unclassified', (annotatedGraph.structural_unclassified || []).length);
  bump('graph_refusals', (annotatedGraph.refusals || []).length);
  for (const [type, count] of Object.entries(conservation?.census?.derivability_by_type || {})) bump(`conservation_${type}`, count);

  const familiesPopulated = KNOWLEDGE_FAMILIES.filter(family => families[family.id] > 0).map(family => family.id);
  const semanticPopulated = SEMANTIC_FAMILIES.filter(family => semantic[family.id] > 0).map(family => family.id);

  return {
    nodes: nodes.length,
    edges: (annotatedGraph.edges || []).length,
    records_total: Object.values(families).reduce((sum, value) => sum + value, 0),
    families,
    families_populated: familiesPopulated,
    families_empty: KNOWLEDGE_FAMILIES.map(family => family.id).filter(id => !familiesPopulated.includes(id)),
    families_populated_ratio: `${familiesPopulated.length}/${KNOWLEDGE_FAMILIES.length}`,
    semantic_families: semantic,
    semantic_populated: semanticPopulated,
    semantic_populated_ratio: `${semanticPopulated.length}/${SEMANTIC_FAMILIES.length}`,
    deterministic_precursors: { interpretation_slices: slices.length, semantic_spans: spans.length, semantic_packets: packets.length },
    // Kept beside the count, not folded into it: on a foreign estate the refusal half is
    // usually the WHOLE story, and it is the half that says what was examined.
    entity_layer_by_record_kind: entityRecordsByKind,
    entity_layer_total: entityLayer.length,
    refusals_by_class: refusalsByClass,
    refusals_total: Object.values(refusalsByClass).reduce((sum, value) => sum + value, 0),
    records_per_node: nodes.length ? Number((Object.values(families).reduce((sum, value) => sum + value, 0) / nodes.length).toFixed(4)) : null,
    connectivity: connectivity ? {
      components: connectivity.components?.count ?? connectivity.components ?? null,
      isolated_nodes: connectivity.isolated_nodes?.count ?? connectivity.isolated_nodes ?? null,
    } : null,
    discovery: discovery ? {
      discovered_entity_types: discovery.headline?.discovered_entity_types ?? null,
      documented_entity_types: discovery.headline?.documented_entity_types ?? null,
      unavailable: discovery.unavailable ?? null,
    } : null,
    conservation: conservation ? { passed: conservation.passed, census: conservation.census } : null,
  };
}

/* ----------------------------------------------------------- regression --- */

/**
 * REGRESSION = the home estate improves while ANY foreign estate degrades.
 *
 * Both halves are required. A change that improves everything is progress. A change that
 * degrades everything is a plain regression that home-estate tests already catch. The
 * dangerous, invisible case -- the one that overfits the tool to the home estate's
 * idioms -- is exactly the ASYMMETRY, and it is invisible to any aggregate.
 */
export function detectRegression(current, baseline) {
  if (!baseline) return { checked: false, why: 'no --baseline supplied; regression detection requires a prior report' };
  const byId = new Map((baseline.estates || []).map(estate => [estate.id, estate]));
  const deltaFor = estate => {
    const prior = byId.get(estate.id);
    if (!prior) return null;
    const families = Object.fromEntries(KNOWLEDGE_FAMILIES.map(family => [family.id, (estate.census.families[family.id] || 0) - (prior.census.families[family.id] || 0)]));
    const newCrashes = estate.crashes.filter(crash => !(prior.crashes || []).some(item => item.pass === crash.pass)).map(crash => crash.pass);
    return {
      id: estate.id, sample: estate.sample,
      records_total: estate.census.records_total - prior.census.records_total,
      families,
      families_populated: estate.census.families_populated.length - prior.census.families_populated.length,
      semantic_populated: estate.census.semantic_populated.length - prior.census.semantic_populated.length,
      new_crashes: newCrashes,
      improved: estate.census.records_total > prior.census.records_total
        || estate.census.families_populated.length > prior.census.families_populated.length
        || estate.census.semantic_populated.length > prior.census.semantic_populated.length,
      degraded: estate.census.records_total < prior.census.records_total
        || estate.census.families_populated.length < prior.census.families_populated.length
        || estate.census.semantic_populated.length < prior.census.semantic_populated.length
        || Object.values(families).some(value => value < 0)
        || newCrashes.length > 0,
    };
  };
  const deltas = (current.estates || []).map(deltaFor).filter(Boolean);
  const home = deltas.find(delta => delta.sample === SAMPLE_LABELS.IN_SAMPLE);
  const degradedForeign = deltas.filter(delta => delta.sample === SAMPLE_LABELS.OUT_OF_SAMPLE && delta.degraded);
  const regression = Boolean(home?.improved) && degradedForeign.length > 0;
  return {
    checked: true,
    regression,
    definition: 'the home (IN-SAMPLE) estate improves while at least one foreign (OUT-OF-SAMPLE) estate degrades',
    home_improved: Boolean(home?.improved),
    degraded_foreign_estates: degradedForeign.map(delta => delta.id),
    deltas,
    verdict: regression
      ? `REGRESSION: home improved while ${degradedForeign.map(delta => delta.id).join(', ')} degraded. This is the overfitting signature.`
      : home?.improved ? 'no regression: home improved and no foreign estate degraded'
        : degradedForeign.length ? `foreign estate(s) ${degradedForeign.map(delta => delta.id).join(', ')} degraded, but home did not improve -- a plain regression, not the asymmetry`
          : 'no regression detected',
  };
}

/* -------------------------------------------------------------- markdown --- */

const pct = (numerator, denominator) => (denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : 'n/a');

export function renderMarkdown(report) {
  const out = [];
  const home = report.estates.find(estate => estate.sample === SAMPLE_LABELS.IN_SAMPLE);
  const foreign = report.estates.filter(estate => estate.sample === SAMPLE_LABELS.OUT_OF_SAMPLE);

  out.push('# Multi-estate portability report');
  out.push('');
  out.push(`Generated ${report.generated_at} · schema \`${report.schema}\` · ${report.estates.length} estate(s).`);
  out.push('');
  out.push('> **There is deliberately no single headline survival number across estates.**');
  out.push('> Home at ~100% and foreign at ~30% average to a number that describes neither.');
  out.push('> Every figure below is per estate.');
  out.push('');

  out.push('## Sample labelling');
  out.push('');
  out.push('| Estate | Root | Sample | Meaning |');
  out.push('|---|---|---|---|');
  for (const estate of report.estates) {
    out.push(`| \`${estate.id}\` | \`${estate.root}\` | **${estate.sample}** | ${SAMPLE_LABEL_MEANING[estate.sample]} |`);
  }
  out.push('');

  out.push('## Per-estate census — knowledge families');
  out.push('');
  out.push(`| Family | Semantic? | ${report.estates.map(estate => `${estate.id}<br>(${estate.sample})`).join(' | ')} |`);
  out.push(`|---|---|${report.estates.map(() => '---:').join('|')}|`);
  for (const family of KNOWLEDGE_FAMILIES) {
    out.push(`| \`${family.id}\` | ${family.semantic ? 'yes' : 'no'} | ${report.estates.map(estate => estate.census.families[family.id] ?? 0).join(' | ')} |`);
  }
  out.push(`| **records total** | | ${report.estates.map(estate => `**${estate.census.records_total}**`).join(' | ')} |`);
  out.push(`| families populated | | ${report.estates.map(estate => estate.census.families_populated_ratio).join(' | ')} |`);
  out.push(`| semantic families populated | | ${report.estates.map(estate => estate.census.semantic_populated_ratio).join(' | ')} |`);
  out.push(`| graph nodes | | ${report.estates.map(estate => estate.census.nodes).join(' | ')} |`);
  out.push(`| records / node | | ${report.estates.map(estate => estate.census.records_per_node ?? 'n/a').join(' | ')} |`);
  out.push(`| refusals total | | ${report.estates.map(estate => estate.census.refusals_total).join(' | ')} |`);
  out.push(`| crashes | | ${report.estates.map(estate => estate.crashes.length).join(' | ')} |`);
  out.push(`| wall time | | ${report.estates.map(estate => `${(estate.wall_ms / 1000).toFixed(1)}s`).join(' | ')} |`);
  out.push('');

  out.push('## Per-estate census — semantic families');
  out.push('');
  out.push(`| Semantic family | ${report.estates.map(estate => estate.id).join(' | ')} |`);
  out.push(`|---|${report.estates.map(() => '---:').join('|')}|`);
  for (const family of SEMANTIC_FAMILIES) {
    out.push(`| \`${family.id}\` | ${report.estates.map(estate => estate.census.semantic_families[family.id] ?? 0).join(' | ')} |`);
  }
  out.push('');

  for (const estate of report.estates) {
    out.push(`## Estate: \`${estate.id}\` — ${estate.sample}`);
    out.push('');
    out.push(`Root \`${estate.root}\`${estate.head ? ` @ \`${estate.head}\`` : ''}. Discovered via ${estate.provenance.join(', ')}. Wall time ${(estate.wall_ms / 1000).toFixed(1)}s.`);
    if (estate.sample === SAMPLE_LABELS.IN_SAMPLE) {
      out.push('');
      out.push('> **IN-SAMPLE / contaminated by construction.** Every extractor in `tools/estate-map/**`');
      out.push('> was written against this estate. Its scores measure fit to the training set and are');
      out.push('> NOT evidence that the instrument generalises.');
    }
    out.push('');
    out.push('| Family | Records | Populated |');
    out.push('|---|---:|:--:|');
    for (const family of KNOWLEDGE_FAMILIES) {
      const value = estate.census.families[family.id] ?? 0;
      out.push(`| \`${family.id}\` | ${value} | ${value > 0 ? 'yes' : '**EMPTY**'} |`);
    }
    out.push('');
    out.push(`Deterministic precursors: interpretation slices ${estate.census.deterministic_precursors.interpretation_slices}, semantic spans ${estate.census.deterministic_precursors.semantic_spans}, semantic packets ${estate.census.deterministic_precursors.semantic_packets}.`);
    out.push('');
    out.push('**Refusals by class**');
    out.push('');
    const classes = Object.entries(estate.census.refusals_by_class).sort((a, b) => b[1] - a[1]);
    if (classes.length) {
      out.push('| Class | Count |');
      out.push('|---|---:|');
      for (const [name, count] of classes) out.push(`| \`${name}\` | ${count} |`);
    } else out.push('_none_');
    out.push('');
    out.push('**Passes**');
    out.push('');
    out.push('| Pass | Exit | Wall |');
    out.push('|---|:--:|---:|');
    for (const item of estate.passes) {
      out.push(`| \`${item.id}\` | ${item.skipped ? 'SKIP' : item.exit_code === 0 ? 'ok' : `**${item.exit_code}**`} | ${(item.wall_ms / 1000).toFixed(1)}s |`);
    }
    out.push('');
    if (estate.crashes.length) {
      out.push('**Crashes**');
      out.push('');
      out.push('| Pass | Exit | First stderr line |');
      out.push('|---|:--:|---|');
      for (const crash of estate.crashes) out.push(`| \`${crash.pass}\` | ${crash.exit_code} | ${(crash.first_stderr_line || '').slice(0, 160)} |`);
      out.push('');
    } else { out.push('**Crashes:** none.'); out.push(''); }
    out.push(`**Read-only violations:** ${estate.readonly_violations.length ? `**${estate.readonly_violations.join(', ')}**` : 'none'}`);
    out.push('');
    if (estate.portability_records.length) {
      out.push('**Typed portability records**');
      out.push('');
      out.push('| Type | Failure mode | Tool | Missing input |');
      out.push('|---|---|---|---|');
      for (const record of estate.portability_records.slice(0, 40)) {
        out.push(`| ${record.record_type} | \`${record.failure_mode}\` | \`${record.tool}\` | \`${record.missing_input ?? '(n/a)'}\` |`);
      }
      out.push('');
    }
  }

  if (home && foreign.length) {
    out.push('## Out-of-sample vs in-sample');
    out.push('');
    out.push('Ratios are stated PER FOREIGN ESTATE. They are not averaged.');
    out.push('');
    out.push('| Foreign estate | records | vs home | records/node | vs home | families | semantic families |');
    out.push('|---|---:|---:|---:|---:|:--:|:--:|');
    for (const estate of foreign) {
      out.push(`| \`${estate.id}\` | ${estate.census.records_total} | ${pct(estate.census.records_total, home.census.records_total)} | ${estate.census.records_per_node ?? 'n/a'} | ${home.census.records_per_node ? pct(estate.census.records_per_node, home.census.records_per_node) : 'n/a'} | ${estate.census.families_populated_ratio} | ${estate.census.semantic_populated_ratio} |`);
    }
    out.push('');
  }

  out.push('## Regression check');
  out.push('');
  out.push(`Definition: **${report.regression.definition ?? 'the home (IN-SAMPLE) estate improves while at least one foreign (OUT-OF-SAMPLE) estate degrades'}**.`);
  out.push('');
  out.push(report.regression.checked ? `Verdict: **${report.regression.verdict}**` : `Not checked — ${report.regression.why}`);
  out.push('');
  out.push('## Estate discovery');
  out.push('');
  for (const note of report.discovery.notes) out.push(`- ${note}`);
  out.push('');
  out.push(`${report.discovery.candidates.length} candidate(s) found; ${report.discovery.candidates.filter(item => item.independent).length} independent (not nested inside another candidate).`);
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ cli --- */

export async function runMultiEstate({ estates, outDir, baseline = null, discovery, generatedAt }) {
  const results = [];
  for (const estate of estates) results.push(await runEstate({ estate, outDir }));
  const report = {
    schema: MULTI_ESTATE_SCHEMA,
    generated_at: generatedAt,
    knowledge_families: KNOWLEDGE_FAMILIES,
    semantic_families: SEMANTIC_FAMILIES,
    sample_label_meaning: SAMPLE_LABEL_MEANING,
    // Stated as an explicit property of the report rather than left implicit, so a
    // consumer that tries to average these estates has to override a stated refusal.
    aggregate_policy: 'PER-ESTATE ONLY. No cross-estate aggregate survival number is emitted: averaging an in-sample estate with an out-of-sample estate produces a figure that describes neither and hides the portability gap.',
    discovery,
    estates: results,
  };
  report.regression = detectRegression(report, baseline);
  return report;
}

async function main() {
  const { options } = parseMultiEstateArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }

  const scratchDir = process.env.ASCRYBE_SCRATCH_DIR || path.join(os.tmpdir(), 'estate-map-multi');
  await fsPromises.mkdir(scratchDir, { recursive: true });
  const homeRoot = path.resolve(options.home || REPO_ROOT);
  const discovery = await discoverEstates({ registryPath: options.registry || null, scratchDir, homeRoot });

  if (options['list-estates']) {
    console.log(stableStringify(discovery));
    return;
  }

  const rawEstates = [].concat(options.estate || []).filter(Boolean);
  const maxEstates = Number(options['max-estates'] ?? 3);
  let selected;
  if (rawEstates.length) {
    selected = rawEstates.map(value => {
      const [rootPart, labelPart] = String(value).split('=');
      const root = path.resolve(rootPart);
      const found = discovery.candidates.find(candidate => candidate.root === root);
      return { root, id: labelPart || path.basename(root), provenance: found?.provenance || ['--estate flag'] };
    });
  } else {
    // Auto-selection is REPORTED, never silent: the chosen set and the reason land in the
    // report's discovery block so a reader can see what was and was not measured.
    const independent = discovery.candidates.filter(candidate => candidate.independent && candidate.root !== homeRoot);
    selected = [{ root: homeRoot, id: path.basename(homeRoot), provenance: ['--home default'] },
      ...independent.slice(0, maxEstates).map(candidate => ({ root: candidate.root, id: path.basename(candidate.root), provenance: candidate.provenance }))];
    discovery.notes.push(`auto-selected ${selected.length} estate(s) (home + up to ${maxEstates} independent foreign); pass --estate to choose explicitly`);
  }

  for (const estate of selected) {
    estate.sample = path.resolve(estate.root) === homeRoot ? SAMPLE_LABELS.IN_SAMPLE : SAMPLE_LABELS.OUT_OF_SAMPLE;
    registerScanRoot(estate.root, { registeredBy: `multi-estate ${estate.id}` });
  }

  const outDir = options.out
    ? path.resolve(options.out)
    : path.join(outputRootBase(), 'multi-estate', crypto.createHash('sha256').update(selected.map(estate => estate.root).join('\0')).digest('hex').slice(0, 8));
  // The report directory must be outside EVERY estate under test, including the home
  // estate. Checked here, loudly, rather than discovered halfway through a 20-minute run.
  assertWritable(outDir, { op: 'write the multi-estate report', tool: 'multi-estate' });
  await fs.mkdir(outDir, { recursive: true });

  const baseline = options.baseline ? await readJsonIfPresent(path.resolve(options.baseline)) : null;
  if (options.baseline && !baseline) console.warn(`multi-estate: --baseline ${options.baseline} could not be read; regression detection is DISABLED for this run.`);

  const report = await runMultiEstate({ estates: selected, outDir, baseline, discovery, generatedAt: options.now || new Date().toISOString() });
  await fs.writeFile(path.join(outDir, 'multi-estate-report.json'), stableStringify(report));
  await fs.writeFile(path.join(outDir, 'multi-estate-report.md'), `${renderMarkdown(report)}\n`);

  if (options.json) console.log(stableStringify(report));
  else {
    console.log(renderMarkdown(report));
    console.log(`\nWrote ${path.join(outDir, 'multi-estate-report.json')}`);
    console.log(`Wrote ${path.join(outDir, 'multi-estate-report.md')}`);
  }
  // A read-only violation anywhere is fatal to the run's credibility, and a detected
  // regression is the finding this harness exists to surface. Both must be non-zero exits
  // so this can be wired into a gate without anyone re-reading the prose.
  const violations = report.estates.flatMap(estate => estate.readonly_violations);
  if (violations.length) { console.error(`READ-ONLY VIOLATIONS: ${violations.join(', ')}`); process.exitCode = 2; }
  else if (report.regression.regression) process.exitCode = 3;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
