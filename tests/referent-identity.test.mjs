import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendIdentityLedger, buildAutomaticIdentityConstraint, buildForgeLocatorIdentity,
  buildIdentityConstraint, buildIdentityLedger, buildIdentityLifecycleRecord,
  buildComponentIdentityDecision, buildIdentityVerificationRegistry, buildReferent,
  buildReviewedResolutionDependency, buildVerifiedComponentIdentityDecision,
  COMPONENT_NAMESPACE_KEY_SCHEMA,
  buildReviewedResolutionReceipt, resolveIdentityComponents, resolveSupersededReferent,
  verifyAppendOnlyIdentityLedger, verifyForgeLocatorIdentity, verifyIdentityConstraint,
  verifyIdentityResolution,
} from '../tools/referent-identity.mjs';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_RECEIPT_SCHEMA,
  CLAIM_PROJECTION_SCHEMA_VERSION,
} from '../tools/claim-projection.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const materializationId = 'materialization:b1-fixture';
const current = 'current';

// C4 design section 7, falsifier B1. Previously a specification only: the resolver validated
// schema and recomputed hash, then built adjacency, so a hand-written constraint carrying an
// inadmissible basis and an honestly recomputed content-addressed id was admitted as a real edge.
test('[falsifier B1] a hash-valid constraint with an inadmissible basis is refused before adjacency', () => {
  const real = buildAutomaticIdentityConstraint({
    left: 'mention:a', right: 'mention:b',
    basis: { kind: 'exact_defined_term_identity', namespace_key: 'ns', exact_term: 'term',
      definition_evidence_id: 'evidence:definition' },
    basis_evidence_ids: ['evidence:a', 'evidence:b'],
    source_status: current, valid_time: null, materialization_id: materializationId,
  });
  const { constraint_id: _issued, ...body } = real;
  const forgedBody = { ...body, basis: { kind: 'normalized_surface_equality' } };
  const forged = { ...forgedBody,
    constraint_id: `identity-constraint:${sha256(stableStringify(forgedBody).trim())}` };

  const codeOf = action => { try { action(); return 'ACCEPTED'; } catch (error) { return error.code; } };
  assert.deepEqual({
    forged_hash_is_self_consistent:
      forged.constraint_id === `identity-constraint:${sha256(stableStringify(forgedBody).trim())}`,
    verifier: codeOf(() => verifyIdentityConstraint(forged)),
    resolver: codeOf(() => resolveIdentityComponents({
      mention_ids: ['mention:a', 'mention:b'], identity_constraints: [forged],
      materialization_id: materializationId,
    })),
    producer_valid_constraint: codeOf(() => verifyIdentityConstraint(real)),
  }, {
    forged_hash_is_self_consistent: true,
    verifier: 'UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS',
    resolver: 'UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS',
    producer_valid_constraint: 'ACCEPTED',
  });
});
const evidence = suffix => [`evidence:${suffix}`];

function automatic(left, right, basis, suffix = `${left}:${right}`) {
  return buildAutomaticIdentityConstraint({
    left,
    right,
    basis,
    basis_evidence_ids: evidence(suffix),
    source_status: current,
    valid_time: { start: '2026-01-01', end: null },
    materialization_id: materializationId,
  });
}

function alias(left, right, assertionId) {
  return buildAutomaticIdentityConstraint({
    left,
    right,
    basis: { kind: 'source_cited_alias', alias_assertion_id: assertionId },
    basis_assertion_ids: [assertionId],
    source_status: current,
    materialization_id: materializationId,
  });
}

function blocker(left, right, constraintKind = 'identity') {
  return buildIdentityConstraint({
    left,
    right,
    disposition: 'cannot_link',
    constraint_kind: constraintKind,
    basis: { kind: constraintKind === 'identity' ? 'explicit_cannot_link' : `${constraintKind}_conflict` },
    basis_evidence_ids: evidence(`${constraintKind}:${left}:${right}`),
    source_status: current,
    valid_time: { start: '2026-01-01', end: '2026-12-31' },
    authority: 'source_explicit',
    materialization_id: materializationId,
  });
}

function reviewed(left, right, receiptId, dependencyIds = ['evidence:review']) {
  return automatic(left, right, {
    kind: 'prior_reviewed_resolution',
    receipt_id: receiptId,
    dependency_ids: dependencyIds,
    dependencies_valid: true,
  });
}

const hashId = (prefix, body) => `${prefix}:${sha256(stableStringify(body).trim())}`;

