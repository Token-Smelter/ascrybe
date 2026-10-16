import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPairedPopulationArtifact, freezeSourceFirstFrames, selectFreshPairedPopulation,
  scanPairedPopulationDisclosure, verifyPairedPopulationArtifact,
} from '../tools/paired-gate-population.mjs';
import { buildPairedBlindReview, operationalArmGrade, scorePairedBlindReview, sealPairedGold, verifyPairedGold } from '../tools/paired-gate-evaluation.mjs';

function fixture(format, ordinal, { bytes = 9000, type = 'paragraph' } = {}) {
  const file = `area${ordinal}/doc${ordinal}.${format}`;
  const block = {
    address: `${file}@0`, id: `block:${ordinal}`, digest: `digest:${ordinal}`, type,
    file, index: 0, start: 1, end: 1, bytes, text: `source ${ordinal} has enough exact bytes`,
  };
  return {
    inventory: { path: file, source_digest: `source:${ordinal}`, blocks: [block] },
    window: {
      id: `window:${String(ordinal).padStart(64, '0')}`, file, kind: 'whole_document',
      primary_bytes: bytes, primary_block_addresses: [block.address],
    },
  };
}

test('fresh selection honors format quotas, exclusions, and one-window-per-file', () => {
  const fixtures = [
    fixture('md', 1), fixture('md', 2, { bytes: 4000, type: 'code' }), fixture('md', 3),
    fixture('json', 4, { bytes: 40000, type: 'code' }), fixture('json', 5),
  ];
  const selected = selectFreshPairedPopulation({
    windows: fixtures.map(row => row.window), inventories: fixtures.map(row => row.inventory),
    excluded_window_ids: [fixtures[0].window.id], seed: 'fixture', format_quotas: { md: 2, json: 1 },
  });
  assert.deepEqual(selected.reduce((held, row) => ({ ...held, [row.format]: (held[row.format] || 0) + 1 }), {}), { md: 2, json: 1 });
  assert.equal(new Set(selected.map(row => row.file)).size, 3);
  assert.equal(selected.some(row => row.id === fixtures[0].window.id), false);
  assert.ok(new Set(selected.map(row => row.size)).size >= 2, 'selection increases stratum coverage before hash tie-breaking');
});

test('disclosure scan covers selected prompt blocks and reports only redacted match metadata', () => {
  const held = fixture('md', 1);
  held.inventory.blocks[0].text = 'credential ghp_abcdefghijklmnopqrstuvwxyzABCDEF should not dispatch';
  const population = selectFreshPairedPopulation({
    windows: [held.window], inventories: [held.inventory], format_quotas: { md: 1 },
  });
  const scan = scanPairedPopulationDisclosure({ population, inventories: [held.inventory] });
  assert.equal(scan.pass, false);
  assert.equal(scan.findings[0].code, 'GITHUB_TOKEN');
  assert.equal(Object.hasOwn(scan.findings[0], 'match'), false);
  assert.equal(scan.findings[0].matched_bytes > 20, true);
});

test('source-first frames contain exact pre-inference block bytes and artifact tampering fails', () => {
  const fixtures = Array.from({ length: 20 }, (_, index) => fixture('md', index + 1));
  const population = selectFreshPairedPopulation({
    windows: fixtures.map(row => row.window), inventories: fixtures.map(row => row.inventory),
    format_quotas: { md: 20 },
  });
  const frames = freezeSourceFirstFrames({ population, inventories: fixtures.map(row => row.inventory) });
  assert.equal(frames.length, 20);
  assert.equal(frames.every(frame => frame.blocks[0].text.startsWith('source ')), true);
  const artifact = buildPairedPopulationArtifact({
    snapshot: { source_sha: 'sha', corpus_digest: 'corpus' }, population, source_frames: frames,
    exclusions: { rule: 'fixture' }, seed: 'fixture', format_quotas: { md: 20 },
  });
  assert.equal(verifyPairedPopulationArtifact(artifact), true);
  assert.throws(() => verifyPairedPopulationArtifact({ ...artifact, window_ids: artifact.window_ids.slice(1) }),
    error => error.code === 'POPULATION_DIGEST_MISMATCH');
});

