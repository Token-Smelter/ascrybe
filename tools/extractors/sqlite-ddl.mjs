// EMBEDDED-SQLITE-DDL extractor.
//
// WHY A SECOND SQL EXTRACTOR EXISTS. `extractors/sql.mjs` matches `filePattern:
// /\.sql$/i` and emits one `sql_object` fact per `CREATE TABLE/VIEW`. This estate
// has ZERO `.sql` files: every table is created from a template literal inside a
// `.mjs` module (`src/runtime/plugin-context.mjs:13`, `plugins/workflow-engine/server/
// index.mjs:6263`, `plugins/task-goals/server/schema.mjs:43`, …). So the shipped
// SQL extractor finds none of this estate's schema, and the schema is the strongest
// available evidence for what the platform's ENTITIES are and how they relate.
//
// This extractor reads the DDL where it really lives, and it reads DDL ONLY —
// `CREATE TABLE` statements and their column/constraint lines. It never opens a
// `.db`/`.sqlite` file, never issues a query, and never sees a row. That is a
// property of the implementation (line-oriented text scan over source files), not
// a promise: there is no database handle in this module.
//
// FACT KINDS (all witnessed at the real line):
//   sqlite_table      one per `CREATE TABLE [IF NOT EXISTS] <name> (`, carrying the
//                     declared primary key columns and the count of columns parsed.
//   sqlite_ref        one per DECLARED foreign key — either the column-level
//                     `<col> … REFERENCES <table>(<col>)` form
//                     (plugins/workflow-engine/server/index.mjs:6293) or the
//                     table-level `FOREIGN KEY (<col>) REFERENCES <table>(<col>)`
//                     form (plugins/session-notes/server/index.mjs:108).
//   sqlite_id_column  one per FK-SHAPED column that declares NO reference: a
//                     column whose name ends `_id` (or is exactly `id`). The
//                     TARGET is deliberately NOT resolved here — a per-file scan
//                     cannot see other files' tables, and guessing a target from a
//                     name inside one file is how a wrong witness gets minted.
//                     Resolution against the estate-wide table set happens in
//                     entity-layer.mjs, which can cite both ends.
//
// Every fact carries `unique_column` / `primary_key_column`, because that single
// bit is what separates `has_one` from `has_many` when the ER layer annotates
// cardinality: a plain FK column admits many child rows per parent, a UNIQUE or
// PRIMARY KEY column admits exactly one.

