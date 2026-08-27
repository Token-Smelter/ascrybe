// Relation roles and node planes: the one schema-level judgment every view derives from.
//
// Every edge in the serving projection plays one of three roles. A structural edge composes the
// estate (a commit contains a document, a module declares a symbol, a plugin provides a
// capability) and has a parent end. A flow edge joins peers at the same tier (a module imports a
// module, a plugin requires a capability another plugin provides). An annotation edge joins an
// entity to the evidence, documentary, or adjudication plane that speaks about it. Overview,
// drill-down, ranking, provenance, and consumer views are all filters over these roles; none may
// carry its own relation list, because five lists drift and one registry is disclosed on every
// projection.
//
// Roles are a property of the relation, never of depth, so a drill-down at any tier is the same
// operation: structural children as nodes, flow edges to peers, annotation edges bundled by
// relation and kind. A relation absent here is `unclassified`: it is projected and queryable but
// contributes to no structural count, and the projection body names it so the omission is visible.

export const RELATION_ROLES = Object.freeze(['structural', 'flow', 'annotation']);
export const UNCLASSIFIED = 'unclassified';

// parent names which end of the edge is the container: 'from' for parent→child edges such as
// contains, 'to' for child→parent edges such as member_of and observed_in.
const structural = parent => Object.freeze({ role: 'structural', parent });
const flow = Object.freeze({ role: 'flow' });
const annotation = Object.freeze({ role: 'annotation' });

export const RELATION_REGISTRY = Object.freeze({
  // Composition: the estate, what it declares, and what those declarations declare.
  has_source_commit: structural('from'),
  contains: structural('from'),
  declares_symbol: structural('from'),
  declares_table: structural('from'),
  declares_sql_object: structural('from'),
  declares_resource: structural('from'),
  declares_service: structural('from'),
  declares_config: structural('from'),
  declares_dependency: structural('from'),
  registers_route: structural('from'),
  exposes_route: structural('from'),
  provides_capability: structural('from'),
  publishes_envelope: structural('from'),
  member_of: structural('to'),
  observed_in: structural('to'),

  // Flow: dependency and message traffic between peers.
  imports: flow,
  imports_framework: flow,
  depends_on: flow,
  consumes_package: flow,
  calls_capability: flow,
  requires_capability: flow,
  subscribes_envelope: flow,
  emits: flow,
  consumes: flow,
  publishes_to: flow,
  uses_infra: flow,
  tf_ref: flow,
  references: flow,
  covers: flow,

  // Annotation: the documentary, evidence, identity, and adjudication planes speaking about entities.
  documented_in: annotation,
  // An assertion belongs to the document that made it and the fact it was read from; neither is
  // a structural composition of the estate.
  asserted_in: annotation,
  read_from: annotation,
  relates_assertion: annotation,
  about: annotation,
  identifies: annotation,
  realized_by: annotation,
  supported_by: annotation,
  unresolved_against: annotation,
  derived_from: annotation,
  adjudicated_by: annotation,
  has_obligation_result: annotation,
  evidenced_by: annotation,
  justified_by: annotation,
  contradicted_by: annotation,
  refines: annotation,
  superseded_by: annotation,
});

export const NODE_PLANES = Object.freeze(['entity', 'observation', 'documentary', 'adjudication']);

// The plane says what kind of thing a node is, independent of how it is connected. An entity is
// something the estate declares or is; an observation is an exact extracted fact about source;
// documentary nodes are prose and the claims parsed from it; adjudication nodes are the receipts
// and evidence that judge claims.
export const NODE_PLANE_REGISTRY = Object.freeze({
  Project: 'entity',
  SourceCommit: 'entity',
  Repository: 'entity',
  Package: 'entity',
  Plugin: 'entity',
  Capability: 'entity',
  Envelope: 'entity',
  Module: 'entity',
  Symbol: 'entity',
  Route: 'entity',
  Table: 'entity',
  Infrastructure: 'entity',
  SchemaRecord: 'entity',
  DeclaredDocument: 'entity',
  Referent: 'entity',

  CodeFact: 'observation',
  CatalogEntry: 'observation',
  ToolRegistration: 'observation',
  DeclarationComment: 'observation',
  EmptyDeclaration: 'observation',
  ExtractionRefusal: 'observation',

  Document: 'documentary',
  Claim: 'documentary',
  Diagram: 'documentary',
  DiagramRelation: 'documentary',
  DocumentSection: 'documentary',
  Assertion: 'documentary',

  Evidence: 'adjudication',
  ObligationResult: 'adjudication',
  AdjudicationReceipt: 'adjudication',
  SupersessionReceipt: 'adjudication',
});

export function relationRole(relation) {
  return RELATION_REGISTRY[relation]?.role ?? UNCLASSIFIED;
}

/** For a structural edge, the [parent, child] node IDs; null for any other role. */
export function structuralEndpoints(edge) {
  const entry = RELATION_REGISTRY[edge.relation];
  if (entry?.role !== 'structural') return null;
  return entry.parent === 'from' ? [edge.from, edge.to] : [edge.to, edge.from];
}

export function nodePlane(kind) {
  return NODE_PLANE_REGISTRY[kind] ?? UNCLASSIFIED;
}
