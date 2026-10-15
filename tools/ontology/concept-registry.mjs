// Preserve source witnesses; do not infer authority from naming conventions alone.
import { sha256 } from '../lib.mjs';
import { NODE_PLANE_REGISTRY } from '../estate-graph-roles.mjs';
import { canonical, digestMatches, fail, CONCEPT_VERSION_SCHEMA, PATTERN_SCHEMA } from './schemas.mjs';
import { conceptId, parseConceptId } from './ids.mjs';
import { validateExpression } from './pattern-language.mjs';

export const SCHEME_IDS = Object.freeze({
  architectural_role: 'ontology-scheme:ascrybe:architectural-role',
  epistemic_standing: 'ontology-scheme:ascrybe:epistemic-standing',
});

// Kept for validation only (a concept's eligible kinds must still be real entity-plane kinds);
// no longer used as the default eligible-subject population itself.
const ALL_ENTITY_NODE_KINDS = Object.freeze(Object.entries(NODE_PLANE_REGISTRY)
  .filter(([, plane]) => plane === 'entity').map(([kind]) => kind).sort());
const ROLE_ELIGIBLE_KINDS = Object.freeze(['Module', 'Plugin', 'Referent']);
for (const kind of ROLE_ELIGIBLE_KINDS) {
  if (!ALL_ENTITY_NODE_KINDS.includes(kind)) {
    fail('CONCEPT_VERSION_INPUT_INVALID', `ROLE_ELIGIBLE_KINDS names ${kind}, which is not a registered entity-plane kind`);
  }
}

const edge = (direction, relation, targetKind) => (targetKind
  ? { edge_exists: { direction, relation, target_kind: targetKind } }
  : { edge_exists: { direction, relation } });
// `owns_fact` is never a base-graph relation (absent from RELATION_REGISTRY on purpose): it is
// synthesized per evidence context by subjects.mjs's file-path owner resolution, only where an
// observation-plane fact's exact file matches exactly one Module/Plugin/Referent's own namespace.
// See the CORRECTED note on AR-0006/AR-0007 below for why the old `contains` leaf never fired.
const owns = kind => edge('out', 'owns_fact', kind);
const or = (...of) => ({ or: of });
const and = (...of) => ({ and: of });
const fieldEq = (field, value) => ({ field_equals: { field, value } });
const fieldIn = (field, values) => ({ field_in: { field, values } });
const fieldSetEq = (field, values) => ({ field_set_equals: { field, values } });

const MANY_TO_MANY_CARDINALITY = Object.freeze({
  subjects_may_have_multiple_concepts: true, concept_may_have_multiple_members: true,
  exhaustive: false, disjoint_with: [],
});