// PORTABILITY (semantic-portability-report-2026-07-27.md §F1). `CREATE TABLE` is
// the same eleven characters in every language that embeds SQL, but this pattern
// used to accept only the SQLite/JS spellings this estate writes. Three real
// spellings on other estates did not match and produced ZERO tables where the DDL
// was sitting in plain sight:
//   * `CREATE OR REPLACE TABLE`  — BigQuery migrations, e.g.
//     <estate>/<component>/bigquery/migrations/
//     0001_create_raw_revenue_tables.sql
//   * a QUALIFIED name `dataset.table` / `project.dataset.table` — same files;
//     the old alternation stopped at the first `.` and then failed on `\s*\(`.
//   * `CREATE TEMP TABLE` / `CREATE TEMPORARY TABLE`.
// The identifier alternation now admits dotted qualifiers in every quoting style.
const CREATE_TABLE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\.(?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\]))*)\s*\(/i;
// A qualified name's LAST segment is the table; the leading segments are the
// dataset/schema/project. Split rather than slugged, so `revenue.charges` and
// `analytics.charges` are still distinguishable in `qualified_name` while the
// entity layer (which keys on the table's own name) sees `charges` in both.
//
// BOTH real quoting shapes have to survive this, and they nest differently:
//   `` `sleepworlds.revenue.app_store_connect_sales_raw` ``  — ONE quoted span
//       holding the dots (BigQuery's usual spelling), and
//   `sleepworlds_analytics.gold_asset_registry`              — unquoted.
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
// `CHECK (<col> IN ('a','b'))` is the only place this estate's schema ENUMERATES what a
// polymorphic id column may point at (plugins/task-goals/server/schema.mjs:236 lists
// 'intent','work_order','brew','criterion' for initiative_membership.item_kind). Without it,
// `item_id` is an unresolvable reference; with it, the membership fan-out is a schema fact.
const CHECK_IN = /\bCHECK\s*\(\s*([A-Za-z_][\w$]*)\s+IN\s*\(([^)]*)\)/i;
// A `--` line comment, and a `/* */`-free approximation of it. DDL in this estate
// documents itself heavily (plugins/workflow-engine/server/index.mjs:6328-6334); a
// comment that mentions `REFERENCES brews(brew_id)` is prose, not a constraint.
const stripComment = line => line.replace(/--.*$/, '');
// A JS comment is PROSE ABOUT the DDL, not DDL. Skipping comment lines is load-bearing, not
// cosmetic, and this is not a hypothetical: the first real-corpus run of this extractor
// promoted an entity called `x` whose only witness was THIS FILE's own explanatory comment
// quoting `CREATE TABLE x (a TEXT PRIMARY KEY, b TEXT)`. extractors/envelopes.mjs carries the
// identical guard for the identical reason.
// The `#` arm is what makes this safe on Python/Ruby/shell, where the JS comment
// markers never appear: without it, this file's own Python-side equivalent — a
// `# CREATE TABLE x (` line of explanation — would mint a phantom table exactly
// as the JS form once did. `--` needs no arm here because `stripComment` already
// removes it before any pattern runs.
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
      // A single-line `CREATE TABLE x (a TEXT PRIMARY KEY, b TEXT)` closes on its
      // own line (src/runtime/plugin-context.mjs:212 is exactly this shape).
      depth += netParens(after);
      if (depth <= 0) { collectBody(open, after, index + 1); tables.push(finish(open)); open = null; }
      else collectBody(open, after, index + 1);
      continue;
    }
    const before = depth;
    depth += netParens(line);
    // Only a line that STARTS at depth 1 is a column or table constraint of this
    // table; a continuation line inside `CHECK (status IN (...))` starts deeper
    // (plugins/work-dispatch/server/aggregates/stagedDispatchJob/repo.mjs:105).
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
    // The `REFERENCES` half may sit on the SAME line or the NEXT one
    // (plugins/session-notes/server/index.mjs:108 keeps them together;
    // src/plugin-runtime/sqlInbox.mjs:58-59 splits them). Only the same-line
    // form is groundable from here; the split form is picked up by the
    // pending-reference carry below.
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
  // PORTABILITY (semantic-portability-report-2026-07-27.md §F1). This was
  // `/\.[cm]?[jt]s$/i` — JS/TS ONLY — because on THIS estate the DDL lives in
  // server-side `.mjs` template literals. That gate is the single reason the
  // `entity` semantic family scored ZERO on every foreign estate measured:
  //   * task-management declares `processed_files` and `tasks` in PYTHON
  //     (src/voice_task_manager/utils/database.py:53,:76) — never opened;
  //   * sw declares 42 BigQuery tables/views in `.sql` files
  //     (<component>/bigquery/migrations/0001_create_tables.sql)
  //     — routed to sql.mjs, which emits only a NAME (`sql_object`) and no
  //     columns, keys or references, so entity-layer.mjs (which consumes
  //     `sqlite_table` / `sqlite_ref` / `sqlite_id_column` and nothing else)
  //     saw an empty table registry.
  // The proof this was failure-to-look and not genuine absence: discover-entities.mjs
  // ALREADY reads the same `CREATE TABLE` lines out of those same `.py` files under
  // its `sqlite-create-table` anchor and reported them as clusters. Two readers of
  // one piece of evidence, one of them blind.
  //
  // The languages listed are exactly the ones this repo already parses with a
  // tree-sitter extractor (js/ts, python, c#, kotlin, swift) plus `.sql` itself,
  // plus the three other common hosts of embedded DDL. Widening the gate does not
  // widen the CLAIM: the parser still reads only `CREATE TABLE` blocks, still skips
  // comment lines, and still emits one fact per real line.
  //
  // `.sql` overlaps sql.mjs deliberately. The two emit DIFFERENT fact kinds
  // (`sql_object` vs `sqlite_table`) which merge.mjs routes to different node kinds
  // (`sql:` nodes via merge.mjs:376 vs the entity layer's table registry), so there
  // is no double-count — there is a NAME-only record and a STRUCTURE record of the
  // same declaration, which is what lets the map say both "this object exists" and
  // "these are its columns".
  filePattern: /\.(?:[cm]?[jt]sx?|py|sql|kt|swift|cs|rb|go|php|java)$/i,
  scan(lines, ctx) {
    const facts = [];
    const parsedTables = parseCreateTables(lines);
    if (parsedTables.length) facts.push(...scanDdlComments(lines, parsedTables, ctx));
    for (const table of parsedTables) {
      const referenced = new Set(table.refs.map(ref => ref.column));
      facts.push(ctx.fact('sqlite_table', table.line, {
        table: table.table,
        // Null on an unqualified declaration, so this estate's output is
        // byte-identical to what it was before qualified names were parsed.
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
