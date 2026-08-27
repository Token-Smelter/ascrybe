#!/usr/bin/env node
// L1 ADJUDICATION HARNESS — the repeatable machinery around a model judgement.
//
// SCOPE. This module is the DETERMINISTIC half of L1. It builds adjudication packets from
// the loop driver's persisted artifacts, validates a verdict against its claim type's
// witness obligations AS FIELD PRESENCE, maps accepted verdicts onto queue deltas through a
// reducer, and records refusals in a schema that carries the four fields DESIGN.md §3.2's
// T4 admissibility test needs. It contains NO judgement of its own and makes no model call.
//
// WHY THE HARNESS AND THE JUDGEMENT ARE SEPARATE FILES. l1-adjudication-spec.md §5.2 gives
// the reducer, not the adjudicator, ownership of the iteration classification: "An
// adjudicator that could declare its own iteration productive could refuse forever and call
// it progress." The same separation applies to drains — §5.4's load-bearing anti-assertion
// control is "sufficiency validation at the reducer, which refuses to decrement on an
// unwitnessed verdict". A drain is therefore EARNED here, by field presence the adjudicator
// cannot talk its way past, and never asserted in the verdict.
//
// TWO RECORDS, NOT ONE (spec §6.2). Overlays are written with the SHIPPED validator
// (annotate.mjs#validateAnnotation) and carry only verdicts with a positive witness.
// Everything else — reasoning, refusals, search evidence — lives in the ledger, which
// annotate.mjs deliberately does not validate. This module does not ask for a validator
// change, because the non-empty `grounded_in` rule is "the structural difference between an
// adjudication and a hallucination".
//
// DRIFT THIS MODULE REPORTS RATHER THAN ABSORBS — see DRIFT_NOTES at the bottom.

import fs from './readonly-guard.mjs';
import { canonDigest } from './portability.mjs';
import path from 'node:path';
import { parseArgs, sha256, stableStringify } from './lib.mjs';
import { validateAnnotation } from './annotate.mjs';
import { SIGNATURE_CLASSES } from './discover-entities.mjs';
import { classifyUnresolved } from './query.mjs';
import { projectActiveVector, readReconciliationEdges } from './reconciliation-edges.mjs';
import { createRecord, validateRecordList, canonicalSerialize } from './adjudication-schema.mjs';
import { closedWorldAbsenceStatus } from './extract.mjs';

const HELP = `Usage:
  node tools/estate-map/l1-adjudicate.mjs packets <driver-work-dir> [--out <file>] [--claim-type <t>]
  node tools/estate-map/l1-adjudicate.mjs prepare <driver-work-dir> --out <file> [--records-out <file>] [--model-available]
  node tools/estate-map/l1-adjudicate.mjs ingest  <receipts.jsonl> --state <dir>
  node tools/estate-map/l1-adjudicate.mjs apply   <driver-work-dir> <verdicts.jsonl> --state <dir> [--estate-root <dir>]
  node tools/estate-map/l1-adjudicate.mjs reduce  <driver-work-dir> --state <dir> [--json]

packets  Build legacy adjudication packets. Deterministic; no model call.
prepare  Persist canonical CandidatePacket records and a typed requires_model receipt when
         the candidate-generator role is unavailable. Deterministic; no model call.
ingest   Validate and append canonical model-produced receipts. Replays are byte-idempotent.
apply    Validate legacy verdicts against live validators and append their ledger records.
reduce   Print the ACTIVE queue vector (CENSUS minus EARNED drains) and repair queue.`;

export const SPEC_VERSION = '1.1';
export const LEDGER_SCHEMA = 'estate-map/adjudication-ledger/v1';
export const PACKET_SCHEMA = 'estate-map/adjudication-packet/v1';
// SEPARATE from annotate.mjs#REFUSAL_SCHEMA on purpose. `estate-map/refusal-record/v1` has a
// CLOSED field list (annotate.mjs#REFUSAL_FIELDS) that validateRefusal enforces, and it
// carries no adjudicator identity, no corpus digest, no attempt counter and no
// insufficient_because — which is exactly why loop-driver.mjs#T4_CONDITIONS reports two of
// the three T4 conditions as `evaluable: false`. Adding those fields to that schema would be
// rejected by the shipped validator, so L1 refusals ride in their own schema and the driver
// reads them alongside.
export const L1_REFUSAL_SCHEMA = 'estate-map/l1-refusal/v1';
export const LEDGER_FILE = 'ledger.jsonl';
export const OVERLAY_FILE = 'l1-adjudication.jsonl';
export const L1_REFUSALS_FILE = 'l1-refusals.jsonl';

export const CLAIM_TYPES = Object.freeze(['disambiguation', 'entity_classification', 'referent_search']);

// spec §3.1 / §3.2 / §3.3 verdict vocabularies. `confirmed_dead` is absent by construction:
// §10 "To delete canon text" is never asked of L1, and the only absence authority (§7.2) is
// the `absent` verdict, which §7.4 gates shut until the corpus manifest ships.
export const VERDICTS = Object.freeze({
  disambiguation: Object.freeze(['resolved_to', 'irreducible', 'insufficient_evidence']),
  entity_classification: Object.freeze(['domain_entity', 'not_an_entity', 'extraction_artifact', 'insufficient_evidence']),
  referent_search: Object.freeze(['found_as', 'absent', 'search_inconclusive']),
});

export const REFUSAL_VERDICTS = Object.freeze(['insufficient_evidence', 'search_inconclusive']);

// spec §9: documented_unwitnessed (12) → ambiguous (4) → discovered_undocumented by
// descending confidence. Smallest + highest-value first; the weak long tail must not starve
// the rest.
const QUEUE_ORDER = Object.freeze(['documented_unwitnessed', 'ambiguous_c', 'discovered_undocumented']);

const QUEUE_OF_CLAIM = Object.freeze({
  referent_search: 'documented_unwitnessed',
  disambiguation: 'ambiguous_c',
  entity_classification: 'discovered_undocumented',
});

// ---------------------------------------------------------------------------
// Identity — spec §2.1/§2.2, corrected for MF-5 (fields that actually exist).
//
// There is NO id on any shipped queue record. The three field sets printed by the shipped
// artifacts are the ones asserted by the tests; the ENTRY IS ITS OWN IDENTITY.
// ---------------------------------------------------------------------------
export const queueEntryDigest = record => sha256(stableStringify(record));

