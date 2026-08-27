// Deterministic exact-mention discovery and assertion-argument coverage.
//
// This plane consumes immutable documentary claims and structural source units. It never rewrites
// claim records and never infers identity: every handle remains an exact source occurrence.
import { sha256, stableStringify } from './lib.mjs';

export const EVIDENCE_POINTER_SCHEMA = 'estate-map/evidence-pointer/v1';
export const MENTION_SCHEMA = 'estate-map/mention/v1';
// Producer byte changelog:
// argument-mentions@2 — document_span.pointer omits block_id/block_address (rehashing evidence_id),
// and Mention.context_digest uses the owning source-block digest so overlapping units emit one value.
// The producer version participates in mention identity; this bump intentionally rehashes mention_id
// and dependent obligation, binding-receipt, projection-receipt, and assertion identities.
export const MENTION_PRODUCER_VERSION = 'argument-mentions@2';
export const MENTION_DISCOVERY_COVERAGE_SCHEMA = 'estate-map/mention-discovery-coverage-receipt/v1';
export const ASSERTION_ARGUMENT_OBLIGATION_SCHEMA = 'estate-map/assertion-argument-obligation/v1';
export const ARGUMENT_BINDING_COVERAGE_SCHEMA = 'estate-map/argument-binding-coverage-receipt/v1';
export const ARGUMENT_MENTION_SUBSTRATE_SCHEMA = 'estate-map/argument-mention-substrate/v1';

const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const clean = value => String(value ?? '').trim();
const valueBytes = value => Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8').toString('base64');

export class ArgumentMentionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ArgumentMentionError';
    this.code = code;
    this.detail = detail;
  }
}

const pointerContracts = Object.freeze({
  document_span: Object.freeze({
    required: ['file', 'start', 'end', 'byte_start', 'byte_end', 'exact_text', 'digest'],
    optional: ['block_id', 'block_address'],
  }),
  repository_metadata: Object.freeze({
    required: ['manifest_id', 'repository_id', 'field_path', 'exact_value', 'digest'],
    optional: [],
  }),
  structured_record: Object.freeze({
    required: ['record_id', 'schema_id', 'field_path', 'exact_value', 'digest'],
    optional: [],
  }),
  source_native_object: Object.freeze({
    required: ['connector', 'native_id', 'native_version_id', 'digest'],
    optional: ['field_path'],
  }),
});

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArgumentMentionError('INVALID_POINTER', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional, 'kind']);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw new ArgumentMentionError('INVALID_POINTER_SHAPE', `${label} has an invalid closed-union shape`, { missing, unknown });
  }
}

// The exact-value digest rule, shared with valueBytes above: a string value is hashed verbatim,
// any other value through its canonical serialization. This is what document_span already does for
// exact_text and what code-grounded-assertions.mjs emits for whole structured records.
function pointerValueDigest(value) {
  return sha256(typeof value === 'string' ? value : canonical(value));
}

function validatePointer(pointer) {
  const contract = pointerContracts[pointer?.kind];
  if (!contract) throw new ArgumentMentionError('UNKNOWN_POINTER_KIND', `unsupported evidence pointer ${pointer?.kind || '<missing>'}`);
  exactKeys(pointer, contract.required, contract.optional, pointer.kind);
  if (['repository_metadata', 'structured_record'].includes(pointer.kind)
    && pointer.digest !== pointerValueDigest(pointer.exact_value)) {
    // Unified section 2.4 gap: these two kinds previously trusted the caller's digest, so a pointer
    // could name one value and commit to another. source_native_object is deliberately excluded --
    // it carries no exact_value, and its digest covers connector-side content this plane never
    // holds, so it stays the resolver's obligation rather than a fabricated local recomputation.
    throw new ArgumentMentionError('POINTER_DIGEST_MISMATCH',
      `${pointer.kind} digest does not match its exact_value`);
  }
  if (pointer.kind === 'document_span') {
    for (const key of ['start', 'end', 'byte_start', 'byte_end']) {
      if (!Number.isInteger(pointer[key]) || pointer[key] < 0) {
        throw new ArgumentMentionError('INVALID_POINTER_COORDINATE', `${key} must be a non-negative integer`);
      }
    }
    if (pointer.end < pointer.start || pointer.byte_end < pointer.byte_start) {
      throw new ArgumentMentionError('INVALID_POINTER_RANGE', 'document span end precedes start');
    }
    if (Buffer.byteLength(pointer.exact_text, 'utf8') !== pointer.byte_end - pointer.byte_start) {
      throw new ArgumentMentionError('POINTER_BYTE_MISMATCH', 'document span bytes do not match exact_text');
    }
    if (sha256(pointer.exact_text) !== pointer.digest) {
      throw new ArgumentMentionError('POINTER_DIGEST_MISMATCH', 'document span digest does not match exact_text');
    }
  }
  return Object.freeze({ ...pointer });
}

