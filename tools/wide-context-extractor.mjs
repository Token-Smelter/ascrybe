#!/usr/bin/env node
// Wide-context extraction driver: deterministic windows -> concurrent custodied units -> claims v3.1.
//
// This is the scale path. It has no planning stage, no recursion, and no model in segmentation.
// Every paid unit goes through the leased queue (per-unit quarantine, rate-based fleet stop) and the
// custody layer (durable attempt/materialization receipts, bounded dispatch, unpriced accounting).
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from './custodied-inference.mjs';
import { createPiRpcRunner, PI_RPC_RUNNER_IMPLEMENTATION } from './neural-model-runner.mjs';
import { parseModelJsonStream } from './neural-json.mjs';
import { flatLineContractLines, parseFlatRelationAnswer } from './flat-relation-lines.mjs';
import { assertPreflight, applyOutputCap } from './outcome-algebra.mjs';
import { createUnitQueue, runQueue } from './unit-queue.mjs';
import {
  buildClaimV32, claimQualityMetricsV32, countProposedLocators, markupNormalized, reduceClaimsV32,
} from './claim-v32.mjs';
import { buildClaimV33, claimQualityMetricsV33, reduceClaimsV33 } from './claim-v33.mjs';
import {
  buildMentionNamespace, buildWindowSubjectOccurrences, prepassDocument, renderMentionMenu,
  renderSubjectOccurrenceMenu,
} from './source-prepass.mjs';
import {
  createWindowBlockCatalog, renderBlockCatalog, repairWhitespaceEquivalentSourceLocator,
  resolveSourceLocator,
} from './source-locator.mjs';
import { segmentCorpus } from './wide-context-windows.mjs';
import { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';
import {
  MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
  MATERIALIZATION_LEDGER_SCHEMA,
  assertAttemptCapacity,
  normalizeAttemptPolicy,
} from './materialization-ledger.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { installGracefulStop } from './graceful-stop.mjs';

const execFileAsync = promisify(execFile);
export const WIDE_CONTEXT_SCHEMA = 'estate-map/wide-context-extraction/v2';
// @3 replaces model-authored coordinates with exact quote-within-block locators and claim v3.2.
// The key bump prevents any @1/@2 completion from replaying under the new addressing contract.
export const EXTRACTOR_VERSION = 'wide-context-extractor@10';
export const PROVIDER_REPAIR_EXTRACTOR_VERSION = 'wide-context-extractor@11-provider-repair';
export const SEMANTIC_REPAIR_EXTRACTOR_VERSION = 'wide-context-extractor@12-semantic-ownership';
export const SEMANTIC_REPAIR_V2_EXTRACTOR_VERSION = 'wide-context-extractor@13-semantic-ownership-v2';
export const ROLE_OWNERSHIP_EXTRACTOR_VERSION = 'wide-context-extractor@14-role-ownership';
export const PRECISE_ROLE_OWNERSHIP_EXTRACTOR_VERSION = 'wide-context-extractor@15-precise-role-ownership';
export const EXACT_UNIQUE_GROUNDING_EXTRACTOR_VERSION = 'wide-context-extractor@16-exact-unique-grounding';
export const RECOVERED_ROLE_OWNERSHIP_EXTRACTOR_VERSION = 'wide-context-extractor@17-recovered-role-ownership';
export const RECOVERED_SEMANTIC_COMPLETENESS_EXTRACTOR_VERSION = 'wide-context-extractor@18-recovered-semantic-completeness';
export const RECOVERED_ACTIVE_HEADING_EXTRACTOR_VERSION = 'wide-context-extractor@19-recovered-active-heading';
export const RECOVERED_CAUSATIVE_HEADING_EXTRACTOR_VERSION = 'wide-context-extractor@20-recovered-causative-heading';
export const V20_PROVIDER_REPAIR_EXTRACTOR_VERSION = 'wide-context-extractor@21-v20-provider-repair';
export const RECOVERED_IMPLICIT_TOPIC_QUOTE_EXTRACTOR_VERSION = 'wide-context-extractor@22-recovered-implicit-topic-quote';
export const RECOVERED_IMPLICIT_TOPIC_ACTOR_EXTRACTOR_VERSION = 'wide-context-extractor@23-recovered-implicit-topic-actor';
export const QUALIFIED_MEMBER_IDENTITY_EXTRACTOR_VERSION = 'wide-context-extractor@24-qualified-member-identity';
export const PROVIDER_OBSERVABILITY_EXTRACTOR_VERSION = 'wide-context-extractor@25-provider-observability';
export const MATERIALIZED_RETRY_EXTRACTOR_VERSION = 'wide-context-extractor@26-materialized-retry-ledger';
export const PROPOSITION_OBLIGATION_EXTRACTOR_VERSION = 'wide-context-extractor@28-proposition-obligation-audit';
export const EXTRACTOR_CONTRACTS = Object.freeze({
  v8: 'wide-context-extractor@8-control-on-hardened-runtime',
  v9: 'wide-context-extractor@9',
  v10: EXTRACTOR_VERSION,
  v11: PROVIDER_REPAIR_EXTRACTOR_VERSION,
  v12: SEMANTIC_REPAIR_EXTRACTOR_VERSION,
  v13: SEMANTIC_REPAIR_V2_EXTRACTOR_VERSION,
  v14: ROLE_OWNERSHIP_EXTRACTOR_VERSION,
  v15: PRECISE_ROLE_OWNERSHIP_EXTRACTOR_VERSION,
  v16: EXACT_UNIQUE_GROUNDING_EXTRACTOR_VERSION,
  v17: RECOVERED_ROLE_OWNERSHIP_EXTRACTOR_VERSION,
  v18: RECOVERED_SEMANTIC_COMPLETENESS_EXTRACTOR_VERSION,
  v19: RECOVERED_ACTIVE_HEADING_EXTRACTOR_VERSION,
  v20: RECOVERED_CAUSATIVE_HEADING_EXTRACTOR_VERSION,
  v21: V20_PROVIDER_REPAIR_EXTRACTOR_VERSION,
  v22: RECOVERED_IMPLICIT_TOPIC_QUOTE_EXTRACTOR_VERSION,
  v23: RECOVERED_IMPLICIT_TOPIC_ACTOR_EXTRACTOR_VERSION,
  v24: QUALIFIED_MEMBER_IDENTITY_EXTRACTOR_VERSION,
  v25: PROVIDER_OBSERVABILITY_EXTRACTOR_VERSION,
  v26: MATERIALIZED_RETRY_EXTRACTOR_VERSION,
  v28: PROPOSITION_OBLIGATION_EXTRACTOR_VERSION,
});
export const EXTRACTOR_RUNTIME_VERSION = 'wide-context-runtime@12-observable-lifecycle';
export const MATERIALIZATION_RUNTIME_VERSION = 'wide-context-runtime@13-materialized-attempt-ledger';
const canonical = value => stableStringify(value).trim();

export function classifyWideContextResultStatus({
  paused = false, unpricedAttempts = 0, queue = null, truncated = false, overflow = false,
} = {}) {
  // Lifecycle comes first: a cooperatively stopped run with pending work is resumable even when
  // an already-recorded quarantine means the eventual terminal result cannot be `complete`.
  if (paused) return 'paused';
  return Number(unpricedAttempts || 0) || Number(queue?.by_state?.quarantined || 0)
    || Number(queue?.by_state?.acceptance_unknown || 0) || queue?.stopped || truncated || overflow
    ? 'incomplete' : 'complete';
}

function normalizeContract(value = 'v10') {
  const contract = String(value || 'v10').toLowerCase();
  if (!Object.hasOwn(EXTRACTOR_CONTRACTS, contract)) {
    throw new WideContextError('UNKNOWN_EXTRACTION_CONTRACT', `unknown extraction contract ${value}`);
  }
  return contract;
}

export class WideContextError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'WideContextError';
    this.code = code;
    this.detail = detail;
  }
}

// Frozen failed-gate treatment. Keeping its exact model-visible bytes selectable makes the @9
// result reproducible while @10 repairs the diagnosed binding distinctions below.
export function buildWindowPromptV9({ window, catalog, subjectMenu, max_claims }) {
  return [
    'You extract documentary claims from exact source evidence.',
    `Unit: ${window.id}. File: ${window.file}.`,
    'Authority: source excerpts > interpreted claim > model prose.',
    `Aim for at most ${max_claims} claims.`,
    '',
    ...flatLineContractLines({ canonicalRef: true, outcomeValues: 'extracted', subjectBinding: true }),
    'canonical_ref uses component|protocol|schema|state|command|record|concept|entity:<id> and is',
    'included ONLY when the source itself establishes that identifier; otherwise omit the field.',
    'One dropped bracket costs one claim, not the whole window, so never batch claims into an array.',
    '',
    'ADDRESSING RULE: never author file/line/byte coordinates. Select a block token and copy an exact',
    'quote byte-for-byte. Quotes shorter than 24 characters MUST include exact adjacent context_before,',
    'context_after, or a 1-based occurrence. If a quote repeats, add context or occurrence. Do not',
    'paraphrase, normalize case, repair a near match, or cite a block token not shown below.',
    '',
    'SUBJECT BINDING RULE: every rel line declares subject_binding. For "explicit", subject_occurrence',
    'is REQUIRED and must be one sNNN selector copied from PROMPT-LOCAL SUBJECT OCCURRENCES. The tool',
    'supplies its exact surface and locator; do not also invent a different subject. If no selector fits,',
    'use "anaphoric", "implicit_topic", or "unresolved" with an exact subject_block/subject_quote.',
    'For "anaphoric", subject_quote is the exact pronoun/description and antecedent_block plus',
    'antecedent_quote are REQUIRED; subject must occur in the antecedent quote. For "implicit_topic",',
    'cite the exact governing heading/table/topic. "unresolved" retains an exact literal mention but',
    'asserts no resolved identity. Only set canonical_ref when source itself defines that identifier.',
    '',
    'EVIDENCE RULE: every claim must cite at least one PRIMARY evidence line. A "context" evidence line',
    'may supplement but can never solely ground a claim. Emit an evidence line only when removing it',
    'would leave the claim unsupported.',
    'Select one controlled family value and use predicate/object for the verbatim local relation.',
    'A claim is itself a local documentary relation: use predicate/object for relations',
    'explicitly stated in this evidence frame. Do not invent cross-section or cross-document synthesis.',
    '',
    'PROMPT-LOCAL SUBJECT OCCURRENCES (each sNNN is already bound to exact source bytes):',
    subjectMenu || '<none>',
    '',
    'TOKENIZED SOURCE BLOCKS (PRIMARY may ground; CONTEXT is interpretive support only):',
    renderBlockCatalog(catalog),
  ].join('\n');
}

export function buildWindowPrompt({ window, catalog, subjectMenu, max_claims }) {
  return [
    'You extract documentary claims from exact source evidence.',
    `Unit: ${window.id}. File: ${window.file}.`,
    'Authority: source excerpts > interpreted claim > model prose.',
    `Aim for at most ${max_claims} claims.`,
    '',
    ...flatLineContractLines({ canonicalRef: true, outcomeValues: 'extracted', subjectBinding: true }),
    'canonical_ref uses component|protocol|schema|state|command|record|concept|entity:<id> and is',
    'included ONLY when the source itself establishes that identifier; otherwise omit the field.',
    'One dropped bracket costs one claim, not the whole window, so never batch claims into an array.',
    '',
    'ADDRESSING RULE: never author file/line/byte coordinates. Select a block token and copy an exact',
    'quote byte-for-byte. Quotes shorter than 24 characters MUST include exact adjacent context_before,',
    'context_after, or a 1-based occurrence. If a quote repeats, add context or occurrence. Do not',
    'paraphrase, normalize case, repair a near match, or cite a block token not shown below.',
    '',
    'SUBJECT BINDING RULE: bind the entity or field that is grammatically described by the evidence,',
    'not a relation keyword merely present in it. For example, under an id field whose pattern is X,',
    'the subject is id and the predicate is has pattern; pattern does not constrain id by itself. Skip',
    'the relation when the parent or hierarchy needed to establish it is absent from the evidence.',
    'Use "explicit" when that subject occurs literally in the relation sentence or structured field',
    'being described. subject_occurrence is then REQUIRED and must be one sNNN selector copied from',
    'PROMPT-LOCAL SUBJECT OCCURRENCES. A heading or container that governs a different evidence block',
    'is "implicit_topic", even when it has an sNNN selector. Do not label a literal grammatical subject',
    '"implicit_topic" or "unresolved" merely because it lacks a global identifier.',
    'If no selector fits, use "anaphoric", "implicit_topic", or "unresolved" with an exact',
    'subject_block/subject_quote. For "anaphoric", subject_quote is the exact pronoun/description and',
    'antecedent_block plus antecedent_quote are REQUIRED; subject must occur in the antecedent quote.',
    'For "implicit_topic", cite the exact governing heading/table/topic. Use "unresolved" only when',
    'an exact literal mention is present but its referent cannot be determined from the supplied source.',
    'Only set canonical_ref when source itself defines that identifier.',
    '',
    'EVIDENCE RULE: every claim must cite at least one PRIMARY evidence line. A "context" evidence line',
    'may supplement but can never solely ground a claim. Emit an evidence line only when removing it',
    'would leave the claim unsupported.',
    'Select one controlled family value and use predicate/object for the verbatim local relation.',
    'A claim is itself a local documentary relation: use predicate/object for relations',
    'explicitly stated in this evidence frame. Do not invent cross-section or cross-document synthesis.',
    '',
    'PROMPT-LOCAL SUBJECT OCCURRENCES (each sNNN is already bound to exact source bytes):',
    subjectMenu || '<none>',
    '',
    'TOKENIZED SOURCE BLOCKS (PRIMARY may ground; CONTEXT is interpretive support only):',
    renderBlockCatalog(catalog),
  ].join('\n');
}

