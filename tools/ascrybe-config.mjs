import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { sha256, stableStringify } from './lib.mjs';

export const ASCRYBE_RUNTIME_CONFIG_SCHEMA = 'estate-map/runtime-config/v1';
const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();

export class EstateMapConfigError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EstateMapConfigError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new EstateMapConfigError(code, message, detail);
}

function closed(record, fields, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('RUNTIME_CONFIG_INVALID', `${label} must be an object`);
  }
  const unknown = Object.keys(record).filter(key => !fields.includes(key));
  if (unknown.length) fail('RUNTIME_CONFIG_UNKNOWN_FIELD', `${label} contains unknown fields`, { unknown });
}

function positiveInteger(value, label, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail('RUNTIME_CONFIG_INVALID_NUMBER', `${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function modelConfig(role, input) {
  closed(input, [
    'runner', 'name', 'thinking', 'concurrency', 'window_bytes', 'timeout_ms',
    'max_event_bytes', 'max_answer_bytes',
  ], `models.${role}`);
  if (input.runner !== 'pi' || !clean(input.name)) {
    fail('RUNTIME_CONFIG_MODEL_INVALID', `models.${role} requires runner=pi and an exact Pi model name`);
  }
  if (input.thinking != null && !clean(input.thinking)) {
    fail('RUNTIME_CONFIG_MODEL_INVALID', `models.${role}.thinking must be null or a non-empty string`);
  }
  const output = {
    runner: 'pi',
    name: clean(input.name),
    thinking: input.thinking == null ? null : clean(input.thinking),
    concurrency: positiveInteger(input.concurrency, `models.${role}.concurrency`, { maximum: 256 }),
    window_bytes: positiveInteger(input.window_bytes, `models.${role}.window_bytes`, { maximum: 1024 * 1024 }),
    timeout_ms: positiveInteger(input.timeout_ms, `models.${role}.timeout_ms`),
    max_event_bytes: positiveInteger(input.max_event_bytes, `models.${role}.max_event_bytes`),
    max_answer_bytes: positiveInteger(input.max_answer_bytes, `models.${role}.max_answer_bytes`),
  };
  if (output.max_answer_bytes > output.max_event_bytes) {
    fail('RUNTIME_CONFIG_MODEL_INVALID', `models.${role}.max_answer_bytes cannot exceed max_event_bytes`);
  }
  return Object.freeze(output);
}

export function validateEstateMapRuntimeConfig(input) {
  closed(input, ['schema', 'models', 'neo4j', 'projection', 'dashboard', 'source_repositories', 'catalog_globs'], 'runtime config');
  if (input.schema !== ASCRYBE_RUNTIME_CONFIG_SCHEMA) {
    fail('RUNTIME_CONFIG_SCHEMA_UNSUPPORTED', `expected ${ASCRYBE_RUNTIME_CONFIG_SCHEMA}`);
  }
  closed(input.models, Object.keys(input.models || {}), 'models');
  const roles = Object.keys(input.models || {}).sort();
  if (!roles.includes('documentary_claims') || !roles.includes('code_claims')) {
    fail('RUNTIME_CONFIG_MODEL_ROLE_MISSING', 'models must define documentary_claims and code_claims');
  }
  if (roles.some(role => !/^[a-z][a-z0-9_]*$/u.test(role))) {
    fail('RUNTIME_CONFIG_MODEL_ROLE_INVALID', 'model role names must be lowercase identifiers');
  }
  const models = Object.freeze(Object.fromEntries(roles.map(role => [role, modelConfig(role, input.models[role])])));

  closed(input.neo4j, ['uri_env', 'username_env', 'password_env'], 'neo4j');
  const neo4j = Object.freeze(Object.fromEntries(['uri_env', 'username_env', 'password_env'].map(field => {
    const value = clean(input.neo4j?.[field]);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(value)) {
      fail('RUNTIME_CONFIG_ENV_NAME_INVALID', `neo4j.${field} must name an uppercase environment variable`);
    }
    return [field, value];
  })));

  closed(input.projection, ['batch_size', 'default_view', 'estate'], 'projection');
  const projection = Object.freeze({
    batch_size: positiveInteger(input.projection?.batch_size, 'projection.batch_size', { maximum: 10_000 }),
    default_view: ['selected', 'working'].includes(input.projection?.default_view)
      ? input.projection.default_view
      : fail('RUNTIME_CONFIG_PROJECTION_INVALID', 'projection.default_view must be selected or working'),
    // One Neo4j serves every estate. A declared id scopes this deployment's projection heads so
    // two estates can be selected at once; omitting it keeps the unqualified heads a
    // single-estate deployment already has.
    estate: input.projection?.estate === undefined ? null
      : (typeof input.projection.estate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.projection.estate)
        ? input.projection.estate
        : fail('RUNTIME_CONFIG_PROJECTION_INVALID', 'projection.estate must be a simple identifier')),
  });

  closed(input.dashboard, ['host', 'port', 'neighbor_limit', 'overview_limit'], 'dashboard');
  const dashboard = Object.freeze({
    host: clean(input.dashboard?.host),
    port: positiveInteger(input.dashboard?.port, 'dashboard.port', { maximum: 65_535 }),
    neighbor_limit: positiveInteger(input.dashboard?.neighbor_limit, 'dashboard.neighbor_limit', { maximum: 1_000 }),
    overview_limit: positiveInteger(input.dashboard?.overview_limit, 'dashboard.overview_limit', { maximum: 500 }),
  });
  if (!dashboard.host) fail('RUNTIME_CONFIG_DASHBOARD_INVALID', 'dashboard.host is required');

  const catalogGlobs = input.catalog_globs == null ? [] : input.catalog_globs;
  if (!Array.isArray(catalogGlobs) || catalogGlobs.some(pattern => typeof pattern !== 'string'
    || !pattern.trim() || pattern.startsWith('/') || pattern.includes('..'))) {
    fail('RUNTIME_CONFIG_CATALOG_GLOBS_INVALID', 'catalog_globs must be an array of non-empty repository-relative glob patterns');
  }

  const sourceRepositories = input.source_repositories == null ? {} : input.source_repositories;
  if (!sourceRepositories || typeof sourceRepositories !== 'object' || Array.isArray(sourceRepositories)) {
    fail('RUNTIME_CONFIG_REPOSITORIES_INVALID', 'source_repositories must be an object mapping repository names to absolute paths');
  }
  for (const [repository, path] of Object.entries(sourceRepositories)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repository) || !isAbsolute(clean(path))) {
      fail('RUNTIME_CONFIG_REPOSITORIES_INVALID', 'source_repositories must map simple repository names to absolute paths');
    }
  }
  const repositories = Object.freeze(Object.fromEntries(Object.entries(sourceRepositories)
    .sort(([left], [right]) => left.localeCompare(right)).map(([repository, path]) => [repository, clean(path)])));

  return Object.freeze({ schema: ASCRYBE_RUNTIME_CONFIG_SCHEMA, models, neo4j, projection, dashboard,
    catalog_globs: Object.freeze([...catalogGlobs].map(pattern => pattern.trim()).sort()),
    source_repositories: repositories });
}

export function loadEstateMapRuntimeConfig(path) {
  const absolute = resolve(path || '');
  let parsed;
  try { parsed = JSON.parse(readFileSync(absolute, 'utf8')); }
  catch (error) {
    fail('RUNTIME_CONFIG_READ_FAILED', `cannot read runtime config ${absolute}`, { cause: error.code || error.message });
  }
  const config = validateEstateMapRuntimeConfig(parsed);
  return Object.freeze({ path: absolute, config, digest: sha256(canonical(config)) });
}

export function configuredModel(runtime, role) {
  const model = runtime?.config?.models?.[role] || runtime?.models?.[role];
  if (!model) fail('RUNTIME_CONFIG_MODEL_ROLE_MISSING', `runtime config does not define model role ${role}`);
  return model;
}

export function neo4jConnectionFromConfig(runtime, environment = process.env) {
  const config = runtime?.config || runtime;
  const names = config?.neo4j;
  const values = Object.fromEntries([
    ['uri', names?.uri_env], ['username', names?.username_env], ['password', names?.password_env],
  ].map(([field, environmentName]) => [field, clean(environment[environmentName])]));
  const missing = Object.entries(values).filter(([, value]) => !value).map(([field]) => field);
  if (missing.length) {
    fail('RUNTIME_CONFIG_NEO4J_ENV_MISSING', 'Neo4j connection environment is incomplete', {
      missing, required_environment: names,
    });
  }
  return Object.freeze(values);
}

export function parsePiModelList(output) {
  const models = new Set();
  for (const line of String(output || '').split(/\r?\n/u)) {
    const [provider, name] = line.trim().split(/\s+/u);
    if (provider && name) models.add(`${provider}/${name}`);
  }
  return models;
}

export function validateConfiguredPiModels(runtime, {
  spawn = spawnSync, environment = process.env, roles = null,
} = {}) {
  const config = runtime?.config || runtime;
  const selectedRoles = roles || Object.keys(config.models).sort();
  const result = spawn('pi', ['--list-models'], { encoding: 'utf8', env: environment });
  if (result.error || result.status !== 0) {
    fail('PI_MODEL_LIST_FAILED', 'pi --list-models failed', {
      exit_code: result.status ?? null, error: result.error?.code || null,
      stderr: String(result.stderr || '').slice(0, 2_048),
    });
  }
  const available = parsePiModelList(result.stdout);
  const missing = selectedRoles.filter(role => !available.has(configuredModel(config, role).name));
  if (missing.length) {
    fail('PI_MODEL_NOT_AVAILABLE', 'configured Pi model is unavailable', {
      missing: missing.map(role => ({ role, model: config.models[role].name })),
    });
  }
  return Object.freeze({ roles: selectedRoles.slice(), models: selectedRoles.map(role => config.models[role].name) });
}
