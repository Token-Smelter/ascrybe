#!/usr/bin/env node
// Full-corpus semantic estate map: exact Git tree -> code facts -> semantic claim census ->
// deterministic adjudication -> claim-centered map. Every configured document is extracted, so the
// denominator is closed and every absent claim is attributable to a recorded refusal or a window.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { buildClaimEvidenceMap } from './claim-evidence-map.mjs';
import { writeClaimMapShards } from './claim-map-shards.mjs';
import { renderClaimEvidenceExplorer } from './claim-evidence-explorer.mjs';
import { mergeParentAnswers, offlineNoDispatchRunner } from './delta/documentary-reuse.mjs';
import {
  configuredModel, loadEstateMapRuntimeConfig, validateConfiguredPiModels,
} from './ascrybe-config.mjs';
import { buildCodeGroundedAssertions } from './code-grounded-assertions.mjs';
import { extractEstate } from './extract.mjs';
import { materializeExactGitTree, validateGitTreeMaterialization } from './git-tree-source.mjs';
import { sha256, stableStringify, writeStableCanonical } from './lib.mjs';
import { sourcePins } from './source-pin-identity.mjs';
import { mergeFacts } from './merge.mjs';
import { createPiModelRunner } from './neural-model-runner.mjs';
import { documentaryScope } from './documentary-scope.mjs';
import { extractSemanticClaims } from './semantic-claim-extractor.mjs';

