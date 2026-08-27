import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutomaticIdentityConstraint, buildForgeLocatorIdentity,
  buildIdentityVerificationRegistry, buildReviewedResolutionDependency,
  buildReviewedResolutionReceipt, verifyIdentityConstraint,
} from '../tools/referent-identity.mjs';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_RECEIPT_SCHEMA,
  CLAIM_PROJECTION_SCHEMA_VERSION,
} from '../tools/claim-projection.mjs';
import { identityCandidateDecision } from '../tools/identity-candidate-generator.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const materializationId = 'materialization:identity-basis-verifiers';
const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const codeOf = action => { try { action(); return 'ACCEPTED'; } catch (error) { return error.code; } };

function registry({ endpoints = [], assertions = [], receipts = [], forge = [], dependencies = [] } = {}) {
  return buildIdentityVerificationRegistry({
    mentions: endpoints.map(row => row.mention),
    evidence_pointers: [...new Map(endpoints.map(row => [row.evidence.evidence_id, row.evidence])).values()],
    assertions,
    receipts,
    forge_locator_identities: forge,
    reviewed_dependencies: dependencies,
  });
}

function documentEndpoint(label, surface, {
  namespace = `docs/${label}.md`, sourceVersion = 'source-version:documentary', role = 'subject',
} = {}) {
  const byteStart = label.length * 100;
  const evidence = buildEvidencePointer({
    source_version_id: sourceVersion,
    pointer: {
      kind: 'document_span', file: namespace, start: 1, end: 1,
      byte_start: byteStart, byte_end: byteStart + Buffer.byteLength(surface),
      exact_text: surface, digest: sha256(surface),
    },
  });
  return buildMention({
    evidence_pointer: evidence, surface, role, namespace,
    provenance_class: 'production_document', source_status: 'current',
    context_digest: sha256(`${namespace}:${surface}`), disposition: 'identity_candidate',
  });
}

function structuredEndpoint(label, surface, pointer, role = 'structured_metadata') {
  const evidence = buildEvidencePointer({ source_version_id: pointer.source_version_id, pointer: {
    kind: 'structured_record', record_id: `record:${label}`, schema_id: pointer.schema_id,
    field_path: pointer.field_path, exact_value: pointer.exact_value, digest: pointer.digest,
  } });
  return buildMention({
    evidence_pointer: evidence, surface, role,
    namespace: pointer.namespace || `registry/${label}`,
    provenance_class: 'unclassified', source_status: 'current',
    context_digest: pointer.digest, disposition: 'identity_candidate',
  });
}

function codeEndpoint(label, record) {
  const decision = identityCandidateDecision(record);
  assert.equal(decision.disposition, 'supported');
  return structuredEndpoint(label, decision.surface, {
    source_version_id: 'code-plane:fixture',
    schema_id: 'estate-map/extracted-code-fact/v1', field_path: '$',
    exact_value: record, digest: sha256(canonical(record)),
    namespace: `${record.repo}/${record.file}`,
  });
}

function automatic(left, right, basis, evidenceIds = [], assertionIds = []) {
  return buildAutomaticIdentityConstraint({
    left: left.mention.mention_id, right: right.mention.mention_id, basis,
    basis_evidence_ids: evidenceIds, basis_assertion_ids: assertionIds,
    source_status: 'current', valid_time: null, materialization_id: materializationId,
  });
}

function rebaseConstraint(constraint, changes) {
  const { constraint_id: _constraintId, ...body } = constraint;
  const changed = { ...body, ...changes };
  return { ...changed, constraint_id: hashId('identity-constraint', changed) };
}

