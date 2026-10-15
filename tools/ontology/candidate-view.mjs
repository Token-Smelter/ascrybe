// Read-only page for one proposed discovery generation. It serves the derived renderer contract
// and its static files; it cannot change the generation, the graph, or any selected head. When a graph is supplied it also serves the
// normal graph application beside the ontology explorer, through the same fixed read-only query routes.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoveryViewModel } from './discovery.mjs';
import { alignmentViewModel } from './alignment.mjs';
import { evidenceGraph } from './evidence-graph.mjs';
import { exploreModel, exploreTriage } from './explore-model.mjs';
import { createGraphBinding, GraphBindingRefused } from './graph-binding.mjs';
import { openCoverage, noCoverage } from './coverage-artifact.mjs';
import { createOntologyMap } from './ontology-map.mjs';
import { routeGraphApi, graphErrorStatus } from '../estate-dashboard-server.mjs';

const JS = 'text/javascript; charset=utf-8', CSS = 'text/css; charset=utf-8', HTML = 'text/html; charset=utf-8';
const ASSETS = Object.freeze({
  '/': ['ontology-candidate.html', HTML],
  '/ontology-candidate.css': ['ontology-candidate.css', CSS],
  '/ontology-candidate.js': ['ontology-candidate.js', JS],
  '/ontology-graph.js': ['ontology-graph.js', JS],
  '/ontology-estate.js': ['ontology-estate.js', JS],
  '/ontology-reconcile.js': ['ontology-reconcile.js', JS],
  '/explore': ['ontology-explore.html', HTML],
  '/ontology-explore.css': ['ontology-explore.css', CSS],
  '/ontology-explore.js': ['ontology-explore.js', JS],
});
// The normal graph application, served only when a graph is configured. Names are the application's own files.
const GRAPH_ASSETS = Object.freeze({
  '/graph': ['index.html', HTML], '/styles.css': ['styles.css', CSS], '/app.js': ['app.js', JS], '/graph-detail.js': ['graph-detail.js', JS],
  '/layered-layout.js': ['layered-layout.js', JS], '/layout.js': ['layout.js', JS], '/bundles.js': ['bundles.js', JS],
  '/ontology-graph-context.js': ['ontology-graph-context.js', JS], '/ontology-graph-context.css': ['ontology-graph-context.css', CSS],
});
const DASHBOARD_ROOT = fileURLToPath(new URL('../../dashboard/', import.meta.url));
// The page renders untrusted model text; the policy forbids anything but its own script and style.
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
});
const JSON_TYPE = 'application/json; charset=utf-8';

