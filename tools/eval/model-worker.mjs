const [modelRunner] = process.argv.slice(2);

async function readRequest() {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  return JSON.parse(body);
}

try {
  if (!modelRunner?.startsWith('file:')) throw new Error('file URL model_runner required');
  const runner = await import(modelRunner);
  if (typeof runner.run !== 'function') throw new Error('model_runner must export run');
  process.stdout.write(JSON.stringify(await runner.run(await readRequest())));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema: 'estate-map/eval-model-worker-error/v1',
    code: typeof error?.code === 'string' ? error.code : null, message: String(error?.message ?? error),
    stderr: typeof error?.stderr === 'string' ? error.stderr.slice(-8_192) : null })}\n`);
  process.exitCode = 1;
}