function aliasAssertion(left, right, label) {
  const basisClaimId = `claim:${label}`;
  const argumentMentions = [
    { role: 'subject', mention_id: left.mention.mention_id },
    { role: 'object', mention_id: right.mention.mention_id },
  ];
  const assertionId = claimAssertionId({ basis_claim_id: basisClaimId, argument_mentions: argumentMentions });
  const receiptBody = {
    schema: CLAIM_PROJECTION_RECEIPT_SCHEMA,
    basis_claim_id: basisClaimId,
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
  return { assertion, receipt };
}

test('[F2.6] structured-record and repository-metadata pointers recompute their exact-value digest', () => {
  const record = { kind: 'yaml_record', repo: 'alpha', file: 'schema.yaml', line: 1 };
  const build = (kind, exactValue, digest) => buildEvidencePointer({
    source_version_id: 'source-version:digest-rule',
    pointer: kind === 'structured_record'
      ? { kind, record_id: 'record:1', schema_id: 'estate-map/extracted-code-fact/v1',
        field_path: '$', exact_value: exactValue, digest }
      : { kind, manifest_id: 'manifest:1', repository_id: 'repository:1',
        field_path: 'visibility', exact_value: exactValue, digest },
  });
  assert.deepEqual({
    object_value: codeOf(() => build('structured_record', record, sha256(canonical(record)))),
    object_value_forged: codeOf(() => build('structured_record', record, sha256('unrelated'))),
    string_value: codeOf(() => build('repository_metadata', 'private', sha256('private'))),
    string_value_forged: codeOf(() => build('repository_metadata', 'private', sha256('public'))),
  }, {
    object_value: 'ACCEPTED', object_value_forged: 'POINTER_DIGEST_MISMATCH',
    string_value: 'ACCEPTED', string_value_forged: 'POINTER_DIGEST_MISMATCH',
  });
});

test('source-established canonical reference requires exact canonical-reference pointers on both endpoints', () => {
  const surface = 'canonical:payments';
  const make = label => structuredEndpoint(label, surface, {
    source_version_id: 'source-version:canonical',
    schema_id: 'estate-map/source-established-canonical-reference/v1',
    field_path: '$.canonical_reference', exact_value: surface, digest: sha256(surface),
  });
  const left = make('canonical-left'), right = make('canonical-right');
  const constraint = automatic(left, right, {
    kind: 'source_established_canonical_reference', canonical_reference: surface,
    source_version_id: 'source-version:canonical',
  }, [left.evidence.evidence_id, right.evidence.evidence_id]);
  const held = registry({ endpoints: [left, right] });
  const changed = rebaseConstraint(constraint, { basis: {
    ...constraint.basis, canonical_reference: 'canonical:normalized-payments',
  } });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    changed: codeOf(() => verifyIdentityConstraint(changed, held)) },
  { valid: 'ACCEPTED', changed: 'CANONICAL_REFERENCE_BASIS_MISMATCH' });
});

test('connector-native identity requires both source-native pointers to carry one exact tuple', () => {
  const make = (label, role) => {
    const evidence = buildEvidencePointer({
      source_version_id: 'source-version:connector',
      pointer: { kind: 'source_native_object', connector: 'git', native_id: 'repo-42',
        native_version_id: 'sha-1', digest: sha256('repo-42') },
    });
    return buildMention({ evidence_pointer: evidence, surface: 'repo-42', role,
      provenance_class: 'production_document', source_status: 'current' });
  };
  const left = make('native-left', 'subject'), right = make('native-right', 'object');
  const constraint = automatic(left, right, {
    kind: 'connector_native_id', connector: 'git', native_id: 'repo-42', native_version_id: 'sha-1',
  }, [left.evidence.evidence_id, right.evidence.evidence_id]);
  const held = registry({ endpoints: [left, right] });
  const changed = rebaseConstraint(constraint, { basis: { ...constraint.basis, native_id: 'repo-24' } });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    changed: codeOf(() => verifyIdentityConstraint(changed, held)) },
  { valid: 'ACCEPTED', changed: 'CONNECTOR_NATIVE_ID_BASIS_MISMATCH' });
});

