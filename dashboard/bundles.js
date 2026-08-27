// Folded neighbourhoods. The node query returns every relation of the selected node as a counted
// bundle plus the rows it had room for; the canvas draws a bundle only for what the rows did not
// already show. Pure so the residual arithmetic can be verified without a DOM.
export function bundleId(owner, bundle) {
  return `bundle:${owner}\u0000${bundle.relation}\u0000${bundle.direction}\u0000${bundle.kind}`;
}

// The query returns every relation of the selected node as a counted bundle, and the rows it had
// room for. A bundle is drawn only for what the rows did not already show: its residual count.
// Structural rows are the drill-down; bundles are what is folded beneath it at this node.
export function bundlesFor(payload) {
  const shown = new Map();
  for (const row of payload.neighbors) {
    const direction = row.edge.from === payload.node.id ? 'out' : 'in';
    const key = `${row.edge.relation}\u0000${direction}\u0000${row.node.kind}`;
    shown.set(key, (shown.get(key) || 0) + 1);
  }
  return (payload.bundles || []).map(bundle => {
    const residual = bundle.count == null ? null : bundle.count - (shown.get(`${bundle.relation}\u0000${bundle.direction}\u0000${bundle.kind}`) || 0);
    return { ...bundle, id: bundleId(payload.node.id, bundle), residual, owner: payload.node.id };
  }).filter(bundle => bundle.residual == null || bundle.residual > 0)
    .map(bundle => ({ ...bundle, count: bundle.residual ?? bundle.count }));
}

