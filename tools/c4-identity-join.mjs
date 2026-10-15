// C4 identity closure over exact documentary mentions and parser-backed code records.
// Candidate discovery is structural (repository/path/key), while joining additionally requires
// the same source occurrence and an independently testable parser-backed identity basis.
import {
  buildAutomaticIdentityConstraint, buildIdentityDeclarationWitness,
  buildIdentityVerificationRegistry, buildVerifiedComponentIdentityDecision,
  resolveIdentityComponents, verifyIdentityResolution,
} from './referent-identity.mjs';
import {
  groupIdentityCandidatesByExactBasis, selectIdentityCandidateBatch,
} from './identity-candidate-generator.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const C4_JOIN_RECEIPT_SCHEMA = 'estate-map/c4-join-receipt/v1';
export const C4_JOIN_MATERIALIZATION_ID = 'materialization:c4-cross-plane-identity-v1';
export const C4_JOIN_DISPOSITIONS = Object.freeze([
  'joined', 'unresolved', 'cannot_link', 'terminal_incomplete',
]);

const canonical = value => stableStringify(value).trim();
const joinKey = ({ file, line, surface }) => canonical([file, line, surface]);
const fail = message => { throw new Error(message); };

function uniqueRecords(rows, idField, label) {
  const byId = new Map();
  for (const row of rows) {
    const id = row?.[idField] || fail(`${label} record lacks ${idField}`);
    const prior = byId.get(id);
    if (prior && canonical(prior) !== canonical(row)) fail(`${label} ${id} has conflicting bytes`);
    byId.set(id, row);
  }
  return [...byId.values()];
}

function selectedDocumentaryMentions({ argumentSubstrate, documentaryIdentity }) {
  const selected = new Set(documentaryIdentity.identity_resolution.mention_ids);
  const evidenceById = new Map(argumentSubstrate.evidence_pointers.map(row => [row.evidence_id, row]));
  const rows = argumentSubstrate.mentions.filter(row => selected.has(row.mention_id)).map(mention => {
    const evidence = evidenceById.get(mention.evidence_id) || fail(`documentary mention ${mention.mention_id} lacks evidence`);
    if (evidence.pointer?.kind !== 'document_span') fail(`documentary mention ${mention.mention_id} lacks a document-span basis`);
    return { mention, evidence };
  });
  if (rows.length !== selected.size) fail('selected documentary mention closure is incomplete');
  return rows;
}

