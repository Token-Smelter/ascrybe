import { EVALUATION_REPORT_SCHEMA } from './schemas.mjs';

const NOT_MEASURABLE = (note) => ({ status: 'not_measurable_in_phase_1', note });

/**
 * @param memberships  the sealed memberships a build produced
 * @param refusals     the sealed refusals a build produced
 * @param diagnostics  generation-builder's diagnostics object
 * @param replay       optional { matches: boolean } from a caller that rebuilt and compared digests
 */
export function buildEvaluationReport({ memberships, refusals, diagnostics, replay = null }) {
  const outcomeCounts = { member: 0, not_member: 0, abstain: 0 };
  for (const membership of memberships) outcomeCounts[membership.outcome] += 1;
  const membershipsWithoutWitness = memberships
    .filter(membership => membership.outcome !== 'abstain' && !membership.witnesses.length).length;

  const thresholds = {
    dangling_refs: { target: 0, observed: diagnostics.danglingEdgeTargets, pass: diagnostics.danglingEdgeTargets === 0 },
    memberships_without_valid_witness: { target: 0, observed: membershipsWithoutWitness, pass: membershipsWithoutWitness === 0 },
    exact_replay: replay
      ? { target: true, observed: replay.matches, pass: replay.matches === true }
      : NOT_MEASURABLE("caller did not supply a second build to diff; rebuild and pass { matches } to measure this"),
    mechanical_role_precision_recall: NOT_MEASURABLE(
      '>=0.98 precision / >=0.95 recall on held-out mechanical roles needs an independently labeled sample (design v2 section 10); none exists yet'),
    runtime_abstention_correctness: NOT_MEASURABLE(
      '>=0.95 correct abstention on runtime questions needs a labeled runtime-question set; none exists yet'),
    model_only_membership_auto_selected: {
      target: 0, observed: 0, pass: true,
      note: 'Phase 1 makes zero model calls; no model_proposal/embedding_neighbor witness is ever produced, so this cannot be violated by construction',
    },
    accepted_generalizations_in_v1: {
      target: 0, observed: 0, pass: true,
      note: 'Phase 1 computes no generalizations at all (design v2 section 4c exclusion)',
    },
    ontology_assisted_accuracy_uplift: NOT_MEASURABLE(
      '+10pt accuracy / -25% time vs the best non-ontology arm needs the question-set evaluation harness (Phase 2+ query surface); none exists yet'),
  };

  return {
    schema: EVALUATION_REPORT_SCHEMA,
    measured: {
      outcome_counts: outcomeCounts,
      refusal_count: refusals.length,
      dangling_edge_targets: diagnostics.danglingEdgeTargets,
      node_plane_drift: diagnostics.nodePlaneDrift,
      edge_role_drift: diagnostics.edgeRoleDrift,
      node_count: diagnostics.nodeCount,
      edge_count: diagnostics.edgeCount,
      entity_subject_count: diagnostics.entitySubjectCount,
      claim_subject_count: diagnostics.claimSubjectCount,
    },
    thresholds,
  };
}
