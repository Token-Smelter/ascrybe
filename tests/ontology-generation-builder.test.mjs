import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOntologyGeneration } from '../tools/ontology/generation-builder.mjs';

// Every name below is invented (an example widget-tracking estate); nothing here describes a
// mapped repository (AGENTS.md / docs/before-a-pr.md).
function fixture({ shuffleEdges = false, sourceDigest = 'a'.repeat(40), projectionId = 'estate-projection:fixture-a', contentDigest = 'b'.repeat(64), httpClientLine = 55 } = {}) {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'ontology-gen-'));
  const nodes = [
    { node_id: 'referent:namespace:widget-router', kind: 'Module', label: 'widget-router', plane: 'entity', record_digest: 'n1'.padEnd(64, '0'),
      properties: { namespace: 'example-estate/src/widgets/router.mjs' } },
    { node_id: 'referent:namespace:widget-idle', kind: 'Module', label: 'widget-idle', plane: 'entity', record_digest: 'n2'.padEnd(64, '0'),
      properties: { namespace: 'example-estate/src/widgets/idle.mjs' } },
    {
      // `document_path` is deliberately REPO-RELATIVE here, matching the real projection: it is
      // NOT the same string as an entity's `namespace` (which is repo-QUALIFIED). subjects.mjs must
      // key ownership by `${repository}/${file}`, never by `document_path` alone -- a real bug this
      // fixture caught only once it stopped (wrongly) pre-qualifying document_path itself.
      node_id: 'extracted-fact:widget-router-http', kind: 'HttpClientCall', label: 'call', plane: 'unclassified', record_digest: 'n9'.padEnd(64, '0'),
      properties: { repository: 'example-estate', file: 'src/widgets/router.mjs',
        document_path: 'src/widgets/router.mjs', line: httpClientLine },
    },
    { node_id: 'capability:widget-service', kind: 'Capability', label: 'widget-service', plane: 'entity', record_digest: 'n3'.padEnd(64, '0') },
    { node_id: 'route:widgets-index', kind: 'Route', label: '/widgets', plane: 'entity', record_digest: 'n4'.padEnd(64, '0') },
    {
      node_id: 'estate-claim:widget-claim-ok', kind: 'Claim', label: 'widget claim', plane: 'documentary', record_digest: 'n5'.padEnd(64, '0'),
      properties: { claim_kind: 'current_capability', source_status: 'current', decision_status: 'implemented',
        source_path: 'design/widgets.md', source_line: 12, proof_plan_json: JSON.stringify({ obligations: [{ kind: 'code_symbol_declared', symbol: 'widgetRouter' }] }) },
    },
    {
      node_id: 'estate-claim:widget-claim-orphan', kind: 'Claim', label: 'orphan claim', plane: 'documentary', record_digest: 'n6'.padEnd(64, '0'),
      properties: { claim_kind: 'current_capability', source_status: 'current', decision_status: 'none',
        source_path: 'design/widgets.md', source_line: 40, proof_plan_json: JSON.stringify({ obligations: [{ kind: 'open_question', question: 'does it idle?' }] }) },
    },
    {
      node_id: 'claim-adjudication-receipt:widget-claim-ok', kind: 'AdjudicationReceipt', label: 'receipt', plane: 'adjudication', record_digest: 'n7'.padEnd(64, '0'),
      properties: { claim_id: 'estate-claim:widget-claim-ok', verdict: 'supported', realization: 'partial', supporting_evidence_tiers_json: JSON.stringify(['declared']) },
    },
    {
      node_id: 'claim-obligation-result:widget-claim-ok-1', kind: 'ObligationResult', label: 'result', plane: 'adjudication', record_digest: 'n8'.padEnd(64, '0'),
      properties: { claim_id: 'estate-claim:widget-claim-ok', obligation_kind: 'code_symbol_declared', state: 'supported' },
    },
  ];
  const edges = [
    { edge_id: 'code-dependency-relation:1', relation: 'provides_capability', from: 'referent:namespace:widget-router', to: 'capability:widget-service',
      role: 'unclassified', properties: { witnesses: [{ repo: 'example-estate', file: 'src/widgets/router.mjs', line: 10 }] }, record_digest: 'e1'.padEnd(64, '0') },
    { edge_id: 'code-dependency-relation:2', relation: 'exposes_route', from: 'referent:namespace:widget-router', to: 'route:widgets-index',
      role: 'structural', properties: {}, record_digest: 'e2'.padEnd(64, '0') },
    // Dangling on purpose: no node named 'envelope:missing-target' exists in this fixture.
    { edge_id: 'code-dependency-relation:3', relation: 'consumes', from: 'referent:namespace:widget-router', to: 'envelope:missing-target',
      role: 'flow', properties: {}, record_digest: 'e3'.padEnd(64, '0') },
    // Operator decision, 2026-09-26: an architectural role now requires a production witness, so
    // this edge -- the fixture's only route-handler `member` case -- needs one, or it downgrades
    // to not_member/TEST_OR_FIXTURE_ONLY like any other test/fixture-only match.
    { edge_id: 'code-dependency-relation:4', relation: 'registers_route', from: 'referent:namespace:widget-idle', to: 'route:widgets-index',
      role: 'structural', properties: { witnesses: [{ repo: 'example-estate', file: 'src/widgets/idle.mjs', line: 4 }] }, record_digest: 'e4'.padEnd(64, '0') },
    // Test-only match: widget-idle only calls the capability from its OWN test file, never from
    // production code. capability-caller should downgrade this to not_member/TEST_OR_FIXTURE_ONLY,
    // retaining the witness rather than deleting it.
    { edge_id: 'code-dependency-relation:5', relation: 'calls_capability', from: 'referent:namespace:widget-idle', to: 'capability:widget-service',
      role: 'structural', properties: { witnesses: [{ repo: 'example-estate', file: 'test/widgets/idle.test.mjs', line: 20 }] }, record_digest: 'e5'.padEnd(64, '0') },
  ];
  const orderedEdges = shuffleEdges ? [edges[4], edges[3], edges[2], edges[0], edges[1]] : edges;
  const nodesPath = join(root, 'projection-nodes.jsonl');
  const edgesPath = join(root, 'projection-edges.jsonl');
  writeFileSync(nodesPath, nodes.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(edgesPath, orderedEdges.map(row => JSON.stringify(row)).join('\n') + '\n');
  return {
    nodesPath, edgesPath,
    estate: 'example-estate',
    sourceIdentity: { kind: 'single_repository_commit', digest: sourceDigest },
    baseProjection: { projection_id: projectionId, content_digest: contentDigest, claim_map_digest: 'c'.repeat(64), code_graph_digest: 'd'.repeat(64) },
    coverage: { documentary_documents_included: 1, documentary_documents_eligible: 1 },
  };
}

