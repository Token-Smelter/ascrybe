import { serializeFlatRelationAnswer } from '../tools/flat-relation-lines.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildWindowPrompt, buildWindowPromptV8, buildWindowPromptV9, buildWindowPromptV12, buildWindowPromptV13, buildWindowPromptV14, buildWindowPromptV15, buildWindowPromptV16, buildWindowPromptV17, buildWindowPromptV18, buildWindowPromptV19, buildWindowPromptV20, classifyWideContextResultStatus, runWideContextExtraction,
  validateWindowResponse,
} from '../tools/wide-context-extractor.mjs';
import { createWindowBlockCatalog } from '../tools/source-locator.mjs';
import { prepassDocument } from '../tools/source-prepass.mjs';
import { segmentDocument } from '../tools/wide-context-windows.mjs';
import { createNoRedispatchProvider } from '../tools/fake-provider.mjs';
import { createInferenceBudget } from '../tools/custodied-inference.mjs';
import { buildClaimSourceGraph } from '../tools/wide-context-claim-graph.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: 'digest' };
const docA = ['# Router', '', 'The router calls `propose_route(candidate)` on commit.', 'A case tracks each attempt.', ''].join('\n');
const docB = ['# Fence', '', 'The fence blocks late results.', ''].join('\n');
const documents = [{ path: 'a.md', content: docA }, { path: 'b.md', content: docB }];

const bounds = {
  window_bytes: 48 * 1024, max_claims_per_unit: 64,
  max_calls: 50, max_known_cost_usd: 5, max_unpriced_attempts: 3,
  call_timeout_ms: 600000, max_answer_bytes: 1048576, max_event_bytes: 67108864,
};

test('cooperative pause lifecycle takes precedence over recorded incomplete taint', () => {
  assert.equal(classifyWideContextResultStatus({
    paused: true, queue: { by_state: { done: 3, quarantined: 1, pending: 2 } },
  }), 'paused');
  assert.equal(classifyWideContextResultStatus({
    paused: false, queue: { by_state: { done: 5, quarantined: 1 } },
  }), 'incomplete');
  assert.equal(classifyWideContextResultStatus({
    paused: false, queue: { by_state: { done: 6 } },
  }), 'complete');
});

// A provider that answers with claims pinned to the window's own primary span.
const claimingRunner = ({
  perCall = 2, malformedIndex = null, extra = 0, omitOccurrence = false,
  wireTransform = value => value,
} = {}) => () => ({
  kind: 'fake', model: 'fake/extract',
  // stats() accumulates like a real runner so usd_per_kb is genuinely exercised, not assumed.
  _calls: [],
  async complete({ prompt }) {
    this._calls.push({ tag: 'fake', model: 'fake/extract', cost: 0.01, cost_reported: true, input_tokens: 10, output_tokens: 5, total_tokens: 15, billing_status: 'reported', accepted: true });
    const m = /\[(b\d{3}) PRIMARY ([^:]+):(\d+)-(\d+)\]/.exec(prompt);
    const file = m[2];
    const occurrenceRow = prompt.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(row => row?.subject_occurrence);
    assert.ok(occurrenceRow, 'the @10 prompt exposes an exact occurrence selector');
    const subjectSurface = occurrenceRow.surface;
    const blockToken = occurrenceRow.block;
    const sourceLocator = { block_token: blockToken, quote: subjectSurface, occurrence: 1 };
    const claims = Array.from({ length: perCall + extra }, (_, i) => ({
      subject_mention: { surface: subjectSurface, source_locator: sourceLocator },
      subject_binding: 'explicit', ...(!omitOccurrence ? { subject_occurrence: occurrenceRow.subject_occurrence } : {}),
      relation_family: 'other',
      predicate_family: `p${i}`, object_or_value: `v${i}`,
      polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
      support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: sourceLocator }] }],
    }));
    if (malformedIndex !== null && claims[malformedIndex]) delete claims[malformedIndex].predicate_family;
    return { text: wireTransform(serializeFlatRelationAnswer({ claims })), json: null, outcome: 'ok', accepted: true, billing_status: 'reported',
      usage: { cost: 0.01, cost_reported: true, input_tokens: 10, output_tokens: 5, total_tokens: 15 }, model: 'fake/extract' };
  },
  stats() {
    return { kind: 'fake', calls: this._calls.length, cost: Number(this._calls.reduce((s, c) => s + c.cost, 0).toFixed(6)), cost_status: 'complete', unpriced_attempts: 0, models: ['fake/extract'], per_call: this._calls.slice() };
  },
});

const legacyClaimingRunner = () => () => ({
  kind: 'fake', model: 'fake/extract', _calls: [],
  async complete({ prompt }) {
    this._calls.push({ tag: 'fake', model: this.model, cost: 0.01, cost_reported: true,
      input_tokens: 10, output_tokens: 5, total_tokens: 15, billing_status: 'reported', accepted: true });
    assert.match(prompt, /GROUNDED SUBJECT CANDIDATES/);
    assert.doesNotMatch(prompt, /PROMPT-LOCAL SUBJECT OCCURRENCES/);
    const source = /\[(b\d{3}) PRIMARY [^\]]+\]\n([^\n#][^\n]*)/.exec(prompt);
    const quote = source[2];
    const subject = quote.split(/\s+/).slice(0, 2).join(' ');
    const claims = [{
      subject_mention: { surface: subject, source_locator: { block_token: source[1], quote } },
      predicate_family: 'legacy_control', object_or_value: quote,
      polarity: 'affirmed', modality: 'descriptive', quantifier: 'one', scope: {}, valid_time: {},
      support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: source[1], quote } }] }],
    }];
    return { text: serializeFlatRelationAnswer({ claims }), json: null, outcome: 'ok', accepted: true,
      billing_status: 'reported', usage: { cost: 0.01, cost_reported: true, input_tokens: 10,
        output_tokens: 5, total_tokens: 15 }, model: this.model };
  },
  stats() { return { kind: 'fake', calls: this._calls.length, cost: this._calls.length * 0.01,
    cost_status: 'complete', unpriced_attempts: 0, models: [this.model], per_call: this._calls.slice() }; },
});

