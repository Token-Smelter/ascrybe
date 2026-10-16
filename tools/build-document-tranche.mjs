#!/usr/bin/env node
// Deterministically freezes a document-level tranche. Selection uses one representative window per
// document, but inference includes every conserved window belonging to each selected document.
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepassDocument } from './source-prepass.mjs';
import { segmentCorpus } from './wide-context-windows.mjs';
import {
  freezeSourceFirstFrames, scanPairedPopulationDisclosure, selectFreshPairedPopulation,
} from './paired-gate-population.mjs';
import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  return out;
}
async function readJson(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function writeJson(file, value) {
  const target = path.resolve(file), temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

async function previouslyExtractedFiles(analysisDir) {
  const files = new Set();
  for (const name of await fs.readdir(analysisDir)) {
    if (!name.endsWith('.json')) continue;
    let artifact;
    try { artifact = await readJson(path.join(analysisDir, name)); } catch { continue; }
    if (!Array.isArray(artifact.claims) || !Array.isArray(artifact.window_catalog)) continue;
    const selected = new Set(artifact.claims.map(claim => claim?.semantic?.provenance?.unit_id).filter(Boolean));
    for (const window of artifact.window_catalog) if (selected.has(window.id)) files.add(window.file);
  }
  return files;
}

const options = args(process.argv.slice(2));
for (const name of ['manifest', 'estate', 'analysis', 'population', 'bounds']) {
  if (!options[name]) throw new Error(`--${name} required`);
}
const manifest = await readJson(options.manifest);
const estate = await fs.realpath(path.resolve(options.estate));
const analysisDir = path.resolve(options.analysis);
const documents = await Promise.all((manifest.documents || []).map(async row => ({
  path: row.path, content: await fs.readFile(path.join(estate, row.path), 'utf8'),
})));
const snapshot = {
  source_sha: manifest.source_sha,
  corpus_digest: sha256(canonical(documents.map(row => ({ path: row.path, digest: sha256(row.content) })))),
};
const inventories = documents.map(row => prepassDocument({ path: row.path, content: row.content, ...snapshot }).inventory);
const segmented = segmentCorpus({
  documents, snapshot, window_bytes: manifest.bounds.window_bytes,
  overlap_bytes: manifest.bounds.overlap_bytes ?? null,
});
const excludedFiles = await previouslyExtractedFiles(analysisDir);
const seed = options.seed || 'v9-document-tranche-25-20260804';
const requestedConcurrency = Number(options.concurrency || 16);
const initialWorkerConcurrency = Number(options['initial-worker-concurrency'] || requestedConcurrency);
const workerStartDelayMs = Number(options['worker-start-delay-ms'] || 0);
if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) throw new Error('--concurrency must be a positive integer');
if (!Number.isInteger(initialWorkerConcurrency) || initialWorkerConcurrency < 1
  || initialWorkerConcurrency > requestedConcurrency) {
  throw new Error('--initial-worker-concurrency must be an integer from 1 through concurrency');
}
if (!Number.isFinite(workerStartDelayMs) || workerStartDelayMs < 0) throw new Error('--worker-start-delay-ms must be non-negative');
const formatQuotas = options['format-quotas']
  ? JSON.parse(options['format-quotas']) : { md: 20, yaml: 3, json: 1, mjs: 1 };
if (!formatQuotas || Array.isArray(formatQuotas) || !Object.keys(formatQuotas).length
  || Object.values(formatQuotas).some(value => !Number.isInteger(value) || value < 0)) {
  throw new Error('--format-quotas must be a JSON object of non-negative integer counts');
}
const representatives = selectFreshPairedPopulation({
  windows: segmented.windows, inventories, excluded_files: [...excludedFiles], seed, format_quotas: formatQuotas,
});
const selectedFiles = new Set(representatives.map(row => row.file));
const windows = segmented.windows.filter(window => selectedFiles.has(window.file));
const scanRows = windows.map(window => ({
  id: window.id, file: window.file, primary_block_addresses: window.primary_block_addresses,
}));
const disclosureScan = scanPairedPopulationDisclosure({ population: scanRows, inventories });
if (!disclosureScan.pass) throw new Error(`disclosure scan failed with ${disclosureScan.findings.length} finding(s)`);
const documentRows = [...selectedFiles].sort().map(file => {
  const held = windows.filter(window => window.file === file);
  return {
    file,
    representative_window_id: representatives.find(row => row.file === file).id,
    windows: held.length,
    primary_bytes: held.reduce((sum, window) => sum + window.primary_bytes, 0),
    window_ids: held.map(window => window.id).sort(),
  };
});
const sourceFrames = freezeSourceFirstFrames({ population: representatives, inventories, blocks_per_window: 4 });
const body = {
  schema: 'estate-map/document-extraction-tranche/v1',
  status: 'frozen_before_inference_pending_source_gold',
  purpose: options.purpose || '25-document wide-context semantic gate; audit required before expansion',
  snapshot,
  seed,
  exclusions: {
    policy: 'exclude every document with a promoted claim in any existing analysis artifact at freeze time',
    files: [...excludedFiles].sort(),
  },
  selection: {
    documents: documentRows.length,
    windows: windows.length,
    format_quotas: formatQuotas,
    requested_concurrency: requestedConcurrency,
    initial_worker_concurrency: initialWorkerConcurrency,
    worker_start_delay_ms: workerStartDelayMs,
    one_representative_window_per_document_for_selection: true,
    every_window_of_selected_document_included: true,
  },
  documents: documentRows,
  window_ids: windows.map(window => window.id).sort(),
  representative_windows: representatives,
  source_frames: sourceFrames,
  source_gold_status: 'pending_before_inference',
  disclosure_scan: disclosureScan,
};
const population = { ...body, digest: sha256(canonical(body)) };
const bounds = {
  max_calls: windows.length,
  max_known_cost_usd: Number((windows.length * 0.2).toFixed(2)),
  max_unpriced_attempts: 0,
  cost_reserve_per_call_usd: 0.2,
  concurrency: requestedConcurrency,
  initial_worker_concurrency: initialWorkerConcurrency,
  worker_start_delay_ms: workerStartDelayMs,
  fleet_stop: { failure_rate: 0.25, min_samples: 4 },
  _tranche_note: 'The cap reserves the full historical treatment maximum envelope of $0.20 for every selected window; configured concurrency is an admission ceiling.',
};
await writeJson(options.population, population);
await writeJson(options.bounds, bounds);
console.log(JSON.stringify({ population: path.resolve(options.population), bounds: path.resolve(options.bounds),
  documents: documentRows.length, windows: windows.length, max_known_cost_usd: bounds.max_known_cost_usd,
  digest: population.digest }));
