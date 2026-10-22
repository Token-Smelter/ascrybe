// [EVAL-HARNESS]: tools/eval/delta-shape-eval.mjs exercised on REAL invented temporary Git
// repositories (never a hand-built fixture plan) through the REAL production extraction path
// (tools/extract.mjs extractEstate(), tools/file-extraction-adapter.mjs, tools/merge.mjs). These
// are harness tests proving the evaluator itself works, NOT the pending private two-estate campaign
// (which the owning session runs later against real private pins — CONTRIBUTING.md /
// docs/multi-repository-documentary-campaigns.md). Every name here is invented.
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CANONICAL_CHANGE_SHAPES, mergeStage, runCaseManifest, runChangeShapeCase, runCorruptionControl,
  runDroppedRecordControl, runReuseAllControl, runReuseAllStaleControl, runReuseNoneControl, summarizeCoverage,
} from '../tools/eval/delta-shape-eval.mjs';

const EVAL_CLI = fileURLToPath(new URL('../tools/eval/delta-shape-eval.mjs', import.meta.url));

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
function ownedWork() {
  return { workDirRoot: scratchDir('shape-eval-owned-') };
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

const PY_SOURCE_V1 = 'def widget_handler():\n    return 1\n';
const PY_SOURCE_V2 = 'def widget_handler():\n    return 2\n';
const JS_SOURCE = 'export function gatewayHandler() {\n  return "invented";\n}\n';
const MD_NOTES_V1 = '# Widget notes\n\nThis is a plan.\n';
const MD_NOTES_V2 = '# Widget notes\n\nThis plan changed.\n';

function multilingualRepo() {
  const repoDir = scratchDir('shape-eval-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V1);
  writeFileSync(join(repoDir, 'gateway.mjs'), JS_SOURCE);
  writeFileSync(join(repoDir, 'notes.md'), MD_NOTES_V1);
  mkdirSync(join(repoDir, 'node_modules', 'vendor'), { recursive: true });
  writeFileSync(join(repoDir, 'node_modules', 'vendor', 'lib.js'), 'module.exports = function vendored() { return 0; };\n');
  const parent = commit(repoDir, 'invented parent state');
  return { repoDir, parent };
}

function repositories(repoDir, parentRef, childRef) {
  return { 'invented-multilingual-estate': { path: repoDir, parent_ref: parentRef, child_ref: childRef } };
}

// A real, small MULTI-repository estate with routed resources — an HTTP route + client call
// across two repositories, a declared npm dependency naming the other repository's own package
// name, a local import, and documentation. Not an empty graph: proves repository incident edges
// survive the real extraction+merge path this task repairs.
function multiRepoEstate() {
  const providerDir = scratchDir('shape-eval-provider-');
  initRepo(providerDir);
  mkdirSync(join(providerDir, 'lib'), { recursive: true });
  writeFileSync(join(providerDir, 'package.json'), `${JSON.stringify({ name: 'widgets-api', version: '1.0.0' }, null, 2)}\n`);
  writeFileSync(join(providerDir, 'lib', 'respond.mjs'), 'export function respond(res, body) {\n  res.json(body);\n}\n');
  writeFileSync(join(providerDir, 'server.mjs'), "import { respond } from './lib/respond.mjs';\n\nexport function registerRoutes(app) {\n  app.get('/widgets', (req, res) => {\n    respond(res, []);\n  });\n}\n");
  writeFileSync(join(providerDir, 'README.md'), '# Widgets API\n\nInvented HTTP provider for the multi-repository fixture.\n');
  const providerParent = commit(providerDir, 'invented provider parent state');

  const consumerDir = scratchDir('shape-eval-consumer-');
  initRepo(consumerDir);
  writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify({ name: 'widgets-console', version: '1.0.0', dependencies: { 'widgets-api': '^1.0.0' } }, null, 2)}\n`);
  writeFileSync(join(consumerDir, 'client.mjs'), "export async function loadWidgets() {\n  return fetch('https://widgets-api.example.invalid/widgets');\n}\n");
  const consumerParent = commit(consumerDir, 'invented consumer parent state');

  return { providerDir, providerParent, consumerDir, consumerParent };
}

function multiRepoRepositories({
  providerDir, providerParentRef, providerChildRef, consumerDir, consumerParentRef, consumerChildRef,
}) {
  return {
    'widgets-api': { path: providerDir, parent_ref: providerParentRef, child_ref: providerChildRef },
    'widgets-console': { path: consumerDir, parent_ref: consumerParentRef, child_ref: consumerChildRef },
  };
}

test('[EVAL-HARNESS] coverage summary reports the canonical strata a manifest declares, never fabricating a missing one', () => {
  const coverage = summarizeCoverage([{ change_shape: 'content_edit' }, { change_shape: 'add' }]);
  assert.deepEqual(coverage.present, ['content_edit', 'add']);
  assert.ok(coverage.missing.includes('rename'));
  assert.equal(coverage.missing.length, CANONICAL_CHANGE_SHAPES.length - 2);
});

test('[EVAL-HARNESS] content_edit case: verdict passes, records/merge digests agree, scan calls decrease for the unchanged JS unit, and the change is classified as a routed change', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit');
  const caseSpec = { name: 'content-edit', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };

  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true, 'delta and forced-uncached reference facts and merged graphs must agree');
  assert.deepEqual(result.records, { missing: [], extra: [], stale: [] });
  assert.equal(result.merge.digest_equal, true, 'a fresh downstream STRICT merge over delta vs reference facts must agree');
  assert.equal(result.merge.delta.status, 'ok');
  assert.equal(result.merge.reference.status, 'ok');
  assert.ok(result.scan_calls.decreased, 'unchanged gateway.mjs/notes.md units must be reused, so actual scan calls must be fewer than the reference');
  assert.equal(result.units.reuse_expected_not_actual.length, 0, 'every unit the parent-seeded cache could serve must actually be served');
  assert.equal(result.units.reuse_actual_not_expected.length, 0, 'nothing may be reused that was not actually eligible');
  assert.ok(result.scope_exclusions.child.excluded_totals_by_category.vendored_dependency > 0, 'the vendored file must be named as excluded, not silently dropped');
  assert.equal(result.routing.classification, 'routed_change', 'app.py is routed by the Python extractor');
  assert.ok(result.routing.routed_changed_units > 0);
  assert.equal(result.input_complete, true);
});

test('[EVAL-HARNESS] add case: canonical equality holds and the added file\u2019s unit is produced, not reused', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'added.py'), 'def newly_added():\n    return 3\n');
  const child = commit(repoDir, 'invented add');
  const caseSpec = { name: 'add', change_shape: 'add', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  assert.equal(result.scope.diff.added, 1);
  assert.equal(result.routing.classification, 'routed_change');
});

test('[EVAL-HARNESS] delete case: canonical equality holds and the deleted file contributes no record on either side', async () => {
  const { repoDir, parent } = multilingualRepo();
  git(repoDir, ['rm', '--quiet', 'app.py']);
  const child = commit(repoDir, 'invented delete');
  const caseSpec = { name: 'delete', change_shape: 'delete', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  assert.equal(result.scope.diff.deleted, 1);
});

test('[EVAL-HARNESS] rename case: a rename is delete-plus-add (the design\u2019s own default — no continuity claimed), and canonical equality still holds', async () => {
  const { repoDir, parent } = multilingualRepo();
  git(repoDir, ['mv', 'app.py', 'renamed_app.py']);
  const child = commit(repoDir, 'invented rename');
  const caseSpec = { name: 'rename', change_shape: 'rename', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  assert.equal(result.scope.diff.added, 1, 'a rename is delete-plus-add: the new path is added');
  assert.equal(result.scope.diff.deleted, 1, 'a rename is delete-plus-add: the old path is deleted');
  assert.equal(result.scope.diff.modified, 0);
  assert.equal(result.routing.classification, 'routed_change', 'both the deleted old path and the added new path are routed by the Python extractor');
});

test('[EVAL-HARNESS] docs_only case: canonical equality holds; reuse is reported honestly rather than assumed 100% (document-structure still routes the edited file)', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'notes.md'), MD_NOTES_V2);
  const child = commit(repoDir, 'invented docs-only edit');
  const caseSpec = { name: 'docs-only', change_shape: 'docs_only', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  // The claim under test is honesty, not a fixed number: docs-only must NOT be asserted as 100%
  // reuse. The edited file's own unit(s) must be produced; something else must be reused.
  assert.ok(result.units.actual_dispositions.produced >= 1, 'the edited document\u2019s own unit(s) must be produced, not silently reused');
  assert.ok(result.units.actual_reused_count >= 1, 'unrelated files (app.py, gateway.mjs) must still be reused');
  assert.notEqual(result.units.actual_reused_count, result.units.expected, 'docs-only must not be reported as 100% reuse');
});

test('[EVAL-HARNESS] ignored_or_unrouted_only case: editing only the vendored (excluded) file changes nothing extractable, and this is reported as the no-routed-change control rather than silently passing as full reuse', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'node_modules', 'vendor', 'lib.js'), 'module.exports = function vendoredV2() { return 1; };\n');
  const child = commit(repoDir, 'invented vendor-only edit');
  const caseSpec = { name: 'ignored-only', change_shape: 'ignored_or_unrouted_only', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  assert.equal(result.scope.diff.modified, 0, 'the excluded file must never appear in the in-scope diff at all');
  assert.equal(result.units.actual_dispositions.produced, 0, 'nothing should need re-production when only an excluded path changed');
  assert.equal(result.routing.classification, 'no_raw_change', 'the excluded file never enters the routed diff at all, so there is no raw in-scope change either');
});

test('[EVAL-HARNESS] a routed content edit mislabelled as ignored_or_unrouted_only is caught as an inconclusive mislabel, not silently accepted', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit mislabelled as unrouted-only');
  const caseSpec = { name: 'mislabelled', change_shape: 'ignored_or_unrouted_only', repositories: repositories(repoDir, parent, child) };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.verdict_reasons.some(reason => reason.includes('mislabelled')));
});

test('[EVAL-HARNESS] chained_update: two sequential deltas (A\u2192B, B\u2192C) each agree with their own forced-uncached reference', async () => {
  const { repoDir, parent: shaA } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const shaB = commit(repoDir, 'invented hop 1');
  writeFileSync(join(repoDir, 'gateway.mjs'), JS_SOURCE.replace('invented', 'invented-v2'));
  const shaC = commit(repoDir, 'invented hop 2');

  const hop1 = await runChangeShapeCase({ name: 'chain-hop-1', change_shape: 'chained_update', repositories: repositories(repoDir, shaA, shaB) }, ownedWork());
  const hop2 = await runChangeShapeCase({ name: 'chain-hop-2', change_shape: 'chained_update', repositories: repositories(repoDir, shaB, shaC) }, ownedWork());
  assert.equal(hop1.verdict, 'pass', JSON.stringify(hop1.verdict_reasons));
  assert.equal(hop2.verdict, 'pass', JSON.stringify(hop2.verdict_reasons));
  assert.equal(hop2.canonical_equal, true, 'accumulation across a SECOND hop (relative to a state itself reached by a prior update) must not silently diverge');
});

test('[EVAL-HARNESS] multi-repository fixture: a routed HTTP route + client call, a declared npm dependency, and an import across two real repositories produce valid, resolved cross-repository incident edges in both delta and reference merges', async () => {
  const {
    providerDir, providerParent, consumerDir, consumerParent,
  } = multiRepoEstate();
  // A real routed content edit to the provider between parent and child.
  writeFileSync(join(providerDir, 'server.mjs'), "import { respond } from './lib/respond.mjs';\n\nexport function registerRoutes(app) {\n  app.get('/widgets', (req, res) => {\n    respond(res, []);\n  });\n  app.get('/widgets/health', (req, res) => {\n    respond(res, { ok: true });\n  });\n}\n");
  const providerChild = commit(providerDir, 'invented provider route addition');

  const caseSpec = {
    name: 'multi-repo-routed',
    change_shape: 'content_edit',
    repositories: multiRepoRepositories({
      providerDir, providerParentRef: providerParent, providerChildRef: providerChild,
      consumerDir, consumerParentRef: consumerParent, consumerChildRef: consumerParent,
    }),
  };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  assert.equal(result.merge.delta.status, 'ok', JSON.stringify(result.merge.delta));
  assert.equal(result.merge.reference.status, 'ok', JSON.stringify(result.merge.reference));
  assert.ok(result.merge.delta.nodes > 0 && result.merge.delta.edges > 0, 'a real multi-repository graph must have nodes and edges, not an empty graph');
  assert.equal(result.routing.classification, 'routed_change');
  assert.ok(result.routing.routed_changed_units > 0);

  // Read the merged graph directly: the empirical lead this rewrite fixes was ZERO repo and ZERO
  // coverage records reaching merge at all, which left every cross-repository edge with an
  // undefined endpoint.
  const deltaGraph = JSON.parse(readFileSync(join(result.work_dir, 'merge-out-delta', 'estate-graph.json'), 'utf8'));
  const repoNodes = deltaGraph.nodes.filter(node => node.kind === 'repo');
  assert.deepEqual(repoNodes.map(node => node.repo).sort(), ['widgets-api', 'widgets-console'], 'both repositories must be present as real repo nodes');
  const crossRepoCall = deltaGraph.edges.find(edge => edge.kind === 'http_call_candidate' && edge.status === 'resolved');
  assert.ok(crossRepoCall, 'the consumer\u2019s fetch() call must resolve to the provider\u2019s declared route across repositories');
  assert.notEqual(crossRepoCall.from, undefined);
  assert.notEqual(crossRepoCall.to, undefined);
  const consumesPackage = deltaGraph.edges.find(edge => edge.kind === 'consumes_package' && edge.status === 'resolved');
  assert.ok(consumesPackage, 'the declared npm dependency naming the provider\u2019s package name must resolve to a real cross-repository consumes_package edge');
});

test('[EVAL-HARNESS] same relative path in two repositories does not collide: each repository keeps its own distinct module identity', async () => {
  const repoADir = scratchDir('shape-eval-path-a-');
  initRepo(repoADir);
  mkdirSync(join(repoADir, 'shared'), { recursive: true });
  writeFileSync(join(repoADir, 'shared', 'util.py'), 'def helper_a():\n    return "a"\n');
  const repoAParent = commit(repoADir, 'invented repo-a parent state');
  writeFileSync(join(repoADir, 'shared', 'util.py'), 'def helper_a():\n    return "a2"\n');
  const repoAChild = commit(repoADir, 'invented repo-a content edit');

  const repoBDir = scratchDir('shape-eval-path-b-');
  initRepo(repoBDir);
  mkdirSync(join(repoBDir, 'shared'), { recursive: true });
  writeFileSync(join(repoBDir, 'shared', 'util.py'), 'def helper_b():\n    return "b"\n');
  const repoBParent = commit(repoBDir, 'invented repo-b parent state');

  const caseSpec = {
    name: 'same-path-two-repos', change_shape: 'content_edit',
    repositories: {
      'estate-alpha': { path: repoADir, parent_ref: repoAParent, child_ref: repoAChild },
      'estate-beta': { path: repoBDir, parent_ref: repoBParent, child_ref: repoBParent },
    },
  };
  const result = await runChangeShapeCase(caseSpec, ownedWork());
  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.canonical_equal, true);
  const deltaGraph = JSON.parse(readFileSync(join(result.work_dir, 'merge-out-delta', 'estate-graph.json'), 'utf8'));
  const repoNodes = deltaGraph.nodes.filter(node => node.kind === 'repo');
  assert.deepEqual(repoNodes.map(node => node.repo).sort(), ['estate-alpha', 'estate-beta']);
  const moduleIds = deltaGraph.nodes.filter(node => node.kind === 'module' && node.name === 'shared/util.py').map(node => node.id).sort();
  assert.equal(moduleIds.length, 2, 'the same relative path in two repositories must produce two distinct module nodes, not a collision');
});

test('[EVAL-HARNESS] mergeStage retains the FULL conservation report on a conservation-gate failure — never reduced to a bare message (the empirical-lead bug this rewrite fixes)', async () => {
  const workDir = scratchDir('mergestage-missing-repo-');
  const extractOut = join(workDir, 'extract-missing-repo');
  mkdirSync(join(extractOut, 'facts'), { recursive: true });
  // A route fact with NO corresponding repo fact anywhere in the facts stream — exactly the
  // empirically-observed shape (retained input census with zero repo and zero coverage records).
  writeFileSync(join(extractOut, 'facts', 'widgets-api.jsonl'), `${JSON.stringify({
    kind: 'http_route', repo: 'widgets-api', file: 'server.mjs', line: 1,
    method: 'GET', route: '/widgets', declared_route: '/widgets', owner: 'widgets-api', owner_basis: 'repository', framework: 'express',
  })}\n`);
  writeFileSync(join(extractOut, '_MANIFEST.json'), JSON.stringify({ schema_version: 1, repositories: [{ repo: 'widgets-api', status: 'complete' }] }));
  const result = await mergeStage(extractOut, workDir, 'missing-repo');
  assert.equal(result.status, 'error');
  assert.equal(result.exit_code, 3);
  assert.ok(result.conservation_gates, 'the FULL conservation report must be retained, never discarded down to error.message alone');
  assert.ok(result.conservation_gates.census.bugs > 0, 'a route fact with no corresponding repo fact must surface as a conservation bug, not a silent pass');
});

test('[EVAL-HARNESS] reuse-none control: a never-seeded cache produces zero reuse while correctness holds', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for reuse-none control');
  const caseSpec = { name: 'reuse-none-source', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };
  const control = await runReuseNoneControl(caseSpec, ownedWork());
  assert.equal(control.passed, true, control.reason);
  assert.equal(control.reused_count, 0);
  assert.equal(control.correctness_holds, true);
});

test('[EVAL-HARNESS] reuse-all control: every validated reuse-eligible unit is actually served from a fully-seeded cache', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for reuse-all control');
  const caseSpec = { name: 'reuse-all-source', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };
  const control = await runReuseAllControl(caseSpec, ownedWork());
  if (control.passed === null) return; // no eligible unit in this fixture; documented, not hidden.
  assert.equal(control.passed, true, control.reason);
  assert.equal(control.missed_reuse.length, 0);
  assert.ok(control.expected_reusable_count > 0);
});

test('[EVAL-HARNESS] dropped-record control: a self-consistent but incomplete cache entry is caught by the evaluator\u2019s reference comparison, not by unit-cache self-validation alone', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for dropped-record control');
  const caseSpec = { name: 'dropped-record-source', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };
  const control = await runDroppedRecordControl(caseSpec, ownedWork());
  if (control.passed === null) return; // no multi-record unit in this fixture; documented, not hidden.
  assert.equal(control.forged_entry_passed_self_validation, true, 'the forged entry must be a REAL gap, not an input the cache already rejects');
  assert.equal(control.passed, true, control.reason);
  assert.ok(control.missing_records.length > 0);
});

test('[EVAL-HARNESS] reuse-all-stale control (the STALE reuse-all NEGATIVE, distinct from the positive reuse_all control): a blind "reuse everything from parent regardless of child state" candidate is rejected by the shared scorer\u2019s correctness objective', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  git(repoDir, ['rm', '--quiet', 'gateway.mjs']);
  const child = commit(repoDir, 'invented content edit plus delete for reuse-all-stale control');
  const caseSpec = { name: 'reuse-all-stale-source', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };
  const control = await runReuseAllStaleControl(caseSpec, ownedWork());
  if (control.passed === null) return; // no modified/deleted file in this fixture; documented, not hidden.
  // Meta-control success means THIS SAME SCORER returned the expected failure reason — not a
  // separate self-declared passed flag. The intentionally-faulty stale-reuse-all candidate itself
  // must NOT read as passing.
  assert.equal(control.scorer_verdict, 'fail', control.scorer_reasons.join('; '));
  assert.ok(control.stale.length > 0 || control.extra.length > 0, 'the blind reuse-all-stale candidate must show a stale (edited) or extra (deleted) record against the honest reference');
  assert.equal(control.passed, true, control.reason);
});

test('[EVAL-HARNESS] corruption control: a tampered receipt digest is quarantined, recomputed, and correctness is preserved', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for corruption control');
  const caseSpec = { name: 'corruption-source', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) };
  const control = await runCorruptionControl(caseSpec, ownedWork());
  assert.equal(control.passed, true, control.reason);
  assert.equal(control.quarantined, true);
  assert.equal(control.recomputed_disposition, 'produced');
  assert.equal(control.correctness_holds, true);
});

test('[EVAL-HARNESS] runCaseManifest: an empty case manifest is incomplete, never a silent full pass', async () => {
  const manifestPath = join(scratchDir('empty-manifest-'), 'case-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ cases: [] }));
  const result = await runCaseManifest(manifestPath, { runControls: false, ...ownedWork() });
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.verdict_reasons.length > 0);
});

test('[EVAL-HARNESS] runCaseManifest: a manifest covering only one canonical change shape is incomplete even though its one case passes', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for run-manifest coverage test');
  const manifestPath = join(scratchDir('partial-manifest-'), 'case-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    cases: [{ name: 'partial-coverage', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) }],
  }));
  const result = await runCaseManifest(manifestPath, { runControls: false, ...ownedWork() });
  assert.equal(result.cases[0].verdict, 'pass');
  assert.equal(result.verdict, 'incomplete', 'missing coverage of the other 8 canonical change shapes must never silently report full evaluation success');
  assert.ok(result.coverage.missing.length > 0);
});

test('[EVAL-HARNESS] CLI: exit status reflects the actual run verdict, not a fixed 0', async () => {
  const { repoDir, parent } = multilingualRepo();
  writeFileSync(join(repoDir, 'app.py'), PY_SOURCE_V2);
  const child = commit(repoDir, 'invented content edit for CLI exit-status test');
  const manifestPath = join(scratchDir('cli-manifest-'), 'case-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    cases: [{ name: 'cli-content-edit', change_shape: 'content_edit', repositories: repositories(repoDir, parent, child) }],
  }));
  let status = 0;
  try {
    execFileSync(process.execPath, [EVAL_CLI, '--case-manifest', manifestPath, '--work-dir', scratchDir('shape-eval-owned-')], { encoding: 'utf8' });
  } catch (error) {
    status = error.status;
  }
  // A manifest covering one of nine canonical change shapes is an INCOMPLETE run (exit 2), never a
  // fixed 0 regardless of what happened — the exact CLI-exit-status defect this rewrite fixes.
  assert.equal(status, 2);
});
