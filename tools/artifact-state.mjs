#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, statSync, symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_LAYOUT = Object.freeze({
  '.evals': 'evaluations',
  runs: 'runs',
  out: 'out',
  logs: 'logs',
  checkpoints: 'checkpoints',
  estate: 'estate',
  '.verification': 'verification',
});

function inside(candidate, parent) {
  const relation = relative(parent, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function gitPath(repository, argument) {
  const output = execFileSync('git', ['-C', repository, 'rev-parse', argument], { encoding: 'utf8' }).trim();
  return resolve(repository, output);
}

export function repositoryIdentity(repository) {
  const worktree = realpathSync(repository);
  return Object.freeze({
    worktree,
    git_dir: gitPath(worktree, '--git-dir'),
    common_dir: gitPath(worktree, '--git-common-dir'),
  });
}

export function physicalPath(path) {
  const missing = [];
  let ancestor = resolve(path);
  while (!lstatExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve artifact root ancestry: ${path}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function assertExternalArtifactRoot(path, identity) {
  const physical = physicalPath(path);
  for (const protectedPath of [identity.worktree, identity.git_dir, identity.common_dir]) {
    if (inside(physical, protectedPath)) {
      throw new Error(`artifact root must be outside Git worktree and common directory: ${physical}`);
    }
  }
  return physical;
}

export function artifactRoot({ repository, environment = process.env } = {}) {
  if (!repository) throw new Error('repository is required to resolve the artifact root');
  const configured = environment.ASCRYBE_ARTIFACT_ROOT;
  const xdg = environment.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const candidate = resolve(configured || join(xdg, 'estate-map-runner'));
  return assertExternalArtifactRoot(candidate, repositoryIdentity(repository));
}

function ensureDirectory(path) {
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`state path collision: ${path}`);
  mkdirSync(path, { recursive: true });
}

function symlinkTarget(path) {
  const link = readlinkSync(path);
  return resolve(dirname(path), link);
}

function ensureLink(path, target) {
  if (!existsSync(path) && !lstatExists(path)) {
    symlinkSync(target, path, 'dir');
    return 'created';
  }
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) throw new Error(`state compatibility collision: ${path}`);
  if (symlinkTarget(path) !== target) throw new Error(`state compatibility link points elsewhere: ${path}`);
  return 'verified';
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function initializeState({ repository, environment = process.env } = {}) {
  let root = artifactRoot({ repository, environment });
  ensureDirectory(root);
  // mkdir follows parent links, so verify the newly created leaf again before linking repository paths.
  root = assertExternalArtifactRoot(root, repositoryIdentity(repository));
  const links = {};
  for (const [legacy, location] of Object.entries(STATE_LAYOUT)) {
    const target = join(root, location);
    ensureDirectory(target);
    links[legacy] = ensureLink(join(repository, legacy), target);
  }
  return Object.freeze({ root, links });
}

function emptyDirectory(path) {
  return !existsSync(path) || (lstatSync(path).isDirectory() && readdirSync(path).length === 0);
}

function fileDigest(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function directoryReceipt(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`state custody does not follow symlinks: ${path}`);
  if (stat.isFile()) return { files: 1, bytes: stat.size, sha256: fileDigest(path).sha256 };
  if (!stat.isDirectory()) throw new Error(`state custody accepts regular files and directories only: ${path}`);
  const rows = [];
  let bytes = 0;
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(directory, entry.name);
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) visit(child, name);
      else if (entry.isFile()) {
        const receipt = fileDigest(child);
        bytes += receipt.bytes;
        rows.push(`${name}\0${receipt.bytes}\0${receipt.sha256}`);
      } else throw new Error(`state custody accepts regular files only: ${child}`);
    }
  };
  visit(path);
  return { files: rows.length, bytes, sha256: createHash('sha256').update(rows.join('\n')).digest('hex') };
}

function linkOrCopy(source, destination) {
  try { linkSync(source, destination); } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error;
    copyFileSync(source, destination);
  }
}

