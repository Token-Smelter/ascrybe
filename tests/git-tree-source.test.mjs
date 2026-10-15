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
      human_mentions: ['SHA-1', 'symlinks', 'submodule'].every(term =>
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
    git(held.repo, ['commit', '-qm', 'Add an undeclared gitlink']);
    const gitlinkSha = git(held.repo, ['rev-parse', 'HEAD']);
    // An undeclared gitlink (no .gitmodules entry) no longer refuses the whole tree: it is named
    // and counted, and everything else in the tree still materializes exactly.
    const gitlinkResult = materializeExactGitTree({ repository: held.repo, sha: gitlinkSha,
      target: join(held.root, 'gitlink-tree'), project_id: 'fixture' });
    assert.deepEqual({
      filesIncludeTracked: gitlinkResult.manifest.files.map(row => row.path).includes('tracked.txt'),
      gitlinks: gitlinkResult.manifest.gitlinks,
      counts: gitlinkResult.manifest.gitlink_counts,
    }, {
      filesIncludeTracked: true,
      gitlinks: [{ path: 'vendor/submodule', mode: '160000', target_commit: held.sha,
        kind: 'undeclared_gitlink', status: 'unregistered' }],
      counts: { materialized: 0, unavailable: 0, unregistered: 1, cycle_refused: 0, depth_exceeded: 0 },
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('a declared submodule resolved through .git/modules materializes recursively at its own path', () => {
  const held = fixture();
  try {
    const childRepo = join(held.root, 'child');
    mkdirSync(childRepo, { recursive: true });
    git(childRepo, ['init', '-q']);
    writeFileSync(join(childRepo, 'child.txt'), 'child content\n');
    git(childRepo, ['add', '-A']);
    git(childRepo, ['commit', '-qm', 'Create child']);
    const childSha = git(childRepo, ['rev-parse', 'HEAD']);

    git(held.repo, ['reset', '--hard', held.sha]);
    git(held.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRepo, 'vendor/child']);
    git(held.repo, ['commit', '-qm', 'Add declared submodule']);
    const parentSha = git(held.repo, ['rev-parse', 'HEAD']);

    const target = join(held.root, 'declared-tree');
    const result = materializeExactGitTree({ repository: held.repo, sha: parentSha, target, project_id: 'fixture' });
    assert.deepEqual({
      childFile: readFileSync(join(target, 'vendor', 'child', 'child.txt'), 'utf8'),
      gitlinks: result.manifest.gitlinks.map(row => ({ path: row.path, kind: row.kind, status: row.status, resolved_via: row.resolved_via })),
      counts: result.manifest.gitlink_counts,
      validates: validateGitTreeMaterialization(target, result.manifest).content_set_digest === result.manifest.content_set_digest,
    }, {
      childFile: 'child content\n',
      gitlinks: [{ path: 'vendor/child', kind: 'declared_submodule', status: 'materialized', resolved_via: 'git_modules_dir' }],
      counts: { materialized: 1, unavailable: 0, unregistered: 0, cycle_refused: 0, depth_exceeded: 0 },
      validates: true,
    });
    assert.equal(childSha, git(childRepo, ['rev-parse', 'HEAD']));
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('a declared submodule via source_repositories is preferred over .git/modules', () => {
  const held = fixture();
  try {
    const childRepoA = join(held.root, 'child-a');
    mkdirSync(childRepoA, { recursive: true });
    git(childRepoA, ['init', '-q']);
    writeFileSync(join(childRepoA, 'child.txt'), 'from A\n');
    git(childRepoA, ['add', '-A']);
    git(childRepoA, ['commit', '-qm', 'A']);

    git(held.repo, ['reset', '--hard', held.sha]);
    git(held.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRepoA, 'vendor/child']);
    git(held.repo, ['commit', '-qm', 'Add declared submodule']);
    const parentSha = git(held.repo, ['rev-parse', 'HEAD']);
    const childSha = git(join(held.repo, 'vendor', 'child'), ['rev-parse', 'HEAD']);

    // A DIFFERENT clone that ALSO has the pinned commit -- proving source_repositories is what got
    // used, not .git/modules (which also exists and would otherwise resolve the same commit).
    const childRepoB = join(held.root, 'child-b');
    execFileSync('git', ['clone', '-q', childRepoA, childRepoB]);

    const target = join(held.root, 'declared-tree-source-repos');
    const result = materializeExactGitTree({ repository: held.repo, sha: parentSha, target, project_id: 'fixture',
      source_repositories: { 'vendor/child': childRepoB } });
    assert.deepEqual({
      resolvedVia: result.manifest.gitlinks[0].resolved_via,
      childFile: readFileSync(join(target, 'vendor', 'child', 'child.txt'), 'utf8'),
    }, { resolvedVia: 'source_repositories', childFile: 'from A\n' });
    assert.equal(childSha, git(childRepoB, ['rev-parse', 'HEAD']));
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('a declared submodule whose pinned commit is absent everywhere is named and counted, not refused', () => {
  const held = fixture();
  try {
    git(held.repo, ['reset', '--hard', held.sha]);
    writeFileSync(join(held.repo, '.gitmodules'), '[submodule "phantom"]\n\tpath = vendor/phantom\n\turl = ../phantom.git\n');
    git(held.repo, ['add', '.gitmodules']);
    git(held.repo, ['update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},vendor/phantom`]);
    git(held.repo, ['commit', '-qm', 'Declare an unresolvable submodule']);
    const sha = git(held.repo, ['rev-parse', 'HEAD']);

    const target = join(held.root, 'unavailable-tree');
    const result = materializeExactGitTree({ repository: held.repo, sha, target, project_id: 'fixture' });
    assert.deepEqual({
      gitlinks: result.manifest.gitlinks.map(row => ({ path: row.path, kind: row.kind, status: row.status })),
      counts: result.manifest.gitlink_counts,
      vendorAbsent: !existsSync(join(target, 'vendor')),
    }, {
      gitlinks: [{ path: 'vendor/phantom', kind: 'declared_submodule', status: 'unavailable' }],
      counts: { materialized: 0, unavailable: 1, unregistered: 0, cycle_refused: 0, depth_exceeded: 0 },
      vendorAbsent: true,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('nested submodules materialize recursively at their own paths', () => {
  const held = fixture();
  try {
    const grandchild = join(held.root, 'grandchild');
    mkdirSync(grandchild, { recursive: true });
    git(grandchild, ['init', '-q']);
    writeFileSync(join(grandchild, 'leaf.txt'), 'leaf\n');
    git(grandchild, ['add', '-A']);
    git(grandchild, ['commit', '-qm', 'grandchild']);

    const child = join(held.root, 'nested-child');
    mkdirSync(child, { recursive: true });
    git(child, ['init', '-q']);
    writeFileSync(join(child, 'child.txt'), 'child\n');
    git(child, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', grandchild, 'inner']);
    git(child, ['add', '-A']);
    git(child, ['commit', '-qm', 'child with grandchild submodule']);

    git(held.repo, ['reset', '--hard', held.sha]);
    git(held.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'outer']);
    git(held.repo, ['commit', '-qm', 'nested submodule chain']);
    const parentSha = git(held.repo, ['rev-parse', 'HEAD']);
    // `submodule add` clones ONLY the outer submodule itself, never its own nested submodules --
    // the SAME reason a bare `git clone` of a repo with submodules leaves them uninitialized.
    // Populating `outer`'s OWN .git/modules/inner (and its checkout) is what makes "inner"
    // resolvable at all; without this the fixture would test an operator gap, not this function.
    git(held.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);

    const target = join(held.root, 'nested-tree');
    const result = materializeExactGitTree({ repository: held.repo, sha: parentSha, target, project_id: 'fixture' });
    assert.deepEqual({
      leaf: readFileSync(join(target, 'outer', 'inner', 'leaf.txt'), 'utf8'),
      statuses: result.manifest.gitlinks.map(row => ({ path: row.path, status: row.status })),
    }, {
      leaf: 'leaf\n',
      statuses: [{ path: 'outer', status: 'materialized' }, { path: 'outer/inner', status: 'materialized' }],
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

// Cycle detection is by declared NAME along the current recursion chain, not by repository
// content -- constructed directly (update-index + a hand-written .gitmodules) rather than via
// `git submodule add`, which refuses to declare a name already checked out elsewhere in the same
// repository and would fight this fixture rather than build it.
test('a declared submodule name repeated deeper in its own chain is refused as a cycle, never infinitely recursed', () => {
  const held = fixture();
  try {
    const grandchild = join(held.root, 'cycle-grandchild');
    mkdirSync(grandchild, { recursive: true });
    git(grandchild, ['init', '-q']);
    writeFileSync(join(grandchild, 'leaf.txt'), 'leaf\n');
    git(grandchild, ['add', '-A']);
    git(grandchild, ['commit', '-qm', 'grandchild']);
    const grandchildSha = git(grandchild, ['rev-parse', 'HEAD']);

    const child = join(held.root, 'cycle-child');
    mkdirSync(child, { recursive: true });
    git(child, ['init', '-q']);
    writeFileSync(join(child, 'child.txt'), 'child\n');
    // The child declares a submodule named "shared" -- the SAME name the parent will also declare.
    writeFileSync(join(child, '.gitmodules'), '[submodule "shared"]\n\tpath = inner\n\turl = ../unused.git\n');
    git(child, ['add', 'child.txt', '.gitmodules']);
    git(child, ['update-index', '--add', '--cacheinfo', `160000,${grandchildSha},inner`]);
    git(child, ['commit', '-qm', 'child declares submodule "shared" at inner']);

    git(held.repo, ['reset', '--hard', held.sha]);
    writeFileSync(join(held.repo, '.gitmodules'), '[submodule "shared"]\n\tpath = outer\n\turl = ../unused.git\n');
    git(held.repo, ['add', '.gitmodules']);
    const childSha = git(child, ['rev-parse', 'HEAD']);
    git(held.repo, ['update-index', '--add', '--cacheinfo', `160000,${childSha},outer`]);
    git(held.repo, ['commit', '-qm', 'root declares submodule "shared" at outer']);
    const parentSha = git(held.repo, ['rev-parse', 'HEAD']);

    const target = join(held.root, 'cycle-tree');
    const result = materializeExactGitTree({
      repository: held.repo, sha: parentSha, target, project_id: 'fixture',
      source_repositories: { shared: child },
    });
    // The root's OWN "shared" (-> child) resolves via source_repositories and materializes; once
    // inside the child, ITS "shared" (-> grandchild) hits the same declared name already on the
    // chain and is refused as a cycle -- "inner" never appears on disk, and nothing infinitely
    // recurses despite source_repositories still offering the SAME repository for "shared" again.
    assert.deepEqual({
      childFile: readFileSync(join(target, 'outer', 'child.txt'), 'utf8'),
      statuses: result.manifest.gitlinks.map(row => ({ path: row.path, status: row.status, submodule_name: row.submodule_name })),
      counts: result.manifest.gitlink_counts,
      innerAbsent: !existsSync(join(target, 'outer', 'inner')),
    }, {
      childFile: 'child\n',
      statuses: [
        { path: 'outer', status: 'materialized', submodule_name: 'shared' },
        { path: 'outer/inner', status: 'cycle_refused', submodule_name: 'shared' },
      ],
      counts: { materialized: 1, unavailable: 0, unregistered: 0, cycle_refused: 1, depth_exceeded: 0 },
      innerAbsent: true,
    });
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

test('a submodule chain nested past the depth bound is refused as depth-exceeded, not recursed further', () => {
  const held = fixture();
  try {
    // A 2-level chain (root -> a -> b), materialized with max_submodule_depth: 1 so the SECOND
    // level (depth 1, at the point it would recurse) is refused rather than followed.
    const leaf = join(held.root, 'depth-leaf');
    mkdirSync(leaf, { recursive: true });
    git(leaf, ['init', '-q']);
    writeFileSync(join(leaf, 'leaf.txt'), 'leaf\n');
    git(leaf, ['add', '-A']);
    git(leaf, ['commit', '-qm', 'leaf']);

    const mid = join(held.root, 'depth-mid');
    mkdirSync(mid, { recursive: true });
    git(mid, ['init', '-q']);
    writeFileSync(join(mid, 'mid.txt'), 'mid\n');
    git(mid, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leaf, 'leaf-dir']);
    git(mid, ['add', '-A']);
    git(mid, ['commit', '-qm', 'mid with leaf submodule']);

    git(held.repo, ['reset', '--hard', held.sha]);
    git(held.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', mid, 'mid-dir']);
    git(held.repo, ['commit', '-qm', 'root with mid submodule']);
    const parentSha = git(held.repo, ['rev-parse', 'HEAD']);

    const target = join(held.root, 'depth-tree');
    const result = materializeExactGitTree({
      repository: held.repo, sha: parentSha, target, project_id: 'fixture', max_submodule_depth: 1,
    });
    assert.deepEqual({
      statuses: result.manifest.gitlinks.map(row => ({ path: row.path, status: row.status })),
      leafDirAbsent: !existsSync(join(target, 'mid-dir', 'leaf-dir')),
    }, {
      statuses: [
        { path: 'mid-dir', status: 'materialized' },
        { path: 'mid-dir/leaf-dir', status: 'depth_exceeded' },
      ],
      leafDirAbsent: true,
    });
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
