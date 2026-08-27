#!/usr/bin/env node
// One finite, local-only Phase A conservation and projection exit gate.
// Historical V32 payloads are read from pinned local Git objects; git-ignored run custody is never
// opened, moved, regenerated, or hashed by this command.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClaimProjection, buildGraphCommit, buildMigrationProvenanceReceipt,
  buildSourceStalenessReceipt, verifyClaimProjection, verifyPhaseAExit, verifyStatusDerivation,
  CLAIM_PROJECTION_SCHEMA_VERSION,
} from './claim-projection.mjs';
import { buildArgumentMentionSubstrate, sourceVersionIdForInventory } from './argument-mentions.mjs';
import { backfillCandidateContactLedger, buildPropositionObligationInventory } from './proposition-obligations.mjs';
import { inventoryMarkdown } from './recursive-contracts.mjs';
import { stableStringify } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const producerCommit = 'cc358149b4c6871d6dce56494b414719ba16f66b';
const estateCommit = '90ec8527ca8fa5957dc52e91d25414ff5980e1fd';
const estateCapturedAt = '2026-08-02T11:19:50-07:00';
const corpusDigest = '00453024af3da71ab21d07b23237bab0ce3cc410a09c9b7befaf5fe4bdfc299b';
const expectedClaimPlaneDigest = 'e36a75ddfb082461deac076a8afcfc914d5cd4ca6bf0f9129a6d2657356d2e0f';
const expectedLineagePlaneDigest = '059ded4b712c39b645b6ba4c7b7e0eccd0543de684122a701f2d280863923a57';
const unionPath = 'analysis/current-evidence/V32-CONFIRM-TREATMENT-UNION.json';
const graphPath = 'analysis/current-evidence/V32-CONFIRM-TREATMENT-MAP.json';
const gradePath = 'analysis/current-evidence/V32-CONFIRM-GRADE.json';
const sourceManifestPath = 'analysis/human-domain-projection-package-2026-08-06/evidence/current/wide-context-full-manifest.json';
const materializationId = 'materialization:v32-phase-a-exit-v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 128 * 1024 * 1024, ...options });
}

function gitObject(path, expected) {
  const bytes = git(['show', `${producerCommit}:${path}`]);
  const digest = sha256(bytes);
  if (bytes.length !== expected.bytes || digest !== expected.sha256) {
    fail(`pinned local Git object differs from tracked V32 custody: ${path}`);
  }
  return JSON.parse(bytes);
}

export function estateRoot() {
  const local = join(root, 'estate');
  if (existsSync(local)) return local;
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const held = join(dirname(common), 'estate');
  if (!existsSync(held)) fail('pinned estate checkout is unavailable');
  return held;
}

function lineageFacts(claims, graph) {
  const nodes = new Map(graph.nodes.filter(row => row.kind === 'documentary_claim').map(row => [row.id, row]));
  const findings = new Map(graph.findings.map(row => [row.id, row]));
  return Object.fromEntries(claims.map(claim => {
    const node = nodes.get(claim.id) || fail(`lineage graph lacks claim ${claim.id}`);
    const ids = node.lineage_finding_ids || [];
    return [claim.id, {
      lineage_status: node.lineage_status,
      lineage_finding_ids: ids,
      findings: ids.map(id => findings.get(id) || fail(`lineage graph lacks finding ${id}`)),
    }];
  }));
}

function lineageDigest(claims, facts) {
  const rows = claims.map(claim => ({
    claim_id: claim.id,
    status: facts[claim.id].lineage_status,
    finding_ids: facts[claim.id].lineage_finding_ids,
    sha256: sha256(stableStringify({
      lineage_status: facts[claim.id].lineage_status,
      lineage_finding_ids: facts[claim.id].lineage_finding_ids,
      findings: facts[claim.id].findings,
    })),
  }));
  return sha256(stableStringify(rows));
}

