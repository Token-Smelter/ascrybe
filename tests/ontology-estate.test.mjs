import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chunkText, dispositionOf, inventorySource, summarizeInventory, unitsForSource, UNIT_MAX_BYTES } from '../tools/ontology/estate-inventory.mjs';
import { batchUnits, runEstateDiscovery, screenUnit } from '../tools/ontology/estate-discovery.mjs';
import { discoveryViewModel } from '../tools/ontology/discovery.mjs';
import { evidenceGraph } from '../tools/ontology/evidence-graph.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const runtime = { models: { code_claims: { name: 'example-provider/example-model', thinking: 'off' } }, ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100_000 } };

test('units partition a file: every line is in exactly one unit, in order, and none exceeds the bound', () => {
  const body = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? `## Section ${i}` : i % 9 === 0 ? '' : `line ${i} of the invented note with some words`)).join('\n');
  const units = chunkText(body);
  assert.deepEqual([units.map(u => u.text).join('\n'), units.every(u => Buffer.byteLength(u.text) <= UNIT_MAX_BYTES + 120), units[0].start_line, units.at(-1).end_line,
    units.every((u, i) => i === 0 || u.start_line === units[i - 1].end_line + 1)], [body, true, 1, 400, true]);
});

test('every path gets one deterministic disposition with its rule, and none names a domain', () => {
  const d = (path, extra = {}) => { const r = dispositionOf({ path, size: 1000, mode: '100644', type: 'blob', policy: 'interpret', ...extra }); return `${r.disposition}:${r.rule}`; };
  assert.deepEqual([d('src/app.ts'), d('docs/guide.md'), d('node_modules/x/index.js'), d('config/.env'), d('assets/logo.png'), d('papers/plan.pdf'), d('archive/old/notes.md'), d('a/b.json', { size: 500_000 }),
    d('a/c.md', { size: 600_000 }), d('x/y.ts', { subtree: 2000 }), d('files/z.csv', { size: 100_000 }), d('x.lock'), d('app/package-lock.json'), d('legal/a.md', { policy: 'inventory_only' }), d('sub', { mode: '160000', type: 'commit' }), d('run.log')],
  ['supported:supported_text', 'supported:supported_text', 'excluded:dependency_or_build_directory', 'withheld:credential_like_name', 'not_read:unsupported_binary_or_media', 'not_read:unsupported_document_format',
    'not_read:archived_snapshot_directory', 'not_read:data_file_over_read_limit', 'not_read:file_over_read_limit', 'not_read:homogeneous_bulk_subtree', 'not_read:data_file_over_read_limit', 'not_read:unknown_format',
    'excluded:generated_lock_or_minified', 'withheld:sensitive_domain_inventory_only', 'not_read:non_regular_entry', 'not_read:log_or_record_stream']);
});

test('outbound screening withholds credential, card, IBAN and identifier shapes and passes ordinary text', () => {
  assert.deepEqual([screenUnit('Note that api_key = "abcdef1234567890abcdef12" is configured'), screenUnit('card 4111 1111 1111 1111 expires'), screenUnit('pay to GB82WEST12345698765432 today'), screenUnit('id 123-45-6789'),
    screenUnit('The order total is 4111 units over 12 days.')], ['credential_shaped_text', 'payment_card_number', 'bank_account_iban', 'national_identifier_shape', null]);
});

// An invented estate of two sources: one with documents and code, one inventory-only.
function estate() {
  const dir = mkdtempSync(join(tmpdir(), 'estate-'));
  git(dir, 'init', '-q');
  const files = {
    'docs/decisions.md': '# Decisions\n\nD1: keepers and visitors use separate ledgers.\n\n## Admission\n\nVisitors are admitted by badge only.\n',
    'src/admit.mjs': 'export function admit(request, sessions) {\n  return sessions.verify(request.headers.badge);\n}\n',
    'src/ledger.mjs': 'export const keeperTable = {\n  partitionKey: "lanternId",\n};\n',
    'archive/old/notes.md': '# Old\n\nstale text\n',
    'secrets/.env': 'TOKEN=abc\n',
    'notes/leak.md': '# Leak\n\nthe shared account is DE89370400440532013000 for refunds\n',
  };
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), body); }
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-qm', 'create']);
  const ref = git(dir, 'rev-parse', 'HEAD');
  const manifest = { schema: 'estate-map/ontology-estate-manifest/v1', sources: [{ id: 'lantern', root: dir, ref, policy: 'interpret', role: 'software' }, { id: 'vault', root: dir, ref, policy: 'inventory_only', role: 'legal' }] };
  const entries = manifest.sources.flatMap(s => inventorySource(s));
  const units = unitsForSource(manifest.sources[0], entries.filter(e => e.source_id === 'lantern')).units;
  return { dir, manifest, entries, units };
}

