// Locates ontology evidence in one projection of the normal graph. A cited passage is bound to a graph Document only when the
// document's content identity (blob id) equals the passage's, at the same repository path, and the projection was built at the
// commit the passage was cited at. A locator finds evidence; it never makes a graph node the identity of a concept or domain.
const REASONS = Object.freeze({
  bound: 'Exact content match (blob_oid), file level: the graph holds this exact file at this path.',
  same_content_other_path: 'The graph holds this exact file content, but at a different path.',
  source_not_in_graph: 'The graph does not include this source repository.',
  pin_differs: 'The graph was built at a different commit of this source.',
  file_version_differs: 'The graph holds a different version of this file.',
  not_in_graph: 'The file is not a document in this graph.',
  refused_projection: 'Bindings are refused because the graph projection is not the one they were made for.',
});
const MAX_PAGE = 24;

export class GraphBindingRefused extends Error {
  constructor(message, detail = {}) { super(message); this.code = 'GRAPH_BINDING_REFUSED'; this.detail = detail; }
}

// `concepts[i]` is the evidence of concept i: [{ repository, path, commit_sha, blob_oid }]. Nothing is read from the graph but its
// head and its Document nodes, through fixed read-only queries.
export async function createGraphBinding({ queries, view, expectedProjectionId = null, concepts, refs = null, blobMap = null }) {
  const head = await queries.projection(view);
  const refusal = expectedProjectionId && head.projection_id !== expectedProjectionId
    ? { reason: 'expected_projection_differs', expected: expectedProjectionId, found: head.projection_id } : null;
  const byPath = new Map(), byBlob = new Map();
  let suppliedBlobs = 0;
  if (!refusal) {
    const { data } = await queries.documentAnchors({ view });
    for (const d of data.documents) {
      // The document's address is its node id (`doc:<repository>/<path>`), the same form in every estate. A build whose Document nodes
      // carry no content id may be given one from the pinned tree by the caller; that is counted and reported apart.
      const address = d.node_id.replace(/^doc:/u, ''), blob = d.blob_oid ?? blobMap?.get(d.node_id) ?? null;
      if (!d.blob_oid && blob) suppliedBlobs += 1;
      byPath.set(address, d);
      if (blob) (byBlob.get(blob) ?? byBlob.set(blob, []).get(blob)).push({ ...d, address });
    }
  }
  const pins = head.source_pins ?? {};

  // Line-level references from a sidecar: graph nodes whose own locator lies inside a cited passage's lines. They are used only when
  // the sidecar was made against this very projection; they locate evidence and never identify a concept.
  let refsRefusal = null;
  if (refs) {
    if (refs.graph?.projection_id !== head.projection_id || (head.content_digest && refs.graph?.content_digest !== head.content_digest)) {
      refsRefusal = { reason: 'refs_made_for_another_projection', refs_projection: refs.graph?.projection_id ?? null, graph_projection: head.projection_id };
    }
  }
  const passageRefs = refs && !refsRefusal && !refusal ? refs.refs : {};

  function classify(row) {
    if (refusal) return { status: 'refused_projection' };
    if (!(row.repository in pins)) return { status: 'source_not_in_graph' };
    if (pins[row.repository] !== row.commit_sha) return { status: 'pin_differs' };
    const address = `${row.repository}/${row.path}`;
    const hit = (byBlob.get(row.blob_oid) ?? []).find(d => d.address === address);
    if (hit) return { status: 'bound', node_id: hit.node_id };
    if (byPath.has(address)) return { status: 'file_version_differs' };
    return { status: byBlob.has(row.blob_oid) ? 'same_content_other_path' : 'not_in_graph' };
  }

  const classified = concepts.map(rows => rows.map(classify));
  const nodeConcepts = new Map();
  classified.forEach((rows, i) => rows.forEach(c => { if (c.node_id) (nodeConcepts.get(c.node_id) ?? nodeConcepts.set(c.node_id, new Set()).get(c.node_id)).add(i); }));

  // The head is read again on every request: a graph that moved on is refused, never silently used.
  async function guard(requestedView) {
    if (requestedView && requestedView !== view) throw new GraphBindingRefused(`These bindings were made for the ${view} projection, not ${requestedView}.`, { bound_view: view, requested_view: requestedView });
    const now = await queries.projection(view);
    if (now.projection_id !== head.projection_id) throw new GraphBindingRefused('The graph projection changed after these bindings were made. Restart the viewer to bind to the current one.', { bound: head.projection_id, now: now.projection_id });
    if (refusal) throw new GraphBindingRefused('The graph projection is not the one this viewer was configured to bind to.', refusal);
  }

  function anchorsFor(indices, { limit = 12, offset = 0 } = {}) {
    const nodes = new Map(), located = new Map(), unresolved = {};
    let passages = 0, bound = 0, withAnchor = 0, noEvidence = 0, withRefs = 0;
    for (const i of indices) {
      const rows = classified[i] ?? [];
      if (!rows.length) { noEvidence += 1; continue; }
      let any = false;
      for (const [n, c] of rows.entries()) {
        passages += 1;
        const found = passageRefs[concepts[i][n]?.evidence_id];
        if (found?.length) {
          withRefs += 1;
          for (const r of found) { const l = located.get(r.node_id) ?? located.set(r.node_id, { node_id: r.node_id, kind: r.kind, label: r.label, passages: 0 }).get(r.node_id); l.passages += 1; }
        }
        if (c.status === 'bound') {
          bound += 1; any = true;
          const n = nodes.get(c.node_id) ?? nodes.set(c.node_id, { node_id: c.node_id, passages: 0, concepts: new Set() }).get(c.node_id);
          n.passages += 1; n.concepts.add(i);
        } else unresolved[c.status] = (unresolved[c.status] ?? 0) + 1;
      }
      if (any) withAnchor += 1;
    }
    const ranked = [...nodes.values()].sort((a, b) => b.concepts.size - a.concepts.size || b.passages - a.passages || a.node_id.localeCompare(b.node_id));
    const page = Math.min(Math.max(Number(limit) || 0, 0), MAX_PAGE), start = Math.max(Number(offset) || 0, 0);
    return { total_anchors: ranked.length, offset: start, anchors: ranked.slice(start, start + page).map(n => ({ node_id: n.node_id, passages: n.passages, concepts: n.concepts.size })),
      located_nodes: { total: located.size, passages_with_refs: withRefs, nodes: [...located.values()].sort((a, b) => b.passages - a.passages || a.node_id.localeCompare(b.node_id)).slice(0, MAX_PAGE) },
      coverage: { concepts: indices.length, concepts_with_anchor: withAnchor, concepts_without_evidence: noEvidence, passages, passages_bound: bound, unresolved },
      reasons: REASONS };
  }

  const citedFiles = new Set(concepts.flatMap(rows => rows.map(r => `${r.repository}\0${r.path}`)));
  const linkedByRefs = new Set(Object.values(passageRefs).flatMap(list => list.map(r => r.node_id)));
  return Object.freeze({
    view, head, refused: refusal, guard, classify, anchorsFor, reasons: REASONS, citedFiles, linkedByRefs,
    documents: () => [...byPath.entries()].map(([address, d]) => ({ node_id: d.node_id, address })),
    boundNodeIds: () => new Set(nodeConcepts.keys()),
    conceptsForNode: nodeId => [...(nodeConcepts.get(nodeId) ?? [])],
    annotate: row => { const c = classify(row); const located = passageRefs[row.evidence_id]; return { ...c, reason: REASONS[c.status], ...(located?.length ? { located } : {}) }; },
    info: () => ({ view, refs: refs ? { loaded: !refsRefusal && !refusal, refused: refsRefusal, passages_with_refs: Object.keys(passageRefs).length, note: refs.note ?? null } : null, projection_id: head.projection_id, content_digest: head.content_digest ?? null, nodes_sha256: refs?.graph?.nodes_sha256 ?? null, projection_version: head.projection_version ?? null, blobs_from_supplied_map: suppliedBlobs, expected_projection_id: expectedProjectionId,
      refused: refusal, source_pins: pins, documents: byPath.size, bound_passages: classified.flat().filter(c => c.status === 'bound').length,
      passages: classified.reduce((n, r) => n + r.length, 0) }),
  });
}
