// Basis-8 reviewed-resolution producer (C4 design section 13).
//
// An LLM proposes cross-occurrence documentary/code references; this module disposes. The model
// may only select from two enumerated sets — the identity-candidate declarations and the exact
// documentary occurrence records — so a free-text referent is unrepresentable. Every proposal is
// re-verified here against source bytes before any record is minted, and a failed proposal becomes
// a recorded refusal rather than a silent drop.
//
// This file performs no model invocation. The transport lives in the CLI so the whole gate can be
// replayed offline from captured response bytes.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidencePointer, buildMention } from './argument-mentions.mjs';
import {
  buildAutomaticIdentityConstraint, buildIdentityVerificationRegistry,
  buildReviewedResolutionDependency, buildReviewedResolutionReceipt, verifyIdentityConstraint,
} from './referent-identity.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const REVIEWED_RESOLUTION_UNIVERSE_SCHEMA = 'estate-map/reviewed-resolution-universe/v1';
export const REVIEWED_RESOLUTION_PROPOSAL_SCHEMA = 'estate-map/reviewed-resolution-proposal/v1';
export const REVIEWED_RESOLUTION_REFUSAL_SCHEMA = 'estate-map/reviewed-resolution-refusal/v1';
export const REVIEWED_RESOLUTION_RUN_RECEIPT_SCHEMA = 'estate-map/reviewed-resolution-run-receipt/v1';
export const REVIEWED_RESOLUTION_MATERIALIZATION_ID = 'materialization:reviewed-resolution-v1';

const canonical = value => stableStringify(value).trim();
const hashId = (prefix, value) => `${prefix}:${sha256(canonical(value))}`;
const compare = (left, right) => left.localeCompare(right);

export class ReviewedResolutionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ReviewedResolutionError';
    this.code = code;
    this.detail = detail;
  }
}
const fail = (code, message, detail = {}) => { throw new ReviewedResolutionError(code, message, detail); };

/** Exact 1-based line starts, so every span is recomputed rather than trusted. */
function lineIndex(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}
function lineText(content, starts, line) {
  if (line < 1 || line > starts.length) return null;
  const start = starts[line - 1];
  const end = line < starts.length ? starts[line] - 1 : content.length;
  return content.slice(start, end).replace(/\r$/u, '');
}

/**
 * Enumerate byte-exact documentary occurrences from the documentary plane's own mentions.
 * The surface and its lines come from the documentary producer; only the byte arithmetic is
 * computed here, from the exact materialized bytes.
 */
export function enumerateDocumentaryOccurrences({ documentary, materialized_root: root }) {
  const rows = [];
  const contentByPath = new Map();
  for (const document of documentary.documents) {
    contentByPath.set(document.path, readFileSync(join(root, document.path), 'utf8'));
  }
  for (const mention of documentary.mentions) {
    const content = contentByPath.get(mention.file);
    if (content == null) continue;
    const starts = lineIndex(content);
    for (const line of mention.lines) {
      const text = lineText(content, starts, line);
      if (text == null) continue;
      let from = 0;
      while (from <= text.length - mention.surface.length) {
        const column = text.indexOf(mention.surface, from);
        if (column < 0) break;
        const byteStart = Buffer.byteLength(content.slice(0, starts[line - 1] + column), 'utf8');
        const body = {
          schema: 'estate-map/documentary-occurrence/v1',
          document_path: mention.file,
          line,
          column_start: column + 1,
          byte_start: byteStart,
          byte_end: byteStart + Buffer.byteLength(mention.surface, 'utf8'),
          surface: mention.surface,
          quote: text,
          documentary_mention_id: mention.id,
          content_sha256: sha256(Buffer.from(content, 'utf8')),
        };
        rows.push(Object.freeze({ ...body, occurrence_id: hashId('documentary-occurrence', body) }));
        from = column + Math.max(1, mention.surface.length);
      }
    }
  }
  return Object.freeze(rows.sort((left, right) => compare(left.occurrence_id, right.occurrence_id)));
}

