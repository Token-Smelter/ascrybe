import test from 'node:test';
import assert from 'node:assert/strict';
import { Neo4jHttpClient } from '../tools/c3-serving-projection.mjs';
import {
  stageInterpretation, promoteInterpretation, pruneInterpretations, teardownInterpretation, SidecarStoreError,
} from '../tools/ontology/sidecar-store.mjs';

// Every retry test uses a near-zero delay so the suite stays fast; queryWithRetry's own default
// (2s, doubling per attempt) is what a real caller gets, not what these tests wait for.
const FAST_RETRY = { max_attempts: 3, retry_delay_ms: 1 };

// Every name below is invented (an example widget-tracking estate); nothing here describes a
// mapped repository (AGENTS.md / docs/before-a-pr.md).
function fakeClient() {
  return new Neo4jHttpClient({ uri: 'http://127.0.0.1:9999', username: 'neo4j', password: 'held' });
}

function generation({ interpretationId = 'estate-interpretation:aaa', baseProjectionId = 'estate-projection:widgets' } = {}) {
  return Object.freeze({
    interpretation_id: interpretationId,
    interpretation_version: 'ontology-interpretation@1',
    base: { evidence_context_id: 'evidence-context:widgets', projection_id: baseProjectionId, projection_content_digest: 'c'.repeat(64) },
    contracts: {
      concept_registry_digest: 'r'.repeat(64), ontology_policy_digest: 'p'.repeat(64),
      membership_evaluator_digest: 'e'.repeat(64), generalization_evaluator_digest: null,
      accepted_decision_set_digest: 'd'.repeat(64),
    },
    artifacts: { concepts_digest: 'x'.repeat(64), memberships_digest: 'y'.repeat(64),
      relations_digest: 'z'.repeat(64), generalizations_digest: 'g'.repeat(64), refusals_digest: 'f'.repeat(64) },
    counts: { concept_versions: 1, memberships_member: 1, memberships_not_member: 0, memberships_abstain: 0,
      relation_assertions: 0, generalizations: 0, counterexamples: 0, refusals: 0 },
    content_digest: 'h'.repeat(64),
  });
}

function membership(overrides = {}) {
  return {
    membership_id: 'ontology-membership:widget-1', concept_id: 'ontology-concept:ascrybe:AR-0001',
    concept_version_id: 'ontology-concept-version:v1',
    subject_ref: { projection_id: 'estate-projection:widgets', node_id: 'referent:namespace:widget-router', record_digest: 'd'.repeat(64) },
    outcome: 'member', method: 'deterministic_rule', confidence: 'certain',
    evaluation: { evaluator: 'x', rule_digest: 'y', result: 'matched', reason_code: null, trace: [] },
    witnesses: [{ kind: 'projected_edge', edge_id: 'e1' }],
    witness_provenance_summary: { production: 1, test: 0, fixture: 0, docs: 0 },
    defeaters: [],
    ...overrides,
  };
}

test('stageInterpretation refuses a working-head compare-and-swap collision', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('UNWIND [$selected_slot')) {
      return [
        ['estate-projection:widgets:selected', null, null, null, null, null, null, null, null],
        ['estate-projection:widgets:working', null, null, null, null, null, null, null, null],
      ];
    }
    if (statement.includes('MERGE (h:InterpretationHead {slot: $working_slot')) {
      // Someone else's working head is already 'estate-interpretation:someone-else', not what
      // startWorkingInterpretation expected (null) -- the CAS predicate excludes this row.
      return [];
    }
    return [];
  };
  await assert.rejects(
    () => stageInterpretation({ client, generation: generation(), memberships: [membership()] }),
    error => error instanceof SidecarStoreError && error.code === 'SIDECAR_WORKING_HEAD_COMPARE_AND_SWAP_FAILED',
  );
});

