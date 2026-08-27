// Deterministic source-unit and child proposition-obligation construction.
//
// Contact is intentionally not coverage. Existing claims may be shown to have touched exact source
// bytes, but only an explicit candidate-characterization receipt may verify that a child obligation
// was represented. The constructor therefore overgenerates conservative obligations and gives each
// one an exact, tool-owned source locator whose stable identity excludes unrelated global snapshots.
import { sha256, stableStringify } from './lib.mjs';
import { inventoryIndex } from './recursive-contracts.mjs';

export const PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION = 'proposition-obligations@10-table-rank-ownership';
export const SOURCE_UNIT_SCHEMA = 'estate-map/source-unit/v1';
export const CANDIDATE_OBLIGATION_SCHEMA = 'estate-map/candidate-obligation/v1';
export const CONTACT_LEDGER_SCHEMA = 'estate-map/candidate-contact-ledger/v1';
export const COVERAGE_RECEIPT_SCHEMA = 'estate-map/candidate-coverage-receipt/v1';

const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const newlineCount = value => (String(value).match(/\n/g) || []).length;
const clean = value => String(value ?? '').trim();
const leadingPredicateVerb = /^(?:is|are|was|were|has|have|must|may|should|will|can|cannot|does|do|mean|means|state|states|define|defines|denote|denotes|provide|provides|render|renders|return|returns|become|becomes|use|uses|require|requires|add|adds|lack|lacks|process|processes|report|reports|retire|retires|occur|occurs|reject|rejects|store|stores|resolve|resolves|reconcile|reconciles|gate|gates|control|controls|remain|remains|live|lives|fix|fixes|ship|ships|invoke|invokes|reuse|reuses|match|matches|produce|produces|own|owns|carry|carries|track|tracks|drive|drives|head|heads|miss|misses|adopt|adopts|exit|exits|apply|applies|keep|keeps|share|shares|put|puts)\b/iu;
export const isUnsafePredicateActorSurface = value => leadingPredicateVerb.test(clean(value));

function exactSpan(block, start, end) {
  const text = block.text.slice(start, end);
  const prefix = block.text.slice(0, start);
  const startLine = block.start + newlineCount(prefix);
  return Object.freeze({
    file: block.file,
    block_address: block.address,
    block_id: block.id,
    block_digest: block.digest,
    start: startLine,
    end: startLine + newlineCount(text),
    byte_start: block.byte_start + Buffer.byteLength(prefix, 'utf8'),
    byte_end: block.byte_start + Buffer.byteLength(block.text.slice(0, end), 'utf8'),
    text,
    text_digest: sha256(text),
  });
}

