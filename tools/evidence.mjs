// Preserve source witnesses; do not infer authority from naming conventions alone.

/**
 * The evidentiary classes, in strictly weakening order. The map's core honesty property is
 * that these are NOT interchangeable, so they are separated in data here and rendered with a
 * different hue AND a different border style AND a different glyph AND an all-caps name — a
 * distinction that survives greyscale, a screenshot, and a colour-blind reader.
 */
export const EVIDENCE_CLASSES = Object.freeze({
  extracted: Object.freeze({
    id: 'extracted', rank: 0, label: 'EXTRACTED FACT', glyph: '\u25CF', color: '#4ade80', border: 'solid',
    caption: 'A deterministic extractor read this out of the source. Witnessed at a real file:line you can open.',
  }),
  derived: Object.freeze({
    id: 'derived', rank: 1, label: 'DETERMINISTIC DERIVATION', glyph: '\u25E7', color: '#a78bfa', border: 'dashed',
    caption: 'A named rule computed this from extracted facts or from a parsed document (doc_derived_annotation). No model was involved; re-running the rule reproduces it.',
  }),
  inferred: Object.freeze({
    id: 'inferred', rank: 2, label: 'MODEL INFERENCE', glyph: '\u25C6', color: '#fb923c', border: 'dotted',
    caption: 'A model asserted this (llm_annotation). It is still grounded at a file:line, but the judgement is the model\u2019s, not an extractor\u2019s.',
  }),
  interpretation: Object.freeze({
    id: 'interpretation', rank: 3, label: 'INTERPRETATION', glyph: '\u2B21', color: '#fb7185', border: 'dotted',
    caption: 'A model claim ABOUT A SET, evidenced only by a reproducible slice witness (spec + exact members + graph digest). NOT witnessed at any file:line \u2014 the weakest class in this map.',
  }),
  refusal: Object.freeze({
    id: 'refusal', rank: 4, label: 'REFUSAL', glyph: '\u2298', color: '#94a3b8', border: 'solid',
    caption: 'A recorded absence: what was sought, what was examined, and why nothing was emitted. A refusal proves the question was asked, never that an answer exists.',
  }),
});

export const EVIDENCE_CLASS_ORDER = Object.freeze(['extracted', 'derived', 'inferred', 'interpretation', 'refusal']);

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export const witnessText = witness => `${witness?.repo ? `${witness.repo}/` : ''}${witness?.file || 'unknown'}:${witness?.line ?? '?'}`;

const list = value => (Array.isArray(value) ? value.filter(Boolean) : []);
const witnessList = value => list(value).map(item => ({
  repo: item.repo || '', file: item.file || 'unknown', line: item.line ?? null,
  provenance_class: item.provenance_class || null, quoted_doc: item.quoted_doc || null,
}));
const joinValues = value => (Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value));

/**
 * Semantic claims ride as ordinary `finding` overlays and pack their structure into a single
 * pipe-separated `body.detail` string. This is the REAL shape (see
 * tools/estate-map/examples/semantic-run1/semantic-layer.jsonl) — the claim type, the
 * documented entity, the quoted prose and the constrained site are NOT separate fields. The
 * view parses them rather than inventing an extractor change; a field the string does not
 * carry comes back empty and is rendered as a stated gap.
 */
export function parseSemanticDetail(detail) {
  const known = ['gap', 'semantic_key', 'documents', 'quoted_prose', 'constrains'];
  const fields = {}; const prose = [];
  for (const part of String(detail || '').split(' | ')) {
    const match = /^([a-z_]+)=([\s\S]*)$/.exec(part.trim());
    if (match && known.includes(match[1])) fields[match[1]] = match[2].trim();
    else if (part.trim()) prose.push(part.trim());
  }
  return { gap: fields.gap || '', semantic_key: fields.semantic_key || '', documents: fields.documents || '', quoted_prose: fields.quoted_prose || '', constrains: fields.constrains || '', prose: prose.join(' | ') };
}

/**
 * The class a record belongs to, decided from the record's OWN provenance fields — never from
 * which array it happened to arrive in. `evidence_class` (the interpretation layer's explicit
 * self-declaration) wins over `kind`, and `kind` wins over the producer string.
 */
