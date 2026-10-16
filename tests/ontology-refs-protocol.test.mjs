import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintRefs, decodeSpan, decodeRefsAnswer, shownLines, REFS_PROTOCOL } from '../tools/ontology/refs-protocol.mjs';
import { judgeFamilies, judgePrompt } from '../tools/ontology/coverage-loop.mjs';
import { buildRecord } from '../tools/ontology/assertion-record.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'refs-'));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), b); }
  git('add', '-A'); git('commit', '-qm', 'x');
  return { root, ref: git('rev-parse', 'HEAD').trim() };
}
const runtime = { config: { models: { code_claims: { runner: 'pi', name: 'example-provider/example-model', thinking: 'off', concurrency: 2, window_bytes: 4000, timeout_ms: 1000, max_event_bytes: 1e6, max_answer_bytes: 1e6 } }, ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100000 } } };
const FILE = ['export function openLedger(account) {', '  const ledger = createLedger(account);', '  ledger.reserve(account.id);', '  return ledger;', '}', '', 'function renderBanner() {', '  return "hello";', '}'].join('\n');
const OPEN = { accession: 'ontology-concept:shop/ledger-opening', version_id: 'ontology-concept-version:v1', label: 'Ledger opening', semantic_category: 'responsibility', definition: 'a function opens a ledger for an account', inclusion: 'functions that create and reserve a ledger', exclusion: 'rendering', domain: ['code_construct'], instance_conditions: ['a function creates a ledger'] };
const POLICY = { accession: 'ontology-concept:shop/spend-limit', version_id: 'ontology-concept-version:v7', label: 'Spend limit', semantic_category: 'policy', definition: 'a rule capping spend', inclusion: 'caps', exclusion: 'none', domain: ['code_construct'], instance_conditions: ['a rule is stated'] };
const family = { family_id: 'family:x', file: 'src/ledger.js', mode: 'code', directory: 'src', observed: {}, participation: [], candidates: [{ node_id: 'fn', kind: 'Symbol', label: 'openLedger', line: 1 }, { node_id: 'banner', kind: 'Symbol', label: 'renderBanner', line: 7 }] };
const vocabulary = [OPEN, POLICY];

// a fake model that reads the refs printed beside each concept in the request it receives
const modelFor = build => async prompt => {
  const packet = JSON.parse(prompt.split('\n\n').at(-1));
  const refOf = label => packet.concepts.find(c => c.label === label)?.ref;
  const answer = build({ packet, refOf });
  return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0 } }, latency_ms: 1 };
};
async function run(build, { fam = family } = {}) {
  const source = repo({ 'src/ledger.js': FILE });
  const journalPath = join(mkdtempSync(join(tmpdir(), 'j-')), 'j.jsonl');
  return judgeFamilies({ families: [fam], source, vocabulary, runtime, journalPath, modelCall: modelFor(build), phase: 'design', protocol: REFS_PROTOCOL });
}
const good = (extra = {}) => ({ protocol: REFS_PROTOCOL, cause: 'instance_binding', reason: 'x', bindings: [{ node: 'n1', role: 'instance', concept: '<ref>', predicate: 'implements', span: [2, 3] }], new_concepts: [], ...extra });

