// Loads subject views out of an offline unified-projection artifact (projection-nodes.jsonl,
// projection-edges.jsonl) for the two Phase 1 schemes. Not one of Pro's suggested module names
// (design v2 section 12 / Pro section 14.4); split out from generation-builder.mjs because
// streaming I/O and join logic is a distinct, independently testable concern from evaluation.
//
// Two streaming passes total, regardless of how many concepts run: one over the nodes file (kind
// index + eligible subjects + claim/receipt/obligation-result rows), one over the edges file
// (adjacency, filtered to only the relations and subject ids Phase 1 concepts actually reference).
// Neither file is ever loaded whole into memory -- both can run tens of GB.
//
// Two producer-classification facts are recomputed here rather than trusted from the file, because
// the retained Phase 1 baseline was projected BEFORE PR #23 landed node-kind classification: 23
// node kinds and the declares_value relation were `unclassified` in that run. Silently reading the
// file's own `plane`/`role` columns would silently inherit that gap; this module reads `kind` and
// `relation` (which are exact regardless of producer version) and reclassifies them against
// whichever estate-graph-roles.mjs registry is loaded right now, counting every place the two
// disagree instead of picking one silently.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { relationRole, nodePlane } from '../estate-graph-roles.mjs';
import { sha256, classifyProvenance } from '../lib.mjs';
import { canonical, fail } from './schemas.mjs';

// Observation-plane fact kinds a real run showed are never reached by a structural edge from any
// Module/Plugin/Referent -- attached only to the SourceCommit aggregate (operator finding, 2026-
// 09-25: "HTTP/URL/persistence facts only observed_in SourceCommit, no module owns them"). For
// these specific kinds, ownership is RESOLVED from the fact's own exact file rather than read off
// a projected edge -- see buildOwnershipAdjacency.
export const OWNABLE_FACT_KINDS = Object.freeze(['HttpClientCall', 'ConfiguredUrl', 'PersistenceTarget', 'SqliteTable']);

async function* readJsonLines(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    try { yield JSON.parse(line); }
    catch { fail('ONTOLOGY_PROJECTION_LINE_INVALID', `${path}:${lineNumber} is not valid JSON`); }
  }
}

function parseObligationKinds(proofPlanJson, claimId) {
  let plan;
  try { plan = JSON.parse(proofPlanJson ?? 'null'); }
  catch { fail('ONTOLOGY_CLAIM_FIELD_INVALID', `${claimId} proof_plan_json is not valid JSON`); }
  if (!plan || !Array.isArray(plan.obligations)) fail('ONTOLOGY_CLAIM_FIELD_INVALID', `${claimId} proof_plan_json has no obligations array`);
  return [...new Set(plan.obligations.map(row => row.kind).filter(Boolean))].sort();
}

function parseTiers(tiersJson, receiptId) {
  let tiers;
  try { tiers = JSON.parse(tiersJson ?? 'null'); }
  catch { fail('ONTOLOGY_CLAIM_FIELD_INVALID', `${receiptId} supporting_evidence_tiers_json is not valid JSON`); }
  if (!Array.isArray(tiers)) fail('ONTOLOGY_CLAIM_FIELD_INVALID', `${receiptId} supporting_evidence_tiers_json is not an array`);
  return tiers;
}

/** One streaming pass over projection-nodes.jsonl: the node-kind index, eligible entity subjects,
 * and the raw Claim / AdjudicationReceipt / ObligationResult rows epistemic standing joins. */