export function evidenceClassOf(record, { refusal = false } = {}) {
  if (refusal) return 'refusal';
  if (record?.evidence_class === 'reproducible_slice_witness') return 'interpretation';
  if (record?.kind === 'doc_derived_annotation') return 'derived';
  if (record?.kind === 'llm_annotation') return 'inferred';
  if (typeof record?.producer === 'string' && record.producer.startsWith('deterministic/')) return 'derived';
  return 'extracted';
}

// `values.record` is set for every record so a table that draws MORE THAN ONE family (the
// interpretation layer's concepts / relationships / doc-bindings, say) can name the family in a
// column. Without it a doc-binding row reads as a concept row with mysteriously empty cells.
const record = ({ id, family, evidenceClass, title, subtitle = '', subjects = [], witnesses = [], values = {}, raw }) => ({
  id, family, evidenceClass, title: String(title ?? id), subtitle: String(subtitle ?? ''),
  subjects: [...new Set(subjects.filter(item => typeof item === 'string' && item))],
  witnesses: witnessList(witnesses), values: { record: family.replaceAll('_', ' '), ...values }, raw,
});

/**
 * Every record family, normalised. Ordering is deterministic: families in a fixed order and
 * each family in the order the canonical graph carries it (which merge.mjs already sorts).
 */
