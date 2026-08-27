import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssertionSupersessionLedger, buildAssertionSupersessionReceipt,
  buildFrozenReferencePolicyResult, buildServingAssertionPlane, groundedAssertionId,
  identityHeadForResolution, reconcileDependentReferences, resolveAssertionSupersession,
  verifyAppendOnlyAssertionSupersession, verifyDependentReferenceReconciliation,
  verifyServingAssertionPlane, GROUNDED_ASSERTION_SCHEMA, GROUNDED_ASSERTION_SCHEMA_VERSION,
} from '../tools/serving-assertions.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityConstraint, buildIdentityVerificationRegistry,
  buildReferent, buildResolutionReceipt, resolveIdentityComponents,
} from '../tools/referent-identity.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_RECEIPT_SCHEMA,
  CLAIM_PROJECTION_SCHEMA_VERSION,
} from '../tools/claim-projection.mjs';
import {
  ARGUMENT_BINDING_COVERAGE_SCHEMA, buildEvidencePointer, buildMention,
} from '../tools/argument-mentions.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const materializationId = 'materialization:c1-fixture';
const emptyGroundingRegistry = () => ({ evidence_pointers: [], receipts: [] });
const emptyIdentityHistory = () => ({ resolution_receipts: [], referent_identity_keys: [] });
const hashId = (prefix, body) => `${prefix}:${sha256(stableStringify(body).trim())}`;

function rehashIdentityResolution(resolution) {
  const { digest: _digest, ...body } = resolution;
  resolution.digest = sha256(stableStringify(body).trim());
  return resolution;
}

function projectionReceipt(basisClaimId, assertionIds, fields = {}) {
  const body = {
    schema: CLAIM_PROJECTION_RECEIPT_SCHEMA,
    basis_claim_id: basisClaimId,
    disposition: assertionIds.length ? 'fully_projected' : 'unresolved_argument_mentions',
    assertion_ids: assertionIds,
    argument_binding_receipt_ids: [],
    findings: [],
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    materialization_id: materializationId,
    ...fields,
  };
  return { ...body, receipt_id: hashId('claim-projection-receipt', body) };
}

function documentaryClaim(id) {
  return {
    schema: 'estate-map/documentary-claim/v3',
    id,
    semantic: { predicate_lexeme: `predicate:${id}`, support_sets: [] },
    producer: { model_identifier: 'fixture:deterministic', prompt_digest: 'fixture:exact' },
  };
}

function claimAssertion(basisClaimId, argumentMentions, fields = {}) {
  const assertionId = claimAssertionId({
    basis_claim_id: basisClaimId,
    argument_mentions: argumentMentions,
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
  });
  const receipt = projectionReceipt(basisClaimId, [assertionId]);
  return {
    schema: CLAIM_ASSERTION_SCHEMA,
    assertion_id: assertionId,
    basis_claim_id: basisClaimId,
    proposition_key: `proposition:${basisClaimId}`,
    core_proposition_key: `core:${basisClaimId}`,
    evidence_key: `evidence:${basisClaimId}`,
    repair_findings: [{ code: 'fixture-byte', exact: 'A\u0000B' }],
    lineage_status: 'valid',
    lineage_finding_ids: ['lineage:exact'],
    predicate_lexeme: 'routes_when_ready',
    polarity: 'affirmed',
    modality: 'descriptive',
    quantifier: 'one',
    scope: { environment: 'production' },
    conditions: [],
    valid_time: { start: '2025-01-01', end: null },
    recorded_time: '2026-08-06T12:00:00.000Z',
    source_status: 'current',
    decision_status: 'none',
    argument_mentions: argumentMentions,
    support_set_ids: ['support:exact'],
    source_staleness_receipt_ids: [],
    migration_provenance_receipt_id: 'migration:exact',
    projection_receipt_id: receipt.receipt_id,
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    ...fields,
  };
}

