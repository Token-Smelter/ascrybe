// Minimal C2 canonical graph store. Canonical JSON artifacts are authoritative; query projections
// and the inference-attempt materialization ledger remain separate downstream concerns.
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  buildGraphCommit, buildMigrationProvenanceReceipt, buildSourceStalenessReceipt,
  claimAssertionId, verifyGraphCommit, GRAPH_COMMIT_SCHEMA,
} from './claim-projection.mjs';
import { buildEvidencePointer, buildMention } from './argument-mentions.mjs';
import {
  buildIdentityConstraint, buildIdentityVerificationRegistryFromLookup,
  buildReferent, buildResolutionReceipt, verifyIdentityConstraint,
} from './referent-identity.mjs';
import {
  buildAssertionSupersessionReceipt, groundedAssertionId, servingAssertionId,
} from './serving-assertions.mjs';
import { sha256, stable, stableStringify } from './lib.mjs';

export const DEPENDENCY_INDEX_SCHEMA = 'estate-map/dependency-index/v1';
export const SEGMENT_MANIFEST_SCHEMA = 'estate-map/graph-segment-manifest/v1';
export const SEGMENT_SCHEMA_VERSION = 'graph-segment@1';
export const GRAPH_STORE_SCHEMA_VERSION = 'canonical-graph-store@1';

const digestPattern = /^[0-9a-f]{64}$/u;
const clean = value => String(value ?? '').trim();
const canonicalBytes = value => Buffer.from(stableStringify(value), 'utf8');
const compactCanonical = value => JSON.stringify(stable(value));
const exactEqual = (left, right) => stableStringify(left) === stableStringify(right);
const exactArray = values => [...new Set(values || [])].sort();

const schemaIdentities = Object.freeze({
  'estate-map/documentary-claim/v3.3': 'id',
  'estate-map/evidence-pointer/v1': 'evidence_id',
  'estate-map/mention/v1': 'mention_id',
  'estate-map/mention-discovery-coverage-receipt/v1': 'receipt_id',
  'estate-map/assertion-argument-obligation/v1': 'obligation_id',
  'estate-map/argument-binding-coverage-receipt/v1': 'receipt_id',
  'estate-map/claim-assertion/v1': 'assertion_id',
  'estate-map/claim-projection-receipt/v1': 'receipt_id',
  'estate-map/source-staleness-receipt/v1': 'receipt_id',
  'estate-map/migration-provenance-receipt/v1': 'receipt_id',
  'estate-map/grounded-assertion/v1': 'assertion_id',
  'estate-map/serving-assertion/v1': 'serving_assertion_id',
  'estate-map/referent/v1': 'referent_id',
  'estate-map/identity-constraint/v1': 'constraint_id',
  'estate-map/identity-conflict/v1': 'conflict_id',
  'estate-map/resolution-receipt/v1': 'receipt_id',
  'estate-map/identity-candidate-batch-receipt/v1': 'receipt_id',
  'estate-map/assertion-supersession-receipt/v1': 'receipt_id',
  [DEPENDENCY_INDEX_SCHEMA]: 'index_id',
});

export class CanonicalGraphStoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CanonicalGraphStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new CanonicalGraphStoreError(code, message, detail);
}

