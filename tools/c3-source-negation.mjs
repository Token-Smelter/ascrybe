#!/usr/bin/env node
// Remove one exact C3a production guard in managed scratch and prove its focused test turns red.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();
const mutations = [
  {
    id: 'explicit_connection',
    pattern: 'connection target requires explicit credentials',
    old: "  if (!clean(uri) || !clean(username) || !clean(password)) {\n    fail('EXPLICIT_NEO4J_CONNECTION_REQUIRED', 'Neo4j URI, username, and password are required explicit inputs');\n  }\n",
    replacement: '',
  },
  {
    id: 'protected_ports',
    pattern: 'connection guard refuses both protected production ports',
    old: "  if (forbiddenPorts.has(parsed.port)) {\n    fail('PROTECTED_NEO4J_PORT', `Neo4j port ${parsed.port} is protected and cannot be used`);\n  }\n",
    replacement: '',
  },
  {
    id: 'policy_identity',
    pattern: 'RelationProjectionPolicy identity freezes every policy field',
    old: "  if (!exactEqual(policy, rebuilt)) {\n    fail('RELATION_POLICY_IDENTITY_MISMATCH', 'RelationProjectionPolicy identity differs from its exact frozen body');\n  }\n",
    replacement: '',
  },
  {
    id: 'selected_assertion',
    pattern: 'REL without a selected assertion fails closed',
    old: "  if (!serving) {\n    fail('REL_SELECTED_ASSERTION_MISSING', 'REL candidate does not resolve to one selected serving assertion', {\n      selected_tip_assertion_id: chain.selected_tip_assertion_id,\n    });\n  }\n",
    replacement: "  if (!serving) return { selected_assertion_id: chain.selected_tip_assertion_id };\n",
  },
  {
    id: 'policy_rejection',
    pattern: 'REL that violates the frozen policy fails closed',
    old: "  if (policyFailure) {\n    fail('REL_POLICY_REJECTED', `REL candidate violates frozen policy field ${policyFailure}`, {\n      requested_assertion_id: requestedAssertionId,\n      selected_tip_assertion_id: chain.selected_tip_assertion_id,\n      policy_field: policyFailure,\n    });\n  }\n",
    replacement: '',
  },
  {
    id: 'c1_supersession_tip',
    pattern: 'REL reconciliation asks C1 for the selected supersession tip',
    old: "    chain = resolveAssertionSupersession({ assertion_id: requestedAssertionId, ledger: supersessionLedger });\n",
    replacement: '',
  },
  {
    id: 'assertion_exclusion',
    pattern: 'excluded assertion or endpoint removes a previously live REL',
    old: "    !relation.assertion_ids.some(id => excludedAssertions.has(id))\n    && !excludedReferents.has(relation.subject_referent_id)\n    && !excludedReferents.has(relation.object_referent_id));\n",
    replacement: "    true\n    && !excludedReferents.has(relation.subject_referent_id)\n    && !excludedReferents.has(relation.object_referent_id));\n",
  },
  {
    id: 'endpoint_exclusion',
    pattern: 'excluded assertion or endpoint removes a previously live REL',
    old: "    && !excludedReferents.has(relation.subject_referent_id)\n    && !excludedReferents.has(relation.object_referent_id));\n",
    replacement: "    && true\n    && true);\n",
  },
  {
    id: 'access_metadata',
    pattern: 'projection validation detects content mutation',
    old: "  for (const node of nodes.values()) if (node.kind === 'EvidencePointer'\n    && !Object.hasOwn(node.properties, 'access_policy_id')) {\n    fail('PROJECTION_ACCESS_METADATA_MISSING',\n      `EvidencePointer ${node.node_id} lacks its commit-derived access policy metadata`);\n  }\n",
    replacement: '',
  },
  {
    id: 'mention_resolution_receipt',
    pattern: 'resolved mentions traverse to Referents',
    old: "    if (nodes.get(edge.from)?.kind !== 'Mention' || nodes.get(edge.to)?.kind !== 'Referent'\n      || !receipt || receipt.properties.disposition !== 'resolved'\n      || receipt.properties.selected_referent_id !== edge.to || !admitted.includes(edge.from)) {\n      fail('MENTION_RESOLUTION_EDGE_MISMATCH',\n        `RESOLVES_TO ${edge.from} -> ${edge.to} lacks its exact selected receipt`);\n    }\n",
    replacement: '',
  },
  {
    id: 'referent_display_properties',
    pattern: 'Referent nodes reject every name',
    old: "    if (forbidden.length) {\n      fail('REFERENT_DISPLAY_PROPERTY_FORBIDDEN',\n        `Referent ${node.node_id} contains forbidden display properties`, { forbidden });\n    }\n",
    replacement: '',
  },
  {
    id: 'rel_assertion_node',
    pattern: 'projection validation detects content mutation',
    old: "      || relation.assertion_ids.some(id => nodes.get(id)?.kind !== 'Assertion')\n",
    replacement: '',
  },
  {
    id: 'content_digest',
    pattern: 'projection validation detects content mutation',
    old: "  if (state.content_digest !== sha256(canonical(body))) {\n    fail('SERVING_CONTENT_DIGEST_MISMATCH', 'serving content digest differs from deterministic selected content');\n  }\n",
    replacement: '',
  },
  {
    id: 'zero_rel_null_sentinel',
    pattern: 'zero-REL verification excludes the OPTIONAL MATCH null sentinel',
    old: 'r IS NOT NULL AND (r.assertion_id IS NULL',
    replacement: '(r.assertion_id IS NULL',
  },
  {
    id: 'schema_await',
    pattern: 'projection schema setup creates and awaits every required index',
    old: "  await client.query('CALL db.awaitIndexes(300)');\n",
    replacement: '',
  },
  {
    id: 'exact_projection_ids',
    pattern: 'projection ID verification rejects same-count substitutions',
    old: "  return expected.length === actual.length\n    && exactEqual(expected.slice().sort(), actual.slice().sort());\n",
    replacement: '  return true;\n',
  },
  {
    id: 'verification_detail_ids',
    pattern: 'verification divergence reports category counts',
    old: '      missing_node_ids: boundedSetDifference(expectedNodeIds, actualNodeIds),\n',
    replacement: '      missing_node_ids: [],\n',
  },
  {
    id: 'retention_selected_head',
    pattern: 'retention keeps the selected projection',
    old: '  const keep = new Set([selected_projection_id]);\n',
    replacement: '  const keep = new Set();\n',
  },
];

