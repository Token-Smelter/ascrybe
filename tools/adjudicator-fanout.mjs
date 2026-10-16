#!/usr/bin/env node
// Decision-grade adjudicator comparison over one frozen, lossless extraction artifact.
// Prompts are constructed once from complete claims and delivered byte-identically to every model.
// Agreement is diagnostic only; disagreements and conflict flags become a human-review queue.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusFromClaims, DISAGREEMENT_RELATIONS } from './documentation-claim-census.mjs';
import { assertInferencePromptWithinLimit, INFERENCE_CUSTODY_POLICY, interruptedInferenceCustody, openInferenceCircuit } from './inference-custody.mjs';
import { buildAdjudicationPrompt, sideFromClaim, validateAdjudicationAnswer, RESOLUTION_ADJUDICATOR_VERSION } from './neural-resolution.mjs';
import { createPiRpcRunner } from './neural-model-runner.mjs';
import { mapWithRunnerPool } from './neural-runner-pool.mjs';
import { parseCensusModelJson } from './neural-json.mjs';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { combineModelStats, modelStatsDelta, modelStatsSnapshot } from './model-usage.mjs';
import { readExtractionArtifact, validateExtractionArtifact } from './extraction-artifact.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const FANOUT_SCHEMA = 'estate-map/adjudicator-fanout/v1';
export const DEFAULT_SAMPLE_SIZE = 300;

const stableCaseOrder = (left, right) => sha256(left.case_id).localeCompare(sha256(right.case_id));
const sanitize = value => String(value).replaceAll('/', '__').replace(/[^a-zA-Z0-9_.-]/g, '_');

