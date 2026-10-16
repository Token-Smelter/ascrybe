// Cartography Spine v0 — human view records + LLM map tiles, from ONE shared view-model.
//
// Answer Q4 (mandatory): the human HTML view and the LLM projection are generated from the
// same persisted view-model. This module derives, per scope, ONE projection object; both the
// human view record and the LLM tile read the SAME fields. Parity (test G) is therefore
// structural, not a coincidence to be re-verified by hand: child ids/counts, edge-bundle
// ids/counts, and orphan totals are literally the same source values, pinned to one build_id.

import { BUDGET_PROFILES, TOKENIZER_ID, CONNECTIVITY_PROJECTIONS, ASSIGNMENT_STATES } from './canon.mjs';

const byId = (a, b) => String(a).localeCompare(String(b));
// THREE ADDRESS LAYERS (answer Q5): raw record id (scope_id) — exact identity; logical view
// address — build-independent navigation identity; build-pinned address — one estate digest.
const scopeAddress = (buildId, scopeId) => `estate://cartography@${buildId}/scope/${scopeId}`;
const scopeLogicalAddress = scopeId => `estate://cartography/scope/${scopeId}`;

// One projection per scope, shared by the human view record and the LLM tile.
export function buildScopeProjections(model) {
  const buildId = model.build_id;
  const membersByScope = new Map();
  for (const m of model.memberships) {
    const list = membersByScope.get(m.primary_scope_id) || []; list.push(m); membersByScope.set(m.primary_scope_id, list);
  }
  const semanticByScope = new Map();
  for (const m of model.memberships) {
    if (!m.semantic_scope_id) continue;
    const list = semanticByScope.get(m.semantic_scope_id) || []; list.push(m); semanticByScope.set(m.semantic_scope_id, list);
  }
  const diagByScope = new Map();
  for (const d of model.diagnostics) { const list = diagByScope.get(d.scope_id) || []; list.push(d); diagByScope.set(d.scope_id, list); }
  const bundlesBySource = new Map();
  const bundlesByTarget = new Map();
  for (const b of model.edge_bundles) {
    const s = bundlesBySource.get(b.source_scope_id) || []; s.push(b); bundlesBySource.set(b.source_scope_id, s);
    const t = bundlesByTarget.get(b.target_scope_id) || []; t.push(b); bundlesByTarget.set(b.target_scope_id, t);
  }

  const projections = new Map();
  for (const scope of model.scopes.slice().sort((a, b) => byId(a.scope_id, b.scope_id))) {
    const physicalMembers = (membersByScope.get(scope.scope_id) || []).slice().sort((a, b) => byId(a.node_id, b.node_id));
    const semanticMembers = (semanticByScope.get(scope.scope_id) || []).slice().sort((a, b) => byId(a.node_id, b.node_id));
    const members = scope.lens === 'semantic' ? semanticMembers : physicalMembers;

    const assignmentBreakdown = Object.fromEntries(ASSIGNMENT_STATES.map(s => [s, members.filter(m => m.assignment_state === s).length]));
    const children = scope.child_scope_ids.slice().sort(byId).map(childId => {
      const child = model.scopes.find(s => s.scope_id === childId);
      const childMembers = (child?.lens === 'semantic' ? semanticByScope : membersByScope).get(childId) || [];
      return { child_scope_id: childId, child_view_address: scopeAddress(buildId, childId), node_count: childMembers.length,
        scope_kind: child?.scope_kind || null, membership_basis: child?.membership_basis || null };
    });

    const outbound = (bundlesBySource.get(scope.scope_id) || []).slice().sort((a, b) => byId(a.bundle_id, b.bundle_id))
      .map(b => ({ bundle_id: b.bundle_id, target_scope_id: b.target_scope_id, relation_family: b.relation_family, exact_edge_count: b.exact_edge_count, expansion_address: b.expansion_address }));
    const inbound = (bundlesByTarget.get(scope.scope_id) || []).slice().sort((a, b) => byId(a.bundle_id, b.bundle_id))
      .map(b => ({ bundle_id: b.bundle_id, source_scope_id: b.source_scope_id, relation_family: b.relation_family, exact_edge_count: b.exact_edge_count, expansion_address: b.expansion_address }));

    const orphanByProjection = Object.fromEntries(CONNECTIVITY_PROJECTIONS.map(p => {
      const d = (diagByScope.get(scope.scope_id) || []).find(x => x.projection_id === p.id);
      return [p.id, { orphan_count: d?.orphan_count ?? 0, connected_components: d?.connected_components ?? 0, node_count: d?.node_count ?? members.length }];
    }));

    projections.set(scope.scope_id, {
      view_address: scopeAddress(buildId, scope.scope_id),
      logical_address: scopeLogicalAddress(scope.scope_id),
      raw_id: scope.scope_id,
      build_id: buildId,
      estate_digest: model.estate_digest,
      view_model_version: model.view_model_version,
      layout_epoch: model.layout_epoch,
      scope: { scope_id: scope.scope_id, scope_kind: scope.scope_kind, label: scope.label, lens: scope.lens,
        parent_scope_id: scope.parent_scope_id, membership_basis: scope.membership_basis, membership_predicate: scope.membership_predicate },
      // aggregate scopes with no membership data say so honestly (never "0 members").
      membership_status: (scope.scope_kind === 'aggregate' && members.length === 0) ? 'membership not yet established' : 'established',
      node_count: members.length,
      member_node_ids: members.map(m => m.node_id),
      assignment_breakdown: assignmentBreakdown,
      child_scope_ids: children.map(c => c.child_scope_id),
      children,
      edge_bundle_ids_out: outbound.map(b => b.bundle_id),
      edge_bundle_ids_in: inbound.map(b => b.bundle_id),
      outbound_bundles: outbound,
      inbound_bundles: inbound,
      orphans: orphanByProjection,
      unknowns: {
        ambiguous_count: assignmentBreakdown.ambiguous || 0,
        no_anchor_count: assignmentBreakdown.no_anchor || 0,
        ineligible_subject_count: assignmentBreakdown.ineligible_subject || 0,
        fixture_only_count: assignmentBreakdown.fixture_only || 0,
        unaccounted_count: assignmentBreakdown.unaccounted || 0,
      },
    });
  }
  return projections;
}

