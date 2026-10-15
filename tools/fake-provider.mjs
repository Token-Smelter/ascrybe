// Scripted zero-spend provider doubles for state-machine testing.
//
// WHY THIS EXISTS. Every defect in the recursive pilot was reachable without spending a cent, but we
// only met them one paid call at a time. This module makes the whole failure surface addressable
// offline: cap boundaries, malformed-among-valid, timeout edges, crash points, and replay of every
// recorded failure state. Nothing here contacts a provider; cost is always zero.
import { classifyBillingStatus, emptyInferenceUsage } from './inference-custody.mjs';

export const CRASH_POINTS = Object.freeze(['after_reservation', 'after_dispatch', 'before_receipt_fsync']);

const usage = ({ priced = true, tokens = 10 } = {}) => ({
  ...emptyInferenceUsage(),
  input_tokens: tokens,
  output_tokens: Math.ceil(tokens / 4),
  total_tokens: tokens + Math.ceil(tokens / 4),
  cost: priced ? 0.01 : 0,
  cost_reported: priced,
});

const result = ({ outcome = 'ok', json = null, text = null, accepted = true, priced = true } = {}) => {
  const u = usage({ priced });
  const body = text !== null ? text : (json !== null ? JSON.stringify(json) : '');
  return {
    text: body,
    json: outcome === 'ok' ? json : null,
    usage: u,
    model: 'fake/provider',
    outcome,
    accepted,
    billing_status: classifyBillingStatus({ outcome, usage: u, accepted }),
  };
};

/** Emit exactly `count` well-formed claim objects, optionally corrupting one of them. */
export function claimPayload({ count, malformed_index = null, file = 'doc.md', start = 1, end = 1 }) {
  const claims = Array.from({ length: count }, (_, i) => ({
    subject_ref: `concept:item-${i}`,
    subject_kind: 'concept',
    unresolved_subject: null,
    referent_status: 'resolved',
    predicate_family: 'states',
    object_or_value: `fact ${i}`,
    polarity: 'affirmed',
    modality: 'descriptive',
    quantifier: 'unspecified',
    scope: {},
    valid_time: {},
    source_spans: [{ role: 'primary', file, start, end }],
  }));
  if (malformed_index !== null && claims[malformed_index]) {
    delete claims[malformed_index].predicate_family; // triggers MISSING_CLAIM_FIELDS
  }
  return { claims };
}

/**
 * A provider whose behaviour is fully scripted per call.
 * `script` is an array of directives consumed in order; the last one repeats.
 *
 * Directive shapes:
 *   { kind:'ok', json }                              — normal priced success
 *   { kind:'claims', count, malformed_index }        — claim payload, optionally with one bad item
 *   { kind:'timeout', priced }                       — accepted timeout (priced or unpriced)
 *   { kind:'output_limit' }                          — answer exceeded the ceiling
 *   { kind:'unparseable' }                           — priced but not JSON
 *   { kind:'provider_error' }                        — provider-side failure
 *   { kind:'crash', at }                             — throw at a named crash point
 *   { kind:'slow', ms }                              — resolve after a delay (timeout-edge tests)
 */
export function createScriptedProvider({ script = [{ kind: 'ok', json: {} }], model = 'fake/provider' } = {}) {
  const calls = [];
  let index = 0;
  const per_call = [];
  return {
    kind: 'fake',
    model,
    calls: () => calls.slice(),
    async complete({ prompt, tag } = {}) {
      const directive = script[Math.min(index, script.length - 1)];
      index += 1;
      calls.push({ tag, directive: directive.kind, prompt_bytes: Buffer.byteLength(String(prompt || ''), 'utf8') });
      per_call.push({ tag, model, outcome: directive.kind, cost: 0, cost_reported: false, input_tokens: 0, output_tokens: 0, total_tokens: 0, billing_status: 'not_billable', accepted: true });
      switch (directive.kind) {
        case 'ok': return result({ json: directive.json ?? {} });
        case 'claims': return result({ json: claimPayload(directive) });
        case 'timeout': return result({ outcome: 'timeout', accepted: true, priced: directive.priced === true });
        case 'output_limit': return result({ outcome: 'output_limit', accepted: true, priced: false });
        case 'unparseable': return result({ outcome: 'ok:unparseable', text: 'not json at all', accepted: true });
        case 'provider_error': return result({ outcome: 'error:provider', accepted: true, priced: false });
        case 'slow': {
          await new Promise(resolve => setTimeout(resolve, Number(directive.ms || 0)));
          return result({ json: directive.json ?? {} });
        }
        case 'crash': {
          const error = new Error(`fake crash at ${directive.at}`);
          error.code = 'FAKE_CRASH';
          error.crash_point = directive.at;
          throw error;
        }
        default: throw new Error(`unknown directive ${directive.kind}`);
      }
    },
    stats: () => ({ kind: 'fake', calls: per_call.length, cost: 0, cost_status: 'complete', unpriced_attempts: 0, models: [model], per_call: per_call.slice() }),
  };
}

/** A provider that fails if called more than `limit` times — proves no silent re-purchase. */
export function createNoRedispatchProvider(limit = 0) {
  let count = 0;
  return {
    kind: 'fake-guard',
    model: 'fake/guard',
    count: () => count,
    async complete() {
      count += 1;
      if (count > limit) {
        const error = new Error(`FORBIDDEN_REDISPATCH: call ${count} exceeds allowance ${limit}`);
        error.code = 'FORBIDDEN_REDISPATCH';
        throw error;
      }
      return result({ json: {} });
    },
    stats: () => ({ kind: 'fake-guard', calls: 0, cost: 0, cost_status: 'complete', unpriced_attempts: 0, models: ['fake/guard'], per_call: [] }),
  };
}
