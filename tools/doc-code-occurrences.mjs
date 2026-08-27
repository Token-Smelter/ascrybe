// Deterministic document→code occurrence join (roadmap step 3, deterministic half).
//
// Every markdown file is tokenized ONCE into an exact-token index (identifier tokens, backtick
// spans, path-like tokens), then each code entity's surface is looked up. The result is an
// EVIDENCE edge — "this document names this entity's surface at these lines" — and never an
// identity claim: no entity is created, merged, or renamed by a documentary occurrence.
//
// Matching is graded, and every edge names its basis so aggressiveness is disclosed, never
// smuggled: `exact` is the byte-exact surface; `normalized` folds case and the separator
// alphabet (kebab/snake/camel/space) on both sides, which is what links human prose
// ("Sleep Worlds", "media encoder") to identifier surfaces (sleepworlds, MediaEncoder).
// Normalized matching is still derivation, not similarity: two tokens match only when one
// deterministic fold maps both to the same string, and a fold that lands on a short or
// English-common form is refused by the distinctiveness guard rather than allowed to flood
// the join. No embedding, no edit distance, no caps chosen to make numbers look good; the
// report carries the full hit distribution per basis so noise rules are decided from
// measurement.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const DOC_CODE_OCCURRENCE_REPORT_SCHEMA = 'estate-map/doc-code-occurrence-report/v1';
const canonical = value => stableStringify(value).trim();

