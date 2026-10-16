// Durable leased work queue for concurrent paid units.
//
// WHY THIS EXISTS. The pilot ran strictly sequentially with a global circuit: the FIRST failure of
// any kind stopped everything. At 32-way concurrency that design would halt the entire fleet because
// one unit returned 65 claims instead of 64. Scale needs the opposite defaults: quarantine the unit,
// keep the fleet running, and stop only when a failure RATE says the provider or an invariant is
// broken.
//
// CUSTODY RULE THAT DOES NOT BEND. A lease that expires does NOT return its unit to `pending`. The
// unit may already have been dispatched and billed, so it becomes `acceptance_unknown` and requires
// an explicit decision. Blind redispatch is how you pay twice for the same inference.
import { UNIT_OUTCOMES } from './outcome-algebra.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const UNIT_STATES = Object.freeze([
  'pending', 'leased', 'done', 'quarantined', 'acceptance_unknown', 'skipped_bound',
]);

/** Outcomes that indicate the PROVIDER or an INVARIANT is broken, not just this unit's content. */
export const FLEET_FAILURE_OUTCOMES = Object.freeze(['acceptance_unknown', 'provider_failure', 'fleet_stop']);

export class UnitQueueError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'UnitQueueError';
    this.code = code;
    this.detail = detail;
  }
}

const nowMs = () => Date.now();

/**
 * @param units          [{ id, payload }] — `id` must be the content-addressed dispatch key.
 * @param lease_ms       lease duration; a worker must heartbeat within it.
 * @param fleet_stop     { failure_rate, min_samples } over a sliding window of terminal outcomes.
 * @param onTerminal     optional async hook for durable recording (checkpoint write).
 */
export function createUnitQueue({ units = [], lease_ms = 900000, fleet_stop = { failure_rate: 0.5, min_samples: 6 }, clock = nowMs, onTerminal = null } = {}) {
  const rows = new Map();
  for (const unit of units) {
    if (!unit || typeof unit.id !== 'string' || !unit.id.trim()) throw new UnitQueueError('INVALID_UNIT', 'each unit needs a stable string id');
    if (rows.has(unit.id)) throw new UnitQueueError('DUPLICATE_UNIT', `duplicate unit id ${unit.id}`);
    rows.set(unit.id, { id: unit.id, payload: unit.payload, state: 'pending', lease: null, outcome: null, findings: [], attempts: 0 });
  }
  const order = [...rows.keys()];
  const terminalWindow = [];
  let stopped = null;

  const recordTerminal = outcome => {
    terminalWindow.push(outcome);
    if (terminalWindow.length > 64) terminalWindow.shift();
    if (outcome === 'fleet_stop') {
      stopped = { reason: 'explicit_fleet_stop', failures: 1, samples: terminalWindow.length, failure_rate: 1 };
      return;
    }
    const samples = terminalWindow.length;
    if (samples >= Number(fleet_stop.min_samples || 6)) {
      const failures = terminalWindow.filter(o => FLEET_FAILURE_OUTCOMES.includes(o)).length;
      if (failures / samples > Number(fleet_stop.failure_rate ?? 0.5)) {
        stopped = { reason: 'fleet_failure_rate_exceeded', failures, samples, failure_rate: Number((failures / samples).toFixed(4)) };
      }
    }
  };

  const expireLeases = () => {
    const t = clock();
    for (const row of rows.values()) {
      if (row.state !== 'leased' || !row.lease) continue;
      if (t <= row.lease.expires_at) continue;
      // Possibly dispatched and billed. Never silently requeue.
      row.state = 'acceptance_unknown';
      row.outcome = 'acceptance_unknown';
      row.findings.push({ code: 'LEASE_EXPIRED', worker: row.lease.worker, leased_at: row.lease.leased_at, expired_at: row.lease.expires_at });
      row.lease = null;
      recordTerminal('acceptance_unknown');
    }
  };

  const api = {
    /** Claim the next pending unit. Returns null when nothing is claimable or the fleet is stopped. */
    claim(worker) {
      if (!worker) throw new UnitQueueError('WORKER_REQUIRED', 'claim requires a worker id');
      expireLeases();
      if (stopped) return null;
      for (const id of order) {
        const row = rows.get(id);
        if (row.state !== 'pending') continue;
        const t = clock();
        row.state = 'leased';
        row.attempts += 1;
        row.lease = { worker, leased_at: t, expires_at: t + Number(lease_ms), dispatch_key: sha256(stableStringify({ id, attempt: row.attempts }).trim()) };
        return Object.freeze({ id: row.id, payload: row.payload, dispatch_key: row.lease.dispatch_key, attempt: row.attempts });
      }
      return null;
    },

    heartbeat(worker, id) {
      const row = rows.get(id);
      if (!row || row.state !== 'leased') return false;
      if (row.lease.worker !== worker) throw new UnitQueueError('LEASE_NOT_HELD', `${worker} does not hold the lease on ${id}`);
      row.lease.expires_at = clock() + Number(lease_ms);
      return true;
    },

    /** Terminal settle. `outcome` must be a declared unit outcome. */
    async settle(worker, id, outcome, { findings = [], value = null } = {}) {
      if (!UNIT_OUTCOMES.includes(outcome)) throw new UnitQueueError('INVALID_OUTCOME', `unknown outcome ${outcome}`);
      const row = rows.get(id);
      if (!row) throw new UnitQueueError('UNKNOWN_UNIT', `unknown unit ${id}`);
      if (row.state === 'leased' && row.lease.worker !== worker) throw new UnitQueueError('LEASE_NOT_HELD', `${worker} does not hold the lease on ${id}`);
      // A unit whose lease already expired keeps acceptance_unknown; a late worker result may not
      // overwrite the custody record, but its findings are retained.
      if (row.state === 'acceptance_unknown') {
        row.findings.push({ code: 'LATE_RESULT_AFTER_LEASE_EXPIRY', outcome, ...(findings.length ? { findings } : {}) });
        return Object.freeze({ ...row, late: true });
      }
      row.state = outcome === 'ok' || outcome === 'partial' || outcome === 'overflow' ? 'done'
        : outcome === 'quarantined' || outcome === 'provider_failure' || outcome === 'fleet_stop' ? 'quarantined'
        : outcome === 'unresolved_due_to_bound' ? 'skipped_bound'
        : outcome === 'acceptance_unknown' ? 'acceptance_unknown' : 'done';
      row.outcome = outcome;
      row.value = value;
      row.lease = null;
      if (findings.length) row.findings.push(...findings);
      recordTerminal(outcome);
      if (onTerminal) await onTerminal({ id, outcome, findings: row.findings, value });
      return Object.freeze({ ...row });
    },

    status() {
      expireLeases();
      const byState = {};
      for (const row of rows.values()) byState[row.state] = (byState[row.state] || 0) + 1;
      return Object.freeze({
        total: rows.size,
        by_state: byState,
        stopped,
        terminal_samples: terminalWindow.length,
      });
    },

    get stopped() { return stopped; },
    rows: () => [...rows.values()].map(row => Object.freeze({ ...row })),
  };
  return Object.freeze(api);
}

