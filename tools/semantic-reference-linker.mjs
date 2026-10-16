#!/usr/bin/env node
// Semantic reference layer: model-proposed, tool-validated doc→entity edges.
//
// String folds can only link shared spellings; "the iOS app" never reaches parcel-client-apps that
// way. This producer closes that gap without surrendering the map's discipline: the model reads
// one document window plus the complete referent catalog and proposes references, but every
// proposal must copy an exact quote from the window and name a catalog ID. The tool rewrites the
// quote to exact source lines (a quote that is absent or ambiguous in the window is a typed
// rejection, never a repair), refuses unknown targets, and records a receipt per window. The
// resulting `refers_to` edge carries match_basis: semantic, its witness span, and its receipt —
// the same custody contract every deterministic edge has. Model coordinates are never accepted;
// only model-copied bytes that the tool re-finds itself.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib.mjs';
import { wholeFileJson } from './whole-file-json.mjs';
import { buildAssertion, entitySubject } from './assertion.mjs';
import { classifyDocument } from './document-mode.mjs';
import documentStructure from './extractors/document-structure.mjs';

export const SEMANTIC_REFERENCE_SCHEMA = 'estate-map/semantic-reference/v1';
const canonical = value => stableStringify(value).trim();
const WINDOW_BYTES = 24_000;
const CATALOG_LIMIT = 200;

