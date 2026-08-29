// F1 — LITERAL-VALUE RETENTION (orientation-test-report.md §7.2 P0).
//
// WHY THIS EXISTS. The orientation test measured the map at 31% on DIRECT
// (single-lookup) questions — its WORST class, and the counter-intuitive one,
// because a single lookup is what an index is *for*. The diagnosis in §2.3 is
// exact: "DIRECT questions in this estate ask *what a thing equals* (a path, a
// regex, an enum, a required-field list), and the map records **where symbols
// are, not what they evaluate to**." The map located `resolveDbPath` (Q2),
// `loadChecksLibrary` (Q3), `validateManifest` (Q15) and `validateInjectWhen`
// (Q17) at the correct file and line every time and could not state a single
// one of their values.
//
// WHAT IT EXTRACTS. One `literal_value` fact per `const`/`let`/`var` declarator
// whose right-hand side is statically summarizable: a string, number, boolean,
// null, regex, array literal, object literal, `new Set([...])` / `new Map([...])`,
// an `Object.freeze(...)` wrapper around any of those, or a `||` / `??`
// alternative chain. Every fact is witnessed at the declarator's real line, and
// every object entry / array item carries its own line.
//
// WHAT IT REFUSES, TYPED, RATHER THAN GUESSING. A value this module cannot
// evaluate from the syntax alone is never approximated. Non-scalar object
// property values are recorded as `{ value_kind: 'unevaluated' }` entries
// carrying the raw source text; a declarator whose whole RHS is a call, an
// await, an identifier or a class is skipped entirely (it mints no fact rather
// than a wrong one). An array or object over the size cap is emitted with
// `truncated: true` and the true `entry_count`, never silently shortened.
// Zero fabrications is the one property this map has that nothing else does;
// a summarizer that "mostly" evaluates would trade it away.
//
// READ-ONLY / NO-EXEC: this module evaluates NOTHING. It reads tree-sitter node
// text that extract.mjs already read and secret-redacted. There is no `eval`,
// no `Function`, no `import()` of scanned code, and no filesystem or network
// I/O anywhere in this file.

const VALUE_TEXT_CAP = 400;
const COLLECTION_CAP = 128;
const SCOPE_NAME_CAP = 120;

const cap = (text) => {
  const value = String(text ?? '');
  return value.length > VALUE_TEXT_CAP ? `${value.slice(0, VALUE_TEXT_CAP)}…` : value;
};

const DECLARATION_TYPES = new Set(['lexical_declaration', 'variable_declaration']);
// Nodes that name an enclosing lexical scope. `scope` is reported so a reader can
// tell a module-level constant (a contract) from a function-local one (a detail)
// without re-opening the file — Q2's answer is function-local, Q3's is module-level.
const SCOPE_NAMED_TYPES = new Set([
  'function_declaration', 'generator_function_declaration', 'method_definition', 'class_declaration',
]);

function line(node) {
  return node.startPosition.row + 1;
}

