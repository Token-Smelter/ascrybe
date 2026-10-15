import nodeTest from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync as allocate,
  readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const current = new AsyncLocalStorage();
// Allocation and reclamation are synchronous: concurrent cases cannot interleave these checks.
// This is ownership within this module instance, not a cross-process quiescence claim.
const liveRoots = new Set();
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
};
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Walk only the allocated tree. Symlinks are evidence, never traversal instructions.
function walk(root, visit, rel = '') {
  const path = join(root, rel), stat = lstatSync(path);
  visit(path, rel, stat);
  if (stat.isDirectory()) for (const name of readdirSync(path)) walk(root, visit, join(rel, name));
}

function validateRoot(record) {
  const stat = lstatSync(record.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== record.dev || stat.ino !== record.ino || realpathSync(record.root) !== record.root) {
    throw new Error('allocated root identity changed');
  }
}

export function fixtureScope({ source, name, archiveBase = process.env.ASCRYBE_FIXTURE_ARCHIVE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ascrybe-test-fixtures') } = {}) {
  const run = process.env.ASCRYBE_FIXTURE_RUN_ID || `${process.pid}`;
  const id = randomUUID(), records = [], children = new Set();
  const receiptDir = join(resolve(archiveBase), id);
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const event = data => appendFileSync(join(receiptDir, 'roots.jsonl'), `${JSON.stringify({ run, id, source, case: name, ...data })}\n`, { mode: 0o600 });
  let closed = false, preserveEvidence = false;
  function snapshot(record) {
    const target = join(receiptDir, `evidence-${record.index}`), files = [];
    walk(record.root, (path, rel, stat) => {
      const dest = join(target, rel);
      if (stat.isDirectory()) mkdirSync(dest, { recursive: true, mode: 0o700 });
      else if (stat.isFile()) {
        copyFileSync(path, dest);
        files.push({ path: rel, bytes: stat.size, sha256: createHash('sha256').update(readFileSync(dest)).digest('hex') });
      } else if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        symlinkSync(link, dest);
        files.push({ path: rel, symlink: link, sha256: createHash('sha256').update(link).digest('hex') });
      } else throw new Error(`unsupported evidence entry: ${rel}`);
    });
    writeFileSync(join(receiptDir, `manifest-${record.index}.json`), JSON.stringify({ run, id, source, case: name, root: record.root, files }, null, 2), { mode: 0o600 });
    return target;
  }
  return {
    receiptDir,
    allocate(prefix) {
      if (closed) throw new Error('fixture scope already closed');
      const parent = realpathSync(dirname(resolve(prefix)));
      // Exclusive mkdtemp cannot create an ancestor of an existing root; prevent descendants.
      if ([...liveRoots].some(record => inside(record.root, parent))) throw new Error('nested fixture allocation refused');
      const root = allocate(join(parent, basename(prefix)));
      const stat = lstatSync(root);
      const record = { root, index: records.length, dev: stat.dev, ino: stat.ino };
      records.push(record);
      liveRoots.add(record);
      event({ event: 'allocated', ...record, allocation: new Error().stack });
      return root;
    },
    // An owner releases this token only after its child has closed, not merely timed out.
    child(label) {
      if (closed) throw new Error('fixture scope already closed');
      const token = { label };
      children.add(token);
      return () => children.delete(token);
    },
    finish({ failed = false, cancelled = false } = {}) {
      closed = true;
      preserveEvidence ||= failed || cancelled;
      const outcomes = [];
      for (const record of [...records].reverse().filter(row => !row.reclaimed)) {
        let evidence = record.evidence;
        try {
          if (children.size || cancelled) throw new Error('owned child completion unresolved');
          validateRoot(record);
          if (preserveEvidence && !evidence) evidence = record.evidence = snapshot(record);
          let linkedCommon;
          walk(record.root, (path, rel, entry) => {
            if (entry.isSymbolicLink() && path.endsWith('/.git')) throw new Error('symlinked git metadata');
            if (entry.isDirectory() && path.endsWith('/worktrees') && readdirSync(path).length) {
              throw new Error('dependent worktree registration remains');
            }
            if (entry.isFile() && path.endsWith('/.git')) {
              const repo = dirname(path);
              const common = resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
              const gitDir = resolve(repo, git(repo, 'rev-parse', '--git-dir'));
              if (common !== gitDir) {
                const owner = records.find(r => liveRoots.has(r) && inside(r.root, common) && inside(r.root, gitDir));
                if (repo !== record.root || !owner) throw new Error('unowned or nested linked worktree');
                linkedCommon = { common, gitDir, owner };
              } else if (!inside(record.root, gitDir)) throw new Error('git directory outside allocated root');
            }
          });
          if (linkedCommon) {
            const { common, gitDir, owner } = linkedCommon;
            validateRoot(owner);
            if (realpathSync(common) !== common || realpathSync(gitDir) !== gitDir ||
                !inside(owner.root, common) || !inside(common, gitDir)) throw new Error('git metadata ownership changed');
            walk(common, (path, rel, entry) => {
              if (entry.isSymbolicLink()) throw new Error('symlinked git metadata');
            });
            validateRoot(record);
            validateRoot(owner);
            execFileSync('git', ['--git-dir', common, 'worktree', 'remove', record.root], { stdio: ['ignore', 'pipe', 'pipe'] });
          } else rmSync(record.root, { recursive: true });
          if (existsSync(record.root)) throw new Error('root still exists');
          const outcome = { event: 'reclaimed', root: record.root, evidence };
          event(outcome); outcomes.push(outcome);
          record.reclaimed = true;
          liveRoots.delete(record);
        } catch (error) {
          const outcome = { event: 'retained', root: record.root, evidence, reason: error.message };
          event(outcome); outcomes.push(outcome);
        }
      }
      return outcomes;
    },
  };
}

export function mkdtempSync(prefix) {
  const scope = current.getStore();
  if (!scope) throw new Error('fixture allocation outside an owned test');
  return scope.allocate(prefix);
}

export function fixtureTest(source) {
  return (name, options, body) => {
    if (typeof options === 'function') { body = options; options = {}; }
    return nodeTest(name, options, async t => {
      const scope = fixtureScope({ source, name });
      let failed = false, completed = false;
      t.after(() => {
        const outcomes = scope.finish({ failed, cancelled: !completed });
        const retained = outcomes.filter(row => row.event === 'retained');
        if (retained.length) throw new Error(`fixture KEEP: ${JSON.stringify(retained)}; receipt: ${scope.receiptDir}`);
      });
      return current.run(scope, async () => {
        try { return await body(t); }
        catch (error) { failed = true; throw error; }
        finally { completed = true; }
      });
    });
  };
}
