// Full-corpus semantic claim extraction.
//
// DIVISION OF LABOUR. The model READS MEANING only: it proposes claims with an exact source quote.
// Deterministic code BINDS EVIDENCE: obligations are derived from the exact symbol census, the exact
// tracked tree, and the project's own declared checks — never from model-authored identifiers. This
// removes the whole class of hallucinated bindings and keeps the model's task small enough to be
// fast and reliable.
//
// CLOSED DENOMINATOR. Every window is attempted, and every proposal becomes either an admitted claim
// or a RECORDED REFUSAL with a reason. Nothing is silently dropped, so a missing claim is always
// attributable to a named window, a named refusal, or a documented cap.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const SEMANTIC_EXTRACTION_SCHEMA = 'estate-map/semantic-claim-extraction/v2';
export const SEMANTIC_EXTRACTOR_VERSION = 'semantic-claim-extractor@3-code-shaped-binding';
export const DEFAULT_WINDOW_BYTES = 4000;
// Measured: at 4 KB windows a 12-claim cap truncated 45 of 51 windows, so the claim denominator was
// capped rather than closed. Raised until windows stop saturating; `reached_claim_cap` stays in the
// receipt so truncation is always visible rather than inferred.
export const MAX_CLAIMS_PER_WINDOW = 30;
export const MAX_BOUND_SYMBOLS = 3;

const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const compare = (left, right) => left.localeCompare(right);

