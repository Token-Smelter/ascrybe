// Preserve source witnesses; do not infer authority from naming conventions alone.

// Preserve source witnesses; do not infer authority from naming conventions alone.
const CREATE_TABLE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\.(?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\]))*)\s*\(/i;
// A qualified name's LAST segment is the table; the leading segments are the
// dataset/schema/project. Split rather than slugged, so `revenue.charges` and
// `analytics.charges` are still distinguishable in `qualified_name` while the
// entity layer (which keys on the table's own name) sees `charges` in both.
//
// BOTH real quoting shapes have to survive this, and they nest differently:
//   `` `orchardlabs.revenue.storefront_sales_raw` ``  — ONE quoted span
//       holding the dots (BigQuery's usual spelling), and
//   `orchardlabs_analytics.gold_asset_registry`              — unquoted.
// So the outer quoting is stripped FIRST and the dots are split AFTER; splitting
// first left the backticked form as a single 47-character "table name".
const splitQualifiedName = raw => unquote(String(raw).trim())
  .split('.')
  .map(part => unquote(part.trim()))
  .filter(Boolean);
// A column definition starts with a bare identifier; a table-level constraint
// starts with one of these keywords. Distinguishing them is what keeps
// `PRIMARY KEY (a, b)` out of the column list and `FOREIGN KEY (x)` out of it too.
const TABLE_CONSTRAINT = /^\s*(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i;
const COLUMN_START = /^\s*([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s+/;
const COLUMN_REFERENCES = /\bREFERENCES\s+([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`)\s*\(\s*([A-Za-z_][\w$]*)\s*\)/i;
const TABLE_FOREIGN_KEY = /\bFOREIGN\s+KEY\s*\(\s*([^)]+?)\s*\)\s*(?:--.*)?$/i;
const TABLE_PRIMARY_KEY = /^\s*PRIMARY\s+KEY\s*\(\s*([^)]+?)\s*\)/i;
const TABLE_UNIQUE = /^\s*UNIQUE\s*\(\s*([^)]+?)\s*\)/i;
const ID_COLUMN = /^(?:id|[\w$]+_id)$/i;
// Preserve source witnesses; do not infer authority from naming conventions alone.
const CHECK_IN = /\bCHECK\s*\(\s*([A-Za-z_][\w$]*)\s+IN\s*\(([^)]*)\)/i;
// Preserve source witnesses; do not infer authority from naming conventions alone.
const stripComment = line => line.replace(/--.*$/, '');
const JS_COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;
const unquote = value => String(value).replace(/^["`[]|[\]"`]$/g, '');
const splitColumns = value => value.split(',').map(part => unquote(part.trim().split(/\s+/)[0])).filter(Boolean);

/**
 * Parse every `CREATE TABLE` block in `lines`. Returns one entry per table with
 * 1-based line numbers, exported so entity-layer.mjs and the tests can reuse the
 * identical parse rather than reimplementing it (a second parser is a second set
 * of bugs, and the ER layer's witnesses have to match the extractor's exactly).
 */
export function parseCreateTables(lines) {
  const tables = [];
  let open = null;
  let depth = 0;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (JS_COMMENT_LINE.test(raw)) continue;
    const line = stripComment(raw);
    if (!open) {
      const match = line.match(CREATE_TABLE);
      if (!match) continue;
      const after = line.slice(match.index + match[0].length);
      const parts = splitQualifiedName(match[1]);
      open = {
        table: parts[parts.length - 1],
        qualified_name: parts.length > 1 ? parts.join('.') : null,
        line: index + 1, columns: [], primary_key: [], unique: [], refs: [], check_enums: [],
      };
      depth = 1;
      // Preserve source witnesses; do not infer authority from naming conventions alone.
      depth += netParens(after);
      if (depth <= 0) { collectBody(open, after, index + 1); tables.push(finish(open)); open = null; }
      else collectBody(open, after, index + 1);
      continue;
    }
    const before = depth;
    depth += netParens(line);
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    if (before === 1) collectBody(open, line, index + 1);
    if (depth <= 0) { tables.push(finish(open)); open = null; }
  }
  // An unterminated block is a parse failure, not a table: reporting a
  // half-parsed table would ship a schema claim the source never made.
  return tables;
}

function netParens(text) {
  let delta = 0;
  let quote = null;
  for (const char of text) {
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') delta++;
    else if (char === ')') delta--;
  }
  return delta;
}

function collectBody(open, line, lineNumber) {
  const check = line.match(CHECK_IN);
  if (check) {
    const values = [...check[2].matchAll(/'([^']*)'/g)].map(match => match[1]).filter(Boolean);
    if (values.length) open.check_enums.push({ column: unquote(check[1]), values, line: lineNumber });
  }
  const primary = line.match(TABLE_PRIMARY_KEY);
  if (primary) { open.primary_key.push(...splitColumns(primary[1])); return; }
  const unique = line.match(TABLE_UNIQUE);
  if (unique) {
    // A MULTI-column UNIQUE constrains the TUPLE, not its members: under
    // `UNIQUE (initiative_id, item_kind, item_id)` one initiative still has many rows. Reading
    // each member as unique would turn every junction table into a 1:1 in the ER layer.
    const columns = splitColumns(unique[1]);
    if (columns.length === 1) open.unique.push(columns[0]);
    return;
  }
  const foreignKey = line.match(TABLE_FOREIGN_KEY);
  if (foreignKey) {
    // Preserve source witnesses; do not infer authority from naming conventions alone.
    const reference = line.match(COLUMN_REFERENCES);
    const columns = splitColumns(foreignKey[1]);
    if (reference) for (const column of columns) open.refs.push({ column, target_table: unquote(reference[1]), target_column: reference[2], line: lineNumber, form: 'table_foreign_key' });
    else open.pending_foreign_key = { columns, line: lineNumber };
    return;
  }
  if (open.pending_foreign_key) {
    const reference = line.match(COLUMN_REFERENCES);
    if (reference) {
      for (const column of open.pending_foreign_key.columns) {
        open.refs.push({ column, target_table: unquote(reference[1]), target_column: reference[2], line: open.pending_foreign_key.line, form: 'table_foreign_key' });
      }
      open.pending_foreign_key = null;
      return;
    }
    open.pending_foreign_key = null;
  }
  if (TABLE_CONSTRAINT.test(line)) return;
  const column = line.match(COLUMN_START);
  if (!column) return;
  const name = unquote(column[1]);
  const inlinePrimary = /\bPRIMARY\s+KEY\b/i.test(line);
  const inlineUnique = /\bUNIQUE\b/i.test(line);
  if (inlinePrimary) open.primary_key.push(name);
  if (inlineUnique) open.unique.push(name);
  open.columns.push({ name, line: lineNumber, primary_key: inlinePrimary, unique: inlineUnique });
  const reference = line.match(COLUMN_REFERENCES);
  if (reference) open.refs.push({ column: name, target_table: unquote(reference[1]), target_column: reference[2], line: lineNumber, form: 'column_references' });
}

function finish(open) {
  delete open.pending_foreign_key;
  const primary = [...new Set(open.primary_key)];
  open.check_enums.sort((a, b) => a.column.localeCompare(b.column) || a.line - b.line);
  const unique = new Set(open.unique);
  return {
    table: open.table,
    qualified_name: open.qualified_name || null,
    line: open.line,
    primary_key: primary,
    check_enums: open.check_enums,
    columns: open.columns.map(column => ({
      ...column,
      primary_key: column.primary_key || primary.includes(column.name),
      // A single-column PRIMARY KEY is a uniqueness constraint; a member of a
      // COMPOSITE primary key is not (two rows may share it), and treating it as
      // one would turn every junction table into a has_one.
      unique: column.unique || unique.has(column.name) || (primary.length === 1 && primary[0] === column.name),
    })),
    refs: open.refs,
  };
}

// F4 (second half) — DDL COMMENT RETENTION (orientation-test-report.md §7.2).
//
// F4 asks for "comment retention adjacent to manifest and DDL keys" because it
// "exposes the stale-comment class that Q10 and the round-2 report both turn
// on." Q10 asks the reader to "note anything misleading about how this table is
// documented **in the same file**" — the misleading text is a COMMENT beside
// the DDL, and a schema extractor that strips comments (this one does,
// deliberately, so prose can never be parsed as a constraint) also destroys the
// evidence for that clause.
//
// Both properties are kept. parseCreateTables still skips comment lines exactly
// as before, so no comment can ever become a column or a constraint. Comments
// are ADDITIONALLY emitted as their own fact kind, `sqlite_comment`, tagged
// with the table they sit in or above and flagged `is_constraint: false`. A
// reader can then compare what the prose SAYS against what the CHECK actually
// enumerates — which is the whole of Q10's second clause.
const COMMENT_TEXT = /^\s*(?:\/\/|\/\*|\*|--)\s?(.*?)\s*(?:\*\/)?\s*$/;
const COMMENT_ANY = /^\s*(?:\/\/|\/\*|\*|--)/;
const COMMENT_LEAD_WINDOW = 12;
const DDL_COMMENT_CAP = 80;

function scanDdlComments(lines, tables, ctx) {
  const facts = [];
  // A comment BELONGS to a table when it sits inside the table's line span, or
  // in the short window directly above its `CREATE TABLE` line. Anything else
  // is unattached prose and is not claimed for any table.
  const spans = tables.map(table => ({
    table: table.table,
    start: table.line,
    end: Math.max(table.line, ...table.columns.map(column => column.line), ...table.check_enums.map(entry => entry.line)),
  }));
  for (let index = 0; index < lines.length && facts.length < DDL_COMMENT_CAP; index++) {
    if (!COMMENT_ANY.test(lines[index])) continue;
    const text = (lines[index].match(COMMENT_TEXT)?.[1] || '').trim();
    if (!text) continue;
    const lineNumber = index + 1;
    const inside = spans.find(span => lineNumber > span.start && lineNumber <= span.end);
    const above = inside ? null : spans.find(span => span.start > lineNumber && span.start - lineNumber <= COMMENT_LEAD_WINDOW);
    const owner = inside || above;
    if (!owner) continue;
    facts.push(ctx.fact('sqlite_comment', lineNumber, {
      table: owner.table,
      text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
      position: inside ? 'inside_create_table' : 'above_create_table',
      table_line: owner.start,
      // A comment is PROSE ABOUT the schema, never a constraint. This flag
      // exists so no consumer can confuse the two — the point of Q10 is that
      // the prose and the constraint DISAGREE.
      is_constraint: false,
    }));
  }
  return facts;
}

export default {
  kind: 'sqlite_table',
  // Preserve source witnesses; do not infer authority from naming conventions alone.
  filePattern: /\.(?:[cm]?[jt]sx?|py|sql|kt|swift|cs|rb|go|php|java)$/i,
  scan(lines, ctx) {
    const facts = [];
    const parsedTables = parseCreateTables(lines);
    if (parsedTables.length) facts.push(...scanDdlComments(lines, parsedTables, ctx));
    for (const table of parsedTables) {
      const referenced = new Set(table.refs.map(ref => ref.column));
      facts.push(ctx.fact('sqlite_table', table.line, {
        table: table.table,
        // Preserve source witnesses; do not infer authority from naming conventions alone.
        ...(table.qualified_name ? { qualified_name: table.qualified_name } : {}),
        primary_key: table.primary_key,
        column_count: table.columns.length,
        check_enums: table.check_enums,
      }));
      for (const ref of table.refs) {
        const column = table.columns.find(entry => entry.name === ref.column);
        facts.push(ctx.fact('sqlite_ref', ref.line, {
          table: table.table,
          column: ref.column,
          target_table: ref.target_table,
          target_column: ref.target_column,
          form: ref.form,
          unique_column: Boolean(column?.unique),
          primary_key_column: Boolean(column?.primary_key),
        }));
      }
      for (const column of table.columns) {
        if (referenced.has(column.name) || !ID_COLUMN.test(column.name)) continue;
        facts.push(ctx.fact('sqlite_id_column', column.line, {
          table: table.table,
          column: column.name,
          unique_column: column.unique,
          primary_key_column: column.primary_key,
        }));
      }
    }
    return facts;
  },
};
