// C3a disposable Neo4j serving projection over an authoritative C2 GraphCommit.
//
// The projection is deliberately versioned instead of destructive: candidate nodes and edges are
// written inside one Neo4j transaction, verified while uncommitted, receipted, and only then made
// readable by advancing C3GraphHead in the same commit. Canonical C2 artifacts remain authoritative.
import { sha256, stableCanonicalSha256, stableStringify } from './lib.mjs';
import { resolveAssertionSupersession } from './serving-assertions.mjs';

export const RELATION_PROJECTION_POLICY_SCHEMA = 'estate-map/relation-projection-policy/v1';
export const RELATION_RECONCILIATION_RECEIPT_SCHEMA = 'estate-map/relation-reconciliation-receipt/v1';
export const NEO4J_PROJECTION_RECEIPT_SCHEMA = 'estate-map/neo4j-projection-receipt/v1';
export const C3_PROJECTION_VERSION = 'neo4j-serving-projection@1';

const edgeTypes = Object.freeze([
  'PREDICATE', 'ARGUMENT', 'SUPPORTED_BY', 'DERIVED_FROM', 'SOURCE_VERSION', 'RESOLVES_TO',
]);
const edgeTypeSet = new Set(edgeTypes);
const verificationSampleLimit = 20;
const forbiddenPorts = new Set(['7474', '7687']);
const clean = value => String(value ?? '').trim();
const canonical = value => stableStringify(value).trim();
const exactEqual = (left, right) => canonical(left) === canonical(right);
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const sortedUnique = values => [...new Set(values || [])].sort();

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const held of Object.values(value)) deepFreeze(held);
  return Object.freeze(value);
}

export class C3ProjectionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'C3ProjectionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new C3ProjectionError(code, message, detail);
}

function requireId(value, label) {
  if (!clean(value)) fail('MISSING_C3_ID', `${label} is required`);
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_C3_RECORD', `${label} must be an object`);
  }
  return value;
}

function closedRecord(value, fields, label) {
  requireRecord(value, label);
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  const missing = fields.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail('INVALID_C3_RECORD_SHAPE', `${label} differs from its closed contract`, { unknown, missing });
  }
}

function exactStringSet(values, label, { empty = false } = {}) {
  if (!Array.isArray(values) || values.some(value => !clean(value))) {
    fail('INVALID_RELATION_POLICY', `${label} must be an array of non-empty strings`);
  }
  const exact = sortedUnique(values);
  if ((!empty && !exact.length) || !exactEqual(values, exact)) {
    fail('INVALID_RELATION_POLICY', `${label} must be a sorted unique set`);
  }
  return exact;
}

/** Build the exact frozen §7.3 policy. Every field participates in policy identity. */
export function buildRelationProjectionPolicy({
  eligible_predicate_concept_ids,
  accepted_source_statuses,
  accepted_decision_statuses,
  accepted_polarities,
  accepted_modalities,
  argument_cardinality,
  deduplication_key,
  projection_version = C3_PROJECTION_VERSION,
}) {
  const cardinalityFields = ['subject_roles', 'object_roles', 'exact_total'];
  closedRecord(argument_cardinality, cardinalityFields, 'RelationProjectionPolicy.argument_cardinality');
  const cardinality = {
    subject_roles: exactStringSet(argument_cardinality.subject_roles, 'subject_roles'),
    object_roles: exactStringSet(argument_cardinality.object_roles, 'object_roles'),
    exact_total: argument_cardinality.exact_total,
  };
  if (!Number.isInteger(cardinality.exact_total) || cardinality.exact_total < 2) {
    fail('INVALID_RELATION_POLICY', 'argument_cardinality.exact_total must be an integer of at least two');
  }
  const allowedDeduplicationFields = [
    'predicate_id', 'subject_referent_id', 'object_referent_id', 'assertion_id',
  ];
  const deduplication = exactStringSet(deduplication_key, 'deduplication_key');
  if (deduplication.some(field => !allowedDeduplicationFields.includes(field))
    || !['predicate_id', 'subject_referent_id', 'object_referent_id']
      .every(field => deduplication.includes(field))) {
    fail('INVALID_RELATION_POLICY', 'deduplication_key must contain the three relation identity fields');
  }
  requireId(projection_version, 'projection_version');
  const body = {
    schema: RELATION_PROJECTION_POLICY_SCHEMA,
    eligible_predicate_concept_ids: exactStringSet(eligible_predicate_concept_ids,
      'eligible_predicate_concept_ids', { empty: true }),
    accepted_source_statuses: exactStringSet(accepted_source_statuses, 'accepted_source_statuses'),
    accepted_decision_statuses: exactStringSet(accepted_decision_statuses, 'accepted_decision_statuses'),
    accepted_polarities: exactStringSet(accepted_polarities, 'accepted_polarities'),
    accepted_modalities: exactStringSet(accepted_modalities, 'accepted_modalities'),
    argument_cardinality: cardinality,
    deduplication_key: deduplication,
    projection_version,
  };
  return deepFreeze({ ...body, policy_id: hashId('relation-projection-policy', body) });
}

export function verifyRelationProjectionPolicy(policy) {
  requireRecord(policy, 'RelationProjectionPolicy');
  const rebuilt = buildRelationProjectionPolicy(policy);
  if (!exactEqual(policy, rebuilt)) {
    fail('RELATION_POLICY_IDENTITY_MISMATCH', 'RelationProjectionPolicy identity differs from its exact frozen body');
  }
  return true;
}