export const CLAIM_KINDS = Object.freeze([
  'current_capability', 'current_architecture', 'negative_capability',
  'accepted_design', 'proposed_design', 'historical_design',
]);
const SOURCE_STATUSES = Object.freeze(['current', 'historical', 'aspirational', 'deprecated', 'disputed']);
const DECISION_STATUSES = Object.freeze(['none', 'draft', 'proposed', 'accepted', 'rejected', 'implemented', 'superseded']);
const DESIGN_KINDS = new Set(['accepted_design', 'proposed_design', 'historical_design']);
const IDENTIFIER = /[A-Za-z_$][\w$]{2,}/gu;
// A prose word that happens to collide with a unique symbol name is not a reference to that symbol.
// Measured on the 111,347-claim corpus, bare English words carried the bulk of all bindings — `work`
// bound 14,291 claims, `only` 11,558, `without` 8,368 — because each collided with exactly one
// declaration somewhere in the estate. Uniqueness proves the NAME is unambiguous; it says nothing
// about whether the prose meant the code. Shape does: an author writing about code either quotes it
// or spells it in a form prose does not produce.
const CODE_SHAPED = /[a-z][A-Z]|_|\$|\d/u;
const BACKTICKED = /`([^`]+)`/gu;

function extractionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Split a document into windows, never mid-line. Markdown headings are a PREFERRED boundary, used
 * only once a window carries substantial content, so a heading-dense document does not degenerate
 * into many tiny paid units. Non-Markdown files have no heading concept: a YAML comment is not a
 * section break.
 */
export function windowDocument({ path, content, maxBytes = DEFAULT_WINDOW_BYTES }) {
  const lines = String(content).split(/\r?\n/u);
  const markdown = /\.md$/iu.test(path);
  const preferBoundaryAt = Math.floor(maxBytes * 0.6);
  const windows = [];
  let current = [];
  let startLine = 1;
  let bytes = 0;
  const flush = nextStart => {
    if (current.length) {
      windows.push(Object.freeze({
        path,
        start_line: startLine,
        end_line: startLine + current.length - 1,
        content: current.join('\n'),
      }));
    }
    current = [];
    bytes = 0;
    startLine = nextStart;
  };
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const heading = markdown && /^#{1,6}\s/u.test(line);
    if (current.length && ((heading && bytes >= preferBoundaryAt) || bytes + lineBytes > maxBytes)) {
      flush(lineNumber);
    }
    if (!current.length) startLine = lineNumber;
    current.push(line);
    bytes += lineBytes;
  }
  flush(lines.length + 1);
  return Object.freeze(windows);
}

/** Claims-only prompt. Small and uniform: the model never sees an identifier menu. */
export function buildExtractionPrompt({ window }) {
  const numbered = window.content.split(/\r?\n/u)
    .map((line, index) => `${window.start_line + index}: ${line}`).join('\n');
  return [
    'Extract the semantic claims this document window asserts about the project.',
    'A claim states what the project IS, DOES, MUST DO, WILL DO, ONCE DID, or DOES NOT DO.',
    'Skip pure formatting, navigation, and table-of-contents text.',
    '',
    'For each claim return EXACTLY:',
    '  statement: one short sentence in your own words',
    `  claim_kind: ${CLAIM_KINDS.join('|')}`,
    '     current_capability = the project currently does or has this',
    '     current_architecture = how the project is currently structured or packaged',
    '     negative_capability = the project does NOT do or have this',
    '     accepted_design = a decision accepted as intent',
    '     proposed_design = proposed, deferred, or unresolved and explicitly not shipped',
    '     historical_design = a superseded or previous behavior',
    `  source_status: ${SOURCE_STATUSES.join('|')}`,
    `  decision_status: ${DECISION_STATUSES.join('|')}`,
    '  line: 1-based line number your quote is on',
    '  quote: verbatim substring copied byte-for-byte from that line',
    '',
    `At most ${MAX_CLAIMS_PER_WINDOW} claims. Terse fields. Do not restate the quote in the statement.`,
    'Return ONLY JSON: {"claims":[...]}',
    '',
    `DOCUMENT ${window.path} lines ${window.start_line}-${window.end_line}:`,
    numbered,
  ].join('\n');
}

function lineText(root, path, line) {
  return readFileSync(join(root, path), 'utf8').split(/\r?\n/u)[line - 1] ?? null;
}

/**
 * Deterministically bind evidence obligations. Identifiers are matched ONLY against the exact symbol
 * census; paths ONLY against the exact tracked tree; checks ONLY when the source text itself cites
 * the project's verifier. A claim with no bindable evidence gets an explicit open question rather
 * than a flattering guess.
 */
export function bindObligations({ claim, quote, root, symbolIndex, treePaths, checks, verifierPaths }) {
  const obligations = [];
  const haystack = `${claim.statement} ${quote}`;
  const seenSymbols = new Set();
  // A negative claim cannot be supported by finding a declaration: presence is evidence toward the
  // opposite. Absence is only decidable over an explicitly complete inventory, which this binder
  // cannot derive from prose, so such claims are routed to an explicit open question instead.
  const negative = claim.claim_kind === 'negative_capability';
  // Explicit quoting is an authorial declaration that the token names code, so a backticked word
  // binds whatever its shape. Everything else must carry code shape to bind at all.
  const quoted = new Set();
  for (const span of haystack.matchAll(BACKTICKED)) {
    for (const token of span[1].matchAll(IDENTIFIER)) quoted.add(token[0]);
  }
  if (!negative) for (const match of haystack.matchAll(IDENTIFIER)) {
    const name = match[0];
    if (seenSymbols.has(name)) continue;
    if (!quoted.has(name) && !CODE_SHAPED.test(name)) continue;
    const declarations = symbolIndex.get(name);
    if (!declarations || declarations.length !== 1) continue;
    seenSymbols.add(name);
    obligations.push({ kind: 'code_symbol_declared', symbol: name, path: declarations[0].file,
      declaration_kind: declarations[0].symbol_kind || null });
    if (seenSymbols.size >= MAX_BOUND_SYMBOLS) break;
  }
  // Prose that names files asserts those files EXIST; it does not assert the tree contains nothing
  // else. Binding an exact-set obligation here made every such claim refute itself.
  const citedPaths = treePaths.filter(path => haystack.includes(path));
  if (!negative && citedPaths.length) {
    obligations.push({ kind: 'tree_paths_present', paths: citedPaths });
  }
  const citesVerifier = verifierPaths.some(path => haystack.includes(path))
    || /\bverif(y|ier|ication)\b|\bharness\b|\btest suite\b/iu.test(haystack);
  if (!negative && citesVerifier && checks.length) {
    const check = checks.find(row => row.id === 'tests') || checks[0];
    obligations.push({ kind: 'verification_check_passed', command: check.command,
      stdout_pattern: check.stdout_pattern, timeout_ms: check.timeout_ms });
  }
  if (DESIGN_KINDS.has(claim.claim_kind)) {
    obligations.push({ kind: 'source_text_present', path: claim.source.path,
      line: claim.source.line, quote });
  }
  if (negative) {
    obligations.push({
      kind: 'open_question',
      question: `What complete inventory would settle the absence asserted by: ${claim.statement}`,
      missing_evidence: 'Absence is decidable only over an explicitly complete inventory (for example a whole-runtime effect trace); no such closed inventory is a producer input here.',
    });
  }
  if (!obligations.length) {
    obligations.push({
      kind: 'open_question',
      question: `What deterministic evidence would settle: ${claim.statement}`,
      missing_evidence: 'No declared symbol, tracked path, or declared check in this project binds to this claim; runtime behavior traces are not producer inputs.',
    });
  }
  return obligations;
}

function admitProposal({ proposal, window, root, symbolIndex, treePaths, checks, verifierPaths, seen }) {
  const refuse = reason => ({ admitted: null, refusal: Object.freeze({
    document: window.path,
    window_start_line: window.start_line,
    // A refusal is either about ONE proposal or about a whole window that produced none, and
    // conservation depends on telling them apart. It used to be inferred from whether a statement
    // survived -- but a malformed proposal is refused about a specific proposal and has no
    // statement to show, so seventeen of them broke the invariant after every window had been
    // paid for. The category is now declared instead of deduced.
    scope: 'proposal',
    proposed_statement: clean(proposal?.statement).slice(0, 300) || null,
    proposed_line: Number.isInteger(proposal?.line) ? proposal.line : null,
    proposed_quote: String(proposal?.quote ?? '').slice(0, 300) || null,
    reason,
  }) });

  if (!proposal || typeof proposal !== 'object') return refuse('proposal_not_an_object');
  const statement = clean(proposal.statement);
  const quote = String(proposal.quote ?? '');
  const line = Number(proposal.line);
  if (!statement) return refuse('statement_missing');
  if (!CLAIM_KINDS.includes(proposal.claim_kind)) return refuse('claim_kind_outside_closed_vocabulary');
  if (!SOURCE_STATUSES.includes(proposal.source_status)) return refuse('source_status_outside_closed_vocabulary');
  if (!DECISION_STATUSES.includes(proposal.decision_status)) return refuse('decision_status_outside_closed_vocabulary');
  if (!Number.isInteger(line) || line < window.start_line || line > window.end_line) {
    return refuse('cited_line_outside_extraction_window');
  }
  if (!quote.trim()) return refuse('quote_missing');
  const observed = lineText(root, window.path, line);
  if (observed == null || !observed.includes(quote)) return refuse('quote_not_byte_exact_on_cited_line');

  const claimKey = `${window.path}:${line}:${sha256(canonical([statement, quote])).slice(0, 12)}`;
  if (seen.has(claimKey)) return refuse('duplicate_claim_key');
  seen.add(claimKey);
  const base = {
    authority_plane: 'imported_semantic',
    claim_key: claimKey,
    statement,
    claim_kind: proposal.claim_kind,
    source_status: proposal.source_status,
    decision_status: proposal.decision_status,
    source: { path: window.path, line, quote },
  };
  const obligations = bindObligations({ claim: base, quote, root, symbolIndex, treePaths, checks, verifierPaths });
  return { refusal: null, admitted: Object.freeze({
    ...base,
    extraction: Object.freeze({
      producer: SEMANTIC_EXTRACTOR_VERSION,
      window_start_line: window.start_line,
      window_end_line: window.end_line,
      binding: 'deterministic',
    }),
    proof_plan: { mode: 'all_required', obligations },
  }) };
}

function loadJournal(path) {
  if (!existsSync(path)) return new Map();
  const held = new Map();
  for (const row of readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean)) {
    try {
      const entry = JSON.parse(row);
      if (entry?.prompt_digest && entry.outcome === 'ok' && entry.answer) held.set(entry.prompt_digest, entry);
    } catch { /* a corrupt line simply forces the call to be re-made */ }
  }
  return held;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function extractSemanticClaims({
  project, materialized_root: materializedRoot, tree_manifest: treeManifest,
  document_paths: documentPaths, code_facts: codeFacts, checks = [],
  runner, journal_dir: journalDir, window_bytes: windowBytes = DEFAULT_WINDOW_BYTES,
  concurrency = 4, onProgress = null,
}) {
  if (!project?.sha || !runner || typeof runner.complete !== 'function') {
    throw extractionError('SEMANTIC_EXTRACTION_INPUT_INVALID', 'semantic extraction requires a project and a model runner');
  }
  const root = resolve(materializedRoot);
  const treePaths = treeManifest.files.map(row => row.path);
  const manifestByPath = new Map(treeManifest.files.map(row => [row.path, row]));
  const symbolIndex = new Map();
  for (const fact of codeFacts) {
    if (fact.record.kind !== 'symbol' || !clean(fact.record.name)) continue;
    const held = symbolIndex.get(fact.record.name) || [];
    held.push({ file: fact.record.file, symbol_kind: fact.record.symbol_kind || null });
    symbolIndex.set(fact.record.name, held);
  }
  const verifierPaths = treePaths.filter(path => /verify|test|check/iu.test(path));
  mkdirSync(journalDir, { recursive: true });
  const journalFile = join(journalDir, 'extraction-calls.jsonl');
  const cached = loadJournal(journalFile);

  const windows = [];
  for (const path of documentPaths.slice().sort(compare)) {
    if (!manifestByPath.has(path)) throw extractionError('DOCUMENT_OUTSIDE_TREE', `document is absent from the exact tree: ${path}`);
    windows.push(...windowDocument({ path, content: readFileSync(join(root, path), 'utf8'), maxBytes: windowBytes }));
  }

  let completed = 0;
  const answers = await mapWithConcurrency(windows, concurrency, async window => {
    const prompt = buildExtractionPrompt({ window });
    const promptDigest = sha256(prompt);
    const hit = cached.get(promptDigest);
    if (hit) {
      completed += 1;
      if (onProgress) onProgress({ completed, total: windows.length, window, reused: true });
      return { window, promptDigest, payload: hit.answer, outcome: 'ok', usage: hit.usage || null, reused: true };
    }
    const result = await runner.complete({ prompt, tag: `extract:${window.path}:${window.start_line}` });
    const entry = {
      prompt_digest: promptDigest,
      document: window.path,
      window_start_line: window.start_line,
      outcome: result.outcome || 'ok',
      usage: result.usage || null,
      answer: result.json ?? null,
      answer_digest: sha256(String(result.text ?? '')),
    };
    appendFileSync(journalFile, `${JSON.stringify(entry)}\n`);
    completed += 1;
    if (onProgress) onProgress({ completed, total: windows.length, window, reused: false, outcome: entry.outcome });
    return { window, promptDigest, payload: entry.answer, outcome: entry.outcome, usage: entry.usage, reused: false };
  });

  const admitted = [];
  const refusals = [];
  const unitReceipts = [];
  const seen = new Set();
  let calls = 0;
  let reused = 0;
  let cost = 0;
  for (const answer of answers) {
    if (answer.reused) reused += 1; else calls += 1;
    cost += Number(answer.usage?.cost || 0);
    const proposals = Array.isArray(answer.payload?.claims) ? answer.payload.claims : null;
    if (!proposals) {
      refusals.push(Object.freeze({
        document: answer.window.path,
        window_start_line: answer.window.start_line,
        scope: 'window',
        proposed_statement: null,
        proposed_line: null,
        proposed_quote: null,
        reason: answer.outcome === 'ok' ? 'model_answer_not_a_claims_array' : `model_call_${answer.outcome}`,
      }));
    }
    let admittedHere = 0;
    for (const proposal of proposals || []) {
      const decision = admitProposal({ proposal, window: answer.window, root, symbolIndex,
        treePaths, checks, verifierPaths, seen });
      if (decision.admitted) { admitted.push(decision.admitted); admittedHere += 1; }
      else refusals.push(decision.refusal);
    }
    unitReceipts.push(Object.freeze({
      document: answer.window.path,
      start_line: answer.window.start_line,
      end_line: answer.window.end_line,
      prompt_digest: answer.promptDigest,
      reused_from_journal: answer.reused,
      outcome: answer.outcome,
      proposed: (proposals || []).length,
      admitted: admittedHere,
      reached_claim_cap: (proposals || []).length >= MAX_CLAIMS_PER_WINDOW,
    }));
  }
  unitReceipts.sort((left, right) => compare(left.document, right.document) || left.start_line - right.start_line);
  admitted.sort((left, right) => compare(left.claim_key, right.claim_key));
  refusals.sort((left, right) => compare(left.document, right.document)
    || left.window_start_line - right.window_start_line || compare(left.reason, right.reason));

  const proposedTotal = unitReceipts.reduce((sum, row) => sum + row.proposed, 0);
  const refusedProposals = refusals.filter(row => row.scope === 'proposal').length;
  if (admitted.length + refusedProposals !== proposedTotal) {
    throw extractionError('EXTRACTION_CONSERVATION', 'admitted + refused proposals must equal proposals');
  }
  const body = {
    schema: SEMANTIC_EXTRACTION_SCHEMA,
    producer: SEMANTIC_EXTRACTOR_VERSION,
    project: { id: project.id, sha: project.sha },
    model: runner.model || null,
    window_bytes: windowBytes,
    binding_policy: 'model proposes claims only; obligations are bound deterministically from the exact symbol census, tracked tree, and declared checks',
    documents: documentPaths.slice().sort(compare),
    extraction_units: unitReceipts,
    conservation: {
      windows: windows.length,
      model_calls: calls,
      reused_journal_answers: reused,
      failed_units: unitReceipts.filter(row => row.outcome !== 'ok').length,
      windows_at_claim_cap: unitReceipts.filter(row => row.reached_claim_cap).length,
      proposed_claims: proposedTotal,
      admitted_claims: admitted.length,
      refused_proposals: refusedProposals,
      reported_cost_usd: Number(cost.toFixed(6)),
    },
    refusals,
  };
  return Object.freeze({
    claims: Object.freeze(admitted),
    receipt: Object.freeze({ ...body, digest: sha256(canonical(body)) }),
  });
}
