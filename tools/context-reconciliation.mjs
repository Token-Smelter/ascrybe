// Deterministic cross-boundary candidate selection plus custodied targeted reconciliation.
//
// Candidate generation is zero-inference. Model work begins only after exact source blocks are
// selected. Query-driven selection is rejected unless the caller explicitly authorizes it.
import { buildClaimV32 } from './claim-v32.mjs';
import { createWindowBlockCatalog, renderBlockCatalog, resolveSourceLocator } from './source-locator.mjs';
import { inventoryIndex } from './recursive-contracts.mjs';
import { runCustodiedInference } from './custodied-inference.mjs';
import { parseModelJsonStream } from './neural-json.mjs';
import { flatLineContractLines, parseFlatRelationAnswer } from './flat-relation-lines.mjs';
import { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const RECONCILIATION_CANDIDATE_SCHEMA = 'estate-map/reconciliation-candidate/v2';
export const RECONCILIATION_RESULT_SCHEMA = 'estate-map/context-reconciliation/v1';
export const RELATION_LINK_SCHEMA = 'estate-map/reconciled-relation-link/v1';
export const RECONCILIATION_VERSION = 'context-reconciliation@4';
export const ATOMIC_RECONCILIATION_VERSION = 'context-atomic-reconciliation@4';
const canonical = value => stableStringify(value).trim();
const norm = value => String(value ?? '').trim().toLocaleLowerCase();
const REFUSALS = new Set(['no_joint_claim', 'ambiguous_identity', 'insufficient_context']);
const LINK_KINDS = new Set(['qualifies', 'exception_to', 'depends_on', 'motivates', 'prevents', 'implements']);

export class ContextReconciliationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ContextReconciliationError';
    this.code = code;
    this.detail = detail;
  }
}

const blockForLine = (inventory, line) => inventory.blocks.find(block => block.start <= line && block.end >= line) || null;

const DEFAULT_CANDIDATE_LIMITS = Object.freeze({
  max_blocks: 16,
  max_files: 4,
  max_exact_spans: 64,
  max_surface_occurrences: 16,
  max_candidate_bytes: 192 * 1024,
  max_packet_bytes: 48 * 1024,
  max_expected_packets: 4,
});
const DECLARATION_KINDS = new Set(['defined_term', 'structured_field']);
const USE_KINDS = new Set(['symbol', 'structured_value']);
const GENERIC_SURFACES = new Set([
  'and', 'not', 'id', 'kind', 'type', 'status', 'name', 'value', 'key', 'design.md', 'index.mjs', 'e.g',
]);
const discriminativeIdentifier = rows => {
  const display = String(rows[0]?.display || '');
  const surface = String(rows[0]?.surface || '');
  return surface.length >= 4 && !GENERIC_SURFACES.has(surface)
    && /[._/:()\-]|[A-Z].*[A-Z]|\d/.test(display);
};

/**
 * Build bounded candidates from independent typed witnesses. No signal may union another candidate,
 * and no transitive closure exists: a common surface can never connect unrelated evidence packets.
 */
