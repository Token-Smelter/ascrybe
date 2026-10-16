#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fail = message => {
  console.error(`FAIL census-partition-consistency: ${message}`);
  process.exit(1);
};

const censusPath = process.argv[2] ? resolve(process.argv[2]) : null;
if (!censusPath) fail('usage: node scripts/check-identity-candidate-census.mjs <census.json>');

const census = JSON.parse(readFileSync(censusPath, 'utf8'));
if (census.schema !== 'estate-map/identity-candidate-census/v2') fail(`unexpected schema ${census.schema}`);
if (!Array.isArray(census.kinds) || !census.kinds.length) fail('kinds are missing');
if (!census.compiler_registry || typeof census.compiler_registry !== 'object') fail('compiler registry is missing');

const globalInventory = new Set();
let totalRows = 0;
for (const row of census.kinds) {
  const inventory = row.inventory_fact_ids;
  const eligible = row.eligible_fact_ids;
  const refusedByReason = row.refused_fact_ids_by_reason;
  if (!Array.isArray(inventory) || !Array.isArray(eligible) || !refusedByReason || typeof refusedByReason !== 'object') {
    fail(`${row.kind}: exact partition fields are missing`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(row.basis_field_value_digest || '')) {
    fail(`${row.kind}: basis field value digest is missing or malformed`);
  }
  if (!row.compiler_id || !row.compiler_version || !Array.isArray(row.contract_parser_dependency_ids)) {
    fail(`${row.kind}: compiler/dependency identity is incomplete`);
  }
  if (!row.provenance_class_counts || typeof row.provenance_class_counts !== 'object') {
    fail(`${row.kind}: provenance class counts are missing`);
  }
  if (inventory.length !== row.row_count || new Set(inventory).size !== inventory.length) {
    fail(`${row.kind}: inventory IDs are not exact and unique`);
  }
  const refused = Object.values(refusedByReason).flat();
  const partition = [...eligible, ...refused];
  if (new Set(partition).size !== partition.length) fail(`${row.kind}: eligible/refused partitions overlap or duplicate`);
  if (partition.length !== inventory.length) fail(`${row.kind}: partition cardinality differs from inventory`);
  const expected = [...inventory].sort().join('\n');
  const observed = [...partition].sort().join('\n');
  if (observed !== expected) fail(`${row.kind}: partition IDs differ from inventory IDs`);
  if (row.currently_admissible_count !== eligible.length) fail(`${row.kind}: admissible count disagrees with IDs`);
  for (const [reason, ids] of Object.entries(refusedByReason)) {
    if (!reason || !Array.isArray(ids) || row.refused_counts_by_reason?.[reason] !== ids.length) {
      fail(`${row.kind}: refusal taxonomy/count disagreement for ${reason || '<empty>'}`);
    }
  }
  if (row.candidate_status === 'contract_pending' && eligible.length !== 0) {
    fail(`${row.kind}: contract-pending compiler admitted identity`);
  }
  for (const factId of inventory) {
    if (globalInventory.has(factId)) fail(`duplicate producer fact ID across kinds: ${factId}`);
    globalInventory.add(factId);
  }
  totalRows += row.row_count;
}

if (totalRows !== census.total_rows || globalInventory.size !== census.total_rows) {
  fail('global inventory cardinality disagreement');
}
if (census.kinds.length !== census.total_kinds) fail('kind cardinality disagreement');

console.log(`PASS census-partition-consistency: ${census.total_rows} exact fact IDs partitioned over ${census.total_kinds} kinds`);
console.log('PASS census-partition-consistency: contract-pending kinds admit zero identities');
