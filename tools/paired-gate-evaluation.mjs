// Source-first gold contract and deterministic paired-arm grading helpers.
import { sha256, stableStringify } from './lib.mjs';
import { verifyPairedPopulationArtifact } from './paired-gate-population.mjs';

export const PAIRED_GOLD_SCHEMA = 'estate-map/paired-extraction-gold/v1';
const canonical = value => stableStringify(value).trim();

export class PairedEvaluationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PairedEvaluationError';
    this.code = code;
    this.detail = detail;
  }
}

function validateOpportunity(opportunity, frameByWindow) {
  const frame = frameByWindow.get(opportunity.window_id);
  if (!frame) throw new PairedEvaluationError('GOLD_WINDOW_UNKNOWN', opportunity.window_id);
  const block = frame.blocks.find(row => row.address === opportunity.block_address);
  if (!block) throw new PairedEvaluationError('GOLD_BLOCK_OUTSIDE_FROZEN_FRAME', opportunity.block_address);
  const quote = String(opportunity.source_quote || '');
  if (quote.length < 24 || !block.text.includes(quote)) {
    throw new PairedEvaluationError('GOLD_QUOTE_NOT_EXACT', opportunity.id, { quote, block: block.address });
  }
  const subject = String(opportunity.subject_surface || '');
  if (!subject || !quote.toLocaleLowerCase().includes(subject.toLocaleLowerCase())) {
    throw new PairedEvaluationError('GOLD_SUBJECT_NOT_IN_QUOTE', opportunity.id, { subject, quote });
  }
  if (!String(opportunity.proposition || '').trim()) throw new PairedEvaluationError('GOLD_PROPOSITION_MISSING', opportunity.id);
}

