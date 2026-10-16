// [STATEFUL-CHAIN]: tools/eval/delta-chain-eval.mjs exercised against REAL, invented, temporary
// multi-repository Git fixtures through the REAL production extraction path (tools/extract.mjs
// extractEstate()) — never a hand-built fixture plan. Every repository/file/function name here is
// invented (CONTRIBUTING.md).
import { fixtureScope, fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAIN_CACHE_STATE_SCHEMA, runChainCase, validateChainState, writeChainState,
} from '../tools/eval/delta-chain-eval.mjs';

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

// --- validateChainState: the guard mechanism, unit-tested directly against fabricated mismatches
// so each failure mode is proven without needing a full chain run per case. ------------------------

test('[STATEFUL-CHAIN] validateChainState accepts a genuinely matching predecessor state', () => {
  const cacheRoot = scratchDir('chain-state-ok-');
  writeChainState(cacheRoot, {
    schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: 'invented-chain', step_index: 0, label: 'A', pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
  });
  assert.doesNotThrow(() => validateChainState(cacheRoot, {
    chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
  }));
});

test('[STATEFUL-CHAIN] validateChainState refuses a cache that was never seeded by any chain (a fresh cache silently replacing state)', () => {
  const cacheRoot = scratchDir('chain-state-fresh-');
  assert.throws(
    () => validateChainState(cacheRoot, {
      chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
    }),
    /no valid chain state/,
  );
});

test('[STATEFUL-CHAIN] validateChainState refuses a cache seeded by a DIFFERENT chain', () => {
  const cacheRoot = scratchDir('chain-state-foreign-');
  writeChainState(cacheRoot, {
    schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: 'some-other-chain', step_index: 0, label: 'A', pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
  });
  assert.throws(
    () => validateChainState(cacheRoot, {
      chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
    }),
    /refusing to continue from a foreign chain's cache/,
  );
});

test('[STATEFUL-CHAIN] validateChainState refuses a chain-position mismatch (e.g. a fresh B seed silently skipping ahead)', () => {
  const cacheRoot = scratchDir('chain-state-position-');
  writeChainState(cacheRoot, {
    schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: 'invented-chain', step_index: 5, label: 'F', pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
  });
  assert.throws(
    () => validateChainState(cacheRoot, {
      chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
    }),
    /chain position mismatch/,
  );
});

test('[STATEFUL-CHAIN] validateChainState refuses an adjacent pin-identity mismatch (the recorded state does not match the actual preceding step)', () => {
  const cacheRoot = scratchDir('chain-state-pins-');
  writeChainState(cacheRoot, {
    schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: 'invented-chain', step_index: 0, label: 'A', pins: { alpha: 'stale-pin' }, producer_registry_digest: 'digest-1',
  });
  assert.throws(
    () => validateChainState(cacheRoot, {
      chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'digest-1',
    }),
    /adjacent pin identity failed/,
  );
});

test('[STATEFUL-CHAIN] validateChainState refuses a producer/config identity mismatch', () => {
  const cacheRoot = scratchDir('chain-state-producer-');
  writeChainState(cacheRoot, {
    schema: CHAIN_CACHE_STATE_SCHEMA, chain_name: 'invented-chain', step_index: 0, label: 'A', pins: { alpha: 'deadbeef' }, producer_registry_digest: 'old-digest',
  });
  assert.throws(
    () => validateChainState(cacheRoot, {
      chain_name: 'invented-chain', previous_step_index: 0, previous_pins: { alpha: 'deadbeef' }, producer_registry_digest: 'new-digest',
    }),
    /producer\/config identity mismatch/,
  );
});

// --- Full multi-repository A->B->C chain, driven through the real extraction path -----------------