/** Deterministic stratification: seed every non-empty relation, then round-robin remaining capacity. */
export function selectStratifiedAssemblies(assemblies, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const cap = Math.max(0, Number.parseInt(sampleSize, 10) || 0);
  const groups = new Map(DISAGREEMENT_RELATIONS.map(relation => [relation, []]));
  for (const assembly of assemblies || []) {
    if (groups.has(assembly.relation)) groups.get(assembly.relation).push(assembly);
  }
  const active = DISAGREEMENT_RELATIONS.filter(relation => groups.get(relation).length);
  for (const relation of active) groups.get(relation).sort(stableCaseOrder);
  const cursors = new Map(active.map(relation => [relation, 0]));
  const selected = [];
  while (selected.length < cap) {
    let progressed = false;
    for (const relation of active) {
      const index = cursors.get(relation);
      const group = groups.get(relation);
      if (index >= group.length) continue;
      selected.push(group[index]);
      cursors.set(relation, index + 1);
      progressed = true;
      if (selected.length >= cap) break;
    }
    if (!progressed) break;
  }
  return selected.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export function buildFanoutSample(artifactInput, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const artifact = validateExtractionArtifact(artifactInput);
  const claims = artifact.extraction.claims;
  const claimsById = new Map(claims.map(claim => [claim.id, claim]));
  const { disagreement } = censusFromClaims(claims, { snapshot: artifact.snapshot });
  const casesById = new Map(disagreement.store.list().map(record => [record.id, record]));
  const selected = selectStratifiedAssemblies(disagreement.assemblies, sampleSize);
  const sample = selected.map(assembly => {
    const record = casesById.get(assembly.case_id);
    const sides = (record?.semantic?.claims || []).map(id => claimsById.get(id)).filter(Boolean).map(sideFromClaim);
    if (sides.length < 2 || sides.some(side => !side.excerpts.length)) throw new Error(`fanout case ${assembly.case_id} lacks complete cited sides`);
    const prompt = buildAdjudicationPrompt({ relation: assembly.relation, sides });
    assertInferencePromptWithinLimit(prompt);
    return { case_id: assembly.case_id, relation: assembly.relation, sides, prompt, prompt_digest: sha256(prompt) };
  });
  return { artifact, sample, disagreement };
}

export function parseModelSpecs(value) {
  return String(value || '').split(',').filter(Boolean).map(spec => {
    const at = spec.lastIndexOf('=');
    return at > spec.indexOf('/') ? { model: spec.slice(0, at), thinking: spec.slice(at + 1) || null } : { model: spec, thinking: null };
  });
}

function quoteFidelity(answer, sides) {
  const source = sides.flatMap(side => side.excerpts || []).map(excerpt => String(excerpt.text || '')).join('\n');
  const top = Array.isArray(answer?.quoted_spans) ? answer.quoted_spans : [];
  const grounding = (answer?.side_grounding || []).flatMap(item => item.quoted_spans || []);
  const quotes = [...top, ...grounding].filter(Boolean).map(String);
  return {
    quoted_count: quotes.length,
    exact_count: quotes.filter(quote => source.includes(quote)).length,
    all_exact: quotes.length > 0 && quotes.every(quote => source.includes(quote)),
  };
}

function groundingSignature(answer) {
  return stableStringify((answer?.side_grounding || []).map(item => ({ claim_id: item.claim_id, state: item.state })).sort((a, b) => a.claim_id.localeCompare(b.claim_id)));
}

function pairwiseComparisons(results) {
  const comparisons = [];
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const left = results[i], right = results[j];
      const rightByCase = new Map(right.results.map(entry => [entry.case_id, entry]));
      const rows = left.results.map(entry => [entry, rightByCase.get(entry.case_id)]).filter(([, other]) => other);
      const valid = rows.filter(([a, b]) => a.valid && b.valid);
      const disagreements = valid.filter(([a, b]) =>
        a.answer.resolution !== b.answer.resolution
        || a.answer.pair_conflict !== b.answer.pair_conflict
        || groundingSignature(a.answer) !== groundingSignature(b.answer)
        || stableStringify(a.answer.context_relation) !== stableStringify(b.answer.context_relation));
      comparisons.push({
        left: left.model_key,
        right: right.model_key,
        cases: rows.length,
        both_valid: valid.length,
        resolution_agreement: valid.filter(([a, b]) => a.answer.resolution === b.answer.resolution).length,
        pair_conflict_agreement: valid.filter(([a, b]) => a.answer.pair_conflict === b.answer.pair_conflict).length,
        side_grounding_agreement: valid.filter(([a, b]) => groundingSignature(a.answer) === groundingSignature(b.answer)).length,
        context_relation_agreement: valid.filter(([a, b]) => stableStringify(a.answer.context_relation) === stableStringify(b.answer.context_relation)).length,
        disagreement_case_ids: disagreements.map(([entry]) => entry.case_id),
      });
    }
  }
  return comparisons;
}

