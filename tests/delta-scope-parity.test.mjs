// [SHARED-PATH][PARITY]: `ascrybe update` (tools/delta-update-run.mjs) now applies `.estate-mapignore`
// (read through Git plumbing, not a checkout) and accepts the same `catalog_globs` a runtime config
// declares (`--catalog-globs`). This proves the two paths now route the EXACT SAME (file, extractor)
// unit set for the SAME real input and config, at the `planFileScopeExtraction()` level both paths
// share — not merely "explained" the way an unresolved divergence would be.
//
// FIXTURE SHAPE. tools/extract.mjs's `discoverRepositories()` is filesystem-only and estate-shaped:
// every immediate child directory of the passed root becomes its own component (README/tests/
// delta-shared-path-update.test.mjs's own "byte-identical FACT CONTENT" case already establishes
// this: its ordinary-side fixture is `<estate>/<repo>/widget.mjs`, never `<repo>/widget.mjs`
// directly). `ascrybe update` has no such wrapping estate — one pinned Git repository per declared
// member, addressed repository-relative. Both sides' `catalog_globs` matching and `.estate-mapignore`
// prefix matching already operate on that SAME repository-relative path
// (tools/file-extraction-adapter.mjs sets `ctx.file`/`normalized_path` from the component-relative
// path on one side and the Git-tree-relative path on the other), so this fixture shape difference is
// a caller-context fact, not a scope difference: `.estate-mapignore` lives at each side's own root
// (the container's root for the ordinary path, the repository's own root for the delta path) and
// names the SAME logical directory, just with the addressing prefix its own side actually uses.
// Every name here is invented (CONTRIBUTING.md).
import { fixtureTest, mkdtempSync } from './helpers/fixture-lifecycle.mjs';
const test = fixtureTest(import.meta.url);
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEstateUpdate, runUpdateCommand } from '../tools/delta-update-run.mjs';
import { extractEstate } from '../tools/extract.mjs';

function scratchDir(prefix) {
  const base = process.env.ASCRYBE_SCRATCH_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function initRepo(dir) {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'nobody@example.invalid']);
  git(dir, ['config', 'user.name', 'Invented Committer']);
}
function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
const REPO = 'invented-estate';
const CATALOG_GLOBS = ['.invented/catalog.yaml'];

function unitKeys(plan) {
  return new Set(plan.expected_units.map(unit => `${unit.normalized_path}\u0000${unit.extractor_id}`));
}

function writeFixtureFiles(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'app.mjs'), 'export function ownSource() { return 1; }\n');
  mkdirSync(join(root, '.invented'), { recursive: true });
  writeFileSync(join(root, '.invented', 'catalog.yaml'), 'id: invented-catalog-entry\ncommand: echo ok\n');
  mkdirSync(join(root, 'scratch-notes'), { recursive: true });
  writeFileSync(join(root, 'scratch-notes', 'ignored.mjs'), 'export function shouldNeverBeScanned() { return 1; }\n');
}

/** The Git-backed repository `ascrybe update` reads via plumbing. */
function buildDeltaRepo() {
  const repoDir = scratchDir('scope-parity-repo-');
  initRepo(repoDir);
  writeFixtureFiles(repoDir);
  // Delta path: no wrapping estate, so the ignore rule is repository-root-relative.
  writeFileSync(join(repoDir, '.estate-mapignore'), '# invented ignore file\nscratch-notes\n');
  const sha = commit(repoDir, 'add a catalog file, an ignored directory, and one real source file');
  return { repoDir, sha };
}

/** The plain-filesystem estate `tools/extract.mjs` reads directly, one repository as one immediate
 * child directory (the proven shape from tests/delta-shared-path-update.test.mjs). */
function buildOrdinaryEstate() {
  const estateRoot = scratchDir('scope-parity-estate-');
  writeFixtureFiles(join(estateRoot, REPO));
  // Ordinary path: `.estate-mapignore` lives at the ESTATE root and its prefixes are
  // estate-relative (repository-name-prefixed) -- tools/extract.mjs reads it once, there.
  writeFileSync(join(estateRoot, '.estate-mapignore'), `# invented ignore file\n${REPO}/scratch-notes\n`);
  return estateRoot;
}

