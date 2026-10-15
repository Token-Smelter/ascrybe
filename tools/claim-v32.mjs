// Documentary claim v3.2 — exact quote locators with tool-derived coordinates.
//
// Proposition identity deliberately excludes claim-specific mention occurrence IDs and evidence.
// Every subject is keyed by normalized surface + source document. Canonical refs are projection-time
// concept links only; they never mutate extraction identity or collapse source occurrences.
import { sha256, stableStringify } from './lib.mjs';
import { resolveSourceLocator, locatorToSpan, SourceLocatorError } from './source-locator.mjs';

export const CLAIM_V32_SCHEMA = 'estate-map/documentary-claim/v3.2';
export const RESOLUTION_STATUSES_V32 = Object.freeze(['canonical', 'local', 'ambiguous', 'unresolved']);
export const SUPPORT_MODES_V32 = Object.freeze(['all_required', 'alternative_support']);
export const CLAIM_MODALITIES_V32 = Object.freeze(['descriptive', 'normative', 'historical', 'constitutive', 'predictive']);
export const CLAIM_POLARITIES_V32 = Object.freeze(['affirmed', 'negated']);
export const SUBJECT_BINDINGS_V32 = Object.freeze(['explicit', 'anaphoric', 'implicit_topic', 'unresolved']);
export const RELATION_FAMILIES_V32 = Object.freeze([
  'identity', 'classification', 'definition', 'composition', 'dependency', 'causation',
  'constraint', 'permission', 'prohibition', 'requirement', 'capability', 'configuration',
  'precedence', 'lifecycle', 'measurement', 'other',
]);

const CANONICAL_REF = /^(?:component|protocol|schema|state|command|record|concept|entity):[a-z0-9][a-z0-9._/-]*$/;
const canonical = value => stableStringify(value).trim();
const text = value => String(value ?? '');
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const normalizedSurface = value => text(value).trim().toLocaleLowerCase();
const orderSpan = (a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end || a.role.localeCompare(b.role);

export class ClaimV32Error extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimV32Error';
    this.code = code;
    this.detail = detail;
  }
}

const rawLocator = value => value?.source_locator || value?.locator || value || null;

export function countProposedLocators(proposed) {
  // Count every explicit locator field before shape validation. A model that emits a legacy string
  // locator still proposed a locator; reporting zero would hide the addressing failure measured by
  // calibration. Do not recurse into a locator value, or a valid locator object would double-count.
  let count = 0;
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'source_locator' || key === 'locator') { count += 1; continue; }
      visit(child);
    }
  };
  visit(proposed);
  return count;
}

function propositionIdentity(subject) {
  return {
    kind: 'document_surface',
    file: subject.identity_file || subject.span.file,
    surface: normalizedSurface(subject.identity_surface || subject.surface),
  };
}

