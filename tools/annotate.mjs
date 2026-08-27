#!/usr/bin/env node
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { factKey, parseArgs, stableStringify } from './lib.mjs';
import { buildPresentationRecords } from './presentation-records.mjs';
import { ADJUDICATION_SCHEMA_VERSION, validateRecord } from './adjudication-schema.mjs';

const HELP=`Usage:
  node tools/estate-map/annotate.mjs validate <overlay.jsonl>
  node tools/estate-map/annotate.mjs validate-refusals <ledger.refusals.jsonl>
  node tools/estate-map/annotate.mjs validate-unclassified <ledger.structural-unclassified.jsonl>
  node tools/estate-map/annotate.mjs validate-entity-layer <layer.entity-layer.jsonl>
  node tools/estate-map/annotate.mjs validate-interpretation-layer <layer.interpretation-layer.jsonl>
  node tools/estate-map/annotate.mjs validate-dataflow-layer <layer.dataflow-layer.jsonl>
  node tools/estate-map/annotate.mjs validate-graph-witnesses <estate-graph.json> [--kinds a,b,c]
  node tools/estate-map/annotate.mjs merge <graph-dir> <overlays-dir>
Validate deterministic annotation overlays, refusal records or structural-unclassified
records, or merge them beside the canonical graph.

MERGE ROUTES BY FILENAME SUFFIX. The suffix is the ONLY routing signal; the records'
own 'schema' field is not consulted. A producer that writes a valid record family to a
file with the wrong name has its records read as overlays and rejected.

  *.refusals.jsonl                 -> graph.refusals
  *.structural-unclassified.jsonl  -> graph.structural_unclassified
  *.entity-layer.jsonl             -> graph.entity_layer
  *.interpretation-layer.jsonl     -> graph.interpretation_layer
  *.dataflow-layer.jsonl           -> graph.dataflow_layer
  *.domain-prepass.jsonl           -> graph.domain_prepass_receipts
  *.adjudication-records.jsonl     -> graph.adjudication_records
  every other *.jsonl              -> graph.overlays`;
// Provenance vocabulary. `llm_annotation` is a model inference; `doc_derived_annotation`
// is a deterministic parse of a committed document (see ddd-overlays.mjs) and must not be
// labelled as an LLM judgement.
export const ANNOTATION_KINDS=Object.freeze(['llm_annotation','doc_derived_annotation']);

// ---------------------------------------------------------------------------
// REFUSAL RECORDS — a derivation rule's decision NOT to derive, carried as data.
//
// WHY A SEPARATE RECORD TYPE AND NOT AN ANNOTATION. An overlay annotation asserts
// something POSITIVE about a subject and the validator above therefore requires a
// non-empty `grounded_in`. Most refusals are ABSENCE-SHAPED ("no documented import
// neighbour exists") and have no `file:line` that exhibits them. l1-adjudication-spec.md
// §6.2 faces exactly this and refuses to weaken the non-empty `grounded_in` rule, because
// that rule is "the structural difference between an adjudication and a hallucination";
// absence lives in a separate ledger instead. Refusal records follow that precedent:
// `validateAnnotation` is UNCHANGED, and refusals ride in their own array of the same
// merged graph artifact rather than in a parallel store.
//
// WHY NOT A NODE ATTRIBUTE. merge.mjs rebuilds every node from facts on each run, so an
// attribute written by a later pass is clobbered by regeneration — and one node can be
// refused by several rules for several reasons, which a scalar attribute cannot hold.
export const REFUSAL_SCHEMA='estate-map/refusal-record/v1';
// Frozen vocabulary, in the style of ANNOTATION_KINDS above: a refusal reason is an enum
// member a later process can GROUP BY, never a free-text sentence. Parameterised detail
// (the node kind, the conflicting domains) belongs in `reason_detail`, not in the code.
export const REFUSAL_REASONS=Object.freeze([
  // R1 manifest_publication — envelope kinds.
  'no_manifest_publisher',                                   // no plugin.yaml declares this kind
  'declaring_plugin_has_no_documented_domain',               // declared, but canon has no row for the plugin
  'publisher_set_mixes_documented_and_undocumented_plugins', // some declaring plugins documented, some not
  'publisher_domain_conflict',                               // documented publishers disagree on the domain
  // R2 import_neighbourhood — modules.
  'no_documented_import_neighbour',                          // imports nothing canon assigns a domain
  'single_documented_import_neighbour_below_threshold',      // unanimous, but fewer neighbours than the bar
  'import_neighbourhood_domain_conflict',                    // documented neighbours in >1 domain
  // R0 — the node kinds no rule addresses at all.
  'no_applicable_rule_for_node_kind',
]);
// DESIGN.md §2.5 state machine, one level down. A refusal TRANSITIONS; it is never dropped.
//   refused                  — the rule refuses this subject on the current graph
//   superseded_by_derivation — a later rule succeeded; the refusal happened and is kept
//   withdrawn                — no longer refused and not derived (subject left the corpus)
export const REFUSAL_STATES=Object.freeze(['refused','superseded_by_derivation','withdrawn']);
// §2.5.1 honesty rule made machine-checkable. `witnessed` carries only real {repo,file,line};
// `absence` carries NO witness and must state its limitation; `mixed` is a refusal that found
// something real AND failed to find something else.
export const REFUSAL_EVIDENCE_SHAPES=Object.freeze(['witnessed','mixed','absence']);
// Why a refusal stopped standing. Kept separate from REFUSAL_STATES because "the record no
// longer applies" has genuinely different causes and collapsing them loses the signal:
//   derived                     — a rule succeeded on this subject (the §2.5 unverifiable→implements arrow)
//   refused_for_different_reason — still refused, under another reason code (the RULE moved, not the subject)
//   no_longer_refused           — neither refused nor derived: canon now seeds it, or it left the corpus
export const REFUSAL_RESOLUTION_KINDS=Object.freeze(['derived','refused_for_different_reason','no_longer_refused']);
export const REFUSAL_FILE_SUFFIX='.refusals.jsonl';

// DOMAIN PREPASS RECEIPTS — one persisted decision for every node without a
// documented-domain anchor. Assignment overlays are separate positive records;
// these receipts retain the ambiguous/no-anchor alternatives views must expose.
export const DOMAIN_PREPASS_SCHEMA='estate-map/domain-prepass-receipt/v1';
export const DOMAIN_PREPASS_FILE_SUFFIX='.domain-prepass.jsonl';
export const DOMAIN_PREPASS_STATUSES=Object.freeze(['assigned','ambiguous','no_anchor','ineligible_subject','fixture_only']);
// no_anchor + the two @2 gate states (ineligible_subject, fixture_only) carry no adjacency candidates/evidence.
export const DOMAIN_PREPASS_NON_ADJACENT_STATUSES=Object.freeze(['no_anchor','ineligible_subject','fixture_only']);
const DOMAIN_PREPASS_FIELDS=['candidates','domain','evidence','examined_edge_ids','exclusion_reason','generated_at','producer','reason','rule_id','rule_version','schema','status','subject','subject_kind','subject_witnesses'];
const DOMAIN_PREPASS_EVIDENCE_FIELDS=['domain','edge_ids','witnesses'];