test('buildOntologyGeneration classifies member/not_member/abstain across both schemes and keeps a missing receipt a refusal, not a membership', async () => {
  const held = fixture();
  const result = await buildOntologyGeneration(held);

  const byStableKeyFor = subjectId => stableKey => result.memberships.find(m =>
    m.subject_ref.node_id === subjectId && result.concepts.find(c => c.concept_id === m.concept_id)?.stable_key === stableKey);
  const router = byStableKeyFor('referent:namespace:widget-router');
  const idle = byStableKeyFor('referent:namespace:widget-idle');
  const claim = byStableKeyFor('estate-claim:widget-claim-ok');

  assert.equal(router('capability-provider').outcome, 'member');
  assert.equal(router('capability-provider').confidence, 'certain');
  assert.equal(idle('capability-provider').outcome, 'abstain');

  // CORRECTED: route-handler must fire on registers_route alone, not only exposes_route.
  assert.equal(idle('route-handler').outcome, 'member');
  assert.equal(idle('route-handler').witnesses[0].relation, 'registers_route');

  // CORRECTED: external-http-client had no path to a member outcome at all before owner
  // resolution (HttpClientCall facts are never reached by a structural edge); it now resolves the
  // fact's exact-file owner, discloses the resolution as non-native, and classifies the witness's
  // provenance rather than leaving it undistinguished.
  const httpClient = router('external-http-client');
  assert.equal(httpClient.outcome, 'member');
  assert.equal(httpClient.witnesses[0].resolution, 'file_path_owner_match');
  assert.equal(httpClient.witness_provenance_summary.production, 1);

  assert.equal(claim('documented-current-capability').outcome, 'member');
  assert.equal(claim('documentary-design-rule').outcome, 'not_member');
  assert.equal(claim('partially-realized-claim').outcome, 'member');

  // The orphan claim (no AdjudicationReceipt) is refused for every epistemic-standing concept, and
  // never appears as a membership subject at all -- not even an abstained one.
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].code, 'CLAIM_RECEIPT_MISSING');
  assert.equal(result.refusals[0].subject_ref.node_id, 'estate-claim:widget-claim-orphan');
  assert.equal(result.memberships.some(m => m.subject_ref.node_id === 'estate-claim:widget-claim-orphan'), false);

  // The dangling `consumes` edge still grounds a membership (its own truth value does not depend
  // on the target resolving) but is separately counted as a data-integrity diagnostic.
  assert.equal(result.diagnostics.danglingEdgeTargets, 1);
  // The fixture deliberately mis-marks provides_capability's stored role as 'unclassified', the
  // shape the retained Phase 1 baseline actually has pre-PR-#23; the drift must be measured, not
  // silently inherited.
  assert.ok(Object.keys(result.diagnostics.edgeRoleDrift).some(key => key.startsWith('provides_capability:')));

  // Operator decision, 2026-09-26: an architectural role requires a production witness. widget-idle
  // only calls the capability from its own test file, so capability-caller downgrades to
  // not_member/TEST_OR_FIXTURE_ONLY -- but the witness is RETAINED, not deleted.
  const idleCaller = idle('capability-caller');
  assert.equal(idleCaller.outcome, 'not_member');
  assert.equal(idleCaller.evaluation.result, 'matched_scope_excluded');
  assert.equal(idleCaller.evaluation.reason_code, 'TEST_OR_FIXTURE_ONLY');
  assert.equal(idleCaller.witnesses.length, 1, 'the test-only witness is retained, not deleted');
  assert.equal(idleCaller.witness_provenance_summary.test, 1);
  assert.equal(idleCaller.witness_provenance_summary.production, 0);
});