/** Build one member of the closed EvidencePointer union. */
export function buildEvidencePointer({ source_version_id, access_policy_id = null, pointer }) {
  if (!clean(source_version_id)) throw new ArgumentMentionError('MISSING_SOURCE_VERSION', 'evidence pointer requires source_version_id');
  const validated = validatePointer(pointer);
  const body = {
    schema: EVIDENCE_POINTER_SCHEMA,
    source_version_id,
    access_policy_id,
    pointer: validated,
  };
  return Object.freeze({ ...body, evidence_id: hashId('evidence', body) });
}

export function sourceVersionIdForInventory(inventory) {
  if (!inventory?.path || !inventory?.source_digest) {
    throw new ArgumentMentionError('INVALID_SOURCE_INVENTORY', 'source version identity requires path and source_digest');
  }
  return hashId('source-version', {
    resource_id: `git-path:${inventory.path}`,
    native_version_id: inventory.source_sha,
    content_digest: inventory.source_digest,
  });
}

const mentionRoles = new Set([
  'subject', 'object', 'qualified_referent', 'scope_referent', 'condition_referent',
  'definition', 'heading', 'link_label', 'namespace_owner', 'structured_metadata',
]);

function pointerLocalIdentity(pointer) {
  switch (pointer.kind) {
    case 'document_span':
      return {
        kind: pointer.kind,
        file: pointer.file,
        byte_start: pointer.byte_start,
        byte_end: pointer.byte_end,
        value_bytes: valueBytes(pointer.exact_text),
      };
    case 'repository_metadata':
      return {
        kind: pointer.kind,
        manifest_id: pointer.manifest_id,
        repository_id: pointer.repository_id,
        field_path: pointer.field_path,
        value_bytes: valueBytes(pointer.exact_value),
      };
    case 'structured_record':
      return {
        kind: pointer.kind,
        record_id: pointer.record_id,
        schema_id: pointer.schema_id,
        field_path: pointer.field_path,
        value_bytes: valueBytes(pointer.exact_value),
      };
    case 'source_native_object':
      return {
        kind: pointer.kind,
        connector: pointer.connector,
        native_id: pointer.native_id,
        native_version_id: pointer.native_version_id,
        field_path: pointer.field_path || null,
      };
    default:
      throw new ArgumentMentionError('UNKNOWN_POINTER_KIND', `unsupported evidence pointer ${pointer.kind}`);
  }
}