export async function loadNodePools(nodesPath, { eligibleEntityKinds }) {
  const entityKinds = new Set(eligibleEntityKinds);
  const kindByNodeId = new Map();
  const entitySubjects = [];
  const claimNodes = [];
  const receiptsByClaim = new Map();
  const obligationResultsByClaim = new Map();
  const duplicateReceiptClaims = new Set();
  const planeDrift = new Map();
  const ownableFactsByPath = new Map();
  let nodeCount = 0;
  for await (const node of readJsonLines(nodesPath)) {
    if (!node?.node_id || !node.kind) fail('ONTOLOGY_PROJECTION_NODE_INVALID', 'a projected node is missing node_id/kind');
    nodeCount += 1;
    kindByNodeId.set(node.node_id, node.kind);
    const recomputedPlane = nodePlane(node.kind);
    if (node.plane !== recomputedPlane) {
      const key = `${node.kind}: file said ${node.plane}, current registry says ${recomputedPlane}`;
      planeDrift.set(key, (planeDrift.get(key) ?? 0) + 1);
    }
    if (entityKinds.has(node.kind)) {
      // `namespace` is the entity's own exact component-relative-path identity
      // (identity-candidate-generator.mjs: "Identity is the exact component-relative path within
      // its repository") -- kept here only to resolve ownership of otherwise-unowned observation
      // facts (buildOwnershipAdjacency); never used as a membership-rule field.
      entitySubjects.push({ node_id: node.node_id, kind: node.kind, record_digest: node.record_digest,
        namespace: node.properties?.namespace ?? null });
    } else if (OWNABLE_FACT_KINDS.includes(node.kind)) {
      const props = node.properties ?? {};
      if (!props.repository || !props.file) fail('ONTOLOGY_PROJECTION_NODE_INVALID', `${node.node_id} (${node.kind}) has no repository/file`);
      const path = `${props.repository}/${props.file}`;
      const list = ownableFactsByPath.get(path) ?? [];
      list.push({ kind: node.kind, node_id: node.node_id, record_digest: node.record_digest,
        repository: props.repository, file: props.file, line: props.line });
      ownableFactsByPath.set(path, list);
    } else if (node.kind === 'Claim') {
      claimNodes.push({ node_id: node.node_id, record_digest: node.record_digest, properties: node.properties ?? {} });
    } else if (node.kind === 'AdjudicationReceipt') {
      const claimId = node.properties?.claim_id;
      if (!claimId) fail('ONTOLOGY_PROJECTION_NODE_INVALID', `${node.node_id} AdjudicationReceipt has no claim_id`);
      if (receiptsByClaim.has(claimId)) duplicateReceiptClaims.add(claimId);
      receiptsByClaim.set(claimId, { node_id: node.node_id, record_digest: node.record_digest, properties: node.properties });
    } else if (node.kind === 'ObligationResult') {
      const claimId = node.properties?.claim_id;
      if (!claimId) fail('ONTOLOGY_PROJECTION_NODE_INVALID', `${node.node_id} ObligationResult has no claim_id`);
      const list = obligationResultsByClaim.get(claimId) ?? [];
      list.push({ obligation_kind: node.properties.obligation_kind, state: node.properties.state });
      obligationResultsByClaim.set(claimId, list);
    }
  }
  return { nodeCount, kindByNodeId, entitySubjects, claimNodes, receiptsByClaim, obligationResultsByClaim,
    duplicateReceiptClaims, planeDrift: Object.fromEntries(planeDrift), ownableFactsByPath };
}

/** One streaming pass over projection-edges.jsonl: OUT/IN adjacency, but only for `relations` and
 * only where an endpoint is in `subjectIds` -- almost all edges in a real projection are neither. */