function sourcePlanes(claims, inventories) {
  const sourceVersions = inventories.map(inventory => ({
    source_version_id: sourceVersionIdForInventory(inventory),
    resource_id: `git-path:${inventory.path}`,
    native_version_id: estateCommit,
    captured_at: estateCapturedAt,
    content_digest: inventory.source_digest,
    state: 'current',
  })).sort((a, b) => a.source_version_id.localeCompare(b.source_version_id));
  const byFile = new Map(inventories.map(inventory => [inventory.path, sourceVersionIdForInventory(inventory)]));
  const byId = new Map(sourceVersions.map(row => [row.source_version_id, row]));
  const claimSources = {};
  const migrationReceipts = [];
  for (const claim of claims) {
    const ids = [...new Set((claim.semantic?.support_sets || []).flatMap(set => set.locators || [])
      .map(locator => byFile.get(locator.file) || fail(`claim ${claim.id} cites source outside manifest: ${locator.file}`)))].sort();
    if (!ids.length) fail(`claim ${claim.id} has no source version`);
    claimSources[claim.id] = ids;
    const selected = ids.map(id => byId.get(id)).sort((left, right) => left.captured_at.localeCompare(right.captured_at)
      || left.source_version_id.localeCompare(right.source_version_id))[0];
    migrationReceipts.push(buildMigrationProvenanceReceipt({
      basis_claim_id: claim.id,
      source_version: selected,
      capture_basis: `git-commit-committer-time:${estateCommit}`,
      materialization_id: materializationId,
    }));
  }
  return { sourceVersions, claimSources, migrationReceipts };
}

function assertThrowsCode(action, code) {
  try { action(); }
  catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  fail(`negated fixture did not fail with ${code}`);
}

function rehashProjectionReceipt(receipt) {
  const { receipt_id: _receiptId, ...body } = receipt;
  return { ...body, receipt_id: `claim-projection-receipt:${sha256(stableStringify(body).trim())}` };
}

