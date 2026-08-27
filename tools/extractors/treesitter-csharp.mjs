// AST-based C#/.NET extractor (web-tree-sitter, WASM), mirroring
// treesitter-js.mjs's structure and treesitter-swift.mjs's file-to-file
// coupling strategy for a language with NO per-file import between files
// of the same project.
//
// C# is architecturally like Swift/Kotlin, not JS/TS, in the load-bearing
// way that matters for cross-file coupling: `using X.Y;` names a NAMESPACE,
// not a file, and every file that declares (or is in scope for) namespace
// X.Y sees every OTHER file's types in that namespace with no import
// between them. Multiple files routinely share one namespace with no
// `using` between them at all. So file-to-file coupling can only be
// recovered by resolving TYPE REFERENCES (base lists, field/property/
// param/return types) against a project-wide namespace+type symbol table,
// informed by each referencing file's in-scope namespaces (its own declared
// namespace(s) plus its plain `using` targets) -- see merge.mjs's C#
// resolution pass. This extractor emits FIVE fact kinds:
//   - 'module'    one per .cs file (same convention as treesitter-js.mjs).
//   - 'namespace' one per namespace declared in the file (block-scoped or
//                 file-scoped), carrying its full dotted name.
//   - 'import'    one per `using` directive (plain/static/global/aliased),
//                 carrying the target namespace/type text and the
//                 static/global/alias flags merge.mjs needs to decide
//                 whether it widens the referencing file's in-scope
//                 namespace set.
//   - 'symbol'    one per top-level declared class/struct/interface/enum/
//                 record, carrying its fully-qualified enclosing namespace.
//   - 'reference' one per used type name in a base list or a field/
//                 property/parameter/return type annotation -- what
//                 merge.mjs resolves against the project-wide symbol table.
//
// READ-ONLY / NO-EXEC / NO-NETWORK: same guarantee as treesitter-js.mjs --
// this module only parses text already read and secret-redacted by
// extract.mjs, never requires/imports/evals the scanned repository's own
// code, spawns no child process, and performs no network I/O. The only I/O
// here is the local filesystem reads of (a) the pinned `tree-sitter-wasms`
// grammar WASM (via treesitter/loader.mjs, already a dependency for JS/TS/
// Swift/Kotlin) and (b) the four committed .scm query files below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languages, TreeSitter } from '../treesitter/loader.mjs';
import { usingParsedTree } from './treesitter-js.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '..', 'treesitter', 'queries');
const namespaceQuerySource = fs.readFileSync(path.join(queriesDir, 'csharp-namespaces.scm'), 'utf8');
const importQuerySource = fs.readFileSync(path.join(queriesDir, 'csharp-imports.scm'), 'utf8');
const symbolQuerySource = fs.readFileSync(path.join(queriesDir, 'csharp-symbols.scm'), 'utf8');
const referenceQuerySource = fs.readFileSync(path.join(queriesDir, 'csharp-references.scm'), 'utf8');

const parser = new TreeSitter();
parser.setLanguage(languages.csharp);

const queries = {
  namespaces: languages.csharp.query(namespaceQuerySource),
  imports: languages.csharp.query(importQuerySource),
  symbols: languages.csharp.query(symbolQuerySource),
  references: languages.csharp.query(referenceQuerySource),
};

// Pattern-index -> symbol_kind, in the exact order the 15 patterns are
// declared in csharp-symbols.scm (5 kinds x 3 enclosing contexts).
const SYMBOL_KINDS = ['class', 'struct', 'interface', 'enum', 'record'];
const SYMBOL_KIND_BY_PATTERN_INDEX = [...SYMBOL_KINDS, ...SYMBOL_KINDS, ...SYMBOL_KINDS];

const NAMESPACE_NODE_TYPES = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);

// Walks a node's ancestor chain (namespace_declaration/file_scoped_namespace_
// declaration nodes may nest arbitrarily deep) collecting each enclosing
// namespace's own `name` field, innermost-last, then joins them dotted. When
// invoked on a namespace declaration node itself, its own name is included
// (the walk starts at `node`, not `node.parent`); when invoked on a symbol's
// decl node (never itself a namespace type), only its ancestors contribute.
function namespaceFqn(node) {
  const segments = [];
  let current = node;
  while (current) {
    if (NAMESPACE_NODE_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name');
      if (nameNode) segments.unshift(nameNode.text);
    }
    current = current.parent;
  }
  return segments.join('.');
}

// The plain dotted type name (no generic `<...>` suffix) for an identifier/
// qualified_name/generic_name node. `qualified_name` exposes NO `left`/
// `right` fields on this bundled grammar (verified directly -- unlike
// class_declaration/property_declaration/etc., which do carry fields), so
// its two named children are read positionally: namedChild(0) is the
// qualifier, namedChild(1) is the final segment (itself possibly a
// `generic_name`, e.g. `System.Collections.Generic.List<Foo>` parses as
// qualified_name(qualified_name(...), generic_name(List, <Foo>))).
function baseNameText(node) {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'generic_name') return baseNameText(node.namedChild(0));
  if (node.type === 'qualified_name') return `${baseNameText(node.namedChild(0))}.${baseNameText(node.namedChild(1))}`;
  return node.text;
}

