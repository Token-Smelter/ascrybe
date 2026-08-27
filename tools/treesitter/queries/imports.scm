; Import/require/dynamic-import/re-export specifiers, one capture per
; occurrence. Shared verbatim across the javascript, typescript, and tsx
; grammars (node type + field names for these forms are identical across
; all three tree-sitter-javascript-family grammars).
;
; `import.specifier` always captures the `string_fragment` node — the raw
; specifier text with quotes already stripped by the grammar, so no
; quote-trimming logic is needed downstream.

(import_statement
  source: (string (string_fragment) @import.specifier)) @import.statement

(export_statement
  source: (string (string_fragment) @import.specifier)) @import.reexport

(call_expression
  function: (identifier) @import.call_name
  arguments: (arguments (string (string_fragment) @import.specifier))) @import.call

(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @import.specifier))) @import.dynamic
