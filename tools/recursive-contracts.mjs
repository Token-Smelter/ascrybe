// Scale-compatible, model-neutral contracts for recursive semantic mapping.
// Source blocks and exact spans are authoritative; plans, claims, bundles, and projections are derived.
import { sha256, stableStringify } from './lib.mjs';

export const EVIDENCE_REGION_SCHEMA = 'estate-map/evidence-region/v1';
export const PLANNING_HYPOTHESIS_SCHEMA = 'estate-map/planning-hypothesis/v1';
export const DOCUMENTARY_CLAIM_V3_SCHEMA = 'estate-map/documentary-claim/v3';
export const MAP_BUNDLE_SCHEMA = 'estate-map/map-bundle/v1';
export const ALIAS_LEDGER_SCHEMA = 'estate-map/source-alias-ledger/v1';
export const MAX_REGION_CHILDREN = 6;
export const DEFAULT_ATOMIC_PRIMARY_BYTES = 48 * 1024;
export const DEFAULT_OVERLAP_EPSILON = 0.10;

const text = value => String(value ?? '');
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const uniq = values => [...new Set(values)];
const canonicalJson = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonicalJson(value))}`;
const orderRefs = (left, right) => left.file.localeCompare(right.file) || left.start - right.start || left.end - right.end || left.block_id.localeCompare(right.block_id);
const roleOrder = role => role === 'primary' ? 0 : 1;
const orderSpans = (left, right) => roleOrder(left.role) - roleOrder(right.role) || left.file.localeCompare(right.file) || left.start - right.start || left.end - right.end;

export class RecursiveContractError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'RecursiveContractError';
    this.code = code;
    this.detail = detail;
  }
}

function physicalLines(content) {
  const source = text(content);
  if (!source) return [];
  const raw = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  let byte = 0;
  return raw.map((line, index) => {
    const start = byte;
    byte += Buffer.byteLength(line, 'utf8');
    const withoutLf = line.endsWith('\n') ? line.slice(0, -1) : line;
    const visible = withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf;
    return { number: index + 1, raw: line, text: visible, byte_start: start, byte_end: byte };
  });
}

const headingMatch = line => /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
const fenceMatch = line => /^\s*(`{3,}|~{3,})/.exec(line);
const isBlank = line => /^\s*$/.test(line);
const isList = line => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
const isThematic = line => /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const looksTable = (lines, index) => {
  const current = lines[index]?.text || '';
  const next = lines[index + 1]?.text || '';
  return current.includes('|') && /^\s*\|?\s*:?-{3,}/.test(next) && next.includes('|');
};

function blockTypeAt(lines, index) {
  const line = lines[index]?.text || '';
  if (isBlank(line)) return 'separator';
  if (headingMatch(line)) return 'heading';
  if (fenceMatch(line)) return 'code';
  if (isThematic(line)) return 'separator';
  if (isList(line)) return 'list';
  if (looksTable(lines, index) || /^\s*\|.*\|\s*$/.test(line)) return 'table';
  return 'paragraph';
}

