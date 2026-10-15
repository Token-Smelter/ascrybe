// Deterministic wide-context segmentation. NO MODEL IN THE LOOP.
//
// WHY THIS REPLACES PLANNED RECURSION. In the pilot, planning cost 32 paid calls and 11 s median
// each to produce a partition, and the only two syntactic multi-span results came from the ONE
// document the planner declined to partition at all (37.7 KB sent whole). Segmentation is therefore
// bought at real cost for no demonstrated benefit. Here it is a pure function of source bytes:
// whole document when it fits, deterministic overlapping windows when it does not.
//
// PREFER WHOLE-DOCUMENT. Windows exist only to respect the prompt ceiling. Every split is a chance
// to separate a definition from its use, which is the failure mode heading-chunking already had.
import { inventoryMarkdown } from './recursive-contracts.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const WINDOW_SCHEMA = 'estate-map/wide-context-window/v1';
export const DEFAULT_WINDOW_BYTES = 48 * 1024;
export const DEFAULT_OVERLAP_BYTES = 4 * 1024;

export class WindowError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'WindowError';
    this.code = code;
    this.detail = detail;
  }
}

const canonical = value => stableStringify(value).trim();

const makeWindow = ({ path, blocks, kind, snapshot, contextBlocks = [] }) => {
  if (!blocks.length) throw new WindowError('EMPTY_WINDOW', 'a window must contain at least one block');
  const first = blocks[0], last = blocks[blocks.length - 1];
  const primary_spans = [{ file: path, start: first.start, end: last.end }];
  const context_spans = contextBlocks.length
    ? [{ file: path, start: contextBlocks[0].start, end: contextBlocks[contextBlocks.length - 1].end }]
    : [];
  const identity = {
    schema: WINDOW_SCHEMA,
    snapshot: snapshot || null,
    primary: primary_spans.map(s => ({ file: s.file, start: s.start, end: s.end })),
    context: context_spans.map(s => ({ file: s.file, start: s.start, end: s.end })),
  };
  return Object.freeze({
    schema: WINDOW_SCHEMA,
    id: `window:${sha256(canonical(identity))}`,
    kind,                                   // 'whole_document' | 'overlapping_window'
    file: path,
    source_containers: Object.freeze([{ kind: 'document', id: path }]),
    primary_spans,
    context_spans,
    primary_block_addresses: blocks.map(b => b.address),
    context_block_addresses: contextBlocks.map(b => b.address),
    heading_ancestry: Object.freeze([...new Set(blocks.flatMap(b => b.heading_ancestry || []))]),
    primary_bytes: blocks.reduce((sum, b) => sum + b.bytes, 0),
    block_count: blocks.length,
    snapshot: snapshot || null,
  });
};

/**
 * Segment one document. Returns whole-document when it fits under `window_bytes`, otherwise
 * block-aligned windows that overlap by at least `overlap_bytes` of preceding CONTEXT.
 *
 * Overlap is carried as `context_spans`, not as duplicated primary evidence: a block is primary in
 * exactly one window, so primary coverage is a partition and claim dedup stays meaningful.
 */
