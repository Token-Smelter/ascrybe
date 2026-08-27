// AST-based Python extractor (web-tree-sitter, WASM), mirroring
// treesitter-js.mjs's discipline for the JS/TS/TSX grammar family.
//
// Emits one 'module' fact per .py file (with package/__init__ status and a
// naive repo-root-relative dotted module path — the source-root-aware
// dotted path used for resolution is computed in merge.mjs, which has
// visibility across the whole module-fact set and can infer real source
// roots from where __init__.py chains actually stop; a single file's own
// extraction cannot know that), one 'import' fact per import/import-as/
// from-import/relative-from occurrence (raw specifier + relative dot
// level), and one 'symbol' fact per top-level def/class/assignment.
//
// READ-ONLY / NO-EXEC / NO-NETWORK (AC-READONLY-NOEXEC-NONET): same
// contract as treesitter-js.mjs — this module only parses text already
// read and secret-redacted by extract.mjs before scan() ever sees it; it
// never requires/imports/evals the scanned repository's own code, spawns
// no child process, and performs no network I/O. The only I/O here is the
// local filesystem reads of (a) the pinned grammar WASM (treesitter/loader.mjs,
// shared with the JS/TS extractor) and (b) the two committed .scm query
// files below — both resolved from local disk paths, never a URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, TreeSitter } from '../treesitter/loader.mjs';
import { usingParsedTree } from './treesitter-js.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '..', 'treesitter', 'queries');
const importQuerySource = fs.readFileSync(path.join(queriesDir, 'python-imports.scm'), 'utf8');
const symbolQuerySource = fs.readFileSync(path.join(queriesDir, 'python-symbols.scm'), 'utf8');

const parser = new TreeSitter();
parser.setLanguage(languages.python);
const queries = {
  imports: languages.python.query(importQuerySource),
  symbols: languages.python.query(symbolQuerySource),
};

const SYMBOL_KIND_BY_NODE_TYPE = {
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
};

// Naive dotted path assuming the repo root is the source root; merge.mjs
// re-derives the source-root-relative path independently for resolution.
function dottedPathFor(file) {
  const withoutExt = file.replace(/\.py$/i, '');
  const segments = withoutExt.split('/');
  if (segments[segments.length - 1] === '__init__') segments.pop();
  return segments.join('.');
}

function leadingDotCount(text) {
  const match = text.match(/^\.+/);
  return match ? match[0].length : 0;
}

function pos(node) {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

function scanImports(tree, ctx, facts) {
  for (const match of queries.imports.matches(tree.rootNode)) {
    const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));

    if (byName['import.plain']) {
      const node = byName['import.specifier'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: node.text, import_kind: 'import', relative_level: 0, column }));
    } else if (byName['import.aliased']) {
      const node = byName['import.specifier'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: node.text, alias: byName['import.alias'].text, import_kind: 'import-as', relative_level: 0, column }));
    } else if (byName['import.from_plain']) {
      const node = byName['import.imported_name'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: byName['import.from_module'].text, imported_name: node.text, import_kind: 'from-import', relative_level: 0, column }));
    } else if (byName['import.from_aliased']) {
      const node = byName['import.imported_name'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: byName['import.from_module'].text, imported_name: node.text, alias: byName['import.alias'].text, import_kind: 'from-import', relative_level: 0, column }));
    } else if (byName['import.from_wildcard']) {
      const node = byName['import.wildcard'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: byName['import.from_module'].text, imported_name: '*', import_kind: 'from-import', relative_level: 0, column }));
    } else if (byName['import.relative_plain']) {
      const node = byName['import.imported_name'];
      const relativeModule = byName['import.relative_module'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: relativeModule.text, imported_name: node.text, import_kind: 'relative-from', relative_level: leadingDotCount(relativeModule.text), column }));
    } else if (byName['import.relative_aliased']) {
      const node = byName['import.imported_name'];
      const relativeModule = byName['import.relative_module'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: relativeModule.text, imported_name: node.text, alias: byName['import.alias'].text, import_kind: 'relative-from', relative_level: leadingDotCount(relativeModule.text), column }));
    } else if (byName['import.relative_wildcard']) {
      const node = byName['import.wildcard'];
      const relativeModule = byName['import.relative_module'];
      const { line, column } = pos(node);
      facts.push(ctx.fact('import', line, { specifier: relativeModule.text, imported_name: '*', import_kind: 'relative-from', relative_level: leadingDotCount(relativeModule.text), column }));
    }
  }
}

function scanSymbols(tree, ctx, facts) {
  for (const match of queries.symbols.matches(tree.rootNode)) {
    const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
    const nameNode = byName['symbol.name'];
    const declNode = byName['symbol.decl'];
    if (!nameNode || !declNode) continue;
    const symbolKind = SYMBOL_KIND_BY_NODE_TYPE[declNode.type] || declNode.type;
    const { line, column } = pos(nameNode);
    facts.push(ctx.fact('symbol', line, { name: nameNode.text, symbol_kind: symbolKind, column }));
  }
}

function scanCode(lines, ctx) {
  const facts = [];
  const text = lines.join('\n');
  const isPackage = path.posix.basename(ctx.file) === '__init__.py';
  facts.push(ctx.fact('module', 1, {
    language: 'python',
    end_line: Math.max(1, lines.length),
    is_package: isPackage,
    dotted_path: dottedPathFor(ctx.file),
  }));

  return usingParsedTree(parser, text, (tree) => {
    scanImports(tree, ctx, facts);
    scanSymbols(tree, ctx, facts);
    return facts;
  });
}

export default {
  kind: 'treesitter_python',
  filePattern: /\.py$/i,
  scan(lines, ctx) {
    return scanCode(lines, ctx);
  },
};