export function createCandidateViewServer({ generation, alignment = null, alignedGenerations = [], estate = null, reconcile = null, predicates = null, graph: graphConfig = null, chains = null, workspace = null, dashboardRoot = DASHBOARD_ROOT }) {
  // An estate-sized generation is served lean: concept and source detail (quoted evidence, assertions, subjects) is fetched one item at a time.
  const full = discoveryViewModel(generation);
  const detail = { concepts: new Map(), artifacts: new Map() };
  let lean = full;
  if (estate) {
    lean = { ...full, lazy: true, collections: full.collections.map(c => ({ ...c, schemes: c.schemes.map(sc => ({ ...sc, concepts: sc.concepts.map(k => {
      detail.concepts.set(k.accession, k);
      return { ...k, assertions: [], evidence: [], pending_changes: [], blockers: [], citation_overlaps: [], counts: { assertions: k.assertions.length, evidence: k.evidence.length }, lazy: true };
    }) })), relations: c.relations.slice(0, 500), gaps: c.gaps.slice(0, 200), unresolved: c.unresolved.slice(0, 200), changes: [], candidates: [], candidate_count: c.candidates.length,
    coverage: { artifacts: [], synthesis: c.coverage.synthesis, grounding: c.coverage.grounding } })),
    artifacts: full.artifacts.map(a => { detail.artifacts.set(a.artifact_id, a); const { referents, ...meta } = a; return { ...meta, referents: [], referent_count: referents.length, lazy: true }; }),
    rejected: full.rejected.slice(0, 300), rejected_total: full.rejected.length, decisions_needed: full.decisions_needed.slice(0, 300), decisions_total: full.decisions_needed.length, neighbor_review: [] };
  }
  const viewModel = Buffer.from(JSON.stringify(lean));
  // One entrypoint: when an alignment is supplied the same page also offers the aligned view across the
  // generations it relates. The page, the generations and the alignment stay read-only.
  const aligned = alignment ? Buffer.from(JSON.stringify(alignmentViewModel(alignment, [generation, ...alignedGenerations.filter(g => g.generation_id !== generation.generation_id)]))) : null;
  const read = file => readFileSync(new URL(file, `file://${dashboardRoot}`));
  const assets = Object.fromEntries(Object.entries(ASSETS).map(([route, [file, type]]) => [route, [read(file), type]]));
  if (graphConfig) {
    for (const [route, [file, type]] of Object.entries(GRAPH_ASSETS)) assets[route] = [read(file), type];
    // With a graph configured the application's own front door is the graph, opening on the ontology. The earlier candidate page stays at /candidate.
    assets['/candidate'] = assets['/'];
    assets['/'] = assets['/graph'];
  }
  const allGenerations = [generation, ...alignedGenerations.filter(g => g.generation_id !== generation.generation_id)];
  // A whole-estate generation is too large to draw as one evidence graph; its Graph tab is served only when a link-bearing alignment is present.
  const graph = Buffer.from(JSON.stringify(estate && !alignment ? { schema: 'estate-map/ontology-evidence-graph/v1', status: { proposal: true, accepted: false, decision_id: null, review_recording: 'not_enabled', note: '' },
    generations: [], alignment_id: null, collections: [], nodes: [], edges: [], chains: [], broken: [], default_chain: null, counts: {} } : evidenceGraph({ generations: allGenerations, alignment })));
  const reconcileBytes = reconcile ? Buffer.from(JSON.stringify(reconcile)) : null;
  const explored = estate ? exploreModel({ view: full, estate, reconcile, predicates, chains }) : null;
  const triageBytes = estate ? Buffer.from(JSON.stringify(exploreTriage({ view: full }))) : null;
  const estateBytes = estate ? Buffer.from(JSON.stringify(estate)) : null;

  // Binding of ontology evidence to the graph's documents. Built once, against one projection; every use re-checks that head.
  let binding = null, ontologyMap = null, graphUnavailable = null, exploreBytes = explored ? Buffer.from(JSON.stringify({ ...explored, workspace })) : null;
  const conceptIndex = new Map(explored ? explored.concepts.map((c, i) => [c[0], i]) : []);
  const pairId = () => `${String(generation.generation_id).split(':').pop().slice(0, 12)}:${binding ? binding.info().projection_id.slice(-8) : 'nograph'}`;
  const ready = (async () => {
    if (!graphConfig || !explored) return;
    // A graph that cannot be bound (for example its projection is not staged) leaves the explorer working and says so.
    try {
      binding = await createGraphBinding({ queries: graphConfig.queries, view: graphConfig.view, expectedProjectionId: graphConfig.expectedProjectionId ?? null, concepts: explored.concept_evidence, refs: graphConfig.refs ?? null, blobMap: graphConfig.blobMap ?? null });
      // Coverage is accounted over every node the graph admitted: linked, in an evidenced file, located but unplaced, or with no locator.
      const stats = await graphConfig.queries.stats({ view: graphConfig.view });
      // The coverage artifact is used only if it was made for this generation and counts the same admitted nodes; otherwise it is refused, visibly.
      const admitted = Object.values(stats.data.nodes_by_kind).reduce((a, b) => a + b, 0);
      let coverage = noCoverage(admitted), coverageRefusal = null;
      if (graphConfig.coverageDir) {
        const opened = openCoverage(graphConfig.coverageDir);
        if (opened.baseGeneration !== generation.generation_id) coverageRefusal = 'The coverage artifact was made for a different generation and is not used.';
        else if (opened.admitted !== admitted) coverageRefusal = `The coverage artifact counts ${opened.admitted} admitted nodes but this graph has ${admitted}; it is not used.`;
        else coverage = opened;
      }
      ontologyMap = createOntologyMap({ explored, details: detail.concepts, binding, coverage, queries: graphConfig.queries, view: graphConfig.view, projection: binding.head,
        coverageNote: coverageRefusal, loop: graphConfig.loop ?? null });
      exploreBytes = Buffer.from(JSON.stringify({ ...explored, graph: { ...binding.info(), pair: pairId(), coverage: ontologyMap.coverageSummary() }, workspace }));
    } catch (error) {
      graphUnavailable = error.message;
      exploreBytes = Buffer.from(JSON.stringify({ ...explored, graph_unavailable: graphUnavailable, workspace }));
    }
  })();

  const send = (res, status, body, type = JSON_TYPE) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': bytes.length });
    res.end(bytes);
  };
  const refuse = (res, error) => send(res, error instanceof GraphBindingRefused ? 409 : graphErrorStatus(error),
    { error: error.code || 'ONTOLOGY_GRAPH_FAILED', message: error.message, detail: error.detail ?? null });

  // Rows that carry a source location get their graph status attached; a refused binding marks every row refused instead of using the current graph.
  async function annotate(rows, view) {
    if (!binding) return { rows, refusal: null };
    try { await binding.guard(view); } catch (error) {
      if (!(error instanceof GraphBindingRefused)) throw error;
      return { rows: rows.map(r => ({ ...r, graph: { status: 'refused_projection' } })), refusal: error.message };
    }
    return { rows: rows.map(r => ({ ...r, graph: binding.annotate(r) })), refusal: null };
  }

  async function ontologyRoute(path, params, res) {
    await ready;
    if (!binding) return send(res, graphUnavailable ? 503 : 404, { error: graphUnavailable ? 'ONTOLOGY_GRAPH_UNAVAILABLE' : 'ONTOLOGY_GRAPH_NOT_CONFIGURED', message: graphUnavailable ?? 'no graph is bound to this ontology view' });
    if (path === '/api/ontology/binding') return send(res, 200, { ...binding.info(), pair: pairId(), workspace, coverage: ontologyMap?.coverageSummary() ?? null, default_lens: ontologyMap ? 'ontology' : 'source' });
    // A link made for another estate and generation pair is refused, not answered from this one.
    if (params.get('pair') && params.get('pair') !== pairId()) throw new GraphBindingRefused('This link was made for a different estate and generation pair than the one this page is bound to.', { bound: pairId(), requested: params.get('pair') });
    await binding.guard(params.get('view'));
    if (path === '/api/ontology/anchors') {
      const kind = params.get('kind'), i = Number(params.get('i'));
      const subject = kind === 'domain' ? explored.domains[i] : kind === 'concept' ? { label: explored.concepts[i]?.[1], members: [i] } : null;
      if (!subject?.label) return send(res, 404, { error: 'ONTOLOGY_SUBJECT_MISSING', message: `no ${kind} ${params.get('i')}` });
      return send(res, 200, { kind, i, label: subject.label, projection_id: binding.info().projection_id, ...binding.anchorsFor(subject.members, { limit: params.get('limit') ?? 12, offset: params.get('offset') ?? 0 }) });
    }
    if (path === '/api/ontology/coverage-explain') {
      const row = await ontologyMap.explain(params.get('id') ?? '');
      const named = acc => { const i = conceptIndex.get(acc); return i === undefined ? { accession: acc } : { i, label: explored.concepts[i][1] }; };
      const via = row ? [...new Map([...(row.via ?? []), ...(row.cited_by ?? []).map(c => ({ concept: c, by: 'cites this document' }))].map(v => [`${v.concept}|${v.by}`, v])).values()].slice(0, 8).map(v => ({ by: v.by, owner: v.owner, relation: v.relation, depth: v.depth, ...named(v.concept ?? v.owner) })) : [];
      return send(res, 200, { node_id: params.get('id'), row: row && { d: row.d, reason: row.reason ?? null, owner: row.owner ?? null, relation: row.relation ?? null, depth: row.depth ?? null, owners_reached: row.owners_reached ?? null, via }, summary: ontologyMap.coverageSummary() });
    }
    if (path === '/api/ontology/by-node') {
      const ids = binding.conceptsForNode(params.get('id') ?? '');
      const rows = ids.slice(0, 25).map(i => ({ i, label: explored.concepts[i][1], form: explored.forms[explored.concepts[i][2]]?.id ?? null, standing: explored.standings[explored.concepts[i][3]] ?? null, source: explored.sources[explored.concepts[i][4]] }));
      return send(res, 200, { node_id: params.get('id'), total: ids.length, concepts: rows, projection_id: binding.info().projection_id });
    }
    return send(res, 404, { error: 'ONTOLOGY_ROUTE_MISSING', message: 'unknown ontology route' });
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('read-only');
    }
    const url = new URL(req.url, 'http://localhost'), path = url.pathname, params = url.searchParams;
    try {
      if (path.startsWith('/api/ontology/')) return await ontologyRoute(path, params, res);
      // The ontology as graph nodes, served in the shape the graph application already reads. Pair and projection guards apply first.
      if (graphConfig && ((['/api/overview', '/api/search'].includes(path) && params.get('lens') === 'ontology') || (['/api/node', '/api/neighbors'].includes(path) && String(params.get('id') ?? '').startsWith('ontology:')))) {
        await ready;
        if (!ontologyMap) return send(res, 503, { error: 'ONTOLOGY_GRAPH_UNAVAILABLE', message: graphUnavailable ?? 'no ontology map is bound' });
        if (params.get('pair') && params.get('pair') !== pairId()) throw new GraphBindingRefused('This link was made for a different estate and generation pair than the one this page is bound to.', { bound: pairId(), requested: params.get('pair') });
        await binding.guard(params.get('view'));
        const wrap = (query, data, meta = {}) => ({ schema: 'estate-map/query-result/v1', query, projection: binding.head, ...meta, data });
        if (path === '/api/overview') return send(res, 200, wrap('overview', ontologyMap.overview()));
        if (path === '/api/search') return send(res, 200, wrap('search', ontologyMap.search(params.get('term'), Number(params.get('limit')) || 30)));
        if (path === '/api/node') {
          const found = await ontologyMap.node(params.get('id'), { quota: Number(params.get('kind_quota')) || undefined });
          if (!found) return send(res, 404, { error: 'ESTATE_QUERY_NODE_MISSING', message: `node ${params.get('id')} is not in the ontology map` });
          const { truncated, withheld_by_kind: withheld, ...data } = found;
          return send(res, 200, wrap('node', data, { truncated, withheld_by_kind: withheld }));
        }
        const near = await ontologyMap.neighbors(params.get('id'), { relation: params.get('relation'), direction: params.get('direction'), offset: Number(params.get('offset')) || 0, limit: params.get('limit') });
        if (!near) return send(res, 404, { error: 'ESTATE_QUERY_NODE_MISSING', message: 'no such neighbourhood in the ontology map' });
        const { truncated, ...data } = near;
        return send(res, 200, wrap('neighbors', data, { truncated }));
      }
      if (graphConfig && path.startsWith('/api/') && !path.startsWith('/api/explore') && !['/api/concept', '/api/artifact', '/api/reconcile', '/api/estate', '/api/graph', '/api/view-model', '/api/alignment'].includes(path)) {
        const routed = await routeGraphApi(graphConfig.queries, url);
        return routed ? send(res, 200, routed) : send(res, 404, { error: 'ESTATE_DASHBOARD_ROUTE_MISSING', message: 'unknown dashboard API route' });
      }
      if (path === '/api/concept' && estate) {
        await ready;
        const k = detail.concepts.get(params.get('accession')) ?? null;
        if (!k) return send(res, 200, null);
        const ev = await annotate(k.evidence, params.get('view') ?? undefined), as = await annotate(k.assertions.map(a => a.occurrence), params.get('view') ?? undefined);
        return send(res, 200, binding ? { ...k, evidence: ev.rows, assertions: k.assertions.map((a, n) => ({ ...a, occurrence: as.rows[n] })), graph_refusal: ev.refusal } : k);
      }
      if (path === '/api/explore/relation' && explored) {
        await ready;
        const rec = explored.relation_records[Number(params.get('i'))] ?? null;
        if (!rec) return send(res, 200, null);
        const ev = await annotate(rec.evidence, params.get('view') ?? undefined);
        return send(res, 200, binding ? { ...rec, evidence: ev.rows, graph_refusal: ev.refusal } : rec);
      }
      if (path === '/api/workspace') return send(res, workspace ? 200 : 404, workspace ?? { error: 'NO_WORKSPACE' });
      if (path === '/api/explore') { await ready; if (exploreBytes) return send(res, 200, exploreBytes); }
      const [bytes, type] = path === '/api/view-model' ? [viewModel, JSON_TYPE]
        : path === '/api/artifact' && estate ? [Buffer.from(JSON.stringify(detail.artifacts.get(params.get('id')) ?? null)), JSON_TYPE]
        : path === '/api/reconcile' && reconcileBytes ? [reconcileBytes, JSON_TYPE]
        : path === '/api/explore/triage' && triageBytes ? [triageBytes, JSON_TYPE]
        : path === '/api/estate' && estateBytes ? [estateBytes, JSON_TYPE]
        : path === '/api/graph' ? [graph, JSON_TYPE]
        : path === '/api/alignment' && aligned ? [aligned, JSON_TYPE] : assets[path] ?? [];
      if (!bytes) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': bytes.length });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { return refuse(res, error); }
  });
  server.ready = ready;
  return server;
}

export async function startCandidateView({ generation, alignment = null, alignedGenerations = [], estate = null, reconcile = null, predicates = null, graph = null, chains = null, workspace = null, host = '127.0.0.1', port }) {
  const server = createCandidateViewServer({ generation, alignment, alignedGenerations, estate, reconcile, predicates, graph, chains, workspace });
  await server.ready;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return Object.freeze({ server, url: `http://${host}:${server.address().port}/` });
}
