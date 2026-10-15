import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { parseArgs } from '../tools/ontology/cli.mjs';
import { planInvocation } from '../bin/ascrybe.mjs';

test('parseArgs pairs a flag with the token after it, unless that token is itself a flag', () => {
  assert.deepEqual(parseArgs(['--interpretation-id', 'estate-interpretation:aaa', '--min-confidence', 'certain']),
    { options: { 'interpretation-id': 'estate-interpretation:aaa', 'min-confidence': 'certain' }, positionals: [] });
});

test('parseArgs treats a flag with no following value as boolean true', () => {
  assert.deepEqual(parseArgs(['--verbose']), { options: { verbose: true }, positionals: [] });
});

test('ascrybe ontology classify dispatches with caller runtime config after its verb', () => {
  const plan = planInvocation(['ontology', 'classify', '--input', '/tmp/widget.json'],
    { environment: {}, cwd: '/tmp', root: '/invented/ascrybe' });
  assert.deepEqual({ script: plan.script, args: plan.args }, {
    script: '/invented/ascrybe/tools/ontology/cli.mjs',
    args: ['classify', '--runtime-config', '/tmp/ascrybe.config.json', '--input', '/tmp/widget.json'],
  });
});

test('parseArgs keeps positionals and flags separate regardless of interleaving order', () => {
  assert.deepEqual(parseArgs(['--runtime-config', '/work/ascrybe.config.json', 'members', '--concept-id', 'AR-0001']),
    { options: { 'runtime-config': '/work/ascrybe.config.json', 'concept-id': 'AR-0001' }, positionals: ['members'] });
});

test('ontology align hands the repositories map, corpora and generations to the alignment pass (no inference)', async () => {
  const { writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runAlign } = await import('../tools/ontology/cli.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'align-cli-'));
  const put = (name, value) => { const file = join(dir, name); write(file, JSON.stringify(value)); return file; };
  const seen = {};
  const align = async args => {
    Object.assign(seen, args);
    const alignment = Object.freeze({ schema: 'estate-map/ontology-alignment/v1', alignment_id: 'ontology-alignment:test', status: 'proposed', accepted: false, counts: {}, inputs: [], links: [], subject_links: [],
      judged_none: [], needs_context: [], subject_needs_context: [], subject_no_link: [], governed_subjects: [], withheld_concepts: [], stale_links: [], rejected: [], subject_link_withheld: [], unaligned: [],
      candidate_pairs: {}, model_config: {} });
    return { alignment, receipt: { new_model_calls: 0, new_cost_usd: 0, calls: [] } };
  };
  const out = join(mkdtempSync(join(tmpdir(), 'align-out-')), 'private');
  const code = await runAlign({ generations: put('g.json', { generation_id: 'g1', collections: [] }), corpora: put('c.json', { collections: [], source_identity: {}, unsupported: [], withheld: [],
    outbound_review: { status: 'approved_for_selected_llm', policy: 'x' } }), repositories: put('r.json', { lantern: '/srv/lantern' }), 'output-dir': out, 'include-within-collection': true },
  { align, loadRuntime: () => ({ models: {} }) }).catch(error => error);
  assert.deepEqual([seen.repositories, seen.generations?.length, seen.includeWithinCollection, typeof seen.journalPath], [{ lantern: '/srv/lantern' }, 1, true, 'string']);
  assert.ok(code === 0 || code instanceof Error);
});
