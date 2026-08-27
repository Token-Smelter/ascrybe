// A model stub that spends its first turn on a tool call and then finalizes. The default fixture
// finalizes immediately, which cannot exercise the tool-invocation path at all.
export async function run(request) {
  const priorToolTurn = (request.events ?? []).some(event => event.tool || event.tool_error);
  if (!priorToolTurn) {
    return { tool_call: { name: 'estate_query', arguments: { command: 'search' } } };
  }
  return { final: request.context.tool_schema.stub_final };
}
