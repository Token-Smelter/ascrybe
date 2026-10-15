import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWithRunnerPool } from '../tools/neural-runner-pool.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('pool stops launching new units after first failure and waits for in-flight custody', async () => {
  const runners = [{ id: 0 }, { id: 1 }, { id: 2 }];
  const started = [];
  const completed = [];
  let inFlightFinished = false;
  await assert.rejects(
    mapWithRunnerPool([0, 1, 2, 3, 4, 5], runners, async item => {
      started.push(item);
      if (item === 0) {
        await sleep(5);
        throw new Error('hard failure');
      }
      await sleep(20);
      completed.push(item);
      inFlightFinished = true;
      return item;
    }),
    /hard failure/,
  );
  assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 2], 'only units already assigned at failure may run');
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2]);
  assert.equal(inFlightFinished, true, 'rejection waits until in-flight completion receipts can finish');
});
