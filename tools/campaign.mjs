#!/usr/bin/env node
// ESTATE-MAP CAMPAIGN — the independent-verification candidate generator (VCEC Arm 2/3).
//
// WHAT THIS IS. This is the FIRST genuinely model-dependent estate-map stage. Forensic
// archaeology (brew-88761b08) proved that every prior "neural" L1 run was a the host runtime module worker
// hand-transcribing verdicts into a committed JS literal (examples/l1-run1/build-verdicts.mjs)
// with ZERO provider calls. This module wires the real thing: it BRIDGES the already-landed
// deterministic `l1-adjudicate prepare -> ingest -> reduce/apply` boundary by making REAL
// cross-provider model calls, and it emits canonical `estate-map/adjudication-record/v1`
// receipts that the landed ingest validates and appends fail-closed. It does NOT reimplement
// prepare/ingest/apply/reduce — it imports and calls them.
//
// WHERE INDEPENDENCE LIVES. Independence is a property of THIS HARNESS, not of brew topology.
//   * Proposer (a routed opus model) reads ONE candidate_packet and emits a
//     normalized_proposition P plus a claim_candidate. Its rationale is QUARANTINED — it never
//     reaches any verifier.
//   * Four verifiers = {support-P, support-not-P} x {openai gpt-5.6-sol, google gemini-3.1-pro}
//     are BLINDED: each receives ONLY the proposition (or its canonical negation) plus
//     harness-gathered evidence — never the proposer rationale, never a sibling's output.
//   * Evidence is TOOL-OWNED: campaign.mjs itself runs `git grep`/`git show` over the immutable
//     G0 snapshot and passes the RESULTS into the prompt. Every model call is
//     `pi --no-tools --no-session --no-context-files --mode json` so a model cannot fetch its
//     own evidence or self-confirm.
//   * A PURE-CODE deterministic combiner folds the four signals into a 4-state lattice.
//   * A separate ratifier may veto `supported` -> `underdetermined` but can NEVER upgrade.
//
// SNAPSHOT IMMUTABILITY (VCEC). The campaign binds an immutable
// G0 = {subject_source_sha, generator_sha, graph_digest, corpus_manifest_digest, campaign_id}
// recorded in a campaign_contract record. Evidence is gathered ONCE per packet against G0 and
// frozen; obligations query only that evidence universe. No `latest` lookup, no mid-campaign
// rescan. See CAMPAIGN_INVARIANTS below and test/tools/estateMapCampaign.test.mjs.
//
// NO anthropic/* CALLS. The proposer/ratifier route through the `a routed gateway` the routed gateway
// gateway (`<configured-model>`), never `anthropic/*`. Asserted in tests.

import { spawn } from 'node:child_process';
import { constants as bufferConstants } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { createRecord, validateRecordList, canonicalSerialize, semanticHash } from './adjudication-schema.mjs';
import {
  assertInferencePromptWithinLimit,
  classifyBillingStatus as billingStatus,
  DEFAULT_MAX_INFERENCE_ANSWER_BYTES,
  DEFAULT_MAX_INFERENCE_EVENT_BYTES,
  emptyInferenceUsage as emptyUsage,
} from './inference-custody.mjs';

const execFileAsync = promisify(execFile);

export const CAMPAIGN_SCHEMA_VERSION = 'estate-map/campaign/v1';
export const CAMPAIGN_VERSION = '1';
export const COMBINER_TRUTH_TABLE_VERSION = 'estate-map/campaign-combiner/v1';

// ---------------------------------------------------------------------------
// MODEL ROSTER — verified reachable this session. NO anthropic/*.
// ---------------------------------------------------------------------------
export const PROPOSER_MODEL = '<configured-model>';
export const RATIFIER_MODEL = '<configured-model>';
export const VERIFIER_FAMILY_A = 'openai-codex/gpt-5.6-sol';
// FLIPPED default (was openrouter/google/gemini-3.1-pro-preview): the reachability-tested
// google verifier for this build session routes through the a routed gateway the routed gateway gateway.
export const VERIFIER_FAMILY_B = '<configured-model>';
export const FALLBACK_MODEL = 'openai-codex/gpt-5.6-sol';

