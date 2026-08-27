import { assertMetricDefinitionCoverage, FIRST_CLASS_DIAGNOSTIC_STATES } from './conservation.mjs';
import { presentationRecordIndex, selectPresentation } from './presentation-records.mjs';

const DIRECTIONS=new Set(['both','upstream','downstream']);
// `entity` is the ER LANDING layer: the domain entities the schema declares, drawn with typed
// cardinality-annotated relationships. It is the ONLY grouping whose nodes are not a partition
// of graph.nodes, and deliberately so — see entityLayerView() below.
// `structure` groups by DERIVED STRUCTURE (file layout); `landing` is the file-substrate
// hybrid: documented domain where canon has one, derived structure everywhere else. They are
// separate axes from `domain` on purpose — see structuralMembership() below.
// `interpretation` is the MODEL-INFERENCE layer: concepts a shape reader proposed over reproducible
// SLICES of the assembled graph. Like `entity` it is not a partition of graph.nodes; unlike every
// other grouping its members are not witnessed at a file:line at all — see interpretationLayerView()
// below for why it is drawn under its own aggregate kind with its own label prefix.
// `event` is the EVENT-FLOW layer: envelope kinds as first-class subjects, drawn with the
// components that produce and consume them on either side. Like `entity` and `interpretation`
// it is not a partition of graph.nodes — see eventFlowView() below for why the tripartite
// producer -> kind -> consumer shape is the point and a single blob is not.
const GROUPINGS=new Set(['none','repository','kind','domain','refusal','structure','landing','entity','interpretation','event']);
const VIEWS=new Set(['auto','graph','matrix']);
const RANKINGS=new Set(['degree','id']);
const MAX_BOUNDS=Object.freeze({aggregateNodes:150,aggregateEdges:400,rawNodes:80,rawEdges:160});

// A diagnostic state is not "surfaced" merely because a node happens to retain the field in
// JSON. It needs a supported SELECTABLE projection. This registry is consumed by the merge-time
// conservation gate; adding a diagnostic state without mapping it here fails every map build.
export const SUPPORTED_DIAGNOSTIC_PROJECTIONS=Object.freeze([
  Object.freeze({
    id:'event-flow',label:'Event flow (producer → kind → consumer)',selectable:GROUPINGS.has('event'),
    recipe:Object.freeze({kind:'whole',grouping:'event',view:'graph'}),
    states:Object.freeze(FIRST_CLASS_DIAGNOSTIC_STATES.filter(state=>state.id.startsWith('envelope.')).map(state=>state.id)),
  }),
  Object.freeze({
    id:'domain-prepass-receipts',label:'Domain prepass receipts',selectable:true,
    recipe:Object.freeze({kind:'whole',grouping:'domain',view:'graph'}),
    states:Object.freeze(FIRST_CLASS_DIAGNOSTIC_STATES.filter(state=>state.id.startsWith('domain_prepass.')).map(state=>state.id)),
  }),
  Object.freeze({
    id:'adjudication-records',label:'Adjudication packet and receipt records',selectable:true,
    recipe:Object.freeze({kind:'whole',grouping:'repository',view:'graph'}),
    states:Object.freeze(FIRST_CLASS_DIAGNOSTIC_STATES.filter(state=>state.id.startsWith('adjudication.')).map(state=>state.id)),
  }),
  Object.freeze({
    id:'cartography-spine',label:'Cartography Spine v0 scope / connectivity / orphan diagnostics',selectable:true,
    recipe:Object.freeze({kind:'whole',grouping:'domain',view:'graph'}),
    states:Object.freeze(FIRST_CLASS_DIAGNOSTIC_STATES.filter(state=>state.id.startsWith('cartography.')).map(state=>state.id)),
  }),
]);

const metric=(path,predicate,knownBlindCases)=>Object.freeze({path,predicate,known_blind_cases:Object.freeze(knownBlindCases)});
export const PROJECTION_METRIC_DEFINITIONS=Object.freeze([
  metric('stats.nodes','count(graph.nodes)', ['synthetic entity and interpretation aggregates are not canonical graph nodes']),
  metric('stats.edges','count(graph.edges)', ['targetless and ambiguous edges are included even when they connect no two canonical nodes']),
  metric('stats.edgeRecords','count(resolved projection edge records after expanding candidate targets)', ['targetless edges have no projection edge record']),
  metric('stats.unresolved','count(graph.unresolved)', ['refusal families stored outside graph.unresolved are excluded']),
  metric('stats.overlays','count(graph.overlays)', ['entity, interpretation, dataflow, refusal, and structural-unclassified families are excluded']),
  metric('stats.refusals','count(graph.refusals)', ['only domain-derivation refusal records use this family']),
  metric('stats.refusedNodes','count(distinct subjects with a standing state=refused domain refusal)', ['superseded and withdrawn refusal history is excluded']),
  metric('stats.structuralGroups','count(distinct structural group labels assigned or explicitly unclassified)', ['nodes with neither structural annotation nor unclassified record are absent']),
  metric('stats.structurallyGrouped','count(distinct subjects with structural annotation or structural-unclassified record)', ['does not imply documented domain membership']),
  metric('stats.structurallyUnclassified','count(graph.structural_unclassified)', ['does not include nodes the structural pass never examined']),
  metric('stats.entityTypes','count(entity-layer records where record_kind=entity_type)', ['entities rejected by the layer are counted under entityRefusals instead']),
  metric('stats.entityRelationships','count(entity-layer records where record_kind=relationship)', ['shape-only relations remain included and must be separated by record status']),
  metric('stats.entityEvidenceNodes','count(distinct canonical graph nodes attached as evidence to promoted entities)', ['one evidence node attached to several entities is counted once']),
  metric('stats.envelopeKindsAttached','count(entity-layer records where record_kind=envelope_attachment)', ['unmappable envelope kinds are entity refusals']),
  metric('stats.entityRefusals','count(entity-layer records where record_kind=refusal)', ['conflicts are counted separately']),
  metric('stats.entityConflicts','count(entity-layer records where record_kind=conflict)', ['only disagreements represented by the entity-layer schema are included']),
  metric('stats.interpretationConcepts','count(interpretation-layer records where record_kind=concept)', ['refused slices and unverifiable documented concepts are excluded']),
  metric('stats.interpretationRelationships','count(interpretation-layer records where record_kind=interpretation_relationship)', ['relationships rejected by apply-time gates are absent']),
  metric('stats.interpretationBindings','count(interpretation-layer records where record_kind=doc_binding)', ['unverifiable documented concepts are counted separately']),
  metric('stats.interpretationUnverifiable','count(interpretation-layer records where record_kind=unverifiable_doc_concept)', ['documents outside configured canon sources were never examined']),
  metric('stats.interpretationRefusals','count(interpretation-layer records where record_kind=refusal)', ['skipped slices that never became proposals are outside this family']),
  metric('stats.interpretationEvidenceNodes','count(distinct canonical graph members across interpretation concepts)', ['one member of several concepts is counted once']),
  metric('stats.eventKinds','count(canonical nodes where kind=envelope_kind)', ['envelope mentions and dynamic sites that mint no kind node are excluded']),
  metric('stats.eventParticipants','count(distinct component names owning at least one resolved emits or consumes edge)', ['components with only unresolved flow facts are excluded']),
  metric('stats.eventEmitSites','count(resolved emits edges targeting an envelope_kind node)', ['multiple facts at one source line are separate edges and therefore separate sites']),
  metric('stats.eventConsumeSites','count(resolved consumes edges targeting an envelope_kind node)', ['wildcard subscriptions fan out and count once per matched kind']),
  metric('stats.eventEmittedNeverConsumed','count(envelope_kind nodes where orphan=emitted_never_consumed)', ['degree is nonzero by definition; degree-zero metrics cannot detect this state']),
  metric('stats.eventConsumedNeverEmitted','count(envelope_kind nodes where orphan=consumed_never_emitted)', ['degree is nonzero by definition; degree-zero metrics cannot detect this state']),
  metric('stats.eventIsolatedKinds','count(envelope_kind nodes where orphan=isolated)', ['a kind absent from all literal flow facts mints no node and cannot enter this count']),
  metric('stats.domainPrepassAssigned','count(graph.domain_prepass_receipts where status=assigned)', ['documented DDD anchors are not prepass receipts']),
  metric('stats.domainPrepassAmbiguous','count(graph.domain_prepass_receipts where status=ambiguous)', ['ambiguous candidates remain undomained']),
  metric('stats.domainPrepassNoAnchor','count(graph.domain_prepass_receipts where status=no_anchor)', ['no-anchor receipts are constrained by the allowed adjacency family']),
  metric('stats.adjudicationRecords','count(graph.adjudication_records)', ['records remain empty during a model-disabled ordinary build']),
]);

