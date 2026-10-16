import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extentReceipt, buildRecord, reviewQuestionFor, relationSemantics, contractLint, subjectIdentity, diffReplays, bindConditionCheck, contractHash, RECORD_SCHEMA } from '../tools/ontology/assertion-record.mjs';
import { identityOf, buildFrontier, judgePrompt, familyPacket, PART_ONLY_SENTENCE, SENTENCE_FIXED } from '../tools/ontology/coverage-loop.mjs';

const text = ['export function openLedger() {', '  const PATH = "x";', '  return PATH;', '}', 'function other() {', '  return openLedger();', '}'].join('\n');
const concept = (extra = {}) => ({ accession: 'c1', label: 'Ledger opening', semantic_category: 'responsibility', definition: 'opens a ledger', inclusion: 'opens or reuses a ledger', exclusion: 'helpers', domain: ['code_construct'], instance_conditions: ['a function opens a ledger', 'the ledger is unavailable to others'], ...extra });
const family = { candidates: [{ node_id: 'fn', kind: 'Symbol', label: 'openLedger', line: 1 }, { node_id: 'k', kind: 'LiteralValue', label: 'PATH', line: 2 }, { node_id: 'o', kind: 'Symbol', label: 'other', line: 5 }] };
const context = { request_digest: 'd', retrieval: 'short_lexical_list', shown_concept_ids: ['c1'], declarations: [{ lines: [1, 4], may_be_cut_or_incomplete: false }], judged_nodes: [{ node_id: 'fn' }], escalated: false, family_nodes_total: 3, omitted_nodes: [] };
const binding = (extra = {}) => ({ binding_id: 'b1', family_id: 'f', node_id: 'fn', node_kind: 'Symbol', node_label: 'openLedger', node_line: 1, role: 'instance', predicate: 'implements', concept: 'c1', evidence: { start_line: 1, end_line: 1, quote: 'export function openLedger() {' }, ...extra });
const rec = (b = binding(), extra = {}) => buildRecord({ round: 'r', binding: b, concept: concept(), conceptKind: 'existing', family, context, fileText: text, ownRange: [1, 4], pin: 'pin', ...extra });
const check = (extra = {}) => ({ request_digest: 'rq', subject: { node_id: 'fn', pin: 'pin' }, concept_id: 'c1', contract_hash: contractHash(concept()), whole_concept: 'does_not_hold', conditions: [{ condition: 'a function opens a ledger', verdict: 'yes', why: 'it does' }, { condition: 'the ledger is unavailable to others', verdict: 'no', why: 'not shown' }], ...extra });

test('the review question tests the predicate actually asserted, and describes is never tested as membership', () => {
  assert.deepEqual([/EVERY instance condition/u.test(reviewQuestionFor({ role: 'instance', predicate: 'implements' })), /EVERY instance condition/u.test(reviewQuestionFor({ role: 'relates', predicate: 'describes' })), /need not instantiate/u.test(reviewQuestionFor({ role: 'relates', predicate: 'describes' }))], [true, false, true]);
});

test('lexical containment, dependency use and contribution are three different relations, and no contribution is inferred', () => {
  const a = relationSemantics('part_of'), b = relationSemantics('used_by'), c = relationSemantics('instance', 'implements');
  assert.deepEqual([a.kind, b.kind, c.kind, new Set([a.relation, b.relation, c.relation]).size, /not_asserted/u.test(rec(binding({ role: 'used_by', predicate: null })).predicate.contributes_to)], ['lexical_ownership', 'dependency', 'membership', 3, true]);
});

test('concept availability separates an existing lookup, a validated new proposal, and an edge with no concept, so a proposal is never failed for not being in a list', () => {
  const find = (r, c) => r.structural_validation.trace.find(t => t.check === c);
  const existingMissing = buildRecord({ round: 'r', binding: binding({ concept: 'c9' }), concept: concept(), conceptKind: 'existing', family, context, fileText: text, ownRange: [1, 4], pin: 'pin' });
  const proposal = buildRecord({ round: 'r', binding: binding({ concept: 'proposal:x' }), concept: concept(), conceptKind: 'validated_new_proposal', family, context, fileText: text, ownRange: [1, 4], pin: 'pin' });
  const edge = buildRecord({ round: 'r', binding: binding({ role: 'part_of', predicate: null, concept: null }), concept: concept(), conceptKind: 'none', family, context, fileText: text, ownRange: [1, 4], ownerRange: [1, 4], pin: 'pin' });
  assert.deepEqual([find(existingMissing, 'concept_available_to_the_model').outcome, find(proposal, 'concept_available_to_the_model').outcome, find(proposal, 'concept_available_to_the_model').concept_kind, find(edge, 'concept_available_to_the_model').outcome], ['fail', 'pass', 'validated_new_proposal', 'not_applicable']);
});

