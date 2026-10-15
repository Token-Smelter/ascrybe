import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHITECTURAL_ROLES, buildJevRequest, checkJevBudget, classifyWithCascade, decideJev, JEV_ENDPOINT, JEV_MODEL,
  requestJev,
} from '../tools/ontology/jev-classifier.mjs';

const widgetCode = 'export function sendWidget() { return fetch("https://invented.example/widget"); }';
const choice = criteria => ({ type: 'choice', choice: Object.keys(criteria)[0], confidence: 0.92,
  probabilities: Object.fromEntries(Object.keys(criteria).map((key, index) => [key, index === 0 ? 1 : 0])) });
const responseFor = request => ({ status: 200, ok: true, json: async () => ({
  model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', id: 'invented-id',
  usage: { input_tokens: 123, output_tokens: 5, cost: 0.000005166 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => [key, choice(q.criteria)])),
}) });

test('code uses independent role Choices rather than one mutually exclusive Choice', () => {
  const request = buildJevRequest({ kind: 'code', text: widgetCode, path: 'widgets/dispatch.mjs' });
  assert.deepEqual(Object.keys(request.questions), ARCHITECTURAL_ROLES.map((_, index) => `role_${index + 1}`));
});

test('claim Choice distinguishes none of the existing types from insufficient context', () => {
  const request = buildJevRequest({ kind: 'claim', text: 'The widget once existed.' });
  assert.deepEqual(Object.keys(request.questions.type.criteria).slice(-2), ['none_of_existing_types', 'insufficient_context']);
});

test('document Choice distinguishes none of the existing types from insufficient context', () => {
  const request = buildJevRequest({ kind: 'document', text: '# Widget memo' });
  assert.deepEqual(Object.keys(request.questions.type.criteria).slice(-2), ['none_of_existing_types', 'insufficient_context']);
});

test('oversized input is refused without truncation or calling the provider', async () => {
  const request = buildJevRequest({ kind: 'code', text: '界'.repeat(11_000) });
  let called = false;
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => { called = true; } }),
    error => error.code === 'JEV_INPUT_OVERSIZE');
  assert.equal(called, false);
  assert.equal(checkJevBudget(request).within, false);
});

test('aggregate question budget is enforced even if no individual state-plus-question exceeds 32k', () => {
  const request = { model: JEV_MODEL, state: { source: 'W'.repeat(5_000) },
    questions: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`q${index}`, { type: 'choice',
      instructions: 'R'.repeat(15_000), criteria: { yes: 'Yes', no: 'No' } }])) };
  assert.deepEqual({ within: checkJevBudget(request).within,
    longest_safe: checkJevBudget(request).longest_bytes < 30_000,
    total_over: checkJevBudget(request).total_bytes > 60_000 },
  { within: false, longest_safe: true, total_over: true });
});

test('outbound credential-shaped text is refused before provider call without echoing it', async () => {
  const secret = `sk-or-${'A'.repeat(28)}`;
  const request = buildJevRequest({ kind: 'code', text: `${widgetCode}\nconst credential='${secret}'` });
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => { throw Error('must not call'); } }),
    error => error.code === 'JEV_OUTBOUND_SECRET_REFUSED' && !error.message.includes(secret));
});

test('credential assignments are caught before JSON escaping can mask their quotes', async () => {
  const request = buildJevRequest({ kind: 'code', text: 'const password = "HighlySecretLiteralValue";' });
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => { throw Error('must not call'); } }),
    error => error.code === 'JEV_OUTBOUND_SECRET_REFUSED');
});

test('nested imported context cannot bypass the outbound credential screen', async () => {
  const request = buildJevRequest({ kind: 'code', text: widgetCode });
  request.state.context = [{ implementation: { text: `const api_key = "${'A'.repeat(32)}";` } }];
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => { throw Error('must not call'); } }),
    error => error.code === 'JEV_OUTBOUND_SECRET_REFUSED');
});

