// Deterministic C4 adapter from extractor facts to non-documentary GroundedAssertions.
//
// Every exact extractor record becomes one lossless observation. Semantic interpretation is
// deliberately excluded: extractor kind names and normalized graph IDs are not identity receipts.
import { execFileSync } from 'node:child_process';
import { extractorAvailabilityReceipt } from './extractors/index.mjs';
import {
  existsSync, readFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildEvidencePointer, buildMention } from './argument-mentions.mjs';
import { buildExtractionCacheBinding, materializeExtractionCache } from './extraction-cache.mjs';
import {
  identityCandidateDecisions, identityCandidateGenerationReport,
} from './identity-candidate-generator.mjs';
import { estateRoot } from './phase-a-exit-gate.mjs';
import {
  groundedAssertionId, GROUNDED_ASSERTION_SCHEMA, GROUNDED_ASSERTION_SCHEMA_VERSION,
} from './serving-assertions.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const CODE_FACT_INVENTORY_SCHEMA = 'estate-map/code-fact-inventory/v1';
export const CODE_FACT_PROJECTION_RECEIPT_SCHEMA = 'estate-map/code-fact-projection-receipt/v1';
export const CODE_FACT_PROJECTION_CONTRACT = 'code-fact-grounded-assertion@1';
export const CODE_FACT_SCHEMA = 'estate-map/extracted-code-fact/v1';

const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const compare = (left, right) => left.localeCompare(right);
const expectedEstateHead = '90ec8527ca8fa5957dc52e91d25414ff5980e1fd';

function fail(message) { throw new Error(message); }

function scratchRoot() {
  return process.env.ASCRYBE_SCRATCH_DIR || process.env.TMPDIR || tmpdir();
}

function exactFactRows(factsDir) {
  const held = resolve(factsDir);
  const nested = join(held, 'facts');
  const root = existsSync(nested) ? nested : held;
  return readdirSync(root).filter(name => name.endsWith('.jsonl')).sort(compare).flatMap(outputName => {
    const lines = readFileSync(join(root, outputName), 'utf8').split(/\r?\n/u).filter(Boolean);
    return lines.map((line, index) => ({
      output_path: `facts/${outputName}`,
      record_selector: `jsonl:${index + 1}`,
      exact_record_bytes: line,
      record: JSON.parse(line),
    }));
  });
}

function inventoryFromRows({ rows, sourceHead, extractManifest, mergeGraphDigest }) {
  const recordDigests = rows.map(row => sha256(canonical(row.record)));
  const codePlaneBody = {
    source_head: sourceHead,
    corpus_manifest_digest: extractManifest.corpus_manifest_digest,
    scanner_source_closure_digest: extractManifest.scanned_manifest?.scanner_source_closure_digest,
    extractor_availability_digest: extractManifest.extractor_availability?.digest,
    merge_graph_digest: mergeGraphDigest,
    exact_fact_stream_digest: sha256(canonical(recordDigests)),
    projection_contract: CODE_FACT_PROJECTION_CONTRACT,
  };
  const codePlaneHead = `code-plane:${sha256(canonical(codePlaneBody))}`;
  const records = rows.map((row, index) => {
    const exactRecordDigest = recordDigests[index];
    const body = {
      code_plane_head: codePlaneHead,
      stage_id: 'extract',
      producer_id: 'tools/extract.mjs',
      output_path: row.output_path,
      record_selector: row.record_selector,
      exact_record_digest: exactRecordDigest,
    };
    return {
      ...row,
      fact_id: hashId('code-fact', body),
      exact_record_digest: exactRecordDigest,
    };
  });
  const inventoryBody = {
    schema: CODE_FACT_INVENTORY_SCHEMA,
    code_plane_head: codePlaneHead,
    source_head: sourceHead,
    projection_contract: CODE_FACT_PROJECTION_CONTRACT,
    exact_fact_stream_digest: codePlaneBody.exact_fact_stream_digest,
    records: records.map(({ exact_record_bytes: _bytes, record: _record, ...record }) => record),
  };
  return { codePlaneHead, records, inventory: {
    ...inventoryBody, inventory_digest: sha256(canonical(inventoryBody)),
  } };
}

function projectionReceipt({ fact, codePlaneHead, sourceHead, assertion, evidence }) {
  const body = {
    schema: CODE_FACT_PROJECTION_RECEIPT_SCHEMA,
    fact_id: fact.fact_id,
    code_plane_head: codePlaneHead,
    source_head: sourceHead,
    producer_id: 'tools/extract.mjs',
    stage_id: 'extract',
    exact_record_digest: fact.exact_record_digest,
    disposition: 'excluded_from_semantic_projection',
    observation_assertion_id: assertion.assertion_id,
    semantic_assertion_ids: [],
    basis_evidence_ids: [evidence.evidence_id],
    basis_identity_receipt_ids: [],
    exclusion_reason: 'semantic interpretation excluded: exact extractor records are observations, not identity or domain-membership receipts',
    findings: [],
    projection_contract_version: CODE_FACT_PROJECTION_CONTRACT,
    materialization_id: assertion.materialization_id,
  };
  return Object.freeze({ ...body, receipt_id: hashId('code-fact-projection-receipt', body) });
}

