#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib.mjs';

export const RUNTIME_PROJECT_QUERY_SCHEMA = 'estate-map/runtime-project-query/v1';
const canonical = value => stableStringify(value).trim();

function queryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function recordMatches(record, query) {
  return record.surface === query || record.fact_id === query
    || record.code_declarations.some(row => row.surface === query || row.fact_id === query
      || row.file === query)
    || record.documentary_occurrences.some(row => row.path === query);
}

export function queryRuntimeProject({ input_dir: inputDir, query }) {
  if (!inputDir || !isAbsolute(inputDir) || typeof query !== 'string' || !query) {
    throw queryError('RUNTIME_PROJECT_QUERY_INVALID', 'an absolute input directory and non-empty query are required');
  }
  const ledger = JSON.parse(readFileSync(join(inputDir, 'identity-decision-records.json'), 'utf8'));
  if (ledger.schema !== 'estate-map/runtime-project-identity-decisions/v1'
    || !Array.isArray(ledger.records) || ledger.count !== ledger.records.length) {
    throw queryError('RUNTIME_PROJECT_QUERY_LEDGER_INVALID', 'identity decision record is absent or incomplete');
  }
  const matches = ledger.records.filter(record => recordMatches(record, query));
  const body = {
    schema: RUNTIME_PROJECT_QUERY_SCHEMA,
    project: ledger.project,
    query,
    match: 'case-sensitive byte-exact surface, fact id, or file equality',
    full_census_denominator: ledger.count,
    matched_decisions: matches.length,
    records: matches,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

function parse(argv) {
  const held = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--input-dir', '--query', '--output'].includes(flag) || !argv[index + 1]) {
      throw queryError('RUNTIME_PROJECT_QUERY_ARGUMENT_INVALID', `unknown or incomplete argument: ${flag}`);
    }
    const value = argv[index + 1];
    index += 1;
    if (flag === '--input-dir') held.input_dir = resolve(value);
    else if (flag === '--query') held.query = value;
    else held.output = resolve(value);
  }
  return held;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parse(process.argv.slice(2));
    const result = queryRuntimeProject(args);
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(`FAIL runtime project query: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
