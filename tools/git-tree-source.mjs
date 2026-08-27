import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const GIT_TREE_SOURCE_SCHEMA = 'estate-map/git-tree-source/v2';
export const GIT_TREE_SOURCE_LIMITS = Object.freeze({
  schema: 'estate-map/git-tree-source-limits/v2',
  object_format: Object.freeze({ supported: 'sha1', refusal_code: 'GIT_OBJECT_FORMAT_UNSUPPORTED' }),
  git_tree_entries: Object.freeze({
    supported_modes: Object.freeze(['100644', '100755']),
    // Git stores a symlink as a blob whose bytes are the target path. Recording that observation
    // exactly — and never writing a link to disk — is more faithful than refusing the whole tree
    // for one entry. The link's target may point anywhere; it is recorded, never resolved.
    symlink_mode: '120000',
    submodule_refusal_code: 'GIT_TREE_ENTRY_UNSUPPORTED',
  }),
  materialization_entries: Object.freeze({
    symlink_refusal_code: 'GIT_MATERIALIZATION_SYMLINK',
    special_file_refusal_code: 'GIT_MATERIALIZATION_SPECIAL_FILE',
  }),
  human_text: 'Only SHA-1 Git repositories are supported. Regular file blobs (modes 100644/100755) are materialized; Git symlinks are recorded as exact target observations and never written to disk; submodules, materialized symlinks, and materialized special files are refused.',
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

function parseTree(repository, commit, objectFormat) {
  const output = git(repository, ['ls-tree', '-r', '-z', '--full-tree', '-l', commit]);
  const records = output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    if (tab < 0) throw sourceError('GIT_TREE_RECORD_INVALID', 'Git ls-tree record lacks a path separator');
    const header = record.slice(0, tab).trim().split(/\s+/u);
    if (header.length !== 4) throw sourceError('GIT_TREE_RECORD_INVALID', `invalid Git ls-tree header: ${record.slice(0, tab)}`);
    const [mode, type, blobOid, sizeText] = header;
    const path = safeTreePath(record.slice(tab + 1));
    const symlink = mode === GIT_TREE_SOURCE_LIMITS.git_tree_entries.symlink_mode;
    if (type !== 'blob' || !/^[0-9a-f]+$/u.test(blobOid) || !/^\d+$/u.test(sizeText)
      || (!symlink && !GIT_TREE_SOURCE_LIMITS.git_tree_entries.supported_modes.includes(mode))) {
      throw sourceError('GIT_TREE_ENTRY_UNSUPPORTED', `only regular file and symlink blobs are supported: ${path}`);
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
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      return Object.freeze({
        path, mode, blob_oid: blobOid, bytes: bytes.length, content_sha256: sha256(bytes),
        symlink_target: target,
        target_in_tree: !posix.isAbsolute(target) && resolved !== '..' && !resolved.startsWith('../'),
        content: null,
      });
    }
    return Object.freeze({
      path,
      mode,
      blob_oid: blobOid,
      bytes: bytes.length,
      content_sha256: sha256(bytes),
      content: bytes,
    });
  });
  if (new Set(records.map(row => row.path)).size !== records.length) {
    throw sourceError('GIT_TREE_DUPLICATE_PATH', 'Git tree contains duplicate materialization paths');
  }
  return records.sort((left, right) => compare(left.path, right.path));
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

/** Read and materialize one exact commit solely through the local Git object database. */
export function materializeExactGitTree({ repository, sha, target, project_id: projectId }) {
  if (!repository || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha || '') || !projectId || !target) {
    throw sourceError('GIT_TREE_INPUT_INVALID', 'repository, exact 40- or 64-hex SHA, project id, and target are required');
  }
  const repo = resolve(repository);
  const commit = git(repo, ['rev-parse', `${sha}^{commit}`], { encoding: 'utf8' }).trim();
  if (commit !== sha) throw sourceError('GIT_COMMIT_MISMATCH', `requested SHA resolved to a different commit: ${commit}`);
  const objectFormat = git(repo, ['rev-parse', '--show-object-format'], { encoding: 'utf8' }).trim();
  const tree = git(repo, ['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim();
  const commitTime = git(repo, ['show', '-s', '--format=%cI', sha], { encoding: 'utf8' }).trim();
  const records = parseTree(repo, sha, objectFormat);
  const materialized = records.filter(record => record.symlink_target === undefined);
  const symlinks = records.filter(record => record.symlink_target !== undefined)
    .map(({ content: _content, ...record }) => record);
  const files = materialized.map(({ content: _content, ...record }) => record);
  const body = {
    schema: GIT_TREE_SOURCE_SCHEMA,
    project_id: projectId,
    commit_sha: commit,
    tree_oid: tree,
    object_format: objectFormat,
    commit_time: commitTime,
    source_transport: 'local_git_object_database_only',
    live_worktree_files_read: false,
    enforced_refusal_limits: GIT_TREE_SOURCE_LIMITS,
    files,
    symlink_entries: symlinks,
    content_set_digest: sha256(canonical({ files, symlink_entries: symlinks })),
  };
  const manifest = Object.freeze({ ...body, manifest_digest: sha256(canonical(body)) });
  const root = resolve(target);
  if (existsSync(root) && readdirSync(root).length) {
    throw sourceError('GIT_MATERIALIZATION_TARGET_NOT_EMPTY', 'Git tree materialization target must be absent or empty');
  }
  mkdirSync(root, { recursive: true });
  for (const record of materialized) {
    const path = join(root, record.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, record.content, { flag: 'wx' });
    if (record.mode === '100755') chmodSync(path, 0o755);
  }
  validateGitTreeMaterialization(root, manifest);
  return Object.freeze({ root, manifest });
}
