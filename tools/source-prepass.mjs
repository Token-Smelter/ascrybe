// Deterministic source prepass: mention namespace, symbols, defined terms, aliases.
//
// WHY THIS EXISTS. 66-73% of pilot claims carried unresolved referents, and the external review
// diagnosed the cause precisely: we demanded a corpus-global canonical `kind:id` at EXTRACTION time.
// That conflates three different questions —
//   (a) does the text support the proposition?
//   (b) is the subject mention stably anchored in source?
//   (c) has that mention been resolved to a global entity?
// Extraction should answer (a) and (b). Only merge answers (c). This module supplies (b)
// deterministically, so the extractor can point at a real source mention instead of inventing an
// identity or giving up. Zero model calls; pure function of source bytes.
import { inventoryMarkdown } from './recursive-contracts.mjs';
import { extractSectionReferences, extractStructuredObservations } from './structured-source.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const PREPASS_SCHEMA = 'estate-map/source-prepass/v2';
export const SUBJECT_OCCURRENCE_SCHEMA = 'estate-map/window-subject-occurrence/v1';

export class PrepassError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PrepassError';
    this.code = code;
    this.detail = detail;
  }
}

const text = value => String(value ?? '');
const norm = value => text(value).trim().toLowerCase();

// Fully-qualified or structured code identifiers: dotted/scoped paths, snake/camel with separators,
// and function-call shapes. Deliberately conservative: a bare English word is NOT a symbol.
const SYMBOL_PATTERNS = Object.freeze([
  /`([A-Za-z_$][\w$]*(?:[./:][\w$]+)+)`/g,                 // `a.b`, `mod::fn`, `path/to/thing`
  /`([A-Za-z_$][\w$]*\([^`)]*\))`/g,                        // `propose_route(...)`
  /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g,                     // `snake_case_symbol`
  /`([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)`/g,                 // `lowerCamelCaseSymbol`
  /`([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)`/g,                 // `CamelCaseSymbol`
  /\b([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/g, // bare dotted path
]);

// "X is called Y", "X, also known as Y", "X (Y)" where Y looks like a term, "Y — short for X".
const ALIAS_PATTERNS = Object.freeze([
  /\b([A-Z][\w .-]{2,60}?)\s*\((?:a\.k\.a\.|aka|also known as)\s+([^)]{2,60})\)/gi,
  /\b([\w .-]{2,60}?)\s+(?:is|are)\s+(?:also\s+)?(?:called|known as|referred to as)\s+["“']?([\w .-]{2,60}?)["”']?[.,;]/gi,
  /\b(?:short for|abbreviated as)\s+["“']?([\w .-]{2,60}?)["”']?[.,;]/gi,
]);

// "**Term** — definition", "Term: definition" in a definition-list shape, or a bolded lead-in.
const DEFINED_TERM_PATTERNS = Object.freeze([
  /^\s*[-*]\s+\*\*([^*]{2,60})\*\*\s*[—:-]/gm,
  /^\s*\*\*([^*]{2,60})\*\*\s*[—:-]/gm,
  /^\s*([A-Z][\w .-]{2,60}?)\s*:\s{1,3}[A-Z]/gm,
]);

const collect = (pattern, source, groupIndex = 1) => {
  const found = [];
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match;
  while ((match = regex.exec(source)) !== null) {
    const value = match[groupIndex];
    if (value && value.trim()) found.push({ value: value.trim(), index: match.index });
  }
  return found;
};

/** 1-based line number for a byte/char offset. */
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const offsetAtLine = (source, line) => {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return offset;
};

/**
 * Build the mention namespace for one document.
 *
 * A mention ID asserts "this exact source mention", NOT "globally the same entity as X". That
 * distinction is the whole point: a source-local ID is grounded, not invented.
 */
export function prepassDocument({ path, content, source_sha = null, corpus_digest = null }) {
  if (!path || typeof path !== 'string') throw new PrepassError('INVALID_PATH', 'prepass requires a document path');
  const source = text(content);
  const inventory = inventoryMarkdown({ path, content: source, source_sha, corpus_digest });

  const mentionsBySurface = new Map();
  const addMention = ({ surface, kind, offset }) => {
    const key = `${kind}\u0000${norm(surface)}`;
    const line = lineAt(source, offset);
    const existing = mentionsBySurface.get(key);
    if (existing) {
      if (!existing.lines.includes(line)) existing.lines.push(line);
      existing.occurrences += 1;
      return existing;
    }
    const body = { file: path, kind, surface: surface.trim(), normalized: norm(surface) };
    const entry = { ...body, id: `mention:${sha256(stableStringify(body).trim())}`, lines: [line], occurrences: 1 };
    mentionsBySurface.set(key, entry);
    return entry;
  };

  for (const pattern of SYMBOL_PATTERNS) {
    for (const hit of collect(pattern, source)) addMention({ surface: hit.value, kind: 'symbol', offset: hit.index });
  }
  for (const pattern of DEFINED_TERM_PATTERNS) {
    for (const hit of collect(pattern, source)) addMention({ surface: hit.value, kind: 'defined_term', offset: hit.index });
  }
  for (const block of inventory.blocks) {
    if (block.type !== 'heading') continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(block.text.split('\n')[0]);
    if (heading) addMention({ surface: heading[1], kind: 'heading', offset: source.indexOf(block.raw) });
  }

  const structured = extractStructuredObservations({ file: path, content: source, inventory });
  for (const row of structured.observations) {
    const leaf = row.field_path.split('.').filter(Boolean).at(-1);
    if (leaf) addMention({ surface: leaf, kind: 'structured_field', offset: offsetAtLine(source, row.source_span.start) });
    if (typeof row.value === 'string' && /^(?:[A-Z][A-Z0-9_]{2,}|[A-Za-z_$][\w$]*(?:[./:][\w$]+)+)$/.test(row.value)) {
      addMention({ surface: row.value, kind: 'structured_value', offset: offsetAtLine(source, row.source_span.start) });
    }
  }
  // Diagram identifiers are documentary evidence, not structure. They are addressable mentions so a
  // claim can cite an architecture diagram, but buildReconciliationCandidates excludes this kind
  // from repeated-identifier signals so generic node names cannot forge cross-document clusters.
  for (const row of structured.diagram_identifiers || []) {
    addMention({ surface: row.surface, kind: 'diagram_identifier', offset: offsetAtLine(source, row.line) });
  }
  const sectionReferences = extractSectionReferences({ file: path, content: source, inventory });

  // Source-cited aliases. Each carries the exact span that states the alias, so the merge-time
  // ledger never has to trust similarity.
  const aliases = [];
  for (const pattern of ALIAS_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(source)) !== null) {
      const [, a, b] = match;
      const line = lineAt(source, match.index);
      const left = norm(a), right = norm(b ?? a);
      if (!left || !right || left === right) continue;
      aliases.push({
        alias: right, refers_to: left,
        source_span: { file: path, start: line, end: line },
        evidence: match[0].slice(0, 200),
      });
    }
  }

  const mentions = [...mentionsBySurface.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.normalized.localeCompare(b.normalized));
  const body = {
    schema: PREPASS_SCHEMA,
    file: path,
    source_sha,
    corpus_digest,
    source_digest: inventory.source_digest,
    blocks: inventory.blocks.length,
    mentions,
    aliases: aliases.sort((x, y) => x.alias.localeCompare(y.alias) || x.refers_to.localeCompare(y.refers_to)),
    structured_observations: structured.observations,
    section_references: sectionReferences.references,
    findings: [...structured.findings, ...sectionReferences.findings]
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  };
  return Object.freeze({ ...body, digest: sha256(stableStringify(body).trim()), inventory });
}

/** Index mentions across documents for extraction-time lookup and merge-time candidate generation. */
export function buildMentionNamespace(prepasses = []) {
  const byId = new Map(), byNormalized = new Map();
  for (const pre of prepasses) {
    for (const mention of pre.mentions) {
      byId.set(mention.id, mention);
      const list = byNormalized.get(mention.normalized) || [];
      list.push(mention);
      byNormalized.set(mention.normalized, list);
    }
  }
  const aliases = prepasses.flatMap(pre => pre.aliases);
  return Object.freeze({
    size: byId.size,
    get: id => byId.get(id) || null,
    /** Exact-surface lookup only. Similarity may PROPOSE elsewhere; it never resolves here. */
    lookup: surface => (byNormalized.get(norm(surface)) || []).slice(),
    /** Cross-document surfaces are merge-time CANDIDATES, never automatic identities. */
    ambiguous: () => [...byNormalized.entries()]
      .filter(([, list]) => new Set(list.map(m => m.file)).size > 1)
      .map(([normalized, list]) => ({ normalized, files: [...new Set(list.map(m => m.file))].sort() }))
      .sort((a, b) => a.normalized.localeCompare(b.normalized)),
    aliases: () => aliases.slice(),
    digest: sha256(stableStringify(prepasses.map(p => p.digest).sort()).trim()),
  });
}

/**
 * Render the grounded candidate menu shown to the extractor. The model SELECTS from real source
 * mentions or emits its own source span; it is never asked to invent a canonical identifier.
 */
export function renderMentionMenu(prepass, { limit = 120 } = {}) {
  const rows = prepass.mentions
    .slice()
    .sort((a, b) => b.occurrences - a.occurrences || a.normalized.localeCompare(b.normalized))
    .slice(0, limit)
    .map(m => JSON.stringify({ mention: m.id.slice(0, 22), kind: m.kind, surface: m.surface, lines: m.lines.slice(0, 4) }));
  return rows.join('\n');
}

const exactIndexes = (source, needle) => {
  const indexes = [];
  let from = 0;
  while (needle && from <= source.length - needle.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
};

/**
 * Turn document-level mention aggregates into prompt-local exact occurrences. The model sees only
 * short `sNNN` selectors; every selector is deterministically bound to one block, occurrence,
 * byte range, source digest, and exact surface before inference.
 */
export function buildWindowSubjectOccurrences({
  prepass, catalog, limit = 120, prefer_maximal_identifiers = false,
  strip_qualified_line_ranges = false, strict_qualified_code_spans = false,
}) {
  const candidates = [];
  for (const mention of prepass?.mentions || []) {
    for (const block of catalog?.entries || []) {
      const indexes = exactIndexes(block.text, mention.surface);
      indexes.forEach((offset, ordinal) => {
        const line = block.start + (block.text.slice(0, offset).match(/\n/g) || []).length;
        if (!mention.lines.includes(line)) return;
        const byteStart = block.byte_start + Buffer.byteLength(block.text.slice(0, offset), 'utf8');
        const body = {
          schema: SUBJECT_OCCURRENCE_SCHEMA,
          window_id: catalog.window_id,
          mention_id: mention.id,
          kind: mention.kind,
          surface: mention.surface,
          block_token: block.token,
          block_id: block.block_id,
          block_digest: block.digest,
          role: block.role,
          occurrence: ordinal + 1,
          line,
          byte_start: byteStart,
          byte_end: byteStart + Buffer.byteLength(mention.surface, 'utf8'),
          text_digest: sha256(mention.surface),
        };
        candidates.push({ ...body, id: `subject-occurrence:${sha256(stableStringify(body).trim())}` });
      });
    }
  }
  if (prefer_maximal_identifiers) {
    // The legacy symbol recognizer intentionally stops at punctuation such as `-`. For @12, add
    // exact code-fenced qualified paths directly from prompt-local blocks so the whole source
    // identity can dominate a nested basename or suffix found by another recognizer.
    for (const block of catalog?.entries || []) {
      // The strict treatment enumerates real code spans first, then selects path-like contents.
      // The frozen older treatments retain their matcher because changing their selector menus
      // would silently rewrite already-measured model-visible contracts.
      const matches = strict_qualified_code_spans
        ? block.text.matchAll(/`([^`\n]+)`/g)
        : block.text.matchAll(/`([^`\n]*[/\\][^`\n]+)`/g);
      for (const match of matches) {
        if (strict_qualified_code_spans && !/[/\\]/.test(match[1])) continue;
        const surface = strip_qualified_line_ranges
          ? match[1].replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '')
          : match[1].replace(/:\d+(?:-\d+)?$/, '');
        if (!surface) continue;
        const offset = Number(match.index || 0) + 1;
        const byteStart = block.byte_start + Buffer.byteLength(block.text.slice(0, offset), 'utf8');
        const body = {
          schema: SUBJECT_OCCURRENCE_SCHEMA,
          window_id: catalog.window_id,
          mention_id: null,
          kind: 'qualified_identifier',
          surface,
          block_token: block.token,
          block_id: block.block_id,
          block_digest: block.digest,
          role: block.role,
          occurrence: exactIndexes(block.text, surface).indexOf(offset) + 1,
          line: block.start + (block.text.slice(0, offset).match(/\n/g) || []).length,
          byte_start: byteStart,
          byte_end: byteStart + Buffer.byteLength(surface, 'utf8'),
          text_digest: sha256(surface),
        };
        candidates.push({ ...body, id: `subject-occurrence:${sha256(stableStringify(body).trim())}` });
      }
    }
  }
  const kindRank = new Map([
    ['qualified_identifier', 0], ['defined_term', 1], ['symbol', 2], ['structured_field', 3],
    ['structured_value', 4], ['heading', 5], ['diagram_identifier', 6],
  ]);
  let unique = [...new Map(candidates.map(row => [row.id, row])).values()];
  if (prefer_maximal_identifiers) {
    // Multiple conservative recognizers can find `vision.md` inside the same exact occurrence of
    // `design/canon/orchestration-vision.md`. Offering both invites the model to mint two identities
    // for one source token. Keep the maximal qualified symbol while preserving unrelated mentions.
    const identifierKinds = new Set(['symbol', 'qualified_identifier']);
    unique = unique.filter(candidate => !identifierKinds.has(candidate.kind) || !unique.some(other =>
      other !== candidate && identifierKinds.has(other.kind) && other.block_token === candidate.block_token
      && other.byte_start <= candidate.byte_start && other.byte_end >= candidate.byte_end
      && (other.byte_start < candidate.byte_start || other.byte_end > candidate.byte_end)));
  }
  const selected = unique
    .sort((a, b) => (a.role === 'primary' ? 0 : 1) - (b.role === 'primary' ? 0 : 1)
      || (kindRank.get(a.kind) ?? 9) - (kindRank.get(b.kind) ?? 9)
      || a.block_token.localeCompare(b.block_token) || a.byte_start - b.byte_start || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map((row, index) => Object.freeze({ ...row, ref: `s${String(index + 1).padStart(3, '0')}` }));
  return Object.freeze(selected);
}

export function renderSubjectOccurrenceMenu(occurrences = []) {
  return occurrences.map(row => JSON.stringify({
    subject_occurrence: row.ref,
    kind: row.kind,
    surface: row.surface,
    block: row.block_token,
    occurrence: row.occurrence,
    line: row.line,
  })).join('\n');
}
