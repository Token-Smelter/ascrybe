import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignSubjectRefs,
  buildDocumentaryClaimV3,
  canonicalRegionOrder,
  claimDedupKey,
  conservationReceipt,
  createAliasLedger,
  createEvidenceRegion,
  createMapBundle,
  createPlanningHypothesis,
  inventoryMarkdown,
  reduceDuplicateClaims,
  rootEvidenceRegion,
} from '../tools/recursive-contracts.mjs';
import { buildExtractionPrompt, buildPlanningPrompt } from '../tools/recursive-semantic-mapper.mjs';
import { assembleDisagreementCases } from '../tools/documentation-claim-census.mjs';
import { buildPropositionIndex } from '../tools/proposition-index.mjs';
import { sha256 } from '../tools/lib.mjs';

const source = [
  '# Alpha',
  'Alpha is a protocol for exact state.',
  '',
  '## Rules',
  '- It must preserve evidence.',
  '- It must not infer identity.',
  '',
  '| Field | Meaning |',
  '| --- | --- |',
  '| state | exact |',
  '',
  '```json',
  '{"state":"exact"}',
  '```',
  '',
  'Final paragraph with ünicode.',
  '',
].join('\n');
const snapshot = { source_sha: 'source-sha', corpus_digest: 'corpus-digest' };

function fixture() {
  const inventory = inventoryMarkdown({ path: 'alpha.md', content: source, ...snapshot });
  const root = rootEvidenceRegion(inventory, snapshot);
  return { inventory, root };
}

function splitFixture() {
  const { inventory, root } = fixture();
  const midpoint = Math.ceil(inventory.blocks.length / 2);
  const left = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: inventory.blocks.slice(0, midpoint).map(block => block.address), parent_id: root.id, depth: 1, snapshot });
  const right = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: inventory.blocks.slice(midpoint).map(block => block.address), context_block_addresses: [inventory.blocks[0].address], parent_id: root.id, depth: 1, snapshot });
  return { inventory, root, left, right };
}

function proposal({ subject_ref = 'concept:alpha', referent_status = 'resolved', primary, context = null }) {
  return {
    subject_ref: referent_status === 'resolved' ? subject_ref : null,
    subject_kind: 'concept',
    unresolved_subject: referent_status === 'unresolved' ? 'possible alpha' : null,
    referent_status,
    predicate_family: 'preserves_evidence',
    object_or_value: 'Alpha must preserve evidence.',
    polarity: 'affirmed',
    modality: 'normative',
    quantifier: 'universal',
    scope: { component: 'alpha' },
    valid_time: { from: null, until: null },
    source_spans: [primary, ...(context ? [context] : [])],
  };
}

test('markdown inventory is byte-lossless and region identity ignores tree placement', () => {
  const { inventory, root } = fixture();
  assert.equal(inventory.blocks.map(block => block.raw).join(''), source);
  assert.equal(inventory.bytes, Buffer.byteLength(source));
  assert.ok(inventory.blocks.some(block => block.type === 'table'));
  assert.ok(inventory.blocks.some(block => block.type === 'code'));
  const clone = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: root.primary_block_addresses, parent_id: 'different-parent', depth: 2, status: 'unresolved', snapshot });
  assert.equal(clone.id, root.id, 'content-only identity excludes parent/depth/status');
});

test('conservation and planning are permutation invariant', () => {
  const { inventory, root, left, right } = splitFixture();
  const forward = conservationReceipt({ parent: root, children: [left, right] });
  const reverse = conservationReceipt({ parent: root, children: [right, left] });
  assert.equal(forward.valid, true);
  assert.deepEqual(reverse, forward);
  const specs = [left, right].map((region, index) => ({ label: `child-${index}`, primary_block_addresses: region.primary_block_addresses, context_block_addresses: region.context_block_addresses }));
  const plan = children => createPlanningHypothesis({
    region: root,
    proposed: { outcome: 'split', reason: 'two coherent concepts', concept_candidates: [{ term: 'Alpha', anchor_block_addresses: [inventory.blocks[0].address] }], children },
    model_identifier: 'mock/planner', prompt_digest: 'prompt', inventories: [inventory], atomic_primary_bytes: root.primary_bytes, max_depth: 2,
  });
  const a = plan(specs), b = plan(specs.slice().reverse());
  assert.equal(a.hypothesis.digest, b.hypothesis.digest);
  assert.deepEqual(canonicalRegionOrder(a.children).map(region => region.id), canonicalRegionOrder(b.children).map(region => region.id));
});