async function tmp(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `wce-${name}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the @10 window prompt carries exact block tokens and distinguishes literal subjects from topics', () => {
  const prepass = prepassDocument({ path: 'a.md', content: docA, ...snapshot });
  const { windows } = segmentDocument({ path: 'a.md', content: docA, snapshot });
  const catalog = createWindowBlockCatalog({ window: windows[0], inventories: [prepass.inventory] });
  const prompt = buildWindowPrompt({ window: windows[0], catalog, subjectMenu: '{"subject_occurrence":"s001","kind":"symbol","surface":"propose_route(candidate)","block":"b002","occurrence":1}', max_claims: 64 });
  assert.match(prompt, /PROMPT-LOCAL SUBJECT OCCURRENCES/);
  assert.match(prompt, /\[b\d{3} PRIMARY a\.md:1-\d+\]/);
  assert.match(prompt, /subject_occurrence[\s\S]*REQUIRED/);
  assert.match(prompt, /heading or container[\s\S]*implicit_topic/);
  assert.match(prompt, /under an id field whose pattern is X/);
  assert.match(prompt, /removing it would leave the claim[\s\S]{0,12}unsupported/);
  assert.match(prompt, /never author file\/line\/byte coordinates/);
  assert.doesNotMatch(prompt, /"span":\{"file"/, 'schema contains locators, not model coordinates');
  assert.doesNotMatch(prompt, /ROUTING HYPOTHESIS|concept_candidates|Arm:/, 'no planning channel exists in this path');
});

test('the failed-gate @9 model-visible contract remains frozen and selectable', () => {
  const prepass = prepassDocument({ path: 'a.md', content: docA, ...snapshot });
  const { windows } = segmentDocument({ path: 'a.md', content: docA, snapshot });
  const catalog = createWindowBlockCatalog({ window: windows[0], inventories: [prepass.inventory] });
  const prompt = buildWindowPromptV9({ window: windows[0], catalog, subjectMenu: '<fixture>', max_claims: 64 });
  assert.match(prompt, /For "implicit_topic",[\s\S]*governing heading\/table\/topic/);
  assert.doesNotMatch(prompt, /under an id field whose pattern is X/);
});

test('@11 provider repair changes inference identity without changing @10 model-visible bytes', async t => {
  const dir = await tmp(t, 'v11-provider-repair');
  const v10Checkpoint = path.join(dir, 'v10.jsonl');
  await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v10',
    checkpointPath: v10Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  const v11Checkpoint = path.join(dir, 'v11.jsonl');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v11',
    checkpointPath: v11Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.extraction_contract, 'v11');
  assert.equal(result.extractor, 'wide-context-extractor@11-provider-repair');
  const startedDigests = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(row => row.stage === 'wide-context-started').map(row => row.value.prompt_digest).sort();
  assert.deepEqual(await startedDigests(v11Checkpoint), await startedDigests(v10Checkpoint),
    'provider repair changes the unit identity but not the model-visible prompt');
});

test('@21 provider repair changes inference identity without changing @20 model-visible bytes or validation', async t => {
  const dir = await tmp(t, 'v21-provider-repair');
  const v20Checkpoint = path.join(dir, 'v20.jsonl');
  const v20 = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v20',
    checkpointPath: v20Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  const v21Checkpoint = path.join(dir, 'v21.jsonl');
  const v21 = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v21',
    checkpointPath: v21Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  assert.equal(v21.status, 'complete');
  assert.equal(v21.extraction_contract, 'v21');
  assert.equal(v21.extractor, 'wide-context-extractor@21-v20-provider-repair');
  assert.deepEqual(v21.claims.map(row => row.id), v20.claims.map(row => row.id),
    'provider repair retains the V20 deterministic validator');
  const startedDigests = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(row => row.stage === 'wide-context-started').map(row => row.value.prompt_digest).sort();
  assert.deepEqual(await startedDigests(v21Checkpoint), await startedDigests(v20Checkpoint),
    'provider repair changes the unit identity but not the V20 model-visible prompt');

  const v22Checkpoint = path.join(dir, 'v22.jsonl');
  const v22 = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v22',
    checkpointPath: v22Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  assert.equal(v22.extractor, 'wide-context-extractor@22-recovered-implicit-topic-quote');
  assert.deepEqual(await startedDigests(v22Checkpoint), await startedDigests(v20Checkpoint),
    'V22 retains the V20 model-visible prompt bytes');

  const v23Checkpoint = path.join(dir, 'v23.jsonl');
  const v23 = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v23',
    checkpointPath: v23Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  assert.equal(v23.extractor, 'wide-context-extractor@23-recovered-implicit-topic-actor');
  assert.deepEqual(await startedDigests(v23Checkpoint), await startedDigests(v20Checkpoint),
    'V23 retains the V20 model-visible prompt bytes');

  const v24Checkpoint = path.join(dir, 'v24.jsonl');
  const v24 = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v24',
    checkpointPath: v24Checkpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  assert.equal(v24.extractor, 'wide-context-extractor@24-qualified-member-identity');
  assert.deepEqual(await startedDigests(v24Checkpoint), await startedDigests(v20Checkpoint),
    'V24 retains the V20 model-visible prompt bytes');
});

test('@12 adds ownership and maximal-identity guidance without changing the frozen @10 prompt', () => {
  const prepass = prepassDocument({ path: 'a.md', content: docA, ...snapshot });
  const { windows } = segmentDocument({ path: 'a.md', content: docA, snapshot });
  const catalog = createWindowBlockCatalog({ window: windows[0], inventories: [prepass.inventory] });
  const args = { window: windows[0], catalog, subjectMenu: '<fixture>', max_claims: 64 };
  const v10 = buildWindowPrompt(args), v12 = buildWindowPromptV12(args);
  assert.notEqual(v12, v10);
  assert.match(v12, /longest exact source surface/);
  assert.match(v12, /A trigger\/event does[\s\S]*not perform an action/);
  assert.match(v12, /multiple witnesses[\s\S]*never assign their aggregate description/);
  assert.match(v12, /Do not infer a named implementation from[\s\S]*generic behavior/);
  const v13 = buildWindowPromptV13(args);
  assert.match(v13, /OMIT subject_occurrence/);
  assert.match(v13, /Never invent an sNNN value not shown below/);
  const v14 = buildWindowPromptV14(args);
  assert.match(v14, /A trigger\/event may trigger an effect but does not perform/);
  assert.match(v14, /Witness\/Evidence\/Proof citation is evidence, not the actor/);
  const v15 = buildWindowPromptV15(args);
  assert.match(v15, /An implicit section\/document topic is valid for anaphora/);
  assert.match(v15, /Do not turn analysis, recommendations, proposed experiments/);
  const v16 = buildWindowPromptV16(args);
  assert.match(v16, /cited evidence must itself contain the complete clause/);
  const v17 = buildWindowPromptV17(args);
  assert.match(v17, /when a local sentence or table cell names the actor or patient/);
  const v18 = buildWindowPromptV18(args);
  assert.match(v18, /preserve the full literal actor, including adjacent inline-code identifiers/);
  assert.match(v18, /normative requirement, prohibition, permission, or exact-reuse constraint/);
  const v19 = buildWindowPromptV19(args);
  assert.match(v19, /a heading may report, describe, or define its scoped content/);
  assert.match(v19, /do not rewrite the heading as limiting, making, modeling, transitioning, updating, or assigning/);
  const v20 = buildWindowPromptV20(args);
  assert.match(v20, /do not turn “X performs Y” into “the heading causes or forces X to perform Y/);
  assert.equal(buildWindowPromptV19(args), v19, 'the frozen V19 prompt is unchanged');
  assert.equal(buildWindowPromptV18(args), v18, 'the frozen V18 prompt is unchanged');
  assert.equal(buildWindowPromptV17(args), v17, 'the frozen V17 prompt is unchanged');
  assert.equal(buildWindowPromptV16(args), v16, 'the frozen V16 prompt is unchanged');
  assert.equal(buildWindowPromptV15(args), v15, 'the frozen V15 prompt is unchanged');
});

test('@16 recovers only exact-unique omitted block tokens and short-quote occurrences', () => {
  const content = '# Runtime\n\nWorkers drain queued work. Other work remains.\n';
  const document = { path: 'runtime.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
  const claim = {
    subject_binding: 'implicit_topic',
    subject_mention: { surface: 'Runtime', source_locator: { block_token: '', quote: '# Runtime' } },
    relation_family: 'capability', predicate_family: 'drains', object_or_value: 'queued work',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: paragraph.token, quote: 'queued work',
    } }] }],
  };
  const validate = recoverExactUniqueLocators => validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [claim] }) }, window, catalog,
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true, recoverExactUniqueLocators,
  });
  assert.equal(validate(false).value.rejected[0].reason, 'UNKNOWN_BLOCK_TOKEN');
  const recovered = validate(true);
  assert.equal(recovered.value.rejected.length, 0, JSON.stringify(recovered.value.rejected));
  assert.equal(recovered.value.claims[0].semantic.subject.source_locator.source_locator.block_token,
    catalog.entries.find(entry => entry.type === 'heading').token);
  assert.equal(recovered.value.claims[0].semantic.support_sets[0].locators[0].source_locator.occurrence, 1);

  const redundant = structuredClone(claim);
  redundant.support_sets[0].locators.unshift({ role: 'context', source_locator: {
    block_token: catalog.entries.find(entry => entry.type === 'heading').token,
    quote: '# Runtime', occurrence: 1,
  } });
  const redundantResult = validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [redundant] }) }, window, catalog,
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true, recoverExactUniqueLocators: true,
    normalizeCatalogPrimaryRoles: true,
  });
  assert.equal(redundantResult.value.rejected.length, 0, JSON.stringify(redundantResult.value.rejected));
  assert.equal(redundantResult.value.claims[0].semantic.support_sets[0].locators.length, 2);
  assert.ok(redundantResult.value.claims[0].semantic.support_sets[0].locators.every(row => row.role === 'primary'));

  const ambiguous = structuredClone(claim);
  ambiguous.support_sets[0].locators[0].source_locator.quote = 'work';
  const ambiguousResult = validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [ambiguous] }) }, window, catalog,
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true, recoverExactUniqueLocators: true,
  });
  assert.equal(ambiguousResult.value.rejected[0].reason, 'SHORT_QUOTE_REQUIRES_DISAMBIGUATOR');
});

test('v28 validation makes missing trailers, count mismatches, and overflow terminal-incomplete', () => {
  const content = '# Runtime\n\nWorkers drain queued work.\n';
  const document = { path: 'runtime.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
  const claim = {
    subject_binding: 'implicit_topic',
    subject_mention: { surface: 'Runtime', source_locator: {
      block_token: catalog.entries.find(entry => entry.type === 'heading').token,
      quote: '# Runtime', occurrence: 1,
    } },
    relation_family: 'capability', predicate_family: 'drains', object_or_value: 'queued work',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: paragraph.token, quote: paragraph.text,
    } }] }],
  };
  const complete = serializeFlatRelationAnswer({ claims: [claim] });
  const validate = (text, maxClaims = 4) => validateWindowResponse({
    response: { text }, window, catalog, modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims,
    terminalIncompleteOnTruncation: true, terminalIncompleteOnOverflow: true,
  });
  for (const text of [
    complete.split('\n').slice(0, -1).join('\n'),
    complete.replace(/"count":1/, '"count":2'),
  ]) {
    const result = validate(text);
    assert.equal(result.ok, false);
    assert.equal(result.terminal_incomplete, true);
    assert.equal(result.error_code, 'TRUNCATED_WINDOW');
    assert.equal(result.salvage.status, 'non_promotable');
    assert.equal(result.salvage.claims.length, 1, 'parseable prefix remains available only as salvage');
  }
  const overflow = validate(serializeFlatRelationAnswer({ claims: [claim, claim] }), 1);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error_code, 'CLAIM_OVERFLOW');
  assert.equal(overflow.salvage.claims.length, 2, 'every purchased parseable claim is retained in salvage');
});

test('v28 preserves a longer authored subject and uses the occurrence only as an anchor', () => {
  const content = '# Intake\n\nReceiver-owned `.catalog/intake.yaml` policy plus a generalized `intake_router@1.0` routes intake.\n';
  const document = { path: 'intake.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
  const authoredSurface = 'Receiver-owned `.catalog/intake.yaml` policy plus a generalized `intake_router@1.0`';
  const anchorSurface = '.catalog/intake.yaml';
  const anchorOffset = paragraph.text.indexOf(anchorSurface);
  const occurrence = {
    ref: 's001', id: 'subject-occurrence:intake', surface: anchorSurface,
    block_token: paragraph.token, occurrence: 1, file: document.path, lines: [paragraph.start],
    byte_start: paragraph.byte_start + Buffer.byteLength(paragraph.text.slice(0, anchorOffset)),
    byte_end: paragraph.byte_start + Buffer.byteLength(paragraph.text.slice(0, anchorOffset + anchorSurface.length)),
  };
  const claim = {
    subject_binding: 'explicit', subject_occurrence: 's001',
    subject_mention: { surface: authoredSurface, source_locator: {
      block_token: paragraph.token, quote: paragraph.text,
    } },
    relation_family: 'configuration', predicate_family: 'routes', object_or_value: 'intake',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: paragraph.token, quote: paragraph.text,
    } }] }],
  };
  const result = validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [claim] }) }, window, catalog,
    subjectOccurrenceByRef: new Map([['s001', occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, preserveAuthoredSubjectSurfaces: true, useClaimV33: true,
  });
  assert.equal(result.value.rejected.length, 0, JSON.stringify(result.value.rejected));
  const subject = result.value.claims[0].semantic.subject;
  assert.equal(subject.surface, authoredSurface);
  assert.equal(subject.authored_surface, authoredSurface);
  assert.equal(subject.resolved_surface, authoredSurface);
  assert.equal(subject.anchor_surface, anchorSurface);
  assert.equal(subject.binding.subject_occurrence_id, occurrence.id);
  assert.ok(result.value.claims[0].repair_findings.some(row => row.code === 'SUBJECT_SURFACE_PRESERVED_WITH_ANCHOR'));

  const conflict = structuredClone(claim);
  conflict.subject_mention.surface = 'Unrelated intake owner';
  const rejected = validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [conflict] }) }, window, catalog,
    subjectOccurrenceByRef: new Map([['s001', occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, preserveAuthoredSubjectSurfaces: true, useClaimV33: true,
  });
  assert.equal(rejected.value.claims.length, 0);
  assert.equal(rejected.value.rejected[0].reason, 'SUBJECT_OCCURRENCE_SURFACE_CONFLICT');
});

test('v28 whitespace recovery promotes exact source bytes and passes claim-source graph verification', () => {
  const content = '# Search\n\n`builtin/search.hill-climb` is informed greedy local improvement\nwith admissibility-gated keep-best behavior.\n';
  const document = { path: 'search.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
  const surface = 'builtin/search.hill-climb';
  const offset = paragraph.text.indexOf(surface);
  const occurrence = {
    ref: 's001', id: 'subject-occurrence:search', surface,
    block_token: paragraph.token, occurrence: 1, file: document.path, lines: [paragraph.start],
    byte_start: paragraph.byte_start + Buffer.byteLength(paragraph.text.slice(0, offset)),
    byte_end: paragraph.byte_start + Buffer.byteLength(paragraph.text.slice(0, offset + surface.length)),
  };
  const authoredEvidence = paragraph.text.replace('\n', ' ');
  const response = serializeFlatRelationAnswer({ claims: [{
    subject_binding: 'explicit', subject_occurrence: 's001',
    subject_mention: { surface, source_locator: {
      block_token: paragraph.token, quote: surface, occurrence: 1,
    } },
    relation_family: 'definition', predicate_family: 'is',
    object_or_value: 'informed greedy local improvement with admissibility-gated keep-best behavior',
    polarity: 'affirmed', modality: 'constitutive', quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: paragraph.token, quote: authoredEvidence,
    } }] }],
  }] });
  const result = validateWindowResponse({
    response: { text: response }, window, catalog,
    subjectOccurrenceByRef: new Map([['s001', occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverExactUniqueLocators: true,
    repairWhitespaceEquivalentLocators: true, preserveAuthoredSubjectSurfaces: true, useClaimV33: true,
  });
  assert.equal(result.value.rejected.length, 0, JSON.stringify(result.value.rejected));
  const claim = result.value.claims[0];
  const evidence = claim.semantic.support_sets[0].locators[0];
  assert.equal(evidence.text, paragraph.text);
  assert.equal(content.slice(evidence.byte_start, evidence.byte_end), paragraph.text);
  assert.ok(claim.repair_findings.some(row => row.code === 'WHITESPACE_EQUIVALENT_LOCATOR_REWRITTEN'));
  const graph = buildClaimSourceGraph({
    extraction: { snapshot, claims: [claim] }, windows: [window], documents: [document],
  });
  assert.equal(graph.metrics.lineage_complete, true, JSON.stringify(graph.findings));
  assert.equal(graph.findings.length, 0, JSON.stringify(graph.findings));
});

test('@16 rejects a sole primary evidence quote that ends mid-clause', () => {
  const content = '# Loop\n\nExtract keep-best findings from the search runtime.\n';
  const document = { path: 'loop.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const heading = catalog.entries.find(entry => entry.type === 'heading');
  const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
  const claim = {
    subject_binding: 'implicit_topic',
    subject_mention: { surface: 'Loop', source_locator: { block_token: heading.token, quote: heading.text, occurrence: 1 } },
    relation_family: 'composition', predicate_family: 'extracts', object_or_value: 'keep-best findings from the search runtime',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: paragraph.token, quote: 'Extract keep-best findings from the',
    } }] }],
  };
  const result = validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [claim] }) }, window, catalog,
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectIncompleteEvidenceFragments: true,
  });
  assert.equal(result.value.rejected[0].reason, 'INCOMPLETE_EVIDENCE_FRAGMENT');
});

function ownershipCollapseFixture(content, surface, predicate = 'grounds') {
  const document = { path: 'index.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const row = catalog.entries.find(entry => entry.text.includes(surface));
  const occurrence = { ref: 's001', id: `subject-occurrence:${surface}`, surface,
    block_token: row.token, occurrence: 1 };
  const response = { text: serializeFlatRelationAnswer({ claims: [{
    subject_binding: 'explicit', subject_occurrence: 's001',
    subject_mention: { surface, source_locator: { block_token: row.token, quote: surface, occurrence: 1 } },
    relation_family: 'capability', predicate_family: predicate, object_or_value: 'all listed concerns',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: row.token, quote: row.text } }] }],
  }] }) };
  return { response, window, catalog, occurrence };
}

test('@12 rejects a nested filename fragment as a truncated qualified identity', () => {
  const held = ownershipCollapseFixture(
    '# Index\n\n| `design/canon/orchestration-vision.md` | active features |\n', 'vision.md',
  );
  const result = validateWindowResponse({
    response: held.response, window: held.window, catalog: held.catalog,
    subjectOccurrenceByRef: new Map([['s001', held.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true, rejectOwnershipCollapse: true,
  });
  assert.equal(result.value.claims.length, 0);
  assert.equal(result.value.rejected[0].reason, 'QUALIFIED_IDENTITY_TRUNCATED');
});

test('@12 rejects assigning a multi-witness table row to one listed witness', () => {
  const held = ownershipCollapseFixture(
    '# Proof\n\n| 6 | `test/a.mjs`; `test/b.mjs` | CLI seam and projection |\n', 'a.mjs',
  );
  const result = validateWindowResponse({
    response: held.response, window: held.window, catalog: held.catalog,
    subjectOccurrenceByRef: new Map([['s001', held.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true, rejectOwnershipCollapse: true,
  });
  assert.equal(result.value.claims.length, 0);
  assert.equal(result.value.rejected[0].reason, 'MULTI_WITNESS_SUBJECT_COLLAPSE');
});

test('@13 ignores an unknown advisory selector on an implicit topic but not an explicit subject', () => {
  const content = '# Runtime\n\nWorkers drain queued work.\n';
  const document = { path: 'runtime.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const heading = catalog.entries.find(entry => entry.type === 'heading');
  const paragraph = catalog.entries.find(entry => entry.text.includes('Workers'));
  const proposed = {
    subject_binding: 'implicit_topic', subject_occurrence: 's999',
    subject_mention: { surface: 'Runtime', source_locator: { block_token: heading.token, quote: heading.text, occurrence: 1 } },
    relation_family: 'capability', predicate_family: 'governs', object_or_value: 'queued work',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: paragraph.token, quote: paragraph.text } }] }],
  };
  const validate = claim => validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [claim] }) }, window, catalog,
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    ignoreUnknownAdvisoryOccurrence: true,
  });
  const implicit = validate(proposed);
  assert.equal(implicit.value.claims.length, 1, JSON.stringify(implicit.value.rejected));
  const explicit = validate({ ...proposed, subject_binding: 'explicit' });
  assert.equal(explicit.value.claims.length, 0);
  assert.equal(explicit.value.rejected[0].reason, 'UNKNOWN_SUBJECT_OCCURRENCE');
});

test('@13 ownership guard considers multiple witnesses only inside the subject table cell', () => {
  const accepted = ownershipCollapseFixture(
    '# Proof\n\n| Validator rejects bad input through `schema.yaml`. | `tools/validate.mjs:10-20` |\n',
    'tools/validate.mjs',
  );
  const acceptedResult = validateWindowResponse({
    response: accepted.response, window: accepted.window, catalog: accepted.catalog,
    subjectOccurrenceByRef: new Map([['s001', accepted.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
  });
  assert.equal(acceptedResult.value.claims.length, 1);

  const rejected = ownershipCollapseFixture(
    '# Proof\n\n| CLI seam | `test/a.mjs`; `test/b.mjs` |\n', 'test/a.mjs',
  );
  const rejectedResult = validateWindowResponse({
    response: rejected.response, window: rejected.window, catalog: rejected.catalog,
    subjectOccurrenceByRef: new Map([['s001', rejected.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
  });
  assert.equal(rejectedResult.value.rejected[0].reason, 'MULTI_WITNESS_SUBJECT_COLLAPSE');
});

test('@13 truncated-identity guard permits a separately named directory but rejects a nested basename', () => {
  const directory = ownershipCollapseFixture(
    '# Shipping\n\n`plugins/parcel-dispatch/` ships via `plugins/parcel-dispatch/extensions/tools.ts`.\n', 'plugins/parcel-dispatch/',
  );
  const directoryResult = validateWindowResponse({
    response: directory.response, window: directory.window, catalog: directory.catalog,
    subjectOccurrenceByRef: new Map([['s001', directory.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
  });
  assert.equal(directoryResult.value.claims.length, 1);

  const basename = ownershipCollapseFixture(
    '# Index\n\n`design/canon/orchestration-vision.md` is active.\n', 'vision.md',
  );
  const basenameResult = validateWindowResponse({
    response: basename.response, window: basename.window, catalog: basename.catalog,
    subjectOccurrenceByRef: new Map([['s001', basename.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
  });
  assert.equal(basenameResult.value.rejected[0].reason, 'QUALIFIED_IDENTITY_TRUNCATED');
});

test('@24 preserves exact dotted members while retaining true filename truncation', () => {
  const validate = (held, preserveDottedMemberIdentities) => validateWindowResponse({
    response: held.response, window: held.window, catalog: held.catalog,
    subjectOccurrenceByRef: new Map([['s001', held.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
    preserveDottedMemberIdentities,
  });
  const exactMembers = [
    ['statements.listActiveParcels.all', '`statements.listActiveParcels.all()` walks every active Parcel.'],
    ['e.to', '`nodes.flatMap(n => n.edges.map(e => ({from:n.id,...e}))).filter(e => e.to === id)` computes incoming edges.'],
    ['n.id', '`nodes.flatMap(n => n.edges.map(e => ({from:n.id,...e})))` records the source id.'],
    ['verdict.status', '`verdict.status: "success"` records the sink outcome.'],
    ['worker.kind', '`worker.kind: parcel` selects the loop worker.'],
    ['verdict.status', '`verdict.status = computed.status` projects the computed status.'],
    ['work_type.delivery', '`resolved_delivery = work_type.delivery × project delivery profile` resolves delivery.'],
    ['n.edges.map', '`nodes.flatMap(n => n.edges.map(e => ({from:n.id,...e})))` maps the edges.'],
    ['workerSpec.kind', '`workerSpec.kind === "parcel"` selects startChildParcel.'],
    ['nodes.flatMap', '`nodes.flatMap(n => n.edges.map(e => ({from:n.id,...e})))` flattens the edges.'],
    ['artifact_ref.sha', '`git ls-tree <artifact_ref.sha> manifest.yaml` checks the manifest.'],
    ['acceptance.mode', '`acceptance.mode: structural_audit` folds in the audit.'],
    ['payload.json', '`record.payload.json = serialize(record)` stores the serialized payload.'],
    ['response.json', '`response.json === parsed.json` compares the response payload.'],
    ['template.md', '`render.template.md()` produces the documentation template.'],
    ['worker.kind', '`worker.kind: parcel` is the adopted loop primitive.'],
    ['computed.status', '`verdict.status = computed.status` supplies the projected status.'],
  ];
  for (const [subject, source] of exactMembers) {
    const member = ownershipCollapseFixture(`# Evidence\n\n${source}\n`, subject);
    assert.equal(validate(member, false).value.rejected[0].reason, 'QUALIFIED_IDENTITY_TRUNCATED');
    assert.equal(validate(member, true).value.claims.length, 1, subject);
  }

  const trueTruncations = [
    ['cross-session-tools.ts', '`src/runtime/cross-session-tools.ts` loads unconditionally.'],
    ['env.example', '`.env.example` has no runtime effect until copied.'],
    ['REPORT.md', '`VALIDATION-REPORT.md` records validation counts.'],
    ['dashboard-bridge.ts', '`src/runtime/dashboard-bridge.ts` loads unconditionally.'],
    ['service.proto', '`schemas/service.proto` defines the service schema.'],
    ['My File.md', '`docs/My File.md` is the generated report.'],
  ];
  for (const [subject, source] of trueTruncations) {
    const filename = ownershipCollapseFixture(`# Index\n\n${source}\n`, subject);
    const result = validate(filename, true);
    assert.equal(result.value.claims.length, 0, subject);
    assert.equal(result.value.rejected[0].reason, 'QUALIFIED_IDENTITY_TRUNCATED', subject);
  }
});

