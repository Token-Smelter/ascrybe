#!/usr/bin/env node
/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
import { DATAFLOW_REFUSAL_REASONS, INTERPRETATION_REFUSAL_REASONS, REFUSAL_REASONS } from './annotate.mjs';
import { SEMANTIC_REFUSAL_REASONS } from './semantic-layer.mjs';

/**
 * The seven ROUTING states. These are not evidence verdicts (entailed / refuted /
 * inconsistent / underdetermined); they answer "what happens to this question next", which
 * is the thing a reader needs and the thing the old rendering destroyed.
 */
export const REFUSAL_ACTION_STATES = Object.freeze([
  'closed_world_absent',   // a named finite universe was exhausted for an exact predicate
  'derivation_failed',     // this rule / parser / reader could not derive the proposition
  'not_examined',          // the deciding evidence lies outside what was actually executed
  'out_of_scope',          // the mapper does not model the evidence class this needs
  'no_known_decider',      // no registered evidence action can settle it today
  'open_obligation',       // an admissible next action exists NOW
  'deferred_obligation',   // an admissible action exists but is postponed by a declared bound
]);

/** The ONLY state a reader may read as settled. Everything else carries a route. */
export const TERMINAL_ACTION_STATES = Object.freeze(['closed_world_absent']);

export const REFUSAL_FAMILIES = Object.freeze(['domain', 'dataflow', 'interpretation', 'semantic']);

/** The frozen code set per family, taken from the producers rather than re-typed here. */
export const FROZEN_VOCABULARIES = Object.freeze({
  domain: REFUSAL_REASONS,
  dataflow: DATAFLOW_REFUSAL_REASONS,
  interpretation: INTERPRETATION_REFUSAL_REASONS,
  semantic: SEMANTIC_REFUSAL_REASONS,
});

export const isTerminalState = state => TERMINAL_ACTION_STATES.includes(state);

// ---------------------------------------------------------------------------
// The table. One row per frozen code.
//
//   state          — the routing state that holds TODAY, with today's registered actions.
//   evidence_set   — what was actually examined. Printed after "did not establish this from",
//                    so it must name a universe, never restate the failure.
//   next_check     — the supported thing a reader does next. Never "open the source" alone.
//   closed_predicate / closed_universe — REQUIRED on `closed_world_absent` rows: the exact
//                    predicate exhausted and the exact universe it was exhausted over.
//   broader_claim  — REQUIRED on `closed_world_absent` rows: the question a reader will
//                    actually ask, which the narrow closure does NOT answer, and its state.
//   escalates_to   — the state this becomes once the named action is registered. Documented
//                    so a future action registration is a table edit, not a re-derivation.
// ---------------------------------------------------------------------------

