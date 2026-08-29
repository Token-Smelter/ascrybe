import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identityCandidateDecision, identityCandidateDecisions,
} from '../tools/identity-candidate-generator.mjs';

const capability = (direction, capability_type, owner = 'controller-runtime', line = 20) => ({
  kind: 'capability_flow', repo: 'app', file: 'plugins/controller-runtime/plugin.yaml', line,
  capability_type, direction, owner, source: 'manifest',
});
const envelope = (idiom, envelope_kind, line = 18) => ({
  kind: 'envelope_flow', repo: 'app', file: 'plugins/session-notes/plugin.yaml', line,
  envelope_kind, direction: 'emit', idiom,
});
const document = (file, fields) => ({ kind: 'yaml_document', repo: 'app', file, line: 1, ...fields });

test('a declared capability becomes an entity while requiring or calling one stays a reference', () => {
  assert.deepEqual([
    identityCandidateDecision(capability('provide', 'work_order_management')),
    identityCandidateDecision(capability('require', 'brew')),
    identityCandidateDecision(capability('call', 'brew')),
    identityCandidateDecision(capability('provide', '')),
  ].map(decision => decision.disposition === 'supported'
    ? { surface: decision.surface, namespace: decision.candidate_basis.namespace_key }
    : decision.reason), [
    { surface: 'work_order_management', namespace: '[\n  "app",\n  "capability"\n]' },
    'capability_reference_not_declaration',
    'capability_reference_not_declaration',
    'capability_declaration_incomplete',
  ]);
});

test('a manifest-published envelope kind becomes an entity while code-site traffic stays a reference', () => {
  assert.deepEqual([
    identityCandidateDecision(envelope('manifest_publishes', 'failure.observed')),
    identityCandidateDecision(envelope('envelope_object_literal', 'failure.observed')),
  ].map(decision => decision.disposition === 'supported' ? decision.surface : decision.reason),
  ['failure.observed', 'envelope_reference_not_declaration']);
});

test('plugin manifests and typed documents retain declared identity while untyped YAML uses exact file identity', () => {
  assert.deepEqual([
    document('plugins/workflow-engine/plugin.yaml', { doc_name: 'workflow-engine', api_version: 1 }),
    document('.catalog/potions/factory-investigation.yaml',
      { api_version: 'example.recipe/v1', doc_id: 'factory/investigation' }),
    document('design/features/thing/DESIGN.md.yaml', { api_version: null, doc_id: null }),
    document('config/settings.yaml', { api_version: 2, doc_id: 'ambiguous' }),
    document('plugins/unnameable/plugin.yaml', { api_version: null, doc_id: null }),
  ].map(row => {
    const decision = identityCandidateDecision(row);
    return decision.disposition === 'supported'
      ? { surface: decision.surface, basis: decision.candidate_basis }
      : decision.reason;
  }), [
    { surface: 'workflow-engine', basis: { kind: 'declared_namespace_identity',
      namespace_key: '[\n  "app",\n  "plugin"\n]', declared_identifier: 'workflow-engine' } },
    { surface: 'factory/investigation', basis: { kind: 'declared_namespace_identity',
      namespace_key: '[\n  "app",\n  "example.recipe/v1"\n]', declared_identifier: 'factory/investigation' } },
    { surface: 'design/features/thing/DESIGN.md.yaml', basis: { kind: 'declared_namespace_identity',
      namespace_key: '[\n  "app",\n  "yaml-document"\n]', declared_identifier: 'design/features/thing/DESIGN.md.yaml' } },
    'document_identity_contract_unpinned',
    'plugin_manifest_name_unwitnessed',
  ]);
});

test('one capability declared by manifest and code merges, while duplicate typed and path document keys refuse every member', () => {
  const decisions = identityCandidateDecisions([
    capability('provide', 'brew', 'workflow-engine', 4),
    { ...capability('provide', 'brew', 'workflow-engine', 91), file: 'plugins/workflow-engine/server/index.mjs' },
    document('.catalog/potions/one.yaml', { api_version: 'example.recipe/v1', doc_id: 'shared/id' }),
    document('.catalog/potions/two.yaml', { api_version: 'example.recipe/v1', doc_id: 'shared/id' }),
    document('checks/fast.yaml', { api_version: null, doc_id: null }),
    document('checks/fast.yaml', { api_version: null, doc_id: null, line: 8 }),
    document('checks/slow.yaml', { api_version: null, doc_id: null }),
  ]);
  assert.deepEqual(decisions.map(decision =>
    decision.disposition === 'supported' ? decision.surface : decision.reason), [
    'brew', 'brew', 'duplicate_declaration_key', 'duplicate_declaration_key',
    'duplicate_declaration_key', 'duplicate_declaration_key', 'checks/slow.yaml',
  ]);
});
