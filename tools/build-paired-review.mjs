#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPairedBlindReview } from './paired-gate-evaluation.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function readJson(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function writeJson(file, value) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

const options = args(process.argv.slice(2));
for (const name of ['control', 'treatment', 'gold', 'packet', 'key']) {
  if (!options[name]) throw new Error(`--${name} required`);
}
const review = buildPairedBlindReview({
  gold: await readJson(options.gold),
  arms: { control: await readJson(options.control), treatment: await readJson(options.treatment) },
  seed: options.seed || 'v9-paired-gate-review-20260804',
  sample_size: Number(options['sample-size'] || 40),
});
await writeJson(options.packet, review.packet);
await writeJson(options.key, review.key);
console.log(JSON.stringify({ packet: path.resolve(options.packet), key: path.resolve(options.key),
  opportunities: review.packet.opportunity_frame.length, precision: review.packet.precision_frame.length }));
