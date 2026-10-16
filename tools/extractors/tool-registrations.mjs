// Preserve source witnesses; do not infer authority from naming conventions alone.

const TEXT_CAP = 300;
const KEY_CAP = 64;

const cap = (text, limit = TEXT_CAP) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};
const line = (node) => node.startPosition.row + 1;

const REGISTRATION_CALLEES = new Set(['registerTool', 'defineTool', 'addTool', 'registerTools', 'tool']);

function stringValue(node) {
  if (!node) return null;
  if (node.type === 'string') {
    const fragments = node.namedChildren.filter((child) => child.type === 'string_fragment');
    return fragments.length ? fragments.map((child) => child.text).join('') : node.text.replace(/^['"]|['"]$/g, '');
  }
  if (node.type === 'template_string' && !node.namedChildren.some((child) => child.type === 'template_substitution')) {
    return node.text.replace(/^`|`$/g, '');
  }
  return null;
}

function objectPairs(node) {
  const pairs = new Map();
  if (!node || node.type !== 'object') return pairs;
  for (const child of node.namedChildren) {
    if (child.type !== 'pair' && child.type !== 'method_definition') continue;
    const keyNode = child.childForFieldName(child.type === 'pair' ? 'key' : 'name');
    if (!keyNode) continue;
    const key = keyNode.type === 'string' ? stringValue(keyNode) : keyNode.text;
    if (key) pairs.set(key, { key: keyNode, value: child.childForFieldName('value') || child });
  }
  return pairs;
}

/**
 * Read the declared parameter KEY LIST from the estate's `Type.Object({ … })`
 * idiom. Only the key names are taken: the value side is a schema-builder call
 * whose meaning this module does not attempt to render.
 */
function parameterKeys(node) {
  if (!node) return null;
  let target = node;
  if (target.type === 'call_expression') {
    const args = target.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
    target = args[0];
  }
  if (!target || target.type !== 'object') return null;
  return [...objectPairs(target).keys()].map((key) => cap(key, KEY_CAP)).sort();
}

export function scanToolRegistrations(rootNode, ctx) {
  const facts = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    for (let index = node.namedChildCount - 1; index >= 0; index--) stack.push(node.namedChild(index));
    if (node.type !== 'call_expression') continue;
    const callee = node.childForFieldName('function');
    if (!callee) continue;
    const calleeName = callee.type === 'member_expression' ? callee.childForFieldName('property')?.text : callee.text;
    if (!calleeName || !REGISTRATION_CALLEES.has(calleeName)) continue;
    const receiver = callee.type === 'member_expression' ? cap(callee.childForFieldName('object')?.text || '', KEY_CAP) : null;
    // A bare `tool(...)` with no receiver is too generic to claim as a tool
    // registration; require the estate's real member-call shape for that name.
    if (calleeName === 'tool' && !receiver) continue;
    const args = node.childForFieldName('arguments')?.namedChildren.filter((child) => child.type !== 'comment') || [];
    const spec = args.find((argument) => argument.type === 'object');

    if (!spec) {
      facts.push(ctx.fact('tool_registration_refusal', line(node), {
        registrar: calleeName,
        receiver,
        reason: 'tool_spec_is_not_an_object_literal',
      }));
      continue;
    }

    const pairs = objectPairs(spec);
    const nameNode = pairs.get('name');
    const name = nameNode ? stringValue(nameNode.value) : null;
    const label = pairs.get('label') ? stringValue(pairs.get('label').value) : null;
    const description = pairs.get('description') ? stringValue(pairs.get('description').value) : null;
    const sourceLine = nameNode ? line(nameNode.key) : line(node);
    if (!name) {
      facts.push(ctx.fact('tool_registration_refusal', sourceLine, {
        registrar: calleeName, receiver, reason: 'tool_name_is_not_a_string_literal',
        call_line: line(node),
      }));
      continue;
    }
    facts.push(ctx.fact('tool_registration', sourceLine, {
      registrar: calleeName,
      receiver,
      name,
      label: label ? cap(label) : null,
      description: description ? cap(description) : null,
      parameter_keys: parameterKeys(pairs.get('parameters')?.value),
      spec_keys: [...pairs.keys()].sort(),
      call_line: line(node),
    }));
  }
  return facts;
}
