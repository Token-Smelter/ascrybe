#!/usr/bin/env node
// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { parseArgs } from './lib.mjs';
import { readOverlay } from './annotate.mjs';
import { loadEntityAnalysisConfig, validateEntityAnalysisConfig, unconfiguredEntityAnalysis } from './entity-analysis-config.mjs';

export const DOMAIN_PREPASS_SCHEMA = 'estate-map/domain-prepass-receipt/v2';
export const DOMAIN_PREPASS_PRODUCER = 'deterministic/domain-prepass@1';
export const DOMAIN_PREPASS_RULE = 'DPA-1-direct-anchored-adjacency';
export const DOMAIN_PREPASS_VERSION = '3';
export const DOMAIN_PREPASS_STATUSES = Object.freeze(['assigned', 'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only']);
// Statuses whose subject was gated (subject/fixture eligibility) or found no strong-edge
// anchor: they carry no adjacency candidates or evidence.
export const NON_ADJACENT_STATUSES = Object.freeze(['no_anchor', 'ineligible_subject', 'fixture_only']);
// @2 EDGE-ELIGIBILITY GATE. Only these strong, membership-entailing edges propagate a domain.
export const PROPAGATION_EDGE_KINDS = Object.freeze(['member_of', 'declares_service', 'declares_resource']);
// Imports and event flow do not establish domain membership, so they cannot propagate it.
export const DROPPED_EDGE_KINDS = Object.freeze(['emits', 'consumes', 'imports']);
// Retained export name; @2 narrows it to the strong edges only.
export const ADJACENCY_KINDS = PROPAGATION_EDGE_KINDS;
// Exclusion reason classes for ineligible_subject receipts (audit §5.2 FM classes).
export const SUBJECT_EXCLUSION_REASONS = Object.freeze([
  'substrate', 'session_rpc_infra', 'composition_root', 'scripts',
  'client', 'test', 'test_fixture', 'read_model', 'envelope_kind',
]);
export const FIXTURE_ONLY_REASON = 'test_only_witnesses';
const DEFAULT_GENERATED_AT = '2026-07-28T00:00:00Z';

const witnessKey = value => `${value.repo}\0${value.file}\0${value.line}`;
const canonicalWitness = ({ repo, file, line }) => ({ repo, file, line });
const sortWitnesses = values => [...new Map(values
  .map(canonicalWitness)
  .map(value => [witnessKey(value), value])).values()]
  .sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);
const sortEdges = values => values.sort((a, b) => a.id.localeCompare(b.id));
const targets = edge => edge.to ? [edge.to] : Array.isArray(edge.candidates) ? edge.candidates : [];

// Parse a node id / repo into { component, rel, base }. Module ids are `module:<component>:<relpath>`;
// we fall back to node.repo and the leading witness path when the id is not module-shaped.
function subjectLocation(node) {
  const parts = String(node.id || '').split(':');
  const component = node.repo || (parts.length > 1 ? parts[1] : '') || '';
  const rel = parts.length > 2 ? parts.slice(2).join(':') : ((node.witnesses || [])[0]?.file || '');
  const base = rel.split('/').pop() || '';
  return { component, rel, base };
}

/**
 * SUBJECT-ELIGIBILITY GATE. Returns the exclusion reason class if the subject is a non-domain
 * by construction per canon §1.2 and the census FM classes, else null. Envelope kinds are
 * excluded here entirely (audit §5.2.2 option (a): a successor may later assign by emitting
 * aggregate, but @2 does not) — except synthetic/test-only kinds, which are classified
 * `fixture_only` upstream of this gate.
 */
export function subjectExclusionReason(node, entityConfig = null) {
  entityConfig = validateEntityAnalysisConfig(entityConfig);
  if (node.kind === 'envelope_kind') return 'envelope_kind';
  const { component, rel, base } = subjectLocation(node);
  if (node.kind === 'repo') {
    if (node.id === 'repo:test-fixtures' || component === 'test-fixtures') return 'test_fixture';
    if (node.id === 'repo:test' || component === 'test') return 'test';
    return null;
  }
  switch (component) {
    case 'test': return 'test';
    case 'test-fixtures': return 'test_fixture';
    case 'client': return 'client';
    case 'scripts': return 'scripts';
    default: break;
  }
  for (const rule of entityConfig?.subject_exclusions ?? []) {
    if (component !== rule.component) continue;
    if ((rule.path !== undefined && rel === rule.path) ||
        (rule.path_prefix !== undefined && rel.startsWith(rule.path_prefix)) ||
        (rule.basename !== undefined && base === rule.basename) ||
        (rule.basename_prefix !== undefined && base.startsWith(rule.basename_prefix))) return rule.reason;
  }
  return null;
}

