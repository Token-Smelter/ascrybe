import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  configuredModel, neo4jConnectionFromConfig, parsePiModelList,
  validateConfiguredPiModels, validateEstateMapRuntimeConfig,
} from '../tools/ascrybe-config.mjs';

function fixture() {
  return {
    schema: 'estate-map/runtime-config/v1',
    models: {
      documentary_claims: {
        runner: 'pi', name: 'provider/documentary', thinking: null, concurrency: 4,
        window_bytes: 4000, timeout_ms: 600000,
        max_event_bytes: 536870912, max_answer_bytes: 4194304,
      },
      code_claims: {
        runner: 'pi', name: 'provider/code', thinking: 'low', concurrency: 3,
        window_bytes: 5000, timeout_ms: 600000,
        max_event_bytes: 536870912, max_answer_bytes: 4194304,
      },
    },
    neo4j: {
      uri_env: 'ASCRYBE_NEO4J_URI', username_env: 'ASCRYBE_NEO4J_USERNAME',
      password_env: 'ASCRYBE_NEO4J_PASSWORD',
    },
    projection: { batch_size: 500, default_view: 'selected' },
    dashboard: { host: '127.0.0.1', port: 8790, neighbor_limit: 120, overview_limit: 100 },
  };
}

test('runtime config resolves model roles and Neo4j secrets without storing secret values', () => {
  const config = validateEstateMapRuntimeConfig(fixture());
  const connection = neo4jConnectionFromConfig(config, {
    ASCRYBE_NEO4J_URI: 'http://127.0.0.1:7475',
    ASCRYBE_NEO4J_USERNAME: 'neo4j', ASCRYBE_NEO4J_PASSWORD: 'secret',
  });
  assert.deepEqual({ model: configuredModel(config, 'documentary_claims').name, connection }, {
    model: 'provider/documentary',
    connection: { uri: 'http://127.0.0.1:7475', username: 'neo4j', password: 'secret' },
  });
});

test('runtime config refuses omitted roles, unknown fields, invalid Pi runner names, and unsafe source repositories', () => {
  const cases = [];
  const missing = fixture(); delete missing.models.code_claims; cases.push(missing);
  const unknown = fixture(); unknown.models.documentary_claims.fallback_model = 'hidden/default'; cases.push(unknown);
  const runner = fixture(); runner.models.documentary_claims.runner = 'direct-api'; cases.push(runner);
  const repository = fixture(); repository.source_repositories = { estate: 'relative/path' }; cases.push(repository);
  assert.deepEqual(cases.map(input => {
    try { validateEstateMapRuntimeConfig(input); return null; }
    catch (error) { return error.code; }
  }), ['RUNTIME_CONFIG_MODEL_ROLE_MISSING', 'RUNTIME_CONFIG_UNKNOWN_FIELD', 'RUNTIME_CONFIG_MODEL_INVALID',
    'RUNTIME_CONFIG_REPOSITORIES_INVALID']);
});

test('ontology classification config selects a Pi role and optional pinned SystemOne key reference', () => {
  const input = fixture();
  input.ontology_classification = { llm_role: 'documentary_claims', llm_max_input_bytes: 48000,
    system_one: { model: 'typesafe/jev-1.13', credential_env: 'OPENROUTER_API_KEY' } };
  const config = validateEstateMapRuntimeConfig(input);
  assert.deepEqual(config.ontology_classification, input.ontology_classification);
});

test('unknown ontology role and moving accelerator alias fail closed', () => {
  const invalidRole = fixture(); invalidRole.ontology_classification = { llm_role: 'missing_role' };
  const moving = fixture(); moving.ontology_classification = {
    system_one: { model: '~typesafe/jev-latest', credential_env: 'OPENROUTER_API_KEY' },
  };
  assert.deepEqual([invalidRole, moving].map(input => {
    try { validateEstateMapRuntimeConfig(input); return null; } catch (error) { return error.code; }
  }), ['RUNTIME_CONFIG_CLASSIFICATION_ROLE_INVALID', 'RUNTIME_CONFIG_CLASSIFICATION_ACCELERATOR_INVALID']);
});

test('runtime config preserves explicit logical source repository paths', () => {
  const input = fixture();
  input.source_repositories = { 'home-estate': '/srv/home-estate' };
  assert.deepEqual(validateEstateMapRuntimeConfig(input).source_repositories,
    { 'home-estate': '/srv/home-estate' });
});

test('runtime config defaults catalog globs to empty and rejects unsafe catalog paths', () => {
  assert.deepEqual(validateEstateMapRuntimeConfig(fixture()).catalog_globs, []);
  const configured = fixture(); configured.catalog_globs = ['catalogs/**/*.yaml', 'checks/*.json'];
  assert.deepEqual(validateEstateMapRuntimeConfig(configured).catalog_globs,
    ['catalogs/**/*.yaml', 'checks/*.json']);
  const unsafe = fixture(); unsafe.catalog_globs = ['../catalogs/*.yaml'];
  assert.throws(() => validateEstateMapRuntimeConfig(unsafe),
    error => error.code === 'RUNTIME_CONFIG_CATALOG_GLOBS_INVALID');
});

test('Pi model preflight requires every configured role by exact provider and name', () => {
  const config = validateEstateMapRuntimeConfig(fixture());
  const spawn = () => ({ status: 0, stdout: 'provider documentary\nprovider code\n', stderr: '' });
  assert.deepEqual(validateConfiguredPiModels(config, { spawn }), {
    roles: ['code_claims', 'documentary_claims'], models: ['provider/code', 'provider/documentary'],
  });
  assert.deepEqual([...parsePiModelList('provider documentary\nother model\n')].sort(),
    ['other/model', 'provider/documentary']);
});

test('Pi model preflight reports the missing configured role without fallback', () => {
  const config = validateEstateMapRuntimeConfig(fixture());
  assert.throws(() => validateConfiguredPiModels(config, {
    spawn: () => ({ status: 0, stdout: 'provider documentary\n', stderr: '' }),
  }), error => error.code === 'PI_MODEL_NOT_AVAILABLE'
    && error.detail.missing[0].role === 'code_claims');
});

// Nothing validated the shipped example against the closed validator, so a key added to one and
// not the other would only be found by a new user copying it. It is also the only place a
// multi-repository estate is DECLARED rather than described: source_repositories is the estate's
// membership -- what materialize builds and what read-span later resolves bytes through -- and
// projection.estate is what keeps two estates' heads apart in the one Neo4j they share.
test('the shipped example config validates and declares a multi-repository estate', () => {
  const example = validateEstateMapRuntimeConfig(JSON.parse(
    readFileSync(new URL('../ascrybe.config.example.json', import.meta.url), 'utf8')));
  assert.deepEqual({
    repositories: Object.keys(example.source_repositories).length > 1,
    estate: example.projection.estate,
  }, { repositories: true, estate: 'example-estate' });
});

test('every model role pins its reasoning level explicitly', () => {
  // `thinking: null` means the --thinking flag is never passed, so the provider's own default
  // decides. That is not a setting, it is an absence someone else fills in. The same model with
  // the same null config cost $0.0124/window on 2026-08-16 and $0.0657/window ten days later --
  // a five-fold change nothing in the repository could have noticed, because nothing declared
  // what the level was supposed to be.
  const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const configs = ['ascrybe.config.example.json'];
  for (const path of configs) {
    const runtime = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
    for (const [role, model] of Object.entries(runtime.models ?? {})) {
      assert.ok(levels.has(model.thinking),
        `${path}: ${role} must pin a reasoning level, got ${JSON.stringify(model.thinking)}`);
    }
  }
});
