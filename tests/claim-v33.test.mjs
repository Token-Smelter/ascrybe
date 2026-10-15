import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimV33, reduceClaimsV33 } from '../tools/claim-v33.mjs';
import { createWindowBlockCatalog } from '../tools/source-locator.mjs';
import { buildMentionNamespace, prepassDocument } from '../tools/source-prepass.mjs';
import { segmentDocument } from '../tools/wide-context-windows.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: 'digest' };
const content = '# History\n\nThe evidence screenshots were supplied in the source conversation.\n';
const prepass = prepassDocument({ path: 'history.md', content, ...snapshot });
const window = segmentDocument({ path: 'history.md', content, snapshot }).windows[0];
const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
const paragraph = catalog.entries.find(entry => entry.type === 'paragraph');
const sourceLocator = { block_token: paragraph.token, quote: paragraph.text };

function proposal(overrides = {}) {
  return {
    subject_binding: 'explicit', subject_occurrence_id: 'subject-occurrence:history',
    subject_mention: { surface: 'evidence screenshots', source_locator: sourceLocator },
    relation_family: 'historical', predicate_family: 'were supplied in',
    object_or_value: 'the source conversation', polarity: 'affirmed', modality: 'historical',
    quantifier: 'the', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: sourceLocator }] }],
    ...overrides,
  };
}

const build = proposed => buildClaimV33({
  proposed, window, catalog, namespace: buildMentionNamespace([prepass]),
  model_identifier: 'fake/model', prompt_digest: 'prompt',
});

test('v3.3 normalizes unknown relation family without vetoing the grounded proposition', () => {
  const claim = build(proposal());
  assert.equal(claim.schema, 'estate-map/documentary-claim/v3.3');
  assert.equal(claim.semantic.relation_family, 'other');
  assert.equal(claim.semantic.authored_relation_family, 'historical');
  assert.equal(claim.semantic.modality, 'historical');
  assert.equal(claim.repair_findings[0].code, 'UNKNOWN_RELATION_FAMILY_NORMALIZED');
  assert.equal(claim.proposition_key, claim.legacy_proposition_key);
});

test('v3.3 relation family remains a legacy index but not core documentary identity', () => {
  const constraint = build(proposal({ relation_family: 'constraint' }));
  const requirement = build(proposal({ relation_family: 'requirement' }));
  assert.notEqual(constraint.legacy_proposition_key, requirement.legacy_proposition_key);
  assert.equal(constraint.core_proposition_key, requirement.core_proposition_key);
  assert.equal(reduceClaimsV33([constraint, constraint]).length, 1);
});

test('v3.3 preserves unknown modality as unresolved and blocks semantic projection', () => {
  const claim = build(proposal({ relation_family: 'permission', modality: 'permission' }));
  assert.equal(claim.semantic.modality, 'unresolved');
  assert.equal(claim.semantic.authored_modality, 'permission');
  assert.equal(claim.semantic.modality_resolution, 'unresolved');
  assert.equal(claim.semantic.projection_eligible, false);
  assert.ok(claim.repair_findings.some(row => row.code === 'UNKNOWN_MODALITY_PRESERVED_UNRESOLVED'));
});
