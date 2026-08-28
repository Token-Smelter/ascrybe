#!/usr/bin/env node
// Pack a projection for another Ascrybe user, or load one they sent.
//
//   node scripts/projection-package-cli.mjs pack   --claim-map-shards <dir> --code-graph <file> \
//                                                  --projection-receipt <file> --out <dir>
//   node scripts/projection-package-cli.mjs verify --bundle <dir>
//   node scripts/projection-package-cli.mjs load   --bundle <dir> [--promote]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectionPackage, loadProjectionPackage, verifyProjectionPackage } from '../tools/projection-package.mjs';
import { projectEstateMap } from '../tools/project-estate-map.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FLAGS = new Set(['--claim-map-shards', '--code-graph', '--projection-receipt', '--remap-receipt',
  '--semantic-receipt', '--out', '--bundle', '--runtime-config']);
const SWITCHES = new Set(['--promote', '--allow-dirty', '--allow-version-drift']);

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (SWITCHES.has(flag)) { held[flag.slice(2).replace(/-/gu, '_')] = true; continue; }
    if (!FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index += 1];
    if (!value) throw new Error(`${flag} requires a value`);
    held[flag.slice(2).replace(/-/gu, '_')] = value;
  }
  return held;
}

/** What is about to leave this machine, stated before it does. */
function announce(discloses) {
  console.error('DISCLOSURE this package carries the estate itself, not a summary of it:');
  console.error(`  repositories        ${(discloses.repositories || []).join(', ') || '(unnamed)'}`);
  console.error(`  documents           ${discloses.documents ?? 'unreported'}`);
  console.error(`  claims              ${discloses.claims ?? 'unreported'}`);
  console.error(`  verbatim quotes     ${discloses.includes_verbatim_quotes ? 'INCLUDED' : 'excluded'}`);
  console.error(`  source file paths   ${discloses.includes_source_paths ? 'INCLUDED' : 'excluded'}`);
  console.error(`  mapped source code  ${discloses.includes_mapped_source ? 'INCLUDED' : 'excluded'}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  const options = parse(rest);
  if (command === 'pack') {
    const manifest = buildProjectionPackage({ ...options, repository });
    announce(manifest.discloses);
    console.log(JSON.stringify({ out: resolve(options.out), files: manifest.files.length,
      expects: manifest.expects, packaged_at_ascrybe_commit: manifest.packaged_at_ascrybe_commit }, null, 2));
  } else if (command === 'verify') {
    const held = verifyProjectionPackage(options.bundle);
    console.log(JSON.stringify({ files_checked: held.files_checked, mismatched: held.mismatched,
      expects: held.manifest.expects, discloses: held.manifest.discloses }, null, 2));
    if (held.mismatched.length) process.exitCode = 1;
  } else if (command === 'load') {
    const receipt = await loadProjectionPackage({ ...options, repository }, { projectEstateMap });
    announce(receipt.discloses);
    console.log(JSON.stringify(receipt, null, 2));
    console.log(receipt.reproduced
      ? `REPRODUCED ${receipt.projection_id}`
      : `NOT REPRODUCED expected ${receipt.expected_projection_id} got ${receipt.projection_id}`);
    if (!receipt.reproduced) process.exitCode = 1;
  } else {
    throw new Error('one of pack, verify, load is required');
  }
} catch (error) {
  console.error(`FAIL projection package: ${error.message}`);
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
  process.exitCode = 1;
}
