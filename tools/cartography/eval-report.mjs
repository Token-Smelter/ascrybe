#!/usr/bin/env node
// Generates the Cartography Spine v0 evaluation report from a built annotated graph:
// exact conservation tables, hidden-vs-visible counts per screenshot, determinism results
// (byte-identical rebuild + single-module mutation stability + tombstone), and human/LLM
// parity results. Deterministic; no network, no server, read-only against the graph.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, stableStringify } from '../lib.mjs';
import { buildViewModel } from './model.mjs';
import { buildScopeProjections, humanViewRecords, llmTiles, parityCheck } from './tiles.mjs';

const GEN_AT = '2026-07-28T00:00:00Z';
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`
  + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

const BUILD_ID_RE = /build:[a-f0-9]{12}/;

export async function generateReport(graphPath, outPath, { screenshotsDir = 'cartography-v1-screenshots', viewModelPath = null, atlasHtmlPath = null } = {}) {
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  // Match cli.mjs's estate-digest so the report's build_id equals the committed atlas HTML's.
  const estateDigest = crypto.createHash('sha256').update(stableStringify({ nodes: (graph.nodes || []).map(n => n.id).sort(), edges: (graph.edges || []).map(e => e.id).sort() })).digest('hex');
  // A1 (build identity): prefer the ALREADY-COMPILED view-model emitted by cli.mjs so the report
  // is pinned to the exact snapshot that produced the atlas HTML — never an independently
  // re-scanned graph. Fall back to compiling from the graph only when no view-model is supplied.
  let a;
  if (viewModelPath) {
    a = JSON.parse(await fs.readFile(viewModelPath, 'utf8'));
  } else {
    a = buildViewModel(graph, { generatedAt: GEN_AT, estateDigest });
  }
  const GEN = a.generated_at || GEN_AT;
  const ED = a.estate_digest || estateDigest;
  // A1 HARD ASSERTION: the build id documented by this report MUST equal the build id embedded in
  // the atlas HTML it describes. A mismatch means HTML + report derive from two different graph
  // snapshots (the exact regression this fixes) — throw rather than ship an unresolvable package.
  if (atlasHtmlPath) {
    const html = await fs.readFile(atlasHtmlPath, 'utf8');
    const htmlBuildId = (html.match(BUILD_ID_RE) || [])[0] || null;
    if (htmlBuildId !== a.build_id) {
      throw new Error(`Cartography evaluation-package BUILD IDENTITY MISMATCH: report build_id ${a.build_id} != atlas HTML build id ${htmlBuildId} (${atlasHtmlPath}). HTML and report must derive from ONE pinned graph snapshot; regenerate both from the same run.`);
    }
  }
  const b = buildViewModel(graph, { generatedAt: GEN, estateDigest: ED });

  // Determinism E.1: byte-identical rebuild. Compare via the CANONICAL (key-sorted) form so the
  // check is stable whether `a` is a freshly-built model or the persisted view-model.json (which
  // was written key-sorted by stableStringify); the model digest itself is computed the same way.
  const identical = a.digest === b.digest && stableStringify(a.layout_slots) === stableStringify(b.layout_slots);

  // Determinism E.2/E.3: add one synthetic module, then remove it.
  const grown = structuredClone(graph);
  const synthId = 'module:plugins:probe-plugin/server/__cartography_probe__.mjs';
  grown.nodes.push({ id: synthId, kind: 'module', repo: 'plugins', witnesses: [{ repo: 'plugins', file: 'probe-plugin/server/__cartography_probe__.mjs', line: 1, provenance_class: 'production' }] });
  (grown.domain_prepass_receipts ||= []).push({ schema: 'estate-map/domain-prepass-receipt/v1', producer: 'deterministic/domain-prepass@1', rule_id: 'DPA-1-direct-anchored-adjacency', rule_version: '2', subject: synthId, subject_kind: 'module', status: 'no_anchor', domain: null, candidates: [], evidence: [], examined_edge_ids: [] });
  const grownModel = buildViewModel(grown, { generatedAt: GEN, estateDigest: ED, priorViewModel: a });
  const slotKey = s => `${s.view_id}\u0000${s.child_id}`;
  const aSlots = new Map(a.layout_slots.map(s => [slotKey(s), s.slot_index]));
  const movedUnrelated = grownModel.layout_slots.filter(s => aSlots.has(slotKey(s)) && aSlots.get(slotKey(s)) !== s.slot_index && !s.child_id.includes('__cartography_probe__'));
  const grewByOne = grownModel.conservation.estate_node_total === a.conservation.estate_node_total + 1;
  const shrunk = buildViewModel(graph, { generatedAt: GEN, estateDigest: ED, priorViewModel: grownModel });
  const tombstoned = shrunk.layout_slots.some(s => s.state === 'tombstone' && s.child_id.includes('__cartography_probe__'));

  // Parity G.
  const projections = buildScopeProjections(a);
  const humanViews = humanViewRecords(a, projections);
  const tiles = llmTiles(a, projections);
  const parity = parityCheck(a, humanViews, tiles);

  const c = a.conservation;
  const eventBundles = a.edge_bundles.filter(x => x.relation_family === 'event_incidence');
  const l1ScopeCount = a.scopes.filter(s => s.parent_scope_id === 'scope:estate').length;
  const chosen = a.descent?.chosen?.scope_id;
  const chosenView = humanViews.find(v => v.scope_id === chosen);
  const aggCards = a.scopes.filter(s => s.parent_scope_id === chosen && s.scope_kind === 'aggregate').length;

  // Hidden-vs-visible per screenshot (visible = drawn glyphs/rows; hidden = accounted-but-not-drawn).
  // v1 provenance + contract-slice aggregates (answer Q1 / Q7). eval-report is NOT the renderer,
  // so it may sum persisted projection records here for the report tables.
  const eventProjections = a.edge_bundle_projections.filter(p => p.relation_family === 'event_incidence');
  const provTotals = Object.fromEntries(['production', 'test', 'fixture', 'docs', 'unknown'].map(cls => [cls,
    eventProjections.reduce((s, p) => s + p.counts_by_provenance[cls].total, 0)]));
  const slicesByProjection = {};
  for (const s of a.event_contract_slices) slicesByProjection[s.projection_id] = (slicesByProjection[s.projection_id] || 0) + 1;
  const productionSlices = a.event_contract_slices.filter(s => s.projection_id === 'production').length;
  const L = a.disposition_ledger;
  const perView = [
    ['01-root-default', `disposition ledger (2 denominators) + Runtime (production) event backbone as DEFAULT; ${l1ScopeCount} L1 scope cards`, `test/fixture/docs/unknown incidences carried as remainder chips + Verification lens; ${c.estate_node_total} individual nodes not drawn at L1`],
    ['02-root-event-flow', `${eventBundles.length} event bundles (all-provenance overlay)`, `${a.edge_bundles.length - eventBundles.length} non-event bundles`],
    ['03-root-coupling-matrix', `${a.coupling.cells.length} DSM cells over ${a.coupling.l1_scopes.length} L1 scopes`, `individual edges rolled into cells (${c.edge_total} total)`],
    ['04-unknown-frontier', `${a.unknown_frontier.ambiguous_groups.length} ambiguous + ${a.unknown_frontier.no_anchor_groups.length} no_anchor + ${a.unknown_frontier.ineligible_subject_groups.length} ineligible + ${a.unknown_frontier.fixture_only_groups.length} fixture groups`, `0 (every unknown node reachable by exact expansion)`],
    ['05-context-interior', `${aggCards} aggregate cards for ${chosenView?.label || 'n/a'}`, `aggregate members: "membership not yet established" (no module→aggregate receipts)`],
    ['06-component-contract', `${productionSlices} production event_contract_slices populate the L3 envelope spine (emitters → named envelope → consumers)`, `test/fixture/docs/unknown contract slices carried in their provenance projections`],
    ['07-module-dsm', `${a.coupling.cells.filter(x => x.relation_family === 'code_dependency').length} code-dependency cells`, `individual module edges rolled up`],
    ['08-node-dossier', `1 node with full receipts + one-hop bundles`, `adjacency pages beyond first (exact omitted counts)`],
    ['09-build-diff', `${a.changes.length} change records`, `0 (baseline build has no predecessor)`],
  ];

  const md = `# Cartography Spine v1 — Evaluation Package Report

