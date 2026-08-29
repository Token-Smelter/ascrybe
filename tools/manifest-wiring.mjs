// MANIFEST DECLARATIONS LINKED TO WIRING REALITY.
//
// WHY THIS EXISTS (instrument defect K3, acceptance-test-round2.md §5.1). The
// map already carried manifest DECLARATIONS. It could not say whether any of
// them was actually WIRED. Two round-2 findings live in exactly that gap:
//
//   D13 (the round's ONLY map-unique find) — `subscribes_envelopes` is a
//     declaration, not a handler binding: `validateEnvelopeEntries` checks
//     `kind` / `version` / `subscriber_id` and never imports a handler
//     (src/runtime/plugin-context.mjs:71-93). The real subscription API is
//     `context.envelopes.subscribe`.
//   N1 (HIGH, found by NEITHER arm) — `requires_capabilities` entries carry
//     `optional: true` (plugins/task-goals/plugin.yaml:82-91) and the
//     consuming wrappers swallow the absence into a `null`
//     (plugins/task-goals/server/index.mjs:176-178,:180-187), so an absent
//     provider is indistinguishable from an empty answer.
//
// Both are the SAME shape one level up: a declaration is a promise, and the
// map showed the promise without the delivery. This module emits, for every
// manifest declaration the extractors see, a wiring-status assessment:
//
//   wired             — a real binding site was found in the DECLARING plugin's
//                       own code, and its file:line is carried.
//   declared_unwired  — the declaring plugin was searched exhaustively for the
//                       binding idiom and none matched. Recorded refusal-style:
//                       `examined` names what was searched and over what.
//   undeterminable    — a binding site exists but is not groundable (a
//                       non-literal capability type, a wildcard subscription
//                       that names no single handler), so neither answer is
//                       honest. Never silently counted as wired.
//
// SCOPE, STATED HONESTLY. "Wired" here means the declaring plugin contains the
// binding idiom for that subject. It does NOT mean the handler runs, that the
// provider is present at run time, or that a null-swallowing wrapper does not
// erase the result — the `optional` and `binding` fields carry the evidence for
// that question rather than pretending to answer it. The null-guard signal is
// detected only in the single-line `try { … } catch { … null }` form this
// estate writes; a multi-line guard is reported as `unguarded`, which is a
// statement about what was SEEN, and the limitation is recorded here.
//
// DETERMINISM. A pure function of the fact stream. No model calls, no network,
// no second pass over the estate.

import { pluginDirectoryOwner } from './extractors/capabilities.mjs';

export const MANIFEST_WIRING_STATUSES = Object.freeze(['wired', 'declared_unwired', 'undeterminable']);
export const MANIFEST_WIRING_FAMILIES = Object.freeze([
  'provides_capability', 'requires_capability', 'publishes_envelope', 'subscribes_envelope', 'http_route',
]);
// Frozen vocabulary in the style of annotate.mjs#REFUSAL_REASONS: a reason is an
// enum a later process can GROUP BY, never a free-text sentence.
export const MANIFEST_WIRING_REASONS = Object.freeze([
  'no_binding_site_in_declaring_plugin',
  'wildcard_declaration_names_no_single_binding',
  'declaring_plugin_has_a_non_literal_site_of_this_kind',
  'declaring_plugin_has_a_refused_registration_site',
]);

// WHY `undeterminable` IS NOT A DODGE. The first version of this module called a
// declaration `declared_unwired` whenever no literal binding site named it. A
// grounding pass against real source found that verdict FALSE in three
// independent places, all for the same reason: the estate reaches the bus and
// the registry through paths a line-oriented reader cannot follow.
//   plugins/session-notes/server/index.mjs:607 subscribes with a `kind`
//     parameter, iterating its own manifest list — all eight of its declared
//     subscriptions really are wired;
//   plugins/task-goals/server/index.mjs:4021-4026 loops
//     `for (const kind of FAILURE_THRESHOLD_KINDS)` around a subscribe;
//   plugins/project-index/server/index.mjs:845 emits
//     `emit(created ? "bundle.created" : "bundle.updated", …)` — a ternary.
// So a plugin that contains ANY dynamic site of the same direction gets
// `undeterminable` with that site cited, never an accusation. The sharper
// signal survives separately: `subject_occurrences_in_plugin` counts every
// literal appearance of the subject in the plugin's own code, and the census's
// `undeterminable_without_any_literal_occurrence` list is the set where the
// declared subject appears NOWHERE in the declaring plugin — the strongest
// statement this instrument can make without a false positive.

