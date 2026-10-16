// Reads the private artifacts one ontology view is made of. Every path comes from the caller; nothing about an estate, a model or a
// category is fixed here. Shared by the standalone candidate view and by the dashboard that embeds the explorer.
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileSummary, reconcileViewModel } from './reconcile-summary.mjs';

// Calls and cost come from the journals themselves: one completed request counts once, whatever order the runs happened in.
export function journalCalls(paths) {
  const done = new Map(), models = new Set(), failed = [];
  for (const path of paths.filter(existsSync)) for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    if (e.state === 'completed' && !done.has(e.request_digest)) { done.set(e.request_digest, e); models.add(e.response?.model ?? 'unknown'); }
    if (e.state === 'failed' && e.usage) failed.push(e);
  }
  const rows = [...done.values()], byStage = {};
  for (const e of rows) { const s = byStage[e.stage] ??= { calls: 0, cost_usd: 0 }; s.calls += 1; s.cost_usd += e.response?.usage?.cost?.total ?? 0; }
  const cost = e => e.response?.usage?.cost?.total ?? 0;
  return { completed_calls: rows.length, cost_usd: rows.reduce((n, e) => n + cost(e), 0), unreadable_answers: failed.length,
    unreadable_answers_cost_usd: failed.reduce((n, e) => n + (e.usage?.cost?.total ?? 0), 0), calls_with_unknown_cost: rows.filter(e => e.response?.usage?.cost?.total == null).length,
    models: [...models], by_stage: byStage, cost_note: 'API-price equivalent from route usage, not a bill. Account allocation is unverified.' };
}

const json = async path => JSON.parse(await readFile(path, 'utf8'));

// `options` uses the same keys as the `ontology view` flags: generation, estate-dir, inventory-dir, manifest, reconcile-dir,
// base-generation, predicate-mapping.
export async function loadViewInputs(options) {
  const generation = await json(options.generation);
  const estate = options['estate-dir'] ? await (async () => {
    const dir = options['estate-dir'], inventoryDir = options['inventory-dir'];
    return { coverage: await json(join(dir, 'estate-coverage.json')), domains: await json(join(dir, 'estate-domains.json')),
      diagnostics: existsSync(join(dir, 'estate-diagnostics.json')) ? await json(join(dir, 'estate-diagnostics.json')) : null,
      manifest: options.manifest ? await json(options.manifest) : null,
      inventory: inventoryDir ? await json(join(inventoryDir, 'inventory-summary.json')) : null };
  })() : null;
  const reconcileDir = options['reconcile-dir'];
  const reconcile = reconcileDir ? await (async () => {
    const reconciliation = await json(join(reconcileDir, 'main-reconciliation.json'));
    const traces = existsSync(join(reconcileDir, 'handoff-traces.json')) ? await json(join(reconcileDir, 'handoff-traces.json')) : [];
    const baseGeneration = options['base-generation'] ? await json(options['base-generation']) : generation;
    const secondaryDomains = estate?.domains ?? await json(join(options['estate-dir'], 'estate-domains.json'));
    const summary = reconcileSummary({ generation: baseGeneration, secondaryDomains, reconciliation });
    return reconcileViewModel({ generation: baseGeneration, reconciliation, summary, traces,
      calls: journalCalls([join(reconcileDir, 'clusters3/reconcile-journal.jsonl'), join(reconcileDir, 'paths/reconcile-journal.jsonl')]) });
  })() : null;
  const predicates = options['predicate-mapping'] ? await json(options['predicate-mapping']) : null;
  if (predicates && predicates.base_generation_id !== generation.generation_id) throw new Error('the predicate mapping was made for a different generation');
  return { generation, estate, reconcile, predicates };
}
