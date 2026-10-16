#!/usr/bin/env node
// One command that maps an estate, because the pipeline was never the thing anyone wanted to
// assemble by hand.
//
// WHY THIS EXISTS DESPITE THE DISPATCH RULE. `bin/ascrybe.mjs` dispatches rather than implements,
// and that rule earned itself: a verb that quietly bundles a stage costing money with one that
// changes what live readers see is a verb nobody can run confidently. But the answer to that is
// not to make a person run six commands in order and remember which produces what -- it is to make
// the two dangerous stages DECLARED rather than implied. Spend is authorized by an environment
// gate the paid stage already enforces; promotion is opt-in by flag. Everything else is the
// deterministic middle, and there was never a reason to make anyone sequence it.
//
// WHAT EACH STAGE OWES THE NEXT is the real content here: materialize produces the pin map that
// gives a multi-repository estate its identity, remap carries those pins into the code graph's
// provenance, and the projection re-derives that same digest independently and refuses if the two
// disagree. Running them apart makes it possible to pass stage N the output of a different run of
// stage N-1; running them together makes that a type error.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEstateMapRuntimeConfig } from './ascrybe-config.mjs';
import { parseArgs } from './lib.mjs';

export const MAP_STAGES = Object.freeze(['materialize', 'extract', 'merge', 'remap', 'claims', 'project', 'promote']);

/** Stages that do something a person must authorize, and what authorizes each. */
export const GUARDED_STAGES = Object.freeze({
  claims: { gate: 'ASCRYBE_ENABLE_PAID_INFERENCE', why: 'calls a model per window of document text and is the only stage that costs money' },
  promote: { gate: '--promote', why: 'advances the selected head, changing what the dashboard and every reader see' },
});

function mapError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

/**
 * The stages this invocation will run, and the reason for every one it will not.
 *
 * Returned rather than logged so a caller can show the plan before anything happens. A stage
 * skipped for a missing authorization is not the same as one skipped because it was not asked
 * for, and a run that silently produced a code-plane-only map because a gate was closed is the
 * outcome this distinction exists to prevent.
 */
// The default range reaches promotion so the plan can SAY it did not promote. Stopping the range
// short instead would leave the most consequential stage simply absent, which reads as though it
// were never part of the pipeline rather than as a decision not taken.
export function planStages({ from = 'materialize', to = 'promote', promote = false,
  environment = process.env } = {}) {
  const first = MAP_STAGES.indexOf(from);
  const last = MAP_STAGES.indexOf(to);
  if (first < 0) throw mapError('MAP_STAGE_UNKNOWN', `--from ${from} is not one of: ${MAP_STAGES.join(', ')}`);
  if (last < 0) throw mapError('MAP_STAGE_UNKNOWN', `--to ${to} is not one of: ${MAP_STAGES.join(', ')}`);
  if (last < first) throw mapError('MAP_STAGE_ORDER', `--to ${to} comes before --from ${from}`);
  const requested = MAP_STAGES.slice(first, last + 1);
  const plan = [];
  for (const stage of requested) {
    if (stage === 'promote' && !promote) {
      plan.push({ stage, run: false, reason: 'not requested; pass --promote to advance the selected head' });
      continue;
    }
    const guard = GUARDED_STAGES[stage];
    if (guard?.gate?.startsWith('ASCRYBE_') && environment[guard.gate] !== '1') {
      plan.push({ stage, run: false, skipped_for: 'closed_gate', gate: guard.gate,
        reason: `${guard.gate} is not set to 1; this stage ${guard.why}` });
      continue;
    }
    plan.push({ stage, run: true });
  }
  return Object.freeze(plan);
}

/** Whether the plan would produce a graph that is documentary-complete, and what it lacks if not. */
export function planDisclosure(plan) {
  const skipped = plan.filter(entry => !entry.run);
  const closed = skipped.filter(entry => entry.skipped_for === 'closed_gate');
  return Object.freeze({
    runs: plan.filter(entry => entry.run).map(entry => entry.stage),
    skips: skipped.map(entry => ({ stage: entry.stage, reason: entry.reason })),
    // A map missing its paid half is not a smaller map; it is a map with no Claim nodes at all,
    // which reads as an estate that documents nothing rather than one that was not asked.
    documentary_complete: !closed.some(entry => entry.stage === 'claims'),
  });
}