function runOwnedFalsifiers({ claims, projection, argumentSubstrate, sourceVersions, claimSources, lineage }) {
  const changed = structuredClone(projection);
  changed.documentary_claims[0].evidence_key = 'negated:evidence-key';
  assertThrowsCode(() => verifyClaimProjection({ admitted_claims: claims, projection: changed }), 'CLAIM_BYTES_CHANGED');
  const duplicate = structuredClone(projection);
  duplicate.claim_projection_receipts.push(structuredClone(duplicate.claim_projection_receipts[0]));
  assertThrowsCode(() => verifyClaimProjection({ admitted_claims: claims, projection: duplicate }), 'PROJECTION_RECEIPT_CARDINALITY');

  const favorable = projection.claim_projection_receipts.find(row =>
    ['fully_projected', 'projected_with_literal_argument', 'non_referential_assertion'].includes(row.disposition)
      && row.assertion_ids?.length === 1) || fail('owned disposition falsifiers require a favorable receipt');
  const disappeared = structuredClone(projection);
  const disappearedIndex = disappeared.claim_projection_receipts
    .findIndex(row => row.receipt_id === favorable.receipt_id);
  disappeared.assertions = disappeared.assertions.filter(row => row.assertion_id !== favorable.assertion_ids[0]);
  disappeared.claim_projection_receipts[disappearedIndex].assertion_ids = [];
  disappeared.claim_projection_receipts[disappearedIndex] = rehashProjectionReceipt(
    disappeared.claim_projection_receipts[disappearedIndex]);
  assertThrowsCode(() => verifyClaimProjection({ admitted_claims: claims, projection: disappeared }),
    'DISPOSITION_ASSERTION_CARDINALITY_MISMATCH');

  const unresolved = structuredClone(projection);
  const unresolvedIndex = unresolved.claim_projection_receipts
    .findIndex(row => row.receipt_id === favorable.receipt_id);
  unresolved.claim_projection_receipts[unresolvedIndex].disposition = 'unresolved_argument_mentions';
  unresolved.claim_projection_receipts[unresolvedIndex] = rehashProjectionReceipt(
    unresolved.claim_projection_receipts[unresolvedIndex]);
  const unresolvedAssertion = unresolved.assertions.find(row => row.assertion_id === favorable.assertion_ids[0]);
  unresolvedAssertion.projection_receipt_id = unresolved.claim_projection_receipts[unresolvedIndex].receipt_id;
  assertThrowsCode(() => verifyClaimProjection({ admitted_claims: claims, projection: unresolved }),
    'DISPOSITION_ASSERTION_CARDINALITY_MISMATCH');

  const claim = claims[0];
  const obligations = argumentSubstrate.assertion_argument_obligations.filter(row => row.basis_claim_id === claim.id);
  const obligationIds = new Set(obligations.map(row => row.obligation_id));
  const bindings = argumentSubstrate.argument_binding_coverage_receipts.filter(row => obligationIds.has(row.obligation_id));
  const selectedMentions = new Set(bindings.flatMap(row => row.selected_mention_ids || []));
  const heldSubstrate = {
    ...argumentSubstrate,
    assertion_argument_obligations: obligations,
    argument_binding_coverage_receipts: bindings,
    mentions: argumentSubstrate.mentions.filter(row => selectedMentions.has(row.mention_id)),
  };
  const staleVersions = sourceVersions.filter(row => claimSources[claim.id].includes(row.source_version_id))
    .map(row => ({ ...row, state: 'deleted' }));
  const staleness = staleVersions.map(row => buildSourceStalenessReceipt({
    prior_supporting_source_version_id: row.source_version_id,
    transition_source_version_id: `deleted:${row.source_version_id}`,
    to_state: 'deleted',
    materialization_id: `${materializationId}:deleted-fixture`,
  }));
  const selected = staleVersions.slice().sort((left, right) => left.captured_at.localeCompare(right.captured_at)
    || left.source_version_id.localeCompare(right.source_version_id))[0];
  const migration = buildMigrationProvenanceReceipt({
    basis_claim_id: claim.id,
    source_version: selected,
    capture_basis: `git-commit-committer-time:${estateCommit}`,
    materialization_id: `${materializationId}:deleted-fixture`,
  });
  const deletedProjection = buildClaimProjection({
    admitted_claims: [claim],
    argument_substrate: heldSubstrate,
    source_versions: staleVersions,
    claim_source_version_ids: { [claim.id]: claimSources[claim.id] },
    source_staleness_receipts: staleness,
    migration_provenance_receipts: [migration],
    lineage_facts: { [claim.id]: lineage[claim.id] },
    materialization_id: `${materializationId}:deleted-fixture`,
  });
  if (deletedProjection.assertions[0]?.source_status !== 'historical'
    || deletedProjection.assertions[0]?.source_staleness_receipt_ids.length !== staleVersions.length) {
    fail('deleted-source fixture did not produce historical assertion with exact staleness receipts');
  }
  const negated = structuredClone(deletedProjection);
  negated.assertions[0].source_status = 'current';
  assertThrowsCode(() => verifyStatusDerivation({
    projection: negated,
    source_versions: staleVersions,
    claim_source_version_ids: { [claim.id]: claimSources[claim.id] },
  }), 'STATUS_TIME_DERIVATION_MISMATCH');
}

