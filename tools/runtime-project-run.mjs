#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeGroundedAssertions } from './code-grounded-assertions.mjs';
import { buildClaimEvidenceMap } from './claim-evidence-map.mjs';
import { renderClaimEvidenceExplorer } from './claim-evidence-explorer.mjs';
import { extractEstate } from './extract.mjs';
import { materializeExactGitTree, validateGitTreeMaterialization } from './git-tree-source.mjs';
import {
  groupIdentityCandidatesByExactBasis, selectIdentityCandidateBatch,
} from './identity-candidate-generator.mjs';
import { buildLocalStructuralDocumentaryPlane } from './local-documentary-source.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { mergeFacts } from './merge.mjs';
import { renderRuntimeProjectExplorer } from './runtime-project-explorer.mjs';

export const RUNTIME_PROJECT_RUN_SCHEMA = 'estate-map/runtime-project-run/v1';
export const RUNTIME_PROJECT_CONFIG_SCHEMA = 'estate-map/runtime-project-config/v1';
export const RUNTIME_PROJECT_DECISION_RECORD_SCHEMA = 'estate-map/runtime-project-identity-decisions/v1';
const canonical = value => stableStringify(value).trim();
const compare = (left, right) => left.localeCompare(right);
const admittedBasisKinds = new Set(['source_cited_alias', 'exact_defined_term_identity']);
const governingRules = Object.freeze({
  admittedBasis: Object.freeze({
    id: 'identity.manual-citation-existing-basis/v1',
    requirement: 'same-entity disposition requires a configured manual citation using an existing admissible basis kind',
    admitted_basis_kinds: Object.freeze([...admittedBasisKinds].sort(compare)),
  }),
  documentaryOccurrence: Object.freeze({
    id: 'documentary.byte-exact-occurrence-required/v1',
    requirement: 'documentary evidence must contain the candidate surface as byte-exact text',
    match: 'case-sensitive byte-exact identifier span',
  }),
});

function runError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

function exact(left, right) {
  return canonical(left) === canonical(right);
}

function scratchRoot() {
  return process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();
}

function loadConfig(path) {
  const bytes = readFileSync(path);
  const config = JSON.parse(bytes);
  if (config.schema !== RUNTIME_PROJECT_CONFIG_SCHEMA || !config.project_id
    || !/^[0-9a-f]{40}$/u.test(config.sha || '')
    || !Array.isArray(config.documentary_paths) || !config.documentary_paths.length
    || !config.identity_selection || !Number.isInteger(config.render?.max_items)
    || config.render.max_items < 1) {
    throw runError('RUNTIME_PROJECT_CONFIG_INVALID', 'runtime project config is incomplete');
  }
  if (!Array.isArray(config.manual_identity_joins) || !Array.isArray(config.explicit_cannot_links)
    || config.manual_identity_joins.some(row => !admittedBasisKinds.has(row.basis_kind))) {
    throw runError('RUNTIME_PROJECT_IDENTITY_POLICY_INVALID', 'manual joins must use an existing admissible identity basis');
  }
  return Object.freeze({ config, digest: sha256(bytes) });
}

function exactFactRows(extractRoot, codePlane) {
  const bySelector = new Map(codePlane.inventory.records.map(row => [
    `${row.output_path}\0${row.record_selector}`, row,
  ]));
  const root = join(extractRoot, 'facts');
  return readdirSync(root).filter(name => name.endsWith('.jsonl')).sort(compare).flatMap(name =>
    readFileSync(join(root, name), 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
      const outputPath = `facts/${name}`;
      const recordSelector = `jsonl:${index + 1}`;
      const inventory = bySelector.get(`${outputPath}\0${recordSelector}`);
      if (!inventory) throw runError('CODE_FACT_INVENTORY_MISS', `${outputPath} ${recordSelector} is absent from code inventory`);
      return Object.freeze({ fact_id: inventory.fact_id, exact_record_digest: inventory.exact_record_digest,
        output_path: outputPath, record_selector: recordSelector, record: JSON.parse(line) });
    }));
}

