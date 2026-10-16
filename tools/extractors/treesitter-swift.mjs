// Preserve source witnesses; do not infer authority from naming conventions alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, TreeSitter } from '../treesitter/loader.mjs';
import { usingParsedTree } from './treesitter-js.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '..', 'treesitter', 'queries');
const importQuerySource = fs.readFileSync(path.join(queriesDir, 'swift-imports.scm'), 'utf8');
const symbolQuerySource = fs.readFileSync(path.join(queriesDir, 'swift-symbols.scm'), 'utf8');
const referenceQuerySource = fs.readFileSync(path.join(queriesDir, 'swift-references.scm'), 'utf8');

const parser = new TreeSitter();
parser.setLanguage(languages.swift);

const queries = {
  imports: languages.swift.query(importQuerySource),
  symbols: languages.swift.query(symbolQuerySource),
  references: languages.swift.query(referenceQuerySource),
};

// class/struct/enum/extension all share the `class_declaration` node type
// in tree-sitter-swift; the real keyword used is exposed via the
// `declaration_kind` field (verified against the real grammar).
const DECLARATION_KIND_SYMBOL_KIND = { class: 'class', struct: 'struct', enum: 'enum', extension: 'extension' };

function symbolKindFor(declNode) {
  if (declNode.type === 'protocol_declaration') return 'protocol';
  if (declNode.type === 'function_declaration') return 'function';
  if (declNode.type === 'property_declaration') return 'global';
  if (declNode.type === 'class_declaration') {
    const keyword = declNode.childForFieldName('declaration_kind');
    return (keyword && DECLARATION_KIND_SYMBOL_KIND[keyword.text]) || 'class';
  }
  return declNode.type;
}

function scanCode(lines, ctx) {
  const facts = [];
  const text = lines.join('\n');
  facts.push(ctx.fact('module', 1, { language: 'swift', end_line: Math.max(1, lines.length) }));

  return usingParsedTree(parser, text, (tree) => {
    for (const match of queries.imports.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const moduleNode = byName['import.module'];
      if (!moduleNode) continue;
      facts.push(ctx.fact('import', moduleNode.startPosition.row + 1, {
        module: moduleNode.text,
        import_kind: 'framework',
        column: moduleNode.startPosition.column + 1,
      }));
    }

    for (const match of queries.symbols.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const nameNode = byName['symbol.name'];
      const declNode = byName['symbol.decl'];
      if (!nameNode || !declNode) continue;
      facts.push(ctx.fact('symbol', nameNode.startPosition.row + 1, {
        name: nameNode.text,
        symbol_kind: symbolKindFor(declNode),
        column: nameNode.startPosition.column + 1,
      }));
    }

    for (const match of queries.references.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const nameNode = byName['reference.name'];
      if (!nameNode) continue;
      facts.push(ctx.fact('reference', nameNode.startPosition.row + 1, {
        name: nameNode.text,
        column: nameNode.startPosition.column + 1,
      }));
    }

    return facts;
  });
}

export default {
  kind: 'treesitter_swift',
  filePattern: /\.swift$/i,
  scan(lines, ctx) {
    return scanCode(lines, ctx);
  },
};
