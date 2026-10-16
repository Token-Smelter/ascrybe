// Durable, replayable output of the paid neural extraction stage.
//
// This artifact is the boundary between extraction and adjudication. It preserves complete claim
// records (including subject_refs, object_or_value, scope, valid_time, and verbatim provenance) so
// any number of adjudicators can receive the identical frozen extraction without another model call.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const EXTRACTION_ARTIFACT_SCHEMA = 'estate-map/neural-claim-extraction/v1';

export class ExtractionArtifactError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ExtractionArtifactError';
    this.code = code;
    this.detail = detail;
  }
}

const sem = record => record?.semantic ?? record ?? {};
const nonblank = value => typeof value === 'string' && value.trim().length > 0;

function validateSnapshot(snapshot) {
  if (!snapshot || !nonblank(snapshot.source_sha) || !nonblank(snapshot.corpus_digest)) {
    throw new ExtractionArtifactError('INVALID_SNAPSHOT', 'extraction artifact requires snapshot { source_sha, corpus_digest }');
  }
}

function validateClaim(claim, snapshot, index) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim) || !nonblank(claim.id)) {
    throw new ExtractionArtifactError('INVALID_CLAIM', `claims[${index}] must be an identified claim record`);
  }
  const body = sem(claim);
  if (body.source_sha !== snapshot.source_sha || body.corpus_digest !== snapshot.corpus_digest) {
    throw new ExtractionArtifactError('CLAIM_SNAPSHOT_MISMATCH', `claims[${index}] is not bound to the artifact snapshot`, { claim_id: claim.id });
  }
  if (!Array.isArray(body.subject_refs) || !body.subject_refs.length) {
    throw new ExtractionArtifactError('MISSING_CLAIM_SEMANTICS', `claims[${index}] lacks subject_refs`, { claim_id: claim.id });
  }
  if (!Object.hasOwn(body, 'object_or_value') || !body.scope || typeof body.scope !== 'object' || Array.isArray(body.scope)
      || !body.valid_time || typeof body.valid_time !== 'object' || Array.isArray(body.valid_time)) {
    throw new ExtractionArtifactError('MISSING_CLAIM_SEMANTICS', `claims[${index}] lacks object_or_value, scope, or valid_time`, { claim_id: claim.id });
  }
  const excerpts = body.provenance?.source_excerpts;
  if (!Array.isArray(excerpts) || !excerpts.length || excerpts.some(excerpt => !nonblank(String(excerpt?.text ?? '')))) {
    throw new ExtractionArtifactError('MISSING_SOURCE_EXCERPT', `claims[${index}] lacks verbatim source excerpts`, { claim_id: claim.id });
  }
}

function coreOf(artifact) {
  const { artifact_digest: _digest, ...core } = artifact;
  return core;
}

export function createExtractionArtifact({ snapshot, extraction, selection = {} }) {
  validateSnapshot(snapshot);
  if (!extraction || !Array.isArray(extraction.claims)) {
    throw new ExtractionArtifactError('INVALID_EXTRACTION', 'extraction artifact requires extraction.claims[]');
  }
  extraction.claims.forEach((claim, index) => validateClaim(claim, snapshot, index));
  const claims = extraction.claims.slice();
  const skipped = Array.isArray(extraction.skipped) ? extraction.skipped : [];
  const timedOutChunks = skipped.filter(item => ['call_timeout', 'call_timeout_exhausted'].includes(item?.reason)).length;
  const incompletePaidUnits = skipped.filter(item => item?.inference_complete === false || ['call_timeout', 'call_timeout_exhausted'].includes(item?.reason)).length;
  const costStatus = extraction.model_stats?.cost_status ?? 'complete';
  const unpricedAttempts = Number(extraction.model_stats?.unpriced_attempts || 0);
  const artifactsExamined = Number(extraction.artifacts_examined ?? 0);
  const selectedDocs = Number(selection.selected_docs ?? artifactsExamined);
  const core = {
    schema: EXTRACTION_ARTIFACT_SCHEMA,
    snapshot: { source_sha: snapshot.source_sha, corpus_digest: snapshot.corpus_digest },
    selection: { ...selection },
    completion: {
      artifacts_examined: artifactsExamined,
      claims_extracted: claims.length,
      skipped: skipped.length,
      timed_out_chunks: timedOutChunks,
      incomplete_paid_units: incompletePaidUnits,
      cost_status: costStatus,
      unpriced_attempts: unpricedAttempts,
      full_domain: selection.max_artifacts == null && artifactsExamined === selectedDocs && incompletePaidUnits === 0 && costStatus === 'complete',
    },
    claims_digest: sha256(stableStringify(claims)),
    extraction: {
      claims,
      attempts: Array.isArray(extraction.attempts) ? extraction.attempts.slice() : [],
      skipped: skipped.slice(),
      chunk_counts: Array.isArray(extraction.chunk_counts) ? extraction.chunk_counts.slice() : [],
      model: extraction.model ?? null,
      model_stats: extraction.model_stats ?? null,
      artifacts_examined: Number(extraction.artifacts_examined ?? 0),
      concurrency: Number(extraction.concurrency ?? 0),
      max_in_flight: Number(extraction.max_in_flight ?? 0),
    },
  };
  return { ...core, artifact_digest: sha256(stableStringify(core)) };
}

export function validateExtractionArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new ExtractionArtifactError('INVALID_ARTIFACT', 'extraction artifact must be an object');
  }
  if (artifact.schema !== EXTRACTION_ARTIFACT_SCHEMA) {
    throw new ExtractionArtifactError('INVALID_SCHEMA', `expected ${EXTRACTION_ARTIFACT_SCHEMA}`);
  }
  validateSnapshot(artifact.snapshot);
  if (!artifact.extraction || !Array.isArray(artifact.extraction.claims)) {
    throw new ExtractionArtifactError('INVALID_EXTRACTION', 'artifact requires extraction.claims[]');
  }
  artifact.extraction.claims.forEach((claim, index) => validateClaim(claim, artifact.snapshot, index));
  const claimsDigest = sha256(stableStringify(artifact.extraction.claims));
  if (artifact.claims_digest !== claimsDigest) {
    throw new ExtractionArtifactError('CLAIMS_DIGEST_MISMATCH', 'extraction claims digest does not match payload');
  }
  const digest = sha256(stableStringify(coreOf(artifact)));
  if (artifact.artifact_digest !== digest) {
    throw new ExtractionArtifactError('ARTIFACT_DIGEST_MISMATCH', 'extraction artifact digest does not match payload');
  }
  return artifact;
}

export async function writeExtractionArtifact(file, artifact) {
  const validated = validateExtractionArtifact(artifact);
  const absolute = path.resolve(file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${stableStringify(validated)}\n`, 'utf8');
  await fs.rename(temporary, absolute);
  return absolute;
}

export async function readExtractionArtifact(file) {
  const absolute = path.resolve(file);
  const raw = await fs.readFile(absolute, 'utf8');
  const artifact = validateExtractionArtifact(JSON.parse(raw));
  return { artifact, path: absolute, file_sha256: sha256(raw) };
}
