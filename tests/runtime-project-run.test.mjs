import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRuntimeProject } from '../tools/runtime-project-run.mjs';
import { queryRuntimeProject } from '../tools/runtime-project-query.mjs';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  }).trim();
}

function fixture() {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'runtime-project-run-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'README.md'), [
    '# Fixture Project',
    '',
    '`validateProject` is declared below.',
    '',
    '```js',
    'validateProject();',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'src', 'app.js'), 'export function validateProject() { return true; }\n');
  writeFileSync(join(repo, 'src', 'other.js'), 'export function validateProject() { return false; }\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'Create exact runtime fixture']);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'README.md'), '# Dirty replacement\n');
  writeFileSync(join(repo, 'untracked.md'), '# Untracked\n');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    schema: 'estate-map/runtime-project-config/v1',
    project_id: 'fixture-project',
    sha,
    documentary_paths: ['README.md'],
    imported_semantic_claims: [],
    identity_selection: { mode: 'all' },
    manual_identity_joins: [],
    explicit_cannot_links: [],
    render: { max_items: 20 },
  }));
  return { root, repo, sha, configPath };
}

test('runtime project binds both planes to one commit and keeps relations outside identity', async () => {
  const held = fixture();
  try {
    const result = await runRuntimeProject({
      repository: held.repo,
      config_path: held.configPath,
      output_dir: join(held.root, 'output'),
      scratch_dir: join(held.root, 'scratch'),
      allow_unpinned_profile: true,
    });
    const receipt = result.receipt;
    const pending = receipt.identity.batch_receipt.candidate_rows
      .filter(row => row.evaluation_state === 'not_evaluated_in_this_batch');
    const decision = result.decision_record.records.find(row => row.surface === 'validateProject');
    const query = queryRuntimeProject({ input_dir: join(held.root, 'output'), query: 'validateProject' });
    const explorer = readFileSync(result.explorer.page, 'utf8');
    assert.deepEqual({
      project_sha: receipt.project.sha,
      provenance_sha: receipt.provenance.commit_sha,
      live_read: receipt.provenance.live_worktree_files_read,
      documentary_mode: receipt.documentary_plane.mode,
      relation_like: receipt.excluded_relation_like_observations.total > 0,
      relation_identity_admitted: receipt.excluded_relation_like_observations.identity_admitted,
      full_census: receipt.scope.full_census_candidates,
      evaluated: receipt.scope.evaluated_candidates,
      pending_dispositions: pending.filter(row => Object.hasOwn(row, 'disposition')).length,
      imported_semantic: receipt.documentary_plane.imported_semantic_claims,
      explorer_declares_sha: explorer.includes(held.sha),
      explorer_searchable: explorer.includes('id="entity-search"'),
      explorer_honest_count: explorer.includes('Rendered 5 of 5 full-census decisions (cap 20).'),
      full_decision_count: receipt.identity.full_decision_record_count,
      claim_evidence: receipt.claim_evidence,
      claim_map_exists: readFileSync(result.claim_evidence_explorer.page, 'utf8')
        .includes('0</strong><span>semantic claims'),
      persisted_decision_count: JSON.parse(readFileSync(join(held.root, 'output',
        'identity-decision-records.json'), 'utf8')).count,
      occurrence: decision.documentary_occurrences.map(row => ({ path: row.path, line: row.line,
        quote: row.quote, mention_id: row.mention_id, exact_span: row.span.byte_end > row.span.byte_start })),
      declarations: query.records.flatMap(row => row.code_declarations)
        .map(row => `${row.file}:${row.line}`).sort(),
      governing_rule: decision.governing_rule.id,
      basis_result: decision.considered_basis_analysis.result,
      query_matches: query.matched_decisions,
      query_denominator: query.full_census_denominator,
    }, {
      project_sha: held.sha,
      provenance_sha: held.sha,
      live_read: false,
      documentary_mode: 'structural_only',
      relation_like: true,
      relation_identity_admitted: 0,
      // 3 -> 5 with design section 17 (2026-08-13): the fixture's two source files enter the
      // census as module candidates alongside the two validateProject symbols and the repo.
      full_census: 5,
      evaluated: 5,
      pending_dispositions: 0,
      imported_semantic: 0,
      explorer_declares_sha: true,
      explorer_searchable: true,
      explorer_honest_count: true,
      full_decision_count: 5,
      claim_evidence: {
        policy: result.claim_evidence_map.policy,
        semantic_claims: 0,
        terminal_receipts: 0,
        obligation_results: 0,
        silent_drops: 0,
        verdicts: { supported: 0, refuted: 0, underdetermined: 0, unverifiable: 0 },
        realizations: { not_started: 0, partial: 0, implemented: 0, diverged: 0,
          removed: 0, not_applicable: 0, unknown: 0 },
        supersession_edges: 0,
        artifact: { path: 'claim-evidence-map.json', schema: 'estate-map/claim-evidence-map/v1',
          digest: result.claim_evidence_map.digest },
        explorer: { path: 'claim-evidence-map.html' },
        digest: result.claim_evidence_map.digest,
      },
      claim_map_exists: true,
      persisted_decision_count: 5,
      occurrence: [
        { path: 'README.md', line: 3, quote: '`validateProject` is declared below.',
          mention_id: decision.documentary_occurrences[0].mention_id, exact_span: true },
        { path: 'README.md', line: 6, quote: 'validateProject();',
          mention_id: decision.documentary_occurrences[1].mention_id, exact_span: true },
      ],
      declarations: ['src/app.js:1', 'src/other.js:1'],
      governing_rule: 'identity.manual-citation-existing-basis/v1',
      basis_result: 'refused_missing_admissible_documentary_basis',
      query_matches: 2,
      query_denominator: 5,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});
