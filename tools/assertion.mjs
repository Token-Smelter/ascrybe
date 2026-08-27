#!/usr/bin/env node
// The assertion model: one structure for everything a document claims.
//
// Three trust axes were invented separately and never reconciled — `document_mode` (a property of
// the SOURCE), `assertion: documented` versus observation (a property of the PRODUCER), and claim
// `modality` descriptive/normative (a property of the CONTENT). They kept looking like competing
// answers to "how far should a reader trust this", which is why nothing unified them. They are
// orthogonal: a normative statement in a research note read from a drawn diagram has a value on
// all three at once, and none of them substitutes for another.
//
// So the map has two levels, and only the second needs trust axes at all.
//
//   Level 1, OBSERVATIONS. Entities and relations a producer witnessed at an exact location. The
//   witness is the warrant; there is nothing to qualify.
//
//   Level 2, ASSERTIONS about level 1. Every assertion carries a SUBJECT, a SOURCE, and a NATURE,
//   and the adjudication frame follows from the nature.
//
// Two properties make this general where the one-offs were not:
//
//   A subject may be a RELATION. `TaskOrch -->|publishes| Envelope` asserts something about a
//   relationship, not about either endpoint, and a model with only entity subjects has to either
//   drop it or flatten it into two unrelated statements. It may also be another ASSERTION, which
//   is what "this design supersedes that one" and "these two claims contradict" require — the
//   claim-to-claim layer needs no new structure, only a subject that points at an assertion.
//
//   A subject may be UNRESOLVED. A diagram drawing `R1 --> U` is a real assertion by a real
//   document about identifiers that ground to nothing yet; 78% of drawn identifiers in a measured
//   corpus are diagram-local shorthand. The assertion is well-formed regardless, and grounding
//   arrives later as a separate receipt-backed edge. It never rewrites the assertion: the verbatim
//   identifier stays forever, so a reader can always see what was actually written and decide for
//   itself whether to follow the resolution. An assertion that quietly became a different
//   assertion when someone guessed at its endpoints would be unauditable.
import { createHash } from 'node:crypto';
import { stableStringify } from './lib.mjs';

export const ASSERTION_SCHEMA = 'estate-map/assertion/v1';
const canonical = value => stableStringify(value).trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').trim();

// What an assertion is about. `entity` and `relation` name things the observation plane may hold;
// `assertion` points at another assertion; `unresolved` is a reference the producer could not
// ground and refused to guess at.
export const SUBJECT_KINDS = Object.freeze(['entity', 'relation', 'assertion', 'unresolved']);

/** A subject the observation plane holds by ID. */
export function entitySubject(id) {
  if (!clean(id)) throw new Error('entity subject requires an id');
  return Object.freeze({ kind: 'entity', id: clean(id) });
}

/**
 * A relationship as a subject. Endpoints are themselves subjects, so a drawn edge between two
 * ungrounded identifiers is expressible without inventing entities for them.
 */
export function relationSubject({ from, predicate, to }) {
  if (!from?.kind || !to?.kind) throw new Error('relation subject requires from and to subjects');
  if (!clean(predicate)) throw new Error('relation subject requires a predicate');
  return Object.freeze({ kind: 'relation', from, predicate: clean(predicate), to });
}

/** Another assertion as a subject: supersession, contradiction, refinement. */
export function assertionSubject(id) {
  if (!clean(id)) throw new Error('assertion subject requires an assertion id');
  return Object.freeze({ kind: 'assertion', id: clean(id) });
}

/**
 * A reference the producer could not ground. The verbatim text is the point: it is what the
 * document actually said, and it survives every later grounding attempt unchanged.
 */
export function unresolvedSubject({ text, scope = null }) {
  if (!clean(text)) throw new Error('unresolved subject requires the verbatim text');
  return Object.freeze({ kind: 'unresolved', text: clean(text), scope: scope ? clean(scope) : null });
}

