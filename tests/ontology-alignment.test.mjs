import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverOntology, sealDiscoveryCorpus } from '../tools/ontology/discovery.mjs';
import { alignGenerations, alignmentViewModel, ALIGN_BOUNDS } from '../tools/ontology/alignment.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const runtime = { models: { code_claims: { name: 'example-provider/example-model', thinking: 'off' } }, ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100_000 } };
const files = {
  'gateway/login.mjs': 'export function admit(request, sessions) {\n  const token = request.headers.badge;\n  return sessions.verify(token);\n}',
  'ledger/store.mjs': 'export const keeperTable = {\n  partitionKey: "lanternId",\n  sortKey: "keeperId",\n};',
  'notes/decisions.md': '# Decisions\n\nD1: Keepers and visitors use separate ledgers.\nD2: Visitors are admitted by badge only.',
  'gateway/audit.mjs': 'export function record(keeper, ledger) {\n  ledger.append(keeper.id);\n}',
  'notes/typography.md': '# Typography\n\nLedger lines separate the columns of a printed page.\nHeadlines use a rounded face.',
  'notes/palette.md': '# Palette\n\nDusk indigo is the primary colour.\nEmber gold marks each call to action.',
  'notes/rights.md': '# Rights\n\nThe lantern photographs are ours to ship.',
  'notes/inspiration.md': '# Inspiration\n\nThird-party lantern photographs are reference only and are never shipped.',
  'ledger/schema.yml': 'keeper_table:\n  key: keeperId\n  owner: ledger',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function commit(dir, message) {
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message]);
  return git(dir, 'rev-parse', 'HEAD');
}
function write(dir, entries) {
  for (const [path, body] of Object.entries(entries)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), `${body}\n`); }
}
function art(dir, sha, id, path, kind) {
  const body = git(dir, 'show', `${sha}:${path}`);
  return { artifact_id: id, kind, repository: 'lantern', commit_sha: sha, path, start_line: 1, end_line: body.split('\n').length, blob_oid: git(dir, 'rev-parse', `${sha}:${path}`),
    content_sha256: hash(body), text: body, provenance: kind, graph_node_ids: [] };
}
const corpusAt = (dir, sha) => sealDiscoveryCorpus({ source_identity: { projection_id: null, repo_pins: { lantern: sha } }, selection_policy: 'invented fixture',
  outbound_review: { status: 'approved_for_selected_llm', policy: 'invented fixture' }, unsupported: [], withheld: [],
  collections: [
    { collection_id: 'software', held_out_artifact_ids: ['specimen-4'], artifacts: [art(dir, sha, 'specimen-1', 'gateway/login.mjs', 'code'), art(dir, sha, 'specimen-2', 'ledger/store.mjs', 'code'),
      art(dir, sha, 'specimen-3', 'notes/decisions.md', 'document_claim'), art(dir, sha, 'specimen-4', 'gateway/audit.mjs', 'code'), art(dir, sha, 'specimen-5', 'ledger/schema.yml', 'structured_source')] },
    { collection_id: 'brand', held_out_artifact_ids: ['br-3'], artifacts: [art(dir, sha, 'br-1', 'notes/typography.md', 'document_claim'), art(dir, sha, 'br-2', 'notes/palette.md', 'document_claim'),
      art(dir, sha, 'br-3', 'notes/rights.md', 'document_claim'), art(dir, sha, 'br-4', 'notes/inspiration.md', 'third_party_reference')] }] });
const concept = (key, scheme, category, label, definition, support, domain = []) => ({ stable_key: key, scheme_key: scheme, semantic_category: category, label, definition,
  inclusion: `Source showing ${label}.`, exclusion: `Mentions only.`, domain, invariants: [], instance_conditions: [], aliases: [], support, counterexamples: [] });