test('buildOntologyGeneration content_digest is sensitive to membership content even when outcome counts are unchanged (CORRECTED: it used to hash only counts, not artifacts)', async () => {
  const a = await buildOntologyGeneration(fixture({ httpClientLine: 55 }));
  const b = await buildOntologyGeneration(fixture({ httpClientLine: 999 }));
  assert.deepEqual(a.generation.counts, b.generation.counts);
  assert.notEqual(a.generation.artifacts.memberships_digest, b.generation.artifacts.memberships_digest);
  assert.notEqual(a.generation.content_digest, b.generation.content_digest);
});

test('buildOntologyGeneration replays byte-identically regardless of the input files\' line order', async () => {
  const inOrder = await buildOntologyGeneration(fixture({ shuffleEdges: false }));
  const shuffled = await buildOntologyGeneration(fixture({ shuffleEdges: true }));
  assert.equal(inOrder.generation.content_digest, shuffled.generation.content_digest);
  assert.equal(inOrder.generation.artifacts.memberships_digest, shuffled.generation.artifacts.memberships_digest);
});

test('buildOntologyGeneration never blends two evidence contexts: the same subject gets a distinct membership id in each', async () => {
  const baseline = await buildOntologyGeneration(fixture({ sourceDigest: 'a'.repeat(40), projectionId: 'estate-projection:fixture-a' }));
  const target = await buildOntologyGeneration(fixture({ sourceDigest: 'c'.repeat(40), projectionId: 'estate-projection:fixture-b' }));
  assert.notEqual(baseline.evidenceContext.context_id, target.evidenceContext.context_id);
  assert.notEqual(baseline.generation.interpretation_id, target.generation.interpretation_id);
  const findRouterCapability = built => built.memberships.find(m => m.subject_ref.node_id === 'referent:namespace:widget-router'
    && built.concepts.find(c => c.concept_id === m.concept_id)?.stable_key === 'capability-provider');
  assert.notEqual(findRouterCapability(baseline).membership_id, findRouterCapability(target).membership_id);
});
