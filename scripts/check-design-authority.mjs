#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityScope, bridgeSchema, digest, documentSnapshot, governedPaths, ledgerSchema } from './design-authority-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function check() {
  const ledgerBytes = readFileSync(join(root, 'DESIGN-AUTHORITY-LEDGER.json'));
  const ledger = JSON.parse(ledgerBytes);
  const bridge = JSON.parse(readFileSync(join(root, 'DESIGN-AUTHORITY-HISTORY-BRIDGE.json'), 'utf8'));
  if (ledger.schema !== ledgerSchema || ledger.scope !== authorityScope || bridge.schema !== bridgeSchema ||
      bridge.scope !== authorityScope || bridge.ledger_sha256 !== digest(ledgerBytes)) throw new Error('ledger or snapshot binding differs');
  const paths = governedPaths(root);
  if (JSON.stringify(ledger.documents.map(row => row.document_id)) !== JSON.stringify(paths)) throw new Error('published document coverage differs');
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const hasGit = gitRoot.status === 0 && resolve(gitRoot.stdout.trim()) === root;
  for (const row of ledger.documents) {
    const observed = documentSnapshot(root, row.document_id);
    if (observed.bytes !== row.bytes || observed.sha256 !== row.sha256) throw new Error(`governed document bytes differ: ${row.document_id}`);
    if (!/^[0-9a-f]{40}$/u.test(row.produced_at_commit_sha)) throw new Error(`invalid provenance: ${row.document_id}`);
    if (hasGit) {
      const latest = execFileSync('git', ['log', '-1', '--format=%H', 'HEAD', '--', row.document_id], { cwd: root, encoding: 'utf8' }).trim();
      if (latest !== row.produced_at_commit_sha) throw new Error(`committed provenance differs: ${row.document_id}`);
      const bytes = execFileSync('git', ['show', `${row.produced_at_commit_sha}:${row.document_id}`], { cwd: root });
      if (digest(bytes) !== row.sha256) throw new Error(`committed bytes differ: ${row.document_id}`);
    }
  }
  console.log(`design-authority mode: ${hasGit ? 'public-git' : 'snapshot-bytes (history not verified)'}`);
  console.log(`design-authority consistency: PASS (${paths.length} published documents)`);
}

try { check(); } catch (error) { console.error(`design-authority consistency: FAIL: ${error.message}`); process.exitCode = 1; }
