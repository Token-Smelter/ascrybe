#!/usr/bin/env node
// Canonical deterministic Ascrybe build. Operator entrypoints call this module
// instead of maintaining divergent command lists.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsNative from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from './readonly-guard.mjs';
import { assertWritable, registerScanRoot, SCAN_ROOT_ENV } from './readonly-guard.mjs';
import { discoverRepositories } from './extract.mjs';
import { normalizePath, parseArgs, readEstateMapIgnore, stableStringify, walk } from './lib.mjs';

export const PIPELINE_SCHEMA = 'estate-map/canonical-pipeline-manifest/v1';
export const PIPELINE_VERSION = '1';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');

// This is the single ordered registry. A stage either executes through this registry
// or has a receipt explaining why it did not. Model application stages deliberately
// stay in the DAG: their absence must be observable, not inferred from an empty array.
export const CANONICAL_STAGE_REGISTRY = Object.freeze([
  { id: 'extract', deterministic: true, depends_on: [], outputs: ['facts', 'extract-manifest'] },
  { id: 'merge', deterministic: true, depends_on: ['extract'], outputs: ['graph', 'graph-digest'] },
  { id: 'groundpacks', deterministic: true, depends_on: ['merge'], outputs: ['groundpacks'] },
  { id: 'connectivity-analysis', deterministic: true, depends_on: ['merge'], outputs: ['connectivity-report'] },
  { id: 'entity-discovery', deterministic: true, depends_on: ['merge'], outputs: ['discovery-report'] },
  { id: 'ddd-overlays', deterministic: true, depends_on: ['merge'], outputs: ['ddd-overlays'] },
  { id: 'domain-derivation', deterministic: true, depends_on: ['merge'], outputs: ['domain-overlays', 'domain-refusals'] },
  { id: 'domain-prepass', deterministic: true, depends_on: ['ddd-overlays', 'domain-derivation'], outputs: ['domain-prepass-assignments', 'domain-prepass-receipts'] },
  { id: 'structural-grouping', deterministic: true, depends_on: ['merge'], outputs: ['structural-overlays', 'structural-unclassified'] },
  { id: 'entity-layer', deterministic: true, depends_on: ['entity-discovery'], outputs: ['entity-layer', 'entity-census'] },
  { id: 'loop-diagnosis', deterministic: true, depends_on: ['entity-discovery'], outputs: ['queue-diagnosis'] },
  // Step-3 WP3 prepares records before merging so every canonical projection sees them.
  { id: 'l1-prepare', deterministic: true, depends_on: ['loop-diagnosis'], outputs: ['candidate-packets', 'l1-prepare-receipt', 'adjudication-records'] },
  { id: 'merge-deterministic-overlays', deterministic: true, depends_on: ['ddd-overlays', 'domain-derivation', 'domain-prepass', 'structural-grouping', 'entity-layer', 'l1-prepare'], outputs: ['annotated-graph'] },
  { id: 'conservation', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['conservation-report'] },
  { id: 'semantic-spans', deterministic: true, depends_on: ['merge'], outputs: ['text-spans'] },
  { id: 'semantic-packets', deterministic: true, depends_on: ['semantic-spans'], outputs: ['semantic-packets'] },
  { id: 'interpretation-slices', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['interpretation-slices'] },
  { id: 'interpretation-packets', deterministic: true, depends_on: ['interpretation-slices'], outputs: ['interpretation-packets'] },
  { id: 'dataflow-skeletons', deterministic: true, depends_on: ['merge'], outputs: ['dataflow-skeletons', 'dataflow-refusals'] },
  { id: 'semantic-apply', deterministic: false, depends_on: ['semantic-packets'], outputs: ['semantic-layer'], availability: 'requires_model' },
  { id: 'interpretation-apply', deterministic: false, depends_on: ['interpretation-packets'], outputs: ['interpretation-layer'], availability: 'requires_model' },
  { id: 'dataflow-apply', deterministic: false, depends_on: ['dataflow-skeletons'], outputs: ['dataflow-layer'], availability: 'requires_model' },
  { id: 'l1-adjudication', deterministic: false, depends_on: ['l1-prepare'], outputs: ['adjudication-ledger', 'ingested-receipts'], availability: 'requires_model' },
  { id: 'agent-projection', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['agent-bundle', 'resource-manifest'] },
  { id: 'graph-index', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['graph-index'] },
  { id: 'atlas', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['atlas', 'atlas-census'] },
  { id: 'explorer', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['explorer'] },
  // Cartography Spine v0: a deterministic VIEW COMPILER over the annotated graph. It emits the
  // persisted cartographic record set (scopes / memberships / edge bundles / connectivity +
  // orphan diagnostics / layout slots / change records) plus BOTH human view records and LLM
  // JSONL tiles from one shared view-model, then the atlas HTML LAST (only after the view-model
  // passes conservation). An UNACCOUNTED node fails this stage loudly.
  { id: 'cartography', deterministic: true, depends_on: ['merge-deterministic-overlays'], outputs: ['cartography', 'cartography-view-model', 'cartography-html'] },
]);

