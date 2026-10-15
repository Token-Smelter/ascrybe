#!/usr/bin/env node
// Deterministic, topology-aware node placement for the estate-map explorer.
//
// The previous renderer derived coordinates from a node's INDEX IN THE ARRAY
// (x = index % columns), so position encoded array order and nothing about the
// graph: edges flew diagonally across the canvas and the eye could not find
// structure. Placement here is a pure function of the graph instead.
//
// This module exists as a module (rather than living inline in render.mjs's
// HTML template literal) so the layout is genuinely unit-testable. render.mjs
// inlines it into the browser bundle via layoutBrowserSource(), the same
// Function.prototype.toString() mechanism the file already uses for the
// projection code. Consequence: every function inlined below must be
// self-contained (no imports, no module-scope references other than the
// constants block that layoutBrowserSource emits alongside them) and must
// contain no backtick and no ${ , which would be interpolated at render time
// and corrupt the emitted HTML.
//
// No RNG and no physics simulation: identical input renders byte-identically,
// which the existing determinism acceptance criteria depend on.

export const LAYOUT_CONSTANTS=Object.freeze({
  RING_STEP:210,      // base radius per BFS ring
  NODE_STEP:190,      // arc length reserved per node on a ring
  TRAY_STEP:125,      // grid pitch of the degree-0 tray
  COMPONENT_GAP:150,  // padding between packed components
  TRAY_GAP:150,       // vertical gap between structure and tray
  CANVAS_WIDTH:2600,  // wrap width for row-major component packing
  TRAY_COLUMNS:10,    // tray stays narrow: at most this many columns
  RING_ASPECT:1.45,   // rings are ellipses (wider than tall), never circles
});

/**
 * Split edges into the ones worth drawing and per-node self-loop totals.
 * A self-loop (a repository's intra-repo imports collapsing onto itself)
 * carries no comparative information and, on a real estate, accounts for most
 * of the visual noise. Its count is preserved per node rather than discarded.
 */
export function splitSelfLoops(edges){
  const selfLoops=new Map(),drawn=[];
  for(const edge of edges){
    if(edge.source===edge.target)selfLoops.set(edge.source,(selfLoops.get(edge.source)||0)+(edge.count||1));
    else drawn.push(edge);
  }
  return{drawn,selfLoops};
}

/**
 * Compute a position for every node. Returns Map<nodeId,{x,y}>.
 *
 * Connected components are laid out as concentric elliptical rings around
 * their highest-degree node and packed row-major largest-first; degree-0 nodes
 * are parked in a compact tray beneath the structure. Self-loops must already
 * be excluded from `edges` (see splitSelfLoops) -- a self-loop says nothing
 * about where a node sits relative to OTHER nodes.
 */
