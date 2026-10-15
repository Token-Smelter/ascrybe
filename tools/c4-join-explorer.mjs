import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const C4_JOIN_EXPLORER_SCHEMA = 'estate-map/c4-join-explorer/v1';
const canonical = value => stableStringify(value).trim();
const fail = message => { throw new Error(message); };

function sourceSummary(source) {
  if (source.pointer_kind === 'structured_record') return {
    kind: 'code_record',
    label: `${source.repository || '[repository]'} / ${source.document_path || '[record]'}`,
    detail: `${source.fact_kind} · ${source.record_id}`,
    exact_record: source.exact_record,
  };
  return {
    kind: 'document_span',
    label: source.document_path,
    detail: `lines ${source.line_start}–${source.line_end} · bytes ${source.byte_start}–${source.byte_end}`,
    digest: source.evidence_digest,
  };
}

function refusedCandidates(identityJoin) {
  return identityJoin.join_receipts.filter(row => row.disposition !== 'joined').map(row => ({
    receipt_id: row.receipt_id,
    fact_id: row.fact_id,
    fact_kind: row.fact_kind,
    disposition: row.disposition,
    reason: row.reason,
    source_locator: row.source_locator,
    basis: row.basis,
  }));
}

function renderedScope(identityJoin, graphCounts, joins) {
  const refusals = refusedCandidates(identityJoin);
  const batch = identityJoin.batch_receipt || fail('identity join lacks its batch receipt');
  return Object.freeze({
    rendered_shared_referents: joins.length,
    total_shared_referents: graphCounts.shared_assertion_neighborhood_nodes,
    rendered_join_receipts: identityJoin.join_receipts.filter(row => row.disposition === 'joined').length,
    rendered_refusals: refusals.length,
    rendered_evaluated_candidates: identityJoin.join_receipts.length,
    evaluated_batch_candidates: batch.selected_candidate_count,
    full_census_candidates: batch.total_candidates,
    not_evaluated_candidates: batch.not_evaluated_in_this_batch_count,
    policy: 'all evaluated joins and refusals are rendered; pending census candidates retain not-evaluated state in the embedded batch receipt; non-identity graph neighborhoods remain in atlas pages',
  });
}

