#!/usr/bin/env node
// `ascrybe ontology build|stage|promote|query` -- design v2 section 12: "Suggested tools/ontology/
// module boundaries per Pro section 14.4; a single ascrybe ontology build|stage|promote|evaluate
// surface" (query added here per operator direction: the evaluate step is folded into build, which
// already writes evaluation-receipt.json as part of buildOntologyGeneration()'s existing output).
//
// Dispatches to the modules that own each behaviour, the same convention bin/ascrybe.mjs already
// documents for every other verb: one behaviour, one place it lives.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin } from '../path-within.mjs';
import { buildOntologyGeneration } from './generation-builder.mjs';
import { stageInterpretation, promoteInterpretation } from './sidecar-store.mjs';
import { OntologyQueries, ontologyQuerySurfaceContract } from './ontology-query.mjs';
import { Neo4jHttpClient } from '../c3-serving-projection.mjs';
import { loadEstateMapRuntimeConfig, neo4jConnectionFromConfig } from '../ascrybe-config.mjs';
import { buildClassificationPacket, classifyOntologyPacket, gapCandidate, appendGapCandidate,
  analyzeGap, classificationEvaluationManifest } from './classification.mjs';
import { discoverOntology, discoveryViewModel, resolveUnknownAttempt, sealDiscoveryCorpus } from './discovery.mjs';
import { alignGenerations, alignmentViewModel } from './alignment.mjs';
import { runEstateDiscovery } from './estate-discovery.mjs';
import { estateDiagnostics } from './estate-diagnostics.mjs';
import { runReconcile } from './estate-reconcile.mjs';
import { reconcileSummary, reconcileViewModel } from './reconcile-summary.mjs';
import { proposePredicateMappings } from './predicate-mapping.mjs';
import { anchorsOfGeneration, computeCoverage, summariseCoverage, COVERAGE_POLICY } from './graph-coverage.mjs';
import { createReadStream } from 'node:fs';
import { writeCoverageShards } from './graph-coverage-store.mjs';
import { buildFrontier, freezeCases, judgeFamilies, compressProposals, splitProbe, conditionCheck, complexityOf, writeJson, LOOP_SCAFFOLD } from './coverage-loop.mjs';
import { enclosing as enclosingBlock, readPinned } from './handoff-trace.mjs';
import { createInterface } from 'node:readline';
import { loadViewInputs } from './view-inputs.mjs';
import { loadCoverageLoop } from './coverage-loop-view.mjs';
import { EstateGraphQueries } from '../estate-graph-query.mjs';
import { INVENTORY_SCHEMA, inventoryEstate, summarizeInventory, validateManifest } from './estate-inventory.mjs';
import { startCandidateView } from './candidate-view.mjs';

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) { options[name] = true; }
      else { options[name] = next; index += 1; }
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

function neo4jClientFrom(options) {
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const connection = neo4jConnectionFromConfig(runtime);
  return new Neo4jHttpClient(connection);
}

async function runBuild(options) {
  const configPath = options.config;
  if (!configPath) { console.error('ontology build requires --config <path to a build config JSON>'); return 1; }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const result = await buildOntologyGeneration({ ...config, outputDir: options['output-dir'] ?? config.output_dir ?? null });
  console.log(JSON.stringify({
    interpretation_id: result.generation.interpretation_id,
    content_digest: result.generation.content_digest,
    counts: result.generation.counts,
    output_dir: options['output-dir'] ?? config.output_dir ?? null,
  }, null, 2));
  return 0;
}