// Preserve source witnesses; do not infer authority from naming conventions alone.
const PRODUCTION_SCOPE_NOTE = '; does not claim membership from test-only or fixture-only evidence (that requires a production witness -- a test/fixture-only match is not_member, reason TEST_OR_FIXTURE_ONLY, with its witnesses retained)';
const ARCHITECTURAL_ROLE_DEFS = Object.freeze([
  { code: 'AR-0001', stable_key: 'capability-provider', preferred_label: 'Capability provider',
    definition: 'An estate entity from which at least one projected provides_capability relation originates.',
    does_not_claim: `that the capability works${PRODUCTION_SCOPE_NOTE}`,
    expression: edge('out', 'provides_capability', 'Capability') },
  // CORRECTED: exposes_route alone ignored registers_route, a separate registered structural
  // relation (estate-graph-roles.mjs) a real run showed also originates route declarations.
  { code: 'AR-0002', stable_key: 'route-handler', preferred_label: 'Route handler',
    definition: 'An estate entity from which at least one projected exposes_route or registers_route relation originates.',
    does_not_claim: `reachability in a live deployment${PRODUCTION_SCOPE_NOTE}`,
    expression: or(edge('out', 'exposes_route', 'Route'), edge('out', 'registers_route')) },
  { code: 'AR-0003', stable_key: 'envelope-publisher', preferred_label: 'Envelope publisher',
    definition: 'An estate entity that structurally publishes an envelope (publishes_envelope) or originates a recorded emit flow (emits) for one.',
    does_not_claim: `that an envelope was ever actually sent${PRODUCTION_SCOPE_NOTE}`,
    expression: or(edge('out', 'publishes_envelope'), edge('out', 'emits')) },
  // CORRECTED (operator, 2026-09-26, against real held-out answers): "recorded as a consume-flow
  // TARGET" contradicted the rule it described -- `edge('out', 'consumes')` makes the subject the
  // EDGE'S SOURCE (it is the entity a `consumes` relation originates FROM), not its target; "target"
  // here meant "target/recipient of the envelope flow", a different sense the wording never
  // disambiguated. Every disagreement said some version of "the subject is the source, not the
  // target, of the consumes relation" -- correctly, against the word actually used. Restated in the
  // same "entity from which ... originates" shape every other structural-motif definition uses,
  // all of which held 100% agreement.
  { code: 'AR-0004', stable_key: 'envelope-consumer', preferred_label: 'Envelope consumer',
    definition: 'An estate entity from which at least one projected consumes relation originates.',
    does_not_claim: `that an event was ever actually received${PRODUCTION_SCOPE_NOTE}`,
    expression: edge('out', 'consumes') },
  { code: 'AR-0005', stable_key: 'capability-caller', preferred_label: 'Capability caller',
    definition: 'An estate entity that calls (calls_capability) or requires (requires_capability) a capability another entity provides.',
    does_not_claim: `that a call ever actually occurred${PRODUCTION_SCOPE_NOTE}`,
    expression: or(edge('out', 'calls_capability'), edge('out', 'requires_capability')) },
  // CORRECTED: a real run showed SqliteTable/PersistenceTarget facts are never reached by a
  // structural edge from any Module/Plugin/Referent -- they are observation-plane facts attached
  // only to the SourceCommit aggregate ("no module owns them", operator finding). `owns_fact` is
  // an owner RESOLVED by subjects.mjs from the fact's own exact file, not a base-graph edge; it
  // fires only where that file matches exactly one entity's own namespace, and abstains otherwise
  // -- never a guess, per the "exact and unambiguous, otherwise abstain" instruction.
  { code: 'AR-0006', stable_key: 'persistence-adapter', preferred_label: 'Persistence adapter',
    definition: 'An estate entity that declares a table (declares_table), or whose own exact file is the unambiguous owner of a SqliteTable or PersistenceTarget fact.',
    does_not_claim: `that data was ever actually written${PRODUCTION_SCOPE_NOTE}`,
    expression: or(edge('out', 'declares_table'), owns('SqliteTable'), owns('PersistenceTarget')) },
  { code: 'AR-0007', stable_key: 'external-http-client', preferred_label: 'External HTTP client',
    definition: 'An estate entity whose own exact file is the unambiguous owner of an HttpClientCall or ConfiguredUrl fact.',
    does_not_claim: `that a request was ever actually made${PRODUCTION_SCOPE_NOTE}`,
    expression: or(owns('HttpClientCall'), owns('ConfiguredUrl')) },
  { code: 'AR-0008', stable_key: 'route-and-event-boundary', preferred_label: 'Route and event boundary',
    definition: 'A route-handler entity that is also an envelope-publisher or envelope-consumer: it both exposes a route and either publishes or consumes an envelope.',
    does_not_claim: `anything beyond the conjunction of the two composite facts${PRODUCTION_SCOPE_NOTE}`,
    expression: and(or(edge('out', 'exposes_route', 'Route'), edge('out', 'registers_route')),
      or(edge('out', 'publishes_envelope'), edge('out', 'emits'), edge('out', 'consumes'))) },
]);