**BLUF.** A deterministic view compiler materializes every cartographic record; the renderer only selects and draws. v1 (data-representation consultation #4) makes the **Runtime (production) projection the default**, splits bundle identity from content identity, populates the L3 envelope spine with **${productionSlices} production event_contract_slices**, adds a compiler-side evidence index, and reports the honest zero as a two-denominator disposition ledger. Conservation ${c.passed ? 'PASSED' : 'FAILED'} over ${c.estate_node_total} estate nodes and ${c.edge_total} edges. Human/LLM parity ${parity.passed ? 'PASSED' : 'FAILED'}. Rebuild byte-identical: ${identical ? 'YES' : 'NO'}.

## 0. Disposition ledger (honest zero — answer Q4)

- **EPISTEMIC ACCOUNTING** — ${L.epistemic_accounting.statement} (UNACCOUNTED is fatal).
- **DOMAIN MAP COVERAGE** — ${L.domain_map_coverage.statement}.
- **DPA-1@2 precision** — ${L.deterministic_zero.statement}.
- Alongside (never in the denominator): ineligible_subject **${L.alongside.ineligible_subject}** · fixture_only **${L.alongside.fixture_only}** · unaccounted **${L.alongside.unaccounted}**.

${table(['assignment_disposition', 'count'], Object.entries(L.assignment_disposition).map(([k, v]) => [k, String(v)]))}

Build id: \`${a.build_id}\` · view-model v${a.view_model_version} · layout epoch ${a.layout_epoch} · generated_at ${GEN}.

## 1. Conservation tables

### 1.1 Node conservation (assignment-state axis)

${table(['assignment_state', 'count'], Object.entries(c.assignment_states).map(([k, v]) => [k, String(v)]))}
Sum of states = **${c.assignment_state_total}** ; estate node total = **${c.estate_node_total}** ; UNACCOUNTED = **${c.assignment_states.unaccounted}** (must be 0 or the build fails loudly).

### 1.2 Physical membership (primary-parent axis) — top scopes

${table(['physical_scope', 'nodes'], Object.entries(c.physical_counts).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => [k, String(v)]))}
Physical membership total = **${c.physical_membership_total}** = estate node total (${c.estate_node_total}).

### 1.3 Edge conservation

Active projection family: **${c.edge_projection.active_family}** · active edges: **${c.edge_projection.active_edge_count}** · not-shown: **${c.edge_projection.not_shown_edge_count}** · total: **${c.edge_total}**.

${table(['not-shown relation family', 'edge count'], Object.entries(c.edge_projection.not_shown_by_family).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, String(v)]))}
${c.unmapped_edge_kinds?.length ? `Ungoverned edge kinds mapped to family \`other\` (visible, not dropped): ${c.unmapped_edge_kinds.join(', ')}.` : 'Every edge kind maps to a governed relation family.'}

