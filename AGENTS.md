# Operating rules — Ascrybe

## Never publish a mapped estate

**This repository is public. The estates it maps are not.** Nothing describing a mapped
repository belongs here — not in code, fixtures, documentation examples, analysis, screenshots,
commit messages, or pull request descriptions. A real module, plugin, route, or feature-directory
name is that estate's information, and naming one to explain a change publishes it as surely as
committing the file would.

Use invented names in every example. Before opening a pull request, grep the diff for the estates
you map. If a real name seems load-bearing to an explanation, rewrite the explanation.

See [docs/before-a-pr.md](docs/before-a-pr.md).

## Canonical repository and custody

The GitHub remote named `origin` is canonical. A local bare repository, where one exists, is a
cache used for worktree coordination; it is not a second publication line. Changes to `main` are
delivered through pull requests, never by rewriting or force-pushing a mirror.

**What a clone does not carry.** `.env`, `ascrybe.config.json`, and generated state are not in
Git. Initialize external custody with `npm run state:init`; it uses
`ASCRYBE_ARTIFACT_ROOT`, then `XDG_STATE_HOME/estate-map-runner`, then
`~/.local/state/estate-map-runner`, and creates checked compatibility links. Keep the env and
runtime-config examples current whenever a config key is added.

## Standing authorization: re-run without asking

**Granted by the operator, 2026-08-18, verbatim: "Please re-run liberally without human approval
going forward."**

Re-extraction, re-adjudication, re-projection, re-mapping, evaluation runs, and full pipeline
rebuilds are **pre-approved**. Do not stop to ask before spending on them. Report what a run cost
after the fact; do not seek permission before it.

Scope and guardrails, so the grant stays usable rather than becoming a blank cheque:

- **Pre-approved without limit:** any run whose model spend is projected under **$25**, and any run
  that is journal-replayed (near-zero live calls) regardless of size.
- **Pre-approved, report promptly:** projected spend **$25–150**. State the projection *before*
  launching and the actual *after*.
- **Ask first:** projected spend **above $150**, or any run that would destroy an artifact that
  cannot be regenerated deterministically.
- **Never silently:** anything that changes what a live service serves. Staging a new projection
  generation is free; **promoting it swaps the LAN dashboard's graph** — say so, or stage as
  `working` and leave `selected` alone.

Corollary the operator has stated repeatedly: **days elapsed is the metric, not dollars.** A run
that costs $6 and saves an afternoon is correct. Idling for approval is the expensive option.

## Where work runs

**Building the instrument is Brew work; running the study is session work.**

A Brew worktree is a clean checkout of *this* repository at a pinned SHA. It has **no gitignored
files** — no `ascrybe.config.json`, no `.env`, no Neo4j credentials — and **no checkout of the
estate being mapped**. Work that needs a live database, gitignored credentials, or a different
repository at a specific commit **cannot run there by construction**. Dispatching it anyway wastes a
worker and produces a failure that looks like the worker's fault. (Witness: `brew-ef1e4d5b`, where
the target commit belongs to a *mapped estate* and could never resolve inside an
*ascrybe* worktree.)

## Invariants that outrank convenience

- **Exactness beats completeness.** `git-tree-source.mjs` refuses non-regular blobs and verifies
  every blob OID and size against `ls-tree`. Do **not** relax this to make a commit buildable — if a
  tree cannot be materialized exactly, the honest move is to say so and change the question, not the
  guarantee. (Witness: `AGENTS.md` is a symlink at `0d02c452`, which blocks re-projecting that base.)
- **A wrong edge is worse than an absent one.** Resolvers refuse rather than guess; refusals carry a
  typed reason. The map's measured strength is that it produces zero wrong claims — protect it.
- **The source wins.** When a design doc, comment, test fixture, or prior review disagrees with live
  source, the source is authority and the disagreement is itself a finding.
- **Green is a checkpoint, not a terminus.** A clean fix in this system should be expected to
  *reveal* rather than *conclude*.

## Standing quick battery

```bash
node scripts/test-fast.mjs && npm run verify:falsifiers && node scripts/check-design-authority.mjs
```

`check-design-authority.mjs` reads **committed** state. Amending a governed document requires a
ledger rebind: commit the doc first, then update `produced_at_commit_sha`, `effective_receipt`, and
`production_history`, then `--refresh-derived-hashes`.
