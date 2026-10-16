import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodeGroundedAssertions } from '../tools/code-grounded-assertions.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { materializeExactGitTree } from '../tools/git-tree-source.mjs';
import { buildLocalStructuralDocumentaryPlane } from '../tools/local-documentary-source.mjs';
import { mergeFacts } from '../tools/merge.mjs';
import {
  buildReviewedResolutionUniverse, enumerateDocumentaryOccurrences,
  gateReviewedResolutionProposals, mintReviewedResolutionConstraint,
  parseReviewedResolutionResponse,
} from '../tools/reviewed-resolution-producer.mjs';
import {
  buildIdentityVerificationRegistry, buildReviewedResolutionDependency, verifyIdentityConstraint,
} from '../tools/referent-identity.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const canonical = value => stableStringify(value).trim();
const codeOf = action => { try { action(); return 'ACCEPTED'; } catch (error) { return error.code; } };
const modelBinding = { provider: 'fixture', model: 'fixture-model', api: 'fixture-api' };

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test' } }).trim();
}

/** One exact commit carrying prose that names a declaration without sharing its namespace. */
async function corpus() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'reviewed-resolution-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'DECISIONS.md'),
    '# Decisions\n\n**Implementation.** The `validateProject` helper owns admission.\n');
  writeFileSync(join(repo, 'src', 'app.js'), 'export function validateProject() { return true; }\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'Create reviewed-resolution fixture']);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const estateRoot = join(root, 'estate');
  const materializedRoot = join(estateRoot, 'fixture');
  const materialized = materializeExactGitTree({ repository: repo, sha, target: materializedRoot,
    project_id: 'fixture' });
  const documentary = buildLocalStructuralDocumentaryPlane({
    materialized_root: materializedRoot, tree_manifest: materialized.manifest,
    document_paths: ['DECISIONS.md'], imported_semantic_claims: [] });
  const extractRoot = join(root, 'extract');
  const mergeRoot = join(root, 'merge');
  await extractEstate(estateRoot, extractRoot, { repo: 'fixture', strict: true });
  await mergeFacts(extractRoot, mergeRoot);
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: JSON.parse(readFileSync(join(extractRoot, '_MANIFEST.json'), 'utf8')),
    merge_graph: JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8')),
    merge_graph_digest: readFileSync(join(mergeRoot, 'digest.txt'), 'utf8').trim(),
    source_head: sha, required_source_head: sha,
    recorded_time: materialized.manifest.commit_time });
  const occurrences = enumerateDocumentaryOccurrences({ documentary,
    materialized_root: materializedRoot });
  const universe = buildReviewedResolutionUniverse({
    identity_candidates: codePlane.identity_candidates, documentary_occurrences: occurrences,
    code_plane_head: codePlane.code_plane_head,
    documentary_plane_head: documentary.documentary_plane_head,
    source_head: sha, project_id: 'fixture' });
  return { root, materializedRoot, universe, codePlane, sha };
}

const gate = (held, proposals) => gateReviewedResolutionProposals({
  universe: held.universe, proposals, materialized_root: held.materializedRoot,
  model_binding: modelBinding, prompt_digest: sha256('prompt'), response_digest: sha256('response'),
  review_authority_id: 'review:fixture',
  documentary_source_version_id: `source-version:${held.sha}` });

