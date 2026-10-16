import { sha256, stableStringify } from './lib.mjs';

const canonical = value => stableStringify(value).trim();
const clean = value => String(value ?? '').trim();
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * A multi-repository estate is identified by the digest of its ordered source pins.
 * A single-repository estate retains its commit as its identity.
 */
export function sourcePins(provenance) {
  const pins = provenance?.source_pins;
  if (pins && typeof pins === 'object' && !Array.isArray(pins)) {
    const entries = Object.entries(pins).sort(([left], [right]) => compare(left, right));
    if (!entries.length) fail('UNIFIED_PROJECTION_SOURCE_PINS_EMPTY', 'source_pins must name at least one repository');
    for (const [repository, sha] of entries) {
      if (!clean(repository) || !/^[0-9a-f]{40}$/u.test(String(sha))) {
        fail('UNIFIED_PROJECTION_SOURCE_PIN_INVALID', `source pin for ${repository} is not a full commit SHA`);
      }
    }
    const orderedPins = Object.fromEntries(entries);
    return Object.freeze({ pins: orderedPins, digest: sha256(canonical(orderedPins)) });
  }
  const head = clean(provenance?.source_head);
  if (!head) return null;
  return Object.freeze({ pins: null, digest: head });
}