const targets=edge=>edge.to?[edge.to]:(edge.candidates||[]);
const selected=(records,subject,field='label')=>selectPresentation(records,subject,field).value;
const strings=value=>[...new Set((Array.isArray(value)?value:[]).filter(item=>typeof item==='string'&&item).map(String))].sort();
const orderedStrings=value=>[...new Set((Array.isArray(value)?value:[]).filter(item=>typeof item==='string'&&item).map(String))];
const integer=(value,fallback,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Math.floor(Number(value)):fallback));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

export function createProjectionRecipe(input={}){
  const raw=Boolean(input.raw),nodeMax=raw?MAX_BOUNDS.rawNodes:MAX_BOUNDS.aggregateNodes,edgeMax=raw?MAX_BOUNDS.rawEdges:MAX_BOUNDS.aggregateEdges;
  return stable({
    version:1,
    kind:input.kind==='path'?'path':input.kind==='whole'?'whole':'neighborhood',
    seeds:orderedStrings(input.seeds),
    includeMembership:Boolean(input.includeMembership),
    hops:integer(input.hops,1,0,3),
    direction:DIRECTIONS.has(input.direction)?input.direction:'both',
    edgeFamilies:strings(input.edgeFamilies),
    statuses:strings(input.statuses),
    grouping:GROUPINGS.has(input.grouping)?input.grouping:'repository',
    stopKinds:strings(input.stopKinds),
    ranking:RANKINGS.has(input.ranking)?input.ranking:'degree',
    bounds:{maxNodes:integer(input.bounds?.maxNodes,80,1,nodeMax),maxEdges:integer(input.bounds?.maxEdges,160,0,edgeMax)},
    view:VIEWS.has(input.view)?input.view:'auto',
    raw,
  });
}

