// Preserve source witnesses; do not infer authority from naming conventions alone.

import YAML from 'yaml';

const LEAF_CAP = 400;
const VALUE_CAP = 400;
const KEY_PATH_CAP = 200;

const cap = (text, limit = VALUE_CAP) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

/** Offset -> 1-based line, via a precomputed line-start index (files are scanned once). */
function lineIndexer(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return (offset) => {
    if (!Number.isInteger(offset) || offset < 0) return 1;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

const scalarType = (value) => {
  if (value === null) return 'null';
  const type = typeof value;
  return type === 'object' ? 'unevaluated' : type;
};

/**
 * Depth-first walk over the parsed document, collecting one entry per leaf.
 * A leaf is a scalar, an alias, or an EMPTY map/sequence — an empty collection
 * is itself a statement (see F4's `requires_capabilities: []`) and is recorded
 * rather than skipped.
 */
function collectLeaves(node, path, lineOf, out, seen) {
  if (out.length >= LEAF_CAP * 4) return;
  if (node == null) { out.push({ key_path: path, value: null, value_type: 'null', line: lineOf(0) }); return; }
  if (YAML.isAlias(node)) { out.push({ key_path: path, value: `*${node.source}`, value_type: 'alias', line: lineOf(node.range?.[0]) }); return; }
  if (YAML.isScalar(node)) {
    out.push({ key_path: path, value: cap(node.value), value_type: scalarType(node.value), line: lineOf(node.range?.[0]) });
    return;
  }
  if (YAML.isMap(node)) {
    if (!node.items.length) { out.push({ key_path: path, value: '{}', value_type: 'empty_map', line: lineOf(node.range?.[0]) }); return; }
    for (const pair of node.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const next = cap(path ? `${path}.${key}` : key, KEY_PATH_CAP);
      if (seen.has(pair)) continue;
      seen.add(pair);
      collectLeaves(pair.value, next, lineOf, out, seen);
    }
    return;
  }
  if (YAML.isSeq(node)) {
    if (!node.items.length) { out.push({ key_path: path, value: '[]', value_type: 'empty_sequence', line: lineOf(node.range?.[0]) }); return; }
    node.items.forEach((item, index) => collectLeaves(item, cap(`${path}[${index}]`, KEY_PATH_CAP), lineOf, out, seen));
    return;
  }
  out.push({ key_path: path, value: cap(String(node)), value_type: 'unevaluated', line: lineOf(node?.range?.[0]) });
}

const scalarAt = (doc, key) => {
  const value = doc.get(key, true);
  return YAML.isScalar(value) ? value.value : null;
};

export default {
  kind: 'yaml_record',
  filePattern: /\.(?:ya?ml)$/i,
  scan(lines, ctx) {
    const text = lines.join('\n');
    const lineOf = lineIndexer(text);
    let doc;
    try {
      doc = YAML.parseDocument(text, { keepSourceTokens: false, logLevel: 'silent' });
    } catch (error) {
      return [ctx.fact('yaml_parse_refusal', 1, { reason: 'yaml_parse_threw', detail: cap(error.message) })];
    }
    // A document with a hard parse error is refused whole. A half-parsed catalog
    // is exactly the shape that produces a confident wrong answer.
    const fatal = (doc.errors || []).filter((error) => error.name !== 'YAMLWarning');
    if (fatal.length) {
      return [ctx.fact('yaml_parse_refusal', lineOf(fatal[0].pos?.[0]), { reason: 'yaml_parse_error', detail: cap(fatal[0].message) })];
    }
    if (doc.contents == null) return [];

    const leaves = [];
    collectLeaves(doc.contents, '', lineOf, leaves, new Set());

    const topLevelKeys = YAML.isMap(doc.contents)
      ? doc.contents.items.map((pair) => (YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key))).sort()
      : [];

    const facts = [ctx.fact('yaml_document', 1, {
      // Preserve source witnesses; do not infer authority from naming conventions alone.
      api_version: YAML.isMap(doc.contents) ? (scalarAt(doc, 'api_version') ?? null) : null,
      doc_id: YAML.isMap(doc.contents) ? (scalarAt(doc, 'id') ?? null) : null,
      doc_name: YAML.isMap(doc.contents) ? (scalarAt(doc, 'name') ?? null) : null,
      doc_version: YAML.isMap(doc.contents) ? String(scalarAt(doc, 'version') ?? '') || null : null,
      root_kind: YAML.isMap(doc.contents) ? 'map' : YAML.isSeq(doc.contents) ? 'sequence' : 'scalar',
      top_level_keys: topLevelKeys,
      leaf_count: leaves.length,
      truncated: leaves.length > LEAF_CAP,
    })];

    for (const leaf of leaves.slice(0, LEAF_CAP)) {
      facts.push(ctx.fact('yaml_record', leaf.line, {
        key_path: leaf.key_path,
        value: leaf.value,
        value_type: leaf.value_type,
      }));
    }
    if (leaves.length > LEAF_CAP) {
      facts.push(ctx.fact('yaml_record_refusal', 1, {
        reason: 'leaf_cap_exceeded',
        leaf_cap: LEAF_CAP,
        leaf_count: leaves.length,
        detail: `document carries ${leaves.length} leaf scalars; only the first ${LEAF_CAP} are recorded as yaml_record facts`,
      }));
    }
    return facts;
  },
};
