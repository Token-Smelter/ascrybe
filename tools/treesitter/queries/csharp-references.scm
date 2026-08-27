; Type-reference sites: base lists (inheritance/interface implementation)
; and the type annotation of a property, field, parameter, or method return.
;
; `base_list (_)` captures each comma-separated base type individually --
; `(_)` matches only NAMED children, so the `:` and `,` anonymous tokens are
; structurally excluded (verified against the real grammar's `base_list`
; shape: `:` identifier `,` identifier ...).
;
; `field_declaration`'s `variable_declaration` child is anchored explicitly
; (rather than querying `variable_declaration` alone) to exclude LOCAL
; variable declarations inside method bodies, which share the same
; `variable_declaration` node type but nest under `local_declaration_statement`
; instead of `field_declaration` -- deliberately out of scope, mirroring
; treesitter-swift.mjs's documented exclusion of Swift extensions from
; top-level symbols (extra noise from every local `var x = ...` in every
; method body would swamp the real field/property/param/return-type surface
; AC-CSHARP-EXTRACTOR asks for).
;
; The captured node itself may be `predefined_type` (built-in keyword types
; like `string`/`int`/`void` -- never a resolvable project reference),
; `identifier`, `qualified_name`, `generic_name`, `nullable_type`,
; `array_type`, `pointer_type`, or `tuple_type`; treesitter-csharp.mjs's
; `collectTypeReferences` walks each captured type node's shape (unwrapping
; nullable/array/pointer/tuple, flattening qualified names, and descending
; into generic type arguments) to emit one or more precise reference facts,
; skipping `predefined_type` entirely.

(base_list (_) @reference.type)

(property_declaration type: (_) @reference.type)

(field_declaration
  (variable_declaration type: (_) @reference.type))

(parameter type: (_) @reference.type)

(method_declaration type: (_) @reference.type)