// Family label per model string. Distinct families are load-bearing: the `absent` verdict's
// A4 condition requires two negative verifiers of DISTINCT model families.
export const MODEL_FAMILY = Object.freeze({
  [PROPOSER_MODEL]: 'a routed anthropic model',
  [VERIFIER_FAMILY_A]: 'openai',
  [VERIFIER_FAMILY_B]: 'google',
});
// The explicit map wins; otherwise a robust heuristic classifies an OVERRIDDEN --verifier
// model string (CLI roster override) so the two verifier families stay DISTINCT — both the
// A4/absent C4 condition and the inter-family agreement metric depend on distinctness.
export function familyOf(model) {
  if (MODEL_FAMILY[model]) return MODEL_FAMILY[model];
  const m = String(model || '');
  if (/(^|\/)anthropic\/|claude/i.test(m)) return 'a routed anthropic model';
  if (/gemini|(^|\/)google\//i.test(m)) return 'google';
  if (/gpt|openai|codex/i.test(m)) return 'openai';
  return m.split('/')[0] || 'unknown';
}

// The four blinded verifier roles: two directions x two families. buildVerifierRoles lets the
// CLI override the two verifier model strings while re-deriving each family from the string.
export function buildVerifierRoles(verifierA = VERIFIER_FAMILY_A, verifierB = VERIFIER_FAMILY_B) {
  return Object.freeze([
    Object.freeze({ role: 'support-P', direction: 'support-P', model: verifierA, family: familyOf(verifierA) }),
    Object.freeze({ role: 'support-P', direction: 'support-P', model: verifierB, family: familyOf(verifierB) }),
    Object.freeze({ role: 'support-not-P', direction: 'support-not-P', model: verifierA, family: familyOf(verifierA) }),
    Object.freeze({ role: 'support-not-P', direction: 'support-not-P', model: verifierB, family: familyOf(verifierB) }),
  ]);
}
export const VERIFIER_ROLES = buildVerifierRoles();

// Fail-closed roster gate: NO anthropic/* model may be invoked directly (credits exhausted;
// opus routes through the a routed gateway the routed gateway gateway). Enforced at campaign start AND in
// the unit tests, so a CLI override cannot smuggle in a forbidden provider.
export function assertRosterNoAnthropic(models) {
  for (const m of models) {
    if (/^anthropic\//.test(String(m))) throw new Error(`roster model "${m}" is a forbidden anthropic/* model (credits exhausted; route opus via a routed gateway)`);
  }
}

export const CAMPAIGN_INVARIANTS = Object.freeze({
  snapshot_immutable: 'evidence is gathered once against G0 and frozen; no latest lookup or mid-campaign rescan',
  blinded_verifiers: 'verifier prompts contain only proposition (or negation) + tool-gathered evidence; never proposer rationale or sibling output',
  tool_owned_evidence: 'the harness runs git grep/show; every model runs --no-tools --no-session --no-context-files',
  pure_combiner: 'the 4->1 combiner is total, deterministic, model-free',
  ratifier_monotone: 'the ratifier may veto supported->underdetermined but can never upgrade refuted/underdetermined to supported',
  no_anthropic_direct: 'proposer/ratifier route through the the routed gateway gateway; zero anthropic/* invocations',
});

// ===========================================================================
// PROPOSITION NORMALIZATION AND CANONICAL NEGATION
// ===========================================================================

/** The canonical proposition for a packet, stated affirmatively (P). Deterministic. */
export function normalizeProposition(packet, { proposerText = null } = {}) {
  const entry = packet.queue_entry || {};
  if (packet.claim_type === 'referent_search') {
    const subject = entry.canon_entity;
    return {
      subject,
      predicate: 'has_code_referent',
      polarity: 'affirmative',
      text: proposerText || `The canon entity "${subject}" exists in the code under some (possibly different) name.`,
    };
  }
  if (packet.claim_type === 'entity_classification') {
    const subject = entry.entity;
    return {
      subject,
      predicate: 'is_domain_entity',
      polarity: 'affirmative',
      text: proposerText || `The discovered name "${subject}" is a domain entity (not an extraction artifact or a mere read model).`,
    };
  }
  if (packet.claim_type === 'disambiguation') {
    const subject = entry.name ?? entry.target_name_or_expr;
    return {
      subject,
      predicate: 'resolves_to_single_candidate',
      polarity: 'affirmative',
      text: proposerText || `The ambiguous reference "${subject}" resolves to exactly one of its candidate targets.`,
    };
  }
  throw new Error(`normalizeProposition: unsupported claim_type ${packet.claim_type}`);
}

/** Canonical negation of P (¬P). The not-P verifiers seek evidence for THIS. */
export function negateProposition(proposition) {
  const negatedText = proposition.polarity === 'affirmative'
    ? `It is NOT the case that: ${proposition.text}`
    : proposition.text.replace(/^It is NOT the case that:\s*/, '');
  return {
    subject: proposition.subject,
    predicate: proposition.predicate,
    polarity: proposition.polarity === 'affirmative' ? 'negative' : 'affirmative',
    text: negatedText,
  };
}

// ===========================================================================
// THE PURE-CODE COMBINER — total, deterministic, model-free.
//
// Inputs: four verifier stances. The two support-P verifiers seek grounded evidence FOR P;
// the two support-not-P verifiers seek grounded evidence FOR ¬P. Each returns a stance in
// {affirms, denies, inconclusive}, where `affirms` means "the tool-gathered evidence contains
// a concrete witness for MY assigned direction".
//
// Let pAff = #{support-P verifiers that affirm} in 0..2, nAff = #{support-not-P that affirm}.
//
//   pAff\nAff |   0             |   1          |   2
//   ----------+-----------------+--------------+-------------
//      0      | underdetermined | underdeterm. | refuted
//      1      | underdetermined | conflict     | conflict
//      2      | supported       | conflict     | conflict
//
// Rationale:
//  * supported  : BOTH cross-family P-verifiers found evidence for P and NEITHER ¬P-verifier
//                 found counter-evidence. The strongest, cross-family-independent positive.
//  * refuted    : BOTH ¬P-verifiers found evidence for ¬P and NEITHER P-verifier found P.
//  * conflict   : both directions found some evidence (a genuine contradiction to surface).
//  * underdetermined: partial or absent signal — NOT enough to force any verdict (the T4 case).
// ===========================================================================
export function combine(signals) {
  const stances = ['affirms', 'denies', 'inconclusive'];
  const check = (arr, label) => {
    if (!Array.isArray(arr) || arr.length !== 2) throw new Error(`combine: ${label} must be exactly two stances`);
    for (const s of arr) if (!stances.includes(s)) throw new Error(`combine: invalid stance "${s}" in ${label}`);
  };
  check(signals.p, 'signals.p (support-P)');
  check(signals.n, 'signals.n (support-not-P)');
  const pAff = signals.p.filter(s => s === 'affirms').length;
  const nAff = signals.n.filter(s => s === 'affirms').length;
  let state;
  if (pAff >= 1 && nAff >= 1) state = 'conflict';
  else if (pAff === 2 && nAff === 0) state = 'supported';
  else if (nAff === 2 && pAff === 0) state = 'refuted';
  else state = 'underdetermined';
  return { state, p_affirms: pAff, n_affirms: nAff, truth_table_version: COMBINER_TRUTH_TABLE_VERSION };
}

// The full 9-row truth table, materialized for the unit test and documentation.
export function combinerTruthTable() {
  const stanceFor = k => k === 0 ? ['denies', 'denies'] : k === 1 ? ['affirms', 'denies'] : ['affirms', 'affirms'];
  const rows = [];
  for (let pAff = 0; pAff <= 2; pAff++) {
    for (let nAff = 0; nAff <= 2; nAff++) {
      rows.push({ pAff, nAff, ...combine({ p: stanceFor(pAff), n: stanceFor(nAff) }) });
    }
  }
  return rows;
}

// ===========================================================================
// NEGATIVE-EVIDENCE BAR — the five conditions §14.5 requires before `absent`.
// ===========================================================================
export const ABSENCE_CONDITIONS = Object.freeze([
  'C1: every near-miss cluster rejected with a discriminating positive witness',
  'C2: tool-owned search transcript (queries + manifest digest), not a model assertion',
  'C3: both negative verifiers bind the same corpus_manifest_digest',
  'C4: two negative verifiers of DISTINCT model families independently returned absence',
  'C5: the canon witness that created the expectation still resolves',
]);

/**
 * Evaluate the five-condition bar. Returns { satisfied, conditions:[{id,pass,why}] }. This is
 * deterministic and model-free; it inspects the packet, the tool-gathered evidence, and the
 * blinded negative-verifier stances. Never fabricates an absence witness.
 */
export function evaluateAbsenceBar({ packet, evidence, negativeVerifiers, corpusManifestDigest }) {
  const conditions = [];
  const nearMisses = (packet.queue_entry?.near_miss_clusters || []);
  const rejected = evidence?.near_miss_rejections || [];
  const c1 = nearMisses.length === 0 || nearMisses.every(nm => rejected.some(r => r.cluster === (nm.entity ?? nm)));
  conditions.push({ id: 'C1', pass: Boolean(c1), why: c1 ? 'all near misses rejected' : `${nearMisses.length} near miss(es), ${rejected.length} rejection(s)` });

  const hasTranscript = Array.isArray(evidence?.queries) && evidence.queries.length > 0 && Boolean(corpusManifestDigest);
  conditions.push({ id: 'C2', pass: hasTranscript, why: hasTranscript ? 'tool search transcript present' : 'missing search transcript or manifest digest' });

  const bothBind = Boolean(corpusManifestDigest) && (negativeVerifiers || []).every(v => v.corpus_manifest_digest === corpusManifestDigest);
  conditions.push({ id: 'C3', pass: bothBind, why: bothBind ? 'both negatives bind the same corpus_manifest_digest' : 'negative verifiers do not share a corpus manifest binding' });

  const negFamilies = new Set((negativeVerifiers || []).filter(v => v.stance === 'affirms').map(v => v.family));
  const c4 = negFamilies.size >= 2;
  conditions.push({ id: 'C4', pass: c4, why: c4 ? 'two distinct-family negatives returned absence' : `distinct affirming negative families: ${negFamilies.size}` });

  const canonResolves = Boolean(evidence?.canon_witness_resolves);
  conditions.push({ id: 'C5', pass: canonResolves, why: canonResolves ? 'canon witness still resolves' : 'canon witness does not resolve' });

  const satisfied = conditions.every(c => c.pass);
  return { satisfied, conditions };
}

// ===========================================================================
// PROMPT BUILDERS
//
// evidenceMenu is the harness-gathered, tool-owned evidence, presented with STABLE indices so
// a model (running --no-tools) can reference a witness by index rather than inventing one.
// ===========================================================================

function renderEvidenceMenu(evidence) {
  const lines = [];
  lines.push('EVIDENCE (gathered by the harness over the immutable snapshot; you cannot run tools):');
  if (evidence.clusters?.length) {
    lines.push('  Candidate code clusters (choose a target from THIS list only):');
    evidence.clusters.forEach((c, i) => lines.push(`    [cluster ${i}] ${c}`));
  }
  lines.push('  Grep witnesses (file:line — the ONLY witnesses you may cite, by index):');
  if (!evidence.hits.length) lines.push('    (none — the tool search returned no matching site)');
  evidence.hits.forEach(h => lines.push(`    [${h.idx}] ${h.file}:${h.line}  ${truncate(h.text, 200)}`));
  if (evidence.canon_witness) lines.push(`  Canon witness: ${evidence.canon_witness.file}:${evidence.canon_witness.line}`);
  return lines.join('\n');
}

function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }

export function buildProposerPrompt(packet, evidence) {
  const p = normalizeProposition(packet);
  return [
    'You are the PROPOSER in an independent-verification campaign. You read ONE candidate packet',
    'and state a single normalized proposition, then decide whether the code evidence supports it.',
    'You have NO tools. Use ONLY the evidence below. Do not invent file paths or line numbers.',
    '',
    `CLAIM TYPE: ${packet.claim_type}`,
    `QUESTION: ${packet.question}`,
    `NORMALIZED PROPOSITION P: ${p.text}`,
    '',
    renderEvidenceMenu(evidence),
    '',
    'Output ONLY a single-line minified JSON object, no markdown, no prose, matching:',
    '{"proposition":"<one-sentence affirmative restatement of P>",',
    ' "exists":true|false|null,',
    ' "target_cluster":"<one cluster NAME from the list, or null>",',
    ' "behaviour_witness_index":<integer index into the grep witnesses, or null>,',
    ' "confidence":<number 0..1>,',
    ' "rationale":"<your private reasoning — quarantined, never shown to verifiers>"}',
  ].join('\n');
}

/**
 * BLINDING GUARANTEE. This builder accepts ONLY the proposition (already direction-adjusted),
 * the direction label, and the tool-gathered evidence. It has no parameter through which the
 * proposer rationale or a sibling verifier's output could enter, so a blinded prompt is
 * structural, not a matter of discipline. Asserted by estateMapCampaign.test.mjs.
 */
export function buildVerifierPrompt(directionProposition, direction, evidence) {
  const seeking = direction === 'support-P' ? 'FOR this proposition' : 'FOR this proposition (which is the negation of the original claim)';
  return [
    `You are a BLINDED VERIFIER (${direction}). You seek grounded evidence ${seeking}.`,
    'You do NOT see the proposer\'s reasoning or any other verifier\'s conclusion. You have NO tools.',
    'You may cite ONLY a witness that appears in the evidence menu, by its index.',
    '',
    `PROPOSITION TO VERIFY: ${directionProposition.text}`,
    '',
    renderEvidenceMenu(evidence),
    '',
    'A witness "affirms" only if it concretely demonstrates the proposition at that file:line.',
    'If the evidence contains no such witness, you MUST answer "inconclusive" or "denies" — never guess.',
    '',
    'Output ONLY a single-line minified JSON object, no markdown, no prose, matching:',
    '{"stance":"affirms"|"denies"|"inconclusive",',
    ' "witness_index":<integer index of the strongest supporting witness, or null>,',
    ' "confidence":<number 0..1>,',
    ' "reason":"<one short sentence grounded in the cited witness>"}',
  ].join('\n');
}

export function buildRatifierPrompt(proposition, aggregate, evidence, proposedVerdict) {
  return [
    'You are the RATIFIER. The pure-code combiner returned "supported" for the proposition below.',
    'You may CONFIRM the support, or VETO it down to "underdetermined". You can NEVER upgrade.',
    'You have NO tools. Judge ONLY from the evidence and the combiner tally.',
    '',
    `PROPOSITION P: ${proposition.text}`,
    `COMBINER: support-P affirmations=${aggregate.p_affirms}/2, support-not-P affirmations=${aggregate.n_affirms}/2 -> ${aggregate.state}`,
    `PROPOSED POSITIVE VERDICT: ${proposedVerdict}`,
    '',
    renderEvidenceMenu(evidence),
    '',
    'Veto (ratify=false) if the cited witnesses do not actually discharge the proposition, or if',
    'the support looks like name-similarity rather than a behavioural witness.',
    '',
    'Output ONLY a single-line minified JSON object, no markdown, no prose, matching:',
    '{"ratify":true|false,"reason":"<one short sentence>"}',
  ].join('\n');
}

// ===========================================================================
// pi INVOCATION + OUTPUT PARSING
// ===========================================================================

/**
 * Extract the final assistant answer and usage from a `pi --mode json` JSONL stream. The final
 * `agent_end` event carries the full message list; we take the last assistant message's joined
 * text content and its usage. Falls back to the last assistant message_end with usage.
 */
export function extractPiResult(stdout) {
  const lines = String(stdout).split('\n').map(l => l.trim()).filter(Boolean);
  let agentEnd = null;
  let lastAssistant = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'agent_end' && Array.isArray(ev.messages)) agentEnd = ev;
    if ((ev.type === 'message_end' || ev.type === 'turn_end') && ev.message?.role === 'assistant') lastAssistant = ev.message;
  }
  let message = null;
  if (agentEnd) {
    const assistants = agentEnd.messages.filter(m => m.role === 'assistant');
    message = assistants.length ? assistants[assistants.length - 1] : null;
  }
  message = message || lastAssistant;
  if (!message) return { text: '', usage: emptyUsage(), found: false, stopReason: null, errorMessage: null };
  const text = (message.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const u = message.usage || {};
  const usage = {
    input_tokens: Number(u.input || 0),
    output_tokens: Number(u.output || 0),
    total_tokens: Number(u.totalTokens || (Number(u.input || 0) + Number(u.output || 0))),
    cost: Number(u.cost?.total || 0),
    cost_reported: u.cost?.total != null,
  };
  // stopReason/errorMessage expose PROVIDER-side failures (e.g. openai-codex
  // provider_transport_failure -> stopReason 'error' with an empty content[]), which otherwise
  // masquerade as an unparseable answer. Surface them as terminal provider failures for custody.
  return { text, usage, found: true, model: message.model || null, stopReason: message.stopReason || null, errorMessage: message.errorMessage || null };
}


