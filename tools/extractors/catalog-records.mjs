import YAML from 'yaml';
import { stableCanonicalSha256 } from '../lib.mjs';

export const CATALOG_VALUE_LIMIT = 400;

function globPattern(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index += 1; }
        else expression += '.*';
      } else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}

function matchesCatalog(file, globs) {
  return (globs || []).some(pattern => globPattern(pattern).test(file));
}

function scalarFields(value, path = '', fields = {}, omitted = []) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (String(value).length > CATALOG_VALUE_LIMIT) {
      omitted.push({ key_path: path, reason: 'catalog_scalar_value_exceeds_limit', limit: CATALOG_VALUE_LIMIT });
    } else fields[path] = value;
    return { fields, omitted };
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scalarFields(item, `${path}[${index}]`, fields, omitted));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      scalarFields(item, path ? `${path}.${key}` : key, fields, omitted);
    }
  }
  return { fields, omitted };
}

function parse(file, text) {
  if (/\.json$/iu.test(file)) return JSON.parse(text);
  const document = YAML.parseDocument(text, { logLevel: 'silent' });
  if (document.errors?.length) throw document.errors[0];
  return document.toJS();
}

export default {
  kind: 'catalog_entry',
  filePattern: /\.(?:json|ya?ml)$/iu,
  scan(lines, ctx) {
    if (!matchesCatalog(ctx.file, ctx.catalog_globs)) return [];
    let document;
    try { document = parse(ctx.file, lines.join('\n')); }
    catch (error) {
      return [ctx.fact('catalog_entry_refusal', 1, {
        reason: /\.json$/iu.test(ctx.file) ? 'catalog_json_parse_error' : 'catalog_yaml_parse_error',
        detail: String(error.message || error).slice(0, CATALOG_VALUE_LIMIT),
      })];
    }
    const entries = Array.isArray(document)
      ? document.map((value, index) => [`[${index}]`, value])
      : document && typeof document === 'object'
        ? Object.entries(document)
        : null;
    if (!entries) return [ctx.fact('catalog_entry_refusal', 1, {
      reason: 'catalog_root_is_not_a_map_or_sequence', root_type: document === null ? 'null' : typeof document,
    })];
    return entries.flatMap(([keyPath, value]) => {
      const { fields, omitted } = scalarFields(value);
      return [
        ctx.fact('catalog_entry', 1, {
          entry_key_path: keyPath,
          scalar_fields: fields,
          omitted_fields: omitted,
          content_digest: stableCanonicalSha256(value),
        }),
        ...omitted.map(omission => ctx.fact('catalog_entry_refusal', 1, {
          reason: omission.reason,
          entry_key_path: keyPath,
          key_path: omission.key_path,
          limit: omission.limit,
        })),
      ];
    });
  },
};
