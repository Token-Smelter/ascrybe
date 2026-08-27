const COMMENT_LIMIT = 800;

function boundedText(text) {
  const value = text.join('\n').trim();
  return value.length <= COMMENT_LIMIT
    ? { text: value, truncated: false }
    : { text: value.slice(0, COMMENT_LIMIT), truncated: true };
}

function yamlKey(line) {
  return line.match(/^([A-Za-z_][\w.-]*)\s*:/u)?.[1] || null;
}

export function scanYamlDeclarationComments(lines, ctx) {
  const facts = [];
  for (let index = 0; index < lines.length;) {
    if (!/^\s*#/u.test(lines[index])) { index += 1; continue; }
    const start = index;
    const block = [];
    while (index < lines.length && /^\s*#/u.test(lines[index])) {
      block.push(lines[index].replace(/^\s*#\s?/u, ''));
      index += 1;
    }
    const declaration = yamlKey(lines[index] || '');
    if (!declaration) continue;
    const bounded = boundedText(block);
    facts.push(ctx.fact('declaration_comment', start + 1, {
      syntax: 'yaml', declaration, declaration_line: index + 1,
      comment_line_start: start + 1, comment_line_end: index,
      ...bounded,
    }));
  }
  return facts;
}

function declarationName(node) {
  const declaration = node.type === 'export_statement'
    ? node.childForFieldName('declaration') : node;
  if (!declaration) return null;
  const named = declaration.childForFieldName('name');
  if (named) return named.text;
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    const declarator = declaration.namedChildren.find(child => child.type === 'variable_declarator');
    return declarator?.childForFieldName('name')?.text || null;
  }
  return null;
}

function isDeclaration(node) {
  const declaration = node.type === 'export_statement'
    ? node.childForFieldName('declaration') : node;
  return ['function_declaration', 'class_declaration', 'lexical_declaration', 'variable_declaration']
    .includes(declaration?.type);
}

export function scanJsDeclarationComments(rootNode, ctx) {
  const facts = [];
  const children = rootNode.namedChildren;
  for (let index = 0; index < children.length;) {
    if (children[index].type !== 'comment') { index += 1; continue; }
    const start = index;
    let end = index;
    while (end + 1 < children.length && children[end + 1].type === 'comment'
      && children[end + 1].startPosition.row <= children[end].endPosition.row + 1) end += 1;
    const declarationNode = children[end + 1];
    if (declarationNode && isDeclaration(declarationNode)
      && declarationNode.startPosition.row === children[end].endPosition.row + 1) {
      const bounded = boundedText(children.slice(start, end + 1).map(node => node.text
        .replace(/^\s*\/\/?\s?/mu, '').replace(/^\s*\*\s?/mu, '').replace(/\*\/\s*$/mu, '')));
      facts.push(ctx.fact('declaration_comment', children[start].startPosition.row + 1, {
        syntax: 'javascript', declaration: declarationName(declarationNode),
        declaration_line: declarationNode.startPosition.row + 1,
        comment_line_start: children[start].startPosition.row + 1,
        comment_line_end: children[end].endPosition.row + 1,
        ...bounded,
      }));
    }
    index = end + 1;
  }
  return facts;
}

export default {
  kind: 'declaration_comment',
  filePattern: /\.ya?ml$/iu,
  scan(lines, ctx) { return scanYamlDeclarationComments(lines, ctx); },
};