/**
 * The adjudication key (§2.2). Every input is a field that exists on a shipped artifact or is
 * computed here — v1.0's key hashed a `queue_entry_id` that exists nowhere, which is the MF-5
 * correction this signature encodes.
 */
export function adjudicationKey(parts) {
  const required = ['spec_version', 'claim_type', 'queue_entry_digest', 'adjudicated_at_sha',
    'tools_digest', 'canon_digest', 'dependency_digest', 'adjudicator_identity', 'batch_digest'];
  const missing = required.filter(key => !parts[key]);
  if (missing.length) throw new Error(`adjudication_key is missing input(s): ${missing.join(', ')}`);
  return sha256(stableStringify(Object.fromEntries(required.map(key => [key, parts[key]]))));
}

export const batchDigest = digests => (digests.length ? sha256(stableStringify([...digests].sort())) : 'single');

/** sha256 over the sorted bytes of tools/estate-map/**\/*.mjs — the tool half of the key. */
export async function toolsDigest(toolsDir) {
  const rows = [];
  const walk = async dir => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.mjs')) rows.push({ file: path.relative(toolsDir, full), sha256: sha256(await fs.readFile(full)) });
    }
  };
  await walk(toolsDir);
  return sha256(stableStringify(rows));
}

// ---------------------------------------------------------------------------
// PACKET BUILDER — read the driver's persisted artifacts, emit one packet per entry.
//
// The two adjudicable discovery queues are read from discovery-report.json and the ambiguous
// queue from the persisted graph, because that is where query.mjs#QUEUE_SOURCES says each
// one lives. Nothing here re-derives a queue; a packet that disagreed with the driver's
// vector would be a second opinion about routing, and §1 gives routing to the diagnoser.
// ---------------------------------------------------------------------------

const questionFor = {
  disambiguation: entry => `The extractor found reference \`${entry.name ?? entry.target_name_or_expr}\` at ${entry.repo}:${entry.file}:${entry.line} with ${entry.candidates.length} candidate target(s). Which is correct, or is the ambiguity irreducible?`,
  entity_classification: entry => `Discovered name \`${entry.entity}\` has ${entry.signature_classes.length} signature class(es) of evidence at ${entry.witness_count} site(s). Is it a domain entity, not an entity at all, or an extraction artifact?`,
  referent_search: entry => `Canon asserts \`${entry.canon_entity}\` at ${entry.canon_witness.file}:${entry.canon_witness.line}. The extractor searched ${entry.searched_signature_classes.join(', ')} and found no signal. Does it exist under a different name, or is it genuinely absent?`,
};

export function buildPackets({ graph, discovery, symbolRepos = null, absentPermitted = false, scannedManifest = null }) {
  const absenceStatus = scannedManifest ? closedWorldAbsenceStatus(scannedManifest) : { status: 'blocked', code: 'manifest_missing' };
  const packets = [];
  const push = (claimType, entry, evidence) => packets.push({
    schema: PACKET_SCHEMA,
    spec_version: SPEC_VERSION,
    claim_type: claimType,
    queue: QUEUE_OF_CLAIM[claimType],
    queue_entry: entry,
    queue_entry_digest: queueEntryDigest(entry),
    question: questionFor[claimType](entry),
    evidence_pointers: evidence,
    options: [...VERDICTS[claimType]],
    // §7.4: until `corpus_manifest_digest` is emitted, no `absent` may be written and every
    // negative result is `search_inconclusive`. The packet carries the gate so the verdict
    // validator can refuse `absent` with the reason rather than a bare rejection.
    absent_permitted: claimType === 'referent_search' ? Boolean(absentPermitted || absenceStatus.status === 'permitted') : false,
    absence_status: claimType === 'referent_search' ? absenceStatus : null,
  });

  for (const entry of discovery?.reconciliation?.documented_unwitnessed || []) {
    push('referent_search', entry, {
      canon_witness: entry.canon_witness,
      near_miss_clusters: entry.near_miss_clusters,
      searched_signature_classes: entry.searched_signature_classes,
      // §3.3: near misses are an ADJUDICATION AID, never evidence. Carried, and labelled.
      near_miss_status: 'adjudication aid only — a name-similarity argument is not a witness',
    });
  }
  for (const row of classifyUnresolved(graph, symbolRepos).filter(entry => entry.category === 'c')) {
    push('disambiguation', row.record, { candidates: row.record.candidates, family: row.family, referencing_site: { repo: row.record.repo, file: row.record.file, line: row.record.line } });
  }
  const undocumented = [...(discovery?.reconciliation?.discovered_undocumented || [])]
    .sort((a, b) => (b.confidence - a.confidence) || (b.witness_count - a.witness_count) || a.entity.localeCompare(b.entity));
  for (const entry of undocumented) {
    push('entity_classification', entry, {
      discovered_witnesses: entry.discovered_witnesses,
      signature_classes: entry.signature_classes,
      aliases: entry.aliases,
      canon_note: entry.canon_note,
      confidence_label: entry.confidence_label,
      // The only extractor-rule ids that exist. An `extraction_artifact` verdict must name
      // one of these, so the packet ships the vocabulary rather than inviting free text.
      extractor_rule_vocabulary: [...SIGNATURE_CLASSES],
    });
  }
  const rank = new Map(QUEUE_ORDER.map((queue, index) => [queue, index]));
  packets.sort((a, b) => rank.get(a.queue) - rank.get(b.queue));
  return packets;
}

// ---------------------------------------------------------------------------
// WP3 PREPARE / INGEST — progressive-map-generation §9.3. These operations only
// materialize and validate durable inputs; no branch in either operation invokes a model.
export const PREPARED_PACKETS_FILE = 'candidate-packets.jsonl';
export const INGESTED_RECEIPTS_FILE = 'ingested-receipts.jsonl';

