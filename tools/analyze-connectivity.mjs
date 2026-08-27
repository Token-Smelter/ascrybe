#!/usr/bin/env node
// Ascrybe connectivity analyzer.
//
// Read-only, offline, deterministic diagnostic over an already-generated
// `estate-graph.json`. It measures how fragmented the canonical graph is and
// attributes that fragmentation to the language/extractor, node kind, and edge
// kind that produced it.
//
// SAFETY: this tool only reads JSON/JSONL data files with `node:fs`. It never
// imports, executes, builds, or otherwise evaluates scanned source; it never
// spawns a process and never touches the network. Every output is derived from
// the input bytes alone, so two runs over the same input are byte-identical.
//
// Why this exists: the estate graph is visibly fragmented, and until now the
// fragmentation had never been measured. Guessing at fixes without a baseline
// is how resolution work gets spent on the wrong edge families.

import fs from './readonly-guard.mjs';
import path from 'node:path';
import { parseArgs } from './lib.mjs';
import { PYTHON_STDLIB_MODULES } from './platform-vocabulary.mjs';
import { assertMetricDefinitionCoverage } from './conservation.mjs';

const metric=(pathPattern,predicate,knownBlindCases)=>Object.freeze({path:pathPattern,predicate,known_blind_cases:Object.freeze(knownBlindCases)});
export const CONNECTIVITY_METRIC_DEFINITIONS=Object.freeze([
  metric('totals.nodes','count(graph.nodes)', ['different nodes can represent the same semantic concept at different evidence grains']),
  metric('totals.edges','count(graph.edges)', ['includes targetless external and ambiguous edge records that do not connect two canonical nodes']),
  metric('totals.linking_edges','count(edges where from and to are non-null and both endpoint ids exist in graph.nodes)', ['candidate-only ambiguous edges and external targetless edges are excluded']),
  metric('totals.targetless_edges','count(edges where from is null or to is null)', ['does not include non-null endpoint ids missing from graph.nodes; those are dangling_edges']),
  metric('totals.dangling_edges','count(edges with non-null endpoints where at least one endpoint id is absent from graph.nodes)', ['candidate ids are not evaluated because ambiguous edges have to=null']),
  metric('totals.self_loop_edges','count(linking edges where from id equals to id)', ['parallel self-loop records are counted separately']),
  metric('totals.unresolved_records','count(graph.unresolved)', ['refusal families outside graph.unresolved are excluded']),
  metric('components.count','count(weakly connected components over the undirected projection of linking_edges)', ['edge direction and targetless evidence do not affect component membership']),
  metric('components.isolated_nodes','count(nodes whose degree over linking_edges is exactly zero)', ['emitted-never-consumed and consumed-never-emitted nodes have nonzero degree and are invisible to this predicate']),
  metric('components.isolated_pct','100 * components.isolated_nodes / totals.nodes, or 0 when totals.nodes=0', ['inherits every blind case of components.isolated_nodes']),
  metric('components.giant.nodes','node count of the largest weakly connected component; ties break by smallest member id', ['does not imply semantic importance or directional reachability']),
  metric('components.giant.edges','linking-edge count whose source belongs to the largest weakly connected component', ['parallel edges count separately']),
  metric('components.giant.node_share_pct','100 * components.giant.nodes / totals.nodes', ['inherits component and node-grain blind cases']),
  metric('components.giant.edge_share_pct','100 * components.giant.edges / totals.edges', ['denominator includes targetless and dangling edges that cannot belong to any component']),
  metric('components.giant.linking_edge_share_pct','100 * components.giant.edges / totals.linking_edges', ['edge direction and parallelism are ignored for component identity']),
  metric('components.size_histogram.*','count(weak components whose node count falls in the bucket named by the final path segment)', ['bucket boundaries hide variation inside each bucket']),
  metric('components.largest_non_giant[].size','node count of one non-giant weak component', ['list is truncated by the --top bound']),
  metric('components.largest_non_giant[].edges','linking-edge count inside one non-giant weak component', ['list is truncated by the --top bound and parallel edges count separately']),
  metric('components.largest_non_giant[].kinds[].count','node count in the component grouped by canonical node kind', ['only the five largest kind groups per component are published']),
  metric('components.largest_non_giant[].repos[].count','node count in the component grouped by node.repo', ['only the five largest repository groups per component are published']),
  metric('attribution.unresolved_population','count(graph.unresolved)', ['does not include targetless edges absent from graph.unresolved or separate refusal ledgers']),
  metric('attribution.categories[].records','count(unresolved records assigned to the named a/b/c/d category)', ['classification is bounded by available graph facts and optional symbol enrichment']),
  metric('attribution.categories[].pct_of_unresolved','100 * category records / attribution.unresolved_population', ['inherits category-classifier blind cases']),
  metric('attribution.category_by_language[].count','count(unresolved records in the named category and source-file language)', ['unknown file extensions collapse to other']),
  metric('attribution.ranked_b_should_have_resolved[].records','count(unresolved records in one category-b family)', ['family membership depends on the current deterministic classifier vocabulary']),
  metric('attribution.a_external_legitimate[].records','count(unresolved records in one category-a family)', ['absence of an in-estate target is closed-world only over the scanned estate']),
  metric('attribution.c_ambiguous[].records','count(unresolved records in one category-c family)', ['candidate arrays may be capped while candidate_count preserves the true total']),
  metric('attribution.d_indeterminate[].records','count(unresolved records in one category-d family)', ['indeterminate intentionally combines cases requiring evidence outside the graph']),
  metric('attribution.*[].distinct_source_nodes','count(distinct source module ids represented by records in the family)', ['records without a source module fact contribute no source node']),
  metric('attribution.*[].disconnected_source_nodes','count(distinct family source modules outside the giant component)', ['a connected source may still have the particular reference unresolved']),
  metric('attribution.*[].examples[].candidate_count','candidate count recorded on one bounded diagnostic example', ['examples are truncated by --samples and some records omit candidate_count']),
  metric('attribution.nodes.*[].count','count(graph nodes in the state and grouping encoded by the parent path and row key)', ['dynamic grouping rows may omit zero-count groups']),
  metric('attribution.nodes.first_party_only.total','count(module nodes classified first_party by path and included in connectivity attribution)', ['non-module nodes and excluded-scope modules are omitted']),
  metric('attribution.nodes.first_party_only.*[].count','count(first-party module nodes in the grouping encoded by the parent path and row key)', ['path classification cannot detect generated or vendored source stored under an unrecognised name']),
  metric('attribution.edges.*[].count','count(graph edges in the kind/status grouping encoded by the parent path)', ['targetless and connecting populations are reported in separate arrays and must not be summed without deduplication']),
]);