const concept = (key, scheme, category, label, definition, support, domain = []) => ({ stable_key: key, scheme_key: scheme, semantic_category: category, label, definition, inclusion: `Source showing ${label}.`, exclusion: 'Mentions only.',
  domain, invariants: [], instance_conditions: [], aliases: [], support, counterexamples: [] });
function fakeModel({ failMap = false, identity = [] } = {}) {
  const seen = [];
  const call = async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    seen.push(packet);
    let answer;
    if (packet.schema === 'estate-map/ontology-discovery-packet/v4') {
      const ids = packet.artifacts.map(a => a.artifact_id), byPath = p => packet.artifacts.find(a => a.path === p);
      if (failMap) throw Object.assign(new Error('timeout'), { code: 'DISCOVERY_MODEL_UNAVAILABLE' });
      const docs = byPath('docs/decisions.md'), code = byPath('src/admit.mjs');
      answer = { schemes: [{ key: 'behaviour', label: 'Behaviour', definition: 'What the system does or decides.' }], relations: [], unresolved: [], gaps: [], uncovered: [],
        concepts: [
          ...(docs ? [concept('ledger-separation', 'behaviour', 'strategy', 'Separate ledgers', 'A decision keeps keeper and visitor records apart.', [{ artifact_id: docs.artifact_id, quote: 'D1: keepers and visitors use separate ledgers.' }], ['decision'])] : []),
          ...(code ? [concept('admission', 'behaviour', 'responsibility', 'Visitor admission', 'Code admits a visitor by verifying a badge.', [{ artifact_id: code.artifact_id, quote: 'sessions.verify(request.headers.badge)' }], ['code_construct'])] : []),
          ...(ids.length && !docs && !code ? [concept('ledger-separation', 'behaviour', 'strategy', 'Separate ledgers', 'The same idea restated.', [{ artifact_id: ids[0], quote: 'partitionKey: "lanternId"' }])] : []),
        ] };
    } else if (packet.schema === 'estate-map/ontology-identity-packet/v1') answer = { decisions: identity.map(d => ({ ...d })) };
    else if (packet.schema === 'estate-map/ontology-subject-grounding-packet/v3') {
      const text = packet.artifact.text;
      answer = text.includes('admit(') ? { referents: [{ ref: 'r1', kind: 'code_construct', name: 'admit', quote: 'export function admit(request, sessions) {' }], assertions: [{ ref: 'r1', predicate: 'implements', concept: packet.vocabulary.find(c => c.label === 'Visitor admission')?.accession }], subject_status: [], instance_status: [], artifact_status: null }
        : { referents: [], assertions: [], subject_status: [], instance_status: [], artifact_status: { status: 'out_of_scope', reason: 'nothing here' } };
    } else if (packet.domains) answer = { themes: [], paths: [] };
    else if (packet.concepts && packet.source) answer = { domains: [{ key: 'access', label: 'Access and separation', definition: 'Who may enter and what is kept apart.', concepts: packet.concepts.map(c => c.id) }], relations: [], uncovered: [] };
    else answer = {};
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
  };
  return { call, seen };
}

