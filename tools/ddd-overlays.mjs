#!/usr/bin/env node
// Derive Ascrybe domain overlays from design/canon/ddd-mapping.md.
//
// The estate's bounded-context vocabulary ("Task Management", "Orchestration
// Execution", ...) appears NOWHERE in the code: it exists only in the canon
// document. This tool projects that vocabulary onto real code nodes while
// keeping provenance separate from canonical extracted evidence.
//
// PROVENANCE HONESTY: every record is a DETERMINISTIC PARSE of a committed
// document, not a model inference. It therefore carries
// `kind: 'doc_derived_annotation'` (see annotate.mjs ANNOTATION_KINDS) rather
// than `llm_annotation`, which would overstate the claim as an LLM judgement.
// The `model` field is required by the overlay schema and carries the producer
// identity instead of a model name.
//
// HARDENING: the document is PARSED, never transcribed. Witness line numbers
// are the real line numbers of the asserting rows/headings, so a reader can
// open the file at that line and check the claim. If the document's structure
// drifts (table gone, columns renamed, no rows), the parse FAILS LOUDLY and
// emits nothing: a wrong witness is worse than no overlay because it looks
// verified.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';

const HELP = `Usage:
  node tools/estate-map/ddd-overlays.mjs <estate-graph.json> <out.jsonl> [options]

Options:
  --canon <path>        canon document (default: <repo>/design/canon/ddd-mapping.md)
  --witness-repo <id>   repo name used in grounded_in witnesses (default: design)
  --witness-file <path> file path used in grounded_in witnesses (default: canon/ddd-mapping.md)
  --component <repo>    graph repo/component holding plugin modules (default: plugins)
  --generated-at <iso>  overlay timestamp (default: ${''}fixed constant, keeps output byte-stable)

Parses the canon DDD mapping and emits one service_card overlay per plugin module
node whose plugin has a documented bounded context. Plugins absent from the canon
table receive no domain and are reported as a documentation gap.`;

export const DOC_DERIVED_KIND = 'doc_derived_annotation';
export const PRODUCER_ID = 'deterministic/ddd-mapping-canon-parse';
// Fixed, not `new Date()`: repeated runs must be byte-identical.
export const DEFAULT_GENERATED_AT = '2026-07-25T00:00:00Z';
export const DEFAULT_CANON_RELATIVE = 'design/canon/ddd-mapping.md';
export const DEFAULT_WITNESS = Object.freeze({ repo: 'design', file: 'canon/ddd-mapping.md' });
export const DEFAULT_COMPONENT = 'plugins';
export const UNDOCUMENTED_DOMAIN_KEY = 'domain:__undocumented__';

const CONTEXT_SECTION = /^###\s+1\.1\s+Bounded Contexts\s*$/;
const AGGREGATE_SECTION = /^##\s+2\.\s+Aggregates\s*$/;
const AGGREGATE_HEADING = /^###\s+2\.(\d+)\s+(.+?)\s+\(([A-Za-z0-9_-]+)\s+plugin\)\s*$/;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|$/;
const EXPECTED_COLUMNS = ['Plugin', 'Bounded context', 'Ubiquitous language'];

const fail = message => {
  throw new Error(`ddd-mapping parse failed: ${message}. No overlays were emitted; fix the canon document or this parser before trusting a domain projection.`);
};
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

/**
 * Parse the canon DDD mapping document. Returns bounded contexts (with the real
 * line number of the asserting table row) and aggregates (with the real line
 * number of their heading). Throws loudly on any structural mismatch.
 */
export function parseDddMapping(text) {
  const lines = String(text).split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => CONTEXT_SECTION.test(line));
  if (sectionIndex < 0) fail("section heading '### 1.1 Bounded Contexts' not found");
  if (!lines.some(line => AGGREGATE_SECTION.test(line))) fail("section heading '## 2. Aggregates' not found");

  let cursor = sectionIndex + 1;
  while (cursor < lines.length && !lines[cursor].trim().startsWith('|') && !/^#{2,3}\s/.test(lines[cursor])) cursor++;
  if (cursor >= lines.length || !lines[cursor].trim().startsWith('|')) fail('no markdown table found under section 1.1 (bounded-context table missing)');

  const header = cells(lines[cursor]);
  if (header.length !== EXPECTED_COLUMNS.length || header.some((cell, index) => cell !== EXPECTED_COLUMNS[index])) {
    fail(`section 1.1 table columns changed: expected [${EXPECTED_COLUMNS.join(' | ')}] but found [${header.join(' | ')}]`);
  }
  if (!TABLE_SEPARATOR.test((lines[cursor + 1] || '').trim())) fail('section 1.1 table is missing its header separator row');

  const contexts = [];
  for (let index = cursor + 2; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) break;
    const row = cells(line);
    if (row.length !== EXPECTED_COLUMNS.length) fail(`section 1.1 table row at line ${index + 1} has ${row.length} column(s), expected ${EXPECTED_COLUMNS.length}`);
    const [plugin, domain, language] = row;
    if (!plugin || !domain || !language) fail(`section 1.1 table row at line ${index + 1} has an empty cell: [${row.join(' | ')}]`);
    if (contexts.some(entry => entry.plugin === plugin)) fail(`section 1.1 table lists plugin '${plugin}' twice (line ${index + 1})`);
    contexts.push({ plugin, domain, language, line: index + 1, aggregates: [] });
  }
  if (!contexts.length) fail('section 1.1 bounded-context table parsed zero rows');

  const aggregates = [];
  for (const [index, line] of lines.entries()) {
    const match = AGGREGATE_HEADING.exec(line);
    if (match) aggregates.push({ name: match[2].trim(), plugin: match[3], line: index + 1 });
  }
  if (!aggregates.length) fail("section 2 has no '### 2.N <Aggregate> (<plugin> plugin)' headings");

  const orphanAggregates = [];
  for (const aggregate of aggregates) {
    const context = contexts.find(entry => entry.plugin === aggregate.plugin);
    if (context) context.aggregates.push({ name: aggregate.name, line: aggregate.line });
    else orphanAggregates.push(aggregate);
  }
  for (const context of contexts) context.aggregates.sort((a, b) => a.line - b.line);
  return { contexts, aggregates, orphanAggregates };
}

