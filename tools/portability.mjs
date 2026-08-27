// Typed portability records: what an extractor could NOT do on THIS estate, and why.
//
// WHY THIS EXISTS. Every reading layer in this directory was written against
// the home estate, and several of them require an artifact only the home estate
// has: `design/canon/ontology.md`, `design/canon/ddd-mapping.md`,
// `plugins/<p>/plugin.yaml`, `client/src/lib/workExplorerGraphModel.ts`. On any other
// estate those inputs are ABSENT. Absence is a legitimate, reportable state of the
// world. It must never be an unhandled ENOENT that aborts a pass — on the
// 2026-07-26 probe a missing MARKDOWN FILE took down loop-driver's entire iteration
// AFTER extract, merge, structural-grouping and analyze-connectivity had already
// succeeded, and their output was discarded.
//
// NOT A PARALLEL MECHANISM. These records are the conservation gates' derivability
// vocabulary (conservation.mjs) applied to a second subject. conservation.mjs asks
// "was extracted evidence represented in the graph?"; this asks "was the evidence
// this layer needs present on this estate at all?". Same record_type triad, same
// classification strings, same `examined` discipline — so one consumer reads both
// and nothing has to learn a second refusal shape.
//
//   REFUSAL  the input EXISTS but cannot support the claim   (evidence_lacks_required_membership)
//   SCOPE    the input was not examined — absent, or the      (relevant_evidence_not_examined)
//            attempt to examine it failed
//   BUG      the input exists and supports the claim, and     (evidence_exists_edge_omitted)
//            the layer still failed to emit
//
// AN EXCEPTION IS NOT A REFUSAL. `runGuarded` catches, but it never swallows: an
// unexpected throw becomes a SCOPE record with failure_mode `unexpected_exception`
// carrying the error code, message and top stack frame, and callers are expected to
// surface it. A silent catch would convert "this tool is broken on this estate" into
// "this estate has nothing to say", which is the exact over-claim the refusal
// machinery exists to prevent.
import path from 'node:path';
import fs from './readonly-guard.mjs';
import { DERIVABILITY_CLASSIFICATIONS } from './conservation.mjs';
import { sha256 } from './lib.mjs';

export const PORTABILITY_SCHEMA = 'estate-map/portability/v1';