// ---------------------------------------------------------------------------
// STRUCTURAL-UNCLASSIFIED RECORDS — the structural layer's refusal, carried as data.
//
// WHY A THIRD RECORD FAMILY AND NOT A REFUSAL. graph.refusals is the DOMAIN-derivation
// ledger: every reason in REFUSAL_REASONS is about why a rule would not assign a documented
// DOMAIN, and loop-driver.mjs reads that ledger for the T4 admissibility test. "No structural
// rule covers this component" is a different question by a different producer, and folding it
// into graph.refusals would inflate the refusal census and the T4 new-refusal count with
// records that have nothing to do with domain derivation. It rides in its own array of the
// same merged artifact instead, exactly as refusals ride beside overlays.
//
// WHY IT EXISTS AT ALL. A structural grouping that silently swept its leftovers into a
// default bucket would be the very failure the grouping is meant to fix, one level down. A
// node with no applicable structural rule gets an explicit record naming the reason, and the
// view's `unclassified` group is BUILT FROM THOSE RECORDS rather than from fallthrough.
export const STRUCTURAL_UNCLASSIFIED_SCHEMA='estate-map/structural-unclassified/v1';
export const STRUCTURAL_UNCLASSIFIED_FILE_SUFFIX='.structural-unclassified.jsonl';
// Frozen vocabulary, same discipline as REFUSAL_REASONS: an enum a later process can GROUP BY.
export const STRUCTURAL_UNCLASSIFIED_REASONS=Object.freeze([
  'no_structural_rule_for_component', // the node is positioned, but no rule covers its component
  'no_witness_to_position_the_node',  // the node carries no witness, so it cannot be positioned at all
]);
// ---------------------------------------------------------------------------
// ENTITY-LAYER RECORDS — the DOMAIN entities, their typed relationships, the envelope kinds
// attached to them, and both halves of every cross-source disagreement.
//
// WHY A FOURTH RECORD FAMILY AND NOT graph.nodes. The entity layer is the only layer in this
// toolkit whose subjects are NOT graph nodes: `entity:brew` is a thing the schema declares,
// not a file the walker found. Minting 13 new `graph.nodes` entries for it would raise the
// `undomained` queue by 13 (query.mjs#queueVector counts `graph.nodes` minus domained
// subjects) and inflate every node-population statistic in the toolkit with records from a
// different ontology. AC-NO-DRAIN forbids exactly that contamination, so the layer rides in
// its own array of the same merged artifact — like refusals and structural-unclassified
// records — and projection.mjs SYNTHESISES the ER view's nodes from it at render time.
//
// WHY ONE FAMILY WITH FIVE RECORD KINDS. All five are statements about the same subject
// (an entity), they are produced together by one derivation, and a consumer that reads
// entities without their refusals or conflicts would read a map that looks complete and is
// not. `record_kind` discriminates; the validator holds each kind to its own exact fields.
export const ENTITY_LAYER_SCHEMA='estate-map/entity-layer/v1';
export const ENTITY_LAYER_FILE_SUFFIX='.entity-layer.jsonl';
export const ENTITY_RECORD_KINDS=Object.freeze(['entity_type','relationship','envelope_attachment','capability_attachment','refusal','conflict']);
// Cardinality is what makes the landing view an ER diagram rather than a word cloud, and the
// schema can prove exactly these three: a plain foreign key admits many child rows (1..N), a
// UNIQUE or single-column-PK foreign key admits one (1..1), and a composite key or a
// polymorphic CHECK enum relates both sides many-to-many (N..N).
export const ENTITY_CARDINALITIES=Object.freeze(['1..1','1..N','N..N']);
export const ENTITY_RELATIONS=Object.freeze(['has_one','has_many','relates_to']);
export const ENTITY_REFUSAL_REASONS=Object.freeze([
  'single_source_uncorroborated',
  'read_model_or_infrastructure_table',
  'model_kind_without_schema_evidence',
  'insufficient_schema_evidence',
  'id_column_names_no_promoted_entity',
  'polymorphic_reference_not_resolvable_from_schema',
  'detail_table_without_entity_subject',
  'envelope_prefix_names_no_promoted_entity',
  // CAPABILITY ATTACHMENT (instrument fix J1). A capability type whose name does
  // not reach a promoted entity is refused, never attached to the nearest
  // plausible one: `legitimacy_escrow` and `dispatch_models` are real
  // capabilities about no entity this schema declares.
  'capability_type_names_no_promoted_entity',
  // TABLE AUDIT (entity-layer.mjs §TABLE AUDIT). Every extracted non-test table either backs
  // a promoted entity or carries one of these; a table that simply vanished from the layer
  // with no record is the failure mode that hid `envelopes` behind `instance_table: false`.
  'table_superseded_by_other_root_table',
  'table_names_no_promoted_entity',
]);
// ---------------------------------------------------------------------------
// INTERPRETATION-LAYER RECORDS — model inference over PROJECTIONS of the assembled graph,
// carrying a SECOND, WEAKER evidentiary class that is labelled as such everywhere.
//
// THE WITNESS PROBLEM, STATED RATHER THAN SMUGGLED. Every node in this map is witnessed at a
// real `file:line`: a demonstrative witness, a place you can open that EXHIBITS the fact. An
// interpretation node cannot have one. It is not at a line — it is ABOUT A SET. So this family
// carries `evidence_class: 'reproducible_slice_witness'` on EVERY record, and the witness it
// carries is the projection/query spec that produced the slice + the exact member node ids +
// the graph digest the spec was evaluated against. The check is mechanical and falsifiable:
// re-run the spec against that digest and you must get the same members back
// (interpretation-layer.mjs#reproduceSlice). It is NOT the same thing as `file:line` evidence
// and the schema never lets it be read as such.
//
// WHY A FIFTH RECORD FAMILY AND NOT AN OVERLAY ANNOTATION. Three independent reasons, each of
// which alone is disqualifying:
//   1. `validateAnnotation` requires a NON-EMPTY `grounded_in` of `{repo,file,line}` witnesses.
//      A slice witness has no line. Weakening that rule is exactly what l1-adjudication-spec.md
//      §6.2 refuses to do — it is "the structural difference between an adjudication and a
//      hallucination" — and satisfying it would mean SYNTHESISING a file:line for a set. Both
//      options are worse than a separate family, so the family is separate.
//   2. An overlay's `subject` is an EXISTING graph node. A concept node is a NEW subject; there
//      is no node to annotate. This is the same problem the entity layer has and solves the
//      same way (its subjects are entities the schema declares, not files the walker found).
//   3. `BODY_FIELDS` bodies are flat strings. A slice witness is a spec object plus a member
//      array plus a digest; it cannot be expressed as a body of scalars without lossy encoding.
// The consequence is the honesty guarantee: minting concept graph nodes would raise the
// `undomained` queue by their count and put model inferences into every extracted-node census.
// These records are not nodes, carry no `body.domain`, and `projection.mjs` synthesises the
// interpretation view from them at render time — the same discipline the entity layer used.
//
// WHY ONE FAMILY WITH FIVE RECORD KINDS. All five are the shape reader's output over one slice
// enumeration and are produced together; a consumer that read concepts without their refusals
// and unverifiable documented concepts would read a map that looks complete and is not.
export const INTERPRETATION_LAYER_SCHEMA='estate-map/interpretation-layer/v1';
export const INTERPRETATION_LAYER_FILE_SUFFIX='.interpretation-layer.jsonl';
export const INTERPRETATION_RECORD_KINDS=Object.freeze(['concept','interpretation_relationship','doc_binding','unverifiable_doc_concept','refusal']);
// The label, carried on every record of the family, in the data and not only in a report.
// A consumer grouping by `evidence_class` separates the two evidentiary classes with one key.
export const INTERPRETATION_EVIDENCE_CLASS='reproducible_slice_witness';
// Every concept id begins with this prefix. Enforced by the validator, so an interpretation
// can never occupy a `module:` / `entity:` / `envelope_kind:` id and be mistaken for one.
export const INTERPRETATION_ID_PREFIX='interpretation:';
// The topologies the shape reader may assert BETWEEN concepts. Frozen for the same reason
// REFUSAL_REASONS is: a relation is an enum a later process can GROUP BY, not a sentence.
export const INTERPRETATION_RELATIONS=Object.freeze(['pipeline','hub_and_spoke','layering','producer_consumer_chain']);
// A slice with no coherent interpretation gets one of these. Refusal is the CORRECT output for
// an incoherent slice and is expected to be common: a deterministic enumerator produces many
// sets that are sets and nothing more.
export const INTERPRETATION_REFUSAL_REASONS=Object.freeze([
  'members_share_no_relation_beyond_enumeration', // the spec is the only thing they have in common
  'slice_is_a_kind_bucket_not_a_thing',           // "all routes" is a type, not a concept
  'members_span_unrelated_concerns',              // coherent sub-parts, no coherent whole
  'slice_too_small_to_constitute_a_thing',        // one or two members name themselves already
  'name_would_restate_the_enumerator',            // any honest name is the spec spelled out
  'coherence_only_via_test_fixtures',             // the only shared structure is test scaffolding
]);
// SHAPE EVIDENCE — the kinds of assertion a concept may rest on. Each is RE-DERIVED from the
// graph at apply time (interpretation-layer.mjs gate I4), so a model that asserts "these all
// publish envelope X" must be telling the truth about the graph or the record is rejected.
export const INTERPRETATION_SHAPE_EVIDENCE_KINDS=Object.freeze([
  'shared_edge_kind',          // every member is incident to >=1 edge of this kind
  'member_kind_histogram',     // the members' node-kind distribution
  'common_neighbour',          // every member is adjacent to this node id
  'degree_rank',               // this member's degree rank within the slice
  'repo_spread',               // the set of components the members span
  'shared_envelope_kind',      // every member emits/consumes this envelope kind
  'shared_capability',         // every member provides/requires/calls this capability
  'edge_direction_split',      // in/out edge counts of a given kind across the slice
  // The one that carries the most weight on this corpus, and the one the packet deliberately
  // does NOT pre-compute: the model must COUNT how many members' names share a prefix and
  // state `k/n` exactly. Wrong arithmetic is a rejection, so the claim costs the model work.
  'shared_name_prefix',
]);
// Where a DOCUMENTED concept came from. A binding pairs one of these with a slice.
export const INTERPRETATION_DOC_SOURCES=Object.freeze(['canon_entity_type','ddd_bounded_context','prose_text_span']);
const INTERPRETATION_RECORD_FIELDS=Object.freeze({
  concept:['coheres_because','concept','confidence','evidence_class','generated_at','id','kind','label','model','name_basis','producer','record_kind','rule','schema','shape_evidence','slice_witness'],
  interpretation_relationship:['confidence','evidence_class','from','generated_at','id','kind','model','producer','record_kind','relation','rule','schema','shape_evidence','slice_witnesses','statement','to'],
  doc_binding:['concept','confidence','doc_source','doc_witness','documented_concept','evidence_class','generated_at','id','kind','model','producer','record_kind','rule','schema','slice_witness'],
  unverifiable_doc_concept:['doc_source','doc_witness','documented_concept','evidence_class','examined','generated_at','id','model','producer','reason_detail','record_kind','rule','schema'],
  refusal:['evidence_class','examined','generated_at','id','kind','model','producer','reason','reason_detail','record_kind','rule','schema','slice_witness'],
});
// ---------------------------------------------------------------------------
// DATAFLOW-LAYER RECORDS — the SIXTH record family. Guarded-assignment flow skeletons extracted
// deterministically from the syntax tree, plus the claims a shape reader may make OVER them.
//
// WHY IT IS NOT THE INTERPRETATION FAMILY. That family's every record carries
// `reproducible_slice_witness` — evidence ABOUT A SET, with no line to open. A flow skeleton is
// the opposite: every element of it is at a real `file:line` with the verbatim source text, and a
// checker re-reads the file. Collapsing the two would relabel demonstrative evidence as
// distributional evidence, which is the exact confusion the interpretation family's header refuses
// to allow in the other direction. So this family carries TWO evidence classes, pinned per record
// kind, and the validator will not let a record wear the wrong one:
//   `witnessed_guarded_assignment` — the deterministic half (skeletons + extraction refusals).
//   `entailed_by_flow_skeleton`    — the model half (claims + claim refusals), whose evidence is
//                                    NOT the source but the SKELETON, cited by id AND digest.
//
// WHY THE CLAIM CARRIES BOTH A SENTENCE AND TYPED ASSERTIONS. `interpretation-layer.mjs` measured
// a 43.6% over-claim rate and named the mechanism: its gates checked evidence ITEMS and left the
// prose SENTENCE ungated. Its own §4.3 named the fix — "a `claims[]` array of typed, checkable
// assertions replacing free prose". This schema makes both mandatory and the layer's gate D6
// checks one against the other, so a sentence cannot assert an exclusion the assertions do not
// carry and an assertion cannot cite a guard the skeleton does not hold.
export const DATAFLOW_LAYER_SCHEMA='estate-map/dataflow-layer/v1';
export const DATAFLOW_LAYER_FILE_SUFFIX='.dataflow-layer.jsonl';
export const DATAFLOW_RECORD_KINDS=Object.freeze(['flow_skeleton','flow_refusal','flow_claim','claim_refusal']);
export const DATAFLOW_EVIDENCE_CLASSES=Object.freeze(['witnessed_guarded_assignment','entailed_by_flow_skeleton']);
// The deterministic half is NOT an `llm_annotation` and must not be able to claim it is; the model
// half is, and must not be able to deny it.
export const DATAFLOW_PROVENANCE_KINDS=Object.freeze(['deterministic_extraction','llm_annotation']);
export const DATAFLOW_EVIDENCE_CLASS_FOR_RECORD_KIND=Object.freeze({
  flow_skeleton:'witnessed_guarded_assignment',
  flow_refusal:'witnessed_guarded_assignment',
  flow_claim:'entailed_by_flow_skeleton',
  claim_refusal:'entailed_by_flow_skeleton',
});
export const DATAFLOW_PROVENANCE_FOR_RECORD_KIND=Object.freeze({
  flow_skeleton:'deterministic_extraction',
  flow_refusal:'deterministic_extraction',
  flow_claim:'llm_annotation',
  claim_refusal:'llm_annotation',
});
export const DATAFLOW_ID_PREFIX='flow:';
// Two families because a condition dominates a write in two structurally different ways: the write
// sits INSIDE a branch, or a guarded exit BEFORE it skips it. D7 is the second shape.
export const DATAFLOW_GUARD_FAMILIES=Object.freeze(['enclosing','early_exit']);
export const DATAFLOW_GUARD_KINDS=Object.freeze([
  'if_consequence','if_alternative','switch_case','switch_default','ternary_consequence',
  'ternary_alternative','logical_and','logical_or','optional_call',
  'early_exit_return','early_exit_continue','early_exit_break','early_exit_throw',
]);
// `requires` — the write happens only when the condition is TRUE. `requires_not` — only when
// FALSE. `skips_when` — the write is SKIPPED when the condition is TRUE. The distinction is the
// whole content of an exclusion claim, so it is an enum and never a sentence.
export const DATAFLOW_GUARD_POLARITIES=Object.freeze(['requires','requires_not','skips_when']);
export const DATAFLOW_SINK_CLASSES=Object.freeze(['counter','prepared_statement_write','map_counter','reduce_aggregate']);
export const DATAFLOW_SOURCE_ORIGINS=Object.freeze(['parameter','destructured_parameter','local_declaration','loop_binding','catch_binding','unresolved_in_scope']);
export const DATAFLOW_ASSERTION_TYPES=Object.freeze(['excludes_when','requires','accumulates_from','writes_unconditionally','writes_at']);
const DATAFLOW_ASSERTION_FIELDS=Object.freeze(['guard_line','quoted_condition','subject','type']);
// The extractor's refusals: what could not be resolved WITHOUT LEAVING THE SCOPE. Frozen so a
// consumer can GROUP BY the boundary that stopped it.
export const DATAFLOW_REFUSAL_REASONS=Object.freeze([
  'callee_is_member_expression',
  'callee_declared_outside_module',
  'callee_name_ambiguous_in_module',
  'callee_is_imported_binding',
  'resolution_depth_exceeded',
  'sink_target_unresolvable_cross_module',
  'source_unresolvable_in_scope',
  'dynamic_sink_expression',
  'parse_failed',
]);
// The reader's refusals: a proven skeleton it declines to say anything about. A proven flow with
// no interpretation is still coverage, so refusing is a first-class outcome.
export const DATAFLOW_CLAIM_REFUSAL_REASONS=Object.freeze([
  'skeleton_has_no_guard_to_interpret',
  'guard_condition_not_interpretable',
  'claim_would_restate_the_skeleton',
  'sink_meaning_unresolvable_in_scope',
]);
const DATAFLOW_RECORD_FIELDS=Object.freeze({
  flow_skeleton:['chain_steps','digest','evidence_class','file','function_end_line','function_line','function_name','generated_at','guards','id','kind','producer','record_kind','repo','rule','schema','sink','sites','sources'],
  flow_refusal:['detail','evidence_class','file','generated_at','id','kind','line','producer','reason','record_kind','repo','rule','schema','unresolvable'],
  flow_claim:['assertions','claim_sentence','confidence','evidence_class','generated_at','id','kind','model','producer','record_kind','rule','schema','skeleton_digest','skeleton_id'],
  claim_refusal:['detail','evidence_class','generated_at','id','kind','model','producer','reason','record_kind','rule','schema','skeleton_digest','skeleton_id'],
});
// `dominates_sites` is load-bearing, not decoration: a sink written at seven sites collects the
// UNION of their guards, and without knowing WHICH sites a guard dominates a claim can call a
// partial exclusion a total one. The layer's gate D3 refuses an exclusion whose guard does not
// dominate every site, and it can only do that because the record carries this list.
const DATAFLOW_GUARD_FIELDS=Object.freeze(['condition','dominates_sites','family','kind','line','polarity']);
const DATAFLOW_SITE_FIELDS=Object.freeze(['idiom','line','resolution','text','value_text','via_nested_closure']);
const DATAFLOW_RESOLUTION_FIELDS=Object.freeze(['call_line','callee','declared_line','hop']);
const DATAFLOW_SOURCE_FIELDS=Object.freeze(['line','name','origin','text']);
const DATAFLOW_CHAIN_STEP_FIELDS=Object.freeze(['line','receiver','step','text']);
const DATAFLOW_SINK_FIELDS=Object.freeze(['class','expression','idioms']);
const SLICE_WITNESS_FIELDS=Object.freeze(['enumerator','graph_digest','member_count','members','slice_id','spec','spec_hash']);
const DOC_WITNESS_FIELDS=Object.freeze(['file','line','quoted_doc','repo']);
const SHAPE_EVIDENCE_FIELDS=Object.freeze(['kind','statement','subject','value']);
const NAME_BASIS_FIELDS=Object.freeze(['source','token','where']);
export const ENTITY_CONFLICT_REASONS=Object.freeze([
  'entity_name_disagreement',
  'model_declares_entity_schema_has_no_table',
  'schema_declares_entity_model_has_no_kind',
  'schema_relationship_has_no_model_edge_kind',
]);
const ENTITY_SCHEMA_EVIDENCE=Object.freeze(['root_table','referenced_id']);
const ENTITY_RELATIONSHIP_BASES=Object.freeze(['declared_foreign_key','fk_shaped_column','polymorphic_check_enum','link_table']);
const ENTITY_RELATIONSHIP_STATUSES=Object.freeze(['schema_declared','shape_only','read_model_evidence']);
const ENTITY_CLAIM_SOURCES=Object.freeze(['sqlite_schema','shipped_model','code_signal','envelope_namespace']);
const ENTITY_RECORD_FIELDS=Object.freeze({
  entity_type:['corroboration','entity','id','instance_table','label','producer','record_kind','root_table','rule','schema','schema_evidence','witnesses'],
  relationship:['basis','cardinality','from','id','note','producer','record_kind','relation','rule','schema','status','to','via','witnesses'],
  envelope_attachment:['entity','envelope_kind','envelope_node','id','producer','record_kind','rule','schema','witnesses'],
  capability_attachment:['capability','capability_node','entity','id','producer','providers','record_kind','rule','schema','witnesses'],
  refusal:['examined','id','producer','reason','reason_detail','record_kind','rule','schema','subject','subject_kind','witnesses'],
  conflict:['about','claim_a','claim_b','id','producer','reason','record_kind','schema','witnesses'],
});
// relation and cardinality are two views of ONE schema fact, so they cannot be set
// independently: a record claiming `has_one` at `1..N` would be asserting that the same
// column is and is not unique.
const ENTITY_RELATION_FOR_CARDINALITY=Object.freeze({'1..1':'has_one','1..N':'has_many','N..N':'relates_to'});
const TOP_FIELDS=['annotation_kind','body','confidence','generated_at','grounded_in','kind','model','subject'];
const BODY_FIELDS={
  service_card:['domain','key_flows','risks','summary'],
  proposed_edge:['edge_kind','from','reasoning','to'],
  finding:['detail','severity','title'],
  // STRUCTURAL GROUP — a fact about file layout, NEVER an assertion about the business.
  // `group` is a member of structural-grouping.mjs#STRUCTURAL_GROUPS, `rule` names the rule
  // that fired, and `basis` states the exact directory/kind fact it fired on. Deliberately
  // has NO `domain` field: query.mjs#domainedSubjects keys off `body.domain`, so a structural
  // annotation cannot drain the undomained queue even by accident.
  structural_group:['basis','group','rule'],
};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exactFields(value,allowed,label){
  if(!isObject(value))throw new Error(`${label} must be an object`);
  const unknown=Object.keys(value).filter(key=>!allowed.includes(key));
  if(unknown.length)throw new Error(`${label} has unknown field(s): ${unknown.sort().join(', ')}`);
  const missing=allowed.filter(key=>!(key in value));
  if(missing.length)throw new Error(`${label} is missing field(s): ${missing.join(', ')}`);
}
function nonempty(value,label){if(typeof value!=='string'||!value.trim())throw new Error(`${label} must be a non-empty string`);}
function isoUtc(value,label){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)||Number.isNaN(Date.parse(value)))throw new Error(`${label} must be an ISO UTC timestamp`);}
function witnessAt(value,label){exactFields(value,['file','line','repo'],label);nonempty(value.repo,`${label}.repo`);nonempty(value.file,`${label}.file`);if(!Number.isInteger(value.line)||value.line<1)throw new Error(`${label}.line must be a positive integer`);}
export function validateAnnotation(record,label='annotation'){
  exactFields(record,TOP_FIELDS,label);
  if(!ANNOTATION_KINDS.includes(record.kind))throw new Error(`${label}.kind must be one of ${ANNOTATION_KINDS.join(', ')}`);
  if(!BODY_FIELDS[record.annotation_kind])throw new Error(`${label}.annotation_kind is invalid`);
  for(const field of ['subject','model'])nonempty(record[field],`${label}.${field}`);
  isoUtc(record.generated_at,`${label}.generated_at`);
  if(typeof record.confidence!=='number'||!Number.isFinite(record.confidence)||record.confidence<0||record.confidence>1)throw new Error(`${label}.confidence must be between 0 and 1`);
  if(!Array.isArray(record.grounded_in)||record.grounded_in.length===0)throw new Error(`${label}.grounded_in must contain at least one witness`);
  record.grounded_in.forEach((witness,index)=>witnessAt(witness,`${label}.grounded_in[${index}]`));
  exactFields(record.body,BODY_FIELDS[record.annotation_kind],`${label}.body`);
  for(const [field,value] of Object.entries(record.body)){
    if(['key_flows','risks'].includes(field)){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new Error(`${label}.body.${field} must be a string array`);}
    else nonempty(value,`${label}.body.${field}`);
  }
  return record;
}
// ---------------------------------------------------------------------------
// GRAPH-EDGE WITNESS VALIDATION.
//
// Every validator above checks a RECORD family. Nothing checked the graph's own edges, and
// the map's central promise is about edges: "Every fact and edge witness contains `repo`,
// repository-relative `file`, and 1-based `line`" (README §Vocabulary). That promise was
// enforced by convention — each producer site remembering to pass `witnesses:[provenance(f)]`
// — and convention is exactly what a new edge kind forgets. This validator makes it
// mechanical: an edge that connects two real nodes must exhibit at least one witness in the
// SAME `{repo,file,line}` shape the annotation validators already demand.
//
// SCOPE, stated rather than assumed:
//   * an edge with no resolved `to` and no `candidates` connects nothing and is skipped — it
//     is an unresolved record wearing an edge shape, and `graph.unresolved` is where its
//     provenance lives;
//   * the line rule is "positive 1-based integer", identical to witnessAt above. A
//     component-level witness is `{file:'.',line:1}`, not line 0, so nothing legitimate needs
//     the rule weakened.
const edgeTargets=edge=>(edge.to?[edge.to]:(Array.isArray(edge.candidates)?edge.candidates:[]));
/** Validate ONE graph edge's witnesses. Throws with the edge id on the first violation. */
export function validateEdgeWitness(edge,label='edge'){
  const name=`${label}[${edge?.id||'(no id)'}]`;
  if(!edge||typeof edge!=='object')throw new Error(`${name} is not an object`);
  nonempty(edge.id,`${name}.id`);
  nonempty(edge.kind,`${name}.kind`);
  if(!Array.isArray(edge.witnesses)||edge.witnesses.length===0)throw new Error(`${name} must carry at least one file:line witness`);
  edge.witnesses.forEach((witness,index)=>{
    const witnessLabel=`${name}.witnesses[${index}]`;
    if(!witness||typeof witness!=='object')throw new Error(`${witnessLabel} is not an object`);
    nonempty(witness.repo,`${witnessLabel}.repo`);
    nonempty(witness.file,`${witnessLabel}.file`);
    if(!Number.isInteger(witness.line)||witness.line<1)throw new Error(`${witnessLabel}.line must be a positive integer`);
  });
  return edge;
}
/**
 * Validate every connecting edge in a merged graph. Returns a per-kind census so a caller can
 * see WHICH kinds were covered rather than only that nothing threw — a validator that silently
 * examined zero edges passes just as loudly as one that examined ten thousand.
 */