test('@24 treats independently predicated shell commands as commands, not collapsed file witnesses', () => {
  const command = ownershipCollapseFixture(
    '# Docs\n\n| AC-DOCS | `node scripts/map.mjs` and `node scripts/index.mjs` pass. |\n',
    'node scripts/map.mjs', 'passes',
  );
  const validate = preserveIndependentCommandWitnesses => validateWindowResponse({
    response: command.response, window: command.window, catalog: command.catalog,
    subjectOccurrenceByRef: new Map([['s001', command.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
    preserveIndependentCommandWitnesses,
  });
  assert.equal(validate(false).value.rejected[0].reason, 'MULTI_WITNESS_SUBJECT_COLLAPSE');
  assert.equal(validate(true).value.claims.length, 1);

  const files = ownershipCollapseFixture(
    '# Proof\n\n| CLI seam | `test/a.mjs`; `test/b.mjs` |\n', 'test/a.mjs',
  );
  const fileResult = validateWindowResponse({
    response: files.response, window: files.window, catalog: files.catalog,
    subjectOccurrenceByRef: new Map([['s001', files.occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
    preserveIndependentCommandWitnesses: true,
  });
  assert.equal(fileResult.value.rejected[0].reason, 'MULTI_WITNESS_SUBJECT_COLLAPSE');

  for (const [source, subject] of [
    ['# Proof\n\n| Files | `docs/My File.md`; `docs/Other File.md` pass. |\n', 'docs/My File.md'],
    ['# Proof\n\n| Commands | `node scripts/a.mjs`; `node scripts/b.mjs` |\n', 'node scripts/a.mjs'],
  ]) {
    const held = ownershipCollapseFixture(source, subject);
    const result = validateWindowResponse({
      response: held.response, window: held.window, catalog: held.catalog,
      subjectOccurrenceByRef: new Map([['s001', held.occurrence]]),
      modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
      requireSubjectOccurrence: true, recoverColocatedExplicit: true,
      rejectOwnershipCollapse: true, preciseOwnershipCollapse: true,
      preserveIndependentCommandWitnesses: true,
    });
    assert.equal(result.value.rejected[0].reason, 'MULTI_WITNESS_SUBJECT_COLLAPSE', subject);
  }
});

function validateRoleFixture({ content, subject, subjectBinding = 'explicit', predicate, object,
  relation = 'capability', preciseHeadingOwnership = false, evidenceQuote = null,
  recoverExactUniqueLocators = false, rejectRecoveredRoleOwnership = false,
  rejectRecoveredSemanticCompleteness = false, rejectRecoveredActiveHeadings = false,
  rejectRecoveredCausativeHeadings = false,
  recoverExactImplicitTopicQuotes = false,
  rejectRecoveredImplicitTopicActors = false,
  omitSubjectOccurrenceDisambiguator = false,
  implicitSubjectInEvidence = false, subjectQuote = null, modality = 'descriptive' }) {
  const document = { path: 'roles.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const evidence = subjectBinding === 'implicit_topic'
    ? catalog.entries.find(entry => entry.type !== 'heading' && entry.text.trim())
    : catalog.entries.find(entry => entry.text.includes(subject) && entry.type !== 'heading');
  const subjectBlock = subjectBinding === 'implicit_topic' && !implicitSubjectInEvidence
    ? catalog.entries.find(entry => entry.type === 'heading') : evidence;
  const occurrence = { ref: 's001', id: `subject-occurrence:${subject}`, surface: subject,
    block_token: subjectBlock.token, occurrence: 1 };
  const claim = {
    subject_binding: subjectBinding,
    ...(subjectBinding === 'explicit' ? { subject_occurrence: 's001' } : {}),
    subject_mention: { surface: subject, source_locator: {
      block_token: subjectBlock.token,
      quote: subjectQuote === null ? (subjectBlock.type === 'heading' ? subjectBlock.text : subject) : subjectQuote,
      ...(!omitSubjectOccurrenceDisambiguator ? { occurrence: 1 } : {}),
    } },
    relation_family: relation, predicate_family: predicate, object_or_value: object,
    polarity: 'affirmed', modality, quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: {
      block_token: evidence.token, quote: evidenceQuote || evidence.text,
    } }] }],
  };
  return validateWindowResponse({
    response: { text: serializeFlatRelationAnswer({ claims: [claim] }) }, window, catalog,
    subjectOccurrenceByRef: implicitSubjectInEvidence ? new Map() : new Map([['s001', occurrence]]),
    modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    rejectOwnershipCollapse: true, preciseOwnershipCollapse: true, rejectRoleOwnership: true,
    preciseHeadingOwnership, recoverExactUniqueLocators, rejectRecoveredRoleOwnership,
    rejectRecoveredSemanticCompleteness, rejectRecoveredActiveHeadings, rejectRecoveredCausativeHeadings,
    recoverExactImplicitTopicQuotes,
    rejectRecoveredImplicitTopicActors,
  });
}

test('@14 rejects an object or citation selected after its own predicate', () => {
  const result = validateRoleFixture({
    content: '# Checks\n\n`code-change` requires those IDs (`plugins/parcel-example-15/code-change.yaml:1-10`).\n',
    subject: 'plugins/parcel-example-15/code-change.yaml', predicate: 'requires', object: 'those IDs', relation: 'requirement',
  });
  assert.equal(result.value.rejected[0].reason, 'SUBJECT_OCCURS_AFTER_PREDICATE');
});

test('@14 rejects a trigger inheriting an action from the effect table cell', () => {
  const result = validateRoleFixture({
    content: '# Lifecycle\n\n| State | Durable trigger | Effect |\n|---|---|---|\n| `reconciling` | `registration.completed` | Return to registered; never mutates declarations. |\n',
    subject: 'registration.completed', predicate: 'never mutates', object: 'declarations', relation: 'prohibition',
  });
  assert.equal(result.value.rejected[0].reason, 'TABLE_TRIGGER_EFFECT_OWNERSHIP');
});

test('@14 rejects discourse labels and headings that displace a stated actor', () => {
  const deictic = validateRoleFixture({
    content: '# Failure\n\n**THIS** is the catastrophic failure mode.\n',
    subject: 'THIS', predicate: 'is', object: 'the catastrophic failure mode', relation: 'classification',
  });
  assert.equal(deictic.value.rejected[0].reason, 'DISCOURSE_LABEL_NOT_ENTITY');

  const heading = validateRoleFixture({
    content: '# Concrete Example: Endpoint Integration\n\nThe local agent pre-analyzes the document.\n',
    subject: 'Concrete Example: Endpoint Integration', subjectBinding: 'implicit_topic',
    predicate: 'pre-analyzes', object: 'the document',
  });
  assert.equal(heading.value.rejected[0].reason, 'IMPLICIT_HEADING_DISPLACED_ACTOR');
});

test('@15 abstains on valid topic scope and rejects precise presentation and causative inversions', () => {
  const anaphor = validateRoleFixture({
    content: '# Parcelworks\n\nIts outer shell is rigid.\n', subject: 'Parcelworks',
    subjectBinding: 'implicit_topic', predicate: 'has an outer shell that is', object: 'rigid',
    preciseHeadingOwnership: true,
  });
  assert.equal(anaphor.value.claims.length, 1);
  const discourse = validateRoleFixture({
    content: '# Why (each scar, briefly)\n\nA census found abandoned work streams.\n',
    subject: 'Why (each scar, briefly)', subjectBinding: 'implicit_topic',
    predicate: 'reports that a census found', object: 'abandoned work streams', preciseHeadingOwnership: true,
  });
  assert.equal(discourse.value.claims.length, 1);
  const operation = validateRoleFixture({
    content: '# Concrete Example: Endpoint Integration\n\nThe local agent pre-analyzes the document.\n',
    subject: 'Concrete Example: Endpoint Integration', subjectBinding: 'implicit_topic',
    predicate: 'pre-analyzes', object: 'the document', preciseHeadingOwnership: true,
  });
  assert.equal(operation.value.rejected[0].reason, 'PRESENTATION_HEADING_NOT_OPERATIONAL_ACTOR');
  const causative = validateRoleFixture({
    content: '# The ladder\n\nThe gate reads evidence, not reputations.\n',
    subject: 'The ladder', subjectBinding: 'implicit_topic', predicate: 'makes the gate read',
    object: 'evidence, not reputations', preciseHeadingOwnership: true,
  });
  assert.equal(causative.value.rejected[0].reason, 'CAUSATIVE_ACTOR_INVERSION');
});

test('@15 rejects active/passive role reversal and explicit assignment away from the topic', () => {
  const passive = validateRoleFixture({
    content: '# Parcelworks\n\nEvery parcel is anchored to a crate or a shelf.\n',
    subject: 'Parcelworks', subjectBinding: 'implicit_topic', predicate: 'anchors',
    object: 'every stored parcel to a crate or shelf', preciseHeadingOwnership: true,
  });
  assert.equal(passive.value.rejected[0].reason, 'PASSIVE_TO_ACTIVE_OWNERSHIP_REVERSAL');
  const contrast = validateRoleFixture({
    content: '# Parcelworks\n\nWhat is not replicable: the packing stencils. Those travel with the artisan, not the product.\n',
    subject: 'Parcelworks', subjectBinding: 'implicit_topic', predicate: 'has non-replicable assets',
    object: 'the packing stencils', preciseHeadingOwnership: true,
    evidenceQuote: 'What is not replicable: the packing stencils.',
  });
  assert.equal(contrast.value.rejected[0].reason, 'EXPLICIT_TOPIC_EXCLUSION_REVERSED');
  const localQuote = validateRoleFixture({
    content: '# Parcelworks\n\nA small workshop could rebuild the cabinet in two weeks. The cabinet has three shelves. What is not replicable is the packing stencil. Those travel with the artisan, not the product.\n',
    subject: 'Parcelworks', subjectBinding: 'implicit_topic', predicate: 'could be rebuilt by',
    object: 'a small workshop in two weeks', preciseHeadingOwnership: true,
    evidenceQuote: 'A small workshop could rebuild the cabinet in two weeks',
  });
  assert.equal(localQuote.value.claims.length, 1);
});

test('@17 rejects recovered headings that displace the literal actor but preserves topic policy', () => {
  const displaced = validateRoleFixture({
    content: '# Exhaustion\n\nWhen retries stop, recipe engine durably commits the terminal sequence.\n',
    subject: 'Exhaustion', subjectBinding: 'implicit_topic', predicate: 'commits the terminal sequence',
    object: 'when retries stop', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(displaced.value.rejected[0].reason, 'RECOVERED_HEADING_DISPLACED_ACTOR');

  const literal = validateRoleFixture({
    content: '# One object\n\nOne object gives the outbox command a single compare-and-set unit.\n',
    subject: 'One object', subjectBinding: 'implicit_topic', predicate: 'gives the outbox command',
    object: 'a single compare-and-set unit', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(literal.value.rejected[0].reason, 'RECOVERED_LITERAL_ACTOR_REQUIRES_EXPLICIT');

  const policy = validateRoleFixture({
    content: '# 2. State Isolation\n\nPer-aggregate serialization via mutex prevents concurrent handlers from racing.\n',
    subject: '2. State Isolation', subjectBinding: 'implicit_topic',
    predicate: 'uses per-aggregate serialization', object: 'to prevent concurrent races',
    preciseHeadingOwnership: true, recoverExactUniqueLocators: true,
    rejectRecoveredRoleOwnership: true, omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(policy.value.claims.length, 1, JSON.stringify(policy.value.rejected));

  const anaphor = validateRoleFixture({
    content: '# AC Contract\n\nThis proposal promotes the AC to a first-class contract object.\n',
    subject: 'AC Contract', subjectBinding: 'implicit_topic', predicate: 'promotes the AC to',
    object: 'a first-class contract object', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(anaphor.value.claims.length, 1, JSON.stringify(anaphor.value.rejected));
});

test('@17 rejects recovered presentation, possessive-patient, assignment-away, and fragment inversions', () => {
  const properties = validateRoleFixture({
    content: '# Properties\n\n**Cardinality is many-to-many with items.** An item can belong to multiple Initiatives.\n',
    subject: 'Properties', subjectBinding: 'implicit_topic', predicate: 'gives item membership',
    object: 'many-to-many cardinality across Initiatives',
    preciseHeadingOwnership: true, recoverExactUniqueLocators: true,
    rejectRecoveredRoleOwnership: true, omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(properties.value.rejected[0].reason, 'RECOVERED_PRESENTATION_LABEL_NOT_ACTOR');

  const patient = validateRoleFixture({
    content: '# Tool surface\n\n`suggest_initiatives` is the LLM-backed tool. Per policy, its suggestions are *prepared asynchronously*.\n',
    subject: 'Tool surface', subjectBinding: 'implicit_topic', predicate: 'prepares suggestions',
    object: 'asynchronously', preciseHeadingOwnership: true, recoverExactUniqueLocators: true,
    rejectRecoveredRoleOwnership: true, omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(patient.value.rejected[0].reason, 'RECOVERED_HEADING_DISPLACED_ACTOR');

  const assignment = validateRoleFixture({
    content: '# Stub\n\nAll design content now lives in the consolidated document.\n', subject: 'Stub',
    subjectBinding: 'implicit_topic', predicate: 'has design content', object: 'storage and sync',
    preciseHeadingOwnership: true, recoverExactUniqueLocators: true,
    rejectRecoveredRoleOwnership: true, omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(assignment.value.rejected[0].reason, 'RECOVERED_ASSIGNMENT_AWAY_FROM_TOPIC');

  const fragment = validateRoleFixture({
    content: '# AC\n\n- the durable proof reference returns 404 with no replacement.\n', subject: 'AC',
    subjectBinding: 'implicit_topic', predicate: 'becomes stale when',
    object: 'the durable proof reference returns 404', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    omitSubjectOccurrenceDisambiguator: true,
  });
  assert.equal(fragment.value.rejected[0].reason, 'RECOVERED_CONDITION_FRAGMENT_LACKS_RELATION');
});

test('@18 rejects residual uncited norms, heading causes, ordering rewrites, and identifier shortening', () => {
  const shared = {
    subjectBinding: 'implicit_topic', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    rejectRecoveredSemanticCompleteness: true, omitSubjectOccurrenceDisambiguator: true,
  };
  const norm = validateRoleFixture({
    ...shared, content: '# Snapshot\n\nA real per-WO mutex already exists: `withWoLocks` calls `storage.withLock(id)`.\n',
    subject: 'Snapshot', predicate: 'requires reuse of', object: 'the exact withWoLocks lock',
    modality: 'normative',
  });
  assert.equal(norm.value.rejected[0].reason, 'RECOVERED_NORMATIVE_FORCE_UNCITED');

  const actor = validateRoleFixture({
    ...shared, content: '# Purpose\n\nThe substrate makes agents portable. The orchestration vision makes work portable.\n',
    subject: 'Purpose', predicate: 'makes', object: 'work portable',
  });
  assert.equal(actor.value.rejected[0].reason, 'RECOVERED_HEADING_DISPLACED_ACTOR');

  const order = validateRoleFixture({
    ...shared, content: '# Snapshot\n\nInfrastructure block handling runs before Pattern matching.\n',
    subject: 'Snapshot', predicate: 'places infrastructure block handling', object: 'before Pattern matching',
  });
  assert.equal(order.value.rejected[0].reason, 'RECOVERED_CAUSATIVE_ACTOR_INVERSION');

  const identity = validateRoleFixture({
    ...shared, content: '# Issue\n\nBulk `remove_sessions` skips cleanup, leaving tailers running.\n',
    subject: 'Bulk remove', subjectQuote: 'Bulk `remove_sessions`', implicitSubjectInEvidence: true,
    predicate: 'leaves', object: 'tailers running',
  });
  assert.equal(identity.value.rejected[0].reason, 'RECOVERED_LITERAL_IDENTITY_TRUNCATED');
});

test('@19 rejects exact-recovered active-heading rewrites without rejecting heading-scoped description', () => {
  const shared = {
    subjectBinding: 'implicit_topic', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    rejectRecoveredSemanticCompleteness: true, rejectRecoveredActiveHeadings: true,
    omitSubjectOccurrenceDisambiguator: true,
  };
  const fixtures = [
    { content: '# Grounding snapshot\n\nPost-BLOCKED late result is accepted only for `liveness_watchdog`, the last worker, and no replacement.\n', subject: 'Grounding snapshot', predicate: 'limits post-BLOCKED late result acceptance to', object: 'liveness_watchdog, the last worker, and no replacement', reason: 'RECOVERED_HEADING_NOT_POLICY_ACTOR' },
    { content: '# New state\n\n`STALLED → REPAIRING` is the linearization point for repair ownership.\n', subject: 'New state', predicate: 'makes', object: 'STALLED → REPAIRING the linearization point', reason: 'RECOVERED_HEADING_CAUSATIVE_REWRITE' },
    { content: '# Exhaustion\n\n`fail_parcel_repair` — compare the fence, transition `STALLED|REPAIRING → FAILED`, and emit once.\n', subject: 'Exhaustion', predicate: 'transitions', object: 'STALLED|REPAIRING → FAILED', reason: 'RECOVERED_HEADING_DISPLACED_ACTOR' },
    { content: '# Properties\n\n- **Nestable.** Initiatives form a tree via `parent_initiative_id`.\n', subject: 'Properties', predicate: 'makes Initiatives', object: 'nestable in a tree', reason: 'RECOVERED_HEADING_CAUSATIVE_REWRITE' },
    { content: '# 14. Maintenance\n\n1. trigger one\n2. trigger two\n', subject: '14. Maintenance', predicate: 'updates when', object: 'trigger one or trigger two', reason: 'RECOVERED_GOVERNING_CLAUSE_UNCITED' },
    { content: '# Purpose\n\nKestrel is the runtime for all agentic activity.\n', subject: 'Purpose', predicate: 'models all agentic activity', object: 'as runtime work', reason: 'RECOVERED_HEADING_DISPLACED_ACTOR' },
    { content: '# Log is not memory\n\nThe event log is memory\'s substrate, not memory itself.\n', subject: 'Log is not memory', predicate: 'makes', object: 'the event log memory\'s substrate', reason: 'RECOVERED_HEADING_CAUSATIVE_REWRITE' },
    { content: '# DDD Mapping\n\nEach aggregate is owned by one plugin.\n', subject: 'DDD Mapping', predicate: 'assigns ownership', object: 'of each aggregate to one plugin', reason: 'RECOVERED_REPRESENTATION_NOT_ASSIGNER' },
  ];
  for (const fixture of fixtures) {
    const result = validateRoleFixture({ ...shared, ...fixture });
    assert.equal(result.value.rejected[0]?.reason, fixture.reason,
      `${fixture.subject}: ${JSON.stringify(result.value.rejected)}`);
  }
  const valid = validateRoleFixture({
    ...shared, content: '# Grounding snapshot\n\nThe registered state machine has no repair state.\n',
    subject: 'Grounding snapshot', predicate: 'states that the registered state machine has no',
    object: 'repair state',
  });
  assert.equal(valid.value.claims.length, 1, JSON.stringify(valid.value.rejected));
});

test('@20 rejects a recovered heading made to cause its local actor action', () => {
  const shared = {
    subjectBinding: 'implicit_topic', preciseHeadingOwnership: true,
    recoverExactUniqueLocators: true, rejectRecoveredRoleOwnership: true,
    rejectRecoveredSemanticCompleteness: true, rejectRecoveredActiveHeadings: true,
    rejectRecoveredCausativeHeadings: true, omitSubjectOccurrenceDisambiguator: true,
  };
  const inversion = validateRoleFixture({
    ...shared, content: '# New state\n\nPattern evaluation ignores `REPAIRING`; it is neither terminal nor a human-attention state.\n',
    subject: 'New state', predicate: 'causes Pattern evaluation to ignore', object: 'REPAIRING',
  });
  assert.equal(inversion.value.rejected[0]?.reason, 'RECOVERED_HEADING_CAUSATIVE_REWRITE',
    JSON.stringify(inversion.value.rejected));
  const explicitCause = validateRoleFixture({
    ...shared, content: '# New state\n\nThe new state causes Pattern evaluation to ignore `REPAIRING`.\n',
    subject: 'New state', predicate: 'causes Pattern evaluation to ignore', object: 'REPAIRING',
  });
  assert.equal(explicitCause.value.claims.length, 1, JSON.stringify(explicitCause.value.rejected));
});

test('@22 recovers only an omitted implicit-topic quote with one exact surface in its declared block', () => {
  const shared = {
    content: '# Recovery\n\nThe runtime restores sessions.\n', subject: 'Recovery',
    subjectBinding: 'implicit_topic', subjectQuote: '', predicate: 'describes',
    object: 'the runtime restores sessions', recoverExactUniqueLocators: true,
    rejectRecoveredRoleOwnership: true, rejectRecoveredSemanticCompleteness: true,
    rejectRecoveredActiveHeadings: true, rejectRecoveredCausativeHeadings: true,
  };
  const baseline = validateRoleFixture(shared);
  assert.equal(baseline.value.rejected[0].reason, 'EMPTY_LOCATOR_QUOTE');
  const recovered = validateRoleFixture({ ...shared, recoverExactImplicitTopicQuotes: true });
  assert.equal(recovered.value.claims.length, 1, JSON.stringify(recovered.value.rejected));
  assert.equal(recovered.value.claims[0].semantic.subject.source_locator.source_locator.quote, 'Recovery');
  assert.equal(recovered.value.claims[0].semantic.subject.source_locator.source_locator.occurrence, 1);

  const ambiguous = validateRoleFixture({
    ...shared, content: '# Recovery Recovery\n\nThe runtime restores sessions.\n',
    recoverExactImplicitTopicQuotes: true,
  });
  assert.equal(ambiguous.value.rejected[0].reason, 'EMPTY_LOCATOR_QUOTE');
});

test('@23 rejects recovered scenario, exception, and relative-clause actors without changing V22 recovery', () => {
  const shared = {
    subjectBinding: 'implicit_topic', subjectQuote: '', recoverExactUniqueLocators: true,
    recoverExactImplicitTopicQuotes: true, rejectRecoveredRoleOwnership: true,
    rejectRecoveredSemanticCompleteness: true, rejectRecoveredActiveHeadings: true,
    rejectRecoveredCausativeHeadings: true,
  };
  const scenario = {
    ...shared, content: '# When the substrate restarts:\n\n1. `runRecovery()` auto-respawns sessions.\n',
    subject: 'When the substrate restarts:', predicate: 'auto-respawns sessions',
    object: 'standard recovery', relation: 'lifecycle',
  };
  assert.equal(validateRoleFixture(scenario).value.claims.length, 1);
  assert.equal(validateRoleFixture({ ...scenario, rejectRecoveredImplicitTopicActors: true })
    .value.rejected[0].reason, 'RECOVERED_SCENARIO_LABEL_NOT_ACTOR');

  const exception = {
    ...shared, content: '# Exceptions that still unregister:\n\n- Clean exits\n- Explicit termination\n',
    subject: 'Exceptions that still unregister:', predicate: 'still unregisters entries for',
    object: 'clean exits and explicit termination', relation: 'prohibition',
  };
  assert.equal(validateRoleFixture({ ...exception, rejectRecoveredImplicitTopicActors: true })
    .value.rejected[0].reason, 'RECOVERED_EXCEPTION_LABEL_NOT_ACTOR');

  const relativeActor = {
    ...shared, content: '# RPC Sidecar Lifetime\n\nThe sidecar runs an orphan timer that starts whenever `activeClient` is null.\n',
    subject: 'RPC Sidecar Lifetime', predicate: 'starts an orphan timer when',
    object: '`activeClient` is null', relation: 'lifecycle',
  };
  assert.equal(validateRoleFixture({ ...relativeActor, rejectRecoveredImplicitTopicActors: true })
    .value.rejected[0].reason, 'RECOVERED_HEADING_DISPLACED_ACTOR');
});

test('@10 deterministically upgrades a unique literal subject co-located with primary evidence', () => {
  const content = ['# Workflow', '', 'New decisions start here and migrate to `canon/` when stable.', ''].join('\n');
  const document = { path: 'workflow.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.text.includes('New decisions'));
  const sentence = paragraph.text;
  const response = { text: serializeFlatRelationAnswer({ claims: [{
    subject_binding: 'unresolved',
    subject_mention: { surface: 'New decisions', source_locator: { block_token: paragraph.token, quote: sentence } },
    relation_family: 'lifecycle', predicate_family: 'migrate to', object_or_value: 'canon/ when stable',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: paragraph.token, quote: sentence } }] }],
  }] }) };
  const result = validateWindowResponse({
    response, window, catalog, modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.rejected.length, 0);
  assert.equal(result.value.claims[0].semantic.subject.binding.kind, 'explicit');
  assert.match(result.value.claims[0].semantic.subject.binding.subject_occurrence_id, /^subject-occurrence:/);
  assert.equal(result.value.claims[0].semantic.subject.literal_surface, 'New decisions');
});

test('@10 does not upgrade a governing heading in a different evidence block', () => {
  const content = ['# React + TypeScript + Vite', '', 'Currently, two official plugins are available.', ''].join('\n');
  const document = { path: 'client.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const heading = catalog.entries.find(entry => entry.type === 'heading');
  const paragraph = catalog.entries.find(entry => entry.text.includes('two official'));
  const headingOccurrence = {
    ref: 's001', id: 'subject-occurrence:heading', surface: 'React + TypeScript + Vite',
    block_token: heading.token, occurrence: 1,
  };
  const response = { text: serializeFlatRelationAnswer({ claims: [{
    subject_binding: 'implicit_topic',
    subject_occurrence: 's001',
    subject_mention: { surface: 'React + TypeScript + Vite', source_locator: { block_token: heading.token, quote: heading.text } },
    relation_family: 'composition', predicate_family: 'has', object_or_value: 'two official plugins',
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'two', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: paragraph.token, quote: paragraph.text } }] }],
  }] }) };
  const result = validateWindowResponse({
    response, window, catalog, modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    subjectOccurrenceByRef: new Map([['s001', headingOccurrence]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.rejected.length, 0);
  assert.equal(result.value.claims[0].semantic.subject.binding.kind, 'implicit_topic');
});

test('@10 uses a redundant non-explicit selector to recover a co-located explicit subject', () => {
  const content = ['# Workflow', '', '**D1–D10** originates in the recipe architecture note.', ''].join('\n');
  const document = { path: 'workflow.md', content };
  const prepass = prepassDocument({ ...document, ...snapshot });
  const window = segmentDocument({ ...document, snapshot }).windows[0];
  const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
  const paragraph = catalog.entries.find(entry => entry.text.includes('D1–D10'));
  const occurrence = { ref: 's001', id: 'subject-occurrence:d1', surface: 'D1–D10',
    block_token: paragraph.token, occurrence: 1 };
  const response = { text: serializeFlatRelationAnswer({ claims: [{
    subject_binding: 'unresolved', subject_occurrence: 's001',
    subject_mention: { surface: 'D1–D10', source_locator: { block_token: paragraph.token, quote: paragraph.text } },
    relation_family: 'dependency', predicate_family: 'originates in', object_or_value: 'the recipe architecture note',
    polarity: 'affirmed', modality: 'historical', quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: paragraph.token, quote: paragraph.text } }] }],
  }] }) };
  const result = validateWindowResponse({
    response, window, catalog, modelIdentifier: 'fake/extract', promptDigest: 'digest', maxClaims: 4,
    requireSubjectOccurrence: true, recoverColocatedExplicit: true,
    subjectOccurrenceByRef: new Map([['s001', occurrence]]),
  });
  assert.equal(result.value.rejected.length, 0);
  assert.equal(result.value.claims[0].semantic.subject.binding.kind, 'explicit');
  assert.equal(result.value.claims[0].semantic.subject.binding.subject_occurrence_id, occurrence.id);
});

test('the frozen @8 model-visible contract remains selectable on the hardened runtime', async t => {
  const prepass = prepassDocument({ path: 'a.md', content: docA, ...snapshot });
  const { windows } = segmentDocument({ path: 'a.md', content: docA, snapshot });
  const catalog = createWindowBlockCatalog({ window: windows[0], inventories: [prepass.inventory] });
  const prompt = buildWindowPromptV8({ window: windows[0], catalog, mentionMenu: '<fixture>', max_claims: 64 });
  assert.match(prompt, /SUBJECT RULE: always give subject_mention/);
  assert.doesNotMatch(prompt, /subject_occurrence|subject_binding/);

  const dir = await tmp(t, 'v8-control');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2, contract: 'v8',
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: legacyClaimingRunner(),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.extraction_contract, 'v8');
  assert.equal(result.extractor, 'wide-context-extractor@8-control-on-hardened-runtime');
  assert.equal(result.metrics.rejected_claims, 0);
  assert.equal(result.metrics.reduced_claims, 2);
});

test('extraction runs concurrently through custody and produces v3.2 claims with honest locator metrics', async t => {
  const dir = await tmp(t, 'run');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2,
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: claimingRunner({ perCall: 3 }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.segmentation.documents, 2);
  assert.equal(result.segmentation.whole_document_windows, 2, 'both small documents went whole');
  assert.equal(result.window_catalog.length, 2, 'every execution window remains durable lineage');
  assert.equal(new Set(result.window_catalog.map(window => window.id)).size, 2);
  assert.ok(result.claims.every(claim => claim.extraction_provenance.every(row =>
    result.window_catalog.some(window => window.id === row.unit_id))), 'every claim unit_id resolves in the artifact');
  assert.equal(result.budget.accounted_calls, 2, 'one paid unit per window');
  assert.equal(result.metrics.reduced_claims, 6);
  assert.equal(result.metrics.unanchored_subjects, 0, 'every promoted subject has a resolved locator');
  assert.equal(result.metrics.locator_resolution_rate, 1);
  assert.equal(result.metrics.promoted_locator_resolution_rate, 1);
  assert.equal(result.metrics.proposed_locators, 12, 'two locators per proposed claim are measured before promotion');
  assert.ok(result.metrics.usd_per_kb > 0 && result.metrics.calls_per_kb > 0, 'Phase 3 budget inputs are produced');
  assert.equal(result.metrics.selected_primary_bytes, Buffer.byteLength(docA) + Buffer.byteLength(docB));
  assert.equal(result.metrics.corpus_primary_bytes, result.metrics.selected_primary_bytes);
  assert.deepEqual(result.inference, {
    model: 'fake/extract', thinking: null, provider_route: 'injected', runner_implementation: 'injected', effective_concurrency: 2,
    custody_policy: 'single-dispatch-durable-unit-circuit-break@1',
  });
  assert.equal(result.window_conservation.every(r => r.valid), true);
});

test('filtered telemetry uses selected bytes while retaining full-corpus lineage', async t => {
  const dir = await tmp(t, 'selected-scope');
  const selectedId = segmentDocument({ path: 'a.md', content: docA, snapshot }).windows[0].id;
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 1,
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: claimingRunner({ perCall: 3 }),
    window_ids: [selectedId],
  });
  assert.equal(result.window_catalog.length, 2, 'full catalog remains available for lineage');
  assert.equal(result.metrics.selected_windows, 1);
  assert.equal(result.metrics.selected_documents, 1);
  assert.equal(result.metrics.selected_primary_bytes, Buffer.byteLength(docA));
  assert.equal(result.metrics.corpus_primary_bytes, Buffer.byteLength(docA) + Buffer.byteLength(docB));
  assert.equal(result.metrics.usd_per_kb, Number((0.01 / (Buffer.byteLength(docA) / 1024)).toFixed(6)));
});

test('a malformed claim quarantines only itself; the unit and the fleet survive', async t => {
  const dir = await tmp(t, 'partial');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2,
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: claimingRunner({ perCall: 4, malformedIndex: 1 }),
  });
  assert.ok(result.metrics.rejected_claims >= 2, 'the bad claim is recorded per unit');
  assert.ok(result.metrics.reduced_claims > 0, 'valid siblings are kept');
  assert.equal(result.queue.stopped, null, 'one bad claim never stops the fleet');
});

test('explicit subjects without a prompt-local occurrence selector fail closed', async t => {
  const dir = await tmp(t, 'explicit-selector-required');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2,
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: claimingRunner({ perCall: 2, omitOccurrence: true }),
  });
  assert.equal(result.metrics.reduced_claims, 0);
  assert.deepEqual(result.metrics.rejection_codes, [['EXPLICIT_SUBJECT_OCCURRENCE_REQUIRED', 4]]);
});

test('an over-cap response retains every purchased claim and is marked overflow', async t => {
  const dir = await tmp(t, 'overflow');
  const result = await runWideContextExtraction({
    documents, snapshot, bounds: { ...bounds, max_claims_per_unit: 2 }, model: 'fake/extract', concurrency: 1,
    checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: claimingRunner({ perCall: 2, extra: 1 }),
  });
  assert.ok(result.metrics.overflow_units > 0);
  assert.equal(result.metrics.reduced_claims, 6, 'all 3 claims per window survive the cap of 2');
});

test('v28 terminal-incomplete response is never selected, done, retried, or promoted', async t => {
  const dir = await tmp(t, 'v28-terminal-incomplete');
  const checkpointPath = path.join(dir, 'c.jsonl');
  const v28Bounds = {
    ...bounds, max_attempts_per_unit: 1, max_calls: 2,
    cost_reserve_per_call_usd: 0.2,
  };
  const result = await runWideContextExtraction({
    documents, snapshot, bounds: v28Bounds, model: 'fake/extract', concurrency: 2, contract: 'v28',
    checkpointPath, runnerFactory: claimingRunner({
      perCall: 2,
      wireTransform: text => text.split('\n').slice(0, -1).join('\n'),
    }),
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.metrics.reduced_claims, 0);
  assert.equal(result.metrics.truncated_units, 2);
  assert.equal(result.queue.by_state.done || 0, 0);
  assert.equal(result.queue.by_state.quarantined, 2);
  assert.equal(result.materialization.selected_units, 0);
  assert.equal(result.materialization.terminal_incomplete_units, 2);
  assert.equal(result.materialization.attempts, 2, 'terminal validation failure does not authorize a retry');
  assert.equal(result.terminal_salvage.length, 2);
  assert.ok(result.terminal_salvage.every(row => row.salvage?.status === 'non_promotable'
    && row.salvage.claims.length === 2));
});

test('v28 overflow is terminal-incomplete and contributes zero promotable claims', async t => {
  const dir = await tmp(t, 'v28-overflow');
  const result = await runWideContextExtraction({
    documents, snapshot,
    bounds: { ...bounds, max_claims_per_unit: 2, max_attempts_per_unit: 1, max_calls: 2,
      cost_reserve_per_call_usd: 0.2 },
    model: 'fake/extract', concurrency: 2, contract: 'v28', checkpointPath: path.join(dir, 'c.jsonl'),
    runnerFactory: claimingRunner({ perCall: 2, extra: 1 }),
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.metrics.overflow_units, 2);
  assert.equal(result.metrics.reduced_claims, 0);
  assert.equal(result.queue.by_state.quarantined, 2);
  assert.equal(result.materialization.selected_units, 0);
  assert.equal(result.materialization.terminal_incomplete_units, 2);
  assert.ok(result.terminal_salvage.every(row => row.reason === 'CLAIM_OVERFLOW'));
});

test('v28 reports freshly exhausted provider materializations in the aggregate follow-up partition', async t => {
  const dir = await tmp(t, 'v28-provider-terminal-partition');
  const checkpointPath = path.join(dir, 'c.jsonl');
  const failingRunner = () => ({
    kind: 'fake', model: 'fake/extract', _calls: [],
    async complete() {
      this._calls.push({ tag: 'fail', model: this.model, outcome: 'error:provider', accepted: true,
        billing_status: 'reported', cost: 0.01, cost_reported: true, input_tokens: 1, output_tokens: 0, total_tokens: 1 });
      return { text: '', outcome: 'error:provider', accepted: true, billing_status: 'reported',
        usage: { cost: 0.01, cost_reported: true, input_tokens: 1, output_tokens: 0, total_tokens: 1 }, model: this.model };
    },
    stats() { return { kind: 'fake', calls: this._calls.length, cost: this._calls.length * 0.01,
      cost_status: 'complete', unpriced_attempts: 0, models: [this.model], per_call: this._calls.slice() }; },
  });
  const result = await runWideContextExtraction({
    documents, snapshot,
    bounds: { ...bounds, max_attempts_per_unit: 2, max_calls: 4, cost_reserve_per_call_usd: 0.02,
      fleet_stop: { failure_rate: 1, min_samples: 99 } },
    model: 'fake/extract', concurrency: 2, contract: 'v28', checkpointPath,
    runnerFactory: failingRunner,
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.queue.by_state.quarantined, 2);
  assert.equal(result.materialization.selected_units, 0);
  assert.equal(result.materialization.terminal_incomplete_units, 2);
  assert.equal(result.materialization.attempts, 4);
  assert.equal(result.terminal_salvage.length, 2);
  assert.ok(result.terminal_salvage.every(row => row.reason === 'incomplete paid result'
    && row.terminal_outcome === 'error:provider' && row.salvage === null));
  const guard = { ...createNoRedispatchProvider(0), model: 'fake/extract' };
  const replay = await runWideContextExtraction({
    documents, snapshot,
    bounds: { ...bounds, max_attempts_per_unit: 2, max_calls: 4, cost_reserve_per_call_usd: 0.02,
      fleet_stop: { failure_rate: 1, min_samples: 99 } },
    model: 'fake/extract', concurrency: 2, contract: 'v28', checkpointPath,
    runnerFactory: () => guard,
  });
  assert.equal(guard.count(), 0);
  assert.equal(replay.materialization.terminal_incomplete_units, 2);
  assert.deepEqual(replay.terminal_salvage, result.terminal_salvage,
    'the follow-up partition survives a zero-dispatch replay');
});

test('an explicit v28 follow-up label creates a new logical materialization without changing prompt bytes', async t => {
  const dir = await tmp(t, 'v28-explicit-followup');
  const baseCheckpoint = path.join(dir, 'base.jsonl');
  const followupCheckpoint = path.join(dir, 'followup.jsonl');
  const v28Bounds = { ...bounds, max_attempts_per_unit: 1, max_calls: 2, cost_reserve_per_call_usd: 0.2 };
  await runWideContextExtraction({
    documents, snapshot, bounds: v28Bounds, model: 'fake/extract', concurrency: 2, contract: 'v28',
    checkpointPath: baseCheckpoint, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  await runWideContextExtraction({
    documents, snapshot, bounds: v28Bounds, model: 'fake/extract', concurrency: 2, contract: 'v28',
    checkpointPath: followupCheckpoint, runnerFactory: claimingRunner({ perCall: 1 }),
    materialization_label: 'explicit-terminal-followup-1',
  });
  const started = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(row => row.stage === 'wide-context-attempt-started').map(row => row.value)
    .sort((a, b) => a.dependencies.window_id.localeCompare(b.dependencies.window_id));
  const original = await started(baseCheckpoint), followup = await started(followupCheckpoint);
  assert.deepEqual(followup.map(row => row.input_digest), original.map(row => row.input_digest),
    'the explicit follow-up preserves the exact model-visible prompt');
  assert.notDeepEqual(followup.map(row => row.logical_key), original.map(row => row.logical_key),
    'the operator label creates a new logical key instead of erasing or retrying the first draw');
  assert.notDeepEqual(followup.map(row => row.materialization_id), original.map(row => row.materialization_id));
  assert.ok(followup.every(row => row.dependencies.explicit_materialization_label === 'explicit-terminal-followup-1'));
});

test('replay re-uses every purchased unit and dispatches nothing', async t => {
  const dir = await tmp(t, 'replay');
  const checkpointPath = path.join(dir, 'c.jsonl');
  const first = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2,
    checkpointPath, runnerFactory: claimingRunner({ perCall: 3 }),
  });
  // Same model: a DIFFERENT model is legitimately a different unit, so the guard must impersonate
  // the original runner to prove replay reuse rather than key mismatch.
  const guard = { ...createNoRedispatchProvider(0), model: 'fake/extract' };
  const second = await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', concurrency: 2,
    checkpointPath, runnerFactory: () => guard,
  });
  assert.equal(guard.count(), 0, 'no purchased unit is ever re-bought');
  assert.equal(second.metrics.reduced_claims, first.metrics.reduced_claims);
  assert.equal(second.digest, first.digest, 'replay is byte-identical');
});

test('thinking level is part of checkpoint identity', async t => {
  const dir = await tmp(t, 'thinking-identity');
  const checkpointPath = path.join(dir, 'c.jsonl');
  await runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/extract', thinking: 'low', concurrency: 1,
    checkpointPath, runnerFactory: claimingRunner({ perCall: 1 }),
  });
  const guard = { ...createNoRedispatchProvider(0), model: 'fake/extract' };
  await assert.rejects(
    runWideContextExtraction({
      documents, snapshot, bounds, model: 'fake/extract', thinking: 'high', concurrency: 1,
      checkpointPath, runnerFactory: () => guard,
    }),
    /checkpoint fingerprint mismatch/,
  );
  assert.equal(guard.count(), 0);
});