/** Adapt an exact runtime fact stream. No fact kind is inferred from a report or fixture. */
export function buildCodeGroundedAssertions({
  facts_dir, extract_manifest, merge_graph, merge_graph_digest, source_head, recorded_time,
  required_source_head: requiredSourceHead = expectedEstateHead,
}) {
  if (source_head !== requiredSourceHead) fail(`C4 requires declared source head ${requiredSourceHead}`);
  // The gate is completeness, not a particular count: every registered extractor must have been
  // available and none excluded. Hardcoding the number turned adding an extractor into a failing
  // assertion about an unrelated property, so the registry states its own size.
  const registered = extractorAvailabilityReceipt.available.length;
  if (extract_manifest?.extractor_availability?.available?.length !== registered
    || extract_manifest?.extractor_exclusions?.length !== 0) {
    fail(`C4 requires all ${registered} registered extractors and zero extractor exclusion receipts`);
  }
  const rows = exactFactRows(facts_dir);
  const held = inventoryFromRows({ rows, sourceHead: source_head, extractManifest: extract_manifest,
    mergeGraphDigest: merge_graph_digest });
  const materializationId = `materialization:c4:${held.codePlaneHead.slice('code-plane:'.length)}`;
  const evidencePointers = [], groundedAssertions = [], receipts = [], identityCandidates = [];
  const skippedIdentityCandidates = [];
  const candidateDecisions = identityCandidateDecisions(held.records.map(row => row.record));
  for (const [factIndex, fact] of held.records.entries()) {
    const evidence = buildEvidencePointer({
      source_version_id: held.codePlaneHead,
      pointer: {
        kind: 'structured_record',
        record_id: fact.fact_id,
        schema_id: CODE_FACT_SCHEMA,
        field_path: '$',
        exact_value: fact.record,
        digest: fact.exact_record_digest,
      },
    });
    const candidateDecision = candidateDecisions[factIndex];
    const identityCandidate = candidateDecision.disposition === 'supported'
      ? buildMention({
        evidence_pointer: evidence,
        surface: candidateDecision.surface,
        role: 'structured_metadata',
        // This producer determines no provenance. The prior constant
        // 'production_document' asserted a classification nothing computed — a
        // fabricated field, which is the defect, not the absence of a class.
        // The witnessing path is already on every fact, so a consumer that
        // cares can classify at read time without a heuristic being frozen
        // into immutable records. See design section 16.
        provenance_class: 'unclassified',
        namespace: `${fact.record.repo}/${fact.record.file}`,
        source_status: 'current',
        context_digest: fact.exact_record_digest,
        disposition: 'identity_candidate',
      })
      : null;
    if (identityCandidate) identityCandidates.push(Object.freeze({
      fact_id: fact.fact_id,
      fact_kind: fact.record.kind,
      candidate_class: candidateDecision.candidate_class,
      record: Object.freeze(structuredClone(fact.record)),
      mention: identityCandidate.mention,
      evidence_id: evidence.evidence_id,
      candidate_basis: candidateDecision.candidate_basis,
    }));
    else skippedIdentityCandidates.push(Object.freeze({ fact_id: fact.fact_id,
      fact_kind: fact.record.kind, reason: candidateDecision.reason }));
    const assertionBody = {
      schema: GROUNDED_ASSERTION_SCHEMA,
      assertion_origin: 'structured_record',
      basis_evidence_ids: [evidence.evidence_id],
      basis_receipt_ids: [],
      assertion_schema_version: GROUNDED_ASSERTION_SCHEMA_VERSION,
      predicate_lexeme_id: 'predicate:deterministic-producer-emitted-record',
      arguments: [
        { role: 'subject', literal: {
          fact_id: fact.fact_id,
          fact_kind: fact.record.kind,
          producer_id: 'tools/extract.mjs',
          stage_id: 'extract',
          output_path: fact.output_path,
          record_selector: fact.record_selector,
          source_location: {
            repository: fact.record.repo ?? null,
            file: fact.record.file ?? null,
            line: fact.record.line ?? null,
          },
        } },
        { role: 'object', literal: fact.record },
        ...(identityCandidate ? [{ role: 'identity_candidate', mention_id: identityCandidate.mention.mention_id }] : []),
      ],
      polarity: 'affirmed',
      modality: 'descriptive',
      quantifier: 'one',
      scope: [held.codePlaneHead],
      conditions: [],
      source_status: 'current',
      decision_status: 'none',
      epistemic_authority: 'deterministic_derivation',
      valid_time: null,
      recorded_time,
      support_set_ids: [],
      materialization_id: materializationId,
    };
    const assertion = Object.freeze({ ...assertionBody, assertion_id: groundedAssertionId(assertionBody) });
    evidencePointers.push(evidence);
    groundedAssertions.push(assertion);
    receipts.push(projectionReceipt({ fact, codePlaneHead: held.codePlaneHead, sourceHead: source_head,
      assertion, evidence }));
  }
  groundedAssertions.sort((left, right) => compare(left.assertion_id, right.assertion_id));
  evidencePointers.sort((left, right) => compare(left.evidence_id, right.evidence_id));
  receipts.sort((left, right) => compare(left.fact_id, right.fact_id));
  identityCandidates.sort((left, right) => compare(left.mention.mention_id, right.mention.mention_id));
  const factKindInventory = [...held.records.reduce((counts, fact) => {
    const kind = fact.record.kind;
    counts.set(kind, (counts.get(kind) || 0) + 1);
    return counts;
  }, new Map())].map(([kind, count]) => ({ kind, count })).sort((a, b) => compare(a.kind, b.kind));
  const receiptKinds = new Set(receipts.map(receipt => held.records.find(row => row.fact_id === receipt.fact_id).record.kind));
  const identityCandidateGeneration = identityCandidateGenerationReport({
    facts: held.records.length,
    candidates: identityCandidates.map(row => ({ fact_kind: row.fact_kind,
      candidate_class: row.candidate_class })),
    skipped: skippedIdentityCandidates,
  });
  if (sha256(stableStringify(merge_graph)) !== merge_graph_digest) {
    fail('C4 merge graph digest differs from the exact merge.mjs runtime output');
  }
  if (canonical(merge_graph?.fact_kind_inventory) !== canonical(factKindInventory)) {
    fail('C4 fact-kind inventory differs from the exact merge.mjs runtime output');
  }
  if (receipts.length !== held.records.length || receiptKinds.size !== factKindInventory.length
    || groundedAssertions.length !== held.records.length || evidencePointers.length !== held.records.length
    || identityCandidates.length + skippedIdentityCandidates.length !== held.records.length) {
    fail('C4 represent-or-receipt conservation failed');
  }
  return Object.freeze({
    code_plane_head: held.codePlaneHead,
    extractor_availability: Object.freeze({
      available: Object.freeze(extract_manifest.extractor_availability.available.map(row => Object.freeze(structuredClone(row)))),
      exclusions: Object.freeze(extract_manifest.extractor_exclusions.map(row => Object.freeze(structuredClone(row)))),
    }),
    inventory: Object.freeze({ ...held.inventory, fact_kind_inventory: factKindInventory }),
    grounded_assertions: Object.freeze(groundedAssertions),
    grounding_registry: Object.freeze({ evidence_pointers: Object.freeze(evidencePointers), receipts: Object.freeze([]) }),
    projection_receipts: Object.freeze(receipts),
    extracted_facts: Object.freeze(held.records.map(row => Object.freeze(structuredClone(row.record)))),
    identity_candidates: Object.freeze(identityCandidates),
    identity_candidate_generation: identityCandidateGeneration,
    verification: Object.freeze({
      facts: held.records.length,
      fact_kinds: factKindInventory.length,
      represented_observations: groundedAssertions.length,
      excluded_fact_kinds: 0,
      excluded_semantic_fact_kinds: factKindInventory.length,
      identity_candidates: identityCandidates.length,
      terminal_incomplete: 0,
    }),
  });
}

