// estate-map/ontology-pattern/v1 -- the small, versioned, bounded-depth expression language
// membership rules are written in (design v2 section 5: "a small versioned expression language
// ... arbitrary Cypher in definitions rejected").
//
// Five leaf predicates, three combinators, nothing else:
//
//   edge_exists       { direction: 'out'|'in', relation, target_kind? }
//   fact_kind_present { kind }                  -- sugar for edge_exists(out, 'contains', kind)
//   field_equals      { field, value }           -- scalar equality against the subject's own fields
//   field_in          { field, values }          -- scalar-or-array-element membership in `values`
//   field_set_equals  { field, values }          -- the field, read as a set, equals `values` exactly
//   and / or / not    combinators, depth-bounded
//
// A leaf's truth value is always two-valued (the exact edge either is or is not in the exact
// projection; a field either does or does not equal the requested value). What an unmatched TOP
// LEVEL result means for a concept -- abstain, because extraction is heuristic and absence is not
// proof, or not_member, because the field is a closed-vocabulary column every subject carries -- is
// a per-CONCEPT policy (`negative_semantics`), applied by membership-evaluator.mjs to the whole
// expression's result. This module only ever returns a boolean plus the trace that produced it.
import { sha256 } from '../lib.mjs';
import { canonical, fail, PATTERN_SCHEMA } from './schemas.mjs';

export { PATTERN_SCHEMA };

export const MAX_EXPRESSION_DEPTH = 6;
const DIRECTIONS = Object.freeze(['out', 'in']);
const LEAF_KINDS = Object.freeze(['edge_exists', 'fact_kind_present', 'field_equals', 'field_in', 'field_set_equals']);
const COMBINATOR_KINDS = Object.freeze(['and', 'or', 'not']);
const FIELD_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const unknownKeys = (body, allowed) => Object.keys(body ?? {}).filter(key => !allowed.includes(key));

function validateLeaf(kind, body, path) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('PATTERN_EXPRESSION_INVALID', `${path}.${kind} must be an object`);
  }
  if (kind === 'edge_exists') {
    if (!DIRECTIONS.includes(body.direction)) {
      fail('PATTERN_EXPRESSION_INVALID', `${path}.edge_exists.direction must be one of ${DIRECTIONS.join(', ')}`);
    }
    if (typeof body.relation !== 'string' || !body.relation) {
      fail('PATTERN_EXPRESSION_INVALID', `${path}.edge_exists.relation is required`);
    }
    if (body.target_kind !== undefined && (typeof body.target_kind !== 'string' || !body.target_kind)) {
      fail('PATTERN_EXPRESSION_INVALID', `${path}.edge_exists.target_kind must be a non-empty string`);
    }
    const extra = unknownKeys(body, ['direction', 'relation', 'target_kind']);
    if (extra.length) fail('PATTERN_EXPRESSION_INVALID', `${path}.edge_exists has unknown field(s) ${extra.join(', ')}`);
  } else if (kind === 'fact_kind_present') {
    if (typeof body.kind !== 'string' || !body.kind) fail('PATTERN_EXPRESSION_INVALID', `${path}.fact_kind_present.kind is required`);
    const extra = unknownKeys(body, ['kind']);
    if (extra.length) fail('PATTERN_EXPRESSION_INVALID', `${path}.fact_kind_present has unknown field(s) ${extra.join(', ')}`);
  } else if (kind === 'field_equals') {
    if (!FIELD_PATTERN.test(body.field || '')) fail('PATTERN_EXPRESSION_INVALID', `${path}.field_equals.field is not a valid field path`);
    if (!isScalar(body.value)) fail('PATTERN_EXPRESSION_INVALID', `${path}.field_equals.value must be a scalar`);
    const extra = unknownKeys(body, ['field', 'value']);
    if (extra.length) fail('PATTERN_EXPRESSION_INVALID', `${path}.field_equals has unknown field(s) ${extra.join(', ')}`);
  } else {
    if (!FIELD_PATTERN.test(body.field || '')) fail('PATTERN_EXPRESSION_INVALID', `${path}.${kind}.field is not a valid field path`);
    if (!Array.isArray(body.values) || !body.values.length || !body.values.every(isScalar)) {
      fail('PATTERN_EXPRESSION_INVALID', `${path}.${kind}.values must be a non-empty array of scalars`);
    }
    const extra = unknownKeys(body, ['field', 'values']);
    if (extra.length) fail('PATTERN_EXPRESSION_INVALID', `${path}.${kind} has unknown field(s) ${extra.join(', ')}`);
  }
}