export function validateGraphWitnesses(graph,{kinds=null}={}){
  const nodeIds=new Set((graph?.nodes||[]).map(node=>node.id));
  const byKind=new Map();
  let checked=0,skipped=0;
  for(const edge of graph?.edges||[]){
    if(kinds&&!kinds.includes(edge.kind))continue;
    const targets=edgeTargets(edge).filter(id=>nodeIds.has(id));
    if(!nodeIds.has(edge.from)||!targets.length){skipped++;continue;}
    validateEdgeWitness(edge,'edge');
    checked++;byKind.set(edge.kind,(byKind.get(edge.kind)||0)+1);
  }
  return{checked,skipped,by_kind:Object.fromEntries([...byKind].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])))};
}

const REFUSAL_FIELDS=['evidence','first_observed_at','id','last_observed_at','producer','reason','reason_detail','resolution','rule','schema','state','subject','subject_kind'];
const REFUSAL_EVIDENCE_FIELDS=['examined','not_found','shape','witnesses'];
const REFUSAL_EXAMINED_FIELDS=['relation','target','value','witness'];
const REFUSAL_NOT_FOUND_FIELDS=['limitation','over','sought'];
const REFUSAL_RESOLUTION_FIELDS=['domain','kind','note','rule'];
/**
 * Validate one refusal record. Deliberately a SEPARATE validator from validateAnnotation:
 * admitting absence into the annotation schema would require dropping the non-empty
 * `grounded_in` rule, which l1-adjudication-spec.md §6.2 refuses to ask for.
 */
