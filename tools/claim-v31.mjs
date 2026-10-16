// Documentary claim v3.1 — source-anchored subjects and evidence-set logic.
//
// Keep source grounding separate from corpus-wide identity.
//
// 1. SUBJECT. v3 demanded a corpus-global canonical `kind:id` at extraction time and marked
//    everything else `unresolved`, conflating a grounded local concept with absent evidence.
//    v3.1 separates:
//       (a) is the proposition supported by source?   -> evidence
//       (b) is the subject anchored in source?        -> subject_mention (REQUIRED)
//       (c) is it the same entity as X corpus-wide?   -> merge time only
//    `local` is a COMPLETE, promotable state. `unresolved` now means what it should: no source
//    anchor at all.
//
// 2. EVIDENCE. v3 carried a flat span list, so "has two primary spans" could not distinguish
//    "both spans are required" from "either span suffices". Explicit support-set modes preserve
//    that distinction while keeping proposition identity independent of the citation set.
import { sha256, stableStringify } from './lib.mjs';

export const CLAIM_V31_SCHEMA = 'estate-map/documentary-claim/v3.1';
export const RESOLUTION_STATUSES = Object.freeze(['canonical', 'alias_resolved', 'local', 'ambiguous', 'unresolved']);
export const SUPPORT_MODES = Object.freeze(['all_required', 'alternative_support']);
export const CLAIM_MODALITIES = Object.freeze(['descriptive', 'normative', 'historical', 'constitutive', 'predictive']);
export const CLAIM_POLARITIES = Object.freeze(['affirmed', 'negated']);

const CANONICAL_REF = /^(?:component|protocol|schema|state|command|record|concept|entity):[a-z0-9][a-z0-9._/-]*$/;

export class ClaimV31Error extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ClaimV31Error';
    this.code = code;
    this.detail = detail;
  }
}

