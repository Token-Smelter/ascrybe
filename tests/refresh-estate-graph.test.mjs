// tools/refresh-estate-graph.mjs: the supported update procedure as ONE command (operator
// directive) -- extract, reuse documentary answers from a named prior journal, --require-model
// coverage always on, bind, project, and optionally stage (never promote). Composes three
// already-tested primitives (runSemanticMap, writeOfflineProjectionArtifact, projectEstateMap)
// rather than reimplementing any of them, so this file proves the COMPOSITION and the combined
// receipt, not each primitive's own behavior again. Every name is invented (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshEstateGraph } from '../tools/refresh-estate-graph.mjs';
import { buildExtractionPrompt, windowDocument } from '../tools/semantic-claim-extractor.mjs';
import { sha256 } from '../tools/lib.mjs';

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

const MODEL = 'invented-provider/primary-6';
const OTHER_MODEL = 'invented-provider/primary-5';
const DOC_CONTENT = '# Design\n\nThe cache never lies about its state.\n';

/** `validateConfiguredPiModels()` always spawns the REAL `pi --list-models` and checks the
 * configured model is in that real, live list -- it has no injection point (unlike the library
 * function itself, which does), so a real Pi installation would otherwise force this test to name a
 * REAL model route to pass. A tiny fake `pi` on PATH, listing only invented names, keeps every route
 * in this file invented instead. Restored in the caller's `finally`. */
function withFakePiOnPath(run) {
  const binDir = scratchDir('refresh-fake-pi-');
  const script = join(binDir, 'pi');
  writeFileSync(script, `#!/usr/bin/env bash\nif [ "$1" = "--list-models" ]; then\n  echo "invented-provider primary-5"\n  echo "invented-provider primary-6"\nfi\n`);
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  return run().finally(() => { process.env.PATH = originalPath; });
}

function buildFixtureRepo() {
  const repoDir = scratchDir('refresh-repo-');
  initRepo(repoDir);
  writeFileSync(join(repoDir, 'DESIGN.md'), DOC_CONTENT);
  const sha = commit(repoDir, 'add one documentary file');
  return { repoDir, sha };
}

