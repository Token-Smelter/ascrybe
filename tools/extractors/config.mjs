const configFile = /(?:^|\/)(?:appsettings(?:\.[^.\/]+)?|[^\/]*config)[^\/]*\.json$/i;
const urlValue = /^\s*"([^"]+)"\s*:\s*"(https?:\/\/[^"\s]+)"\s*,?\s*$/i;

export function safeConfigUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.href.replace(/\/$/, parsed.pathname === '/' ? '' : '/');
  } catch {
    return null;
  }
}

export default {
  kind: 'config_value_url',
  filePattern: /\.json$/i,
  scan(lines, ctx) {
    const facts = [];
    try {
      JSON.parse(lines.join('\n'));
      facts.push(ctx.fact('json_document', 1, {}));
    } catch {
      // A file that does not parse as JSON cannot witness a JSON document identity.
    }
    if (!configFile.test(ctx.file)) return facts;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(urlValue);
      const url = match && safeConfigUrl(match[2]);
      if (url) facts.push(ctx.fact('config_value_url', index + 1, { key: match[1], url }));
    }
    return facts;
  },
};