export function prepareAdjudication({ packets, generatedAt = '1970-01-01T00:00:00Z', modelAvailable = false }) {
  const candidatePackets = packets.map(packet => createRecord('candidate_packet', {
    packet,
    queue_entry_digest: packet.queue_entry_digest,
    // Explicitly bind the current packet producer and absent gate; model work remains external.
    producer: 'l1-adjudicate.prepare@1',
  }, { generated_at: generatedAt }));
  const receipt = createRecord('replay_receipt', {
    operation: 'prepare', status: modelAvailable ? 'ready_for_model' : 'requires_model',
    packet_ids: candidatePackets.map(packet => packet.id), packet_count: candidatePackets.length,
    reason: modelAvailable ? null : 'candidate-generator role is not configured; no model output was fabricated',
  }, { generated_at: generatedAt });
  return { candidatePackets, receipt };
}

const canonicalJsonl = record => `${canonicalSerialize(record).replaceAll('\n', '')}\n`;

export async function persistPreparedAdjudication({ packets, outFile, recordsOutFile = null, generatedAt, modelAvailable = false }) {
  const prepared = prepareAdjudication({ packets, generatedAt, modelAvailable });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, prepared.candidatePackets.map(canonicalJsonl).join(''), 'utf8');
  const receiptFile = path.join(path.dirname(outFile), 'l1-prepare-receipt.json');
  await fs.writeFile(receiptFile, canonicalSerialize(prepared.receipt), 'utf8');
  if (recordsOutFile) {
    await fs.mkdir(path.dirname(recordsOutFile), { recursive: true });
    await fs.writeFile(recordsOutFile, [...prepared.candidatePackets, prepared.receipt].map(canonicalJsonl).join(''), 'utf8');
  }
  return { ...prepared, outFile, receiptFile, recordsOutFile };
}

export async function ingestReceiptRecords({ receipts, stateDir }) {
  validateRecordList(receipts);
  const file = path.join(stateDir, INGESTED_RECEIPTS_FILE);
  const prior = await readJsonl(file);
  const known = new Set(prior.map(record => record.id));
  const accepted = receipts.filter(record => !known.has(record.id));
  await appendJsonl(file, accepted);
  return { accepted, skipped: receipts.filter(record => known.has(record.id)), file };
}

// ---------------------------------------------------------------------------
// OUTPUT VALIDATOR — the witness obligations of §3, as FIELD PRESENCE.
//
// §6.3 is explicit that presence is not proof: `exactFields` checks presence and primitive
// type only, and "the witness genuinely discriminates" is NOT machine-checkable. What this
// function can do, it does: reject a verdict outside the entry's option set, reject a
// `resolved_to` naming a string absent from `candidates[]`, bounds-check every witness index,
// and refuse to accept a claim whose required evidence field is missing. Everything it cannot
// check is named in DRIFT_NOTES rather than waved through.
// ---------------------------------------------------------------------------

const VERDICT_FIELDS = ['adjudicator', 'adjudicator_family', 'claim_type', 'confidence', 'queue_entry_digest',
  'reasoning', 'verdict', 'witnesses'];

const isWitness = value => value && typeof value === 'object' && typeof value.repo === 'string' && value.repo.trim()
  && typeof value.file === 'string' && value.file.trim() && Number.isInteger(value.line) && value.line > 0;

function requireFields(record, fields, label) {
  const missing = fields.filter(field => record[field] === undefined || record[field] === null || record[field] === '');
  if (missing.length) throw new Error(`${label}: missing required field(s): ${missing.join(', ')}`);
}

function requireIndex(record, field, label, witnesses) {
  if (!Number.isInteger(record[field])) throw new Error(`${label}: ${field} must be an integer index into witnesses`);
  if (record[field] < 0 || record[field] >= witnesses.length) throw new Error(`${label}: ${field}=${record[field]} is out of range for ${witnesses.length} witness(es)`);
}

const nonEmptyStrings = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim());

/**
 * Validate one verdict against its packet. Throws with a specific reason; the caller counts a
 * throw as a REJECTED row (§4.3 case 2) — malformed, not merely wrong, queue untouched, and
 * the attempt still consumes the entry's retry budget so refusal is never the dominated
 * strategy.
 */