function requireDigest(value, label = 'digest') {
  if (!digestPattern.test(value || '')) fail('INVALID_DIGEST', `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CANONICAL_RECORD', `${label} must be an object`);
  }
  return value;
}

export function semanticObjectId(record) {
  requireRecord(record, 'semantic object');
  const field = schemaIdentities[record.schema];
  if (!field) fail('UNKNOWN_OBJECT_SCHEMA', `unsupported semantic object schema ${record.schema || '<missing>'}`);
  const id = clean(record[field]);
  if (!id) fail('MISSING_SEMANTIC_ID', `${record.schema} requires ${field}`);
  if (record.schema === DEPENDENCY_INDEX_SCHEMA) {
    const { index_id: _indexId, ...body } = record;
    const expected = `dependency-index:${sha256(canonicalBytes(body))}`;
    if (id !== expected) fail('INVALID_DEPENDENCY_INDEX_ID', 'dependency index identity differs from its exact canonical body');
  }
  return id;
}

function producerBodyId(prefix, record, idField) {
  const { [idField]: _declaredId, ...body } = record;
  return `${prefix}:${sha256(stableStringify(body).trim())}`;
}

function requireProducerMatch(record, expected, idField) {
  if (!exactEqual(record, expected) || record[idField] !== expected[idField]) {
    fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
  }
}

function validateProducerIdentity(record, lookup) {
  try {
    switch (record.schema) {
      // DocumentaryClaim identity is externally pinned immutable input. Its byte identity is
      // discharged by the committed claim_plane external head, not recomputed or rewritten here.
      case 'estate-map/documentary-claim/v3.3': break;
      case 'estate-map/evidence-pointer/v1':
        requireProducerMatch(record, buildEvidencePointer(record), 'evidence_id'); break;
      case 'estate-map/mention/v1': {
        const evidence = lookup(record.evidence_id);
        if (!evidence) {
          fail('PRODUCER_IDENTITY_PRECONDITION',
            `Mention ${record.mention_id} requires its producer-valid EvidencePointer at intake`);
        }
        const built = buildMention({
          evidence_pointer: evidence,
          surface: record.surface,
          role: record.role,
          mention_producer_version: record.mention_producer_version,
          claim_id: record.claim_id,
          proposition_key: record.proposition_key,
          candidate_obligation_id: record.candidate_obligation_id,
          provenance_class: record.provenance_class,
          namespace: record.namespace,
          source_status: record.source_status,
          context_digest: record.context_digest,
          disposition: record.disposition,
        });
        requireProducerMatch(record, built.mention, 'mention_id');
        break;
      }
      case 'estate-map/mention-discovery-coverage-receipt/v1':
        if (record.receipt_id !== producerBodyId('mention-discovery-receipt', record, 'receipt_id')) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      // AssertionArgumentObligation identity includes exact_value_bytes, which its stored record
      // intentionally omits. Intake therefore requires the pinned argument_substrate producer head;
      // inventing a weaker body hash here would falsely claim producer revalidation.
      case 'estate-map/assertion-argument-obligation/v1': break;
      case 'estate-map/argument-binding-coverage-receipt/v1':
        if (record.receipt_id !== producerBodyId('argument-binding-receipt', record, 'receipt_id')) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/claim-assertion/v1':
        if (record.assertion_id !== claimAssertionId(record)) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/claim-projection-receipt/v1':
        if (record.receipt_id !== producerBodyId('claim-projection-receipt', record, 'receipt_id')) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/source-staleness-receipt/v1':
        requireProducerMatch(record, buildSourceStalenessReceipt({
          prior_supporting_source_version_id: record.prior_supporting_source_version_id,
          from_state: record.from_state,
          to_state: record.to_state,
          transition_source_version_id: record.transition_source_version_id,
          materialization_id: record.materialization_id,
          projection_schema_version: record.projection_schema_version,
        }), 'receipt_id');
        break;
      case 'estate-map/migration-provenance-receipt/v1':
        requireProducerMatch(record, buildMigrationProvenanceReceipt({
          basis_claim_id: record.basis_claim_id,
          source_version: {
            source_version_id: record.source_version_id, captured_at: record.captured_at,
          },
          capture_basis: record.capture_basis,
          materialization_id: record.materialization_id,
          projection_schema_version: record.projection_schema_version,
        }), 'receipt_id');
        break;
      case 'estate-map/grounded-assertion/v1':
        if (record.assertion_id !== groundedAssertionId(record)) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/serving-assertion/v1':
        if (record.serving_assertion_id !== servingAssertionId(record)) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/referent/v1':
        if (record.identity_kind === 'resolved_opaque') {
          requireProducerMatch(record, buildReferent({
            identity_kind: record.identity_kind,
            creation_receipt_id: record.creation_receipt_id,
            lifecycle_state: record.lifecycle_state,
          }), 'referent_id');
        }
        // Source-native and deterministic-namespace identity keys live in pinned identity receipt
        // history and are deliberately absent from Referent bytes; that external head is required.
        break;
      // Store intake is boundary 3 of the closed constraint intake (C4 design section 3.1). It
      // shares the one verifier rather than repeating the reconstruction, so intake and resolver
      // cannot drift: a basis the resolver refuses can never be admitted to the store instead.
      // A ReferentIdentityError raised here is converted below to INVALID_PRODUCER_IDENTITY
      // carrying its producer_code, preserving this boundary's existing error contract.
      case 'estate-map/identity-constraint/v1':
        // Preserve source witnesses; do not infer authority from naming conventions alone.
        verifyIdentityConstraint(record);
        if (record.disposition === 'must_link') {
          const identityRegistry = buildIdentityVerificationRegistryFromLookup({
            constraint: record, lookup,
          });
          verifyIdentityConstraint(record, identityRegistry);
        }
        break;
      case 'estate-map/identity-conflict/v1':
        if (record.conflict_id !== producerBodyId('identity-conflict', record, 'conflict_id')) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/resolution-receipt/v1':
        requireProducerMatch(record, buildResolutionReceipt(record), 'receipt_id'); break;
      case 'estate-map/identity-candidate-batch-receipt/v1':
        if (record.receipt_id !== producerBodyId('identity-candidate-batch-receipt', record, 'receipt_id')) {
          fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity differs from its deterministic producer`);
        }
        break;
      case 'estate-map/assertion-supersession-receipt/v1':
        requireProducerMatch(record, buildAssertionSupersessionReceipt(record), 'receipt_id'); break;
      case DEPENDENCY_INDEX_SCHEMA: semanticObjectId(record); break;
      default: break;
    }
  } catch (error) {
    if (error instanceof CanonicalGraphStoreError) throw error;
    fail('INVALID_PRODUCER_IDENTITY', `${record.schema} identity could not be reproduced`, {
      producer_code: error?.code || null,
    });
  }
}