// @12 keeps the exact-address contract and adds the ownership distinctions exposed by the blinded
// @10 tranche. @10/@11 remain byte-frozen and selectable for replay.
export function buildWindowPromptV12({ window, catalog, subjectMenu, max_claims }) {
  return [
    'You extract documentary claims from exact source evidence.',
    `Unit: ${window.id}. File: ${window.file}.`,
    'Authority: source excerpts > interpreted claim > model prose.',
    `Aim for at most ${max_claims} claims.`,
    '',
    ...flatLineContractLines({ canonicalRef: true, outcomeValues: 'extracted', subjectBinding: true }),
    'canonical_ref uses component|protocol|schema|state|command|record|concept|entity:<id> and is',
    'included ONLY when the source itself establishes that identifier; otherwise omit the field.',
    'One dropped bracket costs one claim, not the whole window, so never batch claims into an array.',
    '',
    'ADDRESSING RULE: never author file/line/byte coordinates. Select a block token and copy an exact',
    'quote byte-for-byte. Quotes shorter than 24 characters MUST include exact adjacent context_before,',
    'context_after, or a 1-based occurrence. If a quote repeats, add context or occurrence. Do not',
    'paraphrase, normalize case, repair a near match, or cite a block token not shown below.',
    '',
    'SUBJECT BINDING RULE: bind the entity or field that is grammatically described by the evidence,',
    'not a relation keyword merely present in it. Under an id field whose pattern is X, the subject is',
    'id and the predicate is has pattern. Skip a relation when its owner or hierarchy is absent.',
    'Use "explicit" when that subject occurs literally in the relation sentence or structured field.',
    'subject_occurrence is then REQUIRED and must be one sNNN selector from PROMPT-LOCAL SUBJECT',
    'OCCURRENCES. A heading governing a different evidence block is "implicit_topic". Do not label a',
    'literal grammatical subject "implicit_topic" or "unresolved" merely because it lacks a global id.',
    'Use "unresolved" only when a literal mention exists but its referent cannot be determined here.',
    'For "anaphoric", cite both the exact pronoun/description and its exact antecedent. Only set',
    'canonical_ref when the source itself defines that identifier.',
    '',
    'IDENTITY COMPLETENESS RULE: select the longest exact source surface that names the entity. Never',
    'shorten a path or qualified identifier to a basename, suffix, member, or other nested fragment',
    'when the longer identity occurs in the same sentence, cell, or structured value.',
    '',
    'TABLE AND DIAGRAM OWNERSHIP RULE: headings, row numbers, statuses, triggers, actions, and proof',
    'witnesses have different roles. A status label is not the entity it labels. A trigger/event does',
    'not perform an action stated in another cell. A heading is not the subject of a row whose cell',
    'names the actor. When one row lists multiple witnesses, never assign their aggregate description',
    'to a single witness; bind the row/group or emit only a one-to-one relation explicitly stated by',
    'the source. If ownership is not explicit, skip the claim.',
    '',
    'ENTAILMENT RULE: every agent, product name, priority, rank, exclusivity, and causal direction in',
    'predicate/object must be stated by the cited evidence. Do not infer a named implementation from',
    'generic behavior, turn a list item into a primary/preferred item, or reverse actor and action.',
    '',
    'EVIDENCE RULE: every claim must cite at least one PRIMARY evidence line. A "context" evidence line',
    'may supplement but can never solely ground a claim. Emit an evidence line only when removing it',
    'would leave the claim unsupported. Select one controlled family and use predicate/object for the',
    'verbatim local relation. Do not invent cross-section or cross-document synthesis.',
    '',
    'PROMPT-LOCAL SUBJECT OCCURRENCES (each sNNN is already bound to exact source bytes):',
    subjectMenu || '<none>',
    '',
    'TOKENIZED SOURCE BLOCKS (PRIMARY may ground; CONTEXT is interpretive support only):',
    renderBlockCatalog(catalog),
  ].join('\n');
}

// @13 preserves @12's ownership treatment while making the bounded selector namespace explicit.
// Its deterministic validator also ignores an out-of-menu selector on non-explicit bindings: such
// a selector carries no authority, while the exact heading/topic locator remains fail-closed.
export function buildWindowPromptV13(args) {
  return buildWindowPromptV12(args).replace(
    'Use "unresolved" only when a literal mention exists but its referent cannot be determined here.',
    'For "implicit_topic", "anaphoric", or "unresolved", OMIT subject_occurrence; selectors are only for explicit subjects. Never invent an sNNN value not shown below.\nUse "unresolved" only when a literal mention exists but its referent cannot be determined here.',
  );
}

export function buildWindowPromptV14(args) {
  return buildWindowPromptV13(args).replace(
    'ENTAILMENT RULE: every agent, product name, priority, rank, exclusivity, and causal direction in',
    'ROLE OWNERSHIP RULE: when evidence says A performs an action on B, bind A—not B, a section heading, or a citation path. A trigger/event may trigger an effect but does not perform the handler/controller action in another table cell. A path in a Witness/Evidence/Proof citation is evidence, not the actor that inherits the witnessed proposition. Deictic or status labels such as THIS and future are not entities. If the actor is not supported, skip the claim.\n\nENTAILMENT RULE: every agent, product name, priority, rank, exclusivity, and causal direction in',
  );
}

export function buildWindowPromptV15(args) {
  return buildWindowPromptV14(args).replace(
    'ROLE OWNERSHIP RULE: when evidence says A performs an action on B, bind A—not B, a section heading, or a citation path.',
    'ROLE OWNERSHIP RULE: when evidence says A performs an action on B, bind A—not B or a citation path. An implicit section/document topic is valid for anaphora, whole/part attributes, system policy, and explicit discourse predicates such as states/reports/defines. It is NOT the actor for a local actor’s operation: do not turn “the local agent checks X” into “the example checks X,” or “the gate demands X” into “the section makes the gate demand X.” Do not turn analysis, recommendations, proposed experiments, or future learning policy into current system behavior.',
  );
}

export function buildWindowPromptV16(args) {
  return buildWindowPromptV15(args).replace(
    'EVIDENCE RULE: every claim must cite at least one PRIMARY evidence line.',
    'EVIDENCE COMPLETENESS RULE: the cited evidence must itself contain the complete clause and every named condition, destination, or list item asserted by predicate/object. Never cite a fragment that ends mid-clause.\n\nEVIDENCE RULE: every claim must cite at least one PRIMARY evidence line.',
  );
}

export function buildWindowPromptV17(args) {
  return buildWindowPromptV16(args).replace(
    'EVIDENCE COMPLETENESS RULE:',
    'RECOVERED ROLE RULE: when a local sentence or table cell names the actor or patient, bind that literal actor explicitly; a procedure, document, diagram, API, state, or presentation heading does not inherit the local operation or cause it. Headings may still state/report/define content and own genuinely heading-scoped policy.\n\nEVIDENCE COMPLETENESS RULE:',
  );
}

export function buildWindowPromptV18(args) {
  return buildWindowPromptV17(args).replace(
    'EVIDENCE COMPLETENESS RULE:',
    'RECOVERED SEMANTIC COMPLETENESS RULE: preserve the full literal actor, including adjacent inline-code identifiers. Do not turn “X runs before Y” into “the section places X before Y.” A normative requirement, prohibition, permission, or exact-reuse constraint must appear in the cited evidence itself; descriptive existence or current behavior is insufficient.\n\nEVIDENCE COMPLETENESS RULE:',
  );
}

export function buildWindowPromptV19(args) {
  return buildWindowPromptV18(args).replace(
    'EVIDENCE COMPLETENESS RULE:',
    'RECOVERED ACTIVE-HEADING RULE: a heading may report, describe, or define its scoped content, but it does not thereby perform the content. If the evidence says a local entity is, owns, forms, accepts, or performs something, bind that entity; do not rewrite the heading as limiting, making, modeling, transitioning, updating, or assigning it. A detached trigger list does not support an “updates when” claim unless the cited evidence includes that governing clause.\n\nEVIDENCE COMPLETENESS RULE:',
  );
}

export function buildWindowPromptV20(args) {
  return buildWindowPromptV19(args).replace(
    'EVIDENCE COMPLETENESS RULE:',
    'RECOVERED CAUSATIVE-HEADING RULE: do not turn “X performs Y” into “the heading causes or forces X to perform Y.” Causation requires an exact causal statement in the cited evidence; a local actor performing the embedded action is not evidence that its heading caused the action.\n\nEVIDENCE COMPLETENESS RULE:',
  );
}

// Frozen model-visible @8 control. Operational custody, fleet circuits, accounting, and telemetry
// remain the same hardened runtime in both arms; only the extraction contract is the treatment.
export function buildWindowPromptV8({ window, catalog, mentionMenu, max_claims }) {
  return [
    'You extract documentary claims from exact source evidence.',
    `Unit: ${window.id}. File: ${window.file}.`,
    'Authority: source excerpts > interpreted claim > model prose.',
    `Aim for at most ${max_claims} claims.`,
    '',
    ...flatLineContractLines({ canonicalRef: true, outcomeValues: 'extracted' }),
    'canonical_ref uses component|protocol|schema|state|command|record|concept|entity:<id> and is',
    'included ONLY when the source itself establishes that identifier; otherwise omit the field.',
    'One dropped bracket costs one claim, not the whole window, so never batch claims into an array.',
    '',
    'ADDRESSING RULE: never author file/line/byte coordinates. Select a block token and copy an exact',
    'quote byte-for-byte. Quotes shorter than 24 characters MUST include exact adjacent context_before,',
    'context_after, or a 1-based occurrence. If a quote repeats, add context or occurrence. Do not',
    'paraphrase, normalize case, repair a near match, or cite a block token not shown below.',
    '',
    'SUBJECT RULE: always give subject_mention with exact source words and its own source locator. A subject',
    'that is an ordinary concept (a case, an attempt, a record) is perfectly valid — anchor it, do not',
    'invent an identifier. Only set canonical_ref when the source itself defines that identifier.',
    '',
    'EVIDENCE RULE: every claim must cite at least one PRIMARY evidence line. A "context" evidence line',
    'may supplement but can never solely ground a claim. Emit an evidence line only when removing it',
    'would leave the claim unsupported.',
    'A claim is itself a local documentary relation: use predicate_family/object_or_value for relations',
    'explicitly stated in this evidence frame. Do not invent cross-section or cross-document synthesis.',
    '',
    'GROUNDED SUBJECT CANDIDATES (select when one fits; otherwise use your own exact source words):',
    mentionMenu,
    '',
    'TOKENIZED SOURCE BLOCKS (PRIMARY may ground; CONTEXT is interpretive support only):',
    renderBlockCatalog(catalog),
  ].join('\n');
}

/**
 * A per-unit claim guidance figure that SCALES WITH THE UNIT.
 *
 * Calibration showed the model targets whatever number you state: told "at most 64", six windows
 * returned 57/61/58/65/26/73 regardless of whether the window held 8 KB or 48 KB. A flat cap is
 * therefore a density throttle that punishes wide context precisely because its units are larger
 * (1.57 claims/KB here vs 4.4 claims/KB for the pilot's small regions). Scale the ask with the
 * evidence, and keep a ceiling so a single answer still fits the answer-byte bound.
 */
export function claimBudgetForWindow(window, bounds) {
  const perKb = Number(bounds.claims_per_kb_target ?? 0);
  if (!perKb) return Number(bounds.max_claims_per_unit ?? 64);
  const kb = window.primary_bytes / 1024;
  const floor = Number(bounds.min_claims_per_unit ?? 32);
  const ceiling = Number(bounds.max_claims_per_unit ?? 400);
  return Math.max(floor, Math.min(ceiling, Math.ceil(kb * perKb)));
}

function normalizeSourceIdentity(value) {
  return String(value || '').replace(/^`|`$/g, '')
    .replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '');
}

