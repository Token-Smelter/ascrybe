// F3 — AGGREGATE PERSISTENCE-TARGET FACTS (orientation-test-report.md §7.2 P1).
//
// WHY THIS EXISTS. §7.2 F3: "Unblocks Q11: 1 point, but disproportionate
// importance. 'Where does the authoritative Work Order live' is arguably *the*
// orientation question in this estate, and the map got it half-right by
// classification alone while the answer sits at `workOrder.mjs:1`. Extract the
// storage target of repository/aggregate modules (scoped-storage calls, path
// joins) as a first-class fact."
//
// §5 states the failure harder: "It knows where every *symbol* is and cannot
// say where the *system's state* is." The pre-F3 map could prove there is no
// `work_orders` table and could classify `work_order_summary` as a read model,
// and still could not say that truth lives in `work-orders/<id>/order.json`.
//
// GROUNDED IN THE REAL IDIOMS (verified at the base of record, not assumed):
//   context.storage.write(`work-orders/${wo.id}/order.json`, …)
//                       plugins/task-orchestration/server/aggregates/workOrder.mjs:338
//   context.storage.read("work-orders/index.json")
//                       plugins/task-orchestration/server/aggregates/workOrder.mjs:247
//   join(home, "plugins", "recipe-engine", "brews.db")
//                       plugins/recipe-engine/server/index.mjs:6258
//
// WHAT IT EXTRACTS.
//   persistence_target  one per scoped-storage / filesystem call that names a
//                       path: the operation, the receiver chain, and the path
//                       as the source writes it (literal, or template with its
//                       literal segments preserved and its substitutions marked).
//   path_expression     one per `join(...)` / `resolve(...)` / `path.join(...)`
//                       call: the ordered segment list, each marked literal or
//                       expression. This is what makes Q2's default brew-DB path
//                       readable without evaluating anything.
//
// WHAT IT REFUSES, TYPED. A template substitution is NEVER resolved: it is
// recorded as `{kind:'expression', text:'wo.id'}` inside the segment list and
// the reconstructed `path_pattern` carries `${…}` verbatim. A path built from a
// bare identifier is emitted with `path_kind:'expression'` and
// `refusal:'path_not_statically_readable'` rather than omitted — the call site
// is still the witness a reader needs, and silence would hide it.
//
// READ-ONLY / NO-EXEC: walks a tree-sitter tree over already-redacted text.
// Resolves no path, touches no filesystem, evaluates nothing.

const TEXT_CAP = 400;
const SEGMENT_CAP = 32;

const cap = (text) => {
  const value = String(text ?? '');
  return value.length > TEXT_CAP ? `${value.slice(0, TEXT_CAP)}…` : value;
};
const line = (node) => node.startPosition.row + 1;

// Storage/filesystem operations this estate actually uses for durable state.
const STORAGE_OPERATIONS = new Set([
  'write', 'read', 'writeFile', 'readFile', 'writeFileSync', 'readFileSync',
  'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync',
  'unlink', 'unlinkSync', 'rename', 'renameSync', 'createWriteStream', 'createReadStream',
]);
// A `.write(` on an HTTP response or a socket is not persistence. The receiver
// chain must name a storage-ish surface for the call to be claimed as one.
const STORAGE_RECEIVERS = /(?:^|\.)(?:storage|fs|fsp|fsPromises|promises|files|store|disk)$/i;
const PATH_BUILDERS = new Set(['join', 'resolve', 'path.join', 'path.resolve', 'posix.join', 'path.posix.join', 'normalize', 'path.normalize']);

function stringValue(node) {
  const fragments = node.namedChildren.filter((child) => child.type === 'string_fragment');
  if (fragments.length) return fragments.map((child) => child.text).join('');
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Describe a path argument WITHOUT evaluating it. A template string becomes an
 * ordered segment list plus a `path_pattern` that keeps `${…}` verbatim, so the
 * shape `work-orders/<id>/order.json` is legible and no id is invented.
 */
function describePath(node) {
  if (!node) return null;
  if (node.type === 'string') {
    const value = stringValue(node);
    return { path_kind: 'literal', path_pattern: cap(value), segments: [{ kind: 'literal', value: cap(value) }], refusal: null };
  }
  if (node.type === 'template_string') {
    const segments = [];
    let pattern = '';
    for (const child of node.children) {
      if (child.type === '`') continue;
      if (child.type === 'template_substitution') {
        const inner = child.namedChildren[0];
        const text = cap(inner ? inner.text : child.text);
        segments.push({ kind: 'expression', text });
        pattern += `\${${text}}`;
        continue;
      }
      segments.push({ kind: 'literal', value: cap(child.text) });
      pattern += child.text;
    }
    return { path_kind: 'template', path_pattern: cap(pattern), segments: segments.slice(0, SEGMENT_CAP), refusal: null };
  }
  return {
    path_kind: 'expression',
    path_pattern: null,
    segments: [{ kind: 'expression', text: cap(node.text) }],
    refusal: 'path_not_statically_readable',
  };
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!['function_declaration', 'generator_function_declaration', 'method_definition'].includes(current.type)) continue;
    return current.childForFieldName('name')?.text || null;
  }
  return null;
}

