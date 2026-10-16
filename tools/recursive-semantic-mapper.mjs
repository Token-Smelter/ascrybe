#!/usr/bin/env node
// Fixed, budgeted recursive semantic-mapper pilot. Planning is routing hypothesis; extraction claims
// remain source-grounded and every paid unit uses durable single-dispatch custody.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openCheckpointJournal } from './checkpoint-journal.mjs';
import { createInferenceBudget, runCustodiedInference } from './custodied-inference.mjs';
import { createPiRpcRunner } from './neural-model-runner.mjs';
import { parseCensusModelJson } from './neural-json.mjs';
import {
  buildDocumentaryClaimV3,
  canonicalRegionOrder,
  createEvidenceRegion,
  createMapBundle,
  createPlanningHypothesis,
  DEFAULT_ATOMIC_PRIMARY_BYTES,
  DOCUMENTARY_CLAIM_V3_SCHEMA,
  inventoryIndex,
  inventoryMarkdown,
  MAP_BUNDLE_SCHEMA,
  MAX_REGION_CHILDREN,
  PLANNING_HYPOTHESIS_SCHEMA,
  reduceDuplicateClaims,
  renderRegionEvidence,
  rootEvidenceRegion,
} from './recursive-contracts.mjs';
import { readExtractionArtifact } from './extraction-artifact.mjs';
import { assembleDisagreementCases } from './documentation-claim-census.mjs';
import { buildPropositionIndex } from './proposition-index.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';

const execFileAsync = promisify(execFile);
export const RECURSIVE_PILOT_SCHEMA = 'estate-map/recursive-semantic-pilot/v1';
export const RECURSIVE_MAPPER_VERSION = 'recursive-semantic-mapper@3';
const text = value => String(value ?? '');
const canonical = value => stableStringify(value).trim();
const compactPreview = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);

export class RecursivePilotError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'RecursivePilotError';
    this.code = code;
    this.detail = detail;
  }
}

function parseResultJson(result) {
  return result?.json ?? parseCensusModelJson(result?.text || '');
}

function regionBlocks(region, inventories) {
  const index = inventoryIndex(inventories);
  return region.primary_block_addresses.map(address => index.byAddress.get(address)).sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
}

/** Addressing-only compression for planning prompts. Units expand exactly to constituent blocks. */
export function buildRoutingUnits({ region, inventories, target_bytes = 8 * 1024 }) {
  const blocks = regionBlocks(region, inventories);
  const groups = [];
  let current = [];
  const flush = () => { if (current.length) groups.push(current); current = []; };
  for (const block of blocks) {
    const bytes = current.reduce((sum, item) => sum + item.bytes, 0);
    if (current.length && (block.file !== current[0].file || bytes + block.bytes > target_bytes)) flush();
    current.push(block);
  }
  flush();
  return groups.map((group, ordinal) => {
    const addresses = group.map(block => block.address);
    const headings = group.filter(block => block.type === 'heading').map(block => compactPreview(block.text));
    const prose = group.filter(block => block.type !== 'separator' && block.type !== 'heading').map(block => compactPreview(block.text)).filter(Boolean);
    const body = { file: group[0].file, addresses };
    return Object.freeze({
      // The opaque content digest remains the internal identity; the model is shown ONLY the short
      // ordinal token. A 64-hex string the model must echo back is a transcription hazard, and one
      // dropped character pair is what stopped the v2 pilot.
      id: `unit:${sha256(canonical(body))}`,
      token: `u${String(ordinal + 1).padStart(2, '0')}`,
      file: group[0].file,
      from_index: group[0].index,
      to_index: group[group.length - 1].index,
      lines: [group[0].start, group[group.length - 1].end],
      bytes: group.reduce((sum, block) => sum + block.bytes, 0),
      block_addresses: addresses,
      headings,
      summary: [...headings, ...prose].join(' · ').slice(0, 900),
    });
  });
}

export function buildPlanningPrompt({ region, inventories, bounds }) {
  const units = buildRoutingUnits({ region, inventories, target_bytes: bounds.routing_unit_bytes || 8 * 1024 });
  const includeExactSource = region.primary_bytes <= bounds.atomic_primary_bytes;
  const menu = units.map(unit => JSON.stringify({
    unit: unit.token,
    file: unit.file,
    index_range: [unit.from_index, unit.to_index],
    lines: unit.lines,
    bytes: unit.bytes,
    headings: unit.headings,
    summary: unit.summary,
  })).join('\n');
  const exact = includeExactSource ? `\nEXACT REGION EVIDENCE:\n${renderRegionEvidence(region, inventories)}\n` : '';
  return [
    'You are the routing planner for a source-grounded recursive semantic mapper.',
    'Your output is a PROVISIONAL PLANNING HYPOTHESIS. It is never evidence and cannot support claims.',
    `Region: ${region.id}; depth=${region.depth}; primary_bytes=${region.primary_bytes}; atomic_limit=${bounds.atomic_primary_bytes}.`,
    `Rules: max ${bounds.max_children_per_region} children; max depth ${bounds.max_depth}.`,
    'Choose outcome atomic, split, or unresolved.',
    'Atomic is allowed only when primary_bytes <= atomic_limit and the region has one coherent interpretive frame.',
    'For split, partition EVERY primary block exactly once. Prefer 2-6 semantic children, not one child per heading.',
    'Children should partition the primary units from the routing menu exactly once.',
    'Refer to units ONLY by their short token (for example "u03"). Never invent or alter a token.',
    'A child may group nonadjacent units. Units are addressing-only and expand losslessly to blocks.',
    'context_units may cite other units in this region needed to interpret a child.',
    'Do not infer truth. Do not create claims. Do not use headings as semantic identity.',
    'Return ONLY one JSON object matching:',
    '{"outcome":"atomic|split|unresolved","reason":"...","concept_candidates":[{"term":"...","anchor_units":["u01"]}],"dependency_suggestions":[],"unresolved_questions":[],"children":[{"label":"...","primary_units":["u01","u02"],"context_units":[]}]}',
    '',
    'PRIMARY ROUTING-UNIT MENU (one JSON object per line):',
    menu,
    exact,
  ].join('\n');
}