export function canonicalObject(record) {
  const semanticId = semanticObjectId(record);
  const bytes = canonicalBytes(record);
  return Object.freeze({ semantic_id: semanticId, digest: sha256(bytes), bytes });
}

export function semanticObjectReferences(record) {
  const refs = [];
  const add = value => { if (clean(value)) refs.push(value); };
  const addAll = values => { for (const value of values || []) add(value); };
  switch (record.schema) {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    case 'estate-map/mention/v1':
      add(record.evidence_id);
      // claim_id is immutable claim-plane metadata and candidate_obligation_id names an obligation
      // that C2 does not store; neither is an invalidation edge from this exact source occurrence.
      break;
    case 'estate-map/mention-discovery-coverage-receipt/v1': addAll(record.discovered_mention_ids); break;
    case 'estate-map/assertion-argument-obligation/v1':
      add(record.basis_claim_id); addAll(record.candidate_mention_ids); addAll(record.evidence_ids);
      add(record.mention_discovery_coverage_receipt_id); break;
    case 'estate-map/argument-binding-coverage-receipt/v1':
      addAll(record.selected_mention_ids); addAll(record.rejected_candidate_mention_ids);
      // obligation_id is intentionally undeclared because obligations are not selected C2 objects.
      break;
    case 'estate-map/claim-assertion/v1':
      add(record.basis_claim_id); add(record.projection_receipt_id);
      add(record.migration_provenance_receipt_id); addAll(record.source_staleness_receipt_ids);
      for (const row of record.argument_mentions || []) add(row.mention_id); break;
    case 'estate-map/claim-projection-receipt/v1':
      add(record.basis_claim_id); addAll(record.assertion_ids); addAll(record.argument_binding_receipt_ids); break;
    case 'estate-map/migration-provenance-receipt/v1': add(record.basis_claim_id); break;
    case 'estate-map/grounded-assertion/v1':
      addAll(record.basis_evidence_ids); addAll(record.basis_receipt_ids);
      for (const row of record.arguments || []) add(row.mention_id || row.referent_id || row.assertion_id); break;
    case 'estate-map/serving-assertion/v1':
      add(record.assertion_id); add(record.identity_batch_receipt_id);
      for (const row of record.selected_arguments || []) {
        add(row.resolution_receipt_id); add(row.referent_id);
        addAll(row.conflict_ids); addAll(row.blocking_constraint_ids);
      }
      break;
    case 'estate-map/referent/v1': add(record.creation_receipt_id); break;
    case 'estate-map/identity-constraint/v1':
      add(record.left); add(record.right);
      addAll(record.basis_evidence_ids); addAll(record.basis_assertion_ids); break;
    case 'estate-map/identity-conflict/v1':
      addAll(record.candidate_mention_ids); add(record.blocking_constraint_id); break;
    case 'estate-map/resolution-receipt/v1':
      addAll(record.candidate_mention_ids); add(record.selected_referent_id); addAll(record.identity_constraint_ids);
      addAll(record.conflict_ids); add(record.supersedes_receipt_id); break;
    case 'estate-map/identity-candidate-batch-receipt/v1':
      addAll(record.candidate_rows?.map(row => row.mention_id)); break;
    case 'estate-map/assertion-supersession-receipt/v1':
      add(record.old_assertion_id); add(record.new_assertion_id); addAll(record.basis_receipt_ids); break;
    // Dependency indexes are manifests of these edges and never depend on themselves.
    default: break;
  }
  return exactArray(refs);
}

function objectDependency(dependency) {
  requireRecord(dependency, 'dependency');
  const allowed = dependency.kind === 'object' ? ['kind', 'semantic_id', 'object_digest']
    : dependency.kind === 'external_head' ? ['kind', 'head_type', 'head_id'] : [];
  if (!allowed.length || Object.keys(dependency).some(key => !allowed.includes(key))) {
    fail('INVALID_DEPENDENCY_EDGE', 'dependency must be a closed object or external_head reference');
  }
  if (dependency.kind === 'object') {
    if (!clean(dependency.semantic_id)) fail('INVALID_DEPENDENCY_EDGE', 'object dependency requires semantic_id');
    requireDigest(dependency.object_digest, 'dependency target digest');
    return { kind: 'object', semantic_id: dependency.semantic_id, object_digest: dependency.object_digest };
  }
  if (!['source', 'identity', 'ontology', 'argument_substrate', 'claim_plane', 'code_plane'].includes(dependency.head_type)
    || !clean(dependency.head_id)) {
    fail('INVALID_DEPENDENCY_EDGE', 'external dependency requires a supported frozen producer head');
  }
  return { kind: 'external_head', head_type: dependency.head_type, head_id: dependency.head_id };
}

function compareDependencies(left, right) {
  return compactCanonical(left).localeCompare(compactCanonical(right));
}

