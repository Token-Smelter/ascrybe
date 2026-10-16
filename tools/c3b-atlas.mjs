#!/usr/bin/env node
// Static C3b atlas over one explicitly selected Neo4j serving projection.
import {
  mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient, parseNeo4jConnectionTarget } from './c3-serving-projection.mjs';
import { sha256, stableCanonicalSha256, stableStringify } from './lib.mjs';

export const C3B_ATLAS_SCHEMA = 'estate-map/c3b-atlas/v1';
export const C3B_ATLAS_VERSION = 'c3b-static-atlas@1';
export const ATLAS_ENTITY_LEDGER_PAGE_SIZE = 250;
export const ATLAS_STATEMENT_LEDGER_PAGE_SIZE = 100;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clean = value => String(value ?? '').trim();
const canonical = value => stableStringify(value).trim();
const forbiddenReferentField = /(?:^|_)(?:name|label|title|display|preferred)(?:_|$)/u;
const fail = (code, message, detail = {}) => {
  const error = new Error(message);
  error.name = 'C3bAtlasError';
  error.code = code;
  error.detail = detail;
  throw error;
};

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { fail('INVALID_ATLAS_GRAPH_JSON', `${label} is not valid projected JSON`); }
}

function unique(values) {
  return [...new Set(values)].sort();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function pageKey(prefix, value) {
  return `${prefix}-${sha256(value).slice(0, 16)}.html`;
}

function spanKey(span) {
  return canonical([span.document_path, span.line_start, span.line_end,
    span.byte_start, span.byte_end, span.evidence_digest]);
}

function exactSpans(spans) {
  return [...new Map((spans || []).map(span => [spanKey(span), span])).values()]
    .sort((left, right) => left.document_path.localeCompare(right.document_path)
      || left.byte_start - right.byte_start || left.byte_end - right.byte_end);
}

function selectedPredicate(node) {
  const value = parseJson(node.properties.value_json, `Predicate ${node.node_id}`);
  return value == null ? `[unresolved predicate ${node.node_id}]` : String(value);
}

function argumentText(argument, referentById, nodeById) {
  const endpoint = nodeById.get(argument.endpoint_id);
  if (endpoint?.kind === 'Referent') {
    const surfaces = referentById.get(endpoint.node_id)?.observed_surfaces || [];
    return surfaces.length
      ? `Observed surfaces: ${surfaces.map(surface => `“${surface}”`).join(' / ')}`
      : `Referent ${endpoint.node_id}`;
  }
  if (endpoint?.kind === 'Mention') return `Observed surface: “${endpoint.properties.surface}”`;
  if (endpoint?.kind === 'Literal') return canonical(parseJson(endpoint.properties.literal_json,
    `Literal ${endpoint.node_id}`));
  if (endpoint?.kind === 'Assertion') return `Assertion ${endpoint.node_id}`;
  return argument.endpoint_id;
}

function sourceSpanFromClaim(claim) {
  return exactSpans(parseJson(claim.properties.support_spans_json,
    `DocumentaryClaim ${claim.node_id} support spans`));
}

function structuredSourceFromEvidence(evidence) {
  if (evidence?.properties?.pointer_kind !== 'structured_record') return null;
  const record = parseJson(evidence.properties.record_value_json,
    `EvidencePointer ${evidence.node_id} structured record`);
  return {
    pointer_kind: 'structured_record',
    evidence_id: evidence.node_id,
    record_id: evidence.properties.record_id,
    schema_id: evidence.properties.record_schema_id,
    field_path: evidence.properties.record_field_path,
    record_digest: evidence.properties.evidence_digest,
    repository: record.repo ?? null,
    document_path: record.file ?? null,
    line_start: Number.isInteger(record.line) ? record.line : null,
    fact_kind: record.kind ?? null,
    exact_record: record,
  };
}

function buildGraphFacts(nodes, edges) {
  const mentionIds = nodes.filter(node => node.kind === 'Mention').map(node => node.node_id).sort();
  const resolutionEdges = edges.filter(edge => edge.type === 'RESOLVES_TO');
  const ambiguityReceiptIds = nodes.filter(node =>
    node.properties?.schema === 'estate-map/claim-projection-receipt/v1'
      && node.properties.disposition === 'unresolved_argument_mentions')
    .map(node => node.node_id).sort();
  return Object.freeze({
    referent_ids: nodes.filter(node => node.kind === 'Referent').map(node => node.node_id).sort(),
    mention_ids: mentionIds,
    resolved_mention_ids: unique(resolutionEdges.map(edge => edge.from)),
    resolution_edge_receipt_ids: resolutionEdges.map(edge => edge.properties.resolution_receipt_id).sort(),
    rel_count: edges.filter(edge => edge.type === 'REL').length,
    ambiguity_receipt_ids: ambiguityReceiptIds,
    assertion_ids: nodes.filter(node => node.kind === 'Assertion').map(node => node.node_id).sort(),
  });
}

function coverageFromFacts(facts) {
  return Object.freeze({
    referents: facts.referent_ids.length,
    resolved_mentions: facts.resolved_mention_ids.length,
    unresolved_mentions: facts.mention_ids.length - facts.resolved_mention_ids.length,
    rel_edges: facts.rel_count,
    exact_occurrence_ambiguities: facts.ambiguity_receipt_ids.length,
  });
}

/** Assemble the complete atlas model from one database-read selected graph. */
export function buildAtlasModel({
  projection_id, graph_commit_id, identity_head, nodes, edges, source_documents,
  generation_inputs,
}) {
  if (![projection_id, graph_commit_id, identity_head].every(clean)) {
    fail('ATLAS_PROVENANCE_MISSING', 'projection id, graph commit id, and identity head are required');
  }
  const nodeById = new Map(nodes.map(node => [node.node_id, node]));
  if (nodeById.size !== nodes.length) fail('ATLAS_DUPLICATE_NODE', 'atlas input contains duplicate nodes');
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of edges) {
    const heldOut = outgoing.get(edge.from) || [];
    heldOut.push(edge); outgoing.set(edge.from, heldOut);
    const heldIn = incoming.get(edge.to) || [];
    heldIn.push(edge); incoming.set(edge.to, heldIn);
  }
  const resolutionEdges = edges.filter(edge => edge.type === 'RESOLVES_TO');
  const resolutionEdgesByReferent = new Map();
  for (const edge of resolutionEdges) {
    const held = resolutionEdgesByReferent.get(edge.to) || [];
    held.push(edge);
    resolutionEdgesByReferent.set(edge.to, held);
  }
  const referents = nodes.filter(node => node.kind === 'Referent').map(node => {
    const mentionEdges = resolutionEdgesByReferent.get(node.node_id) || [];
    const mentions = mentionEdges.map(edge => {
      const mention = nodeById.get(edge.from);
      const evidenceEdge = (outgoing.get(edge.from) || []).find(row => row.type === 'DERIVED_FROM'
        && nodeById.get(row.to)?.kind === 'EvidencePointer');
      const evidence = nodeById.get(evidenceEdge?.to);
      return {
        mention_id: edge.from,
        surface: mention?.properties?.surface,
        role: mention?.properties?.role,
        source_status: mention?.properties?.source_status,
        resolution_receipt_id: edge.properties.resolution_receipt_id,
        span: evidence ? {
          document_path: evidence.properties.document_path,
          line_start: evidence.properties.line_start,
          line_end: evidence.properties.line_end,
          byte_start: evidence.properties.byte_start,
          byte_end: evidence.properties.byte_end,
          evidence_digest: evidence.properties.evidence_digest,
        } : null,
      };
    }).sort((left, right) => left.mention_id.localeCompare(right.mention_id));
    return {
      referent_id: node.node_id,
      identity_kind: node.properties.identity_kind,
      lifecycle_state: node.properties.lifecycle_state,
      creation_receipt_id: node.properties.creation_receipt_id,
      observed_surfaces: unique(mentions.map(mention => mention.surface)),
      mentions,
      assertions: [],
      grounding_receipts: [],
    };
  }).sort((left, right) => left.referent_id.localeCompare(right.referent_id));
  const referentById = new Map(referents.map(referent => [referent.referent_id, referent]));
  const constraintById = new Map(nodes.filter(node => node.properties?.schema === 'estate-map/identity-constraint/v1')
    .map(node => [node.node_id, {
      constraint_id: node.node_id,
      left: node.properties.left,
      right: node.properties.right,
      disposition: node.properties.disposition,
      constraint_kind: node.properties.constraint_kind,
      basis: parseJson(node.properties.basis_json, `IdentityConstraint ${node.node_id} basis`),
      basis_evidence_ids: parseJson(node.properties.basis_evidence_ids_json,
        `IdentityConstraint ${node.node_id} evidence`),
      basis_assertion_ids: parseJson(node.properties.basis_assertion_ids_json,
        `IdentityConstraint ${node.node_id} assertions`),
      source_status: node.properties.source_status,
      valid_time: parseJson(node.properties.valid_time_json, `IdentityConstraint ${node.node_id} valid time`),
      authority: node.properties.authority,
      materialization_id: node.properties.materialization_id,
    }]));
  const receiptById = new Map(nodes.filter(node => node.properties?.schema === 'estate-map/resolution-receipt/v1')
    .map(node => [node.node_id, node]));
  for (const referent of referents) {
    const receiptIds = unique(referent.mentions.map(mention => mention.resolution_receipt_id));
    referent.grounding_receipts = receiptIds.map(receiptId => {
      const receipt = receiptById.get(receiptId);
      const constraintIds = parseJson(receipt?.properties?.identity_constraint_ids_json || '[]',
        `ResolutionReceipt ${receiptId} constraints`);
      return {
        resolution_receipt_id: receiptId,
        disposition: receipt?.properties?.disposition,
        selected_referent_id: receipt?.properties?.selected_referent_id,
        admitted_mention_ids: parseJson(receipt?.properties?.admitted_mention_ids_json || '[]',
          `ResolutionReceipt ${receiptId} mentions`),
        identity_constraints: constraintIds.map(id => constraintById.get(id) || { constraint_id: id, missing: true }),
      };
    });
  }

  const statements = nodes.filter(node => node.kind === 'Assertion').map(assertion => {
    const predicateEdge = (outgoing.get(assertion.node_id) || []).find(edge => edge.type === 'PREDICATE');
    const predicateNode = nodeById.get(predicateEdge?.to);
    const arguments_ = (outgoing.get(assertion.node_id) || []).filter(edge => edge.type === 'ARGUMENT')
      .sort((left, right) => left.properties.argument_index - right.properties.argument_index)
      .map(edge => ({
        role: edge.properties.role,
        argument_kind: edge.properties.argument_kind,
        endpoint_id: edge.to,
        raw_mention_id: edge.properties.raw_mention_id,
        resolution_receipt_id: edge.properties.resolution_receipt_id,
      }));
    const claimEdges = (outgoing.get(assertion.node_id) || []).filter(edge => edge.type === 'DERIVED_FROM'
      && edge.properties.basis_kind === 'claim');
    const documentarySources = exactSpans(claimEdges.flatMap(edge => {
      const claim = nodeById.get(edge.to);
      return claim?.kind === 'DocumentaryClaim' ? sourceSpanFromClaim(claim) : [];
    }));
    const groundingSources = (outgoing.get(assertion.node_id) || [])
      .filter(edge => edge.type === 'DERIVED_FROM' && edge.properties.basis_kind === 'grounding_evidence')
      .map(edge => structuredSourceFromEvidence(nodeById.get(edge.to))).filter(Boolean)
      .sort((left, right) => left.record_id.localeCompare(right.record_id));
    const sources = [...documentarySources, ...groundingSources];
    const predicate = predicateNode ? selectedPredicate(predicateNode) : '[missing predicate]';
    const renderedArguments = arguments_.map(argument => ({
      ...argument,
      text: argumentText(argument, referentById, nodeById),
    }));
    const subjects = renderedArguments.filter(argument => argument.role === 'subject').map(argument => argument.text);
    const objects = renderedArguments.filter(argument => argument.role === 'object').map(argument => argument.text);
    const others = renderedArguments.filter(argument => !['subject', 'object'].includes(argument.role));
    const readable = `${subjects.join('; ') || '[no subject]'} — ${predicate} — ${objects.join('; ') || '[no object]'}${others.length ? ` (${others.map(argument => `${argument.role}: ${argument.text}`).join('; ')})` : ''}`;
    return {
      assertion_id: assertion.node_id,
      plane: assertion.properties.raw_schema === 'estate-map/grounded-assertion/v1'
        ? 'code' : 'documentary',
      predicate,
      readable,
      arguments: renderedArguments,
      polarity: assertion.properties.polarity,
      modality: assertion.properties.modality,
      quantifier: assertion.properties.quantifier,
      scope: parseJson(assertion.properties.scope_json, `Assertion ${assertion.node_id} scope`),
      conditions: parseJson(assertion.properties.conditions_json, `Assertion ${assertion.node_id} conditions`),
      valid_time: parseJson(assertion.properties.valid_time_json, `Assertion ${assertion.node_id} valid time`),
      source_status: assertion.properties.source_status,
      decision_status: assertion.properties.decision_status,
      recorded_time: assertion.properties.recorded_time,
      sources,
    };
  }).sort((left, right) => left.assertion_id.localeCompare(right.assertion_id));
  const statementById = new Map(statements.map(statement => [statement.assertion_id, statement]));
  for (const referent of referents) {
    referent.assertions = (incoming.get(referent.referent_id) || []).filter(edge => edge.type === 'ARGUMENT')
      .map(edge => ({ assertion_id: edge.from, role: edge.properties.role,
        readable: statementById.get(edge.from)?.readable }))
      .sort((left, right) => left.assertion_id.localeCompare(right.assertion_id));
  }
  const statementIdsByDocument = new Map();
  for (const statement of statements) for (const path of unique(statement.sources
    .filter(source => source.pointer_kind !== 'structured_record').map(source => source.document_path))) {
    const held = statementIdsByDocument.get(path) || [];
    held.push(statement.assertion_id); statementIdsByDocument.set(path, held);
  }
  const documents = unique(source_documents).map(path => ({
    document_path: path,
    statement_ids: unique(statementIdsByDocument.get(path) || []),
  }));
  const graphFacts = buildGraphFacts(nodes, edges);
  const model = {
    schema: C3B_ATLAS_SCHEMA,
    atlas_version: C3B_ATLAS_VERSION,
    provenance: {
      projection_id,
      graph_commit_id,
      identity_head,
      generation_inputs,
    },
    graph_facts: graphFacts,
    coverage: coverageFromFacts(graphFacts),
    statements,
    referents,
    documents,
  };
  validateAtlasModel(model);
  return Object.freeze(model);
}

