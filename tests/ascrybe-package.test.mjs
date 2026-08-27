import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const root = new URL('../', import.meta.url);
const text = path => readFileSync(new URL(path, root), 'utf8');

test('packaged Neo4j bounds transactions so an abandoned client cannot hold locks indefinitely', () => {
  const environment = parseYaml(text('compose.yaml')).services.neo4j.environment;
  assert.deepEqual({
    transaction: Boolean(environment.NEO4J_db_transaction_timeout),
    lock: Boolean(environment.NEO4J_db_lock_acquisition_timeout),
  }, { transaction: true, lock: true });
});

test('packaged Neo4j uses the pinned official image, safe host ports, persistence, and health check', () => {
  const compose = parseYaml(text('compose.yaml'));
  const neo4j = compose.services.neo4j;
  assert.deepEqual({
    image: neo4j.image,
    ports: neo4j.ports,
    volumes: neo4j.volumes,
    health: neo4j.healthcheck.test.join(' ').includes('cypher-shell'),
  }, {
    image: 'neo4j:5.26.14-community',
    ports: [
      '127.0.0.1:${ASCRYBE_NEO4J_HTTP_PORT:-7475}:7474',
      '127.0.0.1:${ASCRYBE_NEO4J_BOLT_PORT:-7688}:7687',
    ],
    volumes: ['estate-map-neo4j-data:/data', 'estate-map-neo4j-logs:/logs'],
    health: true,
  });
});

test('package examples contain no real credential and runtime files are ignored', () => {
  const environment = text('ascrybe.env.example');
  const ignored = text('.gitignore').split(/\r?\n/u);
  assert.deepEqual({
    placeholder: environment.includes('replace-with-a-long-local-password'),
    secretLikeValue: /PASSWORD=(?!replace-)[^\n]{12,}/u.test(environment),
    envIgnored: ignored.includes('.env'),
    // One config per estate, so the rule is a glob. The tracked example must survive it.
    configIgnored: ignored.includes('*ascrybe.config.json'),
    // The glob ends in the same suffix, so prove it cannot swallow the tracked example.
    exampleMatchedByGlob: 'ascrybe.config.example.json'.endsWith('ascrybe.config.json'),
  }, { placeholder: true, secretLikeValue: false, envIgnored: true, configIgnored: true, exampleMatchedByGlob: false });
});

test('governed documents are not rewritten by a product rename', () => {
  // Twice now a repository-wide rename has rewritten records: first twelve archived files under
  // analysis/ and reviews/, then a governed rollout plan at the repository root. A record edited
  // to match a name it never carried is the thing this repository argues against, and only the
  // second case was caught by a gate -- the first was excluded from the gate's own scope.
  // The ledger governs a design campaign that belongs to the private record, so a distribution
  // that does not carry it has nothing to check rather than something to fail.
  if (!existsSync(new URL('../DESIGN-AUTHORITY-LEDGER.json', import.meta.url))) return;
  const ledger = JSON.parse(text('DESIGN-AUTHORITY-LEDGER.json'));
  const governed = ledger.documents.map(row => row.document_id);
  const offenders = governed.filter(path => {
    try { return text(path).includes('Ascrybe'); } catch { return false; }
  });
  assert.deepEqual(offenders, [],
    `governed documents were rewritten by a rename: ${offenders.join(', ')}`);
});
