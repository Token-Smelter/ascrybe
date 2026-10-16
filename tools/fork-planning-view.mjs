#!/usr/bin/env node
// Isolated read-only planning view. All estate facts and treatment overlays are external runtime
// inputs; no mapped estate, source path or provider key is compiled into this public repository.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = resolve(fileURLToPath(new URL('../dashboard', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const GROUPS = new Set(['platform', 'service', 'datastore', 'provider']);
const LAYERS = new Set(['claimed_plan', 'graph_observed', 'pending']);
const FRESHNESS = new Set(['current', 'stale', 'unknown']);
const MAX_COMPONENTS = 120, MAX_GRAPH_REFS = 240, MAX_EDGES = 400;
const secretField = /^(?:password|secret|access_token|api_key|private_key|credential_value)$/i;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function safeText(value, limit = 8_000) { return typeof value === 'string' && value.length <= limit; }
function sourceRef(ref) {
  return ref && safeText(ref.path, 500) && ref.path.length > 0 && !ref.path.startsWith('/')
    && !ref.path.split('/').includes('..') && /^[a-f0-9]{40}$/.test(ref.commit_sha || '')
    && /^\d{4}-\d{2}-\d{2}$/.test(ref.date || '') && safeText(ref.detail || '', 2_000);
}
function assertNoSecrets(value) {
  if (Array.isArray(value)) return value.forEach(assertNoSecrets);
  if (!value || typeof value !== 'object') return;
  for (const [key, field] of Object.entries(value)) {
    if (secretField.test(key)) fail('FORK_VIEW_SECRET_REFUSED', 'scenario contains a credential-shaped field');
    if (typeof field === 'string' && /(?:sk-(?:or-|ant-|proj-)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(field)) {
      fail('FORK_VIEW_SECRET_REFUSED', 'scenario contains credential-shaped content');
    }
    assertNoSecrets(field);
  }
}

export function validateForkOverlay(input) {
  if (input?.schema !== 'estate-map/fork-planning-overlay/v1' || !Array.isArray(input.components)
    || input.components.length > MAX_COMPONENTS || !Array.isArray(input.decisions)
    || input.decisions.length > 40 || !safeText(input.title, 160) || !sourceRef(input.source_ref)
    || !Array.isArray(input.coverage_status || []) || (input.coverage_status || []).length > MAX_COMPONENTS
    || (input.expected_projection_id != null && !safeText(input.expected_projection_id, 180))
    || (input.expected_content_digest != null && !/^[a-f0-9]{64}$/.test(input.expected_content_digest))
    || (input.expected_code_graph_digest != null && !/^[a-f0-9]{64}$/.test(input.expected_code_graph_digest))) {
    fail('FORK_VIEW_OVERLAY_INVALID', 'scenario requires bounded components, decisions and title');
  }
  assertNoSecrets(input);
  const ids = new Set();
  for (const component of input.components) {
    if (!/^[a-z][a-z0-9_-]{0,64}$/i.test(component.id || '') || ids.has(component.id)
      || !GROUPS.has(component.group) || !safeText(component.label, 180)
      || !LAYERS.has(component.layer || 'claimed_plan') || !FRESHNESS.has(component.evidence_freshness || 'unknown')
      || !Array.isArray(component.graph_refs || []) || component.graph_refs.length > 6
      || !Array.isArray(component.current_evidence || []) || !Array.isArray(component.source_refs || [])
      || !Array.isArray(component.approved_decision_ids || []) || !Array.isArray(component.dependencies || [])
      || !Array.isArray(component.affected_components || [])
      || (component.implementation_verified !== true && component.implementation_verified !== false)) {
      fail('FORK_VIEW_OVERLAY_INVALID', 'component fields are invalid or duplicate');
    }
    ids.add(component.id);
    for (const ref of [...component.current_evidence, ...component.source_refs]) {
      if (!sourceRef(ref) || !['claimed', 'source_read', 'graph_observed', 'unknown'].includes(ref.standing)) {
        fail('FORK_VIEW_SOURCE_REF_INVALID', 'every evidence item requires a pinned source and explicit standing');
      }
    }
    for (const ref of component.graph_refs || []) {
      if (!safeText(ref.node_id || '', 220) && !(safeText(ref.namespace, 500) && safeText(ref.kind, 80))) {
        fail('FORK_VIEW_GRAPH_REF_INVALID', 'graph ref needs exact node_id or exact namespace and kind');
      }
      if (ref.association && !['exact_component', 'repository_locator', 'source_locator'].includes(ref.association)) {
        fail('FORK_VIEW_GRAPH_REF_INVALID', 'graph ref association must distinguish component fact from source or repository locator');
      }
      if ((ref.association === 'repository_locator' || ref.kind === 'Repository') && ref.association !== 'repository_locator') {
        fail('FORK_VIEW_GRAPH_REF_INVALID', 'Repository refs must be explicitly marked as locators, never native component evidence');
      }
    }
    if (component.proposed_treatment && !sourceRef(component.proposed_treatment.source_ref)) {
      fail('FORK_VIEW_SOURCE_REF_INVALID', 'proposed treatment needs a pinned source reference');
    }
    if (component.implementation_verified && (!Array.isArray(component.verification_refs) || !component.verification_refs.length
      || component.verification_refs.some(ref => !sourceRef(ref)))) {
      fail('FORK_VIEW_VERIFICATION_REQUIRED', 'implementation_verified needs a cited verification record');
    }
  }
  for (const component of input.components) for (const ref of [...component.dependencies, ...component.affected_components]) {
    if (!ids.has(ref)) fail('FORK_VIEW_OVERLAY_INVALID', 'dependencies and affected components must name a declared component');
  }
  for (const row of input.coverage_status || []) {
    if (!safeText(row.surface, 160) || !safeText(row.status, 600) || !sourceRef(row.source_ref)) {
      fail('FORK_VIEW_COVERAGE_INVALID', 'coverage status requires a surface, finding and cited source');
    }
  }
  const decisionIds = new Set();
  for (const decision of input.decisions) {
    if (!safeText(decision.id, 40) || decisionIds.has(decision.id) || !safeText(decision.text, 2_000)
      || !sourceRef(decision.source_ref) || decision.approved !== true) {
      fail('FORK_VIEW_DECISION_INVALID', 'an approved decision requires an id, text and pinned source');
    }
    decisionIds.add(decision.id);
  }
  for (const component of input.components) for (const id of component.approved_decision_ids) {
    if (!decisionIds.has(id)) fail('FORK_VIEW_DECISION_INVALID', 'component refers to an unknown approved decision');
  }
  return input;
}

export function validateGraphManifest(input) {
  if (input?.schema !== 'estate-map/fork-planning-graph-source/v1'
    || !safeText(input.projection_id, 180) || !safeText(input.nodes_path, 2_000)
    || !safeText(input.edges_path, 2_000) || !/^[a-f0-9]{64}$/.test(input.nodes_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(input.edges_sha256 || '')
    || (input.content_digest != null && !/^[a-f0-9]{64}$/.test(input.content_digest))
    || (input.code_graph_digest != null && !/^[a-f0-9]{64}$/.test(input.code_graph_digest))) {
    fail('FORK_VIEW_GRAPH_MANIFEST_INVALID', 'graph manifest needs projection id, paths and SHA-256 digests');
  }
  return input;
}

async function streamJsonLines(path, onRow) {
  const stream = createReadStream(path);
  const hash = createHash('sha256');
  stream.on('data', bytes => hash.update(bytes));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) if (line) await onRow(JSON.parse(line));
  return hash.digest('hex');
}

export async function loadGraphSlice(manifest, overlay) {
  const refs = new Map(), byNamespace = new Map();
  let refCount = 0;
  for (const component of overlay.components) for (const ref of component.graph_refs || []) {
    if (++refCount > MAX_GRAPH_REFS) fail('FORK_VIEW_GRAPH_LIMIT', 'too many component graph refs');
    const key = ref.node_id || `${ref.kind}:${ref.namespace}`;
    const owners = ref.node_id ? refs : byNamespace;
    if (!owners.has(key)) owners.set(key, []);
    const associations = owners.get(key);
    if (associations.some(row => row.association === 'exact_component' && row.component_id !== component.id)
      || ref.association !== 'repository_locator' && ref.association !== 'source_locator'
        && associations.some(row => row.component_id !== component.id)) {
      fail('FORK_VIEW_GRAPH_REF_AMBIGUOUS', 'shared graph ref requires an explicit non-native locator association');
    }
    associations.push({ component_id: component.id, association: ref.association || 'exact_component' });
  }
  const matches = new Map(), nodes = new Map(), edges = [], namespaceMatches = new Map();
  const nodeHash = await streamJsonLines(manifest.nodes_path, node => {
    const namespaceKey = `${node.kind}:${node.properties?.namespace}`;
    const associations = refs.get(node.node_id) || byNamespace.get(namespaceKey);
    if (!associations) return;
    if (!refs.has(node.node_id) && byNamespace.has(namespaceKey)) {
      namespaceMatches.set(namespaceKey, (namespaceMatches.get(namespaceKey) || 0) + 1);
    }
    for (const association of associations) {
      if (!matches.has(association.component_id)) matches.set(association.component_id, []);
      if (matches.get(association.component_id).length >= 6) continue;
      matches.get(association.component_id).push({ node_id: node.node_id, association: association.association });
    }
    nodes.set(node.node_id, { node_id: node.node_id, kind: node.kind, label: node.label,
      properties: Object.fromEntries(Object.entries(node.properties || {}).filter(([key]) =>
        ['namespace', 'file', 'path', 'source_path', 'source_commit', 'repository'].includes(key))) });
  });
  if (nodeHash !== manifest.nodes_sha256) fail('FORK_VIEW_GRAPH_CONTENT_MISMATCH', 'node file differs from graph manifest');
  if ([...namespaceMatches.values()].some(count => count !== 1)) {
    fail('FORK_VIEW_GRAPH_REF_AMBIGUOUS', 'an exact namespace matched multiple graph nodes');
  }
  const edgeHash = await streamJsonLines(manifest.edges_path, edge => {
    if (edges.length >= MAX_EDGES) return;
    const from = edge.from_node_id || edge.from, to = edge.to_node_id || edge.to;
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, relation: edge.relation || edge.kind || 'related' });
  });
  if (edgeHash !== manifest.edges_sha256) fail('FORK_VIEW_GRAPH_CONTENT_MISMATCH', 'edge file differs from graph manifest');
  return { matches, nodes, edges };
}

