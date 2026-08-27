import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractEstate } from '../tools/extract.mjs';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const fixture = join(here, 'fixtures', 'catalog-coverage', 'estate');

async function extracted(t) {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  const root = await mkdtemp(join(scratch, 'catalog-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const estate = join(root, 'estate');
  const output = join(root, 'output');
  await cp(fixture, estate, { recursive: true });
  await extractEstate(estate, output, {
    repo: 'fixture', strict: true, catalog_globs: ['catalogs/**/*.json', 'catalogs/**/*.yaml'],
  });
  return (await readFile(join(output, 'facts', 'fixture.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('configured YAML and JSON catalogs emit bounded, content-addressed entries', async t => {
  const facts = await extracted(t);
  const entries = facts.filter(fact => fact.kind === 'catalog_entry');
  const alpha = entries.find(fact => fact.file === 'catalogs/potions.yaml' && fact.entry_key_path === 'alpha');
  const beta = entries.find(fact => fact.file === 'catalogs/potions.yaml' && fact.entry_key_path === 'beta');
  const fast = entries.find(fact => fact.file === 'catalogs/checks.json' && fact.entry_key_path === 'fast');
  const refusals = facts.filter(fact => fact.kind === 'catalog_entry_refusal').map(fact => ({
    file: fact.file, reason: fact.reason, entry_key_path: fact.entry_key_path ?? null,
    key_path: fact.key_path ?? null, limit: fact.limit ?? null,
  }));
  assert.deepEqual({ alpha: alpha?.scalar_fields, betaOmission: beta?.omitted_fields, fast: fast?.scalar_fields,
    refusals, digest: /^[0-9a-f]{64}$/u.test(alpha?.content_digest || ''),
    unconfigured: entries.some(fact => fact.file.includes('plugin.yaml')) }, {
    alpha: { title: 'alpha', retries: 3, enabled: true, 'nested.mode': 'safe' },
    betaOmission: [{ key_path: 'huge', reason: 'catalog_scalar_value_exceeds_limit', limit: 400 }],
    fast: { command: 'node test', retries: 2, enabled: true },
    refusals: [
      { file: 'catalogs/broken.json', reason: 'catalog_json_parse_error', entry_key_path: null, key_path: null, limit: null },
      { file: 'catalogs/potions.yaml', reason: 'catalog_scalar_value_exceeds_limit', entry_key_path: 'beta', key_path: 'huge', limit: 400 },
    ],
    digest: true, unconfigured: false,
  });
});

test('absent, declared-empty, and populated manifest relations remain distinct', async t => {
  const facts = await extracted(t);
  const presence = facts.filter(fact => fact.kind === 'manifest_key_presence'
    && fact.manifest_key === 'requires_capabilities');
  const byFile = Object.fromEntries(presence.map(fact => [fact.file, fact.presence]));
  const empty = facts.find(fact => fact.kind === 'manifest_empty_declaration'
    && fact.file === 'plugins/empty/plugin.yaml');
  assert.deepEqual({ byFile, empty: empty && {
    declaration_key: empty.declaration_key, declaration_empty: empty.declaration_empty, shape: empty.shape,
  } }, {
    byFile: {
      'plugins/absent/plugin.yaml': 'absent', 'plugins/empty/plugin.yaml': 'present_empty',
      'plugins/entries/plugin.yaml': 'present_nonempty',
    }, empty: { declaration_key: 'requires_capabilities', declaration_empty: true, shape: 'sequence' },
  });
});

test('adjacent YAML and TypeScript comments remain separate declaration facts', async t => {
  const facts = await extracted(t);
  const yaml = facts.find(fact => fact.kind === 'declaration_comment' && fact.syntax === 'yaml'
    && fact.file === 'plugins/empty/plugin.yaml');
  const source = facts.find(fact => fact.kind === 'declaration_comment' && fact.syntax === 'javascript'
    && fact.file === 'extensions/tools.ts');
  assert.deepEqual({ yaml: yaml && [yaml.declaration, yaml.comment_line_start, yaml.comment_line_end],
    source: source && [source.declaration, source.declaration_line, source.comment_line_start, source.comment_line_end],
    commentsEmbeddedInRegistration: facts.filter(fact => fact.kind === 'tool_registration').some(fact => 'comment' in fact) }, {
    yaml: ['requires_capabilities', 1, 1], source: ['tools', 3, 1, 2], commentsEmbeddedInRegistration: false,
  });
});

test('literal and computed registration names are respectively extracted and refused', async t => {
  const facts = await extracted(t);
  const registrations = facts.filter(fact => fact.kind === 'tool_registration');
  const refusal = facts.find(fact => fact.kind === 'tool_registration_refusal');
  assert.deepEqual({ registrations: registrations.map(fact => [fact.name, fact.line]),
    refusal: refusal && [refusal.reason, refusal.line] }, {
    registrations: [['declare_ward', 6]], refusal: ['tool_name_is_not_a_string_literal', 11],
  });
});