/** Deterministic, lossless Markdown block inventory. Concatenating block.raw reproduces source bytes. */
export function inventoryMarkdown({ path, content, source_sha = null, corpus_digest = null }) {
  if (!nonblank(path)) throw new RecursiveContractError('INVALID_PATH', 'inventory requires a path');
  const source = text(content);
  const lines = physicalLines(source);
  const blocks = [];
  const headingStack = [];
  let index = 0;

  const push = (type, startIndex, endIndex) => {
    const selected = lines.slice(startIndex, endIndex + 1);
    const raw = selected.map(line => line.raw).join('');
    const first = selected[0], last = selected[selected.length - 1];
    const heading = type === 'heading' ? headingMatch(first.text) : null;
    if (heading) {
      const level = heading[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: heading[2].trim() });
    }
    const body = {
      file: path,
      index: blocks.length,
      type,
      start: first.number,
      end: last.number,
      byte_start: first.byte_start,
      byte_end: last.byte_end,
      bytes: last.byte_end - first.byte_start,
      digest: sha256(raw),
      heading_ancestry: headingStack.map(item => item.text),
    };
    const id = hashId('block', body);
    blocks.push({ ...body, id, address: `${path}@${body.index}`, raw, text: raw.endsWith('\n') ? raw.slice(0, -1) : raw });
  };

  // Front matter is a distinct block only when it starts at line 1 and has a closing delimiter.
  if (lines[0]?.text.trim() === '---') {
    let close = 1;
    while (close < lines.length && lines[close].text.trim() !== '---') close += 1;
    if (close < lines.length) { push('front_matter', 0, close); index = close + 1; }
  }

  while (index < lines.length) {
    const type = blockTypeAt(lines, index);
    let end = index;
    if (type === 'heading' || (type === 'separator' && isThematic(lines[index].text))) {
      end = index;
    } else if (type === 'code') {
      const opening = fenceMatch(lines[index].text)[1];
      const marker = opening[0], minimum = opening.length;
      end = index + 1;
      while (end < lines.length && !(new RegExp(`^\\s*${marker}{${minimum},}\\s*$`)).test(lines[end].text)) end += 1;
      if (end >= lines.length) end = lines.length - 1;
    } else if (type === 'separator') {
      while (end + 1 < lines.length && isBlank(lines[end + 1].text)) end += 1;
    } else if (type === 'table') {
      while (end + 1 < lines.length && !isBlank(lines[end + 1].text) && lines[end + 1].text.includes('|')) end += 1;
    } else if (type === 'list') {
      while (end + 1 < lines.length) {
        const next = lines[end + 1].text;
        if (isBlank(next) || headingMatch(next) || fenceMatch(next) || isThematic(next) || looksTable(lines, end + 1)) break;
        if (isList(next) || /^\s{2,}\S/.test(next)) end += 1;
        else break;
      }
    } else {
      while (end + 1 < lines.length && blockTypeAt(lines, end + 1) === 'paragraph') end += 1;
    }
    push(type, index, end);
    index = end + 1;
  }

  const reconstructed = blocks.map(block => block.raw).join('');
  if (reconstructed !== source) throw new RecursiveContractError('INVENTORY_NOT_LOSSLESS', `block inventory did not reconstruct ${path}`);
  return Object.freeze({
    schema: 'estate-map/markdown-block-inventory/v1',
    path,
    source_sha,
    corpus_digest,
    source_digest: sha256(source),
    bytes: Buffer.byteLength(source, 'utf8'),
    lines: lines.length,
    blocks: Object.freeze(blocks),
  });
}

export function inventoryIndex(inventories) {
  const list = inventories instanceof Map ? [...inventories.values()] : Array.isArray(inventories) ? inventories : Object.values(inventories || {});
  const byAddress = new Map(), byPath = new Map();
  for (const inventory of list) {
    byPath.set(inventory.path, inventory);
    for (const block of inventory.blocks) {
      if (byAddress.has(block.address)) throw new RecursiveContractError('DUPLICATE_BLOCK_ADDRESS', block.address);
      byAddress.set(block.address, block);
    }
  }
  return { inventories: list, byAddress, byPath };
}

function resolveBlockRefs(addresses, index, field) {
  const refs = uniq(addresses || []).map(address => {
    const block = index.byAddress.get(address);
    if (!block) throw new RecursiveContractError('UNKNOWN_BLOCK', `${field} cites unknown block ${address}`);
    return { file: block.file, block_id: block.id, address: block.address, start: block.start, end: block.end, bytes: block.bytes, digest: block.digest };
  }).sort(orderRefs);
  return refs;
}

function mergeBlockSpans(refs) {
  const spans = [];
  for (const ref of refs.slice().sort(orderRefs)) {
    const prior = spans[spans.length - 1];
    if (prior && prior.file === ref.file && ref.start <= prior.end + 1) {
      prior.end = Math.max(prior.end, ref.end);
      prior.block_ids.push(ref.block_id);
      prior.addresses.push(ref.address);
      continue;
    }
    spans.push({ file: ref.file, start: ref.start, end: ref.end, block_ids: [ref.block_id], addresses: [ref.address] });
  }
  return spans;
}

