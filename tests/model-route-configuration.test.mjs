import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifierRoles, callModelOnce } from '../tools/campaign.mjs';
import { requireModel } from '../tools/neural-model-runner.mjs';

for (const route of [undefined, '', '<provider/model>']) {
  test(`an unset or placeholder route is refused before dispatch: ${route}`, async () => {
    await assert.rejects(callModelOnce({ model: route, prompt: 'fixture', runner: () => {
      throw new Error('must not dispatch');
    } }), { code: 'ASCRYBE_MODEL_UNCONFIGURED' });
  });
}

test('a campaign cannot construct an ambient verifier roster', () => {
  assert.throws(() => buildVerifierRoles(), { code: 'ASCRYBE_MODEL_UNCONFIGURED' });
});

test('explicit invented routes keep separate verifier families', () => {
  assert.deepEqual(buildVerifierRoles('fixture-a/model', 'fixture-b/model').map(role => role.family),
    ['fixture-a', 'fixture-b', 'fixture-a', 'fixture-b']);
});

test('a configured route survives without rewriting its provider', () => {
  assert.equal(requireModel('example-provider/example-model'), 'example-provider/example-model');
});
