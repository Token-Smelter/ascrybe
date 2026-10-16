import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { prepassDocument } from './source-prepass.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const LOCAL_DOCUMENTARY_PLANE_SCHEMA = 'estate-map/local-structural-documentary-plane/v1';
const canonical = value => stableStringify(value).trim();
const compare = (left, right) => left.localeCompare(right);

function documentaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lineText(content, line) {
  return content.split(/\r?\n/u)[line - 1] ?? null;
}

function structuralClaim(body) {
  return Object.freeze({ ...body, claim_id: `structural-claim:${sha256(canonical(body))}` });
}

function relationObservation(body) {
  return Object.freeze({ ...body, observation_id: `relation-observation:${sha256(canonical(body))}` });
}

function fencedRelations({ path, content, prepass, source }) {
  const rows = [];
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/gu;
  for (const block of prepass.inventory.blocks.filter(row => row.type === 'code')) {
    for (const [offset, text] of block.text.split(/\r?\n/u).entries()) {
      let match;
      const pattern = new RegExp(callPattern.source, callPattern.flags);
      while ((match = pattern.exec(text)) !== null) {
        rows.push(relationObservation({
          authority_plane: 'deterministic_structure',
          observation_class: 'relation_like_not_identity',
          relation_kind: 'command_or_function_invocation',
          surface: match[1],
          syntax_license: 'lexical call shape inside a source code fence; invocation only, never same-entity evidence',
          source: { ...source, path, line: block.start + offset, quote: text.trim() },
          identity_admission: 'excluded',
        }));
      }
    }
  }
  return rows;
}

function structuredRelations({ path, content, prepass, source }) {
  return prepass.structured_observations.filter(row => {
    const leaf = row.field_path.split('.').at(-1)?.toLowerCase();
    return ['command', 'commands', 'script', 'scripts', 'validator', 'validation'].includes(leaf);
  }).map(row => relationObservation({
    authority_plane: 'deterministic_structure',
    observation_class: 'relation_like_not_identity',
    relation_kind: /valid/iu.test(row.field_path) ? 'validator_enforcement_observation' : 'declared_command_observation',
    surface: row.field_path,
    syntax_license: `${row.producer} emitted a ${row.syntax} field observation; the value describes wiring or invocation, not identity`,
    source: { ...source, path, line: row.source_span.start,
      quote: lineText(content, row.source_span.start) },
    identity_admission: 'excluded',
  }));
}

