// Source-first custody and scoring contracts for document-level extraction tranches.
import { sha256, stableStringify } from './lib.mjs';
import { EXTRACTOR_CONTRACTS } from './wide-context-extractor.mjs';

export const TRANCHE_POPULATION_SCHEMA = 'estate-map/document-extraction-tranche/v1';
export const TRANCHE_GOLD_SCHEMA = 'estate-map/document-tranche-gold/v1';
const canonical = value => stableStringify(value).trim();

export class TrancheEvaluationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TrancheEvaluationError';
    this.code = code;
    this.detail = detail;
  }
}

export function verifyTranchePopulation(population) {
  const { digest, ...body } = population || {};
  if (population?.schema !== TRANCHE_POPULATION_SCHEMA) {
    throw new TrancheEvaluationError('TRANCHE_SCHEMA_INVALID', String(population?.schema || '<missing>'));
  }
  if (sha256(canonical(body)) !== digest) {
    throw new TrancheEvaluationError('TRANCHE_DIGEST_MISMATCH', 'tranche population changed after freeze');
  }
  const documents = Array.isArray(population.documents) ? population.documents : [];
  const windowIds = Array.isArray(population.window_ids) ? population.window_ids : [];
  const frames = Array.isArray(population.source_frames) ? population.source_frames : [];
  if (documents.length !== Number(population.selection?.documents)
    || windowIds.length !== Number(population.selection?.windows)
    || new Set(windowIds).size !== windowIds.length) {
    throw new TrancheEvaluationError('TRANCHE_POPULATION_INCOHERENT', 'declared document/window totals do not match unique rows');
  }
  const documentWindows = documents.flatMap(row => row.window_ids || []);
  if (new Set(documentWindows).size !== windowIds.length
    || documentWindows.some(id => !windowIds.includes(id))) {
    throw new TrancheEvaluationError('TRANCHE_WINDOW_CONSERVATION_FAILED', 'document window rows do not exactly cover the inference population');
  }
  const representativeByFile = new Map(documents.map(row => [row.file, row.representative_window_id]));
  if (frames.length !== documents.length || new Set(frames.map(row => row.file)).size !== documents.length
    || frames.some(frame => representativeByFile.get(frame.file) !== frame.window_id)) {
    throw new TrancheEvaluationError('TRANCHE_SOURCE_FRAME_COVERAGE_FAILED', 'source frames must cover each representative document exactly once');
  }
  if (population.disclosure_scan?.pass !== true || population.disclosure_scan?.findings?.length) {
    throw new TrancheEvaluationError('TRANCHE_DISCLOSURE_SCAN_FAILED', 'frozen inference population did not pass disclosure scan');
  }
  return true;
}

function validateOpportunity(opportunity, frameByWindow) {
  const frame = frameByWindow.get(opportunity.window_id);
  if (!frame || frame.file !== opportunity.file) {
    throw new TrancheEvaluationError('TRANCHE_GOLD_WINDOW_UNKNOWN', String(opportunity.window_id));
  }
  const block = frame.blocks.find(row => row.address === opportunity.block_address);
  if (!block) throw new TrancheEvaluationError('TRANCHE_GOLD_BLOCK_OUTSIDE_FRAME', String(opportunity.block_address));
  const quote = String(opportunity.source_quote || '');
  if (quote.length < 24 || !block.text.includes(quote)) {
    throw new TrancheEvaluationError('TRANCHE_GOLD_QUOTE_NOT_EXACT', String(opportunity.id), { block: block.address });
  }
  const subject = String(opportunity.subject_surface || '');
  if (!subject || !quote.toLocaleLowerCase().includes(subject.toLocaleLowerCase())) {
    throw new TrancheEvaluationError('TRANCHE_GOLD_SUBJECT_NOT_IN_QUOTE', String(opportunity.id));
  }
  if (!String(opportunity.proposition || '').trim()) {
    throw new TrancheEvaluationError('TRANCHE_GOLD_PROPOSITION_MISSING', String(opportunity.id));
  }
}

