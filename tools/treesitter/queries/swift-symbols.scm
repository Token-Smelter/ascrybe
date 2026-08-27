; Top-level declared symbols: class/struct/enum/extension all share the
; `class_declaration` node type in tree-sitter-swift, disambiguated in
; treesitter-swift.mjs by the `declaration_kind` field's anonymous keyword
; child (class/struct/enum/extension). `extension`'s `name` field wraps the
; extended type reference in a `user_type` node (it names an EXISTING type,
; not a new declaration) rather than the bare `type_identifier` class/struct/
; enum use directly -- both shapes are queried separately below (verified
; against the real grammar; a concrete node type that doesn't occur for a
; given pattern just yields zero matches, it does not throw).
;
; `(source_file ...)` requires the declaration to be a DIRECT child of the
; file's root node, restricting matches to top-level declarations only --
; mirrors treesitter-js.mjs's `(program (export_statement ...))` anchor.

(source_file
  (class_declaration
    name: (type_identifier) @symbol.name) @symbol.decl)

(source_file
  (class_declaration
    name: (user_type (type_identifier) @symbol.name)) @symbol.decl)

(source_file
  (protocol_declaration
    name: (type_identifier) @symbol.name) @symbol.decl)

(source_file
  (function_declaration
    name: (simple_identifier) @symbol.name) @symbol.decl)

(source_file
  (property_declaration
    name: (pattern
      bound_identifier: (simple_identifier) @symbol.name)) @symbol.decl)
