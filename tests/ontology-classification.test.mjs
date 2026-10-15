import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEstateMapRuntimeConfig } from '../tools/ascrybe-config.mjs';
import { stableStringify } from '../tools/lib.mjs';
import {
  buildClassificationPacket, classificationQuestions, classifyOntologyPacket, gapCandidate,
  appendGapCandidate, analyzeGap, classificationEvaluationManifest,
} from '../tools/ontology/classification.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = 'export function registerWidget(context) { context.capabilities.provide("widget", "1.0", () => ({})); }';
const concepts = [
  { id: 'role-provider', label: 'Capability provider', definition: 'Formally registers a named plugin capability.',
    boundary: 'An arbitrary exported function is not a registered capability.' },
  { id: 'role-storage', label: 'Application-state store', definition: 'Owns persistent application-state storage.',
    boundary: 'Loading a config file alone is not storage ownership.' },
];
function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-widget-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'widget.mjs'), `${source}\n`);
  git(dir, 'add', 'widget.mjs');
  execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Create widget']);
  const commit = git(dir, 'rev-parse', 'HEAD');
  const input = { kind: 'code', subject: { kind: 'Module', node_id: 'module:widget', projection_id: 'estate-projection:widgets',
    provenance: 'production', scope: 'own_code' },
  sources: [{ path: 'widget.mjs', commit_sha: commit, blob_oid: git(dir, 'rev-parse', `${commit}:widget.mjs`),
    start_line: 1, end_line: 1, content_sha256: hash(source), text: source, role: 'primary' }],
  taxonomy: { ontology_version_digest: hash(stableStringify(concepts).trim()), concepts } };
  return { dir, input, packet: buildClassificationPacket(input, { repository: dir }) };
}
const model = { runner: 'pi', name: 'example-provider/example-model', thinking: 'off', timeout_ms: 60_000 };
const runtime = (system_one = null) => ({ models: { code_claims: model }, ontology_classification: {
  llm_role: 'code_claims', llm_max_input_bytes: 100_000, system_one,
} });
const plain = { role_1: 'member', role_2: 'not_member', coverage: 'existing_type' };
const llm = async () => ({ answers: plain, model: model.name, usage: { cost: { total: 0.0002 } }, actual_reasoning_effort: 'low' });
const jev = async request => ({ resolved_model: 'typesafe/jev-1.13-20260917', request_digest: hash(JSON.stringify(request)),
  usage: { cost: 0.00001, input_tokens: 200 }, latency_ms: 18,
  answers: Object.fromEntries(Object.entries(plain).map(([id, choice]) => [id,
    { type: 'choice', choice, confidence: 0.91,
      probabilities: Object.fromEntries(Object.keys(request.questions[id].criteria).map(key => [key, key === choice ? 1 : 0])) }])),
});

test('a pinned source packet rejects content changed after its recorded Git commit', () => {
  const f = fixture();
  const altered = structuredClone(f.input); altered.sources[0].text = 'export const widget = 2;';
  altered.sources[0].content_sha256 = hash(altered.sources[0].text);
  assert.throws(() => buildClassificationPacket(altered, { repository: f.dir }), error => error.code === 'CLASSIFICATION_SOURCE_NOT_AT_PIN');
});

test('a sealed classification packet refuses source edits before any model call', async () => {
  const f = fixture(), corrupted = structuredClone(f.packet);
  corrupted.sources[0].text = 'export const widget = false;';
  let called = false;
  await assert.rejects(() => classifyOntologyPacket({ packet: corrupted, runtime: runtime(),
    llm: async () => { called = true; return llm(); } }), error => error.code === 'CLASSIFICATION_PACKET_INVALID');
  assert.equal(called, false);
});

test('a packet is identical across a selected LLM-only and optional accelerator route', async () => {
  const { packet } = fixture();
  const a = await classifyOntologyPacket({ packet, runtime: runtime(), llm });
  const b = await classifyOntologyPacket({ packet, runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, systemOne: jev, llm });
  assert.deepEqual({ packet: [a.packet_id, b.packet_id], config_same: a.configuration_id === b.configuration_id,
    backends: [a.backend, b.backend] },
  { packet: [packet.packet_id, packet.packet_id], config_same: false, backends: ['llm', 'system_one'] });
});

