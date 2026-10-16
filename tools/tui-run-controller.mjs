#!/usr/bin/env node
// Zero-dependency terminal controller for long, paid wide-context jobs. It owns only the exact
// process it spawns (plus that process group), follows checkpoint telemetry read-only, and uses a
// cooperative SIGINT pause before any force-stop option is considered.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CheckpointTelemetry, loadWideContextTelemetryContext } from './checkpoint-telemetry.mjs';

const execFileAsync = promisify(execFile);
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(TOOL_DIR);
export const RUN_CONTROLLER_SCHEMA = 'estate-map/run-controller-state/v1';

export function parseControllerArgs(args) {
  const flags = new Set(['help', 'json']);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected positional argument ${arg}`);
    const key = arg.slice(2);
    if (flags.has(key)) options[key] = true;
    else {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[key] = args[++i];
    }
  }
  return options;
}

export function hostPreflight({
  load1 = os.loadavg()[0], cpuCount = os.availableParallelism(), maxLoad = null,
} = {}) {
  const cpus = Math.max(1, Number(cpuCount || 1));
  const threshold = maxLoad == null ? Math.max(4, cpus * 0.75) : Number(maxLoad);
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('max load threshold must be positive');
  return Object.freeze({
    pass: Number(load1) <= threshold,
    load_1m: Number(Number(load1).toFixed(2)),
    cpu_count: cpus,
    max_load_1m: Number(threshold.toFixed(2)),
    utilization: Number((Number(load1) / cpus).toFixed(3)),
  });
}

export function shouldRequestSoftLoadPause({
  running, hardCircuit = false, pauseRequested = false, softPreflight = null,
} = {}) {
  return Boolean(running && !hardCircuit && !pauseRequested && softPreflight && !softPreflight.pass);
}

export function updateLoadAudit(previous, preflight, {
  at = new Date().toISOString(), circuit = false, armCircuit = false,
  minSampleIntervalMs = 5000, overloadRequiredSamples = 2,
} = {}) {
  const prior = previous || {};
  const required = Number(overloadRequiredSamples);
  if (!Number.isInteger(required) || required < 1) throw new Error('overload required samples must be a positive integer');
  const samples = [...(prior.samples || [])];
  const lastAt = samples.length ? Date.parse(samples.at(-1).at) : 0;
  const now = Date.parse(at);
  const shouldSample = !samples.length || circuit || !Number.isFinite(lastAt)
    || !Number.isFinite(now) || now - lastAt >= minSampleIntervalMs;
  if (shouldSample) samples.push({
    at, load_1m: preflight.load_1m, max_load_1m: preflight.max_load_1m,
    utilization: preflight.utilization,
  });
  const previousStreak = Number(prior.overload_streak || 0);
  const overloadStreak = preflight.pass ? 0 : (shouldSample ? previousStreak + 1 : previousStreak);
  const thresholdCrossed = previousStreak < required && overloadStreak >= required;
  const circuitOpened = Boolean(prior.circuit_opened) || circuit || (armCircuit && thresholdCrossed);
  const circuitEvents = [...(prior.circuit_events || [])];
  if (!prior.circuit_opened && circuitOpened) circuitEvents.push({
    at, load_1m: preflight.load_1m, max_load_1m: preflight.max_load_1m,
    overload_streak: overloadStreak, required_samples: required,
  });
  return Object.freeze({
    preflight: prior.preflight || { ...preflight, at },
    sample_interval_ms: minSampleIntervalMs,
    samples,
    sample_count: samples.length,
    peak_load_1m: Math.max(Number(prior.peak_load_1m || 0), preflight.load_1m),
    last: { ...preflight, at },
    overload_streak: overloadStreak,
    overload_required_samples: required,
    overload_pending: overloadStreak > 0 && overloadStreak < required,
    circuit_opened: circuitOpened,
    circuit_events: circuitEvents,
  });
}

function requireOptions(options) {
  const kind = options.job || 'extraction';
  if (!['extraction', 'replay-gate'].includes(kind)) throw new Error('--job must be extraction or replay-gate');
  for (const key of ['manifest', 'checkpoint', 'output']) if (!options[key]) throw new Error(`--${key} required`);
  if (kind === 'replay-gate' && !options['failed-units']) throw new Error('--failed-units required for replay-gate');
  return kind;
}

export function buildRunnerCommand(options, { cwd = process.cwd() } = {}) {
  const kind = requireOptions(options);
  const resolve = value => path.resolve(cwd, value);
  if (kind === 'replay-gate') {
    const args = [
      '--max-old-space-size=4096', path.join(TOOL_DIR, 'replay-gate.mjs'),
      '--manifest', resolve(options.manifest),
      '--failed-units', resolve(options['failed-units']),
      '--checkpoint', resolve(options.checkpoint),
      '--output', resolve(options.output),
      '--estate', resolve(options.estate || 'estate'),
    ];
    for (const [flag, key] of [
      ['--bounds', 'bounds'], ['--control-windows', 'control-windows'], ['--seed', 'seed'],
      ['--concurrency', 'concurrency'], ['--max-cost', 'max-cost'], ['--model', 'model'],
      ['--thinking', 'thinking'], ['--claims-output', 'claims-output'], ['--outcome-class', 'outcome-class'],
    ]) if (options[key] != null) args.push(flag, key.endsWith('output') || key === 'bounds' ? resolve(options[key]) : String(options[key]));
    return Object.freeze({ command: process.execPath, args, kind });
  }
  const args = [
    '--max-old-space-size=4096', path.join(TOOL_DIR, 'wide-context-extractor.mjs'),
    resolve(options.estate || 'estate'), '--manifest', resolve(options.manifest),
    '--checkpoint', resolve(options.checkpoint), '--output', resolve(options.output),
  ];
  for (const [flag, key] of [
    ['--bounds', 'bounds'], ['--window-ids', 'window-ids'], ['--concurrency', 'concurrency'],
    ['--max-cost', 'max-cost'], ['--contract', 'contract'],
    ['--worker-start-delay-ms', 'worker-start-delay-ms'],
    ['--initial-worker-concurrency', 'initial-worker-concurrency'],
  ]) if (options[key] != null) args.push(flag, key === 'bounds' || key === 'window-ids' ? resolve(options[key]) : String(options[key]));
  return Object.freeze({ command: process.execPath, args, kind });
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function resumeOutputState(file) {
  try {
    const artifact = JSON.parse(await fs.readFile(file, 'utf8'));
    return artifact?.status === 'complete' ? 'complete' : 'replaceable_nonfinal';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw new Error(`resume cannot classify existing output ${file}: ${error.message}`);
  }
}

export function classifyRunnerCompletion({
  code, signal = null, artifact = null, artifactError = null, pauseRequested = false,
} = {}) {
  const byState = artifact?.queue?.by_state || {};
  const pending = Number(byState.pending || 0) + Number(byState.leased || 0);
  const quarantined = Number(byState.quarantined || 0) + Number(byState.acceptance_unknown || 0);
  const status = artifact?.status || null;
  const detail = Object.freeze({ artifact_status: status, pending_units: pending, quarantined_units: quarantined });
  const paused = message => Object.freeze({ classification: 'paused', controller_code: 75, message, ...detail });
  const failed = message => Object.freeze({ classification: 'failed', controller_code: 2, message, ...detail });

  // Exit 75 is the runner's explicit cooperative-pause contract. The extractor writes paused
  // artifacts beside the requested output, so the requested path can legitimately be absent (or
  // still contain the previous non-final artifact) here.
  if (code === 75) return paused('run paused cleanly; resume is safe');
  if (signal) return failed(`runner terminated by ${signal}`);
  if (code !== 0) return failed(`runner exited ${code}`);
  if (artifactError) return failed(`runner exited 0 but output could not be read: ${artifactError}`);
  if (!artifact) return failed('runner exited 0 but did not write the requested output artifact');

  // A cooperative stop can coexist with already-recorded quarantine taint. In that case the
  // extractor historically called the artifact `incomplete` and exited 0, but pending queue units
  // still make the lifecycle state resumable rather than terminal.
  if (pending > 0) {
    return paused(pauseRequested
      ? `run paused with ${pending} unit(s) pending; resume is safe`
      : `runner stopped with ${pending} unit(s) pending; resume is required`);
  }
  if (status === 'complete' && quarantined === 0) {
    return Object.freeze({
      classification: 'complete', controller_code: 0, message: 'run completed', ...detail,
    });
  }
  if (status === 'paused') return failed('runner wrote a paused artifact with no pending work');
  if (status === 'incomplete' || quarantined > 0) {
    return failed(`run finished incomplete with ${quarantined} quarantined unit(s)`);
  }
  return failed(`runner exited 0 with unrecognized output status ${JSON.stringify(status)}`);
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export async function readProcessIdentity(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id < 2) return null;
  try {
    const [stat, cmdline] = await Promise.all([
      fs.readFile(`/proc/${id}/stat`, 'utf8'),
      fs.readFile(`/proc/${id}/cmdline`, 'utf8'),
    ]);
    // The executable name in parentheses may contain spaces; fields after the final ')' start at #3.
    const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: id, start_ticks: suffix[19], command: cmdline.split('\u0000').filter(Boolean) };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

export async function listOwnedDescendants(rootPid) {
  const found = [], pending = [Number(rootPid)], seen = new Set();
  while (pending.length) {
    const pid = pending.shift();
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    let raw = '';
    try { raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    for (const child of raw.trim().split(/\s+/).filter(Boolean).map(Number)) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

export async function verifyOwnedProcess(state) {
  if (!state?.pid || !state?.start_ticks) return false;
  const identity = await readProcessIdentity(state.pid);
  if (!identity || identity.start_ticks !== String(state.start_ticks)) return false;
  return identity.command.includes(state.runner_script) && identity.command.includes(state.checkpoint);
}

async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifyModel(model, env) {
  const { stdout } = await execFileAsync('pi', ['--list-models'], { env, maxBuffer: 16 * 1024 * 1024 });
  const [provider, ...rest] = String(model).split('/');
  const name = rest.join('/');
  const found = stdout.split('\n').some(line => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === provider && fields[1] === name;
  });
  if (!found) throw new Error(`model is not registered in scoped Pi configuration: ${model}`);
}

async function plannedUnits(options, context) {
  if ((options.job || 'extraction') === 'replay-gate') {
    const rows = JSON.parse(await fs.readFile(path.resolve(options['failed-units']), 'utf8'));
    const outcome = options['outcome-class'] || 'ok:unparseable';
    const replay = new Set(rows.filter(row => row.outcome === outcome)
      .map(row => String(row.tag || '').replace(/^extract:/, '')).filter(Boolean));
    return replay.size + Math.max(0, Number(options['control-windows'] || 0));
  }
  if (options['window-ids']) {
    const value = JSON.parse(await fs.readFile(path.resolve(options['window-ids']), 'utf8'));
    const ids = Array.isArray(value) ? value : value.window_ids;
    if (!Array.isArray(ids)) throw new Error('--window-ids must name a JSON array or {"window_ids": [...]}');
    return new Set(ids).size;
  }
  return context.windows.size;
}

function fmtMoney(value) { return value == null ? '—' : `$${Number(value).toFixed(4)}`; }
function fmtRate(value) { return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }

function renderScreen({ options, telemetry, preflight, state, running, descendants, message }) {
  const u = telemetry.units, b = telemetry.budget, c = telemetry.claims;
  const a = telemetry.attempts;
  const rejection = c.rejection_codes.length
    ? c.rejection_codes.slice(0, 8).map(([code, count]) => `  ${String(count).padStart(4)}  ${code}`).join('\n')
    : '  (none yet)';
  const perWindow = Object.entries(c.by_window).slice(-8)
    .map(([id, count]) => `  ${String(count).padStart(4)}  ${id.slice(0, 28)}…`).join('\n') || '  (none yet)';
  return [
    '\u001b[2J\u001b[H',
    'estate-map run controller',
    `job ${options.job || 'extraction'}  state ${running ? 'RUNNING' : state?.exit ? `EXIT ${state.exit.code ?? state.exit.signal}` : 'IDLE'}`,
    `owner pid ${state?.pid || '—'}  descendants ${descendants.length ? descendants.join(', ') : '—'}`,
    `load ${preflight.load_1m.toFixed(2)} / ${preflight.max_load_1m.toFixed(2)}  cpus ${preflight.cpu_count}  ${preflight.pass ? 'READY' : 'BLOCKED'}`,
    '',
    `units     ${u.completed}/${u.planned ?? '?'} complete  ${u.started} started  ${u.in_flight} in-flight  ${u.orphaned_started} orphaned`,
    a ? `attempts  ${a.completed}/${a.started} complete  ${a.retry_schedules} retries  ${a.recovered} recovered  ${a.terminal_incomplete} terminal` : null,
    `budget    ${fmtMoney(b.known_cost_usd)} known  ${fmtMoney(b.cap_remaining_usd)} remaining  ${b.unpriced_attempts} unpriced`,
    `claims    ${c.promoted} promoted  ${c.rejected} rejected  ${fmtRate(c.promotion_rate)} promotion  ${c.truncated_units} truncated`,
    '',
    'rejection codes', rejection,
    '',
    'latest per-window promoted claims', perWindow,
    '',
    running ? '[x] graceful pause  [K] force-stop (poisons in-flight receipts)  [q] refused while running'
      : '[s] start fresh  [r] resume clean checkpoint  [q] quit',
    message ? `\n${message}` : '',
  ].filter(line => line !== null).join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseControllerArgs(argv);
  if (options.help) {
    process.stdout.write('usage: tui-run-controller.mjs --job extraction|replay-gate --manifest FILE --bounds FILE --checkpoint FILE --output FILE [--window-ids FILE] [--pause-load N] [--max-load N] [--action start|resume|status]\n');
    return;
  }
  requireOptions(options);
  const cwd = process.cwd();
  const checkpoint = path.resolve(cwd, options.checkpoint);
  const output = path.resolve(cwd, options.output);
  const statePath = path.resolve(cwd, options['state-file'] || `${checkpoint}.controller.json`);
  const logPath = path.resolve(cwd, options['log-file'] || `${checkpoint}.runner.log`);
  const command = buildRunnerCommand(options, { cwd });
  const context = await loadWideContextTelemetryContext({
    manifestPath: path.resolve(cwd, options.manifest),
    boundsPath: options.bounds ? path.resolve(cwd, options.bounds) : null,
    estateRoot: path.resolve(cwd, options.estate || 'estate'),
    contract: options.contract || 'v10',
  });
  const maxCost = Number(options['max-cost'] || context.bounds.max_known_cost_usd || 0);
  const softLoadLimit = options['pause-load'] == null ? null : Number(options['pause-load']);
  const hardLoadLimit = options['max-load'] == null ? null : Number(options['max-load']);
  if (softLoadLimit != null && (!Number.isFinite(softLoadLimit) || softLoadLimit <= 0)) {
    throw new Error('--pause-load must be positive');
  }
  if (hardLoadLimit != null && (!Number.isFinite(hardLoadLimit) || hardLoadLimit <= 0)) {
    throw new Error('--max-load must be positive');
  }
  if (softLoadLimit != null && hardLoadLimit != null && softLoadLimit >= hardLoadLimit) {
    throw new Error('--pause-load must be lower than --max-load');
  }
  const loadCircuitSamples = Number(options['load-circuit-samples'] || 2);
  if (!Number.isInteger(loadCircuitSamples) || loadCircuitSamples < 1) {
    throw new Error('--load-circuit-samples must be a positive integer');
  }
  const telemetryReader = new CheckpointTelemetry({ context, maxKnownCostUsd: maxCost });
  const totalUnits = await plannedUnits(options, context);
  let state = await readState(statePath);
  let child = null;
  let message = '';
  let ending = false;
  let loadPauseRequested = false;
  let childExitHandled = null;
  let controllerExitCode = 0;

  const persistLoad = async (preflight, { armCircuit = false } = {}) => {
    if (!state) return false;
    const previous = state.load_audit || null;
    const next = updateLoadAudit(previous, preflight, {
      armCircuit, overloadRequiredSamples: loadCircuitSamples,
    });
    const sampled = next.sample_count !== Number(previous?.sample_count || 0);
    const newPeak = next.peak_load_1m > Number(previous?.peak_load_1m || 0);
    const streakChanged = next.overload_streak !== Number(previous?.overload_streak || 0);
    const circuitOpened = next.circuit_events.length > Number(previous?.circuit_events?.length || 0);
    if (!sampled && !newPeak && !streakChanged && !circuitOpened) return false;
    state = { ...state, load_audit: next };
    await writeJsonAtomic(statePath, state);
    return circuitOpened;
  };

  const runningNow = async () => Boolean(state && await verifyOwnedProcess(state));
  const currentSnapshot = async () => {
    const running = await runningNow();
    await telemetryReader.refresh(checkpoint);
    return { running, telemetry: telemetryReader.snapshot({ running, plannedUnits: totalUnits }) };
  };

  const start = async mode => {
    if (await runningNow()) throw new Error(`owned runner ${state.pid} is already active`);
    loadPauseRequested = false;
    const before = await currentSnapshot();
    if (mode === 'start') {
      if (await exists(checkpoint)) throw new Error(`fresh start refused: checkpoint already exists: ${checkpoint}`);
      if (await exists(output)) throw new Error(`fresh start refused: output already exists: ${output}`);
    } else {
      if (!await exists(checkpoint)) throw new Error(`resume requires checkpoint: ${checkpoint}`);
      if (before.telemetry.units.orphaned_started) {
        throw new Error(`resume refused: checkpoint has ${before.telemetry.units.orphaned_started} orphaned started receipt(s)`);
      }
      const outputState = await resumeOutputState(output);
      if (outputState === 'complete') throw new Error(`resume refused: complete final output already exists: ${output}`);
      if (outputState === 'replaceable_nonfinal') message = 'resume will atomically replace the existing non-final output';
    }
    if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('PAID_GATE_CLOSED: set ASCRYBE_ENABLE_PAID_INFERENCE=1');
    const admission = hostPreflight({ maxLoad: softLoadLimit ?? hardLoadLimit });
    if (!admission.pass) throw new Error(`HOST_LOAD_TOO_HIGH: ${admission.load_1m} > ${admission.max_load_1m}`);
    const preflight = hostPreflight({ maxLoad: hardLoadLimit });
    const model = options.model || context.model;
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || path.join(cwd, 'pi-agent'),
      ASCRYBE_CONTROLLER_SESSION_ID: `controller:${Date.now()}:${process.pid}`,
    };
    await verifyModel(model, env);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const log = await fs.open(logPath, 'a');
    child = spawn(command.command, command.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`runner exited before ownership record: ${code ?? signal}`)));
      let attempts = 0;
      const inspect = async () => {
        const value = await readProcessIdentity(child.pid);
        if (value) resolve(value);
        else if (++attempts >= 200) reject(new Error('runner process identity did not appear in /proc'));
        else setTimeout(inspect, 10);
      };
      inspect().catch(reject);
    });
    state = {
      schema: RUN_CONTROLLER_SCHEMA,
      pid: child.pid,
      process_group: child.pid,
      start_ticks: identity.start_ticks,
      runner_script: command.args[1],
      checkpoint,
      output,
      log: logPath,
      command: [command.command, ...command.args],
      started_at: new Date().toISOString(),
      controller_session_id: env.ASCRYBE_CONTROLLER_SESSION_ID,
      mode,
      admission_preflight: { ...admission, at: new Date().toISOString() },
      soft_load_limit: softLoadLimit,
      soft_load_pauses: [],
      load_audit: updateLoadAudit(null, preflight, { overloadRequiredSamples: loadCircuitSamples }),
    };
    await writeJsonAtomic(statePath, state);
    const append = chunk => log.appendFile(chunk).catch(() => {});
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let resolveExitHandled;
    childExitHandled = new Promise(resolve => { resolveExitHandled = resolve; });
    child.once('exit', async (code, signal) => {
      let artifact = null;
      let artifactError = null;
      if (code !== 75) {
        try { artifact = JSON.parse(await fs.readFile(output, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') artifactError = error.message;
        }
      }
      const completion = classifyRunnerCompletion({
        code, signal, artifact, artifactError, pauseRequested: loadPauseRequested,
      });
      controllerExitCode = completion.controller_code;
      state = {
        ...state,
        exit: {
          code, signal, at: new Date().toISOString(),
          classification: completion.classification,
          controller_code: completion.controller_code,
          artifact_status: completion.artifact_status,
          pending_units: completion.pending_units,
          quarantined_units: completion.quarantined_units,
        },
      };
      await writeJsonAtomic(statePath, state).catch(() => {});
      await log.sync().catch(() => {});
      await log.close().catch(() => {});
      child = null;
      message = completion.message;
      resolveExitHandled();
    });
    message = `started owned runner ${child.pid}`;
  };

  const stop = async ({ force = false } = {}) => {
    if (!await runningNow()) throw new Error('no verified owned runner is active');
    if (force) {
      process.kill(-Number(state.process_group), 'SIGKILL');
      message = 'force-stopped owned process group; unmatched started receipts are now poisoned';
    } else {
      process.kill(Number(state.pid), 'SIGINT');
      message = 'pause requested; waiting for owned in-flight units to finish';
    }
  };

  const action = options.action || null;
  if (action) {
    if (!['start', 'resume', 'status'].includes(action)) throw new Error('--action must be start, resume, or status');
    if (action !== 'status') await start(action);
    let last = '';
    while (true) {
      let { running, telemetry } = await currentSnapshot();
      if (!running && childExitHandled) {
        await childExitHandled;
        ({ running, telemetry } = await currentSnapshot());
      }
      const preflight = hostPreflight({ maxLoad: options['max-load'] ?? null });
      const circuit = running && action !== 'status'
        ? await persistLoad(preflight, { armCircuit: true }) : false;
      if (circuit) {
        loadPauseRequested = true;
        await stop();
        message = `HOST_LOAD_CIRCUIT: sustained ${preflight.load_1m} > ${preflight.max_load_1m}; graceful pause requested`;
      } else {
        const softPreflight = softLoadLimit == null ? null : hostPreflight({ maxLoad: softLoadLimit });
        if (action !== 'status' && shouldRequestSoftLoadPause({
          running, hardCircuit: circuit, pauseRequested: loadPauseRequested, softPreflight,
        })) {
          loadPauseRequested = true;
          state = { ...state, soft_load_pauses: [...(state.soft_load_pauses || []), {
            at: new Date().toISOString(), load_1m: softPreflight.load_1m,
            max_load_1m: softPreflight.max_load_1m,
          }] };
          await writeJsonAtomic(statePath, state);
          await stop();
          message = `HOST_LOAD_SOFT_PAUSE: ${softPreflight.load_1m} > ${softPreflight.max_load_1m}; graceful pause requested`;
        }
      }
      const descendants = running ? await listOwnedDescendants(state.pid) : [];
      const softLoad = softLoadLimit == null ? null : hostPreflight({ maxLoad: softLoadLimit });
      const payload = { running, pid: state?.pid || null, descendants, load: preflight,
        soft_load: softLoad, ...telemetry, message };
      const rendered = JSON.stringify(payload);
      if (rendered !== last) process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${rendered}\n`);
      last = rendered;
      if (action === 'status' || !running) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return controllerExitCode;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive TUI requires a TTY; use --action start|resume|status');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const onKey = async key => {
    try {
      if (key === 's') await start('start');
      else if (key === 'r') await start('resume');
      else if (key === 'x') await stop();
      else if (key === 'K') await stop({ force: true });
      else if (key === 'q' || key === '\u0003') {
        if (await runningNow()) message = 'runner is active; pause it before quitting';
        else ending = true;
      }
    } catch (error) { message = error.message; }
  };
  process.stdin.on('data', onKey);
  try {
    while (!ending) {
      const { running, telemetry } = await currentSnapshot();
      const preflight = hostPreflight({ maxLoad: options['max-load'] ?? null });
      const circuit = running
        ? await persistLoad(preflight, { armCircuit: true }) : false;
      if (circuit) {
        loadPauseRequested = true;
        await stop();
        message = `HOST_LOAD_CIRCUIT: sustained ${preflight.load_1m} > ${preflight.max_load_1m}; graceful pause requested`;
      } else {
        const softPreflight = softLoadLimit == null ? null : hostPreflight({ maxLoad: softLoadLimit });
        if (shouldRequestSoftLoadPause({
          running, hardCircuit: circuit, pauseRequested: loadPauseRequested, softPreflight,
        })) {
          loadPauseRequested = true;
          state = { ...state, soft_load_pauses: [...(state.soft_load_pauses || []), {
            at: new Date().toISOString(), load_1m: softPreflight.load_1m,
            max_load_1m: softPreflight.max_load_1m,
          }] };
          await writeJsonAtomic(statePath, state);
          await stop();
          message = `HOST_LOAD_SOFT_PAUSE: ${softPreflight.load_1m} > ${softPreflight.max_load_1m}; graceful pause requested`;
        }
      }
      const descendants = running ? await listOwnedDescendants(state.pid) : [];
      process.stdout.write(renderScreen({ options, telemetry, preflight, state, running, descendants, message }));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    process.stdin.off('data', onKey);
    process.stdin.setRawMode(false);
    process.stdout.write('\u001b[2J\u001b[H');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => {
    if (Number.isInteger(code)) process.exitCode = code;
  }).catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