const DOMAIN_ROUTING = {
  // Narrow closure survives: the scanned manifest set IS a finite universe and the predicate
  // "a plugin.yaml literally declares kind K" IS exhaustively decidable over it.
  no_manifest_publisher: {
    state: 'closed_world_absent',
    closed_predicate: 'some scanned plugin.yaml literally declares this envelope kind under publishes_envelope',
    closed_universe: 'the plugin.yaml manifest set the scanner admitted at this snapshot',
    broader_claim: {
      claim: 'no publisher or runtime binding for this kind exists anywhere in the estate',
      state: 'derivation_failed',
      next_check: 'the extracted emit sites on the kind node — `estate://subject/{subject}` — which are counted independently of any manifest declaration',
    },
    evidence_set: 'plugin.yaml publishes_envelope declarations in the scanned manifest set',
    next_check: '`estate://subject/{subject}` for emit/consume site counts, then `estate://wiring` for declared-vs-wired status',
  },
  declaring_plugin_has_no_documented_domain: {
    state: 'closed_world_absent',
    closed_predicate: 'the canon bounded-context table contains a row for the declaring plugin',
    closed_universe: 'the canon bounded-context rows at this canon snapshot',
    broader_claim: {
      claim: 'the declaring plugin belongs to no bounded context',
      state: 'open_obligation',
      next_check: 'canon remediation — add the plugin row to the bounded-context table, then re-derive',
    },
    evidence_set: 'the canon bounded-context row census at this snapshot',
    next_check: '`estate://domains` for the documented contexts, then the canon table that would need the missing row',
  },
  // OFFENDER 1/8. Mixed positive evidence is not absence; it is an incomplete canon.
  publisher_set_mixes_documented_and_undocumented_plugins: {
    state: 'open_obligation',
    evidence_set: 'the declaring plugin set joined against the canon bounded-context rows',
    next_check: 'complete the canon rows for the undocumented declarers, or declare an explicit mixed-domain policy, then re-derive',
  },
  // OFFENDER 2/8. A conflict holds TWO positive witnesses; discarding either is data loss.
  publisher_domain_conflict: {
    state: 'open_obligation',
    evidence_set: 'the documented domains of every plugin declaring this kind',
    next_check: 'adjudicate the conflicting canon rows (or split the kind); both witnesses are preserved at `estate://refusals/publisher_domain_conflict`',
  },
  no_documented_import_neighbour: {
    state: 'derivation_failed',
    escalates_to: { state: 'open_obligation', when: 'a resolver, static-query or runtime evidence action is registered for this subject' },
    evidence_set: 'the one-hop import neighbourhood carried by this graph',
    next_check: '`estate://subject/{subject}` for the real import edges, then a wider-hop or runtime action once one is registered',
  },
  single_documented_import_neighbour_below_threshold: {
    state: 'derivation_failed',
    escalates_to: { state: 'open_obligation', when: 'an another-neighbour check is registered' },
    evidence_set: 'the one-hop import neighbourhood and the rule threshold it failed to clear',
    next_check: 'the single documented neighbour at `estate://subject/{subject}` — the rule declined to propagate from one witness, it did not find none',
  },
  // OFFENDER 3/8. Same shape as publisher_domain_conflict, one rule down.
  import_neighbourhood_domain_conflict: {
    state: 'open_obligation',
    evidence_set: 'the documented domains of every import neighbour of this node',
    next_check: 'adjudicate which context owns this module, or record a deliberate boundary crossing; every witnessed edge is preserved',
  },
  no_applicable_rule_for_node_kind: {
    // `out_of_scope` names WHY nothing decided it; `no_known_decider` names the routing
    // consequence today. The routing state is the operative one for a reader.
    state: 'no_known_decider',
    escalates_to: { state: 'open_obligation', when: 'a candidate rule AND an independent verifier are registered for this node kind' },
    evidence_set: 'the rule set this derivation ran — no rule addresses this node kind at all',
    next_check: 'this is a gap in the INSTRUMENT, not the corpus; `estate://refusals/no_applicable_rule_for_node_kind` groups every node kind still unaddressed',
  },
};

const DATAFLOW_ROUTING = {
  callee_is_member_expression: {
    state: 'out_of_scope',
    evidence_set: 'syntactic callee resolution inside the executed module',
    next_check: 'receiver resolution needs points-to / dataflow analysis this extractor does not model — read the call site named in the record',
  },
  callee_declared_outside_module: {
    state: 'not_examined',
    evidence_set: 'the declarations inside the executed module only',
    next_check: 'the declaring module named in the record — it was never opened by this pass',
  },
  callee_name_ambiguous_in_module: {
    state: 'derivation_failed',
    escalates_to: { state: 'open_obligation', when: 'a disambiguating resolver is registered' },
    evidence_set: 'every declaration binding this name inside the executed module',
    next_check: 'the competing declarations named in the record — more than one binds the name, so the extractor refused to pick',
  },
  callee_is_imported_binding: {
    state: 'not_examined',
    evidence_set: 'the executed module only; the imported body lives elsewhere',
    next_check: 'the imported module named in the record',
  },
  resolution_depth_exceeded: {
    state: 'deferred_obligation',
    evidence_set: 'the traversal executed within the declared two-hop bound',
    next_check: 'a deeper traversal is KNOWN and excluded by a declared bound, not unavailable — raise the bound and re-run',
  },
  sink_target_unresolvable_cross_module: {
    state: 'not_examined',
    evidence_set: 'the statement/table/column definitions visible in the executed module',
    next_check: 'the defining module named in the record',
  },
  source_unresolvable_in_scope: {
    state: 'not_examined',
    evidence_set: 'the bindings visible in the executed function scope',
    next_check: 'the enclosing scope that binds the guard source',
  },
  dynamic_sink_expression: {
    state: 'out_of_scope',
    escalates_to: { state: 'open_obligation', when: 'a runtime trace action is registered' },
    evidence_set: 'static syntax at the sink site',
    next_check: 'the sink is computed at runtime; only a trace decides it',
  },
  parse_failed: {
    state: 'derivation_failed',
    evidence_set: 'nothing — the parser did not produce a tree for this file',
    next_check: 'a parser failure is not evidence about the proposition; repair the parser or run another one over the file named in the record',
  },
};

