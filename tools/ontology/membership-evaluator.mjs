// estate-map/ontology-membership/v1 (design v2 sections 3, 5, 7.2-7.3) -- evaluates one sealed
// concept version against one subject view and seals the outcome triad: `member` (the rule
// matched, with witnesses), `not_member` (the rule did not match AND the concept's inventory is
// declared closed-world), or `abstain` (the rule did not match and absence is not proof -- a
// retained record with a closed-vocabulary reason_code, never a silent drop).
//
// Confidence is mechanical from WITNESS-KIND COMPOSITION, never a model's self-report (design v2
// section 3): `certain` needs a deterministic structural (`projected_edge`) witness; `likely` is
// the strongest a documentary (`claim`/`assertion`) witness earns on its own, since Phase 1 has no
// mixed structural+documentary concept to test the design's literal "documentary + partial
// structural" wording against; `plausible` is model/embedding evidence, produced nowhere in Phase 1
// (zero model calls); `contested` is any active defeater, overriding the rest. This `likely`
// reading is a DOCUMENTED DEFAULT for open decision (b) ("minimum witness policy for likely"),
// which the design left for the operator; report it as such rather than as a settled answer.
import { sha256 } from '../lib.mjs';
import { canonical, digestMatches, fail, MEMBERSHIP_SCHEMA, CONFIDENCE_POLICY_SCHEMA } from './schemas.mjs';
import { evaluateExpression, expressionDigest } from './pattern-language.mjs';

export const EVALUATOR_ID = 'ontology-membership-evaluator@1';
export const WITNESS_KINDS = Object.freeze(['projected_edge', 'claim', 'assertion', 'model_proposal', 'embedding_neighbor', 'operator_assertion']);
export const REASON_CODES = Object.freeze(['RUNTIME_EVIDENCE_UNAVAILABLE', 'INVENTORY_INCOMPLETE', 'CONFLICTING_WITNESS', 'EPOCH_MISMATCH', 'TEST_OR_FIXTURE_ONLY']);
export const OUTCOMES = Object.freeze(['member', 'not_member', 'abstain']);
export const CONFIDENCE_LEVELS = Object.freeze(['certain', 'likely', 'plausible', 'contested']);
export const NEGATIVE_SEMANTICS = Object.freeze(['open_world_abstain', 'closed_world_not_member']);

export const CONFIDENCE_POLICY = Object.freeze({
  schema: CONFIDENCE_POLICY_SCHEMA,
  rule: "certain: >=1 'projected_edge' witness, no active defeater. likely: a documentary "
    + "('claim'/'assertion') witness and no 'projected_edge' witness, no active defeater. plausible: "
    + "only 'model_proposal'/'embedding_neighbor' witnesses. contested: any active defeater, "
    + 'regardless of witness kind. A function of witness-kind composition only, never of a model\'s '
    + 'self-reported probability.',
});
export const CONFIDENCE_POLICY_DIGEST = sha256(canonical(CONFIDENCE_POLICY));

export function confidenceFor(witnesses, defeaters) {
  if (defeaters?.length) return 'contested';
  const kinds = new Set((witnesses || []).map(witness => witness.kind));
  if (kinds.has('projected_edge')) return 'certain';
  if (kinds.has('claim') || kinds.has('assertion')) return 'likely';
  if (kinds.has('model_proposal') || kinds.has('embedding_neighbor')) return 'plausible';
  return null;
}

