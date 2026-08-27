; Namespace declarations, both forms: block-scoped (`namespace X.Y { ... }`)
; and file-scoped (`namespace X.Y;`, C# 10+). Namespace declarations may
; nest (`namespace A { namespace B { ... } }`), so a query alone cannot
; assemble the full dotted ancestor chain for a nested case -- the
; extractor walks each captured node's ancestor chain itself (plain node
; traversal, verified against the real tree-sitter-c-sharp grammar's `name`
; field on both node types) to compute the complete fully-qualified name,
; the same "structural traversal beside a declarative capture" division of
; labor treesitter-swift.mjs uses for its symbol-kind disambiguation.

(namespace_declaration) @namespace.decl
(file_scoped_namespace_declaration) @namespace.decl
