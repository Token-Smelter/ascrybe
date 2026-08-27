#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { finalizeClaimMapShards } from '../tools/claim-map-shards.mjs';

const [outputDir, metadataPath, ...extra] = process.argv.slice(2);
if (!outputDir || !metadataPath || extra.length) {
  console.error('usage: node scripts/finalize-claim-map-shards.mjs <shard-directory> <source-metadata.json>');
  process.exitCode = 2;
} else {
  try {
    const manifest = await finalizeClaimMapShards({
      output_dir: resolve(outputDir),
      source_metadata: JSON.parse(readFileSync(resolve(metadataPath), 'utf8')),
    });
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(`FAIL claim-map shard finalization: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
