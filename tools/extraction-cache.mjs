import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractorAvailabilityReceipt } from './extractors/index.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const EXTRACTION_CACHE_RECEIPT_SCHEMA = 'estate-map/extraction-cache-receipt/v1';
const canonical = value => stableStringify(value).trim();
const compare = (left, right) => left.localeCompare(right);
const receiptName = '_CACHE_RECEIPT.json';
const toolsRoot = dirname(fileURLToPath(import.meta.url));

function cacheError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sourceClosure() {
  const extractorNames = readdirSync(join(toolsRoot, 'extractors'))
    .filter(name => name.endsWith('.mjs')).sort(compare)
    .map(name => join(toolsRoot, 'extractors', name));
  // Tree-sitter query files are producer inputs read by computed path, not by
  // import, so the import walk below cannot see them. Without these entries a
  // query-only edit changes extractor output while reusing a cache whose
  // binding still matches — the exact stale-reuse the content binding exists to
  // refuse. They hash like any other source: no imports, so the walk just
  // records their bytes.
  const queriesRoot = join(toolsRoot, 'treesitter', 'queries');
  const queryNames = existsSync(queriesRoot)
    ? readdirSync(queriesRoot).filter(name => name.endsWith('.scm')).sort(compare)
      .map(name => join(queriesRoot, name))
    : [];
  const pending = [join(toolsRoot, 'extract.mjs'), join(toolsRoot, 'merge.mjs'),
    join(toolsRoot, 'extraction-cache.mjs'), ...extractorNames, ...queryNames];
  const visited = new Set();
  while (pending.length) {
    const path = resolve(pending.pop());
    if (visited.has(path)) continue;
    if (!path.startsWith(`${toolsRoot}/`) || !existsSync(path)) {
      throw cacheError('CACHE_PRODUCER_CLOSURE_INCOMPLETE', `local producer import is unavailable: ${path}`);
    }
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu)) {
      let dependency = resolve(dirname(path), match[1]);
      if (!dependency.endsWith('.mjs')) dependency = `${dependency}.mjs`;
      pending.push(dependency);
    }
  }
  const sources = [...visited].map(path => [relative(toolsRoot, path).split('\\').join('/'),
    sha256(readFileSync(path))]).sort(([left], [right]) => left.localeCompare(right));
  return { sources, digest: sha256(canonical(sources)) };
}