function claimContext(assertions, bindingReceiptsByAssertion = new Map()) {
  const claims = assertions.map(row => documentaryClaim(row.basis_claim_id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sortedAssertions = assertions.slice().sort((left, right) => left.assertion_id.localeCompare(right.assertion_id));
  const receipts = sortedAssertions.map(row => projectionReceipt(row.basis_claim_id, [row.assertion_id], {
    argument_binding_receipt_ids: (bindingReceiptsByAssertion.get(row.assertion_id) || [])
      .map(receipt => receipt.receipt_id).sort(),
  })).sort((left, right) => left.basis_claim_id.localeCompare(right.basis_claim_id));
  const receiptByAssertionId = new Map(receipts
    .flatMap(receipt => receipt.assertion_ids.map(assertionId => [assertionId, receipt])));
  const projectedAssertions = sortedAssertions.map(row => ({
    ...row,
    projection_receipt_id: receiptByAssertionId.get(row.assertion_id).receipt_id,
  }));
  const bindingReceipts = [...new Map([...bindingReceiptsByAssertion.values()].flat()
    .map(receipt => [receipt.receipt_id, receipt])).values()]
    .sort((left, right) => left.obligation_id.localeCompare(right.obligation_id));
  return {
    admittedClaims: claims,
    claimProjection: {
      schema: 'estate-map/claim-projection-bundle/v1',
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
      materialization_id: materializationId,
      documentary_claims: claims,
      lineage_facts: {},
      claim_plane_projection_digest: sha256(stableStringify(claims)),
      assertions: projectedAssertions,
      claim_projection_receipts: receipts,
      argument_binding_coverage_receipts: bindingReceipts,
      source_staleness_receipts: [],
      migration_provenance_receipts: [],
      digest: 'fixture:projection-bundle',
    },
  };
}

function bindingReceipt(obligationId, selectedMentionIds = ['mention:binding']) {
  const body = {
    schema: ARGUMENT_BINDING_COVERAGE_SCHEMA,
    obligation_id: obligationId,
    disposition: selectedMentionIds.length ? 'bound_to_exact_mention' : 'literal_argument',
    selected_mention_ids: selectedMentionIds,
    rejected_candidate_mention_ids: [],
    findings: [],
    materialization_id: `${materializationId}:binding`,
  };
  return { ...body, receipt_id: hashId('argument-binding-receipt', body) };
}

function fixtureDocumentMention(label, surface, role) {
  const evidence = buildEvidencePointer({
    source_version_id: 'source-version:c1-identity-fixture',
    pointer: { kind: 'document_span', file: `fixtures/${label}.md`, start: 1, end: 1,
      byte_start: 0, byte_end: Buffer.byteLength(surface), exact_text: surface,
      digest: sha256(surface) },
  });
  return buildMention({ evidence_pointer: evidence, surface, role,
    provenance_class: 'fixture', namespace: `fixtures/${label}.md`, source_status: 'current',
    context_digest: sha256(label), disposition: 'identity_candidate' });
}

function fixtureCanonicalMention(label, role) {
  const surface = 'entity:blocked-candidate';
  const evidence = buildEvidencePointer({
    source_version_id: 'source:blocked',
    pointer: { kind: 'structured_record', record_id: `canonical:${label}`,
      schema_id: 'estate-map/source-established-canonical-reference/v1',
      field_path: '$.canonical_reference', exact_value: surface, digest: sha256(surface) },
  });
  return buildMention({ evidence_pointer: evidence, surface, role,
    provenance_class: 'fixture', namespace: 'registry:blocked', source_status: 'current',
    context_digest: sha256(label), disposition: 'identity_candidate' });
}

function identityFixture() {
  const resolvedA = fixtureDocumentMention('resolved-a', 'legacy-service', 'subject');
  const resolvedB = fixtureDocumentMention('resolved-b', 'canonical-service', 'object');
  const unresolved = fixtureDocumentMention('unresolved', 'unresolved-service', 'object');
  const blockedA = fixtureCanonicalMention('blocked-a', 'subject');
  const blockedB = fixtureCanonicalMention('blocked-b', 'object');
  const alias = claimContext([claimAssertion('claim:explicit-alias', [
    { role: 'subject', mention_id: resolvedA.mention.mention_id },
    { role: 'object', mention_id: resolvedB.mention.mention_id },
  ])]);
  const aliasAssertion = alias.claimProjection.assertions[0];
  const aliasReceipt = alias.claimProjection.claim_projection_receipts[0];
  const pairs = [resolvedA, resolvedB, unresolved, blockedA, blockedB];
  const verificationRegistry = buildIdentityVerificationRegistry({
    mentions: pairs.map(row => row.mention), evidence_pointers: pairs.map(row => row.evidence),
    assertions: [aliasAssertion], receipts: [aliasReceipt],
  });
  const automatic = buildAutomaticIdentityConstraint({
    left: resolvedA.mention.mention_id,
    right: resolvedB.mention.mention_id,
    basis: { kind: 'source_cited_alias', alias_assertion_id: aliasAssertion.assertion_id },
    basis_evidence_ids: [resolvedA.evidence.evidence_id, resolvedB.evidence.evidence_id],
    basis_assertion_ids: [aliasAssertion.assertion_id],
    source_status: 'current', materialization_id: materializationId,
  }, verificationRegistry);
  const blockedLink = buildAutomaticIdentityConstraint({
    left: blockedA.mention.mention_id,
    right: blockedB.mention.mention_id,
    basis: {
      kind: 'source_established_canonical_reference',
      canonical_reference: 'entity:blocked-candidate', source_version_id: 'source:blocked',
    },
    basis_evidence_ids: [blockedA.evidence.evidence_id, blockedB.evidence.evidence_id],
    source_status: 'current', materialization_id: materializationId,
  }, verificationRegistry);
  const blocker = buildIdentityConstraint({
    left: blockedA.mention.mention_id,
    right: blockedB.mention.mention_id,
    disposition: 'cannot_link', basis: { kind: 'explicit_conflict' },
    basis_evidence_ids: [blockedA.evidence.evidence_id, blockedB.evidence.evidence_id],
    source_status: 'disputed', authority: 'source_explicit', materialization_id: materializationId,
  });
  const constraints = [automatic, blockedLink, blocker];
  const mentionIds = pairs.map(row => row.mention.mention_id);
  return {
    constraints, verificationRegistry,
    labels: { resolvedA: resolvedA.mention.mention_id, resolvedB: resolvedB.mention.mention_id,
      unresolved: unresolved.mention.mention_id, blockedA: blockedA.mention.mention_id,
      blockedB: blockedB.mention.mention_id },
    resolution: resolveIdentityComponents({
      mention_ids: mentionIds, identity_constraints: constraints,
      materialization_id: materializationId,
      identity_verification_registry: verificationRegistry,
    }),
  };
}

function qualifiedFixture(groundingReceipt = buildResolutionReceipt({
  candidate_mention_ids: ['mention:grounding'],
  disposition: 'unresolved',
  excluded_mention_ids: ['mention:grounding'],
  materialization_id: `${materializationId}:grounding`,
}), identityMentions = {
  resolvedA: 'mention:resolved-a', resolvedB: 'mention:resolved-b',
  unresolved: 'mention:unresolved', blockedA: 'mention:blocked-a',
}) {
  const negated = claimAssertion('claim:negated', [
    { role: 'subject', mention_id: identityMentions.resolvedA },
    { role: 'object', mention_id: identityMentions.unresolved },
    { role: 'scope_referent', mention_id: identityMentions.blockedA },
    { role: 'condition_referent', literal: { exact: 'feature == "on"', bytes: 'AAEC' } },
  ], {
    predicate_lexeme: 'does_not_route', polarity: 'negated', modality: 'conditional', quantifier: 'all',
    scope: { environment: 'legacy', tenant: 'all' },
    conditions: [{ if: 'feature == "on"', then: 'deny' }],
    valid_time: { start: '2019-01-01', end: '2020-01-01' },
    source_status: 'historical', decision_status: 'proposed',
  });
  const disputed = claimAssertion('claim:disputed', [
    { role: 'subject', mention_id: identityMentions.resolvedB },
  ], { source_status: 'disputed', decision_status: 'accepted', conditions: [{ exact: 'subject to appeal' }] });
  const aspirational = claimAssertion('claim:aspirational', [
    { role: 'subject', literal: 'future-system' },
  ], {
    modality: 'aspirational', source_status: 'aspirational', decision_status: 'implemented',
    valid_time: { start: '2030-01-01', end: null },
  });
  const statementBody = {
    schema: GROUNDED_ASSERTION_SCHEMA,
    assertion_origin: 'identity_receipt',
    basis_evidence_ids: [],
    basis_receipt_ids: [groundingReceipt.receipt_id],
    assertion_schema_version: GROUNDED_ASSERTION_SCHEMA_VERSION,
    predicate_lexeme_id: 'predicate:disputes',
    arguments: [
      { role: 'subject', assertion_id: negated.assertion_id },
      { role: 'object', mention_id: identityMentions.resolvedB },
      { role: 'scope_referent', literal: 'review-board' },
    ],
    polarity: 'affirmed', modality: 'descriptive', quantifier: 'one', scope: ['governance'],
    conditions: [{ exact: 'while appeal is open' }], source_status: 'current', decision_status: 'none',
    epistemic_authority: 'reviewed_resolution', valid_time: { start: '2026-08-01', end: null },
    recorded_time: '2026-08-06T13:00:00.000Z', support_set_ids: ['support:statement'], materialization_id: materializationId,
  };
  const statement = { ...statementBody, assertion_id: groundedAssertionId(statementBody) };
  const assertions = [negated, disputed, aspirational];
  const context = claimContext(assertions);
  return {
    ...context,
    groundedAssertions: [statement],
    groundingRegistry: { evidence_pointers: [], receipts: [groundingReceipt] },
    negated, disputed, aspirational, statement,
  };
}

function servingFixture() {
  const identity = identityFixture();
  const identityResolution = identity.resolution;
  const groundingReceipt = identityResolution.resolution_receipts[0];
  const qualified = qualifiedFixture(groundingReceipt, identity.labels);
  const identityReceiptHistory = {
    resolution_receipts: identityResolution.resolution_receipts,
    referent_identity_keys: [],
  };
  const servingPlane = buildServingAssertionPlane({
    admitted_claims: qualified.admittedClaims,
    claim_projection: qualified.claimProjection,
    grounded_assertions: qualified.groundedAssertions,
    grounding_registry: qualified.groundingRegistry,
    identity_resolution: identityResolution,
    identity_constraints: identity.constraints,
    identity_verification_registry: identity.verificationRegistry,
    identity_receipt_history: identityReceiptHistory,
    identity_head: identityHeadForResolution(identityResolution),
    materialization_id: materializationId,
  });
  return { ...qualified, identityResolution, identityConstraints: identity.constraints,
    identityVerificationRegistry: identity.verificationRegistry,
    identityReceiptHistory, servingPlane };
}

function servingArgs(held, overrides = {}) {
  return {
    admitted_claims: held.admittedClaims,
    claim_projection: held.claimProjection,
    grounded_assertions: held.groundedAssertions,
    grounding_registry: held.groundingRegistry,
    identity_resolution: held.identityResolution,
    identity_constraints: held.identityConstraints,
    identity_verification_registry: held.identityVerificationRegistry,
    identity_receipt_history: held.identityReceiptHistory,
    identity_head: identityHeadForResolution(held.identityResolution),
    materialization_id: materializationId,
    ...overrides,
  };
}

function servingFor(held, assertionId) {
  return held.servingPlane.serving_assertions.find(row => row.assertion_id === assertionId);
}

function supersessionFixture() {
  const oldAssertion = claimAssertion('claim:old', [{ role: 'subject', literal: 'old' }]);
  const middleAssertion = claimAssertion('claim:middle', [{ role: 'subject', literal: 'middle' }]);
  const newAssertion = claimAssertion('claim:new', [{ role: 'subject', literal: 'new' }]);
  const rebindingBasis = bindingReceipt('obligation:old-middle');
  const unrelatedBinding = bindingReceipt('obligation:unrelated-old');
  const context = claimContext([oldAssertion, middleAssertion, newAssertion], new Map([
    [oldAssertion.assertion_id, [unrelatedBinding]],
    [middleAssertion.assertion_id, [rebindingBasis]],
  ]));
  const schemaBasis = context.claimProjection.claim_projection_receipts
    .find(receipt => receipt.assertion_ids.includes(newAssertion.assertion_id));
  const first = buildAssertionSupersessionReceipt({
    old_assertion_id: oldAssertion.assertion_id,
    new_assertion_id: middleAssertion.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [rebindingBasis.receipt_id],
    materialization_id: `${materializationId}:first`,
  });
  const second = buildAssertionSupersessionReceipt({
    old_assertion_id: middleAssertion.assertion_id,
    new_assertion_id: newAssertion.assertion_id,
    cause: 'schema_version', basis_receipt_ids: [schemaBasis.receipt_id],
    materialization_id: `${materializationId}:second`,
  });
  const previousContext = context;
  const previous = buildAssertionSupersessionLedger({
    admitted_claims: previousContext.admittedClaims,
    claim_projection: previousContext.claimProjection,
    grounding_registry: emptyGroundingRegistry(),
    basis_receipts: [rebindingBasis], supersession_receipts: [first],
    materialization_id: `${materializationId}:ledger-1`,
  });
  const ledger = buildAssertionSupersessionLedger({
    admitted_claims: context.admittedClaims,
    claim_projection: context.claimProjection,
    grounding_registry: emptyGroundingRegistry(),
    basis_receipts: [rebindingBasis, schemaBasis], supersession_receipts: [first, second],
    materialization_id: `${materializationId}:ledger-2`,
  });
  return {
    oldAssertion, middleAssertion, newAssertion, rebindingBasis, unrelatedBinding,
    schemaBasis, first, second, previous, ledger, context,
  };
}

function ledgerArgs(context, basisReceipts, supersessionReceipts, overrides = {}) {
  return {
    admitted_claims: context.admittedClaims,
    claim_projection: context.claimProjection,
    grounding_registry: emptyGroundingRegistry(),
    basis_receipts: basisReceipts,
    supersession_receipts: supersessionReceipts,
    materialization_id: materializationId,
    ...overrides,
  };
}

test('[falsifier: qualified assertion] qualifications stay orthogonal and byte-preserved in n-ary and statement-to-statement serving assertions', () => {
  const held = servingFixture();
  const result = verifyServingAssertionPlane({
    ...servingArgs(held),
    serving_plane: held.servingPlane,
  });
  assert.equal(result.serving_assertions, 4);
  for (const raw of [held.negated, held.disputed, held.aspirational, held.statement]) {
    assert.deepEqual(servingFor(held, raw.assertion_id).raw_assertion, raw);
  }
  const changed = structuredClone(held.servingPlane);
  changed.serving_assertions.find(row => row.assertion_id === held.negated.assertion_id).raw_assertion.polarity = 'affirmed';
  assert.throws(() => verifyServingAssertionPlane({ ...servingArgs(held), serving_plane: changed }),
    error => error.code === 'SERVING_ASSERTION_PLANE_MISMATCH');
});

test('[falsifier: selected resolution] mappings require the exact selected receipt; blocked and unresolved arguments retain conflict provenance; literals remain literals', () => {
  const held = servingFixture();
  const [resolved, unresolved, blocked, literal] = servingFor(held, held.negated.assertion_id).selected_arguments;
  assert.deepEqual([resolved.argument_kind, unresolved.resolution_state, blocked.resolution_state, literal.argument_kind],
    ['referent', 'unresolved', 'blocked', 'literal']);
  assert.ok(resolved.resolution_receipt);
  assert.ok(blocked.conflicts.length);
  const forged = structuredClone(held.identityResolution);
  forged.mention_resolutions[0].resolution_receipt_id = 'resolution-receipt:forged';
  rehashIdentityResolution(forged);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    identity_resolution: forged,
    identity_receipt_history: {
      resolution_receipts: forged.resolution_receipts,
      referent_identity_keys: [],
    },
    identity_head: identityHeadForResolution(forged),
  })), error => error.code === 'FORGED_MENTION_RESOLUTION');
});