// design v2 section 4b. All closed-world: `claim_kind`, `verdict`, `realization` and
// `supporting_evidence_tiers` are required, controlled-vocabulary columns on every terminal
// adjudication receipt (claim-evidence-map.mjs's CLAIM_ADJUDICATION_CONSERVATION invariant: every
// imported claim gets exactly one terminal receipt with these fields populated). An observed value
// that differs from the requested one is a genuine not_member, not an evidentiary gap.
const EPISTEMIC_STANDING_DEFS = Object.freeze([
  { code: 'EP-0001', stable_key: 'documentary-design-rule', preferred_label: 'Documentary design rule',
    definition: 'A claim whose declared kind is accepted_design and for which documentary source evidence is present.',
    does_not_claim: 'that an implementation exists',
    expression: and(fieldEq('claim_kind', 'accepted_design'), fieldEq('has_documentary_evidence', true)) },
  { code: 'EP-0002', stable_key: 'documented-current-capability', preferred_label: 'Documented current capability',
    definition: 'A claim whose declared kind is current_capability.',
    does_not_claim: 'that the capability is implemented or has been exercised',
    expression: fieldEq('claim_kind', 'current_capability') },
  // CORRECTED (operator, 2026-09-26, against real held-out answers): "carries the declared
  // evidence tier" read, to an independent judge, as if "the declared evidence tier" were some
  // OTHER unshown reference value to compare against, rather than the literal string 'declared'
  // already present in the shown supporting_evidence_tiers array -- every disagreement here said
  // some form of "does not identify the declared evidence tier". Naming the literal value fixes it.
  { code: 'EP-0003', stable_key: 'declaration-supported-claim', preferred_label: 'Declaration-supported claim',
    definition: 'A claim whose adjudication receipt\'s supporting_evidence_tiers field includes the tier \'declared\'.',
    does_not_claim: 'that the declaration was exercised at runtime',
    expression: fieldIn('supporting_evidence_tiers', ['declared']) },
  { code: 'EP-0004', stable_key: 'documentary-only-supported-claim', preferred_label: 'Documentary-only supported claim',
    definition: 'A claim adjudicated supported whose supporting evidence tiers are exactly {documentary}: no declared or executed evidence backs it.',
    does_not_claim: 'that the statement is false, only that code has not independently confirmed it',
    expression: and(fieldEq('verdict', 'supported'), fieldSetEq('supporting_evidence_tiers', ['documentary'])) },
  // RENAMED (operator correction): the old name read as "the claim's prose poses a question",
  // which is not what this measures. `open_question` is one closed-vocabulary OBLIGATION KIND in
  // claim-evidence-map.mjs's own schema (obligationKinds) -- a proof-plan authoring choice, not a
  // property of the claim's statement text. Same rule, same accession (EP-0005), clearer name.
  { code: 'EP-0005', stable_key: 'unresolved-proof-obligation-claim',
    preferred_label: 'Claim with an unresolved proof obligation',
    definition: 'A claim whose proof plan declares an obligation of kind open_question (claim-evidence-map.mjs\'s obligation-kind vocabulary), or whose adjudication left such an obligation underdetermined: the adjudicator could not settle it against the currently complete inventories.',
    does_not_claim: 'that the claim\'s own statement poses an explicit or rhetorical question in prose -- "open_question" here names a proof-obligation kind in the adjudication schema, not a property of the claim text',
    expression: or(fieldIn('proof_plan_obligation_kinds', ['open_question']), fieldEq('open_question_underdetermined', true)) },
  // CORRECTED (operator, 2026-09-26, against real held-out answers): the old definitions added an
  // explanatory GLOSS after the field check ("a declaration was found but behavior was not shown
  // to be exercised"; "could not be established from the currently complete inventories"). An
  // independent judge treated the gloss as ADDITIONAL evidence it needed proof of, separate from
  // the realization field itself, and abstained on nearly half of both concepts as a result --
  // exactly the two lowest agreement rates of all 15 concepts. The gloss is real and useful, so it
  // moves to `does_not_claim`; the tested `definition` states only the field/value check, matching
  // EP-0001/EP-0002's shape, which held 100% agreement.
  { code: 'EP-0006', stable_key: 'partially-realized-claim', preferred_label: 'Partially realized claim',
    definition: 'A claim whose adjudication receipt records realization as partial.',
    does_not_claim: 'that the capability is complete or has been exercised: partial means a declaration was found but the behavior was not shown to be exercised',
    expression: fieldEq('realization', 'partial') },
  { code: 'EP-0007', stable_key: 'unknown-realization-claim', preferred_label: 'Unknown-realization claim',
    definition: 'A claim whose adjudication receipt records realization as unknown.',
    does_not_claim: 'that the claim is false, only that realization could not be established from the currently complete inventories',
    expression: fieldEq('realization', 'unknown') },
]);

