import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentDocument } from '../tools/wide-context-windows.mjs';
import {
  createWindowBlockCatalog, renderBlockCatalog, repairWhitespaceEquivalentSourceLocator,
  resolveSourceLocator,
} from '../tools/source-locator.mjs';
import { buildClaimV32, countProposedLocators, markupNormalized, reduceClaimsV32 } from '../tools/claim-v32.mjs';
import { buildMentionNamespace, prepassDocument } from '../tools/source-prepass.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: 'digest' };
const content = [
  '# Port rules',
  '',
  'The key DASHBOARD_PORT maps to server.port.',
  'The key DASHBOARD_PORT is protected.',
  '',
  'Only ASCRYBE_TEST_OVERRIDE_KEYS may promote the test port.',
  'Unicode café remains exact.',
  '',
].join('\n');
const prepass = prepassDocument({ path: 'doc.md', content, ...snapshot });
const { windows: [window] } = segmentDocument({ path: 'doc.md', content, snapshot });
const catalog = createWindowBlockCatalog({ window, inventories: [prepass.inventory] });
const tokenFor = fragment => catalog.entries.find(entry => entry.text.includes(fragment))?.token;

const locator = (quote, extra = {}) => ({ block_token: tokenFor(quote) || tokenFor('DASHBOARD_PORT'), quote, ...extra });

function proposal({ subjectQuote = 'DASHBOARD_PORT maps to server.port', subjectSurface = 'DASHBOARD_PORT', evidenceQuote = 'The key DASHBOARD_PORT maps to server.port.', canonical_ref = null } = {}) {
  return {
    subject_mention: { surface: subjectSurface, source_locator: locator(subjectQuote) },
    ...(canonical_ref ? { canonical_ref } : {}),
    predicate_family: 'maps_to', object_or_value: 'server.port',
    polarity: 'affirmed', modality: 'constitutive', quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: locator(evidenceQuote) }] }],
  };
}

const build = proposed => buildClaimV32({
  proposed, window, catalog,
  namespace: buildMentionNamespace([prepass]),
  model_identifier: 'fake/model', prompt_digest: 'prompt',
});

test('catalog renders opaque block tokens and resolver derives exact line and byte coordinates', () => {
  const rendered = renderBlockCatalog(catalog);
  assert.match(rendered, /\[b\d{3} PRIMARY doc\.md:\d+-\d+\]/);
  const resolved = resolveSourceLocator({ locator: locator('café', { occurrence: 1 }), catalog });
  assert.equal(resolved.file, 'doc.md');
  assert.equal(resolved.start, 7);
  assert.equal(resolved.end, 7);
  assert.equal(Buffer.byteLength(content.slice(0, content.indexOf('café')), 'utf8'), resolved.byte_start);
  assert.equal(content.slice(content.indexOf('café'), content.indexOf('café') + 4), resolved.text);
});

test('zero, ambiguous, near, short, and wrong-role locators fail with typed errors', () => {
  assert.throws(() => resolveSourceLocator({ locator: { block_token: tokenFor('DASHBOARD_PORT'), quote: 'DASHBOARD_PORT', occurrence: null }, catalog }),
    error => error.code === 'SHORT_QUOTE_REQUIRES_DISAMBIGUATOR');
  assert.throws(() => resolveSourceLocator({ locator: { block_token: tokenFor('DASHBOARD_PORT'), quote: 'DASHBOARD_PORT', context_before: '' }, catalog }),
    error => error.code === 'SHORT_QUOTE_REQUIRES_DISAMBIGUATOR', 'empty context is not a disambiguator');
  assert.throws(() => resolveSourceLocator({ locator: locator('DASHBOARD_PORT', { context_before: 'key ' }), catalog }),
    error => error.code === 'LOCATOR_QUOTE_AMBIGUOUS');
  assert.throws(() => resolveSourceLocator({ locator: locator('dashboard_port is protected', { occurrence: 1 }), catalog }),
    error => error.code === 'LOCATOR_QUOTE_NOT_FOUND', 'near/case-insensitive matches are never repaired');
  assert.throws(() => resolveSourceLocator({ locator: locator('The key DASHBOARD_PORT maps to server.port.'), catalog, expected_role: 'context' }),
    error => error.code === 'LOCATOR_ROLE_MISMATCH');
  const selected = resolveSourceLocator({ locator: locator('DASHBOARD_PORT', { occurrence: 2 }), catalog });
  assert.equal(selected.start, 4, 'explicit occurrence disambiguates deterministically');
});

