; Top-level exported declarations (functions, classes, const/let bindings —
; including React function components, which are just exported functions or
; const arrow-function bindings and need no special-casing).
;
; `(program (export_statement ...))` requires export_statement to be a
; DIRECT child of the program node — this is what restricts matches to
; *top-level* declarations only; a `const`/`function`/`class` exported from
; inside a nested block never matches.
;
; The class-name field uses `(_)` (wildcard) rather than a concrete node
; type name because the field's node type differs across grammars: plain
; JavaScript's `class_declaration` names with `identifier`, while
; TypeScript/TSX name with `type_identifier`. A concrete type name that
; does not exist in a given grammar makes query construction throw for that
; language, so match structurally instead of by type name.

(program
  (export_statement
    declaration: (function_declaration name: (identifier) @symbol.name)) @symbol.decl)

(program
  (export_statement
    declaration: (class_declaration name: (_) @symbol.name)) @symbol.decl)

(program
  (export_statement
    declaration: (lexical_declaration
      (variable_declarator name: (identifier) @symbol.name))) @symbol.decl)

(program
  (export_statement
    declaration: (variable_declaration
      (variable_declarator name: (identifier) @symbol.name))) @symbol.decl)

; Top-level declarations that are NOT exported. A module-private function or
; constant is still a named, traversable declaration: its enclosing scope is the
; module, so its scope path is unambiguous without any positional component.

(program (function_declaration name: (identifier) @symbol.name) @symbol.decl)

(program (class_declaration name: (_) @symbol.name) @symbol.decl)

(program
  (lexical_declaration
    (variable_declarator name: (identifier) @symbol.name)) @symbol.decl)

(program
  (variable_declaration
    (variable_declarator name: (identifier) @symbol.name)) @symbol.decl)

; Class members. `class_body` is the single body of its class, so a method's
; path through it is unambiguous: Repo.create names exactly one declaration.
; This matches members of exported and unexported classes alike, because both
; are the same `class_declaration` node.

(class_declaration
  body: (class_body
    (method_definition name: (_) @symbol.name) @symbol.decl))
