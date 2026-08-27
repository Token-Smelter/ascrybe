import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JOURNAL_SCHEMA, completedExecutions, createJournal, finalizedJournalDigest, pendingExecutions, readJournal, resumeJournal } from '../tools/eval/journal.mjs';
import { createGraphArm, filterBenchmarkRows, OUTPUT_LIMIT_BYTES } from '../tools/eval/graph-arm.mjs';
import { retryModelCall } from '../tools/eval/retry.mjs';
import { bundleDigest, coverageDisclosure, report, sourceClosureDigest, verifyFinalizedBundle } from '../tools/eval/cli.mjs';
import { aggregatePairs } from '../tools/eval/aggregate.mjs';
import { verifiedProjectionInputs, verifiedProjectionShardInputs } from '../tools/estate-graph-projection.mjs';
import { writeClaimMapShards } from '../tools/claim-map-shards.mjs';
import { stableCanonicalSha256 } from '../tools/lib.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { mergeFacts } from '../tools/merge.mjs';
import { remapCodePlane } from '../scripts/remap.mjs';

const catalogFixture = fileURLToPath(new URL('./fixtures/catalog-coverage/estate', import.meta.url));
const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();

function journalExecution(execution_id = 'one') {
  return { execution_id, question_id: 'q1', repetition: 1, arm: 'filesystem', anonymous_order: 1, attempt: 1,
    prompt_sha256: 'a'.repeat(64), turns_used: 1, transcript: [],
    answer: { answer_kind: 'set', answer_units: [], citations: [], abstained: true,
      abstention_reason: 'no valid final answer', limitations: [] },
    termination: { reason: 'turn_limit' },
    usage: { provider_input_tokens: 0, provider_output_tokens: 0, tokens_consumed: 0, reported_cost_usd: null },
    elapsed_monotonic_ms: 0 };
}

test('journal fsync custody reuses only complete execution and rejects mismatch or corruption', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-journal-'));
  const path = join(directory, 'journal.jsonl');
  const immutable = { target_commit: 'a'.repeat(40), questions_sha256: 'q', keys_sha256: 'k',
    runtime_config_sha256: 'r'.repeat(64), runtime_config_digest: 'd'.repeat(64), behavioral_source_sha256: 'b'.repeat(64) };
  try {
    const journal = await createJournal({ path, immutable });
    await journal.append('execution', { execution: journalExecution() });
    await assert.rejects(() => journal.append('arm_event', { execution_id: 'one', arm: 'filesystem',
      event: { type: 'model_attempt', attempt: 1, outcome: 'success', extra: true } }), /corrupt or unsupported/u);
    await assert.rejects(() => journal.append('judge_attempt', { execution_id: 'one',
      event: { type: 'model_attempt', attempt: 'one', outcome: 'success' } }), /corrupt or unsupported/u);
    await assert.rejects(() => journal.append('execution', { execution: {
      ...journalExecution('bad-abstention'), answer: { ...journalExecution().answer, abstention_reason: null },
    } }), /corrupt or unsupported/u);
    await assert.rejects(() => journal.append('score', { execution_id: 'one', score: {
      correctness: 2, exact_citation_rate: 1, confidently_wrong_rate: 0,
    } }), /corrupt or unsupported/u);
    await journal.close();
    assert.equal(completedExecutions(await readJournal(path)).size, 0, 'an interrupted current unit is not reused as scored');
    assert.equal(pendingExecutions(await readJournal(path)).size, 1, 'an interrupted judge resumes from its fsynced arm execution');
    const resumed = await resumeJournal({ path, immutable });
    await resumed.journal.append('score', { execution_id: 'one', score: {
      correctness: 1, exact_citation_rate: 1, confidently_wrong_rate: 0 } });
    await resumed.journal.close();
    assert.equal(completedExecutions(await readJournal(path)).get('one').score.correctness, 1);
    await assert.rejects(() => resumeJournal({ path, immutable: { ...immutable, keys_sha256: 'wrong' } }), /immutable inputs/u);
    await assert.rejects(() => resumeJournal({ path, immutable: { ...immutable, runtime_config_sha256: 'x'.repeat(64) } }), /immutable inputs/u);
    await assert.rejects(() => resumeJournal({ path, immutable: { ...immutable, behavioral_source_sha256: 'y'.repeat(64) } }), /immutable inputs/u);
    writeFileSync(path, '{not-json}\n');
    await assert.rejects(() => readJournal(path), /partial or corrupt/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retry is bounded to typed provider failures and records every attempt', async () => {
  const events = []; let calls = 0;
  const result = await retryModelCall({ attempts: 3, backoff_ms: 0, sleep: async () => {}, checkpoint: event => events.push(event),
    call: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('No API key found for openai-codex');
        error.code = 'EVAL_MODEL_UNAVAILABLE';
        throw error;
      }
      return { value: 'recovered' };
    } });
  assert.equal(result.result.value, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => [event.attempt, event.outcome, event.error_class]), [[1, 'error', 'model_unavailable'], [2, 'success', undefined]]);
  calls = 0;
  const deterministic = await retryModelCall({ attempts: 3, backoff_ms: 0, sleep: async () => {}, call: async () => {
    calls += 1; throw new Error('No API key found for openai-codex');
  } });
  assert.equal(calls, 1);
  assert.equal(deterministic.error_class, 'deterministic');
  const delays = [];
  const exhausted = await retryModelCall({ attempts: 2, backoff_ms: 7, sleep: async delay => delays.push(delay),
    call: async () => { const error = new Error('provider outage'); error.code = 'EVAL_MODEL_TRANSIENT'; throw error; } });
  assert.equal(exhausted.error_class, 'model_unavailable');
  assert.deepEqual(delays, [7]);
  assert.deepEqual(exhausted.attempts.map(event => [event.error_class, event.delay_ms]), [['transient', 7], ['transient', 0]]);
});