test('v28 whitespace repair rewrites one same-block match to exact source bytes and fails closed', () => {
  const repairContent = [
    '# Search',
    '',
    'Hill climb is informed greedy local improvement',
    'with admissibility-gated keep-best behavior.',
    '',
    'Repeated alpha beta gamma',
    'delta. Repeated alpha beta gamma  delta.',
    '',
    '| Rule | Consequence |',
    '| --- | --- |',
    '| Do not invent | Defer |',
    '| Missing edge kinds | Retire |',
    '',
    '- first obligation',
    '- second obligation',
    '',
  ].join('\n');
  const held = prepassDocument({ path: 'repair.md', content: repairContent, ...snapshot });
  const repairWindow = segmentDocument({ path: 'repair.md', content: repairContent, snapshot }).windows[0];
  const repairCatalog = createWindowBlockCatalog({ window: repairWindow, inventories: [held.inventory] });
  const paragraph = repairCatalog.entries.find(entry => entry.text.includes('Hill climb'));
  const result = repairWhitespaceEquivalentSourceLocator({ locator: {
    block_token: paragraph.token,
    quote: 'Hill climb is informed greedy local improvement with admissibility-gated keep-best behavior.',
  }, catalog: repairCatalog });
  assert.equal(result.repair.code, 'WHITESPACE_EQUIVALENT_LOCATOR_REWRITTEN');
  assert.equal(result.locator.quote, 'Hill climb is informed greedy local improvement\nwith admissibility-gated keep-best behavior.');
  assert.equal(result.resolved.text, result.locator.quote);
  assert.equal(result.repair.exact_source_quote, result.resolved.text);
  assert.equal(result.repair.byte_start, result.resolved.byte_start);
  assert.equal(result.repair.text_digest, result.resolved.text_digest);

  const repeated = repairCatalog.entries.find(entry => entry.text.includes('Repeated alpha'));
  assert.throws(() => repairWhitespaceEquivalentSourceLocator({ locator: {
    block_token: repeated.token, quote: 'Repeated alpha beta gamma delta.',
  }, catalog: repairCatalog }), error => error.code === 'WHITESPACE_EQUIVALENT_QUOTE_AMBIGUOUS');

  const table = repairCatalog.entries.find(entry => entry.type === 'table');
  assert.throws(() => repairWhitespaceEquivalentSourceLocator({ locator: {
    block_token: table.token, quote: '| Do not invent | Defer | | Missing edge kinds | Retire |',
  }, catalog: repairCatalog }), error => error.code === 'WHITESPACE_EQUIVALENT_BOUNDARY_CROSSING');

  const list = repairCatalog.entries.find(entry => entry.type === 'list');
  assert.throws(() => repairWhitespaceEquivalentSourceLocator({ locator: {
    block_token: list.token, quote: '- first obligation - second obligation',
  }, catalog: repairCatalog }), error => error.code === 'WHITESPACE_EQUIVALENT_BOUNDARY_CROSSING');

  assert.throws(() => repairWhitespaceEquivalentSourceLocator({ locator: {
    block_token: paragraph.token, quote: 'Repeated alpha beta gamma delta.',
  }, catalog: repairCatalog }), error => error.code === 'LOCATOR_QUOTE_NOT_FOUND',
  'an exact quote elsewhere in the file is never allowed to escape the declared block');
});

test('malformed legacy locator fields still count as proposed addressing attempts', () => {
  const legacy = {
    subject_mention: 'DASHBOARD_PORT',
    source_locator: 'DESIGN.md:128-143',
    support_sets: [[
      { source_locator: 'DESIGN.md:128-143', role: 'PRIMARY', quote: 'DASHBOARD_PORT' },
      { source_locator: 'DESIGN.md:162-170', role: 'SECONDARY', quote: 'force_local' },
    ]],
  };
  assert.equal(countProposedLocators(legacy), 3, 'invalid shape is measured, not reported as zero locators');
});

test('v3.2 accepts only resolved locators and reports honest locator stats', () => {
  const claim = build(proposal());
  assert.equal(claim.schema, 'estate-map/documentary-claim/v3.2');
  assert.equal(claim.semantic.subject.span.start, 3);
  assert.equal(claim.semantic.support_sets[0].spans[0].start, 3);
  assert.deepEqual(claim.locator_stats, { proposed: 2, resolved: 2, failed: 0 });
  assert.throws(() => build(proposal({ evidenceQuote: 'The key DASHBOARD_PORT maps near server.port.' })), error => {
    assert.equal(error.code, 'LOCATOR_QUOTE_NOT_FOUND');
    assert.deepEqual(error.detail.locator_stats, { proposed: 2, resolved: 1, failed: 1 });
    return true;
  });
});

test('markup normalization removes formatting without collapsing identifier underscores', () => {
  assert.equal(markupNormalized('**one** `A_B`'), 'one a_b');
  assert.notEqual(markupNormalized('A_B'), markupNormalized('AB'));
});

