import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, stableStringify, writeStableCanonical } from './lib.mjs';

export const CLAIM_EVIDENCE_EXPLORER_SCHEMA = 'estate-map/claim-evidence-explorer/v1';
const canonical = value => stableStringify(value).trim();
const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function cssClass(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_-]/giu, '-').toLowerCase();
}

// This page is a convenience view, not the corpus. At estate scale (111,499 claims) rendering every
// claim exceeded V8's maximum string length and produced a page no browser could open, which failed
// the whole run AFTER its data artifacts were already written. The authoritative record is the
// receipt written beside this page and the claim-evidence shards; the bound below is disclosed in
// the page itself so a reader never mistakes a partial view for the whole corpus.
const MAX_RENDERED_CLAIMS = 5000;

function explorerModel(map) {
  const receiptByClaim = new Map(map.adjudication_receipts.map(row => [row.claim_id, row]));
  const evidenceById = new Map(map.evidence.map(row => [row.evidence_id, row]));
  const resultById = new Map(map.obligation_results.map(row => [row.result_id, row]));
  const successors = new Map(map.supersession_receipts.map(row => [row.old_claim_id, row]));
  const predecessors = new Map(map.supersession_receipts.map(row => [row.new_claim_id, row]));
  const claims = map.claims.map(claim => {
    const receipt = receiptByClaim.get(claim.claim_id);
    const results = receipt.obligation_result_ids.map(id => resultById.get(id)).map(result => ({
      ...result,
      evidence: result.evidence_ids.map(id => evidenceById.get(id)),
    }));
    return {
      ...claim,
      verdict: receipt.verdict,
      realization: receipt.realization,
      receipt_id: receipt.receipt_id,
      obligation_results: results,
      superseded_by: successors.get(claim.claim_id)?.new_claim_id || null,
      supersedes: predecessors.get(claim.claim_id)?.old_claim_id || null,
    };
  });
  const body = {
    schema: CLAIM_EVIDENCE_EXPLORER_SCHEMA,
    project: map.project,
    coverage: map.coverage,
    policy: map.policy,
    claims,
    edges: map.edges,
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

const css = `:root{color-scheme:light;--canvas:oklch(.965 .008 235);--surface:oklch(.995 .002 235);--ink:oklch(.20 .025 240);--muted:oklch(.47 .026 240);--line:oklch(.84 .018 235);--green:oklch(.55 .12 145);--blue:oklch(.55 .13 245);--amber:oklch(.65 .14 78);--red:oklch(.56 .17 25);--gray:oklch(.56 .02 240);--purple:oklch(.54 .14 300);--focus:oklch(.5 .17 250)}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,oklch(.91 .035 230) 0,transparent 28rem),var(--canvas);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}.shell{max-width:96rem;margin:auto;padding:1.25rem 1.5rem 5rem}.mast{display:grid;grid-template-columns:minmax(20rem,1fr) minmax(22rem,.68fr);gap:3rem;align-items:end;padding:2.5rem 0 1.4rem;border-bottom:1px solid var(--line)}h1{max-width:21ch;margin:0 0 .65rem;font-size:2.4rem;line-height:1.05;letter-spacing:-.035em;text-wrap:balance}.lede{max-width:70ch;margin:0;color:var(--muted)}.sha{padding:.8rem 1rem;background:var(--ink);color:var(--surface);font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.metrics{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--line)}.metric{min-width:9rem;padding:1rem 1.5rem 1rem 0;margin-right:1.7rem}.metric strong{display:block;font:1.35rem/1.2 ui-monospace,monospace}.metric span{color:var(--muted)}.toolbar{display:flex;flex-wrap:wrap;gap:.7rem;align-items:end;padding:1.4rem 0}.toolbar label{display:grid;gap:.35rem;font-weight:650}.toolbar input,.toolbar select{min-height:2.75rem;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:.65rem .75rem}.toolbar input{width:min(36rem,72vw)}.toolbar input:focus,.toolbar select:focus,button:focus-visible,summary:focus-visible{outline:3px solid color-mix(in oklch,var(--focus) 35%,transparent);outline-offset:2px}.timeline{display:grid;gap:.85rem}.claim{background:color-mix(in oklch,var(--surface) 87%,transparent);border:1px solid var(--line)}.claim[hidden]{display:none}.claim summary{display:grid;grid-template-columns:minmax(12rem,.34fr) minmax(18rem,1fr) auto;gap:1rem;align-items:start;padding:1rem;cursor:pointer}.identity{font:12px/1.45 ui-monospace,monospace;overflow-wrap:anywhere}.statement{font-weight:700;text-wrap:pretty}.status{display:flex;gap:.35rem;justify-content:end;flex-wrap:wrap}.tag{padding:.16rem .45rem;border:1px solid currentColor;font-size:.76rem;white-space:nowrap}.tag.supported{color:var(--green)}.tag.refuted,.tag.diverged{color:var(--red)}.tag.underdetermined,.tag.unverifiable,.tag.unknown{color:oklch(.48 .12 75)}.tag.implemented{color:var(--blue)}.tag.not_started{color:var(--blue)}.tag.removed,.tag.superseded{color:var(--gray)}.detail{display:grid;grid-template-columns:minmax(18rem,.65fr) minmax(24rem,1.35fr);gap:1.5rem;padding:0 1rem 1.2rem}.source{margin:.4rem 0 0;padding:.75rem;background:var(--ink);color:var(--surface);font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap}.facts{border-top:1px solid var(--line)}.fact{display:grid;grid-template-columns:8rem 1fr;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line)}.fact strong{font-size:.8rem;text-transform:none}.fact p{margin:0}.fact code{font:12px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}.supersession{margin-top:.8rem;padding:.65rem;border:1px solid var(--line);color:var(--muted)}.legend{display:flex;gap:.7rem;flex-wrap:wrap;margin:.4rem 0 1.2rem;color:var(--muted)}.legend span{display:flex;align-items:center;gap:.35rem}.legend i{width:.65rem;height:.65rem;border-radius:50%;background:currentColor}.empty{padding:2rem;border:1px dashed var(--line);color:var(--muted)}@media(max-width:800px){.mast,.detail{grid-template-columns:1fr}.claim summary{grid-template-columns:1fr}.status{justify-content:start}.sha{margin-top:1rem}.fact{grid-template-columns:1fr}}@media(prefers-reduced-motion:no-preference){.claim{transition:border-color 180ms cubic-bezier(.22,1,.36,1),background-color 180ms cubic-bezier(.22,1,.36,1)}.claim:hover{border-color:color-mix(in oklch,var(--focus) 40%,var(--line))}}`;

function obligationHtml(result) {
  const evidence = result.evidence.map(row => {
    const summary = row.kind === 'code_symbol_census'
      ? `${row.matches.length} declaration(s): ${row.matches.map(match => `${match.file}:${match.line} ${match.surface}`).join(', ')}`
      : row.kind === 'verification_execution'
        ? `${row.command.join(' ')} → exit ${row.exit_code}; attestation ${row.stdout_pattern_matched ? 'matched' : 'missing'}`
        : row.kind === 'git_tree_path_set'
          ? `${row.observed_paths.length} path(s); ${row.missing_paths.length} missing; ${row.extra_paths.length} extra`
          : row.kind === 'closed_tree_text_search'
            ? `${row.hits.length} matching occurrence(s) across ${row.complete_paths.length} complete path(s)`
            : row.kind === 'open_question' ? row.missing_evidence || row.question
              : `${row.path || ''}:${row.line || ''} ${row.quote || ''}`;
    return `<code>${esc(row.evidence_id)}</code><br>${esc(summary)}`;
  }).join('<br>');
  return `<div class="fact"><strong>${esc(result.state)}</strong><p>${esc(result.reason)}<br>${evidence}</p></div>`;
}

function claimHtml(claim, byId) {
  const successor = byId.get(claim.superseded_by);
  const predecessor = byId.get(claim.supersedes);
  const lifecycle = successor
    ? `<div class="supersession">Superseded by <strong>${esc(successor.claim_key)}</strong>: ${esc(successor.statement)}</div>`
    : predecessor ? `<div class="supersession">Supersedes <strong>${esc(predecessor.claim_key)}</strong>: ${esc(predecessor.statement)}</div>` : '';
  return `<details class="claim" data-search="${esc(canonical(claim).toLowerCase())}" data-verdict="${esc(claim.verdict)}" data-realization="${esc(claim.realization)}"><summary><span class="identity">${esc(claim.claim_key)}<br>${esc(claim.source.path)}:${claim.source.line}</span><span class="statement">${esc(claim.statement)}</span><span class="status"><span class="tag ${cssClass(claim.verdict)}">${esc(claim.verdict)}</span><span class="tag ${cssClass(claim.realization)}">${esc(claim.realization)}</span><span class="tag ${cssClass(claim.decision_status)}">${esc(claim.decision_status)}</span></span></summary><div class="detail"><div><dl><dt>Claim kind</dt><dd>${esc(claim.claim_kind)}</dd><dt>Source status</dt><dd>${esc(claim.source_status)}</dd><dt>Decision status</dt><dd>${esc(claim.decision_status)}</dd><dt>Receipt</dt><dd class="identity">${esc(claim.receipt_id)}</dd></dl><pre class="source">${esc(claim.source.quote)}</pre>${lifecycle}</div><div><strong>Evidence obligations</strong><div class="facts">${claim.obligation_results.map(obligationHtml).join('')}</div></div></div></details>`;
}

function html(model) {
  const byId = new Map(model.claims.map(row => [row.claim_id, row]));
  const rendered = model.claims.slice(0, MAX_RENDERED_CLAIMS);
  const claims = rendered.map(claim => claimHtml(claim, byId)).join('');
  const disclosure = rendered.length < model.claims.length
    ? `<p class="empty">Showing the first ${rendered.length} of ${model.claims.length} claims. This page is bounded so it stays openable; the complete corpus is the receipt beside this file and the claim-evidence shards.</p>`
    : '';
  // The embedded payload previously duplicated the entire model, which no script on this page reads
  // and which alone exceeded the string ceiling. The rendered identities are enough to correlate a
  // row with the receipt.
  const data = JSON.stringify({
    schema: model.schema, digest: model.digest, project: model.project,
    rendered_claim_ids: rendered.map(row => row.claim_id),
    rendered_claims: rendered.length, total_claims: model.claims.length,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(model.project.id)} · intent and reality</title><style>${css}</style></head><body><main class="shell"><header class="mast"><div><h1>${esc(model.project.id)}: intent, reality, evidence, and history</h1><p class="lede">Every semantic claim terminates with a source-bound verdict and realization state. Identity, evidence, implementation, and supersession remain separate so the map can show intended, current, historical, and divergent states without inventing links.</p></div><div class="sha">commit ${esc(model.project.sha)}<br>model ${esc(model.digest)}<br>${esc(model.policy.closed_world_absence)}</div></header><section class="metrics" aria-label="Coverage"><div class="metric"><strong>${model.coverage.semantic_claims}</strong><span>semantic claims</span></div><div class="metric"><strong>${model.coverage.terminal_receipts}</strong><span>terminal receipts</span></div><div class="metric"><strong>${model.coverage.verdicts.supported}</strong><span>supported</span></div><div class="metric"><strong>${model.coverage.verdicts.refuted}</strong><span>refuted</span></div><div class="metric"><strong>${model.coverage.verdicts.underdetermined + model.coverage.verdicts.unverifiable}</strong><span>open / unverifiable</span></div><div class="metric"><strong>${model.coverage.supersession_edges}</strong><span>supersession edges</span></div></section><div class="toolbar"><label for="search">Find claim, source, symbol, or evidence<input id="search" type="search" placeholder="canonical factor chain" autocomplete="off" spellcheck="false"></label><label for="verdict">Verdict<select id="verdict"><option value="">all</option><option>supported</option><option>refuted</option><option>underdetermined</option><option>unverifiable</option></select></label><label for="realization">Realization<select id="realization"><option value="">all</option><option>implemented</option><option>not_started</option><option>diverged</option><option>removed</option><option>unknown</option></select></label></div><div class="legend" aria-label="Legend"><span style="color:var(--green)"><i></i>supported</span><span style="color:var(--blue)"><i></i>implemented / planned</span><span style="color:var(--amber)"><i></i>open</span><span style="color:var(--red)"><i></i>refuted / drifted</span><span style="color:var(--gray)"><i></i>historical</span></div>${disclosure}<section class="timeline" id="claims">${claims}</section><p id="empty" class="empty" hidden>No claims match this view.</p></main><script type="application/json" id="map-data">${data}</script><script>(()=>{const search=document.getElementById('search'),verdict=document.getElementById('verdict'),realization=document.getElementById('realization'),rows=[...document.querySelectorAll('.claim')],empty=document.getElementById('empty');function apply(){const q=search.value.trim().toLowerCase();let shown=0;for(const row of rows){const visible=(!q||row.dataset.search.includes(q))&&(!verdict.value||row.dataset.verdict===verdict.value)&&(!realization.value||row.dataset.realization===realization.value);row.hidden=!visible;if(visible)shown+=1;}empty.hidden=shown!==0;}search.addEventListener('input',apply);verdict.addEventListener('change',apply);realization.addEventListener('change',apply);})();</script></body></html>`;
}

// The page is bounded, but the receipt carries the COMPLETE model and is the authoritative record.
// Materializing it with canonical() built one string over every claim, which at corpus scale exceeds
// V8's maximum string length and threw AFTER the run's durable artifacts were already written — so a
// successful rebuild still exited non-zero. The streaming writer emits identical canonical bytes
// without ever holding the whole document in memory.
export async function renderClaimEvidenceExplorer({ map, output_dir: outputDir }) {
  const model = explorerModel(map);
  const root = resolve(outputDir);
  mkdirSync(root, { recursive: true });
  const page = join(root, 'claim-evidence-map.html');
  const receipt = join(root, 'claim-evidence-explorer-receipt.json');
  writeFileSync(page, html(model));
  await writeStableCanonical(receipt, model);
  return Object.freeze({ page, receipt, digest: model.digest });
}