/** The closed input universe. Nothing outside these two enumerated sets can be proposed. */
export function buildReviewedResolutionUniverse({
  identity_candidates: candidates, documentary_occurrences: occurrences,
  code_plane_head: codePlaneHead, documentary_plane_head: documentaryPlaneHead,
  source_head: sourceHead, project_id: projectId,
}) {
  const declarations = candidates.map(candidate => Object.freeze({
    candidate_fact_id: candidate.fact_id,
    fact_kind: candidate.fact_kind,
    repository: candidate.record.repo,
    file: candidate.record.file,
    line: candidate.record.line,
    surface: candidate.mention.surface,
    declaration_kind: candidate.record.symbol_kind || candidate.candidate_class,
    code_mention_id: candidate.mention.mention_id,
    code_evidence_id: candidate.evidence_id,
    candidate_basis: candidate.candidate_basis,
  })).sort((left, right) => compare(left.candidate_fact_id, right.candidate_fact_id));
  if (new Set(declarations.map(row => row.candidate_fact_id)).size !== declarations.length) {
    fail('UNIVERSE_DUPLICATE_CANDIDATE', 'identity candidates must be unique by fact id');
  }
  if (new Set(occurrences.map(row => row.occurrence_id)).size !== occurrences.length) {
    fail('UNIVERSE_DUPLICATE_OCCURRENCE', 'documentary occurrences must be unique by occurrence id');
  }
  const body = {
    schema: REVIEWED_RESOLUTION_UNIVERSE_SCHEMA,
    project_id: projectId,
    source_head: sourceHead,
    code_plane_head: codePlaneHead,
    documentary_plane_head: documentaryPlaneHead,
    declarations,
    occurrences: occurrences.slice(),
  };
  return Object.freeze({ ...body, universe_digest: sha256(canonical(body)) });
}

const PROPOSAL_FIELDS = Object.freeze(['candidate_fact_id', 'occurrence_id', 'exact_quote']);

/**
 * Strict parse. The whole response must be one JSON array — an optional Markdown code fence is
 * the only wrapper tolerated. Scanning for a bracket anywhere would silently accept a nested
 * array inside an envelope object, so the text must begin and end as an array.
 */
export function parseReviewedResolutionResponse(text) {
  let trimmed = String(text ?? '').trim();
  const fence = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  if (fence) trimmed = fence[1].trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    fail('RESPONSE_NOT_A_JSON_ARRAY', 'reviewed-resolution response must be exactly one JSON array');
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (error) { fail('RESPONSE_NOT_PARSEABLE', `reviewed-resolution response is not valid JSON: ${error.message}`); }
  if (!Array.isArray(parsed)) fail('RESPONSE_NOT_A_JSON_ARRAY', 'reviewed-resolution response must be an array');
  return parsed;
}

function refusal(code, detail) {
  const body = { schema: REVIEWED_RESOLUTION_REFUSAL_SCHEMA, refusal_code: code, ...detail };
  return Object.freeze({ ...body, refusal_id: hashId('reviewed-resolution-refusal', body) });
}

/**
 * Re-verify every proposal against exact bytes, then mint records only for survivors.
 * Zero accepted proposals is a valid result; a refusal always names its rule.
 */