// An estate without an ontology canon still has a legitimate provenance value: the
// ABSENCE of one. Lives here rather than in semantic-layer.mjs because FOUR call sites
// need it (semantic-layer apply, l1-adjudicate apply, and any future adjudicator), and
// importing a 49 KB CLI module to reach one hash helper is how import cycles start.
export const CANON_ABSENT_DIGEST = 'absent:no-ontology-canon';
export async function canonDigest(canonPath, { tool = 'estate-map' } = {}) {
  try {
    return sha256(await fs.readFile(canonPath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.warn(`${tool}: no ontology canon at ${canonPath} \u2014 recording canon_digest=${CANON_ABSENT_DIGEST}.`);
    return CANON_ABSENT_DIGEST;
  }
}

export const PORTABILITY_FAILURE_MODES = Object.freeze({
  INPUT_ABSENT: 'input_absent',
  INPUT_UNREADABLE: 'input_unreadable',
  INPUT_MALFORMED: 'input_malformed',
  UNEXPECTED_EXCEPTION: 'unexpected_exception',
});

const estateName = estateRoot => path.basename(path.resolve(estateRoot || '.')) || String(estateRoot);
const relativeToEstate = (estateRoot, target) => {
  const relative = path.relative(path.resolve(estateRoot || '.'), path.resolve(target));
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : path.resolve(target);
};

function baseRecord({ tool, estateRoot, input, recordType, failureMode }) {
  return {
    schema: PORTABILITY_SCHEMA,
    record_type: recordType,
    classification: DERIVABILITY_CLASSIFICATIONS[recordType],
    failure_mode: failureMode,
    // The three things the task of triage always needs first, and the three things
    // an ENOENT stack trace does not tell you: which tool, which estate, which input.
    tool,
    estate: estateName(estateRoot),
    estate_root: path.resolve(estateRoot || '.'),
    missing_input: input === null || input === undefined ? null : relativeToEstate(estateRoot, input),
    subject: input === null || input === undefined ? tool : relativeToEstate(estateRoot, input),
    subject_kind: 'estate_input',
  };
}

/**
 * The estate does not carry an input this layer wants. The layer still runs; it just
 * runs without that corroboration, and says so.
 */
export function missingInputRecord({ tool, estateRoot, input, capability, why, examined = [] }) {
  return {
    ...baseRecord({ tool, estateRoot, input, recordType: 'SCOPE', failureMode: PORTABILITY_FAILURE_MODES.INPUT_ABSENT }),
    capability,
    detail: why,
    examined: examined.length ? examined : [relativeToEstate(estateRoot, input)],
    witnesses: [],
  };
}

/**
 * The layer threw for a reason nobody predicted. This is the record that keeps a
 * crash from becoming either a hard abort OR a silent zero.
 */
export function unexpectedFailureRecord({ tool, estateRoot, input = null, phase, error }) {
  return {
    ...baseRecord({ tool, estateRoot, input, recordType: 'SCOPE', failureMode: PORTABILITY_FAILURE_MODES.UNEXPECTED_EXCEPTION }),
    capability: phase,
    detail: `${tool} threw during ${phase} on estate ${estateName(estateRoot)}: ${error?.code ? `${error.code} ` : ''}${error?.message || String(error)}`,
    error_code: error?.code || null,
    error_message: error?.message || String(error),
    error_frame: String(error?.stack || '').split('\n').slice(1, 2).join('').trim() || null,
    examined: input ? [relativeToEstate(estateRoot, input)] : [],
    witnesses: [],
  };
}

/**
 * Read an OPTIONAL estate input. Absence degrades to a typed SCOPE record; anything
 * else (EACCES, EISDIR, a parse failure) is ALSO typed rather than thrown, because a
 * foreign estate produces error codes this repo never sees and an unhandled one is
 * indistinguishable to the operator from a crash.
 *
 * Returns { present, value, record } — `record` is null iff present.
 */
export async function readOptionalEstateInput(absolutePath, { tool, estateRoot, capability, why, parse = null, encoding = 'utf8' } = {}) {
  let raw;
  try {
    raw = await fs.readFile(absolutePath, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { present: false, value: null, record: missingInputRecord({ tool, estateRoot, input: absolutePath, capability, why }) };
    }
    return {
      present: false,
      value: null,
      record: {
        ...baseRecord({ tool, estateRoot, input: absolutePath, recordType: 'SCOPE', failureMode: PORTABILITY_FAILURE_MODES.INPUT_UNREADABLE }),
        capability,
        detail: `input present but unreadable (${error.code}): ${why}`,
        error_code: error.code,
        error_message: error.message,
        examined: [relativeToEstate(estateRoot, absolutePath)],
        witnesses: [],
      },
    };
  }
  if (!parse) return { present: true, value: raw, record: null };
  try {
    return { present: true, value: parse(raw), record: null };
  } catch (error) {
    // A MALFORMED input is categorically different from an absent one and must not
    // be smoothed into "this estate has no canon". Absence is a property of the
    // estate; malformation is a defect in the input or the parser, and silently
    // treating it as absence manufactures false "undocumented" findings.
    return {
      present: false,
      value: null,
      record: {
        ...baseRecord({ tool, estateRoot, input: absolutePath, recordType: 'BUG', failureMode: PORTABILITY_FAILURE_MODES.INPUT_MALFORMED }),
        capability,
        detail: `input present but could not be parsed: ${error.message}`,
        error_message: error.message,
        examined: [relativeToEstate(estateRoot, absolutePath)],
        witnesses: [],
      },
    };
  }
}

/**
 * Run one pipeline stage so that no throw escapes as an abort.
 *
 * A READ-ONLY VIOLATION is deliberately NOT caught: it is not a portability finding
 * about the estate, it is this tool misbehaving toward the estate, and it must stay
 * loud and fatal. Degrading it to a record is how a guard becomes decorative.
 */
export async function runGuarded(operation, { tool, estateRoot, phase }) {
  try {
    return { ok: true, value: await operation(), record: null };
  } catch (error) {
    if (error?.code === 'ASCRYBE_READONLY_VIOLATION') throw error;
    const record = unexpectedFailureRecord({ tool, estateRoot, phase, error });
    console.warn(`${tool}: ${phase} failed on ${record.estate} — recorded as ${record.record_type}/${record.failure_mode} (${record.error_code || 'no code'}).`);
    return { ok: false, value: null, record };
  }
}

export const summarizePortability = records => ({
  total: records.length,
  by_record_type: records.reduce((acc, record) => ({ ...acc, [record.record_type]: (acc[record.record_type] || 0) + 1 }), {}),
  by_failure_mode: records.reduce((acc, record) => ({ ...acc, [record.failure_mode]: (acc[record.failure_mode] || 0) + 1 }), {}),
  by_tool: records.reduce((acc, record) => ({ ...acc, [record.tool]: (acc[record.tool] || 0) + 1 }), {}),
});
