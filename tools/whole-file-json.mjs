// Reading a JSON artifact that has to fit in one string.
//
// `JSON.parse` needs a string, and this runtime cannot hold one larger than 536,870,888 bytes.
// Estate artifacts cross that line as an estate grows, and when they do the failure is a bare
// RangeError from inside a read with nothing naming the artifact, the limit, or what to do.
//
// It has happened twice in this repository already: the model output accumulator capped 24 bytes
// above the ceiling, and the whole-file claim map at 644,632,920 bytes for a 1,154-document
// estate. The code graph for that same estate is at 403,750,181 -- three quarters of the way --
// so the next occurrence is a matter of the estate growing, not of anyone making a mistake.
//
// So: refuse past the ceiling with the artifact and the numbers named, and warn while approaching
// it, because a limit you only learn about by hitting it is a limit nobody could plan around.
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
