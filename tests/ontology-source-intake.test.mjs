import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotSource } from '../tools/snapshot-source.mjs';
import { inventoryEstate, readBlobs } from '../tools/ontology/estate-inventory.mjs';
import { runEstateDiscovery } from '../tools/ontology/estate-discovery.mjs';
import { readPinned, traceHandOff } from '../tools/ontology/handoff-trace.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const manifest = sources => ({ schema: 'estate-map/ontology-estate-manifest/v1', sources });
const descriptor = (root, id, ref = git(root, 'rev-parse', 'HEAD')) => ({ root, id, ref, policy: 'interpret' });
const runtime = { models: { code_claims: { name: 'example-provider/example-model', thinking: 'off' } }, ontology_classification: { llm_role: 'code_claims', llm_max_input_bytes: 100_000 } };
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'source-intake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function commit(root) { git(root, 'add', '-A'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Record fixture'); return git(root, 'rev-parse', 'HEAD'); }
function repo(dir, name) { const root = join(dir, name); mkdirSync(root); git(root, 'init', '-q'); writeFileSync(join(root, 'same.md'), `${name} pinned content\n`); commit(root); return root; }
function link(parent, child, path, pin = git(child, 'rev-parse', 'HEAD')) {
  writeFileSync(join(parent, '.gitmodules'), `[submodule "${path}"]\n\tpath = ${path}\n\turl = ../invented\n`);
  git(parent, 'add', '.gitmodules'); git(parent, 'update-index', '--add', '--cacheinfo', `160000,${pin},${path}`);
  git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Pin child');
}
function fakeModel(seen) {
  return async prompt => {
    const packet = JSON.parse(prompt.split('\n\n').at(-1)); seen.push(packet);
    let answer = {};
    if (packet.artifacts) answer = { schemes: [{ key: 'rules', label: 'Rules', definition: 'Invented admission rules.' }], concepts: packet.artifacts.map(a => ({ stable_key: a.path.replace(/\W/gu, '-'), scheme_key: 'rules', semantic_category: 'strategy', label: a.path, definition: 'An invented admission rule.', inclusion: 'States the rule.', exclusion: 'Mentions only.', domain: ['decision'], invariants: [], instance_conditions: [], aliases: [], support: [{ artifact_id: a.artifact_id, quote: a.text }], counterexamples: [] })), relations: [], unresolved: [], gaps: [], uncovered: [] };
    else if (packet.artifact) answer = { referents: [], assertions: [], subject_status: [], instance_status: [], artifact_status: { status: 'out_of_scope', reason: 'Fixture only.' } };
    else if (packet.source && packet.concepts) answer = { domains: [], relations: [], uncovered: packet.concepts.map(c => c.id) };
    else if (packet.domains) answer = { themes: [], paths: [] };
    else answer = { decisions: [] };
    return { answer, raw_text: JSON.stringify(answer), model: runtime.models.code_claims.name, usage: { cost: { total: 0 } }, latency_ms: 0 };
  };
}

test('snapshots retain history, reuse unchanged maps, retire deleted evidence and replay without calls', async t => {
  const dir = sandbox(t), root = join(dir, 'folder'); mkdirSync(root);
  for (const name of ['keep', 'change', 'delete']) writeFileSync(join(root, `${name}.md`), `${name} admission rule.\n`);
  const options = { root, id: 'paper', authorizedRoots: [root], stateRoot: join(dir, 'state') };
  const first = snapshotSource(options), same = snapshotSource(options);
  const initial = inventoryEstate(manifest([first.source])), seen = [], journalPath = join(dir, 'journal.jsonl');
  const discover = intake => runEstateDiscovery({ manifest: intake.manifest, units: intake.units, inventoryEntries: intake.entries, runtime, journalPath, modelCall: fakeModel(seen), bounds: { concurrency: 1 } });
  const original = await discover(initial);
  const replay = await discover(initial);
  writeFileSync(join(root, 'change.md'), 'Changed admission rule.\n'); rmSync(join(root, 'delete.md'));
  const next = snapshotSource(options), updated = inventoryEstate(manifest([next.source]));
  const delta = await discover(updated);
  const evidence = delta.generation.collections.flatMap(c => c.evidence);
  assert.deepEqual({
    same: same.source.ref === first.source.ref && same.source.snapshot.tree === first.source.snapshot.tree,
    untouched: !existsSync(join(root, '.git')),
    parent: git(next.source.root, 'rev-parse', `${next.source.ref}^`),
    diff: git(next.source.root, 'diff', '--name-status', first.source.ref, next.source.ref).split('\n'),
    replay: replay.receipt.new_model_calls,
    reused: delta.receipt.reused_snapshot_map_batches,
    oldReadable: readPinned(first.source.root, first.source.ref, 'delete.md'),
    noDeletedUnits: updated.units.every(u => u.path !== 'delete.md'),
    oldGenerationKept: original.generation.source_identity.repo_pins.paper === first.source.ref,
    snapshotKind: delta.generation.source_identity.source_descriptors[0].source_kind,
    newPin: delta.generation.source_identity.repo_pins.paper === next.source.ref,
    noDeletedEvidence: evidence.length > 0 && delta.generation.source_artifacts.every(a => a.path !== 'delete.md' && a.commit_sha === next.source.ref),
    originalHadDeleted: original.generation.source_artifacts.some(a => a.path === 'delete.md'),
    changedQuoteInvalidated: !JSON.stringify(evidence).includes('change admission rule.'),
    retainedQuoteRepinned: delta.generation.source_artifacts.some(a => a.path === 'keep.md' && a.commit_sha === next.source.ref),
  }, { same: true, untouched: true, parent: first.source.ref, diff: ['M\tchange.md', 'D\tdelete.md'], replay: 0, reused: 1, oldReadable: 'delete admission rule.\n', noDeletedUnits: true, oldGenerationKept: true, snapshotKind: 'snapshot_import', newPin: true, noDeletedEvidence: true, originalHadDeleted: true, changedQuoteInvalidated: true, retainedQuoteRepinned: true });
});