export function buildDependencyIndex({ records, historical_records = [], external_heads, validation_contract }) {
  if (!Array.isArray(records) || !clean(validation_contract)) {
    fail('INVALID_DEPENDENCY_INDEX', 'dependency index requires records and a validation contract');
  }
  const heads = {
    source: clean(external_heads?.source),
    identity: clean(external_heads?.identity),
    ontology: clean(external_heads?.ontology),
    argument_substrate: clean(external_heads?.argument_substrate),
    claim_plane: clean(external_heads?.claim_plane),
    code_plane: clean(external_heads?.code_plane),
  };
  if (!heads.source) fail('INVALID_DEPENDENCY_INDEX', 'dependency index requires a frozen source head');
  const byId = new Map();
  for (const record of records) {
    const held = canonicalObject(record);
    if (byId.has(held.semantic_id)) fail('DUPLICATE_SEMANTIC_ID', `duplicate semantic object ${held.semantic_id}`);
    byId.set(held.semantic_id, held);
  }
  const dependencyObjects = new Map(byId);
  for (const record of historical_records) {
    const held = canonicalObject(record);
    const prior = dependencyObjects.get(held.semantic_id);
    if (prior && prior.digest !== held.digest) fail('FORKED_SEMANTIC_ID', `dependency target ${held.semantic_id} has conflicting bytes`);
    dependencyObjects.set(held.semantic_id, held);
  }
  const entries = [...byId.values()].map(held => {
    const record = JSON.parse(held.bytes);
    const dependencies = semanticObjectReferences(record).map(semanticId => {
      const target = dependencyObjects.get(semanticId);
      if (!target) fail('DANGLING_DEPENDENCY_EDGE', `${held.semantic_id} depends on missing ${semanticId}`);
      return { kind: 'object', semantic_id: semanticId, object_digest: target.digest };
    });
    const externalTypes = [];
    if (record.schema === 'estate-map/documentary-claim/v3.3') externalTypes.push('claim_plane');
    if (record.schema === 'estate-map/evidence-pointer/v1') {
      externalTypes.push(record.source_version_id?.startsWith('code-plane:') ? 'code_plane' : 'source');
    }
    if (['estate-map/source-staleness-receipt/v1',
      'estate-map/migration-provenance-receipt/v1'].includes(record.schema)) externalTypes.push('source');
    if (record.schema === 'estate-map/argument-binding-coverage-receipt/v1') externalTypes.push('argument_substrate');
    if (record.schema === 'estate-map/grounded-assertion/v1'
      && (record.scope || []).some(value => String(value).startsWith('code-plane:'))) {
      externalTypes.push('code_plane');
    }
    if (record.schema === 'estate-map/identity-candidate-batch-receipt/v1') {
      externalTypes.push('source', 'code_plane');
    }
    for (const headType of externalTypes) {
      const headId = heads[headType];
      if (!headId) fail('DANGLING_DEPENDENCY_EDGE', `${held.semantic_id} lacks frozen ${headType} head`);
      dependencies.push({ kind: 'external_head', head_type: headType, head_id: headId });
    }
    return {
      semantic_id: held.semantic_id,
      object_digest: held.digest,
      dependencies: dependencies.sort(compareDependencies),
      validation_contract,
    };
  }).sort((left, right) => left.semantic_id.localeCompare(right.semantic_id));
  const body = {
    schema: DEPENDENCY_INDEX_SCHEMA,
    graph_store_schema_version: GRAPH_STORE_SCHEMA_VERSION,
    external_heads: heads,
    entries,
  };
  return Object.freeze({ ...body, index_id: `dependency-index:${sha256(canonicalBytes(body))}` });
}