function lineAt(root, citation) {
  const line = readFileSync(join(root, citation.path), 'utf8').split(/\r?\n/u)[citation.line - 1];
  if (line == null || !line.includes(citation.quote)) {
    throw runError('MANUAL_IDENTITY_CITATION_MISMATCH', `${citation.path}:${citation.line} does not contain the exact cited quote`);
  }
  return line;
}

function resolveConfiguredRows({ configRows, selectedCandidates, documentary, materializedRoot, disposition }) {
  return configRows.map(row => {
    lineAt(materializedRoot, row.documentary);
    const candidates = selectedCandidates.filter(candidate => candidate.record.file === row.code.path
      && candidate.record.line === row.code.line && candidate.mention.surface === row.code.surface);
    const mentions = documentary.mentions.filter(mention => mention.file === row.documentary.path
      && mention.lines.includes(row.documentary.line) && mention.surface === row.documentary.surface);
    if (candidates.length !== 1 || mentions.length !== 1
      || !row.documentary.quote.includes(row.documentary.surface)) {
      throw runError('MANUAL_IDENTITY_CITATION_AMBIGUOUS', 'manual identity citation must resolve one code candidate and one exact documentary mention');
    }
    return Object.freeze({ fact_id: candidates[0].fact_id, mention_id: mentions[0].id,
      disposition, basis_kind: row.basis_kind, documentary: row.documentary, code: row.code });
  });
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

function lineQuoteAt(content, line) {
  return content.split(/\r?\n/u)[line - 1] ?? '';
}

function documentaryOccurrences({ documentary, materializedRoot, surface }) {
  const rows = [];
  for (const document of documentary.documents) {
    const content = readFileSync(join(materializedRoot, document.path), 'utf8');
    let from = 0;
    while (surface && from <= content.length - surface.length) {
      const index = content.indexOf(surface, from);
      if (index < 0) break;
      const before = content[index - 1] || '';
      const after = content[index + surface.length] || '';
      if (/[A-Za-z0-9_$]/u.test(before) || /[A-Za-z0-9_$]/u.test(after)) {
        from = index + Math.max(1, surface.length);
        continue;
      }
      const line = lineNumberAt(content, index);
      const lineStart = content.lastIndexOf('\n', index - 1) + 1;
      const byteStart = Buffer.byteLength(content.slice(0, index), 'utf8');
      const mention = documentary.mentions.find(row => row.file === document.path
        && row.surface === surface && row.lines.includes(line));
      const mentionBody = { file: document.path, kind: 'runtime_byte_exact_surface', surface };
      rows.push(Object.freeze({
        path: document.path,
        line,
        span: Object.freeze({
          byte_start: byteStart,
          byte_end: byteStart + Buffer.byteLength(surface, 'utf8'),
          column_start: index - lineStart + 1,
          column_end: index - lineStart + surface.length + 1,
        }),
        quote: lineQuoteAt(content, line),
        mention_id: mention?.id || `mention:${sha256(canonical(mentionBody))}`,
        mention_origin: mention ? 'documentary_plane' : 'runtime_byte_exact_search',
      }));
      from = index + Math.max(1, surface.length);
    }
  }
  return rows.sort((left, right) => compare(left.path, right.path)
    || left.span.byte_start - right.span.byte_start || compare(left.mention_id, right.mention_id));
}

function identityOutcomes({ config, selectedCandidates, documentary, materializedRoot }) {
  const joins = resolveConfiguredRows({ configRows: config.manual_identity_joins,
    selectedCandidates, documentary, materializedRoot, disposition: 'joined' });
  const cannotLinks = resolveConfiguredRows({ configRows: config.explicit_cannot_links,
    selectedCandidates, documentary, materializedRoot, disposition: 'cannot_link' });
  const configured = new Map([...joins, ...cannotLinks].map(row => [row.fact_id, row]));
  if (configured.size !== joins.length + cannotLinks.length) {
    throw runError('MANUAL_IDENTITY_DISPOSITION_CONFLICT', 'one candidate has multiple configured identity outcomes');
  }
  return selectedCandidates.map(candidate => {
    const held = configured.get(candidate.fact_id);
    const occurrences = documentaryOccurrences({ documentary, materializedRoot,
      surface: candidate.mention.surface });
    const rule = held || occurrences.length ? governingRules.admittedBasis
      : governingRules.documentaryOccurrence;
    const basisAnalysis = Object.freeze({
      candidate_basis: candidate.candidate_basis,
      documentary_basis_kinds_considered: Object.freeze([...admittedBasisKinds].sort(compare)),
      configured_basis: held ? Object.freeze({ basis_kind: held.basis_kind,
        mention_id: held.mention_id }) : null,
      byte_exact_documentary_occurrence_count: occurrences.length,
      result: held ? 'admitted_configured_existing_basis'
        : occurrences.length ? 'refused_missing_admissible_documentary_basis'
          : 'refused_no_byte_exact_documentary_occurrence',
    });
    const reason = held ? `manual citation admitted under ${held.basis_kind}; rule ${rule.id}`
      : occurrences.length
        ? `byte-exact documentary search found ${occurrences.length} occurrence(s) of "${candidate.mention.surface}", but no configured source_cited_alias or exact_defined_term_identity basis exists; refused by ${rule.id}`
        : `byte-exact documentary search found no occurrence of "${candidate.mention.surface}" across ${documentary.documents.length} configured document(s); refused by ${rule.id}`;
    const body = {
      schema: 'estate-map/runtime-project-identity-decision/v1',
      fact_id: candidate.fact_id,
      fact_kind: candidate.fact_kind,
      surface: candidate.mention.surface,
      source_locator: { repository: candidate.record.repo, file: candidate.record.file,
        line: candidate.record.line },
      disposition: held?.disposition || 'unresolved',
      reason,
      documentary_occurrences: occurrences,
      code_declarations: [Object.freeze({
        fact_id: candidate.fact_id,
        fact_kind: candidate.fact_kind,
        surface: candidate.mention.surface,
        repository: candidate.record.repo,
        file: candidate.record.file,
        line: candidate.record.line,
        declaration_kind: candidate.record.symbol_kind || candidate.candidate_class,
        candidate_basis: candidate.candidate_basis,
      })],
      considered_basis_analysis: basisAnalysis,
      governing_rule: rule,
      identity_basis: held || null,
    };
    return Object.freeze({ ...body, outcome_id: `identity-outcome:${sha256(canonical(body))}` });
  }).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
}

function measuredExpected(receipt, { include_claim_evidence: includeClaimEvidence = true } = {}) {
  const measured = {
    tree: {
      files: receipt.provenance.tree_files,
      bytes: receipt.provenance.tree_bytes,
      tree_oid: receipt.provenance.tree_oid,
      content_set_digest: receipt.provenance.content_set_digest,
    },
    documentary: {
      documents: receipt.documentary_plane.documents,
      structural_claims: receipt.documentary_plane.structural_claims,
      imported_semantic_claims: receipt.documentary_plane.imported_semantic_claims,
      mentions: receipt.documentary_plane.mentions,
      relation_like_excluded: receipt.excluded_relation_like_observations.total,
      head: receipt.provenance.documentary_plane_head,
    },
    code: {
      facts: receipt.code_plane.facts,
      fact_kinds: receipt.code_plane.fact_kinds,
      fact_kind_inventory: receipt.code_plane.fact_kind_inventory,
      identity_candidates: receipt.scope.full_census_candidates,
      identity_components: receipt.scope.full_census_components,
      head: receipt.provenance.code_plane_head,
    },
    evaluation: {
      evaluated_candidates: receipt.scope.evaluated_candidates,
      pending_candidates: receipt.scope.pending_candidates,
      dispositions: receipt.identity.dispositions,
      manual_join_citations: receipt.identity.manual_join_citations,
    },
  };
  if (includeClaimEvidence) measured.claim_evidence = {
    semantic_claims: receipt.claim_evidence.semantic_claims,
    terminal_receipts: receipt.claim_evidence.terminal_receipts,
    obligation_results: receipt.claim_evidence.obligation_results,
    silent_drops: receipt.claim_evidence.silent_drops,
    verdicts: receipt.claim_evidence.verdicts,
    realizations: receipt.claim_evidence.realizations,
    supersession_edges: receipt.claim_evidence.supersession_edges,
    digest: receipt.claim_evidence.digest,
  };
  return measured;
}

/** Execute documentary and code planes from one exact local Git commit tree. */
export async function runRuntimeProject({
  repository, config_path: configPath, output_dir: outputDir,
  scratch_dir: scratchDir = null, allow_unpinned_profile: allowUnpinnedProfile = false,
}) {
  if (!repository || !configPath || !outputDir || !isAbsolute(outputDir)) {
    throw runError('RUNTIME_PROJECT_INPUT_INVALID', 'repository, config path, and absolute output directory are required');
  }
  const loaded = loadConfig(resolve(configPath));
  const config = loaded.config;
  if (!config.expected && !allowUnpinnedProfile) {
    throw runError('RUNTIME_PROJECT_PROFILE_UNPINNED', 'runtime project profile lacks exact expected measurement pins');
  }
  const runRoot = scratchDir ? resolve(scratchDir)
    : mkdtempSync(join(scratchRoot(), `runtime-project-${config.project_id}-`));
  mkdirSync(runRoot, { recursive: true });
  const estateRoot = join(runRoot, 'estate');
  const materializedRoot = join(estateRoot, config.project_id);
  const materialized = materializeExactGitTree({ repository, sha: config.sha,
    target: materializedRoot, project_id: config.project_id });
  const documentary = buildLocalStructuralDocumentaryPlane({
    materialized_root: materializedRoot,
    tree_manifest: materialized.manifest,
    document_paths: config.documentary_paths,
    imported_semantic_claims: config.imported_semantic_claims || [],
  });
  const extractRoot = join(runRoot, 'extract');
  const mergeRoot = join(runRoot, 'merge');
  await extractEstate(estateRoot, extractRoot, { repo: config.project_id, strict: true });
  await mergeFacts(extractRoot, mergeRoot);
  validateGitTreeMaterialization(materializedRoot, materialized.manifest);
  const extractManifest = JSON.parse(readFileSync(join(extractRoot, '_MANIFEST.json'), 'utf8'));
  const mergeGraph = JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8'));
  const mergeDigest = readFileSync(join(mergeRoot, 'digest.txt'), 'utf8').trim();
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: extractManifest,
    merge_graph: mergeGraph,
    merge_graph_digest: mergeDigest,
    source_head: config.sha,
    required_source_head: config.sha,
    recorded_time: materialized.manifest.commit_time,
  });
  const factRows = exactFactRows(extractRoot, codePlane);
  const claimEvidenceMap = buildClaimEvidenceMap({
    project: { id: config.project_id, sha: config.sha },
    semantic_claims: config.imported_semantic_claims || [],
    materialized_root: materializedRoot,
    tree_manifest: materialized.manifest,
    code_facts: factRows,
  });
  const groups = groupIdentityCandidatesByExactBasis(codePlane.identity_candidates);
  const censusBody = groups.map(group => ({ component_id: group.component_id,
    exact_basis_digest: group.exact_basis_digest,
    candidate_fact_ids: group.members.map(row => row.fact_id).sort() }));
  const censusDigest = sha256(canonical(censusBody));
  const selected = selectIdentityCandidateBatch({ groups, selection: config.identity_selection,
    source_head: config.sha, code_plane_head: codePlane.code_plane_head,
    census_digest: censusDigest });
  if (!selected.receipt.complete) {
    throw runError('RUNTIME_PROJECT_FULL_CENSUS_REQUIRED',
      'runtime project identity evaluation requires identity_selection.mode=all');
  }
  const outcomes = identityOutcomes({ config, selectedCandidates: selected.selected_candidates,
    documentary, materializedRoot });
  const dispositions = {
    joined: outcomes.filter(row => row.disposition === 'joined').length,
    unresolved: outcomes.filter(row => row.disposition === 'unresolved').length,
    cannot_link: outcomes.filter(row => row.disposition === 'cannot_link').length,
    terminal_incomplete: outcomes.filter(row => row.disposition === 'terminal_incomplete').length,
  };
  const maxItems = config.render.max_items;
  const treeFiles = materialized.manifest.files.length;
  const treeBytes = materialized.manifest.files.reduce((sum, row) => sum + row.bytes, 0);
  const receiptBody = {
    schema: RUNTIME_PROJECT_RUN_SCHEMA,
    project: { id: config.project_id, sha: config.sha },
    provenance: {
      source_transport: materialized.manifest.source_transport,
      live_worktree_files_read: false,
      commit_sha: materialized.manifest.commit_sha,
      tree_oid: materialized.manifest.tree_oid,
      tree_files: treeFiles,
      tree_bytes: treeBytes,
      content_set_digest: materialized.manifest.content_set_digest,
      git_tree_manifest_digest: materialized.manifest.manifest_digest,
      documentary_plane_head: documentary.documentary_plane_head,
      code_plane_head: codePlane.code_plane_head,
      policy_config_digest: loaded.digest,
      identity_policy: 'existing exact identity bases only; relation-like observations excluded',
    },
    scope: {
      order: 'full census before complete-component selection',
      full_census_candidates: selected.receipt.total_candidates,
      full_census_components: selected.receipt.total_components,
      evaluated_candidates: selected.receipt.selected_candidate_count,
      evaluated_components: selected.receipt.selected_component_ids.length,
      pending_candidates: selected.receipt.not_evaluated_in_this_batch_count,
      pending_semantics: 'not_evaluated; no semantic disposition',
      inventory: { documentary_claims: documentary.claims.length, code_facts: factRows.length },
      render_cap: maxItems,
      rendered: { documentary_claims: Math.min(maxItems, documentary.claims.length),
        code_facts: Math.min(maxItems, factRows.length), identity_outcomes: Math.min(maxItems, outcomes.length),
        relation_like_observations: Math.min(maxItems, documentary.relation_like_observations.length) },
    },
    documentary_plane: {
      mode: documentary.mode,
      boundary: documentary.authority_boundary.local_claims,
      documents: documentary.documents.length,
      structural_claims: documentary.claims.length,
      imported_semantic_claims: documentary.imported_semantic_claims.length,
      mentions: documentary.mentions.length,
      findings: documentary.findings.length,
      rendered_claims: documentary.claims.slice(0, maxItems),
    },
    code_plane: {
      boundary: 'exact extractor observations; semantic interpretation and relation-to-identity promotion excluded',
      facts: factRows.length,
      fact_kinds: codePlane.verification.fact_kinds,
      fact_kind_inventory: codePlane.inventory.fact_kind_inventory,
      rendered_facts: factRows.slice(0, maxItems),
    },
    identity: {
      policy: 'same-entity joins require a manually cited existing admissible identity basis',
      batch_receipt: selected.receipt,
      census_digest: censusDigest,
      dispositions,
      manual_join_citations: outcomes.filter(row => row.disposition === 'joined').length,
      full_decision_record_count: outcomes.length,
      decision_record_artifact: { path: 'identity-decision-records.json',
        schema: RUNTIME_PROJECT_DECISION_RECORD_SCHEMA, count: outcomes.length,
        digest: sha256(canonical(outcomes)) },
      rendered_outcomes: outcomes.slice(0, maxItems),
      identity_head: `identity-head:${sha256(canonical(outcomes))}`,
    },
    claim_evidence: {
      policy: claimEvidenceMap.policy,
      semantic_claims: claimEvidenceMap.coverage.semantic_claims,
      terminal_receipts: claimEvidenceMap.coverage.terminal_receipts,
      obligation_results: claimEvidenceMap.coverage.obligation_results,
      silent_drops: claimEvidenceMap.coverage.silent_drops,
      verdicts: claimEvidenceMap.coverage.verdicts,
      realizations: claimEvidenceMap.coverage.realizations,
      supersession_edges: claimEvidenceMap.coverage.supersession_edges,
      artifact: { path: 'claim-evidence-map.json', schema: claimEvidenceMap.schema,
        digest: claimEvidenceMap.digest },
      explorer: { path: 'claim-evidence-map.html' },
      digest: claimEvidenceMap.digest,
    },
    excluded_relation_like_observations: {
      total: documentary.relation_like_observations.length,
      identity_admitted: 0,
      rendered: documentary.relation_like_observations.slice(0, maxItems),
    },
    limitations: [
      'Local documentary claims are structural, not semantic product claims.',
      config.imported_semantic_claims?.length
        ? 'Semantic coverage is exact only for the explicitly imported claim set; no all-prose extraction claim is made.'
        : 'No semantic-coverage or favorable target-count claim is made.',
      `Rendered plane rows are capped at ${maxItems}; full denominators and the unbounded identity decision artifact remain exact.`,
    ],
  };
  const receipt = Object.freeze({ ...receiptBody, receipt_digest: sha256(canonical(receiptBody)) });
  const measured = measuredExpected(receipt, {
    include_claim_evidence: config.expected == null || Object.hasOwn(config.expected, 'claim_evidence'),
  });
  if (config.expected && !exact(config.expected, measured)) {
    throw runError('RUNTIME_PROJECT_EXPECTATION_MISMATCH', 'runtime project measurement differs from pinned profile',
      { expected: config.expected, actual: measured });
  }
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'runtime-project-run-receipt.json'), `${canonical(receipt)}\n`);
  const decisionRecord = Object.freeze({
    schema: RUNTIME_PROJECT_DECISION_RECORD_SCHEMA,
    project: receipt.project,
    count: outcomes.length,
    records: outcomes,
  });
  writeFileSync(join(output, 'identity-decision-records.json'), `${canonical(decisionRecord)}\n`);
  const explorer = renderRuntimeProjectExplorer({ receipt, decision_records: outcomes, output_dir: output });
  writeFileSync(join(output, 'claim-evidence-map.json'), `${canonical(claimEvidenceMap)}\n`);
  const claimEvidenceExplorer = await renderClaimEvidenceExplorer({ map: claimEvidenceMap, output_dir: output });
  writeFileSync(join(output, 'measurement.json'), `${JSON.stringify(measured, null, 2)}\n`);
  return Object.freeze({ receipt, measured, explorer, decision_record: decisionRecord,
    claim_evidence_map: claimEvidenceMap, claim_evidence_explorer: claimEvidenceExplorer,
    scratch_root: runRoot });
}

