#!/usr/bin/env node
// Deterministic provenance projection for documentary claims.
//
// v2 separates claim-specific SubjectMention occurrences from shared Concept nodes. Mentions own
// exact source anchors; concepts never do. Legacy coordinate claims are preserved through synthetic
// mentions and explicit lineage findings instead of being silently repaired.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { segmentCorpus } from './wide-context-windows.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { markupNormalized } from './claim-v32.mjs';
import { renderContextMapHtml } from './context-map-artifacts.mjs';

const execFileAsync = promisify(execFile);
const canonical = value => stableStringify(value).trim();
const ordered = values => values.slice().sort((a, b) => a.id.localeCompare(b.id));
const normalizedSurface = value => String(value ?? '').trim().toLocaleLowerCase();

export const CLAIM_SOURCE_GRAPH_SCHEMA = 'estate-map/claim-source-graph/v2';

export class ClaimSourceGraphError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimSourceGraphError';
    this.code = code;
    this.detail = detail;
  }
}

const documentId = (file, snapshot) => `document:${sha256(canonical({ file, snapshot }))}`;
const evidenceSpanId = (span, snapshot) => `evidence-span:${sha256(canonical({
  file: span.file,
  start: span.start,
  end: span.end,
  byte_start: span.byte_start ?? null,
  byte_end: span.byte_end ?? null,
  text_digest: span.text_digest ?? null,
  snapshot,
}))}`;
const subjectMentionId = (claimId, subject) => `subject-mention:${sha256(canonical({
  claim_id: claimId,
  surface: normalizedSurface(subject.surface),
  span: subject.span || null,
  locator_id: subject.source_locator?.id || null,
}))}`;
const conceptId = canonicalRef => `concept:${sha256(canonical({ canonical_ref: canonicalRef }))}`;
const candidateId = surface => `concept-candidate:${sha256(canonical({ kind: 'same_surface', surface }))}`;
const supportSetId = (claimId, set, index) => `support-set:${sha256(canonical({
  claim_id: claimId,
  index,
  mode: set.mode,
  locators: (set.locators || []).map(locator => ({ role: locator.role, id: locator.id })),
  spans: set.spans || [],
}))}`;
const edgeId = body => `lineage-edge:${sha256(canonical(body))}`;

const inspectLineSpan = (documents, span) => {
  const document = documents.get(span.file);
  if (!document) throw new ClaimSourceGraphError('UNKNOWN_DOCUMENT', `span cites unknown document ${span.file}`, { span });
  const lines = document.content.split('\n');
  const valid = Number.isInteger(span.start) && Number.isInteger(span.end)
    && span.start >= 1 && span.end >= span.start && span.end <= lines.length;
  return valid
    ? { valid: true, text: lines.slice(span.start - 1, span.end).join('\n'), line_count: lines.length }
    : { valid: false, text: null, line_count: lines.length };
};

const inspectExactLocator = (documents, locator) => {
  const document = documents.get(locator.file);
  if (!document) throw new ClaimSourceGraphError('UNKNOWN_DOCUMENT', `locator cites unknown document ${locator.file}`, { locator });
  const line = inspectLineSpan(documents, locator);
  const source = Buffer.from(document.content, 'utf8');
  const byteValid = Number.isInteger(locator.byte_start) && Number.isInteger(locator.byte_end)
    && locator.byte_start >= 0 && locator.byte_end >= locator.byte_start && locator.byte_end <= source.length;
  const exact = byteValid ? source.subarray(locator.byte_start, locator.byte_end).toString('utf8') : null;
  const digestValid = exact !== null && locator.text_digest === sha256(exact);
  const textValid = exact !== null && exact === locator.text;
  return {
    valid: line.valid && byteValid && digestValid && textValid,
    text: exact,
    line_count: line.line_count,
    byte_valid: byteValid,
    digest_valid: digestValid,
    text_valid: textValid,
  };
};

