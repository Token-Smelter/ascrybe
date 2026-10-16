import test from 'node:test';
import assert from 'node:assert/strict';
import { planStages, planDisclosure, MAP_STAGES } from '../tools/map-estate.mjs';

const plan = (options = {}) => planStages({ environment: {}, ...options });

test('the default plan runs the full graph and stops before promotion', () => {
  const held = plan({ environment: { ASCRYBE_ENABLE_PAID_INFERENCE: '1' } });
  const disclosure = planDisclosure(held);
  assert.deepEqual(disclosure.runs,
    ['materialize', 'extract', 'merge', 'remap', 'claims', 'project']);
  // Promotion changes what every reader sees, so it is the one stage a default never performs.
  assert.deepEqual(disclosure.skips.map(entry => entry.stage), ['promote']);
  assert.equal(disclosure.documentary_complete, true);
});

// A run that quietly produced a code-plane-only map because a gate was closed is the outcome
// worth the most care: the graph is not smaller, it has no Claim nodes at all, and reads as an
// estate that documents nothing rather than one that was never asked.
test('a closed spend gate is disclosed as an incomplete map, not a silent skip', () => {
  const held = plan();
  const claims = held.find(entry => entry.stage === 'claims');
  assert.equal(claims.run, false);
  assert.equal(claims.skipped_for, 'closed_gate');
  assert.match(claims.reason, /ASCRYBE_ENABLE_PAID_INFERENCE/u);
  assert.match(claims.reason, /costs money/u);
  assert.equal(planDisclosure(held).documentary_complete, false);
  // The deterministic stages still run: a free map is a real outcome, just a named one.
  assert.deepEqual(planDisclosure(held).runs, ['materialize', 'extract', 'merge', 'remap', 'project']);
});

test('promotion runs only when asked for, and then only with the rest', () => {
  const held = planDisclosure(plan({ promote: true, environment: { ASCRYBE_ENABLE_PAID_INFERENCE: '1' } }));
  assert.equal(held.runs.at(-1), 'promote');
  assert.deepEqual(held.skips, []);
});

test('a partial range is honoured, and an impossible one refused', () => {
  assert.deepEqual(planDisclosure(plan({ from: 'remap', to: 'remap' })).runs, ['remap']);
  assert.throws(() => plan({ from: 'project', to: 'extract' }),
    error => error.code === 'MAP_STAGE_ORDER');
  assert.throws(() => plan({ from: 'invent' }), error => error.code === 'MAP_STAGE_UNKNOWN');
});

test('every stage the pipeline names is a stage it can plan', () => {
  for (const stage of MAP_STAGES) {
    const held = plan({ from: stage, to: stage, promote: true,
      environment: { ASCRYBE_ENABLE_PAID_INFERENCE: '1' } });
    assert.equal(held.length, 1, `${stage} plans as exactly one step`);
    assert.equal(held[0].run, true, `${stage} is runnable when authorized`);
  }
});
