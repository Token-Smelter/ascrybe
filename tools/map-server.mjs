#!/usr/bin/env node
// Estate-map query server over a remap output directory (roadmap: drift-stamped viewers).
//
// Env: MAP_DIR (required, holds adjacency.json + remap-receipt.json + static viewer files),
//      PORT (default 8789), DRIFT_REPO (optional git dir for commits-behind-live).
// Read-only. Every displayed number comes from the receipted remap output; drift is computed
// live with one git command so staleness is visible, never hidden.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MAP_DIR = process.env.MAP_DIR ? resolve(process.env.MAP_DIR) : null;
if (!MAP_DIR) { console.error('MAP_DIR is required'); process.exit(2); }
const PORT = Number(process.env.PORT || 8789);
const DRIFT_REPO = process.env.DRIFT_REPO ? resolve(process.env.DRIFT_REPO) : null;

const graph = JSON.parse(readFileSync(join(MAP_DIR, 'adjacency.json'), 'utf8'));
const receipt = JSON.parse(readFileSync(join(MAP_DIR, 'remap-receipt.json'), 'utf8'));
const { nodes, adj } = graph;
console.log(`loaded nodes=${Object.keys(nodes).length} edges=${graph.counts.edges}`);

const searchable = Object.entries(nodes)
  .filter(([, node]) => node.l)
  .map(([id, node]) => [id, node.l, node.l.toLowerCase(), node.ns || '', node.r || '']);

function drift() {
  const mapped = graph.provenance.source_head;
  if (!DRIFT_REPO) return { mapped_sha: mapped, mapped_at: graph.provenance.mapped_at,
    commits_behind_live: null, live_sha: null };
  try {
    const live = execFileSync('git', ['-C', DRIFT_REPO, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim();
    const behind = execFileSync('git', ['-C', DRIFT_REPO, 'rev-list', '--count',
      `${mapped}..${live}`], { encoding: 'utf8' }).trim();
    return { mapped_sha: mapped, mapped_at: graph.provenance.mapped_at,
      live_sha: live, commits_behind_live: Number(behind) };
  } catch (error) {
    return { mapped_sha: mapped, mapped_at: graph.provenance.mapped_at,
      commits_behind_live: null, live_sha: null, drift_error: error.message.slice(0, 200) };
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const json = (res, body, code = 200) => {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length });
  res.end(bytes);
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === '/api/stats') {
    return json(res, { counts: graph.counts, provenance: graph.provenance,
      scope: receipt.scope, searchable: searchable.length, drift: drift() });
  }
  if (path === '/api/search') {
    const term = (url.searchParams.get('q') || '').toLowerCase().trim();
    const limit = Math.min(Number(url.searchParams.get('limit') || 40), 200);
    if (!term) return json(res, { term, hits: [] });
    const hits = [];
    for (const [id, label, lower, ns, kind] of searchable) {
      if (!lower.includes(term)) continue;
      hits.push({ id, label, namespace: ns, kind, degree: (adj[id] || []).length });
      if (hits.length >= limit) break;
    }
    return json(res, { term, hits });
  }
  if (path === '/api/node') {
    const id = url.searchParams.get('id') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 60), 400);
    if (!nodes[id]) return json(res, { error: 'unknown node id', id }, 404);
    const rows = (adj[id] || []).filter(([, other]) => nodes[other]);
    const seen = new Map();
    for (const [type, other, role] of rows) {
      const key = `${type}\u0000${other}`;
      if (!seen.has(key)) seen.set(key, { type, id: other, role, node: nodes[other] });
    }
    const all = [...seen.values()];
    return json(res, { id, node: nodes[id], total: all.length,
      returned: all.slice(0, limit), truncated: all.length > limit });
  }
  const rel = normalize(path === '/' ? '/graph-explorer.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(MAP_DIR, rel);
  if (!file.startsWith(MAP_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const bytes = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
    'content-length': bytes.length });
  res.end(bytes);
}).listen(PORT, '127.0.0.1', () => console.log(`map server on http://127.0.0.1:${PORT}/`));
