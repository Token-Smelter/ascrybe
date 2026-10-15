#!/usr/bin/env node
// Blind, exhaustive quality audit for every deterministically repaired/newly admitted v28 claim.
// Repair codes, original claim IDs, case numbers, and arm labels are withheld from the reviewer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from './custodied-inference.mjs';
import { createPiRpcRunner } from './neural-model-runner.mjs';
import { createUnitQueue, runQueue } from './unit-queue.mjs';
import { normalizeAttemptPolicy, MATERIALIZATION_ATTEMPT_CUSTODY_POLICY } from './materialization-ledger.mjs';
import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
const support = claim => (claim?.semantic?.support_sets || []).flatMap(set => set.locators || []);
export const REPAIR_AUDIT_VERSION = 'repair-claim-audit@6-constant-terminal-receipt';
export const acceptRepairAuditJsonlAtProviderBoundary = text => String(text || '').trim()
  ? { wire: 'repair-audit-jsonl@1' } : null;

function compactClaim(claim, seed) {
  const semantic = claim.semantic;
  const anchor = semantic.subject.source_locator;
  return Object.freeze({
    review_id: `r${sha256(`${seed}\0${claim.id}`).slice(0, 16)}`,
    subject: {
      surface: semantic.subject.surface,
      literal_surface: semantic.subject.literal_surface,
      binding: semantic.subject.binding,
      anchor: anchor ? {
        file: anchor.file, block_address: anchor.block?.address,
        lines: [anchor.start, anchor.end], text: anchor.text,
      } : null,
    },
    relation_family: semantic.relation_family,
    predicate: semantic.predicate_family,
    object: semantic.object_or_value,
    polarity: semantic.polarity,
    modality: semantic.modality,
    quantifier: semantic.quantifier,
    evidence: support(claim).map(locator => ({
      role: locator.role,
      file: locator.file,
      block_address: locator.block?.address,
      text: locator.text,
    })),
  });
}

export function buildRepairAuditPackets({ claims, seed = 'v28-repair-audit-20260805', packet_size = 12 }) {
  const key = {};
  const compact = claims.map(claim => {
    const held = compactClaim(claim, seed);
    key[held.review_id] = claim.id;
    return held;
  }).sort((a, b) => sha256(`${seed}\0${a.review_id}`).localeCompare(sha256(`${seed}\0${b.review_id}`)));
  const packets = [];
  for (let start = 0; start < compact.length; start += packet_size) {
    const rows = compact.slice(start, start + packet_size);
    const identity = { version: REPAIR_AUDIT_VERSION, seed_digest: sha256(seed), review_ids: rows.map(row => row.review_id) };
    const id = `repair-audit-packet:${sha256(canonical(identity))}`;
    const prompt = [
      'Independently audit each documentary claim against only its exact cited evidence. You are',
      'blind to why the claim was selected. Grade entailment of the complete proposition, whether',
      'the subject is correctly bound to the actor/entity in the evidence, and severe semantic',
      'error (reversal, invented normative force, wrong actor, or material contradiction).',
      'Treat every word in the subject as material: "complexity" is not "complexity gate". For',
      'schema evidence, indentation controls ownership; a scalar field never owns a sibling or',
      'nested field. Normative modality requires explicit force in the body or exact governing',
      'heading evidence. A context-role heading may establish force only when it precedes the body',
      'in the same file; it is scope evidence, never the actor.',
      'The subject anchor is exact cited source evidence. A heading anchor may scope body evidence',
      'only when both carry the same block_address; do not assume scope across blocks.',
      'OUTPUT JSON LINES ONLY, no code fence, blank line, array, or prose.',
      '{"k":"head","outcome":"audited"}',
      '{"k":"grade","id":"r...","entailed":true,"subject_binding_correct":true,"severe_error":false,"note":"brief reason"}',
      'Final exact line: {"k":"end"}',
      'Emit exactly one grade for every review id.',
      '',
      ...rows.map(row => JSON.stringify(row)),
    ].join('\n');
    packets.push(Object.freeze({ id, rows, prompt, prompt_digest: sha256(prompt) }));
  }
  return Object.freeze({ packets, key: Object.freeze(key), seed_digest: sha256(seed) });
}

