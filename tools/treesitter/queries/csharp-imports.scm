; Every `using` directive, one capture per statement. The four variants --
; plain (`using X.Y;`), static (`using static X.Y;`), global
; (`global using X.Y;`), and aliased (`using A = X.Y;`) -- all parse to the
; same `using_directive` node type, distinguished only by which anonymous
; keyword tokens (`static`/`global`) and/or a `name_equals` child are present
; among its direct children (verified against the real tree-sitter-c-sharp
; grammar: none of these are exposed as named fields on `using_directive`,
; so the extractor inspects direct children structurally, exactly as
; kotlin-symbols.scm's own comment documents doing for a grammar lacking
; field metadata). The extractor captures the whole node and derives
; is_static/is_global/alias/target from its children.
;
; Decoy `using`-shaped text inside `// line comments`, `/* block comments
; */`, or string literals is structurally impossible to match here: the
; grammar parses those spans as `comment`/`string_literal` (or
; `raw_string_literal`/`verbatim_string_literal`) nodes, never as
; `using_directive`.

(using_directive) @import.directive
