import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DECLARED_BOUNDS, callDiscoveryLlm, commentLineFlags, locate, spanClassOf, discoverOntology, discoveryViewModel, groundingPrompt, linkedContext, parseAnswer, resolveUnknownAttempt, sealDiscoveryCorpus,
  validateDiscoveryCorpus } from '../tools/ontology/discovery.mjs';
import { startCandidateView } from '../tools/ontology/candidate-view.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const files = {
  'gateway/login.mjs': 'export function admit(request, sessions) {\n  const token = request.headers.badge;\n  return sessions.verify(token);\n}',
  'ledger/store.mjs': 'export const lanternTable = {\n  partitionKey: "lanternId",\n  sortKey: "keeperId",\n};',
  'gateway/audit.mjs': 'export function recordVisit(keeper, ledger) {\n  ledger.append({ keeper: keeper.id, at: Date.now() });\n}',
  'notes/decisions.md': '# Decisions\n\nD1: Keepers and visitors use **separate** ledgers.\nD2: Both ledgers share one schema.',
  'gateway/shape.mjs': 'export function isWellFormed(visit) {\n  return typeof visit.keeper === "string" && visit.keeper.length > 0;\n}',
  'notes/palette.md': '# Palette\n\nDusk indigo is the primary colour.\nEmber gold marks every call to action.\nOur lantern emblem ships with every page.',
  'notes/voice.md': '# Voice\n\nSpeak like a quiet lighthouse keeper.\nNever shout; never hurry the reader.',
  'notes/inspiration.md': '# Inspiration\n\nThird-party lantern photographs; reference only, never shipped.',
  'notes/rights.md': '# Rights\n\nThe lantern photographs are ours to ship.',
  'ledger/tables.mjs': 'export const first = {\n  mode: "on-demand",\n};\nexport const second = {\n  mode: "on-demand",\n};',
};
const acc = (collection, key) => `ontology-concept:${collection}/${key}`;
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function commitAll(dir, message) {
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message]);
  return git(dir, 'rev-parse', 'HEAD');
}
function write(dir, entries) {
  for (const [path, body] of Object.entries(entries)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), `${body}\n`);
  }
}
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-discovery-'));
  git(dir, 'init', '-q');
  write(dir, files);
  writeFileSync(join(dir, 'notes/emblem.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { dir, commit: commitAll(dir, 'Create lantern estate') };
}
function artifact(dir, commit, id, path, kind) {
  const text = git(dir, 'show', `${commit}:${path}`);
  return { artifact_id: id, kind, repository: 'lantern', commit_sha: commit, path, start_line: 1,
    end_line: text.split('\n').length, blob_oid: git(dir, 'rev-parse', `${commit}:${path}`),
    content_sha256: hash(text), text, graph_node_ids: [] };
}
function corpusFor({ dir, commit, brandCommit = commit, alarm = false }) {
  return sealDiscoveryCorpus({
    source_identity: { projection_id: 'estate-projection:lantern', repo_pins: { lantern: commit } },
    outbound_review: { status: 'approved_for_selected_llm', policy: 'invented fixture' },
    collections: [
      { collection_id: 'software', held_out_artifact_ids: ['software-03'], artifacts: [
        artifact(dir, commit, 'software-01', 'gateway/login.mjs', 'code'),
        artifact(dir, commit, 'software-02', 'ledger/store.mjs', 'code'),
        artifact(dir, commit, 'software-03', 'gateway/audit.mjs', 'code'),
        artifact(dir, commit, 'software-04', 'notes/decisions.md', 'document_claim'),
        artifact(dir, commit, 'software-05', 'gateway/shape.mjs', 'code'),
        ...(alarm ? [artifact(dir, commit, 'software-06', 'gateway/alarm.mjs', 'code')] : [])] },
      { collection_id: 'brand', held_out_artifact_ids: ['brand-04'], artifacts: [
        artifact(dir, brandCommit, 'brand-01', 'notes/palette.md', 'document_claim'),
        artifact(dir, brandCommit, 'brand-02', 'notes/voice.md', 'document_claim'),
        artifact(dir, brandCommit, 'brand-03', 'notes/inspiration.md', 'third_party_reference'),
        artifact(dir, brandCommit, 'brand-04', 'notes/rights.md', 'document_claim')] },
    ],
    unsupported: [{ repository: 'lantern', commit_sha: brandCommit, path: 'notes/emblem.png',
      blob_oid: git(dir, 'rev-parse', `${brandCommit}:notes/emblem.png`), code: 'DISCOVERY_BINARY_UNSUPPORTED',
      state: 'inventoried_not_interpreted' }],
    withheld: [],
  });
}
const runtime = { models: { code_claims: { name: 'example-provider/example-model', thinking: 'off' } },
  ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100_000, system_one: null } };
const concept = (key, scheme, category, label, support, counterexamples = [], domain = []) => ({ stable_key: key, scheme_key: scheme,
  semantic_category: category, label, definition: `${label} as evidenced by the collection.`, inclusion: `Source showing ${label}.`,
  exclusion: `Anything that only mentions ${label}.`, domain, invariants: [], aliases: [], support, counterexamples });
