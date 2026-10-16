#!/usr/bin/env node
// Basis-8 reviewed-resolution run: build the closed universe, ask one model for proposals, then
// gate every proposal deterministically (C4 design section 13).
//
// The model call is isolated here so `--replay` can re-run the entire gate offline from captured
// response bytes. Model and spend policy are explicit per-run operator inputs; this tool sets no
// default model and applies no tuning to the outcome.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { buildCodeGroundedAssertions } from './code-grounded-assertions.mjs';
import { extractEstate } from './extract.mjs';
import { materializeExactGitTree, validateGitTreeMaterialization } from './git-tree-source.mjs';
import { buildLocalStructuralDocumentaryPlane } from './local-documentary-source.mjs';
import { mergeFacts } from './merge.mjs';
import {
  buildReviewedResolutionRunReceipt, buildReviewedResolutionUniverse,
  enumerateDocumentaryOccurrences, gateReviewedResolutionProposals,
  mintReviewedResolutionConstraint, parseReviewedResolutionResponse,
} from './reviewed-resolution-producer.mjs';
import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
const scratchRoot = () => process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();

const SYSTEM_PROMPT = [
  'You propose cross-occurrence references between documentation and code for a deterministic',
  'verifier that re-checks every claim against source bytes and discards anything it cannot prove.',
  '',
  'You are given two enumerated sets: DECLARATIONS (code declarations with exact coordinates) and',
  'OCCURRENCES (exact documentary text occurrences). Propose a pair only when the documentary',
  'occurrence refers to that specific code declaration.',
  '',
  'Return ONLY a JSON array. Each element must have exactly three fields:',
  '  candidate_fact_id  - a candidate_fact_id copied verbatim from DECLARATIONS',
  '  occurrence_id      - an occurrence_id copied verbatim from OCCURRENCES',
  '  exact_quote        - the occurrence "quote" field copied verbatim, byte for byte',
  '',
  'Rules: never invent an id; never edit a quote; never add fields; never wrap the array in an',
  'object; propose at most one declaration per occurrence. Returning [] is a correct answer when',
  'no reference is supported. There is no target number of proposals and no credit for volume.',
].join('\n');

function renderPrompt(universe) {
  return canonical({
    task: 'propose documentary-to-code references drawn only from these enumerated sets',
    project_id: universe.project_id,
    source_head: universe.source_head,
    declarations: universe.declarations.map(row => ({
      candidate_fact_id: row.candidate_fact_id,
      surface: row.surface,
      declaration_kind: row.declaration_kind,
      file: row.file,
      line: row.line,
    })),
    occurrences: universe.occurrences.map(row => ({
      occurrence_id: row.occurrence_id,
      document_path: row.document_path,
      line: row.line,
      surface: row.surface,
      quote: row.quote,
    })),
  });
}

/** Exact terminal assistant text plus the provider-reported binding. No self-reported fields. */
function invokeModel({ model, thinking, promptPath, outputDir }) {
  const args = ['--model', model, '--mode', 'json', '--print', '--no-session', '--no-tools',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve',
    ...(thinking ? ['--thinking', thinking] : []),
    '--system-prompt', SYSTEM_PROMPT, `@${promptPath}`];
  const stdout = execFileSync('pi', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  writeFileSync(join(outputDir, 'model-response.jsonl'), stdout);
  return readResponse(stdout);
}

function readResponse(stdout) {
  let text = null, binding = null;
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const message = row?.message;
    if (row?.type !== 'message_end' || message?.role !== 'assistant') continue;
    text = (message.content || []).filter(part => part?.type === 'text')
      .map(part => part.text).join('');
    binding = { provider: message.provider ?? null, model: message.model ?? null,
      api: message.api ?? null, response_id: message.responseId ?? null,
      stop_reason: message.stopReason ?? null };
  }
  if (text == null) throw new Error('model transport produced no terminal assistant message');
  return { text, binding };
}