async function runStage(options) {
  const buildDir = options['build-dir'];
  if (!buildDir) { console.error('ontology stage requires --build-dir <a directory ontology build wrote>'); return 1; }
  const generation = JSON.parse(await readFile(join(buildDir, 'interpretation-manifest.json'), 'utf8'));
  const memberships = (await readFile(join(buildDir, 'memberships.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const client = neo4jClientFrom(options);
  const result = await stageInterpretation({
    client, generation, memberships,
    batch_size: options['batch-size'] ? Number(options['batch-size']) : undefined,
    expected_working_interpretation_id: options['expected-working'] || null,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function runPromote(options) {
  const interpretationId = options['interpretation-id'];
  if (!interpretationId) { console.error('ontology promote requires --interpretation-id <id>'); return 1; }
  const client = neo4jClientFrom(options);
  const result = await promoteInterpretation({
    client, interpretation_id: interpretationId,
    expected_selected_interpretation_id: options['expected-selected'] || null,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const QUERY_DISPATCH = {
  'interpretation-status': (queries, options) => queries.interpretationStatus({ base_projection_id: options['base-projection-id'] }),
  members: (queries, options) => queries.members({
    interpretation_id: options['interpretation-id'], concept_id: options['concept-id'],
    min_confidence: options['min-confidence'] || null, limit: options.limit ? Number(options.limit) : undefined,
    expected_base_projection_id: options['expected-base-projection-id'] || null,
  }),
  'concepts-of': (queries, options) => queries.conceptsOf({
    interpretation_id: options['interpretation-id'], node_id: options['node-id'],
    limit: options.limit ? Number(options.limit) : undefined,
    expected_base_projection_id: options['expected-base-projection-id'] || null,
  }),
  why: (queries, options) => queries.why({
    interpretation_id: options['interpretation-id'], membership_id: options['membership-id'],
    expected_base_projection_id: options['expected-base-projection-id'] || null,
  }),
  conflicts: (queries, options) => queries.conflicts({
    interpretation_id: options['interpretation-id'], concept_id: options['concept-id'],
    limit: options.limit ? Number(options.limit) : undefined,
    expected_base_projection_id: options['expected-base-projection-id'] || null,
  }),
  drift: (queries, options) => queries.drift({
    concept_id: options['concept-id'], interpretation_id_a: options['interpretation-id-a'],
    interpretation_id_b: options['interpretation-id-b'], limit: options.limit ? Number(options.limit) : undefined,
  }),
  'generalization-report': (queries, options) => queries.generalizationReport({ generalization_id: options['generalization-id'] || null }),
  contract: () => ontologyQuerySurfaceContract(),
};

async function runQuery(options, positionals) {
  const [command] = positionals;
  if (command === 'contract') { console.log(JSON.stringify(ontologyQuerySurfaceContract(), null, 2)); return 0; }
  const handler = QUERY_DISPATCH[command];
  if (!handler) {
    console.error(`ontology query requires one of: ${Object.keys(QUERY_DISPATCH).join(', ')}`);
    return 1;
  }
  const client = neo4jClientFrom(options);
  const queries = new OntologyQueries({ client });
  const result = await handler(queries, options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// Classification never writes source-bearing packets into this PUBLIC repository. The caller's
// output root holds receipts, packets and gap proposals outside it, or the verb refuses early.
const CODE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
function externalOutput(path) {
  const target = resolve(path);
  if (isWithin(CODE_ROOT, target)) {
    throw Object.assign(new Error('classification artifacts must be written outside the public repository'),
      { code: 'CLASSIFICATION_OUTPUT_NOT_PRIVATE' });
  }
  return target;
}

async function runClassify(options) {
  if (!options.input || !options.repository || !options['output-dir']) {
    console.error('ontology classify requires --input <JSON> --repository <pinned local Git repo> --output-dir <private directory>');
    return 1;
  }
  const output = externalOutput(options['output-dir']);
  if (existsSync(output) && readdirSync(output).length) {
    throw Object.assign(new Error('classification output must be absent or empty to preserve old receipts'),
      { code: 'CLASSIFICATION_OUTPUT_NOT_EMPTY' });
  }
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const input = JSON.parse(await readFile(options.input, 'utf8'));
  const packet = buildClassificationPacket(input, { repository: options.repository });
  const result = await classifyOntologyPacket({ packet, runtime });
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'classification-packet.json'), `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'classification-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const manifest = classificationEvaluationManifest({ packet, runtime, result, split: 'unassigned' });
  await writeFile(join(output, 'classification-evaluation-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const gap = result.status === 'no_existing_type' ? gapCandidate(packet, result) : null;
  if (gap) appendGapCandidate(join(output, 'ontology-gaps.jsonl'), gap);
  console.log(JSON.stringify({ packet_id: packet.packet_id, receipt_id: result.receipt_id,
    status: result.status, backend: result.backend, fallback_reason: result.fallback_reason,
    gap_id: gap?.gap_id ?? null, output_dir: output, evaluation_rating: null }, null, 2));
  return result.status === 'pending' || result.status === 'needs_context' ? 2 : 0;
}

async function runAnalyzeGap(options) {
  if (!options['output-dir'] || !options['gap-id']) {
    console.error('ontology analyze-gap requires --output-dir <private classify directory> --gap-id <id>');
    return 1;
  }
  const output = externalOutput(options['output-dir']);
  const packet = JSON.parse(await readFile(join(output, 'classification-packet.json'), 'utf8'));
  const rows = (await readFile(join(output, 'ontology-gaps.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const candidate = rows.find(row => row.gap_id === options['gap-id']);
  if (!candidate) throw Object.assign(new Error('gap id is absent from the private queue'), { code: 'ONTOLOGY_GAP_MISSING' });
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const result = await analyzeGap({ candidate, packet, runtime });
  await writeFile(join(output, 'gap-analysis.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ gap_id: result.gap_id, status: result.status, finding: result.finding ?? null,
    accepted: false, output_dir: output }, null, 2));
  return result.status === 'pending' ? 2 : 0;
}

// The output directory keeps the call journal, so rerunning the same corpus replays paid answers.
// Generations are named by content identity; an earlier interpretation is never overwritten.
async function runDiscover(options) {
  if (!options.corpus || !options.repositories || !options['output-dir']) {
    console.error('ontology discover requires --corpus <JSON> --repositories <JSON name→path> --output-dir <private directory> [--prior <generation JSON>]');
    return 1;
  }
  const output = externalOutput(options['output-dir']);
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const corpus = sealDiscoveryCorpus(JSON.parse(await readFile(options.corpus, 'utf8')));
  const repositories = JSON.parse(await readFile(options.repositories, 'utf8'));
  const priorGeneration = options.prior ? JSON.parse(await readFile(options.prior, 'utf8')) : null;
  await mkdir(join(output, 'generations'), { recursive: true, mode: 0o700 });
  const { generation, receipt } = await discoverOntology({ corpus, runtime, repositories, priorGeneration,
    journalPath: join(output, 'discovery-journal.jsonl') });
  const name = generation.generation_id.split(':').at(-1);
  await writeFile(join(output, 'generations', `${name}.json`), `${JSON.stringify(generation, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'generations', `${name}.view-model.json`),
    `${JSON.stringify(discoveryViewModel(generation), null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'generations', `${name}.receipt-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ generation_id: generation.generation_id, context_id: generation.context_id,
    status: generation.status, accepted: false, counts: generation.counts, new_model_calls: receipt.new_model_calls,
    new_cost_usd: receipt.new_cost_usd, output_dir: output }, null, 2));
  return 0;
}

// Alignment proposes links between concepts and subjects interpreted in different collections. It reads
// generations and the corpora they came from, and writes a separate proposal; no generation changes.
export async function runAlign(options, { align = alignGenerations, loadRuntime = loadEstateMapRuntimeConfig } = {}) {
  if (!options.generations || !options.corpora || !options.repositories || !options['output-dir']) {
    console.error('ontology align requires --generations <JSON,JSON> --corpora <JSON,JSON> --repositories <JSON> --output-dir <private directory> [--prior-alignment <JSON>] [--include-within-collection]');
    return 1;
  }
  const output = externalOutput(options['output-dir']);
  const runtime = loadRuntime(options['runtime-config']);
  const readAll = async list => Promise.all(String(list).split(',').map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const generations = await readAll(options.generations);
  const corpora = (await readAll(options.corpora)).map(sealDiscoveryCorpus);
  const repositories = JSON.parse(await readFile(options.repositories, 'utf8'));
  const priorAlignment = options['prior-alignment'] ? JSON.parse(await readFile(options['prior-alignment'], 'utf8')) : null;
  await mkdir(join(output, 'alignments'), { recursive: true, mode: 0o700 });
  const { alignment, receipt } = await align({ generations, corpora, runtime, repositories, priorAlignment, includeWithinCollection: options['include-within-collection'] === true, reconsiderRefused: options['reconsider-refused'] === true,
    journalPath: join(output, 'alignment-journal.jsonl') });
  const name = alignment.alignment_id.split(':').at(-1);
  // A stored alignment is never overwritten: identical bytes are left alone, and a faithful replay that differs only in
  // provenance (carried from a prior) is written beside it.
  const target = join(output, 'alignments', `${name}.json`), bytes = `${JSON.stringify(alignment, null, 2)}\n`;
  if (!existsSync(target)) await writeFile(target, bytes, { mode: 0o600 });
  else if (readFileSync(target, 'utf8') !== bytes) await writeFile(join(output, 'alignments', `${name}.carried-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.json`), bytes, { mode: 0o600 });
  await writeFile(join(output, 'alignments', `${name}.view-model.json`), `${JSON.stringify(alignmentViewModel(alignment, generations), null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'alignments', `${name}.receipt-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ alignment_id: alignment.alignment_id, status: alignment.status, accepted: false, counts: alignment.counts,
    new_model_calls: receipt.new_model_calls, new_cost_usd: receipt.new_cost_usd, output_dir: output }, null, 2));
  return 0;
}

// Inventory is metadata only: it reads trees and, for supported files, their bytes at the pinned ref to cut units. No model is called.
async function runInventory(options) {
  if (!options.manifest || !options['output-dir']) { console.error('ontology inventory requires --manifest <JSON> --output-dir <private directory>'); return 1; }
  const output = externalOutput(options['output-dir']);
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, 'utf8')));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const { manifest: expanded, entries, units, unreadable } = inventoryEstate(manifest);
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(expanded, null, 2)}\n`, { mode: 0o600 });
  const summary = { schema: INVENTORY_SCHEMA, manifest_sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), by_source: summarizeInventory(entries, units), unreadable_files: unreadable.length };
  await writeFile(join(output, 'inventory.json'), `${JSON.stringify({ ...summary, manifest: expanded, files: entries }, null, 0)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'units.jsonl'), units.map(u => JSON.stringify(u)).join('\n') + '\n', { mode: 0o600 });
  await writeFile(join(output, 'inventory-summary.json'), `${JSON.stringify({ ...summary, unreadable }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ files: entries.length, units: units.length, unreadable: unreadable.length, output_dir: output }, null, 2));
  return 0;
}

// Estate-scale discovery over a frozen manifest and its inventory. Every call is journalled in the output directory; rerunning replays
// recorded answers. --sources limits a trial to named sources; --plan builds the batches without any model call.
async function runEstate(options) {
  if (!options.manifest || !options['inventory-dir'] || !options['output-dir']) { console.error('ontology estate requires --manifest <JSON> --inventory-dir <dir> --output-dir <private directory> [--sources a,b] [--plan]'); return 1; }
  const output = externalOutput(options['output-dir']);
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const requestedManifest = validateManifest(JSON.parse(await readFile(options.manifest, 'utf8')));
  const inventory = JSON.parse(await readFile(join(options['inventory-dir'], 'inventory.json'), 'utf8'));
  const requestedDigest = createHash('sha256').update(JSON.stringify(requestedManifest)).digest('hex');
  if (inventory.manifest_sha256 !== requestedDigest && JSON.stringify(inventory.manifest) !== JSON.stringify(requestedManifest)) throw new Error('inventory manifest does not match the requested sources');
  const manifest = validateManifest(inventory.manifest ?? requestedManifest);
  const only = options.sources ? new Set(String(options.sources).split(',')) : null;
  if (only) manifest.sources = manifest.sources.filter(s => only.has(s.id));
  const inventoryEntries = inventory.files.filter(f => !only || only.has(f.source_id));
  const units = (await readFile(join(options['inventory-dir'], 'units.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(u => !only || only.has(u.source_id));
  await mkdir(join(output, 'generations'), { recursive: true, mode: 0o700 });
  const plan = options.plan === true;
  const started = Date.now();
  const { generation, coverage, receipt, domains } = await runEstateDiscovery({ manifest, units, inventoryEntries, runtime, outputDir: output, journalPath: plan ? null : join(output, 'estate-journal.jsonl'),
    modelCall: plan || options['replay-only'] === true ? async () => { throw Object.assign(new Error('replay only: no request may be dispatched'), { code: 'PLAN_ONLY' }); } : undefined, bounds: { ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}), ...(options['min-cluster'] ? { cluster_min_size: Number(options['min-cluster']) } : {}) },
    progress: (stage, done, total, calls) => console.error(`[${Math.round((Date.now() - started) / 1000)}s] ${stage} ${done}/${total} calls=${calls.length} cost=${calls.reduce((n, c) => n + (c.cost_usd || 0), 0).toFixed(4)}`) });
  if (!plan) {
    const name = generation.generation_id.split(':').at(-1);
    await writeFile(join(output, 'generations', `${name}.json`), `${JSON.stringify(generation)}\n`, { mode: 0o600 });
    await writeFile(join(output, 'generations', `${name}.receipt-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ plan, generation_id: generation.generation_id, counts: generation.counts, coverage_totals: coverage.totals, planned: coverage.planned, failures: coverage.failures, domains: domains.domains.length,
    themes: domains.themes.themes.length, new_model_calls: receipt.new_model_calls, new_cost_usd: receipt.new_cost_usd, by_stage: receipt.by_stage, output_dir: output }, null, 2));
  return 0;
}

