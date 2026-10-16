# Contributing to Ascrybe

Changes to Ascrybe must preserve source custody, typed refusals, and the separation between observations and documentary claims. For mapping an estate, read [USAGE.md](USAGE.md) instead.

## Privacy

This repository is public; mapped estates may not be. Use invented fixtures and reserved example domains. Do not publish estate names, module paths, infrastructure identifiers, screenshots, measurements, or derived artifacts. Sweep the whole candidate tree before release; see [docs/before-a-pr.md](docs/before-a-pr.md).

## Invariants

- Materialize exactly the pinned Git tree, including pinned submodules, or report a typed absence. Do not silently substitute working-tree bytes.
- Prefer a witnessed refusal to a guessed edge. Missing evidence is not proof of absence.
- Source is authority; disagreement with a document is itself a finding.
- Test estates with different repository counts, languages, frameworks, and identifier widths. Estate-specific aliases and model paths belong in optional runtime configuration, never baked into extraction code.
- Keep generated output and local credentials in external custody. `ascrybe state init` initializes it; runtime examples must stay portable.

## Verification

```bash
npm run setup
node scripts/test-fast.mjs
npm run verify
npm run verify:falsifiers
node scripts/check-artifact-hygiene.mjs --tracked
node scripts/check-design-authority.mjs
ascrybe skill bundle
ascrybe skill verify
```

The fast suite is hermetic: no secret, database, or paid model call. Other execution, spend, graph mutation, and promotion require the operator's authorization. Passing fixture checks does not establish qualification on a private corpus.

## Documentation authority

The public ledger governs the root contributor and usage documents plus every Markdown file under `docs/`. To amend one, commit the document first, then run `npm run authority:bridge` and commit the refreshed ledger and snapshot bridge. The gate verifies coverage, bytes, and public Git provenance. Exported trees disclose that only snapshot bytes can be checked without Git history. It makes no assertion about records outside this distribution.

## Delivery

Changes to `main` go through pull requests on the canonical `origin`; never rewrite its history. Keep commits focused, use imperative subjects, and never include private estate details in commit messages or review descriptions.