test('[falsifier: assertion independence] identity head, referent, lifecycle, and resolution receipt never alter raw ClaimAssertion IDs', () => {
  const held = qualifiedFixture();
  for (const assertion of held.claimProjection.assertions) {
    assert.equal(claimAssertionId({
      ...assertion,
      identity_head: 'identity-head:changed', referent_id: 'referent:changed',
      lifecycle_state: 'tombstoned', resolution_receipt_id: 'resolution-receipt:changed',
      predicate_concept_id: 'concept:changed', ontology_head: 'ontology:changed',
    }), assertion.assertion_id);
  }
});

test('[falsifier: assertion supersession] grounded append-only chains resolve to one selected tip and fail closed on structural defects', () => {
  const held = supersessionFixture();
  assert.equal(verifyAppendOnlyAssertionSupersession({ previous: held.previous, next: held.ledger }), true);
  const resolved = resolveAssertionSupersession({ assertion_id: held.oldAssertion.assertion_id, ledger: held.ledger });
  assert.deepEqual(resolved.assertion_chain,
    [held.oldAssertion.assertion_id, held.middleAssertion.assertion_id, held.newAssertion.assertion_id]);
  assert.throws(() => buildAssertionSupersessionReceipt({
    old_assertion_id: 'assertion:same', new_assertion_id: 'assertion:same', cause: 'rebinding',
    basis_receipt_ids: ['receipt:ground'], materialization_id: materializationId,
  }), error => error.code === 'SAME_ASSERTION_SUPERSESSION');
  const fork = buildAssertionSupersessionReceipt({
    old_assertion_id: held.oldAssertion.assertion_id, new_assertion_id: held.newAssertion.assertion_id,
    cause: 'claim_supersession', basis_receipt_ids: [held.schemaBasis.receipt_id], materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(held.context,
    [held.rebindingBasis, held.schemaBasis], [held.first, fork])),
  error => error.code === 'ASSERTION_SUPERSESSION_FORK');
});