function validSubject(subject, depth = 0) {
  if (depth > 8) throw new Error('subject nesting exceeds the addressable depth');
  if (!subject || !SUBJECT_KINDS.includes(subject.kind)) return false;
  if (subject.kind === 'relation') {
    return clean(subject.predicate) !== '' && validSubject(subject.from, depth + 1) && validSubject(subject.to, depth + 1);
  }
  if (subject.kind === 'unresolved') return clean(subject.text) !== '';
  return clean(subject.id) !== '';
}

/**
 * Build one assertion.
 *
 * @param {{subject: object, source: {document: string, line: number, section_path?: string|null,
 *          quote?: string|null}, nature: {producer: string, modality?: string|null,
 *          document_mode?: string|null, adjudication_frame?: string|null,
 *          archived?: boolean|null}, evidence?: object|null}} input
 */
export function buildAssertion({ subject, source, nature, evidence = null }) {
  if (!validSubject(subject)) throw new Error('assertion requires a valid subject');
  if (!clean(source?.document) || !Number.isInteger(source?.line) || source.line < 1) {
    throw new Error('assertion requires a source document and a positive integer line');
  }
  if (!clean(nature?.producer)) throw new Error('assertion requires the producer that read it');
  const body = {
    schema: ASSERTION_SCHEMA,
    subject,
    source: {
      document: clean(source.document),
      line: source.line,
      // Where in the author's own outline, so the assertion survives the line numbers moving.
      section_path: source.section_path ? clean(source.section_path) : null,
      quote: source.quote == null ? null : String(source.quote),
    },
    nature: {
      producer: clean(nature.producer),
      // What kind of statement it is, what kind of document said it, and therefore what could
      // refute it. All three, because none of them implies the others.
      modality: nature.modality ? clean(nature.modality) : null,
      document_mode: nature.document_mode ? clean(nature.document_mode) : null,
      adjudication_frame: nature.adjudication_frame ? clean(nature.adjudication_frame) : null,
      archived: nature.archived ?? null,
    },
    evidence,
  };
  return Object.freeze({ ...body, assertion_id: `assertion:${sha256(canonical(body))}` });
}

/**
 * Ground an unresolved reference WITHOUT touching the assertion that made it. The resolution is a
 * separate record carrying its own receipt, so an agent reading the graph sees both what the
 * document said and what someone later decided it meant, and can weigh them independently.
 */
export function groundSubject({ assertion_id: assertionId, path = [], resolved_to: resolvedTo, receipt }) {
  if (!clean(assertionId)) throw new Error('grounding requires the assertion it resolves');
  if (!clean(resolvedTo)) throw new Error('grounding requires the entity it resolved to');
  if (!clean(receipt?.producer) || !clean(receipt?.basis)) {
    throw new Error('grounding requires a receipt naming its producer and basis');
  }
  const body = {
    schema: 'estate-map/assertion-grounding/v1',
    assertion_id: clean(assertionId),
    // Which subject inside the assertion: [] is the subject itself, ['from'] its relation source.
    subject_path: [...path].map(clean),
    resolved_to: clean(resolvedTo),
    receipt: Object.freeze({ producer: clean(receipt.producer), basis: clean(receipt.basis),
      confidence: receipt.confidence ?? null, evidence: receipt.evidence ?? null }),
  };
  return Object.freeze({ ...body, grounding_id: `assertion-grounding:${sha256(canonical(body))}` });
}

/** Every unresolved reference in an assertion, with the path that addresses it. */
export function unresolvedReferences(assertion) {
  const found = [];
  const walk = (subject, path) => {
    if (!subject) return;
    if (subject.kind === 'unresolved') { found.push({ path, text: subject.text, scope: subject.scope }); return; }
    if (subject.kind === 'relation') { walk(subject.from, [...path, 'from']); walk(subject.to, [...path, 'to']); }
  };
  walk(assertion.subject, []);
  return found;
}