function trimmedSpan(source, start, end) {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function lineSpans(text) {
  const rows = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    rows.push({ start, end, text: text.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

function sentenceSpans(text) {
  const boundaries = [0];
  const split = /[.!?](?:["'”’)*_`\]]*)\s+(?=(?:[A-Z0-9`*_([]|Do\b|If\b|When\b|Before\b|After\b))/gu;
  for (const match of text.matchAll(split)) boundaries.push(Number(match.index) + match[0].length);
  boundaries.push(text.length);
  return boundaries.slice(0, -1).map((start, index) => trimmedSpan(text, start, boundaries[index + 1]))
    .filter(span => span.end > span.start);
}

function listItemSpans(text) {
  const starts = [...text.matchAll(/(?:^|\n)([ \t]*(?:[-+*]|\d+[.)])[ \t]+)/g)]
    .map(match => Number(match.index) + (match[0].startsWith('\n') ? 1 : 0));
  if (!starts.length) return [];
  return starts.map((start, index) => trimmedSpan(text, start, starts[index + 1] ?? text.length));
}

function schemaPropertySpans(text) {
  const lines = lineSpans(text);
  const starts = lines.map((row, index) => {
    const match = /^(\s*)(?:-\s+)?(?:["']?[$A-Za-z_][\w$.-]*["']?)\s*:/.exec(row.text);
    return match ? { index, indent: match[1].replace(/\t/g, '  ').length, start: row.start } : null;
  }).filter(Boolean);
  return starts.map((held, ordinal) => {
    let end = text.length;
    for (const next of starts.slice(ordinal + 1)) {
      if (next.indent > held.indent) continue;
      end = lines[next.index - 1]?.end ?? next.start;
      break;
    }
    return trimmedSpan(text, held.start, end);
  });
}

function sourceUnitSpans(block) {
  if (block.type === 'separator') return [];
  // YAML/JSON structure takes precedence over Markdown's visual classification. In particular,
  // a YAML sequence record beginning with "- id:" is not one prose list item whose scalar id can
  // inherit every nested property below it.
  if (/\.(?:ya?ml|json|jsonc)$/iu.test(block.file)) {
    const properties = schemaPropertySpans(block.text);
    if (properties.length) return properties.map(span => ({ ...span, kind: 'schema_property' }));
  }
  // Broad source-addressed units are additive. Retain the legacy sentence units so current A1
  // claims can span a whole non-Markdown block or heading without changing the pinned proposition
  // opportunity plane that measured V32 candidate behavior.
  if (!/\.mdx?$/iu.test(block.file)) return [
    { start: 0, end: block.text.length, kind: 'source_block' },
    ...sentenceSpans(block.text).map(span => ({ ...span, kind: 'sentence' })),
  ];
  if (block.type === 'heading') return [
    { start: 0, end: block.text.length, kind: 'heading' },
    ...sentenceSpans(block.text).map(span => ({ ...span, kind: 'sentence' })),
  ];
  if (block.type === 'table') return lineSpans(block.text)
    .filter(row => clean(row.text) && !/^\s*\|?\s*:?-{3,}/.test(row.text))
    .map(row => ({ ...trimmedSpan(block.text, row.start, row.end), kind: 'table_row' }));
  if (block.type === 'list') return listItemSpans(block.text)
    .map(span => ({ ...span, kind: 'list_item' }));
  if (['code', 'front_matter'].includes(block.type) || /\.(?:ya?ml|json|jsonc)$/iu.test(block.file)) {
    const properties = schemaPropertySpans(block.text);
    if (properties.length) return [
      { start: 0, end: block.text.length, kind: 'structured_block' },
      ...properties.map(span => ({ ...span, kind: 'schema_property' })),
    ];
  }
  return sentenceSpans(block.text).map(span => ({ ...span, kind: 'sentence' }));
}

function tableCells(text) {
  const cells = [];
  let cursor = text.startsWith('|') ? 1 : 0;
  let cellStart = cursor;
  let escaped = false;
  for (; cursor <= text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '\\' && !escaped) { escaped = true; continue; }
    if ((character === '|' && !escaped) || cursor === text.length) {
      const span = trimmedSpan(text, cellStart, cursor);
      if (span.end > span.start) cells.push(span);
      cellStart = cursor + 1;
    }
    escaped = false;
  }
  return cells;
}

const tableHeaderLabel = value => clean(value).replace(/[*_`~]/gu, '').replace(/\s+/gu, ' ').toLowerCase();
const ordinalTableHeader = value => /^(?:#|no\.?|number|rank|order|ordinal|position|priority)$/u.test(tableHeaderLabel(value));
const entityTableHeader = value => /\b(?:area|candidate|component|entity|event|feature|item|name|option|phase|proposal|source|step|technique|type|witness)\b/u
  .test(tableHeaderLabel(value));

const typedSignals = Object.freeze([
  ['condition', /\b(?:if|when|whenever|before|after|until|unless|provided that|only if|while)\b/iu],
  ['exception', /\b(?:except|exception|unless|other than|but not)\b/iu],
  ['prohibition', /\b(?:do not|don't|must not|may not|never|prohibited|forbidden|no\s+[^.;:]{1,80}\s+may)\b/iu],
  ['consequence', /\b(?:therefore|thereby|then|so that|results? in|causes?|leads? to|becomes?|retires?|is lost)\b/iu],
]);

function childSpans(unit) {
  const text = unit.locator.text;
  const rows = [{ kind: 'main_clause', start: 0, end: text.length }];
  // Numbered list position is documentary content when the source explicitly authors it. Keep it
  // distinct from the proposition that follows so a characterization cannot silently discard the
  // item's ordinal (a recurring strict-recall failure in the fresh confirmation).
  const listOrdinal = /^\s*(\d+)[.)]\s+/u.exec(text);
  if (unit.unit_kind === 'list_item' && listOrdinal) {
    rows.push({ kind: 'ordinal_membership', start: Number(listOrdinal.index), end: listOrdinal[0].length });
  }
  // Labels such as "Member 1 is X" carry an ordinal classification independently of the
  // characteristics that follow the colon. Keep that proposition as its own obligation instead
  // of relying on a broad main-clause characterization to notice it.
  for (const match of text.matchAll(/(?:\*\*)?Member\s+\d+\s+is\s+`[^`\n]+`(?::(?:\*\*)?)?/giu)) {
    rows.push({ kind: 'ordinal_membership', start: Number(match.index), end: Number(match.index) + match[0].length });
  }
  if (unit.unit_kind === 'table_row') {
    tableCells(text).forEach((span, table_column_index) => rows.push({ kind: 'table_cell', table_column_index, ...span }));
  }
  if (unit.unit_kind === 'schema_property') {
    rows.push({ kind: 'schema_constraint', start: 0, end: text.length });
  }
  for (const [kind, pattern] of typedSignals) {
    if (pattern.test(text)) rows.push({ kind, start: 0, end: text.length });
  }
  const conjunctions = [...text.matchAll(/\s+(?:and|or|but|while|yet)\s+/giu)];
  for (const match of conjunctions) {
    const left = trimmedSpan(text, 0, Number(match.index));
    const right = trimmedSpan(text, Number(match.index) + match[0].length, text.length);
    if (left.end - left.start >= 4) rows.push({ kind: 'coordinated_clause', ...left });
    if (right.end - right.start >= 4) rows.push({ kind: 'coordinated_clause', ...right });
  }
  return [...new Map(rows.map(row => [`${row.kind}\0${row.start}\0${row.end}`, row])).values()]
    .sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
}

function subjectHandles(unit, block, tableHeader = null) {
  const text = unit.locator.text;
  const candidates = [];
  const add = (start, end, handleKind, priority, metadata = {}) => {
    const span = trimmedSpan(text, start, end);
    if (span.end <= span.start) return;
    let surface = text.slice(span.start, span.end);
    // Markdown decoration and list ordinals are addressing syntax, not semantic actor text.
    const prefix = /^(?:[-+*]\s+|\d+[.)]\s+|\*\*)+/u.exec(surface)?.[0] || '';
    const suffix = /\*\*$/u.exec(surface)?.[0] || '';
    const cleanStart = span.start + prefix.length;
    const cleanEnd = span.end - suffix.length;
    if (cleanEnd <= cleanStart) return;
    surface = text.slice(cleanStart, cleanEnd).trim();
    if (!surface) return;
    const offset = text.indexOf(surface, cleanStart);
    if (handleKind === 'predicate_actor' && /^(?:it|its|they|their|this|these|those|there)\b/iu.test(surface)) {
      handleKind = 'anaphoric_subject';
      priority = 20;
    }
    // Predicate discovery is deliberately recall-biased and some documentary nouns (notably
    // "state") are also verbs. Never promote the resulting predicate phrase itself as an actor.
    // A real actor may contain a verb later ("The estimate puts ..."), but it must not begin with
    // the verb token that a false parse left on the subject side.
    if (handleKind === 'predicate_actor' && isUnsafePredicateActorSurface(surface)) return;
    candidates.push({ surface, start: offset, end: offset + surface.length,
      handle_kind: handleKind, priority, ...metadata });
  };
  const addDecorated = (start, end, handleKind, priority, metadata = {}) => {
    let span = trimmedSpan(text, start, end);
    let surface = text.slice(span.start, span.end);
    const listPrefix = /^(?:[-+*]|\d+[.)])\s+/u.exec(surface)?.[0] || '';
    span = { start: span.start + listPrefix.length, end: span.end };
    surface = text.slice(span.start, span.end);
    const wrappers = [['**', '**'], ['__', '__'], ['~~', '~~'], ['`', '`']];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [left, right] of wrappers) if (surface.startsWith(left) && surface.endsWith(right)
        && surface.length > left.length + right.length) {
        span = { start: span.start + left.length, end: span.end - right.length };
        surface = text.slice(span.start, span.end);
        changed = true;
      }
    }
    const link = /^\[([^\]\n]+)\]\([^\n]+\)$/u.exec(surface);
    if (link) {
      const offset = surface.indexOf(link[1]);
      span = { start: span.start + offset, end: span.start + offset + link[1].length };
    }
    add(span.start, span.end, handleKind, priority, metadata);
  };

  // Structural syntax can predicate directly about values that are not grammatical noun phrases:
  // mapping-table keys, reference-list paths, metadata labels, and row cells. These handles remain
  // exact and source-unit-local; this does not reopen the old broad window-level subject menu.
  if (unit.unit_kind === 'table_row') {
    const headerCells = tableHeader?.text_digest !== unit.locator.text_digest
      ? tableCells(tableHeader.text) : [];
    const ordinalColumns = new Set(headerCells.flatMap((span, index) =>
      ordinalTableHeader(tableHeader.text.slice(span.start, span.end)) ? [index] : []));
    const nonOrdinalColumns = headerCells.map((span, index) => ({ span, index,
      label: tableHeader.text.slice(span.start, span.end) }))
      .filter(row => !ordinalColumns.has(row.index));
    const rowSubjectColumn = ordinalColumns.size
      ? (nonOrdinalColumns.find(row => entityTableHeader(row.label)) || nonOrdinalColumns[0])?.index
      : 0;
    tableCells(text).forEach((span, index) => {
      const cell = text.slice(span.start, span.end).trim();
      if (ordinalColumns.has(index)) {
        addDecorated(span.start, span.end, 'table_ordinal_label', 2, { table_column_index: index });
        return;
      }
      if (index === rowSubjectColumn && ordinalColumns.size) {
        const raw = text.slice(span.start, span.end);
        const leading = /^\s*(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`)/u.exec(raw);
        if (leading) {
          const surface = leading[1] || leading[2] || leading[3];
          const start = span.start + raw.indexOf(surface, Number(leading.index));
          add(start, start + surface.length, 'table_row_subject', 1, { table_column_index: index });
          return;
        }
      }
      // A prose table cell is not automatically an entity. Retain exact structural values and
      // references, but let grammatical-actor discovery handle sentence-like cell content.
      const structural = index === rowSubjectColumn || (cell.length <= 100
        && (!/[.;!?]\s/u.test(cell) || /^`[^`]+`$/u.test(cell) || /(?:^|\/)\w[\w.-]*\.(?:md|mjs|js|json|ya?ml)$/iu.test(cell)));
      if (structural) addDecorated(span.start, span.end,
        index === rowSubjectColumn ? 'table_row_subject' : 'table_cell_reference',
        index === rowSubjectColumn ? 1 : 8, { table_column_index: index });
    });
  }
  if (unit.unit_kind === 'list_item') {
    const contentStart = /^(?:\s*)(?:[-+*]|\d+[.)])\s+/u.exec(text)?.[0].length || 0;
    const remainder = text.slice(contentStart);
    const dash = /\s+(?:—|–|-)\s+/u.exec(remainder);
    const leadingBold = /^\*\*([^*\n]+)\*\*/u.exec(remainder);
    if (dash && dash.index > 0) addDecorated(contentStart, contentStart + dash.index, 'list_item_subject', 1);
    else if (leadingBold) addDecorated(contentStart, contentStart + leadingBold[0].length, 'list_item_subject', 1);
    else {
      const colon = remainder.indexOf(':');
      if (colon > 0 && colon < 160) addDecorated(contentStart, contentStart + colon, 'list_item_subject', 4);
    }
  }
  const metadata = /^\s*(?:\*\*)?([^:\n]{1,100})(?:\*\*)?\s*:/u.exec(text);
  if (metadata) {
    const offset = text.indexOf(metadata[1], Number(metadata.index));
    addDecorated(offset, offset + metadata[1].length, 'metadata_subject', 2);
  }
  if (unit.unit_kind === 'schema_property') {
    const stack = [];
    for (const row of lineSpans(text)) {
      const match = /^(\s*)(?:-\s+)?(["']?)([$A-Za-z_][\w$.-]*)\2\s*:/.exec(row.text);
      if (!match) continue;
      const indent = match[1].replace(/\t/g, '  ').length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const key = match[3];
      const keyOffset = row.start + match[0].indexOf(key);
      const schemaPath = [...stack.map(item => item.key), key].join('.');
      add(keyOffset, keyOffset + key.length, 'schema_property_subject', Math.min(6, stack.length), {
        schema_path: schemaPath,
        schema_depth: stack.length,
      });
      stack.push({ key, indent });
    }
  }
  const patterns = [
    /`([^`\n]{1,160})`/gu,
    /\*\*([^*\n]{1,160})\*\*/gu,
    /\b(?:[A-Za-z_$][\w$-]*\/)+(?:[A-Za-z_$][\w$.-]*)\b/gu,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/gu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const inner = match[1] ?? match[0];
    const offset = Number(match.index) + match[0].indexOf(inner);
    add(offset, offset + inner.length, 'literal_reference', 30);
  }

  // Discover grammatical actors independently inside table cells and punctuation-delimited
  // clauses. This prevents a Markdown heading or whole row from displacing the actual actor.
  const segmentSpans = unit.unit_kind === 'table_row'
    ? tableCells(text)
    : [{ start: 0, end: text.length }];
  const predicate = /\b(?:is|are|was|were|has|have|must|may|should|will|can|cannot|does|do|means?|states|defines?|denotes?|provides?|renders?|returns?|becomes?|uses?|requires?|adds?|lacks?|processes?|reports?|retires?|occurs?|rejects?|stores?|resolves?|reconciles?|reconciled|gates?|controls?|remains?|lives?|fix(?:es|ed)?|ships?|shipped|invokes?|invoked|reuses?|reused|matches?|matched|produces?|produced|owns?|owned|carr(?:y|ies|ied)|tracks?|tracked|drives?|drove|heads?|misses?|missed|adopts?|adopted|exits?|exited|applies|applied|keeps?|kept|shares?|shared|puts?|put)\b/giu;
  for (const segment of segmentSpans) {
    const segmentText = text.slice(segment.start, segment.end);
    for (const match of segmentText.matchAll(/(?:\*\*)?Member\s+\d+\s+is\s+`([^`\n]+)`/giu)) {
      const inner = match[1];
      const start = segment.start + Number(match.index) + match[0].indexOf(inner);
      add(start, start + inner.length, 'membership_actor', 0);
    }
    for (const match of segmentText.matchAll(predicate)) {
      const predicateStart = segment.start + Number(match.index);
      const before = text.slice(segment.start, predicateStart);
      const conjunctions = [...before.matchAll(/\b(?:and|or|but|while|yet)\b/giu)];
      const conjunctionBoundary = conjunctions.length
        ? Number(conjunctions.at(-1).index) + conjunctions.at(-1)[0].length : -1;
      // A dot inside a path, version, or code literal is not a clause boundary. Only punctuation
      // followed by whitespace may delimit the actor phrase.
      const punctuation = [...before.matchAll(/[.;:](?:\*\*)?\s+/gu)];
      const punctuationBoundary = punctuation.length
        ? Number(punctuation.at(-1).index) + punctuation.at(-1)[0].length : 0;
      const boundary = Math.max(punctuationBoundary, conjunctionBoundary);
      let actorStart = segment.start + Math.max(0, boundary);
      const actorText = text.slice(actorStart, predicateStart);
      const label = /^\s*(?:\d+[.)]\s+)?\*\*[^*]+\*\*\s*/u.exec(actorText)?.[0];
      if (label) actorStart += label.length;
      add(actorStart, predicateStart, 'predicate_actor', 0, { predicate_token: match[0].toLowerCase() });
    }
    for (const match of segmentText.matchAll(/^\s*Missing\s+([^|.;]{2,140})\s*$/gu)) {
      const inner = match[1];
      const start = segment.start + Number(match.index) + match[0].indexOf(inner);
      add(start, start + inner.length, 'missing_subject', 0);
    }
    const equals = segmentText.indexOf('=');
    if (equals > 0) {
      const beforeEquals = segmentText.slice(0, equals);
      const boundary = Math.max(beforeEquals.lastIndexOf('.'), beforeEquals.lastIndexOf(';'), beforeEquals.lastIndexOf(':'));
      add(segment.start + boundary + 1, segment.start + equals, 'equality_subject', 0);
    }
  }
  if (!candidates.length) {
    const fallback = /[A-Za-z0-9_$][^|,;:.!?\n]{1,100}/u.exec(text);
    if (fallback) add(Number(fallback.index), Number(fallback.index) + fallback[0].length, 'lexical_fallback', 50);
  }
  // If predicate discovery sees a noun/verb ambiguity ("complexity gate controls ..."), the first
  // parse may offer the truncated actor "complexity" while the later predicate yields the exact
  // actor "complexity gate". Never expose the prefix when a same-start predicate actor strictly
  // contains it by one token.
  const nondominated = candidates.filter(row => !(row.handle_kind === 'predicate_actor'
    && candidates.some(other => other !== row && other.handle_kind === 'predicate_actor'
      && other.start === row.start && other.end > row.end
      && /^\s+[A-Za-z_$][\w$-]*$/u.test(text.slice(row.end, other.end)))));
  const ordered = nondominated.filter(row => clean(row.surface))
    .sort((a, b) => a.priority - b.priority || (b.end - b.start) - (a.end - a.start));
  const firstBySpan = new Map();
  for (const row of ordered) {
    const key = `${row.start}\0${row.end}`;
    if (!firstBySpan.has(key)) firstBySpan.set(key, row);
  }
  const unique = [...firstBySpan.values()]
    .sort((a, b) => a.priority - b.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, 12)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  return unique.map((row, index) => {
    const localStart = unit.local_start + row.start;
    const locator = exactSpan(block, localStart, unit.local_start + row.end);
    const identity = { candidate_unit_id: unit.id, surface: row.surface, byte_start: locator.byte_start, byte_end: locator.byte_end };
    const { schema_path, schema_depth, predicate_token, table_column_index } = row;
    return Object.freeze({
      ref: `s${String(index + 1).padStart(3, '0')}`,
      id: hashId('candidate-subject-handle', identity),
      surface: row.surface,
      handle_kind: row.handle_kind,
      priority: row.priority,
      ...(schema_path ? { schema_path, schema_depth } : {}),
      ...(predicate_token ? { predicate_token } : {}),
      ...(Number.isInteger(table_column_index) ? { table_column_index } : {}),
      locator,
    });
  });
}