const stage = id => CANONICAL_STAGE_REGISTRY.find(item => item.id === id);

// Every dependency is hard unless the registry names it in optional_depends_on. This makes
// stale/unavailable ancestors contagious rather than letting a descendant read old files.
export function blockingDependencies(definition, receipts) {
  const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const optionalDependencies = new Set(definition.optional_depends_on || []);
  return definition.depends_on
    .map(id => byId.get(id))
    .filter(receipt => !optionalDependencies.has(receipt?.id) && receipt?.status !== 'success');
}

export const REQUIRED_FAMILY_STAGES = Object.freeze([
  'groundpacks', 'connectivity-analysis', 'conservation', 'entity-discovery',
  'domain-derivation', 'domain-prepass', 'structural-grouping', 'entity-layer', 'semantic-spans',
  'interpretation-slices', 'dataflow-skeletons', 'l1-prepare', 'semantic-apply',
  'interpretation-apply', 'dataflow-apply', 'agent-projection', 'graph-index',
  'atlas', 'explorer', 'cartography',
]);
// Some deterministic stages truthfully emit an empty candidate set on a foreign estate.
// Their zero count remains visible in the receipt; it is not a failed producer. These
// families instead require a nonempty report/view artifact, not a populated candidate set.
export const NONEMPTY_REQUIRED_FAMILY_STAGES = new Set([
  'groundpacks', 'entity-discovery', 'domain-derivation', 'domain-prepass', 'structural-grouping',
  'entity-layer', 'agent-projection', 'graph-index', 'atlas', 'explorer', 'cartography',
]);
const SUCCESSFUL_REQUIRED_STATUSES = new Set(['success']);
const MODEL_REQUIRED_STATUSES = new Set(['success', 'requires_model']);

export function assertCanonicalCompleteness(manifest) {
  if (manifest?.schema !== PIPELINE_SCHEMA || !Array.isArray(manifest.stages)) throw new Error('canonical manifest is missing or has an unknown schema');
  const byId = new Map(manifest.stages.map(item => [item.id, item]));
  for (const definition of CANONICAL_STAGE_REGISTRY) {
    const receipt = byId.get(definition.id);
    if (!receipt) throw new Error(`canonical manifest omitted stage receipt: ${definition.id}`);
    if (!['success', 'requires_model', 'unavailable', 'stale', 'failed'].includes(receipt.status)) throw new Error(`canonical manifest has untyped stage status: ${definition.id}`);
    if (receipt.status !== 'success' && !receipt.reason) throw new Error(`non-success stage lacks a reason: ${definition.id}`);
    if (receipt.status === 'success' && Object.values(receipt.output_digests || {}).some(value => value === null)) throw new Error(`successful stage has a missing output: ${definition.id}`);
    if (!Number.isInteger(receipt.output_count) || receipt.output_count < 0) throw new Error(`stage receipt has an invalid output count: ${definition.id}`);
    if (!Array.isArray(receipt.inputs) || !receipt.input_digests || Object.keys(receipt.input_digests).length !== receipt.inputs.length) throw new Error(`stage receipt does not bind every declared input: ${definition.id}`);
  }
  for (const id of REQUIRED_FAMILY_STAGES) {
    const receipt = byId.get(id);
    if (!receipt) throw new Error(`canonical manifest omitted required knowledge family: ${id}`);
    const allowed = stage(id).availability === 'requires_model' ? MODEL_REQUIRED_STATUSES : SUCCESSFUL_REQUIRED_STATUSES;
    if (!allowed.has(receipt.status)) throw new Error(`required knowledge family is not admissible: ${id}=${receipt.status}`);
    if (NONEMPTY_REQUIRED_FAMILY_STAGES.has(id) && receipt.status === 'success' && receipt.output_count === 0) throw new Error(`required knowledge family has no evidence records: ${id}`);
  }
  for (const id of ['atlas', 'explorer']) if (byId.get(id)?.status !== 'success') throw new Error(`required view is not fresh: ${id}=${byId.get(id)?.status || 'missing'}`);
  return true;
}
const exists = async target => fsNative.access(target).then(() => true, () => false);
const lstatOrNull = async target => fsNative.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
const relative = (root, target) => path.relative(root, target).split(path.sep).join('/');

