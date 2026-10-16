#!/usr/bin/env node
// Bounded pass-2 characterization over deterministic proposition obligations.
//
// The model selects candidate-local subject handles and authors only semantic fields. The tool owns
// every evidence locator, then feeds the synthesized proposal through the unchanged v28 validator
// and strict semantic guards. Each candidate receives an execution receipt; abstention is always
// `abstained_unverified`, never evidence that the source contains no claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from './custodied-inference.mjs';
import { createPiRpcRunner, createMockModelRunner, PI_RPC_RUNNER_IMPLEMENTATION } from './neural-model-runner.mjs';
import { createUnitQueue, runQueue } from './unit-queue.mjs';
import { normalizeAttemptPolicy, MATERIALIZATION_ATTEMPT_CUSTODY_POLICY } from './materialization-ledger.mjs';
import { buildMentionNamespace, prepassDocument } from './source-prepass.mjs';
import { createWindowBlockCatalog } from './source-locator.mjs';
import { serializeFlatRelationAnswer } from './flat-relation-lines.mjs';
import { validateWindowResponse } from './wide-context-extractor.mjs';
import { reduceClaimsV33, claimQualityMetricsV33 } from './claim-v33.mjs';
import {
  buildCoverageReceipt, isUnsafePredicateActorSurface, PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
} from './proposition-obligations.mjs';
import { installGracefulStop } from './graceful-stop.mjs';
import { sha256, stableStringify } from './lib.mjs';

const execFileAsync = promisify(execFile);
const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const exactIndexes = (source, needle) => {
  const rows = [];
  let cursor = 0;
  while (needle && cursor <= source.length - needle.length) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) break;
    rows.push(index);
    cursor = index + Math.max(1, needle.length);
  }
  return rows;
};

export const CANDIDATE_CHARACTERIZATION_VERSION = 'candidate-characterization@13-table-rank-ownership';
export const CANDIDATE_WIRE_VERSION = 'candidate-characterization-jsonl@8';
export const CANDIDATE_RESULT_SCHEMA = 'estate-map/candidate-characterization-result/v1';
export const acceptCandidateJsonlAtProviderBoundary = text => String(text || '').trim()
  ? { wire: CANDIDATE_WIRE_VERSION } : null;

function rawLocatorForExactSpan(span, block, blockToken) {
  const occurrences = exactIndexes(block.text, span.text);
  const localByte = span.byte_start - block.byte_start;
  const ordinal = occurrences.findIndex(index => Buffer.byteLength(block.text.slice(0, index), 'utf8') === localByte) + 1;
  if (!ordinal) throw new Error(`exact candidate span is not recoverable in ${block.address}`);
  return {
    block_token: blockToken,
    quote: span.text,
    context_before: null,
    context_after: null,
    occurrence: span.text.length < 24 || occurrences.length > 1 ? ordinal : null,
  };
}

function createPackets({ inventory, candidate_ids = null, max_candidates = 18, max_source_bytes = 24000 }) {
  const selectedIds = candidate_ids ? new Set(candidate_ids) : null;
  const candidates = inventory.obligations.filter(row => !selectedIds || selectedIds.has(row.id));
  if (selectedIds && candidates.length !== selectedIds.size) {
    const resolved = new Set(candidates.map(row => row.id));
    throw new Error(`candidate selection has ${[...selectedIds].filter(id => !resolved.has(id)).length} unknown ids`);
  }
  const unitById = new Map(inventory.units.map(row => [row.id, row]));
  const groups = [];
  for (const candidate of candidates) {
    const prior = groups.at(-1);
    if (prior?.unit.id === candidate.source_unit_id) prior.candidates.push(candidate);
    else groups.push({ unit: unitById.get(candidate.source_unit_id), candidates: [candidate] });
  }
  const packets = [];
  let held = [], heldCandidates = 0, heldBytes = 0;
  const flush = () => {
    if (!held.length) return;
    const identity = {
      constructor: inventory.constructor_version,
      units: held.map(row => ({ id: row.unit.id, local_context_digest: row.unit.local_context_digest })),
      candidates: held.flatMap(row => row.candidates.map(candidate => candidate.id)),
    };
    packets.push({ id: `candidate-packet:${sha256(canonical(identity))}`, groups: held });
    held = []; heldCandidates = 0; heldBytes = 0;
  };
  for (const group of groups) {
    for (let start = 0; start < group.candidates.length; start += max_candidates) {
      const slice = group.candidates.slice(start, start + max_candidates);
      const bytes = Buffer.byteLength(group.unit.locator.text, 'utf8');
      if (held.length && (heldCandidates + slice.length > max_candidates || heldBytes + bytes > max_source_bytes)) flush();
      held.push({ unit: group.unit, candidates: slice });
      heldCandidates += slice.length;
      heldBytes += bytes;
      if (heldCandidates >= max_candidates || heldBytes >= max_source_bytes) flush();
    }
  }
  flush();
  return packets;
}