function sealConceptVersion(def, { scope, schemeId, eligibleSourcePlanes, eligibleNodeKinds, conceptKind, negativeSemantics, policyDigest }) {
  validateExpression(def.expression);
  const body = {
    schema: CONCEPT_VERSION_SCHEMA,
    concept_id: conceptId(scope, def.code),
    scheme_id: schemeId,
    stable_key: def.stable_key,
    preferred_label: def.preferred_label,
    alternate_labels: [],
    definition: def.definition,
    does_not_claim: def.does_not_claim,
    concept_kind: conceptKind,
    scope: { eligible_source_planes: eligibleSourcePlanes, eligible_node_kinds: eligibleNodeKinds,
      evidence_context_policy: 'one_exact_projection' },
    membership_rule: { language: PATTERN_SCHEMA, expression: def.expression, negative_semantics: negativeSemantics },
    cardinality: MANY_TO_MANY_CARDINALITY,
    // No acceptance authority exists yet (design v2 open decision (d)); a concept minted here is
    // `proposed`, never `accepted`, until the operator names one. See the Phase 1 report.
    acceptance: { decision_id: null, policy_digest: policyDigest },
    supersedes_version_id: null,
    status: 'proposed',
  };
  return Object.freeze({ ...body, concept_version_id: `ontology-concept-version:${sha256(canonical(body))}` });
}

/**
 * Seal the whole Phase 1 catalog. `scope` defaults to the global `ascrybe` scope as a DOCUMENTED
 * DEFAULT for open decision (a) ("concept accessions global to Ascrybe or per estate") -- the
 * design explicitly says the rest of Phase 1 is unchanged under either answer, so this default
 * does not block anything and should be revisited once the operator decides.
 */
export function buildPhase1Concepts({ policyDigest, scope = 'ascrybe' }) {
  if (typeof policyDigest !== 'string' || !policyDigest) fail('CONCEPT_VERSION_INPUT_INVALID', 'sealing the Phase 1 catalog requires a policy digest');
  const roles = ARCHITECTURAL_ROLE_DEFS.map(def => sealConceptVersion(def, {
    scope, schemeId: SCHEME_IDS.architectural_role, eligibleSourcePlanes: ['entity'],
    eligibleNodeKinds: def.eligibleNodeKinds ?? ROLE_ELIGIBLE_KINDS, conceptKind: 'architectural-role',
    negativeSemantics: 'open_world_abstain', policyDigest }));
  const standing = EPISTEMIC_STANDING_DEFS.map(def => sealConceptVersion(def, {
    scope, schemeId: SCHEME_IDS.epistemic_standing, eligibleSourcePlanes: ['documentary'],
    eligibleNodeKinds: ['Claim'], conceptKind: 'epistemic-standing',
    negativeSemantics: 'closed_world_not_member', policyDigest }));
  return Object.freeze([...roles, ...standing]);
}

export function validateConceptVersion(record) {
  if (record?.schema !== CONCEPT_VERSION_SCHEMA) fail('CONCEPT_VERSION_INVALID', 'concept version schema mismatch');
  parseConceptId(record.concept_id);
  if (!record.scheme_id || !record.stable_key || !record.definition) {
    fail('CONCEPT_VERSION_INVALID', `${record.concept_id} is missing required descriptive fields`);
  }
  if (!Array.isArray(record.scope?.eligible_node_kinds) || !record.scope.eligible_node_kinds.length) {
    fail('CONCEPT_VERSION_INVALID', `${record.concept_id} scope must name at least one eligible node kind`);
  }
  validateExpression(record.membership_rule?.expression);
  if (record.membership_rule?.language !== PATTERN_SCHEMA) {
    fail('CONCEPT_VERSION_INVALID', `${record.concept_id} membership_rule.language must be ${PATTERN_SCHEMA}`);
  }
  if (!['open_world_abstain', 'closed_world_not_member'].includes(record.membership_rule?.negative_semantics)) {
    fail('CONCEPT_VERSION_INVALID', `${record.concept_id} negative_semantics is not recognized`);
  }
  if (!digestMatches(record, 'concept_version_id', 'ontology-concept-version')) {
    fail('CONCEPT_VERSION_DIGEST_MISMATCH', `${record.concept_id} version id does not match its canonical body`);
  }
}

/** Every relation named by any edge_exists/fact_kind_present leaf across `concepts` -- used to
 * bound the adjacency a real run has to index instead of loading every relation in the projection. */
export function referencedRelations(concepts) {
  const relations = new Set();
  const walk = expr => {
    const [kind] = Object.keys(expr);
    if (kind === 'edge_exists') relations.add(expr.edge_exists.relation);
    else if (kind === 'fact_kind_present') relations.add('contains');
    else if (kind === 'and' || kind === 'or') expr[kind].forEach(walk);
    else if (kind === 'not') walk(expr.not);
  };
  for (const concept of concepts) walk(concept.membership_rule.expression);
  return relations;
}
