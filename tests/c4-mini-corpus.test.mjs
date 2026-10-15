import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidencePointer, buildMention } from '../tools/argument-mentions.mjs';
import { buildC4IdentityJoinClosure } from '../tools/c4-identity-join.mjs';
import { buildC4JoinReceiptExplorerModel } from '../tools/c4-join-explorer.mjs';
import { buildCodeGroundedAssertions } from '../tools/code-grounded-assertions.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';
import { mergeFacts } from '../tools/merge.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityConstraint, buildIdentityVerificationRegistry,
  resolveIdentityComponents, verifyIdentityResolution,
} from '../tools/referent-identity.mjs';
import {
  claimAssertionId, CLAIM_ASSERTION_SCHEMA, CLAIM_PROJECTION_RECEIPT_SCHEMA,
  CLAIM_PROJECTION_SCHEMA_VERSION,
} from '../tools/claim-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, 'fixtures/c4-mini-corpus');
const estateRoot = join(fixtureRoot, 'estate');
const substrate = JSON.parse(readFileSync(join(fixtureRoot, 'documentary-substrate.json'), 'utf8'));
const miniSourceHead = '2222222222222222222222222222222222222222';
const materializationId = 'materialization:c4-mini-corpus-v1';
const canonical = value => stableStringify(value).trim();

function documentSpan(descriptor) {
  const path = join(estateRoot, descriptor.file);
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/u);
  const line = lines[descriptor.line - 1];
  assert.notEqual(line, undefined, `${descriptor.file}:${descriptor.line} exists`);
  const column = line.indexOf(descriptor.surface);
  assert.notEqual(column, -1, `${descriptor.file}:${descriptor.line} contains ${descriptor.surface}`);
  const beforeLines = lines.slice(0, descriptor.line - 1).join('\n');
  const lineOffset = Buffer.byteLength(beforeLines, 'utf8') + (descriptor.line > 1 ? 1 : 0);
  const byteStart = lineOffset + Buffer.byteLength(line.slice(0, column), 'utf8');
  return {
    kind: 'document_span', file: descriptor.file,
    start: descriptor.line, end: descriptor.line,
    byte_start: byteStart,
    byte_end: byteStart + Buffer.byteLength(descriptor.surface, 'utf8'),
    exact_text: descriptor.surface,
    digest: sha256(descriptor.surface),
  };
}

