import { serializeFlatRelationAnswer } from '../tools/flat-relation-lines.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runWideContextExtraction } from '../tools/wide-context-extractor.mjs';
import { buildClaimSourceGraph, reconstructWindowCatalog } from '../tools/wide-context-claim-graph.mjs';
import { renderContextMapHtml } from '../tools/context-map-artifacts.mjs';
import { stableStringify } from '../tools/lib.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: null };
const documents = [
  { path: 'a.md', content: '# A\n\nA case records an attempt.\n' },
  { path: 'b.md', content: '# B\n\nA case closes an attempt.\n' },
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// Reproduce the extractor's exact corpus binding in the fixture.
snapshot.corpus_digest = sha256(stableStringify(documents.map(document => ({ path: document.path, digest: sha256(document.content) }))).trim());

const bounds = {
  window_bytes: 48 * 1024, max_claims_per_unit: 8,
  max_calls: 10, max_known_cost_usd: 1, max_unpriced_attempts: 1,
  call_timeout_ms: 600000, max_answer_bytes: 1048576, max_event_bytes: 67108864,
};

const runnerFactory = () => ({
  kind: 'fake', model: 'fake/lineage', calls: 0,
  async complete({ prompt }) {
    this.calls += 1;
    const match = /\[(b\d{3}) PRIMARY ([^:]+):(\d+)-(\d+)\]/.exec(prompt);
    const file = match[2];
    const occurrence = prompt.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(row => row?.subject_occurrence);
    const surface = occurrence.surface;
    const source_locator = { block_token: occurrence.block, quote: surface, occurrence: occurrence.occurrence };
    const claims = [{
      subject_mention: { surface, source_locator },
      subject_binding: 'explicit', subject_occurrence: occurrence.subject_occurrence,
      relation_family: 'other',
      predicate_family: 'participates_in', object_or_value: 'an attempt',
      polarity: 'affirmed', modality: 'descriptive', quantifier: 'one', scope: {}, valid_time: {},
      support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator }] }],
    }];
    return {
      text: serializeFlatRelationAnswer({ claims }), json: null, outcome: 'ok', accepted: true,
      billing_status: 'reported', usage: { cost: 0.01, cost_reported: true }, model: this.model,
    };
  },
  stats() {
    return { kind: 'fake', calls: this.calls, cost: this.calls * 0.01, cost_status: 'complete', unpriced_attempts: 0, models: [this.model], per_call: [] };
  },
});

async function extract(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-graph-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return runWideContextExtraction({
    documents, snapshot, bounds, model: 'fake/lineage', concurrency: 2,
    checkpointPath: path.join(dir, 'checkpoint.jsonl'), runnerFactory,
  });
}

const edgeFrom = (graph, kind, from) => graph.edges.filter(edge => edge.kind === kind && edge.from === from);

test('projection makes document -> window -> claim -> support -> span lineage explicit', async t => {
  const extraction = await extract(t);
  const graph = buildClaimSourceGraph({ extraction, windows: extraction.window_catalog, documents });
  assert.equal(graph.metrics.documents, 2);
  assert.equal(graph.metrics.windows, 2);
  assert.equal(graph.metrics.claims, 2);
  assert.equal(graph.metrics.lineage_complete, true);
  assert.equal(graph.metrics.cross_document_claims, 0);

  for (const claim of graph.nodes.filter(node => node.kind === 'documentary_claim')) {
    const windowEdges = edgeFrom(graph, 'claim_extracted_from_window', claim.id);
    const mentionEdges = edgeFrom(graph, 'claim_has_subject_mention', claim.id);
    const supportEdges = edgeFrom(graph, 'claim_has_support_set', claim.id);
    const citedDocumentEdges = edgeFrom(graph, 'claim_cites_document', claim.id);
    const groundedDocumentEdges = edgeFrom(graph, 'claim_grounded_in_document', claim.id);
    assert.equal(windowEdges.length, 1, 'claim points to its exact extraction window');
    assert.equal(mentionEdges.length, 1, 'claim owns exactly one mention occurrence');
    assert.equal(edgeFrom(graph, 'mention_anchored_by_span', mentionEdges[0].to).length, 1, 'mention—not concept—owns its exact anchor');
    assert.equal(supportEdges.length, 1, 'claim points to a typed support set');
    assert.equal(citedDocumentEdges.length, 1, 'claim has a direct source-document citation edge');
    assert.equal(groundedDocumentEdges.length, 1, 'valid evidence earns a distinct grounded edge');
    const evidenceEdges = edgeFrom(graph, 'support_requires_span', supportEdges[0].to);
    assert.equal(evidenceEdges.length, 1);
    assert.equal(edgeFrom(graph, 'span_in_document', evidenceEdges[0].to).length, 1, 'exact evidence span points to source document');
  }
  assert.equal(graph.nodes.filter(node => node.kind === 'subject_mention').length, 2);
  assert.equal(graph.edges.filter(edge => edge.kind === 'subject_anchored_by_span').length, 0, 'legacy shared-subject anchor edge is gone');
});

