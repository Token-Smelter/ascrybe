import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepassDocument } from '../tools/source-prepass.mjs';
import { buildReconciliationCandidates, buildJointPackets } from '../tools/context-reconciliation.mjs';
import { buildClaimV32 } from '../tools/claim-v32.mjs';
import { buildRelationLinkPrompt, runRelationLinking } from '../tools/relation-linker.mjs';
import { openCheckpointJournal } from '../tools/checkpoint-journal.mjs';
import { createInferenceBudget } from '../tools/custodied-inference.mjs';

const snapshot={source_sha:'sha',corpus_digest:'digest'};
const content='force_local makes local configuration win over ambient values.\n\nASCRYBE_TEST_OVERRIDE_KEYS is the explicit test exception.\n';
const prepass=prepassDocument({path:'rule.md',content,...snapshot});
const candidate=buildReconciliationCandidates({prepasses:[prepass],query_terms:['force_local','ASCRYBE_TEST_OVERRIDE_KEYS'],query_authorized:true})
  .find(row=>row.signals.some(signal=>signal.kind==='authorized_query'));
const joint=buildJointPackets({candidate,prepasses:[prepass],snapshot});
const packet=joint.packets[0];
const blockFor=term=>packet.catalog.entries.find(entry=>entry.text.includes(term));
const proposal=(surface,term,predicate)=>{
  const block=blockFor(term),quote=block.text;
  return {subject_mention:{surface,source_locator:{block_token:block.token,quote}},predicate_family:predicate,object_or_value:quote,
    polarity:'affirmed',modality:'normative',quantifier:'one',scope:{},valid_time:{},
    support_sets:[{mode:'all_required',locators:[{role:'primary',source_locator:{block_token:block.token,quote}}]}]};
};
const relations=[
  buildClaimV32({proposed:proposal('force_local','force_local','precedence'),window:packet.window,catalog:packet.catalog,model_identifier:'fake/base',prompt_digest:'p'}),
  buildClaimV32({proposed:proposal('ASCRYBE_TEST_OVERRIDE_KEYS','ASCRYBE_TEST_OVERRIDE_KEYS','test_exception'),window:packet.window,catalog:packet.catalog,model_identifier:'fake/base',prompt_digest:'p'}),
];

test('link-only prompt freezes validated relations and requires primary exact support', async t=>{
  const prompt=buildRelationLinkPrompt({candidate,packet,relations});
  assert.match(prompt,/Do NOT regenerate, rewrite, drop, or renumber relations/);
  assert.match(prompt,/ALL source blocks in this packet[\s\S]*role MUST be "primary"/);
  let calls=0;
  const runner={kind:'fake',model:'fake/linker',_rows:[],async complete({tag}){
    calls+=1;
    const first=blockFor('force_local'),second=blockFor('ASCRYBE_TEST_OVERRIDE_KEYS');
    const json={links:[{from_relation:1,to_relation:0,kind:'exception_to',support_locators:[
      {role:'primary',source_locator:{block_token:first.token,quote:first.text}},
      {role:'primary',source_locator:{block_token:second.token,quote:second.text}},
    ]}],reason:'explicit test exception'};
    this._rows.push({tag,model:this.model,outcome:'ok',accepted:true,billing_status:'reported',cost:.01,cost_reported:true,input_tokens:1,output_tokens:1,total_tokens:2});
    return{text:JSON.stringify(json),json,outcome:'ok',accepted:true,billing_status:'reported',usage:{cost:.01,cost_reported:true},model:this.model};
  },stats(){return{kind:'fake',calls:this._rows.length,cost:this._rows.length*.01,cost_status:'complete',unpriced_attempts:0,models:[this.model],per_call:this._rows.slice()}}};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relation-linker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const checkpoint=await openCheckpointJournal({file:path.join(dir,'c.jsonl'),fingerprint:{fixture:'linker'}});
  try{
    const result=await runRelationLinking({candidate,packet,relations,runner,checkpoint,budget:createInferenceBudget({max_calls:1,max_known_cost_usd:1,max_unpriced_attempts:0})});
    assert.equal(calls,1);assert.equal(result.status,'complete');assert.equal(result.links.length,1);assert.equal(result.rejected_links.length,0);
    assert.equal(result.links[0].producer.version,'context-relation-linker@1');
  }finally{await checkpoint.close()}
});
