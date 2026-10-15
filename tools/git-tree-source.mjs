import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';
import {
  DEFAULT_MAX_SUBMODULE_DEPTH, GITLINK_UNREGISTERED_CODE, SUBMODULE_CYCLE_CODE,
  SUBMODULE_DEPTH_EXCEEDED_CODE, SUBMODULE_UNAVAILABLE_CODE, parseGitmodulesText,
  resolveSubmoduleRepository, submoduleCommitPresent,
} from './git-submodule-resolution.mjs';

export const GIT_TREE_SOURCE_SCHEMA = 'estate-map/git-tree-source/v3';
export const GIT_TREE_SOURCE_LIMITS = Object.freeze({
  schema: 'estate-map/git-tree-source-limits/v3',
  object_format: Object.freeze({ supported: 'sha1', refusal_code: 'GIT_OBJECT_FORMAT_UNSUPPORTED' }),
  git_tree_entries: Object.freeze({
    supported_modes: Object.freeze(['100644', '100755']),
    // Git stores a symlink as a blob whose bytes are the target path. Recording that observation
    // exactly — and never writing a link to disk — is more faithful than refusing the whole tree
    // for one entry. The link's target may point anywhere; it is recorded, never resolved.
    symlink_mode: '120000',
    // A gitlink (mode 160000, tree-entry type `commit`) is a pinned reference to another
    // repository, not a reason to refuse the tree that carries it. See `gitlinks` below for how
    // it is handled instead.
    gitlink_mode: '160000',
  }),
  materialization_entries: Object.freeze({
    symlink_refusal_code: 'GIT_MATERIALIZATION_SYMLINK',
    special_file_refusal_code: 'GIT_MATERIALIZATION_SPECIAL_FILE',
  }),
  gitlinks: Object.freeze({
    declared_submodule_unavailable_code: SUBMODULE_UNAVAILABLE_CODE,
    undeclared_gitlink_code: GITLINK_UNREGISTERED_CODE,
    cycle_code: SUBMODULE_CYCLE_CODE,
    depth_exceeded_code: SUBMODULE_DEPTH_EXCEEDED_CODE,
    default_max_depth: DEFAULT_MAX_SUBMODULE_DEPTH,
  }),
  human_text: 'Only SHA-1 Git repositories are supported. Regular file blobs (modes 100644/100755) are materialized; Git symlinks are recorded as exact target observations and never written to disk; materialized symlinks and materialized special files are refused. A declared submodule (named in .gitmodules) whose pinned commit is locally resolvable is materialized exactly, recursively, at its own path, folded into this tree\u2019s identity; one that is not resolvable, an undeclared gitlink, a naming cycle, or a submodule nested past the depth bound is named and counted instead \u2014 never silently included, never guessed, never read from a live checkout.',
});
const canonical = value => stableStringify(value).trim();
const compare = (left, right) => left.localeCompare(right);

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function git(repository, args, options = {}) {
  try {
    return execFileSync('git', ['-C', repository, ...args], {
      maxBuffer: 256 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw sourceError('GIT_OBJECT_READ_FAILED', `git ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function safeTreePath(value) {
  const path = String(value);
  const normalized = posix.normalize(path);
  if (!path || path.includes('\0') || path.includes('\\') || normalized !== path
    || posix.isAbsolute(path) || path === '..' || path.startsWith('../')) {
    throw sourceError('GIT_TREE_PATH_UNSAFE', `unsafe Git tree path: ${JSON.stringify(path)}`);
  }
  return path;
}

function gitBlobOid(bytes, objectFormat) {
  if (objectFormat !== GIT_TREE_SOURCE_LIMITS.object_format.supported) {
    throw sourceError(GIT_TREE_SOURCE_LIMITS.object_format.refusal_code, `unsupported Git object format: ${objectFormat}`);
  }
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Splits one Git tree's entries into regular files, symlinks, and gitlinks. A `commit`-type tree
 * entry is no longer a reason to refuse the whole tree; it is data the caller (below) decides what
 * to do with. */
function parseTreeEntries(repository, commit, objectFormat) {
  const output = git(repository, ['ls-tree', '-r', '-z', '--full-tree', '-l', commit]);
  const files = [];
  const symlinks = [];
  const gitlinkEntries = [];
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw sourceError('GIT_TREE_RECORD_INVALID', 'Git ls-tree record lacks a path separator');
    const header = record.slice(0, tab).trim().split(/\s+/u);
    if (header.length !== 4) throw sourceError('GIT_TREE_RECORD_INVALID', `invalid Git ls-tree header: ${record.slice(0, tab)}`);
    const [mode, type, blobOid, sizeText] = header;
    const path = safeTreePath(record.slice(tab + 1));
    if (type === 'commit') {
      if (mode !== GIT_TREE_SOURCE_LIMITS.git_tree_entries.gitlink_mode || !/^[0-9a-f]{40}$/u.test(blobOid)) {
        throw sourceError('GIT_TREE_ENTRY_UNSUPPORTED', `unexpected commit-type tree entry: ${path}`);
      }
      gitlinkEntries.push(Object.freeze({ path, mode, target_commit: blobOid }));
      continue;
    }
    const symlink = mode === GIT_TREE_SOURCE_LIMITS.git_tree_entries.symlink_mode;
    if (type !== 'blob' || !/^[0-9a-f]+$/u.test(blobOid) || !/^\d+$/u.test(sizeText)
      || (!symlink && !GIT_TREE_SOURCE_LIMITS.git_tree_entries.supported_modes.includes(mode))) {
      throw sourceError('GIT_TREE_ENTRY_UNSUPPORTED', `only regular file, symlink, and gitlink entries are supported: ${path}`);
    }
    const bytes = git(repository, ['cat-file', 'blob', blobOid]);
    const observedOid = gitBlobOid(bytes, objectFormat);
    if (observedOid !== blobOid || bytes.length !== Number(sizeText)) {
      throw sourceError('GIT_BLOB_BINDING_MISMATCH', `Git blob bytes differ from ls-tree metadata: ${path}`);
    }
    if (symlink) {
      // The blob bytes are the link target, recorded verbatim. in_tree is derived metadata: it
      // says whether the normalized target stays inside the repository tree, never that the
      // target exists there. Nothing dereferences the link.
      const target = bytes.toString('utf8');
      const resolvedTarget = posix.normalize(posix.join(posix.dirname(path), target));
      symlinks.push(Object.freeze({
        path, mode, blob_oid: blobOid, bytes: bytes.length, content_sha256: sha256(bytes),
        symlink_target: target,
        target_in_tree: !posix.isAbsolute(target) && resolvedTarget !== '..' && !resolvedTarget.startsWith('../'),
      }));
      continue;
    }
    files.push(Object.freeze({
      path, mode, blob_oid: blobOid, bytes: bytes.length, content_sha256: sha256(bytes), content: bytes,
    }));
  }
  const allPaths = [...files.map(row => row.path), ...symlinks.map(row => row.path), ...gitlinkEntries.map(row => row.path)];
  if (new Set(allPaths).size !== allPaths.length) throw sourceError('GIT_TREE_DUPLICATE_PATH', 'Git tree contains duplicate materialization paths');
  return {
    files: files.sort((left, right) => compare(left.path, right.path)),
    symlinks: symlinks.sort((left, right) => compare(left.path, right.path)),
    gitlinkEntries: gitlinkEntries.sort((left, right) => compare(left.path, right.path)),
  };
}

/** Reads `.gitmodules` at `commit` from the already-fetched file list, if tracked there -- never a
 * live path, never the working tree. Absent entirely is an empty declaration map, exactly like a
 * tree with no submodules at all. */
function readGitmodules(fileEntries) {
  const entry = fileEntries.find(row => row.path === '.gitmodules');
  if (!entry) return new Map();
  return parseGitmodulesText(entry.content.toString('utf8'));
}

function withPrefix(path, prefix) { return prefix ? posix.join(prefix, path) : path; }

function countGitlinks(gitlinks) {
  const counts = { materialized: 0, unavailable: 0, unregistered: 0, cycle_refused: 0, depth_exceeded: 0 };
  for (const link of gitlinks) if (link.status in counts) counts[link.status] += 1;
  return Object.freeze(counts);
}

/**
 * Materializes one Git tree node (the outermost repository, or one declared submodule reached by
 * recursion) into `targetDir`, and returns both its OWN local manifest body (paths relative to
 * ITSELF, recorded as the submodule's own pin) and the FLATTENED file/symlink/gitlink lists with
 * paths prefixed relative to the OUTERMOST root -- what the top-level manifest validates against
 * disk. Cycles are refused by declared submodule NAME along the current recursion chain, never by
 * repository content; depth is bounded the same way.
 */
function materializeGitTreeNode({
  repository, sha, targetDir, pathPrefix, sourceRepositories, maxSubmoduleDepth, depth, visitedNames,
}) {
  const commit = git(repository, ['rev-parse', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
  if (commit !== sha) throw sourceError('GIT_COMMIT_MISMATCH', `requested SHA resolved to a different commit: ${commit}`);
  const objectFormat = git(repository, ['rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim();
  const tree = git(repository, ['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim();
  const commitTime = git(repository, ['show', '-s', '--format=%cI', sha], { encoding: 'utf8' }).trim();
  const { files: rawFiles, symlinks: rawSymlinks, gitlinkEntries } = parseTreeEntries(repository, sha, objectFormat);
  const declaredByPath = readGitmodules(rawFiles);

  mkdirSync(targetDir, { recursive: true });
  for (const record of rawFiles) {
    const path = join(targetDir, record.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, record.content, { flag: 'wx' });
    if (record.mode === '100755') chmodSync(path, 0o755);
  }

  const flatFiles = rawFiles.map(({ content: _content, ...record }) => ({ ...record, path: withPrefix(record.path, pathPrefix) }));
  const flatSymlinks = rawSymlinks.map(record => ({ ...record, path: withPrefix(record.path, pathPrefix) }));
  const flatGitlinks = [];
  const localGitlinks = [];

  for (const link of gitlinkEntries) {
    const declaredName = declaredByPath.get(link.path) || null;
    const prefixedPath = withPrefix(link.path, pathPrefix);
    if (!declaredName) {
      flatGitlinks.push({ path: prefixedPath, mode: link.mode, target_commit: link.target_commit,
        kind: 'undeclared_gitlink', status: 'unregistered' });
      localGitlinks.push({ path: link.path, mode: link.mode, target_commit: link.target_commit, kind: 'undeclared_gitlink' });
      continue;
    }
    const local = { path: link.path, mode: link.mode, target_commit: link.target_commit,
      kind: 'declared_submodule', submodule_name: declaredName };
    localGitlinks.push(local);
    if (visitedNames.includes(declaredName)) {
      flatGitlinks.push({ ...local, path: prefixedPath, status: 'cycle_refused' });
      continue;
    }
    if (depth >= maxSubmoduleDepth) {
      flatGitlinks.push({ ...local, path: prefixedPath, status: 'depth_exceeded' });
      continue;
    }
    const resolved = resolveSubmoduleRepository({
      parentRepository: repository, name: declaredName, path: link.path, sourceRepositories,
    });
    if (!resolved || !submoduleCommitPresent(resolved.repository, link.target_commit)) {
      flatGitlinks.push({ ...local, path: prefixedPath, status: 'unavailable' });
      continue;
    }
    const nested = materializeGitTreeNode({
      repository: resolved.repository, sha: link.target_commit, targetDir: join(targetDir, link.path),
      pathPrefix: prefixedPath, sourceRepositories, maxSubmoduleDepth, depth: depth + 1,
      visitedNames: [...visitedNames, declaredName],
    });
    flatFiles.push(...nested.flatFiles);
    flatSymlinks.push(...nested.flatSymlinks);
    flatGitlinks.push({ ...local, path: prefixedPath, status: 'materialized', resolved_via: resolved.resolved_via,
      submodule_manifest_digest: nested.own.manifest_digest });
    flatGitlinks.push(...nested.flatGitlinks);
  }

  const body = {
    commit_sha: commit, tree_oid: tree, object_format: objectFormat, commit_time: commitTime,
    files: rawFiles.map(({ content: _content, ...record }) => record),
    symlink_entries: rawSymlinks,
    gitlinks: localGitlinks,
  };
  const own = Object.freeze({ ...body, manifest_digest: sha256(canonical(body)) });
  return { own, flatFiles, flatSymlinks, flatGitlinks };
}

function filesUnder(root, current = root, held = []) {
  for (const name of readdirSync(current).sort(compare)) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw sourceError(GIT_TREE_SOURCE_LIMITS.materialization_entries.symlink_refusal_code, `materialization contains a symlink: ${relative(root, path)}`);
    if (stat.isDirectory()) filesUnder(root, path, held);
    else if (stat.isFile()) held.push(relative(root, path).split(sep).join('/'));
    else throw sourceError(GIT_TREE_SOURCE_LIMITS.materialization_entries.special_file_refusal_code, `materialization contains a special file: ${relative(root, path)}`);
  }
  return held.sort(compare);
}

export function validateGitTreeMaterialization(materializedRoot, manifest) {
  const root = resolve(materializedRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw sourceError('GIT_MATERIALIZATION_MISSING', 'Git tree materialization root is absent');
  }
  const expected = manifest.files.map(row => row.path);
  const observed = filesUnder(root);
  if (canonical(expected) !== canonical(observed)) {
    throw sourceError('GIT_MATERIALIZATION_SET_MISMATCH', 'Git tree materialization has extra or missing files');
  }
  for (const file of manifest.files) {
    const bytes = readFileSync(join(root, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.content_sha256
      || gitBlobOid(bytes, manifest.object_format) !== file.blob_oid) {
      throw sourceError('GIT_MATERIALIZATION_CONTENT_MISMATCH', `materialized content differs from Git blob: ${file.path}`);
    }
  }
  return Object.freeze({ files: observed.length, content_set_digest: manifest.content_set_digest });
}

/**
 * Read and materialize one exact commit solely through the local Git object database. A gitlink
 * (a submodule reference) is never a reason to refuse: `source_repositories` (an explicitly
 * declared peer, checked first), the parent's `.git/modules/<name>`, and the checked-out
 * submodule's own `.git` are tried in order (tools/git-submodule-resolution.mjs); a resolvable,
 * present pin recurses and is folded in exactly, at its own path; anything else is named and
 * counted in `manifest.gitlinks`/`manifest.gitlink_counts`, never silently included.
 */
export function materializeExactGitTree({
  repository, sha, target, project_id: projectId,
  source_repositories: sourceRepositories = {}, max_submodule_depth: maxSubmoduleDepth = DEFAULT_MAX_SUBMODULE_DEPTH,
}) {
  if (!repository || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha || '') || !projectId || !target) {
    throw sourceError('GIT_TREE_INPUT_INVALID', 'repository, exact 40- or 64-hex SHA, project id, and target are required');
  }
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length) {
    throw sourceError('GIT_MATERIALIZATION_TARGET_NOT_EMPTY', 'Git tree materialization target must be absent or empty');
  }
  mkdirSync(root, { recursive: true });
  const node = materializeGitTreeNode({
    repository: resolve(repository), sha, targetDir: root, pathPrefix: '',
    sourceRepositories, maxSubmoduleDepth, depth: 0, visitedNames: [],
  });
  const files = node.flatFiles.sort((left, right) => compare(left.path, right.path));
  const symlinks = node.flatSymlinks.sort((left, right) => compare(left.path, right.path));
  const gitlinks = node.flatGitlinks.sort((left, right) => compare(left.path, right.path));
  const body = {
    schema: GIT_TREE_SOURCE_SCHEMA,
    project_id: projectId,
    commit_sha: node.own.commit_sha,
    tree_oid: node.own.tree_oid,
    object_format: node.own.object_format,
    commit_time: node.own.commit_time,
    source_transport: 'local_git_object_database_only',
    live_worktree_files_read: false,
    enforced_refusal_limits: GIT_TREE_SOURCE_LIMITS,
    files,
    symlink_entries: symlinks,
    gitlinks,
    gitlink_counts: countGitlinks(gitlinks),
    // Folds gitlinks into the tree's own identity: a submodule's pinned commit changing (even one
    // this tree could not materialize either way) changes content_set_digest, because the record
    // includes target_commit -- identity never rests solely on which bytes happened to be readable.
    content_set_digest: sha256(canonical({ files, symlink_entries: symlinks, gitlinks })),
  };
  const manifest = Object.freeze({ ...body, manifest_digest: sha256(canonical(body)) });
  validateGitTreeMaterialization(root, manifest);
  return Object.freeze({ root, manifest });
}