// POSIX can atomically replace a symlink but cannot atomically replace a non-empty
// directory. Canonical outputs therefore publish immutable revisions through an
// atomic symlink swap: readers resolve either complete revision, never no revision.
export async function promoteCanonicalOutput(staging, out) {
  const safeStaging = assertWritable(staging, { op: 'promote canonical staging output', tool: 'pipeline.mjs' });
  const safeOut = assertWritable(out, { op: 'promote canonical output', tool: 'pipeline.mjs' });
  const parent = assertWritable(path.dirname(safeOut), { op: 'publish canonical output parent', tool: 'pipeline.mjs' });
  const base = path.basename(safeOut);
  const revisionPrefix = `.${base}.revision-`;
  const revision = assertWritable(path.join(parent, `${revisionPrefix}${crypto.randomUUID()}`), { op: 'create canonical output revision', tool: 'pipeline.mjs' });
  const pending = assertWritable(path.join(parent, `.${base}.next-${crypto.randomUUID()}`), { op: 'create pending canonical output link', tool: 'pipeline.mjs' });
  try {
    await fsNative.rename(safeStaging, revision);
    const current = await lstatOrNull(safeOut);
    if (current && !current.isSymbolicLink()) {
      if (!current.isDirectory() || (await fsNative.readdir(safeOut)).length) {
        throw new Error(`canonical output ${safeOut} must be a symlink or an empty directory; publish to a new --out path to migrate a legacy directory without exposing partial output`);
      }
      // First publication only: an empty caller-created directory has no reader-visible
      // artifact to preserve. Every refresh afterwards swaps a symlink atomically.
      await fsNative.rmdir(safeOut);
    }
    await fsNative.symlink(revision, pending, 'dir');
    await fsNative.rename(pending, safeOut);
  } catch (error) {
    await fsNative.rm(pending, { force: true });
    await fsNative.rm(revision, { recursive: true, force: true });
    throw error;
  }
  // Retain the prior immutable revision. A reader may have resolved its symlink just
  // before this exchange; deleting that directory would reintroduce a reader-visible
  // ENOENT race after an otherwise atomic pointer swap.
  return revision;
}

