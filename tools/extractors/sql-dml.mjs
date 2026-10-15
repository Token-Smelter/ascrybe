// Preserve source witnesses; do not infer authority from naming conventions alone.

const IDENT = String.raw`[A-Za-z_][\w$]*|"[^"]+"|\`[^\`]+\`|\[[^\]]+\]`;
const JS_COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const stripSqlComment = (line) => line.replace(/--.*$/, '');
const unquote = (value) => String(value).replace(/^["`[]|[\]"`]$/g, '');
const COLUMN_LIST_CAP = 128;

const INSERT = new RegExp(String.raw`\bINSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+(${IDENT})\s*(\()?`, 'gi');
const UPDATE = new RegExp(String.raw`\bUPDATE\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?(${IDENT})\s+SET\s+`, 'gi');
const DELETE = new RegExp(String.raw`\bDELETE\s+FROM\s+(${IDENT})`, 'gi');
const ALTER = new RegExp(String.raw`\bALTER\s+TABLE\s+(${IDENT})\s+(ADD|DROP|RENAME)\s+(?:(COLUMN)\s+)?(${IDENT})?(?:\s+TO\s+(${IDENT}))?`, 'gi');
const CREATE_INDEX = new RegExp(String.raw`\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${IDENT})\s*\(([^)]*)\)`, 'gi');

/** Split a parenthesised column list, keeping only bare identifiers. */
function splitColumns(text) {
  return text
    .split(',')
    .map((part) => unquote(part.trim().split(/\s+/)[0] || ''))
    .filter((value) => /^[A-Za-z_][\w$]*$/.test(value));
}

/** Read the balanced parenthesis group beginning at `open` (index OF the '('). */
function balanced(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth++;
    else if (char === ')') { depth--; if (!depth) return text.slice(open + 1, index); }
  }
  return null;
}

export default {
  kind: 'sql_dml',
  filePattern: /\.(?:[cm]?[jt]s|sql)$/i,
  scan(lines, ctx) {
    const isSql = /\.sql$/i.test(ctx.file);
    // Blank out comment lines rather than deleting them, so every offset below
    // still maps to the file's real line number.
    const safe = lines.map((line) => (!isSql && JS_COMMENT_LINE.test(line) ? '' : stripSqlComment(line)));
    const text = safe.join('\n');
    if (!/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/i.test(text)) return [];

    const starts = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
    const lineOf = (offset) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= offset) low = mid; else high = mid - 1; }
      return low + 1;
    };

    const facts = [];
    const emit = (kind, offset, data) => facts.push(ctx.fact(kind, lineOf(offset), data));

    for (const match of text.matchAll(INSERT)) {
      const table = unquote(match[1]);
      const openIndex = match[2] ? match.index + match[0].length - 1 : -1;
      const inner = openIndex >= 0 ? balanced(text, openIndex) : null;
      const columns = inner === null ? null : splitColumns(inner);
      emit('sql_dml', match.index, {
        operation: 'insert',
        table,
        columns: columns ? columns.slice(0, COLUMN_LIST_CAP) : null,
        column_count: columns ? columns.length : null,
        truncated: Boolean(columns && columns.length > COLUMN_LIST_CAP),
        refusal: columns ? null : 'insert_without_explicit_column_list',
      });
    }

    for (const match of text.matchAll(UPDATE)) {
      const table = unquote(match[1]);
      const clauseStart = match.index + match[0].length;
      // The SET clause runs to WHERE / RETURNING / the end of the template
      // literal or statement, whichever comes first.
      const rest = text.slice(clauseStart, clauseStart + 2000);
      const stop = rest.search(/\b(?:WHERE|RETURNING)\b|;|`/i);
      const clause = stop >= 0 ? rest.slice(0, stop) : rest;
      const assignments = [...clause.matchAll(/([A-Za-z_][\w$]*)\s*=/g)].map((entry) => entry[1]);
      const readable = assignments.length > 0 && !/\$\{/.test(clause);
      emit('sql_dml', match.index, {
        operation: 'update',
        table,
        columns: readable ? assignments.slice(0, COLUMN_LIST_CAP) : null,
        column_count: readable ? assignments.length : null,
        truncated: readable && assignments.length > COLUMN_LIST_CAP,
        refusal: readable ? null : 'set_clause_not_statically_readable',
      });
    }

    for (const match of text.matchAll(DELETE)) {
      emit('sql_dml', match.index, { operation: 'delete', table: unquote(match[1]), columns: null, column_count: null, truncated: false, refusal: null });
    }

    for (const match of text.matchAll(ALTER)) {
      const operation = match[2].toLowerCase();
      emit('sql_migration', match.index, {
        statement: 'alter_table',
        table: unquote(match[1]),
        operation,
        target_kind: match[3] ? 'column' : operation === 'rename' ? 'table' : 'unspecified',
        column: match[4] ? unquote(match[4]) : null,
        rename_to: match[5] ? unquote(match[5]) : null,
        refusal: match[4] || match[5] ? null : 'alter_target_not_named_in_statement',
      });
    }

    for (const match of text.matchAll(CREATE_INDEX)) {
      const columns = splitColumns(match[4]);
      emit('sql_migration', match.index, {
        statement: 'create_index',
        table: unquote(match[3]),
        operation: 'create_index',
        target_kind: 'index',
        index_name: unquote(match[2]),
        unique: Boolean(match[1]),
        columns: columns.slice(0, COLUMN_LIST_CAP),
        refusal: columns.length ? null : 'index_column_list_not_readable',
      });
    }

    return facts;
  },
};