test('stageInterpretation recognizes an already-selected identical generation instead of rewriting it', async () => {
  const gen = generation();
  const statements = [];
  const client = fakeClient();
  client.query = async statement => {
    statements.push(statement);
    if (statement.includes('UNWIND [$selected_slot')) {
      return [
        [`${gen.base.projection_id}:selected`, gen.interpretation_id, 'selected', gen.base.projection_id,
          gen.base.evidence_context_id, gen.contracts.ontology_policy_digest, gen.content_digest, 1, 1],
        [`${gen.base.projection_id}:working`, null, null, null, null, null, null, null, null],
      ];
    }
    return [];
  };
  const staged = await stageInterpretation({ client, generation: gen, memberships: [membership()] });
  assert.deepEqual({
    status: staged.status,
    wroteMemberships: statements.some(statement => statement.includes('MERGE (m:OntologyMembership')),
  }, { status: 'already_selected', wroteMemberships: false });
});

test('stageInterpretation writes batches, tracks progress, verifies, and marks ready', async () => {
  const gen = generation();
  const memberships = [membership(), membership({ membership_id: 'ontology-membership:widget-2' })];
  const client = fakeClient();
  const writtenBatches = [];
  let processedSet = 0;
  client.query = async (statement, parameters) => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      [`${gen.base.projection_id}:selected`, null, null, null, null, null, null, null, null],
      [`${gen.base.projection_id}:working`, null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MERGE (h:InterpretationHead {slot: $working_slot')) {
      return [[1, gen.interpretation_id]];
    }
    if (statement.includes('MERGE (m:OntologyMembership')) { writtenBatches.push(parameters.rows.length); return []; }
    if (statement.includes('SET g.processed_memberships = $processed')) { processedSet = parameters.processed; return []; }
    if (statement.includes('WHERE m.membership_id > $after')) {
      // Verification: return the two staged rows in order, then nothing further.
      if (!parameters.after) return memberships.map(m => [m.membership_id, m.membership_id]);
      return [];
    }
    if (statement.includes("SET g.status = 'ready'")) return [[gen.interpretation_id, gen.content_digest]];
    return [];
  };
  const staged = await stageInterpretation({ client, generation: gen, memberships, batch_size: 1 });
  assert.deepEqual({ status: staged.status, processed: staged.processed_memberships, batches: writtenBatches, tracked: processedSet },
    { status: 'ready', processed: 2, batches: [1, 1], tracked: 2 });
});

test('stageInterpretation marks the generation failed and rethrows when a write fails', async () => {
  const gen = generation();
  const client = fakeClient();
  let markedFailed = false;
  client.query = async statement => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      [`${gen.base.projection_id}:selected`, null, null, null, null, null, null, null, null],
      [`${gen.base.projection_id}:working`, null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MERGE (h:InterpretationHead {slot: $working_slot')) return [[1, gen.interpretation_id]];
    if (statement.includes('MERGE (m:OntologyMembership')) throw new Error('simulated write failure');
    if (statement.includes("SET g.status = 'failed'")) { markedFailed = true; return []; }
    return [];
  };
  await assert.rejects(() => stageInterpretation({ client, generation: gen, memberships: [membership()] }), /simulated write failure/u);
  assert.equal(markedFailed, true);
});

test('promoteInterpretation refuses when the interpretation is not staged at all', async () => {
  const client = fakeClient();
  client.query = async () => [];
  await assert.rejects(
    () => promoteInterpretation({ client, interpretation_id: 'estate-interpretation:missing' }),
    error => error instanceof SidecarStoreError && error.code === 'SIDECAR_GENERATION_MISSING',
  );
});

test('promoteInterpretation refuses a selected-head compare-and-swap collision', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('RETURN g.base_projection_id')) return [['estate-projection:widgets']];
    return [];
  };
  client.begin = async () => 'tx-1';
  client.commit = async () => [{ data: [{ row: [] }] }]; // CAS predicate excluded every row
  client.rollback = async () => {};
  await assert.rejects(
    () => promoteInterpretation({ client, interpretation_id: 'estate-interpretation:aaa' }),
    error => error instanceof SidecarStoreError && error.code === 'SIDECAR_SELECTED_HEAD_COMPARE_AND_SWAP_FAILED',
  );
});

