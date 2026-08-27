; The file's declared package (at most one per file; absent means the
; default/unnamed package). Same dotted-identifier shape as
; kotlin-imports.scm's `import.fqn` capture.

(source_file
  (package_header
    (identifier) @package.name))