function graphFixture(labels, aliasEdges) {
  const endpointByLabel = new Map(labels.map((label, index) => {
    const surface = `identity-${label}`;
    const evidencePointer = buildEvidencePointer({
      source_version_id: 'source-version:referent-identity-fixture',
      pointer: { kind: 'document_span', file: 'fixtures/referent-identity.md',
        start: index + 1, end: index + 1, byte_start: index * 100,
        byte_end: index * 100 + Buffer.byteLength(surface), exact_text: surface,
        digest: sha256(surface) },
    });
    return [label, buildMention({ evidence_pointer: evidencePointer, surface,
      role: index % 2 ? 'object' : 'subject', provenance_class: 'fixture',
      namespace: 'fixtures/referent-identity.md', source_status: current,
      context_digest: sha256(`context:${label}`), disposition: 'identity_candidate' })];
  }));
  const aliases = aliasEdges.map(({ left, right, label }) => {
    const leftId = endpointByLabel.get(left).mention.mention_id;
    const rightId = endpointByLabel.get(right).mention.mention_id;
    const basisClaimId = `claim:identity-alias:${label}`;
    const argumentMentions = [
      { role: 'subject', mention_id: leftId }, { role: 'object', mention_id: rightId },
    ];
    const assertionId = claimAssertionId({ basis_claim_id: basisClaimId,
      argument_mentions: argumentMentions });
    const receiptBody = {
      schema: CLAIM_PROJECTION_RECEIPT_SCHEMA, basis_claim_id: basisClaimId,
      disposition: 'fully_projected', assertion_ids: [assertionId],
      argument_binding_receipt_ids: [], findings: [],
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
      materialization_id: materializationId,
    };
    const receipt = { ...receiptBody, receipt_id: hashId('claim-projection-receipt', receiptBody) };
    const assertion = {
      schema: CLAIM_ASSERTION_SCHEMA, assertion_id: assertionId, basis_claim_id: basisClaimId,
      argument_mentions: argumentMentions, projection_receipt_id: receipt.receipt_id,
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    };
    return { left, right, label, assertion, receipt };
  });
  const endpoints = [...endpointByLabel.values()];
  const registry = buildIdentityVerificationRegistry({
    mentions: endpoints.map(row => row.mention), evidence_pointers: endpoints.map(row => row.evidence),
    assertions: aliases.map(row => row.assertion), receipts: aliases.map(row => row.receipt),
  });
  const mentionId = label => endpointByLabel.get(label).mention.mention_id;
  const aliasConstraint = label => {
    const row = aliases.find(candidate => candidate.label === label);
    const left = endpointByLabel.get(row.left), right = endpointByLabel.get(row.right);
    return buildAutomaticIdentityConstraint({
      left: left.mention.mention_id, right: right.mention.mention_id,
      basis: { kind: 'source_cited_alias', alias_assertion_id: row.assertion.assertion_id },
      basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
      basis_assertion_ids: [row.assertion.assertion_id], source_status: current,
      materialization_id: materializationId,
    }, registry);
  };
  const blockingConstraint = (leftLabel, rightLabel, constraintKind = 'identity') => {
    const left = endpointByLabel.get(leftLabel), right = endpointByLabel.get(rightLabel);
    return buildIdentityConstraint({
      left: left.mention.mention_id, right: right.mention.mention_id,
      disposition: 'cannot_link', constraint_kind: constraintKind,
      basis: { kind: constraintKind === 'identity' ? 'explicit_cannot_link' : `${constraintKind}_conflict` },
      basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
      source_status: current, valid_time: { start: '2026-01-01', end: '2026-12-31' },
      authority: 'source_explicit', materialization_id: materializationId,
    });
  };
  return { endpointByLabel, mentionId, mentionIds: labels.map(mentionId), registry,
    aliasConstraint, blockingConstraint, aliases };
}

