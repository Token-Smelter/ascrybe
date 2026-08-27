// AST-based JavaScript/TypeScript/TSX extractor (web-tree-sitter, WASM).
//
// Replaces per-line regex scanning for code structure with real parsing:
// emits one 'module' fact per source file, one 'import' fact per
// import/require/dynamic-import/re-export (raw specifier, precise
// file+line[:col] span), and one 'symbol' fact per top-level exported
// function/class/const declaration. Also emits 'ts_path_alias' facts from
// tsconfig.json/jsconfig.json `compilerOptions.paths`, consumed by the
// import-resolution pass in merge.mjs.
//
// READ-ONLY / NO-EXEC / NO-NETWORK (AC-READONLY-NOEXEC-NONET): this module
// only parses text already read and secret-redacted by extract.mjs
// (extract.mjs:27-32 secretPattern blanking) before scan() ever sees it; it
// never requires/imports/evals the scanned repository's own code, spawns no
// child process, and performs no network I/O. The only I/O here is the local
// filesystem reads of the (a) pinned grammar WASM files (treesitter/loader.mjs)
// and (b) the two committed .scm query files below — both resolved from
// local disk paths, never a URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { languages, TreeSitter } from '../treesitter/loader.mjs';
import { scanLiteralValues, scanPredicateLiterals, scanThrowSites } from './literal-values.mjs';
import { scanModuleHeader, scanPersistence } from './persistence.mjs';
import { scanToolRegistrations } from './tool-registrations.mjs';
import { scanJsDeclarationComments } from './declaration-comments.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesDir = path.join(here, '..', 'treesitter', 'queries');
const importQuerySource = fs.readFileSync(path.join(queriesDir, 'imports.scm'), 'utf8');
const symbolQuerySource = fs.readFileSync(path.join(queriesDir, 'symbols.scm'), 'utf8');
const inlineSymbolQuerySource = fs.readFileSync(path.join(queriesDir, 'inline-symbols.scm'), 'utf8');

const parserCache = new Map();
function parserFor(language) {
  if (!parserCache.has(language)) {
    const parser = new TreeSitter();
    parser.setLanguage(language);
    parserCache.set(language, parser);
  }
  return parserCache.get(language);
}

const queryCache = new Map();
function queriesFor(language) {
  if (!queryCache.has(language)) {
    queryCache.set(language, {
      imports: language.query(importQuerySource),
      symbols: language.query(symbolQuerySource),
      inlineSymbols: language.query(inlineSymbolQuerySource),
    });
  }
  return queryCache.get(language);
}

function grammarFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tsx') return { name: 'tsx', language: languages.tsx };
  if (ext === '.ts') return { name: 'typescript', language: languages.typescript };
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return { name: 'javascript', language: languages.javascript };
  return null;
}

const JAVASCRIPT_MIME_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript',
]);

const positionAt = (text, offset) => {
  const prefix = text.slice(0, offset);
  const newline = prefix.lastIndexOf('\n');
  return {
    line: (prefix.match(/\n/g) || []).length + 1,
    column: Buffer.byteLength(prefix.slice(newline + 1), 'utf8') + 1,
  };
};

const SYMBOL_KIND_BY_NODE_TYPE = {
  function_declaration: 'function',
  class_declaration: 'class',
  lexical_declaration: 'const',
  variable_declaration: 'variable',
  method_definition: 'method',
};

// Containers a declaration may sit inside while still having an unambiguous
// name path: the module root, an export wrapper, and a class body (which is the
// single body of its class). Any other ancestor — a function body, arrow, loop,
// or bare block — is an anonymous binding scope, so two same-named declarations
// under it can only be told apart positionally. Those are emitted as facts but
// carry no scope_path and are therefore never identity candidates.
const SCOPE_PATH_TRANSPARENT = new Set(['export_statement', 'class_body']);

export function scopePathFor(declNode, name) {
  const path = [name];
  let node = declNode?.parent;
  while (node) {
    if (node.type === 'program') return path;
    if (SCOPE_PATH_TRANSPARENT.has(node.type)) { node = node.parent; continue; }
    if (node.type === 'class_declaration') {
      const className = node.childForFieldName('name');
      if (!className) return null;
      path.unshift(className.text);
      node = node.parent;
      continue;
    }
    return null;
  }
  return null;
}