// All six say the same thing: THIS READER declined to mint a concept from THIS slice. None
// is a negative fact about the estate, so all six route the same way.
const INTERPRETATION_NEXT_CHECK = {
  members_share_no_relation_beyond_enumeration: 'the enumerator spec that produced the slice — a different slicing may hold a real concept',
  slice_is_a_kind_bucket_not_a_thing: 'the members themselves at `estate://subject/{subject}`; a type bucket is not evidence that no concept spans them',
  members_span_unrelated_concerns: 'the coherent sub-parts named in the record — each may carry its own concept',
  slice_too_small_to_constitute_a_thing: 'the members directly; the slice was below the size the reader will name, not empty',
  name_would_restate_the_enumerator: 'the enumerator spec — the reader refused a tautological name, not the concept',
  coherence_only_via_test_fixtures: 'the non-test members; shared test scaffolding was the only structure this reader could see',
};

const INTERPRETATION_ROUTING = Object.fromEntries(INTERPRETATION_REFUSAL_REASONS.map(reason => [reason, {
  state: 'derivation_failed',
  escalates_to: { state: 'open_obligation', when: 'a new shape-evidence recipe is registered for this slice' },
  evidence_set: 'the slice members and the shape evidence re-derivable from this graph',
  next_check: INTERPRETATION_NEXT_CHECK[reason],
}]));

const SEMANTIC_ROUTING = {
  prose_absent: {
    state: 'closed_world_absent',
    closed_predicate: 'this exact adjudication packet contains prose qualifying for this claim class',
    closed_universe: 'the text spans inside this one packet',
    broader_claim: {
      claim: 'no architectural rule of this class exists',
      state: 'derivation_failed',
      next_check: 'the source and canon outside this packet — the packet trigger over-fired, which says nothing about the estate',
    },
    evidence_set: 'the text spans inside this one adjudication packet',
    next_check: 'the requested_artifact named on the refusal record, then re-adjudicate with a packet that contains it',
  },
  // OFFENDERS 4-8/8. Every one of these was operationally terminal: the L1 path appends a
  // refusal and exposes no child-work pointer. Each now carries a route.
  prose_ambiguous: {
    state: 'derivation_failed',
    evidence_set: 'the quoted prose span in this packet',
    next_check: 'the requested_artifact on the record — the prose gestures at the class but names no field, value or counter, so another evidence type or a human rubric decides it',
  },
  prose_states_no_rule: {
    state: 'derivation_failed',
    evidence_set: 'the quoted prose span in this packet',
    next_check: 'the requested_artifact on the record — behavioural prose stated no present obligation; the obligation may still be stated in source or canon',
  },
  subject_underivable: {
    state: 'derivation_failed',
    escalates_to: { state: 'open_obligation', when: 'a subject-binding action is registered' },
    evidence_set: 'the quoted prose span and the subjects derivable from it',
    next_check: 'the rule IS stated; only its subject binding is missing — resolve the field/entity it binds, then re-adjudicate',
  },
  code_site_underivable: {
    state: 'derivation_failed',
    escalates_to: { state: 'open_obligation', when: 'a code-site resolver is registered' },
    evidence_set: 'the quoted prose span and the code sites derivable from it',
    next_check: 'the rule IS stated; only a constrained code site is missing — resolve the site, then re-adjudicate',
  },
  prose_stale_vs_source: {
    state: 'open_obligation',
    evidence_set: 'the quoted prose span and the source at this SHA, which contradict each other',
    next_check: 'BOTH witnesses are real and preserved — repair the documentation or the estate; SOURCE WINS on the factual question',
  },
};

/** family -> code -> row. Frozen so a consumer cannot mutate the routing at read time. */
export const REFUSAL_ROUTING = Object.freeze({
  domain: Object.freeze(DOMAIN_ROUTING),
  dataflow: Object.freeze(DATAFLOW_ROUTING),
  interpretation: Object.freeze(INTERPRETATION_ROUTING),
  semantic: Object.freeze(SEMANTIC_ROUTING),
});

/**
 * The eight codes that rendered as terminal WITHOUT WARRANT before this adapter, named so a
 * regression test can assert each one now routes non-terminally. Derived from
 * external-round3-triage.md §4.2 "Existing terminal-rendering audit": three domain
 * conflict/mixed codes explicitly labelled TERMINAL, plus the five semantic reasons other
 * than narrowly scoped `prose_absent`, which the shipped L1 path closes operationally by
 * appending a refusal with no child-work pointer.
 */
