import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEstate } from '../tools/extract.mjs';

async function extract(source) {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'withhold-'));
  mkdirSync(join(root, 'estate', 'fixture', 'lib'), { recursive: true });
  writeFileSync(join(root, 'estate', 'fixture', 'lib', 'config.ts'), source);
  await extractEstate(join(root, 'estate'), join(root, 'out'), { repo: 'fixture', strict: false });
  const facts = readFileSync(join(root, 'out', 'facts', 'fixture.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  rmSync(root, { recursive: true, force: true });
  return facts;
}

test('a numeric configuration value beside a secret-shaped name survives extraction', async () => {
  // The whole line used to be blanked because the identifier contains "token", so the value a
  // runbook contradicts was deleted before the parser saw it -- and blanking a line inside an
  // object literal unbalanced the literal, losing every sibling after it.
  const facts = await extract([
    'export const config = {',
    '  production: {',
    '    tokenExpiration: {',
    '      accessToken: 720,',
    '      idToken: 720,',
    '    },',
    "    apiKey: 'sk-live-must-not-appear',",
    '  },',
    '};',
  ].join('\n'));
  const literal = facts.find(fact => fact.kind === 'literal_value' && fact.name === 'config');
  const find = (row, key) => (row.entries || []).find(entry => entry.key === key);
  const expiration = find(find(literal, 'production'), 'tokenExpiration');
  assert.equal(find(expiration, 'accessToken').value, '720');
  assert.equal(find(expiration, 'idToken').value, '720');
});

test('an embedded credential is withheld and never reaches a fact', async () => {
  const facts = await extract("const apiKey = 'sk-live-must-not-appear';\n");
  const serialised = facts.map(fact => JSON.stringify(fact)).join('\n');
  assert.equal(serialised.includes('sk-live-must-not-appear'), false);
  assert.ok(serialised.includes('[redacted]'), 'the withholding must be visible, not silent');
});

test('an environment reference is left untouched, because it names a binding not a secret', async () => {
  // `process.env.STRIPE_KEY` contains no credential -- it says where one comes from. Withholding
  // it would destroy the deployment binding while removing nothing sensitive.
  const facts = await extract('const apiKey = process.env.STRIPE_KEY;\n');
  const serialised = facts.map(fact => JSON.stringify(fact)).join('\n');
  assert.equal(serialised.includes('[redacted]'), false, 'the line must not be rewritten');
  assert.ok(facts.some(fact => fact.kind === 'symbol' && fact.name === 'apiKey'));
});