test('[falsifier: dependent references] active references need an explicit qualifying frozen result; scenarios stay pinned historical with the complete chain', () => {
  const held = supersessionFixture();
  const references = [
    { reference_id: 'reference:serving', reference_kind: 'active_serving', assertion_id: held.oldAssertion.assertion_id },
    { reference_id: 'reference:relation', reference_kind: 'relation', assertion_id: held.oldAssertion.assertion_id },
    { reference_id: 'reference:scenario', reference_kind: 'scenario', assertion_id: held.oldAssertion.assertion_id },
  ];
  const relationPolicy = buildFrozenReferencePolicyResult({
    reference_id: 'reference:relation', reference_kind: 'relation',
    requested_assertion_id: held.oldAssertion.assertion_id,
    selected_tip_assertion_id: held.newAssertion.assertion_id,
    policy_id: 'policy:rel-frozen', policy_version: 'rel-policy@1', qualifies: true,
    materialization_id: `${materializationId}:references`,
  });
  const reconciliation = reconcileDependentReferences({
    references, supersession_ledger: held.ledger, frozen_policy_results: [relationPolicy],
    materialization_id: `${materializationId}:references`,
  });
  assert.equal(verifyDependentReferenceReconciliation({
    references, supersession_ledger: held.ledger, frozen_policy_results: [relationPolicy], reconciliation,
  }), true);
  const byId = new Map(reconciliation.reconciled_references.map(row => [row.reference_id, row]));
  assert.equal(byId.get('reference:serving').reference_state, 'historical');
  assert.equal(byId.get('reference:relation').selected_assertion_id, held.newAssertion.assertion_id);
  assert.equal(byId.get('reference:scenario').reference_state, 'pinned_historical');
});

test('[F1 regression] GroundedAssertion and ClaimAssertion intake rejects fabricated identity, missing basis, unknown fields, and schema impersonation', () => {
  const held = servingFixture();
  const fabricated = structuredClone(held.statement);
  fabricated.assertion_id = 'grounded-assertion:fabricated';
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { grounded_assertions: [fabricated] })),
    error => error.code === 'INVALID_GROUNDED_ASSERTION_ID');
  const ungrounded = structuredClone(held.statement);
  ungrounded.basis_receipt_ids = [];
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    grounded_assertions: [ungrounded], grounding_registry: emptyGroundingRegistry(),
  })), error => error.code === 'UNGROUNDED_ASSERTION');
  const downstream = structuredClone(held.claimProjection);
  downstream.assertions[0].referent_id = 'referent:impersonated';
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { claim_projection: downstream })),
    error => error.code === 'INVALID_C1_RECORD_SHAPE');
});