// Each receipt binds this directory as its producer source closure. Ascrybe CLIs
// import helpers from this tree, so hashing only the invoked entry module would let a
// transitive helper change without changing the stage's declared inputs.
export async function digestPath(target, { followTopLevelDirectorySymlinks = false } = {}) {
  if (!await exists(target)) return null;
  const stat = await fsNative.stat(target);
  if (stat.isFile()) return crypto.createHash('sha256').update(await fsNative.readFile(target)).digest('hex');
  const files = [];
  const visitedDirectories = new Set();
  const visit = async (current, { topLevel = false } = {}) => {
    // extract.mjs accepts immediate-child directory symlinks as components, resolving
    // and deduplicating their targets before it scans. Match that contract here so an
    // extract receipt binds every source tree the extractor can consume, without
    // following nested symlinks that walk() deliberately records as skipped.
    const real = await fsNative.realpath(current);
    if (visitedDirectories.has(real)) return;
    visitedDirectories.add(real);
    for (const item of (await fsNative.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, item.name);
      if (item.isDirectory()) await visit(child);
      else if (topLevel && followTopLevelDirectorySymlinks && item.isSymbolicLink()) {
        const targetStat = await fsNative.stat(child).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (targetStat?.isDirectory()) await visit(child);
      }
      else if (item.isFile()) files.push([relative(target, child), crypto.createHash('sha256').update(await fsNative.readFile(child)).digest('hex')]);
    }
  };
  await visit(target, { topLevel: true });
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

// `extract.mjs` deliberately excludes dependencies, build output, linked worktrees, and
// ignored paths. Binding the raw estate directory would make content it never reads alter
// every receipt. This manifest uses the extractor's actual discovery and walk functions,
// so it identifies precisely the normalized source inputs that can reach facts.
export async function digestNormalizedEstateInputs(estate) {
  const ignorePrefixes = await readEstateMapIgnore(estate);
  const discovered = await discoverRepositories(estate, { ignorePrefixes });
  const selections = (discovered.selections || discovered.repos.map(item => ({ ...item, status: 'ready' })))
    .map(({ name, path: componentPath, status, error }) => ({
      name,
      root: normalizePath(path.relative(estate, componentPath)) || '.',
      status,
      error: error || null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const component of selections.filter(item => item.status === 'ready')) {
    const componentPath = path.join(estate, component.root);
    const scanned = await walk(componentPath, { ignorePrefixes, estateRelativeRoot: component.root });
    for (const file of scanned.files) {
      files.push([
        normalizePath(path.relative(estate, file)),
        crypto.createHash('sha256').update(await fsNative.readFile(file)).digest('hex'),
      ]);
    }
  }
  files.sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(stableStringify({
    schema: 'estate-map/extract-normalized-inputs/v1',
    ignore_prefixes: ignorePrefixes,
    selections,
    files,
  })).digest('hex');
}

export class CanonicalPipelineError extends Error {
  constructor(message, diagnostic, { cause } = {}) {
    super(message, { cause });
    this.name = 'CanonicalPipelineError';
    this.diagnostic = diagnostic;
  }
}

async function countRecords(target) {
  if (!await exists(target)) return 0;
  const stat = await fsNative.stat(target);
  if (stat.isFile()) return (await fsNative.readFile(target, 'utf8')).split(/\r?\n/).filter(Boolean).length;
  let count = 0;
  for (const item of await fsNative.readdir(target, { withFileTypes: true })) {
    if (item.isFile()) count += 1;
  }
  return count;
}

export function runStage(args, estateRoot) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, [SCAN_ROOT_ENV]: estateRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ exit_code: null, stdout, stderr: `${stderr}${error.message}`, spawn_error: error.message }));
    child.on('close', exit_code => resolve({ exit_code, stdout, stderr, spawn_error: null }));
  });
}

function statusFor({ result, outputCount, outputsPresent, optional = false, reason = null }) {
  if (result.exit_code !== 0) return { status: 'failed', reason: reason || (result.stderr.trim().split('\n').filter(Boolean).at(-1) || `exit ${result.exit_code}`) };
  if (!outputsPresent) return { status: 'unavailable', reason: reason || `producer completed without its declared output (${outputCount} records)` };
  if (outputCount === 0 && !optional) return { status: 'unavailable', reason: reason || 'producer completed without evidence records' };
  return { status: 'success', reason: null };
}

