import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAtlasModel, renderAtlas, validateAtlasModel,
} from '../tools/c3b-atlas.mjs';
import { sha256, stableCanonicalSha256, stableStringify } from '../tools/lib.mjs';

function fixture() {
  const receiptId = 'resolution-receipt:one';
  const referentId = 'referent:one';
  const mentionId = 'mention:one';
  const assertionId = 'assertion:one';
  const nodes = [
    { node_id: 'graph-commit:one', kind: 'GraphCommit', properties: { identity_head: 'identity-head:one' } },
    { node_id: referentId, kind: 'Referent', properties: {
      schema: 'estate-map/referent/v1', identity_kind: 'resolved_opaque', lifecycle_state: 'active',
      creation_receipt_id: receiptId,
    } },
    { node_id: mentionId, kind: 'Mention', properties: {
      schema: 'estate-map/mention/v1', surface: 'Payments', role: 'subject', source_status: 'current',
    } },
    { node_id: 'evidence:one', kind: 'EvidencePointer', properties: {
      schema: 'estate-map/evidence-pointer/v1', document_path: 'design/payments.md',
      line_start: 12, line_end: 12, byte_start: 100, byte_end: 108,
      evidence_digest: 'digest:mention',
    } },
    { node_id: receiptId, kind: 'Receipt', properties: {
      schema: 'estate-map/resolution-receipt/v1', disposition: 'resolved', selected_referent_id: referentId,
      admitted_mention_ids_json: JSON.stringify([mentionId]), identity_constraint_ids_json: JSON.stringify(['constraint:one']),
    } },
    { node_id: 'constraint:one', kind: 'Constraint', properties: {
      schema: 'estate-map/identity-constraint/v1', left: mentionId, right: 'mention:alias',
      disposition: 'must_link', constraint_kind: 'identity', basis_json: JSON.stringify({ kind: 'source_cited_alias' }),
      basis_evidence_ids_json: JSON.stringify(['evidence:one']), basis_assertion_ids_json: JSON.stringify([]),
      source_status: 'current', valid_time_json: 'null', authority: 'deterministic_derivation',
      materialization_id: 'materialization:one',
    } },
    { node_id: assertionId, kind: 'Assertion', properties: {
      polarity: 'negated', modality: 'conditional', quantifier: 'all',
      scope_json: JSON.stringify({ region: 'checkout' }), conditions_json: JSON.stringify(['feature enabled']),
      valid_time_json: JSON.stringify({ start: '2026-01-01', end: null }), recorded_time: '2026-02-01',
      source_status: 'historical', decision_status: 'proposed',
    } },
    { node_id: 'predicate:one', kind: 'Predicate', properties: { value_json: JSON.stringify('owns') } },
    { node_id: 'literal:one', kind: 'Literal', properties: { literal_json: JSON.stringify('ledger') } },
    { node_id: 'claim:one', kind: 'DocumentaryClaim', properties: {
      support_spans_json: JSON.stringify([{
        document_path: 'design/payments.md', line_start: 12, line_end: 14,
        byte_start: 100, byte_end: 180, evidence_digest: 'digest:claim',
      }]),
    } },
  ];
  const edges = [
    { type: 'DERIVED_FROM', from: mentionId, to: 'evidence:one', properties: { basis_kind: 'evidence' } },
    { type: 'RESOLVES_TO', from: mentionId, to: referentId, properties: { resolution_receipt_id: receiptId } },
    { type: 'PREDICATE', from: assertionId, to: 'predicate:one', properties: {} },
    { type: 'ARGUMENT', from: assertionId, to: referentId, properties: {
      role: 'subject', argument_kind: 'referent', argument_index: 0,
      raw_mention_id: mentionId, resolution_receipt_id: receiptId,
    } },
    { type: 'ARGUMENT', from: assertionId, to: 'literal:one', properties: {
      role: 'object', argument_kind: 'literal', argument_index: 1,
    } },
    { type: 'DERIVED_FROM', from: assertionId, to: 'claim:one', properties: { basis_kind: 'claim' } },
  ];
  return buildAtlasModel({
    projection_id: 'projection:one', graph_commit_id: 'graph-commit:one', identity_head: 'identity-head:one',
    nodes, edges, source_documents: ['design/payments.md'],
    generation_inputs: { source_manifest: 'manifest.json', source_head: 'source-head:one' },
  });
}

test('statements preserve readable roles, qualifications, and exact source custody', () => {
  const statement = fixture().statements[0];
  assert.deepEqual({
    readable: statement.readable,
    polarity: statement.polarity,
    modality: statement.modality,
    quantifier: statement.quantifier,
    scope: statement.scope,
    conditions: statement.conditions,
    valid_time: statement.valid_time,
    source_status: statement.source_status,
    decision_status: statement.decision_status,
    source: statement.sources[0],
  }, {
    readable: 'Observed surfaces: “Payments” — owns — "ledger"',
    polarity: 'negated', modality: 'conditional', quantifier: 'all',
    scope: { region: 'checkout' }, conditions: ['feature enabled'],
    valid_time: { start: '2026-01-01', end: null }, source_status: 'historical', decision_status: 'proposed',
    source: { document_path: 'design/payments.md', line_start: 12, line_end: 14,
      byte_start: 100, byte_end: 180, evidence_digest: 'digest:claim' },
  });
});