export function scanPersistence(rootNode, ctx) {
  const facts = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));
    if (node.type !== 'call_expression') continue;
    const callee = node.childForFieldName('function');
    if (!callee) continue;
    const args = node.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
    if (!args.length) continue;

    if (callee.type === 'member_expression') {
      const operation = callee.childForFieldName('property')?.text;
      const receiver = callee.childForFieldName('object')?.text || '';
      if (operation && STORAGE_OPERATIONS.has(operation) && STORAGE_RECEIVERS.test(receiver)) {
        const described = describePath(args[0]);
        if (described) {
          facts.push(ctx.fact('persistence_target', line(node), {
            operation,
            receiver: cap(receiver),
            access: /read|createReadStream/i.test(operation) ? 'read' : 'write',
            scope: enclosingFunction(node) || 'module',
            ...described,
          }));
        }
      }
    }

    const calleeText = callee.text;
    if (PATH_BUILDERS.has(calleeText)) {
      const segments = args.slice(0, SEGMENT_CAP).map((argument) => {
        if (argument.type === 'string') return { kind: 'literal', value: cap(stringValue(argument)) };
        if (argument.type === 'template_string') return { kind: 'template', text: cap(argument.text) };
        return { kind: 'expression', text: cap(argument.text) };
      });
      const literalTail = [];
      for (let index = segments.length - 1; index >= 0; index--) {
        if (segments[index].kind !== 'literal') break;
        literalTail.unshift(segments[index].value);
      }
      facts.push(ctx.fact('path_expression', line(node), {
        builder: calleeText,
        segments,
        segment_count: args.length,
        truncated: args.length > SEGMENT_CAP,
        // The trailing run of literal segments is the part of the path this
        // module can state with certainty; the leading expression segments are
        // named, not resolved.
        literal_suffix: literalTail.length ? literalTail.join('/') : null,
        scope: enclosingFunction(node) || 'module',
        refusal: literalTail.length ? null : 'no_literal_segment_in_path_expression',
      }));
    }
  }
  return facts;
}

// --- Module-header retention (the other half of Q11's witness) --------------
//
// The WorkOrder aggregate states its own root file in LINE 1 of the module:
// `// WorkOrder aggregate: root file \`work-orders/<id>/order.json\`.` That is a
// persistence declaration written as prose, and the report's §5 names it
// explicitly: "a fact stated in **line 1 of the aggregate module**." A map that
// reads the call site but not the header answers Q11 with a template pattern and
// no statement of intent; a map that reads both answers it the way the source does.
//
// Scope is deliberately narrow: the LEADING comment block only (the first
// contiguous run of comment lines from line 1), capped, and only when it
// contains a path-shaped token. A general comment dump would bury the signal.

const PATH_TOKEN = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.<>${}-]+(?:\.\w+)?)/g;
const HEADER_LINE = /^\s*(?:\/\/|\*|\/\*)\s?(.*)$/;
const HEADER_SCAN_CAP = 40;

export function scanModuleHeader(lines, ctx) {
  const collected = [];
  for (let index = 0; index < Math.min(lines.length, HEADER_SCAN_CAP); index++) {
    const match = lines[index].match(HEADER_LINE);
    if (!match) { if (lines[index].trim()) break; continue; }
    collected.push({ line: index + 1, text: match[1].trim() });
  }
  if (!collected.length) return [];
  const facts = [];
  const seen = new Set();
  for (const entry of collected) {
    for (const match of entry.text.matchAll(PATH_TOKEN)) {
      const token = match[1];
      // A bare `a/b` with no extension and no placeholder is as likely to be a
      // prose slash as a path. Require a file extension or a `<…>`/`${…}`
      // placeholder before claiming it is a persistence path.
      if (!/\.\w+$/.test(token) && !/[<${]/.test(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      facts.push(ctx.fact('persistence_target', entry.line, {
        operation: 'declared_in_module_header',
        receiver: null,
        access: 'declaration',
        scope: 'module',
        path_kind: 'documented',
        path_pattern: cap(token),
        segments: [{ kind: 'literal', value: cap(token) }],
        // A header comment is a CLAIM by the module about itself, not an
        // executed call. Marking the basis keeps a reader from citing prose as
        // if it were a call site — and lets them cross-check it against the
        // persistence_target facts minted from the real calls in the same file.
        basis: 'module_header_comment',
        comment_text: cap(entry.text),
        refusal: null,
      }));
      if (facts.length >= 8) return facts;
    }
  }
  return facts;
}
