#!/usr/bin/env node
// ENTITY DISCOVERY for the Ascrybe: mine the codebase's own signals for the
// entity types that ACTUALLY exist, reconcile them against the documented
// ontology (design/canon/ontology.md), and report the difference.
//
// WHY: the canon formally catalogues ~26 entity types while the estate graph
// models only file/deployment artifacts -- the intersection is EMPTY. And the
// canon is provably stale: typed-ID prefixes minted in real code name entity
// types that appear nowhere in it. The map must be a SUPERSET of the canon:
// anything real is captured from reality regardless of whether anyone
// remembered to document it, so canon staleness becomes a computable diff
// instead of a vibe.
//
// THIS IS A DISCOVERY TOOL, NOT A GRAPH MUTATION. v1 output is a report
// (JSON + markdown). It writes no graph nodes, does not touch merge.mjs, the
// extractors, or the renderer, and NEVER edits the canon it measures against
// (the +N queue drives HUMAN canon updates).
//
// CONTRACT (same as every estate-map tool): read-only, offline, deterministic,
// never executes or imports scanned code (files are read as TEXT and matched
// with regexes), respects the shared scan-scope exclusions from lib.mjs.
//
// EVIDENCE DISCIPLINE -- the two failure modes this tool exists to avoid, both
// encountered live on a hand-rolled grep census:
//   (a) a NARROW regex silently missed real envelope kinds (`.v1` suffixes,
//       backtick quoting);
//   (b) a BROAD regex admitted hundreds of hits of property-path junk
//       (params.x, payload.y, ctx.z).
// Neither string-shape approach is sound. So a dotted literal counts as an
// envelope kind ONLY when it is (i) a COMPLETE quoted string literal -- which
// structurally excludes unquoted property paths -- AND (ii) demonstrably
// anchored to bus machinery: an emit-like call argument, a `kind:` field inside
// an envelope literal, or a subscription/filter registration. Every candidate
// carries file:line witnesses pointing at its real anchor site, and the anchor
// reason is recorded so a human can audit why the hit was admitted.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, walk, normalizePath, stableStringify } from './lib.mjs';
import { defaultOutputRoot, registerScanRoot } from './readonly-guard.mjs';
import { readOptionalEstateInput } from './portability.mjs';

export const TOOL_ID = 'discover-entities';

export const SCHEMA = 'estate-map/entity-discovery/v1';
export const PRODUCER_ID = 'deterministic/entity-discovery-scan';
// Fixed, not `new Date()`: repeated runs must be byte-identical.
export const DEFAULT_GENERATED_AT = '2026-07-25T00:00:00Z';
export const DEFAULT_CANON_RELATIVE = 'design/canon/ontology.md';
export const SIGNATURE_CLASSES = Object.freeze(['typed_id', 'envelope_namespace', 'storage_shape', 'api_resource']);
export const SIGNATURE_CLASS_DESCRIPTIONS = Object.freeze({
  typed_id: 'prefixed identifier MINT sites (template literals / concatenations that construct `<prefix>-<random>` ids)',
  envelope_namespace: 'dotted kind literals anchored to bus emission / consumption machinery (emit calls, `kind:` fields in envelope literals, subscription+filter registrations)',
  storage_shape: 'persistent record families (sqlite CREATE TABLE, store/repository modules, per-record run-directory families)',
  api_resource: 'HTTP route registrations whose path segments name a collection resource',
});
// Only code is scanned: markdown/JSON would inflate string-shape noise, and the
// generated reports themselves must never feed back into the next run.
export const SCANNED_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.cs', '.sql']);
export const TEST_PATH_PATTERNS = Object.freeze([
  /(^|\/)tests?\//, /(^|\/)__tests__\//, /(^|\/)e2e\//, /(^|\/)fixtures?\//,
  /\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/,
]);
// Belt-and-suspenders only: the anchors above already exclude property paths.
// Kept so a future anchor relaxation cannot silently readmit the junk class.
export const NOISE_ROOTS = Object.freeze(new Set([
  'param', 'params', 'payload', 'ctx', 'context', 'opt', 'opts', 'option', 'options', 'arg', 'args',
  'req', 'res', 'request', 'response', 'this', 'self', 'window', 'document', 'process', 'console',
  'body', 'data', 'result', 'value', 'obj', 'object', 'config', 'env', 'error', 'err', 'e', 'it',
  'row', 'item', 'entry', 'node', 'json', 'string', 'number', 'boolean', 'array', 'promise', 'math',
]));
// DELIBERATELY TINY. Every entry is an abbreviation observed minting ids in THIS
// codebase, and an entry alone never merges anything: the abbreviation cluster
// and the expansion cluster must additionally share a witness context (§merge).
export const ABBREVIATIONS = Object.freeze({ wo: 'work_order', bsub: 'brew_subscription' });
export const IRREGULAR_SINGULARS = Object.freeze({
  criteria: 'criterion', indices: 'index', matrices: 'matrix', vertices: 'vertex', people: 'person',
  children: 'child', data: 'data', metadata: 'metadata', schema: 'schema', media: 'media', status: 'status',
});
export const MAX_WITNESSES_PER_CLASS = 8;
export const MIN_CANON_ENTITIES = 20;
export const CONFIDENCE_LABELS = Object.freeze({ 1: 'weak', 2: 'moderate', 3: 'high', 4: 'maximal' });
// Sanity list from the operator's in-session census. These are VERIFIED, never
// assumed: a miss is reported as a probable extractor bug, and a documented
// entity the census called undocumented is reported as a census error. The tool
// states what the source says; the source always wins.
export const EXPECTED_FINDINGS = Object.freeze([
  { entity: 'artifact', expected: 'discovered_undocumented' },
  { entity: 'environment', expected: 'discovered_undocumented' },
  { entity: 'criterion', expected: 'discovered_undocumented' },
  { entity: 'ward', expected: 'discovered_undocumented' },
  { entity: 'lease', expected: 'discovered_undocumented' },
  { entity: 'initiative', expected: 'discovered_undocumented' },
  { entity: 'brew_subscription', expected: 'discovered_undocumented', aliases: ['bsub'] },
  { entity: 'work_order', expected: 'matched', min_signature_classes: 4, aliases: ['wo'] },
]);

const HELP = `Usage:
  node tools/estate-map/discover-entities.mjs [estate-root] [options]

Options:
  --out <dir>            output directory (default: a per-estate directory OUTSIDE the
                         scanned tree, under $ASCRYBE_OUT_ROOT / $XDG_STATE_HOME /
                         ~/.local/state/estate-map -- never inside <estate-root>)
  --canon <path>         ontology document (default: <estate-root>/${DEFAULT_CANON_RELATIVE})
  --include-tests        also mine test/fixture/e2e paths (default: production code only)
  --dead <path>          JSON array of adjudicated-dead documented entities (signed +N negatives)
  --generated-at <iso>   report timestamp (default: fixed constant, keeps output byte-stable)
  --json                 print the report JSON to stdout instead of the summary
  --help

Read-only, offline, deterministic. Writes discovery-report.json + discovery-report.md.
Writes NO graph nodes and never modifies the canon.

READ-ONLY: the scanned estate is never written to. --out defaults OUTSIDE it, and any
write resolving under the scan root fails with ASCRYBE_READONLY_VIOLATION.`;