/** Connection is always explicit. URI credentials and implicit/default ports are rejected. */
export function parseNeo4jConnectionTarget({ uri, username, password }) {
  if (!clean(uri) || !clean(username) || !clean(password)) {
    fail('EXPLICIT_NEO4J_CONNECTION_REQUIRED', 'Neo4j URI, username, and password are required explicit inputs');
  }
  let parsed;
  try { parsed = new URL(uri); }
  catch { fail('INVALID_NEO4J_CONNECTION_TARGET', 'Neo4j URI is not parseable'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.hostname || !parsed.port
    || !['', '/'].includes(parsed.pathname)) {
    fail('INVALID_NEO4J_CONNECTION_TARGET',
      'Neo4j target must be an explicit credential-free HTTP(S) origin with an explicit port');
  }
  if (forbiddenPorts.has(parsed.port)) {
    fail('PROTECTED_NEO4J_PORT', `Neo4j port ${parsed.port} is protected and cannot be used`);
  }
  return deepFreeze({ origin: parsed.origin, username, password });
}

function responseErrors(payload) {
  return Array.isArray(payload?.errors) ? payload.errors : [];
}

function ensureSameOrigin(url, origin) {
  const parsed = new URL(url);
  if (parsed.origin !== origin || !parsed.pathname.startsWith('/db/neo4j/tx/')) {
    fail('NEO4J_TRANSACTION_ORIGIN_MISMATCH', 'Neo4j returned an unsafe transaction endpoint');
  }
  return parsed.href;
}

/** Minimal standard-Node Neo4j transactional HTTP client; it sends only to the supplied origin. */
export class Neo4jHttpClient {
  constructor(connection) {
    this.connection = parseNeo4jConnectionTarget(connection);
    this.authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`, 'utf8').toString('base64')}`;
  }

  async request(url, { method = 'POST', statements = null } = {}) {
    const target = new URL(url, this.connection.origin);
    if (target.origin !== this.connection.origin) {
      fail('NEO4J_REQUEST_ORIGIN_MISMATCH', 'refusing to send Neo4j credentials outside the explicit origin');
    }
    let response;
    try {
      response = await fetch(target, {
        method,
        headers: {
          accept: 'application/json',
          authorization: this.authorization,
          ...(statements == null ? {} : { 'content-type': 'application/json' }),
        },
        body: statements == null ? undefined : JSON.stringify({ statements }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail('NEO4J_REQUEST_FAILED', 'Neo4j request failed at the explicit target');
    }
    let payload = {};
    if (response.status !== 204) {
      try { payload = await response.json(); }
      catch { fail('NEO4J_INVALID_RESPONSE', 'Neo4j returned a non-JSON response'); }
    }
    const errors = responseErrors(payload);
    if (!response.ok || errors.length) {
      fail('NEO4J_STATEMENT_FAILED', 'Neo4j rejected a projection statement', {
        status: response.status,
        codes: errors.map(error => error.code || 'unknown'),
        // A syntax or semantic complaint is the caller's own statement described back; without it
        // an agent holding a rejected query has nothing to correct. Parameter values are never
        // echoed by Neo4j in these messages, and the statement is the caller's to begin with.
        messages: errors.map(error => String(error.message || '').slice(0, 500)),
      });
    }
    return { payload, response };
  }

  async query(statement, parameters = {}) {
    const { payload } = await this.request('/db/neo4j/tx/commit', {
      statements: [{ statement, parameters, resultDataContents: ['row'] }],
    });
    return payload.results?.[0]?.data?.map(row => row.row) || [];
  }

  async begin(statements = []) {
    const { payload, response } = await this.request('/db/neo4j/tx', { statements });
    const commit = payload.commit || response.headers.get('location');
    if (!commit) fail('NEO4J_TRANSACTION_ENDPOINT_MISSING', 'Neo4j omitted the transaction endpoint');
    const commitUrl = ensureSameOrigin(commit, this.connection.origin);
    return deepFreeze({ commit_url: commitUrl, transaction_url: commitUrl.replace(/\/commit$/u, '') });
  }

  async run(transaction, statements) {
    const { payload } = await this.request(transaction.transaction_url, { statements });
    return payload.results || [];
  }

  async commit(transaction, statements = []) {
    const { payload } = await this.request(transaction.commit_url, { statements });
    return payload.results || [];
  }

  async rollback(transaction) {
    try { await this.request(transaction.transaction_url, { method: 'DELETE' }); }
    catch { /* A failed Neo4j transaction may already have been rolled back server-side. */ }
  }

  async readHead() {
    const rows = await this.query(`
      OPTIONAL MATCH (h:C3GraphHead {slot: 'selected'})
      RETURN h.current_projection_id, h.graph_commit_id, h.policy_id,
             h.content_digest, h.projection_receipt_id
    `);
    const row = rows[0] || [null, null, null, null, null];
    return deepFreeze({
      projection_id: row[0] || null,
      graph_commit_id: row[1] || null,
      policy_id: row[2] || null,
      content_digest: row[3] || null,
      projection_receipt_id: row[4] || null,
    });
  }
}

function schemaKind(schema) {
  if (schema === 'estate-map/documentary-claim/v3.3') return 'DocumentaryClaim';
  if (schema === 'estate-map/evidence-pointer/v1') return 'EvidencePointer';
  if (schema === 'estate-map/mention/v1') return 'Mention';
  if (schema === 'estate-map/referent/v1') return 'Referent';
  if (schema === 'estate-map/serving-assertion/v1') return 'ServingAssertion';
  if (schema?.includes('receipt/')) return 'Receipt';
  if (schema?.includes('constraint/')) return 'Constraint';
  return 'CanonicalRecord';
}

function recordIdentity(record) {
  for (const field of [
    'serving_assertion_id', 'assertion_id', 'referent_id', 'mention_id', 'evidence_id',
    'receipt_id', 'constraint_id', 'conflict_id', 'id', 'index_id',
  ]) if (clean(record?.[field])) return record[field];
  fail('MISSING_PROJECTABLE_RECORD_ID', `selected ${record?.schema || '<missing>'} record lacks an identity`);
}

function safeScalar(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return canonical(value);
}

function compactRecordProperties(record) {
  const keys = [
    'schema', 'id', 'mention_id', 'evidence_id', 'referent_id', 'receipt_id', 'constraint_id',
    'identity_kind', 'lifecycle_state', 'source_version_id', 'access_policy_id', 'surface', 'role',
    'namespace', 'source_status', 'disposition', 'basis_claim_id', 'materialization_id',
    'creation_receipt_id', 'selected_referent_id', 'constraint_kind', 'left', 'right', 'authority',
  ];
  const properties = Object.fromEntries(keys.filter(key => Object.hasOwn(record, key))
    .map(key => [key, safeScalar(record[key])]));
  if (record.schema === 'estate-map/evidence-pointer/v1') {
    const pointer = record.pointer || {};
    Object.assign(properties, {
      pointer_kind: safeScalar(pointer.kind),
      document_path: safeScalar(pointer.file),
      line_start: safeScalar(pointer.start),
      line_end: safeScalar(pointer.end),
      byte_start: safeScalar(pointer.byte_start),
      byte_end: safeScalar(pointer.byte_end),
      exact_text: safeScalar(pointer.exact_text),
      evidence_digest: safeScalar(pointer.digest),
    });
    if (pointer.kind === 'structured_record') Object.assign(properties, {
      record_id: safeScalar(pointer.record_id),
      record_schema_id: safeScalar(pointer.schema_id),
      record_field_path: safeScalar(pointer.field_path),
      record_value_json: canonical(pointer.exact_value),
    });
  }
  if (record.schema === 'estate-map/documentary-claim/v3.3') {
    const spans = (record.semantic?.support_sets || []).flatMap(set => set.locators || []).map(locator => ({
      document_path: locator.file,
      line_start: locator.start,
      line_end: locator.end,
      byte_start: locator.byte_start,
      byte_end: locator.byte_end,
      evidence_digest: locator.text_digest,
    }));
    properties.support_spans_json = canonical(spans);
  }
  if (record.schema === 'estate-map/identity-constraint/v1') {
    properties.basis_json = canonical(record.basis);
    properties.basis_evidence_ids_json = canonical(record.basis_evidence_ids);
    properties.basis_assertion_ids_json = canonical(record.basis_assertion_ids);
    properties.valid_time_json = canonical(record.valid_time);
  }
  if (record.schema === 'estate-map/resolution-receipt/v1') {
    properties.admitted_mention_ids_json = canonical(record.admitted_mention_ids);
    properties.excluded_mention_ids_json = canonical(record.excluded_mention_ids);
    properties.identity_constraint_ids_json = canonical(record.identity_constraint_ids);
    properties.conflict_ids_json = canonical(record.conflict_ids);
  }
  return properties;
}

function edgeKey(edge) {
  return canonical([edge.type, edge.from, edge.to, edge.properties]);
}

function selectedPredicate(raw) {
  if (clean(raw?.predicate_concept_id)) {
    return { predicate_id: raw.predicate_concept_id, predicate_kind: 'concept', value: raw.predicate_concept_id };
  }
  if (clean(raw?.predicate_lexeme_id)) {
    return { predicate_id: raw.predicate_lexeme_id, predicate_kind: 'lexeme', value: raw.predicate_lexeme_id };
  }
  if (clean(raw?.predicate_lexeme)) {
    return {
      predicate_id: hashId('predicate-lexeme', { exact: raw.predicate_lexeme }),
      predicate_kind: 'lexeme',
      value: raw.predicate_lexeme,
    };
  }
  return {
    predicate_id: hashId('unresolved-predicate', { assertion_id: raw?.assertion_id }),
    predicate_kind: 'unresolved',
    value: null,
  };
}

function projectionRecordsFromStore(store, graphCommitId) {
  if (!store || typeof store.replay !== 'function' || typeof store.readObject !== 'function') {
    fail('C2_STORE_REQUIRED', 'projection requires the live C2 store producer boundary');
  }
  const replay = store.replay(graphCommitId);
  const commit = store.readCommit(graphCommitId);
  const records = Object.entries(replay.selected_object_map)
    .map(([semanticId, digest]) => ({ semantic_id: semanticId, digest, record: store.readObject(digest) }));
  return { commit, replay, records };
}

function normalizeInput({ store, graph_commit_id, commit, replay, records }) {
  if (store) return projectionRecordsFromStore(store, graph_commit_id);
  requireRecord(commit, 'GraphCommit');
  requireId(commit.graph_commit_id, 'graph_commit_id');
  if (commit.graph_commit_id !== graph_commit_id || !Array.isArray(records)) {
    fail('C2_COMMIT_INPUT_MISMATCH', 'projection records must name their exact GraphCommit');
  }
  const normalized = records.map(row => {
    const record = row.record || row;
    const semanticId = row.semantic_id || recordIdentity(record);
    const digest = row.digest || sha256(canonical(record));
    return { semantic_id: semanticId, digest, record };
  });
  const selected = Object.fromEntries(normalized.map(row => [row.semantic_id, row.digest]));
  return {
    commit,
    replay: replay || {
      graph_commit_id,
      selected_object_map: selected,
      logical_graph_digest: sha256(canonical(selected)),
    },
    records: normalized,
  };
}

function policyDisposition(raw, predicate, policy) {
  if (predicate.predicate_kind !== 'concept'
    || !policy.eligible_predicate_concept_ids.includes(predicate.predicate_id)) return 'predicate';
  if (!policy.accepted_source_statuses.includes(raw.source_status)) return 'source_status';
  if (!policy.accepted_decision_statuses.includes(raw.decision_status)) return 'decision_status';
  if (!policy.accepted_polarities.includes(raw.polarity)) return 'polarity';
  if (!policy.accepted_modalities.includes(raw.modality)) return 'modality';
  return null;
}

function relationCandidate({ request, servingByAssertion, policy, supersessionLedger }) {
  const requestedAssertionId = request.assertion_id;
  let chain = {
    requested_assertion_id: requestedAssertionId,
    selected_tip_assertion_id: requestedAssertionId,
    assertion_chain: [requestedAssertionId],
    supersession_receipt_chain: [],
  };
  if (supersessionLedger) {
    // This call is the C1 contract. C3 never reconstructs or weakens supersession validation.
    chain = resolveAssertionSupersession({ assertion_id: requestedAssertionId, ledger: supersessionLedger });
  }
  const serving = servingByAssertion.get(chain.selected_tip_assertion_id);
  if (!serving) {
    fail('REL_SELECTED_ASSERTION_MISSING', 'REL candidate does not resolve to one selected serving assertion', {
      selected_tip_assertion_id: chain.selected_tip_assertion_id,
    });
  }
  const raw = serving.raw_assertion;
  const predicate = selectedPredicate(raw);
  const policyFailure = policyDisposition(raw, predicate, policy);
  if (policyFailure) {
    fail('REL_POLICY_REJECTED', `REL candidate violates frozen policy field ${policyFailure}`, {
      requested_assertion_id: requestedAssertionId,
      selected_tip_assertion_id: chain.selected_tip_assertion_id,
      policy_field: policyFailure,
    });
  }
  const args = serving.selected_arguments || [];
  if (args.length !== policy.argument_cardinality.exact_total) {
    fail('REL_ARGUMENT_CARDINALITY', 'REL candidate violates frozen argument cardinality');
  }
  const subjects = args.filter(row => policy.argument_cardinality.subject_roles.includes(row.role));
  const objects = args.filter(row => policy.argument_cardinality.object_roles.includes(row.role));
  if (subjects.length !== 1 || objects.length !== 1
    || subjects[0].argument_kind !== 'referent' || objects[0].argument_kind !== 'referent') {
    fail('REL_ARGUMENT_CARDINALITY', 'REL requires one selected referent in each frozen endpoint role');
  }
  return {
    reference_id: request.reference_id,
    requested_assertion_id: requestedAssertionId,
    selected_assertion_id: chain.selected_tip_assertion_id,
    assertion_chain: chain.assertion_chain,
    supersession_receipt_chain: chain.supersession_receipt_chain,
    predicate_id: predicate.predicate_id,
    subject_referent_id: subjects[0].referent_id,
    object_referent_id: objects[0].referent_id,
  };
}

function relationProjection({ servingRecords, policy, commit, relationRequests, supersessionLedger }) {
  const servingByAssertion = new Map(servingRecords.map(record => [record.assertion_id, record]));
  if (servingByAssertion.size !== servingRecords.length) {
    fail('DUPLICATE_SELECTED_ASSERTION', 'selected serving assertions must be unique by raw assertion ID');
  }
  let requests = relationRequests;
  if (requests == null) {
    requests = servingRecords.filter(serving => {
      const raw = serving.raw_assertion;
      const predicate = selectedPredicate(raw);
      if (policyDisposition(raw, predicate, policy)) return false;
      const args = serving.selected_arguments || [];
      return args.length === policy.argument_cardinality.exact_total
        && args.some(row => policy.argument_cardinality.subject_roles.includes(row.role)
          && row.argument_kind === 'referent')
        && args.some(row => policy.argument_cardinality.object_roles.includes(row.role)
          && row.argument_kind === 'referent');
    }).map(row => ({ reference_id: `relation-reference:${row.assertion_id}`, assertion_id: row.assertion_id }));
  }
  if (!Array.isArray(requests)) fail('INVALID_RELATION_REQUESTS', 'relation_requests must be an array');
  const candidates = requests.map(request => {
    const fields = ['reference_id', 'assertion_id'];
    closedRecord(request, fields, 'relation request');
    requireId(request.reference_id, 'relation reference_id');
    requireId(request.assertion_id, 'relation assertion_id');
    return relationCandidate({ request, servingByAssertion, policy, supersessionLedger });
  });
  if (new Set(candidates.map(row => row.reference_id)).size !== candidates.length) {
    fail('DUPLICATE_RELATION_REFERENCE', 'relation reference IDs must be unique');
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const key = canonical(Object.fromEntries(policy.deduplication_key.map(field => [field,
      field === 'assertion_id' ? candidate.selected_assertion_id : candidate[field]])));
    const held = groups.get(key) || [];
    held.push(candidate); groups.set(key, held);
  }
  const relations = [], receipts = [];
  for (const [deduplicationValue, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = group.slice().sort((left, right) =>
      left.selected_assertion_id.localeCompare(right.selected_assertion_id));
    const selectedAssertionIds = sortedUnique(ordered.map(row => row.selected_assertion_id));
    const referenceIds = sortedUnique(ordered.map(row => row.reference_id));
    const body = {
      schema: RELATION_RECONCILIATION_RECEIPT_SCHEMA,
      graph_commit_id: commit.graph_commit_id,
      policy_id: policy.policy_id,
      projection_version: policy.projection_version,
      deduplication_value: deduplicationValue,
      disposition: selectedAssertionIds.length === 1 ? 'exact_selected_assertion' : 'deduplicated_assertion_set',
      selected_assertion_ids: selectedAssertionIds,
      reference_ids: referenceIds,
      assertion_chains: ordered.map(row => ({
        reference_id: row.reference_id,
        assertion_chain: row.assertion_chain,
        supersession_receipt_chain: row.supersession_receipt_chain,
      })),
    };
    const receipt = { ...body, receipt_id: hashId('relation-reconciliation-receipt', body) };
    const first = ordered[0];
    const relationBody = {
      predicate_id: first.predicate_id,
      assertion_id: selectedAssertionIds[0],
      assertion_ids: selectedAssertionIds,
      graph_commit_id: commit.graph_commit_id,
      ontology_revision_id: commit.ontology_head,
      projection_version: policy.projection_version,
      policy_id: policy.policy_id,
      reconciliation_receipt_id: receipt.receipt_id,
      subject_referent_id: first.subject_referent_id,
      object_referent_id: first.object_referent_id,
    };
    relations.push({ ...relationBody, relation_id: hashId('rel', relationBody) });
    receipts.push(receipt);
  }
  return { relations, receipts };
}

/** Build a deterministic, fully validated selected serving state from one C2 commit. */
export function buildServingProjection({
  store = null,
  graph_commit_id,
  commit = null,
  replay = null,
  records = null,
  relation_policy,
  relation_requests = null,
  supersession_ledger = null,
}) {
  requireId(graph_commit_id, 'graph_commit_id');
  verifyRelationProjectionPolicy(relation_policy);
  const source = normalizeInput({ store, graph_commit_id, commit, replay, records });
  const selectedIds = new Set(Object.keys(source.replay.selected_object_map));
  const recordById = new Map(source.records.map(row => [row.semantic_id, row]));
  if (recordById.size !== source.records.length
    || recordById.size !== selectedIds.size
    || [...recordById].some(([id, row]) => source.replay.selected_object_map[id] !== row.digest)) {
    fail('C2_SELECTED_RECORD_MISMATCH', 'projected records differ from the exact C2 selected object map');
  }

  const nodes = new Map(), edges = new Map();
  const addNode = (nodeId, kind, properties = {}) => {
    requireId(nodeId, 'projected node_id');
    const node = { node_id: nodeId, kind, properties };
    const prior = nodes.get(nodeId);
    if (prior && !exactEqual(prior, node)) {
      fail('PROJECTED_NODE_ID_COLLISION', `projected node ${nodeId} has conflicting derivations`);
    }
    nodes.set(nodeId, node);
  };
  const addEdge = (type, from, to, properties = {}) => {
    if (!edgeTypeSet.has(type)) fail('INVALID_PROJECTION_EDGE_TYPE', `unsupported projection edge ${type}`);
    const edge = { type, from, to, properties };
    edges.set(edgeKey(edge), edge);
  };

  addNode(source.commit.graph_commit_id, 'GraphCommit', {
    graph_commit_id: source.commit.graph_commit_id,
    parent_graph_commit_id: source.commit.parent_graph_commit_id,
    source_head: source.commit.source_head,
    identity_head: source.commit.identity_head,
    ontology_head: source.commit.ontology_head,
    logical_graph_digest: source.replay.logical_graph_digest,
  });

  for (const held of source.records) {
    const record = held.record;
    if (record.schema === 'estate-map/serving-assertion/v1'
      || ['estate-map/claim-assertion/v1', 'estate-map/grounded-assertion/v1'].includes(record.schema)) continue;
    addNode(held.semantic_id, schemaKind(record.schema), {
      ...compactRecordProperties(record),
      semantic_id: held.semantic_id,
      canonical_object_digest: held.digest,
    });
    if (record.schema === 'estate-map/evidence-pointer/v1') {
      addNode(record.source_version_id, 'SourceVersion', { source_version_id: record.source_version_id });
      addEdge('SOURCE_VERSION', record.evidence_id, record.source_version_id);
    }
    if (record.schema === 'estate-map/mention/v1') {
      if (!selectedIds.has(record.evidence_id)) {
        fail('PROJECTION_DANGLING_REFERENCE', `Mention ${record.mention_id} lacks selected evidence ${record.evidence_id}`);
      }
      addEdge('DERIVED_FROM', record.mention_id, record.evidence_id, { basis_kind: 'evidence' });
    }
    if (record.schema === 'estate-map/resolution-receipt/v1' && record.disposition === 'resolved') {
      if (!selectedIds.has(record.selected_referent_id)) {
        fail('PROJECTION_DANGLING_REFERENCE',
          `Resolution receipt ${record.receipt_id} lacks selected Referent ${record.selected_referent_id}`);
      }
      for (const mentionId of record.admitted_mention_ids || []) {
        if (!selectedIds.has(mentionId)) continue;
        addEdge('RESOLVES_TO', mentionId, record.selected_referent_id, {
          resolution_receipt_id: record.receipt_id,
        });
      }
    }
  }

  const servingRecords = source.records
    .filter(row => row.record.schema === 'estate-map/serving-assertion/v1')
    .map(row => row.record);
  for (const serving of servingRecords) {
    const raw = serving.raw_assertion;
    if (!raw || raw.assertion_id !== serving.assertion_id || !selectedIds.has(serving.assertion_id)) {
      fail('PROJECTION_RAW_ASSERTION_MISMATCH', `ServingAssertion ${serving.serving_assertion_id} lacks its exact selected raw assertion`);
    }
    const predicate = selectedPredicate(raw);
    addNode(raw.assertion_id, 'Assertion', {
      assertion_id: raw.assertion_id,
      serving_assertion_id: serving.serving_assertion_id,
      raw_schema: raw.schema,
      predicate_id: predicate.predicate_id,
      polarity: safeScalar(raw.polarity),
      modality: safeScalar(raw.modality),
      quantifier: safeScalar(raw.quantifier),
      scope_json: canonical(raw.scope),
      conditions_json: canonical(raw.conditions),
      valid_time_json: canonical(raw.valid_time),
      recorded_time: safeScalar(raw.recorded_time),
      source_status: safeScalar(raw.source_status),
      decision_status: safeScalar(raw.decision_status),
      support_set_ids_json: canonical(raw.support_set_ids || []),
      graph_commit_id: source.commit.graph_commit_id,
    });
    addNode(predicate.predicate_id, predicate.predicate_kind === 'concept' ? 'Concept' : 'Predicate', {
      predicate_id: predicate.predicate_id,
      predicate_kind: predicate.predicate_kind,
      value_json: canonical(predicate.value),
    });
    addEdge('PREDICATE', raw.assertion_id, predicate.predicate_id);

    for (const [index, argument] of (serving.selected_arguments || []).entries()) {
      requireId(argument.role, 'argument role');
      let endpoint;
      if (argument.argument_kind === 'referent') {
        endpoint = argument.referent_id;
        if (!selectedIds.has(endpoint)) {
          fail('PROJECTION_DANGLING_REFERENCE', `Assertion ${raw.assertion_id} lacks selected Referent ${endpoint}`);
        }
      } else if (argument.argument_kind === 'mention') {
        endpoint = argument.mention_id;
        if (!selectedIds.has(endpoint)) {
          fail('PROJECTION_DANGLING_REFERENCE', `Assertion ${raw.assertion_id} lacks selected Mention ${endpoint}`);
        }
      } else if (argument.argument_kind === 'assertion') {
        endpoint = argument.assertion_id;
        if (!selectedIds.has(endpoint)) {
          fail('PROJECTION_DANGLING_REFERENCE', `Assertion ${raw.assertion_id} lacks selected assertion endpoint ${endpoint}`);
        }
      } else if (argument.argument_kind === 'literal') {
        endpoint = hashId('literal', { assertion_id: raw.assertion_id, index, role: argument.role, literal: argument.literal });
        addNode(endpoint, 'Literal', { literal_json: canonical(argument.literal) });
      } else fail('INVALID_SELECTED_ARGUMENT_KIND', `unsupported argument kind ${argument.argument_kind || '<missing>'}`);
      addEdge('ARGUMENT', raw.assertion_id, endpoint, {
        role: argument.role,
        argument_kind: argument.argument_kind,
        argument_index: index,
        raw_mention_id: argument.raw_mention_id || null,
        resolution_receipt_id: argument.resolution_receipt_id || null,
      });
    }
    for (const supportSetId of raw.support_set_ids || []) {
      addNode(supportSetId, 'SupportSet', { support_set_id: supportSetId });
      addEdge('SUPPORTED_BY', raw.assertion_id, supportSetId);
    }
    for (const [basisKind, ids] of [
      ['claim', [raw.basis_claim_id]],
      ['projection_receipt', [raw.projection_receipt_id]],
      ['migration_receipt', [raw.migration_provenance_receipt_id]],
      ['staleness_receipt', raw.source_staleness_receipt_ids || []],
      ['grounding_receipt', raw.basis_receipt_ids || []],
      ['grounding_evidence', raw.basis_evidence_ids || []],
    ]) for (const id of ids.filter(clean)) {
      if (!selectedIds.has(id)) {
        fail('PROJECTION_DANGLING_REFERENCE', `Assertion ${raw.assertion_id} lacks selected drill-down basis ${id}`);
      }
      addEdge('DERIVED_FROM', raw.assertion_id, id, { basis_kind: basisKind });
    }
  }

  const projectedRelations = relationProjection({
    servingRecords,
    policy: relation_policy,
    commit: source.commit,
    relationRequests: relation_requests,
    supersessionLedger: supersession_ledger,
  });
  for (const receipt of projectedRelations.receipts) {
    addNode(receipt.receipt_id, 'RelationReconciliationReceipt', {
      receipt_id: receipt.receipt_id,
      disposition: receipt.disposition,
      selected_assertion_ids_json: canonical(receipt.selected_assertion_ids),
      policy_id: receipt.policy_id,
      graph_commit_id: receipt.graph_commit_id,
    });
  }

  const stateBody = {
    schema: 'estate-map/neo4j-serving-state/v1',
    graph_commit_id: source.commit.graph_commit_id,
    c2_logical_graph_digest: source.replay.logical_graph_digest,
    policy_id: relation_policy.policy_id,
    projection_version: relation_policy.projection_version,
    selected_object_count: selectedIds.size,
    nodes: [...nodes.values()].sort((left, right) => left.node_id.localeCompare(right.node_id)),
    edges: [...edges.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
    relations: projectedRelations.relations.sort((left, right) => left.relation_id.localeCompare(right.relation_id)),
    relation_reconciliation_receipts: projectedRelations.receipts
      .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id)),
  };
  const state = deepFreeze({ ...stateBody, content_digest: stableCanonicalSha256(stateBody) });
  validateServingProjection(state);
  return state;
}

export function validateServingProjection(state) {
  requireRecord(state, 'Neo4j serving state');
  const nodes = new Map((state.nodes || []).map(node => [node.node_id, node]));
  if (nodes.size !== state.nodes?.length) fail('DUPLICATE_PROJECTED_NODE', 'serving state contains duplicate node IDs');
  for (const edge of state.edges || []) {
    if (!edgeTypeSet.has(edge.type) || !nodes.has(edge.from) || !nodes.has(edge.to)) {
      fail('PROJECTION_DANGLING_REFERENCE', 'serving state contains a dangling or unsupported edge');
    }
  }
  for (const node of nodes.values()) if (node.kind === 'EvidencePointer'
    && !Object.hasOwn(node.properties, 'access_policy_id')) {
    fail('PROJECTION_ACCESS_METADATA_MISSING',
      `EvidencePointer ${node.node_id} lacks its commit-derived access policy metadata`);
  }
  const forbiddenReferentProperty = /(?:^|_)(?:name|label|title|display|preferred)(?:_|$)/u;
  for (const node of nodes.values()) if (node.kind === 'Referent') {
    const forbidden = Object.keys(node.properties || {}).filter(key => forbiddenReferentProperty.test(key));
    if (forbidden.length) {
      fail('REFERENT_DISPLAY_PROPERTY_FORBIDDEN',
        `Referent ${node.node_id} contains forbidden display properties`, { forbidden });
    }
  }
  const resolutionReceiptById = new Map([...nodes.values()]
    .filter(node => node.properties?.schema === 'estate-map/resolution-receipt/v1')
    .map(node => [node.node_id, node]));
  const resolutionEdges = (state.edges || []).filter(edge => edge.type === 'RESOLVES_TO');
  const resolutionEdgeKeys = new Set(resolutionEdges.map(edge => canonical([
    edge.from, edge.to, edge.properties?.resolution_receipt_id,
  ])));
  for (const edge of resolutionEdges) {
    const receipt = resolutionReceiptById.get(edge.properties?.resolution_receipt_id);
    let admitted = [];
    try { admitted = JSON.parse(receipt?.properties?.admitted_mention_ids_json || '[]'); }
    catch { /* The exact mismatch below remains fail-closed. */ }
    if (nodes.get(edge.from)?.kind !== 'Mention' || nodes.get(edge.to)?.kind !== 'Referent'
      || !receipt || receipt.properties.disposition !== 'resolved'
      || receipt.properties.selected_referent_id !== edge.to || !admitted.includes(edge.from)) {
      fail('MENTION_RESOLUTION_EDGE_MISMATCH',
        `RESOLVES_TO ${edge.from} -> ${edge.to} lacks its exact selected receipt`);
    }
  }
  for (const receipt of resolutionReceiptById.values()) if (receipt.properties.disposition === 'resolved') {
    const admitted = JSON.parse(receipt.properties.admitted_mention_ids_json);
    for (const mentionId of admitted) if (nodes.get(mentionId)?.kind === 'Mention'
      && !resolutionEdgeKeys.has(canonical([
        mentionId, receipt.properties.selected_referent_id, receipt.node_id,
      ]))) {
      fail('MISSING_MENTION_RESOLUTION_EDGE',
        `resolved Mention ${mentionId} lacks RESOLVES_TO receipt ${receipt.node_id}`);
    }
  }
  const receiptById = new Map((state.relation_reconciliation_receipts || [])
    .map(receipt => [receipt.receipt_id, receipt]));
  for (const relation of state.relations || []) {
    const receipt = receiptById.get(relation.reconciliation_receipt_id);
    if (!nodes.has(relation.subject_referent_id) || !nodes.has(relation.object_referent_id)
      || nodes.get(relation.subject_referent_id).kind !== 'Referent'
      || nodes.get(relation.object_referent_id).kind !== 'Referent'
      || relation.assertion_ids.some(id => nodes.get(id)?.kind !== 'Assertion')
      || !receipt || !receipt.selected_assertion_ids.includes(relation.assertion_id)
      || relation.graph_commit_id !== state.graph_commit_id
      || relation.projection_version !== state.projection_version
      || relation.policy_id !== state.policy_id) {
      fail('REL_RECONCILIATION_MISMATCH', `REL ${relation.relation_id} lacks exact selected assertion reconciliation`);
    }
  }
  const body = { ...state };
  delete body.content_digest;
  if (state.content_digest !== stableCanonicalSha256(body)) {
    fail('SERVING_CONTENT_DIGEST_MISMATCH', 'serving content digest differs from deterministic selected content');
  }
  return true;
}

/** C3 exclusion primitive. It is not a D1 traversal or ranking policy. */
export function induceRelationGraph(state, {
  excluded_assertion_ids = [], excluded_referent_ids = [],
} = {}) {
  validateServingProjection(state);
  const excludedAssertions = new Set(excluded_assertion_ids);
  const excludedReferents = new Set(excluded_referent_ids);
  const relations = state.relations.filter(relation =>
    !relation.assertion_ids.some(id => excludedAssertions.has(id))
    && !excludedReferents.has(relation.subject_referent_id)
    && !excludedReferents.has(relation.object_referent_id));
  const participants = sortedUnique(relations.flatMap(relation =>
    [relation.subject_referent_id, relation.object_referent_id]));
  return deepFreeze({
    relations,
    traversable_relation_ids: relations.map(row => row.relation_id).sort(),
    transition_mass_recipients: participants,
    induced_graph_digest: sha256(canonical(relations)),
  });
}

const projectionSchemaStatements = Object.freeze([
  'CREATE CONSTRAINT c3head_slot_unique IF NOT EXISTS FOR (h:C3GraphHead) REQUIRE h.slot IS UNIQUE',
  'CREATE INDEX c3node_projection_node IF NOT EXISTS FOR (n:C3Node) ON (n.projection_id, n.node_id)',
  'CREATE INDEX c3receipt_id IF NOT EXISTS FOR (p:C3ProjectionReceipt) ON (p.receipt_id)',
]);

/** Create and await the projection schema before candidate graph writes begin. */
export async function ensureServingProjectionSchema(client) {
  if (!(client instanceof Neo4jHttpClient)) {
    fail('NEO4J_CLIENT_REQUIRED', 'schema setup requires an explicit Neo4jHttpClient');
  }
  const started = Date.now();
  for (const statement of projectionSchemaStatements) await client.query(statement);
  await client.query('CALL db.awaitIndexes(300)');
  return deepFreeze({
    names: ['c3head_slot_unique', 'c3node_projection_node', 'c3receipt_id'],
    elapsed_ms: Date.now() - started,
  });
}

function batches(rows, size = 500) {
  const output = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

function neo4jProperties(properties) {
  return Object.fromEntries(Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, safeScalar(value)]));
}

function projectionReceipt(state, previousProjectionId) {
  const body = {
    schema: NEO4J_PROJECTION_RECEIPT_SCHEMA,
    graph_commit_id: state.graph_commit_id,
    previous_projection_id: previousProjectionId,
    policy_id: state.policy_id,
    projection_version: state.projection_version,
    content_digest: state.content_digest,
    selected_object_count: state.selected_object_count,
    node_count: state.nodes.length,
    edge_count: state.edges.length,
    rel_count: state.relations.length,
  };
  const receipt = { ...body, receipt_id: hashId('neo4j-projection-receipt', body) };
  return { receipt, projection_id: hashId('neo4j-serving-projection', receipt) };
}

function projectionEdgeId(edge) {
  return hashId('projection-edge', edge);
}

function countsBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key]] = (counts[row[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function boundedSetDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort().slice(0, verificationSampleLimit);
}

function boundedDuplicates(values) {
  const seen = new Set(), duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort().slice(0, verificationSampleLimit);
}

export function projectionIdsMatch(expected, actual) {
  return expected.length === actual.length
    && exactEqual(expected.slice().sort(), actual.slice().sort());
}

/** Build the bounded, category-specific payload attached to a failed database verification. */
export function buildProjectionVerificationDetail({ state, actual_nodes, actual_edges }) {
  const expectedEdges = [
    ...state.edges.map(edge => ({ type: edge.type, id: projectionEdgeId(edge) })),
    ...state.relations.map(relation => ({ type: 'REL', id: relation.relation_id })),
  ];
  const expectedNodeIds = new Set(state.nodes.map(node => node.node_id));
  const actualNodeIds = new Set(actual_nodes.map(node => node.node_id));
  const expectedEdgeIds = new Set(expectedEdges.map(edge => edge.id));
  const actualEdgeIds = new Set(actual_edges.map(edge => edge.id));
  const invalidRelationIds = actual_edges.filter(edge => edge.type === 'REL'
    && (!clean(edge.relation_id) || !clean(edge.assertion_id) || !clean(edge.predicate_id)
      || edge.graph_commit_id !== state.graph_commit_id || edge.policy_id !== state.policy_id
      || edge.projection_version !== state.projection_version))
    .map(edge => edge.relation_id || edge.id || '<missing-relation-id>')
    .sort();
  return deepFreeze({
    expected_counts: {
      nodes: state.nodes.length,
      nodes_by_kind: countsBy(state.nodes, 'kind'),
      edges: expectedEdges.length,
      edges_by_type: countsBy(expectedEdges, 'type'),
      relations: state.relations.length,
      invalid_relations: 0,
    },
    actual_counts: {
      nodes: actual_nodes.length,
      nodes_by_kind: countsBy(actual_nodes, 'kind'),
      edges: actual_edges.length,
      edges_by_type: countsBy(actual_edges, 'type'),
      relations: actual_edges.filter(edge => edge.type === 'REL').length,
      invalid_relations: invalidRelationIds.length,
    },
    offending_ids: {
      missing_node_ids: boundedSetDifference(expectedNodeIds, actualNodeIds),
      unexpected_node_ids: boundedSetDifference(actualNodeIds, expectedNodeIds),
      duplicate_node_ids: boundedDuplicates(actual_nodes.map(node => node.node_id)),
      missing_edge_ids: boundedSetDifference(expectedEdgeIds, actualEdgeIds),
      unexpected_edge_ids: boundedSetDifference(actualEdgeIds, expectedEdgeIds),
      duplicate_edge_ids: boundedDuplicates(actual_edges.map(edge => edge.id)),
      invalid_relation_ids: invalidRelationIds.slice(0, verificationSampleLimit),
    },
    sample_limit: verificationSampleLimit,
  });
}

const acquireHeadStatement = `
  MERGE (h:C3GraphHead {slot: 'selected'})
  ON CREATE SET h.current_projection_id = null
  SET h.candidate_lock = $candidate_lock
  WITH h WHERE coalesce(h.current_projection_id, '') = coalesce($expected_projection_id, '')
  RETURN count(h) AS acquired
`;
const writeNodesStatement = `
  UNWIND $rows AS row
  MERGE (n:C3Node {projection_id: $projection_id, node_id: row.node_id})
  SET n.kind = row.kind, n += row.properties
  RETURN count(n) AS written
`;
const edgeStatements = Object.freeze(Object.fromEntries(edgeTypes.map(type => [type, `
  UNWIND $rows AS row
  MATCH (a:C3Node {projection_id: $projection_id, node_id: row.from})
  MATCH (b:C3Node {projection_id: $projection_id, node_id: row.to})
  CREATE (a)-[r:${type} {projection_id: $projection_id, projection_edge_id: row.projection_edge_id}]->(b)
  SET r += row.properties
  RETURN count(r) AS written
`])));
const writeRelationsStatement = `
  UNWIND $rows AS row
  MATCH (a:C3Node {projection_id: $projection_id, node_id: row.subject_referent_id})
  MATCH (b:C3Node {projection_id: $projection_id, node_id: row.object_referent_id})
  CREATE (a)-[r:REL {projection_id: $projection_id, relation_id: row.relation_id}]->(b)
  SET r += row.properties
  RETURN count(r) AS written
`;
export const NEO4J_PROJECTION_VERIFY_STATEMENT = `
  MATCH (n:C3Node {projection_id: $projection_id})
  WITH count(n) AS nodes
  OPTIONAL MATCH ()-[e {projection_id: $projection_id}]->()
  WITH nodes, count(e) AS edges
  OPTIONAL MATCH ()-[r:REL {projection_id: $projection_id}]->()
  RETURN nodes, edges, count(r) AS rels,
    count(CASE WHEN r IS NOT NULL AND (r.assertion_id IS NULL OR r.predicate_id IS NULL
      OR r.graph_commit_id <> $graph_commit_id OR r.policy_id <> $policy_id
      OR r.projection_version <> $projection_version) THEN 1 END) AS invalid_rels
`;
const advanceHeadStatement = `
  MATCH (h:C3GraphHead {slot: 'selected'})
  WITH h WHERE coalesce(h.current_projection_id, '') = coalesce($expected_projection_id, '')
  MERGE (p:C3ProjectionReceipt {receipt_id: $receipt.receipt_id})
  SET p += $receipt, p.projection_id = $projection_id
  SET h.current_projection_id = $projection_id,
      h.graph_commit_id = $graph_commit_id,
      h.policy_id = $policy_id,
      h.content_digest = $content_digest,
      h.projection_receipt_id = $receipt.receipt_id
  REMOVE h.candidate_lock
  RETURN h.current_projection_id, h.content_digest
`;

/** Apply, verify, receipt, and advance one state in a single explicit Neo4j transaction. */
export async function applyServingProjection({
  client,
  state,
  expected_previous_projection_id,
  inject_mid_application_failure = false,
}) {
  if (!(client instanceof Neo4jHttpClient)) fail('NEO4J_CLIENT_REQUIRED', 'apply requires an explicit Neo4jHttpClient');
  if (!Object.hasOwn(arguments[0], 'expected_previous_projection_id')) {
    fail('EXPECTED_GRAPH_HEAD_REQUIRED', 'projection requires an explicit expected prior head, including null');
  }
  validateServingProjection(state);
  const schemaSetup = await ensureServingProjectionSchema(client);
  const { receipt, projection_id: projectionId } = projectionReceipt(state, expected_previous_projection_id);
  const transaction = await client.begin();
  try {
    const acquired = await client.run(transaction, [{
      statement: acquireHeadStatement,
      parameters: {
        expected_projection_id: expected_previous_projection_id,
        candidate_lock: projectionId,
      },
      resultDataContents: ['row'],
    }]);
    if (acquired[0]?.data?.[0]?.row?.[0] !== 1) {
      fail('GRAPH_HEAD_COMPARE_AND_SWAP_FAILED', 'selected Neo4j graph head changed before projection');
    }

    for (const batch of batches(state.nodes)) await client.run(transaction, [{
      statement: writeNodesStatement,
      parameters: {
        projection_id: projectionId,
        rows: batch.map(node => ({ node_id: node.node_id, kind: node.kind,
          properties: neo4jProperties(node.properties) })),
      },
    }]);
    for (const type of edgeTypes) for (const batch of batches(state.edges.filter(edge => edge.type === type))) {
      await client.run(transaction, [{
        statement: edgeStatements[type],
        parameters: { projection_id: projectionId, rows: batch.map(edge => ({
          from: edge.from, to: edge.to, projection_edge_id: projectionEdgeId(edge),
          properties: neo4jProperties(edge.properties),
        })) },
      }]);
    }
    for (const batch of batches(state.relations)) await client.run(transaction, [{
      statement: writeRelationsStatement,
      parameters: { projection_id: projectionId, rows: batch.map(relation => ({
        relation_id: relation.relation_id,
        subject_referent_id: relation.subject_referent_id,
        object_referent_id: relation.object_referent_id,
        properties: neo4jProperties({
          predicate_id: relation.predicate_id,
          assertion_id: relation.assertion_id,
          assertion_ids_json: canonical(relation.assertion_ids),
          graph_commit_id: relation.graph_commit_id,
          ontology_revision_id: relation.ontology_revision_id,
          projection_version: relation.projection_version,
          policy_id: relation.policy_id,
          reconciliation_receipt_id: relation.reconciliation_receipt_id,
        }),
      })) },
    }]);

    const verification = await client.run(transaction, [{
      statement: NEO4J_PROJECTION_VERIFY_STATEMENT,
      parameters: {
        projection_id: projectionId,
        graph_commit_id: state.graph_commit_id,
        policy_id: state.policy_id,
        projection_version: state.projection_version,
      },
      resultDataContents: ['row'],
    }]);
    const [nodeCount, edgeCount, relCount, invalidRels] = verification[0]?.data?.[0]?.row || [];
    const expectedNodeIds = state.nodes.map(node => node.node_id);
    const expectedEdgeIds = [
      ...state.edges.map(edge => projectionEdgeId(edge)),
      ...state.relations.map(relation => relation.relation_id),
    ];
    const idVerification = await client.run(transaction, [{
      statement: `
        MATCH (n:C3Node {projection_id: $projection_id})
        RETURN collect(n.node_id)
      `,
      parameters: { projection_id: projectionId },
      resultDataContents: ['row'],
    }, {
      statement: `
        MATCH ()-[e {projection_id: $projection_id}]->()
        RETURN collect(coalesce(e.projection_edge_id, e.relation_id))
      `,
      parameters: { projection_id: projectionId },
      resultDataContents: ['row'],
    }]);
    const actualNodeIds = idVerification[0]?.data?.[0]?.row?.[0] || [];
    const actualEdgeIds = idVerification[1]?.data?.[0]?.row?.[0] || [];
    if (nodeCount !== state.nodes.length
      || edgeCount !== state.edges.length + state.relations.length
      || relCount !== state.relations.length || invalidRels !== 0
      || !projectionIdsMatch(expectedNodeIds, actualNodeIds)
      || !projectionIdsMatch(expectedEdgeIds, actualEdgeIds)) {
      const diagnostic = await client.run(transaction, [{
        statement: `
          MATCH (n:C3Node {projection_id: $projection_id})
          RETURN n.node_id, n.kind ORDER BY n.node_id
        `,
        parameters: { projection_id: projectionId },
        resultDataContents: ['row'],
      }, {
        statement: `
          MATCH ()-[e {projection_id: $projection_id}]->()
          RETURN type(e), coalesce(e.projection_edge_id, e.relation_id), e.relation_id,
                 e.assertion_id, e.predicate_id, e.graph_commit_id, e.policy_id,
                 e.projection_version
          ORDER BY type(e), coalesce(e.projection_edge_id, e.relation_id)
        `,
        parameters: { projection_id: projectionId },
        resultDataContents: ['row'],
      }]);
      const actualNodes = (diagnostic[0]?.data || []).map(({ row }) => ({
        node_id: row[0], kind: row[1],
      }));
      const actualEdges = (diagnostic[1]?.data || []).map(({ row }) => ({
        type: row[0], id: row[1], relation_id: row[2], assertion_id: row[3],
        predicate_id: row[4], graph_commit_id: row[5], policy_id: row[6],
        projection_version: row[7],
      }));
      fail('NEO4J_PROJECTION_VERIFICATION_FAILED',
        `Neo4j projection diverged: expected ${state.nodes.length} nodes, ${state.edges.length + state.relations.length} edges, and ${state.relations.length} REL edges; received ${nodeCount}, ${edgeCount}, and ${relCount}`,
        buildProjectionVerificationDetail({
          state, actual_nodes: actualNodes, actual_edges: actualEdges,
        }));
    }

    if (inject_mid_application_failure) {
      // The required parameter is intentionally omitted after candidate writes and verification.
      // Neo4j terminates the open transaction, proving all uncommitted candidate work rolls back.
      await client.run(transaction, [{
        statement: 'RETURN $c3_required_failure_parameter',
        parameters: {},
      }]);
      fail('FAILURE_INJECTION_DID_NOT_FIRE', 'Neo4j accepted a statement with a missing required parameter');
    }

    const committed = await client.commit(transaction, [{
      statement: advanceHeadStatement,
      parameters: {
        expected_projection_id: expected_previous_projection_id,
        projection_id: projectionId,
        graph_commit_id: state.graph_commit_id,
        policy_id: state.policy_id,
        content_digest: state.content_digest,
        receipt,
      },
      resultDataContents: ['row'],
    }]);
    if (committed[0]?.data?.[0]?.row?.[0] !== projectionId
      || committed[0]?.data?.[0]?.row?.[1] !== state.content_digest) {
      fail('GRAPH_HEAD_ADVANCE_FAILED', 'Neo4j projection committed without its exact selected head');
    }
    return deepFreeze({
      projection_id: projectionId,
      receipt,
      content_digest: state.content_digest,
      schema_setup: schemaSetup,
    });
  } catch (error) {
    await client.rollback(transaction);
    throw error;
  }
}

/** Read persisted projection counts and receipt/head digests from Neo4j. */
export async function readServingProjectionSummary(client, projectionId) {
  if (!(client instanceof Neo4jHttpClient)) {
    fail('NEO4J_CLIENT_REQUIRED', 'projection readback requires an explicit Neo4jHttpClient');
  }
  requireId(projectionId, 'projection_id');
  const [nodeRows, edgeRows, receiptRows, head] = await Promise.all([
    client.query(`
      MATCH (n:C3Node {projection_id: $projection_id})
      RETURN n.kind, count(n) ORDER BY n.kind
    `, { projection_id: projectionId }),
    client.query(`
      MATCH ()-[e {projection_id: $projection_id}]->()
      RETURN type(e), count(e) ORDER BY type(e)
    `, { projection_id: projectionId }),
    client.query(`
      MATCH (p:C3ProjectionReceipt {projection_id: $projection_id})
      RETURN p.receipt_id, p.content_digest, p.node_count, p.edge_count, p.rel_count
    `, { projection_id: projectionId }),
    client.readHead(),
  ]);
  const nodesByKind = Object.fromEntries(nodeRows.map(row => [row[0], row[1]]));
  const edgesByType = Object.fromEntries(edgeRows.map(row => [row[0], row[1]]));
  const receipt = receiptRows[0] || [];
  return deepFreeze({
    projection_id: projectionId,
    node_count: Object.values(nodesByKind).reduce((sum, count) => sum + count, 0),
    nodes_by_kind: nodesByKind,
    edge_count: Object.values(edgesByType).reduce((sum, count) => sum + count, 0),
    edges_by_type: edgesByType,
    receipt: {
      receipt_id: receipt[0] || null,
      content_digest: receipt[1] || null,
      node_count: receipt[2] ?? null,
      edge_count: receipt[3] ?? null,
      rel_count: receipt[4] ?? null,
    },
    head,
  });
}

/** Select only receipt-backed ancestors beyond the explicit bounded retention window. */
export function planProjectionRetention({
  selected_projection_id,
  receipts,
  retain_superseded = 1,
}) {
  requireId(selected_projection_id, 'selected_projection_id');
  if (!Number.isInteger(retain_superseded) || retain_superseded < 1) {
    fail('INVALID_PROJECTION_RETENTION', 'retention must keep at least one superseded projection');
  }
  const byProjection = new Map();
  for (const receipt of receipts || []) {
    requireId(receipt?.projection_id, 'receipt projection_id');
    if (byProjection.has(receipt.projection_id)) {
      fail('DUPLICATE_PROJECTION_RECEIPT', `multiple receipts name projection ${receipt.projection_id}`);
    }
    byProjection.set(receipt.projection_id, receipt);
  }
  const keep = new Set([selected_projection_id]);
  let cursor = selected_projection_id;
  for (let index = 0; index < retain_superseded; index++) {
    const previous = clean(byProjection.get(cursor)?.previous_projection_id);
    if (!previous) break;
    keep.add(previous);
    cursor = previous;
  }
  return deepFreeze({
    selected_projection_id,
    retain_superseded,
    kept_projection_ids: [...keep].sort(),
    prunable_projection_ids: [...byProjection.keys()].filter(id => !keep.has(id)).sort(),
  });
}

/** Prune receipt-backed projection ancestors while locking and preserving the selected head. */
export async function pruneSupersededProjections({
  client,
  expected_selected_projection_id,
  retain_superseded = 1,
}) {
  if (!(client instanceof Neo4jHttpClient)) {
    fail('NEO4J_CLIENT_REQUIRED', 'projection pruning requires an explicit Neo4jHttpClient');
  }
  requireId(expected_selected_projection_id, 'expected_selected_projection_id');
  const before = await client.readHead();
  if (before.projection_id !== expected_selected_projection_id || !clean(before.projection_receipt_id)) {
    fail('GRAPH_HEAD_COMPARE_AND_SWAP_FAILED', 'selected Neo4j graph head changed before pruning');
  }
  const rows = await client.query(`
    MATCH (p:C3ProjectionReceipt)
    WHERE p.projection_id IS NOT NULL
    RETURN p.projection_id, p.previous_projection_id, p.receipt_id
  `);
  const plan = planProjectionRetention({
    selected_projection_id: expected_selected_projection_id,
    retain_superseded,
    receipts: rows.map(row => ({
      projection_id: row[0], previous_projection_id: row[1] || null, receipt_id: row[2],
    })),
  });
  const transaction = await client.begin();
  try {
    const lock = await client.run(transaction, [{
      statement: `
        MATCH (h:C3GraphHead {slot: 'selected'})
        WHERE h.current_projection_id = $expected_projection_id
        SET h.retention_lock = $retention_lock
        RETURN count(h) AS acquired
      `,
      parameters: {
        expected_projection_id: expected_selected_projection_id,
        retention_lock: `retention:${Date.now()}`,
      },
      resultDataContents: ['row'],
    }]);
    if (lock[0]?.data?.[0]?.row?.[0] !== 1) {
      fail('GRAPH_HEAD_COMPARE_AND_SWAP_FAILED', 'selected Neo4j graph head changed before pruning');
    }
    const removed = await client.run(transaction, [{
      statement: `
        MATCH (n:C3Node)
        WHERE n.projection_id IN $projection_ids
        WITH collect(n) AS victims
        FOREACH (n IN victims | DETACH DELETE n)
        RETURN size(victims) AS removed
      `,
      parameters: { projection_ids: plan.prunable_projection_ids },
      resultDataContents: ['row'],
    }, {
      statement: `
        MATCH (p:C3ProjectionReceipt)
        WHERE p.projection_id IN $projection_ids AND p.receipt_id <> $selected_receipt_id
        WITH collect(p) AS victims
        FOREACH (p IN victims | DELETE p)
        RETURN size(victims) AS removed
      `,
      parameters: {
        projection_ids: plan.prunable_projection_ids,
        selected_receipt_id: before.projection_receipt_id,
      },
      resultDataContents: ['row'],
    }]);
    const committed = await client.commit(transaction, [{
      statement: `
        MATCH (h:C3GraphHead {slot: 'selected'})
        WHERE h.current_projection_id = $expected_projection_id
        REMOVE h.retention_lock
        RETURN h.current_projection_id, h.projection_receipt_id, h.content_digest
      `,
      parameters: { expected_projection_id: expected_selected_projection_id },
      resultDataContents: ['row'],
    }]);
    const row = committed[0]?.data?.[0]?.row || [];
    if (row[0] !== before.projection_id || row[1] !== before.projection_receipt_id
      || row[2] !== before.content_digest) {
      fail('GRAPH_HEAD_COMPARE_AND_SWAP_FAILED', 'projection pruning did not preserve the selected head');
    }
    return deepFreeze({
      ...plan,
      removed_node_count: removed[0]?.data?.[0]?.row?.[0] || 0,
      removed_receipt_count: removed[1]?.data?.[0]?.row?.[0] || 0,
      selected_receipt_id: before.projection_receipt_id,
      selected_content_digest: before.content_digest,
    });
  } catch (error) {
    await client.rollback(transaction);
    throw error;
  }
}

export function compareServingContentDigests(left, right) {
  if (!clean(left) || !clean(right) || left !== right) {
    fail('SERVING_REBUILD_DIVERGENCE', 'clean and incremental serving content digests differ');
  }
  return true;
}