export function validateDependencyIndex(index, { selected_map = null, commit = null } = {}) {
  if (semanticObjectId(index) !== index.index_id || index.graph_store_schema_version !== GRAPH_STORE_SCHEMA_VERSION
    || !Array.isArray(index.entries) || !clean(index.external_heads?.source)) {
    fail('INVALID_DEPENDENCY_INDEX', 'dependency index differs from its closed C2 contract');
  }
  if (commit && (index.external_heads.source !== commit.source_head
    || index.external_heads.identity !== clean(commit.identity_head)
    || index.external_heads.ontology !== clean(commit.ontology_head))) {
    fail('DEPENDENCY_HEAD_MISMATCH', 'dependency index external heads differ from GraphCommit heads');
  }
  const ids = new Set();
  let prior = null;
  for (const entry of index.entries) {
    const fields = ['semantic_id', 'object_digest', 'dependencies', 'validation_contract'];
    if (!entry || Object.keys(entry).some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(entry, key)) || !clean(entry.semantic_id)
      || !clean(entry.validation_contract) || !Array.isArray(entry.dependencies)) {
      fail('INVALID_DEPENDENCY_ENTRY', 'dependency entry differs from its closed contract');
    }
    requireDigest(entry.object_digest, 'dependency object digest');
    if (ids.has(entry.semantic_id) || (prior && prior.localeCompare(entry.semantic_id) >= 0)) {
      fail('DUPLICATE_DEPENDENCY_ENTRY', `duplicate or unordered dependency entry ${entry.semantic_id}`);
    }
    ids.add(entry.semantic_id); prior = entry.semantic_id;
    const normalized = entry.dependencies.map(objectDependency).sort(compareDependencies);
    if (!exactEqual(normalized, entry.dependencies)) fail('INVALID_DEPENDENCY_ORDER', `dependencies for ${entry.semantic_id} are not ordered`);
  }
  // Resolve dependency targets through one exact index. A linear scan for every edge made replay
  // quadratic at the all-candidate estate scale (hundreds of thousands of entries/dependencies)
  // while proving no stronger invariant than this semantic-ID lookup.
  const entryById = new Map(index.entries.map(entry => [entry.semantic_id, entry]));
  for (const entry of index.entries) for (const dependency of entry.dependencies) {
    if (dependency.kind === 'object') {
      const selectedTarget = entryById.get(dependency.semantic_id);
      if (selectedTarget && selectedTarget.object_digest !== dependency.object_digest) {
        fail('DANGLING_DEPENDENCY_EDGE', `${entry.semantic_id} dependency digest disagrees for ${dependency.semantic_id}`);
      }
    }
    if (dependency.kind === 'external_head'
      && index.external_heads[dependency.head_type] !== dependency.head_id) {
      fail('DANGLING_DEPENDENCY_EDGE', `${entry.semantic_id} depends on an uncommitted external head`);
    }
  }
  if (selected_map) {
    const selected = selected_map instanceof Map ? selected_map : new Map(Object.entries(selected_map));
    if (selected.size !== index.entries.length) fail('DEPENDENCY_INDEX_OMISSION', 'dependency index does not cover the exact selected object map');
    for (const entry of index.entries) if (selected.get(entry.semantic_id) !== entry.object_digest) {
      fail('DEPENDENCY_INDEX_CONTENT_MISMATCH', `dependency index digest differs for ${entry.semantic_id}`);
    }
  }
  return true;
}

export function downstreamCone(index, changedSemanticIds) {
  validateDependencyIndex(index);
  const reverse = new Map();
  for (const entry of index.entries) for (const dependency of entry.dependencies) {
    if (dependency.kind !== 'object') continue;
    const held = reverse.get(dependency.semantic_id) || [];
    held.push(entry.semantic_id); reverse.set(dependency.semantic_id, held);
  }
  const cone = new Set(changedSemanticIds || []), queue = [...cone];
  while (queue.length) for (const dependent of reverse.get(queue.shift()) || []) if (!cone.has(dependent)) {
    cone.add(dependent); queue.push(dependent);
  }
  return [...cone].sort();
}

export function selectReusableObjects({ previous_index, next_index }) {
  validateDependencyIndex(previous_index); validateDependencyIndex(next_index);
  const previous = new Map(previous_index.entries.map(entry => [entry.semantic_id, entry]));
  return next_index.entries.filter(entry => {
    const prior = previous.get(entry.semantic_id);
    return prior && exactEqual(prior, entry);
  }).map(entry => entry.semantic_id).sort();
}

export function verifySelectedGraphEquivalence(expected, actual) {
  if (!exactEqual(actual?.selected_object_map, expected?.selected_object_map)
    || !exactEqual(actual?.dependency_index, expected?.dependency_index)
    || actual?.logical_graph_digest !== expected?.logical_graph_digest) {
    fail('CLEAN_INCREMENTAL_DIVERGENCE', 'selected objects, dependencies, or logical graph digest diverged');
  }
  return true;
}

function assertExplicitRoot(root) {
  if (!clean(root) || !isAbsolute(root)) fail('EXPLICIT_STORE_PATH_REQUIRED', 'graph store path must be explicit and absolute');
  return resolve(root);
}

export class CanonicalGraphStore {
  constructor(root) {
    this.root = assertExplicitRoot(root);
    for (const directory of ['objects', 'segments', 'commits', 'heads']) {
      mkdirSync(join(this.root, directory), { recursive: true });
    }
    this.semanticDigests = null;
    this.createdDirectories = new Set([
      join(this.root, 'objects'), join(this.root, 'segments'), join(this.root, 'commits'), join(this.root, 'heads'),
    ]);
  }

  objectPath(digest) {
    requireDigest(digest, 'object digest');
    return join(this.root, 'objects', digest.slice(0, 2), `${digest}.json`);
  }

