# Releasing

**Opinion: a release of Ascrybe is a promise about four surfaces, and the release process exists
to prove each one still holds.** Passing tests is necessary and nowhere near sufficient, because
the things that break for a consumer of this project are mostly not testable by running the tests.

## What a release can break

| surface | who holds it | what breaks |
|---|---|---|
| **query surface contract** | agents and skills, via a declared `surface_contract` | a bumped digest silently disagreeing with an installed skill |
| **skill bundle** | anyone who installed `dist/ascrybe-skill/` | instructions describing a graph that no longer exists |
| **artifact schema identifiers** | files already on disk in someone's custody | a claim map or code graph that no longer validates |
| **projection identity** | a served graph someone promoted | a `projection_id` no checkout can reproduce |

The fourth is the least obvious and bit us. `counts.containment` sits inside the digested
projection body, so changing how that report is *counted* changed the `projection_id`. A
generation staged before the change was no longer what the current commit produced, and promoting
it would have left a served graph nobody could rebuild.

## Versioning rules

**The query surface contract is the only public version, and it moves on any change to commands,
arguments, or the data model.** Adding an argument moves it. Adding a node kind moves it. Nothing
else in the repository carries a consumer-facing version, and nothing else should start.

**Schema identifiers are not versioned by releases.** The ~380 `estate-map/...` strings are
interfaces to artifacts on disk, and most of them are records — preregistrations and blind-screen
grades from a campaign that committed to a method before seeing results. A release must not rename
them; a genuine schema change is a new `/v2` alongside the old, never a rewrite.

**Records are never edited by a release.** Documents governed by `DESIGN-AUTHORITY-LEDGER.json`,
and anything under `analysis/` or `reviews/`, are what somebody wrote at a time. Two repository-wide
renames in one session rewrote twelve archived files and one governed rollout plan. Only the second
was caught by a gate, because the review package is explicitly outside that gate's scope.

## Gates, and what each actually proves

| gate | proves |
|---|---|
| `node scripts/test-fast.mjs` | behaviour, at the unit level |
| `npm run verify` | the **registered** gate set ran — a discovered-but-unregistered gate fails this |
| `npm run verify:falsifiers` | the tests can still fail; a battery that cannot fail proves nothing |
| `check-artifact-hygiene --tracked` | no oversized or generated payload entered history |
| `check-design-authority` | governed documents are byte-for-byte what the ledger says |
| `ascrybe skill verify` | the shipped bundle describes the surface it is talking to |

`npm run verify` is the one that catches the class of bug the others cannot: a new gate added and
never registered runs nowhere. It short-circuits before executing anything if the registry and the
discovered gate set disagree — deliberately, because a battery that quietly skips a check is worse
than one that refuses to start.

**CI currently runs a subset.** `.github/workflows/verify.yml` omits `npm run verify` and
`skill:verify`. Both belong there before the repository is public.

## The checklist

1. **Battery and gates green**, including the two CI omits.
2. **Contract digest matches the skill.** `ascrybe skill bundle && ascrybe skill verify`. If the
   contract moved, `SKILL.md` must declare the new version in the same commit.
3. **No record rewritten.** `git diff --stat` against `analysis/`, `reviews/`, and every
   `document_id` in the ledger must be empty.
4. **No credential and no machine path in the bundle.** The build enforces both; confirm rather
   than assume, since the path check only covered `SKILL.md` until a consumer's own grep found a
   home directory in a bundled comment.
5. **Config defaults that reach a paid provider are pinned.** `thinking: null` is not a setting —
   it means the flag is never passed and the provider's default decides. The same null config cost
   $0.0124/window one week and $0.0657 the next. Any field a release ships that a vendor can
   reinterpret is part of the release surface.
6. **Reproducibility.** Rebuilding from the tagged commit must produce the same `projection_id` a
   promoted graph carries. If digest-bearing code moved, restage before promoting.
7. **Tag and release notes** naming: the contract version, whether it moved, and whether any
   artifact schema changed such that existing custody must be regenerated.

## What we deliberately do not do

**No npm publish.** `package.json` is `private: true` with no version and no `files` field.
Consumers install from a clone. Publishing would require deciding what ships, and the honest
current answer is that the skill bundle is the distributable and the repository is the source.

**No semantic version on the repository.** There is no API surface for semver to describe. The
contract version is the thing consumers pin, and it says what it means.

**No release from a dirty projection.** Generated state is never in a release. A projection is
custody, described by a manifest carrying its path, size, and digest — never a committed payload.
