#!/usr/bin/env node
// Zero-spend preservation of a purchased calibration unit that never produced an artifact.
// It reads an existing checkpoint, never dispatches, never repairs, and emits the paired map.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOSSIER_CALIBRATION_SCHEMA, DOSSIER_SPEC_SCHEMA, gradeDossierCalibration, loadCalibrationSource } from './dossier-calibration.mjs';
import { writeContextMapArtifacts } from './context-map-artifacts.mjs';
import { sha256, stableStringify } from './lib.mjs';
import { requireModel } from './neural-model-runner.mjs';

const canonical = value => stableStringify(value).trim();

export function summarizeCheckpoint(records) {
  const completions = records.filter(row => String(row.stage || '').endsWith('-completion') && row.value?.result);
  const costs = completions.map(row => Number(row.value.model_stats?.cost || row.value.result.usage?.cost || 0));
  return {
    stages: [...new Set(records.map(row => row.stage).filter(Boolean))].sort(),
    completions: completions.length,
    known_cost_usd: Number(costs.reduce((sum, value) => sum + value, 0).toFixed(6)),
    outcomes: completions.map(row => ({
      outcome: row.value.result.outcome,
      accepted: row.value.result.accepted,
      billing_status: row.value.result.billing_status,
      answer_bytes: row.value.result.answer_bytes ?? null,
      cost: Number(row.value.model_stats?.cost || 0),
    })),
  };
}

async function main() {
  const args = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i += 1) { if (!args[i].startsWith('--')) throw new Error(`unexpected argument ${args[i]}`); o[args[i].slice(2)] = args[++i]; }
  for (const required of ['spec', 'checkpoint', 'output', 'stage', 'version', 'failure-code']) if (!o[required]) throw new Error(`--${required} is required`);
  const estate = await fs.realpath(path.resolve(o.estate || 'estate'));
  const specPath = path.resolve(o.spec), spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
  if (spec.schema !== DOSSIER_SPEC_SCHEMA) throw new Error('INVALID_DOSSIER_SPEC');
  const expectedSha = (await fs.readFile(new URL('../ESTATE_SHA', import.meta.url), 'utf8')).trim();
  const source = await loadCalibrationSource({ estate, spec, expectedSha });
  const checkpointPath = path.resolve(o.checkpoint), checkpointRaw = await fs.readFile(checkpointPath, 'utf8');
  const records = checkpointRaw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const summary = summarizeCheckpoint(records);
  if (!summary.completions) throw new Error('CHECKPOINT_HAS_NO_PURCHASED_COMPLETION');
  const result = { schema: 'estate-map/context-reconciliation/v1', version: o.version, candidate_id: source.candidate.id, recursion: source.joint.recursion, packet_results: [], composition: null, relations: [], links: [], status: 'incomplete' };
  const body = {
    schema: DOSSIER_CALIBRATION_SCHEMA, calibration_id: spec.id, title: spec.title, stage: o.stage,
    authorization: { standing_iterative_evaluation: true, max_calls: 1, max_cost_usd: Number(o['max-cost'] || 2), automatic_retries: 0 },
    model: requireModel(o.model, 'calibration --model'), thinking: o.thinking || 'high', reconciliation_version: o.version, linker_version: null,
    spec_path: path.relative(process.cwd(), specPath), spec_digest: sha256(canonical(spec)), base_calibration: null,
    snapshot: source.snapshot, source_document: spec.source_document, query_terms: spec.query_terms, candidate: source.candidate,
    joint_packet: { total_bytes: source.joint.total_bytes, packet_ids: source.joint.packets.map(packet => packet.id), block_catalogs: source.joint.packets.map(packet => ({ packet_id: packet.id, catalog_digest: packet.catalog.digest, entries: packet.catalog.entries.map(entry => ({ token: entry.token, file: entry.file, start: entry.start, end: entry.end, digest: entry.digest })) })), recursion: source.joint.recursion },
    result, linking: null,
    failure: { code: o['failure-code'], message: o.message || 'purchased unit failed validation and was never retried', detail: summary },
    grade: gradeDossierCalibration({ result, spec, stage: o.stage }),
    budget: { max_calls: 1, max_known_cost_usd: Number(o['max-cost'] || 2), accounted_calls: summary.completions, in_flight_reservations: 0, known_cost_usd: summary.known_cost_usd, cost_status: 'complete', unpriced_attempts: 0, max_unpriced_attempts: 0, promotion_blocked: false },
    runner_stats: null,
    custody: { checkpoint_path: checkpointPath, checkpoint_digest: sha256(checkpointRaw), checkpoint_records: records },
  };
  const artifact = { ...body, digest: sha256(canonical(body)) };
  const output = path.resolve(o.output); await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'); await fs.rename(temporary, output);
  const stem = output.replace(/\.json$/i, '');
  const visualization = await writeContextMapArtifacts({ calibration: artifact, estate, mapPath: o.map || `${stem}-MAP.json`, htmlPath: o.html || `${stem}-MAP.html` });
  console.log(JSON.stringify({ output, failure: artifact.failure.code, known_cost_usd: summary.known_cost_usd, digest: artifact.digest, visualization }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