const synthesis = {
  software: { schemes: [{ key: 'responsibility', label: 'Responsibility', definition: 'What the code does.' },
    { key: 'separation', label: 'Separation', definition: 'How parts are kept apart.' }],
  concepts: [
    concept('admission', 'responsibility', 'responsibility', 'Visitor admission', [{ artifact_id: 'software-01', quote: 'return sessions.verify(token);' }],
      [{ artifact_id: 'software-02', quote: 'partitionKey: "lanternId"', reason: 'storage keys, not admission' }], ['code_construct']),
    concept('keeper-records', 'responsibility', 'responsibility', 'Keeper records', [{ artifact_id: 'software-02', quote: 'sortKey: "keeperId"' }]),
    concept('separate-ledgers', 'separation', 'strategy', 'Separate ledgers',
      [{ artifact_id: 'software-04', quote: 'D1: Keepers and visitors use separate ledgers.' }], [], ['decision'])],
  relations: [{ from: 'admission', to: 'keeper-records', type: 'reads', definition: 'Admission consults records.',
    evidence: [{ artifact_id: 'software-01', quote: 'sessions.verify(token)' }] }],
  unresolved: [], gaps: [],
  uncovered: [{ artifact_id: 'software-05', status: 'no_matching_concept', reason: 'Checks a visit payload shape; no concept covers validation.' }] },
  brand: { schemes: [{ key: 'expression', label: 'Expression', definition: 'How the brand presents itself.' }],
    concepts: [
      concept('palette', 'expression', 'type', 'Palette colour', [{ artifact_id: 'brand-01', quote: 'Dusk indigo is the primary colour.' }]),
      concept('quiet-voice', 'expression', 'theme', 'Quiet voice', [{ artifact_id: 'brand-02', quote: 'Speak like a quiet lighthouse keeper.' }]),
      concept('owned-assets', 'expression', 'type', 'Owned asset', [{ artifact_id: 'brand-01', quote: 'Our lantern emblem ships with every page.' }]),
      concept('reference-only-use', 'expression', 'policy', 'Reference-only use', [{ artifact_id: 'brand-03', quote: 'reference only, never shipped' }])],
    relations: [], unresolved: [], gaps: [], uncovered: [] },
};
const anchored = {
  new_schemes: [], evidence_additions: [], relations: [], unresolved: [], gaps: [], uncovered: [],
  new_concepts: [concept('alerting', 'responsibility', 'responsibility', 'Threshold alerting', [{ artifact_id: 'software-06', quote: 'threshold: 10' }])],
  changes: [{ op: 'drop', accessions: [acc('software', 'separate-ledgers')], proposal: [], reason: 'Hypothesis: may be premature.',
    evidence: [{ artifact_id: 'software-04', quote: 'D2: Both ledgers share one schema.' }] }],
};
const grounding = {
  'software-01': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'admit function', quote: 'export function admit(request, sessions) {' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'admission') }], subject_status: [], artifact_status: null },
  'software-02': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'lantern table', quote: 'export const lanternTable = {' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') }], subject_status: [], artifact_status: null },
  'software-03': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'record visit', quote: 'ledger.append' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') }], subject_status: [], artifact_status: null },
  'software-04': { referents: [{ ref: 'r1', kind: 'decision', name: 'D1 separate ledgers', quote: 'D1: Keepers and visitors use separate ledgers.' }],
    assertions: [{ ref: 'r1', predicate: 'selects', concept: acc('software', 'separate-ledgers') },
      { ref: 'r1', predicate: 'implements', concept: acc('software', 'separate-ledgers') },
      { ref: 'r1', predicate: 'describes', concept: acc('software', 'keeper-records') }], subject_status: [], artifact_status: null },
  'software-05': { referents: [{ ref: 'r1', kind: 'code_construct', name: 'well-formed check', quote: 'export function isWellFormed(visit) {' },
    { ref: 'r2', kind: 'code_construct', name: 'keeper length test', quote: 'visit.keeper.length > 0' }],
  assertions: [], subject_status: [{ ref: 'r1', status: 'no_matching_concept', reason: 'Payload shape check, not admission.' }],
  artifact_status: { status: 'no_matching_concept', reason: 'No concept covers payload validation.' } },
  'software-06': { referents: [{ ref: 'r1', kind: 'configuration_entry', name: 'visit alarm', quote: 'threshold: 10' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'alerting') }], subject_status: [], artifact_status: null },
  'brand-01': { referents: [{ ref: 'r1', kind: 'specification', name: 'primary colour', quote: 'Dusk indigo is the primary colour.' },
    { ref: 'r2', kind: 'asset', name: 'lantern emblem', denotes: 'lantern emblem', quote: 'Our lantern emblem ships with every page.' }],
  assertions: [{ ref: 'r1', predicate: 'is_a', concept: acc('brand', 'palette') }, { ref: 'r2', predicate: 'is_a', concept: acc('brand', 'owned-assets') }],
  subject_status: [], artifact_status: null },
  'brand-02': { referents: [{ ref: 'r1', kind: 'rule', name: 'quiet keeper voice', quote: 'Speak like a quiet lighthouse keeper.' }],
    assertions: [{ ref: 'r1', predicate: 'defines', concept: acc('brand', 'quiet-voice') }], subject_status: [], artifact_status: null },
  'brand-03': { referents: [{ ref: 'r1', kind: 'asset', name: 'reference photographs', denotes: 'lantern photographs', quote: 'Third-party lantern photographs' }],
    assertions: [{ ref: 'r1', predicate: 'subject_to', concept: acc('brand', 'reference-only-use') },
      { ref: 'r1', predicate: 'is_a', polarity: 'deny', concept: acc('brand', 'owned-assets'), quote: 'reference only, never shipped' }],
    subject_status: [], artifact_status: null },
  'brand-04': { referents: [{ ref: 'r1', kind: 'asset', name: 'shop photographs', denotes: 'lantern photographs', quote: 'The lantern photographs are ours to ship.' }],
    assertions: [{ ref: 'r1', predicate: 'is_a', concept: acc('brand', 'owned-assets') }], subject_status: [], artifact_status: null },
};
const quietExpansion = { new_schemes: [], new_concepts: [], evidence_additions: [], uncovered: [] };
function fakeModel({ synthesisOverrides = {}, groundingOverrides = {}, pairs = [], anchoredAnswer = anchored, expansion = quietExpansion, identity = [] } = {}) {
  const prompts = [];
  const call = async prompt => {
    prompts.push(prompt);
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    let answer;
    if (packet.schema === 'estate-map/ontology-discovery-packet/v4') {
      answer = packet.prior_vocabulary ? anchoredAnswer : synthesisOverrides[packet.collection_id] ?? synthesis[packet.collection_id];
    } else if (packet.schema === 'estate-map/ontology-expansion-packet/v2') answer = expansion;
    else if (packet.schema === 'estate-map/ontology-subject-grounding-packet/v3') {
      answer = groundingOverrides[packet.artifact.artifact_id] ?? grounding[packet.artifact.artifact_id];
    } else if (packet.schema === 'estate-map/ontology-identity-packet/v1') answer = { decisions: identity };
    else answer = { pairs };
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', actual_reasoning_effort: 'low',
      usage: { cost: { total: 0.001 } }, latency_ms: 5 };
  };
  return { prompts, call };
}
async function discover(repo, { journalPath = null, model = fakeModel(), priorGeneration = null } = {}) {
  return await discoverOntology({ corpus: corpusFor(repo), runtime, repositories: { lantern: repo.dir },
    journalPath, priorGeneration, modelCall: model.call });
}
const journal = () => join(mkdtempSync(join(tmpdir(), 'discovery-journal-')), 'journal.jsonl');
const software = generation => generation.collections.find(c => c.collection_id === 'software');
const brand = generation => generation.collections.find(c => c.collection_id === 'brand');
const rejectedCodes = (generation, artifactId) => generation.rejected.filter(r => r.artifact_id === artifactId).map(r => [r.predicate, r.code]);
async function sourceChange({ model = fakeModel(), edit = { 'ledger/store.mjs': `// Keeper ledger\n${files['ledger/store.mjs']}`,
  'gateway/alarm.mjs': 'export const visitAlarm = {\n  threshold: 10,\n};' }, alarm = true } = {}) {
  const repo = repository(), journalPath = journal();
  const before = await discover(repo, { journalPath });
  write(repo.dir, edit);
  const commit = commitAll(repo.dir, 'Change the ledger');
  const after = await discoverOntology({ corpus: corpusFor({ dir: repo.dir, commit, brandCommit: repo.commit, alarm }),
    runtime, repositories: { lantern: repo.dir }, journalPath, priorGeneration: before.generation, modelCall: model.call });
  return { before: before.generation, after: after.generation, receipt: after.receipt };
}