function parse(argv) {
  const held = { allow_unpinned_profile: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--allow-unpinned-profile') held.allow_unpinned_profile = true;
    else if (['--repository', '--config', '--output-dir', '--scratch-dir'].includes(flag)) {
      const value = argv[index + 1];
      if (!value) throw runError('RUNTIME_PROJECT_ARGUMENT_INVALID', `${flag} requires a value`);
      index += 1;
      if (flag === '--repository') held.repository = resolve(value);
      else if (flag === '--config') held.config_path = resolve(value);
      else if (flag === '--output-dir') held.output_dir = resolve(value);
      else held.scratch_dir = resolve(value);
    } else throw runError('RUNTIME_PROJECT_ARGUMENT_INVALID', `unknown argument: ${flag}`);
  }
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRuntimeProject(parse(process.argv.slice(2)));
    console.log(`PASS runtime project ${result.receipt.project.id}@${result.receipt.project.sha}`);
    console.log(`PASS same-SHA planes ${result.receipt.provenance.documentary_plane_head} ${result.receipt.provenance.code_plane_head}`);
    console.log(`PASS dual denominators census=${result.receipt.scope.full_census_candidates} evaluated=${result.receipt.scope.evaluated_candidates} pending=${result.receipt.scope.pending_candidates}`);
    console.log(`PASS claim adjudication claims=${result.receipt.claim_evidence.semantic_claims} receipts=${result.receipt.claim_evidence.terminal_receipts} silent_drops=${result.receipt.claim_evidence.silent_drops}`);
    console.log(`PASS explorer ${result.explorer.page}`);
    console.log(`PASS claim evidence map ${result.claim_evidence_explorer.page}`);
  } catch (error) {
    console.error(`FAIL runtime project run: ${error.stack || error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