test('[F2 regression] direct referent arguments require a validated Referent in the selected identity resolution', () => {
  const held = servingFixture();
  const statement = structuredClone(held.statement);
  statement.arguments = [{ role: 'subject', referent_id: held.identityResolution.referents[0].referent_id }];
  statement.assertion_id = groundedAssertionId(statement);
  assert.equal(buildServingAssertionPlane(servingArgs(held, { grounded_assertions: [statement] })).serving_assertions.length, 4);
  statement.arguments = [{ role: 'subject', referent_id: 'referent:nonexistent' }];
  statement.assertion_id = groundedAssertionId(statement);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { grounded_assertions: [statement] })),
    error => error.code === 'MISSING_REFERENT_ARGUMENT');
});

test('[F3 regression] supersession basis accepts only closed deterministic Phase A receipt contracts', () => {
  const held = supersessionFixture();
  for (const basis of [
    { receipt_id: held.rebindingBasis.receipt_id },
    { schema: 'estate-map/unknown-receipt/v1', receipt_id: 'receipt:unknown' },
  ]) {
    assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
      claimContext([held.oldAssertion, held.middleAssertion]), [basis], [held.first])),
    error => error.code === 'INVALID_SUPERSESSION_BASIS_RECEIPT');
  }
});

test('[F4 regression] selected identity records preserve complete partitions and pair resolution with its digest-committed head', () => {
  const held = servingFixture();
  const truncated = structuredClone(held.identityResolution);
  truncated.components.pop();
  rehashIdentityResolution(truncated);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    identity_resolution: truncated,
    identity_receipt_history: { resolution_receipts: truncated.resolution_receipts, referent_identity_keys: [] },
    identity_head: identityHeadForResolution(truncated),
  })), error => error.code === 'IDENTITY_COMPONENT_PARTITION_MISMATCH');
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { identity_head: null })),
    error => error.code === 'IDENTITY_SELECTION_PAIR_MISMATCH');
  const home = buildServingAssertionPlane(servingArgs(held, {
    identity_resolution: null, identity_constraints: [],
    identity_receipt_history: emptyIdentityHistory(), identity_head: null,
  }));
  assert.equal(home.identity_resolution_digest, null);
});

test('[falsifier B1 serving boundary] a hash-valid unsupported basis is refused before constraint-set conservation', () => {
  const held = servingFixture();
  const real = held.identityConstraints.find(row => row.disposition === 'must_link');
  const { constraint_id: _constraintId, ...body } = real;
  const forgedBody = { ...body, basis: { kind: 'normalized_surface_equality' } };
  const forged = { ...forgedBody, constraint_id: hashId('identity-constraint', forgedBody) };
  const remaining = held.identityConstraints.filter(row => row.constraint_id !== real.constraint_id);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    identity_constraints: [forged, ...remaining],
  })), error => error.code === 'UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS'
    && error.detail.producer_code === 'UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS');
});

test('[falsifier B9] an identity key that is not receipt-bound is powerless at serving', () => {
  const held = servingFixture();
  const opaqueReferentId = held.identityResolution.referents[0].referent_id;
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    identity_receipt_history: {
      resolution_receipts: held.identityResolution.resolution_receipts,
      referent_identity_keys: [{ referent_id: opaqueReferentId,
        identity_key: { namespace_key: 'forged-namespace', local_id: 'sidecar-authority' } }],
    },
  })), error => error.code === 'IDENTITY_KEY_SIDECAR_UNBOUND');
});

test('serving refuses an otherwise-valid selected must-link when its truth registry is omitted', () => {
  const held = servingFixture();
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    identity_verification_registry: null,
  })), error => error.code === 'IDENTITY_VERIFICATION_REGISTRY_REQUIRED'
    && error.detail.producer_code === 'IDENTITY_VERIFICATION_REGISTRY_REQUIRED');
});

test('[F5 regression] every supersession consumer rejects hand-written, truncated, mutated, and graph-invalid ledgers', () => {
  const held = supersessionFixture();
  assert.throws(() => resolveAssertionSupersession({
    assertion_id: held.oldAssertion.assertion_id,
    ledger: { assertions: held.ledger.assertions },
  }), error => error.code === 'INVALID_C1_RECORD_SHAPE');
  const truncated = structuredClone(held.ledger);
  truncated.selected_tips.pop();
  assert.throws(() => resolveAssertionSupersession({ assertion_id: held.oldAssertion.assertion_id, ledger: truncated }),
    error => error.code === 'INVALID_ASSERTION_SUPERSESSION_LEDGER');
  const corrupted = structuredClone(held.previous);
  corrupted.digest = 'digest:forged';
  assert.throws(() => verifyAppendOnlyAssertionSupersession({ previous: corrupted, next: held.ledger }),
    error => error.code === 'INVALID_ASSERTION_SUPERSESSION_LEDGER');
  const omittedAuthority = structuredClone(held.ledger);
  delete omittedAuthority.claim_projection;
  assert.throws(() => resolveAssertionSupersession({
    assertion_id: held.oldAssertion.assertion_id, ledger: omittedAuthority,
  }), error => error.code === 'INVALID_C1_RECORD_SHAPE');
  const replacedAuthority = structuredClone(held.ledger);
  replacedAuthority.claim_projection.argument_binding_coverage_receipts = [];
  assert.throws(() => resolveAssertionSupersession({
    assertion_id: held.oldAssertion.assertion_id, ledger: replacedAuthority,
  }), error => error.code === 'MISSING_ARGUMENT_BINDING_RECEIPT');
});

