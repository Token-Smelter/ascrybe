// Preserve source witnesses; do not infer authority from naming conventions alone.
import { readFileSync, statSync } from 'node:fs';
import { constants } from 'node:buffer';

export const STRING_CEILING = constants.MAX_STRING_LENGTH;
/** Warn from here, so growth is visible before it is terminal. */
export const HEADROOM_WARNING = 0.7;

/**
 * Whether a file of this size can be held in one string, and how close it is. Separated from the
 * read so the decision is testable without producing a valid four-hundred-megabyte fixture --
 * padding a file to size makes it unparseable, which tests the wrong thing.
 */
export function artifactHeadroom(bytes) {
  const fraction = bytes / STRING_CEILING;
  return Object.freeze({
    bytes, ceiling: STRING_CEILING, fraction,
    exceeds: bytes >= STRING_CEILING,
    approaching: fraction >= HEADROOM_WARNING && bytes < STRING_CEILING,
  });
}

export function wholeFileJson(path, { label = 'artifact', onWarning = null } = {}) {
  const bytes = statSync(path).size;
  const held = artifactHeadroom(bytes);
  if (held.exceeds) {
    const error = new Error(`${label} is ${bytes.toLocaleString()} bytes and cannot be read whole `
      + `(this runtime holds at most ${STRING_CEILING.toLocaleString()}). It needs a streaming `
      + 'reader; reading it as one string is not a limit that can be raised.');
    error.code = 'ASCRYBE_ARTIFACT_TOO_LARGE';
    error.detail = { path, label, bytes, ceiling: STRING_CEILING };
    throw error;
  }
  if (held.approaching && onWarning) onWarning({ label, path, ...held });
  return JSON.parse(readFileSync(path, 'utf8'));
}
