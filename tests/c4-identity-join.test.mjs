import test from 'node:test';
import assert from 'node:assert/strict';
import { buildC4IdentityJoinClosure } from '../tools/c4-identity-join.mjs';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import { resolveIdentityComponents } from '../tools/referent-identity.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const materializationId = 'materialization:c4-nary-documentary-fixture';
const surface = 'urn:example:schema';
const candidateBasis = {
  kind: 'parser_backed_schema', parser_id: 'yaml-catalog@1',
  schema_id: surface, declared_identifier: '$id',
};

function codeCandidate(index) {
  const file = `schemas/schema-${index}.yaml`;
  const record = { kind: 'yaml_record', repo: 'design', file, line: 1,
    key_path: '$id', value: surface, value_type: 'string' };
  const evidence = buildEvidencePointer({
    source_version_id: 'code-plane:nary-fixture',
    pointer: { kind: 'structured_record', record_id: `code-fact:${index}`,
      schema_id: 'estate-map/extracted-code-fact/v1', field_path: '$', exact_value: record,
      digest: sha256(stableStringify(record).trim()) },
  });
  const mention = buildMention({
    evidence_pointer: evidence, surface, role: 'structured_metadata',
    provenance_class: 'unclassified', namespace: `design/${file}`, source_status: 'current',
    context_digest: evidence.pointer.digest, disposition: 'identity_candidate',
  }).mention;
  return {
    fact_id: `code-fact:${index}`,
    fact_kind: 'yaml_record',
    candidate_class: 'yaml_record:top_level_schema_identifier',
    record, mention, evidence_id: evidence.evidence_id, evidence,
    candidate_basis: candidateBasis,
  };
}

test('three-file exact-basis group joins every code mention through one component', () => {
  const documentaryEvidence = buildEvidencePointer({
    source_version_id: 'source-version:documentary',
    pointer: { kind: 'document_span', file: 'design/schemas/schema-1.yaml',
      start: 1, end: 1, byte_start: 0, byte_end: Buffer.byteLength(surface),
      exact_text: surface, digest: sha256(surface) },
  });
  const documentaryMention = buildMention({
    evidence_pointer: documentaryEvidence, surface, role: 'structured_metadata',
    provenance_class: 'production_document', namespace: 'design/schemas/schema-1.yaml',
    source_status: 'current', context_digest: sha256(surface), disposition: 'identity_candidate',
  }).mention;
  const documentaryResolution = resolveIdentityComponents({
    mention_ids: [documentaryMention.mention_id],
    identity_constraints: [],
    materialization_id: materializationId,
  });
  const candidates = [1, 2, 3].map(codeCandidate);
  const closure = buildC4IdentityJoinClosure({
    argument_substrate: { mentions: [documentaryMention], evidence_pointers: [documentaryEvidence] },
    documentary_identity: {
      identity_constraints: [], identity_resolution: documentaryResolution,
      identity_verification_records: {
        // The exact-match Mention is unconstrained on the documentary side, so it is intentionally
        // absent here. The join producer must close its witness with the matched Mention/Evidence.
        mentions: [], evidence_pointers: [],
        assertions: [], receipts: [], declaration_witnesses: [],
        forge_locator_identities: [], reviewed_dependencies: [],
      },
    },
    code_fact_plane: {
      code_plane_head: 'code-plane:nary-fixture',
      inventory: { source_head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      grounding_registry: { evidence_pointers: candidates.map(row => row.evidence), receipts: [] },
      identity_candidates: candidates,
      identity_candidate_generation: { digest: 'identity-census:nary-fixture' },
    },
    identity_selection: { mode: 'all' },
  });
  const componentIds = new Set(closure.report.join_receipts.map(row => row.resolution_receipt_id));
  const component = closure.identity_resolution.components.find(row =>
    row.candidate_mention_ids.includes(documentaryMention.mention_id));
  const selectedReferent = closure.identity_resolution.referents.find(row =>
    row.referent_id === component.selected_referent_id);
  assert.deepEqual({
    grouped_code_mentions: closure.report.exact_basis_groups[0].candidate_mention_ids.length,
    joined_receipts: closure.report.dispositions.joined,
    component_receipts: componentIds.size,
    component_mentions: component.candidate_mention_ids.length,
    component_decisions: closure.component_identity_decisions.length,
    matched_documentary_registry_closed:
      closure.identity_verification_registry.mention_ids.includes(documentaryMention.mention_id),
    entity_layer: closure.report.entity_layer,
    selected_identity_kind: selectedReferent.identity_kind,
    receipt_bound_key: closure.identity_resolution.resolution_receipts
      .find(row => row.receipt_id === component.resolution_receipt_id).identity_key,
    old_pairwise_omission: candidates.length - candidates.slice(0, Math.floor(candidates.length / 2) * 2).length,
  }, {
    grouped_code_mentions: 3,
    joined_receipts: 3,
    component_receipts: 1,
    component_mentions: 4,
    component_decisions: 1,
    matched_documentary_registry_closed: true,
    entity_layer: {
      evaluated_candidates: 3, candidate_components: 1, component_identity_decisions: 1,
      resolved_candidate_mentions: 3, unresolved_candidate_mentions: 0, keyed_referents: 1,
    },
    selected_identity_kind: 'deterministic_namespace',
    receipt_bound_key: {
      namespace_key: {
        schema: 'estate-map/component-namespace-key/v1', basis_kind: 'parser_backed_schema',
        parser_id: 'yaml-catalog@1', schema_id: surface,
      },
      local_id: '$id',
    },
    old_pairwise_omission: 1,
  });
});
