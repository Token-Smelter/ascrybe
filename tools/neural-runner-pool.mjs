
/** Coerce a runner-pool argument to a non-empty array of runners. Accepts an array (used as-is) or a
 *  single runner (wrapped as a pool of one — the exact N=1 sequential case). Throws if neither yields
 *  a usable runner. */
export function normalizeRunnerPool(runnerPool, singleRunner) {
  const pool = Array.isArray(runnerPool) && runnerPool.length
    ? runnerPool.slice()
    : (singleRunner ? [singleRunner] : []);
  if (!pool.length) throw new Error('a ModelRunner pool requires at least one runner (pass runnerPool[] or runner)');
  for (const runner of pool) {
    if (!runner || typeof runner.complete !== 'function') throw new Error('every pooled entry must be a ModelRunner exposing complete()');
  }
  return pool;
}

/**
 * Map `items` through `processItem(item, runner, index)` over a pool of runners, at most
 * `pool.length` in flight. Returns `{ results, maxInFlight }` where `results[i]` is the resolved value
 * for `items[i]` in INPUT order (not completion order) and `maxInFlight` is the observed peak number
 * of concurrently-executing `processItem` calls (a mock-transport test asserts this equals N).
 *
 * A pool of one runner runs items strictly one-after-another (sequential) — the N=1 regression path.
 */
export async function mapWithRunnerPool(items, pool, processItem) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let stopped = false;
  let firstError = null;
  const worker = async runner => {
    while (true) {
      if (stopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        results[index] = await processItem(list[index], runner, index);
      } catch (error) {
        if (!firstError) firstError = error;
        stopped = true;
        return;
      } finally {
        inFlight -= 1;
      }
    }
  };
  // One long-lived worker per runner; each drains the shared index. A worker whose runner never gets
  // an item (pool larger than item count) simply returns without ever calling the runner — so an idle
  // pooled RPC runner never spawns its warm process (lazy spawn on first complete()).
  // Stop assigning new units after the first failure, but wait for every already-in-flight unit to
  // finish its completion receipt before surfacing the error. This prevents paid fanout from
  // continuing after a hard failure and prevents callers from closing the journal under active puts.
  await Promise.all(pool.map(runner => worker(runner)));
  if (firstError) throw firstError;
  return { results, maxInFlight };
}