function codeSpanIdentities(text) {
  return [...String(text || '').matchAll(/`([^`\n]+)`/g)]
    .map(match => normalizeSourceIdentity(match[1]));
}

function isFileWitness(value) {
  return /[/\\]/.test(value) && /\.[a-z0-9]{1,10}$/i.test(value);
}

function sameWitness(candidate, subject) {
  return candidate === subject || candidate.endsWith(`/${subject}`) || candidate.endsWith(`\\${subject}`);
}

// V23 showed that an arbitrary dotted suffix is not enough to identify a filename: expressions
// such as `verdict.status = computed.status` and `nodes.flatMap(...)` contain exact member subjects.
// A V24 basename rejection therefore requires file-shaped qualification, not an extension allowlist
// (which would merely move the collision to members named `payload.json` or `template.md`).
function isStrictFileQualification(candidate, subject) {
  return candidate.endsWith(`/${subject}`) || candidate.endsWith(`\\${subject}`)
    || candidate === `.${subject}` || candidate.endsWith(`-${subject}`)
    || candidate.endsWith(`_${subject}`) || candidate.startsWith(`${subject}.`);
}

function isShellCommandWitness(value) {
  return /^(?:node|bun|deno|python3?|ruby|bash|sh|zsh|npm|pnpm|yarn|npx|git|cargo|go|make)\s+\S/i
    .test(String(value || '').trim());
}

function hasIndependentCommandPredicate(cell, predicate) {
  const codeSpans = [...String(cell || '').matchAll(/`[^`\n]+`/g)];
  if (!codeSpans.length) return false;
  const tail = String(cell).slice(codeSpans.at(-1).index + codeSpans.at(-1)[0].length).trim();
  const normalized = String(predicate || '').trim().toLocaleLowerCase();
  // The observed false-rejection class is a coordinated command list followed by a distributive
  // pass predicate. Keep the exception narrow: a bare list or an unrelated predicate still rejects.
  return /^(?:,?\s*and\s+)?pass(?:es|ed)?\b/i.test(tail)
    && /^(?:pass|passes|passed)$/i.test(normalized);
}

function hasPreciseMultiWitnessCollapse(primaryLocators, surface, predicate,
  preserveCommandWitnesses = false) {
  const subject = normalizeSourceIdentity(surface);
  return primaryLocators.some(locator => String(locator.text || '').split('\n').some(line => {
    if (!/^\s*\|.*\|\s*$/.test(line)) return false;
    return line.split('|').some(cell => {
      const witnesses = [...new Set(codeSpanIdentities(cell).filter(isFileWitness))];
      if (witnesses.length <= 1 || !witnesses.some(value => sameWitness(value, subject))) return false;
      const independentlyPredicatedCommands = preserveCommandWitnesses
        && witnesses.every(isShellCommandWitness) && hasIndependentCommandPredicate(cell, predicate);
      return !independentlyPredicatedCommands;
    });
  }));
}

function hasPreciseTruncatedIdentity(primaryLocators, surface, preserveDottedMembers = false) {
  const subject = normalizeSourceIdentity(surface);
  if (!subject || (!/[/\\]/.test(subject) && !/\.[a-z0-9]{1,10}$/i.test(subject))) return null;
  const identifiers = primaryLocators.flatMap(locator => codeSpanIdentities(locator.text));
  if (identifiers.some(value => value === subject)) return null;
  const nested = identifiers.filter(value => value !== subject && value.includes(subject));
  if (!preserveDottedMembers || /[/\\]/.test(subject)) return nested[0] || null;
  return nested.find(value => isStrictFileQualification(value, subject)) || null;
}

function markdownTableCells(line) {
  return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function tableTriggerEffectViolation({ proposed, claim, catalog }) {
  const subject = normalizeSourceIdentity(claim.semantic.subject?.surface);
  const predicate = String(claim.semantic.predicate_family || '').toLocaleLowerCase();
  if (!subject || !predicate) return false;
  const rawLocators = (proposed.support_sets || []).flatMap(set => set.locators || [])
    .filter(locator => String(locator.role || 'primary') === 'primary');
  return rawLocators.some(locator => {
    const token = String(locator.source_locator?.block_token || '');
    const quote = String(locator.source_locator?.quote || '');
    const block = catalog?.byToken?.[token];
    if (block?.type !== 'table') return false;
    const lines = block.text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line));
    if (lines.length < 3) return false;
    const headers = markdownTableCells(lines[0]).map(cell => cell.toLocaleLowerCase());
    return lines.slice(2).some(line => {
      if (!(quote.includes(line) || line.includes(quote)) || !line.includes(subject)) return false;
      const cells = markdownTableCells(line);
      const subjectCell = cells.findIndex(cell => cell.includes(subject));
      if (subjectCell < 0 || !/(?:trigger|event)/i.test(headers[subjectCell] || '')) return false;
      return cells.some((cell, index) => index !== subjectCell && cell.toLocaleLowerCase().includes(predicate));
    });
  });
}

function leadingGrammaticalActor(text) {
  let line = String(text || '').split('\n').map(value => value.trim()).find(Boolean) || '';
  line = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^With [^:]{1,80}:\s*/i, '').replace(/^Before [^,]{1,120},\s*/i, '');
  const match = /^(?:the|a|an)?\s*([^|:;,]{1,80}?)\s+(?:can|must|may|will|shall|should|is|are|was|were|has|have|had|runs?|pre-analyzes?|pulls?|flags?|assigns?|becomes?|spawns?|creates?|writes?|reads?|verifies?|persists?|supports?|requires?)\b/i.exec(line);
  return match?.[1]?.trim() || null;
}

function presentationHeading(surface) {
  return /^(?:why\b|but\b|concrete\s+example\b)/i.test(surface)
    || /(?:^|[-:—]\s*)cross[- ]repo\s+coordination\b/i.test(surface);
}

function discoursePredicate(predicate) {
  return /^(?:states?|reports?|describes?|defines?|identifies?|documents?|records?|notes?|explains?)\b/i.test(predicate);
}

function verbStem(value) {
  const word = String(value || '').toLocaleLowerCase().replace(/^[^a-z]+|[^a-z-]+$/g, '')
    .replace(/^evidence-/, '');
  if (word.endsWith('ied')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2);
    return /([b-df-hj-np-tv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function activePassiveOwnershipReversal(predicate, blockTexts) {
  const first = String(predicate || '').trim().split(/\s+/)[0];
  const activeStem = verbStem(first);
  if (!activeStem || /^(?:is|are|was|were|has|have|had|be)$/.test(first.toLocaleLowerCase())) return false;
  return blockTexts.some(text => {
    const pattern = /\b(?:is|are|was|were|be|been|being)\s+(?:evidence-)?([a-z]+ed)\b/gi;
    return [...String(text || '').matchAll(pattern)].some(match => verbStem(match[1]) === activeStem);
  });
}

function localizedPrimaryEvidenceTexts(proposed, catalog) {
  return (proposed.support_sets || []).flatMap(set => set.locators || [])
    .filter(locator => String(locator.role || 'primary') === 'primary')
    .map(locator => {
      const source = locator.source_locator || {};
      const block = catalog?.byToken?.[String(source.block_token || '')];
      const quote = String(source.quote || '');
      const start = block?.text.indexOf(quote) ?? -1;
      if (start < 0) return quote;
      const remainder = block.text.slice(start + quote.length);
      const followingSentence = /^\s*[^.!?]*(?:[.!?]|$)/s.exec(remainder)?.[0] || '';
      return `${quote}${followingSentence}`;
    })
    .filter(Boolean);
}

function preciseHeadingOwnershipReason({ subject, predicate, primaryLocators, proposed, catalog }) {
  if (presentationHeading(subject) && !discoursePredicate(predicate)) {
    return ['PRESENTATION_HEADING_NOT_OPERATIONAL_ACTOR', 'a presentation/objection heading may report its content but cannot perform the stated operation'];
  }
  if (/^(?:makes?|causes?|forces?)\s+(?:the|a|an)\s+[\w.-]+(?:\s+[\w.-]+){0,2}\s+(?:demand|read|perform|run|write|check|require|emit|return|create|update|mutate|call|start|stop|handle|enforce|validate)\b/i.test(predicate)) {
    return ['CAUSATIVE_ACTOR_INVERSION', 'the predicate embeds the source actor and makes the heading cause that actor without source support'];
  }
  const evidenceTexts = primaryLocators.map(locator => locator.text).filter(Boolean);
  if (activePassiveOwnershipReversal(predicate, evidenceTexts)) {
    return ['PASSIVE_TO_ACTIVE_OWNERSHIP_REVERSAL', 'the source states a passive patient/predicate but the proposal makes the heading its active actor'];
  }
  const localEvidenceTexts = localizedPrimaryEvidenceTexts(proposed, catalog);
  if (localEvidenceTexts.some(text => /\b(?:travel|belong|attach(?:es|ed)?)\b[^.]{0,100}\bwith\s+[^.]{1,80},\s*not\s+the\s+(?:product|system)\b/i.test(text))) {
    return ['EXPLICIT_TOPIC_EXCLUSION_REVERSED', 'the source explicitly assigns the property away from the product/system topic'];
  }
  return null;
}

function roleOwnershipReason({ proposed, claim, catalog, preciseHeadingOwnership = false }) {
  const subject = String(claim.semantic.subject?.surface || '').replace(/^`|`$/g, '');
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (subject === 'THIS' || subject.toLocaleLowerCase() === 'future') {
    return ['DISCOURSE_LABEL_NOT_ENTITY', `${subject} is a discourse/status label, not the described entity`];
  }
  const primaryLocators = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary');
  if (binding === 'explicit') {
    const predicate = String(claim.semantic.predicate_family || '').toLocaleLowerCase();
    const object = String(claim.semantic.object_or_value || '').toLocaleLowerCase();
    const reversed = primaryLocators.some(locator => {
      const text = String(locator.text || '').toLocaleLowerCase();
      const predicateIndex = predicate ? text.indexOf(predicate) : -1;
      const subjectIndex = text.indexOf(subject.toLocaleLowerCase());
      if (predicateIndex < 0 || subjectIndex <= predicateIndex) return false;
      if (object.includes(subject.toLocaleLowerCase())) return true;
      const precedingIdentifiers = codeSpanIdentities(text.slice(0, predicateIndex));
      return precedingIdentifiers.some(value => !isFileWitness(value)
        && value.length >= 4 && subject.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
    });
    if (reversed) return ['SUBJECT_OCCURS_AFTER_PREDICATE', 'the selected subject occurs after the claimed predicate and is its object/citation, not its actor'];
    if (tableTriggerEffectViolation({ proposed, claim, catalog })) {
      return ['TABLE_TRIGGER_EFFECT_OWNERSHIP', 'a trigger/event cell cannot inherit an action stated in the effect cell'];
    }
  }
  if (binding === 'implicit_topic') {
    const subjectToken = String(proposed.subject_mention?.source_locator?.block_token || '');
    if (catalog?.byToken?.[subjectToken]?.type === 'heading') {
      if (preciseHeadingOwnership) {
        return preciseHeadingOwnershipReason({
          subject, predicate: String(claim.semantic.predicate_family || ''), primaryLocators,
          proposed, catalog,
        });
      }
      const actor = primaryLocators.map(locator => leadingGrammaticalActor(locator.text)).find(Boolean);
      if (actor && !subject.toLocaleLowerCase().includes(actor.toLocaleLowerCase())) {
        return ['IMPLICIT_HEADING_DISPLACED_ACTOR', `the evidence names grammatical actor ${actor}; the governing heading is not that actor`];
      }
    }
  }
  return null;
}

function normalizedRoleSurface(value) {
  return String(value || '').replace(/[`*_#]/g, '').replace(/[^a-z0-9]+/gi, ' ')
    .trim().toLocaleLowerCase().replace(/^(?:the|a|an)\s+/, '');
}

function relationVerbStem(value) {
  const words = String(value || '').toLocaleLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [];
  const ignored = new Set(['the', 'a', 'an', 'not', 'does', 'do', 'did', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'has', 'have', 'had', 'can', 'must', 'may', 'will', 'shall', 'should']);
  const word = words.find(candidate => !ignored.has(candidate));
  return verbStem(word || words[0] || '');
}

// V17 deliberately does not revive V14's broad "a heading cannot own a sentence" heuristic. It
// finds a local grammatical subject only when that subject performs the proposal's own lexical
// action. This preserves document policy and whole/part attributions while rejecting an operation
// reassigned to a procedure/presentation heading by an exact-address recovery.
function localActorRelations(text) {
  const clean = String(text || '').replace(/[`*_]/g, '').replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-+]\s+|\d+[.)]\s+)/, '').trim();
  const clauses = clean.split(/\n|(?<=[.!?;])\s+/).flatMap(sentence => {
    const pieces = [sentence];
    for (const match of sentence.matchAll(/,\s*/g)) pieces.push(sentence.slice(match.index + match[0].length));
    return pieces;
  }).map(clause => clause.trim()).filter(Boolean).reverse();
  const verbs = 'can|must|may|will|shall|should|does|do|did|is|are|was|were|has|have|had|commits?|prepares?|provides?|gives?|updates?|imports?|leaves?|returns?|selects?|stores?|keeps?|prevents?|allows?|requires?|defines?|states?|reports?|describes?|identifies?|documents?|records?|notes?|explains?|lives?|belongs?|attaches?|spawns?|creates?|writes?|reads?|verifies?|persists?|supports?|runs?|pulls?|flags?|assigns?|becomes?|uses?|models?|evaluates?|captures?|marks?|checks?|rejects?|promotes?|prohibits?';
  const pattern = new RegExp(`^(?:the|a|an)?\\s*([a-z0-9][a-z0-9_.\\/ -]{0,79}?)\\s+(?:[a-z]+ly\\s+){0,2}(${verbs})\\b(.*)$`, 'i');
  const relations = [];
  for (const clause of clauses) {
    const match = pattern.exec(clause);
    if (!match) continue;
    const actor = match[1].trim();
    if (/^(?:it|its|this|that|these|those|they|their|there|we|our|you|your|i)\b/i.test(actor)
      || /\b(?:it|this|that|these|those|they|we|you|i)$/i.test(actor)
      || /^[a-z]+ing\b/i.test(actor)) continue;
    let action = match[2];
    if (/^(?:does|do|did|is|are|was|were|has|have|had|can|must|may|will|shall|should)$/i.test(action)) {
      const lexical = /^\s*(?:not\s+|never\s+|[a-z]+ly\s+)*(?:be\s+)?([a-z]+(?:ed|en|ing|s)?)\b/i.exec(match[3]);
      if (lexical) action = lexical[1];
    }
    relations.push({ actor, action_stem: verbStem(action) });
  }
  return relations;
}