/** Parse a model's JSON answer defensively: strip fences, take the first {...last }. */
export function parseModelJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  const candidate = s.slice(first, last + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

/** Legacy classifier retained for old benchmark analysis. Paid invocation no longer consumes it:
 * once a call may have reached the provider, every outcome is terminal and durably reviewed.
 */
export function isRetryableOutcome(outcome) {
  const s = String(outcome || '');
  if (s === 'ok') return false;
  if (/timeout/i.test(s)) return false;
  return true;
}

/**
 * Invoke one model via pi exactly once. `maxAttempts` is accepted only for compatibility and never
 * honored above one: provider acceptance/billing cannot be proven absent after a failed attempt.
 * Targeted repair must create a new, explicit work unit.
 */
export async function callModel(opts) {
  assertInferencePromptWithinLimit(opts.prompt);
  const started = Date.now();
  const res = await callModelOnce(opts);
  res.attempts = 1;
  res.retry_policy = Number(opts.maxAttempts ?? 1) > 1 ? 'unsafe-retry-request-suppressed' : 'single-attempt';
  res.latency_ms = Date.now() - started;
  return res;
}

export async function callModelOnce({ model, prompt, thinking = null, runner = null, scratchDir = null, tag = 'call', timeoutMs = 90000, maxOutputBytes = DEFAULT_MAX_INFERENCE_EVENT_BYTES, maxAnswerBytes = DEFAULT_MAX_INFERENCE_ANSWER_BYTES }) {
  const started = Date.now();
  if (runner) {
    // RESILIENT: a runner (fixture OR live) that THROWS is caught and recorded as an errored
    // call, never propagated — one bad call must not abort the whole campaign.
    try {
      const res = await runner({ model, prompt, thinking, tag });
      const parsedFromStdout = res.stdout != null ? extractPiResult(res.stdout) : null;
      const text = res.text != null ? res.text : (parsedFromStdout?.text || '');
      const usage = res.usage || parsedFromStdout?.usage || emptyUsage();
      const json = parseModelJson(text);
      let outcome = res.outcome || 'ok';
      if (outcome === 'ok' && text && json === null) outcome = 'ok:unparseable';
      const answerBytes = Buffer.byteLength(text || '', 'utf8');
      if (answerBytes > maxAnswerBytes) outcome = 'output_limit';
      const accepted = res.accepted ?? (!/spawn_error|process_unavailable/i.test(outcome) ? true : false);
      const billing_status = res.billing_status || billingStatus({ outcome, usage, accepted });
      return { model, family: familyOf(model), thinking, text, usage, latency_ms: Date.now() - started, outcome, json: outcome === 'output_limit' ? null : json, accepted, billing_status, answer_bytes: answerBytes, max_answer_bytes: maxAnswerBytes };
    } catch (e) {
      const usage = emptyUsage();
      const outcome = `error:${e.message}`;
      const accepted = null;
      return { model, family: familyOf(model), thinking, text: '', usage, latency_ms: Date.now() - started, outcome, json: null, accepted, billing_status: billingStatus({ outcome, usage, accepted }) };
    }
  }
  const args = ['--model', model, '-p', prompt, '--no-tools', '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--mode', 'json'];
  if (thinking) args.push('--thinking', thinking);
  const { stdout, outcome } = await new Promise((resolve) => {
    const child = spawn('pi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // A cap above what a JS string can hold is not a cap. `max_event_bytes` was configured at
    // 536,870,912 while this runtime's ceiling is 536,870,888 -- twenty-four bytes lower -- so a
    // runaway stream raced the two limits, and whichever a chunk crossed first decided whether
    // the call was recorded as output_limit or killed the whole batch with RangeError. It killed
    // an 8,762-window run at window 27. Byte accounting still uses the configured cap so the
    // recorded outcome is unchanged; only what is RETAINED is clamped to what can be held.
    const retained = Math.min(maxOutputBytes, bufferConstants.MAX_STRING_LENGTH - 1024);
    let out = '';
    let outBytes = 0;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    // TIMEOUT: every pi call is bounded; a hung provider is SIGKILLed (a stuck model stream
    // ignores SIGTERM) and recorded as a timeout rather than stalling the batch.
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } done({ stdout: out, outcome: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', d => {
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      const remaining = Math.max(0, retained - outBytes);
      if (remaining > 0) out += chunk.subarray(0, remaining).toString('utf8');
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        done({ stdout: out, outcome: 'output_limit' });
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (e) => done({ stdout: out, outcome: `spawn_error:${e.message}` }));
    child.on('close', (code) => done({ stdout: out, outcome: code === 0 ? 'ok' : `exit_${code}` }));
  });
  if (scratchDir) {
    try { await fsp.writeFile(path.join(scratchDir, `${tag}.pi.jsonl`), stdout, 'utf8'); } catch { /* best effort */ }
  }
  const parsed = extractPiResult(stdout);
  const json = parseModelJson(parsed.text);
  // A provider-side stopReason:'error' (e.g. openai-codex WebSocket transport failure) exits 0
  // but carries no answer; classify it as a terminal provider error rather than 'unparseable'.
  let finalOutcome = outcome;
  if (parsed.stopReason === 'error') finalOutcome = 'error:provider';
  else if (outcome === 'ok') {
    if (!parsed.found) finalOutcome = 'ok:no_answer';
    else if (json === null) finalOutcome = parsed.text ? 'ok:unparseable' : 'ok:empty';
  }
  const answerBytes = Buffer.byteLength(parsed.text || '', 'utf8');
  if (answerBytes > maxAnswerBytes) finalOutcome = 'output_limit';
  const accepted = parsed.found || parsed.stopReason ? true : (/spawn_error/i.test(finalOutcome) ? false : (finalOutcome === 'ok' ? true : null));
  const billing_status = billingStatus({ outcome: finalOutcome, usage: parsed.usage, accepted });
  return { model, family: familyOf(model), thinking, text: parsed.text, usage: parsed.usage, latency_ms: Date.now() - started, outcome: finalOutcome, json: finalOutcome === 'output_limit' ? null : json, accepted, billing_status, answer_bytes: answerBytes, max_answer_bytes: maxAnswerBytes };
}

// ===========================================================================
// TOOL-OWNED EVIDENCE GATHERING (runs over the immutable G0 snapshot)
// ===========================================================================

function termVariants(name) {
  const base = String(name || '').trim();
  if (!base) return [];
  const lower = base.toLowerCase();
  const snake = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const nospace = base.replace(/\s+/g, '');
  const camel = nospace.charAt(0).toLowerCase() + nospace.slice(1);
  return [...new Set([base, lower, snake, nospace, camel].filter(Boolean))];
}

const GREP_EXCLUDES = [':!node_modules', ':!*.md', ':!design', ':!.git', ':!*.lock', ':!pnpm-lock.yaml', ':!package-lock.json', ':!dist', ':!build'];

async function gitGrep(estateRoot, term, limit) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', estateRoot, 'grep', '-nI', '--no-color', '-F', '-e', term, '--', ...GREP_EXCLUDES], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean).slice(0, limit).map(line => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
    }).filter(Boolean);
  } catch (e) {
    // git grep exits 1 when there are no matches — that is a valid, empty result.
    if (e.code === 1) return [];
    return [];
  }
}

