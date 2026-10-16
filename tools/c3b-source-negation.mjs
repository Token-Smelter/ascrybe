#!/usr/bin/env node
// Remove each C3b display guard in managed scratch and prove only its focused negation turns red.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();
const mutations = [
  {
    id: 'invented_referent_label',
    pattern: 'invented Referent label fails closed',
    old: "    if (forbidden.length) {\n      fail('ATLAS_REFERENT_LABEL_FORBIDDEN', `Referent ${referent.referent_id} contains an invented display field`,\n        { forbidden });\n    }\n",
    replacement: '',
  },
  {
    id: 'statement_source_span',
    pattern: 'statement without an exact source span fails closed',
    old: "    if (!statement.sources?.length || statement.sources.some(source =>\n      !validDocumentSpan(source) && !validStructuredRecord(source))) {\n      fail('ATLAS_STATEMENT_SPAN_MISSING',\n        `statement ${statement.assertion_id} lacks exact documentary or structured-record custody`);\n    }\n",
    replacement: '',
  },
  {
    id: 'live_coverage_match',
    pattern: 'coverage figure that disagrees with graph facts fails closed',
    old: "  if (canonical(model.coverage) !== canonical(expectedCoverage)) {\n    fail('ATLAS_COVERAGE_MISMATCH', 'rendered coverage differs from live graph facts');\n  }\n",
    replacement: '',
  },
];

function replaceExactly(source, mutation) {
  const first = source.indexOf(mutation.old);
  if (first < 0 || source.indexOf(mutation.old, first + 1) >= 0) {
    throw new Error(`C3b negation ${mutation.id} no longer matches exactly one production guard`);
  }
  return `${source.slice(0, first)}${mutation.replacement}${source.slice(first + mutation.old.length)}`;
}

export function runC3bSourceNegations() {
  const source = readFileSync(join(root, 'tools/c3b-atlas.mjs'), 'utf8');
  const heldRoot = mkdtempSync(join(scratch, 'estate-map-c3b-negation-'));
  try {
    for (const mutation of mutations) {
      const candidate = join(heldRoot, mutation.id);
      mkdirSync(join(candidate, 'tools'), { recursive: true });
      mkdirSync(join(candidate, 'tests'), { recursive: true });
      for (const name of [
        'lib.mjs', 'readonly-guard.mjs', 'serving-assertions.mjs', 'claim-projection.mjs',
        'referent-identity.mjs', 'argument-mentions.mjs', 'c3-serving-projection.mjs',
      ]) copyFileSync(join(root, 'tools', name), join(candidate, 'tools', name));
      copyFileSync(join(root, 'tests/c3b-atlas.test.mjs'), join(candidate, 'tests/c3b-atlas.test.mjs'));
      writeFileSync(join(candidate, 'tools/c3b-atlas.mjs'), replaceExactly(source, mutation));
      let turnedRed = false;
      try {
        execFileSync(process.execPath, ['--test', `--test-name-pattern=${mutation.pattern}`,
          'tests/c3b-atlas.test.mjs'], { cwd: candidate, encoding: 'utf8', timeout: 20_000, stdio: 'pipe' });
      } catch (error) {
        if (error.status != null && error.status !== 0) turnedRed = true;
        else throw error;
      }
      if (!turnedRed) throw new Error(`C3b guard ${mutation.id} was removed but its focused test stayed green`);
      console.log(`PASS C3b source negation: ${mutation.id} removal turned focused test red`);
    }
    console.log(`PASS C3b source negations: ${mutations.length}/${mutations.length} exact production guards are test-sensitive`);
    return mutations.length;
  } finally {
    rmSync(heldRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runC3bSourceNegations(); }
  catch (error) {
    console.error(`FAIL C3b source negations: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
