// [SHARED-PATH] [INTEGRITY] [DEPENDENCIES]: `ascrybe update` (tools/delta-update-run.mjs) now
// builds its extractor registry through tools/file-extraction-adapter.mjs — the SAME function
// tools/extract.mjs calls — applies the SAME scan-scope exclusions the ordinary extract CLI's
// walk() applies, and resolves every repository's ref exactly ONCE per invocation instead of once
// per equivalence-oracle arm. Every repository/file name here is invented (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetGitRunnerForTests, __setGitRunnerForTests, planEstateUpdate, runUpdateCommand,
} from '../tools/delta-update-run.mjs';
import { extractEstate } from '../tools/extract.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function initRepo(dir) {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'nobody@example.invalid']);
  git(dir, ['config', 'user.name', 'Invented Committer']);
}
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
const REPO = 'invented-estate';
const pinManifestFor = (repository, path, ref) => ({ repositories: { [repository]: { path, ref } } });

test('[SHARED-PATH][INTEGRITY] ascrybe update applies the SAME name/pattern scan-scope exclusions as the ordinary extract CLI: a vendored dependency never becomes a delta unit', () => {
  const repoDir = scratchDir('delta-scope-repo-');
  initRepo(repoDir);
  mkdirSync(join(repoDir, 'node_modules', 'some-package'), { recursive: true });
  writeFileSync(join(repoDir, 'node_modules', 'some-package', 'index.js'), 'module.exports = function vendored() { return 1; };\n');
  writeFileSync(join(repoDir, 'app.mjs'), 'export function ownSource() { return 2; }\n');
  const sha = commit(repoDir, 'add a vendored dependency and one real source file');

  const build = planEstateUpdate({ pinManifest: pinManifestFor(REPO, repoDir, sha), mode: 'full' });
  const paths = build.plan.current_files.map(file => file.normalized_path);
  assert.ok(paths.includes('app.mjs'), 'real source must remain in scope');
  assert.ok(!paths.some(path => path.startsWith('node_modules/')), 'a vendored dependency directory must never become a delta unit');
  assert.ok(build.excluded_paths.some(entry => entry.category === 'vendored_dependency'), 'the exclusion must be named, not silent');
});

test('[SHARED-PATH] refs are resolved exactly ONCE per `ascrybe update` invocation, shared by the primary arm and the equivalence-oracle full arm', () => {
  const repoDir = scratchDir('delta-refonce-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'app.mjs'), 'export function ownSource() { return 1; }\n');
  commit(repoDir, 'add one real source file');
  const outDir = scratchDir('delta-refonce-out-');
  const pinManifestPath = join(scratchDir('delta-refonce-pins-'), 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { [REPO]: { path: repoDir, ref: 'main' } } }));

  let revParseCalls = 0;
  const real = execFileSync;
  __setGitRunnerForTests((gitDir, args) => {
    if (args[0] === 'rev-parse') revParseCalls += 1;
    return real('git', ['-C', gitDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  });
  try {
    const result = runUpdateCommand([
      '--pin-manifest', pinManifestPath, '--mode', 'delta', '--output', outDir,
    ]);
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    // Equivalence is required by default, which plans a SECOND (full) arm over the SAME resolved
    // inventory. Before this fix, each arm independently called `git rev-parse` per repository —
    // 2 calls for one repository. The fix shares one resolution across both arms.
    assert.equal(revParseCalls, 1, 'exactly one rev-parse per declared repository, regardless of how many arms plan from it');
  } finally {
    __resetGitRunnerForTests();
  }
});

test('[SHARED-PATH] the ordinary extract CLI (filesystem-sourced) and `ascrybe update` (Git-blob-sourced) extract byte-identical FACT CONTENT for the identical file bytes, via the one shared adapter', async () => {
  const source = 'export function widgetHandler() {\n  return "invented-widget-value";\n}\n';

  // Git-sourced path.
  const repoDir = scratchDir('delta-parity-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'widget.mjs'), source);
  const sha = commit(repoDir, 'add the invented widget module');
  const build = planEstateUpdate({ pinManifest: pinManifestFor(REPO, repoDir, sha), mode: 'full' });
  const gitFacts = build.plan.receipts.flatMap(receipt => receipt.output.records.map(record => record.normalized_record));

  // Filesystem-sourced path.
  const estateRoot = scratchDir('delta-parity-estate-');
  mkdirSync(join(estateRoot, REPO), { recursive: true });
  writeFileSync(join(estateRoot, REPO, 'widget.mjs'), source);
  const out = scratchDir('delta-parity-out-');
  await extractEstate(estateRoot, out, { strict: true });
  const fsFactsRaw = readFileSync(join(out, 'facts', `${REPO}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const fsFacts = fsFactsRaw.filter(fact => fact.kind !== 'repo' && fact.kind !== 'coverage');

  // `document_path` legitimately differs: tools/extract.mjs addresses a document ESTATE-relative
  // (an estate can compose several repositories under one root); tools/delta-update-run.mjs has no
  // encompassing estate root at all (one pinned Git repository per declared member) and addresses
  // a document repository-relative. That is a caller-supplied CONTEXT difference, not a fact-
  // content difference, so it is normalized out here rather than asserted equal.
  const normalize = facts => facts.map(fact => JSON.stringify({ ...fact, document_path: undefined })).sort();
  assert.deepEqual(normalize(gitFacts), normalize(fsFacts), 'the same file bytes routed through both call paths must produce identical fact content (document_path context aside)');
});