test('coverage disclosure derives S9 fields from projection-bound producer artifacts', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-coverage-'));
  const target_commit = 'a'.repeat(40);
  const claimMapBody = {
    schema: 'estate-map/claim-evidence-map/v1', project: { id: 'fixture', sha: target_commit },
    policy: {}, claims: [], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [], coverage: {},
  };
  const claimMap = { ...claimMapBody, digest: stableCanonicalSha256(claimMapBody) };
  try {
    const estate = join(directory, 'estate');
    const work = join(directory, 'work');
    const remap = join(directory, 'remap');
    cpSync(join(catalogFixture, 'fixture'), join(estate, 'fixture'), { recursive: true });
    await extractEstate(estate, join(work, 'extract'), { repo: 'fixture', strict: true,
      catalog_globs: ['catalogs/**/*.json', 'catalogs/**/*.yaml'] });
    await mergeFacts(join(work, 'extract'), join(work, 'merge'));
    remapCodePlane({ work, sha: target_commit, out: remap });
    // The claim-map and code-graph bytes have the producer shapes from semantic-map-run.mjs and
    // scripts/remap.mjs; the expected counts below come from extract.mjs's emitted fact stream.
    const codeGraph = JSON.parse(readFileSync(join(remap, 'adjacency.json'), 'utf8'));
    const sourceFacts = readFileSync(join(work, 'extract', 'facts', 'fixture.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(JSON.parse);
    const coverage = sourceFacts.find(fact => fact.kind === 'coverage');
    const refusalKinds = sourceFacts.filter(fact => fact.kind.endsWith('_refusal')).map(fact => fact.kind);
    const claimPath = join(directory, 'claim-evidence-map.json');
    const graphPath = join(remap, 'adjacency.json');
    writeFileSync(claimPath, `${JSON.stringify(claimMap)}\n`);
    const inputs = verifiedProjectionInputs({ claim_map: claimMap, code_graph: codeGraph });
    const projection = { projection_id: 'estate-projection:one', ...inputs };
    const config = { target_commit, graph_mode: 'index-only', benchmark_policy: {},
      coverage_artifacts: { claim_map: claimPath, code_graph: graphPath } };
    const disclosed = await coverageDisclosure({ config, projection, rows: [] });
    assert.deepEqual(disclosed, {
      source_contract: 'tools/extract.mjs coverage facts preserved by scripts/remap.mjs',
      projection, graph_mode: 'index-only', benchmark_exclusions: { policy: {}, filtered_count: 0 },
      fields: {
        corpus: { availability: 'available', value: { repositories: 1, files_scanned: coverage.files_scanned,
          files_skipped: coverage.files_skipped } },
        file: { availability: 'available', value: [{ repo: coverage.repo, files_scanned: coverage.files_scanned,
          files_skipped: coverage.files_skipped, parse_error_count: coverage.parse_error_count }] },
        extractor: 'unavailable',
        refusal: { availability: 'available', value: { count: refusalKinds.length,
          by_kind: Object.fromEntries([...new Set(refusalKinds)].sort().map(kind => [kind,
            refusalKinds.filter(candidate => candidate === kind).length])) } },
        parse_failed: { availability: 'available', value: [{ repo: coverage.repo,
          parse_error_count: coverage.parse_error_count, parse_errors: coverage.parse_errors }] },
      },
    });
    await assert.rejects(() => coverageDisclosure({ config, projection: { ...projection, code_graph_digest: '0'.repeat(64) }, rows: [] }),
    /do not match the selected projection identity/u);
    const shardRoot = join(directory, 'claim-evidence-shards');
    const shardManifest = await writeClaimMapShards({ map: claimMap, output_dir: shardRoot });
    assert.deepEqual(verifiedProjectionShardInputs({ claim_map_manifest: shardManifest, code_graph: codeGraph }), inputs);
    const shardConfig = { ...config, coverage_artifacts: { claim_map: shardRoot, code_graph: graphPath } };
    assert.deepEqual(await coverageDisclosure({ config: shardConfig, projection, rows: [] }), disclosed);
    appendFileSync(join(shardRoot, 'claims.jsonl'), '{}\n');
    await assert.rejects(() => coverageDisclosure({ config: shardConfig, projection, rows: [] }),
      /coverage artifacts are unreadable.*count, bytes, or digest differs/u);
    writeFileSync(claimPath, `${JSON.stringify({ ...claimMap, coverage: { forged: true } })}\n`);
    await assert.rejects(() => coverageDisclosure({ config, projection, rows: [] }),
      /not authoritative projection inputs/u);
    await assert.rejects(() => coverageDisclosure({ config: { ...config, coverage_disclosure: { corpus: true } }, projection, rows: [] }),
      /coverage_disclosure is retired/u);
    assert.deepEqual((await coverageDisclosure({ config: { target_commit, graph_mode: 'index-only', benchmark_policy: {} },
      projection, rows: [] })).fields,
    { corpus: 'unavailable', file: 'unavailable', extractor: 'unavailable', refusal: 'unavailable', parse_failed: 'unavailable' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report renders every contrast and metric overall and by stratum', () => {
  const execution = arm => ({ arm, termination: { reason: 'final' }, answer: { abstained: false },
    usage: { tokens_consumed: 2, reported_cost_usd: 0.01 }, elapsed_monotonic_ms: 3,
    score: { correctness: arm === 'both' ? 1 : 0, exact_citation_rate: 1, confidently_wrong_rate: 0 } });
  const pairs = [{ question_id: 'q1', stratum: 'covered', repetitions: [1, 2].map(repetition => ({ repetition,
    filesystem: execution('filesystem'), graph: execution('graph'), both: execution('both'),
  })) }];
  const aggregate = aggregatePairs({ pairs, plan: [{ question_id: 'q1', stratum: 'covered' }],
    declared_strata: ['covered'], seed: 1, bootstrap_samples: 20 });
  const rendered = report({ pairs, aggregate }, [], { estimated_usd: 0, actual_usd: null, actual_spend_status: 'unavailable' });
  for (const effect of ['both_minus_filesystem', 'graph_minus_filesystem', 'both_minus_graph']) {
    assert.match(rendered, new RegExp(`### ${effect}`, 'u'));
  }
  for (const metric of ['correctness', 'exact_citation_rate', 'confidently_wrong_rate', 'abstention',
    'tokens_consumed', 'wall_clock_ms', 'invalidity', 'spend']) assert.match(rendered, new RegExp(metric, 'u'));
  assert.match(rendered, /## Stratum: covered/u);
  assert.equal(rendered.includes('undefined'), false);
});

test('bundle digest seals deliverables but not the append-only journal', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-bundle-'));
  try {
    writeFileSync(join(directory, 'manifest.json'), '{"sealed":true}\n');
    writeFileSync(join(directory, 'journal.jsonl'), '{"type":"header"}\n');
    const before = await bundleDigest(directory);
    writeFileSync(join(directory, 'journal.jsonl'), '{"type":"header"}\n{"type":"finalized"}\n');
    assert.equal(await bundleDigest(directory), before);
    writeFileSync(join(directory, 'manifest.json'), '{"sealed":false}\n');
    assert.notEqual(await bundleDigest(directory), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('source closure digest binds recursive producer dependencies', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-source-closure-'));
  try {
    const entry = join(directory, 'entry.mjs');
    const producer = join(directory, 'producer.mjs');
    writeFileSync(entry, "import { value } from './producer.mjs';\nexport { value };\n");
    writeFileSync(producer, 'export const value = 1;\n');
    const before = await sourceClosureDigest({ repository: directory, entrypoints: [entry] });
    writeFileSync(producer, 'export const value = 2;\n');
    assert.notEqual(await sourceClosureDigest({ repository: directory, entrypoints: [entry] }), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('finalized journal hash-binds the bundle, harness, schemas, and pre-final journal', async () => {
  const directory = mkdtempSync(join(scratch, 'eval-finalization-'));
  const path = join(directory, 'journal.jsonl');
  const immutable = { harness_sha256: 'a'.repeat(64), behavioral_source_sha256: 'c'.repeat(64),
    runtime_config_sha256: 'd'.repeat(64), runtime_config_digest: 'e'.repeat(64), tool_schemas_sha256: 'b'.repeat(64) };
  try {
    writeFileSync(join(directory, 'manifest.json'), '{"sealed":true}\n');
    const digest = await bundleDigest(directory);
    writeFileSync(join(directory, 'bundle.sha256'), `${digest}\n`);
    const journal = await createJournal({ path, immutable });
    await journal.append('finalized', { bundle_sha256: digest, journal_sha256: await journal.digest(), ...immutable });
    await journal.close();
    const record = (await readJournal(path)).at(-1);
    assert.equal(await verifyFinalizedBundle(directory, record, immutable), digest);
    assert.equal(await finalizedJournalDigest(path), record.payload.journal_sha256);
    await assert.rejects(() => verifyFinalizedBundle(directory, record, { ...immutable, harness_sha256: 'c'.repeat(64) }), /harness identity/u);
    writeFileSync(join(directory, 'manifest.json'), '{"sealed":false}\n');
    await assert.rejects(() => verifyFinalizedBundle(directory, record, immutable), /does not match sealed bytes/u);
    const records = (await readJournal(path)).map(value => structuredClone(value));
    records[0].payload.harness_sha256 = 'c'.repeat(64);
    writeFileSync(path, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    await assert.rejects(() => readJournal(path), /partial or corrupt/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('overflowed filtered graph results retain benchmark filtering for coverage disclosure', async () => {
  const policy = { material: 'committed', excluded_path_prefixes: ['benchmarks'] };
  const arm = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
    benchmark_policy: policy, execute: async () => ({ stdout: JSON.stringify({ schema: 'estate-map/query-result/v1', query: 'search', data: [
      { id: 'fact:large', kind: 'CodeFact', label: 'large projected node', properties: { source_path: 'src/large.mjs', payload: 'x'.repeat(OUTPUT_LIMIT_BYTES) } },
      { id: 'doc:answer-key', kind: 'Document', label: 'answer key', properties: { source_path: 'benchmarks/answer-key.md' } },
    ] }) }) });
  const result = await arm.tools.estate_query({ command: 'search', arguments: { term: 'node' } });
  assert.equal(result.error, 'EVAL_TOOL_OUTPUT_LIMIT');
  assert.deepEqual(result.benchmark_filter, { filtered_count: 1, excluded_path_prefixes: ['benchmarks'] });
  const disclosure = await coverageDisclosure({ config: { graph_mode: 'index-only', benchmark_policy: policy },
    projection: { projection_id: 'estate-projection:one', source_commit: 'a'.repeat(40) },
    rows: [{ transcript: [{ result }] }], coverage_fields: {} });
  assert.equal(disclosure.benchmark_exclusions.filtered_count, 1);
});

test('benchmark-filtered read-span refusal remains counted in disclosure', async () => {
  const policy = { material: 'committed', excluded_path_prefixes: ['benchmarks'] };
  const arm = createGraphArm({ runtime_config_path: '/controller-only/runtime.json', query_script: '/controller-only/query.mjs',
    benchmark_policy: policy, execute: async () => ({ stdout: JSON.stringify({ schema: 'estate-map/query-result/v1',
      query: 'read-span', data: { id: 'fact:key', properties: { source_path: 'benchmarks/answer-key.md' } } }) }) });
  const result = await arm.tools.estate_query({ command: 'read-span', arguments: { id: 'fact:key' } });
  assert.equal(result.error, 'EVAL_BENCHMARK_PATH_EXCLUDED');
  const disclosure = await coverageDisclosure({ config: { graph_mode: 'as-deployed', benchmark_policy: policy },
    projection: { projection_id: 'estate-projection:one', source_commit: 'a'.repeat(40) },
    rows: [{ transcript: [{ type: 'tool_result', result }] }], coverage_fields: {} });
  assert.equal(disclosure.benchmark_exclusions.filtered_count, 1);
});

test('benchmark filtering removes a contaminated traversal node and its directed incident edge', () => {
  const source = { data: {
    focal_node: { id: 'envelope:ok', kind: 'Envelope', properties: {} },
    adjacent_nodes: [
      { id: 'plugin:ok', kind: 'Plugin', properties: { source_path: 'src/plugin.mjs' } },
      { id: 'plugin:answer-key', kind: 'Plugin', properties: { source_path: 'benchmarks/answer-key.md' } },
    ],
    edges: [
      { id: 'edge:ok', from: 'plugin:ok', to: 'envelope:ok' },
      { id: 'edge:leak', from: 'plugin:answer-key', to: 'envelope:ok' },
    ],
  } };
  const result = filterBenchmarkRows(source, { material: 'committed', excluded_path_prefixes: ['benchmarks'] });
  assert.deepEqual(result.value.data.adjacent_nodes.map(node => node.id), ['plugin:ok']);
  assert.deepEqual(result.value.data.edges.map(edge => edge.id), ['edge:ok']);
  assert.equal(result.filtered, 1);
});
