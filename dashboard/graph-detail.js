function displayValue(value) {
  if (value == null) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function propertiesFor(node) {
  return node?.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties
    : {};
}

function endpointLabel(id, nodes) {
  const node = nodes instanceof Map ? nodes.get(id) : nodes?.[id];
  const endpoint = displayValue(id);
  const label = node?.label == null ? null : displayValue(node.label);
  return label && label !== endpoint ? `${label} (${endpoint})` : endpoint;
}

export function graphDetailForNode(node) {
  const title = node?.label == null ? displayValue(node?.id) : displayValue(node.label);
  return {
    type: 'Node',
    title,
    fields: [
      { label: 'Kind', value: displayValue(node?.kind) },
      { label: 'Node ID', value: displayValue(node?.id) },
      ...Object.entries(propertiesFor(node)).map(([label, value]) => ({
        label: label.replaceAll('_', ' '), value: displayValue(value),
      })),
    ],
  };
}

export function graphDetailForEdge(edge, nodes) {
  const source = endpointLabel(edge?.from, nodes);
  const target = endpointLabel(edge?.to, nodes);
  return {
    type: 'Relation',
    title: displayValue(edge?.relation),
    fields: [
      { label: 'Relation', value: displayValue(edge?.relation) },
      { label: 'Source', value: source },
      { label: 'Target', value: target },
      { label: 'Direction', value: `${source} → ${target}` },
    ],
  };
}

export function graphDetailText(detail) {
  return [detail.type, detail.title, ...detail.fields.map(field => `${field.label}: ${field.value}`)]
    .join('. ');
}
