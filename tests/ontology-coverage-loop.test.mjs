import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { freezeCases, familyPacket, complexityOf, judgeFamilies, REFERENT_KIND } from '../tools/ontology/coverage-loop.mjs';
import { computeCoverage } from '../tools/ontology/graph-coverage.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const family = (file, mode = 'code', extra = {}) => ({ family_id: `family:${file}`, file, mode, observed: {}, directory: file.split('/').slice(0, 3).join('/'),
  candidates: [{ node_id: 'n', kind: 'Symbol', label: 'openLedger', line: 3 }], participation: [], ...extra });
const concept = (accession, extra = {}) => ({ accession, label: 'Ledger opening', definition: 'opens a ledger for the openLedger call', inclusion: 'openLedger entry points', exclusion: 'helpers', semantic_category: 'responsibility', domain: ['code_construct'], invariants: [], instance_conditions: ['a function that opens a ledger'], ...extra });

test('design and held-out sets share no directory and are fixed by the inputs alone', () => {
  const families = Array.from({ length: 60 }, (_, i) => family(`area${i % 12}/sub/f${i}.js`));
  const a = freezeCases(families, { design: { code: 8, text: 0 }, heldout: { code: 8, text: 0 } }), b = freezeCases([...families].reverse(), { design: { code: 8, text: 0 }, heldout: { code: 8, text: 0 } });
  const dirs = set => new Set(set.map(f => f.directory));
  assert.deepEqual([[...dirs(a.design)].filter(d => dirs(a.heldout).has(d)).length, a.manifest.digest === b.manifest.digest], [0, true]);
});

test('a packet carries whole declarations with full concept text; a declaration over budget is a recorded missing-context node, never a silent slice', () => {
  const body = ['function openLedger() {', ...Array.from({ length: 9 }, (_, i) => `  step${i}();`), '}', 'const unrelated = 1;'].join('\n');
  const long = 'x'.repeat(300);
  const packet = familyPacket(family('a/b/c.js', 'code', { candidates: [{ node_id: 'n', kind: 'Symbol', label: 'openLedger', line: 1 }] }), body, [concept('c1', { definition: long })], { packet_chars: 4000, block_lines: 70, max_line_chars: 1200, shortlist: 3, escalated_shortlist: 5 });
  const tiny = familyPacket(family('a/b/c.js', 'code', { candidates: [{ node_id: 'n', kind: 'Symbol', label: 'openLedger', line: 1 }] }), body, [concept('c1')], { packet_chars: 20, block_lines: 70, max_line_chars: 1200, shortlist: 3, escalated_shortlist: 5 });
  assert.deepEqual([packet.packet.declarations[0].text.includes('step8();'), packet.packet.concepts[0].definition.length, tiny.judged.length, tiny.missing[0].reason], [true, 300, 0, 'declaration_exceeds_packet_budget']);
});

test('complexity counts stated constraints as well as properties, so moving a constraint into a property is not a reduction', () => {
  const before = complexityOf([{ definition: 'aaa', inclusion: 'i', exclusion: 'e', instance_conditions: ['x', 'y'] }]);
  const after = complexityOf([{ canonical: { definition: 'aaa', inclusion: 'i', exclusion: 'e', instance_properties: ['p', 'q'] } }]);
  assert.deepEqual([before.stated_constraints, after.stated_constraints, after.instance_properties], [4, 2, 2]);
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'loop-'));
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), b); }
  git('add', '-A'); git('commit', '-qm', 'x');
  return { root, ref: git('rev-parse', 'HEAD').trim() };
}
const runtime = { config: { models: { code_claims: { runner: 'pi', name: 'example-provider/example-model', thinking: 'off', concurrency: 2, window_bytes: 4000, timeout_ms: 1000, max_event_bytes: 1e6, max_answer_bytes: 1e6 } }, ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100000 } } };

test('typed bindings keep the concept category predicate and domain, a helper is part_of a bound owner only inside the owner declaration, and a bare name match is refused', async () => {
  const text = ['export function openLedger() {', '  const PATH = "x";', '  return PATH;', '}', 'function other() {', '  return 1;', '}'].join('\n');
  const source = repo({ 'src/a.js': text });
  const fam = family('src/a.js', 'code', { candidates: [{ node_id: 'fn', kind: 'Symbol', label: 'openLedger', line: 1 }, { node_id: 'k', kind: 'LiteralValue', label: 'PATH', line: 2 }, { node_id: 'o', kind: 'Symbol', label: 'other', line: 5 }] });
  const answers = { cause: 'instance_binding', bindings: [
    { node: 'n1', role: 'instance', concept: 'c1', predicate: 'implements', quote: 'export function openLedger() {' },
    { node: 'n2', role: 'part_of', concept: 'c1', owner: 'n1', quote: 'const PATH = "x";' },
    { node: 'n3', role: 'instance', concept: 'c1', predicate: 'selects', quote: 'function other() {' },
    { node: 'n3', role: 'part_of', concept: 'c1', owner: 'n1', quote: 'function other() {' }], new_concepts: [], reason: 'x' };
  const model = async () => ({ answer: answers, raw_text: JSON.stringify(answers), model: 'example-provider/example-model', usage: { cost: { total: 0 } }, latency_ms: 1 });
  const out = await judgeFamilies({ families: [fam], source, vocabulary: [concept('c1')], runtime, journalPath: join(mkdtempSync(join(tmpdir(), 'j-')), 'j.jsonl'), modelCall: model, phase: 'design' });
  assert.deepEqual([out.bindings.map(b => `${b.node_label}:${b.role}:${b.predicate}`), out.part_of.map(e => e.node_label), out.part_of.length, out.refused.map(r => r.code).sort(), REFERENT_KIND.Symbol],
    [['openLedger:instance:implements'], ['PATH'], 1, ['NODE_NOT_INSIDE_OWNER_DECLARATION', 'PREDICATE_NOT_ADMISSIBLE_FOR_CATEGORY'], 'code_construct']);
});

test('a proposed subject is a state of its own, never replaces an evidence anchor, and never reaches through an import', async () => {
  async function* of(rows) { for (const r of rows) yield r; }
  const nodes = [{ node_id: 'm', kind: 'Module', properties: { repository: 'shop', file: 'a.js' } }, { node_id: 'f', kind: 'Symbol', properties: { repository: 'shop', file: 'a.js', line: 3 } }, { node_id: 'g', kind: 'Symbol', properties: { repository: 'shop', file: 'b.js', line: 3 } }];
  const edges = [{ relation: 'imports', from: 'f', to: 'g' }];
  const r = await computeCoverage({ nodes: of(nodes), edges: of(edges), anchors: [], repositories: ['shop'], graphPins: { shop: 'p' }, bindings: [{ node_id: 'f', concept: 'c', predicate: 'implements', ref: 'b1' }] });
  assert.deepEqual([r.state.get('f').d, r.state.get('g').d], ['proposed_subject', 'unplaced']);
});