export function buildReconciliationCandidates({
  prepasses, query_terms = [], query_authorized = false, limits: suppliedLimits = {},
}) {
  if (query_terms.length && !query_authorized) {
    throw new ContextReconciliationError('QUERY_CANDIDATE_NOT_AUTHORIZED', 'query-driven candidate selection requires explicit authorization');
  }
  const limits = Object.freeze({ ...DEFAULT_CANDIDATE_LIMITS, ...suppliedLimits });
  const index = inventoryIndex(prepasses.map(prepass => prepass.inventory));
  const occurrencesBySurface = new Map();
  for (const prepass of prepasses) {
    for (const mention of prepass.mentions) {
      for (const line of mention.lines) {
        const block = blockForLine(prepass.inventory, line);
        if (!block) continue;
        const row = { surface: mention.normalized, display: mention.surface, kind: mention.kind, file: prepass.file, line, block_address: block.address, block_id: block.id };
        const bySurface = occurrencesBySurface.get(row.surface) || [];
        bySurface.push(row); occurrencesBySurface.set(row.surface, bySurface);
      }
    }
  }

  const candidates = [];
  const exactSpan = row => ({
    file: row.file, start: row.line, end: row.line, surface: row.display,
    normalized_surface: row.surface, kind: row.kind,
    block_address: row.block_address, block_id: row.block_id,
  });
  const addCandidate = ({ candidate_kind, rows, signals, block_addresses = null }) => {
    const exactSpans = [...new Map(rows.map(row => [canonical({
      file: row.file, line: row.line, surface: row.surface, kind: row.kind,
    }), exactSpan(row)])).values()]
      .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.normalized_surface.localeCompare(b.normalized_surface));
    const addresses = [...new Set(block_addresses || rows.map(row => row.block_address))].filter(Boolean).sort();
    if (addresses.length < 2 || exactSpans.length < 2 || !signals.length) return;
    const blocks = addresses.map(address => index.byAddress.get(address)).filter(Boolean);
    const totalBytes = blocks.reduce((sum, block) => sum + Number(block.bytes || 0), 0);
    const files = [...new Set(blocks.map(block => block.file))].sort();
    const expectedPackets = blocks.some(block => block.bytes > limits.max_packet_bytes)
      ? Infinity : Math.ceil(totalBytes / limits.max_packet_bytes);
    const boundFindings = [];
    if (addresses.length > limits.max_blocks) boundFindings.push({ code: 'CANDIDATE_BLOCK_CAP_EXCEEDED', observed: addresses.length, maximum: limits.max_blocks });
    if (files.length > limits.max_files) boundFindings.push({ code: 'CANDIDATE_FILE_CAP_EXCEEDED', observed: files.length, maximum: limits.max_files });
    if (exactSpans.length > limits.max_exact_spans) boundFindings.push({ code: 'CANDIDATE_SPAN_CAP_EXCEEDED', observed: exactSpans.length, maximum: limits.max_exact_spans });
    if (totalBytes > limits.max_candidate_bytes) boundFindings.push({ code: 'CANDIDATE_BYTE_CAP_EXCEEDED', observed: totalBytes, maximum: limits.max_candidate_bytes });
    if (!Number.isFinite(expectedPackets)) {
      const oversized = blocks.filter(block => block.bytes > limits.max_packet_bytes).map(block => ({ address: block.address, bytes: block.bytes }));
      boundFindings.push({ code: 'INDIVISIBLE_JOINT_BLOCK_TOO_LARGE', maximum: limits.max_packet_bytes, blocks: oversized });
    } else if (expectedPackets > limits.max_expected_packets) {
      boundFindings.push({ code: 'CANDIDATE_PACKET_CAP_EXCEEDED', observed: expectedPackets, maximum: limits.max_expected_packets });
    }
    const body = {
      schema: RECONCILIATION_CANDIDATE_SCHEMA,
      authority_plane: 'deterministic_structure',
      producer: 'bounded_typed_candidate_witness',
      candidate_kind,
      status: boundFindings.length ? 'unresolved_due_to_bound' : 'ready',
      block_addresses: addresses,
      exact_spans: exactSpans,
      signals: signals.slice().sort((a, b) => canonical(a).localeCompare(canonical(b))),
      bounds: { ...limits, observed_blocks: addresses.length, observed_files: files.length,
        observed_exact_spans: exactSpans.length, observed_bytes: totalBytes,
        expected_packets: Number.isFinite(expectedPackets) ? expectedPackets : null },
      bound_findings: boundFindings,
    };
    candidates.push(Object.freeze({ ...body, id: `reconciliation-candidate:${sha256(canonical(body))}` }));
  };

  // One explicit reference is one candidate. References never union with each other.
  for (const prepass of prepasses) {
    for (const reference of prepass.section_references || []) {
      const sourceBlock = blockForLine(prepass.inventory, reference.source_span.start);
      const targetBlock = index.byAddress.get(reference.target.block_address);
      if (!sourceBlock || !targetBlock) continue;
      addCandidate({
        candidate_kind: 'explicit_section_reference',
        rows: [
          { surface: `section:${reference.number}`, display: `section ${reference.number}`, kind: 'section_reference_source',
            file: reference.source_span.file, line: reference.source_span.start, block_address: sourceBlock.address, block_id: sourceBlock.id },
          { surface: `section:${reference.number}`, display: `section ${reference.number}`, kind: 'section_reference_target',
            file: reference.target.file, line: reference.target.start, block_address: targetBlock.address, block_id: targetBlock.id },
        ],
        signals: [{ kind: 'explicit_section_reference', from: sourceBlock.address, to: targetBlock.address, reference_id: reference.id }],
      });
    }
  }

  // Declaration/use candidates require a discriminative exact identifier and compatible roles.
  for (const [surface, allRows] of occurrencesBySurface) {
    const rows = allRows.filter(row => row.kind !== 'diagram_identifier');
    if (rows.length < 2 || rows.length > limits.max_surface_occurrences || !discriminativeIdentifier(rows)) continue;
    const declarations = rows.filter(row => DECLARATION_KINDS.has(row.kind));
    const uses = rows.filter(row => USE_KINDS.has(row.kind));
    if (!declarations.length || !uses.length) continue;
    const selectedRows = [...declarations, ...uses];
    if (new Set(selectedRows.map(row => row.block_address)).size < 2) continue;
    addCandidate({
      candidate_kind: 'declaration_use',
      rows: selectedRows,
      signals: [{ kind: 'namespace_compatible_declaration_use', surface,
        declaration_kinds: [...new Set(declarations.map(row => row.kind))].sort(),
        use_kinds: [...new Set(uses.map(row => row.kind))].sort() }],
    });
  }

  // Source-stated aliases are witnesses, not similarity. Bound the associated exact occurrences.
  for (const prepass of prepasses) {
    for (const alias of prepass.aliases || []) {
      const sourceBlock = blockForLine(prepass.inventory, alias.source_span.start);
      const rows = [
        ...(occurrencesBySurface.get(alias.alias) || []),
        ...(occurrencesBySurface.get(alias.refers_to) || []),
      ];
      if (!sourceBlock || !rows.length || rows.length > limits.max_surface_occurrences) continue;
      rows.push({ surface: alias.alias, display: alias.evidence, kind: 'source_stated_alias',
        file: alias.source_span.file, line: alias.source_span.start, block_address: sourceBlock.address, block_id: sourceBlock.id });
      addCandidate({
        candidate_kind: 'source_stated_alias', rows,
        signals: [{ kind: 'source_stated_alias', alias: alias.alias, refers_to: alias.refers_to,
          source_span: alias.source_span, evidence: alias.evidence }],
      });
    }
  }

  let authorizedQuery = null;
  if (query_terms.length) {
    const wanted = [...new Set(query_terms.map(norm))].sort();
    const rows = [];
    for (const term of wanted) {
      for (const block of index.byAddress.values()) {
        const offset = block.text.toLocaleLowerCase().indexOf(term);
        if (offset === -1) continue;
        const line = block.start + (block.text.slice(0, offset).match(/\n/g) || []).length;
        rows.push({ surface: term, display: block.text.slice(offset, offset + term.length), kind: 'authorized_query_term', file: block.file, line, block_address: block.address, block_id: block.id });
      }
    }
    const blockAddresses = [...new Set(rows.map(row => row.block_address))].sort();
    if (blockAddresses.length) authorizedQuery = { wanted, rows, blockAddresses };
  }

  if (authorizedQuery) {
    addCandidate({
      candidate_kind: 'authorized_query', rows: authorizedQuery.rows,
      block_addresses: authorizedQuery.blockAddresses,
      signals: [{ kind: 'authorized_query', terms: authorizedQuery.wanted, block_addresses: authorizedQuery.blockAddresses }],
    });
  }
  return [...new Map(candidates.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Campaign preflight. Per-candidate bounds are insufficient when thousands of small candidates
 * exist, so autonomous execution must also fit a declared total candidate/call budget. This
 * function never truncates to an arbitrary first N: an oversized campaign requires a separately
 * justified selection policy or explicit candidate IDs.
 */
export function buildReconciliationCampaignPlan({
  candidates = [], candidate_ids = null, max_candidates = 64, max_expected_calls = 128,
} = {}) {
  const wantedIds = candidate_ids ? new Set(candidate_ids) : null;
  const requested = candidate_ids
    ? candidates.filter(candidate => wantedIds.has(candidate.id))
    : candidates.slice();
  if (candidate_ids && requested.length !== wantedIds.size) {
    throw new ContextReconciliationError('CANDIDATE_FILTER_UNRESOLVED',
      `requested ${wantedIds.size} candidates but resolved ${requested.length}`);
  }
  const ready = requested.filter(candidate => candidate.status === 'ready');
  const expectedCalls = ready.reduce((sum, candidate) => sum + Number(candidate.bounds?.expected_packets || 0), 0);
  const findings = [];
  if (ready.length > max_candidates) findings.push({
    code: 'CAMPAIGN_CANDIDATE_CAP_EXCEEDED', observed: ready.length, maximum: max_candidates,
  });
  if (expectedCalls > max_expected_calls) findings.push({
    code: 'CAMPAIGN_CALL_CAP_EXCEEDED', observed: expectedCalls, maximum: max_expected_calls,
  });
  const body = {
    schema: 'estate-map/reconciliation-campaign-plan/v1',
    status: findings.length ? 'unresolved_due_to_bound' : 'ready',
    selection: candidate_ids ? 'explicit_candidate_ids' : 'all_autonomous_candidates',
    requested_candidates: requested.length,
    ready_candidates: ready.length,
    bounded_refusals: requested.length - ready.length,
    expected_calls: expectedCalls,
    limits: { max_candidates, max_expected_calls },
    findings,
    candidate_ids: findings.length ? [] : ready.map(candidate => candidate.id).sort(),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

function packetWindow({ candidate, blocks, snapshot, ordinal }) {
  const addresses = blocks.map(block => block.address);
  const spans = [];
  for (const block of blocks) {
    const prior = spans.at(-1);
    if (prior && prior.file === block.file && block.start <= prior.end + 1) prior.end = Math.max(prior.end, block.end);
    else spans.push({ file: block.file, start: block.start, end: block.end });
  }
  const identity = { candidate_id: candidate.id, ordinal, addresses, snapshot };
  return Object.freeze({
    id: `reconciliation-window:${sha256(canonical(identity))}`,
    kind: 'joint_evidence_packet',
    file: blocks[0].file,
    primary_spans: spans,
    context_spans: [],
    primary_block_addresses: addresses,
    context_block_addresses: [],
    source_containers: [...new Set(blocks.map(block => block.file))].sort().map(id => ({ kind: 'document', id })),
    primary_bytes: blocks.reduce((sum, block) => sum + block.bytes, 0),
    block_count: blocks.length,
    snapshot,
  });
}

function partitionBlocks(blocks, maxBytes) {
  const packets = [];
  let current = [], bytes = 0;
  for (const block of blocks) {
    if (block.bytes > maxBytes) return null;
    if (current.length && bytes + block.bytes > maxBytes) { packets.push(current); current = []; bytes = 0; }
    current.push(block); bytes += block.bytes;
  }
  if (current.length) packets.push(current);
  return packets;
}

/** Select exact source blocks and activate deterministic bounded recursion only when required. */
export function buildJointPackets({ candidate, prepasses, snapshot, max_packet_bytes = 48 * 1024 }) {
  const index = inventoryIndex(prepasses.map(prepass => prepass.inventory));
  const blocks = candidate.block_addresses.map(address => {
    const block = index.byAddress.get(address);
    if (!block) throw new ContextReconciliationError('UNKNOWN_CANDIDATE_BLOCK', address);
    return block;
  }).sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
  const totalBytes = blocks.reduce((sum, block) => sum + block.bytes, 0);
  const inheritedFindings = Array.isArray(candidate.bound_findings) ? candidate.bound_findings : [];
  const oversizedBlocks = blocks.filter(block => block.bytes > max_packet_bytes)
    .map(block => ({ block_address: block.address, bytes: block.bytes, max_bytes: max_packet_bytes }));
  const boundFindings = [...new Map([
    ...inheritedFindings,
    ...oversizedBlocks.map(detail => ({ code: 'INDIVISIBLE_JOINT_BLOCK_TOO_LARGE', ...detail })),
  ].map(finding => [canonical(finding), finding])).values()];
  if (candidate.status === 'unresolved_due_to_bound' || boundFindings.length) {
    return Object.freeze({
      candidate_id: candidate.id,
      status: 'unresolved_due_to_bound',
      total_bytes: totalBytes,
      max_packet_bytes,
      packets: [],
      findings: boundFindings,
      recursion: { activated: false, recursive_partitions: 0, depth: 0 },
    });
  }
  const partitions = totalBytes <= max_packet_bytes ? [blocks] : partitionBlocks(blocks, max_packet_bytes);
  const packets = partitions.map((part, ordinal) => {
    const window = packetWindow({ candidate, blocks: part, snapshot, ordinal });
    return Object.freeze({
      id: `joint-packet:${sha256(canonical({ candidate_id: candidate.id, ordinal, window_id: window.id }))}`,
      ordinal,
      window,
      catalog: createWindowBlockCatalog({ window, inventories: prepasses.map(prepass => prepass.inventory) }),
      bytes: part.reduce((sum, block) => sum + block.bytes, 0),
    });
  });
  return Object.freeze({
    candidate_id: candidate.id,
    status: 'ready',
    total_bytes: totalBytes,
    max_packet_bytes,
    packets,
    recursion: {
      activated: packets.length > 1,
      recursive_partitions: packets.length > 1 ? packets.length : 0,
      depth: packets.length > 1 ? 1 : 0,
    },
  });
}

export function buildReconciliationPrompt({ candidate, packet, mode = 'combined' }) {
  if (!['combined', 'atomic'].includes(mode)) throw new ContextReconciliationError('INVALID_RECONCILIATION_MODE', mode);
  const queryTerms = candidate.signals.find(signal => signal.kind === 'authorized_query')?.terms || [];
  const lines = [
    mode === 'atomic' ? 'Extract atomic relations from one deterministically selected joint source packet.' : 'Reconcile one deterministically selected joint source packet.',
    `Candidate: ${candidate.id}; packet ${packet.ordinal + 1}.`,
    mode === 'atomic'
      ? 'Source blocks are the only evidence.'
      : 'Source blocks are the only evidence. Return one JSON object.',
    'Outcome must be linked, no_joint_claim, ambiguous_identity, or insufficient_context.',
  ];
  if (mode === 'atomic') lines.push(...flatLineContractLines());
  else lines.push(
    'For linked, return {"outcome":"linked","relations":[<EXACT RELATION OBJECT BELOW>],"links":[<EXACT LINK OBJECT BELOW>],"reason":"..."}.',
    'EXACT RELATION OBJECT (field names, nesting, and enum values are mandatory):',
    '{"subject_mention":{"surface":"<exact source words>","source_locator":{"block_token":"b001","quote":"<exact bytes>","context_before":null,"context_after":null,"occurrence":null}},',
    ' "predicate_family":"...","object_or_value":"...","polarity":"affirmed|negated",',
    ' "modality":"descriptive|normative|historical|constitutive|predictive","quantifier":"...","scope":{},"valid_time":{},',
    ' "support_sets":[{"mode":"all_required|alternative_support","locators":[{"role":"primary|context","source_locator":{"block_token":"b001","quote":"<exact bytes>","context_before":null,"context_after":null,"occurrence":null}}]}]}',
    'FORBIDDEN LEGACY SHAPES: subject_mention as a string; top-level source_locator; file:line range',
    'strings; PRIMARY/SECONDARY roles; positive polarity; proposed modality; support_sets as nested',
    'arrays; spans or coordinates. Any such relation is rejected without repair or redispatch.',
    'Never author coordinates. Quotes under 24 characters require context or occurrence.',
    'Every relation needs a PRIMARY locator. Do not rewrite leaf claims or invent concept identity.',
  );
  if (mode === 'combined') lines.push(
    'EXACT LINK OBJECT: {"from_relation":0,"to_relation":1,"kind":"qualifies|exception_to|depends_on|motivates|prevents|implements",',
    ' "support_locators":[{"role":"primary|context","source_locator":{"block_token":"b001","quote":"<exact bytes>","context_before":null,"context_after":null,"occurrence":null}}]}',
    'Relation references are zero-based indexes into relations[]. A cross-boundary link requires at least',
    'two exact support locators from distinct blocks and at least one PRIMARY locator. When relations',
    'come from different governing blocks, return the explicit link that makes them one rule.',
  );
  lines.push(
    mode === 'atomic' ? 'Emit no links at all. Linking occurs later over frozen validated relation IDs.' : '',
    queryTerms.length ? `AUTHORIZED SYNTHESIS TERMS: ${JSON.stringify(queryTerms)}.` : '',
    queryTerms.length ? 'A linked answer must account for every authorized term through narrow atomic relations and exact evidence.' : '',
    queryTerms.length ? 'Prefer several narrow predicates over one compound paragraph; use all-required multi-block support only when one atomic relation genuinely needs it.' : '',
    mode === 'atomic'
      ? 'For a refusal, return exactly one line: {"k":"head","outcome":"no_joint_claim|ambiguous_identity|insufficient_context","reason":"..."}.'
      : 'For a refusal, return {"outcome":"no_joint_claim|ambiguous_identity|insufficient_context","relations":[],"links":[],"reason":"..."}.',
    '',
    'DETERMINISTIC CANDIDATE SIGNALS:',
    JSON.stringify(candidate.signals),
    '',
    'EXACT JOINT SOURCE:',
    renderBlockCatalog(packet.catalog),
  );
  return lines.join('\n');
}

function reconciliationKey({ candidate, packet, prompt, runner, version, mode }) {
  return sha256(canonical({
    policy: INFERENCE_CUSTODY_POLICY,
    version,
    mode,
    stage: 'joint-reconciliation',
    candidate_id: candidate.id,
    packet_id: packet.id,
    prompt_digest: sha256(prompt),
    model: runner.model,
  }));
}

export function validateRelationLinks({ proposed_links, relation_by_index, packet, candidate, producer_version = RECONCILIATION_VERSION }) {
  const links = [], rejected_links = [], seen = new Set();
  (Array.isArray(proposed_links) ? proposed_links : []).forEach((proposed, index) => {
    const rawLocators = Array.isArray(proposed?.support_locators) ? proposed.support_locators : [];
    const locatorStats = { proposed: rawLocators.length, resolved: 0, failed: 0 };
    const supportLocators = [];
    let locatorError = null;
    for (const item of rawLocators) {
      try {
        const role = String(item?.role || 'primary');
        if (!['primary', 'context'].includes(role)) throw new ContextReconciliationError('INVALID_LINK_LOCATOR_ROLE', role);
        supportLocators.push(Object.freeze({ role, ...resolveSourceLocator({ locator: item.source_locator, catalog: packet.catalog, expected_role: role }) }));
        locatorStats.resolved += 1;
      } catch (error) {
        locatorStats.failed += 1;
        locatorError ||= error;
      }
    }
    supportLocators.sort((a, b) => a.file.localeCompare(b.file) || a.byte_start - b.byte_start || a.id.localeCompare(b.id));
    try {
      const fromIndex = Number(proposed?.from_relation), toIndex = Number(proposed?.to_relation);
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) throw new ContextReconciliationError('INVALID_LINK_ENDPOINTS', 'link endpoints must be distinct relation indexes');
      const from = relation_by_index.get(fromIndex), to = relation_by_index.get(toIndex);
      if (!from || !to) throw new ContextReconciliationError('LINK_ENDPOINT_REJECTED', 'link endpoint relation did not survive validation', { from_relation: fromIndex, to_relation: toIndex });
      const kind = String(proposed.kind || '');
      if (!LINK_KINDS.has(kind)) throw new ContextReconciliationError('INVALID_LINK_KIND', kind);
      if (rawLocators.length < 2) throw new ContextReconciliationError('LINK_NEEDS_TWO_LOCATORS', 'cross-boundary link requires at least two support locators');
      if (locatorError) throw locatorError;
      if (!supportLocators.some(locator => locator.role === 'primary')) throw new ContextReconciliationError('LINK_MISSING_PRIMARY_LOCATOR', 'link requires a primary locator');
      if (new Set(supportLocators.map(locator => locator.block.address)).size < 2) throw new ContextReconciliationError('LINK_NOT_CROSS_BOUNDARY', 'link support must span at least two source blocks');
      const body = {
        schema: RELATION_LINK_SCHEMA,
        authority_plane: 'reconciled_documentary_claim',
        producer: { stage: 'targeted_reconciliation', version: producer_version, candidate_id: candidate.id },
        kind,
        from_relation_id: from.id,
        to_relation_id: to.id,
        support_locators: supportLocators,
        locator_stats: locatorStats,
      };
      const id = `reconciled-link:${sha256(canonical(body))}`;
      if (seen.has(id)) throw new ContextReconciliationError('DUPLICATE_LINK', 'duplicate relation link proposal');
      seen.add(id);
      links.push(Object.freeze({ ...body, id }));
    } catch (error) {
      rejected_links.push({ index, code: error.code || 'INVALID_LINK', detail: error.message, context: error.detail || null, locator_stats: locatorStats });
    }
  });
  return Object.freeze({ links, rejected_links });
}

const countLocatorAttempts = raw => (String(raw ?? '').match(/"source_locator"|"quote"/g) || []).length;

/** Read either one JSON document or a JSON-lines answer; malformed lines survive as entries. */
function readRelationPayload(result) {
  const stream = parseModelJsonStream(result.text || '');
  if (!stream?.header) return null;
  if (stream.mode === 'stream') return { header: stream.header, entries: stream.entries, streamed: true };
  const relations = Array.isArray(stream.header.relations) ? stream.header.relations : null;
  return { header: stream.header, entries: relations?.map((value, index) => ({ index, ok: true, value })) ?? null, streamed: false };
}

async function reconcilePacket({ candidate, packet, namespace, runner, checkpoint, budget, mode, version }) {
  const prompt = buildReconciliationPrompt({ candidate, packet, mode });
  const completion = await runCustodiedInference({
    checkpoint,
    stage: mode === 'atomic' ? 'context-atomic-reconciliation' : 'context-reconciliation',
    key: reconciliationKey({ candidate, packet, prompt, runner, version, mode }),
    tag: `reconcile:${candidate.id}:${packet.ordinal}`,
    prompt,
    runner,
    budget,
    validate: result => {
      const payload = readRelationPayload(result);
      if (!payload) return { ok: false, reason: 'reconciler did not return a parseable outcome object' };
      const parsed = payload.header;
      const outcome = String(parsed.outcome || '');
      if (REFUSALS.has(outcome)) return { ok: true, value: { outcome, reason: String(parsed.reason || ''), relations: [], links: [], rejected: [], rejected_links: [] } };
      if (outcome !== 'linked' || !payload.entries) return { ok: false, reason: 'invalid reconciliation outcome/relations' };
      const assembled = mode === 'atomic'
        ? parseFlatRelationAnswer(result.text || '')
        : { proposals: payload.entries.filter(entry => entry.ok).map(entry => ({ index: entry.index, proposed: entry.value })),
            rejected: payload.entries.filter(entry => !entry.ok).map(entry => ({ index: entry.index, code: 'MALFORMED_RELATION_LINE', detail: entry.error, locator_stats: { proposed: countLocatorAttempts(entry.raw), resolved: 0, failed: countLocatorAttempts(entry.raw) } })) };
      const relations = [], rejected = [...assembled.rejected], relationByIndex = new Map();
      assembled.proposals.forEach(({ index, proposed }) => {
        try {
          const claim = buildClaimV32({
            proposed,
            window: packet.window,
            catalog: packet.catalog,
            namespace,
            model_identifier: runner.model,
            prompt_digest: sha256(prompt),
          });
          const relation = Object.freeze({
            ...claim,
            authority_plane: 'reconciled_documentary_claim',
            producer: { stage: 'targeted_reconciliation', version, candidate_id: candidate.id },
          });
          relations.push(relation);
          relationByIndex.set(index, relation);
        } catch (error) {
          rejected.push({ index, code: error.code || 'INVALID_RELATION', detail: error.message, locator_stats: error.detail?.locator_stats || null });
        }
      });
      const validatedLinks = mode === 'atomic'
        ? {
            links: [],
            rejected_links: (Array.isArray(parsed.links) ? parsed.links : []).map((link, index) => ({
              index,
              code: 'ATOMIC_MODE_FORBIDS_LINKS',
              detail: 'atomic extraction cannot emit relation links',
              context: null,
              locator_stats: { proposed: Array.isArray(link?.support_locators) ? link.support_locators.length : 0, resolved: 0, failed: Array.isArray(link?.support_locators) ? link.support_locators.length : 0 },
            })),
          }
        : validateRelationLinks({
            proposed_links: parsed.links,
            relation_by_index: relationByIndex,
            packet,
            candidate,
            producer_version: version,
          });
      if (!relations.length) return { ok: true, value: { outcome: 'insufficient_context', reason: 'no valid exact-locator relation survived', relations: [], links: [], rejected, rejected_links: validatedLinks.rejected_links } };
      return { ok: true, value: { outcome, reason: String(parsed.reason || ''), relations, links: validatedLinks.links, rejected, rejected_links: validatedLinks.rejected_links } };
    },
  });
  if (completion.incomplete) return { packet_id: packet.id, outcome: 'incomplete', relations: [], links: [], rejected: [], rejected_links: [], incomplete: completion.incomplete };
  return { packet_id: packet.id, ...completion.validated, incomplete: null };
}

function buildDeterministicComposition(candidate, packetResults) {
  const relationIds = packetResults.flatMap(result => result.relations.map(relation => relation.id)).sort();
  if (relationIds.length < 2) return null;
  const body = {
    schema: 'estate-map/reconciled-composition/v1',
    authority_plane: 'reconciled_documentary_claim',
    producer: 'bounded_recursive_composer',
    candidate_id: candidate.id,
    member_relation_ids: relationIds,
    rule: 'validated leaf relations remain linked through their shared deterministic candidate; no new proposition is inferred',
  };
  return Object.freeze({ ...body, id: `reconciled-composition:${sha256(canonical(body))}` });
}

/** Run one candidate with single-dispatch custody per packet. No automatic retry exists here. */
export async function runTargetedReconciliation({ candidate, joint, namespace, runner, checkpoint, budget, mode = 'combined' }) {
  if (!['combined', 'atomic'].includes(mode)) throw new ContextReconciliationError('INVALID_RECONCILIATION_MODE', mode);
  const version = mode === 'atomic' ? ATOMIC_RECONCILIATION_VERSION : RECONCILIATION_VERSION;
  if (joint.status === 'unresolved_due_to_bound') {
    const body = {
      schema: RECONCILIATION_RESULT_SCHEMA,
      version,
      candidate_id: candidate.id,
      recursion: joint.recursion,
      packet_results: [],
      composition: null,
      relations: [],
      links: [],
      findings: joint.findings || [],
      status: 'unresolved_due_to_bound',
    };
    return Object.freeze({ ...body, digest: sha256(canonical(body)) });
  }
  const packetResults = [];
  for (const packet of joint.packets) packetResults.push(await reconcilePacket({ candidate, packet, namespace, runner, checkpoint, budget, mode, version }));
  const composition = joint.recursion.activated ? buildDeterministicComposition(candidate, packetResults) : null;
  const body = {
    schema: RECONCILIATION_RESULT_SCHEMA,
    version,
    candidate_id: candidate.id,
    recursion: joint.recursion,
    packet_results: packetResults,
    composition,
    relations: packetResults.flatMap(result => result.relations).sort((a, b) => a.id.localeCompare(b.id)),
    links: packetResults.flatMap(result => result.links || []).sort((a, b) => a.id.localeCompare(b.id)),
    status: packetResults.some(result => result.incomplete) ? 'incomplete' : 'complete',
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}
