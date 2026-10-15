#!/usr/bin/env node
// Ascrybe REPAIR-LOOP DRIVER.
//
// Makes "iterate until converged" (DESIGN.md §3) a single command instead of a wizard
// hand-driving each round: GENERATE → DIAGNOSE → ROUTE → STOPPING RULE → PERSIST → REPORT.
//
// HONEST SCOPE — THE DRIVER MEASURES, ROUTES AND STOPS; IT DOES NOT ACT. The loop's two
// action arms are REPAIR (change extractor code — construction work for a dispatched task)
// and ADJUDICATE (L1 — specified in l1-adjudication-spec.md, not implemented). The driver
// therefore does everything AROUND the actions and reports adjudicable entries as
// ready-for-L1 rather than acting on them. It never invents an edge, never drains a queue,
// and never writes into the graph.
//
// SAFETY / DETERMINISM.
//   * No model calls anywhere. Every number is a function of bytes on disk.
//   * The driver ORCHESTRATES the shipped tools by importing their exported entry points
//     (extractEstate, mergeFacts, discoverEntities, produceDddOverlays,
//     produceDomainDerivation, mergeAnnotations) — it reimplements none of them.
//   * The driver writes ONLY under its own state directory and its own work directory.
//     Domain assignments (derived.jsonl) and refusal records (*.refusals.jsonl) are written
//     by domain-derivation.mjs and are never touched afterwards; the driver records their
//     sha256 so the no-mutation claim is checkable rather than asserted.
//   * The default state/work root is OUTSIDE the scanned estate (readonly-guard.mjs
//     #defaultOutputRoot). It used to be `<estate-root>/.estate-map/loop`, justified by
//     `.estate-map` being in lib.mjs#DEFAULT_EXCLUDED_DIRS so the driver's own output
//     could not perturb the next iteration's corpus. That reasoning was sound about
//     CORPUS CONTAMINATION and silent about the larger problem: it made the driver WRITE
//     INTO A TREE IT DOES NOT OWN. Pointed at a foreign estate it created directories in
//     somebody else's repository. Exclusion from the scan is not permission to write.
//     The default is now per-estate and outside the estate; it is still stable across
//     iterations, which the refusal state machine's first_observed_at depends on.

import fs from './readonly-guard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { extractEstate } from './extract.mjs';
import { mergeFacts } from './merge.mjs';
import { loadSymbolIndex } from './analyze-connectivity.mjs';
import { discoverEntities, emptyDiscoveryReport, writeDiscoveryReport } from './discover-entities.mjs';
import { produceDddOverlays } from './ddd-overlays.mjs';
import { produceDomainDerivation } from './domain-derivation.mjs';
import { produceStructuralGrouping } from './structural-grouping.mjs';
import { mergeAnnotations, STRUCTURAL_UNCLASSIFIED_FILE_SUFFIX } from './annotate.mjs';
import { QUEUE_KEYS, queueVector, refusalCensus } from './query.mjs';
import { defaultOutputRoot, registerScanRoot } from './readonly-guard.mjs';
import { runGuarded } from './portability.mjs';
import { LEDGER_FILE as ADJUDICATION_LEDGER_FILE, LEDGER_SCHEMA as ADJUDICATION_LEDGER_SCHEMA, reconciliationEdgePlans } from './l1-adjudicate.mjs';
import { ACTIVE_VECTOR_FILE, appendReconciliationEdges, CENSUS_VECTOR_FILE, projectActiveVector, readReconciliationEdges } from './reconciliation-edges.mjs';

const HELP = `Usage: node tools/estate-map/loop-driver.mjs <estate-root> [options]

Runs ONE full repair-loop iteration end to end and classifies the transition against the
previous iteration loaded from persisted state.

Options:
  --state <dir>      iteration state directory (default: a per-estate directory OUTSIDE the
                     scanned tree, under $ASCRYBE_OUT_ROOT / $XDG_STATE_HOME /
                     ~/.local/state/estate-map -- never inside <estate-root>)
  --work <dir>       pipeline working directory (default: <state>/work)
  --canon-ddd <p>    ddd-mapping canon (default: <repo>/design/canon/ddd-mapping.md)
  --canon-ontology   ontology canon (default: <estate-root>/design/canon/ontology.md)
  --now <iso>        iteration timestamp (default: wall clock; fix it for byte-stable output)
  --l1-state <dir>   L1 adjudication state directory (default: <state>); accepted current-digest
                     ledger rows are persisted as reconciliation edges before ACTIVE is compared
  --l1-refusals <p>  L1 refusal ledger (default: <l1-state>/l1-refusals.jsonl) — makes the
                     attempt_bound and concrete_insufficient_because T4 conditions evaluable
  --json             print the machine-readable verdict to stdout instead of the summary
  --help

Deterministic, offline, no model calls. Writes only under --state and --work, and NEVER
inside <estate-root>: any write resolving under the scan root fails loudly with
ASCRYBE_READONLY_VIOLATION.`;

export const ITERATION_SCHEMA = 'estate-map/loop-iteration/v1';
export const OBSERVATION_SCHEMA = 'estate-map/refusal-observation/v1';
export const ITERATIONS_FILE = 'loop-iterations.jsonl';
export const OBSERVATIONS_FILE = 'refusal-observations.jsonl';
export const STATE_FILE = 'loop-state.json';
export const VERDICT_FILE = 'latest-verdict.json';
export const SUMMARY_FILE = 'latest-summary.txt';
export const LEDGER_FILE = 'domain-derivation.refusals.jsonl';
// Written by l1-adjudicate.mjs into ITS state dir; the driver reads it to make the two T4
// conditions the deterministic refusal schema cannot express evaluable (§3.1 of the driver
// report). Absent file ⇒ empty ⇒ pre-L1 behaviour, unchanged.
export const L1_REFUSALS_FILE = 'l1-refusals.jsonl';
export const L1_REFUSAL_SCHEMA = 'estate-map/l1-refusal/v1';
export { CENSUS_VECTOR_FILE, ACTIVE_VECTOR_FILE };