export function computeTopologyLayout(nodes,edges){
  const positions=new Map();
  if(!nodes||!nodes.length)return positions;
  const C=LAYOUT_CONSTANTS;
  const order=nodes.map(node=>node.id),indexOf=new Map(order.map((id,i)=>[id,i]));

  // Undirected adjacency, deduped, each list sorted by original node order so
  // no traversal below can depend on Map/Set iteration incidentals.
  const adjacency=new Map(order.map(id=>[id,[]]));
  for(const edge of edges||[]){
    if(edge.source===edge.target)continue;
    if(!adjacency.has(edge.source)||!adjacency.has(edge.target))continue;
    adjacency.get(edge.source).push(edge.target);
    adjacency.get(edge.target).push(edge.source);
  }
  for(const [id,neighbours] of adjacency){
    const seen=new Set(),unique=[];
    for(const other of neighbours){if(other===id||seen.has(other))continue;seen.add(other);unique.push(other);}
    unique.sort((a,b)=>indexOf.get(a)-indexOf.get(b));
    adjacency.set(id,unique);
  }
  const degree=id=>adjacency.get(id).length;

  // Component discovery: seed in stable node order, expand in stable
  // neighbour order.
  const visited=new Set(),components=[];
  for(const id of order){
    if(visited.has(id))continue;
    visited.add(id);
    const queue=[id],members=[];
    while(queue.length){
      const current=queue.shift();
      members.push(current);
      for(const other of adjacency.get(current))if(!visited.has(other)){visited.add(other);queue.push(other);}
    }
    components.push(members);
  }
  const isolated=components.filter(members=>members.length===1).map(members=>members[0]);
  const clusters=components.filter(members=>members.length>1);
  const firstIndex=members=>members.reduce((min,id)=>Math.min(min,indexOf.get(id)),Infinity);
  clusters.sort((a,b)=>b.length-a.length||firstIndex(a)-firstIndex(b));

  // Lay each cluster out locally, around its highest-degree node.
  const laid=clusters.map(members=>{
    const ranked=members.slice().sort((a,b)=>degree(b)-degree(a)||indexOf.get(a)-indexOf.get(b));
    const centre=ranked[0],depth=new Map([[centre,0]]),queue=[centre];
    while(queue.length){
      const current=queue.shift();
      for(const other of adjacency.get(current))if(!depth.has(other)){depth.set(other,depth.get(current)+1);queue.push(other);}
    }
    const rings=new Map();
    for(const id of ranked){
      const ring=depth.has(id)?depth.get(id):1;
      if(!rings.has(ring))rings.set(ring,[]);
      rings.get(ring).push(id);
    }
    const local=new Map();
    let radius=0;
    for(const ring of [...rings.keys()].sort((a,b)=>a-b)){
      const band=rings.get(ring);
      if(ring===0){local.set(band[0],{x:0,y:0});continue;}
      // Radius grows with ring occupancy so a dense ring does not overlap itself.
      const ringRadius=Math.max(ring*C.RING_STEP,(band.length*C.NODE_STEP)/(2*Math.PI));
      radius=Math.max(radius,ringRadius);
      // Ellipse, not circle. Screens are wide and the inspector owns the right
      // third, so vertical compactness is what preserves a readable zoom: a
      // tall layout forces cytoscape's fit() to zoom out until labels are
      // illegible -- structurally correct and practically useless.
      // Half-slot offset so a sparse ring straddles the top rather than
      // stacking its members vertically (a two-node ring placed at exactly
      // -90/+90 degrees is a column, which is the opposite of the wide shape
      // the ellipse exists to produce).
      band.forEach((id,i)=>{
        const angle=(2*Math.PI*i)/band.length-Math.PI/2+Math.PI/band.length;
        local.set(id,{x:Math.cos(angle)*ringRadius*C.RING_ASPECT,y:Math.sin(angle)*ringRadius});
      });
    }
    return{local,radius:Math.max(radius,C.NODE_STEP)};
  });

  // Row-major packing of components, largest first, wrapping at canvas width.
  let cursorX=0,cursorY=0,rowHeight=0;
  for(const cluster of laid){
    // Reserve the ELLIPSE's extent, not a square: a cluster is RING_ASPECT
    // times wider than it is tall, so a square reservation lets neighbouring
    // components overlap horizontally.
    const halfWidth=cluster.radius*C.RING_ASPECT,halfHeight=cluster.radius;
    const spanX=halfWidth*2+C.COMPONENT_GAP,spanY=halfHeight*2+C.COMPONENT_GAP;
    if(cursorX>0&&cursorX+spanX>C.CANVAS_WIDTH){cursorX=0;cursorY+=rowHeight;rowHeight=0;}
    const originX=cursorX+halfWidth+C.COMPONENT_GAP/2,originY=cursorY+halfHeight+C.COMPONENT_GAP/2;
    for(const [id,point] of cluster.local)positions.set(id,{x:originX+point.x,y:originY+point.y});
    cursorX+=spanX;
    rowHeight=Math.max(rowHeight,spanY);
  }

  // Degree-0 nodes: a compact tray beneath the structure. They stay visible but
  // stop occupying the visual weight (and prime canvas space) of a hub.
  //
  // The tray is deliberately NARROW and horizontally centred. A tray spanning
  // the full canvas dominates the bounding box, so fit() zooms out to contain
  // it and the actual topology collapses into an unreadable knot.
  if(isolated.length){
    const columns=Math.max(1,Math.min(C.TRAY_COLUMNS,isolated.length));
    const trayWidth=(columns-1)*C.TRAY_STEP;
    let structureLeft=0,structureRight=0,structureBottom=0;
    if(positions.size){
      structureLeft=Infinity;structureRight=-Infinity;structureBottom=-Infinity;
      for(const point of positions.values()){
        structureLeft=Math.min(structureLeft,point.x);
        structureRight=Math.max(structureRight,point.x);
        structureBottom=Math.max(structureBottom,point.y);
      }
    }
    // Centre on the structure's actual midpoint (negative coordinates are fine;
    // cytoscape fits the bounding box, it does not care about the origin).
    const trayLeft=(structureLeft+structureRight)/2-trayWidth/2;
    const trayTop=structureBottom+C.TRAY_GAP;
    isolated.slice().sort((a,b)=>indexOf.get(a)-indexOf.get(b)).forEach((id,i)=>{
      positions.set(id,{x:trayLeft+(i%columns)*C.TRAY_STEP,y:trayTop+Math.floor(i/columns)*C.TRAY_STEP});
    });
  }
  return positions;
}

/** Browser-side source for the layout, inlined by render.mjs into its HTML. */
export function layoutBrowserSource(){
  return 'const LAYOUT_CONSTANTS='+JSON.stringify(LAYOUT_CONSTANTS)+';\n'+splitSelfLoops.toString()+'\n'+computeTopologyLayout.toString();
}