function tableHeaderSubjectHandles(unit, block, headerLocator) {
  if (unit.unit_kind !== 'table_row' || !headerLocator
    || headerLocator.text_digest === unit.locator.text_digest) return [];
  const headerStarts = [];
  let cursor = 0;
  while (cursor <= block.text.length - headerLocator.text.length) {
    const index = block.text.indexOf(headerLocator.text, cursor);
    if (index < 0) break;
    if (block.byte_start + Buffer.byteLength(block.text.slice(0, index), 'utf8') === headerLocator.byte_start) {
      headerStarts.push(index);
    }
    cursor = index + Math.max(1, headerLocator.text.length);
  }
  if (headerStarts.length !== 1) return [];
  const headerStart = headerStarts[0];
  const handles = [];
  for (const [tableColumnIndex, cell] of tableCells(headerLocator.text).entries()) {
    const cellText = headerLocator.text.slice(cell.start, cell.end);
    const match = /\b(?:this|current)\s+(?:dossier|document|file|readme)\b/iu.exec(cellText);
    if (!match) continue;
    const localStart = headerStart + cell.start + Number(match.index);
    const locator = exactSpan(block, localStart, localStart + match[0].length);
    const identity = {
      candidate_unit_id: unit.id,
      surface: locator.text,
      byte_start: locator.byte_start,
      byte_end: locator.byte_end,
      table_column_index: tableColumnIndex,
    };
    handles.push(Object.freeze({
      ref: '',
      id: hashId('candidate-subject-handle', identity),
      surface: locator.text,
      handle_kind: 'table_column_subject',
      table_column_index: tableColumnIndex,
      priority: 0,
      locator,
    }));
  }
  return handles;
}

