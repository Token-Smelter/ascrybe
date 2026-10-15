// Proposed ontology classification: ONE sealed input and answer contract for a selected Pi model
// and optional SystemOne acceleration. This module writes no graph nodes, memberships or decisions.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertOutboundSafe, checkJevBudget, JEV_MODEL, requestJev } from './jev-classifier.mjs';
import { canonical, fail } from './schemas.mjs';

export const CLASSIFICATION_PACKET_SCHEMA = 'estate-map/ontology-classification-packet/v1';
export const CLASSIFICATION_RESULT_SCHEMA = 'estate-map/ontology-classification-result/v1';
export const GAP_CANDIDATE_SCHEMA = 'estate-map/ontology-gap-candidate/v1';
export const GAP_ANALYSIS_SCHEMA = 'estate-map/ontology-gap-analysis/v1';
export const EVALUATION_MANIFEST_SCHEMA = 'estate-map/ontology-classifier-evaluation-manifest/v1';
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const statuses = Object.freeze(['classified', 'no_existing_type', 'insufficient_evidence', 'out_of_scope']);
const clean = value => String(value ?? '').trim();
const validSha = value => /^[0-9a-f]{40}$/u.test(value);
const validHash = value => /^[0-9a-f]{64}$/u.test(value);
const noSecrets = value => assertOutboundSafe(value); // same screen before both transports and analysis

