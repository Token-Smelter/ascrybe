# Before a pull request

**Opinion: the test that proves your fix must be one the bug could not have passed.** Everything
below follows from that, and every rule here was bought by shipping — or nearly shipping — a
breakage this repository actually produced.

## Two hard rules

### 1. Nothing about a mapped estate goes in this repository

Ascrybe maps private repositories. **Their contents are not ours to publish**, and they leak in
ways that do not look like leaks:

- **Examples and documentation.** A path like `design/features/<real-feature>/DESIGN.md` names a
  private feature. Use invented names. This document's own first draft used a real plugin name in
  an example of identifier grounding.
- **Test fixtures.** A fixture built from a real estate carries its module names, routes and
  capabilities.
- **Analysis and evidence.** Anything derived from a mapped estate describes it. A tracked
  analysis document once linked a live S3 bucket serving rendered maps of a private codebase.
- **Screenshots and rendered artifacts.** A dashboard screenshot shows real node labels.
- **Commit messages and PR descriptions.** Naming a private module to explain a fix publishes it
  just as surely as committing the file.

**Estate names are the easy half.** A scan for the estates you map by name will miss the class
that matters more: infrastructure. Corporate model gateways sat in this repository as exported
constants for weeks, through several reviews, because every scan looked for a company name and
none looked for a hostname. Sweep for all of it:

- **gateway and host identifiers** — model routes, internal DNS, anything shaped `host/model`
- **cloud identifiers** — bucket names, ARNs, twelve-digit account numbers, region-qualified URLs
- **addresses** — emails, non-loopback IPs, ports that mean something on your network
- **machine paths** — `/home/<you>/`, `/Users/<you>/`
- **estate names** and their distinctive module, plugin, capability and route names

If a real name is load-bearing to an explanation, the explanation needs rewriting, not the name
redacting. And when you replace one, replace it with something reserved: a blanket rename here
turned a real domain into an invented one that may belong to somebody, which is a different
mistake rather than a fix. Use `example.com`, `example.invalid`, `example.test`.

### 2. Records are not edited

Documents governed by `DESIGN-AUTHORITY-LEDGER.json`, and everything under `analysis/` and
`reviews/`, are what somebody wrote at a time. A repository-wide rename is not a reason to restate
them. Two renames in one session rewrote twelve archived files and one governed rollout plan;
only the second was caught by a gate, because the review package sits outside that gate's scope.

## Verifying a fix

**Find a number the bug could not have produced.** This is the whole discipline.

A containment fix reported **zero refusals** and was wrong: it had minted a parallel set of
documents at the wrong addresses, and every section attached to the orphans. Zero refusals was
producible *by the defect*. The number that would have caught it immediately was the document
count — 2,308 for 1,154 files.

So, in order:

1. **State what the number would be if the fix worked, before running it.** Then run it. A metric
   you interpret afterwards will accommodate whatever it finds.
2. **Prefer a conservation identity to a success count.** `admitted + refused == proposed` cannot
   be satisfied by a bug that loses rows; `refused == 0` can.
3. **Run it against real data, not only a fixture.** Extractors were once verified by calling them
   directly while the pipeline that feeds them admitted no markdown at all. Every number was real
   and none of it ran.

## Verifying the test

**A test that cannot fail proves nothing.** Before opening a PR, break the fix and watch the test
go red. If it stays green, the test is a tautology — one written in this repository asserted
against a locally constructed array rather than the code under test, and would have passed whether
or not the fix worked.

`npm run verify:falsifiers` exists for this class and should be run, not assumed.

## The checklist

```bash
node scripts/test-fast.mjs                        # behaviour
npm run verify                                    # the registered gate set ran
npm run verify:falsifiers                         # the tests can still fail
node scripts/check-artifact-hygiene.mjs --tracked  # nothing oversized or generated
node scripts/check-design-authority.mjs            # no record was rewritten
ascrybe skill bundle && ascrybe skill verify       # the bundle matches the surface
git diff --stat -- analysis reviews                 # must be empty
```

Then, by hand, because no gate can check them:

- **Did I state the expected number before measuring it?**
- **Could the bug have produced the number I am treating as proof?**
- **Does the diff, including the commit message, name anything from a mapped estate?**
- **If a config field a vendor can reinterpret is touched, is it pinned rather than left unset?**

That last one is not hypothetical: `thinking: null` meant the flag was never passed, so a
provider's default decided, and when that default moved it multiplied a corpus run's cost by five
with nothing in the repository able to notice.
