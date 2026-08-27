import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, stableCanonicalSha256, stableStringify } from './lib.mjs';

export const CLAIM_EVIDENCE_MAP_SCHEMA = 'estate-map/claim-evidence-map/v1';
export const ESTATE_CLAIM_SCHEMA = 'estate-map/estate-claim/v1';
export const CLAIM_EVIDENCE_SCHEMA = 'estate-map/claim-evidence/v1';
export const CLAIM_OBLIGATION_RESULT_SCHEMA = 'estate-map/claim-obligation-result/v1';
export const CLAIM_ADJUDICATION_RECEIPT_SCHEMA = 'estate-map/claim-adjudication-receipt/v1';
export const CLAIM_SUPERSESSION_RECEIPT_SCHEMA = 'estate-map/claim-supersession-receipt/v1';
export const ASCRYBE_EDGE_SCHEMA = 'estate-map/estate-map-edge/v1';

const canonical = value => stableStringify(value).trim();
const exact = (left, right) => canonical(left) === canonical(right);
const compare = (left, right) => left.localeCompare(right);
const clean = value => String(value ?? '').trim();
const claimKinds = new Set([
  'current_capability', 'current_architecture', 'negative_capability', 'accepted_design',
  'proposed_design', 'historical_design',
]);
const sourceStatuses = new Set(['current', 'historical', 'aspirational', 'deprecated', 'disputed']);
const decisionStatuses = new Set([
  'none', 'draft', 'proposed', 'accepted', 'rejected', 'implemented', 'superseded',
]);
const obligationKinds = new Set([
  'code_symbol_declared', 'source_text_present', 'tree_paths_exact', 'tree_paths_present',
  'tree_text_absent', 'verification_check_passed', 'open_question',
]);
const relationKinds = new Set([
  'about', 'realized_by', 'supported_by', 'contradicted_by', 'unresolved_against',
  'superseded_by', 'refines', 'derived_from', 'depends_on',
]);

function mapError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  throw error;
}

function immutableRecord(schema, prefix, body, idField) {
  const record = Object.freeze({ schema, ...body });
  return Object.freeze({ ...record, [idField]: `${prefix}:${sha256(canonical(record))}` });
}

function sourceLine(root, path, line) {
  return readFileSync(join(root, path), 'utf8').split(/\r?\n/u)[line - 1] ?? null;
}

function normalizeClaim(raw, manifestByPath, root) {
  if (raw?.authority_plane !== 'imported_semantic' || !clean(raw.claim_key)
    || !clean(raw.statement) || !claimKinds.has(raw.claim_kind)
    || !sourceStatuses.has(raw.source_status) || !decisionStatuses.has(raw.decision_status)
    || !raw.source?.path || !Number.isInteger(raw.source?.line) || raw.source.line < 1
    || !clean(raw.source?.quote) || raw.proof_plan?.mode !== 'all_required'
    || !Array.isArray(raw.proof_plan?.obligations) || !raw.proof_plan.obligations.length) {
    mapError('ESTATE_CLAIM_INVALID', `semantic claim ${raw?.claim_key || '<missing>'} is incomplete`);
  }
  const manifest = manifestByPath.get(raw.source.path);
  if (!manifest) mapError('ESTATE_CLAIM_SOURCE_OUTSIDE_TREE', `${raw.claim_key} source is outside the exact tree`);
  const line = sourceLine(root, raw.source.path, raw.source.line);
  if (line == null || !line.includes(raw.source.quote)) {
    mapError('ESTATE_CLAIM_QUOTE_MISMATCH', `${raw.source.path}:${raw.source.line} does not contain the exact claim quote`);
  }
  for (const [index, obligation] of raw.proof_plan.obligations.entries()) {
    if (!obligationKinds.has(obligation?.kind)) {
      mapError('CLAIM_OBLIGATION_KIND_UNSUPPORTED', `${raw.claim_key} obligation ${index} has unsupported kind ${obligation?.kind}`);
    }
  }
  const body = {
    claim_key: raw.claim_key,
    statement: raw.statement,
    claim_kind: raw.claim_kind,
    source_status: raw.source_status,
    decision_status: raw.decision_status,
    valid_time: raw.valid_time ?? null,
    source: Object.freeze({ path: raw.source.path, line: raw.source.line, quote: raw.source.quote,
      blob_oid: manifest.blob_oid, content_sha256: manifest.content_sha256 }),
    supersedes_claim_keys: Object.freeze([...(raw.supersedes_claim_keys || [])].sort(compare)),
    supersession_cause: raw.supersession_cause || null,
    proof_plan: Object.freeze(structuredClone(raw.proof_plan)),
  };
  return immutableRecord(ESTATE_CLAIM_SCHEMA, 'estate-claim', body, 'claim_id');
}

