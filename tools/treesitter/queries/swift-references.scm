; Every `user_type` node anywhere in the file is a reference to a named
; type: inheritance clauses, property/parameter/return type annotations,
; optional/array/dictionary element types, generic type arguments, and
; `as?`/`as!` casts all parse to a `user_type` node wrapping one or more
; `type_identifier` children (verified against the real tree-sitter-swift
; grammar). Comments and string literals parse to distinct
; `comment`/`multiline_comment`/`line_string_literal` node types whose text
; is opaque leaf content -- this query structurally cannot match decoy
; import/type text embedded inside them, the same guarantee the JS/TS
; import query gets for free from the grammar (see treesitter-js.mjs).
;
; A qualified/dotted type (`Foundation.Notification.Name`) parses to ONE
; `user_type` node with multiple `type_identifier` children (not nested);
; this un-anchored child pattern matches each segment as its own reference
; fact. merge.mjs's resolution pass then classifies each independently
; against the project symbol table, so an unresolvable qualified segment
; simply resolves to `external` rather than requiring special-case parsing
; here.
(user_type (type_identifier) @reference.name) @reference.node
