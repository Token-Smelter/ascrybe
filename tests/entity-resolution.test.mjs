import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionKey, modalityDiff, resolveEntities } from '../tools/entity-resolution.mjs';

const mention = (type, name) => ({ key: mentionKey({ type, name }), type, name });
const key = (type, name) => mentionKey({ type, name });

test('mentions merge only on equivalence evidence, never on surface similarity', () => {
  const held = resolveEntities({
    mentions: [mention('table', 'revenue daily'), mention('table', 'revenue_daily'), mention('table', 'revenue monthly')],
    equivalences: [{ left: key('table', 'revenue daily'), right: key('table', 'revenue_daily'), evidence: { claim: 'c1' } }],
  });
  assert.deepEqual({
    entities: held.entities.map(entity => entity.aliases),
    merges: held.merges,
    // The similar-looking third surface stays separate: nothing said it was the same thing.
    refusals: held.refusals,
  }, {
    entities: [['revenue daily', 'revenue_daily'], ['revenue monthly']],
    merges: 1,
    refusals: [],
  });
});

test('a non-merge constraint blocks transitive union and the refusal is recorded, not silent', () => {
  const held = resolveEntities({
    mentions: [mention('service', 'billing'), mention('service', 'billing service'), mention('service', 'billing api')],
    equivalences: [
      { left: key('service', 'billing'), right: key('service', 'billing service'), evidence: { claim: 'c1' } },
      { left: key('service', 'billing service'), right: key('service', 'billing api'), evidence: { claim: 'c2' } },
    ],
    // The corpus says these two name different things, so no chain of equivalences may join them.
    non_merges: [{ left: key('service', 'billing'), right: key('service', 'billing api'), reason: 'referent_ambiguity' }],
  });
  const entityOf = name => held.entities.find(entity => entity.mention_keys.includes(key('service', name)));
  assert.deepEqual({
    // The invariant, whichever of the two conflicting unions the canonical order applies first:
    // the forbidden pair never shares an entity, and exactly one union is refused.
    forbiddenSeparated: entityOf('billing').entity_id !== entityOf('billing api').entity_id,
    entitySizes: held.entities.map(entity => entity.mention_keys.length).sort(),
    refusalCodes: held.refusals.map(row => row.code),
    // The refusal names the constraint it would have violated and the evidence that proposed it.
    violatesForbiddenPair: held.refusals[0].violates.left === key('service', 'billing')
      || held.refusals[0].violates.right === key('service', 'billing'),
    evidenceKept: Boolean(held.refusals[0].evidence?.claim),
  }, {
    forbiddenSeparated: true,
    entitySizes: [1, 2],
    refusalCodes: ['NON_MERGE_CONSTRAINT'],
    violatesForbiddenPair: true,
    evidenceKept: true,
  });
});

test('resolution is deterministic under reordering, and reports both merges and refusals', () => {
  const input = {
    mentions: [mention('module', 'a'), mention('module', 'b'), mention('module', 'c')],
    equivalences: [
      { left: key('module', 'b'), right: key('module', 'c') },
      { left: key('module', 'a'), right: key('module', 'b') },
    ],
    non_merges: [],
  };
  const forward = resolveEntities(input);
  const reversed = resolveEntities({ ...input, equivalences: [...input.equivalences].reverse() });
  assert.deepEqual(forward.entities, reversed.entities);
  assert.deepEqual([forward.merges, forward.mentions_merged, forward.entities[0].entity_id === reversed.entities[0].entity_id],
    [1, 3, true]);
  const unknown = resolveEntities({ mentions: [mention('module', 'a')], equivalences: [{ left: key('module', 'a'), right: key('module', 'ghost') }] });
  assert.deepEqual(unknown.refusals.map(row => row.code), ['UNKNOWN_MENTION']);
});

test('modality diff separates what the corpus describes from what it prescribes', () => {
  const edge = (source, predicate, target) => ({ source, predicate, target });
  const held = modalityDiff({
    descriptive: [edge('billing', 'calls', 'ledger'), edge('billing', 'writes', 'audit-log')],
    normative: [edge('billing', 'calls', 'ledger'), edge('billing', 'must-retry', 'ledger')],
  });
  assert.deepEqual({
    aligned: held.counts.aligned,
    // Described but never prescribed: real behaviour nobody wrote a rule for.
    describedOnly: held.descriptive_only.length,
    // Prescribed but never described: a rule nothing is documented as following.
    prescribedOnly: held.normative_only.length,
  }, { aligned: 1, describedOnly: 1, prescribedOnly: 1 });
});
