// AST-based Kotlin extractor (web-tree-sitter, WASM) — mirrors
// treesitter-js.mjs's structure and discipline for a second language.
//
// Emits one 'module' fact per .kt/.kts file (carrying its declared
// package), one 'import' fact per `import` statement (FQN or wildcard, raw
// specifier), and one 'symbol' fact per top-level class/interface/object/
// function declaration — each with precise file+line[:col], correctly
// ignoring comment/string-embedded decoys because the tree-sitter grammar
// never parses comment/string content as declarations.
//
// READ-ONLY / NO-EXEC / NO-NETWORK (AC-READONLY-NOEXEC-NONET, same contract
// as treesitter-js.mjs): parses text already read and secret-redacted by
// extract.mjs; never requires/imports/evals the scanned repository's own
// code, spawns no child process, performs no network I/O. Grammar WASM is
// loaded from local node_modules disk only (treesitter/loader.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, TreeSitter } from '../treesitter/loader.mjs';
import { usingParsedTree } from './treesitter-js.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '..', 'treesitter', 'queries');
const packageQuerySource = fs.readFileSync(path.join(queriesDir, 'kotlin-package.scm'), 'utf8');
const importQuerySource = fs.readFileSync(path.join(queriesDir, 'kotlin-imports.scm'), 'utf8');
const symbolQuerySource = fs.readFileSync(path.join(queriesDir, 'kotlin-symbols.scm'), 'utf8');

let cachedParser = null;
function parserFor() {
  if (!cachedParser) {
    cachedParser = new TreeSitter();
    cachedParser.setLanguage(languages.kotlin);
  }
  return cachedParser;
}

const queries = {
  package: languages.kotlin.query(packageQuerySource),
  imports: languages.kotlin.query(importQuerySource),
  symbols: languages.kotlin.query(symbolQuerySource),
};

function grammarFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.kt') return { name: 'kotlin' };
  if (ext === '.kts') return { name: 'kotlin-script' };
  return null;
}

// Query-pattern index -> symbol_kind, in the same order the four patterns
// are declared in kotlin-symbols.scm (class, interface, object, function).
const SYMBOL_KIND_BY_PATTERN_INDEX = ['class', 'interface', 'object', 'function'];

function declaredPackage(rootNode) {
  const match = queries.package.matches(rootNode)[0];
  const nameNode = match?.captures.find((capture) => capture.name === 'package.name')?.node;
  return nameNode ? nameNode.text : '';
}

function scanCode(lines, ctx, grammar) {
  const facts = [];
  const text = lines.join('\n');
  const parser = parserFor();
  return usingParsedTree(parser, text, (tree) => {
    const pkg = declaredPackage(tree.rootNode);
    facts.push(ctx.fact('module', 1, { language: grammar.name, package: pkg, end_line: Math.max(1, lines.length) }));

    for (const match of queries.imports.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const fqnNode = byName['import.fqn'];
      if (!fqnNode) continue;
      const isWildcard = Boolean(byName['import.wildcard']);
      facts.push(ctx.fact('import', fqnNode.startPosition.row + 1, {
        specifier: isWildcard ? `${fqnNode.text}.*` : fqnNode.text,
        is_wildcard: isWildcard,
        column: fqnNode.startPosition.column + 1,
      }));
    }

    for (const match of queries.symbols.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const nameNode = byName['symbol.name'];
      if (!nameNode) continue;
      const symbolKind = SYMBOL_KIND_BY_PATTERN_INDEX[match.pattern] || 'unknown';
      facts.push(ctx.fact('symbol', nameNode.startPosition.row + 1, {
        name: nameNode.text,
        symbol_kind: symbolKind,
        column: nameNode.startPosition.column + 1,
      }));
    }

    return facts;
  });
}

export default {
  kind: 'treesitter_kotlin',
  filePattern: /\.kts?$/i,
  scan(lines, ctx) {
    const grammar = grammarFor(ctx.file);
    if (!grammar) return [];
    return scanCode(lines, ctx, grammar);
  },
};