export function gateReviewedResolutionProposals({
  universe, proposals, materialized_root: root, model_binding: modelBinding,
  prompt_digest: promptDigest, response_digest: responseDigest,
  review_authority_id: reviewAuthorityId, documentary_source_version_id: documentarySourceVersionId,
}) {
  const declarationById = new Map(universe.declarations.map(row => [row.candidate_fact_id, row]));
  const occurrenceById = new Map(universe.occurrences.map(row => [row.occurrence_id, row]));
  const contentCache = new Map();
  const contentFor = path => {
    if (!contentCache.has(path)) contentCache.set(path, readFileSync(join(root, path), 'utf8'));
    return contentCache.get(path);
  };
  const accepted = [], refusals = [];
  const seenPairs = new Map(), occurrenceClaims = new Map();

  const rows = proposals.map((proposal, index) => ({ proposal, index }));
  for (const { proposal, index } of rows) {
    const keys = proposal && typeof proposal === 'object' && !Array.isArray(proposal)
      ? Object.keys(proposal).sort() : null;
    if (!keys || canonical(keys) !== canonical([...PROPOSAL_FIELDS].sort())) {
      refusals.push(refusal('PROPOSAL_SHAPE_INVALID', { proposal_index: index, observed_fields: keys }));
      continue;
    }
    const declaration = declarationById.get(proposal.candidate_fact_id);
    if (!declaration) {
      refusals.push(refusal('CANDIDATE_OUTSIDE_CLOSED_UNIVERSE',
        { proposal_index: index, candidate_fact_id: proposal.candidate_fact_id }));
      continue;
    }
    const occurrence = occurrenceById.get(proposal.occurrence_id);
    if (!occurrence) {
      refusals.push(refusal('OCCURRENCE_OUTSIDE_CLOSED_UNIVERSE',
        { proposal_index: index, occurrence_id: proposal.occurrence_id }));
      continue;
    }
    const pairKey = `${declaration.candidate_fact_id}\u0000${occurrence.occurrence_id}`;
    if (seenPairs.has(pairKey)) {
      refusals.push(refusal('DUPLICATE_PROPOSAL', { proposal_index: index, pair_key: pairKey }));
      continue;
    }
    seenPairs.set(pairKey, index);

    const content = contentFor(occurrence.document_path);
    if (sha256(Buffer.from(content, 'utf8')) !== occurrence.content_sha256) {
      refusals.push(refusal('DOCUMENT_CONTENT_CHANGED',
        { proposal_index: index, document_path: occurrence.document_path }));
      continue;
    }
    const starts = lineIndex(content);
    const text = lineText(content, starts, occurrence.line);
    if (text !== occurrence.quote || text !== proposal.exact_quote) {
      refusals.push(refusal('QUOTE_NOT_BYTE_EXACT_ON_CITED_LINE', {
        proposal_index: index, document_path: occurrence.document_path, line: occurrence.line,
      }));
      continue;
    }
    const byteStart = Buffer.byteLength(
      content.slice(0, starts[occurrence.line - 1] + occurrence.column_start - 1), 'utf8');
    const slice = Buffer.from(content, 'utf8')
      .subarray(occurrence.byte_start, occurrence.byte_end).toString('utf8');
    if (byteStart !== occurrence.byte_start || slice !== occurrence.surface) {
      refusals.push(refusal('OCCURRENCE_SPAN_ARITHMETIC_FAILED', {
        proposal_index: index, occurrence_id: occurrence.occurrence_id,
      }));
      continue;
    }
    const codePath = `${declaration.repository}/${declaration.file}`;
    // Not every identity candidate is witnessed by a readable text line: a `repo` candidate is
    // witnessed by its component root or `.git/HEAD`. Those cannot carry a cross-occurrence
    // documentary reference, so they are refused by rule rather than read blindly.
    const declarationPath = join(root, declaration.file);
    if (!existsSync(declarationPath) || !statSync(declarationPath).isFile()) {
      refusals.push(refusal('DECLARATION_SOURCE_NOT_A_READABLE_FILE', {
        proposal_index: index, code_path: codePath, declared_file: declaration.file,
      }));
      continue;
    }
    const declarationContent = contentFor(declaration.file);
    const declarationLine = lineText(declarationContent,
      lineIndex(declarationContent), declaration.line);
    if (declarationLine == null || !declarationLine.includes(declaration.surface)) {
      refusals.push(refusal('DECLARATION_LINE_DIFFERS_FROM_RECORD', {
        proposal_index: index, code_path: codePath, line: declaration.line,
        declared_surface: declaration.surface,
      }));
      continue;
    }
    const claims = occurrenceClaims.get(occurrence.occurrence_id) || [];
    claims.push({ index, declaration, occurrence, quote: text });
    occurrenceClaims.set(occurrence.occurrence_id, claims);
  }

  // One documentary occurrence naming two different declarations is ambiguous, not a pair of
  // joins. Both sides are refused rather than arbitrarily selecting one.
  const survivors = [];
  for (const [occurrenceId, claims] of occurrenceClaims) {
    if (claims.length > 1) {
      for (const claim of claims) refusals.push(refusal('AMBIGUOUS_OCCURRENCE_MULTIPLE_CANDIDATES', {
        proposal_index: claim.index, occurrence_id: occurrenceId,
        candidate_fact_ids: claims.map(row => row.declaration.candidate_fact_id).sort(),
      }));
      continue;
    }
    survivors.push(claims[0]);
  }

  for (const claim of survivors.sort((left, right) => left.index - right.index)) {
    const { declaration, occurrence, quote } = claim;
    const documentaryEvidence = buildEvidencePointer({
      source_version_id: documentarySourceVersionId,
      pointer: {
        kind: 'document_span', file: occurrence.document_path,
        start: occurrence.line, end: occurrence.line,
        byte_start: occurrence.byte_start, byte_end: occurrence.byte_end,
        exact_text: occurrence.surface, digest: sha256(occurrence.surface),
      },
    });
    const documentaryMention = buildMention({
      evidence_pointer: documentaryEvidence, surface: occurrence.surface, role: 'subject',
      namespace: occurrence.document_path, source_status: 'current',
      context_digest: sha256(quote), disposition: 'identity_candidate',
    }).mention;
    const dependencies = [
      buildReviewedResolutionDependency({
        dependency_id: `reviewed-dependency:documentary-occurrence:${occurrence.occurrence_id}`,
        exact_record: occurrence,
      }),
      buildReviewedResolutionDependency({
        dependency_id: `reviewed-dependency:code-declaration:${declaration.candidate_fact_id}`,
        exact_record: declaration,
      }),
      buildReviewedResolutionDependency({
        dependency_id: `reviewed-dependency:model-proposal:${sha256(canonical({
          candidate_fact_id: declaration.candidate_fact_id, occurrence_id: occurrence.occurrence_id,
        }))}`,
        exact_record: {
          model_binding: modelBinding, prompt_digest: promptDigest, response_digest: responseDigest,
          universe_digest: universe.universe_digest,
          candidate_fact_id: declaration.candidate_fact_id,
          occurrence_id: occurrence.occurrence_id, exact_quote: quote,
        },
      }),
      buildReviewedResolutionDependency({
        dependency_id: `reviewed-dependency:source-heads:${sha256(canonical([
          universe.source_head, universe.code_plane_head, universe.documentary_plane_head,
        ]))}`,
        exact_record: {
          project_id: universe.project_id, source_head: universe.source_head,
          code_plane_head: universe.code_plane_head,
          documentary_plane_head: universe.documentary_plane_head,
        },
      }),
    ];
    const receipt = buildReviewedResolutionReceipt({
      endpoint_mention_ids: [declaration.code_mention_id, documentaryMention.mention_id],
      dependencies,
      selected_head_ids: [universe.code_plane_head, universe.documentary_plane_head],
      review_authority_id: reviewAuthorityId,
    });
    accepted.push(Object.freeze({
      candidate_fact_id: declaration.candidate_fact_id,
      occurrence_id: occurrence.occurrence_id,
      code_mention_id: declaration.code_mention_id,
      documentary_mention_id: documentaryMention.mention_id,
      documentary_mention: documentaryMention,
      documentary_evidence: documentaryEvidence,
      dependencies: Object.freeze(dependencies),
      receipt,
      proposal: Object.freeze({
        schema: REVIEWED_RESOLUTION_PROPOSAL_SCHEMA,
        candidate_fact_id: declaration.candidate_fact_id,
        occurrence_id: occurrence.occurrence_id, exact_quote: quote,
      }),
    }));
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    refusals: Object.freeze(refusals.sort((left, right) => compare(left.refusal_id, right.refusal_id))),
  });
}