test('promoteInterpretation accepts a ready OR a superseded candidate, so rollback is the same compare-and-set', async () => {
  const client = fakeClient();
  const committedStatements = [];
  client.query = async statement => {
    if (statement.includes('RETURN g.base_projection_id')) return [['estate-projection:widgets']];
    return [];
  };
  client.begin = async () => 'tx-1';
  client.commit = async (transaction, statements) => {
    committedStatements.push(...statements);
    return [{ data: [{ row: ['estate-interpretation:older', 'h'.repeat(64)] }] }];
  };
  const result = await promoteInterpretation({ client, interpretation_id: 'estate-interpretation:older' });
  assert.equal(result.status, 'selected');
  assert.match(committedStatements[0].statement, /status IN \['ready', 'superseded'\]/u);
});

test('pruneInterpretations refuses when neither head is set, and protects every head across every base projection', async () => {
  const client = fakeClient();
  client.query = async () => [[null, null, null, null, null, null, null, null, null], [null, null, null, null, null, null, null, null, null]];
  await assert.rejects(
    () => pruneInterpretations({ client, base_projection_id: 'estate-projection:widgets' }),
    error => error instanceof SidecarStoreError && error.code === 'SIDECAR_RETENTION_UNSAFE',
  );
});

test('pruneInterpretations keeps the retained ancestor count and reports what it removed', async () => {
  const client = fakeClient();
  let deleteCalls = 0;
  client.query = async (statement, parameters) => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      ['estate-projection:widgets:selected', 'estate-interpretation:current', 'selected', 'estate-projection:widgets', null, null, null, 1, 1],
      ['estate-projection:widgets:working', null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MATCH (h:InterpretationHead) WHERE')) return [['estate-interpretation:current'], ['estate-interpretation:other-estate-head']];
    if (statement.includes('MATCH (g:InterpretationGeneration {base_projection_id:')) {
      // Real Neo4j applies `WHERE NOT g.interpretation_id IN $protected` server-side, so
      // 'current' (protected -- it is the selected head) never appears in this candidate list.
      return [
        ['estate-interpretation:mid', 'superseded', '2'],
        ['estate-interpretation:old', 'superseded', '1'],
      ];
    }
    if (statement.includes('DETACH DELETE m')) {
      deleteCalls += 1;
      return deleteCalls === 1 ? [[5]] : [[0]]; // one batch of 5, then empty -- loop stops
    }
    if (statement.includes('DELETE g RETURN count(g)')) return [[1]];
    return [];
  };
  const result = await pruneInterpretations({ client, base_projection_id: 'estate-projection:widgets', retain_superseded: 1 });
  assert.deepEqual({
    retained: result.retained, pruned: result.pruned_interpretation_ids,
    removedMemberships: result.removed_memberships, removedGenerations: result.removed_generations,
  }, {
    retained: ['estate-interpretation:current', 'estate-interpretation:mid'],
    pruned: ['estate-interpretation:old'],
    removedMemberships: 5, removedGenerations: 1,
  });
});

// Injected slow/failing client tests (operator instruction, 2026-09-26, after a real 30s client
// timeout during teardown): a stateful fake that actually removes rows from an in-memory store on
// a "successful" call, so a test can simulate the real incident precisely -- the SERVER may have
// completed a delete even though the CLIENT saw the request fail, and retrying must never act as
// though those rows are still there.
function statefulMembershipStore(total) {
  let remaining = total;
  return {
    remaining: () => remaining,
    deleteBatch(batch) {
      const count = Math.min(batch, remaining);
      remaining -= count;
      return count;
    },
  };
}