export function validateDomainPrepassReceipt(record,label='domain_prepass'){
  exactFields(record,DOMAIN_PREPASS_FIELDS,label);
  if(record.schema!==DOMAIN_PREPASS_SCHEMA)throw new Error(`${label}.schema must be ${DOMAIN_PREPASS_SCHEMA}`);
  for(const field of ['producer','rule_id','rule_version','subject','subject_kind','reason'])nonempty(record[field],`${label}.${field}`);
  if(!DOMAIN_PREPASS_STATUSES.includes(record.status))throw new Error(`${label}.status must be one of ${DOMAIN_PREPASS_STATUSES.join(', ')}`);
  isoUtc(record.generated_at,`${label}.generated_at`);
  if(!Array.isArray(record.candidates)||record.candidates.some(value=>typeof value!=='string'||!value))throw new Error(`${label}.candidates must be a string array`);
  if(record.status==='assigned'){
    nonempty(record.domain,`${label}.domain`);
    if(record.candidates.length!==1||record.candidates[0]!==record.domain)throw new Error(`${label}.assigned receipt must carry exactly its domain as candidate`);
  }else if(record.domain!==null)throw new Error(`${label}.${record.status} receipt domain must be null`);
  if(!Array.isArray(record.subject_witnesses))throw new Error(`${label}.subject_witnesses must be an array`);
  record.subject_witnesses.forEach((witness,index)=>witnessAt(witness,`${label}.subject_witnesses[${index}]`));
  if(!Array.isArray(record.examined_edge_ids)||record.examined_edge_ids.some(value=>typeof value!=='string'||!value))throw new Error(`${label}.examined_edge_ids must be a string array`);
  if(!Array.isArray(record.evidence))throw new Error(`${label}.evidence must be an array`);
  record.evidence.forEach((entry,index)=>{
    const at=`${label}.evidence[${index}]`;exactFields(entry,DOMAIN_PREPASS_EVIDENCE_FIELDS,at);nonempty(entry.domain,`${at}.domain`);
    if(!Array.isArray(entry.edge_ids)||entry.edge_ids.some(value=>typeof value!=='string'||!value))throw new Error(`${at}.edge_ids must be a string array`);
    if(!Array.isArray(entry.witnesses))throw new Error(`${at}.witnesses must be an array`);
    entry.witnesses.forEach((witness,witnessIndex)=>witnessAt(witness,`${at}.witnesses[${witnessIndex}]`));
  });
  if(DOMAIN_PREPASS_NON_ADJACENT_STATUSES.includes(record.status)&&(record.candidates.length||record.evidence.length))throw new Error(`${label}.${record.status} receipt must carry no candidates or evidence`);
  if(!DOMAIN_PREPASS_NON_ADJACENT_STATUSES.includes(record.status)&&!record.evidence.length)throw new Error(`${label}.${record.status} receipt must carry adjacency evidence`);
  if(record.status==='ineligible_subject'||record.status==='fixture_only')nonempty(record.exclusion_reason,`${label}.exclusion_reason`);
  else if(record.exclusion_reason!==null)throw new Error(`${label}.${record.status} receipt exclusion_reason must be null`);
  return record;
}
export function validateRefusal(record,label='refusal'){
  exactFields(record,REFUSAL_FIELDS,label);
  if(record.schema!==REFUSAL_SCHEMA)throw new Error(`${label}.schema must be ${REFUSAL_SCHEMA}`);
  for(const field of ['id','subject','subject_kind','producer','rule'])nonempty(record[field],`${label}.${field}`);
  if(!REFUSAL_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${REFUSAL_REASONS.join(', ')}`);
  if(record.reason_detail!==null)nonempty(record.reason_detail,`${label}.reason_detail`);
  if(!REFUSAL_STATES.includes(record.state))throw new Error(`${label}.state must be one of ${REFUSAL_STATES.join(', ')}`);
  for(const field of ['first_observed_at','last_observed_at'])isoUtc(record[field],`${label}.${field}`);
  const evidence=record.evidence;
  exactFields(evidence,REFUSAL_EVIDENCE_FIELDS,`${label}.evidence`);
  if(!REFUSAL_EVIDENCE_SHAPES.includes(evidence.shape))throw new Error(`${label}.evidence.shape must be one of ${REFUSAL_EVIDENCE_SHAPES.join(', ')}`);
  if(!Array.isArray(evidence.witnesses))throw new Error(`${label}.evidence.witnesses must be an array`);
  evidence.witnesses.forEach((witness,index)=>witnessAt(witness,`${label}.evidence.witnesses[${index}]`));
  if(!Array.isArray(evidence.examined))throw new Error(`${label}.evidence.examined must be an array`);
  evidence.examined.forEach((item,index)=>{
    const at=`${label}.evidence.examined[${index}]`;exactFields(item,REFUSAL_EXAMINED_FIELDS,at);
    for(const field of ['relation','target','value'])nonempty(item[field],`${at}.${field}`);
    if(item.witness!==null)witnessAt(item.witness,`${at}.witness`);
  });
  if(evidence.not_found!==null){exactFields(evidence.not_found,REFUSAL_NOT_FOUND_FIELDS,`${label}.evidence.not_found`);for(const field of REFUSAL_NOT_FOUND_FIELDS)nonempty(evidence.not_found[field],`${label}.evidence.not_found.${field}`);}
  // The honesty invariant. An absence-shaped refusal MUST NOT carry a witness it did not
  // find, and a refusal that really did examine a `file:line` MUST NOT hide behind an
  // absence claim. The shape is derived from the carried evidence, never asserted freely.
  const witnessed=evidence.witnesses.length>0,absent=evidence.not_found!==null;
  if(!witnessed&&!absent)throw new Error(`${label}.evidence carries neither a witness nor a stated absence`);
  const implied=witnessed&&absent?'mixed':witnessed?'witnessed':'absence';
  if(evidence.shape!==implied)throw new Error(`${label}.evidence.shape is '${evidence.shape}' but the carried evidence is '${implied}' (witnesses=${evidence.witnesses.length}, not_found=${absent})`);
  if(record.resolution!==null){
    exactFields(record.resolution,REFUSAL_RESOLUTION_FIELDS,`${label}.resolution`);
    if(!REFUSAL_RESOLUTION_KINDS.includes(record.resolution.kind))throw new Error(`${label}.resolution.kind must be one of ${REFUSAL_RESOLUTION_KINDS.join(', ')}`);
    nonempty(record.resolution.note,`${label}.resolution.note`);
    for(const field of ['domain','rule'])if(record.resolution[field]!==null)nonempty(record.resolution[field],`${label}.resolution.${field}`);
  }
  if((record.state==='refused')!==(record.resolution===null))throw new Error(`${label}.resolution must be null exactly when state is 'refused'`);
  return record;
}
const STRUCTURAL_UNCLASSIFIED_FIELDS=['examined','id','producer','reason','reason_detail','rule','schema','subject','subject_kind','witness'];
/**
 * Validate one structural-unclassified record. A SEPARATE validator again, for the same
 * reason validateRefusal is separate from validateAnnotation: this record asserts an absence
 * ("no structural rule covers this node") and therefore has no positive `grounded_in`.
 */
export function validateStructuralUnclassified(record,label='structural_unclassified'){
  exactFields(record,STRUCTURAL_UNCLASSIFIED_FIELDS,label);
  if(record.schema!==STRUCTURAL_UNCLASSIFIED_SCHEMA)throw new Error(`${label}.schema must be ${STRUCTURAL_UNCLASSIFIED_SCHEMA}`);
  for(const field of ['id','subject','subject_kind','producer','rule'])nonempty(record[field],`${label}.${field}`);
  if(!STRUCTURAL_UNCLASSIFIED_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${STRUCTURAL_UNCLASSIFIED_REASONS.join(', ')}`);
  nonempty(record.reason_detail,`${label}.reason_detail`);
  if(!Array.isArray(record.examined)||record.examined.length===0)throw new Error(`${label}.examined must name at least one thing the rule set looked at`);
  record.examined.forEach((item,index)=>{const at=`${label}.examined[${index}]`;exactFields(item,['relation','target','value'],at);for(const field of ['relation','target','value'])nonempty(item[field],`${at}.${field}`);});
  // A node WITHOUT a witness cannot be positioned, which is itself one of the two reasons; a
  // node WITH a witness must carry it, so the record proves the rule set really saw a path.
  if(record.witness!==null)witnessAt(record.witness,`${label}.witness`);
  const implied=record.witness===null?'no_witness_to_position_the_node':'no_structural_rule_for_component';
  if(record.reason!==implied)throw new Error(`${label}.reason is '${record.reason}' but the carried evidence implies '${implied}' (witness=${record.witness===null?'absent':'present'})`);
  return record;
}
/**
 * Validate one entity-layer record. A SEPARATE validator again, for the same reason
 * validateRefusal is separate from validateAnnotation: these records' subjects are entities
 * and relationships rather than graph nodes, and three of the five kinds legitimately carry
 * an absence (a refusal, and the missing half of a conflict) that the annotation schema's
 * non-empty `grounded_in` rule would forbid.
 */
