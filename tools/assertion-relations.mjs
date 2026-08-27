#!/usr/bin/env node
// Relations between assertions: what a corpus says about its own claims.
//
// Until now every edge in the documentary plane ran from a claim to its evidence or to a code
// fact. Nothing connected two claims, so a corpus could not be asked the questions that matter
// most about it: do these two documents say the same thing, do they contradict, has this design
// been superseded. Measured on a real claim map, 250,000 documentary edges contained exactly zero
// claim-to-claim relations.
//
// The assertion model already made this expressible — an assertion whose subject is a relation
// between two assertions needs no new structure. What was missing is a producer, and the reason
// to be careful about building one: the failure mode is asserting that two documents contradict
// when they merely differ in scope, which is worse than saying nothing. So this producer is
// deterministic, its rules are the ported comparison classifier's rules, and every relation it
// emits carries both assertions' verbatim text so a reader can check the call rather than trust it.
//
// Candidate pairs come from a bucket: two assertions are comparable only when they share a subject
// neighbourhood and a predicate family. Without that, every corpus becomes an O(n squared)
// comparison of unrelated sentences, and the classifier's own first rule — different bucket means
// incomparable — would reject nearly all of it anyway.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib.mjs';
import { assertionSubject, buildAssertion, relationSubject } from './assertion.mjs';

export const ASSERTION_RELATION_SCHEMA = 'estate-map/assertion-relation/v1';
const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Which relations this producer will emit. `incomparable` is the classifier's explicit
// fall-through and is counted rather than emitted: a pair with no comparison basis is not a
// finding, and recording one per unrelated pair would bury the findings that matter.
export const EMITTED_RELATIONS = Object.freeze([
  'equivalent_proposition', 'direct_conflict', 'modality_divergence', 'referent_ambiguity',
]);

// The same fold the documentary tiers use: split camelCase, then collapse case and the separator
// alphabet, so TaskOrch, task-orch, and "task orch" reach one key. Collapsing separators without
// splitting camelCase leaves TaskOrch as `taskorch` and "task orch" as `task orch` — two keys for
// one name, which silently makes every such pair incomparable.
const normalize = value => clean(value)
  .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .toLowerCase()
  .replace(/[\s_-]+/gu, '');

/**
 * A comparison bucket for an assertion. Two assertions are candidates only when these match, which
 * is what keeps the comparison from being every sentence against every other sentence.
 */
// A diagram-local identifier like A, R1, or P names nothing outside its own fence, so two
// diagrams both drawing `A --> B` are not talking about the same thing. Measured over a real
// corpus, comparing on such endpoints produced 5,444 relations of which the overwhelming majority
// were single-letter collisions between unrelated drawings — a producer that manufactures
// disagreements between documents that never discussed each other. An endpoint must be
// distinctive enough to name something before two assertions about it can be compared.
const DISTINCTIVE = /^[a-z][a-z0-9]{3,}$/u;
export function comparableEndpoint(value) {
  const key = normalize(value);
  return DISTINCTIVE.test(key) ? key : null;
}

export function assertionBucket(assertion) {
  const subject = assertion.subject;
  if (subject.kind !== 'relation') return null;
  const from = comparableEndpoint(subject.from.text ?? subject.from.id);
  const to = comparableEndpoint(subject.to.text ?? subject.to.id);
  // Not a refusal to record the assertion — only a refusal to claim it is comparable to another.
  if (!from || !to) return null;
  // The endpoints as written, folded — never resolved, since resolution is a later receipted step
  // and two assertions about the same words are comparable whether or not anyone grounded them.
  return canonical({ from, to });
}

