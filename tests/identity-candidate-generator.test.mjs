import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupIdentityCandidatesByExactBasis, identityCandidateDecision, identityCandidateDecisions,
  selectIdentityCandidateBatch,
} from '../tools/identity-candidate-generator.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityVerificationRegistry, resolveIdentityComponents,
} from '../tools/referent-identity.mjs';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const materializationId = 'materialization:nary-fixture';
const sharedBasis = {
  kind: 'parser_backed_schema', parser_id: 'yaml-catalog@1',
  schema_id: 'https://example.test/schema', declared_identifier: '$id',
};

function heldCandidate(index, basis = sharedBasis) {
  const record = { kind: 'yaml_record', repo: `repo-${index}`,
    file: `schemas/${index}.yaml`, line: index,
    key_path: basis.declared_identifier, value: basis.schema_id, value_type: 'string' };
  const evidence = buildEvidencePointer({
    source_version_id: 'code-plane:fixture',
    pointer: { kind: 'structured_record', record_id: `fact:${index}`,
      schema_id: 'estate-map/extracted-code-fact/v1', field_path: '$', exact_value: record,
      digest: sha256(stableStringify(record).trim()) },
  });
  const mention = buildMention({
    evidence_pointer: evidence, surface: basis.schema_id, role: 'structured_metadata',
    provenance_class: 'unclassified', namespace: `${record.repo}/${record.file}`,
    source_status: 'current', context_digest: evidence.pointer.digest,
    disposition: 'identity_candidate',
  }).mention;
  return {
    fact_id: `fact:${index}`, fact_kind: 'yaml_record', record, mention,
    evidence_id: evidence.evidence_id, evidence, candidate_basis: basis,
  };
}

function registryFor(candidates) {
  return buildIdentityVerificationRegistry({
    mentions: candidates.map(row => row.mention),
    evidence_pointers: candidates.map(row => row.evidence),
  });
}

function constraintsFor(members, verificationRegistry) {
  return members.slice(1).map(member => buildAutomaticIdentityConstraint({
    left: members[0].mention.mention_id,
    right: member.mention.mention_id,
    basis: { ...members[0].candidate_basis, source_version_id: 'code-plane:fixture' },
    basis_evidence_ids: [members[0].evidence_id, member.evidence_id],
    source_status: 'current',
    materialization_id: materializationId,
  }, verificationRegistry));
}

test('candidate compiler accepts live parser declarations without path, line, or value allowlists', () => {
  const rows = [
    { kind: 'yaml_record', repo: 'alpha', file: 'arbitrary/a.yaml', line: 91,
      key_path: '$id', value: 'urn:any-value:a', value_type: 'string' },
    { kind: 'yaml_record', repo: 'beta', file: 'elsewhere/b.yaml', line: 3,
      key_path: '$schema', value: 'urn:any-value:b', value_type: 'string' },
    { kind: 'yaml_record', repo: 'beta', file: 'elsewhere/b.yaml', line: 4,
      key_path: 'title', value: 'not identity', value_type: 'string' },
  ];
  assert.deepEqual(rows.map(identityCandidateDecision).map(row => [row.disposition, row.reason || row.candidate_class]), [
    ['supported', 'yaml_record:top_level_schema_identifier'],
    ['supported', 'yaml_record:top_level_schema_identifier'],
    ['skipped', 'yaml_record_not_top_level_schema_identifier'],
  ]);
});

test('symbol identity is the nameable declaration path within its exact file', () => {
  const rows = [
    { kind: 'symbol', repo: 'app', file: 'src/first.ts', line: 1, name: 'Widget', symbol_kind: 'class', scope_path: ['Widget'] },
    { kind: 'symbol', repo: 'app', file: 'src/second.ts', line: 1, name: 'Widget', symbol_kind: 'class', scope_path: ['Widget'] },
    { kind: 'symbol', repo: 'app', file: 'src/first.ts', line: 3, name: 'render', symbol_kind: 'method', scope_path: ['Widget', 'render'] },
    { kind: 'symbol', repo: 'app', file: 'src/first.ts', line: 9, name: 'index', symbol_kind: 'const' },
    { kind: 'reference', repo: 'app', file: 'src/first.ts', line: 8, name: 'Widget' },
    { kind: 'module', repo: 'app', file: 'src/first.ts', line: 1, language: 'typescript' },
  ];
  const decisions = rows.map(identityCandidateDecision);
  const candidates = decisions.slice(0, 3).map((decision, index) => ({
    fact_id: `fact:symbol-${index}`,
    fact_kind: 'symbol',
    record: rows[index],
    mention: { mention_id: `mention:symbol-${index}` },
    evidence_id: `evidence:symbol-${index}`,
    candidate_basis: decision.candidate_basis,
  }));
  assert.deepEqual({
    dispositions: decisions.map(row => row.disposition),
    typed_refusals: decisions.slice(3).map(row => row.reason),
    parser_ids: [...new Set(candidates.map(row => row.candidate_basis.parser_id))],
    scoped_bases: candidates.map(row => JSON.parse(row.candidate_basis.schema_id)),
    surfaces: decisions.slice(0, 3).map(row => row.surface),
    groups: groupIdentityCandidatesByExactBasis(candidates).length,
  }, {
    // The module row supports since design section 17 (2026-08-13): a parsed source file is an
    // identity-eligible navigation container at its exact component-relative path.
    dispositions: ['supported', 'supported', 'supported', 'skipped', 'skipped', 'supported'],
    // A declaration whose enclosing scope is not nameable carries no scope_path
    // and is refused: same-named locals in anonymous scopes never contend.
    typed_refusals: ['declaration_scope_not_nameable', 'source_reference', undefined],
    parser_ids: ['tree-sitter-symbol-query@2'],
    scoped_bases: [
      ['app', 'src/first.ts'],
      ['app', 'src/second.ts'],
      ['app', 'src/first.ts'],
    ],
    surfaces: ['Widget', 'Widget', 'Widget.render'],
    groups: 3,
  });
});

