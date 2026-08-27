#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient } from './c3-serving-projection.mjs';
import { EstateGraphQueries } from './estate-graph-query.mjs';
import {
  loadEstateMapRuntimeConfig, neo4jConnectionFromConfig,
} from './ascrybe-config.mjs';

const DASHBOARD_ROOT = resolve(fileURLToPath(new URL('../dashboard', import.meta.url)));
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
});

function json(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  res.end(bytes);
}

function value(url, name) {
  const held = url.searchParams.get(name);
  return held == null || held === '' ? undefined : held;
}

function statusFor(error) {
  if (['ESTATE_QUERY_NODE_MISSING', 'ESTATE_QUERY_PROJECTION_MISSING'].includes(error?.code)) return 404;
  if (String(error?.code || '').includes('INVALID') || String(error?.code || '').includes('MISSING')) return 400;
  return 500;
}

export function createEstateDashboardServer({ queries, dashboard_root: dashboardRoot = DASHBOARD_ROOT }) {
  if (!(queries instanceof EstateGraphQueries)) throw new Error('dashboard server requires EstateGraphQueries');
  const root = resolve(dashboardRoot);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/projection-status') return json(res, await queries.projectionStatus());
      if (url.pathname === '/api/stats') return json(res, await queries.stats({ view: value(url, 'view') }));
      if (url.pathname === '/api/concepts') return json(res, await queries.concepts({
        view: value(url, 'view'), limit: value(url, 'limit'),
      }));
      if (url.pathname === '/api/overview') return json(res, await queries.overview({
        view: value(url, 'view'), limit: value(url, 'limit'),
      }));
      if (url.pathname === '/api/search') return json(res, await queries.search({
        view: value(url, 'view'), term: value(url, 'term'), limit: value(url, 'limit'),
        kinds: (value(url, 'kinds') || '').split(',').filter(Boolean),
        kind_quota: value(url, 'kind_quota') ?? null,
      }));
      if (url.pathname === '/api/node') return json(res, await queries.node({
        view: value(url, 'view'), id: value(url, 'id'), limit: value(url, 'limit'),
        ...(value(url, 'expand') ? { expand: value(url, 'expand') } : {}),
        kind_quota: value(url, 'kind_quota') ?? null,
      }));
      if (url.pathname === '/api/neighbors') return json(res, await queries.neighbors({
        view: value(url, 'view'), id: value(url, 'id'), relation: value(url, 'relation'),
        direction: value(url, 'direction'), limit: value(url, 'limit'),
      }));
      if (url.pathname === '/api/path') return json(res, await queries.path({
        view: value(url, 'view'), from: value(url, 'from'), to: value(url, 'to'),
        depth: value(url, 'depth'),
      }));
      if (url.pathname === '/api/provenance') return json(res, await queries.provenance({
        view: value(url, 'view'), id: value(url, 'id'), depth: value(url, 'depth'),
        limit: value(url, 'limit'),
      }));
      if (url.pathname.startsWith('/api/')) return json(res, {
        error: 'ESTATE_DASHBOARD_ROUTE_MISSING', message: 'unknown dashboard API route',
      }, 404);

      const relative = normalize(url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//u, ''));
      const file = resolve(root, relative);
      if ((file !== root && !file.startsWith(`${root}/`)) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      const bytes = readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'content-length': bytes.length,
        'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=300',
      });
      return res.end(bytes);
    } catch (error) {
      return json(res, { error: error.code || 'ESTATE_DASHBOARD_QUERY_FAILED',
        message: error.message, detail: error.detail || null }, statusFor(error));
    }
  });
}

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--runtime-config') held.runtime_config = resolve(value);
    else if (flag === '--host') held.host = value;
    else if (flag === '--port') held.port = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!held.runtime_config) throw new Error('--runtime-config is required');
  return held;
}

export async function startEstateDashboard({ runtime_config: runtimePath, host = null, port = null },
  environment = process.env) {
  const runtime = loadEstateMapRuntimeConfig(runtimePath);
  const client = new Neo4jHttpClient(neo4jConnectionFromConfig(runtime, environment));
  const queries = new EstateGraphQueries({
    client,
    default_view: runtime.config.projection.default_view,
    neighbor_limit: runtime.config.dashboard.neighbor_limit,
    overview_limit: runtime.config.dashboard.overview_limit,
    estate: runtime.config.projection.estate,
  });
  const server = createEstateDashboardServer({ queries });
  const listenHost = host || runtime.config.dashboard.host;
  const listenPort = port || runtime.config.dashboard.port;
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolvePromise);
  });
  return Object.freeze({ server, url: `http://${listenHost}:${listenPort}/` });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = await startEstateDashboard(parse(process.argv.slice(2)));
    console.log(`estate dashboard on ${running.url}`);
  } catch (error) {
    console.error(`FAIL estate dashboard: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
