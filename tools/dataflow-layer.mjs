#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from './readonly-guard.mjs';
import path from 'node:path';
import { languages, TreeSitter } from './treesitter/loader.mjs';
import { normalizePath, parseArgs, stableStringify, walk, writeJsonLines } from './lib.mjs';
import { bindCallSitesIn, callReceiptId, sourceByteOffset } from './call-site-binding.mjs';

export const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00Z';
import {
  DATAFLOW_ASSERTION_TYPES, DATAFLOW_CLAIM_REFUSAL_REASONS, DATAFLOW_GUARD_FAMILIES,
  DATAFLOW_GUARD_KINDS, DATAFLOW_GUARD_POLARITIES, DATAFLOW_LAYER_SCHEMA,
  DATAFLOW_REFUSAL_REASONS, DATAFLOW_SOURCE_ORIGINS, validateDataflowRecord,
} from './annotate.mjs';

export const PRODUCER = 'dataflow-layer@1';
export const EXTRACTOR_PRODUCER = 'deterministic/guarded-assignment-extractor@1';
export const SKELETON_SCHEMA = 'estate-map/flow-skeleton/v1';
export const DEFAULT_MODEL = 'unspecified-model';

// The single boundary crossing is deliberately bounded at two hops. This restores the bound
// declared when the characterization fixture was introduced; any increase needs separate evidence.
export const MAX_RESOLUTION_DEPTH = 2;
// A skeleton is evidence a human reads, so it is bounded rather than exhaustive. The cap is on
// SOURCES only — sites and guards are never truncated, because a dropped guard would let an
// exclusion claim be checked against an incomplete guard set, which is the one truncation that
// could turn a gate into a rubber stamp.
export const SOURCE_CAP = 24;

// ---------------------------------------------------------------------------
// Invented examples explain the bounded syntax vocabulary without publishing source citations.
export const SINK_IDIOMS = Object.freeze([
  Object.freeze({
    id: 'S1-compound-add',
    what: 'augmented assignment `x += expr` / `x -= expr` onto an identifier or member',
    example: 'if (enabled) { parcelCount += 2; }',
  }),
  Object.freeze({
    id: 'S2-increment',
    what: 'update expression `x++` / `x--`',
    example: 'parcelCount++;',
  }),
  Object.freeze({
    id: 'S3-or-zero-bump',
    what: 'the null-safe counter bump `X = (X || 0) + N`',
    example: 'counts.parcels = (counts.parcels || 0) + 1;',
  }),
  Object.freeze({
    id: 'S4-prepared-write',
    what: 'a prepared-statement rollup write `statements.<name>.run(...)` / `stmts.<name>.run(...)`',
    example: 'statements.setParcelCount.run(count);',
  }),
  Object.freeze({
    id: 'S5-reduce-aggregate',
    what: 'an aggregate built by `.reduce((sum, x) => sum + ..., 0)`',
    example: 'const total = parcels.reduce((sum, parcel) => sum + parcel.weight, 0);',
  }),
  Object.freeze({
    id: 'S6-map-counter',
    what: 'a Map-backed counter `M.set(k, (M.get(k) || 0) + N)`',
    example: 'counts.set(parcel, (counts.get(parcel) || 0) + 1);',
  }),
]);
export const SINK_IDIOM_IDS = Object.freeze(SINK_IDIOMS.map(idiom => idiom.id));

// A prepared statement is a SINK only if its name says it writes. `getParcel` reads; `setParcelCount`
// writes. The prefix set is frozen and declared rather than inferred, and the report states the
// recall cost of that choice.
export const WRITING_STATEMENT_PREFIXES = Object.freeze(['set', 'upsert', 'update', 'insert', 'increment', 'bump', 'record', 'add', 'mark', 'apply']);
export const STATEMENT_HOLDER_NAMES = Object.freeze(['statements', 'stmts', 'statement', 'stmt']);

// `entry += " Args: ..."` is string building, not accumulation. The discriminator is syntactic
// (the RHS shape), never a name heuristic, and the excluded count is reported in the census.
const STRING_RHS_TYPES = new Set(['string', 'template_string']);
const STRING_RHS_CALLS = new Set(['toString', 'stringify', 'join', 'slice', 'padStart', 'padEnd', 'trim', 'toLowerCase', 'toUpperCase', 'repeat', 'concat']);

// Preserve source witnesses; do not infer authority from naming conventions alone.
export const GUARD_FAMILIES = DATAFLOW_GUARD_FAMILIES;
export const GUARD_KINDS = DATAFLOW_GUARD_KINDS;
export const GUARD_POLARITIES = DATAFLOW_GUARD_POLARITIES;
export const SOURCE_ORIGINS = DATAFLOW_SOURCE_ORIGINS;
export const SKELETON_REFUSAL_REASONS = DATAFLOW_REFUSAL_REASONS;

// ---------------------------------------------------------------------------
// THE CLAIM VOCABULARY. `interpretation-layer.mjs` §4.3 named the next move exactly: "a `claims[]`
// array of typed, checkable assertions replacing free prose". This is that move. A claim carries
// BOTH a sentence (what a human reads) and typed assertions (what a gate checks) — and gate D6
// checks the sentence AGAINST the assertions, so the two cannot drift apart.
export const FLOW_ASSERTION_TYPES = DATAFLOW_ASSERTION_TYPES;
// Assertion types that MUST cite a guard that genuinely prevents the write.
export const EXCLUDING_ASSERTION_TYPES = Object.freeze(['excludes_when']);
export const CONDITIONAL_ASSERTION_TYPES = Object.freeze(['excludes_when', 'requires']);

// Sentence cues. A cue is a surface marker of a claim class; if the sentence carries the cue, the
// record must carry the matching assertion. Frozen, lower-cased, matched on word boundaries.
export const EXCLUSION_CUES = Object.freeze([
  'excludes', 'exclude', 'excluded', 'drops', 'drop', 'dropped', 'omits', 'omitted', 'ignores',
  'ignored', 'skips', 'skipped', 'discards', 'discarded', 'zeroes', 'never counts', 'not counted',
  'does not count', 'silently loses', 'loses',
]);
export const REQUIREMENT_CUES = Object.freeze([
  'only when', 'only if', 'requires', 'required', 'gated on', 'conditional on', 'guarded by',
]);
export const UNCONDITIONAL_CUES = Object.freeze([
  'unconditionally', 'always', 'every time', 'without a guard', 'ungated',
]);
export const CLAIM_REFUSAL_REASONS = DATAFLOW_CLAIM_REFUSAL_REASONS;

// ---------------------------------------------------------------------------
// PARSING
const GRAMMARS = Object.freeze({
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
});
export const grammarNameFor = file => GRAMMARS[path.extname(String(file)).toLowerCase()] || null;

const parserCache = new Map();
function parserFor(grammarName) {
  if (!parserCache.has(grammarName)) {
    const parser = new TreeSitter();
    parser.setLanguage(languages[grammarName]);
    parserCache.set(grammarName, parser);
  }
  return parserCache.get(grammarName);
}

const FUNCTION_TYPES = new Set([
  'function_declaration', 'function_expression', 'function', 'arrow_function',
  'generator_function', 'generator_function_declaration', 'method_definition',
]);
const BLOCK_TYPES = new Set(['statement_block', 'program', 'switch_case', 'switch_default']);
const EXIT_TYPES = Object.freeze({
  return_statement: 'early_exit_return',
  continue_statement: 'early_exit_continue',
  break_statement: 'early_exit_break',
  throw_statement: 'early_exit_throw',
});

const lineOf = node => node.startPosition.row + 1;
const field = (node, name) => (node && typeof node.childForFieldName === 'function' ? node.childForFieldName(name) : null);
const textOf = node => (node ? node.text : '');
// A condition is quoted verbatim from source but collapsed to one line: a wrapped `if (...)` is
// still ONE condition, and a checker comparing it back to the file must compare the same thing.
export const collapse = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