test('[falsifier B12] a valid singleton resolves only through a verified identity decision', () => {
  const record = {
    kind: 'sqlite_table', repo: 'fixtures', file: 'schema.sql', line: 1, table: 'jobs',
  };
  const evidencePointer = buildEvidencePointer({
    source_version_id: 'code-plane:verified-singleton',
    pointer: {
      kind: 'structured_record', record_id: 'code-fact:verified-singleton',
      schema_id: 'estate-map/extracted-code-fact/v1', field_path: '$', exact_value: record,
      digest: sha256(stableStringify(record).trim()),
    },
  });
  const mention = buildMention({
    evidence_pointer: evidencePointer, surface: 'jobs', role: 'structured_metadata',
    provenance_class: 'unclassified', namespace: 'fixtures/schema.sql', source_status: current,
    context_digest: evidencePointer.pointer.digest, disposition: 'identity_candidate',
  }).mention;
  const mentionIds = [mention.mention_id];
  const registry = buildIdentityVerificationRegistry({
    mentions: [mention], evidence_pointers: [evidencePointer],
  });
  const identityKey = {
    namespace_key: {
      schema: COMPONENT_NAMESPACE_KEY_SCHEMA,
      basis_kind: 'parser_backed_schema', parser_id: 'sqlite-ddl@1',
      schema_id: stableStringify(['fixtures', 'schema.sql']).trim(),
    },
    local_id: 'jobs',
  };
  const withoutDecision = resolveIdentityComponents({
    mention_ids: mentionIds, identity_constraints: [], materialization_id: materializationId,
    identity_verification_registry: registry,
  });
  const decision = buildVerifiedComponentIdentityDecision({
    candidate_mention_ids: mentionIds, declaration_mention_ids: mentionIds,
  }, registry);
  const callerAuthoredLookalike = buildComponentIdentityDecision({
    candidate_mention_ids: mentionIds, identity_kind: 'deterministic_namespace',
    identity_key: identityKey,
  });
  const withDecision = resolveIdentityComponents({
    mention_ids: mentionIds, identity_constraints: [], materialization_id: materializationId,
    identity_verification_registry: registry, component_identity_decisions: [decision],
  });
  const receipt = withDecision.resolution_receipts[0];
  const referent = withDecision.referents[0];
  assert.deepEqual({
    singleton_status: withoutDecision.components[0].status,
    singleton_referents: withoutDecision.referents.length,
    caller_authored: (() => {
      try {
        resolveIdentityComponents({
          mention_ids: mentionIds, identity_constraints: [], materialization_id: materializationId,
          identity_verification_registry: registry,
          component_identity_decisions: [callerAuthoredLookalike],
        });
        return 'ACCEPTED';
      } catch (error) { return error.code; }
    })(),
    keyed_status: withDecision.components[0].status,
    keyed_kind: referent.identity_kind,
    receipt_bound_key: receipt.identity_key,
    replay_verified: verifyIdentityResolution({
      mention_ids: mentionIds, identity_constraints: [], resolution: withDecision,
      identity_verification_registry: registry, component_identity_decisions: [decision],
    }),
    referent_is_selected: referent.referent_id === receipt.selected_referent_id,
    creation_receipt_is_selecting: referent.creation_receipt_id === receipt.receipt_id,
  }, {
    singleton_status: 'unresolved',
    singleton_referents: 0,
    caller_authored: 'IDENTITY_COMPONENT_DECISION_VERIFICATION_REQUIRED',
    keyed_status: 'resolved',
    keyed_kind: 'deterministic_namespace',
    receipt_bound_key: identityKey,
    replay_verified: true,
    referent_is_selected: true,
    creation_receipt_is_selecting: true,
  });
});

test('resolver refuses an otherwise-valid must-link when its truth registry is omitted', () => {
  const fixture = graphFixture(['a', 'b'], [
    { left: 'a', right: 'b', label: 'registry-required' },
  ]);
  const constraint = fixture.aliasConstraint('registry-required');
  assert.throws(() => resolveIdentityComponents({
    mention_ids: fixture.mentionIds, identity_constraints: [constraint],
    materialization_id: materializationId,
  }), error => error.code === 'IDENTITY_VERIFICATION_REGISTRY_REQUIRED');
});

test('Referent contains identity and lifecycle only; classification fields are rejected', () => {
  const referent = buildReferent({
    identity_kind: 'source_native',
    creation_receipt_id: 'resolution-receipt:one',
    identity_key: { connector: 'git', native_id: 'repo-42', native_version_id: 'sha-1' },
  });
  assert.deepEqual(Object.keys(referent).sort(), [
    'creation_receipt_id', 'identity_kind', 'lifecycle_state', 'referent_id', 'schema',
  ]);
  assert.throws(() => buildReferent({
    identity_kind: 'resolved_opaque',
    creation_receipt_id: 'resolution-receipt:one',
    name: 'Payments',
    type: 'team',
    ownership: 'internal',
  }), error => error.code === 'UNKNOWN_IDENTITY_FIELD'
    && error.detail.unknown.every(field => ['name', 'type', 'ownership'].includes(field)));
});