test('an estate run reads, folds, grounds and assembles one proposed generation with separate counters', async () => {
  const { manifest, entries, units } = estate();
  const model = fakeModel();
  const { generation, coverage, domains, receipt, withheld_units } = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: model.call, bounds: { concurrency: 2 } });
  const c = coverage.by_source.lantern;
  const graph = evidenceGraph({ generations: [generation] });
  const view = discoveryViewModel(generation);
  assert.deepEqual([generation.acceptance.accepted, generation.status, withheld_units.map(w => w.rule), c.units_total === units.length, c.units_screened_out, c.units_read === c.units_ready, c.units_grounded > 0,
    generation.counts.concepts, generation.assertions.map(a => a.predicate), domains.domains.length, graph.counts.concepts, view.collections[0].collection_id, coverage.failures.map, receipt.by_stage.map > 0],
  [false, 'proposed', ['credential_shaped_text'].length ? withheld_units.map(w => w.rule) : [], true, withheld_units.length, true, true, 2, ['implements'], 1, 2, 'lantern', 0, true]);
  assert.ok(withheld_units.every(w => /credential|iban/u.test(w.rule)) && withheld_units.length >= 1);
});

test('an inventory-only source is counted and never sent, and archives, credentials and binaries keep their dispositions', () => {
  const { entries, units } = estate();
  const summary = summarizeInventory(entries, units);
  assert.deepEqual([summary.vault.by_disposition.withheld.files === summary.vault.files, summary.lantern.by_rule['not_read:archived_snapshot_directory'].files, summary.lantern.by_rule['withheld:credential_like_name'].files,
    summary.lantern.supported_files, summary.lantern.units > 0], [true, 1, 1, 4, true]);
});

test('a map batch that fails is a counted gap, not a silent skip, and nothing in it is claimed read', async () => {
  const { manifest, entries, units } = estate();
  const { coverage, generation } = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel({ failMap: true }).call, bounds: { concurrency: 2 } });
  assert.deepEqual([coverage.by_source.lantern.units_read, coverage.by_source.lantern.units_map_failed === coverage.by_source.lantern.units_ready, coverage.failures.map > 0, generation.counts.concepts, coverage.by_source.lantern.units_unknown_outcome === coverage.by_source.lantern.units_ready,
    coverage.map_gaps.length > 0 && coverage.map_gaps.every(g => g.class === 'unknown_outcome' && g.units.length && g.share_of_source_units > 0), coverage.cost_accounting.unknown_outcome_cost_usd], [0, true, true, 0, true, true, null]);
});

test('a restated concept becomes an identity candidate beside its target with its own evidence, and an exact repeat adds evidence to the original', async () => {
  const { manifest, entries, units } = estate();
  const batches = batchUnits(units.filter(u => !/leak/u.test(u.path)), { bytes: 100, count: 1 });
  assert.ok(batches.length >= 3);
  const model = fakeModel({ identity: [] });
  const base = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: model.call, bounds: { concurrency: 1, batch_bytes: 100, batch_units: 1 } });
  const separate = base.generation.collections[0].concepts.filter(x => x.label === 'Separate ledgers');
  const evidence = base.generation.collections[0].evidence.filter(e => e.concept_accession === separate[0].accession);
  assert.deepEqual([separate.length, evidence.length >= 1], [1, true]);
});

test('the candidate server serves /api/estate and the estate view script only when an estate is supplied', async () => {
  const { createCandidateViewServer } = await import('../tools/ontology/candidate-view.mjs');
  const { manifest, entries, units } = estate();
  const { generation, coverage, domains } = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel().call, bounds: { concurrency: 2 } });
  const withEstate = createCandidateViewServer({ generation, estate: { coverage, domains, manifest, inventory: { by_source: summarizeInventory(entries, units) } } }), without = createCandidateViewServer({ generation });
  await Promise.all([withEstate, without].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  try {
    const get = async (s, path) => fetch(`http://127.0.0.1:${s.address().port}${path}`);
    const est = await (await get(withEstate, '/api/estate')).json();
    assert.deepEqual([est.coverage.totals.units_total > 0, est.domains.domains.length, (await get(withEstate, '/ontology-estate.js')).status, (await get(without, '/api/estate')).status],
      [true, 1, 200, 404]);
  } finally { withEstate.close(); without.close(); }
});

