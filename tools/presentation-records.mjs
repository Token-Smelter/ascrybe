// BUILD-TIME presentation records. Views select these values; they never derive names or families.
// Records are deliberately part of the graph artifact rather than renderer state so a graph diff
// shows every visible value, its producing rule, and the witness/reason that justified it.
export const PRESENTATION_RECORD_SCHEMA = 'estate-map/presentation-record/v1';
export const PRESENTATION_RECORD_PRODUCER = 'deterministic/presentation-records@1';

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const unique = values => [...new Set(values.filter(Boolean))].sort();
const witnessOf = value => (value?.witnesses || value?.grounded_in || []).find(item => item?.file && Number.isInteger(item.line)) || null;
const familyFor = kind => {
  const value = String(kind || '');
  if (/http|route|api|deploys|routes_to/.test(value)) return 'api';
  if (/config|parameter|secret/.test(value)) return 'config';
  if (/publish|topic|queue|sns|sqs|message/.test(value)) return 'messaging';
  if (/package|dependency|depends_on|consumes|shares/.test(value)) return 'package';
  if (/tf_|infra|resource|member_of/.test(value)) return 'infra';
  if (/test/.test(value)) return 'test';
  return 'relationship';
};
const words = value => String(value || '').replaceAll('_', ' ');
const add = (records, seen, { subject, field, value, rule, witness = null, reason = null }) => {
  const key = `${subject}\0${field}`;
  const record = { schema: PRESENTATION_RECORD_SCHEMA, subject, field, value, producer: PRESENTATION_RECORD_PRODUCER, rule, witness, reason };
  const prior = seen.get(key);
  if (prior && prior.value !== value) throw new Error(`presentation record conflict for ${subject}.${field}: ${prior.value} != ${value}`);
  if (!prior) { seen.set(key, record); records.push(record); }
};
const domainFor = (node, overlays, { repoScopedOverlays = true } = {}) => {
  const values = unique([...(Array.isArray(node.domains) ? node.domains : []), node.domain]);
  if (values.length) return { value: values[0], rule: 'P2-canonical-domain', witness: witnessOf(node) };
  const overlay = overlays.filter(item => item.annotation_kind === 'service_card' && (item.subject === node.id || (repoScopedOverlays && item.subject === node.repo)) && text(item.body?.domain) && (item.grounded_in || []).length)
    .sort((a, b) => text(a.body.domain).localeCompare(text(b.body.domain)))[0];
  if (overlay) return { value: text(overlay.body.domain), rule: 'P3-domain-overlay', witness: witnessOf(overlay) };
  const structural = overlays.find(item => item.annotation_kind === 'structural_group' && item.subject === node.id && text(item.body?.group));
  if (structural) return { value: `structure · ${text(structural.body.group)}`, rule: 'P4-structural-fallback', witness: witnessOf(structural), reason: 'no documented domain; structural grouping is the explicit fallback' };
  return { value: 'No documented domain', rule: 'P5-no-documented-domain', reason: 'no canonical or witnessed domain membership and no structural grouping' };
};

