// Sidecar staging, promotion and retention for an ontology interpretation generation -- design v2
// section 6: "A Neo4j sidecar generation is staged under its own labels (InterpretationGeneration,
// OntologyMembership, ...) keyed by interpretation_id and joined to EstateNode by (projection_id,
// node_id); a convenience interpreted_as edge may be projected but carries basis_membership_id and
// is never authoritative. Working/selected interpretation heads are per base projection; promotion
// is explicit and compare-and-set; rollback moves only the interpretation head. Retention must
// protect any base projection named by a retained or selected interpretation."
//
// Deliberately mirrors estate-graph-projection.mjs's stage/promote/prune CAS discipline (design v2
// section 12: "Reused unchanged: ... CAS head pattern") rather than inventing a second one: the
// same MERGE-with-expected-value compare-and-swap on the head node, the same bounded-batch write
// with a processed-count checkpoint on the generation node, the same byte-exact post-write
// verification, the same head/generation split. Everything specific to THIS domain -- what a
// membership carries, that the head key is a base projection id rather than an estate name, that
// promotion accepts a superseded generation (rollback) as well as a ready one -- is called out
// where it diverges.
import { Neo4jHttpClient } from '../c3-serving-projection.mjs';
import { interpretationSlot, readInterpretationHeads } from './sidecar-heads.mjs';
import { canonical } from './schemas.mjs';

const clean = value => String(value ?? '').trim();

export class SidecarStoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SidecarStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new SidecarStoreError(code, message, detail);
}

function requireClient(client) {
  if (!(client instanceof Neo4jHttpClient)) fail('SIDECAR_STORE_CLIENT_REQUIRED', 'an explicit Neo4j HTTP client is required');
}

export const SCHEMA_OBJECTS = Object.freeze([
  { name: 'interpretation_head_slot_unique',
    statement: 'CREATE CONSTRAINT interpretation_head_slot_unique IF NOT EXISTS FOR (h:InterpretationHead) REQUIRE h.slot IS UNIQUE' },
  { name: 'interpretation_generation_id_unique',
    statement: 'CREATE CONSTRAINT interpretation_generation_id_unique IF NOT EXISTS FOR (g:InterpretationGeneration) REQUIRE g.interpretation_id IS UNIQUE' },
  { name: 'ontology_membership_key_unique',
    statement: 'CREATE CONSTRAINT ontology_membership_key_unique IF NOT EXISTS FOR (m:OntologyMembership) REQUIRE (m.interpretation_id, m.membership_id) IS UNIQUE' },
]);

function* batches(rows, size) {
  for (let index = 0; index < rows.length; index += size) yield rows.slice(index, index + size);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Operator incident, 2026-09-26: a real teardown's first attempt hit the client's fixed 30s
// per-request timeout partway through a bulk DETACH DELETE (a densely-connected label costs more
// per row than a sparse one; the timeout was a real request cost, not a bug in the query). Real
// test data was left live in the shared database for a period as a result. This retries an
// already-bounded, already-idempotent delete on ANY failure -- distinguishing nothing about the
// failure kind, because a lost response to a request the server may have still completed looks
// identical, from the caller's side, to a genuine outage. Retrying is always safe: every delete
// this guards is `MATCH ... WITH ... LIMIT $batch DETACH DELETE ... RETURN count(...)`, which
// re-issued against whatever CURRENTLY remains can never double-delete a row already gone -- so
// calling the enclosing function AGAIN after a process-level crash resumes correctly with no
// separate resume state to track or lose, and this internal retry is the same property applied
// without needing to crash and restart at all.
async function queryWithRetry(client, statement, parameters, { maxAttempts = 5, retryDelayMs = 2_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await client.query(statement, parameters); }
    catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleep(Math.min(30_000, retryDelayMs * attempt));
    }
  }
  fail('SIDECAR_QUERY_RETRY_EXHAUSTED', `query failed after ${maxAttempts} attempts`, {
    last_error_code: lastError?.code || lastError?.name || null,
    last_error_message: String(lastError?.message || lastError),
  });
}