function unquote(node) {
  // tree-sitter `string` node text INCLUDES its delimiters. The fragment children
  // carry the content, which is what a reader wants to compare against a manifest
  // key or a CHECK constraint value.
  const fragments = node.namedChildren.filter((child) => child.type === 'string_fragment');
  if (fragments.length) return fragments.map((child) => child.text).join('');
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

/** A scalar this module is willing to state a VALUE for. Anything else gets a typed refusal. */
function scalar(node) {
  switch (node.type) {
    case 'string': return { value_kind: 'string', value: unquote(node) };
    case 'number': return { value_kind: 'number', value: node.text };
    case 'true': return { value_kind: 'boolean', value: 'true' };
    case 'false': return { value_kind: 'boolean', value: 'false' };
    case 'null': return { value_kind: 'null', value: 'null' };
    case 'undefined': return { value_kind: 'undefined', value: 'undefined' };
    case 'regex': return { value_kind: 'regex', value: node.text };
    case 'unary_expression': {
      // `-1` parses as a unary expression over a number; refusing it would lose
      // every negative-valued constant in the estate.
      const operand = node.childForFieldName('argument');
      if (node.child(0)?.text === '-' && operand?.type === 'number') return { value_kind: 'number', value: `-${operand.text}` };
      return null;
    }
    case 'template_string':
      // Only a template with NO substitution has a determinate value. One with
      // `${...}` is reported as an unevaluated expression, never as its raw text
      // pretending to be a value.
      return node.namedChildren.some((child) => child.type === 'template_substitution')
        ? null
        : { value_kind: 'string', value: node.text.replace(/^`|`$/g, '') };
    default: return null;
  }
}

function arrayItems(node) {
  const elements = node.namedChildren.filter((child) => child.type !== 'comment');
  const items = elements.slice(0, COLLECTION_CAP).map((child) => {
    const value = scalar(child);
    return value
      ? { ...value, line: line(child) }
      : { value_kind: 'unevaluated', text: cap(child.text), line: line(child) };
  });
  return { items, entry_count: elements.length, truncated: elements.length > COLLECTION_CAP };
}

function objectEntries(node) {
  const properties = node.namedChildren.filter((child) => child.type === 'pair' || child.type === 'shorthand_property_identifier' || child.type === 'spread_element');
  const entries = properties.slice(0, COLLECTION_CAP).map((child) => {
    if (child.type === 'shorthand_property_identifier') return { key: child.text, value_kind: 'unevaluated', text: child.text, line: line(child) };
    if (child.type === 'spread_element') return { key: null, value_kind: 'spread', text: cap(child.text), line: line(child) };
    const keyNode = child.childForFieldName('key');
    const valueNode = child.childForFieldName('value');
    if (!keyNode || !valueNode) return { key: null, value_kind: 'unevaluated', text: cap(child.text), line: line(child) };
    const key = keyNode.type === 'string' ? unquote(keyNode) : keyNode.text;
    const value = scalar(valueNode);
    return value
      ? { key, ...value, line: line(child) }
      : { key, value_kind: 'unevaluated', text: cap(valueNode.text), line: line(child) };
  });
  return { entries, entry_count: properties.length, truncated: properties.length > COLLECTION_CAP };
}

/**
 * Summarize a right-hand side, or return null to skip the declarator entirely.
 * `frozen` / `container` are carried through wrappers so `Object.freeze([...])`
 * reports the same items an unwrapped array literal would, plus the fact that it
 * is frozen — which is itself a design statement about the constant.
 */
export function summarizeValue(node, depth = 0) {
  if (!node || depth > 3) return null;
  const direct = scalar(node);
  if (direct) return { ...direct };
  switch (node.type) {
    case 'array': return { value_kind: 'array', ...arrayItems(node) };
    case 'object': return { value_kind: 'object', ...objectEntries(node) };
    case 'parenthesized_expression': {
      const inner = node.namedChildren[0];
      return inner ? summarizeValue(inner, depth + 1) : null;
    }
    case 'as_expression': case 'satisfies_expression': case 'type_assertion': {
      // TypeScript `[...] as const` — the value is the operand; the assertion is
      // a type-level annotation, not a different value.
      const inner = node.namedChildren[0];
      const summary = inner ? summarizeValue(inner, depth + 1) : null;
      return summary ? { ...summary, type_asserted: true } : null;
    }
    case 'binary_expression': {
      const operator = node.childForFieldName('operator')?.text;
      if (operator !== '||' && operator !== '??') return null;
      // A `||` / `??` chain is the estate's idiom for "configured value, else
      // env var, else default" (Q2's `resolveDbPath`). Its ALTERNATIVES are the
      // answer; the resolved value is runtime state and is deliberately not claimed.
      const alternatives = [];
      const flatten = (value) => {
        if (value.type === 'binary_expression' && ['||', '??'].includes(value.childForFieldName('operator')?.text)) {
          flatten(value.childForFieldName('left'));
          flatten(value.childForFieldName('right'));
          return;
        }
        const summary = scalar(value);
        alternatives.push(summary
          ? { ...summary, line: line(value) }
          : { value_kind: 'unevaluated', text: cap(value.text), line: line(value) });
      };
      flatten(node);
      return { value_kind: 'alternatives', operator, alternatives, entry_count: alternatives.length, truncated: false };
    }
    case 'new_expression': {
      const constructor = node.childForFieldName('constructor')?.text;
      if (!['Set', 'Map', 'RegExp'].includes(constructor)) return null;
      const argument = node.childForFieldName('arguments')?.namedChildren.find((child) => child.type !== 'comment');
      if (constructor === 'RegExp') {
        const value = argument ? scalar(argument) : null;
        return value ? { value_kind: 'regex', value: value.value, container: 'RegExp' } : null;
      }
      if (!argument || argument.type !== 'array') return null;
      return { value_kind: constructor === 'Set' ? 'set' : 'map', container: constructor, ...arrayItems(argument) };
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function')?.text;
      if (fn !== 'Object.freeze') return null;
      const argument = node.childForFieldName('arguments')?.namedChildren.find((child) => child.type !== 'comment');
      const summary = argument ? summarizeValue(argument, depth + 1) : null;
      return summary ? { ...summary, frozen: true } : null;
    }
    default: return null;
  }
}

function enclosingScope(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!SCOPE_NAMED_TYPES.has(current.type)) continue;
    const name = current.childForFieldName('name')?.text;
    return name ? `${current.type === 'class_declaration' ? 'class' : 'function'}:${name}`.slice(0, SCOPE_NAME_CAP) : null;
  }
  return null;
}