test('multi-span claims retain roles, context cannot stand alone, and overlap dedups', () => {
  const { inventory, left } = splitFixture();
  const primaryBlock = inventory.blocks.find(block => block.text.includes('preserve evidence'));
  const heading = inventory.blocks[0];
  const region = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: [primaryBlock.address], context_block_addresses: [heading.address], snapshot });
  const proposed = proposal({
    primary: { role: 'primary', file: inventory.path, start: primaryBlock.start, end: primaryBlock.end },
    context: { role: 'context', file: inventory.path, start: heading.start, end: heading.end },
  });
  const first = buildDocumentaryClaimV3({ proposed, region, inventories: [inventory], model_identifier: 'mock/a', prompt_digest: 'a' });
  const second = buildDocumentaryClaimV3({ proposed, region, inventories: [inventory], model_identifier: 'mock/b', prompt_digest: 'b' });
  assert.equal(first.semantic.provenance.source_excerpts[0].role, 'primary');
  assert.equal(first.semantic.provenance.source_excerpts[1].role, 'context');
  assert.equal(claimDedupKey(first), claimDedupKey(second));
  assert.equal(reduceDuplicateClaims([second, first]).length, 1);
  const contextOnly = { ...proposed, source_spans: [{ role: 'context', file: inventory.path, start: heading.start, end: heading.end }] };
  assert.throws(() => buildDocumentaryClaimV3({ proposed: contextOnly, region, inventories: [inventory], model_identifier: 'mock', prompt_digest: 'x' }), error => error.code === 'MISSING_PRIMARY_SPAN');
});

test('referents align only by exact identity or source-cited alias', () => {
  const { inventory, left } = splitFixture();
  const primaryBlock = inventory.blocks.find(block => block.text.includes('preserve evidence'));
  const region = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: left.primary_block_addresses, snapshot });
  const primary = { role: 'primary', file: inventory.path, start: primaryBlock.start, end: primaryBlock.end };
  const canonicalClaim = buildDocumentaryClaimV3({ proposed: proposal({ primary }), region, inventories: [inventory], model_identifier: 'mock', prompt_digest: '1' });
  const unresolved = buildDocumentaryClaimV3({ proposed: proposal({ referent_status: 'unresolved', primary }), region, inventories: [inventory], model_identifier: 'mock', prompt_digest: '2' });
  const aliasClaim = buildDocumentaryClaimV3({ proposed: proposal({ subject_ref: 'concept:alpha-alias', primary }), region, inventories: [inventory], model_identifier: 'mock', prompt_digest: '3' });
  assert.equal(alignSubjectRefs(canonicalClaim, unresolved).aligned, false);
  assert.equal(alignSubjectRefs(canonicalClaim, aliasClaim).aligned, false);
  assert.throws(() => createAliasLedger([{ alias: 'concept:alpha-alias', canonical_ref: 'concept:alpha', source_spans: [] }]), error => error.code === 'UNSOURCED_ALIAS');
  const ledger = createAliasLedger([{ alias: 'concept:alpha-alias', canonical_ref: 'concept:alpha', source_spans: [primary], accepted_by: 'human' }]);
  assert.equal(alignSubjectRefs(canonicalClaim, aliasClaim, ledger).aligned, true);
});