test('[falsifier B7] forge-like fields require the specialized verified locator record', () => {
  const url = 'https://github.com/sponsors/eemeli';
  const left = documentEndpoint('forge-left', url, { sourceVersion: 'source-version:forge', role: 'subject' });
  const right = documentEndpoint('forge-right', url, { sourceVersion: 'source-version:forge', role: 'object' });
  const forge = buildForgeLocatorIdentity({
    url, source_version_id: 'source-version:forge',
    basis_evidence_ids: [left.evidence.evidence_id, right.evidence.evidence_id],
  });
  const constraint = automatic(left, right, {
    kind: 'pinned_forge_repository_locator', forge_host: 'github.com', namespace: 'sponsors',
    repository_locator: 'eemeli', source_version_id: 'source-version:forge',
  }, [left.evidence.evidence_id, right.evidence.evidence_id]);
  assert.deepEqual({
    verified: codeOf(() => verifyIdentityConstraint(constraint,
      registry({ endpoints: [left, right], forge: [forge] }))),
    lookalike_fields_only: codeOf(() => verifyIdentityConstraint(constraint,
      registry({ endpoints: [left, right] }))),
  }, { verified: 'ACCEPTED', lookalike_fields_only: 'FORGE_IDENTITY_BASIS_MISMATCH' });
});

test('[falsifier B2] parser-backed identity rejects an evidence swap before resolution', () => {
  const record = index => ({ kind: 'yaml_record', repo: `repo-${index}`,
    file: `schema-${index}.yaml`, line: 1, key_path: '$id', value: 'urn:shared', value_type: 'string' });
  const left = codeEndpoint('parser-left', record(1));
  const right = codeEndpoint('parser-right', record(2));
  const unrelated = codeEndpoint('parser-unrelated', { ...record(3), value: 'urn:other' });
  const basis = { ...identityCandidateDecision(record(1)).candidate_basis,
    source_version_id: 'code-plane:fixture' };
  const constraint = automatic(left, right, basis,
    [left.evidence.evidence_id, right.evidence.evidence_id]);
  const held = registry({ endpoints: [left, right, unrelated] });
  const swapped = rebaseConstraint(constraint, {
    basis_evidence_ids: [left.evidence.evidence_id, unrelated.evidence.evidence_id].sort(),
  });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    swapped: codeOf(() => verifyIdentityConstraint(swapped, held)) },
  { valid: 'ACCEPTED', swapped: 'IDENTITY_BASIS_SUPPORT_MISMATCH' });
});

test('[falsifier B3] declared-namespace identity rejects normalized identifier bytes', () => {
  const record = index => ({ kind: 'http_route', repo: 'api', file: `routes-${index}.mjs`, line: index,
    owner: 'payments', framework: 'express', method: 'GET',
    declared_route: '/PaymentsAPI', route: `/api/plugins/payments/PaymentsAPI` });
  const left = codeEndpoint('namespace-left', record(1));
  const right = codeEndpoint('namespace-right', record(2));
  const basis = { ...identityCandidateDecision(record(1)).candidate_basis,
    source_version_id: 'code-plane:fixture' };
  const constraint = automatic(left, right, basis,
    [left.evidence.evidence_id, right.evidence.evidence_id]);
  const held = registry({ endpoints: [left, right] });
  const normalized = rebaseConstraint(constraint, { basis: {
    ...constraint.basis, declared_identifier: constraint.basis.declared_identifier.toLocaleLowerCase(),
  } });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    normalized: codeOf(() => verifyIdentityConstraint(normalized, held)) },
  { valid: 'ACCEPTED', normalized: 'DECLARED_NAMESPACE_BASIS_MISMATCH' });
});

test('[falsifier B5] exact defined-term identity refuses an unresolved definition evidence ID', () => {
  const left = documentEndpoint('term-left', 'Payment Service', {
    namespace: 'design/glossary.md', role: 'subject',
  });
  const right = documentEndpoint('term-right', 'Payment Service', {
    namespace: 'design/glossary.md', role: 'definition',
  });
  const constraint = automatic(left, right, {
    kind: 'exact_defined_term_identity', namespace_key: 'design/glossary.md',
    exact_term: 'Payment Service', definition_evidence_id: right.evidence.evidence_id,
  }, [left.evidence.evidence_id, right.evidence.evidence_id]);
  const held = registry({ endpoints: [left, right] });
  const missing = rebaseConstraint(constraint, { basis: {
    ...constraint.basis, definition_evidence_id: 'evidence:missing-definition',
  } });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    missing: codeOf(() => verifyIdentityConstraint(missing, held)) },
  { valid: 'ACCEPTED', missing: 'EXACT_DEFINED_TERM_EVIDENCE_UNRESOLVED' });
});

