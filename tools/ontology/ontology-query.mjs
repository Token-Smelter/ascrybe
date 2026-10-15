// The ontology's bounded read surface -- design v2 section 9: "members(concept, context,
// min_confidence), concepts_of(node), why(membership) -> witnesses -> raw facts/quotes,
// conflicts(concept), drift(concept, ctxA, ctxB) with cause attribution (source | evidence |
// policy | definition), generalization_report(g). Result envelope discloses interpretation_id,
// base projection_id, evaluator/policy digests, and per-row outcome + method. Raw and interpreted
// views are separated; interpreted rows enter raw responses only by opt-in parameter. Query
// refuses a base/interpretation mismatch."
//
// A parallel module to estate-graph-query.mjs (design v2 section 12: "Extended: query contract
// (parallel tools/ontology-query.mjs)"), never imported by it and never importing it -- the
// separation IS the opt-in: a caller that wants raw graph reads imports estate-graph-query.mjs; a
// caller that wants interpreted reads imports this one; nothing here silently reaches into the
// other's rows.
import { createHash } from 'node:crypto';
import { Neo4jHttpClient } from '../c3-serving-projection.mjs';
import { readInterpretationHeads } from './sidecar-heads.mjs';

const clean = value => String(value ?? '').trim();

export class OntologyQueryError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'OntologyQueryError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new OntologyQueryError(code, message, detail);
}

export const ONTOLOGY_QUERY_RESULT_SCHEMA = 'estate-map/ontology-query-result/v1';
export const ONTOLOGY_QUERY_CONTRACT_VERSION = 'ascrybe/ontology-query-surface/v1';
export const ONTOLOGY_QUERY_CONTRACT = Object.freeze({
  'interpretation-status': ['base_projection_id'],
  members: ['interpretation_id', 'concept_id', 'min_confidence', 'limit', 'expected_base_projection_id'],
  'concepts-of': ['interpretation_id', 'node_id', 'limit', 'expected_base_projection_id'],
  why: ['interpretation_id', 'membership_id', 'expected_base_projection_id'],
  conflicts: ['interpretation_id', 'concept_id', 'limit', 'expected_base_projection_id'],
  drift: ['concept_id', 'interpretation_id_a', 'interpretation_id_b', 'limit'],
  'generalization-report': ['generalization_id'],
});