const synthesis = {
  software: { schemes: [{ key: 'behaviour', label: 'Behaviour', definition: 'What the system does or decides.' }], relations: [], unresolved: [], gaps: [], uncovered: [],
    concepts: [
      concept('admission', 'behaviour', 'responsibility', 'Visitor admission', 'Code admits a visitor by verifying a badge token against active sessions.', [{ artifact_id: 'specimen-1', quote: 'return sessions.verify(token);' }], ['code_construct']),
      concept('keeper-records', 'behaviour', 'responsibility', 'Keeper records', 'Code defines the table that stores one record per keeper.', [{ artifact_id: 'specimen-2', quote: 'sortKey: "keeperId"' }], ['code_construct']),
      concept('record-schema', 'behaviour', 'type', 'Keeper record schema', 'A declared schema that names the key of the keeper table.', [{ artifact_id: 'specimen-5', quote: 'key: keeperId' }], ['configuration_entry']),
      concept('ledger-separation', 'behaviour', 'strategy', 'Separate ledgers', 'A decision keeps keeper and visitor records in separate ledgers.', [{ artifact_id: 'specimen-3', quote: 'D1: Keepers and visitors use separate ledgers.' }], ['decision'])] },
  brand: { schemes: [{ key: 'expression', label: 'Expression', definition: 'How the brand looks.' }], relations: [], unresolved: [], gaps: [], uncovered: [],
    concepts: [
      concept('ledger-rules', 'expression', 'type', 'Ledger rules', 'Thin printed lines that separate the columns of a typographic page.', [{ artifact_id: 'br-1', quote: 'Ledger lines separate the columns of a printed page.' }], ['specification']),
      concept('palette', 'expression', 'type', 'Palette colour', 'A named colour in the brand palette.', [{ artifact_id: 'br-2', quote: 'Dusk indigo is the primary colour.' }], ['specification']),
      concept('use-rules', 'expression', 'policy', 'Reference-only use', 'A rule that third-party images may be studied but not copied or shipped.', [{ artifact_id: 'br-4', quote: 'reference only and are never shipped.' }], ['asset']),
      concept('lantern-photographs', 'expression', 'type', 'Lantern photograph', 'A photograph whose subject is a lantern.', [{ artifact_id: 'br-4', quote: 'Third-party lantern photographs' }], ['asset'])] },
};
const acc = (c, k) => `ontology-concept:${c}/${k}`;
const grounding = {
  'specimen-1': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'admit function', quote: 'export function admit(request, sessions) {' }], assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'admission') }] },
  'specimen-2': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'keeper table', quote: 'export const keeperTable = {' }], assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') }] },
  'specimen-3': { referents: [{ ref: 'r1', kind: 'decision', name: 'D1 separate ledgers', quote: 'D1: Keepers and visitors use separate ledgers.' }], assertions: [{ ref: 'r1', predicate: 'selects', concept: acc('software', 'ledger-separation') }] },
  'br-1': { referents: [{ ref: 'r1', kind: 'specification', name: 'ledger line rule', quote: 'Ledger lines separate the columns of a printed page.' }], assertions: [{ ref: 'r1', predicate: 'is_a', concept: acc('brand', 'ledger-rules') }] },
  'specimen-5': { referents: [{ ref: 'r1', kind: 'configuration_entry', name: 'keeper key declaration', quote: 'key: keeperId' }], assertions: [{ ref: 'r1', predicate: 'is_a', concept: acc('software', 'record-schema') }] },
  'br-4': { referents: [{ ref: 'r1', kind: 'asset', name: 'third-party lantern photographs', quote: 'Third-party lantern photographs' }, { ref: 'r2', kind: 'rule', name: 'reference-only rule', quote: 'reference only and are never shipped.' }],
    assertions: [{ ref: 'r1', predicate: 'subject_to', concept: acc('brand', 'use-rules') }, { ref: 'r1', predicate: 'is_a', concept: acc('brand', 'lantern-photographs') },
      { ref: 'r2', predicate: 'defines', concept: acc('brand', 'use-rules') }] },
  'br-2': { referents: [{ ref: 'r1', kind: 'specification', name: 'primary colour', quote: 'Dusk indigo is the primary colour.' }], assertions: [{ ref: 'r1', predicate: 'is_a', concept: acc('brand', 'palette') }] },
};
const discoveryModel = async prompt => {
  const packet = JSON.parse(prompt.split('\n\n').at(-1));
  let answer;
  if (packet.schema === 'estate-map/ontology-discovery-packet/v4') answer = packet.prior_vocabulary ? { new_schemes: [], new_concepts: [], changes: [], evidence_additions: [], relations: [], unresolved: [], gaps: [], uncovered: [] } : synthesis[packet.collection_id];
  else if (packet.schema === 'estate-map/ontology-subject-grounding-packet/v3') answer = { subject_status: [], instance_status: [], artifact_status: null, ...(grounding[packet.artifact.artifact_id] ?? { referents: [], assertions: [] }) };
  else if (packet.schema === 'estate-map/ontology-expansion-packet/v2') answer = { new_schemes: [], new_concepts: [], evidence_additions: [], uncovered: [], changes: [] };
  else if (packet.schema === 'estate-map/ontology-identity-packet/v1') answer = { decisions: [] };
  else answer = { pairs: [] };
  return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
};
async function world({ edit = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alignment-'));
  git(dir, 'init', '-q');
  write(dir, files);
  const first = commit(dir, 'Create');
  const c0 = corpusAt(dir, first);
  const g0 = (await discoverOntology({ corpus: c0, runtime, repositories: { lantern: dir }, modelCall: discoveryModel })).generation;
  let c1 = null, g1 = null;
  if (edit) {
    write(dir, edit);
    const second = commit(dir, 'Change');
    c1 = corpusAt(dir, second);
    g1 = (await discoverOntology({ corpus: c1, runtime, repositories: { lantern: dir }, priorGeneration: g0, modelCall: discoveryModel })).generation;
  }
  return { dir, c0, g0, c1, g1 };
}
const accessionOf = (g, collection, key) => g.collections.find(c => c.collection_id === collection).concepts.find(c => c.accession === acc(collection, key));
// An alignment model that answers from a rule on the labels of a pair.
const alignModel = (rule, subjectRule = () => [], retrieve = () => []) => {
  const seen = [];
  const call = async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    seen.push(packet);
    let answer;
    if (packet.schema === 'estate-map/ontology-retrieval-packet/v1') answer = { pairs: retrieve(packet) };
    else if (packet.schema === 'estate-map/ontology-alignment-packet/v1') answer = { links: packet.pairs.map(p => rule(p)) };
    else answer = { subject_links: subjectRule(packet) };
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
  };
  return { call, seen };
};
const own = a => a.links.filter(l => !l.derived);
const ownS = a => a.subject_links.filter(l => !l.derived);
const ids = side => side.support.map(e => e.evidence_id);
const none = p => ({ pair_id: p.pair_id, relation: 'none', reason: 'different meaning' });
const run = (w, model, extra = {}) => alignGenerations({ generations: [w.g1 ?? w.g0], corpora: [w.c1 ?? w.c0], runtime, modelCall: model.call, ...extra });
const labels = p => `${p.a.label}|${p.b.label}`;

