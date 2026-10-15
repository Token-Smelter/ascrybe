// Typed outcomes and declarative bounds for paid work.
//
// WHY THIS EXISTS. Ten separate stops in the recursive pilot shared one cause: exception-driven
// control flow crossed the paid-call boundary without a total outcome algebra or a declared salvage
// granularity. A bound would raise, and an already-purchased response died with it. Here every bound
// must declare, up front, what it measures, when it is checked, what it does when reached, and what
// completeness guarantee survives. Exceptions are reserved for custody/invariant breaches.
import { sha256, stableStringify } from './lib.mjs';

/** Total outcome set for one paid unit. Every terminal state must be one of these. */
export const UNIT_OUTCOMES = Object.freeze([
  'ok',                        // validated, fully promotable
  'partial',                   // some items promotable; rest quarantined WITH findings
  'overflow',                  // more items than the cap; ALL retained; predeclared policy applied
  'quarantined',               // unit invalid; raw retained; nothing promoted
  'provider_failure',          // accepted/terminal provider or response failure; counts toward fleet stop
  'unresolved_due_to_bound',   // a scope bound stopped further work; explicit, recorded gap
  'acceptance_unknown',        // may have been dispatched/billed; no terminal usage observed
  'fleet_stop',                // provider-wide or invariant-wide failure RATE exceeded
]);

/** What a bound does when reached. `abort` is legal only for custody/invariant/spend bounds. */
export const BOUND_ACTIONS = Object.freeze(['clamp', 'paginate', 'quarantine', 'abort']);
export const BOUND_CHECKS = Object.freeze(['pre_dispatch', 'post_return']);
/** Only these bound kinds may declare action:'abort'. A scope bound may never abort. */
export const ABORT_ELIGIBLE_KINDS = Object.freeze(['spend', 'custody', 'invariant']);
export const BOUND_KINDS = Object.freeze(['scope', 'output', 'spend', 'custody', 'invariant']);

export class OutcomeAlgebraError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'OutcomeAlgebraError';
    this.code = code;
    this.detail = detail;
  }
}

const nonblank = value => typeof value === 'string' && value.trim().length > 0;

/**
 * Declare one bound. Every field is mandatory: the pilot's failures were all bounds whose behaviour
 * was implicit. `salvage_granularity` names the smallest unit that survives the bound being hit.
 */
export function declareBound(spec) {
  const { id, kind, measures, checked, action, salvage_granularity, completeness, replay_may_dispatch } = spec || {};
  if (!nonblank(id)) throw new OutcomeAlgebraError('BOUND_ID_REQUIRED', 'bound requires an id');
  if (!BOUND_KINDS.includes(kind)) throw new OutcomeAlgebraError('BOUND_KIND_INVALID', `${id}: kind must be one of ${BOUND_KINDS.join(', ')}`);
  if (!nonblank(measures)) throw new OutcomeAlgebraError('BOUND_MEASURES_REQUIRED', `${id}: must declare what it measures`);
  if (!BOUND_CHECKS.includes(checked)) throw new OutcomeAlgebraError('BOUND_CHECK_INVALID', `${id}: checked must be one of ${BOUND_CHECKS.join(', ')}`);
  if (!BOUND_ACTIONS.includes(action)) throw new OutcomeAlgebraError('BOUND_ACTION_INVALID', `${id}: action must be one of ${BOUND_ACTIONS.join(', ')}`);
  if (!nonblank(salvage_granularity)) throw new OutcomeAlgebraError('BOUND_SALVAGE_REQUIRED', `${id}: must declare salvage granularity`);
  if (!UNIT_OUTCOMES.includes(completeness)) throw new OutcomeAlgebraError('BOUND_COMPLETENESS_INVALID', `${id}: completeness must be a declared unit outcome`);
  if (typeof replay_may_dispatch !== 'boolean') throw new OutcomeAlgebraError('BOUND_REPLAY_REQUIRED', `${id}: must declare whether replay may issue new work`);
  // A scope bound reduces what we ATTEMPT; it must never destroy what was already bought.
  if (action === 'abort' && !ABORT_ELIGIBLE_KINDS.includes(kind)) {
    throw new OutcomeAlgebraError('SCOPE_BOUND_MAY_NOT_ABORT', `${id}: kind '${kind}' may not abort; use clamp/paginate/quarantine`, { id, kind });
  }
  const body = { id, kind, measures, checked, action, salvage_granularity, completeness, replay_may_dispatch };
  return Object.freeze({ ...body, digest: sha256(stableStringify(body).trim()) });
}

export function createBoundRegistry(specs = []) {
  const bounds = new Map();
  for (const spec of specs) {
    const bound = declareBound(spec);
    if (bounds.has(bound.id)) throw new OutcomeAlgebraError('DUPLICATE_BOUND', `duplicate bound id ${bound.id}`);
    bounds.set(bound.id, bound);
  }
  return Object.freeze({
    get: id => bounds.get(id) || null,
    list: () => [...bounds.values()].sort((a, b) => a.id.localeCompare(b.id)),
    digest: sha256(stableStringify([...bounds.values()].map(b => b.digest).sort()).trim()),
  });
}

/**
 * Maximum regions a depth/branching pair can produce: 1 + c + c^2 + ... + c^depth.
 * The pilot set depth 2, children 6 (=> 43 possible regions) alongside caps of 8 and 24, so those
 * caps could never bind together with the tree they authorized. That contradiction aborted a paid
 * run three times and is exactly what preflight must reject at config time.
 */