test('LLM-only works with no accelerator or Jev key and never invents native probabilities', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), environment: {},
    systemOne: () => { throw Error('must not call'); }, llm });
  assert.deepEqual({ status: result.status, backend: result.backend, confidence: result.native_probabilities,
    fallback: result.fallback_reason, types: result.selected_type_ids },
  { status: 'classified', backend: 'llm', confidence: null, fallback: 'system_one_not_configured', types: ['role-provider'] });
});

test('Jev-enabled keeps raw native distributions and its resolved model', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, systemOne: jev, llm });
  assert.deepEqual({ backend: result.backend, model: result.model, probability: result.native_probabilities.role_1.member,
    attempted: result.attempts.map(x => x.backend) },
  { backend: 'system_one', model: 'typesafe/jev-1.13-20260917', probability: 1, attempted: ['system_one'] });
});

test('Jev uncertainty falls back while preserving native probabilities and confidence separately from the LLM', async () => {
  const { packet } = fixture();
  const uncertain = async request => {
    const response = await jev(request);
    response.answers.role_2.choice = 'insufficient_evidence';
    response.answers.role_2.confidence = 0.2;
    return response;
  };
  const result = await classifyOntologyPacket({ packet,
    runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, systemOne: uncertain, llm });
  assert.deepEqual({ backend: result.backend, fallback: result.fallback_reason,
    raw_choice: result.native_answers.role_2.choice, raw_confidence: result.native_answers.role_2.confidence,
    llm_probability: result.attempts.at(-1).usage?.probabilities ?? null },
  { backend: 'llm', fallback: 'native_uncertainty_or_missing_context',
    raw_choice: 'insufficient_evidence', raw_confidence: 0.2, llm_probability: null });
});

test('missing accelerator credential records reason and falls back to selected LLM', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: {}, systemOne: () => { throw Error('must not call'); }, llm });
  assert.deepEqual({ fallback: result.fallback_reason, backend: result.backend, attempts: result.attempts.map(a =>
    [a.backend, a.status, a.cost_usd]) },
  { fallback: 'system_one_credential_absent', backend: 'llm',
    attempts: [['system_one', 'not_dispatched', null], ['llm', 'answered', 0.0002]] });
});

test('accelerator outage is bounded and records failed attempts with unknown cost before fallback', async () => {
  const { packet } = fixture(); let calls = 0;
  const result = await classifyOntologyPacket({ packet, runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, retryDelayMs: 0,
    systemOne: async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'JEV_TRANSPORT_FAILED' }); }, llm });
  assert.deepEqual({ calls, reasons: result.attempts.map(a => [a.backend, a.status, a.cost_usd]), fallback: result.fallback_reason },
    { calls: 2, reasons: [['system_one', 'failed', null], ['system_one', 'failed', null], ['llm', 'answered', 0.0002]],
      fallback: 'JEV_TRANSPORT_FAILED' });
});

test('an answered but inconsistent Jev decision is billed once and falls back without retry', async () => {
  const { packet } = fixture(); let calls = 0;
  const malformed = async request => {
    calls++;
    const receipt = await jev(request);
    receipt.answers.coverage.choice = 'no_existing_type';
    return receipt;
  };
  const result = await classifyOntologyPacket({ packet,
    runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, systemOne: malformed, llm });
  assert.deepEqual({ calls, fallback: result.fallback_reason, attempts: result.attempts.map(a => [a.backend, a.status, a.cost_usd]) },
  { calls: 1, fallback: 'CLASSIFICATION_RESPONSE_INVALID',
    attempts: [['system_one', 'answered', 0.00001], ['llm', 'answered', 0.0002]] });
});