test('[F6 regression] frozen policy results cannot cross reconciliation materializations or target another chain', () => {
  const held = supersessionFixture();
  const references = [{
    reference_id: 'reference:relation', reference_kind: 'relation', assertion_id: held.oldAssertion.assertion_id,
  }];
  const crossed = buildFrozenReferencePolicyResult({
    reference_id: 'reference:relation', reference_kind: 'relation',
    requested_assertion_id: held.oldAssertion.assertion_id,
    selected_tip_assertion_id: held.newAssertion.assertion_id,
    policy_id: 'policy:crossed', policy_version: 'policy@1', qualifies: true,
    materialization_id: 'materialization:other',
  });
  assert.throws(() => reconcileDependentReferences({
    references, supersession_ledger: held.ledger, frozen_policy_results: [crossed], materialization_id: materializationId,
  }), error => error.code === 'FROZEN_POLICY_MATERIALIZATION_MISMATCH');
});

test('[F7 regression] statement references reject self-reference and preserve a different existing assertion', () => {
  const held = servingFixture();
  assert.equal(servingFor(held, held.statement.assertion_id).selected_arguments[0].assertion_id,
    held.negated.assertion_id);
  const self = structuredClone(held.statement);
  self.arguments = [{ role: 'subject', assertion_id: self.assertion_id }];
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { grounded_assertions: [self] })),
    error => error.code === 'SELF_ASSERTION_ARGUMENT');
});

test('[R2-1 regression] every GroundedAssertion basis resolves exactly once to producer-valid evidence or receipt rows', () => {
  const held = servingFixture();
  const unresolved = structuredClone(held.statement);
  unresolved.basis_receipt_ids = ['resolution-receipt:statement'];
  unresolved.assertion_id = groundedAssertionId(unresolved);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { grounded_assertions: [unresolved] })),
    error => error.code === 'UNRESOLVED_GROUNDING_BASIS');
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    grounding_registry: {
      evidence_pointers: [],
      receipts: [held.groundingRegistry.receipts[0], held.groundingRegistry.receipts[0]],
    },
  })), error => error.code === 'DUPLICATE_GROUNDING_RECORD');

  const firstEvidence = buildEvidencePointer({
    source_version_id: 'source-version:first',
    pointer: {
      kind: 'repository_metadata', manifest_id: 'manifest:first', repository_id: 'repository:first',
      field_path: 'visibility', exact_value: 'private', digest: sha256('private'),
    },
  });
  const secondEvidence = buildEvidencePointer({
    source_version_id: 'source-version:second',
    pointer: {
      kind: 'repository_metadata', manifest_id: 'manifest:second', repository_id: 'repository:second',
      field_path: 'visibility', exact_value: 'private', digest: sha256('private'),
    },
  });
  const grounded = [firstEvidence, secondEvidence].map(evidence => {
    const body = {
      ...held.statement,
      basis_evidence_ids: [evidence.evidence_id],
      basis_receipt_ids: [],
    };
    delete body.assertion_id;
    return { ...body, assertion_id: groundedAssertionId(body) };
  });
  const plane = buildServingAssertionPlane(servingArgs(held, {
    grounded_assertions: grounded,
    grounding_registry: { evidence_pointers: [firstEvidence, secondEvidence], receipts: [] },
  }));
  assert.equal(plane.serving_assertions.length, 5);
});

test('[R2-2 regression] serving intake conserves the explicit admitted DocumentaryClaim plane and rejects orphan favorable receipts', () => {
  const held = servingFixture();
  const changedClaims = structuredClone(held.admittedClaims);
  changedClaims[0].semantic.predicate_lexeme = 'changed-outside-projection';
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { admitted_claims: changedClaims })),
    error => error.code === 'CLAIM_BYTES_CHANGED');
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    admitted_claims: [...held.admittedClaims, held.admittedClaims[0]],
  })), error => error.code === 'DUPLICATE_ADMITTED_CLAIM');

  const orphan = structuredClone(held.claimProjection);
  const orphanAssertion = claimAssertion('claim:orphan', [{ role: 'subject', literal: 'orphan' }]);
  orphan.claim_projection_receipts.push(projectionReceipt('claim:orphan', [orphanAssertion.assertion_id]));
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { claim_projection: orphan })),
    error => error.code === 'UNADMITTED_PROJECTION_RECEIPT');
});

test('[R2-3 regression] independent self-consistent claim projections cannot become their own admission authority', () => {
  const held = servingFixture();
  const independentAssertion = claimAssertion('claim:independent', [{ role: 'subject', literal: 'independent' }]);
  const independent = claimContext([independentAssertion]);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, {
    claim_projection: independent.claimProjection,
  })), error => error.code === 'CLAIM_BYTES_CHANGED');
});

function identityWithPrior(identityKind, identityKey) {
  const left = fixtureDocumentMention(`prior-${identityKind}-a`, 'legacy-prior', 'subject');
  const right = fixtureDocumentMention(`prior-${identityKind}-b`, 'canonical-prior', 'object');
  const alias = claimContext([claimAssertion(`claim:prior-alias:${identityKind}`, [
    { role: 'subject', mention_id: left.mention.mention_id },
    { role: 'object', mention_id: right.mention.mention_id },
  ])]);
  const aliasAssertion = alias.claimProjection.assertions[0];
  const aliasReceipt = alias.claimProjection.claim_projection_receipts[0];
  const verificationRegistry = buildIdentityVerificationRegistry({
    mentions: [left.mention, right.mention], evidence_pointers: [left.evidence, right.evidence],
    assertions: [aliasAssertion], receipts: [aliasReceipt],
  });
  const temporary = buildReferent({
    identity_kind: identityKind,
    creation_receipt_id: 'resolution-receipt:temporary',
    identity_key: identityKey,
  });
  const mentionIds = [left.mention.mention_id, right.mention.mention_id];
  const priorReceipt = buildResolutionReceipt({
    candidate_mention_ids: mentionIds, selected_referent_id: temporary.referent_id,
    disposition: 'resolved', admitted_mention_ids: mentionIds,
    materialization_id: `${materializationId}:prior`,
    identity_key: identityKey,
  });
  const referent = buildReferent({
    identity_kind: identityKind,
    creation_receipt_id: priorReceipt.receipt_id,
    identity_key: identityKey,
  });
  const constraint = buildAutomaticIdentityConstraint({
    left: mentionIds[0], right: mentionIds[1],
    basis: { kind: 'source_cited_alias', alias_assertion_id: aliasAssertion.assertion_id },
    basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
    basis_assertion_ids: [aliasAssertion.assertion_id],
    source_status: 'current', materialization_id: materializationId,
  }, verificationRegistry);
  const resolution = resolveIdentityComponents({
    mention_ids: mentionIds, identity_constraints: [constraint],
    prior_resolution_receipts: [priorReceipt], prior_referents: [referent],
    materialization_id: materializationId,
    identity_verification_registry: verificationRegistry,
  });
  return {
    constraint, verificationRegistry,
    resolution,
    history: {
      resolution_receipts: [priorReceipt, ...resolution.resolution_receipts],
      referent_identity_keys: [{ referent_id: referent.referent_id, identity_key: identityKey }],
    },
    referent,
  };
}

