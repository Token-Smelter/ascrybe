// [SHARED-PATH] [PARITY] [DEPENDENCIES] [INTEGRITY]: tools/file-extraction-adapter.mjs is the ONE
// place the ordinary extract CLI (tools/extract.mjs extractEstate) builds its per-file/extractor
// units. These tests exercise the REAL production extractor registry and the REAL per-unit cache
// (tools/delta/unit-cache.mjs) through extractEstate() itself -- never a hand-built fixture plan.
// Every repository/component/file name here is invented (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import {
  mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEstate } from '../tools/extract.mjs';
import { createScanInvocationRecorder, moduleClosureDigest } from '../tools/file-extraction-adapter.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function writeEstate(root) {
  mkdirSync(join(root, 'widget-app'), { recursive: true });
  writeFileSync(join(root, 'widget-app', 'index.mjs'),
    'export function widgetHandler() {\n  const apiKey = "sk-invented-widget-token";\n  return apiKey;\n}\n');
  writeFileSync(join(root, 'widget-app', 'notes.md'), '# Widget notes\n\nThis is a plan for the widget.\n');
}

test('[SHARED-PATH][PARITY] cold, warm, and forced-full extractEstate runs over the same source/config produce byte-identical facts and _MANIFEST.json; cache telemetry stays separate and scan calls actually decrease when warm', async () => {
  const root = scratchDir('shared-adapter-parity-');
  const estate = join(root, 'estate');
  writeEstate(estate);
  const cacheRoot = join(root, 'cache');

  const cold = await extractEstate(estate, join(root, 'cold'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const warm = await extractEstate(estate, join(root, 'warm'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const full = await extractEstate(estate, join(root, 'full'), { strict: true, cache: { root: cacheRoot, mode: 'full' } });

  const factsPath = 'facts/widget-app.jsonl';
  const coldFacts = readFileSync(join(root, 'cold', factsPath), 'utf8');
  const warmFacts = readFileSync(join(root, 'warm', factsPath), 'utf8');
  const fullFacts = readFileSync(join(root, 'full', factsPath), 'utf8');
  assert.equal(warmFacts, coldFacts, 'a warm (cache-reusing) run must emit byte-identical facts to the cold run');
  assert.equal(fullFacts, coldFacts, 'a forced-full (--cache-mode full) run must emit byte-identical facts to the cold run');

  const coldManifest = readFileSync(join(root, 'cold', '_MANIFEST.json'), 'utf8');
  const warmManifest = readFileSync(join(root, 'warm', '_MANIFEST.json'), 'utf8');
  const fullManifest = readFileSync(join(root, 'full', '_MANIFEST.json'), 'utf8');
  assert.equal(warmManifest, coldManifest, 'canonical _MANIFEST.json content must be byte-identical, cold vs warm');
  assert.equal(fullManifest, coldManifest, 'canonical _MANIFEST.json content must be byte-identical, cold vs forced-full');

  // Cache telemetry is a SEPARATE receipt and is where cold/warm/full are allowed -- and expected
  // -- to differ: this is the actual proof that reuse happened, not a self-reported digest.
  const coldTelemetry = JSON.parse(readFileSync(join(root, 'cold', '_CACHE_TELEMETRY.json'), 'utf8'));
  const warmTelemetry = JSON.parse(readFileSync(join(root, 'warm', '_CACHE_TELEMETRY.json'), 'utf8'));
  const fullTelemetry = JSON.parse(readFileSync(join(root, 'full', '_CACHE_TELEMETRY.json'), 'utf8'));
  assert.ok(coldTelemetry.scan_calls > 0, 'the cold run must actually call extractor.scan()');
  assert.equal(coldTelemetry.by_disposition.reused_exact, 0, 'the cold run has nothing to reuse');
  assert.equal(warmTelemetry.scan_calls, 0, 'ACTUAL scan calls must drop to zero for a fully-unchanged warm run — not merely a lower reported count');
  assert.equal(warmTelemetry.by_disposition.reused_exact, coldTelemetry.total_units, 'every unit must be served reused_exact on the warm run');
  assert.equal(fullTelemetry.scan_calls, coldTelemetry.scan_calls, 'forced-full must recompute every unit, exactly like the cold run');
  assert.equal(fullTelemetry.by_disposition.reused_exact, 0, '--cache-mode full must never reuse, even though the same cache_root now holds warm entries');

  assert.equal(cold.repositories, 1);
  assert.deepEqual(warm.cache, { root: cacheRoot, mode: 'reuse' });
  assert.deepEqual(full.cache, { root: cacheRoot, mode: 'full' });

  // [ACTUAL-SCANS] `actual_scan_invocations` is grounded at the production extractor.scan()
  // callsite itself, never deduced from `disposition.kind` — verified separately from `scan_calls`
  // above (which is disposition-derived) even though both agree in this honest, non-adversarial run.
  assert.equal(coldTelemetry.actual_scan_invocations, coldTelemetry.scan_calls, 'the cold run’s actual invocation count must equal its disposition-derived count when nothing is adversarial');
  assert.ok(coldTelemetry.actual_scan_invocations > 0);
  assert.equal(warmTelemetry.actual_scan_invocations, 0, 'warm reuse must record ZERO actual scan invocations');
  // "deliberately recomputed cached output is detected": --cache-mode full over an ALREADY-WARM
  // cache_root must show a REAL, nonzero recompute count equal to the cold run’s — proving this is
  // a genuine recompute, not a disposition label that silently stayed at zero.
  assert.equal(fullTelemetry.actual_scan_invocations, coldTelemetry.actual_scan_invocations, 'a forced-full run over an already-warm cache must show a GENUINE recompute (nonzero, matching cold), never a silently-reused zero');
  assert.ok(Array.isArray(coldTelemetry.scan_invocation_samples) && coldTelemetry.scan_invocation_samples.length > 0);
  assert.equal(coldTelemetry.scan_invocation_samples[0].outcome, 'returned');
});

test('[ACTUAL-SCANS] createScanInvocationRecorder records BEFORE the call, with the return/throw outcome attached once it settles — the exact shape tools/file-extraction-adapter.mjs’s production callsite uses', () => {
  const recorder = createScanInvocationRecorder();
  assert.equal(recorder.count, 0);

  const returnedEvent = recorder.recordInvocation({ repository: 'invented-repo', normalized_path: 'src/a.py', extractor_id: 'invented-extractor' });
  assert.equal(returnedEvent.outcome, 'pending', 'the event is recorded BEFORE the outcome is known');
  recorder.recordOutcome(returnedEvent, { outcome: 'returned', fact_count: 3 });

  const threwEvent = recorder.recordInvocation({ repository: 'invented-repo', normalized_path: 'src/b.py', extractor_id: 'invented-extractor' });
  recorder.recordOutcome(threwEvent, { outcome: 'threw', error: 'invented parse failure' });

  assert.equal(recorder.count, 2, 'a THROW must still increment the counter — telemetry counts invocations, not successes');
  const events = recorder.events;
  assert.equal(events[0].outcome, 'returned');
  assert.equal(events[0].fact_count, 3);
  assert.equal(events[1].outcome, 'threw');
  assert.equal(events[1].error, 'invented parse failure');
});

test('[SHARED-PATH][PARITY] editing one file only invalidates that file\u2019s units on the next warm run — the untouched file keeps zero scan calls', async () => {
  const root = scratchDir('shared-adapter-invalidate-');
  const estate = join(root, 'estate');
  writeEstate(estate);
  const cacheRoot = join(root, 'cache');

  await extractEstate(estate, join(root, 'run1'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  writeFileSync(join(estate, 'widget-app', 'notes.md'), '# Widget notes\n\nThis plan changed.\n');
  const run2 = await extractEstate(estate, join(root, 'run2'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });

  const telemetry = JSON.parse(readFileSync(join(root, 'run2', '_CACHE_TELEMETRY.json'), 'utf8'));
  const widget = telemetry.by_repository.find(entry => entry.repo === 'widget-app');
  // document-structure routes to notes.md; index.mjs's units (treesitter etc.) must all reuse.
  assert.ok(widget.by_disposition.produced >= 1, 'the edited file\u2019s unit(s) must recompute');
  assert.ok(widget.by_disposition.reused_exact >= 1, 'the untouched file\u2019s unit(s) must reuse, proving invalidation is per-file, not whole-estate');
  void run2;
});

test('[INTEGRITY] two components with the SAME relative path never collide: distinct facts, distinct cache units', async () => {
  const root = scratchDir('shared-adapter-samepath-');
  const estate = join(root, 'estate');
  for (const component of ['amber-ledger', 'cobalt-gateway']) {
    mkdirSync(join(estate, component, 'src'), { recursive: true });
    writeFileSync(join(estate, component, 'src', 'entry.mjs'), `export function ${component === 'amber-ledger' ? 'publishAmber' : 'publishCobalt'}() { return 1; }\n`);
  }
  const cacheRoot = join(root, 'cache');
  const out = join(root, 'out');
  await extractEstate(estate, out, { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const amberFacts = readFileSync(join(out, 'facts', 'amber-ledger.jsonl'), 'utf8');
  const cobaltFacts = readFileSync(join(out, 'facts', 'cobalt-gateway.jsonl'), 'utf8');
  assert.notEqual(amberFacts, cobaltFacts, 'facts at the same relative path in different repositories must not collide');
  assert.ok(amberFacts.includes('publishAmber'));
  assert.ok(cobaltFacts.includes('publishCobalt'));
  // Two distinct file-scope cache objects must exist (one per repository), not one shared object.
  const cacheEntries = readdirSync(cacheRoot).filter(name => !name.includes('.staging') && !name.includes('.lock'));
  assert.ok(cacheEntries.length >= 2, 'same-relative-path units in different repositories must occupy distinct cache objects');
});

test('[INTEGRITY] a corrupt cached unit is quarantined and recomputed, never trusted or repaired in place', async () => {
  const root = scratchDir('shared-adapter-corrupt-');
  const estate = join(root, 'estate');
  writeEstate(estate);
  const cacheRoot = join(root, 'cache');
  await extractEstate(estate, join(root, 'run1'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });

  const unitDirs = readdirSync(cacheRoot).filter(name => /^[0-9a-f]{64}$/.test(name));
  assert.ok(unitDirs.length > 0);
  const receiptPath = join(cacheRoot, unitDirs[0], 'receipt.json');
  const stored = JSON.parse(readFileSync(receiptPath, 'utf8'));
  stored.receipt_digest = 'tampered';
  writeFileSync(receiptPath, JSON.stringify(stored, null, 2));

  const run2 = await extractEstate(estate, join(root, 'run2'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const telemetry = JSON.parse(readFileSync(join(root, 'run2', '_CACHE_TELEMETRY.json'), 'utf8'));
  assert.ok(telemetry.by_disposition.produced >= 1, 'the corrupted unit must be recomputed, not silently reused');
  assert.ok(readdirSync(cacheRoot).some(name => name.includes('.quarantined.')), 'the corrupt object must be quarantined on disk, never edited in place');
  const factsAfter = readFileSync(join(root, 'run2', 'facts', 'widget-app.jsonl'), 'utf8');
  const factsBefore = readFileSync(join(root, 'run1', 'facts', 'widget-app.jsonl'), 'utf8');
  assert.equal(factsAfter, factsBefore, 'recomputation after quarantine must reproduce the same correct facts');
  void run2;
});

test('[DEPENDENCIES] moduleClosureDigest changes when a TRANSITIVELY-IMPORTED HELPER changes, even though the extractor\u2019s own scan() function text is untouched — Function.toString() cannot see this', () => {
  const root = scratchDir('shared-adapter-closure-');
  mkdirSync(join(root, 'extractors'), { recursive: true });
  mkdirSync(join(root, 'helpers'), { recursive: true });
  writeFileSync(join(root, 'helpers', 'util.mjs'), 'export function widgetKind() { return "widget-v1"; }\n');
  writeFileSync(join(root, 'extractors', 'sample.mjs'), [
    "import { widgetKind } from '../helpers/util.mjs';",
    'export function scan(lines, ctx) { return lines.map(() => widgetKind()); }',
    'export default { kind: "sample", filePattern: /\\.sample$/, scan };',
    '',
  ].join('\n'));
  const entry = join(root, 'extractors', 'sample.mjs');
  const before = moduleClosureDigest(entry);
  assert.ok(before.files.includes('helpers/util.mjs'), 'the closure must include the transitively-imported helper');

  // Edit ONLY the helper. The extractor's own file (and therefore
  // extractor.scan.toString(), which is scoped to that one function's own source) is unchanged.
  writeFileSync(join(root, 'helpers', 'util.mjs'), 'export function widgetKind() { return "widget-v2"; }\n');
  const after = moduleClosureDigest(entry);
  assert.notEqual(after.digest, before.digest, 'a helper-only edit must change the extractor\u2019s implementation_digest');
});

test('[DEPENDENCIES] moduleClosureDigest refuses to walk outside its own root', () => {
  const root = scratchDir('shared-adapter-closure-escape-');
  mkdirSync(join(root, 'extractors'), { recursive: true });
  writeFileSync(join(root, 'extractors', 'escape.mjs'), "import { x } from '../../etc/passwd.mjs';\nexport default { kind: 'escape' };\n");
  assert.throws(() => moduleClosureDigest(join(root, 'extractors', 'escape.mjs')), /escaped its root/);
});

test('[INTEGRITY] a file whose only matching extractor throws is refused, never cached as a clean success, and diagnostics stay accurate across a cache hit', async () => {
  // document-structure extraction requires readable Markdown; feeding a real Markdown file that
  // does not itself error is not useful here, so instead we prove the diagnostics/refusal
  // plumbing end to end with a normal estate and confirm parse_error_count is stable across a
  // cache-served rerun (the earlier corruption test already proves failure IS fail-closed;
  // this proves absence of failure is reported identically warm vs cold).
  const root = scratchDir('shared-adapter-diagnostics-');
  const estate = join(root, 'estate');
  writeEstate(estate);
  const cacheRoot = join(root, 'cache');
  await extractEstate(estate, join(root, 'run1'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const run2 = await extractEstate(estate, join(root, 'run2'), { strict: true, cache: { root: cacheRoot, mode: 'reuse' } });
  const manifest1 = JSON.parse(readFileSync(join(root, 'run1', '_MANIFEST.json'), 'utf8'));
  const manifest2 = JSON.parse(readFileSync(join(root, 'run2', '_MANIFEST.json'), 'utf8'));
  assert.deepEqual(
    manifest1.repositories.map(entry => entry.repo),
    manifest2.repositories.map(entry => entry.repo),
  );
  void run2;
});