export function usingParsedTree(parser, text, visit) {
  const tree = parser.parse(text);
  try {
    return visit(tree);
  } finally {
    tree.delete();
  }
}

function scanCode(lines, ctx, grammar, { onSyntaxError = null, includeLocalSymbols = false } = {}) {
  const facts = [];
  const text = lines.join('\n');
  facts.push(ctx.fact('module', 1, { language: grammar.name, end_line: Math.max(1, lines.length) }));
  // F3's prose half: a module that states its own storage root in its header
  // comment (workOrder.mjs:1) is declaring a persistence target, and the
  // orientation test turned on exactly that line.
  facts.push(...scanModuleHeader(lines, ctx));

  const parser = parserFor(grammar.language);
  return usingParsedTree(parser, text, (tree) => {
    if (onSyntaxError && tree.rootNode.hasError()) return onSyntaxError();
    const { imports, symbols, inlineSymbols } = queriesFor(grammar.language);

    for (const match of imports.matches(tree.rootNode)) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const specifierNode = byName['import.specifier'];
      if (!specifierNode) continue;
      let importKind;
      if (byName['import.statement']) importKind = 'import';
      else if (byName['import.reexport']) importKind = 're-export';
      else if (byName['import.call']) {
        if (!byName['import.call_name'] || byName['import.call_name'].text !== 'require') continue;
        importKind = 'require';
      } else if (byName['import.dynamic']) importKind = 'dynamic-import';
      else continue;
      facts.push(ctx.fact('import', specifierNode.startPosition.row + 1, {
        specifier: specifierNode.text,
        import_kind: importKind,
        column: specifierNode.startPosition.column + 1,
      }));
    }

    const symbolMatches = symbols.matches(tree.rootNode)
      .concat(includeLocalSymbols ? inlineSymbols.matches(tree.rootNode) : []);
    const seenSymbols = new Set();
    for (const match of symbolMatches) {
      const byName = Object.fromEntries(match.captures.map((capture) => [capture.name, capture.node]));
      const nameNode = byName['symbol.name'];
      const declNode = byName['symbol.decl'];
      if (!nameNode || !declNode) continue;
      const symbolKey = `${nameNode.startIndex}\0${nameNode.endIndex}\0${nameNode.text}`;
      if (seenSymbols.has(symbolKey)) continue;
      seenSymbols.add(symbolKey);
      const declaration = declNode.type === 'export_statement'
        ? declNode.childForFieldName('declaration') : declNode;
      const symbolKind = declaration ? (SYMBOL_KIND_BY_NODE_TYPE[declaration.type] || declaration.type) : 'unknown';
      const scopePath = scopePathFor(declNode, nameNode.text);
      facts.push(ctx.fact('symbol', nameNode.startPosition.row + 1, {
        name: nameNode.text,
        symbol_kind: symbolKind,
        column: nameNode.startPosition.column + 1,
        ...(scopePath ? { scope_path: scopePath } : {}),
      }));
    }

    // F1 (+F1b). Literal-value retention rides the SAME parse as imports and
    // symbols rather than re-parsing every JS file in a second extractor: the
    // orientation-test gap is that the map records where a symbol is and not
    // what it equals, and both halves come off one tree.
    facts.push(...scanLiteralValues(tree.rootNode, ctx));
    facts.push(...scanPredicateLiterals(tree.rootNode, ctx));
    facts.push(...scanThrowSites(tree.rootNode, ctx));
    // F3 + F6 ride the same parse for the same reason.
    facts.push(...scanPersistence(tree.rootNode, ctx));
    facts.push(...scanToolRegistrations(tree.rootNode, ctx));
    facts.push(...scanJsDeclarationComments(tree.rootNode, ctx));

    return facts;
  });
}