test('lint is suspicion only: an OR in an inclusion is not a contradiction, and a domain applies to instance bindings only', () => {
  const instance = contractLint(concept(), 'configuration_entry', 'instance'), relating = contractLint(concept(), 'configuration_entry', 'relates');
  assert.deepEqual([instance.map(l => `${l.code}:${l.severity}`).sort(), relating.map(l => l.code)], [['inclusion_uses_or_while_conditions_are_conjunctive:suspicion_only', 'instance_subject_kind_outside_concept_domain:applies_to_instance_bindings'], ['inclusion_uses_or_while_conditions_are_conjunctive']]);
});

test('part_of and used_by traces are checked against the owner span, never passed by omission, and a name in text is not a resolved dependency', () => {
  const inside = rec(binding({ node_id: 'k', node_label: 'PATH', node_line: 2, role: 'part_of', predicate: null, evidence: { start_line: 2, end_line: 2, quote: '  const PATH = "x";' } }), { ownerRange: [1, 4] });
  const outside = rec(binding({ node_id: 'k', node_label: 'PATH', node_line: 2, role: 'part_of', predicate: null, evidence: { start_line: 2, end_line: 2, quote: '  const PATH = "x";' } }), { ownerRange: [5, 7] });
  const none = rec(binding({ node_id: 'k', node_label: 'PATH', node_line: 2, role: 'part_of', predicate: null, evidence: { start_line: 2, end_line: 2, quote: '  const PATH = "x";' } }));
  const used = rec(binding({ node_id: 'fn', node_label: 'openLedger', node_line: 1, role: 'used_by', predicate: null }), { ownerRange: [5, 7] });
  const unused = rec(binding({ node_id: 'k', node_label: 'PATH', node_line: 2, role: 'used_by', predicate: null, evidence: { start_line: 2, end_line: 2, quote: '  const PATH = "x";' } }), { ownerRange: [5, 7] });
  const t = (r, c) => r.structural_validation.trace.find(x => x.check === c);
  assert.deepEqual([t(inside, 'lexical_containment_in_owner_declaration').outcome, t(outside, 'lexical_containment_in_owner_declaration').outcome, t(none, 'lexical_containment_in_owner_declaration').outcome, t(used, 'name_appears_in_owner_declaration_text').outcome, t(unused, 'name_appears_in_owner_declaration_text').outcome, t(used, 'name_appears_in_owner_declaration_text').resolved_dependency], ['pass', 'fail', 'unverified', 'pass', 'fail', 'not_established']);
});

test('an original run is told apart from a present-day shadow policy: an unenforced check is "not checked then" with a separate shadow outcome', () => {
  const long = rec(binding({ evidence: { start_line: 1, end_line: 1, quote: `export function openLedger() {${'x'.repeat(400)}` } }), { enforcedInOriginalRun: ['quote_located_at_pin'] });
  const q = long.structural_validation.trace.find(t => t.check === 'quote_within_300_characters');
  assert.deepEqual([q.enforced_in_original_run, q.historical_outcome, q.shadow_outcome, long.structural_validation.shadow_passed_all_applicable, long.structural_validation.all_enforced_checks_passed_by_construction], [false, 'not_checked_then', 'fail', false, true]);
});

test('a condition check applies only when subject, pin, concept, contract hash and the complete condition set all match; otherwise every condition stays unknown', () => {
  const ok = bindConditionCheck({ nodeId: 'fn', pin: 'pin', concept: concept(), check: check() });
  const wrongSubject = bindConditionCheck({ nodeId: 'other', pin: 'pin', concept: concept(), check: check() });
  const wrongPin = bindConditionCheck({ nodeId: 'fn', pin: 'p2', concept: concept(), check: check() });
  const reworded = bindConditionCheck({ nodeId: 'fn', pin: 'pin', concept: concept({ definition: 'something else' }), check: check() });
  const incomplete = bindConditionCheck({ nodeId: 'fn', pin: 'pin', concept: concept(), check: check({ conditions: [{ condition: 'a function opens a ledger', verdict: 'yes', why: 'x' }] }) });
  assert.deepEqual([ok.bound, ok.derived_whole_concept, wrongSubject.bound, wrongPin.bound, reworded.bound, incomplete.bound, incomplete.statuses.every(x => x === null)], [true, 'some_condition_contradicted', false, false, false, false, true]);
});