export function buildPropositionObligationInventory({ inventories, block_addresses = null }) {
  const index = inventoryIndex(inventories);
  const selected = block_addresses == null
    ? [...index.byAddress.values()]
    : [...new Set(block_addresses)].map(address => {
        const block = index.byAddress.get(address);
        if (!block) throw new Error(`unknown candidate block ${address}`);
        return block;
      });
  const units = [];
  for (const block of selected.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index)) {
    for (const held of sourceUnitSpans(block)) {
      const locator = exactSpan(block, held.start, held.end);
      const identity = {
        constructor: PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
        unit_kind: held.kind,
        file: locator.file,
        block_address: locator.block_address,
        byte_start: locator.byte_start,
        byte_end: locator.byte_end,
        text_digest: locator.text_digest,
      };
      units.push({
        schema: SOURCE_UNIT_SCHEMA,
        id: hashId('source-unit', identity),
        constructor_version: PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
        unit_kind: held.kind,
        local_start: held.start,
        local_end: held.end,
        locator,
        parent_block_digest: block.digest,
        heading_ancestry: block.heading_ancestry || [],
        block,
      });
    }
  }
  const obligations = [];
  const governingHeadingByBlock = new Map();
  for (const sourceInventory of index.inventories) {
    let activeHeading = null;
    for (const block of sourceInventory.blocks.slice().sort((a, b) => a.index - b.index)) {
      if (block.type === 'heading') activeHeading = block;
      else if (activeHeading && (block.heading_ancestry || []).length) {
        governingHeadingByBlock.set(block.address, exactSpan(activeHeading, 0, activeHeading.text.length));
      }
    }
  }
  const tableHeaderByBlock = new Map();
  for (const unit of units) if (unit.unit_kind === 'table_row' && !tableHeaderByBlock.has(unit.locator.block_id)) {
    tableHeaderByBlock.set(unit.locator.block_id, unit.locator);
  }
  const additiveUnitKinds = new Set(['source_block', 'heading', 'structured_block']);
  const legacyUnits = units.filter(unit => !additiveUnitKinds.has(unit.unit_kind));
  const legacyIndexById = new Map(legacyUnits.map((unit, index) => [unit.id, index]));
  const finalizedUnits = units.map((unit, index_) => {
    const contextUnits = additiveUnitKinds.has(unit.unit_kind) ? units : legacyUnits;
    const contextIndex = additiveUnitKinds.has(unit.unit_kind) ? index_ : legacyIndexById.get(unit.id);
    const prior = contextUnits[contextIndex - 1]?.locator;
    const next = contextUnits[contextIndex + 1]?.locator;
    // Context is exact and deliberately narrow: only adjacent structural units inside the same
    // parent block. It can resolve anaphora, but cannot silently bridge a paragraph, row, or item.
    const tableHeader = unit.unit_kind === 'table_row' ? tableHeaderByBlock.get(unit.locator.block_id) : null;
    const governingHeading = governingHeadingByBlock.get(unit.locator.block_address) || null;
    const contextLocators = [...new Map([
      governingHeading,
      tableHeader?.text_digest !== unit.locator.text_digest ? tableHeader : null,
      prior?.block_id === unit.locator.block_id ? prior : null,
      next?.block_id === unit.locator.block_id ? next : null,
    ].filter(Boolean).map(locator => [`${locator.block_id}\0${locator.byte_start}\0${locator.byte_end}`, locator])).values()];
    const localContextDigest = sha256(canonical({
      parent_block_digest: unit.parent_block_digest,
      context: contextLocators.map(locator => ({
        byte_start: locator.byte_start,
        byte_end: locator.byte_end,
        text_digest: locator.text_digest,
      })),
    }));
    const handles = [...subjectHandles(unit, unit.block, tableHeader),
      ...tableHeaderSubjectHandles(unit, unit.block, tableHeader)]
      .map((handle, index) => Object.freeze({ ...handle, ref: `s${String(index + 1).padStart(3, '0')}` }));
    const selfReferentialColumns = [...new Set(handles
      .filter(handle => handle.handle_kind === 'table_column_subject')
      .map(handle => handle.table_column_index))].sort((a, b) => a - b);
    for (const child of childSpans(unit)) {
      const localStart = unit.local_start + child.start;
      const locator = exactSpan(unit.block, localStart, unit.local_start + child.end);
      const identity = {
        constructor: PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
        source_unit_id: unit.id,
        obligation_kind: child.kind,
        byte_start: locator.byte_start,
        byte_end: locator.byte_end,
        text_digest: locator.text_digest,
        ...(Number.isInteger(child.table_column_index) ? { table_column_index: child.table_column_index } : {}),
      };
      const anaphoric = /\b(?:(?:that|this|these|those|such)\s+[A-Za-z_$`*][\w$`*.-]*|it|its|they|their|them|former|latter)\b/iu
        .test(locator.text);
      const candidateContext = [...new Map([
        governingHeading,
        ...(unit.unit_kind === 'table_row' && tableHeader?.text_digest !== unit.locator.text_digest ? [tableHeader] : []),
        ...(anaphoric && prior?.block_id === unit.locator.block_id ? [prior] : []),
      ].filter(Boolean).map(row => [`${row.block_id}\0${row.byte_start}\0${row.byte_end}`, row])).values()];
      obligations.push(Object.freeze({
        schema: CANDIDATE_OBLIGATION_SCHEMA,
        id: hashId('candidate-obligation', identity),
        constructor_version: PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
        source_unit_id: unit.id,
        source_unit_kind: unit.unit_kind,
        obligation_kind: child.kind,
        ...(Number.isInteger(child.table_column_index) ? {
          table_column_index: child.table_column_index,
          table_column_self_referential: selfReferentialColumns.includes(child.table_column_index),
        } : {}),
        table_has_self_referential_column: selfReferentialColumns.length > 0,
        locator,
        support_locator: unit.locator,
        // Governing headings preserve authored semantic force. Documentary anaphora additionally
        // resolves backward through the exact prior structural unit only when needed.
        context_locators: candidateContext,
        parent_block_digest: unit.parent_block_digest,
        local_context_digest: localContextDigest,
        subject_handles: handles,
      }));
    }
    const { block: _block, local_start: _start, local_end: _end, ...publicUnit } = unit;
    return Object.freeze({
      ...publicUnit,
      local_context_digest: localContextDigest,
      context_locators: contextLocators,
      subject_handles: handles,
    });
  });
  const body = {
    schema: 'estate-map/proposition-obligation-inventory/v1',
    constructor_version: PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
    units: finalizedUnits,
    obligations: obligations.sort((a, b) => a.locator.file.localeCompare(b.locator.file)
      || a.locator.byte_start - b.locator.byte_start || a.obligation_kind.localeCompare(b.obligation_kind)),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

const evidenceLocators = claim => (claim?.semantic?.support_sets || [])
  .flatMap(set => set?.locators || []).filter(locator => locator?.file && Number.isInteger(locator?.byte_start));
const overlaps = (left, right) => left.file === right.file
  && left.byte_start < right.byte_end && right.byte_start < left.byte_end;

export function backfillCandidateContactLedger({
  inventory, admitted_claims = [], rejected_candidate_contacts = new Map(),
  rejection_backfill_complete = false, unknown_rejected_proposals = 0,
}) {
  const rows = inventory.obligations.map(candidate => {
    const admitted = admitted_claims.filter(claim => evidenceLocators(claim)
      .some(locator => overlaps(locator, candidate.locator))).map(claim => claim.id).sort();
    const rejected = [...(rejected_candidate_contacts.get(candidate.id) || [])].sort();
    const contact_state = admitted.length ? 'contacted_by_admitted_claim'
      : rejected.length ? 'contacted_by_rejected_proposal'
      : rejection_backfill_complete ? 'untouched' : 'unknown';
    return Object.freeze({
      candidate_id: candidate.id,
      contact_state,
      admitted_claim_ids: admitted,
      rejected_proposal_ids: rejected,
      // Evidence overlap is never upgraded into semantic coverage. Existing artifacts have no
      // explicit candidate receipt, so every such obligation remains conservatively eligible.
      explicit_coverage_receipt_ids: [],
      follow_up_eligible: true,
      eligibility_reasons: [
        'no_verified_candidate_to_claim_receipt',
        ...(candidate.obligation_kind !== 'main_clause' ? ['child_obligation_requires_explicit_link'] : []),
      ],
    });
  });
  const body = {
    schema: CONTACT_LEDGER_SCHEMA,
    inventory_digest: inventory.digest,
    terminology: ['contacted_by_admitted_claim', 'contacted_by_rejected_proposal', 'untouched', 'unknown'],
    semantic_coverage_inferred_from_overlap: false,
    rejection_backfill_complete: Boolean(rejection_backfill_complete),
    unknown_rejected_proposals: Number(unknown_rejected_proposals || 0),
    rows,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function buildCoverageReceipt({
  candidate_id, execution_state, disposition, admitted_claim_ids = [], rejected_proposal_ids = [],
  attempt_id, verification_status = 'unverified',
}) {
  if (disposition === 'covered') throw new Error('coverage receipts may not use evidence contact as covered');
  if (!['emitted', 'rejected_only', 'abstained_unverified', 'terminal_incomplete'].includes(disposition)) {
    throw new Error(`unsupported candidate disposition ${disposition}`);
  }
  if (!['pending', 'completed', 'terminal_incomplete'].includes(execution_state)) {
    throw new Error(`unsupported candidate execution state ${execution_state}`);
  }
  const body = {
    schema: COVERAGE_RECEIPT_SCHEMA,
    candidate_id,
    execution_state,
    disposition,
    admitted_claim_ids: [...new Set(admitted_claim_ids)].sort(),
    rejected_proposal_ids: [...new Set(rejected_proposal_ids)].sort(),
    attempt_id,
    verification_status,
  };
  return Object.freeze({ ...body, id: hashId('coverage-receipt', body) });
}