function evidence(kind, state, body) {
  return immutableRecord(CLAIM_EVIDENCE_SCHEMA, 'claim-evidence', { kind, state, ...body }, 'evidence_id');
}

function exactSourceEvidence(claim, project) {
  return evidence('documentary_source', 'supported', {
    project_sha: project.sha,
    claim_id: claim.claim_id,
    source: claim.source,
  });
}

function matchCodeSymbols(obligation, codeFacts) {
  return codeFacts.filter(fact => fact.record.kind === 'symbol'
    && fact.record.name === obligation.symbol
    && (!obligation.path || fact.record.file === obligation.path)
    && (!obligation.declaration_kind || fact.record.symbol_kind === obligation.declaration_kind))
    .map(fact => Object.freeze({ fact_id: fact.fact_id, evidence_id: null,
      exact_record_digest: fact.exact_record_digest,
      surface: fact.record.name, repository: fact.record.repo,
      file: fact.record.file, line: fact.record.line,
      declaration_kind: fact.record.symbol_kind || null }))
    .sort((left, right) => left.fact_id.localeCompare(right.fact_id));
}

function safePath(root, path) {
  const target = resolve(root, path || '.');
  if (target !== root && !target.startsWith(`${root}/`)) {
    mapError('CLAIM_EVIDENCE_PATH_ESCAPE', `evidence path escapes the exact tree: ${path}`);
  }
  return target;
}