function expandChildSpecs(proposed, region, inventories, bounds) {
  if (!proposed) return proposed;
  const index = inventoryIndex(inventories);
  const units = buildRoutingUnits({ region, inventories, target_bytes: bounds.routing_unit_bytes || 8 * 1024 });
  const unitByRef = new Map();
  for (const unit of units) { unitByRef.set(unit.token, unit); unitByRef.set(unit.id, unit); }
  const parentPrimary = new Set(region.primary_block_addresses);
  const refs = (spec, ...fields) => fields.flatMap(field => spec?.[field] || []).map(value => text(value).trim()).filter(Boolean);

  // ADVISORY: concept anchors resolve best-effort for EVERY outcome (atomic plans previously
  // dropped their anchors silently because this function returned early). Unknown refs are
  // recorded, never fatal.
  const unresolvedAnchorReferences = [];
  const conceptCandidates = (proposed.concept_candidates || []).map(candidate => {
    const anchors = new Set(candidate.anchor_block_addresses || []);
    for (const ref of refs(candidate, 'anchor_units', 'anchor_unit_ids', 'anchor_unit_tokens')) {
      const unit = unitByRef.get(ref);
      if (!unit) { unresolvedAnchorReferences.push(ref); continue; }
      for (const address of unit.block_addresses) anchors.add(address);
    }
    return { ...candidate, anchor_block_addresses: [...anchors].sort() };
  });
  const advisory = { concept_candidates: conceptCandidates, unresolved_anchor_references: [...new Set(unresolvedAnchorReferences)].sort() };
  if (proposed.outcome !== 'split') return { ...proposed, ...advisory };

  // LOAD-BEARING: a partition reference decides extraction scope and coverage conservation, so an
  // unknown ref is fatal and must never be repaired by similarity or re-asked from the model.
  const children = (proposed.children || []).map(child => {
    const addresses = new Set(child.primary_block_addresses || []);
    const contextAddresses = new Set(child.context_block_addresses || []);
    for (const ref of refs(child, 'primary_units', 'primary_unit_ids', 'primary_unit_tokens')) {
      const unit = unitByRef.get(ref);
      if (!unit) throw new RecursivePilotError('UNKNOWN_ROUTING_UNIT', `unknown primary routing unit ${ref}`, { ref, known_tokens: units.map(item => item.token) });
      for (const address of unit.block_addresses) addresses.add(address);
    }
    for (const ref of refs(child, 'context_units', 'context_unit_ids', 'context_unit_tokens')) {
      const unit = unitByRef.get(ref);
      if (!unit) throw new RecursivePilotError('UNKNOWN_ROUTING_UNIT', `unknown context routing unit ${ref}`, { ref, known_tokens: units.map(item => item.token) });
      for (const address of unit.block_addresses) contextAddresses.add(address);
    }
    for (const range of child.primary_ranges || []) {
      const inventory = index.byPath.get(text(range.file));
      const from = Number(range.from_index), to = Number(range.to_index);
      if (!inventory || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= inventory.blocks.length) {
        throw new RecursivePilotError('INVALID_PLAN_RANGE', 'planner emitted invalid block range', { range });
      }
      for (let i = from; i <= to; i += 1) addresses.add(inventory.blocks[i].address);
    }
    const primary = [...addresses].sort();
    const foreign = primary.filter(address => !parentPrimary.has(address));
    if (foreign.length) throw new RecursivePilotError('PLAN_RANGE_OUTSIDE_PARENT', 'planner range crosses outside parent region', { foreign });
    return { ...child, primary_block_addresses: primary, context_block_addresses: [...contextAddresses].sort() };
  });
  return { ...proposed, ...advisory, children };
}

function planningKey({ region, prompt, runner, bounds }) {
  return sha256(canonical({
    policy: INFERENCE_CUSTODY_POLICY,
    mapper: RECURSIVE_MAPPER_VERSION,
    stage: 'planning',
    region_id: region.id,
    prompt_digest: sha256(prompt),
    model: runner.model,
    bounds: { atomic_primary_bytes: bounds.atomic_primary_bytes, max_children_per_region: bounds.max_children_per_region, max_depth: bounds.max_depth },
    schema: PLANNING_HYPOTHESIS_SCHEMA,
  }));
}