/** Produce the persisted contract for all labels/families consumed by atlas/projection. */
export function buildPresentationRecords(graph) {
  const records = [], seen = new Map(), overlays = graph.overlays || [];
  const nodes = (graph.nodes || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const node of nodes) {
    const witness = witnessOf(node);
    add(records, seen, { subject: `node:${node.id}`, field: 'label', value: text(node.name) || node.id, rule: text(node.name) ? 'P1-canonical-node-name' : 'P1-node-id-fallback', witness, reason: text(node.name) ? null : 'node carries no name' });
    const repo = text(node.repo) || 'unknown repository';
    const kind = text(node.kind) || 'evidence';
    // Atlas containment historically recognizes service-card membership only when the
    // card names this node. Repo-scoped cards remain projection memberships; applying
    // them here would label the atlas's undocumented frame with a different domain.
    const atlasDomain = domainFor(node, overlays, { repoScopedOverlays: false });
    add(records, seen, { subject: `atlas:${node.id}:domain`, field: 'label', ...atlasDomain });
    add(records, seen, { subject: `atlas:${node.id}:repository`, field: 'label', value: repo, rule: text(node.repo) ? 'P6-canonical-repository' : 'P6-no-repository', witness, reason: text(node.repo) ? null : 'node carries no repo field' });
    add(records, seen, { subject: `atlas:${node.id}:kind`, field: 'label', value: words(kind), rule: 'P7-kind-display-name', witness });
    add(records, seen, { subject: `kind:${kind}`, field: 'label', value: words(kind), rule: 'P7-kind-display-name', witness });
    add(records, seen, { subject: `repo:${repo}`, field: 'label', value: repo, rule: text(node.repo) ? 'P6-canonical-repository' : 'P6-no-repository', witness, reason: text(node.repo) ? null : 'node carries no repo field' });
    const refusal = (graph.refusals || []).find(item => item.subject === node.id && item.state === 'refused');
    if (refusal) {
      const key = refusal.reason === 'no_applicable_rule_for_node_kind' && refusal.reason_detail ? `${refusal.reason}:${refusal.reason_detail}` : refusal.reason;
      add(records, seen, { subject: `refusal:${key}`, field: 'label', value: words(key), rule: refusal.rule || 'P8-domain-refusal', witness: witnessOf(refusal), reason: refusal.reason_detail || null });
    }
    else add(records, seen, { subject: 'refusal:__none__', field: 'label', value: 'No refusal recorded', rule: 'P8-no-refusal', witness, reason: 'no standing refusal record for this node' });
    const structural = overlays.find(item => item.annotation_kind === 'structural_group' && item.subject === node.id && text(item.body?.group));
    if (structural) add(records, seen, { subject: `structure:${text(structural.body.group)}`, field: 'label', value: `structure · ${text(structural.body.group)}`, rule: structural.body.rule || 'P9-structural-group', witness: witnessOf(structural) });
    else {
      const unclassified = (graph.structural_unclassified || []).find(item => item.subject === node.id);
      if (unclassified) add(records, seen, { subject: 'structure:unclassified', field: 'label', value: 'structure · unclassified', rule: unclassified.rule || 'P10-structural-unclassified', witness: unclassified.witness, reason: unclassified.reason_detail || unclassified.reason });
      else add(records, seen, { subject: 'structure:__none__', field: 'label', value: 'structure · not derived', rule: 'P10-no-structural-record', witness, reason: 'no structural annotation or unclassified record for this node' });
    }
    const domainLabel = domainFor(node, overlays);
    if (domainLabel.value.startsWith('structure · ')) {
      add(records, seen, { subject: `structure:${domainLabel.value.slice('structure · '.length)}`, field: 'label', ...domainLabel });
      // The landing view may select structural fallback, but the documented-domain view must
      // still expose the same explicit absence rather than inventing its fallback bucket.
      add(records, seen, { subject: 'domain:__undocumented__', field: 'label', value: 'No documented domain', rule: 'P5-no-documented-domain', witness: null, reason: domainLabel.reason });
    } else add(records, seen, { subject: `domain:${domainLabel.value === 'No documented domain' ? '__undocumented__' : domainLabel.value}`, field: 'label', ...domainLabel });
  }
  for (const [index, edge] of (graph.edges || []).entries()) {
    const edgeId = edge.id || `edge:${index}`;
    add(records, seen, { subject: `edge:${edgeId}`, field: 'family', value: familyFor(edge.kind), rule: 'P11-edge-kind-family', witness: witnessOf(edge) });
    if (edge.kind === 'emits' || edge.kind === 'consumes') add(records, seen, { subject: `event-flow:${edgeId}`, field: 'family', value: 'messaging', rule: 'P14-envelope-flow-family', witness: witnessOf(edge) });
  }
  for (const record of graph.entity_layer || []) {
    if (record.record_kind === 'entity_type') add(records, seen, { subject: `entity:${record.entity}`, field: 'label', value: record.label, rule: record.rule || 'E1-entity-label', witness: witnessOf(record) });
    if (record.record_kind === 'relationship') {
      add(records, seen, { subject: `entity-edge:${record.id}`, field: 'label', value: `${words(record.relation)} · ${record.cardinality}`, rule: record.rule || 'R1-entity-relationship', witness: witnessOf(record) });
      add(records, seen, { subject: `entity-edge:${record.id}`, field: 'family', value: 'relationship', rule: record.rule || 'R1-entity-relationship', witness: witnessOf(record) });
    }
  }
  for (const record of graph.interpretation_layer || []) {
    if (record.record_kind === 'concept') add(records, seen, { subject: record.id, field: 'label', value: `interpretation · ${record.label || record.concept}`, rule: record.rule || 'I1-concept-label', witness: null, reason: 'reproducible slice witness' });
    if (record.record_kind === 'interpretation_relationship') {
      add(records, seen, { subject: `interpretation-edge:${record.id}`, field: 'label', value: `interpretation · ${words(record.relation)}`, rule: record.rule || 'I2-relationship-label', witness: null, reason: 'reproducible slice witness' });
      add(records, seen, { subject: `interpretation-edge:${record.id}`, field: 'family', value: 'relationship', rule: record.rule || 'I2-relationship-label', witness: null, reason: 'reproducible slice witness' });
    }
  }
  for (const node of nodes.filter(node => node.kind === 'envelope_kind')) add(records, seen, { subject: `event:${node.id}`, field: 'label', value: text(node.name) || node.id, rule: 'P12-envelope-kind-label', witness: witnessOf(node) });
  for (const repo of unique(nodes.map(node => node.repo))) add(records, seen, { subject: `event_participant:${repo}`, field: 'label', value: `component · ${repo}`, rule: 'P13-event-participant-label', witness: witnessOf(nodes.find(node => node.repo === repo)) });
  return records.sort((a, b) => a.subject.localeCompare(b.subject) || a.field.localeCompare(b.field));
}

export function withPresentationRecords(graph) { return { ...graph, presentation_records: buildPresentationRecords(graph) }; }
export function presentationRecordIndex(graph) {
  const persisted = Array.isArray(graph.presentation_records) ? graph.presentation_records : [];
  return new Map(persisted.map(record => [`${record.subject}\0${record.field}`, record]));
}
export function selectPresentation(index, subject, field) {
  const record = index.get(`${subject}\0${field}`);
  if (!record) throw new Error(`missing persisted presentation record: ${subject}.${field}`);
  return record;
}