export function validateEntityLayerRecord(record,label='entity_layer'){
  if(!isObject(record))throw new Error(`${label} must be an object`);
  if(record.schema!==ENTITY_LAYER_SCHEMA)throw new Error(`${label}.schema must be ${ENTITY_LAYER_SCHEMA}`);
  if(!ENTITY_RECORD_KINDS.includes(record.record_kind))throw new Error(`${label}.record_kind must be one of ${ENTITY_RECORD_KINDS.join(', ')}`);
  exactFields(record,ENTITY_RECORD_FIELDS[record.record_kind],label);
  for(const field of ['id','producer'])nonempty(record[field],`${label}.${field}`);
  if(record.record_kind!=='conflict')nonempty(record.rule,`${label}.rule`);
  if(!Array.isArray(record.witnesses))throw new Error(`${label}.witnesses must be an array`);
  record.witnesses.forEach((item,index)=>witnessAt(item,`${label}.witnesses[${index}]`));
  if(record.record_kind==='entity_type'){
    for(const field of ['entity','label','schema_evidence'])nonempty(record[field],`${label}.${field}`);
    if(!ENTITY_SCHEMA_EVIDENCE.includes(record.schema_evidence))throw new Error(`${label}.schema_evidence must be one of ${ENTITY_SCHEMA_EVIDENCE.join(', ')}`);
    if(record.root_table!==null)nonempty(record.root_table,`${label}.root_table`);
    if(typeof record.instance_table!=='boolean')throw new Error(`${label}.instance_table must be a boolean`);
    // The honesty invariant. `instance_table` is what sizes the node in the landing view, so
    // it must BE the presence of a root table rather than a separate claim about it, and a
    // `root_table` evidence class without a root table is a contradiction.
    if(record.instance_table!==(record.root_table!==null))throw new Error(`${label}.instance_table is ${record.instance_table} but root_table is ${record.root_table===null?'null':`'${record.root_table}'`}`);
    if(record.schema_evidence==='root_table'&&record.root_table===null)throw new Error(`${label}.schema_evidence is 'root_table' but no root_table is carried`);
    if(!Array.isArray(record.corroboration)||!record.corroboration.length)throw new Error(`${label}.corroboration must name at least one INDEPENDENT source; schema evidence alone cannot promote an entity`);
    record.corroboration.forEach((item,index)=>{const at=`${label}.corroboration[${index}]`;exactFields(item,['detail','source'],at);nonempty(item.detail,`${at}.detail`);if(!ENTITY_CLAIM_SOURCES.includes(item.source))throw new Error(`${at}.source must be one of ${ENTITY_CLAIM_SOURCES.join(', ')}`);if(item.source==='sqlite_schema')throw new Error(`${at}.source is 'sqlite_schema', which is the evidence being corroborated, not an independent source`);});
    if(!record.witnesses.length)throw new Error(`${label}.witnesses must carry the file:line that declares the entity`);
  }else if(record.record_kind==='relationship'){
    for(const field of ['from','to','via'])nonempty(record[field],`${label}.${field}`);
    if(!ENTITY_RELATIONS.includes(record.relation))throw new Error(`${label}.relation must be one of ${ENTITY_RELATIONS.join(', ')}`);
    if(!ENTITY_CARDINALITIES.includes(record.cardinality))throw new Error(`${label}.cardinality must be one of ${ENTITY_CARDINALITIES.join(', ')}`);
    if(ENTITY_RELATION_FOR_CARDINALITY[record.cardinality]!==record.relation)throw new Error(`${label}.relation '${record.relation}' contradicts cardinality '${record.cardinality}' (expected '${ENTITY_RELATION_FOR_CARDINALITY[record.cardinality]}')`);
    if(!ENTITY_RELATIONSHIP_BASES.includes(record.basis))throw new Error(`${label}.basis must be one of ${ENTITY_RELATIONSHIP_BASES.join(', ')}`);
    if(!ENTITY_RELATIONSHIP_STATUSES.includes(record.status))throw new Error(`${label}.status must be one of ${ENTITY_RELATIONSHIP_STATUSES.join(', ')}`);
    // A DECLARED foreign key is the schema stating the target itself; anything weaker must
    // not claim to be schema-declared, or the ER diagram launders a name match into a
    // constraint the database never enforced.
    if(record.basis==='fk_shaped_column'&&record.status==='schema_declared')throw new Error(`${label}.status 'schema_declared' is not available to basis 'fk_shaped_column': no REFERENCES clause was found`);
    if(record.note!==null)nonempty(record.note,`${label}.note`);
    if(!record.witnesses.length)throw new Error(`${label}.witnesses must carry the column and table that prove the relationship`);
  }else if(record.record_kind==='envelope_attachment'){
    for(const field of ['entity','envelope_kind','envelope_node'])nonempty(record[field],`${label}.${field}`);
    if(!record.witnesses.length)throw new Error(`${label}.witnesses must carry a site that names the envelope kind`);
  }else if(record.record_kind==='capability_attachment'){
    for(const field of ['entity','capability','capability_node'])nonempty(record[field],`${label}.${field}`);
    if(!Array.isArray(record.providers))throw new Error(`${label}.providers must be an array of the plugin(s) whose code registers the capability`);
    record.providers.forEach((item,index)=>nonempty(item,`${label}.providers[${index}]`));
    if(!record.witnesses.length)throw new Error(`${label}.witnesses must carry the registration site that declares the capability`);
  }else if(record.record_kind==='refusal'){
    for(const field of ['subject','subject_kind','reason_detail'])nonempty(record[field],`${label}.${field}`);
    if(!ENTITY_REFUSAL_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${ENTITY_REFUSAL_REASONS.join(', ')}`);
    if(!Array.isArray(record.examined)||!record.examined.length)throw new Error(`${label}.examined must name at least one thing the rule set looked at`);
    record.examined.forEach((item,index)=>{const at=`${label}.examined[${index}]`;exactFields(item,['relation','target','value'],at);for(const field of ['relation','target','value'])nonempty(item[field],`${at}.${field}`);});
  }else{
    nonempty(record.about,`${label}.about`);
    if(!ENTITY_CONFLICT_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${ENTITY_CONFLICT_REASONS.join(', ')}`);
    for(const side of ['claim_a','claim_b']){
      const at=`${label}.${side}`;exactFields(record[side],['source','statement','witnesses'],at);
      nonempty(record[side].statement,`${at}.statement`);
      if(!ENTITY_CLAIM_SOURCES.includes(record[side].source))throw new Error(`${at}.source must be one of ${ENTITY_CLAIM_SOURCES.join(', ')}`);
      if(!Array.isArray(record[side].witnesses))throw new Error(`${at}.witnesses must be an array`);
      record[side].witnesses.forEach((item,index)=>witnessAt(item,`${at}.witnesses[${index}]`));
    }
    if(record.claim_a.source===record.claim_b.source)throw new Error(`${label} claims both come from '${record.claim_a.source}': a conflict is between DIFFERENT sources`);
    // One side of a conflict may legitimately be an absence ("the schema has no such table"),
    // but not both: two unwitnessed claims are a guess about a disagreement, not a record of one.
    if(!record.claim_a.witnesses.length&&!record.claim_b.witnesses.length)throw new Error(`${label} carries no witness on either side, so no disagreement is evidenced`);
  }
  return record;
}
const hex64=(value,label)=>{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new Error(`${label} must be a 64-character lowercase sha256 hex digest`);};
/**
 * Validate ONE slice witness — the whole of the weaker evidentiary class, in one place.
 *
 * `members` is required to be SORTED and DUPLICATE-FREE. That is not tidiness: reproduction is
 * a SET comparison done by comparing serialisations, so a canonical order is what makes
 * "re-run the spec and get the same members" a byte check rather than a fuzzy one.
 */