test('integrated provider failures trip the fleet circuit and leave pending units undispatched', async t => {
  const dir = await tmp(t, 'provider-fleet-stop');
  const manyDocuments = Array.from({ length: 12 }, (_, i) => ({
    path: `d${i}.md`, content: `# D${i}\n\nDocument ${i} has enough text for a deterministic block.\n`,
  }));
  let calls = 0;
  const failingRunner = () => ({
    kind: 'fake', model: 'fake/extract', _calls: [],
    async complete() {
      calls += 1;
      this._calls.push({ tag: 'fail', model: this.model, outcome: 'error:provider', accepted: true,
        billing_status: 'reported', cost: 0.01, cost_reported: true, input_tokens: 1, output_tokens: 0, total_tokens: 1 });
      return { text: '', outcome: 'error:provider', accepted: true, billing_status: 'reported',
        usage: { cost: 0.01, cost_reported: true, input_tokens: 1, output_tokens: 0, total_tokens: 1 }, model: this.model };
    },
    stats() { return { kind: 'fake', calls: this._calls.length, cost: this._calls.length * 0.01,
      cost_status: 'complete', unpriced_attempts: 0, models: [this.model], per_call: this._calls.slice() }; },
  });
  const result = await runWideContextExtraction({
    documents: manyDocuments, snapshot, bounds: { ...bounds, fleet_stop: { failure_rate: 0.5, min_samples: 4 } },
    model: 'fake/extract', concurrency: 2, checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: failingRunner,
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.queue.stopped.reason, 'fleet_failure_rate_exceeded');
  assert.ok(result.queue.by_state.pending > 0);
  assert.ok(calls < manyDocuments.length, 'the remaining documents were never dispatched');
});

test('incoherent bounds are refused before any dispatch', async t => {
  const dir = await tmp(t, 'preflight');
  const guard = createNoRedispatchProvider(0);
  await assert.rejects(
    runWideContextExtraction({
      documents, snapshot, model: 'fake/extract', concurrency: 1,
      bounds: { ...bounds, max_answer_bytes: 8 * 1024 * 1024, max_event_bytes: 1024 * 1024 },
      checkpointPath: path.join(dir, 'c.jsonl'), runnerFactory: () => guard,
    }),
    error => error.code === 'BOUND_PREFLIGHT_FAILED',
  );
  assert.equal(guard.count(), 0, 'preflight fires before the first call');
});

test('the claim ask scales with window size instead of throttling large windows', async () => {
  const { claimBudgetForWindow } = await import('../tools/wide-context-extractor.mjs');
  const bounds = { claims_per_kb_target: 5, min_claims_per_unit: 32, max_claims_per_unit: 400 };
  assert.equal(claimBudgetForWindow({ primary_bytes: 48 * 1024 }, bounds), 240, 'a 48 KB window may ask for far more than 64');
  assert.equal(claimBudgetForWindow({ primary_bytes: 2 * 1024 }, bounds), 32, 'small windows keep a sane floor');
  assert.equal(claimBudgetForWindow({ primary_bytes: 500 * 1024 }, bounds), 400, 'the ceiling still bounds one answer');
  assert.equal(claimBudgetForWindow({ primary_bytes: 48 * 1024 }, { max_claims_per_unit: 64 }), 64, 'legacy flat cap still honored when no target is set');
});

test('concurrent paid calls reserve cost headroom before dispatch', () => {
  const budget = createInferenceBudget({
    max_calls: 10, max_known_cost_usd: 0.3, max_unpriced_attempts: 0,
    cost_reserve_per_call_usd: 0.2,
  });
  budget.beforeDispatch('a');
  assert.throws(() => budget.beforeDispatch('b'), error => error.code === 'KNOWN_COST_RESERVATION_CAP_REACHED');
  budget.account('a', { calls: 1, cost: 0.1, unpriced_attempts: 0 });
  budget.beforeDispatch('b');
  assert.equal(budget.snapshot().in_flight_reservations, 1);
  assert.equal(budget.snapshot().cost_reserve_per_call_usd, 0.2);
});

test('an unpriced completion stops future dispatch only after every in-flight purchase can finalize', () => {
  const budget = createInferenceBudget({
    max_calls: 10, max_known_cost_usd: 2, max_unpriced_attempts: 0,
    cost_reserve_per_call_usd: 0.2,
  });
  budget.beforeDispatch('timed-out');
  budget.beforeDispatch('successful-peer');
  assert.doesNotThrow(() => budget.account('timed-out', {
    calls: 1, cost: 0, cost_status: 'lower_bound', unpriced_attempts: 1,
  }), 'a purchased receipt is durably accounted before the stop becomes active');
  assert.doesNotThrow(() => budget.account('successful-peer', {
    calls: 1, cost: 0.1, cost_status: 'complete', unpriced_attempts: 0,
  }), 'a peer already in flight can still finish accounting and materialization');
  assert.equal(budget.snapshot().accounted_calls, 2);
  assert.equal(budget.snapshot().known_cost_usd, 0.1);
  assert.equal(budget.snapshot().stopped.reason, 'unpriced_attempt_cap_exceeded');
  assert.throws(() => budget.beforeDispatch('new-logical-unit'),
    error => error.code === 'UNPRICED_ATTEMPT_LIMIT_EXCEEDED');
  assert.doesNotThrow(() => budget.beforeDispatch('timed-out-retry', { continuation: true }),
    'the immutable retry already authorized for the same materialization remains eligible');
});

test('transient cost-reservation contention waits instead of becoming a fleet stop', async () => {
  const budget = createInferenceBudget({
    max_calls: 10, max_known_cost_usd: 0.3, max_unpriced_attempts: 0,
    cost_reserve_per_call_usd: 0.2,
  });
  await budget.waitBeforeDispatch('a');
  let secondDispatched = false;
  const second = budget.waitBeforeDispatch('b').then(() => { secondDispatched = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondDispatched, false, 'the second call waits while the pessimistic reserve is held');
  budget.account('a', { calls: 1, cost: 0.1, unpriced_attempts: 0 });
  await second;
  assert.equal(secondDispatched, true);
  assert.equal(budget.snapshot().in_flight_reservations, 1);
});

test('a genuinely exhausted pre-dispatch budget is a typed bound, not a provider failure', async () => {
  const budget = createInferenceBudget({
    max_calls: 10, max_known_cost_usd: 0.3, max_unpriced_attempts: 0,
    cost_reserve_per_call_usd: 0.2,
  });
  budget.beforeDispatch('a');
  budget.account('a', { calls: 1, cost: 0.25, unpriced_attempts: 0 });
  await assert.rejects(
    budget.waitBeforeDispatch('b'),
    error => error.code === 'KNOWN_COST_RESERVATION_CAP_REACHED'
      && error.unit_outcome === 'unresolved_due_to_bound',
  );
});