/** Fail-closed structural check: one recognized operator key, valid leaf shape, bounded depth. */
export function validateExpression(expr, depth = 0, path = '$') {
  if (depth > MAX_EXPRESSION_DEPTH) fail('PATTERN_DEPTH_EXCEEDED', `${path} exceeds max pattern depth ${MAX_EXPRESSION_DEPTH}`);
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) fail('PATTERN_EXPRESSION_INVALID', `${path} must be an object`);
  const keys = Object.keys(expr);
  if (keys.length !== 1) fail('PATTERN_EXPRESSION_INVALID', `${path} must have exactly one operator key, found ${keys.length}`);
  const [kind] = keys;
  if (LEAF_KINDS.includes(kind)) { validateLeaf(kind, expr[kind], path); return; }
  if (kind === 'and' || kind === 'or') {
    const list = expr[kind];
    if (!Array.isArray(list) || !list.length) fail('PATTERN_EXPRESSION_INVALID', `${path}.${kind} must be a non-empty array`);
    list.forEach((child, index) => validateExpression(child, depth + 1, `${path}.${kind}[${index}]`));
    return;
  }
  if (kind === 'not') { validateExpression(expr.not, depth + 1, `${path}.not`); return; }
  fail('PATTERN_EXPRESSION_INVALID', `${path} has unrecognized operator ${JSON.stringify(kind)}; expected one of ${[...LEAF_KINDS, ...COMBINATOR_KINDS].join(', ')}`);
}

/** sha256(canonical(expression)) -- validated first, so a malformed rule can never earn a digest. */
export function expressionDigest(expression) {
  validateExpression(expression);
  return sha256(canonical(expression));
}

function fieldValue(fields, path) {
  return path.split('.').reduce((held, key) => (held && typeof held === 'object' ? held[key] : undefined), fields);
}

function edgeMatches(subjectView, direction, relation, targetKind) {
  const bucket = subjectView.edges?.[direction]?.get(relation) || [];
  return targetKind ? bucket.filter(entry => entry.to_kind === targetKind) : bucket.slice();
}

function evaluateLeaf(kind, body, subjectView) {
  if (kind === 'edge_exists') {
    const matches = edgeMatches(subjectView, body.direction, body.relation, body.target_kind);
    return { matched: matches.length > 0,
      clause: `${body.direction} ${body.relation}${body.target_kind ? ` -> ${body.target_kind}` : ''}`, matches };
  }
  if (kind === 'fact_kind_present') {
    const matches = edgeMatches(subjectView, 'out', 'contains', body.kind);
    return { matched: matches.length > 0, clause: `contains ${body.kind}`, matches };
  }
  if (kind === 'field_equals') {
    const observed = fieldValue(subjectView.fields, body.field);
    return { matched: observed === body.value, clause: `${body.field} == ${JSON.stringify(body.value)}`, observed, field: body.field };
  }
  if (kind === 'field_in') {
    const observed = fieldValue(subjectView.fields, body.field);
    const matched = Array.isArray(observed) ? observed.some(value => body.values.includes(value)) : body.values.includes(observed);
    return { matched, clause: `${body.field} in ${JSON.stringify(body.values)}`, observed, field: body.field };
  }
  // field_set_equals
  const observed = fieldValue(subjectView.fields, body.field);
  const matched = Array.isArray(observed) && (() => {
    const observedSet = new Set(observed);
    const expectedSet = new Set(body.values);
    return observedSet.size === expectedSet.size && [...observedSet].every(value => expectedSet.has(value));
  })();
  return { matched, clause: `${body.field} == set(${JSON.stringify(body.values)})`, observed, field: body.field };
}

/**
 * Evaluate a validated expression against one subject view. Returns `{ matched, trace }`: `matched`
 * is the whole tree's two-valued boolean result; `trace` has one entry per LEAF actually visited
 * (short-circuiting and/or skip unvisited branches, same as `&&`/`||`), each carrying either the
 * matched `edge_exists`/`fact_kind_present` adjacency records (`matches`) or the raw field name and
 * value `field_equals`/`field_in`/`field_set_equals` read (`field`, `observed`), so a caller can
 * build witnesses or an explanation without re-walking the tree.
 */
export function evaluateExpression(expression, subjectView) {
  validateExpression(expression);
  const trace = [];
  const evalNode = node => {
    const [kind] = Object.keys(node);
    if (kind === 'and') return node.and.map(evalNode).every(Boolean);
    if (kind === 'or') return node.or.map(evalNode).some(Boolean);
    if (kind === 'not') return !evalNode(node.not);
    const leaf = evaluateLeaf(kind, node[kind], subjectView);
    trace.push({ clause: leaf.clause, result: leaf.matched, matches: leaf.matches, observed: leaf.observed, field: leaf.field });
    return leaf.matched;
  };
  return { matched: evalNode(expression), trace };
}