/** Run extract + merge against the pinned estate into managed scratch, then adapt exact facts. */
export function producePinnedCodeGroundedAssertions() {
  const estate = estateRoot();
  const sourceHead = execFileSync('git', ['-C', estate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['-C', estate, 'status', '--short'], { encoding: 'utf8' }).trim();
  if (sourceHead !== expectedEstateHead || status) fail('pinned estate checkout is unavailable or dirty');
  const recordedTime = execFileSync('git', ['-C', estate, 'show', '-s', '--format=%cI', sourceHead], { encoding: 'utf8' }).trim();
  const scratch = scratchRoot();
  const binding = buildExtractionCacheBinding(sourceHead);
  const cache = materializeExtractionCache({
    cache_root: join(scratch, 'c4-extraction-cache'),
    lock_path: join(scratch, 'c4-extraction-cache.lock'),
    binding,
    produce: staging => {
      const extractRoot = join(staging, 'extract');
      const mergeRoot = join(staging, 'merge');
      execFileSync(process.execPath, ['tools/extract.mjs', estate, '--out', extractRoot], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      execFileSync(process.execPath, ['tools/merge.mjs', extractRoot, '--out', mergeRoot], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
    },
  });
  const extractRoot = join(cache.path, 'extract');
  const mergeRoot = join(cache.path, 'merge');
  const manifestPath = join(extractRoot, '_MANIFEST.json');
  const graphDigestPath = join(mergeRoot, 'digest.txt');
  if (!existsSync(manifestPath) || !existsSync(graphDigestPath)) {
    fail('validated extraction cache lacks required producer outputs');
  }
  return buildCodeGroundedAssertions({
    facts_dir: extractRoot,
    extract_manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    merge_graph: JSON.parse(readFileSync(join(mergeRoot, 'estate-graph.json'), 'utf8')),
    merge_graph_digest: readFileSync(graphDigestPath, 'utf8').trim(),
    source_head: sourceHead,
    recorded_time: recordedTime,
  });
}