test('snapshot screening excludes secrets and unsafe entries before writing objects', t => {
  const dir = sandbox(t), root = join(dir, 'folder'); mkdirSync(root);
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'dep.js'), 'excluded dependency');
  mkdirSync(join(root, 'empty')); writeFileSync(join(root, '.env'), 'excluded credential');
  writeFileSync(join(root, 'leak.md'), 'api_key = "abcdef1234567890abcdef12"');
  writeFileSync(join(root, 'large.md'), 'x'.repeat(600_000)); writeFileSync(join(root, 'safe.md'), 'Invented safe note.\n');
  symlinkSync('safe.md', join(root, 'link.md')); execFileSync('mkfifo', [join(root, 'pipe')]);
  const result = snapshotSource({ root, id: 'paper', authorizedRoots: [root], stateRoot: join(dir, 'state') });
  assert.deepEqual([git(result.source.root, 'ls-tree', '-r', '--name-only', result.source.ref), Object.fromEntries(result.dispositions.map(d => [d.path, d.rule]))], ['safe.md', { '.env': 'credential_like_name', empty: 'empty_directory_not_representable', 'large.md': 'file_over_read_limit', 'leak.md': 'credential_shaped_text', 'link.md': 'symlink', node_modules: 'dependency_or_build_directory', pipe: 'special_file', 'safe.md': 'screened_regular_file' }]);
  const objects = git(result.source.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').split('\n').filter(l => l.endsWith(' blob')).map(l => git(result.source.root, 'cat-file', 'blob', l.split(' ')[0]));
  assert.deepEqual(objects, ['Invented safe note.']);
});

test('unauthorized, Git, concurrent and changing sources are refused without advancing the pin', t => {
  const dir = sandbox(t), root = repo(dir, 'folder'), stateRoot = join(dir, 'state');
  const options = { root, id: 'paper', stateRoot, authorizedRoots: [root] };
  assert.throws(() => snapshotSource({ ...options, authorizedRoots: [] }), /explicitly authorized/u);
  assert.throws(() => snapshotSource(options), /normal Git source/u);
  const first = snapshotSource({ ...options, forceGit: true });
  mkdirSync(`${first.source.root}.lock`);
  assert.throws(() => snapshotSource({ ...options, forceGit: true }), /lock exists/u);
  rmSync(`${first.source.root}.lock`, { recursive: true });
  assert.throws(() => snapshotSource({ ...options, forceGit: true, beforeConsistencyCheck: () => writeFileSync(join(root, 'same.md'), 'Changed during import\n') }), /changed during import/u);
  assert.equal(git(first.source.root, 'rev-parse', 'refs/heads/snapshots'), first.source.ref);
});

test('private exclude rules are applied before staging', t => {
  const dir = sandbox(t), root = join(dir, 'folder'); mkdirSync(root); writeFileSync(join(root, 'safe.md'), 'Safe\n');
  const options = { root, id: 'paper', authorizedRoots: [root], stateRoot: join(dir, 'state') }, first = snapshotSource(options);
  writeFileSync(join(first.source.root, 'info', 'exclude'), 'hidden.md\n'); writeFileSync(join(root, 'hidden.md'), 'Not imported\n');
  const next = snapshotSource(options);
  assert.deepEqual([next.source.ref === first.source.ref, next.dispositions.find(d => d.path === 'hidden.md').rule], [true, 'git_ignore']);
});

