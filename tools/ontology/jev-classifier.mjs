// A proposed, source-grounded classifier, not a claim verifier or an observation writer.
// Source retrieval, independent labels and model escalation live with the private caller. This
// public adapter holds only estate-neutral questions, transport, budget and response custody.
import { createHash } from 'node:crypto';
import { SEMANTIC_INTENT_QUESTIONS } from './semantic-audit.mjs';
import { DOCUMENT_MODES } from '../document-mode.mjs';

export const JEV_CLASSIFIER_SCHEMA = 'estate-map/ontology-jev-classification/v1';
export const JEV_MODEL = 'typesafe/jev-1.13';
export const JEV_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
// TypeSafe documents both limits: state + longest question <= 32k tokens; state + ALL questions
// <= 64k. Until Jev publishes its tokenizer, UTF-8 byte length is used as a conservative upper
// bound for byte-fallback text tokenization, not chars/4. Leave 2k/4k headroom for framing.
export const JEV_LIMITS = Object.freeze({ longest_bytes: 30_000, total_bytes: 60_000 });
export const ARCHITECTURAL_ROLES = Object.freeze([
  'capability-provider', 'route-handler', 'envelope-publisher', 'envelope-consumer',
  'capability-caller', 'persistence-adapter', 'external-http-client', 'route-and-event-boundary',
]);
export const CLAIM_TYPES = Object.freeze([
  'current_capability', 'current_architecture', 'negative_capability', 'accepted_design',
  'proposed_design', 'historical_design',
]);
export const DOCUMENT_TYPES = Object.freeze(DOCUMENT_MODES.filter(mode => mode !== 'unclassified'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/u,
  /\b(?:password|passwd|secret|api[_-]?key|token)["']?\s*[=:]\s*["'`][^"'`]{8,}["'`]/iu,
]);

/** Refuse outbound source containing a credential-shaped value. Never echo matched bytes. */
export function assertOutboundSafe(state) {
  // Scan every raw nested string before EITHER backend sees a packet. JSON escaping can hide
  // assignment quotes, and String(object) hides entire imported-source bundles as [object Object].
  const pending = [state];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (SECRET_PATTERNS.some(pattern => pattern.test(value))) {
        fail('JEV_OUTBOUND_SECRET_REFUSED', 'source contains credential-shaped text; no request sent');
      }
    } else if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
}

function roleQuestions() {
  return Object.fromEntries(ARCHITECTURAL_ROLES.map((role, index) => [`role_${index + 1}`, {
    type: 'choice',
    instructions: `For PRODUCTION architecture only, ${SEMANTIC_INTENT_QUESTIONS[role]} Judge the provided code itself, not comments predicting future behavior.`,
    criteria: {
      member: 'The shown production code actually has this architectural role; a test or fixture alone is not sufficient.',
      not_member: 'The shown code is not an instance of this role (including test-only or fixture-only implementation).',
      insufficient_evidence: 'The supplied code does not settle whether this production role applies.',
    },
  }]));
}

const CLAIM_CRITERIA = Object.freeze({
  current_capability: 'A current, affirmative capability attributed to the system.',
  current_architecture: 'A current arrangement or structural relationship among system parts.',
  negative_capability: 'A current explicit absence, prohibition or unsupported capability.',
  accepted_design: 'An adopted design decision or rule, regardless of whether it has been implemented.',
  proposed_design: 'An intended or suggested change not yet adopted as the current design.',
  historical_design: 'A past or superseded design described as historical.',
  none_of_existing_types: 'The passage clearly makes a claim, but none of the six listed claim types applies.',
  insufficient_context: 'The supplied passage cannot establish which type applies.',
});
const DOCUMENT_CRITERIA = Object.freeze({
  specification: 'Specifies what the system is or must do.',
  decision: 'Records a design choice and its rationale or consequences.',
  plan: 'States intended work or milestones, not what is already built.',
  research: 'Explores hypotheses, options or outside-world facts.',
  report: 'States findings of an executed analysis, run, review or audit.',
  log: 'Chronological record of events or a session.',
  record: 'External artifact kept by the estate, such as a ticket or correspondence.',
  none_of_existing_types: 'The document clearly has another type outside this vocabulary.',
  insufficient_context: 'The supplied document does not give enough context to identify a type.',
});

/** Independent Choice per architectural role; mutually exclusive Choice only for a single type. */
export function buildJevRequest({ kind, text, path = null }) {
  if (!['code', 'claim', 'document'].includes(kind) || typeof text !== 'string' || !text.trim()) {
    fail('JEV_INPUT_INVALID', 'kind must be code, claim or document with nonempty source text');
  }
  const state = { kind, path, source: text };
  const questions = kind === 'code' ? roleQuestions() : {
    type: {
      type: 'choice',
      instructions: kind === 'claim'
        ? 'Which ONE type best describes the claim in `source`? Classify what is asserted, not whether the assertion is true or verified. Distinguish an actual none from missing context.'
        : 'Which ONE document mode best describes `source`? Use the path only as contextual evidence; distinguish an actual other mode from missing context.',
      criteria: kind === 'claim' ? CLAIM_CRITERIA : DOCUMENT_CRITERIA,
    },
  };
  return Object.freeze({ model: JEV_MODEL, state, questions });
}

/** No truncation and no chars/4 estimate. Deliberately conservative for unknown tokenizer. */
export function checkJevBudget(request) {
  const stateBytes = bytes(request.state);
  const questionBytes = Object.values(request.questions).map(bytes);
  const longest = stateBytes + Math.max(...questionBytes);
  const total = stateBytes + questionBytes.reduce((sum, n) => sum + n, 0);
  return Object.freeze({ within: longest <= JEV_LIMITS.longest_bytes && total <= JEV_LIMITS.total_bytes,
    state_bytes: stateBytes, longest_bytes: longest, total_bytes: total, method: 'utf8_byte_upper_bound' });
}

