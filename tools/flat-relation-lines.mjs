// One wire format for every model that emits documentary claims.
//
// Evidence for this contract, all from paid units: a single nested JSON answer loses EVERYTHING when
// the model drops one bracket (atomic@1, $0.035796, six good relations lost); JSON lines contain the
// damage but deep nesting still fails systematically (atomic@2, $0.042863, all five lines closed
// `}}]}` instead of `}}]}]}`); flat depth-1 lines pass (atomic@3). Phase 3's 23 quarantined windows
// out of 364 are the same failure at scale. The tool owns coordinates, so it owns structure too.
//
// LIMITATION: one claim carries exactly one support set. `support_mode` preserves the
// all_required/alternative_support distinction, but a claim needing several INDEPENDENT support
// sets cannot be expressed on the wire and must be emitted as separate claims.
import { parseModelJsonStream } from './neural-json.mjs';

export const FLAT_LINE_SENTINEL = 'OUTPUT IS JSON LINES OF FLAT OBJECTS';

// Without a trailer, a response truncated at a token limit parses as a COMPLETE, shorter answer:
// the flat format would convert a loud unparseable failure into silent recall loss. The trailer
// makes truncation machine-detectable, so purchased-but-partial units are retained AND flagged.
export const FLAT_LINE_TRAILER_KIND = 'end';

const countLocatorAttempts = raw => (String(raw ?? '').match(/"source_locator"|"quote"/g) || []).length;
const stat = attempts => ({ proposed: attempts, resolved: 0, failed: attempts });

const FLAT_KEYS_BY_KIND = Object.freeze({
  head: new Set(['k', 'outcome', 'reason']),
  rel: new Set([
    'k', 'i', 'subject_binding', 'subject_occurrence', 'subject_ref', 'subject',
    'subject_block', 'subject_quote', 'occurrence', 'antecedent_block', 'antecedent_quote',
    'antecedent_occurrence', 'canonical_ref', 'family', 'predicate', 'object', 'polarity',
    'modality', 'quantifier', 'support_mode',
  ]),
  ev: new Set(['k', 'i', 'role', 'block', 'quote', 'occurrence']),
  [FLAT_LINE_TRAILER_KIND]: new Set(['k', 'count']),
});

function validFlatRepair(value, structuralKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = FLAT_KEYS_BY_KIND[String(value.k || '')];
  if (!allowed || Object.keys(value).some(key => !allowed.has(key))) return false;
  if (Object.values(value).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) return false;
  // JSON.parse accepts duplicate keys. A source quote that happens to contain a schema-shaped
  // fragment must not be allowed to masquerade as structure during recovery.
  return structuralKeys.length === new Set(structuralKeys).size;
}

/**
 * Recover one narrowly observed flat-wire defect: a model copies a byte-exact source quotation
 * containing `"..."` but forgets to JSON-escape those interior quote marks. A quote can close a
 * value only immediately before the object end or the next flat property. Everything else is an
 * interior quote and is escaped without changing the decoded value.
 *
 * This is intentionally not a general JSON repairer. Invalid escapes, missing closing braces,
 * nesting, unknown keys, and ambiguous duplicate keys remain malformed and are quarantined.
 */
export function repairUnescapedFlatQuotes(raw) {
  const source = String(raw ?? '').trim();
  if (!source.startsWith('{') || !source.endsWith('}')) return null;
  let repaired = '', inString = false, role = null, lastSignificant = null, repairs = 0;
  const structuralKeys = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      repaired += character;
      if (character === '"') {
        inString = true;
        role = lastSignificant === '{' || lastSignificant === ',' ? 'key' : 'value';
      } else if (!/\s/.test(character)) lastSignificant = character;
      continue;
    }
    if (character === '\\') {
      repaired += character;
      if (index + 1 < source.length) repaired += source[++index];
      continue;
    }
    if (character !== '"') { repaired += character; continue; }
    const tail = source.slice(index + 1);
    const closes = role === 'key'
      ? /^\s*:/.test(tail)
      : /^\s*}\s*$/.test(tail) || /^\s*,\s*"(?:[^"\\]|\\.)+"\s*:/.test(tail);
    if (!closes) { repaired += '\\"'; repairs += 1; continue; }
    if (role === 'key') {
      const keyStart = repaired.lastIndexOf('"') + 1;
      structuralKeys.push(repaired.slice(keyStart));
    }
    repaired += character;
    inString = false;
    role = null;
    lastSignificant = '"';
  }
  if (inString || !repairs) return null;
  try {
    const value = JSON.parse(repaired);
    return validFlatRepair(value, structuralKeys)
      ? Object.freeze({ value, repaired_line: repaired, repair_count: repairs }) : null;
  } catch { return null; }
}