export function createEvidenceRegion({ inventories, primary_block_addresses, context_block_addresses = [], parent_id = null, depth = 0, status = 'planned', split_reason = null, snapshot = null }) {
  const index = inventoryIndex(inventories);
  const primary = resolveBlockRefs(primary_block_addresses, index, 'primary');
  const context = resolveBlockRefs(context_block_addresses, index, 'context');
  if (!primary.length) throw new RecursiveContractError('EMPTY_PRIMARY_REGION', 'region requires at least one primary block');
  const primarySet = new Set(primary.map(ref => ref.address));
  const contextOnly = context.filter(ref => !primarySet.has(ref.address));
  const snap = snapshot || { source_sha: index.inventories[0]?.source_sha ?? null, corpus_digest: index.inventories[0]?.corpus_digest ?? null };
  const identity = {
    schema: EVIDENCE_REGION_SCHEMA,
    snapshot: snap,
    primary: primary.map(ref => ({ file: ref.file, start: ref.start, end: ref.end, digest: ref.digest })),
    context: contextOnly.map(ref => ({ file: ref.file, start: ref.start, end: ref.end, digest: ref.digest })),
  };
  const id = hashId('region', identity);
  return Object.freeze({
    schema: EVIDENCE_REGION_SCHEMA,
    id,
    parent_id,
    depth,
    region_order_key: primary.map(ref => [ref.file, ref.start, ref.end]),
    source_containers: uniq(primary.concat(contextOnly).map(ref => ref.file)).map(id_ => ({ kind: 'document', id: id_ })),
    primary_block_addresses: primary.map(ref => ref.address),
    context_block_addresses: contextOnly.map(ref => ref.address),
    primary_spans: mergeBlockSpans(primary),
    context_spans: mergeBlockSpans(contextOnly),
    primary_bytes: primary.reduce((sum, ref) => sum + ref.bytes, 0),
    context_bytes: contextOnly.reduce((sum, ref) => sum + ref.bytes, 0),
    heading_ancestry: uniq(primary.flatMap(ref => index.byAddress.get(ref.address).heading_ancestry || [])),
    status,
    split_reason,
    snapshot: snap,
  });
}

export function rootEvidenceRegion(inventory, snapshot = null) {
  return createEvidenceRegion({ inventories: [inventory], primary_block_addresses: inventory.blocks.map(block => block.address), snapshot });
}

export function sourceSlice(inventory, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > inventory.lines) {
    throw new RecursiveContractError('INVALID_SOURCE_SPAN', `${inventory.path}:${start}-${end} is outside source`, { path: inventory.path, start, end, lines: inventory.lines });
  }
  const lines = physicalLines(inventory.blocks.map(block => block.raw).join(''));
  const raw = lines.slice(start - 1, end).map(line => line.raw).join('');
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

export function renderRegionEvidence(region, inventories) {
  const index = inventoryIndex(inventories);
  const render = (role, addresses) => addresses.map(address => {
    const block = index.byAddress.get(address);
    return [`[${role.toUpperCase()} ${block.file}:${block.start}-${block.end} ${address}]`, block.text].join('\n');
  }).join('\n\n');
  return [render('primary', region.primary_block_addresses), render('context', region.context_block_addresses)].filter(Boolean).join('\n\n');
}

export function conservationReceipt({ parent, children, excluded_block_addresses = [], overlap_epsilon = DEFAULT_OVERLAP_EPSILON }) {
  const parentSet = new Set(parent.primary_block_addresses);
  const excluded = new Set(excluded_block_addresses);
  const counts = new Map();
  for (const child of children || []) for (const address of child.primary_block_addresses) counts.set(address, (counts.get(address) || 0) + 1);
  const missing = [...parentSet].filter(address => !counts.has(address) && !excluded.has(address)).sort();
  const foreign = [...counts.keys()].filter(address => !parentSet.has(address)).sort();
  const excludedForeign = [...excluded].filter(address => !parentSet.has(address)).sort();
  const childBytes = (children || []).reduce((sum, child) => sum + Number(child.primary_bytes || 0), 0);
  const overlapRatio = parent.primary_bytes ? Math.max(0, childBytes - parent.primary_bytes) / parent.primary_bytes : 0;
  const nonShrinking = (children || []).filter(child => child.primary_bytes >= parent.primary_bytes).map(child => child.id);
  return Object.freeze({
    schema: 'estate-map/source-span-conservation/v1',
    parent_region_id: parent.id,
    child_region_ids: (children || []).map(child => child.id).sort(),
    excluded_block_addresses: [...excluded].sort(),
    missing,
    foreign,
    excluded_foreign: excludedForeign,
    overlap_ratio: Number(overlapRatio.toFixed(6)),
    overlap_epsilon,
    non_shrinking_children: nonShrinking.sort(),
    valid: missing.length === 0 && foreign.length === 0 && excludedForeign.length === 0 && overlapRatio <= overlap_epsilon && nonShrinking.length === 0,
  });
}