/** Entity catalog from a remap adjacency graph: id, surface, kind, namespace. */
export function referentCatalog(codeGraph) {
  return Object.entries(codeGraph.nodes ?? {})
    .filter(([, row]) => row.k === 'entity' && row.r !== 'document')
    .map(([id, row]) => ({ id, surface: row.l, kind: row.r, namespace: row.ns ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The catalog is the prompt's bulk, and a whole-estate catalog is mostly irrelevant to any one
 * document. Keep the entities that document could plausibly name: any whose surface or its
 * separator-folded form appears in the text, plus the estate's structurally largest entities as
 * a floor so a document that names nothing exactly can still reach the things that matter.
 * Pruning changes cost, never validity — an entity absent from the prompt simply cannot be
 * proposed, and every proposal is still validated against the full catalog id set.
 */
const fold = value => String(value ?? '').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().replace(/[\s_/-]+/gu, '');

export function prunedCatalog(catalog, text, limit = CATALOG_LIMIT) {
  const folded = fold(text);
  const lower = String(text).toLowerCase();
  const hit = catalog.filter(entry => {
    const surface = String(entry.surface ?? '');
    if (surface.length >= 4 && lower.includes(surface.toLowerCase())) return true;
    const key = fold(surface);
    return key.length >= 6 && folded.includes(key);
  });
  if (hit.length >= limit) return hit.slice(0, limit);
  const held = new Set(hit.map(entry => entry.id));
  const filler = catalog.filter(entry => !held.has(entry.id))
    .sort((left, right) => String(left.surface ?? '').length - String(right.surface ?? '').length);
  return [...hit, ...filler.slice(0, limit - hit.length)];
}

/** Line-aligned contiguous windows of at most WINDOW_BYTES. */
export function documentWindows(text, windowBytes = WINDOW_BYTES) {
  const lines = text.split(/\r?\n/u);
  const windows = [];
  let start = 0; let bytes = 0; let held = [];
  lines.forEach((line, index) => {
    const cost = Buffer.byteLength(line) + 1;
    if (held.length && bytes + cost > windowBytes) {
      windows.push({ line_start: start + 1, line_end: start + held.length, text: held.join('\n') });
      start = index; bytes = 0; held = [];
    }
    held.push(line); bytes += cost;
  });
  if (held.length) windows.push({ line_start: start + 1, line_end: start + held.length, text: held.join('\n') });
  return windows;
}

export function referencePrompt({ window, catalog }) {
  const entities = catalog.map(entry => `${entry.id}\t${entry.kind}\t${entry.surface}`).join('\n');
  return [
    'You are indexing references from a document into a closed catalog of software entities.',
    'Report each place the document text refers to a catalog entity — by name, alias, description, or paraphrase.',
    'Output: one JSON object per line, nothing else. Forms:',
    '{"q": "<verbatim quote copied from the document text>", "t": "<catalog id>"}',
    'Rules: q must be copied byte-for-byte from the DOCUMENT section (a short span, at most one line);',
    't must be one id from the CATALOG section. If the document references something not in the catalog, omit it.',
    'Do not report incidental word overlap; report only spans a careful reader would understand as referring to the entity.',
    'A span naming a different instance is not a reference: a different number, a different file, a',
    'different job, or a differently-scoped name is a different thing even when the words overlap.',
    'If there are no references, output exactly: NONE',
    '',
    'CATALOG (id<TAB>kind<TAB>surface):',
    entities,
    '',
    'DOCUMENT:',
    window.text,
  ].join('\n');
}

/** Validate one model proposal against the window and catalog; typed rejection, never repair. */
export function validateProposal({ proposal, window, catalogIds }) {
  const quote = proposal?.q;
  const target = proposal?.t;
  if (typeof quote !== 'string' || !quote.trim() || typeof target !== 'string') {
    return { rejected: 'malformed_proposal' };
  }
  if (!catalogIds.has(target)) return { rejected: 'unknown_target', target };
  const first = window.text.indexOf(quote);
  if (first === -1) return { rejected: 'quote_not_in_window', quote: quote.slice(0, 120) };
  if (window.text.indexOf(quote, first + 1) !== -1) return { rejected: 'quote_ambiguous_in_window', quote: quote.slice(0, 120) };
  const line = window.line_start + window.text.slice(0, first).split('\n').length - 1;
  return { quote, target, line };
}

function runPi({ model, prompt, environment = process.env }) {
  const args = ['--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-builtin-tools',
    '--print', '--mode', 'json', '--model', model];
  const held = spawnSync(environment.PI_COMMAND || 'pi', args, {
    input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: environment,
  });
  if (held.status !== 0) throw new Error(`pi exited ${held.status}: ${String(held.stderr).slice(-500)}`);
  const events = String(held.stdout).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const assistant = events.slice().reverse().map(event => event?.message ?? event?.messages?.at?.(-1))
    .find(message => message?.role === 'assistant');
  if (!assistant) throw new Error('pi produced no assistant message');
  if (assistant.stopReason === 'error') throw new Error(`pi provider error: ${assistant.errorMessage ?? 'unknown'}`);
  const text = (assistant.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  return { text, usage: assistant.usage ?? null };
}

export function parseProposals(text) {
  const proposals = []; let unparseable = 0;
  for (const line of String(text).split(/\r?\n/u).map(row => row.trim()).filter(Boolean)) {
    if (line === 'NONE') continue;
    try { proposals.push(JSON.parse(line)); } catch { unparseable += 1; }
  }
  return { proposals, unparseable };
}

export async function linkReferences({ estate_root, documents, code_graph, model, output,
  window_bytes: windowBytes = WINDOW_BYTES, environment = process.env, execute = runPi }) {
  if (environment.ASCRYBE_ENABLE_PAID_INFERENCE !== '1' && execute === runPi) {
    throw new Error('semantic reference linking is paid inference; set ASCRYBE_ENABLE_PAID_INFERENCE=1');
  }
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const catalog = referentCatalog(wholeFileJson(resolve(code_graph), { label: 'code graph' }));
  if (!catalog.length) throw new Error('referent catalog is empty');
  const catalogIds = new Set(catalog.map(entry => entry.id));
  mkdirSync(resolve(output), { recursive: true });
  const referencesPath = join(resolve(output), 'references.jsonl');
  const rejectionsPath = join(resolve(output), 'rejections.jsonl');
  const receipts = [];
  let totalCost = 0;
  // Where in the author's outline each line sits, so an assertion cites a section rather than a
  // line number that the next edit moves.
  const sections = new Map();
  const sectionAt = (rows, line) => rows?.find(row => line >= row.line && line <= row.line_end)?.section_path ?? null;
  for (const document of documents) {
    const bytes = readFileSync(join(resolve(estate_root), document), 'utf8');
    const classified = classifyDocument({ path: document, text: bytes });
    const standing = { mode: classified.mode, adjudication_frame: classified.adjudication_frame,
      archived: classified.archived };
    sections.set(document, documentStructure
      .scan(bytes.split(/\r?\n/u), { file: document, fact: (kind, line, data) => ({ kind, line, ...data }) })
      .filter(fact => fact.kind === 'document_section')
      .sort((left, right) => right.section_depth - left.section_depth));
    for (const window of documentWindows(bytes, windowBytes)) {
      const prompt = referencePrompt({ window, catalog: prunedCatalog(catalog, window.text) });
      const { text, usage } = await execute({ model, prompt, environment });
      const { proposals, unparseable } = parseProposals(text);
      const receipt = {
        receipt_id: `semantic-reference-receipt:${sha256(canonical({ document, window: [window.line_start, window.line_end], model, prompt_sha256: sha256(prompt) }))}`,
        document, line_start: window.line_start, line_end: window.line_end, model,
        proposals: proposals.length, unparseable, usage,
      };
      totalCost += Number(usage?.cost?.total ?? 0);
      receipts.push(receipt);
      for (const proposal of proposals) {
        const held = validateProposal({ proposal, window, catalogIds });
        if (held.rejected) {
          appendFileSync(rejectionsPath, `${JSON.stringify({ document, window: [window.line_start, window.line_end], ...held })}\n`);
          continue;
        }
        // A reference is an assertion: this document, at this line, says this entity. Emitting it
        // through the shared model rather than a bespoke record is what lets one reader handle
        // references, drawn edges, and claim-to-claim relations without three special cases.
        const assertion = buildAssertion({
          subject: entitySubject(held.target),
          source: { document, line: held.line, quote: held.quote,
            section_path: sectionAt(sections.get(document), held.line) },
          nature: { producer: 'semantic-reference-linker', modality: 'descriptive',
            document_mode: standing.mode ?? null, adjudication_frame: standing.adjudication_frame ?? null,
            archived: standing.archived ?? null },
          evidence: { receipt_id: receipt.receipt_id, match_basis: 'semantic' },
        });
        appendFileSync(referencesPath, `${JSON.stringify({
          schema: SEMANTIC_REFERENCE_SCHEMA, relation: 'refers_to', match_basis: 'semantic',
          document, line: held.line, quote: held.quote, referent_id: held.target,
          receipt_id: receipt.receipt_id,
          assertion_id: assertion.assertion_id, assertion,
        })}\n`);
      }
    }
  }
  const summary = { schema: `${SEMANTIC_REFERENCE_SCHEMA}-run`, model, documents: documents.length,
    windows: receipts.length, cost_usd: totalCost, receipts };
  writeFileSync(join(resolve(output), 'run-receipt.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error('usage: semantic-reference-linker --estate <root> --documents <list.json> --code-graph <adjacency.json> --model <pi model> --output <dir>');
    options[flag.slice(2).replaceAll('-', '_')] = value;
  }
  for (const required of ['estate', 'documents', 'code_graph', 'model', 'output']) {
    if (!options[required]) throw new Error(`--${required.replaceAll('_', '-')} is required`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const documents = JSON.parse(readFileSync(resolve(options.documents), 'utf8'));
  linkReferences({ estate_root: options.estate, documents, code_graph: options.code_graph,
    model: options.model, output: options.output,
    ...(options.window_bytes ? { window_bytes: Number(options.window_bytes) } : {}) })
    .then(summary => console.log(JSON.stringify({ documents: summary.documents, windows: summary.windows, cost_usd: summary.cost_usd }, null, 2)))
    .catch(error => { console.error(`FAIL semantic reference linking: ${error.message}`); process.exitCode = 1; });
}
