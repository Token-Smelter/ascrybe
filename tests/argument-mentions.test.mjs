import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArgumentMentionSubstrate, buildEvidencePointer, buildMention,
  MENTION_PRODUCER_VERSION, sourceVersionIdForInventory,
} from '../tools/argument-mentions.mjs';
import { sha256 } from '../tools/lib.mjs';
import { buildPropositionObligationInventory } from '../tools/proposition-obligations.mjs';
import { inventoryMarkdown } from '../tools/recursive-contracts.mjs';

const inventoryFor = (path, content, corpus_digest = 'corpus:a') => inventoryMarkdown({
  path, content, source_sha: 'source:v1', corpus_digest,
});

function exactLocator(unit, surface) {
  const index = unit.locator.text.indexOf(surface);
  assert.notEqual(index, -1, `${surface} is present in fixture source`);
  const prefix = unit.locator.text.slice(0, index);
  const byteStart = unit.locator.byte_start + Buffer.byteLength(prefix, 'utf8');
  const start = unit.locator.start + (prefix.match(/\n/g) || []).length;
  return {
    file: unit.locator.file,
    start,
    end: start + (surface.match(/\n/g) || []).length,
    byte_start: byteStart,
    byte_end: byteStart + Buffer.byteLength(surface, 'utf8'),
    text: surface,
    text_digest: sha256(surface),
    block_id: unit.locator.block_id,
    block_address: unit.locator.block_address,
  };
}

function claimFor(unit, { id = 'claim:one', subject = 'router', object = 'AuditService', scope = {} } = {}) {
  return {
    id,
    proposition_key: `proposition:${id}`,
    core_proposition_key: `core:${id}`,
    evidence_key: `evidence:${id}`,
    repair_findings: [],
    semantic: {
      subject: { surface: subject, source_locator: exactLocator(unit, subject) },
      object_or_value: object,
      scope,
      support_sets: [{ mode: 'all_required', locators: [{ ...unit.locator, role: 'primary' }] }],
    },
    extraction: { unit_id: 'window:fixture' },
    extraction_provenance: [],
  };
}

function fixture(path = 'docs/rule.md', content = '# Rule\n\nThe router sends payload to AuditService.\n', corpus = 'corpus:a') {
  const sourceInventory = inventoryFor(path, content, corpus);
  const inventory = buildPropositionObligationInventory({ inventories: [sourceInventory] });
  const unit = inventory.units.find(row => row.locator.text.includes('router sends'));
  return { sourceInventory, inventory, unit };
}

function build(fixture_, claims = [], extra = {}) {
  return buildArgumentMentionSubstrate({
    inventory: fixture_.inventory,
    inventories: [fixture_.sourceInventory],
    claims,
    materialization_id: 'materialization:a1-fixture',
    ...extra,
  });
}

test('mention identity uses source version, exact occurrence bytes, role, and producer version but not corpus digest', () => {
  const left = fixture('docs/rule.md', undefined, 'corpus:left');
  const right = fixture('docs/rule.md', undefined, 'corpus:right');
  const leftResult = build(left, [claimFor(left.unit)]);
  const rightResult = build(right, [claimFor(right.unit)]);
  const select = result => {
    const ids = new Set(result.assertion_argument_obligations.flatMap(row => row.candidate_mention_ids));
    return result.mentions.filter(row => ids.has(row.mention_id))
      .map(row => [row.role, row.mention_id]).sort();
  };
  assert.deepEqual(select(leftResult), select(rightResult));

  const subjectObligation = leftResult.assertion_argument_obligations.find(row => row.role === 'subject');
  const subject = leftResult.mentions.find(row => row.mention_id === subjectObligation.candidate_mention_ids[0]);
  const pointer = leftResult.evidence_pointers.find(row => row.evidence_id === subject.evidence_id);
  const changedRole = buildMention({
    evidence_pointer: pointer,
    surface: subject.surface,
    role: 'object',
    mention_producer_version: MENTION_PRODUCER_VERSION,
  }).mention;
  assert.notEqual(subject.mention_id, changedRole.mention_id);
  const priorProducer = buildMention({
    evidence_pointer: pointer,
    surface: subject.surface,
    role: subject.role,
    mention_producer_version: 'argument-mentions@1',
  }).mention;
  assert.notEqual(subject.mention_id, priorProducer.mention_id);
});