/** Fail-closed validation shared by rendering, the gate, and focused negations. */
export function validateAtlasModel(model) {
  if (model?.schema !== C3B_ATLAS_SCHEMA
    || !clean(model.provenance?.projection_id)
    || !clean(model.provenance?.graph_commit_id)
    || !clean(model.provenance?.identity_head)
    || !model.provenance?.generation_inputs) {
    fail('ATLAS_PROVENANCE_MISSING', 'every atlas page requires complete selected-head provenance');
  }
  const expectedCoverage = coverageFromFacts(model.graph_facts);
  if (canonical(model.coverage) !== canonical(expectedCoverage)) {
    fail('ATLAS_COVERAGE_MISMATCH', 'rendered coverage differs from live graph facts');
  }
  const assertionIds = new Set(model.graph_facts.assertion_ids);
  for (const statement of model.statements || []) {
    if (!assertionIds.has(statement.assertion_id)) {
      fail('ATLAS_ASSERTION_MISSING', `rendered statement ${statement.assertion_id} is absent from the selected graph`);
    }
    const validDocumentSpan = span => clean(span.document_path)
      && Number.isInteger(span.line_start) && Number.isInteger(span.line_end)
      && Number.isInteger(span.byte_start) && Number.isInteger(span.byte_end)
      && span.line_start >= 0 && span.line_end >= span.line_start && span.byte_start >= 0
      && span.byte_end >= span.byte_start && clean(span.evidence_digest);
    const validStructuredRecord = source => source.pointer_kind === 'structured_record'
      && clean(source.evidence_id) && clean(source.record_id) && clean(source.schema_id)
      && clean(source.record_digest) && clean(source.fact_kind) && source.exact_record
      && typeof source.exact_record === 'object';
    if (!statement.sources?.length || statement.sources.some(source =>
      !validDocumentSpan(source) && !validStructuredRecord(source))) {
      fail('ATLAS_STATEMENT_SPAN_MISSING',
        `statement ${statement.assertion_id} lacks exact documentary or structured-record custody`);
    }
  }
  for (const referent of model.referents || []) {
    const forbidden = Object.keys(referent).filter(key => forbiddenReferentField.test(key));
    if (forbidden.length) {
      fail('ATLAS_REFERENT_LABEL_FORBIDDEN', `Referent ${referent.referent_id} contains an invented display field`,
        { forbidden });
    }
    const attested = unique((referent.mentions || []).map(mention => mention.surface));
    if (canonical(referent.observed_surfaces) !== canonical(attested)
      || referent.mentions.some(mention => !clean(mention.surface) || !mention.span
        || !clean(mention.resolution_receipt_id))) {
      fail('ATLAS_REFERENT_SURFACE_MISMATCH',
        `Referent ${referent.referent_id} surfaces differ from its source-attested mentions`);
    }
    if (referent.grounding_receipts.some(receipt => receipt.selected_referent_id !== referent.referent_id
      || receipt.identity_constraints.some(constraint => constraint.missing))) {
      fail('ATLAS_REFERENT_GROUNDING_MISMATCH',
        `Referent ${referent.referent_id} lacks its exact receipt or identity constraints`);
    }
  }
  const documentPaths = new Set((model.documents || []).map(document => document.document_path));
  for (const statement of model.statements || []) for (const span of statement.sources) {
    if (span.pointer_kind !== 'structured_record' && !documentPaths.has(span.document_path)) {
      fail('ATLAS_SOURCE_DOCUMENT_MISSING', `statement source ${span.document_path} has no document page`);
    }
  }
  return true;
}

