; Python import forms, one capture per specifier/name occurrence, mirroring
; the discipline of ../queries/imports.scm for the JS/TS grammar family.
; tree-sitter-python assigns real `name`/`module_name`/`alias`/`definition`
; fields for every one of these forms (confirmed against the loaded grammar
; via tools/estate-map/probe-python-grammar.mjs during authoring — not
; assumed from memory of the grammar source).
;
; Four import forms, matching AC-PYTHON-EXTRACTOR's vocabulary:
;   import        `import a.b.c`            (plain dotted import)
;   import-as     `import a.b.c as x`       (aliased dotted import)
;   from-import   `from a.b import x`       (absolute from-import)
;   relative-from `from . import x` /
;                 `from ..pkg import x`     (relative from-import)
;
; `import_statement` and `import_from_statement` both allow more than one
; `name:` field child (comma-separated import lists) — the query engine
; yields one match per such child, so `import a, b as c` produces two
; separate matches sharing nothing, and `from a.b import x, y as z`
; produces two matches that both carry the same `import.from_module`.

(import_statement
  name: (dotted_name) @import.specifier) @import.plain

(import_statement
  name: (aliased_import
    name: (dotted_name) @import.specifier
    alias: (identifier) @import.alias)) @import.aliased

(import_from_statement
  module_name: (dotted_name) @import.from_module
  name: (dotted_name) @import.imported_name) @import.from_plain

(import_from_statement
  module_name: (dotted_name) @import.from_module
  name: (aliased_import
    name: (dotted_name) @import.imported_name
    alias: (identifier) @import.alias)) @import.from_aliased

(import_from_statement
  module_name: (dotted_name) @import.from_module
  (wildcard_import) @import.wildcard) @import.from_wildcard

(import_from_statement
  module_name: (relative_import) @import.relative_module
  name: (dotted_name) @import.imported_name) @import.relative_plain

(import_from_statement
  module_name: (relative_import) @import.relative_module
  name: (aliased_import
    name: (dotted_name) @import.imported_name
    alias: (identifier) @import.alias)) @import.relative_aliased

(import_from_statement
  module_name: (relative_import) @import.relative_module
  (wildcard_import) @import.wildcard) @import.relative_wildcard
