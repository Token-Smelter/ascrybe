import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { traceHandOff, sharedBlobs } from '../tools/ontology/handoff-trace.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'trace-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q');
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  git('add', '-A'); git('commit', '-qm', 'x');
  return { root, ref: git('rev-parse', 'HEAD').trim() };
}

function fixtures() {
const writer = repo({ 'src/store.ts': "import { useDbClient } from './client';\nexport const COLLECTION_NAME = 'ledger_row';\nexport async function save(row: unknown) {\n  const db = await useDbClient(config);\n  await db.collection(COLLECTION_NAME).insertOne(row);\n}\n", 'src/client.ts': "export async function useDbClient(config: any) {\n  const { host } = config.ledgerDb;\n  return host;\n}\n" });
const reader = repo({ 'src/read.ts': "import { useDbClient } from './db';\nexport const COLLECTION_NAME = 'ledger_row';\nexport async function list() {\n  const db = await useDbClient(config);\n  return db.collection(COLLECTION_NAME).find({}).toArray();\n}\n", 'src/db.ts': "export async function useDbClient(config: any) {\n  const { host } = config.ledgerDb;\n  return host;\n}\n" });
const server = repo({ 'functions/index.ts': "export const recordEntry = functions.https.onCall(async (request) => {\n  return { ok: true };\n});\n" });
const client = repo({ 'app/Logger.kt': "val call = functions.getHttpsCallable(\"recordEntry\")\n", '.hidden/leak.txt': 'apiKey: "abcdefghijklmnop1234567890"\nrecordEntry\n' });
return { writer, reader, server, client };
}

test('a shared collection name is located but the physical store stays unresolved; a missing pin is reported, not guessed', () => {
  const roots = fixtures(), { writer } = roots;
  const same = traceHandOff({ id: 't1', label: 'x', a: { repo: 'writer', path: 'src/store.ts', line: 5 }, b: { repo: 'reader', path: 'src/read.ts', line: 5 } }, roots);
  const bad = traceHandOff({ id: 't2', label: 'x', a: { repo: 'writer', path: 'src/store.ts', line: 500 }, b: { repo: 'reader', path: 'src/read.ts', line: 5 } }, roots);
  const f = same.findings[0];
  assert.deepEqual([f.kind, f.relation, f.collections, f.physical_store, /deployed value/u.test(f.missing), same.static_only, bad.findings[0].relation, same.a.commit_sha === writer.ref],
    ['datastore', 'writes_to_and_reads_from_same_named_collection', ['ledger_row'], 'same connection configuration key in code, value not read back', true, true, 'pin_not_verified', true]);
});

test('a callable defined on one side and invoked by name on the other is a network finding with the exact call site, and hidden files are not searched', () => {
  const roots = fixtures();
  const t = traceHandOff({ id: 't3', label: 'x', a: { repo: 'server', path: 'functions/index.ts', line: 1 }, b: { repo: 'client' } }, roots);
  const f = t.findings[0], ref = f.refs.find(r => r.repo === 'client');
  assert.deepEqual([f.kind, f.callables, ref.path, ref.start_line, JSON.stringify(t).includes('leak.txt'), JSON.stringify(t).includes('abcdefghijklmnop')], ['network', ['recordEntry'], 'app/Logger.kt', 1, false, false]);
});

test('identical bytes in two trees are reported as a copy, not as shipped', () => {
  const body = 'x'.repeat(600);
  const one = repo({ 'marks/a.svg': body, 'marks/b.svg': 'y'.repeat(600) }), two = repo({ 'catalog/copy.svg': body, 'catalog/other.svg': 'z'.repeat(600) });
  const m = sharedBlobs(one.root, one.ref, 'marks/', two.root, two.ref, 'catalog/');
  assert.deepEqual([m.matches.length, m.matches[0].a_path, m.matches[0].b_paths], [1, 'marks/a.svg', ['catalog/copy.svg']]);
});