export async function planRegionTree({ root, inventories, runner, checkpoint, budget, bounds, inspectOnly = false }) {
  const hypotheses = [], conservations = [], regions = [], unresolved = [], incomplete = [];
  let planningCalls = 0;
  // CLASS RULE: every deterministic bound terminates the region as an explicit `unresolved` and
  // lets the run finish. Only the GLOBAL spend budget (max_calls / max_known_cost_usd) aborts.
  // Fixing these one at a time (depth, then call cap, then region cap) was the wrong shape; a
  // bound is a scope decision, and a scope decision must never destroy already-purchased work.
  const terminateBounded = (region, bound, detail) => {
    const body = {
      schema: PLANNING_HYPOTHESIS_SCHEMA, region_id: region.id, outcome: 'unresolved',
      reason: `deterministic bound: ${bound}`,
      concept_candidates: [], dependency_suggestions: [], unresolved_questions: [], unresolved_anchor_references: [],
      model_identifier: null, prompt_digest: null, status: 'provisional', proposed_children: [],
      bound_clamp: { from: 'planned', to: 'unresolved', bound, ...detail },
      decided_without_model_call: true,
    };
    hypotheses.push(Object.freeze({ ...body, digest: sha256(canonical(body)) }));
    unresolved.push(region);
    return [];
  };
  const visit = async region => {
    regions.push(region);
    if (regions.length > bounds.max_regions_per_document) return terminateBounded(region, 'region_cap', { max_regions_per_document: bounds.max_regions_per_document, regions_visited: regions.length });
    // PER-DOCUMENT CAP CLAMPS, IT DOES NOT ABORT. The hard spend stop is the global budget
    // (max_calls / max_known_cost_usd), which aborts. This per-document cap only shapes how much
    // of one document we are willing to plan, so exceeding it must leave the remaining regions
    // explicitly unresolved and let the run finish — a partial map with recorded gaps is worth more
    // than a dead run, and the gaps are exactly what the human review is designed to measure.
    if (planningCalls >= bounds.max_planning_calls_per_document) return terminateBounded(region, 'planning_call_cap', { max_planning_calls_per_document: bounds.max_planning_calls_per_document });
    // FREE TERMINATION. A region at max depth that still exceeds the atomic bound has exactly one
    // lawful outcome (unresolved), so spending a paid planning call on it buys nothing. Decide it
    // deterministically and record it as an explicit unresolved region.
    if (region.depth >= bounds.max_depth && region.primary_bytes > bounds.atomic_primary_bytes) {
      return terminateBounded(region, 'max_depth_oversized', { max_depth: bounds.max_depth, primary_bytes: region.primary_bytes, atomic_primary_bytes: bounds.atomic_primary_bytes });
    }
    // Indivisible AND oversized: a single source block larger than the atomic bound cannot be
    // split or extracted, so its only lawful outcome is unresolved. Decide it for free.
    if (region.primary_block_addresses.length === 1 && region.primary_bytes > bounds.atomic_primary_bytes) {
      return terminateBounded(region, 'indivisible_oversized_block', { primary_bytes: region.primary_bytes, atomic_primary_bytes: bounds.atomic_primary_bytes });
    }
    const prompt = buildPlanningPrompt({ region, inventories, bounds });
    const key = planningKey({ region, prompt, runner, bounds });
    planningCalls += 1;
    const completion = await runCustodiedInference({
      checkpoint,
      stage: 'recursive-planning',
      key,
      tag: `plan:${region.id}`,
      prompt,
      runner,
      budget,
      inspectOnly,
      validate: result => {
        const parsed = parseResultJson(result);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'planner did not return one JSON object' };
        try {
          const expanded = expandChildSpecs(parsed, region, inventories, bounds);
          const built = createPlanningHypothesis({
            region,
            proposed: expanded,
            model_identifier: runner.model,
            prompt_digest: sha256(prompt),
            inventories,
            atomic_primary_bytes: bounds.atomic_primary_bytes,
            max_children: bounds.max_children_per_region,
            max_depth: bounds.max_depth,
          });
          return { ok: true, value: built };
        } catch (error) {
          return { ok: false, reason: error.message, error_code: error.code || null, detail: error.detail || null };
        }
      },
    });
    if (completion.incomplete) {
      // Recorded failure from a prior run: skip without re-dispatching and keep the region explicit.
      incomplete.push(completion.incomplete);
      return terminateBounded(region, 'recorded_incomplete_unit', { reason: completion.incomplete.reason, outcome: completion.incomplete.outcome });
    }
    const built = completion.validated;
    hypotheses.push(built.hypothesis);
    if (built.conservation) conservations.push(built.conservation);
    if (built.hypothesis.outcome === 'atomic') return [region];
    if (built.hypothesis.outcome === 'unresolved') { unresolved.push(region); return []; }
    const leaves = [];
    for (const child of canonicalRegionOrder(built.children)) leaves.push(...await visit(child));
    return leaves;
  };
  const leaves = await visit(root);
  return Object.freeze({ root, regions: canonicalRegionOrder(regions), leaves: canonicalRegionOrder(leaves), hypotheses: hypotheses.slice().sort((a, b) => a.region_id.localeCompare(b.region_id)), conservations, unresolved, incomplete, planning_calls: planningCalls });
}