test('automatic must-link accepts only complete independently testable bases', () => {
  const inputs = [
    ['source_established_canonical_reference', { canonical_reference: 'entity:payments', source_version_id: 'source:1' }],
    ['connector_native_id', { connector: 'git', native_id: '42', native_version_id: 'sha-1' }],
    ['pinned_forge_repository_locator', { forge_host: 'forge.example', namespace: 'acme', repository_locator: 'api', source_version_id: 'source:1' }],
    ['parser_backed_schema', { parser_id: 'json-schema@1', schema_id: 'schema:1', declared_identifier: '$id', source_version_id: 'source:1' }],
    ['declared_namespace_identity', { namespace_key: 'urn:example', declared_identifier: 'payments', source_version_id: 'source:1' }],
    ['exact_defined_term_identity', { namespace_key: 'glossary:1', exact_term: 'Payment Service', definition_evidence_id: 'evidence:def' }],
    ['source_cited_alias', { alias_assertion_id: 'assertion:alias' }],
    ['prior_reviewed_resolution', { receipt_id: 'receipt:review', dependency_ids: ['evidence:1'], dependencies_valid: true }],
  ];
  for (const [kind, fields] of inputs) {
    const constraint = automatic('mention:a', 'mention:b', { kind, ...fields }, kind);
    assert.equal(constraint.disposition, 'must_link');
  }
  assert.throws(() => automatic('mention:a', 'mention:b', {
    kind: 'normalized_surface_equality', normalized_surface: 'payments',
  }), error => error.code === 'UNSUPPORTED_AUTOMATIC_IDENTITY_BASIS');
  assert.throws(() => automatic('mention:a', 'mention:b', {
    kind: 'prior_reviewed_resolution',
    receipt_id: 'receipt:stale',
    dependency_ids: ['evidence:changed'],
    dependencies_valid: false,
  }), error => error.code === 'STALE_REVIEWED_RESOLUTION');
});

test('normalized surface equality without an admitted basis remains unresolved', () => {
  const resolution = resolveIdentityComponents({
    mention_ids: ['mention:doc-a:payments', 'mention:doc-b:payments'],
    identity_constraints: [],
    materialization_id: materializationId,
  });
  assert.deepEqual(resolution.components.map(row => ({
    mentions: row.candidate_mention_ids,
    status: row.status,
    selected: row.selected_referent_id,
  })), [
    { mentions: ['mention:doc-a:payments'], status: 'unresolved', selected: null },
    { mentions: ['mention:doc-b:payments'], status: 'unresolved', selected: null },
  ]);
});

test('[falsifier: alias bridge] whole-component conflict is recorded and transitive merge fails closed', () => {
  const fixture = graphFixture(['a', 'b', 'c'], [
    { left: 'a', right: 'b', label: 'a-equals-b' },
    { left: 'b', right: 'c', label: 'b-equals-c' },
  ]);
  const constraints = [fixture.aliasConstraint('a-equals-b'),
    fixture.aliasConstraint('b-equals-c'), fixture.blockingConstraint('a', 'c')];
  const resolution = resolveIdentityComponents({
    mention_ids: fixture.mentionIds, identity_constraints: constraints,
    materialization_id: materializationId,
    identity_verification_registry: fixture.registry,
  });
  const component = resolution.components[0];
  assert.deepEqual({
    status: component.status,
    selected_referent_id: component.selected_referent_id,
    blocking_constraint_ids: component.blocking_constraint_ids,
    conflicts: resolution.conflicts.map(row => row.blocking_constraint_id),
    admitted: resolution.resolution_receipts[0].admitted_mention_ids,
    excluded: resolution.resolution_receipts[0].excluded_mention_ids,
  }, {
    status: 'blocked',
    selected_referent_id: null,
    blocking_constraint_ids: [constraints[2].constraint_id],
    conflicts: [constraints[2].constraint_id],
    admitted: [],
    excluded: fixture.mentionIds.slice().sort(),
  });

  const negated = structuredClone(resolution);
  negated.components[0].status = 'resolved';
  negated.components[0].selected_referent_id = 'referent:illicit-transitive-merge';
  negated.mention_resolutions = negated.mention_ids.map(mention_id => ({
    mention_id,
    referent_id: 'referent:illicit-transitive-merge',
    resolution_receipt_id: negated.resolution_receipts[0].receipt_id,
  }));
  assert.throws(() => verifyIdentityResolution({
    mention_ids: resolution.mention_ids,
    identity_constraints: constraints,
    resolution: negated,
    identity_verification_registry: fixture.registry,
  }), error => error.code === 'IDENTITY_RESOLUTION_MISMATCH');
});

