import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaimEvidenceMap } from '../tools/claim-evidence-map.mjs';
import { sha256 } from '../tools/lib.mjs';

function fixture() {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'claim-map-'));
  mkdirSync(join(root, 'src'));
  const docs = [
    '# Decisions',
    'Old behavior is superseded.',
    'Current behavior ships.',
    'Future behavior is proposed.',
    'The runtime has no telemetry.',
    '',
  ].join('\n');
  const source = 'export function currentBehavior() { return true; }\n';
  writeFileSync(join(root, 'DECISIONS.md'), docs);
  writeFileSync(join(root, 'src', 'app.js'), source);
  const sha = 'a'.repeat(40);
  const files = [
    ['DECISIONS.md', docs], ['src/app.js', source],
  ].map(([path, content], index) => ({ path, blob_oid: `${index + 1}`.repeat(40),
    content_sha256: sha256(Buffer.from(content)), bytes: Buffer.byteLength(content) }));
  const manifest = { project_id: 'fixture', commit_sha: sha, tree_oid: 'b'.repeat(40), files };
  const codeFacts = [{
    fact_id: 'code-fact:current', exact_record_digest: sha256('currentBehavior'),
    record: { kind: 'symbol', repo: 'fixture', file: 'src/app.js', line: 1,
      name: 'currentBehavior', symbol_kind: 'function' },
  }];
  const claims = [
    {
      authority_plane: 'imported_semantic', claim_key: 'old', statement: 'Old behavior.',
      claim_kind: 'historical_design', source_status: 'historical', decision_status: 'superseded',
      source: { path: 'DECISIONS.md', line: 2, quote: 'Old behavior is superseded.' },
      proof_plan: { mode: 'all_required', obligations: [
        { kind: 'source_text_present', path: 'DECISIONS.md', line: 2,
          quote: 'Old behavior is superseded.' },
      ] },
    },
    {
      authority_plane: 'imported_semantic', claim_key: 'current', statement: 'Current behavior ships.',
      claim_kind: 'current_capability', source_status: 'current', decision_status: 'implemented',
      source: { path: 'DECISIONS.md', line: 3, quote: 'Current behavior ships.' },
      supersedes_claim_keys: ['old'], supersession_cause: 'explicit_replacement',
      proof_plan: { mode: 'all_required', obligations: [
        { kind: 'code_symbol_declared', symbol: 'currentBehavior', path: 'src/app.js',
          declaration_kind: 'function' },
      ] },
    },
    {
      authority_plane: 'imported_semantic', claim_key: 'future', statement: 'Future behavior.',
      claim_kind: 'proposed_design', source_status: 'aspirational', decision_status: 'proposed',
      source: { path: 'DECISIONS.md', line: 4, quote: 'Future behavior is proposed.' },
      proof_plan: { mode: 'all_required', obligations: [
        { kind: 'source_text_present', path: 'DECISIONS.md', line: 4,
          quote: 'Future behavior is proposed.' },
      ] },
    },
    {
      authority_plane: 'imported_semantic', claim_key: 'negative', statement: 'No telemetry.',
      claim_kind: 'negative_capability', source_status: 'current', decision_status: 'none',
      source: { path: 'DECISIONS.md', line: 5, quote: 'The runtime has no telemetry.' },
      proof_plan: { mode: 'all_required', obligations: [
        { kind: 'open_question', question: 'Does runtime telemetry occur?',
          missing_evidence: 'runtime effect trace unavailable' },
      ] },
    },
  ];
  return { root, sha, manifest, codeFacts, claims };
}

function build(held, claims = held.claims, codeFacts = held.codeFacts) {
  return buildClaimEvidenceMap({
    project: { id: 'fixture', sha: held.sha }, semantic_claims: claims,
    materialized_root: held.root, tree_manifest: held.manifest, code_facts: codeFacts,
  });
}

