import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluationChildEnvironment } from './child-environment.mjs';

const worker = fileURLToPath(new URL('./model-worker.mjs', import.meta.url));
const MODEL_FAILURE_CODES = new Set(['EVAL_MODEL_TRANSIENT', 'EVAL_MODEL_UNAVAILABLE']);

function childFailure(message, stderr) {
  const error = new Error(message);
  error.stderr = stderr.slice(-8_192);
  try {
    const workerError = JSON.parse(stderr.trim().split('\n').at(-1));
    if (workerError?.schema === 'estate-map/eval-model-worker-error/v1') {
      if (typeof workerError.stderr === 'string') error.stderr = workerError.stderr.slice(-8_192);
      if (MODEL_FAILURE_CODES.has(workerError.code)) error.code = workerError.code;
    }
  } catch { /* malformed worker stderr remains a deterministic failure */ }
  return error;
}

export async function runModelInFreshProcess({ model_runner, request }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, model_runner], {
      stdio: ['pipe', 'pipe', 'pipe'], env: evaluationChildEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => reject(error));
    child.once('close', code => {
      if (code !== 0) return reject(childFailure(`isolated model process failed (${code}): ${stderr.trim()}`, stderr));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(childFailure(`isolated model process returned invalid JSON: ${error.message}`, stderr));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