test('gold seals only exact frozen source and operational grade fails closed', () => {
  const fixtures = Array.from({ length: 20 }, (_, index) => fixture('md', index + 1));
  const population = selectFreshPairedPopulation({
    windows: fixtures.map(row => row.window), inventories: fixtures.map(row => row.inventory),
    format_quotas: { md: 20 },
  });
  const frames = freezeSourceFirstFrames({ population, inventories: fixtures.map(row => row.inventory) });
  const artifact = buildPairedPopulationArtifact({
    snapshot: { source_sha: 'sha', corpus_digest: 'corpus' }, population, source_frames: frames,
    exclusions: { rule: 'fixture' }, seed: 'fixture', format_quotas: { md: 20 },
  });
  const gold = sealPairedGold({ population: artifact, draft: {
    reviewer: { kind: 'fixture' }, matching_policy: {}, decision_rule: {},
    opportunities: frames.map((frame, index) => ({
      id: `gold:${index}`, window_id: frame.window_id, block_address: frame.blocks[0].address,
      subject_surface: 'source', source_quote: frame.blocks[0].text,
      proposition: 'fixture proposition',
    })),
  } });
  assert.ok(gold);
  assert.equal(verifyPairedGold({ population: artifact, gold }), true);
  const grade = operationalArmGrade({ status: 'complete', metrics: { selected_windows: 20, truncated_units: 0 },
    budget: { unpriced_attempts: 0 }, queue: { by_state: { done: 19, quarantined: 1, acceptance_unknown: 0 }, stopped: null } });
  assert.equal(grade.pass, false);
  assert.equal(grade.checks.every_window_completed, false);
  assert.equal(grade.checks.no_quarantine, false);
});

test('paired review sampling is deterministic and hides arm and original claim identity', () => {
  const claim = (id, unit, block) => ({ id, semantic: {
    subject: { surface: 'Thing', literal_surface: 'Thing', identity_surface: 'Thing', binding: { kind: 'explicit' },
      source_locator: { text: 'Thing', block: { address: block } } },
    relation_family: 'definition', predicate_family: 'is', object_or_value: 'defined', polarity: 'affirmed',
    modality: 'constitutive', quantifier: 'one', scope: {}, valid_time: {},
    support_sets: [{ locators: [{ role: 'primary', block: { address: block }, file: block.split('@')[0], start: 1, end: 1, text: 'Thing is defined.' }] }],
    provenance: { unit_id: unit },
  } });
  const gold = { opportunities: [{ id: 'gold:1', window_id: 'window:1', block_address: 'a.md@0',
    subject_surface: 'Thing', source_quote: 'Thing is defined.', proposition: 'Thing is defined.' }] };
  const input = { gold, arms: {
    control: { claims: [claim('control:1', 'window:1', 'a.md@0'), claim('control:2', 'window:2', 'b.md@0')] },
    treatment: { claims: [claim('treatment:1', 'window:1', 'a.md@0'), claim('treatment:2', 'window:2', 'b.md@0')] },
  }, seed: 'fixture', sample_size: 1 };
  const first = buildPairedBlindReview(input);
  const second = buildPairedBlindReview(input);
  assert.deepEqual(first, second);
  assert.equal(first.packet.precision_frame.length, 2);
  assert.equal(first.packet.schema, 'estate-map/paired-extraction-blind-review/v2');
  assert.deepEqual(Object.keys(first.key.mapping).sort(), ['A', 'B']);
  assert.doesNotMatch(JSON.stringify(first.packet), /control:|treatment:/);
  assert.equal(first.packet.opportunity_frame[0].arms.A.grade, null);
  assert.equal(first.packet.opportunity_frame[0].arms.B.grade, null);
  assert.equal(first.packet.opportunity_frame[0].arms.A.frames.sealed_block.candidate_claims.length, 1);
  assert.equal(first.packet.opportunity_frame[0].arms.A.frames.document_scope.candidate_claims.length, 1);

  const marginalOnly = buildPairedBlindReview({ ...input, arms: {
    control: { ...input.arms.control, precision_claims: [input.arms.control.claims[1]] },
    treatment: { ...input.arms.treatment, precision_claims: [input.arms.treatment.claims[1]] },
  } });
  assert.equal(marginalOnly.packet.opportunity_frame[0].arms.A.frames.document_scope.candidate_claims.length, 1);
  assert.ok(marginalOnly.packet.precision_frame.every(row => row.claim.evidence_files.includes('b.md')));
});

