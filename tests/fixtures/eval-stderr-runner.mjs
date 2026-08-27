export async function run(request) {
  return { emission: { final: request.context.tool_schema.stub_final }, usage: { totalTokens: 1 }, stderr: 'provider diagnostic' };
}