function sliceWitnessAt(value,label){
  exactFields(value,SLICE_WITNESS_FIELDS,label);
  for(const field of ['enumerator','slice_id'])nonempty(value[field],`${label}.${field}`);
  hex64(value.graph_digest,`${label}.graph_digest`);
  hex64(value.spec_hash,`${label}.spec_hash`);
  if(!isObject(value.spec))throw new Error(`${label}.spec must be the projection/query spec object that produced the slice`);
  if(!Array.isArray(value.members)||!value.members.length)throw new Error(`${label}.members must list the exact member node ids the spec produced`);
  value.members.forEach((item,index)=>nonempty(item,`${label}.members[${index}]`));
  const sorted=value.members.slice().sort();
  if(value.members.some((item,index)=>item!==sorted[index]))throw new Error(`${label}.members must be sorted, so reproduction is a byte comparison`);
  if(new Set(value.members).size!==value.members.length)throw new Error(`${label}.members must not repeat a node id`);
  if(value.member_count!==value.members.length)throw new Error(`${label}.member_count is ${value.member_count} but ${value.members.length} member(s) are listed`);
}
/** A DOC witness is a real {repo,file,line} PLUS the text quoted from it — the strong half of a binding. */
function docWitnessAt(value,label){
  exactFields(value,DOC_WITNESS_FIELDS,label);
  witnessAt({file:value.file,line:value.line,repo:value.repo},label);
  nonempty(value.quoted_doc,`${label}.quoted_doc`);
}
function shapeEvidenceAt(value,label){
  if(!Array.isArray(value)||!value.length)throw new Error(`${label} must carry at least one shape-evidence item; a concept with no shape evidence is a name with nothing under it`);
  value.forEach((item,index)=>{
    const at=`${label}[${index}]`;
    exactFields(item,SHAPE_EVIDENCE_FIELDS,at);
    if(!INTERPRETATION_SHAPE_EVIDENCE_KINDS.includes(item.kind))throw new Error(`${at}.kind must be one of ${INTERPRETATION_SHAPE_EVIDENCE_KINDS.join(', ')}`);
    for(const field of ['statement','subject','value'])nonempty(item[field],`${at}.${field}`);
  });
}
/**
 * Validate one interpretation-layer record. A FIFTH separate validator, for the reasons stated
 * at INTERPRETATION_LAYER_SCHEMA: the annotation schema's non-empty `grounded_in` cannot hold a
 * slice witness, and the only ways to satisfy it are to weaken it or to fabricate a file:line.
 *
 * The invariants below are the ones a model cannot talk past by writing more confidently:
 *   * `evidence_class` is pinned to the weaker class on EVERY record.
 *   * `kind` is pinned to `llm_annotation` — this is inference, and the provenance says so.
 *   * a concept id must live in the `interpretation:` namespace.
 *   * a `doc_binding` must carry BOTH witnesses; the closed field list makes a one-sided
 *     binding unrepresentable rather than merely discouraged.
 *   * an `unverifiable_doc_concept` may carry NO slice witness at all (it IS the no-match case),
 *     and must say what was examined.
 *   * NO record may carry `grounded_in`: the unknown-field check rejects any attempt to dress a
 *     slice witness up as demonstrative evidence.
 */