/**
 * Gather evidence for one packet ONCE against the G0 snapshot. The returned menu is frozen and
 * reused for the proposer and all four verifiers — no verifier triggers a rescan.
 */
export async function gatherEvidence({ estateRoot, packet, maxHits = 28, grep = null }) {
  const runGrep = grep || ((term, limit) => gitGrep(estateRoot, term, limit));
  const entry = packet.queue_entry || {};
  const subject = entry.canon_entity ?? entry.entity ?? entry.name ?? entry.target_name_or_expr ?? '';
  const terms = termVariants(subject);
  const seen = new Set();
  const hits = [];
  for (const term of terms) {
    if (hits.length >= maxHits) break;
    for (const h of await runGrep(term, maxHits)) {
      const key = `${h.file}:${h.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ idx: hits.length, file: h.file, line: h.line, text: h.text });
      if (hits.length >= maxHits) break;
    }
  }
  const clusters = (packet.evidence_pointers?.near_miss_clusters || entry.near_miss_clusters || []).map(c => c.entity ?? c).filter(Boolean);
  const canon_witness = entry.canon_witness || packet.evidence_pointers?.canon_witness || null;
  return {
    subject,
    terms,
    hits,
    clusters: [...new Set(clusters)],
    canon_witness,
    queries: terms.map(t => `git grep -nI -F -e "${t}" -- ${GREP_EXCLUDES.join(' ')}`),
    hit_count: hits.length,
    evidence_digest: sha256(stableStringify({ subject, terms, hits, clusters, canon_witness })),
  };
}

// ===========================================================================
// VERDICT MAPPING — ratified combiner outcome -> legacy verdict (for `apply`) + disposition.
//
// The legacy verdict object is the input to the LANDED `applyVerdicts`; it is validated there
// by validateVerdict against the packet. We build only structurally-valid verdicts: witnesses
// come from real grep hits (so they resolve), found_as targets come from the real cluster list,
// and refusals carry empty witnesses. When the model's structured pick cannot be discharged
// into a valid positive verdict, the honest output is a refusal (search_inconclusive /
// insufficient_evidence) — exactly the l1-run1 pattern for `project`/`registry`/`route`.
// ===========================================================================

const REFUSAL_ARTIFACT = 'a promoted deterministic check (fixed exhaustive search action + manifest binding) that a later build can re-run without a model; see step-3-build-spec §14.7';

function witnessFrom(hit) { return { repo: '.', file: hit.file, line: hit.line }; }

export function mapOutcomeToVerdict({ packet, aggregate, ratified, proposerPick, evidence, corpusManifestDigest, negativeVerifiers, adjudicator, adjudicatorFamily }) {
  const base = {
    adjudicator, adjudicator_family: adjudicatorFamily,
    claim_type: packet.claim_type, queue_entry_digest: packet.queue_entry_digest,
    confidence: clamp01(proposerPick?.confidence ?? 0.7),
  };
  const combineState = aggregate.state;
  const supported = combineState === 'supported' && ratified;
  const reasonTail = `combine=${combineState} p_affirms=${aggregate.p_affirms}/2 n_affirms=${aggregate.n_affirms}/2 ratified=${ratified}`;

  if (packet.claim_type === 'referent_search') {
    if (supported && proposerPick?.target_cluster && Number.isInteger(proposerPick.behaviour_witness_index) && evidence.hits[proposerPick.behaviour_witness_index]) {
      const w = witnessFrom(evidence.hits[proposerPick.behaviour_witness_index]);
      return {
        disposition: 'found_as', record_kind: 'found_as', active_delta: -1,
        verdict: { ...base, verdict: 'found_as', found_as: `cluster:${proposerPick.target_cluster}`, witnesses: [w], behaviour_witness_index: 0,
          reasoning: `Independent verification supported the referent under cluster:${proposerPick.target_cluster}; behaviour witnessed at ${w.file}:${w.line}. ${reasonTail}` },
      };
    }
    if (combineState === 'refuted') {
      const bar = evaluateAbsenceBar({ packet, evidence: { ...evidence, near_miss_rejections: proposerPick?.near_miss_rejections || [], canon_witness_resolves: Boolean(evidence.canon_witness) }, negativeVerifiers, corpusManifestDigest });
      if (packet.absent_permitted && bar.satisfied) {
        return {
          disposition: 'absent', record_kind: 'absent', active_delta: -1,
          verdict: { ...base, verdict: 'absent', witnesses: [],
            panel: dedupeFamilies(negativeVerifiers),
            search_evidence: { corpus_manifest_digest: corpusManifestDigest, sha: corpusManifestDigest, queries: evidence.queries, corpora_covered: ['tracked source at the G0 snapshot'], aliases_considered: evidence.terms },
            near_miss_rejections: proposerPick?.near_miss_rejections || [], canon_witness_resolves: true,
            reasoning: `Closed-world absence satisfied the five-condition bar. ${reasonTail}` },
        };
      }
      // Refuted but absence not writable (gate shut or bar unmet): honest inconclusive.
      return refusalReferent(base, evidence, `Evidence pointed away from a code referent but the closed-world absence bar is not satisfiable here (${packet.absent_permitted ? 'bar unmet' : 'absent gated shut §7.4'}). ${reasonTail}`);
    }
    return refusalReferent(base, evidence, `Independent verification did not converge on a code referent. ${reasonTail}`);
  }

  if (packet.claim_type === 'entity_classification') {
    // domain_entity / not_an_entity require a discharged per-signature-class witness map, which
    // cannot be honestly synthesized from a bare grep. The honest output when the coverage
    // obligation cannot be discharged from opened sites is insufficient_evidence.
    return refusalClassification(base, evidence, `Independent verification produced combine=${combineState}, but the per-signature-class witness obligation (${(packet.queue_entry?.signature_classes || []).join(', ') || 'none'}) cannot be discharged from the harness-opened sites without fabricating a class label. ${reasonTail}`);
  }

  // disambiguation
  return refusalDisambiguation(base, evidence, `Independent verification produced combine=${combineState}; a resolved_to needs a discriminating witness pair chosen from candidates[], which was not discharged. ${reasonTail}`);
}

function refusalReferent(base, evidence, reasoning) {
  return {
    disposition: 'search_inconclusive', record_kind: 'search_inconclusive', active_delta: 0,
    verdict: { ...base, verdict: 'search_inconclusive', witnesses: [],
      search_evidence: { queries: evidence.queries, corpora_covered: ['tracked source at the G0 snapshot'], aliases_considered: evidence.terms },
      insufficient_because: firstNChars(reasoning, 240), requested_artifact: REFUSAL_ARTIFACT, reasoning },
  };
}
function refusalClassification(base, evidence, reasoning) {
  return {
    disposition: 'insufficient_evidence', record_kind: 'insufficient_evidence', active_delta: 0,
    verdict: { ...base, verdict: 'insufficient_evidence', witnesses: [],
      insufficient_because: firstNChars(reasoning, 240), requested_artifact: REFUSAL_ARTIFACT, reasoning },
  };
}
function refusalDisambiguation(base, evidence, reasoning) {
  return {
    disposition: 'insufficient_evidence', record_kind: 'insufficient_evidence', active_delta: 0,
    verdict: { ...base, verdict: 'insufficient_evidence', witnesses: [],
      insufficient_because: firstNChars(reasoning, 240), requested_artifact: REFUSAL_ARTIFACT, reasoning },
  };
}

/**
 * The safe non-verdict a packet is routed to when a model call errored/timed out/returned
 * unparseable JSON. Never promotes: referent_search -> search_inconclusive; classification /
 * disambiguation -> insufficient_evidence. The claim survives (non-terminal), the run does not
 * abort, and the failure is recorded in the metrics ledger (outcome=error/timeout).
 */
export function safeNonVerdict({ packet, evidence, adjudicator, adjudicatorFamily, reason, confidence = 0 }) {
  const base = { adjudicator, adjudicator_family: adjudicatorFamily, claim_type: packet.claim_type, queue_entry_digest: packet.queue_entry_digest, confidence: clamp01(confidence) };
  if (packet.claim_type === 'referent_search') return refusalReferent(base, evidence, reason);
  if (packet.claim_type === 'entity_classification') return refusalClassification(base, evidence, reason);
  return refusalDisambiguation(base, evidence, reason);
}

/** Bucket a raw pi outcome string into the ledger's coarse class: ok | error | timeout. */
export function classifyOutcome(outcome) {
  const s = String(outcome || '');
  if (/timeout/i.test(s)) return 'timeout';
  if (s === 'ok') return 'ok';
  if (/no_answer|unparseable|error|exit_|spawn_error/i.test(s)) return 'error';
  return 'ok';
}

function dedupeFamilies(negativeVerifiers) {
  return (negativeVerifiers || []).map(v => ({ adjudicator: v.model, family: v.family }));
}
function clamp01(x) { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7; }
function firstNChars(s, n) { s = String(s || ''); return s.length <= n ? s : s.slice(0, n); }

// ===========================================================================
// CAMPAIGN CONTRACT (G0 binding)
// ===========================================================================

/**
 * Build the immutable G0 campaign contract. campaign_id is content-addressed over the G0 core
 * (audit/cost excluded), so an identical snapshot yields an identical campaign_id.
 */
export function buildCampaignContract({ subjectSourceSha, generatorSha, graphDigest, corpusManifestDigest, packetIds, mode = 'closed_campaign', limits = {}, generatedAt = '1970-01-01T00:00:00Z', proposer = PROPOSER_MODEL, ratifier = RATIFIER_MODEL, verifierRoles = VERIFIER_ROLES }) {
  const g0core = {
    subject_source_sha: subjectSourceSha,
    generator_sha: generatorSha,
    graph_digest: graphDigest,
    corpus_manifest_digest: corpusManifestDigest,
    subject_universe: { n: packetIds.length, packet_ids: [...packetIds].sort() },
  };
  const campaignId = `campaign:${sha256(stableStringify(g0core))}`;
  const semantic = {
    campaign_schema: CAMPAIGN_SCHEMA_VERSION,
    campaign_id: campaignId,
    mode,
    snapshot_binding: {
      subject_source_sha: subjectSourceSha,
      generator_sha: generatorSha,
      graph_digest: graphDigest,
      corpus_manifest_digest: corpusManifestDigest,
    },
    subject_universe: g0core.subject_universe,
    predicate_contract: {
      family: 'estate-map/l1-claim-types@1',
      allowed: ['referent_search', 'entity_classification', 'disambiguation'],
      canonical_negation: 'negateProposition@1',
    },
    verification_policy: {
      proposer,
      ratifier,
      verifiers: verifierRoles.map(r => ({ direction: r.direction, model: r.model, family: r.family })),
      blinded: true,
      combiner: COMBINER_TRUTH_TABLE_VERSION,
      ratification_required_for: 'supported',
    },
    limits: {
      max_candidate_keys: limits.max_candidate_keys ?? packetIds.length,
      max_candidates_per_queue_entry: limits.max_candidates_per_queue_entry ?? 1,
      max_open_verification_bundles: limits.max_open_verification_bundles ?? 8,
      max_action_keys_per_candidate: limits.max_action_keys_per_candidate ?? 16,
      max_scope_extensions: limits.max_scope_extensions ?? 0,
    },
    verifier_capacity_per_candidate: 4,
    invariants: CAMPAIGN_INVARIANTS,
  };
  const record = createRecord('campaign_contract', semantic, { generated_at: generatedAt, generator_source: 'tools/estate-map/campaign.mjs' });
  return { record, campaignId, g0: g0core };
}

// ===========================================================================
// RECEIPT RECORD BUILDERS (all canonical `estate-map/adjudication-record/v1`)
// ===========================================================================

export function buildNormalizedPropositionRecord({ campaignId, packet, proposition, proposerPick, audit }) {
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, queue_entry_digest: packet.queue_entry_digest,
    claim_type: packet.claim_type, produced_by_role: 'proposer',
    proposition: { subject: proposition.subject, predicate: proposition.predicate, polarity: proposition.polarity, text: proposition.text },
    canonical_negation: negateProposition(proposition),
    proposer_choice: { exists: proposerPick?.exists ?? null, target_cluster: proposerPick?.target_cluster ?? null, behaviour_witness_index: Number.isInteger(proposerPick?.behaviour_witness_index) ? proposerPick.behaviour_witness_index : null },
  };
  // The proposer rationale is QUARANTINED into audit (excluded from the semantic hash and never
  // passed to any verifier).
  return createRecord('normalized_proposition', semantic, { ...audit, quarantined_rationale: firstNChars(proposerPick?.rationale || '', 2000) });
}

export function buildClaimCandidateRecord({ campaignId, packet, propositionId, verifierCapacityReserved }) {
  if (verifierCapacityReserved !== 4) throw new Error('claim_candidate requires exactly 4 reserved verifier slots (VCEC finite-capacity contract)');
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, normalized_proposition_id: propositionId,
    queue_entry_digest: packet.queue_entry_digest, claim_type: packet.claim_type,
    verifier_capacity_reserved: verifierCapacityReserved, ratifier_reserved: true,
  };
  return createRecord('claim_candidate', semantic, {});
}

export function buildSideVerificationRecord({ campaignId, packet, propositionId, direction, verifier, corpusManifestDigest, audit }) {
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, normalized_proposition_id: propositionId,
    direction, family: verifier.family, model: verifier.model,
    stance: verifier.stance, witness_index: Number.isInteger(verifier.witness_index) ? verifier.witness_index : null,
    confidence: clamp01(verifier.confidence), corpus_manifest_digest: corpusManifestDigest,
    reason: firstNChars(verifier.reason || '', 500),
  };
  return createRecord('side_verification_receipt', semantic, audit);
}

export function buildVerificationAggregateRecord({ campaignId, packet, propositionId, aggregate, receiptIds }) {
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, normalized_proposition_id: propositionId,
    combine_state: aggregate.state, p_affirms: aggregate.p_affirms, n_affirms: aggregate.n_affirms,
    truth_table_version: aggregate.truth_table_version, input_receipt_ids: [...receiptIds].sort(), produced_by: 'pure-code-combiner',
  };
  return createRecord('verification_aggregate', semantic, {});
}

export function buildRatificationRecord({ campaignId, packet, aggregateId, ratified, downgradedTo, audit }) {
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, aggregate_id: aggregateId,
    ratifier_role: 'ratifier', ratified: Boolean(ratified), downgraded_to: downgradedTo ?? null,
  };
  return createRecord('ratification_receipt', semantic, audit);
}

export function buildResolutionRecord({ campaignId, packet, propositionId, outcome, aggregate, ratified, audit }) {
  const semantic = {
    campaign_id: campaignId, packet_id: packet.__packet_record_id, queue_entry_digest: packet.queue_entry_digest,
    claim_type: packet.claim_type, disposition: outcome.disposition, verdict_record_kind: outcome.record_kind,
    grounded_in: (outcome.verdict.witnesses || []).map(w => ({ repo: w.repo, file: w.file, line: w.line })),
    combine_state: aggregate.state, ratified: Boolean(ratified), active_delta_expected: outcome.active_delta,
  };
  return createRecord('resolution_record', semantic, audit);
}

// ===========================================================================
// PACKET SELECTION — pick a spread that spans the completion standard.
// ===========================================================================

/**
 * Score packets by evidence strength and pick a spread of `count` that maximizes the chance of
 * hitting >=1 strong positive (found_as), >=1 weak referent (search_inconclusive), and >=1
 * classification/disambiguation refusal (insufficient_evidence). Deterministic given evidence.
 */
export function selectPackets(packetsWithEvidence, { count = 5 } = {}) {
  const referent = packetsWithEvidence.filter(p => p.packet.claim_type === 'referent_search');
  const other = packetsWithEvidence.filter(p => p.packet.claim_type !== 'referent_search');
  const strength = p => p.evidence.hit_count + (p.evidence.clusters.length ? 2 : 0);
  const strongRef = [...referent].sort((a, b) => strength(b) - strength(a));
  const weakRef = [...referent].sort((a, b) => strength(a) - strength(b));
  const picked = [];
  const add = p => { if (p && !picked.includes(p)) picked.push(p); };
  // 2 strongest referents (positive candidates), 1 weakest referent (inconclusive candidate),
  // then classification/disambiguation refusal candidates, then backfill.
  add(strongRef[0]); add(strongRef[1]);
  add(weakRef[0]);
  for (const p of other) { if (picked.length >= count) break; add(p); }
  for (const p of strongRef) { if (picked.length >= count) break; add(p); }
  return picked.slice(0, count);
}

// ===========================================================================
// JSONL HELPERS
// ===========================================================================
const canonicalJsonl = record => `${canonicalSerialize(record).replaceAll('\n', '')}\n`;

export async function readJsonl(file) {
  try { return (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function appendJsonlLine(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

// ===========================================================================
// THE CAMPAIGN ORCHESTRATOR
// ===========================================================================

/**
 * Run the full independent-verification campaign over a set of prepared candidate_packet
 * records. Emits canonical receipts, legacy verdicts, and an append-only metrics ledger.
 *
 * `callFn` defaults to the real pi-backed callModel; tests inject a fixture runner.
 */
export async function runCampaign({
  candidatePacketRecords, estateRoot, subjectSourceSha, generatorSha, graphDigest, corpusManifestDigest,
  select = 5, only = null, fullSet = false, callFn = null, grep = null, now = new Date().toISOString(), scratchDir = null,
  metricsLedgerPath = null, receiptsPath = null, verdictsPath = null, onModelCall = null, onBatch = null,
  proposerThinking = 'medium', ratifierThinking = 'medium',
  proposer = PROPOSER_MODEL, ratifier = RATIFIER_MODEL, verifierRoles = VERIFIER_ROLES,
  batchSize = 24, concurrency = 6, timeoutMs = 90000, maxAttempts = 1, resumeReceipts = null,
}) {
  if (!callFn && process.env.ALLOW_LEGACY_PAID_CAMPAIGN !== '1') throw new Error('legacy paid campaign is frozen; inject a zero-spend fixture or use the current durable-unit pipeline');
  // Fail-closed: no anthropic/* model may be invoked (incl. via a CLI roster override).
  assertRosterNoAnthropic([proposer, ratifier, ...verifierRoles.map(r => r.model)]);

  // Global concurrency gate: NEVER exceed the bound of live pi processes (this host also runs
  // the live :7900 server). Clamped to [1,8]; the live campaign runs 4-8.
  const limit = pLimit(Math.max(1, Math.min(8, concurrency)));
  // callFn (fixture) is passed to callModel as its low-level runner so BOTH the live and
  // fixture paths get identical normalization (latency_ms, usage, parsed json). Every call is
  // timeout-wrapped and gated by the semaphore.
  const call = (opts) => limit(() => callModel({ ...opts, runner: callFn, scratchDir, timeoutMs, maxAttempts }));
  const emitMetric = async (row) => {
    if (metricsLedgerPath) await appendJsonlLine(metricsLedgerPath, row);
    if (onModelCall) onModelCall(row);
  };

  // Hydrate the legacy packets from the canonical candidate_packet records.
  let packets = candidatePacketRecords
    .filter(r => r.record_kind === 'candidate_packet')
    .map(r => ({ ...r.semantic.packet, __packet_record_id: r.id }));
  if (only && only.length) packets = packets.filter(p => only.includes(p.queue_entry_digest) || only.includes(p.queue_entry?.canon_entity) || only.includes(p.queue_entry?.entity) || only.includes(p.queue_entry?.name));

  // Gather evidence ONCE per packet against the immutable snapshot (no mid-campaign rescan).
  const withEvidence = [];
  for (const packet of packets) withEvidence.push({ packet, evidence: await gatherEvidence({ estateRoot, packet, grep }) });
  // FULL-SET adjudicates every candidate_packet; --only keeps the explicit subset; otherwise a
  // deterministic spread is selected.
  const selected = (fullSet || (only && only.length)) ? withEvidence : selectPackets(withEvidence, { count: select });

  const contract = buildCampaignContract({
    subjectSourceSha, generatorSha, graphDigest, corpusManifestDigest,
    packetIds: selected.map(s => s.packet.__packet_record_id), generatedAt: now,
    proposer, ratifier, verifierRoles,
  });
  const campaignId = contract.campaignId;

  // RESUME-SKIP: a packet that already carries a resolution_record in the prior receipts is
  // done; a (re)start processes only the remainder (content-addressed by packet_id).
  const doneIds = new Set((resumeReceipts || []).filter(r => r.record_kind === 'resolution_record').map(r => r.semantic.packet_id));
  const pending = selected.filter(s => !doneIds.has(s.packet.__packet_record_id));
  // Dedup keys for incremental disk flush (the contract may already be on disk on resume).
  const knownReceiptIds = new Set((resumeReceipts || []).map(r => r.id));
  const knownVerdictKeys = new Set();

  const receipts = [contract.record];
  const verdicts = [];
  const claimRows = [];
  const totals = { promotions: 0, underdetermined: 0, negatives: 0, refusals: 0, conflicts: 0, errors: 0, timeouts: 0, skipped: doneIds.size, total_model_calls: 0, total_cost: 0 };

  if (receiptsPath) await appendReceiptsDedup(receiptsPath, [contract.record], knownReceiptIds);

  // One packet through the pipeline: proposer -> 4 blinded verifiers -> pure combiner ->
  // (ratifier if supported) -> mapped verdict + resolution receipt. Returns its receipts,
  // legacy verdict, claim row and tally; NEVER throws (a failed call routes to a safe
  // non-verdict). Called concurrently within a batch; the pi bound is held by `call`.
  const processPacket = async (packet, evidence) => {
    const packetTag = (packet.queue_entry?.canon_entity ?? packet.queue_entry?.entity ?? packet.queue_entry?.name ?? packet.queue_entry_digest.slice(0, 8)).toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const pReceipts = [];
    let modelCalls = 0;
    let cost = 0;
    const outcomes = [];
    const record = async (role, direction, res) => { modelCalls++; cost += res.usage.cost; outcomes.push(classifyOutcome(res.outcome)); await emitMetric(modelMetric({ campaignId, packet, role, direction, res })); };
    try {
      // 1. PROPOSER
      const proposerRes = await call({ model: proposer, prompt: buildProposerPrompt(packet, evidence), thinking: proposerThinking, tag: `${packetTag}.proposer` });
      await record('proposer', 'propose', proposerRes);
      const proposerPick = proposerRes.json || {};
      const proposition = normalizeProposition(packet, { proposerText: typeof proposerPick.proposition === 'string' ? proposerPick.proposition : null });
      const propRecord = buildNormalizedPropositionRecord({ campaignId, packet, proposition, proposerPick, audit: { generated_at: now, model: proposer, latency_ms: proposerRes.latency_ms, cost: proposerRes.usage.cost } });
      pReceipts.push(propRecord);
      pReceipts.push(buildClaimCandidateRecord({ campaignId, packet, propositionId: propRecord.id, verifierCapacityReserved: 4 }));

      // 2. FOUR BLINDED VERIFIERS
      const negP = negateProposition(proposition);
      const verifierResults = await Promise.all(verifierRoles.map(async (vr) => {
        const dirProp = vr.direction === 'support-P' ? proposition : negP;
        const res = await call({ model: vr.model, prompt: buildVerifierPrompt(dirProp, vr.direction, evidence), thinking: null, tag: `${packetTag}.${vr.direction}.${vr.family}` });
        const j = res.json || {};
        const stance = ['affirms', 'denies', 'inconclusive'].includes(j.stance) ? j.stance : 'inconclusive';
        return { vr, res, stance, witness_index: j.witness_index, confidence: j.confidence, reason: j.reason };
      }));
      for (const v of verifierResults) await record('verifier', v.vr.direction, v.res);

      pReceipts.push(...verifierResults.map(v => buildSideVerificationRecord({
        campaignId, packet, propositionId: propRecord.id, direction: v.vr.direction,
        verifier: { model: v.vr.model, family: v.vr.family, stance: v.stance, witness_index: v.witness_index, confidence: v.confidence, reason: v.reason },
        corpusManifestDigest, audit: { generated_at: now, model: v.vr.model, latency_ms: v.res.latency_ms, cost: v.res.usage.cost },
      })));
      const sideRecords = pReceipts.filter(r => r.record_kind === 'side_verification_receipt');

      // 3. PURE-CODE COMBINER
      const aggregate = combine({
        p: verifierResults.filter(v => v.vr.direction === 'support-P').map(v => v.stance),
        n: verifierResults.filter(v => v.vr.direction === 'support-not-P').map(v => v.stance),
      });
      const aggRecord = buildVerificationAggregateRecord({ campaignId, packet, propositionId: propRecord.id, aggregate, receiptIds: sideRecords.map(r => r.id) });
      pReceipts.push(aggRecord);

      // 4. RATIFIER (only for supported; may veto to underdetermined, never upgrade)
      let ratified = false;
      let downgradedTo = null;
      if (aggregate.state === 'supported') {
        const proposedVerdict = packet.claim_type === 'referent_search' ? `found_as cluster:${proposerPick.target_cluster}` : `${packet.claim_type} positive`;
        const ratRes = await call({ model: ratifier, prompt: buildRatifierPrompt(proposition, aggregate, evidence, proposedVerdict), thinking: ratifierThinking, tag: `${packetTag}.ratifier` });
        await record('ratifier', 'ratify', ratRes);
        ratified = (ratRes.json || {}).ratify === true;
        if (!ratified) downgradedTo = 'underdetermined';
        pReceipts.push(buildRatificationRecord({ campaignId, packet, aggregateId: aggRecord.id, ratified, downgradedTo, audit: { generated_at: now, model: ratifier, latency_ms: ratRes.latency_ms, cost: ratRes.usage.cost } }));
      }

      // 5. MAP TO VERDICT + RESOLUTION RECEIPT.
      // If ANY call errored/timed out/was unparseable, route to a SAFE non-verdict rather than
      // risk a promotion on incomplete evidence (never abort the run).
      const callOutcome = outcomes.includes('timeout') ? 'timeout' : outcomes.includes('error') ? 'error' : 'ok';
      const effectiveAggregate = ratified || aggregate.state !== 'supported' ? aggregate : { ...aggregate, state: 'underdetermined' };
      const negativeVerifiers = verifierResults.filter(v => v.vr.direction === 'support-not-P').map(v => ({ model: v.vr.model, family: v.vr.family, stance: v.stance, corpus_manifest_digest: corpusManifestDigest }));
      const adjudicator = `estate-map-campaign/${campaignId.slice(0, 20)} (ratifier ${ratifier})`;
      const outcome = callOutcome !== 'ok'
        ? safeNonVerdict({ packet, evidence, adjudicator, adjudicatorFamily: familyOf(ratifier), reason: `A model call failed (outcome=${callOutcome}); routed to a safe non-verdict rather than aborting the campaign. combine=${effectiveAggregate.state}`, confidence: 0 })
        : mapOutcomeToVerdict({ packet, aggregate: effectiveAggregate, ratified, proposerPick, evidence, corpusManifestDigest, negativeVerifiers, adjudicator, adjudicatorFamily: familyOf(ratifier) });
      pReceipts.push(buildResolutionRecord({ campaignId, packet, propositionId: propRecord.id, outcome, aggregate: effectiveAggregate, ratified, audit: { generated_at: now } }));

      const claimRow = {
        type: 'claim', campaign_id: campaignId, packet_id: packet.__packet_record_id, normalized_proposition_id: propRecord.id,
        queue_entry_digest: packet.queue_entry_digest, claim_type: packet.claim_type,
        combine_state: effectiveAggregate.state, ratified, record_kind_emitted: outcome.record_kind,
        disposition: outcome.disposition, active_delta: outcome.active_delta, call_outcome: callOutcome,
      };
      await emitMetric(claimRow);
      return { receipts: pReceipts, verdict: { ...outcome.verdict, claim_type: packet.claim_type, queue_entry_digest: packet.queue_entry_digest }, claimRow, modelCalls, cost, callOutcome };
    } catch (e) {
      // A defect in the deterministic core must not abort the whole run either: record the
      // packet as an error and route it to a safe non-verdict.
      const evidenceSafe = evidence || { queries: [], terms: [], hits: [] };
      const adjudicator = `estate-map-campaign/${campaignId.slice(0, 20)} (ratifier ${ratifier})`;
      const outcome = safeNonVerdict({ packet, evidence: evidenceSafe, adjudicator, adjudicatorFamily: familyOf(ratifier), reason: `Packet processing threw (${e.message}); routed to a safe non-verdict rather than aborting the campaign.`, confidence: 0 });
      const proposition = normalizeProposition(packet);
      const propRecord = buildNormalizedPropositionRecord({ campaignId, packet, proposition, proposerPick: {}, audit: { generated_at: now, model: proposer } });
      const resRecord = buildResolutionRecord({ campaignId, packet, propositionId: propRecord.id, outcome, aggregate: { state: 'underdetermined', p_affirms: 0, n_affirms: 0, truth_table_version: COMBINER_TRUTH_TABLE_VERSION }, ratified: false, audit: { generated_at: now } });
      const claimRow = {
        type: 'claim', campaign_id: campaignId, packet_id: packet.__packet_record_id, normalized_proposition_id: propRecord.id,
        queue_entry_digest: packet.queue_entry_digest, claim_type: packet.claim_type,
        combine_state: 'underdetermined', ratified: false, record_kind_emitted: outcome.record_kind,
        disposition: outcome.disposition, active_delta: outcome.active_delta, call_outcome: 'error',
      };
      await emitMetric(claimRow);
      return { receipts: [propRecord, resRecord], verdict: { ...outcome.verdict, claim_type: packet.claim_type, queue_entry_digest: packet.queue_entry_digest }, claimRow, modelCalls, cost, callOutcome: 'error' };
    }
  };

  // BATCHING: process `pending` in bounded batches. Between batches, flush receipts/verdicts
  // incrementally to disk AND surface a progress heartbeat so a caller can report_progress.
  const batches = chunk(pending, Math.max(1, batchSize));
  let processed = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const results = await Promise.all(batches[bi].map(({ packet, evidence }) => processPacket(packet, evidence)));
    const batchReceipts = [];
    const batchVerdicts = [];
    for (const r of results) {
      receipts.push(...r.receipts); batchReceipts.push(...r.receipts);
      verdicts.push(r.verdict); batchVerdicts.push(r.verdict);
      claimRows.push(r.claimRow);
      totals.total_model_calls += r.modelCalls; totals.total_cost += r.cost;
      const d = r.claimRow.disposition;
      if (['found_as', 'resolved_to', 'irreducible', 'not_an_entity', 'domain_entity'].includes(d)) totals.promotions++;
      else if (d === 'search_inconclusive') totals.underdetermined++;
      else if (d === 'absent') totals.negatives++;
      else if (d === 'insufficient_evidence') totals.refusals++;
      if (r.claimRow.combine_state === 'conflict') totals.conflicts++;
      if (r.callOutcome === 'error') totals.errors++;
      else if (r.callOutcome === 'timeout') totals.timeouts++;
    }
    if (receiptsPath) await appendReceiptsDedup(receiptsPath, batchReceipts, knownReceiptIds);
    if (verdictsPath) await appendVerdictsDedup(verdictsPath, batchVerdicts, knownVerdictKeys);
    processed += batches[bi].length;
    const progress = {
      type: 'batch_progress', campaign_id: campaignId, batch: bi + 1, batches: batches.length,
      processed, pending: pending.length, skipped: doneIds.size, total: selected.length,
      promotions: totals.promotions, underdetermined: totals.underdetermined, negatives: totals.negatives,
      refusals: totals.refusals, conflicts: totals.conflicts, errors: totals.errors, timeouts: totals.timeouts,
      model_calls: totals.total_model_calls, cost: Number(totals.total_cost.toFixed(6)),
    };
    if (metricsLedgerPath) await appendJsonlLine(metricsLedgerPath, progress);
    if (onBatch) await onBatch(progress);
  }

  validateRecordList(receipts);

  const campaignTotal = {
    type: 'campaign_total', campaign_id: campaignId, contract_id: contract.record.id,
    contract_digest: semanticHash(contract.record.semantic), packet_count: selected.length,
    processed_this_run: pending.length, skipped: doneIds.size,
    promotions: totals.promotions, underdetermined: totals.underdetermined, negatives: totals.negatives,
    refusals: totals.refusals, conflicts: totals.conflicts, errors: totals.errors, timeouts: totals.timeouts,
    total_model_calls: totals.total_model_calls, total_cost: Number(totals.total_cost.toFixed(6)),
  };
  if (metricsLedgerPath) await appendJsonlLine(metricsLedgerPath, campaignTotal);

  return { campaignId, contract: contract.record, receipts, verdicts, claimRows, totals: campaignTotal, selected: selected.map(s => ({ packet_id: s.packet.__packet_record_id, claim_type: s.packet.claim_type, subject: s.evidence.subject, hit_count: s.evidence.hit_count })) };
}

// Minimal promise-pool: caps concurrent executions at n. Guarantees the live pi-process bound.
export function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(
      v => { active--; resolve(v); next(); },
      e => { active--; reject(e); next(); },
    );
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function appendReceiptsDedup(file, records, knownIds) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fresh = records.filter(r => { if (knownIds.has(r.id)) return false; knownIds.add(r.id); return true; });
  if (fresh.length) await fsp.appendFile(file, fresh.map(canonicalJsonl).join(''), 'utf8');
}

async function appendVerdictsDedup(file, verdictRows, knownKeys) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fresh = verdictRows.filter(v => { const k = v.queue_entry_digest; if (knownKeys.has(k)) return false; knownKeys.add(k); return true; });
  if (fresh.length) await fsp.appendFile(file, fresh.map(v => JSON.stringify(v)).join('\n') + '\n', 'utf8');
}

function modelMetric({ campaignId, packet, role, direction, res }) {
  return {
    type: 'model_call', campaign_id: campaignId, packet_id: packet.__packet_record_id, role, direction,
    model: res.model, family: res.family, thinking: res.thinking,
    input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens,
    cost_estimate: res.usage.cost, latency_ms: res.latency_ms, outcome: res.outcome, attempts: res.attempts || 1,
  };
}

export async function writeReceipts(file, receipts) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, receipts.map(canonicalJsonl).join(''), 'utf8');
  return file;
}
export async function writeVerdicts(file, verdicts) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, verdicts.map(v => JSON.stringify(v)).join('\n') + '\n', 'utf8');
  return file;
}

// ===========================================================================
// RECONCILE — bridge accepted verdicts onto the ACTIVE queue via the LANDED reducer machinery,
// then check the CENSUS/ACTIVE conservation law. Uses the landed functions; reimplements none.
// ===========================================================================
export async function reconcileActive({ stateDir, censusVector, corpusDigest, now = new Date().toISOString() }) {
  const { reconciliationEdgePlans, LEDGER_FILE } = await import('./l1-adjudicate.mjs');
  const { appendReconciliationEdges, readReconciliationEdges, projectActiveVector } = await import('./reconciliation-edges.mjs');
  const ledger = await readJsonl(path.join(stateDir, LEDGER_FILE));
  const detail = reconciliationEdgePlans(ledger, corpusDigest);
  await appendReconciliationEdges(stateDir, detail.plans, { now });
  const edges = await readReconciliationEdges(stateDir);
  const projection = projectActiveVector(censusVector, edges, corpusDigest);
  // Conservation law: CENSUS is never mutated; ACTIVE = CENSUS minus accounted resolved drains.
  const drainByQueue = {};
  for (const d of projection.drained) drainByQueue[d.queue] = (drainByQueue[d.queue] || 0) + 1;
  const conservation = { passed: true, checks: [] };
  for (const q of Object.keys(projection.census)) {
    const census = projection.census[q];
    const active = projection.active[q];
    const drained = drainByQueue[q] || 0;
    const ok = census === active + drained;
    conservation.checks.push({ queue: q, census, active, drained, ok });
    if (!ok) conservation.passed = false;
  }
  if (!deepEqual(projection.census, censusVector)) conservation.passed = false;
  return { detail, projection, conservation, ledger_rows: ledger.length, edges: edges.length };
}

function deepEqual(a, b) { return stableStringify(a) === stableStringify(b); }

// ===========================================================================
// CLI
// ===========================================================================
async function readWorkDirDigests(workDir) {
  const annotated = path.join(workDir, 'graph', 'estate-graph.annotated.json');
  let graphDigest = null;
  try { graphDigest = sha256(await fsp.readFile(annotated)); } catch { /* fall through */ }
  let corpusManifestDigest = null;
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(workDir, 'extract', '_MANIFEST.json'), 'utf8'));
    corpusManifestDigest = manifest?.scanned_manifest?.corpus_manifest_digest || null;
  } catch { /* fall through */ }
  return { graphDigest, corpusManifestDigest };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (options.help || !cmd) {
    console.log(`Usage:
  node tools/estate-map/campaign.mjs run --packets <candidate-packets.jsonl> --work <driver-work-dir> --estate <root> \\
       --out <receipts.jsonl> --verdicts <verdicts.jsonl> --metrics <metrics.jsonl> \\
       [--select N|all] [--only a,b] [--batch-size N] [--concurrency 4-8] [--timeout-ms N] \\
       [--proposer M] [--verifier-a M] [--verifier-b M] [--ratifier M] [--now <iso>] [--scratch <dir>]
  node tools/estate-map/campaign.mjs reconcile --state <l1-state-dir> --census <census-vector.json> --corpus-digest <digest> [--now <iso>]

run        LEGACY paid campaign, frozen by default. Requires explicit ALLOW_LEGACY_PAID_CAMPAIGN=1.
           --select all adjudicates EVERY candidate_packet in bounded batches (heartbeat per
           batch, receipts flushed incrementally). Re-running with the same --out RESUMES
           (skips already-receipted packets). Every pi call is timeout-wrapped; concurrency is
           held to [1,8] live pi processes. Roster flags override the constants; NO anthropic/*.
reconcile  Fold accepted verdicts onto ACTIVE via the landed reducer and print the conservation law.`);
    process.exit(options.help ? 0 : 1);
  }
  if (cmd === 'run') {
    if (process.env.ALLOW_LEGACY_PAID_CAMPAIGN !== '1') throw new Error('legacy paid campaign is frozen; current paid work must use durable per-unit custody (set ALLOW_LEGACY_PAID_CAMPAIGN=1 only for explicit historical reproduction)');
    const estateRoot = path.resolve(options.estate || process.cwd());
    const workDir = path.resolve(options.work);
    const records = await readJsonl(path.resolve(options.packets));
    const { graphDigest, corpusManifestDigest } = await readWorkDirDigests(workDir);
    const subjectSourceSha = options.sha || (await execFileAsync('git', ['-C', estateRoot, 'rev-parse', 'HEAD']).then(r => r.stdout.trim(), () => 'working-tree'));
    const generatorSha = sha256(await fsp.readFile(fileURLToPath(import.meta.url)));
    const receiptsPath = options.out ? path.resolve(options.out) : null;
    const verdictsPath = options.verdicts ? path.resolve(options.verdicts) : null;
    const fullSet = options.select === 'all' || options.select === 'full';
    // RESUME: existing receipts on the --out path skip already-receipted packets.
    const resumeReceipts = receiptsPath ? await readJsonl(receiptsPath) : [];
    const verifierRoles = buildVerifierRoles(options['verifier-a'] || VERIFIER_FAMILY_A, options['verifier-b'] || VERIFIER_FAMILY_B);
    const result = await runCampaign({
      candidatePacketRecords: records, estateRoot, subjectSourceSha, generatorSha, graphDigest, corpusManifestDigest,
      select: (options.select && !fullSet) ? Number(options.select) : 5, fullSet,
      only: options.only ? String(options.only).split(',').map(s => s.trim()) : null,
      now: options.now, scratchDir: options.scratch ? path.resolve(options.scratch) : null,
      metricsLedgerPath: options.metrics ? path.resolve(options.metrics) : null,
      receiptsPath, verdictsPath,
      proposer: options.proposer || PROPOSER_MODEL, ratifier: options.ratifier || RATIFIER_MODEL, verifierRoles,
      batchSize: options['batch-size'] ? Number(options['batch-size']) : 24,
      concurrency: options.concurrency ? Number(options.concurrency) : 6,
      timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : 90000,
      maxAttempts: 1,
      resumeReceipts,
      onBatch: (p) => console.log(`[batch ${p.batch}/${p.batches}] processed=${p.processed}/${p.pending} skipped=${p.skipped} total=${p.total} · promotions=${p.promotions} underdet=${p.underdetermined} refusals=${p.refusals} absent=${p.negatives} conflicts=${p.conflicts} err=${p.errors} timeout=${p.timeouts} · calls=${p.model_calls} cost=$${p.cost}`),
    });
    console.log(stableStringify({ campaign_id: result.campaignId, ...result.totals, selected_count: result.selected.length, receipts: result.receipts.length, verdicts: result.verdicts.length }).trim());
    process.exit(0);
  }
  if (cmd === 'reconcile') {
    const stateDir = path.resolve(options.state);
    const censusRaw = JSON.parse(await fsp.readFile(path.resolve(options.census), 'utf8'));
    const censusVector = censusRaw.vector || censusRaw;
    const corpusDigest = options['corpus-digest'] || censusRaw.corpus_digest;
    const result = await reconcileActive({ stateDir, censusVector, corpusDigest, now: options.now });
    console.log(stableStringify({
      CENSUS: result.projection.census, ACTIVE: result.projection.active,
      drains: result.projection.drained, conservation: result.conservation,
      ledger_rows: result.ledger_rows, edges: result.edges,
    }).trim());
    process.exit(result.conservation.passed ? 0 : 2);
  }
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}