// Planning prose can anchor an extractor to an unsupported hypothesis. Keep it as
// routing metadata, never source evidence; this function accepts no hypothesis parameter.
export function buildExtractionPrompt({ region, inventories, arm, max_claims = 64 }) {
  const planBlock = 'NO PLANNING HYPOTHESIS IS PROVIDED. Interpret only exact source evidence.';
  return [
    'You extract documentary claims from exact source evidence.',
    // No arm label: it told the model nothing, and it changed prompt_digest, which would have made
    // two arms buy the same inference twice instead of sharing one purchase.
    `Region: ${region.id}.`,
    'Authority: source excerpts > interpreted claim > model prose. Planning is never evidence.',
    `Return ONLY one JSON object {"claims":[...]}; at most ${max_claims} claims.`,
    'Each claim must contain:',
    '{"subject_ref":"component|protocol|schema|state|command|record|concept|entity:<canonical-id>"|null,"subject_kind":"...","unresolved_subject":"..."|null,"referent_status":"resolved|unresolved","predicate_family":"...","object_or_value":"...","polarity":"affirmed|negated","modality":"descriptive|normative|historical|constitutive|predictive","quantifier":"...","scope":{},"valid_time":{},"source_spans":[{"role":"primary|context","file":"...","start":1,"end":1}]}',
    'Every claim must cite at least one PRIMARY span. CONTEXT may supplement but never solely ground a claim.',
    'Coordinates must be exact supplied file/line coordinates. Do not quote or paraphrase source in source_spans.',
    'Use referent_status=unresolved and subject_ref=null unless source explicitly establishes a stable canonical referent.',
    'Do not merge referents by lexical similarity. Preserve scope, time, modality, and negation.',
    planBlock,
    '',
    'EXACT REGION EVIDENCE:',
    renderRegionEvidence(region, inventories),
  ].join('\n');
}

// The key deliberately excludes both `arm` and any hypothesis digest: with injection deleted, two
// arms over the same region produce a byte-identical prompt, so they must share one purchase rather
// than buying the same inference twice.
function extractionKey({ region, prompt, runner, max_claims }) {
  return sha256(canonical({
    policy: INFERENCE_CUSTODY_POLICY,
    mapper: RECURSIVE_MAPPER_VERSION,
    stage: 'extraction',
    region_id: region.id,
    prompt_digest: sha256(prompt),
    model: runner.model,
    schema: DOCUMENTARY_CLAIM_V3_SCHEMA,
    max_claims,
  }));
}

export async function extractRegion({ arm, region, inventories, hypothesis, runner, checkpoint, budget, max_claims = 64, inspectOnly = false }) {
  const prompt = buildExtractionPrompt({ region, inventories, arm, max_claims });
  const key = extractionKey({ region, prompt, runner, max_claims });
  const completion = await runCustodiedInference({
    checkpoint,
    stage: `recursive-extraction-${arm}`,
    key,
    tag: `extract:${arm}:${region.id}`,
    prompt,
    runner,
    budget,
    inspectOnly,
    validate: result => {
      const parsed = parseResultJson(result);
      const proposals = Array.isArray(parsed?.claims) ? parsed.claims : null;
      if (!proposals) return { ok: false, reason: 'extractor did not return {claims:[]}' };
      // The claim cap is a PROSPECTIVE bound (stated in the prompt; memory is really protected by
      // the 1 MiB answer ceiling). Enforcing it retroactively discarded 65 valid claims from an
      // already-priced call because the model returned one more than asked. Record the overshoot
      // and keep the work.
      const cap_exceeded = proposals.length > max_claims ? { returned: proposals.length, max_claims } : null;
      // PER-CLAIM validation. One malformed claim must not discard an entire priced extraction:
      // rejecting 58 good claims because the 59th lacks a field destroys purchased work and stops
      // the run. Invalid claims are recorded with their reason (as the heading extractor already
      // did); the unit fails only if the payload shape is wrong or NOTHING survives.
      const claims = [], rejected = [];
      proposals.forEach((proposed, index) => {
        try {
          claims.push(buildDocumentaryClaimV3({
            proposed,
            region,
            inventories,
            model_identifier: runner.model,
            prompt_digest: sha256(prompt),
            planning_hypothesis_digest: hypothesis?.digest ?? null,
          }));
        } catch (error) {
          rejected.push({ index, reason: error.code || 'INVALID_CLAIM', detail: error.message });
        }
      });
      // Claim CONTENT never fails the unit: a purchased extraction is kept with its valid claims
      // and an explicit record of rejected ones. Only payload SHAPE (checked above) can fail it.
      return { ok: true, value: { claims, rejected, cap_exceeded } };
    },
  });
  if (completion.incomplete) return Object.freeze({ region, arm, hypothesis_digest: hypothesis?.digest ?? null, claims: [], rejected_claims: [], incomplete: completion.incomplete });
  return Object.freeze({ region, arm, hypothesis_digest: hypothesis?.digest ?? null, claims: completion.validated.claims, rejected_claims: completion.validated.rejected, cap_exceeded: completion.validated.cap_exceeded, incomplete: null });
}

