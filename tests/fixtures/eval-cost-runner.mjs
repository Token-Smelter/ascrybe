import { existsSync, writeFileSync } from 'node:fs';

export async function run(request) {
  const retryMarker = request.context.tool_schema.retry_marker;
  if (retryMarker && !existsSync(retryMarker)) {
    writeFileSync(retryMarker, 'attempted\n');
    const error = new Error('provider temporarily unavailable');
    error.code = 'EVAL_MODEL_TRANSIENT';
    throw error;
  }
  const reportedCosts = request.context.tool_schema.reported_costs ?? [];
  const total = reportedCosts[request.turn - 1];
  const usage = { totalTokens: 1 };
  if (Number.isFinite(total)) usage.cost = { total };
  if (request.context.tool_schema.two_turn && request.turn === 1) {
    return { emission: { tool_call: { name: 'probe', arguments: {} } }, usage };
  }
  return { emission: { final: request.context.tool_schema.stub_final }, usage };
}