test('proposed concept evidence is the exact source passage at its line', async () => {
  const { generation } = await discover(repository());
  const support = software(generation).evidence.find(e => e.concept_accession === acc('software', 'admission') && e.role === 'support');
  assert.deepEqual([support.quote, support.start_line, support.locator, support.standing, generation.acceptance.accepted],
    ['return sessions.verify(token);', 3, 'exact', 'source_observed', false]);
});

test('a quote absent from its artifact is rejected rather than stored', async () => {
  const wrong = structuredClone(synthesis.software);
  wrong.concepts[1].support = [{ artifact_id: 'software-02', quote: 'sortKey: "visitorId"' }];
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { software: wrong } }) });
  assert.deepEqual(generation.rejected.filter(r => r.where.startsWith('concept')).map(r => r.code), ['QUOTE_NOT_LOCATED']);
});

test('a quote that occurs more than once is refused as ambiguous', async () => {
  const twice = structuredClone(synthesis.software);
  twice.concepts[0].support = [{ artifact_id: 'software-01', quote: 'sessions' }];
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { software: twice } }) });
  assert.deepEqual(generation.rejected.filter(r => r.where.startsWith('concept')).map(r => r.code), ['QUOTE_AMBIGUOUS']);
});

test('a quote without Markdown marks maps to the exact source text and records how', async () => {
  const { generation } = await discover(repository());
  const decision = generation.referents.find(r => r.occurrence.artifact_id === 'software-04');
  assert.deepEqual([decision.occurrence.quote, decision.occurrence.locator],
    ['D1: Keepers and visitors use **separate** ledgers.', 'whitespace+markup']);
});

test('a quote with a changed initial capital is located only through the recorded case relaxation', async () => {
  const lower = structuredClone(synthesis.brand);
  lower.concepts[1].support = [{ artifact_id: 'brand-02', quote: 'speak like a quiet lighthouse keeper.' }];
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { brand: lower } }) });
  const voice = brand(generation).evidence.find(e => e.concept_accession === acc('brand', 'quiet-voice'));
  assert.deepEqual([voice.quote, voice.locator, voice.model_quote],
    ['Speak like a quiet lighthouse keeper.', 'whitespace+markup+case', 'speak like a quiet lighthouse keeper.']);
});

test('citing a held-out artifact in synthesis is rejected as unsupplied', async () => {
  const peek = structuredClone(synthesis.software);
  peek.concepts[1].support.push({ artifact_id: 'software-03', quote: 'ledger.append' });
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { software: peek } }) });
  assert.deepEqual(generation.rejected.filter(r => r.where.startsWith('concept')).map(r => r.code), ['ARTIFACT_NOT_SUPPLIED']);
});

test('synthesis receives source text but no target vocabulary and no pins', async () => {
  const model = fakeModel(), repo = repository();
  await discover(repo, { model });
  const prompts = model.prompts.filter(p => p.includes('estate-map/ontology-discovery-packet/v4'));
  assert.deepEqual(prompts.map(p => ['Visitor admission', 'Palette colour', repo.commit].some(term => p.includes(term))), [false, false]);
});

test('a concrete decision selects a strategy and an is_a assertion on it is refused, not relabelled', async () => {
  const typed = structuredClone(grounding['software-04']);
  typed.assertions.push({ ref: 'r1', predicate: 'is_a', concept: acc('software', 'separate-ledgers') });
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-04': typed } }) });
  const kept = generation.assertions.filter(a => a.occurrence.artifact_id === 'software-04').map(a => [a.predicate, a.membership]).sort();
  assert.deepEqual([kept, rejectedCodes(generation, 'software-04')], [[['describes', false], ['selects', true]],
    [['implements', 'PREDICATE_NOT_ADMISSIBLE_FOR_CATEGORY'], ['is_a', 'PREDICATE_NOT_ADMISSIBLE_FOR_CATEGORY']]]);
});

test('a responsibility is implemented by code and refuses is_a', async () => {
  const typed = structuredClone(grounding['software-02']);
  typed.assertions.push({ ref: 'r1', predicate: 'is_a', concept: acc('software', 'keeper-records') });
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-02': typed } }) });
  assert.deepEqual(rejectedCodes(generation, 'software-02'), [['is_a', 'PREDICATE_NOT_ADMISSIBLE_FOR_CATEGORY']]);
});

test('a subject kind outside the concept domain cannot instantiate it', async () => {
  const outside = { ...grounding['software-01'], referents: [{ ref: 'r1', kind: 'configuration_entry', name: 'badge header', quote: 'request.headers.badge' }] };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-01': outside } }) });
  assert.deepEqual(rejectedCodes(generation, 'software-01'), [['implements', 'SUBJECT_KIND_OUTSIDE_DOMAIN']]);
});

test('a document cannot implement a practice step', async () => {
  const practice = structuredClone(synthesis.brand);
  practice.concepts.push(concept('voice-review', 'expression', 'practice', 'Voice review', [{ artifact_id: 'brand-02', quote: 'Never shout; never hurry the reader.' }]));
  const claim = { referents: [{ ref: 'r1', kind: 'rule', name: 'never shout', quote: 'Never shout;' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('brand', 'voice-review') }], subject_status: [], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { brand: practice }, groundingOverrides: { 'brand-02': claim } }) });
  assert.deepEqual(rejectedCodes(generation, 'brand-02'), [['implements', 'DOCUMENT_CANNOT_IMPLEMENT']]);
});

test('a theme defined by a source has documentary standing without any instance', async () => {
  const { generation } = await discover(repository());
  const theme = generation.concept_standing.find(s => s.accession === acc('brand', 'quiet-voice')).standing;
  assert.deepEqual([theme.summary, theme.instances], ['documentary_claim', {}]);
});

test('a referenced material is subject to a policy, is not a type of it, and is marked unread', async () => {
  const { generation } = await discover(repository());
  const photo = generation.assertions.find(a => a.concept_accession === acc('brand', 'reference-only-use'));
  const referent = generation.referents.find(r => r.referent_id === photo.referent_id);
  assert.deepEqual([photo.predicate, photo.membership, referent.basis], ['subject_to', true, 'referenced_by_document']);
});

test('a decision in a document is stated there, not a referenced unread thing', async () => {
  const { generation } = await discover(repository());
  assert.equal(generation.referents.find(r => r.occurrence.artifact_id === 'software-04').basis, 'stated_in_document');
});

test('each subject and excerpt carries an explicit coverage status, and silence is visible', async () => {
  const { generation } = await discover(repository());
  const shape = generation.referents.filter(r => r.occurrence.artifact_id === 'software-05').map(r => r.coverage.status).sort();
  const excerpt = software(generation).coverage.artifacts.find(a => a.artifact_id === 'software-05');
  assert.deepEqual([shape, excerpt.synthesis.status, excerpt.grounding.status], [['no_matching_concept', 'unexplained'], 'no_matching_concept', 'no_matching_concept']);
});