function replaceExactly(source, mutation) {
  const first = source.indexOf(mutation.old);
  if (first < 0 || source.indexOf(mutation.old, first + 1) >= 0) {
    throw new Error(`C3a negation ${mutation.id} no longer matches exactly one production guard`);
  }
  return `${source.slice(0, first)}${mutation.replacement}${source.slice(first + mutation.old.length)}`;
}

export function runC3SourceNegations() {
  const source = readFileSync(join(root, 'tools/c3-serving-projection.mjs'), 'utf8');
  const heldRoot = mkdtempSync(join(scratch, 'estate-map-c3-negation-'));
  try {
    for (const mutation of mutations) {
      const candidate = join(heldRoot, mutation.id);
      mkdirSync(join(candidate, 'tools'), { recursive: true });
      mkdirSync(join(candidate, 'tests'), { recursive: true });
      for (const name of [
        'lib.mjs', 'readonly-guard.mjs', 'serving-assertions.mjs', 'claim-projection.mjs',
        'referent-identity.mjs', 'argument-mentions.mjs', 'c3-fixture-producer.mjs',
      ]) copyFileSync(join(root, 'tools', name), join(candidate, 'tools', name));
      copyFileSync(join(root, 'tests/c3-serving-projection.test.mjs'),
        join(candidate, 'tests/c3-serving-projection.test.mjs'));
      writeFileSync(join(candidate, 'tools/c3-serving-projection.mjs'), replaceExactly(source, mutation));
      let turnedRed = false;
      try {
        execFileSync(process.execPath, [
          '--test', `--test-name-pattern=${mutation.pattern}`,
          'tests/c3-serving-projection.test.mjs',
        ], { cwd: candidate, encoding: 'utf8', timeout: 20_000, stdio: 'pipe' });
      } catch (error) {
        if (error.status != null && error.status !== 0) turnedRed = true;
        else throw error;
      }
      if (!turnedRed) throw new Error(`C3a production guard ${mutation.id} was removed but its focused test stayed green`);
      console.log(`PASS C3a source negation: ${mutation.id} removal turned focused test red`);
    }
    console.log(`PASS C3a source negations: ${mutations.length}/${mutations.length} exact production guards are test-sensitive`);
    return mutations.length;
  } finally {
    rmSync(heldRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runC3SourceNegations(); }
  catch (error) {
    console.error(`FAIL C3a source negations: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
