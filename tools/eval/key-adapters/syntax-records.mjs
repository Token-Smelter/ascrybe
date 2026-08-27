export const version = 'syntax-records/v1';

async function treeSitterParser({ source, language, query, capture = 'value' }) {
  const { languages, TreeSitter } = await import('../../treesitter/loader.mjs');
  if (!languages[language]) throw new Error(`unknown configured tree-sitter language: ${language}`);
  const parser = new TreeSitter();
  parser.setLanguage(languages[language]);
  const matches = languages[language].query(query).matches(parser.parse(source));
  return matches.flatMap(match => match.captures.filter(item => item.name === capture).map(item => ({
    value: item.node.text, line_start: item.node.startPosition.row + 1,
    line_end: item.node.endPosition.row + 1, quote: item.node.text,
  })));
}

// The language, grammar selection, query, and capture name are declarative question inputs.
export async function derive({ repository, specification, parser = { query: treeSitterParser } }) {
  if (!parser?.query) throw new Error('syntax adapter requires a tree-sitter parser');
  const paths = (await repository.listFiles(specification.directory ?? '')).filter(path =>
    (specification.extensions ?? []).some(extension => path.endsWith(extension))).sort();
  const captures = [];
  for (const path of paths) {
    const source = await repository.readFile(path);
    for (const capture of await parser.query({ source, path, language: specification.language, query: specification.query,
      capture: specification.capture })) {
      if (typeof capture.value !== 'string' || !Number.isInteger(capture.line_start)) throw new Error(`syntax capture refusal: ${path}`);
      captures.push({ value: capture.value, path, line_start: capture.line_start, line_end: capture.line_end ?? capture.line_start, quote: capture.quote ?? capture.value });
    }
  }
  return { answer_units: [...new Set(captures.map(capture => capture.value))].sort(), witnesses: captures };
}
