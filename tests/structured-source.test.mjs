import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryMarkdown } from '../tools/recursive-contracts.mjs';
import { extractSectionReferences, extractStructuredObservations } from '../tools/structured-source.mjs';
import { prepassDocument } from '../tools/source-prepass.mjs';

const snapshot = { source_sha: 'sha', corpus_digest: 'digest' };
const inventoryFor = (file, content) => inventoryMarkdown({ path: file, content, ...snapshot });

test('JSON, strict YAML, and strict TOML produce parser-backed field observations', () => {
  const fixtures = [
    ['config.json', '{"server":{"port":4100},"enabled":true}\n', 'json_parser', ['server.port', 'enabled']],
    ['config.yaml', 'server:\n  port: 4100\n  enabled: true\n', 'strict_yaml_parser', ['server.port', 'server.enabled']],
    ['config.toml', '[server]\nport = 4100\nenabled = true\n', 'strict_toml_parser', ['server.port', 'server.enabled']],
  ];
  for (const [file, content, producer, expected] of fixtures) {
    const result = extractStructuredObservations({ file, content, inventory: inventoryFor(file, content) });
    assert.equal(result.findings.length, 0, file);
    assert.deepEqual(result.observations.map(row => row.field_path).sort(), expected.sort(), file);
    assert.ok(result.observations.every(row => row.producer === producer), `${file} records real producer provenance`);
    assert.ok(result.observations.every(row => row.authority_plane === 'deterministic_structure'));
    assert.ok(result.observations.every(row => row.evidence_class === 'runtime_configuration'));
  }
});

test('structured files under design/docs remain documentary rather than runtime authority', () => {
  const content = 'server:\n  port: 4100\n';
  const result = extractStructuredObservations({ file: 'design/canon/schemas/machine.yaml', content, inventory: inventoryFor('design/canon/schemas/machine.yaml', content) });
  assert.ok(result.observations.length > 0);
  assert.ok(result.observations.every(row => row.evidence_class === 'document_structured_data'));
  assert.ok(!result.observations.some(row => row.evidence_class === 'runtime_configuration'));
});

test('duplicate JSON leaf keys retain path-specific source lines', () => {
  const content = '{\n  "first": { "port": 4100 },\n  "second": {\n    "port": 4096\n  }\n}\n';
  const result = extractStructuredObservations({ file: 'config.json', content, inventory: inventoryFor('config.json', content) });
  const ports = result.observations.filter(row => row.field_path.endsWith('.port')).sort((a, b) => a.field_path.localeCompare(b.field_path));
  assert.deepEqual(ports.map(row => [row.field_path, row.source_span.start]), [['first.port', 2], ['second.port', 4]]);
});

test('JS/pseudocode fence is lexical document evidence, never YAML or runtime authority', () => {
  const content = [
    '# Schema',
    '',
    '```js',
    '{',
    '  key: "DASHBOARD_PORT",',
    '  yaml_path: "server.port",',
    '  force_local: true,',
    '  validate: (v) => Number(v) > 0,',
    '}',
    '```',
    '',
  ].join('\n');
  const prepass = prepassDocument({ path: 'DESIGN.md', content, ...snapshot });
  const rows = prepass.structured_observations;
  const surfaces = new Set(rows.flatMap(row => [row.field_path, String(row.value)]));
  assert.ok(surfaces.has('DASHBOARD_PORT'));
  assert.ok(surfaces.has('server.port'));
  assert.ok(surfaces.has('force_local'));
  assert.ok(rows.every(row => row.producer === 'lexical_example_scanner'));
  assert.ok(rows.every(row => row.evidence_class === 'document_example'));
  assert.ok(rows.every(row => row.syntax === 'js'));
  assert.ok(!rows.some(row => row.producer === 'strict_yaml_parser'), 'JS example is never misclassified as YAML');
});

test('a mermaid fence yields a typed finding and NO structured observations', () => {
  const content = [
    '# Router',
    '',
    '```mermaid',
    'flowchart LR',
    '  ROOT["Atomic root"] --> MATCH["Match"]',
    '  MATCH --> INBOX[("batch_inbox")]',
    '```',
    '',
    '```json',
    '{ "server": { "port": 7890 } }',
    '```',
    '',
  ].join('\n');
  const inventory = inventoryFor('design/features/x/DESIGN.md', content);
  const { observations, findings } = extractStructuredObservations({ file: 'design/features/x/DESIGN.md', content, inventory });
  const mermaid = observations.filter(row => row.syntax === 'mermaid');
  assert.equal(mermaid.length, 0, 'a diagram must not produce structured observations');
  assert.ok(!observations.some(row => row.field_path === row.value && /^[A-Z]+$/.test(row.field_path)),
    'no self-referential IDENT = IDENT observation survives');
  assert.equal(findings.filter(row => row.code === 'DIAGRAM_FENCE_NOT_STRUCTURED').length, 1);
  const diagram = extractStructuredObservations({ file: 'design/features/x/DESIGN.md', content, inventory }).diagram_identifiers;
  assert.ok(diagram.some(row => row.surface === 'ROOT'), 'diagram identifiers stay addressable as evidence');
  assert.ok(!diagram.some(row => row.surface.toLowerCase() === 'flowchart'), 'diagram keywords are not identifiers');
  const prepass = prepassDocument({ path: 'design/features/x/DESIGN.md', content, ...snapshot });
  assert.ok(prepass.mentions.some(row => row.surface === 'ROOT' && row.kind === 'diagram_identifier'),
    'suppressing false structure must not destroy the identifier as evidence');
  assert.ok(observations.some(row => row.field_path === 'server.port' && String(row.value) === '7890'),
    'a real structured fence in the same document still parses');
});

test('unsupported YAML features fail closed to lexical mentions with a typed finding', () => {
  const content = 'server: &defaults\n  port: 4100\n';
  const result = extractStructuredObservations({ file: 'config.yaml', content, inventory: inventoryFor('config.yaml', content) });
  assert.ok(result.findings.some(row => row.code === 'STRUCTURED_PARSE_FALLBACK'));
  assert.ok(result.observations.every(row => row.producer === 'lexical_example_scanner'));
});

test('section-reference parser resolves exact numbered headings and reports missing targets', () => {
  const content = [
    '# 1 Overview',
    '',
    'See §2.1 for the governing rule and §9 for the unavailable appendix.',
    '',
    '## 2.1 Governing rule',
    '',
    'The rule applies.',
    '',
  ].join('\n');
  const result = extractSectionReferences({ file: 'DESIGN.md', content, inventory: inventoryFor('DESIGN.md', content) });
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].number, '2.1');
  assert.equal(result.references[0].target.start, 5);
  assert.equal(result.references[0].producer, 'section_reference_parser');
  assert.ok(result.findings.some(row => row.code === 'UNRESOLVED_SECTION_REFERENCE' && row.number === '9'));
});
