export const MODEL_FAILURE_CODES = Object.freeze({
  transient: 'EVAL_MODEL_TRANSIENT',
  unavailable: 'EVAL_MODEL_UNAVAILABLE',
});

export function modelErrorClass(error) {
  if (error?.code === MODEL_FAILURE_CODES.transient) return 'transient';
  if (error?.code === MODEL_FAILURE_CODES.unavailable) return 'model_unavailable';
  return 'deterministic';
}

export async function retryModelCall({ call, attempts = 3, backoff_ms = 4000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), checkpoint }) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('model retry attempts must be a positive integer');
  const events = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await call();
      const event = { type: 'model_attempt', attempt, outcome: 'success' };
      events.push(event); await checkpoint?.(event);
      return { result, attempts_used: attempt, attempts: events };
    } catch (error) {
      const error_class = modelErrorClass(error);
      const delay_ms = attempt < attempts && error_class !== 'deterministic' ? backoff_ms * attempt : 0;
      const event = { type: 'model_attempt', attempt, outcome: 'error', error_class, error_code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 2_048), stderr: error?.stderr ?? null, delay_ms };
      events.push(event); await checkpoint?.(event);
      if (error_class === 'deterministic') return { error, error_class, attempts_used: attempt, attempts: events };
      if (attempt === attempts) return { error, error_class: 'model_unavailable', attempts_used: attempt, attempts: events };
      await sleep(delay_ms);
    }
  }
  throw new Error('unreachable retry state');
}