export function planCandidateCharacterization({ inventory, candidate_ids = null, bounds = {} }) {
  const packets = createPackets({
    inventory,
    candidate_ids,
    max_candidates: Number(bounds.max_candidates_per_packet ?? 18),
    max_source_bytes: Number(bounds.max_source_bytes_per_packet ?? 24000),
  });
  return Object.freeze({
    packets: packets.length,
    candidates: packets.reduce((sum, packet) => sum + packet.groups.reduce((held, group) => held + group.candidates.length, 0), 0),
    source_units: new Set(packets.flatMap(packet => packet.groups.map(group => group.unit.id))).size,
    packet_ids: packets.map(packet => packet.id),
  });
}

function materializePacket(packet, inventory, blockByAddress, snapshot = null, maxRelationsPerCandidate = 24) {
  const candidateByRef = new Map(), handleByRef = new Map();
  const allowedHandlesByCandidateRef = new Map();
  let candidateOrdinal = 0, handleOrdinal = 0;
  const groups = packet.groups.map(group => {
    const handles = group.unit.subject_handles.map(handle => {
      const ref = `s${String(++handleOrdinal).padStart(3, '0')}`;
      handleByRef.set(ref, { ...handle, unit_id: group.unit.id });
      return { ref, handle };
    });
    const candidates = group.candidates.map(candidate => {
      const ref = `c${String(++candidateOrdinal).padStart(3, '0')}`;
      candidateByRef.set(ref, candidate);
      const inside = handles.filter(row => row.handle.locator.byte_start < candidate.locator.byte_end
        && candidate.locator.byte_start < row.handle.locator.byte_end);
      const actorKinds = new Set(['predicate_actor', 'membership_actor', 'missing_subject', 'equality_subject',
        'table_row_subject', 'table_cell_reference', 'table_column_subject', 'list_item_subject', 'metadata_subject',
        'schema_property_subject']);
      const insideActors = inside.filter(row => actorKinds.has(row.handle.handle_kind));
      const actorAnchors = inside.filter(row => row.handle.handle_kind === 'literal_reference'
        && insideActors.some(actor => actor.handle.locator.byte_start <= row.handle.locator.byte_start
          && row.handle.locator.byte_end <= actor.handle.locator.byte_end));
      const priorActors = handles.filter(row => actorKinds.has(row.handle.handle_kind)
        && row.handle.locator.byte_end <= candidate.locator.byte_start)
        .sort((a, b) => b.handle.locator.byte_end - a.handle.locator.byte_end);
      const rowSubjects = handles.filter(row => row.handle.handle_kind === 'table_row_subject');
      const columnSubjects = handles.filter(row => row.handle.handle_kind === 'table_column_subject'
        && row.handle.table_column_index === candidate.table_column_index);
      const listSubjects = handles.filter(row => row.handle.handle_kind === 'list_item_subject');
      // Keep the candidate menu closed around grammatical actors. An elided coordinated clause may
      // inherit only its nearest preceding actor. Whole-unit closure may use every actor within the
      // exact unit; structural rows/cells may also inherit their exact row subject.
      const tableDisallowsRowSubject = group.unit.unit_kind === 'table_row'
        && (candidate.table_column_self_referential
          || (candidate.obligation_kind === 'main_clause' && candidate.table_has_self_referential_column));
      const localHandles = candidate.obligation_kind === 'ordinal_membership' && group.unit.unit_kind === 'list_item'
        ? listSubjects.slice(0, 2)
        : candidate.obligation_kind === 'main_clause'
        ? handles.filter(row => actorKinds.has(row.handle.handle_kind)
          && !(tableDisallowsRowSubject && row.handle.handle_kind === 'table_row_subject')).slice(0, 12)
        : group.unit.unit_kind === 'table_row'
          ? [...new Map([...insideActors, ...(tableDisallowsRowSubject ? columnSubjects : rowSubjects),
            ...actorAnchors].map(row => [row.ref, row])).values()].slice(0, 6)
          : insideActors.length ? [...insideActors, ...actorAnchors].slice(0, 4)
        : inside.length ? inside.filter(row => row.handle.handle_kind !== 'literal_reference').slice(0, 2)
        : priorActors.slice(0, 1);
      allowedHandlesByCandidateRef.set(ref, new Set(localHandles.map(row => row.ref)));
      return { ref, candidate, handles: localHandles };
    });
    const contextLocators = [...new Map(candidates.flatMap(row => row.candidate.context_locators || [])
      .map(locator => [`${locator.block_id}\0${locator.byte_start}\0${locator.byte_end}`, locator])).values()];
    return { ...group, candidates, handles, contextLocators };
  });
  const blockAddresses = [...new Set(groups.map(group => group.unit.locator.block_address))];
  const contextBlockAddresses = [...new Set(groups.flatMap(group => group.contextLocators)
    .map(locator => locator.block_address).filter(address => !blockAddresses.includes(address)))];
  const first = groups[0].unit.locator;
  const window = Object.freeze({
    id: packet.id,
    file: first.file,
    primary_block_addresses: blockAddresses,
    context_block_addresses: contextBlockAddresses,
    primary_spans: blockAddresses.map(address => {
      const block = blockByAddress.get(address);
      return { file: block.file, start: block.start, end: block.end };
    }),
    context_spans: contextBlockAddresses.map(address => {
      const block = blockByAddress.get(address);
      return { file: block.file, start: block.start, end: block.end };
    }),
    snapshot,
  });
  const prompt = [
    'You are characterizing exact documentary proposition obligations. The tool owns all evidence',
    'locators and source coordinates. Use only the candidate and subject handles shown below.',
    'Characterize ONLY the named focus obligation. The complete source unit is its governing',
    'semantic scope: preserve negation, conditions, causes, exceptions, and qualifications from it.',
    'For a main_clause obligation, perform WHOLE-UNIT CLOSURE: emit every distinct proposition needed',
    'to represent all material clauses, cells, ordinals, conditions, qualifications, and consequences',
    'in that exact source unit. Do not stop after its first proposition.',
    'Never turn a negated list member into an affirmative claim or a conditional into an unconditional',
    'claim. Source-unit context is not permission to inventory sibling obligations.',
    'A possible condition (can/may/if/when/before) must remain explicit in every consequence claim;',
    'never universalize it. For imperatives, abstain unless the commanded actor has its own handle.',
    'In particular, never assign schema-check/forbid/rerun/revalidate actions to a later-mentioned',
    'model whose only explicit predicate is that it cannot waive standards.',
    'A candidate may yield multiple propositions only when its exact text itself contains multiple',
    'material conjuncts. Do not merge conditions, causes, prohibitions, qualifications, or consequences.',
    'Adjacent context is supplied only to resolve references in the focus such as "that submission".',
    'When it resolves one, make the referent explicit in the semantic claim and keep the context locator',
    'as required evidence. Never inventory a proposition found only in adjacent context.',
    'Ordinal and role labels are material. For "Member N is X", explicitly state that X is member N;',
    'do not treat the label as evidence-only decoration or replace it with X characteristics. A',
    'numbered list-item candidate must likewise preserve its authored list position.',
    'In a table, ADJACENT_CONTEXT may contain the exact header row. Use it to interpret columns.',
    'A Rank/Number/Order/Priority cell is an ordinal value, never the row actor. Predicate the rank',
    'about the entity named by the row subject handle from the table\'s entity/technique/item cell.',
    'A self-referential header such as "This dossier\'s role" predicates that column about the',
    'dossier/document, not the row key. Use its table-column subject or a grammatical actor inside',
    'the cell; never transfer that column\'s actions or possessions onto the first-cell row label.',
    'Mapping keys, row labels, paths before an em dash, and metadata labels can be legitimate subjects',
    'when the shown structural handle is local to the exact source unit.',
    'For schema mappings, field ownership follows indentation. Select the exact leaf-property handle;',
    'a scalar key never owns a sibling or nested field. schema_path is tool-owned addressing metadata.',
    'If the source has no handle for a faithful enclosing record, abstain instead of assigning the',
    'record-wide proposition to one of its scalar fields.',
    'A GOVERNING HEADING in adjacent context may establish semantic force (for example Mandatory',
    'invariants), but it is scope evidence, never the actor of a body proposition.',
    'The subject_handles array on each candidate is closed. Select the actor/entity that the exact',
    'text predicates about—not an object, value, status token, path, citation witness, or discourse label.',
    'Preserve semantic force: a descriptive report of no change is negated/descriptive, never a',
    'normative prohibition. Preserve conditions and qualifications in predicate or object text.',
    `Emit at most ${maxRelationsPerCandidate} relation lines for any one candidate.`,
    'OUTPUT JSON LINES ONLY: no code fence, blank line, array, or prose.',
    '{"k":"head","outcome":"characterized","reason":"..."}',
    '{"k":"rel","i":1,"candidate":"c001","subject_ref":"s001","family":"constraint","predicate":"...","object":"...","polarity":"affirmed","modality":"normative","quantifier":"all"}',
    'Emit one candidate_end for EVERY candidate, even when you abstain:',
    '{"k":"candidate_end","candidate":"c001","disposition":"emitted|abstain","reason":"..."}',
    `Final line: {"k":"end","candidates":${candidateByRef.size},"relations":<number of rel lines>}`,
    'An abstention is unverified; use it when no shown subject handle supports a faithful claim.',
    '',
    ...groups.flatMap((group, unitIndex) => [
      `UNIT u${String(unitIndex + 1).padStart(3, '0')} ${group.unit.unit_kind} ${group.unit.locator.file}:${group.unit.locator.start}-${group.unit.locator.end}`,
      ...(group.contextLocators.length ? [
        'ADJACENT_CONTEXT_START',
        ...group.contextLocators.map(locator => locator.text),
        'ADJACENT_CONTEXT_END',
      ] : []),
      'SOURCE_START', group.unit.locator.text, 'SOURCE_END',
      'CANDIDATE_OBLIGATIONS',
      ...group.candidates.map(row => JSON.stringify({
        candidate: row.ref,
        kind: row.candidate.obligation_kind,
        focus_text: row.candidate.locator.text,
        support_text: row.candidate.support_locator?.text || group.unit.locator.text,
        subject_handles: row.handles.map(handle => ({
          subject_ref: handle.ref,
          surface: handle.handle.surface,
          kind: handle.handle.handle_kind,
          ...(handle.handle.schema_path ? { schema_path: handle.handle.schema_path } : {}),
          ...(Number.isInteger(handle.handle.table_column_index)
            ? { table_column_index: handle.handle.table_column_index } : {}),
        })),
      })),
      '',
    ]),
  ].join('\n');
  const dependencies = {
    candidate_constructor_version: inventory.constructor_version,
    candidate_wire_version: CANDIDATE_WIRE_VERSION,
    validator_version: 'wide-context-extractor@28-proposition-obligation-audit',
    claim_schema: 'estate-map/documentary-claim/v3.3',
    candidate_exact_bytes: [...candidateByRef.values()].map(candidate => ({
      id: candidate.id,
      focus_text_digest: candidate.locator.text_digest,
      support_text_digest: candidate.support_locator?.text_digest || candidate.locator.text_digest,
      context_text_digests: (candidate.context_locators || []).map(locator => locator.text_digest),
    })),
    parent_block_digests: [...new Set([...candidateByRef.values()].map(row => row.parent_block_digest))].sort(),
    local_context_digests: [...new Set([...candidateByRef.values()].map(row => row.local_context_digest))].sort(),
    subject_handle_inventory_digest: sha256(canonical([...new Set([...allowedHandlesByCandidateRef.values()]
      .flatMap(refs => [...refs]))].sort().map(ref => {
      const handle = handleByRef.get(ref);
      return { ref, id: handle.id, text_digest: handle.locator.text_digest };
    }))),
  };
  return { ...packet, groups, candidateByRef, handleByRef, allowedHandlesByCandidateRef, window, prompt, dependencies };
}

