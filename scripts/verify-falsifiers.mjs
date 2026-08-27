#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratchBaseFor = environment => environment.ASCRYBE_SCRATCH_DIR
  || environment.TMPDIR || environment.TMP || environment.TEMP || tmpdir();

if (process.argv[2] === '--scratch-fallback-probe') {
  assert.equal(process.env.ASCRYBE_SCRATCH_DIR, undefined);
  assert.equal(process.env.TMPDIR, undefined);
  assert.equal(process.env.TMP, undefined);
  assert.equal(process.env.TEMP, undefined);
  assert.equal(scratchBaseFor(process.env), tmpdir());
  console.log(`PASS scratch fallback: os.tmpdir() selected literally as ${tmpdir()}`);
  process.exit(0);
}

const scratchBase = scratchBaseFor(process.env);
const probeRoot = mkdtempSync(join(scratchBase, 'verification-falsifiers-'));
const verifier = resolve(root, 'scripts/verify-all.mjs');
const validator = resolve(root, 'scripts/validate-verification-receipt.mjs');
const exactB2Signature = 'FAIL B2 exit gate: Error: ServingAssertion identity did not move exactly with the selected B2 identity head';

function commandFor(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function check(id, {
  command, expectation, requirements = [], signature = null, gatePath = null,
}) {
  return {
    id,
    command,
    category: 'probe',
    expectation,
    required_environment: requirements,
    failure_signature: signature,
    gate_path: gatePath,
    reason: 'Verification-runner falsifier probe.',
    source_citation: ['scripts/verify-falsifiers.mjs'],
    timeout_seconds: 30,
  };
}

function run(directory, command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...environment },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}`.trimEnd() };
}

function git(directory, args) {
  const result = run(directory, 'git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.output}`);
  return result.output;
}

function createSiblingWorktree(directory, name) {
  const sibling = join(probeRoot, name);
  git(directory, ['worktree', 'add', '-q', '-b', `probe-${name}`, sibling]);
  return sibling;
}

function killProcessGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function createRepository(name, {
  checks,
  requiredIds = checks.map(held => held.id),
  bindings = [],
  profileOverrides = {},
  gateDiscovery = { boundaries: [], candidate_pattern: 'a^', exclusions: [] },
  files = {},
}) {
  const directory = join(probeRoot, name);
  mkdirSync(join(directory, '.catalog'), { recursive: true });
  mkdirSync(join(directory, 'verification'), { recursive: true });
  writeFileSync(join(directory, '.gitignore'), '.verification/\n');
  writeFileSync(join(directory, '.catalog/checks.yaml'), `${JSON.stringify({
    api_version: 'example.project-checks/v1', overrides: profileOverrides,
  }, null, 2)}\n`);
  writeFileSync(join(directory, 'verification/checks.yaml'), `${JSON.stringify({
    schema: 'estate-map/verification-registry/v2',
    profile_binding: {
      path: '.catalog/checks.yaml',
      api_version: 'example.project-checks/v1',
      checks: bindings,
    },
    gate_discovery: gateDiscovery,
    checks,
  }, null, 2)}\n`);
  writeFileSync(join(directory, 'verification/expectations.yaml'), `${JSON.stringify({
    schema: 'estate-map/verification-expectations/v1', required_check_ids: requiredIds,
  }, null, 2)}\n`);
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(join(directory, 'scripts/verify-all.mjs'), readFileSync(verifier));
  writeFileSync(join(directory, 'probe.txt'), 'tracked neutral probe file\n');
  for (const [path, contents] of Object.entries(files)) {
    const output = join(directory, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, contents);
  }
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.email', 'verification-falsifier@example.invalid']);
  git(directory, ['config', 'user.name', 'Verification Falsifier']);
  git(directory, ['add', '.']);
  git(directory, ['commit', '-qm', `Create ${name} scratch copy`]);
  return directory;
}

function verifierArguments(directory, additions = []) {
  return [
    verifier,
    '--root', directory,
    '--registry', 'verification/checks.yaml',
    '--expectations', 'verification/expectations.yaml',
    '--profile', '.catalog/checks.yaml',
    '--receipt', '.verification/receipt.json',
    '--lock-timeout-ms', '500',
    ...additions,
  ];
}

