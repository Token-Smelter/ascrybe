#!/usr/bin/env node
// Bounded read-only Cypher gateway over the serving projection.
//
// The closed command surface forces multi-turn client-side joins for questions one Cypher query
// answers directly; this gateway trades the closed verbs for a validated query while keeping the
// guarantees that mattered: no writes, no admin procedures, projection-scoped reads, a row cap
// with disclosed truncation, and typed refusals instead of opaque provider errors. It never
// accepts credentials from the caller; connection material comes from the runtime config's
// declared environment variables exactly as the command surface does.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient } from './c3-serving-projection.mjs';
import { loadEstateMapRuntimeConfig, neo4jConnectionFromConfig } from './ascrybe-config.mjs';
import { EstateGraphQueries, EstateGraphQueryError } from './estate-graph-query.mjs';

export const ESTATE_CYPHER_RESULT_SCHEMA = 'estate-map/cypher-result/v1';
export const CYPHER_ROW_CAP = 200;
const QUERY_MAX_BYTES = 8 * 1024;

function fail(code, message, detail = {}) {
  throw new EstateGraphQueryError(code, message, detail);
}

// Strings and comments are removed before any keyword scan so a literal like "CREATE TABLE" in a
// searched label cannot trip the guard, and a keyword smuggled inside a comment cannot pass it.
export function strippedQueryText(query) {
  let output = '';
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < query.length && query[index] !== quote) index += query[index] === '\\' ? 2 : 1;
      output += quote === '`' ? ' ident ' : ' text ';
      continue;
    }
    if (character === '/' && query[index + 1] === '/') {
      while (index < query.length && query[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && query[index + 1] === '*') {
      index += 2;
      while (index < query.length && !(query[index] === '*' && query[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

const WRITE_OR_ADMIN = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD|USE|PERIODIC|COMMIT|INSTALL|GRANT|DENY|REVOKE|ALTER|START|TERMINATE)\b/iu;
const PROCEDURE = /\bCALL\s+(?!\s*\{)/iu;

export function validateCypherQuery(query) {
  if (typeof query !== 'string' || !query.trim()) fail('ESTATE_CYPHER_QUERY_MISSING', 'a Cypher query string is required');
  if (Buffer.byteLength(query) > QUERY_MAX_BYTES) {
    fail('ESTATE_CYPHER_QUERY_TOO_LARGE', `query exceeds ${QUERY_MAX_BYTES} bytes`);
  }
  const stripped = strippedQueryText(query);
  if (stripped.includes(';')) fail('ESTATE_CYPHER_MULTI_STATEMENT', 'one statement per call; remove the semicolon');
  const write = stripped.match(WRITE_OR_ADMIN);
  if (write) fail('ESTATE_CYPHER_READ_ONLY', `${write[1].toUpperCase()} is not available: this surface is read-only`, { keyword: write[1] });
  // Procedures reach schema, admin, and library surfaces (db.*, dbms.*, apoc.*) that bypass both
  // the read-only guard and projection scoping. CALL { } subqueries remain available.
  if (PROCEDURE.test(stripped)) fail('ESTATE_CYPHER_PROCEDURE', 'CALL procedures are not available; only CALL { } subqueries');
  if (!/\bRETURN\b/iu.test(stripped)) fail('ESTATE_CYPHER_RETURN_REQUIRED', 'the query must RETURN rows');
  if (!stripped.includes('$projection_id')) {
    fail('ESTATE_CYPHER_UNSCOPED', 'every EstateNode pattern must scope to {projection_id: $projection_id}; the parameter is supplied by the gateway');
  }
  return stripped;
}

export function boundedCypherStatement(query, cap = CYPHER_ROW_CAP) {
  // The wrapper enforces the row cap without parsing the query: whatever the inner RETURN yields
  // becomes the outer rows, fetched to cap + 1 so truncation is a disclosed fact, never silent.
  return `CALL { ${query} } RETURN * LIMIT ${cap + 1}`;
}

export async function runCypher({ queries, query, parameters = {}, view, row_cap = CYPHER_ROW_CAP }) {
  validateCypherQuery(query);
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    fail('ESTATE_CYPHER_PARAMETERS_INVALID', 'parameters must be an object');
  }
  if ('projection_id' in parameters) {
    fail('ESTATE_CYPHER_PARAMETERS_INVALID', 'projection_id is supplied by the gateway and cannot be overridden');
  }
  const projection = await queries.projection(view);
  // RETURN * reorders the inner aliases, so rows without their column names would silently
  // misassign values. Ask the transaction endpoint directly and keep the columns.
  const { payload } = await queries.client.request('/db/neo4j/tx/commit', {
    statements: [{ statement: boundedCypherStatement(query, row_cap),
      parameters: { ...parameters, projection_id: projection.projection_id },
      resultDataContents: ['row'] }],
  });
  const result = payload.results?.[0] ?? {};
  // properties_json is stored pretty-printed for the projection's own digests; over this surface
  // the indentation is pure token weight (a 56-row neighborhood cost 40 KB). Re-serialize any
  // JSON-object string cell compactly — byte layout changes, JSON value never does.
  const compact = value => {
    if (Array.isArray(value)) return value.map(compact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
    }
    return value;
  };
  const rows = (result.data ?? []).map(row => compact(row.row));
  const truncated = rows.length > row_cap;
  return Object.freeze({
    schema: ESTATE_CYPHER_RESULT_SCHEMA,
    query: 'cypher',
    projection,
    columns: result.columns ?? [],
    row_cap,
    row_count: Math.min(rows.length, row_cap),
    truncated,
    rows: rows.slice(0, row_cap),
  });
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('ESTATE_CYPHER_ARGUMENT_INVALID', `unexpected argument ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (value === undefined) fail('ESTATE_CYPHER_ARGUMENT_INVALID', `${token} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!options.runtime_config || !options.query) {
    fail('ESTATE_CYPHER_ARGUMENT_INVALID', 'usage: estate-graph-cypher --runtime-config <path> --query <cypher> [--parameters <json>] [--view selected|working]');
  }
  return options;
}

export async function runEstateCypherCli(argv, environment = process.env) {
  const options = parseCli(argv);
  let parameters = {};
  if (options.parameters !== undefined) {
    try { parameters = JSON.parse(options.parameters); }
    catch { fail('ESTATE_CYPHER_PARAMETERS_INVALID', '--parameters must be JSON'); }
  }
  const runtime = loadEstateMapRuntimeConfig(options.runtime_config);
  const client = new Neo4jHttpClient(neo4jConnectionFromConfig(runtime, environment));
  const queries = new EstateGraphQueries({
    client,
    default_view: runtime.config.projection.default_view,
    source_repositories: runtime.config.source_repositories,
    estate: runtime.config.projection.estate,
  });
  return runCypher({ queries, query: options.query, parameters, view: options.view });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runEstateCypherCli(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || 'ESTATE_CYPHER_FAILED', message: error.message, detail: error.detail || null }));
    process.exitCode = 1;
  }
}