test('prompt, case, and checkpoint identities survive input permutations', () => {
  const { inventory, root } = fixture();
  const reversedRegion = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: root.primary_block_addresses.slice().reverse(), snapshot });
  assert.equal(reversedRegion.id, root.id);
  const bounds = { atomic_primary_bytes: 100_000, max_children_per_region: 6, max_depth: 2 };
  const planningA = buildPlanningPrompt({ region: root, inventories: [inventory], bounds });
  const planningB = buildPlanningPrompt({ region: reversedRegion, inventories: [inventory], bounds });
  assert.equal(planningA, planningB);
  const extractionA = buildExtractionPrompt({ region: root, inventories: [inventory], arm: 'C', max_claims: 64 });
  const extractionB = buildExtractionPrompt({ region: reversedRegion, inventories: [inventory], arm: 'C', max_claims: 64 });
  assert.equal(extractionA, extractionB);
  assert.equal(sha256(extractionA), sha256(extractionB));

  const block = inventory.blocks.find(item => item.text.includes('preserve evidence'));
  const region = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: [block.address], snapshot });
  const primary = { role: 'primary', file: inventory.path, start: block.start, end: block.end };
  const affirmed = buildDocumentaryClaimV3({ proposed: proposal({ primary }), region, inventories: [inventory], model_identifier: 'mock', prompt_digest: 'same' });
  const negatedProposal = { ...proposal({ primary }), object_or_value: 'Alpha must not preserve evidence.', polarity: 'negated' };
  const negated = buildDocumentaryClaimV3({ proposed: negatedProposal, region, inventories: [inventory], model_identifier: 'mock', prompt_digest: 'other' });
  const forwardClaims = [affirmed, negated], reverseClaims = [negated, affirmed];
  const forward = assembleDisagreementCases(forwardClaims, buildPropositionIndex(forwardClaims, { snapshot }), { snapshot });
  const reverse = assembleDisagreementCases(reverseClaims, buildPropositionIndex(reverseClaims, { snapshot }), { snapshot });
  assert.ok(forward.assemblies.length > 0);
  assert.deepEqual(forward.assemblies.map(item => item.case_id), reverse.assemblies.map(item => item.case_id));
});

test('explicit exclusions balance conservation and cross-document order is canonical', () => {
  const { inventory, root } = fixture();
  const excluded = inventory.blocks.at(-1).address;
  const child = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: root.primary_block_addresses.filter(address => address !== excluded), parent_id: root.id, depth: 1, snapshot });
  assert.equal(conservationReceipt({ parent: root, children: [child], excluded_block_addresses: [excluded] }).valid, true);
  const second = inventoryMarkdown({ path: 'beta.md', content: '# Beta\nBeta is separate.\n', ...snapshot });
  const primary = [inventory.blocks[0].address, second.blocks[0].address];
  const a = createEvidenceRegion({ inventories: [inventory, second], primary_block_addresses: primary, snapshot });
  const b = createEvidenceRegion({ inventories: [inventory, second], primary_block_addresses: primary.slice().reverse(), snapshot });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.region_order_key, b.region_order_key);
});

test('a non-canonical referent downgrades to unresolved instead of discarding the claim', () => {
  const { inventory } = fixture();
  const block = inventory.blocks.find(item => item.text.includes('preserve evidence'));
  const region = createEvidenceRegion({ inventories: [inventory], primary_block_addresses: [block.address], snapshot });
  const primary = { role: 'primary', file: inventory.path, start: block.start, end: block.end };
  const bare = { ...proposal({ primary }), subject_ref: 'state', referent_status: 'resolved' };
  const claim = buildDocumentaryClaimV3({ proposed: bare, region, inventories: [inventory], model_identifier: 'mock', prompt_digest: 'p' });
  const subject = claim.semantic.subject_refs[0];
  assert.equal(claim.semantic.referent_status, 'unresolved');
  assert.equal(subject.ref, null, 'no identity is invented');
  assert.equal(subject.referent_normalized_from, 'state');
  assert.equal(subject.unresolved_label, 'state');
  assert.equal(claim.semantic.predicate_family, 'preserves_evidence', 'claim content survives');
  assert.equal(claim.semantic.provenance.source_excerpts.length, 1);
});

test('MapBundle bytes are invariant to child order', () => {
  const { root, left, right } = splitFixture();
  const leftBundle = createMapBundle({ region: left });
  const rightBundle = createMapBundle({ region: right });
  const a = createMapBundle({ region: root, child_bundles: [leftBundle, rightBundle] });
  const b = createMapBundle({ region: root, child_bundles: [rightBundle, leftBundle] });
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a, b);
});