/** Exact mention identity excludes corpus/materialization digests and normalized display text. */
export function buildMention({
  evidence_pointer, surface, role, mention_producer_version = MENTION_PRODUCER_VERSION,
  claim_id = null, proposition_key = null, candidate_obligation_id = null,
  provenance_class = 'production_document', namespace = null, source_status = 'current',
  context_digest = null, disposition = 'uncharacterized',
}) {
  const evidence = buildEvidencePointer({
    source_version_id: evidence_pointer?.source_version_id,
    access_policy_id: evidence_pointer?.access_policy_id ?? null,
    pointer: evidence_pointer?.pointer,
  });
  if (!mentionRoles.has(role)) throw new ArgumentMentionError('INVALID_MENTION_ROLE', `unsupported mention role ${role}`);
  if (!clean(surface)) throw new ArgumentMentionError('EMPTY_MENTION_SURFACE', 'mention surface must be non-empty');
  if (!clean(mention_producer_version)) throw new ArgumentMentionError('MISSING_MENTION_PRODUCER', 'mention producer version is required');
  const identity = {
    source_version_id: evidence.source_version_id,
    local: pointerLocalIdentity(evidence.pointer),
    exact_value_bytes: evidence.pointer.kind === 'source_native_object' ? valueBytes(surface) : undefined,
    role,
    mention_producer_version,
  };
  const body = {
    schema: MENTION_SCHEMA,
    mention_id: hashId('mention', identity),
    evidence_id: evidence.evidence_id,
    surface,
    normalized_surface: clean(surface).toLocaleLowerCase(),
    role,
    claim_id,
    proposition_key,
    candidate_obligation_id,
    provenance_class,
    namespace,
    source_status,
    context_digest,
    disposition,
    mention_producer_version,
  };
  return Object.freeze({ evidence, mention: Object.freeze(body) });
}

function provenanceClass(file, block) {
  if (/(?:^|\/)(?:fixtures?|testdata)(?:\/|$)/iu.test(file)) return 'fixture';
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.test\.[^.]+$/iu.test(file)) return 'test';
  if (block?.type === 'code' || /(?:^|\/)(?:examples?|samples?)(?:\/|$)/iu.test(file)) return 'example';
  if (/^design\/canon\//u.test(file)) return 'canon';
  if (/^design\/features\//u.test(file)) return 'feature_document';
  if (/^https?:/iu.test(file)) return 'external_citation';
  return 'production_document';
}

function pointerFromLocator(sourceVersionId, locator) {
  return buildEvidencePointer({
    source_version_id: sourceVersionId,
    pointer: {
      kind: 'document_span',
      file: locator.file,
      start: locator.start,
      end: locator.end,
      byte_start: locator.byte_start,
      byte_end: locator.byte_end,
      exact_text: locator.text,
      digest: locator.text_digest,
    },
  });
}

const overlaps = (left, right) => left.file === right.file
  && left.byte_start < right.byte_end && right.byte_start < left.byte_end;
const contains = (outer, inner) => outer.file === inner.file
  && outer.byte_start <= inner.byte_start && outer.byte_end >= inner.byte_end;

function nestedValues(value, path) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => nestedValues(item, `${path}.${index}`));
  if (typeof value === 'object') return Object.keys(value).sort().flatMap(key => nestedValues(value[key], `${path}.${key}`));
  return [{ field_path: path, value }];
}

function claimArgumentSpecs(claim) {
  const semantic = claim?.semantic || {};
  const subject = semantic.subject || {};
  return [
    ...(clean(subject.surface) ? [{
      role: 'subject', field_path: 'semantic.subject', value: subject.surface,
      direct_locator: subject.source_locator || null, referential: true,
    }] : []),
    ...nestedValues(semantic.object_or_value, 'semantic.object_or_value')
      .map(row => ({ ...row, role: 'object', direct_locator: null, referential: null })),
    ...nestedValues(semantic.qualified_referents, 'semantic.qualified_referents')
      .map(row => ({ ...row, role: 'qualified_referent', direct_locator: null, referential: true })),
    ...nestedValues(semantic.qualifiers, 'semantic.qualifiers')
      .map(row => ({ ...row, role: 'qualified_referent', direct_locator: null, referential: null })),
    ...nestedValues(semantic.scope, 'semantic.scope')
      .map(row => ({ ...row, role: 'scope_referent', direct_locator: null, referential: null })),
    ...nestedValues(semantic.conditions, 'semantic.conditions')
      .map(row => ({ ...row, role: 'condition_referent', direct_locator: null, referential: null })),
    ...nestedValues(semantic.valid_time, 'semantic.valid_time')
      .map(row => ({ ...row, role: 'condition_referent', direct_locator: null, referential: null })),
  ];
}