/** The best available name for a function region. Never invented: falls back to `<anonymous@LINE>`. */
function functionNameOf(node) {
  const own = field(node, 'name');
  if (own) return textOf(own);
  const parent = node.parent;
  if (!parent) return `<anonymous@${lineOf(node)}>`;
  if (parent.type === 'variable_declarator') return textOf(field(parent, 'name')) || `<anonymous@${lineOf(node)}>`;
  if (parent.type === 'pair') return textOf(field(parent, 'key')) || `<anonymous@${lineOf(node)}>`;
  if (parent.type === 'assignment_expression') return collapse(textOf(field(parent, 'left'))) || `<anonymous@${lineOf(node)}>`;
  if (parent.type === 'arguments') {
    const call = parent.parent;
    const callee = call ? collapse(textOf(field(call, 'function'))) : '';
    return callee ? `<callback@${callee}:${lineOf(node)}>` : `<anonymous@${lineOf(node)}>`;
  }
  return `<anonymous@${lineOf(node)}>`;
}

function walkTree(node, visit) {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walkTree(node.namedChild(i), visit);
}

// ---------------------------------------------------------------------------
// SINK RECOGNITION
const isStatementHolder = expression => {
  const root = expression.split(/[.[]/)[0];
  return STATEMENT_HOLDER_NAMES.includes(root);
};
const statementWrites = name => WRITING_STATEMENT_PREFIXES.some(prefix => name.toLowerCase().startsWith(prefix));

function rhsIsStringBuilding(node) {
  if (!node) return false;
  if (STRING_RHS_TYPES.has(node.type)) return true;
  if (node.type === 'binary_expression') return rhsIsStringBuilding(field(node, 'left')) || rhsIsStringBuilding(field(node, 'right'));
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    const property = callee && callee.type === 'member_expression' ? textOf(field(callee, 'property')) : textOf(callee);
    return STRING_RHS_CALLS.has(property) || property === 'String';
  }
  return false;
}

/** Every sink write in one file, before any grouping. Deterministic in AST order. */
function collectSinkSites(root) {
  const sites = [];
  const excluded = [];
  walkTree(root, node => {
    const line = lineOf(node);
    if (node.type === 'augmented_assignment_expression') {
      const operator = collapse(textOf(node).slice(collapse(textOf(field(node, 'left'))).length));
      if (!/^[+-]=/.test(operator.trim()) && !/[+-]=/.test(textOf(node))) return;
      const right = field(node, 'right');
      const sink = collapse(textOf(field(node, 'left')));
      if (!sink) return;
      if (rhsIsStringBuilding(right)) { excluded.push({ line, reason: 'string_concatenation', sink }); return; }
      sites.push({ idiom: 'S1-compound-add', line, node, sink, value_text: collapse(textOf(right)) });
      return;
    }
    if (node.type === 'update_expression') {
      const argument = field(node, 'argument');
      const sink = collapse(textOf(argument));
      if (!sink) return;
      sites.push({ idiom: 'S2-increment', line, node, sink, value_text: collapse(textOf(node)) });
      return;
    }
    if (node.type === 'assignment_expression') {
      const sink = collapse(textOf(field(node, 'left')));
      const right = collapse(textOf(field(node, 'right')));
      // `X = (X || 0) + N` — the null-safe bump. Recognised only when the LHS reappears in the RHS,
      // which is what makes it an ACCUMULATION rather than an overwrite.
      if (sink && right.includes(sink) && /\|\|\s*0\)?\s*[+-]/.test(right)) {
        sites.push({ idiom: 'S3-or-zero-bump', line, node, sink, value_text: right });
      }
      return;
    }
    if (node.type !== 'call_expression') return;
    const callee = field(node, 'function');
    if (!callee || callee.type !== 'member_expression') return;
    const property = textOf(field(callee, 'property'));
    const receiver = collapse(textOf(field(callee, 'object')));
    if (property === 'run' && receiver && isStatementHolder(receiver)) {
      const statementName = receiver.split('.').pop().replace(/\?$/, '');
      if (!statementWrites(statementName)) { excluded.push({ line, reason: 'prepared_statement_is_a_read', sink: receiver }); return; }
      sites.push({ idiom: 'S4-prepared-write', line, node, sink: receiver, value_text: collapse(textOf(field(node, 'arguments'))) });
      return;
    }
    if (property === 'reduce') {
      const args = field(node, 'arguments');
      const body = collapse(textOf(args));
      // Only a SUMMING reduce is an accumulation sink; `.reduce` building an object is not.
      if (!/=>\s*[A-Za-z_$][\w$]*\s*[+-]/.test(body) && !/[+-]\s*[A-Za-z_$]/.test(body)) return;
      const holder = node.parent && node.parent.type === 'variable_declarator' ? collapse(textOf(field(node.parent, 'name'))) : collapse(textOf(callee));
      sites.push({ idiom: 'S5-reduce-aggregate', line, node, sink: holder, value_text: collapse(textOf(node)) });
      return;
    }
    if (property === 'set') {
      const args = field(node, 'arguments');
      const body = collapse(textOf(args));
      if (!/\.get\(/.test(body) || !/[+-]\s*\d|\|\|\s*0\)?\s*[+-]/.test(body)) return;
      sites.push({ idiom: 'S6-map-counter', line, node, sink: receiver, value_text: body });
    }
  });
  return { excluded, sites };
}

// ---------------------------------------------------------------------------
// GUARD EXTRACTION — the whole point of the layer.
/**
 * Every condition that dominates `node` within `boundary` (the enclosing function body).
 * ENCLOSING guards come from the ancestor chain; EARLY-EXIT guards come from statements that
 * PRECEDE the node's ancestor within each enclosing block. Both are witnessed at file:line and
 * both quote the condition verbatim.
 */
export function dominatingGuards(node, boundary) {
  const guards = [];
  const seen = new Set();
  const push = guard => {
    const key = `${guard.family}\0${guard.kind}\0${guard.line}\0${guard.condition}`;
    if (seen.has(key)) return;
    seen.add(key);
    guards.push(guard);
  };
  let child = node;
  let parent = node.parent;
  while (parent && parent.id !== boundary.id) {
    if (parent.type === 'if_statement') {
      const condition = collapse(textOf(field(parent, 'condition'))).replace(/^\(|\)$/g, '');
      const consequence = field(parent, 'consequence');
      const alternative = field(parent, 'alternative');
      if (consequence && consequence.id === child.id) push({ condition, family: 'enclosing', kind: 'if_consequence', line: lineOf(parent), polarity: 'requires' });
      else if (alternative && alternative.id === child.id) push({ condition, family: 'enclosing', kind: 'if_alternative', line: lineOf(parent), polarity: 'requires_not' });
    } else if (parent.type === 'else_clause') {
      const owner = parent.parent;
      if (owner && owner.type === 'if_statement') push({ condition: collapse(textOf(field(owner, 'condition'))).replace(/^\(|\)$/g, ''), family: 'enclosing', kind: 'if_alternative', line: lineOf(owner), polarity: 'requires_not' });
    } else if (parent.type === 'switch_case') {
      const switchStatement = parent.parent && parent.parent.parent;
      const discriminant = switchStatement && switchStatement.type === 'switch_statement' ? collapse(textOf(field(switchStatement, 'value'))).replace(/^\(|\)$/g, '') : '<switch>';
      push({ condition: `${discriminant} === ${collapse(textOf(field(parent, 'value')))}`, family: 'enclosing', kind: 'switch_case', line: lineOf(parent), polarity: 'requires' });
    } else if (parent.type === 'switch_default') {
      push({ condition: 'no case matched', family: 'enclosing', kind: 'switch_default', line: lineOf(parent), polarity: 'requires' });
    } else if (parent.type === 'ternary_expression') {
      const condition = collapse(textOf(field(parent, 'condition')));
      const consequence = field(parent, 'consequence');
      if (consequence && consequence.id === child.id) push({ condition, family: 'enclosing', kind: 'ternary_consequence', line: lineOf(parent), polarity: 'requires' });
      else push({ condition, family: 'enclosing', kind: 'ternary_alternative', line: lineOf(parent), polarity: 'requires_not' });
    } else if (parent.type === 'binary_expression') {
      const operator = collapse(textOf(parent).slice(collapse(textOf(field(parent, 'left'))).length)).split(' ')[0];
      const left = field(parent, 'left');
      const right = field(parent, 'right');
      if (right && right.id === child.id && left) {
        if (operator === '&&') push({ condition: collapse(textOf(left)), family: 'enclosing', kind: 'logical_and', line: lineOf(parent), polarity: 'requires' });
        else if (operator === '||') push({ condition: collapse(textOf(left)), family: 'enclosing', kind: 'logical_or', line: lineOf(parent), polarity: 'requires_not' });
      }
    }
    if (BLOCK_TYPES.has(parent.type)) for (const guard of collectEarlyExits(parent, child)) push(guard);
    child = parent;
    parent = parent.parent;
  }
  if (boundary && BLOCK_TYPES.has(boundary.type)) for (const guard of collectEarlyExits(boundary, child)) push(guard);
  return guards.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.condition.localeCompare(b.condition));
}