  #loadSemanticDigests() {
    if (this.semanticDigests) return this.semanticDigests;
    const byId = new Map(), objectRoot = join(this.root, 'objects');
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const digest = entry.name.slice(0, -5);
          requireDigest(digest, 'stored object digest');
          if (this.objectPath(digest) !== path) fail('MALFORMED_OBJECT_PATH', `object ${digest} is not under its digest-only path`);
          const bytes = readFileSync(path);
          if (sha256(bytes) !== digest) fail('OBJECT_DIGEST_MISMATCH', `object path and bytes disagree for ${digest}`);
          let record;
          try { record = JSON.parse(bytes); }
          catch { fail('MALFORMED_OBJECT', `object ${digest} is not JSON`); }
          const held = canonicalObject(record);
          if (held.digest !== digest || !held.bytes.equals(bytes)) fail('NONCANONICAL_OBJECT', `object ${digest} is not exact canonical JSON`);
          const prior = byId.get(held.semantic_id);
          if (prior && prior !== digest) fail('SEMANTIC_ID_BYTES_CHANGED', `semantic object ${held.semantic_id} has multiple byte identities`);
          byId.set(held.semantic_id, digest);
        }
      }
    };
    visit(objectRoot);
    this.semanticDigests = byId;
    return byId;
  }

  #writeExclusive(path, bytes) {
    const directory = resolve(path, '..');
    if (!this.createdDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true });
      this.createdDirectories.add(directory);
    }
    try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readFileSync(path);
      if (!existing.equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))) {
        fail('IMMUTABLE_ARTIFACT_MISMATCH', `immutable artifact already exists with different bytes: ${path}`);
      }
    }
  }

  writeObject(record, { validation_lookup: validationLookup = null } = {}) {
    const semanticDigests = this.#loadSemanticDigests();
    validateProducerIdentity(record, semanticId => {
      const supplied = validationLookup?.(semanticId) || null;
      if (supplied) return supplied;
      const digest = semanticDigests.get(semanticId);
      return digest ? this.readObject(digest) : null;
    });
    const held = canonicalObject(record);
    const prior = semanticDigests.get(held.semantic_id);
    if (prior && prior !== held.digest) {
      fail('SEMANTIC_ID_BYTES_CHANGED', `semantic object ${held.semantic_id} was assigned changed bytes`);
    }
    const path = this.objectPath(held.digest);
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      if (sha256(bytes) !== held.digest || !bytes.equals(held.bytes)) {
        fail('OBJECT_CORRUPTION', `object ${held.digest} is corrupt or mismatched`);
      }
    } else this.#writeExclusive(path, held.bytes);
    semanticDigests.set(held.semantic_id, held.digest);
    return Object.freeze({ semantic_id: held.semantic_id, digest: held.digest });
  }

  readObject(digest) {
    const path = this.objectPath(digest);
    if (!existsSync(path) || !statSync(path).isFile()) fail('MISSING_OBJECT', `missing object ${digest}`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== digest) fail('OBJECT_DIGEST_MISMATCH', `object path and bytes disagree for ${digest}`);
    let record;
    try { record = JSON.parse(bytes); }
    catch { fail('MALFORMED_OBJECT', `object ${digest} is not JSON`); }
    const held = canonicalObject(record);
    if (held.digest !== digest || !held.bytes.equals(bytes)) fail('NONCANONICAL_OBJECT', `object ${digest} is not exact canonical JSON`);
    return record;
  }

  writeSegment(rows, { schema_version = SEGMENT_SCHEMA_VERSION } = {}) {
    if (!Array.isArray(rows) || !rows.length || !clean(schema_version)) fail('INVALID_SEGMENT', 'segment requires ordered rows and schema version');
    const normalized = rows.map(row => {
      const fields = ['semantic_id', 'object_digest'];
      if (!row || Object.keys(row).some(key => !fields.includes(key)) || fields.some(key => !clean(row[key]))) {
        fail('INVALID_SEGMENT_ROW', 'segment row must contain only semantic_id and object_digest');
      }
      requireDigest(row.object_digest, 'segment object digest');
      return { semantic_id: row.semantic_id, object_digest: row.object_digest };
    });
    const ids = normalized.map(row => row.semantic_id);
    if (new Set(ids).size !== ids.length || !exactEqual(ids, ids.slice().sort())) {
      fail('INVALID_SEGMENT_ORDER', 'segment rows must be uniquely ordered by semantic ID');
    }
    const bytes = Buffer.from(`${normalized.map(compactCanonical).join('\n')}\n`, 'utf8');
    const segmentDigest = sha256(Buffer.concat([Buffer.from(`${schema_version}\0`, 'utf8'), bytes]));
    const body = {
      schema: SEGMENT_MANIFEST_SCHEMA,
      schema_version,
      segment_digest: segmentDigest,
      row_count: normalized.length,
      row_byte_digests: bytes.toString('utf8').trimEnd().split('\n').map(row => sha256(row)),
      content_digest: sha256(bytes),
    };
    const manifest = { ...body, segment_id: `segment:${sha256(canonicalBytes(body))}` };
    const base = join(this.root, 'segments', segmentDigest);
    this.#writeExclusive(`${base}.jsonl`, bytes);
    this.#writeExclusive(`${base}.manifest.json`, canonicalBytes(manifest));
    return Object.freeze({ segment_id: manifest.segment_id, segment_digest: segmentDigest });
  }

  readSegment(reference) {
    const segmentDigest = requireDigest(reference?.segment_digest, 'segment digest');
    const base = join(this.root, 'segments', segmentDigest);
    if (!existsSync(`${base}.jsonl`) || !existsSync(`${base}.manifest.json`)) {
      fail('MISSING_SEGMENT', `segment ${segmentDigest} is incomplete`);
    }
    const bytes = readFileSync(`${base}.jsonl`);
    let manifest;
    try { manifest = JSON.parse(readFileSync(`${base}.manifest.json`, 'utf8')); }
    catch { fail('MALFORMED_SEGMENT_MANIFEST', `segment ${segmentDigest} manifest is malformed`); }
    const { segment_id: segmentId, ...body } = manifest;
    if (manifest.schema !== SEGMENT_MANIFEST_SCHEMA || segmentId !== `segment:${sha256(canonicalBytes(body))}`
      || segmentId !== reference.segment_id || sha256(bytes) !== manifest.content_digest
      || sha256(Buffer.concat([Buffer.from(`${manifest.schema_version}\0`, 'utf8'), bytes])) !== segmentDigest) {
      fail('SEGMENT_INTEGRITY_MISMATCH', `segment ${segmentDigest} bytes or manifest changed`);
    }
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n')) fail('SEGMENT_TRUNCATED', `segment ${segmentDigest} lacks its terminal newline`);
    const lines = text.slice(0, -1).split('\n');
    if (lines.length !== manifest.row_count
      || !exactEqual(lines.map(line => sha256(line)), manifest.row_byte_digests)) {
      fail('SEGMENT_ROW_MISMATCH', `segment ${segmentDigest} rows were truncated, reordered, or replaced`);
    }
    let rows;
    try { rows = lines.map(line => JSON.parse(line)); }
    catch { fail('MALFORMED_SEGMENT', `segment ${segmentDigest} contains malformed JSONL`); }
    const ids = rows.map(row => row.semantic_id);
    if (new Set(ids).size !== ids.length || !exactEqual(ids, ids.slice().sort())
      || rows.some((row, index) => compactCanonical(row) !== lines[index])) {
      fail('SEGMENT_ROW_MISMATCH', `segment ${segmentDigest} row order or canonical bytes changed`);
    }
    return rows;
  }

  writeCommit(input) {
    const commit = buildGraphCommit(input);
    verifyGraphCommit({ graph_commit: commit, claim_projection_receipts: input.claim_projection_receipts || [] });
    const digest = commit.graph_commit_id.split(':')[1];
    requireDigest(digest, 'graph commit digest');
    this.#writeExclusive(join(this.root, 'commits', `${digest}.json`), canonicalBytes(commit));
    return commit;
  }

  readCommit(commitId) {
    const [prefix, digest, extra] = String(commitId || '').split(':');
    if (prefix !== 'graph-commit' || extra != null) fail('INVALID_GRAPH_COMMIT_ID', 'GraphCommit ID is malformed');
    requireDigest(digest, 'graph commit digest');
    const path = join(this.root, 'commits', `${digest}.json`);
    if (!existsSync(path)) fail('MISSING_GRAPH_COMMIT', `missing GraphCommit ${commitId}`);
    let commit;
    try { commit = JSON.parse(readFileSync(path, 'utf8')); }
    catch { fail('MALFORMED_GRAPH_COMMIT', `GraphCommit ${commitId} is malformed`); }
    verifyGraphCommit({ graph_commit: commit });
    if (commit.graph_commit_id !== commitId || !canonicalBytes(commit).equals(readFileSync(path))) {
      fail('GRAPH_COMMIT_DIGEST_MISMATCH', `GraphCommit ${commitId} path or bytes disagree`);
    }
    return commit;
  }

  replay(commitId) {
    const reverse = [], seenCommits = new Set();
    let current = commitId;
    while (current) {
      // graph_commit_id hashes parent_graph_commit_id, so a genuine immutable on-disk cycle is
      // unconstructible. Keep this guard as defensive depth; stubbed-cycle tests prove only the guard.
      if (seenCommits.has(current)) fail('GRAPH_COMMIT_CYCLE', `GraphCommit chain cycles at ${current}`);
      seenCommits.add(current);
      const commit = this.readCommit(current);
      reverse.push(commit); current = commit.parent_graph_commit_id;
    }
    const selected = new Map(), tombstoned = new Set(), usedSegments = new Set();
    let dependencyIndex = null;
    for (const commit of reverse.reverse()) {
      const segmentRows = [];
      for (const reference of commit.segment_references) {
        if (usedSegments.has(reference.segment_id)) fail('SEGMENT_REUSED', `segment ${reference.segment_id} appears twice in one chain`);
        usedSegments.add(reference.segment_id);
        for (const row of this.readSegment(reference)) segmentRows.push(row);
      }
      const segmentDigests = segmentRows.map(row => row.object_digest).sort();
      if (!exactEqual(segmentDigests, commit.added_object_digests)) {
        fail('COMMIT_SEGMENT_MISMATCH', `GraphCommit ${commit.graph_commit_id} segment rows differ from added objects`);
      }
      const additions = new Map();
      for (const digest of commit.added_object_digests) {
        const record = this.readObject(digest), semanticId = semanticObjectId(record);
        if (additions.has(semanticId)) fail('DUPLICATE_SEMANTIC_ID', `commit adds ${semanticId} twice`);
        additions.set(semanticId, { digest, record });
      }
      const receiptByOld = new Map();
      for (const receiptId of commit.assertion_supersession_receipt_ids) {
        const held = [...additions.values(), ...[...selected].map(([id, digest]) => ({ digest, record: this.readObject(digest), semanticId: id }))]
          .find(row => semanticObjectId(row.record) === receiptId)?.record;
        if (!held || held.schema !== 'estate-map/assertion-supersession-receipt/v1') {
          fail('MISSING_SUPERSESSION_RECEIPT', `commit cites missing supersession receipt ${receiptId}`);
        }
        if (receiptByOld.has(held.old_assertion_id)) fail('DUPLICATE_SUPERSESSION_RECEIPT', `multiple receipts supersede ${held.old_assertion_id}`);
        receiptByOld.set(held.old_assertion_id, held);
      }
      for (const semanticId of commit.superseded_object_ids) {
        if (!selected.has(semanticId) || !receiptByOld.has(semanticId)) {
          fail('SUPERSESSION_WITHOUT_RECEIPT', `cannot supersede ${semanticId} without one exact receipt`);
        }
        selected.delete(semanticId);
      }
      for (const semanticId of commit.tombstones) {
        if (tombstoned.has(semanticId)) fail('DOUBLE_TOMBSTONE', `${semanticId} was tombstoned twice`);
        if (!selected.has(semanticId) || commit.superseded_object_ids.includes(semanticId)) {
          fail('INVALID_TOMBSTONE', `cannot tombstone absent or superseded ${semanticId}`);
        }
        selected.delete(semanticId); tombstoned.add(semanticId);
      }
      for (const [semanticId, held] of additions) {
        if (selected.has(semanticId) && selected.get(semanticId) !== held.digest) {
          fail('FORKED_SEMANTIC_ID', `GraphCommit selects changed bytes under ${semanticId}`);
        }
        if (tombstoned.has(semanticId)) fail('RESURRECTED_TOMBSTONE', `GraphCommit resurrects ${semanticId}`);
        selected.set(semanticId, held.digest);
      }
      for (const receipt of receiptByOld.values()) {
        if (!selected.has(receipt.new_assertion_id)) fail('DANGLING_SUPERSESSION', `supersession tip ${receipt.new_assertion_id} is absent`);
      }
      const indexRecord = this.readObject(commit.dependency_index_digest);
      if (indexRecord.schema !== DEPENDENCY_INDEX_SCHEMA) fail('INVALID_COMMITTED_DEPENDENCY_INDEX', 'committed dependency digest is not an index');
      validateDependencyIndex(indexRecord, { selected_map: selected, commit });
      for (const entry of indexRecord.entries) for (const dependency of entry.dependencies) {
        if (dependency.kind !== 'object') continue;
        // A selected target was already read and content-verified while assembling additions, and
        // validateDependencyIndex just proved its semantic ID/digest pair. Read bytes here only for
        // a historical dependency that is deliberately outside the selected map.
        if (selected.get(dependency.semantic_id) === dependency.object_digest) continue;
        const record = this.readObject(dependency.object_digest);
        if (semanticObjectId(record) !== dependency.semantic_id) {
          fail('DANGLING_DEPENDENCY_EDGE', `${entry.semantic_id} dependency bytes disagree for ${dependency.semantic_id}`);
        }
      }
      dependencyIndex = indexRecord;
      const incompleteReceipts = [...selected.values()].map(digest => this.readObject(digest))
        .filter(row => row.schema === 'estate-map/claim-projection-receipt/v1'
          && row.disposition === 'terminal_incomplete');
      const expectedReceiptIds = incompleteReceipts.map(row => row.receipt_id).sort();
      const expectedClaimIds = incompleteReceipts.map(row => row.basis_claim_id).sort();
      const expectedStatus = incompleteReceipts.length ? 'incomplete' : 'complete';
      if (commit.claim_projection_status !== expectedStatus
        || !exactEqual(commit.incomplete_claim_projection_receipt_ids, expectedReceiptIds)
        || !exactEqual(commit.incomplete_claim_ids, expectedClaimIds)) {
        fail('COMMIT_INCOMPLETE_SET_MISMATCH',
          `GraphCommit ${commit.graph_commit_id} disagrees with selected terminal-incomplete receipts`);
      }
    }
    const selectedObjectMap = Object.fromEntries([...selected].sort(([left], [right]) => left.localeCompare(right)));
    const logicalGraphDigest = sha256(canonicalBytes(selectedObjectMap));
    return Object.freeze({ graph_commit_id: commitId, selected_object_map: selectedObjectMap,
      dependency_index: dependencyIndex, logical_graph_digest: logicalGraphDigest });
  }

  advanceReadableHead(commitId) {
    this.replay(commitId);
    const path = join(this.root, 'heads', 'selected');
    const temp = `${path}.candidate-${randomBytes(8).toString('hex')}`;
    writeFileSync(temp, `${commitId}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    return commitId;
  }

  readReadableHead() {
    const path = join(this.root, 'heads', 'selected');
    if (!existsSync(path)) return null;
    const commitId = readFileSync(path, 'utf8').trim();
    return this.replay(commitId);
  }
}