test('subject binding variants preserve literal anchors without pretending every referent is explicit', () => {
  const explicit = build({ ...proposal(), subject_binding: 'explicit', subject_occurrence_id: 'subject-occurrence:test' });
  assert.equal(explicit.semantic.subject.binding.kind, 'explicit');
  assert.equal(explicit.semantic.subject.binding.subject_occurrence_id, 'subject-occurrence:test');

  const anaphoric = build({
    ...proposal(), subject_binding: 'anaphoric',
    subject_mention: {
      surface: 'DASHBOARD_PORT',
      source_locator: locator('The key', { occurrence: 1 }),
      antecedent_locator: locator('DASHBOARD_PORT maps to server.port'),
    },
  });
  assert.equal(anaphoric.semantic.subject.binding.kind, 'anaphoric');
  assert.equal(anaphoric.semantic.subject.literal_surface, 'The key');
  assert.equal(anaphoric.semantic.subject.binding.antecedent_locator.text, 'DASHBOARD_PORT maps to server.port');

  const implicit = build({
    ...proposal(), subject_binding: 'implicit_topic',
    subject_mention: { surface: 'Port rules', source_locator: locator('# Port rules', { occurrence: 1 }) },
  });
  assert.equal(implicit.semantic.subject.binding.kind, 'implicit_topic');

  const unresolved = build({
    ...proposal(), subject_binding: 'unresolved', canonical_ref: 'schema:the-key',
    subject_mention: { surface: 'The key', source_locator: locator('The key', { occurrence: 1 }) },
  });
  assert.equal(unresolved.semantic.subject.resolution_status, 'unresolved');
  assert.equal(unresolved.semantic.subject.canonical_ref, null);
});

test('relation family is controlled while raw predicate text remains verbatim', () => {
  const claim = build({ ...proposal(), relation_family: 'configuration', predicate_family: 'maps exactly to' });
  assert.equal(claim.semantic.relation_family, 'configuration');
  assert.equal(claim.semantic.predicate_family, 'maps exactly to');
  assert.throws(() => build({ ...proposal(), relation_family: 'whatever-the-model-wants' }),
    error => error.code === 'INVALID_RELATION_FAMILY');
});

test('canonical identity requires the exact source surface to match the reference tail', () => {
  const grounded = build(proposal({ canonical_ref: 'schema:dashboard-port' }));
  assert.equal(grounded.semantic.subject.canonical_ref, 'schema:dashboard-port');
  assert.equal(grounded.semantic.subject.canonical_basis, 'exact_source_surface_matches_canonical_tail');
  const invented = build(proposal({ canonical_ref: 'command:unrelated-operation' }));
  assert.equal(invented.semantic.subject.canonical_ref, null);
  assert.equal(invented.semantic.subject.rejected_canonical_ref, 'command:unrelated-operation');
  assert.ok(invented.semantic.subject.candidate_refs.includes('command:unrelated-operation'));
});

test('proposition identity ignores claim occurrence and evidence but remains document-local without canonical source identity', () => {
  const first = build(proposal());
  const second = build(proposal({ evidenceQuote: 'The key DASHBOARD_PORT is protected.' }));
  assert.equal(first.proposition_key, second.proposition_key, 'same local proposition survives overlap/occurrence changes');
  assert.notEqual(first.evidence_key, second.evidence_key);
  const reduced = reduceClaimsV32([second, first]);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].semantic.support_sets.length, 2);
  assert.deepEqual(reduced, reduceClaimsV32([first, second]), 'reduction is permutation invariant');

  const otherContent = 'The key DASHBOARD_PORT maps to server.port.\n';
  const otherPrepass = prepassDocument({ path: 'other.md', content: otherContent, ...snapshot });
  const { windows: [otherWindow] } = segmentDocument({ path: 'other.md', content: otherContent, snapshot });
  const otherCatalog = createWindowBlockCatalog({ window: otherWindow, inventories: [otherPrepass.inventory] });
  const other = buildClaimV32({
    proposed: {
      ...proposal(),
      subject_mention: { surface: 'DASHBOARD_PORT', source_locator: { block_token: 'b001', quote: 'DASHBOARD_PORT maps to server.port' } },
      support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: 'b001', quote: 'The key DASHBOARD_PORT maps to server.port.' } }] }],
    },
    window: otherWindow, catalog: otherCatalog,
    namespace: buildMentionNamespace([otherPrepass]), model_identifier: 'fake/model', prompt_digest: 'prompt',
  });
  assert.notEqual(first.proposition_key, other.proposition_key, 'surface equality cannot merge documents');

  const canonicalA = build(proposal({ canonical_ref: 'schema:dashboard-port' }));
  const canonicalB = buildClaimV32({
    proposed: {
      ...proposal({ canonical_ref: 'schema:dashboard-port' }),
      subject_mention: { surface: 'DASHBOARD_PORT', source_locator: { block_token: 'b001', quote: 'DASHBOARD_PORT maps to server.port' } },
      support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator: { block_token: 'b001', quote: 'The key DASHBOARD_PORT maps to server.port.' } }] }],
    },
    window: otherWindow, catalog: otherCatalog,
    namespace: buildMentionNamespace([otherPrepass]), model_identifier: 'fake/model', prompt_digest: 'prompt',
  });
  assert.notEqual(canonicalA.proposition_key, canonicalB.proposition_key,
    'canonical concept links never collapse document-specific claim occurrences during extraction');
});