test('[falsifier B4] source-cited alias requires the exact producer assertion to cite both endpoints', () => {
  const left = documentEndpoint('alias-left', 'legacy-name', { role: 'subject' });
  const right = documentEndpoint('alias-right', 'canonical-name', { role: 'object' });
  const unrelatedLeft = documentEndpoint('alias-other-left', 'other-legacy', { role: 'subject' });
  const unrelatedRight = documentEndpoint('alias-other-right', 'other-canonical', { role: 'object' });
  const exactAlias = aliasAssertion(left, right, 'exact-alias');
  const unrelatedAlias = aliasAssertion(unrelatedLeft, unrelatedRight, 'unrelated-alias');
  const constraint = automatic(left, right, {
    kind: 'source_cited_alias', alias_assertion_id: exactAlias.assertion.assertion_id,
  }, [left.evidence.evidence_id, right.evidence.evidence_id], [exactAlias.assertion.assertion_id]);
  const held = registry({ endpoints: [left, right, unrelatedLeft, unrelatedRight],
    assertions: [exactAlias.assertion, unrelatedAlias.assertion],
    receipts: [exactAlias.receipt, unrelatedAlias.receipt] });
  const unrelated = rebaseConstraint(constraint, {
    basis: { kind: 'source_cited_alias', alias_assertion_id: unrelatedAlias.assertion.assertion_id },
    basis_assertion_ids: [unrelatedAlias.assertion.assertion_id],
  });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, held)),
    unrelated: codeOf(() => verifyIdentityConstraint(unrelated, held)) },
  { valid: 'ACCEPTED', unrelated: 'SOURCE_CITED_ALIAS_CONGRUENCE_FAILURE' });
});

test('prior reviewed resolution recomputes its complete dependency closure instead of trusting the Boolean', () => {
  const left = documentEndpoint('review-left', 'reviewed-left', { role: 'subject' });
  const right = documentEndpoint('review-right', 'reviewed-right', { role: 'object' });
  const dependencies = [
    buildReviewedResolutionDependency({ dependency_id: 'source-version:one', exact_record: { sha: 'a'.repeat(40) } }),
    buildReviewedResolutionDependency({ dependency_id: 'model-response:one', exact_record: { digest: 'response-a' } }),
  ];
  const receipt = buildReviewedResolutionReceipt({
    endpoint_mention_ids: [left.mention.mention_id, right.mention.mention_id], dependencies,
    selected_head_ids: ['claim-head:one', 'code-head:one'], review_authority_id: 'review:human-approved',
  });
  const constraint = automatic(left, right, {
    kind: 'prior_reviewed_resolution', receipt_id: receipt.receipt_id,
    dependency_ids: receipt.dependency_ids, dependencies_valid: true,
  });
  const validRegistry = registry({ endpoints: [left, right], receipts: [receipt], dependencies });
  const changedDependencies = dependencies.map(row => row.dependency_id === 'model-response:one'
    ? buildReviewedResolutionDependency({ dependency_id: row.dependency_id,
      exact_record: { digest: 'response-b' } }) : row);
  const staleRegistry = registry({ endpoints: [left, right], receipts: [receipt],
    dependencies: changedDependencies });
  assert.deepEqual({ valid: codeOf(() => verifyIdentityConstraint(constraint, validRegistry)),
    changed_dependency_with_true_boolean:
      codeOf(() => verifyIdentityConstraint(constraint, staleRegistry)) },
  { valid: 'ACCEPTED', changed_dependency_with_true_boolean: 'STALE_REVIEWED_RESOLUTION' });
});
