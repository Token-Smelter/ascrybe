#!/usr/bin/env node
// Empty claim map for a code-plane-only estate.
//
// The unified projection requires a digested claim-evidence map because every estate mapped so far
// carried documentary claims. An estate whose semantic campaign has not run yet still has a
// complete code plane worth projecting, and inventing placeholder claims to satisfy the shape
// would put unwitnessed rows in the graph. The stub instead declares the absence: zero claims,
// zero receipts, and a digest over exactly that emptiness bound to the estate's source identity,
// so a later real claim map produces a different projection identity rather than silently
// replacing this one.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stableStringify } from './lib.mjs';
import { sourcePins } from './source-pin-identity.mjs';

export const CLAIM_MAP_STUB_SCHEMA = 'estate-map/claim-evidence-map/v1';

export function emptyClaimMap({ project_id: projectId, code_graph: codeGraph }) {
  const pins = sourcePins(codeGraph?.provenance);
  if (!pins?.digest) throw new Error('code graph provenance must declare source_head or source_pins');
  const body = {
    schema: CLAIM_MAP_STUB_SCHEMA,
    project: { id: projectId, sha: pins.digest },
    claims: [], evidence: [], obligation_results: [], adjudication_receipts: [],
    supersession_receipts: [], edges: [],
    coverage: { semantic_claims: 0, terminal_receipts: 0 },
    policy: { claim_plane: 'absent', reason: 'code-plane-only estate: no documentary claim campaign has run' },
  };
  return Object.freeze({ ...body, digest: sha256(stableStringify(body).trim()) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [codeGraphPath, projectId, output] = process.argv.slice(2);
  if (!codeGraphPath || !projectId || !output) {
    console.error('usage: claim-map-stub <adjacency.json> <project-id> <output.json>');
    process.exitCode = 1;
  } else {
    const codeGraph = JSON.parse(readFileSync(resolve(codeGraphPath), 'utf8'));
    const map = emptyClaimMap({ project_id: projectId, code_graph: codeGraph });
    writeFileSync(resolve(output), `${JSON.stringify(map, null, 2)}\n`);
    console.log(JSON.stringify({ project: map.project, digest: map.digest }, null, 2));
  }
}