async function ensureSidecarSchema(client) {
  for (const object of SCHEMA_OBJECTS) {
    try { await client.query(object.statement); }
    catch (error) { fail('SIDECAR_SCHEMA_FAILED', `could not create ${object.name}`, { code: error.code || error.name }); }
  }
}

/** The `(interpretation_id, base.*, contracts.*, artifacts.*, counts)` shape a Phase 1 `generation`
 * object already carries (tools/ontology/generation-builder.mjs) -- staging reads it as-is. */
function generationProperties(generation, membershipCount) {
  return {
    interpretation_id: generation.interpretation_id,
    interpretation_version: generation.interpretation_version,
    base_projection_id: generation.base.projection_id,
    base_content_digest: generation.base.projection_content_digest,
    evidence_context_id: generation.base.evidence_context_id,
    concept_registry_digest: generation.contracts.concept_registry_digest,
    ontology_policy_digest: generation.contracts.ontology_policy_digest,
    membership_evaluator_digest: generation.contracts.membership_evaluator_digest,
    generalization_evaluator_digest: generation.contracts.generalization_evaluator_digest,
    accepted_decision_set_digest: generation.contracts.accepted_decision_set_digest,
    concepts_digest: generation.artifacts.concepts_digest,
    memberships_digest: generation.artifacts.memberships_digest,
    relations_digest: generation.artifacts.relations_digest,
    generalizations_digest: generation.artifacts.generalizations_digest,
    refusals_digest: generation.artifacts.refusals_digest,
    generation_content_digest: generation.content_digest,
    counts_json: canonical(generation.counts),
    total_memberships: membershipCount,
  };
}

async function startWorkingInterpretation(client, generation, membershipCount, expectedWorkingId) {
  const rows = await client.query(`
    MERGE (h:InterpretationHead {slot: $working_slot})
    ON CREATE SET h.interpretation_id = null
    WITH h WHERE coalesce(h.interpretation_id, '') = coalesce($expected_interpretation_id, '')
    MERGE (g:InterpretationGeneration {interpretation_id: $props.interpretation_id})
    ON CREATE SET g.created_at = datetime()
    SET g += $props, g.status = 'working', g.processed_memberships = 0, g.error = null,
        h.interpretation_id = $props.interpretation_id, h.updated_at = datetime()
    RETURN count(h), g.interpretation_id
  `, {
    working_slot: interpretationSlot('working', generation.base.projection_id),
    expected_interpretation_id: expectedWorkingId,
    props: generationProperties(generation, membershipCount),
  });
  if (rows[0]?.[0] !== 1 || rows[0]?.[1] !== generation.interpretation_id) {
    fail('SIDECAR_WORKING_HEAD_COMPARE_AND_SWAP_FAILED', 'working interpretation changed before staging');
  }
}

async function markInterpretationFailed(client, interpretationId, error) {
  try {
    await client.query(`
      MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
      SET g.status = 'failed', g.error = $error, g.failed_at = datetime()
      RETURN g.interpretation_id
    `, { interpretation_id: interpretationId, error: String(error?.message || error).slice(0, 2_048) });
  } catch { /* Preserve the original staging failure. */ }
}

