---
api_version: example.project/v2
kind: project
id: ascrybe
name: Ascrybe
summary: Source-grounded estate mapping with deterministic extraction and explicit documentary claims.
protected_refs:
  - main
grounding:
  - description: Product overview
    path: README.md
  - description: Usage and operating boundaries
    path: USAGE.md
  - description: Contributor verification
    path: CONTRIBUTING.md
entrypoints:
  repo_root: "."
  test: "node scripts/test-fast.mjs"
---

# Product catalog

Ascrybe keeps source observations separate from documentary claims. Source corpora are read-only; generated state and private study records belong outside the checkout. Machine-local orchestration registration is not part of this catalog.