export function sealTrancheGold({ population, draft }) {
  verifyTranchePopulation(population);
  const frames = population.source_frames || [];
  const opportunities = Array.isArray(draft?.opportunities) ? draft.opportunities : [];
  const frameByWindow = new Map(frames.map(frame => [frame.window_id, frame]));
  opportunities.forEach(row => validateOpportunity(row, frameByWindow));
  if (opportunities.length !== frames.length
    || new Set(opportunities.map(row => row.window_id)).size !== frames.length
    || new Set(opportunities.map(row => row.id)).size !== frames.length) {
    throw new TrancheEvaluationError('TRANCHE_GOLD_COVERAGE_INCOMPLETE', `expected one unique opportunity for each of ${frames.length} source frames`);
  }
  const body = {
    schema: TRANCHE_GOLD_SCHEMA,
    population_digest: population.digest,
    status: 'frozen_before_inference',
    reviewer: draft.reviewer,
    frozen_source_only: draft.frozen_source_only === true,
    matching_policy: draft.matching_policy,
    decision_rule: draft.decision_rule,
    opportunities: opportunities.slice().sort((a, b) => a.window_id.localeCompare(b.window_id)),
  };
  if (!body.frozen_source_only) throw new TrancheEvaluationError('TRANCHE_GOLD_NOT_SOURCE_FIRST', 'gold author must attest source-only review');
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyTrancheGold({ population, gold }) {
  const { digest, ...body } = gold || {};
  if (sha256(canonical(body)) !== digest) throw new TrancheEvaluationError('TRANCHE_GOLD_DIGEST_MISMATCH', 'gold changed after sealing');
  const resealed = sealTrancheGold({ population, draft: gold });
  if (resealed.digest !== digest || gold.status !== 'frozen_before_inference') {
    throw new TrancheEvaluationError('TRANCHE_GOLD_NOT_FROZEN', 'gold does not match its source-first contract');
  }
  return true;
}

const hashedOrder = (seed, id) => sha256(`${seed}\0${id}`);
const supportLocators = claim => (claim?.semantic?.support_sets || [])
  .flatMap(set => Array.isArray(set?.locators) ? set.locators : []);

function compactReviewClaim(claim, seed) {
  const semantic = claim?.semantic || {};
  const subject = semantic.subject || {};
  const evidence = supportLocators(claim).map(locator => ({
    role: locator.role ?? null,
    block_address: locator.block?.address ?? null,
    file: locator.file ?? null,
    lines: [locator.start ?? null, locator.end ?? null],
    text: locator.text ?? null,
  }));
  const windowIds = [...new Set([
    ...(claim?.extraction_provenance || []).map(row => row?.unit_id),
    semantic.provenance?.unit_id,
    claim?.extraction?.unit_id,
  ].filter(Boolean))].sort();
  return Object.freeze({
    review_claim_id: `review-claim:${sha256(`${seed}\0${claim.id}`)}`,
    window_id: windowIds[0] ?? null,
    window_ids: windowIds,
    evidence_files: [...new Set(evidence.map(row => row.file).filter(Boolean))].sort(),
    evidence_blocks: [...new Set(evidence.map(row => row.block_address).filter(Boolean))].sort(),
    subject: {
      surface: subject.surface ?? null,
      literal_surface: subject.literal_surface ?? null,
      identity_surface: subject.identity_surface ?? null,
      binding: subject.binding || null,
      anchor_text: subject.source_locator?.text ?? null,
      anchor_block: subject.source_locator?.block?.address ?? null,
      antecedent_text: subject.binding?.antecedent_locator?.text ?? null,
    },
    relation_family: semantic.relation_family ?? null,
    predicate_family: semantic.predicate_family ?? null,
    object_or_value: semantic.object_or_value ?? null,
    polarity: semantic.polarity ?? null,
    modality: semantic.modality ?? null,
    quantifier: semantic.quantifier ?? null,
    scope: semantic.scope || {},
    valid_time: semantic.valid_time || {},
    evidence,
  });
}

/** Build a source-first single-treatment review packet without original claim IDs or run metadata. */
export function buildTrancheBlindReview({
  population, gold, artifact, seed = 'v10-document-tranche-review-20260804', sample_size = 80,
}) {
  verifyTranchePopulation(population);
  verifyTrancheGold({ population, gold });
  const claim_id_mapping = {};
  const catalog = (artifact?.claims || []).map(claim => {
    const compact = compactReviewClaim(claim, seed);
    claim_id_mapping[compact.review_claim_id] = claim.id;
    return compact;
  }).sort((a, b) => a.review_claim_id.localeCompare(b.review_claim_id));
  const opportunity_frame = gold.opportunities.map(opportunity => {
    const sealed = catalog.filter(claim => claim.window_ids.includes(opportunity.window_id)
      && claim.evidence_blocks.includes(opportunity.block_address));
    const documentScope = catalog.filter(claim => claim.evidence_files.includes(opportunity.file));
    return {
      opportunity: {
      id: opportunity.id,
      window_id: opportunity.window_id,
      file: opportunity.file,
      block_address: opportunity.block_address,
      subject_surface: opportunity.subject_surface,
      source_quote: opportunity.source_quote,
      proposition: opportunity.proposition,
      },
      // Legacy alias retained for readers of frozen v1 packets. It is explicitly the sealed-block
      // frame and never stands for document-scope semantic coverage.
      candidate_claims: sealed,
      grade: null,
      frames: {
        sealed_block: { candidate_claims: sealed, grade: null },
        document_scope: { candidate_claims: documentScope, grade: null },
      },
    };
  }).sort((a, b) => a.opportunity.id.localeCompare(b.opportunity.id));
  const precision_frame = catalog.slice()
    .sort((a, b) => hashedOrder(`${seed}:precision`, a.review_claim_id)
      .localeCompare(hashedOrder(`${seed}:precision`, b.review_claim_id)))
    .slice(0, Number(sample_size))
    .map(claim => ({ claim, grade: {
      entailed: null, subject_binding_correct: null, severe_error: null, note: null,
    } }));
  const seedDigest = sha256(seed);
  return Object.freeze({
    packet: {
      schema: 'estate-map/document-tranche-blind-review/v2',
      blinded: true,
      seed_digest: seedDigest,
      strict_recall_policy: 'Only recovered counts toward recall; partial is reported separately.',
      primary_recall_frame: 'document_scope',
      secondary_recall_frame: 'sealed_block',
      opportunity_frame,
      precision_frame,
      status: 'awaiting_review',
    },
    key: {
      schema: 'estate-map/document-tranche-blind-key/v1',
      population_digest: population.digest,
      gold_digest: gold.digest,
      artifact_digest: artifact?.digest ?? null,
      seed_digest: seedDigest,
      claim_id_mapping,
    },
  });
}

export function operationalTrancheGrade({
  population, artifact, expected_contract = 'v10', controller = null, require_load_audit = false,
}) {
  const expectedWindows = Number(population?.selection?.windows || 0);
  const checks = {
    complete_status: artifact?.status === 'complete',
    exact_snapshot: artifact?.snapshot?.source_sha === population?.snapshot?.source_sha
      && artifact?.snapshot?.corpus_digest === population?.snapshot?.corpus_digest,
    expected_population: Number(artifact?.metrics?.selected_windows) === expectedWindows,
    every_window_completed: Number(artifact?.queue?.by_state?.done || 0) === expectedWindows,
    no_truncation: Number(artifact?.metrics?.truncated_units || 0) === 0,
    no_overflow: Number(artifact?.metrics?.overflow_units || 0) === 0,
    no_unpriced_attempts: Number(artifact?.budget?.unpriced_attempts || 0) === 0,
    no_fleet_stop: !artifact?.queue?.stopped,
    no_acceptance_unknown: Number(artifact?.queue?.by_state?.acceptance_unknown || 0) === 0,
    no_quarantine: Number(artifact?.queue?.by_state?.quarantined || 0) === 0,
    exact_extractor: artifact?.extractor === EXTRACTOR_CONTRACTS[expected_contract]
      && artifact?.extraction_contract === expected_contract,
    controller_load_audit_present: !require_load_audit || Boolean(controller?.load_audit),
    controller_exit_zero: !require_load_audit || Number(controller?.exit?.code) === 0,
    no_sustained_host_load_circuit: !require_load_audit
      || (Array.isArray(controller?.load_audit?.circuit_events)
        && controller.load_audit.circuit_events.length === 0),
  };
  return Object.freeze({ pass: Object.values(checks).every(Boolean), checks });
}

/** Score a completed blind review against the preregistered absolute floors. */
export function scoreTrancheBlindReview({
  population, gold, packet, key, grades, artifact, rejection_audit, expected_contract = 'v10',
  controller = null, require_load_audit = false,
}) {
  verifyTranchePopulation(population);
  verifyTrancheGold({ population, gold });
  if (key?.population_digest !== population.digest || key?.gold_digest !== gold.digest
    || key?.artifact_digest !== artifact?.digest || key?.seed_digest !== packet?.seed_digest) {
    throw new TrancheEvaluationError('TRANCHE_REVIEW_CUSTODY_MISMATCH', 'review key does not bind population, gold, artifact, and packet');
  }
  const opportunityIds = new Set(packet.opportunity_frame.map(row => row.opportunity.id));
  const precisionIds = new Set(packet.precision_frame.map(row => row.claim.review_claim_id));
  const opportunityGrades = grades?.opportunity_grades || [];
  const precisionGrades = grades?.precision_grades || [];
  const dualFrameGrades = opportunityGrades.some(row => row.frame != null);
  const expectedOpportunityGrades = opportunityIds.size * (dualFrameGrades ? 2 : 1);
  if (opportunityGrades.length !== expectedOpportunityGrades) {
    throw new TrancheEvaluationError('TRANCHE_OPPORTUNITY_GRADES_INCOMPLETE', `expected ${expectedOpportunityGrades} opportunity grades`);
  }
  if (precisionGrades.length !== precisionIds.size) {
    throw new TrancheEvaluationError('TRANCHE_PRECISION_GRADES_INCOMPLETE', `expected ${precisionIds.size} precision grades`);
  }
  const seenOpportunities = new Set(), seenClaims = new Set();
  const qualityMetrics = {
    precision_sample: precisionIds.size, entailed: 0, subject_binding_correct: 0, severe_errors: 0,
  };
  const recallByFrame = Object.fromEntries(['sealed_block', 'document_scope'].map(frame => [frame, {
    opportunities: opportunityIds.size, recovered: 0, partial: 0, missed: 0,
  }]));
  for (const row of opportunityGrades) {
    const frame = dualFrameGrades ? row.frame : 'sealed_block';
    if (!opportunityIds.has(row.opportunity_id) || !Object.hasOwn(recallByFrame, frame)
      || !['recovered', 'partial', 'missed'].includes(row.grade)) {
      throw new TrancheEvaluationError('TRANCHE_OPPORTUNITY_GRADE_INVALID', canonical(row));
    }
    const identity = `${row.opportunity_id}\0${frame}`;
    if (seenOpportunities.has(identity)) throw new TrancheEvaluationError('TRANCHE_OPPORTUNITY_GRADE_DUPLICATE', identity);
    seenOpportunities.add(identity);
    recallByFrame[frame][row.grade] += 1;
  }
  for (const row of precisionGrades) {
    if (!precisionIds.has(row.review_claim_id) || typeof row.entailed !== 'boolean'
      || typeof row.subject_binding_correct !== 'boolean' || typeof row.severe_error !== 'boolean') {
      throw new TrancheEvaluationError('TRANCHE_PRECISION_GRADE_INVALID', canonical(row));
    }
    if (seenClaims.has(row.review_claim_id)) throw new TrancheEvaluationError('TRANCHE_PRECISION_GRADE_DUPLICATE', row.review_claim_id);
    seenClaims.add(row.review_claim_id);
    if (row.entailed) qualityMetrics.entailed += 1;
    if (row.subject_binding_correct) qualityMetrics.subject_binding_correct += 1;
    if (row.severe_error) qualityMetrics.severe_errors += 1;
  }
  const scoredRecall = Object.fromEntries(Object.entries(recallByFrame).map(([frame, held]) => [frame, {
    ...held,
    strict_recall: held.opportunities ? held.recovered / held.opportunities : null,
  }]));
  const primaryRecall = dualFrameGrades ? scoredRecall.document_scope : scoredRecall.sealed_block;
  const scored = {
    ...primaryRecall,
    ...qualityMetrics,
    recall_frames: scoredRecall,
    primary_recall_frame: dualFrameGrades ? 'document_scope' : 'sealed_block',
    precision: qualityMetrics.precision_sample ? qualityMetrics.entailed / qualityMetrics.precision_sample : null,
    subject_binding_accuracy: qualityMetrics.precision_sample ? qualityMetrics.subject_binding_correct / qualityMetrics.precision_sample : null,
    severe_error_rate: qualityMetrics.precision_sample ? qualityMetrics.severe_errors / qualityMetrics.precision_sample : null,
  };
  const operational = operationalTrancheGrade({
    population, artifact, expected_contract, controller, require_load_audit,
  });
  const rule = gold.decision_rule || {};
  const checks = {
    operational: operational.pass,
    strict_recall_floor: scored.strict_recall >= Number(rule.strict_recall_floor ?? 0.4),
    precision_floor: scored.precision >= Number(rule.precision_floor ?? 0.9),
    subject_binding_floor: scored.subject_binding_accuracy >= Number(rule.subject_binding_floor ?? 0.95),
    severe_errors_max: scored.severe_errors <= Number(rule.severe_errors_max ?? 0),
    no_new_high_severity_systematic_rejection: rejection_audit?.pass === true,
  };
  return Object.freeze({
    schema: 'estate-map/document-tranche-gate-grade/v1',
    blinded_review: grades?.blinded === true,
    reviewer: grades?.reviewer ?? null,
    metrics: scored,
    operational,
    rejection_audit,
    checks,
    pass: Boolean(grades?.blinded) && Object.values(checks).every(Boolean),
  });
}