export function runPhaseAExitGate() {
  const confirmationManifest = JSON.parse(readFileSync(join(root, 'analysis/run-manifests/v32-confirmation.json'), 'utf8'));
  const pins = new Map(confirmationManifest.payloads.map(row => [row.old_path, row]));
  const union = gitObject(unionPath, pins.get(unionPath) || fail('V32 union custody pin is absent'));
  const graph = gitObject(graphPath, pins.get(graphPath) || fail('V32 graph custody pin is absent'));
  const grade = gitObject(gradePath, pins.get(gradePath) || fail('V32 grade custody pin is absent'));
  const baselineManifest = JSON.parse(readFileSync(join(root, 'analysis/run-manifests/v32-phase-a-baseline-v1.json'), 'utf8'));
  if (baselineManifest.determination !== 'complete' || baselineManifest.missing_inputs.length
    || baselineManifest.payloads[0]?.sha256 !== 'e8521a70dba239aa76802cb5ed2202a8799da0a8bfa9a690f94e0d0e54134ffe') {
    fail('tracked V32 Phase A baseline determination is not the verified complete baseline');
  }
  const claims = union.claims.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (claims.length !== 8024 || sha256(stableStringify(claims)) !== expectedClaimPlaneDigest) {
    fail('V32 claim plane differs from the verified baseline');
  }
  const lineage = lineageFacts(claims, graph);
  if (lineageDigest(claims, lineage) !== expectedLineagePlaneDigest) fail('V32 lineage plane differs from the verified baseline');
  console.log('PASS Phase A baseline custody: 8,024 claims from hash-pinned local Git objects; git-ignored runs untouched');

  const heldEstate = estateRoot();
  const estateHead = execFileSync('git', ['-C', heldEstate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const estateStatus = execFileSync('git', ['-C', heldEstate, 'status', '--short'], { encoding: 'utf8' }).trim();
  const capturedAt = execFileSync('git', ['-C', heldEstate, 'show', '-s', '--format=%cI', estateCommit], { encoding: 'utf8' }).trim();
  if (estateHead !== estateCommit || estateStatus || capturedAt !== estateCapturedAt) fail('pinned estate source/capture provenance is unavailable or dirty');
  const sourceManifest = JSON.parse(readFileSync(join(root, sourceManifestPath), 'utf8'));
  if (sourceManifest.source_sha !== estateCommit || sourceManifest.documents.length !== 285) fail('source manifest differs from V32 baseline');
  const inventories = sourceManifest.documents.map(spec => inventoryMarkdown({
    path: spec.path,
    content: readFileSync(join(heldEstate, spec.path), 'utf8'),
    source_sha: estateCommit,
    corpus_digest: corpusDigest,
  }));
  // The proposition producer's estate-wide object exceeds V8's single-string limit at Truth285
  // scale. Build each producer-owned document inventory independently, then combine its emitted
  // units for A1 and its obligations for the pinned segmentation/coverage replay.
  const propositionInventories = inventories
    .map(inventory => buildPropositionObligationInventory({ inventories: [inventory] }));
  const obligationInventory = {
    schema: 'estate-map/proposition-obligation-inventory/v1',
    units: propositionInventories.flatMap(inventory => inventory.units),
    obligations: propositionInventories.flatMap(inventory => inventory.obligations),
  };
  const measuredSourceUnitIds = new Set(grade.opportunity_results.map(row => row.source_unit_id));
  const currentSourceUnitIds = new Set(obligationInventory.units.map(row => row.id));
  const missingMeasuredUnits = [...measuredSourceUnitIds].filter(id => !currentSourceUnitIds.has(id));
  if (grade.opportunity_results.length !== 576 || measuredSourceUnitIds.size !== 576 || missingMeasuredUnits.length) {
    fail(`proposition segmentation changed ${missingMeasuredUnits.length} pinned V32 candidate opportunity source units`);
  }
  const measuredObligations = obligationInventory.obligations
    .filter(row => measuredSourceUnitIds.has(row.source_unit_id));
  const coverageProbe = backfillCandidateContactLedger({
    inventory: {
      digest: sha256(stableStringify(measuredObligations)),
      obligations: measuredObligations,
    },
    admitted_claims: claims,
  });
  if (coverageProbe.semantic_coverage_inferred_from_overlap
    || coverageProbe.rows.some(row => row.explicit_coverage_receipt_ids.length || !row.follow_up_eligible)) {
    fail('proposition segmentation changed receipt-only proposition-coverage semantics');
  }
  const contacted = coverageProbe.rows.filter(row => row.contact_state === 'contacted_by_admitted_claim').length;
  const control = grade.metrics?.control?.document_scope;
  const treatment = grade.metrics?.treatment?.document_scope;
  if (!grade.pass || control?.recovered !== 288 || treatment?.recovered !== 413
    || control?.strict_recall !== 0.5 || treatment?.strict_recall !== 0.7170138888888888) {
    fail('pinned V32 candidate-obligation behavior differs from the confirmed grade');
  }
  console.log(`PASS Phase A proposition segmentation: 576/576 pinned V32 candidate opportunities retain source-unit identity; ${contacted}/${coverageProbe.rows.length} evidence contacts remain non-coverage and follow-up eligible; measured control 288/576 (0.5), treatment 413/576 (0.7170138888888888)`);
  const argumentSubstrate = buildArgumentMentionSubstrate({
    inventory: obligationInventory,
    inventories,
    claims,
    materialization_id: materializationId,
  });
  if (argumentSubstrate.concepts.length) fail('A1 provenance/noise fixture promoted concepts');
  console.log(`PASS Phase A provenance/noise fixtures: ${argumentSubstrate.mention_discovery_coverage_receipts.length} source-unit receipts; zero promoted concepts`);

  const sources = sourcePlanes(claims, inventories);
  const projection = buildClaimProjection({
    admitted_claims: claims,
    argument_substrate: argumentSubstrate,
    source_versions: sources.sourceVersions,
    claim_source_version_ids: sources.claimSources,
    migration_provenance_receipts: sources.migrationReceipts,
    lineage_facts: lineage,
    materialization_id: materializationId,
    projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
  });
  const graphCommit = buildGraphCommit({
    source_head: estateCommit,
    added_object_digests: [argumentSubstrate.digest, projection.digest],
    claim_projection_receipts: projection.claim_projection_receipts,
    dependency_index_digest: sha256(stableStringify({
      producer_commit: producerCommit,
      estate_commit: estateCommit,
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    })),
  });
  const result = verifyPhaseAExit({
    admitted_claims: claims,
    projection,
    graph_commit: graphCommit,
    source_versions: sources.sourceVersions,
    claim_source_version_ids: sources.claimSources,
    expected_claim_plane_digest: expectedClaimPlaneDigest,
    expected_lineage_facts: lineage,
  });
  console.log(`PASS Phase A conservation: ${result.claims} claim IDs and exact keys/support/spans/repairs/extraction/lineage; digest ${result.claim_plane_projection_digest}`);
  console.log(`PASS Phase A receipts: ${result.receipts} exact receipts; ${result.assertions} assertions; GraphCommit projection complete`);
  const dispositionHistogram = Object.fromEntries([...new Set(projection.claim_projection_receipts
    .map(row => row.disposition))].sort().map(disposition => [disposition,
    projection.claim_projection_receipts.filter(row => row.disposition === disposition).length]));
  console.log(`PASS Phase A disposition histogram: ${JSON.stringify(dispositionHistogram)}`);

  runOwnedFalsifiers({ claims, projection, argumentSubstrate, sourceVersions: sources.sourceVersions,
    claimSources: sources.claimSources, lineage });
  console.log('PASS Phase A owned falsifiers: 5/5 claim bytes, receipt cardinality, favorable/assertion, unresolved/assertion, and deleted-source negations failed closed');
  console.log('PASS Phase A exit gate');
  return Object.freeze({
    claims,
    projection,
    argument_substrate: argumentSubstrate,
    disposition_histogram: dispositionHistogram,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runPhaseAExitGate(); }
  catch (error) {
    console.error(`FAIL Phase A exit gate: ${error.stack || error.message}`);
    if (error?.detail && Object.keys(error.detail).length) console.error(stableStringify(error.detail).trim());
    process.exitCode = 1;
  }
}