function buildWitnesses(trace, subject, projectionId) {
  const edgeWitnesses = [];
  for (const entry of trace) {
    if (!entry.matches) continue;
    for (const match of entry.matches) {
      edgeWitnesses.push({
        kind: 'projected_edge', projection_id: projectionId, edge_id: match.edge_id,
        record_digest: match.record_digest, relation: match.relation, from: subject.node_id, to: match.to,
        // CORRECTED (operator, 2026-09-26, against real held-out answers): a witness that named
        // `to` but not its KIND told a held-out judge there was SOME edge to SOMETHING, never that
        // the something was the HttpClientCall/Capability/etc. the rule actually required -- every
        // owns_fact disagreement on external-http-client and persistence-adapter said exactly this
        // ("does not identify that fact as an HttpClientCall"). `to_kind` is already resolved by
        // subjects.mjs's fillTargetKinds; it was just never carried past the adjacency entry.
        to_kind: match.to_kind,
        from_fact_id: match.from_fact_id, to_fact_id: match.to_fact_id, source_witnesses: match.source_witnesses,
        // 'native': the base projection emitted this exact edge. 'file_path_owner_match': subjects.mjs
        // RESOLVED this ownership from an exact, unambiguous file match; it is still a deterministic
        // structural fact (hence still a `projected_edge` witness, still `certain`-eligible), but a
        // reader should be able to tell the two apart rather than assume every witness here is native.
        resolution: match.resolution ?? 'native',
      });
    }
  }
  if (edgeWitnesses.length) {
    const seen = new Set();
    return edgeWitnesses.filter(w => (seen.has(w.edge_id) ? false : seen.add(w.edge_id)))
      .sort((a, b) => a.edge_id.localeCompare(b.edge_id));
  }
  if (subject.witnessMeta) {
    // CORRECTED (operator, 2026-09-26, against a real held-out pilot): a claim witness that names
    // only opaque ids and a source location gives a reader -- human or model -- nothing to check
    // the outcome against. A held-out judge handed exactly that abstained on every single claim
    // sample, correctly: it had no observable fact to reason from. `observed_fields` is every
    // field a field_equals/field_in/field_set_equals leaf actually read for THIS subject, taken
    // from the trace rather than re-read, so the witness can never disagree with what the rule saw.
    const observedFields = {};
    for (const entry of trace) {
      if (entry.field) observedFields[entry.field] = entry.observed;
    }
    return [{
      kind: 'claim', claim_id: subject.witnessMeta.claim_id, receipt_id: subject.witnessMeta.receipt_id,
      source: `${subject.witnessMeta.source_path}:${subject.witnessMeta.source_line}`,
      observed_fields: observedFields,
    }];
  }
  return [];
}

/** Per-witness `source_witnesses[].provenance_class` counts, flattened across every witness this
 * membership carries -- so "66 of 90 envelope-publisher members are test-only" is answerable from
 * the persisted record without re-deriving provenance from raw file paths (operator finding:
 * "distinguish test/production scope rather than delete evidence"). Never changes `outcome`. */
function witnessProvenanceSummary(witnesses) {
  const summary = { production: 0, test: 0, fixture: 0, docs: 0 };
  for (const witness of witnesses) {
    for (const sourceWitness of witness.source_witnesses ?? []) {
      const witnessClass = sourceWitness.provenance_class;
      if (witnessClass in summary) summary[witnessClass] += 1;
    }
  }
  return summary;
}

