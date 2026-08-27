import test from 'node:test';
import assert from 'node:assert/strict';
import extractor from '../tools/extractors/config.mjs';
import { identityCandidateDecisions } from '../tools/identity-candidate-generator.mjs';

const scan = (file, source) => extractor.scan(source.split(/\r?\n/u), {
  repo: 'app', file, parseErrors: [],
  fact: (kind, line, fields) => ({ kind, repo: 'app', file, line, ...fields }),
});

test('valid JSON configuration emits one exact-file identity fact without changing URL observations', () => {
  const facts = scan('config/service-config.json', '{\n  "endpoint": "https://api.example.test/v1"\n}');
  assert.deepEqual(facts.map(fact => [fact.kind, fact.line]), [
    ['json_document', 1],
    ['config_value_url', 2],
  ]);
});

test('JSON path identities admit distinct files and refuse every duplicate path member', () => {
  const decisions = identityCandidateDecisions([
    { kind: 'json_document', repo: 'app', file: 'config/one.json', line: 1 },
    { kind: 'json_document', repo: 'app', file: 'config/one.json', line: 2 },
    { kind: 'json_document', repo: 'app', file: 'config/two.json', line: 1 },
  ]);
  assert.deepEqual(decisions.map(decision => decision.disposition === 'supported'
    ? { surface: decision.surface, basis: decision.candidate_basis }
    : decision.reason), [
    'duplicate_declaration_key',
    'duplicate_declaration_key',
    { surface: 'config/two.json', basis: { kind: 'declared_namespace_identity',
      namespace_key: '[\n  "app",\n  "json-document"\n]', declared_identifier: 'config/two.json' } },
  ]);
});