function runProbe(name, configuration, additions = []) {
  const directory = createRepository(name, configuration);
  const result = run(directory, process.execPath, verifierArguments(directory, additions));
  return {
    directory,
    receipt: join(directory, '.verification/receipt.json'),
    ...result,
  };
}

function printProbe(name, result) {
  console.log(`--- FALSIFIER ${name} (exit ${result.status}) ---`);
  console.log(result.output);
}

function receiptFor(result) {
  return JSON.parse(readFileSync(result.receipt, 'utf8'));
}

function waitForPath(path, timeoutMs = 30_000) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(sleeper, 0, 0, 20);
  }
}

try {
  const expectPass = runProbe('01-expect-pass-nonzero', {
    checks: [check('probe-expect-pass', {
      command: commandFor("console.error('literal expect_pass failure'); process.exit(9)"),
      expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(expectPass.status, 1);
  assert.match(expectPass.output,
    /REGRESSION probe-expect-pass: expect_pass command exited 9 under established isolation[\s\S]*literal expect_pass failure[\s\S]*verification verdict: REGRESSION/u);
  printProbe('expect_pass_nonzero', expectPass);

  const differentB2 = runProbe('02-different-b2-signature', {
    checks: [check('b2-exit-gate', {
      command: commandFor("console.error('FAIL B2 exit gate: Error: DIFFERENT literal probe failure'); process.exit(1)"),
      expectation: 'expect_fail',
      signature: { match: 'exact_line', stream: 'stderr', value: exactB2Signature },
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(differentB2.status, 1);
  assert.match(differentB2.output,
    /REGRESSION b2-exit-gate: nonzero exit 1 did not match exact declared stderr line under established isolation:[\s\S]*DIFFERENT literal probe failure[\s\S]*verification verdict: REGRESSION/u);
  printProbe('b2_signature_drift', differentB2);

  const absentName = 'ASCRYBE_PROBE_REQUIREMENT_MUST_BE_ABSENT';
  delete process.env[absentName];
  const absentEnvironment = runProbe('03-absent-environment', {
    checks: [check('probe-environment', {
      command: commandFor("console.log('must not execute')"),
      expectation: 'expect_pass',
      requirements: [{ kind: 'env', name: absentName }],
    })],
  });
  assert.equal(absentEnvironment.status, 2);
  assert.match(absentEnvironment.output,
    /UNRUNNABLE probe-environment: missing requirement\(s\): environment variable: ASCRYBE_PROBE_REQUIREMENT_MUST_BE_ABSENT[\s\S]*verification verdict: INCOMPLETE/u);
  printProbe('absent_environment', absentEnvironment);

  const shrunkRegistry = runProbe('04-shrunk-registry', {
    checks: [], requiredIds: ['required-check'],
  });
  assert.equal(shrunkRegistry.status, 1);
  assert.match(shrunkRegistry.output,
    /REGISTRY REGRESSION: missing registered checks: required-check[\s\S]*verification verdict: REGRESSION/u);
  printProbe('shrunk_registry', shrunkRegistry);

  const unestablishedFailure = runProbe('05-unestablished-failure', {
    checks: [check('probe-unestablished', {
      command: commandFor("console.error('literal unestablished failure'); process.exit(5)"),
      expectation: 'expect_pass',
    })],
  });
  assert.equal(unestablishedFailure.status, 2);
  assert.match(unestablishedFailure.output,
    /INCONCLUSIVE probe-unestablished:[\s\S]*under unestablished isolation[\s\S]*verification verdict: INCOMPLETE/u);
  printProbe('unestablished_failure', unestablishedFailure);

  const contaminatedFailure = runProbe('06-contaminated-failure', {
    checks: [check('probe-contaminated-failure', {
      command: commandFor("console.error('literal contaminated failure'); process.exit(6)"),
      expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'contaminated', '--isolation-note', 'synthetic concurrent load']);
  assert.equal(contaminatedFailure.status, 2);
  assert.match(contaminatedFailure.output,
    /INCONCLUSIVE probe-contaminated-failure:[\s\S]*under contaminated isolation[\s\S]*verification verdict: INCOMPLETE/u);
  printProbe('contaminated_failure', contaminatedFailure);

  const contaminatedPass = runProbe('07-contaminated-pass', {
    checks: [check('probe-contaminated-pass', {
      command: commandFor("console.log('literal pass under extra load')"),
      expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'contaminated', '--isolation-note', 'synthetic concurrent load']);
  assert.equal(contaminatedPass.status, 0);
  assert.match(contaminatedPass.output,
    /PASS probe-contaminated-pass: expect_pass command exited 0[\s\S]*verification isolation: contaminated[\s\S]*verification verdict: VERIFIED/u);
  printProbe('contaminated_pass', contaminatedPass);

  const sideEffectMarker = join(probeRoot, 'lock-timeout-side-effect');
  const lockDirectory = createRepository('08-lock-timeout', {
    checks: [check('probe-lock-timeout', {
      command: commandFor(`require('node:fs').writeFileSync(${JSON.stringify(sideEffectMarker)}, 'EXECUTED')`),
      expectation: 'expect_pass',
    })],
  });
  const heldLock = join(lockDirectory, '.verification/runner.lock');
  mkdirSync(heldLock, { recursive: true });
  const lockTimeout = run(lockDirectory, process.execPath, verifierArguments(lockDirectory, [
    '--lock-path', '.verification/runner.lock', '--lock-timeout-ms', '50',
  ]));
  assert.equal(lockTimeout.status, 2);
  assert.equal(existsSync(sideEffectMarker), false);
  assert.equal(receiptFor({
    receipt: join(lockDirectory, '.verification/receipt.json'),
  }).runner_lock.path_source, 'cli_override');
  assert.match(lockTimeout.output,
    /UNRUNNABLE probe-lock-timeout: exclusive runner lock timed out[\s\S]*zero checks executed[\s\S]*verification runner lock: timed_out; checks executed: 0[\s\S]*verification verdict: INCOMPLETE/u);
  printProbe('lock_timeout_zero_execution', lockTimeout);

  const boundCommand = commandFor("console.log('bound profile command')");
  const profileDriftDirectory = createRepository('09-profile-drift', {
    checks: [check('bound-check', { command: boundCommand, expectation: 'expect_pass' })],
    bindings: [{ check_id: 'bound-check', profile_check_id: 'build' }],
    profileOverrides: { build: { command: boundCommand } },
  });
  writeFileSync(join(profileDriftDirectory, '.catalog/checks.yaml'), `${JSON.stringify({
    api_version: 'example.project-checks/v1',
    overrides: { build: { command: commandFor("console.log('drifted profile command')") } },
  }, null, 2)}\n`);
  const profileDrift = run(profileDriftDirectory, process.execPath, verifierArguments(profileDriftDirectory));
  assert.equal(profileDrift.status, 1);
  assert.match(profileDrift.output,
    /REGISTRY REGRESSION: profile command drift: bound-check != overrides\.build[\s\S]*verification verdict: REGRESSION/u);
  printProbe('live_profile_drift', profileDrift);

  const byteEdit = runProbe('10-receipt-byte-edit', {
    checks: [check('probe-receipt', {
      command: commandFor("console.log('receipt source output')"), expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(byteEdit.status, 0);
  const validReceipt = run(byteEdit.directory, process.execPath, [
    validator, '--root', byteEdit.directory, byteEdit.receipt,
  ]);
  assert.equal(validReceipt.status, 0);
  const receiptBytes = readFileSync(byteEdit.receipt, 'utf8');
  writeFileSync(byteEdit.receipt, receiptBytes.replace('"verdict": "VERIFIED"', '"verdict": "XERIFIED"'));
  const editedReceipt = run(byteEdit.directory, process.execPath, [
    validator, '--root', byteEdit.directory, byteEdit.receipt,
  ]);
  assert.equal(editedReceipt.status, 1);
  assert.match(editedReceipt.output, /receipt body digest mismatch; receipt bytes were edited/u);
  printProbe('receipt_byte_edit', {
    status: editedReceipt.status,
    output: `${validReceipt.output}\n${editedReceipt.output}`,
  });

  const fallbackCopy = createRepository('11-scratch-fallback', { checks: [] });
  const fallbackEnvironment = { ...process.env };
  for (const name of ['ASCRYBE_SCRATCH_DIR', 'TMPDIR', 'TMP', 'TEMP']) delete fallbackEnvironment[name];
  const scratchFallback = run(fallbackCopy, process.execPath, [
    resolve(root, 'scripts/verify-falsifiers.mjs'), '--scratch-fallback-probe', fallbackCopy,
  ], fallbackEnvironment);
  assert.equal(scratchFallback.status, 0);
  assert.match(scratchFallback.output, /PASS scratch fallback: os\.tmpdir\(\) selected literally/u);
  printProbe('os_tmpdir_fallback', scratchFallback);

  const freshGateDirectory = createRepository('12-fresh-ignored-gate', {
    checks: [check('probe-pass', {
      command: commandFor("console.log('must not execute after coverage drift')"),
      expectation: 'expect_pass',
    })],
    gateDiscovery: {
      boundaries: [{ root: 'scripts', max_depth: 1 }],
      candidate_pattern: '^scripts/check-[^/]+\\.mjs$',
      exclusions: [],
    },
  });
  mkdirSync(join(freshGateDirectory, 'scripts'), { recursive: true });
  appendFileSync(join(freshGateDirectory, '.gitignore'), 'scripts/check-fresh-ignored.mjs\n');
  writeFileSync(join(freshGateDirectory, 'scripts/check-fresh-ignored.mjs'),
    "throw new Error('fresh ignored gate must be inventoried');\n");
  const freshIgnoredGate = run(freshGateDirectory, process.execPath, verifierArguments(freshGateDirectory));
  assert.equal(freshIgnoredGate.status, 1);
  assert.match(freshIgnoredGate.output,
    /REGISTRY REGRESSION: discovered in-scope gate is unregistered: scripts\/check-fresh-ignored\.mjs[\s\S]*verification verdict: REGRESSION/u);
  printProbe('fresh_ignored_gate_creation', freshIgnoredGate);

  const outputMutation = runProbe('13-output-mutation', {
    checks: [check('probe-output-mutation', {
      command: commandFor("process.stdout.write('exact output bytes\\n'); process.stderr.write('exact error bytes\\n')"),
      expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(outputMutation.status, 0);
  const outputMutationReceipt = receiptFor(outputMutation);
  const stdoutBinding = outputMutationReceipt.outcomes[0].captured_output.stdout;
  assert.equal(stdoutBinding.bytes, Buffer.byteLength('exact output bytes\n'));
  appendFileSync(resolve(outputMutation.directory, stdoutBinding.path), Buffer.from('MUTATED'));
  const mutatedOutput = run(outputMutation.directory, process.execPath, [
    validator, '--root', outputMutation.directory, outputMutation.receipt,
  ]);
  assert.equal(mutatedOutput.status, 1);
  assert.match(mutatedOutput.output, /probe-output-mutation stdout output byte count mismatch/u);
  printProbe('captured_output_mutation', mutatedOutput);

  const freshIgnored = createRepository('14-fresh-ignored-artifacts', {
    checks: [check('probe-fresh-ignored', {
      command: commandFor("console.log('fresh ignored output bytes')"), expectation: 'expect_pass',
    })],
  });
  assert.equal(existsSync(join(freshIgnored, '.verification')), false);
  const freshIgnoredRun = run(freshIgnored, process.execPath, verifierArguments(freshIgnored, [
    '--isolation-attestation', 'exclusive', '--isolation-note', 'fresh absent artifact directory',
  ]));
  assert.equal(freshIgnoredRun.status, 0);
  const freshReceiptPath = join(freshIgnored, '.verification/receipt.json');
  const freshReceipt = JSON.parse(readFileSync(freshReceiptPath, 'utf8'));
  const actualArtifactPaths = [freshReceiptPath,
    ...Object.values(freshReceipt.outcomes[0].captured_output)
      .map(binding => resolve(freshIgnored, binding.path))];
  for (const path of actualArtifactPaths) {
    assert.equal(existsSync(path), true);
    assert.equal(run(freshIgnored, 'git', [
      'check-ignore', '--no-index', '-q', '--', relative(freshIgnored, path),
    ]).status, 0);
  }
  const freshValidation = run(freshIgnored, process.execPath, [
    validator, '--root', freshIgnored, freshReceiptPath,
  ]);
  assert.equal(freshValidation.status, 0);
  assert.equal(run(freshIgnored, 'git', ['status', '--porcelain=v1', '--untracked-files=all']).output, '');
  printProbe('fresh_actual_ignored_artifacts', {
    status: freshValidation.status,
    output: `${freshIgnoredRun.output}\nPASS actual receipt/output files are ignored with no nonignored residue\n${freshValidation.output}`,
  });

  const runnerMutation = runProbe('15-runner-mutation', {
    checks: [check('probe-runner-binding', {
      command: commandFor("console.log('runner binding source')"), expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(runnerMutation.status, 0);
  appendFileSync(join(runnerMutation.directory, 'scripts/verify-all.mjs'), '\n// scratch mutation\n');
  const mutatedRunner = run(runnerMutation.directory, process.execPath, [
    validator, '--root', runnerMutation.directory, runnerMutation.receipt,
  ]);
  assert.equal(mutatedRunner.status, 1);
  assert.match(mutatedRunner.output, /runner bytes differ from the receipt binding/u);
  printProbe('canonical_runner_mutation', mutatedRunner);

  const dirtyWorktree = runProbe('16-dirty-worktree', {
    checks: [check('probe-worktree-binding', {
      command: commandFor("console.log('worktree binding source')"), expectation: 'expect_pass',
    })],
  }, ['--isolation-attestation', 'exclusive', '--isolation-note', 'single falsifier process']);
  assert.equal(dirtyWorktree.status, 0);
  appendFileSync(join(dirtyWorktree.directory, 'probe.txt'), 'post-receipt dirty mutation\n');
  const mutatedWorktree = run(dirtyWorktree.directory, process.execPath, [
    validator, '--root', dirtyWorktree.directory, dirtyWorktree.receipt,
  ]);
  assert.equal(mutatedWorktree.status, 1);
  assert.match(mutatedWorktree.output, /current worktree state, entries, or digests differ/u);
  printProbe('post_receipt_dirty_worktree', mutatedWorktree);

  const competitionDirectory = createRepository('17-competition-override', {
    checks: [check('probe-competition-failure', {
      command: commandFor("console.error('failure while competitor is observed'); process.exit(7)"),
      expectation: 'expect_pass',
    })],
    files: {
      'tests/competitor-observed.test.mjs': `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(probeRoot, 'competitor-ready'))}, 'ready');\ntest('holds a matching check process', async () => new Promise(resolveHeld => setTimeout(resolveHeld, 30_000)));\n`,
    },
  });
  const competitorReady = join(probeRoot, 'competitor-ready');
  const competitorEnvironment = { ...process.env };
  delete competitorEnvironment.NODE_TEST_CONTEXT;
  const competitor = spawn(process.execPath, ['--test', 'tests/competitor-observed.test.mjs'], {
    cwd: competitionDirectory,
    env: competitorEnvironment,
    stdio: 'ignore',
  });
  let competitionOverride;
  try {
    waitForPath(competitorReady);
    competitionOverride = run(competitionDirectory, process.execPath,
      verifierArguments(competitionDirectory, [
        '--isolation-attestation', 'exclusive', '--isolation-note', 'exclusive claim must be overridden',
      ]));
  } finally {
    competitor.kill('SIGKILL');
  }
  assert.equal(competitionOverride.status, 2);
  assert.match(competitionOverride.output,
    /INCONCLUSIVE probe-competition-failure:[\s\S]*under contaminated isolation[\s\S]*verification isolation: contaminated/u);
  const competitionReceipt = JSON.parse(readFileSync(join(
    competitionDirectory, '.verification/receipt.json'), 'utf8'));
  assert.equal(competitionReceipt.isolation.self_attestation.value, 'exclusive');
  assert.equal(competitionReceipt.isolation.competition_detected, true);
  assert.equal(competitionReceipt.isolation.effective_state, 'contaminated');
  assert.ok(competitionReceipt.isolation.bounded_observations.samples
    .some(sample => sample.matching_process_count > 0 && sample.matching_processes.length > 0));
  printProbe('automatic_competition_override', competitionOverride);

  const observationHonesty = runProbe('18-observation-honesty', {
    checks: [check('probe-observation-scope', {
      command: commandFor("console.log('bounded observation source')"), expectation: 'expect_pass',
    })],
  });
  assert.equal(observationHonesty.status, 0);
  const observationReceipt = receiptFor(observationHonesty);
  assert.ok(observationReceipt.isolation.bounded_observations.limitations
    .includes('processes that start and finish between samples can be missed'));
  assert.ok(observationReceipt.isolation.bounded_observations.limitations
    .includes('non-observation of a matching process is not evidence of host quiescence'));
  const verificationDocumentation = readFileSync(resolve(root, 'docs/verification.md'), 'utf8');
  assert.match(verificationDocumentation, /Processes that start and finish between samples can be missed/u);
  assert.match(verificationDocumentation, /Non-observation of a match is not host-quiescence evidence/u);
  printProbe('observation_scope_disclaimers', {
    status: observationHonesty.status,
    output: `${observationHonesty.output}\nPASS disclaimer: processes that start and finish between samples can be missed\nPASS disclaimer: non-observation of a matching process is not evidence of host quiescence`,
  });

  const identityFailureMarker = join(probeRoot, 'identity-failure-side-effect');
  const identityFailureDirectory = createRepository('19-common-identity-failure', {
    checks: [check('probe-identity-failure', {
      command: commandFor(`require('node:fs').writeFileSync(${JSON.stringify(identityFailureMarker)}, 'EXECUTED')`),
      expectation: 'expect_pass',
    })],
  });
  rmSync(join(identityFailureDirectory, '.git'), { recursive: true, force: true });
  const identityFailure = run(identityFailureDirectory, process.execPath,
    verifierArguments(identityFailureDirectory));
  assert.equal(identityFailure.status, 1);
  assert.equal(existsSync(identityFailureMarker), false);
  assert.match(identityFailure.output,
    /verification runner error: Error: git rev-parse --path-format=absolute --git-common-dir failed/u);
  printProbe('common_identity_failure_zero_execution', {
    status: identityFailure.status,
    output: `${identityFailure.output}\nPASS common identity derivation failure: zero checks executed`,
  });

  const sharedLockMarker = join(probeRoot, 'shared-lock-side-effects');
  const sharedLockDirectory = createRepository('20-shared-worktree-lock', {
    checks: [check('probe-shared-lock', {
      command: commandFor(`require('node:fs').appendFileSync(${JSON.stringify(sharedLockMarker)}, 'x\\n'); setTimeout(() => {}, 30_000)`),
      expectation: 'expect_pass',
    })],
  });
  const sharedLockSibling = createSiblingWorktree(sharedLockDirectory, '20-shared-worktree-lock-sibling');
  const primaryLockRunner = spawn(process.execPath, verifierArguments(sharedLockDirectory, [
    '--lock-timeout-ms', '30000',
  ]), {
    cwd: sharedLockDirectory,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  });
  let siblingLockTimeout;
  try {
    waitForPath(sharedLockMarker);
    siblingLockTimeout = run(sharedLockSibling, process.execPath,
      verifierArguments(sharedLockSibling, ['--lock-timeout-ms', '50']));
  } finally {
    killProcessGroup(primaryLockRunner);
  }
  assert.equal(siblingLockTimeout.status, 2);
  assert.equal(readFileSync(sharedLockMarker, 'utf8'), 'x\n');
  assert.match(siblingLockTimeout.output,
    /UNRUNNABLE probe-shared-lock: exclusive runner lock timed out[\s\S]*zero checks executed[\s\S]*verification runner lock: timed_out; checks executed: 0/u);
  const siblingLockReceipt = JSON.parse(readFileSync(join(
    sharedLockSibling, '.verification/receipt.json'), 'utf8'));
  assert.equal(siblingLockReceipt.runner_lock.path_source, 'git_common_dir_default');
  assert.equal(siblingLockReceipt.runner_lock.checks_executed, 0);
  assert.equal(siblingLockReceipt.runner_lock.common_repository_identity_digest,
    siblingLockReceipt.bindings.common_repository_identity.digest);
  assert.ok(siblingLockReceipt.bindings.common_repository_identity.observed_worktree_roots
    .includes(sharedLockDirectory));
  assert.ok(siblingLockReceipt.bindings.common_repository_identity.observed_worktree_roots
    .includes(sharedLockSibling));
  printProbe('shared_sibling_worktree_lock_timeout', {
    status: siblingLockTimeout.status,
    output: `${siblingLockTimeout.output}\nPASS shared default: sibling worktree timed out with zero checks; path_source=git_common_dir_default`,
  });

  const crossWorktreeDirectory = createRepository('21-cross-worktree-competition', {
    checks: [check('probe-cross-worktree-failure', {
      command: commandFor("console.error('failure while sibling competitor is observed'); process.exit(8)"),
      expectation: 'expect_pass',
    })],
    files: {
      'tests/sibling-competitor.test.mjs': `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(probeRoot, 'sibling-competitor-ready'))}, 'ready');\ntest('holds a sibling matching process', async () => new Promise(resolveHeld => setTimeout(resolveHeld, 30_000)));\n`,
    },
  });
  const crossWorktreeSibling = createSiblingWorktree(
    crossWorktreeDirectory, '21-cross-worktree-competition-sibling',
  );
  const siblingCompetitorReady = join(probeRoot, 'sibling-competitor-ready');
  const siblingCompetitor = spawn(process.execPath, ['--test', 'tests/sibling-competitor.test.mjs'], {
    cwd: crossWorktreeSibling,
    env: { ...competitorEnvironment },
    detached: true,
    stdio: 'ignore',
  });
  let crossWorktreeCompetition;
  try {
    waitForPath(siblingCompetitorReady);
    crossWorktreeCompetition = run(crossWorktreeDirectory, process.execPath,
      verifierArguments(crossWorktreeDirectory, [
        '--isolation-attestation', 'exclusive', '--isolation-note', 'sibling must override exclusive',
      ]));
  } finally {
    killProcessGroup(siblingCompetitor);
  }
  assert.equal(crossWorktreeCompetition.status, 2);
  assert.match(crossWorktreeCompetition.output,
    /INCONCLUSIVE probe-cross-worktree-failure:[\s\S]*under contaminated isolation[\s\S]*verification isolation: contaminated/u);
  const crossWorktreeReceipt = receiptFor({
    receipt: join(crossWorktreeDirectory, '.verification/receipt.json'),
  });
  assert.equal(crossWorktreeReceipt.isolation.self_attestation.value, 'exclusive');
  assert.equal(crossWorktreeReceipt.isolation.effective_state, 'contaminated');
  assert.ok(crossWorktreeReceipt.isolation.detected_competitors
    .some(process => process.observed_worktree_root === crossWorktreeSibling));
  printProbe('cross_worktree_competition_override', {
    status: crossWorktreeCompetition.status,
    output: `${crossWorktreeCompetition.output}\nPASS sibling process: detected under shared Git common-dir identity and overrode exclusive`,
  });

  const unrelatedDirectory = createRepository('22-unrelated-process-excluded', {
    checks: [check('probe-unrelated-exclusion', {
      command: commandFor("console.log('unrelated matching process excluded')"),
      expectation: 'expect_pass',
    })],
  });
  const unrelatedProcessDirectory = createRepository('22-different-git-identity', {
    checks: [],
    files: {
      'tests/unrelated-competitor.test.mjs': `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(probeRoot, 'unrelated-competitor-ready'))}, 'ready');\ntest('holds an unrelated matching process', async () => new Promise(resolveHeld => setTimeout(resolveHeld, 30_000)));\n`,
    },
  });
  const unrelatedCompetitorReady = join(probeRoot, 'unrelated-competitor-ready');
  const unrelatedCompetitor = spawn(process.execPath, ['--test', 'tests/unrelated-competitor.test.mjs'], {
    cwd: unrelatedProcessDirectory,
    env: { ...competitorEnvironment },
    detached: true,
    stdio: 'ignore',
  });
  let unrelatedExclusion;
  try {
    waitForPath(unrelatedCompetitorReady);
    unrelatedExclusion = run(unrelatedDirectory, process.execPath,
      verifierArguments(unrelatedDirectory, [
        '--isolation-attestation', 'exclusive', '--isolation-note', 'different Git identity is unrelated',
      ]));
  } finally {
    killProcessGroup(unrelatedCompetitor);
  }
  assert.equal(unrelatedExclusion.status, 0);
  const unrelatedReceipt = receiptFor({
    receipt: join(unrelatedDirectory, '.verification/receipt.json'),
  });
  assert.equal(unrelatedReceipt.isolation.competition_detected, false);
  assert.equal(unrelatedReceipt.isolation.effective_state, 'established');
  assert.ok(unrelatedReceipt.isolation.bounded_observations.samples
    .every(sample => sample.matching_process_count === 0));
  printProbe('unrelated_git_identity_excluded', {
    status: unrelatedExclusion.status,
    output: `${unrelatedExclusion.output}\nPASS unrelated exclusion: live matching process in different scratch Git repository was not classified as a competitor`,
  });

  console.log('PASS verification falsifiers: 22/22 fail-closed scratch-copy probes produced literal evidence; all prior 18 remain green');
} finally {
  rmSync(probeRoot, { recursive: true, force: true });
}