export function validateVerdict(packet, verdict, { clusterNames = null } = {}) {
  const label = `${packet.claim_type}:${packet.queue_entry_digest.slice(0, 12)}`;
  requireFields(verdict, VERDICT_FIELDS, label);
  if (verdict.claim_type !== packet.claim_type) throw new Error(`${label}: claim_type ${verdict.claim_type} does not match the packet`);
  if (verdict.queue_entry_digest !== packet.queue_entry_digest) throw new Error(`${label}: queue_entry_digest does not match the packet`);
  if (!packet.options.includes(verdict.verdict)) throw new Error(`${label}: verdict '${verdict.verdict}' is outside the entry's option set (${packet.options.join(', ')})`);
  if (typeof verdict.confidence !== 'number' || !(verdict.confidence >= 0 && verdict.confidence <= 1)) throw new Error(`${label}: confidence must be a number in [0,1]`);
  if (!Array.isArray(verdict.witnesses) || !verdict.witnesses.every(isWitness)) throw new Error(`${label}: witnesses must be an array of {repo,file,line}`);

  const refusing = REFUSAL_VERDICTS.includes(verdict.verdict);
  if (refusing) {
    // §4.3 case 1 / §5.2: the ledger row records WHAT EVIDENCE WOULD HAVE SUFFICED, and the
    // T4 admissibility test requires it to name a concrete obtainable artefact.
    requireFields(verdict, ['insufficient_because', 'requested_artifact'], label);
    if (verdict.insufficient_because.length < 24) throw new Error(`${label}: insufficient_because must name a concrete obtainable artefact, not a mood`);
  }

  switch (verdict.verdict) {
    case 'resolved_to': {
      requireFields(verdict, ['resolved_to'], label);
      // §3.1 hard rule: the adjudicator answers the extractor's question, it does not invent
      // a target.
      if (!packet.queue_entry.candidates.includes(verdict.resolved_to)) {
        throw new Error(`${label}: resolved_to '${verdict.resolved_to}' does not appear verbatim in candidates[]`);
      }
      if (verdict.witnesses.length < 2) throw new Error(`${label}: resolved_to needs the referencing site AND >=1 discriminating witness`);
      requireIndex(verdict, 'discriminating_witness_index', label, verdict.witnesses);
      requireFields(verdict, ['rejected_candidates'], label);
      const rejected = packet.queue_entry.candidates.filter(candidate => candidate !== verdict.resolved_to);
      if (!Array.isArray(verdict.rejected_candidates) || verdict.rejected_candidates.length !== rejected.length) {
        throw new Error(`${label}: rejected_candidates must account for every candidate not chosen (${rejected.length})`);
      }
      break;
    }
    case 'irreducible':
      // A real finding, not a failure — but it still has to have LOOKED. The referencing site
      // is always openable, so an irreducible with no witness at all is an assertion.
      if (verdict.witnesses.length < 1) throw new Error(`${label}: irreducible must cite the referencing site it examined`);
      requireFields(verdict, ['no_discriminator_because'], label);
      break;
    case 'domain_entity':
    case 'not_an_entity': {
      // §3.2 witness: >=1 site per signature class cited in the record, PLUS >=1 site
      // exhibiting the distinguishing property of the chosen class. `discovered_witnesses` is
      // a bare `path:line` list with no class label, so per-class coverage cannot be derived
      // from it — the verdict must SAY which witness discharges which class, and those
      // indices are bounds-checked.
      requireFields(verdict, ['signature_class_coverage'], label);
      const coverage = verdict.signature_class_coverage;
      const expected = [...packet.queue_entry.signature_classes].sort();
      const got = Object.keys(coverage || {}).sort();
      if (stableStringify(expected) !== stableStringify(got)) {
        throw new Error(`${label}: signature_class_coverage must cover exactly ${expected.join(', ')} (got ${got.join(', ') || 'nothing'})`);
      }
      for (const [signatureClass, index] of Object.entries(coverage)) requireIndex({ index }, 'index', `${label}.coverage[${signatureClass}]`, verdict.witnesses);
      requireIndex(verdict, 'distinguishing_witness_index', label, verdict.witnesses);
      break;
    }
    case 'extraction_artifact':
      // §3.2 hard rule: naming the extractor rule is the obligation, and the verdict is a
      // REPAIR signal that routes back to L0 — it does NOT become an overlay.
      requireFields(verdict, ['repair_signal'], label);
      if (!verdict.repair_signal || typeof verdict.repair_signal.extractor_rule !== 'string') throw new Error(`${label}: extraction_artifact needs repair_signal.extractor_rule`);
      if (!SIGNATURE_CLASSES.includes(verdict.repair_signal.extractor_rule)) {
        throw new Error(`${label}: repair_signal.extractor_rule '${verdict.repair_signal.extractor_rule}' is not a shipped extractor rule (${SIGNATURE_CLASSES.join(', ')})`);
      }
      if (verdict.witnesses.length < 1) throw new Error(`${label}: extraction_artifact must cite the site the rule misfired on`);
      break;
    case 'found_as': {
      requireFields(verdict, ['found_as'], label);
      // DRIFT-1: the spec says `found_as: <graph node id>`. The referent lives in the
      // DISCOVERY namespace, not the graph — see DRIFT_NOTES.
      if (!/^cluster:/.test(verdict.found_as)) throw new Error(`${label}: found_as must name a discovery cluster as 'cluster:<entity>' (see DRIFT_NOTES DRIFT-1)`);
      const target = verdict.found_as.slice('cluster:'.length);
      if (clusterNames && !clusterNames.has(target)) throw new Error(`${label}: found_as target '${target}' is not a cluster in the discovery report`);
      if (verdict.witnesses.length < 1) throw new Error(`${label}: found_as needs >=1 site where the alias exhibits the behaviour canon ascribes`);
      requireIndex(verdict, 'behaviour_witness_index', label, verdict.witnesses);
      break;
    }
    case 'absent': {
      // §7.3's bar, as fields. A1 rejections, A2 transcript, A3 manifest, A4 panel, A5 canon
      // line still resolves. A3 is the one that is not satisfiable today, and the packet's
      // `absent_permitted: false` short-circuits before the rest so the refusal reason names
      // the real blocker instead of the first missing field.
      if (!packet.absent_permitted) {
        throw new Error(`${label}: 'absent' is gated shut (§7.4): ${packet.absence_status?.code || 'manifest_missing'} blocks closed-world absence; every negative result is 'search_inconclusive'`);
      }
      requireFields(verdict, ['search_evidence', 'near_miss_rejections', 'panel', 'canon_witness_resolves'], label);
      const evidence = verdict.search_evidence;
      requireFields(evidence, ['corpus_manifest_digest', 'sha'], `${label}.search_evidence`);
      for (const field of ['queries', 'corpora_covered', 'aliases_considered']) {
        if (!nonEmptyStrings(evidence[field])) throw new Error(`${label}.search_evidence.${field} must be a non-empty string array`);
      }
      // §6.2: a negative claim has no positive witness and writes NO overlay. A file:line on
      // an absence claim is a fabricated witness by construction.
      if (verdict.witnesses.length) throw new Error(`${label}: 'absent' must carry no file:line witness — a negative claim has none to carry`);
      if (!Array.isArray(verdict.panel) || new Set(verdict.panel.map(member => member.family)).size < 2) {
        throw new Error(`${label}: A4 requires two adjudicators of DISTINCT model families`);
      }
      break;
    }
    case 'search_inconclusive':
      requireFields(verdict, ['search_evidence'], label);
      if (!nonEmptyStrings(verdict.search_evidence.queries)) throw new Error(`${label}.search_evidence.queries must record the searches actually run`);
      break;
    case 'insufficient_evidence':
      break;
    default:
      throw new Error(`${label}: unhandled verdict ${verdict.verdict}`);
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// WITNESS RESOLUTION — §6.3 "witnesses are real": the reducer resolves every {repo,file,line}
// and rejects the row when one does not resolve. Without this the whole witness apparatus is
// a formatting convention.
// ---------------------------------------------------------------------------
export async function resolveWitness(estateRoot, witness) {
  for (const candidate of [path.join(estateRoot, witness.repo, witness.file), path.join(estateRoot, witness.file)]) {
    let text;
    try { text = await fs.readFile(candidate, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    if (witness.line > lines.length) return { resolved: false, why: `${candidate} has ${lines.length} line(s), witness cites ${witness.line}` };
    return { resolved: true, path: candidate, text: lines[witness.line - 1] };
  }
  return { resolved: false, why: `no file found for repo=${witness.repo} file=${witness.file}` };
}

export async function resolveWitnesses(estateRoot, witnesses) {
  const rows = [];
  for (const witness of witnesses) rows.push({ witness, ...await resolveWitness(estateRoot, witness) });
  return rows;
}

/** Positive tier of §2.2: sorted sha256 of every cited witness file. */
export async function dependencyDigest(estateRoot, witnesses, { corpusManifestDigest = null } = {}) {
  if (corpusManifestDigest) return corpusManifestDigest;
  const files = [...new Set(witnesses.map(witness => `${witness.repo}\0${witness.file}`))].sort();
  const rows = [];
  for (const key of files) {
    const [repo, file] = key.split('\0');
    const resolved = await resolveWitness(estateRoot, { repo, file, line: 1 });
    rows.push({ repo, file, sha256: resolved.resolved ? sha256(await fs.readFile(resolved.path)) : null });
  }
  // An entry with no cited file (a refusal) still needs a stable digest, or its key collapses.
  return sha256(stableStringify(rows.length ? rows : [{ tier: 'no-cited-witness' }]));
}

// ---------------------------------------------------------------------------
// OVERLAY — spec §6.2(a). Written with the SHIPPED validator, unchanged.
// ---------------------------------------------------------------------------
export const OVERLAY_BEARING_VERDICTS = Object.freeze(['resolved_to', 'found_as', 'domain_entity', 'not_an_entity']);

export function toOverlay(packet, verdict, { generatedAt, adjudicationKey: key }) {
  if (!OVERLAY_BEARING_VERDICTS.includes(verdict.verdict)) return null;
  const base = {
    kind: 'llm_annotation',                 // PROVENANCE. A model inference is never doc_derived_annotation.
    subject: `adjudication:${packet.queue}:${packet.queue_entry_digest}`,
    model: verdict.adjudicator,
    generated_at: generatedAt,
    confidence: verdict.confidence,
    grounded_in: verdict.witnesses.map(witness => ({ repo: witness.repo, file: witness.file, line: witness.line })),
  };
  const reasoning = `adjudication_key=${key} | ${verdict.reasoning}`;
  if (verdict.verdict === 'resolved_to') {
    return { ...base, annotation_kind: 'proposed_edge', body: { edge_kind: packet.queue_entry.kind, from: `${packet.queue_entry.repo}:${packet.queue_entry.file}:${packet.queue_entry.line}`, to: verdict.resolved_to, reasoning } };
  }
  if (verdict.verdict === 'found_as') {
    return { ...base, annotation_kind: 'proposed_edge', body: { edge_kind: 'implements', from: `canon:${packet.queue_entry.canon_entity}`, to: verdict.found_as, reasoning } };
  }
  return { ...base, annotation_kind: 'finding', body: { title: `${verdict.verdict}: ${packet.queue_entry.entity}`, severity: verdict.verdict === 'domain_entity' ? 'medium' : 'low', detail: reasoning } };
}

// ---------------------------------------------------------------------------
// THE REDUCER — spec §4.2's total transition table, as data.
//
// `delta` is the ACTIVE queue delta. `deferred` marks the rows §4.2 makes conditional on
// work that has not happened yet: a `domain_entity` drains when the canon PR lands, an
// `extraction_artifact` when re-extraction removes the cluster. Counting either today would
// be draining by exclusion (§5.2's exploit shape) — the map would look emptier because a
// model spoke, which is the one thing this architecture exists to prevent.
// ---------------------------------------------------------------------------
export const TRANSITION_TABLE = Object.freeze({
  'referent_search:found_as': Object.freeze({ l2_state: 'unverifiable -> implements', queue: 'documented_unwitnessed', delta: -1, deferred: false, mechanism: 'canon alias/rename or clusterer alias rule — the reducer emits the work item' }),
  'referent_search:absent': Object.freeze({ l2_state: 'unverifiable -> confirmed_dead', queue: 'documented_unwitnessed', delta: -1, deferred: false, mechanism: 'shipped: dead-ledger, passed to discover-entities --dead' }),
  'referent_search:search_inconclusive': Object.freeze({ l2_state: 'stays unverifiable', queue: 'documented_unwitnessed', delta: 0, deferred: false, mechanism: 'none — by design (T4)' }),
  'entity_classification:domain_entity': Object.freeze({ l2_state: 'stays undocumented', queue: 'discovered_undocumented', delta: 0, deferred: true, mechanism: 'canon PR: add `### Name` under `## Expanded Definitions` (X2)' }),
  'entity_classification:not_an_entity': Object.freeze({ l2_state: 'stays undocumented; ledger records durable not_an_entity', queue: 'discovered_undocumented', delta: -1, deferred: false, mechanism: 'reducer exclusion — X3 proves the canon non-entity section does not drain' }),
  'entity_classification:extraction_artifact': Object.freeze({ l2_state: 'no L2 edge — this is L0', queue: 'discovered_undocumented', delta: 0, deferred: true, mechanism: 'REPAIR: fix the named extractor rule, re-run L0' }),
  'entity_classification:insufficient_evidence': Object.freeze({ l2_state: 'stays undocumented', queue: 'discovered_undocumented', delta: 0, deferred: false, mechanism: 'none — by design (T4)' }),
  'disambiguation:resolved_to': Object.freeze({ l2_state: 'no L2 edge state (§4.4)', queue: 'ambiguous_c', delta: -1, deferred: false, mechanism: 'overlay proposed_edge + reducer exclusion; permanent fix is a merge.mjs resolver change' }),
  'disambiguation:irreducible': Object.freeze({ l2_state: 'no L2 edge state (§4.4)', queue: 'ambiguous_c', delta: -1, deferred: false, mechanism: 'reducer exclusion only; reopened if dependency_digest changes' }),
  'disambiguation:insufficient_evidence': Object.freeze({ l2_state: 'unchanged', queue: 'ambiguous_c', delta: 0, deferred: false, mechanism: 'none — by design (T4)' }),
});

export const transitionFor = row => TRANSITION_TABLE[`${row.claim_type}:${row.verdict}`] || null;

const reconciliationStatesFor = row => {
  switch (`${row.claim_type}:${row.verdict}`) {
    case 'referent_search:found_as': return { previous_state: 'unverifiable', current_state: 'implements' };
    case 'referent_search:absent': return { previous_state: 'unverifiable', current_state: 'confirmed_dead' };
    // `not_an_entity` closes this queue entry but is not itself one of DESIGN.md §2.4's
    // reality↔assertion states. Preserve the documented state and make its adjudication
    // provenance explicit instead of inventing a sixth L2 state.
    case 'entity_classification:not_an_entity': return { previous_state: 'undocumented', current_state: 'undocumented' };
    // DESIGN.md §2.4's `contradicts → ambiguous` mapping does not describe the shipped
    // unresolved-reference queue. These accepted resolutions still get durable edges that
    // discharge their queue entry, but correctly carry no fictional L2 state.
    case 'disambiguation:resolved_to':
    case 'disambiguation:irreducible': return { previous_state: null, current_state: null };
    default: return null;
  }
};

/** Build drain candidates from accepted, current-corpus ledger rows. This does not mutate a
 * queue: appendReconciliationEdges persists these candidates first, then ACTIVE projects them. */
export function reconciliationEdgePlans(ledgerRows, corpusDigest) {
  const plans = [], deferred = [], refusals = [], repair = [];
  const seen = new Set();
  for (const row of ledgerRows) {
    if (!row?.adjudication_key || seen.has(row.adjudication_key)) continue;
    seen.add(row.adjudication_key);
    const transition = transitionFor(row);
    if (!transition) { refusals.push({ ...row, why: 'no transition — row is not in the §4.2 table' }); continue; }
    if (REFUSAL_VERDICTS.includes(row.verdict)) refusals.push(row);
    if (row.verdict === 'extraction_artifact') repair.push({ entity: row.queue_entry.entity, extractor_rule: row.repair_signal.extractor_rule, queue_entry_digest: row.queue_entry_digest });
    if (transition.deferred) { deferred.push({ key: `${row.claim_type}:${row.verdict}`, queue: transition.queue, mechanism: transition.mechanism, subject: row.queue_entry.entity ?? row.queue_entry_digest.slice(0, 12) }); continue; }
    if (transition.delta !== -1 || row.corpus_digest !== corpusDigest) continue;
    const states = reconciliationStatesFor(row);
    if (!states) throw new Error(`accepted drain has no reconciliation-edge mapping: ${row.claim_type}:${row.verdict}`);
    plans.push({
      queue: transition.queue, queue_entry_digest: row.queue_entry_digest,
      subject: row.queue_entry.entity ?? row.queue_entry.canon_entity ?? row.queue_entry_digest.slice(0, 12),
      ...states, corpus_digest: row.corpus_digest, adjudication_key: row.adjudication_key,
      claim_type: row.claim_type, verdict: row.verdict, adjudicator: row.adjudicator,
      adjudicator_family: row.adjudicator_family, ledger_schema: row.schema, witnesses: row.witnesses,
    });
  }
  return { plans, deferred, refusals, repair, rows_folded: seen.size };
}

/** ACTIVE is always a projection of persisted reconciliation edges. Ledger rows produce only
 * append candidates; callers must persist them before passing edgeRows here. */
export function reduce(censusVector, ledgerRows, { edgeRows = [], corpusDigest } = {}) {
  const detail = reconciliationEdgePlans(ledgerRows, corpusDigest);
  const projection = projectActiveVector(censusVector, edgeRows, corpusDigest);
  return { ...projection, ...detail, drains: projection.drained };
}

// ---------------------------------------------------------------------------
// L1 REFUSAL RECORD — the four fields that make DESIGN.md §3.2's T4 test evaluable.
// ---------------------------------------------------------------------------
const L1_REFUSAL_FIELDS = ['adjudication_key', 'adjudicator', 'adjudicator_family', 'attempt', 'claim_type',
  'corpus_digest', 'dependency_digest', 'insufficient_because', 'observed_at', 'queue', 'queue_entry_digest',
  'refusal_id', 'requested_artifact', 'schema', 'verdict'];

export function validateL1Refusal(record, label = 'l1_refusal') {
  const unknown = Object.keys(record).filter(key => !L1_REFUSAL_FIELDS.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.sort().join(', ')}`);
  requireFields(record, L1_REFUSAL_FIELDS, label);
  if (record.schema !== L1_REFUSAL_SCHEMA) throw new Error(`${label}.schema must be ${L1_REFUSAL_SCHEMA}`);
  if (!REFUSAL_VERDICTS.includes(record.verdict)) throw new Error(`${label}.verdict must be one of ${REFUSAL_VERDICTS.join(', ')}`);
  if (!Number.isInteger(record.attempt) || record.attempt < 1) throw new Error(`${label}.attempt must be a positive integer`);
  if (record.insufficient_because.length < 24) throw new Error(`${label}.insufficient_because must name a concrete obtainable artefact`);
  return record;
}

export function toL1Refusal(packet, verdict, { key, corpusDigest, dependencyDigest: dependency, attempt, observedAt }) {
  if (!REFUSAL_VERDICTS.includes(verdict.verdict)) return null;
  return validateL1Refusal({
    schema: L1_REFUSAL_SCHEMA,
    refusal_id: `l1:${packet.claim_type}:${packet.queue_entry_digest.slice(0, 16)}:${attempt}`,
    adjudication_key: key,
    claim_type: packet.claim_type,
    queue: packet.queue,
    queue_entry_digest: packet.queue_entry_digest,
    adjudicator: verdict.adjudicator,
    adjudicator_family: verdict.adjudicator_family,
    corpus_digest: corpusDigest,
    dependency_digest: dependency,
    attempt,
    verdict: verdict.verdict,
    insufficient_because: verdict.insufficient_because,
    requested_artifact: verdict.requested_artifact,
    observed_at: observedAt,
  });
}

// ---------------------------------------------------------------------------
// APPLY — validate, key, dedupe, append.
// ---------------------------------------------------------------------------
const readJsonl = async file => {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const appendJsonl = async (file, rows) => {
  if (!rows.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
};

/**
 * Apply a verdict batch. Returns every row it accepted, rejected, or skipped as already
 * adjudicated — the caller reports all three, because a silent skip and a silent rejection
 * are the two ways an idempotency gate hides work that did not happen.
 */
export async function applyVerdicts({ packets, verdicts, stateDir, estateRoot, context, clusterNames = null, now }) {
  const byDigest = new Map(packets.map(packet => [packet.queue_entry_digest, packet]));
  // `stateDir: null` is a DRY RUN: validate, key and reduce without persisting anything.
  const priorLedger = stateDir ? await readJsonl(path.join(stateDir, LEDGER_FILE)) : [];
  const priorKeys = new Set(priorLedger.map(row => row.adjudication_key));
  const attemptsByEntry = new Map();
  for (const row of priorLedger) attemptsByEntry.set(row.queue_entry_digest, Math.max(attemptsByEntry.get(row.queue_entry_digest) || 0, row.attempt || 0));

  const accepted = [], overlays = [], refusals = [], rejected = [], skipped = [];
  const digests = verdicts.map(verdict => verdict.queue_entry_digest).filter(Boolean);
  const batch = batchDigest(digests.length > 1 ? digests : []);
  const generatedAt = now || new Date().toISOString();

  for (const verdict of verdicts) {
    const packet = byDigest.get(verdict.queue_entry_digest);
    if (!packet) { rejected.push({ verdict, why: 'no packet with that queue_entry_digest — the entry is not on a ready-for-L1 queue' }); continue; }
    try {
      validateVerdict(packet, verdict, { clusterNames });
      const resolutions = await resolveWitnesses(estateRoot, verdict.witnesses);
      const unresolved = resolutions.filter(row => !row.resolved);
      if (unresolved.length) throw new Error(`witness does not resolve at ${context.adjudicated_at_sha}: ${unresolved.map(row => row.why).join('; ')}`);
      const dependency = await dependencyDigest(estateRoot, verdict.witnesses);
      const key = adjudicationKey({
        spec_version: SPEC_VERSION,
        claim_type: packet.claim_type,
        queue_entry_digest: packet.queue_entry_digest,
        adjudicated_at_sha: context.adjudicated_at_sha,
        tools_digest: context.tools_digest,
        canon_digest: context.canon_digest,
        dependency_digest: dependency,
        adjudicator_identity: verdict.adjudicator,
        batch_digest: batch,
      });
      if (priorKeys.has(key)) { skipped.push({ queue_entry_digest: packet.queue_entry_digest, adjudication_key: key, why: 'already adjudicated at this key — unchanged corpus, no re-adjudication' }); continue; }
      const attempt = (attemptsByEntry.get(packet.queue_entry_digest) || 0) + 1;
      attemptsByEntry.set(packet.queue_entry_digest, attempt);
      const overlay = toOverlay(packet, verdict, { generatedAt, adjudicationKey: key });
      if (overlay) validateAnnotation(overlay, `overlay:${packet.queue_entry_digest.slice(0, 12)}`);
      const row = {
        schema: LEDGER_SCHEMA,
        spec_version: SPEC_VERSION,
        claim_type: packet.claim_type,
        queue: packet.queue,
        queue_entry: packet.queue_entry,
        queue_entry_digest: packet.queue_entry_digest,
        adjudicated_at_sha: context.adjudicated_at_sha,
        adjudicator: verdict.adjudicator,
        adjudicator_family: verdict.adjudicator_family,
        panel: verdict.panel || [verdict.adjudicator],
        adjudication_key: key,
        dependency_digest: dependency,
        corpus_digest: context.corpus_digest,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        witnesses: verdict.witnesses,
        witness_lines: resolutions.map(row => row.text),
        overlay_ref: overlay ? sha256(stableStringify(overlay)) : null,
        attempt,
        adjudicated_at: generatedAt,
      };
      for (const field of ['resolved_to', 'rejected_candidates', 'discriminating_witness_index', 'no_discriminator_because',
        'found_as', 'behaviour_witness_index', 'signature_class_coverage', 'distinguishing_witness_index',
        'repair_signal', 'search_evidence', 'insufficient_because', 'requested_artifact']) {
        if (verdict[field] !== undefined) row[field] = verdict[field];
      }
      priorKeys.add(key);
      accepted.push(row);
      if (overlay) overlays.push(overlay);
      const refusal = toL1Refusal(packet, verdict, { key, corpusDigest: context.corpus_digest, dependencyDigest: dependency, attempt, observedAt: generatedAt });
      if (refusal) refusals.push(refusal);
    } catch (error) {
      rejected.push({ queue_entry_digest: verdict.queue_entry_digest, verdict: verdict.verdict, why: error.message });
    }
  }
  if (stateDir) {
    await appendJsonl(path.join(stateDir, LEDGER_FILE), accepted);
    await appendJsonl(path.join(stateDir, OVERLAY_FILE), overlays);
    await appendJsonl(path.join(stateDir, L1_REFUSALS_FILE), refusals);
  }
  return { accepted, overlays, refusals, rejected, skipped, batch_digest: batch };
}

// ---------------------------------------------------------------------------
// DRIFT NOTES — disagreements between the landed spec and the landed source. The injected
// grounding contract is explicit that where a citation and the live source disagree, THE
// SOURCE WINS; these are reported, not silently absorbed.
// ---------------------------------------------------------------------------
export const DRIFT_NOTES = Object.freeze([
  Object.freeze({
    id: 'DRIFT-1',
    spec: 'l1-adjudication-spec.md §3.3: "`found_as: <graph node id>`"',
    source: 'query.mjs#QUEUE_SOURCES: documented_unwitnessed comes from `discovery-report.json headline.documented_unwitnessed`; discover-entities.mjs writes NO graph nodes, and `near_miss_clusters[].entity` names a CLUSTER.',
    resolution: 'found_as targets are `cluster:<entity>` and are resolved against discovery-report.json clusters[]. Admitting graph node ids would let every referent search resolve to "the module that mentions the name", which is the laundering shape §1 forbids.',
  }),
  Object.freeze({
    id: 'DRIFT-2',
    spec: '§6.2 overlay table gives `extraction_artifact` an overlay of annotation_kind `finding`.',
    source: '§3.2 hard rule in the SAME spec: "It is a REPAIR signal, routes back to L0, and does not become an overlay"; §4.2 gives it "no L2 edge — this is L0".',
    resolution: 'No overlay is written for extraction_artifact. The more specific normative rule wins over the summary table, and an L0 defect must not acquire a permanent map annotation.',
  }),
  Object.freeze({
    id: 'DRIFT-3',
    spec: '§3.1 offers disambiguation only `resolved_to` / `irreducible` / `insufficient_evidence`.',
    source: 'A real entry (ambiguous_c `/gateway/template-events`) has BOTH candidates refuted by discriminating witnesses — the candidate SET is wrong, which is an extractor defect, not an irreducible ambiguity.',
    resolution: 'Recorded as `insufficient_evidence` with a concrete repair ask, because `irreducible` would drain a queue entry whose real answer is "fix the resolver" — the §1 laundering shape. The spec needs a `candidate_set_refuted` verdict routing to REPAIR, mirroring entity_classification\'s `extraction_artifact`.',
  }),
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export async function loadDriverArtifacts(workDir) {
  const graph = JSON.parse(await fs.readFile(path.join(workDir, 'graph', 'estate-graph.annotated.json'), 'utf8'));
  const discovery = JSON.parse(await fs.readFile(path.join(workDir, 'discovery', 'discovery-report.json'), 'utf8'));
  const extractManifest = await fs.readFile(path.join(workDir, 'extract', '_MANIFEST.json'), 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return { graph, discovery, scannedManifest: extractManifest?.scanned_manifest || null, clusterNames: new Set((discovery.clusters || []).map(cluster => cluster.entity)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  try {
    // `ingest` consumes a receipts.jsonl and appends canonical records to --state; it needs NO
    // driver artifacts. Dispatch it BEFORE loadDriverArtifacts so `ingest <receipts.jsonl>` does
    // not read the receipts file as a driver work dir (ENOTDIR). Every other command takes a
    // driver work dir as positional[1].
    if (positional[0] === 'ingest') {
      if (!positional[1] || !options.state) throw new Error('ingest requires <receipts.jsonl> and --state <dir>');
      const result = await ingestReceiptRecords({ receipts: await readJsonl(path.resolve(positional[1])), stateDir: path.resolve(options.state) });
      console.log(`accepted=${result.accepted.length} skipped=${result.skipped.length} file=${result.file}`);
      process.exit(0);
    }
    const workDir = path.resolve(positional[1] || '.');
    const { graph, discovery, scannedManifest, clusterNames } = await loadDriverArtifacts(workDir);
    const { loadSymbolIndex } = await import('./analyze-connectivity.mjs');
    const symbolIndex = await loadSymbolIndex(path.join(workDir, 'extract', 'facts'));
    const packets = buildPackets({ graph, discovery, symbolRepos: symbolIndex.symbolRepos, scannedManifest });
    if (positional[0] === 'packets') {
      const selected = options['claim-type'] ? packets.filter(packet => packet.claim_type === options['claim-type']) : packets;
      const text = selected.map(packet => JSON.stringify(packet)).join('\n') + '\n';
      if (options.out) { await fs.writeFile(path.resolve(options.out), text, 'utf8'); console.log(`Wrote ${selected.length} packet(s) to ${options.out}`); }
      else process.stdout.write(text);
    } else if (positional[0] === 'prepare') {
      if (!options.out) throw new Error('prepare requires --out <candidate-packets.jsonl>');
      const result = await persistPreparedAdjudication({ packets, outFile: path.resolve(options.out), recordsOutFile: options['records-out'] ? path.resolve(options['records-out']) : null, generatedAt: options.now, modelAvailable: Boolean(options['model-available']) });
      console.log(`prepared=${result.candidatePackets.length} status=${result.receipt.semantic.status} receipt=${result.receiptFile}${result.recordsOutFile ? ` records=${result.recordsOutFile}` : ''}`);
    } else if (positional[0] === 'apply') {
      if (!positional[2] || !options.state) throw new Error('apply requires <verdicts.jsonl> and --state <dir>');
      const estateRoot = path.resolve(options['estate-root'] || process.cwd());
      const verdicts = await readJsonl(path.resolve(positional[2]));
      const context = {
        adjudicated_at_sha: options.sha || 'working-tree',
        tools_digest: await toolsDigest(path.resolve(new URL('.', import.meta.url).pathname)),
        // The SAME unguarded canon read that took down entity-layer, discover-entities,
        // semantic-layer apply and loop-driver. Those four were fixed; this fifth site was
        // never listed in the 2026-07-26 portability probe because the probe never invoked
        // `l1-adjudicate apply`, so it survived the round of fixes. An absent canon is a
        // legitimate provenance value -- record the ABSENCE, do not abort adjudication over
        // a missing Markdown file.
        canon_digest: await canonDigest(path.join(estateRoot, 'design/canon/ontology.md')),
        corpus_digest: options['corpus-digest'] || 'unknown',
      };
      const result = await applyVerdicts({ packets, verdicts, stateDir: path.resolve(options.state), estateRoot, context, clusterNames, now: options.now });
      console.log(`accepted=${result.accepted.length} overlays=${result.overlays.length} refusals=${result.refusals.length} rejected=${result.rejected.length} skipped=${result.skipped.length}`);
      for (const row of result.rejected) console.error(`REJECTED ${row.queue_entry_digest?.slice(0, 12)} ${row.verdict}: ${row.why}`);
    } else if (positional[0] === 'reduce') {
      if (!options.state) throw new Error('reduce requires --state <dir>');
      const { queueVector } = await import('./query.mjs');
      const census = queueVector(graph, { discovery, symbolRepos: symbolIndex.symbolRepos }).vector;
      const stateDir = path.resolve(options.state);
      const ledger = await readJsonl(path.join(stateDir, LEDGER_FILE));
      const edges = await readReconciliationEdges(stateDir);
      const result = reduce(census, ledger, { edgeRows: edges, corpusDigest: options['corpus-digest'] || ledger[0]?.corpus_digest || 'unknown' });
      console.log(options.json ? stableStringify(result).trim() : [
        `CENSUS  ${stableStringify(result.census).trim()}`,
        `ACTIVE  ${stableStringify(result.active).trim()}`,
        `persisted resolved edges ${result.drains.length}; pending edge plans ${result.plans.length}; deferred ${result.deferred.length}; refusals ${result.refusals.length}; repair items ${result.repair.length}`,
      ].join('\n'));
    } else throw new Error(`Unknown command: ${positional[0]}`);
    process.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
