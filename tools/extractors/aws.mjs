
const CAMEL_TO_SNAKE = value => value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();

// service, normalized op, the argument that names the target, and the snake_case spelling of that
// argument boto3 uses. The op name doubles as the v3 command prefix (`PublishCommand`).
const OPERATIONS = Object.freeze([
  ['publish', 'sns', 'publish', 'TopicArn'],
  ['sendMessage', 'sqs', 'sendmessage', 'QueueUrl'],
  ['getObject', 's3', 'getobject', 'Bucket'],
  ['putObject', 's3', 'putobject', 'Bucket'],
  ['putItem', 'dynamodb', 'putitem', 'TableName'],
  ['getItem', 'dynamodb', 'getitem', 'TableName'],
  ['updateItem', 'dynamodb', 'updateitem', 'TableName'],
  ['deleteItem', 'dynamodb', 'deleteitem', 'TableName'],
  ['query', 'dynamodb', 'query', 'TableName'],
  ['scan', 'dynamodb', 'scan', 'TableName'],
  ['getParameter', 'ssm', 'get_parameter', 'Name'],
].map(([method, service, op, property]) => Object.freeze({
  service, op, property,
  // `.publish(` / `.put_item(` / `.PublishAsync(` / `new PublishCommand(`.
  call: new RegExp(`(?:\\.\\s*(?:${method}|${CAMEL_TO_SNAKE(method)})(?:Async)?|\\bnew\\s+${method[0].toUpperCase()}${method.slice(1)}Command)\\s*\\(`, 'iu'),
  command: new RegExp(`\\bnew\\s+${method[0].toUpperCase()}${method.slice(1)}Command\\s*\\(`, 'u'),
  snake: new RegExp(`\\.\\s*${CAMEL_TO_SNAKE(method)}\\s*\\(`, 'u'),
  // `TopicArn: x`, `TopicArn = x`, `topic_arn=x`. Where the value ENDS is decided by
  // argumentValue, not by this pattern, because an argument can contain commas and braces.
  target: new RegExp(`\\b(?:${property}|${CAMEL_TO_SNAKE(property)})\\s*[:=]\\s*`, 'u'),
})));