export function serializeProjectionRecipe(recipe){return JSON.stringify(createProjectionRecipe(recipe));}
export function deserializeProjectionRecipe(value){return createProjectionRecipe(typeof value==='string'?JSON.parse(value):value);}
export function recipeToHash(recipe){return`#recipe=${encodeURIComponent(serializeProjectionRecipe(recipe))}`;}
export function recipeFromHash(hash){const match=String(hash||'').match(/(?:^#|[&#])recipe=([^&]+)/);return match?deserializeProjectionRecipe(decodeURIComponent(match[1])):null;}

export function summarizeProjectionRecipe(recipe){
  const value=createProjectionRecipe(recipe),seed=value.seeds.length?`${value.seeds.length} seed${value.seeds.length===1?'':'s'}`:'all evidence',families=value.edgeFamilies.length?value.edgeFamilies.join(', '):'all families',statuses=value.statuses.length?value.statuses.join(', '):'all statuses';
  return`${value.kind==='whole'?'Whole estate':value.kind==='path'?'Witnessed path':'Neighborhood'} · ${seed} · ${value.hops} hop${value.hops===1?'':'s'} ${value.direction} · ${families} · ${statuses} · group ${value.grouping} · rank ${value.ranking} · bound ${value.bounds.maxNodes}/${value.bounds.maxEdges} · ${value.view}`;
}

function groundedMemberships(graph){
  const result=[],byId=new Map((graph.nodes||[]).map(node=>[node.id,node]));
  for(const node of graph.nodes||[]){
    const values=[...(Array.isArray(node.domains)?node.domains:[]),...(typeof node.domain==='string'?[node.domain]:[])];
    for(const domain of strings(values))result.push({nodeId:node.id,domain,attribution:'canonical',witnesses:node.witnesses||[]});
  }
  for(const overlay of graph.overlays||[]){
    const domain=overlay.annotation_kind==='service_card'&&typeof overlay.body?.domain==='string'?overlay.body.domain.trim():'';
    if(!domain||!(overlay.grounded_in||[]).length)continue;
    const subject=overlay.subject,ids=byId.has(subject)?[subject]:(graph.nodes||[]).filter(node=>node.repo===subject).map(node=>node.id);
    for(const nodeId of ids)result.push({nodeId,domain,attribution:`attributed overlay · ${overlay.model||'unknown model'}`,witnesses:overlay.grounded_in||[]});
  }
  const seen=new Set();return result.filter(item=>{const key=`${item.nodeId}\0${item.domain}\0${item.attribution}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.domain.localeCompare(b.domain)||a.nodeId.localeCompare(b.nodeId)||a.attribution.localeCompare(b.attribution));
}

// Standing refusals, indexed by subject. A refused node and a node nobody ever considered
// are DIFFERENT things and the map must be able to show that difference, so the projection
// reads graph.refusals the same way it reads graph.overlays. Only `refused` records group a
// node: a superseded/withdrawn record is history, not a current state of the node.
function refusalMembership(graph){
  const byNode=new Map();
  for(const record of graph.refusals||[]){
    if(record.state!=='refused')continue;
    const reason=typeof record.reason==='string'?record.reason:'';if(!reason)continue;
    const detail=record.reason==='no_applicable_rule_for_node_kind'&&record.reason_detail?`${reason}:${record.reason_detail}`:reason;
    const list=byNode.get(record.subject)||[];list.push({reason:detail,rule:record.rule||'unknown rule',shape:record.evidence?.shape||'unknown'});byNode.set(record.subject,list);
  }
  for(const list of byNode.values())list.sort((a,b)=>a.reason.localeCompare(b.reason)||a.rule.localeCompare(b.rule));
  return byNode;
}

// Derived STRUCTURAL groups, indexed by subject. A structural group is a fact about file
// layout (`client-ui`, `test-suite`); a domain is a documented assertion about the business.
// This function reads a DIFFERENT annotation family from groundedMemberships above and never
// looks at `body.domain`, which is what keeps the two axes from merging: a structurally
// grouped node is still undomained, still refused, and still counted in the undomained queue.
// Nodes no structural rule covered arrive as graph.structural_unclassified records and are
// surfaced under an explicitly-named `unclassified` group carrying their reason, never swept
// into a silent default bucket.
function structuralMembership(graph){
  const byNode=new Map();
  for(const overlay of graph.overlays||[]){
    if(overlay.annotation_kind!=='structural_group')continue;
    const group=typeof overlay.body?.group==='string'?overlay.body.group.trim():'';if(!group)continue;
    if(!(overlay.grounded_in||[]).length)continue;
    byNode.set(overlay.subject,{group,rule:overlay.body?.rule||'unknown rule',basis:overlay.body?.basis||'',classified:true});
  }
  for(const record of graph.structural_unclassified||[]){
    if(byNode.has(record.subject))continue;
    byNode.set(record.subject,{group:'unclassified',rule:record.rule||'unknown rule',basis:record.reason_detail||'',reason:record.reason||'unknown reason',classified:false});
  }
  return byNode;
}
const structureDescriptor=(item,presentation)=>({key:`structure:${item.group}`,label:selected(presentation,`structure:${item.group}`),kind:'structure_aggregate',attribution:item.classified?`derived structure · ${item.rule} · NOT a documented domain`:`unclassified · ${item.reason} · no structural rule applied`});

// THE ENTITY LAYER, read off graph.entity_layer.
//
// WHY THIS IS NOT A PARTITION OF graph.nodes. Every other grouping answers "which bucket does
// this FILE belong to", so its aggregates sum to the node count. The entity layer answers a
// different question — "what is this system ABOUT" — and its subjects are entities the schema
// declares, not files the walker found. Forcing it into a partition would require inventing a
// bucket for the ~2,000 nodes that witness no entity, which is exactly the 1,746-member blob
// the structural layer was built to remove. Instead the ER view draws ONLY the entities, and
// the file substrate stays reachable through every other grouping and through drill-in: an
// entity's members are the modules that witness it, so opening one lands in the evidence.
//
// Membership is keyed on (repo, file) because merge.mjs sets a module node's `name` to its
// repo-relative file path, which is the same string the entity layer's witnesses carry. No id
// slugging is reimplemented here; a mismatch would silently empty every entity.
function entityLayerView(graph){
  const records=graph.entity_layer||[];
  const entities=records.filter(record=>record.record_kind==='entity_type');
  if(!entities.length)return{entities:[],relationships:[],attachments:[],refusals:0,conflicts:0};
  const moduleByFile=new Map(),envelopeById=new Map();
  for(const node of graph.nodes||[]){
    if(node.kind==='module')moduleByFile.set(`${node.repo}\0${node.name}`,node.id);
    else if(node.kind==='envelope_kind')envelopeById.set(node.id,node);
  }
  const attachments=records.filter(record=>record.record_kind==='envelope_attachment');
  const attachedByEntity=new Map();
  for(const record of attachments){const list=attachedByEntity.get(record.entity)||[];list.push(record);attachedByEntity.set(record.entity,list);}
  const view=entities.map(record=>{
    const memberIds=[],witnessFiles=[],repos=[];
    for(const item of record.witnesses||[]){
      const id=moduleByFile.get(`${item.repo}\0${item.file}`);
      if(!id||memberIds.includes(id))continue;
      memberIds.push(id);witnessFiles.push(`${item.repo}/${item.file}:${item.line}`);
      if(!repos.includes(item.repo))repos.push(item.repo);
    }
    const attached=(attachedByEntity.get(record.entity)||[]).filter(item=>envelopeById.has(item.envelope_node));
    for(const item of attached)if(!memberIds.includes(item.envelope_node))memberIds.push(item.envelope_node);
    return{entity:record.entity,label:record.label,rootTable:record.root_table,instanceTable:record.instance_table===true,
      schemaEvidence:record.schema_evidence,corroboration:(record.corroboration||[]).map(item=>item.source),
      envelopeKinds:attached.map(item=>item.envelope_kind).sort(),memberIds,witnessFiles,repos};
  }).sort((a,b)=>a.entity.localeCompare(b.entity));
  return{entities:view,relationships:records.filter(record=>record.record_kind==='relationship'),attachments,
    refusals:records.filter(record=>record.record_kind==='refusal').length,
    conflicts:records.filter(record=>record.record_kind==='conflict').length};
}

// The ER aggregate set. Node size in the view comes from `instanceTable` (does the entity have
// a table of its own?) and its evidence count; edge labels come from the schema's cardinality.
function entityAggregates(entityView,presentation){
  const nodes=entityView.entities.map(item=>({
    id:`entity:${item.entity}`,label:selected(presentation,`entity:${item.entity}`),kind:'entity_aggregate',aggregate:true,raw:false,
    count:item.memberIds.length,counts:{module:item.memberIds.length-item.envelopeKinds.length,envelope_kind:item.envelopeKinds.length},
    memberIds:item.memberIds,repos:item.repos,entity:item.entity,instanceTable:item.instanceTable,
    rootTable:item.rootTable,envelopeKinds:item.envelopeKinds,witnessFiles:item.witnessFiles,
    attribution:`${item.instanceTable?`instance table \`${item.rootTable}\``:'no table of its own · attested by foreign keys'} · corroborated by ${item.corroboration.join(', ')||'nothing'}`,
    whyIncluded:['schema-declared domain entity']}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const drawable=new Set(nodes.map(node=>node.id)),bundled=new Map();
  for(const record of entityView.relationships){
    const source=`entity:${record.from}`,target=`entity:${record.to}`;
    if(!drawable.has(source)||!drawable.has(target))continue;
    const key=`${source}\0${target}\0${record.relation}\0${record.cardinality}`;
    const existing=bundled.get(key)||{id:`edge:${source}:${target}:${record.relation}:${record.cardinality}`,source,target,
      family:selected(presentation,`entity-edge:${record.id}`,'family'),kind:record.relation,relation:record.relation,cardinality:record.cardinality,
      label:selected(presentation,`entity-edge:${record.id}`),count:0,statuses:{},evidenceByStatus:{},
      vias:[],rawIds:[],witnesses:[],whyIncluded:'schema-declared entity relationship'};
    existing.count++;
    const status=record.status||'schema_declared';
    existing.statuses[status]=(existing.statuses[status]||0)+1;
    const evidence=existing.evidenceByStatus[status]||{rawIds:[],witnesses:[]};
    if(evidence.rawIds.length<20)evidence.rawIds.push(record.id);
    if(evidence.witnesses.length<3)evidence.witnesses.push(...(record.witnesses||[]).slice(0,3-evidence.witnesses.length));
    existing.evidenceByStatus[status]=evidence;
    if(existing.vias.length<12&&!existing.vias.includes(record.via))existing.vias.push(record.via);
    if(existing.rawIds.length<20)existing.rawIds.push(record.id);
    if(existing.witnesses.length<3)existing.witnesses.push(...(record.witnesses||[]).slice(0,3-existing.witnesses.length));
    bundled.set(key,existing);
  }
  return{nodes,edges:[...bundled.values()].sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)),
    nodeToGroup:new Map(entityView.entities.flatMap(item=>item.memberIds.map(id=>[id,`entity:${item.entity}`])))};
}

// THE INTERPRETATION LAYER, read off graph.interpretation_layer.
//
// WHY IT IS DRAWN SEPARATELY AND CAN NEVER BE MISTAKEN FOR AN EXTRACTED FACT. Every other
// aggregate in this file groups nodes the walker FOUND, each witnessed at a real {repo,file,line}.
// An interpretation concept is a model's claim ABOUT A SET, evidenced only by a reproducible slice
// witness (the projection spec + the exact members + the graph digest). That is a strictly weaker
// evidentiary class, so the view keeps it strictly separate:
//   * its own aggregate kind `interpretation_aggregate` (render.mjs gives it a dotted rose hexagon
//     and its own legend row, distinct from the amber entity and violet structure families);
//   * an `interpretation · ` label prefix, the same trick that stops `client-ui` reading as a
//     bounded context;
//   * an `attribution` that names the evidence class and says NOT extracted in words;
//   * `evidenceClass` on the node data, so a consumer can filter the two classes apart with one key.
// Members are drilled the same way an entity's are, so opening a concept lands the reader in the
// real witnessed evidence the interpretation was made over.
function interpretationLayerView(graph){
  const records=graph.interpretation_layer||[];
  const byId=new Map((graph.nodes||[]).map(node=>[node.id,node]));
  const bindingsByConcept=new Map();
  for(const record of records.filter(item=>item.record_kind==='doc_binding')){
    const list=bindingsByConcept.get(record.concept)||[];list.push(record);bindingsByConcept.set(record.concept,list);
  }
  const concepts=records.filter(record=>record.record_kind==='concept').map(record=>{
    const memberIds=(record.slice_witness?.members||[]).filter(id=>byId.has(id));
    const repos=strings(memberIds.map(id=>byId.get(id)?.repo));
    const bindings=(bindingsByConcept.get(record.id)||[]).map(item=>({documented:item.documented_concept,source:item.doc_source,witness:`${item.doc_witness.repo}/${item.doc_witness.file}:${item.doc_witness.line}`}));
    return{id:record.id,concept:record.concept,label:record.label||record.concept,coheresBecause:record.coheres_because,
      confidence:record.confidence,enumerator:record.slice_witness?.enumerator||'unknown',sliceId:record.slice_witness?.slice_id||'unknown',
      specHash:record.slice_witness?.spec_hash||'',graphDigest:record.slice_witness?.graph_digest||'',
      shapeEvidence:(record.shape_evidence||[]).map(item=>`${item.kind}: ${item.statement}`),bindings,memberIds,repos,model:record.model};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  return{concepts,relationships:records.filter(record=>record.record_kind==='interpretation_relationship'),
    bindings:records.filter(record=>record.record_kind==='doc_binding'),
    unverifiable:records.filter(record=>record.record_kind==='unverifiable_doc_concept'),
    refusals:records.filter(record=>record.record_kind==='refusal')};
}

function interpretationAggregates(view,presentation){
  const nodes=view.concepts.map(item=>({
    id:item.id,label:selected(presentation,item.id),kind:'interpretation_aggregate',aggregate:true,raw:false,
    count:item.memberIds.length,counts:{member:item.memberIds.length},memberIds:item.memberIds,repos:item.repos,
    concept:item.concept,coheresBecause:item.coheresBecause,confidence:item.confidence,enumerator:item.enumerator,
    sliceId:item.sliceId,specHash:item.specHash,graphDigest:item.graphDigest,shapeEvidence:item.shapeEvidence,
    bindings:item.bindings,evidenceClass:'reproducible_slice_witness',
    attribution:`model interpretation · ${item.model} · reproducible slice witness (${item.enumerator}, ${item.memberIds.length} member(s)) · NOT extracted, NOT witnessed at a file:line`,
    whyIncluded:['model interpretation over a reproducible graph slice']})).sort((a,b)=>a.id.localeCompare(b.id));
  const drawable=new Set(nodes.map(node=>node.id)),bundled=new Map();
  for(const record of view.relationships){
    if(!drawable.has(record.from)||!drawable.has(record.to))continue;
    const key=`${record.from}\0${record.to}\0${record.relation}`;
    const existing=bundled.get(key)||{id:`edge:${record.from}:${record.to}:${record.relation}`,source:record.from,target:record.to,
      family:selected(presentation,`interpretation-edge:${record.id}`,'family'),kind:record.relation,relation:record.relation,label:selected(presentation,`interpretation-edge:${record.id}`),
      count:0,statuses:{},evidenceByStatus:{},rawIds:[],witnesses:[],statements:[],
      whyIncluded:'model interpretation over two reproducible graph slices'};
    existing.count++;existing.statuses.interpretation=(existing.statuses.interpretation||0)+1;
    if(existing.rawIds.length<20)existing.rawIds.push(record.id);
    if(existing.statements.length<5)existing.statements.push(record.statement);
    bundled.set(key,existing);
  }
  return{nodes,edges:[...bundled.values()].sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)),
    nodeToGroup:new Map(view.concepts.flatMap(item=>item.memberIds.map(id=>[id,item.id])))};
}

// THE EVENT-FLOW LAYER, read off the graph's REAL `emits` / `consumes` edges.
//
// WHY THIS EXISTS. The extractors already resolve the envelope bus completely: on this estate
// 232 `envelope_kind` nodes carry 761 `emits` and 1,001 `consumes` edges and NOT ONE kind node
// is isolated. The failure was never extraction — it was that no VIEW made producer -> kind ->
// consumer navigable. Every other grouping either hides the kinds inside a file bucket
// (`repository`, `landing`, `structure`), collapses them into one label (`kind`), or attaches
// them to something else entirely (`entity`). A reader asking "who emits work_order.reported,
// and who is listening?" had to read the raw edge list.
//
// WHY IT IS TRIPARTITE AND NOT A BLOB. Both `emits` and `consumes` point AT the kind, so
// drawing them as they are stored makes the kind a sink and loses direction entirely. The
// consume edge is therefore drawn REVERSED here — kind -> consumer — so the flow reads left to
// right and one glance separates "who sends this" from "who receives it". Nothing about the
// canonical edge changes: the reversal is a VIEW fact, the bundled edge keeps the canonical
// edge ids and witnesses, and `direction` says which way the stored edge really points.
//
// WHY THE PARTICIPANT IS THE COMPONENT. A site is a module (or the component itself, for a
// plugin manifest). 232 kinds against 1,682 module nodes is a hairball nobody can read, so the
// drawn participant is the component and the SITES ARE ITS MEMBERS — opening one drills
// straight into the witnessed module nodes through the same machinery every other aggregate
// uses. Nothing is summarised away: every site id is carried on the participant.
//
// WHY ASYMMETRIES ARE FIRST-CLASS. `merge.mjs` already stamps `orphan:
// 'emitted_never_consumed' | 'consumed_never_emitted' | 'isolated'` on the kind node. That
// stamp IS the defect class this layer exists to find — a kind everybody sends and nobody
// reads, or one a subscriber waits on that nothing in the estate ever sends — so it is carried
// onto the drawn node, counted in the view's own stats, and given its own node kind
// (`event_asymmetry_aggregate`) so the renderer can style it apart from a healthy kind.
function eventFlowView(graph){
  const byId=new Map((graph.nodes||[]).map(node=>[node.id,node]));
  const kindNodes=(graph.nodes||[]).filter(node=>node.kind==='envelope_kind').sort((a,b)=>a.id.localeCompare(b.id));
  const empty={kinds:[],participants:[],flows:[],stats:{kinds:0,participants:0,emitSites:0,consumeSites:0,emittedNeverConsumed:0,consumedNeverEmitted:0,isolatedKinds:0}};
  if(!kindNodes.length)return empty;
  const kindIds=new Set(kindNodes.map(node=>node.id));
  const participants=new Map();
  const bundles=new Map();
  let emitSites=0,consumeSites=0;
  for(const edge of graph.edges||[]){
    if(edge.kind!=='emits'&&edge.kind!=='consumes')continue;
    if(!edge.to||!kindIds.has(edge.to))continue;
    const site=byId.get(edge.from);if(!site)continue;
    const repo=site.repo||'unknown component',participantId=`event_participant:${repo}`;
    const participant=participants.get(participantId)||{id:participantId,repo,siteIds:new Set(),emitSites:0,consumeSites:0,kindsEmitted:new Set(),kindsConsumed:new Set()};
    participant.siteIds.add(site.id);
    if(edge.kind==='emits'){participant.emitSites++;participant.kindsEmitted.add(edge.to);emitSites++;}
    else{participant.consumeSites++;participant.kindsConsumed.add(edge.to);consumeSites++;}
    participants.set(participantId,participant);
    // The bundle key keeps direction, so a component that BOTH emits and consumes the same
    // kind draws two edges rather than one ambiguous line — which is exactly the shape a
    // relay/adapter has, and collapsing it would hide that.
    const key=`${participantId}\0${edge.to}\0${edge.kind}`;
    const existing=bundles.get(key)||{key,participantId,kindId:edge.to,direction:edge.kind,count:0,rawIds:[],witnesses:[],statuses:{},idioms:new Set(),provenanceClasses:new Set(),wildcard:0};
    existing.count++;
    existing.statuses[edge.status||'resolved']=(existing.statuses[edge.status||'resolved']||0)+1;
    if(edge.idiom)existing.idioms.add(edge.idiom);
    if(edge.provenance_class)existing.provenanceClasses.add(edge.provenance_class);
    if(edge.resolution_kind==='wildcard_subscription')existing.wildcard++;
    if(existing.rawIds.length<20)existing.rawIds.push(edge.id);
    if(existing.witnesses.length<3)existing.witnesses.push(...(edge.witnesses||[]).slice(0,3-existing.witnesses.length));
    bundles.set(key,existing);
  }
  const kinds=kindNodes.map(node=>{
    const producers=[...participants.values()].filter(item=>item.kindsEmitted.has(node.id)).map(item=>item.repo).sort();
    const consumers=[...participants.values()].filter(item=>item.kindsConsumed.has(node.id)).map(item=>item.repo).sort();
    return{id:node.id,name:node.name,orphan:node.orphan||null,producers,consumers,
      emitSiteCount:node.emit_site_count??0,consumeSiteCount:node.consume_site_count??0,
      declaredPublisher:Boolean(node.declared_publisher),declaredSubscriber:Boolean(node.declared_subscriber),
      primaryWitnessClass:node.primary_witness_class||null,
      witnessFiles:(node.witnesses||[]).slice(0,20).map(item=>`${item.repo?`${item.repo}/`:''}${item.file}:${item.line}`),
      memberIds:[...new Set((graph.edges||[]).filter(edge=>(edge.kind==='emits'||edge.kind==='consumes')&&edge.to===node.id&&byId.has(edge.from)).map(edge=>edge.from))].sort()};
  });
  return{kinds,
    participants:[...participants.values()].map(item=>({id:item.id,repo:item.repo,memberIds:[...item.siteIds].sort(),
      emitSites:item.emitSites,consumeSites:item.consumeSites,kindsEmitted:item.kindsEmitted.size,kindsConsumed:item.kindsConsumed.size})).sort((a,b)=>a.id.localeCompare(b.id)),
    // Sets are converted here, not at the draw site: the index is embedded in the rendered
    // artifact as JSON and a Set serialises to `{}`, which would silently empty every idiom
    // and provenance list in the shipped HTML.
    flows:[...bundles.values()].map(item=>({...item,presentationSubject:`event-flow:${item.rawIds[0]}`,idioms:[...item.idioms].sort(),provenanceClasses:[...item.provenanceClasses].sort()})).sort((a,b)=>a.key.localeCompare(b.key)),
    stats:{kinds:kinds.length,participants:participants.size,emitSites,consumeSites,
      emittedNeverConsumed:kinds.filter(item=>item.orphan==='emitted_never_consumed').length,
      consumedNeverEmitted:kinds.filter(item=>item.orphan==='consumed_never_emitted').length,
      isolatedKinds:kinds.filter(item=>item.orphan==='isolated').length}};
}

// The event-flow aggregate set. Node size comes from participation counts; the ASYMMETRY is
// carried three ways so it survives greyscale and a screenshot: a separate aggregate kind, an
// `orphan` field on the node data, and an attribution that names the asymmetry in words.
function eventFlowAggregates(view,presentation){
  const kindNodes=view.kinds.map(item=>({
    id:item.id,label:selected(presentation,`event:${item.id}`),kind:item.orphan?'event_asymmetry_aggregate':'event_kind_aggregate',aggregate:true,raw:false,...(item.orphan?{priority:true}:{}),
    count:item.memberIds.length,counts:{producer:item.producers.length,consumer:item.consumers.length,emit_site:item.emitSiteCount,consume_site:item.consumeSiteCount},
    memberIds:item.memberIds,repos:[...new Set([...item.producers,...item.consumers])].sort(),
    envelopeKind:item.name,orphan:item.orphan,producers:item.producers,consumers:item.consumers,
    declaredPublisher:item.declaredPublisher,declaredSubscriber:item.declaredSubscriber,
    witnessFiles:item.witnessFiles,evidenceClass:'extracted',
    attribution:item.orphan==='emitted_never_consumed'?`ASYMMETRY · emitted by ${item.producers.join(', ')||'nothing'} · NO consumer anywhere in the estate`
      :item.orphan==='consumed_never_emitted'?`ASYMMETRY · consumed by ${item.consumers.join(', ')||'nothing'} · NO emitter anywhere in the estate`
      :item.orphan==='isolated'?'ASYMMETRY · named on the bus but neither emitted nor consumed at any witnessed site'
      :`${item.emitSiteCount} emit site(s) · ${item.consumeSiteCount} consume site(s)`,
    whyIncluded:['envelope kind on the estate bus']})).sort((a,b)=>a.id.localeCompare(b.id));
  const participantNodes=view.participants.map(item=>({
    id:item.id,label:selected(presentation,item.id),kind:'event_participant_aggregate',aggregate:true,raw:false,
    count:item.memberIds.length,counts:{emit_site:item.emitSites,consume_site:item.consumeSites},
    memberIds:item.memberIds,repos:[item.repo],repo:item.repo,evidenceClass:'extracted',
    attribution:`emits ${item.kindsEmitted} kind(s) at ${item.emitSites} site(s) · consumes ${item.kindsConsumed} kind(s) at ${item.consumeSites} site(s)`,
    whyIncluded:['component with a witnessed site on the envelope bus']})).sort((a,b)=>a.id.localeCompare(b.id));
  const drawable=new Set([...kindNodes,...participantNodes].map(node=>node.id));
  const edges=view.flows.filter(flow=>drawable.has(flow.participantId)&&drawable.has(flow.kindId)).map(flow=>{
    // PRODUCER -> KIND -> CONSUMER. `consumes` is stored consumer -> kind; drawing it that way
    // makes both arrows converge on the kind and the direction stops meaning anything.
    const source=flow.direction==='emits'?flow.participantId:flow.kindId;
    const target=flow.direction==='emits'?flow.kindId:flow.participantId;
    return{id:`edge:${source}:${target}:${flow.direction}`,source,target,family:selected(presentation,flow.presentationSubject,'family'),kind:flow.direction,
      direction:flow.direction,label:flow.direction==='emits'?'emits':'consumes',
      canonicalDirection:flow.direction==='emits'?'site -> kind':'site -> kind (drawn reversed so the flow reads producer -> kind -> consumer)',
      count:flow.count,statuses:flow.statuses,evidenceByStatus:{[Object.keys(flow.statuses)[0]||'resolved']:{rawIds:flow.rawIds,witnesses:flow.witnesses}},
      rawIds:flow.rawIds,witnesses:flow.witnesses,idioms:flow.idioms,
      wildcardSubscriptions:flow.wildcard,provenanceClasses:flow.provenanceClasses,
      whyIncluded:'witnessed envelope-bus traffic'};
  }).sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id));
  return{nodes:[...participantNodes,...kindNodes],edges,
    nodeToGroup:new Map([...view.kinds.flatMap(item=>item.memberIds.map(id=>[id,item.id])),...view.participants.flatMap(item=>item.memberIds.map(id=>[id,item.id]))])};
}

function descriptor(node,grouping,membershipByNode,refusalByNode,structuralByNode,presentation){
  if(grouping==='none')return{key:node.id,label:selected(presentation,`node:${node.id}`),kind:node.kind||'evidence',attribution:'canonical'};
  if(grouping==='kind'){const key=`kind:${node.kind||'evidence'}`;return{key,label:selected(presentation,key),kind:'kind_aggregate',attribution:'canonical'};}
  if(grouping==='refusal'){
    const refusal=refusalByNode?.get(node.id)?.[0],key=refusal?`refusal:${refusal.reason}`:'refusal:__none__';
    return{key,label:selected(presentation,key),kind:'refusal_aggregate',attribution:refusal?`refused by ${refusal.rule} · ${refusal.shape} evidence`:'no refusal record for this node'};
  }
  if(grouping==='structure'){
    const item=structuralByNode?.get(node.id),key=item?`structure:${item.group}`:'structure:__none__';
    return item?structureDescriptor(item,presentation):{key,label:selected(presentation,key),kind:'structure_aggregate',attribution:'no structural annotation for this node'};
  }
  if(grouping==='domain'||grouping==='landing'){
    const membership=membershipByNode.get(node.id)?.[0];
    if(membership){const key=`domain:${membership.domain}`;return{key,label:selected(presentation,key),kind:'domain_aggregate',attribution:membership.attribution};}
    if(grouping==='landing'){const item=structuralByNode?.get(node.id);if(item)return structureDescriptor(item,presentation);}
    const key='domain:__undocumented__';return{key,label:selected(presentation,key),kind:'domain_aggregate',attribution:'no grounded domain membership'};
  }
  const key=`repo:${node.repo||'unknown repository'}`;return{key,label:selected(presentation,key),kind:'repo_aggregate',attribution:'canonical'};
}

function aggregateRecords(nodes,edgeRecords,grouping,memberships,refusalByNode,structuralByNode,entityView,interpretationView,eventView,presentation){
  if(grouping==='entity')return entityAggregates(entityView||{entities:[],relationships:[]},presentation);
  if(grouping==='interpretation')return interpretationAggregates(interpretationView||{concepts:[],relationships:[]},presentation);
  if(grouping==='event')return eventFlowAggregates(eventView||{kinds:[],participants:[],flows:[]},presentation);
  const membershipByNode=new Map();for(const item of memberships){const list=membershipByNode.get(item.nodeId)||[];list.push(item);membershipByNode.set(item.nodeId,list);}
  const groups=new Map(),nodeToGroup=new Map();
  for(const node of nodes){const item=descriptor(node,grouping,membershipByNode,refusalByNode,structuralByNode,presentation),existing=groups.get(item.key)||{id:item.key,label:item.label,kind:item.kind,aggregate:true,raw:false,count:0,counts:{},memberIds:[],repos:[],attribution:item.attribution,whyIncluded:[]};existing.count++;existing.counts[node.kind||'evidence']=(existing.counts[node.kind||'evidence']||0)+1;if(existing.memberIds.length<2000)existing.memberIds.push(node.id);existing.repos=strings([...existing.repos,node.repo,...(node.repos||[])]);nodeToGroup.set(node.id,item.key);groups.set(item.key,existing);}
  const bundled=new Map();
  for(const record of edgeRecords){const source=nodeToGroup.get(record.source),target=nodeToGroup.get(record.target);if(!source||!target)continue;const family=record.family,key=`${source}\0${target}\0${family}`,existing=bundled.get(key)||{id:`edge:${source}:${target}:${family}`,source,target,family,kind:family,count:0,statuses:{},evidenceByStatus:{},rawIds:[],witnesses:[],whyIncluded:'bundled canonical relationships'};const recordCount=record.count||record.parallel_count||1;existing.count+=recordCount;const status=record.status||'resolved';existing.statuses[status]=(existing.statuses[status]||0)+recordCount;const evidence=existing.evidenceByStatus[status]||{rawIds:[],witnesses:[]},rawId=record.canonicalId||record.id;if(evidence.rawIds.length<20&&!evidence.rawIds.includes(rawId))evidence.rawIds.push(rawId);if(evidence.witnesses.length<3)evidence.witnesses.push(...(record.witnesses||[]).slice(0,3-evidence.witnesses.length));existing.evidenceByStatus[status]=evidence;if(existing.rawIds.length<20&&!existing.rawIds.includes(rawId))existing.rawIds.push(rawId);if(existing.witnesses.length<3)existing.witnesses.push(...(record.witnesses||[]).slice(0,3-existing.witnesses.length));bundled.set(key,existing);}
  return{nodes:[...groups.values()].sort((a,b)=>a.id.localeCompare(b.id)),edges:[...bundled.values()].sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)),nodeToGroup};
}

function rawEdgeRecords(graph,presentation){
  const byId=new Map((graph.nodes||[]).map(node=>[node.id,node])),expanded=[];
  for(const [edgeIndex,edge] of (graph.edges||[]).entries()){const canonicalId=edge.id||`edge:${edgeIndex}`;for(const [targetIndex,target] of targets(edge).entries())if(byId.has(edge.from)&&byId.has(target))expanded.push({...edge,canonicalId,source:edge.from,target,family:selected(presentation,`edge:${canonicalId}`,'family'),count:edge.parallel_count||1,whyIncluded:'canonical witnessed relationship',edgeIndex,targetIndex});}
  expanded.sort((a,b)=>a.canonicalId.localeCompare(b.canonicalId)||a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||String(a.kind||'').localeCompare(String(b.kind||''))||String(a.status||'').localeCompare(String(b.status||''))||a.targetIndex-b.targetIndex||a.edgeIndex-b.edgeIndex);
  const occurrences=new Map();return expanded.map(({edgeIndex,targetIndex,...record})=>{const ordinal=(occurrences.get(record.canonicalId)||0)+1;occurrences.set(record.canonicalId,ordinal);return{...record,id:`projection:${encodeURIComponent(record.canonicalId)}:${ordinal}`};});
}

export function buildCompactProjectionIndex(graph){
  const presentation=presentationRecordIndex(graph),nodes=(graph.nodes||[]).slice().sort((a,b)=>a.id.localeCompare(b.id)),edges=rawEdgeRecords(graph,presentation),memberships=groundedMemberships(graph),refusalByNode=refusalMembership(graph),structuralByNode=structuralMembership(graph),entityView=entityLayerView(graph),interpretationView=interpretationLayerView(graph),eventView=eventFlowView(graph),aggregates={};
  for(const grouping of ['repository','kind','domain','refusal','structure','landing','entity','interpretation','event']){const value=aggregateRecords(nodes,edges,grouping,memberships,refusalByNode,structuralByNode,entityView,interpretationView,eventView,presentation);aggregates[grouping]={nodes:value.nodes,edges:value.edges};}
  const refusalCounts=new Map();for(const list of refusalByNode.values())for(const item of list)refusalCounts.set(item.reason,(refusalCounts.get(item.reason)||0)+1);
  const structuralCounts=new Map();for(const item of structuralByNode.values())structuralCounts.set(item.group,(structuralCounts.get(item.group)||0)+1);
  // Interpretation counts live under their OWN keys. Nothing above them changes when the layer is
  // merged, which is the census-separability half of the honesty contract.
  const prepassReceipts=graph.domain_prepass_receipts||[];
  const adjudicationRecords=graph.adjudication_records||[];
  const result={version:1,stats:{nodes:nodes.length,edges:(graph.edges||[]).length,edgeRecords:edges.length,unresolved:(graph.unresolved||[]).length,overlays:(graph.overlays||[]).length,refusals:(graph.refusals||[]).length,refusedNodes:refusalByNode.size,structuralGroups:structuralCounts.size,structurallyGrouped:structuralByNode.size,structurallyUnclassified:(graph.structural_unclassified||[]).length,entityTypes:entityView.entities.length,entityRelationships:entityView.relationships.length,entityEvidenceNodes:new Set(entityView.entities.flatMap(item=>item.memberIds)).size,envelopeKindsAttached:entityView.attachments.length,entityRefusals:entityView.refusals,entityConflicts:entityView.conflicts,interpretationConcepts:interpretationView.concepts.length,interpretationRelationships:interpretationView.relationships.length,interpretationBindings:interpretationView.bindings.length,interpretationUnverifiable:interpretationView.unverifiable.length,interpretationRefusals:interpretationView.refusals.length,interpretationEvidenceNodes:new Set(interpretationView.concepts.flatMap(item=>item.memberIds)).size,
    // Event-flow counts live under their OWN keys, and the two ASYMMETRY counts are separate
    // numbers rather than one "orphans" total: emitted-never-consumed and consumed-never-emitted
    // are opposite defects with opposite repairs and summing them hides which one you have.
    eventKinds:eventView.stats.kinds,eventParticipants:eventView.stats.participants,eventEmitSites:eventView.stats.emitSites,eventConsumeSites:eventView.stats.consumeSites,
    eventEmittedNeverConsumed:eventView.stats.emittedNeverConsumed,eventConsumedNeverEmitted:eventView.stats.consumedNeverEmitted,eventIsolatedKinds:eventView.stats.isolatedKinds,
    domainPrepassAssigned:prepassReceipts.filter(record=>record.status==='assigned').length,domainPrepassAmbiguous:prepassReceipts.filter(record=>record.status==='ambiguous').length,domainPrepassNoAnchor:prepassReceipts.filter(record=>record.status==='no_anchor').length,adjudicationRecords:adjudicationRecords.length},domainPrepassReceipts:prepassReceipts,adjudicationRecords,entityView,interpretationView,eventView,memberships,refusalsByReason:[...refusalCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([reason,count])=>({reason,count})),structuralByGroup:[...structuralCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([group,count])=>({group,count})),aggregates,metric_definitions:PROJECTION_METRIC_DEFINITIONS};
  assertMetricDefinitionCoverage(result,PROJECTION_METRIC_DEFINITIONS,{roots:['stats']});
  return result;
}

function allowed(record,recipe){return(!recipe.edgeFamilies.length||recipe.edgeFamilies.includes(record.family))&&(!recipe.statuses.length||recipe.statuses.includes(record.status||'resolved'));}
function traversal(records,recipe,seeds,byId){
  const incident=new Map();for(const record of records){for(const [id,step] of [[record.source,'downstream'],[record.target,'upstream']]){const list=incident.get(id)||[];list.push({record,next:step==='downstream'?record.target:record.source,step});incident.set(id,list);}}
  for(const list of incident.values())list.sort((a,b)=>a.record.id.localeCompare(b.record.id)||a.next.localeCompare(b.next));
  const included=new Map(),queue=[];for(const id of seeds)if(byId.has(id)){included.set(id,{depth:0,reason:'seed',path:[id]});queue.push(id);}
  while(queue.length){const current=queue.shift(),info=included.get(current),node=byId.get(current);if(info.depth>=recipe.hops||recipe.stopKinds.includes(node?.kind))continue;for(const step of incident.get(current)||[]){if(!allowed(step.record,recipe))continue;if(recipe.direction!=='both'&&recipe.direction!==step.step)continue;if(included.has(step.next))continue;included.set(step.next,{depth:info.depth+1,reason:`${info.depth+1}-hop ${step.step} via ${step.record.kind}`,path:[...info.path,step.next],via:step.record.id});queue.push(step.next);}
  }
  return included;
}

function shortestPath(records,recipe,start,end,byId){
  if(!byId.has(start)||!byId.has(end))return null;const seen=new Set([start]),queue=[{id:start,nodes:[start],edges:[]}];
  while(queue.length){const item=queue.shift();if(item.edges.length>=Math.max(1,recipe.hops))continue;const choices=[];for(const record of records){if(!allowed(record,recipe))continue;if((recipe.direction==='both'||recipe.direction==='downstream')&&record.source===item.id)choices.push({record,next:record.target});if((recipe.direction==='both'||recipe.direction==='upstream')&&record.target===item.id)choices.push({record,next:record.source});}choices.sort((a,b)=>a.record.id.localeCompare(b.record.id)||a.next.localeCompare(b.next));for(const choice of choices){if(choice.next===end)return{nodes:[...item.nodes,end],edges:[...item.edges,choice.record]};if(!seen.has(choice.next)){seen.add(choice.next);queue.push({id:choice.next,nodes:[...item.nodes,choice.next],edges:[...item.edges,choice.record]});}}}
  return null;
}

function chooseView(recipe,nodeCount,edgeCount){if(recipe.view!=='auto')return recipe.view;const possible=Math.max(1,nodeCount*(nodeCount-1)),density=edgeCount/possible;return nodeCount>=8&&(density>=.18||edgeCount>nodeCount*2)?'matrix':'graph';}
function matrixFor(nodes,edges){const ids=nodes.map(node=>node.id),byPair=new Map();for(const edge of edges){const key=`${edge.source}\0${edge.target}`,cell=byPair.get(key)||{source:edge.source,target:edge.target,count:0,families:{},statuses:{},rawIds:[],witnesses:[]};cell.count+=edge.count||1;cell.families[edge.family]=(cell.families[edge.family]||0)+(edge.count||1);for(const [status,count] of Object.entries(edge.statuses||{[edge.status||'resolved']:edge.count||1}))cell.statuses[status]=(cell.statuses[status]||0)+count;for(const id of edge.rawIds||[edge.canonicalId||edge.id])if(id&&cell.rawIds.length<20&&!cell.rawIds.includes(id))cell.rawIds.push(id);if(cell.witnesses.length<3)cell.witnesses.push(...(edge.witnesses||[]).slice(0,3-cell.witnesses.length));byPair.set(key,cell);}const cells=[...byPair.values()].sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target));return{ids,cells,totalCells:ids.length*ids.length,nonzeroCells:cells.length};}
function filteredAggregateEdges(edges,recipe){return edges.flatMap(edge=>{if(recipe.edgeFamilies.length&&!recipe.edgeFamilies.includes(edge.family))return[];if(!recipe.statuses.length)return[edge];const statuses=Object.fromEntries(Object.entries(edge.statuses||{}).filter(([status])=>recipe.statuses.includes(status))),count=Object.values(statuses).reduce((sum,value)=>sum+value,0);if(!count)return[];const selectedEvidence=recipe.statuses.flatMap(status=>edge.evidenceByStatus?.[status]?[edge.evidenceByStatus[status]]:[]),rawIds=[...new Set(selectedEvidence.flatMap(item=>item.rawIds||[]))].slice(0,20),witnesses=selectedEvidence.flatMap(item=>item.witnesses||[]).slice(0,3),evidenceByStatus=Object.fromEntries(Object.entries(edge.evidenceByStatus||{}).filter(([status])=>recipe.statuses.includes(status)));return[{...edge,count,statuses,evidenceByStatus,rawIds,witnesses}];});}
function boundProjection(nodes,edges,recipe){
  const degree=new Map(nodes.map(node=>[node.id,0])),byId=new Map(nodes.map(node=>[node.id,node]));for(const edge of edges){degree.set(edge.source,(degree.get(edge.source)||0)+(edge.count||1));degree.set(edge.target,(degree.get(edge.target)||0)+(edge.count||1));}
  const ranked=nodes.slice().sort(recipe.ranking==='id'?(a,b)=>a.id.localeCompare(b.id):(a,b)=>(degree.get(b.id)||0)-(degree.get(a.id)||0)||a.id.localeCompare(b.id)),rankedEdges=edges.slice().sort((a,b)=>(b.count||1)-(a.count||1)||a.id.localeCompare(b.id)),ids=new Set();
  const add=id=>{if(byId.has(id)&&ids.size<recipe.bounds.maxNodes)ids.add(id);};
  // Expansion must stay visible. A many-seeded hop traversal (every member of an opened
  // aggregate, say) can fill the whole node budget with seeds, so the frontier the hops
  // reached would never be drawn. Reserve a deterministic slice of the budget for non-seed
  // nodes whenever hops>0 and more than one seed is present; single-seed and zero-hop
  // recipes keep the seeds-first behaviour exactly.
  const seedSet=new Set(recipe.seeds.filter(id=>byId.has(id))),frontierReserve=recipe.hops>0&&seedSet.size>1?Math.floor(recipe.bounds.maxNodes/4):0,seedCap=Math.max(1,recipe.bounds.maxNodes-frontierReserve);
  for(const id of recipe.seeds){if(ids.size>=seedCap)break;add(id);}
  if(frontierReserve){let taken=0;for(const node of ranked){if(taken>=frontierReserve||ids.size>=recipe.bounds.maxNodes)break;if(seedSet.has(node.id)||ids.has(node.id))continue;const before=ids.size;add(node.id);if(ids.size>before)taken++;}}
  // PRIORITY NODES, ON A RESERVE — never on the whole budget.
  //
  // A view whose PURPOSE is to surface a defect class must not let a generic degree ranking
  // evict that class: an emitted-never-consumed envelope kind has degree 1 BY DEFINITION —
  // that is what makes it the defect — so it sorts last precisely because it is the thing
  // worth seeing, and on the real estate 75 of them fell outside the node bound while
  // high-traffic healthy kinds filled it.
  //
  // The reserve is HALF the node budget, and the cap is the whole point. An unbounded priority
  // pass is worse than none: this estate carries 81 asymmetric kinds against an 80-node bound,
  // so admitting them all drew a canvas of 80 defect diamonds with NO producer and NO consumer
  // beside them — the tripartite view collapsed into exactly the blob it exists to replace.
  // Half the budget guarantees the defect class is represented AND that the components and
  // healthy kinds it must be read against are still on screen; the remainder is reported
  // through `omitted`, never silently dropped.
  const priorityReserve=Math.floor(recipe.bounds.maxNodes/2);
  let priorityTaken=0;
  for(const node of ranked){
    if(priorityTaken>=priorityReserve||ids.size>=recipe.bounds.maxNodes)break;
    if(!node.priority||ids.has(node.id))continue;
    const before=ids.size;add(node.id);if(ids.size>before)priorityTaken++;
  }
  if(nodes.length<=recipe.bounds.maxNodes)for(const node of ranked)add(node);else for(const edge of rankedEdges){const needed=[edge.source,edge.target].filter(id=>!ids.has(id));if(ids.size+needed.length<=recipe.bounds.maxNodes)needed.forEach(add);if(ids.size>=recipe.bounds.maxNodes)break;}for(const node of ranked)add(node.id);
  const shownNodes=[...ids].map(id=>byId.get(id)),eligibleEdges=rankedEdges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)),shownEdges=eligibleEdges.slice(0,recipe.bounds.maxEdges);
  return{nodes:shownNodes,edges:shownEdges,omitted:{nodes:Math.max(0,nodes.length-shownNodes.length),edges:Math.max(0,eligibleEdges.length-shownEdges.length),disconnectedEdges:Math.max(0,edges.length-eligibleEdges.length)}};
}

