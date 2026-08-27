#!/usr/bin/env node
// Extractor facts to assertions.
//
// Extractors must load standalone from their own directory, so they emit fact SHAPES rather than
// assertions: a drawn edge records that its subject is a relation whose endpoints are unresolved,
// and this module builds the assertion from that. The split keeps the extractor registry portable
// while giving every documentary producer one output structure.
//
// What each fact becomes:
//
//   diagram_relation  an assertion whose subject is a RELATION between two unresolved endpoints,
//                     with the author's own edge label as the predicate. The label is not mapped
//                     onto the code vocabulary: a document saying "publishes" and a producer
//                     emitting publishes_envelope agreeing is a finding, and collapsing them
//                     beforehand destroys it.
//   diagram           an assertion whose subject is the drawing itself — an unresolved reference
//                     to its own fence address. The drawing existing is the fact that never
//                     depends on grounding anything inside it.
//
// Every assertion cites the section it was read from when the document has one, so it survives
// the line numbers moving.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssertion, relationSubject, unresolvedSubject } from './assertion.mjs';

export const DOCUMENTED_ASSERTION_RUN_SCHEMA = 'estate-map/documented-assertion-run/v1';

/** Index sections deepest-first so a line resolves to the most specific section containing it. */
export function sectionIndex(facts) {
  return facts.filter(fact => fact.kind === 'document_section')
    .slice()
    .sort((left, right) => right.section_depth - left.section_depth);
}

export function sectionAt(index, document, line) {
  return (index.get(document) ?? [])
    .find(row => line >= row.line && line <= row.line_end)?.section_path ?? null;
}

function natureOf(fact, producer, modality = 'descriptive') {
  return {
    producer,
    modality,
    document_mode: fact.document_mode ?? null,
    adjudication_frame: fact.adjudication_frame ?? null,
    archived: fact.document_archived ?? null,
  };
}

/** Build assertions for every documentary fact in an extractor stream. */
export function documentedAssertions(facts) {
  const sections = new Map();
  for (const fact of facts) {
    if (fact.kind !== 'document_section') continue;
    if (!sections.has(fact.file)) sections.set(fact.file, []);
    sections.get(fact.file).push(fact);
  }
  for (const [file, rows] of sections) sections.set(file, sectionIndex(rows));

  const assertions = [];
  for (const fact of facts) {
    if (fact.kind === 'diagram_relation') {
      assertions.push(buildAssertion({
        subject: relationSubject({
          from: unresolvedSubject({ text: fact.from_identifier, scope: fact.diagram_address }),
          // The author's own word when they wrote one; the arrow itself when they did not.
          predicate: fact.relation_label || fact.arrow,
          to: unresolvedSubject({ text: fact.to_identifier, scope: fact.diagram_address }),
        }),
        source: { document: fact.file, line: fact.line,
          section_path: sectionAt(sections, fact.file, fact.line), quote: null },
        nature: natureOf(fact, 'diagrams'),
        evidence: { diagram_address: fact.diagram_address, diagram_shape: fact.diagram_shape,
          diagram_syntax: fact.diagram_syntax, arrow: fact.arrow },
      }));
      continue;
    }
    if (fact.kind === 'diagram') {
      assertions.push(buildAssertion({
        subject: unresolvedSubject({ text: fact.diagram_address, scope: fact.file }),
        source: { document: fact.file, line: fact.line,
          section_path: sectionAt(sections, fact.file, fact.line), quote: null },
        nature: natureOf(fact, 'diagrams'),
        evidence: { diagram_shape: fact.diagram_shape, diagram_syntax: fact.diagram_syntax,
          line_end: fact.line_end, line_count: fact.line_count },
      }));
    }
  }
  const byFrame = {}; const byProducer = {};
  for (const assertion of assertions) {
    const frame = assertion.nature.adjudication_frame ?? 'unknown';
    byFrame[frame] = (byFrame[frame] || 0) + 1;
    byProducer[assertion.nature.producer] = (byProducer[assertion.nature.producer] || 0) + 1;
  }
  return Object.freeze({
    schema: DOCUMENTED_ASSERTION_RUN_SCHEMA,
    assertions,
    counts: {
      total: assertions.length,
      // How much of what documents assert could be refuted at all, and where.
      by_adjudication_frame: byFrame,
      by_producer: byProducer,
      with_section: assertions.filter(assertion => assertion.source.section_path).length,
      unresolved_subjects: assertions.filter(assertion =>
        assertion.subject.kind === 'unresolved'
        || assertion.subject.from?.kind === 'unresolved'
        || assertion.subject.to?.kind === 'unresolved').length,
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: documented-assertions <facts.jsonl> [output.jsonl]');
    process.exitCode = 1;
  } else {
    const facts = readFileSync(resolve(input), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    const held = documentedAssertions(facts);
    if (output) {
      writeFileSync(resolve(output), held.assertions.map(assertion => JSON.stringify(assertion)).join('\n') + '\n');
    }
    console.log(JSON.stringify(held.counts, null, 2));
  }
}