export function createPlanningHypothesis({ region, proposed, model_identifier, prompt_digest, inventories, atomic_primary_bytes = DEFAULT_ATOMIC_PRIMARY_BYTES, max_children = MAX_REGION_CHILDREN, max_depth = 2 }) {
  if (!proposed || !['atomic', 'split', 'unresolved'].includes(proposed.outcome)) throw new RecursiveContractError('INVALID_PLAN_OUTCOME', 'plan outcome must be atomic, split, or unresolved');
  const availableAddresses = new Set(region.primary_block_addresses.concat(region.context_block_addresses));
  // ADVISORY vs LOAD-BEARING. Concept anchors are hypothesis annotation: they can never ground a
  // claim, so an unresolvable anchor is RECORDED as unresolved and dropped, never fatal. Child
  // partitions decide what gets extracted and whether source coverage conserves, so they stay
  // fail-closed below. Applying partition strictness to annotation halted a paid run on a
  // two-character transcription slip while the partition itself was exactly correct.
  const droppedAnchors = [];
  const concepts = Array.isArray(proposed.concept_candidates) ? proposed.concept_candidates.map(candidate => {
    const requested = uniq(candidate.anchor_block_addresses || []);
    const resolved = requested.filter(address => availableAddresses.has(address));
    for (const address of requested.filter(address => !availableAddresses.has(address))) droppedAnchors.push(address);
    return { term: text(candidate.term).trim(), anchor_block_addresses: resolved.sort() };
  }).filter(candidate => candidate.term).sort((a, b) => a.term.localeCompare(b.term) || canonicalJson(a.anchor_block_addresses).localeCompare(canonicalJson(b.anchor_block_addresses))) : [];
  const unresolvedAnchors = uniq(droppedAnchors.concat(proposed.unresolved_anchor_references || [])).sort();
  const base = {
    schema: PLANNING_HYPOTHESIS_SCHEMA,
    region_id: region.id,
    outcome: proposed.outcome,
    reason: text(proposed.reason).trim(),
    concept_candidates: concepts,
    dependency_suggestions: Array.isArray(proposed.dependency_suggestions) ? proposed.dependency_suggestions.slice().sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) : [],
    unresolved_questions: Array.isArray(proposed.unresolved_questions) ? uniq(proposed.unresolved_questions.map(text)).sort() : [],
    unresolved_anchor_references: unresolvedAnchors,
    model_identifier,
    prompt_digest,
    status: 'provisional',
  };
  if (proposed.outcome === 'atomic') {
    // An oversized `atomic` proposal is clamped, not fatal. A region can be genuinely indivisible
    // (a single oversized block, e.g. a large table or code fence) yet still exceed the atomic
    // bound, in which case NO outcome is lawful: atomic is refused and split is impossible. The
    // honest terminal state is `unresolved`, recorded. Letting it through instead would build an
    // extraction prompt above the hard prompt ceiling and kill the run later anyway.
    if (region.primary_bytes > atomic_primary_bytes) {
      const clamped = {
        ...base,
        outcome: 'unresolved',
        bound_clamp: { from: 'atomic', to: 'unresolved', bound: 'atomic_region_too_large', primary_bytes: region.primary_bytes, atomic_primary_bytes, primary_blocks: region.primary_block_addresses.length },
        proposed_children: [],
      };
      return { hypothesis: Object.freeze({ ...clamped, digest: sha256(canonicalJson(clamped)) }), children: [], conservation: null };
    }
    return { hypothesis: Object.freeze({ ...base, proposed_children: [], digest: sha256(canonicalJson(base)) }), children: [], conservation: null };
  }
  if (proposed.outcome === 'unresolved') return { hypothesis: Object.freeze({ ...base, proposed_children: [], digest: sha256(canonicalJson(base)) }), children: [], conservation: null };
  // BOUNDS CLAMP, NOT ABORT. Depth is OUR bound, not a model error: plan §6.4 makes deterministic
  // recursion bounds a termination guarantee and `unresolved` a valid terminal state. A split
  // proposed at max depth is therefore clamped — to `atomic` when the region still fits one
  // interpretive frame (preserving extractable coverage), otherwise to `unresolved` — and the
  // clamp is recorded. Aborting a paid run because our own bound was reached destroys work the
  // model already produced and paid for.
  if (region.depth >= max_depth) {
    const fitsAtomic = region.primary_bytes <= atomic_primary_bytes;
    const clamped = {
      ...base,
      outcome: fitsAtomic ? 'atomic' : 'unresolved',
      bound_clamp: { from: 'split', to: fitsAtomic ? 'atomic' : 'unresolved', bound: 'max_depth', max_depth, region_depth: region.depth, primary_bytes: region.primary_bytes, atomic_primary_bytes },
      proposed_children: [],
    };
    return { hypothesis: Object.freeze({ ...clamped, digest: sha256(canonicalJson(clamped)) }), children: [], conservation: null };
  }
  const specs = Array.isArray(proposed.children) ? proposed.children : [];
  if (specs.length < 2 || specs.length > max_children) throw new RecursiveContractError('INVALID_CHILD_COUNT', `split requires 2..${max_children} children`);
  const foreignChildAddresses = specs.flatMap(spec => (spec.primary_block_addresses || []).concat(spec.context_block_addresses || [])).filter(address => !availableAddresses.has(address));
  if (foreignChildAddresses.length) throw new RecursiveContractError('FOREIGN_CHILD_EVIDENCE', 'child cites evidence outside parent region', { addresses: uniq(foreignChildAddresses).sort() });
  const childPairs = specs.map(spec => ({ spec, child: createEvidenceRegion({
    inventories,
    primary_block_addresses: spec.primary_block_addresses,
    context_block_addresses: spec.context_block_addresses || [],
    parent_id: region.id,
    depth: region.depth + 1,
    status: 'planned',
    split_reason: text(proposed.reason).trim() || 'heterogeneous_evidence',
    snapshot: region.snapshot,
  }) })).sort((a, b) => canonicalJson(a.child.region_order_key).localeCompare(canonicalJson(b.child.region_order_key)));
  const children = childPairs.map(pair => pair.child);
  const conservation = conservationReceipt({ parent: region, children });
  if (!conservation.valid) throw new RecursiveContractError('INVALID_PLAN_CONSERVATION', `plan does not conserve ${region.id}`, conservation);
  // A child that lands oversized at max depth is NOT fatal either: the driver terminates it as
  // unresolved without spending a call on a region whose only lawful outcome is unresolved.
  const proposedChildren = childPairs.map(({ child, spec }) => ({
    region_id: child.id,
    label: text(spec?.label).trim() || null,
    primary_block_addresses: child.primary_block_addresses,
    context_block_addresses: child.context_block_addresses,
  }));
  const body = { ...base, proposed_children: proposedChildren };
  return { hypothesis: Object.freeze({ ...body, digest: sha256(canonicalJson(body)) }), children, conservation };
}