test('a too-large Jev request routes the unchanged packet to LLM and records size', async () => {
  const f = fixture();const large = structuredClone(f.input);large.sources[0].text = 'W'.repeat(32_000);
  large.sources[0].content_sha256 = hash(large.sources[0].text);const packet = buildClassificationPacket(large);
  let observed = null;
  const result = await classifyOntologyPacket({ packet, runtime: runtime({ model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' }),
    environment: { OPENROUTER_API_KEY: 'fixture' }, systemOne: () => { throw Error('must not call'); },
    llm: async received => { observed = received.packet_id; return llm(); } });
  assert.deepEqual({ fallback: result.fallback_reason, unchanged: observed === packet.packet_id, backend: result.backend },
    { fallback: 'system_one_context_oversize', unchanged: true, backend: 'llm' });
});

test('oversize for both backends needs context and never fabricates a label', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: { models: { code_claims: model }, ontology_classification: {
    llm_role: 'code_claims', llm_max_input_bytes: 10, system_one: null } },
    llm: async (p, q, m, opts) => { if (opts.maxInputBytes < JSON.stringify(p).length) throw Object.assign(new Error('oversize'),
      { code: 'CLASSIFICATION_LLM_CONTEXT_OVERSIZE' }); } });
  assert.deepEqual({ status: result.status, code: result.reason_code, types: result.selected_type_ids },
    { status: 'needs_context', code: 'CLASSIFICATION_LLM_CONTEXT_OVERSIZE', types: [] });
});

test('if selected LLM is unavailable, classification is pending rather than guessed', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => { throw Object.assign(new Error('unavailable'),
    { code: 'CLASSIFICATION_LLM_UNAVAILABLE' }); } });
  assert.deepEqual({ status: result.status, code: result.reason_code, types: result.selected_type_ids },
    { status: 'pending', code: 'CLASSIFICATION_LLM_UNAVAILABLE', types: [] });
});

test('secret nested inside imported context blocks both backends before any attempt', async () => {
  const f = fixture();const input = structuredClone(f.input);input.sources.push({ ...input.sources[0], role: 'implementation',
    text: `const api_key = "${'A'.repeat(32)}";` });
  input.sources[1].content_sha256 = hash(input.sources[1].text);
  assert.throws(() => buildClassificationPacket(input), error => error.code === 'JEV_OUTBOUND_SECRET_REFUSED');
});

test('multiple code roles can be members while scheme coverage remains separate', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => ({
    answers: { role_1: 'member', role_2: 'member', coverage: 'existing_type' }, model: model.name,
  }) });
  assert.deepEqual(result.selected_type_ids, ['role-provider', 'role-storage']);
});

test('eight negative roles do not automatically become an ontology gap without explicit coverage', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => ({
    answers: { role_1: 'not_member', role_2: 'not_member', coverage: 'insufficient_evidence' }, model: model.name,
  }) });
  assert.equal(result.status, 'insufficient_evidence');
});

test('explicit none produces one stable proposed gap and deduplicates queue writes', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => ({
    answers: { role_1: 'not_member', role_2: 'not_member', coverage: 'no_existing_type' }, model: model.name,
  }) });
  const gap = gapCandidate(packet, result), file = join(mkdtempSync(join(tmpdir(), 'ontology-gaps-')), 'queue.jsonl');
  const first = appendGapCandidate(file, gap), second = appendGapCandidate(file, gap);
  assert.deepEqual({ status: result.status, proposal: gap.status, first, second,
    rows: readFileSync(file, 'utf8').trim().split('\n').length },
  { status: 'no_existing_type', proposal: 'proposed', first: true, second: false, rows: 1 });
});

test('a discovered document scheme permits independent overlapping concepts', async () => {
  const f = fixture(), input = structuredClone(f.input);
  input.kind = 'document'; input.subject.kind = 'Document'; input.subject.scope = 'document_source';
  input.subject.provenance = 'documentary'; input.taxonomy.cardinality = 'many_to_many';
  const packet = buildClassificationPacket(input, { repository: f.dir });
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => ({
    model: model.name, answers: { role_1: 'member', role_2: 'member', coverage: 'existing_type' },
  }) });
  assert.deepEqual({ status: result.status, members: result.selected_type_ids },
    { status: 'classified', members: ['role-provider', 'role-storage'] });
});