export function buildC4JoinExplorerModel({ atlas_model: atlasModel, identity_join: identityJoin,
  graph_counts_by_plane: graphCounts }) {
  const statementById = new Map(atlasModel.statements.map(row => [row.assertion_id, row]));
  const referentById = new Map(atlasModel.referents.map(row => [row.referent_id, row]));
  const joinedReceipts = identityJoin.join_receipts.filter(row => row.disposition === 'joined');
  const receiptsByReferent = new Map();
  for (const receipt of joinedReceipts) {
    const held = receiptsByReferent.get(receipt.selected_referent_id) || [];
    held.push(receipt); receiptsByReferent.set(receipt.selected_referent_id, held);
  }
  const joins = [...receiptsByReferent].map(([referentId, receipts]) => {
    const referent = referentById.get(referentId) || fail(`joined referent ${referentId} is absent from the atlas`);
    const assertions = referent.assertions.map(row => {
      const statement = statementById.get(row.assertion_id)
        || fail(`joined assertion ${row.assertion_id} is absent from the atlas`);
      return {
        assertion_id: statement.assertion_id,
        plane: statement.plane,
        role: row.role,
        readable: statement.readable,
        predicate: statement.predicate,
        sources: statement.sources.map(sourceSummary),
      };
    });
    const documentary = assertions.filter(row => row.plane === 'documentary');
    const code = assertions.filter(row => row.plane === 'code');
    if (!documentary.length || !code.length) fail(`joined referent ${referentId} does not reach both planes`);
    return {
      referent_id: referentId,
      observed_surfaces: referent.observed_surfaces,
      documentary,
      code,
      receipts: receipts.map(receipt => ({
        receipt_id: receipt.receipt_id,
        fact_id: receipt.fact_id,
        fact_kind: receipt.fact_kind,
        basis: receipt.basis,
        source_locator: receipt.source_locator,
        identity_constraint_ids: receipt.identity_constraint_ids,
        documentary_mention_ids: receipt.documentary_mention_ids,
      })),
    };
  }).sort((left, right) => left.referent_id.localeCompare(right.referent_id));
  if (joins.length !== graphCounts.shared_assertion_neighborhood_nodes) {
    fail('join explorer referent count differs from shared assertion-neighborhood node count');
  }
  const body = {
    schema: C4_JOIN_EXPLORER_SCHEMA,
    projection_id: atlasModel.provenance.projection_id || atlasModel.projection_id
      || atlasModel.provenance.graph_commit_id,
    graph_commit_id: atlasModel.provenance.graph_commit_id,
    identity_head: atlasModel.provenance.identity_head,
    graph_counts_by_plane: graphCounts,
    dispositions: identityJoin.dispositions,
    joined_by_fact_kind: identityJoin.joined_by_fact_kind,
    identity_batch_receipt: identityJoin.batch_receipt,
    rendered_scope: renderedScope(identityJoin, graphCounts, joins),
    joins,
    unresolved_candidates: refusedCandidates(identityJoin),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

export function buildC4JoinReceiptExplorerModel(combinedReceipt) {
  const identityJoin = combinedReceipt?.identity_join || fail('combined receipt lacks identity_join');
  const graphCounts = combinedReceipt.graph_counts_by_plane || fail('combined receipt lacks graph counts');
  const grouped = new Map();
  for (const receipt of identityJoin.join_receipts.filter(row => row.disposition === 'joined')) {
    const held = grouped.get(receipt.selected_referent_id) || [];
    held.push(receipt); grouped.set(receipt.selected_referent_id, held);
  }
  const joins = [...grouped].map(([referentId, receipts]) => {
    const documentaryIds = [...new Set(receipts.flatMap(row => row.documentary_mention_ids))].sort();
    const documentary = documentaryIds.map(mentionId => {
      const witness = receipts.find(row => row.documentary_mention_ids.includes(mentionId));
      return {
        assertion_id: mentionId,
        plane: 'documentary',
        role: 'exact_source_occurrence',
        predicate: 'documentary mention',
        readable: `${witness.basis.declared_identifier} documentary occurrence selected by the identity component`,
        sources: [{ kind: 'document_span', label: 'Documentary identity occurrence',
          detail: mentionId }],
      };
    });
    const code = receipts.map(receipt => ({
      assertion_id: receipt.fact_id,
      plane: 'code',
      role: 'identity_candidate',
      predicate: receipt.fact_kind,
      readable: `${receipt.basis.declared_identifier} emitted by yaml-catalog@1 at ${receipt.source_locator.repository}/${receipt.source_locator.file}:${receipt.source_locator.line}`,
      sources: [{ kind: 'code_record', label: `${receipt.source_locator.repository}/${receipt.source_locator.file}`,
        detail: `line ${receipt.source_locator.line} · ${receipt.fact_id}` }],
    }));
    return {
      referent_id: referentId,
      observed_surfaces: [...new Set(receipts.map(row => row.basis.schema_id))].sort(),
      documentary,
      code,
      receipts: receipts.map(receipt => ({
        receipt_id: receipt.receipt_id,
        fact_id: receipt.fact_id,
        fact_kind: receipt.fact_kind,
        basis: receipt.basis,
        source_locator: receipt.source_locator,
        identity_constraint_ids: receipt.identity_constraint_ids,
        documentary_mention_ids: receipt.documentary_mention_ids,
      })),
    };
  }).sort((left, right) => left.referent_id.localeCompare(right.referent_id));
  if (joins.length !== graphCounts.shared_assertion_neighborhood_nodes
    || joins.some(join => !join.documentary.length || !join.code.length)) {
    fail('combined receipt does not close every shared node to both planes');
  }
  const body = {
    schema: C4_JOIN_EXPLORER_SCHEMA,
    projection_id: combinedReceipt.projection_id || combinedReceipt.graph_commit_id,
    graph_commit_id: combinedReceipt.graph_commit_id || null,
    identity_head: combinedReceipt.identity_head || null,
    graph_counts_by_plane: graphCounts,
    dispositions: identityJoin.dispositions,
    joined_by_fact_kind: identityJoin.joined_by_fact_kind,
    identity_batch_receipt: identityJoin.batch_receipt,
    rendered_scope: renderedScope(identityJoin, graphCounts, joins),
    joins,
    unresolved_candidates: refusedCandidates(identityJoin),
  };
  return Object.freeze({ ...body, digest: sha256(canonical(body)) });
}

const css = `:root{color-scheme:dark;--bg:oklch(.145 .025 254);--panel:oklch(.205 .028 254);--panel-2:oklch(.245 .03 254);--ink:oklch(.94 .012 245);--muted:oklch(.72 .025 245);--line:oklch(.35 .035 254);--doc:oklch(.76 .13 222);--code:oklch(.79 .15 67);--join:oklch(.84 .18 128);--danger:oklch(.72 .16 24);--focus:oklch(.82 .15 286)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "IBM Plex Sans","Segoe UI",sans-serif}button{font:inherit}.topbar{display:flex;justify-content:space-between;gap:2rem;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid var(--line);background:var(--panel)}.topbar strong{font-size:1rem}.topbar span{color:var(--muted)}main{max-width:94rem;margin:auto;padding:2rem 1.5rem 5rem}.summary{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2rem;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}h1{max-width:18ch;margin:0;font-size:2.5rem;line-height:1.06;letter-spacing:-.035em;text-wrap:balance}.lede{max-width:66ch;color:var(--muted)}.counts{display:flex;flex-wrap:wrap;gap:.5rem;align-self:flex-end}.count{padding:.45rem .7rem;border:1px solid var(--line);background:var(--panel)}.count strong{margin-right:.35rem}.legend{display:flex;gap:1.2rem;margin:1.5rem 0;color:var(--muted)}.legend span::before{content:"";display:inline-block;width:.65rem;height:.65rem;margin-right:.4rem;border-radius:50%}.legend .doc::before{background:var(--doc)}.legend .join::before{background:var(--join)}.legend .code::before{background:var(--code)}.join-picker{display:flex;flex-wrap:wrap;gap:.55rem;margin:1rem 0 1.5rem}.join-picker button{padding:.6rem .8rem;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}.join-picker button[aria-pressed="true"]{border-color:var(--join);background:color-mix(in oklch,var(--join) 14%,var(--panel))}.join-picker button:focus-visible,.node:focus-visible{outline:3px solid color-mix(in oklch,var(--focus) 45%,transparent);outline-offset:2px}.graph{display:grid;grid-template-columns:minmax(0,1fr) minmax(16rem,.58fr) minmax(0,1fr);gap:1.25rem;align-items:start}.plane{min-width:0}.plane-title{display:flex;justify-content:space-between;align-items:center;margin:0 0 .7rem;padding-bottom:.55rem;border-bottom:1px solid var(--line)}.plane-title h2{margin:0;font-size:1rem}.documentary .plane-title{color:var(--doc)}.code .plane-title{color:var(--code)}.nodes{display:grid;gap:.65rem}.node{width:100%;padding:.8rem;text-align:left;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}.node:hover{background:var(--panel-2)}.node small{display:block;margin-top:.35rem;color:var(--muted)}.node code,.detail code,.join-core code{font:12px/1.4 "Cascadia Code","SFMono-Regular",monospace;overflow-wrap:anywhere}.documentary .node{box-shadow:inset 3px 0 var(--doc)}.code .node{box-shadow:inset -3px 0 var(--code)}.join-core{position:sticky;top:1rem;padding:1rem;border:1px solid var(--join);background:color-mix(in oklch,var(--join) 10%,var(--panel));text-align:center}.join-core::before,.join-core::after{content:"";position:absolute;top:3rem;width:1.3rem;border-top:2px solid var(--join)}.join-core::before{right:100%}.join-core::after{left:100%}.join-core .pulse{width:.9rem;height:.9rem;margin:0 auto .8rem;border-radius:50%;background:var(--join);box-shadow:0 0 0 .35rem color-mix(in oklch,var(--join) 18%,transparent)}.surfaces{margin:.7rem 0;font-weight:700}.join-core button{margin-top:.5rem;padding:.45rem .65rem;border:1px solid var(--join);background:transparent;color:var(--ink);cursor:pointer}.detail{margin-top:1.5rem;padding:1rem;border:1px solid var(--line);background:var(--panel)}.detail h2{margin-top:0;font-size:1rem}.detail pre{max-height:18rem;overflow:auto;padding:.75rem;background:var(--bg);white-space:pre-wrap;overflow-wrap:anywhere}.source{padding:.65rem 0;border-top:1px solid var(--line)}.source span{display:block;color:var(--muted)}.receipts{margin-top:2.5rem}.receipt{padding:.8rem 0;border-top:1px solid var(--line)}.receipt summary{cursor:pointer;font-weight:700}.unresolved{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--line)}.unresolved table{width:100%;border-collapse:collapse}.unresolved th,.unresolved td{text-align:left;vertical-align:top;padding:.65rem;border-bottom:1px solid var(--line)}.unresolved th{color:var(--muted)}.boundary{color:var(--muted);max-width:75ch}.empty{padding:1rem;color:var(--muted);border:1px dashed var(--line)}@media(max-width:900px){.graph{grid-template-columns:1fr}.join-core{position:relative;order:-1}.join-core::before,.join-core::after{display:none}.code .node{box-shadow:inset 3px 0 var(--code)}}@media(prefers-reduced-motion:no-preference){.node,.join-picker button{transition:background-color 180ms ease-out,border-color 180ms ease-out}.join-core .pulse{animation:pulse 2s ease-out infinite}@keyframes pulse{50%{box-shadow:0 0 0 .7rem color-mix(in oklch,var(--join) 4%,transparent)}}}`;

const js = `(()=>{const data=JSON.parse(document.querySelector('#join-data').textContent);const picker=document.querySelector('#join-picker');const docNodes=document.querySelector('#doc-nodes');const codeNodes=document.querySelector('#code-nodes');const core=document.querySelector('#join-core');const detail=document.querySelector('#detail');const receipts=document.querySelector('#receipts');const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const source=s=>'<div class="source"><strong>'+esc(s.label)+'</strong><span>'+esc(s.detail)+'</span>'+(s.exact_record?'<pre>'+esc(JSON.stringify(s.exact_record,null,2))+'</pre>':'')+'</div>';const showDetail=a=>{detail.hidden=false;detail.innerHTML='<h2>'+esc(a.plane==='code'?'Code-grounded assertion':'Documentary assertion')+'</h2><p>'+esc(a.readable)+'</p><code>'+esc(a.assertion_id)+'</code>'+a.sources.map(source).join('')};const node=a=>{const b=document.createElement('button');b.className='node';b.innerHTML='<strong>'+esc(a.predicate)+'</strong><small>'+esc(a.readable)+'</small><code>'+esc(a.assertion_id)+'</code>';b.onclick=()=>showDetail(a);return b};function render(index){const join=data.joins[index];[...picker.children].forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));docNodes.replaceChildren(...join.documentary.map(node));codeNodes.replaceChildren(...join.code.map(node));core.innerHTML='<div class="pulse"></div><strong>Shared referent</strong><p class="surfaces">'+join.observed_surfaces.map(esc).join('<br>')+'</p><code>'+esc(join.referent_id)+'</code><button type="button">Inspect join receipts</button>';core.querySelector('button').onclick=()=>receipts.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});receipts.innerHTML='<h2>Admissible join receipts</h2>'+join.receipts.map(r=>'<details class="receipt"><summary>'+esc(r.fact_kind)+' · '+esc(r.source_locator.file)+':'+esc(r.source_locator.line)+'</summary><p><code>'+esc(r.receipt_id)+'</code></p><pre>'+esc(JSON.stringify(r.basis,null,2))+'</pre></details>').join('');detail.hidden=true}data.joins.forEach((j,i)=>{const b=document.createElement('button');b.type='button';b.setAttribute('aria-pressed','false');b.textContent=j.observed_surfaces.join(' / ');b.onclick=()=>render(i);picker.append(b)});if(data.joins.length)render(0)})();`;

function html(model) {
  const safeData = JSON.stringify(model).replaceAll('<', '\\u003c');
  const unresolvedRows = model.unresolved_candidates.map(row => `<tr><td><code>${row.fact_id}</code></td><td>${row.source_locator.file}:${row.source_locator.line}</td><td>${row.disposition}: ${row.reason}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Merged estate graph · Join explorer</title><style>${css}</style></head><body><header class="topbar"><strong>Estate graph / join explorer</strong><span>${model.graph_commit_id ? 'Graph commit' : 'Projection'} ${model.graph_commit_id || model.projection_id}</span></header><main><section class="summary"><div><h1>The two planes now meet.</h1><p class="lede">Every highlighted bridge rests on an exact parser-backed schema occurrence. Select a shared referent, then open assertions on either side to navigate its documentary and code-grounded neighborhoods.</p></div><div class="counts"><span class="count"><strong>${model.rendered_scope.full_census_candidates}</strong> full census</span><span class="count"><strong>${model.rendered_scope.evaluated_batch_candidates}</strong> evaluated</span><span class="count"><strong>${model.rendered_scope.not_evaluated_candidates}</strong> pending</span><span class="count"><strong>${model.dispositions.joined}</strong> joined</span><span class="count"><strong>${model.rendered_scope.rendered_refusals}</strong> refused</span></div></section><section class="detail"><h2>Evaluation batch</h2><p class="boundary">${model.identity_batch_receipt.selection_mode} mode · policy ${model.identity_batch_receipt.selection_policy} · cursor ${model.identity_batch_receipt.cursor}→${model.identity_batch_receipt.next_cursor}. Semantic join/refusal rates use only the ${model.rendered_scope.evaluated_batch_candidates} evaluated candidates; ${model.rendered_scope.not_evaluated_candidates} census candidates remain not evaluated.</p><p class="boundary">Rendered scope: ${model.graph_counts_by_plane.scope?.description || 'canonical combined C2/C3 assertion graph'}</p><code>${model.identity_batch_receipt.receipt_id}</code></section><div class="legend"><span class="doc">Documentary plane</span><span class="join">Cross-plane join</span><span class="code">Code plane</span></div><nav id="join-picker" class="join-picker" aria-label="Shared referents"></nav><section class="graph" aria-label="Cross-plane assertion neighborhoods"><div class="plane documentary"><div class="plane-title"><h2>Documentary assertions</h2><span>source spans</span></div><div id="doc-nodes" class="nodes"></div></div><div id="join-core" class="join-core"></div><div class="plane code"><div class="plane-title"><h2>Code-grounded assertions</h2><span>exact records</span></div><div id="code-nodes" class="nodes"></div></div></section><section id="detail" class="detail" hidden></section><section id="receipts" class="receipts"></section><section class="unresolved"><h2>Refused candidates remain visible</h2><p class="boundary">Every non-joined candidate remains visible with its exact terminal disposition and reason. Shared text alone is insufficient.</p><div style="overflow-x:auto"><table><thead><tr><th>Fact</th><th>Source</th><th>Disposition basis</th></tr></thead><tbody>${unresolvedRows}</tbody></table></div></section></main><script id="join-data" type="application/json">${safeData}</script><script>${js}</script></body></html>`;
}

function renderModel(model, outputDir) {
  const target = resolve(outputDir);
  mkdirSync(target, { recursive: true });
  const page = join(target, 'join-explorer.html');
  const receipt = join(target, 'join-explorer-receipt.json');
  writeFileSync(page, html(model));
  writeFileSync(receipt, `${canonical(model)}\n`);
  return Object.freeze({ page, receipt, digest: model.digest, joins: model.joins.length,
    refusals: model.unresolved_candidates.length, rendered_scope: model.rendered_scope });
}

export function renderC4JoinExplorer({ atlas_model: atlasModel, identity_join: identityJoin,
  graph_counts_by_plane: graphCounts, output_dir: outputDir }) {
  return renderModel(buildC4JoinExplorerModel({ atlas_model: atlasModel, identity_join: identityJoin,
    graph_counts_by_plane: graphCounts }), outputDir);
}

export function renderC4JoinReceiptExplorer({ combined_receipt: combinedReceipt, output_dir: outputDir }) {
  return renderModel(buildC4JoinReceiptExplorerModel(combinedReceipt), outputDir);
}
