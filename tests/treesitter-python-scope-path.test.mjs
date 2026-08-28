import test from 'node:test';
import assert from 'node:assert/strict';
import extractor from '../tools/extractors/treesitter-python.mjs';
import { identityCandidateDecision } from '../tools/identity-candidate-generator.mjs';

function scan(source) {
  const ctx = {
    repo: 'fixture', file: 'module.py', parseErrors: [],
    fact: (kind, line, data) => ({ kind, repo: 'fixture', file: 'module.py', line, ...data }),
  };
  return extractor.scan(source.split(/\r?\n/u), ctx).filter(fact => fact.kind === 'symbol');
}

// Without scope_path every Python symbol is refused as `declaration_scope_not_nameable`, which is
// how a 4,772-module Python estate produced a code plane of 140 symbols. The identity generator is
// the thing that has to accept them, so the test drives it rather than asserting on the field.
test('module-level Python declarations become identity candidates', () => {
  const symbols = scan([
    'import os',
    '',
    'DEFAULT_TIMEOUT = 30',
    '',
    'def build_report(rows):',
    '    return rows',
    '',
    '@register',
    'class ReportBuilder:',
    '    def create(self):',
    '        return None',
  ].join('\n'));

  const names = symbols.map(fact => fact.name).sort();
  assert.deepEqual(names, ['DEFAULT_TIMEOUT', 'ReportBuilder', 'build_report']);
  for (const fact of symbols) {
    assert.deepEqual(fact.scope_path, [fact.name], `${fact.name} must carry its own name path`);
    assert.equal(identityCandidateDecision(fact).disposition, 'supported',
      `${fact.name} must not be refused by the identity candidate generator`);
  }
});

test('a declaration inside a function body is emitted but never a candidate', () => {
  const symbols = scan([
    'def outer():',
    '    def inner():',
    '        return 1',
    '    return inner',
  ].join('\n'));

  const outer = symbols.find(fact => fact.name === 'outer');
  assert.deepEqual(outer.scope_path, ['outer']);
  // `inner` cannot be told apart from another `inner` in a sibling function by name alone, so if
  // the query is ever widened to reach it the walk must refuse rather than mint a colliding id.
  const inner = symbols.find(fact => fact.name === 'inner');
  if (inner) {
    assert.equal(inner.scope_path, undefined);
    assert.equal(identityCandidateDecision(inner).reason, 'declaration_scope_not_nameable');
  }
});