const spanInside = (span, windows, role) => windows.filter(window => {
  const allowed = role === 'primary' ? window.primary_spans : window.context_spans;
  return (allowed || []).some(bound => bound.file === span.file && span.start >= bound.start && span.end <= bound.end);
});

const claimProvenance = claim => {
  const rows = Array.isArray(claim.extraction_provenance) && claim.extraction_provenance.length
    ? claim.extraction_provenance
    : [claim.extraction || {}];
  return [...new Map(rows.filter(row => row?.unit_id).map(row => [row.unit_id, row])).values()]
    .sort((a, b) => a.unit_id.localeCompare(b.unit_id));
};

/** Reconstruct a legacy artifact's deterministic window catalog without inference. */
export function reconstructWindowCatalog({ extraction, documents }) {
  if (!extraction?.snapshot?.source_sha || !extraction?.snapshot?.corpus_digest) {
    throw new ClaimSourceGraphError('INVALID_EXTRACTION_SNAPSHOT', 'extraction requires source_sha and corpus_digest');
  }
  if (!Array.isArray(documents) || !documents.length) {
    throw new ClaimSourceGraphError('MISSING_DOCUMENTS', 'window reconstruction requires source documents');
  }
  const corpusDigest = sha256(canonical(documents.map(document => ({ path: document.path, digest: sha256(document.content) }))));
  if (corpusDigest !== extraction.snapshot.corpus_digest) {
    throw new ClaimSourceGraphError('CORPUS_DIGEST_MISMATCH', 'source documents do not match extraction corpus', {
      expected: extraction.snapshot.corpus_digest, actual: corpusDigest,
    });
  }
  const segmented = segmentCorpus({
    documents,
    snapshot: extraction.snapshot,
    window_bytes: extraction.bounds?.window_bytes,
    overlap_bytes: extraction.bounds?.overlap_bytes ?? null,
  });
  for (const field of ['documents', 'windows', 'whole_document_windows', 'primary_bytes']) {
    if (Number(extraction.segmentation?.[field]) !== Number(segmented.totals[field])) {
      throw new ClaimSourceGraphError('SEGMENTATION_MISMATCH', `segmentation total ${field} does not match`, {
        field, expected: extraction.segmentation?.[field], actual: segmented.totals[field],
      });
    }
  }
  if (Array.isArray(extraction.window_catalog)) {
    const embedded = extraction.window_catalog.map(window => window.id).sort();
    const rebuilt = segmented.windows.map(window => window.id).sort();
    if (canonical(embedded) !== canonical(rebuilt)) {
      throw new ClaimSourceGraphError('WINDOW_CATALOG_MISMATCH', 'embedded and reconstructed window ids differ');
    }
  }
  return segmented.windows;
}

