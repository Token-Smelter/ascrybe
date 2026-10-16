// Deterministic quote-within-block source addressing.
//
// Models select exact source bytes inside short prompt-local block tokens. This module—not the
// model—derives file, line, byte, digest, and custody role. Near matches are never repaired.
import { inventoryIndex } from './recursive-contracts.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const SOURCE_LOCATOR_SCHEMA = 'estate-map/source-locator/v1';
export const BLOCK_CATALOG_SCHEMA = 'estate-map/window-block-catalog/v1';
export const MIN_BARE_QUOTE_CHARS = 24;

const canonical = value => stableStringify(value).trim();
const text = value => String(value ?? '');

export class SourceLocatorError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SourceLocatorError';
    this.code = code;
    this.detail = detail;
  }
}

const countNewlines = value => (String(value).match(/\n/g) || []).length;
const tokenFor = index => `b${String(index + 1).padStart(3, '0')}`;

/** Build the immutable prompt-local token catalog for one extraction window. */
export function createWindowBlockCatalog({ window, inventories }) {
  if (!window?.id) throw new SourceLocatorError('INVALID_WINDOW', 'block catalog requires a window');
  const index = inventoryIndex(inventories);
  const primary = new Set(window.primary_block_addresses || []);
  const context = new Set(window.context_block_addresses || []);
  const addresses = [...new Set([...primary, ...context])];
  const blocks = addresses.map(address => {
    const block = index.byAddress.get(address);
    if (!block) throw new SourceLocatorError('UNKNOWN_BLOCK', `window cites unknown block ${address}`);
    return block;
  }).sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
  const entries = blocks.map((block, ordinal) => Object.freeze({
    token: tokenFor(ordinal),
    role: primary.has(block.address) ? 'primary' : 'context',
    address: block.address,
    block_id: block.id,
    file: block.file,
    start: block.start,
    end: block.end,
    byte_start: block.byte_start,
    byte_end: block.byte_end,
    digest: block.digest,
    type: block.type,
    text: block.text,
  }));
  const body = {
    schema: BLOCK_CATALOG_SCHEMA,
    window_id: window.id,
    snapshot: window.snapshot || null,
    entries,
  };
  return Object.freeze({
    ...body,
    digest: sha256(canonical(body)),
    byToken: Object.freeze(Object.fromEntries(entries.map(entry => [entry.token, entry]))),
  });
}

export function renderBlockCatalog(catalog) {
  return catalog.entries.map(entry => [
    `[${entry.token} ${entry.role.toUpperCase()} ${entry.file}:${entry.start}-${entry.end}]`,
    entry.text,
  ].join('\n')).join('\n\n');
}

function occurrenceIndexes(haystack, needle) {
  const indexes = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

const regexEscape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const canonicalWhitespace = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function whitespaceEquivalentMatches(source, authoredQuote) {
  const tokens = String(authoredQuote ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const pattern = new RegExp(tokens.map(regexEscape).join('\\s+'), 'gu');
  return [...String(source).matchAll(pattern)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  })).filter(match => canonicalWhitespace(match.text) === canonicalWhitespace(authoredQuote));
}

function crossesStructuralBoundary(block, sourceSlice) {
  if (/\n[\t ]*\n/.test(sourceSlice)) return 'blank_line';
  if (block.type === 'table' && /\r?\n/.test(sourceSlice)) return 'table_row';
  if (/\r?\n[\t ]*(?:[-+*]|\d+[.)])[\t ]+/.test(sourceSlice)) return 'list_item';
  return null;
}

