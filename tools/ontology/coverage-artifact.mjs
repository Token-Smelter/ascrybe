// Reads an offline coverage artifact of one graph by one ontology generation: a summary, per-disposition shards that list nodes a
// page at a time, and hashed shards that explain one node. The measure is a reach over ADMITTED graph nodes by evidence anchor and
// navigation, not a semantic correctness score, and it carries its own label for that. Nothing is computed here and nothing is written.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Plain names for the artifact's dispositions. The artifact is the authority on which exist and how many nodes each holds.
export const DISPOSITION_TEXT = Object.freeze({
  evidence_anchored: ['Evidence-anchored', 'The node\'s own line lies inside a passage that supports a concept. An association with evidence, not the identity or type of the concept.'],
  anchored_entity: ['Anchored entity', 'An entity the graph binds, through an identity relation, to an anchored observation.'],
  owned_detail: ['Owned detail', 'Reached by walking ownership relations (at most three steps) from an anchored node.'],
  participates_with_grounded: ['Participates with anchored', 'One step over a participation relation from an anchored node. Never walked onward.'],
  cited_document_locator: ['Cited document (locator)', 'A document some concept cites. Navigational only: it does not reach the uncited rest of its file and is not counted as reached.'],
  locator_root: ['Locator root', 'A repository, commit or project node. A place to start, never a semantic parent.'],
  unplaced: ['Unplaced', 'No cited passage or owning node reaches it. Listed so it can be opened; not counted as reached.'],
});
const REACHED = ['evidence_anchored', 'anchored_entity', 'owned_detail', 'participates_with_grounded'];
const shardOf = id => createHash('sha1').update(id).digest('hex').slice(0, 2);
const fileOf = repo => `${repo === '(no repository locator)' ? '_no_repository_locator_' : repo}.jsonl`;

async function* lines(path) {
  if (!existsSync(path)) return;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line) yield JSON.parse(line);
}

export function openCoverage(dir) {
  const summary = JSON.parse(readFileSync(join(dir, 'graph-coverage-summary.json'), 'utf8'));
  const index = JSON.parse(readFileSync(join(dir, 'shard-index.json'), 'utf8'));
  return Object.freeze({
    summary, admitted: summary.admitted_nodes ?? summary.denominators.admitted_graph_nodes, reached: summary.reached_nodes, share: summary.reach_share_of_admitted_nodes,
    label: summary.reach_share_label, notes: summary.notes ?? [], baseGeneration: summary.base_generation_id,
    counts: summary.by_disposition, unplacedReasons: summary.unplaced_reasons, byPlane: summary.by_plane, denominators: summary.denominators, isReached: d => REACHED.includes(d),
    dispositions: () => Object.entries(summary.by_disposition).filter(([, n]) => n > 0).sort((a, b) => Number(b[0] !== 'unplaced') - Number(a[0] !== 'unplaced') || b[1] - a[1]),
    repositories: d => Object.entries(index.dispositions[d] ?? {}).sort((a, b) => b[1] - a[1]),
    // One page of a disposition within a repository, streamed from its shard; lines before the offset are skipped, not kept.
    async page(disposition, repo, offset = 0, limit = 40) {
      const rows = []; let n = 0;
      for await (const row of lines(join(dir, 'shards', disposition, fileOf(repo)))) {
        if (n++ < offset) continue;
        rows.push(row);
        if (rows.length >= limit) break;
      }
      return rows;
    },
    async explain(nodeId) {
      for await (const row of lines(join(dir, 'by-id', `${shardOf(nodeId)}.jsonl`))) if (row.node_id === nodeId) return row;
      return null;
    },
  });
}

// Used when no artifact is supplied: the graph's node count, and an explicit statement that no reach is claimed.
export const noCoverage = admitted => Object.freeze({ summary: null, admitted, reached: 0, share: 0, label: 'No coverage artifact was supplied, so no reach is claimed.', notes: [], baseGeneration: null, counts: {}, unplacedReasons: {}, byPlane: {}, denominators: {},
  isReached: () => false, dispositions: () => [], repositories: () => [], page: async () => [], explain: async () => null });
