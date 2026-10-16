import { isAbsolute, relative, sep } from 'node:path';

// A child named like "..state" is still inside its parent; only a ".." path segment leaves it.
export function isWithin(parent, child) {
  const r = relative(parent, child);
  return r === '' || !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r));
}
