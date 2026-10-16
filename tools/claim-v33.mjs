// Documentary claim v3.3 — lossless authored metadata plus two proposition identities.
//
// v3.2 remains byte-frozen for historical replay. v3.3 narrows deterministic repair to fields that
// are not allowed to destroy an otherwise grounded proposition: relation-family classification is
// normalized to `other`, while an unknown semantic modality is retained as `unresolved` and is not
// eligible for normative projection.
import { buildClaimV32, claimQualityMetricsV32 } from './claim-v32.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const CLAIM_V33_SCHEMA = 'estate-map/documentary-claim/v3.3';
export const CLAIM_MODALITIES_V33 = Object.freeze([
  'descriptive', 'normative', 'historical', 'constitutive', 'predictive', 'unresolved',
]);
export const RELATION_FAMILIES_V33 = Object.freeze([
  'identity', 'classification', 'definition', 'composition', 'dependency', 'causation',
  'constraint', 'permission', 'prohibition', 'requirement', 'capability', 'configuration',
  'precedence', 'lifecycle', 'measurement', 'other',
]);

const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const normalizedSurface = value => clean(value).toLocaleLowerCase();

function propositionIdentity(subject) {
  return {
    kind: 'document_surface',
    file: subject.identity_file || subject.span.file,
    surface: normalizedSurface(subject.identity_surface || subject.surface),
  };
}

function identityBody(semantic, { includeRelationFamily }) {
  return {
    subject: propositionIdentity(semantic.subject),
    ...(includeRelationFamily ? { relation_family: semantic.relation_family } : {}),
    predicate_family: semantic.predicate_family,
    object_or_value: semantic.object_or_value,
    polarity: semantic.polarity,
    modality: semantic.modality,
    quantifier: semantic.quantifier,
    scope: semantic.scope,
    valid_time: semantic.valid_time,
  };
}

function uniqueFindings(findings = []) {
  return [...new Map(findings.filter(Boolean).map(row => [canonical(row), Object.freeze(row)])).values()]
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

export function buildClaimV33({
  proposed, window, catalog, namespace = null, model_identifier, prompt_digest,
  repair_findings = [], subject_resolution = null,
}) {
  const authoredFamily = clean(proposed?.relation_family) || 'other';
  const relationFamily = RELATION_FAMILIES_V33.includes(authoredFamily) ? authoredFamily : 'other';
  const authoredModality = clean(proposed?.modality);
  const modality = CLAIM_MODALITIES_V33.includes(authoredModality) ? authoredModality : 'unresolved';
  const findings = [...repair_findings];
  if (relationFamily !== authoredFamily) findings.push({
    code: 'UNKNOWN_RELATION_FAMILY_NORMALIZED',
    authored_relation_family: authoredFamily,
    normalized_relation_family: relationFamily,
  });
  if (modality === 'unresolved' && authoredModality !== 'unresolved') findings.push({
    code: 'UNKNOWN_MODALITY_PRESERVED_UNRESOLVED',
    authored_modality: authoredModality,
    normalized_modality: 'unresolved',
  });

  // v3.2 performs the unchanged exact-locator, subject-containment, polarity, and support-set
  // validation. A temporary descriptive modality is used only to pass its closed vocabulary; the
  // v3.3 record is immediately re-keyed with `unresolved` and never exposed as descriptive.
  const base = buildClaimV32({
    proposed: {
      ...proposed,
      relation_family: relationFamily,
      modality: modality === 'unresolved' ? 'descriptive' : modality,
    },
    window, catalog, namespace, model_identifier, prompt_digest,
  });
  const subject = Object.freeze({
    ...base.semantic.subject,
    authored_surface: subject_resolution?.authored_surface ?? base.semantic.subject.surface,
    resolved_surface: subject_resolution?.resolved_surface ?? base.semantic.subject.surface,
    anchor_surface: subject_resolution?.anchor_surface ?? null,
    anchor_kind: subject_resolution?.anchor_kind ?? null,
  });
  const semantic = Object.freeze({
    ...base.semantic,
    subject,
    relation_family: relationFamily,
    authored_relation_family: authoredFamily,
    modality,
    authored_modality: authoredModality,
    modality_resolution: modality === 'unresolved' ? 'unresolved' : 'exact',
    projection_eligible: modality !== 'unresolved',
  });
  const legacyPropositionKey = sha256(canonical(identityBody(semantic, { includeRelationFamily: true })));
  const corePropositionKey = sha256(canonical(identityBody(semantic, { includeRelationFamily: false })));
  const normalizedFindings = uniqueFindings(findings);
  const body = {
    schema: CLAIM_V33_SCHEMA,
    semantic,
    proposition_key: legacyPropositionKey,
    legacy_proposition_key: legacyPropositionKey,
    core_proposition_key: corePropositionKey,
    evidence_key: base.evidence_key,
    locator_stats: base.locator_stats,
    repair_findings: normalizedFindings,
    extraction: base.extraction,
  };
  return Object.freeze({
    ...body,
    id: `claim-v33:${sha256(canonical({
      proposition_key: legacyPropositionKey,
      evidence_key: base.evidence_key,
      repair_findings: normalizedFindings,
    }))}`,
  });
}

export function reduceClaimsV33(claims = []) {
  const groups = new Map();
  for (const claim of claims) {
    const group = groups.get(claim.proposition_key)
      || { claims: [], sets: new Map(), provenance: new Map(), findings: [] };
    group.claims.push(claim);
    for (const set of claim.semantic.support_sets || []) {
      const signature = canonical({
        mode: set.mode,
        locators: set.locators.map(item => ({ role: item.role, id: item.id })),
      });
      group.sets.set(signature, set);
    }
    const provenance = { claim_id: claim.id, ...claim.extraction };
    group.provenance.set(canonical(provenance), provenance);
    group.findings.push(...(claim.repair_findings || []));
    groups.set(claim.proposition_key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([propositionKey, group]) => {
    const seed = group.claims.slice().sort((a, b) => a.id.localeCompare(b.id) || canonical(a).localeCompare(canonical(b)))[0];
    const supportSets = [...group.sets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, set]) => set);
    const evidenceKey = sha256(canonical(supportSets.map(set => ({
      mode: set.mode,
      locators: set.locators.map(item => ({ role: item.role, id: item.id })),
    }))));
    const semantic = Object.freeze({
      ...seed.semantic,
      support_sets: supportSets,
      irreducible_multi_span: supportSets.some(set => set.mode === 'all_required'
        && set.locators.filter(item => item.role === 'primary').length > 1),
    });
    const extractionProvenance = [...group.provenance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    const locatorStats = group.claims.reduce((sum, claim) => ({
      proposed: sum.proposed + claim.locator_stats.proposed,
      resolved: sum.resolved + claim.locator_stats.resolved,
      failed: 0,
    }), { proposed: 0, resolved: 0, failed: 0 });
    const repairFindings = uniqueFindings(group.findings);
    return Object.freeze({
      ...seed,
      id: `claim-v33:${sha256(canonical({
        proposition_key: propositionKey,
        evidence_key: evidenceKey,
        repair_findings: repairFindings,
      }))}`,
      semantic,
      proposition_key: propositionKey,
      legacy_proposition_key: propositionKey,
      evidence_key: evidenceKey,
      locator_stats: locatorStats,
      repair_findings: repairFindings,
      extraction_provenance: extractionProvenance,
    });
  });
}

export const claimQualityMetricsV33 = claims => claimQualityMetricsV32(claims);
