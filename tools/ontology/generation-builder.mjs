// Preserve source witnesses; do not infer authority from naming conventions alone.
import { join } from 'node:path';
import { sha256, writeJson, writeJsonLines } from '../lib.mjs';
import { canonical, fail, GENERATION_SCHEMA } from './schemas.mjs';
import { buildEvidenceContext } from './evidence-context.mjs';
import { buildPhase1Concepts, validateConceptVersion, referencedRelations } from './concept-registry.mjs';
import { evaluateMembership, validateMembership, EVALUATOR_ID, CONFIDENCE_POLICY_DIGEST } from './membership-evaluator.mjs';
import { loadNodePools, loadEdgeAdjacency, fillTargetKinds, buildEntitySubjects, buildClaimSubjects,
  buildOwnershipAdjacency, mergeAdjacency } from './subjects.mjs';

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export async function buildOntologyGeneration({ estate, sourceIdentity, baseProjection, coverage, nodesPath, edgesPath, outputDir }) {
  const evidenceContext = buildEvidenceContext({
    estate, source_identity: sourceIdentity, base_projection: baseProjection, coverage,
  });
  const concepts = buildPhase1Concepts({ policyDigest: CONFIDENCE_POLICY_DIGEST });
  concepts.forEach(validateConceptVersion);

  const roleConcepts = concepts.filter(concept => concept.concept_kind === 'architectural-role');
  const standingConcepts = concepts.filter(concept => concept.concept_kind === 'epistemic-standing');
  const eligibleEntityKinds = new Set(roleConcepts.flatMap(concept => concept.scope.eligible_node_kinds));
  const relations = referencedRelations(roleConcepts);
  // No Phase 1 rule references direction:'in'; adjacency is built out-only so the edges pass never
  // pays for a direction no concept reads.
  const directions = new Set(['out']);

  const nodePools = await loadNodePools(nodesPath, { eligibleEntityKinds });
  const subjectIds = new Set(nodePools.entitySubjects.map(subject => subject.node_id));
  const adjacency = await loadEdgeAdjacency(edgesPath, { subjectIds, relations, directions });
  // File-path owner resolution for facts no structural edge reaches (AR-0006/AR-0007's `owns_fact`
  // leaves) -- merged into the real adjacency before target-kind resolution so a synthesized entry
  // is checked for dangling targets exactly like a real edge.
  const ownership = buildOwnershipAdjacency({ entitySubjects: nodePools.entitySubjects,
    ownableFactsByPath: nodePools.ownableFactsByPath });
  mergeAdjacency(adjacency.out, ownership.adjacency);
  const danglingOut = fillTargetKinds(adjacency.out, nodePools.kindByNodeId);
  const danglingIn = fillTargetKinds(adjacency.in, nodePools.kindByNodeId);

  const entitySubjects = buildEntitySubjects({
    entitySubjects: nodePools.entitySubjects, outAdjacency: adjacency.out, inAdjacency: adjacency.in,
  });
  const { subjects: claimSubjects, refusals: claimRefusals } = buildClaimSubjects(nodePools);

  const generationBody = {
    schema: GENERATION_SCHEMA,
    interpretation_version: 'ontology-interpretation@1',
    base: {
      evidence_context_id: evidenceContext.context_id,
      projection_id: baseProjection.projection_id,
      projection_content_digest: baseProjection.content_digest,
    },
    contracts: {
      concept_registry_digest: sha256(canonical(concepts.map(concept => concept.concept_version_id))),
      ontology_policy_digest: CONFIDENCE_POLICY_DIGEST,
      membership_evaluator_digest: sha256(canonical({ evaluator: EVALUATOR_ID })),
      // Phase 1 computes no generalizations and accepts no decisions; both digests are the
      // canonical-empty digest, honestly empty rather than a masked refusal
      // (docs/before-a-pr.md's caution about `sha256(canonical([]))` applies to REFUSAL sentinels
      // standing in for unknown data -- here the set genuinely is empty).
      generalization_evaluator_digest: null,
      accepted_decision_set_digest: sha256(canonical([])),
    },
  };
  const interpretationId = `estate-interpretation:${sha256(canonical(generationBody))}`;

  // Explicit applicability accounting (operator finding: a shared eligible-kind list across all
  // role concepts hid how narrow each one actually is). Recorded per concept BEFORE evaluation so
  // the conservation check below has an independent number to check the membership count against,
  // not just a count derived from the same loop that produces it.
  const applicableSubjectsByConcept = {};
  const memberships = [];
  for (const concept of roleConcepts) {
    const eligible = entitySubjects.filter(subject => concept.scope.eligible_node_kinds.includes(subject.kind));
    applicableSubjectsByConcept[concept.concept_id] = eligible.length;
    for (const subject of eligible) {
      const membership = evaluateMembership({
        conceptVersion: concept, subject, evidenceContextId: evidenceContext.context_id,
        projectionId: baseProjection.projection_id, generationId: interpretationId,
      });
      validateMembership(membership);
      // Belt-and-suspenders context-isolation check (design v2 section 4.3, "baseline and target
      // contexts cannot blend"): every membership this build produces must reference exactly the
      // projection and context this build was sealed against, by construction, not by convention.
      if (membership.subject_ref.projection_id !== baseProjection.projection_id
        || membership.evidence_context_id !== evidenceContext.context_id) {
        fail('ONTOLOGY_EVIDENCE_CONTEXT_MISMATCH', 'a membership referenced a different projection or evidence context than this build');
      }
      memberships.push(membership);
    }
  }
  for (const concept of standingConcepts) {
    applicableSubjectsByConcept[concept.concept_id] = claimSubjects.length;
    for (const subject of claimSubjects) {
      const membership = evaluateMembership({
        conceptVersion: concept, subject, evidenceContextId: evidenceContext.context_id,
        projectionId: baseProjection.projection_id, generationId: interpretationId,
      });
      validateMembership(membership);
      memberships.push(membership);
    }
  }
  memberships.sort((a, b) => a.membership_id.localeCompare(b.membership_id));

  // Conservation identity (docs/before-a-pr.md: "prefer a conservation identity to a success
  // count"): the membership count must equal the applicable-subject count summed over concepts,
  // exactly -- not derived from the same loop, checked independently against it.
  const expectedMembershipCount = Object.values(applicableSubjectsByConcept).reduce((sum, count) => sum + count, 0);
  if (memberships.length !== expectedMembershipCount) {
    fail('ONTOLOGY_MEMBERSHIP_CONSERVATION', 'membership count does not equal the sum of applicable subjects across concepts', {
      memberships: memberships.length, expected: expectedMembershipCount,
    });
  }

  const refusals = claimRefusals.map(refusal => ({
    schema: 'estate-map/ontology-refusal/v1',
    evidence_context_id: evidenceContext.context_id,
    subject_ref: { projection_id: baseProjection.projection_id, node_id: refusal.node_id },
    code: refusal.code,
    detail: refusal.detail,
    concept_ids_affected: standingConcepts.map(concept => concept.concept_id),
  })).sort((a, b) => (a.subject_ref.node_id + a.code).localeCompare(b.subject_ref.node_id + b.code));

  const counts = {
    concept_versions: concepts.length,
    memberships_member: memberships.filter(m => m.outcome === 'member').length,
    memberships_not_member: memberships.filter(m => m.outcome === 'not_member').length,
    memberships_abstain: memberships.filter(m => m.outcome === 'abstain').length,
    relation_assertions: 0,
    generalizations: 0,
    counterexamples: 0,
    refusals: refusals.length,
  };

  // CORRECTED (found while validating a held-out-eval witness enrichment, 2026-09-26): this used
  // to hash only `generationBody` + `counts`, so two generations with identical counts but
  // DIFFERENT membership content (e.g. richer witnesses, same outcomes) produced the same
  // content_digest -- a real generation should never look unchanged when its artifacts changed.
  // `artifacts` is computed first and folded into content_digest so it cannot happen again.
  const artifacts = {
    concepts_digest: sha256(canonical(concepts.map(concept => concept.concept_version_id))),
    memberships_digest: sha256(canonical(memberships.map(membership => membership.membership_id))),
    relations_digest: sha256(canonical([])),
    generalizations_digest: sha256(canonical([])),
    refusals_digest: sha256(canonical(refusals)),
  };

  const generation = Object.freeze({
    ...generationBody,
    interpretation_id: interpretationId,
    artifacts,
    counts,
    database_manifest_digest: null,
    staged: false,
    content_digest: sha256(canonical({ ...generationBody, interpretation_id: interpretationId, artifacts, counts })),
  });

  if (outputDir) {
    await writeJson(join(outputDir, 'evidence-context.json'), evidenceContext);
    await writeJsonLines(join(outputDir, 'concepts.jsonl'), concepts);
    await writeJsonLines(join(outputDir, 'memberships.jsonl'), memberships);
    await writeJsonLines(join(outputDir, 'refusals.jsonl'), refusals);
    await writeJson(join(outputDir, 'interpretation-manifest.json'), generation);
  }

  return {
    evidenceContext, concepts, memberships, refusals, generation,
    diagnostics: {
      nodeCount: nodePools.nodeCount,
      edgeCount: adjacency.edgeCount,
      entitySubjectCount: entitySubjects.length,
      claimSubjectCount: claimSubjects.length,
      danglingEdgeTargets: danglingOut + danglingIn,
      nodePlaneDrift: nodePools.planeDrift,
      edgeRoleDrift: adjacency.roleDrift,
      applicableSubjectsByConcept,
      ownershipResolution: { ownedFacts: ownership.ownedFacts, ambiguousPaths: ownership.ambiguousPaths,
        unownedPaths: ownership.unownedPaths },
    },
  };
}
