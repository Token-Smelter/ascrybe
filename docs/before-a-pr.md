# Before a pull request

A change is ready only when its checks pass, its claims match measured evidence, and its entire public tree reveals nothing about private mapped estates.

## Privacy sweep

Use invented names in code, fixtures, examples, comments, screenshots, commit messages, and review descriptions. A private module path or a measured estate census is confidential even without the estate's name.

Sweep the whole tree, not just the diff, for:

- Estate names and distinctive module, plugin, capability, feature, and route names.
- Hostnames, model gateways, internal DNS, and infrastructure-specific ports.
- Cloud bucket names, ARNs, account identifiers, and region-qualified service URLs.
- Emails, non-loopback IPs, concrete home-directory paths, private repository names, and credentials.
- Derived measurements, source pins, screenshots, and historical run records.

Use reserved `example.com`, `.invalid`, or `.test` domains. An invented but registrable domain may identify someone else. Inspect binary assets visually; a text scan cannot clear a screenshot. Keep detailed scan findings and private records in external state, not in this repository.

## Portability

The shape of one estate is not the shape of every estate. Test different repository counts, languages, frameworks, and identifier widths. Configuration may declare an estate-specific vocabulary; code must not assume it. An unconfigured feature must report a counted, typed refusal or skip, not an empty result presented as a measured fact.

## Evidence

State the expected outcome before running a check. Prefer conservation identities such as `admitted + refused == proposed` over success counts. Break the fix and verify that its regression test fails. Never treat an unrun check, an unavailable corpus, or a missing service as a pass.

## Records and public documentation

Private studies, analysis, and reviews remain in external custody and are not rewritten to fit a product rename. The public documentation ledger has a separate, explicit scope. Commit changed public documents before rebinding their hashes with `npm run authority:bridge`; the gate checks coverage, bytes, and available public Git provenance.

## Checklist

```bash
node scripts/test-fast.mjs
npm run verify
npm run verify:falsifiers
node scripts/check-artifact-hygiene.mjs --tracked
node scripts/check-design-authority.mjs
ascrybe skill bundle
ascrybe skill verify
```

Before publishing, inspect the candidate tree and commit messages, confirm that no private history is included, and obtain the required operator review. Passing automated checks does not replace that review.