function identityComponentPlans(mentionIds, constraints) {
  const adjacency = new Map(mentionIds.map(mentionId => [mentionId, new Set()]));
  for (const constraint of constraints) {
    if (!adjacency.has(constraint.left) || !adjacency.has(constraint.right)) {
      fail(`identity constraint ${constraint.constraint_id} falls outside the selected mention set`);
    }
    if (constraint.disposition !== 'must_link') continue;
    adjacency.get(constraint.left).add(constraint.right);
    adjacency.get(constraint.right).add(constraint.left);
  }
  const visited = new Set();
  const components = [];
  for (const start of mentionIds) {
    if (visited.has(start)) continue;
    const pending = [start];
    const members = [];
    visited.add(start);
    while (pending.length) {
      const held = pending.pop();
      members.push(held);
      for (const neighbor of adjacency.get(held)) if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    members.sort();
    const memberSet = new Set(members);
    const componentConstraints = constraints.filter(row =>
      memberSet.has(row.left) && memberSet.has(row.right));
    const blockers = componentConstraints.filter(row => row.disposition !== 'must_link'
      || ['namespace', 'type', 'incompatible_time'].includes(row.constraint_kind));
    components.push({ members, constraints: componentConstraints, blockers });
  }
  return components.sort((left, right) => left.members[0].localeCompare(right.members[0]));
}

function verifiedComponentDecisions({ mentionIds, constraints, codeCandidates,
  verificationRegistry }) {
  const codeMentionIds = new Set(codeCandidates.map(row => row.mention.mention_id));
  return Object.freeze(identityComponentPlans(mentionIds, constraints).flatMap(component => {
    const declarationMentionIds = component.members.filter(mentionId => codeMentionIds.has(mentionId));
    if (!declarationMentionIds.length || component.blockers.length) return [];
    return [buildVerifiedComponentIdentityDecision({
      candidate_mention_ids: component.members,
      declaration_mention_ids: declarationMentionIds,
      identity_constraints: component.constraints,
    }, verificationRegistry)];
  }).sort((left, right) => left.decision_id.localeCompare(right.decision_id)));
}

function buildJoinReceipt({ candidate, component, componentReceipt, documentaryMentionIds }) {
  let disposition = 'terminal_incomplete';
  let reason = 'candidate component has no recognized terminal state';
  const reachesDocumentary = component?.candidate_mention_ids.some(id => documentaryMentionIds.has(id));
  if (component?.status === 'blocked') {
    disposition = 'cannot_link';
    reason = 'whole-component validation recorded a blocking constraint';
  } else if (component?.status === 'unresolved'
    || (component?.status === 'resolved' && !reachesDocumentary)) {
    disposition = 'unresolved';
    reason = 'no admissible documentary occurrence exists in the exact-basis component';
  } else if (component?.status === 'resolved' && reachesDocumentary && componentReceipt) {
    disposition = 'joined';
    reason = `exact-basis component reaches a documentary occurrence through ${candidate.candidate_basis.kind} identity`;
  }
  const body = {
    schema: C4_JOIN_RECEIPT_SCHEMA,
    fact_id: candidate.fact_id,
    fact_kind: candidate.fact_kind,
    code_mention_id: candidate.mention.mention_id,
    disposition,
    reason,
    documentary_mention_ids: component?.candidate_mention_ids.filter(id => documentaryMentionIds.has(id)).sort() || [],
    identity_constraint_ids: componentReceipt?.identity_constraint_ids || [],
    resolution_receipt_id: component?.resolution_receipt_id || null,
    selected_referent_id: disposition === 'joined' ? component?.selected_referent_id || null : null,
    basis: candidate.candidate_basis,
    source_locator: {
      repository: candidate.record.repo,
      file: candidate.record.file,
      line: candidate.record.line,
      key_path: candidate.record.key_path,
    },
    materialization_id: C4_JOIN_MATERIALIZATION_ID,
  };
  return Object.freeze({ ...body, receipt_id: `c4-join-receipt:${sha256(canonical(body))}` });
}

export function buildC4IdentityJoinClosure({ argument_substrate: argumentSubstrate,
  documentary_identity: documentaryIdentity, code_fact_plane: codeFactPlane,
  identity_selection: identitySelection }) {
  const documentaryRows = selectedDocumentaryMentions({ argumentSubstrate, documentaryIdentity });
  const documentaryMentionIds = new Set(documentaryRows.map(row => row.mention.mention_id));
  const documentaryByOccurrence = new Map();
  for (const row of documentaryRows) {
    const key = joinKey({ file: row.evidence.pointer.file, line: row.evidence.pointer.start,
      surface: row.mention.surface });
    const held = documentaryByOccurrence.get(key) || [];
    held.push(row); documentaryByOccurrence.set(key, held);
  }

  const candidateGroups = groupIdentityCandidatesByExactBasis(codeFactPlane.identity_candidates || []);
  const batch = selectIdentityCandidateBatch({
    groups: candidateGroups,
    selection: identitySelection,
    source_head: codeFactPlane.inventory.source_head,
    code_plane_head: codeFactPlane.code_plane_head,
    census_digest: codeFactPlane.identity_candidate_generation.digest,
  });
  const codeCandidates = batch.selected_candidates;
  const documentaryMatches = new Map();
  for (const candidate of codeCandidates) {
    const sourceFile = `${candidate.record.repo}/${candidate.record.file}`;
    const matches = documentaryByOccurrence.get(joinKey({
      file: sourceFile, line: candidate.record.line, surface: candidate.mention.surface,
    })) || [];
    if (matches.length > 1) fail(`identity candidate ${candidate.fact_id} has ambiguous exact documentary occurrences`);
    if (matches.length) {
      const target = matches[0];
      if (target.evidence.pointer.end !== candidate.record.line
        || target.evidence.pointer.exact_text !== candidate.mention.surface
        || target.mention.namespace !== sourceFile) {
        fail(`identity candidate ${candidate.fact_id} differs from its exact documentary occurrence`);
      }
      documentaryMatches.set(candidate.mention.mention_id, target);
    }
  }
  const documentaryVerification = documentaryIdentity.identity_verification_records
    || fail('documentary identity lacks its basis-verification records');
  const codeEvidenceById = new Map((codeFactPlane.grounding_registry?.evidence_pointers || [])
    .map(row => [row.evidence_id, row]));
  const selectedCodeEvidence = codeCandidates.map(candidate =>
    codeEvidenceById.get(candidate.evidence_id)
      || fail(`identity candidate ${candidate.fact_id} lacks its exact EvidencePointer`));
  const bridgeWitnesses = [...documentaryMatches].map(([codeMentionId, target]) => {
    const candidate = codeCandidates.find(row => row.mention.mention_id === codeMentionId)
      || fail(`documentary match ${codeMentionId} lacks its code candidate`);
    return buildIdentityDeclarationWitness({
      mention_id: target.mention.mention_id,
      candidate_basis: candidate.candidate_basis,
      compiler_id: 'identity-candidate-exact-occurrence@1',
      source_fact_evidence_id: candidate.evidence_id,
    });
  });
  const identityVerificationRecords = Object.freeze({
    mentions: Object.freeze(uniqueRecords([
      ...(documentaryVerification.mentions || []),
      ...[...documentaryMatches.values()].map(row => row.mention),
      ...codeCandidates.map(row => row.mention),
    ], 'mention_id', 'identity mention')),
    evidence_pointers: Object.freeze(uniqueRecords([
      ...(documentaryVerification.evidence_pointers || []),
      ...[...documentaryMatches.values()].map(row => row.evidence),
      ...selectedCodeEvidence,
    ], 'evidence_id', 'identity evidence')),
    assertions: Object.freeze(documentaryVerification.assertions || []),
    receipts: Object.freeze(documentaryVerification.receipts || []),
    declaration_witnesses: Object.freeze(uniqueRecords([
      ...(documentaryVerification.declaration_witnesses || []), ...bridgeWitnesses,
    ], 'witness_id', 'declaration witness')),
    forge_locator_identities: Object.freeze(documentaryVerification.forge_locator_identities || []),
    reviewed_dependencies: Object.freeze(documentaryVerification.reviewed_dependencies || []),
  });
  const verificationRegistry = buildIdentityVerificationRegistry(identityVerificationRecords);

  const constraints = documentaryIdentity.identity_constraints.slice();
  // Exact-basis groups are the deterministic code entity layer, whether or not a documentary
  // occurrence happens to reach them. Singletons need no synthetic edge; n-ary declarations use
  // an anchor-star so every member is conserved in one verifiable component.
  for (const group of batch.selected_groups) {
    const [anchor, ...members] = group.members;
    for (const member of members) constraints.push(buildAutomaticIdentityConstraint({
      left: anchor.mention.mention_id,
      right: member.mention.mention_id,
      basis: { ...anchor.candidate_basis, source_version_id: codeFactPlane.code_plane_head },
      basis_evidence_ids: [anchor.evidence_id, member.evidence_id],
      basis_assertion_ids: [],
      source_status: 'current',
      valid_time: null,
      materialization_id: C4_JOIN_MATERIALIZATION_ID,
    }, verificationRegistry));
  }
  for (const candidate of codeCandidates) {
    const target = documentaryMatches.get(candidate.mention.mention_id);
    if (!target) continue;
    const constraint = buildAutomaticIdentityConstraint({
      left: candidate.mention.mention_id,
      right: target.mention.mention_id,
      basis: {
        ...candidate.candidate_basis,
        source_version_id: target.evidence.source_version_id,
      },
      basis_evidence_ids: [candidate.evidence_id, target.evidence.evidence_id],
      basis_assertion_ids: [],
      source_status: 'current',
      valid_time: null,
      materialization_id: C4_JOIN_MATERIALIZATION_ID,
    }, verificationRegistry);
    constraints.push(constraint);
  }
  constraints.sort((left, right) => left.constraint_id.localeCompare(right.constraint_id));
  const mentionIds = [...documentaryMentionIds,
    ...codeCandidates.map(candidate => candidate.mention.mention_id)].sort();
  const componentIdentityDecisions = verifiedComponentDecisions({
    mentionIds, constraints, codeCandidates, verificationRegistry,
  });
  const resolution = resolveIdentityComponents({
    mention_ids: mentionIds,
    identity_constraints: constraints,
    materialization_id: C4_JOIN_MATERIALIZATION_ID,
    identity_verification_registry: verificationRegistry,
    component_identity_decisions: componentIdentityDecisions,
  });
  verifyIdentityResolution({ mention_ids: mentionIds, identity_constraints: constraints, resolution,
    identity_verification_registry: verificationRegistry,
    component_identity_decisions: componentIdentityDecisions });

  const componentByMention = new Map(resolution.components.flatMap(component =>
    component.candidate_mention_ids.map(id => [id, component])));
  const resolutionReceiptById = new Map(resolution.resolution_receipts.map(row => [row.receipt_id, row]));
  const joinReceipts = codeCandidates.map(candidate => {
    const component = componentByMention.get(candidate.mention.mention_id);
    return buildJoinReceipt({
      candidate,
      component,
      componentReceipt: resolutionReceiptById.get(component?.resolution_receipt_id) || null,
      documentaryMentionIds,
    });
  }).sort((left, right) => left.receipt_id.localeCompare(right.receipt_id));
  if (joinReceipts.length !== codeCandidates.length
    || joinReceipts.some(receipt => !C4_JOIN_DISPOSITIONS.includes(receipt.disposition))) {
    fail('every code identity candidate requires exactly one closed join disposition');
  }
  const countsByKind = {};
  for (const receipt of joinReceipts.filter(row => row.disposition === 'joined')) {
    countsByKind[receipt.fact_kind] = (countsByKind[receipt.fact_kind] || 0) + 1;
  }
  const refusals = joinReceipts.filter(row => row.disposition !== 'joined').reduce((held, receipt) => {
    const key = canonical([receipt.fact_kind, receipt.reason]);
    const row = held.get(key) || { fact_kind: receipt.fact_kind, reason: receipt.reason,
      disposition: receipt.disposition, count: 0 };
    row.count += 1;
    held.set(key, row);
    return held;
  }, new Map());
  const candidateComponents = [...new Set(codeCandidates.map(candidate =>
    componentByMention.get(candidate.mention.mention_id)?.resolution_receipt_id).filter(Boolean))];
  const selectedReferents = [...new Set(joinReceipts.filter(row => row.disposition === 'joined')
    .map(row => row.selected_referent_id).filter(Boolean))];
  const codeMentionIds = new Set(codeCandidates.map(row => row.mention.mention_id));
  const resolutionByMention = new Map(resolution.mention_resolutions.map(row => [row.mention_id, row]));
  const resolvedCodeMentions = [...codeMentionIds].filter(mentionId => resolutionByMention.has(mentionId));
  const codeReferentIds = [...new Set(resolvedCodeMentions
    .map(mentionId => resolutionByMention.get(mentionId).referent_id))].sort();
  const referentById = new Map(resolution.referents.map(row => [row.referent_id, row]));
  if (codeReferentIds.some(referentId =>
    referentById.get(referentId)?.identity_kind !== 'deterministic_namespace')) {
    fail('an evaluated code declaration resolved without a deterministic namespace key');
  }
  const entityLayer = Object.freeze({
    evaluated_candidates: codeCandidates.length,
    candidate_components: batch.receipt.selected_component_ids.length,
    component_identity_decisions: componentIdentityDecisions.length,
    resolved_candidate_mentions: resolvedCodeMentions.length,
    unresolved_candidate_mentions: codeCandidates.length - resolvedCodeMentions.length,
    keyed_referents: codeReferentIds.length,
  });
  const dispositions = Object.freeze(Object.fromEntries(C4_JOIN_DISPOSITIONS.map(disposition => [
    disposition, joinReceipts.filter(row => row.disposition === disposition).length,
  ])));
  const coverage = Object.freeze({
    measurement_policy: 'observed evaluated-batch outcome; no join or referent target; rates exclude not-evaluated candidates',
    seeded_baseline: Object.freeze({ candidates: 6, joins: 4, unresolved: 2, referents: 2 }),
    full_census: Object.freeze({
      candidates: batch.receipt.total_candidates,
      components: batch.receipt.total_components,
      nary_components: candidateGroups.filter(group => group.members.length > 1).length,
      singleton_components: candidateGroups.filter(group => group.members.length === 1).length,
    }),
    evaluated_batch: Object.freeze({
      denominator: joinReceipts.length,
      components: candidateComponents.length,
      referents: selectedReferents.length,
      joins: dispositions.joined,
      refusals: joinReceipts.length - dispositions.joined,
      refusals_by_exact_reason_and_fact_kind: Object.freeze([...refusals.values()]
        .sort((left, right) => canonical(left).localeCompare(canonical(right)))),
    }),
    not_evaluated: Object.freeze({
      candidates: batch.receipt.not_evaluated_in_this_batch_count,
      semantic_disposition: null,
      state: 'not_evaluated_in_this_batch',
    }),
  });
  const evaluationStateByComponent = new Map(batch.receipt.candidate_rows.map(row => [
    row.component_id, row.evaluation_state,
  ]));
  const report = Object.freeze({
    denominators: Object.freeze({
      full_census_candidates: batch.receipt.total_candidates,
      full_census_components: batch.receipt.total_components,
      evaluated_batch_candidates: joinReceipts.length,
      evaluated_batch_components: batch.receipt.selected_component_ids.length,
      not_evaluated_in_this_batch: batch.receipt.not_evaluated_in_this_batch_count,
    }),
    candidates: joinReceipts.length,
    dispositions,
    joined_by_fact_kind: Object.freeze(Object.fromEntries(Object.entries(countsByKind).sort())),
    candidate_generation: codeFactPlane.identity_candidate_generation,
    batch_receipt: batch.receipt,
    exact_basis_groups: Object.freeze(candidateGroups.map(group => Object.freeze({
      component_id: group.component_id,
      exact_basis_digest: group.exact_basis_digest,
      grouping_disposition: group.disposition,
      evaluation_state: evaluationStateByComponent.get(group.component_id),
      candidate_fact_ids: Object.freeze(group.members.map(row => row.fact_id).sort()),
      candidate_mention_ids: Object.freeze(group.members.map(row => row.mention.mention_id).sort()),
    }))),
    coverage,
    entity_layer: entityLayer,
    join_receipts: Object.freeze(joinReceipts),
  });
  return Object.freeze({
    identity_constraints: Object.freeze(constraints),
    component_identity_decisions: componentIdentityDecisions,
    identity_resolution: resolution,
    identity_verification_registry: verificationRegistry,
    identity_verification_records: identityVerificationRecords,
    identity_receipt_history: Object.freeze({
      resolution_receipts: resolution.resolution_receipts,
      referent_identity_keys: Object.freeze([]),
    }),
    code_mentions: Object.freeze(candidateGroups.flatMap(group => group.members).map(row => row.mention)
      .sort((left, right) => left.mention_id.localeCompare(right.mention_id))),
    evaluated_code_mentions: Object.freeze(codeCandidates.map(row => row.mention)
      .sort((left, right) => left.mention_id.localeCompare(right.mention_id))),
    pending_code_mentions: Object.freeze(candidateGroups.flatMap(group => group.members)
      .filter(row => !batch.receipt.selected_candidate_fact_ids.includes(row.fact_id))
      .map(row => row.mention).sort((left, right) => left.mention_id.localeCompare(right.mention_id))),
    batch_receipt: batch.receipt,
    report,
  });
}
