; Top-level declared class/struct/interface/enum/record: a type declaration
; is "top-level" when it is a direct child of (a) a namespace's body
; (`namespace X { ... }`), (b) a file-scoped namespace declaration
; (`namespace X;`, whose members are direct children of the
; `file_scoped_namespace_declaration` node itself rather than wrapped in a
; `declaration_list` -- verified against the real grammar), or (c) the
; compilation unit directly (the "global namespace", no `namespace` keyword
; at all in the file). A type nested inside ANOTHER type's body (e.g. a
; class declared inside another class) is excluded by these three anchors,
; since its parent `declaration_list`'s parent is that enclosing type
; declaration, not one of the three contexts above -- mirrors
; kotlin-symbols.scm's `(source_file ...)` top-level anchor and
; swift-symbols.scm's `extension`-exclusion discipline of "only a real
; top-level declaration produces a symbol fact".
;
; PATTERN ORDER IS LOAD-BEARING: treesitter-csharp.mjs maps each pattern's
; positional index to a symbol_kind via
; SYMBOL_KIND_BY_PATTERN_INDEX = ['class','struct','interface','enum','record'] repeated
; three times (namespace-scoped, file-scoped, global) in EXACTLY the order
; declared below. Editing this file requires updating that array to match.

(namespace_declaration
  body: (declaration_list
    (class_declaration name: (identifier) @symbol.name) @symbol.decl))
(namespace_declaration
  body: (declaration_list
    (struct_declaration name: (identifier) @symbol.name) @symbol.decl))
(namespace_declaration
  body: (declaration_list
    (interface_declaration name: (identifier) @symbol.name) @symbol.decl))
(namespace_declaration
  body: (declaration_list
    (enum_declaration name: (identifier) @symbol.name) @symbol.decl))
(namespace_declaration
  body: (declaration_list
    (record_declaration name: (identifier) @symbol.name) @symbol.decl))

(file_scoped_namespace_declaration
  (class_declaration name: (identifier) @symbol.name) @symbol.decl)
(file_scoped_namespace_declaration
  (struct_declaration name: (identifier) @symbol.name) @symbol.decl)
(file_scoped_namespace_declaration
  (interface_declaration name: (identifier) @symbol.name) @symbol.decl)
(file_scoped_namespace_declaration
  (enum_declaration name: (identifier) @symbol.name) @symbol.decl)
(file_scoped_namespace_declaration
  (record_declaration name: (identifier) @symbol.name) @symbol.decl)

(compilation_unit
  (class_declaration name: (identifier) @symbol.name) @symbol.decl)
(compilation_unit
  (struct_declaration name: (identifier) @symbol.name) @symbol.decl)
(compilation_unit
  (interface_declaration name: (identifier) @symbol.name) @symbol.decl)
(compilation_unit
  (enum_declaration name: (identifier) @symbol.name) @symbol.decl)
(compilation_unit
  (record_declaration name: (identifier) @symbol.name) @symbol.decl)
