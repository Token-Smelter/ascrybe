#!/usr/bin/env node
// Paid blind review for the exposed v28 paired screen.
//
// This process reads only the blind packet. It never loads the arm key, original claim ids, repair
// findings, or case-analysis labels. Opportunity units are kept separate so a reviewer can inspect
// every document-scope candidate without cross-opportunity competition.
import fs from 'node:fs/promises';
import path from 'node:path';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from './custodied-inference.mjs';
import { createPiRpcRunner } from './neural-model-runner.mjs';
import { createUnitQueue, runQueue } from './unit-queue.mjs';
import { normalizeAttemptPolicy, MATERIALIZATION_ATTEMPT_CUSTODY_POLICY } from './materialization-ledger.mjs';
import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
export const BLIND_SCREEN_REVIEW_VERSION = 'v28-blind-screen-review@9-constant-terminal-receipt';
export const acceptBlindReviewJsonlAtProviderBoundary = text => String(text || '').trim()
  ? { wire: 'v28-blind-screen-review-jsonl@9' } : null;

const compactRecallClaim = (claim, inSealedBlockFrame, claimRef) => {
  const compact = {
    claim_ref: claimRef,
    subject: claim.subject?.surface,
    predicate: claim.predicate_family,
    object: claim.object_or_value,
    polarity: claim.polarity,
    modality: claim.modality,
    quantifier: claim.quantifier,
    in_sealed_block_frame: inSealedBlockFrame,
  };
  if (claim.scope && Object.keys(claim.scope).length) compact.scope = claim.scope;
  if (claim.valid_time && Object.keys(claim.valid_time).length) compact.valid_time = claim.valid_time;
  return compact;
};

const compactOpportunityArm = (held, blind) => {
  const documentClaims = held.frames.document_scope.candidate_claims;
  const sealedIds = new Set(held.frames.sealed_block.candidate_claims.map(row => row.review_claim_id));
  const rows = documentClaims.map((claim, index) => ({ claim, ref: `${blind}${String(index + 1).padStart(4, '0')}` }));
  return {
    // Recall grading concerns what each already-validated claim expresses. Evidence/provenance is
    // audited in the separate precision frame and is intentionally not repeated here; every claim
    // remains present and addressable by its blind id.
    document_scope_claims: rows.map(({ claim, ref }) => compactRecallClaim(claim, sealedIds.has(claim.review_claim_id), ref)),
    claim_id_by_ref: Object.fromEntries(rows.map(({ claim, ref }) => [ref, claim.review_claim_id])),
  };
};