const NEGATIONS = /\b(not|never|no longer|cannot|must not|does not|doesn't|isn't|won't)\b/iu;

/** Affirmed or negated, read from the predicate the author wrote. */
export function predicatePolarity(predicate) {
  return NEGATIONS.test(String(predicate ?? '')) ? 'negated' : 'affirmed';
}

/**
 * Classify one candidate pair. Deterministic, and every branch names the rule it applied so a
 * disagreement is with a stated rule rather than with a judgement nobody can inspect.
 */
export function classifyAssertionPair(left, right) {
  const leftPredicate = normalize(left.subject.predicate);
  const rightPredicate = normalize(right.subject.predicate);
  const leftPolarity = predicatePolarity(left.subject.predicate);
  const rightPolarity = predicatePolarity(right.subject.predicate);

  if (leftPolarity !== rightPolarity) {
    return { relation: 'direct_conflict',
      rule: 'same endpoints, opposed polarity: one says the relation holds and the other that it does not' };
  }
  if (leftPredicate === rightPredicate) {
    // The same relation stated twice. Different documents saying it is corroboration; the same
    // document saying it twice is repetition, and both are worth being able to ask about.
    return { relation: 'equivalent_proposition',
      rule: 'same endpoints, same predicate, same polarity' };
  }
  const modalities = new Set([left.nature.modality, right.nature.modality].filter(Boolean));
  if (modalities.has('normative') && modalities.has('descriptive')) {
    return { relation: 'modality_divergence',
      rule: 'same endpoints, one prescribes and the other describes: a requirement paired with a statement of fact' };
  }
  // One side labelled its edge and the other did not. A bare arrow says these things are related
  // without saying how, so it cannot disagree with a label — it is silent, not contradictory.
  // Measured on a real corpus this was the single largest source of claimed disagreements.
  const unlabelled = predicate => /^[-.=<>ox]+$/u.test(clean(predicate));
  if (unlabelled(left.subject.predicate) || unlabelled(right.subject.predicate)) {
    return { relation: 'compatible_partial',
      rule: 'same endpoints, one edge unlabelled: a bare arrow asserts the relation without characterizing it' };
  }
  // Same endpoints, different predicates, same polarity: the documents agree these things are
  // related and disagree about how. That is a referent question, not a contradiction.
  return { relation: 'referent_ambiguity',
    rule: 'same endpoints, different predicates: the corpus relates the same pair in incompatible terms' };
}

/**
 * Build relation assertions over a set of assertions. Returns the relations plus the counts that
 * make the producer auditable: how many pairs were compared, how many buckets had more than one
 * member, and how many candidate pairs produced nothing.
 */
export function assertionRelations(assertions, { max_bucket: maxBucket = 40 } = {}) {
  const buckets = new Map();
  for (const assertion of assertions) {
    const key = assertionBucket(assertion);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(assertion);
  }
  const relations = [];
  const skipped = [];
  let compared = 0;
  let multiMember = 0;
  for (const [key, members] of [...buckets].sort(([left], [right]) => compare(left, right))) {
    if (members.length < 2) continue;
    multiMember += 1;
    // A bucket with hundreds of members is a generic pair like A --> B appearing in every diagram
    // in the corpus; comparing all of them is quadratic and says nothing. The cap is disclosed,
    // never silent.
    if (members.length > maxBucket) {
      skipped.push({ bucket: key, members: members.length, reason: 'bucket exceeds the comparison cap' });
      continue;
    }
    const ordered = [...members].sort((left, right) => compare(left.assertion_id, right.assertion_id));
    for (let index = 0; index < ordered.length; index += 1) {
      for (let other = index + 1; other < ordered.length; other += 1) {
        compared += 1;
        const left = ordered[index]; const right = ordered[other];
        const held = classifyAssertionPair(left, right);
        if (!EMITTED_RELATIONS.includes(held.relation)) continue;
        relations.push(buildAssertion({
          subject: relationSubject({ from: assertionSubject(left.assertion_id),
            predicate: held.relation, to: assertionSubject(right.assertion_id) }),
          // A relation between two assertions is read from both, so its source is the document of
          // the first and its evidence carries the second. Neither claim is privileged; the
          // ordering is by assertion id so the record is reproducible.
          source: { document: left.source.document, line: left.source.line,
            section_path: left.source.section_path, quote: null },
          nature: { producer: 'assertion-relations', modality: 'descriptive',
            document_mode: left.nature.document_mode, adjudication_frame: 'corpus',
            archived: left.nature.archived },
          evidence: {
            rule: held.rule,
            // Both sides verbatim, so a reader can check the call rather than trust it.
            left: { assertion_id: left.assertion_id, document: left.source.document,
              line: left.source.line, predicate: left.subject.predicate,
              from: left.subject.from.text ?? left.subject.from.id, to: left.subject.to.text ?? left.subject.to.id },
            right: { assertion_id: right.assertion_id, document: right.source.document,
              line: right.source.line, predicate: right.subject.predicate,
              from: right.subject.from.text ?? right.subject.from.id, to: right.subject.to.text ?? right.subject.to.id },
            cross_document: left.source.document !== right.source.document,
          },
        }));
      }
    }
  }
  const byRelation = {};
  for (const relation of relations) {
    byRelation[relation.subject.predicate] = (byRelation[relation.subject.predicate] || 0) + 1;
  }
  return Object.freeze({
    schema: ASSERTION_RELATION_SCHEMA,
    relations,
    counts: {
      assertions: assertions.length,
      // Assertions whose endpoints are too generic to identify anything: recorded in the graph,
      // never compared. Reporting the number keeps the coverage gap visible.
      incomparable_assertions: assertions.filter(row => row.subject.kind === 'relation' && !assertionBucket(row)).length,
      buckets: buckets.size,
      comparable_buckets: multiMember,
      pairs_compared: compared,
      relations: relations.length,
      by_relation: byRelation,
      cross_document: relations.filter(relation => relation.evidence.cross_document).length,
      // Disclosed rather than silent: a capped bucket is a comparison nobody made.
      skipped_buckets: skipped,
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: assertion-relations <assertions.jsonl> [output.jsonl]');
    process.exitCode = 1;
  } else {
    const assertions = readFileSync(resolve(input), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    const held = assertionRelations(assertions);
    if (output) writeFileSync(resolve(output), held.relations.map(row => JSON.stringify(row)).join('\n') + '\n');
    console.log(JSON.stringify(held.counts, null, 2));
  }
}