export function segmentDocument({ path, content, snapshot = null, window_bytes = DEFAULT_WINDOW_BYTES, overlap_bytes = null }) {
  if (!Number.isInteger(window_bytes) || window_bytes < 1024) throw new WindowError('INVALID_WINDOW_BYTES', 'window_bytes must be an integer >= 1024');
  // An UNSPECIFIED overlap adapts to the window (a fixed 4 KB default is invalid for a 4 KB window).
  // An explicitly supplied bad overlap still fails loudly rather than being silently corrected.
  const explicitOverlap = overlap_bytes !== null && overlap_bytes !== undefined;
  const effectiveOverlap = explicitOverlap ? overlap_bytes : Math.min(DEFAULT_OVERLAP_BYTES, Math.floor(window_bytes / 4));
  if (!Number.isInteger(effectiveOverlap) || effectiveOverlap < 0 || effectiveOverlap >= window_bytes) {
    throw new WindowError('INVALID_OVERLAP', 'overlap_bytes must be >= 0 and < window_bytes', { window_bytes, overlap_bytes });
  }
  overlap_bytes = effectiveOverlap;
  const inventory = inventoryMarkdown({ path, content, source_sha: snapshot?.source_sha ?? null, corpus_digest: snapshot?.corpus_digest ?? null });
  const blocks = inventory.blocks;

  if (inventory.bytes <= window_bytes) {
    return Object.freeze({ inventory, windows: Object.freeze([makeWindow({ path, blocks, kind: 'whole_document', snapshot })]) });
  }

  const windows = [];
  let current = [];
  let currentBytes = 0;
  const flush = () => {
    if (!current.length) return;
    // Context = trailing blocks of the previous window, up to overlap_bytes. Deterministic.
    const previous = windows.length ? windows[windows.length - 1].primary_block_addresses : [];
    const contextBlocks = [];
    let contextBytes = 0;
    for (let i = previous.length - 1; i >= 0 && contextBytes < overlap_bytes; i -= 1) {
      const block = blocks.find(b => b.address === previous[i]);
      if (!block) break;
      contextBlocks.unshift(block);
      contextBytes += block.bytes;
    }
    windows.push(makeWindow({ path, blocks: current, kind: 'overlapping_window', snapshot, contextBlocks }));
    current = [];
    currentBytes = 0;
  };

  for (const block of blocks) {
    // A single block larger than the window cannot be split without breaking source custody; it
    // becomes its own oversized window and is reported, never silently dropped.
    if (block.bytes > window_bytes) {
      flush();
      windows.push(makeWindow({ path, blocks: [block], kind: 'overlapping_window', snapshot }));
      continue;
    }
    if (currentBytes + block.bytes > window_bytes) flush();
    current.push(block);
    currentBytes += block.bytes;
  }
  flush();
  return Object.freeze({ inventory, windows: Object.freeze(windows) });
}

/** Primary coverage must be an exact partition of the document's blocks. */
export function windowConservation({ inventory, windows }) {
  const all = inventory.blocks.map(b => b.address);
  const seen = new Map();
  for (const window of windows) {
    for (const address of window.primary_block_addresses) seen.set(address, (seen.get(address) || 0) + 1);
  }
  const missing = all.filter(a => !seen.has(a));
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([a]) => a);
  const foreign = [...seen.keys()].filter(a => !all.includes(a));
  const oversized = windows.filter(w => w.block_count === 1 && w.primary_bytes > DEFAULT_WINDOW_BYTES).map(w => w.id);
  return Object.freeze({
    schema: 'estate-map/window-conservation/v1',
    file: inventory.path,
    blocks: all.length,
    windows: windows.length,
    missing, duplicated, foreign,
    oversized_single_block_windows: oversized,
    valid: missing.length === 0 && duplicated.length === 0 && foreign.length === 0,
  });
}

/** Segment a corpus; returns windows in canonical order plus a per-file conservation receipt. */
export function segmentCorpus({ documents, snapshot = null, window_bytes = DEFAULT_WINDOW_BYTES, overlap_bytes = null }) {
  const receipts = [], windows = [], inventories = [];
  for (const document of [...documents].sort((a, b) => a.path.localeCompare(b.path))) {
    const segmented = segmentDocument({ path: document.path, content: document.content, snapshot, window_bytes, overlap_bytes });
    const receipt = windowConservation(segmented);
    if (!receipt.valid) throw new WindowError('WINDOW_CONSERVATION_FAILED', `windows do not partition ${document.path}`, receipt);
    inventories.push(segmented.inventory);
    receipts.push(receipt);
    windows.push(...segmented.windows);
  }
  return Object.freeze({
    inventories,
    receipts,
    windows: Object.freeze(windows.slice().sort((a, b) => a.file.localeCompare(b.file) || a.primary_spans[0].start - b.primary_spans[0].start)),
    totals: Object.freeze({
      documents: documents.length,
      windows: windows.length,
      whole_document_windows: windows.filter(w => w.kind === 'whole_document').length,
      primary_bytes: windows.reduce((sum, w) => sum + w.primary_bytes, 0),
    }),
  });
}