function parseCandidateAnswer(text, expectedCandidateRefs, maxRelations) {
  const lines = String(text || '').split('\n').filter(line => line.trim());
  let header = null, trailer = null;
  const relations = [], endings = new Map(), malformed = [];
  for (let index = 0; index < lines.length; index += 1) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch (error) { malformed.push({ index, code: 'MALFORMED_CANDIDATE_LINE', detail: error.message, raw: lines[index] }); continue; }
    if (row?.k === 'head') { if (!header) header = row; else malformed.push({ index, code: 'DUPLICATE_CANDIDATE_HEADER', raw: lines[index] }); }
    else if (row?.k === 'rel') relations.push({ index, row });
    else if (row?.k === 'candidate_end') {
      const ref = clean(row.candidate);
      if (endings.has(ref)) malformed.push({ index, code: 'DUPLICATE_CANDIDATE_END', raw: lines[index] });
      else endings.set(ref, row);
    } else if (row?.k === 'end') trailer = row;
    else malformed.push({ index, code: 'UNKNOWN_CANDIDATE_LINE_KIND', raw: lines[index] });
  }
  const expected = [...expectedCandidateRefs];
  const missingEnds = expected.filter(ref => !endings.has(ref));
  const invalidEnds = [...endings.entries()].filter(([ref, row]) => !expected.includes(ref)
    || !['emitted', 'abstain'].includes(clean(row.disposition)));
  const complete = Boolean(header && trailer)
    && !missingEnds.length && !invalidEnds.length
    && Number(trailer.candidates) === expected.length
    && Number(trailer.relations) === relations.length
    && relations.length <= maxRelations;
  return {
    header, relations, endings, malformed,
    completeness: {
      complete,
      missing_candidate_ends: missingEnds,
      invalid_candidate_ends: invalidEnds.map(([ref]) => ref),
      declared_candidates: Number(trailer?.candidates),
      declared_relations: Number(trailer?.relations),
      observed_relations: relations.length,
      overflow: relations.length > maxRelations ? { returned: relations.length, max_items: maxRelations } : null,
    },
  };
}

