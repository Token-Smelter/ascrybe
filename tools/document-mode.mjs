#!/usr/bin/env node
// What a document is, as distinct from what it says.
//
// Every document in the corpus is currently read the same way: a research note exploring an
// abandoned option produces the same occurrence and reference edges as a specification asserting
// what the system does, and a claim campaign would adjudicate both against code. That is a
// manufactured false signal — "we tried X and it underperformed" is not an assertion that the
// system does X, and refuting it says nothing about whether the docs are right.
//
// A document's rhetorical mode is therefore a first-class property, decided once and disclosed
// like relation roles are. The axis is whether a document asserts what is true of the system NOW:
//
//   specification  asserts what the system is            adjudicate against code
//   decision       records a choice and its rationale    adjudicate; supersession matters
//   plan           states what is intended, not built    never adjudicate: absence is not error
//   research       explores the world or the options     never adjudicate against code
//   report         states findings of an executed run    historical; evidence, not design
//   log            records what happened at a time       historical; not current-state
//   record         an external artifact the estate keeps  ticket, KB entry; about the world
//   unclassified   no signal reached its threshold       excluded from adjudication, visible
//
// A plan is the research problem in another guise: adjudicating "we will add X" against code
// refutes every intention not yet implemented, which says nothing about whether the plan is
// sound. A record is not about the system at all — a support ticket describes a customer's
// experience, and its mention of a table name is an occurrence, never a claim about that table.
//
// Classification is graded exactly as surface matching is: a `path` basis fires on repository
// conventions, a `structure` basis on front matter and headings, and anything unresolved stays
// `unclassified` rather than being guessed. Every decision carries the basis and the exact
// evidence that produced it, so a wrong mode is arguable against its witness rather than opaque.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCUMENT_MODES = Object.freeze([
  'specification', 'decision', 'plan', 'research', 'report', 'log', 'record', 'unclassified',
]);
// Adjudication is comparing a claim against something that could refute it, and the something
// differs by what kind of document made the claim. A boolean here would encode "refutable against
// code" while reading as "refutable at all" — which would quietly assert that a research finding
// is unfalsifiable rather than that its refuter lives outside the estate. Each mode therefore
// names its frame, and `none` means nothing in reach could settle it, not that it is beyond doubt.
export const ADJUDICATION_FRAMES = Object.freeze({
  specification: 'code',            // does the implementation match what this says?
  decision: 'code_and_supersession', // and: has a later decision replaced it?
  plan: 'execution',                // was the intended thing actually done?
  report: 'execution',              // did the run happen as this describes?
  research: 'world',                // true of reality — not checkable inside the estate
  record: 'external_system',        // mirrors a system this map does not hold
  log: 'none',                      // records a moment; there is nothing to refute
  unclassified: 'none',
});
export const ADJUDICABLE_DOCUMENT_MODES = Object.freeze(['specification', 'decision']);

/** The frame a mode may be adjudicated in; archived material is never a current assertion. */
export function adjudicationFrame(mode, archived = false) {
  if (archived) return 'none';
  return ADJUDICATION_FRAMES[mode] ?? 'none';
}

// Path conventions are the strongest available signal and the cheapest: a corpus that files
// research under research/ is telling you the mode directly. Ordered; first match wins.
const PATH_RULES = Object.freeze([
  { mode: 'record', pattern: /(^|\/)(knowledge-base|tickets?|kb|faq|correspondence|inbox)(\/|$)/iu },
  { mode: 'research', pattern: /(^|\/)[a-z-]*research[a-z-]*(\/|$)/iu },
  { mode: 'research', pattern: /(^|\/)(experiments?|explorations?|spikes?|market-analyses|competitive-landscape|benchmarks?)(\/|$)/iu },
  { mode: 'plan', pattern: /(^|\/)(plans?|initiatives?|roadmaps?|proposals?|backlog)(\/|$)/iu },
  { mode: 'plan', pattern: /(^|\/)(PLAN|ROADMAP|PROPOSAL|RFC-DRAFT)[A-Z0-9_.-]*\.md$/u },
  { mode: 'log', pattern: /(^|\/)(logs?|journal|transcripts?|sessions?|_recovered-from-transcripts)(\/|$)/iu },
  { mode: 'log', pattern: /(^|\/)[A-Z_-]*LOG\.md$/u },
  { mode: 'report', pattern: /(^|\/)(reports?|reviews?|audits?|incidents?|proofs?|findings|investigations?|postmortems?)(\/|$)/iu },
  { mode: 'report', pattern: /(^|\/)(IMPL-REPORT|REVIEW|AUDIT|PROOF|POSTMORTEM|RCA)[A-Z0-9_.-]*\.md$/u },
  { mode: 'decision', pattern: /(^|\/)(decisions?|adrs?|rfcs?|doctrine)(\/|$)/iu },
  { mode: 'decision', pattern: /(^|\/)(ADR|RFC)[-_]?\d+/iu },
  { mode: 'specification', pattern: /(^|\/)(specs?|designs?|architecture|contracts?|schemas?)(\/|$)/iu },
  { mode: 'specification', pattern: /(^|\/)(README|AGENTS|CLAUDE|DESIGN|ARCHITECTURE|SPEC)[A-Z0-9_.-]*\.md$/u },
]);