test('[design §17] module identity is the exact component-relative path within its repository', () => {
  const rows = [
    { kind: 'module', repo: 'app', file: 'src/first.ts', line: 1, language: 'typescript', end_line: 90 },
    { kind: 'module', repo: 'app', file: 'src/first.ts', line: 1, language: 'javascript' },
    { kind: 'module', repo: 'app', file: 'src/solo.ts', line: 1, language: 'typescript' },
    { kind: 'module', repo: 'app', file: 'src/mystery.ts', line: 1 },
  ];
  const decisions = identityCandidateDecisions(rows);
  const solo = decisions[2];
  assert.deepEqual({
    dispositions: decisions.map(row => row.disposition),
    duplicate_reasons: decisions.slice(0, 2).map(row => row.reason),
    unwitnessed_reason: decisions[3].reason,
    surface: solo.surface,
    basis: solo.candidate_basis,
    candidate_class: solo.candidate_class,
  }, {
    dispositions: ['skipped', 'skipped', 'supported', 'skipped'],
    duplicate_reasons: ['duplicate_declaration_key', 'duplicate_declaration_key'],
    unwitnessed_reason: 'module_language_unwitnessed',
    surface: 'src/solo.ts',
    basis: { kind: 'declared_namespace_identity',
      namespace_key: '[\n  "app",\n  "module"\n]', declared_identifier: 'src/solo.ts' },
    candidate_class: 'module:parsed_source_file',
  });
});

test('duplicate symbol declaration paths refuse every member', () => {
  const rows = [
    { kind: 'symbol', repo: 'app', file: 'src/dup.ts', line: 1, name: 'Thing', symbol_kind: 'class', scope_path: ['Thing'] },
    { kind: 'symbol', repo: 'app', file: 'src/dup.ts', line: 40, name: 'Thing', symbol_kind: 'class', scope_path: ['Thing'] },
    { kind: 'symbol', repo: 'app', file: 'src/other.ts', line: 1, name: 'Thing', symbol_kind: 'class', scope_path: ['Thing'] },
  ];
  const decisions = identityCandidateDecisions(rows);
  assert.deepEqual({
    dispositions: decisions.map(row => row.disposition),
    reasons: decisions.filter(row => row.disposition === 'skipped').map(row => row.reason),
  }, {
    dispositions: ['skipped', 'skipped', 'supported'],
    reasons: ['duplicate_declaration_key', 'duplicate_declaration_key'],
  });
});

test('duplicate SQLite declaration keys preserve the existing all-member refusal', () => {
  const rows = [3, 9, 14].map((line, index) => ({
    kind: 'sqlite_table', repo: 'core', file: 'schema.mjs', line,
    table: index < 2 ? 'jobs' : 'receipts',
  }));
  assert.deepEqual(identityCandidateDecisions(rows).map(row => row.reason || row.candidate_class), [
    'duplicate_declaration_key', 'duplicate_declaration_key', 'sqlite_table:exact_file_declaration',
  ]);
});

test('n-ary exact-basis grouping retains three files while the old pairwise pass omits one', () => {
  const candidates = [heldCandidate(1), heldCandidate(2), heldCandidate(3)];
  const group = groupIdentityCandidatesByExactBasis(candidates)[0];
  const verificationRegistry = registryFor(candidates);
  const naryConstraints = constraintsFor(group.members, verificationRegistry);
  const nary = resolveIdentityComponents({
    mention_ids: candidates.map(row => row.mention.mention_id),
    identity_constraints: naryConstraints,
    materialization_id: materializationId,
    identity_verification_registry: verificationRegistry,
  });
  const oldPairwiseMembers = candidates.slice(0, Math.floor(candidates.length / 2) * 2);
  const oldPairwise = resolveIdentityComponents({
    mention_ids: candidates.map(row => row.mention.mention_id),
    identity_constraints: constraintsFor(oldPairwiseMembers, verificationRegistry),
    materialization_id: materializationId,
    identity_verification_registry: verificationRegistry,
  });
  assert.deepEqual({
    nary_disposition: group.disposition,
    nary_component_sizes: nary.components.map(row => row.candidate_mention_ids.length).sort(),
    old_pairwise_component_sizes: oldPairwise.components.map(row => row.candidate_mention_ids.length).sort(),
    omitted_by_old_pairwise: candidates.length - oldPairwiseMembers.length,
  }, {
    nary_disposition: 'nary_exact_basis_component',
    nary_component_sizes: [3],
    old_pairwise_component_sizes: [1, 2],
    omitted_by_old_pairwise: 1,
  });
});