test('[PARITY] .estate-mapignore read via Git plumbing excludes the SAME directory the ordinary filesystem walk() excludes', async () => {
  const { repoDir, sha } = buildDeltaRepo();
  const estateRoot = buildOrdinaryEstate();

  const ordinaryOut = scratchDir('scope-parity-ordinary-out-');
  const ordinary = await extractEstate(estateRoot, ordinaryOut, { collectPlans: true });
  assert.equal(ordinary.plans.length, 1, 'the fixture must resolve to exactly one component, or this comparison is not apples-to-apples');
  const ordinaryPaths = new Set(ordinary.plans[0].plan.expected_units.map(unit => unit.normalized_path));
  assert.ok(!([...ordinaryPaths].some(path => path.startsWith('scratch-notes/'))), 'ordinary path must honor .estate-mapignore');
  assert.ok([...ordinaryPaths].some(path => path === 'app.mjs'), 'the fixture\u2019s real source file must still be in scope');

  const delta = planEstateUpdate({ pinManifest: { repositories: { [REPO]: { path: repoDir, ref: sha } } }, mode: 'full' });
  const deltaPaths = new Set(delta.plan.expected_units.map(unit => unit.normalized_path));
  assert.ok(!([...deltaPaths].some(path => path.startsWith('scratch-notes/'))), 'delta path must honor the SAME .estate-mapignore, read via Git plumbing');
  assert.ok(delta.excluded_paths.some(entry => entry.category === 'estate_mapignore' && entry.path === 'scratch-notes/ignored.mjs'),
    'the exclusion must be named, not silent');
  assert.deepEqual(ordinaryPaths, deltaPaths, 'the exact same set of repository-relative paths is in scope on both sides');
});

test('[PARITY] --catalog-globs routes the SAME file the ordinary path\u2019s catalog_globs routes, and the two paths agree when both omit it too', async () => {
  const { repoDir, sha } = buildDeltaRepo();

  // Arm A: BOTH paths given the SAME catalog_globs.
  const withGlobsOut = scratchDir('scope-parity-with-globs-out-');
  const ordinaryWithGlobs = await extractEstate(buildOrdinaryEstate(), withGlobsOut, { catalog_globs: CATALOG_GLOBS, collectPlans: true });
  const deltaWithGlobs = planEstateUpdate({
    pinManifest: { repositories: { [REPO]: { path: repoDir, ref: sha } } }, mode: 'full', catalogGlobs: CATALOG_GLOBS,
  });
  assert.deepEqual(unitKeys(deltaWithGlobs.plan), unitKeys(ordinaryWithGlobs.plans[0].plan),
    'with the SAME catalog_globs, the delta and ordinary paths expect the exact same (file, extractor) unit set');
  assert.ok([...unitKeys(deltaWithGlobs.plan)].some(key => key.startsWith('.invented/catalog.yaml\u0000')),
    'the catalog file must actually be routed when its glob is given');

  // Arm B: BOTH paths omit catalog_globs (the pre-existing default on each side).
  const withoutGlobsOut = scratchDir('scope-parity-without-globs-out-');
  const ordinaryWithoutGlobs = await extractEstate(buildOrdinaryEstate(), withoutGlobsOut, { collectPlans: true });
  const deltaWithoutGlobs = planEstateUpdate({ pinManifest: { repositories: { [REPO]: { path: repoDir, ref: sha } } }, mode: 'full' });
  assert.deepEqual(unitKeys(deltaWithoutGlobs.plan), unitKeys(ordinaryWithoutGlobs.plans[0].plan),
    'omitting catalog_globs on both sides also agrees exactly');

  // `catalog_entry`'s filePattern matches every YAML/JSON file regardless of catalog_globs (the
  // UNIT is always expected); catalog_globs instead gates its OUTPUT (tools/extractors/catalog-
  // records.mjs: `if (!matchesCatalog(...)) return [];`). So the real, checkable effect of the
  // flag is on RECORDS, not on which units exist -- prove that directly, on the delta side, so
  // this test cannot pass by coincidence.
  const catalogRecords = plan => plan.receipts
    .find(receipt => receipt.scope.normalized_path === '.invented/catalog.yaml' && receipt.extractor.id === 'catalog_entry')
    ?.output.records ?? [];
  assert.equal(catalogRecords(deltaWithoutGlobs.plan).length, 0, 'without catalog_globs, the catalog file yields no catalog_entry records');
  assert.ok(catalogRecords(deltaWithGlobs.plan).length > 0, 'with catalog_globs, the catalog file yields at least one catalog_entry record');
});