export function copyAndVerify({ source, destination, beforeCopy = () => {}, afterCreate = () => {} } = {}) {
  if (!source || !destination) throw new Error('source and destination are required');
  if (!emptyDirectory(destination)) throw new Error(`destination already contains custody: ${destination}`);
  const sourceReceipt = directoryReceipt(source);
  const sourceStat = lstatSync(source);
  if (sourceStat.isFile()) {
    if (existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true });
    afterCreate(destination);
    beforeCopy(source, destination);
    linkOrCopy(source, destination);
  } else {
    mkdirSync(destination, { recursive: true });
    afterCreate(destination);
    const visit = (from, to) => {
      for (const entry of readdirSync(from, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const fromChild = join(from, entry.name);
        const toChild = join(to, entry.name);
        if (entry.isDirectory()) { mkdirSync(toChild); visit(fromChild, toChild); }
        else if (entry.isFile()) { beforeCopy(fromChild, toChild); linkOrCopy(fromChild, toChild); }
        else throw new Error(`state custody accepts regular files only: ${fromChild}`);
      }
    };
    visit(source, destination);
  }
  const destinationReceipt = directoryReceipt(destination);
  if (JSON.stringify(sourceReceipt) !== JSON.stringify(destinationReceipt)) {
    throw new Error(`copy verification failed: ${source} -> ${destination}`);
  }
  return Object.freeze({ source: sourceReceipt, destination: destinationReceipt });
}

export function migrateState({ repository, from, environment = process.env, beforeCopy } = {}) {
  if (!repository || !from) throw new Error('repository and --from are required for migration');
  let root = artifactRoot({ repository, environment });
  const legacyRoot = resolve(from);
  if (!existsSync(legacyRoot) || !lstatSync(legacyRoot).isDirectory()) throw new Error(`migration source is not a directory: ${legacyRoot}`);
  if (inside(root, legacyRoot) || inside(legacyRoot, root)) throw new Error('migration source and artifact root must not overlap');
  ensureDirectory(root);
  root = assertExternalArtifactRoot(root, repositoryIdentity(repository));
  const migrated = [];
  for (const [legacy, location] of Object.entries(STATE_LAYOUT)) {
    const source = join(legacyRoot, legacy);
    if (!lstatExists(source)) continue;
    const destination = join(root, location);
    if (!emptyDirectory(destination)) throw new Error(`migration destination already contains custody: ${destination}`);
    const receipt = copyAndVerify({ source, destination, beforeCopy });
    migrated.push({ legacy, source, destination, receipt });
  }
  const initialized = initializeState({ repository, environment });
  return Object.freeze({ root, migrated, links: initialized.links });
}

export function snapshotState({ repository, destination, environment = process.env, beforeCopy, afterCreate } = {}) {
  if (!destination) throw new Error('--destination is required for snapshot');
  const root = artifactRoot({ repository, environment });
  const target = resolve(destination);
  const physicalTarget = () => {
    const resolved = physicalPath(target);
    if (inside(resolved, root) || inside(root, resolved)) {
      throw new Error('snapshot destination must be outside the primary artifact root');
    }
    return resolved;
  };
  const custodyDestination = physicalTarget();
  if (lstatExists(target)) throw new Error(`snapshot destination already exists: ${target}`);
  const receipt = copyAndVerify({
    source: root,
    destination: custodyDestination,
    beforeCopy,
    afterCreate: () => {
      afterCreate?.(custodyDestination);
      if (physicalTarget() !== custodyDestination || physicalPath(custodyDestination) !== custodyDestination) {
        throw new Error('snapshot destination changed during creation');
      }
    },
  });
  return Object.freeze({ root, destination: custodyDestination, receipt });
}

export function verifyState({ repository, environment = process.env } = {}) {
  const root = artifactRoot({ repository, environment });
  const links = {};
  for (const [legacy, location] of Object.entries(STATE_LAYOUT)) {
    const target = join(root, location);
    if (!lstatExists(target) || !lstatSync(target).isDirectory()) throw new Error(`missing artifact location: ${target}`);
    const path = join(repository, legacy);
    if (!lstatExists(path) || !lstatSync(path).isSymbolicLink() || symlinkTarget(path) !== target) {
      throw new Error(`invalid state compatibility link: ${path}`);
    }
    links[legacy] = target;
  }
  return Object.freeze({ root, links });
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index].startsWith('--') || !rest[index + 1]) throw new Error('usage: artifact-state <init|verify|migrate|snapshot> [--from path] [--destination path]');
    options[rest[index].slice(2).replace(/-/g, '_')] = rest[index + 1];
  }
  return { command, options };
}

export function runArtifactStateCli(argv = process.argv.slice(2), { repository = process.cwd(), environment = process.env } = {}) {
  const { command, options } = parse(argv);
  if (command === 'init') return initializeState({ repository, environment });
  if (command === 'verify') return verifyState({ repository, environment });
  if (command === 'migrate') return migrateState({ repository, from: options.from, environment });
  if (command === 'snapshot') return snapshotState({ repository, destination: options.destination, environment });
  throw new Error('usage: artifact-state <init|verify|migrate|snapshot> [--from path] [--destination path]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runArtifactStateCli(), null, 2)); }
  catch (error) { console.error(`artifact state: ${error.message}`); process.exitCode = 1; }
}