// DESIGN.md §3.2: R = 2 refusals per entry, from adjudicators of distinct model families.
export const REFUSAL_ATTEMPT_BOUND = 2;

// ---------------------------------------------------------------------------
// ROUTING — l1-adjudication-spec.md §1, emitted as DATA, not prose.
//
// The routing decision is made by the deterministic diagnoser, NEVER by an adjudicator
// (spec §1: "The routing decision is made by the deterministic diagnoser"). Category (b)
// is an extractor defect BY DEFINITION and never reaches L1: "a model judgment here
// launders a bug into a permanent overlay".
// ---------------------------------------------------------------------------
export const ROUTING_TABLE = Object.freeze({
  unresolved_b: Object.freeze({
    queue: 'unresolved_b', arm: 'REPAIR', claim_type: null, actionable_today: true,
    rationale: 'Defined as "should have resolved and did not" — the classification already asserts a deterministic resolver defect. Never L1.',
    spec: 'l1-adjudication-spec.md §1 row "unresolved (b)"',
  }),
  ambiguous_c: Object.freeze({
    queue: 'ambiguous_c', arm: 'ADJUDICABLE', claim_type: 'disambiguation', actionable_today: false,
    rationale: 'Extractor found ≥2 candidate targets and refused to guess. Bounded multiple-choice with a determinate answer.',
    spec: 'l1-adjudication-spec.md §1 row "ambiguous (c)" / §3.1',
  }),
  discovered_undocumented: Object.freeze({
    queue: 'discovered_undocumented', arm: 'ADJUDICABLE', claim_type: 'entity_classification', actionable_today: false,
    rationale: 'Real in code, absent from canon.',
    spec: 'l1-adjudication-spec.md §1 row "discovered_undocumented" / §3.2',
  }),
  documented_unwitnessed: Object.freeze({
    queue: 'documented_unwitnessed', arm: 'ADJUDICABLE', claim_type: 'referent_search', actionable_today: false,
    rationale: 'Canon asserts it, extractor found no signal.',
    spec: 'l1-adjudication-spec.md §1 row "documented_unwitnessed" / §3.3',
  }),
  undomained: Object.freeze({
    queue: 'undomained', arm: 'GATED', claim_type: 'domain_assignment', actionable_today: false,
    rationale: 'GATED — not v1. §8: domain_assignment should not be the first thing L1 ever does.',
    spec: 'l1-adjudication-spec.md §1 row "undomained" / §8',
  }),
});

// l1-adjudication-spec.md §2: batch cap 10, single queue, homogeneous claim type.
export const L1_BATCH_CAP = 10;

/**
 * Route the measured queues. Pure function of the diagnosis; emits one row per queue with
 * the arm, the claim type, the batch shape L1 would consume, and — for the arms that are
 * NOT actionable today — the reason they are reported rather than acted on.
 */