// CDK resource constructors. The namespace decides the service, so `new s3.Bucket` is a bucket
// and a same-named construct from another library is not silently claimed as one.
const CDK_RESOURCES = Object.freeze({
  sns: { Topic: ['topic', 'topicName'] },
  sqs: { Queue: ['queue', 'queueName'] },
  s3: { Bucket: ['bucket', 'bucketName'] },
  dynamodb: { Table: ['table', 'tableName'] },
});
const CDK_DECLARATION = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|this\.([A-Za-z_$][\w$]*))?\s*=?\s*new\s+(sns|sqs|s3|dynamodb)\s*\.\s*(Topic|Queue|Bucket|Table)\s*\(/u;
const CDK_CONSTRUCT_ID = /new\s+(?:sns|sqs|s3|dynamodb)\s*\.\s*(?:Topic|Queue|Bucket|Table)\s*\(\s*[^,]+,\s*([`'"])([^`'"]*)\1/u;

// Which resource attribute a CDK environment value reads. This is what says the variable holds a
// topic rather than a table, independently of what the variable is called.
const CDK_ATTRIBUTES = '(?:topicArn|topicName|queueUrl|queueArn|queueName|bucketName|bucketArn|tableName|tableArn)';
// `ORDERS_TOPIC_ARN: mergeTopic.topicArn,` inside a function's `environment` object.
const ENV_OBJECT_BINDING = new RegExp(`^\\s*([A-Z][A-Z0-9_]*)\\s*:\\s*(?:[\\w$]+\\.)*([\\w$]+)\\.(${CDK_ATTRIBUTES})\\s*,?\\s*$`, 'u');
// `fn.addEnvironment('ORDERS_TOPIC_ARN', this.mergeTopic.topicArn);`
const ENV_METHOD_BINDING = new RegExp(`\\.addEnvironment\\s*\\(\\s*['"\`]([A-Z][A-Z0-9_]*)['"\`]\\s*,\\s*(?:[\\w$]+\\.)*([\\w$]+)\\.(${CDK_ATTRIBUTES})\\s*\\)`, 'u');

const STRING_LITERAL = /^(['"])(.*)\1$/u;
const TEMPLATE = /^`([^`]*)`$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const ENVIRONMENT_READ = /(?:process\s*\.\s*env\s*\.\s*([A-Za-z_][\w]*)|process\s*\.\s*env\s*\[\s*['"]([^'"]+)['"]\s*\]|os\s*\.\s*environ\s*\[\s*['"]([^'"]+)['"]\s*\]|os\s*\.\s*(?:getenv|environ\s*\.\s*get)\s*\(\s*['"]([^'"]+)['"])/u;
// Commented-out code is not code. A real stack carries a disabled `// this.jtiTable = new
// dynamodb.Table(` and a real test carries a commented assertion naming `dynamodb:PutItem`; both
// read as declarations and operations to a pattern that does not look at the line's first
// characters, and neither exists at run time.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/u;
const CALL_WINDOW_LINES = 12;
const TEMPLATE_PREFIX_MIN = 8;

/**
 * The text of a call's argument list, from the line the call opens on until its parentheses
 * balance. Bounded, because an unbalanced window would run to the end of the file and pick up a
 * `TableName:` belonging to a different call entirely.
 */
export function callWindow(lines, index, limit = CALL_WINDOW_LINES) {
  const held = [];
  let depth = 0;
  let opened = false;
  for (let at = index; at < lines.length && at < index + limit; at += 1) {
    held.push(lines[at]);
    for (const character of lines[at]) {
      if (character === '(') { depth += 1; opened = true; } else if (character === ')') depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return held.join('\n');
}

/** The literal head of a template literal, or null when it is too short to address anything. */
export function templatePrefix(value) {
  const held = TEMPLATE.exec(String(value || ''));
  if (!held || !held[1].includes('${')) return null;
  const head = held[1].slice(0, held[1].indexOf('${'));
  if (!head) return null;
  // Both bars, not either: `oa-pay-` is two segments and addresses every stack in an account,
  // and eight characters of one segment is a word rather than an address.
  return head.split(/[-/_.]/u).filter(Boolean).length >= 2 && head.length >= TEMPLATE_PREFIX_MIN ? head : null;
}

/**
 * One argument, read from where its value starts to where the ARGUMENT ends rather than where the
 * line does. `Bucket: getBucketName(),` ends at the comma but carries its own parentheses;
 * `Name: name })` ends at a brace that belongs to the enclosing object; and
 * `` Name: `/orders/${env}/topic` `` contains a brace that belongs to neither. Quotes are tracked
 * so a separator inside a string never ends the argument, and depth so one inside a nested call
 * never does either.
 */
export function argumentValue(text) {
  let depth = 0;
  let quote = null;
  let held = '';
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quote) { held += character; if (character === quote && text[at - 1] !== '\\') quote = null; continue; }
    if (character === '\'' || character === '"' || character === '`') { quote = character; held += character; continue; }
    if (character === '\n') break;
    if ('([{'.includes(character)) { depth += 1; held += character; continue; }
    if (')]}'.includes(character)) { if (depth === 0) break; depth -= 1; held += character; continue; }
    if ((character === ',' || character === ';') && depth === 0) break;
    held += character;
  }
  return held.trim();
}

/** What an expression says about the resource it names, without evaluating it. */
export function classifyTarget(raw) {
  const expression = String(raw || '').trim();
  if (!expression) return { basis: 'target_property_empty', expression };
  const quoted = STRING_LITERAL.exec(expression);
  if (quoted) return { basis: 'literal', name: quoted[2], expression };
  const template = TEMPLATE.exec(expression);
  if (template && !template[1].includes('${')) return { basis: 'literal', name: template[1], expression };
  if (template) return { basis: 'template_expression', prefix: templatePrefix(expression), expression };
  if (IDENTIFIER.test(expression)) return { basis: 'identifier', identifier: expression, expression };
  return { basis: 'expression', expression };
}

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
export function resolveName(lines, name) {
  const declaration = new RegExp(`(?:^|\\b)(?:const|let|var)?\\s*${name}\\s*(?::[^=]+)?=\\s*(.+?)\\s*;?\\s*$`, 'u');
  const found = [];
  for (const line of lines) {
    if (COMMENT_LINE.test(line)) continue;
    const held = declaration.exec(line);
    if (!held) continue;
    const value = held[1].trim();
    const environment = ENVIRONMENT_READ.exec(value);
    if (environment) { found.push({ env_var: environment.slice(1).find(Boolean), basis: 'environment_read' }); continue; }
    const quoted = STRING_LITERAL.exec(value) || TEMPLATE.exec(value);
    if (quoted && !String(quoted[2] ?? quoted[1]).includes('${')) {
      found.push({ name: quoted[2] ?? quoted[1], basis: 'file_constant' });
      continue;
    }
    found.push({ basis: 'not_groundable', expression: value.slice(0, 120) });
  }
  if (!found.length) return { basis: 'not_assigned_in_file' };
  const distinct = [...new Set(found.map(entry => `${entry.basis}\0${entry.env_var || entry.name || ''}`))];
  return distinct.length === 1 ? found[0] : { basis: 'assigned_more_than_once' };
}

const REFUSAL_DETAIL = Object.freeze({
  expression: 'the target argument is an expression rather than a name, so what it evaluates to is decided at run time and is not derivable from bytes on disk',
  template_expression: 'the target argument is a template literal with no literal head long enough to address a resource',
  target_property_empty: 'the target argument is present but empty',
  not_assigned_in_file: 'the target names a variable this file never assigns — a parameter, an import, or a field set elsewhere',
  assigned_more_than_once: 'the target names a variable this file assigns more than once, so which value reaches this call is not decided by the bytes',
  not_groundable: 'the target names a variable assigned neither an environment read nor a string literal',
});

function operationFacts(lines, index, ctx) {
  const facts = [];
  for (const operation of OPERATIONS) {
    if (!operation.call.test(lines[index])) continue;
    const window = callWindow(lines, index);
    const argument = operation.target.exec(window);
    const value = argument ? argumentValue(window.slice(argument.index + argument[0].length)) : null;
    // No target argument means this is not that operation: an IAM grant naming `s3:GetObject`, a
    // `localStorage.getItem`, a SQL `.query(`. Recognising it anyway is how the previous
    // extractor filled the graph with grants.
    if (!argument) continue;
    const base = { service: operation.service, op: operation.op, target_property: operation.property,
      idiom: operation.command.test(lines[index]) ? 'sdk_v3_command'
        : operation.snake.test(lines[index]) ? 'boto3_keyword' : 'sdk_v2_method' };
    const held = classifyTarget(value);
    const refuse = (reason, extra = {}) => facts.push(ctx.fact('aws_usage_refusal', index + 1, {
      ...base, reason, reason_detail: REFUSAL_DETAIL[reason] || reason,
      examined: 'target_argument', target_expression: held.expression, ...extra,
    }));
    const usage = (fields, status = 'dynamic') => facts.push(ctx.fact('aws_usage', index + 1, {
      ...base, status, target_expression: held.expression, ...fields,
    }));
    if (held.basis === 'literal') { usage({ target_name_or_expr: held.name, target_basis: 'literal' }, 'literal'); break; }
    if (held.basis === 'template_expression') {
      if (!held.prefix) { refuse('template_expression'); break; }
      usage({ target_name_or_expr: held.expression, target_basis: 'template_literal_prefix', target_name_prefix: held.prefix });
      break;
    }
    if (held.basis !== 'identifier') { refuse(held.basis); break; }
    const resolved = resolveName(lines, held.identifier);
    if (resolved.basis === 'environment_read') {
      usage({ target_name_or_expr: held.identifier, target_basis: 'environment_variable', target_env_var: resolved.env_var });
      break;
    }
    if (resolved.basis === 'file_constant') {
      usage({ target_name_or_expr: resolved.name, target_basis: 'file_constant_resolved' }, 'literal');
      break;
    }
    refuse(resolved.basis, { target_identifier: held.identifier });
    break;
  }
  return facts;
}

function declarationFact(lines, index, ctx) {
  const held = CDK_DECLARATION.exec(lines[index]);
  if (!held) return null;
  const [, constant, property, namespace, construct] = held;
  const [resource_kind, nameProperty] = CDK_RESOURCES[namespace][construct];
  const window = callWindow(lines, index);
  const declared = new RegExp(`\\b${nameProperty}\\s*:\\s*`, 'u').exec(window);
  const name = declared
    ? classifyTarget(argumentValue(window.slice(declared.index + declared[0].length)))
    : { basis: 'name_property_absent', expression: null };
  const identifier = CDK_CONSTRUCT_ID.exec(lines[index]);
  return ctx.fact('aws_resource_declaration', index + 1, {
    service: namespace, resource_kind, construct: `${namespace}.${construct}`,
    // The variable the construct is bound to. This is what an environment binding cites, and it
    // is exact where the declared name is usually a template.
    binding: constant || property || null,
    construct_id: identifier ? identifier[2] : null,
    declared_name: name.basis === 'literal' ? name.name : null,
    declared_name_prefix: name.basis === 'template_expression' ? (name.prefix || null) : null,
    name_expression: name.basis === 'literal' ? null : name.expression,
    name_basis: name.basis === 'literal' ? 'literal'
      : name.basis === 'template_expression' && name.prefix ? 'template_literal_prefix'
        : name.basis === 'name_property_absent' ? 'name_property_absent' : 'name_expression_not_literal',
  });
}

export default {
  kind: 'aws_usage',
  filePattern: /\.(?:cs|py|[cm]?[jt]sx?)$/i,
  scan(lines, ctx) {
    const facts = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (COMMENT_LINE.test(line)) continue;
      facts.push(...operationFacts(lines, index, ctx));
      const declaration = declarationFact(lines, index, ctx);
      if (declaration) facts.push(declaration);
      const objectBinding = ENV_OBJECT_BINDING.exec(line) || ENV_METHOD_BINDING.exec(line);
      if (objectBinding) {
        facts.push(ctx.fact('aws_env_binding', index + 1, {
          env_var: objectBinding[1], binding: objectBinding[2], attribute: objectBinding[3],
        }));
      }
    }
    // An SSM parameter read whose name IS a literal is also a config key read, which is what
    // joins a component to the parameter another component declares. Emitted from the resolved
    // fact so a name recovered from a file constant counts exactly as a quoted one does.
    for (const fact of facts.filter(value => value.kind === 'aws_usage' && value.service === 'ssm' && value.status === 'literal')) {
      facts.push(ctx.fact('config_key', fact.line, { key_name: fact.target_name_or_expr, role: 'read' }));
    }
    return facts;
  },
};