const text = value => String(value ?? '');
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const canonical = value => stableStringify(value).trim();
const orderSpan = (a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.end - b.end;

const spanInside = (span, allowed) => allowed.some(a => a.file === span.file && span.start >= a.start && span.end <= a.end);

/**
 * @param proposed        model output
 * @param window          { primary_spans[], context_spans[], id, snapshot }
 * @param sliceSource     (file, start, end) => verbatim text  (tool-owned; never model prose)
 * @param namespace       optional mention namespace for exact-surface anchoring
 */
export function buildClaimV31({ proposed, window, sliceSource, namespace = null, model_identifier, prompt_digest }) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new ClaimV31Error('INVALID_CLAIM', 'claim must be an object');
  if (typeof sliceSource !== 'function') throw new ClaimV31Error('MISSING_SLICER', 'buildClaimV31 requires a source slicer');

  const modality = text(proposed.modality).trim();
  const polarity = text(proposed.polarity).trim();
  if (!CLAIM_MODALITIES.includes(modality)) throw new ClaimV31Error('INVALID_MODALITY', modality);
  if (!CLAIM_POLARITIES.includes(polarity)) throw new ClaimV31Error('INVALID_POLARITY', polarity);
  if (!nonblank(proposed.predicate_family)) throw new ClaimV31Error('MISSING_PREDICATE', 'predicate_family is required');
  if (!Object.hasOwn(proposed, 'object_or_value')) throw new ClaimV31Error('MISSING_OBJECT', 'object_or_value is required');

  // ---- Subject: anchored first, resolved later -----------------------------------------------
  const mention = proposed.subject_mention || {};
  const surface = text(mention.surface ?? proposed.subject_surface).trim();
  const mentionSpan = mention.span || proposed.subject_span || null;
  const declaredRef = text(proposed.canonical_ref).trim().toLowerCase();

  let resolution_status;
  let canonical_ref = null;
  let mention_id = null;

  if (declaredRef && CANONICAL_REF.test(declaredRef)) {
    canonical_ref = declaredRef;
    resolution_status = 'canonical';
  } else if (nonblank(surface) && namespace) {
    const hits = namespace.lookup(surface);
    // A namespace hit is a SOURCE-LOCAL mention, not a global identity. When the same surface
    // occurs in several documents, bind only the hit at the model-cited source span. Choosing the
    // first corpus-wide hit here used to give every ambiguous surface the same mention_id, which
    // could collapse propositions across documents despite the no-similarity-merge rule.
    const localHits = mentionSpan?.file
      ? hits.filter(hit => hit.file === mentionSpan.file && hit.lines.some(line =>
        line >= Number(mentionSpan.start) && line <= Number(mentionSpan.end ?? mentionSpan.start)))
      : [];
    if (hits.length === 1) {
      if (localHits.length === 1) mention_id = localHits[0].id;
      resolution_status = 'local';
    } else if (hits.length > 1) {
      if (localHits.length === 1) mention_id = localHits[0].id;
      resolution_status = 'ambiguous';
    }
  }

  if (!resolution_status) {
    // A source-anchored concept is LAWFUL. Only a subject with no anchor at all is unresolved.
    if (nonblank(surface) && mentionSpan && Number.isInteger(Number(mentionSpan.start))) resolution_status = 'local';
    else resolution_status = 'unresolved';
  }

  // Resolution and anchoring are orthogonal: a declared canonical ref does not prove the model
  // supplied a source mention. Anchored means a surface plus coordinates; validity is checked below.
  const anchored = nonblank(surface) && Boolean(mentionSpan?.file) && Number.isInteger(Number(mentionSpan?.start));
  const subject = {
    surface: surface || null,
    span: mentionSpan ? { file: text(mentionSpan.file) || null, start: Number(mentionSpan.start), end: Number(mentionSpan.end ?? mentionSpan.start) } : null,
    mention_id,
    canonical_ref,
    resolution_status,
    candidate_refs: Array.isArray(proposed.candidate_refs) ? proposed.candidate_refs.map(r => text(r).trim().toLowerCase()).filter(Boolean).sort() : [],
    anchored,
  };
  if (subject.span) {
    if (!subject.span.file || !Number.isInteger(subject.span.start) || !Number.isInteger(subject.span.end) || subject.span.start < 1 || subject.span.end < subject.span.start) {
      throw new ClaimV31Error('INVALID_SUBJECT_SPAN', 'subject span must have a file and increasing positive integer coordinates', { span: subject.span });
    }
    if (!spanInside(subject.span, window.primary_spans.concat(window.context_spans || []))) {
      throw new ClaimV31Error('SUBJECT_SPAN_OUTSIDE_WINDOW', `subject span ${subject.span.file}:${subject.span.start} is outside this unit's evidence`);
    }
    if (surface && !sliceSource(subject.span.file, subject.span.start, subject.span.end).toLocaleLowerCase().includes(surface.toLocaleLowerCase())) {
      throw new ClaimV31Error('SUBJECT_SURFACE_NOT_IN_SPAN', `subject surface is not present in ${subject.span.file}:${subject.span.start}-${subject.span.end}`);
    }
  }

  // ---- Evidence: support sets with explicit necessity ------------------------------------------
  const rawSets = Array.isArray(proposed.support_sets) && proposed.support_sets.length
    ? proposed.support_sets
    : [{ mode: 'all_required', spans: proposed.source_spans || [] }];

  const support_sets = rawSets.map((set, setIndex) => {
    const mode = text(set.mode).trim() || 'all_required';
    if (!SUPPORT_MODES.includes(mode)) throw new ClaimV31Error('INVALID_SUPPORT_MODE', mode);
    const spans = (Array.isArray(set.spans) ? set.spans : []).map(span => ({
      role: text(span.role).trim() || 'primary',
      file: text(span.file).trim(),
      start: Number(span.start),
      end: Number(span.end ?? span.start),
    })).sort(orderSpan);
    if (!spans.length) throw new ClaimV31Error('EMPTY_SUPPORT_SET', `support_sets[${setIndex}] has no spans`);
    if (!spans.some(span => span.role === 'primary')) throw new ClaimV31Error('MISSING_PRIMARY_SPAN', `support_sets[${setIndex}] cites no primary span`);
    for (const span of spans) {
      if (!['primary', 'context'].includes(span.role)) throw new ClaimV31Error('INVALID_SPAN_ROLE', span.role);
      if (!span.file || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 1 || span.end < span.start) {
        throw new ClaimV31Error('INVALID_EVIDENCE_SPAN', 'evidence span must have a file and increasing positive integer coordinates', { span });
      }
      const allowed = span.role === 'primary' ? window.primary_spans : (window.context_spans || []);
      if (!spanInside(span, allowed)) throw new ClaimV31Error('SPAN_OUTSIDE_ROLE_CUSTODY', `${span.role} span ${span.file}:${span.start}-${span.end} is outside this unit's ${span.role} evidence`);
    }
    const excerpts = spans.map(span => ({ ...span, text: sliceSource(span.file, span.start, span.end) }));
    return { mode, spans, excerpts };
  });

  // Irreducible iff some all_required set genuinely needs more than one PRIMARY span. This is the
  // measurable form of the pilot's headline metric, which "has N spans" could never express.
  const irreducible_multi_span = support_sets.some(set => set.mode === 'all_required' && set.spans.filter(s => s.role === 'primary').length > 1);

  const semantic = {
    subject,
    predicate_family: text(proposed.predicate_family).trim(),
    object_or_value: proposed.object_or_value,
    polarity,
    modality,
    quantifier: text(proposed.quantifier).trim() || 'unspecified',
    scope: proposed.scope && typeof proposed.scope === 'object' && !Array.isArray(proposed.scope) ? proposed.scope : {},
    valid_time: proposed.valid_time && typeof proposed.valid_time === 'object' && !Array.isArray(proposed.valid_time) ? proposed.valid_time : {},
    support_sets,
    irreducible_multi_span,
    provenance: {
      unit_id: window.id ?? null,
      source_sha: window.snapshot?.source_sha ?? null,
      corpus_digest: window.snapshot?.corpus_digest ?? null,
    },
  };

  // Proposition identity EXCLUDES the citation set, so one proposition with alternative supports is
  // one claim. v3's dedup key folded spans in, which made "multi-span" partly an artifact of
  // evidence packaging.
  // SUBJECT IDENTITY FOR THE PROPOSITION KEY. A canonical ref or a resolved mention id IS an
  // identity and may unify across documents. A bare surface is NOT: "a case" in two documents is two
  // local subjects until a merge-time rule says otherwise. Folding the anchor's file into the key
  // keeps surface similarity from silently merging identity, which the constitution forbids.
  const subjectIdentity = subject.canonical_ref
    ? { kind: 'canonical', ref: subject.canonical_ref }
    : subject.mention_id
      ? { kind: 'mention', ref: subject.mention_id }
      : { kind: 'local_surface', surface: subject.surface || null, file: subject.span?.file ?? window.primary_spans[0]?.file ?? null };
  const proposition_key = sha256(canonical({
    subject: subjectIdentity,
    resolution_status: subject.resolution_status,
    predicate_family: semantic.predicate_family,
    object_or_value: semantic.object_or_value,
    polarity, modality,
    quantifier: semantic.quantifier,
    scope: semantic.scope,
    valid_time: semantic.valid_time,
  }));
  const evidence_key = sha256(canonical(support_sets.map(set => ({ mode: set.mode, spans: set.spans }))));

  const record = {
    schema: CLAIM_V31_SCHEMA,
    semantic,
    proposition_key,
    evidence_key,
    extraction: { model_identifier, prompt_digest, unit_id: window.id ?? null },
  };
  return Object.freeze({ ...record, id: `claim-v31:${sha256(canonical({ proposition_key, evidence_key }))}` });
}