test('teardownInterpretation retries a transient failure and does not double-count what the server already deleted', async () => {
  const client = fakeClient();
  const store = statefulMembershipStore(25);
  let queryCount = 0;
  let failedOnce = false;
  client.query = async (statement, parameters) => {
    queryCount += 1;
    if (statement.includes('DETACH DELETE m')) {
      // The FIRST membership-delete call: the server actually deletes the batch (store.deleteBatch
      // runs), but the client is made to see a failure -- exactly the real incident's shape.
      const count = store.deleteBatch(parameters.batch);
      if (!failedOnce) { failedOnce = true; throw new Error('simulated lost response'); }
      return [[count]];
    }
    if (statement.includes('RETURN g.base_projection_id')) return [['estate-projection:widgets']];
    if (statement.includes('MATCH (h:InterpretationHead')) return [[0]];
    if (statement.includes('DELETE g RETURN count(g)')) return [[1]];
    return [[0]];
  };
  const result = await teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa', batch_size: 10, ...FAST_RETRY });
  // The lost attempt did real server-side work (store.deleteBatch ran) before the client saw a
  // failure -- a retried call can only report what its OWN successful attempts returned, so the
  // authoritative invariant is convergence (nothing left, no crash), not an exact reported total.
  assert.equal(store.remaining(), 0, 'every row is actually gone, including the ones the lost response never confirmed');
  assert.ok(result.removed_memberships > 0 && result.removed_memberships <= 25);
  assert.equal(result.removed_generation, true);
});

test('teardownInterpretation gives up with a typed error after exhausting retries against a permanently failing client', async () => {
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('DETACH DELETE m')) throw new Error('permanently unreachable');
    return [[0]];
  };
  await assert.rejects(
    () => teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa', batch_size: 10, ...FAST_RETRY }),
    error => error instanceof SidecarStoreError && error.code === 'SIDECAR_QUERY_RETRY_EXHAUSTED'
      && error.detail.last_error_message === 'permanently unreachable',
  );
});

test('teardownInterpretation is resumable: calling it again after a simulated crash continues from what remains, without double-counting', async () => {
  // Simulates a process-level crash: the FIRST "run" deleted some rows then the process died
  // (nothing more happens -- there is no retry, no continuation, just a store left partially done).
  const store = statefulMembershipStore(30);
  store.deleteBatch(10); // stands in for a prior, now-dead process's partial progress
  const client = fakeClient();
  client.query = async (statement, parameters) => {
    if (statement.includes('DETACH DELETE m')) return [[store.deleteBatch(parameters.batch)]];
    if (statement.includes('RETURN g.base_projection_id')) return [['estate-projection:widgets']];
    if (statement.includes('MATCH (h:InterpretationHead')) return [[0]];
    if (statement.includes('DELETE g RETURN count(g)')) return [[1]];
    return [[0]];
  };
  // A fresh call to teardownInterpretation with the SAME arguments -- no resume state passed, none
  // needed -- correctly reports only the 20 rows that were actually still there to delete.
  const result = await teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa', batch_size: 10, ...FAST_RETRY });
  assert.equal(result.removed_memberships, 20, 'reports exactly what remained, not the original total');
  assert.equal(store.remaining(), 0);
});

test('teardownInterpretation clears whichever head (selected, working, or both) currently points at it', async () => {
  const client = fakeClient();
  const clearedSlots = [];
  client.query = async (statement, parameters) => {
    if (statement.includes('DETACH DELETE m')) return [[0]];
    if (statement.includes('RETURN g.base_projection_id')) return [['estate-projection:widgets']];
    if (statement.includes('MATCH (h:InterpretationHead')) { clearedSlots.push(parameters.interpretation_id); return [[2]]; }
    if (statement.includes('DELETE g RETURN count(g)')) return [[1]];
    return [[0]];
  };
  const result = await teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa' });
  assert.equal(result.cleared_heads, 2);
  assert.deepEqual(clearedSlots, ['estate-interpretation:aaa']);
});

