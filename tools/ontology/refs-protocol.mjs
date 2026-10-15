// An opt-in output-reference protocol for the coverage loop. The caller mints short, request-local references for the concepts it shows and the model
// answers with those references and with LINE SPANS of the source it was shown, instead of retyping long concept ids or copying source text.
// A deterministic decoder turns references back into the exact versioned concept and spans back into the exact pinned text. It never repairs: an unknown or
// stale reference, a span that is out of range, partly unshown or has a gap, text outside the packet, or a freeform field, is refused with its code.
// A decoded reference is still only a proposed semantic claim; resolving it proves provenance, not fit.
import { createHash } from 'node:crypto';

export const REFS_PROTOCOL = 'refs/v1';
export const REFS_BOUNDS = Object.freeze({ span_max_lines: 40 });
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Request-local references c1..cN for the concepts shown in one request, with a digest of the exact mapping for custody. */
export function mintRefs(entries) {
  const refs = new Map(), order = [];
  entries.forEach((e, i) => { const ref = `c${i + 1}`; refs.set(ref, { accession: e.accession, version_id: e.version_id ?? null, label: e.label ?? null }); order.push(ref); });
  return { refs, order, digest: sha(order.map(r => [r, refs.get(r).accession, refs.get(r).version_id])) };
}

/** The set of file lines the model was actually shown, from the declaration ranges of the packet. */
export const shownLines = ranges => { const s = new Set(); for (const [a, b] of ranges) for (let n = a; n <= b; n += 1) s.add(n); return s; };

/** A span is [first, last], whole file line numbers, inclusive. Every line of it must have been shown; a gap is refused, not bridged. */
export function decodeSpan(span, { totalLines, shown, maxLines = REFS_BOUNDS.span_max_lines }) {
  if (!Array.isArray(span) || span.length !== 2 || !span.every(n => Number.isInteger(n))) return { ok: false, code: 'SPAN_MALFORMED' };
  const [a, b] = span;
  if (a < 1 || b < a) return { ok: false, code: 'SPAN_MALFORMED' };
  if (b > totalLines) return { ok: false, code: 'SPAN_OUT_OF_RANGE' };
  if (b - a + 1 > maxLines) return { ok: false, code: 'SPAN_TOO_LONG' };
  for (let n = a; n <= b; n += 1) if (!shown.has(n)) return { ok: false, code: 'SPAN_NOT_SHOWN', first_unshown_line: n };
  return { ok: true, start_line: a, end_line: b };
}

/**
 * Decodes one answer. ctx = { request_digest, pin, ref_map (from mintRefs), file_lines, shown (Set of line numbers), node_ids (Set of packet node ids) }.
 * custody = { answer_request_digest, expected_pin }: the digest of the request the answer belongs to, and the pin the decode is for. A different request or pin refuses everything.
 * Returns an answer in the loop's own shape (concept = exact accession, quote = text derived from the pinned lines) plus the refusals, with the decoded references kept.
 */
export function decodeRefsAnswer({ answer, ctx, custody }) {
  const refused = [];
  const fail = (code, extra = {}) => ({ answer: { ...answer, bindings: [], new_concepts: [] }, refused: [{ code, ...extra }] });
  if (custody.answer_request_digest !== ctx.request_digest) return fail('REF_CROSS_REQUEST', { expected: ctx.request_digest, got: custody.answer_request_digest });
  if (custody.expected_pin !== ctx.pin) return fail('REF_PIN_MISMATCH', { expected: ctx.pin, got: custody.expected_pin });
  if (answer?.protocol !== REFS_PROTOCOL) return fail('PROTOCOL_MARKER_MISSING');
  const text = (a, b) => ctx.file_lines.slice(a - 1, b).join('\n');
  const derive = (span, what) => { const d = decodeSpan(span, { totalLines: ctx.file_lines.length, shown: ctx.shown }); return d.ok ? { ok: true, at: { quote: text(d.start_line, d.end_line), start_line: d.start_line, end_line: d.end_line, derived_from: 'pinned_source_lines' } } : { ok: false, code: d.code, detail: d, what }; };
  const newKeys = new Set();
  const new_concepts = [];
  for (const nc of Array.isArray(answer.new_concepts) ? answer.new_concepts : []) {
    if ('witness_quote' in nc || (nc.counterexample && 'quote' in nc.counterexample)) { refused.push({ code: 'PROTOCOL_VIOLATION_FREEFORM', key: nc.key ?? null, field: 'new concept quote' }); continue; }
    const w = derive(nc.witness_span, 'witness');
    let counter = { status: 'none_found' };
    if (nc.counterexample?.status === 'tested_negative') { const c = derive(nc.counterexample.span, 'counterexample'); counter = c.ok ? { status: 'tested_negative', ...c.at } : { status: 'claimed_not_located', why: c.code }; }
    if (!w.ok) { refused.push({ code: w.code, key: nc.key ?? null, field: 'witness_span', span: nc.witness_span ?? null }); continue; }
    newKeys.add(nc.key);
    new_concepts.push({ ...nc, witness_quote: w.at.quote, _witness: { ok: true, at: w.at }, _counter: counter, counterexample: { status: counter.status, quote: counter.quote }, _decoded: { protocol: REFS_PROTOCOL, witness_span: nc.witness_span } });
  }
  const bindings = [];
  for (const b of Array.isArray(answer.bindings) ? answer.bindings : []) {
    const base = { node: b?.node ?? null, concept_ref: b?.concept ?? null, span: b?.span ?? null };
    if ('quote' in b) { refused.push({ code: 'PROTOCOL_VIOLATION_FREEFORM', field: 'quote', ...base }); continue; }
    if (!ctx.node_ids.has(b.node)) { refused.push({ code: 'NODE_NOT_IN_PACKET', ...base }); continue; }
    const concept = String(b.concept ?? '');
    let accession = null, versionId = null;
    if (concept.startsWith('new:')) { if (!newKeys.has(concept.slice(4))) { refused.push({ code: 'REF_UNKNOWN_NEW_CONCEPT', ...base }); continue; } accession = concept; }
    else if (/^c\d+$/u.test(concept)) { const e = ctx.ref_map.refs.get(concept); if (!e) { refused.push({ code: 'REF_UNKNOWN_CONCEPT', ...base }); continue; } accession = e.accession; versionId = e.version_id; }
    else { refused.push({ code: concept.includes(':') ? 'PROTOCOL_VIOLATION_FREEFORM' : 'REF_UNKNOWN_CONCEPT', field: 'concept', ...base }); continue; }
    const s = derive(b.span, 'support');
    if (!s.ok) { refused.push({ code: s.code, ...base, detail: s.detail }); continue; }
    bindings.push({ ...b, concept: accession, quote: s.at.quote, _derived: s.at, _decoded: { protocol: REFS_PROTOCOL, concept_ref: concept.startsWith('new:') ? null : concept, concept_accession: accession, concept_version_id: versionId, span: b.span, ref_map_digest: ctx.ref_map.digest, request_digest: ctx.request_digest, pin: ctx.pin } });
  }
  return { answer: { ...answer, bindings, new_concepts }, refused };
}