// Walks a type-annotation node's shape (unwrapping nullable/array/pointer/
// tuple, flattening qualified names, descending into generic type
// arguments) collecting one reference per named type occurrence.
// `predefined_type` (built-in keyword types: string/int/bool/void/...) is
// skipped entirely -- never a resolvable project reference, and including
// it would swamp every field/property/param/return type with noise no
// resolver could ever usefully classify.
function collectTypeReferences(node, refs) {
  if (!node) return;
  switch (node.type) {
    case 'predefined_type':
      return;
    case 'identifier':
      refs.push({ name: node.text, node });
      return;
    case 'qualified_name': {
      refs.push({ name: baseNameText(node), node });
      const right = node.namedChild(1);
      if (right && right.type === 'generic_name') {
        const typeArgs = right.namedChildren.find((child) => child.type === 'type_argument_list');
        if (typeArgs) for (const argument of typeArgs.namedChildren) collectTypeReferences(argument, refs);
      }
      return;
    }
    case 'generic_name': {
      refs.push({ name: baseNameText(node), node });
      const typeArgs = node.namedChildren.find((child) => child.type === 'type_argument_list');
      if (typeArgs) for (const argument of typeArgs.namedChildren) collectTypeReferences(argument, refs);
      return;
    }
    case 'nullable_type':
    case 'pointer_type':
    case 'array_type':
      collectTypeReferences(node.namedChild(0), refs);
      return;
    case 'tuple_type':
      for (const element of node.namedChildren) if (element.type === 'tuple_element') collectTypeReferences(element.namedChild(0), refs);
      return;
    default:
      return;
  }
}

// `using_directive` exposes no named fields for its static/global/alias/
// target shape on this bundled grammar (verified directly, same "no field
// metadata" situation kotlin-symbols.scm documents for tree-sitter-kotlin)
// -- every variant is disambiguated by scanning direct children structurally.
function analyzeUsingDirective(node) {
  let isStatic = false;
  let isGlobal = false;
  let alias = null;
  let targetNode = null;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child.type === 'static') isStatic = true;
    else if (child.type === 'global') isGlobal = true;
    else if (child.type === 'name_equals') alias = child.namedChild(0)?.text || null;
    else if (child.type === 'identifier' || child.type === 'qualified_name') targetNode = child;
  }
  return { isStatic, isGlobal, alias, targetNode };
}

function scanCode(lines, ctx) {
  const facts = [];
  const text = lines.join('\n');
  facts.push(ctx.fact('module', 1, { language: 'csharp', end_line: Math.max(1, lines.length) }));

  return usingParsedTree(parser, text, (tree) => {
    for (const match of queries.namespaces.matches(tree.rootNode)) {
      const nsNode = match.captures.find((capture) => capture.name === 'namespace.decl')?.node;
      if (!nsNode) continue;
      facts.push(ctx.fact('namespace', nsNode.startPosition.row + 1, { name: namespaceFqn(nsNode) }));
    }

    for (const match of queries.imports.matches(tree.rootNode)) {
      const directiveNode = match.captures.find((capture) => capture.name === 'import.directive')?.node;
      if (!directiveNode) continue;
      const { isStatic, isGlobal, alias, targetNode } = analyzeUsingDirective(directiveNode);
      if (!targetNode) continue;
      facts.push(ctx.fact('import', targetNode.startPosition.row + 1, {
        target: targetNode.text,
        is_static: isStatic,
        is_global: isGlobal,
        alias,
        column: targetNode.startPosition.column + 1,
      }));
    }

    for (const match of queries.symbols.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const nameNode = byName['symbol.name'];
      const declNode = byName['symbol.decl'];
      if (!nameNode || !declNode) continue;
      const symbolKind = SYMBOL_KIND_BY_PATTERN_INDEX[match.pattern] || 'unknown';
      facts.push(ctx.fact('symbol', nameNode.startPosition.row + 1, {
        name: nameNode.text,
        symbol_kind: symbolKind,
        namespace: namespaceFqn(declNode),
        column: nameNode.startPosition.column + 1,
      }));
    }

    for (const match of queries.references.matches(tree.rootNode)) {
      const typeNode = match.captures.find((capture) => capture.name === 'reference.type')?.node;
      if (!typeNode) continue;
      const refs = [];
      collectTypeReferences(typeNode, refs);
      for (const reference of refs) {
        facts.push(ctx.fact('reference', reference.node.startPosition.row + 1, {
          name: reference.name,
          column: reference.node.startPosition.column + 1,
        }));
      }
    }

    return facts;
  });
}

export default {
  kind: 'treesitter_csharp',
  filePattern: /\.cs$/i,
  scan(lines, ctx) {
    return scanCode(lines, ctx);
  },
};
