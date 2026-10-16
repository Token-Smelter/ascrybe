// AC2-UNIT-CACHE: extraction cache reuse is keyed per unit, not per whole estate head. Exactly one
// file's bytes change; only that file's routed units invalidate, every other expected unit
// validates as reused_exact, and each reused record retains its ORIGINAL producer provenance and
// original record_digest. Invented fixture names throughout (CONTRIBUTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../tools/lib.mjs';
import { buildProducedFileUnitReceipt } from '../tools/delta/extraction-unit.mjs';
import { readUnitCacheEntry, tryReuseUnit, writeUnitCacheEntry } from '../tools/delta/unit-cache.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const extractor = Object.freeze({
  id: 'invented-declarations', routing_contract_digest: sha256('routing-v1'), output_contract: 'invented-declarations@1',
  identity_contract: 'invented-declaration-identity@1', implementation_digest: sha256('impl-v1'),
  configuration_digest: sha256('config-v1'), runtime_digest: sha256('runtime-v1'),
});

function fileEntry(repository, normalizedPath, bytes) {
  return {
    repository, normalized_path: normalizedPath, blob_oid: `blob-${sha256(bytes).slice(0, 12)}`, content_sha256: sha256(bytes),
  };
}

function receiptFor(entry, localKey) {
  return buildProducedFileUnitReceipt({
    ...entry, extractor,
    records: [{ observation_kind: 'symbol', producer_local_key: localKey, output_schema: 'invented-declarations@1', normalized_record: { name: localKey } }],
  });
}

test('a byte-for-byte cache hit reuses the unit and preserves original provenance and record_digest', () => {
  const cacheRoot = scratchDir('delta-unit-cache-');
  try {
    const entry = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
    const produced = receiptFor(entry, 'LedgerEntry');
    writeUnitCacheEntry(cacheRoot, produced);

    const reuse = tryReuseUnit(cacheRoot, { unit_id: produced.unit_id, inputs: produced.inputs });
    assert.equal(reuse.status, 'hit');
    assert.equal(reuse.receipt.disposition.kind, 'reused_exact');
    assert.equal(reuse.receipt.disposition.source_receipt_digest, produced.receipt_digest);
    // ORIGINAL producer provenance and ORIGINAL record_digest, never restamped.
    assert.deepEqual(reuse.receipt.output.records, produced.output.records);
    assert.equal(reuse.receipt.output.records[0].record_digest, produced.output.records[0].record_digest);
    assert.equal(reuse.receipt.output.records[0].producer_contract_digest, produced.output.records[0].producer_contract_digest);
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});

test('exactly one changed file invalidates only its routed unit; every other unit reuses', () => {
  const cacheRoot = scratchDir('delta-unit-cache-');
  try {
    const ledger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 1;');
    const gateway = fileEntry('amber-ledger', 'src/gateway.mjs', 'const GatewayEntry = 1;');
    const ledgerReceipt = receiptFor(ledger, 'LedgerEntry');
    const gatewayReceipt = receiptFor(gateway, 'GatewayEntry');
    writeUnitCacheEntry(cacheRoot, ledgerReceipt);
    writeUnitCacheEntry(cacheRoot, gatewayReceipt);

    // Only ledger.mjs's bytes change.
    const changedLedger = fileEntry('amber-ledger', 'src/ledger.mjs', 'const LedgerEntry = 2;');

    const changedReuse = tryReuseUnit(cacheRoot, {
      unit_id: buildProducedFileUnitReceipt({ ...changedLedger, extractor, records: [] }).unit_id,
      inputs: buildProducedFileUnitReceipt({ ...changedLedger, extractor, records: [] }).inputs,
    });
    assert.equal(changedReuse.status, 'miss');
    assert.equal(changedReuse.reason, 'absent');

    const unchangedReuse = tryReuseUnit(cacheRoot, { unit_id: gatewayReceipt.unit_id, inputs: gatewayReceipt.inputs });
    assert.equal(unchangedReuse.status, 'hit');
    assert.equal(unchangedReuse.receipt.disposition.kind, 'reused_exact');
    assert.deepEqual(unchangedReuse.receipt.output.records, gatewayReceipt.output.records);

    // The ledger unit's own untouched cache entry is unaffected by the change (it is simply a
    // different unit_id now; the OLD unit_id's entry still reuses on its own terms).
    const staleLedgerReuse = tryReuseUnit(cacheRoot, { unit_id: ledgerReceipt.unit_id, inputs: ledgerReceipt.inputs });
    assert.equal(staleLedgerReuse.status, 'hit');
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});

test('a truncated cache receipt fails closed, is quarantined, and reports a recomputable miss', () => {
  const cacheRoot = scratchDir('delta-unit-cache-');
  try {
    const entry = fileEntry('cobalt-gateway', 'src/router.mjs', 'const RouterEntry = 1;');
    const produced = receiptFor(entry, 'RouterEntry');
    const { path } = writeUnitCacheEntry(cacheRoot, produced);
    const receiptPath = join(path, 'receipt.json');
    const bytes = readFileSync(receiptPath, 'utf8');
    writeFileSync(receiptPath, bytes.slice(0, Math.floor(bytes.length / 2)));

    const result = readUnitCacheEntry(cacheRoot, produced.unit_id);
    assert.equal(result.status, 'miss');
    assert.equal(result.reason, 'cache_corrupt');
    assert.ok(result.quarantined_to, 'corrupt entry must be moved aside, never edited in place');
    // Recomputing is possible: writing a fresh entry under the same unit_id succeeds.
    const rewritten = writeUnitCacheEntry(cacheRoot, produced);
    assert.equal(rewritten.written, true);
    assert.equal(readUnitCacheEntry(cacheRoot, produced.unit_id).status, 'hit');
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});

test('an edited (tampered) cache receipt fails closed rather than being trusted', () => {
  const cacheRoot = scratchDir('delta-unit-cache-');
  try {
    const entry = fileEntry('cobalt-gateway', 'src/handler.mjs', 'const HandlerEntry = 1;');
    const produced = receiptFor(entry, 'HandlerEntry');
    const { path } = writeUnitCacheEntry(cacheRoot, produced);
    const receiptPath = join(path, 'receipt.json');
    const tampered = JSON.parse(readFileSync(receiptPath, 'utf8'));
    tampered.output.records[0].normalized_record = { name: 'TamperedEntry' };
    writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);

    const result = readUnitCacheEntry(cacheRoot, produced.unit_id);
    assert.equal(result.status, 'miss');
    assert.equal(result.reason, 'cache_corrupt');
    assert.equal(result.code, 'DELTA_RECORD_DIGEST_MISMATCH');
  } finally { rmSync(cacheRoot, { recursive: true, force: true }); }
});