function isExported(declaration) {
  return declaration.parent?.type === 'export_statement';
}

/**
 * Emit one `literal_value` fact per summarizable declarator anywhere in the file.
 * Function-local constants are INCLUDED and marked with their scope: the estate's
 * default brew-DB path (Q2) is a function-local `join(...)`, and excluding local
 * scope would re-open the exact gap this feature closes.
 */
export function scanLiteralValues(rootNode, ctx) {
  const facts = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));
    if (!DECLARATION_TYPES.has(node.type)) continue;
    const kindToken = node.child(0)?.text || 'const';
    for (const declarator of node.namedChildren.filter((child) => child.type === 'variable_declarator')) {
      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');
      if (!nameNode || !valueNode || nameNode.type !== 'identifier') continue;
      const summary = summarizeValue(valueNode);
      if (!summary) continue;
      const scope = enclosingScope(declarator);
      facts.push(ctx.fact('literal_value', line(nameNode), {
        name: nameNode.text,
        declaration_kind: kindToken,
        exported: isExported(node),
        scope: scope || 'module',
        value_text: cap(valueNode.text),
        ...summary,
      }));
    }
  }
  return facts;
}

// --- F1 (second half): PREDICATE LITERALS ----------------------------------
//
// §7.1 names the missing fact class for Q15 and Q17 precisely: "validator
// literal arrays; **regex + equality predicates**." A declarator-only
// extractor closes the first half and NOT the second, and this estate's
// validators put their real contract in the second:
//
//   src/runtime/plugin-context.mjs:31  const REQUIRED = […]        ← declarator
//   src/runtime/plugin-context.mjs:36  /^[a-z0-9][a-z0-9-]*$/.test(name)
//   src/runtime/plugin-context.mjs:39  manifest.api_version !== 1
//   src/runtime/plugin-context.mjs:138 ["always","env","not_env","bundle"].includes(key)
//   src/runtime/plugin-context.mjs:142 cond[key] !== true
//
// Three of those four are inline literals in TEST position, bound to no name.
// Q15 asks what constraint is placed on `name` and which `api_version` values
// are accepted; Q17 asks how many keys `inject_when` permits, which names are
// legal, and what value constraint applies to each. Every one of those answers
// is an inline predicate literal.
//
// WHAT IT EXTRACTS. One `predicate_literal` fact per site where a literal is
// TESTED against a named subject:
//   membership   <array|set literal>.includes(x) / .has(x)
//   pattern      <regex literal>.test(x) / x.match(<regex>)
//   comparison   x === <scalar> / x !== <scalar> / x < <number> …
//   prefix       x.startsWith(<string>) / x.endsWith(<string>)
//
// WHAT IT REFUSES, TYPED. The SUBJECT is recorded as source text, never
// resolved to a value. A comparison in which NEITHER side is a literal emits
// nothing (it states no constraint this module can read). A comparison whose
// literal side is a collection is emitted with its items, not with a claim
// about what the collection means.

const PREDICATE_METHODS = new Map([
  ['includes', 'membership'], ['has', 'membership'], ['test', 'pattern'],
  ['match', 'pattern'], ['startsWith', 'prefix'], ['endsWith', 'prefix'],
]);
const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=']);
const SUBJECT_TYPES = new Set(['identifier', 'member_expression', 'subscript_expression', 'call_expression']);