test('claim-validated presentation differences recover an exact source occurrence', () => {
  const sourceInventory = inventoryFor('docs/formatted.md', '# 9. Reading this with `ontology.md`\n');
  const inventory = buildPropositionObligationInventory({ inventories: [sourceInventory] });
  const unit = inventory.units[0];
  const claim = {
    id: 'claim:formatted',
    proposition_key: 'proposition:formatted',
    core_proposition_key: 'core:formatted',
    evidence_key: 'evidence:formatted',
    repair_findings: [],
    semantic: {
      subject: { surface: 'Reading this with ontology.md', source_locator: unit.locator },
      object_or_value: 'documentary heading',
      support_sets: [{ mode: 'all_required', locators: [{ ...unit.locator, role: 'primary' }] }],
    },
    extraction: { unit_id: 'window:formatted' },
    extraction_provenance: [],
  };
  const result = buildArgumentMentionSubstrate({
    inventory,
    inventories: [sourceInventory],
    claims: [claim],
    materialization_id: 'materialization:formatted',
  });
  const obligation = result.assertion_argument_obligations.find(row => row.field_path === 'semantic.subject');
  const binding = result.argument_binding_coverage_receipts.find(row => row.obligation_id === obligation.obligation_id);
  assert.equal(binding.disposition, 'bound_to_exact_mention');
  const mention = result.mentions.find(row => row.mention_id === binding.selected_mention_ids[0]);
  const pointer = result.evidence_pointers.find(row => row.evidence_id === mention.evidence_id);
  assert.equal(pointer.pointer.exact_text, 'Reading this with `ontology.md');
});

test('EvidencePointer is a closed discriminated union without synthetic claim identity', () => {
  const metadata = buildEvidencePointer({
    source_version_id: 'source-version:one',
    pointer: {
      kind: 'repository_metadata',
      manifest_id: 'manifest:one',
      repository_id: 'repository:one',
      field_path: 'visibility',
      exact_value: 'private',
      digest: sha256('private'),
    },
  });
  assert.equal(metadata.pointer.kind, 'repository_metadata');
  assert.equal(Object.hasOwn(metadata, 'claim_id'), false);
  assert.throws(() => buildEvidencePointer({
    source_version_id: 'source-version:one',
    pointer: { ...metadata.pointer, claim_id: 'claim:synthetic' },
  }), error => error.code === 'INVALID_POINTER_SHAPE' && error.detail.unknown.includes('claim_id'));
  assert.throws(() => buildEvidencePointer({
    source_version_id: 'source-version:one', pointer: { kind: 'invented_pointer' },
  }), error => error.code === 'UNKNOWN_POINTER_KIND');
});

test('[falsifier: mention under-discovery] a planted missed surface makes its unit partial and names the uncovered span', () => {
  const held = fixture();
  const planted = exactLocator(held.unit, 'AuditService');
  const claim = claimFor(held.unit, { object: 'literal not present in source' });
  const result = build(held, [claim], { required_referential_spans: [planted] });
  const receipt = result.mention_discovery_coverage_receipts.find(row => row.source_unit_id === held.unit.id);
  assert.equal(receipt.disposition, 'partial_known_under_discovery');
  assert.deepEqual(receipt.findings[0].uncovered_span, {
    file: planted.file,
    start: planted.start,
    end: planted.end,
    byte_start: planted.byte_start,
    byte_end: planted.byte_end,
    text_digest: planted.text_digest,
  });
  const object = result.assertion_argument_obligations.find(row => row.field_path === 'semantic.object_or_value');
  const binding = result.argument_binding_coverage_receipts.find(row => row.obligation_id === object.obligation_id);
  assert.equal(binding.disposition, 'terminal_incomplete');
  assert.ok(binding.findings.some(row => row.code === 'DISCOVERY_COVERAGE_PREVENTS_SILENT_LITERAL'));
});