for (const kind of ['namespace', 'type', 'incompatible_time']) {
  test(`whole-component ${kind} incompatibility is an explicit blocking conflict`, () => {
    const fixture = graphFixture(['a', 'b', 'c'], [
      { left: 'a', right: 'b', label: `${kind}:a-b` },
      { left: 'b', right: 'c', label: `${kind}:b-c` },
    ]);
    const constraints = [fixture.aliasConstraint(`${kind}:a-b`),
      fixture.aliasConstraint(`${kind}:b-c`), fixture.blockingConstraint('a', 'c', kind)];
    const resolution = resolveIdentityComponents({
      mention_ids: fixture.mentionIds, identity_constraints: constraints,
      materialization_id: materializationId,
      identity_verification_registry: fixture.registry,
    });
    assert.deepEqual({
      component_status: resolution.components[0].status,
      blocking_kind: resolution.conflicts[0].blocking_kind,
      receipt_conflict_ids: resolution.resolution_receipts[0].conflict_ids,
    }, {
      component_status: 'blocked',
      blocking_kind: kind,
      receipt_conflict_ids: [resolution.conflicts[0].conflict_id],
    });
  });
}

test('reviewed opaque referent keeps its first accepted receipt id when later evidence arrives', () => {
  const fixture = graphFixture(['a', 'b', 'c'], [
    { left: 'a', right: 'b', label: 'first-alias' },
  ]);
  const firstConstraint = fixture.aliasConstraint('first-alias');
  const first = resolveIdentityComponents({
    mention_ids: [fixture.mentionId('a'), fixture.mentionId('b')],
    identity_constraints: [firstConstraint], materialization_id: `${materializationId}:first`,
    identity_verification_registry: fixture.registry,
  });
  const firstReceipt = first.resolution_receipts[0];
  const referent = first.referents[0];
  const dependency = buildReviewedResolutionDependency({
    dependency_id: 'resolution-dependency:first', exact_record: firstReceipt,
  });
  const reviewReceipt = buildReviewedResolutionReceipt({
    endpoint_mention_ids: [fixture.mentionId('b'), fixture.mentionId('c')],
    dependencies: [dependency], selected_head_ids: ['identity-head:first'],
    review_authority_id: 'review:fixture',
  });
  const endpoints = [...fixture.endpointByLabel.values()];
  const laterRegistry = buildIdentityVerificationRegistry({
    mentions: endpoints.map(row => row.mention), evidence_pointers: endpoints.map(row => row.evidence),
    assertions: fixture.aliases.map(row => row.assertion),
    receipts: [...fixture.aliases.map(row => row.receipt), reviewReceipt],
    reviewed_dependencies: [dependency],
  });
  const reviewedConstraint = buildAutomaticIdentityConstraint({
    left: fixture.mentionId('b'), right: fixture.mentionId('c'),
    basis: { kind: 'prior_reviewed_resolution', receipt_id: reviewReceipt.receipt_id,
      dependency_ids: reviewReceipt.dependency_ids, dependencies_valid: true },
    source_status: current, materialization_id: materializationId,
  }, laterRegistry);
  const later = resolveIdentityComponents({
    mention_ids: fixture.mentionIds,
    identity_constraints: [firstConstraint, reviewedConstraint],
    prior_resolution_receipts: [firstReceipt], prior_referents: [referent],
    materialization_id: `${materializationId}:later`,
    identity_verification_registry: laterRegistry,
  });
  assert.deepEqual({
    original_referent_id: referent.referent_id,
    original_creation_receipt_id: referent.creation_receipt_id,
    later_selected_referent_id: later.components[0].selected_referent_id,
    later_creation_receipt_id: later.referents[0].creation_receipt_id,
    later_supersedes: later.resolution_receipts[0].supersedes_receipt_id,
  }, {
    original_referent_id: referent.referent_id,
    original_creation_receipt_id: firstReceipt.receipt_id,
    later_selected_referent_id: referent.referent_id,
    later_creation_receipt_id: firstReceipt.receipt_id,
    later_supersedes: firstReceipt.receipt_id,
  });
});