const HELP = `Usage: node tools/estate-map/analyze-connectivity.mjs --graph <estate-graph.json> [options]

Options:
  --graph <path>     Canonical estate-graph.json to analyze (required).
  --facts <dir>      Optional facts dir (or its parent) from the same extract run.
                     Enables cross-repo symbol attribution for 'external'
                     reference records, which the graph alone cannot decide.
  --out <path>       Write the full machine-readable report JSON here.
  --top <n>          How many largest non-giant components to list (default 20).
  --samples <n>      Sample member ids per component / examples per family (default 5).
  --json             Print the full report JSON to stdout instead of the text summary.
  --help

Read-only, offline, deterministic. Never executes or imports scanned code.`;

// ---------------------------------------------------------------------------
// Attribution vocabulary
// ---------------------------------------------------------------------------

// Which extractor produced a node of this kind. Node kinds come from
// merge.mjs's addNode() call sites; the extractor mapping comes from
// tools/estate-map/extractors/index.mjs.
const NODE_KIND_EXTRACTOR = {
  repo: 'extract-core',
  service: 'extract-core',
  coverage: 'extract-core',
  tf_resource: 'hcl',
  tf_module: 'hcl',
  environment: 'hcl',
  route: 'http',
  config_key: 'config',
  package: 'dependencies',
  external_internal_package: 'dependencies',
  sql_object: 'sql',
  module: 'treesitter',
  swift_framework: 'treesitter-swift',
};

const EXTENSION_LANGUAGE = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.swift': 'swift', '.kt': 'kotlin',
  '.kts': 'kotlin-script', '.cs': 'csharp', '.py': 'python', '.tf': 'hcl',
  '.tfvars': 'hcl', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml', '.sql': 'sql', '.xml': 'xml', '.csproj': 'msbuild',
  '.gradle': 'gradle', '.properties': 'properties', '.env': 'dotenv',
};

// Kotlin/JVM import roots that merge.mjs itself already treats as external.
// Duplicated here (not imported) because merge.mjs does not export it and this
// analyzer must never import merge.mjs's resolution machinery.
const KOTLIN_EXTERNAL_PACKAGE_ROOTS = ['kotlin', 'kotlinx', 'java', 'javax', 'android', 'androidx', 'com.google', 'com.squareup', 'dagger', 'retrofit2', 'okhttp3', 'io.reactivex', 'rx', 'junit', 'org.junit', 'org.jetbrains'];

// Python 3.12 top-level stdlib module names. A stdlib import is external by
// definition, even when a vendored copy of the same name happens to sit inside
// the scanned tree (a `.venv/lib/**/site-packages/json/` directory must not
// make `import json` look like a missing in-estate edge). Static list, so the
// classification stays deterministic and offline.
//
// SHARED WITH merge.mjs through platform-vocabulary.mjs. merge.mjs classifies
// WHY a module ended up isolated and this file classifies WHY a record went
// unresolved; both answers turn on "is this specifier a platform built-in",
// and two copies of that list would let the two tools disagree about the same
// specifier.
const PYTHON_STDLIB = PYTHON_STDLIB_MODULES;

// Scan-scope classification. Fragmentation caused by scanning vendored
// dependencies, generated build output, or a duplicate in-repo worktree is a
// SCOPE problem, not a resolution problem, and the two must not be conflated
// when deciding where to spend fixing effort.
const SCAN_SCOPE_RULES = [
  { scope: 'vendored_dependency', test: file => /(?:^|\/)(?:node_modules|site-packages|vendor|Pods|third_party|\.venv[^/]*|venv|bower_components)(?:\/|$)/.test(file) },
  { scope: 'duplicate_worktree', test: file => /(?:^|\/)\.?worktrees(?:\/|$)/.test(file) },
  { scope: 'build_artifact', test: file => /(?:^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|\.tmp|__pycache__|cdk\.out[^/]*|generated|Generated)(?:\/|$)/.test(file) || /\.(?:min|bundle)\.js$/.test(file) || /\.d\.ts$/.test(file) },
];
export const scanScopeOf = file => SCAN_SCOPE_RULES.find(rule => rule.test(String(file || '')))?.scope || 'first_party';

