; Declarations anywhere in an inline HTML script. The script element is the
; admission boundary; nested function/class/variable declarations remain
; source declarations even though a classic script cannot export them.

(function_declaration name: (identifier) @symbol.name) @symbol.decl

(class_declaration name: (_) @symbol.name) @symbol.decl

(lexical_declaration
  (variable_declarator name: (identifier) @symbol.name)) @symbol.decl

(variable_declaration
  (variable_declarator name: (identifier) @symbol.name)) @symbol.decl
