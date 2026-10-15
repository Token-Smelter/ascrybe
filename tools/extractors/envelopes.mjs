// Preserve source witnesses; do not infer authority from naming conventions alone.

// An envelope kind is a dotted lower-snake path: `batch.started`,
// `parcel_order.heartbeat_poke_sent`, `archive_memory.episode.ingested`.
const KIND = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

// A subscription may be a prefix wildcard: `batch.*`.
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
// Preserve source witnesses; do not infer authority from naming conventions alone.
const SUBSCRIBE_CALL_ANY = /envelopes\s*\.\s*subscribe\s*\(/;
const LEADING_STRING_ARGUMENT = /^\s*(["'])([^"'`]+)\1\s*,/;
// Preserve source witnesses; do not infer authority from naming conventions alone.
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

/** Resolve only witnessed evidence; unresolved candidates remain explicit. */
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
      // Preserve source witnesses; do not infer authority from naming conventions alone.
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
    // Preserve source witnesses; do not infer authority from naming conventions alone.
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