const WORD = /[A-Za-z_$][\w$]*/gu;
const BACKTICK = /`([^`\n]+)`/gu;
const PATHISH = /[\w$.@-]+(?:\/[\w$.@-]+)+/gu;
// Multi-word phrases feed the normalized tier as overlapping 2- and 3-grams: a greedy regex
// would consume "Sleep Worlds is" and never offer "Sleep Worlds", so the n-grams are enumerated
// from the line's word sequence instead.

/** Fold case and the separator alphabet so prose and identifier spellings meet. */
export function normalizedSurfaceKey(value) {
  const folded = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
  return folded;
}

// A normalized key must stay distinctive: short folds and folds that are single common English
// words collide with prose constantly (the estate that taught this lesson had surfaces named
// 'all' and 'path'). The guard is deterministic and disclosed in the report.
const COMMON_WORDS = new Set(['all', 'and', 'any', 'app', 'are', 'array', 'boolean', 'build', 'but', 'call', 'case',
  'check', 'client', 'close', 'code', 'config', 'const', 'context', 'count', 'data', 'date', 'default', 'delete',
  'docs', 'end', 'error', 'event', 'false', 'file', 'files', 'filter', 'first', 'for', 'from', 'get', 'group',
  'handle', 'has', 'have', 'head', 'health', 'host', 'index', 'info', 'input', 'item', 'items', 'json', 'key',
  'keys', 'last', 'level', 'line', 'lines', 'link', 'list', 'load', 'log', 'logs', 'main', 'map', 'match', 'max',
  'message', 'meta', 'min', 'mode', 'model', 'name', 'names', 'new', 'next', 'node', 'not', 'null', 'number',
  'object', 'off', 'once', 'one', 'only', 'open', 'options', 'order', 'out', 'output', 'page', 'parse', 'patch',
  'path', 'paths', 'post', 'push', 'put', 'query', 'read', 'ready', 'render', 'report', 'request', 'response',
  'result', 'results', 'root', 'route', 'row', 'rows', 'run', 'runs', 'save', 'send', 'service', 'set', 'size',
  'sort', 'source', 'start', 'state', 'status', 'stop', 'string', 'sync', 'table', 'tag', 'tags', 'task', 'test',
  'tests', 'text', 'the', 'time', 'title', 'token', 'true', 'type', 'types', 'update', 'url', 'use', 'user',
  'users', 'value', 'values', 'view', 'watch', 'web', 'with', 'work', 'write']);
export function distinctiveNormalizedKey(key) {
  return key.length >= 4 && !COMMON_WORDS.has(key) && !/^\d+$/u.test(key);
}

function* markdownFiles(root, current = root) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const held = statSync(path);
    if (held.isDirectory()) yield* markdownFiles(root, path);
    else if (held.isFile() && /\.md$/iu.test(name)) yield relative(root, path);
  }
}

/** One pass over the declared document set; token → exact [docIndex, line] postings. */
export function buildDocTokenIndex({ docs_root: docsRoot, document_paths: documentPaths = null }) {
  const root = resolve(docsRoot);
  // The configured documentary set is authoritative and may name any text file the corpus governs;
  // this index only requires that every declared path be unique and inside the docs root. Ordering
  // is normalized here rather than demanded of the caller, because document index positions are
  // internal to this join and never an external identity.
  const documents = documentPaths == null
    ? [...markdownFiles(root)]
    : [...documentPaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (documents.some(path => {
    const target = resolve(root, path);
    return !path || (target !== root && !target.startsWith(`${root}/`));
  })) throw new Error('document_paths must be paths below docs_root');
  if (new Set(documents).size !== documents.length) {
    throw new Error('document_paths must be unique');
  }
  const postings = new Map();
  const normalizedPostings = new Map();
  const add = (store, token, docIndex, line) => {
    let held = store.get(token);
    if (!held) { held = []; store.set(token, held); }
    held.push([docIndex, line]);
  };
  documents.forEach((path, docIndex) => {
    const lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/u);
    lines.forEach((text, lineIndex) => {
      const line = lineIndex + 1;
      const once = new Set();
      const normalizedOnce = new Set();
      const addNormalized = token => {
        const normalized = normalizedSurfaceKey(token);
        if (!distinctiveNormalizedKey(normalized)) return;
        const key = `${normalized}\u0000${line}`;
        if (!normalizedOnce.has(key)) { normalizedOnce.add(key); add(normalizedPostings, normalized, docIndex, line); }
      };
      const words = [];
      for (const pattern of [WORD, BACKTICK, PATHISH]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const token = match[1] ?? match[0];
          const key = `${token}\u0000${line}`;
          if (!once.has(key)) { once.add(key); add(postings, token, docIndex, line); }
          addNormalized(token);
          if (pattern === WORD) words.push(token);
        }
      }
      for (let start = 0; start < words.length; start += 1) {
        if (start + 1 < words.length) addNormalized(`${words[start]} ${words[start + 1]}`);
        if (start + 2 < words.length) addNormalized(`${words[start]} ${words[start + 1]} ${words[start + 2]}`);
      }
    });
  });
  return { documents, postings, normalized_postings: normalizedPostings };
}

/**
 * Join resolved entities onto the index by exact surface. Returns document nodes, evidence
 * edges (document ↔ entity with hit lines), and the full distribution for honest reporting.
 */
export function joinDocOccurrences({ index, identity_candidates: candidates,
  mention_resolutions: resolutions }) {
  const referentByMention = new Map(resolutions.map(row => [row.mention_id, row.referent_id]));
  // A normalized key occurring across a large share of all documents is ambient vocabulary, not a
  // reference: linking a symbol named DASHBOARD to every prose "dashboard" adds noise, no
  // information. The threshold is derived from the corpus itself and disclosed in the report.
  const ambientThreshold = Math.max(20, Math.ceil(index.documents.length * 0.05));
  const ambient = new Set();
  for (const [key, postings] of index.normalized_postings ?? []) {
    if (new Set(postings.map(([docIndex]) => docIndex)).size > ambientThreshold) ambient.add(key);
  }
  const edges = new Map();
  let matchedEntities = 0;
  const surfaceHitCounts = [];
  let normalizedEntities = 0;
  for (const candidate of candidates) {
    const referentId = referentByMention.get(candidate.mention.mention_id);
    if (!referentId) continue;
    const surface = candidate.mention.surface;
    const record = (postings, basis) => {
      for (const [docIndex, line] of postings) {
        const key = `${docIndex}\u0000${referentId}`;
        let held = edges.get(key);
        if (!held) {
          held = { doc_index: docIndex, referent_id: referentId,
            surface, fact_kind: candidate.fact_kind, match_basis: basis,
            hits: 0, lines: [] };
          edges.set(key, held);
        }
        // An exact hit outranks a normalized one for the same document pair.
        if (basis === 'exact' && held.match_basis !== 'exact') held.match_basis = 'exact';
        held.hits += 1;
        if (held.lines.length < 5) held.lines.push(line);
      }
    };
    const exact = index.postings.get(surface);
    if (exact) {
      surfaceHitCounts.push(exact.length);
      matchedEntities += 1;
      record(exact, 'exact');
    } else surfaceHitCounts.push(0);
    const normalizedKey = normalizedSurfaceKey(surface);
    const normalized = index.normalized_postings && distinctiveNormalizedKey(normalizedKey)
      && !ambient.has(normalizedKey) ? index.normalized_postings.get(normalizedKey) : null;
    if (normalized) {
      // Exact postings for the same surface are a subset of its normalized postings; recording
      // both would double-count hits, so normalized lines only add pairs the exact tier missed.
      const seenExact = new Set((exact ?? []).map(([docIndex]) => `${docIndex}\u0000${referentId}`));
      const fresh = normalized.filter(([docIndex]) => !seenExact.has(`${docIndex}\u0000${referentId}`));
      if (fresh.length) { normalizedEntities += 1; record(fresh, 'normalized'); }
    }
  }
  const distribution = {};
  for (const count of surfaceHitCounts) {
    const bucket = count === 0 ? '0' : count <= 5 ? '1-5' : count <= 25 ? '6-25'
      : count <= 100 ? '26-100' : '>100';
    distribution[bucket] = (distribution[bucket] || 0) + 1;
  }
  const basisCounts = {};
  for (const edge of edges.values()) basisCounts[edge.match_basis] = (basisCounts[edge.match_basis] || 0) + 1;
  const reportBody = {
    schema: DOC_CODE_OCCURRENCE_REPORT_SCHEMA,
    rule: 'graded token occurrence of an entity surface in a markdown line — exact bytes first, then deterministic case/separator folding under a distinctiveness guard; evidence edge, never identity; every edge names its match_basis',
    documents: index.documents.length,
    entities_evaluated: candidates.length,
    entities_with_occurrences: matchedEntities,
    entities_with_normalized_only_occurrences: normalizedEntities,
    normalized_ambient_threshold_documents: ambientThreshold,
    normalized_ambient_keys_refused: ambient.size,
    doc_entity_edges: edges.size,
    edges_by_match_basis: basisCounts,
    surface_hit_distribution: distribution,
  };
  return {
    documents: index.documents,
    edges: [...edges.values()],
    report: { ...reportBody, report_digest: sha256(canonical(reportBody)) },
  };
}