function addressesForSpan(inventory, span) {
  return inventory.blocks.filter(block => block.start <= span.end && block.end >= span.start).map(block => block.address);
}

function nearestHeadingContext(inventory, span, selected) {
  const candidates = inventory.blocks.filter(block => block.type === 'heading' && block.start < span.start && !selected.includes(block.address));
  return candidates.length ? [candidates[candidates.length - 1].address] : [];
}

export function jointRegionFromManifest({ manifest, inventories, snapshot }) {
  const index = inventoryIndex(inventories);
  const primary = [], context = [];
  for (const span of manifest.cross_document_pair.spans) {
    const inventory = index.byPath.get(span.file);
    if (!inventory) throw new RecursivePilotError('UNKNOWN_JOINT_FILE', span.file);
    const addresses = addressesForSpan(inventory, span);
    primary.push(...addresses);
    context.push(...nearestHeadingContext(inventory, span, addresses));
  }
  return createEvidenceRegion({ inventories, primary_block_addresses: primary, context_block_addresses: context, depth: 0, snapshot });
}

function hypothesisByRegion(plan) { return new Map(plan.hypotheses.map(hypothesis => [hypothesis.region_id, hypothesis])); }

async function extractPlanArm({ arm, plans, inventories, runner, checkpoint, budget, injectPlan, bounds, inspectOnly = false }) {
  const extractions = [];
  for (const plan of plans) {
    const byRegion = hypothesisByRegion(plan);
    for (const region of plan.leaves) {
      extractions.push(await extractRegion({
        arm,
        region,
        inventories,
        // Recorded as provenance only; it cannot reach the prompt.
        hypothesis: byRegion.get(region.id) || null,
        runner,
        checkpoint,
        budget,
        max_claims: bounds.max_claims_per_unit,
        inspectOnly,
      }));
    }
  }
  const claims = reduceDuplicateClaims(extractions.flatMap(item => item.claims));
  const incomplete = extractions.filter(item => item.incomplete).map(item => ({ region_id: item.region.id, ...item.incomplete }));
  const rejected_claims = extractions.flatMap(item => (item.rejected_claims || []).map(r => ({ region_id: item.region.id, ...r })));
  const cap_overshoots = extractions.filter(item => item.cap_exceeded).map(item => ({ region_id: item.region.id, ...item.cap_exceeded }));
  const bundles = plans.map(plan => {
    const leafBundles = plan.leaves.map(region => {
      const extraction = extractions.find(item => item.region.id === region.id);
      return createMapBundle({ region, planning_hypotheses: injectPlan ? [hypothesisByRegion(plan).get(region.id)].filter(Boolean) : [], claims: extraction?.claims || [] });
    });
    return createMapBundle({ region: plan.root, planning_hypotheses: injectPlan ? plan.hypotheses : [], child_bundles: leafBundles, unresolved_questions: plan.unresolved.map(region => `unresolved region ${region.id}`) });
  });
  return Object.freeze({ arm, claims, extractions, bundles, incomplete, rejected_claims, cap_overshoots });
}

function claimFiles(claim) {
  const semantic = claim?.semantic || claim || {};
  const excerpts = semantic.provenance?.source_excerpts || [];
  return new Set(excerpts.map(excerpt => excerpt.file).filter(Boolean));
}

async function loadControlClaims(controlPath, documentPaths) {
  const { artifact } = await readExtractionArtifact(controlPath);
  const wanted = new Set(documentPaths);
  const claims = artifact.extraction.claims.filter(claim => [...claimFiles(claim)].some(file => wanted.has(file)));
  return { artifact_digest: artifact.artifact_digest, snapshot: artifact.snapshot, claims, completion: artifact.completion, skipped: artifact.extraction.skipped || [] };
}

function armMetrics(claims, snapshot) {
  const multiSpan = claims.filter(claim => ((claim.semantic || claim).source_spans || (claim.semantic || claim).provenance?.source_excerpts || []).length > 1).length;
  const unresolved = claims.filter(claim => (claim.semantic || claim).referent_status === 'unresolved' || (claim.semantic || claim).subject_refs?.[0]?.referent_status === 'unresolved').length;
  let index = null, disagreement = null, error = null;
  try {
    index = buildPropositionIndex(claims, { snapshot });
    disagreement = assembleDisagreementCases(claims, index, { snapshot });
  } catch (caught) { error = caught.message; }
  return {
    claims: claims.length,
    multi_span_claims: multiSpan,
    unresolved_referents: unresolved,
    buckets: index?.bucketCount ?? null,
    candidate_pairs: index?.candidatePairCount ?? null,
    disagreement_cases: disagreement?.cases_total ?? null,
    comparison_error: error,
  };
}

