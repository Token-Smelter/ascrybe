// One record per binding, shared by extraction, validation and review. It keeps apart what a validator can establish (a quote exists at the pin,
// a name occurs in it, a predicate and a domain are admissible, a line lies inside a range) from what only a reader can establish (that a
// subject satisfies a concept's conditions). The structural validator never claims semantic entailment: a condition is "unknown" until a
// judgement bound to this exact subject, pin and contract says otherwise, and that judgement is kept with its basis and raw text.
// What an original run enforced is recorded apart from what a present-day policy would check ("shadow").
import { createHash } from 'node:crypto';
import { discoverySupport, locate } from './discovery.mjs';

const { CONCEPT_CATEGORIES } = discoverySupport;
export const RECORD_SCHEMA = 'estate-map/assertion-evidence-record/v2';
export const QUOTE_LIMIT = 300;
const RELATING = ['defines', 'constrains', 'describes'];
const REFERENT_KIND = { Symbol: 'code_construct', Module: 'code_construct', CodeFact: 'code_construct', ThrowSite: 'code_construct', Route: 'code_construct', Table: 'code_construct', HttpClientCall: 'code_construct', PathExpression: 'code_construct',
  YamlRecord: 'configuration_entry', LiteralLeaf: 'configuration_entry', LiteralValue: 'configuration_entry', PredicateLiteral: 'configuration_entry', ConfiguredUrl: 'configuration_entry', DocumentSection: 'passage', Document: 'passage', DiagramNode: 'passage' };
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** What a predicate asserts. Containment, dependency and contribution are different relations; none implies another. */
export function relationSemantics(role, predicate) {
  if (role === 'part_of') return { relation: 'contained_in_owner_declaration', kind: 'lexical_ownership', membership: false, note: 'the subject is declared inside the owner; this says nothing about what the subject contributes' };
  if (role === 'used_by') return { relation: 'dependency_use_by_owner', kind: 'dependency', membership: false, note: 'the owner declaration names the subject; a call or reference is not a contribution to a responsibility, and a name in text is not a resolved dependency' };
  if (role === 'instance') return { relation: `instantiates_via_${predicate}`, kind: 'membership', membership: true, note: 'requires the subject itself to satisfy the concept contract' };
  if (RELATING.includes(predicate)) return { relation: predicate, kind: 'relating', membership: false, note: { describes: 'the passage describes what the concept is about; it need not instantiate it', defines: 'the passage defines the concept as stated', constrains: 'the passage states a constraint that governs instances' }[predicate] };
  return { relation: String(predicate), kind: 'unknown', membership: false, note: 'unrecognised predicate' };
}

/** The question a reviewer is asked must test the relation actually asserted. */
export function reviewQuestionFor({ role, predicate }) {
  const byRole = { part_of: 'Is the node declared inside the owner, and does the owner declaration contain it?', used_by: 'Does the owner declaration use this helper? (A use is a dependency, not evidence that the helper contributes to the owner\'s responsibility.)' };
  const byPredicate = { implements: 'Does the node ITSELF satisfy EVERY instance condition of the concept as written? A construct that covers only part of the concept is not an instance.', is_a: 'Is the node a kind of thing the concept names, under every condition?', selects: 'Does the node make the choice the concept describes?', subject_to: 'Is the node governed by the rule the concept states?', exemplifies: 'Does the node show the concept?', follows: 'Does the node carry out the procedure the concept describes?',
    describes: 'Does the passage describe what the concept is about? It need not instantiate it, and instance conditions are not the test.', defines: 'Does the passage define the concept as stated?', constrains: 'Does the passage state a constraint that governs instances of the concept?' };
  return byRole[role] ?? byPredicate[predicate] ?? 'Does the quoted text support this typed relation?';
}

/**
 * Observations about a concept's own wording. They are suspicions about the contract, never a verdict on a binding: an OR in an inclusion may be a
 * deliberate alternative, and a domain only constrains INSTANCE bindings (a relating binding is not an instance of anything).
 */
