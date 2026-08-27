#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return result.stdout.trimEnd();
}

function parseArguments(argv) {
  let root = defaultRoot;
  let receipt = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      if (!argv[index + 1]) fail('--root requires a value');
      root = resolve(argv[index + 1]);
      index += 1;
    } else if (!receipt) receipt = argv[index];
    else fail(`unknown argument: ${argv[index]}`);
  }
  if (!receipt) fail('usage: node scripts/validate-verification-receipt.mjs [--root <path>] <receipt.json>');
  return { root, receipt: isAbsolute(receipt) ? receipt : resolve(root, receipt) };
}

function resolveBinding(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function insidePath(parent, path) {
  const held = resolve(path);
  const root = resolve(parent);
  return held === root || held.startsWith(root + sep);
}

function assertIgnoredArtifact(root, path) {
  if (!insidePath(root, path)) return;
  const held = relative(root, path);
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', held], { cwd: root });
  if (result.status !== 0) fail(`verification artifact is not gitignored: ${held}`);
}

export function validateReceipt({ root, receipt: receiptPath }) {
  const bytes = readFileSync(receiptPath);
  let receipt;
  try { receipt = JSON.parse(bytes); }
  catch (error) { fail(`receipt is not valid JSON: ${error.message}`); }
  if (receipt.schema !== 'estate-map/verification-receipt/v2') fail(`unexpected schema: ${receipt.schema}`);
  const { receipt_digest: claimedDigest, ...body } = receipt;
  if (!digestPattern.test(claimedDigest || '')) fail('receipt_digest is missing or malformed');
  const observedDigest = sha256(`${JSON.stringify(body)}\n`);
  if (observedDigest !== claimedDigest) fail('receipt body digest mismatch; receipt bytes were edited or incompletely regenerated');
  if (receipt.commit?.head !== git(root, ['rev-parse', 'HEAD'])) fail('receipt commit differs from current HEAD');

  const identity = receipt.bindings?.common_repository_identity;
  const identityScheme = 'git-common-dir-realpath-v1';
  const currentCommonDir = realpathSync(git(root, [
    'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]));
  const currentSelectedWorktree = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  const currentIdentityDigest = sha256(`${identityScheme}\0${currentCommonDir}`);
  if (identity?.scheme !== identityScheme
    || identity?.common_dir !== currentCommonDir
    || identity?.digest !== currentIdentityDigest
    || identity?.selected_worktree !== currentSelectedWorktree
    || !Array.isArray(identity?.observed_worktree_roots)
    || !identity.observed_worktree_roots.includes(currentSelectedWorktree)) {
    fail('current Git common-dir identity differs from the receipt binding');
  }

  for (const name of ['runner', 'registry', 'expectations', 'live_profile']) {
    const binding = receipt.bindings?.[name];
    if (typeof binding?.path !== 'string' || !digestPattern.test(binding?.digest || '')) {
      fail(`${name} binding is missing or malformed`);
    }
    const currentDigest = sha256(readFileSync(resolveBinding(root, binding.path)));
    if (currentDigest !== binding.digest) fail(`${name} bytes differ from the receipt binding`);
  }
  if (receipt.provenance?.runner_digest !== receipt.bindings.runner.digest) {
    fail('runner provenance digest differs from the canonical runner binding');
  }

  const porcelain = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const trackedDiff = git(root, ['diff', '--binary', 'HEAD']);
  const currentWorktree = {
    state: porcelain ? 'dirty' : 'clean',
    porcelain_sha256: sha256(porcelain),
    tracked_diff_sha256: sha256(trackedDiff),
    entries: porcelain ? porcelain.split('\n') : [],
  };
  if (receipt.worktree?.state !== currentWorktree.state
    || receipt.worktree?.porcelain_sha256 !== currentWorktree.porcelain_sha256
    || receipt.worktree?.tracked_diff_sha256 !== currentWorktree.tracked_diff_sha256
    || JSON.stringify(receipt.worktree?.entries) !== JSON.stringify(currentWorktree.entries)) {
    fail('current worktree state, entries, or digests differ from the receipt binding');
  }

  const coverage = receipt.bindings?.gate_coverage;
  if (!Array.isArray(coverage?.inventory) || !digestPattern.test(coverage?.digest || '')) {
    fail('gate coverage binding is missing or malformed');
  }
  if (sha256(`${JSON.stringify(coverage.inventory)}\n`) !== coverage.digest) {
    fail('gate coverage inventory digest mismatch');
  }
  if (!Array.isArray(receipt.outcomes)
    || sha256(`${JSON.stringify(receipt.outcomes)}\n`) !== receipt.outcomes_digest) {
    fail('outcomes digest mismatch');
  }
  const outputRootBinding = receipt.artifacts?.output_root;
  if (typeof outputRootBinding !== 'string' || !outputRootBinding) {
    fail('captured output root binding is missing');
  }
  const outputRoot = resolveBinding(root, outputRootBinding);
  const seenOutputPaths = new Set();
  for (const outcome of receipt.outcomes) {
    for (const field of ['stdout_digest', 'stderr_digest', 'output_digest']) {
      if (!digestPattern.test(outcome?.[field] || '')) fail(`${outcome?.id || '<unknown>'} lacks ${field}`);
    }
    if (typeof outcome.executed !== 'boolean') fail(`${outcome?.id || '<unknown>'} lacks executed state`);
    if (!outcome.executed) {
      if (outcome.captured_output !== null) fail(`${outcome.id} has captured output despite not executing`);
      continue;
    }
    const captured = {};
    for (const stream of ['stdout', 'stderr']) {
      const binding = outcome.captured_output?.[stream];
      if (typeof binding?.path !== 'string' || !binding.path
        || !Number.isInteger(binding?.bytes) || binding.bytes < 0
        || !digestPattern.test(binding?.digest || '')) {
        fail(`${outcome.id} ${stream} output binding is missing or malformed`);
      }
      const path = resolveBinding(root, binding.path);
      if (!insidePath(outputRoot, path)) fail(`${outcome.id} ${stream} output is outside its artifact tree`);
      if (seenOutputPaths.has(path)) fail(`captured output path is reused: ${binding.path}`);
      seenOutputPaths.add(path);
      const outputBytes = readFileSync(path);
      if (outputBytes.length !== binding.bytes) fail(`${outcome.id} ${stream} output byte count mismatch`);
      if (sha256(outputBytes) !== binding.digest
        || binding.digest !== outcome[`${stream}_digest`]) {
        fail(`${outcome.id} ${stream} output digest mismatch`);
      }
      assertIgnoredArtifact(root, path);
      captured[stream] = outputBytes;
    }
    if (sha256(Buffer.concat([captured.stdout, Buffer.from('\n'), captured.stderr]))
      !== outcome.output_digest) {
      fail(`${outcome.id} combined output digest mismatch`);
    }
  }
  if (!receipt.provenance?.runner_digest || !digestPattern.test(receipt.provenance.runner_digest)
    || receipt.provenance.self_attested !== true) {
    fail('runner provenance is missing or not labeled self-attested');
  }
  if (!receipt.isolation?.self_attestation?.source
    || !Array.isArray(receipt.isolation?.claims_not_made)
    || !receipt.isolation.claims_not_made.includes('processes that start and finish between samples can be missed')
    || !receipt.isolation.claims_not_made.includes('non-observation of a matching process is not evidence of host quiescence')) {
    fail('isolation scope or observation disclaimer is missing');
  }
  const observations = receipt.isolation?.bounded_observations;
  if (!Array.isArray(observations?.samples)
    || observations.samples[0]?.point !== 'before'
    || observations.samples.at(-1)?.point !== 'after'
    || !Array.isArray(observations.limitations)
    || !observations.limitations.includes('processes that start and finish between samples can be missed')
    || !observations.limitations.includes('non-observation of a matching process is not evidence of host quiescence')
    || !observations.limitations.includes('Linux /proc may be unavailable or access-restricted on this platform')
    || !observations.limitations.includes('worktrees added after the receipt-bound git worktree inventory are outside these samples')
    || JSON.stringify(observations.observed_worktree_roots)
      !== JSON.stringify(identity.observed_worktree_roots)) {
    fail('bounded competitor observation scope or samples are malformed');
  }
  const observedCompetition = observations.samples.some(sample => sample.matching_process_count > 0);
  if (observedCompetition !== (receipt.isolation.competition_detected === true)) {
    fail('competition detection does not match bounded observations');
  }
  if (observedCompetition && (receipt.isolation.effective_state !== 'contaminated'
    || receipt.isolation.competition_override
      !== 'detected matching process overrides any exclusive self-attestation')) {
    fail('detected competition did not override isolation to contaminated');
  }
  if (receipt.runner_lock?.checks_executed > 0) {
    for (const outcome of receipt.outcomes) {
      if (!observations.samples.some(sample => sample.point === 'before_check'
        && sample.check_id === outcome.id)) {
        fail(`${outcome.id} lacks its bounded pre-check observation`);
      }
    }
  }
  if (!['acquired', 'timed_out'].includes(receipt.runner_lock?.state)
    || !Number.isInteger(receipt.runner_lock?.checks_executed)
    || !['git_common_dir_default', 'cli_override'].includes(receipt.runner_lock?.path_source)
    || receipt.runner_lock?.common_repository_identity_digest !== identity.digest
    || receipt.isolation?.common_repository_identity_digest !== identity.digest) {
    fail('runner lock evidence is missing');
  }
  if (receipt.runner_lock.path_source === 'git_common_dir_default'
    && resolveBinding(root, receipt.runner_lock.path)
      !== resolve(identity.common_dir, 'verification-runner.lock')) {
    fail('default runner lock is not rooted in the receipt-bound Git common-dir identity');
  }
  assertIgnoredArtifact(root, receiptPath);
  console.log(`PASS receipt structure: ${receiptPath}`);
  console.log('NOTICE receipt authenticity: unsigned self-attestation only; independent regeneration is authoritative');
  return receipt;
}

try {
  validateReceipt(parseArguments(process.argv.slice(2)));
} catch (error) {
  console.error(`FAIL receipt structure: ${error.message}`);
  process.exitCode = 1;
}
