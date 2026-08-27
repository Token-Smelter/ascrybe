#!/usr/bin/env node
// One-command current-head map (roadmap step: cheap full re-maps with drift stamps).
//
// v1 scope, stated honestly: the CODE PLANE networked graph — module/symbol/route/table entities
// resolved through the real identity machinery, plus traversable typed dependency relations.
// Documentary claims join in a later slice; nothing here fabricates them.
//
// Usage:
//   node scripts/remap.mjs --work <extract+merge work dir> --sha <head> --out <map dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeGroundedAssertions } from '../tools/code-grounded-assertions.mjs';
import {
  buildCodeDependencyRelations, traversableRelations,
} from '../tools/code-dependency-relations.mjs';
import {
  groupIdentityCandidatesByExactBasis,
} from '../tools/identity-candidate-generator.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityVerificationRegistry,
  buildVerifiedComponentIdentityDecision, resolveIdentityComponents,
} from '../tools/referent-identity.mjs';
import { buildDocTokenIndex, joinDocOccurrences } from '../tools/doc-code-occurrences.mjs';
import { sha256, stableStringify } from '../tools/lib.mjs';

const canonical = value => stableStringify(value).trim();
const MATERIALIZATION_ID = 'materialization:remap-code-plane-v1';

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--work') held.work = resolve(value);
    else if (flag === '--sha') held.sha = value;
    else if (flag === '--out') held.out = resolve(value);
    else if (flag === '--docs-root') held.docs_root = resolve(value);
    else if (flag === '--docs-config') held.docs_config = resolve(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const required of ['work', 'sha', 'out']) {
    if (!held[required]) throw new Error(`--${required} is required`);
  }
  return held;
}

