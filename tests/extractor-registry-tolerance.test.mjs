// Adversarial regression battery for the extractor registry's BOUNDED
// tolerance (adjudication wo-e86c657c, R1): an ERR_MODULE_NOT_FOUND whose
// unresolved specifier is NOT declared optional for its extractor must fail
// loudly, naming the extractor and the specifier. Every case runs against a
// scratch copy of the extractor tree — never the worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_EXTRACTORS = [
  'hcl', 'http', 'aws', 'dependencies', 'config', 'sql', 'sqlite-ddl', 'sql-dml',
  'envelopes', 'capabilities', 'yaml-catalog', 'catalog-records', 'declaration-comments', 'diagrams', 'document-structure', 'manifest-completeness', 'treesitter-js',
  'treesitter-swift', 'treesitter-kotlin', 'treesitter-csharp', 'treesitter-python',
];

async function scratchExtractorTree() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'extractor-tolerance-'));
  const tools = path.join(scratch, 'tools');
  await fs.mkdir(tools, { recursive: true });
  await fs.cp(path.join(repoRoot, 'tools', 'extractors'), path.join(tools, 'extractors'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'tools', 'treesitter'), path.join(tools, 'treesitter'), { recursive: true });
  for (const name of ['lib.mjs', 'readonly-guard.mjs']) {
    await fs.copyFile(path.join(repoRoot, 'tools', name), path.join(tools, name));
  }
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
  return scratch;
}

function loadRegistry(scratch) {
  const probe = [
    'const m = await import(process.argv[1]);',
    'const r = m.extractorAvailabilityReceipt;',
    'console.log(JSON.stringify({ available: r.available.map(e => e.extractor), exclusions: r.exclusions.map(e => [e.extractor, e.unresolved_specifier]) }));',
  ].join('\n');
  const indexUrl = pathToFileURL(path.join(scratch, 'tools', 'extractors', 'index.mjs')).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe, indexUrl], { encoding: 'utf8' });
}

async function withMutatedHcl(mutation, body) {
  const scratch = await scratchExtractorTree();
  try {
    const hcl = path.join(scratch, 'tools', 'extractors', 'hcl.mjs');
    if (mutation) await fs.appendFile(hcl, `\n${mutation}\n`);
    await body(loadRegistry(scratch));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

test('undeclared absent package in a working extractor fails loudly', async () => {
  await withMutatedHcl('import __absent from "totally-absent-pkg-xyz";', result => {
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
    assert.match(result.stderr, /hcl/);
    assert.match(result.stderr, /totally-absent-pkg-xyz/);
  });
});

test('typo\'d local import in a working extractor fails loudly', async () => {
  await withMutatedHcl('import __typo from "./does-not-exist.mjs";', result => {
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
    assert.match(result.stderr, /hcl/);
    assert.match(result.stderr, /\.\/does-not-exist\.mjs/);
  });
});

test('syntax error in an extractor still fails loudly', async () => {
  await withMutatedHcl('const __broken = ;', result => {
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}; stdout: ${result.stdout}`);
    assert.match(result.stderr, /SyntaxError/);
  });
});

test('unmodified tree loads every registered extractor without exclusions', async () => {
  await withMutatedHcl(null, result => {
    assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt.available, EXPECTED_EXTRACTORS);
    assert.deepEqual(receipt.exclusions, []);
  });
});
