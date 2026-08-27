import { randomUUID } from 'node:crypto';

const QUESTION_FIELDS = new Set(['question_id', 'prompt', 'answer_kind', 'key_id', 'family', 'stratum', 'stratum_evidence', 'derivation']);
const ANSWER_KINDS = new Set(['set', 'scalar', 'prose']);
const STRATUM_EVIDENCE_FIELDS = new Set(['producer_citations', 'independent_key_receipt_digest', 'graph_probes', 'gap_proof']);
const DERIVATION_ADAPTERS = new Set(['yaml-records', 'syntax-records', 'tree-paths']);

function copy(value) { return structuredClone(value); }
function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

// Question rows are a controller-only envelope. Rejecting unknown fields before any model
// process starts makes it impossible to accidentally promote an answer, key alias, or transcript
// into the arm prompt during a future schema extension.
export function validateQuestion(question) {
  if (!record(question) || Object.keys(question).some(key => !QUESTION_FIELDS.has(key))) {
    throw new Error('evaluation question has unsupported fields');
  }
  for (const field of ['question_id', 'prompt', 'key_id', 'stratum']) {
    if (typeof question[field] !== 'string' || !question[field].trim()) throw new Error(`evaluation question ${field} must be a non-empty string`);
  }
  if (!ANSWER_KINDS.has(question.answer_kind)) throw new Error('evaluation question answer_kind is invalid');
  if (question.family !== undefined && (typeof question.family !== 'string' || !question.family.trim())) {
    throw new Error('evaluation question family must be a non-empty string');
  }
  if (typeof question.stratum !== 'string' || !question.stratum.trim()) {
    throw new Error('evaluation question stratum must be a non-empty string');
  }
  if (question.stratum_evidence !== undefined && (!record(question.stratum_evidence)
    || Object.keys(question.stratum_evidence).some(key => !STRATUM_EVIDENCE_FIELDS.has(key)))) {
    throw new Error('evaluation question stratum_evidence is invalid');
  }
  if (question.derivation !== undefined && (!record(question.derivation)
    || Object.keys(question.derivation).some(key => !['adapter', 'specification'].includes(key))
    || !DERIVATION_ADAPTERS.has(question.derivation.adapter))) {
    throw new Error('evaluation question derivation is invalid');
  }
  return true;
}

export function publicQuestion(question) {
  validateQuestion(question);
  return freeze({ question_id: question.question_id, prompt: question.prompt, answer_kind: question.answer_kind });
}

export function createArmContext({ question, arm, toolSchema, nonce = randomUUID() }) {
  if (!['filesystem', 'graph', 'both'].includes(arm)) throw new Error('unknown evaluation arm');
  return freeze({
    context_id: nonce,
    arm,
    question: publicQuestion(question),
    tool_schema: copy(toolSchema),
  });
}

export function assertIsolatedContext(context) {
  if (!record(context) || Object.keys(context).sort().join(',') !== 'arm,context_id,question,tool_schema'
    || !record(context.question) || Object.keys(context.question).sort().join(',') !== 'answer_kind,prompt,question_id') {
    throw new Error('isolated context does not match the public question contract');
  }
  if (!ANSWER_KINDS.has(context.question.answer_kind)
    || typeof context.question.question_id !== 'string' || typeof context.question.prompt !== 'string') {
    throw new Error('isolated context question is invalid');
  }
  return true;
}
