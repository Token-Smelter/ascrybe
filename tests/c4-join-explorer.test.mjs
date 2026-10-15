import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildC4JoinExplorerModel, buildC4JoinReceiptExplorerModel, renderC4JoinExplorer } from '../tools/c4-join-explorer.mjs';

const atlas = {
  provenance: { graph_commit_id: 'graph-commit:test', identity_head: 'identity-head:test' },
  statements: [
    { assertion_id: 'assertion:documentary', plane: 'documentary', readable: 'Document declares schema identity', predicate: 'declares',
      sources: [{ document_path: 'design/schema.yaml', line_start: 1, line_end: 1, byte_start: 0, byte_end: 9, evidence_digest: 'digest' }] },
    { assertion_id: 'assertion:code', plane: 'code', readable: 'Parser emitted schema identity', predicate: 'emitted',
      sources: [{ pointer_kind: 'structured_record', repository: 'design', document_path: 'schema.yaml', fact_kind: 'yaml_record', record_id: 'fact:1', exact_record: { kind: 'yaml_record' } }] },
  ],
  referents: [{ referent_id: 'referent:shared', observed_surfaces: ['schema-id'], assertions: [
    { assertion_id: 'assertion:documentary', role: 'object' },
    { assertion_id: 'assertion:code', role: 'identity_candidate' },
  ] }],
};
const identityJoin = {
  batch_receipt: {
    receipt_id: 'identity-candidate-batch-receipt:fixture',
    selection_mode: 'batch', selection_policy: 'exact-basis-component-id-ascending/v1',
    cursor: 0, next_cursor: 2, selected_candidate_count: 2,
    total_candidates: 3, not_evaluated_in_this_batch_count: 1,
  },
  dispositions: { joined: 1, unresolved: 1, cannot_link: 0, terminal_incomplete: 0 },
  joined_by_fact_kind: { yaml_record: 1 },
  join_receipts: [
    { disposition: 'joined', selected_referent_id: 'referent:shared', receipt_id: 'join:1', fact_id: 'fact:1', fact_kind: 'yaml_record',
      basis: { kind: 'parser_backed_schema' }, source_locator: { file: 'schema.yaml', line: 1 }, identity_constraint_ids: ['constraint:1'], documentary_mention_ids: ['mention:1'] },
    { disposition: 'unresolved', selected_referent_id: null, receipt_id: 'join:2', fact_id: 'fact:2', fact_kind: 'yaml_record', reason: 'no exact occurrence',
      basis: { kind: 'parser_backed_schema' }, source_locator: { file: 'schema-v2.yaml', line: 1 } },
  ],
};
const counts = { shared_assertion_neighborhood_nodes: 1 };

test('join explorer requires and exposes both assertion planes for every shared referent', () => {
  const model = buildC4JoinExplorerModel({ atlas_model: atlas, identity_join: identityJoin, graph_counts_by_plane: counts });
  assert.deepEqual({ joins: model.joins.length, documentary: model.joins[0].documentary.length,
    code: model.joins[0].code.length, unresolved: model.unresolved_candidates.length,
    evaluated: model.rendered_scope.evaluated_batch_candidates,
    full_census: model.rendered_scope.full_census_candidates,
    pending: model.rendered_scope.not_evaluated_candidates },
  { joins: 1, documentary: 1, code: 1, unresolved: 1,
    evaluated: 2, full_census: 3, pending: 1 });
});

test('combined receipt alone closes every shared node to exact occurrences on both planes', () => {
  const model = buildC4JoinReceiptExplorerModel({
    graph_commit_id: 'graph-commit:test', graph_counts_by_plane: counts, identity_join: identityJoin,
  });
  assert.deepEqual({ joins: model.joins.length, documentary: model.joins[0].documentary.length,
    code: model.joins[0].code.length }, { joins: 1, documentary: 1, code: 1 });
});

test('rendered local explorer distinguishes planes and keeps refused candidates visible', () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'join-explorer-'));
  try {
    const rendered = renderC4JoinExplorer({ atlas_model: atlas, identity_join: identityJoin,
      graph_counts_by_plane: counts, output_dir: root });
    const html = readFileSync(rendered.page, 'utf8');
    assert.match(html, /Documentary assertions/);
    assert.match(html, /Code-grounded assertions/);
    assert.match(html, /Cross-plane join/);
    assert.match(html, /Refused candidates remain visible/);
    assert.match(html, /Evaluation batch/);
    assert.match(html, /3<\/strong> full census/);
    assert.match(html, /1<\/strong> pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