test('claim and document classifications preserve none, insufficient, and out-of-scope distinctly', async () => {
  const f = fixture();const results = [];
  for (const [kind, subjectKind, type, coverage] of [
    ['claim', 'Claim', 'no_existing_type', 'no_existing_type'],
    ['claim', 'Claim', 'insufficient_evidence', 'insufficient_evidence'],
    ['document', 'Document', 'out_of_scope', 'out_of_scope'],
  ]) {
    const input = structuredClone(f.input);
    input.kind = kind;input.subject.kind = subjectKind;input.subject.scope = 'document_source';
    const packet = buildClassificationPacket(input, { repository: f.dir });
    const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm: async () => ({
      model: model.name, answers: { type, coverage },
    }) });
    results.push(result.status);
  }
  assert.deepEqual(results, ['no_existing_type', 'insufficient_evidence', 'out_of_scope']);
});

test('changing one taxonomy boundary changes packet and configuration identity', async () => {
  const f = fixture();
  const changed = structuredClone(f.input);
  changed.taxonomy.concepts[0].boundary = 'Only registered widget capabilities count.';
  changed.taxonomy.ontology_version_digest = hash(stableStringify(changed.taxonomy.concepts).trim());
  const packetB = buildClassificationPacket(changed, { repository: f.dir });
  const resultA = await classifyOntologyPacket({ packet: f.packet, runtime: runtime(), llm });
  const resultB = await classifyOntologyPacket({ packet: packetB, runtime: runtime(), llm });
  assert.notDeepEqual([f.packet.packet_id, resultA.configuration_id], [packetB.packet_id, resultB.configuration_id]);
});

test('changing selected fallback model invalidates the classification configuration identity', async () => {
  const { packet } = fixture();const alternate = runtime();
  alternate.models.code_claims = { ...model, name: 'example-provider/alternate-model' };
  const a = await classifyOntologyPacket({ packet, runtime: runtime(), llm });
  const b = await classifyOntologyPacket({ packet, runtime: alternate, llm: async () => ({ ...await llm(), model: alternate.models.code_claims.name }) });
  assert.notEqual(a.configuration_id, b.configuration_id);
});

test('gap analysis is proposed, never an accepted ontology revision', async () => {
  const { packet } = fixture();
  const result = { status: 'no_existing_type', packet_id: packet.packet_id, receipt_id: 'receipt:widget', backend: 'llm', model: model.name };
  const candidate = gapCandidate(packet, result);
  const analysis = await analyzeGap({ candidate, packet, runtime: runtime(), llm: async () => ({
    answers: { analysis: 'novel_concept' }, model: model.name,
  }) });
  assert.deepEqual({ status: analysis.status, finding: analysis.finding, accepted: analysis.accepted },
    { status: 'proposed', finding: 'novel_concept', accepted: false });
});

test('a pending evaluation manifest carries no inherited rating for arbitrary configured models', async () => {
  const { packet } = fixture();
  const result = await classifyOntologyPacket({ packet, runtime: runtime(), llm });
  const manifest = classificationEvaluationManifest({ packet, runtime: runtime(), result, split: 'held_out' });
  assert.deepEqual({ recommended: manifest.recommended, metrics: manifest.metrics, thresholds: manifest.thresholds,
    actual: manifest.actual_models[0].requested, scope: manifest.scope },
  { recommended: false, metrics: null, thresholds: null, actual: model.name, scope: 'own_code' });
});

test('legacy runtime config remains valid and does not acquire new normalized bytes', () => {
  const input = { schema: 'estate-map/runtime-config/v1', models: {
    documentary_claims: { runner: 'pi', name: model.name, thinking: 'off', concurrency: 1, window_bytes: 1000,
      timeout_ms: 10000, max_event_bytes: 5000, max_answer_bytes: 1000 },
    code_claims: { runner: 'pi', name: model.name, thinking: 'off', concurrency: 1, window_bytes: 1000,
      timeout_ms: 10000, max_event_bytes: 5000, max_answer_bytes: 1000 } },
  neo4j: { uri_env: 'ASCRYBE_NEO4J_URI', username_env: 'ASCRYBE_NEO4J_USERNAME', password_env: 'ASCRYBE_NEO4J_PASSWORD' },
  projection: { batch_size: 1, default_view: 'working' }, dashboard: { host: '127.0.0.1', port: 8899,
    neighbor_limit: 1, overview_limit: 1 } };
  assert.equal(Object.hasOwn(validateEstateMapRuntimeConfig(input), 'ontology_classification'), false);
});
