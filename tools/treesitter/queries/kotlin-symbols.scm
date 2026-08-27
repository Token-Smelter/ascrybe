; Top-level (direct children of source_file) class/interface/object/function
; declarations.
;
; PROVENANCE: this bundled tree-sitter-kotlin.wasm grammar (tree-sitter-wasms
; @0.1.13) exposes NO field names at all (`Language.fields` is `[null]`;
; `childForFieldName('name')` throws `RangeError: Bad field name`), unlike
; the JS/TS grammars the sibling imports.scm/symbols.scm queries rely on —
; verified directly against the loaded grammar, not assumed from upstream
; tree-sitter-kotlin docs (which do define fields; this particular prebuilt
; wasm does not carry that metadata). Every capture below is therefore
; STRUCTURAL (child node type, in sibling order) rather than field-based.
;
; `class_declaration` is the single node type for BOTH `class` and
; `interface` (also reused, with extra `modifiers`/`enum`/`data`/etc.
; children spliced in before the keyword, for `data class`, `abstract
; class`, `enum class`, `annotation class` — all still contain a literal
; "class" child token regardless of modifiers). Distinguish class vs.
; interface by matching the literal anonymous keyword token ("class" vs.
; "interface") as an (unanchored) child alongside the (type_identifier) name
; — verified empirically that modifier/keyword children preceding the name
; do not break this match.
;
; `object_declaration` covers top-level singleton objects. A `companion
; object` nested inside a class is also `object_declaration`, but its
; parent is the class's `class_body`, not `source_file` — the `source_file`
; anchor here already excludes it without extra logic.
;
; `function_declaration` covers top-level functions. A member function
; nested inside a class/object `class_body` has the same node type but,
; again, its parent is `class_body`, not `source_file`, so the anchor
; excludes it.

(source_file
  (class_declaration
    "class"
    (type_identifier) @symbol.name) @symbol.decl)

(source_file
  (class_declaration
    "interface"
    (type_identifier) @symbol.name) @symbol.decl)

(source_file
  (object_declaration
    (type_identifier) @symbol.name) @symbol.decl)

(source_file
  (function_declaration
    (simple_identifier) @symbol.name) @symbol.decl)