export function validateInterpretationRecord(record,label='interpretation'){
  if(!isObject(record))throw new Error(`${label} must be an object`);
  if(record.schema!==INTERPRETATION_LAYER_SCHEMA)throw new Error(`${label}.schema must be ${INTERPRETATION_LAYER_SCHEMA}`);
  if(!INTERPRETATION_RECORD_KINDS.includes(record.record_kind))throw new Error(`${label}.record_kind must be one of ${INTERPRETATION_RECORD_KINDS.join(', ')}`);
  exactFields(record,INTERPRETATION_RECORD_FIELDS[record.record_kind],label);
  for(const field of ['id','producer','model','rule'])nonempty(record[field],`${label}.${field}`);
  isoUtc(record.generated_at,`${label}.generated_at`);
  if(record.evidence_class!==INTERPRETATION_EVIDENCE_CLASS)throw new Error(`${label}.evidence_class must be '${INTERPRETATION_EVIDENCE_CLASS}': this family carries the WEAKER evidentiary class and must say so on every record`);
  // `unverifiable_doc_concept` is the one kind with no model judgement to label: it records that
  // a documented concept matched NOTHING, which is an absence the enumeration proves.
  if(record.record_kind!=='unverifiable_doc_concept'&&record.kind!=='llm_annotation')throw new Error(`${label}.kind must be 'llm_annotation': an interpretation is model inference, never a deterministic parse`);
  if('confidence' in record&&(typeof record.confidence!=='number'||!Number.isFinite(record.confidence)||record.confidence<0||record.confidence>1))throw new Error(`${label}.confidence must be between 0 and 1`);
  if(record.record_kind==='concept'){
    if(!record.id.startsWith(INTERPRETATION_ID_PREFIX))throw new Error(`${label}.id must begin with '${INTERPRETATION_ID_PREFIX}' so an interpretation can never be read as an extracted node`);
    for(const field of ['concept','label','coheres_because'])nonempty(record[field],`${label}.${field}`);
    sliceWitnessAt(record.slice_witness,`${label}.slice_witness`);
    shapeEvidenceAt(record.shape_evidence,`${label}.shape_evidence`);
    if(!Array.isArray(record.name_basis)||!record.name_basis.length)throw new Error(`${label}.name_basis must derive every significant token of the proposed name from something in the slice; a name from model memory alone is not admissible`);
    record.name_basis.forEach((item,index)=>{const at=`${label}.name_basis[${index}]`;exactFields(item,NAME_BASIS_FIELDS,at);for(const field of NAME_BASIS_FIELDS)nonempty(item[field],`${at}.${field}`);});
  }else if(record.record_kind==='interpretation_relationship'){
    for(const field of ['from','to','statement'])nonempty(record[field],`${label}.${field}`);
    if(record.from===record.to)throw new Error(`${label} relates '${record.from}' to itself`);
    for(const field of ['from','to'])if(!record[field].startsWith(INTERPRETATION_ID_PREFIX))throw new Error(`${label}.${field} must be an interpretation concept id`);
    if(!INTERPRETATION_RELATIONS.includes(record.relation))throw new Error(`${label}.relation must be one of ${INTERPRETATION_RELATIONS.join(', ')}`);
    if(!Array.isArray(record.slice_witnesses)||record.slice_witnesses.length<2)throw new Error(`${label}.slice_witnesses must carry the slice witness of BOTH related concepts`);
    record.slice_witnesses.forEach((item,index)=>sliceWitnessAt(item,`${label}.slice_witnesses[${index}]`));
    shapeEvidenceAt(record.shape_evidence,`${label}.shape_evidence`);
  }else if(record.record_kind==='doc_binding'){
    for(const field of ['concept','documented_concept'])nonempty(record[field],`${label}.${field}`);
    if(!record.concept.startsWith(INTERPRETATION_ID_PREFIX))throw new Error(`${label}.concept must be an interpretation concept id`);
    if(!INTERPRETATION_DOC_SOURCES.includes(record.doc_source))throw new Error(`${label}.doc_source must be one of ${INTERPRETATION_DOC_SOURCES.join(', ')}`);
    // THE POINT OF THE RECORD. A binding is the `implements` edge between an assertion and a
    // reality, so it must carry the assertion's witness AND the reality's witness. One of the
    // two alone is either an undocumented interpretation or an unverified document.
    docWitnessAt(record.doc_witness,`${label}.doc_witness`);
    sliceWitnessAt(record.slice_witness,`${label}.slice_witness`);
  }else if(record.record_kind==='unverifiable_doc_concept'){
    nonempty(record.documented_concept,`${label}.documented_concept`);
    nonempty(record.reason_detail,`${label}.reason_detail`);
    if(!INTERPRETATION_DOC_SOURCES.includes(record.doc_source))throw new Error(`${label}.doc_source must be one of ${INTERPRETATION_DOC_SOURCES.join(', ')}`);
    docWitnessAt(record.doc_witness,`${label}.doc_witness`);
    if(!Array.isArray(record.examined)||!record.examined.length)throw new Error(`${label}.examined must name what was searched before the concept was called unverifiable`);
    record.examined.forEach((item,index)=>{const at=`${label}.examined[${index}]`;exactFields(item,['relation','target','value'],at);for(const field of ['relation','target','value'])nonempty(item[field],`${at}.${field}`);});
  }else{
    nonempty(record.reason_detail,`${label}.reason_detail`);
    if(!INTERPRETATION_REFUSAL_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${INTERPRETATION_REFUSAL_REASONS.join(', ')}`);
    sliceWitnessAt(record.slice_witness,`${label}.slice_witness`);
    if(!Array.isArray(record.examined)||!record.examined.length)throw new Error(`${label}.examined must name what the reader looked at before refusing`);
    record.examined.forEach((item,index)=>{const at=`${label}.examined[${index}]`;exactFields(item,['relation','target','value'],at);for(const field of ['relation','target','value'])nonempty(item[field],`${at}.${field}`);});
  }
  return record;
}
const positiveInt=(value,label)=>{if(!Number.isInteger(value)||value<1)throw new Error(`${label} must be a positive integer line number`);};
/**
 * Validate one dataflow-layer record. A SIXTH separate validator.
 *
 * The invariants are the ones a confident sentence cannot talk past:
 *   * `evidence_class` and `kind` are pinned PER RECORD KIND, so the deterministic half can never
 *     be relabelled as model output and the model half can never be relabelled as extraction.
 *   * a skeleton's guards carry an enum POLARITY, never prose — `skips_when` versus `requires` is
 *     the entire content of an exclusion claim.
 *   * a claim must carry BOTH a `claim_sentence` and a non-empty typed `assertions` array. A
 *     sentence with no assertions is exactly the ungated prose that produced a 43.6% over-claim
 *     rate one layer ago; the schema makes it unrepresentable.
 *   * every conditional assertion must carry the `guard_line` AND the `quoted_condition` it rests
 *     on, so the gate has something verbatim to compare against the skeleton.
 *   * a claim carries NO `grounded_in` and NO witnesses of its own: its evidence is the skeleton,
 *     cited by id and digest, and the closed field list forbids inventing any other.
 */
export function validateDataflowRecord(record,label='dataflow'){
  if(!isObject(record))throw new Error(`${label} must be an object`);
  if(record.schema!==DATAFLOW_LAYER_SCHEMA)throw new Error(`${label}.schema must be ${DATAFLOW_LAYER_SCHEMA}`);
  if(!DATAFLOW_RECORD_KINDS.includes(record.record_kind))throw new Error(`${label}.record_kind must be one of ${DATAFLOW_RECORD_KINDS.join(', ')}`);
  exactFields(record,DATAFLOW_RECORD_FIELDS[record.record_kind],label);
  for(const f of ['id','producer','rule'])nonempty(record[f],`${label}.${f}`);
  isoUtc(record.generated_at,`${label}.generated_at`);
  const expectedClass=DATAFLOW_EVIDENCE_CLASS_FOR_RECORD_KIND[record.record_kind];
  if(record.evidence_class!==expectedClass)throw new Error(`${label}.evidence_class must be '${expectedClass}' for a ${record.record_kind}: this family carries TWO evidentiary classes and each record must say which one it is`);
  const expectedKind=DATAFLOW_PROVENANCE_FOR_RECORD_KIND[record.record_kind];
  if(record.kind!==expectedKind)throw new Error(`${label}.kind must be '${expectedKind}' for a ${record.record_kind}`);
  if(record.record_kind==='flow_skeleton'){
    if(!record.id.startsWith(DATAFLOW_ID_PREFIX))throw new Error(`${label}.id must begin with '${DATAFLOW_ID_PREFIX}' so a skeleton can never be read as an extracted node`);
    for(const f of ['file','function_name'])nonempty(record[f],`${label}.${f}`);
    nonempty(record.digest,`${label}.digest`);
    if(typeof record.repo!=='string')throw new Error(`${label}.repo must be a string`);
    positiveInt(record.function_line,`${label}.function_line`);
    positiveInt(record.function_end_line,`${label}.function_end_line`);
    if(record.function_end_line<record.function_line)throw new Error(`${label}.function_end_line precedes function_line`);
    exactFields(record.sink,DATAFLOW_SINK_FIELDS,`${label}.sink`);
    nonempty(record.sink.expression,`${label}.sink.expression`);
    if(!DATAFLOW_SINK_CLASSES.includes(record.sink.class))throw new Error(`${label}.sink.class must be one of ${DATAFLOW_SINK_CLASSES.join(', ')}`);
    if(!Array.isArray(record.sink.idioms)||!record.sink.idioms.length)throw new Error(`${label}.sink.idioms must name the idiom(s) that recognised this sink`);
    if(!Array.isArray(record.sites)||!record.sites.length)throw new Error(`${label}.sites must carry at least one write site; a sink with no site is not a flow`);
    record.sites.forEach((site,index)=>{
      const at=`${label}.sites[${index}]`;
      exactFields(site,DATAFLOW_SITE_FIELDS,at);
      positiveInt(site.line,`${at}.line`);
      nonempty(site.idiom,`${at}.idiom`);
      if(typeof site.via_nested_closure!=='boolean')throw new Error(`${at}.via_nested_closure must be a boolean`);
      if(!Array.isArray(site.resolution))throw new Error(`${at}.resolution must be an array; a DIRECT site carries the empty array and an INDIRECT one carries every hop`);
      site.resolution.forEach((hop,hopIndex)=>{
        const hopAt=`${at}.resolution[${hopIndex}]`;
        exactFields(hop,DATAFLOW_RESOLUTION_FIELDS,hopAt);
        nonempty(hop.callee,`${hopAt}.callee`);
        positiveInt(hop.call_line,`${hopAt}.call_line`);
        positiveInt(hop.declared_line,`${hopAt}.declared_line`);
        positiveInt(hop.hop,`${hopAt}.hop`);
      });
    });
    if(!Array.isArray(record.guards))throw new Error(`${label}.guards must be an array; an UNGUARDED sink carries the empty array and says so`);
    record.guards.forEach((guard,index)=>{
      const at=`${label}.guards[${index}]`;
      exactFields(guard,DATAFLOW_GUARD_FIELDS,at);
      nonempty(guard.condition,`${at}.condition`);
      positiveInt(guard.line,`${at}.line`);
      if(!DATAFLOW_GUARD_FAMILIES.includes(guard.family))throw new Error(`${at}.family must be one of ${DATAFLOW_GUARD_FAMILIES.join(', ')}`);
      if(!DATAFLOW_GUARD_KINDS.includes(guard.kind))throw new Error(`${at}.kind must be one of ${DATAFLOW_GUARD_KINDS.join(', ')}`);
      if(!DATAFLOW_GUARD_POLARITIES.includes(guard.polarity))throw new Error(`${at}.polarity must be one of ${DATAFLOW_GUARD_POLARITIES.join(', ')}`);
      if(guard.family==='early_exit'&&guard.polarity!=='skips_when')throw new Error(`${at}: an early-exit guard SKIPS the write, so its polarity must be 'skips_when'`);
      if(!Array.isArray(guard.dominates_sites)||!guard.dominates_sites.length)throw new Error(`${at}.dominates_sites must name at least one site line this guard dominates; a guard dominating no site is not a guard of this flow`);
      const siteLines=new Set(record.sites.map(site=>site.line));
      for(const line of guard.dominates_sites){positiveInt(line,`${at}.dominates_sites`);if(!siteLines.has(line))throw new Error(`${at}.dominates_sites names line ${line}, which is not a write site of this sink`);}
    });
    if(!Array.isArray(record.sources))throw new Error(`${label}.sources must be an array`);
    record.sources.forEach((source,index)=>{
      const at=`${label}.sources[${index}]`;
      exactFields(source,DATAFLOW_SOURCE_FIELDS,at);
      nonempty(source.name,`${at}.name`);
      positiveInt(source.line,`${at}.line`);
      if(!DATAFLOW_SOURCE_ORIGINS.includes(source.origin))throw new Error(`${at}.origin must be one of ${DATAFLOW_SOURCE_ORIGINS.join(', ')}`);
    });
    if(!Array.isArray(record.chain_steps))throw new Error(`${label}.chain_steps must be an array`);
    record.chain_steps.forEach((step,index)=>{const at=`${label}.chain_steps[${index}]`;exactFields(step,DATAFLOW_CHAIN_STEP_FIELDS,at);nonempty(step.step,`${at}.step`);positiveInt(step.line,`${at}.line`);});
  }else if(record.record_kind==='flow_refusal'){
    for(const f of ['file','unresolvable','detail'])nonempty(record[f],`${label}.${f}`);
    positiveInt(record.line,`${label}.line`);
    if(typeof record.repo!=='string')throw new Error(`${label}.repo must be a string`);
    if(!DATAFLOW_REFUSAL_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${DATAFLOW_REFUSAL_REASONS.join(', ')}`);
  }else if(record.record_kind==='flow_claim'){
    for(const f of ['model','claim_sentence','skeleton_id','skeleton_digest'])nonempty(record[f],`${label}.${f}`);
    if(!record.skeleton_id.startsWith(DATAFLOW_ID_PREFIX))throw new Error(`${label}.skeleton_id must be a flow-skeleton id`);
    if('confidence' in record&&(typeof record.confidence!=='number'||!Number.isFinite(record.confidence)||record.confidence<0||record.confidence>1))throw new Error(`${label}.confidence must be between 0 and 1`);
    if(!Array.isArray(record.assertions)||!record.assertions.length)throw new Error(`${label}.assertions must carry at least one typed assertion: a claim SENTENCE with no assertions is ungated prose, which is the mechanism that produced a 43.6% over-claim rate in the interpretation layer`);
    record.assertions.forEach((assertion,index)=>{
      const at=`${label}.assertions[${index}]`;
      exactFields(assertion,DATAFLOW_ASSERTION_FIELDS,at);
      if(!DATAFLOW_ASSERTION_TYPES.includes(assertion.type))throw new Error(`${at}.type must be one of ${DATAFLOW_ASSERTION_TYPES.join(', ')}`);
      nonempty(assertion.subject,`${at}.subject`);
      if(assertion.type==='writes_unconditionally'){
        if(assertion.guard_line!==null)throw new Error(`${at}.guard_line must be null: writes_unconditionally asserts that NO guard exists`);
        if(assertion.quoted_condition!=='')throw new Error(`${at}.quoted_condition must be the empty string for writes_unconditionally`);
        return;
      }
      positiveInt(assertion.guard_line,`${at}.guard_line`);
      if(assertion.type==='writes_at'||assertion.type==='accumulates_from')return;
      nonempty(assertion.quoted_condition,`${at}.quoted_condition`);
    });
  }else{
    for(const f of ['model','detail','skeleton_id','skeleton_digest'])nonempty(record[f],`${label}.${f}`);
    if(!DATAFLOW_CLAIM_REFUSAL_REASONS.includes(record.reason))throw new Error(`${label}.reason must be one of ${DATAFLOW_CLAIM_REFUSAL_REASONS.join(', ')}`);
  }
  return record;
}
export async function readDomainPrepassReceipts(file){return readJsonl(file,validateDomainPrepassReceipt,'domain_prepass');}
export async function readEntityLayer(file){return readJsonl(file,validateEntityLayerRecord,'entity_layer');}
export async function readInterpretationLayer(file){return readJsonl(file,validateInterpretationRecord,'interpretation');}
export async function readDataflowLayer(file){return readJsonl(file,validateDataflowRecord,'dataflow');}
export const ADJUDICATION_RECORDS_FILE_SUFFIX='.adjudication-records.jsonl';
export async function readAdjudicationRecords(file){return readJsonl(file,validateRecord,'adjudication');}
async function readJsonl(file,validate,what){
  const records=[];let lineNumber=0;
  for(const line of (await fs.readFile(file,'utf8')).split(/\r?\n/)){lineNumber++;if(!line.trim())continue;let record;try{record=JSON.parse(line);}catch(error){throw new Error(`${file}:${lineNumber}: invalid JSON: ${error.message}`);}records.push(validate(record,`${file}:${lineNumber}`));}
  if(what==='refusal'){const seen=new Set();for(const record of records){if(seen.has(record.id))throw new Error(`${file}: duplicate refusal id ${record.id}`);seen.add(record.id);}}
  return records;
}
export async function readOverlay(file){return readJsonl(file,validateAnnotation,'annotation');}
export async function readRefusalLedger(file){return readJsonl(file,validateRefusal,'refusal');}
export async function readStructuralUnclassifiedLedger(file){return readJsonl(file,validateStructuralUnclassified,'structural_unclassified');}
const annotationKey=record=>[record.annotation_kind,record.subject,record.model,record.generated_at,factKey({kind:record.kind,repo:record.grounded_in[0].repo,file:record.grounded_in[0].file,line:record.grounded_in[0].line}),stableStringify(record)].join('\0');
// ---------------------------------------------------------------------------
// MISROUTED-FILE DIAGNOSIS (instrument defect J4, acceptance-test-round2.md §5.1).
//
// `mergeAnnotations` routes ONLY by filename suffix. A file of perfectly valid
// entity-layer records named `layer.jsonl` instead of `layer.entity-layer.jsonl`
// is therefore read as an overlay and rejected by `validateAnnotation` with
// `has unknown field(s): corroboration, entity, instance_table, …` — an error
// that names the symptom and not one word of the cause or the fix. The round-2
// map arm lost minutes to exactly this. The records carry their own `schema`,
// so the cause is derivable: read it and say WHY the file was rejected and what
// name it must have.
export const RECORD_FAMILY_BY_SCHEMA=Object.freeze({
  [ENTITY_LAYER_SCHEMA]:{suffix:ENTITY_LAYER_FILE_SUFFIX,array:'graph.entity_layer',producer:'entity-layer.mjs'},
  [REFUSAL_SCHEMA]:{suffix:REFUSAL_FILE_SUFFIX,array:'graph.refusals',producer:'domain-derivation.mjs'},
  [STRUCTURAL_UNCLASSIFIED_SCHEMA]:{suffix:STRUCTURAL_UNCLASSIFIED_FILE_SUFFIX,array:'graph.structural_unclassified',producer:'structural-grouping.mjs'},
  [INTERPRETATION_LAYER_SCHEMA]:{suffix:INTERPRETATION_LAYER_FILE_SUFFIX,array:'graph.interpretation_layer',producer:'interpretation-layer.mjs'},
  [DATAFLOW_LAYER_SCHEMA]:{suffix:DATAFLOW_LAYER_FILE_SUFFIX,array:'graph.dataflow_layer',producer:'dataflow-layer.mjs'},
  [DOMAIN_PREPASS_SCHEMA]:{suffix:DOMAIN_PREPASS_FILE_SUFFIX,array:'graph.domain_prepass_receipts',producer:'domain-prepass.mjs'},
  [ADJUDICATION_SCHEMA_VERSION]:{suffix:ADJUDICATION_RECORDS_FILE_SUFFIX,array:'graph.adjudication_records',producer:'l1-adjudicate.mjs'},
});
/** The record family a misrouted overlay file really holds, or null if it is not one. */
export async function diagnoseMisroutedOverlay(file){
  let text;
  try{text=await fs.readFile(file,'utf8');}catch{return null;}
  for(const line of text.split(/\r?\n/)){
    if(!line.trim())continue;
    let record;try{record=JSON.parse(line);}catch{return null;}
    const schema=record?.schema || record?.schema_version;
    const family=record&&typeof record==='object'?RECORD_FAMILY_BY_SCHEMA[schema]:null;
    return family?{...family,schema}:null;
  }
  return null;
}
async function readOverlayFile(file){
  try{return await readOverlay(file);}
  catch(error){
    const family=await diagnoseMisroutedOverlay(file);
    if(!family)throw error;
    const base=path.basename(file);
    const suggested=`${base.replace(/\.jsonl$/,'')}${family.suffix}`;
    throw new Error(`${base} was read as an ANNOTATION OVERLAY and rejected, because merge routes by FILENAME SUFFIX only and this name matches no record-family suffix.\n  Its records declare schema '${family.schema}', which belongs in ${family.array} and is routed by the suffix '${family.suffix}'.\n  Fix: rename the file to '${suggested}' (its producer, ${family.producer}, writes that name when given an output path ending in '${family.suffix}').\n  Underlying validation error: ${error.message}`);
  }
}
export async function mergeAnnotations(graphDir,overlaysDir){
  const graphFile=path.join(graphDir,'estate-graph.json');
  const graph=JSON.parse(await fs.readFile(graphFile,'utf8'));
  const files=(await fs.readdir(overlaysDir,{withFileTypes:true})).filter(entry=>entry.isFile()&&entry.name.endsWith('.jsonl')).map(entry=>entry.name).sort();
  const isRefusal=name=>name.endsWith(REFUSAL_FILE_SUFFIX),isUnclassified=name=>name.endsWith(STRUCTURAL_UNCLASSIFIED_FILE_SUFFIX),isEntityLayer=name=>name.endsWith(ENTITY_LAYER_FILE_SUFFIX),isInterpretation=name=>name.endsWith(INTERPRETATION_LAYER_FILE_SUFFIX),isDataflow=name=>name.endsWith(DATAFLOW_LAYER_FILE_SUFFIX),isDomainPrepass=name=>name.endsWith(DOMAIN_PREPASS_FILE_SUFFIX),isAdjudication=name=>name.endsWith(ADJUDICATION_RECORDS_FILE_SUFFIX);
  const overlays=[];for(const file of files.filter(name=>!isRefusal(name)&&!isUnclassified(name)&&!isEntityLayer(name)&&!isInterpretation(name)&&!isDataflow(name)&&!isDomainPrepass(name)&&!isAdjudication(name)))overlays.push(...await readOverlayFile(path.join(overlaysDir,file)));
  overlays.sort((a,b)=>annotationKey(a).localeCompare(annotationKey(b)));
  // Refusals travel in the SAME merged artifact as overlays, under their own key, so a
  // consumer reads one file and a refusal survives regeneration exactly as an overlay does.
  const refusals=[];for(const file of files.filter(isRefusal))refusals.push(...await readRefusalLedger(path.join(overlaysDir,file)));
  refusals.sort((a,b)=>a.id.localeCompare(b.id));
  const structuralUnclassified=[];for(const file of files.filter(isUnclassified))structuralUnclassified.push(...await readStructuralUnclassifiedLedger(path.join(overlaysDir,file)));
  structuralUnclassified.sort((a,b)=>a.id.localeCompare(b.id));
  const entityLayer=[];for(const file of files.filter(isEntityLayer))entityLayer.push(...await readEntityLayer(path.join(overlaysDir,file)));
  entityLayer.sort((a,b)=>`${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  // The interpretation layer rides in the SAME merged artifact under its own key, so a reader
  // gets model inferences and extracted facts from one file while never confusing the two.
  const interpretationLayer=[];for(const file of files.filter(isInterpretation))interpretationLayer.push(...await readInterpretationLayer(path.join(overlaysDir,file)));
  interpretationLayer.sort((a,b)=>`${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  // The dataflow layer rides in the SAME merged artifact under its own key. It mints no node and
  // carries no `body.domain`, so no diagnostic queue can move because it was merged.
  const dataflowLayer=[];for(const file of files.filter(isDataflow))dataflowLayer.push(...await readDataflowLayer(path.join(overlaysDir,file)));
  dataflowLayer.sort((a,b)=>`${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  const domainPrepassReceipts=[];for(const file of files.filter(isDomainPrepass))domainPrepassReceipts.push(...await readDomainPrepassReceipts(path.join(overlaysDir,file)));
  domainPrepassReceipts.sort((a,b)=>a.subject.localeCompare(b.subject));
  const adjudicationRecords=[];for(const file of files.filter(isAdjudication))adjudicationRecords.push(...await readAdjudicationRecords(path.join(overlaysDir,file)));
  adjudicationRecords.sort((a,b)=>`${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  const merged={...graph,overlays,refusals,structural_unclassified:structuralUnclassified,entity_layer:entityLayer,interpretation_layer:interpretationLayer,dataflow_layer:dataflowLayer,domain_prepass_receipts:domainPrepassReceipts,adjudication_records:adjudicationRecords};
  // Overlay/derivation changes can change visible domain/structure labels. Re-emit the
  // whole contract atomically with this merged graph; no view gets to fill it in later.
  const annotated={...merged,presentation_records:buildPresentationRecords(merged)};
  const out=path.join(graphDir,'estate-graph.annotated.json');
  await fs.writeFile(out,stableStringify(annotated));
  return {out,count:overlays.length,refusals:refusals.length,structural_unclassified:structuralUnclassified.length,entity_layer:entityLayer.length,interpretation_layer:interpretationLayer.length,dataflow_layer:dataflowLayer.length,domain_prepass_receipts:domainPrepassReceipts.length,adjudication_records:adjudicationRecords.length};
}
if(import.meta.url===`file://${process.argv[1]}`){
  const {positional,options}=parseArgs(process.argv.slice(2));
  if(options.help||!positional[0]){console.log(HELP);process.exit(options.help?0:1);}
  try{
    if(positional[0]==='validate'){if(!positional[1])throw new Error('validate requires <overlay.jsonl>');const records=await readOverlay(path.resolve(positional[1]));console.log(`Valid: ${records.length} annotation(s)`);}
    else if(positional[0]==='validate-refusals'){if(!positional[1])throw new Error('validate-refusals requires <ledger.refusals.jsonl>');const records=await readRefusalLedger(path.resolve(positional[1]));console.log(`Valid: ${records.length} refusal record(s)`);}
    else if(positional[0]==='validate-unclassified'){if(!positional[1])throw new Error('validate-unclassified requires <ledger.structural-unclassified.jsonl>');const records=await readStructuralUnclassifiedLedger(path.resolve(positional[1]));console.log(`Valid: ${records.length} structural-unclassified record(s)`);}
    else if(positional[0]==='validate-entity-layer'){if(!positional[1])throw new Error('validate-entity-layer requires <layer.entity-layer.jsonl>');const records=await readEntityLayer(path.resolve(positional[1]));console.log(`Valid: ${records.length} entity-layer record(s)`);}
    else if(positional[0]==='validate-interpretation-layer'){if(!positional[1])throw new Error('validate-interpretation-layer requires <layer.interpretation-layer.jsonl>');const records=await readInterpretationLayer(path.resolve(positional[1]));console.log(`Valid: ${records.length} interpretation-layer record(s)`);}
    else if(positional[0]==='validate-dataflow-layer'){if(!positional[1])throw new Error('validate-dataflow-layer requires <layer.dataflow-layer.jsonl>');const records=await readDataflowLayer(path.resolve(positional[1]));console.log(`Valid: ${records.length} dataflow-layer record(s)`);}
    else if(positional[0]==='validate-graph-witnesses'){
      if(!positional[1])throw new Error('validate-graph-witnesses requires <estate-graph.json>');
      const graph=JSON.parse(await fs.readFile(path.resolve(positional[1]),'utf8'));
      const kinds=options.kinds?String(options.kinds).split(',').map(value=>value.trim()).filter(Boolean):null;
      const census=validateGraphWitnesses(graph,{kinds});
      console.log(`Valid: ${census.checked} connecting edge(s) carry a file:line witness (${census.skipped} non-connecting edge(s) skipped)`);
      for(const [kind,count] of Object.entries(census.by_kind))console.log(`  ${String(count).padStart(8)}  ${kind}`);
    }
    else if(positional[0]==='merge'){if(!positional[1]||!positional[2])throw new Error('merge requires <graph-dir> <overlays-dir>');const result=await mergeAnnotations(path.resolve(positional[1]),path.resolve(positional[2]));console.log(`Wrote ${result.count} annotation(s), ${result.refusals} refusal record(s), ${result.structural_unclassified} structural-unclassified record(s), ${result.entity_layer} entity-layer record(s) and ${result.interpretation_layer} interpretation-layer record(s) to ${result.out}`);}
    else throw new Error(`Unknown command: ${positional[0]}`);
  }catch(error){console.error(error.message);process.exit(1);}
}
