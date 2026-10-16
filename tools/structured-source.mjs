// Deterministic structured observations and explicit section references.
//
// JSON uses the platform parser. YAML and TOML use deliberately strict, fail-closed parsers for
// ordinary configuration mappings/lists; unsupported language features yield findings and lexical
// mentions rather than invented structure. JS/TS and pseudocode are lexical-only in v1.
import path from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const STRUCTURED_OBSERVATION_SCHEMA = 'estate-map/structured-observation/v1';
export const SECTION_REFERENCE_SCHEMA = 'estate-map/section-reference/v1';
const canonical = value => stableStringify(value).trim();

const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const scalarType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const unquote = value => {
  const source = String(value).trim();
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) return source.slice(1, -1);
  if (/^(true|false)$/i.test(source)) return source.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(source)) return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(source)) return Number(source);
  if (/^\[[^\]]*\]$/.test(source)) return source.slice(1, -1).split(',').map(item => unquote(item)).filter(item => item !== '');
  return source;
};

const observation = ({ file, block, syntax, fieldPath, value, line, quote, evidenceClass, producer }) => {
  const body = {
    schema: STRUCTURED_OBSERVATION_SCHEMA,
    authority_plane: 'deterministic_structure',
    producer,
    evidence_class: evidenceClass,
    syntax,
    field_path: fieldPath,
    value_type: scalarType(value),
    value,
    source_span: { file, start: line, end: line },
    source_quote: quote,
    block_address: block.address,
    block_id: block.id,
  };
  return Object.freeze({ ...body, id: `structured-observation:${sha256(canonical(body))}` });
};

function walkJson(value, prefix, emit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, [...prefix, String(index)], emit));
    return;
  }
  if (value && typeof value === 'object') {
    // JSON.parse preserves source member order; keeping it lets duplicate leaf keys map to their
    // corresponding source occurrence rather than whichever alphabetic key happens to walk first.
    for (const key of Object.keys(value)) walkJson(value[key], [...prefix, key], emit);
    return;
  }
  emit(prefix.join('.'), value);
}

function parseJsonBlock({ file, block, body, startLine, evidenceClass }) {
  const parsed = JSON.parse(body);
  const rows = [], seenLeafOccurrences = new Map();
  walkJson(parsed, [], (fieldPath, value) => {
    const leaf = fieldPath.split('.').at(-1);
    const lines = body.split('\n');
    const matching = lines.map((line, index) => line.includes(`"${leaf}"`) ? index : -1).filter(index => index >= 0);
    const ordinal = seenLeafOccurrences.get(leaf) || 0;
    seenLeafOccurrences.set(leaf, ordinal + 1);
    const index = matching[ordinal] ?? matching[0] ?? -1;
    rows.push(observation({ file, block, syntax: 'json', fieldPath, value,
      line: startLine + Math.max(0, index), quote: index >= 0 ? lines[index].trim() : leaf,
      evidenceClass, producer: 'json_parser' }));
  });
  return rows;
}

function parseYamlBlock({ file, block, body, startLine, evidenceClass }) {
  const rows = [], stack = [];
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith('#') || raw.trim() === '---' || raw.trim() === '...') continue;
    if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) throw new Error('tabs are not valid indentation in strict YAML parser');
    if (/^[^#]*[&*!][A-Za-z0-9_-]+/.test(raw) || /[|>]\s*(?:#.*)?$/.test(raw)) throw new Error('unsupported YAML anchor/tag/block scalar');
    const indent = raw.length - raw.trimStart().length;
    const source = raw.trim();
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const sequence = /^-\s+(.*)$/.exec(source);
    const item = sequence ? sequence[1] : source;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(item);
    if (!match) {
      if (sequence) {
        const pathParts = [...stack.map(row => row.key), String(stack.filter(row => row.sequence).length)];
        rows.push(observation({ file, block, syntax: 'yaml', fieldPath: pathParts.join('.'), value: unquote(item),
          line: startLine + index, quote: source, evidenceClass, producer: 'strict_yaml_parser' }));
        continue;
      }
      throw new Error(`unsupported YAML line ${index + 1}`);
    }
    const [, key, rawValue] = match;
    const fieldPath = [...stack.map(row => row.key), key].join('.');
    if (rawValue === '') {
      stack.push({ indent, key, sequence: Boolean(sequence) });
      continue;
    }
    rows.push(observation({ file, block, syntax: 'yaml', fieldPath, value: unquote(rawValue),
      line: startLine + index, quote: source, evidenceClass, producer: 'strict_yaml_parser' }));
  }
  return rows;
}

