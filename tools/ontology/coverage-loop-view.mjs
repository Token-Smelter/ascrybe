// Reads the rounds of an offline coverage loop: proposed concepts and proposed anchors that would reach more of the graph. Everything
// in a round is a proposal on top of the sealed generation. A round is used only if it was made for this generation; nothing is
// accepted, and the sealed ontology and the graph are never changed by it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadCoverageLoop(dir, generationId) {
  if (!existsSync(dir)) return null;
  const rounds = readdirSync(dir).filter(f => /^round-\d+\.json$/u.test(f)).sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]))
    .map(f => ({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), file_round: Number(f.match(/\d+/u)[0]) }))
    .filter(r => r.schema === 'estate-map/coverage-loop-round/v1' && r.base_generation_id === generationId);
  if (!rounds.length) return null;
  return rounds.map(r => {
    const proposals = [...r.proposals.new_concepts, ...(r.heldout.new_concepts_needed ?? [])].filter((p, i, all) => all.findIndex(q => q.proposal_id === p.proposal_id) === i);
    const bindings = [...(r.proposals.bindings_design ?? []), ...(r.heldout.bindings ?? [])];
    const results = [...r.design.results, ...r.heldout.results];
    const after = {};
    for (const x of results) after[x.cause_after_model] = (after[x.cause_after_model] ?? 0) + 1;
    return { round: r.round ?? r.file_round, status: r.status, coverage: r.coverage, frontier: r.frontier, measures: r.measures, cost: r.cost, complexity: { before: r.compression.complexity_before, after: r.compression.complexity_after },
      proposals, bindings, groups: r.compression.groups, causes_after_model: after, retrieval: r.retrieval };
  });
}
