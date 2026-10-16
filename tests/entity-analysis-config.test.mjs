import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEntityAnalysisConfig } from '../tools/entity-analysis-config.mjs';
import { deriveDomainPrepass } from '../tools/domain-prepass.mjs';
import { readDomainPrepassReceipts } from '../tools/annotate.mjs';
import { clusterSignals, scanFileForSignals, buildReport, reconcile } from '../tools/discover-entities.mjs';
import { deriveEntityLayer, parseShippedModel, produceEntityLayer, resolveIdColumn } from '../tools/entity-layer.mjs';

const config = validateEntityAnalysisConfig({
  model_path: 'parcel/model.ts', read_model_prefixes: ['parcel_view_'],
  id_aliases: { pkg: 'package' }, abbreviations: { pkg: 'package' },
  expected_findings: [{ entity: 'package', expected: 'discovered_undocumented' }],
});
const signals = scanFileForSignals('services/parcels/main.mjs', [
  'export function newId() { return `pkg-${crypto.randomUUID()}`; }',
  'context.envelopes.emit({kind: "package.created", payload: {}});',
].join('\n'));
const canon = { entities: [], non_entities: [], quick_reference_rows: 0, quick_reference_only: [], relative_path: 'docs/ontology.md' };

function report(entityConfig) {
  const grouped = clusterSignals(signals, { abbreviations: entityConfig?.abbreviations });
  return buildReport({ ...grouped, canon, reconciliation: reconcile(grouped.clusters, canon, { abbreviations: entityConfig?.abbreviations }), scan: {}, entityConfig });
}

test('configured discovery merges witnessed aliases and checks declared expectations', () => {
  const result = report(config);
  assert.deepEqual({ entities: result.clusters.map(row => row.entity), expectations: result.expectations.map(row => row.ok) },
    { entities: ['package'], expectations: [true] });
});

test('unconfigured discovery keeps aliases separate and counts skipped estate-specific checks', () => {
  const result = report(null);
  assert.deepEqual({ entities: result.clusters.map(row => row.entity), skipped: result.configuration_dispositions }, {
    entities: ['package', 'pkg'],
    skipped: ['abbreviation_expansion', 'expected_discovery'].map(feature => ({ disposition: 'skipped', reason: 'entity_analysis_unconfigured', feature, count: 1 })),
  });
});

test('identity aliases require explicit configuration', () => {
  const entities = new Set(['package']);
  assert.deepEqual([resolveIdColumn('parent_pkg_id', entities), resolveIdColumn('parent_pkg_id', entities, config.id_aliases)],
    [null, { entity: 'package', role: 'parent', alias: 'pkg' }]);
});

test('unconfigured entity layer records counted configuration dispositions', () => {
  const result = deriveEntityLayer({ facts: [], graph: { nodes: [] }, model: { entityKinds: new Map(), edgeKinds: new Map() } });
  assert.deepEqual(result.census.configuration_dispositions,
    ['read_model_prefixes', 'identity_aliases'].map(feature => ({ disposition: 'skipped', reason: 'entity_analysis_unconfigured', feature, count: 1 })));
});

test('configured model parses declared export names rather than an estate-specific default', () => {
  const configured = validateEntityAnalysisConfig({ model_entity_export: 'PARCEL_TYPES', model_edge_export: 'PARCEL_LINKS' });
  const source = "export const PARCEL_TYPES = [\n  'package',\n] as const;\nexport const PARCEL_LINKS = [\n  'contains',\n] as const;\n";
  const model = parseShippedModel(source, { repo: 'parcel', file: 'model.ts', entityConfig: configured });
  assert.deepEqual([...model.entityKinds.keys()], ['package']);
});

test('configured read-model prefixes prevent promotion without weakening schema evidence', () => {
  const facts = [{ kind: 'sqlite_table', repo: 'parcel', file: 'schema.sql', line: 1, table: 'parcel_view_packages', primary_key: ['id'] }];
  const model = { entityKinds: new Map([['parcel_view_package', { repo: 'parcel', file: 'model.ts', line: 2 }]]), edgeKinds: new Map() };
  const results = [config, { read_model_prefixes: [] }].map(entityConfig => deriveEntityLayer({ facts, graph: { nodes: [] }, model, entityConfig }));
  assert.deepEqual(results.map(result => result.census.entities_promoted), [0, 1]);
});

test('unconfigured model is a counted refusal rather than a hidden empty measurement', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'unconfigured-model-'));
  mkdirSync(join(root, 'facts'));
  writeFileSync(join(root, 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
  const result = await produceEntityLayer(join(root, 'graph.json'), join(root, 'result.entity-layer.jsonl'), { factsDir: join(root, 'facts'), estateRoot: root });
  assert.deepEqual(result.census.refusals.map(row => ({ refusal: row.refusal, count: row.count })), [{ refusal: 'shipped_model_unconfigured', count: 1 }]);
});

test('subject exclusions require configuration and missing configuration remains counted', () => {
  const graph = { nodes: [{ id: 'module:parcel:views/list.mjs', repo: 'parcel', kind: 'module', witnesses: [] }], edges: [] };
  const entityConfig = { subject_exclusions: [{ component: 'parcel', path_prefix: 'views/', reason: 'read_model' }] };
  const configured = deriveDomainPrepass(graph, [], { entityConfig });
  const unconfigured = deriveDomainPrepass(graph, []);
  assert.deepEqual({ exclusion: configured.receipts[0].exclusion_reason, status: unconfigured.receipts[0].status, skipped: unconfigured.census.configuration_dispositions }, {
    exclusion: 'read_model', status: 'no_anchor', skipped: [{ disposition: 'skipped', reason: 'entity_analysis_unconfigured', feature: 'subject_exclusions', count: 1 }],
  });
});

test('legacy receipt aliases normalize on read without rewriting historical bytes', async () => {
  const entityConfig = { subject_exclusions: [{ component: 'parcel', path_prefix: 'views/', reason: 'read_model' }], legacy_exclusion_aliases: { old_parcel_view: 'read_model' } };
  const receipt = deriveDomainPrepass({ nodes: [{ id: 'module:parcel:views/list.mjs', repo: 'parcel', kind: 'module', witnesses: [] }], edges: [] }, [], { entityConfig }).receipts[0];
  const historical = { ...receipt, schema: 'estate-map/domain-prepass-receipt/v1', exclusion_reason: 'old_parcel_view', reason: 'declared old_parcel_view exclusion' };
  const bytes = `${JSON.stringify(historical)}\n`;
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'legacy-receipt-'));
  const file = join(root, 'receipt.jsonl'); writeFileSync(file, bytes);
  const [loaded] = await readDomainPrepassReceipts(file, { entityConfig });
  assert.deepEqual({ schema: loaded.schema, label: loaded.exclusion_reason, bytesUnchanged: readFileSync(file, 'utf8') === bytes },
    { schema: 'estate-map/domain-prepass-receipt/v2', label: 'read_model', bytesUnchanged: true });
});

for (const value of [{ unknown: true }, { model_path: '../private.ts' }, { read_model_prefixes: ['.*'] },
  { id_aliases: { pkg: 1 } }, { expected_findings: [{ entity: 'package', expected: 'guessed' }] }, { model_entity_export: 'X.*' }]) {
  test(`invalid entity-analysis declaration is refused: ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateEntityAnalysisConfig(value), { code: 'ENTITY_ANALYSIS_CONFIG_INVALID' });
  });
}