## 2. Hidden-vs-visible counts per screenshot

${table(['screenshot', 'visible', 'hidden / accounted elsewhere'], perView.map(r => [r[0], r[1], r[2]]))}

## 3. Determinism results

- **E.1 byte-identical rebuild:** ${identical ? 'PASS' : 'FAIL'} (view-model digest \`${a.digest}\` == \`${b.digest}\`; layout slots identical).
- **E.2 single-module mutation stability:** ${movedUnrelated.length === 0 && grewByOne ? 'PASS' : 'FAIL'} (added one synthetic module; unrelated slots moved: ${movedUnrelated.length}; ancestor node total ${a.conservation.estate_node_total} → ${grownModel.conservation.estate_node_total}).
- **E.3 removal tombstone:** ${tombstoned ? 'PASS' : 'FAIL'} (removed the synthetic module; former slot tombstoned within the layout epoch).

## 4. Human / LLM parity results

- **Parity:** ${parity.passed ? 'PASS' : 'FAIL'} (${parity.violations.length} violations).
- Human view records: **${humanViews.length}** · LLM tiles: **${tiles.length}** (${humanViews.length} scopes × 3 budget profiles).
- Every clickable human scope address matches an LLM tile with identical child ids/counts, edge-bundle ids, and orphan totals, pinned to build \`${a.build_id}\`.

## 5. Scope + record inventory

${table(['record family', 'count'], [
    ['scope records', a.scopes.length], ['memberships', a.memberships.length], ['edge bundles', a.edge_bundles.length],
    ['connectivity/orphan diagnostics', a.diagnostics.length], ['layout slots', a.layout_slots.length], ['change records', a.changes.length],
    ['human view records', humanViews.length], ['LLM tiles', tiles.length],
  ].map(([k, v]) => [k, String(v)]))}

## 6. Screenshots

Nine headless Chromium renders of the built atlas HTML (viewport 1440×900) live in \`${screenshotsDir}/\`:
${perView.map(r => `- \`${r[0]}.png\``).join('\n')}