// Human view records: one per clickable scope, carrying the EXACT scope address the LLM tile
// is keyed by (test G: every clickable human scope carries its exact scope address).
export function humanViewRecords(model, projections) {
  return [...projections.values()].map(p => ({
    view_address: p.view_address, logical_address: p.logical_address, raw_id: p.raw_id,
    build_id: p.build_id, scope_id: p.scope.scope_id, scope_kind: p.scope.scope_kind,
    label: p.scope.label, lens: p.scope.lens, membership_predicate: p.scope.membership_predicate,
    membership_status: p.membership_status, node_count: p.node_count, child_scope_ids: p.child_scope_ids,
    edge_bundle_ids_out: p.edge_bundle_ids_out, edge_bundle_ids_in: p.edge_bundle_ids_in,
    orphans: p.orphans, assignment_breakdown: p.assignment_breakdown, unknowns: p.unknowns,
  })).sort((a, b) => byId(a.scope_id, b.scope_id));
}

const utf8Bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

// One LLM tile per (scope, budget profile). Packing order is deterministic; when a budget cannot
// carry every member row, the tile still states exact totals + omitted counts + continuation
// addresses (answer Q4: no "representative" sampling; "canonical first N by stable address").
export function llmTiles(model, projections) {
  const tiles = [];
  for (const p of [...projections.values()].sort((a, b) => byId(a.scope.scope_id, b.scope.scope_id))) {
    for (const profile of BUDGET_PROFILES) {
      const base = {
        record: 'cartography_tile', view_address: p.view_address,
        // All three address layers explicit on every LLM tile (answer Q5 / AC-ADDRESS-LAYERS).
        address_layers: { raw_id: p.raw_id, logical_address: p.logical_address, build_pinned_address: p.view_address },
        logical_address: p.logical_address, raw_id: p.raw_id,
        build_id: p.build_id, estate_digest: p.estate_digest,
        view_model_version: p.view_model_version, layout_epoch: p.layout_epoch, budget_profile: profile.id,
        tokenizer_id: TOKENIZER_ID, max_utf8_bytes: profile.max_utf8_bytes,
        scope: p.scope, membership_status: p.membership_status, node_count: p.node_count,
        assignment_breakdown: p.assignment_breakdown, unknowns: p.unknowns,
        child_scope_ids: p.child_scope_ids, children: p.children,
        edge_bundle_ids_out: p.edge_bundle_ids_out, edge_bundle_ids_in: p.edge_bundle_ids_in,
        outbound_bundles: p.outbound_bundles, inbound_bundles: p.inbound_bundles, orphans: p.orphans,
      };
      // Fit member node rows within the byte budget; always report exact totals + continuation.
      const rows = [];
      let included = 0;
      for (const nodeId of p.member_node_ids) {
        const candidate = { ...base, node_rows: [...rows, nodeId], node_rows_included: included + 1, node_rows_total: p.member_node_ids.length,
          node_rows_omitted: p.member_node_ids.length - (included + 1), continuation_address: `${p.view_address}/nodes?after=${included + 1}` };
        if (utf8Bytes(candidate) > profile.max_utf8_bytes && included > 0) break;
        rows.push(nodeId); included += 1;
      }
      tiles.push({ ...base, node_rows: rows, node_rows_included: included, node_rows_total: p.member_node_ids.length,
        node_rows_omitted: p.member_node_ids.length - included,
        continuation_address: included < p.member_node_ids.length ? `${p.view_address}/nodes?after=${included}` : null });
    }
  }
  return tiles;
}