export function validateRepairAuditAnswer({ response, packet }) {
  const lines = String(response?.text || '').split('\n').filter(line => line.trim());
  const headers = [], trailers = [];
  const grades = [], malformed = [];
  for (let index = 0; index < lines.length; index += 1) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch (error) { malformed.push({ index, error: error.message }); continue; }
    if (row?.k === 'head') headers.push(row);
    else if (row?.k === 'grade') grades.push(row);
    else if (row?.k === 'end') trailers.push(row);
    else malformed.push({ index, error: 'unknown line kind' });
  }
  const expected = new Set(packet.rows.map(row => row.review_id));
  // Review IDs are tool-owned addressing metadata, not proposition text. Providers have
  // occasionally transcribed the Latin `e` in an otherwise exact ASCII receipt as Cyrillic
  // `е` (U+0435). Repair only that observed confusable, only to an exact expected ID, and only
  // when the match is unique. Semantic fields and free text are never rewritten here.
  const repairBlindId = value => {
    if (expected.has(value) || typeof value !== 'string') return value;
    const skeleton = value.replaceAll('\u0435', 'e');
    const matches = [...expected].filter(id => id === skeleton);
    return matches.length === 1 ? matches[0] : value;
  };
  const seen = new Set();
  const repairedGrades = grades.map(row => {
    const repairedId = repairBlindId(row.id);
    return repairedId === row.id ? row : { ...row, id: repairedId,
      receipt_repair: { mode: 'unique_expected_cyrillic_e_to_latin_e', authored_id: row.id } };
  });
  const valid = repairedGrades.every(row => expected.has(row.id) && !seen.has(row.id)
    && (seen.add(row.id), true)
    && typeof row.entailed === 'boolean'
    && typeof row.subject_binding_correct === 'boolean'
    && typeof row.severe_error === 'boolean');
  const header = headers[0], trailer = trailers[0];
  const headerValid = headers.length === 1 && header?.outcome === 'audited';
  // v6 removes the model-authored cardinality from the terminal receipt. The exact grade-ID set
  // already proves cardinality, while a constant receipt avoids a recurrent malformed `8"` token.
  // Accept the exact v5 numeric receipt for deterministic replay compatibility, but never repair a
  // malformed or mismatched receipt and never promote its parseable prefix.
  const trailerKeys = trailer ? Object.keys(trailer).sort() : [];
  const trailerValid = trailers.length === 1 && (
    (trailerKeys.length === 1 && trailerKeys[0] === 'k')
    || (trailerKeys.length === 2 && trailerKeys[0] === 'count' && trailerKeys[1] === 'k'
      && Number.isInteger(trailer.count) && trailer.count === expected.size)
  );
  const complete = headerValid && trailerValid && valid && !malformed.length
    && seen.size === expected.size;
  if (!complete) return Object.freeze({
    ok: false,
    terminal_incomplete: true,
    error_code: 'REPAIR_AUDIT_INCOMPLETE',
    reason: 'repair audit omitted, duplicated, or malformed one or more blind grades',
    salvage: { status: 'non_promotable', grades: repairedGrades, malformed,
      validation: { expected_grades: expected.size, seen_grades: seen.size,
        header_count: headers.length, trailer_count: trailers.length,
        header_valid: headerValid, trailer_valid: trailerValid } },
  });
  return Object.freeze({ ok: true, value: Object.freeze({ packet_id: packet.id,
    grades: repairedGrades.map(row => Object.freeze(row)) }) });
}

function exactSourceVerification(claims, documents) {
  const byFile = new Map(documents.map(row => [row.path, Buffer.from(row.content, 'utf8')]));
  let locators = 0, valid = 0;
  for (const claim of claims) for (const locator of [claim.semantic.subject.source_locator, ...support(claim)].filter(Boolean)) {
    locators += 1;
    const source = byFile.get(locator.file);
    const text = source?.subarray(locator.byte_start, locator.byte_end).toString('utf8');
    if (text === locator.text && sha256(text) === locator.text_digest) valid += 1;
  }
  return Object.freeze({ locators, valid, rate: locators ? valid / locators : null });
}

