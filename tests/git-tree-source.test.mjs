import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_TREE_SOURCE_LIMITS, materializeExactGitTree, validateGitTreeMaterialization,
} from '../tools/git-tree-source.mjs';

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
  const root = mkdtempSync(join(scratch, 'git-tree-source-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'a'), { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'a-'), 'prefix collision peer\n');
  writeFileSync(join(repo, 'a', 'nested'), 'prefix collision nested\n');
  writeFileSync(join(repo, 'docs', 'source.md'), '# Committed source\n');
  writeFileSync(join(repo, 'tracked.txt'), 'committed bytes\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'Create fixture']);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'tracked.txt'), 'dirty replacement\n');
  writeFileSync(join(repo, 'untracked.txt'), 'must never materialize\n');
  return { root, repo, sha };
}

test('exact Git object materialization uses one total path ordering', () => {
  const held = fixture();
  try {
    const target = join(held.root, 'materialized');
    const result = materializeExactGitTree({ repository: held.repo, sha: held.sha,
      target, project_id: 'fixture' });
    assert.deepEqual({
      committed: readFileSync(join(target, 'tracked.txt'), 'utf8'),
      paths: result.manifest.files.map(row => row.path),
      source: result.manifest.source_transport,
      live_read: result.manifest.live_worktree_files_read,
      commit: result.manifest.commit_sha,
    }, {
      committed: 'committed bytes\n',
      paths: ['a-', 'a/nested', 'docs/source.md', 'tracked.txt'],
      source: 'local_git_object_database_only',
      live_read: false,
      commit: held.sha,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('materialization manifest discloses the enforced refusal limits', () => {
  const held = fixture();
  try {
    const result = materializeExactGitTree({ repository: held.repo, sha: held.sha,
      target: join(held.root, 'materialized'), project_id: 'fixture' });
    assert.deepEqual({
      machine: result.manifest.enforced_refusal_limits,
      human_mentions: ['SHA-1', 'symlinks', 'submodules'].every(term =>
        result.manifest.enforced_refusal_limits.human_text.includes(term)),
    }, { machine: GIT_TREE_SOURCE_LIMITS, human_mentions: true });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('materialization validation fails closed on extras and misses', () => {
  const held = fixture();
  try {
    const target = join(held.root, 'materialized');
    const result = materializeExactGitTree({ repository: held.repo, sha: held.sha,
      target, project_id: 'fixture' });
    writeFileSync(join(target, 'extra'), 'extra');
    assert.throws(() => validateGitTreeMaterialization(target, result.manifest),
      error => error.code === 'GIT_MATERIALIZATION_SET_MISMATCH');
    rmSync(join(target, 'extra'));
    rmSync(join(target, 'tracked.txt'));
    assert.throws(() => validateGitTreeMaterialization(target, result.manifest),
      error => error.code === 'GIT_MATERIALIZATION_SET_MISMATCH');
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('materialization validation refuses symlinks', () => {
  const held = fixture();
  try {
    const target = join(held.root, 'materialized');
    const result = materializeExactGitTree({ repository: held.repo, sha: held.sha,
      target, project_id: 'fixture' });
    rmSync(join(target, 'tracked.txt'));
    symlinkSync('docs/source.md', join(target, 'tracked.txt'));
    assert.throws(() => validateGitTreeMaterialization(target, result.manifest),
      error => error.code === GIT_TREE_SOURCE_LIMITS.materialization_entries.symlink_refusal_code);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('a Git symlink entry is recorded exactly and never written to disk', () => {
  const held = fixture();
  try {
    rmSync(join(held.repo, 'tracked.txt'));
    symlinkSync('docs/source.md', join(held.repo, 'tracked.txt'));
    symlinkSync('../outside/secret', join(held.repo, 'escape.link'));
    git(held.repo, ['add', 'tracked.txt', 'escape.link']);
    git(held.repo, ['commit', '-qm', 'Add symlinks']);
    const symlinkSha = git(held.repo, ['rev-parse', 'HEAD']);
    const target = join(held.root, 'symlink-tree');
    const result = materializeExactGitTree({ repository: held.repo, sha: symlinkSha, target, project_id: 'fixture' });
    const entries = Object.fromEntries(result.manifest.symlink_entries.map(row => [row.path, row]));
    assert.deepEqual({
      recorded: [entries['tracked.txt'].symlink_target, entries['tracked.txt'].target_in_tree],
      escape: [entries['escape.link'].symlink_target, entries['escape.link'].target_in_tree],
      materializedFiles: result.manifest.files.map(row => row.path).includes('tracked.txt'),
      noLinkOnDisk: existsSync(join(target, 'tracked.txt')) || existsSync(join(target, 'escape.link')),
      validates: validateGitTreeMaterialization(target, result.manifest).content_set_digest === result.manifest.content_set_digest,
    }, {
      recorded: ['docs/source.md', true],
      escape: ['../outside/secret', false],
      materializedFiles: false,
      noLinkOnDisk: false,
      validates: true,
    });
    git(held.repo, ['reset', '--hard', held.sha]);

    git(held.repo, ['reset', '--hard', held.sha]);
    git(held.repo, ['update-index', '--add', '--cacheinfo', `160000,${held.sha},vendor/submodule`]);
    git(held.repo, ['commit', '-qm', 'Add submodule entry']);
    const submoduleSha = git(held.repo, ['rev-parse', 'HEAD']);
    assert.throws(() => materializeExactGitTree({ repository: held.repo, sha: submoduleSha,
      target: join(held.root, 'submodule-tree'), project_id: 'fixture' }),
    error => error.code === GIT_TREE_SOURCE_LIMITS.git_tree_entries.submodule_refusal_code);
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('Git tree source refuses non-SHA-1 object formats', () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'git-tree-sha256-'));
  const repo = join(root, 'repo');
  try {
    mkdirSync(repo);
    git(repo, ['init', '-q', '--object-format=sha256']);
    writeFileSync(join(repo, 'source.txt'), 'sha256 object\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'Create SHA-256 fixture']);
    const sha = git(repo, ['rev-parse', 'HEAD']);
    assert.throws(() => materializeExactGitTree({ repository: repo, sha,
      target: join(root, 'materialized'), project_id: 'fixture' }),
    error => error.code === GIT_TREE_SOURCE_LIMITS.object_format.refusal_code);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