// Category letters, per the diagnosis contract:
//   a = target is legitimately EXTERNAL to the estate. Correct, not a defect.
//   b = target SHOULD have resolved to an in-estate node and did not. The bug.
//   c = AMBIGUOUS: multiple in-estate candidates, deliberately not guessed.
//   d = INDETERMINATE from the available evidence. Never merged into a or b.
const CATEGORIES = { a: 'external_legitimate', b: 'should_have_resolved', c: 'ambiguous', d: 'indeterminate' };

const languageForFile = file => EXTENSION_LANGUAGE[path.posix.extname(String(file || '')).toLowerCase()] || 'other';
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const sortedCounts = map => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
const pct = (part, total) => (total ? Number(((part / total) * 100).toFixed(4)) : 0);

// ---------------------------------------------------------------------------
// Graph loading (read-only)
// ---------------------------------------------------------------------------

export async function loadGraph(graphPath) {
  const text = await fs.readFile(graphPath, 'utf8');
  const graph = JSON.parse(text);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error(`${graphPath} is not an estate graph (missing nodes/edges arrays)`);
  return { graph, bytes: Buffer.byteLength(text) };
}

// Optional facts enrichment. Facts are JSONL, one object per line, exactly as
// extract.mjs wrote them. Only 'symbol' and 'module' facts are retained, so
// memory stays proportional to the declaration count, not the fact count.
export async function loadSymbolIndex(factsDir) {
  let dir = factsDir;
  try { if ((await fs.stat(path.join(factsDir, 'facts'))).isDirectory()) dir = path.join(factsDir, 'facts'); } catch { /* facts dir given directly */ }
  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  // Keyed `${language}\0${name}` -> Set(repo). The language qualifier is
  // load-bearing: a Swift reference to `URL` must not be "resolved" by a
  // Python class named URL in another repo. Cross-language name collisions are
  // common enough (URL, String, Config, Client) to invert the ranking if the
  // index is language-agnostic.
  const symbolRepos = new Map();
  let factLines = 0;
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      factLines += 1;
      // Cheap pre-filter avoids parsing ~99% of lines in a large estate.
      if (!line.includes('"kind":"symbol"')) continue;
      const fact = JSON.parse(line);
      if (fact.kind !== 'symbol' || !fact.name) continue;
      const key = `${languageForFile(fact.file)}\0${fact.name}`;
      const repos = symbolRepos.get(key) || new Set();
      repos.add(fact.repo);
      symbolRepos.set(key, repos);
    }
  }
  return { symbolRepos, factFiles: files.length, factLines };
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