/** Resolve one exact quote. `expected_role` enforces primary/context custody for evidence. */
export function resolveSourceLocator({ locator, catalog, expected_role = null, min_bare_quote_chars = MIN_BARE_QUOTE_CHARS }) {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
    throw new SourceLocatorError('INVALID_SOURCE_LOCATOR', 'source_locator must be an object');
  }
  const blockToken = text(locator.block_token).trim();
  const quote = text(locator.quote);
  const beforeValue = locator.context_before == null ? null : text(locator.context_before);
  const afterValue = locator.context_after == null ? null : text(locator.context_after);
  const before = beforeValue?.length ? beforeValue : null;
  const after = afterValue?.length ? afterValue : null;
  const occurrence = locator.occurrence == null ? null : Number(locator.occurrence);
  const block = catalog?.byToken?.[blockToken];
  if (!block) throw new SourceLocatorError('UNKNOWN_BLOCK_TOKEN', `unknown block token ${blockToken || '<blank>'}`, { block_token: blockToken });
  if (expected_role && block.role !== expected_role) {
    throw new SourceLocatorError('LOCATOR_ROLE_MISMATCH', `${blockToken} is ${block.role}, not ${expected_role}`, { block_token: blockToken, expected_role, actual_role: block.role });
  }
  if (!quote.length) throw new SourceLocatorError('EMPTY_LOCATOR_QUOTE', 'source locator quote must be non-empty', { block_token: blockToken });
  if (quote.length < min_bare_quote_chars && before == null && after == null && occurrence == null) {
    throw new SourceLocatorError('SHORT_QUOTE_REQUIRES_DISAMBIGUATOR', `quotes shorter than ${min_bare_quote_chars} characters require context or occurrence`, {
      block_token: blockToken, quote_length: quote.length, minimum: min_bare_quote_chars,
    });
  }
  if (occurrence !== null && (!Number.isInteger(occurrence) || occurrence < 1)) {
    throw new SourceLocatorError('INVALID_LOCATOR_OCCURRENCE', 'occurrence must be a positive 1-based integer', { occurrence: locator.occurrence });
  }

  const allMatches = occurrenceIndexes(block.text, quote);
  let matches = allMatches.filter(index => {
    const left = block.text.slice(0, index);
    const right = block.text.slice(index + quote.length);
    return (before == null || left.endsWith(before)) && (after == null || right.startsWith(after));
  });
  if (occurrence !== null) matches = matches[occurrence - 1] == null ? [] : [matches[occurrence - 1]];
  if (!matches.length) {
    throw new SourceLocatorError('LOCATOR_QUOTE_NOT_FOUND', `quote did not resolve in ${blockToken}`, {
      block_token: blockToken, quote, raw_match_count: allMatches.length,
    });
  }
  if (matches.length > 1) {
    throw new SourceLocatorError('LOCATOR_QUOTE_AMBIGUOUS', `quote resolved ${matches.length} times in ${blockToken}`, {
      block_token: blockToken, quote, match_count: matches.length,
    });
  }

  const offset = matches[0];
  const prefix = block.text.slice(0, offset);
  const start = block.start + countNewlines(prefix);
  const end = start + countNewlines(quote);
  const byteStart = block.byte_start + Buffer.byteLength(prefix, 'utf8');
  const byteEnd = byteStart + Buffer.byteLength(quote, 'utf8');
  const body = {
    schema: SOURCE_LOCATOR_SCHEMA,
    source_locator: {
      block_token: blockToken,
      quote,
      context_before: before,
      context_after: after,
      occurrence,
    },
    block: { address: block.address, block_id: block.block_id, digest: block.digest, role: block.role },
    file: block.file,
    start,
    end,
    byte_start: byteStart,
    byte_end: byteEnd,
    text: quote,
    text_digest: sha256(quote),
  };
  return Object.freeze({ ...body, id: `resolved-locator:${sha256(canonical(body))}` });
}

/**
 * Narrow v28 repair: rewrite one uniquely whitespace-equivalent authored quote to the exact bytes
 * in its already-declared block, then pass the rewritten locator through the unchanged resolver.
 * No file/block search, fuzzy text, case folding, or structural-boundary crossing is permitted.
 */
export function repairWhitespaceEquivalentSourceLocator({
  locator, catalog, expected_role = null, min_bare_quote_chars = MIN_BARE_QUOTE_CHARS,
}) {
  try {
    return Object.freeze({
      locator,
      resolved: resolveSourceLocator({ locator, catalog, expected_role, min_bare_quote_chars }),
      repair: null,
    });
  } catch (error) {
    if (!(error instanceof SourceLocatorError) || error.code !== 'LOCATOR_QUOTE_NOT_FOUND'
      || Number(error.detail?.raw_match_count || 0) !== 0) throw error;
    const blockToken = text(locator?.block_token).trim();
    const authoredQuote = text(locator?.quote);
    const block = catalog?.byToken?.[blockToken];
    if (!block) throw error;
    const matches = whitespaceEquivalentMatches(block.text, authoredQuote);
    if (!matches.length) throw error;
    if (matches.length > 1) {
      throw new SourceLocatorError('WHITESPACE_EQUIVALENT_QUOTE_AMBIGUOUS',
        `whitespace-equivalent quote resolved ${matches.length} times in ${blockToken}`, {
          block_token: blockToken, authored_quote: authoredQuote, match_count: matches.length,
        });
    }
    const match = matches[0];
    const boundary = crossesStructuralBoundary(block, match.text);
    if (boundary) {
      throw new SourceLocatorError('WHITESPACE_EQUIVALENT_BOUNDARY_CROSSING',
        `whitespace repair would cross a ${boundary} boundary in ${blockToken}`, {
          block_token: blockToken, authored_quote: authoredQuote, boundary,
        });
    }
    const exactOccurrences = occurrenceIndexes(block.text, match.text);
    const exactOrdinal = exactOccurrences.indexOf(match.start) + 1;
    const rewritten = {
      block_token: blockToken,
      quote: match.text,
      context_before: null,
      context_after: null,
      occurrence: match.text.length < min_bare_quote_chars || exactOccurrences.length > 1
        ? exactOrdinal : null,
    };
    const resolved = resolveSourceLocator({
      locator: rewritten, catalog, expected_role, min_bare_quote_chars,
    });
    return Object.freeze({
      locator: Object.freeze(rewritten),
      resolved,
      repair: Object.freeze({
        code: 'WHITESPACE_EQUIVALENT_LOCATOR_REWRITTEN',
        repair_mode: 'unique_declared_block_whitespace_equivalence',
        block_token: blockToken,
        block_address: block.address,
        authored_quote: authoredQuote,
        exact_source_quote: match.text,
        file: resolved.file,
        start: resolved.start,
        end: resolved.end,
        byte_start: resolved.byte_start,
        byte_end: resolved.byte_end,
        text_digest: resolved.text_digest,
      }),
    });
  }
}

export function locatorToSpan(resolved, role = resolved.block.role) {
  return Object.freeze({ role, file: resolved.file, start: resolved.start, end: resolved.end });
}
