#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outcomeNames = Object.freeze([
  'PASS', 'EXPECTED_FAIL', 'REGRESSION', 'INCONCLUSIVE', 'UNRUNNABLE',
]);
const expectationNames = new Set(['expect_pass', 'expect_fail']);
const isolationAttestations = new Set(['unestablished', 'exclusive', 'contaminated']);
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trimEnd();
}

function deriveRepositoryIdentity(root) {
  const scheme = 'git-common-dir-realpath-v1';
  const commonDir = realpathSync(git(root, [
    'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]));
  const selectedWorktree = realpathSync(git(root, ['rev-parse', '--show-toplevel']));
  const worktreeRoots = git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(path => existsSync(path))
    .map(path => realpathSync(path))
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
  if (!worktreeRoots.includes(selectedWorktree)) {
    throw new Error('selected worktree is absent from git worktree list --porcelain');
  }
  return {
    scheme,
    common_dir: commonDir,
    digest: sha256(`${scheme}\0${commonDir}`),
    selected_worktree: selectedWorktree,
    observed_worktree_roots: worktreeRoots,
    derivation: {
      common_dir: 'git rev-parse --path-format=absolute --git-common-dir, then fs.realpath',
      selected_worktree: 'git rev-parse --show-toplevel, then fs.realpath',
      observed_worktree_roots: 'existing paths from git worktree list --porcelain, then fs.realpath',
    },
  };
}

function parseArguments(argv) {
  const held = {
    root: defaultRoot,
    registry: null,
    expectations: null,
    profile: null,
    receipt: null,
    lockPath: null,
    lockTimeoutMs: 10_000,
    isolationAttestation: 'unestablished',
    isolationNote: null,
    includes: new Set(),
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--verbose') held.verbose = true;
    else if ([
      '--root', '--registry', '--expectations', '--profile', '--receipt', '--lock-path',
      '--lock-timeout-ms', '--isolation-attestation', '--isolation-note', '--include',
    ].includes(flag)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      if (flag === '--include') {
        for (const name of value.split(',').filter(Boolean)) held.includes.add(name);
      } else if (flag === '--lock-timeout-ms') {
        held.lockTimeoutMs = Number(value);
      } else {
        const key = flag.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
        held[key] = value;
      }
    } else throw new Error(`unknown argument: ${flag}`);
  }
  held.root = resolve(held.root);
  const pathAtRoot = (value, fallback) => {
    const selected = value || fallback;
    return isAbsolute(selected) ? resolve(selected) : resolve(held.root, selected);
  };
  held.registry = pathAtRoot(held.registry, 'verification/checks.yaml');
  held.expectations = pathAtRoot(held.expectations, 'verification/expectations.yaml');
  held.profile = pathAtRoot(held.profile, '.catalog/checks.yaml');
  held.receipt = held.receipt
    ? pathAtRoot(held.receipt) : null;
  held.lockPath = held.lockPath ? pathAtRoot(held.lockPath) : null;
  if (!Number.isInteger(held.lockTimeoutMs) || held.lockTimeoutMs < 0 || held.lockTimeoutMs > 300_000) {
    throw new Error('--lock-timeout-ms must be an integer from 0 through 300000');
  }
  if (!isolationAttestations.has(held.isolationAttestation)) {
    throw new Error('--isolation-attestation must be unestablished, exclusive, or contaminated');
  }
  if (held.isolationAttestation !== 'unestablished' && !held.isolationNote) {
    throw new Error('--isolation-note is required for exclusive or contaminated self-attestation');
  }
  return held;
}

function loadYaml(path, label) {
  let bytes;
  try { bytes = readFileSync(path); }
  catch (error) { throw new Error(`${label} is unreadable at ${path}: ${error.message}`); }
  let value;
  try { value = parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label} is invalid YAML: ${error.message}`); }
  return { bytes, value };
}

function normalizeRepositoryPath(root, path) {
  const held = relative(root, path).split(sep).join('/');
  return held || '.';
}

function configuredPath(root, path) {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function walkBoundary(root, boundary) {
  const start = configuredPath(root, boundary.root);
  const paths = [];
  if (!existsSync(start)) return paths;
  const visit = (directory, depth) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile()) paths.push(normalizeRepositoryPath(root, path));
      else if (entry.isDirectory() && depth < boundary.max_depth) visit(path, depth + 1);
    }
  };
  visit(start, 0);
  return paths;
}

export function collectGateCoverage(root, declaration) {
  if (!declaration || typeof declaration !== 'object') {
    return { findings: ['registry gate_discovery must be an object'], inventory: [] };
  }
  const boundaries = Array.isArray(declaration.boundaries) ? declaration.boundaries : [];
  const findings = [];
  if (!Array.isArray(declaration.boundaries)) findings.push('gate_discovery boundaries must be an array');
  for (const [index, boundary] of boundaries.entries()) {
    if (typeof boundary?.root !== 'string' || !boundary.root
      || !Number.isInteger(boundary?.max_depth) || boundary.max_depth < 0 || boundary.max_depth > 8) {
      findings.push(`gate_discovery boundaries[${index}] is invalid`);
    }
  }
  let candidatePattern;
  try { candidatePattern = new RegExp(declaration.candidate_pattern, 'u'); }
  catch { findings.push('gate_discovery candidate_pattern must be a valid regular expression'); }
  const exclusions = new Map();
  if (!Array.isArray(declaration.exclusions)) {
    findings.push('gate_discovery exclusions must be an array');
  } else {
    for (const exclusion of declaration.exclusions) {
      if (typeof exclusion?.path !== 'string' || !exclusion.path
        || typeof exclusion?.reason !== 'string' || !exclusion.reason) {
        findings.push('every gate_discovery exclusion requires path and reason');
      } else exclusions.set(exclusion.path, exclusion.reason);
    }
  }
  const paths = [...new Set(boundaries.flatMap(boundary => (
    typeof boundary?.root === 'string' && Number.isInteger(boundary?.max_depth)
      ? walkBoundary(root, boundary) : []
  )))].filter(path => candidatePattern?.test(path)).sort();
  const inventory = paths.map(path => exclusions.has(path)
    ? { path, disposition: 'excluded', reason: exclusions.get(path) }
    : { path, disposition: 'included', reason: 'matched the declared in-scope candidate pattern' });
  for (const path of exclusions.keys()) {
    if (!paths.includes(path)) findings.push(`gate exclusion is not a discovered candidate: ${path}`);
  }
  return { findings, inventory };
}

function registryFindings(root, registry, expectations, profile, profilePath) {
  const findings = [];
  if (registry?.schema !== 'estate-map/verification-registry/v2') {
    findings.push('registry schema must be estate-map/verification-registry/v2');
  }
  if (expectations?.schema !== 'estate-map/verification-expectations/v1') {
    findings.push('expectations schema must be estate-map/verification-expectations/v1');
  }
  const checks = Array.isArray(registry?.checks) ? registry.checks : [];
  if (!Array.isArray(registry?.checks)) findings.push('registry checks must be an array');
  const requiredIds = Array.isArray(expectations?.required_check_ids)
    ? expectations.required_check_ids : [];
  if (!Array.isArray(expectations?.required_check_ids)) {
    findings.push('expectations required_check_ids must be an array');
  }
  const ids = checks.map(check => check?.id).filter(id => typeof id === 'string');
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  if (duplicateIds.length) findings.push(`duplicate registered checks: ${duplicateIds.join(', ')}`);
  const missingIds = requiredIds.filter(id => !ids.includes(id)).sort();
  const unexpectedIds = ids.filter(id => !requiredIds.includes(id)).sort();
  if (missingIds.length) findings.push(`missing registered checks: ${missingIds.join(', ')}`);
  if (unexpectedIds.length) findings.push(`checks absent from expectations: ${unexpectedIds.join(', ')}`);

  for (const [index, check] of checks.entries()) {
    const at = check?.id || `checks[${index}]`;
    for (const field of [
      'id', 'command', 'category', 'expectation', 'required_environment',
      'failure_signature', 'reason', 'source_citation', 'gate_path',
    ]) {
      if (!Object.hasOwn(check || {}, field)) findings.push(`${at} lacks ${field}`);
    }
    if (typeof check?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(check.id)) {
      findings.push(`${at} has an invalid id`);
    }
    if (typeof check?.command !== 'string' || !check.command.trim()) {
      findings.push(`${at} command must be a nonempty string`);
    }
    if (typeof check?.category !== 'string' || !check.category.trim()) {
      findings.push(`${at} category must be a nonempty string`);
    }
    if (!expectationNames.has(check?.expectation)) {
      findings.push(`${at} expectation must be expect_pass or expect_fail`);
    }
    if (!Array.isArray(check?.required_environment)) {
      findings.push(`${at} required_environment must be an array`);
    }
    if (typeof check?.reason !== 'string' || !check.reason.trim()) {
      findings.push(`${at} reason must be a nonempty string`);
    }
    if (!Array.isArray(check?.source_citation) || check.source_citation.length === 0
      || check.source_citation.some(citation => typeof citation !== 'string' || !citation.trim())) {
      findings.push(`${at} source_citation must be a nonempty string array`);
    }
    if (check?.gate_path !== null && (typeof check?.gate_path !== 'string' || !check.gate_path)) {
      findings.push(`${at} gate_path must be null or a nonempty repository path`);
    }
    if (check?.expectation === 'expect_fail') {
      const signature = check.failure_signature;
      if (signature?.match !== 'exact_line'
        || !['stdout', 'stderr', 'combined'].includes(signature?.stream)
        || typeof signature?.value !== 'string' || !signature.value) {
        findings.push(`${at} expect_fail requires an exact_line failure signature and stream`);
      }
    } else if (check?.failure_signature !== null) {
      findings.push(`${at} expect_pass failure_signature must be null`);
    }
    if (check?.timeout_seconds !== undefined
      && (!Number.isInteger(check.timeout_seconds) || check.timeout_seconds < 1)) {
      findings.push(`${at} timeout_seconds must be a positive integer`);
    }
  }

  const declaredProfilePath = typeof registry?.profile_binding?.path === 'string'
    ? configuredPath(root, registry.profile_binding.path) : null;
  if (!declaredProfilePath) findings.push('registry profile_binding path must be a nonempty string');
  else if (declaredProfilePath !== resolve(profilePath)) {
    findings.push(`loaded profile differs from registry profile_binding path: ${registry.profile_binding.path}`);
  }
  if (profile?.api_version !== registry?.profile_binding?.api_version) {
    findings.push('live profile api_version differs from registry profile_binding api_version');
  }
  const bindings = Array.isArray(registry?.profile_binding?.checks)
    ? registry.profile_binding.checks : [];
  if (!Array.isArray(registry?.profile_binding?.checks)) {
    findings.push('registry profile_binding checks must be an array');
  }
  for (const binding of bindings) {
    const check = checks.find(candidate => candidate.id === binding?.check_id);
    const profileCheck = profile?.overrides?.[binding?.profile_check_id];
    if (!check) findings.push(`profile binding names absent registry check: ${binding?.check_id}`);
    else if (!profileCheck) findings.push(`profile binding names absent live override: ${binding?.profile_check_id}`);
    else if (check.command !== profileCheck.command) {
      findings.push(`profile command drift: ${binding.check_id} != overrides.${binding.profile_check_id}`);
    }
  }

  const coverage = collectGateCoverage(root, registry?.gate_discovery);
  findings.push(...coverage.findings);
  const included = coverage.inventory
    .filter(item => item.disposition === 'included').map(item => item.path);
  const registered = checks.map(check => check.gate_path).filter(Boolean);
  for (const path of included) {
    if (!registered.includes(path)) findings.push(`discovered in-scope gate is unregistered: ${path}`);
  }
  for (const path of registered) {
    if (!included.includes(path)) findings.push(`registered gate_path is not an included candidate: ${path}`);
  }
  return { findings, coverage: coverage.inventory };
}

function requirementMissing(root, requirement, includes) {
  if (!requirement || typeof requirement !== 'object') return 'invalid requirement declaration';
  if (requirement.kind === 'opt_in') {
    return includes.has(requirement.name) || includes.has('all')
      ? null : `opt-in category: ${requirement.name}`;
  }
  if (requirement.kind === 'env') {
    return process.env[requirement.name] ? null : `environment variable: ${requirement.name}`;
  }
  if (requirement.kind === 'env_file') {
    const value = process.env[requirement.name];
    if (!value) return `environment variable naming a file: ${requirement.name}`;
    return existsSync(value) ? null : `file named by ${requirement.name}: ${value}`;
  }
  if (requirement.kind === 'path') {
    const path = isAbsolute(requirement.name) ? requirement.name : resolve(root, requirement.name);
    return existsSync(path) ? null : `path: ${requirement.name}`;
  }
  if (requirement.kind === 'command') {
    const result = spawnSync('bash', [
      '-lc', 'command -v -- "$1" >/dev/null 2>&1', 'verification-requirement', requirement.name,
    ]);
    return result.status === 0 ? null : `command: ${requirement.name}`;
  }
  return `unsupported requirement kind: ${requirement.kind ?? '<missing>'}`;
}

function exactSignatureMatched(signature, stdout, stderr) {
  const stdoutText = stdout.toString('utf8');
  const stderrText = stderr.toString('utf8');
  const text = signature.stream === 'stdout' ? stdoutText
    : signature.stream === 'stderr' ? stderrText : `${stdoutText}\n${stderrText}`;
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  return lines.filter(line => line === signature.value).length === 1;
}

function tail(bytes, lines = 12) {
  const text = bytes.toString('utf8');
  return text.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-lines).join('\n');
}

function isolationFailureOutcome(isolation) {
  return isolation.effective_state === 'established' ? 'REGRESSION' : 'INCONCLUSIVE';
}

function executeCheck(root, check, includes, isolation) {
  const missing = (check.required_environment || [])
    .map(requirement => requirementMissing(root, requirement, includes)).filter(Boolean);
  if (missing.length) return unrunResult(check, `missing requirement(s): ${missing.join('; ')}`, missing);
  const result = spawnSync('bash', ['-lc', check.command], {
    cwd: root,
    env: { ...process.env },
    maxBuffer: 256 * 1024 * 1024,
    timeout: (check.timeout_seconds || 600) * 1000,
  });
  const stdout = result.stdout || Buffer.alloc(0);
  const stderr = result.stderr || Buffer.alloc(0);
  const exitCode = result.status;
  const matched = check.expectation === 'expect_fail'
    && exitCode !== 0 && exactSignatureMatched(check.failure_signature, stdout, stderr);
  let outcome;
  let reason;
  if (result.error) {
    outcome = isolationFailureOutcome(isolation);
    reason = `command execution error under ${isolation.effective_state} isolation: ${result.error.message}`;
  } else if (check.expectation === 'expect_pass') {
    outcome = exitCode === 0 ? 'PASS' : isolationFailureOutcome(isolation);
    reason = exitCode === 0 ? 'expect_pass command exited 0'
      : `expect_pass command exited ${exitCode}${result.signal ? ` (${result.signal})` : ''} under ${isolation.effective_state} isolation`;
  } else if (exitCode === 0) {
    outcome = isolationFailureOutcome(isolation);
    reason = `expect_fail command unexpectedly exited 0 under ${isolation.effective_state} isolation`;
  } else if (matched) {
    outcome = 'EXPECTED_FAIL';
    reason = `matched exact ${check.failure_signature.stream} line: ${check.failure_signature.value}`;
  } else {
    outcome = isolationFailureOutcome(isolation);
    reason = `nonzero exit ${exitCode} did not match exact declared ${check.failure_signature.stream} line under ${isolation.effective_state} isolation: ${check.failure_signature.value}`;
  }
  return {
    id: check.id,
    category: check.category,
    expectation: check.expectation,
    command: check.command,
    outcome,
    reason,
    missing_requirements: [],
    exit_code: exitCode,
    signal: result.signal,
    stdout_digest: sha256(stdout),
    stderr_digest: sha256(stderr),
    output_digest: sha256(Buffer.concat([stdout, Buffer.from('\n'), stderr])),
    matched_failure_signature: matched,
    executed: true,
    captured_output: null,
    stdout,
    stderr,
  };
}

function unrunResult(check, reason, missingRequirements = []) {
  return {
    id: check.id,
    category: check.category,
    expectation: check.expectation,
    command: check.command,
    outcome: 'UNRUNNABLE',
    reason,
    missing_requirements: missingRequirements,
    exit_code: null,
    signal: null,
    stdout_digest: sha256(''),
    stderr_digest: sha256(''),
    output_digest: sha256('\n'),
    matched_failure_signature: false,
    executed: false,
    captured_output: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

function insideRoot(root, path) {
  const held = resolve(path);
  return held === root || held.startsWith(root + sep);
}

function assertIgnoredArtifact(root, path) {
  if (!insideRoot(root, path)) return;
  if (!existsSync(path)) throw new Error(`artifact path does not exist: ${relative(root, path)}`);
  // Ignored custody is reached through a symlink on machines that keep run output on another
  // volume, and `git check-ignore` refuses to answer for a path beyond one — it exits 128 saying
  // so. Reading that refusal as "not ignored" failed the runner over an artifact that was never
  // in the repository's tree at all, so resolve the link first and judge the real location.
  const held = relative(root, realpathSync(path));
  if (!insideRoot(root, resolve(root, held))) return;
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', held], { cwd: root });
  // 0 ignored, 1 tracked, anything else means git could not decide: a runner that cannot tell
  // those apart is not enforcing the rule, so an undecided answer is its own failure.
  if (result.status === 1) throw new Error(`created verification artifact is not gitignored: ${held}`);
  if (result.status !== 0) {
    throw new Error(`git could not decide whether ${held} is ignored `
      + `(exit ${result.status}): ${String(result.stderr ?? '').trim()}`);
  }
}

function publicResult(result) {
  const { stdout: _stdout, stderr: _stderr, ...held } = result;
  return held;
}

function printResult(result, verbose) {
  console.log(`${result.outcome} ${result.id}: ${result.reason}`);
  if (verbose || ['REGRESSION', 'INCONCLUSIVE'].includes(result.outcome)) {
    const stdout = tail(result.stdout);
    const stderr = tail(result.stderr);
    if (stdout) for (const line of stdout.split('\n')) console.log(`  stdout | ${line}`);
    if (stderr) for (const line of stderr.split('\n')) console.log(`  stderr | ${line}`);
  }
}

const competitorMarkers = [
  /scripts\/(?:verify(?:-all)?|check-[^/]+)\.mjs/u,
  /tools\/[^/]+-exit-gate\.mjs/u,
  /analysis\/run-manifests\/VERIFY\.mjs/u,
  /node\0--test\0tests\//u,
];

function observeHostLoad(identity, point, checkId = null) {
  let processCount = null;
  let processCountError = null;
  const competitors = [];
  let competitorObservationError = null;
  let scannedProcessCount = 0;
  let candidateProcessCount = 0;
  const scanLimit = 4096;
  const matchLimit = 32;
  try {
    const pids = readdirSync('/proc').filter(name => /^\d+$/u.test(name))
      .sort((left, right) => Number(left) - Number(right));
    processCount = pids.length;
    for (const pid of pids.slice(0, scanLimit)) {
      scannedProcessCount += 1;
      if (Number(pid) === process.pid) continue;
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        const worktreeRoot = identity.observed_worktree_roots
          .find(root => insideRoot(root, cwd));
        if (!worktreeRoot) continue;
        const commandBytes = readFileSync(`/proc/${pid}/cmdline`);
        const command = commandBytes.toString('utf8');
        const marker = competitorMarkers.find(pattern => pattern.test(command));
        if (!marker) continue;
        candidateProcessCount += 1;
        if (competitors.length < matchLimit) {
          const argv0 = command.split('\0')[0] || '<empty>';
          competitors.push({
            pid: Number(pid),
            executable: basename(argv0),
            command_sha256: sha256(commandBytes),
            matched_marker: marker.source,
            observed_worktree_root: worktreeRoot,
          });
        }
      } catch {
        // Processes can exit or deny /proc reads between the bounded directory and file samples.
      }
    }
  } catch (error) {
    processCountError = error.code || error.message;
    competitorObservationError = processCountError;
  }
  return {
    point,
    check_id: checkId,
    scope: 'one instantaneous Linux /proc sample: at most 4096 numeric PIDs, excluding the runner PID, whose cwd is inside an existing worktree returned by git worktree list --porcelain for the receipt-bound Git common-dir identity and whose NUL-delimited command line matches a declared runner/check marker; at most 32 sanitized matches are listed',
    load_average_1m_5m_15m: loadavg(),
    available_parallelism: availableParallelism(),
    proc_process_count: processCount,
    proc_observation_error: processCountError,
    competitor_observation_supported: competitorObservationError === null,
    competitor_observation_error: competitorObservationError,
    scanned_process_count: scannedProcessCount,
    matching_process_count: candidateProcessCount,
    matching_processes_truncated: candidateProcessCount > competitors.length,
    matching_processes: competitors,
  };
}

function isolationRecord(options, lock, identity) {
  const effective = options.isolationAttestation === 'exclusive' && lock.state === 'acquired'
    ? 'established'
    : options.isolationAttestation === 'contaminated' ? 'contaminated' : 'unestablished';
  return {
    effective_state: effective,
    exact_scope: 'by default commands in every worktree of the receipt-bound Git common-dir identity share one lock; a CLI lock-path override is explicitly labeled; bounded Linux /proc samples match selected runner/check command lines in existing worktrees registered to that identity but perform no host-wide process exclusion',
    common_repository_identity_digest: identity.digest,
    competition_detected: false,
    competition_override: null,
    detected_competitors: [],
    self_attestation: {
      source: 'operator CLI; not independently authenticated',
      value: options.isolationAttestation,
      note: options.isolationNote,
    },
    lock_state: lock.state,
    claims_not_made: [
      'no host-quiescence claim',
      'no claim that unrelated processes, databases, remotes, or paid inference are absent',
      'load observations are bounded samples, not proof of isolation',
      'processes that start and finish between samples can be missed',
      'non-observation of a matching process is not evidence of host quiescence',
    ],
  };
}

function applyCompetitionObservation(isolation, observation) {
  if (observation.matching_process_count < 1) return;
  isolation.competition_detected = true;
  isolation.effective_state = 'contaminated';
  isolation.competition_override = 'detected matching process overrides any exclusive self-attestation';
  for (const process of observation.matching_processes) {
    if (!isolation.detected_competitors.some(held => held.pid === process.pid)) {
      isolation.detected_competitors.push(process);
    }
  }
}

function acquireLock(path, timeoutMs) {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`);
      return {
        state: 'acquired',
        path,
        timeout_ms: timeoutMs,
        wait_ms: Date.now() - started,
        attempts,
        release: () => rmSync(path, { recursive: true, force: true }),
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        return {
          state: 'timed_out', path, timeout_ms: timeoutMs, wait_ms: elapsed, attempts,
          release: () => {},
        };
      }
      Atomics.wait(sleepBuffer, 0, 0, Math.min(25, timeoutMs - elapsed));
    }
  }
}