test('teardownInterpretation refuses a missing interpretation_id and an out-of-range batch size', async () => {
  const client = fakeClient();
  await assert.rejects(() => teardownInterpretation({ client, interpretation_id: '' }), SidecarStoreError);
  await assert.rejects(() => teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa', batch_size: 0 }), SidecarStoreError);
  await assert.rejects(() => teardownInterpretation({ client, interpretation_id: 'estate-interpretation:aaa', batch_size: 20_001 }), SidecarStoreError);
});

test('pruneInterpretations retries a transient membership-delete failure instead of aborting the whole prune', async () => {
  const client = fakeClient();
  const store = statefulMembershipStore(12);
  let failedOnce = false;
  client.query = async (statement, parameters) => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      ['estate-projection:widgets:selected', 'estate-interpretation:current', 'selected', 'estate-projection:widgets', null, null, null, 1, 1],
      ['estate-projection:widgets:working', null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MATCH (h:InterpretationHead) WHERE')) return [['estate-interpretation:current']];
    if (statement.includes('MATCH (g:InterpretationGeneration {base_projection_id:')) return [['estate-interpretation:old', 'superseded', '1']];
    if (statement.includes('DETACH DELETE m')) {
      const count = store.deleteBatch(parameters.batch);
      if (!failedOnce) { failedOnce = true; throw new Error('simulated lost response'); }
      return [[count]];
    }
    if (statement.includes('DELETE g RETURN count(g)')) return [[1]];
    return [[0]];
  };
  const result = await pruneInterpretations({ client, base_projection_id: 'estate-projection:widgets', retain_superseded: 0, batch_size: 5, ...FAST_RETRY });
  assert.equal(store.remaining(), 0, 'every row is actually gone, including the ones the lost response never confirmed');
  assert.ok(result.removed_memberships > 0 && result.removed_memberships <= 12);
});

test('stageInterpretation reports non-negative peak memory on success', async () => {
  const gen = generation();
  const client = fakeClient();
  client.query = async (statement, parameters) => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      [`${gen.base.projection_id}:selected`, null, null, null, null, null, null, null, null],
      [`${gen.base.projection_id}:working`, null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MERGE (h:InterpretationHead {slot: $working_slot')) return [[1, gen.interpretation_id]];
    if (statement.includes('MERGE (m:OntologyMembership')) return [];
    if (statement.includes('WHERE m.membership_id > $after')) {
      if (!parameters.after) return [[membership().membership_id, membership().membership_id]];
      return [];
    }
    if (statement.includes("SET g.status = 'ready'")) return [[gen.interpretation_id, gen.content_digest]];
    return [];
  };
  const staged = await stageInterpretation({ client, generation: gen, memberships: [membership()] });
  assert.ok(Number.isFinite(staged.peak_rss_mb) && staged.peak_rss_mb > 0);
  assert.ok(Number.isFinite(staged.peak_heap_used_mb) && staged.peak_heap_used_mb > 0);
});

test('stageInterpretation attaches peak memory to the thrown error on failure, not only to a success result', async () => {
  const gen = generation();
  const client = fakeClient();
  client.query = async statement => {
    if (statement.includes('UNWIND [$selected_slot')) return [
      [`${gen.base.projection_id}:selected`, null, null, null, null, null, null, null, null],
      [`${gen.base.projection_id}:working`, null, null, null, null, null, null, null, null],
    ];
    if (statement.includes('MERGE (h:InterpretationHead {slot: $working_slot')) return [[1, gen.interpretation_id]];
    if (statement.includes('MERGE (m:OntologyMembership')) throw new Error('simulated write failure');
    return [];
  };
  await assert.rejects(
    () => stageInterpretation({ client, generation: gen, memberships: [membership()] }),
    error => Number.isFinite(error.peak_rss_mb) && error.peak_rss_mb > 0,
  );
});