export function maxRegionsForTree({ max_depth, max_children_per_region }) {
  const depth = Number(max_depth), children = Number(max_children_per_region);
  if (!Number.isInteger(depth) || depth < 0) throw new OutcomeAlgebraError('INVALID_DEPTH', 'max_depth must be a non-negative integer');
  if (!Number.isInteger(children) || children < 1) throw new OutcomeAlgebraError('INVALID_CHILDREN', 'max_children_per_region must be a positive integer');
  let total = 0;
  for (let level = 0; level <= depth; level += 1) total += children ** level;
  return total;
}

/**
 * Static preflight over a bound set. Runs BEFORE any spend and returns every violation at once, so a
 * misconfiguration is a config-time error rather than a mid-run abort that destroys paid work.
 */
export function preflightBounds(bounds = {}, { registry = null } = {}) {
  const violations = [];
  const add = (code, message, detail = {}) => violations.push({ code, message, ...detail });
  const num = key => (bounds[key] === undefined ? null : Number(bounds[key]));

  const depth = num('max_depth');
  const children = num('max_children_per_region');
  const regions = num('max_regions_per_document');
  const planningCalls = num('max_planning_calls_per_document');

  if (depth !== null && children !== null) {
    const maxTree = maxRegionsForTree({ max_depth: depth, max_children_per_region: children });
    if (regions !== null && regions < maxTree) {
      add('REGION_CAP_BELOW_AUTHORIZED_TREE',
        `max_regions_per_document (${regions}) is below the ${maxTree} regions that depth ${depth} x ${children} children authorizes`,
        { max_regions_per_document: regions, authorized_max: maxTree });
    }
    if (planningCalls !== null && regions !== null && planningCalls < regions) {
      add('PLANNING_CAP_BELOW_REGION_CAP',
        `max_planning_calls_per_document (${planningCalls}) is below max_regions_per_document (${regions}); each region costs at most one planning call, so these can never both bind`,
        { max_planning_calls_per_document: planningCalls, max_regions_per_document: regions });
    }
  }

  const atomic = num('atomic_primary_bytes');
  const prompt = num('max_prompt_bytes');
  if (atomic !== null && prompt !== null && atomic >= prompt) {
    add('ATOMIC_EXCEEDS_PROMPT_CEILING',
      `atomic_primary_bytes (${atomic}) must leave headroom under max_prompt_bytes (${prompt}); an atomic region is embedded verbatim in the extraction prompt`,
      { atomic_primary_bytes: atomic, max_prompt_bytes: prompt });
  }

  const answer = num('max_answer_bytes');
  const event = num('max_event_bytes');
  if (answer !== null && event !== null && answer > event) {
    add('ANSWER_CEILING_ABOVE_TRANSPORT',
      `max_answer_bytes (${answer}) exceeds max_event_bytes (${event}); the answer cannot be larger than the stream that carries it`,
      { max_answer_bytes: answer, max_event_bytes: event });
  }

  // Timeout must exceed OBSERVED latency with margin. The pilot ran a 180s timeout against 144-155s
  // observed extraction latency and converted a normal slow call into a possibly-billed unpriced
  // attempt. Callers pass observed_latency_ms_p95 from calibration once it exists.
  const timeout = num('call_timeout_ms');
  const observed = num('observed_latency_ms_p95');
  if (timeout !== null && observed !== null && timeout < observed * 2) {
    add('TIMEOUT_MARGIN_TOO_THIN',
      `call_timeout_ms (${timeout}) is less than 2x observed p95 latency (${observed}); a slow-but-normal call would time out and become an unpriced, possibly-billed attempt`,
      { call_timeout_ms: timeout, observed_latency_ms_p95: observed });
  }

  const maxCalls = num('max_calls');
  if (maxCalls !== null && regions !== null && maxCalls < regions) {
    add('CALL_BUDGET_BELOW_REGION_CAP',
      `max_calls (${maxCalls}) is below max_regions_per_document (${regions}); the run cannot complete one document`,
      { max_calls: maxCalls, max_regions_per_document: regions });
  }

  if (registry) {
    for (const bound of registry.list()) {
      if (bound.action === 'abort' && !ABORT_ELIGIBLE_KINDS.includes(bound.kind)) {
        add('SCOPE_BOUND_DECLARES_ABORT', `bound ${bound.id} (kind ${bound.kind}) declares abort`, { bound: bound.id });
      }
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    checked_bounds: Object.freeze(Object.keys(bounds).sort()),
  });
}

/** Fail-closed wrapper: refuse to start paid work on an incoherent bound set. */
export function assertPreflight(bounds, options = {}) {
  const result = preflightBounds(bounds, options);
  if (!result.ok) {
    throw new OutcomeAlgebraError('BOUND_PREFLIGHT_FAILED',
      `bound preflight failed: ${result.violations.map(v => v.code).join(', ')}`,
      { violations: result.violations });
  }
  return result;
}

/**
 * Apply an output cap without destroying purchased items. NEVER silently truncates to "first N":
 * model ordering could bias selection. All items are retained; the policy records what happened.
 */
export function applyOutputCap({ items, max_items, policy = 'retain_all_mark_overflow' }) {
  const list = Array.isArray(items) ? items : [];
  const cap = Number(max_items);
  if (!Number.isInteger(cap) || cap < 1) throw new OutcomeAlgebraError('INVALID_OUTPUT_CAP', 'max_items must be a positive integer');
  if (list.length <= cap) return Object.freeze({ outcome: 'ok', retained: list, overflow: null });
  if (policy !== 'retain_all_mark_overflow') throw new OutcomeAlgebraError('UNSUPPORTED_CAP_POLICY', `unsupported cap policy ${policy}`);
  return Object.freeze({
    outcome: 'overflow',
    retained: list,
    overflow: Object.freeze({ returned: list.length, max_items: cap, policy, selection_bias_avoided: true }),
  });
}