test('legacy artifacts reconstruct the identical window catalog without inference', async t => {
  const extraction = await extract(t);
  const legacy = { ...extraction };
  delete legacy.window_catalog;
  const rebuilt = reconstructWindowCatalog({ extraction: legacy, documents });
  assert.deepEqual(rebuilt.map(window => window.id), extraction.window_catalog.map(window => window.id));
});

test('projection shares the validator markup normalization and renders as self-contained HTML', async t => {
  const extraction = await extract(t);
  const marked = structuredClone(extraction);
  marked.claims[0].semantic.subject.surface = `\`${marked.claims[0].semantic.subject.surface}\``;
  const graph = buildClaimSourceGraph({ extraction: marked, windows: marked.window_catalog, documents });
  assert.ok(!graph.findings.some(finding => finding.code === 'SUBJECT_SURFACE_NOT_IN_SPAN'));
  const html = renderContextMapHtml(graph);
  assert.match(html, /Claim \/ Source Graph/);
  assert.match(html, /id="graph-data"/);
  assert.doesNotMatch(html, /<script\s+src=/i);
});

test('exact excerpts on the same line are matched by byte-exact locator identity', async t => {
  const extraction = await extract(t);
  const sameLine = structuredClone(extraction);
  const claim = sameLine.claims.find(row => row.semantic.subject.source_locator.file === 'a.md');
  const set = claim.semantic.support_sets[0];
  const original = set.locators[0];
  const text = 'A case records an attempt.';
  const byteStart = Buffer.byteLength(documents[0].content.slice(0, documents[0].content.indexOf(text)), 'utf8');
  const expanded = {
    ...original,
    id: `locator:${sha256(text)}`,
    byte_start: byteStart,
    byte_end: byteStart + Buffer.byteLength(text, 'utf8'),
    text,
    text_digest: sha256(text),
  };
  set.locators = [original, expanded];
  set.spans = set.locators.map(locator => ({
    role: locator.role, file: locator.file, start: locator.start, end: locator.end,
    byte_start: locator.byte_start, byte_end: locator.byte_end, text_digest: locator.text_digest,
  }));
  // Deliberately put the expanded excerpt first: a coordinate-only lookup would assign it to the
  // shorter original locator and incorrectly report a source mismatch.
  set.excerpts = [expanded, original].map(locator => ({
    role: locator.role, file: locator.file, start: locator.start, end: locator.end,
    byte_start: locator.byte_start, byte_end: locator.byte_end,
    text: locator.text, text_digest: locator.text_digest,
  }));
  const graph = buildClaimSourceGraph({ extraction: sameLine, windows: sameLine.window_catalog, documents });
  assert.ok(!graph.findings.some(finding => finding.claim_id === claim.id
    && finding.code === 'EXCERPT_SOURCE_MISMATCH'));
});

