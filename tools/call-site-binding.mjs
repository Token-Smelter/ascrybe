// Deterministic call-site binding from tree-sitter syntax and supplied source bytes.
// It deliberately emits a refusal rather than infer an edge from a name or path.
import path from 'node:path';
import { languages, TreeSitter } from './treesitter/loader.mjs';
import { normalizePath } from './lib.mjs';

export const PRODUCER = 'call-site-binding@1';
export const SCHEMA = 'estate-map/call-site-binding/v1';
export const CALL_STATUSES = Object.freeze(['resolved', 'ambiguous', 'unresolved']);
export const UNRESOLVED_REASONS = Object.freeze([
  'dynamic_dispatch', 'computed_member', 'external_module', 're_export_chain',
  'commonjs_interop', 'namespace_import', 'module_resolution_ambiguous',
  'unsupported_grammar', 'parse_failed', 'new_expression', 'unbound_identifier',
  'method_call_on_local', 'shadowed_by_non_function_binding', 'assigned_binding',
]);
const GRAMMARS = Object.freeze({
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
});
const FUNCTION_TYPES = new Set(['function_declaration', 'function_expression', 'function', 'arrow_function', 'generator_function', 'generator_function_declaration']);
const FUNCTION_SCOPE_TYPES = new Set([...FUNCTION_TYPES, 'method_definition']);
const SCOPE_TYPES = new Set(['program', 'statement_block', 'class_body', 'catch_clause', 'switch_statement', 'for_statement', 'for_in_statement', 'for_of_statement', ...FUNCTION_SCOPE_TYPES]);
const parserCache = new Map();
const grammarFor = file => GRAMMARS[path.extname(String(file)).toLowerCase()] || null;
const field = (node, name) => node?.childForFieldName?.(name) || null;
const textOf = node => node?.text || '';
const lineOf = node => node.startPosition.row + 1;
const collapse = value => String(value || '').replace(/\s+/g, ' ').trim();
function codePointCompare(left, right) {
  const leftPoints = Array.from(String(left));
  const rightPoints = Array.from(String(right));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
export const callReceiptId = (file, start) => `call-binding:${normalizePath(file)}:${start}`;
export const sourceByteOffset = (text, characterOffset) => Buffer.byteLength(String(text).slice(0, characterOffset));
function parserFor(grammar) {
  if (!parserCache.has(grammar)) {
    const parser = new TreeSitter();
    parser.setLanguage(languages[grammar]);
    parserCache.set(grammar, parser);
  }
  return parserCache.get(grammar);
}
function walk(node, visit) {
  visit(node);
  for (let index = 0; index < node.namedChildCount; index += 1) walk(node.namedChild(index), visit);
}
function quotedSpecifier(node) {
  const value = textOf(node);
  return value.length >= 2 ? value.slice(1, -1) : value;
}
function patternNames(node, names = []) {
  if (!node) return names;
  if (node.type === 'identifier') { names.push(node); return names; }
  if (node.type === 'pair_pattern') return patternNames(field(node, 'value') || node.namedChild(node.namedChildCount - 1), names);
  if (node.type === 'assignment_pattern' || node.type === 'default_parameter') return patternNames(field(node, 'left') || field(node, 'name') || node.namedChild(0), names);
  if (node.type === 'rest_pattern') return patternNames(field(node, 'argument') || node.namedChild(0), names);
  if (node.type === 'shorthand_property_identifier_pattern') { names.push(node); return names; }
  for (const child of node.namedChildren) patternNames(child, names);
  return names;
}
function scopeModel(root, file) {
  const scopes = [];
  walk(root, node => {
    if (!SCOPE_TYPES.has(node.type)) return;
    scopes.push({ bindings: new Map(), end: node.endIndex, node, parent: null, start: node.startIndex, type: node.type });
  });
  const scopeAt = position => scopes.filter(scope => scope.start <= position && position < scope.end)
    .sort((left, right) => right.start - left.start || left.end - right.end)[0] || null;
  for (const scope of scopes) {
    const parentStart = scope.node.parent?.startIndex ?? -1;
    scope.parent = scopes.filter(candidate => candidate !== scope && candidate.start <= parentStart && parentStart < candidate.end)
      .sort((left, right) => right.start - left.start || left.end - right.end)[0] || null;
  }
  const outerScope = node => {
    const parentStart = node.parent?.startIndex ?? -1;
    return scopes.filter(scope => scope.start <= parentStart && parentStart < scope.end &&
      (scope.start !== node.startIndex || scope.end !== node.endIndex || scope.type !== node.type))
      .sort((left, right) => right.start - left.start || left.end - right.end)[0] || null;
  };
  const functionScope = node => {
    let scope = scopeAt(node.startIndex);
    while (scope && scope.type !== 'program' && !FUNCTION_SCOPE_TYPES.has(scope.type)) scope = scope.parent;
    return scope;
  };
  const add = (scope, nameNode, kind, declaration = null, importBinding = null, details = {}) => {
    if (!scope || !nameNode) return;
    const name = textOf(nameNode);
    if (!name) return;
    const item = { assigned: false, declaration, importBinding, kind, name, node: nameNode, scope, ...details };
    const entries = scope.bindings.get(name) || [];
    entries.push(item);
    scope.bindings.set(name, entries);
  };
  const variableScope = node => {
    const declaration = node.parent;
    return /^var\b/.test(textOf(declaration).trim()) ? functionScope(node) : scopeAt(node.startIndex);
  };
  const functionDeclarationScope = node => {
    const scope = outerScope(node);
    const body = field(scope?.node.parent, 'body');
    if (scope?.type === 'statement_block' && FUNCTION_SCOPE_TYPES.has(scope.node.parent?.type) && body?.startIndex === scope.start && body.endIndex === scope.end) return scope.parent;
    return scope;
  };
  walk(root, node => {
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      const name = field(node, 'name');
      add(functionDeclarationScope(node), name, 'function', node, null, { source: 'function_declaration' });
      const scope = scopeAt(node.startIndex);
      for (const parameter of field(node, 'parameters')?.namedChildren || []) {
        for (const nameNode of patternNames(parameter)) add(scope, nameNode, 'non_function');
      }
      return;
    }
    if (FUNCTION_TYPES.has(node.type) || node.type === 'method_definition') {
      const scope = scopeAt(node.startIndex);
      const parameters = field(node, 'parameters')?.namedChildren || [field(node, 'parameter')].filter(Boolean);
      for (const parameter of parameters) {
        for (const nameNode of patternNames(parameter)) add(scope, nameNode, 'non_function');
      }
      if (node.type === 'function_expression' || node.type === 'function') {
        const name = field(node, 'name');
        if (name) add(scope, name, 'function', node);
      }
      return;
    }
    if (node.type === 'class_declaration') {
      add(outerScope(node), field(node, 'name'), 'non_function');
      return;
    }
    if (node.type === 'variable_declarator') {
      const name = field(node, 'name');
      const value = field(node, 'value');
      const kind = name?.type === 'identifier' && value && FUNCTION_TYPES.has(value.type) ? 'function' : 'non_function';
      const source = /^var\b/.test(textOf(node.parent).trim()) ? 'var' : 'lexical';
      for (const nameNode of patternNames(name)) add(variableScope(node), nameNode, kind, value || node, null, { initialized: Boolean(value), source });
      return;
    }
    if (node.type === 'catch_clause') {
      for (const nameNode of patternNames(field(node, 'parameter'))) add(scopeAt(node.startIndex), nameNode, 'non_function');
      return;
    }
    if (node.type === 'for_in_statement' || node.type === 'for_of_statement') {
      const declared = textOf(node).match(/^for\s*\(\s*(var|let|const)\b/);
      if (declared) {
        const scope = declared[1] === 'var' ? functionScope(node) : scopeAt(node.startIndex);
        for (const nameNode of patternNames(field(node, 'left'))) add(scope, nameNode, 'non_function');
      }
      return;
    }
    if (node.type === 'import_statement') {
      const scope = scopeAt(node.startIndex);
      const source = node.namedChildren.find(child => ['string', 'string_fragment'].includes(child.type));
      if (!source) return;
      const specifier = quotedSpecifier(source);
      walk(node, child => {
        if (child.type === 'import_specifier') {
          const imported = field(child, 'name') || child.namedChild(0);
          const alias = field(child, 'alias') || child.namedChild(child.namedChildCount - 1);
          add(scope, alias, 'import', null, { imported: textOf(imported), kind: 'named', specifier });
        }
      });
      const clause = node.namedChildren.find(child => child.type === 'import_clause');
      for (const child of clause?.namedChildren || []) {
        if (child.type === 'identifier') add(scope, child, 'import', null, { imported: 'default', kind: 'default', specifier });
        if (child.type === 'namespace_import') {
          const local = child.namedChildren.find(inner => inner.type === 'identifier');
          add(scope, local, 'import', null, { imported: '*', kind: 'namespace', specifier });
        }
      }
    }
  });
  for (const scope of scopes) {
    for (const [name, entries] of scope.bindings) {
      const functionDeclarations = entries.filter(entry => entry.source === 'function_declaration');
      const varDeclarations = entries.filter(entry => entry.source === 'var');
      if (!functionDeclarations.length || !varDeclarations.length) continue;
      if (varDeclarations.some(entry => entry.initialized)) {
        for (const entry of entries) entry.assigned = true;
      } else {
        scope.bindings.set(name, entries.filter(entry => entry.source !== 'var'));
      }
    }
  }
  const bindingFor = (position, name) => {
    for (let scope = scopeAt(position); scope; scope = scope.parent) {
      const bindings = scope.bindings.get(name);
      if (bindings?.length) return bindings;
    }
    return [];
  };
  const assignmentTargetNames = (node, names = []) => {
    if (!node || node.type === 'member_expression' || node.type === 'subscript_expression') return names;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') { names.push(node); return names; }
    if (node.type === 'pair_pattern') return assignmentTargetNames(field(node, 'value') || node.namedChild(node.namedChildCount - 1), names);
    if (node.type === 'assignment_pattern' || node.type === 'default_parameter') return assignmentTargetNames(field(node, 'left') || field(node, 'name') || node.namedChild(0), names);
    if (node.type === 'rest_pattern') return assignmentTargetNames(field(node, 'argument') || node.namedChild(0), names);
    for (const child of node.namedChildren) assignmentTargetNames(child, names);
    return names;
  };
  const markAssigned = target => {
    for (const nameNode of assignmentTargetNames(target)) {
      for (const binding of bindingFor(nameNode.startIndex, textOf(nameNode))) binding.assigned = true;
    }
  };
  walk(root, node => {
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') markAssigned(field(node, 'left') || node.namedChild(0));
    if (node.type === 'update_expression') markAssigned(field(node, 'argument') || node.namedChild(0));
    if ((node.type === 'for_in_statement' || node.type === 'for_of_statement') && !/^for\s*\(\s*(?:var|let|const)\b/.test(textOf(node))) markAssigned(field(node, 'left'));
  });
  return { bindingFor, scopes };
}
function functionDeclarations(root, file, scope) {
  const declarations = [];
  for (const item of scope.scopes.flatMap(entry => [...entry.bindings.values()].flat())) {
    if (item.kind !== 'function' || !item.declaration) continue;
    declarations.push({
      declaration: { end: item.declaration.endIndex, file, line: lineOf(item.node), start: item.declaration.startIndex, text: collapse(textOf(item.declaration)).slice(0, 240), type: item.declaration.type },
      item,
      name: item.name,
    });
  }
  return declarations;
}
function commonJsBindings(root, scope) {
  walk(root, node => {
    if (node.type !== 'variable_declarator') return;
    const value = field(node, 'value');
    if (value?.type !== 'call_expression' || textOf(field(value, 'function')) !== 'require') return;
    for (const nameNode of patternNames(field(node, 'name'))) {
      for (const binding of scope.bindingFor(nameNode.startIndex, textOf(nameNode))) binding.commonJs = true;
    }
  });
}
function exportsOf(root, declarations) {
  const exports = new Map();
  const reexports = new Set();
  walk(root, node => {
    if (node.type !== 'export_statement') return;
    const source = node.namedChildren.find(child => child.type === 'string');
    if (source) { reexports.add(quotedSpecifier(source)); return; }
    const declaration = field(node, 'declaration');
    const name = declaration && FUNCTION_TYPES.has(declaration.type) ? field(declaration, 'name') : null;
    if (name) exports.set(textOf(name), declarations.filter(item => item.name === textOf(name)));
    if (textOf(node).startsWith('export default') && declaration && FUNCTION_TYPES.has(declaration.type)) {
      const target = name ? declarations.filter(item => item.name === textOf(name)) : declarations.filter(item => item.item.declaration === declaration);
      if (target.length) exports.set('default', target);
    }
    if (!declaration) for (const child of node.namedChildren) {
      if (child.type !== 'export_clause') continue;
      walk(child, entry => {
        if (entry.type !== 'export_specifier') return;
        const local = field(entry, 'name') || entry.namedChild(0);
        const exported = field(entry, 'alias') || entry.namedChild(entry.namedChildCount - 1);
        if (local?.type === 'identifier' && exported?.type === 'identifier') exports.set(textOf(exported), declarations.filter(item => item.name === textOf(local)));
      });
    }
  });
  return { exports, reexports };
}
function resolveModule(fromFile, specifier, modules) {
  if (!specifier.startsWith('.')) return { reason: 'external_module' };
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`];
  const matched = candidates.filter(candidate => modules.has(candidate));
  if (matched.length === 1) return { file: matched[0] };
  return { reason: matched.length ? 'module_resolution_ambiguous' : 'external_module' };
}
function moduleModel(file, text) {
  const grammar = grammarFor(file);
  if (!grammar) return { file, grammar: null, text };
  const tree = parserFor(grammar).parse(text);
  const root = tree.rootNode;
  const scope = scopeModel(root, file);
  const declarations = functionDeclarations(root, file, scope);
  commonJsBindings(root, scope);
  return { declarations, ...exportsOf(root, declarations), file, grammar, root, scope, tree, text };
}
function declarationFor(binding, file) {
  const declaration = binding.declaration;
  return { end: declaration.endIndex, file, line: lineOf(binding.node), start: declaration.startIndex, text: collapse(textOf(declaration)).slice(0, 240), type: declaration.type };
}
function candidateReceipt(item) { return item.declaration; }
function receiptBase(model, call) {
  const start = sourceByteOffset(model.text, call.startIndex);
  const end = sourceByteOffset(model.text, call.endIndex);
  return {
    call_site: { end, file: model.file, id: callReceiptId(model.file, start), line: lineOf(call), start, text: collapse(textOf(call)).slice(0, 240), type: call.type },
    file: model.file, id: callReceiptId(model.file, start), line: lineOf(call), producer: PRODUCER, schema: SCHEMA,
  };
}
function unresolved(model, call, reason) { return { ...receiptBase(model, call), reason, status: 'unresolved' }; }
function bindCall(model, call, models) {
  if (model.root.hasError()) return unresolved(model, call, 'parse_failed');
  if (call.type === 'new_expression') return unresolved(model, call, 'new_expression');
  const callee = field(call, 'function');
  if (!callee) return unresolved(model, call, 'unsupported_grammar');
  if (callee.type === 'subscript_expression') return unresolved(model, call, 'computed_member');
  if (callee.type === 'member_expression') {
    if (textOf(field(callee, 'property')) === '') return unresolved(model, call, 'computed_member');
    const object = field(callee, 'object');
    const bindings = object?.type === 'identifier' ? model.scope.bindingFor(object.startIndex, textOf(object)) : [];
    if (bindings.some(binding => binding.kind === 'import' && binding.importBinding.kind === 'namespace')) return unresolved(model, call, 'namespace_import');
    if (bindings.some(binding => binding.commonJs)) return unresolved(model, call, 'commonjs_interop');
    return unresolved(model, call, 'method_call_on_local');
  }
  if (callee.type !== 'identifier') return unresolved(model, call, 'dynamic_dispatch');
  const name = textOf(callee);
  const bindings = model.scope.bindingFor(callee.startIndex, name);
  if (!bindings.length) return unresolved(model, call, 'unbound_identifier');
  if (bindings.some(binding => binding.assigned)) return unresolved(model, call, 'assigned_binding');
  if (bindings.some(binding => binding.commonJs)) return unresolved(model, call, 'commonjs_interop');
  if (bindings.length !== 1) return { ...receiptBase(model, call), candidates: bindings.filter(binding => binding.declaration).map(binding => candidateReceipt({ declaration: { file: model.file, line: lineOf(binding.node), text: collapse(textOf(binding.declaration)).slice(0, 240) } })), status: 'ambiguous' };
  const binding = bindings[0];
  if (binding.kind === 'non_function') return unresolved(model, call, 'shadowed_by_non_function_binding');
  let candidates;
  if (binding.kind === 'import') {
    if (binding.importBinding.kind === 'namespace') return unresolved(model, call, 'namespace_import');
    const moduleTarget = resolveModule(model.file, binding.importBinding.specifier, models);
    if (moduleTarget.reason) return unresolved(model, call, moduleTarget.reason);
    const target = models.get(moduleTarget.file);
    if (!target?.grammar || !target.root) return unresolved(model, call, 'unsupported_grammar');
    if (target.reexports.size) return unresolved(model, call, 're_export_chain');
    candidates = (target.exports.get(binding.importBinding.imported) || []).slice();
    if (candidates.some(candidate => candidate.item.assigned)) return unresolved(model, call, 'assigned_binding');
    if (!candidates.length) return unresolved(model, call, 'unbound_identifier');
  } else candidates = [{ declaration: declarationFor(binding, model.file) }];
  if (candidates.length === 1) return { ...receiptBase(model, call), declaration: candidateReceipt(candidates[0]), status: 'resolved' };
  return { ...receiptBase(model, call), candidates: candidates.map(candidateReceipt), status: 'ambiguous' };
}
function unsupportedCalls(text) {
  const pairs = new Map();
  const stack = [];
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') { index = text.indexOf('\n', index + 2); if (index < 0) break; continue; }
    if (character === '/' && text[index + 1] === '*') { index = text.indexOf('*/', index + 2); if (index < 0) break; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[') stack.push({ character, index });
    if (character === ')' || character === ']') {
      const opening = stack.pop();
      if (opening && ((opening.character === '(' && character === ')') || (opening.character === '[' && character === ']'))) pairs.set(index, opening.index);
    }
  }
  const previousWord = index => {
    const match = text.slice(0, index).match(/([A-Za-z_$][\w$]*)\s*$/);
    return match?.[1] || '';
  };
  const calls = [];
  const excluded = new Set(['catch', 'for', 'function', 'if', 'switch', 'while', 'with']);
  for (const [close, open] of [...pairs].sort(([left], [right]) => left - right)) {
    if (text[open] !== '(') continue;
    let cursor = open - 1;
    while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
    let start = -1;
    if (cursor >= 0 && text[cursor] === ')') start = pairs.get(cursor) ?? -1;
    else if (cursor >= 0 && /[\w$\].]/.test(text[cursor])) {
      start = cursor;
      while (start > 0 && /[\w$\[\].]/.test(text[start - 1])) start -= 1;
    }
    if (start < 0) continue;
    const direct = text.slice(start, cursor + 1).match(/^([A-Za-z_$][\w$]*)$/)?.[1] || '';
    if (excluded.has(direct) || excluded.has(previousWord(start))) continue;
    const newStart = previousWord(start) === 'new' ? text.lastIndexOf('new', start) : start;
    const row = text.slice(0, newStart).split('\n').length - 1;
    calls.push({
      endIndex: close + 1,
      startIndex: newStart,
      startPosition: { row },
      text: text.slice(newStart, close + 1),
      type: newStart < start ? 'new_expression' : 'call_expression',
    });
  }
  return calls;
}
/** Bind every parser call node in supplied source bytes. `sources` is an object or Map keyed by
 * normalized repository-relative path. The result owns its parser trees and is byte deterministic. */
export function bindCallSites(sources) {
  const entries = sources instanceof Map ? [...sources.entries()] : Object.entries(sources || {});
  const models = new Map(entries.map(([file, text]) => [normalizePath(file), moduleModel(normalizePath(file), String(text))]));
  const receipts = [];
  try {
    for (const model of [...models.values()].sort((left, right) => codePointCompare(left.file, right.file))) {
      if (!model.root) {
        for (const call of unsupportedCalls(model.text)) receipts.push(unresolved(model, call, call.type === 'new_expression' ? 'new_expression' : 'unsupported_grammar'));
        continue;
      }
      const calls = [];
      walk(model.root, node => { if (node.type === 'call_expression' || node.type === 'new_expression') calls.push(node); });
      if (model.root.hasError()) {
        const seen = new Set(calls.map(call => `${call.startIndex}:${call.type}`));
        for (const call of unsupportedCalls(model.text)) {
          if (!seen.has(`${call.startIndex}:${call.type}`)) calls.push(call);
        }
      }
      for (const call of calls) receipts.push(bindCall(model, call, models));
    }
    return receipts.sort((left, right) => codePointCompare(left.file, right.file) || left.call_site.start - right.call_site.start);
  } finally {
    for (const model of models.values()) model.tree?.delete();
  }
}
/** Bind one source file, with optional other source bytes for import resolution. */
export function bindCallSitesIn(text, { file, sources = {} } = {}) {
  const all = sources instanceof Map ? new Map(sources) : { ...sources };
  if (all instanceof Map) all.set(file, text); else all[file] = text;
  return bindCallSites(all).filter(receipt => receipt.file === normalizePath(file));
}
