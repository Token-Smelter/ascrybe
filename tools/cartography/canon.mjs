// Preserve source witnesses; do not infer authority from naming conventions alone.
import { readFileSync } from 'node:fs';

export const CARTOGRAPHY_SCHEMA = 'estate-map/cartography-view-model/v1';
export const CARTOGRAPHY_VIEW_MODEL_VERSION = '1';
export const CARTOGRAPHY_LAYOUT_RULE_VERSION = '1';
// v1 (data-representation consultation #4): bundle identity is split from content identity, so
// adding one member edge no longer changes a bundle's logical id. bundle_uid hashes only the
// stable logical key (source, target, family, projection, grouping-rule version); the sorted
// member-edge set lives in member_set_digest. Bump this when the grouping rule changes.
export const CARTOGRAPHY_GROUPING_RULE_VERSION = '1';
export const CARTOGRAPHY_EVENT_CONTRACT_SCHEMA = 'estate-map/cartography-event-contract/v1';
export const CARTOGRAPHY_BUNDLE_PROJECTION_SCHEMA = 'estate-map/cartography-edge-bundle-projection/v1';
export const CARTOGRAPHY_EVIDENCE_SUMMARY_SCHEMA = 'estate-map/cartography-evidence-summary/v1';
export const CARTOGRAPHY_CONTRACT_SLICE_RULE = 'contract-slice-by-envelope-and-provenance@1';

// Provenance classes — the FIRST-CLASS projection axis (answer Q1). `unknown` is RESERVED: a
// missing/unrecognised edge provenance_class classifies as `unknown`, NEVER silently as
// production. Test provenance is POSITIVELY KNOWN (Verification lens), not epistemic uncertainty.
export const PROVENANCE_CLASSES = Object.freeze(['production', 'test', 'fixture', 'docs', 'unknown']);

// Named provenance lenses (answer Q1). Runtime (production) is the DEFAULT rendering.
export const PROVENANCE_LENSES = Object.freeze([
  Object.freeze({ id: 'runtime', label: 'Runtime', classes: Object.freeze(['production']), is_default: true,
    purpose: 'What can shape live behavior?' }),
  Object.freeze({ id: 'verification', label: 'Verification', classes: Object.freeze(['test', 'fixture']), is_default: false,
    purpose: 'How is the behavior exercised, simulated, or specified?' }),
  Object.freeze({ id: 'declared', label: 'Declared', classes: Object.freeze(['docs']), is_default: false,
    purpose: 'What does the estate claim should exist?' }),
  Object.freeze({ id: 'all-evidence', label: 'All evidence', classes: PROVENANCE_CLASSES, is_default: false,
    purpose: 'Exhaustive reconciliation, including explicit unknown.' }),
]);
export const DEFAULT_PROVENANCE_LENS = 'runtime';

// Classify an edge's provenance. Missing/unrecognised => `unknown` (never production).
export function edgeProvenanceClass(edge) {
  const value = edge && edge.provenance_class;
  return PROVENANCE_CLASSES.includes(value) ? value : 'unknown';
}

// Emit vs consume role for an event edge kind.
export function eventEdgeRole(edgeKind) {
  if (edgeKind === 'emits' || edgeKind === 'publishes_to') return 'emits';
  if (edgeKind === 'consumes') return 'consumes';
  return null;
}
export const CANON_RECEIPT = Object.freeze({
  doc: 'design/canon/ddd-mapping.md',
  sections: Object.freeze(['1.1 Bounded Contexts', '1.2 The Substrate Is Not a Bounded Context', '2 Aggregates']),
});

// scope_kind taxonomy (answer Q1 "Scope records required above the existing graph").
export const SCOPE_KINDS = Object.freeze([
  'estate', 'plugin_scope', 'bounded_context', 'aggregate', 'substrate_scope',
  'client_scope', 'engineering_scope', 'delivery_scope', 'environment_scope',
  'path_scope', 'diagnostic_scope',
]);