function provenanceFooter(model) {
  const provenance = model.provenance;
  return `<footer class="provenance"><strong>Rendering provenance</strong><dl>
    <div><dt>Projection</dt><dd>${escapeHtml(provenance.projection_id)}</dd></div>
    <div><dt>Graph commit</dt><dd>${escapeHtml(provenance.graph_commit_id)}</dd></div>
    <div><dt>Identity head</dt><dd>${escapeHtml(provenance.identity_head)}</dd></div>
    <div><dt>Generation inputs</dt><dd>${escapeHtml(canonical(provenance.generation_inputs))}</dd></div>
  </dl></footer>`;
}

function shell(model, { title, eyebrow, body, depth = 0, inlineAssets = false }) {
  const prefix = depth ? '../' : '';
  const styles = inlineAssets ? `<style>${css}</style>`
    : `<link rel="stylesheet" href="${prefix}assets/atlas.css">`;
  const script = inlineAssets ? `<script>${searchJs}</script>`
    : `<script src="${prefix}assets/search.js"></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light"><title>${escapeHtml(title)} · Statement Atlas</title>
  ${styles}</head><body>
  <header class="mast"><a class="brand" href="${prefix}index.html">Statement Atlas</a><span>${escapeHtml(eyebrow)}</span></header>
  <main>${body}</main>${provenanceFooter(model)}${script}</body></html>`;
}

