// Bounded resolver from a cited passage to the nodes of an existing source graph. The graph is read once into a compact index of the
// nodes that carry an exact source locator (repository, file, line); the graph itself is never shipped. A node is offered as a
// reference only when its own locator falls inside the quoted lines of the same file in the same repository. A name or namespace match
// is not a reference. Whether the graph and the passage describe the same commit is stated per reference, not assumed.
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const LOCATOR_BOUNDS = Object.freeze({ refs_per_passage: 8 });

/** Streams a node file and keeps only nodes with a repository, file and line. Returns { by_file, nodes, skipped }. */
export async function buildLocatorIndex(nodesPath, { graphPins = {}, graphRef = {} } = {}) {
  const byFile = new Map();
  let nodes = 0, kept = 0;
  const rl = createInterface({ input: createReadStream(nodesPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    nodes += 1;
    const o = JSON.parse(line), p = o.properties ?? {};
    const repository = p.repository, file = p.file ?? p.document_path, at = Number(p.line);
    if (!repository || !file || !Number.isInteger(at) || at < 1) continue;
    kept += 1;
    const key = `${repository}\u0000${file}`;
    (byFile.get(key) ?? byFile.set(key, []).get(key)).push([at, o.node_id, o.kind, String(o.label ?? '').slice(0, 120)]);
  }
  for (const rows of byFile.values()) rows.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return { schema: 'estate-map/graph-locator-index/v1', graph: graphRef, graph_pins: graphPins, nodes_read: nodes, nodes_with_locator: kept, files: byFile.size, by_file: Object.fromEntries(byFile) };
}

export function saveLocatorIndex(index, path) { writeFileSync(path, JSON.stringify(index), { mode: 0o600 }); }
export function loadLocatorIndex(path) { return JSON.parse(readFileSync(path, 'utf8')); }

const lowerBound = (rows, line) => { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] < line) lo = mid + 1; else hi = mid; } return lo; };

/**
 * References for one evidence row. `pin_consistent` is true only when the graph was built at the very commit the passage was read at;
 * it is null when the graph has no recorded commit for that repository, and false when the commits differ.
 */
export function resolvePassage(index, evidence, bounds = LOCATOR_BOUNDS) {
  const rows = index.by_file[`${evidence.repository}\u0000${evidence.path}`];
  if (!rows || !Number.isInteger(evidence.start_line)) return [];
  const end = Number.isInteger(evidence.end_line) ? evidence.end_line : evidence.start_line;
  const graphCommit = index.graph_pins?.[evidence.repository] ?? null;
  const pinConsistent = graphCommit == null ? null : graphCommit === evidence.commit_sha;
  const out = [];
  for (let i = lowerBound(rows, evidence.start_line); i < rows.length && rows[i][0] <= end && out.length < bounds.refs_per_passage; i += 1) {
    const [line, node_id, kind, label] = rows[i];
    out.push({ node_id, kind, label, repository: evidence.repository, file: evidence.path, line, match: 'node_line_within_quoted_lines', graph_commit_sha: graphCommit, passage_commit_sha: evidence.commit_sha, pin_consistent: pinConsistent });
  }
  return out;
}

/** Resolves every evidence row of a generation; returns only rows that have references, plus a header that says what was and was not checkable. */
export function resolveGeneration(index, generation) {
  const refs = {}, perRepo = {};
  let rows = 0, withRefs = 0;
  for (const c of generation.collections) for (const e of c.evidence) {
    rows += 1;
    const r = resolvePassage(index, e);
    const repo = perRepo[e.repository] ??= { evidence_rows: 0, with_refs: 0, graph_pin: index.graph_pins?.[e.repository] ?? null };
    repo.evidence_rows += 1;
    if (r.length) { refs[e.evidence_id] = r; withRefs += 1; repo.with_refs += 1; }
  }
  return { schema: 'estate-map/evidence-graph-refs/v1', base_generation_id: generation.generation_id, graph: index.graph, graph_pins: index.graph_pins, nodes_with_locator: index.nodes_with_locator,
    evidence_rows: rows, evidence_rows_with_refs: withRefs, per_repository: perRepo,
    note: 'A reference means a graph node whose own locator lies inside the quoted lines of the same file. It does not say the node is what the passage is about, and a passage without a reference has none that could be shown, not none that exists.', refs };
}