export function evaluateProjectionRecipe(graph,index,recipeInput){
  const presentation=presentationRecordIndex(graph);
  let recipe=createProjectionRecipe(recipeInput);if(recipe.kind==='whole'&&recipe.grouping==='none')recipe=createProjectionRecipe({...recipe,grouping:'repository',raw:false});const summary=summarizeProjectionRecipe(recipe),memberships=index?.memberships||groundedMemberships(graph),refusalByNode=refusalMembership(graph),structuralByNode=structuralMembership(graph),entityView=index?.entityView||entityLayerView(graph),interpretationView=index?.interpretationView||interpretationLayerView(graph),eventView=index?.eventView||eventFlowView(graph),byId=new Map((graph.nodes||[]).map(node=>[node.id,node])),records=rawEdgeRecords(graph,presentation);
  if(recipe.kind==='whole'||!recipe.seeds.length){
    const grouping=recipe.grouping,source=index?.aggregates?.[grouping]||aggregateRecords([...byId.values()],records,grouping,memberships,refusalByNode,structuralByNode,entityView,interpretationView,eventView,presentation),filteredEdges=filteredAggregateEdges(source.edges,recipe),bounded=boundProjection(source.nodes.map(node=>({...node,whyIncluded:['whole-estate semantic aggregation']})),filteredEdges,recipe),view=chooseView(recipe,bounded.nodes.length,bounded.edges.length);
    const noDomain=grouping==='domain'&&!memberships.length,noRefusal=grouping==='refusal'&&!refusalByNode.size,noStructure=(grouping==='structure'||grouping==='landing')&&!structuralByNode.size,noEntity=grouping==='entity'&&!entityView.entities.length,noInterpretation=grouping==='interpretation'&&!interpretationView.concepts.length,noEvent=grouping==='event'&&!eventView.kinds.length;
    return{recipe,summary,title:'Whole estate',nodes:view==='matrix'?[]:bounded.nodes,edges:view==='matrix'?[]:bounded.edges,matrix:view==='matrix'?matrixFor(bounded.nodes,bounded.edges):null,view,totalNodes:source.nodes.length,totalEdges:filteredEdges.length,included:{nodes:bounded.nodes.length,edges:bounded.edges.length},omitted:bounded.omitted,simplification:{bundled:true,degree2:false,reversible:true},guidance:noEvent?{kind:'no-event-flow',message:'No envelope-bus traffic is carried by this graph. The event-flow view is built from the extractors\u2019 own `emits` / `consumes` edges; with no envelope_kind node there is nothing to draw and nothing is invented.'}:noInterpretation?{kind:'no-interpretation-layer',message:'No interpretation layer is carried by this graph. Run interpretation-layer.mjs (slices -> packets -> apply) and merge the *.interpretation-layer.jsonl family; interpretation concepts are model inferences over reproducible graph slices, and are drawn as a separate, weaker evidentiary class rather than as extracted facts.'}:noEntity?{kind:'no-entity-layer',message:'No entity layer is carried by this graph. Run entity-layer.mjs and merge the *.entity-layer.jsonl family; entities are derived from SQLite DDL plus independent corroboration, never guessed.'}:noStructure?{kind:'no-structure',message:'No structural grouping is carried by this graph. Run structural-grouping.mjs and merge the overlay; structural groups are derived from directory position, never guessed.'}:noDomain?{kind:'no-domain',message:'No grounded domain membership is available. Try repository or kind grouping; domains are never guessed.'}:noRefusal?{kind:'no-refusal',message:'No refusal records are carried by this graph. Run domain-derivation.mjs --refusals and merge the ledger; refusals are recorded, never inferred.'}:null,reason:'complete full-input aggregate index; raw graph was not instantiated'};
  }
  let seeds=recipe.seeds.filter(id=>byId.has(id));
  if(recipe.includeMembership){const domains=new Set(memberships.filter(item=>seeds.includes(item.nodeId)).map(item=>item.domain));seeds=[...new Set([...seeds,...memberships.filter(item=>domains.has(item.domain)).map(item=>item.nodeId)])].sort();}
  let included,path=null,guidance=null;
  if(recipe.kind==='path'&&recipe.seeds.length<2){included=traversal(records,recipe,seeds,byId);guidance={kind:'no-path',message:'Pin two selections to find a deterministic witnessed path.'};}
  else if(recipe.kind==='path'&&recipe.seeds.length>=2){path=shortestPath(records,recipe,recipe.seeds[0],recipe.seeds[1],byId);included=new Map();if(path)path.nodes.forEach((id,index)=>included.set(id,{depth:index,reason:index===0?'pinned path start':index===path.nodes.length-1?'pinned path destination':'deterministic shortest witnessed path',path:path.nodes.slice(0,index+1)}));else guidance={kind:'no-path',message:`No witnessed ${recipe.direction} path is available within ${Math.max(1,recipe.hops)} hops and the selected families/statuses.`};}
  else included=traversal(records,recipe,seeds,byId);
  const rawNodes=[...included].map(([id,why])=>({...byId.get(id),label:selected(presentation,`node:${id}`),raw:true,aggregate:false,whyIncluded:[why.reason],inclusionPath:why.path})),includedIds=new Set(included.keys()),rawEdges=(path?path.edges:records.filter(record=>includedIds.has(record.source)&&includedIds.has(record.target)&&allowed(record,recipe))).map(edge=>({...edge,whyIncluded:edge.whyIncluded||'connects included canonical evidence'}));
  const grouped=recipe.grouping==='none'?{nodes:rawNodes,edges:rawEdges,nodeToGroup:new Map(rawNodes.map(node=>[node.id,node.id]))}:aggregateRecords(rawNodes,rawEdges,recipe.grouping,memberships,refusalByNode,structuralByNode,entityView,interpretationView,eventView,presentation);for(const node of grouped.nodes)if(!node.whyIncluded?.length)node.whyIncluded=['contains included canonical evidence'];
  const boundRecipe={...recipe,seeds:recipe.seeds.map(id=>grouped.nodeToGroup.get(id)).filter(Boolean)},bounded=boundProjection(grouped.nodes,grouped.edges,boundRecipe),view=chooseView(recipe,bounded.nodes.length,bounded.edges.length),noDomain=recipe.grouping==='domain'&&!memberships.length;
  if(noDomain)guidance={kind:'no-domain',message:'No grounded domain membership is available. Try repository or kind grouping; domains are never guessed.'};
  if(recipe.grouping==='refusal'&&!refusalByNode.size)guidance={kind:'no-refusal',message:'No refusal records are carried by this graph. Run domain-derivation.mjs --refusals and merge the ledger; refusals are recorded, never inferred.'};
  if(recipe.grouping==='entity'&&!entityView.entities.length)guidance={kind:'no-entity-layer',message:'No entity layer is carried by this graph. Run entity-layer.mjs and merge the *.entity-layer.jsonl family; entities are derived from SQLite DDL plus independent corroboration, never guessed.'};
  if((recipe.grouping==='structure'||recipe.grouping==='landing')&&!structuralByNode.size)guidance={kind:'no-structure',message:'No structural grouping is carried by this graph. Run structural-grouping.mjs and merge the overlay; structural groups are derived from directory position, never guessed.'};
  if(recipe.grouping==='event'&&!eventView.kinds.length)guidance={kind:'no-event-flow',message:'No envelope-bus traffic is carried by this graph. The event-flow view is built from the extractors\u2019 own `emits` / `consumes` edges; with no envelope_kind node there is nothing to draw and nothing is invented.'};
  if(recipe.grouping==='interpretation'&&!interpretationView.concepts.length)guidance={kind:'no-interpretation-layer',message:'No interpretation layer is carried by this graph. Run interpretation-layer.mjs (slices -> packets -> apply) and merge the *.interpretation-layer.jsonl family; interpretation concepts are model inferences over reproducible graph slices, and are drawn as a separate, weaker evidentiary class rather than as extracted facts.'};
  return{recipe,summary,title:recipe.kind==='path'?'Witnessed path':recipe.direction==='downstream'?'Downstream blast radius':recipe.direction==='upstream'?'Upstream lineage':'Neighborhood',nodes:view==='matrix'?[]:bounded.nodes,edges:view==='matrix'?[]:bounded.edges,matrix:view==='matrix'?matrixFor(bounded.nodes,bounded.edges):null,view,totalNodes:grouped.nodes.length,totalEdges:grouped.edges.length,included:{nodes:bounded.nodes.length,edges:bounded.edges.length},omitted:bounded.omitted,simplification:{bundled:recipe.grouping!=='none',degree2:false,reversible:true},guidance,reason:path?'deterministic shortest witnessed path':`bounded ${recipe.hops}-hop canonical traversal`};
}