function parseStartTag(text, start) {
  let cursor = start + '<script'.length;
  let quote = null;
  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') break;
    else if (character === '<') return { error: 'malformed_start_tag', end: cursor };
  }
  if (cursor >= text.length || quote) return { error: 'unterminated_start_tag', end: text.length };

  const source = text.slice(start + '<script'.length, cursor);
  const selfClosing = /\/\s*$/u.test(source);
  const attributes = new Map();
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] || '')) index += 1;
    if (index >= source.length || (source[index] === '/' && /^\/\s*$/u.test(source.slice(index)))) break;
    const nameMatch = /^[^\s"'<>/=]+/u.exec(source.slice(index));
    if (!nameMatch) return { error: 'malformed_attribute', end: cursor + 1 };
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    while (/\s/u.test(source[index] || '')) index += 1;
    let value = null;
    if (source[index] === '=') {
      index += 1;
      while (/\s/u.test(source[index] || '')) index += 1;
      const delimiter = source[index];
      if (delimiter === '"' || delimiter === "'") {
        index += 1;
        const end = source.indexOf(delimiter, index);
        if (end < 0) return { error: 'unterminated_attribute_value', end: cursor + 1 };
        value = source.slice(index, end);
        index = end + 1;
      } else {
        const valueMatch = /^[^\s"'`=<>]+/u.exec(source.slice(index));
        if (!valueMatch) return { error: 'malformed_attribute_value', end: cursor + 1 };
        value = valueMatch[0];
        index += value.length;
      }
    }
    if (attributes.has(name)) return { error: 'duplicate_attribute', end: cursor + 1, attribute: name };
    attributes.set(name, value);
  }
  return { attributes, selfClosing, end: cursor + 1 };
}

function findEndTag(text, start) {
  const lower = text.toLowerCase();
  let cursor = start;
  while ((cursor = lower.indexOf('</script', cursor)) >= 0) {
    const boundary = text[cursor + '</script'.length];
    if (boundary !== undefined && !/[\s>/]/u.test(boundary)) {
      cursor += 2;
      continue;
    }
    const match = /^<\/script\s*>/iu.exec(text.slice(cursor));
    if (match) return { start: cursor, end: cursor + match[0].length };
    return null;
  }
  return null;
}

function nextTagEnd(text, start) {
  let quote = null;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return cursor + 1;
  }
  return text.length;
}

function htmlScriptElements(text) {
  const elements = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (!/^<script(?=[\s/>])/iu.test(text.slice(open))) {
      const rawText = /^<(style|textarea|title|xmp|iframe|noembed|noframes)(?=[\s/>])/iu.exec(text.slice(open));
      if (rawText) {
        const startEnd = nextTagEnd(text, open + 1);
        const close = new RegExp(`<\\/${rawText[1]}\\s*>`, 'iu').exec(text.slice(startEnd));
        if (!close) break;
        cursor = startEnd + Number(close.index) + close[0].length;
      } else cursor = nextTagEnd(text, open + 1);
      continue;
    }
    const startTag = parseStartTag(text, open);
    if (startTag.error) {
      elements.push({ start: open, end: startTag.end, refusal: startTag.error,
        detail: startTag.attribute || null });
      break;
    }
    if (startTag.selfClosing) {
      elements.push({ start: open, end: startTag.end, attributes: startTag.attributes,
        refusal: 'self_closing_script_element' });
      cursor = startTag.end;
      continue;
    }
    const endTag = findEndTag(text, startTag.end);
    if (!endTag) {
      elements.push({ start: open, end: text.length, attributes: startTag.attributes,
        contentStart: startTag.end, refusal: 'unterminated_script_element' });
      break;
    }
    elements.push({ start: open, end: endTag.end, attributes: startTag.attributes,
      contentStart: startTag.end, contentEnd: endTag.start, refusal: null });
    cursor = endTag.end;
  }
  return elements;
}

function mapLineFields(value, lineOffset) {
  if (Array.isArray(value)) return value.map(item => mapLineFields(item, lineOffset));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, held]) => {
    if (['line', 'call_line', 'end_line'].includes(key) && Number.isInteger(held)) {
      return [key, held + lineOffset];
    }
    if (key === 'code_source' && typeof held === 'string' && /^assignment@\d+$/u.test(held)) {
      return [key, `assignment@${Number(held.slice('assignment@'.length)) + lineOffset}`];
    }
    return [key, mapLineFields(held, lineOffset)];
  }));
}

function scriptFact(ctx, kind, element, text, data) {
  const start = positionAt(text, element.start);
  const end = positionAt(text, element.end);
  return ctx.fact(kind, start.line, {
    ...data,
    source_span: {
      file: ctx.file,
      start: { line: start.line, column: start.column },
      end: { line: end.line, column: end.column },
    },
  });
}

