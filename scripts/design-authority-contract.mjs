import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ledgerSchema = 'ascrybe/public-document-authority/v1';
export const bridgeSchema = 'ascrybe/public-document-snapshot/v1';
export const authorityScope = 'Published documentation only; no claims about unpublished records or unavailable history.';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function governedPaths(root) {
  const paths = ['AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'USAGE.md'];
  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) paths.push(path);
      else if (entry.isSymbolicLink()) throw new Error(`governed directory contains a symlink: ${path}`);
    }
  }
  walk('docs');
  return paths.sort();
}

export function documentSnapshot(root, path) {
  const bytes = readFileSync(join(root, path));
  return { document_id: path, bytes: bytes.length, sha256: digest(bytes) };
}