// A witness is fixture-class when its provenance is test/fixture, or (when provenance is
// absent) its path is under test/**, test-fixtures/**, or client/e2e/**.
function witnessIsFixtureClass(witness) {
  const provenance = witness?.provenance_class;
  if (provenance === 'production' || provenance === 'docs') return false;
  if (provenance === 'test' || provenance === 'fixture') return true;
  const repo = witness?.repo || '';
  const file = witness?.file || '';
  if (repo === 'test' || repo === 'test-fixtures') return true;
  if (repo === 'client' && (file === 'e2e' || file.startsWith('e2e/'))) return true;
  if (/(^|\/)test(-fixtures)?\//.test(file) || file.startsWith('test/') || file.startsWith('test-fixtures/')) return true;
  if (/(^|\/)e2e\//.test(file)) return true;
  return false;
}

/**
 * FIXTURE/SYNTHETIC CLASSIFICATION. An envelope_kind node whose ONLY witnesses come from
 * test/**, test-fixtures/**, or client/e2e/** is a synthetic fixture, not a real estate
 * entity (e.g. batch-imaginary, batch-made-up, definitely-not-a-real-envelope-kind). It is
 * classified `fixture_only` — typed, counted, conservation-covered — and excluded from the
 * canonical estate node totals, never assigned and never silently dropped.
 */
export function isFixtureOnlyEnvelope(node) {
  if (node.kind !== 'envelope_kind') return false;
  const witnesses = node.witnesses || [];
  if (!witnesses.length) return false;
  return witnesses.every(witnessIsFixtureClass);
}

export function documentedDomainAnchors(records) {
  const bySubject = new Map();
  for (const record of records) {
    const domain = record.annotation_kind === 'service_card' ? record.body?.domain : null;
    if (!domain) continue;
    const prior = bySubject.get(record.subject);
    if (prior && prior !== domain) throw new Error(`documented domain anchors conflict for ${record.subject}: ${prior} != ${domain}`);
    bySubject.set(record.subject, domain);
  }
  return bySubject;
}

export function deriveDomainPrepass(graph, documentedRecords, { generatedAt = DEFAULT_GENERATED_AT, existingRecords = [], entityConfig = null } = {}) {
  entityConfig = validateEntityAnalysisConfig(entityConfig);
  const documentedAnchors = documentedDomainAnchors(documentedRecords);
  const domains = new Set(documentedAnchors.values());
  const anchors = documentedDomainAnchors([...documentedRecords, ...existingRecords]);
  const outsideVocabulary = [...new Set(anchors.values())].filter(domain => !domains.has(domain)).sort();
  if (outsideVocabulary.length) throw new Error(`existing domain assignments use labels outside the documented closed set: ${outsideVocabulary.join(', ')}`);
  // A foreign estate may carry no project-specific DDD anchors. It still gets a
  // typed no_anchor receipt per node; absence of local vocabulary is not a crash.
  const nodeIds = new Set((graph.nodes || []).map(node => node.id));
  const neighbors = new Map();
  for (const edge of graph.edges || []) {
    if (!PROPAGATION_EDGE_KINDS.includes(edge.kind) || !nodeIds.has(edge.from)) continue;
    for (const target of targets(edge)) {
      if (!nodeIds.has(target)) continue;
      for (const [subject, other] of [[edge.from, target], [target, edge.from]]) {
        const list = neighbors.get(subject) || [];
        list.push({ edge, other });
        neighbors.set(subject, list);
      }
    }
  }

  const receipts = [];
  const assignments = [];
  for (const node of (graph.nodes || []).slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (anchors.has(node.id)) continue;
    const base = {
      schema: DOMAIN_PREPASS_SCHEMA,
      producer: DOMAIN_PREPASS_PRODUCER,
      rule_id: DOMAIN_PREPASS_RULE,
      rule_version: DOMAIN_PREPASS_VERSION,
      subject: node.id,
      subject_kind: node.kind || 'evidence',
      generated_at: generatedAt,
      subject_witnesses: sortWitnesses(node.witnesses || []),
      examined_edge_ids: [],
      evidence: [],
      exclusion_reason: null,
    };
    // FIXTURE gate: synthetic/test-only envelope kinds are non-estate diagnostics.
    if (isFixtureOnlyEnvelope(node)) {
      receipts.push({ ...base, status: 'fixture_only', domain: null, candidates: [], exclusion_reason: FIXTURE_ONLY_REASON, reason: 'envelope kind is witnessed only from test/test-fixtures/client-e2e paths; classified non-estate fixture_only (not counted in canonical estate totals)' });
      continue;
    }
    // SUBJECT-ELIGIBILITY gate: canon §1.2 non-domains by construction.
    const exclusion = subjectExclusionReason(node, entityConfig);
    if (exclusion) {
      receipts.push({ ...base, status: 'ineligible_subject', domain: null, candidates: [], exclusion_reason: exclusion, reason: `subject class "${exclusion}" is a non-domain by construction (DPA-1@3 subject-eligibility gate); no domain assigned` });
      continue;
    }
    // EDGE-ELIGIBILITY gate already applied when building `neighbors` (strong edges only).
    const adjacent = (neighbors.get(node.id) || []).slice().sort((a, b) => a.edge.id.localeCompare(b.edge.id) || a.other.localeCompare(b.other));
    const candidates = new Map();
    for (const { edge, other } of adjacent) {
      const domain = anchors.get(other);
      if (!domain) continue;
      const list = candidates.get(domain) || [];
      list.push(edge);
      candidates.set(domain, list);
    }
    const candidateDomains = [...candidates.keys()].sort();
    const evidence = candidateDomains.map(domain => ({
      domain,
      edge_ids: sortEdges(candidates.get(domain).slice()).map(edge => edge.id),
      witnesses: sortWitnesses(candidates.get(domain).flatMap(edge => edge.witnesses || [])),
    }));
    base.examined_edge_ids = [...new Set(adjacent.map(item => item.edge.id))].sort();
    base.evidence = evidence;
    if (candidateDomains.length === 0) {
      receipts.push({ ...base, status: 'no_anchor', domain: null, candidates: [], evidence: [], reason: 'no documented-domain anchor is adjacent through a strong membership edge (member_of / declares_service / declares_resource)' });
      continue;
    }
    if (candidateDomains.length > 1) {
      receipts.push({ ...base, status: 'ambiguous', domain: null, candidates: candidateDomains, reason: 'adjacent documented anchors belong to conflicting domains' });
      continue;
    }
    const domain = candidateDomains[0];
    if (!domains.has(domain)) throw new Error(`domain prepass attempted non-documented domain: ${domain}`);
    const witnesses = evidence[0].witnesses;
    if (!witnesses.length) throw new Error(`domain prepass receipt for ${node.id} has no edge witness`);
    receipts.push({ ...base, status: 'assigned', domain, candidates: [domain], reason: 'all adjacent documented anchors agree on one domain via a strong membership edge' });
    assignments.push({
      annotation_kind: 'service_card', subject: node.id, kind: 'doc_derived_annotation',
      model: `${DOMAIN_PREPASS_PRODUCER}:${DOMAIN_PREPASS_RULE}`,
      confidence: 1, generated_at: generatedAt, grounded_in: witnesses,
      body: {
        domain,
        key_flows: evidence[0].edge_ids.map(id => `anchored adjacency via ${id}`),
        risks: ['Derived from direct strong-edge adjacency to documented-domain anchors; not a documented canon assignment.'],
        summary: `${DOMAIN_PREPASS_RULE}@${DOMAIN_PREPASS_VERSION}: all documented anchor neighbours agree on "${domain}" via a strong membership edge.`,
      },
    });
  }
  const byStatus = Object.fromEntries(DOMAIN_PREPASS_STATUSES.map(status => [status, receipts.filter(receipt => receipt.status === status).length]));
  const byDomain = Object.fromEntries([...new Set(assignments.map(record => record.body.domain))].sort().map(domain => [domain, assignments.filter(record => record.body.domain === domain).length]));
  const ineligibleByReason = Object.fromEntries([...new Set([...SUBJECT_EXCLUSION_REASONS, ...(entityConfig?.subject_exclusions ?? []).map(rule => rule.reason)])]
    .map(reasonClass => [reasonClass, receipts.filter(receipt => receipt.status === 'ineligible_subject' && receipt.exclusion_reason === reasonClass).length])
    .filter(([, count]) => count > 0));
  if (receipts.length !== (graph.nodes || []).length - anchors.size) throw new Error('domain prepass omitted an undomained node receipt');
  // `fixture_only` subjects are non-estate synthetic entities; they are counted but excluded
  // from the canonical undomained-estate denominator used by the census/sizing report.
  const undomainedEstate = receipts.length - byStatus.fixture_only;
  return {
    anchors,
    assignments,
    receipts,
    census: {
      ...(!entityConfig ? { configuration_dispositions: unconfiguredEntityAnalysis(['subject_exclusions']) } : {}),
      undomained_before: undomainedEstate,
      ...byStatus,
      residue_for_model_adjudication: byStatus.ambiguous + byStatus.no_anchor,
      ineligible_by_reason: ineligibleByReason,
      assigned_by_domain: byDomain,
    },
  };
}

const writeJsonl = async (file, records) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
};

export async function produceDomainPrepass(graphPath, documentedPath, assignmentsPath, receiptsPath, options = {}) {
  const [graph, documented, existingRecords] = await Promise.all([
    fs.readFile(graphPath, 'utf8').then(JSON.parse),
    readOverlay(documentedPath),
    options.existingPath ? readOverlay(options.existingPath) : [],
  ]);
  const result = deriveDomainPrepass(graph, documented, { ...options, existingRecords });
  await Promise.all([writeJsonl(assignmentsPath, result.assignments), writeJsonl(receiptsPath, result.receipts)]);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || positional.length < 4) {
    console.log('Usage: node tools/estate-map/domain-prepass.mjs <graph.json> <documented.jsonl> <assignments.jsonl> <receipts.domain-prepass.jsonl> [--existing <domain-assignments.jsonl>] [--generated-at <iso>]');
    process.exit(options.help ? 0 : 1);
  }
  try {
    const result = await produceDomainPrepass(...positional.slice(0, 4).map(value => path.resolve(value)), { generatedAt: options['generated-at'], existingPath: options.existing ? path.resolve(options.existing) : undefined, entityConfig: loadEntityAnalysisConfig(options['runtime-config']) });
    console.log(JSON.stringify(result.census, null, 2));
  } catch (error) { console.error(error.message); process.exit(1); }
}
