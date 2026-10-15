#!/usr/bin/env node
// Evidence-backed entity resolution with explicit non-merge constraints.
//
// Two mentions collapse into one entity only where a producer found them equivalent — never
// because their surfaces look alike, and never because collapsing would make the graph smaller.
// Compression is a consequence of resolution, not a reason for it: a merge that shortens the
// description while joining two different things has destroyed the map's only real guarantee.
//
// The mechanism is a union-find over mention keys, driven by equivalence evidence and constrained
// by its opposite. A producer that reports two mentions as ambiguously referring — the same words
// naming different things — writes a non-merge constraint, and transitive union must respect it:
// when merging two groups would place a forbidden pair in one entity, the union is refused and the
// refusal is recorded with the pair and the evidence that would have caused it. A refusal is a
// finding, not an error; it says the corpus disagrees with itself about what a name means.
//
// The result reports both directions, because either alone can be gamed: merges made, and merges
// refused. A resolver that quietly drops its constraints scores well on the first number only.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib.mjs';

export const ENTITY_RESOLUTION_SCHEMA = 'estate-map/entity-resolution/v1';
const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** A mention's identity key: its declared type and its surface, normalized only for whitespace. */
export function mentionKey({ type, name }) {
  const held = clean(name).toLowerCase().replace(/\s+/gu, ' ');
  // A separator that cannot occur in a type or a surface, so two mentions collide only when
  // both halves match exactly.
  return `${clean(type).toLowerCase() || 'concept'}\u0000${held}`;
}

const pairKey = (left, right) => canonical([left, right].sort(compare));

class UnionFind {
  constructor(keys) { this.parent = new Map([...keys].map(key => [key, key])); }

  find(key) {
    const parent = this.parent.get(key);
    if (parent === undefined) { this.parent.set(key, key); return key; }
    if (parent !== key) this.parent.set(key, this.find(parent));
    return this.parent.get(key);
  }

  members(root) {
    return [...this.parent.keys()].filter(key => this.find(key) === root);
  }

  union(left, right) {
    const a = this.find(left); const b = this.find(right);
    if (a === b) return;
    // Deterministic orientation: the lexically smaller root always wins, so the same inputs
    // produce the same canonical entity whatever order the evidence arrived in.
    this.parent.set(a < b ? b : a, a < b ? a : b);
  }
}

/**
 * @param {{mentions: {key: string, type?: string, name: string}[],
 *          equivalences: {left: string, right: string, evidence?: unknown}[],
 *          non_merges: {left: string, right: string, reason?: string}[]}} input
 */
export function resolveEntities({ mentions, equivalences = [], non_merges: nonMerges = [] }) {
  const infoByKey = new Map();
  for (const mention of mentions) {
    const key = mention.key ?? mentionKey(mention);
    if (!infoByKey.has(key)) infoByKey.set(key, { key, name: clean(mention.name), type: clean(mention.type) || 'concept' });
  }
  const forbidden = new Set();
  for (const constraint of nonMerges) {
    if (constraint.left === constraint.right) continue;
    forbidden.add(pairKey(constraint.left, constraint.right));
  }
  const union = new UnionFind(infoByKey.keys());
  const refusals = [];
  // Evidence is applied in a canonical order so a refusal is a property of the corpus, not of the
  // order a caller happened to supply. Which specific union gets refused when two conflict is
  // otherwise arbitrary, and an arbitrary refusal is not reproducible.
  const ordered = [...equivalences].sort((left, right) =>
    compare(pairKey(left.left, left.right), pairKey(right.left, right.right)));
  for (const equivalence of ordered) {
    const { left, right } = equivalence;
    if (!infoByKey.has(left) || !infoByKey.has(right)) {
      refusals.push({ code: 'UNKNOWN_MENTION', left, right, evidence: equivalence.evidence ?? null });
      continue;
    }
    const leftRoot = union.find(left); const rightRoot = union.find(right);
    if (leftRoot === rightRoot) continue;
    const leftMembers = union.members(leftRoot); const rightMembers = union.members(rightRoot);
    const violated = leftMembers.flatMap(a => rightMembers.map(b => [a, b]))
      .find(([a, b]) => forbidden.has(pairKey(a, b)));
    if (violated) {
      refusals.push({ code: 'NON_MERGE_CONSTRAINT', left, right,
        violates: { left: violated[0], right: violated[1] }, evidence: equivalence.evidence ?? null });
      continue;
    }
    union.union(left, right);
  }
  const groups = new Map();
  for (const key of infoByKey.keys()) {
    const root = union.find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(key);
  }
  const entities = [...groups.values()]
    .map(keys => keys.sort(compare))
    .sort((left, right) => compare(left[0], right[0]))
    .map(keys => {
      const canonicalMention = infoByKey.get(keys[0]);
      return Object.freeze({
        entity_id: `entity:${sha256(keys[0])}`,
        name: canonicalMention.name,
        type: canonicalMention.type,
        mention_keys: keys,
        aliases: [...new Set(keys.map(key => infoByKey.get(key).name))].sort(compare),
      });
    });
  const merged = entities.filter(entity => entity.mention_keys.length > 1);
  return Object.freeze({
    schema: ENTITY_RESOLUTION_SCHEMA,
    rule: 'union only on producer equivalence evidence, constrained by recorded non-merge pairs; refusals are findings',
    mentions: infoByKey.size,
    entities,
    // Both directions, always together: a resolver that drops its constraints improves the first
    // number and empties the second.
    merges: merged.length,
    mentions_merged: merged.reduce((total, entity) => total + entity.mention_keys.length, 0),
    refusals: refusals.sort((left, right) => compare(canonical(left), canonical(right))),
    non_merge_constraints: [...forbidden].sort(compare).map(key => {
      const [left, right] = JSON.parse(key);
      return { left, right };
    }),
  });
}

/**
 * What a corpus says IS true against what it says SHOULD be true, as a set difference over edges.
 *
 * A claim's modality already separates description from prescription; comparing the two graphs
 * built from the same corpus turns that into an answer to a question nobody could ask before:
 * where does the estate's own documentation describe something it never prescribed, and where
 * does it prescribe something it never describes? Neither list is an error — a descriptive-only
 * edge may be undocumented intent, a normative-only edge may be unbuilt intent — but both are
 * findings, and the aligned set is the part of the documentation that agrees with itself.
 */
export function modalityDiff({ descriptive = [], normative = [] }) {
  const signature = edge => canonical({ source: edge.source, predicate: edge.predicate,
    target: edge.target, polarity: edge.polarity ?? null });
  const descriptiveByKey = new Map(descriptive.map(edge => [signature(edge), edge]));
  const normativeByKey = new Map(normative.map(edge => [signature(edge), edge]));
  const keys = store => [...store.keys()].sort(compare);
  return Object.freeze({
    schema: 'estate-map/modality-diff/v1',
    aligned: keys(descriptiveByKey).filter(key => normativeByKey.has(key)),
    descriptive_only: keys(descriptiveByKey).filter(key => !normativeByKey.has(key)),
    normative_only: keys(normativeByKey).filter(key => !descriptiveByKey.has(key)),
    counts: {
      descriptive: descriptiveByKey.size,
      normative: normativeByKey.size,
      aligned: keys(descriptiveByKey).filter(key => normativeByKey.has(key)).length,
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('usage: entity-resolution <input.json> [output.json]');
    process.exitCode = 1;
  } else {
    const held = resolveEntities(JSON.parse(readFileSync(resolve(input), 'utf8')));
    const { entities: _entities, ...summary } = held;
    if (output) writeFileSync(resolve(output), `${JSON.stringify(held, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  }
}