function response(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(bytes);
}

export function createForkPlanningView({ overlay_path: overlayPath = null, graph_manifest: graphManifestPath = null }) {
  let overlay = null, graph = null, graphState = 'pending', graphReason = 'graph manifest not supplied';
  let loading = null, lastManifestMtime = null;
  async function refresh() {
    if (!overlayPath || !existsSync(overlayPath)) { overlay = null; graphState = 'pending'; graphReason = 'private scenario not supplied'; return; }
    overlay = validateForkOverlay(JSON.parse(readFileSync(overlayPath, 'utf8')));
    if (!graphManifestPath || !existsSync(graphManifestPath)) {
      graph = null; graphState = 'pending'; graphReason = 'observed graph is not available yet'; return;
    }
    const modified = statSync(graphManifestPath).mtimeMs;
    if (graph && lastManifestMtime === modified) return;
    const manifest = validateGraphManifest(JSON.parse(readFileSync(graphManifestPath, 'utf8')));
    if (overlay.expected_projection_id && overlay.expected_projection_id !== manifest.projection_id
      || overlay.expected_content_digest && overlay.expected_content_digest !== manifest.content_digest
      || overlay.expected_code_graph_digest && overlay.expected_code_graph_digest !== manifest.code_graph_digest) {
      graph = null; graphState = 'mismatch'; graphReason = 'scenario projection or content digests do not match observed graph'; return;
    }
    if (!overlay.expected_projection_id) {
      graph = null; graphState = 'pending'; graphReason = 'scenario has no pinned expected projection id'; return;
    }
    graph = await loadGraphSlice(manifest, overlay);
    lastManifestMtime = modified; graphState = 'matched'; graphReason = null;
  }
  const refreshOnce = async () => {
    if (!loading) loading = refresh().catch(error => { overlay = null; graph = null; graphState = 'pending'; graphReason = error.code || 'graph read failed'; })
      .finally(() => { loading = null; });
    await loading;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return response(res, { error: 'FORK_VIEW_READ_ONLY' }, 405);
    if (url.pathname.startsWith('/api/')) {
      await refreshOnce();
      if (url.pathname === '/api/fork-planning') return response(res, {
        schema: 'estate-map/fork-planning-view/v1', scenario: overlay ? { title: overlay.title, source_ref: overlay.source_ref,
          expected_projection_id: overlay.expected_projection_id,
          expected_content_digest: overlay.expected_content_digest || null } : null,
        graph: { state: graphState, reason: graphReason, matched_nodes: graph?.nodes.size ?? 0, edges: graph?.edges.length ?? 0,
          native_components: graph ? [...graph.matches.values()].filter(rows => rows.some(row => row.association === 'exact_component')).length : 0,
          locator_components: graph ? [...graph.matches.values()].filter(rows => rows.some(row => row.association !== 'exact_component')).length : 0 },
        decisions: overlay?.decisions ?? [], coverage_status: overlay?.coverage_status ?? [],
        components: overlay?.components.map(c => ({ id: c.id, label: c.label, group: c.group, layer: c.layer || 'claimed_plan',
          treatment: c.proposed_treatment?.kind || 'unassigned', evidence_freshness: c.evidence_freshness || 'unknown',
          implementation_verified: c.implementation_verified, approved_decision_ids: c.approved_decision_ids,
          dependencies: c.dependencies, affected_components: c.affected_components,
          graph_matches: graph?.matches.get(c.id)?.filter(row => row.association === 'exact_component').length || 0,
          graph_locators: graph?.matches.get(c.id)?.filter(row => row.association !== 'exact_component').length || 0 })) ?? [],
      });
      if (url.pathname === '/api/fork-planning/component') {
        const id = url.searchParams.get('id'), component = overlay?.components.find(c => c.id === id);
        if (!component) return response(res, { error: 'FORK_VIEW_COMPONENT_MISSING' }, 404);
        const bindings = graph?.matches.get(id) || [];
        const exact = bindings.filter(row => row.association === 'exact_component');
        return response(res, { schema: 'estate-map/fork-planning-component/v1', component,
          observed: bindings.length ? { state: exact.length ? 'graph_observed' : bindings.some(row => row.association === 'source_locator') ? 'source_locator' : 'repository_locator',
            projection_id: overlay.expected_projection_id,
            reason: exact.length ? null : 'Source/repository locator only; no component-native graph fact is bound',
            nodes: bindings.map(binding => ({ ...graph.nodes.get(binding.node_id), association: binding.association })),
            edges: graph.edges.filter(e => bindings.some(binding => binding.node_id === e.from || binding.node_id === e.to)) }
            : { state: 'pending', reason: graphState !== 'matched' ? graphReason : 'no exact graph ref matched', nodes: [], edges: [] },
        });
      }
      return response(res, { error: 'FORK_VIEW_ROUTE_MISSING' }, 404);
    }
    const fileName = url.pathname === '/' ? 'fork-planning.html' : url.pathname.slice(1);
    if (!['fork-planning.html', 'fork-planning.css', 'fork-planning.js', 'styles.css'].includes(fileName)) {
      res.writeHead(404); return res.end('not found');
    }
    const file = resolve(ASSETS, fileName);
    if (!file.startsWith(`${ASSETS}/`) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const bytes = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(bytes);
  });
  return server;
}

function options(argv) {
  const result = { port: 8780, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--overlay', '--graph-manifest', '--port'].includes(argv[i]) || !argv[i + 1]) fail('FORK_VIEW_ARGUMENT_INVALID', 'use --overlay <private JSON> [--graph-manifest <private JSON>] [--port 8780]');
    if (argv[i] === '--overlay') result.overlay_path = resolve(argv[i + 1]);
    if (argv[i] === '--graph-manifest') result.graph_manifest = resolve(argv[i + 1]);
    if (argv[i] === '--port') result.port = Number(argv[i + 1]);
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) fail('FORK_VIEW_ARGUMENT_INVALID', 'port must be 1024–65535');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2));
    const server = createForkPlanningView(opts);
    server.listen(opts.port, opts.host, () => console.log(`fork planning view on http://${opts.host}:${opts.port}/ (read-only)`));
  } catch (error) { console.error(`FAIL ${error.code || 'FORK_VIEW_FAILED'}: ${error.message}`); process.exitCode = 1; }
}