async function main(options) {
  const config = JSON.parse(readFileSync(options.config, 'utf8'));
  const runRoot = options.scratch_dir || mkdtempSync(join(scratchRoot(), `reviewed-resolution-${config.project_id}-`));
  mkdirSync(runRoot, { recursive: true });
  const outputDir = resolve(options.output_dir);
  mkdirSync(outputDir, { recursive: true });
  const estateRoot = join(runRoot, 'estate');
  const materializedRoot = join(estateRoot, config.project_id);
  const materialized = materializeExactGitTree({ repository: options.repository, sha: config.sha,
    target: materializedRoot, project_id: config.project_id });
  const documentary = buildLocalStructuralDocumentaryPlane({
    materialized_root: materializedRoot, tree_manifest: materialized.manifest,
    document_paths: config.documentary_paths, imported_semantic_claims: [] });
  const extractRoot = join(runRoot, 'extract');
  const mergeRoot = join(runRoot, 'merge');
  await extractEstate(estateRoot, extractRoot, { repo: config.project_id, strict: true });
  await mergeFacts(extractRoot, mergeRoot);
  validateGitTreeMaterialization(materializedRoot, materialized.manifest);
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: JSON.parse(readFileSync(join(extractRoot, '_MANIFEST.json'), 'utf8')),
    merge_graph: JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8')),
    merge_graph_digest: readFileSync(join(mergeRoot, 'digest.txt'), 'utf8').trim(),
    source_head: config.sha, required_source_head: config.sha,
    recorded_time: materialized.manifest.commit_time });
  const occurrences = enumerateDocumentaryOccurrences({ documentary,
    materialized_root: materializedRoot });
  const universe = buildReviewedResolutionUniverse({
    identity_candidates: codePlane.identity_candidates, documentary_occurrences: occurrences,
    code_plane_head: codePlane.code_plane_head,
    documentary_plane_head: documentary.documentary_plane_head,
    source_head: config.sha, project_id: config.project_id });
  const prompt = renderPrompt(universe);
  const promptPath = join(outputDir, 'prompt.json');
  writeFileSync(promptPath, prompt);
  writeFileSync(join(outputDir, 'universe.json'), canonical(universe));
  console.log(`UNIVERSE declarations=${universe.declarations.length} occurrences=${universe.occurrences.length} digest=${universe.universe_digest}`);
  console.log(`PROMPT bytes=${Buffer.byteLength(prompt)} path=${promptPath}`);
  if (options.dry_run) { console.log('DRY RUN: no model invoked'); return; }

  const response = options.replay
    ? readResponse(readFileSync(options.replay, 'utf8'))
    : invokeModel({ model: options.model, thinking: options.thinking, promptPath, outputDir });
  const responseDigest = sha256(response.text);
  console.log(`RESPONSE binding=${canonical(response.binding)} digest=${responseDigest}`);
  const proposals = parseReviewedResolutionResponse(response.text);
  const gated = gateReviewedResolutionProposals({
    universe, proposals, materialized_root: materializedRoot,
    model_binding: response.binding, prompt_digest: sha256(prompt), response_digest: responseDigest,
    review_authority_id: options.review_authority_id,
    documentary_source_version_id: `source-version:${config.sha}` });
  const evidenceById = new Map(codePlane.grounding_registry.evidence_pointers
    .map(row => [row.evidence_id, row]));
  const candidateById = new Map(codePlane.identity_candidates.map(row => [row.fact_id, row]));
  const constraints = gated.accepted.map(accepted => {
    const candidate = candidateById.get(accepted.candidate_fact_id);
    return mintReviewedResolutionConstraint({ accepted, code_mention: candidate.mention,
      code_evidence: evidenceById.get(candidate.evidence_id) });
  });
  const receipt = buildReviewedResolutionRunReceipt({ universe, gated,
    model_binding: response.binding, prompt_digest: sha256(prompt), response_digest: responseDigest,
    constraints, review_authority_id: options.review_authority_id });
  writeFileSync(join(outputDir, 'reviewed-resolution-run-receipt.json'), canonical(receipt));
  writeFileSync(join(outputDir, 'accepted.json'), canonical(gated.accepted.map(row => ({
    candidate_fact_id: row.candidate_fact_id, occurrence_id: row.occurrence_id,
    reviewed_resolution_receipt_id: row.receipt.receipt_id,
    dependency_ids: row.receipt.dependency_ids }))));
  writeFileSync(join(outputDir, 'refusals.json'), canonical(gated.refusals));
  writeFileSync(join(outputDir, 'identity-constraints.json'),
    canonical(constraints.map(row => row.constraint)));
  console.log(`PROPOSED ${proposals.length} ACCEPTED ${gated.accepted.length} REFUSED ${gated.refusals.length}`);
  console.log(`REFUSALS ${canonical(receipt.refusals_by_code)}`);
  console.log(`RECEIPT ${receipt.receipt_id}`);
}

function parse(argv) {
  const held = { dry_run: false, thinking: null, replay: null, scratch_dir: null,
    review_authority_id: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') { held.dry_run = true; continue; }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--repository') held.repository = resolve(value);
    else if (flag === '--config') held.config = resolve(value);
    else if (flag === '--output-dir') held.output_dir = resolve(value);
    else if (flag === '--scratch-dir') held.scratch_dir = resolve(value);
    else if (flag === '--model') held.model = value;
    else if (flag === '--thinking') held.thinking = value;
    else if (flag === '--replay') held.replay = resolve(value);
    else if (flag === '--review-authority-id') held.review_authority_id = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const required of ['repository', 'config', 'output_dir']) {
    if (!held[required]) throw new Error(`--${required.replace('_', '-')} is required`);
  }
  if (!held.dry_run && !held.replay && !held.model) {
    throw new Error('--model is a required explicit operator input unless --dry-run or --replay');
  }
  if (!held.dry_run && !held.review_authority_id) {
    throw new Error('--review-authority-id is required: a reviewed resolution names its authority');
  }
  if (held.output_dir && !isAbsolute(held.output_dir)) throw new Error('--output-dir must be absolute');
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(parse(process.argv.slice(2))).catch(error => {
    console.error(`FAIL reviewed-resolution run: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