export function routeQueues(diagnosis) {
  const rows = QUEUE_KEYS.map(key => {
    const rule = ROUTING_TABLE[key];
    const depth = diagnosis.queues.vector[key];
    const row = {
      ...rule,
      depth,
      ready_for_l1: rule.arm === 'ADJUDICABLE' ? depth : 0,
      batches: rule.arm === 'ADJUDICABLE' && depth ? Math.ceil(depth / L1_BATCH_CAP) : 0,
      blocked_by: rule.arm === 'ADJUDICABLE' ? 'no L1 adjudicator implementation exists (spec landed, implementation not)'
        : rule.arm === 'GATED' ? 'claim type gated out of L1 v1'
          : null,
    };
    if (key === 'unresolved_b') row.families = diagnosis.queues.families.unresolved_b;
    if (key === 'ambiguous_c') row.families = diagnosis.queues.families.ambiguous_c;
    if (key === 'undomained') row.families = diagnosis.refusals.by_reason.map(entry => ({ family: entry.reason, count: entry.count }));
    return row;
  });
  const ready = rows.filter(row => row.arm === 'ADJUDICABLE');
  return {
    rows,
    ready_for_l1_by_claim_type: Object.fromEntries(ready.map(row => [row.claim_type, row.ready_for_l1])),
    ready_for_l1_total: ready.reduce((sum, row) => sum + (row.ready_for_l1 || 0), 0),
    repair_total: rows.filter(row => row.arm === 'REPAIR').reduce((sum, row) => sum + (row.depth || 0), 0),
    gated_total: rows.filter(row => row.arm === 'GATED').reduce((sum, row) => sum + (row.depth || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// T4 ADMISSIBILITY — DESIGN.md §3.2 "Admissible refusal" row, stated condition by
// condition, each carrying whether TODAY'S refusal-record data can evaluate it.
//
// The data contract is annotate.mjs#REFUSAL_FIELDS, a CLOSED field list the validator
// enforces:
//   ['evidence','first_observed_at','id','last_observed_at','producer','reason',
//    'reason_detail','resolution','rule','schema','state','subject','subject_kind']
// There is no `refusal_attempts`, no `insufficient_because` and no `corpus_digest` on a
// record, and a record carrying one would be REJECTED by validateRefusal. So two of the
// three conditions are not evaluable from record data, and this module says so in its
// output rather than approximating them into a silent pass.
// ---------------------------------------------------------------------------
export const T4_CONDITIONS = Object.freeze([
  Object.freeze({
    id: 'attempt_bound',
    design_text: '`refusal_attempts < R` (R = 2, from adjudicators of distinct model families)',
    evaluable: false,
    why: 'No `refusal_attempts` field exists on estate-map/refusal-record/v1, and annotate.mjs#REFUSAL_FIELDS is a closed list the validator enforces, so one cannot be added without changing the schema. The driver reports `iterations_standing` per refusal as TELEMETRY, but that counts iterations a deterministic rule re-emitted the same verdict — not adjudication attempts by distinct model families — so it is NOT used as the bound.',
  }),
  Object.freeze({
    id: 'identity_digest_dedup',
    design_text: 'this adjudicator identity has not already refused this queue entry at this corpus digest',
    evaluable: true,
    why: 'Evaluable, but from DRIVER state rather than record data: a refusal record carries a producer/rule identity but no corpus digest. The driver keeps an append-only refusal-observations ledger keyed on (refusal_id, producer, corpus_digest) and treats a refusal as new iff that triple was not already observed.',
  }),
  Object.freeze({
    id: 'concrete_insufficient_because',
    design_text: '`insufficient_because` names a concrete obtainable artefact',
    evaluable: false,
    why: 'No `insufficient_because` field exists on the record. The nearest data is `evidence.not_found.sought` (present only on absence/mixed-shaped refusals) plus a prose `limitation`. Deciding whether prose "names a concrete obtainable artefact" is a judgement, not a deterministic check, so the driver does not score it.',
  }),
]);

/**
 * L1 refusal rows CLOSE the two schema gaps above (`estate-map/l1-refusal/v1`, written by
 * l1-adjudicate.mjs). That schema is separate from `estate-map/refusal-record/v1` precisely
 * because annotate.mjs#REFUSAL_FIELDS is a closed list the validator enforces — so the fields
 * DESIGN.md §3.2 needs could not be added there. Given L1 rows, `attempt_bound` becomes an
 * integer comparison and `concrete_insufficient_because` becomes presence of a STRUCTURED
 * `requested_artifact` alongside the prose. The residue is stated, not hidden: whether the
 * named artefact would ACTUALLY have sufficed is still a judgement no field can make.
 */
export function assessL1Refusals(l1Refusals, priorObservations, corpusDigest) {
  const seen = new Set((priorObservations || []).map(row => `${row.refusal_id}\0${row.producer}\0${row.corpus_digest}`));
  const rows = [], escalated = [], overBound = [], vague = [];
  for (const record of l1Refusals || []) {
    const producer = `l1/${record.adjudicator}`;
    const key = `${record.refusal_id}\0${producer}\0${corpusDigest}`;
    const withinBound = Number.isInteger(record.attempt) && record.attempt <= REFUSAL_ATTEMPT_BOUND;
    const concrete = typeof record.insufficient_because === 'string' && record.insufficient_because.trim().length >= 24
      && typeof record.requested_artifact === 'string' && record.requested_artifact.trim().length > 0;
    if (!withinBound) overBound.push(record.refusal_id);
    if (!concrete) vague.push(record.refusal_id);
    if (Number.isInteger(record.attempt) && record.attempt >= REFUSAL_ATTEMPT_BOUND) escalated.push(record.refusal_id);
    if (seen.has(key) || !withinBound || !concrete) continue;
    seen.add(key);
    rows.push({
      schema: OBSERVATION_SCHEMA,
      refusal_id: record.refusal_id,
      producer,
      rule: record.claim_type,
      reason: record.verdict,
      subject: record.queue_entry_digest,
      corpus_digest: corpusDigest,
    });
  }
  return {
    total: (l1Refusals || []).length,
    new_admissible: rows.length,
    new_observations: rows,
    escalated,
    inadmissible_over_attempt_bound: overBound,
    inadmissible_vague_insufficient_because: vague,
    adjudicators: [...new Set((l1Refusals || []).map(record => record.adjudicator).filter(Boolean))].sort(),
    families: [...new Set((l1Refusals || []).map(record => record.adjudicator_family).filter(Boolean))].sort(),
  };
}

/**
 * Decide which of this iteration's standing refusals are ADMISSIBLE for T4, and record what
 * could not be decided. `priorObservations` is the driver's append-only observation ledger.
 *
 * Policy, stated so it is auditable: a refusal is counted admissible iff every EVALUABLE
 * condition passes. Unevaluable conditions are neither passed nor failed — they are listed,
 * and any T4 verdict reached with a non-empty unevaluable list is marked `provisional`.
 * Fail-closed would make T4 unreachable and quietly restore the exact empty-fixpoint bug T4
 * was added to fix; silent fail-open is what this contract forbids.
 *
 * `l1Refusals` is OPTIONAL and defaults to none, so a run with no L1 ledger behaves exactly as
 * before: two conditions unevaluable, deterministic-producer degeneracy flagged.
 */
export function assessT4Admissibility(standingRefusals, priorObservations, corpusDigest, l1Refusals = []) {
  const seen = new Set((priorObservations || []).map(row => `${row.refusal_id}\0${row.producer}\0${row.corpus_digest}`));
  const newObservations = [];
  for (const record of standingRefusals) {
    const key = `${record.id}\0${record.producer}\0${corpusDigest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newObservations.push({
      schema: OBSERVATION_SCHEMA,
      refusal_id: record.id,
      producer: record.producer,
      rule: record.rule,
      reason: record.reason,
      subject: record.subject,
      corpus_digest: corpusDigest,
    });
  }
  const l1 = assessL1Refusals(l1Refusals, priorObservations, corpusDigest);
  // The two record-schema gaps are closed IFF L1 rows are present this iteration. With no L1
  // ledger the driver reports exactly what it reported before, because nothing supplies them.
  const closedByL1 = l1.total > 0 ? new Set(['attempt_bound', 'concrete_insufficient_because']) : new Set();
  const unevaluable = T4_CONDITIONS.filter(condition => !condition.evaluable && !closedByL1.has(condition.id)).map(condition => condition.id);
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  const producers = [...new Set(standingRefusals.map(record => record.producer).filter(Boolean))].sort();
  const deterministicProducersOnly = producers.length > 0 && producers.every(producer => producer.startsWith('deterministic/')) && l1.total === 0;
  const admissibleCount = newObservations.length + l1.new_admissible;
  const conditionVerdict = condition => {
    if (condition.id === 'attempt_bound' && l1.total) return l1.inadmissible_over_attempt_bound.length ? 'fail' : 'pass';
    if (condition.id === 'concrete_insufficient_because' && l1.total) return l1.inadmissible_vague_insufficient_because.length ? 'fail' : 'pass';
    if (!condition.evaluable) return 'unevaluable';
    return admissibleCount ? 'pass' : 'fail';
  };
  return {
    standing_refusals: standingRefusals.length,
    new_admissible_refusals: admissibleCount,
    admissible: admissibleCount > 0,
    provisional: admissibleCount > 0 && (unevaluable.length > 0 || deterministicProducersOnly),
    producers,
    deterministic_producers_only: deterministicProducersOnly,
    conditions: T4_CONDITIONS.map(condition => ({
      ...condition,
      evaluable_this_iteration: condition.evaluable || closedByL1.has(condition.id),
      evaluated_from: closedByL1.has(condition.id) ? `${l1.total} ${L1_REFUSAL_SCHEMA} row(s)` : (condition.evaluable ? 'driver observation ledger' : null),
      verdict: conditionVerdict(condition),
    })),
    unevaluable_conditions: unevaluable,
    attempt_bound: REFUSAL_ATTEMPT_BOUND,
    l1: { ...l1, new_observations: undefined },
    new_observations: [...newObservations, ...l1.new_observations],
    examples: [...newObservations, ...l1.new_observations].slice(0, 5).map(row => row.refusal_id),
  };
}

// ---------------------------------------------------------------------------
// STOPPING RULE — DESIGN.md §3.2, evaluated in the order the design mandates: T1, T2, T4, T3.
//
// "T1 is tested first, so a mixed iteration (some queue shrank, some queue grew) is GROWTH."
// "T4 is tested after T2 and before T3, so equality-with-a-new-refusal is REFUSAL and
//  equality-without is FIXPOINT."
// The reducer (this function, deterministic) classifies the iteration — NEVER the adjudicator.
// ---------------------------------------------------------------------------
export const TRANSITIONS = Object.freeze({
  T1: Object.freeze({ id: 'T1', name: 'GROWTH', decision: 'stop', terminal: 'escalate_to_outer_loop', diminishing_returns: false }),
  T2: Object.freeze({ id: 'T2', name: 'PROGRESS', decision: 'continue', terminal: null, diminishing_returns: false }),
  T4: Object.freeze({ id: 'T4', name: 'REFUSAL', decision: 'continue', terminal: null, diminishing_returns: false }),
  T3: Object.freeze({ id: 'T3', name: 'FIXPOINT', decision: 'stop', terminal: 'inner_loop_terminates', diminishing_returns: true }),
  BASELINE: Object.freeze({ id: 'BASELINE', name: 'BASELINE', decision: 'continue', terminal: null, diminishing_returns: false }),
});

export function queueDeltas(previousVector, currentVector) {
  return Object.fromEntries(QUEUE_KEYS.map(key => {
    const before = previousVector ? previousVector[key] : null;
    const after = currentVector[key];
    const comparable = Number.isInteger(before) && Number.isInteger(after);
    return [key, { before, after, delta: comparable ? after - before : null, comparable }];
  }));
}

/**
 * Classify iteration i against iteration i−1.
 *
 * `previousVector === null` is the FIRST iteration: it has no predecessor, so it is not one
 * of T1–T4. It is reported as BASELINE rather than being forced into FIXPOINT, which would
 * halt the loop before it ever ran.
 *
 * A queue whose depth is unavailable in either vector is NOT comparable; treating an
 * unavailable depth as 0 would manufacture a spurious shrink (a §5.2 draining-by-exclusion
 * shape). Such an iteration is reported INDETERMINATE and stops the loop.
 */
export function classifyTransition(previousVector, currentVector, t4) {
  const deltas = queueDeltas(previousVector, currentVector);
  const rows = Object.entries(deltas);
  if (!previousVector) {
    return { ...TRANSITIONS.BASELINE, deltas, reason: 'First iteration: no previous queue vector to compare against, so none of T1–T4 applies. The next run classifies against this one.', grew: [], shrank: [], equal: [] };
  }
  const incomparable = rows.filter(([, row]) => !row.comparable).map(([key]) => key);
  if (incomparable.length) {
    return {
      id: 'INDETERMINATE', name: 'INDETERMINATE', decision: 'stop', terminal: 'indeterminate', diminishing_returns: false, deltas,
      reason: `Queue depth unavailable on both sides for: ${incomparable.join(', ')}. The stopping rule is componentwise over all five queues; substituting 0 for a missing depth would manufacture a shrink, which is draining by exclusion (§5.2).`,
      grew: [], shrank: [], equal: [],
    };
  }
  const grew = rows.filter(([, row]) => row.delta > 0).map(([key]) => key);
  const shrank = rows.filter(([, row]) => row.delta < 0).map(([key]) => key);
  const equal = rows.filter(([, row]) => row.delta === 0).map(([key]) => key);
  const base = { deltas, grew, shrank, equal };
  // T1 — tested FIRST, so a mixed iteration is GROWTH, not PROGRESS and not FIXPOINT.
  if (grew.length) {
    return { ...TRANSITIONS.T1, ...base, reason: `Queue(s) grew: ${grew.map(key => `${key} ${deltas[key].before}→${deltas[key].after}`).join(', ')}. NOT diminishing returns — control transfers to the outer loop (§4.2).` };
  }
  // T2 — ∀k ≤ (implied once T1 is excluded, still checked literally) AND ∃k <.
  if (rows.every(([, row]) => row.delta <= 0) && shrank.length) {
    return { ...TRANSITIONS.T2, ...base, reason: `No queue grew and ${shrank.length} shrank: ${shrank.map(key => `${key} ${deltas[key].before}→${deltas[key].after}`).join(', ')}. Continue to the next iteration.` };
  }
  // T4 — componentwise equality AND ≥1 new ADMISSIBLE refusal record this iteration.
  if (equal.length === rows.length && t4?.admissible) {
    const caveats = [];
    if (t4.unevaluable_conditions?.length) caveats.push(`${t4.unevaluable_conditions.join(', ')} could not be evaluated with the refusal-record data that exists`);
    if (t4.deterministic_producers_only) caveats.push('every standing refusal comes from a DETERMINISTIC producer, which re-emits its verdict set for free, so these refusals are new only in the sense that the corpus digest moved');
    return { ...TRANSITIONS.T4, ...base, reason: `Every queue is componentwise equal, and this iteration appended ${t4.new_admissible_refusals} new admissible refusal record(s). NOT diminishing returns — the loop learned something the queue depths cannot show.${caveats.length ? ` PROVISIONAL: ${caveats.join('; ')}.` : ''}` };
  }
  // T3 — componentwise equality, no new admissible refusal.
  return { ...TRANSITIONS.T3, ...base, reason: `Every queue is componentwise equal and no new admissible refusal record was appended (${t4 ? t4.new_admissible_refusals : 0} new). Diminishing returns — the inner loop terminates.` };
}

// ---------------------------------------------------------------------------
// RECOMMENDATION — one next action, with its reason, derived from the routing data.
// ---------------------------------------------------------------------------
export function recommendNextAction(transition, routing, t4) {
  if (transition.id === 'T1') {
    const grew = transition.grew.map(key => `${key} ${transition.deltas[key].before}→${transition.deltas[key].after}`).join(', ');
    return { action: 'ESCALATE_TO_OUTER_LOOP', target: transition.grew, why: `GROWTH is an inner-loop terminal, not the fixpoint: ${grew}. Better extraction discovering more real entities is a signal, so the outer loop (§4.2) decides the next strategy.` };
  }
  if (transition.id === 'INDETERMINATE') {
    return { action: 'REPAIR_DIAGNOSIS', target: [], why: transition.reason };
  }
  const repair = routing.rows.find(row => row.queue === 'unresolved_b');
  if (repair.depth > 0) {
    const top = repair.families[0];
    return {
      action: 'REPAIR',
      target: [top.family],
      batch: repair.families.slice(0, 3),
      why: `Category (b) is the only arm actionable today without an L1 implementation: ${repair.depth} record(s) that should have resolved and did not, across ${repair.families.length} deterministic family/families. The largest is \`${top.family}\` (${top.count}). Fixing a resolver family removes real defects and re-runs L0, which is a DRAIN backed by a re-extraction delta rather than by exclusion (§5.4).`,
    };
  }
  const biggest = routing.rows.filter(row => row.arm === 'ADJUDICABLE' && row.depth > 0).sort((a, b) => b.depth - a.depth)[0];
  if (biggest) {
    return {
      action: 'REPORT_READY_FOR_L1',
      target: [biggest.claim_type],
      batch: [{ claim_type: biggest.claim_type, depth: biggest.depth, batches: biggest.batches }],
      why: `Category (b) is empty, so no REPAIR is available. The largest adjudicable queue is ${biggest.queue} (${biggest.depth} entries → ${biggest.batches} batch(es) of ≤${L1_BATCH_CAP} at claim type \`${biggest.claim_type}\`). It cannot be acted on: ${biggest.blocked_by}.`,
    };
  }
  return {
    action: 'NO_ACTION_AVAILABLE',
    target: [],
    why: `Every actionable queue is empty. Standing refusals: ${t4.standing_refusals}. Gated (undomained) entries remain out of L1 v1 scope.`,
  };
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
const readJsonlFile = async (file) => {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

export async function readLoopState(stateDir) {
  const iterations = await readJsonlFile(path.join(stateDir, ITERATIONS_FILE));
  const observations = await readJsonlFile(path.join(stateDir, OBSERVATIONS_FILE));
  return { iterations, observations, latest: iterations.length ? iterations[iterations.length - 1] : null };
}

const appendJsonl = async (file, rows) => {
  if (!rows.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
};

export async function persistIteration(stateDir, record, newObservations) {
  await fs.mkdir(stateDir, { recursive: true });
  await appendJsonl(path.join(stateDir, ITERATIONS_FILE), [record]);
  await appendJsonl(path.join(stateDir, OBSERVATIONS_FILE), newObservations);
  await fs.writeFile(path.join(stateDir, CENSUS_VECTOR_FILE), stableStringify({
    schema: 'estate-map/queue-vector/v1', kind: 'CENSUS', iteration: record.iteration,
    corpus_digest: record.corpus_digest, vector: record.queues.census ?? record.queues.vector,
  }), 'utf8');
  await fs.writeFile(path.join(stateDir, ACTIVE_VECTOR_FILE), stableStringify({
    schema: 'estate-map/queue-vector/v1', kind: 'ACTIVE', iteration: record.iteration,
    corpus_digest: record.corpus_digest, vector: record.queues.active ?? record.queues.vector,
  }), 'utf8');
  await fs.writeFile(path.join(stateDir, STATE_FILE), stableStringify({
    schema: ITERATION_SCHEMA,
    latest_iteration: record.iteration,
    iterations_file: ITERATIONS_FILE,
    observations_file: OBSERVATIONS_FILE,
    latest: record,
  }), 'utf8');
  return record;
}

const digestFile = async (file) => {
  try { return sha256(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/**
 * Corpus digest — a function of the EXTRACTED CORPUS, upstream of every downstream artifact
 * the driver produces, so the driver's own state can never move it. Computed over the facts
 * files extract.mjs wrote, which are themselves a deterministic function of the scanned tree.
 */
export async function corpusDigestOf(factsDir) {
  const files = (await fs.readdir(factsDir)).sort();
  const rows = [];
  for (const file of files) rows.push({ file, sha256: await digestFile(path.join(factsDir, file)) });
  return { digest: sha256(stableStringify(rows)), files: rows.length };
}

// ---------------------------------------------------------------------------
// The iteration
// ---------------------------------------------------------------------------
export async function runIteration(estateRoot, options = {}) {
  const root = path.resolve(estateRoot);
  registerScanRoot(root, { registeredBy: 'loop-driver estate-root argument' });
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : defaultOutputRoot(root, 'loop');
  const workDir = path.resolve(options.workDir || path.join(stateDir, 'work'));
  const now = options.now || new Date().toISOString();
  const startedAt = options.startedAt || now;

  const extractDir = path.join(workDir, 'extract');
  const graphDir = path.join(workDir, 'graph');
  const overlaysDir = path.join(workDir, 'overlays');
  const discoveryDir = path.join(workDir, 'discovery');
  const graphPath = path.join(graphDir, 'estate-graph.json');
  const annotatedPath = path.join(graphDir, 'estate-graph.annotated.json');
  const derivedPath = path.join(overlaysDir, 'derived.jsonl');
  const dddPath = path.join(overlaysDir, 'ddd.jsonl');
  const structuralPath = path.join(overlaysDir, 'structural.jsonl');
  const structuralUnclassifiedPath = path.join(overlaysDir, `structural${STRUCTURAL_UNCLASSIFIED_FILE_SUFFIX}`);
  const refusalsPath = path.join(overlaysDir, LEDGER_FILE);
  const durableLedgerPath = path.join(stateDir, LEDGER_FILE);

  const prior = await readLoopState(stateDir);
  const iteration = (prior.latest?.iteration || 0) + 1;
  const l1StateDir = path.resolve(options.l1StateDir || stateDir);

  // ---- 1. GENERATE — orchestrate the shipped pipeline, in order. ----
  await extractEstate(root, extractDir, {});
  await mergeFacts(path.join(extractDir, 'facts'), graphDir, {});
  // The whole iteration used to die here. `discoverEntities` read the ontology canon
  // unguarded, so on an estate without `design/canon/ontology.md` a missing MARKDOWN FILE
  // aborted the pass AFTER extract, merge and the overlays had already succeeded, and all
  // of that work was discarded. discoverEntities now degrades internally; this wrapper
  // covers the residual class -- any OTHER throw from the discovery stage becomes a typed
  // SCOPE record naming the tool, the estate and the phase, and the iteration continues to
  // a verdict that says discovery is unavailable instead of producing no verdict at all.
  const discoveryRun = await runGuarded(() => discoverEntities({
    estateRoot: root,
    canonPath: options.ontologyCanonPath,
  }), { tool: 'loop-driver', estateRoot: root, phase: 'discover-entities' });
  const portability = [...(discoveryRun.record ? [discoveryRun.record] : []), ...(discoveryRun.value?.portability || [])];
  const discovery = discoveryRun.value ?? emptyDiscoveryReport({ estateRoot: root, unavailable: discoveryRun.record.detail });
  await writeDiscoveryReport(discovery, discoveryDir);
  await produceDddOverlays(graphPath, dddPath, options.canonPath ? { canonPath: options.canonPath } : {});
  // The prior DURABLE ledger (state dir) drives the §2.5 refusal state machine across
  // iterations, so first_observed_at survives a wiped work dir.
  const derivation = await produceDomainDerivation(graphPath, derivedPath, {
    ...(options.canonPath ? { canonPath: options.canonPath } : {}),
    refusalsPath,
    priorRefusalsPath: durableLedgerPath,
  });
  // Structural grouping is a PROJECTION input, not a derivation of domain: it emits a
  // separate annotation family with no `domain` field, so it cannot move a queue depth. It
  // runs here so the merged graph the DIAGNOSE step reads back is the same artifact the
  // renderer consumes — and so the queue vector below is measured WITH it present, which is
  // the whole no-drain claim rather than an assertion about it.
  const structural = await produceStructuralGrouping(graphPath, structuralPath, { unclassifiedPath: structuralUnclassifiedPath, now });
  await mergeAnnotations(graphDir, overlaysDir);

  // ---- 2. DIAGNOSE — read back OFF DISK through the query path. ----
  // Nothing below reads `derivation` for a queue depth or a census: the vector and the
  // refusal census are recomputed from the persisted bytes, which is the whole point.
  const annotatedBytes = await fs.readFile(annotatedPath, 'utf8');
  const annotated = JSON.parse(annotatedBytes);
  const discoveryBytes = await fs.readFile(path.join(discoveryDir, 'discovery-report.json'), 'utf8');
  const persistedDiscovery = JSON.parse(discoveryBytes);
  // classifyRecord wants the inner Map, not loadSymbolIndex's wrapper (analyze.mjs:532 does
  // the same unwrap). Without it, cross-repo symbol records the facts index proves in-estate
  // fall to category (a) instead of (b) and the REPAIR queue is silently understated.
  const symbolIndex = await loadSymbolIndex(path.join(extractDir, 'facts'));
  const queues = queueVector(annotated, { discovery: persistedDiscovery, symbolRepos: symbolIndex.symbolRepos });
  const census = refusalCensus(annotated);
  const standing = (annotated.refusals || []).filter(record => record.state === 'refused');
  const corpus = await corpusDigestOf(path.join(extractDir, 'facts'));
  const l1Refusals = (await readJsonlFile(path.resolve(options.l1RefusalsPath || path.join(l1StateDir, L1_REFUSALS_FILE))))
    .filter(record => record?.schema === L1_REFUSAL_SCHEMA);
  const adjudicationLedger = (await readJsonlFile(path.join(l1StateDir, ADJUDICATION_LEDGER_FILE)))
    .filter(record => record?.schema === ADJUDICATION_LEDGER_SCHEMA);
  const ledgerDetail = reconciliationEdgePlans(adjudicationLedger, corpus.digest);
  // A drain is not a reducer-side exclusion: accepted rows first become append-only edges,
  // then ACTIVE is projected from those persisted edge bytes.
  const appendedEdges = await appendReconciliationEdges(stateDir, ledgerDetail.plans, { now });
  const persistedEdges = appendedEdges.edges.length ? appendedEdges.edges : await readReconciliationEdges(stateDir);
  const activeProjection = projectActiveVector(queues.vector, persistedEdges, corpus.digest);
  const l1 = {
    status: adjudicationLedger.length ? 'durable_ledger_available' : 'unavailable',
    reason: adjudicationLedger.length ? 'ACTIVE folded accepted current-digest ledger rows through persisted reconciliation edges' : 'no L1 adjudication ledger exists; model-dependent adjudication is absent by design',
    state: l1StateDir === stateDir ? 'co-located' : 'external',
    accepted_current_digest: ledgerDetail.plans.length,
    reconciliation_edges_appended: appendedEdges.appended.length,
    reconciliation_edges_active: activeProjection.resolved_edge_count,
  };

  // ---- 3. ROUTE ----
  const diagnosis = { queues: { ...queues, vector: activeProjection.active }, refusals: census };
  const routing = routeQueues(diagnosis);

  // ---- 4. STOPPING RULE ----
  const t4 = assessT4Admissibility(standing, prior.observations, corpus.digest, l1Refusals);
  const transition = classifyTransition(prior.latest?.queues?.active || null, activeProjection.active, t4);
  const recommendation = recommendNextAction(transition, routing, t4);

  // ---- 5. PERSIST ----
  // Copy the freshly produced ledger to the durable state dir so the NEXT run has it even
  // if the work dir is wiped. The copy is byte-for-byte; the driver never edits a record.
  await fs.mkdir(stateDir, { recursive: true });
  await fs.copyFile(refusalsPath, durableLedgerPath);
  const { new_observations: newObservations, ...t4Record } = t4;
  const record = {
    schema: ITERATION_SCHEMA,
    iteration,
    started_at: startedAt,
    finished_at: options.now || new Date().toISOString(),
    estate_root: root,
    corpus_digest: corpus.digest,
    corpus_fact_files: corpus.files,
    artifact_digests: {
      graph: sha256(await fs.readFile(graphPath)),
      annotated_graph: sha256(annotatedBytes),
      derived_overlays: await digestFile(derivedPath),
      ddd_overlays: await digestFile(dddPath),
      structural_overlays: await digestFile(structuralPath),
      structural_unclassified: await digestFile(structuralUnclassifiedPath),
      refusal_ledger: await digestFile(refusalsPath),
      discovery_report: sha256(discoveryBytes),
    },
    queues: {
      // `vector` remains an ACTIVE compatibility alias; consumers must prefer the explicit
      // CENSUS/ACTIVE pair and their standalone durable artifacts.
      vector: activeProjection.active, census: queues.vector, active: activeProjection.active,
      totals: queues.totals, sources: queues.sources, families: queues.families,
      active_projection: { resolved_edge_count: activeProjection.resolved_edge_count, drains: activeProjection.drained },
    },
    queue_deltas: transition.deltas,
    transition: {
      id: transition.id, name: transition.name, decision: transition.decision,
      terminal: transition.terminal, diminishing_returns: transition.diminishing_returns,
      reason: transition.reason, grew: transition.grew, shrank: transition.shrank, equal: transition.equal,
      compared_against_iteration: prior.latest?.iteration ?? null,
    },
    refusals: {
      total_records: census.total_records,
      standing: census.standing_refusals,
      refused_subjects: census.refused_subjects,
      by_reason: census.by_reason.map(({ reason, count }) => ({ reason, count })),
      by_state: census.by_state,
      by_evidence_shape: census.by_evidence_shape,
    },
    // Reported beside the queues, NOT inside them. A structural group is a projection facet;
    // recording its census here lets a reader check the no-drain claim in one file (the
    // groups moved, the queue vector did not) instead of taking it on trust.
    structural: {
      grouped: structural.census.grouped,
      unclassified: structural.census.unclassified,
      coverage_complete: structural.census.coverage_complete,
      by_group: structural.census.by_group,
      unclassified_by_reason: structural.census.unclassified_by_reason.map(({ reason, count }) => ({ reason, count })),
    },
    t4: t4Record,
    l1,
    routing: {
      rows: routing.rows.map(({ families, ...row }) => row),
      ready_for_l1_by_claim_type: routing.ready_for_l1_by_claim_type,
      ready_for_l1_total: routing.ready_for_l1_total,
      repair_total: routing.repair_total,
      gated_total: routing.gated_total,
    },
    recommendation,
  };
  await persistIteration(stateDir, record, newObservations);

  const verdict = { ...record, routing_detail: routing.rows };
  await fs.writeFile(path.join(stateDir, VERDICT_FILE), stableStringify(verdict), 'utf8');
  const summary = renderSummary(verdict);
  await fs.writeFile(path.join(stateDir, SUMMARY_FILE), summary + '\n', 'utf8');
  return { record, verdict, summary, stateDir, workDir, routing, queues: { census: queues, active: activeProjection }, transition, t4, l1, derivation, structural };
}

// ---------------------------------------------------------------------------
// REPORT — one screen.
// ---------------------------------------------------------------------------
export function renderSummary(verdict) {
  const pad = (value, width) => String(value ?? '—').padStart(width);
  const lines = [];
  lines.push(`REPAIR LOOP — iteration ${verdict.iteration}  ·  corpus ${verdict.corpus_digest.slice(0, 12)}  ·  ${verdict.finished_at}`);
  lines.push(`TRANSITION  ${verdict.transition.id} ${verdict.transition.name} → ${verdict.transition.decision.toUpperCase()}${verdict.transition.terminal ? ` (${verdict.transition.terminal})` : ''}`);
  lines.push(`            ${verdict.transition.reason}`);
  lines.push('');
  lines.push('QUEUE                      depth    Δ   arm          claim type            ready-for-L1');
  for (const row of verdict.routing.rows) {
    const delta = verdict.queue_deltas[row.queue];
    const shown = delta && delta.delta !== null ? (delta.delta > 0 ? `+${delta.delta}` : String(delta.delta)) : '—';
    lines.push(`  ${row.queue.padEnd(24)}${pad(row.depth, 5)}${pad(shown, 5)}   ${row.arm.padEnd(12)} ${(row.claim_type || '—').padEnd(21)} ${pad(row.ready_for_l1 || '—', 5)}`);
  }
  lines.push('');
  lines.push(`REFUSALS    ${verdict.refusals.standing} standing over ${verdict.refusals.refused_subjects} subject(s); ${verdict.t4.new_admissible_refusals} new admissible this iteration`);
  if (verdict.structural) {
    // Printed right under REFUSALS so the no-drain relationship is visible in one screen: the
    // structural census partitions the SAME nodes the undomained queue still counts.
    lines.push(`STRUCTURE   ${verdict.structural.by_group.length} derived group(s) over ${verdict.structural.grouped} node(s); ${verdict.structural.unclassified} unclassified — a structural group is NOT a domain and drains no queue`);
    lines.push(`            ${verdict.structural.by_group.map(row => `${row.group}=${row.count}`).join('  ')}`);
  }
  lines.push(`T4 UNEVALUABLE  ${verdict.t4.unevaluable_conditions.length ? verdict.t4.unevaluable_conditions.join(', ') : '(none)'} — see t4.conditions[].why`);
  if (verdict.t4.l1?.total) {
    lines.push(`L1 REFUSALS     ${verdict.t4.l1.total} row(s) from ${verdict.t4.l1.families.join(', ') || '(no family)'}; ${verdict.t4.l1.new_admissible} newly admissible, ${verdict.t4.l1.escalated.length} escalated at the R=${verdict.t4.attempt_bound} bound`);
  }
  lines.push('');
  lines.push(`READY FOR L1  ${Object.entries(verdict.routing.ready_for_l1_by_claim_type).map(([type, count]) => `${type}=${count}`).join('  ')}  (total ${verdict.routing.ready_for_l1_total}; NOT acted on — no adjudicator exists)`);
  lines.push('');
  lines.push(`NEXT ACTION  ${verdict.recommendation.action}${verdict.recommendation.target.length ? ` → ${verdict.recommendation.target.join(', ')}` : ''}`);
  lines.push(`            ${verdict.recommendation.why}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await runIteration(positional[0], {
      stateDir: options.state,
      workDir: options.work,
      canonPath: options['canon-ddd'] ? path.resolve(options['canon-ddd']) : undefined,
      ontologyCanonPath: options['canon-ontology'] ? path.resolve(options['canon-ontology']) : undefined,
      l1StateDir: options['l1-state'] ? path.resolve(options['l1-state']) : undefined,
      l1RefusalsPath: options['l1-refusals'] ? path.resolve(options['l1-refusals']) : undefined,
      now: options.now,
    });
    console.log(options.json ? stableStringify(result.verdict).trim() : result.summary);
    process.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

export const __repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