test('[F3.3] the reviewed-resolution gate admits only byte-verified proposals from the closed universe', async () => {
  const held = await corpus();
  try {
    const declaration = held.universe.declarations
      .find(row => row.surface === 'validateProject');
    const occurrence = held.universe.occurrences
      .find(row => row.surface === 'validateProject');
    assert.ok(declaration && occurrence, 'fixture must expose one declaration and one occurrence');
    const valid = { candidate_fact_id: declaration.candidate_fact_id,
      occurrence_id: occurrence.occurrence_id, exact_quote: occurrence.quote };

    const good = gate(held, [valid]);
    const forgedQuote = gate(held, [{ ...valid, exact_quote: `${occurrence.quote} (paraphrased)` }]);
    const unknownCandidate = gate(held, [{ ...valid, candidate_fact_id: 'code-fact:absent' }]);
    const unknownOccurrence = gate(held, [{ ...valid, occurrence_id: 'documentary-occurrence:absent' }]);
    const extraField = gate(held, [{ ...valid, confidence: 0.99 }]);
    const duplicate = gate(held, [valid, { ...valid }]);

    assert.deepEqual({
      accepted: good.accepted.length,
      accepted_pair: good.accepted[0] && [good.accepted[0].candidate_fact_id === declaration.candidate_fact_id,
        good.accepted[0].occurrence_id === occurrence.occurrence_id],
      receipt_binds_two_endpoints: good.accepted[0].receipt.endpoint_mention_ids.length,
      closure_size: good.accepted[0].receipt.dependency_ids.length,
      forged_quote: [forgedQuote.accepted.length, forgedQuote.refusals[0].refusal_code],
      unknown_candidate: [unknownCandidate.accepted.length, unknownCandidate.refusals[0].refusal_code],
      unknown_occurrence: [unknownOccurrence.accepted.length, unknownOccurrence.refusals[0].refusal_code],
      extra_field: [extraField.accepted.length, extraField.refusals[0].refusal_code],
      duplicate: [duplicate.accepted.length, duplicate.refusals[0].refusal_code],
      // Free-text referents are unrepresentable: the model can only cite enumerated ids.
      zero_is_valid: gate(held, []).accepted.length,
    }, {
      accepted: 1,
      accepted_pair: [true, true],
      receipt_binds_two_endpoints: 2,
      closure_size: 4,
      forged_quote: [0, 'QUOTE_NOT_BYTE_EXACT_ON_CITED_LINE'],
      unknown_candidate: [0, 'CANDIDATE_OUTSIDE_CLOSED_UNIVERSE'],
      unknown_occurrence: [0, 'OCCURRENCE_OUTSIDE_CLOSED_UNIVERSE'],
      extra_field: [0, 'PROPOSAL_SHAPE_INVALID'],
      duplicate: [1, 'DUPLICATE_PROPOSAL'],
      zero_is_valid: 0,
    });

    // A `repo` candidate is witnessed by a directory or `.git/HEAD`, never a source line.
    const unreadable = held.universe.declarations.find(row => row.fact_kind === 'repo');
    if (unreadable) {
      const refused = gate(held, [{ candidate_fact_id: unreadable.candidate_fact_id,
        occurrence_id: occurrence.occurrence_id, exact_quote: occurrence.quote }]);
      assert.deepEqual({ accepted: refused.accepted.length, code: refused.refusals[0].refusal_code },
        { accepted: 0, code: 'DECLARATION_SOURCE_NOT_A_READABLE_FILE' });
    }
    const rival = held.universe.declarations.find(row =>
      row.candidate_fact_id !== declaration.candidate_fact_id && row.fact_kind === 'symbol');
    if (rival) {
      const ambiguous = gate(held, [valid,
        { candidate_fact_id: rival.candidate_fact_id,
          occurrence_id: occurrence.occurrence_id, exact_quote: occurrence.quote }]);
      assert.deepEqual({ accepted: ambiguous.accepted.length,
        codes: [...new Set(ambiguous.refusals.map(row => row.refusal_code))] },
      { accepted: 0, codes: ['AMBIGUOUS_OCCURRENCE_MULTIPLE_CANDIDATES'] });
    }
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('[falsifier B6] a mutated reviewed dependency closure fails recomputation despite dependencies_valid', async () => {
  const held = await corpus();
  try {
    const declaration = held.universe.declarations.find(row => row.surface === 'validateProject');
    const occurrence = held.universe.occurrences.find(row => row.surface === 'validateProject');
    const gated = gate(held, [{ candidate_fact_id: declaration.candidate_fact_id,
      occurrence_id: occurrence.occurrence_id, exact_quote: occurrence.quote }]);
    const accepted = gated.accepted[0];
    const codeCandidate = held.codePlane.identity_candidates
      .find(row => row.fact_id === declaration.candidate_fact_id);
    const codeEvidence = held.codePlane.grounding_registry.evidence_pointers
      .find(row => row.evidence_id === declaration.code_evidence_id);
    const minted = mintReviewedResolutionConstraint({ accepted,
      code_mention: codeCandidate.mention, code_evidence: codeEvidence });

    // Mutate one byte of the real closure while the caller keeps asserting validity.
    const mutated = accepted.dependencies.map(row => row.dependency_id.startsWith('reviewed-dependency:model-proposal:')
      ? buildReviewedResolutionDependency({ dependency_id: row.dependency_id,
        exact_record: { ...row.exact_record, exact_quote: `${row.exact_record.exact_quote} ` } })
      : row);
    const staleRegistry = buildIdentityVerificationRegistry({
      mentions: [codeCandidate.mention, accepted.documentary_mention],
      evidence_pointers: [codeEvidence, accepted.documentary_evidence],
      receipts: [accepted.receipt], reviewed_dependencies: mutated });

    assert.deepEqual({
      real_record_verifies: verifyIdentityConstraint(minted.constraint, minted.registry),
      basis_kind: minted.constraint.basis.kind,
      authority: minted.constraint.authority,
      dependencies_valid_still_true: minted.constraint.basis.dependencies_valid,
      mutated_closure: codeOf(() => verifyIdentityConstraint(minted.constraint, staleRegistry)),
      closure_digest_moved: canonical(mutated) !== canonical([...accepted.dependencies]),
    }, {
      real_record_verifies: true,
      basis_kind: 'prior_reviewed_resolution',
      authority: 'reviewed_resolution',
      dependencies_valid_still_true: true,
      mutated_closure: 'STALE_REVIEWED_RESOLUTION',
      closure_digest_moved: true,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('[F3.3] a model response that is not one closed JSON array is refused whole', () => {
  assert.deepEqual({
    prose: codeOf(() => parseReviewedResolutionResponse('I found three references.')),
    truncated: codeOf(() => parseReviewedResolutionResponse('[{"candidate_fact_id":')),
    malformed: codeOf(() => parseReviewedResolutionResponse('[{"candidate_fact_id": }]')),
    object: codeOf(() => parseReviewedResolutionResponse('{"proposals":[]}')),
    empty_array: parseReviewedResolutionResponse('[]').length,
    fenced_array: parseReviewedResolutionResponse('```json\n[{"a":1}]\n```').length,
  }, {
    prose: 'RESPONSE_NOT_A_JSON_ARRAY',
    // A truncated array is not one complete array; a bracketed-but-invalid body is unparseable.
    truncated: 'RESPONSE_NOT_A_JSON_ARRAY',
    malformed: 'RESPONSE_NOT_PARSEABLE',
    object: 'RESPONSE_NOT_A_JSON_ARRAY',
    empty_array: 0,
    fenced_array: 1,
  });
});

test('[F3.3] an envelope object hiding a proposal array is refused, not unwrapped', () => {
  assert.equal(codeOf(() => parseReviewedResolutionResponse('{"proposals":[{"a":1}]}')),
    'RESPONSE_NOT_A_JSON_ARRAY');
});
