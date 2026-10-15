#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { scorePairedBlindReview } from './paired-gate-evaluation.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  return out;
}
async function readJson(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function writeJson(file, value) {
  const target = path.resolve(file), temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

const options = args(process.argv.slice(2));
for (const name of ['packet', 'key', 'grades', 'control', 'treatment', 'rejection-audit', 'output']) {
  if (!options[name]) throw new Error(`--${name} required`);
}
const grade = scorePairedBlindReview({
  packet: await readJson(options.packet), key: await readJson(options.key), grades: await readJson(options.grades),
  artifacts: { control: await readJson(options.control), treatment: await readJson(options.treatment) },
  rejection_audit: await readJson(options['rejection-audit']),
});
await writeJson(options.output, grade);
console.log(JSON.stringify({ output: path.resolve(options.output), pass: grade.pass, checks: grade.checks }));