const allowedModalities = new Set(['descriptive', 'normative', 'historical', 'constitutive', 'predictive']);
const allowedPolarities = new Set(['affirmed', 'negated']);
const allowedReferents = new Set(['resolved', 'unresolved']);
const canonicalRefPattern = /^(?:component|protocol|schema|state|command|record|concept|entity):[a-z0-9][a-z0-9._/-]*$/;

function spanWithin(span, regionSpans) {
  return regionSpans.some(allowed => allowed.file === span.file && span.start >= allowed.start && span.end <= allowed.end);
}

export function buildDocumentaryClaimV3({ proposed, region, inventories, model_identifier, prompt_digest, planning_hypothesis_digest = null }) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new RecursiveContractError('INVALID_CLAIM', 'claim proposal must be an object');
  let referentStatus = text(proposed.referent_status).trim();
  if (!allowedReferents.has(referentStatus)) throw new RecursiveContractError('INVALID_REFERENT_STATUS', referentStatus);
  let subjectRef = text(proposed.subject_ref).trim().toLowerCase();
  // A non-canonical referent is NOT an invalid claim; it is an UNRESOLVED one. Downgrading keeps
  // the claim's predicate, object, scope and source spans while still refusing to invent identity
  // (alignment still requires exact canonical form or a source-cited alias). Throwing instead
  // discarded whole priced extractions where the model wrote a bare word like "state".
  let referentNormalizedFrom = null;
  if (referentStatus === 'resolved' && !canonicalRefPattern.test(subjectRef)) {
    referentNormalizedFrom = subjectRef || null;
    referentStatus = 'unresolved';
  }
  if (referentStatus === 'unresolved') subjectRef = null;
  const modality = text(proposed.modality).trim();
  const polarity = text(proposed.polarity).trim();
  if (!allowedModalities.has(modality)) throw new RecursiveContractError('INVALID_MODALITY', modality);
  if (!allowedPolarities.has(polarity)) throw new RecursiveContractError('INVALID_POLARITY', polarity);
  if (!nonblank(text(proposed.predicate_family)) || !Object.hasOwn(proposed, 'object_or_value')) throw new RecursiveContractError('MISSING_CLAIM_FIELDS', 'predicate_family and object_or_value are required');
  const index = inventoryIndex(inventories);
  const sourceSpans = (Array.isArray(proposed.source_spans) ? proposed.source_spans : []).map(span => ({
    role: text(span.role).trim(), file: text(span.file).trim(), start: Number(span.start), end: Number(span.end),
  })).sort(orderSpans);
  if (!sourceSpans.length || !sourceSpans.some(span => span.role === 'primary')) throw new RecursiveContractError('MISSING_PRIMARY_SPAN', 'claim requires at least one primary source span');
  const excerpts = sourceSpans.map(span => {
    if (!['primary', 'context'].includes(span.role)) throw new RecursiveContractError('INVALID_SPAN_ROLE', span.role);
    const allowed = span.role === 'primary' ? region.primary_spans : region.context_spans;
    if (!spanWithin(span, allowed)) throw new RecursiveContractError('SPAN_OUTSIDE_REGION_ROLE', `${span.role} span ${span.file}:${span.start}-${span.end} is outside region custody`);
    const inventory = index.byPath.get(span.file);
    if (!inventory) throw new RecursiveContractError('UNKNOWN_SOURCE_FILE', span.file);
    return { ...span, text: sourceSlice(inventory, span.start, span.end), source_digest: inventory.source_digest };
  });
  const semantic = {
    subject_refs: [{
      ref: subjectRef,
      kind: referentStatus === 'unresolved' ? 'unresolved' : (text(proposed.subject_kind).trim() || 'concept'),
      referent_status: referentStatus,
      unresolved_label: referentStatus === 'unresolved' ? (text(proposed.unresolved_subject).trim() || referentNormalizedFrom || null) : null,
      referent_normalized_from: referentNormalizedFrom,
    }],
    predicate_family: text(proposed.predicate_family).trim(),
    object_or_value: proposed.object_or_value,
    polarity,
    modality,
    quantifier: text(proposed.quantifier).trim() || 'unspecified',
    scope: proposed.scope && typeof proposed.scope === 'object' && !Array.isArray(proposed.scope) ? proposed.scope : {},
    valid_time: proposed.valid_time && typeof proposed.valid_time === 'object' && !Array.isArray(proposed.valid_time) ? proposed.valid_time : {},
    referent_status: referentStatus,
    source_sha: region.snapshot?.source_sha ?? null,
    corpus_digest: region.snapshot?.corpus_digest ?? null,
    source_spans: sourceSpans,
    provenance: {
      document_id: uniq(sourceSpans.map(span => span.file)).join(' + '),
      source_excerpts: excerpts,
      spans: sourceSpans,
      source_sha: region.snapshot?.source_sha ?? null,
      corpus_digest: region.snapshot?.corpus_digest ?? null,
      region_id: region.id,
      planning_hypothesis_digest,
    },
  };
  const identity = { schema: DOCUMENTARY_CLAIM_V3_SCHEMA, semantic, model_identifier, prompt_digest };
  const record = {
    schema: DOCUMENTARY_CLAIM_V3_SCHEMA,
    id: hashId('claim-v3', identity),
    semantic,
    extraction: { model_identifier, prompt_digest, region_id: region.id, planning_hypothesis_digest },
  };
  record.claim_dedup_key = claimDedupKey(record);
  return Object.freeze(record);
}