async function runModel({ config, artifact, sample, concurrency, checkpointDir, runnerFactory }) {
  const modelKey = `${config.model}${config.thinking ? `=${config.thinking}` : ''}`;
  const sampleDigest = sha256(stableStringify(sample.map(item => ({ case_id: item.case_id, prompt_digest: item.prompt_digest }))));
  const checkpoint = await openCheckpointJournal({
    file: path.join(checkpointDir, `${sanitize(modelKey)}.jsonl`),
    fingerprint: {
      pipeline: 'estate-map/adjudicator-fanout/v1', artifact_digest: artifact.artifact_digest,
      sample_digest: sampleDigest, model: config.model, thinking: config.thinking,
      adjudicator_version: RESOLUTION_ADJUDICATOR_VERSION,
      inference_custody_policy: INFERENCE_CUSTODY_POLICY,
    },
  });
  const runners = Array.from({ length: concurrency }, (_, index) => runnerFactory({ ...config, index }));
  let completedCount = 0;
  try {
    const assertComplete = (item, value) => {
      if (value.result.outcome !== 'ok') openInferenceCircuit(`fanout stopped after incomplete paid unit ${item.case_id}`, { stage: 'fanout', model: config.model, case_id: item.case_id, result: value.result, model_stats: value.model_stats });
      const parsed = value.result.json ?? parseCensusModelJson(value.result.text || '');
      const validation = validateAdjudicationAnswer(parsed, item.sides);
      if (!validation.ok) openInferenceCircuit(`fanout stopped after invalid paid answer ${item.case_id}`, { stage: 'fanout', model: config.model, case_id: item.case_id, reason: validation.reason, result: value.result, model_stats: value.model_stats });
    };
    const processCase = async (item, runner) => {
      const key = sha256(stableStringify({ inference_custody_policy: INFERENCE_CUSTODY_POLICY, case_id: item.case_id, prompt_digest: item.prompt_digest, model: config.model, thinking: config.thinking }));
      const cached = checkpoint.get('adjudication', key);
      if (cached) { assertComplete(item, cached); completedCount += 1; return cached; }
      const tag = `fanout:${item.case_id}`;
      const started = checkpoint.get('adjudication-started', key);
      if (started) {
        const { result, model_stats } = interruptedInferenceCustody({ model: config.model, tag, kind: runner.kind || 'unknown' });
        const value = { result, model_stats };
        await checkpoint.put('adjudication', key, value);
        assertComplete(item, value);
        completedCount += 1;
        return value;
      }
      await checkpoint.put('adjudication-started', key, { tag, model: config.model, prompt_digest: item.prompt_digest, inference_custody_policy: INFERENCE_CUSTODY_POLICY });
      const before = modelStatsSnapshot(runner);
      const result = await runner.complete({ prompt: item.prompt, tag });
      const model_stats = modelStatsDelta(before, modelStatsSnapshot(runner), config.model);
      const value = { result, model_stats };
      await checkpoint.put('adjudication', key, value);
      assertComplete(item, value);
      completedCount += 1;
      if (completedCount % 10 === 0 || completedCount === sample.length) console.error(`[${modelKey}] ${completedCount}/${sample.length}`);
      return value;
    };
    const { results: completed } = await mapWithRunnerPool(sample, runners, processCase);
    const entries = completed.map((value, index) => {
      const item = sample[index];
      const parsed = value.result.json ?? parseCensusModelJson(value.result.text || '');
      const validation = value.result.outcome === 'ok'
        ? validateAdjudicationAnswer(parsed, item.sides)
        : { ok: false, reason: `model outcome ${value.result.outcome}` };
      return {
        case_id: item.case_id,
        relation: item.relation,
        prompt_digest: item.prompt_digest,
        valid: validation.ok,
        validation_reason: validation.ok ? null : validation.reason,
        answer: validation.ok ? validation.value : null,
        raw_text: validation.ok ? null : value.result.text || '',
        outcome: value.result.outcome,
        accepted: value.result.accepted ?? null,
        billing_status: value.result.billing_status ?? null,
        quote_fidelity: validation.ok ? quoteFidelity(validation.value, item.sides) : { quoted_count: 0, exact_count: 0, all_exact: false },
        documents: item.sides.map(side => side.document_id),
      };
    });
    const stats = combineModelStats(completed.map(value => value.model_stats), config.model);
    return {
      model: config.model,
      thinking: config.thinking,
      model_key: modelKey,
      cases: entries.length,
      valid: entries.filter(entry => entry.valid).length,
      exact_quote_fidelity: entries.filter(entry => entry.valid && entry.quote_fidelity.all_exact).length,
      pair_conflict_counts: Object.fromEntries(['conflict', 'no_conflict', 'underdetermined'].map(state => [state, entries.filter(entry => entry.answer?.pair_conflict === state).length])),
      calls: stats.calls,
      cost_usd: stats.cost,
      cost_status: stats.cost_status,
      unpriced_attempts: stats.unpriced_attempts,
      input_tokens: stats.per_call.reduce((sum, call) => sum + Number(call.input_tokens || 0), 0),
      output_tokens: stats.per_call.reduce((sum, call) => sum + Number(call.output_tokens || 0), 0),
      checkpoint: checkpoint.stats(),
      results: entries,
    };
  } finally {
    await checkpoint.close();
    for (const runner of runners) { try { await runner.shutdown?.(); } catch { /* best effort */ } }
  }
}