/** Guarded exits that appear BEFORE `stopAt` in `block` and therefore skip everything after them. */
function collectEarlyExits(block, stopAt) {
  const guards = [];
  for (let i = 0; i < block.namedChildCount; i++) {
    const statement = block.namedChild(i);
    if (stopAt && statement.id === stopAt.id) break;
    if (statement.type !== 'if_statement') continue;
    const alternative = field(statement, 'alternative');
    // An `if (...) return; else ...` is a branch, not a skip: only a bare guarded exit
    // unconditionally skips everything below it.
    if (alternative) continue;
    const consequence = field(statement, 'consequence');
    if (!consequence) continue;
    const exits = [];
    if (EXIT_TYPES[consequence.type]) exits.push(consequence);
    else if (consequence.type === 'statement_block') {
      const last = consequence.namedChildCount ? consequence.namedChild(consequence.namedChildCount - 1) : null;
      if (last && EXIT_TYPES[last.type]) exits.push(last);
    }
    if (!exits.length) continue;
    guards.push({
      condition: collapse(textOf(field(statement, 'condition'))).replace(/^\(|\)$/g, ''),
      family: 'early_exit',
      kind: EXIT_TYPES[exits[0].type],
      line: lineOf(statement),
      polarity: 'skips_when',
    });
  }
  return guards;
}

// ---------------------------------------------------------------------------
// SOURCES — reads that resolve to a binding IN THE SAME FUNCTION SCOPE. Anything else is
// `unresolved_in_scope` and, if it is a bare identifier from an outer scope, also a refusal.
const IDENTIFIER_ROOT = /^[A-Za-z_$][\w$]*/;
const RESERVED_ROOTS = new Set(['true', 'false', 'null', 'undefined', 'this', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'Object', 'Array', 'Date', 'Set', 'Map', 'Promise', 'console', 'process', 'NaN', 'Infinity']);

// Memoised per function node for the same reason `plainCallsIn` is: one function region backs many
// (region, sink) groups, and re-walking its body per group is quadratic on large modules.
const bindingCache = new WeakMap();
function collectBindings(functionNode) {
  if (bindingCache.has(functionNode)) return bindingCache.get(functionNode);
  const bindings = new Map();
  const add = (name, origin, node) => {
    if (!name || bindings.has(name)) return;
    bindings.set(name, { line: lineOf(node), name, origin, text: collapse(textOf(node)) });
  };
  const parameters = field(functionNode, 'parameters') || field(functionNode, 'parameter');
  if (parameters) {
    walkTree(parameters, node => {
      if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
        const inPattern = node.parent && ['object_pattern', 'array_pattern', 'object_assignment_pattern', 'pair_pattern'].includes(node.parent.type);
        add(textOf(node), inPattern ? 'destructured_parameter' : 'parameter', node);
      }
    });
  }
  const body = field(functionNode, 'body');
  if (body) {
    walkTree(body, node => {
      if (node.type === 'variable_declarator') {
        const name = field(node, 'name');
        if (!name) return;
        if (name.type === 'identifier') add(textOf(name), 'local_declaration', node);
        else walkTree(name, inner => { if (inner.type === 'identifier' || inner.type === 'shorthand_property_identifier_pattern') add(textOf(inner), 'local_declaration', node); });
      } else if (node.type === 'for_in_statement') {
        const left = field(node, 'left');
        if (left) walkTree(left, inner => { if (inner.type === 'identifier') add(textOf(inner), 'loop_binding', node); });
      } else if (node.type === 'catch_clause') {
        const parameter = field(node, 'parameter');
        if (parameter) walkTree(parameter, inner => { if (inner.type === 'identifier') add(textOf(inner), 'catch_binding', node); });
      }
    });
  }
  bindingCache.set(functionNode, bindings);
  return bindings;
}

function readsIn(node) {
  const reads = new Set();
  if (!node) return reads;
  walkTree(node, inner => {
    if (inner.type === 'identifier') {
      if (inner.parent && inner.parent.type === 'member_expression' && field(inner.parent, 'property') && field(inner.parent, 'property').id === inner.id) return;
      if (inner.parent && inner.parent.type === 'property_identifier') return;
      reads.add(textOf(inner));
    } else if (inner.type === 'member_expression') {
      reads.add(collapse(textOf(inner)));
    }
  });
  return reads;
}

// ---------------------------------------------------------------------------
// CHAIN STEPS — filter/map/reduce/flatMap steps feeding a site, read off the same expression.
const CHAIN_METHODS = Object.freeze(['filter', 'map', 'flatMap', 'reduce', 'some', 'every', 'find', 'sort', 'slice']);
function chainStepsIn(node) {
  const steps = [];
  if (!node) return steps;
  walkTree(node, inner => {
    if (inner.type !== 'call_expression') return;
    const callee = field(inner, 'function');
    if (!callee || callee.type !== 'member_expression') return;
    const method = textOf(field(callee, 'property'));
    if (!CHAIN_METHODS.includes(method)) return;
    steps.push({ line: lineOf(inner), receiver: collapse(textOf(field(callee, 'object'))), step: method, text: collapse(textOf(inner)).slice(0, 240) });
  });
  return steps.sort((a, b) => a.line - b.line || a.step.localeCompare(b.step));
}

// ---------------------------------------------------------------------------
// THE ONE BOUNDARY CROSSING — lexical, same-file, uniquely-bound, depth-limited.
function declaredFunctionsByName(regions) {
  const byName = new Map();
  for (const region of regions) {
    if (region.name.startsWith('<')) continue;
    const existing = byName.get(region.name) || [];
    existing.push(region);
    byName.set(region.name, existing);
  }
  return byName;
}

function importedNames(root) {
  const names = new Set();
  walkTree(root, node => {
    if (node.type !== 'import_statement') return;
    walkTree(node, inner => {
      if (inner.type === 'identifier' || inner.type === 'shorthand_property_identifier_pattern') names.add(textOf(inner));
    });
  });
  return names;
}

const callCache = new WeakMap();
function plainCallsIn(region) {
  const body = field(region.node, 'body');
  if (!body) return [];
  if (callCache.has(body)) return callCache.get(body);
  const calls = [];
  walkTree(body, node => {
    if (node.type !== 'call_expression') return;
    const callee = field(node, 'function');
    if (!callee) return;
    calls.push({ callee, line: lineOf(node), node, text: collapse(textOf(node)).slice(0, 240) });
  });
  callCache.set(body, calls);
  return calls;
}