test('exact-basis singletons retain an explicit disposition', () => {
  const singleton = heldCandidate(1, { ...sharedBasis, schema_id: 'urn:singleton' });
  assert.equal(groupIdentityCandidatesByExactBasis([singleton])[0].disposition,
    'singleton_requires_explicit_join_disposition');
});

function select(groups, selection) {
  return selectIdentityCandidateBatch({
    groups, selection,
    source_head: '90ec8527ca8fa5957dc52e91d25414ff5980e1fd',
    code_plane_head: 'code-plane:fixture',
    census_digest: 'census:fixture',
  });
}

test('batch selection occurs after full enumeration and retains the deferred denominator', () => {
  const groups = groupIdentityCandidatesByExactBasis(Array.from({ length: 5 }, (_, index) =>
    heldCandidate(index + 1, { ...sharedBasis, schema_id: `urn:${index + 1}` })));
  const batch = select(groups, { mode: 'batch', batch_size: 2, cursor: 0, batch_index: 0 });
  assert.deepEqual({
    full_candidates: batch.receipt.total_candidates,
    selected: batch.receipt.selected_candidate_count,
    deferred: batch.receipt.deferred_candidate_count,
    rows: batch.receipt.candidate_rows.length,
  }, { full_candidates: 5, selected: 2, deferred: 3, rows: 5 });
});

test('batch limit never splits an n-ary component', () => {
  const groups = groupIdentityCandidatesByExactBasis([
    heldCandidate(1), heldCandidate(2), heldCandidate(3),
    heldCandidate(4, { ...sharedBasis, schema_id: 'urn:other' }),
  ]);
  const naryIndex = groups.findIndex(group => group.members.length === 3);
  const batch = select(groups, { mode: 'batch', batch_size: 1,
    cursor: naryIndex, batch_index: naryIndex });
  assert.deepEqual({ components: batch.receipt.selected_component_ids.length,
    candidates: batch.receipt.selected_candidate_count }, { components: 1, candidates: 3 });
});

test('deferred candidates are not labelled with semantic dispositions', () => {
  const groups = groupIdentityCandidatesByExactBasis(Array.from({ length: 3 }, (_, index) =>
    heldCandidate(index + 1, { ...sharedBasis, schema_id: `urn:${index + 1}` })));
  const batch = select(groups, { mode: 'batch', batch_size: 1, cursor: 0, batch_index: 0 });
  const pending = batch.receipt.candidate_rows.filter(row => row.evaluation_state === 'not_evaluated_in_this_batch');
  assert.deepEqual({ count: pending.length, dispositions: pending.filter(row => Object.hasOwn(row, 'disposition')).length,
    states: [...new Set(pending.map(row => row.evaluation_state))] },
  { count: 2, dispositions: 0, states: ['not_evaluated_in_this_batch'] });
});

test('adjacent batches are disjoint and their union equals the full census', () => {
  const groups = groupIdentityCandidatesByExactBasis(Array.from({ length: 7 }, (_, index) =>
    heldCandidate(index + 1, { ...sharedBasis, schema_id: `urn:${index + 1}` })));
  const selected = [];
  let cursor = 0;
  let batchIndex = 0;
  while (cursor < groups.length) {
    const batch = select(groups, { mode: 'batch', batch_size: 2, cursor, batch_index: batchIndex });
    selected.push(...batch.receipt.selected_candidate_fact_ids);
    cursor = batch.receipt.next_cursor;
    batchIndex += 1;
  }
  assert.deepEqual({ unique: new Set(selected).size, union: selected.slice().sort(),
    census: groups.flatMap(group => group.members.map(row => row.fact_id)).sort() },
  { unique: 7, union: groups.flatMap(group => group.members.map(row => row.fact_id)).sort(),
    census: groups.flatMap(group => group.members.map(row => row.fact_id)).sort() });
});

test('explicit all mode evaluates every complete component', () => {
  const groups = groupIdentityCandidatesByExactBasis([
    heldCandidate(1), heldCandidate(2), heldCandidate(3,
      { ...sharedBasis, schema_id: 'urn:other' }),
  ]);
  const batch = select(groups, { mode: 'all' });
  assert.deepEqual({ selected: batch.receipt.selected_candidate_count,
    pending: batch.receipt.not_evaluated_in_this_batch_count,
    complete: batch.receipt.complete }, { selected: 3, pending: 0, complete: true });
});
