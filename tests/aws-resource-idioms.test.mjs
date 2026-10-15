import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import extractor from '../tools/extractors/aws.mjs';
import { extractEstate } from '../tools/extract.mjs';
import { mergeFacts } from '../tools/merge.mjs';

// Every fixture here is invented. The idioms were read from real AWS SDK call sites and real CDK
// stacks before the patterns were written -- which is the only reason any of them match anything
// -- but a public test cannot carry the estate it learned from, so these say the same shapes about
// services that do not exist.

const scan = (repo, file, source) => extractor.scan(source.split('\n'),
  { repo, file, fact: (kind, line, data) => ({ kind, repo, file, line, ...data }) });
const kinds = (facts, kind) => facts.filter(fact => fact.kind === kind);

test('an IAM grant naming an operation is not an operation, and a call carrying a target is', () => {
  const facts = scan('orders-infra', 'lib/stack.ts', [
    'new iam.PolicyStatement({',
    "  actions: ['s3:GetObject', 's3:PutObject', 'dynamodb:PutItem'],",
    "  resources: [bucket.arnForObjects('*')],",
    '});',
    "// await client.send(new PutItemCommand({ TableName: 'orders' }));",
    "await client.send(new GetObjectCommand({ Bucket: 'orders-archive', Key: key }));",
  ].join('\n'));

  // A grant carries no Bucket/TableName argument, so it names no target and is not a call.
  assert.deepEqual(kinds(facts, 'aws_usage').map(fact => `${fact.service} ${fact.op} ${fact.target_name_or_expr}`),
    ['s3 getobject orders-archive']);
  assert.equal(kinds(facts, 'aws_usage_refusal').length, 0);
});

test('a call that shares an operation name with browser storage or SQL is not an AWS operation', () => {
  const facts = scan('orders-web', 'src/draft.ts', [
    "const draft = localStorage.getItem('orders-draft');",
    "const rows = await db.query('SELECT id FROM orders WHERE status = $1', [status]);",
  ].join('\n'));
  // Neither carries the argument the AWS operation would fail without, which is the only thing
  // separating them from a call that does.
  assert.equal(kinds(facts, 'aws_usage').length, 0);
  assert.equal(kinds(facts, 'aws_usage_refusal').length, 0);
});

test('a call whose target sits two lines below it is still read', () => {
  const facts = scan('orders-api', 'src/publish.ts', [
    "const topicArn = process.env.ORDERS_TOPIC_ARN;",
    'await sns',
    '  .publish({',
    '    TopicArn: topicArn,',
    '    Message: JSON.stringify(event),',
    '  })',
    '  .promise();',
  ].join('\n'));
  const usage = kinds(facts, 'aws_usage')[0];
  assert.equal(usage.op, 'publish');
  // The variable is not the address; the environment variable it holds is what a stack binds.
  assert.equal(usage.target_env_var, 'ORDERS_TOPIC_ARN');
  assert.equal(usage.target_basis, 'environment_variable');
});

test('a target variable the file assigns twice is refused rather than resolved to the first', () => {
  const facts = scan('orders-api', 'tests/publish.test.ts', [
    "let topicArn = process.env.ORDERS_TOPIC_ARN ?? '';",
    'topicArn = await resolveTopicArn();',
    'await sns.publish({ TopicArn: topicArn, Message: body });',
  ].join('\n'));
  assert.equal(kinds(facts, 'aws_usage').length, 0);
  assert.equal(kinds(facts, 'aws_usage_refusal')[0].reason, 'assigned_more_than_once');
});

test('a module constant naming a bucket makes the operation literal', () => {
  const facts = scan('orders-backfill', 'scripts/backfill.py', [
    'S3_BUCKET = "orders-archive-production"',
    'resp = s3.get_object(Bucket=S3_BUCKET, Key=key)',
  ].join('\n'));
  const usage = kinds(facts, 'aws_usage')[0];
  assert.equal(usage.status, 'literal');
  assert.equal(usage.target_name_or_expr, 'orders-archive-production');
});

test('a CDK declaration records its binding, and keeps only a template head that addresses something', () => {
  const facts = scan('orders-infra', 'lib/stack.ts', [
    "const eventsBucket = new s3.Bucket(this, 'EventsBucket', {",
    '  bucketName: `orders-archive-${props.environment}`,',
    '});',
    "this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {",
    '  topicName: `${props.stackName}-alarms`,',
    '});',
    '    EVENTS_BUCKET_NAME: eventsBucket.bucketName,',
  ].join('\n'));
  const declarations = kinds(facts, 'aws_resource_declaration');
  assert.deepEqual(declarations.map(fact => [fact.binding, fact.declared_name_prefix]),
    // The head of `orders-archive-${env}` can only be this bucket in some environment. The literal
    // part of `${stackName}-alarms` is a suffix every stack in the account shares, so it is kept as
    // an expression and never matched on.
    [['eventsBucket', 'orders-archive-'], ['alarmTopic', null]]);
  assert.equal(declarations[1].name_basis, 'name_expression_not_literal');
  // The attribute is what says this variable holds a bucket; the variable's spelling is not evidence.
  assert.deepEqual(kinds(facts, 'aws_env_binding').map(fact => [fact.env_var, fact.binding, fact.attribute]),
    [['EVENTS_BUCKET_NAME', 'eventsBucket', 'bucketName']]);
});

