#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.

import fsNative from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from '../readonly-guard.mjs';
import { parseArgs, stableStringify } from '../lib.mjs';
import { buildViewModel, CartographyConservationError } from './model.mjs';
import { buildScopeProjections, humanViewRecords, llmTiles, serializeTilesJsonl, parityCheck } from './tiles.mjs';
import { renderAtlas } from './render.mjs';

const jsonl = records => records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');

export async function runCartographyStage({ graphPath, outDir, priorViewModelPath = null, generatedAt = '2026-07-28T00:00:00Z' }) {
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const estateDigest = crypto.createHash('sha256').update(stableStringify({ nodes: (graph.nodes || []).map(n => n.id).sort(), edges: (graph.edges || []).map(e => e.id).sort() })).digest('hex');
  let priorViewModel = null;
  if (priorViewModelPath) {
    try { priorViewModel = JSON.parse(await fs.readFile(priorViewModelPath, 'utf8')); } catch { priorViewModel = null; }
  }

  const model = buildViewModel(graph, { priorViewModel, generatedAt, estateDigest });
  const projections = buildScopeProjections(model);
  const humanViews = humanViewRecords(model, projections);
  const tiles = llmTiles(model, projections);
  const parity = parityCheck(model, humanViews, tiles);

  await fs.mkdir(outDir, { recursive: true });
  const write = (name, content) => fs.writeFile(path.join(outDir, name), content);
  await Promise.all([
    write('view-model.json', stableStringify(model)),
    write('scopes.jsonl', jsonl(model.scopes)),
    write('memberships.jsonl', jsonl(model.memberships)),
    write('edge-bundles.jsonl', jsonl(model.edge_bundles)),
    write('diagnostics.jsonl', jsonl(model.diagnostics)),
    write('layout.jsonl', jsonl(model.layout_slots)),
    write('changes.jsonl', jsonl(model.changes)),
    write('human-views.jsonl', jsonl(humanViews)),
    write('tiles.jsonl', serializeTilesJsonl(tiles)),
    write('parity.json', stableStringify(parity)),
    write('conservation.json', stableStringify(model.conservation)),
    write('unknown-frontier.json', stableStringify(model.unknown_frontier)),
  ]);

  // HTML is produced LAST — only because the view-model already passed conservation above.
  const html = renderAtlas(model, humanViews);
  await write('estate-cartography.html', html);

  const census = {
    schema: 'estate-map/cartography-census/v1',
    build_id: model.build_id, view_model_digest: model.digest, estate_digest: estateDigest,
    conservation_passed: model.conservation.passed, parity_passed: parity.passed,
    estate_node_total: model.conservation.estate_node_total, edge_total: model.conservation.edge_total,
    assignment_states: model.conservation.assignment_states,
    scope_count: model.scopes.length, edge_bundle_count: model.edge_bundles.length,
    tile_count: tiles.length, human_view_count: humanViews.length,
    descent_context: model.descent?.chosen?.scope_id || null,
  };
  await write('census.json', stableStringify(census));
  return { model, humanViews, tiles, parity, census, outDir, htmlPath: path.join(outDir, 'estate-cartography.html') };
}

const HELP = `Usage: node tools/estate-map/cartography/cli.mjs <estate-graph.annotated.json> --out <dir> [--prior <prior-view-model.json>] [--generated-at <iso>]

Builds the Cartography Spine v0 view-model, human view records, LLM tiles, and the atlas HTML.
Exits non-zero (writing no HTML) when the view-model fails conservation.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0] || !options.out) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    const result = await runCartographyStage({
      graphPath: path.resolve(positional[0]), outDir: path.resolve(options.out),
      priorViewModelPath: options.prior ? path.resolve(options.prior) : null, generatedAt: options['generated-at'],
    });
    console.log(JSON.stringify({ build_id: result.model.build_id, conservation_passed: result.census.conservation_passed, parity_passed: result.parity.passed, nodes: result.census.estate_node_total, edges: result.census.edge_total }, null, 2));
    if (!result.parity.passed) { console.error(`cartography human/LLM parity failed: ${JSON.stringify(result.parity.violations.slice(0, 5))}`); process.exit(1); }
  } catch (error) {
    if (error instanceof CartographyConservationError) {
      // Loud failure: write the failing report next to the out dir for diagnosis, emit no HTML.
      try { await fsNative.mkdir(path.resolve(options.out), { recursive: true }); await fsNative.writeFile(path.join(path.resolve(options.out), 'conservation-failure.json'), stableStringify(error.report)); } catch {}
      console.error(`CARTOGRAPHY CONSERVATION FAILED: ${error.message}`);
      process.exit(2);
    }
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