function subjectOccurrence({ ref, handle, block, blockToken, windowId }) {
  const locator = rawLocatorForExactSpan(handle.locator, block, blockToken);
  return Object.freeze({
    ref,
    id: handle.id,
    schema: 'estate-map/window-subject-occurrence/v1',
    window_id: windowId,
    mention_id: null,
    kind: 'candidate_local_handle',
    surface: handle.surface,
    block_token: blockToken,
    block_id: block.id,
    block_digest: block.digest,
    role: 'primary',
    occurrence: locator.occurrence || 1,
    line: handle.locator.start,
    byte_start: handle.locator.byte_start,
    byte_end: handle.locator.byte_end,
    text_digest: handle.locator.text_digest,
  });
}

export function validateCandidateCharacterization({
  response, packet, inventory, inventories, namespace, blockByAddress, model_identifier,
  prompt_digest = sha256(packet.prompt), max_relations_per_candidate = 6,
}) {
  const maxRelations = packet.candidateByRef.size * max_relations_per_candidate;
  const parsed = parseCandidateAnswer(response?.text || '', packet.candidateByRef.keys(), maxRelations);
  if (!parsed.completeness.complete) {
    return Object.freeze({
      ok: false,
      terminal_incomplete: true,
      error_code: parsed.completeness.overflow ? 'CANDIDATE_RELATION_OVERFLOW' : 'CANDIDATE_RESPONSE_INCOMPLETE',
      reason: 'candidate answer lacks complete per-candidate receipts or a matching trailer',
      salvage: Object.freeze({
        schema: 'estate-map/non-promotable-candidate-salvage/v1',
        status: 'non_promotable',
        parsed_relations: parsed.relations,
        malformed: parsed.malformed,
        completeness: parsed.completeness,
      }),
    });
  }
  const catalog = createWindowBlockCatalog({ window: packet.window, inventories });
  const tokenByAddress = new Map(catalog.entries.map(row => [row.address, row.token]));
  const occurrenceByRef = new Map();
  for (const [ref, handle] of packet.handleByRef) {
    const block = blockByAddress.get(handle.locator.block_address);
    occurrenceByRef.set(ref, subjectOccurrence({
      ref, handle, block, blockToken: tokenByAddress.get(block.address), windowId: packet.window.id,
    }));
  }
  const admittedByCandidate = new Map(), rejectedByCandidate = new Map();
  const malformed = parsed.malformed.slice();
  for (const relation of parsed.relations) {
    const candidateRef = clean(relation.row.candidate);
    const subjectRef = clean(relation.row.subject_ref);
    const candidate = packet.candidateByRef.get(candidateRef);
    const handle = packet.handleByRef.get(subjectRef);
    const proposalId = `candidate-proposal:${sha256(canonical({ packet: packet.id, index: relation.index, row: relation.row }))}`;
    const reject = (code, detail) => {
      const rows = rejectedByCandidate.get(candidateRef) || [];
      rows.push({ id: proposalId, code, detail });
      rejectedByCandidate.set(candidateRef, rows);
    };
    if (!candidate) { malformed.push({ index: relation.index, code: 'UNKNOWN_CANDIDATE_REF' }); continue; }
    if (!handle || !packet.allowedHandlesByCandidateRef.get(candidateRef)?.has(subjectRef)) {
      reject('UNKNOWN_OR_NONLOCAL_SUBJECT_REF', subjectRef); continue;
    }
    if (handle.handle_kind === 'table_ordinal_label') {
      reject('TABLE_ORDINAL_LABEL_AS_SUBJECT', { subject: handle.surface,
        table_column_index: handle.table_column_index ?? null });
      continue;
    }
    if (handle.handle_kind === 'predicate_actor' && isUnsafePredicateActorSurface(handle.surface)) {
      reject('PREDICATE_PHRASE_SUBJECT_REF', handle.surface); continue;
    }
    if (handle.handle_kind === 'predicate_actor') {
      const dominated = [...(packet.allowedHandlesByCandidateRef.get(candidateRef) || [])]
        .map(ref => packet.handleByRef.get(ref)).find(other => other?.handle_kind === 'predicate_actor'
          && other.locator.byte_start === handle.locator.byte_start
          && other.locator.byte_end > handle.locator.byte_end
          && /^\s+[A-Za-z_$][\w$-]*$/u.test(other.locator.text.slice(handle.locator.text.length)));
      if (dominated) {
        reject('TRUNCATED_SUBJECT_HANDLE', { selected: handle.surface, exact_actor: dominated.surface });
        continue;
      }
    }
    if (handle.handle_kind === 'schema_property_subject') {
      const authoredRelation = `${clean(relation.row.predicate)} ${clean(relation.row.object)}`.toLowerCase();
      const conflicting = [...(packet.allowedHandlesByCandidateRef.get(candidateRef) || [])]
        .map(ref => packet.handleByRef.get(ref)).find(other => {
          if (other?.handle_kind !== 'schema_property_subject' || other.id === handle.id
            || !other.schema_path?.includes('.')) return false;
          const suffixes = other.schema_path.split('.').map((_, index, parts) => parts.slice(index).join('.'));
          return suffixes.some(suffix => suffix.includes('.') && authoredRelation.includes(suffix.toLowerCase()));
        });
      if (conflicting) {
        reject('SCHEMA_PROPERTY_SUBJECT_CONFLICT', {
          selected: handle.schema_path || handle.surface,
          referenced_property: conflicting.schema_path,
        });
        continue;
      }
    }
    if (handle.handle_kind === 'table_row_subject'
      && (candidate.table_column_self_referential
        || (candidate.obligation_kind === 'main_clause' && candidate.table_has_self_referential_column))) {
      reject('TABLE_COLUMN_SUBJECT_CONFLICT', {
        subject: handle.surface,
        table_column_index: candidate.table_column_index ?? null,
        reason: 'a self-referential table column belongs to the dossier/document, not the row key',
      });
      continue;
    }
    const supportSpan = candidate.support_locator || candidate.locator;
    const candidateBlock = blockByAddress.get(supportSpan.block_address);
    const handleBlock = blockByAddress.get(handle.locator.block_address);
    const candidateLocator = rawLocatorForExactSpan(supportSpan, candidateBlock, tokenByAddress.get(candidateBlock.address));
    const contextLocators = (candidate.context_locators || []).map(span => {
      const block = blockByAddress.get(span.block_address);
      return rawLocatorForExactSpan(span, block, tokenByAddress.get(block.address));
    });
    const handleLocator = rawLocatorForExactSpan(handle.locator, handleBlock, tokenByAddress.get(handleBlock.address));
    const synthesized = serializeFlatRelationAnswer({ claims: [{
      subject_binding: 'explicit',
      subject_occurrence: subjectRef,
      subject_mention: { surface: handle.surface, source_locator: handleLocator },
      relation_family: relation.row.family,
      predicate_family: relation.row.predicate,
      object_or_value: relation.row.object,
      polarity: relation.row.polarity,
      modality: relation.row.modality,
      quantifier: relation.row.quantifier,
      support_sets: [{ mode: 'all_required', locators: [
        { role: 'primary', source_locator: candidateLocator },
        ...contextLocators.map(source_locator => ({ role: 'context', source_locator })),
      ] }],
    }] });
    const validation = validateWindowResponse({
      response: { ...response, outcome: 'ok', text: synthesized },
      window: packet.window,
      catalog,
      namespace,
      subjectOccurrenceByRef: occurrenceByRef,
      modelIdentifier: model_identifier,
      promptDigest: prompt_digest,
      maxClaims: 1,
      requireSubjectOccurrence: true,
      recoverColocatedExplicit: true,
      rejectOwnershipCollapse: true,
      ignoreUnknownAdvisoryOccurrence: true,
      preciseOwnershipCollapse: true,
      rejectRoleOwnership: true,
      preciseHeadingOwnership: true,
      recoverExactUniqueLocators: true,
      normalizeCatalogPrimaryRoles: true,
      rejectIncompleteEvidenceFragments: true,
      rejectRecoveredRoleOwnership: true,
      rejectRecoveredSemanticCompleteness: true,
      rejectRecoveredActiveHeadings: true,
      rejectRecoveredCausativeHeadings: true,
      recoverExactImplicitTopicQuotes: true,
      rejectRecoveredImplicitTopicActors: true,
      preserveDottedMemberIdentities: true,
      preserveIndependentCommandWitnesses: true,
      terminalIncompleteOnTruncation: true,
      terminalIncompleteOnOverflow: true,
      repairWhitespaceEquivalentLocators: true,
      preserveAuthoredSubjectSurfaces: true,
      useClaimV33: true,
    });
    if (!validation.ok || validation.value.claims.length !== 1) {
      const rejected = validation.value?.rejected?.[0];
      reject(rejected?.reason || rejected?.code || validation.error_code || 'INVALID_CANDIDATE_CLAIM', rejected?.detail || validation.reason);
      continue;
    }
    const claims = admittedByCandidate.get(candidateRef) || [];
    claims.push(validation.value.claims[0]);
    admittedByCandidate.set(candidateRef, claims);
  }
  const candidateResults = [...packet.candidateByRef.entries()].map(([ref, candidate]) => {
    const claims = admittedByCandidate.get(ref) || [];
    const rejected = rejectedByCandidate.get(ref) || [];
    const authoredDisposition = clean(parsed.endings.get(ref)?.disposition);
    const disposition = claims.length ? 'emitted'
      : rejected.length || authoredDisposition === 'emitted' ? 'rejected_only' : 'abstained_unverified';
    return Object.freeze({
      candidate_id: candidate.id,
      candidate_ref: ref,
      disposition,
      claims,
      rejected_proposals: rejected,
      authored_disposition: authoredDisposition,
    });
  });
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      packet_id: packet.id,
      candidate_results: candidateResults,
      malformed,
      completeness: parsed.completeness,
    }),
  });
}