function documentaryIdentity() {
  const evidence = [];
  const mentions = [];
  const byKey = new Map();
  for (const descriptor of substrate.mentions) {
    const pointer = buildEvidencePointer({
      source_version_id: substrate.source_version_id,
      pointer: documentSpan(descriptor),
    });
    const mention = buildMention({
      evidence_pointer: pointer,
      surface: descriptor.surface,
      role: descriptor.role,
      provenance_class: 'production_document',
      namespace: descriptor.file,
      source_status: 'current',
      context_digest: sha256(`${descriptor.file}:${descriptor.line}:${descriptor.surface}`),
      disposition: 'identity_candidate',
    }).mention;
    evidence.push(pointer);
    mentions.push(mention);
    byKey.set(descriptor.key, { mention, pointer });
  }
  const projectionReceipts = [];
  const assertionsByDeclaredId = new Map();
  for (const [index, descriptor] of substrate.assertions.entries()) {
    const basisClaimId = `claim:c4-mini:${index}`;
    const argumentMentions = [
      { role: 'subject', mention_id: byKey.get(descriptor.subject_mention_key).mention.mention_id },
      { role: 'object', mention_id: byKey.get(descriptor.object_mention_key).mention.mention_id },
    ];
    const assertionId = claimAssertionId({ basis_claim_id: basisClaimId,
      argument_mentions: argumentMentions });
    const receiptBody = {
      schema: CLAIM_PROJECTION_RECEIPT_SCHEMA, basis_claim_id: basisClaimId,
      disposition: 'fully_projected', assertion_ids: [assertionId],
      argument_binding_receipt_ids: [], findings: [],
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION, materialization_id: materializationId,
    };
    const receipt = { ...receiptBody,
      receipt_id: `claim-projection-receipt:${sha256(canonical(receiptBody))}` };
    const assertion = {
      schema: CLAIM_ASSERTION_SCHEMA, assertion_id: assertionId, basis_claim_id: basisClaimId,
      predicate_lexeme: descriptor.predicate_lexeme, argument_mentions: argumentMentions,
      projection_receipt_id: receipt.receipt_id,
      projection_schema_version: CLAIM_PROJECTION_SCHEMA_VERSION,
    };
    projectionReceipts.push(receipt);
    assertionsByDeclaredId.set(descriptor.assertion_id, assertion);
  }
  const identityVerificationRecords = {
    mentions, evidence_pointers: evidence,
    assertions: [...assertionsByDeclaredId.values()], receipts: projectionReceipts,
    declaration_witnesses: [], forge_locator_identities: [], reviewed_dependencies: [],
  };
  const verificationRegistry = buildIdentityVerificationRegistry(identityVerificationRecords);
  const constraints = substrate.constraints.map(row => {
    const left = byKey.get(row.left);
    const right = byKey.get(row.right);
    if (row.kind === 'source_cited_alias') {
      const assertion = assertionsByDeclaredId.get(row.assertion_id);
      return buildAutomaticIdentityConstraint({
        left: left.mention.mention_id,
        right: right.mention.mention_id,
        basis: { kind: row.kind, alias_assertion_id: assertion.assertion_id },
        basis_evidence_ids: [left.pointer.evidence_id, right.pointer.evidence_id],
        basis_assertion_ids: [assertion.assertion_id],
        source_status: 'current', materialization_id: materializationId,
      }, verificationRegistry);
    }
    if (row.kind === 'exact_defined_term_identity') return buildAutomaticIdentityConstraint({
      left: left.mention.mention_id,
      right: right.mention.mention_id,
      basis: { kind: row.kind, namespace_key: row.namespace_key,
        exact_term: row.exact_term,
        definition_evidence_id: byKey.get(row.definition_mention_key).pointer.evidence_id },
      basis_evidence_ids: [left.pointer.evidence_id, right.pointer.evidence_id],
      source_status: 'current', materialization_id: materializationId,
    }, verificationRegistry);
    return buildIdentityConstraint({
      left: left.mention.mention_id,
      right: right.mention.mention_id,
      disposition: 'cannot_link', constraint_kind: 'identity',
      basis: { kind: 'source_explicit_distinction', reason: row.reason },
      basis_evidence_ids: [left.pointer.evidence_id, right.pointer.evidence_id],
      source_status: 'current', authority: 'source_explicit',
      materialization_id: materializationId,
    });
  }).sort((left, right) => left.constraint_id.localeCompare(right.constraint_id));
  const resolution = resolveIdentityComponents({
    mention_ids: mentions.map(row => row.mention_id),
    identity_constraints: constraints,
    materialization_id: materializationId,
    identity_verification_registry: verificationRegistry,
  });
  verifyIdentityResolution({ mention_ids: mentions.map(row => row.mention_id),
    identity_constraints: constraints, resolution,
    identity_verification_registry: verificationRegistry });
  return {
    argumentSubstrate: { evidence_pointers: evidence, mentions },
    identity: { identity_constraints: constraints, identity_resolution: resolution,
      identity_verification_registry: verificationRegistry,
      identity_verification_records: identityVerificationRecords },
    byKey,
  };
}

async function runMini(scratch) {
  const extractRoot = join(scratch, 'extract');
  const mergeRoot = join(scratch, 'merge');
  await extractEstate(estateRoot, extractRoot, { strict: true });
  await mergeFacts(extractRoot, mergeRoot);
  const manifest = JSON.parse(readFileSync(join(extractRoot, '_MANIFEST.json'), 'utf8'));
  const graph = JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8'));
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: manifest,
    merge_graph: graph,
    merge_graph_digest: readFileSync(join(mergeRoot, 'digest.txt'), 'utf8').trim(),
    source_head: miniSourceHead,
    required_source_head: miniSourceHead,
    recorded_time: '2026-08-10T00:00:00.000Z',
  });
  const documentary = documentaryIdentity();
  const all = buildC4IdentityJoinClosure({
    argument_substrate: documentary.argumentSubstrate,
    documentary_identity: documentary.identity,
    code_fact_plane: codePlane,
    identity_selection: { mode: 'all' },
  });
  const first = buildC4IdentityJoinClosure({
    argument_substrate: documentary.argumentSubstrate,
    documentary_identity: documentary.identity,
    code_fact_plane: codePlane,
    identity_selection: { mode: 'batch', batch_size: substrate.expected.batch_size,
      cursor: 0, batch_index: 0 },
  });
  const second = buildC4IdentityJoinClosure({
    argument_substrate: documentary.argumentSubstrate,
    documentary_identity: documentary.identity,
    code_fact_plane: codePlane,
    identity_selection: { mode: 'batch', batch_size: substrate.expected.batch_size,
      cursor: first.batch_receipt.next_cursor, batch_index: 1 },
  });
  const third = buildC4IdentityJoinClosure({
    argument_substrate: documentary.argumentSubstrate,
    documentary_identity: documentary.identity,
    code_fact_plane: codePlane,
    identity_selection: { mode: 'batch', batch_size: substrate.expected.batch_size,
      cursor: second.batch_receipt.next_cursor, batch_index: 2 },
  });
  const sharedReferents = new Set(all.report.join_receipts
    .filter(row => row.disposition === 'joined').map(row => row.selected_referent_id));
  const explorer = buildC4JoinReceiptExplorerModel({
    projection_id: 'identity-batch-projection:c4-mini', graph_commit_id: null,
    identity_head: 'identity-head:c4-mini',
    graph_counts_by_plane: {
      scope: { description: 'tracked C4 mini-corpus identity receipt only' },
      shared_assertion_neighborhood_nodes: sharedReferents.size,
    },
    identity_join: all.report,
  });
  return { manifest, graph, codePlane, documentary, all, first, second, third, explorer };
}