function claimSourceSpans(claim) {
  const semantic = claim?.semantic || claim || {};
  if (Array.isArray(semantic.source_spans)) return semantic.source_spans;
  return (semantic.provenance?.source_excerpts || []).map(excerpt => ({ role: excerpt.role || 'primary', file: excerpt.file, start: excerpt.start, end: excerpt.end }));
}

const hashedOrder = (seed, id) => sha256(`${seed}\0${id}`);
function sampleBlocks(inventory, count, seed) {
  const groups = new Map();
  for (const block of inventory.blocks) {
    const group = groups.get(block.type) || [];
    group.push(block);
    groups.set(block.type, group);
  }
  for (const group of groups.values()) group.sort((a, b) => hashedOrder(seed, a.id).localeCompare(hashedOrder(seed, b.id)));
  const selected = [], types = [...groups.keys()].sort();
  while (selected.length < count) {
    let progressed = false;
    for (const type of types) {
      const next = groups.get(type).shift();
      if (!next) continue;
      selected.push(next); progressed = true;
      if (selected.length >= count) break;
    }
    if (!progressed) break;
  }
  return selected.sort((a, b) => a.start - b.start);
}

function sampleClaims(claims, count, seed) {
  const id = claim => claim.id ?? claim.review_claim_id;
  return claims.slice().sort((a, b) => hashedOrder(seed, id(a)).localeCompare(hashedOrder(seed, id(b)))).slice(0, count);
}

export function buildBlindedReview({ inventories, arms, seed }) {
  const armNames = Object.keys(arms).sort();
  const blindLabels = ['X', 'Y', 'Z'];
  const shuffled = armNames.slice().sort((a, b) => hashedOrder(seed, a).localeCompare(hashedOrder(seed, b)));
  const key = Object.fromEntries(shuffled.map((arm, index) => [blindLabels[index], arm]));
  const armToBlind = Object.fromEntries(Object.entries(key).map(([blind, arm]) => [arm, blind]));
  const claimIdMapping = {};
  const normalized = Object.fromEntries(armNames.map(arm => {
    const blind = armToBlind[arm];
    const claims = arms[arm].claims.map(claim => {
      const semantic = claim?.semantic || claim || {};
      const review_claim_id = `review-claim:${sha256(`${seed}\0${blind}\0${claim.id}`)}`;
      claimIdMapping[review_claim_id] = { arm, claim_id: claim.id };
      return {
        review_claim_id,
        subject_refs: semantic.subject_refs || [],
        predicate_family: semantic.predicate_family ?? null,
        object_or_value: semantic.object_or_value ?? null,
        polarity: semantic.polarity ?? null,
        modality: semantic.modality ?? null,
        quantifier: semantic.quantifier ?? null,
        scope: semantic.scope || {},
        valid_time: semantic.valid_time || {},
        referent_status: semantic.referent_status ?? semantic.subject_refs?.[0]?.referent_status ?? null,
        source_spans: claimSourceSpans(claim),
        source_excerpts: (semantic.provenance?.source_excerpts || []).map(excerpt => ({ role: excerpt.role || 'primary', file: excerpt.file, start: excerpt.start, end: excerpt.end, text: excerpt.text })),
      };
    }).sort((a, b) => a.review_claim_id.localeCompare(b.review_claim_id));
    return [blind, claims];
  }));
  const coverage = [];
  for (const inventory of inventories) {
    for (const block of sampleBlocks(inventory, 30, `${seed}:blocks:${inventory.path}`)) {
      const represented = {};
      for (const blind of blindLabels) represented[blind] = (normalized[blind] || []).filter(claim => claim.source_spans.some(span => span.file === block.file && span.start <= block.end && span.end >= block.start)).map(claim => claim.review_claim_id);
      coverage.push({ file: block.file, block_id: block.id, type: block.type, lines: [block.start, block.end], source_text: block.text, represented_claim_ids: represented, human_grade: null });
    }
  }
  const precision = [];
  for (const blind of blindLabels) {
    for (const claim of sampleClaims(normalized[blind] || [], 100, `${seed}:claims:${blind}`)) {
      precision.push({ blind_arm: blind, claim, human_grade: { entailment: null, referent: null, scope: null, time: null, modality: null, every_span_needed: null } });
    }
  }
  precision.sort((a, b) => a.blind_arm.localeCompare(b.blind_arm) || a.claim.review_claim_id.localeCompare(b.claim.review_claim_id));
  return {
    packet: {
      schema: 'estate-map/recursive-pilot-human-review/v1',
      blinded: true,
      claim_catalog: normalized,
      coverage_frame: coverage,
      precision_frame: precision,
      second_human_overlap_required: 0.20,
      status: 'awaiting_human_review',
    },
    key: { schema: 'estate-map/recursive-pilot-blind-key/v1', mapping: key, claim_id_mapping: claimIdMapping, seed_digest: sha256(seed) },
  };
}