function pinnedSource(source, repository) {
  if (!validSha(source.commit_sha) || !clean(source.path) || source.path.startsWith('/')
    || source.path.split('/').includes('..') || !validHash(source.content_sha256)
    || !/^[0-9a-f]{40}$/u.test(source.blob_oid) || !Number.isInteger(source.start_line)
    || !Number.isInteger(source.end_line) || source.start_line < 1 || source.end_line < source.start_line
    || typeof source.text !== 'string') fail('CLASSIFICATION_SOURCE_INVALID', 'source needs an exact commit, safe relative path, blob, digest and line bounds');
  if (digest(source.text) !== source.content_sha256) {
    fail('CLASSIFICATION_SOURCE_DIGEST_MISMATCH', 'source excerpt differs from its recorded bytes');
  }
  if (repository) {
    let file, oid;
    try {
      oid = execFileSync('git', ['-C', repository, 'rev-parse', `${source.commit_sha}:${source.path}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      file = execFileSync('git', ['-C', repository, 'show', `${source.commit_sha}:${source.path}`],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { fail('CLASSIFICATION_SOURCE_NOT_AT_PIN', 'pinned source is absent from the local Git object database'); }
    if (oid !== source.blob_oid || file.split('\n').slice(source.start_line - 1, source.end_line).join('\n') !== source.text) {
      fail('CLASSIFICATION_SOURCE_NOT_AT_PIN', 'source excerpt or blob differs from pinned Git object');
    }
  }
  return Object.freeze({ path: source.path, commit_sha: source.commit_sha, blob_oid: source.blob_oid,
    content_sha256: source.content_sha256, start_line: source.start_line, end_line: source.end_line,
    role: source.role ?? 'primary', text: source.text });
}

function taxonomyFor(input) {
  if (!Array.isArray(input.concepts) || !input.concepts.length || input.concepts.length > 40
    || !validHash(input.ontology_version_digest)) fail('CLASSIFICATION_TAXONOMY_INVALID', 'concepts and ontology version digest are required');
  const seen = new Set();
  const concepts = input.concepts.map(concept => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(concept.id ?? '') || seen.has(concept.id)
      || ['no_existing_type', 'insufficient_evidence', 'out_of_scope', 'existing_type'].includes(concept.id)
      || !clean(concept.label) || !clean(concept.definition) || !clean(concept.boundary)) {
      fail('CLASSIFICATION_TAXONOMY_INVALID', 'each concept needs a distinct id, label, definition and boundary');
    }
    seen.add(concept.id);
    return Object.freeze({ id: concept.id, label: concept.label, definition: concept.definition, boundary: concept.boundary });
  });
  if (input.ontology_version_digest !== digest(concepts)) {
    fail('CLASSIFICATION_TAXONOMY_DIGEST_MISMATCH', 'taxonomy definitions differ from the claimed ontology version digest');
  }
  const cardinality = input.cardinality ?? (input.kind === 'code' ? 'many_to_many' : 'exclusive');
  if (!['many_to_many', 'exclusive'].includes(cardinality)) {
    fail('CLASSIFICATION_TAXONOMY_INVALID', 'cardinality must be many_to_many or exclusive');
  }
  return Object.freeze({ ontology_version_digest: input.ontology_version_digest, concepts, cardinality });
}

/** A provider-neutral packet: immutable logical state and questions, never provider-specific prose. */
export function buildClassificationPacket(input, { repository = null } = {}) {
  if (!['code', 'claim', 'document'].includes(input?.kind) || !['Module', 'Plugin', 'Claim', 'Document'].includes(input?.subject?.kind)
    || !clean(input.subject?.node_id) || !clean(input.subject?.projection_id)
    || !['production', 'tooling', 'test', 'fixture', 'documentary', 'unknown'].includes(input.subject?.provenance)
    || !['own_code', 'plugin_owned_implementation', 'document_source'].includes(input.subject?.scope)) {
    fail('CLASSIFICATION_INPUT_INVALID', 'kind and scoped, provenance-bearing subject are required');
  }
  if ((input.kind === 'code') !== ['Module', 'Plugin'].includes(input.subject.kind)) {
    fail('CLASSIFICATION_INPUT_INVALID', 'code subjects must be Module/Plugin; claim/document subjects must use their own kinds');
  }
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 16) {
    fail('CLASSIFICATION_SOURCE_INVALID', 'one through sixteen pinned sources are required');
  }
  const sources = input.sources.map(row => pinnedSource(row, repository));
  if (new Set(sources.map(row => row.commit_sha)).size !== 1 || !sources.some(row => row.role === 'primary')) {
    fail('CLASSIFICATION_SOURCE_INVALID', 'all source spans must have one commit and at least one primary');
  }
  const taxonomy = taxonomyFor({ ...input.taxonomy, kind: input.kind });
  const body = {
    schema: CLASSIFICATION_PACKET_SCHEMA, kind: input.kind,
    subject: { kind: input.subject.kind, node_id: input.subject.node_id, projection_id: input.subject.projection_id,
      provenance: input.subject.provenance, scope: input.subject.scope },
    sources, taxonomy,
    // Source-grounded definitions travel with the same packet to BOTH backends. A classifier may
    // read these, but may not write source witnesses or modify deterministic observations.
    assembly_policy: 'exact_pinned_primary_plus_declared_context/v1',
    question_policy: 'independent_roles_and_explicit_coverage/v1',
  };
  noSecrets(body);
  return Object.freeze({ ...body, packet_id: `ontology-classification-packet:${digest(body)}` });
}

/** All typed questions are derived from the sealed packet, not from backend-specific prompts. */
export function verifyClassificationPacket(packet) {
  if (packet?.schema !== CLASSIFICATION_PACKET_SCHEMA || !packet.packet_id) {
    fail('CLASSIFICATION_PACKET_INVALID', 'sealed packet required');
  }
  const { packet_id: packetId, ...body } = packet;
  if (packetId !== `ontology-classification-packet:${digest(body)}`) {
    fail('CLASSIFICATION_PACKET_INVALID', 'packet bytes differ from sealed identity');
  }
  if (!Array.isArray(packet.sources) || packet.sources.some(s => typeof s.text !== 'string' || digest(s.text) !== s.content_sha256)
    || !Array.isArray(packet.taxonomy?.concepts)
    || packet.taxonomy.ontology_version_digest !== digest(packet.taxonomy.concepts)) {
    fail('CLASSIFICATION_PACKET_INVALID', 'packet source or taxonomy digest differs from its sealed content');
  }
  return packet;
}

export function classificationQuestions(packet) {
  const questions = {};
  if (packet.kind === 'code' || packet.taxonomy.cardinality === 'many_to_many') {
    packet.taxonomy.concepts.forEach((concept, index) => {
      const isCode = packet.kind === 'code';
      questions[`role_${index + 1}`] = { type: 'choice',
        instructions: `For scoped ${packet.subject.kind} source and ${packet.subject.provenance} provenance, does it have the ${concept.label} ${isCode ? 'architectural role' : 'interpreted concept'}? ${concept.definition} Boundary: ${concept.boundary} ${isCode ? 'A called imported implementation counts for actual usage if attached; ownership is distinct. Test/fixture-only is not production membership.' : 'One document can express several concepts at once; a cited quote is a claim, not implementation proof.'}`,
        criteria: { member: isCode ? 'Production role applies to the scoped subject, directly or via evidenced owned/used implementation.' : 'The source excerpt supports this interpreted concept for this subject.',
          not_member: 'Adequate context rules this concept out for the scoped subject.',
          insufficient_evidence: 'Necessary source, context or definition boundary is not established.',
          out_of_scope: 'Subject is outside the concept scheme.' } };
    });
  } else {
    questions.type = { type: 'choice',
      instructions: `Which ONE existing ${packet.kind} type fits the scoped source? This is classification, not verification of the claim's behavior. Use no_existing_type only when the evidence is adequate AND none of the listed definitions fits.`,
      criteria: { ...Object.fromEntries(packet.taxonomy.concepts.map(c => [c.id, `${c.label}: ${c.definition} Boundary: ${c.boundary}`])),
        no_existing_type: 'Adequate in-scope source clearly has a type outside every listed definition.',
        insufficient_evidence: 'Needed source/context is missing or definitions are ambiguous.',
        out_of_scope: 'This subject is outside the specified scheme.' } };
  }
  questions.coverage = { type: 'choice',
    instructions: 'Does this scoped subject fit at least one existing category in the supplied taxonomy? Judge coverage separately from each role. Eight negative role judgments alone are NOT proof of a novel category.',
    criteria: { existing_type: 'At least one named category fits with sufficient source evidence.',
      no_existing_type: 'Adequate in-scope evidence shows a coherent role/type not covered by ANY existing category.',
      insufficient_evidence: 'Cannot decide taxonomy coverage from this source or definitions.',
      out_of_scope: 'Subject is outside the taxonomy scope.' } };
  return Object.freeze(questions);
}

function normalize(packet, answers, backend) {
  const questions = classificationQuestions(packet);
  const choices = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = answers?.[id];
    const choice = backend === 'system_one' ? raw?.choice : raw;
    if (!Object.hasOwn(question.criteria, choice)) fail('CLASSIFICATION_RESPONSE_INVALID', `answer ${id} is not in the packet vocabulary`);
    choices[id] = choice;
  }
  const coverage = choices.coverage;
  if (packet.kind === 'code' || packet.taxonomy.cardinality === 'many_to_many') {
    const roles = Object.fromEntries(packet.taxonomy.concepts.map((c, i) => [c.id, choices[`role_${i + 1}`]]));
    const members = Object.entries(roles).filter(([, outcome]) => outcome === 'member').map(([id]) => id);
    if (members.length && coverage !== 'existing_type') fail('CLASSIFICATION_RESPONSE_INVALID', 'a member role conflicts with non-existing/out-of-scope coverage');
    if (coverage === 'existing_type' && !members.length) fail('CLASSIFICATION_RESPONSE_INVALID', 'existing-type coverage has no member role');
    const status = coverage === 'existing_type' ? 'classified' : coverage;
    return { status, roles, selected_type_ids: members, coverage };
  }
  const selected = choices.type;
  const expectedCoverage = packet.taxonomy.concepts.some(c => c.id === selected) ? 'existing_type' : selected;
  if (coverage !== expectedCoverage) fail('CLASSIFICATION_RESPONSE_INVALID', 'type conflicts with taxonomy coverage');
  const status = expectedCoverage === 'existing_type' ? 'classified' : selected;
  return { status, roles: null, selected_type_ids: status === 'classified' ? [selected] : [], coverage };
}

function llmPrompt(packet, questions) {
  return ['Classify the source; do not verify runtime behavior, invent witnesses, or silently fill missing context.',
    'Every question is independent except the explicit coverage consistency check. Return only JSON:',
    JSON.stringify(Object.fromEntries(Object.keys(questions).map(id => [id, '<one criteria key>']))),
    'Packet:', JSON.stringify(packet), 'Questions:', JSON.stringify(questions)].join('\n');
}

/** Injectable Pi transport; the default makes an actual selected-model call over stdin. */
export async function callClassificationLlm(packet, questions, model, { spawnPi = spawn, maxInputBytes = 100_000 } = {}) {
  noSecrets(packet);
  const prompt = llmPrompt(packet, questions);
  if (Buffer.byteLength(prompt, 'utf8') > maxInputBytes) {
    fail('CLASSIFICATION_LLM_CONTEXT_OVERSIZE', 'whole packet exceeds selected LLM input budget; retrieve context rather than truncate');
  }
  const [provider, ...parts] = clean(model.name).split('/');
  if (!provider || !parts.length) fail('CLASSIFICATION_LLM_MODEL_INVALID', 'selected LLM needs provider/model');
  return await new Promise((resolve, reject) => {
    const child = spawnPi('pi', ['--provider', provider, '--model', parts.join('/'), '--thinking', model.thinking || 'off',
      '--no-tools', '--no-extensions', '--no-session', '--mode', 'json', '--print'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderrLength = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), model.timeout_ms ?? 90_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderrLength += data.length; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(`selected LLM exited ${code}, stderr bytes ${stderrLength}`), { code: 'CLASSIFICATION_LLM_UNAVAILABLE' }));
      const events = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const message = events.findLast(event => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
      if (message?.provider !== provider || message?.model !== parts.join('/')) {
        return reject(Object.assign(new Error('selected model did not answer'), { code: 'CLASSIFICATION_LLM_MODEL_MISMATCH' }));
      }
      let answers;
      try { answers = JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join('')); }
      catch { return reject(Object.assign(new Error('selected LLM returned non-JSON'), { code: 'CLASSIFICATION_LLM_RESPONSE_INVALID' })); }
      resolve({ answers, model: `${message.provider}/${message.model}`, usage: message.usage,
        requested_thinking: model.thinking ?? 'off', actual_reasoning_effort: (model.thinking === 'off' ? 'low' : model.thinking) });
    });
    child.stdin.end(prompt);
  });
}