export function claimDedupKey(claim) {
  const semantic = claim?.semantic || claim || {};
  const subject = semantic.subject_refs?.[0] || {};
  const primary = (semantic.source_spans || []).filter(span => span.role === 'primary').slice().sort(orderSpans);
  return sha256(canonicalJson({
    subject_ref: subject.ref ?? null,
    referent_status: semantic.referent_status ?? subject.referent_status ?? 'unresolved',
    predicate_family: semantic.predicate_family,
    object_or_value: semantic.object_or_value,
    polarity: semantic.polarity,
    modality: semantic.modality,
    quantifier: semantic.quantifier,
    scope: semantic.scope,
    valid_time: semantic.valid_time,
    primary_source_spans: primary,
  }));
}

export function reduceDuplicateClaims(claims) {
  const groups = new Map();
  for (const claim of claims || []) {
    const key = claim.claim_dedup_key || claimDedupKey(claim);
    const group = groups.get(key) || [];
    group.push(claim);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const canonical = group.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    return Object.freeze({
      ...canonical,
      claim_dedup_key: key,
      extraction_provenance: group.map(claim => ({ claim_id: claim.id, ...claim.extraction })).sort((a, b) => a.claim_id.localeCompare(b.claim_id)),
    });
  });
}

export function createAliasLedger(entries = []) {
  const normalized = entries.map(entry => {
    const alias = text(entry.alias).trim().toLowerCase();
    const canonical_ref = text(entry.canonical_ref).trim().toLowerCase();
    if (!alias || !canonicalRefPattern.test(canonical_ref)) throw new RecursiveContractError('INVALID_ALIAS_ENTRY', 'alias and canonical_ref are required');
    if (!Array.isArray(entry.source_spans) || !entry.source_spans.length) throw new RecursiveContractError('UNSOURCED_ALIAS', alias);
    return { alias, canonical_ref, source_spans: entry.source_spans.slice().sort(orderSpans), accepted_by: entry.accepted_by || 'human' };
  }).sort((a, b) => a.alias.localeCompare(b.alias) || a.canonical_ref.localeCompare(b.canonical_ref));
  return Object.freeze({ schema: ALIAS_LEDGER_SCHEMA, entries: normalized, digest: sha256(canonicalJson(normalized)) });
}