const ownerOf = fact => pluginDirectoryOwner(`${fact.repo}/${fact.file}`);
const witness = fact => ({ repo: fact.repo, file: fact.file, line: fact.line });
const sortWitnesses = list => list.slice().sort((a, b) => a.repo.localeCompare(b.repo) || a.file.localeCompare(b.file) || a.line - b.line);

/**
 * The wiring assessment for every manifest declaration in the fact stream.
 * `facts` is the same array merge.mjs reads; nothing else is consulted.
 */
export function deriveManifestWiring(facts) {
  const capabilityFacts = facts.filter(fact => fact.kind === 'capability_flow');
  const capabilityRefusals = facts.filter(fact => fact.kind === 'capability_refusal');
  const envelopeFacts = facts.filter(fact => fact.kind === 'envelope_flow');
  const dynamicSites = facts.filter(fact => fact.kind === 'envelope_dynamic_site');
  const kindMentions = facts.filter(fact => fact.kind === 'envelope_kind_mention');
  const routeFacts = facts.filter(fact => fact.kind === 'http_route');
  const routeRefusals = facts.filter(fact => fact.kind === 'http_route_refusal');
  const routeDeclarations = facts.filter(fact => fact.kind === 'manifest_route_declaration');

  const records = [];
  const add = record => records.push(record);

  // ---- CAPABILITY DECLARATIONS ----------------------------------------
  // The binding idiom is the code `capabilities.provide(` / `.require(` call in
  // the declaring plugin — the substrate surface at
  // src/runtime/plugin-context.mjs:357-364. A manifest entry alone registers
  // nothing: pluginManifest.mjs shape-checks the list and never imports a
  // handler, which is D13's insight applied to the capability family.
  for (const declaration of capabilityFacts.filter(fact => fact.source === 'manifest')) {
    const owner = ownerOf(declaration);
    const family = declaration.direction === 'provide' ? 'provides_capability' : 'requires_capability';
    const bindings = capabilityFacts.filter(fact => fact.source === 'code'
      && fact.direction === declaration.direction
      && fact.capability_type === declaration.capability_type
      && fact.owner === owner);
    const nonLiteral = capabilityRefusals.filter(fact => fact.direction === declaration.direction
      && fact.reason === 'capability_type_argument_not_literal'
      && ownerOf(fact) === owner);
    const occurrences = capabilityFacts.filter(fact => fact.source === 'code'
      && fact.capability_type === declaration.capability_type && fact.owner === owner);
    const examined = [
      { relation: 'binding_idiom', target: `capabilities.${declaration.direction}("${declaration.capability_type}", …)`, value: `${bindings.length} site(s) in plugin '${owner}'` },
      { relation: 'searched_over', target: `plugins/${owner}/**`, value: `${capabilityFacts.filter(fact => fact.source === 'code' && fact.owner === owner).length} literal capability site(s), ${nonLiteral.length} non-literal site(s)` },
    ];
    add({
      id: `wiring:${owner}:${family}:${declaration.capability_type}`,
      declaration_family: family,
      manifest_key: declaration.manifest_key,
      owner,
      subject: declaration.capability_type,
      declared_version: declaration.version || null,
      optional: Boolean(declaration.optional),
      binding: bindings.map(fact => fact.binding).find(value => value) || null,
      wiring_status: bindings.length ? 'wired' : nonLiteral.length ? 'undeterminable' : 'declared_unwired',
      reason: bindings.length ? null : nonLiteral.length ? 'declaring_plugin_has_a_non_literal_site_of_this_kind' : 'no_binding_site_in_declaring_plugin',
      reason_detail: bindings.length
        ? `plugin '${owner}' calls capabilities.${declaration.direction}("${declaration.capability_type}", …) at ${bindings.length} site(s)`
        : nonLiteral.length
          ? `plugin '${owner}' has ${nonLiteral.length} capabilities.${declaration.direction}( call(s) whose TYPE argument is not a string literal, so this declaration may or may not be the one they bind; neither 'wired' nor 'declared_unwired' is honest`
          : `plugin '${owner}' declares ${declaration.manifest_key} '${declaration.capability_type}' and contains no capabilities.${declaration.direction}("${declaration.capability_type}", …) call; the manifest list is shape-checked (src/runtime/plugin-context.mjs:46) and binds no handler`,
      declaration: witness(declaration),
      wiring_witnesses: sortWitnesses(bindings.map(witness)),
      undeterminable_witnesses: sortWitnesses(nonLiteral.map(witness)),
      subject_occurrences_in_plugin: occurrences.length,
      examined,
    });
  }

  // ---- ENVELOPE DECLARATIONS ------------------------------------------
  // D13, machine-checked. The binding idiom for a SUBSCRIPTION is
  // `context.envelopes.subscribe("kind", id, handler)` — the extractor's
  // `envelopes_subscribe` idiom. `pattern_rule_on` and `envelope_kind_equality`
  // are real consume sites but they are not subscriptions, so they are carried
  // as related evidence and never promote a declaration to `wired`.
  const BINDING_IDIOM = { consume: 'envelopes_subscribe', emit: null };
  for (const declaration of envelopeFacts.filter(fact => fact.manifest_key)) {
    const owner = ownerOf(declaration);
    const family = declaration.direction === 'emit' ? 'publishes_envelope' : 'subscribes_envelope';
    const wildcard = declaration.status === 'wildcard';
    const sameKind = envelopeFacts.filter(fact => !fact.manifest_key
      && fact.direction === declaration.direction
      && fact.envelope_kind === declaration.envelope_kind
      && ownerOf(fact) === owner);
    const bindingIdiom = BINDING_IDIOM[declaration.direction];
    const bindings = bindingIdiom ? sameKind.filter(fact => fact.idiom === bindingIdiom) : sameKind;
    const related = sameKind.filter(fact => !bindings.includes(fact));
    const dynamic = dynamicSites.filter(fact => fact.direction === declaration.direction && ownerOf(fact) === owner);
    const occurrences = [
      ...envelopeFacts.filter(fact => !fact.manifest_key && fact.envelope_kind === declaration.envelope_kind && ownerOf(fact) === owner),
      ...kindMentions.filter(fact => fact.envelope_kind === declaration.envelope_kind && ownerOf(fact) === owner),
    ];
    const examined = [
      {
        relation: 'binding_idiom',
        target: bindingIdiom ? `context.envelopes.subscribe("${declaration.envelope_kind}", …)` : `an emit site naming "${declaration.envelope_kind}"`,
        value: `${bindings.length} site(s) in plugin '${owner}'`,
      },
      { relation: 'related_non_binding_sites', target: declaration.envelope_kind, value: `${related.length} site(s) (${[...new Set(related.map(fact => fact.idiom))].sort().join(', ') || 'none'})` },
      { relation: 'dynamic_bus_sites', target: `plugins/${owner}/** ${declaration.direction} with a non-literal kind`, value: `${dynamic.length} site(s)` },
      { relation: 'any_literal_occurrence', target: declaration.envelope_kind, value: `${occurrences.length} site(s) naming this kind anywhere in plugin '${owner}'` },
    ];
    add({
      id: `wiring:${owner}:${family}:${declaration.envelope_kind}`,
      declaration_family: family,
      manifest_key: declaration.manifest_key,
      owner,
      subject: declaration.envelope_kind,
      declared_version: null,
      optional: false,
      binding: null,
      wiring_status: wildcard || (!bindings.length && dynamic.length) ? 'undeterminable' : bindings.length ? 'wired' : 'declared_unwired',
      reason: bindings.length ? null
        : wildcard ? 'wildcard_declaration_names_no_single_binding'
          : dynamic.length ? 'declaring_plugin_has_a_non_literal_site_of_this_kind'
            : 'no_binding_site_in_declaring_plugin',
      reason_detail: bindings.length
        ? `plugin '${owner}' binds '${declaration.envelope_kind}' at ${bindings.length} site(s)`
        : wildcard
          ? `'${declaration.envelope_kind}' is a prefix wildcard; it names no single kind, so no single binding site can confirm or refute it`
          : dynamic.length
            ? `plugin '${owner}' has ${dynamic.length} ${declaration.direction} site(s) whose kind is not a literal (a loop over a kind list, a shorthand \`{ kind }\`, a ternary), so this declaration may be bound through one of them; neither 'wired' nor 'declared_unwired' is honest`
            : `plugin '${owner}' declares ${declaration.manifest_key} '${declaration.envelope_kind}', contains no ${bindingIdiom ? '`context.envelopes.subscribe`' : 'emit'} site for it, and has no ${declaration.direction} site with a non-literal kind that could reach it; src/runtime/plugin-context.mjs:71-93 validates kind/version/subscriber_id and never imports a handler, so the declaration alone binds nothing`,
      declaration: witness(declaration),
      wiring_witnesses: sortWitnesses(bindings.map(witness)),
      undeterminable_witnesses: sortWitnesses([...related, ...dynamic].map(witness)),
      subject_occurrences_in_plugin: occurrences.length,
      examined,
    });
  }

  // ---- HTTP ROUTE DECLARATIONS ----------------------------------------
  // The manifest's `http_routes:` block is the declaration ceiling
  // registerRoute() enforces; the real registration is `context.http.route`
  // (src/runtime/plugin-context.mjs:366-370), which the route extractor
  // already grounds to a MOUNTED path. A declaration is wired when a real
  // registration with the same method mounts at the same path.
  for (const declaration of routeDeclarations) {
    const owner = ownerOf(declaration);
    const matches = routeFacts.filter(fact => fact.owner === owner && fact.method === declaration.method && fact.route === declaration.path);
    const refused = routeRefusals.filter(fact => ownerOf(fact) === owner);
    const examined = [
      { relation: 'registration_idiom', target: `context.http.route("${declaration.method}", …) mounting ${declaration.path}`, value: `${matches.length} site(s) in plugin '${owner}'` },
      { relation: 'searched_over', target: `plugins/${owner}/**`, value: `${routeFacts.filter(fact => fact.owner === owner).length} grounded registration(s), ${refused.length} refused site(s)` },
    ];
    add({
      id: `wiring:${owner}:http_route:${declaration.method} ${declaration.path}`,
      declaration_family: 'http_route',
      manifest_key: 'http_routes',
      owner,
      subject: `${declaration.method} ${declaration.path}`,
      declared_version: null,
      optional: false,
      binding: declaration.auth ? `auth:${declaration.auth}` : null,
      wiring_status: matches.length ? 'wired' : refused.length ? 'undeterminable' : 'declared_unwired',
      reason: matches.length ? null : refused.length ? 'declaring_plugin_has_a_refused_registration_site' : 'no_binding_site_in_declaring_plugin',
      reason_detail: matches.length
        ? `plugin '${owner}' registers ${declaration.method} ${declaration.path} at ${matches.length} site(s)`
        : refused.length
          ? `plugin '${owner}' has ${refused.length} \`context.http.route(\` site(s) the extractor could not ground, so this declaration may be one of them`
          : `plugin '${owner}' declares http_routes '${declaration.method} ${declaration.path}' and registers no route mounting that exact path`,
      declaration: witness(declaration),
      wiring_witnesses: sortWitnesses(matches.map(witness)),
      undeterminable_witnesses: sortWitnesses(refused.map(witness)),
      subject_occurrences_in_plugin: routeFacts.filter(fact => fact.owner === owner && fact.route === declaration.path).length,
      examined,
    });
  }

  records.sort((a, b) => a.id.localeCompare(b.id));
  return records;
}