// Weakly connected components over the UNDIRECTED projection of edges that
// have both endpoints present as real nodes. An edge with `to: null`
// (external/ambiguous) connects nothing and is excluded here by construction —
// that exclusion is precisely what the attribution section then explains.
export function computeConnectivity(graph, { top = 20, samples = 5 } = {}) {
  const index = new Map();
  graph.nodes.forEach((node, i) => index.set(node.id, i));
  const parent = new Int32Array(graph.nodes.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  const degree = new Int32Array(graph.nodes.length);
  let linkingEdges = 0, targetlessEdges = 0, danglingEdges = 0, selfLoops = 0;
  for (const edge of graph.edges) {
    if (edge.from == null || edge.to == null) { targetlessEdges += 1; continue; }
    const from = index.get(edge.from), to = index.get(edge.to);
    if (from === undefined || to === undefined) { danglingEdges += 1; continue; }
    linkingEdges += 1;
    degree[from] += 1; degree[to] += 1;
    if (from === to) { selfLoops += 1; continue; }
    union(from, to);
  }

  const members = new Map(); // root index -> node indices
  for (let i = 0; i < parent.length; i++) {
    const root = find(i);
    const list = members.get(root) || [];
    list.push(i);
    members.set(root, list);
  }
  const componentEdges = new Map();
  for (const edge of graph.edges) {
    if (edge.from == null || edge.to == null) continue;
    const from = index.get(edge.from);
    if (from === undefined || index.get(edge.to) === undefined) continue;
    bump(componentEdges, find(from));
  }

  const components = [...members.entries()]
    .map(([root, list]) => ({ root, size: list.length, edges: componentEdges.get(root) || 0, nodes: list }))
    // Deterministic ordering: size desc, then lexically by smallest member id.
    .sort((a, b) => b.size - a.size || graph.nodes[a.nodes[0]].id.localeCompare(graph.nodes[b.nodes[0]].id));

  const giant = components[0] || { size: 0, edges: 0, nodes: [] };
  const isolated = [];
  for (let i = 0; i < degree.length; i++) if (degree[i] === 0) isolated.push(i);

  const buckets = { '1': 0, '2': 0, '3-10': 0, '11-100': 0, '101-1000': 0, '1000+': 0 };
  const bucketOf = size => (size === 1 ? '1' : size === 2 ? '2' : size <= 10 ? '3-10' : size <= 100 ? '11-100' : size <= 1000 ? '101-1000' : '1000+');
  for (const component of components) buckets[bucketOf(component.size)] += 1;

  const describe = component => ({
    size: component.size,
    edges: component.edges,
    kinds: sortedCounts(component.nodes.reduce((map, i) => (bump(map, graph.nodes[i].kind), map), new Map())).slice(0, 5),
    repos: sortedCounts(component.nodes.reduce((map, i) => (bump(map, graph.nodes[i].repo || '(none)'), map), new Map())).slice(0, 5),
    sample_members: component.nodes.slice(0, samples).map(i => ({ id: graph.nodes[i].id, kind: graph.nodes[i].kind, repo: graph.nodes[i].repo || null, name: graph.nodes[i].name ?? null })),
  });

  return {
    index, degree, componentOf: i => find(i), components,
    isolatedIndices: isolated,
    report: {
      totals: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        linking_edges: linkingEdges,
        targetless_edges: targetlessEdges,
        dangling_edges: danglingEdges,
        self_loop_edges: selfLoops,
        unresolved_records: (graph.unresolved || []).length,
      },
      components: {
        count: components.length,
        isolated_nodes: isolated.length,
        isolated_pct: pct(isolated.length, graph.nodes.length),
        giant: {
          nodes: giant.size,
          edges: giant.edges,
          node_share_pct: pct(giant.size, graph.nodes.length),
          edge_share_pct: pct(giant.edges, graph.edges.length),
          linking_edge_share_pct: pct(giant.edges, linkingEdges),
        },
        size_histogram: buckets,
        largest_non_giant: components.slice(1, 1 + top).map(describe),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

// The estate's own vocabulary, derived from the graph itself, used to decide
// whether an unresolved reference SHOULD have found an in-estate target.
//
// EXPORTED because `classifyRecord` below is exported but takes this object as a
// required argument, and until now its only producer was module-private — so the
// exported classifier was not actually callable from another module without
// re-deriving the vocabulary (i.e. forking the classification logic). Callers that
// want per-record a/b/c/d categories WITHOUT paying for a full `attribute()` run
// (which additionally requires a `computeConnectivity()` result they do not need)
// pair this with `classifyRecord`. Pure function of the graph; no I/O.
export function estateVocabulary(graph) {
  const kotlinPackages = new Set();
  const moduleByRepoFile = new Map();
  // Dotted name -> Set(repo). Every path SUFFIX of every scanned Python module
  // is indexed, because Python resolves an absolute import against whichever
  // source root is on sys.path; merge.mjs only infers roots from __init__.py
  // package parents, so a script-directory or packaging-declared root it did
  // not infer shows up here as a real in-estate target it failed to reach.
  const pythonDottedTargets = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== 'module') continue;
    moduleByRepoFile.set(`${node.repo}\0${node.name}`, node);
    if (node.package) kotlinPackages.add(node.package);
    // A vendored / generated / duplicate-worktree copy is not a legitimate
    // resolution target: "numpy exists in-estate" because a venv was scanned
    // does not make `import numpy` a missing first-party edge.
    if (node.language !== 'python' || scanScopeOf(node.name) !== 'first_party') continue;
    const file = String(node.name);
    const stripped = file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : file.replace(/\.py$/, '');
    const segments = stripped.split('/').filter(segment => segment && segment !== '.');
    for (let i = 0; i < segments.length; i++) {
      const dotted = segments.slice(i).join('.');
      const repos = pythonDottedTargets.get(dotted) || new Set();
      repos.add(node.repo);
      pythonDottedTargets.set(dotted, repos);
    }
  }
  return { kotlinPackages, pythonDottedTargets, moduleByRepoFile };
}

// Classify ONE canonical record that failed to produce a resolved in-estate
// edge. First matching rule wins; every rule states the evidence it used.
export function classifyRecord(record, vocabulary, symbolRepos) {
  const file = String(record.file || '');
  const language = languageForFile(file);
  const specifier = typeof record.specifier === 'string' ? record.specifier : null;

  if (record.status === 'ambiguous') {
    // For import ambiguity the DISCRIMINATOR matters more than the count: a
    // tie between `x.ts` and its compiled `x.js` is a precedence bug, while a
    // tie between two genuinely different files is an irreducible ambiguity.
    const extensions = [...new Set((record.candidates || []).map(id => path.posix.extname(String(id)) || '(none)'))].sort();
    const signature = extensions.length ? extensions.join('+') : '(no candidates recorded)';
    return { category: 'c', family: `ambiguous:${record.kind}:${language}:${signature}`, why: `${(record.candidates || []).length} in-estate candidates differing only by ${signature}; merge refuses to guess` };
  }

  if (record.status === 'external') {
    // merge.mjs declared this external. The graph alone cannot tell whether the
    // referenced symbol exists in ANOTHER estate repo, because merge's symbol
    // tables are repo-scoped. Facts enrichment can.
    if (symbolRepos && record.kind === 'reference' && record.name) {
      const repos = symbolRepos.get(`${language}\0${record.name}`);
      const elsewhere = repos && [...repos].filter(repo => repo !== record.repo);
      if (elsewhere && elsewhere.length) {
        return { category: 'b', family: `cross_repo_symbol_not_resolved:${language}`, why: `symbol '${record.name}' is declared in-estate by repo(s) ${elsewhere.slice(0, 3).join(', ')}; merge resolves references only within ${record.repo}` };
      }
    }
    if (record.kind === 'import') return { category: 'a', family: `external_sdk_import:${language}`, why: 'import FQN matches a known external SDK/platform root' };
    return { category: 'a', family: `external_symbol:${record.kind}:${language}`, why: 'referenced name is declared nowhere in the scanned estate' };
  }

  // status === 'unresolved' from here down.
  if (record.kind === 'import') {
    if (specifier && specifier.startsWith('.')) {
      // merge.mjs resolves a relative specifier as a filesystem path across
      // the WHOLE estate, so "unresolved" no longer implies a defect. Two of
      // the reasons it records are legitimately external, not missing edges:
      // the target sits outside the estate root, or the scan-scope exclusion
      // set deliberately removed it (vendored dependency / build artifact /
      // duplicate worktree). Attribute those to (a), never to (b).
      if (record.unresolved_reason === 'escapes_estate_root') {
        return { category: 'a', family: `relative_import_escapes_estate_root:${language}`, why: `specifier resolves to '${record.estate_target_path}', above the scanned estate root` };
      }
      if (record.unresolved_reason === 'excluded_by_scan_scope') {
        const scope = record.excluded_by_scan_scope?.category || 'excluded';
        return { category: 'a', family: `relative_import_into_excluded_scope:${scope}:${language}`, why: `target path '${record.estate_target_path}' was removed from the scan by the ${scope} exclusion rule '${record.excluded_by_scan_scope?.rule ?? '(unknown)'}' — no node exists by design` };
      }
      // A specifier naming a NON-SOURCE ASSET is correct code that no source
      // extractor will ever produce a module fact for (the JS extractor's
      // filePattern covers .ts/.tsx/.js/.jsx/.mjs/.cjs only). Counting it as
      // "should have resolved" invents a defect out of a stylesheet import.
      if (record.unresolved_reason === 'non_source_asset') {
        return { category: 'a', family: `relative_import_non_source_asset:${record.asset_extension || '(unknown)'}:${language}`, why: `specifier names a '${record.asset_extension}' asset; no source extractor emits a module fact for that extension, so no in-estate node exists by design` };
      }
      // DANGLING vs UNREACHED. merge records whether the target's own directory
      // produced module facts. If it did, the scan covered that directory and
      // the named file simply is not in it — a source-side dangling reference.
      // Whether it was deleted or never existed is not decidable from the fact
      // stream, which is what (d) means; it is emphatically NOT a resolver
      // defect, which is what (b) means.
      if (record.unresolved_reason === 'no_module_fact' && record.target_directory_scanned === true) {
        return { category: 'd', family: `relative_import_target_absent:${language}`, why: `the target's directory WAS scanned and produced module facts, but no candidate matched '${record.estate_target_path}' — the reference is dangling in the source, not missed by the resolver` };
      }
      // Graphs produced before merge.mjs recorded a reason: fall back to
      // classifying the component-relative target path directly.
      if (record.unresolved_reason === undefined) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const scope = scanScopeOf(target);
        if (scope !== 'first_party') {
          return { category: 'a', family: `relative_import_into_excluded_scope:${scope}:${language}`, why: `target path '${target}' lies in ${scope} territory the scan deliberately excludes` };
        }
      }
      return { category: 'b', family: `relative_import_unresolved:${language}`, why: 'specifier names a real filesystem path inside the estate but no scanned module fact matched it' };
    }
    if (record.import_kind === 'relative-from') {
      return { category: 'b', family: `relative_import_unresolved:${language}`, why: 'relative-from import can only target a module inside the same component' };
    }
    if (specifier && (language === 'kotlin' || language === 'kotlin-script')) {
      const base = record.is_wildcard ? specifier.slice(0, -2) : specifier;
      const pkg = record.is_wildcard ? base : base.slice(0, Math.max(0, base.lastIndexOf('.')));
      if (pkg && vocabulary.kotlinPackages.has(pkg)) {
        return { category: 'b', family: 'kotlin_import_into_declared_estate_package', why: `package '${pkg}' IS declared by an in-estate module; only the symbol failed to resolve` };
      }
      if (KOTLIN_EXTERNAL_PACKAGE_ROOTS.some(root => base === root || base.startsWith(`${root}.`))) {
        return { category: 'a', family: 'external_sdk_import:kotlin', why: 'FQN root is a known JVM/Android SDK namespace' };
      }
      return { category: 'd', family: 'kotlin_import_unknown_package', why: 'FQN root is neither an in-estate package nor a known SDK root' };
    }
    if (specifier && language === 'python') {
      const root = specifier.split('.')[0];
      if (PYTHON_STDLIB.has(root)) {
        return { category: 'a', family: 'external_stdlib_import:python', why: `'${root}' is a Python stdlib top-level module` };
      }
      const repos = vocabulary.pythonDottedTargets.get(specifier);
      if (repos && repos.size) {
        const sameRepo = repos.has(record.repo);
        return sameRepo
          ? { category: 'b', family: 'python_absolute_import_source_root_gap', why: `'${specifier}' IS a scanned module inside ${record.repo}; merge inferred no source root that makes it importable` }
          : { category: 'b', family: 'python_absolute_import_cross_repo', why: `'${specifier}' IS a scanned module in in-estate repo(s) ${[...repos].sort().slice(0, 3).join(', ')}; merge resolves Python imports only within ${record.repo}` };
      }
      return { category: 'a', family: 'external_package_import:python', why: 'specifier matches no scanned in-estate module path and is not stdlib — third-party' };
    }
    if (specifier) return { category: 'd', family: `bare_import_unclassified:${language}`, why: 'bare specifier with no in-estate/external evidence available from the graph' };
  }

  if (record.kind === 'tf_ref') {
    // merge records WHICH declaration set it searched. A reference to an
    // address the module never declares (`aws_lambda_layer_version.missing`, an
    // undeclared `var.`) cannot resolve however good the resolver is; only a
    // reference whose target IS declared and still missed is a defect.
    if (record.unresolved_reason === 'target_address_not_declared_in_module') {
      return { category: 'd', family: 'tf_ref_target_address_never_declared', why: `'${record.to}' is declared by no resource in module '${record.module_path}' of ${record.repo}; a module-scoped reference to an undeclared address has no target to reach` };
    }
    if (record.unresolved_reason === 'declaration_not_found_in_module' || record.unresolved_reason === 'module_output_not_found') {
      return { category: 'd', family: `tf_ref_${record.unresolved_reason}`, why: `'${record.to}' names a variable/local/module output that module '${record.module_path}' does not declare; a declaration is a fact, not a node, so no edge endpoint exists` };
    }
    return { category: 'b', family: 'tf_ref_unresolved', why: 'a Terraform address is module-scoped: its target is always inside the same component' };
  }
  if (record.kind === 'config_key') {
    return { category: 'd', family: 'config_key_read_unmatched', why: 'a read config key may legitimately be declared outside the scanned estate' };
  }
  if (record.kind === 'http_client') {
    return { category: 'd', family: `http_client_unmatched:${record.association_kind || 'unknown'}`, why: 'an outbound URL may legitimately target a third-party service' };
  }
  if (record.kind === 'aws_usage') {
    return { category: 'd', family: 'aws_usage_unmatched', why: 'a publish target may legitimately be an out-of-estate topic' };
  }
  if (record.kind === 'tf_resource') {
    return { category: 'd', family: `tf_resource_unassociated:${record.association_kind || 'unknown'}`, why: 'deployment resource shares no distinguishing token with any repo' };
  }
  return { category: 'd', family: `unclassified:${record.kind}:${language}`, why: 'no classification rule matched' };
}

export function attribute(graph, connectivity, { samples = 5, symbolRepos = null } = {}) {
  const vocabulary = estateVocabulary(graph);
  const { index, degree, components } = connectivity;
  const giantRoot = components[0]?.root;

  const nodeState = new Map(); // node id -> 'giant' | 'non_giant' | 'isolated'
  for (let i = 0; i < graph.nodes.length; i++) {
    const root = connectivity.componentOf(i);
    nodeState.set(graph.nodes[i].id, degree[i] === 0 ? 'isolated' : root === giantRoot ? 'giant' : 'non_giant');
  }

  const emptyBucket = () => ({ kind: new Map(), language: new Map(), extractor: new Map(), repo: new Map(), scope: new Map() });
  const byBucket = { isolated: emptyBucket(), non_giant: emptyBucket(), giant: emptyBucket() };
  const scopeByState = new Map();
  // First-party-only view: the same three states restricted to source the team
  // actually owns, so scan-scope noise cannot mask (or manufacture) a
  // connectivity result about the real estate.
  const firstParty = { state: new Map(), language: new Map(), repo: new Map(), isolated_language: new Map(), isolated_repo: new Map() };
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const state = nodeState.get(node.id);
    const scope = node.kind === 'module' ? scanScopeOf(node.name) : 'n/a (non-source node)';
    bump(scopeByState, `${state}\0${scope}`);
    if (scope === 'first_party') {
      bump(firstParty.state, state);
      bump(firstParty.language, node.language || 'unknown');
      bump(firstParty.repo, node.repo || '(none)');
      if (state === 'isolated') { bump(firstParty.isolated_language, node.language || 'unknown'); bump(firstParty.isolated_repo, node.repo || '(none)'); }
    }
    const target = byBucket[state];
    bump(target.kind, node.kind);
    bump(target.language, node.language || (node.kind === 'module' ? 'unknown-module' : 'n/a (non-source node)'));
    bump(target.extractor, node.kind === 'module' ? `treesitter-${node.language || 'unknown'}` : (NODE_KIND_EXTRACTOR[node.kind] || 'unknown'));
    bump(target.repo, node.repo || '(none)');
    bump(target.scope, scope);
  }

  const edgeKindStatus = new Map();
  const targetlessEdgeKindStatus = new Map();
  for (const edge of graph.edges) {
    bump(edgeKindStatus, `${edge.kind}\0${edge.status}`);
    if (edge.from == null || edge.to == null || !index.has(edge.to)) bump(targetlessEdgeKindStatus, `${edge.kind}\0${edge.status}`);
  }
  const expandKindStatus = map => [...map.entries()].map(([key, count]) => { const [kind, status] = key.split('\0'); return { kind, status, count }; }).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status));

  // Category a/b/c/d over the canonical `unresolved` population: every fact
  // that did NOT produce a resolved in-estate edge. Ambiguous records appear
  // both here and as a targetless edge; the two populations are reported
  // separately and never summed.
  const families = new Map(); // family -> {category, count, why, sourceNodes:Set, examples:[]}
  const categoryTotals = { a: 0, b: 0, c: 0, d: 0 };
  const byLanguage = new Map(); // `${category}\0${language}` -> count
  for (const record of graph.unresolved || []) {
    const verdict = classifyRecord(record, vocabulary, symbolRepos);
    categoryTotals[verdict.category] += 1;
    bump(byLanguage, `${verdict.category}\0${languageForFile(record.file)}`);
    const entry = families.get(verdict.family) || { family: verdict.family, category: verdict.category, category_name: CATEGORIES[verdict.category], why: verdict.why, count: 0, source_nodes: new Set(), disconnected_source_nodes: new Set(), examples: [] };
    entry.count += 1;
    const source = vocabulary.moduleByRepoFile.get(`${record.repo}\0${record.file}`);
    if (source) {
      entry.source_nodes.add(source.id);
      if (nodeState.get(source.id) !== 'giant') entry.disconnected_source_nodes.add(source.id);
    }
    if (entry.examples.length < samples) {
      entry.examples.push({
        source_node_id: source ? source.id : null,
        source_node_state: source ? nodeState.get(source.id) : null,
        repo: record.repo,
        source: `${record.file}:${record.line}`,
        record_kind: record.kind,
        reference: record.specifier ?? record.name ?? record.key_name ?? record.to ?? record.url_or_path ?? record.target_name_or_expr ?? null,
        status: record.status,
        candidate_count: Array.isArray(record.candidates) ? record.candidates.length : undefined,
      });
    }
    families.set(verdict.family, entry);
  }

  const serializeFamily = entry => ({
    family: entry.family,
    category: entry.category,
    category_name: entry.category_name,
    why: entry.why,
    records: entry.count,
    distinct_source_nodes: entry.source_nodes.size,
    disconnected_source_nodes: entry.disconnected_source_nodes.size,
    examples: entry.examples,
  });
  const rank = category => [...families.values()].filter(entry => entry.category === category).sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)).map(serializeFamily);

  const total = (graph.unresolved || []).length;
  return {
    unresolved_population: total,
    categories: Object.entries(CATEGORIES).map(([letter, name]) => ({ category: letter, name, records: categoryTotals[letter], pct_of_unresolved: pct(categoryTotals[letter], total) })),
    category_by_language: [...byLanguage.entries()].map(([key, count]) => { const [category, language] = key.split('\0'); return { category, category_name: CATEGORIES[category], language, count }; }).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.language.localeCompare(b.language)),
    ranked_b_should_have_resolved: rank('b'),
    a_external_legitimate: rank('a'),
    c_ambiguous: rank('c'),
    d_indeterminate: rank('d'),
    nodes: {
      isolated_by_kind: sortedCounts(byBucket.isolated.kind),
      isolated_by_language: sortedCounts(byBucket.isolated.language),
      isolated_by_extractor: sortedCounts(byBucket.isolated.extractor),
      isolated_by_repo: sortedCounts(byBucket.isolated.repo),
      non_giant_by_kind: sortedCounts(byBucket.non_giant.kind),
      non_giant_by_language: sortedCounts(byBucket.non_giant.language),
      non_giant_by_extractor: sortedCounts(byBucket.non_giant.extractor),
      non_giant_by_repo: sortedCounts(byBucket.non_giant.repo),
      isolated_by_scan_scope: sortedCounts(byBucket.isolated.scope),
      non_giant_by_scan_scope: sortedCounts(byBucket.non_giant.scope),
      giant_by_scan_scope: sortedCounts(byBucket.giant.scope),
      by_state_and_scan_scope: [...scopeByState.entries()].map(([key, count]) => { const [state, scope] = key.split('\0'); return { state, scope, count }; }).sort((a, b) => b.count - a.count || a.state.localeCompare(b.state) || a.scope.localeCompare(b.scope)),
      first_party_only: {
        total: [...firstParty.state.values()].reduce((sum, count) => sum + count, 0),
        by_state: sortedCounts(firstParty.state),
        by_language: sortedCounts(firstParty.language),
        by_repo: sortedCounts(firstParty.repo),
        isolated_by_language: sortedCounts(firstParty.isolated_language),
        isolated_by_repo: sortedCounts(firstParty.isolated_repo),
      },
    },
    edges: {
      by_kind_and_status: expandKindStatus(edgeKindStatus),
      targetless_by_kind_and_status: expandKindStatus(targetlessEdgeKindStatus),
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function analyze(graphPath, { factsDir = null, top = 20, samples = 5 } = {}) {
  const { graph, bytes } = await loadGraph(graphPath);
  let symbols = null;
  if (factsDir) symbols = await loadSymbolIndex(factsDir);
  const connectivity = computeConnectivity(graph, { top, samples });
  const attribution = attribute(graph, connectivity, { samples, symbolRepos: symbols?.symbolRepos || null });
  const report={
    schema_version: 1,
    input: {
      graph: path.basename(graphPath),
      graph_bytes: bytes,
      graph_schema_version: graph.schema_version ?? null,
      facts_dir: factsDir ? path.basename(path.resolve(factsDir)) : null,
      facts_files: symbols?.factFiles ?? null,
      facts_lines: symbols?.factLines ?? null,
      distinct_symbol_names: symbols ? symbols.symbolRepos.size : null,
    },
    ...connectivity.report,
    attribution,
    metric_definitions:CONNECTIVITY_METRIC_DEFINITIONS,
    runtime: {
      // Operational timing and heap samples cannot belong in deterministic evidence.
      node_version: process.version,
    },
  };
  assertMetricDefinitionCoverage(report,CONNECTIVITY_METRIC_DEFINITIONS,{roots:['totals','components','attribution']});
  return report;
}

function renderText(report) {
  const lines = [];
  const t = report.totals, c = report.components;
  lines.push(`graph: ${report.input.graph} (${(report.input.graph_bytes / 1048576).toFixed(1)} MiB)`);
  lines.push(`nodes=${t.nodes} edges=${t.edges} linking=${t.linking_edges} targetless=${t.targetless_edges} dangling=${t.dangling_edges} unresolved_records=${t.unresolved_records}`);
  lines.push(`components=${c.count} isolated=${c.isolated_nodes} (${c.isolated_pct}%)`);
  lines.push(`giant: ${c.giant.nodes} nodes (${c.giant.node_share_pct}% of nodes), ${c.giant.edges} edges (${c.giant.edge_share_pct}% of all edges, ${c.giant.linking_edge_share_pct}% of linking edges)`);
  lines.push(`histogram: ${Object.entries(c.size_histogram).map(([bucket, count]) => `${bucket}=${count}`).join(' ')}`);
  lines.push('');
  lines.push('largest non-giant components:');
  for (const component of c.largest_non_giant) lines.push(`  size=${component.size} edges=${component.edges} kinds=${component.kinds.map(k => `${k.key}:${k.count}`).join(',')} sample=${component.sample_members.map(m => m.id).join(' | ')}`);
  lines.push('');
  lines.push('unresolved-record categories:');
  for (const row of report.attribution.categories) lines.push(`  (${row.category}) ${row.name}: ${row.records} (${row.pct_of_unresolved}%)`);
  lines.push('');
  lines.push('ranked (b) SHOULD-HAVE-RESOLVED families:');
  for (const family of report.attribution.ranked_b_should_have_resolved) lines.push(`  ${family.records.toString().padStart(8)}  ${family.family}  [distinct source nodes=${family.distinct_source_nodes}, disconnected=${family.disconnected_source_nodes}]`);
  lines.push('');
  lines.push('isolated nodes by kind:');
  for (const row of report.attribution.nodes.isolated_by_kind) lines.push(`  ${row.count.toString().padStart(8)}  ${row.key}`);
  lines.push('');
  lines.push('isolated nodes by language:');
  for (const row of report.attribution.nodes.isolated_by_language) lines.push(`  ${row.count.toString().padStart(8)}  ${row.key}`);
  lines.push('');
  lines.push('nodes by component state x scan scope:');
  for (const row of report.attribution.nodes.by_state_and_scan_scope) lines.push(`  ${row.count.toString().padStart(8)}  ${row.state} / ${row.scope}`);
  lines.push('');
  const fp = report.attribution.nodes.first_party_only;
  lines.push(`FIRST-PARTY source modules only (total ${fp.total}):`);
  for (const row of fp.by_state) lines.push(`  ${row.count.toString().padStart(8)}  state=${row.key} (${pct(row.count, fp.total)}%)`);
  lines.push('  by language: ' + fp.by_language.map(row => `${row.key}=${row.count}`).join(' '));
  lines.push('  by repo: ' + fp.by_repo.map(row => `${row.key}=${row.count}`).join(' '));
  lines.push('  isolated by language: ' + fp.isolated_by_language.map(row => `${row.key}=${row.count}`).join(' '));
  lines.push('  isolated by repo: ' + fp.isolated_by_repo.map(row => `${row.key}=${row.count}`).join(' '));
  lines.push('');
  lines.push('ranked (c) AMBIGUOUS families:');
  for (const family of report.attribution.c_ambiguous) lines.push(`  ${family.records.toString().padStart(8)}  ${family.family}  [distinct source nodes=${family.distinct_source_nodes}]`);
  lines.push('');
  lines.push('ranked (a) EXTERNAL-LEGITIMATE families:');
  for (const family of report.attribution.a_external_legitimate) lines.push(`  ${family.records.toString().padStart(8)}  ${family.family}`);
  lines.push('');
  lines.push('ranked (d) INDETERMINATE families:');
  for (const family of report.attribution.d_indeterminate) lines.push(`  ${family.records.toString().padStart(8)}  ${family.family}`);
  lines.push('');
  lines.push(`runtime: operational samples omitted from deterministic report; node ${report.runtime.node_version}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.help || !options.graph) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  analyze(options.graph, {
    factsDir: options.facts || null,
    top: options.top ? Number(options.top) : 20,
    samples: options.samples ? Number(options.samples) : 5,
  }).then(async report => {
    if (options.out) {
      await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
      await fs.writeFile(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(options.json ? JSON.stringify(report, null, 2) : renderText(report));
  }).catch(error => { console.error(error.message); process.exit(1); });
}