export function buildBlindScreenReviewPackets({ packet, precision_packet_size = 20 }) {
  if (packet?.blinded !== true || packet?.status !== 'awaiting_review') throw new Error('a pending blind review packet is required');
  const units = [];
  for (const frame of packet.opportunity_frame || []) {
    const claimIdByRef = {};
    const payload = {
      opportunity: frame.opportunity,
      arms: Object.fromEntries(Object.entries(frame.arms).map(([blind, held]) => {
        const compact = compactOpportunityArm(held, blind);
        Object.assign(claimIdByRef, compact.claim_id_by_ref);
        return [blind, { document_scope_claims: compact.document_scope_claims }];
      })),
    };
    const id = `blind-opportunity-review:${sha256(canonical(payload))}`;
    const prompt = [
      'Blindly grade recovery of one frozen documentary proposition for two anonymous extraction arms.',
      'Use only the proposition, exact source quote, and candidate claims below. For each arm grade',
      'both frames. Recovered means the candidate claims collectively express the COMPLETE proposition,',
      'including every condition, cause, prohibition, qualification, consequence, and coordinated clause.',
      'Partial means a material part is represented but at least one material conjunct is absent. Missed',
      'means no material part is represented. Evidence contact alone is never semantic coverage.',
      'The sealed_block frame contains only claims marked in_sealed_block_frame=true. The document_scope',
      'frame contains every displayed claim. Do not infer a proposition from source evidence alone: grade',
      'what the claims express. OUTPUT JSON LINES ONLY, with exactly four grade lines.',
      'All claims are present in compact semantic form; exact grounding is independently audited in',
      'the precision frame. Do not infer omitted semantics from a claim id.',
      'Claim refs are short, tool-owned, and ARM-LOCAL. For an A grade, copy claim_refs only from',
      'A.document_scope_claims; for B, copy only from B.document_scope_claims. Never retype, shorten,',
      'invent, or reuse a ref from the other arm. For sealed_block, the same-arm claim must also',
      'have in_sealed_block_frame=true.',
      '{"k":"head","outcome":"graded"}',
      '{"k":"grade","arm":"A","frame":"sealed_block|document_scope","grade":"recovered|partial|missed","claim_refs":["A0001"],"note":"brief reason"}',
      '{"k":"end","count":4}',
      'The final end line is mandatory even when all four grades were emitted; omitting it makes the',
      'entire review unit terminal-incomplete. The head line is optional decorative framing.',
      '',
      JSON.stringify(payload),
    ].join('\n');
    units.push(Object.freeze({ id, kind: 'opportunity', prompt, prompt_digest: sha256(prompt), payload,
      claimIdByRef: Object.freeze(claimIdByRef) }));
  }
  const precision = packet.precision_frame || [];
  for (let start = 0; start < precision.length; start += precision_packet_size) {
    const identityRows = precision.slice(start, start + precision_packet_size)
      .map(row => ({ blind_arm: row.blind_arm, claim: row.claim }));
    // Keep the unit identity stable for explicit continuations, but remove long claim hashes from
    // the model-authored wire. The tool owns the packet-local handle and restores the immutable ID
    // only after exact handle/arm validation.
    const rows = identityRows.map((row, index) => {
      const { review_claim_id: reviewClaimId, ...claim } = row.claim;
      return Object.freeze({ blind_arm: row.blind_arm,
        review_ref: `P${String(index + 1).padStart(3, '0')}`,
        review_claim_id: reviewClaimId, claim: Object.freeze(claim) });
    });
    const id = `blind-precision-review:${sha256(canonical(identityRows))}`;
    const visibleRows = rows.map(({ blind_arm, review_ref, claim }) => ({ arm: blind_arm, id: review_ref, claim }));
    const prompt = [
      'Blindly audit each documentary claim against only its exact cited evidence. Grade whether the',
      'complete proposition is entailed, whether its subject is correctly bound to the actor/entity in',
      'the evidence, and severe semantic error (reversal, invented normative force, wrong actor, or',
      'material contradiction). OUTPUT JSON LINES ONLY, with one grade per review claim.',
      '{"k":"head","outcome":"graded"}',
      '{"k":"grade","arm":"A","id":"P001","entailed":true,"subject_binding_correct":true,"severe_error":false,"note":"brief reason"}',
      '{"k":"end"}',
      'For every grade, echo the exact arm from that grade\'s own input row. Do not reuse one arm',
      'label for the packet. Copy the short id only from the same input row; never copy',
      'or invent a long claim identifier.',
      'The final exact end line is mandatory after every grade; omitting it makes the entire packet',
      'terminal-incomplete even when all claim grades were emitted.',
      '',
      ...visibleRows.map(row => JSON.stringify(row)),
    ].join('\n');
    units.push(Object.freeze({ id, kind: 'precision', prompt, prompt_digest: sha256(prompt), rows }));
  }
  return Object.freeze({ units, packet_digest: sha256(canonical(packet)) });
}

function parseLines(text) {
  const rows = [], malformed = [];
  for (const [index, line] of String(text || '').split('\n').filter(row => row.trim()).entries()) {
    try { rows.push({ index, value: JSON.parse(line) }); }
    catch (error) { malformed.push({ index, error: error.message, raw: line }); }
  }
  return { rows, malformed };
}