async function verifyStagedMemberships(client, interpretationId, memberships, pageSize = 5_000) {
  const expected = memberships.map(m => [m.membership_id, m.record_digest ?? m.membership_id]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let after = '';
  let index = 0;
  while (index < expected.length) {
    const page = await client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id})
      WHERE m.membership_id > $after
      RETURN m.membership_id, m.record_digest ORDER BY m.membership_id LIMIT $limit
    `, { interpretation_id: interpretationId, after, limit: pageSize });
    if (!page.length) fail('SIDECAR_CONTENT_MISMATCH', 'membership verification ended early', { index });
    for (const row of page) {
      const [expectedId, expectedDigest] = expected[index];
      if (!expectedId || row[0] !== expectedId || row[1] !== expectedDigest) {
        fail('SIDECAR_CONTENT_MISMATCH', 'staged membership differs from its exact manifest', {
          index, expected: expected[index] || null, actual: row,
        });
      }
      after = row[0];
      index += 1;
    }
  }
  const extra = await client.query(`
    MATCH (m:OntologyMembership {interpretation_id: $interpretation_id})
    WHERE m.membership_id > $after
    RETURN m.membership_id LIMIT 1
  `, { interpretation_id: interpretationId, after });
  if (extra.length) fail('SIDECAR_CONTENT_MISMATCH', 'membership verification found extra rows');
}

const WRITE_MEMBERSHIPS_STATEMENT = `
  UNWIND $rows AS row
  MERGE (m:OntologyMembership {interpretation_id: $interpretation_id, membership_id: row.membership_id})
  SET m.concept_id = row.concept_id, m.concept_version_id = row.concept_version_id,
      m.subject_projection_id = row.subject_projection_id, m.subject_node_id = row.subject_node_id,
      m.subject_record_digest = row.subject_record_digest,
      m.outcome = row.outcome, m.method = row.method, m.confidence = row.confidence,
      m.reason_code = row.reason_code, m.evaluation_json = row.evaluation_json,
      m.witnesses_json = row.witnesses_json, m.witness_provenance_json = row.witness_provenance_json,
      m.defeaters_json = row.defeaters_json, m.record_digest = row.membership_id
  WITH m, row
  MATCH (n:EstateNode {projection_id: row.subject_projection_id, node_id: row.subject_node_id})
  MERGE (m)-[edge:INTERPRETED_AS]->(n)
  SET edge.basis_membership_id = row.membership_id
`;

function membershipRow(membership) {
  return {
    membership_id: membership.membership_id,
    concept_id: membership.concept_id,
    concept_version_id: membership.concept_version_id,
    subject_projection_id: membership.subject_ref.projection_id,
    subject_node_id: membership.subject_ref.node_id,
    subject_record_digest: membership.subject_ref.record_digest,
    outcome: membership.outcome,
    method: membership.method,
    confidence: membership.confidence,
    reason_code: membership.evaluation?.reason_code ?? null,
    evaluation_json: canonical(membership.evaluation),
    witnesses_json: canonical(membership.witnesses),
    witness_provenance_json: canonical(membership.witness_provenance_summary ?? {}),
    defeaters_json: canonical(membership.defeaters ?? []),
  };
}

/** Stage a queryable working interpretation generation in bounded commits, then verify it without
 * changing selected -- the interpretation analogue of stageEstateProjection(). The convenience
 * `interpreted_as` edge is projected to an already-staged EstateNode when one exists; a membership
 * whose subject is absent from the raw graph (a subject from a DIFFERENT base projection, or a raw
 * graph never staged) still stages -- the edge is convenience, never authoritative, so its absence
 * must never block a membership from being queryable by its own properties. */
export async function stageInterpretation({
  client, generation, memberships, batch_size: batchSize = 500,
  expected_working_interpretation_id: expectedWorking = null,
}) {
  requireClient(client);
  if (!generation?.interpretation_id || !generation.base?.projection_id) {
    fail('SIDECAR_GENERATION_INVALID', 'stage requires a sealed Phase 1 generation with base.projection_id');
  }
  if (!Array.isArray(memberships)) fail('SIDECAR_MEMBERSHIPS_INVALID', 'stage requires a memberships array');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    fail('SIDECAR_BATCH_INVALID', 'batch size must be from 1 through 10000');
  }
  await ensureSidecarSchema(client);
  // Identical content is recognized instead of rebuilt, for the same reason stageEstateProjection
  // does: re-staging an already-selected generation would briefly relabel selected as working.
  const heads = await readInterpretationHeads(client, { base_projection_id: generation.base.projection_id });
  const selected = heads.selected;
  if (selected?.interpretation_id === generation.interpretation_id && selected.status === 'selected'
    && selected.generation_content_digest === generation.content_digest) {
    return Object.freeze({ interpretation_id: generation.interpretation_id, status: 'already_selected',
      processed_memberships: selected.processed_memberships, generation_content_digest: selected.generation_content_digest });
  }
  await startWorkingInterpretation(client, generation, memberships.length, expectedWorking);
  let processed = 0;
  // Periodic peak-memory sampling (operator instruction, 2026-09-26, after a real staging run's
  // external memory sampler never got to report anything -- it only printed at clean completion,
  // which an interrupted run never reaches). Sampled once per batch rather than on a fixed timer:
  // it costs nothing extra (a batch write is already the unit of work), and it correlates with
  // actual memory pressure instead of an arbitrary wall-clock interval. Reported on success AND
  // attached to the error on failure, so a crash still discloses what the peak was up to that point.
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
  };
  const peakMb = () => ({ peak_rss_mb: Math.round(peakRssBytes / (1024 * 1024)), peak_heap_used_mb: Math.round(peakHeapUsedBytes / (1024 * 1024)) });
  try {
    sampleMemory();
    for (const batch of batches(memberships, batchSize)) {
      await client.query(WRITE_MEMBERSHIPS_STATEMENT, {
        interpretation_id: generation.interpretation_id, rows: batch.map(membershipRow),
      });
      processed += batch.length;
      await client.query(`
        MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
        SET g.processed_memberships = $processed, g.updated_at = datetime()
        RETURN g.processed_memberships
      `, { interpretation_id: generation.interpretation_id, processed });
      sampleMemory();
    }
    await verifyStagedMemberships(client, generation.interpretation_id, memberships);
    sampleMemory();
    const ready = await client.query(`
      MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
      WHERE g.processed_memberships = g.total_memberships
      SET g.status = 'ready', g.verified_at = datetime()
      RETURN g.interpretation_id, g.generation_content_digest
    `, { interpretation_id: generation.interpretation_id });
    if (ready[0]?.[0] !== generation.interpretation_id || ready[0]?.[1] !== generation.content_digest) {
      fail('SIDECAR_READY_FAILED', 'working interpretation could not be marked ready');
    }
    return Object.freeze({ interpretation_id: generation.interpretation_id, status: 'ready',
      processed_memberships: processed, generation_content_digest: generation.content_digest, ...peakMb() });
  } catch (error) {
    await markInterpretationFailed(client, generation.interpretation_id, error);
    Object.assign(error, peakMb());
    throw error;
  }
}

/** Atomically advance selected only after a complete working (or previously-selected, for
 * rollback) interpretation is ready -- the interpretation analogue of promoteEstateProjection().
 * The one deliberate divergence: the raw promoter matches status = 'ready' only, because a raw
 * projection is never re-selected once superseded. Rollback ("moves only the interpretation head",
 * design v2 section 6) is not a separate mechanism here -- it is this same compare-and-set promote,
 * targeting a generation already staged and superseded, so `status IN ['ready', 'superseded']`. */
export async function promoteInterpretation({
  client, interpretation_id: interpretationId, expected_selected_interpretation_id: expectedSelected = null,
}) {
  requireClient(client);
  const generationRows = await client.query(`
    MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
    RETURN g.base_projection_id
  `, { interpretation_id: interpretationId });
  if (!generationRows.length) fail('SIDECAR_GENERATION_MISSING', 'interpretation generation is not staged', { interpretation_id: interpretationId });
  const baseProjectionId = generationRows[0][0];
  const transaction = await client.begin();
  try {
    const result = await client.commit(transaction, [{
      statement: `
        MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
        WHERE g.status IN ['ready', 'superseded']
        MERGE (h:InterpretationHead {slot: $selected_slot})
        ON CREATE SET h.interpretation_id = null
        WITH g, h WHERE coalesce(h.interpretation_id, '') = coalesce($expected_interpretation_id, '')
        OPTIONAL MATCH (prior:InterpretationGeneration {interpretation_id: h.interpretation_id})
        FOREACH (_ IN CASE WHEN prior IS NULL OR prior.interpretation_id = g.interpretation_id THEN [] ELSE [1] END | SET prior.status = 'superseded')
        SET h.interpretation_id = g.interpretation_id, h.updated_at = datetime(),
            g.status = 'selected', g.selected_at = datetime()
        WITH g, h
        OPTIONAL MATCH (working:InterpretationHead {slot: $working_slot})
        FOREACH (_ IN CASE WHEN working.interpretation_id = g.interpretation_id THEN [1] ELSE [] END |
          SET working.interpretation_id = null, working.updated_at = datetime())
        RETURN h.interpretation_id, g.generation_content_digest
      `,
      parameters: {
        interpretation_id: interpretationId, expected_interpretation_id: expectedSelected,
        selected_slot: interpretationSlot('selected', baseProjectionId),
        working_slot: interpretationSlot('working', baseProjectionId),
      },
      resultDataContents: ['row'],
    }]);
    const row = result[0]?.data?.[0]?.row || [];
    if (row[0] !== interpretationId || !clean(row[1])) {
      fail('SIDECAR_SELECTED_HEAD_COMPARE_AND_SWAP_FAILED', 'selected interpretation changed, or candidate is not ready/superseded');
    }
    return Object.freeze({ interpretation_id: interpretationId, status: 'selected', generation_content_digest: row[1], base_projection_id: baseProjectionId });
  } catch (error) {
    await client.rollback(transaction);
    throw error;
  }
}

/** Delete generations no head can select. Mirrors pruneEstateProjections(): retains every
 * currently-headed generation across every base projection (never just the caller's own), plus a
 * bounded number of superseded ancestors PER base projection, and removes the rest in bounded
 * batches. "Retention must protect any base projection named by a retained or selected
 * interpretation" (design v2 section 6) is the caller's obligation on the RAW side (this function
 * only ever deletes InterpretationGeneration/OntologyMembership nodes, never an EstateProjection). */
export async function pruneInterpretations({
  client, base_projection_id: baseProjectionId, retain_superseded: retain = 1, batch_size: batchSize = 20_000,
  max_attempts: maxAttempts = 5, retry_delay_ms: retryDelayMs = 2_000,
}) {
  requireClient(client);
  if (!Number.isInteger(retain) || retain < 0) fail('SIDECAR_RETENTION_INVALID', 'retention must be a non-negative integer');
  const retry = { maxAttempts, retryDelayMs };
  const heads = await readInterpretationHeads(client, { base_projection_id: baseProjectionId });
  const ownIds = [heads.selected?.interpretation_id, heads.working?.interpretation_id].filter(clean);
  if (!ownIds.length) fail('SIDECAR_RETENTION_UNSAFE', 'refusing to prune without a selected or working head');
  const headRows = await client.query('MATCH (h:InterpretationHead) WHERE h.interpretation_id IS NOT NULL RETURN h.interpretation_id');
  const protectedIds = [...new Set([...ownIds, ...headRows.map(row => row[0]).filter(clean)])];
  const rows = await client.query(`
    MATCH (g:InterpretationGeneration {base_projection_id: $base_projection_id})
    WHERE NOT g.interpretation_id IN $protected
    RETURN g.interpretation_id, g.status, coalesce(g.selected_at, g.verified_at, g.created_at) AS marked
    ORDER BY marked DESC, g.interpretation_id
  `, { base_projection_id: baseProjectionId, protected: protectedIds });
  const prunable = rows.map(row => row[0]).slice(retain);
  let removedMemberships = 0;
  let removedGenerations = 0;
  for (const interpretationId of prunable) {
    for (;;) {
      const deleted = await queryWithRetry(client, `
        MATCH (m:OntologyMembership {interpretation_id: $interpretation_id})
        WITH m LIMIT $batch
        DETACH DELETE m
        RETURN count(m)
      `, { interpretation_id: interpretationId, batch: batchSize }, retry);
      const count = deleted[0]?.[0] || 0;
      removedMemberships += count;
      if (!count) break;
    }
    await queryWithRetry(client, `
      MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
      DELETE g RETURN count(g)
    `, { interpretation_id: interpretationId }, retry);
    removedGenerations += 1;
  }
  return Object.freeze({
    base_projection_id: baseProjectionId, retained: [...ownIds, ...rows.map(row => row[0]).slice(0, retain)],
    protected_interpretation_ids: protectedIds, pruned_interpretation_ids: prunable,
    removed_memberships: removedMemberships, removed_generations: removedGenerations,
  });
}

/** Forcibly removes ONE interpretation generation and every one of its memberships, including if
 * it is currently a head -- the explicit, named capability pruneInterpretations deliberately
 * refuses (it protects every head, always). Added after a real incident (see queryWithRetry's own
 * comment): tearing down a TEST interpretation entirely needs a real product path, not an ad-hoc
 * private script re-deriving the same Cypher by hand. Every delete batch is independently retried;
 * resuming after a process-level crash is just calling this again with the same interpretation_id
 * -- there is no separate resume state, because the underlying delete cannot double-count. */
export async function teardownInterpretation({
  client, interpretation_id: interpretationId, batch_size: batchSize = 10_000,
  max_attempts: maxAttempts = 5, retry_delay_ms: retryDelayMs = 2_000,
}) {
  requireClient(client);
  if (!clean(interpretationId)) fail('SIDECAR_INTERPRETATION_ID_REQUIRED', 'teardown requires interpretation_id');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20_000) {
    fail('SIDECAR_BATCH_INVALID', 'batch size must be from 1 through 20000');
  }
  const retry = { maxAttempts, retryDelayMs };
  let removedMemberships = 0;
  for (;;) {
    const deleted = await queryWithRetry(client, `
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id})
      WITH m LIMIT $batch
      DETACH DELETE m
      RETURN count(m)
    `, { interpretation_id: interpretationId, batch: batchSize }, retry);
    const count = deleted[0]?.[0] || 0;
    removedMemberships += count;
    if (!count) break;
  }
  const generationRows = await queryWithRetry(client, `
    MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
    RETURN g.base_projection_id
  `, { interpretation_id: interpretationId }, retry);
  const baseProjectionId = generationRows[0]?.[0] ?? null;
  let clearedHeads = 0;
  if (baseProjectionId) {
    const headRows = await queryWithRetry(client, `
      UNWIND [$selected_slot, $working_slot] AS slot
      MATCH (h:InterpretationHead {slot: slot, interpretation_id: $interpretation_id})
      SET h.interpretation_id = null, h.updated_at = datetime()
      RETURN count(h)
    `, {
      selected_slot: interpretationSlot('selected', baseProjectionId),
      working_slot: interpretationSlot('working', baseProjectionId),
      interpretation_id: interpretationId,
    }, retry);
    clearedHeads = headRows[0]?.[0] || 0;
  }
  const deletedGeneration = await queryWithRetry(client, `
    MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
    DELETE g RETURN count(g)
  `, { interpretation_id: interpretationId }, retry);
  return Object.freeze({
    interpretation_id: interpretationId, base_projection_id: baseProjectionId,
    removed_memberships: removedMemberships, removed_generation: (deletedGeneration[0]?.[0] || 0) === 1,
    cleared_heads: clearedHeads,
  });
}