const countBy = values => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
};

/** Derived counts a reader can check without re-deriving the assessment. */
export function manifestWiringCensus(records) {
  const byStatus = status => records.filter(record => record.wiring_status === status);
  return {
    declarations: records.length,
    by_status: Object.fromEntries(MANIFEST_WIRING_STATUSES.map(status => [status, byStatus(status).length])),
    by_family: countBy(records.map(record => record.declaration_family)),
    by_reason: countBy(records.filter(record => record.reason).map(record => record.reason)),
    declared_unwired: byStatus('declared_unwired').map(record => record.id),
    // The sharpest statement this instrument can make WITHOUT a false positive:
    // the declaring plugin reaches the bus/registry through a path this reader
    // cannot follow, AND the declared subject appears nowhere in that plugin's
    // own code. `workflow-engine` / `brew.awaiting_human_verdict` is the case this
    // list was built to surface — its own manifest comment at
    // plugins/workflow-engine/plugin.yaml:106 says "emit site pending".
    undeterminable_without_any_literal_occurrence: byStatus('undeterminable')
      .filter(record => !record.subject_occurrences_in_plugin).map(record => record.id),
    // N1's exact shape, surfaced as data: an OPTIONAL requirement whose binding
    // site swallows the provider's absence into an indistinguishable null.
    optional_requirements: records.filter(record => record.declaration_family === 'requires_capability' && record.optional).length,
    optional_requirements_with_null_swallowing_binding: records
      .filter(record => record.declaration_family === 'requires_capability' && record.optional && record.binding === 'try_catch_null')
      .map(record => record.id),
    limitations: [
      "wired means the declaring plugin contains the binding idiom for that subject; it does not mean the handler runs or that the provider is present at run time",
      "the null-swallowing binding signal is detected only in the single-line `try { … } catch { … null }` form; a multi-line guard is reported as 'unguarded'",
    ],
  };
}
