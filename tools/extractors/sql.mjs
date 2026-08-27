export default {
  kind: 'sql_object',
  filePattern: /\.sql$/i,
  scan(lines, ctx) {
    const facts = [];
    const pattern = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.[\]"`-]+)/i;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (match) {
        facts.push(ctx.fact('sql_object', index + 1, {
          object: match[2].replace(/[\[\]"`]/g, ''),
          object_kind: match[1].toLowerCase(),
        }));
      }
    }
    return facts;
  },
};
