// Writes a coverage result as shards a page can read in bounded memory, and reads them back. Lists are sharded by disposition and repository,
// so a page of "unplaced nodes of one repository" reads one shard; an explanation of one node reads one of 256 hash shards. Nothing here
// loads the whole graph.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const safe = value => String(value ?? 'none').replace(/[^A-Za-z0-9._-]+/gu, '_');
const hashShard = id => createHash('sha1').update(id).digest('hex').slice(0, 2);
const dirOf = file => String(file ?? '').split('/').slice(0, 3).join('/') || '(root)';

export async function writeCoverageShards(outputDir, { info, state }) {
  const writers = new Map();
  const open = path => { let w = writers.get(path); if (!w) { mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); w = createWriteStream(path, { mode: 0o600 }); writers.set(path, w); } return w; };
  const put = async (path, line) => { const w = open(path); if (!w.write(line)) await new Promise(r => w.once('drain', r)); };
  const dirs = new Map();
  const counts = {};
  for (const [id, s] of state) {
    const n = info.get(id), repo = n.r ?? '(no repository locator)';
    const row = JSON.stringify({ node_id: id, kind: n.k, repository: n.r, file: n.f, line: n.l, ...s }) + '\n';
    await put(join(outputDir, 'shards', s.d, `${safe(repo)}.jsonl`), row);
    await put(join(outputDir, 'by-id', `${hashShard(id)}.jsonl`), row);
    (counts[s.d] ??= {})[repo] = (counts[s.d][repo] ?? 0) + 1;
    if (s.d === 'unplaced' && n.f) {
      const key = `${repo}\u0000${dirOf(n.f)}`;
      const d = dirs.get(key) ?? { repository: repo, directory: dirOf(n.f), unplaced: 0, kinds: {}, reasons: {} };
      d.unplaced += 1; d.kinds[n.k] = (d.kinds[n.k] ?? 0) + 1; d.reasons[s.reason] = (d.reasons[s.reason] ?? 0) + 1; dirs.set(key, d);
    }
  }
  await Promise.all([...writers.values()].map(w => new Promise(r => w.end(r))));
  const byRepo = Map.groupBy([...dirs.values()], d => d.repository);
  const top = {};
  for (const [repo, rows] of byRepo) top[repo] = rows.sort((a, b) => b.unplaced - a.unplaced).slice(0, 100).map(d => ({ ...d, kinds: Object.fromEntries(Object.entries(d.kinds).sort((a, b) => b[1] - a[1]).slice(0, 5)) }));
  writeFileSync(join(outputDir, 'unplaced-by-directory.json'), JSON.stringify({ schema: 'estate-map/graph-coverage-directories/v1', note: 'A directory is a locator, not a semantic group. These are where unplaced nodes concentrate.', top_directories_per_repository: top }));
  writeFileSync(join(outputDir, 'shard-index.json'), JSON.stringify({ schema: 'estate-map/graph-coverage-shards/v1', dispositions: counts }));
}

async function* lines(path) { if (!existsSync(path)) return; for await (const l of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (l) yield JSON.parse(l); }

/** One page of nodes of a disposition in a repository, optionally narrowed by kind or reason. Reads only that shard. */
export async function coveragePage(dir, { disposition, repository, kind = null, reason = null, offset = 0, limit = 50 }) {
  const out = []; let seen = 0, total = 0;
  const bound = Math.min(Math.max(limit, 1), 200);
  for await (const r of lines(join(dir, 'shards', disposition, `${safe(repository)}.jsonl`))) {
    if ((kind && r.kind !== kind) || (reason && r.reason !== reason)) continue;
    total += 1;
    if (seen++ >= offset && out.length < bound) out.push(r);
  }
  return { disposition, repository, kind, reason, offset, limit: bound, matching: total, rows: out };
}

/** Why one node has its disposition: the shard row, plus the anchors or the owner that reached it. */
export async function coverageExplain(dir, nodeId) {
  for await (const r of lines(join(dir, 'by-id', `${hashShard(nodeId)}.jsonl`))) if (r.node_id === nodeId) return r;
  return null;
}

export const coverageSummary = dir => JSON.parse(readFileSync(join(dir, 'graph-coverage-summary.json'), 'utf8'));
export const coverageDirectories = dir => JSON.parse(readFileSync(join(dir, 'unplaced-by-directory.json'), 'utf8'));