export const SEMANTIC_MAP_RUN_SCHEMA = 'estate-map/semantic-map-run/v1';
const canonical = value => stableStringify(value).trim();
const compare = (left, right) => left.localeCompare(right);
const shellUnsafe = /[|&;<>()$`\\"'*?\[\]#~=%]/u;

function runError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

function scratchRoot() {
  return process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();
}

function exactFactRows(extractRoot, codePlane) {
  const bySelector = new Map(codePlane.inventory.records.map(row => [
    `${row.output_path}\0${row.record_selector}`, row,
  ]));
  const root = join(extractRoot, 'facts');
  return readdirSync(root).filter(name => name.endsWith('.jsonl')).sort(compare).flatMap(name =>
    readFileSync(join(root, name), 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
      const inventory = bySelector.get(`facts/${name}\0jsonl:${index + 1}`);
      if (!inventory) throw runError('CODE_FACT_INVENTORY_MISS', `${name} row ${index + 1} is absent from the code inventory`);
      return Object.freeze({ fact_id: inventory.fact_id, exact_record_digest: inventory.exact_record_digest,
        output_path: `facts/${name}`, record_selector: `jsonl:${index + 1}`, record: JSON.parse(line) });
    }));
}

/** Build the executable-check menu from the project's own declared check profile. */
function declaredChecks(materializedRoot, checksPath) {
  if (!checksPath) return { checks: [], skipped: [] };
  const parsed = parseYaml(readFileSync(join(materializedRoot, checksPath), 'utf8'));
  const overrides = parsed?.overrides || {};
  const checks = [];
  const skipped = [];
  for (const id of Object.keys(overrides).sort(compare)) {
    const entry = overrides[id];
    const command = String(entry?.command ?? '').trim();
    const pattern = entry?.evidence?.execution?.pattern ?? null;
    if (!command || shellUnsafe.test(command)) {
      skipped.push({ id, reason: 'command requires a shell or contains unsupported metacharacters' });
      continue;
    }
    checks.push(Object.freeze({
      id,
      command: command.split(/\s+/u),
      stdout_pattern: pattern,
      timeout_ms: 300000,
    }));
  }
  return { checks, skipped };
}

/**
 * One materialized estate, from one repository or several.
 *
 * Extraction, merge, remap and projection have all handled multi-repository estates for some time
 * -- the projection identifies one by the digest of its ordered {repository: sha} pins. Only this
 * driver assumed a single repository, so the paid documentary read was the one stage that could
 * not run over an estate spanning services. A composite estate is materialized repository by
 * repository, its manifest is the union with each path carrying its repository prefix, and its
 * commit identity is the pins' digest -- the same identity the projection uses.
 */
function materializeEstate({ repository, repositories, config, estateRoot }) {
  if (!repositories) {
    const materializedRoot = join(estateRoot, config.project_id);
    const held = materializeExactGitTree({ repository, sha: config.sha,
      target: materializedRoot, project_id: config.project_id });
    return { materializedRoot, manifest: held.manifest, extractRepo: config.project_id, pins: null };
  }
  const pins = {};
  const files = [];
  const symlinks = [];
  const gitlinks = [];
  let commitTime = null;
  let objectFormat = null;
  for (const [name, path] of Object.entries(repositories).sort(([left], [right]) => left.localeCompare(right))) {
    const sha = config.source_pins?.[name];
    if (!/^[0-9a-f]{40}$/u.test(String(sha || ''))) {
      throw runError('SEMANTIC_MAP_CONFIG_INVALID', `source_pins.${name} must be an exact commit SHA`);
    }
    // Every OTHER declared member is offered first for a declared submodule's own repository -- the
    // same source_repositories priority tools/materialize-estate.mjs applies.
    const held = materializeExactGitTree({ repository: path, sha, target: join(estateRoot, name), project_id: name,
      source_repositories: repositories });
    pins[name] = sha;
    for (const row of held.manifest.files) files.push({ ...row, path: `${name}/${row.path}` });
    for (const row of held.manifest.symlink_entries ?? []) symlinks.push({ ...row, path: `${name}/${row.path}` });
    for (const row of held.manifest.gitlinks ?? []) gitlinks.push({ ...row, path: `${name}/${row.path}` });
    // The estate has no single commit time; the latest pin is the earliest moment all of them held.
    if (!commitTime || held.manifest.commit_time > commitTime) commitTime = held.manifest.commit_time;
    // Repositories on different object formats cannot share one manifest: a blob OID means
    // something different in each, and the validator checks every file against it.
    if (objectFormat && held.manifest.object_format !== objectFormat) {
      throw runError('SEMANTIC_MAP_ESTATE_MIXED_OBJECT_FORMAT',
        `${name} uses Git object format ${held.manifest.object_format}; the estate is ${objectFormat}`);
    }
    objectFormat = held.manifest.object_format;
  }
  const identity = sourcePins({ source_pins: pins });
  if (config.sha !== identity.digest) {
    throw runError('SEMANTIC_MAP_CONFIG_INVALID',
      `config.sha must be the digest of its source pins (${identity.digest}); a composite estate has no single commit`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  symlinks.sort((left, right) => left.path.localeCompare(right.path));
  gitlinks.sort((left, right) => left.path.localeCompare(right.path));
  return { materializedRoot: estateRoot, extractRepo: null, pins,
    manifest: {
      commit_sha: identity.digest, commit_time: commitTime, object_format: objectFormat,
      files, symlink_entries: symlinks, gitlinks,
      content_set_digest: sha256(stableStringify({ files, symlink_entries: symlinks, gitlinks }).trim()),
    } };
}

export async function runSemanticMap({
  repository, repositories = null, config_path: configPath, runtime_config_path: runtimeConfigPath,
  output_dir: outputDir, scratch_dir: scratchDir = null,
  // Delta reuse (tools/delta/documentary-reuse.mjs). `reuse_journals` names retained parent-epoch
  // journals, checked in priority order, before any live dispatch; `offline` forces every window
  // with no match anywhere to a typed refusal instead of a live call -- a zero-spend plan/reuse run.
  reuse_journals: reuseJournals = [], offline = false,
  // A pure single-model map (operator directive): refuse rather than silently absorb a reused answer
  // from a different model, the way a real prior gap (a large share of a "pure" build's answers
  // silently coming from a different model) went uncaught by never checking at all. Default false:
  // a composite/multi-model reuse plan is unaffected.
  require_model: requireModel = false,
}) {
  if ((!repository && !repositories) || !configPath || !runtimeConfigPath || !outputDir || !isAbsolute(outputDir)) {
    throw runError('SEMANTIC_MAP_INPUT_INVALID',
      'a repository or repositories map, project config, runtime config, and absolute output directory are required');
  }
  const configBytes = readFileSync(resolve(configPath));
  const config = JSON.parse(configBytes);
  const runtime = loadEstateMapRuntimeConfig(runtimeConfigPath);
  const modelConfig = configuredModel(runtime, 'documentary_claims');
  const modelPreflight = validateConfiguredPiModels(runtime, { roles: ['documentary_claims'] });
  // A single repository is identified by its commit; a composite estate has no commit, and is
  // identified by the digest of its ordered pins -- which is how the projection identifies one
  // too. Requiring a 40-character SHA of both is what made the paid stage single-repository.
  const shaPattern = repositories ? /^[0-9a-f]{64}$/u : /^[0-9a-f]{40}$/u;
  if (!config.project_id || !shaPattern.test(config.sha || '')
    || !Array.isArray(config.documentary_paths) || !config.documentary_paths.length) {
    throw runError('SEMANTIC_MAP_CONFIG_INVALID',
      `config requires project_id, ${repositories ? 'the digest of its source pins' : 'an exact commit sha'}, and documentary paths`);
  }
  const runRoot = scratchDir ? resolve(scratchDir) : join(scratchRoot(), `semantic-map-${config.project_id}`);
  mkdirSync(runRoot, { recursive: true });
  const estateRoot = join(runRoot, 'estate');
  const materialized = materializeEstate({ repository, repositories, config, estateRoot });
  const materializedRoot = materialized.materializedRoot;
  const extractRoot = join(runRoot, 'extract');
  const mergeRoot = join(runRoot, 'merge');
  await extractEstate(estateRoot, extractRoot, {
    ...(materialized.extractRepo ? { repo: materialized.extractRepo } : {}),
    strict: true, catalog_globs: runtime.config.catalog_globs,
  });
  await mergeFacts(extractRoot, mergeRoot);
  validateGitTreeMaterialization(materializedRoot, materialized.manifest);
  const codePlane = buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: JSON.parse(readFileSync(join(extractRoot, '_MANIFEST.json'), 'utf8')),
    merge_graph: JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8')),
    merge_graph_digest: readFileSync(join(mergeRoot, 'digest.txt'), 'utf8').trim(),
    source_head: config.sha,
    required_source_head: config.sha,
    recorded_time: materialized.manifest.commit_time,
  });
  const factRows = exactFactRows(extractRoot, codePlane);
  const { checks, skipped } = declaredChecks(materializedRoot, config.checks_path || null);
  // The CLI event stream repeats the full partial message per delta; give it real headroom so a
  // long answer is truncated by the ANSWER cap with usage intact, never SIGKILLed mid-stream.
  const runner = offline ? offlineNoDispatchRunner({ model: modelConfig.name }) : createPiModelRunner({
    model: modelConfig.name,
    thinking: modelConfig.thinking,
    timeoutMs: modelConfig.timeout_ms,
    scratchDir: null,
    maxOutputBytes: modelConfig.max_event_bytes,
    maxAnswerBytes: modelConfig.max_answer_bytes,
  });
  // Import every reusable parent answer into THIS run's own journal before extraction starts, so
  // extractSemanticClaims's existing (and already tested) journal-hit path is what actually serves
  // it -- reuse is a seeded-journal mechanism, never a second admission code path.
  const reuseReceipt = reuseJournals.length
    ? mergeParentAnswers({ own_journal_path: join(runRoot, 'extraction-calls.jsonl'), parent_journals: reuseJournals })
    : null;
  // What the model is allowed to read, and why anything was withheld. Structural extraction above
  // already ran over the whole tree; this bounds only the part that costs money.
  const scope = documentaryScope({
    paths: config.documentary_paths,
    materialized_root: materializedRoot,
    exclusions: Array.isArray(config.documentary_exclusions) ? config.documentary_exclusions : [],
    skip_unadjudicable: config.skip_unadjudicable !== false,
  });
  console.log(`SCOPE offered=${scope.counts.offered} reading=${scope.counts.included} `
    + `withheld=${scope.counts.excluded} ${JSON.stringify(scope.counts.excluded_by_category)}`);
  const extraction = await extractSemanticClaims({
    project: { id: config.project_id, sha: config.sha },
    materialized_root: materializedRoot,
    tree_manifest: materialized.manifest,
    document_paths: scope.included,
    code_facts: factRows,
    checks,
    runner,
    journal_dir: runRoot,
    window_bytes: modelConfig.window_bytes,
    ...(modelConfig.max_claims_per_window === undefined ? {}
      : { max_claims_per_window: modelConfig.max_claims_per_window }),
    concurrency: modelConfig.concurrency, require_model: requireModel,
    onProgress: ({ completed, total, window, reused, outcome }) =>
      console.log(`  ${completed}/${total} ${window.path}:${window.start_line}${reused ? ' (journal)' : ''}${outcome && outcome !== 'ok' ? ` outcome=${outcome}` : ''}`),
  });
  const claimMap = buildClaimEvidenceMap({
    project: { id: config.project_id, sha: config.sha },
    semantic_claims: extraction.claims,
    materialized_root: materializedRoot,
    tree_manifest: materialized.manifest,
    code_facts: factRows,
  });
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  const shardManifest = await writeClaimMapShards({
    map: claimMap, output_dir: join(output, 'claim-evidence-shards'),
  });
  const receiptBody = {
    schema: SEMANTIC_MAP_RUN_SCHEMA,
    project: { id: config.project_id, sha: config.sha },
    provenance: {
      source_transport: materialized.manifest.source_transport,
      live_worktree_files_read: false,
      commit_sha: materialized.manifest.commit_sha,
      tree_oid: materialized.manifest.tree_oid,
      content_set_digest: materialized.manifest.content_set_digest,
      code_plane_head: codePlane.code_plane_head,
      project_config_digest: sha256(configBytes),
      runtime_config_digest: runtime.digest,
    },
    runtime: {
      model_role: 'documentary_claims',
      model: modelConfig,
      pi_preflight: modelPreflight,
    },
    // The receipt said the mode was a full census over every configured document. That was true
    // when nothing could be withheld; now that something can, the receipt has to say what was and
    // on whose rule, or a shrunken corpus reads as a complete one.
    documentary_scope: {
      documents: scope.included.slice().sort(compare),
      offered: config.documentary_paths.slice().sort(compare),
      mode: scope.counts.excluded
        ? 'semantic_census_over_documents_in_scope'
        : 'full_semantic_census_over_every_configured_document',
      counts: scope.counts,
      excluded: scope.excluded.slice().sort((left, right) => compare(left.path, right.path)),
      rules: scope.rules,
    },
    code_plane: { facts: factRows.length, fact_kinds: codePlane.verification.fact_kinds },
    declared_checks: { available: checks.map(row => row.id), skipped },
    documentary_reuse: {
      offline,
      parent_journals: reuseJournals.map(row => row.label),
      imported_by_parent: reuseReceipt?.imported_by_parent ?? null,
    },
    extraction: extraction.receipt,
    claim_evidence: {
      policy: claimMap.policy,
      coverage: claimMap.coverage,
      digest: claimMap.digest,
      shard_manifest: {
        path: 'claim-evidence-shards/manifest.json',
        schema: shardManifest.schema,
        digest: shardManifest.manifest_digest,
      },
    },
    limitations: [
      'Claims are model-proposed and deterministically re-verified; a refused proposal is recorded, never dropped.',
      'Cross-document supersession is not auto-detected in this pass; only explicitly represented lifecycle states are used.',
      'Absence obligations bind only the exact declared path set; they never prove estate-wide absence.',
    ],
  };
  const receipt = Object.freeze({ ...receiptBody, receipt_digest: sha256(canonical(receiptBody)) });
  writeFileSync(join(output, 'semantic-map-run-receipt.json'), `${canonical(receipt)}\n`);
  await writeStableCanonical(join(output, 'semantic-claims.json'), extraction.claims);
  await writeStableCanonical(join(output, 'claim-evidence-map.json'), claimMap);
  const explorer = await renderClaimEvidenceExplorer({ map: claimMap, output_dir: output });
  return Object.freeze({ receipt, claim_map: claimMap, extraction, explorer, scratch_root: runRoot,
    documentary_scope: scope });
}

function parse(argv) {
  const held = { reuse_journals: [] };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    // Boolean: never consumes a following token.
    if (flag === '--offline') { held.offline = true; index += 1; continue; }
    if (flag === '--require-model') { held.require_model = true; index += 1; continue; }
    const value = argv[index + 1];
    if (!value) throw runError('SEMANTIC_MAP_ARGUMENT_INVALID', `${flag} requires a value`);
    if (flag === '--repository') held.repository = resolve(value);
    else if (flag === '--config') held.config_path = resolve(value);
    else if (flag === '--runtime-config') held.runtime_config_path = resolve(value);
    else if (flag === '--output-dir') held.output_dir = resolve(value);
    else if (flag === '--scratch-dir') held.scratch_dir = resolve(value);
    // Repeatable: one retained parent journal to reuse from, named for custody
    // (tools/delta/documentary-reuse.mjs). Priority is argument order. An optional trailing
    // `@model` restricts that parent to entries recorded as answered by exactly that model
    // (mergeParentAnswers()'s existing model-scoped reuse) -- omitted, permissive, as before.
    else if (flag === '--reuse-journal') {
      const split = value.indexOf('=');
      if (split < 1) throw runError('SEMANTIC_MAP_ARGUMENT_INVALID', '--reuse-journal requires label=path[@model]');
      const label = value.slice(0, split);
      const rest = value.slice(split + 1);
      const at = rest.lastIndexOf('@');
      const path = at < 0 ? rest : rest.slice(0, at);
      const model = at < 0 ? undefined : rest.slice(at + 1);
      held.reuse_journals.push({ label, path: resolve(path), ...(model ? { model } : {}) });
    }
    else throw runError('SEMANTIC_MAP_ARGUMENT_INVALID', `unknown argument: ${flag}`);
    index += 2;
  }
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSemanticMap(parse(process.argv.slice(2)));
    const conservation = result.receipt.extraction.conservation;
    const coverage = result.receipt.claim_evidence.coverage;
    console.log(`PASS semantic map ${result.receipt.project.id}@${result.receipt.project.sha}`);
    console.log(`PASS extraction windows=${conservation.windows} calls=${conservation.model_calls} proposed=${conservation.proposed_claims} admitted=${conservation.admitted_claims} refused=${conservation.refused_proposals} `
      + `cost_usd=${conservation.reported_cost_usd === null ? 'unknown (provider reported none)' : conservation.reported_cost_usd} `
      + `marginal_usd=${conservation.marginal_cost_usd === null ? 'unknown' : conservation.marginal_cost_usd} `
      + `reused_usd=${conservation.reused_cost_usd === null ? 'unknown' : conservation.reused_cost_usd}`);
    const mc = conservation.model_coverage;
    console.log(`PASS model_coverage expected=${mc.expected_model} answered_by_expected=${mc.answered_by_expected_model} `
      + `answered_by_other=${mc.answered_by_other_model} answered_by_unknown=${mc.answered_by_unknown_model}`);
    console.log(`PASS adjudication claims=${coverage.semantic_claims} receipts=${coverage.terminal_receipts} silent_drops=${coverage.silent_drops}`);
    console.log(`PASS verdicts ${canonical(coverage.verdicts)}`);
    console.log(`PASS realizations ${canonical(coverage.realizations)}`);
    console.log(`PASS map ${result.explorer.page}`);
  } catch (error) {
    console.error(`FAIL semantic map run: ${error.stack || error.message}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