function multiRepoChainFixture() {
  const alphaDir = scratchDir('chain-alpha-');
  initRepo(alphaDir);
  mkdirSync(join(alphaDir, 'handlers'), { recursive: true });
  writeFileSync(join(alphaDir, 'handlers', 'widget.py'), 'def widget_stage_one():\n    return 1\n');
  const shaAlphaA = commit(alphaDir, 'invented chain alpha step A');
  git(alphaDir, ['rm', '--quiet', 'handlers/widget.py']);
  const shaAlphaB = commit(alphaDir, 'invented chain alpha step B: delete widget.py');
  mkdirSync(join(alphaDir, 'handlers'), { recursive: true });
  writeFileSync(join(alphaDir, 'handlers', 'widget.py'), 'def widget_stage_two():\n    return 2\n');
  const shaAlphaC = commit(alphaDir, 'invented chain alpha step C: re-add widget.py with different content');

  const betaDir = scratchDir('chain-beta-');
  initRepo(betaDir);
  mkdirSync(join(betaDir, 'lib'), { recursive: true });
  writeFileSync(join(betaDir, 'lib', 'format.mjs'), 'export function formatConstant() {\n  return "invented-constant";\n}\n');
  writeFileSync(join(betaDir, 'lib', 'parse.mjs'), 'export function parseStageOne() {\n  return "parse-v1";\n}\n');
  const shaBetaA = commit(betaDir, 'invented chain beta step A');
  const shaBetaB = shaBetaA; // beta does not advance at hop A->B: format.mjs and parse.mjs stay identical.
  writeFileSync(join(betaDir, 'lib', 'parse.mjs'), 'export function parseStageTwo() {\n  return "parse-v2";\n}\n');
  const shaBetaC = commit(betaDir, 'invented chain beta step C: edit parse.mjs only');

  return {
    repositories: { 'invented-chain-alpha': { path: alphaDir }, 'invented-chain-beta': { path: betaDir } },
    steps: [
      { label: 'A', refs: { 'invented-chain-alpha': shaAlphaA, 'invented-chain-beta': shaBetaA } },
      { label: 'B', refs: { 'invented-chain-alpha': shaAlphaB, 'invented-chain-beta': shaBetaB } },
      { label: 'C', refs: { 'invented-chain-alpha': shaAlphaC, 'invented-chain-beta': shaBetaC } },
    ],
  };
}

function retainChainInputs(fixture, evidence) {
  const inputs = Object.entries(fixture.repositories).map(([name, repository]) => {
    const pins = [...new Set(fixture.steps.map(step => step.refs[name]))];
    const bundle = join(evidence, `${name}.bundle`);
    git(repository.path, ['bundle', 'create', bundle, '--all']);
    git(repository.path, ['bundle', 'verify', bundle]);
    const sha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    return { name, source: repository.path, bundle, sha256, pins: pins.map(pin => ({
      pin, commit: git(repository.path, ['cat-file', 'commit', pin]),
      tree: git(repository.path, ['ls-tree', '-r', pin]),
    })), diff: git(repository.path, ['diff', pins[0], pins.at(-1)]) };
  });
  writeFileSync(join(evidence, 'chain-inputs.json'), JSON.stringify(inputs, null, 2));
  return inputs;
}

function verifyRetainedInputs(t, inputs) {
  t.after(() => {
    const scope = fixtureScope({ source: import.meta.url, name: 'replay retained chain inputs' });
    let failed = true;
    try {
      assert.equal(inputs.reduce((count, input) => count + input.pins.length, 0), 5);
      for (const input of inputs) {
        assert.equal(existsSync(input.source), false, 'replay must not depend on the original checkout');
        assert.ok(existsSync(input.bundle), 'retained Git bundle must survive input teardown');
        const restored = scope.allocate(join(tmpdir(), 'chain-replay-'));
        initRepo(restored);
        git(restored, ['bundle', 'verify', input.bundle]);
        git(restored, ['fetch', input.bundle, 'refs/heads/main:refs/remotes/custody/main']);
        assert.equal(createHash('sha256').update(readFileSync(input.bundle)).digest('hex'), input.sha256);
        for (const { pin, commit, tree } of input.pins) {
          git(restored, ['checkout', '--quiet', '--detach', pin]);
          assert.deepEqual([git(restored, ['cat-file', 'commit', pin]), git(restored, ['ls-tree', '-r', pin])], [commit, tree]);
          for (const row of tree.trim().split('\n').filter(Boolean)) {
            const [metadata, path] = row.split('\t');
            assert.equal(readFileSync(join(restored, path), 'utf8'), git(restored, ['cat-file', 'blob', metadata.split(' ')[2]]));
          }
        }
        assert.equal(git(restored, ['diff', input.pins[0].pin, input.pins.at(-1).pin]), input.diff);
      }
      failed = false;
    } finally {
      const outcomes = scope.finish({ failed });
      assert.ok(outcomes.every(row => row.event === 'reclaimed'), JSON.stringify(outcomes));
    }
  });
}