export async function loadEdgeAdjacency(edgesPath, { subjectIds, relations, directions }) {
  const out = new Map();
  const inn = new Map();
  const roleDrift = new Map();
  const wantOut = directions.has('out');
  const wantIn = directions.has('in');
  let edgeCount = 0;
  for await (const rawEdge of readJsonLines(edgesPath)) {
    if (!rawEdge?.edge_id || !rawEdge.relation || !rawEdge.from || !rawEdge.to) {
      fail('ONTOLOGY_PROJECTION_EDGE_INVALID', 'a projected edge is missing edge_id/relation/from/to');
    }
    edgeCount += 1;
    const recomputedRole = relationRole(rawEdge.relation);
    if (rawEdge.role !== recomputedRole) {
      const key = `${rawEdge.relation}: file said ${rawEdge.role}, current registry says ${recomputedRole}`;
      roleDrift.set(key, (roleDrift.get(key) ?? 0) + 1);
    }
    if (!relations.has(rawEdge.relation)) continue;
    const props = rawEdge.properties ?? {};
    // Provenance is classified HERE, at load time, so it is never lost: a witness surviving into a
    // sealed membership always already knows whether it points at production, test, fixture, or
    // docs code (operator finding: mechanical role members were dominated by test-only witnesses,
    // silently indistinguishable from production ones -- "distinguish, do not delete evidence").
    const entry = { relation: rawEdge.relation, edge_id: rawEdge.edge_id, record_digest: rawEdge.record_digest,
      from_fact_id: props.from_fact_id ?? null, to_fact_id: props.to_fact_id ?? null,
      source_witnesses: (props.witnesses ?? []).map(witness => ({ ...witness,
        provenance_class: classifyProvenance(witness.repo, witness.file) })) };
    if (wantOut && subjectIds.has(rawEdge.from)) {
      const bucket = out.get(rawEdge.from) ?? new Map();
      const list = bucket.get(rawEdge.relation) ?? [];
      list.push({ ...entry, to: rawEdge.to, to_kind: null });
      bucket.set(rawEdge.relation, list);
      out.set(rawEdge.from, bucket);
    }
    if (wantIn && subjectIds.has(rawEdge.to)) {
      const bucket = inn.get(rawEdge.to) ?? new Map();
      const list = bucket.get(rawEdge.relation) ?? [];
      list.push({ ...entry, to: rawEdge.from, to_kind: null });
      bucket.set(rawEdge.relation, list);
      inn.set(rawEdge.to, bucket);
    }
  }
  return { edgeCount, out, in: inn, roleDrift: Object.fromEntries(roleDrift) };
}

/** Fills each adjacency entry's `to_kind` from the node-kind index and counts how many resolve to
 * nothing -- an edge endpoint absent from the node file, a genuine dangling reference. */
export function fillTargetKinds(adjacency, kindByNodeId) {
  let dangling = 0;
  for (const bucket of adjacency.values()) {
    for (const list of bucket.values()) {
      for (const entry of list) {
        entry.to_kind = kindByNodeId.get(entry.to) ?? null;
        if (entry.to_kind === null) dangling += 1;
      }
    }
  }
  return dangling;
}

/** Merges a synthetic adjacency map (buildOwnershipAdjacency's output) into a real one built from
 * projected edges, in place. Relation buckets are additive, never overwritten, so a subject that
 * has both a real edge and a synthesized one under different relations keeps both. */
export function mergeAdjacency(target, source) {
  for (const [nodeId, sourceBucket] of source) {
    const targetBucket = target.get(nodeId) ?? new Map();
    for (const [relation, entries] of sourceBucket) {
      targetBucket.set(relation, [...(targetBucket.get(relation) ?? []), ...entries]);
    }
    target.set(nodeId, targetBucket);
  }
  return target;
}

/**
 * Resolves an OWNING entity for each `ownableFactsByPath` fact, ONLY where the fact's exact
 * `document_path` matches exactly one entity subject's own `namespace` -- never a guess, per the
 * operator's "exact and unambiguous, otherwise abstain" instruction. A path claimed by zero or by
 * more than one subject contributes no synthesized edge at all (the fact simply stays unowned; the
 * concept abstains on it exactly as it did before this resolution existed). Returns an adjacency
 * map shaped like loadEdgeAdjacency's `out`, meant to be merged into it with `mergeAdjacency`.
 */