export function remapCodePlane({ work, sha, out, docs_root: docsRoot = null,
  docs_config: docsConfig = null, source_pins: sourcePinMap = null }) {
  const startedAt = new Date().toISOString();
  const plane = buildCodeGroundedAssertions({
    facts_dir: join(work, 'extract'),
    extract_manifest: JSON.parse(readFileSync(join(work, 'extract', '_MANIFEST.json'), 'utf8')),
    merge_graph: JSON.parse(readFileSync(join(work, 'merge', 'estate-graph.json'), 'utf8')),
    merge_graph_digest: readFileSync(join(work, 'merge', 'digest.txt'), 'utf8').trim(),
    source_head: sha, required_source_head: sha,
    recorded_time: startedAt,
  });
  console.log(`STAGE plane:done candidates=${plane.identity_candidates.length}`);

  // Entity resolution through the real machinery: exact-basis groups, anchor-star constraints,
  // verifier-issued component decisions, whole-component resolution. No shortcut identity.
  const groups = groupIdentityCandidatesByExactBasis(plane.identity_candidates);
  const evidenceById = new Map(plane.grounding_registry.evidence_pointers
    .map(row => [row.evidence_id, row]));
  const registry = buildIdentityVerificationRegistry({
    mentions: plane.identity_candidates.map(row => row.mention),
    evidence_pointers: plane.identity_candidates.map(row => evidenceById.get(row.evidence_id)),
  });
  console.log(`STAGE registry:done groups=${groups.length}`);
  const constraints = [];
  const constraintsByGroup = new Map();
  for (const group of groups) {
    if (group.members.length < 2) { constraintsByGroup.set(group.component_id, []); continue; }
    const [anchorRow, ...members] = group.members;
    const held = members.map(member => buildAutomaticIdentityConstraint({
      left: anchorRow.mention.mention_id,
      right: member.mention.mention_id,
      basis: { ...anchorRow.candidate_basis, source_version_id: plane.code_plane_head },
      basis_evidence_ids: [anchorRow.evidence_id, member.evidence_id],
      basis_assertion_ids: [],
      source_status: 'current',
      valid_time: null,
      materialization_id: MATERIALIZATION_ID,
    }, registry));
    constraints.push(...held);
    constraintsByGroup.set(group.component_id, held);
  }
  const decisions = groups.map(group => buildVerifiedComponentIdentityDecision({
    candidate_mention_ids: group.members.map(row => row.mention.mention_id),
    declaration_mention_ids: group.members.map(row => row.mention.mention_id),
    identity_constraints: constraintsByGroup.get(group.component_id),
  }, registry));
  console.log(`STAGE decisions:done count=${decisions.length}`);
  const resolution = resolveIdentityComponents({
    mention_ids: plane.identity_candidates.map(row => row.mention.mention_id),
    identity_constraints: constraints,
    materialization_id: MATERIALIZATION_ID,
    identity_verification_registry: registry,
    component_identity_decisions: decisions,
  });
  console.log(`STAGE resolution:done referents=${resolution.referents.length} resolved=${resolution.mention_resolutions.length}`);

  const mergeGraph = JSON.parse(readFileSync(join(work, 'merge', 'estate-graph.json'), 'utf8'));
  const projected = buildCodeDependencyRelations({
    merge_graph: mergeGraph, code_plane_head: plane.code_plane_head,
    identity_candidates: plane.identity_candidates,
  });
  const walkable = traversableRelations({
    relations: projected.relations, mention_resolutions: resolution.mention_resolutions,
  });
  console.log(`STAGE relations:done records=${projected.relations.length} traversable=${walkable.length}`);

  // Explorer feed: entity nodes labelled by their exact surface, edges = traversable relations.
  const candidateByMention = new Map(plane.identity_candidates
    .map(row => [row.mention.mention_id, row]));
  const nodes = {};
  const adj = {};
  const link = (from, type, to) => { (adj[from] = adj[from] || []).push([type, to, '']); };
  const identityBindings = [];
  for (const row of resolution.mention_resolutions) {
    const candidate = candidateByMention.get(row.mention_id);
    if (!candidate) continue;
    if (!nodes[row.referent_id]) nodes[row.referent_id] = {
      k: 'entity', l: candidate.mention.surface, ns: candidate.mention.namespace,
      r: candidate.fact_kind,
    };
    identityBindings.push({
      fact_id: candidate.fact_id,
      fact_kind: candidate.fact_kind,
      mention_id: row.mention_id,
      referent_id: row.referent_id,
      resolution_receipt_id: row.resolution_receipt_id || null,
      surface: candidate.mention.surface,
      repository: candidate.record.repo,
      file: candidate.record.file,
      line: candidate.record.line,
      declaration_kind: candidate.record.symbol_kind || candidate.record.object_kind
        || candidate.record.declaration_kind || null,
    });
  }
  const graphRelations = walkable.map(row => ({ ...row }));
  for (const relation of walkable) {
    link(relation.from_referent_id, relation.edge_kind, relation.to_referent_id);
    link(relation.to_referent_id, relation.edge_kind, relation.from_referent_id);
  }
  // Deterministic document evidence: byte-exact surface occurrences across the markdown corpus.
  let docJoin = null;
  if (docsRoot) {
    const documentPaths = docsConfig
      ? JSON.parse(readFileSync(docsConfig, 'utf8')).documentary_paths : null;
    if (docsConfig && (!Array.isArray(documentPaths) || !documentPaths.length)) {
      throw new Error('--docs-config must contain a non-empty documentary_paths array');
    }
    const index = buildDocTokenIndex({ docs_root: docsRoot, document_paths: documentPaths });
    docJoin = joinDocOccurrences({ index, identity_candidates: plane.identity_candidates,
      mention_resolutions: resolution.mention_resolutions });
    for (const [docIndex, path] of docJoin.documents.entries()) {
      const docId = `doc:${path}`;
      if (docJoin.edges.some(edge => edge.doc_index === docIndex)) {
        nodes[docId] = { k: 'entity', l: path, ns: 'document', r: 'document' };
      }
    }
    for (const edge of docJoin.edges) {
      const docId = `doc:${docJoin.documents[edge.doc_index]}`;
      link(docId, 'documented_in', edge.referent_id);
      link(edge.referent_id, 'documented_in', docId);
      graphRelations.push({
        relation: 'documented_in',
        from: docId,
        to: edge.referent_id,
        surface: edge.surface,
        occurrence_count: edge.hits,
        match_basis: edge.match_basis ?? 'exact',
      });
    }
    console.log(`STAGE docs:done documents=${docJoin.report.documents} edges=${docJoin.report.doc_entity_edges} entities_documented=${docJoin.report.entities_with_occurrences}`);
  }
  // Preserve the exact, already-validated extractor stream for observations that
  // intentionally do not have identity candidates. The C4 adapter orders this by
  // output path and record selector, so the remap artifact can be projected
  // without a second extraction or a name-based reconstruction.
  const extractedFacts = plane.extracted_facts;
  const graph = {
    schema: 'estate-map/remap-code-graph/v1',
    provenance: {
      // A multi-repo estate declares one pin per repository; its digest is the estate's source
      // identity, and read-span resolves each fact's bytes against its own repository's commit.
      ...(sourcePinMap ? { source_pins: sourcePinMap } : {}),
      source_head: sha, code_plane_head: plane.code_plane_head,
      identity_materialization: MATERIALIZATION_ID,
      relation_report_digest: projected.report.report_digest,
      extracted_fact_stream_digest: plane.inventory.exact_fact_stream_digest,
      mapped_at: startedAt,
    },
    counts: {
      nodes: Object.keys(nodes).length,
      adjacency: Object.keys(adj).length,
      edges: walkable.length + (docJoin ? docJoin.report.doc_entity_edges : 0),
      doc_documents: docJoin ? docJoin.report.documents : 0,
      doc_entity_edges: docJoin ? docJoin.report.doc_entity_edges : 0,
      relation_records: projected.relations.length,
      relation_refusals: projected.refusals.length,
      referents: resolution.referents.length,
      candidates: plane.identity_candidates.length,
      extracted_facts: extractedFacts.length,
    },
    identity_bindings: identityBindings.sort((left, right) => left.fact_id.localeCompare(right.fact_id)),
    extracted_facts: extractedFacts,
    relations: graphRelations,
    nodes, adj,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'adjacency.json'), JSON.stringify(graph));
  const receiptBody = {
    schema: 'estate-map/remap-receipt/v1',
    scope: 'code plane only: entities + typed dependency relations; documentary claims not included in this slice',
    source_head: sha,
    code_plane_head: plane.code_plane_head,
    mapped_at: startedAt,
    counts: graph.counts,
    relation_report: projected.report,
    ...(docJoin ? { doc_occurrence_report: docJoin.report } : {}),
  };
  writeFileSync(join(out, 'remap-receipt.json'),
    canonical({ ...receiptBody, receipt_id: `remap-receipt:${sha256(canonical(receiptBody))}` }));
  console.log(`RESULT nodes=${graph.counts.nodes} edges=${graph.counts.edges} referents=${graph.counts.referents}`);
  return graph.counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { remapCodePlane(parse(process.argv.slice(2))); }
  catch (error) { console.error(`FAIL remap: ${error.stack || error.message}`); process.exitCode = 1; }
}