test('same surface is a candidate—not identity—while source-established canonical refs share a concept without sharing anchors', async t => {
  const makeRunner = canonicalRef => () => ({
    kind: 'fake', model: 'fake/shared-surface', calls: 0,
    async complete({ prompt }) {
      this.calls += 1;
      const blocks = [...prompt.matchAll(/\[(b\d{3}) PRIMARY ([^:]+):\d+-\d+\]\n([\s\S]*?)(?=\n\n\[b\d{3}|$)/g)];
      const block = blocks.find(match => match[3].includes('A case'));
      const source_locator = { block_token: block[1], quote: 'A case', occurrence: 1 };
      const claims = [{
        subject_mention: { surface: 'A case', source_locator },
        subject_binding: 'implicit_topic', relation_family: 'other',
        ...(canonicalRef ? { canonical_ref: canonicalRef } : {}),
        predicate_family: 'participates_in', object_or_value: block[2] === 'a.md' ? 'records an attempt' : 'closes an attempt', polarity: 'affirmed',
        modality: 'descriptive', quantifier: 'one', scope: {}, valid_time: {},
        support_sets: [{ mode: 'all_required', locators: [{ role: 'primary', source_locator }] }],
      }];
      return { text: serializeFlatRelationAnswer({ claims }), json: null, outcome: 'ok', accepted: true,
        billing_status: 'reported', usage: { cost: 0.01, cost_reported: true }, model: this.model };
    },
    stats() { return { kind: 'fake', calls: this.calls, cost: this.calls * 0.01, cost_status: 'complete', unpriced_attempts: 0, models: [this.model], per_call: [] }; },
  });
  const run = async (name, canonicalRef) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `claim-graph-${name}-`));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return runWideContextExtraction({ documents, snapshot, bounds, model: 'fake/shared-surface', concurrency: 2,
      checkpointPath: path.join(dir, 'checkpoint.jsonl'), runnerFactory: makeRunner(canonicalRef) });
  };

  const local = await run('local', null);
  const localGraph = buildClaimSourceGraph({ extraction: local, windows: local.window_catalog, documents });
  assert.equal(localGraph.metrics.concepts, 0);
  assert.equal(localGraph.metrics.concept_candidates, 1);
  assert.equal(localGraph.edges.filter(edge => edge.kind === 'same_surface_candidate').length, 2);
  assert.equal(localGraph.edges.filter(edge => edge.kind === 'claim_grounded_in_document').length, 2,
    'each claim remains grounded only in its own support document');

  const canonicalExtraction = await run('canonical', 'concept:a-case');
  const canonicalGraph = buildClaimSourceGraph({ extraction: canonicalExtraction, windows: canonicalExtraction.window_catalog, documents });
  assert.equal(canonicalGraph.metrics.concepts, 1);
  assert.equal(canonicalGraph.metrics.concept_candidates, 0);
  assert.equal(canonicalGraph.edges.filter(edge => edge.kind === 'mention_resolves_to_concept').length, 2);
  const concept = canonicalGraph.nodes.find(node => node.kind === 'concept');
  assert.equal(canonicalGraph.edges.filter(edge => edge.from === concept.id && /span|document/.test(edge.kind)).length, 0,
    'shared concept owns no claim-specific anchor or document edge');
});

test('legacy claims project through synthetic mentions and remain visibly lineage-invalid', async t => {
  const extraction = await extract(t);
  const legacy = structuredClone(extraction);
  const claim = legacy.claims[0];
  claim.schema = 'estate-map/documentary-claim/v3.1';
  delete claim.semantic.subject.source_locator;
  delete claim.semantic.subject.source_mention_key;
  for (const set of claim.semantic.support_sets) delete set.locators;
  const graph = buildClaimSourceGraph({ extraction: legacy, windows: legacy.window_catalog, documents });
  assert.ok(graph.findings.some(finding => finding.claim_id === claim.id && finding.code === 'LEGACY_COORDINATE_LOCATOR'));
  const mention = graph.nodes.find(node => node.kind === 'subject_mention' && node.claim_id === claim.id);
  assert.equal(mention.synthetic_legacy, true);
  assert.equal(graph.nodes.find(node => node.id === claim.id).lineage_status, 'invalid');
});

test('projection fails on missing lineage but preserves source-validation defects as findings', async t => {
  const extraction = await extract(t);
  const badWindow = structuredClone(extraction);
  badWindow.claims[0].extraction_provenance[0].unit_id = 'window:missing';
  assert.throws(
    () => buildClaimSourceGraph({ extraction: badWindow, windows: extraction.window_catalog, documents }),
    error => error.code === 'UNKNOWN_CLAIM_WINDOW',
  );

  const badExcerpt = structuredClone(extraction);
  badExcerpt.claims[0].semantic.support_sets[0].excerpts[0].text = 'not source text';
  const graph = buildClaimSourceGraph({ extraction: badExcerpt, windows: extraction.window_catalog, documents });
  assert.equal(graph.metrics.projection_complete, true, 'every claim remains represented');
  assert.equal(graph.metrics.lineage_complete, false, 'invalid source linkage is never labeled valid');
  assert.ok(graph.findings.some(finding => finding.code === 'EXCERPT_SOURCE_MISMATCH'));
  assert.equal(graph.nodes.find(node => node.id === badExcerpt.claims[0].id).lineage_status, 'invalid');

  const staleId = structuredClone(extraction);
  staleId.claims[0].id = 'claim-v31:stale-reduced-id';
  const staleGraph = buildClaimSourceGraph({ extraction: staleId, windows: extraction.window_catalog, documents });
  assert.ok(staleGraph.findings.some(finding => finding.code === 'REDUCED_ID_MISMATCH'));
});