test('identity lifecycle appends every event and deprecated ids resolve through supersession', () => {
  const first = buildReferent({
    identity_kind: 'deterministic_namespace',
    creation_receipt_id: 'receipt:first',
    identity_key: { namespace_key: 'service-catalog', local_id: 'payments-v1' },
  });
  const successor = buildReferent({
    identity_kind: 'deterministic_namespace',
    creation_receipt_id: 'receipt:successor',
    identity_key: { namespace_key: 'service-catalog', local_id: 'payments-v2' },
  });
  const third = buildReferent({
    identity_kind: 'deterministic_namespace',
    creation_receipt_id: 'receipt:third',
    identity_key: { namespace_key: 'service-catalog', local_id: 'payments-read' },
  });
  const event = (name, extra = {}) => buildIdentityLifecycleRecord({
    event: name,
    subject_referent_id: first.referent_id,
    related_referent_ids: [successor.referent_id],
    basis_receipt_ids: [`receipt:${name}`],
    valid_time: { start: '2026-08-07', end: null },
    recorded_time: '2026-08-07T12:00:00.000Z',
    materialization_id: materializationId,
    ...extra,
  });
  const records = [
    event('merge', { superseded_by_referent_id: successor.referent_id }),
    event('split', { related_referent_ids: [successor.referent_id, third.referent_id] }),
    event('rename'),
    event('successor', { superseded_by_referent_id: successor.referent_id }),
    event('transfer'),
    event('deprecation', { superseded_by_referent_id: successor.referent_id }),
  ];
  const before = buildIdentityLedger({ referents: [first, successor, third] });
  const after = appendIdentityLedger(before, { lifecycle_records: records });
  assert.equal(verifyAppendOnlyIdentityLedger({ previous: before, next: after }), true);
  assert.deepEqual(after.lifecycle_records.map(row => row.event), [
    'merge', 'split', 'rename', 'successor', 'transfer', 'deprecation',
  ]);
  assert.deepEqual(resolveSupersededReferent({
    referent_id: first.referent_id,
    lifecycle_records: records,
  }), {
    requested_referent_id: first.referent_id,
    selected_referent_id: successor.referent_id,
    supersession_chain: [first.referent_id, successor.referent_id],
  });

  const negated = structuredClone(after);
  negated.lifecycle_records.shift();
  assert.throws(() => verifyAppendOnlyIdentityLedger({ previous: after, next: negated }),
    error => error.code === 'IDENTITY_LEDGER_HISTORY_CHANGED');
});

test('documentary assertion identity provably ignores selected referent ids', () => {
  const input = {
    basis_claim_id: 'claim:identity-independent',
    argument_mentions: [
      { role: 'subject', mention_id: 'mention:subject' },
      { role: 'object', mention_id: 'mention:object' },
    ],
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
  };
  const beforeResolution = claimAssertionId(input);
  const afterResolution = claimAssertionId({
    ...input,
    referent_ids: ['referent:opaque:first', 'referent:opaque:second'],
    selected_referent_id: 'referent:opaque:first',
  });
  assert.equal(afterResolution, beforeResolution);
});

test('[falsifier: forge path] URL path establishes hosting but no account type or ownership', () => {
  const identity = buildForgeLocatorIdentity({
    url: 'https://forge.example/alice/payments.git',
    source_version_id: 'source-version:forge-manifest',
    basis_evidence_ids: ['evidence:forge-url'],
    source_status: current,
    valid_time: { start: '2026-08-01', end: null },
  });
  assert.deepEqual({
    namespace: identity.namespace,
    repository_locator: identity.repository_locator,
    predicate: identity.assertions[0].predicate,
    account_kind: identity.account_kind,
    ownership: identity.ownership,
    fork_status: identity.fork_status,
    mirror_status: identity.mirror_status,
    assertion_valid_time: identity.assertions[0].valid_time,
  }, {
    namespace: { namespace_key: 'forge:forge.example', namespace_path: 'alice' },
    repository_locator: {
      namespace_key: 'forge:forge.example', namespace_path: 'alice', repository_locator: 'payments',
    },
    predicate: 'hosted_under',
    account_kind: null,
    ownership: null,
    fork_status: null,
    mirror_status: null,
    assertion_valid_time: { start: '2026-08-01', end: null },
  });

  const negated = structuredClone(identity);
  negated.account_kind = 'organization';
  negated.ownership = { owner: 'alice', inferred_from: 'url_path' };
  negated.assertions.push({ predicate: 'owns', inferred_from: 'hosted_under' });
  assert.throws(() => verifyForgeLocatorIdentity(negated),
    error => error.code === 'FORGE_PATH_INFERENCE');
  assert.equal(verifyForgeLocatorIdentity(identity), true);
});