export async function runAdjudicatorFanout({ artifact: artifactInput, modelConfigs, sampleSize = DEFAULT_SAMPLE_SIZE, concurrency = 8, checkpointDir, runnerFactory = null }) {
  if (!runnerFactory && process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('paid inference gate is closed; complete free architecture gates, then set ASCRYBE_ENABLE_PAID_INFERENCE=1 explicitly');
  const effectiveRunnerFactory = runnerFactory || (({ model, thinking }) => createPiRpcRunner({ model, thinking }));
  const artifact = validateExtractionArtifact(artifactInput);
  if (!Array.isArray(modelConfigs) || modelConfigs.length < 2) throw new Error('fanout requires at least two model configs');
  const { sample } = buildFanoutSample(artifact, sampleSize);
  const results = [];
  for (const config of modelConfigs) results.push(await runModel({ config, artifact, sample, concurrency: Math.max(1, Number(concurrency)), checkpointDir, runnerFactory: effectiveRunnerFactory }));
  const comparisons = pairwiseComparisons(results);
  const reviewIds = new Set();
  for (const result of results) {
    for (const entry of result.results) if (!entry.valid || entry.answer?.pair_conflict === 'conflict') reviewIds.add(entry.case_id);
  }
  for (const comparison of comparisons) for (const id of comparison.disagreement_case_ids) reviewIds.add(id);
  const sampleById = new Map(sample.map(item => [item.case_id, item]));
  const modelEntries = new Map(results.map(result => [result.model_key, new Map(result.results.map(entry => [entry.case_id, entry]))]));
  const humanReviewPackets = [...reviewIds].sort().map(caseId => {
    const item = sampleById.get(caseId);
    return {
      case_id: caseId,
      relation: item?.relation ?? null,
      prompt_digest: item?.prompt_digest ?? null,
      sides: item?.sides ?? [],
      model_answers: Object.fromEntries(results.map(result => [result.model_key, modelEntries.get(result.model_key).get(caseId) ?? null])),
    };
  });
  return {
    schema: FANOUT_SCHEMA,
    extraction: { artifact_digest: artifact.artifact_digest, claims_digest: artifact.claims_digest, snapshot: artifact.snapshot, claims: artifact.extraction.claims.length },
    sample: {
      count: sample.length,
      by_relation: Object.fromEntries(DISAGREEMENT_RELATIONS.map(relation => [relation, sample.filter(item => item.relation === relation).length])),
      case_ids: sample.map(item => item.case_id),
      prompt_digests: sample.map(item => ({ case_id: item.case_id, prompt_digest: item.prompt_digest })),
    },
    prompt_identity: { byte_identical_across_models: true, construction: 'one prompt per case built before model fanout' },
    models: results,
    pairwise: comparisons,
    human_review_queue: [...reviewIds].sort(),
    human_review_packets: humanReviewPackets,
    epistemic_note: 'Model agreement is diagnostic, never ground truth. Human review decides disagreements from the cited source excerpts.',
  };
}

async function main() {
  const args = process.argv.slice(2), positional = [], options = {};
  for (let i = 0; i < args.length; i += 1) args[i].startsWith('--') ? options[args[i].slice(2)] = args[++i] : positional.push(args[i]);
  const [claimsFile, outputFile] = positional;
  const modelConfigs = parseModelSpecs(options.models);
  if (!claimsFile || !outputFile || modelConfigs.length < 2) {
    throw new Error('usage: adjudicator-fanout.mjs <claims.json> <output.json> --models model1[=thinking],model2[=thinking] [--sample-size 300] [--concurrency 8] [--checkpoint-dir path]');
  }
  const { artifact } = await readExtractionArtifact(claimsFile);
  const report = await runAdjudicatorFanout({
    artifact,
    modelConfigs,
    sampleSize: Number.parseInt(options['sample-size'] || String(DEFAULT_SAMPLE_SIZE), 10),
    concurrency: Number.parseInt(options.concurrency || '8', 10),
    checkpointDir: path.resolve(options['checkpoint-dir'] || './checkpoints/adjudicator-fanout'),
  });
  const output = path.resolve(outputFile), temporary = `${output}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({ output, sample: report.sample.count, models: report.models.map(model => ({ model: model.model_key, valid: model.valid, cost_usd: model.cost_usd })), human_review_queue: report.human_review_queue.length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