test('entity pages contain exact mentions, roles, receipts, constraints, and provenance', () => {
  const model = fixture();
  const output = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'c3b-render-'));
  try {
    const rendered = renderAtlas(model, output);
    const entityFile = Object.keys(rendered.manifest.referent_surfaces)[0];
    const entityPage = readFileSync(join(output, 'entities',
      `referent-${sha256(entityFile).slice(0, 16)}.html`), 'utf8');
    const indexPage = readFileSync(join(output, 'index.html'), 'utf8');
    const entityLedger = readFileSync(join(output, 'ledgers/entities-0001.html'), 'utf8');
    const statementLedger = readFileSync(join(output, 'ledgers/statements-0001.html'), 'utf8');
    assert.deepEqual({
      pages: rendered.page_count,
      ledger_pages: rendered.manifest.ledger_pages,
      surfaces: rendered.manifest.referent_surfaces[entityFile],
      digest_matches_prior_serializer:
        rendered.manifest.digest === sha256(stableStringify(model).trim()),
      digest_matches_streaming: rendered.manifest.digest === stableCanonicalSha256(model),
      lightweight_index: !indexPage.includes('assertion:one')
        && indexPage.includes('ledgers/entities-0001.html')
        && indexPage.includes('ledgers/statements-0001.html'),
      self_contained_index: indexPage.includes('<style>:root{')
        && indexPage.includes("<script>(()=>{")
        && !indexPage.includes('href="assets/atlas.css"')
        && !indexPage.includes('src="assets/search.js"'),
      entity_ledger_has_referent: entityLedger.includes(entityFile),
      statement_ledger_has_assertion: statementLedger.includes('assertion:one'),
      entity_links_statement_shard:
        entityPage.includes('../ledgers/statements-0001.html#assertion-assertion:one'),
      hasMention: entityPage.includes('Payments'),
      hasReceipt: entityPage.includes('resolution-receipt:one'),
      hasConstraint: entityPage.includes('constraint:one'),
      hasProjection: entityPage.includes('projection:one'),
    }, { pages: 5, ledger_pages: { entities: 1, statements: 1 }, surfaces: ['Payments'],
      digest_matches_prior_serializer: true, digest_matches_streaming: true,
      lightweight_index: true, self_contained_index: true,
      entity_ledger_has_referent: true, statement_ledger_has_assertion: true,
      entity_links_statement_shard: true,
      hasMention: true, hasReceipt: true, hasConstraint: true, hasProjection: true });
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('invented Referent label fails closed', () => {
  const model = structuredClone(fixture());
  model.referents[0].display_label = 'Payments Platform';
  assert.throws(() => validateAtlasModel(model), error => error.code === 'ATLAS_REFERENT_LABEL_FORBIDDEN');
});

test('statement without an exact source span fails closed', () => {
  const model = structuredClone(fixture());
  model.statements[0].sources = [];
  assert.throws(() => validateAtlasModel(model), error => error.code === 'ATLAS_STATEMENT_SPAN_MISSING');
});

test('coverage figure that disagrees with graph facts fails closed', () => {
  const model = structuredClone(fixture());
  model.coverage.unresolved_mentions += 1;
  assert.throws(() => validateAtlasModel(model), error => error.code === 'ATLAS_COVERAGE_MISMATCH');
});

test('code-grounded assertions render their exact structured-record custody without Neo4j', () => {
  const assertionId = 'grounded-assertion:code';
  const evidenceId = 'evidence:code';
  const model = buildAtlasModel({
    projection_id: 'projection:combined', graph_commit_id: 'graph-commit:combined',
    identity_head: 'identity-head:combined', source_documents: [],
    generation_inputs: { code_plane_head: 'code-plane:one' },
    nodes: [
      { node_id: assertionId, kind: 'Assertion', properties: {
        raw_schema: 'estate-map/grounded-assertion/v1', polarity: 'affirmed',
        modality: 'descriptive', quantifier: 'one', scope_json: '[]', conditions_json: '[]',
        valid_time_json: 'null', recorded_time: '2026-08-02T11:19:50-07:00',
        source_status: 'current', decision_status: 'none',
      } },
      { node_id: 'predicate:code', kind: 'Predicate', properties: {
        value_json: JSON.stringify('deterministic-producer-emitted-record'),
      } },
      { node_id: 'literal:code', kind: 'Literal', properties: {
        literal_json: JSON.stringify({ kind: 'sqlite_table', table: 'jobs' }),
      } },
      { node_id: evidenceId, kind: 'EvidencePointer', properties: {
        schema: 'estate-map/evidence-pointer/v1', pointer_kind: 'structured_record',
        record_id: 'code-fact:one', record_schema_id: 'estate-map/extracted-code-fact/v1',
        record_field_path: '$', record_value_json: JSON.stringify({
          kind: 'sqlite_table', repo: 'api', file: 'schema.sql', line: 3, table: 'jobs',
        }), evidence_digest: 'digest:code',
      } },
    ],
    edges: [
      { type: 'PREDICATE', from: assertionId, to: 'predicate:code', properties: {} },
      { type: 'ARGUMENT', from: assertionId, to: 'literal:code', properties: {
        role: 'object', argument_kind: 'literal', argument_index: 0,
      } },
      { type: 'DERIVED_FROM', from: assertionId, to: evidenceId,
        properties: { basis_kind: 'grounding_evidence' } },
    ],
  });
  assert.deepEqual({
    plane: model.statements[0].plane,
    fact_kind: model.statements[0].sources[0].fact_kind,
    record_id: model.statements[0].sources[0].record_id,
  }, { plane: 'code', fact_kind: 'sqlite_table', record_id: 'code-fact:one' });
});
