import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractionCacheBindingForInputs, materializeExtractionCache, validateExtractionCache,
} from '../tools/extraction-cache.mjs';
import { sha256 } from '../tools/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/c4-mini-corpus/cache');
const availability = JSON.parse(readFileSync(join(fixture, 'availability.json'), 'utf8'));
const estateHead = '3333333333333333333333333333333333333333';

function binding(producerPath) {
  return extractionCacheBindingForInputs({
    estate_head: estateHead,
    extractor_availability: availability,
    producer_content_files: [{ path: 'producer.mjs',
      digest: sha256(readFileSync(join(fixture, producerPath))) }],
  });
}

test('same availability counts with changed tracked producer bytes invalidate mini-cache reuse', () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'c4-mini-cache-'));
  const cacheRoot = join(root, 'cache');
  const lockPath = join(root, 'cache.lock');
  const firstBinding = binding('producer-a.mjs');
  const changedBinding = binding('producer-b.mjs');
  let producerCalls = 0;
  const produce = staging => {
    producerCalls += 1;
    writeFileSync(join(staging, 'payload.json'), `${JSON.stringify({ producerCalls })}\n`);
  };
  try {
    const first = materializeExtractionCache({ cache_root: cacheRoot, lock_path: lockPath,
      binding: firstBinding, produce });
    const reused = materializeExtractionCache({ cache_root: cacheRoot, lock_path: lockPath,
      binding: firstBinding, produce });
    const changed = materializeExtractionCache({ cache_root: cacheRoot, lock_path: lockPath,
      binding: changedBinding, produce });
    assert.throws(() => validateExtractionCache(first.path, changedBinding),
      error => error.code === 'CACHE_BINDING_MISMATCH');
    assert.deepEqual({
      available_before: availability.available.length,
      available_after: availability.available.length,
      availability_digest_equal: firstBinding.extractor_availability_digest
        === changedBinding.extractor_availability_digest,
      producer_digest_changed: firstBinding.producer_content_digest
        !== changedBinding.producer_content_digest,
      first_reused: first.reused,
      exact_reused: reused.reused,
      changed_reused: changed.reused,
      cache_paths_differ: first.path !== changed.path,
      producer_calls: producerCalls,
    }, {
      available_before: 1, available_after: 1, availability_digest_equal: true,
      producer_digest_changed: true, first_reused: false, exact_reused: true,
      changed_reused: false, cache_paths_differ: true, producer_calls: 2,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
