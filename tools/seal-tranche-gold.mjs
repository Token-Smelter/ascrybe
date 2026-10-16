#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { sealTrancheGold } from './tranche-evaluation.mjs';

const [populationPath, draftPath, outputPath] = process.argv.slice(2);
if (!populationPath || !draftPath || !outputPath) {
  throw new Error('usage: seal-tranche-gold.mjs <population.json> <draft.json> <output.json>');
}
const population = JSON.parse(await fs.readFile(path.resolve(populationPath), 'utf8'));
const draft = JSON.parse(await fs.readFile(path.resolve(draftPath), 'utf8'));
const gold = sealTrancheGold({ population, draft });
const output = path.resolve(outputPath), temporary = `${output}.${process.pid}.tmp`;
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(temporary, `${JSON.stringify(gold, null, 2)}\n`, 'utf8');
await fs.rename(temporary, output);
console.log(JSON.stringify({ output, opportunities: gold.opportunities.length, digest: gold.digest }));
