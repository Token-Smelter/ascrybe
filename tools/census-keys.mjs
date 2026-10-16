// Staged invalidation keys for the documentation-claim census (DESIGN §16.12.2).
//
// Three pure, deterministic key functions. They are NOT wired into any running pipeline this
// slice — they exist to make the staged-invalidation contract concrete and testable.
//
//   claim_attempt_key = hash(content_hash, section, genre_adapter, prompt_digest,
//                            model_version, claim_schema_version)
//   alignment_key     = hash(claim_attempt_id, subject_catalog_digest, alias_registry_digest,
//                            ontology_version)
//   resolution_key    = hash(claim_or_case_id, evidence_manifest_digest,
//                            evidence_protocol_version, verifier_contract_version)
//
// A7 SCOPING (this slice's deliberate addition): the design's alignment_key inputs carry no
// scoping qualifier, so a naive estate-global subject_catalog / alias_registry digest would force
// estate-wide realignment on ANY single rename. That is the exact failure the deterministic side
// already avoids with regional invalidation (DESIGN §9.1). We therefore PARTITION the
// subject_catalog and alias_registry digests BY SUBJECT NEIGHBOURHOOD: alignment_key digests only
// the claim's own neighbourhood partition, so a rename inside one neighbourhood invalidates only
// that neighbourhood's alignment keys, never the estate.
import { sha256, stableStringify } from './lib.mjs';

export class CensusKeyError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'CensusKeyError';
    this.code = code;
    this.detail = detail;
  }
}

const requireStrings = (inputs, fields, label) => {
  const missing = fields.filter(field => inputs[field] === undefined || inputs[field] === null || inputs[field] === '');
  if (missing.length) throw new CensusKeyError('MISSING_KEY_INPUT', `${label} is missing input(s): ${missing.join(', ')}`, { missing });
};

const digest = (tag, parts) => sha256(stableStringify([tag, ...parts]));

export function claimAttemptKey(inputs = {}) {
  const fields = ['content_hash', 'section', 'genre_adapter', 'prompt_digest', 'model_version', 'claim_schema_version'];
  requireStrings(inputs, fields, 'claim_attempt_key');
  return digest('claim_attempt_key/v1', fields.map(field => inputs[field]));
}

/**
 * Digest of ONE subject neighbourhood's slice of the subject catalog. `catalog` maps
 * neighbourhood -> array of subject entries; only the named neighbourhood's partition is hashed,
 * so edits in other neighbourhoods cannot change this digest.
 */
export function subjectCatalogDigest(catalog, neighbourhood) {
  if (neighbourhood === undefined || neighbourhood === null || neighbourhood === '') throw new CensusKeyError('MISSING_NEIGHBOURHOOD', 'subjectCatalogDigest requires a neighbourhood');
  const partition = (catalog && typeof catalog === 'object' && catalog[neighbourhood]) || [];
  return sha256(stableStringify({ neighbourhood, subjects: partition }));
}

/** Digest of ONE subject neighbourhood's slice of the alias registry. Neighbourhood-partitioned. */
export function aliasRegistryDigest(registry, neighbourhood) {
  if (neighbourhood === undefined || neighbourhood === null || neighbourhood === '') throw new CensusKeyError('MISSING_NEIGHBOURHOOD', 'aliasRegistryDigest requires a neighbourhood');
  const partition = (registry && typeof registry === 'object' && registry[neighbourhood]) || [];
  return sha256(stableStringify({ neighbourhood, aliases: partition }));
}

export function alignmentKey(inputs = {}) {
  requireStrings(inputs, ['claim_attempt_id', 'neighbourhood', 'ontology_version'], 'alignment_key');
  const subject_catalog_digest = subjectCatalogDigest(inputs.subject_catalog, inputs.neighbourhood);
  const alias_registry_digest = aliasRegistryDigest(inputs.alias_registry, inputs.neighbourhood);
  return digest('alignment_key/v1', [inputs.claim_attempt_id, subject_catalog_digest, alias_registry_digest, inputs.ontology_version]);
}

const evidenceManifestDigest = (inputs) => {
  if (typeof inputs.evidence_manifest_digest === 'string' && inputs.evidence_manifest_digest) return inputs.evidence_manifest_digest;
  if (inputs.evidence_manifest === undefined || inputs.evidence_manifest === null) throw new CensusKeyError('MISSING_KEY_INPUT', 'resolution_key requires evidence_manifest or evidence_manifest_digest');
  return sha256(stableStringify(inputs.evidence_manifest));
};

export function resolutionKey(inputs = {}) {
  requireStrings(inputs, ['claim_or_case_id', 'evidence_protocol_version', 'verifier_contract_version'], 'resolution_key');
  return digest('resolution_key/v1', [inputs.claim_or_case_id, evidenceManifestDigest(inputs), inputs.evidence_protocol_version, inputs.verifier_contract_version]);
}
