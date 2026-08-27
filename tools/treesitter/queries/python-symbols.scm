; Top-level Python symbols: module-level `def`, `class`, and assignments.
;
; `(module (function_definition ...))` requires the definition to be a
; DIRECT child of the module node (the file's top level), exactly like the
; JS/TS symbols.scm restricts to `(program (export_statement ...))` — a
; `def`/`class`/assignment nested inside a function or block never matches.
;
; `@symbol.decl` is placed on the innermost `function_definition` /
; `class_definition` / `assignment` node (not the `decorated_definition`
; wrapper) so a decorated top-level def/class reports the same
; `declNode.type` as an undecorated one, letting the extractor use one
; node-type -> symbol_kind table for both.

(module
  (function_definition name: (identifier) @symbol.name) @symbol.decl)

(module
  (class_definition name: (identifier) @symbol.name) @symbol.decl)

(module
  (decorated_definition
    definition: (function_definition name: (identifier) @symbol.name) @symbol.decl))

(module
  (decorated_definition
    definition: (class_definition name: (identifier) @symbol.name) @symbol.decl))

(module
  (expression_statement
    (assignment left: (identifier) @symbol.name) @symbol.decl))