function executeVerification(obligation, root) {
  if (!Array.isArray(obligation.command) || !obligation.command.length
    || obligation.command.some(value => !clean(value))) {
    mapError('CLAIM_VERIFICATION_COMMAND_INVALID', 'verification command must be a non-empty argv array');
  }
  const cwd = safePath(root, obligation.cwd || '.');
  const timeout = Number.isInteger(obligation.timeout_ms) && obligation.timeout_ms > 0
    ? obligation.timeout_ms : 120_000;
  const temp = process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || root;
  const environment = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    TZ: 'UTC',
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CI: '1',
    NO_COLOR: '1',
    PYTHONNOUSERSITE: '1',
  };
  const result = spawnSync(obligation.command[0], obligation.command.slice(1), {
    cwd, encoding: 'utf8', env: environment, timeout, maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  let patternMatched = true;
  if (obligation.stdout_pattern) {
    try { patternMatched = new RegExp(obligation.stdout_pattern, 'u').test(stdout); }
    catch { mapError('CLAIM_VERIFICATION_PATTERN_INVALID', 'verification stdout pattern is not a valid regular expression'); }
  }
  const state = result.error?.code === 'ETIMEDOUT' ? 'unverifiable'
    : result.error ? 'unverifiable'
      : result.status === 0 && patternMatched ? 'supported' : 'refuted';
  return evidence('verification_execution', state, {
    command: obligation.command,
    cwd: obligation.cwd || '.',
    environment_policy: 'closed-nonsecret-process-environment/v1',
    exit_code: result.status,
    signal: result.signal || null,
    stdout_pattern: obligation.stdout_pattern || null,
    stdout_pattern_matched: patternMatched,
    stdout_digest: sha256(stdout),
    stderr_digest: sha256(stderr),
    error_code: result.error?.code || null,
  });
}

function evaluateObligation({ claim, obligation, index, project, root, manifest, manifestByPath,
  codeFacts, executionCache }) {
  const obligationBody = { claim_id: claim.claim_id, index, obligation };
  const obligationId = `claim-obligation:${sha256(canonical(obligationBody))}`;
  let record;
  let reason;
  if (obligation.kind === 'code_symbol_declared') {
    if (!clean(obligation.symbol)) mapError('CLAIM_SYMBOL_OBLIGATION_INVALID', `${claim.claim_key} has an empty symbol`);
    const matches = matchCodeSymbols(obligation, codeFacts);
    const requireUnique = obligation.require_unique !== false;
    const state = matches.length === 0 ? 'refuted'
      : requireUnique && matches.length !== 1 ? 'underdetermined' : 'supported';
    record = evidence('code_symbol_census', state, {
      project_sha: project.sha,
      complete_inventory: true,
      requested: { symbol: obligation.symbol, path: obligation.path || null,
        declaration_kind: obligation.declaration_kind || null, require_unique: requireUnique },
      matches,
    });
    reason = matches.length === 0 ? 'complete symbol census contains no matching declaration'
      : state === 'underdetermined' ? 'complete symbol census contains multiple matching declarations'
        : 'complete symbol census contains the requested declaration';
  } else if (obligation.kind === 'source_text_present') {
    const entry = manifestByPath.get(obligation.path);
    if (!entry || !Number.isInteger(obligation.line) || !clean(obligation.quote)) {
      mapError('CLAIM_SOURCE_TEXT_OBLIGATION_INVALID', `${claim.claim_key} source-text obligation is incomplete`);
    }
    const line = sourceLine(root, obligation.path, obligation.line);
    const state = line?.includes(obligation.quote) ? 'supported' : 'refuted';
    record = evidence('source_text', state, {
      project_sha: project.sha, path: obligation.path, line: obligation.line,
      quote: obligation.quote, observed_line: line, blob_oid: entry.blob_oid,
      content_sha256: entry.content_sha256,
    });
    reason = state === 'supported' ? 'exact Git blob contains the cited text on the cited line'
      : 'exact Git blob does not contain the cited text on the cited line';
  } else if (obligation.kind === 'tree_paths_exact') {
    if (!Array.isArray(obligation.paths) || !obligation.paths.length) {
      mapError('CLAIM_TREE_PATH_OBLIGATION_INVALID', `${claim.claim_key} tree path obligation is empty`);
    }
    const prefix = clean(obligation.prefix).replace(/\/$/u, '');
    const expected = [...new Set(obligation.paths)].sort(compare);
    const observed = manifest.files.map(row => row.path)
      .filter(path => !prefix || path === prefix || path.startsWith(`${prefix}/`)).sort(compare);
    const state = exact(expected, observed) ? 'supported' : 'refuted';
    record = evidence('git_tree_path_set', state, {
      project_sha: project.sha, tree_oid: manifest.tree_oid, prefix, expected_paths: expected,
      observed_paths: observed, missing_paths: expected.filter(path => !observed.includes(path)),
      extra_paths: observed.filter(path => !expected.includes(path)),
    });
    reason = state === 'supported' ? 'exact Git tree path set matches the declared architecture'
      : 'exact Git tree path set differs from the declared architecture';
  } else if (obligation.kind === 'tree_paths_present') {
    // Weaker and more common than an exact set: the claim names files that must exist. It says
    // nothing about what else the tree contains.
    if (!Array.isArray(obligation.paths) || !obligation.paths.length) {
      mapError('CLAIM_TREE_PATH_OBLIGATION_INVALID', `${claim.claim_key} path-presence obligation is empty`);
    }
    const expected = [...new Set(obligation.paths)].sort(compare);
    const missing = expected.filter(path => !manifestByPath.has(path));
    const state = missing.length ? 'refuted' : 'supported';
    record = evidence('git_tree_path_presence', state, {
      project_sha: project.sha, tree_oid: manifest.tree_oid, expected_paths: expected, missing_paths: missing,
    });
    reason = state === 'supported' ? 'every cited path exists in the exact Git tree'
      : 'a cited path is absent from the exact Git tree';
  } else if (obligation.kind === 'tree_text_absent') {
    if (!Array.isArray(obligation.paths) || !obligation.paths.length
      || !Array.isArray(obligation.needles) || !obligation.needles.length) {
      mapError('CLAIM_TREE_TEXT_OBLIGATION_INVALID', `${claim.claim_key} tree-text absence obligation is incomplete`);
    }
    const hits = [];
    for (const path of [...new Set(obligation.paths)].sort(compare)) {
      if (!manifestByPath.has(path)) mapError('CLAIM_TREE_TEXT_PATH_OUTSIDE_TREE', `${path} is absent from the exact tree`);
      const content = readFileSync(safePath(root, path), 'utf8');
      for (const needle of obligation.needles) if (content.includes(needle)) hits.push({ path, needle });
    }
    const state = hits.length ? 'refuted' : 'supported';
    record = evidence('closed_tree_text_search', state, {
      project_sha: project.sha, complete_paths: [...new Set(obligation.paths)].sort(compare),
      needles: [...new Set(obligation.needles)].sort(compare), hits,
    });
    reason = state === 'supported' ? 'byte-exact search found no requested text in the complete declared path set'
      : 'byte-exact search found requested text in the complete declared path set';
  } else if (obligation.kind === 'verification_check_passed') {
    const key = canonical({ command: obligation.command, cwd: obligation.cwd || '.',
      stdout_pattern: obligation.stdout_pattern || null, timeout_ms: obligation.timeout_ms || null });
    record = executionCache.get(key);
    if (!record) {
      record = executeVerification(obligation, root);
      executionCache.set(key, record);
    }
    reason = record.state === 'supported' ? 'explicit project verification command passed and attested'
      : record.state === 'refuted' ? 'explicit project verification command failed or omitted its attestation'
        : 'explicit project verification command could not be executed';
  } else if (obligation.kind === 'open_question') {
    record = evidence('open_question', 'underdetermined', {
      question: obligation.question,
      missing_evidence: obligation.missing_evidence || null,
      closed_world: false,
    });
    reason = 'claim requires evidence outside the currently complete inventories';
  }
  const resultBody = {
    claim_id: claim.claim_id,
    obligation_id: obligationId,
    obligation_kind: obligation.kind,
    state: record.state,
    evidence_ids: [record.evidence_id],
    reason,
  };
  const result = immutableRecord(CLAIM_OBLIGATION_RESULT_SCHEMA, 'claim-obligation-result',
    resultBody, 'result_id');
  return { record, result };
}

function adjudicationVerdict(results) {
  if (results.some(row => row.state === 'refuted')) return 'refuted';
  if (results.some(row => row.state === 'unverifiable')) return 'unverifiable';
  if (results.some(row => row.state === 'underdetermined')) return 'underdetermined';
  return 'supported';
}

// Evidence strength is not uniform. A document repeating itself is not implementation evidence, and
// a declaration existing is not the same as behavior being exercised. Realization reads the tier of
// the evidence that actually supported the claim.
const EVIDENCE_TIER = Object.freeze({
  verification_execution: 'executed',
  code_symbol_census: 'declared',
  git_tree_path_set: 'declared',
  git_tree_path_presence: 'declared',
  closed_tree_text_search: 'declared',
  documentary_source: 'documentary',
  source_text: 'documentary',
  open_question: 'none',
});

function supportedTiers(results, evidenceById) {
  const tiers = new Set();
  for (const row of results) {
    if (row.result.state !== 'supported') continue;
    tiers.add(EVIDENCE_TIER[row.record.kind] || 'none');
  }
  return tiers;
}

function realizationFor(claim, verdict, tiers) {
  if (['underdetermined', 'unverifiable'].includes(verdict)) return 'unknown';
  const executed = tiers.has('executed');
  const declared = tiers.has('declared');
  if (claim.claim_kind === 'proposed_design') return verdict === 'supported' ? 'not_started' : 'diverged';
  if (claim.claim_kind === 'historical_design') {
    if (verdict !== 'supported') return 'diverged';
    // A "previous behavior" claim supported only by the document record is consistent with removal;
    // live implementation evidence for it means the history claim is not settled here.
    return executed || declared ? 'unknown' : 'removed';
  }
  if (verdict !== 'supported') {
    return claim.claim_kind === 'accepted_design' ? 'not_started' : 'diverged';
  }
  // Implemented requires the behavior to have been exercised; a declaration alone is partial.
  if (executed) return 'implemented';
  if (declared) return 'partial';
  return 'unknown';
}

function edge(type, from, to, basisReceiptId = null) {
  if (!relationKinds.has(type)) mapError('ASCRYBE_RELATION_UNSUPPORTED', `unsupported map relation ${type}`);
  return immutableRecord(ASCRYBE_EDGE_SCHEMA, 'estate-map-edge', {
    relation: type, from, to, basis_receipt_id: basisReceiptId,
  }, 'edge_id');
}

function buildSupersession(claims, sourceEvidenceByClaim) {
  const byKey = new Map(claims.map(claim => [claim.claim_key, claim]));
  const successorByOld = new Map();
  const receipts = [];
  for (const claim of claims) for (const oldKey of claim.supersedes_claim_keys) {
    const old = byKey.get(oldKey);
    if (!old) mapError('CLAIM_SUPERSESSION_ENDPOINT_MISSING', `${claim.claim_key} supersedes unknown claim ${oldKey}`);
    if (old.claim_id === claim.claim_id || old.decision_status !== 'superseded') {
      mapError('CLAIM_SUPERSESSION_INVALID', `${oldKey} is not a distinct superseded claim`);
    }
    if (successorByOld.has(old.claim_id)) mapError('CLAIM_SUPERSESSION_FORK', `${oldKey} has multiple successors`);
    successorByOld.set(old.claim_id, claim.claim_id);
    const body = {
      old_claim_id: old.claim_id,
      new_claim_id: claim.claim_id,
      cause: claim.supersession_cause || 'explicit_replacement',
      basis_evidence_ids: [sourceEvidenceByClaim.get(old.claim_id).evidence_id,
        sourceEvidenceByClaim.get(claim.claim_id).evidence_id].sort(compare),
    };
    receipts.push(immutableRecord(CLAIM_SUPERSESSION_RECEIPT_SCHEMA,
      'claim-supersession-receipt', body, 'receipt_id'));
  }
  for (const start of successorByOld.keys()) {
    const seen = new Set();
    let current = start;
    while (successorByOld.has(current)) {
      if (seen.has(current)) mapError('CLAIM_SUPERSESSION_CYCLE', `supersession chain cycles at ${current}`);
      seen.add(current); current = successorByOld.get(current);
    }
  }
  return receipts.sort((left, right) => left.receipt_id.localeCompare(right.receipt_id));
}

/** Compile lifecycle-aware claim evidence over one exact Git tree and deterministic code census. */
export function buildClaimEvidenceMap({ project, semantic_claims: semanticClaims,
  materialized_root: materializedRoot, tree_manifest: treeManifest,
  code_facts: codeFacts = [] }) {
  if (!project?.id || !/^[0-9a-f]{40}$/u.test(project.sha || '')
    || project.sha !== treeManifest?.commit_sha || !Array.isArray(semanticClaims)) {
    mapError('CLAIM_EVIDENCE_INPUT_INVALID', 'claim evidence requires one project and its exact Git tree');
  }
  const root = resolve(materializedRoot);
  const manifestByPath = new Map(treeManifest.files.map(row => [row.path, row]));
  const claims = semanticClaims.map(raw => normalizeClaim(raw, manifestByPath, root))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
  if (new Set(claims.map(row => row.claim_key)).size !== claims.length) {
    mapError('ESTATE_CLAIM_KEY_DUPLICATE', 'semantic claim keys must be unique');
  }
  const evidenceById = new Map();
  const sourceEvidenceByClaim = new Map();
  const results = [];
  const receipts = [];
  const edges = [];
  const executionCache = new Map();
  for (const claim of claims) {
    const sourceEvidence = exactSourceEvidence(claim, project);
    evidenceById.set(sourceEvidence.evidence_id, sourceEvidence);
    sourceEvidenceByClaim.set(claim.claim_id, sourceEvidence);
    edges.push(edge('derived_from', claim.claim_id, sourceEvidence.evidence_id));
    const heldResults = claim.proof_plan.obligations.map((obligation, index) =>
      evaluateObligation({ claim, obligation, index, project, root, manifest: treeManifest,
        manifestByPath, codeFacts, executionCache }));
    for (const held of heldResults) {
      evidenceById.set(held.record.evidence_id, held.record);
      results.push(held.result);
    }
    const verdict = adjudicationVerdict(heldResults.map(row => row.result));
    const tiers = supportedTiers(heldResults, evidenceById);
    const realization = realizationFor(claim, verdict, tiers);
    const evidenceIds = [...new Set([sourceEvidence.evidence_id,
      ...heldResults.map(row => row.record.evidence_id)])].sort(compare);
    const receiptBody = {
      claim_id: claim.claim_id,
      project_sha: project.sha,
      documentary_evidence_id: sourceEvidence.evidence_id,
      obligation_result_ids: heldResults.map(row => row.result.result_id).sort(compare),
      verdict,
      realization,
      supporting_evidence_tiers: [...tiers].sort(compare),
      evidence_ids: evidenceIds,
    };
    const receipt = immutableRecord(CLAIM_ADJUDICATION_RECEIPT_SCHEMA,
      'claim-adjudication-receipt', receiptBody, 'receipt_id');
    receipts.push(receipt);
    for (const held of heldResults) {
      const relation = held.result.state === 'supported' ? 'supported_by'
        : held.result.state === 'refuted' ? 'contradicted_by' : 'unresolved_against';
      edges.push(edge(relation, claim.claim_id, held.record.evidence_id, receipt.receipt_id));
      if (held.record.kind === 'code_symbol_census') for (const match of held.record.matches) {
        edges.push(edge('about', claim.claim_id, match.fact_id, receipt.receipt_id));
        if (['implemented', 'partial'].includes(realization)) {
          edges.push(edge('realized_by', claim.claim_id, match.fact_id, receipt.receipt_id));
        }
      }
    }
  }
  const supersessionReceipts = buildSupersession(claims, sourceEvidenceByClaim);
  for (const receipt of supersessionReceipts) {
    edges.push(edge('superseded_by', receipt.old_claim_id, receipt.new_claim_id, receipt.receipt_id));
  }
  const verdicts = Object.fromEntries(['supported', 'refuted', 'underdetermined', 'unverifiable']
    .map(verdict => [verdict, receipts.filter(row => row.verdict === verdict).length]));
  const realizationKinds = ['not_started', 'partial', 'implemented', 'diverged', 'removed',
    'not_applicable', 'unknown'];
  const realizations = Object.fromEntries(realizationKinds
    .map(state => [state, receipts.filter(row => row.realization === state).length]));
  const body = {
    schema: CLAIM_EVIDENCE_MAP_SCHEMA,
    project: Object.freeze(structuredClone(project)),
    policy: {
      adjudication_denominator: 'every imported semantic claim receives one terminal receipt',
      verdict_order: ['refuted', 'unverifiable', 'underdetermined', 'supported'],
      closed_world_absence: 'allowed only for an explicit complete inventory or path set',
      supersession: 'explicit authoritative successor only; implementation drift never implies supersession',
    },
    claims: Object.freeze(claims),
    evidence: Object.freeze([...evidenceById.values()].sort((left, right) =>
      left.evidence_id.localeCompare(right.evidence_id))),
    obligation_results: Object.freeze(results.sort((left, right) => left.result_id.localeCompare(right.result_id))),
    adjudication_receipts: Object.freeze(receipts.sort((left, right) => left.receipt_id.localeCompare(right.receipt_id))),
    supersession_receipts: Object.freeze(supersessionReceipts),
    edges: Object.freeze([...new Map(edges.map(row => [row.edge_id, row])).values()]
      .sort((left, right) => left.edge_id.localeCompare(right.edge_id))),
    coverage: Object.freeze({
      semantic_claims: claims.length,
      terminal_receipts: receipts.length,
      obligation_results: results.length,
      silent_drops: claims.length - receipts.length,
      verdicts,
      realizations,
      supersession_edges: supersessionReceipts.length,
    }),
  };
  if (body.coverage.silent_drops !== 0 || body.coverage.terminal_receipts !== claims.length) {
    mapError('CLAIM_ADJUDICATION_CONSERVATION', 'every semantic claim requires exactly one terminal receipt');
  }
  // Corpus-scale claim maps exceed the V8 maximum string length under whole-object
  // stringification; the streaming canonical digest hashes the exact same bytes (atlas precedent).
  return Object.freeze({ ...body, digest: stableCanonicalSha256(body) });
}