export function alignSubjectRefs(leftClaim, rightClaim, aliasLedger = createAliasLedger()) {
  const canonicalize = claim => {
    const subject = claim?.semantic?.subject_refs?.[0] || {};
    if ((claim?.semantic?.referent_status || subject.referent_status) !== 'resolved' || !subject.ref) return null;
    const direct = text(subject.ref).toLowerCase();
    const alias = aliasLedger.entries.find(entry => entry.alias === direct);
    return alias?.canonical_ref || direct;
  };
  const left = canonicalize(leftClaim), right = canonicalize(rightClaim);
  return Object.freeze({ aligned: Boolean(left && right && left === right), left, right, rule: left && right && left === right ? 'exact_or_source_alias' : 'unresolved_or_distinct' });
}

export function createMapBundle({ region, planning_hypotheses = [], claims = [], child_bundles = [], disagreement_cases = [], unresolved_questions = [] }) {
  const reducedClaims = reduceDuplicateClaims(claims.concat(child_bundles.flatMap(bundle => bundle.claims || [])));
  const entities = [...new Set(reducedClaims.map(claim => claim.semantic?.subject_refs?.[0]?.ref).filter(Boolean))].sort().map(ref => ({ ref, claim_ids: reducedClaims.filter(claim => claim.semantic?.subject_refs?.[0]?.ref === ref).map(claim => claim.id).sort() }));
  const body = {
    schema: MAP_BUNDLE_SCHEMA,
    region_id: region.id,
    planning_hypotheses: planning_hypotheses.slice().sort((a, b) => a.digest.localeCompare(b.digest)),
    claims: reducedClaims,
    entities,
    relations: [],
    disagreement_cases: disagreement_cases.slice().sort((a, b) => text(a.id).localeCompare(text(b.id))),
    unresolved_questions: uniq(unresolved_questions).sort(),
    child_bundle_ids: child_bundles.map(bundle => bundle.id).sort(),
    projection_status: 'derived_non_authoritative',
  };
  return Object.freeze({ ...body, id: hashId('bundle', body), digest: sha256(canonicalJson(body)) });
}

export function canonicalRegionOrder(regions) {
  return regions.slice().sort((a, b) => canonicalJson(a.region_order_key).localeCompare(canonicalJson(b.region_order_key)) || a.id.localeCompare(b.id));
}
