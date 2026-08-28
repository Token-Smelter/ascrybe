// Fail-closed custody primitives shared by every paid inference surface.
// Unknown acceptance or missing provider price is never represented as zero-cost certainty.

export const INFERENCE_CUSTODY_POLICY = 'single-dispatch-durable-unit-circuit-break@1';
export const DEFAULT_MAX_INFERENCE_PROMPT_BYTES = 128 * 1024;
export const DEFAULT_MAX_INFERENCE_EVENT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_INFERENCE_ANSWER_BYTES = 1 * 1024 * 1024;

export class InferenceCircuitOpenError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'InferenceCircuitOpenError';
    this.code = 'INFERENCE_CIRCUIT_OPEN';
    this.detail = detail;
    // Queue drivers must not demote a paid-work circuit break to an ordinary content quarantine.
    // Unknown acceptance participates in the rate circuit; an explicit budget/invariant circuit
    // stops new dispatch immediately.
    this.unit_outcome = detail.unit_outcome === 'acceptance_unknown'
      ? 'acceptance_unknown'
      : detail.unit_outcome === 'provider_failure' ? 'provider_failure' : 'fleet_stop';
  }
}

export function openInferenceCircuit(message, detail = {}) {
  throw new InferenceCircuitOpenError(message, detail);
}

export class InferencePreflightError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'InferencePreflightError';
    this.code = code;
    this.detail = detail;
  }
}

export function assertInferencePromptWithinLimit(prompt, maxBytes = DEFAULT_MAX_INFERENCE_PROMPT_BYTES) {
  const bytes = Buffer.byteLength(String(prompt || ''), 'utf8');
  if (bytes > maxBytes) throw new InferencePreflightError('INFERENCE_PROMPT_TOO_LARGE', `prompt is ${bytes} bytes; limit is ${maxBytes}`, { bytes, max_bytes: maxBytes });
  return bytes;
}
export const UNPRICED_BILLING_STATUSES = Object.freeze([
  'accepted_usage_unknown',
  'acceptance_unknown',
  'usage_reported_cost_unknown',
]);

export const emptyInferenceUsage = () => ({
  cost: 0,
  cost_reported: false,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
});

const hasReportedUsage = usage => Number(usage?.total_tokens || 0) > 0
  || Number(usage?.input_tokens || 0) > 0
  || Number(usage?.output_tokens || 0) > 0;
/** Whether a provider actually stated a cost. A zero it never claimed is not a zero. */
export const hasReportedCost = usage => usage?.cost_reported === true || Number(usage?.cost || 0) > 0;

export function classifyBillingStatus({ outcome, usage, accepted }) {
  if (accepted === false) return 'not_accepted';
  if (hasReportedUsage(usage) || hasReportedCost(usage)) {
    if (!hasReportedCost(usage)) return 'usage_reported_cost_unknown';
    return /timeout|crash|output_limit|interrupted/i.test(String(outcome || '')) ? 'reported_partial' : 'reported';
  }
  return accepted === true ? 'accepted_usage_unknown' : 'acceptance_unknown';
}

export const isUnpricedBillingStatus = status => UNPRICED_BILLING_STATUSES.includes(status);

export function summarizeInferenceCalls(perCall, kind) {
  const calls = Array.isArray(perCall) ? perCall : [];
  const cost = calls.reduce((sum, call) => sum + Number(call.cost || 0), 0);
  const unpriced = calls.filter(call => isUnpricedBillingStatus(call.billing_status)).length;
  return {
    kind,
    calls: calls.length,
    cost: Number(cost.toFixed(6)),
    cost_status: unpriced ? 'lower_bound' : 'complete',
    unpriced_attempts: unpriced,
    models: [...new Set(calls.map(call => call.model).filter(Boolean))],
    per_call: calls.slice(),
  };
}

export function interruptedInferenceCustody({ model, tag, kind = 'unknown' }) {
  const usage = emptyInferenceUsage();
  const billing_status = 'acceptance_unknown';
  const outcome = 'interrupted:completion_unknown';
  const result = {
    text: '',
    json: null,
    usage,
    model,
    outcome,
    accepted: null,
    billing_status,
    attempts: 1,
    retry_policy: 'resume-retry-suppressed',
  };
  const model_stats = {
    model,
    kind,
    calls: 1,
    cost: 0,
    cost_status: 'lower_bound',
    unpriced_attempts: 1,
    models: model ? [model] : [],
    per_call: [{
      tag,
      model,
      outcome,
      accepted: null,
      billing_status,
      cost: 0,
      cost_reported: false,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }],
  };
  return { result, model_stats };
}