export function compileLegacyProjectionRecipe({mode='topology',level=0,scope=null}={}){
  const families=mode==='infrastructure'?['config','infra','messaging']:mode==='apis'?['api','test']:mode==='dependencies'?['package']:[];
  return createProjectionRecipe({kind:level===0?'whole':'neighborhood',seeds:scope?.memberIds||[],hops:level>=2?1:0,direction:'both',edgeFamilies:families,grouping:level>=2?'none':level===1?'kind':'repository',raw:level>=2});
}

export function projectionBrowserSource(){return[
  `const DIRECTIONS=new Set(['both','upstream','downstream']),GROUPINGS=new Set(['none','repository','kind','domain','refusal','structure','landing','entity','interpretation','event']),VIEWS=new Set(['auto','graph','matrix']),RANKINGS=new Set(['degree','id']),MAX_BOUNDS=Object.freeze({aggregateNodes:150,aggregateEdges:400,rawNodes:80,rawEdges:160});`,
  `const targets=${targets.toString()};`,`const strings=${strings.toString()};`,`const orderedStrings=${orderedStrings.toString()};`,`const integer=${integer.toString()};`,`const stable=${stable.toString()};`,
  `const presentationRecordIndex=graph=>new Map((graph.presentation_records||[]).map(record=>[record.subject+'\\0'+record.field,record]));`,
  `const selectPresentation=(index,subject,field)=>{const record=index.get(subject+'\\0'+field);if(!record)throw new Error('missing persisted presentation record: '+subject+'.'+field);return record;};`,`const selected=${selected.toString()};`,
  createProjectionRecipe.toString(),serializeProjectionRecipe.toString(),deserializeProjectionRecipe.toString(),recipeToHash.toString(),recipeFromHash.toString(),summarizeProjectionRecipe.toString(),groundedMemberships.toString(),refusalMembership.toString(),structuralMembership.toString(),entityLayerView.toString(),entityAggregates.toString(),interpretationLayerView.toString(),interpretationAggregates.toString(),eventFlowView.toString(),eventFlowAggregates.toString(),`const structureDescriptor=${structureDescriptor.toString()};`,descriptor.toString(),aggregateRecords.toString(),rawEdgeRecords.toString(),allowed.toString(),traversal.toString(),shortestPath.toString(),chooseView.toString(),matrixFor.toString(),filteredAggregateEdges.toString(),boundProjection.toString(),evaluateProjectionRecipe.toString(),
].join('\n');}