test('one SystemOne request returns response custody without a key', async () => {
  const request = buildJevRequest({ kind: 'claim', text: 'The widget exists.' });
  let invoked = null;
  const result = await requestJev(request, { apiKey: 'fixture-only', ontologyVersionDigest: 'invented-catalog-digest', fetcher: async (url, init) => {
    invoked = { url, method: init.method, body: JSON.parse(init.body) };
    return responseFor(request);
  } });
  assert.deepEqual({ ...invoked, model: result.resolved_model, cost: result.usage.cost,
    raw_probability: result.answers.type.probabilities.current_capability,
    credential_in_custody: JSON.stringify(result).includes('fixture-only'), ontology_digest: result.ontology_version_digest }, {
    url: JEV_ENDPOINT, method: 'POST', body: request,
    model: 'typesafe/jev-1.13-20260917', cost: 0.000005166,
    raw_probability: 1, credential_in_custody: false, ontology_digest: 'invented-catalog-digest',
  });
});

test('any non-Jev model response is rejected without substitution', async () => {
  const request = buildJevRequest({ kind: 'claim', text: 'The widget exists.' });
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => ({ ok: true,
    json: async () => ({ ...(await responseFor(request).json()), model: 'typesafe/jev-router' }),
  }) }), error => error.code === 'JEV_MODEL_MISMATCH');
});

test('invalid Choice probability maps are refused rather than treated as calibrated', async () => {
  const request = buildJevRequest({ kind: 'claim', text: 'The widget exists.' });
  const base = await responseFor(request).json();
  base.answers.type.probabilities = { current_capability: 1 };
  await assert.rejects(() => requestJev(request, { apiKey: 'fixture', fetcher: async () => ({ ok: true,
    json: async () => base,
  }) }), error => error.code === 'JEV_ANSWER_INVALID');
});

test('no calibrated threshold means fallback required, not a fabricated acceptance', () => {
  const request = buildJevRequest({ kind: 'document', text: 'A widget specification.' });
  const result = decideJev(request, { answers: { type: choice(request.questions.type.criteria) } });
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'fallback_required', reason: 'needs_calibration' });
});

test('a confident none remains proposed instead of being silently escalated', () => {
  const request = buildJevRequest({ kind: 'claim', text: 'Widget note.' });
  const item = { ...choice(request.questions.type.criteria), choice: 'none_of_existing_types', confidence: 0.95 };
  const result = decideJev(request, { answers: { type: item } }, { claim: 0.8 });
  assert.deepEqual({ status: result.status, type: result.type }, { status: 'proposed', type: 'none_of_existing_types' });
});

test('a low-confidence Choice requires fallback at a calibrated threshold', () => {
  const request = buildJevRequest({ kind: 'document', text: '# Unknown widget note' });
  const item = { ...choice(request.questions.type.criteria), confidence: 0.51 };
  const result = decideJev(request, { answers: { type: item } }, { document: 0.8 });
  assert.equal(result.status, 'fallback_required');
});

test('oversized source reaches only the injected fallback, with full bytes and size reason', async () => {
  const text = 'X'.repeat(40_000);
  let called = null;
  const result = await classifyWithCascade({ kind: 'claim', text,
    fallback: async ({ request, reason }) => { called = { length: request.state.source.length, reason }; return { model: 'invented-fallback' }; },
    requestOptions: { apiKey: 'fixture', fetcher: async () => { throw Error('Jev must not be called'); } },
  });
  assert.deepEqual({ status: result.status, reason: result.reason, called, jev: result.jev },
    { status: 'fallback_required', reason: 'size', called: { length: 40_000, reason: 'size' }, jev: null });
});

test('ambiguous Jev decision preserves probabilities and asks injected fallback with ambiguity reason', async () => {
  const text = 'The widget exists.';
  let reason = null;
  const request = buildJevRequest({ kind: 'claim', text });
  const result = await classifyWithCascade({ kind: 'claim', text, thresholds: { claim: 0.99 },
    fallback: async ({ reason: why, jev }) => { reason = why; return { model: 'invented-fallback', jev_choice: jev.answers.type.choice }; },
    requestOptions: { apiKey: 'fixture', fetcher: async () => responseFor(request) },
  });
  assert.deepEqual({ status: result.status, reason, probabilities: result.jev.answers.type.probabilities,
    fallback: result.fallback },
  { status: 'fallback_required', reason: 'ambiguity', probabilities: choice(request.questions.type.criteria).probabilities,
    fallback: { model: 'invented-fallback', jev_choice: 'current_capability' } });
});

test('a request uses pinned Jev rather than a moving alias', () => {
  assert.equal(buildJevRequest({ kind: 'claim', text: 'Widget.' }).model, JEV_MODEL);
});