function recoveredRoleOwnershipReason({ proposed, claim, catalog }) {
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (binding !== 'implicit_topic') return null;
  const subjectToken = String(proposed.subject_mention?.source_locator?.block_token || '');
  const subject = String(claim.semantic.subject?.surface || '').replace(/^`|`$/g, '');
  const subjectBlockType = catalog?.byToken?.[subjectToken]?.type;
  if (subjectBlockType !== 'heading' && !/^properties?$/i.test(subject.trim())) return null;
  const predicate = String(claim.semantic.predicate_family || '');
  if (discoursePredicate(predicate)) return null;
  const primary = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary');
  const predicateStem = relationVerbStem(predicate);
  const relation = primary.flatMap(locator => localActorRelations(locator.text)).find(candidate =>
    candidate?.action_stem && predicateStem && candidate.action_stem === predicateStem);
  if (relation) {
    const actor = normalizedRoleSurface(relation.actor), heading = normalizedRoleSurface(subject);
    if (actor === heading || actor.startsWith(`${heading} `) || actor.startsWith(`${heading}_`)) {
      return ['RECOVERED_LITERAL_ACTOR_REQUIRES_EXPLICIT',
        `the evidence names literal actor ${relation.actor}; it cannot remain implicitly bound through its heading`];
    }
    return ['RECOVERED_HEADING_DISPLACED_ACTOR',
      `the evidence assigns the claimed action to ${relation.actor}, not the recovered heading ${subject}`];
  }
  const evidence = primary.map(locator => locator.text).join('\n');
  if (/^properties?$/i.test(subject.trim()) && primary.flatMap(locator => localActorRelations(locator.text)).length) {
    return ['RECOVERED_PRESENTATION_LABEL_NOT_ACTOR',
      'a Properties label scopes the following content but does not perform its local relation'];
  }
  if (/^(?:makes?|causes?|forces?)\b/i.test(predicate)
    && /\b(?:is|are|was|were)\s+(?:mutually\s+)?(?:exclusive|rejected|required|forbidden|invalid)\b/i.test(evidence)) {
    return ['RECOVERED_CAUSATIVE_ACTOR_INVERSION',
      'the evidence states a field/property constraint but the proposal makes the recovered heading cause it'];
  }
  const introducedPossessivePatient = /`([^`\n]+)`\s+is\b[^.]{0,180}\.\s*[^.]{0,120}\bits\s+[^.]{0,100}?\b([a-z]+ed)\b/i
    .exec(evidence.replace(/[*_]/g, ''));
  if (introducedPossessivePatient
    && verbStem(introducedPossessivePatient[2]) === predicateStem) {
    return ['RECOVERED_HEADING_DISPLACED_ACTOR',
      `the evidence assigns the claimed action to ${introducedPossessivePatient[1]}'s patient, not the recovered heading ${subject}`];
  }
  if (/\b(?:map|diagram|table|surface)\b/i.test(subject)
    && /^(?:prohibits?|prevents?|disallows?)\b/i.test(predicate)
    && /(?:^|[.!?]\s+)No\s+[^.!?]{1,120}\b(?:imports?|uses?|calls?|contains?|references?)\b/i.test(evidence)) {
    return ['RECOVERED_REPRESENTATION_NOT_POLICY_ACTOR',
      'a map/diagram/table may report the constraint but is not the actor that imposes it'];
  }
  const proposition = `${predicate} ${String(claim.semantic.object_or_value || '')}`;
  if (/^(?:has|contains?|owns?)\b/i.test(predicate)
    && !/\b(?:living|lives)\s+in\b/i.test(proposition)
    && /\b(?:all\s+)?(?:design\s+)?content\b[\s\S]{0,360}?\bnow\s+lives\s+in\b/i.test(evidence)) {
    return ['RECOVERED_ASSIGNMENT_AWAY_FROM_TOPIC',
      'the evidence assigns the content to another location rather than to the recovered topic'];
  }
  if (primary.length === 1 && /^\s*[-*+]\s+/.test(primary[0].text)
    && /^(?:becomes?|turns?)\b[^.]{0,80}\bwhen\b/i.test(predicate)
    && !/\b(?:becomes?|turns?|stale|when)\b/i.test(primary[0].text)) {
    return ['RECOVERED_CONDITION_FRAGMENT_LACKS_RELATION',
      'the recovered list fragment contains only a condition and does not state the claimed lifecycle relation'];
  }
  return null;
}

function recoveredSemanticCompletenessReason({ proposed, claim }) {
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (binding !== 'implicit_topic') return null;
  const subject = String(claim.semantic.subject?.surface || '');
  const predicate = String(claim.semantic.predicate_family || '');
  const primary = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary');
  const evidence = primary.map(locator => locator.text).join('\n');
  const proposedSubjectQuote = String(proposed.subject_mention?.source_locator?.quote || '');
  const normalizedSubject = normalizedRoleSurface(subject);
  const normalizedQuote = normalizedRoleSurface(proposedSubjectQuote.replace(/[_-]+/g, ' '));
  if (/`[^`\n]+`/.test(proposedSubjectQuote) && normalizedQuote !== normalizedSubject
    && normalizedQuote.startsWith(`${normalizedSubject} `)
    && evidence.includes(proposedSubjectQuote)) {
    return ['RECOVERED_LITERAL_IDENTITY_TRUNCATED',
      `the recovered implicit subject ${subject} shortens literal identifier-bearing actor ${proposedSubjectQuote}`];
  }
  if (/^makes?\b/i.test(predicate)) {
    const actors = [...evidence.replace(/[*_`]/g, '').matchAll(/(?:^|[.!?]\s+)(?:the|a|an)\s+([^.!?;]{1,80}?)\s+makes?\b/gi)]
      .map(match => match[1].trim());
    const displaced = actors.find(actor => normalizedRoleSurface(actor) !== normalizedSubject);
    if (displaced) {
      return ['RECOVERED_HEADING_DISPLACED_ACTOR',
        `the evidence assigns the claimed action to ${displaced}, not the recovered heading ${subject}`];
    }
  }
  if (/^(?:places?|puts?)\b/i.test(predicate)) {
    const local = /(?:^|[.!?]\s+)([^.!?;]{1,100}?)\s+runs?\s+before\b/i.exec(evidence.replace(/[*_`]/g, ''));
    if (local && normalizedRoleSurface(local[1]) !== normalizedSubject) {
      return ['RECOVERED_CAUSATIVE_ACTOR_INVERSION',
        `the evidence reports that ${local[1].trim()} runs before another step; the heading does not place it there`];
    }
  }
  const normativeClaim = /^requires?\s+(?:reuse|use)\s+of\b/i.test(predicate);
  const normativeEvidence = /\b(?:must|required|requires?|no\s+substitute|reuse\s+this|use\s+this|only)\b/i.test(evidence);
  if (normativeClaim && !normativeEvidence) {
    return ['RECOVERED_NORMATIVE_FORCE_UNCITED',
      'the recovered claim asserts normative force that is absent from its exact primary evidence'];
  }
  return null;
}

// V19 is intentionally scoped to exact-address recoveries of implicit headings. It catches active
// rewrites whose evidence uses a different grammatical form or a named local actor, without
// reviving the broad V14 rule that rejected legitimate heading-scoped policy and description.
function recoveredActiveHeadingReason({ proposed, claim, catalog }) {
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (binding !== 'implicit_topic') return null;
  const subjectToken = String(proposed.subject_mention?.source_locator?.block_token || '');
  const subject = String(claim.semantic.subject?.surface || '').replace(/^`|`$/g, '');
  if (catalog?.byToken?.[subjectToken]?.type !== 'heading' && !/^properties?:?$/i.test(subject.trim())) return null;
  const predicate = String(claim.semantic.predicate_family || '');
  const primary = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary');
  const evidence = primary.map(locator => String(locator.text || '')).join('\n');
  const clean = evidence.replace(/[`*_]/g, '').replace(/^\s*>\s?/gm, '').trim();
  const normalizedSubject = normalizedRoleSurface(subject);

  if (/^limits?\b/i.test(predicate) && !/\blimits?\b/i.test(clean)
    && /\b(?:is|are|was|were)\s+(?:accepted|allowed|permitted|rejected)\s+only\b/i.test(clean)) {
    return ['RECOVERED_HEADING_NOT_POLICY_ACTOR',
      `the evidence states a constrained acceptance condition; the recovered heading ${subject} does not impose that limit`];
  }
  if (/^makes?\b/i.test(predicate) && !/\b(?:make|makes|made)\b/i.test(clean)
    && /\b(?:is|are|was|were|forms?|becomes?)\b/i.test(clean)) {
    return ['RECOVERED_HEADING_CAUSATIVE_REWRITE',
      `the evidence states an identity, state, or formation relation; the recovered heading ${subject} does not cause it`];
  }
  if (/^models?\b/i.test(predicate) && !/\bmodels?\b/i.test(clean)) {
    const copular = /^(?:the\s+)?([a-z0-9][a-z0-9_.\/-]*(?:\s+[a-z0-9_.\/-]+){0,5})\s+(?:is|are)\b/i.exec(clean);
    if (copular && normalizedRoleSurface(copular[1]) !== normalizedSubject) {
      return ['RECOVERED_HEADING_DISPLACED_ACTOR',
        `the evidence describes literal subject ${copular[1]}, not the recovered heading ${subject}`];
    }
  }
  if (/^transitions?\b/i.test(predicate)) {
    const operation = /^\s*([a-z0-9_.\/-]+)\s+[—–-]\s+/i.exec(clean);
    if (operation && normalizedRoleSurface(operation[1]) !== normalizedSubject
      && /\btransitions?\b/i.test(clean)) {
      return ['RECOVERED_HEADING_DISPLACED_ACTOR',
        `the evidence assigns the transition to operation ${operation[1]}, not the recovered heading ${subject}`];
    }
  }
  if (/^assigns?\b/i.test(predicate) && !/\bassigns?\b/i.test(clean)
    && /\b(?:is|are)\s+owned\s+by\b/i.test(clean)) {
    return ['RECOVERED_REPRESENTATION_NOT_ASSIGNER',
      `the evidence reports an ownership relation; the recovered heading ${subject} does not assign it`];
  }
  const evidenceLines = evidence.split('\n').map(line => line.trim()).filter(Boolean);
  if (/^updates?\s+when\b/i.test(predicate) && !/\bupdates?\b/i.test(clean)
    && evidenceLines.length > 0 && evidenceLines.every(line => /^(?:[-*+]|\d+[.)])\s+/.test(line))) {
    return ['RECOVERED_GOVERNING_CLAUSE_UNCITED',
      'the cited evidence contains only trigger-list items and omits the governing update clause'];
  }
  return null;
}