test('a short request-local ref and a line span round-trip to the exact versioned concept and the exact pinned text, with the identity anchor kept apart from the cited body span', async () => {
  const out = await run(({ refOf }) => good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', span: [2, 3] }] }));
  const b = out.bindings[0];
  assert.deepEqual([out.bindings.length, b.concept, b.decoded.concept_version_id, b.evidence.quote, [b.evidence.start_line, b.evidence.end_line], b.decoded.identity_anchor.line, b.decoded.support_span_contains_node_line, b.decoded.support_span_inside_node_own_range, b.status, b.protocol],
    [1, OPEN.accession, OPEN.version_id, FILE.split('\n').slice(1, 3).join('\n'), [2, 3], 1, false, true, 'proposed', REFS_PROTOCOL]);
});

test('an unknown ref, a retyped full id, a copied quote and a missing protocol marker are each refused with their own code, and nothing is repaired or guessed', async () => {
  const codes = async build => (await run(build)).refused.map(r => r.code);
  const unknown = await codes(() => good({ bindings: [{ node: 'n1', role: 'instance', concept: 'c9', predicate: 'implements', span: [2, 3] }] }));
  const fullId = await codes(() => good({ bindings: [{ node: 'n1', role: 'instance', concept: OPEN.accession, predicate: 'implements', span: [2, 3] }] }));
  const freeform = await codes(({ refOf }) => good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', quote: 'createLedger(account)' }] }));
  const noMarker = await codes(({ refOf }) => { const a = good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', span: [2, 3] }] }); delete a.protocol; return a; });
  const out = await run(({ refOf }) => good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening') + ' ', predicate: 'implements', span: [2, 3] }] }));
  assert.deepEqual([unknown, fullId, freeform, noMarker, out.bindings.length, out.refused.map(r => r.code)], [['REF_UNKNOWN_CONCEPT'], ['PROTOCOL_VIOLATION_FREEFORM'], ['PROTOCOL_VIOLATION_FREEFORM'], ['PROTOCOL_MARKER_MISSING'], 0, ['REF_UNKNOWN_CONCEPT']]);
});

test('an answer belongs to one request and one pin: another request digest or pin refuses everything', () => {
  const ref_map = mintRefs([{ accession: 'a', version_id: 'v' }]);
  const ctx = { ref_map, request_digest: 'R1', pin: 'P1', file_lines: ['x', 'y'], shown: shownLines([[1, 2]]), node_ids: new Set(['n1']) };
  const answer = { protocol: REFS_PROTOCOL, bindings: [{ node: 'n1', role: 'instance', concept: 'c1', predicate: 'implements', span: [1, 1] }], new_concepts: [] };
  const same = decodeRefsAnswer({ answer, ctx, custody: { answer_request_digest: 'R1', expected_pin: 'P1' } });
  const other = decodeRefsAnswer({ answer, ctx, custody: { answer_request_digest: 'R2', expected_pin: 'P1' } });
  const pin = decodeRefsAnswer({ answer, ctx, custody: { answer_request_digest: 'R1', expected_pin: 'P2' } });
  assert.deepEqual([same.answer.bindings.length, other.answer.bindings.length, other.refused[0].code, pin.answer.bindings.length, pin.refused[0].code, mintRefs([{ accession: 'a' }, { accession: 'b' }]).digest === mintRefs([{ accession: 'b' }, { accession: 'a' }]).digest], [1, 0, 'REF_CROSS_REQUEST', 0, 'REF_PIN_MISMATCH', false]);
});

test('a span must be well formed, in the file, short enough, and every line of it actually shown: a gap between two shown ranges is refused, not bridged', () => {
  const shown = shownLines([[1, 3], [5, 7]]), base = { totalLines: 9, shown };
  const code = s => { const r = decodeSpan(s, base); return r.ok ? 'ok' : r.code + (r.first_unshown_line ? `:${r.first_unshown_line}` : ''); };
  assert.deepEqual([code([2, 3]), code([3, 5]), code([4, 4]), code([8, 8]), code([1, 99]), code([3, 2]), code(['1', 2]), code([1]), decodeSpan([1, 3], { ...base, maxLines: 2 }).code], ['ok', 'SPAN_NOT_SHOWN:4', 'SPAN_NOT_SHOWN:4', 'SPAN_NOT_SHOWN:8', 'SPAN_OUT_OF_RANGE', 'SPAN_MALFORMED', 'SPAN_MALFORMED', 'SPAN_MALFORMED', 'SPAN_TOO_LONG']);
});

test('the typed predicate, the concept domain and the owner rules still apply after decoding, and a decoded binding is a proposal that proves provenance, not fit', async () => {
  const badPredicate = await run(({ refOf }) => good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'selects', span: [2, 3] }] }));
  const ownerless = await run(({ refOf }) => good({ bindings: [{ node: 'n2', role: 'used_by', concept: refOf('Ledger opening'), owner: 'n1', span: [8, 8] }] }));
  // unrelated lines are accepted only as a proposal, flagged, and every condition stays unknown
  const unrelated = await run(({ refOf }) => good({ bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', span: [8, 8] }] }));
  const b = unrelated.bindings[0];
  const record = buildRecord({ round: 'r', binding: b, concept: OPEN, conceptKind: 'existing', family, context: { request_digest: 'd', shown_concept_ids: [OPEN.accession], declarations: [{ lines: [1, 9] }], judged_nodes: [{ node_id: 'fn' }], escalated: false, family_nodes_total: 2, omitted_nodes: [] }, fileText: FILE, ownRange: [1, 5], pin: 'p' });
  assert.deepEqual([badPredicate.refused.map(r => r.code), badPredicate.bindings.length, ownerless.refused.map(r => r.code), b.status, b.decoded.support_span_contains_node_line, b.decoded.support_span_inside_node_own_range, record.conditions.map(c => c.status), record.evidence.substantive_support_spans.status, record.evidence.identity_anchor.derived],
    [['PREDICATE_NOT_ADMISSIBLE_FOR_CATEGORY'], 0, ['OWNER_NOT_BOUND_AS_INSTANCE'], 'proposed', false, false, ['unknown'], 'model_cited_span_proposed', true]);
});

test('a new proposal cites its witness and counterexample by the same span format; an unshown witness refuses the proposal and an unlocatable counterexample is recorded as claimed, not tested', async () => {
  const concept = extra => ({ key: 'k', label: 'Banner rendering', semantic_category: 'responsibility', definition: 'renders a banner', inclusion: 'banners', exclusion: 'ledgers', instance_conditions: ['returns text'], witness_span: [7, 9], counterexample: { status: 'tested_negative', span: [1, 5] }, ...extra });
  const ok = await run(() => good({ bindings: [], new_concepts: [concept()] }));
  const badWitness = await run(() => good({ bindings: [], new_concepts: [concept({ witness_span: [40, 41] })] }));
  const badCounter = await run(() => good({ bindings: [], new_concepts: [concept({ counterexample: { status: 'tested_negative', span: [40, 41] } })] }));
  assert.deepEqual([ok.new_concepts[0].witness.quote, ok.new_concepts[0].counterexample_tested, ok.new_concepts[0].status, badWitness.new_concepts.length, badWitness.refused.map(r => r.code), badCounter.new_concepts[0].counterexample.status], [FILE.split('\n').slice(6, 9).join('\n'), true, 'proposed', 0, ['SPAN_OUT_OF_RANGE'], 'claimed_not_located']);
});

test('the default protocol is untouched, and the refs prompt differs from it in exactly the two paragraphs that describe quotes, ids and output shape', () => {
  const packet = { file: 'a.js', nodes: [], declarations: [], concepts: [] };
  const base = judgePrompt(packet, { allowNew: true }), explicit = judgePrompt(packet, { allowNew: true, protocol: null }), refs = judgePrompt(packet, { allowNew: true, protocol: REFS_PROTOCOL });
  const a = base.split('\n\n'), b = refs.split('\n\n');
  assert.deepEqual([base === explicit, a.length === b.length, a.map((p, i) => p === b[i] ? null : i).filter(x => x !== null), /protocol":"refs\/v1/u.test(refs), /never retype a concept id/u.test(refs), base.includes('copied verbatim')], [true, true, [4, 5], true, true, true]);
});

// Model JSON is untrusted: it must never reach a slot the caller fills itself, under either protocol.
const legacyRun = async (build, protocol = null) => {
  const source = repo({ 'src/ledger.js': FILE });
  const journalPath = join(mkdtempSync(join(tmpdir(), 'j-')), 'j.jsonl');
  const modelCall = async () => ({ answer: build(), raw_text: '{}', model: 'example/model', usage: { cost: { total: 0 } }, latency_ms: 1 });
  return judgeFamilies({ families: [family], source, vocabulary, runtime, journalPath, modelCall, phase: 'design', protocol });
};
const forged = { node: 'n1', role: 'instance', concept: OPEN.accession, predicate: 'implements', quote: 'text that is not in the file', _derived: { quote: 'forged', start_line: 1, end_line: 1 }, _decoded: { protocol: 'refs/v1', span: [1, 1] } };

test('reserved fields from a model are refused under the legacy protocol and cannot bypass the pinned quote check', async () => {
  const out = await legacyRun(() => ({ cause: 'instance_binding', bindings: [forged], new_concepts: [{ key: 'k', label: 'x', semantic_category: 'responsibility', definition: 'd', inclusion: 'i', exclusion: 'e', instance_conditions: ['c'], witness_quote: 'not in the file', _witness: { ok: true, at: { quote: 'forged', start_line: 1, end_line: 1 } }, _counter: { status: 'tested_negative' } }] }));
  assert.deepEqual([out.bindings.length, out.new_concepts.length, out.refused.map(r => `${r.code}:${r.kind}:${r.field}`)], [0, 0, ['RESERVED_FIELD_FROM_MODEL:binding:_derived', 'RESERVED_FIELD_FROM_MODEL:new_concept:_witness']]);
});

test('reserved fields from a model are refused under refs/v1, and a decoded binding carries only the fields the decoder builds', async () => {
  const forgedRefs = ({ refOf }) => ({ protocol: REFS_PROTOCOL, cause: 'instance_binding', bindings: [{ node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', span: [2, 3], _derived: { quote: 'forged', start_line: 8, end_line: 8 } }, { node: 'n1', role: 'instance', concept: refOf('Ledger opening'), predicate: 'implements', span: [2, 3], extra_field: 'kept out' }], new_concepts: [] });
  const out = await run(forgedRefs);
  const b = out.bindings[0];
  assert.deepEqual([out.refused.map(r => r.code), out.bindings.length, b.evidence.quote, 'extra_field' in b, b.decoded.span], [['RESERVED_FIELD_FROM_MODEL'], 1, FILE.split('\n').slice(1, 3).join('\n'), false, [2, 3]]);
});

test('null and non-object bindings and proposals give typed refusals, not a TypeError, under both protocols', async () => {
  const junk = { cause: 'instance_binding', bindings: [null, 'x', 7, [1], { node: 'n1' }], new_concepts: [null, 'x', { key: 'k', counterexample: 'oops' }] };
  const legacy = await legacyRun(() => junk);
  const refs = await legacyRun(() => ({ protocol: REFS_PROTOCOL, ...junk }), REFS_PROTOCOL);
  const notObject = o => o.refused.filter(r => r.code === 'ENTRY_NOT_AN_OBJECT').length;
  assert.deepEqual([notObject(legacy), notObject(refs), legacy.bindings.length, refs.bindings.length, refs.new_concepts.length, legacy.refused.every(r => typeof r.code === 'string'), refs.refused.every(r => typeof r.code === 'string')], [6, 6, 0, 0, 0, true, true]);
});