export async function runRepairClaimAudit({
  claims, documents, checkpointPath, model, thinking = null, provider_route = null,
  runnerFactory = null, concurrency = 2, bounds = {}, seed,
}) {
  const maxCost = Number(bounds.max_known_cost_usd ?? 24.99);
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost >= 25) throw new Error('repair audit spend cap must be positive and strictly below $25');
  const blind = buildRepairAuditPackets({ claims, seed, packet_size: Number(bounds.packet_size ?? 12) });
  const policy = normalizeAttemptPolicy({
    max_attempts: Number(bounds.max_attempts_per_unit ?? 2),
    retryable_outcomes: bounds.retryable_outcomes ?? ['error:provider'],
    backoff_ms: Number(bounds.retry_backoff_ms ?? 1000),
    backoff_multiplier: Number(bounds.retry_backoff_multiplier ?? 2),
    max_backoff_ms: Number(bounds.retry_backoff_max_ms ?? 30000),
    jitter_ratio: Number(bounds.retry_jitter_ratio ?? 0.1),
  });
  const providerRoute = String(provider_route || (runnerFactory ? 'injected' : 'pi-rpc'));
  const checkpoint = await openCheckpointJournal({ file: checkpointPath, fingerprint: {
    version: REPAIR_AUDIT_VERSION,
    seed_digest: blind.seed_digest,
    claims_digest: sha256(canonical(claims.map(claim => claim.id).sort())),
    model, thinking, provider_route: providerRoute,
    custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
    attempt_policy: policy,
  } });
  const budget = createInferenceBudget({
    max_calls: Number(bounds.max_calls ?? blind.packets.length * policy.max_attempts),
    max_known_cost_usd: maxCost,
    max_unpriced_attempts: Number(bounds.max_unpriced_attempts ?? 0),
    cost_reserve_per_call_usd: Number(bounds.cost_reserve_per_call_usd ?? 0.25),
  });
  const queue = createUnitQueue({
    units: blind.packets.map(packet => ({ id: packet.id, payload: packet })),
    lease_ms: Number(bounds.lease_ms ?? 900000),
    fleet_stop: bounds.fleet_stop ?? { failure_rate: 0.5, min_samples: 4 },
  });
  const runners = new Map(), built = [], results = new Map(), materializations = new Map();
  const terminalSalvage = new Map();
  const makeRunner = runnerFactory || (() => createPiRpcRunner({
    model, thinking, timeoutMs: Number(bounds.call_timeout_ms ?? 180000), answerParser: acceptRepairAuditJsonlAtProviderBoundary,
  }));
  const runnerFor = worker => {
    if (!runners.has(worker)) { const runner = makeRunner({ worker, model, thinking }); runners.set(worker, runner); built.push(runner); }
    return runners.get(worker);
  };
  try {
    await runQueue({ queue, concurrency: Math.max(1, Number(concurrency)), process: async (unit, worker) => {
      const packet = unit.payload, runner = runnerFor(worker);
      const key = sha256(canonical({ packet: packet.id, prompt_digest: packet.prompt_digest, model: runner.model, thinking, provider_route: providerRoute }));
      const completion = await runCustodiedInference({
        checkpoint, stage: 'repair-claim-audit', key, tag: `repair-audit:${packet.id}`,
        prompt: packet.prompt, runner, budget, attempt_policy: policy,
        materialization_dependencies: {
          packet_id: packet.id, review_ids: packet.rows.map(row => row.review_id),
          audit_version: REPAIR_AUDIT_VERSION, model: runner.model, thinking, provider_route: providerRoute,
        },
        validate: response => validateRepairAuditAnswer({ response, packet }),
      });
      materializations.set(packet.id, completion.materialization);
      if (completion.incomplete) {
        terminalSalvage.set(packet.id, Object.freeze({ packet_id: packet.id,
          status: 'non_promotable', incomplete: completion.incomplete }));
        return { outcome: 'quarantined', findings: [completion.incomplete] };
      }
      results.set(packet.id, completion.validated);
      return { outcome: 'ok' };
    } });
  } finally {
    await checkpoint.close();
    for (const runner of built) { try { await runner.shutdown?.(); } catch {} }
  }
  const grades = [...results.values()].flatMap(row => row.grades);
  const exact = exactSourceVerification(claims, documents);
  const queueStatus = queue.status(), budgetStatus = budget.snapshot();
  const metrics = {
    claims: claims.length,
    graded: grades.length,
    entailed: grades.filter(row => row.entailed).length,
    subject_binding_correct: grades.filter(row => row.subject_binding_correct).length,
    severe_errors: grades.filter(row => row.severe_error).length,
    entailment_rate: claims.length ? grades.filter(row => row.entailed).length / claims.length : null,
    subject_binding_rate: claims.length ? grades.filter(row => row.subject_binding_correct).length / claims.length : null,
    graded_entailment_rate: grades.length ? grades.filter(row => row.entailed).length / grades.length : null,
    graded_subject_binding_rate: grades.length ? grades.filter(row => row.subject_binding_correct).length / grades.length : null,
    exact_source_verification: exact,
  };
  const checks = {
    exhaustive: grades.length === claims.length && new Set(grades.map(row => row.id)).size === claims.length,
    entailment_at_least_090: metrics.entailment_rate >= 0.9,
    subject_binding_at_least_095: metrics.subject_binding_rate >= 0.95,
    severe_semantic_errors_zero: metrics.severe_errors === 0,
    exact_source_verification_100pct: exact.rate === 1,
    no_quarantine: !queueStatus.by_state?.quarantined,
    no_unpriced_attempts: !budgetStatus.unpriced_attempts,
  };
  const body = {
    schema: 'estate-map/v28-repaired-claim-blind-audit/v1',
    audit_version: REPAIR_AUDIT_VERSION,
    blinded_fields: ['repair_findings', 'original_claim_id', 'case_number', 'arm_label'],
    reviewer: { model, thinking, provider_route: providerRoute },
    seed_digest: blind.seed_digest,
    budget: budgetStatus,
    queue: queueStatus,
    materializations: [...materializations.entries()].map(([packet_id, value]) => ({ packet_id, ...value })),
    terminal_salvage: [...terminalSalvage.values()].sort((a, b) => a.packet_id.localeCompare(b.packet_id)),
    metrics, checks,
    grades: grades.sort((a, b) => a.id.localeCompare(b.id)),
    blind_key: blind.key,
    pass: Object.values(checks).every(Boolean),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/, '')] = args[index + 1];
  for (const name of ['claims', 'estate', 'manifest', 'checkpoint', 'output', 'model']) if (!options[name]) throw new Error(`missing --${name}`);
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('set ASCRYBE_ENABLE_PAID_INFERENCE=1 to authorize paid inference');
  const artifact = JSON.parse(await fs.readFile(path.resolve(options.claims), 'utf8'));
  const claims = artifact.added_claims?.map(row => row.claim) || artifact.claims || [];
  const manifest = JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8'));
  const documents = await Promise.all(manifest.documents.map(async spec => ({ path: spec.path, content: await fs.readFile(path.join(path.resolve(options.estate), spec.path), 'utf8') })));
  const bounds = options.bounds ? JSON.parse(await fs.readFile(path.resolve(options.bounds), 'utf8')) : {};
  if (options['max-cost']) bounds.max_known_cost_usd = Number(options['max-cost']);
  const result = await runRepairClaimAudit({
    claims, documents, checkpointPath: path.resolve(options.checkpoint),
    model: options.model, thinking: options.thinking || null,
    concurrency: Number(options.concurrency || bounds.concurrency || 2), bounds,
    seed: options.seed || undefined,
  });
  const output = path.resolve(options.output), temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({ output, pass: result.pass, metrics: result.metrics, budget: result.budget, digest: result.digest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