function recoveredCausativeHeadingReason({ proposed, claim, catalog }) {
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (binding !== 'implicit_topic') return null;
  const subjectToken = String(proposed.subject_mention?.source_locator?.block_token || '');
  if (catalog?.byToken?.[subjectToken]?.type !== 'heading') return null;
  const predicate = String(claim.semantic.predicate_family || '');
  const causal = /^(?:causes?|forces?)\s+(.{1,100}?)\s+to\s+([a-z]+(?:-[a-z]+)*)\b/i.exec(predicate);
  if (!causal) return null;
  const primary = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary');
  const evidence = primary.map(locator => String(locator.text || '')).join('\n');
  if (/\b(?:causes?|caused|forcing|forces?|forced)\b/i.test(evidence)) return null;
  const normalizedEvidence = normalizedRoleSurface(evidence);
  const embeddedActor = normalizedRoleSurface(causal[1]);
  if (!embeddedActor || !normalizedEvidence.startsWith(`${embeddedActor} `)) return null;
  const localAction = normalizedEvidence.slice(embeddedActor.length).trim().split(/\s+/)[0] || '';
  const claimedAction = causal[2].toLocaleLowerCase();
  if (localAction !== claimedAction && localAction !== `${claimedAction}s`
    && verbStem(localAction) !== verbStem(claimedAction)) return null;
  return ['RECOVERED_HEADING_CAUSATIVE_REWRITE',
    `the evidence assigns ${causal[2]} to local actor ${causal[1]}; it does not make the recovered heading cause that action`];
}

// V23 keeps V22's exact omitted-quote recovery, then fails closed when the recovered surface is a
// scenario/list label or the evidence names a relative-clause actor for the proposal's own action.
// These are scope anchors, not evidence that the label or governing section performs the action.
function recoveredImplicitTopicActorReason({ proposed, claim }) {
  const binding = String(claim.semantic.subject?.binding?.kind || proposed.subject_binding || 'explicit');
  if (binding !== 'implicit_topic') return null;
  const subject = String(claim.semantic.subject?.surface || '').replace(/[`*_#]/g, '').trim();
  const predicate = String(claim.semantic.predicate_family || '');
  if (discoursePredicate(predicate)) return null;
  if (/^when\b/i.test(subject)) {
    return ['RECOVERED_SCENARIO_LABEL_NOT_ACTOR',
      `the recovered scenario label ${subject} scopes the following outcome but does not perform its local actions`];
  }
  if (/^exceptions?\b/i.test(subject)) {
    return ['RECOVERED_EXCEPTION_LABEL_NOT_ACTOR',
      `the recovered exception label ${subject} classifies following cases but does not perform the claimed action`];
  }
  const predicateStem = relationVerbStem(predicate);
  if (!predicateStem) return null;
  const evidence = claim.semantic.support_sets.flatMap(set => set.locators || [])
    .filter(locator => locator.role === 'primary')
    .map(locator => String(locator.text || '').replace(/[`*_]/g, ''));
  for (const text of evidence) {
    const relativeActors = [...text.matchAll(/\b(?:an?|the)\s+([a-z0-9][a-z0-9_.\/ -]{0,79}?)\s+(?:that|which)\s+([a-z]+(?:-[a-z]+)*)\b/gi)];
    const displaced = relativeActors.find(match => verbStem(match[2]) === predicateStem
      && normalizedRoleSurface(match[1]) !== normalizedRoleSurface(subject));
    if (displaced) {
      return ['RECOVERED_HEADING_DISPLACED_ACTOR',
        `the evidence assigns the claimed action to ${displaced[1].trim()}, not the recovered topic ${subject}`];
    }
  }
  return null;
}

