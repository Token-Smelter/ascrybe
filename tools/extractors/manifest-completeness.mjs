// F4 — MANIFEST COMPLETENESS: EMPTY/ABSENT KEYS + ADJACENT COMMENTS
// (orientation-test-report.md §7.2 P1).
//
// WHY THIS EXISTS. §7.2 F4: "The map emits a `capability_flow` fact only for
// *non-empty* requires, so `requires_capabilities: []` is structurally
// invisible — it cannot distinguish 'declares nothing' from 'key absent,' and
// **an absence is itself a design statement** (`failure-observatory/
// plugin.yaml:12-13` is precisely that). Comment retention adjacent to manifest
// and DDL keys additionally exposes the stale-comment class that Q10 and the
// round-2 report both turn on."
//
// Q8 asks for the plugin that declares `requires_capabilities: []` AND the
// stated design reason. Both halves are unanswerable from the pre-F4 map: the
// empty list minted no fact at all, and the reason lives in a YAML COMMENT,
// which no extractor read.
//
// WHAT IT EXTRACTS (plugin manifests only — `**/plugin.yaml`).
//   manifest_key_presence  one per key in the validator-grounded vocabulary,
//                          stamped present_nonempty | present_empty | absent,
//                          with the element count for list-shaped keys.
//   manifest_comment       one per comment line in the file, attached to the
//                          key it precedes (or trails on the same line), so a
//                          stated design reason is retrievable BY THE KEY it
//                          justifies rather than by grepping prose.
//
// WHERE THE VOCABULARY COMES FROM (source-grounded, not invented). The keys
// below are the literals the substrate's own manifest validator names:
// `REQUIRED = ["name","version","api_version","entry_point"]` at
// src/substrate/pluginManifest.mjs:31, and the six list-shaped fields at
// src/substrate/pluginManifest.mjs:46
// (`provides_capabilities`, `requires_capabilities`, `publishes_envelopes`,
// `subscribes_envelopes`, `http_routes`, `state_machines`), plus
// `session_affordances` (validated at the same site) and `subscribes_to` (the
// block the envelope extractor reads). `vocabulary_source` is stamped on every
// absent-key fact so a reader can audit the list rather than trust it.
//
// WHAT IT REFUSES, TYPED. An `absent` fact is witnessed at the FILE, line 1 —
// an absence has no line of its own, and inventing one would be a drifted
// citation. Keys OUTSIDE the vocabulary are reported only when PRESENT (as
// `in_vocabulary: false`); this module never claims a key is absent from a
// vocabulary it does not carry.
//
// READ-ONLY / NO-EXEC: parses redacted text; no evaluation, no I/O.

import YAML from 'yaml';

const MANIFEST_PATTERN = /(?:^|\/)plugin\.ya?ml$/i;
const COMMENT_TEXT_CAP = 400;
const COMMENT_CAP = 200;

// See header: every entry is a literal read off src/substrate/pluginManifest.mjs.
export const MANIFEST_KEY_VOCABULARY = Object.freeze([
  'name', 'version', 'api_version', 'entry_point',
  'provides_capabilities', 'requires_capabilities',
  'publishes_envelopes', 'subscribes_envelopes', 'subscribes_to',
  'http_routes', 'state_machines', 'session_affordances',
]);
export const VOCABULARY_SOURCE = 'src/substrate/pluginManifest.mjs REQUIRED + validateManifest list-shaped fields';

const cap = (text) => {
  const value = String(text ?? '');
  return value.length > COMMENT_TEXT_CAP ? `${value.slice(0, COMMENT_TEXT_CAP)}…` : value;
};

function presenceOf(value) {
  if (value == null) return { presence: 'present_empty', shape: 'null', element_count: 0 };
  if (YAML.isSeq(value)) return { presence: value.items.length ? 'present_nonempty' : 'present_empty', shape: 'sequence', element_count: value.items.length };
  if (YAML.isMap(value)) return { presence: value.items.length ? 'present_nonempty' : 'present_empty', shape: 'map', element_count: value.items.length };
  if (YAML.isScalar(value)) {
    const empty = value.value === null || value.value === '';
    return { presence: empty ? 'present_empty' : 'present_nonempty', shape: 'scalar', element_count: empty ? 0 : 1 };
  }
  return { presence: 'present_nonempty', shape: 'unevaluated', element_count: 0 };
}

/**
 * Attach each comment line to the FIRST following non-blank, non-comment line's
 * top-level-ish key (or, for a trailing comment, the key on its own line). The
 * attachment is reported with the line the key sits on, so a reader can verify
 * the pairing without re-reading the file.
 */