async function atomicWrite(file, value) {
  const absolute = path.resolve(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, absolute);
  return absolute;
}

export async function runRecursivePilot({ root, manifest, checkpointPath, outputPath, reviewPath, blindKeyPath, controlArtifactPath = null, planningRunner = null, extractionRunner = null, inspectOnly = false }) {
  const paid = !planningRunner || !extractionRunner;
  if (paid && process.env.ASCRYBE_ENABLE_PAID_INFERENCE !== '1') throw new RecursivePilotError('PAID_GATE_CLOSED', 'set ASCRYBE_ENABLE_PAID_INFERENCE=1 only after free gates pass');
  if (!checkpointPath || !outputPath || !reviewPath || !blindKeyPath) throw new RecursivePilotError('MISSING_OUTPUT_PATH', 'checkpoint, output, review, and blind-key paths are required');
  const estateRoot = await fs.realpath(root);
  const sourceSha = (await execFileAsync('git', ['-C', estateRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sourceSha !== manifest.source_sha) throw new RecursivePilotError('SOURCE_SHA_MISMATCH', `manifest ${manifest.source_sha}, estate ${sourceSha}`);
  const documents = [];
  for (const spec of manifest.documents) {
    const content = await fs.readFile(path.join(estateRoot, spec.path), 'utf8');
    documents.push({ spec, content });
  }
  const pilotCorpusDigest = sha256(canonical(documents.map(item => ({ path: item.spec.path, digest: sha256(item.content) }))));
  const snapshot = { source_sha: sourceSha, corpus_digest: pilotCorpusDigest };
  const inventories = documents.map(item => inventoryMarkdown({ path: item.spec.path, content: item.content, ...snapshot }));
  const roots = inventories.map(inventory => rootEvidenceRegion(inventory, snapshot));
  const jointRoot = jointRegionFromManifest({ manifest, inventories, snapshot });
  const bounds = {
    atomic_primary_bytes: Number(manifest.bounds.atomic_primary_bytes || DEFAULT_ATOMIC_PRIMARY_BYTES),
    max_children_per_region: Number(manifest.bounds.max_children_per_region || MAX_REGION_CHILDREN),
    max_depth: Number(manifest.bounds.max_depth || 2),
    max_regions_per_document: Number(manifest.bounds.max_regions_per_document || 24),
    max_planning_calls_per_document: Number(manifest.bounds.max_planning_calls_per_document || 8),
    max_claims_per_unit: Number(manifest.bounds.max_claims_per_unit || 64),
  };
  const semanticManifestDigest = sha256(canonical({ source_sha: manifest.source_sha, documents: manifest.documents, cross_document_pair: manifest.cross_document_pair, models: manifest.models }));
  const fingerprint = {
    pipeline: RECURSIVE_PILOT_SCHEMA,
    mapper_version: RECURSIVE_MAPPER_VERSION,
    inference_custody_policy: INFERENCE_CUSTODY_POLICY,
    source_sha: sourceSha,
    pilot_corpus_digest: pilotCorpusDigest,
    semantic_manifest_digest: semanticManifestDigest,
    planning_model: planningRunner?.model || manifest.models.planning,
    extraction_model: extractionRunner?.model || manifest.models.extraction,
    contracts: [PLANNING_HYPOTHESIS_SCHEMA, DOCUMENTARY_CLAIM_V3_SCHEMA, MAP_BUNDLE_SCHEMA],
  };
  const checkpoint = await openCheckpointJournal({ file: checkpointPath, fingerprint });
  const budget = createInferenceBudget({ max_calls: manifest.bounds.max_calls, max_known_cost_usd: manifest.bounds.max_known_cost_usd, max_unpriced_attempts: manifest.bounds.max_unpriced_attempts ?? 3 });
  const builtRunners = [];
  const planner = planningRunner || createPiRpcRunner({ model: manifest.models.planning, thinking: manifest.models.planning_thinking, timeoutMs: manifest.bounds.call_timeout_ms, maxOutputBytes: manifest.bounds.max_event_bytes, maxAnswerBytes: manifest.bounds.max_answer_bytes });
  const extractor = extractionRunner || createPiRpcRunner({ model: manifest.models.extraction, thinking: manifest.models.extraction_thinking, timeoutMs: manifest.bounds.call_timeout_ms, maxOutputBytes: manifest.bounds.max_event_bytes, maxAnswerBytes: manifest.bounds.max_answer_bytes });
  if (!planningRunner) builtRunners.push(planner);
  if (!extractionRunner) builtRunners.push(extractor);
  try {
    const plans = [];
    for (const rootRegion of roots) plans.push(await planRegionTree({ root: rootRegion, inventories, runner: planner, checkpoint, budget, bounds, inspectOnly }));
    const jointPlan = await planRegionTree({ root: jointRoot, inventories, runner: planner, checkpoint, budget, bounds: { ...bounds, max_planning_calls_per_document: 4 }, inspectOnly });
    plans.push(jointPlan);
    const planArtifact = {
      schema: 'estate-map/recursive-pilot-plan/v1', snapshot, manifest_digest: sha256(canonical(manifest)), semantic_manifest_digest: semanticManifestDigest,
      inventories, plans, leaf_region_ids: plans.flatMap(plan => plan.leaves.map(region => region.id)),
    };
    planArtifact.digest = sha256(canonical(planArtifact));

    const armB = await extractPlanArm({ arm: 'B', plans, inventories, runner: extractor, checkpoint, budget, injectPlan: true, bounds, inspectOnly });
    const armC = await extractPlanArm({ arm: 'C', plans, inventories, runner: extractor, checkpoint, budget, injectPlan: false, bounds, inspectOnly });
    const controlPath = controlArtifactPath || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', manifest.control_artifact);
    const control = await loadControlClaims(controlPath, manifest.documents.map(document => document.path));
    const arms = { A: { claims: control.claims }, B: armB, C: armC };
    const regionSetB = armB.extractions.map(item => item.region.id).sort();
    const regionSetC = armC.extractions.map(item => item.region.id).sort();
    if (canonical(regionSetB) !== canonical(regionSetC)) throw new RecursivePilotError('ARM_REGION_MISMATCH', 'B and C did not use identical regions');
    const incompleteUnits = [
      ...plans.flatMap(plan => plan.incomplete || []),
      ...(armB.incomplete || []).map(item => ({ arm: 'B', ...item })),
      ...(armC.incomplete || []).map(item => ({ arm: 'C', ...item })),
    ];
    const metrics = {
      A: armMetrics(control.claims, control.snapshot),
      B: armMetrics(armB.claims, snapshot),
      C: armMetrics(armC.claims, snapshot),
      identical_recursive_regions: true,
      recursive_region_count: regionSetB.length,
      incomplete_units: incompleteUnits.length,
      rejected_claims: { B: (armB.rejected_claims || []).length, C: (armC.rejected_claims || []).length },
      claim_cap_overshoots: { B: (armB.cap_overshoots || []).length, C: (armC.cap_overshoots || []).length },
    };
    const runBudget = budget.snapshot();
    const priorUnpricedAttempts = (manifest.repair_lineage || []).reduce((sum, item) => sum + Number(item.unpriced_attempts || 0), 0);
    const overallBudget = {
      ...runBudget,
      prior_unpriced_attempts: priorUnpricedAttempts,
      unpriced_attempts: Number(runBudget.unpriced_attempts || 0) + priorUnpricedAttempts,
      cost_status: priorUnpricedAttempts ? 'lower_bound' : runBudget.cost_status,
    };
    const result = {
      schema: RECURSIVE_PILOT_SCHEMA,
      status: (priorUnpricedAttempts || runBudget.unpriced_attempts || incompleteUnits.length) ? 'awaiting_human_review_incomplete_cost' : 'awaiting_human_review',
      incomplete_units: incompleteUnits,
      snapshot,
      manifest,
      manifest_digest: sha256(canonical(manifest)),
      semantic_manifest_digest: semanticManifestDigest,
      plan: planArtifact,
      control: { artifact_digest: control.artifact_digest, completion: control.completion, skipped: control.skipped, claims: control.claims },
      arms: { B: armB, C: armC },
      metrics,
      budget: overallBudget,
      checkpoint: { fingerprint_hash: checkpoint.stats().fingerprint_hash, entries: checkpoint.stats().entries },
      epistemic_note: 'Derived non-authoritative pilot. Source plus blinded human review decides promotion.',
    };
    result.digest = sha256(canonical(result));
    const review = buildBlindedReview({ inventories, arms, seed: result.digest });
    review.packet.pilot_cost_status = overallBudget.cost_status;
    review.packet.promotion_blocked_by_unpriced_attempt = priorUnpricedAttempts > 0;
    await atomicWrite(outputPath, result);
    await atomicWrite(reviewPath, review.packet);
    await atomicWrite(blindKeyPath, review.key);
    return { result, review, paths: { output: path.resolve(outputPath), review: path.resolve(reviewPath), blind_key: path.resolve(blindKeyPath) } };
  } finally {
    await checkpoint.close();
    for (const runner of builtRunners) { try { await runner.shutdown?.(); } catch { /* best effort */ } }
  }
}

function parseArgs(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i += 1) argv[i].startsWith('--') ? options[argv[i].slice(2)] = argv[++i] : positional.push(argv[i]);
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const root = positional[0];
  if (!root || !options.manifest || !options.checkpoint || !options.output || !options.review || !options['blind-key']) {
    throw new Error('usage: recursive-semantic-mapper.mjs <estate-root> --manifest <json> --checkpoint <jsonl> --output <json> --review <json> --blind-key <json>');
  }
  const manifest = JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8'));
  const completed = await runRecursivePilot({ root, manifest, checkpointPath: options.checkpoint, outputPath: options.output, reviewPath: options.review, blindKeyPath: options['blind-key'], controlArtifactPath: options.control || null });
  console.log(JSON.stringify({ output: completed.paths.output, review: completed.paths.review, blind_key: completed.paths.blind_key, metrics: completed.result.metrics, budget: completed.result.budget, digest: completed.result.digest }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
