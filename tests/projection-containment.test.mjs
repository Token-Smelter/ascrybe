import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containmentIndex, documentPathOf, factContainer, validateFactKindRegistry,
} from '../tools/estate-graph-projection.mjs';

const section = (file, line, lineEnd, path, depth, extra = {}) => ({
  kind: 'document_section', repo: 'app', file, document_path: file, line, line_end: lineEnd,
  section_path: path, section_depth: depth, ...extra });
const diagram = (file, line, address) => ({
  kind: 'diagram', repo: 'app', file, document_path: file, line,
  diagram_shape: 'flowchart', diagram_address: address });
const relation = (file, line, address) => ({
  kind: 'diagram_relation', repo: 'app', file, document_path: file, line, diagram_address: address,
  from_identifier: 'A', to_identifier: 'B', arrow: '-->', relation_label: 'emits' });

const index = facts => containmentIndex(facts);

test('a fact kind that declares no container is a projection defect, not a default', () => {
  assert.throws(() => validateFactKindRegistry({ thing: { node_kind: 'Thing', label: () => 'x' } }),
    /must declare node_kind, label and one of contained_by/u);
  assert.throws(() => validateFactKindRegistry({ thing: { node_kind: 'Thing', label: () => 'x', contained_by: 'somewhere' } }),
    /contained_by/u);
  // A kind that names the commit is accepted -- the point is that it was written down.
  assert.equal(typeof validateFactKindRegistry({ thing: { node_kind: 'Thing', label: () => 'x', contained_by: 'commit' } }), 'object');
});

test('a document address is refused rather than guessed when the two path spaces differ', () => {
  const fact = { kind: 'document_section', repo: 'component-b', file: 'AGENTS.md' };
  // Single repository rooted at the estate root: the repository-relative path IS the address.
  assert.equal(documentPathOf(fact, { multi_repository: false }), 'AGENTS.md');
  // Multi-repository: 'AGENTS.md' is not the estate-relative path and nothing here can rebuild it.
  assert.equal(documentPathOf(fact, { multi_repository: true }), null);
  // A fact that carries its own address needs neither case.
  assert.equal(documentPathOf({ ...fact, document_path: 'component-b/AGENTS.md' }, { multi_repository: true }),
    'component-b/AGENTS.md');
});

test('a section belongs to the section above it, and a top-level section to its document', () => {
  const outer = section('doc.md', 1, 40, 'Design', 1);
  const inner = section('doc.md', 10, 25, 'Design / Constraints', 2);
  const facts = [outer, inner];
  const held = index(facts);
  const ids = [...held.documents.keys()];
  const [outerId, innerId] = ids;

  const outerContainer = factContainer(outer, outerId, held, () => true);
  const innerContainer = factContainer(inner, innerId, held, () => true);
  // `via` is what the container REPORT reads: a top-level section falling through to its
  // document and a nested one landing on its parent both declare `contained_by: 'section'`, and
  // counting the declaration made those indistinguishable.
  assert.deepEqual({
    outer: [outerContainer.relation, outerContainer.parent, outerContainer.via],
    inner: [innerContainer.relation, innerContainer.parent, innerContainer.via],
  }, {
    outer: ['contains', 'doc:doc.md', 'document'],
    inner: ['contains', outerId, 'section'],
  });
});

test('a drawn edge belongs to the fence it was read from, and the fence to its section', () => {
  const heading = section('doc.md', 1, 60, 'Architecture', 1);
  const fence = diagram('doc.md', 12, 'doc.md#12');
  const drawn = relation('doc.md', 14, 'doc.md#12');
  const facts = [heading, fence, drawn];
  const held = index(facts);
  const [headingId, fenceId, drawnId] = [...held.documents.keys()];
  assert.deepEqual({
    fence: Object.values(factContainer(fence, fenceId, held, () => true)),
    drawn: Object.values(factContainer(drawn, drawnId, held, () => true)),
  }, {
    fence: ['contains', headingId, 'section'],
    drawn: ['contains', fenceId, 'diagram'],
  });
});

test('a container that cannot be found is a recorded refusal, never a silent commit fallback', () => {
  const orphan = section('doc.md', 1, 10, 'Only', 1);
  const held = index([orphan]);
  const [orphanId] = [...held.documents.keys()];
  // The document carries no claims, so no Document node exists for it.
  assert.deepEqual(factContainer(orphan, orphanId, held, () => false), { refusal: 'document_absent' });

  const unaddressed = { kind: 'diagram_relation', repo: 'component-b', file: 'x.md', line: 2,
    diagram_address: 'x.md#1', from_identifier: 'A', to_identifier: 'B', arrow: '-->' };
  const multi = containmentIndex([unaddressed], { multi_repository: true });
  const [unaddressedId] = [...multi.documents.keys()];
  assert.deepEqual(factContainer(unaddressed, unaddressedId, multi, () => true),
    { refusal: 'document_path_unavailable' });

  const dangling = relation('doc.md', 5, 'doc.md#99');
  const danglingIndex = index([dangling]);
  const [danglingId] = [...danglingIndex.documents.keys()];
  assert.deepEqual(factContainer(dangling, danglingId, danglingIndex, () => true), { refusal: 'diagram_absent' });
});

