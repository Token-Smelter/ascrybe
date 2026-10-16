# Verification

The public registry runs product checks against distributable source and invented fixtures; it does not certify private-corpus qualification.

## Registered checks

| Check | Contract |
| --- | --- |
| Build | Every tracked Node module parses |
| Lint | Tracked Node sources contain no trailing whitespace |
| Tests | Hermetic fast battery includes the tracked mini-corpus proofs |
| Identity candidate census | Candidates partition into counted dispositions without loss |
| Design authority | All published documentation matches its ledger and public provenance |
| Artifact hygiene | Oversized and generated tracked payloads are refused |

`verification/checks.yaml` is the registry. Its discovery rule finds published `tools/*-exit-gate.mjs` and `scripts/check-*.mjs` files; every discovered gate must be registered or explicitly excluded. Standard commands are mechanically bound to `.catalog/checks.yaml`.

```bash
npm run verify
npm run verify:falsifiers
```

The falsifiers exercise the registry runner with controlled failures. A command's admission is not proof that it passed; read its recorded outcome. Logs and generated verification state belong outside Git.

## Verdicts and isolation

| Verdict | Exit | Meaning |
| --- | --- | --- |
| `VERIFIED` | 0 | Every required check ran and passed |
| `INCOMPLETE` | 2 | No regression, but some checks could not run |
| `REGRESSION` | 1 | A check failed or the registry disagrees |

Processes that start and finish between samples can be missed. Worktrees added after the
receipt-bound inventory are outside that run's samples. Linux `/proc` may be absent or
access-restricted on other platforms; that limitation is recorded rather than converted into a
quiescence claim. Non-observation of a match is not host-quiescence evidence.

## Documentation authority

`DESIGN-AUTHORITY-LEDGER.json` binds `README.md`, `USAGE.md`, `CONTRIBUTING.md`, `AGENTS.md`, and every Markdown file under `docs/` to byte counts, SHA256 hashes, and the public commit that last changed each document. The snapshot bridge binds the ledger itself.

Commit changed documents first, run `npm run authority:bridge`, then commit the refreshed ledger and bridge. Uncommitted document changes, omitted documents, stale provenance, and changed snapshot bindings fail closed. Without Git, the checker explicitly reports snapshot-byte verification rather than historical verification.

## Evidence boundary

Private study inputs, frozen private-corpus counts, historical run gates, and private authority records are not shipped. Their absence is not a public gate pass. Public fixtures test mechanisms and adversarial cases; separate private studies are needed to establish behavior and scale on private estates. No registry command starts a database service or purchases inference.
