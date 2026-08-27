// AST-based Swift extractor (web-tree-sitter, WASM), mirroring
// treesitter-js.mjs's structure for JS/TS/TSX.
//
// Swift is architecturally different from JS/TS in one load-bearing way:
// within a single Swift MODULE, top-level declarations across ALL of that
// module's files are visible to every other file in the module with no
// per-file import statement between them. `import Foo` names an external
// MODULE/framework dependency (Foundation, UIKit, an SPM package, ...), not
// a file in this project. So this extractor emits THREE fact kinds:
//   - 'module'    one per .swift file (same convention as treesitter-js.mjs)
//   - 'import'    one per `import Foo` framework/module import, carrying
//                 the raw module name -- always resolved as an external
//                 dependency by merge.mjs's `imports_framework` pass, never
//                 as a file (see merge.mjs for the two-edge-kind design).
//   - 'symbol'    one per top-level declared class/struct/enum/protocol/
//                 extension/func/global (let/var).
//   - 'reference' one per top-level-type-shaped identifier usage (any
//                 `user_type` occurrence: inheritance, property/parameter/
//                 return type annotations, generics, casts) -- these are
//                 what merge.mjs resolves against a project-wide symbol
//                 table to recover Swift's file-to-file coupling, since
//                 there is no import statement to resolve instead.
//
// READ-ONLY / NO-EXEC / NO-NETWORK: same guarantee as treesitter-js.mjs --
// this module only parses text already read and secret-redacted by
// extract.mjs, never requires/imports/evals the scanned repository's own
// code, spawns no child process, and performs no network I/O. The only I/O
// here is the local filesystem reads of (a) the pinned `tree-sitter-swift`
// grammar WASM (via treesitter/loader.mjs, already a dependency for JS/TS)
// and (b) the three committed .scm query files below.
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