export function scanPredicateLiterals(rootNode, ctx) {
  const facts = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));

    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      if (!callee || callee.type !== 'member_expression') continue;
      const method = callee.childForFieldName('property')?.text;
      const form = method ? PREDICATE_METHODS.get(method) : null;
      if (!form) continue;
      const receiver = callee.childForFieldName('object');
      const args = node.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
      // Either the RECEIVER carries the literal (`[…].includes(key)`,
      // `/re/.test(name)`) or the ARGUMENT does (`name.startsWith("x")`,
      // `key.match(/re/)`). Both are real constraints; take whichever side is
      // literal and name the other as the subject.
      const receiverSummary = receiver ? summarizeValue(receiver) : null;
      const argumentSummary = args[0] ? summarizeValue(args[0]) : null;
      const literal = receiverSummary || argumentSummary;
      if (!literal) continue;
      const subjectNode = receiverSummary ? args[0] : receiver;
      if (!subjectNode || !SUBJECT_TYPES.has(subjectNode.type)) continue;
      facts.push(ctx.fact('predicate_literal', line(node), {
        predicate_form: form,
        method,
        subject: cap(subjectNode.text),
        literal_side: receiverSummary ? 'receiver' : 'argument',
        scope: enclosingScope(node) || 'module',
        ...literal,
      }));
      continue;
    }

    if (node.type !== 'binary_expression') continue;
    const operator = node.childForFieldName('operator')?.text;
    if (!operator || !COMPARISON_OPERATORS.has(operator)) continue;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) continue;
    const leftValue = scalar(left);
    const rightValue = scalar(right);
    // Exactly one side must be a literal: `a === b` states no readable
    // constraint, and `1 === 1` names no subject.
    if (Boolean(leftValue) === Boolean(rightValue)) continue;
    const subjectNode = leftValue ? right : left;
    if (!SUBJECT_TYPES.has(subjectNode.type)) continue;
    facts.push(ctx.fact('predicate_literal', line(node), {
      predicate_form: 'comparison',
      method: null,
      operator,
      subject: cap(subjectNode.text),
      literal_side: leftValue ? 'left' : 'right',
      scope: enclosingScope(node) || 'module',
      ...(leftValue || rightValue),
    }));
  }
  return facts;
}

// --- F1b: throw-site error-code string literals -----------------------------
//
// §7.2 names this a sub-item of F1: "throw-site error-code string literals —
// unblocks Q16's codes." Q16 asks which error code each of two independent
// route-registration gates raises. The codes are string literals attached to a
// thrown Error, in three idioms this estate actually uses (verified by grep at
// the base of record):
//   1. `const e = new Error(msg); e.code = 'X'; throw e;`
//   2. `throw Object.assign(new Error(msg), { code: 'X' })`
//   3. `throw fail("ROUTE_NOT_DECLARED", "…")` — a FACTORY CALL whose first
//      argument is the code. This is the dominant idiom in the runtime broker
//      (src/plugin-runtime/broker.mjs:167 ROUTE_NAMESPACE_VIOLATION and :180
//      ROUTE_NOT_DECLARED are exactly Q16's two gates), and an extractor that
//      handled only (1) and (2) would answer Q16 with silence while the codes
//      sit in plain string literals. Grounded by reading the real thrower, not
//      by assuming a shape.
//   4. `throw new SomeError(msg)` with no readable code — emitted with
//      `code: null` and its constructor name, a witness to the throw site
//      without claiming a code the source did not state.
//
// The factory form is claimed ONLY when the first argument is a string literal
// in SCREAMING_SNAKE shape. A factory whose first argument is a human message
// (`throw invalid("path must be absolute")`) yields `code: null` — promoting a
// message to a code would be a fabrication of exactly the kind this map does
// not commit.

const ERROR_CODE_PROPERTIES = new Set(['code', 'statusCode', 'status', 'errorCode']);
const ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function assignedErrorCodes(rootNode) {
  // `<identifier>.code = '<literal>'` anywhere in the file, indexed by the
  // identifier so a throw of that identifier can be joined to it.
  const byIdentifier = new Map();
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));
    if (node.type !== 'assignment_expression') continue;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right || left.type !== 'member_expression') continue;
    const object = left.childForFieldName('object');
    const property = left.childForFieldName('property');
    if (!object || object.type !== 'identifier' || !property || !ERROR_CODE_PROPERTIES.has(property.text)) continue;
    const value = scalar(right);
    if (!value || value.value_kind !== 'string') continue;
    const list = byIdentifier.get(object.text) || [];
    list.push({ property: property.text, code: value.value, line: line(node) });
    byIdentifier.set(object.text, list);
  }
  return byIdentifier;
}