test('a bound but contradicting post-hoc check marks the binding disputed for a shadow hold without declaring the source false, and the check stays a separate call', () => {
  const r = rec(binding(), { conditionCheck: check() }), plain = rec();
  assert.deepEqual([r.conditions.map(c => c.status), r.disagreement.post_hoc_condition_check, /does not declare the source false/u.test(r.disagreement.shadow_policy), r.condition_check_binding.separate_call_from_the_binding_model, plain.conditions.map(c => c.status), plain.disagreement], [['supported', 'contradicted'], 'some_condition_contradicted', true, true, ['unknown', 'unknown'], null]);
});

test('generation context and review context are tagged apart, a focal line outside what was shown is flagged, and an enclosing extent is never called whole', () => {
  const k = binding({ node_id: 'k', node_label: 'PATH', node_line: 2, evidence: { start_line: 2, end_line: 2, quote: 'const PATH = "x";' } });
  const r = rec(k, { review: { declaration: { lines: [1, 3], extent: 'heuristic', may_be_cut_or_incomplete: true } } });
  const outside = buildRecord({ round: 'r', binding: k, concept: concept(), conceptKind: 'existing', family, context: { ...context, declarations: [{ lines: [5, 7] }] }, fileText: text, ownRange: [1, 4], pin: 'pin' });
  assert.deepEqual([r.generation_context.claims_whole_declaration, r.review_context.differs_from_generation_context, outside.generation_context.focal_line_in_view, outside.structural_validation.trace.find(t => t.check === 'subject_line_in_generation_context').outcome, /never "whole"/u.test(r.generation_context.completeness), r.schema === RECORD_SCHEMA], [false, true, false, 'fail', true, true]);
});

test('a shown range is re-read for brace closure and reports what it can see', () => {
  const closed = extentReceipt(text, [1, 4]), open = extentReceipt(text, [1, 3]), none = extentReceipt('a\nb\nc', [1, 2]);
  assert.deepEqual([closed.closes_what_it_opens, open.closes_what_it_opens, open.brace_depth_at_end, none.closes_what_it_opens], [true, false, 1, null]);
});

test('stale identity is exposed, and identity evidence keeps every identifying fact in an order that does not depend on edge order', async () => {
  const stale = subjectIdentity({ node: { node_id: 'n', kind: 'Symbol', label: 'registration', line: 6 }, fileText: text, ownRange: [5, 7] });
  const facts = [{ fact_id: 'f2', line: 137, fact_label: 'cap' }, { fact_id: 'f1', line: 78, fact_label: 'logger' }];
  const a = identityOf('cap', null, facts), b = identityOf('cap', null, [...facts].reverse());
  const amb = identityOf('cap', null, [{ fact_id: 'x', line: 3, fact_label: 'a' }, { fact_id: 'y', line: 9, fact_label: 'b' }]);
  const uniq = identityOf('cap', null, [{ fact_id: 'x', line: 3, fact_label: 'a' }, { fact_id: 'y', line: 3, fact_label: 'b' }]);
  assert.deepEqual([stale.identity_status, JSON.stringify(a) === JSON.stringify(b), a.status, a.resolved_line, a.facts.map(f => f.line), amb.status, amb.resolved_line, uniq.status, identityOf('x', 12, []).status], ['label_not_found_near_recorded_line', true, 'resolved_by_label', 137, [78, 137], 'ambiguous', null, 'unique_line', 'own_line']);
});