export function contractLint(concept, referentKind, role = 'instance') {
  const out = [];
  const conds = concept?.instance_conditions ?? [];
  if (conds.length > 1 && /\bor\b/iu.test(concept?.inclusion ?? '')) out.push({ code: 'inclusion_uses_or_while_conditions_are_conjunctive', severity: 'suspicion_only', note: `${conds.length} instance conditions are listed and the inclusion text offers alternatives with "or"; this may be deliberate` });
  if (!conds.length) out.push({ code: 'no_instance_conditions', severity: 'suspicion_only', note: 'nothing for a reviewer to test an instance against' });
  if (role === 'instance' && (concept?.domain ?? []).length && referentKind && !concept.domain.includes(referentKind)) out.push({ code: 'instance_subject_kind_outside_concept_domain', severity: 'applies_to_instance_bindings', note: `${referentKind} is not in ${JSON.stringify(concept.domain)}` });
  return out;
}

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const identRe = label => new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(label)}([^A-Za-z0-9_$]|$)`, 'u');
/** Whether the extractor's node still sits where it says: the label on the recorded line, or within the owning declaration. */
export function subjectIdentity({ node, fileText, ownRange = null }) {
  const lines = fileText.split('\n'), lineText = lines[node.line - 1] ?? '', re = identRe(node.label);
  const onLine = re.test(lineText);
  const inRange = ownRange ? lines.slice(ownRange[0] - 1, ownRange[1]).some(l => re.test(l)) : null;
  return { node_id: node.node_id, graph_kind: node.kind, structural_kind: node.kind, referent_kind: REFERENT_KIND[node.kind] ?? 'passage', label: node.label, line: node.line, line_text: lineText.slice(0, 240),
    label_on_node_line: onLine, label_within_owning_declaration: inRange,
    identity_status: onLine ? 'label_on_recorded_line' : inRange ? 'label_found_in_owning_declaration_not_on_recorded_line' : 'label_not_found_near_recorded_line',
    identity_evidence: node.identity ?? null, model_proposed_denotes: null,
    note: 'a graph route is not its path literal and a document is not one of its passages; the graph kind is kept and the model\'s own denotes would be a separate field' };
}

/** A heuristic re-reading of a shown range: braces counted over its own lines. It says whether the range closes what it opens, not that it is a whole declaration. */
export function extentReceipt(fileText, [from, to]) {
  const lines = fileText.split('\n').slice(from - 1, to);
  let depth = 0, opened = false;
  for (const l of lines) for (const ch of l) { if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1; }
  const next = fileText.split('\n')[to] ?? '';
  return { method: 'heuristic: braces counted, strings and regexes not parsed', opened, brace_depth_at_end: depth, closes_what_it_opens: opened ? depth === 0 : null, next_line_is_indented_continuation: /^\s+\S/u.test(next) };
}

const within = (line, ranges) => (ranges ?? []).some(r => line >= r[0] && line <= r[1]);

/** The wording a condition check was made against. A check applies to a record only when subject, pin and this hash all match. */
export const contractHash = concept => sha({ definition: concept?.definition ?? '', inclusion: concept?.inclusion ?? '', exclusion: concept?.exclusion ?? '', domain: concept?.domain ?? [], instance_conditions: concept?.instance_conditions ?? [] });

/**
 * Binds a retained per-condition check to a record. A verdict is used only when the check was made about this node id, at this pin, against this
 * concept id and contract hash, and its condition list matches the concept's conditions exactly (same set, none missing, none extra). Anything else
 * is kept as retained raw text and every condition stays unknown.
 */
export function bindConditionCheck({ nodeId, pin, concept, check }) {
  const conds = concept?.instance_conditions ?? [];
  const why = [];
  if (!check) return { bound: false, reason: 'no retained condition check', statuses: conds.map(() => null) };
  if (check.subject?.node_id !== nodeId) why.push('different subject node');
  if (check.subject?.pin !== pin) why.push('different pin');
  if (check.concept_id !== concept?.accession) why.push('different concept');
  if (check.contract_hash !== contractHash(concept)) why.push('concept wording differs from the one checked');
  const listed = (check.conditions ?? []).map(c => c.condition);
  const complete = conds.length > 0 && listed.length === conds.length && conds.every(c => listed.filter(x => x === c).length === 1);
  if (!complete) why.push('the checked conditions are not exactly the concept\'s conditions');
  if (why.length) return { bound: false, reason: why.join('; '), statuses: conds.map(() => null) };
  const statuses = conds.map(c => { const m = check.conditions.find(x => x.condition === c); return { yes: 'supported', no: 'contradicted' }[m.verdict] ?? 'unknown'; });
  const derived = statuses.every(x => x === 'supported') ? 'all_conditions_supported' : statuses.some(x => x === 'contradicted') ? 'some_condition_contradicted' : 'unknown';
  return { bound: true, reason: 'subject, pin, concept and contract hash match and the condition set is complete', statuses, derived_whole_concept: derived };
}

/**
 * binding: a typed binding or part_of/used_by edge from a replayed round. context: the generation context entry for its family.
 * conceptKind says how the concept was found: 'existing', 'validated_new_proposal', 'canonical_proposal' or 'none' (an edge carries no concept of its own).
 * Everything not decidable offline is "unknown" or "not_determined", never defaulted to a pass.
 */
export function buildRecord({ round, binding, concept, conceptKind, family, context, fileText, ownRange, ownerRange = null, review = null, conditionCheck = null, pin = null, notes = [], coverageState = null, ownerBinding = null, enforcedInOriginalRun = [] }) {
  const role = binding.role ?? binding.relation ?? 'instance', predicate = binding.predicate ?? null;
  const node = family.candidates.find(c => c.node_id === binding.node_id) ?? { node_id: binding.node_id, kind: binding.node_kind, label: binding.node_label, line: binding.node_line };
  const identity = subjectIdentity({ node, fileText, ownRange });
  const quote = binding.evidence.quote, located = locate({ text: fileText, start_line: 1 }, quote);
  const sem = relationSemantics(role, predicate);
  const category = concept?.semantic_category, allowed = category ? (role === 'instance' ? (CONCEPT_CATEGORIES[category]?.constitutive ?? []) : RELATING) : null;
  const generationRanges = (context?.declarations ?? []).map(d => d.lines);
  const enforced = new Set(enforcedInOriginalRun);
  const entry = (check, outcome, detail, extra = {}) => ({ check, outcome, basis: 'structural', enforced_in_original_run: enforced.has(check), historical_outcome: enforced.has(check) ? 'accepted_by_original_validator' : 'not_checked_then', shadow_outcome: outcome, detail, ...extra });
  const concept_availability = conceptKind === 'existing' ? { kind: 'existing_lookup', outcome: context?.shown_concept_ids?.includes(binding.concept) ? 'pass' : 'fail', detail: 'the concept must have been in the list the model was shown' }
    : conceptKind === 'validated_new_proposal' ? { kind: 'validated_new_proposal', outcome: 'pass', detail: 'proposed in the same answer and accepted only after its witness quote was located at the pin; it was not in any shown list by construction' }
    : conceptKind === 'canonical_proposal' ? { kind: 'canonical_proposal_from_design_phase', outcome: context?.shown_concept_ids?.includes(binding.concept) ? 'pass' : 'fail', detail: 'a design-phase canonical concept offered to the held-out phase' }
    : { kind: 'none', outcome: 'not_applicable', detail: 'an edge carries no concept of its own' };
  const trace = [
    entry('quote_located_at_pin', located.error ? 'fail' : 'pass', located.error ?? `lines ${located.start_line}-${located.end_line}`),
    entry('node_name_occurs_in_quote', quote.includes(node.label) ? 'pass' : 'fail', 'proves location of the name, not fit to the concept'),
    entry('quote_within_300_characters', quote.length <= QUOTE_LIMIT ? 'pass' : 'fail', `${quote.length} characters; the limit is stated in the prompt and was not enforced by the validator`),
    entry('concept_available_to_the_model', concept_availability.outcome, concept_availability.detail, { concept_kind: concept_availability.kind }),
    entry('predicate_admissible_for_concept_category', allowed ? (role === 'part_of' || role === 'used_by' ? 'not_applicable' : allowed.includes(predicate) ? 'pass' : 'fail') : 'not_applicable', category ? `${category}: ${allowed.join(', ')}` : null),
    entry('subject_kind_within_concept_domain', role === 'instance' && (concept?.domain ?? []).length ? (concept.domain.includes(identity.referent_kind) ? 'pass' : 'fail') : 'not_applicable', role === 'instance' ? null : 'a domain constrains instance bindings only'),
    entry('subject_label_on_recorded_line', identity.label_on_node_line ? 'pass' : 'fail', identity.identity_status),
    entry('subject_line_in_generation_context', within(node.line, generationRanges) ? 'pass' : 'fail', 'whether the focal line was in what the model was shown'),
  ];
  if (role === 'part_of') {
    const inside = ownerRange ? node.line >= ownerRange[0] && node.line <= ownerRange[1] : null;
    trace.push(entry('lexical_containment_in_owner_declaration', inside == null ? 'unverified' : inside ? 'pass' : 'fail', ownerRange ? `owner range ${ownerRange[0]}-${ownerRange[1]} (heuristic extent), node line ${node.line}` : 'no owner range retained; the original check is recorded, not re-run'));
  }
  if (role === 'used_by') {
    const ownerText = ownerRange ? fileText.split('\n').slice(ownerRange[0] - 1, ownerRange[1]).map((t, i) => [ownerRange[0] + i, t]).filter(([n]) => n !== node.line).map(([, t]) => t).join('\n') : null;
    const visible = ownerText == null ? null : identRe(node.label).test(ownerText);
    trace.push(entry('name_appears_in_owner_declaration_text', visible == null ? 'unverified' : visible ? 'pass' : 'fail', 'a lexical identifier match only; the dependency is not resolved to a binding, import or call target', { resolved_dependency: 'not_established' }));
  }
  const reviewRanges = review?.declaration ? [review.declaration.lines] : [];
  const binder = bindConditionCheck({ nodeId: node.node_id, pin, concept, check: conditionCheck });
  const conditions = (concept?.instance_conditions ?? []).map((text, i) => ({ condition: text, status: binder.bound ? binder.statuses[i] : 'unknown', basis: binder.bound ? 'post_hoc_condition_check_bound_to_subject_pin_contract' : 'none',
    reason: binder.bound ? 'taken from a separate condition-check request bound to this node, pin and contract' : 'not judged for this subject, pin and contract: the structural validator establishes provenance and eligibility, not entailment' }));
  const disputed = binder.bound && binder.derived_whole_concept === 'some_condition_contradicted' && role === 'instance';
  const quoteSupport = { status: 'not_determined', note: 'which lines actually show a condition is a judgement; none is recorded for this binding' };
  return { schema: RECORD_SCHEMA, round, binding_id: binding.binding_id ?? binding.edge_id, family_id: binding.family_id,
    subject: identity,
    predicate: { role, name: predicate, ...sem, contributes_to: 'not_asserted: no contribution is inferred from a call or a containment' },
    concept: concept ? { id: concept.accession, label: concept.label, category, definition: concept.definition, inclusion: concept.inclusion, exclusion: concept.exclusion, domain: concept.domain ?? [], instance_conditions: concept.instance_conditions ?? [], contract_hash: contractHash(concept), contract_lint: contractLint(concept, identity.referent_kind, role) } : { id: binding.concept ?? null, unresolved: true },
    generation_context: { call: context?.request_digest ?? null, retrieval: context?.retrieval ?? null, declarations: (context?.declarations ?? []).map(d => ({ lines: d.lines, may_be_cut_or_incomplete_as_recorded: d.may_be_cut_or_incomplete ?? 'not recorded by this scaffold', re_read_extent: extentReceipt(fileText, d.lines) })), focal_line_in_view: within(node.line, generationRanges), claims_whole_declaration: false,
      completeness: 'heuristic extent: braces counted, strings and regexes not parsed; never "whole"', omitted_nodes: (context?.omitted_nodes ?? []).length },
    review_context: review?.declaration ? { lines: review.declaration.lines, extent: review.declaration.extent ?? 'unspecified', may_be_cut_or_incomplete: review.declaration.may_be_cut_or_incomplete ?? null, focal_line_in_view: within(node.line, reviewRanges), differs_from_generation_context: JSON.stringify(reviewRanges) !== JSON.stringify(generationRanges.filter(r => node.line >= r[0] && node.line <= r[1])) } : { provided: false },
    evidence: { identity_anchor: { line: node.line, text: (fileText.split('\n')[node.line - 1] ?? '').slice(0, 240), derived: true, role: 'where the extractor put the subject; automatic, not a model claim' },
      locator_quote: { text: quote, lines: [binding.evidence.start_line, binding.evidence.end_line], length: quote.length, over_300: quote.length > QUOTE_LIMIT, role: binding.decoded ? 'text derived from the pinned lines the model cited; it is not by itself semantic support' : 'locates the subject; it is not by itself semantic support' },
      substantive_support_spans: binding.decoded ? { status: 'model_cited_span_proposed', protocol: binding.decoded.protocol, span: binding.decoded.span, concept_ref: binding.decoded.concept_ref, ref_map_digest: binding.decoded.ref_map_digest, request_digest: binding.decoded.request_digest, support_span_contains_node_line: binding.decoded.support_span_contains_node_line ?? null, support_span_inside_node_own_range: binding.decoded.support_span_inside_node_own_range ?? null, note: 'a span the model chose; whether it shows the condition is a judgement, not proved by resolving it' } : quoteSupport },
    conditions, condition_check_binding: { bound: binder.bound, reason: binder.reason, request_digest: conditionCheck?.request_digest ?? null, derived_whole_concept: binder.derived_whole_concept ?? null,
      retained_raw_whole_concept: conditionCheck?.whole_concept ?? null, separate_call_from_the_binding_model: true },
    disagreement: disputed ? { binding_call_bound_it: true, post_hoc_condition_check: binder.derived_whole_concept, shadow_policy: 'hold the binding as disputed; this does not declare the source false, and unknown conditions stay unknown' } : null,
    review: { question: reviewQuestionFor({ role, predicate }), question_basis: 'the predicate actually asserted' },
    structural_validation: { trace, original_run_enforced: [...enforced], all_enforced_checks_passed_by_construction: true, shadow_passed_all_applicable: trace.every(t => t.outcome !== 'fail'), claims: 'provenance and structural eligibility only; no semantic entailment' },
    candidate_availability: { concept_kind: concept_availability.kind, concept_in_shown_list: conceptKind === 'existing' || conceptKind === 'canonical_proposal' ? (context?.shown_concept_ids?.includes(binding.concept) ?? null) : null, shown_concepts: context?.shown_concept_ids?.length ?? null, retrieval_scope: context?.retrieval ?? null, escalated: context?.escalated ?? null,
      node_was_judged_in_packet: context ? context.judged_nodes.some(n => n.node_id === node.node_id) : null, family_nodes_total: context?.family_nodes_total ?? null, note: 'availability is per node; a concept absent from the shown list is not evidence that no concept applies' },
    owner: ownerBinding ? { binding_id: ownerBinding.binding_id, node: ownerBinding.node_label } : null,
    private_review_notes: notes.map(n => ({ source: n.source, verdict: n.verdict, note: n.note })),
    reach: coverageState ?? null };
}

/** What changed between two replays of the same family set. Keys are node, role, concept and predicate. */
export function diffReplays(a, b) {
  const key = r => `${r.subject.node_id}|${r.predicate.role}|${r.concept.id}|${r.predicate.name}`;
  const ma = new Map(a.map(r => [key(r), r])), mb = new Map(b.map(r => [key(r), r]));
  const onlyA = [...ma.keys()].filter(k => !mb.has(k)), onlyB = [...mb.keys()].filter(k => !ma.has(k)), both = [...ma.keys()].filter(k => mb.has(k));
  const nodesA = new Set(a.map(r => r.subject.node_id)), nodesB = new Set(b.map(r => r.subject.node_id));
  const describe = (m, k) => ({ key: k, node: m.get(k).subject.label, role: m.get(k).predicate.role, predicate: m.get(k).predicate.name, concept: m.get(k).concept.label ?? m.get(k).concept.id });
  return { in_both: both.length, only_in_first: onlyA.map(k => describe(ma, k)), only_in_second: onlyB.map(k => describe(mb, k)),
    nodes_bound_only_in_first: [...nodesA].filter(n => !nodesB.has(n)).length, nodes_bound_only_in_second: [...nodesB].filter(n => !nodesA.has(n)).length,
    note: 'a difference is a difference between scaffolds and validators on the same ids and pins, not a difference in correctness' };
}
