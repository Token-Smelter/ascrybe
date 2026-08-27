import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import TreeSitter from 'web-tree-sitter';

const here = dirname(fileURLToPath(import.meta.url));
const grammarRoot = join(here, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out');
const grammarNames = Object.freeze({
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  swift: 'tree-sitter-swift.wasm',
});

await TreeSitter.init();

async function loadGrammar(name) {
  const file = join(grammarRoot, grammarNames[name]);
  if (!existsSync(file)) throw new Error(`missing pinned tree-sitter grammar: ${file}`);
  return TreeSitter.Language.load(file);
}

export const languages = Object.freeze(Object.fromEntries(await Promise.all(
  Object.keys(grammarNames).map(async name => [name, await loadGrammar(name)]),
)));

export { TreeSitter };
