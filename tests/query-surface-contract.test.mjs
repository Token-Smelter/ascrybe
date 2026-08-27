import test from 'node:test';
import assert from 'node:assert/strict';
import { ESTATE_QUERY_CONTRACT, ESTATE_QUERY_CONTRACT_VERSION, querySurfaceContract } from '../tools/estate-graph-query.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the contract digest changes when the command surface changes, and not otherwise', () => {
  const held = querySurfaceContract();
  // Declaration order and argument order are not the contract; the set is.
  assert.equal(querySurfaceContract().digest, held.digest);
  assert.notEqual(held.digest, '');
  const drifted = { ...ESTATE_QUERY_CONTRACT };
  assert.equal(Object.keys(drifted).length, Object.keys(held.commands).length);
  assert.equal(held.contract, ESTATE_QUERY_CONTRACT_VERSION);
  // Estate scoping is context, not contract: two estates share one surface.
  assert.equal(querySurfaceContract({ estate: 'sw' }).digest, querySurfaceContract({ estate: 'other' }).digest);
});

test('the contract lists exactly the commands the CLI dispatches', () => {
  const source = readFileSync(new URL('../tools/estate-graph-query.mjs', import.meta.url), 'utf8');
  const dispatched = [...source.matchAll(/if \(command === '([a-z-]+)'\)/gu)].map(match => match[1])
    .filter(command => command !== 'contract');
  assert.deepEqual(dispatched.sort(), Object.keys(ESTATE_QUERY_CONTRACT).sort());
});

test('the packaged skill declares the contract this build implements', () => {
  const skill = readFileSync(new URL('../skills/ascrybe/SKILL.md', import.meta.url), 'utf8');
  // A skill is a copy; stating which surface it documents is what makes the copy checkable.
  assert.equal(skill.includes(ESTATE_QUERY_CONTRACT_VERSION), true,
    `skills/ascrybe/SKILL.md must declare surface_contract: ${ESTATE_QUERY_CONTRACT_VERSION}`);
});