test('a kind that declares the commit still reaches the commit', () => {
  const entry = { kind: 'catalog_entry', repo: 'app', file: 'checks.yaml', line: 3, entry_key_path: 'checks.build' };
  const held = index([entry]);
  const [entryId] = [...held.documents.keys()];
  assert.deepEqual(factContainer(entry, entryId, held, () => true),
    { relation: 'observed_in', parent: 'commit', via: 'commit' });
});

test('a document nobody claimed anything about still exists, and still holds its sections', async () => {
  const { buildUnifiedEstateProjection } = await import('../tools/estate-graph-projection.mjs');
  // Withholding a document from the paid read is meant to skip extracting claims from it, not to
  // erase it. Before this, a Document node was minted only from claims, so scope exclusions
  // deleted 1,313 sections' containers and the projection reported them as document_absent.
  const claim = {
    schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
    project: { id: 'fixture', sha: '1'.repeat(40) },
    claims: [], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [], coverage: {}, policy: {},
  };
  const file = 'design/withheld.md';
  const graph = {
    schema: 'estate-map/remap-code-graph/v1',
    provenance: { source_head: '1'.repeat(40) },
    counts: {}, identity_bindings: [], relations: [], nodes: {}, adj: {},
    extracted_facts: [
      { kind: 'document', repo: 'fixture', file, document_path: file, line: 1,
        line_count: 40, heading_count: 2, has_structure: true,
        document_mode: 'log', adjudication_frame: 'none', document_archived: false },
      { kind: 'document_section', repo: 'fixture', file, document_path: file, line: 1,
        line_end: 40, section_path: 'Notes', section_depth: 1 },
    ],
  };
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const document = state.nodes.find(row => row.node_id === `doc:${file}`);
  const section = state.nodes.find(row => row.kind === 'DocumentSection');
  const edge = state.edges.find(row => row.relation === 'contains' && row.to === section.node_id);
  assert.deepEqual({
    documentExists: Boolean(document),
    // The standing travels with it, which is the point of keeping it.
    mode: document?.properties.document_mode,
    frame: document?.properties.adjudication_frame,
    claimsExtracted: document?.properties.claims_extracted,
    sectionContainedBy: edge?.from,
    refused: state.counts.containment.refused,
  }, {
    documentExists: true,
    mode: 'log',
    frame: 'none',
    claimsExtracted: false,
    sectionContainedBy: `doc:${file}`,
    refused: {},
  });
});

test('the document address space is decided once from the graph, not guessed per fact', async () => {
  const { buildUnifiedEstateProjection } = await import('../tools/estate-graph-projection.mjs');
  // A repository materialized beneath an estate gives every fact two candidate addresses that
  // differ by the project directory. Choosing wrong mints a parallel set of Documents nothing
  // references: a first attempt produced 2,308 Documents for 1,154 files and reported zero
  // refusals, because the sections had attached to the orphans.
  const claim = {
    schema: 'estate-map/claim-evidence-map/v1', digest: 'c'.repeat(64),
    project: { id: 'fixture', sha: '1'.repeat(40) },
    claims: [], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [], coverage: {}, policy: {},
  };
  const graph = {
    schema: 'estate-map/remap-code-graph/v1',
    provenance: { source_head: '1'.repeat(40) },
    counts: {}, identity_bindings: [], relations: [], adj: {},
    // The code graph addresses documents repository-relative.
    nodes: { 'doc:design/A.md': { k: 'entity', l: 'design/A.md', ns: 'document', r: 'document' } },
    extracted_facts: [
      // The facts carry BOTH forms; document_path is estate-relative.
      { kind: 'document', repo: 'fixture', file: 'design/A.md', document_path: 'fixture/design/A.md',
        line: 1, line_count: 10, heading_count: 1, has_structure: true },
      { kind: 'document_section', repo: 'fixture', file: 'design/A.md',
        document_path: 'fixture/design/A.md', line: 1, line_end: 10,
        section_path: 'A', section_depth: 1 },
    ],
  };
  const state = buildUnifiedEstateProjection({ claim_map: claim, code_graph: graph });
  const documents = state.nodes.filter(row => row.kind === 'Document').map(row => row.node_id);
  const section = state.nodes.find(row => row.kind === 'DocumentSection');
  const edge = state.edges.find(row => row.relation === 'contains' && row.to === section.node_id);
  assert.deepEqual({
    documents,
    form: state.counts.containment.document_address_form,
    minted: state.counts.containment.documents_from_structure,
    sectionContainedBy: edge?.from,
    refused: state.counts.containment.refused,
  }, {
    // One Document, at the address the code graph already used -- not two.
    documents: ['doc:design/A.md'],
    form: 'repository',
    minted: 0,
    sectionContainedBy: 'doc:design/A.md',
    refused: {},
  });
});
