import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimMapDrilldownPayload, renderClaimMapDrilldownHtml } from '../tools/claim-map-drilldown.mjs';

const nodes = [
  { id: 'd1', kind: 'source_document', path: 'a.md', authority_plane: 'source' },
  { id: 'd2', kind: 'source_document', path: 'b.md', authority_plane: 'source' },
  { id: 'w1', kind: 'extraction_window', files: ['a.md'], authority_plane: 'custody' },
  { id: 'c1', kind: 'documentary_claim', subject: { surface: 'Router' }, predicate_family: 'routes',
    object_or_value: 'work', relation_family: 'capability', authority_plane: 'documentary_claim' },
  { id: 'm1', kind: 'subject_mention', surface: 'Router', authority_plane: 'documentary_claim' },
  { id: 's1', kind: 'support_set', mode: 'all_required', authority_plane: 'documentary_claim' },
  { id: 'e1', kind: 'evidence_span', file: 'a.md', start: 1, end: 1, text: 'Router routes work.', authority_plane: 'source' },
  { id: 'c2', kind: 'documentary_claim', subject: { surface: 'Other' }, predicate_family: 'owns',
    object_or_value: 'b', relation_family: 'composition', authority_plane: 'documentary_claim' },
];
const edge = (kind, from, to, index) => ({ id: `e${index}`, kind, from, to });
const edges = [
  edge('window_in_document', 'w1', 'd1', 1),
  edge('claim_grounded_in_document', 'c1', 'd1', 2),
  edge('claim_has_subject_mention', 'c1', 'm1', 3),
  edge('claim_has_support_set', 'c1', 's1', 4),
  edge('support_requires_span', 's1', 'e1', 5),
  edge('span_in_document', 'e1', 'd1', 6),
  edge('claim_grounded_in_document', 'c2', 'd2', 7),
];
const graph = { schema: 'estate-map/claim-source-graph/v2', digest: 'graph-digest',
  source_artifact: {}, snapshot: {}, metrics: { claims: 2, documents: 2 }, findings: [], nodes, edges };
const grade = { status: 'complete_passed_confirmation', pass: true, digest: 'grade-digest',
  metrics: { control: { document_scope: { strict_recall: .5 } }, treatment: { document_scope: { strict_recall: .75 } } },
  paired_primary: { observed_gain: .25, confidence_interval: { lower_95: .15 } } };

test('document drilldown includes exact local claim lineage without leaking another document', () => {
  const payload = buildClaimMapDrilldownPayload({ graph, confirmation: grade });
  const first = payload.documents.find(row => row.p === 'a.md');
  const ids = first.m.map(index => payload.nodes[index].d.forensic_id);
  assert.deepEqual(new Set(ids), new Set(['d1', 'w1', 'c1', 'm1', 's1', 'e1']));
  assert.equal(ids.includes('c2'), false);
  assert.equal(first.c.documentary_claim, 1);
  assert.equal(payload.confirmation.pass, true);
});

test('fast claim map is self-contained, metadata-complete, and first-paint padded', () => {
  const html = renderClaimMapDrilldownHtml({ graph, confirmation: grade });
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /<meta charset="UTF-8">/u);
  assert.match(html, /<meta name="viewport"/u);
  assert.match(html, /<title>Ascrybe — V32 Confirmed Treatment<\/title>/u);
  assert.match(html, /application\/octet-stream/u);
  assert.match(html, /DecompressionStream/u);
  assert.ok(html.split('\n').slice(0, 50).every(line => line.length < 500));
});
