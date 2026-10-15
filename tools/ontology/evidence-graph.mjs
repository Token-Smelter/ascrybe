// A bounded, derived evidence graph over generations and an optional alignment. Nodes are concepts and the
// subjects (quoted referents) that assert to them; edges are the assertions and proposed links that were actually
// sealed. Nothing is invented: a chain stage with no located assertion is reported as such, and a link whose
// endpoint is not in the supplied generations is listed as broken instead of drawn. Every node and edge is a
// generated proposal; validation (source quote located at a pin), review (no decision record exists) and the kind of
// evidence (what the source says or declares) are three separate facts.
import { fail } from './schemas.mjs';

export const GRAPH_SCHEMA = 'estate-map/ontology-evidence-graph/v1';
const STATEMENT_PREDICATES = new Set(['defines', 'selects', 'constrains', 'describes', 'subject_to', 'exemplifies', 'follows']);
const IMPLEMENTING = new Set(['implements', 'is_a']);

// Plain-language meaning of each relation, written once. The ordering of a sentence is subject → relation → concept.
export const RELATION_MEANING = Object.freeze({
  defines: 'The passage states what the concept is or requires.',
  constrains: 'The passage sets a limit on the concept.',
  describes: 'The passage talks about the concept without being an instance of it.',
  selects: 'The decision records a choice of this option.',
  implements: 'The source performs this responsibility.',
  is_a: 'The subject is an instance of this kind of thing.',
  subject_to: 'The rule governs this subject.',
  exemplifies: 'The subject is an example of this theme.',
  follows: 'The subject carries out this practice.',
  specifies: 'One side states what the other is or must be.',
  evidenced_by: 'One side is supported by what the other shows.',
  governed_by: 'The rule governs this subject.',
  same_referent: 'Both name the same real thing.',
  related: 'The two are associated. This does not establish that one realises the other.',
  close_match: 'The meanings overlap but are not identical.',
  same_concept: 'The two have the same meaning.',
  includes: 'The first definition fully contains the second.',
  governs: 'The policy governs what the other concept describes.',
});

const EVIDENCE_KIND = Object.freeze({
  documentary_claim: { id: 'document_says', label: 'Stated in a document or instruction file' },
  comment_claim: { id: 'comment_says', label: 'A code comment says this' },
  third_party_reference: { id: 'third_party_says', label: 'A third-party reference says this' },
  source_observed: { id: 'source_declares', label: 'Source declares this' },
});
const evidenceKindOf = occ => EVIDENCE_KIND[occ?.standing] ?? { id: 'unknown', label: 'Evidence kind not recorded' };

const sentence = value => String(value ?? '');
const quoteOf = occ => (occ ? { quote: occ.quote, repository: occ.repository, path: occ.path, commit_sha: occ.commit_sha, start_line: occ.start_line,
  end_line: occ.end_line, standing: occ.standing, span_class: occ.span_class ?? null, locator: occ.locator ?? null, artifact_id: occ.artifact_id ?? null } : null);
const validationOf = occ => ({ source_quote_located: Boolean(occ?.quote && occ?.start_line != null && occ?.commit_sha), locator: occ?.locator ?? null });
const REVIEW = Object.freeze({ state: 'not_reviewed', decision_id: null, recording_enabled: false });

function subjectDisplay(referent, occ) {
  const observed = occ?.standing === 'source_observed';
  const group = observed ? 'observed' : 'statement';
  const code = ['code_construct', 'configuration_entry', 'build_step'].includes(referent.kind);
  let label;
  if (referent.kind === 'decision') label = observed ? 'Decision declared in source' : 'Decision';
  else if (code) label = occ?.span_class === 'comment' ? 'Code comment' : referent.kind === 'configuration_entry' ? 'Configuration' : referent.kind === 'build_step' ? 'Build step' : 'Code';
  else if (['passage', 'rule', 'specification', 'obligation'].includes(referent.kind)) label = observed ? `${referent.kind[0].toUpperCase()}${referent.kind.slice(1)} declared in source` : occ?.standing === 'third_party_reference' ? 'Third-party reference' : 'Document passage';
  else if (referent.kind === 'asset') label = referent.basis === 'referenced_by_document' ? 'Referenced asset' : 'Asset';
  else label = referent.kind.replaceAll('_', ' ');
  return { label, group };
}

