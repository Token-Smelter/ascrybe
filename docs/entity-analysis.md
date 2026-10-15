# Estate-specific entity analysis

Entity analysis reads optional estate declarations from `entity_analysis` in the existing runtime configuration; no estate-specific vocabulary is built into the product.

```json
{
  "entity_analysis": {
    "model_path": "parcel/model.ts",
    "model_entity_export": "ENTITY_KINDS",
    "model_edge_export": "EDGE_KINDS",
    "read_model_prefixes": ["parcel_view_"],
    "id_aliases": {"pkg": "package"},
    "abbreviations": {"pkg": "package"},
    "expected_findings": [
      {"entity": "package", "expected": "discovered_undocumented"}
    ]
  }
}
```

This invented fragment belongs inside a complete runtime config, not in the public repository as a real estate declaration. Select that file with `ASCRYBE_CONFIG`; the entity-analysis tools also accept `--runtime-config`. Without either selection they check the current directory's `ascrybe.config.json`.

| Declaration | Meaning |
| --- | --- |
| `model_path` | Optional estate-relative corroborating model, without parent traversal |
| Model export names | Declared arrays read as text, never executed |
| `read_model_prefixes` | Literal identifier prefixes identifying read models rather than entities |
| `id_aliases` | Identity-column aliases; targets must already be promoted |
| `abbreviations` | Discovery aliases; merging still requires shared source witnesses |
| `expected_findings` | Explicit comparison expectations, not evidence that a finding exists |
| `subject_exclusions` | Optional component-scoped exclusions with one `path`, `path_prefix`, `basename`, or `basename_prefix` selector and a reason |
| `legacy_exclusion_aliases` | Explicit old-to-current reason labels for read-time migration; private labels stay in private configuration |

Unknown fields, malformed aliases, invalid export names, and invalid expectations are refused with `ENTITY_ANALYSIS_CONFIG_INVALID`. An absent configuration records counted `entity_analysis_unconfigured` skips for estate-specific enrichment. An omitted model path records `shipped_model_unconfigured`; a configured but missing model records `shipped_model_absent`. Generic source-derived discovery continues, and these dispositions keep missing configuration distinguishable from an empty measurement.

Domain prepass now emits `estate-map/domain-prepass-receipt/v2` with rule version `3` and the generic `read_model` exclusion label. Readers still accept v1 receipts. Configured `legacy_exclusion_aliases` normalize old reason labels in memory; historical files are never rewritten. Without a declared subject-exclusion configuration, the census records a counted `entity_analysis_unconfigured` skip rather than claiming to have applied estate-specific policy.

The code-fact adapter separately requires an explicit source pin; an undeclared pin fails with `SOURCE_PIN_REQUIRED`. The graph-store builder accepts explicitly supplied records and producer dependencies, not an implicit historical corpus.