test('[PARITY] ascrybe update --catalog-globs <file> reads a standalone JSON array, not a full runtime config', () => {
  const { repoDir, sha } = buildDeltaRepo();
  const pinManifestPath = join(scratchDir('scope-parity-pins-'), 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { [REPO]: { path: repoDir, ref: sha } } }));
  const globsPath = join(scratchDir('scope-parity-globs-'), 'globs.json');
  writeFileSync(globsPath, JSON.stringify(CATALOG_GLOBS));
  const outDir = scratchDir('scope-parity-cli-out-');

  const result = runUpdateCommand([
    '--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outDir, '--catalog-globs', globsPath,
  ]);
  assert.equal(result.exit_code, 0, JSON.stringify(result));
});

test('[PARITY] the DEFAULT path (no --catalog-globs) reads catalog_globs from --runtime-config, matching an explicit --catalog-globs run', async () => {
  const { repoDir, sha } = buildDeltaRepo();
  const pinManifestPath = join(scratchDir('scope-parity-pins3-'), 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { [REPO]: { path: repoDir, ref: sha } } }));

  const runtimeConfigPath = join(scratchDir('scope-parity-runtime-config-'), 'ascrybe.config.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ catalog_globs: CATALOG_GLOBS }));
  const defaultOut = scratchDir('scope-parity-cli-default-out-');
  const defaultResult = runUpdateCommand([
    '--pin-manifest', pinManifestPath, '--mode', 'full', '--output', defaultOut, '--runtime-config', runtimeConfigPath,
  ]);
  assert.equal(defaultResult.exit_code, 0, JSON.stringify(defaultResult));

  const globsPath = join(scratchDir('scope-parity-explicit-globs-'), 'globs.json');
  writeFileSync(globsPath, JSON.stringify(CATALOG_GLOBS));
  const explicitOut = scratchDir('scope-parity-cli-explicit-out-');
  const explicitResult = runUpdateCommand([
    '--pin-manifest', pinManifestPath, '--mode', 'full', '--output', explicitOut, '--catalog-globs', globsPath,
  ]);
  assert.equal(explicitResult.exit_code, 0, JSON.stringify(explicitResult));

  const defaultManifest = JSON.parse(readFileSync(join(defaultOut, 'estate-build-manifest.json'), 'utf8'));
  const explicitManifest = JSON.parse(readFileSync(join(explicitOut, 'estate-build-manifest.json'), 'utf8'));
  assert.deepEqual(defaultManifest.units.expected, explicitManifest.units.expected,
    'reading catalog_globs from the runtime config by default expects the exact same unit set as passing it explicitly');
  assert.ok(defaultManifest.units.expected.length > 0);
});

test('[PARITY] a missing runtime config at the default path is not an error -- still no live estate required', () => {
  const { repoDir, sha } = buildDeltaRepo();
  const pinManifestPath = join(scratchDir('scope-parity-pins4-'), 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { [REPO]: { path: repoDir, ref: sha } } }));
  const outDir = scratchDir('scope-parity-cli-out4-');
  const nonexistentRuntimeConfig = join(scratchDir('scope-parity-empty-'), 'does-not-exist.json');

  const result = runUpdateCommand([
    '--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outDir, '--runtime-config', nonexistentRuntimeConfig,
  ]);
  assert.equal(result.exit_code, 0, JSON.stringify(result));
});

test('[PARITY] an invalid --catalog-globs file is a typed operational failure, never a silent empty array', () => {
  const { repoDir, sha } = buildDeltaRepo();
  const pinManifestPath = join(scratchDir('scope-parity-pins2-'), 'pins.json');
  writeFileSync(pinManifestPath, JSON.stringify({ repositories: { [REPO]: { path: repoDir, ref: sha } } }));
  const globsPath = join(scratchDir('scope-parity-badglobs-'), 'globs.json');
  writeFileSync(globsPath, JSON.stringify(['/absolute-not-allowed']));
  const outDir = scratchDir('scope-parity-cli-out2-');

  const result = runUpdateCommand([
    '--pin-manifest', pinManifestPath, '--mode', 'full', '--output', outDir, '--catalog-globs', globsPath,
  ]);
  assert.equal(result.exit_code, 4);
  assert.equal(result.reason_code, 'RUNTIME_CONFIG_CATALOG_GLOBS_INVALID');
});