/**
 * Reduce by PROPOSITION, unioning evidence. Two extractions of the same proposition supported by
 * different spans become one claim with two support sets — not two claims.
 */
export function reduceClaimsV31(claims = []) {
  const groups = new Map();
  for (const claim of claims) {
    const key = claim.proposition_key;
    const group = groups.get(key) || { claims: [], support_sets: [], evidence_keys: new Set(), provenance: [] };
    group.claims.push(claim);
    for (const set of claim.semantic.support_sets) {
      const sig = sha256(canonical({ mode: set.mode, spans: set.spans }));
      if (!group.evidence_keys.has(sig)) { group.evidence_keys.add(sig); group.support_sets.push(set); }
    }
    group.provenance.push({ claim_id: claim.id, ...claim.extraction });
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    // Canonical selection and collection ordering are content-based. Queue completion order is
    // nondeterministic under concurrency and must not change reduced claim bytes or identity.
    const canonicalClaim = group.claims.slice().sort((a, b) => a.id.localeCompare(b.id) || canonical(a).localeCompare(canonical(b)))[0];
    const support_sets = group.support_sets.slice().sort((x, y) =>
      canonical({ mode: x.mode, spans: x.spans }).localeCompare(canonical({ mode: y.mode, spans: y.spans })));
    const semantic = { ...canonicalClaim.semantic, support_sets, irreducible_multi_span: support_sets.some(s => s.mode === 'all_required' && s.spans.filter(p => p.role === 'primary').length > 1) };
    const evidence_key = sha256(canonical(support_sets.map(s => ({ mode: s.mode, spans: s.spans }))));
    const extraction_provenance = [...new Map(group.provenance
      .map(item => [canonical(item), item])
      .sort(([a], [b]) => a.localeCompare(b))).values()];
    const record = { ...canonicalClaim, semantic, proposition_key: key, evidence_key, extraction_provenance };
    return Object.freeze({
      ...record,
      // The reduced id describes the REDUCED evidence set, not whichever extraction happened to
      // finish first. A one-evidence claim remains byte-identical to its original id.
      id: `claim-v31:${sha256(canonical({ proposition_key: key, evidence_key }))}`,
    });
  });
}

/** Honest replacements for the misleading "unresolved referent rate". */
export function claimQualityMetrics(claims = []) {
  const total = claims.length;
  const byStatus = {};
  let unanchored = 0, irreducible = 0, canonicalEligibleUnresolved = 0;
  for (const claim of claims) {
    const subject = claim.semantic.subject;
    byStatus[subject.resolution_status] = (byStatus[subject.resolution_status] || 0) + 1;
    if (!subject.anchored) unanchored += 1;
    if (claim.semantic.irreducible_multi_span) irreducible += 1;
    // A subject is canonical-ELIGIBLE only if it names a thing with identity; a bare concept is not.
    if (subject.candidate_refs.length > 0 && !subject.canonical_ref) canonicalEligibleUnresolved += 1;
  }
  return Object.freeze({
    claims: total,
    by_resolution_status: byStatus,
    unanchored_subjects: unanchored,                       // the REAL defect
    unanchored_rate: total ? Number((unanchored / total).toFixed(4)) : 0,
    canonical_eligible_unresolved: canonicalEligibleUnresolved,
    irreducible_multi_span_claims: irreducible,            // the honest headline metric
  });
}
