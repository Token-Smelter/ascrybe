; Kotlin import FQN specifiers, one capture per `import` statement.
;
; `identifier` captures the dotted fully-qualified name text (e.g.
; `com.example.app.util.Helper`), exactly as the grammar already joins the
; dotted `simple_identifier` segments into one span — no manual dot-joining
; needed downstream, mirroring how the JS query lets the grammar hand back
; ready-to-use text (imports.scm's `string_fragment` capture).
;
; `(wildcard_import)?` is an OPTIONAL sibling capture: present only for a
; trailing `.*` (e.g. `import com.example.app.widgets.*`), absent for a
; plain FQN import. The extractor derives `is_wildcard` from whether this
; capture fired, and appends `.*` to the raw specifier text for wildcard
; imports so the merge-time resolver can detect wildcards from the fact
; alone (AC-KOTLIN-RESOLUTION: "wildcard handled explicitly").
;
; Decoy imports embedded in `// line comments`, `/* block comments */`, or
; string literals are structurally impossible to match here: the grammar
; parses those spans as `line_comment` / `multiline_comment` /
; `string_literal` nodes, never as `import_header`, so only real import
; statements are ever captured (verified against the real
; tree-sitter-kotlin.wasm grammar bundled in tree-sitter-wasms@0.1.13).

(import_header
  (identifier) @import.fqn
  (wildcard_import)? @import.wildcard) @import.header