export async function runCandidateCharacterization({
  inventory, inventories, namespace, blockByAddress, snapshot, checkpointPath, model,
  thinking = null, provider_route = null, runnerFactory = null, candidate_ids = null,
  concurrency = 4, bounds = {}, signal = null, materialization_label = null,
}) {
  const maxCost = Number(bounds.max_known_cost_usd ?? 24.99);
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost >= 25) {
    throw new Error('each candidate-characterization test must have a positive spend cap strictly below $25');
  }
  const packets = createPackets({
    inventory, candidate_ids,
    max_candidates: Number(bounds.max_candidates_per_packet ?? 18),
    max_source_bytes: Number(bounds.max_source_bytes_per_packet ?? 24000),
  }).map(packet => materializePacket(packet, inventory, blockByAddress, snapshot,
    Number(bounds.max_relations_per_candidate ?? 24)));
  const attemptPolicy = normalizeAttemptPolicy({
    max_attempts: Number(bounds.max_attempts_per_unit ?? 2),
    retryable_outcomes: bounds.retryable_outcomes ?? ['error:provider'],
    backoff_ms: Number(bounds.retry_backoff_ms ?? 1000),
    backoff_multiplier: Number(bounds.retry_backoff_multiplier ?? 2),
    max_backoff_ms: Number(bounds.retry_backoff_max_ms ?? 30000),
    jitter_ratio: Number(bounds.retry_jitter_ratio ?? 0.1),
  });
  const providerRoute = String(provider_route || (runnerFactory ? 'injected' : 'pi-rpc'));
  const materializationLabel = materialization_label == null ? null : String(materialization_label).trim();
  if (materializationLabel && (materializationLabel.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(materializationLabel))) {
    throw new Error('materialization label must be 1-160 safe identifier characters');
  }
  const checkpoint = await openCheckpointJournal({
    file: checkpointPath,
    fingerprint: {
      schema: CANDIDATE_RESULT_SCHEMA,
      implementation: CANDIDATE_CHARACTERIZATION_VERSION,
      candidate_wire: CANDIDATE_WIRE_VERSION,
      inventory_digest: inventory.digest,
      candidate_ids: packets.flatMap(packet => [...packet.candidateByRef.values()].map(row => row.id)),
      source_sha: snapshot.source_sha,
      corpus_digest: snapshot.corpus_digest,
      model,
      thinking,
      provider_route: providerRoute,
      custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY,
      attempt_policy: attemptPolicy,
      ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
    },
  });
  const budget = createInferenceBudget({
    max_calls: Number(bounds.max_calls ?? Math.max(1, packets.length * attemptPolicy.max_attempts)),
    max_known_cost_usd: maxCost,
    max_unpriced_attempts: Number(bounds.max_unpriced_attempts ?? 0),
    cost_reserve_per_call_usd: Number(bounds.cost_reserve_per_call_usd ?? 0.25),
  });
  const queue = createUnitQueue({
    units: packets.map(packet => ({ id: packet.id, payload: packet })),
    lease_ms: Number(bounds.lease_ms ?? Math.max(900000, Number(bounds.call_timeout_ms ?? 180000) * 2)),
    fleet_stop: bounds.fleet_stop ?? { failure_rate: 0.5, min_samples: 6 },
  });
  const runners = new Map(), built = [];
  const makeRunner = runnerFactory || (() => createPiRpcRunner({
    model, thinking, timeoutMs: Number(bounds.call_timeout_ms ?? 180000),
    maxOutputBytes: Number(bounds.max_event_bytes ?? 4 * 1024 * 1024),
    maxAnswerBytes: Number(bounds.max_answer_bytes ?? 1024 * 1024),
    // The stage validator owns JSONL parsing. Returning a sentinel here prevents the provider
    // wrapper from misclassifying a valid multi-line JSONL answer as one unparseable JSON value.
    answerParser: acceptCandidateJsonlAtProviderBoundary,
  }));
  const runnerFor = worker => {
    if (!runners.has(worker)) { const runner = makeRunner({ worker, model, thinking }); runners.set(worker, runner); built.push(runner); }
    return runners.get(worker);
  };
  const results = new Map(), terminalSalvage = new Map(), materializations = new Map();
  try {
    await runQueue({
      queue,
      concurrency: Math.max(1, Number(concurrency || 1)),
      signal,
      worker_start_delay_ms: Number(bounds.worker_start_delay_ms ?? 0),
      initial_worker_concurrency: Number(bounds.initial_worker_concurrency ?? concurrency),
      process: async (unit, worker) => {
        const packet = unit.payload;
        const runner = runnerFor(worker);
        const key = sha256(canonical({
          implementation: CANDIDATE_CHARACTERIZATION_VERSION,
          packet_id: packet.id,
          prompt_digest: sha256(packet.prompt),
          model: runner.model,
          thinking,
          provider_route: providerRoute,
          ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
        }));
        const completion = await runCustodiedInference({
          checkpoint,
          stage: 'candidate-characterization',
          key,
          tag: `candidate:${packet.id}`,
          prompt: packet.prompt,
          runner,
          budget,
          attempt_policy: attemptPolicy,
          materialization_dependencies: {
            ...packet.dependencies,
            model: runner.model,
            thinking,
            provider_route: providerRoute,
            ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
          },
          validate: response => validateCandidateCharacterization({
            response, packet, inventory, inventories, namespace, blockByAddress,
            model_identifier: runner.model,
            max_relations_per_candidate: Number(bounds.max_relations_per_candidate ?? 6),
          }),
        });
        materializations.set(packet.id, completion.materialization);
        if (completion.incomplete) {
          terminalSalvage.set(packet.id, completion.incomplete.validation?.salvage || null);
          return { outcome: 'quarantined', findings: [completion.incomplete] };
        }
        results.set(packet.id, completion.validated);
        return { outcome: completion.validated.candidate_results.some(row => row.disposition === 'rejected_only') ? 'partial' : 'ok' };
      },
    });
  } finally {
    await checkpoint.close();
    for (const runner of built) { try { await runner.shutdown?.(); } catch {} }
  }
  const selectedResults = [...results.entries()];
  const rawClaims = selectedResults.flatMap(([, result]) => result.candidate_results.flatMap(row => row.claims));
  const claims = reduceClaimsV33(rawClaims);
  const reducedClaimByProposition = new Map(claims.map(claim => [claim.proposition_key, claim]));
  const receipts = [];
  for (const [packetId, result] of selectedResults) {
    const attemptId = materializations.get(packetId)?.selected_attempt_id;
    for (const row of result.candidate_results) receipts.push(buildCoverageReceipt({
      candidate_id: row.candidate_id,
      execution_state: 'completed',
      disposition: row.disposition,
      admitted_claim_ids: [...new Set(row.claims.map(claim => reducedClaimByProposition.get(claim.proposition_key)?.id).filter(Boolean))],
      rejected_proposal_ids: row.rejected_proposals.map(proposal => proposal.id),
      attempt_id: attemptId,
      verification_status: row.claims.length ? 'validated_exact_source' : 'unverified',
    }));
  }
  for (const packet of packets.filter(row => terminalSalvage.has(row.id))) {
    const attemptId = materializations.get(packet.id)?.terminal_attempt_id;
    for (const candidate of packet.candidateByRef.values()) receipts.push(buildCoverageReceipt({
      candidate_id: candidate.id,
      execution_state: 'terminal_incomplete',
      disposition: 'terminal_incomplete',
      attempt_id: attemptId,
      verification_status: 'unverified',
    }));
  }
  const queueStatus = queue.status();
  const budgetStatus = budget.snapshot();
  const expectedCandidates = packets.reduce((sum, packet) => sum + packet.candidateByRef.size, 0);
  const outputClaimIds = new Set(claims.map(claim => claim.id));
  const receiptClaimLinksValid = receipts.every(row => row.admitted_claim_ids.every(id => outputClaimIds.has(id)));
  const receiptComplete = receipts.length === expectedCandidates
    && new Set(receipts.map(row => row.candidate_id)).size === expectedCandidates
    && receiptClaimLinksValid;
  const body = {
    schema: CANDIDATE_RESULT_SCHEMA,
    implementation: CANDIDATE_CHARACTERIZATION_VERSION,
    candidate_wire: CANDIDATE_WIRE_VERSION,
    snapshot,
    inventory_digest: inventory.digest,
    inference: { model, thinking, provider_route: providerRoute, custody_policy: MATERIALIZATION_ATTEMPT_CUSTODY_POLICY },
    ...(materializationLabel ? { explicit_materialization_label: materializationLabel } : {}),
    bounds: { ...bounds, max_known_cost_usd: maxCost },
    queue: queueStatus,
    budget: budgetStatus,
    materializations: [...materializations.entries()].map(([packet_id, value]) => ({ packet_id, ...value })),
    metrics: {
      ...claimQualityMetricsV33(claims),
      packets: packets.length,
      candidates: expectedCandidates,
      candidate_receipts: receipts.length,
      complete_candidate_receipts: receiptComplete,
      candidate_claim_links_valid: receiptClaimLinksValid,
      emitted_candidates: receipts.filter(row => row.disposition === 'emitted').length,
      rejected_only_candidates: receipts.filter(row => row.disposition === 'rejected_only').length,
      abstained_unverified_candidates: receipts.filter(row => row.disposition === 'abstained_unverified').length,
      terminal_incomplete_candidates: receipts.filter(row => row.disposition === 'terminal_incomplete').length,
      selected_truncation: 0,
      selected_overflow: 0,
    },
    claims,
    coverage_receipts: receipts.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    terminal_salvage: [...terminalSalvage.entries()].map(([packet_id, salvage]) => ({ packet_id, salvage })),
    status: receiptComplete && !queueStatus.by_state?.quarantined && !budgetStatus.unpriced_attempts ? 'complete' : 'incomplete',
  };
  return Object.freeze({ ...body, digest: sha256(canonical({ ...body, claims: claims.map(row => row.id) })) });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/, '')] = args[index + 1];
  for (const name of ['estate', 'manifest', 'inventory', 'checkpoint', 'output']) if (!options[name]) throw new Error(`missing --${name}`);
  if (process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new Error('set ASCRYBE_ENABLE_PAID_INFERENCE=1 to authorize paid inference');
  const root = await fs.realpath(path.resolve(options.estate));
  const manifest = JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8'));
  const sourceSha = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (manifest.source_sha && sourceSha !== manifest.source_sha) throw new Error(`source SHA mismatch: ${sourceSha}`);
  const documents = await Promise.all(manifest.documents.map(async spec => ({ path: spec.path, content: await fs.readFile(path.join(root, spec.path), 'utf8') })));
  const snapshot = {
    source_sha: sourceSha,
    corpus_digest: sha256(canonical(documents.map(row => ({ path: row.path, digest: sha256(row.content) })))),
  };
  const prepasses = documents.map(document => prepassDocument({ ...document, ...snapshot }));
  const inventories = prepasses.map(row => row.inventory);
  const namespace = buildMentionNamespace(prepasses);
  const blockByAddress = new Map(inventories.flatMap(held => held.blocks.map(block => [block.address, block])));
  const loaded = JSON.parse(await fs.readFile(path.resolve(options.inventory), 'utf8'));
  const inventory = loaded.known_opportunity_inventory || loaded;
  if (inventory.constructor_version !== PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION) throw new Error('candidate constructor version mismatch');
  const candidateValue = options['candidate-ids'] ? JSON.parse(await fs.readFile(path.resolve(options['candidate-ids']), 'utf8')) : null;
  const candidateIds = Array.isArray(candidateValue) ? candidateValue : candidateValue?.candidate_ids || null;
  const externalBounds = options.bounds ? JSON.parse(await fs.readFile(path.resolve(options.bounds), 'utf8')) : {};
  if (options['max-cost']) externalBounds.max_known_cost_usd = Number(options['max-cost']);
  const stop = installGracefulStop();
  let result;
  try {
    result = await runCandidateCharacterization({
      inventory, inventories, namespace, blockByAddress, snapshot,
      checkpointPath: path.resolve(options.checkpoint),
      model: options.model || manifest.models.extraction,
      thinking: options.thinking || manifest.models.extraction_thinking,
      candidate_ids: candidateIds,
      concurrency: Number(options.concurrency || externalBounds.concurrency || 4),
      bounds: externalBounds,
      signal: stop.signal,
      materialization_label: options['materialization-label'] || null,
    });
  } finally { stop.dispose(); }
  const output = path.resolve(options.output);
  const temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
  console.log(JSON.stringify({ output, status: result.status, metrics: result.metrics, budget: result.budget, digest: result.digest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

export { createMockModelRunner };