export async function runCanonicalPipeline({ estateRoot, outDir, generatedAt = '2026-07-28T00:00:00Z', executeStage = runStage }) {
  const estate = path.resolve(estateRoot);
  registerScanRoot(estate, { registeredBy: 'canonical-pipeline estate-root argument' });
  const out = assertWritable(path.resolve(outDir), { op: 'write canonical pipeline output', tool: 'pipeline.mjs' });
  const outputParent = assertWritable(path.dirname(out), { op: 'create canonical pipeline output parent', tool: 'pipeline.mjs' });
  await fs.mkdir(outputParent, { recursive: true });
  // A run never reads from its destination. annotate.mjs merges every JSONL it finds,
  // so reusing `out/overlays` could otherwise import an old model proposal.
  const stagingPrefix = assertWritable(path.join(outputParent, `.${path.basename(out)}.staging-`), { op: 'create canonical pipeline staging output', tool: 'pipeline.mjs' });
  let staging = await fsNative.mkdtemp(stagingPrefix);
  let receipts = [];
  try {
  const at = (...parts) => path.join(staging, ...parts);
  const graph = at('graph', 'estate-graph.json');
  const annotated = at('graph', 'estate-graph.annotated.json');

  const inputKey = item => item.startsWith(staging) ? relative(staging, item) : relative(REPO_ROOT, item);
  const digestInput = item => item === estate ? digestNormalizedEstateInputs(estate) : digestPath(item);
  const producerInputs = inputs => [...new Set([...inputs, TOOL_DIR])];
  const bindInputs = async inputs => Object.fromEntries(await Promise.all(producerInputs(inputs).map(async item => [inputKey(item), await digestInput(item)])));
  const execute = async (id, args, outputs, { inputs = [], optional = false, emptyReason = null, contentPaths = outputs } = {}) => {
    const declaredInputs = producerInputs(inputs);
    const definition = stage(id);
    // No canonical edge is optional today. An optional edge must be declared in the
    // registry, never inferred from an absent or stale predecessor.
    const blocked = blockingDependencies(definition, receipts);
    if (blocked.length) {
      receipts.push({
        id, deterministic: definition.deterministic, depends_on: definition.depends_on,
        inputs: declaredInputs.map(inputKey), outputs: outputs.map(item => relative(staging, item)),
        input_digests: await bindInputs(inputs), output_digests: Object.fromEntries(outputs.map(item => [relative(staging, item), null])),
        status: 'stale', reason: `upstream stage is not fresh: ${blocked.map(row => `${row.id}=${row.status}`).join(', ')}`,
        exit_code: null, output_count: 0,
      });
      return;
    }
    // Snapshot the exact pre-execution inputs. Some producers write beside their inputs
    // (notably annotate into graph/), so post-run hashing cannot prove what was consumed.
    const inputDigests = await bindInputs(inputs);
    const result = await executeStage(args, estate, id);
    const outputCount = (await Promise.all(contentPaths.map(countRecords))).reduce((sum, value) => sum + value, 0);
    const outputsPresent = (await Promise.all(outputs.map(exists))).every(Boolean);
    const outcome = statusFor({ result, outputCount, outputsPresent, optional, reason: emptyReason });
    receipts.push({
      id, deterministic: definition.deterministic, depends_on: definition.depends_on,
      inputs: declaredInputs.map(inputKey), outputs: outputs.map(item => relative(staging, item)),
      input_digests: inputDigests,
      output_digests: Object.fromEntries(await Promise.all(outputs.map(async item => [relative(staging, item), await digestPath(item)]))),
      status: outcome.status, reason: outcome.reason, exit_code: result.exit_code, output_count: outputCount,
      readonly_violation: /ASCRYBE_READONLY_VIOLATION/.test(result.stderr),
    });
  };
  const receipt = async (id, status, reason, outputs = [], inputs = []) => {
    const definition = stage(id);
    const declaredInputs = producerInputs(inputs);
    receipts.push({
      id, deterministic: definition.deterministic, depends_on: definition.depends_on,
      inputs: declaredInputs.map(inputKey), outputs: outputs.map(item => relative(staging, item)),
      input_digests: await bindInputs(inputs),
      output_digests: Object.fromEntries(await Promise.all(outputs.map(async item => [relative(staging, item), await digestPath(item)]))),
      status, reason, exit_code: null, output_count: 0,
    });
  };

  const tool = name => path.join(TOOL_DIR, name);
  await execute('extract', [tool('extract.mjs'), estate, '--out', at('facts')], [at('facts'), at('facts', '_MANIFEST.json')], { inputs: [tool('extract.mjs'), estate] });
  await execute('merge', [tool('merge.mjs'), at('facts', 'facts'), '--out', at('graph')], [graph, at('graph', 'digest.txt')], { inputs: [tool('merge.mjs'), at('facts', 'facts')] });
  await execute('groundpacks', [tool('groundpack.mjs'), estate, at('graph'), '--seams', '--out', at('evidence', 'groundpacks')], [at('evidence', 'groundpacks')], { inputs: [tool('groundpack.mjs'), estate, graph] });
  await execute('connectivity-analysis', [tool('analyze-connectivity.mjs'), '--graph', graph, '--facts', at('facts', 'facts'), '--out', at('connectivity.json')], [at('connectivity.json')], { inputs: [tool('analyze-connectivity.mjs'), graph, at('facts', 'facts')] });
  await execute('entity-discovery', [tool('discover-entities.mjs'), estate, '--out', at('discovery'), '--generated-at', generatedAt], [at('discovery', 'discovery-report.json')], { inputs: [tool('discover-entities.mjs'), estate] });
  await execute('ddd-overlays', [tool('ddd-overlays.mjs'), graph, at('overlays', 'ddd.jsonl'), '--generated-at', generatedAt], [at('overlays', 'ddd.jsonl')], { inputs: [tool('ddd-overlays.mjs'), graph], optional: true });
  await execute('domain-derivation', [tool('domain-derivation.mjs'), graph, at('overlays', 'derived.jsonl'), '--census', at('census', 'derived.json'), '--refusals', at('overlays', 'derived.refusals.jsonl'), '--generated-at', generatedAt], [at('overlays', 'derived.jsonl'), at('overlays', 'derived.refusals.jsonl'), at('census', 'derived.json')], { inputs: [tool('domain-derivation.mjs'), graph], optional: true, contentPaths: [at('overlays', 'derived.jsonl'), at('overlays', 'derived.refusals.jsonl')] });
  await execute('domain-prepass', [tool('domain-prepass.mjs'), graph, at('overlays', 'ddd.jsonl'), at('overlays', 'domain-prepass.jsonl'), at('overlays', 'domain-prepass.domain-prepass.jsonl'), '--existing', at('overlays', 'derived.jsonl'), '--generated-at', generatedAt], [at('overlays', 'domain-prepass.jsonl'), at('overlays', 'domain-prepass.domain-prepass.jsonl')], { inputs: [tool('domain-prepass.mjs'), graph, at('overlays', 'ddd.jsonl'), at('overlays', 'derived.jsonl')], optional: true, contentPaths: [at('overlays', 'domain-prepass.domain-prepass.jsonl')] });
  await execute('structural-grouping', [tool('structural-grouping.mjs'), graph, at('overlays', 'structural.jsonl'), '--census', at('census', 'structural.json'), '--generated-at', generatedAt], [at('overlays', 'structural.jsonl'), at('overlays', 'structural.structural-unclassified.jsonl'), at('census', 'structural.json')], { inputs: [tool('structural-grouping.mjs'), graph], optional: true, contentPaths: [at('overlays', 'structural.jsonl'), at('overlays', 'structural.structural-unclassified.jsonl')] });
  await execute('entity-layer', [tool('entity-layer.mjs'), graph, at('overlays', 'entities.entity-layer.jsonl'), '--facts', at('facts', 'facts'), '--estate', estate, '--discovery', at('discovery', 'discovery-report.json'), '--census', at('census', 'entity.json')], [at('overlays', 'entities.entity-layer.jsonl'), at('census', 'entity.json')], { inputs: [tool('entity-layer.mjs'), graph, at('facts', 'facts'), estate, at('discovery', 'discovery-report.json')], optional: true, contentPaths: [at('overlays', 'entities.entity-layer.jsonl'), at('census', 'entity.json')] });
  await execute('loop-diagnosis', [tool('loop-driver.mjs'), estate, '--state', at('loop'), '--l1-state', at('l1'), '--work', at('loop-work'), '--now', generatedAt], [at('loop', 'latest-verdict.json'), at('loop', 'latest-census-vector.json'), at('loop', 'latest-active-vector.json')], { inputs: [tool('loop-driver.mjs'), tool('l1-adjudicate.mjs'), tool('reconciliation-edges.mjs'), estate, at('l1')], optional: true, emptyReason: 'no active queue diagnosis was persisted' });
  await execute('l1-prepare', [tool('l1-adjudicate.mjs'), 'prepare', at('loop-work'), '--out', at('l1', 'candidate-packets.jsonl'), '--records-out', at('overlays', 'l1-prepare.adjudication-records.jsonl'), '--now', generatedAt], [at('l1', 'candidate-packets.jsonl'), at('l1', 'l1-prepare-receipt.json'), at('overlays', 'l1-prepare.adjudication-records.jsonl')], { inputs: [tool('l1-adjudicate.mjs'), tool('adjudication-schema.mjs'), at('loop-work')], optional: true, contentPaths: [at('l1', 'l1-prepare-receipt.json'), at('overlays', 'l1-prepare.adjudication-records.jsonl')] });
  await execute('merge-deterministic-overlays', [tool('annotate.mjs'), 'merge', at('graph'), at('overlays')], [annotated], { inputs: [tool('annotate.mjs'), at('graph'), at('overlays'), at('overlays', 'l1-prepare.adjudication-records.jsonl')] });
  await execute('conservation', [tool('conservation.mjs'), at('facts', 'facts'), annotated, '--out', at('conservation.json')], [at('conservation.json')], { inputs: [tool('conservation.mjs'), at('facts', 'facts'), annotated] });
  await execute('semantic-spans', [tool('semantic-layer.mjs'), 'spans', estate, '--out', at('semantic', 'spans.jsonl')], [at('semantic', 'spans.jsonl')], { inputs: [tool('semantic-layer.mjs'), estate], optional: true });
  await execute('semantic-packets', [tool('semantic-layer.mjs'), 'packets', at('semantic', 'spans.jsonl'), '--out', at('semantic', 'packets.jsonl')], [at('semantic', 'packets.jsonl')], { inputs: [tool('semantic-layer.mjs'), at('semantic', 'spans.jsonl')], optional: true });
  await execute('interpretation-slices', [tool('interpretation-layer.mjs'), 'slices', annotated, '--out', at('interpretation', 'slices.jsonl')], [at('interpretation', 'slices.jsonl')], { inputs: [tool('interpretation-layer.mjs'), annotated], optional: true });
  await execute('interpretation-packets', [tool('interpretation-layer.mjs'), 'packets', annotated, at('interpretation', 'slices.jsonl'), '--out', at('interpretation', 'packets.jsonl')], [at('interpretation', 'packets.jsonl')], { inputs: [tool('interpretation-layer.mjs'), annotated, at('interpretation', 'slices.jsonl')], optional: true });
  await execute('dataflow-skeletons', [tool('dataflow-layer.mjs'), 'skeletons', estate, at('dataflow'), '--generated-at', generatedAt], [at('dataflow', 'skeletons.jsonl'), at('dataflow', 'skeleton-refusals.jsonl'), at('dataflow', 'extraction-census.json')], { inputs: [tool('dataflow-layer.mjs'), estate], optional: true });
  const modelReceipt = async (id, output, inputs, description) => {
    const blocked = stage(id).depends_on.map(dependency => receipts.find(row => row.id === dependency)).filter(row => row?.status !== 'success');
    await receipt(id, blocked.length ? 'stale' : 'requires_model', blocked.length ? `model stage blocked by non-fresh precursor: ${blocked.map(row => `${row.id}=${row.status}`).join(', ')}` : description, [output], inputs);
  };
  await modelReceipt('semantic-apply', at('semantic', 'semantic-layer.jsonl'), [at('semantic', 'packets.jsonl')], 'model-authored claims were not supplied; deterministic spans and packets are fresh');
  await modelReceipt('interpretation-apply', at('interpretation', 'interpretation.interpretation-layer.jsonl'), [at('interpretation', 'packets.jsonl')], 'model-authored interpretations were not supplied; deterministic slices and packets are fresh');
  await modelReceipt('dataflow-apply', at('dataflow', 'dataflow.dataflow-layer.jsonl'), [at('dataflow', 'skeletons.jsonl')], 'model-authored dataflow claims were not supplied; deterministic skeletons and refusals are fresh');
  await modelReceipt('l1-adjudication', at('l1', 'adjudication-ledger.jsonl'), [at('l1', 'candidate-packets.jsonl')], 'no neural adjudicator is configured; no adjudication ledger was fabricated');
  await execute('agent-projection', [tool('agent-projection.mjs'), 'all', annotated, '--out-dir', at('agent'), '--generated-at', generatedAt], [at('agent', 'resource-manifest.json'), at('agent', 'estate-brief.md')], { inputs: [tool('agent-projection.mjs'), annotated] });
  await execute('graph-index', [tool('index.mjs'), '--graph', annotated, '--out', at('index', 'estate.db')], [at('index', 'estate.db')], { inputs: [tool('index.mjs'), annotated] });
  await execute('atlas', [tool('atlas.mjs'), annotated, '--out', at('estate-atlas.html'), '--census-json', at('atlas-census.json')], [at('estate-atlas.html'), at('atlas-census.json')], { inputs: [tool('atlas.mjs'), annotated] });
  await execute('explorer', [tool('render.mjs'), annotated, '--out', at('estate-map.html'), '--atlas', 'estate-atlas.html'], [at('estate-map.html')], { inputs: [tool('render.mjs'), annotated, at('estate-atlas.html')] });
  await execute('cartography', [tool('cartography/cli.mjs'), annotated, '--out', at('cartography'), '--generated-at', generatedAt], [at('cartography'), at('cartography', 'view-model.json'), at('cartography', 'estate-cartography.html')], { inputs: [tool('cartography'), annotated], contentPaths: [at('cartography', 'scopes.jsonl'), at('cartography', 'memberships.jsonl'), at('cartography', 'tiles.jsonl')] });

  const graphDigest = await fsNative.readFile(at('graph', 'digest.txt'), 'utf8').then(value => value.trim(), () => null);
  const manifest = {
    schema: PIPELINE_SCHEMA, version: PIPELINE_VERSION, generated_at: generatedAt,
    estate: { root: estate, digest: await digestInput(estate) },
    graph: { path: relative(staging, graph), digest: graphDigest, annotated_path: relative(staging, annotated), annotated_digest: await digestPath(annotated) },
    stages: receipts,
    contract: { deterministic_stage_ids: CANONICAL_STAGE_REGISTRY.filter(item => item.deterministic).map(item => item.id), model_stage_ids: CANONICAL_STAGE_REGISTRY.filter(item => !item.deterministic).map(item => item.id), statuses: ['success', 'requires_model', 'unavailable', 'stale', 'failed'] },
  };
  assertCanonicalCompleteness(manifest);
  manifest.digest = crypto.createHash('sha256').update(stableStringify(manifest)).digest('hex');
  const manifestPath = at('estate-map-manifest.json');
  await fs.writeFile(manifestPath, `${stableStringify(manifest)}\n`);
  await promoteCanonicalOutput(staging, out);
  staging = null;
  return {
    manifest,
    manifestPath: path.join(out, 'estate-map-manifest.json'),
    outDir: out,
    graph: path.join(out, 'graph', 'estate-graph.json'),
    annotated: path.join(out, 'graph', 'estate-graph.annotated.json'),
    receipts,
  };
  } catch (error) {
    if (!staging) throw error;
    const failed = assertWritable(path.join(outputParent, `.${path.basename(out)}.failed-${crypto.randomUUID()}`), { op: 'preserve failed canonical pipeline diagnostics', tool: 'pipeline.mjs' });
    const failure = {
      schema: 'estate-map/canonical-pipeline-failure/v1',
      generated_at: generatedAt,
      estate: { root: estate, digest: await digestNormalizedEstateInputs(estate).catch(() => null) },
      failure: { name: error.name, message: error.message },
      stages: receipts,
    };
    try {
      await fs.writeFile(path.join(staging, 'estate-map-failure.json'), `${stableStringify(failure)}\n`);
      await fsNative.rename(staging, failed);
      staging = null;
    } catch {
      await fsNative.rm(staging, { recursive: true, force: true });
      throw error;
    }
    throw new CanonicalPipelineError(error.message, {
      outDir: failed,
      manifestPath: path.join(failed, 'estate-map-failure.json'),
      graph: path.join(failed, 'graph', 'estate-graph.json'),
      annotated: path.join(failed, 'graph', 'estate-graph.annotated.json'),
      receipts,
      failure,
    }, { cause: error });
  }
}

const HELP = `Usage: node tools/estate-map/pipeline.mjs <estate-root> --out <directory> [--generated-at <iso>]\n\nRuns the canonical deterministic Ascrybe DAG. Output must be outside the scanned estate.`;
if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0] || !options.out) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await runCanonicalPipeline({ estateRoot: positional[0], outDir: options.out, generatedAt: options['generated-at'] });
    console.log(`Manifest ${result.manifestPath}`);
    console.log(`Explorer ${path.join(result.outDir, 'estate-map.html')}`);
    console.log(`Atlas ${path.join(result.outDir, 'estate-atlas.html')}`);
    const failed = result.receipts.filter(item => item.status === 'failed');
    if (failed.length) { console.error(`Failed stages: ${failed.map(item => item.id).join(', ')}`); process.exitCode = 1; }
  } catch (error) { console.error(error.stack || error.message); process.exit(1); }
}