function objectLiteralCode(node) {
  if (!node || node.type !== 'object') return null;
  for (const pair of node.namedChildren.filter((child) => child.type === 'pair')) {
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value) continue;
    const keyName = key.type === 'string' ? unquote(key) : key.text;
    if (!ERROR_CODE_PROPERTIES.has(keyName)) continue;
    const summary = scalar(value);
    if (summary?.value_kind === 'string') return { property: keyName, code: summary.value };
  }
  return null;
}

export function scanThrowSites(rootNode, ctx) {
  const facts = [];
  const assigned = assignedErrorCodes(rootNode);
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));
    if (node.type !== 'throw_statement') continue;
    const thrown = node.namedChildren.find((child) => child.type !== 'comment');
    if (!thrown) continue;
    let code = null;
    let codeProperty = null;
    let errorType = null;
    let message = null;
    let codeSource = null;

    const readConstructor = (candidate) => {
      const constructorName = candidate.childForFieldName('constructor')?.text || null;
      const args = candidate.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
      const first = args[0] ? scalar(args[0]) : null;
      return { constructorName, message: first?.value_kind === 'string' ? cap(first.value) : null, args };
    };

    if (thrown.type === 'new_expression') {
      const info = readConstructor(thrown);
      errorType = info.constructorName;
      message = info.message;
      const literal = info.args.map(objectLiteralCode).find(Boolean);
      if (literal) { code = literal.code; codeProperty = literal.property; codeSource = 'constructor_options_object'; }
    } else if (thrown.type === 'call_expression' && thrown.childForFieldName('function')?.text === 'Object.assign') {
      // Object.assign is matched BEFORE the general factory-call branch below:
      // its code lives in an options object, not in argument[0].
      const args = thrown.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
      const target = args[0];
      if (target?.type === 'new_expression') {
        const info = readConstructor(target);
        errorType = info.constructorName;
        message = info.message;
      }
      const literal = args.map(objectLiteralCode).find(Boolean);
      if (literal) { code = literal.code; codeProperty = literal.property; codeSource = 'object_assign'; }
    } else if (thrown.type === 'call_expression') {
      const factory = thrown.childForFieldName('function');
      const factoryName = factory?.type === 'member_expression' ? factory.childForFieldName('property')?.text : factory?.text;
      const args = thrown.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
      const first = args[0] ? scalar(args[0]) : null;
      const second = args[1] ? scalar(args[1]) : null;
      errorType = factoryName ? `factory:${factoryName}` : 'call_expression';
      if (first?.value_kind === 'string' && ERROR_CODE_SHAPE.test(first.value)) {
        code = first.value;
        codeProperty = 'argument[0]';
        codeSource = `factory_call:${factoryName || 'anonymous'}`;
        message = second?.value_kind === 'string' ? cap(second.value) : null;
      } else {
        message = first?.value_kind === 'string' ? cap(first.value) : null;
      }
      const literal = args.map(objectLiteralCode).find(Boolean);
      if (!code && literal) { code = literal.code; codeProperty = literal.property; codeSource = 'call_options_object'; }
    } else if (thrown.type === 'identifier') {
      const assignments = assigned.get(thrown.text) || [];
      // Join to the NEAREST PRECEDING assignment in the same file. A later
      // assignment cannot be the one this throw carries.
      const before = assignments.filter((entry) => entry.line <= line(node)).sort((a, b) => b.line - a.line)[0];
      if (before) { code = before.code; codeProperty = before.property; codeSource = `assignment@${before.line}`; }
      errorType = 'identifier';
    } else {
      errorType = thrown.type;
    }

    facts.push(ctx.fact('throw_site', line(node), {
      error_type: errorType,
      code,
      code_property: codeProperty,
      code_source: codeSource,
      message,
      scope: enclosingScope(node) || 'module',
      // A throw whose code this module could not read from the syntax is emitted
      // WITH code:null and this reason. Silence would let a reader assume the
      // site raises nothing; a guessed code would be a fabrication.
      refusal: code ? null : 'code_not_a_string_literal_in_syntax',
    }));
  }
  return facts;
}
