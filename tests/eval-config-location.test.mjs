import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { configPaths, defaultEvaluationConfig, evaluationScratchRoot, externalResultsPath } from '../tools/eval/cli.mjs';

const root = new URL('..', import.meta.url).pathname;
const scratch = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
const outside = mkdtempSync(join(scratch, 'eval-config-'));
const configuration = {
  source_repository: '../estate', runtime_config: '../runtime.json', questions: 'questions.jsonl',
  keys: 'keys.jsonl', results_directory: 'results',
};

test('evaluation defaults to the external artifact-root configuration', () => {
  const artifact = join(outside, 'artifact-root');
  assert.equal(defaultEvaluationConfig({ repository: root, environment: { ASCRYBE_ARTIFACT_ROOT: artifact } }), join(artifact, 'evaluations', 'config.json'));
  assert.equal(evaluationScratchRoot({ repository: root, environment: { ASCRYBE_ARTIFACT_ROOT: artifact } }), join(artifact, 'evaluation-checkouts'));
  assert.equal(evaluationScratchRoot({ repository: root, environment: { ASCRYBE_ARTIFACT_ROOT: artifact, ASCRYBE_SCRATCH_DIR: join(outside, 'managed-scratch') } }), join(outside, 'managed-scratch'));
});

test('evaluation resolves every relative study path from its external config', () => {
  const configPath = join(outside, 'evaluations', 'config.json');
  const paths = configPaths(configuration, configPath, root);
  assert.equal(paths.questions, join(outside, 'evaluations', 'questions.jsonl'));
  assert.equal(paths.keys, join(outside, 'evaluations', 'keys.jsonl'));
  assert.equal(paths.results, join(outside, 'evaluations', 'results'));
});

// The destination must be one that cannot resolve elsewhere. `out` read as an ordinary repository
// directory until custody moved to an external volume; on a machine where it is a symlink the
// guard correctly allows it, and the test failed over a name rather than over the rule.
test('evaluation refuses results inside the repository', () => {
  assert.throws(() => configPaths({ ...configuration, results_directory: join(root, 'tests') }, join(outside, 'config.json'), root), /outside the repository/u);
});

test('evaluation refuses repository destinations behind existing and missing symlink paths', () => {
  const existingLink = join(outside, 'results-link');
  symlinkSync(root, existingLink, 'dir');
  assert.throws(() => configPaths({ ...configuration, results_directory: 'results-link' }, join(outside, 'config.json'), root), /outside the repository/u);

  const parentLink = join(outside, 'results-parent-link');
  symlinkSync(root, parentLink, 'dir');
  assert.throws(() => configPaths({ ...configuration, results_directory: 'results-parent-link/missing-leaf' }, join(outside, 'config.json'), root), /outside the repository/u);
});

test('evaluation refuses result-directory traversal into the repository', () => {
  const traversal = join(outside, 'results', relative(join(outside, 'results'), root));
  assert.throws(() => externalResultsPath(traversal, root), /outside the repository/u);
});

test('evaluation rechecks a result root redirected after creation', () => {
  const results = join(outside, 'results-rechecked');
  mkdirSync(results);
  assert.equal(externalResultsPath(results, root), results);
  rmSync(results, { recursive: true, force: true });
  symlinkSync(root, results, 'dir');
  assert.throws(() => externalResultsPath(results, root), /outside the repository/u);
});
