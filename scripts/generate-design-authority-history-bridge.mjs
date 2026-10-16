#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityScope, bridgeSchema, digest, documentSnapshot, governedPaths, ledgerSchema } from './design-authority-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Rebinding is explicit and requires the documentation to be committed first.
// Snapshot hashes protect exported trees without pretending to prove lost history.
function generate() {
  const documents = governedPaths(root).map(path => {
    const committed = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root });
    if (!committed.equals(readFileSync(join(root, path)))) throw new Error(`commit document before rebinding: ${path}`);
    const produced_at_commit_sha = execFileSync('git', ['log', '-1', '--format=%H', 'HEAD', '--', path], { cwd: root, encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/u.test(produced_at_commit_sha)) throw new Error(`missing public history: ${path}`);
    return { ...documentSnapshot(root, path), produced_at_commit_sha };
  });
  const ledger = `${JSON.stringify({ schema: ledgerSchema, scope: authorityScope, documents }, null, 2)}\n`;
  writeFileSync(join(root, 'DESIGN-AUTHORITY-LEDGER.json'), ledger);
  writeFileSync(join(root, 'DESIGN-AUTHORITY-HISTORY-BRIDGE.json'), `${JSON.stringify({
    schema: bridgeSchema,
    scope: authorityScope,
    verification: 'Snapshot bytes are verifiable without Git; commit provenance is checked only with available Git history.',
    ledger_sha256: digest(ledger),
  }, null, 2)}\n`);
  console.log('Rebound public documentation ledger and snapshot bridge.');
}

try { generate(); } catch (error) { console.error(error.message); process.exitCode = 1; }
