// Real, in-environment RPC transport for the persistent pi runner (slice 4d, DESIGN §16.12.1).
//
// It owns ONE warm `pi --mode rpc --model <id>` child process and exposes an LF-framed NDJSON pipe
// to it. This is the spawn machinery for createPiRpcRunner; it is imported LAZILY by that runner so
// importing neural-model-runner.mjs (e.g. from a unit test) pulls in NONE of this and can never
// spawn a process. Tests inject their own transportFactory instead.
//
// FRAMING GOTCHA (pi RPC docs, "Framing"): split records on '\n' ONLY. Node `readline` also breaks
// on U+2028/U+2029, which are valid inside JSON strings, so it can fragment large assistant payloads
// into invalid JSON. This mirrors the LF-only reader already proven in src/rpc-sidecar.mjs.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// LF-only JSONL line reader. Returns a detach function.
export function attachLfLineReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const onData = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const i = buf.indexOf('\n');
      if (i === -1) return;
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  };
  const onEnd = () => {
    buf += decoder.end();
    if (buf.length > 0) {
      onLine(buf.endsWith('\r') ? buf.slice(0, -1) : buf);
      buf = '';
    }
  };
  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => { stream.off('data', onData); stream.off('end', onEnd); };
}

// The exact flag set required so a warm RPC process is a pure model endpoint: no tools, no ambient
// context files, no extensions/skills (so the pi bridge extension never loads), and no session
// persistence (nothing is written to disk; context reset is done via the new_session command).
export const RPC_BASE_ARGS = Object.freeze([
  '--mode', 'rpc', '--no-tools', '--no-context-files', '--no-extensions', '--no-skills', '--no-session',
]);

/**
 * Spawn ONE warm `pi --mode rpc --model <id>` process and return a connection object:
 *   write(obj)   — serialize + '\n' to stdin (one NDJSON command per line)
 *   onLine(fn)   — subscribe to stdout events; fn(parsedEventOrNull, rawLine); returns unsubscribe
 *   onClose(fn)  — subscribe to process exit / stdout EOF; returns unsubscribe
 *   close(opts)  — graceful shutdown (end stdin, then SIGTERM, then SIGKILL)
 *   kill(signal) — force terminate
 *   pid, closed
 *
 * Inherits PI_CODING_AGENT_DIR (and the rest of env) so the SSE agent-dir + symlinked auth/models
 * routing still applies. A warm RPC process connects ONCE (no per-call WebSocket setup).
 */
export function createPiRpcTransport({ model, thinking = null, env = process.env, piCommand = 'pi', extraArgs = [] } = {}) {
  const args = [...RPC_BASE_ARGS, '--model', model];
  if (thinking) args.push('--thinking', thinking);
  args.push(...extraArgs);

  const child = spawn(piCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  const lineListeners = new Set();
  const closeListeners = new Set();
  const stderrTail = [];
  let closed = false;

  const emitClose = (info) => {
    if (closed) return;
    closed = true;
    for (const fn of [...closeListeners]) { try { fn(info); } catch { /* isolate */ } }
  };

  const detachReader = attachLfLineReader(child.stdout, (line) => {
    let evt = null;
    try { evt = JSON.parse(line); } catch { evt = null; }
    for (const fn of [...lineListeners]) { try { fn(evt, line); } catch { /* isolate */ } }
  });

  child.stderr.on('data', (d) => {
    const text = String(d);
    stderrTail.push(text);
    if (stderrTail.length > 50) stderrTail.shift();
  });
  child.on('error', (error) => emitClose({ reason: 'spawn_error', error }));
  child.on('exit', (code, signal) => { try { detachReader(); } catch {} emitClose({ reason: 'exit', code, signal }); });

  const conn = {
    pid: child.pid,
    get closed() { return closed; },
    stderrTail: () => stderrTail.join(''),
    write(obj) {
      if (closed) throw new Error('pi rpc transport is closed');
      child.stdin.write(JSON.stringify(obj) + '\n');
    },
    onLine(fn) { lineListeners.add(fn); return () => lineListeners.delete(fn); },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
    kill(signal = 'SIGKILL') { try { child.kill(signal); } catch { /* already gone */ } },
    async close({ graceMs = 2000 } = {}) {
      if (closed) return;
      try { child.stdin.end(); } catch {}
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(term); clearTimeout(hard); unsub(); resolve(); };
        const unsub = conn.onClose(() => finish());
        const term = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, graceMs);
        const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, graceMs + 1500);
      });
      emitClose({ reason: 'closed' });
    },
  };
  return conn;
}