test('the same word with a different meaning is judged none, and is recorded rather than linked', async () => {
  const w = await world();
  const model = alignModel(p => (labels(p).includes('Separate ledgers') && labels(p).includes('Ledger rules') ? none(p) : none(p)));
  const { alignment } = await run(w, model);
  const pair = model.seen.find(x => x.pairs).pairs.find(p => labels(p).includes('Separate ledgers') && labels(p).includes('Ledger rules'));
  assert.deepEqual([Boolean(pair), own(alignment).length, alignment.judged_none.length > 0, alignment.accepted], [true, 0, true, false]);
});

test('a link needs quoted support on both sides, an uncertainty, and a known pair', async () => {
  const w = await world();
  const model = alignModel(p => ({ pair_id: p.pair_id, relation: 'same_concept', uncertainty: 'low', evidence_a: ids(p.a), evidence_b: [], reason: 'x' }));
  const { alignment } = await run(w, model);
  assert.deepEqual([own(alignment).length, [...new Set(alignment.rejected.map(r => r.code))]], [0, ['EVIDENCE_NEEDED_ON_BOTH_SIDES']]);
});

test('a hierarchy needs an exact inclusion quote from the broader definition, not shared terms', async () => {
  const w = await world();
  const base = p => ({ pair_id: p.pair_id, relation: 'broader', broader_side: 'a', uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' });
  const bad = await run(w, alignModel(p => ({ ...base(p), inclusion_basis: 'the broader concept covers it entirely' })));
  const good = await run(w, alignModel(p => ({ ...base(p), inclusion_basis: p.a.definition.slice(0, 30) })));
  const view = alignmentViewModel(good.alignment, [w.g0]);
  assert.deepEqual([own(bad.alignment).length, [...new Set(bad.alignment.rejected.map(r => r.code))], own(good.alignment).length > 0,
    own(good.alignment).every(l => l.inclusion_basis.length >= 12), view.hierarchy.length === own(good.alignment).length],
  [0, ['HIERARCHY_WITHOUT_INCLUSION_BASIS'], true, true, true]);
});

test('a document may specify what source observably does, but cannot be implemented_by without observation', async () => {
  const w = await world();
  const keeper = labels2 => labels2.includes('Keeper records');
  const pairOf = p => labels(p);
  const specify = kind => alignModel(p => (pairOf(p).includes('Separate ledgers') && keeper(pairOf(p))
    ? { pair_id: p.pair_id, relation: 'related', cross_kind: kind, uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' } : none(p)));
  const specifies = await run(w, specify('specifies'), { includeWithinCollection: true });
  const implemented = await run(w, specify('implemented_by'), { includeWithinCollection: true });
  const link = own(specifies.alignment)[0];
  assert.deepEqual([own(specifies.alignment).length, link.cross_kind, link.source_observation.observed_instances > 0, link.source_observation.observed_subjects.length > 0,
    own(implemented.alignment).length, implemented.alignment.counts.cross_kind_links],
  [1, 'specifies', true, true, 1, 1]);
});

test('implemented_by is refused when the source concept has no observed instance, and a cross kind needs a document and a source', async () => {
  const w = await world();
  const model = alignModel(p => ({ pair_id: p.pair_id, relation: 'related', cross_kind: 'implemented_by', uncertainty: 'low', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' }));
  const { alignment } = await run(w, model, { includeWithinCollection: true });
  const codes = new Set(alignment.rejected.map(r => r.code));
  assert.deepEqual([[...codes].every(c => ['CROSS_KIND_NEEDS_DOCUMENT_AND_SOURCE_CONCEPTS', 'IMPLEMENTATION_NOT_OBSERVED'].includes(c)), own(alignment).every(l => l.source_observation.observed_instances > 0)], [true, true]);
});

test('subject links carry both quote endpoints and context, and a document cannot be a source-observed specifier', async () => {
  const w = await world();
  const rel = p => (labels(p).includes('Separate ledgers') && labels(p).includes('Keeper records')
    ? { pair_id: p.pair_id, relation: 'related', cross_kind: 'specifies', uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' } : none(p));
  const find = (packet, label) => (packet.concept_a.label.includes(label) ? 'a' : 'b');
  const good = alignModel(rel, packet => { const d = find(packet, 'Separate'); const s = d === 'a' ? 'b' : 'a';
    return [{ a_ref: 'a1', b_ref: 'b1', relation: 'specifies', from_side: d, uncertainty: 'medium', reason: s }]; });
  const wrong = alignModel(rel, packet => { const d = find(packet, 'Separate'); const s = d === 'a' ? 'b' : 'a';
    return [{ a_ref: 'a1', b_ref: 'b1', relation: 'specifies', from_side: s, uncertainty: 'medium', reason: d }]; });
  const ok = await run(w, good, { includeWithinCollection: true });
  const bad = await run(w, wrong, { includeWithinCollection: true });
  const s = ownS(ok.alignment)[0];
  assert.deepEqual([ownS(ok.alignment).length, s.a_endpoint.quote.length > 0 && s.b_endpoint.quote.length > 0, s.a_endpoint.context_sha256.length, s.request_digest.length,
    ownS(bad.alignment).length, bad.alignment.rejected.some(r => r.code === 'SPECIFIER_KIND_NOT_DECLARATIVE')], [1, true, 64, 64, 0, true]);
});

test('independent contexts keep their pins and collection contexts on every link endpoint', async () => {
  const w = await world();
  const model = alignModel(p => ({ pair_id: p.pair_id, relation: 'related', uncertainty: 'high', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' }));
  const { alignment } = await run(w, model);
  const l = own(alignment)[0];
  assert.deepEqual([l.a_endpoint.collection_id !== l.b_endpoint.collection_id, l.a_endpoint.pins.length > 0, l.a_endpoint.collection_context_id !== l.b_endpoint.collection_context_id,
    l.a_endpoint.evidence.every(e => e.verified_at_pin), l.model.scaffold, alignment.model_config.bounds.pairs_total], [true, true, true, true, 'cross_collection_alignment/v1', ALIGN_BOUNDS.pairs_total]);
});

test('an unchanged alignment replays with no call, and an updated one carries only judgements whose endpoints are unchanged', async () => {
  const w = await world({ edit: { 'ledger/store.mjs': 'export const index = [];' } });
  const rel = p => ({ pair_id: p.pair_id, relation: 'related', uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' });
  const first = await alignGenerations({ generations: [w.g0], corpora: [w.c0], runtime, modelCall: alignModel(rel).call });
  const replay = await alignGenerations({ generations: [w.g0], corpora: [w.c0], runtime, modelCall: alignModel(rel).call, priorAlignment: first.alignment });
  const updated = await alignGenerations({ generations: [w.g1], corpora: [w.c1], runtime, modelCall: alignModel(rel).call, priorAlignment: first.alignment });
  const keeper = own(first.alignment).find(l => [l.a_endpoint.label, l.b_endpoint.label].includes('Keeper records'));
  assert.deepEqual([replay.receipt.new_model_calls, replay.alignment.counts.carried_links === own(first.alignment).length, Boolean(keeper),
    updated.alignment.withheld_concepts.some(c => c.accession === acc('software', 'keeper-records') && c.reason === 'support_stale'),
    own(updated.alignment).some(l => [l.a_endpoint.label, l.b_endpoint.label].includes('Keeper records')),
    updated.alignment.stale_links.some(s => [s.a_label, s.b_label].includes('Keeper records') && /support_unavailable/u.test(s.reason))],
  [0, true, true, true, false, true]);
});

test('the aligned view keeps every original concept, labels each link, and lists unaligned and withheld ones', async () => {
  const w = await world({ edit: { 'ledger/store.mjs': 'export const index = [];' } });
  const rel = p => (labels(p).includes('Palette') ? none(p) : { pair_id: p.pair_id, relation: 'close_match', uncertainty: 'low', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' });
  const { alignment } = await alignGenerations({ generations: [w.g1], corpora: [w.c1], runtime, modelCall: alignModel(rel).call });
  const view = alignmentViewModel(alignment, [w.g1]);
  assert.deepEqual([view.concepts.length, view.concepts.every(c => c.collection_id && c.generation_id && c.version_id), view.links.every(l => l.a_endpoint.evidence.length && l.b_endpoint.evidence.length),
    view.withheld_concepts.map(c => c.reason), view.unaligned.length + new Set(view.links.flatMap(l => [l.a_endpoint.accession, l.b_endpoint.accession])).size <= view.concepts.length],
  [8, true, true, ['support_stale'], true]);
});

const byLabel = (packet, label) => packet.concepts.find(c => c.label === label)?.id;
const toKeeper = p => labels(p).includes('Visitor admission') && labels(p).includes('Palette colour');

test('a semantic shortlist adds pairs the word baseline misses, records why, and refuses unknown or same-collection ids', async () => {
  const retrieve = packet => [{ a: byLabel(packet, 'Visitor admission'), b: byLabel(packet, 'Palette colour'), reason: 'both govern who or what is let in', gap: null },
    { a: 'c999', b: byLabel(packet, 'Palette colour'), reason: 'x' }, { a: byLabel(packet, 'Visitor admission'), b: byLabel(packet, 'Keeper records'), reason: 'same collection' }];
  const model = alignModel(none, () => [], retrieve);
  const w = await world();
  const { alignment } = await run(w, model);
  const added = alignment.judged_none.filter(n => n.retrieval.some(r => r.source === 'semantic'));
  const sem = alignment.candidate_pairs.semantic;
  assert.deepEqual([sem.proposed, sem.rejected.map(r => r.code).sort(), added.length >= 1, added[0].retrieval.find(r => r.source === 'semantic').reason, sem.added_beyond_lexical >= 1,
    alignment.candidate_pairs.lexical.over_count >= 0, alignment.candidate_pairs.note.includes('zero links does not mean zero relations')],
  [1, ['CONCEPT_ID_UNKNOWN', 'SAME_COLLECTION'], true, 'both govern who or what is let in', true, true, true]);
});

test('an unsettled pair gets one wider look at the same pin with a receipt, and stays needs_context apart from none', async () => {
  const w = await world();
  const rounds = [];
  const settle = p => (toKeeper(p) ? { pair_id: p.pair_id, relation: 'needs_context', wanted: 'what the palette governs' } : none(p));
  const model = alignModel(settle, () => [], packet => [{ a: byLabel(packet, 'Visitor admission'), b: byLabel(packet, 'Palette colour'), reason: 'x' }]);
  const { alignment } = await run(w, model);
  for (const packet of model.seen.filter(x => x.pairs)) rounds.push(packet.round);
  const widerPacket = model.seen.find(x => x.pairs && x.round === 2);
  const side = widerPacket.pairs[0].a;
  const need = alignment.needs_context[0];
  assert.deepEqual([rounds.includes(2), side.context_receipt.same_pin, side.context_receipt.budget_bytes, typeof side.context_receipt.truncated, side.wider_context.passages.length > 0,
    alignment.needs_context.length, need.final, need.wanted, alignment.judged_none.some(n => n.pair_key === need.pair_key), own(alignment).length],
  [true, true, 3000, 'boolean', true, 1, true, 'what the palette governs', false, 0]);
});

test('a pair settled by the wider look is recorded with its round and receipt, not as needing context', async () => {
  const w = await world();
  const settle = p => (toKeeper(p) ? (p.a.wider_context ? none(p) : { pair_id: p.pair_id, relation: 'needs_context', wanted: 'more' }) : none(p));
  const model = alignModel(settle, () => [], packet => [{ a: byLabel(packet, 'Visitor admission'), b: byLabel(packet, 'Palette colour'), reason: 'x' }]);
  const { alignment } = await run(w, model);
  const settled = alignment.judged_none.find(n => n.round === 2);
  assert.deepEqual([Boolean(settled), alignment.needs_context.length], [true, 0]);
});

test('a policy governs the concept whose instance is subject_to it, read from the quoted assertions; a referenced asset is not verified', async () => {
  const w = await world();
  const { alignment } = await run(w, alignModel(none));
  const link = alignment.links.find(l => l.role_kind === 'governs');
  const sub = alignment.subject_links.find(l => l.relation === 'governed_by');
  assert.deepEqual([link.a_endpoint.label, link.b_endpoint.label, link.relation, link.derived, link.via_subject.referenced_not_read, link.via_subject.ownership_verified, link.via_subject.binary_read,
    link.via_subject.claim_standing, link.a_endpoint.evidence.every(e => e.verified_at_pin), link.b_endpoint.evidence.map(e => e.quote).includes('Third-party lantern photographs'),
    link.reason.includes('not an identity'), sub.a_endpoint.quote, sub.b_endpoint.name, link.relation === 'same_concept'],
  ['Reference-only use', 'Lantern photograph', 'related', true, true, false, false, 'third_party_reference', true, true, true, 'reference only and are never shipped.', 'third-party lantern photographs', false]);
});

test('a governed subject is listed with its policy, the defining rule and what is not verified, even with no describing concept', async () => {
  const w = await world();
  const { alignment } = await run(w, alignModel(none));
  const g = alignment.governed_subjects.find(x => x.policy.label === 'Reference-only use');
  assert.deepEqual([g.subject.name, g.subject.claim_standing, g.subject.referenced_not_read, g.subject.ownership_verified, g.subject.binary_read, g.subject.evidence.verified_at_pin,
    g.rules[0].quote, g.rules[0].verified_at_pin, alignment.counts.governed_subjects >= 1],
  ['third-party lantern photographs', 'third_party_reference', true, false, false, true, 'reference only and are never shipped.', true, true]);
});

test('a declared schema in observed source can specify a source subject; an observed status is declared, not verified', async () => {
  const w = await world();
  const rel = p => (labels(p).includes('Keeper record schema') && labels(p).includes('Keeper records')
    ? { pair_id: p.pair_id, relation: 'related', uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' } : none(p));
  const sideOf = (packet, label) => (packet.concept_a.label === label ? 'a' : 'b');
  const specifier = packet => { const from = sideOf(packet, 'Keeper record schema'); return [{ a_ref: 'a1', b_ref: 'b1', relation: 'specifies', from_side: from, uncertainty: 'medium', reason: 'schema declares the key' }]; };
  const evidenced = nature => packet => { const from = sideOf(packet, 'Keeper record schema'); return [{ a_ref: 'a1', b_ref: 'b1', relation: 'evidenced_by', from_side: from, uncertainty: 'medium', evidence_nature: nature, reason: 'x' }]; };
  const ok = await run(w, alignModel(rel, specifier), { includeWithinCollection: true });
  const noNature = await run(w, alignModel(rel, evidenced(null)), { includeWithinCollection: true });
  const declared = await run(w, alignModel(rel, evidenced('declared_in_source')), { includeWithinCollection: true });
  const spec = ok.alignment.subject_links.find(l => l.relation === 'specifies');
  assert.deepEqual([Boolean(spec), spec?.a_endpoint.standing === 'source_observed' || spec?.b_endpoint.standing === 'source_observed',
    noNature.alignment.rejected.some(r => r.code === 'EVIDENCE_NATURE_MISSING'), declared.alignment.subject_links.find(l => l.relation === 'evidenced_by')?.evidence_nature],
  [true, true, true, 'declared_in_source']);
});

test('subject needs_context and no_link are recorded separately from links', async () => {
  const w = await world();
  const rel = p => (labels(p).includes('Keeper record schema') && labels(p).includes('Keeper records')
    ? { pair_id: p.pair_id, relation: 'related', uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' } : none(p));
  const rounds = [];
  const sub = packet => { rounds.push(packet.round); return []; };
  const model = alignModel(rel, packet => { const base = sub(packet); return base; });
  const original = model.call;
  const wrapped = { seen: model.seen, call: async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    if (packet.schema === 'estate-map/ontology-subject-link-packet/v1') {
      const answer = packet.round === 1 ? { subject_links: [], no_link: [], needs_context: [{ a_ref: 'a1', b_ref: 'b1', wanted: 'the table definition' }] } : { subject_links: [], no_link: [{ a_ref: 'a1', b_ref: 'b1', reason: 'sufficient, unrelated' }], needs_context: [] };
      rounds.push(packet.round);
      return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
    }
    return original(prompt);
  } };
  const { alignment } = await run(w, wrapped, { includeWithinCollection: true });
  assert.deepEqual([rounds, alignment.subject_links.filter(l => !l.derived).length, alignment.subject_needs_context.length, alignment.subject_no_link.map(n => n.round)], [[1, 2], 0, 0, [2]]);
});

// ---- Replay: every paid answer is a terminal recorded result, refusals included.
const mixedRule = p => {
  const n = [...labels(p)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 4;
  const base = { pair_id: p.pair_id, uncertainty: 'medium', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'x' };
  if (n === 0) return { ...base, relation: 'broader', broader_side: 'a', inclusion_basis: 'not a quote of the broader definition at all' };
  if (n === 1) return none(p);
  if (n === 2) return { pair_id: p.pair_id, relation: 'needs_context', wanted: 'the definition elsewhere' };
  return { ...base, relation: 'related' };
};
const retrieveAll = packet => packet.concepts.flatMap((a, i) => packet.concepts.slice(i + 1).map(b => ({ a: a.id, b: b.id, reason: 'try' })));
const identityOfRun = ({ alignment }) => ({ id: alignment.alignment_id, links: alignment.links.map(l => l.link_id).sort(), refusals: alignment.rejected.map(r => `${r.where}:${r.code}:${r.pair_key ?? r.link_id}`).sort(),
  none: alignment.judged_none.map(n => n.pair_key).sort(), needs: alignment.needs_context.map(n => n.pair_key).sort(), subject: alignment.subject_links.map(l => l.subject_link_id).sort(),
  over: alignment.candidate_pairs.semantic.rejected.map(r => r.code).sort(), lexOver: alignment.candidate_pairs.lexical.over_count });
const noCalls = () => ({ call: async () => { throw new Error('a replay must not call the model'); } });

test('a replay reproduces refused hierarchy, none, needs_context, over-bound and accepted judgements with no call and the same identity', async () => {
  const w = await world();
  const first = await run(w, alignModel(mixedRule, () => [], retrieveAll), { includeWithinCollection: true });
  const replay = await run(w, noCalls(), { includeWithinCollection: true, priorAlignment: first.alignment });
  const a = identityOfRun(first), b = identityOfRun(replay);
  const refused = first.alignment.rejected.filter(r => r.code === 'HIERARCHY_WITHOUT_INCLUSION_BASIS');
  assert.deepEqual([replay.receipt.new_model_calls, replay.receipt.new_cost_usd, b, refused.length > 0, refused.every(r => r.pair_key && r.row && r.request_digest && r.policy_sha256 && r.refusal_id),
    first.alignment.judged_none.length > 0, first.alignment.needs_context.length > 0, own(first.alignment).length > 0, replay.alignment.rejected.filter(r => r.code === 'HIERARCHY_WITHOUT_INCLUSION_BASIS').every(r => r.carried_from)],
  [0, 0, a, true, true, true, true, true, true]);
});

test('a refused pair is not asked again unless a reconsideration is explicitly requested, and then links the prior refusal', async () => {
  const w = await world();
  const first = await run(w, alignModel(mixedRule, () => [], retrieveAll), { includeWithinCollection: true });
  const again = alignModel(p => ({ pair_id: p.pair_id, relation: 'related', uncertainty: 'low', evidence_a: ids(p.a), evidence_b: ids(p.b), reason: 'reconsidered' }), () => [], retrieveAll);
  const redo = await run(w, again, { includeWithinCollection: true, priorAlignment: first.alignment, reconsiderRefused: true });
  const refusalIds = new Set(first.alignment.rejected.filter(r => r.where === 'concept_link').map(r => r.refusal_id));
  const reconsidered = redo.alignment.links.filter(l => l.reconsiders);
  assert.deepEqual([redo.receipt.new_model_calls > 0, reconsidered.length > 0, reconsidered.every(l => l.reconsiders.every(id => refusalIds.has(id))), redo.alignment.prior_alignment_id === first.alignment.alignment_id],
    [true, true, true, true]);
});

test('under a changed validation policy a stored refusal is re-judged from its stored answer with no call, recording the new interpretation', async () => {
  const w = await world();
  const first = await run(w, alignModel(mixedRule, () => [], retrieveAll), { includeWithinCollection: true });
  const old = structuredClone(first.alignment);
  const target = old.rejected.find(r => r.code === 'HIERARCHY_WITHOUT_INCLUSION_BASIS');
  const pairConcept = [...w.g0.collections.flatMap(c => c.concepts)].find(c => c.label === target.a_label);
  target.row.inclusion_basis = pairConcept.definition.slice(0, 30);
  old.model_config = { ...old.model_config, policy_sha256: 'an-earlier-policy' };
  for (const r of old.rejected) r.policy_sha256 = 'an-earlier-policy';
  const replay = await run(w, noCalls(), { includeWithinCollection: true, priorAlignment: old });
  const link = replay.alignment.links.find(l => l.reinterpreted);
  assert.deepEqual([replay.receipt.new_model_calls, Boolean(link), link?.relation, link?.reinterpreted.from_policy, link?.reinterpreted.to_policy === replay.alignment.model_config.policy_sha256,
    link?.inclusion_basis.length >= 12, replay.alignment.alignment_id === first.alignment.alignment_id], [0, true, 'broader', 'an-earlier-policy', true, true, false]);
});
