#!/usr/bin/env node
// SEMANTIC LAYER — the prose-adjacent-to-code text channel and the LLM-as-parser harness
// that turns it into WITNESSED CLAIMS.
//
// WHY THIS MODULE EXISTS. Three acceptance experiments agreed on one diagnosis: the map's
// failure mode is COVERAGE, not correctness (orientation-test-report.md §2.4 — zero wrong
// claims, zero citation drift, 82% on what it attempted). acceptance-test-round2.md §5.1
// names three P0 coverage gaps and defers all three to "the LLM-parser channel":
//   K1  derived/authoritative fields   — "server computes this; consumers MUST NOT re-derive"
//   J3  state-enum / condition semantics — the legal value set and its transition conditions
//   K2  usage/accounting provenance    — which inputs feed which counter, and where it drops
// All three are stated in PROSE at real `file:line` sites and nowhere else in a machine
// -readable form. reassessment.md §D2 gives the shape: every label source is an artifact
// stream with a parser; TEXT's parser is a model, and its output is a CLAIM, never a fact.
//
// TWO CHANNELS, NOT ONE. Comments are CLAIMS. `extractors/envelopes.mjs` deliberately skips
// comments for FACTS because it once invented a phantom envelope kind out of its own header
// comment. That lesson stands and is why the text channel has its own schema, its own file
// suffix, and never enters the facts corpus. Nothing here writes canonical evidence.
//
// THE CORRECTNESS CONSTRAINT IS THE POINT. The map's one proven property is that it does not
// fabricate. This module extends coverage under FOUR machine gates a model cannot talk past:
//   G1 WITNESS RESOLUTION  — every {repo,file,line} is opened at apply time (resolveWitness,
//                            reused verbatim from l1-adjudicate.mjs).
//   G2 QUOTE CONTAINMENT   — `quoted_prose` must appear VERBATIM in the span text RE-READ FROM
//                            DISK at the cited lines. Not from the packet: a model that
//                            paraphrases the prose it was shown fails here. This is the gate
//                            L1 does not have, and it is what makes "grounded_in the prose
//                            span" mean the prose actually says it.
//   G3 SPAN CONTAINMENT    — the prose witness line must lie inside the packet's span, and the
//                            constrained code site must lie OUTSIDE it. A claim whose "code
//                            site" is the comment itself is vacuous.
//   G4 VALUE CONTAINMENT   — every enumerated legal value in a J3 claim must itself appear
//                            verbatim inside `quoted_prose`. A state enum assembled from model
//                            memory rather than from the prose fails here.
// A claim that passes all four is still only a CLAIM — it is written as `kind: llm_annotation`
// through the SHIPPED annotate.mjs#validateAnnotation, into an overlay file, and the canonical
// graph is not touched.
//
// REUSE, NOT A PARALLEL PATH. The identity, digest, witness-resolution and refusal machinery
// is imported from l1-adjudicate.mjs rather than reimplemented: `adjudicationKey`,
// `batchDigest`, `dependencyDigest`, `resolveWitness(es)`, `toolsDigest`, `toL1Refusal` and
// `validateL1Refusal`. Refusals ride the SHIPPED `estate-map/l1-refusal/v1` schema, whose
// field list is CLOSED — which is why the refusal REASON is carried as a required prefix on
// `insufficient_because` (see SEMANTIC_REFUSAL_REASONS) instead of as a new field the shipped
// validator would reject.
//
// DRIFT AND LIMITS THIS MODULE REPORTS RATHER THAN ABSORBS — see EXTRACTION_LIMITS.

import fs from './readonly-guard.mjs';
import path from 'node:path';
import { DEFAULT_EXCLUDED_DIRS, DEFAULT_EXCLUDED_EXTENSIONS, classifyProvenance, parseArgs, sha256, stableStringify, walk, writeJsonLines } from './lib.mjs';
import { validateAnnotation } from './annotate.mjs';
import {
  adjudicationKey,
  batchDigest,
  dependencyDigest,
  resolveWitnesses,
  toL1Refusal,
  toolsDigest,
} from './l1-adjudicate.mjs';

const HELP = `Usage:
  node tools/estate-map/semantic-layer.mjs spans   <estate-root> [--out <file>] [--scope <prefix>]
  node tools/estate-map/semantic-layer.mjs packets <spans.jsonl> [--out <file>] [--claim-type <t>]
  node tools/estate-map/semantic-layer.mjs apply   <packets.jsonl> <claims.jsonl> --state <dir> [--estate-root <dir>]
  node tools/estate-map/semantic-layer.mjs report  --state <dir> [--json]

spans    DETERMINISTIC. Extract the prose-adjacent-to-code text channel: leading block, line,
         JSDoc and file-header comments, each with its exact file:line span and the code entity
         it documents (Kythe \`documents\`). No model call. Writes NO facts.
packets  DETERMINISTIC. Select the spans that a K1 / J3 / K2 claim could be grounded in, by a
         named lexical trigger rule, and emit one packet per candidate. No model call.
apply    Validate model-authored claims against their packets through G1-G4, write overlays via
         the SHIPPED annotate.mjs validator, and record refusals on the SHIPPED L1 refusal
         schema. Idempotent on adjudication_key.
report   Print claim yield per gap class and refusal counts per reason.`;

export const SPEC_VERSION = '1.0';
export const TEXT_SPAN_SCHEMA = 'estate-map/text-span/v1';
export const CLAIM_PACKET_SCHEMA = 'estate-map/semantic-claim-packet/v1';
export const CLAIM_LEDGER_SCHEMA = 'estate-map/semantic-claim-ledger/v1';
export const TEXT_SPAN_FILE_SUFFIX = '.text-spans.jsonl';
export const LEDGER_FILE = 'semantic-ledger.jsonl';
export const OVERLAY_FILE = 'semantic-layer.jsonl';
export const REFUSALS_FILE = 'semantic-refusals.jsonl';