// Strip inline emphasis/code markers and collapse whitespace so containment compares what a reader
// sees. This never widens WHICH span is cited; it only compares the same bytes more faithfully.
export const markupNormalized = value => String(value ?? '')
  // Zero-width and BOM characters are invisible in source and get dropped when a model retypes a
  // token (observed: "REL\u200b\u200bIABILITY.22"). They must not decide grounding.
  .replace(/[\u200b-\u200d\ufeff]/g, '')
  // Remove paired Markdown delimiters and boundary emphasis markers, but never erase punctuation
  // embedded inside an identifier. `A_B` and `AB` must remain distinct grounding surfaces.
  .replace(/`([^`\n]+)`/g, '$1')
  .replace(/\*\*([^*\n]+)\*\*/g, '$1')
  .replace(/__([^_\n]+)__/g, '$1')
  .replace(/~~([^~\n]+)~~/g, '$1')
  .replace(/(^|[\s([{])([*_~])(?=\S)/g, '$1')
  .replace(/([*_~])(?=$|[\s.,;:!?)}\]])/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

export function buildClaimV32({ proposed, window, catalog, namespace = null, model_identifier, prompt_digest }) {
  const locatorStats = { proposed: countProposedLocators(proposed), resolved: 0 };
  const fail = (code, message, detail = {}) => {
    throw new ClaimV32Error(code, message, { ...detail, locator_stats: { ...locatorStats, failed: Math.max(0, locatorStats.proposed - locatorStats.resolved) } });
  };
  const resolve = (locator, expectedRole = null) => {
    try {
      const value = resolveSourceLocator({ locator: rawLocator(locator), catalog, expected_role: expectedRole });
      locatorStats.resolved += 1;
      return value;
    } catch (error) {
      if (error instanceof SourceLocatorError) fail(error.code, error.message, error.detail);
      throw error;
    }
  };

  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) fail('INVALID_CLAIM', 'claim must be an object');
  const modality = text(proposed.modality).trim();
  const polarity = text(proposed.polarity).trim();
  const subjectBinding = text(proposed.subject_binding).trim() || 'explicit';
  const relationFamily = text(proposed.relation_family).trim() || 'other';
  if (!SUBJECT_BINDINGS_V32.includes(subjectBinding)) fail('INVALID_SUBJECT_BINDING', subjectBinding);

  const mention = proposed.subject_mention || {};
  const surface = text(mention.surface).trim();
  if (!surface) fail('MISSING_SUBJECT_SURFACE', 'subject_mention.surface is required');
  if (!mention.source_locator && !mention.locator) fail('MISSING_SUBJECT_LOCATOR', 'subject_mention.source_locator is required');
  const resolvedSubject = resolve(mention.source_locator || mention.locator);
  let resolvedAntecedent = null;
  if (subjectBinding === 'anaphoric') {
    if (!mention.antecedent_locator) fail('MISSING_ANTECEDENT_LOCATOR', 'anaphoric subjects require an exact antecedent locator');
    resolvedAntecedent = resolve(mention.antecedent_locator);
  }
  // Compare INLINE-MARKUP-NORMALIZED text. Source carries Markdown emphasis the rendered sentence
  // does not: a model quoting `There is **one** function ...` naturally writes the subject as
  // `one function ...`. Rejecting that is a formatting artifact, not a grounding failure — the
  // subject genuinely occurs in the cited span. Stored evidence remains the exact source bytes.
  const containmentSource = resolvedAntecedent?.text || resolvedSubject.text;
  if (!markupNormalized(containmentSource).includes(markupNormalized(surface))) {
    fail('SUBJECT_SURFACE_NOT_IN_QUOTE', 'subject surface is not present in resolved subject quote', {
      surface, quote: containmentSource, locator_id: (resolvedAntecedent || resolvedSubject).id,
    });
  }
  const subjectSpan = { file: resolvedSubject.file, start: resolvedSubject.start, end: resolvedSubject.end };
  const identitySpan = resolvedAntecedent
    ? { file: resolvedAntecedent.file, start: resolvedAntecedent.start, end: resolvedAntecedent.end }
    : subjectSpan;
  const declaredRef = text(proposed.canonical_ref).trim().toLowerCase();
  const canonicalTail = declaredRef.split(':').slice(1).join(':');
  const identityForm = value => normalizedSurface(value).replace(/[^a-z0-9]+/g, '');
  // A well-formed string alone is not identity evidence. The source-addressed surface must name the
  // canonical tail; otherwise retain the proposal only as a candidate and keep the claim local.
  const canonicalRef = subjectBinding !== 'unresolved' && declaredRef && CANONICAL_REF.test(declaredRef)
    && identityForm(canonicalTail) === identityForm(surface) ? declaredRef : null;
  const canonicalBasis = canonicalRef ? 'exact_source_surface_matches_canonical_tail' : null;
  const localHits = namespace?.lookup ? namespace.lookup(surface).filter(hit =>
    hit.file === identitySpan.file && hit.lines.some(line => line >= identitySpan.start && line <= identitySpan.end)) : [];
  const namespaceMentionId = localHits.length === 1 ? localHits[0].id : null;
  const resolutionStatus = subjectBinding === 'unresolved' ? 'unresolved'
    : canonicalRef ? 'canonical' : (localHits.length > 1 ? 'ambiguous' : 'local');
  const literalSurface = resolvedSubject.text;
  const sourceMentionKey = `source-mention-key:${sha256(canonical({ file: subjectSpan.file, surface: normalizedSurface(literalSurface) }))}`;
  const subject = {
    surface,
    literal_surface: literalSurface,
    identity_surface: surface,
    identity_file: identitySpan.file,
    span: subjectSpan,
    source_locator: resolvedSubject,
    binding: {
      kind: subjectBinding,
      subject_occurrence_id: proposed.subject_occurrence_id || null,
      antecedent_locator: resolvedAntecedent,
    },
    source_mention_key: sourceMentionKey,
    namespace_mention_id: namespaceMentionId,
    canonical_ref: canonicalRef,
    canonical_basis: canonicalBasis,
    rejected_canonical_ref: declaredRef && !canonicalRef ? declaredRef : null,
    resolution_status: resolutionStatus,
    candidate_refs: [...new Set([
      ...(Array.isArray(proposed.candidate_refs) ? proposed.candidate_refs : []),
      ...(declaredRef && !canonicalRef ? [declaredRef] : []),
    ].map(value => text(value).trim().toLowerCase()).filter(Boolean))].sort(),
    anchored: true,
  };

  const rawSets = Array.isArray(proposed.support_sets) ? proposed.support_sets : [];
  if (!rawSets.length) fail('EMPTY_SUPPORT_SETS', 'support_sets must contain at least one set');
  const supportSets = rawSets.map((set, setIndex) => {
    const mode = text(set.mode).trim() || 'all_required';
    if (!SUPPORT_MODES_V32.includes(mode)) fail('INVALID_SUPPORT_MODE', mode, { set_index: setIndex });
    const items = Array.isArray(set.locators) ? set.locators : [];
    if (!items.length) fail('EMPTY_SUPPORT_SET', `support_sets[${setIndex}] has no locators`, { set_index: setIndex });
    const resolved = items.map((item, locatorIndex) => {
      const role = text(item.role).trim() || 'primary';
      if (!['primary', 'context'].includes(role)) fail('INVALID_LOCATOR_ROLE', role, { set_index: setIndex, locator_index: locatorIndex });
      return { role, locator: resolve(item.source_locator || item.locator, role) };
    });
    if (!resolved.some(item => item.role === 'primary')) fail('MISSING_PRIMARY_LOCATOR', `support_sets[${setIndex}] has no primary locator`, { set_index: setIndex });
    const locators = resolved.map(item => ({ role: item.role, ...item.locator })).sort((a, b) =>
      a.file.localeCompare(b.file) || a.byte_start - b.byte_start || a.byte_end - b.byte_end || a.role.localeCompare(b.role));
    const spans = locators.map(item => locatorToSpan(item, item.role)).sort(orderSpan);
    const excerpts = locators.map(item => ({ ...locatorToSpan(item, item.role), text: item.text, text_digest: item.text_digest }));
    return { mode, locators, spans, excerpts };
  });

  // Resolve every proposed locator before checking non-address semantic fields. This keeps the
  // proposed-vs-resolved locator metric honest even when a sibling field is malformed.
  if (!CLAIM_MODALITIES_V32.includes(modality)) fail('INVALID_MODALITY', modality);
  if (!CLAIM_POLARITIES_V32.includes(polarity)) fail('INVALID_POLARITY', polarity);
  if (!RELATION_FAMILIES_V32.includes(relationFamily)) fail('INVALID_RELATION_FAMILY', relationFamily);
  if (!nonblank(proposed.predicate_family)) fail('MISSING_PREDICATE', 'predicate_family is required');
  if (!Object.hasOwn(proposed, 'object_or_value')) fail('MISSING_OBJECT', 'object_or_value is required');

  const irreducibleMultiSpan = supportSets.some(set => set.mode === 'all_required' && set.locators.filter(item => item.role === 'primary').length > 1);
  const semantic = {
    subject,
    relation_family: relationFamily,
    predicate_family: text(proposed.predicate_family).trim(),
    object_or_value: proposed.object_or_value,
    polarity,
    modality,
    quantifier: text(proposed.quantifier).trim() || 'unspecified',
    scope: proposed.scope && typeof proposed.scope === 'object' && !Array.isArray(proposed.scope) ? proposed.scope : {},
    valid_time: proposed.valid_time && typeof proposed.valid_time === 'object' && !Array.isArray(proposed.valid_time) ? proposed.valid_time : {},
    support_sets: supportSets,
    irreducible_multi_span: irreducibleMultiSpan,
    provenance: {
      unit_id: window.id ?? null,
      source_sha: window.snapshot?.source_sha ?? null,
      corpus_digest: window.snapshot?.corpus_digest ?? null,
    },
  };
  const proposition_key = sha256(canonical({
    subject: propositionIdentity(subject),
    relation_family: semantic.relation_family,
    predicate_family: semantic.predicate_family,
    object_or_value: semantic.object_or_value,
    polarity,
    modality,
    quantifier: semantic.quantifier,
    scope: semantic.scope,
    valid_time: semantic.valid_time,
  }));
  const evidence_key = sha256(canonical(supportSets.map(set => ({
    mode: set.mode,
    locators: set.locators.map(item => ({ role: item.role, id: item.id })),
  }))));
  const record = {
    schema: CLAIM_V32_SCHEMA,
    semantic,
    proposition_key,
    evidence_key,
    locator_stats: Object.freeze({ ...locatorStats, failed: 0 }),
    extraction: { model_identifier, prompt_digest, unit_id: window.id ?? null },
  };
  return Object.freeze({ ...record, id: `claim-v32:${sha256(canonical({ proposition_key, evidence_key }))}` });
}

export function reduceClaimsV32(claims = []) {
  const groups = new Map();
  for (const claim of claims) {
    const group = groups.get(claim.proposition_key) || { claims: [], sets: new Map(), provenance: new Map() };
    group.claims.push(claim);
    for (const set of claim.semantic.support_sets) {
      const signature = canonical({ mode: set.mode, locators: set.locators.map(item => ({ role: item.role, id: item.id })) });
      group.sets.set(signature, set);
    }
    const provenance = { claim_id: claim.id, ...claim.extraction };
    group.provenance.set(canonical(provenance), provenance);
    groups.set(claim.proposition_key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([propositionKey, group]) => {
    const seed = group.claims.slice().sort((a, b) => a.id.localeCompare(b.id) || canonical(a).localeCompare(canonical(b)))[0];
    const supportSets = [...group.sets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, set]) => set);
    const evidenceKey = sha256(canonical(supportSets.map(set => ({
      mode: set.mode,
      locators: set.locators.map(item => ({ role: item.role, id: item.id })),
    }))));
    const semantic = {
      ...seed.semantic,
      support_sets: supportSets,
      irreducible_multi_span: supportSets.some(set => set.mode === 'all_required' && set.locators.filter(item => item.role === 'primary').length > 1),
    };
    const extractionProvenance = [...group.provenance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    const locatorStats = group.claims.reduce((sum, claim) => ({ proposed: sum.proposed + claim.locator_stats.proposed, resolved: sum.resolved + claim.locator_stats.resolved, failed: 0 }), { proposed: 0, resolved: 0, failed: 0 });
    return Object.freeze({
      ...seed,
      id: `claim-v32:${sha256(canonical({ proposition_key: propositionKey, evidence_key: evidenceKey }))}`,
      semantic,
      proposition_key: propositionKey,
      evidence_key: evidenceKey,
      locator_stats: locatorStats,
      extraction_provenance: extractionProvenance,
    });
  });
}

export function claimQualityMetricsV32(claims = []) {
  const byStatus = {}, byBinding = {}, byRelationFamily = {};
  let irreducible = 0;
  for (const claim of claims) {
    const status = claim.semantic.subject.resolution_status;
    byStatus[status] = (byStatus[status] || 0) + 1;
    const binding = claim.semantic.subject.binding?.kind || 'explicit';
    byBinding[binding] = (byBinding[binding] || 0) + 1;
    const family = claim.semantic.relation_family || 'other';
    byRelationFamily[family] = (byRelationFamily[family] || 0) + 1;
    if (claim.semantic.irreducible_multi_span) irreducible += 1;
  }
  return Object.freeze({
    claims: claims.length,
    by_resolution_status: byStatus,
    by_subject_binding: byBinding,
    by_relation_family: byRelationFamily,
    unanchored_subjects: 0,
    unanchored_rate: 0,
    canonical_eligible_unresolved: claims.filter(claim => claim.semantic.subject.candidate_refs.length && !claim.semantic.subject.canonical_ref).length,
    irreducible_multi_span_claims: irreducible,
  });
}