test('[falsifier: argument conservation] every claim argument has one obligation, one binding receipt, and one unit discovery citation without claim mutation', () => {
  const held = fixture();
  const claim = claimFor(held.unit, { scope: { namespace: 'AuditService' } });
  const before = JSON.stringify(claim);
  const result = build(held, [claim]);
  assert.equal(JSON.stringify(claim), before);
  assert.deepEqual(result.assertion_argument_obligations.map(row => row.field_path).sort(), [
    'semantic.object_or_value', 'semantic.scope.namespace', 'semantic.subject',
  ]);
  const bindings = new Map(result.argument_binding_coverage_receipts.map(row => [row.obligation_id, row]));
  const discovery = new Map(result.mention_discovery_coverage_receipts.map(row => [row.receipt_id, row]));
  for (const obligation of result.assertion_argument_obligations) {
    assert.ok(bindings.has(obligation.obligation_id));
    assert.equal(discovery.get(obligation.mention_discovery_coverage_receipt_id).source_unit_id,
      held.unit.id);
  }
});

test('[falsifier: example vocabulary] exact mentions in examples are retained but never promoted to concepts', () => {
  const held = fixture('docs/example.md', '# Example\n\n```text\nExampleService sends payload.\n```\n');
  const result = build(held);
  assert.ok(result.mentions.some(row => row.provenance_class === 'example'));
  assert.deepEqual(result.concepts, []);
});

test('[falsifier: generic surfaces] repeated generic text remains distinct exact occurrences', () => {
  const a = fixture('docs/a.md', '# A\n\nThe status is current.\n');
  const b = fixture('docs/b.md', '# B\n\nThe status is current.\n');
  const inventory = buildPropositionObligationInventory({ inventories: [a.sourceInventory, b.sourceInventory] });
  const result = buildArgumentMentionSubstrate({
    inventory,
    inventories: [a.sourceInventory, b.sourceInventory],
    materialization_id: 'materialization:generic',
  });
  const generic = result.mentions.filter(row => row.normalized_surface.includes('status'));
  assert.ok(generic.length >= 2);
  assert.equal(new Set(generic.map(row => row.mention_id)).size, generic.length);
  assert.deepEqual(result.concepts, []);
});

test('[falsifier: unsampled source] every contacted unit emits one receipt even when no claim cites it', () => {
  const sourceInventory = inventoryFor('docs/all.md', '# All\n\nThe router sends payload.\n\nThe worker stores proof.\n');
  const inventory = buildPropositionObligationInventory({ inventories: [sourceInventory] });
  const citedUnit = inventory.units.find(row => row.locator.text.includes('router sends'));
  const result = buildArgumentMentionSubstrate({
    inventory,
    inventories: [sourceInventory],
    claims: [claimFor(citedUnit, { object: 'payload' })],
    materialization_id: 'materialization:unsampled',
  });
  assert.equal(result.mention_discovery_coverage_receipts.length, inventory.units.length);
  assert.equal(new Set(result.mention_discovery_coverage_receipts.map(row => row.source_unit_id)).size,
    inventory.units.length);
  const unsampled = inventory.units.find(row => row.locator.text.includes('worker stores'));
  assert.equal(result.mention_discovery_coverage_receipts.find(row => row.source_unit_id === unsampled.id).disposition,
    'complete');
});

test('source-version identity ignores corpus membership and tracks exact source bytes', () => {
  const a = inventoryFor('docs/a.md', 'same\n', 'corpus:a');
  const b = inventoryFor('docs/a.md', 'same\n', 'corpus:b');
  const c = inventoryFor('docs/a.md', 'changed\n', 'corpus:a');
  assert.equal(sourceVersionIdForInventory(a), sourceVersionIdForInventory(b));
  assert.notEqual(sourceVersionIdForInventory(a), sourceVersionIdForInventory(c));
});