/** Prompt lines describing the flat contract. `canonicalRef` adds the optional identifier field. */
export function flatLineContractLines({ canonicalRef = false, outcomeValues = 'linked', subjectMenu = false, subjectBinding = false } = {}) {
  return [
    `${FLAT_LINE_SENTINEL}. Never emit one big JSON document, an array wrapper, a nested object, a`,
    'nested array, code fences, blank lines, or prose. EVERY line is one flat object whose last two',
    'characters are `"}`. Deep nesting is what corrupts these answers, so the tool — not you —',
    'rebuilds the nested claim structure.',
    `LINE 1 (header): {"k":"head","outcome":"${outcomeValues}","reason":"..."}`,
    `CLAIM LINE: {"k":"rel","i":1,${subjectBinding ? '"subject_binding":"explicit|anaphoric|implicit_topic|unresolved","subject_occurrence":"s001",' : ''}"subject":"<exact source words>","subject_block":"b001","subject_quote":"<exact bytes>",${canonicalRef ? '"canonical_ref":"<omit unless the source itself defines it>",' : ''}${subjectBinding ? '"family":"identity|classification|definition|composition|dependency|causation|constraint|permission|prohibition|requirement|capability|configuration|precedence|lifecycle|measurement|other",' : ''}"predicate":"...","object":"...","polarity":"affirmed|negated","modality":"descriptive|normative|historical|constitutive|predictive","quantifier":"..."}`,
    'EVIDENCE LINE: {"k":"ev","i":1,"role":"primary","block":"b001","quote":"<exact bytes>"}',
    'Every claim needs its own rel line plus at least one primary ev line sharing the same integer i.',
    'Evidence is all-required by default: emit an ev line only when removing it would leave the claim',
    'unsupported. If instead ANY ONE ev line would suffice alone, add "support_mode":"alternative_support"',
    'to that claim rel line.',
    'Emit the rel line first, then its ev lines, then the next claim. Use "role":"context" for a',
    'supporting locator that cannot ground the claim alone. Copy quotes byte-exactly, including',
    'backticks, emphasis markers, and punctuation. Never author file, line, or byte coordinates.',
    'A quote under 24 characters needs an "occurrence":<n> field on that same line.',
    ...(subjectMenu ? [
      'PREFER "subject_ref":"mention:xxxx" copied from GROUNDED SUBJECT CANDIDATES instead of typing',
      '"subject" yourself. The tool then uses that mention exact source words as the subject.',
    ] : []),
    'FINAL LINE (mandatory): {"k":"end","count":<number of rel lines you emitted>}. Without it the',
    'answer is treated as truncated. Emit it even when you emit zero claims.',
  ];
}

const flatLocator = (block, quote, occurrence) => ({
  block_token: String(block ?? ''), quote: String(quote ?? ''),
  context_before: null, context_after: null,
  occurrence: occurrence == null ? null : Number(occurrence),
});

/** Serialize nested proposals back to the flat wire format. Inverse of parseFlatRelationAnswer. */
export function serializeFlatRelationAnswer({ outcome = 'extracted', reason = '', claims = [] }) {
  const lines = [JSON.stringify({ k: 'head', outcome, reason })];
  const trailer = () => JSON.stringify({ k: FLAT_LINE_TRAILER_KIND, count: claims.length });
  claims.forEach((claim, ordinal) => {
    const i = ordinal + 1, locator = claim.subject_mention?.source_locator || {};
    const rel = { k: 'rel', i, subject: claim.subject_mention?.surface, subject_block: locator.block_token,
      subject_quote: locator.quote, predicate: claim.predicate_family, object: claim.object_or_value,
      polarity: claim.polarity, modality: claim.modality, quantifier: claim.quantifier };
    if (claim.subject_binding) rel.subject_binding = claim.subject_binding;
    if (claim.subject_occurrence) rel.subject_occurrence = claim.subject_occurrence;
    if (claim.relation_family) rel.family = claim.relation_family;
    const antecedent = claim.subject_mention?.antecedent_locator || {};
    if (antecedent.block_token) rel.antecedent_block = antecedent.block_token;
    if (antecedent.quote) rel.antecedent_quote = antecedent.quote;
    if (antecedent.occurrence != null) rel.antecedent_occurrence = antecedent.occurrence;
    if (locator.occurrence != null) rel.occurrence = locator.occurrence;
    if (claim.canonical_ref) rel.canonical_ref = claim.canonical_ref;
    if ((claim.support_sets || []).some(set => set.mode === 'alternative_support')) rel.support_mode = 'alternative_support';
    lines.push(JSON.stringify(rel));
    for (const set of claim.support_sets || []) {
      for (const item of set.locators || []) {
        const source = item.source_locator || {};
        const ev = { k: 'ev', i, role: item.role || 'primary', block: source.block_token, quote: source.quote };
        if (source.occurrence != null) ev.occurrence = source.occurrence;
        lines.push(JSON.stringify(ev));
      }
    }
  });
  lines.push(trailer());
  return lines.join('\n');
}