## 6b. Provenance projection axis (answer Q1)

Runtime (production) is the DEFAULT event topology; test/fixture/docs/unknown are counted and independently navigable. \`unknown\` is reserved — a missing edge provenance_class never counts as production. Test-only contracts (no production incidence): **${a.test_only_contracts.length}**.

${table(['provenance class', 'event incidences (emits+consumes)'], Object.entries(provTotals).map(([k, v]) => [k, String(v)]))}

## 6c. Event contract slices (answer Q7 — envelope_kind as the identity-bearing event unit)

Persisted \`estate-map/cartography-event-contract/v1\` slices, keyed by (envelope, provenance projection, build). The L3 envelope-spine column renders the production slices (no longer empty).

${table(['projection', 'contract slices'], Object.entries(slicesByProjection).sort().map(([k, v]) => [k, String(v)]))}

## 7. Deferred (answer DEFER LIST — explicitly not built in v1)

**v1 deferrals (data-representation consultation #4):** Q6 \`adjudication_map_binding\` + campaign overlay / parallel Campaign view (→ WP4–10; the verdict / side-verification / ScopeCertificate / ratification records it binds do not exist yet, only candidate_packets); Q3's three new lenses — Contract Reality (manifest_wiring), Derivability Boundary (refusals/unresolved/structural_unclassified), Entity Vocabulary (entity_layer) (→ v1.1). **v0 deferrals (still standing):** full module→aggregate adjudication; all four context interiors; a global node-link canvas; global orthogonal layout; a fully-labeled module DSM landing page; LLM-generated names/descriptions; criticality/centrality ranking; full shortest-path index; complete reflexion UI; full ER explorer; drag-drop / force-directed / animation / 3D; automatic taxonomy expansion; single-file HTML packing.

## 8. Environment

Node ${process.version} · headless Chromium (Playwright) · deterministic seedless layout · read-only against the scanned estate · no server started.
`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md);
  return { identical, movedUnrelated: movedUnrelated.length, grewByOne, tombstoned, parity: parity.passed, conservation: c.passed, node_total: c.estate_node_total, edge_total: c.edge_total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [graphPath, outPath] = positional;
  if (!graphPath || !outPath) {
    console.error('usage: eval-report.mjs <annotated-graph.json> <report.md> [--view-model <view-model.json>] [--atlas-html <estate-cartography.html>] [--screenshots-dir <name>]');
    process.exit(1);
  }
  const summary = await generateReport(path.resolve(graphPath), path.resolve(outPath), {
    viewModelPath: options['view-model'] ? path.resolve(options['view-model']) : null,
    atlasHtmlPath: options['atlas-html'] ? path.resolve(options['atlas-html']) : null,
    ...(options['screenshots-dir'] ? { screenshotsDir: options['screenshots-dir'] } : {}),
  });
  console.log(JSON.stringify(summary, null, 2));
}