function exactIndexes(haystack, needle) {
  const indexes = [];
  let from = 0;
  while (needle && from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

function disambiguateUniqueLocator(locator, catalog) {
  if (!locator || typeof locator !== 'object') return locator;
  const source = locator.source_locator || locator;
  const quote = String(source.quote || '');
  const block = catalog?.byToken?.[String(source.block_token || '').trim()];
  if (!block || !quote || quote.length >= 24 || source.context_before || source.context_after
    || source.occurrence != null || exactIndexes(block.text, quote).length !== 1) return locator;
  const grounded = { ...source, occurrence: 1 };
  return locator.source_locator ? { ...locator, source_locator: grounded } : grounded;
}

function recoverExactUniqueGrounding(proposed, catalog, binding, normalizeCatalogPrimaryRoles = false,
  recoverExactImplicitTopicQuotes = false) {
  let subject = proposed.subject_mention || {};
  let subjectLocator = subject.source_locator || {};
  if (recoverExactImplicitTopicQuotes && binding === 'implicit_topic'
    && !String(subjectLocator.quote || '').length) {
    const surface = String(subject.surface || '').trim();
    const block = catalog?.byToken?.[String(subjectLocator.block_token || '').trim()];
    if (surface && block && exactIndexes(block.text, surface).length === 1) {
      subjectLocator = {
        ...subjectLocator, quote: surface,
        ...(surface.length < 24 && subjectLocator.occurrence == null ? { occurrence: 1 } : {}),
      };
      subject = { ...subject, source_locator: subjectLocator };
    }
  }
  if (!String(subjectLocator.block_token || '').trim() && binding !== 'explicit') {
    const quote = String(subjectLocator.quote || '');
    const matches = (catalog?.entries || []).flatMap(block =>
      exactIndexes(block.text, quote).map(index => ({ block, index })));
    if (quote && matches.length === 1) {
      subjectLocator = {
        ...subjectLocator, block_token: matches[0].block.token,
        ...(quote.length < 24 && subjectLocator.occurrence == null ? { occurrence: 1 } : {}),
      };
      subject = { ...subject, source_locator: subjectLocator };
    }
  }
  subject = { ...subject, source_locator: disambiguateUniqueLocator(subject.source_locator, catalog) };
  const antecedent = subject.antecedent_locator
    ? disambiguateUniqueLocator(subject.antecedent_locator, catalog) : subject.antecedent_locator;
  if (antecedent) subject = { ...subject, antecedent_locator: antecedent };
  const supportSets = (proposed.support_sets || []).map(set => {
    const locators = (set.locators || []).map(locator => disambiguateUniqueLocator(locator, catalog));
    const hasIndependentPrimary = locators.some(locator =>
      String(locator.role || 'primary') === 'primary'
      && catalog?.byToken?.[String(locator.source_locator?.block_token || '')]?.role === 'primary');
    const grounded = normalizeCatalogPrimaryRoles && hasIndependentPrimary
      ? locators.map(locator => {
          const token = String(locator.source_locator?.block_token || '');
          return String(locator.role || 'primary') === 'context'
            && catalog?.byToken?.[token]?.role === 'primary' ? { ...locator, role: 'primary' } : locator;
        })
      : locators;
    return { ...set, locators: grounded };
  });
  return { ...proposed, subject_mention: subject, support_sets: supportSets };
}

function repairWhitespaceEquivalentProposalLocators(proposed, catalog) {
  const findings = [];
  const repair = (locator, expectedRole = null) => {
    try {
      const result = repairWhitespaceEquivalentSourceLocator({ locator, catalog, expected_role: expectedRole });
      if (result.repair) findings.push(result.repair);
      return result.locator;
    } catch (error) {
      // This preprocessing hook has one authority only: rewriting a unique, same-block,
      // whitespace-equivalent miss. Every other exact-locator result belongs to the existing
      // recovery and validation pipeline (including short-quote disambiguation and implicit-topic
      // recovery), so leave the authored locator untouched. Ambiguous or structurally unsafe
      // whitespace repairs are affirmative v28 findings and remain fatal.
      if (String(error?.code || '').startsWith('WHITESPACE_EQUIVALENT_')) throw error;
      return locator;
    }
  };
  const subject = proposed.subject_mention || {};
  const subjectMention = {
    ...subject,
    source_locator: repair(subject.source_locator || {}, null),
    ...(subject.antecedent_locator ? { antecedent_locator: repair(subject.antecedent_locator, null) } : {}),
  };
  const supportSets = (proposed.support_sets || []).map(set => ({
    ...set,
    locators: (set.locators || []).map(item => ({
      ...item,
      source_locator: repair(item.source_locator || {}, null),
    })),
  }));
  return Object.freeze({
    proposed: { ...proposed, subject_mention: subjectMention, support_sets: supportSets },
    findings: findings.slice(),
  });
}

function subjectAnchorBinding({ proposed, anchor, anchorKind, catalog }) {
  const authoredSurface = String(proposed.subject_mention?.surface || '').trim();
  const anchorSurface = String(anchor?.surface || '').trim();
  const authoredNormalized = markupNormalized(authoredSurface);
  const anchorNormalized = markupNormalized(anchorSurface);
  const common = {
    authored_surface: authoredSurface,
    anchor_surface: anchorSurface,
    anchor_kind: anchorKind,
  };
  if (authoredNormalized && authoredNormalized === anchorNormalized) {
    const sourceLocator = anchorKind === 'subject_occurrence'
      ? { block_token: anchor.block_token, quote: anchor.surface, occurrence: anchor.occurrence }
      : proposed.subject_mention?.source_locator;
    return {
      proposed: {
        ...proposed,
        subject_mention: { ...proposed.subject_mention, surface: anchorSurface, source_locator: sourceLocator },
      },
      resolution: { ...common, resolved_surface: anchorSurface, mode: 'normalized_identical_anchor' },
      finding: null,
    };
  }

  const authoredLocator = proposed.subject_mention?.source_locator;
  let resolved;
  try { resolved = resolveSourceLocator({ locator: authoredLocator, catalog }); }
  catch {
    return { conflict: true, ...common, detail: 'the authored subject locator does not resolve exactly' };
  }
  const containsAnchor = authoredNormalized.length > anchorNormalized.length
    && authoredNormalized.includes(anchorNormalized)
    && markupNormalized(resolved.text).includes(authoredNormalized);
  const sameSpan = anchorKind === 'subject_occurrence'
    ? anchor.block_token === resolved.source_locator.block_token
      && Number(anchor.byte_start) >= Number(resolved.byte_start)
      && Number(anchor.byte_end) <= Number(resolved.byte_end)
    : anchor.file === resolved.file && (anchor.lines || []).some(line => line >= resolved.start && line <= resolved.end);
  if (!containsAnchor || !sameSpan) {
    return { conflict: true, ...common, detail: 'the anchor is not a contained occurrence in the authored subject span' };
  }
  return {
    proposed,
    resolution: { ...common, resolved_surface: authoredSurface, mode: 'authored_surface_preserved' },
    finding: {
      code: 'SUBJECT_SURFACE_PRESERVED_WITH_ANCHOR',
      anchor_kind: anchorKind,
      authored_surface: authoredSurface,
      anchor_surface: anchorSurface,
      source_locator_id: resolved.id,
    },
  };
}

// Shared by the paid driver and the read-only checkpoint telemetry. Keeping validation in one
// function prevents the TUI from reporting a rosier rejection rate than the final artifact.
// This is deterministic tool-side factoring only; it does not change the model-visible contract.
export function validateWindowResponse({
  response, window, catalog, namespace, mentionByRef = new Map(), subjectOccurrenceByRef = new Map(),
  modelIdentifier, promptDigest, maxClaims, requireSubjectOccurrence = false,
  recoverColocatedExplicit = false,
  rejectOwnershipCollapse = false,
  ignoreUnknownAdvisoryOccurrence = false,
  preciseOwnershipCollapse = false,
  rejectRoleOwnership = false,
  preciseHeadingOwnership = false,
  recoverExactUniqueLocators = false,
  normalizeCatalogPrimaryRoles = false,
  rejectIncompleteEvidenceFragments = false,
  rejectRecoveredRoleOwnership = false,
  rejectRecoveredSemanticCompleteness = false,
  rejectRecoveredActiveHeadings = false,
  rejectRecoveredCausativeHeadings = false,
  recoverExactImplicitTopicQuotes = false,
  rejectRecoveredImplicitTopicActors = false,
  preserveDottedMemberIdentities = false,
  preserveIndependentCommandWitnesses = false,
  terminalIncompleteOnTruncation = false,
  terminalIncompleteOnOverflow = false,
  repairWhitespaceEquivalentLocators = false,
  preserveAuthoredSubjectSurfaces = false,
  useClaimV33 = false,
}) {
  const answer = parseFlatRelationAnswer(response?.text || '');
  if (!answer) return { ok: false, reason: 'extractor did not return a flat JSON-lines answer with a header' };
  const capped = applyOutputCap({ items: answer.proposals, max_items: maxClaims });
  const claims = [], rejected = [...answer.rejected];
  if (!answer.completeness.complete) {
    rejected.push({ index: null, code: 'TRUNCATED_WINDOW', detail: answer.completeness.reason, locator_stats: null });
  }
  let proposedLocators = 0, resolvedLocators = 0;
  for (const row of answer.rejected) proposedLocators += Number(row.locator_stats?.proposed || 0);
  capped.retained.forEach(({ proposed: raw }, index) => {
    // An explicit sNNN selector is an occurrence—not a document-level surface aggregate. The tool
    // supplies both exact bytes and the disambiguating occurrence, so explicit grounding is a hard
    // structural choice rather than a prompt preference.
    let proposed = raw;
    const proposalRepairFindings = [];
    let subjectResolution = null;
    if (repairWhitespaceEquivalentLocators) {
      try {
        const repaired = repairWhitespaceEquivalentProposalLocators(proposed, catalog);
        proposed = repaired.proposed;
        proposalRepairFindings.push(...repaired.findings);
      } catch (error) {
        rejected.push({
          index,
          reason: error.code || 'INVALID_CLAIM',
          detail: error.message,
          locator_stats: null,
          proposed_digest: sha256(canonical(raw)),
        });
        proposedLocators += countProposedLocators(raw);
        return;
      }
    }
    if (proposed.subject_ref) {
      const mention = mentionByRef.get(String(proposed.subject_ref).trim());
      if (!mention) {
        rejected.push({ index, reason: 'UNKNOWN_SUBJECT_REF', detail: `no grounded mention ${proposed.subject_ref}`, locator_stats: null, proposed_digest: sha256(canonical(raw)) });
        proposedLocators += countProposedLocators(raw);
        return;
      }
      if (preserveAuthoredSubjectSurfaces) {
        const anchored = subjectAnchorBinding({ proposed, anchor: mention, anchorKind: 'subject_ref', catalog });
        if (anchored.conflict) {
          rejected.push({ index, reason: 'SUBJECT_REF_SURFACE_CONFLICT', detail: anchored.detail,
            locator_stats: null, proposed_digest: sha256(canonical(raw)) });
          proposedLocators += countProposedLocators(raw);
          return;
        }
        proposed = anchored.proposed;
        subjectResolution = anchored.resolution;
        if (anchored.finding) proposalRepairFindings.push(anchored.finding);
      } else {
        proposed = { ...proposed, subject_mention: { ...proposed.subject_mention, surface: mention.surface } };
      }
    }
    let binding = String(proposed.subject_binding || 'explicit').trim();
    let advisoryOccurrence = null;
    if (proposed.subject_occurrence) {
      const occurrence = subjectOccurrenceByRef.get(String(proposed.subject_occurrence).trim());
      if (!occurrence) {
        if (!(ignoreUnknownAdvisoryOccurrence && binding !== 'explicit')) {
          rejected.push({ index, reason: 'UNKNOWN_SUBJECT_OCCURRENCE', detail: `no prompt-local occurrence ${proposed.subject_occurrence}`, locator_stats: null, proposed_digest: sha256(canonical(raw)) });
          proposedLocators += countProposedLocators(raw);
          return;
        }
      }
      if (occurrence && binding !== 'explicit') {
        if (!recoverColocatedExplicit) {
          rejected.push({ index, reason: 'SUBJECT_OCCURRENCE_BINDING_MISMATCH', detail: `${proposed.subject_occurrence} may only be used with explicit binding`, locator_stats: null, proposed_digest: sha256(canonical(raw)) });
          proposedLocators += countProposedLocators(raw);
          return;
        }
        // @10 treats a known selector on a non-explicit binding as redundant, not contradictory.
        // Co-location below may deterministically upgrade it; a cross-block heading remains an
        // implicit topic and the model's own exact locator continues to carry authority.
        advisoryOccurrence = occurrence;
      } else if (occurrence) {
        if (preserveAuthoredSubjectSurfaces) {
          const anchored = subjectAnchorBinding({ proposed, anchor: occurrence,
            anchorKind: 'subject_occurrence', catalog });
          if (anchored.conflict) {
            rejected.push({ index, reason: 'SUBJECT_OCCURRENCE_SURFACE_CONFLICT', detail: anchored.detail,
              locator_stats: null, proposed_digest: sha256(canonical(raw)) });
            proposedLocators += countProposedLocators(raw);
            return;
          }
          proposed = { ...anchored.proposed, subject_binding: 'explicit', subject_occurrence_id: occurrence.id };
          subjectResolution = anchored.resolution;
          if (anchored.finding) proposalRepairFindings.push(anchored.finding);
        } else {
          proposed = {
            ...proposed,
            subject_binding: 'explicit',
            subject_occurrence_id: occurrence.id,
            subject_mention: {
              ...proposed.subject_mention,
              surface: occurrence.surface,
              source_locator: {
                block_token: occurrence.block_token,
                quote: occurrence.surface,
                occurrence: occurrence.occurrence,
              },
            },
          };
        }
      }
    }
    let exactGroundingRecovered = proposalRepairFindings.some(row => row.code === 'WHITESPACE_EQUIVALENT_LOCATOR_REWRITTEN');
    if (recoverExactUniqueLocators) {
      const beforeExactGrounding = canonical(proposed);
      proposed = recoverExactUniqueGrounding(proposed, catalog, binding, normalizeCatalogPrimaryRoles,
        recoverExactImplicitTopicQuotes);
      exactGroundingRecovered = exactGroundingRecovered || canonical(proposed) !== beforeExactGrounding;
    }
    if (recoverColocatedExplicit && ['implicit_topic', 'unresolved'].includes(binding)) {
      const recoveryBase = proposed;
      const surface = String(recoveryBase.subject_mention?.surface || '').trim();
      const subjectBlock = String(recoveryBase.subject_mention?.source_locator?.block_token || '').trim();
      const primaryEvidenceBlocks = new Set((proposed.support_sets || []).flatMap(set => set.locators || [])
        .filter(locator => String(locator.role || 'primary') === 'primary')
        .map(locator => String(locator.source_locator?.block_token || '').trim()));
      if (surface && subjectBlock && primaryEvidenceBlocks.has(subjectBlock)) {
        const occurrences = [...subjectOccurrenceByRef.values()].filter(occurrence =>
          occurrence.surface === surface && occurrence.block_token === subjectBlock);
        let occurrence = advisoryOccurrence?.surface === surface
          && advisoryOccurrence?.block_token === subjectBlock ? advisoryOccurrence
          : occurrences.length === 1 ? occurrences[0] : null;
        if (!occurrence) {
          const block = catalog?.byToken?.[subjectBlock];
          const quote = String(recoveryBase.subject_mention?.source_locator?.quote || '');
          const quoteStarts = [], surfaceStarts = [];
          let from = 0;
          while (quote && (from = block?.text.indexOf(quote, from) ?? -1) >= 0) {
            quoteStarts.push(from); from += Math.max(1, quote.length);
          }
          from = 0;
          while (surface && (from = quote.indexOf(surface, from)) >= 0) {
            surfaceStarts.push(from); from += Math.max(1, surface.length);
          }
          if (block && quoteStarts.length === 1 && surfaceStarts.length === 1) {
            const absoluteOffset = quoteStarts[0] + surfaceStarts[0];
            const blockSurfaceStarts = [];
            from = 0;
            while ((from = block.text.indexOf(surface, from)) >= 0) {
              blockSurfaceStarts.push(from); from += Math.max(1, surface.length);
            }
            const ordinal = blockSurfaceStarts.indexOf(absoluteOffset);
            if (ordinal >= 0) {
              const body = {
                schema: 'estate-map/window-subject-occurrence/v1', window_id: catalog.window_id,
                mention_id: null, kind: 'recovered_literal', surface, block_token: subjectBlock,
                block_id: block.block_id, block_digest: block.digest, role: block.role,
                occurrence: ordinal + 1,
                line: block.start + (block.text.slice(0, absoluteOffset).match(/\n/g) || []).length,
                byte_start: block.byte_start + Buffer.byteLength(block.text.slice(0, absoluteOffset), 'utf8'),
                byte_end: block.byte_start + Buffer.byteLength(block.text.slice(0, absoluteOffset + surface.length), 'utf8'),
                text_digest: sha256(surface), recovery: 'co_located_literal_subject',
              };
              occurrence = { ...body, id: `subject-occurrence:${sha256(canonical(body))}` };
            }
          }
        }
        if (occurrence) {
          binding = 'explicit';
          proposed = {
            ...recoveryBase,
            subject_binding: 'explicit', subject_occurrence_id: occurrence.id,
            subject_mention: {
              ...recoveryBase.subject_mention,
              surface: occurrence.surface,
              source_locator: {
                block_token: occurrence.block_token, quote: occurrence.surface,
                occurrence: occurrence.occurrence,
              },
            },
          };
        }
      }
    }
    if (requireSubjectOccurrence && binding === 'explicit' && !proposed.subject_occurrence_id) {
      rejected.push({ index, reason: 'EXPLICIT_SUBJECT_OCCURRENCE_REQUIRED', detail: 'explicit binding requires a prompt-local sNNN selector', locator_stats: null, proposed_digest: sha256(canonical(raw)) });
      proposedLocators += countProposedLocators(raw);
      return;
    }
    proposedLocators += countProposedLocators(proposed);
    try {
      const claim = useClaimV33
        ? buildClaimV33({
            proposed, window, catalog, namespace,
            model_identifier: modelIdentifier, prompt_digest: promptDigest,
            repair_findings: proposalRepairFindings,
            subject_resolution: subjectResolution,
          })
        : buildClaimV32({
            proposed, window, catalog, namespace,
            model_identifier: modelIdentifier, prompt_digest: promptDigest,
          });
      resolvedLocators += claim.locator_stats.resolved;
      if (rejectRoleOwnership) {
        const roleReason = roleOwnershipReason({ proposed, claim, catalog, preciseHeadingOwnership });
        if (roleReason) {
          rejected.push({ index, reason: roleReason[0], detail: roleReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectRecoveredRoleOwnership && exactGroundingRecovered) {
        const recoveredReason = recoveredRoleOwnershipReason({ proposed, claim, catalog });
        if (recoveredReason) {
          rejected.push({ index, reason: recoveredReason[0], detail: recoveredReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectRecoveredSemanticCompleteness && exactGroundingRecovered) {
        const semanticReason = recoveredSemanticCompletenessReason({ proposed, claim });
        if (semanticReason) {
          rejected.push({ index, reason: semanticReason[0], detail: semanticReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectRecoveredActiveHeadings && exactGroundingRecovered) {
        const activeHeadingReason = recoveredActiveHeadingReason({ proposed, claim, catalog });
        if (activeHeadingReason) {
          rejected.push({ index, reason: activeHeadingReason[0], detail: activeHeadingReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectRecoveredCausativeHeadings && exactGroundingRecovered) {
        const causativeHeadingReason = recoveredCausativeHeadingReason({ proposed, claim, catalog });
        if (causativeHeadingReason) {
          rejected.push({ index, reason: causativeHeadingReason[0], detail: causativeHeadingReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectRecoveredImplicitTopicActors && exactGroundingRecovered) {
        const actorReason = recoveredImplicitTopicActorReason({ proposed, claim });
        if (actorReason) {
          rejected.push({ index, reason: actorReason[0], detail: actorReason[1],
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectIncompleteEvidenceFragments) {
        const primary = claim.semantic.support_sets.flatMap(set => set.locators || [])
          .filter(locator => locator.role === 'primary');
        if (primary.length === 1
          && /\b(?:the|a|an|from|to|of|for|with|into|and|or)\s*$/i.test(primary[0].text.trim())) {
          rejected.push({ index, reason: 'INCOMPLETE_EVIDENCE_FRAGMENT',
            detail: 'the sole primary quote ends mid-clause and cannot ground the complete proposition',
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      if (rejectOwnershipCollapse) {
        const surface = String(claim.semantic.subject?.surface || '').replace(/^`|`$/g, '');
        const primaryLocators = claim.semantic.support_sets.flatMap(set => set.locators || [])
          .filter(locator => locator.role === 'primary');
        const primaryText = primaryLocators.map(locator => String(locator.text || '')).join('\n');
        const identifierValues = preciseOwnershipCollapse ? codeSpanIdentities(primaryText)
          : [...primaryText.matchAll(/`([^`\n]+)`/g)]
            .map(match => match[1].replace(/:\d+(?:-\d+)?$/, ''));
        const identifiers = [...new Set(identifierValues
          .filter(value => /[/\\]/.test(value) || /\.[a-z0-9]{1,10}$/i.test(value)))];
        const nested = identifiers.filter(value => value !== surface && value.includes(surface));
        const tableRow = primaryText.split('\n').some(line => /^\s*\|.*\|\s*$/.test(line));
        const multiWitnessCollapse = preciseOwnershipCollapse
          ? hasPreciseMultiWitnessCollapse(primaryLocators, surface, proposed.predicate_family,
            preserveIndependentCommandWitnesses)
          : tableRow && identifiers.length > 1 && identifiers.some(value => value === surface || value.includes(surface));
        if (multiWitnessCollapse) {
          rejected.push({ index, reason: 'MULTI_WITNESS_SUBJECT_COLLAPSE',
            detail: 'a multi-witness table row cannot be assigned to one listed witness',
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
        const truncatedIdentity = preciseOwnershipCollapse
          ? hasPreciseTruncatedIdentity(primaryLocators, surface, preserveDottedMemberIdentities) : nested[0];
        if (truncatedIdentity) {
          rejected.push({ index, reason: 'QUALIFIED_IDENTITY_TRUNCATED',
            detail: `subject ${surface} is nested inside longer source identity ${truncatedIdentity}`,
            locator_stats: claim.locator_stats, proposed_digest: sha256(canonical(proposed)) });
          return;
        }
      }
      claims.push(claim);
    } catch (error) {
      resolvedLocators += Number(error.detail?.locator_stats?.resolved || 0);
      rejected.push({
        index,
        subject_occurrence_used: Boolean(raw.subject_occurrence),
        reason: error.code || 'INVALID_CLAIM',
        detail: error.message,
        locator_stats: error.detail?.locator_stats || null,
        subject_ref_used: Boolean(raw.subject_ref),
        proposed_digest: sha256(canonical(proposed)),
      });
    }
  });
  const terminalReason = terminalIncompleteOnTruncation && !answer.completeness.complete
    ? { code: 'TRUNCATED_WINDOW', detail: answer.completeness.reason }
    : terminalIncompleteOnOverflow && capped.overflow
      ? { code: 'CLAIM_OVERFLOW', detail: `${capped.overflow.returned} claims exceed the declared cap ${capped.overflow.max_items}` }
      : null;
  const value = {
    window_id: window.id,
    claims,
    rejected,
    overflow: capped.overflow,
    truncated: !answer.completeness.complete,
    completeness: answer.completeness,
    wire_repairs: answer.repairs,
    locator_metrics: {
      proposed_claims: capped.retained.length,
      promoted_claims: claims.length,
      proposed_locators: proposedLocators,
      resolved_locators: resolvedLocators,
      failed_locators: Math.max(0, proposedLocators - resolvedLocators),
    },
  };
  if (terminalReason) {
    return {
      ok: false,
      reason: terminalReason.detail,
      error_code: terminalReason.code,
      terminal_incomplete: true,
      salvage: {
        schema: 'estate-map/non-promotable-window-salvage/v1',
        status: 'non_promotable',
        reason: terminalReason,
        ...value,
      },
    };
  }
  return { ok: true, value };
}

const unitKey = ({ window, prompt, model, thinking, provider_route, extractor, max_claims,
  custody_policy, materialization_label = null }) => {
  const identity = {
    policy: custody_policy,
    extractor,
    stage: 'wide-context-extraction',
    window_id: window.id,
    prompt_digest: sha256(prompt),
    model,
    thinking,
    provider_route,
    max_claims,
  };
  if (materialization_label) identity.explicit_materialization_label = materialization_label;
  return sha256(canonical(identity));
};

/**
 * Run wide-context extraction over a corpus. `runnerFactory` is injected by tests for zero spend.
 */
export async function runWideContextExtraction({
  root, documents, snapshot, bounds, checkpointPath, model, thinking = null,
  concurrency = 4, runnerFactory = null, provider_route = null,
  budget = null, window_ids = null, signal = null, contract: requestedContract = 'v10',
  materialization_label = null,
}) {
  if (!checkpointPath) throw new WideContextError('MISSING_CHECKPOINT', 'paid extraction requires a checkpoint');
  assertPreflight(bounds); // fail-closed on incoherent bounds BEFORE any dispatch
  const contract = normalizeContract(requestedContract);
  const contractGeneration = Number(contract.slice(1));
  const extractorVersion = EXTRACTOR_CONTRACTS[contract];
  const materializedAttempts = contract === 'v26' || contract === 'v28';
  const materializationLabel = materialization_label == null ? null : String(materialization_label).trim();
  if (materializationLabel && !materializedAttempts) {
    throw new WideContextError('EXPLICIT_MATERIALIZATION_UNSUPPORTED', 'an explicit materialization label requires a materialized v26/v28 contract');
  }
  if (materializationLabel && (materializationLabel.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(materializationLabel))) {
    throw new WideContextError('INVALID_MATERIALIZATION_LABEL', 'materialization label must be 1-160 safe identifier characters');
  }
  const extractorRuntime = materializedAttempts ? MATERIALIZATION_RUNTIME_VERSION : EXTRACTOR_RUNTIME_VERSION;
  const custodyPolicy = materializedAttempts ? MATERIALIZATION_ATTEMPT_CUSTODY_POLICY : INFERENCE_CUSTODY_POLICY;
  const attemptPolicy = materializedAttempts ? normalizeAttemptPolicy({
    max_attempts: bounds.max_attempts_per_unit ?? 2,
    retryable_outcomes: bounds.retryable_outcomes ?? ['error:provider'],
    backoff_ms: bounds.retry_backoff_ms ?? 1000,
    backoff_multiplier: bounds.retry_backoff_multiplier ?? 2,
    max_backoff_ms: bounds.retry_backoff_max_ms ?? 30000,
    jitter_ratio: bounds.retry_jitter_ratio ?? 0.1,
  }) : null;

  const prepasses = documents.map(d => prepassDocument({ path: d.path, content: d.content, source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest }));
  const namespace = buildMentionNamespace(prepasses);
  const prepassByFile = new Map(prepasses.map(prepass => [prepass.file, prepass]));
  const segmented = segmentCorpus({ documents, snapshot, window_bytes: bounds.window_bytes, overlap_bytes: bounds.overlap_bytes ?? null });

  // A window filter lets a gate replay EXACTLY the units that failed before, at their real size,
  // instead of inferring durability from fresh documents that never exercised the failure.
  const selected = window_ids
    ? segmented.windows.filter(window => new Set(window_ids).has(window.id))
    : segmented.windows;
  if (window_ids && selected.length !== new Set(window_ids).size) {
    throw new WideContextError('WINDOW_FILTER_UNRESOLVED',
      `requested ${new Set(window_ids).size} windows but segmentation produced ${selected.length}`,
      { requested: [...new Set(window_ids)], resolved: selected.map(window => window.id) });
  }
  if (materializedAttempts) {
    assertAttemptCapacity({
      logical_units: selected.length,
      max_calls: bounds.max_calls,
      max_known_cost_usd: bounds.max_known_cost_usd,
      cost_reserve_per_call_usd: bounds.cost_reserve_per_call_usd ?? 0,
      policy: attemptPolicy,
    });
  }

  const effectiveConcurrency = Math.max(1, Number(concurrency || 1));
  const providerRoute = String(provider_route || (runnerFactory ? 'injected' : 'pi-rpc'));
  const inferenceIdentity = Object.freeze({
    model,
    thinking: thinking == null ? null : String(thinking),
    provider_route: providerRoute,
    runner_implementation: runnerFactory ? 'injected' : PI_RPC_RUNNER_IMPLEMENTATION,
    effective_concurrency: effectiveConcurrency,
    custody_policy: custodyPolicy,
  });
  const checkpoint = await openCheckpointJournal({
    file: checkpointPath,
    fingerprint: {
      pipeline: WIDE_CONTEXT_SCHEMA, extractor: extractorVersion,
      extractor_runtime: extractorRuntime, extraction_contract: contract,
      inference_custody_policy: custodyPolicy,
      materialization_attempt_policy: attemptPolicy,
      source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest,
      model, thinking: inferenceIdentity.thinking, provider_route: providerRoute,
      runner_implementation: inferenceIdentity.runner_implementation,
      window_bytes: bounds.window_bytes,
      ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
    },
  });
  const runBudget = budget || createInferenceBudget({
    max_calls: bounds.max_calls, max_known_cost_usd: bounds.max_known_cost_usd,
    max_unpriced_attempts: bounds.max_unpriced_attempts ?? 3,
    cost_reserve_per_call_usd: bounds.cost_reserve_per_call_usd ?? 0,
  });

  const built = [];
  const makeRunner = runnerFactory || (() => createPiRpcRunner({ model, thinking, timeoutMs: bounds.call_timeout_ms, maxOutputBytes: bounds.max_event_bytes, maxAnswerBytes: bounds.max_answer_bytes, answerParser: parseModelJsonStream }));
  const runners = new Map();
  const runnerFor = worker => {
    if (!runners.has(worker)) { const r = makeRunner({ worker, model, thinking }); runners.set(worker, r); built.push(r); }
    return runners.get(worker);
  };

  const queue = createUnitQueue({
    units: selected.map(window => ({ id: window.id, payload: { window } })),
    lease_ms: bounds.lease_ms ?? Math.max(900000, (bounds.call_timeout_ms || 600000) * 2),
    fleet_stop: bounds.fleet_stop ?? { failure_rate: 0.5, min_samples: 6 },
  });

  const results = new Map();
  const terminalSalvage = new Map();
  const materializations = new Map();
  const attemptEvents = new Map();
  try {
    await runQueue({
      queue, concurrency: effectiveConcurrency, signal,
      worker_start_delay_ms: bounds.worker_start_delay_ms ?? 0,
      initial_worker_concurrency: bounds.initial_worker_concurrency ?? effectiveConcurrency,
      process: async (unit, worker) => {
        const { window } = unit.payload;
        const prepass = prepassByFile.get(window.file);
        const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
        const maxClaims = claimBudgetForWindow(window, bounds);
        const subjectOccurrences = contract !== 'v8' ? buildWindowSubjectOccurrences({
          prepass, catalog, limit: bounds.mention_menu_limit ?? 120,
          prefer_maximal_identifiers: contractGeneration >= 12,
          strip_qualified_line_ranges: contractGeneration >= 13,
          strict_qualified_code_spans: contractGeneration >= 16,
        }) : [];
        const subjectOccurrenceByRef = new Map(subjectOccurrences.map(occurrence => [occurrence.ref, occurrence]));
        const mentionByRef = contract === 'v8'
          ? new Map(prepass.mentions.map(mention => [mention.id.slice(0, 22), mention])) : new Map();
        const prompt = contract === 'v8'
          ? buildWindowPromptV8({
              window, catalog,
              mentionMenu: renderMentionMenu(prepass, { limit: bounds.mention_menu_limit ?? 120 }),
              max_claims: maxClaims,
            })
          : contract === 'v9' ? buildWindowPromptV9({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v12' ? buildWindowPromptV12({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v13' ? buildWindowPromptV13({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v14' ? buildWindowPromptV14({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v15' ? buildWindowPromptV15({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v16' ? buildWindowPromptV16({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v17' ? buildWindowPromptV17({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v18' ? buildWindowPromptV18({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contract === 'v19' ? buildWindowPromptV19({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : contractGeneration >= 20 ? buildWindowPromptV20({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            }) : buildWindowPrompt({
              window, catalog, subjectMenu: renderSubjectOccurrenceMenu(subjectOccurrences), max_claims: maxClaims,
            });
        const runner = runnerFor(worker);
        const completion = await runCustodiedInference({
          checkpoint, stage: 'wide-context', key: unitKey({
            window, prompt, model: runner.model, thinking: inferenceIdentity.thinking,
            provider_route: providerRoute, extractor: extractorVersion, max_claims: maxClaims,
            custody_policy: custodyPolicy, materialization_label: materializationLabel,
          }),
          tag: `extract:${window.id}`, prompt, runner, budget: runBudget,
          attempt_policy: attemptPolicy,
          materialization_dependencies: materializedAttempts ? {
            source_snapshot: snapshot.source_sha,
            corpus_digest: snapshot.corpus_digest,
            window_id: window.id,
            window_file: window.file,
            primary_block_addresses: window.primary_block_addresses,
            context_block_addresses: window.context_block_addresses,
            extractor: extractorVersion,
            model: runner.model,
            thinking: inferenceIdentity.thinking,
            provider_route: providerRoute,
            attempt_policy: attemptPolicy,
            ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
          } : null,
          on_attempt: materializedAttempts ? event => attemptEvents.set(event.attempt_id, event) : null,
          receipt_context: {
            worker_id: worker,
            controller_session_id: process.env.ASCRYBE_CONTROLLER_SESSION_ID || null,
          },
          validate: response => validateWindowResponse({
            response, window, catalog, namespace, mentionByRef, subjectOccurrenceByRef,
            modelIdentifier: runner.model, promptDigest: sha256(prompt), maxClaims,
            requireSubjectOccurrence: contract !== 'v8', recoverColocatedExplicit: contractGeneration >= 10,
            rejectOwnershipCollapse: contractGeneration >= 12,
            ignoreUnknownAdvisoryOccurrence: contractGeneration >= 13,
            preciseOwnershipCollapse: contractGeneration >= 13,
            rejectRoleOwnership: contractGeneration >= 14,
            preciseHeadingOwnership: contractGeneration >= 15,
            recoverExactUniqueLocators: contractGeneration >= 16,
            normalizeCatalogPrimaryRoles: contractGeneration >= 16,
            rejectIncompleteEvidenceFragments: contractGeneration >= 16,
            rejectRecoveredRoleOwnership: contractGeneration >= 17,
            rejectRecoveredSemanticCompleteness: contractGeneration >= 18,
            rejectRecoveredActiveHeadings: contractGeneration >= 19,
            rejectRecoveredCausativeHeadings: contractGeneration >= 20,
            recoverExactImplicitTopicQuotes: contractGeneration >= 22,
            rejectRecoveredImplicitTopicActors: contractGeneration >= 23,
            preserveDottedMemberIdentities: contractGeneration >= 24,
            preserveIndependentCommandWitnesses: contractGeneration >= 24,
            terminalIncompleteOnTruncation: contract === 'v28',
            terminalIncompleteOnOverflow: contract === 'v28',
            repairWhitespaceEquivalentLocators: contract === 'v28',
            preserveAuthoredSubjectSurfaces: contract === 'v28',
            useClaimV33: contract === 'v28',
          }),
        });
        if (completion.materialization) materializations.set(window.id, completion.materialization);
        // Recorded failures are preserved but do not re-open the current fleet circuit on resume.
        // Fresh failures throw from custody with a typed queue outcome and are handled by runQueue.
        if (completion.incomplete) {
          if (completion.materialization?.status === 'terminal_incomplete') {
            terminalSalvage.set(window.id, {
              window_id: window.id,
              materialization_id: completion.materialization?.materialization_id || null,
              status: 'terminal_incomplete',
              reason: completion.incomplete.validation?.error_code
                || completion.materialization.terminal_reason || completion.incomplete.reason,
              terminal_outcome: completion.materialization.terminal_outcome || completion.incomplete.outcome || null,
              salvage: completion.incomplete.validation?.salvage || null,
            });
          }
          return { outcome: 'quarantined', findings: [completion.incomplete] };
        }
        results.set(window.id, completion.validated);
        return {
          outcome: completion.validated.overflow ? 'overflow' : (completion.validated.rejected.length ? 'partial' : 'ok'),
          findings: completion.validated.rejected,
        };
      },
    });
    // A freshly exhausted provider result opens the inference circuit after its terminal
    // materialization has been durably written. `runQueue` correctly quarantines that unit, but
    // the throw means the normal return path above cannot copy the ledger into the aggregate.
    // Recover only the tool-owned terminal ledger embedded in the queue finding; this is
    // bookkeeping over an already-persisted attempt, never promotion or redispatch.
    for (const row of queue.rows()) {
      for (const finding of row.findings || []) {
        const materialization = finding?.detail?.materialization;
        if (materialization?.schema !== MATERIALIZATION_LEDGER_SCHEMA
          || materialization.status !== 'terminal_incomplete'
          || materialization.dependencies?.window_id !== row.id) continue;
        materializations.set(row.id, materialization);
        if (!terminalSalvage.has(row.id)) {
          terminalSalvage.set(row.id, {
            window_id: row.id,
            materialization_id: materialization.materialization_id,
            status: 'terminal_incomplete',
            reason: materialization.terminal_reason || 'incomplete paid result',
            terminal_outcome: materialization.terminal_outcome || null,
            salvage: null,
          });
        }
      }
    }
  } finally {
    await checkpoint.close();
    for (const runner of built) { try { await runner.shutdown?.(); } catch { /* best effort */ } }
  }

  const values = [...results.values()];
  const allClaims = values.flatMap(result => result.claims);
  const reduced = contract === 'v28' ? reduceClaimsV33(allClaims) : reduceClaimsV32(allClaims);
  const locatorTotals = values.reduce((totals, result) => {
    for (const field of Object.keys(totals)) totals[field] += Number(result.locator_metrics?.[field] || 0);
    return totals;
  }, { proposed_claims: 0, promoted_claims: 0, proposed_locators: 0, resolved_locators: 0, failed_locators: 0 });
  const status = queue.status();
  const budgetSnapshot = runBudget.snapshot();
  const corpusBytes = segmented.totals.primary_bytes;
  const selectedBytes = selected.reduce((sum, window) => sum + Number(window.primary_bytes || 0), 0);
  const paused = Boolean(signal?.aborted && (status.by_state?.pending || status.by_state?.leased));
  const body = {
    schema: WIDE_CONTEXT_SCHEMA,
    extractor: extractorVersion,
    extractor_runtime: extractorRuntime,
    extraction_contract: contract,
    snapshot,
    bounds,
    inference: inferenceIdentity,
    materialization: materializedAttempts ? {
      schema: MATERIALIZATION_LEDGER_SCHEMA,
      custody_policy: custodyPolicy,
      attempt_policy: attemptPolicy,
      logical_units: selected.length,
      finalized_units: materializations.size,
      selected_units: [...materializations.values()].filter(row => row.status === 'selected').length,
      terminal_incomplete_units: [...materializations.values()].filter(row => row.status === 'terminal_incomplete').length,
      attempts: attemptEvents.size,
      retries: [...materializations.values()].reduce((sum, row) => sum + Number(row.retry_count || 0), 0),
      recovered_after_retry: [...materializations.values()].filter(row => row.status === 'selected' && Number(row.selected_attempt) > 1).length,
      outcome_histogram: Object.entries([...attemptEvents.values()].reduce((counts, event) => {
        const outcome = event.outcome || 'missing';
        counts[outcome] = (counts[outcome] || 0) + 1;
        return counts;
      }, {})).sort((a, b) => a[0].localeCompare(b[0])),
      dependency_model: 'source-snapshot/window/extractor/model/route',
    } : null,
    segmentation: segmented.totals,
    // Windows are durable lineage, not disposable execution detail. Keeping the catalog makes every
    // claim unit_id resolvable and supports a deterministic document -> window -> claim projection.
    window_catalog: segmented.windows,
    window_conservation: segmented.receipts,
    queue: status,
    budget: budgetSnapshot,
    metrics: {
      ...(contract === 'v28' ? claimQualityMetricsV33(reduced) : claimQualityMetricsV32(reduced)),
      ...locatorTotals,
      locator_resolution_rate: locatorTotals.proposed_locators
        ? Number((locatorTotals.resolved_locators / locatorTotals.proposed_locators).toFixed(4))
        : null,
      claim_promotion_rate: locatorTotals.proposed_claims
        ? Number((locatorTotals.promoted_claims / locatorTotals.proposed_claims).toFixed(4))
        : null,
      promoted_locator_resolution_rate: allClaims.length ? 1 : null,
      raw_claims: allClaims.length,
      reduced_claims: reduced.length,
      rejected_claims: values.reduce((sum, result) => sum + result.rejected.length, 0),
      overflow_units: values.filter(result => result.overflow).length
        + [...terminalSalvage.values()].filter(row => row.salvage?.overflow).length,
      truncated_units: values.filter(result => result.truncated).length
        + [...terminalSalvage.values()].filter(row => row.salvage?.truncated).length,
      wire_repaired_lines: values.reduce((sum, result) => sum + Number(result.wire_repairs?.length || 0), 0),
      // Per-window yield: a window that silently returns far fewer claims than its size implies is
      // the signature of a truncated or degraded answer, which a corpus-wide average hides.
      claims_by_unit: Object.fromEntries(values.map(result => [result.window_id, result.claims.length]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      proposals_by_unit: Object.fromEntries(values.map(result => [result.window_id, Number(result.locator_metrics?.proposed_claims || 0)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      rejections_by_unit: Object.fromEntries(values.map(result => [result.window_id, result.rejected.length]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      locator_metrics_by_unit: Object.fromEntries(values.map(result => [result.window_id, result.locator_metrics]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      truncated_by_unit: Object.fromEntries(values.map(result => [result.window_id, Boolean(result.truncated)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      wire_repairs_by_unit: Object.fromEntries(values.map(result => [result.window_id, Number(result.wire_repairs?.length || 0)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      // Why locators fail matters more than how often: a mis-anchored subject is the Phase 3 defect
      // class recurring, whereas a quote-not-found is an addressing miss.
      rejection_codes: Object.entries(values.flatMap(result => result.rejected).reduce((counts, row) => {
        const code = row.reason || row.code || 'UNKNOWN';
        counts[code] = (counts[code] || 0) + 1;
        return counts;
      }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      // Efficiency uses the execution population, never the full catalog embedded for lineage.
      corpus_primary_bytes: corpusBytes,
      selected_primary_bytes: selectedBytes,
      selected_windows: selected.length,
      selected_documents: new Set(selected.map(window => window.file)).size,
      primary_bytes: selectedBytes,
      calls_per_kb: selectedBytes ? Number((budgetSnapshot.accounted_calls / (selectedBytes / 1024)).toFixed(4)) : null,
      usd_per_kb: selectedBytes ? Number((budgetSnapshot.known_cost_usd / (selectedBytes / 1024)).toFixed(6)) : null,
      claims_per_kb: selectedBytes ? Number((reduced.length / (selectedBytes / 1024)).toFixed(4)) : null,
    },
    claims: reduced,
    terminal_salvage: [...terminalSalvage.values()].sort((a, b) => a.window_id.localeCompare(b.window_id)),
    // A truncated window is silent recall loss, so it blocks the eventual `complete` verdict
    // exactly like an unpriced attempt or quarantine. A cooperative stop with pending work remains
    // lifecycle `paused` until resume reaches a terminal verdict.
    status: classifyWideContextResultStatus({
      paused, unpricedAttempts: budgetSnapshot.unpriced_attempts, queue: status,
      truncated: values.some(result => result.truncated),
      overflow: values.some(result => result.overflow)
        || [...terminalSalvage.values()].some(row => row.salvage?.overflow),
    }),
  };
  return Object.freeze({ ...body, digest: sha256(canonical({ ...body, claims: reduced.map(c => c.id) })) });
}

async function main() {
  const args = process.argv.slice(2), positional = [], options = {};
  for (let i = 0; i < args.length; i += 1) args[i].startsWith('--') ? options[args[i].slice(2)] = args[++i] : positional.push(args[i]);
  const [estateRoot] = positional;
  if (!estateRoot || !options.manifest || !options.checkpoint || !options.output) {
    throw new Error('usage: wide-context-extractor.mjs <estate-root> --manifest <json> --checkpoint <jsonl> --output <json> [--contract v8|v9|v10|v11|v12|v13|v14|v15|v16|v17|v18|v19|v20|v21|v22|v23|v24|v25|v26|v28]');
  }
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') {
    throw new WideContextError('PAID_GATE_CLOSED', 'set ASCRYBE_ENABLE_PAID_INFERENCE=1 to authorize paid extraction');
  }
  const manifest = JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8'));
  const root = await fs.realpath(estateRoot);
  const sourceSha = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (manifest.source_sha && sourceSha !== manifest.source_sha) throw new WideContextError('SOURCE_SHA_MISMATCH', `manifest ${manifest.source_sha}, estate ${sourceSha}`);
  const documents = [];
  for (const spec of manifest.documents) documents.push({ path: spec.path, content: await fs.readFile(path.join(root, spec.path), 'utf8') });
  const snapshot = { source_sha: sourceSha, corpus_digest: sha256(canonical(documents.map(d => ({ path: d.path, digest: sha256(d.content) })))) };
  const externalBounds = options.bounds ? JSON.parse(await fs.readFile(path.resolve(options.bounds), 'utf8')) : {};
  const bounds = { ...manifest.bounds, ...externalBounds };
  if (options['max-cost']) bounds.max_known_cost_usd = Number(options['max-cost']);
  if (options['worker-start-delay-ms'] != null) bounds.worker_start_delay_ms = Number(options['worker-start-delay-ms']);
  if (options['initial-worker-concurrency'] != null) bounds.initial_worker_concurrency = Number(options['initial-worker-concurrency']);
  const windowIdsValue = options['window-ids']
    ? JSON.parse(await fs.readFile(path.resolve(options['window-ids']), 'utf8')) : null;
  const windowIds = Array.isArray(windowIdsValue) ? windowIdsValue : windowIdsValue?.window_ids;
  if (options['window-ids'] && !Array.isArray(windowIds)) throw new Error('--window-ids must name a JSON array or {"window_ids": [...]}');
  const stop = installGracefulStop();
  let result;
  try {
    result = await runWideContextExtraction({
      root, documents, snapshot, bounds, checkpointPath: options.checkpoint,
      model: manifest.models.extraction, thinking: manifest.models.extraction_thinking,
      concurrency: Number(options.concurrency || bounds.concurrency || 4), window_ids: windowIds, signal: stop.signal,
      contract: options.contract || 'v10',
      materialization_label: options['materialization-label'] || null,
    });
  } finally { stop.dispose(); }
  const requestedOutput = path.resolve(options.output);
  const output = result.status === 'paused' ? `${requestedOutput}.paused-${Date.now()}.json` : requestedOutput;
  const temporary = `${output}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({ output, metrics: result.metrics, budget: result.budget, status: result.status, digest: result.digest }));
  if (result.status === 'paused') process.exitCode = 75;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