function parseTomlBlock({ file, block, body, startLine, evidenceClass }) {
  const rows = [], lines = body.split('\n');
  let section = [];
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index].trim();
    if (!source || source.startsWith('#')) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(source);
    if (header) { section = header[1].split('.'); continue; }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(source);
    if (!match) throw new Error(`unsupported TOML line ${index + 1}`);
    rows.push(observation({ file, block, syntax: 'toml', fieldPath: [...section, ...match[1].split('.')].join('.'),
      value: unquote(match[2]), line: startLine + index, quote: source, evidenceClass,
      producer: 'strict_toml_parser' }));
  }
  return rows;
}

function lexicalExample({ file, block, body, startLine, syntax, evidenceClass }) {
  const rows = [], seen = new Set(), lines = body.split('\n');
  const patterns = [
    /(?:^\s*|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    /["']([A-Z][A-Z0-9_]{2,}|[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)["']/g,
    /\b([A-Z][A-Z0-9_]{2,})\b/g,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(lines[index])) !== null) {
        const value = match[1];
        const signature = `${startLine + index}\0${value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        rows.push(observation({ file, block, syntax, fieldPath: value, value, line: startLine + index,
          quote: match[0].trim(), evidenceClass, producer: 'lexical_example_scanner' }));
      }
    }
  }
  return rows;
}

// A diagram fence declares nodes and edges, not key/value facts. Running the lexical scanner over
// one produces observations like `BOOT = BOOT` stamped with deterministic-structure authority, and
// feeds generic diagram identifiers into repeated-identifier candidate signals. Diagrams are
// documentary prose for our purposes: mentions may come from the prepass, structure may not.
const DIAGRAM_SYNTAXES = new Set(['mermaid', 'plantuml', 'puml', 'dot', 'graphviz', 'sequencediagram', 'flowchart', 'gantt', 'stateDiagram'.toLowerCase()]);

// A diagram identifier is real source text and must stay addressable, but it is NOT a structured
// fact and must not silently establish cross-document identity: callers keep it out of
// repeated-identifier candidate signals.
function diagramMentions({ block, body, startLine, syntax }) {
  const rows = [], seen = new Set(), lines = String(body).split('\n');
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;
  const keywords = new Set(['flowchart', 'graph', 'subgraph', 'end', 'classdef', 'class', 'style', 'click',
    'sequencediagram', 'statediagram', 'participant', 'note', 'over', 'left', 'right', 'direction',
    'erdiagram', 'gantt', 'title', 'section', 'digraph', 'node', 'edge', 'rankdir', 'label', 'shape']);
  lines.forEach((rawLine, index) => {
    // Quoted text is a human-readable LABEL, not an identifier. Scanning it would mint mentions out
    // of ordinary prose words (`ROOT["Atomic root"]` would yield `Atomic` and `root`).
    const line = rawLine.replace(/"[^"]*"|'[^']*'/g, ' ');
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(line)) !== null) {
      const surface = match[1];
      if (keywords.has(surface.toLowerCase()) || seen.has(surface)) continue;
      seen.add(surface);
      rows.push({ surface, kind: 'diagram_identifier', syntax, line: startLine + index, block_address: block.address });
    }
  });
  return rows;
}

function fenced(block) {
  const lines = block.text.split('\n');
  const open = /^\s*(?:`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/.exec(lines[0] || '');
  if (!open) return null;
  return { language: open[1].toLowerCase(), body: lines.slice(1, -1).join('\n'), startLine: block.start + 1 };
}

/** Parse structured files/fences and retain typed fallback findings. */
export function extractStructuredObservations({ file, content, inventory }) {
  const observations = [], findings = [], diagramIdentifiers = [];
  const extension = path.extname(file).toLowerCase();
  const actualSyntax = ({ '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml' })[extension] || null;
  const actualEvidenceClass = /^(?:design|docs)\//.test(file) ? 'document_structured_data' : 'runtime_configuration';
  const targets = actualSyntax
    ? [{ block: { address: `${file}@file`, id: `file:${sha256(content)}`, start: 1, text: content }, syntax: actualSyntax, body: content, startLine: 1, evidenceClass: actualEvidenceClass }]
    : inventory.blocks.filter(block => block.type === 'code').map(block => {
      const frame = fenced(block);
      return frame ? { block, syntax: frame.language, body: frame.body, startLine: frame.startLine, evidenceClass: 'document_example' } : null;
    }).filter(Boolean);

  for (const target of targets) {
    const syntax = target.syntax === 'yml' ? 'yaml' : target.syntax;
    if (DIAGRAM_SYNTAXES.has(syntax)) {
      findings.push({
        code: 'DIAGRAM_FENCE_NOT_STRUCTURED', file, block_address: target.block.address,
        syntax, detail: 'diagram fences declare nodes and edges, not structured observations',
      });
      diagramIdentifiers.push(...diagramMentions(target));
      continue;
    }
    try {
      let rows;
      if (syntax === 'json') rows = parseJsonBlock({ file, ...target });
      else if (syntax === 'yaml') rows = parseYamlBlock({ file, ...target });
      else if (syntax === 'toml') rows = parseTomlBlock({ file, ...target });
      else rows = lexicalExample({ file, ...target, syntax: syntax || 'pseudocode' });
      observations.push(...rows);
    } catch (error) {
      findings.push({
        code: 'STRUCTURED_PARSE_FALLBACK', file, block_address: target.block.address,
        syntax: syntax || 'unknown', detail: error.message,
      });
      observations.push(...lexicalExample({ file, ...target, syntax: syntax || 'pseudocode' }));
    }
  }
  observations.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  diagramIdentifiers.sort((a, b) => a.line - b.line || a.surface.localeCompare(b.surface));
  return Object.freeze({ observations, findings, diagram_identifiers: diagramIdentifiers });
}

const headingNumber = block => {
  const match = /^#{1,6}\s+((?:\d+\.)*\d+)\b/.exec(block.text.split('\n')[0] || '');
  return match?.[1] || null;
};

/** Resolve explicit `§N.N` references to numbered headings in the same document. */
export function extractSectionReferences({ file, content, inventory }) {
  const headings = new Map();
  for (const block of inventory.blocks.filter(row => row.type === 'heading')) {
    const number = headingNumber(block);
    if (number) headings.set(number, block);
  }
  const references = [], findings = [];
  const regex = /§\s*((?:\d+\.)*\d+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const number = match[1], target = headings.get(number), line = lineAt(content, match.index);
    if (!target) {
      findings.push({ code: 'UNRESOLVED_SECTION_REFERENCE', file, number, source_span: { file, start: line, end: line } });
      continue;
    }
    const body = {
      schema: SECTION_REFERENCE_SCHEMA,
      authority_plane: 'deterministic_structure',
      producer: 'section_reference_parser',
      file,
      number,
      source_span: { file, start: line, end: line },
      target: { file, block_address: target.address, block_id: target.id, start: target.start, end: target.end },
    };
    references.push(Object.freeze({ ...body, id: `section-reference:${sha256(canonical(body))}` }));
  }
  references.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return Object.freeze({ references, findings });
}