// ---------------------------------------------------------------------------
// EXTRACTION
export function skeletonDigest(skeleton) {
  const canonical = JSON.stringify({
    file: skeleton.file,
    function_name: skeleton.function_name,
    guards: skeleton.guards,
    repo: skeleton.repo,
    sink: skeleton.sink,
    sites: skeleton.sites,
    sources: skeleton.sources,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const sinkClassOf = idiom => (idiom === 'S4-prepared-write' ? 'prepared_statement_write' : idiom === 'S6-map-counter' ? 'map_counter' : idiom === 'S5-reduce-aggregate' ? 'reduce_aggregate' : 'counter');

/**
 * Extract every flow skeleton in one source text.
 *
 * Returns `{ skeletons, refusals, census }`. A skeleton is one (file, enclosing function, sink)
 * triple; a refusal names one thing that could not be resolved without leaving the scope.
 */
export function extractFlowSkeletons(text, { file, repo = '', now = '1970-01-01T00:00:00Z', sources = {} } = {}) {
  const grammarName = grammarNameFor(file);
  const witnessFile = normalizePath(String(file));
  if (!grammarName) return { census: { excluded_sites: 0, sink_sites: 0 }, refusals: [], skeletons: [] };
  const parser = parserFor(grammarName);
  const tree = parser.parse(text);
  try {
    const root = tree.rootNode;
    if (root.hasError && root.namedChildCount === 0) {
      return {
        census: { excluded_sites: 0, sink_sites: 0 },
        refusals: [{ detail: `tree-sitter ${grammarName} produced no named children for ${witnessFile}`, file: witnessFile, id: `flow-refusal:${repo ? `${repo}/` : ''}${witnessFile}:1:parse_failed:${witnessFile}`, line: 1, reason: 'parse_failed', repo, unresolvable: witnessFile }],
        skeletons: [],
      };
    }
    const regions = [];
    walkTree(root, node => {
      if (!FUNCTION_TYPES.has(node.type)) return;
      regions.push({ end: node.endIndex, end_line: node.endPosition.row + 1, line: lineOf(node), name: functionNameOf(node), node, start: node.startIndex });
    });
    // Innermost-first by parser span, so same-line functions remain distinct.
    const enclosingRegion = node => regions.filter(region => region.start <= node.startIndex && node.startIndex < region.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] || null;

    const { excluded, sites } = collectSinkSites(root);
    const refusals = [];
    const preparedRefused = new Set();
    const pushRefusal = (reason, line, unresolvable, detail) => {
      refusals.push({ detail, file: witnessFile, line, reason, repo, unresolvable });
    };

    // (1) direct sites, grouped by (region, sink).
    const groups = new Map();
    const groupKey = (region, sink) => `${region ? region.start : 0}\0${region ? region.name : '<module>'}\0${sink}`;
    const moduleRegion = { end: root.endIndex, end_line: root.endPosition.row + 1, line: 1, name: '<module>', node: root, start: root.startIndex };
    for (const site of sites) {
      const region = enclosingRegion(site.node) || moduleRegion;
      const key = groupKey(region, site.sink);
      if (!groups.has(key)) groups.set(key, { region, sink: site.sink, sites: [] });
      const boundary = field(region.node, 'body') || region.node;
      groups.get(key).sites.push({
        idiom: site.idiom,
        line: site.line,
        node: site.node,
        resolution: [],
        text: collapse(textOf(site.node)).slice(0, 200),
        value_text: site.value_text.slice(0, 200),
        via_nested_closure: (enclosingRegion(site.node) || moduleRegion) !== region,
        _guards: dominatingGuards(site.node, boundary),
      });
      if (site.idiom === 'S4-prepared-write' && !preparedRefused.has(site.sink)) {
        preparedRefused.add(site.sink);
        pushRefusal('sink_target_unresolvable_cross_module', site.line, site.sink,
          `the prepared statement '${site.sink}' is bound outside this module, so the table and column set it writes cannot be named from this scope; the skeleton names the statement handle, never a column`);
      }
      if (/\[[^\]]*[^'"\]\s][^\]]*\]$/.test(site.sink) && !/\['[^']*'\]$|\["[^"]*"\]$/.test(site.sink)) {
        pushRefusal('dynamic_sink_expression', site.line, site.sink, `the written property of '${site.sink}' is computed at runtime, so the sink identity is not decidable from syntax`);
      }
    }

    // (2) the one boundary crossing: a call to a same-file, uniquely-declared function whose body
    // lexically contains a sink write becomes an INDIRECT site for that sink.
    const byName = declaredFunctionsByName(regions);
    const imported = importedNames(root);
    // call-site-binding@1 parses the same source bytes and decides lexical binding before this
    // layer follows a call. The receipt id carries the parser node's byte offset, so same-line
    // calls cannot collide. Declaration identity is its parser span, never its display line.
    const bindings = new Map(bindCallSitesIn(text, { file: witnessFile, sources }).map(binding => [binding.id, binding]));
    const bindingFor = call => bindings.get(callReceiptId(witnessFile, sourceByteOffset(text, call.node.startIndex)));
    const regionAtDeclaration = declaration => declaration && declaration.file === witnessFile
      ? regions.find(region => region.node.startIndex === declaration.start && region.node.endIndex === declaration.end && region.node.type === declaration.type) : null;
    const sitesInRegion = region => sites.filter(site => region.start <= site.node.startIndex && site.node.startIndex < region.end);
    const resolveInto = (region, depth, chain, emit) => {
      if (depth > MAX_RESOLUTION_DEPTH) return;
      for (const call of plainCallsIn(region)) {
        const callee = call.callee;
        if (callee.type !== 'identifier') continue;
        const name = textOf(callee);
        const binding = bindingFor(call);
        if (!binding || binding.status !== 'resolved') {
          if (binding?.status === 'ambiguous') pushRefusal('callee_name_ambiguous_in_module', call.line, name, `'${name}' has ${binding.candidates.length} lexical declaration candidates, so the call target is not decided`);
          continue;
        }
        const target = regionAtDeclaration(binding.declaration);
        // Cross-module receipts are correct binding evidence, but following their bodies would
        // make a skeleton whose source/guard scope is another module. Preserve the existing
        // refusal boundary until that larger record model is introduced.
        if (!target || target.node.startIndex === region.node.startIndex) continue;
        const nextChain = [...chain, { call_line: call.line, call_start: call.node.startIndex, callee: name, declared_line: target.line, hop: depth }];
        for (const site of sitesInRegion(target)) emit(site, nextChain, target);
        if (depth === MAX_RESOLUTION_DEPTH) {
          if (plainCallsIn(target).some(inner => bindingFor(inner)?.status === 'resolved' && regionAtDeclaration(bindingFor(inner).declaration))) {
            pushRefusal('resolution_depth_exceeded', call.line, name, `'${name}' itself calls a deterministically resolved function; the chain is longer than the declared bound of ${MAX_RESOLUTION_DEPTH} hops and is not followed`);
          }
        } else {
          resolveInto(target, depth + 1, nextChain, emit);
        }
      }
    };
    for (const region of regions) {
      if (region.name.startsWith('<')) continue;
      const boundary = field(region.node, 'body') || region.node;
      resolveInto(region, 1, [], (site, chain) => {
        const key = groupKey(region, site.sink);
        if (!groups.has(key)) groups.set(key, { region, sink: site.sink, sites: [] });
        const group = groups.get(key);
        const callLine = chain[0].call_line;
        const callNode = plainCallsIn(region).find(call => call.node.startIndex === chain[0].call_start);
        if (group.sites.some(existing => existing._call_start === callNode?.node.startIndex && existing.resolution.length)) return;
        // Guards are computed at the parser-identical CALL, not at the write.
        const anchor = callNode ? callNode.callee.parent : null;
        group.sites.push({
          _call_start: callNode?.node.startIndex,
          idiom: site.idiom,
          line: callLine,
          node: anchor,
          resolution: chain,
          text: callNode ? callNode.text : '',
          value_text: site.value_text.slice(0, 200),
          via_nested_closure: false,
          _guards: anchor ? dominatingGuards(anchor, boundary) : [],
        });
      });
    }

    // (3) assemble.
    const skeletons = [];
    const boundaryRefused = new Set();
    for (const group of [...groups.values()].sort((a, b) => a.region.line - b.region.line || a.sink.localeCompare(b.sink))) {
      const { region, sink } = group;
      const bindings = collectBindings(region.node);
      // A sink written at several sites collects the UNION of their guards, which on its own would
      // let a claim say "this guard excludes the sink" about a guard that dominates ONE of seven
      // sites. Each guard therefore records exactly which site lines it dominates, and gate D3
      // refuses an exclusion whose guard does not dominate every site. This is the precision the
      // union alone does not have, and it is the difference between a true and a partial exclusion.
      const guardMap = new Map();
      for (const site of group.sites) {
        for (const guard of site._guards) {
          const key = `${guard.family}\0${guard.kind}\0${guard.line}\0${guard.condition}`;
          const entry = guardMap.get(key) || { ...guard, dominates_sites: new Set() };
          entry.dominates_sites.add(site.line);
          guardMap.set(key, entry);
        }
      }
      const guards = [...guardMap.values()]
        .map(guard => ({ ...guard, dominates_sites: [...guard.dominates_sites].sort((a, b) => a - b) }))
        .sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.condition.localeCompare(b.condition));
      const readTexts = new Set();
      for (const site of group.sites) {
        if (site.node) for (const read of readsIn(site.node)) readTexts.add(read);
      }
      for (const guard of guards) {
        for (const token of guard.condition.split(/[^\w$.?]+/)) if (token) readTexts.add(token.replace(/\?/g, ''));
      }
      // A read that appears in a GUARD condition is the one whose origin a claim will lean on, so
      // an unresolved one of those is a refusal. An unresolved read elsewhere is still recorded as
      // a source with `unresolved_in_scope`, but it does not earn a refusal record: the layer would
      // drown its own signal in every `Number(...)` and module-scope helper in the estate.
      const guardTokens = new Set(guards.flatMap(guard => guard.condition.split(/[^\w$.?]+/).filter(Boolean).map(token => token.replace(/\?/g, ''))));
      const sources = [];
      const unresolved = new Set();
      for (const read of [...readTexts].sort()) {
        const root2 = (read.match(IDENTIFIER_ROOT) || [''])[0];
        if (!root2 || RESERVED_ROOTS.has(root2) || /^\d/.test(read)) continue;
        if (read === sink) continue;
        const binding = bindings.get(root2);
        if (binding) sources.push({ line: binding.line, name: read, origin: binding.origin, text: binding.text.slice(0, 80) });
        else if (root2 === read) unresolved.add(read);
        else sources.push({ line: region.line, name: read, origin: 'unresolved_in_scope', text: `'${root2}' is not bound in ${region.name}` });
      }
      for (const name of [...unresolved].sort()) {
        sources.push({ line: region.line, name, origin: 'unresolved_in_scope', text: `'${name}' is not bound in ${region.name}` });
        if (guardTokens.has(name)) pushRefusal('source_unresolvable_in_scope', region.line, name, `'${name}' appears in a guard condition of this flow but is bound outside ${region.name}; naming what it holds would require leaving the scope`);
      }
      // The honest incompleteness statement for THIS skeleton: calls made in the same function that
      // could carry the flow further and that scope alone cannot follow. Bounded to functions that
      // actually produced a skeleton, and deduped per callee, so the ledger stays readable.
      if (region.node !== root) {
        for (const call of plainCallsIn(region)) {
          const callee = call.callee;
          if (callee.type === 'member_expression') {
            const text2 = collapse(textOf(callee));
            if (isStatementHolder(text2) || RESERVED_ROOTS.has(text2.split('.')[0])) continue;
            if (boundaryRefused.has(`m\0${region.name}\0${text2}`)) continue;
            boundaryRefused.add(`m\0${region.name}\0${text2}`);
            pushRefusal('callee_is_member_expression', call.line, text2, `'${text2}' is a member call inside ${region.name}; resolving its receiver is dataflow, which this extractor does not do, so any sink it writes is outside this skeleton`);
            continue;
          }
          if (callee.type !== 'identifier') continue;
          const name = textOf(callee);
          if (RESERVED_ROOTS.has(name) || bindings.has(name)) continue;
          const key = `i\0${region.name}\0${name}`;
          if (boundaryRefused.has(key)) continue;
          boundaryRefused.add(key);
          if (imported.has(name)) pushRefusal('callee_is_imported_binding', call.line, name, `'${name}' is bound by an import in this file, so its body is in another module and any sink it writes is outside this skeleton`);
          else if (!byName.has(name)) pushRefusal('callee_declared_outside_module', call.line, name, `'${name}' has no function declaration in this file, so a sink it writes cannot be reached from this scope`);
        }
      }
      const chainSteps = [];
      for (const site of group.sites) if (site.node) chainSteps.push(...chainStepsIn(site.node));
      const skeleton = {
        chain_steps: chainSteps.slice(0, 20),
        evidence_class: 'witnessed_guarded_assignment',
        extractor: EXTRACTOR_PRODUCER,
        file: witnessFile,
        function_end_line: region.end_line,
        function_line: region.line,
        function_name: region.name,
        generated_at: now,
        guards: guards.map(guard => ({ condition: guard.condition.slice(0, 400), dominates_sites: guard.dominates_sites, family: guard.family, kind: guard.kind, line: guard.line, polarity: guard.polarity })),
        id: `flow:${repo ? `${repo}/` : ''}${witnessFile}#${region.name}::${sink}`,
        producer: PRODUCER,
        repo,
        schema: SKELETON_SCHEMA,
        sink: { class: sinkClassOf(group.sites[0].idiom), expression: sink, idioms: [...new Set(group.sites.map(site => site.idiom))].sort() },
        sites: group.sites
          .map(site => ({ idiom: site.idiom, line: site.line, resolution: site.resolution.map(({ call_start, ...step }) => step), text: site.text, value_text: site.value_text, via_nested_closure: site.via_nested_closure }))
          .sort((a, b) => a.line - b.line || a.idiom.localeCompare(b.idiom)),
        sources: sources.slice(0, SOURCE_CAP),
      };
      skeleton.digest = skeletonDigest(skeleton);
      skeletons.push(skeleton);
    }
    const dedupedRefusals = [];
    const refusalSeen = new Set();
    for (const refusal of refusals.sort((a, b) => a.line - b.line || a.reason.localeCompare(b.reason) || a.unresolvable.localeCompare(b.unresolvable))) {
      const key = `${refusal.reason}\0${refusal.line}\0${refusal.unresolvable}`;
      if (refusalSeen.has(key)) continue;
      refusalSeen.add(key);
      dedupedRefusals.push({ ...refusal, id: `flow-refusal:${repo ? `${repo}/` : ''}${witnessFile}:${refusal.line}:${refusal.reason}:${refusal.unresolvable}` });
    }
    return {
      census: { excluded_sites: excluded.length, excluded_by_reason: countBy(excluded.map(item => item.reason)), sink_sites: sites.length },
      refusals: dedupedRefusals,
      skeletons: skeletons.sort((a, b) => a.id.localeCompare(b.id)),
    };
  } finally {
    tree.delete();
  }
}

export const countBy = values => {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
};

// ---------------------------------------------------------------------------
// GATES.
//
// D1 SITES REAL       — every cited line is re-read FROM DISK and the recorded text must be present.
// D2 SKELETON REPRODUCES — re-extracting the file yields a byte-identical skeleton.
// D3 ASSERTION BACKED — every assertion cites a guard that is in the skeleton, quoted verbatim.
// D4 SUBJECT IN CONDITION — the excluded/required subject must appear in the cited condition.
// D5 NO NEW FLOW      — every site/sink/source the claim names is in the skeleton.
// D6 SENTENCE GATE    — the CLAIM SENTENCE is checked against the skeleton, not merely the items.

/** D3 + D4 for one assertion. */
export function checkAssertion(skeleton, assertion) {
  if (!assertion || typeof assertion !== 'object') return { ok: false, why: 'assertion is not an object' };
  if (!FLOW_ASSERTION_TYPES.includes(assertion.type)) return { ok: false, why: `unknown assertion type '${assertion.type}'` };
  if (assertion.type === 'writes_unconditionally') {
    if (skeleton.guards.length) return { ok: false, why: `writes_unconditionally, but the skeleton carries ${skeleton.guards.length} guard(s) (first: ${skeleton.file}:${skeleton.guards[0].line})` };
    return { ok: true };
  }
  if (assertion.type === 'writes_at') {
    const site = skeleton.sites.find(item => item.line === assertion.guard_line);
    if (!site) return { ok: false, why: `writes_at ${skeleton.file}:${assertion.guard_line}, which is not a site in the skeleton` };
    return { ok: true };
  }
  if (assertion.type === 'accumulates_from') {
    const known = skeleton.sources.some(source => source.name === assertion.subject) || skeleton.sites.some(site => site.value_text.includes(assertion.subject));
    if (!known) return { ok: false, why: `accumulates_from '${assertion.subject}', which is neither a source nor present in any site's value expression` };
    return { ok: true };
  }
  const guard = skeleton.guards.find(item => item.line === assertion.guard_line && item.condition === assertion.quoted_condition);
  if (!guard) {
    const atLine = skeleton.guards.filter(item => item.line === assertion.guard_line).map(item => item.condition);
    return { ok: false, why: atLine.length
      ? `quoted_condition is not verbatim at ${skeleton.file}:${assertion.guard_line}: claimed '${assertion.quoted_condition}', skeleton has '${atLine.join("' | '")}'`
      : `no guard at ${skeleton.file}:${assertion.guard_line} in this skeleton (guards are at ${skeleton.guards.map(item => item.line).join(', ') || 'no line'})` };
  }
  // D3's teeth: an EXCLUSION must cite a guard that genuinely PREVENTS the write. An
  // `if_consequence` guard makes the write happen when the condition holds — the opposite.
  if (EXCLUDING_ASSERTION_TYPES.includes(assertion.type)) {
    if (guard.polarity !== 'skips_when' && guard.polarity !== 'requires_not') {
      return { ok: false, why: `excludes_when cites ${skeleton.file}:${guard.line}, whose polarity is '${guard.polarity}': that guard makes the write HAPPEN when the condition holds, it does not exclude anything` };
    }
    // A guard that dominates SOME sites excludes some writes, not the sink. Saying "this counter
    // excludes X" on such a guard is a partial truth stated as a whole one, which is exactly the
    // over-claim class this layer exists to refuse.
    const dominated = guard.dominates_sites || [];
    if (dominated.length !== skeleton.sites.length) {
      const missed = skeleton.sites.map(site => site.line).filter(line => !dominated.includes(line));
      return { ok: false, why: `excludes_when cites ${skeleton.file}:${guard.line}, which dominates ${dominated.length} of the sink's ${skeleton.sites.length} write site(s); the write(s) at ${missed.join(', ')} happen regardless, so this excludes some writes, not the sink` };
    }
  }
  if (assertion.type === 'requires' && guard.polarity === 'skips_when' && !/^\s*!/.test(guard.condition)) {
    return { ok: false, why: `requires cites an early-exit guard at ${skeleton.file}:${guard.line} whose condition is not a negation, so it states a skip rather than a requirement` };
  }
  // D4: the subject must actually appear in the condition the assertion cites.
  const subject = String(assertion.subject || '');
  if (!subject) return { ok: false, why: 'assertion carries no subject' };
  if (!guard.condition.includes(subject)) {
    return { ok: false, why: `subject '${subject}' does not appear in the cited condition '${guard.condition}' at ${skeleton.file}:${guard.line}` };
  }
  return { ok: true };
}

const cueHit = (sentence, cue) => new RegExp(`(^|[^a-z])${cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(sentence);
const FILE_LINE = /([\w./-]+\.(?:mjs|cjs|js|jsx|ts|tsx)):(\d+)/g;
const BACKTICKED = /`([^`]+)`/g;
const INTEGER = /\b\d+\b/g;

/**
 * GATE D6 — THE SENTENCE GATE.
 *
 * This is the gate `interpretation-layer.mjs` §4.2 says did not exist: "gates I1-I6 check EVIDENCE
 * ITEMS and left the cohesion SENTENCE entirely ungated ... so a sentence could assert a singular
 * module, an identity, or a topology that the record's own member list refuted, and pass every
 * check." Here the sentence is the object under test. Six checks:
 *
 *   D6.1 EXCLUSION CUE      — an exclusion word in the sentence requires an `excludes_when`
 *                             assertion, which gate D3 has already tied to a SKIPPING guard.
 *   D6.2 REQUIREMENT CUE    — "only when" / "guarded by" requires a `requires` assertion.
 *   D6.3 UNCONDITIONAL CUE  — "unconditionally" / "always" requires a `writes_unconditionally`
 *                             assertion, which is false the moment the skeleton has a guard.
 *   D6.4 CITATION CONFINEMENT — every `file:line` in the sentence must be a site or guard of the
 *                             cited skeleton. A sentence cannot reach outside its own evidence.
 *   D6.5 QUOTED FRAGMENTS   — every backticked fragment must appear verbatim in the skeleton's
 *                             recorded text (a site, a guard condition, a source or the sink).
 *   D6.6 NUMERALS           — every integer >= 2 must equal a countable skeleton quantity.
 *
 *   D6.0 NON-VACUITY        — a sentence carrying assertions but NO cue at all asserts nothing a
 *                             gate can check, which is how ungated prose gets in. Rejected.
 */
export function checkClaimSentence(sentence, { assertions = [], skeleton } = {}) {
  const problems = [];
  const text = String(sentence || '');
  if (!text.trim()) return { ok: false, problems: ['D6 the claim sentence is empty'] };
  const types = new Set(assertions.map(assertion => assertion.type));
  const exclusionCue = EXCLUSION_CUES.find(cue => cueHit(text, cue));
  const requirementCue = REQUIREMENT_CUES.find(cue => cueHit(text, cue));
  const unconditionalCue = UNCONDITIONAL_CUES.find(cue => cueHit(text, cue));

  if (exclusionCue && !types.has('excludes_when')) {
    problems.push(`D6.1 the sentence says '${exclusionCue}' but the record declares no excludes_when assertion; an asserted exclusion must correspond to a guard in the cited skeleton`);
  }
  if (requirementCue && !types.has('requires') && !types.has('excludes_when')) {
    problems.push(`D6.2 the sentence says '${requirementCue}' but the record declares no requires assertion`);
  }
  if (unconditionalCue && !types.has('writes_unconditionally')) {
    problems.push(`D6.3 the sentence says '${unconditionalCue}' but the record declares no writes_unconditionally assertion`);
  }
  if (!exclusionCue && !requirementCue && !unconditionalCue) {
    problems.push('D6.0 the sentence carries no exclusion, requirement or unconditional cue, so it asserts nothing this gate can check against the skeleton');
  }

  if (skeleton) {
    const siteLines = new Set(skeleton.sites.map(site => site.line));
    const guardLines = new Set(skeleton.guards.map(guard => guard.line));
    const resolutionLines = new Set(skeleton.sites.flatMap(site => (site.resolution || []).flatMap(hop => [hop.call_line, hop.declared_line])));
    for (const match of text.matchAll(FILE_LINE)) {
      const [, file, line] = match;
      const number = Number(line);
      if (!skeleton.file.endsWith(file) && !file.endsWith(path.basename(skeleton.file))) {
        problems.push(`D6.4 the sentence cites ${file}:${line}, which is not the skeleton's file (${skeleton.file})`);
        continue;
      }
      if (!siteLines.has(number) && !guardLines.has(number) && !resolutionLines.has(number)) {
        problems.push(`D6.4 the sentence cites ${file}:${line}, which is neither a site nor a guard nor a resolution hop of the cited skeleton`);
      }
    }
    const corpus = [
      skeleton.sink.expression,
      ...skeleton.sites.map(site => site.text),
      ...skeleton.sites.map(site => site.value_text),
      ...skeleton.sites.flatMap(site => (site.resolution || []).map(hop => hop.callee)),
      ...skeleton.guards.map(guard => guard.condition),
      ...skeleton.sources.map(source => source.name),
      skeleton.function_name,
    ].join('\n');
    for (const match of text.matchAll(BACKTICKED)) {
      const fragment = match[1].trim();
      if (!fragment) continue;
      if (/^[\w./-]+\.(?:mjs|cjs|js|jsx|ts|tsx):\d+$/.test(fragment)) continue;
      if (!corpus.includes(fragment)) {
        problems.push(`D6.5 the sentence quotes \`${fragment}\`, which appears nowhere in the skeleton's recorded text`);
      }
    }
    const countable = new Set([
      skeleton.sites.length, skeleton.guards.length, skeleton.sources.length,
      skeleton.guards.filter(guard => guard.family === 'early_exit').length,
      skeleton.guards.filter(guard => guard.family === 'enclosing').length,
      skeleton.chain_steps.length, skeleton.function_line, skeleton.function_end_line,
      ...skeleton.guards.map(guard => guard.dominates_sites.length),
      ...siteLines, ...guardLines, ...resolutionLines,
    ]);
    for (const match of text.matchAll(INTEGER)) {
      const value = Number(match[0]);
      if (value < 2) continue;
      if (!countable.has(value)) {
        problems.push(`D6.6 the sentence states the number ${value}, which is not a site count, a guard count, a source count, a chain-step count or a cited line of this skeleton`);
      }
    }
  }
  return { ok: !problems.length, problems };
}

/** D1 — re-read the cited lines FROM DISK and require the recorded text to be present. */
export async function verifySkeletonAgainstDisk(skeleton, estateRoot) {
  const problems = [];
  const absolute = path.resolve(estateRoot, skeleton.repo ? path.join(skeleton.repo, skeleton.file) : skeleton.file);
  let lines;
  try { lines = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/); }
  catch (error) { return { ok: false, problems: [`D1 ${skeleton.file} could not be read: ${error.message}`] };
  }
  const at = number => collapse(lines[number - 1] == null ? '' : lines[number - 1]);
  for (const site of skeleton.sites) {
    const line = at(site.line);
    const head = collapse(site.text).split(' ')[0];
    if (!line.includes(head.slice(0, 40))) problems.push(`D1 site ${skeleton.file}:${site.line} does not carry '${head.slice(0, 40)}' (line reads '${line.slice(0, 120)}')`);
  }
  for (const guard of skeleton.guards) {
    // A guard condition may wrap across lines; a wrapped condition is verified against the
    // collapsed window that starts at its line, never against a re-flowed whole file.
    const window = collapse(lines.slice(guard.line - 1, guard.line + 6).join(' '));
    // TWO SWITCH KINDS CARRY A DERIVED PREDICATE, NOT QUOTED SOURCE, and this check says so
    // rather than pretending otherwise. A `case 'x':` line does not contain the discriminant --
    // that lives at the `switch (...)` line -- so the recorded condition `op === 'x'` is a
    // predicate the extractor COMPOSED from two lines. Requiring it verbatim at one line would be
    // a check that can only fail; requiring nothing would let a composed string masquerade as a
    // quotation. So D1 verifies the half that IS at the cited line: the case value.
    // (Found by the 100% over-claim audit, which failed 22 skeletons on exactly this.)
    const expected = guard.kind === 'switch_case'
      ? guard.condition.split(' === ').slice(1).join(' === ')
      : guard.kind === 'switch_default' ? 'default' : guard.condition;
    if (!window.includes(expected.slice(0, 60))) {
      problems.push(`D1 guard ${skeleton.file}:${guard.line} does not carry '${expected.slice(0, 60)}'${guard.kind.startsWith('switch') ? ` (derived predicate '${guard.condition.slice(0, 60)}'; only the case value is at this line)` : ''}`);
    }
  }
  return { ok: !problems.length, problems };
}

/** D2 — re-extract the file and require the cited skeleton back, byte-identical. */
export async function reproduceSkeleton(skeleton, estateRoot) {
  const absolute = path.resolve(estateRoot, skeleton.repo ? path.join(skeleton.repo, skeleton.file) : skeleton.file);
  const text = await fs.readFile(absolute, 'utf8');
  const { skeletons } = extractFlowSkeletons(text, { file: skeleton.file, now: skeleton.generated_at, repo: skeleton.repo });
  const found = skeletons.find(item => item.id === skeleton.id) || null;
  if (!found) return { found: null, ok: false, why: `re-extraction produced no skeleton with id ${skeleton.id}` };
  const a = JSON.stringify({ ...found, generated_at: null });
  const b = JSON.stringify({ ...skeleton, generated_at: null });
  return { found, ok: a === b, why: a === b ? '' : 'the re-extracted skeleton is not byte-identical to the recorded one' };
}

// ---------------------------------------------------------------------------
// APPLY
const asRecord = (base, extra) => ({ ...base, ...extra });

/**
 * Turn claim proposals into validated dataflow-layer records, running every gate. Rejections are
 * returned rather than thrown: the ledger of what the gates refused is part of the output.
 */
export async function applyFlowClaims(skeletons, proposals, { estateRoot = process.cwd(), model = DEFAULT_MODEL, now = new Date().toISOString(), refusals = [] } = {}) {
  const bySkeleton = new Map(skeletons.map(skeleton => [skeleton.id, skeleton]));
  const records = [];
  const rejections = [];
  const reject = (id, gate, why) => rejections.push({ gate, id, why });

  for (const skeleton of skeletons) {
    records.push(validateDataflowRecord(asRecord({
      chain_steps: skeleton.chain_steps,
      digest: skeleton.digest,
      evidence_class: 'witnessed_guarded_assignment',
      file: skeleton.file,
      function_end_line: skeleton.function_end_line,
      function_line: skeleton.function_line,
      function_name: skeleton.function_name,
      generated_at: now,
      guards: skeleton.guards,
      id: skeleton.id,
      kind: 'deterministic_extraction',
      producer: EXTRACTOR_PRODUCER,
      record_kind: 'flow_skeleton',
      repo: skeleton.repo,
      rule: 'D0 bounded intra-procedural guarded-assignment extraction',
      schema: DATAFLOW_LAYER_SCHEMA,
      sink: skeleton.sink,
      sites: skeleton.sites,
      sources: skeleton.sources,
    }, {}), `skeleton ${skeleton.id}`));
  }
  for (const refusal of refusals) {
    records.push(validateDataflowRecord({
      detail: refusal.detail,
      evidence_class: 'witnessed_guarded_assignment',
      file: refusal.file,
      generated_at: now,
      id: refusal.id,
      kind: 'deterministic_extraction',
      line: refusal.line,
      producer: EXTRACTOR_PRODUCER,
      reason: refusal.reason,
      record_kind: 'flow_refusal',
      repo: refusal.repo,
      rule: 'D0 a flow that leaves the scope is refused, never guessed',
      schema: DATAFLOW_LAYER_SCHEMA,
      unresolvable: refusal.unresolvable,
    }, `refusal ${refusal.id}`));
  }

  for (const proposal of proposals) {
    if (proposal.record_kind === 'claim_refusal') {
      if (!CLAIM_REFUSAL_REASONS.includes(proposal.reason)) { reject(proposal.id, 'D0', `claim refusal reason '${proposal.reason}' is not in the frozen vocabulary`); continue; }
      if (!bySkeleton.has(proposal.skeleton_id)) { reject(proposal.id, 'D5', `cites skeleton ${proposal.skeleton_id}, which was not extracted`); continue; }
      try {
        records.push(validateDataflowRecord({
          detail: proposal.detail,
          evidence_class: 'entailed_by_flow_skeleton',
          generated_at: now,
          id: proposal.id,
          kind: 'llm_annotation',
          model,
          producer: PRODUCER,
          reason: proposal.reason,
          record_kind: 'claim_refusal',
          rule: 'D6 a skeleton with nothing defensible to say produces a refusal, not a sentence',
          schema: DATAFLOW_LAYER_SCHEMA,
          skeleton_digest: bySkeleton.get(proposal.skeleton_id).digest,
          skeleton_id: proposal.skeleton_id,
        }, `claim refusal ${proposal.id}`));
      } catch (error) { reject(proposal.id, 'schema', error.message); }
      continue;
    }
    const skeleton = bySkeleton.get(proposal.skeleton_id);
    if (!skeleton) { reject(proposal.id, 'D5', `cites skeleton ${proposal.skeleton_id}, which was not extracted`); continue; }
    if (proposal.skeleton_digest !== skeleton.digest) { reject(proposal.id, 'D2', `cites digest ${String(proposal.skeleton_digest).slice(0, 12)}, the skeleton's digest is ${skeleton.digest.slice(0, 12)}`); continue; }

    const disk = await verifySkeletonAgainstDisk(skeleton, estateRoot);
    if (!disk.ok) { reject(proposal.id, 'D1', disk.problems.join(' | ')); continue; }
    const replay = await reproduceSkeleton(skeleton, estateRoot);
    if (!replay.ok) { reject(proposal.id, 'D2', replay.why); continue; }

    const assertionProblems = [];
    for (const assertion of proposal.assertions || []) {
      const check = checkAssertion(skeleton, assertion);
      if (!check.ok) assertionProblems.push(check.why);
    }
    if (!Array.isArray(proposal.assertions) || !proposal.assertions.length) assertionProblems.push('the claim declares no typed assertions, so its sentence rests on nothing checkable');
    if (assertionProblems.length) { reject(proposal.id, 'D3/D4', assertionProblems.join(' | ')); continue; }

    const sentence = checkClaimSentence(proposal.claim_sentence, { assertions: proposal.assertions, skeleton });
    if (!sentence.ok) { reject(proposal.id, 'D6', sentence.problems.join(' | ')); continue; }

    try {
      records.push(validateDataflowRecord({
        assertions: proposal.assertions,
        claim_sentence: proposal.claim_sentence,
        confidence: proposal.confidence,
        evidence_class: 'entailed_by_flow_skeleton',
        generated_at: now,
        id: proposal.id,
        kind: 'llm_annotation',
        model,
        producer: PRODUCER,
        record_kind: 'flow_claim',
        rule: 'D6 the claim SENTENCE is checked against the skeleton, not merely its citations',
        schema: DATAFLOW_LAYER_SCHEMA,
        skeleton_digest: skeleton.digest,
        skeleton_id: skeleton.id,
      }, `claim ${proposal.id}`));
    } catch (error) { reject(proposal.id, 'schema', error.message); }
  }
  records.sort((a, b) => `${a.record_kind}\0${a.id}`.localeCompare(`${b.record_kind}\0${b.id}`));
  rejections.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { records, rejections };
}

// ---------------------------------------------------------------------------
// CENSUS
export function censusOf(records, { rejections = [], skeletons = [] } = {}) {
  const claims = records.filter(record => record.record_kind === 'flow_claim');
  const skeletonRecords = records.filter(record => record.record_kind === 'flow_skeleton');
  return {
    assertions_by_type: countBy(claims.flatMap(claim => claim.assertions.map(assertion => assertion.type))),
    claim_refusals: records.filter(record => record.record_kind === 'claim_refusal').length,
    claims: claims.length,
    flow_refusals_by_reason: countBy(records.filter(record => record.record_kind === 'flow_refusal').map(record => record.reason)),
    guards_by_family: countBy(skeletonRecords.flatMap(record => record.guards.map(guard => guard.family))),
    guards_by_kind: countBy(skeletonRecords.flatMap(record => record.guards.map(guard => guard.kind))),
    indirect_sites: skeletonRecords.reduce((total, record) => total + record.sites.filter(site => site.resolution.length).length, 0),
    records: records.length,
    rejections: rejections.length,
    rejections_by_gate: countBy(rejections.map(rejection => rejection.gate)),
    sinks_by_class: countBy(skeletonRecords.map(record => record.sink.class)),
    sites: skeletonRecords.reduce((total, record) => total + record.sites.length, 0),
    skeletons: skeletons.length || skeletonRecords.length,
    skeletons_with_early_exit: skeletonRecords.filter(record => record.guards.some(guard => guard.family === 'early_exit')).length,
    skeletons_with_no_guard: skeletonRecords.filter(record => !record.guards.length).length,
  };
}

export function summarize(census) {
  return [
    `skeletons: ${census.skeletons} (${census.sites} write site(s), ${census.indirect_sites} resolved across one call boundary)`,
    `guards: ${JSON.stringify(census.guards_by_family)}`,
    `flow refusals: ${JSON.stringify(census.flow_refusals_by_reason)}`,
    `claims: ${census.claims} (${census.claim_refusals} claim refusal(s), ${census.rejections} gate rejection(s) ${JSON.stringify(census.rejections_by_gate)})`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
export async function produceSkeletons(estateRoot, outDir, { include = [], now = DEFAULT_GENERATED_AT } = {}) {
  const root = path.resolve(estateRoot);
  const { files } = await walk(root);
  const skeletons = [];
  const refusals = [];
  const census = { excluded_by_reason: {}, excluded_sites: 0, files_parsed: 0, files_seen: 0, sink_sites: 0 };
  for (const absolute of files.sort()) {
    const relative = normalizePath(path.relative(root, absolute));
    if (!grammarNameFor(relative)) continue;
    if (include.length && !include.some(prefix => relative.startsWith(prefix))) continue;
    census.files_seen++;
    let text;
    try { text = await fs.readFile(absolute, 'utf8'); } catch { continue; }
    const result = extractFlowSkeletons(text, { file: relative, now });
    census.files_parsed++;
    census.sink_sites += result.census.sink_sites;
    census.excluded_sites += result.census.excluded_sites;
    for (const [reason, count] of Object.entries(result.census.excluded_by_reason || {})) census.excluded_by_reason[reason] = (census.excluded_by_reason[reason] || 0) + count;
    skeletons.push(...result.skeletons);
    refusals.push(...result.refusals);
  }
  skeletons.sort((a, b) => a.id.localeCompare(b.id));
  refusals.sort((a, b) => a.id.localeCompare(b.id));
  await fs.mkdir(outDir, { recursive: true });
  await writeJsonLines(path.join(outDir, 'skeletons.jsonl'), skeletons);
  await writeJsonLines(path.join(outDir, 'skeleton-refusals.jsonl'), refusals);
  await fs.writeFile(path.join(outDir, 'extraction-census.json'), stableStringify({ ...census, refusals: refusals.length, refusals_by_reason: countBy(refusals.map(item => item.reason)), skeletons: skeletons.length }));
  return { census, refusals, skeletons };
}

export async function produceApply(skeletonsPath, refusalsPath, proposalsPath, outPath, { estateRoot = process.cwd(), model = DEFAULT_MODEL, now = new Date().toISOString() } = {}) {
  const readLines = async file => (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const skeletons = await readLines(path.resolve(skeletonsPath));
  const refusals = refusalsPath ? await readLines(path.resolve(refusalsPath)) : [];
  const proposals = proposalsPath ? await readLines(path.resolve(proposalsPath)) : [];
  const { records, rejections } = await applyFlowClaims(skeletons, proposals, { estateRoot, model, now, refusals });
  await writeJsonLines(path.resolve(outPath), records);
  const rejectionsPath = path.resolve(outPath).replace(/\.dataflow-layer\.jsonl$/, '.rejections.jsonl');
  await writeJsonLines(rejectionsPath, rejections);
  return { census: censusOf(records, { rejections, skeletons }), records, rejections };
}

const HELP = `usage:
  node tools/estate-map/dataflow-layer.mjs skeletons <estate-root> <out-dir> [--include <prefix,prefix>] [--generated-at <iso>]
  node tools/estate-map/dataflow-layer.mjs apply <skeletons.jsonl> <skeleton-refusals.jsonl> <proposals.jsonl> <out.dataflow-layer.jsonl> --estate-root <dir> [--model <id>]
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { options, positional } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0]) { console.log(HELP); process.exit(options.help ? 0 : 1); }
  if (positional[0] === 'skeletons') {
    if (!positional[1] || !positional[2]) { console.error(HELP); process.exit(1); }
    const include = options.include ? String(options.include).split(',').filter(Boolean) : [];
    const result = await produceSkeletons(positional[1], path.resolve(positional[2]), {
      include,
      ...(options['generated-at'] ? { now: options['generated-at'] } : {}),
    });
    console.log(stableStringify({ ...result.census, refusals: result.refusals.length, skeletons: result.skeletons.length }));
  } else if (positional[0] === 'apply') {
    if (!positional[1] || !positional[4]) { console.error(HELP); process.exit(1); }
    const result = await produceApply(positional[1], positional[2], positional[3], positional[4], { estateRoot: options['estate-root'] || process.cwd(), model: options.model || DEFAULT_MODEL });
    console.log(summarize(result.census));
    console.log(stableStringify(result.census));
  } else { console.error(HELP); process.exit(1); }
}