test('subjects no concept matches get one expansion call, and a proposed concept re-grounds the collection once', async () => {
  const expansion = { ...quietExpansion, new_concepts: [concept('visit-validation', 'responsibility', 'responsibility', 'Visit payload validation',
    [{ artifact_id: 'software-05', quote: 'export function isWellFormed(visit) {' }])] };
  const { generation, receipt } = await discover(repository(), { model: fakeModel({ expansion }) });
  assert.deepEqual([software(generation).concepts.at(-1).origin, receipt.calls.filter(c => c.stage === 'expansion').length,
    receipt.calls.filter(c => c.stage === 'regrounding').length], ['expansion', 1, 5]);
});

test('an expansion that proposes nothing leaves grounding as it was', async () => {
  const { receipt } = await discover(repository());
  assert.deepEqual([receipt.calls.filter(c => c.stage === 'expansion').length, receipt.calls.filter(c => c.stage === 'regrounding').length], [1, 0]);
});

test('a passage stating a theme describes it and cannot be its instance', async () => {
  const stated = { referents: [{ ref: 'r1', kind: 'passage', name: 'voice line', quote: 'Speak like a quiet lighthouse keeper.' }],
    assertions: [{ ref: 'r1', predicate: 'exemplifies', concept: acc('brand', 'quiet-voice') }], subject_status: [], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-02': stated } }) });
  assert.deepEqual(rejectedCodes(generation, 'brand-02'), [['exemplifies', 'PASSAGE_IS_NOT_AN_INSTANCE']]);
});

test('opposite claims about one subject from different passages block acceptance', async () => {
  const both = structuredClone(grounding['brand-03']);
  both.assertions.push({ ref: 'r1', predicate: 'is_a', concept: acc('brand', 'owned-assets'), quote: 'Third-party lantern photographs' });
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-03': both } }) });
  assert.deepEqual(generation.acceptance_blockers.map(b => [b.kind, b.identity]).sort(),
    [['possible_subject_conflict', 'name_resolved_unconfirmed'], ['subject_conflict', 'same_referent']]);
});

test('opposite claims in two files about a name-resolved subject are a possible conflict, not dismissed', async () => {
  const { generation } = await discover(repository());
  assert.deepEqual(generation.acceptance_blockers.map(b => [b.kind, b.affirm_path, b.deny_path]),
    [['possible_subject_conflict', 'notes/rights.md', 'notes/inspiration.md']]);
});

test('one quote supporting two compatible predicates is not a conflict', async () => {
  const dual = structuredClone(grounding['brand-01']);
  dual.assertions.push({ ref: 'r1', predicate: 'defines', concept: acc('brand', 'palette') });
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-01': dual } }) });
  assert.equal(generation.acceptance_blockers.filter(b => b.concept_accession === acc('brand', 'palette')).length, 0);
});

test('a member quote overlapping a counterexample citation is a review finding, not a blocker', async () => {
  const same = structuredClone(grounding['software-02']);
  same.assertions.push({ ref: 'r1', predicate: 'implements', concept: acc('software', 'admission'), quote: 'partitionKey: "lanternId"' });
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-02': same } }) });
  assert.deepEqual([generation.findings.filter(f => f.kind === 'citation_overlap_member_counterexample').length,
    generation.acceptance_blockers.filter(b => b.concept_accession === acc('software', 'admission')).length], [1, 0]);
});

test('a source change keeps unchanged concept versions and re-locates their evidence', async () => {
  const { before, after } = await sourceChange();
  const pick = g => software(g).evidence.find(e => e.concept_accession === acc('software', 'keeper-records'));
  const version = g => software(g).concepts.find(c => c.accession === acc('software', 'keeper-records')).version_id;
  assert.deepEqual([pick(after).evidence_id, pick(after).start_line, version(after)],
    [pick(before).evidence_id, pick(before).start_line + 1, version(before)]);
});

test('a moved subject keeps its assertion identity with an updated occurrence', async () => {
  const { before, after } = await sourceChange();
  const table = g => g.assertions.find(a => a.occurrence.path === 'ledger/store.mjs');
  assert.deepEqual([table(after).assertion_id, table(after).occurrence.start_line], [table(before).assertion_id, 2]);
});

test('two subjects with the same name but different source text stay distinct', async () => {
  const twins = { referents: [{ ref: 'r1', kind: 'code_construct', name: 'ledger', quote: 'partitionKey: "lanternId"' },
    { ref: 'r2', kind: 'code_construct', name: 'ledger', quote: 'sortKey: "keeperId"' }],
  assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') },
    { ref: 'r2', predicate: 'implements', concept: acc('software', 'keeper-records') }], subject_status: [], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-02': twins } }) });
  assert.equal(new Set(generation.referents.filter(r => r.occurrence.artifact_id === 'software-02').map(r => r.referent_id)).size, 2);
});

test('identical text in two excerpts of one file is two subjects', async () => {
  const repo = repository();
  const span = (id, start, end) => { const full = artifact(repo.dir, repo.commit, id, 'ledger/tables.mjs', 'code');
    const text = full.text.split('\n').slice(start - 1, end).join('\n');
    return { ...full, start_line: start, end_line: end, text, content_sha256: hash(text) }; };
  const corpus = corpusFor(repo);
  corpus.collections[0].artifacts.push(span('software-07', 1, 3), span('software-08', 4, 6));
  const mode = { referents: [{ ref: 'r1', kind: 'configuration_entry', name: 'mode', quote: 'mode: "on-demand",' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') }], subject_status: [], artifact_status: null };
  const model = fakeModel({ groundingOverrides: { 'software-07': mode, 'software-08': mode } });
  const { generation } = await discoverOntology({ corpus: sealDiscoveryCorpus(corpus), runtime, repositories: { lantern: repo.dir }, modelCall: model.call });
  const modes = generation.referents.filter(r => r.occurrence.path === 'ledger/tables.mjs');
  assert.deepEqual([new Set(modes.map(r => r.referent_id)).size, modes.map(r => r.occurrence.file_ordinal).sort()], [2, [0, 1]]);
});

test('a deleted supporting passage leaves the concept but carries no evidence or assertion from it', async () => {
  const quiet = { ...anchored, new_concepts: [], changes: [] };
  const replaced = { referents: [{ ref: 'r1', kind: 'code_construct', name: 'lantern index', quote: 'export const lanternIndex = [];' }],
    assertions: [], subject_status: [{ ref: 'r1', status: 'no_matching_concept', reason: 'An index, not records.' }], artifact_status: null };
  const { after } = await sourceChange({ alarm: false, edit: { 'ledger/store.mjs': 'export const lanternIndex = [];' },
    model: fakeModel({ anchoredAnswer: quiet, groundingOverrides: { 'software-02': replaced } }) });
  const keeper = acc('software', 'keeper-records');
  assert.deepEqual([
    software(after).concepts.some(c => c.accession === keeper),
    software(after).evidence.filter(e => e.concept_accession === keeper && e.path === 'ledger/store.mjs').length,
    after.assertions.filter(a => a.concept_accession === keeper && a.occurrence.path === 'ledger/store.mjs').length,
    after.findings.filter(f => f.kind === 'stale_evidence' && f.concept_accession === keeper).length], [true, 0, 0, 1]);
});

test('the view model reports currentness: a definition outlives support that disappeared, and the revision lists it', async () => {
  const quiet = { ...anchored, new_concepts: [], changes: [] };
  const replaced = { referents: [{ ref: 'r1', kind: 'code_construct', name: 'lantern index', quote: 'export const lanternIndex = [];' }],
    assertions: [], subject_status: [{ ref: 'r1', status: 'no_matching_concept', reason: 'An index, not records.' }], artifact_status: null };
  const { before, after } = await sourceChange({ alarm: false, edit: { 'ledger/store.mjs': 'export const lanternIndex = [];' },
    model: fakeModel({ anchoredAnswer: quiet, groundingOverrides: { 'software-02': replaced } }) });
  const concept = view => view.collections[0].schemes.flatMap(x => x.concepts).find(x => x.accession === acc('software', 'keeper-records'));
  const was = discoveryViewModel(before), now = discoveryViewModel(after);
  assert.deepEqual([concept(was).currentness.state, concept(now).currentness.state, concept(now).currentness.support_stale,
    now.revision.stale_evidence.length, now.revision.prior_generation_id === before.generation_id, now.revision.collections[0].mode],
  ['supported', 'support_stale', 1, 2, true, 'anchored']);
});

test('a proposed drop stays pending while the concept remains in the working vocabulary', async () => {
  const { after } = await sourceChange();
  const kept = software(after).concepts.find(c => c.accession === acc('software', 'separate-ledgers'));
  assert.deepEqual([kept.origin, software(after).changes.map(c => [c.op, c.status])], ['carried', [['drop', 'needs_human_decision']]]);
});

test('new source adds an incremental concept beside every retained one', async () => {
  const { before, after } = await sourceChange();
  assert.deepEqual(software(after).concepts.map(c => [c.accession.split('/').at(-1), c.origin]),
    [...software(before).concepts.map(c => [c.accession.split('/').at(-1), 'carried']), ['alerting', 'added']]);
});

test('an unchanged collection is carried with its subjects and no model call', async () => {
  const { before, after, receipt } = await sourceChange();
  const ids = g => g.assertions.filter(a => a.concept_accession.startsWith('ontology-concept:brand/')).map(a => a.assertion_id);
  assert.deepEqual([brand(after).mode, ids(after), receipt.calls.filter(c => c.label.startsWith('brand')).length], ['carried', ids(before), 0]);
});

test('carried evidence keeps its identity when the anchored answer re-cites a longer passage', async () => {
  const recite = { ...anchored, evidence_additions: [{ accession: acc('software', 'keeper-records'), role: 'support',
    artifact_id: 'software-02', quote: 'sortKey: "keeperId",\n};' }] };
  const { before, after } = await sourceChange({ model: fakeModel({ anchoredAnswer: recite }) });
  const ids = g => software(g).evidence.filter(e => e.concept_accession === acc('software', 'keeper-records')).map(e => e.evidence_id);
  assert.deepEqual(ids(after), ids(before));
});

test('neighbor review keeps only redundancy, contradiction or identity uncertainty', async () => {
  const pairs = [{ a: acc('software', 'admission'), b: acc('software', 'separate-ledgers'), relation: 'overlap', reason: 'co-members' },
    { a: acc('brand', 'palette'), b: acc('brand', 'quiet-voice'), relation: 'redundant', reason: 'invented' }];
  const { generation } = await discover(repository(), { model: fakeModel({ pairs }) });
  assert.deepEqual(generation.neighbor_review.map(p => [p.relation, p.status]), [['redundant', 'needs_human_decision']]);
});

test('a completed journal replays the same generation without a new model call', async () => {
  const repo = repository(), journalPath = journal();
  const first = await discover(repo, { journalPath });
  const second = await discover(repo, { journalPath, model: fakeModel({ synthesisOverrides: { software: { invalid: true } } }) });
  assert.deepEqual([second.generation.generation_id, second.receipt.new_model_calls], [first.generation.generation_id, 0]);
});

test('a prepared attempt without an outcome halts every later run', async () => {
  const repo = repository(), journalPath = journal();
  await discover(repo, { journalPath });
  const fresh = journal();
  appendFileSync(fresh, `${readFileSync(journalPath, 'utf8').split('\n')[0]}\n`);
  await assert.rejects(discover(repo, { journalPath: fresh }), error => error.code === 'DISCOVERY_ACCEPTED_UNKNOWN');
});

test('a person-resolved unknown outcome keeps its prepared line, stays unknown-cost, and allows one disclosed repurchase', async () => {
  const repo = repository(), journalPath = journal();
  await discover(repo, { journalPath });
  const fresh = journal();
  const first = JSON.parse(readFileSync(journalPath, 'utf8').split('\n')[0]);
  appendFileSync(fresh, `${JSON.stringify(first)}\n`);
  assert.throws(() => resolveUnknownAttempt(fresh, first.request_digest, { decidedBy: '', reason: 'x' }), error => error.code === 'DISCOVERY_RESOLUTION_INVALID');
  resolveUnknownAttempt(fresh, first.request_digest, { decidedBy: 'operator', reason: 'client timeout, outcome unknown' });
  const { receipt } = await discover(repo, { journalPath: fresh });
  const events = readFileSync(fresh, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.request_digest === first.request_digest);
  assert.deepEqual([events.map(e => e.state), receipt.unknown_outcome_attempts_in_journal], [['prepared', 'proceed_despite_unknown', 'prepared', 'completed'], 1]);
  assert.deepEqual([events[1].outcome, events[1].cost_usd, events[2].replaces_unknown_attempt], ['unknown', null, 1]);
});

test('a killed call still leaves the provider events it had sent, in a private file written as they arrive', async () => {
  const { EventEmitter } = await import('node:events');
  const { statSync } = await import('node:fs');
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4242;
  child.stdin = { end() {} };
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  const path = join(mkdtempSync(join(tmpdir(), 'capture-')), 'nested', 'call.jsonl');
  const pending = callDiscoveryLlm('invented prompt', { name: 'vendor/tiny', timeout_ms: 20 }, { spawnPi: () => child, capture: { path, meta: { attempt: 3 } } });
  child.stdout.emit('data', '{"type":"message_start"}\n');
  await assert.rejects(pending, error => error.code === 'DISCOVERY_MODEL_UNAVAILABLE');
  const events = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([events.map(e => e.event), events[0].attempt, events.find(e => e.event === 'child').pid, events.find(e => e.event === 'stdout').chunk.trim(),
    (statSync(path).mode & 0o777).toString(8)], [['spawn', 'child', 'stdout', 'client_timeout_kill', 'close'], 3, 4242, '{"type":"message_start"}', '600']);
});

test('an answered but unreadable call is a recorded failed attempt retried up to the bound', async () => {
  const repo = repository(), journalPath = journal();
  const unreadable = async (prompt, model) => { throw Object.assign(new Error('unreadable'), { code: 'DISCOVERY_ANSWER_INVALID',
    answered: { model: model.name, usage: null, raw_text: 'not json' } }); };
  const run = () => discoverOntology({ corpus: corpusFor(repo), runtime, repositories: { lantern: repo.dir }, journalPath, modelCall: unreadable });
  for (let i = 0; i < 3; i += 1) await assert.rejects(run(), error => error.code === 'DISCOVERY_ANSWER_INVALID');
  await assert.rejects(run(), error => error.code === 'DISCOVERY_RETRY_EXHAUSTED');
});

test('an answer keeps punctuation debris out but refuses a second payload after its JSON value', () => {
  assert.deepEqual([parseAnswer('{"a":[{"q":"x {"}]}"}').value, (() => { try { parseAnswer('{"a":1}\n{"a":2}'); return 'read'; } catch { return 'refused'; } })()],
    [{ a: [{ q: 'x {' }] }, 'refused']);
});

test('an object closed early and continued with a member is re-joined, never truncated', () => {
  assert.deepEqual(parseAnswer('{"a":[1],"b":[]},"c":null}'), { value: { a: [1], b: [], c: null }, discarded: '', repair: 'premature_root_close' });
});

test('a stored unreadable answer is re-read by a later parser without a new purchase', async () => {
  const repo = repository(), journalPath = journal();
  const model = fakeModel();
  let broken = true;
  const call = async (prompt, m, options) => {
    const reply = await model.call(prompt, m, options);
    if (broken && prompt.includes('estate-map/ontology-discovery-packet/v4')) {
      broken = false;
      throw Object.assign(new Error('unreadable'), { code: 'DISCOVERY_ANSWER_INVALID', answered: { model: m.name, usage: null, raw_text: JSON.stringify(reply.answer) } });
    }
    return reply;
  };
  await assert.rejects(discoverOntology({ corpus: corpusFor(repo), runtime, repositories: { lantern: repo.dir }, journalPath, modelCall: call }));
  const { receipt } = await discoverOntology({ corpus: corpusFor(repo), runtime, repositories: { lantern: repo.dir }, journalPath, modelCall: call });
  const events = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([events.filter(e => e.state === 'recovered').length, receipt.calls.filter(c => c.stage === 'synthesis').length], [1, 1]);
});

test('corpus validation rejects an excerpt that differs from its pinned blob', () => {
  const repo = repository(), corpus = corpusFor(repo);
  corpus.collections[0].artifacts[0].text = 'export const admit = () => true;';
  corpus.collections[0].artifacts[0].content_sha256 = hash(corpus.collections[0].artifacts[0].text);
  assert.throws(() => validateDiscoveryCorpus(sealDiscoveryCorpus(corpus), { repositories: { lantern: repo.dir } }),
    error => error.code === 'DISCOVERY_SOURCE_NOT_AT_PIN');
});

test('a collection-namespaced key is trimmed but a key sharing the collection word is kept', async () => {
  const keys = structuredClone(synthesis.brand);
  keys.concepts[0].stable_key = 'brand/palette';
  keys.concepts[1].stable_key = 'brand-voice';
  const { generation } = await discover(repository(), { model: fakeModel({ synthesisOverrides: { brand: keys } }) });
  assert.deepEqual(brand(generation).concepts.slice(0, 2).map(c => c.accession), [acc('brand', 'palette'), acc('brand', 'brand-voice')]);
});

test('the renderer contract carries generated vocabulary with each concept category', async () => {
  const { generation } = await discover(repository());
  const view = discoveryViewModel(generation);
  assert.deepEqual(view.collections.flatMap(c => c.schemes.flatMap(s => s.concepts.map(x => [x.label, x.semantic_category]))), [
    ['Visitor admission', 'responsibility'], ['Keeper records', 'responsibility'], ['Separate ledgers', 'strategy'],
    ['Palette colour', 'type'], ['Quiet voice', 'theme'], ['Owned asset', 'type'], ['Reference-only use', 'policy']]);
});

test('binary assets are inventoried as unsupported rather than interpreted', async () => {
  const { generation } = await discover(repository());
  assert.deepEqual(discoveryViewModel(generation).unsupported.map(u => [u.path, u.state]), [['notes/emblem.png', 'inventoried_not_interpreted']]);
});

test('the candidate view serves the derived view model and refuses writes', async () => {
  const { generation } = await discover(repository());
  const { server, url } = await startCandidateView({ generation, port: 0 });
  try {
    const model = await (await fetch(`${url}api/view-model`)).json();
    const write = await fetch(`${url}api/view-model`, { method: 'POST', body: '{}' });
    assert.deepEqual([model.generation_id, write.status], [generation.generation_id, 405]);
  } finally { server.close(); }
});

test('the candidate page allows only its own script and style', async () => {
  const { generation } = await discover(repository());
  const { server, url } = await startCandidateView({ generation, port: 0 });
  try {
    const policy = (await fetch(url)).headers.get('content-security-policy');
    assert.deepEqual([policy.includes("script-src 'self'"), policy.includes('unsafe-inline')], [true, false]);
  } finally { server.close(); }
});

test('a polarity instruction judges the whole assertion and never maps negation words to deny', () => {
  const prompt = groundingPrompt({});
  assert.deepEqual([prompt.includes('WHOLE assertion'), prompt.includes('"not ours"'), prompt.includes('do not decide it')], [true, false, true]);
});

test('comment lines are recognised per language and a block comment spans its lines', () => {
  assert.deepEqual(commentLineFlags('a/build.gradle', '// one\ncode()\n/* two\n three */\ncode() // trailing'), [true, false, true, true, false]);
  assert.deepEqual(commentLineFlags('a/job.yml', '# note\nkey: 1'), [true, false]);
  assert.deepEqual(commentLineFlags('a/notes.md', '# Heading'), [false]);
});

async function afterCommentEdit(override) {
  const edit = { 'ledger/store.mjs': `// Keepers must be listed here\n${files['ledger/store.mjs']}` };
  const model = fakeModel({ groundingOverrides: { 'software-02': override } });
  const { after } = await sourceChange({ model, edit, alarm: false });
  return { after };
}

test('a comment is observed text whose claim stands as a comment claim and cannot implement', async () => {
  const claim = { referents: [{ ref: 'r1', kind: 'passage', name: 'listing comment', quote: '// Keepers must be listed here' },
    { ref: 'r2', kind: 'configuration_entry', name: 'lantern table', quote: 'export const lanternTable = {' }],
  assertions: [{ ref: 'r1', predicate: 'describes', concept: acc('software', 'keeper-records') },
    { ref: 'r2', predicate: 'implements', concept: acc('software', 'keeper-records'), quote: '// Keepers must be listed here' }],
  subject_status: [], artifact_status: null };
  const { after } = await afterCommentEdit(claim);
  const described = after.assertions.find(a => a.predicate === 'describes' && a.occurrence.artifact_id === 'software-02');
  const standing = after.concept_standing.find(s => s.accession === acc('software', 'keeper-records')).standing;
  assert.deepEqual([described.occurrence.standing, described.occurrence.span_class, rejectedCodes(after, 'software-02'), standing.summary],
    ['comment_claim', 'comment', [['implements', 'COMMENT_CANNOT_IMPLEMENT']], 'mixed']);
});

test('an answer that relates a subject and also gives it a no-match status is refused, not relabelled', async () => {
  const both = { referents: [{ ref: 'r1', kind: 'code_construct', name: 'lantern table', quote: 'export const lanternTable = {' }],
    assertions: [{ ref: 'r1', predicate: 'implements', concept: acc('software', 'keeper-records') }],
    subject_status: [{ ref: 'r1', status: 'no_matching_concept', reason: 'Not a keeper record.' }], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-02': both } }) });
  const referent = generation.referents.find(r => r.occurrence.artifact_id === 'software-02');
  assert.deepEqual([rejectedCodes(generation, 'software-02'), referent.coverage.status,
    generation.assertions.some(a => a.occurrence.artifact_id === 'software-02')],
  [[['implements', 'SUBJECT_STATUS_CONTRADICTS_ASSERTION']], 'contradictory_answer', false]);
});

test('one subject cannot both define a concept and be an instance of it', async () => {
  const both = { referents: [{ ref: 'r1', kind: 'asset', name: 'reference photographs', quote: 'Third-party lantern photographs' }],
    assertions: [{ ref: 'r1', predicate: 'defines', concept: acc('brand', 'reference-only-use') },
      { ref: 'r1', predicate: 'subject_to', concept: acc('brand', 'reference-only-use') }], subject_status: [], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-03': both } }) });
  assert.deepEqual([rejectedCodes(generation, 'brand-03').map(r => r[1]), generation.assertions.some(a => a.occurrence.artifact_id === 'brand-03')],
    [['ROLE_CONFLICT_DEFINES_AND_INSTANCE', 'ROLE_CONFLICT_DEFINES_AND_INSTANCE'], false]);
});

test('an identifier shared by two artifacts supplies the other artifact\'s lines as context', () => {
  const a = { artifact_id: 'a-1', kind: 'code', path: 'x/phase.cfg', text: 'phase = [ 0123456789ABCDEF0123 /* Copy */ ];', start_line: 1 };
  const b = { artifact_id: 'a-2', kind: 'code', path: 'x/object.cfg', text: 'head\n0123456789ABCDEF0123 = { script = "copy keys.plist"; };\ntail', start_line: 1 };
  const c = { artifact_id: 'a-3', kind: 'code', path: 'x/other.cfg', text: 'unrelated', start_line: 1 };
  const [link] = linkedContext(a, { artifacts: [a, b, c], held_out_artifact_ids: ['a-3'] });
  assert.deepEqual([link.artifact_id, link.shared_identifiers, link.passage.includes('copy keys.plist'), link.truncated],
    ['a-2', ['0123456789ABCDEF0123'], true, false]);
});

test('an unchanged collection carries its prior grounding rejections', async () => {
  const repo = repository(), journalPath = journal();
  const before = await discover(repo, { journalPath });
  const again = await discover(repo, { journalPath, priorGeneration: before.generation });
  assert.deepEqual([software(again.generation).mode, again.generation.rejected.length, again.generation.rejected.every(r => r.carried)],
    ['carried', before.generation.rejected.length, true]);
});

test('an anchored update re-examines previously unresolved artifacts, not only changed ones', async () => {
  const model = fakeModel();
  await sourceChange({ model });
  const expansions = model.prompts.filter(p => p.includes('estate-map/ontology-expansion-packet/v2')).map(p => JSON.parse(p.split('\n\n').at(-1)));
  const anchoredPacket = model.prompts.map(p => JSON.parse(p.split('\n\n').at(-1))).find(p => p.prior_vocabulary);
  assert.deepEqual([anchoredPacket.changed_artifact_ids, anchoredPacket.unresolved_artifact_ids, expansions.at(-1).artifacts.map(a => a.artifact_id)],
    [['software-02', 'software-06'], ['software-05'], ['software-05']]);
});

test('one expansion call may propose up to eight concepts without the anchored-update bound refusing it', async () => {
  const many = ['one', 'two', 'three', 'four', 'five'].map(n => concept(`probe-${n}`, 'responsibility', 'responsibility', `Probe ${n}`,
    [{ artifact_id: 'software-05', quote: n === 'one' ? 'export function isWellFormed(visit) {' : 'visit.keeper.length > 0' }]));
  const { generation } = await discover(repository(), { model: fakeModel({ expansion: { ...quietExpansion, new_concepts: many } }) });
  assert.equal(software(generation).concepts.filter(c => c.origin === 'expansion').length, 5);
});

test('expansion may add a singleton concept, and a renamed duplicate is refused with its target', async () => {
  const expansion = { ...quietExpansion, new_concepts: [
    concept('visit-validation', 'responsibility', 'responsibility', 'Visit payload validation', [{ artifact_id: 'software-05', quote: 'export function isWellFormed(visit) {' }]),
    concept('admission-again', 'responsibility', 'responsibility', 'Visitor admission', [{ artifact_id: 'software-05', quote: 'visit.keeper.length > 0' }])] };
  const { generation } = await discover(repository(), { model: fakeModel({ expansion }) });
  assert.deepEqual([software(generation).concepts.filter(c => c.origin === 'expansion').map(c => c.label),
    generation.rejected.filter(r => r.code === 'DUPLICATE_OF_EXISTING_CONCEPT').map(r => r.existing_accession)],
  [['Visit payload validation'], [acc('software', 'admission')]]);
});

test('not being an instance does not discard a valid defines, but contradicts an instance assertion', async () => {
  const defining = { referents: [{ ref: 'r1', kind: 'rule', name: 'quiet keeper voice', quote: 'Speak like a quiet lighthouse keeper.' }],
    assertions: [{ ref: 'r1', predicate: 'defines', concept: acc('brand', 'quiet-voice') }],
    subject_status: [], instance_status: [{ ref: 'r1', instance: 'not_an_instance', reason: 'States the theme; it is not an asset showing it.' }], artifact_status: null };
  const both = { ...defining, assertions: [...defining.assertions, { ref: 'r1', predicate: 'exemplifies', concept: acc('brand', 'quiet-voice') }] };
  const kept = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-02': defining } }) });
  const refused = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-02': both } }) });
  const subject = kept.generation.referents.find(r => r.occurrence.artifact_id === 'brand-02');
  assert.deepEqual([kept.generation.assertions.filter(a => a.occurrence.artifact_id === 'brand-02').map(a => a.predicate), subject.instance_status.instance,
    subject.coverage.status, kept.generation.counts.contradiction_refusals, rejectedCodes(refused.generation, 'brand-02')],
  [['defines'], 'not_an_instance', 'related', 0, [['exemplifies', 'INSTANCE_STATUS_CONTRADICTS_ASSERTION']]]);
});

test('a positive defines with a status saying the subject is unrelated stays a refused contradiction', async () => {
  const unrelated = { referents: [{ ref: 'r1', kind: 'rule', name: 'quiet keeper voice', quote: 'Speak like a quiet lighthouse keeper.' }],
    assertions: [{ ref: 'r1', predicate: 'defines', concept: acc('brand', 'quiet-voice') }],
    subject_status: [{ ref: 'r1', status: 'no_matching_concept', reason: 'Not related to the voice theme.' }], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'brand-02': unrelated } }) });
  assert.deepEqual([rejectedCodes(generation, 'brand-02'), generation.assertions.some(a => a.occurrence.artifact_id === 'brand-02')],
    [[['defines', 'SUBJECT_STATUS_CONTRADICTS_ASSERTION']], false]);
});

test('a renamed re-discovery becomes a candidate beside its target, with evidence kept and nothing merged', async () => {
  const identity = [{ candidate: acc('software', 'alerting'), existing: acc('software', 'keeper-records'), kind: 'refinement', reason: 'Same record-keeping meaning.' }];
  const { before, after, receipt } = await sourceChange({ model: fakeModel({ identity }) });
  const c = software(after);
  const candidate = c.candidates[0];
  assert.deepEqual([c.concepts.some(x => x.accession === acc('software', 'alerting')), c.concepts.length, c.candidates.length,
    candidate.relation_to_existing.existing_accession, candidate.relation_to_existing.kind, candidate.definition.length > 0,
    candidate.evidence.map(e => [e.quote, e.new_to_existing]), after.counts.identity_candidates, receipt.calls.some(x => x.stage === 'identity_check'),
    discoveryViewModel(after).decisions_needed.some(d => d.decision_kind === 'resolve_same_concept_or_refinement'),
    software(before).concepts.length],
  [false, software(before).concepts.length, 1, acc('software', 'keeper-records'), 'refinement', true, [['threshold: 10', true]], 1, true, true, 3]);
});

test('a distinct judgement keeps the new concept active and provisional', async () => {
  const identity = [{ candidate: acc('software', 'alerting'), kind: 'distinct', reason: 'Different meaning.' }];
  const { after } = await sourceChange({ model: fakeModel({ identity }) });
  assert.deepEqual([software(after).concepts.some(x => x.accession === acc('software', 'alerting')), software(after).candidates.length], [true, 0]);
});

test('the receipt says which collections carried rejections and which re-judged theirs', async () => {
  const { receipt } = await sourceChange();
  assert.deepEqual([receipt.rejections.carried_collections, receipt.rejections.regenerated_collections.map(c => [c.collection_id, c.mode]),
    receipt.rejections.note.includes('regenerated')], [['brand'], [['software', 'anchored']], true]);
});

test('an unlisted language is unclassified rather than assumed free of comments, and repeats record their lines', () => {
  const artifact = { artifact_id: 'z-1', kind: 'code', path: 'x/engine.zzz', text: 'abc\n// c\nabc', start_line: 10 };
  assert.deepEqual([spanClassOf(artifact, 0, 3), locate(artifact, 'abc').occurrence_lines],
    ['unclassified', [10, 12]]);
});

test('a linked identifier that heads a block brings the whole block, not one neighbouring line', () => {
  const a = { artifact_id: 'a-1', kind: 'code', path: 'x/list.cfg', text: 'phases = ( 0123456789ABCDEF0123 );', start_line: 1 };
  const b = { artifact_id: 'a-2', kind: 'code', path: 'x/objects.cfg', start_line: 1,
    text: ['0123456789ABCDEF0123 = {', '  name = "Copy";', '  files = (', '  );', '  script = "cp in out";', '};', 'other = 1;'].join('\n') };
  const [link] = linkedContext(a, { artifacts: [a, b], held_out_artifact_ids: [] });
  assert.deepEqual([link.passage.includes('script = "cp in out"'), link.passage.includes('other = 1;')], [true, true]);
});

test('surplus beyond a declared bound is recorded with its content, and the prompt states the same bounds', async () => {
  const many = Array.from({ length: 10 }, (_, i) => concept(`probe-${i}`, 'responsibility', 'responsibility', `Probe ${i}`,
    [{ artifact_id: 'software-05', quote: 'visit.keeper.length > 0' }]));
  const model = fakeModel({ expansion: { ...quietExpansion, new_concepts: many } });
  const { generation } = await discover(repository(), { model });
  const over = generation.rejected.filter(r => r.code === 'OVER_DECLARED_BOUND' && r.where === 'new_concept');
  const expansionPrompt = model.prompts.find(p => p.includes('estate-map/ontology-expansion-packet/v2'));
  assert.deepEqual([software(generation).concepts.filter(c => c.origin === 'expansion').length, over.map(r => r.label), over[0].definition.length > 0,
    expansionPrompt.includes(`At most ${DECLARED_BOUNDS.additions.concepts} new concepts`), generation.model_config.declared_bounds.additions.concepts],
  [8, ['Probe 8', 'Probe 9'], true, true, 8]);
});

test('a grounding answer past the declared bound is truncated visibly, not refused or silently cut', async () => {
  const referents = Array.from({ length: 12 }, (_, i) => ({ ref: `r${i}`, kind: 'code_construct', name: `piece ${i}`, quote: 'export function admit(request, sessions) {' }));
  const wide = { referents, assertions: [{ ref: 'r0', predicate: 'implements', concept: acc('software', 'admission') }], subject_status: [], artifact_status: null };
  const { generation } = await discover(repository(), { model: fakeModel({ groundingOverrides: { 'software-01': wide } }) });
  const note = generation.rejected.find(r => r.where === 'answer' && r.artifact_id === 'software-01');
  assert.deepEqual([note.code, note.dropped_referents, note.dropped_assertions], ['OVER_DECLARED_BOUND', 2, 0]);
});

test('a trailing bare model control token is discarded and recorded, but words after the answer still refuse it', () => {
  const stray = parseAnswer('{"links":[]}</|fim_suffix|>');
  assert.deepEqual([stray.value, stray.discarded, (() => { try { parseAnswer('{"links":[]} and then some words'); return 'read'; } catch { return 'refused'; } })()],
    [{ links: [] }, '</|fim_suffix|>', 'refused']);
});
