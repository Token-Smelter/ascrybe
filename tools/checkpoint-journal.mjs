// Crash-safe append-only checkpoint journal for long neural census runs.
// One JSON object per line; every completed model work unit is fsynced before `put()` resolves.
// Resume is fail-closed on fingerprint mismatch. A torn final line is truncated and ignored; corruption
// before the final line aborts rather than silently reusing ambiguous data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const CHECKPOINT_SCHEMA = 'estate-map/census-checkpoint/v1';

export async function openCheckpointJournal({ file, fingerprint }) {
  if (!file) return null;
  const absolute = path.resolve(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const fingerprintHash = sha256(stableStringify(fingerprint));
  const values = new Map();
  let resumed = false;
  let raw = '';
  try { raw = await fs.readFile(absolute, 'utf8'); resumed = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  if (raw) {
    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline < raw.length - 1) {
      // A crash may tear only the final append. Preserve every complete line and discard the tail.
      raw = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : '';
      await fs.writeFile(absolute, raw, 'utf8');
    }
    const lines = raw.split('\n').filter(Boolean);
    let header = null;
    for (let i = 0; i < lines.length; i += 1) {
      let record;
      try { record = JSON.parse(lines[i]); }
      catch (error) { throw new Error(`checkpoint corruption at complete line ${i + 1}: ${error.message}`); }
      if (i === 0) { header = record; continue; }
      if (record.type !== 'entry' || !record.stage || !record.key) throw new Error(`invalid checkpoint entry at line ${i + 1}`);
      values.set(`${record.stage}\u0000${record.key}`, record.value);
    }
    if (!header || header.type !== 'header' || header.schema !== CHECKPOINT_SCHEMA) throw new Error('checkpoint header/schema mismatch');
    if (header.fingerprint_hash !== fingerprintHash) {
      throw new Error(`checkpoint fingerprint mismatch: expected ${fingerprintHash}, found ${header.fingerprint_hash}`);
    }
  } else {
    const header = { type: 'header', schema: CHECKPOINT_SCHEMA, fingerprint_hash: fingerprintHash, fingerprint };
    await fs.writeFile(absolute, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
  }

  const handle = await fs.open(absolute, 'a');
  let chain = Promise.resolve();
  let writes = 0;
  const get = (stage, key) => values.get(`${stage}\u0000${key}`);
  const put = (stage, key, value) => {
    const mapKey = `${stage}\u0000${key}`;
    if (values.has(mapKey)) return chain;
    const line = `${JSON.stringify({ type: 'entry', stage, key, value })}\n`;
    chain = chain.then(async () => {
      if (values.has(mapKey)) return;
      await handle.appendFile(line, 'utf8');
      await handle.sync();
      values.set(mapKey, value);
      writes += 1;
    });
    return chain;
  };
  // Idempotent: close() is called from run `finally` paths AND from test teardown. A double close
  // must not throw EBADF, or a spurious error at the very end of a paid run would mask its result.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await chain;
    await handle.sync();
    await handle.close();
  };
  const stats = () => ({ path: absolute, resumed, entries: values.size, writes, fingerprint_hash: fingerprintHash });
  return Object.freeze({ get, put, close, stats });
}
