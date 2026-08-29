// ENVELOPE-FLOW extractor.
//
// the host runtime module is an event-driven substrate: plugins, the recipe-engine runtime
// and Patterns couple by EMITTING and CONSUMING envelopes on the bus, not by
// importing each other. The import graph therefore misses the architecture
// almost entirely. This extractor emits one `envelope_flow` fact per site that
// names an envelope kind in a groundable way, with the direction that site
// participates in (`emit` or `consume`).
//
// Every idiom below was found by reading the real producers/consumers on this
// branch before the extractor was written; the file:line citations are in
// tools/estate-map/examples/envelope-flow-report-2026-07-25.md §2.
//
// EMIT idioms
//   manifest_publishes      plugins/<p>/plugin.yaml `publishes_envelopes:` list
//                           (e.g. plugins/workflow-engine/plugin.yaml:39-41)
//   envelope_object_literal an envelope object literal: `kind: "x.y"` beside
//                           the envelope schema's `source_kind:` sibling, or
//                           inside an `envelopes.emit(` / `envelopeBus.emit(`
//                           call. Covers the three real construction shapes:
//                           inline in the emit call (plugins/work-dispatch/
//                           server/index.mjs:3256), built into a variable then
//                           emitted later (plugins/workflow-engine/runtime/
//                           runtime.mjs:9477-9488), and the substrate's own
//                           bus (src/app.mjs:1712-1725, `session.spawned`).
//   emit_call               a wrapper call with a literal kind first argument,
//                           `emit("brew.started", …)` / `emitLivenessEnvelope(
//                           "work_order.liveness_poke_sent", …)`
//                           (e.g. plugins/work-dispatch/server/
//                           sessionLivenessWatcher.mjs:1092)
//   envelope_kind_table     a frozen state->kind map whose values are emitted
//                           by a shared transition helper
//                           (plugins/work-dispatch/server/
//                           workOrderTransitionEnvelope.mjs:16-30)
//
// CONSUME idioms
//   manifest_subscribes_legacy    plugins/<p>/plugin.yaml `subscribes_to:` list
//                           (e.g. plugins/work-dispatch/plugin.yaml:192+)
//   manifest_subscribes_validated plugins/<p>/plugin.yaml `subscribes_envelopes:`
//                           list — the key the loader SHAPE-CHECKS (see below)
//   envelopes_subscribe     `context.envelopes.subscribe("kind", id, handler)`
//                           (e.g. plugins/session-trim/server/index.mjs:20)
//   pattern_rule_on         a Pattern rule trigger `on: { kind: "x.y" }`
//                           (e.g. plugins/workflow-engine/patterns/single-task.mjs:106)
//   envelope_kind_equality  a runtime branch on the received envelope's kind,
//                           `env.kind === "brew.stalled"`
//                           (e.g. plugins/work-dispatch/server/
//                           brewPromptPolicy.mjs:42)
//
// DELIBERATE NON-IDIOMS (precision over recall — see report §3.4):
//   * `new Set([...])` kind registries such as KNOWN_RULE_ENVELOPE_KINDS
//     (plugins/workflow-engine/patterns/validate.mjs:170) are ALLOWLISTS. The
//     module neither emits nor consumes those kinds, so no fact is emitted.
//   * a dynamic kind (variable, template literal, concatenation) is not
//     groundable to a kind name and is skipped rather than guessed.
//
// THE TWO SUBSCRIPTION KEYS (defect D15 / instrument fix I4).
// The loader accepts EITHER manifest key, but validates only one of them:
//   * `subscribes_envelopes` is the key `validateManifest` shape-checks, via
//     `validateEnvelopeEntries(manifest.subscribes_envelopes, …)`.
//   * `subscribes_to` is accepted as an alias at read time
//     (`manifest.subscribes_envelopes || manifest.subscribes_to || []`) and
//     is never shape-checked — and it is what every real manifest writes.
// Harvesting only `subscribes_to` (the prior behaviour) made a manifest
// written to the documented key produce ZERO consume edges, and made the
// validated-vs-unvalidated distinction invisible in the map. Both keys are
// now extracted under DISTINCT idiom labels carrying `manifest_key`, and the
// two loader sites above are themselves extracted as facts
// (`manifest_key_validation`, `manifest_key_alias`) so the citation is
// DERIVED from the real loader on this branch rather than transcribed into
// this comment as a line number that would drift.