test('[R2-4 regression] direct Referents require producer-valid creation provenance while legitimate prior source-native and namespace Referents work', () => {
  for (const [kind, key] of [
    ['source_native', { connector: 'git', native_id: 'repo-42', native_version_id: 'sha-1' }],
    ['deterministic_namespace', { namespace_key: 'service-catalog', local_id: 'payments' }],
  ]) {
    const identity = identityWithPrior(kind, key);
    const held = qualifiedFixture(identity.resolution.resolution_receipts[0]);
    const literalContext = claimContext([
      claimAssertion(`claim:direct:${kind}`, [{ role: 'subject', literal: 'direct-referent-fixture' }]),
    ]);
    const direct = structuredClone(held.statement);
    direct.arguments = [{ role: 'subject', referent_id: identity.referent.referent_id }];
    direct.assertion_id = groundedAssertionId(direct);
    const plane = buildServingAssertionPlane({
      admitted_claims: literalContext.admittedClaims, claim_projection: literalContext.claimProjection,
      grounded_assertions: [direct], grounding_registry: held.groundingRegistry,
      identity_resolution: identity.resolution, identity_constraints: [identity.constraint],
      identity_verification_registry: identity.verificationRegistry,
      identity_receipt_history: identity.history,
      identity_head: identityHeadForResolution(identity.resolution), materialization_id: materializationId,
    });
    assert.equal(plane.serving_assertions.length, 2);

    const fabricated = structuredClone(identity.resolution);
    fabricated.referents[0].identity_kind = kind === 'source_native'
      ? 'deterministic_namespace' : 'source_native';
    rehashIdentityResolution(fabricated);
    assert.throws(() => buildServingAssertionPlane({
      admitted_claims: literalContext.admittedClaims, claim_projection: literalContext.claimProjection,
      grounded_assertions: [direct], grounding_registry: held.groundingRegistry,
      identity_resolution: fabricated, identity_constraints: [identity.constraint],
      identity_verification_registry: identity.verificationRegistry,
      identity_receipt_history: identity.history,
      identity_head: identityHeadForResolution(fabricated), materialization_id: materializationId,
    }), error => error.code === 'INVALID_REFERENT');
  }

  const held = servingFixture();
  const missing = { resolution_receipts: held.identityResolution.resolution_receipts, referent_identity_keys: [] };
  missing.resolution_receipts = missing.resolution_receipts
    .filter(row => row.receipt_id !== held.identityResolution.referents[0].creation_receipt_id);
  assert.throws(() => buildServingAssertionPlane(servingArgs(held, { identity_receipt_history: missing })),
    error => ['INCOMPLETE_IDENTITY_RECEIPT_HISTORY', 'MISSING_REFERENT_CREATION_PROVENANCE'].includes(error.code));
});

test('[R2-5 regression] selected identity resolution covers every served mention while both-null home mode remains mention-local', () => {
  const held = servingFixture();
  const extra = claimAssertion('claim:coverage-gap', [{ role: 'subject', mention_id: 'mention:not-selected' }]);
  const context = claimContext([...held.claimProjection.assertions, extra]);
  assert.throws(() => buildServingAssertionPlane({
    admitted_claims: context.admittedClaims, claim_projection: context.claimProjection,
    grounded_assertions: held.groundedAssertions, grounding_registry: held.groundingRegistry,
    identity_resolution: held.identityResolution, identity_constraints: held.identityConstraints,
    identity_verification_registry: held.identityVerificationRegistry,
    identity_receipt_history: held.identityReceiptHistory,
    identity_head: identityHeadForResolution(held.identityResolution), materialization_id: materializationId,
  }), error => error.code === 'IDENTITY_MENTION_COVERAGE_MISMATCH');
  const batchBody = {
    schema: 'estate-map/identity-candidate-batch-receipt/v1',
    total_candidates: 1, selected_candidate_count: 0,
    not_evaluated_in_this_batch_count: 1,
    candidate_rows: [{ component_id: 'component:pending', fact_id: 'fact:pending',
      mention_id: 'mention:not-selected', evaluation_state: 'not_evaluated_in_this_batch',
      schedule_state: 'deferred' }],
  };
  const batchReceipt = { ...batchBody,
    receipt_id: hashId('identity-candidate-batch-receipt', batchBody) };
  const bounded = buildServingAssertionPlane({
    admitted_claims: context.admittedClaims, claim_projection: context.claimProjection,
    grounded_assertions: held.groundedAssertions, grounding_registry: held.groundingRegistry,
    identity_resolution: held.identityResolution, identity_constraints: held.identityConstraints,
    identity_verification_registry: held.identityVerificationRegistry,
    identity_receipt_history: held.identityReceiptHistory,
    identity_batch_receipt: batchReceipt,
    identity_head: identityHeadForResolution(held.identityResolution), materialization_id: materializationId,
  });
  const pending = bounded.serving_assertions
    .find(row => row.assertion_id === extra.assertion_id).selected_arguments[0];
  assert.deepEqual({ state: pending.resolution_state, receipt: pending.resolution_receipt_id,
    semantic_disposition: pending.disposition },
  { state: 'not_evaluated_in_this_batch', receipt: null, semantic_disposition: undefined });
  const home = buildServingAssertionPlane({
    admitted_claims: context.admittedClaims, claim_projection: context.claimProjection,
    grounded_assertions: held.groundedAssertions, grounding_registry: held.groundingRegistry,
    identity_resolution: null, identity_receipt_history: emptyIdentityHistory(), identity_head: null,
    materialization_id: materializationId,
  });
  const selected = home.serving_assertions.find(row => row.assertion_id === extra.assertion_id).selected_arguments[0];
  assert.equal(selected.resolution_state, 'no_selected_resolution');
});