/**
 * Mint the identity constraint for one accepted proposal and prove it through the live §3.2
 * verifier against a registry built from the exact endpoint records. A constraint that does not
 * verify is never returned.
 */
export function mintReviewedResolutionConstraint({ accepted, code_mention: codeMention,
  code_evidence: codeEvidence }) {
  const registry = buildIdentityVerificationRegistry({
    mentions: [codeMention, accepted.documentary_mention],
    evidence_pointers: [codeEvidence, accepted.documentary_evidence],
    receipts: [accepted.receipt],
    reviewed_dependencies: [...accepted.dependencies],
  });
  const constraint = buildAutomaticIdentityConstraint({
    left: accepted.code_mention_id,
    right: accepted.documentary_mention_id,
    basis: {
      kind: 'prior_reviewed_resolution',
      receipt_id: accepted.receipt.receipt_id,
      dependency_ids: accepted.receipt.dependency_ids,
      dependencies_valid: true,
    },
    basis_evidence_ids: [],
    basis_assertion_ids: [],
    source_status: 'current',
    valid_time: null,
    materialization_id: REVIEWED_RESOLUTION_MATERIALIZATION_ID,
  }, registry);
  verifyIdentityConstraint(constraint, registry);
  return Object.freeze({ constraint, registry });
}

export function buildReviewedResolutionRunReceipt({
  universe, gated, model_binding: modelBinding, prompt_digest: promptDigest,
  response_digest: responseDigest, constraints, review_authority_id: reviewAuthorityId,
}) {
  const body = {
    schema: REVIEWED_RESOLUTION_RUN_RECEIPT_SCHEMA,
    project_id: universe.project_id,
    source_head: universe.source_head,
    code_plane_head: universe.code_plane_head,
    documentary_plane_head: universe.documentary_plane_head,
    universe_digest: universe.universe_digest,
    universe_size: {
      declarations: universe.declarations.length,
      documentary_occurrences: universe.occurrences.length,
    },
    model_binding: modelBinding,
    prompt_digest: promptDigest,
    response_digest: responseDigest,
    review_authority_id: reviewAuthorityId,
    proposals_received: gated.accepted.length + gated.refusals.length,
    accepted: gated.accepted.length,
    refused: gated.refusals.length,
    refusals_by_code: Object.fromEntries([...gated.refusals.reduce((counts, row) => {
      counts.set(row.refusal_code, (counts.get(row.refusal_code) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => compare(left, right))),
    identity_constraint_ids: constraints.map(row => row.constraint.constraint_id).sort(),
    reviewed_resolution_receipt_ids: gated.accepted.map(row => row.receipt.receipt_id).sort(),
    measurement_policy: 'observed outcome only; zero accepted proposals is a valid result and no join target exists',
  };
  return Object.freeze({ ...body, receipt_id: hashId('reviewed-resolution-run-receipt', body) });
}