test('nested submodules use their own pins, deduplicate explicit sources and keep equal paths distinct', t => {
  const dir = sandbox(t), parent = repo(dir, 'parent'), child = repo(dir, 'child'), leaf = repo(dir, 'leaf');
  const leafPin = git(leaf, 'rev-parse', 'HEAD'); link(child, leaf, 'leaf'); const childPin = git(child, 'rev-parse', 'HEAD'); link(parent, child, 'child');
  writeFileSync(join(leaf, 'same.md'), 'WRONG live leaf\n'); commit(leaf); writeFileSync(join(child, 'same.md'), 'WRONG live child\n'); commit(child);
  const input = { ...manifest([descriptor(parent, 'parent'), descriptor(child, 'child', childPin)]), source_repositories: { child, leaf } };
  const result = inventoryEstate(input), leafSource = result.manifest.sources.find(s => s.ref === leafPin);
  const contents = result.manifest.sources.flatMap(s => result.units.filter(u => u.source_id === s.id && u.path === 'same.md').map(u => readBlobs(s.root, [u.oid]).get(u.oid).toString()));
  assert.deepEqual([result.manifest.sources.length, result.units.filter(u => u.path === 'same.md').length, new Set(result.units.map(u => u.unit_id)).size === result.units.length, contents.sort(), leafSource.parents[0].gitlink_pin, result.manifest.sources.find(s => s.id === 'child').parents[0].source_id], [3, 3, true, ['child pinned content\n', 'leaf pinned content\n', 'parent pinned content\n'], leafPin, 'parent']);
});

test('unavailable and undeclared gitlinks are explicit dispositions without fetching', t => {
  const dir = sandbox(t), parent = repo(dir, 'parent'), child = repo(dir, 'child');
  link(parent, child, 'child', 'a'.repeat(40));
  const result = inventoryEstate({ ...manifest([descriptor(parent, 'parent')]), source_repositories: { child } });
  assert.deepEqual(result.entries.filter(e => e.mode === '160000').map(e => [e.disposition, e.rule]), [['not_read', 'SUBMODULE_UNAVAILABLE']]);
  git(parent, 'rm', '.gitmodules');
  git(parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Remove declaration');
  const undeclared = inventoryEstate(manifest([descriptor(parent, 'parent')]));
  assert.equal(undeclared.entries.find(e => e.mode === '160000').rule, 'GITLINK_UNREGISTERED');
});

test('checkout resolution and handoff use the gitlink pin rather than a child live HEAD', t => {
  const dir = sandbox(t), parent = repo(dir, 'parent'), child = repo(dir, 'child');
  const pin = git(child, 'rev-parse', 'HEAD'); link(parent, child, 'module');
  writeFileSync(join(child, 'same.md'), 'Wrong live bytes\n'); commit(child);
  execFileSync('git', ['clone', '-q', '--local', child, join(parent, 'module')]);
  const result = inventoryEstate(manifest([descriptor(parent, 'parent')]));
  const source = result.manifest.sources.find(s => s.id !== 'parent');
  const trace = traceHandOff({ id: 'fixture', a: { repo: 'parent', path: 'same.md', whole: true }, b: { repo: source.id, path: 'same.md', whole: true } }, Object.fromEntries(result.manifest.sources.map(s => [s.id, s])));
  assert.deepEqual([trace.b.commit_sha, trace.b.block_text, trace.b.parents[0].source_id], [pin, 'child pinned content\n', 'parent']);
});

test('snapshot pins are reproducible across custody roots and CLI inventory preserves import provenance', t => {
  const dir = sandbox(t), root = join(dir, 'folder'); mkdirSync(root); writeFileSync(join(root, 'note.md'), 'Invented note\n');
  const options = { root, id: 'paper', authorizedRoots: [root] };
  const first = snapshotSource({ ...options, stateRoot: join(dir, 'first') });
  const second = snapshotSource({ ...options, stateRoot: join(dir, 'second') });
  const manifestPath = join(dir, 'manifest.json'), output = join(dir, 'inventory');
  writeFileSync(manifestPath, JSON.stringify(manifest([first.source])));
  execFileSync(process.execPath, [new URL('../bin/ascrybe.mjs', import.meta.url).pathname, 'ontology', 'inventory', '--manifest', manifestPath, '--output-dir', output]);
  const expanded = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  const trace = traceHandOff({ id: 'fixture', a: { repo: 'paper', path: 'note.md' }, b: { repo: 'paper', path: 'note.md' } }, { paper: expanded.sources[0] });
  assert.deepEqual([first.source.ref === second.source.ref, trace.a.source_kind, trace.a.snapshot.authored_history, trace.a.commit_sha], [true, 'snapshot_import', false, first.source.ref]);
});

test('discovery rejects a unit whose blob exists but is not at the source pin and path', async t => {
  const dir = sandbox(t), root = repo(dir, 'source'), old = descriptor(root, 'source');
  const first = inventoryEstate(manifest([old])); writeFileSync(join(root, 'same.md'), 'New bytes\n'); commit(root);
  const next = inventoryEstate(manifest([descriptor(root, 'source')]));
  await assert.rejects(runEstateDiscovery({ manifest: next.manifest, units: first.units, inventoryEntries: next.entries, runtime, modelCall: () => { throw new Error('must not call'); } }), /ESTATE_UNIT_PIN_MISMATCH/u);
});