// Archived and superseded material keeps whatever mode its content implies, but must never be
// read as a current assertion; it is reported alongside the mode rather than replacing it.
const ARCHIVED = /(^|\/)(archive[ds]?|deprecated|superseded|iterations?|old|attic)(\/|$)/iu;

const HEADING_RULES = Object.freeze([
  { mode: 'research', pattern: /^#{1,3}\s+(findings?|hypothes[ie]s|methodology|literature|survey|competitive|market|experiment|prior art)\b/imu },
  { mode: 'decision', pattern: /^#{1,3}\s+(decision|context and decision|status|consequences|alternatives considered)\b/imu },
  { mode: 'report', pattern: /^#{1,3}\s+(results?|verdict|outcome|what happened|timeline|remediation)\b/imu },
  { mode: 'plan', pattern: /^#{1,3}\s+(plan|phases?|milestones?|deliverables?|scope|next steps)\b/imu },
  { mode: 'record', pattern: /^#{1,3}\s+(ticket|customer|subject|resolution)\b/imu },
  { mode: 'specification', pattern: /^#{1,3}\s+(requirements?|acceptance criteria|interface|api|schema|invariants?|contract)\b/imu },
]);

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/u;

function frontMatterMode(text) {
  const held = FRONT_MATTER.exec(text);
  if (!held) return null;
  // Only an explicit declaration counts. A document that names its own kind is authoritative
  // about itself in a way no inference is.
  const declared = /^(?:document_mode|doc_type|kind|type)\s*:\s*["']?([a-z_-]+)["']?\s*$/imu.exec(held[1]);
  const value = declared?.[1]?.toLowerCase().replace(/-/gu, '_');
  const mode = value === 'adr' || value === 'rfc' ? 'decision'
    : DOCUMENT_MODES.includes(value) ? value : null;
  return mode ? { mode, evidence: declared[0].trim() } : null;
}

/** Decide one document's mode from its path and text; never guesses, always discloses. */
export function classifyDocument({ path, text = '' }) {
  const held = String(path ?? '');
  const archived = ARCHIVED.test(held);
  const declared = frontMatterMode(text);
  if (declared) {
    return Object.freeze({ mode: declared.mode, basis: 'declared', evidence: declared.evidence, archived,
      adjudication_frame: adjudicationFrame(declared.mode, archived),
      adjudicable: !archived && ADJUDICABLE_DOCUMENT_MODES.includes(declared.mode) });
  }
  for (const rule of PATH_RULES) {
    const match = rule.pattern.exec(held);
    if (match) {
      return Object.freeze({ mode: rule.mode, basis: 'path', evidence: match[0], archived,
        adjudication_frame: adjudicationFrame(rule.mode, archived),
        adjudicable: !archived && ADJUDICABLE_DOCUMENT_MODES.includes(rule.mode) });
    }
  }
  for (const rule of HEADING_RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      return Object.freeze({ mode: rule.mode, basis: 'structure', evidence: match[0].trim(), archived,
        adjudication_frame: adjudicationFrame(rule.mode, archived),
        adjudicable: !archived && ADJUDICABLE_DOCUMENT_MODES.includes(rule.mode) });
    }
  }
  // No signal reached its threshold. An unclassified document is still fully queryable; it is
  // simply not treated as an assertion about the system until something says what it is.
  return Object.freeze({ mode: 'unclassified', basis: 'none', evidence: null, archived,
    adjudication_frame: 'none', adjudicable: false });
}

export function classifyCorpus({ root, documents, read = path => readFileSync(path, 'utf8') }) {
  const by_mode = {}; const by_basis = {}; const by_frame = {};
  const rows = documents.map(document => {
    let text = '';
    try { text = read(resolve(root, document)); } catch { text = ''; }
    const held = classifyDocument({ path: document, text });
    by_mode[held.mode] = (by_mode[held.mode] || 0) + 1;
    by_basis[held.basis] = (by_basis[held.basis] || 0) + 1;
    by_frame[held.adjudication_frame] = (by_frame[held.adjudication_frame] || 0) + 1;
    return { document, ...held };
  });
  return Object.freeze({
    schema: 'estate-map/document-mode-report/v1',
    rule: 'declared front matter, then repository path convention, then document structure; unresolved stays unclassified',
    documents: rows.length,
    by_mode, by_basis, by_frame,
    archived: rows.filter(row => row.archived).length,
    adjudicable: rows.filter(row => row.adjudicable).length,
    rows,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, list] = process.argv.slice(2);
  if (!root || !list) {
    console.error('usage: document-mode <estate-root> <documents.json>');
    process.exitCode = 1;
  } else {
    const documents = JSON.parse(readFileSync(resolve(list), 'utf8'));
    const report = classifyCorpus({ root, documents });
    const { rows: _rows, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
  }
}