// ---------------------------------------------------------------------------
// 1. THE TEXT CHANNEL (deterministic; no model).
// ---------------------------------------------------------------------------

export const COMMENT_KINDS = Object.freeze(['file_header', 'jsdoc', 'block', 'line_run', 'docstring']);

// Per-language comment syntax. Only the families the estate actually contains; an unmapped
// extension yields NO spans rather than a guess about its comment syntax.
const COMMENT_SYNTAX = Object.freeze({
  c_family: Object.freeze({ line: ['//'], blockOpen: '/*', blockClose: '*/', docPrefix: '/**' }),
  hash: Object.freeze({ line: ['#'], blockOpen: null, blockClose: null, docPrefix: null }),
  sql: Object.freeze({ line: ['--'], blockOpen: '/*', blockClose: '*/', docPrefix: null }),
  hcl: Object.freeze({ line: ['#', '//'], blockOpen: '/*', blockClose: '*/', docPrefix: null }),
});

const SYNTAX_BY_EXTENSION = Object.freeze({
  '.js': 'c_family', '.jsx': 'c_family', '.mjs': 'c_family', '.cjs': 'c_family',
  '.ts': 'c_family', '.tsx': 'c_family', '.cs': 'c_family', '.swift': 'c_family',
  '.kt': 'c_family', '.java': 'c_family', '.go': 'c_family',
  '.py': 'hash', '.yaml': 'hash', '.yml': 'hash', '.toml': 'hash',
  '.sql': 'sql', '.tf': 'hcl',
});

export const syntaxFor = file => COMMENT_SYNTAX[SYNTAX_BY_EXTENSION[path.extname(file).toLowerCase()]] || null;

