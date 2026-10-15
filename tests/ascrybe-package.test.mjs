import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const root = new URL('../', import.meta.url);
const text = path => readFileSync(new URL(path, root), 'utf8');

test('packaged verification metadata is portable without machine-local orchestration state', () => {
  const cardText = text('.catalog/project.md');
  const end = cardText.indexOf('\n---', 4);
  const card = parseYaml(cardText.slice(4, end));
  const checks = parseYaml(text('.catalog/checks.yaml'));
  assert.deepEqual({
    id: card.id,
    machinePaths: /\/(?:home|Users)\/[^<\s/]+/u.test(cardText),
    commands: ['build', 'tests', 'lint', 'design-authority'].map(name => Boolean(checks.overrides[name]?.command?.trim())),
    privateStateIgnored: text('.gitignore').includes('/analysis/'),
  }, { id: 'ascrybe', machinePaths: false, commands: [true, true, true, true], privateStateIgnored: true });
});

test('packaged Neo4j bounds transactions so an abandoned client cannot hold locks indefinitely', () => {
  const environment = parseYaml(text('compose.yaml')).services.neo4j.environment;
  assert.deepEqual({ transaction: Boolean(environment.NEO4J_db_transaction_timeout), lock: Boolean(environment.NEO4J_db_lock_acquisition_timeout) },
    { transaction: true, lock: true });
});

test('packaged Neo4j uses the pinned official image, safe host ports, persistence, and health check', () => {
  const neo4j = parseYaml(text('compose.yaml')).services.neo4j;
  assert.deepEqual({ image: neo4j.image, ports: neo4j.ports, volumes: neo4j.volumes, health: neo4j.healthcheck.test.join(' ').includes('cypher-shell') }, {
    image: 'neo4j:5.26.14-community',
    ports: ['127.0.0.1:${ASCRYBE_NEO4J_HTTP_PORT:-7475}:7474', '127.0.0.1:${ASCRYBE_NEO4J_BOLT_PORT:-7688}:7687'],
    volumes: ['estate-map-neo4j-data:/data', 'estate-map-neo4j-logs:/logs'], health: true,
  });
});

test('package examples contain no real credential and runtime files are ignored', () => {
  const environment = text('ascrybe.env.example');
  const ignored = text('.gitignore').split(/\r?\n/u);
  assert.deepEqual({
    placeholder: environment.includes('replace-with-a-long-local-password'),
    secretLikeValue: /PASSWORD=(?!replace-)[^\n]{12,}/u.test(environment),
    envIgnored: ignored.includes('.env'),
    configIgnored: ignored.includes('*ascrybe.config.json'),
    exampleMatchedByGlob: 'ascrybe.config.example.json'.endsWith('ascrybe.config.json'),
  }, { placeholder: true, secretLikeValue: false, envIgnored: true, configIgnored: true, exampleMatchedByGlob: false });
});
