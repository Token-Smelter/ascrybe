import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryMarkdown } from '../tools/recursive-contracts.mjs';
import {
  backfillCandidateContactLedger, buildCoverageReceipt, buildPropositionObligationInventory,
  isUnsafePredicateActorSurface, PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION,
} from '../tools/proposition-obligations.mjs';
import { sha256 } from '../tools/lib.mjs';

const source = [
  '# Contract',
  '',
  'The router is closed and lacks a fallback. Before Phase 8C, it must not invent vocabulary.',
  '',
  '- Do not invent rung vocabulary; defer with missing edge kinds.',
  '',
  '| Field | Rule |',
  '| --- | --- |',
  '| mode | live or historical |',
  '',
  '```yaml',
  'additionalProperties: false',
  'required: [mode]',
  '```',
  '',
].join('\n');

const inventory = sourceSha => inventoryMarkdown({
  path: 'contract.md', content: source, source_sha: sourceSha, corpus_digest: `corpus:${sourceSha}`,
});

test('constructor emits exact source units and child obligations below block granularity', () => {
  const built = buildPropositionObligationInventory({ inventories: [inventory('one')] });
  assert.equal(built.constructor_version, PROPOSITION_OBLIGATION_CONSTRUCTOR_VERSION);
  const kinds = new Set(built.units.map(row => row.unit_kind));
  assert.ok(kinds.has('sentence'));
  assert.ok(kinds.has('list_item'));
  assert.ok(kinds.has('table_row'));
  assert.ok(kinds.has('schema_property'));
  const obligationKinds = new Set(built.obligations.map(row => row.obligation_kind));
  for (const kind of ['main_clause', 'coordinated_clause', 'condition', 'prohibition', 'table_cell', 'schema_constraint']) {
    assert.ok(obligationKinds.has(kind), `missing ${kind}`);
  }
  const bytes = Buffer.from(source, 'utf8');
  for (const row of [...built.units, ...built.obligations]) {
    const locator = row.locator;
    const exact = bytes.subarray(locator.byte_start, locator.byte_end).toString('utf8');
    assert.equal(exact, locator.text);
    assert.equal(locator.text_digest, sha256(exact));
  }
});

test('candidate identity follows exact local dependencies rather than an unrelated global snapshot', () => {
  const left = buildPropositionObligationInventory({ inventories: [inventory('one')] });
  const right = buildPropositionObligationInventory({ inventories: [inventory('two')] });
  assert.deepEqual(left.units.map(row => row.id), right.units.map(row => row.id));
  assert.deepEqual(left.obligations.map(row => row.id), right.obligations.map(row => row.id));
});

test('contact ledger never promotes evidence overlap into semantic coverage', () => {
  const built = buildPropositionObligationInventory({ inventories: [inventory('one')] });
  const target = built.obligations.find(row => row.obligation_kind === 'coordinated_clause');
  const claim = { id: 'claim:touch', semantic: { support_sets: [{ locators: [{
    file: target.locator.file,
    byte_start: target.locator.byte_start,
    byte_end: target.locator.byte_end,
  }] }] } };
  const ledger = backfillCandidateContactLedger({ inventory: built, admitted_claims: [claim] });
  const row = ledger.rows.find(item => item.candidate_id === target.id);
  assert.equal(row.contact_state, 'contacted_by_admitted_claim');
  assert.deepEqual(row.explicit_coverage_receipt_ids, []);
  assert.equal(row.follow_up_eligible, true);
  assert.ok(row.eligibility_reasons.includes('child_obligation_requires_explicit_link'));
  assert.equal(JSON.stringify(ledger).includes('"claimed"'), false);
});

test('an abstention is explicitly unverified and can never certify source absence', () => {
  const receipt = buildCoverageReceipt({
    candidate_id: 'candidate:c1', execution_state: 'completed',
    disposition: 'abstained_unverified', attempt_id: 'attempt:a1', verification_status: 'unverified',
  });
  assert.equal(receipt.disposition, 'abstained_unverified');
  assert.throws(() => buildCoverageReceipt({
    candidate_id: 'candidate:c1', execution_state: 'completed', disposition: 'covered', attempt_id: 'a1',
  }), /may not use/);
});