function spanLink(span, documentPages, prefix = '') {
  if (span.pointer_kind === 'structured_record') return `<div class="source-link structured-record"><span>${escapeHtml(`${span.repository || '[repository]'} / ${span.document_path || '[record-only]'}`)}</span><small>${escapeHtml(span.fact_kind)}${span.line_start == null ? '' : ` · line ${span.line_start}`}</small><code>${escapeHtml(span.record_id)} · ${escapeHtml(span.record_digest)}</code></div>`;
  const href = `${prefix}${documentPages.get(span.document_path)}#span-${span.byte_start}-${span.byte_end}`;
  return `<a class="source-link" href="${escapeHtml(href)}"><span>${escapeHtml(span.document_path)}</span><small>lines ${span.line_start}–${span.line_end} · bytes ${span.byte_start}–${span.byte_end}</small><code>${escapeHtml(span.evidence_digest)}</code></a>`;
}

function qualifierTable(statement) {
  const rows = [
    ['Polarity', statement.polarity], ['Modality', statement.modality],
    ['Quantifier', statement.quantifier], ['Scope', canonical(statement.scope)],
    ['Conditions', canonical(statement.conditions)], ['Valid time', canonical(statement.valid_time)],
    ['Source status', statement.source_status], ['Decision status', statement.decision_status],
  ];
  return `<dl class="qualifiers">${rows.map(([key, value]) =>
    `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

function statementHtml(statement, documentPages, prefix = '') {
  return `<article class="statement" id="assertion-${escapeHtml(statement.assertion_id)}" data-search="${escapeHtml(`${statement.assertion_id} ${statement.plane} ${statement.predicate} ${statement.readable}`.toLocaleLowerCase())}">
    <div class="statement-head"><code>${escapeHtml(statement.assertion_id)}</code><span>${escapeHtml(statement.plane)} · ${escapeHtml(statement.source_status)}</span></div>
    <p class="spo">${escapeHtml(statement.readable)}</p>${qualifierTable(statement)}
    <details><summary>${statement.sources.length} exact source span${statement.sources.length === 1 ? '' : 's'}</summary>
      <div class="source-list">${statement.sources.map(span => spanLink(span, documentPages, prefix)).join('')}</div>
    </details></article>`;
}

function ledgerFile(kind, index) {
  return `ledgers/${kind}-${String(index + 1).padStart(4, '0')}.html`;
}

function ledgerNavigation({ kind, index, total, count, pageSize }) {
  const first = index * pageSize + 1;
  const last = Math.min(count, first + pageSize - 1);
  const previous = index > 0
    ? `<a rel="prev" href="${escapeHtml(basename(ledgerFile(kind, index - 1)))}">Previous</a>`
    : '<span aria-disabled="true">Previous</span>';
  const next = index + 1 < total
    ? `<a rel="next" href="${escapeHtml(basename(ledgerFile(kind, index + 1)))}">Next</a>`
    : '<span aria-disabled="true">Next</span>';
  return `<nav class="ledger-nav" aria-label="${escapeHtml(kind)} ledger pages">${previous}<span>Rows ${first}–${last} of ${count} · page ${index + 1} of ${total}</span>${next}</nav>`;
}

function indexPage(model, documentPages, ledgerPages) {
  const coverage = model.coverage;
  const documentaryCount = model.statements.filter(statement => statement.plane === 'documentary').length;
  const codeCount = model.statements.filter(statement => statement.plane === 'code').length;
  const coverageSentence = `This selected projection contains ${documentaryCount} documentary and ${codeCount} code-grounded assertions, ${coverage.referents} grounded referents, and ${coverage.resolved_mentions} resolved mentions; ${coverage.unresolved_mentions} mentions remain unresolved. It contains ${coverage.rel_edges} REL edges pending Phase F concepts and ${coverage.exact_occurrence_ambiguities} exact-occurrence ambiguities.`;
  const body = `<section class="intro"><div><p class="context">Selected graph, rendered without ranking</p><h1>Trace statements to the words that support them.</h1><p>${escapeHtml(coverageSentence)}</p><p class="boundary">Coverage is limited to this pinned projection and its 285 source inputs. It does not imply estate-wide entity coverage. Unresolved mentions are not presented as entities.</p></div>
    <dl class="coverage"><div><dt>Grounded referents</dt><dd>${coverage.referents}</dd></div><div><dt>Resolved / unresolved mentions</dt><dd>${coverage.resolved_mentions} / ${coverage.unresolved_mentions}</dd></div><div><dt>REL pending Phase F</dt><dd>${coverage.rel_edges}</dd></div><div><dt>Ambiguities</dt><dd>${coverage.exact_occurrence_ambiguities}</dd></div></dl></section>
  <section><div class="section-heading"><h2>Browse the graph</h2><p>Large ledgers are sharded in deterministic ID order so every page remains directly file-openable.</p></div><ul class="ledger-directory">
    <li><a href="${escapeHtml(ledgerPages.entity[0])}"><strong>Referent ledger</strong><span>${model.referents.length} Referents across ${ledgerPages.entity.length} pages</span></a></li>
    <li><a href="${escapeHtml(ledgerPages.statement[0])}"><strong>Statement ledger</strong><span>${model.statements.length} assertions across ${ledgerPages.statement.length} pages</span></a></li>
  </ul></section>
  <section class="search"><label for="atlas-search">Filter source documents on this page</label><input id="atlas-search" type="search" placeholder="Exact path fragment" autocomplete="off"><p id="search-status" aria-live="polite"></p></section>
  <section><div class="section-heading"><h2>Documents</h2><p>All ${model.documents.length} pinned source inputs, including sources with no rendered assertion.</p></div><ol class="document-index searchable">${model.documents.map(document => `<li data-search="${escapeHtml(document.document_path.toLocaleLowerCase())}"><a href="${documentPages.get(document.document_path)}">${escapeHtml(document.document_path)}</a><span>${document.statement_ids.length} statement${document.statement_ids.length === 1 ? '' : 's'}</span></li>`).join('')}</ol></section>`;
  return shell(model, { title: 'Index', eyebrow: 'Selected projection', body,
    inlineAssets: true });
}

function entityLedgerPage(model, referents, index, total, entityPages) {
  const navigation = ledgerNavigation({ kind: 'entities', index, total,
    count: model.referents.length, pageSize: ATLAS_ENTITY_LEDGER_PAGE_SIZE });
  const rows = referents.map(referent => `<li data-search="${escapeHtml(`${referent.referent_id} ${referent.observed_surfaces.join(' ')}`.toLocaleLowerCase())}"><a href="../${entityPages.get(referent.referent_id)}"><code>${escapeHtml(referent.referent_id)}</code><span>Observed surfaces: ${referent.observed_surfaces.map(escapeHtml).join(' · ')}</span></a></li>`).join('');
  const body = `<nav class="crumb"><a href="../index.html">Atlas</a><span>/</span><span>Referent ledger</span></nav><section class="ledger-hero"><h1>Referents</h1><p>Identifiers and source-attested surfaces only; no preferred labels. Filter narrows this shard.</p></section>${navigation}<section class="search"><label for="atlas-search">Filter this Referent page</label><input id="atlas-search" type="search" placeholder="Referent ID or observed surface" autocomplete="off"><p id="search-status" aria-live="polite"></p></section><ul class="entity-index searchable">${rows}</ul>${navigation}`;
  return shell(model, { title: `Referents ${index + 1} of ${total}`, eyebrow: 'Referent ledger', body, depth: 1 });
}

function statementLedgerPage(model, statements, index, total, documentPages) {
  const navigation = ledgerNavigation({ kind: 'statements', index, total,
    count: model.statements.length, pageSize: ATLAS_STATEMENT_LEDGER_PAGE_SIZE });
  const body = `<nav class="crumb"><a href="../index.html">Atlas</a><span>/</span><span>Statement ledger</span></nav><section class="ledger-hero"><h1>Statements</h1><p>Reified assertions in deterministic assertion-ID order. Filter narrows this shard.</p></section>${navigation}<section class="search"><label for="atlas-search">Filter this statement page</label><input id="atlas-search" type="search" placeholder="Assertion ID, predicate, or rendered argument" autocomplete="off"><p id="search-status" aria-live="polite"></p></section><div class="statement-ledger searchable">${statements.map(statement => statementHtml(statement, documentPages, '../')).join('')}</div>${navigation}`;
  return shell(model, { title: `Statements ${index + 1} of ${total}`, eyebrow: 'Statement ledger', body, depth: 1 });
}

function entityPage(model, referent, documentPages, statementPages) {
  const mentionRows = referent.mentions.map(mention => `<tr><td><strong>${escapeHtml(mention.surface)}</strong><small>${escapeHtml(mention.role)}</small></td><td>${spanLink(mention.span, documentPages, '../')}</td><td><code>${escapeHtml(mention.resolution_receipt_id)}</code></td></tr>`).join('');
  const assertionRows = referent.assertions.map(row => `<li><span class="role">${escapeHtml(row.role)}</span><a href="../${escapeHtml(statementPages.get(row.assertion_id))}#assertion-${escapeHtml(row.assertion_id)}">${escapeHtml(row.readable)}</a><code>${escapeHtml(row.assertion_id)}</code></li>`).join('');
  const receiptRows = referent.grounding_receipts.map(receipt => `<article class="receipt"><h3>Resolution receipt</h3><code>${escapeHtml(receipt.resolution_receipt_id)}</code><p>${escapeHtml(receipt.disposition)} · ${receipt.admitted_mention_ids.length} admitted mentions</p><h4>Identity constraints</h4>${receipt.identity_constraints.map(constraint => `<dl class="constraint"><div><dt>ID</dt><dd>${escapeHtml(constraint.constraint_id)}</dd></div><div><dt>Disposition</dt><dd>${escapeHtml(constraint.disposition)}</dd></div><div><dt>Endpoints</dt><dd>${escapeHtml(constraint.left)} ↔ ${escapeHtml(constraint.right)}</dd></div><div><dt>Basis</dt><dd>${escapeHtml(canonical(constraint.basis))}</dd></div><div><dt>Authority</dt><dd>${escapeHtml(constraint.authority)}</dd></div></dl>`).join('')}</article>`).join('');
  const body = `<nav class="crumb"><a href="../index.html">Atlas</a><span>/</span><span>Referent</span></nav>
  <section class="entity-hero"><p class="context">Referent identifier</p><h1>${escapeHtml(referent.referent_id)}</h1><p><strong>Observed surfaces:</strong> ${referent.observed_surfaces.map(surface => `“${escapeHtml(surface)}”`).join(' · ')}</p><dl><div><dt>Identity kind</dt><dd>${escapeHtml(referent.identity_kind)}</dd></div><div><dt>Lifecycle</dt><dd>${escapeHtml(referent.lifecycle_state)}</dd></div><div><dt>Creation receipt</dt><dd><code>${escapeHtml(referent.creation_receipt_id)}</code></dd></div></dl></section>
  <section><div class="section-heading"><h2>Constituent mentions</h2><p>Every resolved occurrence and its exact span.</p></div><div class="table-wrap"><table><thead><tr><th>Observed surface</th><th>Source span</th><th>Receipt</th></tr></thead><tbody>${mentionRows}</tbody></table></div></section>
  <section><div class="section-heading"><h2>Assertion participation</h2><p>Every selected assertion and argument role.</p></div><ul class="participation">${assertionRows || '<li>No assertion participation in this selected projection.</li>'}</ul></section>
  <section><div class="section-heading"><h2>Grounding</h2><p>Receipts and whole-component constraints, without a canonical name.</p></div>${receiptRows}</section>`;
  return shell(model, { title: `Referent ${referent.referent_id}`, eyebrow: 'Identity drill-down', body, depth: 1 });
}

function documentPage(model, document, documentPages, statementById) {
  const statements = document.statement_ids.map(id => statementById.get(id));
  const localSpans = exactSpans(statements.flatMap(statement => statement.sources)
    .filter(span => span.pointer_kind !== 'structured_record'
      && span.document_path === document.document_path));
  const spanAnchors = localSpans.map(span => `<li id="span-${span.byte_start}-${span.byte_end}"><span>lines ${span.line_start}–${span.line_end} · bytes ${span.byte_start}–${span.byte_end}</span><code>${escapeHtml(span.evidence_digest)}</code></li>`).join('');
  const body = `<nav class="crumb"><a href="../index.html">Atlas</a><span>/</span><span>Document</span></nav>
  <section class="document-hero"><p class="context">Pinned source input</p><h1>${escapeHtml(document.document_path)}</h1><p>${statements.length} selected rendered statement${statements.length === 1 ? '' : 's'} cite this document.</p></section>
  ${localSpans.length ? `<section><div class="section-heading"><h2>Exact cited spans</h2><p>Line and UTF-8 byte coordinates with evidence digests.</p></div><ol class="span-index">${spanAnchors}</ol></section>` : ''}
  <section><div class="section-heading"><h2>Claims from this source</h2><p>Statement semantics remain qualified; source links retain exact line, byte, and digest custody.</p></div>${statements.length ? `<div class="statement-ledger">${statements.map(statement => statementHtml(statement, documentPages, '../')).join('')}</div>` : '<p class="empty">No selected rendered assertion cites this source. This does not assert that the source contains no claims.</p>'}</section>`;
  return shell(model, { title: document.document_path, eyebrow: 'Document drill-down', body, depth: 1 });
}

const css = `:root{--bg:oklch(1 0 0);--surface:oklch(.965 0 0);--ink:oklch(.19 .018 38);--muted:oklch(.47 .018 38);--line:oklch(.88 .012 38);--primary:oklch(.62 .145 38);--primary-soft:oklch(.94 .035 38);--accent:oklch(.29 .105 245);--focus:oklch(.67 .16 245);--radius:.45rem}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font-family:Aptos,"Segoe UI",sans-serif;font-size:16px;line-height:1.55}.mast{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;padding:.8rem max(1rem,calc((100vw - 78rem)/2));background:color-mix(in oklch,var(--bg) 94%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.mast a{color:var(--ink);font-weight:750;text-decoration:none}.mast span{color:var(--muted);font-size:.88rem}main{max-width:78rem;margin:auto;padding:3rem 1.25rem 6rem}h1,h2,h3,h4{line-height:1.15;text-wrap:balance}h1{max-width:18ch;margin:.3rem 0 1rem;font-size:3.35rem;letter-spacing:-.035em}h2{font-size:1.55rem}a{color:var(--accent);text-underline-offset:.2em}code{font-family:"Cascadia Code","SFMono-Regular",monospace;font-size:.78em;overflow-wrap:anywhere}.context{color:var(--primary);font-weight:750}.intro{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(17rem,.8fr);gap:4rem;align-items:end;padding-bottom:3rem;border-bottom:1px solid var(--ink)}.intro p{max-width:68ch}.boundary{padding:.85rem 1rem;background:var(--primary-soft);border:1px solid color-mix(in oklch,var(--primary) 25%,var(--line));border-radius:var(--radius)}.coverage{margin:0}.coverage div{display:flex;justify-content:space-between;gap:1rem;padding:.8rem 0;border-top:1px solid var(--line)}.coverage dd{margin:0;font-weight:800}.search{margin:2.5rem 0 4rem;padding:1.25rem 0;border-block:1px solid var(--line)}.search label{display:block;font-weight:750;margin-bottom:.5rem}.search input{width:min(100%,42rem);padding:.75rem .9rem;border:1px solid var(--muted);border-radius:var(--radius);font:inherit;background:var(--bg);color:var(--ink)}.search input:focus{outline:3px solid color-mix(in oklch,var(--focus) 35%,transparent);border-color:var(--focus)}#search-status{display:inline;margin-left:1rem;color:var(--muted)}section+section{margin-top:4.5rem}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:2rem;border-bottom:1px solid var(--ink)}.section-heading p{color:var(--muted);max-width:52ch}.entity-index,.participation,.ledger-directory{list-style:none;padding:0}.entity-index li a{display:grid;grid-template-columns:minmax(17rem,.8fr) 1.4fr;gap:1.5rem;padding:1rem 0;border-bottom:1px solid var(--line);text-decoration:none}.entity-index span{color:var(--ink)}.ledger-directory li a{display:flex;justify-content:space-between;gap:2rem;padding:1.15rem 0;border-bottom:1px solid var(--line);text-decoration:none}.ledger-directory span{color:var(--muted);text-align:right}.ledger-hero{padding-bottom:1.5rem;border-bottom:1px solid var(--ink)}.ledger-hero h1{font-size:2.25rem}.ledger-nav{display:grid;grid-template-columns:6rem 1fr 6rem;align-items:center;gap:1rem;margin:1.5rem 0;padding:.8rem 0;border-block:1px solid var(--line);text-align:center}.ledger-nav a:first-child,.ledger-nav span:first-child{text-align:left}.ledger-nav a:last-child,.ledger-nav span:last-child{text-align:right}.ledger-nav [aria-disabled=true]{color:var(--muted)}.statement{padding:1.35rem 0 1.8rem;border-bottom:1px solid var(--line);scroll-margin-top:5rem}.statement-head{display:flex;justify-content:space-between;gap:1rem;color:var(--muted)}.statement-head span,.role{padding:.15rem .45rem;border-radius:99rem;background:var(--surface);font-size:.78rem}.spo{max-width:75ch;font-size:1.08rem;font-weight:650}.qualifiers{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem}.qualifiers div{display:flex;gap:.4rem}.qualifiers dt{color:var(--muted)}.qualifiers dd{margin:0}.source-list{display:grid;gap:.55rem;margin-top:.8rem}.source-link{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(11rem,.6fr) minmax(15rem,1fr);gap:1rem;align-items:center;padding:.7rem .85rem;background:var(--surface);border-radius:var(--radius);text-decoration:none}.source-link small{color:var(--muted)}.document-index{columns:2;column-gap:3rem}.document-index li{break-inside:avoid;display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-bottom:1px solid var(--line)}.document-index span{color:var(--muted)}.span-index{padding:0;list-style:none}.span-index li{display:flex;justify-content:space-between;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line);scroll-margin-top:5rem}.crumb{display:flex;gap:.5rem;color:var(--muted);margin-bottom:3rem}.entity-hero,.document-hero{padding-bottom:2.5rem;border-bottom:1px solid var(--ink)}.entity-hero h1,.document-hero h1{font-family:"Cascadia Code","SFMono-Regular",monospace;font-size:2.25rem;max-width:32ch;overflow-wrap:anywhere}.entity-hero dl{display:flex;flex-wrap:wrap;gap:1rem 3rem}.entity-hero dl div{max-width:28rem}.entity-hero dt{color:var(--muted)}.entity-hero dd{margin:0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:.8rem;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:.84rem}td small{display:block;color:var(--muted)}.participation li{display:grid;grid-template-columns:auto 1fr minmax(12rem,.6fr);gap:1rem;padding:.8rem 0;border-bottom:1px solid var(--line)}.receipt{padding:1rem 0 2rem;border-bottom:1px solid var(--ink)}.constraint{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.75rem}.constraint div{padding:.6rem;background:var(--surface)}.constraint dt{color:var(--muted)}.constraint dd{margin:.2rem 0 0;overflow-wrap:anywhere}.empty{padding:2rem;background:var(--surface);border-radius:var(--radius)}.provenance{padding:2rem max(1rem,calc((100vw - 78rem)/2));background:var(--accent);color:oklch(1 0 0)}.provenance dl{display:grid;gap:.4rem}.provenance dl div{display:grid;grid-template-columns:9rem 1fr}.provenance dt{opacity:.75}.provenance dd{margin:0;font-family:"Cascadia Code","SFMono-Regular",monospace;font-size:.78rem;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:760px){main{padding-top:2rem}h1{font-size:2.4rem}.intro{grid-template-columns:1fr;gap:1.5rem}.section-heading{display:block}.entity-index li a,.source-link,.participation li{grid-template-columns:1fr}.document-index{columns:1}.provenance dl div{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
const searchJs = `(()=>{const input=document.querySelector('#atlas-search');if(!input)return;const rows=[...document.querySelectorAll('.searchable [data-search]')];const status=document.querySelector('#search-status');const apply=()=>{const q=input.value.trim().toLocaleLowerCase();let shown=0;for(const row of rows){const match=!q||row.dataset.search.includes(q);row.hidden=!match;if(match)shown++}status.textContent=q?shown+' matches':''};input.addEventListener('input',apply)})();`;

/** Write a directly file-openable atlas to one explicit output directory. */
export function renderAtlas(model, outputDir) {
  validateAtlasModel(model);
  if (!resolve(outputDir).startsWith('/')) fail('ATLAS_OUTPUT_REQUIRED', 'atlas output directory must be absolute');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(join(outputDir, 'assets'), { recursive: true });
  mkdirSync(join(outputDir, 'entities'), { recursive: true });
  mkdirSync(join(outputDir, 'documents'), { recursive: true });
  mkdirSync(join(outputDir, 'ledgers'), { recursive: true });
  const entityPages = new Map(model.referents.map(referent =>
    [referent.referent_id, `entities/${pageKey('referent', referent.referent_id)}`]));
  const documentPages = new Map(model.documents.map(document =>
    [document.document_path, `documents/${pageKey('document', document.document_path)}`]));
  const entityLedgerCount = Math.max(1, Math.ceil(model.referents.length / ATLAS_ENTITY_LEDGER_PAGE_SIZE));
  const statementLedgerCount = Math.max(1, Math.ceil(model.statements.length / ATLAS_STATEMENT_LEDGER_PAGE_SIZE));
  const ledgerPages = {
    entity: Array.from({ length: entityLedgerCount }, (_, index) => ledgerFile('entities', index)),
    statement: Array.from({ length: statementLedgerCount }, (_, index) => ledgerFile('statements', index)),
  };
  const statementPages = new Map(model.statements.map((statement, index) =>
    [statement.assertion_id, ledgerPages.statement[Math.floor(index / ATLAS_STATEMENT_LEDGER_PAGE_SIZE)]]));
  writeFileSync(join(outputDir, 'assets/atlas.css'), css);
  writeFileSync(join(outputDir, 'assets/search.js'), searchJs);
  writeFileSync(join(outputDir, 'index.html'), indexPage(model, documentPages, ledgerPages));
  for (const [index, path] of ledgerPages.entity.entries()) {
    const rows = model.referents.slice(index * ATLAS_ENTITY_LEDGER_PAGE_SIZE,
      (index + 1) * ATLAS_ENTITY_LEDGER_PAGE_SIZE);
    writeFileSync(join(outputDir, path), entityLedgerPage(model, rows, index,
      entityLedgerCount, entityPages));
  }
  for (const [index, path] of ledgerPages.statement.entries()) {
    const rows = model.statements.slice(index * ATLAS_STATEMENT_LEDGER_PAGE_SIZE,
      (index + 1) * ATLAS_STATEMENT_LEDGER_PAGE_SIZE);
    writeFileSync(join(outputDir, path), statementLedgerPage(model, rows, index,
      statementLedgerCount, documentPages));
  }
  for (const referent of model.referents) writeFileSync(join(outputDir, entityPages.get(referent.referent_id)),
    entityPage(model, referent, documentPages, statementPages));
  const statementById = new Map(model.statements.map(statement => [statement.assertion_id, statement]));
  for (const document of model.documents) writeFileSync(join(outputDir, documentPages.get(document.document_path)),
    documentPage(model, document, documentPages, statementById));
  const manifest = {
    schema: 'estate-map/c3b-atlas-render-receipt/v1',
    page_count: 1 + model.referents.length + model.documents.length
      + entityLedgerCount + statementLedgerCount,
    ledger_pages: { entities: entityLedgerCount, statements: statementLedgerCount },
    ledger_page_sizes: { entities: ATLAS_ENTITY_LEDGER_PAGE_SIZE,
      statements: ATLAS_STATEMENT_LEDGER_PAGE_SIZE },
    projection_id: model.provenance.projection_id,
    graph_commit_id: model.provenance.graph_commit_id,
    identity_head: model.provenance.identity_head,
    coverage: model.coverage,
    assertion_ids: model.graph_facts.assertion_ids,
    referent_surfaces: Object.fromEntries(model.referents.map(referent =>
      [referent.referent_id, referent.observed_surfaces])),
    digest: stableCanonicalSha256(model),
  };
  writeFileSync(join(outputDir, 'atlas-manifest.json'), `${canonical(manifest)}\n`);
  return Object.freeze({ output_dir: outputDir, page_count: manifest.page_count,
    view_command: `xdg-open 'file://${join(outputDir, 'index.html')}'`, manifest });
}

export async function readSelectedProjection(client) {
  const before = await client.readHead();
  if (!clean(before.projection_id) || !clean(before.graph_commit_id)) {
    fail('ATLAS_SELECTED_HEAD_MISSING', 'explicit Neo4j target has no selected C3 projection');
  }
  const kinds = ['Assertion', 'Predicate', 'Mention', 'Referent', 'Literal', 'DocumentaryClaim',
    'EvidencePointer', 'Receipt', 'Constraint', 'GraphCommit'];
  const [nodeRows, edgeRows] = await Promise.all([
    client.query(`
      MATCH (n:C3Node {projection_id: $projection_id})
      WHERE n.kind IN $kinds
      RETURN n.node_id, n.kind, properties(n) ORDER BY n.node_id
    `, { projection_id: before.projection_id, kinds }),
    client.query(`
      MATCH (a:C3Node {projection_id: $projection_id})-[e]->(b:C3Node {projection_id: $projection_id})
      WHERE type(e) IN $types
      RETURN type(e), a.node_id, b.node_id, properties(e)
      ORDER BY type(e), a.node_id, b.node_id
    `, { projection_id: before.projection_id,
      types: ['ARGUMENT', 'PREDICATE', 'DERIVED_FROM', 'RESOLVES_TO', 'REL'] }),
  ]);
  const after = await client.readHead();
  if (canonical(before) !== canonical(after)) {
    fail('ATLAS_SELECTED_HEAD_CHANGED', 'selected C3 head changed during atlas read');
  }
  const nodes = nodeRows.map(row => ({ node_id: row[0], kind: row[1], properties: row[2] || {} }));
  const edges = edgeRows.map(row => ({ type: row[0], from: row[1], to: row[2], properties: row[3] || {} }));
  const commit = nodes.find(node => node.kind === 'GraphCommit' && node.node_id === before.graph_commit_id);
  if (!clean(commit?.properties?.identity_head)) {
    fail('ATLAS_IDENTITY_HEAD_MISSING', 'selected projection GraphCommit lacks its identity head');
  }
  return Object.freeze({ head: before, identity_head: commit.properties.identity_head, nodes, edges });
}

function credentialsFromExplicitFile(path, expectedUsername) {
  const entries = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) fail('ATLAS_CREDENTIAL_FILE_INVALID', 'Neo4j credential file is malformed');
    entries.set(line.slice(0, index), line.slice(index + 1));
  }
  if (entries.get('NEO4J_USER') !== expectedUsername || !entries.get('NEO4J_PASSWORD')) {
    fail('ATLAS_CREDENTIAL_FILE_INVALID', 'Neo4j credential file lacks the explicit matching user');
  }
  return { username: expectedUsername, password: entries.get('NEO4J_PASSWORD') };
}

function parseArguments(argv) {
  const allowed = ['--uri', '--username', '--password-file', '--source-manifest', '--output-dir'];
  const fields = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowed.includes(flag) || value == null || fields.has(flag)) {
      fail('ATLAS_USAGE', `usage: node tools/c3b-atlas.mjs ${allowed.map(flag => `${flag} <value>`).join(' ')}`);
    }
    fields.set(flag, value);
  }
  if (fields.size !== allowed.length) fail('ATLAS_USAGE', 'all explicit atlas inputs are required');
  const outputDir = resolve(fields.get('--output-dir'));
  const sourceManifest = resolve(fields.get('--source-manifest'));
  return { uri: fields.get('--uri'), username: fields.get('--username'),
    passwordFile: fields.get('--password-file'), sourceManifest, outputDir };
}

export async function generateAtlas(options) {
  parseNeo4jConnectionTarget(options);
  const manifestBytes = readFileSync(options.sourceManifest);
  const sourceManifest = JSON.parse(manifestBytes);
  if (!clean(sourceManifest.source_sha) || !Array.isArray(sourceManifest.documents)
    || sourceManifest.documents.some(document => !clean(document.path))) {
    fail('ATLAS_SOURCE_MANIFEST_INVALID', 'source manifest lacks its pinned source head or documents');
  }
  const selected = await readSelectedProjection(new Neo4jHttpClient(options));
  if (selected.nodes.filter(node => node.kind === 'Assertion').length === 0) {
    fail('ATLAS_ASSERTIONS_MISSING', 'selected projection contains no assertions');
  }
  const model = buildAtlasModel({
    projection_id: selected.head.projection_id,
    graph_commit_id: selected.head.graph_commit_id,
    identity_head: selected.identity_head,
    nodes: selected.nodes,
    edges: selected.edges,
    source_documents: sourceManifest.documents.map(document => document.path),
    generation_inputs: {
      atlas_version: C3B_ATLAS_VERSION,
      neo4j_origin: new URL(options.uri).origin,
      source_manifest: options.sourceManifest,
      source_manifest_sha256: sha256(manifestBytes),
      source_head: sourceManifest.source_sha,
    },
  });
  return renderAtlas(model, options.outputDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const credentials = credentialsFromExplicitFile(args.passwordFile, args.username);
    const result = await generateAtlas({ ...args, ...credentials });
    console.log(`PASS C3b atlas: ${result.page_count} pages at ${result.output_dir}`);
    console.log(`VIEW ${result.view_command}`);
  } catch (error) {
    console.error(`FAIL C3b atlas: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