// Canonical JSONL: one record per line, stable field ordering (keys sorted), stable address order.
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])])) : value;
export function serializeTilesJsonl(tiles) {
  return tiles
    .slice()
    .sort((a, b) => byId(`${a.view_address}\u0000${a.budget_profile}`, `${b.view_address}\u0000${b.budget_profile}`))
    .map(tile => JSON.stringify(sortKeys(tile))).join('\n') + (tiles.length ? '\n' : '');
}

// Parity check (test G). For every clickable human scope address there is a matching LLM tile
// (one per budget profile) with identical child ids/counts, bundle ids, and orphan totals,
// pinned to the same build_id. Returns { passed, violations }.
export function parityCheck(model, humanViews, tiles) {
  const violations = [];
  const tilesByScope = new Map();
  for (const t of tiles) { const list = tilesByScope.get(t.scope.scope_id) || []; list.push(t); tilesByScope.set(t.scope.scope_id, list); }
  for (const view of humanViews) {
    const matching = tilesByScope.get(view.scope_id) || [];
    if (!matching.length) { violations.push({ scope_id: view.scope_id, code: 'NO_MATCHING_TILE' }); continue; }
    for (const tile of matching) {
      if (tile.build_id !== view.build_id) violations.push({ scope_id: view.scope_id, code: 'BUILD_ID_MISMATCH' });
      if (JSON.stringify(tile.child_scope_ids) !== JSON.stringify(view.child_scope_ids)) violations.push({ scope_id: view.scope_id, code: 'CHILD_IDS_MISMATCH' });
      if (tile.node_count !== view.node_count) violations.push({ scope_id: view.scope_id, code: 'NODE_COUNT_MISMATCH' });
      if (JSON.stringify(tile.edge_bundle_ids_out) !== JSON.stringify(view.edge_bundle_ids_out)) violations.push({ scope_id: view.scope_id, code: 'BUNDLE_OUT_MISMATCH' });
      if (JSON.stringify(tile.edge_bundle_ids_in) !== JSON.stringify(view.edge_bundle_ids_in)) violations.push({ scope_id: view.scope_id, code: 'BUNDLE_IN_MISMATCH' });
      if (JSON.stringify(tile.orphans) !== JSON.stringify(view.orphans)) violations.push({ scope_id: view.scope_id, code: 'ORPHAN_MISMATCH' });
    }
  }
  return { passed: violations.length === 0, violations };
}