test('scoped-focus constructor exposes grammatical actors instead of Markdown and table frames', () => {
  const fixture = [
    '# Handles', '',
    '8. **Revalidate semantic output.** LLM output is an untrusted proposal. The model cannot waive standards.',
    '',
    '2. **Canonical docs.** Two designs for the same topic = two feature folders.',
    '',
    '| Mapping | Status | Reason | Rule |',
    '| --- | --- | --- | --- |',
    '| coverage rungs | deferred | Missing intent-lineage edge kinds | Do not invent vocabulary |',
    '| event mapping | bridge | ready | effect bindings are bridge-owned, never event-supplied |',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'handles.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const surfaces = new Set(built.units.flatMap(row => row.subject_handles.map(handle => handle.surface)));
  for (const surface of ['LLM output', 'The model', 'Two designs for the same topic',
    'intent-lineage edge kinds', 'effect bindings']) assert.ok(surfaces.has(surface), surface);
  assert.equal([...surfaces].some(surface => surface.startsWith('| event mapping')), false);
  const focused = built.obligations.find(row => row.locator.text !== row.support_locator.text);
  assert.ok(focused.support_locator);
  assert.ok(focused.support_locator.byte_start <= focused.locator.byte_start);
  assert.ok(focused.locator.byte_end <= focused.support_locator.byte_end);
});

test('constructor preserves adjacent exact context and ordinal membership as explicit obligations', () => {
  const fixture = [
    '# Context', '',
    'Foreign projects submit a pinned receiver. Receiver-owned policy plus `intake_router@1.0` resolves that submission before execution.',
    '',
    '**Member 1 is `builtin/search.hill-climb`:** informed greedy local improvement.',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'context.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const anaphoric = built.units.find(row => row.locator.text.startsWith('Receiver-owned policy'));
  assert.ok(anaphoric.context_locators.some(locator => locator.text === 'Foreign projects submit a pinned receiver.'));
  assert.ok(anaphoric.context_locators.some(locator => locator.text === '# Context'));
  const ordinal = built.obligations.find(row => row.obligation_kind === 'ordinal_membership');
  assert.ok(ordinal);
  assert.match(ordinal.locator.text, /Member 1 is `builtin\/search\.hill-climb`/);
  assert.ok(ordinal.subject_handles.some(handle => handle.surface === 'builtin/search.hill-climb'
    && handle.handle_kind === 'membership_actor'));
});

test('constructor exposes exact structural subjects, table headers, and numbered-item obligations', () => {
  const fixture = [
    '# Structural', '',
    '| Event | Reducer action |',
    '| --- | --- |',
    '| `brew.activation_completed` | `{ activations_count: incrementOrSet }` |',
    '',
    '3. **`design/canon/recipes.md`** — the current Pattern/Potion/Brew model (context)',
    '',
    'Mechanical closure is deterministic; judgment closure remains fail-closed.',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'structural.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const dataRow = built.units.find(row => row.locator.text.includes('brew.activation_completed'));
  assert.ok(dataRow.subject_handles.some(handle => handle.surface === 'brew.activation_completed'
    && handle.handle_kind === 'table_row_subject'));
  assert.ok(dataRow.subject_handles.some(handle => handle.surface === '{ activations_count: incrementOrSet }'
    && handle.handle_kind === 'table_cell_reference'));
  assert.ok(dataRow.context_locators.some(locator => locator.text.includes('| Event | Reducer action |')));
  const numbered = built.units.find(row => row.unit_kind === 'list_item');
  assert.ok(numbered.subject_handles.some(handle => handle.surface === 'design/canon/recipes.md'
    && handle.handle_kind === 'list_item_subject'));
  assert.ok(built.obligations.some(row => row.source_unit_id === numbered.id
    && row.obligation_kind === 'ordinal_membership' && row.locator.text.trim() === '3.'));
  const closure = built.units.find(row => row.locator.text.startsWith('Mechanical closure'));
  assert.ok(closure.subject_handles.some(handle => handle.surface === 'Mechanical closure'));
  assert.ok(closure.subject_handles.some(handle => handle.surface === 'judgment closure'));
});

test('actor discovery rejects predicate phrases and retains the governing coordinated actor', () => {
  const fixture = [
    '# Actor safety', '',
    '**TL;DR:** Iterative Patterns keep their distinct worker topology but share one optional Recipe Engine control plane for atomic iteration state, append-only finding history, optional keep-best selection, and explicit stop-and-grade settlement.',
    '',
    'The §3 estimate puts ~75% of steady-state traffic on chip fan-out and list polling.',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'actor-safety.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const tldr = built.units.find(row => row.locator.text.includes('Iterative Patterns'));
  assert.ok(tldr.subject_handles.some(handle => handle.surface === 'Iterative Patterns'
    && handle.handle_kind === 'predicate_actor'));
  assert.equal(tldr.subject_handles.some(handle => handle.surface.startsWith('share one optional')),
    false);
  const estimate = built.units.find(row => row.locator.text.startsWith('The §3 estimate'));
  assert.ok(estimate.subject_handles.some(handle => handle.surface === 'The §3 estimate'));
  assert.equal(estimate.subject_handles.some(handle => handle.surface.includes('steady-')), false);
  assert.equal(isUnsafePredicateActorSurface('share one optional Recipe Engine control plane'), true);
  assert.equal(isUnsafePredicateActorSurface('Iterative Patterns'), false);
});

test('self-referential table columns expose their real owner and do not turn prose cells into actors', () => {
  const fixture = [
    '# Platform Recovery Program', '',
    '| Area | Authoritative dossier | This dossier\'s role |',
    '| --- | --- | --- |',
    '| Restart remediation | `design/incidents/restart/DESIGN.md` | References only; the router design in §3 reconciles with its `staged_dispatch_job` reconciler. |',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'table-owner.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const unit = built.units.find(row => row.locator.text.includes('Restart remediation'));
  const role = built.obligations.find(row => row.source_unit_id === unit.id
    && row.obligation_kind === 'table_cell' && row.table_column_index === 2);
  assert.equal(role.table_column_self_referential, true);
  assert.equal(role.table_has_self_referential_column, true);
  assert.ok(role.subject_handles.some(handle => handle.surface === 'This dossier'
    && handle.handle_kind === 'table_column_subject' && handle.table_column_index === 2));
  assert.ok(role.subject_handles.some(handle => handle.surface === 'the router design in §3'
    && handle.handle_kind === 'predicate_actor'));
  assert.equal(role.subject_handles.some(handle => handle.surface.startsWith('References only;')), false);
});

test('predicate actor prefixes cannot displace the longer exact grammatical actor', () => {
  const fixture = [
    '# Evidence', '',
    '| Witness | Finding |',
    '| --- | --- |',
    '| `server.mjs` | Live default is `high`; complexity gate controls session-turn capture. |',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'predicate-prefix.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const unit = built.units.find(row => row.locator.text.includes('complexity gate controls'));
  assert.ok(unit.subject_handles.some(handle => handle.surface === 'complexity gate'));
  assert.equal(unit.subject_handles.some(handle => handle.surface === 'complexity'), false);
});

test('rank columns remain ordinal values while the named technique owns the table row', () => {
  const fixture = [
    '# Roadmap', '',
    '| Rank | Technique and research source | Cost |',
    '| --- | --- | --- |',
    '| **5** | **Specification-aware prefix monitor** from the failure study | M–H |',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'rank.md', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  const unit = built.units.find(row => row.locator.text.includes('Specification-aware prefix monitor'));
  assert.ok(unit.subject_handles.some(handle => handle.surface === '5'
    && handle.handle_kind === 'table_ordinal_label' && handle.table_column_index === 0));
  assert.ok(unit.subject_handles.some(handle => handle.surface === 'Specification-aware prefix monitor'
    && handle.handle_kind === 'table_row_subject' && handle.table_column_index === 1));
  assert.equal(unit.subject_handles.some(handle => handle.surface === '5'
    && handle.handle_kind === 'table_row_subject'), false);
});

test('YAML sequence records remain schema properties with exact nested field handles', () => {
  const fixture = [
    '- id: <string>',
    '    type: <repo|service>',
    '    scope:',
    '      path: <string|null>',
    '      branch: <string|null>',
    '',
  ].join('\n');
  const built = buildPropositionObligationInventory({ inventories: [inventoryMarkdown({
    path: 'record.yaml', content: fixture, source_sha: 'source', corpus_digest: 'corpus',
  })] });
  assert.ok(built.units.length >= 5);
  assert.ok(built.units.every(unit => unit.unit_kind === 'schema_property'));
  const record = built.units.find(unit => unit.locator.text.startsWith('- id:'));
  const byPath = new Map(record.subject_handles.filter(handle => handle.schema_path)
    .map(handle => [handle.schema_path, handle]));
  for (const path of ['id', 'id.type', 'id.scope', 'id.scope.path', 'id.scope.branch']) assert.ok(byPath.has(path), path);
  assert.equal(byPath.get('id.scope.path').surface, 'path');
  assert.ok(record.context_locators.some(locator => locator.text === null) === false);
});