/** Evaluate one sealed concept version against one subject view; returns a sealed membership record. */
export function evaluateMembership({ conceptVersion, subject, evidenceContextId, projectionId, generationId }) {
  if (!conceptVersion?.concept_id || !conceptVersion.concept_version_id || !conceptVersion.membership_rule?.expression) {
    fail('MEMBERSHIP_INPUT_INVALID', 'membership evaluation requires a sealed concept version');
  }
  if (!NEGATIVE_SEMANTICS.includes(conceptVersion.membership_rule.negative_semantics)) {
    fail('MEMBERSHIP_INPUT_INVALID', `concept version ${conceptVersion.concept_id} has an unrecognized negative_semantics`);
  }
  if (!subject?.node_id || !subject.record_digest || !subject.view) {
    fail('MEMBERSHIP_INPUT_INVALID', 'membership evaluation requires a subject with node_id, record_digest and a view');
  }
  if (!evidenceContextId || !projectionId || !generationId) {
    fail('MEMBERSHIP_INPUT_INVALID', 'membership evaluation requires evidence-context, projection and generation identity');
  }

  const { matched, trace } = evaluateExpression(conceptVersion.membership_rule.expression, subject.view);
  const witnesses = buildWitnesses(trace, subject, projectionId);
  const readableTrace = trace.map(entry => ({ clause: entry.clause, result: entry.result, field: entry.field ?? null, observed: entry.observed ?? null }));

  let outcome;
  let evaluationResult;
  let reasonCode = null;
  let defeaters = [];
  if (matched && conceptVersion.concept_kind === 'architectural-role' && witnessProvenanceSummary(witnesses).production === 0) {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    outcome = 'not_member';
    evaluationResult = 'matched_scope_excluded';
    reasonCode = 'TEST_OR_FIXTURE_ONLY';
  } else if (matched) {
    outcome = 'member';
    evaluationResult = 'matched';
  } else if (conceptVersion.membership_rule.negative_semantics === 'closed_world_not_member') {
    outcome = 'not_member';
    evaluationResult = 'not_matched_closed_world';
  } else {
    outcome = 'abstain';
    evaluationResult = 'insufficient_evidence';
    reasonCode = 'INVENTORY_INCOMPLETE';
    defeaters = [{ kind: 'open_world_inventory_gap',
      detail: 'no qualifying witness was found and the extraction inventory for this rule is not declared closed-world complete' }];
  }

  const finalWitnesses = outcome === 'abstain' ? [] : witnesses;
  if (outcome !== 'abstain' && !finalWitnesses.length) {
    fail('MEMBERSHIP_WITNESS_MISSING', `${conceptVersion.concept_id} produced outcome ${outcome} for ${subject.node_id} with no witness`);
  }
  const confidence = outcome === 'abstain' ? null : confidenceFor(finalWitnesses, defeaters);

  const body = {
    schema: MEMBERSHIP_SCHEMA,
    evidence_context_id: evidenceContextId,
    subject_ref: { projection_id: projectionId, node_id: subject.node_id, record_digest: subject.record_digest },
    concept_id: conceptVersion.concept_id,
    concept_version_id: conceptVersion.concept_version_id,
    outcome,
    method: 'deterministic_rule',
    evaluation: {
      evaluator: EVALUATOR_ID,
      rule_digest: expressionDigest(conceptVersion.membership_rule.expression),
      result: evaluationResult,
      reason_code: reasonCode,
      trace: readableTrace,
    },
    witnesses: finalWitnesses,
    witness_provenance_summary: witnessProvenanceSummary(finalWitnesses),
    confidence,
    proposal_id: null,
    decision_id: null,
    defeaters,
    created_by_generation: generationId,
  };
  return Object.freeze({ ...body, membership_id: `ontology-membership:${sha256(canonical(body))}` });
}

/** Fail-closed shape check: schema, closed-vocabulary outcome/witness-kind/reason-code, and that
 * every non-abstain outcome carries at least one witness -- "0 accepted memberships without valid
 * witnesses" (design v2 section 10) checked at seal time, not left to a downstream reader. */
export function validateMembership(record) {
  if (record?.schema !== MEMBERSHIP_SCHEMA) fail('MEMBERSHIP_INVALID', 'membership schema mismatch');
  if (!OUTCOMES.includes(record.outcome)) fail('MEMBERSHIP_INVALID', `unrecognized outcome ${record.outcome}`);
  if (!record.subject_ref?.projection_id || !record.subject_ref?.node_id || !record.subject_ref?.record_digest) {
    fail('MEMBERSHIP_INVALID', 'membership subject_ref is incomplete');
  }
  if (!record.concept_id || !record.concept_version_id) fail('MEMBERSHIP_INVALID', 'membership is missing concept identity');
  if (record.outcome === 'abstain') {
    if (!REASON_CODES.includes(record.evaluation?.reason_code)) {
      fail('MEMBERSHIP_INVALID', 'an abstain membership requires a closed-vocabulary reason_code');
    }
  } else if (!record.witnesses?.length) {
    fail('MEMBERSHIP_INVALID', `a ${record.outcome} membership requires at least one witness`);
  }
  if (record.evaluation?.result === 'matched_scope_excluded' && !REASON_CODES.includes(record.evaluation?.reason_code)) {
    fail('MEMBERSHIP_INVALID', 'a matched_scope_excluded not_member membership requires a closed-vocabulary reason_code');
  }
  for (const witness of record.witnesses || []) {
    if (!WITNESS_KINDS.includes(witness.kind)) fail('MEMBERSHIP_INVALID', `witness kind ${witness.kind} is not in the closed vocabulary`);
  }
  if (record.confidence !== null && !CONFIDENCE_LEVELS.includes(record.confidence)) {
    fail('MEMBERSHIP_INVALID', `confidence ${record.confidence} is not in the closed vocabulary`);
  }
  if (!digestMatches(record, 'membership_id', 'ontology-membership')) {
    fail('MEMBERSHIP_DIGEST_MISMATCH', 'membership id does not match its canonical body');
  }
}