function writeRuntimeConfig(dir) {
  const config = {
    schema: 'estate-map/runtime-config/v1',
    models: {
      documentary_claims: { runner: 'pi', name: MODEL, thinking: null, concurrency: 1,
        window_bytes: 4000, timeout_ms: 600000, max_event_bytes: 536870912, max_answer_bytes: 4194304 },
      code_claims: { runner: 'pi', name: MODEL, thinking: null, concurrency: 1,
        window_bytes: 4000, timeout_ms: 600000, max_event_bytes: 536870912, max_answer_bytes: 4194304 },
    },
    neo4j: { uri_env: 'ASCRYBE_NEO4J_URI', username_env: 'ASCRYBE_NEO4J_USERNAME', password_env: 'ASCRYBE_NEO4J_PASSWORD' },
    projection: { batch_size: 500, default_view: 'selected' },
    dashboard: { host: '127.0.0.1', port: 8790, neighbor_limit: 120, overview_limit: 100 },
  };
  const path = join(dir, 'runtime-config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function writeProjectConfig(dir, sha) {
  const config = { project_id: 'refresh-fixture', sha, documentary_paths: ['DESIGN.md'] };
  const path = join(dir, 'project-config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** A retained journal with exactly one usable answer for DESIGN.md's one window, so the whole run
 * is journal-served -- zero live model calls, deterministic, fast. */
function writeRetainedJournal(dir) {
  const [window] = windowDocument({ path: 'DESIGN.md', content: DOC_CONTENT });
  const prompt = buildExtractionPrompt({ window });
  const path = join(dir, 'retained.jsonl');
  appendFileSync(path, `${JSON.stringify({
    prompt_digest: sha256(prompt), outcome: 'ok', model: MODEL,
    usage: { cost: 0.001, cost_reported: true },
    answer: { claims: [{ statement: 'The cache never lies about its state.', claim_kind: 'current_capability',
      source_status: 'current', decision_status: 'accepted', line: 3, quote: 'The cache never lies about its state.' }] },
  })}\n`);
  return path;
}

test('refresh composes extract+reuse+bind+project into one receipt naming reused vs paid', async () => {
  const root = scratchDir('refresh-e2e-');
  await withFakePiOnPath(async () => {
    const { repoDir, sha } = buildFixtureRepo();
    const runtimeConfigPath = writeRuntimeConfig(root);
    const configPath = writeProjectConfig(root, sha);
    const journalPath = writeRetainedJournal(root);
    const outputDir = join(root, 'out');

    const { receipt } = await refreshEstateGraph({
      repository: repoDir, config_path: configPath, runtime_config_path: runtimeConfigPath,
      reuse_journals: [{ label: 'prior', path: journalPath, model: MODEL }],
      output_dir: outputDir, scratch_dir: join(root, 'scratch'),
    });

    assert.equal(receipt.windows.answered_by_reuse, 1, 'the one window must be served from the retained journal');
    assert.equal(receipt.windows.answered_by_new_dispatch, 0, 'zero live calls for a fully journal-served run');
    assert.deepEqual(receipt.model_coverage, {
      expected_model: MODEL, answered_by_expected_model: 1, answered_by_other_model: 0, answered_by_unknown_model: 0,
    });
    assert.equal(receipt.cost_usd.reused_already_paid, 0.001);
    assert.equal(receipt.cost_usd.marginal_this_run, 0);
    assert.ok(receipt.projection.projection_id.startsWith('estate-projection:'));
    assert.equal(receipt.staged, null, 'no --stage-runtime-config given: staging must be skipped, not silently attempted');

    const written = JSON.parse(readFileSync(join(outputDir, 'refresh-receipt.json'), 'utf8'));
    assert.equal(written.receipt_digest, receipt.receipt_digest);
  });
});

test('refresh derives a real, non-null code graph by default -- not silently null', async () => {
  const root = scratchDir('refresh-code-graph-');
  await withFakePiOnPath(async () => {
    // A fixture with an actual symbol, not only a markdown document -- proving the code graph
    // carries real structural content, not merely a non-crashing empty one.
    const repoDir = scratchDir('refresh-code-repo-');
    initRepo(repoDir);
    writeFileSync(join(repoDir, 'DESIGN.md'), DOC_CONTENT);
    writeFileSync(join(repoDir, 'widget.py'), 'def render_widget():\n    return "ok"\n');
    const sha = commit(repoDir, 'add a documentary file and a real source file');
    const runtimeConfigPath = writeRuntimeConfig(root);
    const configPath = writeProjectConfig(root, sha);
    const journalPath = writeRetainedJournal(root);
    const outputDir = join(root, 'out');

    const { receipt } = await refreshEstateGraph({
      repository: repoDir, config_path: configPath, runtime_config_path: runtimeConfigPath,
      reuse_journals: [{ label: 'prior', path: journalPath, model: MODEL }],
      output_dir: outputDir, scratch_dir: join(root, 'scratch'),
    });

    assert.equal(receipt.mode, 'full_software_graph');
    assert.equal(receipt.code_graph.present, true);
    assert.equal(receipt.code_graph.derived, true);
    assert.ok(receipt.code_graph.digest, 'a real code graph must carry a non-null digest');
    assert.ok(receipt.code_graph.counts.candidates > 0, 'widget.py\'s own symbol must have become a real identity candidate');

    const written = JSON.parse(readFileSync(join(outputDir, 'refresh-receipt.json'), 'utf8'));
    assert.equal(written.code_graph.digest, receipt.code_graph.digest);
    // The projection actually consumed the derived code graph, not merely computed its digest for
    // the receipt and discarded it -- proven against the offline projection's own persisted receipt.
    const offlineReceipt = JSON.parse(readFileSync(join(outputDir, 'projection', 'offline-projection-receipt.json'), 'utf8'));
    assert.equal(offlineReceipt.source_artifacts.code_graph_digest, receipt.code_graph.digest);
  });
});

test('refresh --documentary-only explicitly skips the code graph, never silently', async () => {
  const root = scratchDir('refresh-doc-only-');
  await withFakePiOnPath(async () => {
    const { repoDir, sha } = buildFixtureRepo();
    const runtimeConfigPath = writeRuntimeConfig(root);
    const configPath = writeProjectConfig(root, sha);
    const journalPath = writeRetainedJournal(root);
    const outputDir = join(root, 'out');

    const { receipt } = await refreshEstateGraph({
      repository: repoDir, config_path: configPath, runtime_config_path: runtimeConfigPath,
      reuse_journals: [{ label: 'prior', path: journalPath, model: MODEL }],
      output_dir: outputDir, scratch_dir: join(root, 'scratch'), documentary_only: true,
    });

    assert.equal(receipt.mode, 'documentary_only');
    assert.deepEqual(receipt.code_graph, { present: false, path: null, digest: null, derived: false, counts: null });
  });
});

test('refresh refuses documentary_only combined with an explicit code_graph_path -- one caller, one clear intent', async () => {
  const root = scratchDir('refresh-conflicting-mode-');
  await withFakePiOnPath(async () => {
    const { repoDir, sha } = buildFixtureRepo();
    const runtimeConfigPath = writeRuntimeConfig(root);
    const configPath = writeProjectConfig(root, sha);
    const journalPath = writeRetainedJournal(root);

    await assert.rejects(
      () => refreshEstateGraph({
        repository: repoDir, config_path: configPath, runtime_config_path: runtimeConfigPath,
        reuse_journals: [{ label: 'prior', path: journalPath, model: MODEL }],
        output_dir: join(root, 'out'), scratch_dir: join(root, 'scratch'),
        documentary_only: true, code_graph_path: '/tmp/whatever-adjacency.json',
      }),
      { code: 'REFRESH_INPUT_INVALID' });
  });
});

test('refresh always requires single-model coverage, even when the caller never asks for it', async () => {
  const root = scratchDir('refresh-model-drift-');
  await withFakePiOnPath(async () => {
    const { repoDir, sha } = buildFixtureRepo();
    const runtimeConfigPath = writeRuntimeConfig(root);
    const configPath = writeProjectConfig(root, sha);
    // A retained journal answered by a DIFFERENT model than the runtime config's documentary_claims
    // role names -- refresh must refuse this outright, unconditionally, the way a caller of
    // extractSemanticClaims would only get by passing require_model: true explicitly.
    const [window] = windowDocument({ path: 'DESIGN.md', content: DOC_CONTENT });
    const journalPath = join(root, 'other-model.jsonl');
    appendFileSync(journalPath, `${JSON.stringify({
      prompt_digest: sha256(buildExtractionPrompt({ window })), outcome: 'ok', model: OTHER_MODEL,
      usage: { cost: 0.001, cost_reported: true },
      answer: { claims: [] },
    })}\n`);

    await assert.rejects(
      () => refreshEstateGraph({
        repository: repoDir, config_path: configPath, runtime_config_path: runtimeConfigPath,
        reuse_journals: [{ label: 'other', path: journalPath }], // no @model scope: loads permissively, then require_model catches the drift
        output_dir: join(root, 'out'), scratch_dir: join(root, 'scratch'),
      }),
      { code: 'SEMANTIC_EXTRACTION_MODEL_COVERAGE' });
  });
});