test('provenance classes come from path shape alone, and diagnostics report domain input coverage, provenance, duplicates and path hand-offs offline', async () => {
  const { provenanceOf, estateDiagnostics } = await import('../tools/ontology/estate-diagnostics.mjs');
  assert.deepEqual(['src/admit.mjs', 'tests/admit.test.mjs', 'scripts/release.sh', 'docs/operational/run-report.md', 'docs/design.md', 'infra/stack.yaml', 'research/runs/page.html', 'Makefile'].map(provenanceOf),
    ['product_source', 'tests', 'tooling', 'operational_docs', 'documentation', 'configuration_infra', 'research_or_data_pages', 'tooling']);
  const { manifest, entries, units } = estate();
  const run = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel().call, bounds: { concurrency: 2 } });
  const d = estateDiagnostics({ generation: run.generation, domains: run.domains, coverage: run.coverage, domainCatalogue: 1 });
  const c = d.domain_input_coverage.lantern;
  assert.deepEqual([d.schema, c.concepts, c.shown_to_domain_step, c.not_shown, c.share_concepts_shown <= 1, Object.keys(d.units_read_by_provenance.lantern).length > 0, typeof d.near_duplicates.clusters,
    d.domains.every(x => ['evidence_mostly_tests_tooling_reports', 'product_or_system', 'documentation_or_configuration', 'no_evidence'].includes(x.reading)), Array.isArray(d.paths)],
  ['estate-map/ontology-estate-diagnostics/v1', 2, 1, 1, true, true, 'number', true, true]);
});

test('reconciliation gives every retained concept a disposition, keeps originals, verifies path quotes at the pin, and replays with no call', async () => {
  const { runReconcile } = await import('../tools/ontology/estate-reconcile.mjs');
  const { estateDiagnostics } = await import('../tools/ontology/estate-diagnostics.mjs');
  const mk = mkdtempSync;
  const { manifest, entries, units } = estate();
  const base = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel().call, bounds: { concurrency: 2 } });
  const diagnostics = estateDiagnostics({ generation: base.generation, domains: base.domains, coverage: base.coverage });
  const journalPath = join(mk(join(tmpdir(), 'reconcile-')), 'journal.jsonl');
  const model = async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    let answer;
    if (packet.schema === 'estate-map/ontology-domain-batch-packet/v1') {
      const [first, ...rest] = packet.concepts.map(c => c.id);
      answer = { domains: [{ key: 'access', label: 'Admission and separation', kind: 'responsibility', definition: 'Who is let in and what is kept apart.', concepts: [first] }], unassigned: rest.map(id => ({ id, reason: 'restates another concept' })) };
    } else if (packet.schema === 'estate-map/ontology-rollup-packet/v1') answer = { domains: [{ key: 'access', label: 'Access', kind: 'conceptual_domain', definition: 'Access and separation.', inputs: packet.domains.map(d => d.id) }], unplaced: [] };
    else if (packet.domains && !packet.schema) answer = { themes: [], paths: [] };
    else if (packet.schema === 'estate-map/ontology-path-link-packet/v1') {
      const unit = packet.from.excerpts[0];
      answer = { relation: 'sends_to', identifiers: ['sessions.verify'], from_quote: { unit_id: unit.unit_id, quote: unit.text.slice(0, 20) }, to_quote: { unit_id: unit.unit_id, quote: 'not in the excerpt at all' }, static_only: true, reason: 'x' };
    } else answer = {};
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
  };
  const dom = base.domains.domains[0];
  const edge = { label: 'invented hand-off', from: { domain_id: dom.domain_id, source_id: 'lantern', label: dom.label, concepts: dom.concepts }, to: { domain_id: dom.domain_id, source_id: 'lantern', label: dom.label, concepts: dom.concepts } };
  const run = modelCall => runReconcile({ generation: base.generation, domains: base.domains, diagnostics, units, manifest, runtime, journalPath, modelCall, bounds: { concurrency: 2 }, pathEdges: [edge] });
  const first = await run(model);
  const replay = await run(async () => { throw new Error('a replay must not call the model'); });
  const r = first.result, d = r.dispositions;
  assert.deepEqual([d.total, Object.values(d.by_disposition).reduce((a, b) => a + b, 0), r.domains.source_domains.length, d.by_disposition.assigned, d.by_disposition.unassigned, r.path_links[0].relation, r.path_links[0].quotes_verified_at_pin,
    replay.receipt.new_model_calls, JSON.stringify(replay.result.dispositions), r.model_config.effective_reasoning_effort, r.base_generation_id === base.generation.generation_id],
  [2, 2, 1, 1, 1, 'unverified_claim', false, 0, JSON.stringify(r.dispositions), 'unverified', true]);
});