// The point of everything above: an operation that names a variable is joined, across
// repositories, to the stack that declares the resource that variable holds -- with the call, the
// environment binding and the declaration all quoted -- while an operation whose variable no stack
// binds becomes a named refusal rather than an edge to a plausible neighbour.
test('operations resolve to the component that declares the resource, or refuse by name', async () => {
  const root = mkdtempSync(join(process.env.ASCRYBE_SCRATCH_DIR || tmpdir(), 'aws-join-'));
  try {
    const estate = join(root, 'estate');
    const write = (path, body) => {
      const target = join(estate, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    };
    write('orders-infra/lib/stack.ts', [
      "const eventsBucket = new s3.Bucket(this, 'EventsBucket', {",
      '  bucketName: `orders-archive-${props.environment}`,',
      '});',
      "const mergeTopic = new sns.Topic(this, 'MergeTopic', {",
      "  topicName: 'orders-merge-events',",
      '});',
      "const worker = new NodejsFunction(this, 'Worker', {",
      '  environment: {',
      '    ORDERS_TOPIC_ARN: mergeTopic.topicArn,',
      '  },',
      '});',
    ].join('\n'));
    write('orders-worker/src/publish.ts', [
      'const topicArn = process.env.ORDERS_TOPIC_ARN;',
      'await sns.publish({ TopicArn: topicArn, Message: body });',
    ].join('\n'));
    write('orders-backfill/scripts/backfill.py', [
      'S3_BUCKET = "orders-archive-production"',
      'resp = s3.get_object(Bucket=S3_BUCKET, Key=key)',
    ].join('\n'));
    // Terraform declares the same kinds of resource, and hcl.mjs already extracts them as
    // tf_resource; the resolver reads that rather than adding a second copy of the same parse.
    write('orders-ledger-infra/main.tf', [
      'resource "aws_dynamodb_table" "ledger" {',
      '  name = "orders-ledger"',
      '}',
    ].join('\n'));
    write('orders-ledger/src/write.ts',
      "await dynamodb.putItem({ TableName: 'orders-ledger', Item: item });");
    write('orders-reports/src/report.ts', [
      'const tableName = process.env.REPORTS_TABLE_NAME;',
      'await dynamodb.getItem({ TableName: tableName, Key: key });',
    ].join('\n'));

    await extractEstate(estate, join(root, 'extract'), { strict: false });
    await mergeFacts(join(root, 'extract'), join(root, 'merge'));
    const graph = JSON.parse(readFileSync(join(root, 'merge', 'estate-graph.json'), 'utf8'));
    const uses = (graph.edges || []).filter(edge => edge.kind === 'uses_aws_resource');

    assert.deepEqual(uses.map(edge => `${edge.witnesses[0].repo} ${edge.op} ${edge.resolution_basis} ${edge.status}`).sort(), [
      // The Python constant meets the literal head of the CDK template: the same bucket, in the
      // environment the constant names.
      'orders-backfill getobject declared_name_template_prefix resolved',
      'orders-ledger putitem declared_name_literal resolved',
      // Three hops, no guess: the call reads ORDERS_TOPIC_ARN, the stack binds it to mergeTopic,
      // and mergeTopic is declared in the same file.
      'orders-worker publish environment_variable_binding resolved',
    ]);
    assert.deepEqual(uses.map(edge => edge.to).sort(),
      ['repo:orders-infra', 'repo:orders-infra', 'repo:orders-ledger-infra']);
    assert.equal(uses.find(edge => edge.op === 'putitem').declaration_source, 'terraform');
    // Every hop is citable: call, binding, declaration.
    assert.equal(uses.find(edge => edge.op === 'publish').witnesses.length, 3);

    // Nothing in the estate binds REPORTS_TABLE_NAME, and inventing a table for it would be the
    // wrong edge this refuses to draw.
    const refusals = (graph.aws_resource_refusals || []).filter(record => record.stage === 'resolution');
    assert.deepEqual(refusals.map(record => record.reason),
      ['environment_variable_bound_by_no_declared_stack']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