/** What this build implements, mirroring querySurfaceContract()'s digest-over-commands pattern. */
export function ontologyQuerySurfaceContract() {
  const commands = Object.fromEntries(Object.entries(ONTOLOGY_QUERY_CONTRACT)
    .map(([command, args]) => [command, [...args].sort()])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  const body = { contract: ONTOLOGY_QUERY_CONTRACT_VERSION, commands };
  return Object.freeze({ schema: 'estate-map/ontology-query-contract/v1', ...body,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
}

function boundedInteger(value, label, fallback, maximum) {
  const held = value == null ? fallback : Number(value);
  if (!Number.isInteger(held) || held < 1 || held > maximum) fail('ONTOLOGY_QUERY_BOUND_INVALID', `${label} must be from 1 through ${maximum}`);
  return held;
}

// Confidence is a flat, mechanical enum (design v2 section 3), not a linear scale -- 'contested'
// means "an active defeater exists," a different axis from how much structural warrant a witness
// carries, not "less warrant than plausible." A min_confidence filter still needs SOME order to be
// useful at all, so this ranks contested lowest (excluded unless explicitly asked for) rather than
// silently folding it into whatever rank its witness kind would otherwise have earned.
const CONFIDENCE_RANK = Object.freeze({ certain: 3, likely: 2, plausible: 1, contested: 0 });
// FIXED (self-caught, 2026-09-26): validating min_confidence only inside the row filter meant an
// invalid value silently passed whenever the query happened to return zero rows -- .filter() on
// an empty array never calls its predicate, so a typo'd confidence tier was indistinguishable from
// a concept with no members yet. Validated once, upfront, regardless of what the query returns.
function validateConfidence(minimum) {
  if (minimum && !(minimum in CONFIDENCE_RANK)) {
    fail('ONTOLOGY_QUERY_CONFIDENCE_INVALID', 'min_confidence must be certain, likely, plausible, or contested', { min_confidence: minimum });
  }
}
function confidenceAtLeast(confidence, minimum) {
  if (!minimum) return true;
  return (CONFIDENCE_RANK[confidence] ?? -1) >= CONFIDENCE_RANK[minimum];
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function membershipFromRow(row) {
  return {
    membership_id: row[0], concept_id: row[1], concept_version_id: row[2],
    subject_ref: { projection_id: row[3], node_id: row[4], record_digest: row[5] },
    outcome: row[6], method: row[7], confidence: row[8], reason_code: row[9] ?? null,
    evaluation: parseJson(row[10], null), witnesses: parseJson(row[11], []),
    witness_provenance_summary: parseJson(row[12], {}), defeaters: parseJson(row[13], []),
  };
}

const MEMBERSHIP_RETURN_CLAUSE = `
  m.membership_id, m.concept_id, m.concept_version_id,
  m.subject_projection_id, m.subject_node_id, m.subject_record_digest,
  m.outcome, m.method, m.confidence, m.reason_code,
  m.evaluation_json, m.witnesses_json, m.witness_provenance_json, m.defeaters_json
`;

export class OntologyQueries {
  constructor({ client }) {
    if (!(client instanceof Neo4jHttpClient)) fail('ONTOLOGY_QUERY_CLIENT_REQUIRED', 'ontology query surface requires an explicit Neo4j client');
    this.client = client;
  }

  result(query, generation, data, metadata = {}) {
    return Object.freeze({ schema: ONTOLOGY_QUERY_RESULT_SCHEMA, query, generation, ...metadata, data });
  }

  async generationSummary(interpretationId) {
    const rows = await this.client.query(`
      MATCH (g:InterpretationGeneration {interpretation_id: $interpretation_id})
      RETURN g.interpretation_id, g.status, g.base_projection_id, g.evidence_context_id,
             g.membership_evaluator_digest, g.ontology_policy_digest, g.concept_registry_digest,
             g.generation_content_digest
    `, { interpretation_id: interpretationId });
    if (!rows.length) fail('ONTOLOGY_QUERY_GENERATION_MISSING', `interpretation ${interpretationId} is not staged`, { interpretation_id: interpretationId });
    const row = rows[0];
    return Object.freeze({
      interpretation_id: row[0], status: row[1], base_projection_id: row[2], evidence_context_id: row[3],
      membership_evaluator_digest: row[4], ontology_policy_digest: row[5], concept_registry_digest: row[6],
      generation_content_digest: row[7],
    });
  }

  /** Query refuses a base/interpretation mismatch (design v2 section 9): a caller naming an
   * expected base projection gets a fail-closed refusal, not a silent answer against whichever
   * base the interpretation actually happens to be bound to. */
  async requireGeneration(interpretationId, expectedBaseProjectionId = null) {
    const generation = await this.generationSummary(interpretationId);
    if (expectedBaseProjectionId && generation.base_projection_id !== expectedBaseProjectionId) {
      fail('ONTOLOGY_QUERY_BASE_MISMATCH', 'interpretation is not bound to the expected base projection', {
        interpretation_id: interpretationId, expected_base_projection_id: expectedBaseProjectionId,
        actual_base_projection_id: generation.base_projection_id,
      });
    }
    return generation;
  }

  async interpretationStatus({ base_projection_id: baseProjectionId } = {}) {
    if (!clean(baseProjectionId)) fail('ONTOLOGY_QUERY_BASE_REQUIRED', 'interpretation-status requires base_projection_id');
    const heads = await readInterpretationHeads(this.client, { base_projection_id: baseProjectionId });
    return Object.freeze({ schema: ONTOLOGY_QUERY_RESULT_SCHEMA, query: 'interpretation-status', generation: null, data: heads });
  }

  async members({ interpretation_id: interpretationId, concept_id: conceptId, min_confidence: minConfidence = null,
    limit = 200, expected_base_projection_id: expectedBase = null } = {}) {
    if (!clean(interpretationId) || !clean(conceptId)) fail('ONTOLOGY_QUERY_ARGS_MISSING', 'members requires interpretation_id and concept_id');
    const bound = boundedInteger(limit, 'members limit', 200, 2_000);
    validateConfidence(minConfidence);
    const generation = await this.requireGeneration(interpretationId, expectedBase);
    const rows = await this.client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id})
      WHERE m.outcome = 'member'
      RETURN ${MEMBERSHIP_RETURN_CLAUSE}
      ORDER BY m.subject_node_id
      LIMIT $limit
    `, { interpretation_id: interpretationId, concept_id: conceptId, limit: bound + 1 });
    const kept = rows.slice(0, bound).map(membershipFromRow).filter(row => confidenceAtLeast(row.confidence, minConfidence));
    return this.result('members', generation, kept, { concept_id: conceptId, min_confidence: minConfidence, truncated: rows.length > bound });
  }

  async conceptsOf({ interpretation_id: interpretationId, node_id: nodeId, limit = 50,
    expected_base_projection_id: expectedBase = null } = {}) {
    if (!clean(interpretationId) || !clean(nodeId)) fail('ONTOLOGY_QUERY_ARGS_MISSING', 'concepts-of requires interpretation_id and node_id');
    const bound = boundedInteger(limit, 'concepts-of limit', 50, 500);
    const generation = await this.requireGeneration(interpretationId, expectedBase);
    const rows = await this.client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, subject_node_id: $node_id})
      RETURN ${MEMBERSHIP_RETURN_CLAUSE}
      ORDER BY m.concept_id
      LIMIT $limit
    `, { interpretation_id: interpretationId, node_id: nodeId, limit: bound + 1 });
    const kept = rows.slice(0, bound).map(membershipFromRow);
    return this.result('concepts-of', generation, kept, { node_id: nodeId, truncated: rows.length > bound });
  }

  async why({ interpretation_id: interpretationId, membership_id: membershipId,
    expected_base_projection_id: expectedBase = null } = {}) {
    if (!clean(interpretationId) || !clean(membershipId)) fail('ONTOLOGY_QUERY_ARGS_MISSING', 'why requires interpretation_id and membership_id');
    const generation = await this.requireGeneration(interpretationId, expectedBase);
    const rows = await this.client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, membership_id: $membership_id})
      RETURN ${MEMBERSHIP_RETURN_CLAUSE}
    `, { interpretation_id: interpretationId, membership_id: membershipId });
    if (!rows.length) fail('ONTOLOGY_QUERY_MEMBERSHIP_MISSING', `membership ${membershipId} is absent from ${interpretationId}`, { membership_id: membershipId });
    return this.result('why', generation, membershipFromRow(rows[0]));
  }

  async conflicts({ interpretation_id: interpretationId, concept_id: conceptId, limit = 200,
    expected_base_projection_id: expectedBase = null } = {}) {
    if (!clean(interpretationId) || !clean(conceptId)) fail('ONTOLOGY_QUERY_ARGS_MISSING', 'conflicts requires interpretation_id and concept_id');
    const bound = boundedInteger(limit, 'conflicts limit', 200, 2_000);
    const generation = await this.requireGeneration(interpretationId, expectedBase);
    const rows = await this.client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id, confidence: 'contested'})
      RETURN ${MEMBERSHIP_RETURN_CLAUSE}
      ORDER BY m.subject_node_id
      LIMIT $limit
    `, { interpretation_id: interpretationId, concept_id: conceptId, limit: bound + 1 });
    const kept = rows.slice(0, bound).map(membershipFromRow);
    return this.result('conflicts', generation, kept, { concept_id: conceptId, truncated: rows.length > bound });
  }

  /** Cause attribution over the two generations' OWN sealed contracts (design v2 section 9): a
   * concept-version change outranks a policy change, which outranks a base-projection ("source")
   * change; anything left over is attributed to the underlying evidence itself having differed
   * (the one cause this function cannot read off either generation's own header, since it is a
   * fact about the witnesses, not about the contracts that produced them). */
  async drift({ concept_id: conceptId, interpretation_id_a: idA, interpretation_id_b: idB, limit = 500 } = {}) {
    if (!clean(conceptId) || !clean(idA) || !clean(idB)) fail('ONTOLOGY_QUERY_ARGS_MISSING', 'drift requires concept_id, interpretation_id_a and interpretation_id_b');
    const bound = boundedInteger(limit, 'drift limit', 500, 5_000);
    const [genA, genB] = await Promise.all([this.generationSummary(idA), this.generationSummary(idB)]);
    const [rowsA, rowsB] = await Promise.all([idA, idB].map(interpretationId => this.client.query(`
      MATCH (m:OntologyMembership {interpretation_id: $interpretation_id, concept_id: $concept_id})
      RETURN m.subject_node_id, m.outcome, m.concept_version_id
      ORDER BY m.subject_node_id
      LIMIT $limit
    `, { interpretation_id: interpretationId, concept_id: conceptId, limit: bound + 1 })));
    const byNodeA = new Map(rowsA.slice(0, bound).map(row => [row[0], { outcome: row[1], concept_version_id: row[2] }]));
    const byNodeB = new Map(rowsB.slice(0, bound).map(row => [row[0], { outcome: row[1], concept_version_id: row[2] }]));
    const nodeIds = [...new Set([...byNodeA.keys(), ...byNodeB.keys()])].sort();
    // concept_version_id is a property of the CONCEPT, not the subject: every membership for this
    // concept within one interpretation carries the same value, so the first one found in each
    // side is that interpretation's answer, not a per-row fact needing a per-node comparison.
    const conceptVersionA = byNodeA.values().next().value?.concept_version_id ?? null;
    const conceptVersionB = byNodeB.values().next().value?.concept_version_id ?? null;
    const conceptVersionChanged = conceptVersionA && conceptVersionB && conceptVersionA !== conceptVersionB;
    const cause = conceptVersionChanged ? 'definition'
      : genA.ontology_policy_digest !== genB.ontology_policy_digest ? 'policy'
        : genA.base_projection_id !== genB.base_projection_id ? 'source'
          : 'evidence';
    const rows = nodeIds.map(nodeId => {
      const a = byNodeA.get(nodeId)?.outcome ?? null;
      const b = byNodeB.get(nodeId)?.outcome ?? null;
      return { node_id: nodeId, outcome_a: a, outcome_b: b, changed: a !== b };
    });
    return this.result('drift', null, rows, {
      concept_id: conceptId, cause,
      generation_a: genA, generation_b: genB,
      changed_count: rows.filter(row => row.changed).length,
      truncated: rowsA.length > bound || rowsB.length > bound,
    });
  }

  /** Phase 1 computes zero generalizations by design ("no accepted generalization in v1",
   * design v2 section 10) -- this always, honestly, refuses; it is not a stub awaiting Phase 5. */
  async generalizationReport({ generalization_id: generalizationId } = {}) {
    fail('ONTOLOGY_QUERY_NO_GENERALIZATIONS', 'this build computes no generalizations (Phase 1/2 scope; see design v2 section 4c/10)', {
      generalization_id: generalizationId ?? null,
    });
  }
}
