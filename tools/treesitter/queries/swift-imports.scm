; Framework/module imports (`import Foundation`, `import UIKit`, submodule
; imports like `import Foundation.NSObject`, or declaration-kind imports
; like `import struct Swift.Array`). Unlike JS/TS, Swift has no per-file
; import between files of the SAME module -- `import X` always names an
; external MODULE/framework dependency (see merge.mjs's `imports_framework`
; resolution pass), never a file in this project.
;
; The `identifier` node's raw text already includes any dotted submodule
; path (verified against the real tree-sitter-swift grammar: `import
; Foundation.NSObject` parses to one `identifier` node containing two
; `simple_identifier` children joined by an anonymous `.` token) -- captured
; verbatim as one fact per import_declaration, mirroring the raw-specifier
; convention treesitter-js.mjs uses for JS/TS imports.

(import_declaration
  (identifier) @import.module) @import.statement