const claimLocators = claim => (claim?.semantic?.support_sets || []).flatMap(set => set?.locators || [])
  .filter(locator => locator?.file && Number.isInteger(locator?.byte_start) && Number.isInteger(locator?.byte_end)
    && typeof locator?.text === 'string' && locator?.text_digest);

function searchableSurface(value) {
  const source = String(value);
  const characters = [], sourceIndexes = [];
  let pendingWhitespace = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/[\u200b-\u200d\ufeff`*~]/u.test(character)) continue;
    if (/\s/u.test(character)) {
      if (characters.length && pendingWhitespace == null) pendingWhitespace = index;
      continue;
    }
    if (pendingWhitespace != null) {
      characters.push(' ');
      sourceIndexes.push(pendingWhitespace);
      pendingWhitespace = null;
    }
    characters.push(character.toLocaleLowerCase());
    sourceIndexes.push(index);
  }
  return { text: characters.join('').trim(), source_indexes: sourceIndexes };
}

function occurrenceLocators(spec, locators) {
  const candidates = spec.direct_locator ? [spec.direct_locator, ...locators] : locators;
  const surface = String(spec.value);
  const found = [];
  const add = (locator, index, endIndex) => {
    const prefix = locator.text.slice(0, index);
    const exact = locator.text.slice(index, endIndex);
    const byteStart = locator.byte_start + Buffer.byteLength(prefix, 'utf8');
    const start = locator.start + (prefix.match(/\n/g) || []).length;
    found.push({
      file: locator.file,
      start,
      end: start + (exact.match(/\n/g) || []).length,
      byte_start: byteStart,
      byte_end: byteStart + Buffer.byteLength(exact, 'utf8'),
      text: exact,
      text_digest: sha256(exact),
      ...(locator.block_id ? { block_id: locator.block_id } : {}),
      ...(locator.block_address ? { block_address: locator.block_address } : {}),
    });
  };
  for (const locator of candidates) {
    let offset = 0;
    while (offset <= locator.text.length - surface.length) {
      const index = locator.text.indexOf(surface, offset);
      if (index < 0) break;
      add(locator, index, index + surface.length);
      offset = index + Math.max(1, surface.length);
    }
  }
  // Claim v3.2 validates subject containment after removing authored inline markup and collapsing
  // whitespace. When exact bytes differ only on that proven presentation layer, recover the exact
  // source slice and retain those bytes in the Mention rather than fabricating the claim surface.
  if (!found.length && spec.direct_locator) {
    const target = searchableSurface(surface).text;
    const searchable = searchableSurface(spec.direct_locator.text);
    const index = target ? searchable.text.indexOf(target) : -1;
    if (index >= 0) {
      const rawStart = searchable.source_indexes[index];
      const rawEnd = searchable.source_indexes[index + target.length - 1] + 1;
      add(spec.direct_locator, rawStart, rawEnd);
    }
  }
  return [...new Map(found.map(locator => [canonical(locator), locator])).values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.byte_start - b.byte_start || a.byte_end - b.byte_end);
}

function handleRole(handle) {
  return ['table_cell_reference', 'literal_reference'].includes(handle.handle_kind) ? 'object'
    : handle.handle_kind === 'schema_property_subject' ? 'structured_metadata'
      : 'subject';
}

/**
 * Build the A1 plane over current claims and structural units. All source units in `inventory` are
 * contacted, including units with no admitted claim; each therefore receives one discovery receipt.
 */
export function buildArgumentMentionSubstrate({
  inventory, inventories, claims = [], materialization_id,
  mention_producer_version = MENTION_PRODUCER_VERSION,
  required_referential_spans = [], terminal_source_unit_ids = [],
}) {
  if (!inventory?.units || !Array.isArray(inventory.units)) {
    throw new ArgumentMentionError('INVALID_ARGUMENT_INVENTORY', 'argument substrate requires structural source units');
  }
  if (!clean(materialization_id)) throw new ArgumentMentionError('MISSING_MATERIALIZATION', 'argument substrate requires materialization_id');
  const sourceInventories = Array.isArray(inventories) ? inventories : Object.values(inventories || {});
  const inventoryByFile = new Map(sourceInventories.map(row => [row.path, row]));
  const blockByAddress = new Map(sourceInventories.flatMap(row => row.blocks.map(block => [block.address, block])));
  const sourceVersionByFile = new Map(sourceInventories.map(row => [row.path, sourceVersionIdForInventory(row)]));
  const units = inventory.units.slice().sort((a, b) => a.locator.file.localeCompare(b.locator.file)
    || a.locator.byte_start - b.locator.byte_start || a.id.localeCompare(b.id));
  const unitById = new Map(units.map(unit => [unit.id, unit]));
  const unitsByFile = new Map();
  for (const unit of units) {
    const held = unitsByFile.get(unit.locator.file) || [];
    held.push(unit);
    unitsByFile.set(unit.locator.file, held);
  }
  const evidence = new Map();
  const mentions = new Map();
  const mentionIdsByUnit = new Map();

  const addMention = ({ unit, locator, surface, role, claim = null, candidateObligationId = null }) => {
    const sourceVersionId = sourceVersionByFile.get(locator.file);
    if (!sourceVersionId) throw new ArgumentMentionError('UNKNOWN_SOURCE_VERSION', `no source inventory for ${locator.file}`);
    const pointer = pointerFromLocator(sourceVersionId, locator);
    const block = blockByAddress.get(unit.locator.block_address);
    const built = buildMention({
      evidence_pointer: pointer,
      surface,
      role,
      mention_producer_version,
      // Claim and candidate associations live on obligations. They are deliberately excluded here:
      // one exact source occurrence can support more than one immutable claim.
      claim_id: null,
      proposition_key: null,
      candidate_obligation_id: null,
      provenance_class: provenanceClass(locator.file, block),
      namespace: locator.file,
      source_status: 'current',
      // One exact occurrence can belong to overlapping structural units. Its documentary context
      // is the owning source block, not whichever overlapping unit happened to be visited first.
      context_digest: block?.digest || unit.locator.text_digest,
      disposition: provenanceClass(locator.file, block) === 'example' ? 'fixture/example' : 'uncharacterized',
    });
    evidence.set(pointer.evidence_id, pointer);
    const prior = mentions.get(built.mention.mention_id);
    if (prior && canonical(prior) !== canonical(built.mention)) {
      throw new ArgumentMentionError('MENTION_ID_COLLISION', `mention identity collision ${built.mention.mention_id}`, {
        prior,
        incoming: built.mention,
      });
    }
    mentions.set(built.mention.mention_id, built.mention);
    const unitMentions = mentionIdsByUnit.get(unit.id) || new Set();
    unitMentions.add(built.mention.mention_id);
    mentionIdsByUnit.set(unit.id, unitMentions);
    return built.mention;
  };

  for (const unit of units) {
    for (const handle of unit.subject_handles || []) {
      if (!contains(unit.locator, handle.locator)) continue;
      addMention({ unit, locator: handle.locator, surface: handle.surface, role: handleRole(handle),
        candidateObligationId: handle.id || null });
    }
  }

  const pending = [];
  for (const claim of claims.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const locators = claimLocators(claim);
    for (const spec of claimArgumentSpecs(claim)) {
      const occurrences = occurrenceLocators(spec, locators);
      let selectedUnit = occurrences.flatMap(locator => (unitsByFile.get(locator.file) || [])
        .filter(unit => contains(unit.locator, locator)))[0] || null;
      if (!selectedUnit) {
        selectedUnit = locators.flatMap(locator => (unitsByFile.get(locator.file) || [])
          .filter(unit => overlaps(unit.locator, locator)))[0] || null;
      }
      if (!selectedUnit) {
        throw new ArgumentMentionError('ARGUMENT_SOURCE_UNIT_UNRESOLVED',
          `claim ${claim.id} ${spec.field_path} does not resolve to a structural source unit`, {
            field_path: spec.field_path,
            value: spec.value,
            support_locators: locators,
          });
      }
      const localOccurrences = occurrences.filter(locator => contains(selectedUnit.locator, locator));
      const candidates = localOccurrences.map(locator => addMention({
        unit: selectedUnit, locator, surface: locator.text, role: spec.role, claim,
      }));
      pending.push({ claim, spec, unit: selectedUnit, candidates, locators });
    }
  }

  const terminal = new Set(terminal_source_unit_ids);
  for (const id of terminal) if (!unitById.has(id)) {
    throw new ArgumentMentionError('UNKNOWN_TERMINAL_SOURCE_UNIT', `unknown terminal source unit ${id}`);
  }
  const probesByUnit = new Map();
  for (const span of required_referential_spans) {
    const unit = span.source_unit_id ? unitById.get(span.source_unit_id)
      : units.find(candidate => contains(candidate.locator, span));
    if (!unit) throw new ArgumentMentionError('UNKNOWN_DISCOVERY_PROBE_UNIT', 'referential span does not resolve to a source unit', { span });
    const rows = probesByUnit.get(unit.id) || [];
    rows.push(span);
    probesByUnit.set(unit.id, rows);
  }

  const discoveryReceipts = [];
  for (const unit of units) {
    const discoveredIds = [...(mentionIdsByUnit.get(unit.id) || [])].sort();
    const missed = (probesByUnit.get(unit.id) || []).filter(span => !discoveredIds.some(id => {
      const pointer = evidence.get(mentions.get(id).evidence_id)?.pointer;
      return pointer?.kind === 'document_span' && pointer.file === span.file
        && pointer.byte_start === span.byte_start && pointer.byte_end === span.byte_end;
    }));
    const findings = missed.map(span => Object.freeze({
      code: 'MENTION_UNDER_DISCOVERY',
      detail: 'declared referential surface was not discovered',
      uncovered_span: Object.freeze({
        file: span.file,
        start: span.start,
        end: span.end,
        byte_start: span.byte_start,
        byte_end: span.byte_end,
        text_digest: span.text_digest || null,
      }),
    }));
    if (terminal.has(unit.id)) findings.push(Object.freeze({
      code: 'MENTION_DISCOVERY_TERMINAL_INCOMPLETE',
      detail: 'mention producer did not complete this structural source unit',
      uncovered_span: Object.freeze({
        file: unit.locator.file,
        start: unit.locator.start,
        end: unit.locator.end,
        byte_start: unit.locator.byte_start,
        byte_end: unit.locator.byte_end,
        text_digest: unit.locator.text_digest,
      }),
    }));
    const disposition = terminal.has(unit.id) ? 'terminal_incomplete'
      : missed.length ? 'partial_known_under_discovery' : 'complete';
    const body = {
      schema: MENTION_DISCOVERY_COVERAGE_SCHEMA,
      source_unit_id: unit.id,
      source_version_id: sourceVersionByFile.get(unit.locator.file),
      unit_digest: unit.locator.text_digest,
      mention_producer_version,
      discovered_mention_ids: discoveredIds,
      disposition,
      findings,
      materialization_id,
    };
    discoveryReceipts.push(Object.freeze({ ...body, receipt_id: hashId('mention-discovery-receipt', body) }));
  }
  const discoveryByUnit = new Map(discoveryReceipts.map(receipt => [receipt.source_unit_id, receipt]));

  const obligations = [], bindingReceipts = [];
  for (const row of pending) {
    const discovery = discoveryByUnit.get(row.unit.id);
    if (!discovery) throw new ArgumentMentionError('MISSING_DISCOVERY_RECEIPT', `missing discovery receipt for ${row.unit.id}`);
    const evidenceIds = [...new Set(row.locators.filter(locator => overlaps(row.unit.locator, locator)).map(locator => {
      const pointer = pointerFromLocator(sourceVersionByFile.get(locator.file), locator);
      evidence.set(pointer.evidence_id, pointer);
      return pointer.evidence_id;
    }))].sort();
    const identity = {
      basis_claim_id: row.claim.id,
      role: row.spec.role,
      field_path: row.spec.field_path,
      exact_value_bytes: valueBytes(row.spec.value),
      source_unit_id: row.unit.id,
      mention_producer_version,
    };
    const obligation = Object.freeze({
      schema: ASSERTION_ARGUMENT_OBLIGATION_SCHEMA,
      obligation_id: hashId('assertion-argument-obligation', identity),
      basis_claim_id: row.claim.id,
      role: row.spec.role,
      field_path: row.spec.field_path,
      candidate_mention_ids: [...new Set(row.candidates.map(candidate => candidate.mention_id))].sort(),
      evidence_ids: evidenceIds,
      mention_discovery_coverage_receipt_id: discovery.receipt_id,
      materialization_id,
    });
    let disposition = obligation.candidate_mention_ids.length === 1 ? 'bound_to_exact_mention'
      : obligation.candidate_mention_ids.length > 1 ? 'ambiguous_mentions'
        : row.spec.referential ? 'terminal_incomplete' : 'literal_argument';
    const findings = [];
    if (!obligation.candidate_mention_ids.length) findings.push(Object.freeze({
      code: row.spec.referential ? 'REFERENTIAL_ARGUMENT_MENTION_MISSING' : 'NO_EXACT_ARGUMENT_MENTION',
      field_path: row.spec.field_path,
      source_unit_id: row.unit.id,
    }));
    if (['partial_known_under_discovery', 'terminal_incomplete'].includes(discovery.disposition)
      && ['literal_argument', 'no_referential_argument'].includes(disposition)) {
      disposition = 'terminal_incomplete';
      findings.push(Object.freeze({
        code: 'DISCOVERY_COVERAGE_PREVENTS_SILENT_LITERAL',
        discovery_receipt_id: discovery.receipt_id,
        discovery_disposition: discovery.disposition,
      }));
    }
    const bindingBody = {
      schema: ARGUMENT_BINDING_COVERAGE_SCHEMA,
      obligation_id: obligation.obligation_id,
      disposition,
      selected_mention_ids: disposition === 'bound_to_exact_mention' ? obligation.candidate_mention_ids : [],
      rejected_candidate_mention_ids: [],
      findings,
      materialization_id,
    };
    obligations.push(obligation);
    bindingReceipts.push(Object.freeze({ ...bindingBody, receipt_id: hashId('argument-binding-receipt', bindingBody) }));
  }

  if (new Set(discoveryReceipts.map(row => row.source_unit_id)).size !== units.length) {
    throw new ArgumentMentionError('DISCOVERY_RECEIPT_CARDINALITY', 'every contacted source unit must have exactly one discovery receipt');
  }
  if (new Set(bindingReceipts.map(row => row.obligation_id)).size !== obligations.length) {
    throw new ArgumentMentionError('BINDING_RECEIPT_CARDINALITY', 'every argument obligation must have exactly one binding receipt');
  }
  const receiptIds = new Set(discoveryReceipts.map(row => row.receipt_id));
  if (obligations.some(row => !receiptIds.has(row.mention_discovery_coverage_receipt_id))) {
    throw new ArgumentMentionError('OBLIGATION_DISCOVERY_INTEGRITY', 'argument obligation cites a missing discovery receipt');
  }

  const body = {
    schema: ARGUMENT_MENTION_SUBSTRATE_SCHEMA,
    mention_producer_version,
    materialization_id,
    source_unit_ids: units.map(unit => unit.id),
    evidence_pointers: [...evidence.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
    mentions: [...mentions.values()].sort((a, b) => a.mention_id.localeCompare(b.mention_id)),
    mention_discovery_coverage_receipts: discoveryReceipts,
    assertion_argument_obligations: obligations.sort((a, b) => a.obligation_id.localeCompare(b.obligation_id)),
    argument_binding_coverage_receipts: bindingReceipts.sort((a, b) => a.obligation_id.localeCompare(b.obligation_id)),
    concepts: [],
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}