test('[STATEFUL-CHAIN] a real A->B->C multi-repository chain seeds ONE owned cache exactly once and genuinely carries state hop to hop', async t => {
  const fixture = multiRepoChainFixture();
  // Evaluation outputs are durable evidence, unlike the disposable input repositories.
  const evidence = fixtureScope({ source: import.meta.url, name: 'durable chain evaluation' }).receiptDir;
  const inputs = retainChainInputs(fixture, evidence);
  verifyRetainedInputs(t, inputs);
  const result = await runChainCase({ name: 'invented-widget-chain', ...fixture }, { workDirRoot: evidence });
  writeFileSync(join(evidence, 'chain-result.json'), JSON.stringify(result, null, 2));

  assert.equal(result.verdict, 'pass', JSON.stringify(result.verdict_reasons));
  assert.equal(result.seed_count, 1, 'the chain cache must be seeded exactly once, from step A');
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].role, 'seed');
  assert.equal(result.steps[1].role, 'hop');
  assert.equal(result.steps[1].hop, 'A->B');
  assert.equal(result.steps[2].role, 'hop');
  assert.equal(result.steps[2].hop, 'B->C');

  // CACHE IDENTITY: each hop's "before" entry count must equal the immediately preceding step's
  // "after" count — the SAME cache object, not a fresh one. A silent reset at step 2 would break
  // this equality (the fresh cache would start back at 0 entries).
  assert.equal(result.steps[1].cache_entries_before, result.steps[0].cache_entries_after, 'hop A->B must continue the seed step\u2019s own cache, not a fresh one');
  assert.equal(result.steps[2].cache_entries_before, result.steps[1].cache_entries_after, 'hop B->C must continue hop A->B\u2019s own cache, not a fresh reseed of B');
  assert.ok(result.steps[2].cache_entries_after >= result.steps[1].cache_entries_after, 'the cache must only grow (or stay level), never shrink/reset');

  // ISOLATION: the forced-full reference arm at every hop must never read or warm the chain cache.
  assert.equal(result.steps[1].reference_touched_chain_cache, false);
  assert.equal(result.steps[2].reference_touched_chain_cache, false);

  // Both hops score PASS through the SAME shared case scorer.
  assert.equal(result.steps[1].scorer.verdict, 'pass', JSON.stringify(result.steps[1].scorer.reasons));
  assert.equal(result.steps[2].scorer.verdict, 'pass', JSON.stringify(result.steps[2].scorer.reasons));

  // TWO-HOP CARRIED REUSE: beta/lib/format.mjs never changes across A, B, or C. It must be served
  // from cache at hop A->B AND survive to be served from cache again at hop B->C — real evidence
  // that the SAME cache (not a fresh reseed from B) is what hop B->C actually consumed.
  assert.ok(result.steps[1].units.actual_reused > 0, 'hop A->B must reuse at least the unchanged beta files');
  assert.ok(result.steps[2].units.actual_reused > 0, 'hop B->C must still reuse the file (format.mjs) that has been unchanged since step A');
  assert.ok(result.steps[2].scan_invocations.chain < result.steps[2].scan_invocations.reference, 'the chain arm must invoke fewer actual scans than the isolated forced-full reference at hop B->C');

  // DELETE/READD WITH DIFFERENT CONTENT: alpha/handlers/widget.py is deleted at B and re-added at C
  // with DIFFERENT content. It must be freshly produced (never falsely served from the step-A
  // entry that is still physically sitting, orphaned, in the cache) and reflect the NEW content.
  const chainFactsAlpha = readFileSync(join(result.steps[2].out_dir, 'facts', 'invented-chain-alpha.jsonl'), 'utf8');
  assert.ok(chainFactsAlpha.includes('widget_stage_two'), 'the re-added file\u2019s NEW content must appear in the chain arm\u2019s facts');
  assert.ok(!chainFactsAlpha.includes('widget_stage_one'), 'the pre-delete content must never leak back in as if it were current');

  // SECOND-HOP EDIT EXPOSING STALE STATE: beta/lib/parse.mjs is unchanged A->B, then edited B->C.
  // The chain arm must capture the NEW content, not the state B (or A) left behind.
  const chainFactsBeta = readFileSync(join(result.steps[2].out_dir, 'facts', 'invented-chain-beta.jsonl'), 'utf8');
  assert.ok(chainFactsBeta.includes('parseStageTwo'), 'the second-hop edit must be captured');
  assert.ok(!chainFactsBeta.includes('parseStageOne'), 'the pre-edit content must not survive as stale state');

  // Old isolated pair format vs this chain: this schema is genuinely distinct.
  assert.equal(result.schema, 'estate-map/delta-chain-eval-result/v1');
});
