import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExtractionCacheBinding, materializeExtractionCache, validateExtractionCache,
} from '../tools/extraction-cache.mjs';

const sourceHead = '90ec8527ca8fa5957dc52e91d25414ff5980e1fd';
const otherHead = '1111111111111111111111111111111111111111';

function fixture() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'extraction-cache-'));
  return {
    root,
    cacheRoot: join(root, 'cache'),
    lockPath: join(root, 'shared.lock'),
    binding: buildExtractionCacheBinding(sourceHead),
  };
}

function materialize(held, produce, overrides = {}) {
  return materializeExtractionCache({
    cache_root: held.cacheRoot,
    lock_path: held.lockPath,
    binding: held.binding,
    produce,
    ...overrides,
  });
}

test('cache publication is atomic under one lock and exact reuse executes no producer', () => {
  const held = fixture();
  let calls = 0;
  try {
    const produce = staging => {
      calls += 1;
      assert.equal(existsSync(join(held.cacheRoot, held.binding.cache_key)), false);
      assert.equal(existsSync(held.lockPath), true);
      mkdirSync(join(staging, 'extract'));
      writeFileSync(join(staging, 'extract', '_MANIFEST.json'), '{"complete":true}\n');
    };
    const first = materialize(held, produce);
    const second = materialize(held, produce);
    assert.deepEqual({ first_reused: first.reused, second_reused: second.reused,
      producer_calls: calls, final_valid: Boolean(validateExtractionCache(first.path, held.binding)) },
    { first_reused: false, second_reused: true, producer_calls: 1, final_valid: true });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('estate head, exact extractor availability, and producer content mismatch fail closed', () => {
  const held = fixture();
  try {
    const result = materialize(held, staging => writeFileSync(join(staging, 'payload'), 'exact'));
    const mismatches = [
      buildExtractionCacheBinding(otherHead),
      { ...held.binding, extractor_availability_digest: 'availability:mismatch' },
      { ...held.binding, producer_content_digest: 'producer:mismatch' },
    ];
    assert.deepEqual(mismatches.map(binding => {
      try { validateExtractionCache(result.path, binding); return null; }
      catch (error) { return error.code; }
    }), ['CACHE_BINDING_MISMATCH', 'CACHE_BINDING_MISMATCH', 'CACHE_BINDING_MISMATCH']);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('partial cache receipt fails closed', () => {
  const held = fixture();
  try {
    const partial = join(held.cacheRoot, held.binding.cache_key);
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'payload'), 'partially-receipted');
    writeFileSync(join(partial, '_CACHE_RECEIPT.json'), '{}\n');
    assert.throws(() => validateExtractionCache(partial, held.binding),
      error => error.code === 'CACHE_RECEIPT_INCOMPLETE');
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('post-publication payload mismatch fails closed', () => {
  const held = fixture();
  try {
    const result = materialize(held, staging => writeFileSync(join(staging, 'payload'), 'exact'));
    writeFileSync(join(result.path, 'unexpected-partial'), 'extra');
    assert.throws(() => validateExtractionCache(result.path, held.binding),
      error => error.code === 'CACHE_PAYLOAD_MISMATCH');
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('shared-lock contention times out without executing or publishing', () => {
  const held = fixture();
  let executed = false;
  try {
    mkdirSync(held.lockPath);
    assert.throws(() => materialize(held, () => { executed = true; }, {
      lock_timeout_ms: 5, lock_retry_ms: 1,
    }), error => error.code === 'CACHE_LOCK_TIMEOUT');
    assert.deepEqual({ executed, published: existsSync(join(held.cacheRoot, held.binding.cache_key)) },
      { executed: false, published: false });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});
