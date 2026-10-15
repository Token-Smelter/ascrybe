// Link already-validated atomic relations without asking the model to regenerate them.
import { renderBlockCatalog } from './source-locator.mjs';
import { validateRelationLinks } from './context-reconciliation.mjs';
import { runCustodiedInference } from './custodied-inference.mjs';
import { parseCensusModelJson } from './neural-json.mjs';
import { INFERENCE_CUSTODY_POLICY } from './inference-custody.mjs';
import { sha256, stableStringify } from './lib.mjs';

export const RELATION_LINKER_SCHEMA = 'estate-map/context-relation-linking/v1';
export const RELATION_LINKER_VERSION = 'context-relation-linker@1';
export const GENERIC_RELATION_LINKER_VERSION = 'context-relation-linker@2';
const canonical = value => stableStringify(value).trim();

export function buildRelationLinkPrompt({ candidate, packet, relations, link_instructions = null }) {
  const tokenByAddress = new Map(packet.catalog.entries.map(entry => [entry.address, entry.token]));
  const catalog = relations.map((relation, index) => ({
    index,
    relation_id: relation.id,
    subject: relation.semantic.subject.surface,
    predicate: relation.semantic.predicate_family,
    object_or_value: relation.semantic.object_or_value,
    evidence: relation.semantic.support_sets.flatMap(set => set.locators.map(locator => ({
      block_token: tokenByAddress.get(locator.block.address),
      quote: locator.text,
    }))),
  }));
  return [
    'Link already-validated atomic relations into the smallest explicit governing-rule graph.',
    'Do NOT regenerate, rewrite, drop, or renumber relations. Return ONLY {"links":[...],"reason":"..."}.',
    'LINK OBJECT: {"from_relation":0,"to_relation":1,"kind":"qualifies|exception_to|depends_on|motivates|prevents|implements",',
    ' "support_locators":[{"role":"primary","source_locator":{"block_token":"b001","quote":"<exact bytes>","context_before":null,"context_after":null,"occurrence":null}}]}',
    'Indexes refer exactly to VALIDATED RELATION CATALOG below. Emit only nonredundant semantic links.',
    'Every link needs at least two exact locators from distinct blocks. ALL source blocks in this packet',
    'are PRIMARY: role MUST be "primary" for every locator; never emit "context". Copy quotes exactly,',
    'including Markdown backticks, punctuation, and emphasis markers. Never author coordinates.',
    link_instructions
      ? `CALIBRATION LINK TARGET: ${link_instructions}`
      : 'CALIBRATION LINK TARGET: identify whether test promotion is exception_to ordinary force_local precedence and whether that promotion prevents selection of the protected live port.',
    'Emit only links actually established by source; an empty links array is lawful when none is established.',
    '',
    'VALIDATED RELATION CATALOG:',
    JSON.stringify(catalog, null, 2),
    '',
    'EXACT PRIMARY SOURCE BLOCKS:',
    renderBlockCatalog(packet.catalog),
    '',
    'DETERMINISTIC CANDIDATE:',
    JSON.stringify({ candidate_id: candidate.id, signals: candidate.signals }),
  ].join('\n');
}

function linkingKey({ candidate, packet, relations, prompt, runner, version }) {
  return sha256(canonical({
    policy: INFERENCE_CUSTODY_POLICY,
    linker: version,
    candidate_id: candidate.id,
    packet_id: packet.id,
    relation_ids: relations.map(relation => relation.id),
    prompt_digest: sha256(prompt),
    model: runner.model,
  }));
}

export async function runRelationLinking({ candidate, packet, relations, runner, checkpoint, budget, link_instructions = null }) {
  if (!Array.isArray(relations) || relations.length < 2) throw new Error('relation linking requires at least two validated relations');
  const version = link_instructions ? GENERIC_RELATION_LINKER_VERSION : RELATION_LINKER_VERSION;
  const prompt = buildRelationLinkPrompt({ candidate, packet, relations, link_instructions });
  const completion = await runCustodiedInference({
    checkpoint,
    stage: 'context-relation-linking',
    key: linkingKey({ candidate, packet, relations, prompt, runner, version }),
    tag: `link:${candidate.id}`,
    prompt,
    runner,
    budget,
    validate: result => {
      const parsed = result.json ?? parseCensusModelJson(result.text || '');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.links)) {
        return { ok: false, reason: 'linker did not return {links:[]}' };
      }
      const relationByIndex = new Map(relations.map((relation, index) => [index, relation]));
      const validated = validateRelationLinks({
        proposed_links: parsed.links,
        relation_by_index: relationByIndex,
        packet,
        candidate,
        producer_version: version,
      });
      return { ok: true, value: { reason: String(parsed.reason || ''), ...validated } };
    },
  });
  const body = completion.incomplete
    ? { schema: RELATION_LINKER_SCHEMA, version, status: 'incomplete', candidate_id: candidate.id, links: [], rejected_links: [], incomplete: completion.incomplete }
    : { schema: RELATION_LINKER_SCHEMA, version, status: 'complete', candidate_id: candidate.id, ...completion.validated, incomplete: null };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}