export function buildOwnershipAdjacency({ entitySubjects, ownableFactsByPath }) {
  const owners = new Map();
  for (const subject of entitySubjects) {
    if (!subject.namespace) continue;
    const list = owners.get(subject.namespace) ?? [];
    list.push(subject.node_id);
    owners.set(subject.namespace, list);
  }
  const adjacency = new Map();
  let ownedFacts = 0;
  let ambiguousPaths = 0;
  let unownedPaths = 0;
  for (const [path, facts] of ownableFactsByPath) {
    const candidates = owners.get(path);
    if (!candidates || candidates.length === 0) { unownedPaths += 1; continue; }
    if (candidates.length > 1) { ambiguousPaths += 1; continue; }
    const [ownerId] = candidates;
    const bucket = adjacency.get(ownerId) ?? new Map();
    const list = bucket.get('owns_fact') ?? [];
    for (const fact of facts) {
      ownedFacts += 1;
      list.push({
        relation: 'owns_fact',
        edge_id: `owns-fact:${sha256(canonical({ owner: ownerId, fact: fact.node_id }))}`,
        // The fact's own record digest: there is no real edge to cite a digest FOR, so the exact
        // projected value being witnessed is the observation fact itself.
        record_digest: fact.record_digest,
        from_fact_id: null,
        to_fact_id: fact.node_id,
        to: fact.node_id,
        // Filled by fillTargetKinds from the same kindByNodeId index real edges use, so a fact
        // that somehow is not itself a projected node (should never happen) is caught as dangling
        // exactly like a real edge would be, rather than trusted here.
        to_kind: null,
        resolution: 'file_path_owner_match',
        source_witnesses: [{ repo: fact.repository, file: fact.file, line: fact.line,
          provenance_class: classifyProvenance(fact.repository, fact.file) }],
      });
    }
    bucket.set('owns_fact', list);
    adjacency.set(ownerId, bucket);
  }
  return { adjacency, ownedFacts, ambiguousPaths, unownedPaths };
}

export function buildEntitySubjects({ entitySubjects, outAdjacency, inAdjacency }) {
  return entitySubjects.map(node => ({
    node_id: node.node_id, kind: node.kind, record_digest: node.record_digest,
    view: { edges: { out: outAdjacency.get(node.node_id) ?? new Map(), in: inAdjacency.get(node.node_id) ?? new Map() }, fields: {} },
    witnessMeta: null,
  }));
}

/** Joins Claim, AdjudicationReceipt and ObligationResult rows by claim_id. A claim with no receipt,
 * or more than one, is refused for every epistemic-standing concept rather than silently skipped
 * or silently evaluated against a guessed receipt (`docs/before-a-pr.md`: "an absence that defaults
 * is the defect; an absence that is counted and named is a finding"). */
export function buildClaimSubjects({ claimNodes, receiptsByClaim, obligationResultsByClaim, duplicateReceiptClaims }) {
  const subjects = [];
  const refusals = [];
  for (const claim of claimNodes) {
    if (duplicateReceiptClaims.has(claim.node_id)) {
      refusals.push({ node_id: claim.node_id, code: 'CLAIM_RECEIPT_DUPLICATE',
        detail: `more than one AdjudicationReceipt node references claim_id ${claim.node_id}` });
      continue;
    }
    const receipt = receiptsByClaim.get(claim.node_id);
    if (!receipt) {
      refusals.push({ node_id: claim.node_id, code: 'CLAIM_RECEIPT_MISSING',
        detail: `no AdjudicationReceipt node references claim_id ${claim.node_id}` });
      continue;
    }
    const obligationResults = obligationResultsByClaim.get(claim.node_id) ?? [];
    const fields = {
      claim_kind: claim.properties.claim_kind,
      source_status: claim.properties.source_status,
      decision_status: claim.properties.decision_status,
      verdict: receipt.properties.verdict,
      realization: receipt.properties.realization,
      supporting_evidence_tiers: parseTiers(receipt.properties.supporting_evidence_tiers_json, receipt.node_id),
      proof_plan_obligation_kinds: parseObligationKinds(claim.properties.proof_plan_json, claim.node_id),
      open_question_underdetermined: obligationResults.some(row => row.obligation_kind === 'open_question' && row.state === 'underdetermined'),
      // Every claim gets exactly one `derived_from` documentary-source evidence row unconditionally
      // (claim-evidence-map.mjs's exactSourceEvidence has no branch that skips it) -- a pipeline
      // invariant asserted here, not a per-claim observation.
      has_documentary_evidence: true,
    };
    subjects.push({
      node_id: claim.node_id, kind: 'Claim', record_digest: claim.record_digest,
      view: { edges: { out: new Map(), in: new Map() }, fields },
      witnessMeta: { claim_id: claim.node_id, receipt_id: receipt.node_id,
        source_path: claim.properties.source_path, source_line: claim.properties.source_line },
    });
  }
  return { subjects, refusals };
}