/** Build the full provenance graph. No claims or windows are sampled or omitted. */
export function buildClaimSourceGraph({ extraction, windows, documents }) {
  if (!extraction || !Array.isArray(extraction.claims)) throw new ClaimSourceGraphError('INVALID_EXTRACTION', 'extraction requires claims[]');
  if (!Array.isArray(windows) || !windows.length) throw new ClaimSourceGraphError('MISSING_WINDOWS', 'projection requires a window catalog');
  if (!Array.isArray(documents) || !documents.length) throw new ClaimSourceGraphError('MISSING_DOCUMENTS', 'projection requires source documents');

  const snapshot = extraction.snapshot;
  const documentMap = new Map(documents.map(document => [document.path, document]));
  const windowMap = new Map(windows.map(window => [window.id, window]));
  if (windowMap.size !== windows.length) throw new ClaimSourceGraphError('DUPLICATE_WINDOW', 'window ids must be unique');

  const nodes = new Map(), edges = new Map(), findings = [];
  const findingIdsByClaim = new Map(), mentionRows = [], claimDocuments = new Map();
  let supportSetCount = 0;
  const addNode = node => {
    const prior = nodes.get(node.id);
    if (prior && canonical(prior) !== canonical(node)) throw new ClaimSourceGraphError('NODE_ID_COLLISION', `node ${node.id} has conflicting bodies`);
    if (!prior) nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = body => {
    const edge = { ...body, id: edgeId(body) };
    edges.set(edge.id, edge);
    return edge.id;
  };
  const addFinding = (claimId, code, detail = {}) => {
    const body = { claim_id: claimId, code, detail };
    const finding = { ...body, id: `lineage-finding:${sha256(canonical(body))}` };
    if (!findings.some(item => item.id === finding.id)) findings.push(finding);
    const ids = findingIdsByClaim.get(claimId) || [];
    if (!ids.includes(finding.id)) ids.push(finding.id);
    findingIdsByClaim.set(claimId, ids);
    return finding.id;
  };

  const files = [...new Set(windows.flatMap(window => [
    ...(window.primary_spans || []).map(span => span.file),
    ...(window.context_spans || []).map(span => span.file),
  ]))].sort();
  for (const file of files) {
    const document = documentMap.get(file);
    if (!document) throw new ClaimSourceGraphError('UNKNOWN_DOCUMENT', `window cites unknown document ${file}`);
    addNode({
      id: documentId(file, snapshot), kind: 'source_document', authority_plane: 'source',
      path: file, source_digest: sha256(document.content), source_sha: snapshot.source_sha,
      corpus_digest: snapshot.corpus_digest,
    });
  }

  for (const window of windows.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const windowFiles = [...new Set([...(window.primary_spans || []), ...(window.context_spans || [])].map(span => span.file))].sort();
    addNode({
      id: window.id, kind: 'extraction_window', authority_plane: 'custody', window_kind: window.kind,
      files: windowFiles, primary_spans: window.primary_spans, context_spans: window.context_spans,
      heading_ancestry: window.heading_ancestry || [], primary_bytes: window.primary_bytes,
      block_count: window.block_count, snapshot: window.snapshot,
    });
    for (const file of windowFiles) addEdge({
      kind: 'window_in_document', from: window.id, to: documentId(file, snapshot),
      roles: [
        ...((window.primary_spans || []).some(span => span.file === file) ? ['primary'] : []),
        ...((window.context_spans || []).some(span => span.file === file) ? ['context'] : []),
      ],
    });
  }

  for (const claim of extraction.claims.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const semantic = claim.semantic || {}, subject = semantic.subject || {};
    const exactLocatorClaim = ['estate-map/documentary-claim/v3.2', 'estate-map/documentary-claim/v3.3']
      .includes(claim.schema);
    const provenances = claimProvenance(claim);
    if (!provenances.length) throw new ClaimSourceGraphError('CLAIM_WITHOUT_WINDOW', `claim ${claim.id} has no extraction unit`);
    const provenanceWindows = provenances.map(row => {
      const window = windowMap.get(row.unit_id);
      if (!window) throw new ClaimSourceGraphError('UNKNOWN_CLAIM_WINDOW', `claim ${claim.id} cites missing window ${row.unit_id}`);
      return window;
    });

    const mentionId = subjectMentionId(claim.id, subject);
    addNode({
      id: mentionId,
      kind: 'subject_mention',
      authority_plane: 'documentary_claim',
      claim_id: claim.id,
      surface: subject.surface || null,
      normalized_surface: normalizedSurface(subject.surface) || null,
      literal_surface: subject.literal_surface || subject.surface || null,
      subject_binding: subject.binding?.kind || 'explicit',
      source_mention_key: subject.source_mention_key || subject.mention_id || null,
      synthetic_legacy: !exactLocatorClaim,
    });
    addNode({
      id: claim.id, kind: 'documentary_claim', authority_plane: 'documentary_claim', schema: claim.schema,
      proposition_key: claim.proposition_key, evidence_key: claim.evidence_key, subject_mention_id: mentionId,
      subject: {
        surface: subject.surface || null, literal_surface: subject.literal_surface || subject.surface || null,
        binding: subject.binding || { kind: 'explicit' }, span: subject.span || null,
        canonical_ref: subject.canonical_ref || null, resolution_status: subject.resolution_status || 'unresolved',
      },
      relation_family: semantic.relation_family || 'other',
      predicate_family: semantic.predicate_family, object_or_value: semantic.object_or_value,
      polarity: semantic.polarity, modality: semantic.modality, quantifier: semantic.quantifier,
      scope: semantic.scope, valid_time: semantic.valid_time,
      irreducible_multi_span: Boolean(semantic.irreducible_multi_span),
    });
    addEdge({ kind: 'claim_has_subject_mention', from: claim.id, to: mentionId });
    for (const window of provenanceWindows) addEdge({ kind: 'claim_extracted_from_window', from: claim.id, to: window.id });

    if (!exactLocatorClaim) addFinding(claim.id, 'LEGACY_COORDINATE_LOCATOR', { schema: claim.schema, treatment: 'synthetic_subject_mention_no_coordinate_repair' });
    if (subject.span?.file) {
      const locator = exactLocatorClaim ? subject.source_locator : null;
      const span = locator ? {
        file: locator.file, start: locator.start, end: locator.end,
        byte_start: locator.byte_start, byte_end: locator.byte_end, text_digest: locator.text_digest,
      } : { file: subject.span.file, start: Number(subject.span.start), end: Number(subject.span.end) };
      const inspected = locator ? inspectExactLocator(documentMap, locator) : inspectLineSpan(documentMap, span);
      const id = evidenceSpanId(span, snapshot);
      addNode({
        id, kind: inspected.valid ? 'evidence_span' : 'invalid_source_span',
        authority_plane: inspected.valid ? 'source' : 'documentary_claim', ...span,
        text: inspected.text, text_digest: inspected.valid ? sha256(inspected.text) : null,
      });
      const anchoredSurface = subject.literal_surface || subject.surface;
      const surfacePresent = inspected.valid && anchoredSurface
        ? markupNormalized(inspected.text).includes(markupNormalized(anchoredSurface))
        : false;
      if (!inspected.valid) addFinding(claim.id, 'INVALID_SUBJECT_LOCATOR', { span, exact_locator: Boolean(locator) });
      else if (!subject.surface) addFinding(claim.id, 'MISSING_SUBJECT_SURFACE', { span });
      else if (!surfacePresent) addFinding(claim.id, 'SUBJECT_SURFACE_NOT_IN_SPAN', { span, surface: subject.surface });
      addEdge({ kind: 'mention_anchored_by_span', from: mentionId, to: id, valid: surfacePresent && exactLocatorClaim });
      addEdge({ kind: 'span_in_document', from: id, to: documentId(span.file, snapshot) });
      addEdge({ kind: 'mention_in_document', from: mentionId, to: documentId(span.file, snapshot) });
      mentionRows.push({ mention_id: mentionId, claim_id: claim.id, file: subject.identity_file || span.file,
        surface: normalizedSurface(subject.identity_surface || subject.surface), canonical_ref: subject.canonical_ref || null });
    } else {
      addFinding(claim.id, 'MISSING_SUBJECT_LOCATOR', {});
    }

    if (subject.canonical_ref) {
      const id = conceptId(subject.canonical_ref);
      addNode({ id, kind: 'concept', authority_plane: 'documentary_identity', canonical_ref: subject.canonical_ref });
      addEdge({ kind: 'mention_resolves_to_concept', from: mentionId, to: id, basis: subject.canonical_basis || 'legacy_source_established_canonical_ref' });
    }

    const docsForClaim = new Set(), groundedDocsForClaim = new Set();
    for (const [setIndex, set] of (semantic.support_sets || []).entries()) {
      const setId = supportSetId(claim.id, set, setIndex);
      supportSetCount += 1;
      addNode({ id: setId, kind: 'support_set', authority_plane: 'documentary_claim', mode: set.mode, claim_id: claim.id, position: setIndex });
      addEdge({ kind: 'claim_has_support_set', from: claim.id, to: setId, mode: set.mode, position: setIndex });
      const items = exactLocatorClaim && Array.isArray(set.locators)
        ? set.locators.map(locator => ({ role: locator.role, locator }))
        : (set.spans || []).map(rawSpan => ({ role: rawSpan.role, span: rawSpan }));
      for (const item of items) {
        const role = item.role;
        const locator = item.locator || null;
        const rawSpan = item.span || locator;
        const span = locator ? {
          file: locator.file, start: Number(locator.start), end: Number(locator.end),
          byte_start: locator.byte_start, byte_end: locator.byte_end, text_digest: locator.text_digest,
        } : { file: rawSpan.file, start: Number(rawSpan.start), end: Number(rawSpan.end) };
        const inspected = locator ? inspectExactLocator(documentMap, locator) : inspectLineSpan(documentMap, span);
        const coordinateExcerpts = (set.excerpts || []).filter(excerpt => excerpt.role === role
          && excerpt.file === span.file && Number(excerpt.start) === span.start && Number(excerpt.end) === span.end);
        // Several exact locators may occupy different byte slices on the same source line. Line
        // coordinates alone cannot identify the corresponding excerpt; use the locator's immutable
        // exact text/digest when available. Legacy line-span claims retain coordinate-only behavior.
        const recorded = locator
          ? coordinateExcerpts.find(excerpt => excerpt.text === locator.text
            && (!excerpt.text_digest || excerpt.text_digest === locator.text_digest))
          : coordinateExcerpts[0];
        const excerptMatches = inspected.valid && Boolean(recorded) && recorded.text === inspected.text;
        if (!inspected.valid) addFinding(claim.id, 'INVALID_EVIDENCE_LOCATOR', { span, role, exact_locator: Boolean(locator) });
        else if (!excerptMatches) addFinding(claim.id, 'EXCERPT_SOURCE_MISMATCH', {
          span, role,
          recorded_text_digest: recorded?.text ? sha256(recorded.text) : null,
          source_text_digest: sha256(inspected.text),
        });
        const matchingWindows = inspected.valid ? spanInside(span, provenanceWindows, role) : [];
        if (inspected.valid && !matchingWindows.length) addFinding(claim.id, 'SPAN_OUTSIDE_CLAIM_WINDOWS', { span, role });
        const valid = exactLocatorClaim && inspected.valid && excerptMatches && matchingWindows.length > 0;
        const id = evidenceSpanId(span, snapshot);
        addNode({
          id, kind: inspected.valid ? 'evidence_span' : 'invalid_source_span',
          authority_plane: inspected.valid ? 'source' : 'documentary_claim', ...span,
          text: inspected.text, text_digest: inspected.valid ? sha256(inspected.text) : null,
        });
        addEdge({
          kind: set.mode === 'all_required' ? 'support_requires_span' : 'support_has_alternative_span',
          from: setId, to: id, evidence_role: role, valid,
        });
        addEdge({ kind: 'span_in_document', from: id, to: documentId(span.file, snapshot) });
        for (const window of matchingWindows) addEdge({
          kind: role === 'primary' ? 'span_presented_as_primary' : 'span_presented_as_context',
          from: id, to: window.id,
        });
        docsForClaim.add(span.file);
        if (valid) groundedDocsForClaim.add(span.file);
      }
    }
    if (!docsForClaim.size) throw new ClaimSourceGraphError('CLAIM_WITHOUT_EVIDENCE', `claim ${claim.id} has no evidence spans`);
    for (const file of [...docsForClaim].sort()) addEdge({ kind: 'claim_cites_document', from: claim.id, to: documentId(file, snapshot) });
    for (const file of [...groundedDocsForClaim].sort()) addEdge({ kind: 'claim_grounded_in_document', from: claim.id, to: documentId(file, snapshot), valid: true });
    claimDocuments.set(claim.id, docsForClaim);

    const prefix = claim.schema === 'estate-map/documentary-claim/v3.3' ? 'claim-v33'
      : exactLocatorClaim ? 'claim-v32' : 'claim-v31';
    const expectedReducedId = `${prefix}:${sha256(canonical({
      proposition_key: claim.proposition_key,
      evidence_key: claim.evidence_key,
      ...(claim.schema === 'estate-map/documentary-claim/v3.3'
        ? { repair_findings: claim.repair_findings || [] } : {}),
    }))}`;
    if (claim.id !== expectedReducedId) addFinding(claim.id, 'REDUCED_ID_MISMATCH', { expected_id: expectedReducedId });
    const hasCrossDocumentWindow = provenanceWindows.some(window =>
      new Set([...(window.primary_spans || []), ...(window.context_spans || [])].map(span => span.file)).size > 1);
    if (docsForClaim.size > 1 && !hasCrossDocumentWindow && !subject.canonical_ref) addFinding(claim.id, 'NONCANONICAL_CROSS_DOCUMENT_REDUCTION', {
      documents: [...docsForClaim].sort(), windows: provenanceWindows.map(window => window.id).sort(),
    });
  }

  // Lexical equality proposes a candidate cluster only. It never establishes identity or grounding.
  const bySurface = new Map();
  for (const row of mentionRows.filter(row => row.surface)) {
    const group = bySurface.get(row.surface) || [];
    group.push(row);
    bySurface.set(row.surface, group);
  }
  for (const [surface, allRows] of [...bySurface.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = allRows.filter(row => !row.canonical_ref);
    const filesForSurface = new Set(rows.map(row => row.file));
    if (rows.length < 2 || filesForSurface.size < 2) continue;
    const id = candidateId(surface);
    addNode({ id, kind: 'concept_candidate', authority_plane: 'deterministic_structure', candidate_kind: 'same_surface', surface });
    for (const row of rows.slice().sort((a, b) => a.mention_id.localeCompare(b.mention_id))) {
      addEdge({ kind: 'same_surface_candidate', from: row.mention_id, to: id, basis: 'exact_normalized_surface' });
    }
  }

  // Findings determine claim lineage only after candidate construction; candidate edges never heal it.
  for (const claim of extraction.claims) {
    const ids = (findingIdsByClaim.get(claim.id) || []).slice().sort();
    nodes.set(claim.id, { ...nodes.get(claim.id), lineage_status: ids.length ? 'invalid' : 'valid', lineage_finding_ids: ids });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const nodeList = ordered([...nodes.values()]), edgeList = ordered([...edges.values()]);
  const claimsByDocumentCount = new Map(files.map(file => [file, 0]));
  for (const docs of claimDocuments.values()) for (const file of docs) claimsByDocumentCount.set(file, (claimsByDocumentCount.get(file) || 0) + 1);
  const windowsWithClaims = new Set(edgeList.filter(edge => edge.kind === 'claim_extracted_from_window').map(edge => edge.to));
  const crossDocumentClaims = [...claimDocuments.entries()].filter(([, set]) => set.size > 1);
  const crossDocumentExtractionClaims = crossDocumentClaims.filter(([claimId]) => {
    const units = edgeList.filter(edge => edge.kind === 'claim_extracted_from_window' && edge.from === claimId).map(edge => windowMap.get(edge.to));
    return units.some(window => new Set([...(window?.primary_spans || []), ...(window?.context_spans || [])].map(span => span.file)).size > 1);
  }).length;
  const metrics = {
    documents: nodeList.filter(node => node.kind === 'source_document').length,
    windows: nodeList.filter(node => node.kind === 'extraction_window').length,
    claims: nodeList.filter(node => node.kind === 'documentary_claim').length,
    subject_mentions: nodeList.filter(node => node.kind === 'subject_mention').length,
    subjects: nodeList.filter(node => node.kind === 'subject_mention').length,
    concepts: nodeList.filter(node => node.kind === 'concept').length,
    concept_candidates: nodeList.filter(node => node.kind === 'concept_candidate').length,
    support_sets: supportSetCount,
    evidence_spans: nodeList.filter(node => node.kind === 'evidence_span').length,
    invalid_source_spans: nodeList.filter(node => node.kind === 'invalid_source_span').length,
    edges: edgeList.length,
    windows_without_claims: windows.length - windowsWithClaims.size,
    documents_without_claims: [...claimsByDocumentCount.values()].filter(count => count === 0).length,
    cross_document_claims: crossDocumentClaims.length,
    cross_document_extraction_claims: crossDocumentExtractionClaims,
    cross_document_reduced_propositions: crossDocumentClaims.length - crossDocumentExtractionClaims,
    lineage_findings: findings.length,
    claims_with_lineage_findings: findingIdsByClaim.size,
    projection_complete: true,
    lineage_complete: findings.length === 0,
  };
  const body = {
    schema: CLAIM_SOURCE_GRAPH_SCHEMA,
    source_artifact: { schema: extraction.schema, digest: extraction.digest || null, status: extraction.status || null },
    snapshot,
    authority_boundary: 'documentary claims remain separate from deterministic observations',
    full_graph: true,
    metrics,
    findings,
    nodes: nodeList,
    edges: edgeList,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

async function main() {
  const args = process.argv.slice(2), positional = [], options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) options[args[index].slice(2)] = args[++index];
    else positional.push(args[index]);
  }
  const [artifactPath] = positional;
  if (!artifactPath || !options.estate || !options.manifest || !options.output) {
    throw new Error('usage: wide-context-claim-graph.mjs <extraction.json> --estate <root> --manifest <json> --output <json> [--html <html>]');
  }
  const extraction = JSON.parse(await fs.readFile(path.resolve(artifactPath), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8'));
  const estate = await fs.realpath(path.resolve(options.estate));
  const sourceSha = (await execFileAsync('git', ['-C', estate, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sourceSha !== extraction.snapshot?.source_sha) throw new ClaimSourceGraphError('SOURCE_SHA_MISMATCH', `estate ${sourceSha} != extraction ${extraction.snapshot?.source_sha}`);
  if (manifest.source_sha && manifest.source_sha !== sourceSha) throw new ClaimSourceGraphError('MANIFEST_SHA_MISMATCH', `manifest ${manifest.source_sha} != estate ${sourceSha}`);
  const documents = [];
  for (const spec of manifest.documents || []) documents.push({ path: spec.path, content: await fs.readFile(path.join(estate, spec.path), 'utf8') });
  const windows = reconstructWindowCatalog({ extraction, documents });
  const graph = buildClaimSourceGraph({ extraction, windows, documents });
  const output = path.resolve(options.output);
  const relativeToEstate = path.relative(estate, output);
  if (relativeToEstate === '' || (!relativeToEstate.startsWith('..') && !path.isAbsolute(relativeToEstate))) {
    throw new ClaimSourceGraphError('READ_ONLY_ESTATE', 'graph output must be outside the estate checkout', { output });
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  let html = null;
  if (options.html) {
    html = path.resolve(options.html);
    const htmlRelativeToEstate = path.relative(estate, html);
    if (htmlRelativeToEstate === '' || (!htmlRelativeToEstate.startsWith('..') && !path.isAbsolute(htmlRelativeToEstate))) {
      throw new ClaimSourceGraphError('READ_ONLY_ESTATE', 'graph HTML output must be outside the estate checkout', { output: html });
    }
    await fs.mkdir(path.dirname(html), { recursive: true });
    const htmlTemporary = `${html}.${process.pid}.tmp`;
    await fs.writeFile(htmlTemporary, renderContextMapHtml(graph), 'utf8');
    await fs.rename(htmlTemporary, html);
  }
  console.log(JSON.stringify({ output, html, digest: graph.digest, metrics: graph.metrics }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
}