export function sealPairedGold({ population, draft }) {
  verifyPairedPopulationArtifact(population);
  const opportunities = Array.isArray(draft?.opportunities) ? draft.opportunities : [];
  const frameByWindow = new Map(population.source_frames.map(frame => [frame.window_id, frame]));
  opportunities.forEach(row => validateOpportunity(row, frameByWindow));
  if (opportunities.length !== population.window_ids.length
    || new Set(opportunities.map(row => row.window_id)).size !== population.window_ids.length) {
    throw new PairedEvaluationError('GOLD_COVERAGE_INCOMPLETE',
      `expected one source-first opportunity for each of ${population.window_ids.length} windows`);
  }
  const body = {
    schema: PAIRED_GOLD_SCHEMA,
    population_digest: population.digest,
    status: 'frozen_before_inference',
    reviewer: draft.reviewer,
    frozen_source_only: true,
    matching_policy: draft.matching_policy,
    decision_rule: draft.decision_rule,
    opportunities: opportunities.slice().sort((a, b) => a.window_id.localeCompare(b.window_id)),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function verifyPairedGold({ population, gold }) {
  const { digest, ...body } = gold || {};
  if (sha256(canonical(body)) !== digest) throw new PairedEvaluationError('GOLD_DIGEST_MISMATCH', 'gold artifact changed after sealing');
  const resealed = sealPairedGold({ population, draft: {
    reviewer: gold.reviewer,
    matching_policy: gold.matching_policy,
    decision_rule: gold.decision_rule,
    opportunities: gold.opportunities,
  } });
  if (resealed.digest !== digest || gold.status !== 'frozen_before_inference') {
    throw new PairedEvaluationError('GOLD_NOT_FROZEN', 'gold does not match the sealed source-first contract');
  }
  return true;
}

export function operationalArmGrade(artifact, { expected_windows = 20 } = {}) {
  const queue = artifact?.queue || {};
  const metrics = artifact?.metrics || {};
  const budget = artifact?.budget || {};
  const checks = {
    complete_status: artifact?.status === 'complete',
    expected_population: Number(metrics.selected_windows) === expected_windows,
    every_window_completed: Number(queue.by_state?.done || 0) === expected_windows,
    no_truncation: Number(metrics.truncated_units || 0) === 0,
    no_overflow: Number(metrics.overflow_units || 0) === 0,
    no_unpriced_attempts: Number(budget.unpriced_attempts || 0) === 0,
    no_fleet_stop: !queue.stopped,
    no_acceptance_unknown: Number(queue.by_state?.acceptance_unknown || 0) === 0,
    no_quarantine: Number(queue.by_state?.quarantined || 0) === 0,
  };
  return Object.freeze({ pass: Object.values(checks).every(Boolean), checks });
}

const hashedOrder = (seed, id) => sha256(`${seed}\0${id}`);
const supportLocators = claim => (claim?.semantic?.support_sets || [])
  .flatMap(set => Array.isArray(set?.locators) ? set.locators : []);

function compactReviewClaim(claim, { seed, blind }) {
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
  return {
    review_claim_id: `review-claim:${sha256(`${seed}\0${blind}\0${claim.id}`)}`,
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
  };
}

/** Build the post-inference review packet without exposing arm names or original claim ids. */
export function buildPairedBlindReview({ gold, arms, seed = 'v9-paired-gate-review-20260804', sample_size = 40 }) {
  const armNames = Object.keys(arms || {}).sort();
  if (armNames.length !== 2) throw new PairedEvaluationError('PAIRED_ARMS_REQUIRED', 'blind review requires exactly two arms');
  const labels = ['A', 'B'];
  const shuffled = armNames.slice().sort((a, b) => hashedOrder(`${seed}:arms`, a).localeCompare(hashedOrder(`${seed}:arms`, b)));
  const mapping = Object.fromEntries(labels.map((label, index) => [label, shuffled[index]]));
  const armToBlind = Object.fromEntries(Object.entries(mapping).map(([blind, arm]) => [arm, blind]));
  const claim_id_mapping = {};
  const catalogs = {};
  const precisionCatalogs = {};
  for (const arm of armNames) {
    const blind = armToBlind[arm];
    catalogs[blind] = (arms[arm]?.claims || []).map(claim => {
      const compact = compactReviewClaim(claim, { seed, blind });
      claim_id_mapping[compact.review_claim_id] = { arm, claim_id: claim.id };
      return compact;
    }).sort((a, b) => a.review_claim_id.localeCompare(b.review_claim_id));
    precisionCatalogs[blind] = (arms[arm]?.precision_claims || arms[arm]?.claims || []).map(claim => {
      const compact = compactReviewClaim(claim, { seed, blind });
      claim_id_mapping[compact.review_claim_id] = { arm, claim_id: claim.id };
      return compact;
    }).sort((a, b) => a.review_claim_id.localeCompare(b.review_claim_id));
  }
  const opportunity_frame = (gold?.opportunities || []).map(opportunity => {
    const opportunityFile = opportunity.file
      || /^(.*)@\d+$/.exec(String(opportunity.block_address || ''))?.[1] || null;
    return {
      opportunity: {
      id: opportunity.id,
      window_id: opportunity.window_id,
      file: opportunityFile,
      block_address: opportunity.block_address,
      subject_surface: opportunity.subject_surface,
      source_quote: opportunity.source_quote,
      proposition: opportunity.proposition,
      },
      arms: Object.fromEntries(labels.map(blind => {
        const sealed = catalogs[blind].filter(claim => claim.window_ids.includes(opportunity.window_id)
          && claim.evidence_blocks.includes(opportunity.block_address));
        const documentScope = catalogs[blind].filter(claim => claim.evidence_files.includes(opportunityFile));
        return [blind, {
          candidate_claims: sealed,
          grade: null,
          frames: {
            sealed_block: { candidate_claims: sealed, grade: null },
            document_scope: { candidate_claims: documentScope, grade: null },
          },
        }];
      })),
    };
  }).sort((a, b) => a.opportunity.id.localeCompare(b.opportunity.id));
  const precision_frame = labels.flatMap(blind => precisionCatalogs[blind]
    .slice()
    .sort((a, b) => hashedOrder(`${seed}:precision:${blind}`, a.review_claim_id)
      .localeCompare(hashedOrder(`${seed}:precision:${blind}`, b.review_claim_id)))
    .slice(0, Number(sample_size))
    .map(claim => ({ blind_arm: blind, claim, grade: { entailed: null, subject_binding_correct: null, severe_error: null, note: null } })))
    .sort((a, b) => a.blind_arm.localeCompare(b.blind_arm)
      || a.claim.review_claim_id.localeCompare(b.claim.review_claim_id));
  const packet = {
    schema: 'estate-map/paired-extraction-blind-review/v2',
    blinded: true,
    seed_digest: sha256(seed),
    strict_recall_policy: 'Only recovered counts toward recall; partial is reported separately.',
    primary_recall_frame: 'document_scope',
    secondary_recall_frame: 'sealed_block',
    opportunity_frame,
    precision_frame,
    status: 'awaiting_review',
  };
  const key = {
    schema: 'estate-map/paired-extraction-blind-key/v1',
    mapping, claim_id_mapping, seed_digest: sha256(seed),
  };
  return Object.freeze({ packet, key });
}

export function scorePairedBlindReview({ packet, key, grades, artifacts, rejection_audit }) {
  const labels = Object.keys(key?.mapping || {}).sort();
  if (labels.length !== 2) throw new PairedEvaluationError('BLIND_KEY_INVALID', 'blind key must map exactly two labels');
  const opportunityIds = new Set((packet?.opportunity_frame || []).map(row => row.opportunity.id));
  const precisionIds = new Set((packet?.precision_frame || []).map(row => row.claim.review_claim_id));
  const opportunityGrades = grades?.opportunity_grades || [];
  const precisionGrades = grades?.precision_grades || [];
  const dualFrameGrades = opportunityGrades.some(row => row.frame != null);
  const frames = dualFrameGrades ? ['sealed_block', 'document_scope'] : ['sealed_block'];
  const expectedOpportunityGrades = opportunityIds.size * labels.length * frames.length;
  if (opportunityGrades.length !== expectedOpportunityGrades) {
    throw new PairedEvaluationError('OPPORTUNITY_GRADES_INCOMPLETE', `expected ${expectedOpportunityGrades} opportunity grades`);
  }
  if (precisionGrades.length !== precisionIds.size) {
    throw new PairedEvaluationError('PRECISION_GRADES_INCOMPLETE', `expected ${precisionIds.size} precision grades`);
  }
  const opportunityKeys = new Set(), precisionKeys = new Set();
  const byBlind = Object.fromEntries(labels.map(label => [label, {
    recall_frames: Object.fromEntries(frames.map(frame => [frame, {
      opportunities: opportunityIds.size, recovered: 0, partial: 0, missed: 0,
    }])),
    precision_sample: 0, entailed: 0, subject_binding_correct: 0, severe_errors: 0,
  }]));
  for (const row of opportunityGrades) {
    const frame = dualFrameGrades ? row.frame : 'sealed_block';
    if (!opportunityIds.has(row.opportunity_id) || !labels.includes(row.blind_arm)
      || !frames.includes(frame) || !['recovered', 'partial', 'missed'].includes(row.grade)) {
      throw new PairedEvaluationError('OPPORTUNITY_GRADE_INVALID', canonical(row));
    }
    const identity = `${row.opportunity_id}\0${row.blind_arm}\0${frame}`;
    if (opportunityKeys.has(identity)) throw new PairedEvaluationError('OPPORTUNITY_GRADE_DUPLICATE', identity);
    opportunityKeys.add(identity);
    byBlind[row.blind_arm].recall_frames[frame][row.grade] += 1;
  }
  for (const row of precisionGrades) {
    if (!precisionIds.has(row.review_claim_id) || !labels.includes(row.blind_arm)
      || typeof row.entailed !== 'boolean' || typeof row.subject_binding_correct !== 'boolean'
      || typeof row.severe_error !== 'boolean') {
      throw new PairedEvaluationError('PRECISION_GRADE_INVALID', canonical(row));
    }
    if (precisionKeys.has(row.review_claim_id)) throw new PairedEvaluationError('PRECISION_GRADE_DUPLICATE', row.review_claim_id);
    precisionKeys.add(row.review_claim_id);
    const held = byBlind[row.blind_arm];
    held.precision_sample += 1;
    if (row.entailed) held.entailed += 1;
    if (row.subject_binding_correct) held.subject_binding_correct += 1;
    if (row.severe_error) held.severe_errors += 1;
  }
  const metricsByBlind = Object.fromEntries(labels.map(label => {
    const held = byBlind[label];
    const recallFrames = Object.fromEntries(Object.entries(held.recall_frames).map(([frame, recall]) => [frame, {
      ...recall,
      strict_recall: recall.opportunities ? recall.recovered / recall.opportunities : null,
    }]));
    const primary = dualFrameGrades ? recallFrames.document_scope : recallFrames.sealed_block;
    return [label, {
      ...primary,
      recall_frames: recallFrames,
      primary_recall_frame: dualFrameGrades ? 'document_scope' : 'sealed_block',
      precision_sample: held.precision_sample,
      entailed: held.entailed,
      subject_binding_correct: held.subject_binding_correct,
      severe_errors: held.severe_errors,
      precision: held.precision_sample ? held.entailed / held.precision_sample : null,
      subject_binding_accuracy: held.precision_sample ? held.subject_binding_correct / held.precision_sample : null,
      severe_error_rate: held.precision_sample ? held.severe_errors / held.precision_sample : null,
    }];
  }));
  const metrics = Object.fromEntries(Object.entries(key.mapping).map(([blind, arm]) => [arm, metricsByBlind[blind]]));
  if (!metrics.control || !metrics.treatment) throw new PairedEvaluationError('ARM_MAPPING_INVALID', 'key must map to control and treatment');
  const operational = {
    control: operationalArmGrade(artifacts?.control),
    treatment: operationalArmGrade(artifacts?.treatment),
  };
  const checks = {
    control_operational: operational.control.pass,
    treatment_operational: operational.treatment.pass,
    recall_not_lower: metrics.treatment.strict_recall >= metrics.control.strict_recall,
    precision_within_005: metrics.treatment.precision >= metrics.control.precision - 0.05,
    subject_binding_gain_or_ceiling: metrics.treatment.subject_binding_accuracy >= 0.95
      || metrics.treatment.subject_binding_accuracy >= metrics.control.subject_binding_accuracy + 0.10,
    no_new_high_severity_systematic_rejection: rejection_audit?.pass === true,
  };
  return Object.freeze({
    schema: 'estate-map/paired-extraction-gate-grade/v1',
    blinded_review: grades?.blinded === true,
    reviewer: grades?.reviewer ?? null,
    metrics,
    operational,
    rejection_audit,
    checks,
    pass: Object.values(checks).every(Boolean),
  });
}