test('paired semantic scorer implements the frozen comparison thresholds', () => {
  const packet = {
    opportunity_frame: [{ opportunity: { id: 'g1' } }, { opportunity: { id: 'g2' } }],
    precision_frame: [
      { blind_arm: 'A', claim: { review_claim_id: 'a1' } }, { blind_arm: 'A', claim: { review_claim_id: 'a2' } },
      { blind_arm: 'B', claim: { review_claim_id: 'b1' } }, { blind_arm: 'B', claim: { review_claim_id: 'b2' } },
    ],
  };
  const opportunity_grades = ['A', 'B'].flatMap(blind_arm => ['g1', 'g2'].map(opportunity_id => ({
    opportunity_id, blind_arm, grade: 'recovered',
  })));
  const precision_grades = [
    { review_claim_id: 'a1', blind_arm: 'A', entailed: true, subject_binding_correct: true, severe_error: false },
    { review_claim_id: 'a2', blind_arm: 'A', entailed: true, subject_binding_correct: true, severe_error: false },
    { review_claim_id: 'b1', blind_arm: 'B', entailed: true, subject_binding_correct: true, severe_error: false },
    { review_claim_id: 'b2', blind_arm: 'B', entailed: true, subject_binding_correct: false, severe_error: false },
  ];
  const complete = { status: 'complete', metrics: { selected_windows: 20, truncated_units: 0 },
    budget: { unpriced_attempts: 0 }, queue: { by_state: { done: 20 }, stopped: null } };
  const grade = scorePairedBlindReview({ packet, key: { mapping: { A: 'treatment', B: 'control' } },
    grades: { blinded: true, opportunity_grades, precision_grades },
    artifacts: { control: complete, treatment: complete }, rejection_audit: { pass: true } });
  assert.equal(grade.pass, true);
  assert.equal(grade.metrics.treatment.subject_binding_accuracy, 1);
  assert.equal(grade.metrics.control.subject_binding_accuracy, 0.5);
  assert.equal(grade.checks.precision_within_005, true);
});

test('paired scorer reports document-scope recall separately and uses it as the dual-frame primary', () => {
  const packet = {
    opportunity_frame: [{ opportunity: { id: 'g1' } }],
    precision_frame: [
      { blind_arm: 'A', claim: { review_claim_id: 'a1' } },
      { blind_arm: 'B', claim: { review_claim_id: 'b1' } },
    ],
  };
  const opportunity_grades = ['A', 'B'].flatMap(blind_arm => [
    { opportunity_id: 'g1', blind_arm, frame: 'sealed_block', grade: 'missed' },
    { opportunity_id: 'g1', blind_arm, frame: 'document_scope', grade: 'recovered' },
  ]);
  const precision_grades = ['A', 'B'].map((blind_arm, index) => ({
    review_claim_id: index ? 'b1' : 'a1', blind_arm,
    entailed: true, subject_binding_correct: true, severe_error: false,
  }));
  const complete = { status: 'complete', metrics: { selected_windows: 20, truncated_units: 0, overflow_units: 0 },
    budget: { unpriced_attempts: 0 }, queue: { by_state: { done: 20 }, stopped: null } };
  const grade = scorePairedBlindReview({
    packet,
    key: { mapping: { A: 'treatment', B: 'control' } },
    grades: { blinded: true, opportunity_grades, precision_grades },
    artifacts: { control: complete, treatment: complete },
    rejection_audit: { pass: true },
  });
  assert.equal(grade.pass, true);
  assert.equal(grade.metrics.treatment.primary_recall_frame, 'document_scope');
  assert.equal(grade.metrics.treatment.strict_recall, 1);
  assert.equal(grade.metrics.treatment.recall_frames.sealed_block.strict_recall, 0);
});
