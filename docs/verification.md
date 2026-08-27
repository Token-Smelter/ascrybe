# Verification

**Opinion: the interesting failure is not a check that fails, it is a check that never ran.**
Most of this machinery exists to make silence impossible.

## The battery

`node scripts/test-fast.mjs` runs the unit tests. `npm run verify` runs the *registered* gate set
and is the only thing that notices a gate nobody registered.

That distinction is the whole point. `verification/checks.yaml` declares a discovery pattern —
`tools/*-exit-gate.mjs`, `scripts/check-*.mjs`, `analysis/**/VERIFY.mjs` — and every discovered
gate must be either registered or explicitly excluded with a reason. A gate that exists but is
listed nowhere runs nowhere, and no test can catch that, because there is no test.

When the registry and the discovered set disagree, the runner **short-circuits before executing
anything** and reports `REGRESSION` with zero checks executed. That is deliberate: a battery that
quietly skips a check is worse than one that refuses to start.

## Verdicts

| verdict | exit | meaning |
|---|---|---|
| `VERIFIED` | 0 | every required check ran and passed |
| `INCOMPLETE` | 2 | no regression, but some checks could not run |
| `REGRESSION` | 1 | a check failed, or the registry disagrees |

`INCOMPLETE` is a real answer, not a soft failure. On a hosted runner the Neo4j and expensive
gates cannot run, and a battery that reported `VERIFIED` anyway would be lying. CI accepts 2 and
fails on 1.

## What isolation cannot see

The runner records whether a verification ran alongside competing work, by sampling processes. That
is a bounded observation and the bound is disclosed rather than implied:

Processes that start and finish between samples can be missed. Worktrees added after the
receipt-bound inventory are outside that run's samples. Linux `/proc` may be absent or
access-restricted on other platforms; that limitation is recorded rather than converted into a
quiescence claim. Non-observation of a match is not host-quiescence evidence.

A falsifier asserts that this paragraph exists, because a caveat nobody writes down becomes a
guarantee nobody made.

## Falsifiers

`npm run verify:falsifiers` checks that the tests can still fail. A suite that cannot fail proves
nothing, and assertions rot into tautologies quietly — a test comparing a value to itself passes
forever and reports nothing.

## Design authority

`DESIGN-AUTHORITY-LEDGER.json` pins seventeen governed documents by content digest and the commit
that produced them. The gate verifies current bytes against those digests, so a document cannot be
edited without the edit being visible.

It earns its place. Two repository-wide renames in one session rewrote records: twelve archived
files under `analysis/` and `reviews/`, then a governed rollout plan at the root. Only the second
was caught, because the review package is explicitly outside the gate's scope — which is why there
is now also a test asserting directly that no governed document carries the new product name.

The ledger is also what lets records leave the working tree without being lost: each entry carries
`produced_at_commit_sha`, so the bytes stay retrievable and verifiable from history.

## Artifact hygiene

`check-artifact-hygiene --tracked` refuses tracked files over a size ceiling and generated payloads
committed outside ignored custody. Two blobs past GitHub's hard limit once made the published
history unpushable, which forced a rewrite, which forked the published line from the local one —
twice. Nothing detected it at commit time; it surfaced months later at publish.

## The pattern

Nearly every defect this repository has recorded has the same shape: **an absence that defaulted
instead of failing.**

- markdown was never scanned, because the extension table had no entry and no gate compared
  registered extractors against admitted files
- 23,206 documentary facts hung off a commit, because the table had no slot for a parent
- 320 assertions lost their document edge, because a missing document was skipped silently
- the model's reasoning level was whatever the vendor chose, because `null` means "unset"

The rule that follows: **where something must be declared, not declaring it is an error.** Not a
warning, not a default — a refusal to proceed.