const pluginOf = node => String(node.name || '').split('/')[0];

/** Build overlay records for a graph from parsed canon contexts. Pure + deterministic. */
export function buildDddOverlays(graph, parsed, options = {}) {
  const witnessRepo = options.witnessRepo || DEFAULT_WITNESS.repo;
  const witnessFile = options.witnessFile || DEFAULT_WITNESS.file;
  const component = options.component || DEFAULT_COMPONENT;
  const generatedAt = options.generatedAt || DEFAULT_GENERATED_AT;
  const records = [];
  const coverage = new Map();
  const uncovered = new Set();

  for (const node of graph.nodes || []) {
    if (node.repo !== component || node.kind !== 'module') continue;
    const plugin = pluginOf(node);
    if (!plugin) continue;
    const context = parsed.contexts.find(entry => entry.plugin === plugin);
    if (!context) {
      // Domains are never guessed: an undocumented plugin gets no overlay.
      uncovered.add(plugin);
      continue;
    }
    coverage.set(context.domain, (coverage.get(context.domain) || 0) + 1);
    records.push({
      annotation_kind: 'service_card',
      // Exact node id, NOT the component name: all four contexts live under the
      // single `plugins` component, and a component-name subject would expand to
      // every node in it and collapse the contexts into one domain.
      subject: node.id,
      kind: DOC_DERIVED_KIND,
      model: PRODUCER_ID,
      confidence: 1,
      generated_at: generatedAt,
      grounded_in: [
        { repo: witnessRepo, file: witnessFile, line: context.line },
        ...context.aggregates.map(aggregate => ({ repo: witnessRepo, file: witnessFile, line: aggregate.line })),
      ],
      body: {
        domain: context.domain,
        key_flows: context.aggregates.map(aggregate => `${aggregate.name} aggregate`),
        risks: [],
        summary: `Bounded context "${context.domain}" (plugin ${context.plugin}). Ubiquitous language: ${context.language}.`,
      },
    });
  }
  records.sort((a, b) => a.subject.localeCompare(b.subject));
  return {
    records,
    coverage: [...coverage].sort((a, b) => a[0].localeCompare(b[0])).map(([domain, count]) => ({ domain, count })),
    uncovered: [...uncovered].sort(),
    documentedPlugins: parsed.contexts.map(context => context.plugin).sort(),
  };
}

export async function produceDddOverlays(graphPath, outPath, options = {}) {
  const canonPath = options.canonPath || path.resolve(fileURLToPath(new URL('../../', import.meta.url)), DEFAULT_CANON_RELATIVE);
  const parsed = parseDddMapping(await fs.readFile(canonPath, 'utf8'));
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const result = buildDddOverlays(graph, parsed, options);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, result.records.map(record => JSON.stringify(record)).join('\n') + (result.records.length ? '\n' : ''), 'utf8');
  return { ...result, canonPath, outPath, parsed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length < 2) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await produceDddOverlays(path.resolve(positional[0]), path.resolve(positional[1]), {
      canonPath: options.canon ? path.resolve(options.canon) : undefined,
      witnessRepo: options['witness-repo'],
      witnessFile: options['witness-file'],
      component: options.component,
      generatedAt: options['generated-at'],
    });
    console.log(`Parsed ${result.parsed.contexts.length} bounded context(s) and ${result.parsed.aggregates.length} aggregate(s) from ${result.canonPath}`);
    console.log(`Wrote ${result.records.length} overlay record(s) to ${result.outPath}`);
    console.log('Domains covered:');
    for (const entry of result.coverage) console.log(`  ${entry.count}\t${entry.domain}`);
    console.log(`Plugins with NO documented bounded context (${result.uncovered.length}, correctly left undomained):`);
    console.log(`  ${result.uncovered.join(', ') || '(none)'}`);
    if (result.parsed.orphanAggregates.length) {
      console.log('Canon aggregates whose plugin is absent from the section 1.1 table:');
      for (const aggregate of result.parsed.orphanAggregates) console.log(`  ${aggregate.name} (${aggregate.plugin} plugin) line ${aggregate.line}`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