test('a deleted concept leaves no stale disposition or domain membership, and only the changed batch is purchased again', async () => {
  const { runReconcile } = await import('../tools/ontology/estate-reconcile.mjs');
  const mk = mkdtempSync;
  const { manifest, entries, units } = estate();
  const base = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel().call, bounds: { concurrency: 2 } });
  const journalPath = join(mk(join(tmpdir(), 'reconcile-')), 'journal.jsonl');
  const model = async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    const answer = packet.schema === 'estate-map/ontology-domain-batch-packet/v1' ? { domains: [{ key: 'all', label: 'Everything here', kind: 'scope', definition: 'All of it.', concepts: packet.concepts.map(c => c.id) }], unassigned: [] }
      : packet.schema === 'estate-map/ontology-rollup-packet/v1' ? { domains: [{ key: 'all', label: 'Everything', kind: 'scope', definition: 'All.', inputs: packet.domains.map(d => d.id) }], unplaced: [] } : {};
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
  };
  const run = generation => runReconcile({ generation, domains: base.domains, diagnostics: null, units, manifest, runtime, journalPath, modelCall: model, bounds: { concurrency: 1 }, stages: new Set(['domain', 'rollup']) });
  const first = await run(base.generation);
  const removed = base.generation.collections[0].concepts[0].accession;
  const smaller = structuredClone(base.generation);
  smaller.collections[0].concepts = smaller.collections[0].concepts.filter(c => c.accession !== removed);
  const second = await run(smaller);
  const inDomains = second.result.domains.source_domains.flatMap(d => d.concepts);
  assert.deepEqual([first.receipt.new_model_calls > 0, second.result.dispositions.rows.some(r => r.accession === removed), inDomains.includes(removed), second.result.dispositions.total, second.receipt.new_model_calls > 0],
    [true, false, false, first.result.dispositions.total - 1, true]);
});

test('predicate mapping proposes canonical predicates, keeps every original text, and replays with no call', async () => {
  const { proposePredicateMappings } = await import('../tools/ontology/predicate-mapping.mjs');
  const mk = mkdtempSync;
  const generation = { generation_id: 'g', collections: [{ concepts: [{ accession: 'a', label: 'Gate' }, { accession: 'b', label: 'Door' }], relations: [
    { from: 'a', to: 'b', type: 'constrains', definition: 'x' }, { from: 'a', to: 'b', type: 'is limited by', definition: 'y' }, { from: 'b', to: 'a', type: 'related', definition: 'z' }] }] };
  const model = async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1));
    const answer = { mappings: packet.types.map(t => t.type === 'related' ? { type: t.type, canonical_id: 'unmapped', direction: 'symmetric', reason: 'vague' } : { type: t.type, canonical_id: 'constrains', direction: t.type === 'constrains' ? 'forward' : 'inverse', reason: 'same meaning' }),
      new_predicates: packet.vocabulary.length ? [] : [{ canonical_id: 'constrains', meaning: 'one thing limits another' }] };
    return { answer, raw_text: JSON.stringify(answer), model: 'example-provider/example-model', usage: { cost: { total: 0.001 } }, latency_ms: 1 };
  };
  const journalPath = join(mk(join(tmpdir(), 'pred-')), 'journal.jsonl');
  const run = modelCall => proposePredicateMappings({ generation, runtime, journalPath, modelCall });
  const first = await run(model), replay = await run(async () => { throw new Error('a replay must not call the model'); });
  const m = new Map(first.result.mappings.map(x => [x.original_text, x]));
  assert.deepEqual([first.result.mappings.length, m.get('is limited by').canonical_id, m.get('is limited by').direction, m.get('is limited by').status, m.get('related').canonical_id, first.result.canonical.map(c => c.canonical_id), replay.receipt.new_model_calls, JSON.stringify(replay.result) === JSON.stringify(first.result)],
    [3, 'constrains', 'inverse', 'proposed', 'unmapped', ['constrains'], 0, true]);
});