// Offline diagnostics over an existing estate generation. No model is called.
async function runDiagnose(options) {
  if (!options.generation || !options['estate-dir']) { console.error('ontology diagnose requires --generation <JSON> --estate-dir <dir with estate-domains.json and estate-coverage.json>'); return 1; }
  const dir = options['estate-dir'], read = async path => JSON.parse(await readFile(path, 'utf8'));
  const diagnostics = estateDiagnostics({ generation: await read(options.generation), domains: await read(join(dir, 'estate-domains.json')), coverage: await read(join(dir, 'estate-coverage.json')) });
  await writeFile(join(dir, 'estate-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ domain_readings: diagnostics.domain_readings, thin_domains: diagnostics.thin_domains, domains_without_direct_source_evidence: diagnostics.domains_without_direct_source_evidence, near_duplicate_clusters: diagnostics.near_duplicates.clusters }, null, 2));
  return 0;
}

// Narrow reconciliation over an existing estate generation: large identity clusters, domains over every retained concept, and bounded
// source-level checks of named hand-offs. Journalled, replayable, and it never changes the generation it reads.
// How much of a projected source graph an ontology generation reaches. Offline, no model call, no source or graph mutation.
async function* jsonLines(path) { for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line) yield JSON.parse(line); }
async function runCoverage(options) {
  if (!options.generation || !options['graph-dir'] || !options['graph-pins'] || !options['output-dir']) { console.error('ontology coverage requires --generation <JSON> --graph-dir <dir with projection-nodes.jsonl and projection-edges.jsonl> --graph-pins <JSON {repository: commit}> --output-dir <private directory> [--inventory-summary <JSON>] [--estate-coverage <JSON>]'); return 1; }
  const output = externalOutput(options['output-dir']);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const generation = JSON.parse(await readFile(options.generation, 'utf8'));
  const repositories = generation.collections.map(c => c.collection_id);
  const anchors = anchorsOfGeneration(generation);
  const result = await computeCoverage({ nodes: jsonLines(join(options['graph-dir'], 'projection-nodes.jsonl')), edges: jsonLines(join(options['graph-dir'], 'projection-edges.jsonl')), anchors, repositories, graphPins: JSON.parse(await readFile(options['graph-pins'], 'utf8')) });
  const readJson = async path => (path ? JSON.parse(await readFile(path, 'utf8')) : null);
  const inventory = await readJson(options['inventory-summary']), estateCoverage = await readJson(options['estate-coverage']);
  const denominators = { admitted_graph_nodes: result.state.size, inventory_files_by_repository_and_disposition: inventory ? Object.fromEntries(Object.entries(inventory.by_source).map(([id, v]) => [id, { files: v.files, by_disposition: Object.fromEntries(Object.entries(v.by_disposition).map(([k, x]) => [k, x.files])) }])) : null,
    discovery_units_by_repository: estateCoverage ? Object.fromEntries(Object.entries(estateCoverage.by_source).map(([id, v]) => [id, { units_ready: v.units_ready, units_read: v.units_read, units_cited_by_concepts: v.units_cited_by_concepts, units_grounded: v.units_grounded }])) : null,
    note: 'Three different denominators. Graph nodes are what this coverage measures. Inventoried files that are unsupported, withheld or excluded are not graph nodes. Discovery units read is a reading counter and says nothing about which graph nodes were reached.' };
  const summary = { schema: 'estate-map/graph-coverage/v1', denominators, base_generation_id: generation.generation_id, graph_dir: options['graph-dir'], policy: COVERAGE_POLICY, anchors: { read_from_generation: result.anchors_total, applied: result.anchors_applied, not_applied: result.anchors_dropped, rule: 'an anchor is applied only where the passage was read at the commit the graph was built from' }, anchored_nodes: result.anchored_nodes,
    relations_not_walked: result.excluded_relations, ...summariseCoverage(result),
    notes: ['The measure is of ADMITTED graph nodes. Every proportion is an evidence-anchor and navigation reach: a node is counted when a cited passage covers its own line, or it is an owned part of, or one step of participation with, such a node. It is not a semantic correctness score, and an anchored node is not thereby the subject or type a concept names.',
      'Claim, evidence, adjudication and obligation records are admitted graph nodes and stay in the denominator. They are reached only where their own source line is covered or an owning record is; the rest are reported as claim_layer_unreached.',
      'Discovery units read is a reading counter, and inventoried files that are unsupported, withheld or excluded are not graph nodes. A cited document is a locator; it never reaches the uncited rest of its file.'] };
  await writeFile(join(output, 'graph-coverage-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await writeCoverageShards(output, result);
  console.log(JSON.stringify({ admitted_nodes: summary.admitted_nodes, by_disposition: summary.by_disposition, unplaced_reasons: summary.unplaced_reasons, output_dir: output }, null, 2));
  return 0;
}

// One round of the coverage-driven invention and compression loop over one source. See coverage-loop.mjs. Primary route only; every output is a proposal.
async function runLoop(options) {
  const need = ['generation', 'graph-dir', 'graph-pins', 'manifest', 'source', 'output-dir'];
  if (need.some(k => !options[k])) { console.error('ontology loop requires --' + need.join(' --') + ' [--unread-units <JSON>] [--round n] [--modes code,text] [--cases <earlier frozen-cases JSON>] [--regress <reviewed cases JSON>] [--journal-name f] [--plan] [--replay-only]'); return 1; }
  const output = externalOutput(options['output-dir']);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const generation = JSON.parse(await readFile(options.generation, 'utf8'));
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, 'utf8')));
  const source = manifest.sources.find(s => s.id === options.source);
  if (!source) { console.error('source not in manifest'); return 1; }
  const graphPins = JSON.parse(await readFile(options['graph-pins'], 'utf8'));
  if (graphPins[source.id] !== source.ref) { console.error('graph pin differs from the manifest pin; the loop reads the source at the manifest pin and will not run on a mismatch'); return 1; }
  const unreadRanges = new Map();
  if (options['unread-units']) for (const u of JSON.parse(await readFile(options['unread-units'], 'utf8')).units) (unreadRanges.get(u.path) ?? unreadRanges.set(u.path, []).get(u.path)).push([u.start_line, u.end_line]);
  const graphDir = options['graph-dir'], round_no = Number(options.round ?? 1);
  const loopBounds = options.modes ? { modes: String(options.modes).split(',') } : {};
  const anchors = anchorsOfGeneration(generation), repositories = generation.collections.map(c => c.collection_id);
  const runCov = bindings => computeCoverage({ nodes: jsonLines(join(graphDir, 'projection-nodes.jsonl')), edges: jsonLines(join(graphDir, 'projection-edges.jsonl')), anchors, repositories, graphPins, bindings });
  const before = await runCov([]);
  const families = await buildFrontier({ graphDir, coverage: before, generation, unreadRanges, repository: source.id, bounds: loopBounds });
  const observed = families.reduce((a, f) => { for (const [k, v] of Object.entries({ [f.mode + ':file_has_cited_passage']: f.observed.file_has_cited_passage, [f.mode + ':file_has_extraction_refusal']: f.observed.file_has_extraction_refusal, [f.mode + ':has_owned_nodes_in_unread_unit']: f.observed.owned_nodes_in_unread_unit > 0 })) a[k] = (a[k] ?? 0) + (v ? 1 : 0); a[f.mode + ':families'] = (a[f.mode + ':families'] ?? 0) + 1; return a; }, {});
  let frozen;
  if (options.cases) {
    // A controlled re-run: exactly the families of an earlier frozen set, so before and after differ only in the loop, not in the cases.
    const earlier = JSON.parse(await readFile(options.cases, 'utf8')), byId = new Map(families.map(f => [f.family_id, f]));
    const pick = rows => rows.map(r => byId.get(r.family_id)).filter(Boolean);
    const design = pick(earlier.design), heldout = pick(earlier.heldout);
    const lost = earlier.design.length + earlier.heldout.length - design.length - heldout.length;
    const manifest = { schema: 'estate-map/coverage-loop-frozen-cases/v2', rule: 'the design and held-out families of an earlier frozen set, unchanged', cases_from: options.cases, earlier_digest: earlier.digest, families_no_longer_in_frontier: lost,
      design: design.map(f => ({ family_id: f.family_id, file: f.file, mode: f.mode, observed: f.observed })), heldout: heldout.map(f => ({ family_id: f.family_id, file: f.file, mode: f.mode, observed: f.observed })) };
    manifest.digest = createHash('sha256').update(JSON.stringify([manifest.design.map(f => f.family_id), manifest.heldout.map(f => f.family_id)])).digest('hex');
    frozen = { manifest, design, heldout };
  } else frozen = freezeCases(families, loopBounds);
  writeJson(output, `frozen-cases-round-${round_no}.json`, frozen.manifest);
  if (options.plan === true) { console.log(JSON.stringify({ plan: true, families: families.length, observed_before_model: observed, design: frozen.design.length, heldout: frozen.heldout.length, frozen_digest: frozen.manifest.digest, output_dir: output }, null, 2)); return 0; }
  const journalPath = join(output, options['journal-name'] ?? 'loop-journal-v3.jsonl');
  const modelCall = options['replay-only'] === true ? async () => { throw Object.assign(new Error('replay only'), { code: 'PLAN_ONLY' }); } : undefined;
  const vocabulary = generation.collections.flatMap(c => c.concepts);
  const design = await judgeFamilies({ families: frozen.design, source, vocabulary, runtime, journalPath, modelCall, bounds: loopBounds, phase: 'design' });
  const comp = await compressProposals({ proposals: design.new_concepts, bindings: design.bindings, vocabulary, runtime, journalPath, modelCall });
  const canonicalVocab = comp.groups.filter(g => g.relation !== 'variant_of_existing').map(g => ({ accession: g.group_id, label: g.canonical.label, definition: g.canonical.definition, inclusion: g.canonical.inclusion, exclusion: g.canonical.exclusion, semantic_category: g.canonical.semantic_category, domain: [], instance_conditions: [] }));
  const held = await judgeFamilies({ families: frozen.heldout, source, vocabulary: [...vocabulary, ...canonicalVocab], runtime, journalPath, modelCall, bounds: loopBounds, phase: 'heldout' });
  const allBindings = [...design.bindings, ...held.bindings], instance = allBindings.filter(b => b.role === 'instance');
  const conceptRecords = new Map([...vocabulary.map(c => [c.accession, c]), ...design.new_concepts.map(c => [c.proposal_id, { ...c, accession: c.proposal_id, domain: [] }]), ...held.new_concepts.map(c => [c.proposal_id, { ...c, accession: c.proposal_id, domain: [] }]), ...canonicalVocab.map(c => [c.accession, c])]);
  const split = await splitProbe({ bindings: allBindings, families: [...frozen.design, ...frozen.heldout], source, concepts: conceptRecords, runtime, journalPath, modelCall, bounds: loopBounds });
  // Reviewed cases: the reviewer's verdict is the reference, never another model's agreement.
  let regress = null, regressCalls = [];
  if (options.regress) {
    const cases = JSON.parse(await readFile(options.regress, 'utf8')).cases;
    const conds = await conditionCheck({ cases, source, concepts: conceptRecords, runtime, journalPath, modelCall, bounds: loopBounds });
    regressCalls = conds.calls;
    const known = cases.filter(c => c.reviewer_verdict === 'wrong');
    regress = { cases: cases.length, condition_checks: conds.results,
      known_false_positives_still_bound_as_instance: known.filter(c => allBindings.some(b => b.role === 'instance' && b.node_label === c.label && b.concept === c.concept_id)).map(c => ({ node: c.label, concept: c.concept_id })),
      reviewer_vs_condition_check: conds.results.map(r => ({ case_id: r.case_id, reviewer: r.reviewer_verdict, condition_check: r.whole_concept, agrees: ({ good: 'all_conditions_hold', wrong: 'does_not_hold', partial: 'part_of_a_larger_responsibility' })[r.reviewer_verdict] === r.whole_concept })),
      note: 'reference = the reviewer; a disagreement is a finding about the check, not about the reviewer' };
  }
  const after = await runCov(instance.map(b => ({ node_id: b.node_id, concept: b.concept, predicate: b.predicate, ref: b.binding_id })));
  const sumOf = r => { const x = summariseCoverage(r); return { reached: x.reached_nodes, share: x.reach_share_of_admitted_nodes, by_disposition: x.by_disposition }; };
  const partOf = [...design.part_of, ...held.part_of];
  const calls = [...design.calls, ...comp.calls, ...held.calls, ...split.calls];
  calls.push(...regressCalls);
  const results = [...design.family_results, ...held.family_results], tally = (rows, f) => rows.reduce((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const round = { schema: 'estate-map/coverage-loop-round/v2', round: round_no, scaffold: LOOP_SCAFFOLD, source: { id: source.id, ref: source.ref }, base_generation_id: generation.generation_id, policy: COVERAGE_POLICY,
    status: 'all outputs are proposals; nothing accepted; no source or graph mutated; navigation potential, not validated semantic gain',
    retrieval: { unit: 'whole enclosing declaration or section as numbered lines, never sliced; nodes whose declaration does not fit are listed as missing context', concept_list: 'short lexical list, escalated once to a broader list before any new concept is allowed' },
    frontier: { families: families.length, observed_before_model: observed, note: 'observations, not explanations; an extractor refusal in a file does not remove its other nodes; only nodes inside an unread unit are excluded' },
    frozen_cases_digest: frozen.manifest.digest, design: { families: frozen.design.length }, heldout: { families: frozen.heldout.length },
    results: { by_cause_after_model: tally(results, r => r.mode + ':' + r.cause_after_model), escalated_families: results.filter(r => r.escalated).length, family_results: results },
    proposals: { new_concepts: [...design.new_concepts, ...held.new_concepts], typed_bindings: allBindings, part_of_and_used_by_edges: partOf, missing_predicates: [...design.missing_predicates, ...held.missing_predicates] },
    missing_context: [...design.missing_context, ...held.missing_context], refused: tally([...design.refused, ...held.refused], r => r.code),
    compression: { groups: comp.groups, before: complexityOf(design.new_concepts), after: complexityOf(comp.groups), note: 'counts only; a property is not a replacement for a constraint, so the constraint_accounting lists are the evidence and no reduction is claimed until a reviewer agrees' },
    regression: regress, split_probe: { items: split.items, results: split.results, still_satisfied_as_written: split.results.filter(r => r.satisfies_as_written === 'yes').length, note: 'a yes proposes a narrower restriction; nothing is changed' },
    coverage: { before: sumOf(before), after_with_proposed_subjects: sumOf(after), instance_bindings_counted: instance.length, relating_bindings_not_counted: allBindings.filter(b => b.role === 'relates').length, part_of_and_used_by_edges_not_counted: partOf.length,
      label: 'evidence-anchor and navigation reach; proposed subjects are a separate state from evidence anchors and from the sealed ontology; this is navigation potential, not a semantic correctness score' },
    measures: { schema_completeness: { families_needing_new_concept_after_escalation: results.filter(r => r.cause_after_model === 'missing_concept').length, new_concepts_proposed: design.new_concepts.length + held.new_concepts.length, new_concepts_with_tested_negative: [...design.new_concepts, ...held.new_concepts].filter(c => c.counterexample_tested).length },
      grounding: { families_with_instance_bindings: results.filter(r => r.cause_after_model === 'instance_binding').length, typed_instance_bindings: instance.length },
      unresolved: { insufficient_context: results.filter(r => r.cause_after_model === 'insufficient_context').length, none_in_shortlist_after_escalation: results.filter(r => r.cause_after_model === 'none_in_shortlist').length, missing_context_nodes: design.missing_context.length + held.missing_context.length, refused_answers: design.refused.length + held.refused.length },
      contradictions: { split_probe_yes: split.results.filter(r => r.satisfies_as_written === 'yes').length, note: 'concept-fit precision is not machine-judged; it goes to reviewer asks' } },
    cost: { calls: calls.length, usd: calls.reduce((n, c) => n + (c.cost_usd || 0), 0), unknown_cost_calls: calls.filter(c => c.cost_usd == null).length, model: calls[0]?.model ?? null } };
  writeJson(output, `round-${round_no}-v3.json`, round);
  const fileOf = new Map(); const bodyFor = b => { const f = [...frozen.design, ...frozen.heldout].find(x => x.family_id === b.family_id); if (!f) return null; const t = readPinned(source.root, source.ref, f.file); if (t == null) return null; const e = enclosingBlock(t, b.node_line); const lo = Math.min(e.start_line, b.evidence.start_line), hi = Math.max(e.end_line, b.evidence.end_line); const lines = t.split('\n').slice(lo - 1, hi); return { start_line: lo, end_line: hi, text: lines.map((x, i) => `${lo + i}: ${x}`).join('\n'), extent: 'heuristic enclosing declaration unioned with the quoted lines', may_be_cut_or_incomplete: !e.reached_balanced_close, hit_line_cap: e.hit_line_cap }; };
  void fileOf;
  const asks = [...allBindings, ...partOf.map(e => ({ ...e, role: e.relation, node_line: null }))].sort((x, y) => String(x.binding_id ?? x.edge_id).localeCompare(String(y.binding_id ?? y.edge_id))).filter((_, i, all) => all.length <= 24 || i % Math.ceil(all.length / 24) === 0).slice(0, 24).map(b => {
    const rec = conceptRecords.get(b.concept), body = b.node_line ? bodyFor(b) : null;
    return { id: b.binding_id ?? b.edge_id, phase: b.phase, role: b.role, predicate: b.predicate ?? null, node: b.node_label, node_kind: b.node_kind ?? null, owner: b.owner_label ?? null,
      concept: rec ? { id: rec.accession, label: rec.label, category: rec.semantic_category, definition: rec.definition, inclusion: rec.inclusion, exclusion: rec.exclusion, domain: rec.domain ?? [], instance_conditions: rec.instance_conditions ?? [], invariants: rec.invariants ?? [] } : null,
      quote: b.evidence.quote, file: b.evidence.file, quoted_lines: [b.evidence.start_line, b.evidence.end_line], declaration: body ? { lines: [body.start_line, body.end_line], text: body.text, extent: body.extent, may_be_cut_or_incomplete: body.may_be_cut_or_incomplete, hit_line_cap: body.hit_line_cap } : null,
      question: ({ part_of: 'Is the node declared inside the owner and a part of how the owner does its work?', used_by: 'Does the owner declaration use this helper, and does that use support the owner instantiating its concept (not the helper itself)?' })[b.role] ?? ({ implements: 'Does the node ITSELF satisfy EVERY instance condition of the concept as written? A construct that covers only part of the concept is not an instance.', is_a: 'Is the node a kind of thing the concept names, under every condition?', selects: 'Does the node make the choice the concept describes?', subject_to: 'Is the node governed by the rule the concept states?', exemplifies: 'Does the node show the concept?', follows: 'Does the node carry out the procedure the concept describes?', describes: 'Does the passage describe what the concept is about? It need not instantiate it.', defines: 'Does the passage define the concept as stated?', constrains: 'Does the passage state a constraint that governs instances of the concept?' })[b.predicate] ?? 'Does the quoted text support this typed relation?' };
  });
  writeJson(output, `review-asks-round-${round_no}-v3.json`, { schema: 'estate-map/coverage-loop-review-asks/v2', note: 'a fixed-stride sample frozen by id; each ask carries the full concept definition, the typed predicate or relation, and the declaration body. Answers are the reviewer\'s, not another model\'s', asks });
  console.log(JSON.stringify({ families: families.length, observed_before_model: observed, by_cause_after_model: round.results.by_cause_after_model, escalated: round.results.escalated_families, new_concepts: round.proposals.new_concepts.length, groups: comp.groups.length, typed_instance_bindings: instance.length, relating: round.coverage.relating_bindings_not_counted, part_of: partOf.length,
    refused: round.refused, missing_context_nodes: round.measures.unresolved.missing_context_nodes, split_probe: { items: split.items, yes: round.measures.contradictions.split_probe_yes }, coverage: round.coverage, cost: round.cost, output_dir: output }, null, 2));
  return 0;
}

// Proposed canonical predicates for a generation's free-text relation types; a sidecar, never written into the generation.
async function runPredicates(options) {
  if (!options.generation || !options['output-dir']) { console.error('ontology predicates requires --generation <JSON> --output-dir <private directory> [--replay-only]'); return 1; }
  const output = externalOutput(options['output-dir']);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const generation = JSON.parse(await readFile(options.generation, 'utf8'));
  const { result, receipt } = await proposePredicateMappings({ generation, runtime, outputDir: output, journalPath: join(output, 'predicate-journal.jsonl'),
    modelCall: options['replay-only'] === true ? async () => { throw Object.assign(new Error('replay only: no request may be dispatched'), { code: 'PLAN_ONLY' }); } : undefined,
    progress: (n, total, calls) => console.error(`batch ${n}/${total} calls=${calls.length}`) });
  console.log(JSON.stringify({ distinct_original_types: result.distinct_original_types, canonical_predicates: result.canonical.length, unmapped_types: result.mappings.filter(m => m.canonical_id === 'unmapped').length, failures: result.failures, ...receipt, output_dir: output }, null, 2));
  return 0;
}

async function runReconcileVerb(options) {
  if (!options.generation || !options['estate-dir'] || !options.manifest || !options['inventory-dir'] || !options['output-dir']) {
    console.error('ontology reconcile requires --generation <JSON> --estate-dir <dir> --manifest <JSON> --inventory-dir <dir> --output-dir <private directory> [--stages cluster,domain,rollup,theme,path] [--sources a,b] [--paths <JSON edges>] [--replay-only]');
    return 1;
  }
  const output = externalOutput(options['output-dir']);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runtime = loadEstateMapRuntimeConfig(options['runtime-config']);
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const generation = await read(options.generation), domains = await read(join(options['estate-dir'], 'estate-domains.json')), diagnostics = await read(join(options['estate-dir'], 'estate-diagnostics.json'));
  const manifest = validateManifest(await read(options.manifest));
  const units = (await readFile(join(options['inventory-dir'], 'units.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const pathEdges = options.paths ? await read(options.paths) : [];
  const started = Date.now();
  const { result, receipt } = await runReconcile({ generation, domains, diagnostics, units, manifest, runtime, outputDir: output, journalPath: join(output, 'reconcile-journal.jsonl'),
    modelCall: options['replay-only'] === true ? async () => { throw Object.assign(new Error('replay only: no request may be dispatched'), { code: 'PLAN_ONLY' }); } : undefined,
    bounds: { ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}), ...(options['min-cluster'] ? { cluster_min_size: Number(options['min-cluster']) } : {}) }, stages: options.stages ? new Set(String(options.stages).split(',')) : null,
    sourcesFilter: options.sources ? new Set(String(options.sources).split(',')) : null, pathEdges,
    progress: (stage, done, total, calls) => console.error(`[${Math.round((Date.now() - started) / 1000)}s] ${stage} ${done}/${total} calls=${calls.length} cost=${calls.reduce((n, c) => n + (c.cost_usd || 0), 0).toFixed(4)}`) });
  await writeFile(join(output, `receipt-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ clusters: { attempted: result.clusters.attempted, resolved: result.clusters.resolved, canonical: result.clusters.canonical.length, disagreements: result.clusters.disagreements.length },
    domains: { batches: result.domains.batches, source_domains: result.domains.source_domains.length, themes: result.domains.themes.themes.length, paths: result.domains.themes.paths.length }, dispositions: result.dispositions.by_disposition,
    path_links: result.path_links.length, failures: Object.fromEntries(Object.entries(result.failures).map(([k, v]) => [k, v.length])), new_model_calls: receipt.new_model_calls, new_cost_usd: receipt.new_cost_usd, by_stage: receipt.by_stage, output_dir: output }, null, 2));
  return 0;
}

function runResolveUnknown(options) {
  if (!options.journal || !options['request-digest'] || !options['decided-by'] || !options.reason) {
    console.error('ontology resolve-unknown requires --journal <file> --request-digest <sha256> --decided-by <name> --reason <text>');
    return 1;
  }
  resolveUnknownAttempt(options.journal, options['request-digest'], { decidedBy: options['decided-by'], reason: options.reason });
  console.log(JSON.stringify({ resolved: options['request-digest'], cost: 'unknown', original_line_kept: true }));
  return 0;
}

// Serves one sealed generation read-only; the caller's generation file is never written.
async function runView(options) {
  if (!options.generation || !options.port) {
    console.error('ontology view requires --generation <generation JSON> --port <n> [--host 127.0.0.1]');
    return 1;
  }
  const { generation, estate, reconcile, predicates } = await loadViewInputs(options);
  const alignment = options.alignment ? JSON.parse(await readFile(options.alignment, 'utf8')) : null;
  const alignedGenerations = options['also-generations'] ? await Promise.all(String(options['also-generations']).split(',').map(async path => JSON.parse(await readFile(path, 'utf8')))) : [];
  // Optional: embed the normal graph application. Neo4j connection names come from the runtime config; the credentials stay in the
  // server's environment and are never sent to the browser.
  const graph = options['graph-runtime-config'] ? await (async () => {
    const runtime = loadEstateMapRuntimeConfig(resolve(options['graph-runtime-config']));
    const queries = new EstateGraphQueries({ client: new Neo4jHttpClient(neo4jConnectionFromConfig(runtime)), default_view: options['graph-view'] || 'working',
      neighbor_limit: runtime.config.dashboard.neighbor_limit, overview_limit: runtime.config.dashboard.overview_limit, estate: options['graph-estate'] ?? runtime.config.projection.estate });
    const refs = options['graph-refs'] ? JSON.parse(await readFile(options['graph-refs'], 'utf8')) : null;
    if (refs && refs.base_generation_id !== generation.generation_id) throw new Error('the graph references were made for a different generation');
    const blobRows = options['graph-document-blobs'] ? JSON.parse(await readFile(options['graph-document-blobs'], 'utf8')).rows : null;
    return { queries, view: options['graph-view'] || 'working', expectedProjectionId: options['graph-projection-id'] ?? null, refs, loop: options['coverage-loop'] ? loadCoverageLoop(options['coverage-loop'], generation.generation_id) : null, coverageDir: options['graph-coverage-dir'] ?? null, blobMap: blobRows ? new Map(blobRows.map(r => [r.node_id, r.blob_oid])) : null };
  })() : null;
  const running = await startCandidateView({ generation, alignment, alignedGenerations, estate, reconcile, predicates, graph, chains: options['source-chains'] ? JSON.parse(await readFile(options['source-chains'], 'utf8')) : null,
    workspace: { label: options['workspace-label'] || null, peers: String(options.peers || '').split(',').filter(Boolean).map(x => { const [label, ...url] = x.split('='); return { label, url: url.join('=') }; }) }, host: options.host || '127.0.0.1', port: Number(options.port) });
  console.log(JSON.stringify({ url: running.url, generation_id: generation.generation_id, read_only: true }));
  return 0;
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  const { options, positionals } = parseArgs(rest);
  const runners = { build: () => runBuild(options), stage: () => runStage(options),
    promote: () => runPromote(options), query: () => runQuery(options, positionals),
    classify: () => runClassify(options), 'analyze-gap': () => runAnalyzeGap(options),
    discover: () => runDiscover(options), 'resolve-unknown': () => runResolveUnknown(options), inventory: () => runInventory(options), estate: () => runEstate(options), diagnose: () => runDiagnose(options), predicates: () => runPredicates(options), coverage: () => runCoverage(options), loop: () => runLoop(options), reconcile: () => runReconcileVerb(options), align: () => runAlign(options), view: () => runView(options) };
  const runner = runners[verb];
  if (!runner) {
    console.error(`usage: ascrybe ontology <${Object.keys(runners).join('|')}> [options]`);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await runner();
  } catch (error) {
    console.error(`FAIL ${error.code || error.name}: ${error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