function deterministicOutput(run) {
  return {
    code_plane_head: run.codePlane.code_plane_head,
    candidate_generation: run.codePlane.identity_candidate_generation,
    inventory: run.codePlane.inventory,
    component_identity_decisions: run.all.component_identity_decisions,
    identity_resolution: run.all.identity_resolution,
    report: run.all.report,
    first_report: run.first.report,
    second_report: run.second.report,
    third_report: run.third.report,
    explorer: run.explorer,
  };
}

test('tracked C4 mini-corpus exercises real producers with hand-authored semantic outcomes', async t => {
  const scratchBase = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, 'c4-mini-corpus-'));
  const started = performance.now();
  try {
    const firstRun = await runMini(join(root, 'first'));
    const secondRun = await runMini(join(root, 'second'));
    const expected = substrate.expected;
    const repositoryRows = firstRun.manifest.repositories.filter(row => row.status === 'complete');
    const files = repositoryRows.reduce((sum, row) => sum + row.files_scanned, 0);
    assert.deepEqual({
      extractor_availability: {
        available: firstRun.manifest.extractor_availability.available.map(row => row.extractor),
        exclusions: firstRun.manifest.extractor_exclusions.length,
      },
      fixture_files: expected.fixture_files,
      extractor_scanned_files: files,
      documentary_only_files: expected.documentary_only_files,
      components: repositoryRows.length,
      extract_facts: firstRun.codePlane.verification.facts,
      fact_kinds: firstRun.codePlane.verification.fact_kinds,
      identity_candidates: firstRun.all.report.denominators.full_census_candidates,
      candidate_components: firstRun.all.report.denominators.full_census_components,
      dispositions: firstRun.all.report.dispositions,
      entity_layer: firstRun.all.report.entity_layer,
      shared_referents: firstRun.explorer.joins.length,
    }, {
      extractor_availability: expected.extractor_availability,
      fixture_files: 8,
      // Markdown is now scanned: document-structure reads every documentary file, so no fixture
      // file is documentary-only. The distinction the corpus used to draw — a file the code
      // producers ignore — survives as which KINDS a file yields, not whether it is scanned.
      extractor_scanned_files: 8,
      documentary_only_files: 0,
      components: expected.components,
      extract_facts: expected.extract_facts,
      fact_kinds: expected.fact_kinds,
      identity_candidates: expected.identity_candidates,
      candidate_components: expected.candidate_components,
      dispositions: { joined: expected.joined, unresolved: expected.unresolved,
        cannot_link: expected.cannot_link, terminal_incomplete: expected.terminal_incomplete },
      entity_layer: {
        evaluated_candidates: expected.identity_candidates,
        candidate_components: expected.candidate_components,
        component_identity_decisions: expected.entity_component_decisions,
        resolved_candidate_mentions: expected.resolved_identity_candidates,
        unresolved_candidate_mentions: expected.unresolved_identity_candidates,
        keyed_referents: expected.keyed_referents,
      },
      shared_referents: expected.shared_referents,
    });

    const candidatesByFact = new Map(firstRun.codePlane.identity_candidates.map(row => [row.fact_id, row]));
    const shared = firstRun.all.report.join_receipts.filter(row =>
      candidatesByFact.get(row.fact_id).mention.surface === 'urn:mini:shared');
    const sameString = firstRun.all.report.join_receipts.filter(row =>
      candidatesByFact.get(row.fact_id).mention.surface === 'same_name');
    const orphan = firstRun.all.report.join_receipts.find(row =>
      candidatesByFact.get(row.fact_id).mention.surface === 'urn:mini:orphan');
    const blocked = firstRun.all.report.join_receipts.find(row =>
      candidatesByFact.get(row.fact_id).mention.surface === 'urn:mini:blocked');
    const aliasComponent = firstRun.documentary.identity.identity_resolution.components.find(component =>
      component.candidate_mention_ids.includes(firstRun.documentary.byKey.get('legacy-alias').mention.mention_id));
    assert.deepEqual({
      nary_joined: shared.map(row => row.disposition),
      nary_component_count: new Set(shared.map(row => row.resolution_receipt_id)).size,
      same_string_dispositions: sameString.map(row => row.disposition).sort(),
      same_string_components: new Set(sameString.map(row => row.resolution_receipt_id)).size,
      orphan: orphan.disposition,
      blocked: blocked.disposition,
      alias_component: aliasComponent.status,
      alias_mentions: aliasComponent.candidate_mention_ids.length,
    }, {
      nary_joined: ['joined', 'joined', 'joined'],
      nary_component_count: 1,
      same_string_dispositions: Array(expected.same_string_nonjoin_candidates).fill('unresolved'),
      same_string_components: expected.same_string_nonjoin_candidates,
      orphan: 'unresolved', blocked: 'cannot_link',
      alias_component: 'resolved', alias_mentions: 3,
    });

    const batches = [firstRun.first.batch_receipt, firstRun.second.batch_receipt, firstRun.third.batch_receipt];
    const selected = batches.flatMap(row => row.selected_candidate_fact_ids);
    const fullCandidateIds = firstRun.codePlane.identity_candidates.map(row => row.fact_id).sort();
    const selectedComponents = new Set(batches.flatMap(row => row.selected_component_ids));
    const fullComponents = new Set(firstRun.all.report.exact_basis_groups.map(row => row.component_id));
    const deferredSingleton = firstRun.first.report.exact_basis_groups.some(group =>
      group.candidate_fact_ids.length === 1 && group.evaluation_state === 'not_evaluated_in_this_batch');
    assert.deepEqual({
      adjacent_cursor: firstRun.first.batch_receipt.next_cursor === firstRun.second.batch_receipt.cursor
        && firstRun.second.batch_receipt.next_cursor === firstRun.third.batch_receipt.cursor,
      unique_candidates: new Set(selected).size,
      union: selected.slice().sort(),
      full_candidates: fullCandidateIds,
      selected_components: [...selectedComponents].sort(),
      full_components: [...fullComponents].sort(),
      complete: firstRun.third.batch_receipt.complete,
      deferred_singleton: deferredSingleton,
      pending_semantic_dispositions: firstRun.first.batch_receipt.candidate_rows
        .filter(row => row.evaluation_state === 'not_evaluated_in_this_batch')
        .filter(row => Object.hasOwn(row, 'disposition')).length,
    }, {
      adjacent_cursor: true,
      unique_candidates: expected.identity_candidates,
      union: fullCandidateIds,
      full_candidates: fullCandidateIds,
      selected_components: [...fullComponents].sort(),
      full_components: [...fullComponents].sort(),
      complete: true,
      deferred_singleton: true,
      pending_semantic_dispositions: 0,
    });

    assert.equal(canonical(deterministicOutput(firstRun)), canonical(deterministicOutput(secondRun)));
    t.diagnostic(`mini-corpus inventory: ${expected.fixture_files} tracked source files (${files} extractor-scanned + ${expected.documentary_only_files} documentary-only), ${firstRun.codePlane.verification.facts} facts, ${firstRun.codePlane.verification.fact_kinds} kinds, ${expected.identity_candidates} candidates`);
    t.diagnostic(`mini-corpus runtime_ms=${Math.round(performance.now() - started)} heap_class=default-small-node-process`);
    t.diagnostic('scope: proves producer/generator/grouping/admissibility/dispositions/batches/explorer determinism only; full estate counts and plane invariants remain expensive-integration evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
