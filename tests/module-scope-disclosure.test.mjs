import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeFacts } from '../tools/merge.mjs';

const fixtureFact = (kind, fields) => ({ kind, repo: 'app', file: 'src/worker.mjs', line: 1, ...fields });

test('module entities disclose declarations refused for non-nameable scopes without naming them', async () => {
  const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  const root = mkdtempSync(join(scratch, 'module-scope-disclosure-'));
  const facts = join(root, 'facts');
  try {
    mkdirSync(facts);
    writeFileSync(join(facts, 'app.jsonl'), [
      { kind: 'repo', repo: 'app', file: '.', line: 1, name: 'app', root: '.', head_sha: 'fixture' },
      fixtureFact('module', { language: 'javascript', end_line: 10 }),
      fixtureFact('symbol', { line: 2, name: 'visible', symbol_kind: 'function', scope_path: ['visible'] }),
      fixtureFact('symbol', { line: 5, name: 'local', symbol_kind: 'const' }),
      fixtureFact('symbol', { line: 7, name: 'callback', symbol_kind: 'function', scope_path: [] }),
    ].map(row => JSON.stringify(row)).join('\n').concat('\n'));
    const graph = await mergeFacts(facts, join(root, 'merge'));
    const module = graph.nodes.find(node => node.kind === 'module');
    assert.deepEqual({
      refusal_count: module.declaration_scope_not_nameable_count,
      module_count: graph.nodes.filter(node => node.kind === 'module').length,
      symbol_count: graph.nodes.filter(node => node.kind === 'symbol').length,
    }, { refusal_count: 2, module_count: 1, symbol_count: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