test('[R2-6 regression] supersession endpoints must be validated assertion records under preserved claim and grounding registries', () => {
  const held = supersessionFixture();
  const arbitrary = buildAssertionSupersessionReceipt({
    old_assertion_id: 'assertion:arbitrary-old', new_assertion_id: 'assertion:arbitrary-new',
    cause: 'rebinding', basis_receipt_ids: [held.rebindingBasis.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(held.context,
    [held.rebindingBasis], [arbitrary])),
  error => error.code === 'MISSING_ASSERTION_SUPERSESSION_ENDPOINT');
  assert.deepEqual(held.ledger.admitted_claims, held.context.admittedClaims);
  assert.deepEqual(held.ledger.grounding_registry, emptyGroundingRegistry());
});

test('[R2-7 / FINAL-1 E13-E15 regression] supersession basis is producer-compatible, conserved, and connected to the new assertion', () => {
  const held = supersessionFixture();
  const projectionRebinding = buildAssertionSupersessionReceipt({
    old_assertion_id: held.oldAssertion.assertion_id,
    new_assertion_id: held.middleAssertion.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [held.schemaBasis.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [held.schemaBasis], [projectionRebinding])),
  error => error.code === 'INCOMPATIBLE_ASSERTION_SUPERSESSION_BASIS');

  const resolutionBasis = buildResolutionReceipt({
    candidate_mention_ids: ['mention:phase-b'], disposition: 'unresolved',
    excluded_mention_ids: ['mention:phase-b'], materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    claimContext([held.oldAssertion, held.middleAssertion]), [resolutionBasis], [held.first])),
  error => error.code === 'INVALID_SUPERSESSION_BASIS_RECEIPT');

  const bindingSchema = buildAssertionSupersessionReceipt({
    old_assertion_id: held.middleAssertion.assertion_id,
    new_assertion_id: held.newAssertion.assertion_id,
    cause: 'schema_version', basis_receipt_ids: [held.rebindingBasis.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [held.rebindingBasis], [bindingSchema])),
  error => error.code === 'INCOMPATIBLE_ASSERTION_SUPERSESSION_BASIS');

  const unknownProjection = projectionReceipt('claim:unknown', [held.newAssertion.assertion_id]);
  const e13 = buildAssertionSupersessionReceipt({
    old_assertion_id: held.middleAssertion.assertion_id,
    new_assertion_id: held.newAssertion.assertion_id,
    cause: 'schema_version', basis_receipt_ids: [unknownProjection.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [unknownProjection], [e13])),
  error => error.code === 'SUPERSESSION_BASIS_CONSERVATION_MISMATCH');

  const unrelatedProjection = held.context.claimProjection.claim_projection_receipts
    .find(receipt => receipt.assertion_ids.includes(held.oldAssertion.assertion_id));
  const e14 = buildAssertionSupersessionReceipt({
    old_assertion_id: held.middleAssertion.assertion_id,
    new_assertion_id: held.newAssertion.assertion_id,
    cause: 'claim_supersession', basis_receipt_ids: [unrelatedProjection.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [unrelatedProjection], [e14])),
  error => error.code === 'UNCONNECTED_ASSERTION_SUPERSESSION_BASIS');

  const unknownBinding = bindingReceipt('obligation:unknown');
  const e15 = buildAssertionSupersessionReceipt({
    old_assertion_id: held.oldAssertion.assertion_id,
    new_assertion_id: held.middleAssertion.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [unknownBinding.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [unknownBinding], [e15])),
  error => error.code === 'SUPERSESSION_BASIS_CONSERVATION_MISMATCH');

  const byteDifferentLookalike = bindingReceipt(held.rebindingBasis.obligation_id, []);
  const lookalikeRebinding = buildAssertionSupersessionReceipt({
    old_assertion_id: held.oldAssertion.assertion_id,
    new_assertion_id: held.middleAssertion.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [byteDifferentLookalike.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [byteDifferentLookalike], [lookalikeRebinding])),
  error => error.code === 'SUPERSESSION_BASIS_CONSERVATION_MISMATCH');

  const unrelatedBinding = buildAssertionSupersessionReceipt({
    old_assertion_id: held.oldAssertion.assertion_id,
    new_assertion_id: held.middleAssertion.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [held.unrelatedBinding.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger(ledgerArgs(
    held.context, [held.unrelatedBinding], [unrelatedBinding])),
  error => error.code === 'UNCONNECTED_ASSERTION_SUPERSESSION_BASIS');

  const grounded = qualifiedFixture();
  const groundedBinding = bindingReceipt('obligation:grounded-endpoint');
  const groundedProjection = structuredClone(grounded.claimProjection);
  groundedProjection.argument_binding_coverage_receipts.push(groundedBinding);
  const groundedRebinding = buildAssertionSupersessionReceipt({
    old_assertion_id: grounded.negated.assertion_id,
    new_assertion_id: grounded.statement.assertion_id,
    cause: 'rebinding', basis_receipt_ids: [groundedBinding.receipt_id],
    materialization_id: materializationId,
  });
  assert.throws(() => buildAssertionSupersessionLedger({
    admitted_claims: grounded.admittedClaims,
    claim_projection: groundedProjection,
    grounded_assertions: grounded.groundedAssertions,
    grounding_registry: grounded.groundingRegistry,
    basis_receipts: [groundedBinding],
    supersession_receipts: [groundedRebinding],
    materialization_id: materializationId,
  }), error => error.code === 'GROUNDED_ASSERTION_REBINDING_UNSUPPORTED');
});