/* ---------------------------------------------------------------- naming --- */

const singularizeToken = token => {
  if (!token) return token;
  if (IRREGULAR_SINGULARS[token]) return IRREGULAR_SINGULARS[token];
  if (/[^aeiou]ies$/.test(token) && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (/ss$/.test(token) || /us$/.test(token) || /is$/.test(token)) return token;
  if (/s$/.test(token) && token.length > 3) return token.slice(0, -1);
  return token;
};

/**
 * Deterministic entity-name normalization: case folding, separator folding,
 * camelCase splitting, `.v<N>` version-suffix stripping, per-token
 * singularization. Pure -- same input always yields the same key.
 */
export function normalizeEntityName(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  value = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  value = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  value = value.replace(/_v\d+$/, '');
  const tokens = value.split('_').filter(Boolean).map(singularizeToken);
  return tokens.join('_');
}

export const expandAbbreviation = normalized => ABBREVIATIONS[normalized] || null;
const contextOf = file => normalizePath(file).split('/').slice(0, 2).join('/');
const trimEvidence = line => String(line).trim().replace(/\s+/g, ' ').slice(0, 160);
export const isTestPath = relativePath => TEST_PATH_PATTERNS.some(pattern => pattern.test(normalizePath(relativePath)));

/* ----------------------------------------------------------- signal mining --- */

const ID_MINT_RE = /(["'`])([a-z][a-z0-9_]{1,30})-(?:\$\{|\1\s*\+)/g;
const RANDOM_RE = /randomUUID|randomBytes|randomInt|nanoid|uuidv4|crypto\.random|Math\.random|createHash|\.digest\(|toString\(["']hex["']\)/;
const ID_MINT_HELPER_RE = /^(?:new|next|mint|generate|make|create)[A-Za-z0-9]*(?:Id|ID)$/;
const ASSIGN_TARGET_RE = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/;

const DOTTED_LITERAL_RE = /(["'`])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\1/g;
const EMIT_RE = /\b(?:emit|emitEnvelope|emitScoped|publish|publishEnvelope|dispatchEnvelope|appendEnvelope|emitAndAwait)\s*\(/;
const ENVELOPE_FIELD_RE = /\b(?:topic|source_kind|source_id|payload|scope|trace_id|envelope_id|consumer|version)\s*:/;
const SUBSCRIBE_RE = /\b(?:subscribe|subscribeToKinds|onEnvelope|consumeEnvelopes|envelopeFilter|matchesKind|kind_prefix|kindPrefix)\b|\bkinds?\s*:\s*\[/;
const KIND_FIELD_RE = /\b(kind|type|frame_type|envelope_kind)\s*[:=]\s*$/;
// The estate runs TWO bus dialects: substrate envelopes (`kind:` + topic/payload,
// emitted via context.envelopes.emit) and plugin-runtime frames (`type:` on a
// RuntimeFrame, dispatched by `frame.type === "..."`). Anchoring only on the
// first dialect silently loses whole namespaces (capability.*, plugin.*,
// route.*) -- the same narrow-regex miss that dropped `.v1` kinds from the
// hand-rolled census. `type:` is too common to admit alone, so it additionally
// requires frame machinery in the surrounding window.
const FRAME_RE = /\b(?:createRuntimeFrame|validateRuntimeFrame|RuntimeFrame|resultFrame|requestFrame|forwardFrame|\w*Frame)\s*[({.]|\bframe\.[a-z]/;
const FRAME_FIELD_RE = /\b(?:id|payload|plugin|channel_id|channelId|version|seq)\s*:/;
const KIND_COMPARISON_RE = /\b(?:kind|type|frame_type|envelope_kind)\s*(?:===|!==|==|!=)\s*$/;
const SWITCH_DISCRIMINANT_RE = /switch\s*\([^)]*\b(?:kind|type)\b/;
const CASE_RE = /\bcase\s+$/;

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i;
// A prose sentence about `CREATE TABLE IF NOT EXISTS ...` is not a table. These
// are the SQL/English tokens that follow the phrase in real comments; comment
// stripping catches most of it, this catches the rest.
export const NON_TABLE_NAMES = Object.freeze(new Set(['if', 'not', 'exists', 'only', 'statement', 'statements', 'and', 'or', 'the', 'this', 'these', 'with', 'when', 'as', 'to', 'in', 'for', 'is', 'table', 'schema']));
const STORE_CLASS_RE = /\bclass\s+([A-Z][A-Za-z0-9]*?)(Store|Repository|Repo)\b/;
const STORE_FACTORY_RE = /\b(?:create|open|make)([A-Z][A-Za-z0-9]*?)(Store|Repository|Repo)\s*\(/;
const RECORD_DIR_RE = /join\(\s*[^()]*?["']([a-z][a-z0-9-]{2,30})["']\s*,\s*([A-Za-z_$][\w$.]*(?:[Ii]d|_id))\s*[),]/g;
const COLUMN_RE = /^\s*["'`]?([a-z_][a-z0-9_]*)["'`]?\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN|JSON)/i;

const ROUTE_CALL_RE = /\.route\(\s*(["'`])([A-Z]+)\1\s*,\s*(["'`])(\/[^"'`]*)\3/g;
const EXPRESS_ROUTE_RE = /\b(?:app|router|server|api)\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`]*)\2/g;
const ROUTE_SKIP_SEGMENTS = new Set(['api', 'v1', 'v2', 'v3', 'health', 'index']);

const windowText = (lines, index, back, forward = 0) =>
  lines.slice(Math.max(0, index - back), Math.min(lines.length, index + forward + 1)).join('\n');

/**
 * Drop comment text before matching. A comment that MENTIONS `CREATE TABLE` or a
 * dotted kind is not a mint site, a table, or an emission -- a witness pointing
 * at prose looks verified while proving nothing, which is worse than no witness.
 * Quote-state aware so `https://` and `"a // b"` survive.
 */
export function stripComments(line) {
  const text = String(line);
  const trimmed = text.trimStart();
  if (/^(\/\/|\*|\/\*|#|--)/.test(trimmed)) return '';
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) return text.slice(0, index);
  }
  return text;
}

function typedIdAnchor(lines, index, line, matchIndex) {
  if (RANDOM_RE.test(line)) return 'randomness-source-on-mint-line';
  const target = ASSIGN_TARGET_RE.exec(line.slice(0, matchIndex));
  if (target && /(?:_id|id)$/i.test(target[1])) return `assigned-to-id-target:${target[1]}`;
  for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor--) {
    const declaration = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(lines[cursor]);
    if (declaration && ID_MINT_HELPER_RE.test(declaration[1])) return `inside-id-mint-helper:${declaration[1]}`;
  }
  return null;
}

function envelopeAnchor(lines, index, line, matchIndex) {
  const prefix = line.slice(0, matchIndex);
  if (EMIT_RE.test(prefix)) return 'emit-call-argument';
  const kindField = KIND_FIELD_RE.exec(prefix);
  if (kindField) {
    const surrounding = windowText(lines, index, 8, 8);
    if (kindField[1] === 'kind' || kindField[1] === 'envelope_kind') {
      if (EMIT_RE.test(surrounding)) return 'kind-field-inside-emit-call';
      if (ENVELOPE_FIELD_RE.test(surrounding)) return 'kind-field-inside-envelope-literal';
    } else if (FRAME_RE.test(surrounding) && FRAME_FIELD_RE.test(surrounding)) {
      return 'type-field-inside-runtime-frame-construction';
    }
  }
  if (KIND_COMPARISON_RE.test(prefix)) return 'kind-comparison-dispatch-site';
  if (CASE_RE.test(prefix) && SWITCH_DISCRIMINANT_RE.test(windowText(lines, index, 12))) return 'switch-case-dispatch-site';
  if (SUBSCRIBE_RE.test(windowText(lines, index, 3))) return 'subscription-or-filter-registration';
  if (EMIT_RE.test(windowText(lines, index, 4))) return 'emit-call-argument-continuation';
  return null;
}

/**
 * A route path segment names a resource only if it is a COLLECTION noun: either
 * plural (singularization changes it) or attested by a sibling member route
 * (`/<segment>/:<param>`) elsewhere in the scan. This is what keeps RPC-ish
 * paths (/who, /compact, /remember) out of the entity list.
 */
const isCollectionSegment = (segment, memberSegments) =>
  normalizeEntityName(segment) !== normalizeEntityName(singularizeToken(segment)) ||
  singularizeToken(segment) !== segment ||
  memberSegments.has(segment);

function pushSignal(signals, signal) {
  const normalized = normalizeEntityName(signal.raw_name);
  if (!normalized || normalized.length < 2) return;
  if (NOISE_ROOTS.has(normalized)) return;
  signals.push({ ...signal, normalized, context: contextOf(signal.file) });
}

/**
 * Mine one file's TEXT for entity signals. Never parses or executes the file.
 * Returns raw signals; clustering happens later so that cross-file context
 * (e.g. member-route attestation) is available.
 */
export function scanFileForSignals(file, text, { memberSegments = new Set() } = {}) {
  const signals = [];
  const lines = String(text).split(/\r?\n/);

  const codeLines = lines.map(stripComments);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = codeLines[index];
    if (!line.trim()) continue;

    // 1. TYPED ID SCHEMES -- mint/construction sites only.
    ID_MINT_RE.lastIndex = 0;
    for (let match = ID_MINT_RE.exec(line); match; match = ID_MINT_RE.exec(line)) {
      const anchor = typedIdAnchor(codeLines, index, line, match.index);
      if (!anchor) continue;
      pushSignal(signals, {
        signature_class: 'typed_id', raw_name: match[2], file, line: lineNumber, anchor,
        evidence: trimEvidence(rawLine), detail: { id_prefix: `${match[2]}-` },
      });
    }

    // 2. EVENT/ENVELOPE NAMESPACES -- complete quoted literals on bus machinery.
    DOTTED_LITERAL_RE.lastIndex = 0;
    for (let match = DOTTED_LITERAL_RE.exec(line); match; match = DOTTED_LITERAL_RE.exec(line)) {
      const kind = match[2];
      const root = kind.split('.')[0];
      if (NOISE_ROOTS.has(normalizeEntityName(root))) continue;
      const anchor = envelopeAnchor(codeLines, index, line, match.index);
      if (!anchor) continue;
      pushSignal(signals, {
        signature_class: 'envelope_namespace', raw_name: root, file, line: lineNumber, anchor,
        evidence: trimEvidence(rawLine), detail: { kind, lifecycle_suffix: kind.slice(root.length + 1) },
      });
    }

    // 3. STORAGE SHAPES -- tables, store modules, per-record run-dir families.
    const table = CREATE_TABLE_RE.exec(line);
    if (table && !NON_TABLE_NAMES.has(table[1].toLowerCase())) {
      const fields = [];
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 60); cursor++) {
        const column = COLUMN_RE.exec(codeLines[cursor]);
        if (column) fields.push(column[1]);
        if (/^\s*\)\s*;?/.test(codeLines[cursor])) break;
      }
      pushSignal(signals, {
        signature_class: 'storage_shape', raw_name: table[1], file, line: lineNumber,
        anchor: 'sqlite-create-table', evidence: trimEvidence(rawLine),
        detail: { table: table[1], fields: fields.slice(0, 24) },
      });
    }
    for (const [regex, anchor] of [[STORE_CLASS_RE, 'store-class-declaration'], [STORE_FACTORY_RE, 'store-factory-declaration']]) {
      const match = regex.exec(line);
      if (!match) continue;
      pushSignal(signals, {
        signature_class: 'storage_shape', raw_name: match[1], file, line: lineNumber, anchor,
        evidence: trimEvidence(rawLine), detail: { store_suffix: match[2] },
      });
    }
    RECORD_DIR_RE.lastIndex = 0;
    for (let match = RECORD_DIR_RE.exec(line); match; match = RECORD_DIR_RE.exec(line)) {
      pushSignal(signals, {
        signature_class: 'storage_shape', raw_name: match[1], file, line: lineNumber,
        anchor: `per-record-directory-family:${match[2]}`, evidence: trimEvidence(rawLine),
        detail: { directory: match[1], record_key: match[2] },
      });
    }

    // 4. API RESOURCE NOUNS -- route registrations.
    for (const [regex, kind] of [[ROUTE_CALL_RE, 'plugin-http-route'], [EXPRESS_ROUTE_RE, 'express-route']]) {
      regex.lastIndex = 0;
      for (let match = regex.exec(line); match; match = regex.exec(line)) {
        const method = (kind === 'plugin-http-route' ? match[2] : match[1]).toUpperCase();
        const routePath = kind === 'plugin-http-route' ? match[4] : match[3];
        for (const segment of routePath.split('/').filter(Boolean)) {
          if (segment.startsWith(':') || segment.startsWith('{') || ROUTE_SKIP_SEGMENTS.has(segment)) continue;
          if (!isCollectionSegment(segment, memberSegments)) continue;
          pushSignal(signals, {
            signature_class: 'api_resource', raw_name: segment, file, line: lineNumber,
            anchor: `${kind}:${method}`, evidence: trimEvidence(rawLine),
            detail: { method, path: routePath, resource_segment: segment },
          });
        }
      }
    }
  }
  return signals;
}

/** Collect the `/<segment>/:<param>` member-route attestations across a corpus. */
export function collectMemberSegments(fileTexts) {
  const members = new Set();
  for (const text of fileTexts) {
    for (const regex of [ROUTE_CALL_RE, EXPRESS_ROUTE_RE]) {
      regex.lastIndex = 0;
      for (let match = regex.exec(text); match; match = regex.exec(text)) {
        const routePath = regex === ROUTE_CALL_RE ? match[4] : match[3];
        const segments = routePath.split('/').filter(Boolean);
        for (const [index, segment] of segments.entries()) {
          const next = segments[index + 1];
          if (next && (next.startsWith(':') || next.startsWith('{'))) members.add(segment);
        }
      }
    }
  }
  return members;
}

/* ------------------------------------------------------------- clustering --- */

const bySignatureSite = nameOf => (a, b) =>
  a.signature_class.localeCompare(b.signature_class) || a.file.localeCompare(b.file) ||
  a.line - b.line || String(nameOf(a)).localeCompare(String(nameOf(b))) || String(a.anchor).localeCompare(String(b.anchor));
const witnessSort = bySignatureSite(signal => signal.raw_name);
const emittedWitnessSort = bySignatureSite(witness => witness.name);

function makeCluster(entity) {
  return { entity, aliases: new Set(), classes: new Map(), contexts: new Set(), lifecycle: new Set(), operations: new Set(), fields: new Set(), id_prefixes: new Set(), merged_from: [] };
}

function absorb(cluster, signal) {
  cluster.aliases.add(signal.raw_name);
  cluster.contexts.add(signal.context);
  if (!cluster.classes.has(signal.signature_class)) cluster.classes.set(signal.signature_class, []);
  cluster.classes.get(signal.signature_class).push(signal);
  if (signal.detail?.kind) cluster.lifecycle.add(signal.detail.kind);
  if (signal.detail?.id_prefix) cluster.id_prefixes.add(signal.detail.id_prefix);
  if (signal.detail?.method) cluster.operations.add(`${signal.detail.method} ${signal.detail.path}`);
  for (const field of signal.detail?.fields || []) cluster.fields.add(field);
}

/**
 * Cluster candidates across signature classes.
 *
 * Merging is CONSERVATIVE by construction: identical normalized names merge
 * (deterministic normalization, not similarity), and an abbreviation merges into
 * its expansion ONLY when the two candidate sets share a witness context (same
 * component subtree -- e.g. a `wo-` mint site and a `work_order.*` emission both
 * under plugins/work-dispatch). Name similarity alone NEVER merges; an
 * abbreviation whose expansion is observed elsewhere with no shared context is
 * reported as an AMBIGUOUS merge and the clusters stay separate.
 */
export function clusterSignals(signals) {
  const clusters = new Map();
  for (const signal of [...signals].sort(witnessSort)) {
    if (!clusters.has(signal.normalized)) clusters.set(signal.normalized, makeCluster(signal.normalized));
    absorb(clusters.get(signal.normalized), signal);
  }

  const ambiguous = [];
  for (const name of [...clusters.keys()].sort()) {
    const expansion = expandAbbreviation(name);
    if (!expansion) continue;
    const source = clusters.get(name);
    const target = clusters.get(expansion);
    if (!target) {
      ambiguous.push({ abbreviation: name, expansion, resolution: 'kept_separate', reason: 'expansion_cluster_not_observed' });
      continue;
    }
    const shared = [...source.contexts].filter(context => target.contexts.has(context)).sort();
    if (!shared.length) {
      ambiguous.push({
        abbreviation: name, expansion, resolution: 'kept_separate', reason: 'no_shared_witness_context',
        abbreviation_contexts: [...source.contexts].sort(), expansion_contexts: [...target.contexts].sort(),
      });
      continue;
    }
    for (const [signatureClass, list] of source.classes) for (const signal of list) absorb(target, signal);
    target.merged_from.push({ alias: name, via: 'abbreviation_table', shared_contexts: shared });
    clusters.delete(name);
  }

  const finalized = [...clusters.values()].map(cluster => {
    const classes = [...cluster.classes.keys()].sort();
    const witnesses = [];
    let truncated = 0;
    for (const signatureClass of classes) {
      const list = [...cluster.classes.get(signatureClass)].sort(witnessSort);
      for (const signal of list.slice(0, MAX_WITNESSES_PER_CLASS)) {
        witnesses.push({
          signature_class: signal.signature_class, file: signal.file, line: signal.line,
          name: signal.raw_name, anchor: signal.anchor, evidence: signal.evidence,
        });
      }
      truncated += Math.max(0, list.length - MAX_WITNESSES_PER_CLASS);
    }
    return {
      entity: cluster.entity,
      aliases: [...cluster.aliases].sort(),
      signature_classes: classes,
      confidence: classes.length,
      confidence_label: CONFIDENCE_LABELS[classes.length] || 'weak',
      witness_count: [...cluster.classes.values()].reduce((total, list) => total + list.length, 0),
      witnesses_truncated: truncated,
      contexts: [...cluster.contexts].sort(),
      id_prefixes: [...cluster.id_prefixes].sort(),
      lifecycle_kinds: [...cluster.lifecycle].sort(),
      api_operations: [...cluster.operations].sort(),
      storage_fields: [...cluster.fields].sort(),
      merged_from: [...cluster.merged_from].sort((a, b) => a.alias.localeCompare(b.alias)),
      witnesses: witnesses.sort(emittedWitnessSort),
    };
  });
  finalized.sort((a, b) => a.entity.localeCompare(b.entity));
  return { clusters: finalized, ambiguous_merges: ambiguous.sort((a, b) => a.abbreviation.localeCompare(b.abbreviation)) };
}

/* ---------------------------------------------------------- canon parsing --- */

const canonFail = message => {
  throw new Error(`ontology parse failed: ${message}. No discovery report was written; fix design/canon/ontology.md or this parser before trusting a reconciliation (a wrong canon baseline silently manufactures both false "undocumented" and false "unwitnessed" findings).`);
};
const canonCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
const QUICK_REFERENCE_COLUMNS = ['Entity', 'One-liner', 'Owner', 'DDD Type', 'Mutability'];

/**
 * Parse the REAL entity catalogue out of design/canon/ontology.md: the `###`
 * headings under `## Expanded Definitions`, cross-checked against the Quick
 * Reference table. Fails LOUDLY on structural drift -- same discipline as
 * ddd-overlays.mjs, because a wrong witness looks verified.
 */
export function parseOntologyEntities(text) {
  const lines = String(text).split(/\r?\n/);
  const headingIndex = pattern => lines.findIndex(line => pattern.test(line.trim()));
  const quickIndex = headingIndex(/^##\s+Quick Reference$/);
  const expandedIndex = headingIndex(/^##\s+Expanded Definitions$/);
  const notEntityIndex = headingIndex(/^##\s+What is NOT an Entity$/);
  if (quickIndex < 0) canonFail("section heading '## Quick Reference' not found");
  if (expandedIndex < 0) canonFail("section heading '## Expanded Definitions' not found");
  if (notEntityIndex < 0) canonFail("section heading '## What is NOT an Entity' not found");
  if (notEntityIndex < expandedIndex) canonFail("'## What is NOT an Entity' appears before '## Expanded Definitions'");

  let cursor = quickIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim().startsWith('|') && !/^#{2,3}\s/.test(lines[cursor])) cursor++;
  if (cursor >= lines.length || !lines[cursor].trim().startsWith('|')) canonFail('no markdown table found under Quick Reference');
  const header = canonCells(lines[cursor]);
  if (header.length !== QUICK_REFERENCE_COLUMNS.length || header.some((cell, index) => cell !== QUICK_REFERENCE_COLUMNS[index])) {
    canonFail(`Quick Reference columns changed: expected [${QUICK_REFERENCE_COLUMNS.join(' | ')}] but found [${header.join(' | ')}]`);
  }
  const quickEntities = [];
  for (let index = cursor + 2; index < lines.length; index++) {
    if (!lines[index].trim().startsWith('|')) break;
    const row = canonCells(lines[index]);
    if (row.length !== QUICK_REFERENCE_COLUMNS.length) canonFail(`Quick Reference row at line ${index + 1} has ${row.length} column(s), expected ${QUICK_REFERENCE_COLUMNS.length}`);
    const label = /^\[([^\]]+)\]/.exec(row[0]) ? /^\[([^\]]+)\]/.exec(row[0])[1] : row[0];
    quickEntities.push({ label, line: index + 1 });
  }
  if (!quickEntities.length) canonFail('Quick Reference table parsed zero entity rows');

  // Code fences matter: the document embeds a `# ...` markdown heading inside a
  // fenced example, which a naive heading scan would ingest as an entity.
  const headings = (from, to) => {
    const found = [];
    let fenced = false;
    for (let index = from; index < to; index++) {
      const line = lines[index];
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const match = /^###\s+(.+?)\s*$/.exec(line);
      if (match) found.push({ heading: match[1].trim(), line: index + 1 });
    }
    return found;
  };
  const toEntity = ({ heading, line }) => {
    const label = heading.replace(/\s*\(.*$/, '').trim();
    return { name: label, heading, normalized: normalizeEntityName(label), line };
  };
  const entities = headings(expandedIndex + 1, notEntityIndex).map(toEntity).filter(entity => entity.normalized);
  const nonEntities = headings(notEntityIndex + 1, lines.length).map(toEntity).filter(entity => entity.normalized);
  if (entities.length < MIN_CANON_ENTITIES) {
    canonFail(`only ${entities.length} '### <Entity>' heading(s) parsed under Expanded Definitions, expected at least ${MIN_CANON_ENTITIES}`);
  }
  const seen = new Set();
  for (const entity of entities) {
    if (seen.has(entity.normalized)) canonFail(`entity '${entity.name}' is defined twice under Expanded Definitions (line ${entity.line})`);
    seen.add(entity.normalized);
  }
  const documentedNormalized = new Set(entities.map(entity => entity.normalized));
  const quickOnly = quickEntities
    .map(row => ({ ...row, normalized: normalizeEntityName(row.label) }))
    .filter(row => row.normalized && !documentedNormalized.has(row.normalized));

  return {
    entities: entities.sort((a, b) => a.normalized.localeCompare(b.normalized)),
    non_entities: nonEntities.sort((a, b) => a.normalized.localeCompare(b.normalized)),
    quick_reference_rows: quickEntities.length,
    quick_reference_only: quickOnly.sort((a, b) => a.normalized.localeCompare(b.normalized)),
  };
}

/* -------------------------------------------------------- reconciliation --- */

/**
 * Classify every cluster and every canon entry. The +N is SIGNED: adjudicated
 * dead documented entities count negative. Adjudication is HUMAN input
 * (`--dead`), never inferred by the tool.
 */
const tokensOf = normalized => new Set(String(normalized).split('_').filter(Boolean));
function nearMissClusters(canonNormalized, clusters) {
  const canonTokens = tokensOf(canonNormalized);
  return clusters
    .filter(cluster => {
      const clusterTokens = tokensOf(cluster.entity);
      if (cluster.entity === canonNormalized) return false;
      const subset = [...clusterTokens].every(token => canonTokens.has(token));
      const superset = [...canonTokens].every(token => clusterTokens.has(token));
      return subset || superset;
    })
    .sort((a, b) => b.confidence - a.confidence || a.entity.localeCompare(b.entity))
    .slice(0, 3)
    .map(cluster => ({ entity: cluster.entity, confidence: cluster.confidence, merge_not_performed: 'token-subset overlap only; no shared witness context justified a merge' }));
}

export function reconcile(clusters, canon, { adjudicatedDead = [] } = {}) {
  const canonByNormalized = new Map(canon.entities.map(entity => [entity.normalized, entity]));
  const nonEntityByNormalized = new Map(canon.non_entities.map(entity => [entity.normalized, entity]));
  const dead = new Set(adjudicatedDead.map(normalizeEntityName).filter(Boolean));
  const matchedCanon = new Set();
  const matched = [];
  const discoveredUndocumented = [];

  for (const cluster of clusters) {
    const keys = [cluster.entity, ...cluster.aliases.map(normalizeEntityName), ...cluster.aliases.map(alias => normalizeEntityName(expandAbbreviation(normalizeEntityName(alias)) || ''))].filter(Boolean);
    const hit = keys.map(key => canonByNormalized.get(key)).find(Boolean);
    const row = {
      entity: cluster.entity, aliases: cluster.aliases, confidence: cluster.confidence,
      confidence_label: cluster.confidence_label, signature_classes: cluster.signature_classes,
      witness_count: cluster.witness_count,
      discovered_witnesses: cluster.witnesses.slice(0, MAX_WITNESSES_PER_CLASS).map(witness => `${witness.file}:${witness.line}`),
    };
    if (hit) {
      matchedCanon.add(hit.normalized);
      matched.push({ ...row, classification: 'matched', canon_entity: hit.name, canon_witness: { file: canon.relative_path, line: hit.line } });
    } else {
      const nonEntity = nonEntityByNormalized.get(cluster.entity);
      discoveredUndocumented.push({
        ...row, classification: 'discovered_undocumented',
        canon_note: nonEntity ? `canon explicitly lists '${nonEntity.heading}' under "What is NOT an Entity" (${canon.relative_path}:${nonEntity.line}) -- adjudicate whether the code signal contradicts that ruling` : null,
      });
    }
  }

  const documentedUnwitnessed = canon.entities
    .filter(entity => !matchedCanon.has(entity.normalized))
    .map(entity => ({
      entity: entity.normalized, canon_entity: entity.name, classification: 'documented_unwitnessed',
      canon_witness: { file: canon.relative_path, line: entity.line },
      searched_signature_classes: [...SIGNATURE_CLASSES],
      adjudicated_dead: dead.has(entity.normalized),
      // Adjudication aid ONLY -- never a merge. A token-subset overlap says
      // "a human should check whether these are the same thing"; without a
      // shared witness context the tool refuses to decide.
      near_miss_clusters: nearMissClusters(entity.normalized, clusters),
    }));

  const confirmedDead = documentedUnwitnessed.filter(entry => entry.adjudicated_dead).map(entry => entry.entity);
  return {
    matched: matched.sort((a, b) => a.entity.localeCompare(b.entity)),
    discovered_undocumented: discoveredUndocumented.sort((a, b) => b.confidence - a.confidence || a.entity.localeCompare(b.entity)),
    documented_unwitnessed: documentedUnwitnessed.sort((a, b) => a.entity.localeCompare(b.entity)),
    confirmed_dead: confirmedDead.sort(),
  };
}

function evaluateExpectations(clusters, reconciliation) {
  const byName = new Map();
  for (const cluster of clusters) {
    byName.set(cluster.entity, cluster);
    for (const alias of cluster.aliases) byName.set(normalizeEntityName(alias), cluster);
  }
  const classificationOf = entity => {
    for (const key of ['matched', 'discovered_undocumented']) {
      if (reconciliation[key].some(row => row.entity === entity)) return key;
    }
    return reconciliation.documented_unwitnessed.some(row => row.entity === entity) ? 'documented_unwitnessed' : 'not_found';
  };
  return EXPECTED_FINDINGS.map(expectation => {
    const cluster = byName.get(expectation.entity) ||
      (expectation.aliases || []).map(alias => byName.get(normalizeEntityName(alias))).find(Boolean);
    const observed = cluster ? classificationOf(cluster.entity) : classificationOf(expectation.entity);
    const classesOk = !expectation.min_signature_classes || (cluster?.confidence || 0) >= expectation.min_signature_classes;
    const found = Boolean(cluster);
    const ok = found && observed === expectation.expected && classesOk;
    let note = null;
    if (!found) note = 'NOT DISCOVERED -- treat as an extractor bug (a missing signature-class anchor), not as evidence the entity does not exist.';
    else if (observed !== expectation.expected) {
      note = observed === 'matched'
        ? `census error, not an extractor bug: the entity IS documented in the canon (see reconciliation.matched) -- the source wins over the census claim of '${expectation.expected}'.`
        : `classification mismatch: expected '${expectation.expected}', observed '${observed}'.`;
    } else if (!classesOk) note = `expected at least ${expectation.min_signature_classes} independent signature class(es), observed ${cluster?.confidence || 0}.`;
    return {
      entity: expectation.entity, expected: expectation.expected, observed,
      discovered_as: cluster ? cluster.entity : null,
      signature_classes: cluster ? cluster.signature_classes : [], ok, note,
    };
  }).sort((a, b) => a.entity.localeCompare(b.entity));
}

/* ------------------------------------------------------------- reporting --- */

export function buildReport({ clusters, ambiguous_merges, canon, reconciliation, scan, generatedAt = DEFAULT_GENERATED_AT }) {
  const headline = {
    discovered_entity_types: clusters.length,
    documented_entity_types: canon.entities.length,
    matched: reconciliation.matched.length,
    discovered_undocumented: reconciliation.discovered_undocumented.length,
    documented_unwitnessed: reconciliation.documented_unwitnessed.length,
    confirmed_dead: reconciliation.confirmed_dead.length,
    signed_canon_delta: reconciliation.discovered_undocumented.length - reconciliation.confirmed_dead.length,
  };
  return {
    schema: SCHEMA,
    producer: PRODUCER_ID,
    generated_at: generatedAt,
    headline,
    scan,
    signature_classes: SIGNATURE_CLASSES.map(id => ({ id, description: SIGNATURE_CLASS_DESCRIPTIONS[id] })),
    canon: {
      path: canon.relative_path,
      documented_entities: canon.entities.map(entity => ({ entity: entity.normalized, canon_entity: entity.name, line: entity.line })),
      documented_non_entities: canon.non_entities.map(entity => ({ entity: entity.normalized, heading: entity.heading, line: entity.line })),
      quick_reference_rows: canon.quick_reference_rows,
      quick_reference_only: canon.quick_reference_only.map(row => ({ entity: row.normalized, label: row.label, line: row.line })),
    },
    reconciliation,
    ambiguous_merges,
    expectations: evaluateExpectations(clusters, reconciliation),
    clusters,
  };
}

/**
 * A discovery report of the right SHAPE carrying no findings, for the case where the
 * discovery stage could not run at all.
 *
 * Built by calling the REAL `buildReport` with empty inputs rather than hand-writing an
 * object literal. A hand-written stand-in drifts the moment buildReport grows a key, and
 * the resulting crash surfaces one frame deeper in a consumer (`reading 'headline'`) where
 * nothing names the actual cause -- the same trap the entity-layer and discover-entities
 * ENOENT guards each had to be fixed for a second time.
 *
 * `unavailable` is load-bearing: it distinguishes "discovery ran and found nothing" from
 * "discovery never ran". Without it a consumer reads zero discovered entities as a fact
 * about the estate rather than an absence of measurement.
 */
export function emptyDiscoveryReport({ estateRoot = process.cwd(), unavailable = 'discovery stage did not run' } = {}) {
  return {
    ...buildReport({
      clusters: [],
      ambiguous_merges: [],
      canon: { entities: [], non_entities: [], quick_reference_rows: 0, quick_reference_only: [], relative_path: DEFAULT_CANON_RELATIVE },
      reconciliation: { matched: [], discovered_undocumented: [], documented_unwitnessed: [], confirmed_dead: [] },
      scan: {
        estate_root_basename: path.basename(path.resolve(estateRoot)),
        files_scanned: 0, files_walked: 0, signals: 0,
        extensions: [...SCANNED_EXTENSIONS], include_tests: false, scope_exclusion_counts: {},
      },
    }),
    portability: [],
    unavailable,
  };
}

const mdEscape = value => String(value).replace(/\|/g, '\\|');

export function renderMarkdown(report) {
  const headline = report.headline;
  const out = [];
  out.push('# Ascrybe — Entity Discovery vs Documented Ontology');
  out.push('');
  out.push(`**Discovered ${headline.discovered_entity_types} entity types from code signals · ${headline.matched} matched the canon · +${headline.discovered_undocumented} undocumented · ${headline.documented_unwitnessed} documented-unwitnessed · signed canon delta ${headline.signed_canon_delta >= 0 ? '+' : ''}${headline.signed_canon_delta}.**`);
  out.push('');
  out.push(`Generated by \`tools/estate-map/discover-entities.mjs\` (${report.producer}, deterministic; \`generated_at\` is a fixed constant so two runs are byte-identical). Canon baseline: \`${report.canon.path}\` (${headline.documented_entity_types} entity types under *Expanded Definitions*). Read-only: no graph nodes written, canon never modified.`);
  out.push('');
  out.push('## Discovered vs Documented');
  out.push('');
  out.push('| Bucket | Count | Meaning |');
  out.push('|---|---:|---|');
  out.push(`| Discovered (code signals) | ${headline.discovered_entity_types} | entity types with at least one anchored witness |`);
  out.push(`| Documented (canon) | ${headline.documented_entity_types} | \`###\` entries under Expanded Definitions |`);
  out.push(`| matched | ${headline.matched} | discovered AND documented |`);
  out.push(`| discovered_undocumented (**the +N**) | ${headline.discovered_undocumented} | real in code, absent from canon — the canon-update work queue |`);
  out.push(`| documented_unwitnessed | ${headline.documented_unwitnessed} | in canon, no signal found — stale canon OR a discovery gap |`);
  out.push(`| confirmed_dead (adjudicated) | ${headline.confirmed_dead} | human-adjudicated removals; count negative |`);
  out.push(`| **signed canon delta** | **${headline.signed_canon_delta >= 0 ? '+' : ''}${headline.signed_canon_delta}** | undocumented − confirmed dead |`);
  out.push('');
  out.push(`Scan: ${report.scan.files_scanned} code file(s), ${report.scan.signals} anchored signal(s), extensions \`${report.scan.extensions.join(' ')}\`, test/fixture paths ${report.scan.include_tests ? 'INCLUDED' : 'excluded'}. Signature classes mined:`);
  out.push('');
  for (const entry of report.signature_classes) out.push(`- \`${entry.id}\` — ${entry.description}`);
  out.push('');

  const section = (title, rows, renderer, empty) => {
    out.push(`## ${title}`);
    out.push('');
    if (!rows.length) { out.push(empty); out.push(''); return; }
    renderer(rows);
    out.push('');
  };

  section(`The +N — discovered, undocumented (${headline.discovered_undocumented})`, report.reconciliation.discovered_undocumented, rows => {
    const table = subset => {
      out.push('| Entity | Conf | Signature classes | Witnesses | First witnesses |');
      out.push('|---|---:|---|---:|---|');
      for (const row of subset) {
        out.push(`| \`${row.entity}\`${row.aliases.length > 1 ? ` (aka ${row.aliases.map(a => `\`${a}\``).join(', ')})` : ''} | ${row.confidence} | ${row.signature_classes.join(', ')} | ${row.witness_count} | ${row.discovered_witnesses.slice(0, 3).map(w => `\`${w}\``).join('<br>')} |`);
      }
    };
    const corroborated = rows.filter(row => row.confidence >= 2);
    const weak = rows.filter(row => row.confidence < 2);
    out.push(`**Corroborated (≥2 independent signature classes): ${corroborated.length}.** These are the strongest canon-update candidates.`);
    out.push('');
    if (corroborated.length) table(corroborated); else out.push('_None._');
    out.push('');
    out.push(`**Weak (single signature class): ${weak.length}.** Real anchored witnesses, but only one class attests — includes genuine aggregates (\`environment\`, \`lease\`), projections/read models (\`*_summary\`, \`work_explorer_*\`), and transient message-id schemes (\`ready-\`, \`drained-\`). Triage before promoting to canon.`);
    out.push('');
    if (weak.length) table(weak); else out.push('_None._');
    const notes = rows.filter(row => row.canon_note);
    if (notes.length) {
      out.push('');
      for (const row of notes) out.push(`- \`${row.entity}\`: ${row.canon_note}`);
    }
  }, '_No undocumented entity types discovered._');

  section(`Matched — discovered and documented (${headline.matched})`, report.reconciliation.matched, rows => {
    out.push('| Entity | Canon entry | Conf | Signature classes | Witnesses |');
    out.push('|---|---|---:|---|---:|');
    for (const row of rows) {
      out.push(`| \`${row.entity}\` | ${mdEscape(row.canon_entity)} (\`${row.canon_witness.file}:${row.canon_witness.line}\`) | ${row.confidence} | ${row.signature_classes.join(', ')} | ${row.witness_count} |`);
    }
  }, '_No matches._');

  section(`Documented but unwitnessed (${headline.documented_unwitnessed})`, report.reconciliation.documented_unwitnessed, rows => {
    out.push('Either stale canon **or** a discovery-process gap. All four signature classes were searched, so a human adjudicates which.');
    out.push('');
    out.push('| Canon entry | Canon witness | Searched | Near-miss clusters (adjudication aid, NOT merged) | Adjudicated dead |');
    out.push('|---|---|---|---|---|');
    for (const row of rows) {
      const nearMiss = row.near_miss_clusters?.length ? row.near_miss_clusters.map(entry => `\`${entry.entity}\` (conf ${entry.confidence})`).join(', ') : '—';
      out.push(`| ${mdEscape(row.canon_entity)} | \`${row.canon_witness.file}:${row.canon_witness.line}\` | ${row.searched_signature_classes.join(', ')} | ${nearMiss} | ${row.adjudicated_dead ? 'yes' : 'no'} |`);
    }
  }, '_Every documented entity has a code witness._');

  section(`Ambiguous merges (${report.ambiguous_merges.length})`, report.ambiguous_merges, rows => {
    out.push('Name similarity alone never merges clusters. These abbreviation/expansion pairs lacked a shared witness context and were left SEPARATE.');
    out.push('');
    out.push('| Abbreviation | Expansion | Resolution | Reason |');
    out.push('|---|---|---|---|');
    for (const row of rows) out.push(`| \`${row.abbreviation}\` | \`${row.expansion}\` | ${row.resolution} | ${row.reason} |`);
  }, '_No ambiguous merges._');

  section('Census expectation self-check', report.expectations, rows => {
    out.push('Expected findings from the operator census, VERIFIED against this run. A miss is an extractor bug; a documented-after-all entity is a census error (the source wins).');
    out.push('');
    out.push('| Expected entity | Expected | Observed | Discovered as | OK | Note |');
    out.push('|---|---|---|---|---|---|');
    for (const row of rows) {
      out.push(`| \`${row.entity}\` | ${row.expected} | ${row.observed} | ${row.discovered_as ? `\`${row.discovered_as}\`` : '—'} | ${row.ok ? 'yes' : '**no**'} | ${row.note ? mdEscape(row.note) : ''} |`);
    }
  }, '_No expectations configured._');

  out.push('## Per-cluster evidence');
  out.push('');
  const ordered = [...report.clusters].sort((a, b) => b.confidence - a.confidence || b.witness_count - a.witness_count || a.entity.localeCompare(b.entity));
  for (const cluster of ordered) {
    const classification = report.reconciliation.matched.some(row => row.entity === cluster.entity) ? 'matched' : 'discovered_undocumented';
    out.push(`### \`${cluster.entity}\` — confidence ${cluster.confidence}/4 (${cluster.confidence_label}), ${classification}`);
    out.push('');
    out.push(`- Aliases: ${cluster.aliases.map(alias => `\`${alias}\``).join(', ')}`);
    out.push(`- Signature classes: ${cluster.signature_classes.join(', ')}`);
    if (cluster.id_prefixes.length) out.push(`- Typed id prefixes: ${cluster.id_prefixes.map(prefix => `\`${prefix}\``).join(', ')}`);
    if (cluster.lifecycle_kinds.length) out.push(`- Lifecycle (envelope kinds): ${cluster.lifecycle_kinds.map(kind => `\`${kind}\``).join(', ')}`);
    if (cluster.api_operations.length) out.push(`- API operations: ${cluster.api_operations.map(operation => `\`${operation}\``).join(', ')}`);
    if (cluster.merged_from.length) out.push(`- Merged aliases: ${cluster.merged_from.map(entry => `\`${entry.alias}\` via ${entry.via} (shared context: ${entry.shared_contexts.join(', ')})`).join('; ')}`);
    out.push(`- Contexts: ${cluster.contexts.join(', ')}`);
    out.push('');
    out.push('| Signature class | Witness | Anchor | Evidence |');
    out.push('|---|---|---|---|');
    for (const witness of cluster.witnesses) {
      out.push(`| ${witness.signature_class} | \`${witness.file}:${witness.line}\` | ${mdEscape(witness.anchor)} | \`${mdEscape(witness.evidence)}\` |`);
    }
    if (cluster.witnesses_truncated) out.push('');
    if (cluster.witnesses_truncated) out.push(`_(+${cluster.witnesses_truncated} further witness(es) omitted; full list in discovery-report.json.)_`);
    out.push('');
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ main --- */

export async function discoverEntities({ estateRoot, canonPath, includeTests = false, adjudicatedDead = [], generatedAt = DEFAULT_GENERATED_AT } = {}) {
  const root = path.resolve(estateRoot || process.cwd());
  const resolvedCanon = canonPath ? path.resolve(canonPath) : path.join(root, DEFAULT_CANON_RELATIVE);
  // Canon FIRST: a structural DRIFT (canon present but malformed) must still abort before
  // any output is produced. An ABSENT canon is a different thing: it means this estate does
  // not document an ontology at all, which is the normal case for every estate but the one
  // this tool was written for. Absence degrades to "no documented entities" plus a durable
  // refusal record; it must not kill the run with an ENOENT stack trace (which also took
  // loop-driver's whole iteration down with it).
  //
  // The typed record is produced by portability.mjs, which is the conservation gates'
  // derivability vocabulary (conservation.mjs) applied to "was this input present at
  // all?". Absence -> SCOPE/input_absent; present-but-unreadable -> SCOPE/input_unreadable;
  // present-but-unparseable -> BUG/input_malformed, which is NOT smoothed into absence
  // because a broken parse manufactures false "undocumented" findings.
  const canonRead = await readOptionalEstateInput(resolvedCanon, {
    tool: TOOL_ID,
    estateRoot: root,
    capability: 'documented_entity_comparison',
    why: 'estate documents no ontology canon; documented-entity comparison is unavailable and every discovered entity is reported as undocumented',
  });
  const canonText = canonRead.present ? canonRead.value : null;
  const portabilityRecords = canonRead.record ? [canonRead.record] : [];
  // Retained in its original shape because the discovery report schema and its
  // consumers already read these keys; the typed record above is the machine surface.
  const canonRefusal = canonRead.record && {
    refusal: 'ontology_canon_absent',
    evidence: 'absence',
    canon_path: normalizePath(path.relative(root, resolvedCanon)) || path.basename(resolvedCanon),
    why: canonRead.record.detail,
    portability_record: canonRead.record,
  };
  if (canonRefusal) console.warn(`discover-entities: no ontology canon at ${canonRefusal.canon_path} — degrading to discovery-only (${canonRefusal.refusal}).`);
  // Degrade to an EMPTY canon of the right SHAPE. Downstream code maps over
  // canon.entities / canon.non_entities / canon.quick_reference_only unconditionally, so
  // returning a partial object only moves the crash one frame deeper.
  const canon = canonText === null
    ? {
      entities: [],
      non_entities: [],
      quick_reference_rows: 0,
      quick_reference_only: [],
      refusal: canonRefusal,
      relative_path: canonRefusal.canon_path,
    }
    : { ...parseOntologyEntities(canonText), relative_path: normalizePath(path.relative(root, resolvedCanon)) || path.basename(resolvedCanon) };

  const walked = await walk(root, { sampleCap: 20 });
  const candidates = walked.files
    .map(file => normalizePath(path.relative(root, file)))
    .filter(file => SCANNED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
    .filter(file => includeTests || !isTestPath(file))
    .sort();

  const texts = new Map();
  for (const file of candidates) {
    try { texts.set(file, await fs.readFile(path.join(root, file), 'utf8')); } catch { /* unreadable file: skipped, never fatal */ }
  }
  const memberSegments = collectMemberSegments(texts.values());
  const signals = [];
  for (const file of [...texts.keys()].sort()) signals.push(...scanFileForSignals(file, texts.get(file), { memberSegments }));

  const { clusters, ambiguous_merges } = clusterSignals(signals);
  const reconciliation = reconcile(clusters, canon, { adjudicatedDead });
  const scan = {
    estate_root_basename: path.basename(root),
    files_scanned: texts.size,
    files_walked: walked.files.length,
    signals: signals.length,
    extensions: [...SCANNED_EXTENSIONS],
    include_tests: includeTests,
    scope_exclusion_counts: walked.scopeExclusions.counts,
  };
  return { ...buildReport({ clusters, ambiguous_merges, canon, reconciliation, scan, generatedAt }), portability: portabilityRecords };
}

export async function writeDiscoveryReport(report, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'discovery-report.json');
  const markdownPath = path.join(outDir, 'discovery-report.md');
  await fs.writeFile(jsonPath, stableStringify(report), 'utf8');
  await fs.writeFile(markdownPath, `${renderMarkdown(report).replace(/\n+$/, '')}\n`, 'utf8');
  return { jsonPath, markdownPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); process.exit(0); }
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const root = path.resolve(positional[0] || repoRoot);
  registerScanRoot(root, { registeredBy: `${TOOL_ID} estate-root argument` });
  try {
    const adjudicatedDead = options.dead ? JSON.parse(await fs.readFile(path.resolve(options.dead), 'utf8')) : [];
    const report = await discoverEntities({
      estateRoot: root,
      canonPath: options.canon ? path.resolve(options.canon) : undefined,
      includeTests: Boolean(options['include-tests']),
      adjudicatedDead,
      generatedAt: options['generated-at'],
    });
    // The default MUST NOT be `<root>/.estate-map/...`. That default is how
    // A neighbouring estate acquired an .estate-map/ directory (32 MB map.html,
    // OPERATION-LOG.md, a whole prior run's graph) before anyone noticed the tool was
    // writing into an estate it was only supposed to read.
    const outDir = options.out ? path.resolve(options.out) : defaultOutputRoot(root, 'entity-discovery');
    const written = await writeDiscoveryReport(report, outDir);
    if (options.json) { console.log(stableStringify(report)); process.exit(0); }
    const headline = report.headline;
    console.log(`Discovered ${headline.discovered_entity_types} entity type(s) from ${report.scan.signals} anchored signal(s) across ${report.scan.files_scanned} file(s).`);
    console.log(`matched=${headline.matched}  +undocumented=${headline.discovered_undocumented}  documented_unwitnessed=${headline.documented_unwitnessed}  signed_delta=${headline.signed_canon_delta >= 0 ? '+' : ''}${headline.signed_canon_delta}`);
    console.log(`Wrote ${normalizePath(path.relative(root, written.jsonPath))} and ${normalizePath(path.relative(root, written.markdownPath))}`);
    const failures = report.expectations.filter(expectation => !expectation.ok);
    if (failures.length) {
      console.log('Census expectation self-check flagged:');
      for (const failure of failures) console.log(`  ${failure.entity}: expected ${failure.expected}, observed ${failure.observed} -- ${failure.note}`);
    } else console.log('Census expectation self-check: all expectations satisfied.');
  } catch (error) { console.error(error.message); process.exit(1); }
}
