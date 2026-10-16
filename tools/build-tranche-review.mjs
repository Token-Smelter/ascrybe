#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTrancheBlindReview } from './tranche-evaluation.mjs';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) options[args[index].replace(/^--/, '')] = args[index + 1];
for (const name of ['population', 'gold', 'artifact', 'packet', 'key']) {
  if (!options[name]) throw new Error(`missing --${name}`);
}
const read = async file => JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
const write = async (file, value) => {
  const output = path.resolve(file), temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, output);
};
const review = buildTrancheBlindReview({
  population: await read(options.population), gold: await read(options.gold),
  artifact: await read(options.artifact), seed: options.seed,
  sample_size: Number(options['sample-size'] || 80),
});
await write(options.packet, review.packet);
await write(options.key, review.key);
console.log(JSON.stringify({ packet: path.resolve(options.packet), key: path.resolve(options.key),
  opportunities: review.packet.opportunity_frame.length, precision: review.packet.precision_frame.length }));