// Bounded contexts are estate-specific vocabulary, so they come from an optional private JSON file
// named by ASCRYBE_CARTOGRAPHY_CONTEXTS:
//   { "plugin_contexts": [{ plugin, context, context_slug, aggregates }],
//     "domain_context_aliases": { "<slug>": "<context_slug>" } }
// Each plugin becomes a physical plugin_scope carrying one bounded-context core. Aggregates are
// imported as scope records with `membership_basis: canon_catalog`; they carry NO estate members
// until a module->aggregate membership receipt exists (answer Q1: "membership not yet
// established", never "0 members"). Without the file the canon declares no contexts, so nothing
// is attributed to a shape borrowed from another estate.
function loadContextConfig() {
  const file = process.env.ASCRYBE_CARTOGRAPHY_CONTEXTS;
  if (!file) return { plugin_contexts: [], domain_context_aliases: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const contexts = parsed.plugin_contexts ?? [];
  for (const entry of contexts) {
    if (![entry.plugin, entry.context, entry.context_slug].every(value => typeof value === 'string' && value) || !Array.isArray(entry.aggregates)) {
      throw new Error('ASCRYBE_CARTOGRAPHY_CONTEXTS: each plugin context needs plugin, context, context_slug and aggregates');
    }
  }
  return { plugin_contexts: contexts, domain_context_aliases: parsed.domain_context_aliases ?? {} };
}
const CONTEXT_CONFIG = loadContextConfig();
export const PLUGIN_CONTEXTS = Object.freeze(CONTEXT_CONFIG.plugin_contexts.map(entry => Object.freeze({ ...entry, aggregates: Object.freeze([...entry.aggregates]) })));

// Domain-label aliases: documented service-card `domain` strings that resolve to a canonical
// context. Case/spacing-insensitive slug match is applied first; this table only captures the
// few known non-identity aliases. Any assigned domain that resolves to none of these keeps its
// own bounded_context scope labeled by the raw domain string (honest, never dropped).
export const DOMAIN_CONTEXT_ALIASES = Object.freeze({ ...CONTEXT_CONFIG.domain_context_aliases });

// Preserve source witnesses; do not infer authority from naming conventions alone.
export const ASSIGNMENT_STATES = Object.freeze([
  'assigned', 'ambiguous', 'no_anchor', 'ineligible_subject', 'fixture_only', 'unaccounted',
]);

// relation-family -> display-family map (answer Q1 "governed classification of edge types into
// display families"). Every edge kind the merge produces MUST map to exactly one family here or
// the compiler fails loudly (a silent unmapped edge kind is a conservation defect).
export const RELATION_FAMILY_BY_EDGE_KIND = Object.freeze({
  imports: 'code_dependency',
  depends_on: 'code_dependency',
  declares_dependency: 'code_dependency',
  consumes_package: 'code_dependency',
  imports_framework: 'code_dependency',
  member_of: 'containment',
  emits: 'event_incidence',
  consumes: 'event_incidence',
  publishes_to: 'event_incidence',
  exposes_route: 'route',
  provides_capability: 'capability',
  requires_capability: 'capability',
  calls_capability: 'capability',
  declares_service: 'service_declaration',
  declares_resource: 'infrastructure',
  declares_resource_ref: 'infrastructure',
  tf_ref: 'infrastructure',
  uses_infra: 'infrastructure',
  declares_config: 'configuration',
  declares_sql_object: 'data',
  covers: 'coverage',
  references: 'reference',
});

// Display families in canonical render/order priority. `containment` is deliberately NOT an
// architectural connectivity family (answer Q1/Q3: containment edges must not make a
// disconnected node look connected).
export const DISPLAY_FAMILIES = Object.freeze([
  'code_dependency', 'event_incidence', 'route', 'capability', 'service_declaration',
  'infrastructure', 'configuration', 'data', 'coverage', 'reference', 'containment', 'other',
]);

// Connectivity projections (answer Q1/Q3/D: orphan is always qualified by projection).
// Each names the edge kinds it spans; containment is excluded from architectural orphan calc.
export const CONNECTIVITY_PROJECTIONS = Object.freeze([
  Object.freeze({ id: 'module-import', label: 'module import', edge_kinds: Object.freeze(['imports', 'depends_on']) }),
  Object.freeze({ id: 'event-flow', label: 'event flow', edge_kinds: Object.freeze(['emits', 'consumes']) }),
  Object.freeze({ id: 'all-architecture', label: 'all non-containment architecture edges',
    edge_kinds: Object.freeze(Object.keys(RELATION_FAMILY_BY_EDGE_KIND).filter(kind => RELATION_FAMILY_BY_EDGE_KIND[kind] !== 'containment')) }),
]);

// LLM tile budget profiles (answer Q4). Byte caps are the deterministic gate; token figures are
// advisory. Packing is by stable address, never "representative" sampling.
export const BUDGET_PROFILES = Object.freeze([
  Object.freeze({ id: 'summary', max_tokens: 2000, max_utf8_bytes: 8000 }),
  Object.freeze({ id: 'standard', max_tokens: 8000, max_utf8_bytes: 32000 }),
  Object.freeze({ id: 'deep', max_tokens: 32000, max_utf8_bytes: 131072 }),
]);
export const TOKENIZER_ID = 'utf8-byte-budget/v1';

export const slug = value => String(value || '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

// Resolve a documented `domain` label to a canonical context slug, or to its own honest slug.
export function contextSlugForDomain(domain) {
  const s = slug(domain);
  if (DOMAIN_CONTEXT_ALIASES[s]) return DOMAIN_CONTEXT_ALIASES[s];
  const byContext = PLUGIN_CONTEXTS.find(entry => entry.context_slug === s || slug(entry.context) === s || entry.plugin === s);
  return byContext ? byContext.context_slug : s;
}

// Unknown edge kinds map to a VISIBLE `other` family, never dropped: the compiler records the
// exact unmapped kinds in the view-model so an ungoverned edge kind is a countable diagnostic,
// not a silent conservation hole (answer: a silent drop is a defect, a visible count a feature).
export function relationFamily(edgeKind) {
  return RELATION_FAMILY_BY_EDGE_KIND[edgeKind] || 'other';
}