function scanHtml(lines, ctx) {
  const text = lines.join('\n');
  const facts = [];
  for (const element of htmlScriptElements(text)) {
    const typePresent = element.attributes?.has('type') || false;
    const type = element.attributes?.get('type');
    const normalizedType = typePresent ? (type ?? '').trim().toLowerCase() : null;
    const hasSrc = element.attributes?.has('src') || false;
    const body = element.contentStart == null ? '' : text.slice(element.contentStart, element.contentEnd);
    let refusal = element.refusal;
    if (!refusal && typePresent && type === null) {
      refusal = 'invalid_script_type_attribute';
    } else if (!refusal && normalizedType && normalizedType !== 'module' && !JAVASCRIPT_MIME_TYPES.has(normalizedType)) {
      refusal = 'non_javascript_script_type';
    } else if (!refusal && hasSrc && !body.trim()) {
      refusal = 'src_only_script_element';
    } else if (!refusal && hasSrc) {
      refusal = 'src_attribute_with_inline_content';
    } else if (!refusal && !body.trim()) {
      refusal = 'empty_inline_script';
    }
    if (refusal) {
      facts.push(scriptFact(ctx, 'inline_script_refusal', element, text, {
        disposition: 'refused', refusal,
        script_type: normalizedType,
        has_src: hasSrc,
        detail: element.detail || null,
      }));
      continue;
    }

    const bodyStart = positionAt(text, element.contentStart);
    const bodyEnd = positionAt(text, element.contentEnd);
    const lineOffset = bodyStart.line - 1;
    const localCtx = {
      ...ctx,
      fact(kind, line, data) {
        const mapped = mapLineFields(data, lineOffset);
        if (Number.isInteger(mapped.column) && line === 1) mapped.column += bodyStart.column - 1;
        const mappedLine = line + lineOffset;
        return ctx.fact(kind, mappedLine, {
          ...mapped,
          source_span: { file: ctx.file, start: mappedLine, end: mappedLine },
          script_element_span: {
            start: positionAt(text, element.start),
            end: positionAt(text, element.end),
          },
        });
      },
    };
    const parsed = scanCode(body.split('\n'), localCtx,
      { name: normalizedType === 'module' ? 'javascript-module' : 'javascript', language: languages.javascript }, {
        includeLocalSymbols: true,
        onSyntaxError: () => [scriptFact(ctx, 'inline_script_refusal', element, text, {
          disposition: 'refused', refusal: 'javascript_parse_error',
          script_type: normalizedType, has_src: false,
        })],
      });
    const refused = parsed.length === 1 && parsed[0].kind === 'inline_script_refusal';
    if (refused) facts.push(...parsed);
    else {
      facts.push(scriptFact(ctx, 'inline_script', element, text, {
        disposition: 'parsed', language: 'javascript', script_type: normalizedType,
        content_span: { file: ctx.file, start: bodyStart, end: bodyEnd },
      }));
      facts.push(...parsed);
    }
  }
  return facts;
}

const TSCONFIG_PATTERN = /(?:^|\/)(?:tsconfig(?:\.[\w.-]+)?|jsconfig)\.json$/i;

function scanTsconfig(lines, ctx) {
  const facts = [];
  let parsed;
  try {
    parsed = JSON5.parse(lines.join('\n'));
  } catch (error) {
    ctx.parseErrors.push({ file: ctx.file, error: error.message });
    return facts;
  }
  const compilerOptions = parsed.compilerOptions || {};
  const baseUrl = compilerOptions.baseUrl || '.';
  const configDir = path.posix.dirname(ctx.file);
  const baseDir = path.posix.normalize(path.posix.join(configDir === '.' ? '' : configDir, baseUrl)) || '.';
  for (const [pattern, targets] of Object.entries(compilerOptions.paths || {})) {
    const line = Math.max(1, lines.findIndex((value) => value.includes(`"${pattern}"`)) + 1);
    facts.push(ctx.fact('ts_path_alias', line, {
      pattern,
      targets: [...targets].sort(),
      base_dir: baseDir === '' ? '.' : baseDir,
    }));
  }
  return facts;
}

export default {
  kind: 'treesitter_js',
  filePattern: /\.(?:m?[jt]sx?|cjs|html?)$|(?:^|\/)(?:tsconfig(?:\.[\w.-]+)?|jsconfig)\.json$/i,
  scan(lines, ctx) {
    if (/\.html?$/i.test(ctx.file)) return scanHtml(lines, ctx);
    if (TSCONFIG_PATTERN.test(ctx.file)) return scanTsconfig(lines, ctx);
    const grammar = grammarFor(ctx.file);
    if (!grammar) return [];
    return scanCode(lines, ctx, grammar);
  },
};