export function extractionCacheBindingForInputs({ estate_head: estateHead,
  extractor_availability: extractorAvailability, producer_content_files: producerContentFiles }) {
  if (!/^[0-9a-f]{40}$/u.test(estateHead || '')) {
    throw cacheError('CACHE_ESTATE_HEAD_INVALID', 'extraction cache requires an exact estate Git head');
  }
  if (!extractorAvailability || !Array.isArray(producerContentFiles) || !producerContentFiles.length
    || producerContentFiles.some(row => !row?.path || !/^[0-9a-f]{64}$/u.test(row.digest || ''))
    || new Set(producerContentFiles.map(row => row.path)).size !== producerContentFiles.length) {
    throw cacheError('CACHE_PRODUCER_CLOSURE_INCOMPLETE', 'cache binding requires exact availability and unique producer file digests');
  }
  const files = producerContentFiles.map(row => ({ path: row.path, digest: row.digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    estate_head: estateHead,
    extractor_availability_digest: sha256(canonical(extractorAvailability)),
    producer_content_digest: sha256(canonical(files)),
    producer_content_files: files,
  };
  return Object.freeze({ ...body, cache_key: sha256(canonical(body)) });
}

export function buildExtractionCacheBinding(estateHead) {
  const closure = sourceClosure();
  return extractionCacheBindingForInputs({
    estate_head: estateHead,
    extractor_availability: extractorAvailabilityReceipt,
    producer_content_files: closure.sources.map(([path, digest]) => ({ path, digest })),
  });
}

function filesUnder(root, held = [], current = root) {
  for (const name of readdirSync(current).sort(compare)) {
    const path = join(current, name);
    const stat = statSync(path);
    if (stat.isDirectory()) filesUnder(root, held, path);
    else if (stat.isFile() && name !== receiptName) held.push(relative(root, path).split('\\').join('/'));
  }
  return held;
}

function payloadFor(root) {
  return filesUnder(root).map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

export function validateExtractionCache(cachePath, expectedBinding) {
  const root = resolve(cachePath);
  const receiptPath = join(root, receiptName);
  if (!existsSync(receiptPath)) {
    throw cacheError('CACHE_RECEIPT_INCOMPLETE', `extraction cache lacks ${receiptName}`);
  }
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch (error) { throw cacheError('CACHE_RECEIPT_INCOMPLETE', `extraction cache receipt is unreadable: ${error.message}`); }
  const { receipt_digest: observedDigest, ...body } = receipt;
  if (receipt.schema !== EXTRACTION_CACHE_RECEIPT_SCHEMA || observedDigest !== sha256(canonical(body))) {
    throw cacheError('CACHE_RECEIPT_INCOMPLETE', 'extraction cache receipt digest is missing or invalid');
  }
  for (const field of ['estate_head', 'extractor_availability_digest', 'producer_content_digest',
    'producer_content_files', 'cache_key']) {
    if (!same(receipt.binding?.[field], expectedBinding[field])) {
      throw cacheError('CACHE_BINDING_MISMATCH', `extraction cache ${field} differs from the live producer binding`);
    }
  }
  const payload = payloadFor(root);
  if (!same(payload, receipt.payload)) {
    throw cacheError('CACHE_PAYLOAD_MISMATCH', 'extraction cache payload is partial, extra, or content-mismatched');
  }
  return Object.freeze(receipt);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(lockPath, timeoutMs, retryMs) {
  const started = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      mkdirSync(lockPath);
      return { attempts, waited_ms: Date.now() - started };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) {
        throw cacheError('CACHE_LOCK_TIMEOUT', `extraction cache lock timed out after ${timeoutMs}ms`);
      }
      sleep(retryMs);
    }
  }
}

export function materializeExtractionCache({
  cache_root: cacheRoot, lock_path: lockPath, binding, produce,
  lock_timeout_ms: lockTimeoutMs = 30_000, lock_retry_ms: lockRetryMs = 25,
}) {
  if (!cacheRoot || !lockPath || typeof produce !== 'function') {
    throw cacheError('CACHE_CONFIGURATION_INVALID', 'cache root, shared lock path, and producer are required');
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0
    || !Number.isInteger(lockRetryMs) || lockRetryMs < 1) {
    throw cacheError('CACHE_CONFIGURATION_INVALID', 'cache lock bounds must be non-negative integers');
  }
  const root = resolve(cacheRoot);
  const target = join(root, binding.cache_key);
  const lock = resolve(lockPath);
  mkdirSync(root, { recursive: true });
  mkdirSync(dirname(lock), { recursive: true });
  const lockReceipt = acquireLock(lock, lockTimeoutMs, lockRetryMs);
  try {
    if (existsSync(target)) {
      return Object.freeze({ path: target, reused: true,
        receipt: validateExtractionCache(target, binding), lock: lockReceipt });
    }
    const staging = join(root, `.${basename(target)}.${process.pid}.${Date.now()}.staging`);
    mkdirSync(staging);
    try {
      produce(staging);
      const body = {
        schema: EXTRACTION_CACHE_RECEIPT_SCHEMA,
        binding,
        payload: payloadFor(staging),
        publication: 'atomic-rename-under-bounded-shared-lock',
      };
      if (!body.payload.length) throw cacheError('CACHE_PAYLOAD_INCOMPLETE', 'extraction producer emitted no cache payload');
      const receipt = { ...body, receipt_digest: sha256(canonical(body)) };
      writeFileSync(join(staging, receiptName), `${canonical(receipt)}\n`);
      validateExtractionCache(staging, binding);
      renameSync(staging, target);
      return Object.freeze({ path: target, reused: false,
        receipt: validateExtractionCache(target, binding), lock: lockReceipt });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