export function buildEvidenceRecords(graph) {
  const out = [];
  const nodesById = new Map(list(graph.nodes).map(node => [node.id, node]));

  for (const node of list(graph.nodes)) {
    if (node.kind === 'route') {
      out.push(record({
        id: node.id, family: 'route', evidenceClass: 'extracted',
        title: node.name || node.id, subtitle: node.owner || node.repo || '', subjects: [node.id], witnesses: node.witnesses, raw: node,
        values: {
          method: node.method || '', path: node.route || node.declared_route || '', owner: node.owner || '',
          auth: node.auth || '', auth_basis: node.auth_basis || '', framework: node.framework || '',
          provenance: node.provenance_class || '', mount_prefix: node.mount_prefix || '', mount_basis: node.mount_basis || '',
          repo: node.repo || '', witness: (node.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    } else if (node.kind === 'capability') {
      out.push(record({
        id: node.id, family: 'capability', evidenceClass: 'extracted',
        title: node.name || node.id, subtitle: `provided by ${joinValues(node.providers) || 'nobody'}`, subjects: [node.id, node.name], witnesses: node.witnesses, raw: node,
        values: {
          capability: node.name || '', providers: joinValues(node.providers), consumers: joinValues(node.consumers),
          declared_providers: joinValues(node.declared_providers), optional_for: joinValues(node.optional_for),
          provide_sites: node.provide_site_count ?? 0, require_sites: node.require_site_count ?? 0, call_sites: node.call_site_count ?? 0,
          primary_witness_class: node.primary_witness_class || '', witness: (node.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    }
  }

  for (const overlay of list(graph.overlays)) {
    const evidence = evidenceClassOf(overlay);
    if (overlay.annotation_kind === 'service_card') {
      out.push(record({
        id: `annotation:${overlay.annotation_kind}:${overlay.subject}:${overlay.body?.domain || ''}`,
        family: 'domain_annotation', evidenceClass: evidence,
        title: overlay.body?.domain || overlay.subject, subtitle: overlay.subject, subjects: [overlay.subject], witnesses: overlay.grounded_in, raw: overlay,
        values: { domain: overlay.body?.domain || '', subject: overlay.subject, summary: overlay.body?.summary || '', model: overlay.model || '', confidence: overlay.confidence ?? '', witness: (overlay.grounded_in || []).map(witnessText).join(' · ') },
      }));
    } else if (overlay.annotation_kind === 'structural_group') {
      out.push(record({
        id: `annotation:structural_group:${overlay.subject}`, family: 'structural_group', evidenceClass: evidence,
        title: `structure \u00b7 ${overlay.body?.group || 'unknown'}`, subtitle: overlay.subject, subjects: [overlay.subject], witnesses: overlay.grounded_in, raw: overlay,
        values: { group: overlay.body?.group || '', rule: overlay.body?.rule || '', basis: overlay.body?.basis || '', subject: overlay.subject, model: overlay.model || '', witness: (overlay.grounded_in || []).map(witnessText).join(' · ') },
      }));
    } else if (overlay.annotation_kind === 'finding') {
      const parsed = parseSemanticDetail(overlay.body?.detail);
      out.push(record({
        id: `claim:${overlay.subject}`, family: 'semantic_claim', evidenceClass: evidence,
        title: overlay.body?.title || overlay.subject, subtitle: parsed.gap ? `gap ${parsed.gap}` : '', subjects: [overlay.subject], witnesses: overlay.grounded_in, raw: overlay,
        values: {
          claim_type: parsed.gap, severity: overlay.body?.severity || '', title: overlay.body?.title || '',
          documents: parsed.documents, quoted_prose: parsed.quoted_prose, constrains: parsed.constrains,
          prose: parsed.prose, model: overlay.model || '', confidence: overlay.confidence ?? '',
          witness: (overlay.grounded_in || []).map(witnessText).join(' · '),
        },
      }));
    } else if (overlay.annotation_kind !== 'proposed_edge') {
      out.push(record({
        id: `annotation:${overlay.annotation_kind}:${overlay.subject}`, family: 'annotation', evidenceClass: evidence,
        title: overlay.annotation_kind.replaceAll('_', ' '), subtitle: overlay.subject, subjects: [overlay.subject], witnesses: overlay.grounded_in, raw: overlay,
        values: { annotation_kind: overlay.annotation_kind, subject: overlay.subject, model: overlay.model || '', witness: (overlay.grounded_in || []).map(witnessText).join(' · ') },
      }));
    }
  }

  for (const item of list(graph.refusals)) {
    out.push(record({
      id: item.id, family: 'refusal', evidenceClass: 'refusal',
      title: item.reason, subtitle: item.subject, subjects: [item.subject], witnesses: item.evidence?.witnesses, raw: item,
      values: {
        source: 'domain-derivation', reason: item.reason || '', reason_detail: item.reason_detail || '',
        subject: item.subject || '', subject_kind: item.subject_kind || '', rule: item.rule || '',
        state: item.state || '', shape: item.evidence?.shape || '', sought: item.evidence?.not_found?.sought || '',
        examined: (item.evidence?.examined || []).map(entry => `${entry.relation || ''} ${entry.target || ''} ${entry.value || ''}`.trim()).join(' · '),
        witness: (item.evidence?.witnesses || []).map(witnessText).join(' · '),
      },
    }));
  }

  for (const item of list(graph.domain_prepass_receipts)) {
    out.push(record({
      id: `domain-prepass:${item.subject}`, family: 'domain_prepass_receipt', evidenceClass: 'derived',
      title: item.status, subtitle: item.subject, subjects: [item.subject], witnesses: [...(item.subject_witnesses || []), ...(item.evidence || []).flatMap(entry => entry.witnesses || [])], raw: item,
      values: {
        status: item.status || '', subject: item.subject || '', domain: item.domain || '', candidates: (item.candidates || []).join(', '),
        rule: `${item.rule_id || ''}@${item.rule_version || ''}`, reason: item.reason || '',
        witnesses: [...(item.subject_witnesses || []), ...(item.evidence || []).flatMap(entry => entry.witnesses || [])].map(witnessText).join(' · '),
      },
    }));
  }

  for (const item of list(graph.route_refusals)) {
    out.push(record({
      id: item.id, family: 'refusal', evidenceClass: 'refusal',
      title: item.reason, subtitle: item.examined || '', witnesses: item.witnesses, raw: item,
      values: { source: 'routes', reason: item.reason || '', reason_detail: item.reason_detail || '', subject: item.framework || '', rule: '', state: 'refused', shape: 'route', sought: item.examined || '', examined: item.examined || '', witness: (item.witnesses || []).map(witnessText).join(' · ') },
    }));
  }

  for (const item of list(graph.capability_refusals)) {
    out.push(record({
      id: item.id, family: 'refusal', evidenceClass: 'refusal',
      title: item.reason, subtitle: item.examined || '', witnesses: item.witnesses, raw: item,
      values: { source: 'capabilities', reason: item.reason || '', reason_detail: item.reason_detail || '', subject: item.direction || '', rule: '', state: 'refused', shape: 'capability', sought: item.examined || '', examined: item.examined || '', witness: (item.witnesses || []).map(witnessText).join(' · ') },
    }));
  }

  for (const item of list(graph.structural_unclassified)) {
    out.push(record({
      id: item.id || `structural-unclassified:${item.subject}`, family: 'refusal', evidenceClass: 'refusal',
      title: item.reason || 'structural_unclassified', subtitle: item.subject, subjects: [item.subject], raw: item,
      values: { source: 'structural-grouping', reason: item.reason || '', reason_detail: item.reason_detail || '', subject: item.subject || '', rule: item.rule || '', state: 'refused', shape: 'absence', sought: 'a structural rule covering this node', examined: item.reason_detail || '', witness: '' },
    }));
  }

  for (const item of list(graph.manifest_wiring)) {
    const witnesses = [...witnessList([item.declaration]), ...witnessList(item.wiring_witnesses), ...witnessList(item.undeterminable_witnesses)];
    out.push(record({
      id: item.id, family: 'manifest_wiring', evidenceClass: item.wiring_status === 'wired' ? 'extracted' : 'refusal',
      title: `${item.owner} \u00b7 ${item.subject}`, subtitle: item.wiring_status, subjects: [item.subject], witnesses, raw: item,
      values: {
        owner: item.owner || '', declaration_family: item.declaration_family || '', subject: item.subject || '',
        status: item.wiring_status || '', manifest_key: item.manifest_key || '', optional: item.optional ? 'yes' : 'no',
        reason: item.reason || '', reason_detail: item.reason_detail || '',
        declaration: item.declaration ? witnessText(item.declaration) : '',
        examined: (item.examined || []).map(entry => `${entry.relation || ''} ${entry.target || ''} ${entry.value || ''}`.trim()).join(' · '),
        witness: witnessList(item.wiring_witnesses).map(witnessText).join(' · '),
      },
    }));
  }

  for (const item of list(graph.entity_layer)) {
    if (item.record_kind === 'entity_type') {
      out.push(record({
        id: item.id, family: 'entity', evidenceClass: evidenceClassOf(item),
        title: item.label || item.entity, subtitle: item.root_table || '', subjects: [item.id, item.entity], witnesses: item.witnesses, raw: item,
        values: {
          entity: item.entity || '', label: item.label || '', root_table: item.root_table || '',
          instance_table: item.instance_table ? 'yes' : 'no', schema_evidence: item.schema_evidence || '',
          corroboration: (item.corroboration || []).map(entry => entry.source).join(', '), rule: item.rule || '',
          witness: (item.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    } else if (item.record_kind === 'relationship') {
      out.push(record({
        id: item.id, family: 'entity_relationship', evidenceClass: evidenceClassOf(item),
        title: `${item.from} ${String(item.relation || '').replaceAll('_', ' ')} ${item.to}`, subtitle: item.cardinality || '',
        subjects: [item.from, item.to, `entity:${item.from}`, `entity:${item.to}`], witnesses: item.witnesses, raw: item,
        values: {
          from: item.from || '', relation: item.relation || '', to: item.to || '', cardinality: item.cardinality || '',
          basis: item.basis || '', status: item.status || '', via: item.via || '', rule: item.rule || '',
          note: item.note || '', witness: (item.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    } else if (item.record_kind === 'conflict') {
      out.push(record({
        id: item.id, family: 'entity_conflict', evidenceClass: evidenceClassOf(item),
        title: item.reason || 'conflict', subtitle: item.about || '', subjects: [item.about, `entity:${item.about}`], witnesses: item.witnesses, raw: item,
        values: {
          about: item.about || '', reason: item.reason || '',
          claim_a: item.claim_a?.statement || '', claim_a_source: item.claim_a?.source || '',
          claim_b: item.claim_b?.statement || '', claim_b_source: item.claim_b?.source || '',
          witness: (item.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    } else if (item.record_kind === 'refusal') {
      out.push(record({
        id: item.id, family: 'refusal', evidenceClass: 'refusal',
        title: item.reason || 'entity refusal', subtitle: item.subject || item.about || '', subjects: [item.subject, item.about].filter(Boolean), witnesses: item.witnesses, raw: item,
        values: {
          source: 'entity-layer', reason: item.reason || '', reason_detail: item.reason_detail || '',
          subject: item.subject || item.about || '', rule: item.rule || '', state: 'refused', shape: 'entity',
          sought: item.sought || '', examined: (item.examined || []).map(entry => typeof entry === 'string' ? entry : `${entry.relation || ''} ${entry.target || ''} ${entry.value || ''}`.trim()).join(' · '),
          witness: (item.witnesses || []).map(witnessText).join(' · '),
        },
      }));
    } else if (item.record_kind === 'envelope_attachment' || item.record_kind === 'capability_attachment') {
      out.push(record({
        id: item.id, family: 'entity_attachment', evidenceClass: evidenceClassOf(item),
        title: `${item.entity} \u2190 ${item.envelope_kind || item.capability_type || ''}`, subtitle: item.rule || '',
        subjects: [item.entity, `entity:${item.entity}`, item.envelope_node, item.capability_node].filter(Boolean), witnesses: item.witnesses, raw: item,
        values: { entity: item.entity || '', attached: item.envelope_kind || item.capability_type || '', rule: item.rule || '', witness: (item.witnesses || []).map(witnessText).join(' · ') },
      }));
    }
  }

  for (const item of list(graph.interpretation_layer)) {
    if (item.record_kind === 'concept') {
      out.push(record({
        id: item.id, family: 'interpretation_concept', evidenceClass: 'interpretation',
        title: item.label || item.concept, subtitle: item.slice_witness?.enumerator || '',
        subjects: [item.id, ...list(item.slice_witness?.members)], raw: item,
        values: {
          concept: item.concept || '', label: item.label || '', members: item.slice_witness?.member_count ?? list(item.slice_witness?.members).length,
          enumerator: item.slice_witness?.enumerator || '', slice_id: item.slice_witness?.slice_id || '',
          spec_hash: item.slice_witness?.spec_hash || '', graph_digest: item.slice_witness?.graph_digest || '',
          confidence: item.confidence ?? '', model: item.model || '', coheres_because: item.coheres_because || '',
          shape_evidence: (item.shape_evidence || []).map(entry => `${entry.kind}: ${entry.statement}`).join(' · '),
          witness: '', // by construction: an interpretation has NO file:line witness.
        },
      }));
    } else if (item.record_kind === 'interpretation_relationship') {
      out.push(record({
        id: item.id, family: 'interpretation_relationship', evidenceClass: 'interpretation',
        title: `${item.from} ${String(item.relation || '').replaceAll('_', ' ')} ${item.to}`, subtitle: item.relation || '',
        subjects: [item.from, item.to], raw: item,
        values: { from: item.from || '', relation: item.relation || '', to: item.to || '', statement: item.statement || '', model: item.model || '', witness: '' },
      }));
    } else if (item.record_kind === 'doc_binding') {
      out.push(record({
        id: item.id, family: 'doc_binding', evidenceClass: 'interpretation',
        title: `${item.documented_concept} \u2192 ${item.concept}`, subtitle: item.doc_source || '',
        subjects: [item.concept], witnesses: item.doc_witness ? [item.doc_witness] : [], raw: item,
        values: { documented_concept: item.documented_concept || '', concept: item.concept || '', doc_source: item.doc_source || '', quoted_doc: item.doc_witness?.quoted_doc || '', confidence: item.confidence ?? '', witness: item.doc_witness ? witnessText(item.doc_witness) : '' },
      }));
    } else if (item.record_kind === 'unverifiable_doc_concept') {
      out.push(record({
        id: item.id, family: 'unverifiable_doc_concept', evidenceClass: 'interpretation',
        title: item.documented_concept || item.id, subtitle: item.doc_source || '',
        witnesses: item.doc_witness ? [item.doc_witness] : [], raw: item,
        values: {
          documented_concept: item.documented_concept || '', doc_source: item.doc_source || '',
          quoted_doc: item.doc_witness?.quoted_doc || '', reason_detail: item.reason_detail || '', rule: item.rule || '',
          examined: (item.examined || []).map(entry => `${entry.relation || ''} ${entry.target || ''} ${entry.value || ''}`.trim()).join(' · '),
          witness: item.doc_witness ? witnessText(item.doc_witness) : '',
        },
      }));
    } else if (item.record_kind === 'refusal') {
      out.push(record({
        id: item.id, family: 'refusal', evidenceClass: 'refusal',
        title: item.reason || 'interpretation refusal', subtitle: item.rule || '', raw: item,
        values: {
          source: 'interpretation-layer', reason: item.reason || '', reason_detail: item.reason_detail || '',
          subject: item.subject || item.slice_id || '', rule: item.rule || '', state: 'refused', shape: 'slice',
          sought: 'a coherent concept over this slice',
          examined: (item.examined || []).map(entry => `${entry.relation || ''} ${entry.target || ''} ${entry.value || ''}`.trim()).join(' · '),
          witness: '',
        },
      }));
    }
  }

  // Preserve source witnesses; do not infer authority from naming conventions alone.
  for (const item of out) item.danglingSubjects = item.subjects.filter(id => /^(module|envelope_kind|route|capability|repo|service|package|coverage|tf_|config_key|environment|sql_object|external_internal|swift_)/.test(id) && !nodesById.has(id));
  return out;
}

/** Search text for one record. Kept off the record until asked for, so the index stays cheap. */
export function recordSearchText(item) {
  return [item.id, item.family, item.title, item.subtitle, ...item.subjects, ...Object.values(item.values || {}), ...item.witnesses.map(witnessText)].join(' ').toLowerCase();
}

/**
 * The per-family field gaps this view hit. These are REPORTED, never patched: the brief's
 * constraint is that a missing field is named, not invented.
 */
export function fieldGaps(graph) {
  const gaps = [];
  const claims = list(graph.overlays).filter(item => item.annotation_kind === 'finding');
  if (claims.length) gaps.push({
    family: 'semantic_claim',
    gap: 'claim type, documented target, quoted prose and constrained site are packed into one pipe-separated `body.detail` string, not carried as fields.',
    consequence: 'The table parses them out of that string. A claim whose detail drops a key shows the cell empty rather than guessing.',
  });
  if (claims.some(item => /constrains=[^|]*\//.test(item.body?.detail || ''))) gaps.push({
    family: 'semantic_claim',
    gap: '`constrains=` is a path string (`<repo>/<file>:<line>`), not a node id, and its repo component reflects the estate layout at authoring time.',
    consequence: 'The inspector shows the site verbatim and links it to a node only when a file-path suffix match is unambiguous.',
  });
  if (list(graph.interpretation_layer).some(item => item.record_kind === 'concept')) gaps.push({
    family: 'interpretation_concept',
    gap: 'by construction an interpretation concept carries NO file:line witness \u2014 its evidence is a reproducible slice witness (spec + members + graph digest).',
    consequence: 'The witness column is empty on purpose and the record is rendered in the INTERPRETATION class, which states that in words.',
  });
  if (list(graph.route_refusals).length || list(graph.capability_refusals).length) gaps.push({
    family: 'refusal',
    gap: 'route and capability refusals carry `examined` as a single string and no `rule`/`state`, unlike domain-derivation refusals which carry a structured `evidence.examined[]` and a refusal state machine.',
    consequence: 'The refusals table shows a `source` column so the two shapes are never read as one, and leaves the missing cells empty.',
  });
  return gaps;
}

/**
 * TABLE SPECS ARE DATA, not closures, so they serialise, and so a test can assert the column
 * set of every table without executing the renderer.
 */
export const TABLE_SPECS = Object.freeze([
  { id: 'refusals', label: 'Refusals', families: ['refusal'], facets: ['source', 'reason'], sort: 'reason',
    columns: [{ key: 'source', label: 'Source' }, { key: 'reason', label: 'Reason code' }, { key: 'subject', label: 'Subject' }, { key: 'rule', label: 'Rule' }, { key: 'shape', label: 'Evidence shape' }, { key: 'witness', label: 'Witness' }] },
  { id: 'routes', label: 'Routes', families: ['route'], facets: ['method', 'owner', 'auth'], sort: 'path',
    columns: [{ key: 'method', label: 'Method' }, { key: 'path', label: 'Path' }, { key: 'owner', label: 'Owner' }, { key: 'auth', label: 'Auth' }, { key: 'auth_basis', label: 'Auth basis' }, { key: 'framework', label: 'Framework' }, { key: 'witness', label: 'Witness' }] },
  { id: 'capabilities', label: 'Capabilities', families: ['capability'], facets: ['providers', 'primary_witness_class'], sort: 'capability',
    columns: [{ key: 'capability', label: 'Capability' }, { key: 'providers', label: 'Provider(s)' }, { key: 'consumers', label: 'Consumer(s)' }, { key: 'provide_sites', label: 'provide()' }, { key: 'require_sites', label: 'require()' }, { key: 'call_sites', label: 'request()' }, { key: 'witness', label: 'Witness' }] },
  { id: 'wiring', label: 'Manifest wiring', families: ['manifest_wiring'], facets: ['status', 'declaration_family', 'owner'], sort: 'owner',
    columns: [{ key: 'owner', label: 'Owner' }, { key: 'declaration_family', label: 'Declares' }, { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status' }, { key: 'reason', label: 'Reason' }, { key: 'declaration', label: 'Declared at' }, { key: 'witness', label: 'Binding witness' }] },
  { id: 'entities', label: 'Entities', families: ['entity'], facets: ['instance_table', 'schema_evidence'], sort: 'entity',
    columns: [{ key: 'entity', label: 'Entity' }, { key: 'root_table', label: 'Root table' }, { key: 'instance_table', label: 'Own table' }, { key: 'schema_evidence', label: 'Schema evidence' }, { key: 'corroboration', label: 'Corroborated by' }, { key: 'witness', label: 'DDL witness' }] },
  { id: 'relationships', label: 'Entity relationships', families: ['entity_relationship'], facets: ['cardinality', 'status', 'basis'], sort: 'from',
    columns: [{ key: 'from', label: 'From' }, { key: 'relation', label: 'Relation' }, { key: 'to', label: 'To' }, { key: 'cardinality', label: 'Cardinality' }, { key: 'basis', label: 'Basis' }, { key: 'status', label: 'Status' }, { key: 'via', label: 'Via' }, { key: 'witness', label: 'DDL witness' }] },
  { id: 'conflicts', label: 'Entity conflicts', families: ['entity_conflict'], facets: ['reason'], sort: 'about',
    columns: [{ key: 'about', label: 'About' }, { key: 'reason', label: 'Reason' }, { key: 'claim_a', label: 'Claim A' }, { key: 'claim_b', label: 'Claim B' }, { key: 'witness', label: 'Witness' }] },
  { id: 'claims', label: 'Semantic claims', families: ['semantic_claim'], facets: ['claim_type', 'severity'], sort: 'claim_type',
    columns: [{ key: 'claim_type', label: 'Type' }, { key: 'severity', label: 'Severity' }, { key: 'title', label: 'Claim' }, { key: 'constrains', label: 'Constrained site' }, { key: 'quoted_prose', label: 'Prose witness' }, { key: 'witness', label: 'Grounded at' }] },
  { id: 'interpretations', label: 'Interpretations', families: ['interpretation_concept', 'interpretation_relationship', 'doc_binding'], facets: ['record', 'enumerator', 'confidence'], sort: 'concept',
    columns: [{ key: 'record', label: 'Record' }, { key: 'concept', label: 'Concept' }, { key: 'label', label: 'Label' }, { key: 'members', label: 'Members' }, { key: 'enumerator', label: 'Enumerator' }, { key: 'slice_id', label: 'Slice' }, { key: 'confidence', label: 'Confidence' }, { key: 'graph_digest', label: 'Graph digest' }] },
  { id: 'unverifiable', label: 'Unverifiable doc concepts', families: ['unverifiable_doc_concept'], facets: ['doc_source'], sort: 'documented_concept',
    columns: [{ key: 'documented_concept', label: 'Documented concept' }, { key: 'doc_source', label: 'Doc source' }, { key: 'quoted_doc', label: 'Quoted' }, { key: 'reason_detail', label: 'Why unverifiable' }, { key: 'witness', label: 'Canon witness' }] },
  { id: 'structure', label: 'Structural groups', families: ['structural_group'], facets: ['group', 'rule'], sort: 'group',
    columns: [{ key: 'group', label: 'Group' }, { key: 'subject', label: 'Subject' }, { key: 'rule', label: 'Rule' }, { key: 'basis', label: 'Basis' }, { key: 'witness', label: 'Witness' }] },
  { id: 'domains', label: 'Documented domains', families: ['domain_annotation'], facets: ['domain'], sort: 'domain',
    columns: [{ key: 'domain', label: 'Domain' }, { key: 'subject', label: 'Subject' }, { key: 'summary', label: 'Summary' }, { key: 'model', label: 'Derived by' }, { key: 'witness', label: 'Canon witness' }] },
  { id: 'domain-prepass', label: 'Domain prepass receipts', families: ['domain_prepass_receipt'], facets: ['status', 'domain'], sort: 'status',
    columns: [{ key: 'status', label: 'Status' }, { key: 'subject', label: 'Subject' }, { key: 'domain', label: 'Assigned domain' }, { key: 'candidates', label: 'Candidates' }, { key: 'rule', label: 'Rule' }, { key: 'reason', label: 'Reason' }] },
]);

/**
 * The full view index. Deterministic, allocation-bounded, and computed from the merged graph
 * with no I/O — the browser builds the same index from the same embedded bytes.
 */
export function buildEvidenceIndex(graph) {
  const records = buildEvidenceRecords(graph);
  const byKey = new Map(); const byFamily = new Map();
  for (const item of records) {
    const family = byFamily.get(item.family) || []; family.push(item); byFamily.set(item.family, family);
    for (const subject of item.subjects) { const bucket = byKey.get(subject) || []; bucket.push(item); byKey.set(subject, bucket); }
  }
  const counts = {}; for (const [family, items] of byFamily) counts[family] = items.length;
  const byClass = {}; for (const item of records) byClass[item.evidenceClass] = (byClass[item.evidenceClass] || 0) + 1;
  const tables = TABLE_SPECS.map(spec => ({ ...spec, count: spec.families.reduce((sum, family) => sum + (byFamily.get(family)?.length || 0), 0) }));
  return { records, byKey, byFamily, counts, byClass, tables, gaps: fieldGaps(graph), dangling: records.filter(item => item.danglingSubjects.length).length };
}

/** Records naming any of `keys`, de-duplicated, in stable evidence-class then id order. */
export function recordsFor(index, keys) {
  const seen = new Set(); const out = [];
  for (const key of keys) for (const item of index.byKey.get(key) || []) { if (seen.has(item.id + item.family)) continue; seen.add(item.id + item.family); out.push(item); }
  return out.sort((a, b) => EVIDENCE_CLASS_ORDER.indexOf(a.evidenceClass) - EVIDENCE_CLASS_ORDER.indexOf(b.evidenceClass) || a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
}

/** Browser payload: the same functions, stringified, so the view never re-implements them. */
export function evidenceBrowserSource() {
  return [
    `const EVIDENCE_CLASSES=${JSON.stringify(EVIDENCE_CLASSES)};`,
    `const EVIDENCE_CLASS_ORDER=${JSON.stringify(EVIDENCE_CLASS_ORDER)};`,
    `const TABLE_SPECS=${JSON.stringify(TABLE_SPECS)};`,
    `const witnessText=${witnessText.toString()};`,
    `const list=${list.toString()};`,
    `const witnessList=${witnessList.toString()};`,
    `const joinValues=${joinValues.toString()};`,
    `const record=${record.toString()};`,
    parseSemanticDetail.toString(),
    evidenceClassOf.toString(),
    buildEvidenceRecords.toString(),
    recordSearchText.toString(),
    fieldGaps.toString(),
    buildEvidenceIndex.toString(),
    recordsFor.toString(),
  ].join('\n');
}