test('an embedded graph is reached only through fixed read-only routes, and ontology anchors are graph ids from the bound projection', async () => {
  const { createCandidateViewServer } = await import('../tools/ontology/candidate-view.mjs');
  const { manifest, entries, units } = estate();
  const { generation, coverage, domains } = await runEstateDiscovery({ manifest, units, inventoryEntries: entries, runtime, journalPath: null, modelCall: fakeModel().call, bounds: { concurrency: 2 } });
  const rows = generation.collections.flatMap(c => c.evidence);
  const pins = Object.fromEntries(rows.map(e => [e.repository, e.commit_sha]));
  const documents = [...new Map(rows.map(e => [e.blob_oid, { node_id: `doc:${e.repository}/${e.path}`, path: `${e.repository}/${e.path}`, blob_oid: e.blob_oid }])).values()];
  let head = { projection_id: 'estate-projection:p1', source_pins: pins };
  const queries = { projection: async () => head, stats: async () => ({ data: { nodes_by_kind: { Document: documents.length } } }), documentAnchors: async () => ({ data: { documents } }), node: async ({ id }) => ({ node: id }) };
  const estateInputs = { coverage, domains, manifest, inventory: { by_source: summarizeInventory(entries, units) } };
  const server = createCandidateViewServer({ generation, estate: estateInputs, graph: { queries, view: 'working', expectedProjectionId: 'estate-projection:p1' } }), legacy = createCandidateViewServer({ generation, estate: estateInputs });
  await Promise.all([server.ready, ...[server, legacy].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve)))]);
  try {
    const get = (s, path, init) => fetch(`http://127.0.0.1:${s.address().port}${path}`, init);
    const anchors = await (await get(server, '/api/ontology/anchors?view=working&kind=concept&i=0&limit=24')).json();
    assert.ok(anchors.total_anchors > 0 && anchors.anchors.every(a => documents.some(d => d.node_id === a.node_id)));
    assert.equal(anchors.projection_id, 'estate-projection:p1');
    const accession = encodeURIComponent(generation.collections[0].concepts[0].accession);
    const detail = await (await get(server, `/api/concept?accession=${accession}`)).json();
    assert.ok(detail.evidence.every(e => e.graph.status === 'bound' && documents.some(d => d.node_id === e.graph.node_id)));
    assert.equal((await get(server, '/api/ontology/anchors?view=selected&kind=concept&i=0')).status, 409);
    assert.equal((await get(server, '/api/ontology/anchors?view=working&kind=concept&i=999999')).status, 404);
    assert.equal((await get(server, '/api/node?id=x', { method: 'POST' })).status, 405);
    assert.equal((await get(server, '/api/cypher?q=MATCH')).status, 404);
    assert.equal((await get(server, '/graph')).status, 200);
    assert.equal((await get(legacy, '/graph')).status, 404);
    assert.equal((await get(legacy, '/api/ontology/binding')).status, 404);
    const { pair } = await (await get(server, '/api/ontology/binding')).json();
    assert.equal((await get(server, `/api/ontology/anchors?view=working&kind=concept&i=0&pair=${encodeURIComponent(pair)}`)).status, 200);
    assert.equal((await get(server, '/api/ontology/anchors?view=working&kind=concept&i=0&pair=other%3Apair')).status, 409);
    head = { ...head, projection_id: 'estate-projection:p2' };
    assert.equal((await get(server, '/api/ontology/anchors?view=working&kind=concept&i=0')).status, 409);
    const refused = await (await get(server, `/api/concept?accession=${accession}`)).json();
    assert.ok(refused.evidence.every(e => e.graph.status === 'refused_projection'));
  } finally { server.close(); legacy.close(); }
  // A graph that cannot be bound leaves the explorer up and says why.
  const broken = createCandidateViewServer({ generation, estate: estateInputs, graph: { queries: { projection: async () => { throw new Error('no working projection is staged'); } }, view: 'working' } });
  await Promise.all([broken.ready, new Promise(resolve => broken.listen(0, '127.0.0.1', resolve))]);
  try {
    const get = path => fetch(`http://127.0.0.1:${broken.address().port}${path}`);
    assert.equal((await (await get('/api/explore')).json()).graph_unavailable, 'no working projection is staged');
    assert.equal((await get('/api/ontology/binding')).status, 503);
  } finally { broken.close(); }
});