export const PREVIOUSLY_TERMINAL_WITHOUT_WARRANT = Object.freeze([
  { family: 'domain', reason: 'publisher_set_mixes_documented_and_undocumented_plugins' },
  { family: 'domain', reason: 'publisher_domain_conflict' },
  { family: 'domain', reason: 'import_neighbourhood_domain_conflict' },
  { family: 'semantic', reason: 'prose_ambiguous' },
  { family: 'semantic', reason: 'prose_states_no_rule' },
  { family: 'semantic', reason: 'subject_underivable' },
  { family: 'semantic', reason: 'code_site_underivable' },
  { family: 'semantic', reason: 'prose_stale_vs_source' },
]);

/**
 * `no_applicable_rule_for_node_kind` records carry the node kind in `reason_detail` and the
 * census keys them as `reason:detail`. Strip the detail before table lookup; keep it for the
 * rendered line so the reader sees WHICH kind has no rule.
 */
const splitReason = reason => {
  const text = String(reason ?? '');
  const separator = text.indexOf(':');
  return separator === -1 ? { code: text, detail: '' } : { code: text.slice(0, separator), detail: text.slice(separator + 1) };
};

/**
 * Route one refusal code to its seven-state record.
 *
 * `predicate` selects WHICH question is being asked of a closed-world row:
 *   'narrow' (default) — the exact predicate the universe was exhausted for. Terminal.
 *   'broad'            — the question a reader actually has. NEVER terminal.
 * Non-closed-world rows ignore it: they were never terminal under any predicate.
 *
 * Returns `null` for a code outside the frozen vocabularies rather than inventing a state —
 * a caller that gets `null` must render the code itself, not a guess.
 */
export function routeRefusal({ family, reason, predicate = 'narrow' } = {}) {
  const table = REFUSAL_ROUTING[family];
  if (!table) return null;
  const { code, detail } = splitReason(reason);
  const row = table[code];
  if (!row) return null;
  const broadened = predicate === 'broad' && row.broader_claim;
  return {
    family,
    reason: code,
    reason_detail: detail,
    predicate,
    state: broadened ? row.broader_claim.state : row.state,
    terminal: broadened ? false : isTerminalState(row.state),
    evidence_set: row.evidence_set,
    next_check: broadened ? row.broader_claim.next_check : row.next_check,
    closed_predicate: row.closed_predicate ?? null,
    closed_universe: row.closed_universe ?? null,
    broader_claim: row.broader_claim ?? null,
    escalates_to: row.escalates_to ?? null,
  };
}

/** True only for a code whose narrow predicate is genuinely closed-world. */
export const isTerminalRefusal = ({ family, reason } = {}) => routeRefusal({ family, reason })?.terminal === true;

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export function renderRefusal({ family, reason, subject } = {}) {
  const routed = routeRefusal({ family, reason });
  const what = subject ? `\`${subject}\`` : 'this subject';
  if (!routed) return `OPEN (unrouted) — \`${reason}\` is outside the four frozen refusal vocabularies; read the refusal record for what was sought and examined.`;
  const detail = routed.reason_detail ? ` (${routed.reason_detail})` : '';
  if (routed.terminal) {
    return `CLOSED (${routed.state}) — exhaustive search over ${routed.closed_universe} for: ${routed.closed_predicate}${detail}. `
      + `That closure holds INSIDE that universe only. The broader claim "${routed.broader_claim.claim}" remains ${routed.broader_claim.state} `
      + `for ${what} — next supported check: ${routed.broader_claim.next_check}.`;
  }
  return `OPEN (${routed.state}) — the map did not establish ${what}${detail} from ${routed.evidence_set}; next supported check: ${routed.next_check}.`;
}

/**
 * Roll a census's `by_reason` rows up by routing state, so a reader sees "how much of this
 * map is still open" instead of a flat list of codes that all look like absences.
 * `rows` is the shape `query.mjs#refusalCensus` already returns.
 */
export function routingSummary(rows, family = 'domain') {
  const counts = new Map(REFUSAL_ACTION_STATES.map(state => [state, 0]));
  let unrouted = 0;
  for (const row of rows ?? []) {
    const routed = routeRefusal({ family, reason: row.reason });
    if (!routed) { unrouted += row.count ?? 0; continue; }
    counts.set(routed.state, (counts.get(routed.state) ?? 0) + (row.count ?? 0));
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0) + unrouted;
  const terminal = counts.get('closed_world_absent') ?? 0;
  return {
    by_state: REFUSAL_ACTION_STATES.map(state => ({ state, count: counts.get(state) ?? 0, terminal: isTerminalState(state) })),
    unrouted,
    total,
    terminal,
    open: total - terminal,
  };
}