function scanComments(lines, ctx) {
  const facts = [];
  const keyAt = (text) => text.match(/^\s*(-\s+)?([A-Za-z_][\w.-]*)\s*:/)?.[2] || null;
  for (let index = 0; index < lines.length && facts.length < COMMENT_CAP; index++) {
    const raw = lines[index];
    const hash = raw.indexOf('#');
    if (hash < 0) continue;
    // A '#' inside a quoted scalar is not a comment. Only a '#' that is the
    // first non-space character, or is preceded by whitespace outside quotes,
    // starts one; the cheap quote parity check below is deliberately
    // conservative — when in doubt, no comment fact is emitted.
    const before = raw.slice(0, hash);
    const quotes = (before.match(/"/g) || []).length + (before.match(/'/g) || []).length;
    if (quotes % 2 === 1) continue;
    if (before.trim() && !/\s$/.test(before)) continue;
    const text = raw.slice(hash + 1).trim();
    if (!text) continue;
    const trailing = Boolean(before.trim());
    let attachedKey = trailing ? keyAt(before) : null;
    let attachedLine = trailing ? index + 1 : null;
    if (!trailing) {
      for (let ahead = index + 1; ahead < lines.length; ahead++) {
        const next = lines[ahead];
        if (!next.trim()) continue;
        if (/^\s*#/.test(next)) continue;
        attachedKey = keyAt(next);
        attachedLine = ahead + 1;
        break;
      }
    }
    facts.push(ctx.fact('manifest_comment', index + 1, {
      text: cap(text),
      position: trailing ? 'trailing' : 'leading',
      attached_key: attachedKey,
      attached_line: attachedLine,
      // A comment that precedes a blank-to-EOF tail attaches to nothing. Saying
      // so beats attaching it to the last key that happened to be nearby.
      refusal: attachedKey ? null : 'comment_has_no_following_key_line',
    }));
  }
  return facts;
}

export default {
  kind: 'manifest_key_presence',
  filePattern: /\.(?:ya?ml)$/i,
  scan(lines, ctx) {
    if (!MANIFEST_PATTERN.test(ctx.file)) return [];
    const text = lines.join('\n');
    let doc;
    try {
      doc = YAML.parseDocument(text, { keepSourceTokens: false, logLevel: 'silent' });
    } catch (error) {
      return [ctx.fact('manifest_completeness_refusal', 1, { reason: 'yaml_parse_threw', detail: cap(error.message) })];
    }
    if ((doc.errors || []).filter((error) => error.name !== 'YAMLWarning').length || !YAML.isMap(doc.contents)) {
      return [ctx.fact('manifest_completeness_refusal', 1, {
        reason: YAML.isMap(doc.contents) ? 'yaml_parse_error' : 'manifest_root_is_not_a_map',
        detail: cap(doc.errors?.[0]?.message || 'manifest root did not parse as a mapping'),
      })];
    }

    const facts = [];
    const lineOf = (offset) => {
      if (!Number.isInteger(offset)) return 1;
      let count = 1;
      for (let index = 0; index < offset && index < text.length; index++) if (text[index] === '\n') count++;
      return count;
    };
    const present = new Map();
    for (const pair of doc.contents.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      present.set(key, pair);
    }

    for (const [key, pair] of [...present].sort((a, b) => a[0].localeCompare(b[0]))) {
      const info = presenceOf(pair.value);
      facts.push(ctx.fact('manifest_key_presence', lineOf(pair.key?.range?.[0]), {
        manifest_key: key,
        in_vocabulary: MANIFEST_KEY_VOCABULARY.includes(key),
        ...info,
        value_line: pair.value?.range ? lineOf(pair.value.range[0]) : null,
      }));
      if (info.presence === 'present_empty' && ['sequence', 'map'].includes(info.shape)) {
        facts.push(ctx.fact('manifest_empty_declaration', lineOf(pair.key?.range?.[0]), {
          declaration_key: key,
          declaration_empty: true,
          shape: info.shape,
        }));
      }
    }
    for (const key of MANIFEST_KEY_VOCABULARY) {
      if (present.has(key)) continue;
      facts.push(ctx.fact('manifest_key_presence', 1, {
        manifest_key: key,
        in_vocabulary: true,
        presence: 'absent',
        shape: null,
        element_count: null,
        value_line: null,
        vocabulary_source: VOCABULARY_SOURCE,
      }));
    }
    facts.push(...scanComments(lines, ctx));
    return facts;
  },
};