/**
 * Drive a queue with N concurrent workers. A worker's own throw quarantines ITS unit and the worker
 * continues; only the queue's fleet-stop rule halts everything. This is the inversion the pilot
 * needed: per-unit failure must not be fleet-fatal.
 */
export async function runQueue({
  queue, concurrency = 4, process: processUnit, heartbeat_every_ms = 0, signal = null,
  worker_start_delay_ms = 0, initial_worker_concurrency = concurrency,
}) {
  if (typeof processUnit !== 'function') throw new UnitQueueError('PROCESS_REQUIRED', 'runQueue requires a process(unit) function');
  const startDelay = Number(worker_start_delay_ms);
  if (!Number.isFinite(startDelay) || startDelay < 0) {
    throw new UnitQueueError('INVALID_WORKER_START_DELAY', 'worker_start_delay_ms must be a non-negative finite number');
  }
  const initialWorkers = Number(initial_worker_concurrency);
  if (!Number.isInteger(initialWorkers) || initialWorkers < 1 || initialWorkers > Math.max(1, concurrency)) {
    throw new UnitQueueError('INVALID_INITIAL_WORKER_CONCURRENCY',
      'initial_worker_concurrency must be an integer from 1 through concurrency');
  }
  let successfulCompletions = 0;
  const admissionWaiters = new Set();
  const wakeAdmission = () => {
    for (const resolve of admissionWaiters) resolve();
    admissionWaiters.clear();
  };
  const onAbort = () => wakeAdmission();
  signal?.addEventListener?.('abort', onAbort);
  const awaitAdmission = async index => {
    if (index < initialWorkers) return true;
    const requiredCompletions = index - initialWorkers + 1;
    while (successfulCompletions < requiredCompletions) {
      if (signal?.aborted || queue.stopped || !queue.status().by_state?.pending) return false;
      await new Promise(resolve => admissionWaiters.add(resolve));
    }
    return !signal?.aborted && !queue.stopped && Boolean(queue.status().by_state?.pending);
  };
  const worker = async (name, index) => {
    // Ramp admission instead of leasing the whole fleet in one event-loop turn. This gives an
    // external host-load controller time to request a cooperative pause before every configured
    // worker has dispatched paid work. Already leased units still drain under the custody rule.
    if (index > 0 && startDelay > 0) await new Promise(resolve => setTimeout(resolve, index * startDelay));
    if (!await awaitAdmission(index)) return;
    while (true) {
      // Cooperative pause: never strand a paid dispatch. Existing workers finish their leased unit,
      // then observe the signal before claiming another one.
      if (signal?.aborted) return;
      const unit = queue.claim(name);
      if (!unit) return;
      wakeAdmission();
      let timer = null;
      let admitsAnotherWorker = false;
      if (heartbeat_every_ms > 0) timer = setInterval(() => { try { queue.heartbeat(name, unit.id); } catch { /* lease lost */ } }, heartbeat_every_ms);
      try {
        const result = await processUnit(unit, name);
        const outcome = result?.outcome || 'ok';
        await queue.settle(name, unit.id, outcome, { findings: result?.findings || [], value: result?.value ?? null });
        admitsAnotherWorker = ['ok', 'partial', 'overflow'].includes(outcome);
      } catch (error) {
        const declared = UNIT_OUTCOMES.includes(error?.unit_outcome) ? error.unit_outcome : 'quarantined';
        await queue.settle(name, unit.id, declared, {
          findings: [{ code: error.code || 'WORKER_THROW', message: error.message, detail: error.detail || null }],
        });
      } finally {
        if (timer) clearInterval(timer);
        if (admitsAnotherWorker) successfulCompletions += 1;
        wakeAdmission();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => worker(`w${i + 1}`, i)));
    return queue.status();
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}
