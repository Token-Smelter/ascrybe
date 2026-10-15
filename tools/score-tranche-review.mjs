#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { scoreTrancheBlindReview } from './tranche-evaluation.mjs';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/, '')] = args[index + 1];
for (const name of ['population', 'gold', 'artifact', 'packet', 'key', 'grades', 'rejection-audit', 'output']) {
  if (!options[name]) throw new Error(`missing --${name}`);
}
const read = async file => JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
const controller = options.controller ? await read(options.controller) : null;
const grade = scoreTrancheBlindReview({
  population: await read(options.population), gold: await read(options.gold),
  artifact: await read(options.artifact), packet: await read(options.packet), key: await read(options.key),
  grades: await read(options.grades), rejection_audit: await read(options['rejection-audit']),
  expected_contract: options.contract || 'v10',
  controller, require_load_audit: Boolean(controller),
});
const output = path.resolve(options.output), temporary = `${output}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(grade, null, 2)}\n`, 'utf8');
await fs.rename(temporary, output);
console.log(JSON.stringify({ output, pass: grade.pass, checks: grade.checks, metrics: grade.metrics }));
