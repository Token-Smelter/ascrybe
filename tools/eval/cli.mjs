#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import finalAnswerSchema from './schemas/final-answer.schema.json' with { type: 'json' };
import { configuredModel, loadEstateMapRuntimeConfig, validateConfiguredPiModels } from '../ascrybe-config.mjs';
import { artifactRoot, physicalPath, repositoryIdentity } from '../artifact-state.mjs';
import { verifiedProjectionInputs, verifiedProjectionShardInputs } from '../estate-graph-projection.mjs';
import { verifyClaimMapShards } from '../claim-map-shards.mjs';
import { createBothArm, createFilesystemArm, createGraphArm, sha256 } from './arm-tools.mjs';
import { createCypherArm } from './cypher-arm.mjs';
import { validateBenchmarkPolicy } from './benchmark-policy.mjs';
import { runModelInFreshProcess } from './model-process.mjs';
import { runEvaluation, sealedKeyMap, validateQuestionSet, validateSealedKeys } from './run.mjs';
import { accountedUsage } from './aggregate.mjs';
import { completedExecutions, createJournal, finalizedJournalDigest, pendingExecutions, resumeJournal } from './journal.mjs';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const jsonLines = values => values.map(value => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

export function defaultEvaluationConfig({ repository = root, environment = process.env } = {}) {
  return join(artifactRoot({ repository, environment }), 'evaluations', 'config.json');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--config') options.config = argv[++index];
    else if (argv[index] === '--run-id') options.run_id = argv[++index];
    else if (argv[index] === '--prepare-only') options.prepare_only = true;
    else if (argv[index] === '--resume') options.resume = true;
    else throw new Error('usage: node tools/eval/cli.mjs [--config external-config.json] [--run-id id] [--prepare-only] [--resume]');
  }
  return options;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadJsonLines(path) {
  return (await readFile(path, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

export function evaluationAccessPolicy(config) {
  const benchmark_policy = validateBenchmarkPolicy(config?.benchmark_policy);
  if (!['index-only', 'as-deployed'].includes(config?.graph_mode)) {
    throw new Error('graph_mode must be index-only or as-deployed');
  }
  // graph_surface selects which graph toolset the graph and both arms receive: the closed command
  // set (default) or the bounded read-only Cypher gateway. It is an immutable run input so two
  // runs of one sealed question set can compare the surfaces themselves.
  const graph_surface = config.graph_surface ?? 'commands';
  if (!['commands', 'cypher'].includes(graph_surface)) {
    throw new Error('graph_surface must be commands or cypher');
  }
  return Object.freeze({ benchmark_policy, graph_mode: config.graph_mode, graph_surface });
}

function isInside(candidate, parent) {
  const relation = relative(parent, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

export function externalResultsPath(path, repository = root) {
  const physical = physicalPath(path);
  const identity = repositoryIdentity(repository);
  for (const protectedPath of [identity.worktree, identity.git_dir, identity.common_dir]) {
    if (isInside(physical, protectedPath)) {
      throw new Error(`evaluation results must be outside the repository: ${physical}`);
    }
  }
  return physical;
}

export function configPaths(config, configPath, repository = root) {
  const base = dirname(configPath);
  const local = value => resolve(base, required(value, 'evaluation configuration path'));
  const paths = {
    source_repository: resolve(base, required(config.source_repository, 'source_repository')),
    runtime_config: local(config.runtime_config),
    questions: local(config.questions),
    keys: local(config.keys),
    results: externalResultsPath(local(config.results_directory), repository),
  };
  return paths;
}

function coverageArtifactPaths(config, configPath, source_repository) {
  if (config.coverage_disclosure !== undefined) {
    throw new Error('coverage_disclosure is retired; derive coverage from external claim-map and code-graph producers');
  }
  if (config.coverage_artifacts === undefined) return null;
  if (!config.coverage_artifacts || typeof config.coverage_artifacts !== 'object'
    || Array.isArray(config.coverage_artifacts)
    || Object.keys(config.coverage_artifacts).sort().join(',') !== 'claim_map,code_graph') {
    throw new Error('coverage_artifacts requires exactly claim_map and code_graph');
  }
  const local = value => externalResultsPath(resolve(dirname(configPath), required(value, 'coverage artifact path')), source_repository);
  return Object.freeze({ claim_map: local(config.coverage_artifacts.claim_map), code_graph: local(config.coverage_artifacts.code_graph) });
}

async function verifyTarget(repository, commit) {
  await exec('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`]);
  return (await exec('git', ['-C', repository, 'rev-parse', `${commit}^{commit}`], { encoding: 'utf8' })).stdout.trim();
}

export function evaluationScratchRoot({ repository = root, environment = process.env } = {}) {
  return environment.ASCRYBE_SCRATCH_DIR || join(artifactRoot({ repository, environment }), 'evaluation-checkouts');
}

async function makeReadOnlyCheckout(repository, commit) {
  const scratch = evaluationScratchRoot({ repository });
  await mkdir(scratch, { recursive: true });
  const directory = join(scratch, `eval-checkout-${randomUUID()}`);
  await exec('git', ['-C', repository, 'worktree', 'add', '--detach', directory, commit]);
  const lock = async path => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { await lock(child); await chmod(child, 0o555); }
      else if (entry.isFile()) await chmod(child, 0o444);
    }
  };
  await lock(directory);
  await chmod(directory, 0o555);
  return directory;
}

async function removeCheckout(repository, directory) {
  if (!directory) return;
  await exec('chmod', ['-R', 'u+w', directory]).catch(() => {});
  await exec('git', ['-C', repository, 'worktree', 'remove', '--force', directory]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

function selectedProjection(status) {
  const data = status?.data;
  if (data?.selected && typeof data.selected === 'object') return data.selected;
  if (Array.isArray(data)) return data.find(item => item?.slot === 'selected' || item?.view === 'selected') ?? null;
  return null;
}

async function preflightProjection({ runtime_config_path, query_script, target_commit }) {
  const graph = createGraphArm({ runtime_config_path, query_script });
  const status = await graph.tools.estate_query({ command: 'projection-status' });
  const selected = selectedProjection(status);
  if (!selected?.projection_id || selected.status !== 'selected' || selected.source_commit !== target_commit ||
      selected.processed_nodes !== selected.total_nodes || selected.processed_edges !== selected.total_edges) {
    throw new Error(`selected projection mismatch: expected complete selected projection at ${target_commit}, observed ${selected?.status ?? 'missing'} at ${selected?.source_commit ?? 'missing'}`);
  }
  return { status, selected };
}

export const TRACKED_FINAL_ANSWER_SCHEMA = Object.freeze(finalAnswerSchema);

/**
 * Structural difficulty a question set declares about itself, so a report can plot score against
 * difficulty rather than reporting one pooled number. These are properties of the question's
 * derivation — how many hops its key needed, how far its answer fans out, whether any question
 * token appears in the witness files a grep would have to find — never observations of how an arm
 * performed, which would let outcome select the set.
 */
export const QUESTION_DIFFICULTY_FIELDS = Object.freeze(['hops', 'fan_out', 'witness_files', 'token_disjoint']);

export function questionDifficulty(question) {
  const held = question?.difficulty;
  if (held === undefined) return null;
  if (!held || typeof held !== 'object' || Array.isArray(held)) {
    throw new Error('question difficulty must be an object of declared structural properties');
  }
  const unknown = Object.keys(held).filter(key => !QUESTION_DIFFICULTY_FIELDS.includes(key));
  if (unknown.length) throw new Error(`unknown difficulty field(s): ${unknown.join(', ')}`);
  for (const field of ['hops', 'fan_out', 'witness_files']) {
    if (held[field] !== undefined && !(Number.isInteger(held[field]) && held[field] >= 0)) {
      throw new Error(`difficulty.${field} must be a non-negative integer`);
    }
  }
  if (held.token_disjoint !== undefined && typeof held.token_disjoint !== 'boolean') {
    throw new Error('difficulty.token_disjoint must be a boolean');
  }
  return Object.freeze({ ...held });
}

export function evaluationConfig(config, target_commit, model, questions = []) {
  const protocol = config.protocol && typeof config.protocol === 'object' ? structuredClone(config.protocol) : {};
  if (protocol.final_answer_schema !== undefined && !isDeepStrictEqual(protocol.final_answer_schema, TRACKED_FINAL_ANSWER_SCHEMA)) {
    throw new Error('protocol.final_answer_schema must exactly match tools/eval/schemas/final-answer.schema.json');
  }
  protocol.final_answer_schema = structuredClone(TRACKED_FINAL_ANSWER_SCHEMA);
  protocol.target_commit = target_commit;
  protocol.model = model;
  return {
    protocol,
    seed: config.seed,
    bootstrap_samples: config.bootstrap_samples ?? 10_000,
    repetitions: 2,
    // The strata belong to the question set, not to the harness. Hardcoding one study's vocabulary
    // marks every question of any other study as an undeclared stratum and invalidates the run.
    strata: Array.isArray(config.strata) && config.strata.length ? [...config.strata]
      : [...new Set(questions.map(question => question.stratum).filter(Boolean))],
  };
}

function executions(result) {
  return result.pairs.flatMap(pair => pair.repetitions.flatMap(repetition => ['filesystem', 'graph', 'both'].map(arm => ({
    question_id: pair.question_id, stratum: pair.stratum, ...repetition[arm],
  }))));
}

export function spending(rows, rates = {}) {
  const inputRate = Number(rates.estimated_input_usd_per_million ?? 0);
  const outputRate = Number(rates.estimated_output_usd_per_million ?? 0);
  const usages = rows.map(accountedUsage);
  const input = usages.reduce((total, usage) => total + usage.provider_input_tokens, 0);
  const output = usages.reduce((total, usage) => total + usage.provider_output_tokens, 0);
  const actual = usages.map(usage => usage.reported_cost_usd).filter(Number.isFinite);
  return {
    estimated_usd: input * inputRate / 1e6 + output * outputRate / 1e6,
    actual_usd: actual.length === rows.length ? actual.reduce((total, value) => total + value, 0) : null,
    actual_spend_status: actual.length === rows.length ? 'provider-reported' : 'unavailable-from-Pi-text-mode',
    provider_input_tokens: input, provider_output_tokens: output,
  };
}

export function report(result, rows, spend) {
  const aggregate = result.aggregate;
  const primary = aggregate.primary_effect ?? 'both_minus_filesystem';
  const metricNames = ['correctness', 'exact_citation_rate', 'confidently_wrong_rate', 'abstention',
    'tokens_consumed', 'wall_clock_ms', 'invalidity', 'spend'];
  const endpoint = (effect, source = {}) => {
    const [positive, negative] = effect.split('_minus_');
    return `${positive}=${source[positive] ?? 'unavailable'}, ${negative}=${source[negative] ?? 'unavailable'}, effect=${source.point ?? 'unavailable'}`;
  };
  const effectSection = (effect, descriptive = {}, intervals = {}) => [
    `### ${effect}`,
    ...metricNames.map(name => `- ${name}: ${endpoint(effect, descriptive[name])}; interval=${JSON.stringify(intervals[name] ?? {})}.`),
  ];
  const overall = ['## Overall', ...Object.keys(aggregate.effects ?? {}).flatMap(effect =>
    effectSection(effect, aggregate.descriptive?.overall?.[effect], aggregate.effects?.[effect]))];
  const strata = Object.entries(aggregate.descriptive?.by_stratum ?? {}).flatMap(([stratum, effects]) => [
    `## Stratum: ${stratum}`,
    ...Object.keys(effects).flatMap(effect => effectSection(effect, effects[effect], aggregate.by_stratum?.[stratum]?.[effect])),
  ]);
  return [
    `# Ascrybe evaluation: ${aggregate.label}`,
    '',
    `Primary effect: **${primary}**. Predeclared overall label: **${aggregate.label}**.`,
    `Raw counts: ${rows.length} arm executions; ${result.pairs.length} questions; ${aggregate.invalid_pair_count} invalid pairs.`,
    `Spend: estimated USD ${spend.estimated_usd}; actual ${spend.actual_usd ?? 'unavailable'} (${spend.actual_spend_status}).`,
    '', ...overall, '', ...strata,
  ].join('\n') + '\n';
}

async function evaluationHarnessDigest(directory = resolve(root, 'tools/eval'), prefix = '') {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const contents = [];
  for (const entry of entries) {
    const path = join(directory, entry.name); const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) contents.push(...await evaluationHarnessDigest(path, `${name}/`));
    else if (entry.isFile() && /\.(?:mjs|json)$/u.test(entry.name)) contents.push(`${name}\0${await readFile(path)}`);
  }
  return prefix ? contents : sha256(contents.join('\n'));
}

const RELATIVE_MODULE_SPECIFIER = /\b(?:import|export)\s+(?:[^'"\n;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Hash every static local producer dependency reachable from the supplied entry points. */
export async function sourceClosureDigest({ repository = root, entrypoints }) {
  if (!Array.isArray(entrypoints) || !entrypoints.length) throw new Error('source closure requires entrypoints');
  const boundary = resolve(repository);
  const sources = new Map();
  const visit = async path => {
    const resolved = resolve(path);
    if (!isInside(resolved, boundary)) throw new Error(`source closure escapes repository: ${resolved}`);
    if (sources.has(resolved)) return;
    const source = await readFile(resolved, 'utf8');
    sources.set(resolved, source);
    RELATIVE_MODULE_SPECIFIER.lastIndex = 0;
    for (const match of source.matchAll(RELATIVE_MODULE_SPECIFIER)) {
      await visit(resolve(dirname(resolved), match[1]));
    }
  };
  for (const entrypoint of entrypoints) await visit(entrypoint);
  return sha256([...sources].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => `${relative(boundary, path)}\0${source}`).join('\n'));
}

export async function behavioralSourceDigest({ repository = root } = {}) {
  const evaluationDirectory = resolve(repository, 'tools/eval');
  const [evaluationHarness, controllerClosure, queryClosure, cypherClosure] = await Promise.all([
    evaluationHarnessDigest(evaluationDirectory),
    sourceClosureDigest({ repository, entrypoints: [join(evaluationDirectory, 'cli.mjs')] }),
    sourceClosureDigest({ repository, entrypoints: [resolve(repository, 'tools/estate-graph-query.mjs')] }),
    // The Cypher gateway is reached by child process, not by import, so the controller closure
    // cannot see it; bind it explicitly or a gateway edit would not change the behavioral digest.
    sourceClosureDigest({ repository, entrypoints: [resolve(repository, 'tools/estate-graph-cypher.mjs')] }),
  ]);
  // The complete evaluation directory includes worker modules reached by URL at runtime; the
  // controller and query closures bind their external local producer dependencies recursively.
  return sha256(JSON.stringify({ evaluationHarness, controllerClosure, queryClosure, cypherClosure }));
}

function toolSchemasDigest(arm_tools) {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(arm_tools).map(([arm, definition]) => [arm, definition.schema]))));
}

async function bundleEntries(directory, prefix = '') {
  // The journal remains append-only after sealing. Exclude it (and the digest that names this
  // boundary) so the finalized record cannot mutate the bytes that produced bundle.sha256.
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => !['bundle.sha256', 'journal.jsonl'].includes(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const entries = [];
  for (const entry of names) {
    const path = join(directory, entry.name); const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) entries.push(...await bundleEntries(path, `${name}/`));
    else if (entry.isFile()) entries.push(`${name}\0${await readFile(path)}`);
  }
  return entries;
}

function coverageFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'coverage' || typeof value.repo !== 'string' || !value.repo
    || !Number.isInteger(value.files_scanned) || value.files_scanned < 0
    || !Number.isInteger(value.files_skipped) || value.files_skipped < 0
    || !Number.isInteger(value.parse_error_count) || value.parse_error_count < 0
    || !Array.isArray(value.parse_errors)) {
    throw new Error('code-graph coverage fact does not match tools/extract.mjs');
  }
  return value;
}

function available(value) { return { availability: 'available', value }; }

function extractedCoverageFields(codeGraph) {
  if (!Array.isArray(codeGraph.extracted_facts)) {
    return Object.freeze({ corpus: 'unavailable', file: 'unavailable', extractor: 'unavailable',
      refusal: 'unavailable', parse_failed: 'unavailable' });
  }
  const coverage = codeGraph.extracted_facts.filter(fact => fact?.kind === 'coverage').map(coverageFact)
    .sort((left, right) => left.repo.localeCompare(right.repo));
  if (!coverage.length) {
    return Object.freeze({ corpus: 'unavailable', file: 'unavailable', extractor: 'unavailable',
      refusal: 'unavailable', parse_failed: 'unavailable' });
  }
  if (new Set(coverage.map(fact => fact.repo)).size !== coverage.length) {
    throw new Error('code-graph coverage facts duplicate a repository');
  }
  const files = coverage.map(fact => ({ repo: fact.repo, files_scanned: fact.files_scanned,
    files_skipped: fact.files_skipped, parse_error_count: fact.parse_error_count }));
  const byKind = new Map();
  for (const fact of codeGraph.extracted_facts) if (typeof fact?.kind === 'string' && fact.kind.endsWith('_refusal')) {
    byKind.set(fact.kind, (byKind.get(fact.kind) ?? 0) + 1);
  }
  const parseFailed = coverage.map(fact => ({ repo: fact.repo, parse_error_count: fact.parse_error_count,
    parse_errors: fact.parse_errors }));
  return Object.freeze({
    corpus: available({ repositories: files.length, files_scanned: files.reduce((total, row) => total + row.files_scanned, 0),
      files_skipped: files.reduce((total, row) => total + row.files_skipped, 0) }),
    file: available(files),
    // Extracted facts record what ran, not the extractor availability receipt; a zero fact count
    // cannot establish that an extractor was available.
    extractor: 'unavailable',
    refusal: available({ count: [...byKind.values()].reduce((total, count) => total + count, 0),
      by_kind: Object.fromEntries([...byKind].sort(([left], [right]) => left.localeCompare(right))) }),
    parse_failed: available(parseFailed),
  });
}

async function authoritativeCoverage({ config, projection, coverage_artifacts }) {
  if (!coverage_artifacts) return extractedCoverageFields({});
  let claimMap; let claimMapManifest; let codeGraph;
  try {
    const [claimMetadata, loadedCodeGraph] = await Promise.all([
      stat(coverage_artifacts.claim_map), loadJson(coverage_artifacts.code_graph),
    ]);
    codeGraph = loadedCodeGraph;
    if (claimMetadata.isDirectory()) claimMapManifest = await verifyClaimMapShards(coverage_artifacts.claim_map);
    else if (claimMetadata.isFile()) claimMap = await loadJson(coverage_artifacts.claim_map);
    else throw new Error('claim-map coverage artifact must be a file or shard directory');
  } catch (error) {
    throw new Error(`coverage artifacts are unreadable: ${error.message}`);
  }
  let inputs;
  try {
    inputs = claimMapManifest
      ? verifiedProjectionShardInputs({ claim_map_manifest: claimMapManifest, code_graph: codeGraph })
      : verifiedProjectionInputs({ claim_map: claimMap, code_graph: codeGraph });
  } catch (error) { throw new Error(`coverage artifacts are not authoritative projection inputs: ${error.message}`); }
  if (inputs.source_commit !== config.target_commit || inputs.source_commit !== projection.source_commit
    || inputs.claim_map_digest !== projection.claim_map_digest || inputs.code_graph_digest !== projection.code_graph_digest) {
    throw new Error('coverage artifacts do not match the selected projection identity');
  }
  return extractedCoverageFields(codeGraph);
}

export async function coverageDisclosure({ config, projection, rows, coverage_artifacts = config.coverage_artifacts, coverage_fields }) {
  if (config.coverage_disclosure !== undefined) {
    throw new Error('coverage_disclosure is retired; use source-bound coverage_artifacts');
  }
  const filtered_count = rows.reduce((total, row) => total + (row.transcript ?? []).reduce((sum, event) =>
    sum + Number(event?.result?.benchmark_filter?.filtered_count ?? 0), 0), 0);
  return {
    source_contract: 'tools/extract.mjs coverage facts preserved by scripts/remap.mjs',
    projection: { projection_id: projection.projection_id, source_commit: projection.source_commit,
      claim_map_digest: projection.claim_map_digest ?? null, code_graph_digest: projection.code_graph_digest ?? null },
    graph_mode: config.graph_mode,
    benchmark_exclusions: { policy: config.benchmark_policy, filtered_count },
    fields: coverage_fields ?? await authoritativeCoverage({ config, projection, coverage_artifacts }),
  };
}

export async function bundleDigest(directory) {
  return sha256((await bundleEntries(directory)).join('\n'));
}

async function verifyBundle(directory) {
  const recorded = (await readFile(join(directory, 'bundle.sha256'), 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/u.test(recorded) || recorded !== await bundleDigest(directory)) {
    throw new Error('finalized evaluation bundle digest does not match sealed bytes');
  }
  return recorded;
}

export async function verifyFinalizedBundle(directory, finalization, immutable) {
  const payload = finalization?.payload;
  if (finalization?.type !== 'finalized' || !payload || ['bundle_sha256', 'harness_sha256', 'behavioral_source_sha256',
    'runtime_config_sha256', 'runtime_config_digest', 'journal_sha256', 'tool_schemas_sha256']
    .some(field => !/^[0-9a-f]{64}$/u.test(payload[field] ?? ''))) {
    throw new Error('evaluation journal finalization payload is invalid');
  }
  const sealed = await verifyBundle(directory);
  if (payload.bundle_sha256 !== sealed) throw new Error('evaluation journal finalization does not match sealed bundle digest');
  if (payload.journal_sha256 !== await finalizedJournalDigest(join(directory, 'journal.jsonl'))) {
    throw new Error('evaluation journal finalization does not match journal digest');
  }
  if (immutable && (payload.harness_sha256 !== immutable.harness_sha256
    || payload.behavioral_source_sha256 !== immutable.behavioral_source_sha256
    || payload.runtime_config_sha256 !== immutable.runtime_config_sha256
    || payload.runtime_config_digest !== immutable.runtime_config_digest
    || payload.tool_schemas_sha256 !== immutable.tool_schemas_sha256)) {
    throw new Error('evaluation journal finalization does not match immutable harness identity');
  }
  return sealed;
}

async function writeBundle({ directory, config, questions, keys, result, projection, coverage_artifacts, coverage_fields, immutable }) {
  await mkdir(join(directory, 'transcripts'), { recursive: true });
  const rows = executions(result);
  await Promise.all(rows.map(row => writeFile(join(directory, 'transcripts', `${row.execution_id}.jsonl`), jsonLines([
    { type: 'prompt', prompt_sha256: row.prompt_sha256 }, ...row.transcript,
  ]))));
  const spend = spending(rows, config.spend);
  const manifest = {
    schema: 'estate-map/eval-run/v2', run_id: basename(directory), target_commit: config.target_commit,
    question_count: questions.length, repetitions: 2, projection, model_role: config.model_role,
    graph_mode: config.graph_mode, graph_surface: config.graph_surface ?? 'commands',
    turn_budget: config.protocol?.turn_budget ?? null,
    // Declared difficulty travels with the run so a budget sweep can plot correctness against
    // structure per arm; absent when the question set declares none.
    question_difficulty: Object.fromEntries(questions.filter(question => question.difficulty)
      .map(question => [question.question_id, questionDifficulty(question)])),
    benchmark_policy: config.benchmark_policy,
    harness: { harness_sha256: immutable.harness_sha256, behavioral_source_sha256: immutable.behavioral_source_sha256,
      tool_schemas_sha256: immutable.tool_schemas_sha256, final_answer_schema_sha256: immutable.final_answer_schema_sha256 },
    runtime_config: { bytes_sha256: immutable.runtime_config_sha256, resolved_sha256: immutable.runtime_config_digest },
    coverage: await coverageDisclosure({ config, projection, rows, coverage_artifacts, coverage_fields }),
    // A sealed bundle may be regenerated after a crash before its finalized journal record.
    // Do not put a fresh wall-clock value in the hashed boundary.
    aggregate: result.aggregate, spend, generated_at: 'unavailable-from-resumable-journal',
  };
  await writeFile(join(directory, 'manifest.json'), json(manifest));
  await writeFile(join(directory, 'questions.jsonl'), jsonLines(questions));
  await writeFile(join(directory, 'keys.jsonl'), jsonLines([...keys.values()]));
  await writeFile(join(directory, 'executions.jsonl'), jsonLines(rows.map(({ transcript, ...row }) => row)));
  await writeFile(join(directory, 'scores.json'), json(rows.map(row => ({ execution_id: row.execution_id, score: row.score }))));
  await writeFile(join(directory, 'judge-events.jsonl'), jsonLines(rows.filter(row => row.score?.judge_event).map(row => ({
    execution_id: row.execution_id, judge_event: row.score.judge_event, judge_usage: row.score.judge_usage ?? null,
    judge_stderr: row.score.judge_stderr ?? null,
  }))));
  await writeFile(join(directory, 'report.md'), report(result, rows, spend));
  await writeFile(join(directory, 'study-report.json'), json({ aggregate: result.aggregate, raw_counts: { arm_executions: rows.length, questions: questions.length }, spend }));
  const digest = await bundleDigest(directory);
  await writeFile(join(directory, 'bundle.sha256'), `${digest}\n`);
  return { rows, spend };
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const configPath = resolve(options.config ?? defaultEvaluationConfig());
  const config = await loadJson(configPath);
  const access = evaluationAccessPolicy(config);
  const paths = configPaths(config, configPath, root);
  const coverage_artifacts = coverageArtifactPaths(config, configPath, paths.source_repository);
  const runId = options.run_id ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = externalResultsPath(join(paths.results, runId), root);
  const target_commit = await verifyTarget(paths.source_repository, required(config.target_commit, 'target_commit'));
  const runtime = loadEstateMapRuntimeConfig(paths.runtime_config);
  const model = configuredModel(runtime, required(config.model_role, 'model_role'));
  const judgeModel = configuredModel(runtime, config.judge_model_role ?? config.model_role);
  validateConfiguredPiModels(runtime, { roles: [...new Set([config.model_role, config.judge_model_role ?? config.model_role])] });
  const questions = await loadJsonLines(paths.questions);
  validateQuestionSet(questions);
  const keyRows = await loadJsonLines(paths.keys);
  // Fail the entire run before checkout, journal, or model dispatch: silently skipping one question
  // would leave a partially paid study that still looks like a completed experiment.
  const keys = sealedKeyMap(keyRows);
  validateSealedKeys(questions, keys);
  const expected = config.question_count;
  if (expected !== undefined && !Number.isInteger(expected)) throw new Error('question_count must be an integer when present');
  if (!questions.length) throw new Error('question set is empty');
  if (Number.isInteger(expected) && questions.length !== expected) throw new Error(`question set has ${questions.length} questions; config declares question_count ${expected}`);
  const evaluation = evaluationConfig(config, target_commit, model, questions);
  const query_script = resolve(root, 'tools/estate-graph-query.mjs');
  const projection = await preflightProjection({ runtime_config_path: paths.runtime_config, query_script, target_commit });
  const coverage_config = { ...config, ...access, target_commit };
  // Validate the producer artifacts before paid work and hash their derived disclosure into the
  // journal header. A changed external artifact cannot silently alter a resumed run's manifest.
  const coverage_fields = await authoritativeCoverage({ config: coverage_config,
    projection: projection.selected, coverage_artifacts });
  if (options.prepare_only) return { prepared: true, target_commit, projection };
  const checkout = await makeReadOnlyCheckout(paths.source_repository, target_commit);
  let journal; let records = [];
  try {
    const filesystem = createFilesystemArm({ checkout, benchmark_policy: access.benchmark_policy });
    const graph = access.graph_surface === 'cypher'
      ? createCypherArm({ runtime_config_path: paths.runtime_config, query_script,
        cypher_script: resolve(root, 'tools/estate-graph-cypher.mjs'),
        benchmark_policy: access.benchmark_policy, graph_mode: access.graph_mode })
      : createGraphArm({ runtime_config_path: paths.runtime_config, query_script,
        benchmark_policy: access.benchmark_policy, graph_mode: access.graph_mode });
    const arm_tools = { filesystem, graph, both: createBothArm({ filesystem, graph }) };
    const immutable = {
      target_commit, projection: projection.selected, graph_mode: access.graph_mode,
      graph_surface: access.graph_surface, benchmark_policy: access.benchmark_policy,
      model, judge_model: judgeModel, config_sha256: sha256(JSON.stringify(config)),
      runtime_config_sha256: sha256(await readFile(paths.runtime_config)), runtime_config_digest: runtime.digest,
      questions_sha256: sha256(JSON.stringify(questions)), keys_sha256: sha256(JSON.stringify(keyRows)),
      harness_sha256: await evaluationHarnessDigest(), behavioral_source_sha256: await behavioralSourceDigest(),
      tool_schemas_sha256: toolSchemasDigest(arm_tools),
      final_answer_schema_sha256: sha256(JSON.stringify(evaluation.protocol.final_answer_schema)),
      coverage_fields_sha256: sha256(JSON.stringify(coverage_fields)),
    };
    // Custody is created before the first model process. A sudden process death can lose only the
    // currently-paid unit because every later emission and outcome appends and fsyncs this journal.
    await mkdir(paths.results, { recursive: true });
    externalResultsPath(paths.results, root);
    if (options.resume) {
      ({ records, journal } = await resumeJournal({ path: join(directory, 'journal.jsonl'), immutable }));
      if (records.at(-1).type === 'finalized') {
        await verifyFinalizedBundle(directory, records.at(-1), immutable);
        return { directory, resumed: true, finalized: true };
      }
    } else {
      await mkdir(directory, { recursive: false });
      externalResultsPath(directory, root);
      journal = await createJournal({ path: join(directory, 'journal.jsonl'), immutable });
    }
    const model_runner = pathToFileURL(resolve(root, 'tools/eval/pi-model-runner.mjs')).href;
    const judge_runner = { run: request => runModelInFreshProcess({ model_runner, request: { kind: 'blind-judge', model: judgeModel, judge_request: request } }) };
    const result = await runEvaluation({ config: evaluation, questions, keys, arm_tools,
      model_runner, judge_runner, completed: completedExecutions(records), pending: pendingExecutions(records),
      checkpoint: ({ type, ...payload }) => journal.append(type, payload) });
    const bundle = await writeBundle({ directory, config: coverage_config, questions, keys, result,
      projection: projection.selected, coverage_artifacts, coverage_fields, immutable });
    const bundle_sha256 = (await readFile(join(directory, 'bundle.sha256'), 'utf8')).trim();
    await journal.append('finalized', { bundle_sha256, journal_sha256: await journal.digest(),
      harness_sha256: immutable.harness_sha256, behavioral_source_sha256: immutable.behavioral_source_sha256,
      runtime_config_sha256: immutable.runtime_config_sha256, runtime_config_digest: immutable.runtime_config_digest,
      tool_schemas_sha256: immutable.tool_schemas_sha256 });
    return { directory, result, ...bundle };
  } finally {
    await journal?.close();
    await removeCheckout(paths.source_repository, checkout);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(result => console.log(json({ result: result.directory ?? result }))).catch(error => {
    console.error(json({ error: error.message })); process.exitCode = 1;
  });
}