/** Different transports, one packet. A failed/absent Jev attempt is visible, never free. */
export async function classifyOntologyPacket({ packet, runtime, environment = process.env, systemOne = requestJev,
  llm = callClassificationLlm, maxSystemOneAttempts = 2, retryDelayMs = 1_000 }) {
  verifyClassificationPacket(packet);
  noSecrets(packet);
  const config = runtime?.config ?? runtime;
  const policy = config?.ontology_classification ?? { llm_role: 'code_claims', system_one: null, llm_max_input_bytes: 100_000 };
  const selectedModel = config?.models?.[policy.llm_role];
  if (!selectedModel) fail('CLASSIFICATION_LLM_MODEL_INVALID', 'selected classification model role is absent');
  const questions = classificationQuestions(packet);
  const systemRequest = { model: JEV_MODEL, state: packet, questions };
  const budget = checkJevBudget(systemRequest);
  const configIdentity = { kind: packet.kind, subject_scope: packet.subject.scope,
    llm_role: policy.llm_role, llm_name: selectedModel.name,
    llm_thinking: selectedModel.thinking, llm_max_input_bytes: policy.llm_max_input_bytes,
    system_one: policy.system_one ? { model: policy.system_one.model, credential_env: policy.system_one.credential_env } : null,
    scaffold_digest: digest(questions), ontology_version_digest: packet.taxonomy.ontology_version_digest,
    assembly_policy: packet.assembly_policy, budget_policy: budget.method, routing_policy: 'system_one_then_selected_llm_on_failure_size_or_uncertainty/v1',
    thresholds: null, evaluation_rating: null };
  const configuration_id = `ontology-classifier-config:${digest(configIdentity)}`;
  const attempts = [];
  let answer = null, source = null, nativeProbabilities = null, nativeAnswers = null, fallbackReason = null, used = null;
  const accelerator = policy.system_one;
  if (!accelerator) fallbackReason = 'system_one_not_configured';
  else if (!clean(environment[accelerator.credential_env])) {
    fallbackReason = 'system_one_credential_absent';
    attempts.push({ backend: 'system_one', requested_model: accelerator.model, resolved_model: null,
      status: 'not_dispatched', reason_code: fallbackReason, cost_usd: null, latency_ms: 0 });
  } else if (!budget.within) {
    fallbackReason = 'system_one_context_oversize';
    attempts.push({ backend: 'system_one', requested_model: accelerator.model, resolved_model: null,
      status: 'not_dispatched', reason_code: fallbackReason, cost_usd: null, latency_ms: 0 });
  } else {
    for (let index = 0; index < maxSystemOneAttempts; index++) {
      const began = performance.now();
      let receipt = null;
      try {
        receipt = await systemOne(systemRequest, { apiKey: environment[accelerator.credential_env],
          ontologyVersionDigest: packet.taxonomy.ontology_version_digest });
        attempts.push({ backend: 'system_one', requested_model: accelerator.model, resolved_model: receipt.resolved_model,
          status: 'answered', cost_usd: receipt.usage?.cost ?? null, usage: receipt.usage,
          latency_ms: receipt.latency_ms ?? Math.round(performance.now() - began), request_digest: receipt.request_digest });
        nativeAnswers = receipt.answers;
        nativeProbabilities = Object.fromEntries(Object.entries(receipt.answers).map(([id, row]) => [id, row.probabilities]));
        const possible = normalize(packet, receipt.answers, 'system_one');
        // No uncalibrated confidence threshold is a safe-acceptance policy. Only the typed
        // insufficient finding requests more context; no_existing_type is preserved as a gap.
        const uncertain = possible.status === 'insufficient_evidence'
          || Object.values(receipt.answers).some(row => row.choice === 'insufficient_evidence');
        if (!uncertain) { answer = possible; source = 'system_one'; used = receipt; }
        else fallbackReason = 'native_uncertainty_or_missing_context';
        break;
      } catch (error) {
        // A response received and billed before classification validation failed is already an
        // answered attempt in the receipt above. Do not write a second 'failed, cost unknown'
        // attempt or retry a purchase whose result was already durably observed.
        if (receipt) { fallbackReason = error.code ?? 'system_one_answer_unusable'; break; }
        attempts.push({ backend: 'system_one', requested_model: accelerator.model, resolved_model: null,
          status: 'failed', reason_code: error.code ?? 'SYSTEM_ONE_FAILED', cost_usd: null,
          latency_ms: Math.round(performance.now() - began) });
        fallbackReason = error.code ?? 'system_one_failed';
        if (!['JEV_HTTP_FAILED', 'JEV_TRANSPORT_FAILED'].includes(error.code) || index + 1 >= maxSystemOneAttempts) break;
        if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  if (!answer) {
    const began = performance.now();
    try {
      const response = await llm(packet, questions, selectedModel, { maxInputBytes: policy.llm_max_input_bytes });
      const parsed = normalize(packet, response.answers, 'llm');
      attempts.push({ backend: 'llm', requested_model: selectedModel.name, resolved_model: response.model,
        requested_thinking: selectedModel.thinking, actual_reasoning_effort: response.actual_reasoning_effort ?? null,
        status: 'answered', cost_usd: response.usage?.cost?.total ?? null, usage: response.usage,
        latency_ms: Math.round(performance.now() - began) });
      answer = parsed; source = 'llm'; used = response;
    } catch (error) {
      const oversize = error.code === 'CLASSIFICATION_LLM_CONTEXT_OVERSIZE';
      attempts.push({ backend: 'llm', requested_model: selectedModel.name, resolved_model: null,
        status: oversize ? 'needs_context' : 'failed', reason_code: error.code ?? 'CLASSIFICATION_LLM_UNAVAILABLE',
        cost_usd: null, latency_ms: Math.round(performance.now() - began) });
      return Object.freeze({ schema: CLASSIFICATION_RESULT_SCHEMA, packet_id: packet.packet_id, configuration_id,
        status: oversize ? 'needs_context' : 'pending', reason_code: attempts.at(-1).reason_code, fallback_reason: fallbackReason,
        selected_type_ids: [], roles: null, coverage: null, backend: null, model: null,
        native_probabilities: nativeProbabilities, native_answers: nativeAnswers,
        attempts, receipt_id: `ontology-classification-receipt:${digest({ packet_id: packet.packet_id, configuration_id, attempts })}` });
    }
  }
  const body = { schema: CLASSIFICATION_RESULT_SCHEMA, packet_id: packet.packet_id, configuration_id,
    status: answer.status, coverage: answer.coverage, roles: answer.roles, selected_type_ids: answer.selected_type_ids,
    backend: source, model: source === 'llm' ? used.model : used.resolved_model,
    native_probabilities: nativeProbabilities, native_answers: nativeAnswers,
    fallback_reason: fallbackReason, attempts };
  if (!statuses.includes(body.status)) fail('CLASSIFICATION_RESPONSE_INVALID', 'unsupported classification status');
  return Object.freeze({ ...body, receipt_id: `ontology-classification-receipt:${digest(body)}` });
}

/** A coverage gap is an analysis candidate, never an accepted concept or observation. */
export function gapCandidate(packet, result) {
  if (result.status !== 'no_existing_type' || result.packet_id !== packet.packet_id) {
    fail('ONTOLOGY_GAP_INVALID', 'only an explicit no_existing_type result creates a gap candidate');
  }
  const body = { schema: GAP_CANDIDATE_SCHEMA, subject: packet.subject, sources: packet.sources,
    packet_id: packet.packet_id, ontology_version_digest: packet.taxonomy.ontology_version_digest,
    classification_receipt_id: result.receipt_id, backend: result.backend, model: result.model,
    status: 'proposed', proposal_kind: 'needs_analysis' };
  // Repeated runs against the SAME subject+taxonomy+source are one gap regardless of backend.
  return Object.freeze({ ...body, gap_id: `ontology-gap:${digest({ subject: body.subject, sources: body.sources.map(s => [s.path, s.content_sha256]), ontology_version_digest: body.ontology_version_digest })}` });
}

export function appendGapCandidate(queuePath, candidate) {
  const path = resolve(queuePath);
  let lock;
  try { lock = openSync(`${path}.lock`, 'wx', 0o600); }
  catch { fail('ONTOLOGY_GAP_QUEUE_BUSY', 'gap queue is locked; retry after the writer settles'); }
  try {
    const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    if (rows.some(row => row.gap_id === candidate.gap_id)) return false;
    appendFileSync(path, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
    return true;
  } finally { closeSync(lock); unlinkSync(`${path}.lock`); }
}

export async function analyzeGap({ candidate, packet, runtime, llm = callClassificationLlm }) {
  verifyClassificationPacket(packet);
  if (candidate?.gap_id !== gapCandidate(packet, { status: 'no_existing_type', packet_id: packet.packet_id,
    receipt_id: candidate.classification_receipt_id, backend: candidate.backend, model: candidate.model }).gap_id) {
    fail('ONTOLOGY_GAP_INVALID', 'gap candidate does not match pinned packet and ontology version');
  }
  noSecrets(packet);
  const config = runtime?.config ?? runtime;
  const policy = config.ontology_classification ?? { llm_role: 'code_claims', llm_max_input_bytes: 100_000 };
  const model = config.models[policy.llm_role];
  const questions = { analysis: { type: 'choice',
    instructions: 'For this explicit no-existing-type candidate, does the source justify a genuinely novel concept, reveal missing context, expose an ambiguous existing definition, or fall outside this scheme? Propose only; never accept a new ontology version.',
    criteria: { novel_concept: 'Coherent new concept outside every existing definition, with sufficient evidence.',
      missing_context: 'More pinned source is needed to decide fit.', ambiguous_definition: 'An existing boundary is ambiguous and needs clarification.',
      out_of_scope: 'Subject is outside this scheme.' } } };
  // This is a NEW analysis packet, not a silent rewrite of the original classification input.
  const analysisPacket = { ...packet, schema: 'estate-map/ontology-gap-analysis-packet/v1',
    parent_packet_id: packet.packet_id, gap_candidate: {
      gap_id: candidate.gap_id, classification_receipt_id: candidate.classification_receipt_id,
      backend: candidate.backend, model: candidate.model, disposition: 'no_existing_type',
    } };
  const analysisPacketId = `ontology-gap-analysis-packet:${digest(analysisPacket)}`;
  try {
    const response = await llm(analysisPacket, questions, model, { maxInputBytes: policy.llm_max_input_bytes });
    const choice = response.answers?.analysis;
    if (!Object.hasOwn(questions.analysis.criteria, choice)) fail('ONTOLOGY_GAP_ANALYSIS_INVALID', 'analysis response outside closed vocabulary');
    return Object.freeze({ schema: GAP_ANALYSIS_SCHEMA, gap_id: candidate.gap_id,
      analysis_packet_id: analysisPacketId, status: 'proposed',
      finding: choice, ontology_version_digest: packet.taxonomy.ontology_version_digest,
      model: response.model, usage: response.usage ?? null, accepted: false });
  } catch (error) {
    return Object.freeze({ schema: GAP_ANALYSIS_SCHEMA, gap_id: candidate.gap_id,
      analysis_packet_id: analysisPacketId, status: 'pending',
      reason_code: error.code ?? 'ONTOLOGY_GAP_ANALYSIS_UNAVAILABLE', accepted: false });
  }
}

/** Evaluation authority belongs to an exact measured configuration, never to a model name alone. */
export function classificationEvaluationManifest({ packet, runtime, result, split, metrics = null }) {
  if (!['unassigned', 'calibration', 'held_out'].includes(split)) {
    fail('CLASSIFICATION_EVAL_SPLIT_INVALID', 'split must be unassigned, calibration or held_out');
  }
  const body = { schema: EVALUATION_MANIFEST_SCHEMA, configuration_id: result.configuration_id,
    packet_id: packet.packet_id, ontology_version_digest: packet.taxonomy.ontology_version_digest,
    scaffold_digest: digest(classificationQuestions(packet)), assembly_policy: packet.assembly_policy,
    scope: packet.subject.scope, routing_policy: 'system_one_then_selected_llm_on_failure_size_or_uncertainty/v1',
    budgets: { system_one: checkJevBudget({ state: packet, questions: classificationQuestions(packet) }),
      llm_max_input_bytes: (runtime?.config ?? runtime).ontology_classification?.llm_max_input_bytes ?? 100_000 },
    thresholds: null, split, actual_models: result.attempts.map(a => ({ backend: a.backend,
      requested: a.requested_model, resolved: a.resolved_model, reasoning: a.actual_reasoning_effort ?? null })),
    metrics, recommended: false };
  return Object.freeze({ ...body, manifest_id: `ontology-classifier-eval:${digest(body)}` });
}