export function validateBlindScreenReviewAnswer({ response, unit }) {
  const parsed = parseLines(response?.text);
  const headers = parsed.rows.filter(row => row.value?.k === 'head');
  const trailers = parsed.rows.filter(row => row.value?.k === 'end');
  const grades = parsed.rows.filter(row => row.value?.k === 'grade').map(row => row.value);
  const unknown = parsed.rows.filter(row => !['head', 'grade', 'end'].includes(row.value?.k));
  let expected, valid;
  if (unit.kind === 'opportunity') {
    expected = 4;
    const arms = Object.keys(unit.payload.arms).sort();
    const identities = new Set();
    valid = grades.every(row => {
      if (!arms.includes(row.arm)
        || !['sealed_block', 'document_scope'].includes(row.frame)
        || !['recovered', 'partial', 'missed'].includes(row.grade)
        || !Array.isArray(row.claim_refs)) return false;
      const identity = `${row.arm}\0${row.frame}`;
      if (identities.has(identity)) return false;
      identities.add(identity);
      if ((row.grade === 'missed') !== (row.claim_refs.length === 0)) return false;
      const documentClaims = unit.payload.arms[row.arm].document_scope_claims;
      if (!row.claim_refs.every(ref => documentClaims.some(claim => claim.claim_ref === ref))) return false;
      return row.frame !== 'sealed_block' || row.claim_refs.every(ref => documentClaims
        .some(claim => claim.claim_ref === ref && claim.in_sealed_block_frame));
    });
  } else {
    expected = unit.rows.length;
    const expectedById = new Map(unit.rows.map(row => [row.review_ref, row.blind_arm]));
    const identities = new Set();
    valid = grades.every(row => expectedById.get(row.id) === row.arm
      && !identities.has(row.id) && (identities.add(row.id), true)
      && typeof row.entailed === 'boolean'
      && typeof row.subject_binding_correct === 'boolean'
      && typeof row.severe_error === 'boolean');
  }
  const trailer = trailers[0]?.value;
  const trailerKeys = trailer ? Object.keys(trailer).sort() : [];
  const trailerValid = trailers.length === 1 && (
    (trailerKeys.length === 1 && trailerKeys[0] === 'k')
    || (trailerKeys.length === 2 && trailerKeys[0] === 'count' && trailerKeys[1] === 'k'
      && Number.isInteger(trailer.count) && trailer.count === expected)
  );
  const complete = parsed.malformed.length === 0 && unknown.length === 0
    && headers.length <= 1 && trailerValid
    && grades.length === expected && valid;
  if (!complete) return Object.freeze({
    ok: false,
    terminal_incomplete: true,
    error_code: 'BLIND_SCREEN_REVIEW_INCOMPLETE',
    reason: 'blind review omitted, duplicated, invented, or malformed one or more required grades',
    salvage: { schema: 'estate-map/non-promotable-blind-review-salvage/v1', status: 'non_promotable', grades, malformed: parsed.malformed },
  });
  const normalizedGrades = unit.kind === 'opportunity' ? grades.map(row => {
    const { claim_refs: refs, ...grade } = row;
    return Object.freeze({ ...grade, claim_ids: refs.map(ref => unit.claimIdByRef[ref]) });
  }) : grades.map(row => {
    const held = unit.rows.find(candidate => candidate.review_ref === row.id);
    return Object.freeze({ ...row, id: held.review_claim_id });
  });
  return Object.freeze({ ok: true, value: Object.freeze({ unit_id: unit.id, kind: unit.kind, grades: normalizedGrades }) });
}