test('buildFrontier keeps every identifying fact and gives the same evidence whatever the edge order, while the historical candidate line is unchanged', async () => {
  const mkdir = names => { const d = mkdtempSync(join(tmpdir(), 'frontier-')); return d; };
  const info = new Map([['m', { k: 'Module', r: 'shop', f: 'a.js', l: null }], ['e', { k: 'Capability', r: 'shop', f: 'a.js', l: null, lb: 'cap' }], ['s1', { k: 'Symbol', r: 'shop', f: 'a.js', l: null, lb: 'a1' }], ['s2', { k: 'Symbol', r: 'shop', f: 'a.js', l: null, lb: 'a2' }], ['s3', { k: 'Symbol', r: 'shop', f: 'a.js', l: null, lb: 'a3' }],
    ['f1', { k: 'CodeFact', r: 'shop', f: 'a.js', l: 78, lb: 'logger' }], ['f2', { k: 'CodeFact', r: 'shop', f: 'a.js', l: 137, lb: 'cap' }], ['f3', { k: 'CodeFact', r: 'shop', f: 'a.js', l: 5, lb: 'a1' }], ['f4', { k: 'CodeFact', r: 'shop', f: 'a.js', l: 6, lb: 'a2' }], ['f5', { k: 'CodeFact', r: 'shop', f: 'a.js', l: 7, lb: 'a3' }]]);
  const state = new Map([['m', { d: 'unplaced' }]]);
  const edges = [['identifies', 'f1', 'e'], ['identifies', 'f2', 'e'], ['identifies', 'f3', 's1'], ['identifies', 'f4', 's2'], ['identifies', 'f5', 's3'], ['declares_symbol', 'm', 'e'], ['declares_symbol', 'm', 's1'], ['declares_symbol', 'm', 's2'], ['declares_symbol', 'm', 's3']].map(([relation, from, to]) => ({ relation, from, to }));
  const run = async order => { const dir = mkdtempSync(join(tmpdir(), 'frontier-')); writeFileSync(join(dir, 'projection-edges.jsonl'), order.map(e => JSON.stringify(e)).join('\n')); return buildFrontier({ graphDir: dir, coverage: { info, state }, generation: { collections: [] }, repository: 'shop' }); };
  const one = await run(edges), two = await run([...edges].reverse());
  const cap = f => f[0].candidates.find(c => c.label === 'cap');
  assert.deepEqual([JSON.stringify(cap(one).identity) === JSON.stringify(cap(two).identity), cap(one).identity.status, cap(one).identity.resolved_line, cap(one).identity.facts.length, cap(one).line === 78 || cap(one).line === 137], [true, 'resolved_by_label', 137, 2, true]);
  void mkdir;
});

test('the sentence variant differs from the original prompt in exactly one sentence, and the default prompt is unchanged', () => {
  const packet = { file: 'a.js', nodes: [], declarations: [], concepts: [] };
  const original = judgePrompt(packet, { allowNew: true }), fixed = judgePrompt(packet, { allowNew: true, variant: 'sentence_fixed' }), explicit = judgePrompt(packet, { allowNew: true, variant: 'original' });
  assert.deepEqual([original === explicit, original.includes(PART_ONLY_SENTENCE), fixed.includes(PART_ONLY_SENTENCE), fixed.includes(SENTENCE_FIXED), fixed === original.replace(PART_ONLY_SENTENCE, SENTENCE_FIXED)], [true, true, false, true, true]);
});

test('forcing the concept list reproduces a recorded packet exactly in its recorded order', () => {
  const vocab = [concept({ accession: 'a' }), concept({ accession: 'b' }), concept({ accession: 'c' })];
  const fam = { family_id: 'f', file: 'a.js', mode: 'code', candidates: [{ node_id: 'fn', kind: 'Symbol', label: 'openLedger', line: 1 }], participation: [] };
  const p = familyPacket(fam, text, vocab, undefined, { escalated: true, forcedConceptIds: ['c', 'a'] });
  assert.deepEqual(p.packet.concepts.map(c => c.id), ['c', 'a']);
});

test('a replay diff keys on node, role, concept and predicate and states that a difference is not a correctness difference', () => {
  const a = [rec(binding({ binding_id: '1' }))], b = [rec(binding({ binding_id: '2' })), rec(binding({ binding_id: '3', node_id: 'k', node_label: 'PATH', node_line: 2, role: 'relates', predicate: 'describes', evidence: { start_line: 2, end_line: 2, quote: 'const PATH = "x";' } }))];
  const d = diffReplays(a, b);
  assert.deepEqual([d.in_both, d.only_in_first.length, d.only_in_second.map(x => x.node), /not a difference in correctness/u.test(d.note)], [1, 0, ['PATH'], true]);
});
