#!/usr/bin/env node
// Build the estate-map skill as a self-contained bundle.
//
// A skill is instructions plus the small executable surface an agent invokes, and the installed
// copy of ours pointed at absolute paths inside this checkout: it could not run anywhere else, and
// three days after installation it was two contract versions stale with nothing to notice. Both
// problems have the same cause — the bundle was assembled by hand.
//
// So the bundle is built, not copied. Its contents are the transitive import closure of the two
// read CLIs, which is a property of the code rather than a list someone maintains: a new import
// changes what ships automatically, and an import that reaches the projection builder makes the
// build fail rather than quietly shipping the write path.
//
// What does NOT ship, and must not: the Neo4j password, the runtime config naming this machine's
// repository paths, and the projection itself. The bundle reads its connection from a runtime
// config the consumer supplies, exactly as the CLIs already do.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESTATE_QUERY_CONTRACT_VERSION, querySurfaceContract } from '../tools/estate-graph-query.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINTS = ['tools/estate-graph-query.mjs', 'tools/estate-graph-cypher.mjs'];
// Reaching any of these from a read CLI means the read and write paths have grown back together.
const WRITE_SURFACE = ['estate-graph-projection.mjs', 'project-estate-map.mjs', 'extract.mjs',
  'merge.mjs', 'documented-assertions.mjs', 'assertion-relations.mjs'];
// A specifier list may span lines, so the scan must not stop at a newline: an import written
// across two lines was invisible to a single-line pattern, and the bundle it produced was missing
// a module it needed — the failure only appeared when the bundle was run somewhere else.
const RELATIVE_IMPORT = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Every local module the entry points reach, transitively. */
export function importClosure(entryPoints, repository = root) {
  const held = new Set();
  const visit = path => {
    const resolved = resolve(path);
    if (held.has(resolved)) return;
    held.add(resolved);
    const source = readFileSync(resolved, 'utf8');
    RELATIVE_IMPORT.lastIndex = 0;
    for (const match of source.matchAll(RELATIVE_IMPORT)) visit(resolve(dirname(resolved), match[1]));
  };
  for (const entry of entryPoints) visit(resolve(repository, entry));
  return [...held].map(path => relative(repository, path)).sort();
}

export function buildSkillBundle({ repository = root, out = join(root, 'dist', 'ascrybe-skill') } = {}) {
  const files = importClosure(ENTRY_POINTS, repository);
  const escaped = files.filter(file => WRITE_SURFACE.includes(file.split('/').pop()));
  if (escaped.length) {
    throw new Error(`the read surface reached the write path: ${escaped.join(', ')}. `
      + 'A skill bundle must not carry code that can stage or promote a projection.');
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of files) {
    const target = join(out, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repository, file), target);
  }
  const skill = readFileSync(join(repository, 'skills/ascrybe/SKILL.md'), 'utf8');
  const declared = /^surface_contract:\s*(\S+)\s*$/mu.exec(skill)?.[1];
  if (declared !== ESTATE_QUERY_CONTRACT_VERSION) {
    throw new Error(`SKILL.md declares ${declared ?? 'no contract'} but this build implements `
      + `${ESTATE_QUERY_CONTRACT_VERSION}; a bundle that ships a stale skill is the drift it exists to prevent.`);
  }
  // The bundle runs from wherever it was installed, so the instructions cannot name this machine.
  const portable = skill
    .replace(/cd \/home\/[^\n]*estate-map-runner[^\n]*\n/gu, 'cd "$(dirname "$0")"   # the installed bundle\n')
    .replace(/npm run map:query --/gu, 'node bin/estate-query.mjs --runtime-config "$ASCRYBE_CONFIG"')
    .replace(/npm run map:cypher --/gu, 'node bin/estate-cypher.mjs --runtime-config "$ASCRYBE_CONFIG"')
    .replace(/`\/home\/[^`]*estate-map-runner\/main`/gu, 'the installed bundle');
  writeFileSync(join(out, 'SKILL.md'), portable);
  mkdirSync(join(out, 'bin'), { recursive: true });
  // The CLIs run their main block only when process.argv[1] is their own file, so importing one
  // from a wrapper is a silent no-op — the first bundle exited 0 having done nothing. Call the
  // exported entry function instead, which is the interface those modules actually offer.
  for (const [name, entry, callable] of [
    ['estate-query.mjs', 'tools/estate-graph-query.mjs', 'runEstateGraphQueryCli'],
    ['estate-cypher.mjs', 'tools/estate-graph-cypher.mjs', 'runEstateCypherCli']]) {
    writeFileSync(join(out, 'bin', name), [
      '#!/usr/bin/env node',
      "// Bundle entry point; the implementation is the repository's own read CLI.",
      `import { ${callable} } from '../${entry}';`,
      '',
      'try {',
      `  console.log(JSON.stringify(await ${callable}(process.argv.slice(2)), null, 2));`,
      '} catch (error) {',
      "  console.error(JSON.stringify({ error: error.code ?? 'ESTATE_QUERY_FAILED', message: error.message,",
      '    detail: error.detail ?? null }));',
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'));
  }
  const contract = querySurfaceContract();
  const manifest = {
    schema: 'estate-map/skill-bundle/v1',
    surface_contract: ESTATE_QUERY_CONTRACT_VERSION,
    contract_digest: contract.digest,
    // Named, never valued: the consumer supplies the config and the credentials it points at.
    requires: { runtime_config: 'ASCRYBE_CONFIG', credentials: 'named by the runtime config, never bundled' },
    files: files.length,
    entry_points: ['bin/estate-query.mjs', 'bin/estate-cypher.mjs'],
  };
  writeFileSync(join(out, 'bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({ ...manifest, out, bundled_files: files });
}

/** Does an installed bundle still describe the surface it is talking to? */
export function verifySkillBundle({ path, contract }) {
  const manifest = JSON.parse(readFileSync(join(path, 'bundle.json'), 'utf8'));
  const matches = manifest.surface_contract === contract.contract && manifest.contract_digest === contract.digest;
  return Object.freeze({
    ok: matches,
    declared: { contract: manifest.surface_contract, digest: manifest.contract_digest },
    live: { contract: contract.contract, digest: contract.digest },
    // A version match with a digest mismatch is the interesting failure: same commands, changed
    // data model, which is exactly what a command-only digest missed.
    reason: matches ? null
      : manifest.surface_contract !== contract.contract ? 'contract version differs'
        : 'same contract version, different surface digest',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  try {
    if (command === 'verify') {
      const held = verifySkillBundle({ path: resolve(path ?? join(root, 'dist', 'ascrybe-skill')),
        contract: querySurfaceContract() });
      console.log(JSON.stringify(held, null, 2));
      if (!held.ok) process.exitCode = 1;
    } else {
      const held = buildSkillBundle({ out: path ? resolve(path) : undefined });
      console.log(JSON.stringify({ out: held.out, files: held.files,
        surface_contract: held.surface_contract, contract_digest: held.contract_digest }, null, 2));
    }
  } catch (error) {
    console.error(`FAIL skill bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
