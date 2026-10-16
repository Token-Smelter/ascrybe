import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphBinding, GraphBindingRefused } from '../tools/ontology/graph-binding.mjs';

const PIN = 'a'.repeat(40);
const head = (id = 'estate-projection:one') => ({ projection_id: id, source_pins: { shop: PIN, docs: PIN } });
const fakeQueries = ({ documents, projection = head() }) => {
  const state = { projection };
  return { state, projection: async () => state.projection, documentAnchors: async () => ({ data: { documents } }) };
};
const row = (over = {}) => ({ repository: 'shop', path: 'src/cart.md', commit_sha: PIN, blob_oid: 'b1', ...over });
const documents = [
  { node_id: 'doc:shop/src/cart.md', path: 'shop/src/cart.md', blob_oid: 'b1' },
  { node_id: 'doc:shop/src/old.md', path: 'shop/src/old.md', blob_oid: 'zz' },
  { node_id: 'doc:shop/src/copy.md', path: 'shop/src/copy.md', blob_oid: 'b1' },
];

test('a passage binds only to the document with the same content at the same path', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[row()]] });
  assert.deepEqual(b.classify(row()), { status: 'bound', node_id: 'doc:shop/src/cart.md' });
});

test('a locator that matches by path or by name alone is never an anchor', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[]] });
  assert.equal(b.classify(row({ path: 'src/old.md', blob_oid: 'other' })).status, 'file_version_differs');
  assert.equal(b.classify(row({ path: 'src/elsewhere.md', blob_oid: 'b1' })).status, 'same_content_other_path');
  assert.equal(b.classify(row({ path: 'src/elsewhere.md', blob_oid: 'unseen' })).status, 'not_in_graph');
  assert.equal(b.classify(row({ repository: 'unknown' })).status, 'source_not_in_graph');
  assert.equal(b.classify(row({ commit_sha: 'c'.repeat(40) })).status, 'pin_differs');
});

test('unmapped and missing evidence is counted with a reason and draws no node', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[row()], [row({ repository: 'unknown' })], []] });
  const found = b.anchorsFor([0, 1, 2]);
  assert.equal(found.total_anchors, 1);
  assert.deepEqual(found.coverage, { concepts: 3, concepts_with_anchor: 1, concepts_without_evidence: 1, passages: 2, passages_bound: 1, unresolved: { source_not_in_graph: 1 } });
  const none = b.anchorsFor([1]);
  assert.equal(none.total_anchors, 0);
  assert.deepEqual(none.anchors, []);
});

test('anchors are bounded per page and the rest is reachable by offset', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ node_id: `doc:shop/f${i}.md`, path: `shop/f${i}.md`, blob_oid: `o${i}` }));
  const concepts = [many.map((d, i) => row({ path: `f${i}.md`, blob_oid: `o${i}` }))];
  const b = await createGraphBinding({ queries: fakeQueries({ documents: many }), view: 'working', concepts });
  const first = b.anchorsFor([0], { limit: 1000 });
  assert.equal(first.anchors.length, 24);
  assert.equal(first.total_anchors, 60);
  const next = b.anchorsFor([0], { limit: 24, offset: 24 });
  assert.equal(next.anchors.length, 24);
  assert.notEqual(next.anchors[0].node_id, first.anchors[0].node_id);
  assert.equal(b.anchorsFor([0], { limit: 0 }).anchors.length, 0);
});

test('a moved graph head is refused on use, not silently followed', async () => {
  const queries = fakeQueries({ documents });
  const b = await createGraphBinding({ queries, view: 'working', concepts: [[row()]] });
  await b.guard('working');
  queries.state.projection = head('estate-projection:two');
  await assert.rejects(() => b.guard('working'), GraphBindingRefused);
  await assert.rejects(() => b.guard('selected'), GraphBindingRefused);
});

test('a projection other than the configured one refuses every binding', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', expectedProjectionId: 'estate-projection:wanted', concepts: [[row()]] });
  assert.equal(b.classify(row()).status, 'refused_projection');
  await assert.rejects(() => b.guard('working'), GraphBindingRefused);
  assert.equal(b.anchorsFor([0]).total_anchors, 0);
});

test('a document maps back to the concepts that cite it', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[row()], [row()], [row({ path: 'src/old.md', blob_oid: 'zz' })]] });
  assert.deepEqual(b.conceptsForNode('doc:shop/src/cart.md'), [0, 1]);
  assert.deepEqual(b.conceptsForNode('doc:shop/src/old.md'), [2]);
  assert.deepEqual(b.conceptsForNode('doc:nothing'), []);
});

test('a build whose documents carry no content id binds through a supplied map, counted apart, and only at the same address', async () => {
  const bare = [{ node_id: 'doc:shop/src/cart.md', path: 'src/cart.md', blob_oid: null }, { node_id: 'doc:shop/src/other.md', path: 'src/other.md', blob_oid: null }];
  const blobMap = new Map([['doc:shop/src/cart.md', 'b1'], ['doc:shop/src/other.md', 'b1']]);
  const b = await createGraphBinding({ queries: fakeQueries({ documents: bare }), view: 'working', concepts: [[row()]], blobMap });
  assert.deepEqual(b.classify(row()), { status: 'bound', node_id: 'doc:shop/src/cart.md' });
  assert.equal(b.classify(row({ path: 'src/elsewhere.md' })).status, 'same_content_other_path');
  assert.equal(b.info().blobs_from_supplied_map, 2);
  const none = await createGraphBinding({ queries: fakeQueries({ documents: bare }), view: 'working', concepts: [[row()]] });
  assert.equal(none.classify(row()).status, 'file_version_differs');
});

const sidecar = (projection = 'estate-projection:one') => ({ graph: { projection_id: projection }, refs: { e1: [{ node_id: 'extracted-fact:s1', kind: 'DocumentSection', label: 'Cart totals' }] } });

test('line-level references locate a passage but never bind a file or define a concept', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[row({ evidence_id: 'e1', path: 'src/old.md', blob_oid: 'moved' })]], refs: sidecar() });
  const note = b.annotate(row({ evidence_id: 'e1', path: 'src/old.md', blob_oid: 'moved' }));
  assert.equal(note.status, 'file_version_differs');
  assert.deepEqual(note.located.map(r => r.node_id), ['extracted-fact:s1']);
  const found = b.anchorsFor([0]);
  assert.equal(found.total_anchors, 0);
  assert.deepEqual(found.located_nodes, { total: 1, passages_with_refs: 1, nodes: [{ node_id: 'extracted-fact:s1', kind: 'DocumentSection', label: 'Cart totals', passages: 1 }] });
  assert.deepEqual(b.conceptsForNode('extracted-fact:s1'), []);
});

test('references made for another projection are refused and shown as such', async () => {
  const b = await createGraphBinding({ queries: fakeQueries({ documents }), view: 'working', concepts: [[row({ evidence_id: 'e1' })]], refs: sidecar('estate-projection:other') });
  assert.equal(b.annotate(row({ evidence_id: 'e1' })).located, undefined);
  assert.equal(b.anchorsFor([0]).located_nodes.total, 0);
  assert.equal(b.info().refs.refused.reason, 'refs_made_for_another_projection');
});