test('claim map terminates every claim and keeps lifecycle separate from verdict', () => {
  const held = fixture();
  try {
    const map = build(held);
    const receiptByKey = new Map(map.claims.map(claim => [claim.claim_key,
      map.adjudication_receipts.find(receipt => receipt.claim_id === claim.claim_id)]));
    assert.deepEqual({
      coverage: map.coverage,
      old: [receiptByKey.get('old').verdict, receiptByKey.get('old').realization],
      current: [receiptByKey.get('current').verdict, receiptByKey.get('current').realization],
      future: [receiptByKey.get('future').verdict, receiptByKey.get('future').realization],
      negative: [receiptByKey.get('negative').verdict, receiptByKey.get('negative').realization],
    }, {
      coverage: {
        semantic_claims: 4, terminal_receipts: 4, obligation_results: 4, silent_drops: 0,
        verdicts: { supported: 3, refuted: 0, underdetermined: 1, unverifiable: 0 },
        realizations: { not_started: 1, partial: 1, implemented: 0, diverged: 0,
          removed: 1, not_applicable: 0, unknown: 1 },
        supersession_edges: 1,
      },
      // A declaration existing is partial evidence; only an executed check earns `implemented`.
      old: ['supported', 'removed'], current: ['supported', 'partial'],
      future: ['supported', 'not_started'], negative: ['underdetermined', 'unknown'],
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('complete symbol inventory refutes a missing current capability', () => {
  const held = fixture();
  try {
    const claim = structuredClone(held.claims[1]);
    claim.supersedes_claim_keys = [];
    const map = build(held, [claim], []);
    assert.deepEqual({ verdict: map.adjudication_receipts[0].verdict,
      realization: map.adjudication_receipts[0].realization,
      evidence: map.evidence.find(row => row.kind === 'code_symbol_census') }, {
      verdict: 'refuted', realization: 'diverged', evidence: map.evidence.find(row =>
        row.kind === 'code_symbol_census' && row.state === 'refuted'),
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('verification commands execute without inherited secret-bearing environment', () => {
  const held = fixture();
  const prior = process.env.CLAIM_MAP_SECRET_SENTINEL;
  process.env.CLAIM_MAP_SECRET_SENTINEL = 'must-not-leak';
  try {
    const claim = structuredClone(held.claims[2]);
    claim.proof_plan.obligations = [{
      kind: 'verification_check_passed',
      command: [process.execPath, '-e',
        "if (process.env.CLAIM_MAP_SECRET_SENTINEL) process.exit(7); console.log('environment closed')"],
      stdout_pattern: 'environment closed',
    }];
    const map = build(held, [claim]);
    const evidence = map.evidence.find(row => row.kind === 'verification_execution');
    assert.deepEqual({ state: evidence.state, exit_code: evidence.exit_code,
      environment_policy: evidence.environment_policy,
      persisted_output: Object.keys(evidence).some(key => key.endsWith('_tail')) }, {
      state: 'supported', exit_code: 0,
      environment_policy: 'closed-nonsecret-process-environment/v1',
      persisted_output: false,
    });
  } finally {
    if (prior == null) delete process.env.CLAIM_MAP_SECRET_SENTINEL;
    else process.env.CLAIM_MAP_SECRET_SENTINEL = prior;
    rmSync(held.root, { recursive: true, force: true });
  }
});

test('a design claim evidenced only by its own document is never reported as implemented', () => {
  const held = fixture();
  try {
    const claim = structuredClone(held.claims[0]);
    claim.claim_key = 'accepted';
    claim.claim_kind = 'accepted_design';
    claim.decision_status = 'accepted';
    claim.source_status = 'current';
    const map = build(held, [claim], []);
    const receipt = map.adjudication_receipts[0];
    assert.deepEqual({ verdict: receipt.verdict, realization: receipt.realization,
      tiers: receipt.supporting_evidence_tiers },
    { verdict: 'supported', realization: 'unknown', tiers: ['documentary'] });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('claim source quote drift fails closed', () => {
  const held = fixture();
  try {
    const claim = structuredClone(held.claims[0]);
    claim.source.quote = 'invented quote';
    assert.throws(() => build(held, [claim]), error => error.code === 'ESTATE_CLAIM_QUOTE_MISMATCH');
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('supersession requires an explicitly superseded predecessor', () => {
  const held = fixture();
  try {
    const claims = structuredClone(held.claims.slice(0, 2));
    claims[0].decision_status = 'accepted';
    assert.throws(() => build(held, claims), error => error.code === 'CLAIM_SUPERSESSION_INVALID');
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});
