import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimV31, claimQualityMetrics, reduceClaimsV31 } from '../tools/claim-v31.mjs';
import { buildMentionNamespace, prepassDocument } from '../tools/source-prepass.mjs';

const source = [
  '# Router',                                            // 1
  '',                                                    // 2
  'The router calls `propose_route(candidate)` on commit.', // 3
  'A case tracks the outcome of each attempt.',          // 4
  'The fence blocks late results.',                      // 5
  'Settlement publishes the revision locally.',          // 6
  '',
].join('\n');

const lines = source.split('\n');
const sliceSource = (_file, start, end) => lines.slice(start - 1, end).join('\n');

const window = {
  id: 'unit:test',
  snapshot: { source_sha: 'sha', corpus_digest: 'digest' },
  primary_spans: [{ file: 'r.md', start: 1, end: 7 }],
  context_spans: [],
};

const namespace = buildMentionNamespace([prepassDocument({ path: 'r.md', content: source, source_sha: 'sha' })]);

const base = {
  predicate_family: 'calls', object_or_value: 'propose_route on commit',
  polarity: 'affirmed', modality: 'descriptive', quantifier: 'unspecified', scope: {}, valid_time: {},
  support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file: 'r.md', start: 3, end: 3 }] }],
};

const build = proposed => buildClaimV31({ proposed, window, sliceSource, namespace, model_identifier: 'm', prompt_digest: 'p' });

test('a source-anchored CONCEPT is lawful and promotable, not a defect', () => {
  // "a case" has no canonical id anywhere in the corpus. Under v3 this was `unresolved` and counted
  // against us; it is the single largest category of the pilot's 66-73% unresolved rate.
  const claim = build({ ...base, subject_mention: { surface: 'a case', span: { file: 'r.md', start: 4, end: 4 } }, predicate_family: 'tracks', object_or_value: 'the outcome of each attempt' });
  assert.equal(claim.semantic.subject.resolution_status, 'local');
  assert.equal(claim.semantic.subject.anchored, true);
  assert.equal(claim.semantic.subject.canonical_ref, null, 'no identity is invented');
  assert.equal(claim.semantic.subject.span.start, 4);
});

test('a subject with NO source anchor is the real defect and is the only unresolved case', () => {
  const claim = build({ ...base, subject_mention: {} });
  assert.equal(claim.semantic.subject.resolution_status, 'unresolved');
  assert.equal(claim.semantic.subject.anchored, false);
});

test('an exact namespace surface resolves local; a cross-document collision is ambiguous', () => {
  const claim = build({ ...base, subject_mention: { surface: 'propose_route(candidate)', span: { file: 'r.md', start: 3, end: 3 } } });
  assert.ok(['local', 'ambiguous'].includes(claim.semantic.subject.resolution_status));
  assert.ok(claim.semantic.subject.mention_id, 'anchored to a real source mention');

  const two = buildMentionNamespace([
    prepassDocument({ path: 'a.md', content: 'Uses `route.commit.apply` here.\n', source_sha: 's' }),
    prepassDocument({ path: 'b.md', content: 'Also uses `route.commit.apply` here.\n', source_sha: 's' }),
  ]);
  const collisionSource = 'Uses `route.commit.apply` here.\n';
  const collide = buildClaimV31({
    proposed: {
      ...base,
      subject_mention: { surface: 'route.commit.apply', span: { file: 'a.md', start: 1, end: 1 } },
      support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file: 'a.md', start: 1, end: 1 }] }],
    },
    window: { id: 'window:a', snapshot: window.snapshot, primary_spans: [{ file: 'a.md', start: 1, end: 1 }], context_spans: [] },
    sliceSource: () => collisionSource.trimEnd(), namespace: two, model_identifier: 'm', prompt_digest: 'p',
  });
  assert.equal(collide.semantic.subject.resolution_status, 'ambiguous', 'a cross-document surface never auto-merges');
});

test('a declared canonical ref is honored only in canonical form', () => {
  const good = build({ ...base, canonical_ref: 'component:router' });
  assert.equal(good.semantic.subject.resolution_status, 'canonical');
  const bare = build({ ...base, canonical_ref: 'state', subject_mention: { surface: 'the fence', span: { file: 'r.md', start: 5, end: 5 } } });
  assert.equal(bare.semantic.subject.resolution_status, 'local', 'a bare word is not a canonical ref');
  assert.equal(bare.semantic.subject.canonical_ref, null);
});

test('support sets distinguish required-together from either-suffices', () => {
  const conjunctive = build({ ...base, support_sets: [{ mode: 'all_required', spans: [
    { role: 'primary', file: 'r.md', start: 3, end: 3 },
    { role: 'primary', file: 'r.md', start: 6, end: 6 },
  ] }] });
  assert.equal(conjunctive.semantic.irreducible_multi_span, true, 'two required primaries is genuinely irreducible');

  const corroborative = build({ ...base, support_sets: [{ mode: 'alternative_support', spans: [
    { role: 'primary', file: 'r.md', start: 3, end: 3 },
    { role: 'primary', file: 'r.md', start: 6, end: 6 },
  ] }] });
  assert.equal(corroborative.semantic.irreducible_multi_span, false,
    'two spans where either suffices is NOT multi-span — this is what the pilot metric could not see');
});