// THE KYTHE `documents` RESOLUTION TABLE. lit-review.md §1 verified: "A documents B if A
// describes (in possibly marked up natural language) the semantic object B ... Points toward
// semantic nodes." Prose therefore attaches to the ENTITY it precedes, not to the file at
// large. Each rule carries an id so an attachment can be audited back to the rule that made
// it; a span whose following line matches no rule gets `documents: null` and says so, rather
// than being silently reattached to the file.
export const DOCUMENTS_RULES = Object.freeze([
  Object.freeze({ id: 'export_function', kind: 'function', pattern: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'function', kind: 'function', pattern: /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'export_class', kind: 'class', pattern: /^export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'class', kind: 'class', pattern: /^class\s+([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'export_const', kind: 'const', pattern: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'const', kind: 'const', pattern: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ }),
  Object.freeze({ id: 'py_def', kind: 'function', pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ }),
  Object.freeze({ id: 'sql_create_table', kind: 'table', pattern: /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'\[]?([\w.]+)/i }),
  Object.freeze({ id: 'sql_alter_table', kind: 'table', pattern: /^ALTER\s+TABLE\s+[`"'\[]?([\w.]+)/i }),
  Object.freeze({ id: 'method', kind: 'method', pattern: /^(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{?\s*$/ }),
  Object.freeze({ id: 'field', kind: 'field', pattern: /^([A-Za-z_$][\w$.-]*)\s*:(?!:)/ }),
  Object.freeze({ id: 'assignment', kind: 'assignment', pattern: /^([A-Za-z_$][\w$.]*)\s*=(?!=)/ }),
]);

// How far past the end of a comment we will look for the entity it documents. A comment
// separated from code by more than a blank line and a decorator is not reliably ABOUT that
// code, and guessing further is exactly the behaviour this layer exists not to have.
export const DOCUMENTS_LOOKAHEAD = 3;

const stripCommentMarkers = (line, syntax) => {
  let value = line.trim();
  if (syntax.blockOpen && value.startsWith(syntax.docPrefix || '\0')) value = value.slice((syntax.docPrefix || '').length);
  else if (syntax.blockOpen && value.startsWith(syntax.blockOpen)) value = value.slice(syntax.blockOpen.length);
  for (const marker of syntax.line) if (value.startsWith(marker)) { value = value.slice(marker.length); break; }
  if (value.startsWith('*') && !value.startsWith('*/')) value = value.slice(1);
  if (syntax.blockClose && value.endsWith(syntax.blockClose)) value = value.slice(0, -syntax.blockClose.length);
  return value.trim();
};

const isLeadingComment = (line, syntax) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (syntax.blockOpen && trimmed.startsWith(syntax.blockOpen)) return 'block';
  for (const marker of syntax.line) if (trimmed.startsWith(marker)) return 'line';
  return null;
};

/**
 * Extract the text channel for one file.
 *
 * SPANS ARE LEADING COMMENTS ONLY — the comment marker must be the first non-whitespace
 * content on its line. This is a deliberate PRECISION-over-RECALL choice with two effects:
 * it makes the scanner line-based and therefore trivially correct (no string/regex-literal
 * state machine that could mistake `"http://x"` or `/\/\//g` for a comment), and it matches
 * the Kythe documents shape, where a documentation comment PRECEDES the entity. Trailing
 * comments (`code(); // note`) are not captured; that cost is stated in EXTRACTION_LIMITS
 * rather than papered over.
 */
export function extractTextSpans(text, { repo, file }) {
  const syntax = syntaxFor(file);
  if (!syntax) return [];
  const lines = text.split(/\r?\n/);
  const spans = [];
  let sawCode = false;
  let backtickParity = 0;   // odd => we are inside a multi-line template literal; skip.

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const unescapedBackticks = (line.match(/(?<!\\)`/g) || []).length;
    if (backtickParity % 2 === 1) { backtickParity += unescapedBackticks; index += 1; continue; }

    const leading = isLeadingComment(line, syntax);
    if (!leading) {
      if (line.trim()) sawCode = true;
      backtickParity += unescapedBackticks;
      index += 1;
      continue;
    }

    const startLine = index + 1;
    const raw = [];
    let commentKind;
    if (leading === 'block') {
      commentKind = syntax.docPrefix && line.trim().startsWith(syntax.docPrefix) ? 'jsdoc' : 'block';
      while (index < lines.length) {
        raw.push(lines[index]);
        if (lines[index].includes(syntax.blockClose)) { index += 1; break; }
        index += 1;
      }
    } else {
      commentKind = 'line_run';
      while (index < lines.length && isLeadingComment(lines[index], syntax) === 'line') { raw.push(lines[index]); index += 1; }
    }
    const endLine = startLine + raw.length - 1;
    const prose = raw.map(value => stripCommentMarkers(value, syntax)).join('\n').trim();
    if (!prose) continue;

    // FILE HEADER: a span before any code in the file documents the file itself. This is the
    // one case where attaching prose to a file rather than to a semantic node is correct.
    const isHeader = !sawCode;
    const documents = isHeader
      ? { rule: 'file_header', kind: 'file', name: file, line: startLine }
      : resolveDocuments(lines, endLine);

    spans.push({
      schema: TEXT_SPAN_SCHEMA,
      span_id: `span:${sha256([repo, file, startLine, endLine].join('\0')).slice(0, 16)}`,
      repo,
      file,
      start_line: startLine,
      end_line: endLine,
      comment_kind: isHeader ? 'file_header' : commentKind,
      raw_lines: raw.length,
      text: prose,
      documents,
      provenance_class: classifyProvenance(repo, file),
    });
  }
  return spans;
}

/** The Kythe documents edge, resolved deterministically from the first code line after a span. */
export function resolveDocuments(lines, endLine) {
  for (let offset = 0; offset < DOCUMENTS_LOOKAHEAD; offset += 1) {
    const index = endLine + offset;          // endLine is 1-based; lines[endLine] is the next line
    if (index >= lines.length) break;
    const candidate = lines[index].trim();
    if (!candidate) continue;
    for (const rule of DOCUMENTS_RULES) {
      const match = rule.pattern.exec(candidate);
      if (match) return { rule: rule.id, kind: rule.kind, name: match[1], line: index + 1 };
    }
    return null;   // real code that no rule recognises — say so, do not keep scanning past it
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. CLAIM PACKETS (deterministic; no model).
// ---------------------------------------------------------------------------

export const CLAIM_TYPES = Object.freeze(['derived_authoritative_field', 'state_enum_semantics', 'accounting_provenance']);

export const QUEUE_OF_CLAIM = Object.freeze({
  derived_authoritative_field: 'semantic_k1',
  state_enum_semantics: 'semantic_j3',
  accounting_provenance: 'semantic_k2',
});

export const GAP_OF_CLAIM = Object.freeze({
  derived_authoritative_field: 'K1',
  state_enum_semantics: 'J3',
  accounting_provenance: 'K2',
});

// SELECTION IS DETERMINISTIC AND NAMED. Each trigger is an id + a pattern; the packet records
// which trigger fired, so "why was this span shown to the model" is answerable without
// re-running. Triggers are deliberately RECALL-biased — a span that matches but states no rule
// is supposed to come back as a refusal, and refusals are cheap. The alternative (a model
// choosing its own spans) would make selection unauditable.
export const CLAIM_TRIGGERS = Object.freeze({
  derived_authoritative_field: Object.freeze([
    Object.freeze({ id: 'k1_must_not_rederive', pattern: /\b(?:must not|cannot|contractually forbidden(?: from)?|do(?:es)? not|never)\b[^.]{0,80}\bre-?(?:derive|comput|calculat)/i }),
    Object.freeze({ id: 'k1_server_authoritative', pattern: /\bserver-authoritative\b|\bauthoritative\b[^.]{0,40}\b(?:field|value|state|bucket|badge|source)\b/i }),
    Object.freeze({ id: 'k1_computed_by', pattern: /\b(?:server|backend|runtime)\s+(?:computes|derives|owns)\b/i }),
    Object.freeze({ id: 'k1_render_directly', pattern: /\brender\s+directly\s+from\b|\bconsumers?\s+(?:must|should)\b/i }),
  ]),
  state_enum_semantics: Object.freeze([
    Object.freeze({ id: 'j3_legal_values', pattern: /\b(?:legal|valid|allowed|permitted|possible)\s+(?:value|values|state|states|set)\b/i }),
    Object.freeze({ id: 'j3_state_machine', pattern: /\bstate\s+(?:machine|transition|diagram)\b|\btransitions?\s+(?:to|from|into)\b/i }),
    Object.freeze({ id: 'j3_one_of', pattern: /\bis\s+one\s+of\b|\bexactly\s+one\s+of\b|\benum(?:eration)?\b/i }),
    Object.freeze({ id: 'j3_vocabulary', pattern: /\bvocabulary\b|\bfrozen\s+(?:vocabulary|list|set)\b/i }),
  ]),
  accounting_provenance: Object.freeze([
    Object.freeze({ id: 'k2_counter_feed', pattern: /\b(?:counter|rollup|roll-up|total|totals|tally|aggregate|aggregation)\b/i }),
    Object.freeze({ id: 'k2_spend_usage', pattern: /\b(?:token\s*spend|spend|usage)\b[^.]{0,60}\b(?:record|sum|total|accrue|attribut)/i }),
    Object.freeze({ id: 'k2_drops_input', pattern: /\b(?:drops?|discards?|skips?|ignores?|filters?(?:\s+out)?|excludes?)\b[^.]{0,60}\b(?:usage|event|row|record|payload|input)\b/i }),
    Object.freeze({ id: 'k2_only_counts', pattern: /\bonly\s+(?:counts?|includes?|sums?)\b|\bnot\s+(?:counted|included|summed)\b/i }),
  ]),
});

const questionFor = Object.freeze({
  derived_authoritative_field: span => `Does this prose at ${span.file}:${span.start_line}-${span.end_line} state that a specific field is computed authoritatively by one side and MUST NOT be re-derived by consumers? If so, name the field, its owner, and the rule.`,
  state_enum_semantics: span => `Does this prose at ${span.file}:${span.start_line}-${span.end_line} state the legal value set of a state-ish field, or a condition attached to one of its transitions? If so, name the field and quote the values or condition verbatim.`,
  accounting_provenance: span => `Does this prose at ${span.file}:${span.start_line}-${span.end_line} state which inputs feed a counter/rollup, or where that counter drops or filters an input? If so, name the counter and the inputs or the dropped input.`,
});

// Digest of the estate's ontology canon, or an explicit ABSENT sentinel when the estate
// carries no canon. Returning a sentinel (rather than throwing) keeps the adjudication
// context honest — "there was no canon" is a real, reproducible provenance value — while
// letting `apply` run on estates the canon idiom does not exist in.
//
// Implementation moved to portability.mjs so `l1-adjudicate apply` — which had the same
// unguarded read and was NOT covered by the round of fixes this helper came from — shares
// one definition instead of growing a second, separately-drifting copy. Re-exported here
// because this is the name the helper shipped under.
export { CANON_ABSENT_DIGEST, canonDigest } from './portability.mjs';

export const spanDigest = span => sha256(stableStringify({
  repo: span.repo, file: span.file, start_line: span.start_line, end_line: span.end_line, text: span.text,
}));

/**
 * Build one packet per (span, claim_type) whose text fires a named trigger.
 *
 * PRODUCTION-FIRST. Only `production` provenance spans are packeted by default — the same
 * discipline instrument-repair #1 applied to witnesses, for the same reason: a rule stated in
 * a test fixture's comment is not a rule the estate obeys.
 */
export function buildClaimPackets(spans, { claimTypes = CLAIM_TYPES, provenanceClasses = ['production'] } = {}) {
  const packets = [];
  for (const span of spans) {
    if (provenanceClasses && !provenanceClasses.includes(span.provenance_class)) continue;
    for (const claimType of claimTypes) {
      const fired = CLAIM_TRIGGERS[claimType].filter(trigger => trigger.pattern.test(span.text));
      if (!fired.length) continue;
      packets.push({
        schema: CLAIM_PACKET_SCHEMA,
        spec_version: SPEC_VERSION,
        claim_type: claimType,
        gap: GAP_OF_CLAIM[claimType],
        queue: QUEUE_OF_CLAIM[claimType],
        span,
        queue_entry_digest: spanDigest(span),
        trigger_rules: fired.map(trigger => trigger.id),
        question: questionFor[claimType](span),
        options: [...VERDICTS[claimType]],
        // The Kythe documents target, restated on the packet so the model is told what the
        // prose is attached to rather than left to infer it from the text.
        documents: span.documents,
      });
    }
  }
  // Stable order: gap class, then file, then line. Deterministic across runs.
  const rank = Object.fromEntries(CLAIM_TYPES.map((claimType, index) => [claimType, index]));
  packets.sort((a, b) => rank[a.claim_type] - rank[b.claim_type]
    || a.span.file.localeCompare(b.span.file)
    || a.span.start_line - b.span.start_line);
  return packets;
}

// ---------------------------------------------------------------------------
// 3. THE CLAIM VALIDATOR — witness obligations as FIELD PRESENCE plus G2/G3/G4 containment.
// ---------------------------------------------------------------------------

// `insufficient_evidence` is spelled exactly as l1-adjudicate.mjs#REFUSAL_VERDICTS spells it,
// so a refusal here rides the SHIPPED refusal record through `toL1Refusal` unchanged.
export const VERDICTS = Object.freeze({
  derived_authoritative_field: Object.freeze(['derived_authoritative', 'not_authoritative', 'insufficient_evidence']),
  state_enum_semantics: Object.freeze(['enum_stated', 'condition_stated', 'insufficient_evidence']),
  accounting_provenance: Object.freeze(['feeds_counter', 'drops_input', 'insufficient_evidence']),
});

export const REFUSAL_VERDICT = 'insufficient_evidence';

// The refusal REASON vocabulary. `estate-map/l1-refusal/v1` has a CLOSED field list that
// validateL1Refusal enforces, so a new `refusal_reason` field would be rejected by the shipped
// validator. Rather than fork the schema, the reason is carried as a REQUIRED PREFIX on
// `insufficient_because` — machine-checkable here, GROUP-BY-able downstream, and the shipped
// record is untouched. AC-REFUSAL's "refusal counts reported by reason" reads off this prefix.
export const SEMANTIC_REFUSAL_REASONS = Object.freeze([
  'prose_absent',              // the span says nothing about this claim class; the trigger over-fired
  'prose_ambiguous',           // it gestures at the class but names no field / value / counter
  'prose_states_no_rule',      // it describes behaviour but states no obligation on consumers
  'subject_underivable',       // the rule is stated but the field/entity it binds is not named
  'code_site_underivable',     // the rule is stated but no constrained code site is derivable
  'prose_stale_vs_source',     // the prose asserts something the source at this SHA contradicts
]);

const CLAIM_FIELDS = ['adjudicator', 'adjudicator_family', 'claim_type', 'confidence', 'queue_entry_digest',
  'quoted_prose', 'reasoning', 'verdict', 'witnesses'];

const isWitness = value => value && typeof value === 'object' && typeof value.repo === 'string' && value.repo.trim()
  && typeof value.file === 'string' && value.file.trim() && Number.isInteger(value.line) && value.line > 0;

function requireFields(record, fields, label) {
  const missing = fields.filter(field => record[field] === undefined || record[field] === null || record[field] === '');
  if (missing.length) throw new Error(`${label}: missing required field(s): ${missing.join(', ')}`);
}

const nonEmptyStrings = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim());

/**
 * Whitespace-insensitive verbatim containment. Comment markers (`//`, `/*`, the ` * `
 * JSDoc continuation, `#`, and standalone `-`/`>` bullets) and line wrapping are artefacts of
 * the MEDIUM, not of the claim, so both sides are collapsed to single spaces before
 * comparison. NOTHING ELSE is normalised: word order, wording, punctuation inside words,
 * identifiers and negations must match exactly, which is the entire point of G2. Stripping a
 * standalone punctuation run that is already surrounded by whitespace cannot let a paraphrase
 * through — it only lets a quotation span a wrapped comment line.
 */
export const normalizeProse = value => String(value)
  .replace(/[*/#-]{2,}/g, ' ')
  .replace(/(?:^|\s)[*/#>-]+(?=\s|$)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
export const proseContains = (haystack, needle) => normalizeProse(haystack).includes(normalizeProse(needle));

/**
 * Validate one claim against its packet. Throws with a specific reason; the caller counts a
 * throw as REJECTED — malformed, not merely wrong. `spanText` is the prose RE-READ FROM DISK
 * by the caller; when it is supplied, G2/G4 are checked against the file rather than against
 * the packet, which is what makes a paraphrase detectable.
 */
export function validateClaim(packet, claim, { spanText = null } = {}) {
  const label = `${packet.claim_type}:${packet.queue_entry_digest.slice(0, 12)}`;
  requireFields(claim, CLAIM_FIELDS, label);
  if (claim.claim_type !== packet.claim_type) throw new Error(`${label}: claim_type ${claim.claim_type} does not match the packet`);
  if (claim.queue_entry_digest !== packet.queue_entry_digest) throw new Error(`${label}: queue_entry_digest does not match the packet`);
  if (!packet.options.includes(claim.verdict)) throw new Error(`${label}: verdict '${claim.verdict}' is outside the packet's option set (${packet.options.join(', ')})`);
  if (typeof claim.confidence !== 'number' || !(claim.confidence >= 0 && claim.confidence <= 1)) throw new Error(`${label}: confidence must be a number in [0,1]`);
  if (!Array.isArray(claim.witnesses) || !claim.witnesses.length || !claim.witnesses.every(isWitness)) throw new Error(`${label}: witnesses must be a non-empty array of {repo,file,line}`);

  // G3a — the FIRST witness is the prose span itself, and it must lie inside the packet's
  // span. A claim "grounded in the prose" that cites a line outside the comment is grounded in
  // something else.
  const [proseWitness] = claim.witnesses;
  if (proseWitness.file !== packet.span.file || proseWitness.repo !== packet.span.repo) {
    throw new Error(`${label}: witnesses[0] must be the prose span at ${packet.span.repo}/${packet.span.file}`);
  }
  if (proseWitness.line < packet.span.start_line || proseWitness.line > packet.span.end_line) {
    throw new Error(`${label}: witnesses[0].line=${proseWitness.line} is outside the prose span ${packet.span.start_line}-${packet.span.end_line}`);
  }

  // G2 — quote containment against the prose as read from disk when available.
  const source = spanText === null ? packet.span.text : spanText;
  if (typeof claim.quoted_prose !== 'string' || claim.quoted_prose.trim().length < 12) {
    throw new Error(`${label}: quoted_prose must be a verbatim quotation of at least 12 characters`);
  }
  if (!proseContains(source, claim.quoted_prose)) {
    throw new Error(`${label}: quoted_prose does not appear verbatim in the prose span at ${packet.span.file}:${packet.span.start_line}-${packet.span.end_line} — a paraphrase is not a quotation`);
  }

  if (claim.verdict === REFUSAL_VERDICT) {
    requireFields(claim, ['insufficient_because', 'requested_artifact'], label);
    const reason = String(claim.insufficient_because).split(':')[0];
    if (!SEMANTIC_REFUSAL_REASONS.includes(reason)) {
      throw new Error(`${label}: insufficient_because must be prefixed with a reason from ${SEMANTIC_REFUSAL_REASONS.join(', ')} (got '${reason}')`);
    }
    if (claim.insufficient_because.length < 24) throw new Error(`${label}: insufficient_because must name a concrete obtainable artefact, not a mood`);
    return claim;
  }

  // G3b — every non-prose witness (the CONSTRAINED CODE SITE) must lie outside the span. A
  // claim whose code site is the comment that states it proves nothing about the code.
  const constrains = claim.constrains || null;
  if (constrains) {
    if (!isWitness(constrains)) throw new Error(`${label}: constrains must be a {repo,file,line}`);
    const insideSpan = constrains.file === packet.span.file && constrains.repo === packet.span.repo
      && constrains.line >= packet.span.start_line && constrains.line <= packet.span.end_line;
    if (insideSpan) throw new Error(`${label}: constrains points inside the prose span — the code site must be code, not the comment asserting it`);
    if (!claim.witnesses.some(witness => witness.repo === constrains.repo && witness.file === constrains.file && witness.line === constrains.line)) {
      throw new Error(`${label}: constrains must also appear in witnesses[] so it is resolved on disk`);
    }
  }

  switch (claim.verdict) {
    case 'derived_authoritative':
      // K1's whole content: WHICH field, owned by WHOM, and WHAT consumers may not do. A claim
      // missing any of the three is not the fact round-2 §5.1 says the map cannot express.
      requireFields(claim, ['field', 'owner', 'consumer_rule'], label);
      if (!constrains) throw new Error(`${label}: derived_authoritative must name the code site it constrains`);
      if (!proseContains(source, claim.field)) throw new Error(`${label}: field '${claim.field}' does not appear in the prose that supposedly names it`);
      break;
    case 'not_authoritative':
      requireFields(claim, ['field', 'why_not'], label);
      break;
    case 'enum_stated': {
      // G4 — VALUE CONTAINMENT. Every legal value must appear verbatim inside the QUOTATION,
      // not merely inside the span: this is the gate that stops a model completing a partial
      // enum from memory of the codebase.
      requireFields(claim, ['field', 'legal_values'], label);
      if (!nonEmptyStrings(claim.legal_values)) throw new Error(`${label}: legal_values must be a non-empty string array`);
      const invented = claim.legal_values.filter(value => !proseContains(claim.quoted_prose, value));
      if (invented.length) throw new Error(`${label}: legal_value(s) ${invented.join(', ')} do not appear in quoted_prose — the enum was completed, not read`);
      break;
    }
    case 'condition_stated':
      requireFields(claim, ['field', 'condition'], label);
      break;
    case 'feeds_counter':
      requireFields(claim, ['counter', 'inputs'], label);
      if (!nonEmptyStrings(claim.inputs)) throw new Error(`${label}: inputs must be a non-empty string array`);
      break;
    case 'drops_input':
      // The one verdict whose value is entirely in the code site: "where a counter drops
      // input" is a producer fact (round-2 D7), so the site is mandatory.
      requireFields(claim, ['counter', 'dropped_input'], label);
      if (!constrains) throw new Error(`${label}: drops_input must name the code site where the input is dropped`);
      break;
    default:
      throw new Error(`${label}: unhandled verdict ${claim.verdict}`);
  }
  return claim;
}

// ---------------------------------------------------------------------------
// 4. OVERLAY — written through the SHIPPED annotate.mjs#validateAnnotation, unchanged.
// ---------------------------------------------------------------------------

export const OVERLAY_BEARING_VERDICTS = Object.freeze(['derived_authoritative', 'not_authoritative', 'enum_stated', 'condition_stated', 'feeds_counter', 'drops_input']);

const SEVERITY_OF_VERDICT = Object.freeze({
  derived_authoritative: 'high',   // round-2 D6 was CRITICAL and is exactly this shape
  drops_input: 'high',             // round-2 D7 was HIGH and is exactly this shape
  enum_stated: 'medium',
  condition_stated: 'medium',
  feeds_counter: 'medium',
  not_authoritative: 'low',
});

const titleFor = (packet, claim) => {
  if (claim.verdict === 'derived_authoritative') return `authoritative field: ${claim.owner}.${claim.field} — consumers MUST NOT re-derive`;
  if (claim.verdict === 'not_authoritative') return `not authoritative: ${claim.field}`;
  if (claim.verdict === 'enum_stated') return `state enum: ${claim.field} ∈ {${claim.legal_values.join(', ')}}`;
  if (claim.verdict === 'condition_stated') return `transition condition: ${claim.field}`;
  if (claim.verdict === 'feeds_counter') return `accounting: ${claim.counter} ← ${claim.inputs.join(', ')}`;
  return `accounting drop: ${claim.counter} discards ${claim.dropped_input}`;
};

export function toOverlay(packet, claim, { generatedAt, adjudicationKey: key }) {
  if (!OVERLAY_BEARING_VERDICTS.includes(claim.verdict)) return null;
  // `grounded_in` carries BOTH ends of the Kythe documents edge: the prose anchor and the
  // semantic node it documents. validateAnnotation rejects an empty grounded_in, which is the
  // structural difference between an annotation and a hallucination.
  const grounded = claim.witnesses.map(witness => ({ repo: witness.repo, file: witness.file, line: witness.line }));
  const documents = packet.documents ? `${packet.documents.kind} ${packet.documents.name} (${packet.span.file}:${packet.documents.line}, rule ${packet.documents.rule})` : 'file (no documents target resolved)';
  return validateAnnotation({
    kind: 'llm_annotation',            // PROVENANCE. A model reading prose is never doc_derived_annotation.
    annotation_kind: 'finding',
    subject: `semantic:${packet.queue}:${packet.span.span_id}`,
    model: claim.adjudicator,
    generated_at: generatedAt,
    confidence: claim.confidence,
    grounded_in: grounded,
    body: {
      title: titleFor(packet, claim),
      severity: SEVERITY_OF_VERDICT[claim.verdict],
      detail: [
        `gap=${packet.gap}`,
        `semantic_key=${key}`,
        `documents=${documents}`,
        `quoted_prose="${claim.quoted_prose}"`,
        claim.constrains ? `constrains=${claim.constrains.repo}/${claim.constrains.file}:${claim.constrains.line}` : 'constrains=none',
        claim.reasoning,
      ].join(' | '),
    },
  }, `semantic_overlay:${packet.span.span_id}`);
}

// ---------------------------------------------------------------------------
// 5. APPLY — validate, resolve, key, dedupe, append. Mirrors l1-adjudicate.mjs#applyVerdicts.
// ---------------------------------------------------------------------------

const readJsonl = async file => {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const appendJsonl = async (file, rows) => {
  if (!rows.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
};

export const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

/**
 * Enumerate YAML files under the estate, honouring the SAME directory exclusions the shared
 * walk uses so a vendored or build-output manifest cannot enter the text channel.
 */
export async function collectYamlFiles(root, { excludedDirs = DEFAULT_EXCLUDED_DIRS } = {}) {
  const skip = new Set(excludedDirs);
  const out = [];
  const visit = async dir => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!skip.has(entry.name)) await visit(absolute); }
      else if (entry.isFile() && YAML_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(absolute);
    }
  };
  await visit(root);
  return out;
}

/** Re-read a packet's prose span FROM DISK. G2 is only worth anything if the text is fresh. */
export async function readSpanText(estateRoot, span) {
  for (const candidate of [path.join(estateRoot, span.repo, span.file), path.join(estateRoot, span.file)]) {
    let text;
    try { text = await fs.readFile(candidate, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    if (span.end_line > lines.length) return null;
    return lines.slice(span.start_line - 1, span.end_line).join('\n');
  }
  return null;
}

/**
 * Packet identity is (span, claim_type), NOT the span digest alone. One span routinely fires
 * triggers for two or three gap classes — `deriveAttentionState`'s header is simultaneously a
 * K1 obligation and a J3 enum — and keying the lookup on `queue_entry_digest` alone silently
 * dropped every packet but the last for such a span. Found by the first real run (6 rejected
 * rows reading "claim_type X does not match the packet"), not by a unit test.
 */
export const packetKey = packet => `${packet.claim_type}|${packet.queue_entry_digest}`;

export async function applyClaims({ packets, claims, stateDir, estateRoot, context, now }) {
  const byDigest = new Map(packets.map(packet => [packetKey(packet), packet]));
  const priorLedger = stateDir ? await readJsonl(path.join(stateDir, LEDGER_FILE)) : [];
  const priorKeys = new Set(priorLedger.map(row => row.adjudication_key));
  const attemptsByEntry = new Map();
  for (const row of priorLedger) attemptsByEntry.set(row.queue_entry_digest, Math.max(attemptsByEntry.get(row.queue_entry_digest) || 0, row.attempt || 0));

  const accepted = [], overlays = [], refusals = [], rejected = [], skipped = [];
  const digests = claims.map(claim => claim.queue_entry_digest).filter(Boolean);
  const batch = batchDigest(digests.length > 1 ? digests : []);
  const generatedAt = now || new Date().toISOString();

  for (const claim of claims) {
    const packet = byDigest.get(packetKey(claim));
    if (!packet) { rejected.push({ claim, why: `no packet for claim_type=${claim.claim_type} at that queue_entry_digest — the span is not on that semantic queue` }); continue; }
    try {
      // G2 input: the prose as it really is on disk right now, not as the packet remembers it.
      const spanText = await readSpanText(estateRoot, packet.span);
      if (spanText === null) throw new Error(`prose span does not resolve at ${packet.span.file}:${packet.span.start_line}-${packet.span.end_line}`);
      validateClaim(packet, claim, { spanText });

      // G1 — every witness opened on disk.
      const resolutions = await resolveWitnesses(estateRoot, claim.witnesses);
      const unresolved = resolutions.filter(row => !row.resolved);
      if (unresolved.length) throw new Error(`witness does not resolve at ${context.adjudicated_at_sha}: ${unresolved.map(row => row.why).join('; ')}`);

      const dependency = await dependencyDigest(estateRoot, claim.witnesses);
      const key = adjudicationKey({
        spec_version: SPEC_VERSION,
        claim_type: packet.claim_type,
        queue_entry_digest: packet.queue_entry_digest,
        adjudicated_at_sha: context.adjudicated_at_sha,
        tools_digest: context.tools_digest,
        canon_digest: context.canon_digest,
        dependency_digest: dependency,
        adjudicator_identity: claim.adjudicator,
        batch_digest: batch,
      });
      if (priorKeys.has(key)) { skipped.push({ queue_entry_digest: packet.queue_entry_digest, adjudication_key: key, why: 'already claimed at this key — unchanged corpus, no re-parse' }); continue; }
      const attempt = (attemptsByEntry.get(packet.queue_entry_digest) || 0) + 1;
      attemptsByEntry.set(packet.queue_entry_digest, attempt);

      const overlay = toOverlay(packet, claim, { generatedAt, adjudicationKey: key });
      const row = {
        schema: CLAIM_LEDGER_SCHEMA,
        spec_version: SPEC_VERSION,
        gap: packet.gap,
        claim_type: packet.claim_type,
        queue: packet.queue,
        span: packet.span,
        queue_entry_digest: packet.queue_entry_digest,
        trigger_rules: packet.trigger_rules,
        adjudicated_at_sha: context.adjudicated_at_sha,
        adjudicator: claim.adjudicator,
        adjudicator_family: claim.adjudicator_family,
        adjudication_key: key,
        dependency_digest: dependency,
        corpus_digest: context.corpus_digest,
        verdict: claim.verdict,
        confidence: claim.confidence,
        reasoning: claim.reasoning,
        quoted_prose: claim.quoted_prose,
        witnesses: claim.witnesses,
        witness_lines: resolutions.map(item => item.text),
        overlay_ref: overlay ? sha256(stableStringify(overlay)) : null,
        attempt,
        adjudicated_at: generatedAt,
      };
      for (const field of ['field', 'owner', 'consumer_rule', 'why_not', 'legal_values', 'condition',
        'counter', 'inputs', 'dropped_input', 'constrains', 'insufficient_because', 'requested_artifact']) {
        if (claim[field] !== undefined) row[field] = claim[field];
      }
      priorKeys.add(key);
      accepted.push(row);
      if (overlay) overlays.push(overlay);
      // Refusals ride the SHIPPED estate-map/l1-refusal/v1 record, unmodified.
      const refusal = toL1Refusal(packet, claim, { key, corpusDigest: context.corpus_digest, dependencyDigest: dependency, attempt, observedAt: generatedAt });
      if (refusal) refusals.push(refusal);
    } catch (error) {
      rejected.push({ queue_entry_digest: claim.queue_entry_digest, verdict: claim.verdict, why: error.message });
    }
  }
  if (stateDir) {
    await appendJsonl(path.join(stateDir, LEDGER_FILE), accepted);
    await appendJsonl(path.join(stateDir, OVERLAY_FILE), overlays);
    await appendJsonl(path.join(stateDir, REFUSALS_FILE), refusals);
  }
  return { accepted, overlays, refusals, rejected, skipped, batch_digest: batch };
}

/** Yield per gap class and refusal counts per reason — the two numbers AC-REFUSAL asks for. */
export function summarize(ledgerRows) {
  const byGap = {};
  const refusalsByReason = Object.fromEntries(SEMANTIC_REFUSAL_REASONS.map(reason => [reason, 0]));
  const seen = new Set();
  for (const row of ledgerRows) {
    if (seen.has(row.adjudication_key)) continue;
    seen.add(row.adjudication_key);
    const gap = byGap[row.gap] || (byGap[row.gap] = { claims: 0, refusals: 0, by_verdict: {} });
    gap.by_verdict[row.verdict] = (gap.by_verdict[row.verdict] || 0) + 1;
    if (row.verdict === REFUSAL_VERDICT) {
      gap.refusals += 1;
      const reason = String(row.insufficient_because || '').split(':')[0];
      if (reason in refusalsByReason) refusalsByReason[reason] += 1;
    } else gap.claims += 1;
  }
  const claims = Object.values(byGap).reduce((total, gap) => total + gap.claims, 0);
  const refusals = Object.values(byGap).reduce((total, gap) => total + gap.refusals, 0);
  return { rows: seen.size, claims, refusals, by_gap: byGap, refusals_by_reason: refusalsByReason };
}

// ---------------------------------------------------------------------------
// EXTRACTION LIMITS — stated, not buried. Every one of these is a RECALL cost taken
// deliberately to protect precision, which is the property the experiments proved the map has.
// ---------------------------------------------------------------------------
export const EXTRACTION_LIMITS = Object.freeze([
  Object.freeze({
    id: 'LIMIT-1',
    limit: 'Leading comments only — the marker must be the first non-whitespace content on its line.',
    cost: 'Trailing comments (`emit(x); // only when batch_id is set`) are not captured.',
    why: 'It removes the entire class of false spans a mid-line scanner produces from string and regex literals ("http://", /\\/\\//g). A false span is a fabrication vector; a missed span is a refusal.',
  }),
  Object.freeze({
    id: 'LIMIT-2',
    limit: 'Multi-line template literals are skipped by unescaped-backtick parity, not by parsing.',
    cost: 'A file with an odd number of unescaped backticks inside a regex or char literal can skip the remainder of the file.',
    why: 'Parity is deterministic and cheap; the failure mode is under-extraction (missing spans), never a span pointing at non-comment text.',
  }),
  Object.freeze({
    id: 'LIMIT-3',
    limit: 'The documents edge looks ahead at most DOCUMENTS_LOOKAHEAD lines and stops at the first non-blank line.',
    cost: 'A comment separated from its entity by a decorator block or a long blank gap resolves to `documents: null`.',
    why: 'Kythe documents points at the node the prose describes. Scanning further would attach prose to whatever came next, which is a guess wearing an edge label.',
  }),
  Object.freeze({
    id: 'LIMIT-4',
    limit: 'No comment syntax is assumed for unmapped extensions (SYNTAX_BY_EXTENSION).',
    cost: 'Languages outside the mapped set contribute zero spans.',
    why: 'Guessing a comment marker produces spans whose text is code.',
  }),
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    if (positional[0] === 'spans') {
      const estateRoot = path.resolve(positional[1] || '.');
      const repo = options.repo || path.basename(estateRoot);
      const { files } = await walk(estateRoot, { excludedExtensions: DEFAULT_EXCLUDED_EXTENSIONS.filter(ext => !YAML_EXTENSIONS.has(ext)) });
      const yamlFiles = await collectYamlFiles(estateRoot);
      const scope = options.scope ? options.scope.split(',') : null;
      const spans = [];
      const seen = new Set();
      for (const absolute of [...files, ...yamlFiles].sort()) {
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        const file = path.relative(estateRoot, absolute).split(path.sep).join('/');
        if (scope && !scope.some(prefix => file.startsWith(prefix))) continue;
        if (!syntaxFor(file)) continue;
        spans.push(...extractTextSpans(await fs.readFile(absolute, 'utf8'), { repo, file }));
      }
      if (options.out) { await writeJsonLines(path.resolve(options.out), spans); console.log(`Wrote ${spans.length} text span(s) to ${options.out}`); }
      else process.stdout.write(spans.map(span => JSON.stringify(span)).join('\n') + '\n');
    } else if (positional[0] === 'packets') {
      const spans = await readJsonl(path.resolve(positional[1]));
      const packets = buildClaimPackets(spans, options['claim-type'] ? { claimTypes: [options['claim-type']] } : {});
      if (options.out) { await writeJsonLines(path.resolve(options.out), packets); console.log(`Wrote ${packets.length} packet(s) to ${options.out}`); }
      else process.stdout.write(packets.map(packet => JSON.stringify(packet)).join('\n') + '\n');
    } else if (positional[0] === 'apply') {
      if (!positional[2] || !options.state) throw new Error('apply requires <packets.jsonl> <claims.jsonl> and --state <dir>');
      const estateRoot = path.resolve(options['estate-root'] || process.cwd());
      const packets = await readJsonl(path.resolve(positional[1]));
      const claims = await readJsonl(path.resolve(positional[2]));
      const context = {
        adjudicated_at_sha: options.sha || 'working-tree',
        tools_digest: await toolsDigest(path.resolve(new URL('.', import.meta.url).pathname)),
        // An estate without an ontology canon still has a legitimate digest: the
        // ABSENCE of one. Reading this unguarded made `apply` fatal on every estate
        // that is not this repo, even though the deterministic halves (`spans`,
        // `packets`) had already succeeded.
        canon_digest: await canonDigest(path.join(estateRoot, 'design/canon/ontology.md')),
        corpus_digest: options['corpus-digest'] || 'unknown',
      };
      const result = await applyClaims({ packets, claims, stateDir: path.resolve(options.state), estateRoot, context, now: options.now });
      console.log(`accepted=${result.accepted.length} overlays=${result.overlays.length} refusals=${result.refusals.length} rejected=${result.rejected.length} skipped=${result.skipped.length}`);
      for (const row of result.rejected) console.error(`REJECTED ${row.queue_entry_digest?.slice(0, 12)} ${row.verdict}: ${row.why}`);
    } else if (positional[0] === 'report') {
      if (!options.state) throw new Error('report requires --state <dir>');
      const summary = summarize(await readJsonl(path.join(path.resolve(options.state), LEDGER_FILE)));
      console.log(options.json ? stableStringify(summary).trim() : [
        `rows ${summary.rows}; claims ${summary.claims}; refusals ${summary.refusals}`,
        ...Object.entries(summary.by_gap).map(([gap, value]) => `  ${gap}: claims=${value.claims} refusals=${value.refusals} ${JSON.stringify(value.by_verdict)}`),
        `refusals by reason: ${JSON.stringify(summary.refusals_by_reason)}`,
      ].join('\n'));
    } else throw new Error(`Unknown command: ${positional[0]}`);
    process.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