/** Compile only parser-licensed structure. It never represents prose meaning as a local claim. */
export function buildLocalStructuralDocumentaryPlane({
  materialized_root: materializedRoot, tree_manifest: treeManifest,
  document_paths: documentPaths, imported_semantic_claims: importedSemanticClaims = [],
}) {
  if (!Array.isArray(documentPaths) || !documentPaths.length
    || new Set(documentPaths).size !== documentPaths.length) {
    throw documentaryError('DOCUMENTARY_SCOPE_INVALID', 'document paths must be a non-empty unique list');
  }
  const root = resolve(materializedRoot);
  const manifestByPath = new Map(treeManifest.files.map(row => [row.path, row]));
  const claims = [], relations = [], mentions = [], findings = [], documents = [];
  for (const path of documentPaths.slice().sort(compare)) {
    const manifest = manifestByPath.get(path);
    if (!manifest) throw documentaryError('DOCUMENTARY_PATH_OUTSIDE_TREE', `document is absent from exact Git tree: ${path}`);
    const content = readFileSync(join(root, path), 'utf8');
    if (sha256(Buffer.from(content)) !== manifest.content_sha256) {
      throw documentaryError('DOCUMENTARY_CONTENT_MISMATCH', `document differs from exact Git blob: ${path}`);
    }
    const prepass = prepassDocument({ path, content, source_sha: treeManifest.commit_sha,
      corpus_digest: treeManifest.content_set_digest });
    const source = { commit_sha: treeManifest.commit_sha, tree_oid: treeManifest.tree_oid,
      blob_oid: manifest.blob_oid, content_sha256: manifest.content_sha256 };
    for (const block of prepass.inventory.blocks.filter(row => row.type === 'heading')) {
      const quote = block.text.split(/\r?\n/u)[0];
      claims.push(structuralClaim({
        authority_plane: 'deterministic_structure',
        claim_mode: 'structural_only',
        predicate: 'declares_markdown_heading',
        syntax_license: 'lossless Markdown block inventory recognized an ATX heading',
        subject: path,
        object: quote.replace(/^#{1,6}\s+/u, '').replace(/\s*#*\s*$/u, ''),
        source: { ...source, path, start: block.start, end: block.end,
          byte_start: block.byte_start, byte_end: block.byte_end, quote },
      }));
    }
    for (const row of prepass.structured_observations) {
      claims.push(structuralClaim({
        authority_plane: 'deterministic_structure',
        claim_mode: 'structural_only',
        predicate: 'declares_structured_field_value',
        syntax_license: `${row.producer} licensed ${row.syntax} structure; no prose semantics imported`,
        subject: `${path}#${row.field_path}`,
        object: row.value,
        source: { ...source, path, start: row.source_span.start, end: row.source_span.end,
          quote: row.source_quote },
      }));
    }
    mentions.push(...prepass.mentions.map(row => Object.freeze({ ...row, source })));
    findings.push(...prepass.findings.map(row => Object.freeze({ ...row, source })));
    relations.push(...fencedRelations({ path, content, prepass, source }));
    relations.push(...structuredRelations({ path, content, prepass, source }));
    documents.push(Object.freeze({ path, extension: extname(path).toLowerCase(),
      blob_oid: manifest.blob_oid, content_sha256: manifest.content_sha256,
      bytes: manifest.bytes, structural_claims: claims.filter(row => row.source.path === path).length,
      mentions: prepass.mentions.length, findings: prepass.findings.length }));
  }
  for (const claim of importedSemanticClaims) {
    if (claim?.authority_plane !== 'imported_semantic' || !claim.source?.path
      || !Number.isInteger(claim.source?.line) || !claim.source?.quote || !claim.statement) {
      throw documentaryError('IMPORTED_SEMANTIC_CLAIM_INVALID', 'imported semantic claims require explicit authority, statement, and source citation');
    }
    const manifest = manifestByPath.get(claim.source.path);
    if (!manifest || !documentPaths.includes(claim.source.path)) {
      throw documentaryError('IMPORTED_SEMANTIC_SOURCE_OUTSIDE_SCOPE', 'imported semantic claim source is outside documentary scope');
    }
    const content = readFileSync(join(root, claim.source.path), 'utf8');
    if (!lineText(content, claim.source.line)?.includes(claim.source.quote)) {
      throw documentaryError('IMPORTED_SEMANTIC_QUOTE_MISMATCH', 'imported semantic claim quote does not occur on its cited line');
    }
  }
  claims.sort((left, right) => left.claim_id.localeCompare(right.claim_id));
  relations.sort((left, right) => left.observation_id.localeCompare(right.observation_id));
  mentions.sort((left, right) => left.id.localeCompare(right.id));
  const imported = importedSemanticClaims.map(row => Object.freeze(structuredClone(row)));
  const body = {
    schema: LOCAL_DOCUMENTARY_PLANE_SCHEMA,
    project_id: treeManifest.project_id,
    source_head: treeManifest.commit_sha,
    tree_oid: treeManifest.tree_oid,
    mode: 'structural_only',
    authority_boundary: {
      local_claims: 'deterministic parser-licensed structure only',
      imported_semantic_claims: 'optional, explicitly labelled, separately counted, and never inferred by this adapter',
      relation_like_observations: 'retained outside identity admission',
    },
    documents,
    claims,
    mentions,
    relation_like_observations: relations,
    imported_semantic_claims: imported,
    findings,
  };
  return Object.freeze({ ...body, documentary_plane_head: `documentary-plane:${sha256(canonical(body))}` });
}