test('custody still holds: primary role, valid coordinates, and no span outside the unit', () => {
  assert.throws(() => build({ ...base, support_sets: [{ mode: 'all_required', spans: [{ role: 'context', file: 'r.md', start: 3, end: 3 }] }] }),
    error => error.code === 'MISSING_PRIMARY_SPAN');
  assert.throws(() => build({ ...base, support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file: 'r.md', start: 99, end: 99 }] }] }),
    error => error.code === 'SPAN_OUTSIDE_ROLE_CUSTODY');
  assert.throws(() => build({ ...base, support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file: 'r.md', start: 5, end: 3 }] }] }),
    error => error.code === 'INVALID_EVIDENCE_SPAN');
  assert.throws(() => build({ ...base, subject_mention: { surface: 'x', span: { file: 'r.md', start: 99, end: 99 } } }),
    error => error.code === 'SUBJECT_SPAN_OUTSIDE_WINDOW');
  assert.throws(() => build({ ...base, subject_mention: { surface: 'router', span: { file: 'r.md', start: 5, end: 3 } } }),
    error => error.code === 'INVALID_SUBJECT_SPAN');
  assert.throws(() => build({ ...base, subject_mention: { surface: 'not verbatim source', span: { file: 'r.md', start: 3, end: 3 } } }),
    error => error.code === 'SUBJECT_SURFACE_NOT_IN_SPAN');
});

test('proposition identity is independent of the citation set', () => {
  const a = build(base);
  const b = build({ ...base, support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file: 'r.md', start: 6, end: 6 }] }] });
  assert.equal(a.proposition_key, b.proposition_key, 'same proposition, different evidence');
  assert.notEqual(a.evidence_key, b.evidence_key);

  const reduced = reduceClaimsV31([a, b]);
  assert.equal(reduced.length, 1, 'one proposition, not two claims');
  assert.equal(reduced[0].semantic.support_sets.length, 2, 'evidence is unioned');
  assert.equal(reduced[0].extraction_provenance.length, 2);
  assert.deepEqual(reduced, reduceClaimsV31([b, a]), 'concurrent completion order cannot change reduced bytes');
  assert.notEqual(reduced[0].id, a.id, 'the reduced id covers the unioned evidence, not the first arrival');
  assert.equal(reduceClaimsV31([a])[0].id, a.id, 'a one-evidence reduction preserves the original id');
});

 test('ambiguous surfaces retain document-local mention identity', () => {
  const sourceA = 'Uses `route.commit.apply` here.\n';
  const sourceB = 'Uses `route.commit.apply` here too.\n';
  const crossNamespace = buildMentionNamespace([
    prepassDocument({ path: 'a.md', content: sourceA, source_sha: 'sha' }),
    prepassDocument({ path: 'b.md', content: sourceB, source_sha: 'sha' }),
  ]);
  const make = (file, content) => buildClaimV31({
    proposed: {
      ...base,
      subject_mention: { surface: 'route.commit.apply', span: { file, start: 1, end: 1 } },
      support_sets: [{ mode: 'all_required', spans: [{ role: 'primary', file, start: 1, end: 1 }] }],
    },
    window: { id: `window:${file}`, snapshot: window.snapshot, primary_spans: [{ file, start: 1, end: 1 }], context_spans: [] },
    sliceSource: () => content.trimEnd(), namespace: crossNamespace, model_identifier: 'm', prompt_digest: 'p',
  });
  const a = make('a.md', sourceA), b = make('b.md', sourceB);
  assert.equal(a.semantic.subject.resolution_status, 'ambiguous');
  assert.equal(b.semantic.subject.resolution_status, 'ambiguous');
  assert.ok(a.semantic.subject.mention_id && b.semantic.subject.mention_id);
  assert.notEqual(a.semantic.subject.mention_id, b.semantic.subject.mention_id, 'each claim binds its cited source mention');
  assert.notEqual(a.proposition_key, b.proposition_key, 'surface collision cannot merge cross-document propositions');
});

test('quality metrics replace the misleading unresolved-referent rate', () => {
  const anchored = build({ ...base, subject_mention: { surface: 'a case', span: { file: 'r.md', start: 4, end: 4 } } });
  const unanchored = build({ ...base, subject_mention: {} });
  const irreducible = build({ ...base, subject_mention: { surface: 'settlement', span: { file: 'r.md', start: 6, end: 6 } }, support_sets: [{ mode: 'all_required', spans: [
    { role: 'primary', file: 'r.md', start: 3, end: 3 },
    { role: 'primary', file: 'r.md', start: 6, end: 6 },
  ] }] });
  const metrics = claimQualityMetrics([anchored, unanchored, irreducible]);
  assert.equal(metrics.claims, 3);
  assert.equal(metrics.unanchored_subjects, 1, 'only the truly unanchored subject counts as a defect');
  assert.equal(metrics.irreducible_multi_span_claims, 1);
  assert.ok(metrics.by_resolution_status.local >= 1);
});