/**
 * Parse a flat JSON-lines answer into nested v3.2 proposals.
 * Returns null when no header is present; otherwise { header, proposals, rejected }.
 * A malformed or orphaned line is quarantined individually and never voids its neighbours.
 */
export function parseFlatRelationAnswer(text) {
  const stream = parseModelJsonStream(text || '');
  if (!stream?.header) return null;
  const entries = stream.mode === 'stream' ? stream.entries : [];
  const proposals = [], rejected = [], repairs = [], byIndex = new Map();
  let declaredCount = null;
  for (const entry of entries) {
    const recovered = !entry.ok ? repairUnescapedFlatQuotes(entry.raw) : null;
    const row = entry.ok ? entry.value : recovered?.value;
    if (recovered) repairs.push(Object.freeze({
      index: entry.index, code: 'UNESCAPED_INTERIOR_QUOTE_RECOVERED',
      repair_count: recovered.repair_count,
    }));
    if (row && String(row?.k || '') === FLAT_LINE_TRAILER_KIND) {
      declaredCount = Number(row.count);
      continue;
    }
    if (!row) {
      rejected.push({ index: entry.index, code: 'MALFORMED_RELATION_LINE', detail: entry.error, locator_stats: stat(countLocatorAttempts(entry.raw)) });
      continue;
    }
    const kind = String(row?.k || ''), key = Number(row?.i);
    if (!Number.isInteger(key)) {
      rejected.push({ index: entry.index, code: 'LINE_WITHOUT_RELATION_INDEX', detail: 'flat line requires integer i', locator_stats: stat(countLocatorAttempts(entry.raw)) });
      continue;
    }
    if (kind === 'rel') {
      if (byIndex.has(key)) { rejected.push({ index: entry.index, code: 'DUPLICATE_RELATION_INDEX', detail: `relation ${key} declared twice`, locator_stats: stat(1) }); continue; }
      byIndex.set(key, { line: entry.index, row, evidence: [] });
    } else if (kind === 'ev') {
      const target = byIndex.get(key);
      if (!target) { rejected.push({ index: entry.index, code: 'ORPHAN_EVIDENCE_LINE', detail: `no relation line ${key} precedes this evidence`, locator_stats: stat(1) }); continue; }
      target.evidence.push(row);
    } else {
      rejected.push({ index: entry.index, code: 'UNKNOWN_LINE_KIND', detail: kind || '<missing>', locator_stats: stat(0) });
    }
  }
  for (const [key, held] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (!held.evidence.length) { rejected.push({ index: held.line, code: 'RELATION_WITHOUT_EVIDENCE', detail: `relation ${key} has no evidence line`, locator_stats: stat(1) }); continue; }
    const proposed = {
      subject_binding: held.row.subject_binding || 'explicit',
      subject_occurrence: held.row.subject_occurrence ? String(held.row.subject_occurrence) : null,
      subject_mention: {
        surface: held.row.subject,
        source_locator: flatLocator(held.row.subject_block, held.row.subject_quote, held.row.occurrence),
        ...(held.row.antecedent_block || held.row.antecedent_quote ? {
          antecedent_locator: flatLocator(held.row.antecedent_block, held.row.antecedent_quote, held.row.antecedent_occurrence),
        } : {}),
      },
      relation_family: held.row.family || 'other',
      predicate_family: held.row.predicate,
      object_or_value: held.row.object,
      polarity: held.row.polarity,
      modality: held.row.modality,
      quantifier: held.row.quantifier,
      scope: {}, valid_time: {},
      support_sets: [{
        mode: held.row.support_mode === 'alternative_support' ? 'alternative_support' : 'all_required',
        locators: held.evidence.map(row => ({ role: String(row.role || 'primary'), source_locator: flatLocator(row.block, row.quote, row.occurrence) })),
      }],
    };
    if (held.row.canonical_ref) proposed.canonical_ref = held.row.canonical_ref;
    if (held.row.subject_ref) proposed.subject_ref = String(held.row.subject_ref);
    proposals.push({ index: held.line, proposed });
  }
  const relLines = byIndex.size;
  const truncated = declaredCount === null || !Number.isInteger(declaredCount) || declaredCount !== relLines;
  return {
    header: stream.header,
    proposals,
    rejected,
    repairs,
    completeness: Object.freeze({
      complete: !truncated,
      declared_count: Number.isInteger(declaredCount) ? declaredCount : null,
      observed_rel_lines: relLines,
      reason: !truncated ? null
        : declaredCount === null ? 'answer has no {"k":"end"} trailer'
        : `trailer declared ${declaredCount} claims but ${relLines} rel lines arrived`,
    }),
  };
}
