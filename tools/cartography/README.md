# Cartography view compiler

Cartography deterministically compiles a witnessed estate graph into a bounded view model and HTML; it does not establish new source facts.

## Contracts

| Concern | Rule |
| --- | --- |
| Provenance | Runtime, verification, declared, and all-evidence lenses stay distinct; missing provenance is `unknown`, not production |
| Event identity | Named envelope kinds connect emitters and consumers through witnessed incidence |
| Bundle identity | Logical bundle identity excludes member edges; a separate digest identifies the member set |
| Evidence | Preserve witness, receipt, annotation, and refusal channels; preview budgets report included and omitted counts |
| Dispositions | Every applicable subject has an explicit assignment, ambiguity, absence, or ineligibility disposition |
| Addresses | Keep raw record identity, logical view identity, and build-pinned addresses separate |

A cross-source disagreement requires two available sources. Missing inputs must produce an explicit absence rather than fabricated conflicts or a successful empty map. Test evidence is positively classified verification evidence, not uncertainty.

## Output custody

Compiled HTML, screenshots, and evaluation reports are generated artifacts. Keep them in external custody, never in the public source tree when they describe a private estate. A text scan cannot clear screenshot content.

Generate a graph and its view model from one pinned snapshot. Reports and rendered views must carry that same build identity; a mismatched build is refused rather than presented as a reproducible visualization. Read each command's help for its current arguments.