function relativeOrAbsolute(root, path) {
  return insideRoot(root, path) ? normalizeRepositoryPath(root, path) : path;
}

function persistCapturedOutput(root, outputRoot, results) {
  rmSync(outputRoot, { recursive: true, force: true });
  const written = [];
  for (const result of results) {
    if (!result.executed) continue;
    const checkRoot = join(outputRoot, result.id);
    mkdirSync(checkRoot, { recursive: true });
    const stdoutPath = join(checkRoot, 'stdout.bin');
    const stderrPath = join(checkRoot, 'stderr.bin');
    writeFileSync(stdoutPath, result.stdout);
    writeFileSync(stderrPath, result.stderr);
    written.push(stdoutPath, stderrPath);
    result.captured_output = {
      stdout: {
        path: relativeOrAbsolute(root, stdoutPath),
        bytes: result.stdout.length,
        digest: result.stdout_digest,
      },
      stderr: {
        path: relativeOrAbsolute(root, stderrPath),
        bytes: result.stderr.length,
        digest: result.stderr_digest,
      },
    };
  }
  for (const path of written) assertIgnoredArtifact(root, path);
  return written;
}

export function runVerification(options) {
  // Identity derivation precedes registry loading, lock creation, observations, and check execution.
  const identity = deriveRepositoryIdentity(options.root);
  const lockSelection = options.lockPath
    ? { path: options.lockPath, source: 'cli_override' }
    : {
      path: join(identity.common_dir, 'verification-runner.lock'),
      source: 'git_common_dir_default',
    };
  const registrySource = loadYaml(options.registry, 'registry');
  const expectationsSource = loadYaml(options.expectations, 'expectations');
  const profileSource = loadYaml(options.profile, 'live check profile');
  const registryState = registryFindings(
    options.root, registrySource.value, expectationsSource.value, profileSource.value, options.profile,
  );
  const checks = Array.isArray(registrySource.value?.checks)
    ? registrySource.value.checks.filter(check => check && typeof check.id === 'string') : [];
  const lock = acquireLock(lockSelection.path, options.lockTimeoutMs);
  const isolation = isolationRecord(options, lock, identity);
  const observations = {
    samples: [],
    exact_scope: 'before, immediately before each declared check considered for execution, and after execution; each sample uses the bounded /proc matcher stated on the sample',
    limitations: [
      'processes that start and finish between samples can be missed',
      'non-observation of a matching process is not evidence of host quiescence',
      'Linux /proc may be unavailable or access-restricted on this platform',
      'worktrees added after the receipt-bound git worktree inventory are outside these samples',
    ],
    observed_worktree_roots: identity.observed_worktree_roots,
  };
  const recordObservation = (point, checkId = null) => {
    const observation = observeHostLoad(identity, point, checkId);
    observations.samples.push(observation);
    applyCompetitionObservation(isolation, observation);
  };
  let results;
  try {
    recordObservation('before');
    if (lock.state !== 'acquired') {
      results = checks.map(check => unrunResult(
        check,
        `exclusive runner lock timed out after ${lock.wait_ms}ms; zero checks executed`,
        [`runner lock: ${relativeOrAbsolute(options.root, lock.path)}`],
      ));
    } else if (registryState.findings.length) results = [];
    else {
      results = [];
      for (const check of checks) {
        recordObservation('before_check', check.id);
        results.push(executeCheck(options.root, check, options.includes, isolation));
      }
    }
    recordObservation('after');
    if (isolation.effective_state !== 'established') {
      for (const result of results) {
        if (result.outcome !== 'REGRESSION') continue;
        result.outcome = 'INCONCLUSIVE';
        result.reason = result.reason.replace('under established isolation',
          `under ${isolation.effective_state} isolation`);
      }
    }
    const counts = Object.fromEntries(outcomeNames.map(name => [name,
      results.filter(result => result.outcome === name).length]));
    const verdict = lock.state !== 'acquired' ? 'INCOMPLETE'
      : registryState.findings.length || counts.REGRESSION > 0 ? 'REGRESSION'
        : counts.INCONCLUSIVE > 0 || counts.UNRUNNABLE > 0 ? 'INCOMPLETE' : 'VERIFIED';
    const head = git(options.root, ['rev-parse', 'HEAD']);
    const gitCommitTime = git(options.root, ['show', '-s', '--format=%cI', 'HEAD']);
    const porcelain = git(options.root, ['status', '--porcelain=v1', '--untracked-files=all']);
    const trackedDiff = git(options.root, ['diff', '--binary', 'HEAD']);
    const outputPath = options.receipt
      || resolve(options.root, `.verification/receipts/verification-${head}.json`);
    const outputRoot = resolve(dirname(outputPath), `${basename(outputPath, '.json')}.outputs`);
    let writtenOutputPaths = [];
    try {
      writtenOutputPaths = persistCapturedOutput(options.root, outputRoot, results);
    } catch (error) {
      rmSync(outputRoot, { recursive: true, force: true });
      throw error;
    }
    const publicOutcomes = results.map(publicResult);
    const coverageDigest = sha256(`${JSON.stringify(registryState.coverage)}\n`);
    const canonicalRunnerPath = resolve(options.root, 'scripts/verify-all.mjs');
    const canonicalRunnerDigest = sha256(readFileSync(canonicalRunnerPath));
    const receiptBody = {
      schema: 'estate-map/verification-receipt/v2',
      commit: {
        head,
        git_commit_time: gitCommitTime,
        time_derivation: 'git show -s --format=%cI HEAD',
      },
      worktree: {
        state: porcelain ? 'dirty' : 'clean',
        porcelain_sha256: sha256(porcelain),
        tracked_diff_sha256: sha256(trackedDiff),
        entries: porcelain ? porcelain.split('\n') : [],
      },
      bindings: {
        registry: { path: relativeOrAbsolute(options.root, options.registry), digest: sha256(registrySource.bytes) },
        expectations: { path: relativeOrAbsolute(options.root, options.expectations), digest: sha256(expectationsSource.bytes) },
        live_profile: { path: relativeOrAbsolute(options.root, options.profile), digest: sha256(profileSource.bytes) },
        runner: { path: relativeOrAbsolute(options.root, canonicalRunnerPath), digest: canonicalRunnerDigest },
        gate_coverage: { inventory: registryState.coverage, digest: coverageDigest },
        common_repository_identity: identity,
      },
      artifacts: { output_root: relativeOrAbsolute(options.root, outputRoot) },
      isolation: { ...isolation, bounded_observations: observations },
      runner_lock: {
        state: lock.state,
        path: relativeOrAbsolute(options.root, lock.path),
        timeout_ms: lock.timeout_ms,
        wait_ms: lock.wait_ms,
        attempts: lock.attempts,
        checks_executed: lock.state === 'acquired' && !registryState.findings.length ? results.length : 0,
        path_source: lockSelection.source,
        common_repository_identity_digest: identity.digest,
      },
      provenance: {
        runner: 'scripts/verify-all.mjs',
        runner_digest: canonicalRunnerDigest,
        invocation_argv: process.argv.slice(2),
        cwd: process.cwd(),
        root: options.root,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        self_attested: true,
      },
      included_opt_ins: [...options.includes].sort(),
      registry_findings: registryState.findings,
      outcomes: publicOutcomes,
      outcomes_digest: sha256(`${JSON.stringify(publicOutcomes)}\n`),
      counts,
      verdict,
    };
    const receipt = { ...receiptBody, receipt_digest: sha256(`${JSON.stringify(receiptBody)}\n`) };
    try {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
      assertIgnoredArtifact(options.root, outputPath);
    } catch (error) {
      rmSync(outputPath, { force: true });
      for (const path of writtenOutputPaths) rmSync(path, { force: true });
      rmSync(outputRoot, { recursive: true, force: true });
      throw error;
    }

    for (const finding of registryState.findings) console.log(`REGISTRY REGRESSION: ${finding}`);
    for (const result of results) printResult(result, options.verbose);
    console.log(`verification summary: ${outcomeNames.map(name => `${name} ${counts[name]}`).join(' | ')}`);
    console.log(`verification isolation: ${isolation.effective_state} (${isolation.self_attestation.source})`);
    console.log(`verification runner lock: ${lock.state}; checks executed: ${receipt.runner_lock.checks_executed}`);
    console.log(`verification verdict: ${verdict}`);
    console.log(`verification receipt: ${outputPath}`);
    return {
      verdict,
      exitCode: verdict === 'VERIFIED' ? 0 : verdict === 'INCOMPLETE' ? 2 : 1,
      receipt,
      outputPath,
    };
  } finally {
    lock.release();
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = runVerification(parseArguments(argv));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`verification runner error: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