// An envelope kind is a dotted lower-snake path: `brew.started`,
// `work_order.liveness_poke_sent`, `episodic_memory.episode.ingested`.
const KIND = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
//   * a `switch (kind) { case "brew.started": ... }` projector arm is NOT read
//     as a consume: the discriminant is usually a local variable several lines
//     up, so the binding to an envelope is not groundable from the case line.
//     Measured ceiling on this repo: 10 `switch (…kind)` sites / 41 dotted
//     `case` literals, against 528 groundable `env.kind ===` sites.

// A subscription may be a prefix wildcard: `brew.*`.
const WILDCARD = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.\*$/;

export const isEnvelopeKind = value => KIND.test(String(value || ''));
export const isEnvelopeKindPattern = value => WILDCARD.test(String(value || ''));

// A manifest block key -> the direction it declares and the LABEL that keeps
// the two subscription keys distinguishable downstream. `manifest_key` is the
// literal key read from the YAML, so the map can answer "which key did this
// plugin actually write?" without re-reading the manifest.
const YAML_BLOCKS = {
  publishes_envelopes: { direction: 'emit', idiom: 'manifest_publishes', manifest_key: 'publishes_envelopes' },
  subscribes_envelopes: { direction: 'consume', idiom: 'manifest_subscribes_validated', manifest_key: 'subscribes_envelopes' },
  subscribes_to: { direction: 'consume', idiom: 'manifest_subscribes_legacy', manifest_key: 'subscribes_to' },
};
const YAML_BLOCK_START = /^([a-z_]+):\s*(?:#.*)?$/;
const YAML_KIND_ITEM = /^\s*-\s*kind:\s*["']?([A-Za-z0-9_.*-]+)["']?\s*(?:#.*)?$/;
const YAML_SUBSCRIBER = /^\s*subscriber_id:\s*["']?([A-Za-z0-9_.:-]+)["']?\s*(?:#.*)?$/;
const YAML_TOP_LEVEL = /^[^\s#-]/;

// `kind:` as an object key, never the tail of `source_kind:` / `decision_kind:`.
const OBJECT_KIND_KEY = /(?:^|[{,\s(])kind:\s*(["'])([^"']+)\1/;
// The envelope schema's own sibling key, and the bus call. Either one within
// the window qualifies a `kind:` literal as an ENVELOPE rather than some other
// object that happens to have a `kind` field.
const ENVELOPE_SHAPE = /(?:^|[{,\s(])source_kind:/;
const EMIT_OBJECT_OPEN = /\benvelope[A-Za-z]*\s*\.\s*emit\s*\(/;
const EMIT_CALL = /\bemit[A-Za-z0-9_]*\s*\(\s*(["'])([^"'`]+)\1/;
const SUBSCRIBE_CALL = /envelopes\s*\.\s*subscribe\s*\(\s*(["'])([^"'`]+)\1/;
// DYNAMIC SITES (instrument fix K3). A subscribe whose kind is a VARIABLE, or
// an `envelopes.emit(` whose object carries no literal `kind:`, names no kind
// this reader can ground — but it is not nothing: it is proof that the plugin
// reaches the bus through a path this extractor cannot follow. Two real cases
// on this branch make the distinction load-bearing for the wiring assessment:
//   plugins/session-notes/server/index.mjs:607 subscribes with a `kind`
//     parameter, iterating the manifest list — its eight declarations really
//     ARE wired, and calling them `declared_unwired` would be a false accusation;
//   plugins/task-goals/server/index.mjs:4021-4026 loops
//     `for (const kind of FAILURE_THRESHOLD_KINDS)` around a subscribe.
// Emitting these as facts is what lets manifest-wiring.mjs answer
// `undeterminable` instead of guessing in either direction.
const SUBSCRIBE_CALL_ANY = /envelopes\s*\.\s*subscribe\s*\(/;
const LEADING_STRING_ARGUMENT = /^\s*(["'])([^"'`]+)\1\s*,/;
// MENTIONS (instrument fix K3). A kind NAMED in code without being emitted or
// consumed on that line: a named constant, or a bare element of a kind list. It
// is not a flow — it creates no `emits` / `consumes` edge and no node — but it
// is the difference between "this plugin reaches this kind through a path I
// cannot follow" and "this plugin never names this kind at all". Both real
// forms on this branch:
//   plugins/workflow-engine/runtime/acceptanceDischarge.mjs:3
//     `export const ACCEPTANCE_DISCHARGE_KIND = "acceptance.discharged";`
//   plugins/task-goals/server/index.mjs:108-111
//     `const FAILURE_THRESHOLD_KINDS = [ "failure.threshold_crossed", … ];`
const KIND_CONSTANT = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(["'])([a-z][a-z0-9_.]*)\1\s*;?\s*$/;
const KIND_LIST_ELEMENT = /^\s*(["'])([a-z][a-z0-9_.]*)\1\s*,\s*(?:\/\/.*)?$/;
const RULE_ON_KIND = /\bon:\s*\{\s*kind:\s*(["'])([^"']+)\1/;
const KIND_EQUALITY = /\b(?:env|envelope|event|evt|e)\s*(?:\?\.)?\.?kind\s*===\s*(["'])([^"']+)\1/;
const KIND_TABLE_OPEN = /\b([A-Z][A-Z0-9_]*ENVELOPE_KINDS)\b\s*=\s*Object\.freeze\(\{/;
// The loader's own two statements about manifest subscription keys, read as
// facts so the map cites the REAL line instead of a transcribed one:
//   `validateEnvelopeEntries(manifest.subscribes_envelopes, "subscribes_envelopes", errors)`
//   `manifest.subscribes_envelopes || manifest.subscribes_to || []`
const MANIFEST_KEY_VALIDATION = /\bvalidateEnvelopeEntries\s*\(\s*manifest\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2/;
const MANIFEST_KEY_ALIAS = /\bmanifest\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*manifest\.([A-Za-z_][A-Za-z0-9_]*)/;
const KIND_TABLE_VALUE = /:\s*(["'])([^"']+)\1/;
// A comment is prose about the bus, not a site on it. Skipping comment lines
// is load-bearing, not cosmetic: without it this very file's header (which
// quotes `kind: "x.y"` as an illustration) produced a phantom `x.y` envelope
// kind, and every `// context.envelopes.subscribe(...)` explanation counted as
// a real subscriber.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

// How far from a `kind:` literal the envelope evidence (`source_kind:` or the
// bus call) may sit. Measured max on this repo is 13 lines (src/app.mjs's
// session.spawned envelope, whose `attributes` block precedes `kind`).
const ENVELOPE_WINDOW = 16;

function scanYaml(lines, ctx) {
  const facts = [];
  let block = null;
  let pending = null;
  const flush = () => { if (pending) facts.push(pending.fact); pending = null; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = line.match(YAML_BLOCK_START);
    if (start) { flush(); block = YAML_BLOCKS[start[1]] || null; continue; }
    if (!block) continue;
    if (YAML_TOP_LEVEL.test(line)) { flush(); block = null; continue; }
    const item = line.match(YAML_KIND_ITEM);
    if (item) {
      flush();
      const value = item[1];
      if (!isEnvelopeKind(value) && !isEnvelopeKindPattern(value)) continue;
      pending = {
        fact: ctx.fact('envelope_flow', index + 1, {
          envelope_kind: value,
          direction: block.direction,
          idiom: block.idiom,
          manifest_key: block.manifest_key,
          status: isEnvelopeKindPattern(value) ? 'wildcard' : 'literal',
        }),
      };
      continue;
    }
    const subscriber = pending && line.match(YAML_SUBSCRIBER);
    if (subscriber) pending.fact.subscriber_id = subscriber[1];
  }
  flush();
  return facts;
}

// Is the `kind:` literal at `index` part of an ENVELOPE object literal? A bare
// `kind:` field is common (commands, predicates, artifact refs); the envelope
// schema's `source_kind:` sibling, or the bus call itself, is what makes this
// one an envelope. Dynamic kinds (`{ kind, ... }` shorthand, template
// literals) never reach here because OBJECT_KIND_KEY requires a quoted string.
function isEnvelopeObject(lines, index) {
  const from = Math.max(0, index - ENVELOPE_WINDOW);
  const to = Math.min(lines.length, index + ENVELOPE_WINDOW + 1);
  for (let cursor = from; cursor < to; cursor++) {
    if (COMMENT_LINE.test(lines[cursor])) continue;
    if (ENVELOPE_SHAPE.test(lines[cursor]) || EMIT_OBJECT_OPEN.test(lines[cursor])) return true;
  }
  return false;
}

/**
 * Does a literal `kind: "x.y"` sit within the envelope window of an emit call?
 * The window is SYMMETRIC, exactly as isEnvelopeObject's is: the estate builds
 * an envelope into a variable and emits it several lines LATER
 * (plugins/workflow-engine/runtime/runtime.mjs:9477-9488), so a forward-only
 * search would call that groundable emit dynamic.
 */
function hasLiteralKindNear(lines, index) {
  const from = Math.max(0, index - ENVELOPE_WINDOW);
  const to = Math.min(lines.length, index + ENVELOPE_WINDOW + 1);
  for (let cursor = from; cursor < to; cursor++) {
    if (COMMENT_LINE.test(lines[cursor])) continue;
    const match = lines[cursor].match(OBJECT_KIND_KEY);
    if (match && isEnvelopeKind(match[2])) return true;
  }
  return false;
}

function scanCode(lines, ctx) {
  const facts = [];
  const seen = new Set();
  const push = (line, envelopeKind, direction, idiom, extra = {}) => {
    if (!isEnvelopeKind(envelopeKind) && !isEnvelopeKindPattern(envelopeKind)) return;
    const key = `${line}\0${envelopeKind}\0${direction}\0${idiom}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(ctx.fact('envelope_flow', line, {
      envelope_kind: envelopeKind,
      direction,
      idiom,
      status: isEnvelopeKindPattern(envelopeKind) ? 'wildcard' : 'literal',
      ...extra,
    }));
  };
  let table = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (COMMENT_LINE.test(line)) continue;

    if (table) {
      if (/^\s*\}/.test(line)) table = null;
      else {
        const value = line.match(KIND_TABLE_VALUE);
        if (value) push(index + 1, value[2], 'emit', 'envelope_kind_table', { table: table });
        continue;
      }
    }
    const tableOpen = line.match(KIND_TABLE_OPEN);
    if (tableOpen) { table = tableOpen[1]; continue; }

    const subscribe = line.match(SUBSCRIBE_CALL);
    if (subscribe) push(index + 1, subscribe[2], 'consume', 'envelopes_subscribe');
    else if (SUBSCRIBE_CALL_ANY.test(line)) {
      // The arguments may start on the next line, which
      // plugins/task-goals/server/index.mjs:4022 really writes.
      const continuation = (lines[index + 1] || '').match(LEADING_STRING_ARGUMENT);
      if (continuation && isEnvelopeKind(continuation[2])) push(index + 2, continuation[2], 'consume', 'envelopes_subscribe');
      else facts.push(ctx.fact('envelope_dynamic_site', index + 1, { direction: 'consume', idiom: 'envelopes_subscribe_dynamic_kind' }));
    }

    const ruleOn = line.match(RULE_ON_KIND);
    if (ruleOn) push(index + 1, ruleOn[2], 'consume', 'pattern_rule_on');

    const equality = line.match(KIND_EQUALITY);
    if (equality) push(index + 1, equality[2], 'consume', 'envelope_kind_equality');

    const objectKind = line.match(OBJECT_KIND_KEY);
    if (objectKind && isEnvelopeObject(lines, index)) {
      push(index + 1, objectKind[2], 'emit', 'envelope_object_literal');
    }

    const mention = line.match(KIND_CONSTANT) || line.match(KIND_LIST_ELEMENT);
    if (mention && isEnvelopeKind(mention[2])) facts.push(ctx.fact('envelope_kind_mention', index + 1, { envelope_kind: mention[2] }));

    const emitCall = line.match(EMIT_CALL);
    // `envelopes.emit(` is handled by the object-literal idiom above; a
    // wrapper call is anything else named emit*(…) with a literal kind.
    if (emitCall && !EMIT_OBJECT_OPEN.test(line)) push(index + 1, emitCall[2], 'emit', 'emit_call');
    // A bus emit whose envelope object carries NO literal `kind:` in the
    // window — the `{ kind, payload }` shorthand every wrapper writes, e.g.
    // plugins/fault-watch/server/index.mjs:364-365 and
    // plugins/project-index/server/index.mjs:845 (a ternary kind).
    if (EMIT_OBJECT_OPEN.test(line) && !hasLiteralKindNear(lines, index)) {
      facts.push(ctx.fact('envelope_dynamic_site', index + 1, { direction: 'emit', idiom: 'envelopes_emit_dynamic_kind' }));
    }

    const validation = line.match(MANIFEST_KEY_VALIDATION);
    if (validation && validation[1] === validation[3]) {
      facts.push(ctx.fact('manifest_key_validation', index + 1, { manifest_key: validation[1], validator: 'validateEnvelopeEntries' }));
    }
    const alias = line.match(MANIFEST_KEY_ALIAS);
    if (alias && alias[1] !== alias[2]) {
      facts.push(ctx.fact('manifest_key_alias', index + 1, { preferred_key: alias[1], fallback_key: alias[2] }));
    }
  }
  return facts;
}

export default {
  kind: 'envelope_flow',
  filePattern: /(?:\.[cm]?[jt]sx?|(?:^|\/)plugin\.ya?ml)$/i,
  scan(lines, ctx) {
    return /\.ya?ml$/i.test(ctx.file) ? scanYaml(lines, ctx) : scanCode(lines, ctx);
  },
};
