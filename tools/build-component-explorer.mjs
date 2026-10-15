#!/usr/bin/env node
// Build a browser-safe component-at-a-time explorer from a full neural graph export.
// The legacy explorer force-simulates every connected node with O(N²) repulsion; this projection
// computes components once and renders only one at a time while retaining every
// connected claim, relation, resolution, rationale, and cited source span in the HTML.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [input, output, reviewFile] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/build-component-explorer.mjs <graph.json> <output.html> [human-review.json]');
  process.exit(2);
}
const graph = JSON.parse(fs.readFileSync(input, 'utf8'));
const reviewEnvelope = reviewFile ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : { reviews: {} };
const reviews = reviewEnvelope.reviews || {};
const isConflict = edge => edge?.pair_conflict === 'conflict' || edge?.real_issue === true;
const edgeNodeIds = new Set();
for (const edge of graph.edges) { edgeNodeIds.add(edge.source); edgeNodeIds.add(edge.target); }
const nodes = graph.nodes.filter(node => edgeNodeIds.has(node.id));
const nodeById = new Map(nodes.map(node => [node.id, node]));
const adjacency = new Map(nodes.map(node => [node.id, []]));
graph.edges.forEach((edge, index) => {
  if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) return;
  adjacency.get(edge.source).push({ id: edge.target, edge: index });
  adjacency.get(edge.target).push({ id: edge.source, edge: index });
});
const rawComponents = [];
const seen = new Set();
for (const node of nodes) {
  if (seen.has(node.id)) continue;
  const queue = [node.id], nodeIds = [], edgeIndices = new Set();
  seen.add(node.id);
  while (queue.length) {
    const id = queue.pop(); nodeIds.push(id);
    for (const hit of adjacency.get(id)) {
      edgeIndices.add(hit.edge);
      if (!seen.has(hit.id)) { seen.add(hit.id); queue.push(hit.id); }
    }
  }
  const edges = [...edgeIndices].map(index => graph.edges[index]);
  const documents = [...new Set(nodeIds.map(id => nodeById.get(id).document))].sort();
  const relations = {};
  for (const edge of edges) relations[edge.rel] = (relations[edge.rel] || 0) + 1;
  const rawFlags = edges.filter(isConflict).length;
  const humanFalsePositives = edges.filter(edge => reviews[edge.case_id]?.verdict === 'false_positive').length;
  const labels = nodeIds.slice(0, 5).map(id => nodeById.get(id).neighbourhood).filter(Boolean);
  rawComponents.push({ node_ids: nodeIds.sort(), edge_indices: [...edgeIndices].sort((a, b) => a - b), node_count: nodeIds.length, edge_count: edgeIndices.size, documents, relations, raw_flags: rawFlags, human_false_positives: humanFalsePositives, label: [...new Set(labels)].slice(0, 2).join(' / ') || documents[0] || 'component' });
}
rawComponents.sort((a, b) => b.node_count - a.node_count || b.edge_count - a.edge_count || a.label.localeCompare(b.label));
const components = rawComponents.map((component, id) => {
  const searchText = [component.label, ...component.documents, ...component.node_ids.flatMap(nodeId => {
    const node = nodeById.get(nodeId); return [node.statement, node.neighbourhood, node.predicate];
  })].join(' ').toLowerCase();
  return { id, ...component, search_text: searchText };
});
const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/component-explorer-template.html');
const template = fs.readFileSync(templatePath, 'utf8');
const data = { meta: graph.meta, nodes, edges: graph.edges, components, human_reviews: reviews };
const anchor = /^const DB = __DATA__;$/m;
if (!anchor.test(template)) throw new Error(`data anchor absent from ${templatePath}`);
// JSON is valid JavaScript, but raw '<' can contain a source excerpt's `</script>` and terminate the
// HTML script element before the browser parses it. Escape HTML-significant/codepoint separators.
const serialized = JSON.stringify(data)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
// Function replacer is mandatory: a replacement STRING interprets `$&`, `$\``, and `$'` found in
// source excerpts as substitution directives, silently corrupting the embedded JSON/JavaScript.
const rendered = template.replace(anchor, () => `const DB = ${serialized};`);
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, rendered, 'utf8');
console.log(JSON.stringify({ output: path.resolve(output), bytes: Buffer.byteLength(rendered), connected_nodes: nodes.length, edges: graph.edges.length, components: components.length, largest_component: components[0]?.node_count || 0, raw_flags: graph.edges.filter(isConflict).length, reviewed_false_positives: Object.values(reviews).filter(review => review.verdict === 'false_positive').length }));
