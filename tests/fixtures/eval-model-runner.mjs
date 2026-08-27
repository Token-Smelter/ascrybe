export async function run(request) {
  const serialized = JSON.stringify(request);
  for (const hidden of ['opaque-key', 'map-covered', 'stratum']) {
    if (serialized.includes(hidden)) throw new Error(`public evaluation request leaks ${hidden}`);
  }
  return { final: request.context.tool_schema.stub_final, worker_pid: process.pid };
}