function validateAnswers(request, response) {
  if (!response || typeof response.model !== 'string' || !response.model.startsWith('typesafe/jev-1.13-')) {
    fail('JEV_MODEL_MISMATCH', 'response did not name the pinned Jev 1.13 snapshot');
  }
  if (!Number.isFinite(response.usage?.cost) || response.usage.cost < 0
    || !Number.isInteger(response.usage?.input_tokens) || response.usage.input_tokens < 0) {
    fail('JEV_USAGE_MISSING', 'response lacked measured token usage and cost');
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers?.[id];
    if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)
      || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
      || Object.keys(answer.probabilities ?? {}).length !== Object.keys(question.criteria).length
      || Object.keys(question.criteria).some(option => !Number.isFinite(answer.probabilities[option]))
      || Object.values(answer.probabilities).some(p => !Number.isFinite(p) || p < 0 || p > 1)
      || Math.abs(Object.values(answer.probabilities).reduce((total, p) => total + p, 0) - 1) > 0.02) {
      fail('JEV_ANSWER_INVALID', `invalid Choice answer for ${id}`);
    }
  }
}

/** Makes one direct SystemOne request. The key exists only in the bearer header, never in custody. */
export async function requestJev(request, {
  fetcher = fetch, apiKey = process.env.OPENROUTER_API_KEY, timeoutMs = 30_000,
  ontologyVersionDigest = null,
} = {}) {
  const budget = checkJevBudget(request);
  if (!budget.within) fail('JEV_INPUT_OVERSIZE', 'state and questions exceed conservative Jev budget; no request sent');
  assertOutboundSafe(request.state);
  if (!apiKey) fail('JEV_CREDENTIAL_MISSING', 'OpenRouter API key unavailable');
  const started = performance.now();
  let response;
  try {
    response = await fetcher(JEV_ENDPOINT, { method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    fail('JEV_TRANSPORT_FAILED', `Jev request failed (${error.name})`);
  }
  if (!response.ok) {
    // Do not copy server response text: it can echo source content or headers.
    fail('JEV_HTTP_FAILED', `Jev HTTP ${response.status}`);
  }
  let result;
  try { result = await response.json(); }
  catch { fail('JEV_RESPONSE_INVALID', 'Jev returned non-JSON'); }
  validateAnswers(request, result);
  return Object.freeze({
    schema: JEV_CLASSIFIER_SCHEMA, request_digest: hash(request), state_digest: hash(request.state),
    questions_digest: hash(request.questions), ontology_version_digest: ontologyVersionDigest,
    requested_model: JEV_MODEL, resolved_model: result.model,
    provider: result.provider ?? null, request_id: result.id ?? null, answers: result.answers,
    usage: result.usage, latency_ms: Math.round(performance.now() - started), budget,
  });
}

/** Thresholds are an EXTERNAL calibration artifact. No guessed threshold or automatic witness. */
export function decideJev(request, custody, thresholds = {}) {
  const answer = custody.answers;
  if (request.state.kind === 'code') {
    const roles = {};
    let ambiguous = false;
    for (const [index, role] of ARCHITECTURAL_ROLES.entries()) {
      const item = answer[`role_${index + 1}`];
      const threshold = thresholds[role];
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        roles[role] = { outcome: 'needs_calibration', answer: item }; ambiguous = true; continue;
      }
      const resolved = item.confidence >= threshold ? item.choice : 'ambiguous';
      roles[role] = { outcome: resolved, answer: item };
      if (resolved === 'ambiguous' || resolved === 'insufficient_evidence') ambiguous = true;
    }
    return Object.freeze({ status: ambiguous ? 'fallback_required' : 'proposed', roles });
  }
  const item = answer.type;
  const threshold = thresholds[request.state.kind];
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return Object.freeze({ status: 'fallback_required', reason: 'needs_calibration', answer: item });
  }
  const resolved = item.confidence >= threshold ? item.choice : 'ambiguous';
  return Object.freeze({ status: resolved === 'ambiguous' || resolved === 'insufficient_context' ? 'fallback_required' : 'proposed',
    type: resolved, answer: item });
}

/** One source state, one Jev call, optional caller-owned Primary escalation. A source that contains
 * credential-shaped bytes never goes to EITHER provider. A source that exceeds Jev's budget goes
 * directly to the fallback with its full bytes (no truncation). A low-confidence/uncalibrated
 * answer or explicit insufficiency escalates after keeping Jev's entire probability distribution.
 * The fallback is injected rather than hardcoded here: model routes and estate data stay in the
 * private caller, and absence of the callback is an explicit pending fallback, never an accepted
 * classification. This returns proposals only; it cannot create ontology memberships/witnesses. */
export async function classifyWithCascade({
  kind, text, path = null, thresholds = {}, fallback = null, requestOptions = {},
}) {
  const request = buildJevRequest({ kind, text, path });
  assertOutboundSafe(request.state);
  const budget = checkJevBudget(request);
  if (!budget.within) {
    const escalated = fallback ? await fallback({ request, reason: 'size', budget }) : null;
    return Object.freeze({ status: 'fallback_required', reason: 'size', budget, jev: null, fallback: escalated });
  }
  const custody = await requestJev(request, requestOptions);
  const proposal = decideJev(request, custody, thresholds);
  if (proposal.status === 'proposed') return Object.freeze({ status: 'proposed', proposal, jev: custody, fallback: null });
  const escalated = fallback ? await fallback({ request, reason: 'ambiguity', budget, jev: custody }) : null;
  return Object.freeze({ status: 'fallback_required', reason: 'ambiguity', proposal, jev: custody, fallback: escalated });
}