/** @param {{generations: object[], alignment?: object|null}} input */
export function evidenceGraph({ generations, alignment = null }) {
  if (!Array.isArray(generations) || !generations.length) fail('GRAPH_INPUT_INVALID', 'at least one sealed generation is required');
  const nodes = new Map(), edges = new Map(), broken = [];
  const conceptKey = (gid, accession) => `concept:${gid}|${accession}`;
  const subjectKey = (collection, referentId) => `subject:${collection}|${referentId}`;
  const conceptNode = new Map(); // `${collection}|${accession}` -> node id, for alignment endpoints that name a collection
  const collections = [];

  for (const g of generations) {
    const standingOf = new Map(g.concept_standing.map(s => [s.accession, s.standing]));
    const artifactById = new Map(g.source_artifacts.map(a => [a.artifact_id, a]));
    for (const c of g.collections) {
      collections.push({ collection_id: c.collection_id, generation_id: g.generation_id, mode: c.mode });
      for (const k of c.concepts) {
        const standing = standingOf.get(k.accession);
        const support = c.evidence.filter(e => e.concept_accession === k.accession && e.role === 'support');
        const stale = g.findings.filter(f => f.kind === 'stale_evidence' && f.concept_accession === k.accession && f.role === 'support').length;
        const id = conceptKey(g.generation_id, k.accession);
        nodes.set(id, { id, type: 'concept', label: k.label, category: k.semantic_category, definition: k.definition, inclusion: k.inclusion, exclusion: k.exclusion,
          collection_id: c.collection_id, generation_id: g.generation_id, accession: k.accession, version_id: k.version_id, origin: k.origin,
          standing: standing?.summary ?? 'no_located_evidence', side: standing?.summary === 'source_observed' ? 'observed' : 'statement',
          currentness: { located: support.length, stale, state: support.length ? (stale ? 'partly_stale' : 'supported') : (stale ? 'support_stale' : 'no_support') },
          support: support.slice(0, 3).map(e => ({ ...quoteOf(e), validation: validationOf(e) })), review: REVIEW, proposal: true });
        conceptNode.set(`${c.collection_id}|${k.accession}`, id);
      }
    }
    const conceptByAccession = new Map(g.collections.flatMap(c => c.concepts.map(k => [k.accession, conceptKey(g.generation_id, k.accession)])));
    for (const r of g.referents) {
      const occ = r.occurrence, display = subjectDisplay(r, occ);
      const id = subjectKey(r.collection_id, r.referent_id);
      const artifact = artifactById.get(occ.artifact_id);
      nodes.set(id, { id, type: 'subject', label: r.name, kind: r.kind, display_kind: display.label, group: display.group, basis: r.basis, collection_id: r.collection_id,
        generation_id: g.generation_id, referent_id: r.referent_id, denotes: r.denotes, held_out: Boolean(r.held_out), coverage: r.coverage, instance_status: r.instance_status ?? null,
        source: { ...quoteOf(occ), artifact_kind: artifact?.kind ?? null, validation: validationOf(occ) }, evidence_kind: evidenceKindOf(occ),
        graph_node_ids: artifact?.graph_node_ids ?? [], review: REVIEW, proposal: true });
    }
    for (const a of g.assertions) {
      const from = subjectKey(g.referents.find(r => r.referent_id === a.referent_id)?.collection_id ?? '', a.referent_id), to = conceptByAccession.get(a.concept_accession);
      if (!nodes.has(from) || !to) { broken.push({ id: a.assertion_id, kind: 'assertion', reason: !to ? 'concept_not_in_generation' : 'subject_not_in_generation' }); continue; }
      const id = `edge:assertion:${a.assertion_id}`;
      edges.set(id, { id, type: 'assertion', from, to, predicate: a.predicate, label: a.polarity === 'deny' ? `not ${a.predicate.replaceAll('_', ' ')}` : a.predicate.replaceAll('_', ' '),
        polarity: a.polarity, membership: a.membership, constitutive: a.constitutive, meaning: RELATION_MEANING[a.predicate] ?? null, source: { ...quoteOf(a.occurrence) },
        validation: validationOf(a.occurrence), evidence_kind: evidenceKindOf(a.occurrence), runtime_verified: false, review: REVIEW, proposal: true, dashed: false });
    }
  }

  const endpointConcept = e => nodes.get(conceptNode.get(`${e.collection_id}|${e.accession}`) ?? conceptKey(e.generation_id, e.accession)) ?? null;
  const links = [];
  if (alignment) {
    for (const l of alignment.links) {
      const a = endpointConcept(l.a_endpoint), b = endpointConcept(l.b_endpoint);
      if (!a || !b) { broken.push({ id: l.link_id, kind: 'concept_link', reason: !a ? 'a_concept_not_in_generations' : 'b_concept_not_in_generations' }); continue; }
      const crossKind = l.cross_kind ?? l.role_kind ?? null;
      const hier = l.relation === 'broader' || l.relation === 'narrower';
      const docA = a.side === 'statement' && b.side === 'observed', docB = b.side === 'statement' && a.side === 'observed';
      let from = a, to = b, label = l.relation.replaceAll('_', ' '), directed = false;
      if (hier) { const aBroader = (l.broader_side ?? (l.relation === 'broader' ? 'a' : 'b')) === 'a'; from = aBroader ? a : b; to = aBroader ? b : a; label = 'includes'; directed = true; }
      else if (l.role_kind === 'governs') { label = 'governs'; directed = true; }
      else if (crossKind && ['specifies', 'constrains', 'describes', 'evidenced_by', 'implemented_by'].includes(crossKind)) {
        if (docB) { from = b; to = a; }
        label = crossKind.replaceAll('_', ' '); directed = true;
      }
      const meaningKey = hier ? 'includes' : l.role_kind === 'governs' ? 'governs' : crossKind ?? l.relation;
      const id = `edge:link:${l.link_id}`;
      edges.set(id, { id, type: 'concept_link', link_id: l.link_id, from: from.id, to: to.id, directed, relation: l.relation, cross_kind: l.cross_kind ?? null, role_kind: l.role_kind ?? null,
        label, meaning: RELATION_MEANING[meaningKey] ?? null, uncertainty: l.uncertainty, reason: sentence(l.reason), inclusion_basis: l.inclusion_basis ?? null, derived: Boolean(l.derived),
        endpoints: [l.a_endpoint, l.b_endpoint].map(e => ({ concept: endpointConcept(e)?.id, label: e.label, collection_id: e.collection_id, pins: e.pins ?? [],
          evidence: e.evidence.map(x => ({ ...quoteOf({ ...x, locator: null }), validation: { source_quote_located: Boolean(x.verified_at_pin), locator: null } })) })),
        source_observation: l.source_observation ?? null, via_subject: l.via_subject ?? null, retrieval: l.retrieval ?? [], context_round: l.context_round ?? 1,
        model: l.model ?? null, request_digest: l.request_digest ?? null, judged_model: l.judged_model ?? null, review: REVIEW, proposal: true, runtime_verified: false, dashed: true });
      links.push(edges.get(id));
    }
    for (const s of alignment.subject_links) {
      const na = nodes.get(subjectKey(s.a_endpoint.collection_id, s.a_endpoint.referent_id)), nb = nodes.get(subjectKey(s.b_endpoint.collection_id, s.b_endpoint.referent_id));
      if (!na || !nb) { broken.push({ id: s.subject_link_id, kind: 'subject_link', reason: !na ? 'a_subject_not_in_generations' : 'b_subject_not_in_generations' }); continue; }
      const fromB = s.from_side === 'b', directed = Boolean(s.from_side) && s.relation !== 'same_referent' && s.relation !== 'related';
      const [from, to] = fromB ? [nb, na] : [na, nb];
      const id = `edge:subject:${s.subject_link_id}`;
      edges.set(id, { id, type: 'subject_link', subject_link_id: s.subject_link_id, link_id: s.link_id, from: from.id, to: to.id, directed, relation: s.relation, label: s.relation.replaceAll('_', ' '),
        meaning: RELATION_MEANING[s.relation] ?? null, uncertainty: s.uncertainty, reason: sentence(s.reason), evidence_nature: s.evidence_nature ?? null, derived: Boolean(s.derived),
        endpoints: [s.a_endpoint, s.b_endpoint].map(e => ({ subject: subjectKey(e.collection_id, e.referent_id), name: e.name, kind: e.kind, ...quoteOf(e),
          validation: { source_quote_located: Boolean(e.quote && e.commit_sha), locator: null } })),
        model: s.model ?? null, request_digest: s.request_digest ?? null, judged_model: s.judged_model ?? null, review: REVIEW, proposal: true, runtime_verified: false, dashed: true });
    }
  }

  // Chains: a statement-side concept linked to an observed-side concept, with each stage reported as located or not.
  const assertionsOf = conceptId => [...edges.values()].filter(e => e.type === 'assertion' && e.to === conceptId && e.polarity === 'affirm');
  const chains = [];
  for (const l of links) {
    const [ea, eb] = [nodes.get(l.endpoints[0].concept), nodes.get(l.endpoints[1].concept)];
    const statement = [ea, eb].find(n => n.side === 'statement'), observed = [ea, eb].find(n => n.side === 'observed' && n !== statement);
    if (!statement || !observed || l.derived) continue;
    const stated = assertionsOf(statement.id).filter(e => STATEMENT_PREDICATES.has(e.predicate) && nodes.get(e.from).group === 'statement');
    const realised = assertionsOf(observed.id).filter(e => IMPLEMENTING.has(e.predicate) && nodes.get(e.from).group === 'observed');
    const claimsImplementation = l.cross_kind === 'implemented_by';
    const step = (key, title, status, nodeIds, edgeIds, note) => ({ key, title, status, node_ids: nodeIds, edge_ids: edgeIds, note });
    const steps = [
      step('stated', 'Stated in a document', stated.length ? 'located' : 'no_located_evidence', [...new Set(stated.map(e => e.from))], stated.map(e => e.id),
        stated.length ? null : 'No subject stated in a document was grounded to this concept.'),
      step('concept', 'Concept', 'located', [statement.id], [], null),
      step('link', 'Link between the concepts', 'proposed_link', [], [l.id], claimsImplementation ? 'The link proposes that source implements the stated concept.' : 'The link records an association. It does not establish that the source implements the stated choice.'),
      step('observed_concept', 'Source-side concept', 'located', [observed.id], [], null),
      step('realised', 'Realised in source', realised.length ? 'located' : 'no_located_evidence', [...new Set(realised.map(e => e.from))], realised.map(e => e.id),
        realised.length ? 'Source declares these subjects as instances of the source-side concept.' : 'No source subject was grounded to this concept as an implementation.'),
      step('runtime', 'Checked at runtime', 'none_recorded', [], [], 'No runtime or independent check is recorded for this chain.'),
    ];
    const nodeIds = [...new Set(steps.flatMap(s => s.node_ids))], edgeIds = [...new Set(steps.flatMap(s => s.edge_ids))];
    chains.push({ chain_id: `chain:${l.link_id}`, title: `${statement.label} → ${observed.label}`, statement_concept: statement.id, observed_concept: observed.id, link_edge: l.id, steps,
      node_ids: nodeIds, edge_ids: edgeIds, stages_located: steps.filter(s => s.status === 'located' && ['stated', 'realised'].includes(s.key)).length,
      realisation: claimsImplementation ? 'link_proposes_implementation' : realised.length ? 'associated_only' : 'unknown', implementation_established: false });
  }
  chains.sort((x, y) => y.stages_located - x.stages_located || x.chain_id.localeCompare(y.chain_id));

  const list = [...nodes.values()];
  return Object.freeze({ schema: GRAPH_SCHEMA, status: { proposal: true, accepted: false, decision_id: null, review_recording: 'not_enabled',
    note: 'Generated from source. No review decision exists for any node or edge.' },
  generations: generations.map(g => ({ generation_id: g.generation_id, context_id: g.context_id, status: g.status })), alignment_id: alignment?.alignment_id ?? null,
  collections, nodes: list, edges: [...edges.values()], chains, broken, default_chain: chains[0]?.chain_id ?? null,
  counts: { concepts: list.filter(n => n.type === 'concept').length, subjects: list.filter(n => n.type === 'subject').length, assertions: [...edges.values()].filter(e => e.type === 'assertion').length,
    concept_links: links.length, subject_links: [...edges.values()].filter(e => e.type === 'subject_link').length, chains: chains.length, broken: broken.length } });
}