export async function runBlindScreenReview({
  packet, checkpointPath, model, thinking = null, provider_route = null, runnerFactory = null,
  concurrency = 2, bounds = {}, unit_ids = null, materialization_label = null,
}) {
  const maxCost = Number(bounds.max_known_cost_usd ?? 24.99);
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost >= 25) throw new Error('blind screen review cap must be positive and strictly below $25');
  const fullPlan = buildBlindScreenReviewPackets({ packet, precision_packet_size: Number(bounds.precision_packet_size ?? 20) });
  const selectedIds = unit_ids ? new Set(unit_ids) : null;
  const plan = { ...fullPlan, units: selectedIds ? fullPlan.units.filter(unit => selectedIds.has(unit.id)) : fullPlan.units };
  if (selectedIds && (plan.units.length !== selectedIds.size || !plan.units.length)) {
    throw new Error('blind review follow-up selection contains missing, duplicate, or zero unit ids');
  }
  const policy = normalizeAttemptPolicy({
    max_attempts: Number(bounds.max_attempts_per_unit ?? 2),
    retryable_outcomes: bounds.retryable_outcomes ?? ['error:provider'],
    backoff_ms: Number(bounds.retry_backoff_ms ?? 1000),
    backoff_multiplier: Number(bounds.retry_backoff_multiplier ?? 2),
    max_backoff_ms: Number(bounds.retry_backoff_max_ms ?? 30000),
    jitter_ratio: Number(bounds.retry_jitter_ratio ?? 0.1),
  });
  const providerRoute = String(provider_route || (runnerFactory ? 'injected' : 'pi-rpc'));
  const materializationLabel = materialization_label == null ? null : String(materialization_label).trim();
  if (materializationLabel && (materializationLabel.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(materializationLabel))) {
    throw new Error('materialization label must be 1-160 safe identifier characters');
  }
  const checkpoint = await openCheckpointJournal({ file: checkpointPath, fingerprint: {
    version: BLIND_SCREEN_REVIEW_VERSION, packet_digest: plan.packet_digest,
    selected_unit_ids: plan.units.map(unit => unit.id),
    model, thinking, provider_route: providerRoute, custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
    attempt_policy: policy,
    ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
  } });
  const budget = createInferenceBudget({
    max_calls: Number(bounds.max_calls ?? plan.units.length * policy.max_attempts),
    max_known_cost_usd: maxCost,
    max_unpriced_attempts: Number(bounds.max_unpriced_attempts ?? 0),
    cost_reserve_per_call_usd: Number(bounds.cost_reserve_per_call_usd ?? 0.5),
  });
  const queue = createUnitQueue({
    units: plan.units.map(unit => ({ id: unit.id, payload: unit })),
    lease_ms: Number(bounds.lease_ms ?? Math.max(900000, Number(bounds.call_timeout_ms ?? 900000) * 2)),
    fleet_stop: bounds.fleet_stop ?? { failure_rate: 0.5, min_samples: 4 },
  });
  const makeRunner = runnerFactory || (() => createPiRpcRunner({
    model, thinking, timeoutMs: Number(bounds.call_timeout_ms ?? 900000), answerParser: acceptBlindReviewJsonlAtProviderBoundary,
  }));
  const runners = new Map(), built = [], results = new Map(), materializations = new Map();
  const runnerFor = worker => {
    if (!runners.has(worker)) { const runner = makeRunner({ worker, model, thinking }); runners.set(worker, runner); built.push(runner); }
    return runners.get(worker);
  };
  try {
    await runQueue({ queue, concurrency: Math.max(1, Number(concurrency)), process: async (held, worker) => {
      const unit = held.payload, runner = runnerFor(worker);
      const key = sha256(canonical({
        version: BLIND_SCREEN_REVIEW_VERSION, unit_id: unit.id, prompt_digest: unit.prompt_digest,
        model: runner.model, thinking, provider_route: providerRoute,
        ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
      }));
      const completion = await runCustodiedInference({
        checkpoint, stage: 'blind-screen-review', key, tag: `blind-review:${unit.id}`,
        prompt: unit.prompt, runner, budget, attempt_policy: policy,
        materialization_dependencies: {
          review_packet_digest: plan.packet_digest, review_unit_id: unit.id,
          model: runner.model, thinking, provider_route: providerRoute,
          ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
        },
        validate: response => validateBlindScreenReviewAnswer({ response, unit }),
      });
      materializations.set(unit.id, completion.materialization);
      if (completion.incomplete) return { outcome: 'quarantined', findings: [completion.incomplete] };
      results.set(unit.id, completion.validated);
      return { outcome: 'ok' };
    } });
  } finally {
    await checkpoint.close();
    for (const runner of built) { try { await runner.shutdown?.(); } catch {} }
  }
  const opportunityGrades = [], precisionGrades = [];
  for (const result of results.values()) {
    if (result.kind === 'opportunity') for (const row of result.grades) opportunityGrades.push({
      opportunity_id: plan.units.find(unit => unit.id === result.unit_id).payload.opportunity.id,
      blind_arm: row.arm, frame: row.frame, grade: row.grade, claim_ids: row.claim_ids, note: row.note ?? null,
    });
    else for (const row of result.grades) precisionGrades.push({
      review_claim_id: row.id, blind_arm: row.arm, entailed: row.entailed,
      subject_binding_correct: row.subject_binding_correct, severe_error: row.severe_error, note: row.note ?? null,
    });
  }
  const queueStatus = queue.status(), budgetStatus = budget.snapshot();
  const expectedOpportunity = plan.units.filter(unit => unit.kind === 'opportunity').length * 4;
  const expectedPrecision = plan.units.filter(unit => unit.kind === 'precision').reduce((sum, unit) => sum + unit.rows.length, 0);
  const complete = opportunityGrades.length === expectedOpportunity && precisionGrades.length === expectedPrecision
    && !queueStatus.by_state?.quarantined && !budgetStatus.unpriced_attempts;
  const body = {
    schema: 'estate-map/v28-blind-screen-grades/v1', version: BLIND_SCREEN_REVIEW_VERSION,
    blinded: true, reviewer: { model, thinking, provider_route: providerRoute }, packet_digest: plan.packet_digest,
    selected_unit_ids: plan.units.map(unit => unit.id),
    budget: budgetStatus, queue: queueStatus,
    materializations: [...materializations.entries()].map(([unit_id, value]) => ({ unit_id, ...value })),
    ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
    opportunity_grades: opportunityGrades.sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id) || a.blind_arm.localeCompare(b.blind_arm) || a.frame.localeCompare(b.frame)),
    precision_grades: precisionGrades.sort((a, b) => a.review_claim_id.localeCompare(b.review_claim_id)),
    complete,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/, '')] = args[index + 1];
  for (const name of ['packet', 'checkpoint', 'output', 'model']) if (!options[name]) throw new Error(`missing --${name}`);
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('set ASCRYBE_ENABLE_PAID_INFERENCE=1 to authorize paid inference');
  const packet = JSON.parse(await fs.readFile(path.resolve(options.packet), 'utf8'));
  const bounds = options.bounds ? JSON.parse(await fs.readFile(path.resolve(options.bounds), 'utf8')) : {};
  const selected = options['unit-ids'] ? JSON.parse(await fs.readFile(path.resolve(options['unit-ids']), 'utf8')) : null;
  const unitIds = Array.isArray(selected) ? selected : selected?.unit_ids || null;
  if (options['max-cost']) bounds.max_known_cost_usd = Number(options['max-cost']);
  const result = await runBlindScreenReview({
    packet, checkpointPath: path.resolve(options.checkpoint), model: options.model,
    thinking: options.thinking || null, concurrency: Number(options.concurrency || bounds.concurrency || 2), bounds,
    unit_ids: unitIds,
    materialization_label: options['materialization-label'] || null,
  });
  const output = path.resolve(options.output), temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({ output, complete: result.complete, opportunity_grades: result.opportunity_grades.length, precision_grades: result.precision_grades.length, budget: result.budget, digest: result.digest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
