# Using Ascrybe

Map a repository into a queryable graph, then read it. Everything below is a verb of the
`ascrybe` command; nothing here requires changing Ascrybe itself.

> Changing Ascrybe rather than using it? [CONTRIBUTING.md](CONTRIBUTING.md).

## Once per machine

```bash
npm install                      # dependencies, including the tree-sitter grammars
cp ascrybe.env.example .env      # credentials and ports; never committed
cp ascrybe.config.example.json ascrybe.config.json
docker compose --env-file .env up -d neo4j
ascrybe state init               # the external artifact root, outside the checkout
```

`.env` and `ascrybe.config.json` stay machine-local by design. The config *names* the environment
variables holding credentials rather than containing them, so it is safe to read and share.

`ascrybe.env.example` carries the arithmetic behind every tuning bound — how `window_bytes` trades
against the claim cap, what concurrency actually costs you, why the shipped event cap sits above
V8's string ceiling on purpose. Read it before a corpus run, not after.

## Importing ontology sources

**Ontology inventory reads pinned Git sources, including locally resolvable submodules. For an
ordinary folder, first import a screened snapshot into private state; the folder is never modified.**

```bash
ascrybe snapshot --root "$FOLDER" --id notebook --authorize-root "$FOLDER" > "$PRIVATE/snapshot.json"
```

Authorization must name the exact physical source root. Git worktrees are refused: use their normal
Git source descriptor instead, or explicitly pass `--force-git`. Snapshot custody defaults to
`$ASCRYBE_ARTIFACT_ROOT/snapshots/<id>.git`, with the same XDG/home fallback as `ascrybe state`;
`--state-root` overrides the private root. An ID cannot be rebound to a different folder. A lock
refuses concurrent imports; remove a stale lock only after verifying its importer has stopped.

Copy the result's `source` object into the `sources` array of an
`estate-map/ontology-estate-manifest/v1` manifest. Preserve `source_kind: snapshot_import` and
`snapshot`: these pins represent imported content, **not authored Git history**. Snapshots use a
fixed importer identity/date, parent the previous import, and reuse the current pin when the tree
is identical. Earlier commits remain readable. A second content scan after commit construction
refuses a changing source before advancing the snapshot ref. This is an optimistic consistency
check, not an operating-system filesystem snapshot; quiesce actively written folders first.

| Intake item | Disposition |
|---|---|
| Supported regular text | Screened before any blob is stored; imported with executable mode |
| Credential names, dependency/build paths, generated locks, private `info/exclude` rules | Excluded or withheld before object writes |
| Credential/payment/identifier-shaped content | Withheld by the existing ontology screen (not a guarantee of secret detection) |
| Symlinks, special files, oversized/unsupported/binary files | Explicitly not read or withheld |
| Empty directories | Explicitly not representable in Git |
| Declared, locally resolvable gitlink | Child source at its own pin, with parent source/path/gitlink-pin links |
| Unavailable/undeclared/cyclic/depth-limited gitlink | Explicit `not_read` reason; no fetch or submodule update |

```bash
ascrybe ontology inventory --manifest "$PRIVATE/manifest.json" --output-dir "$PRIVATE/inventory"
ascrybe ontology estate --manifest "$PRIVATE/manifest.json" --inventory-dir "$PRIVATE/inventory" --output-dir "$PRIVATE/discovery" --runtime-config "$PRIVATE/runtime.json" --plan
```

Inventory writes an expanded `manifest.json` beside its units. Use that manifest for subsequent
source-qualified handoff or locator reads: each child's `root` and `ref`, not the parent's root or
the child's live HEAD. Optional manifest `source_repositories` maps submodule names to local
repositories using the shared resolver. Explicit and discovered copies of the same repository/pin
are inventoried once; conflicting scope policies refuse rather than broadening access. Equal paths
in different repositories remain different units. Old manifests without these fields still load.

Keep discovery's journal when updating snapshots: unchanged file-local map batches reuse semantic
answers and reseal their quotes at the new pin. Changed/deleted evidence is absent from the new
generation; saved old generations remain historical. Grounding and later stages still use their
normal exact-request journals. This does **not** implement hierarchical per-repository/cross-repository
incremental discovery, native non-Git readers, or graph promotion. `--plan` spends nothing; removing
it can make model calls.

## Mapping an estate

Five stages. Only the fourth costs money.

```bash
ascrybe extract  <estate-root> --out <dir>          # read the estate into facts
ascrybe merge    <extract-dir> --out <dir>          # reconcile facts into one code graph
ascrybe remap    --work <dir> --sha <commit> --out <dir>   # resolve the code plane and its referents
ascrybe claims   ...                                # the paid documentary read
ascrybe project  --claim-map-shards <dir> --code-graph <adjacency.json> --promote
```

`remap` looks for `<work>/extract` and `<work>/merge` by those exact names, so give the two earlier
stages `--out` paths under one work root. Both take `--out`; a second positional argument is
ignored, and the output goes somewhere you did not ask for.

`extract` reuses per-file/per-extractor work across runs when you give it a cache:

```bash
ascrybe extract <estate-root> --out <dir> --cache-root <cache-dir>            # reuse per unit
ascrybe extract <estate-root> --out <dir> --cache-root <cache-dir> --cache-mode full  # force full recompute
```

Omit `--cache-root` and every run recomputes every unit, exactly as before this flag existed —
facts and `_MANIFEST.json` are byte-identical whether or not a cache was used; only the separate
`_CACHE_TELEMETRY.json` receipt differs. `--cache-mode full` forcibly disables reuse (no read, no
write) even when `--cache-root` is given — the forced-uncached reference mode.

The first three are deterministic and free. `claims` is the only stage that calls a model, and it
is priced per window of document text — measure on a slice before committing to a corpus.

`project` stages an immutable generation and, with `--promote`, advances the `selected` head that
readers see. **Promotion changes what the dashboard serves; say so out loud before doing it.**

Everything a stage refuses is counted and named. A missing claim is always attributable to a
window, a refusal, or a documented cap — never to silence.

## Mapping a multi-repository estate

An estate is not always one repository. `extract` already reads a whole estate: every immediate
child directory of the estate root becomes a component, and `merge` reconciles across all of them.
What a multi-repository estate needs on top of that is **membership** and **identity**.

Declare membership once, in the runtime config:

```json
"projection": { "batch_size": 500, "default_view": "selected", "estate": "example-estate" },
"source_repositories": {
  "billing-ledger":  "/srv/estates/example-estate/billing-ledger",
  "orders-api":      "/srv/estates/example-estate/orders-api",
  "web-storefront":  "/srv/estates/example-estate/web-storefront"
}
```

- `source_repositories` names the estate's members and where each repository lives. It is one
  declaration with two readers: `materialize` builds the estate from it, and the query surface
  later resolves a fact's bytes through it for `read-span`. A repository absent here is a
  repository whose source nobody can show you.
- `projection.estate` scopes this estate's projection heads. One Neo4j serves every estate, and
  without an estate id two estates fight over the same `selected` head. Omit it only on a machine
  that will map exactly one estate, ever.

Then run the free half. Only the first command is new:

```bash
ascrybe materialize --estate <work>/estate --pins <work>/estate-pins.json
ascrybe extract     <work>/estate --out <work>/extract
ascrybe merge       <work>/extract --out <work>/merge
ascrybe remap       --work <work> --source-pins <work>/estate-pins.json --out <work>/map
```

`materialize` writes one **exact Git tree per repository** at that repository's current head —
committed bytes only, never the working tree — and records the `{repository: sha}` pin map it
built the estate from.

The estate root must be **absent or empty**. Materializing into a populated one is refused
outright, because the pin map would then name only what this run rebuilt while `extract` went on
to map every directory it found — and the digest that *is* the estate's identity would describe
less than what was mapped.

**A multi-repository estate has no single commit, so `remap` takes `--source-pins` instead of
`--sha`.** The ordered pin map's digest *is* the estate's source identity: it is what `project`
checks the claim and code artifacts against, and it is how `read-span` knows which commit each
repository's bytes must come from. Both directions are refused — `--sha` alongside `--source-pins`,
and a bare `--sha` against a work directory whose extract manifest names more than one repository.
Either would leave a head stamped in provenance that disagreed with the pins actually used, with
nothing able to notice.

Keep the pin map. It is the only record of what the estate was when it was mapped, and it is
checked against itself on every read, so an edited commit is refused rather than believed.

### The paid stage does not take a multi-repository estate yet

`ascrybe claims` requires a single 40-hex commit and materializes exactly one repository at it. A
pin digest is 64 hex, so the paid documentary read **structurally cannot** serve an estate of many
repositories. This is a real limit, not an omission from this page.

What does work is the code plane, projected as a **code-plane-only estate** — an empty claim map
that declares the absence rather than inventing placeholder claims:

```bash
node tools/claim-map-stub.mjs <work>/map/adjacency.json <estate-id> <work>/claim-map.json
ascrybe project --claim-map-shards <work>/claim-map.json --code-graph <work>/map/adjacency.json
```

That stub is the one step of a multi-repository run still spelled `node tools/…` rather than as a
verb, and it is the obvious next one to promote.

### A repository containing a submodule

A gitlink is a pinned reference to another repository, not a reason to refuse the tree that
carries it. `materialize` (and `ascrybe update`'s inventory) resolves it, in order:

1. an explicitly declared member of `source_repositories` (the caller's own runtime config);
2. the parent's `.git/modules/<name>` (the standard location `git submodule init`/`update` leaves
   a submodule's own admin directory, keyed by its `.gitmodules` name);
3. the checked-out submodule directory's own `.git`.

If the pinned commit is actually present wherever this resolves to, the submodule's tree
materializes exactly, recursively, at its own path, with its own pin — folded into the estate's
source identity. Nested submodules recurse the same way, bounded by depth; a declared name repeated
deeper in its own chain refuses that gitlink as a cycle rather than recursing forever.

A submodule that does not resolve anywhere, or whose pinned commit is not present once resolved, is
named and counted instead — never silently included, never guessed, never read from a live
checkout:

```
SUBMODULE_UNAVAILABLE vendor/sdk
```

An **undeclared** gitlink (a mode-160000 tree entry with no `.gitmodules` entry naming it — an
accidentally committed worktree directory, say) is named separately:

```
GITLINK_UNREGISTERED vendor/orphan
```

Either way, the exclusion is per gitlink, not per repository: everything else in that repository,
and the rest of the estate, still materializes. One unavailable gitlink must not discard the
surrounding repository.

What to do about a genuinely unavailable submodule, in order of honesty:

1. **Accept the absence** and say so when reporting the map. A named gap is a finding.
2. **Declare the submodule's own repository as a separate member** of `source_repositories` if you
   have it locally — that is also the fastest resolution path, checked first.
3. Do not relax the exclusion to make the tree buildable from bytes you do not actually have. A
   pin that cannot be resolved exactly is a reason to say so, never to guess.

### `ascrybe update`: a gitlink or symlink is counted and named, never silently dropped

`ascrybe update`'s file-scope inventory never turns a symlink or a gitlink (a submodule entry) into
a unit — doing so would misrepresent it. Unlike `materialize`'s whole-repository refusal above, this
is a per-entry, non-fatal accounting: the rest of the repository still becomes units normally, and
every non-regular entry is named in `non-regular-entries.json` (`repository`, `path`, `mode`,
`target`) — the target commit for a gitlink, the link text for a symlink. The file is written only
when at least one such entry exists. An absence here would contradict the map's own rule that an
absence must be counted and named, never silent.

### Memory: one very large repository can kill the run

Materializing a repository reads every one of its blobs into memory before it writes any of them,
so memory use scales with the repository's whole checked-in size, not with its largest file.
A repository larger than the available heap cannot be materialized in one process.

`ascrybe materialize` therefore ships `--max-old-space-size=16384`, the same heap `ascrybe project`
carries for the same class of reason. If a repository still exhausts that, it is too large to
materialize whole: map it as its own estate, or exclude it and say which member is missing.

The per-repository `MATERIALIZED` lines are the progress signal — a run that stops printing them
has stopped, whatever the process is still doing.

## Reading it

```bash
ascrybe query overview                        # the estate, ranked by structure
ascrybe query node --id doc:design/X.md       # a document, its sections, its claims
ascrybe query provenance --id <claim>         # what justifies this, and how
ascrybe cypher --query '...'                  # bounded, read-only, projection-scoped
ascrybe dashboard                             # the graph, in a browser
```

Both read paths are scoped to one projection and cannot write. See
[docs/query-surface.md](docs/query-surface.md) for the contract, which is versioned and
digest-checked so a client can tell when documentation has drifted from the build.

## Giving the graph to an agent

```bash
ascrybe skill bundle                      # build a self-contained, read-only copy
ascrybe skill install --into <project>    # build it and put it where that project reads skills
ascrybe skill verify <installed-path>     # does an installed copy still match this build?
```

The bundle carries the two read CLIs and their instructions, and deliberately carries neither the
projection, the credentials, nor the runtime config.

`install` refuses more than it does, because hand-copying is what leaves a stale skill behind. It
will not invent a skills directory in a project that has no convention for one — though
`--skills-dir` is obeyed wherever it points, inside the project or not, provided it already exists.
It will not delete a directory it cannot identify as a previous install of this skill,
and will not report success until each installed entry point loads from its new home and refuses an
empty config. It writes `INSTALL.json` recording which Ascrybe commit produced the copy — the
contract digest can say a bundle describes a different surface, but not which build it came from.

## Planning a delta update (file-scope only)

```bash
ascrybe update --pin-manifest <pins.json> --mode delta --output <build-dir>
```

`update` plans a per-file, per-extractor delta build against a real Git-backed repository read
through Git plumbing (never the working tree), reuses only the units an unchanged blob still
routes to, and runs the full-vs-delta equivalence oracle by default (`--equivalence required`). It
applies `.estate-mapignore` (read from the repository's own tree at the given ref, per declared
repository) and, by default, the same `catalog_globs` your `ascrybe.config.json` declares (`update`
auto-resolves `--runtime-config` exactly like every other estate-facing verb; no config file there
is not an error) — the same scope selection the ordinary `extract`/`claims` path applies, so the two
paths route the exact same units for the exact same input and config. `--catalog-globs
<path-to-json-array>` overrides the runtime config with a standalone array when you want one.
It never promotes: `--promote` is always a typed refusal, and nothing it does can change what a
selected/working generation serves. `--mode full` disables reuse; `--mode shadow` seals a delta
candidate for comparison without publishing it. Add `--cache-root <dir>` to reuse/publish per-unit
work across invocations — the same cache shape `ascrybe extract --cache-root` uses
(`tools/file-extraction-adapter.mjs` builds both registries). Refs are resolved once per
invocation and shared by the primary and equivalence-oracle arms. See
[docs/delta-file-scope-implementation-status.md](docs/delta-file-scope-implementation-status.md)
for exactly what this verb implements versus refuses (repository-scope units, global-scope units,
migrations, and rename continuity remain out of scope).

## Reusing paid documentary answers across a commit range

```bash
ascrybe claims ... --reuse-journal base=<retained/extraction-calls.jsonl> --offline
```

`claims` (`tools/semantic-map-run.mjs`) can seed its own run journal from one or more retained,
read-only journals before it extracts anything. A window's paid-answer identity is its exact
rendered prompt (path, author outline, numbered window bytes — it never renders a source pin), so a
document window that is byte-identical to one already answered at a prior commit is served from
that retained answer and never re-dispatched; a changed or new window is not in any journal and
falls through to a live call. `--reuse-journal` is repeatable and takes `label=path` or
`label=path@model`; earlier labels win ties, and a `@model` suffix restricts that journal to entries
recorded as answered by exactly that model (an entry with no recorded model, or a different one, is
refused rather than assumed to match). Add `--offline` to refuse every window with no match anywhere
(`pre_dispatch_refused:offline_no_new_dispatch`) instead of dispatching — a zero-spend way to see
exactly which windows a real run would need to pay for before running it. The receipt's
`documentary_reuse` field names every journal reused from and how many windows each contributed;
`extraction.conservation.model_coverage` names, on every run, how many windows were answered by the
expected model versus some other or unrecorded one. Add `--require-model` to turn any non-expected-
model answer into a typed `SEMANTIC_EXTRACTION_MODEL_COVERAGE` refusal instead of a silently-mixed
map — the guarantee a "pure single-model" build needs, since a reused answer can otherwise come from
any model a prior run happened to use.
See [docs/delta-documentary-update-status.md](docs/delta-documentary-update-status.md).

## Comparing a projection offline

```bash
ascrybe offline-project --claim-map <claim-evidence-map.json> --code-graph <adjacency.json> --output <dir>
```

`buildUnifiedEstateProjection()` is a pure function of a claim-evidence map and an optional code
graph — no database connection, no staging, no promotion. This CLI drives it from two files on disk
and writes `projection-nodes.jsonl`, `projection-edges.jsonl`, and a receipt naming the projection's
`content_digest`. Two projections — say, one built from a full rebuild's claim map and one built
from a delta candidate's — are equivalent exactly when their `content_digest`s match; nothing here
can change what `ascrybe project --promote` would later serve.

## The supported update procedure, as one command

```bash
# Full software graph (default): documentary claims AND a derived structural code graph.
ascrybe refresh --repository <path> --config <project-config.json> --runtime-config <path> \
  --reuse-journal prior=<retained/extraction-calls.jsonl>@<model> \
  --output-dir <dir> [--stage-runtime-config <path-pointing-at-a-test-estate>]

# Documentary claims only, explicitly -- never the silent default.
ascrybe refresh --repository <path> --config <project-config.json> --runtime-config <path> \
  --reuse-journal prior=<retained/extraction-calls.jsonl>@<model> --documentary-only \
  --output-dir <dir>
```

The supported way to bring an estate's graph forward to a new commit, as one command instead of a
hand-assembled pipeline: full deterministic code re-extraction, documentary-answer reuse from the
named prior journal(s) (paying only for windows that changed), `--require-model` coverage (always
on — this verb's whole point is a map that is provably pure in exactly one model), deterministic
binding, **a derived structural code graph** (`scripts/remap.mjs`'s own code-plane pipeline, run over
the SAME extract+merge output the claims pass just produced — real Module/Route/etc. entities and
traversable relations, not merely a non-null placeholder), and projection. `--stage-runtime-config`
optionally stages (never promotes) the result to the estate a SEPARATE runtime config names — point
it at an isolated test estate's config to try a candidate without touching any real estate's
`selected`/`working` heads; promotion stays a separate, deliberate, later action
(`ascrybe project --promote`) outside this verb's scope.

**The code graph is on by default, off only by explicit request.** A run that skips it
(`--documentary-only`) is a legitimate, named mode — a claims-only map is sometimes exactly what is
wanted — but the receipt's `mode` field (`full_software_graph` or `documentary_only`) says which one
ran, and `code_graph.present`/`code_graph.digest` say whether a structural layer actually exists in
the projection this run wrote. A `full_software_graph` run can never end with a null code graph by
accident: `--documentary-only` and an explicit `--code-graph` (to reuse one a prior run already
derived, when the code plane provably has not changed) are mutually exclusive — combining them is
refused (`REFRESH_INPUT_INVALID`) rather than silently picking one.

`refresh-receipt.json` in `--output-dir` is the one receipt naming what was reused versus paid:
`windows.total/answered_by_reuse/answered_by_new_dispatch/offline_refusals`, `model_coverage`, and
`cost_usd.marginal_this_run` versus `cost_usd.reused_already_paid` (the same total/marginal/reused
split `claims` itself reports — see above — so a delta run that reused nearly everything reports
what it actually spent, not what the whole map would have cost from scratch), the `mode` and
`code_graph` fields described above, alongside the projection's own
`projection_id`/`content_digest`/`counts`.

**Named, not silently assumed done**: this composes `claims` + `remap` + `offline-project` +
`project`'s own staging step — it does NOT consume `ascrybe update`'s per-file cache-reused code
facts (a separate code path); code re-extraction here is always full and fresh. That re-extraction
is deterministic and its cost is CPU/time, never model spend, so leaving the two paths unwired is
the simpler, already-reliable choice today. Wiring `ascrybe update`'s cached extraction into this
verb's binding step directly is real future work, not done here.

## Sending a graph to another Ascrybe user

```bash
ascrybe package pack --claim-map-shards <dir> --code-graph <adjacency.json> \
                     --projection-receipt <receipt.json> --out <bundle>
ascrybe package verify --bundle <bundle>
ascrybe package load --bundle <bundle> [--promote]
```

The package ships the projection's **inputs**. A recipient who re-derives and lands on the same
`projection_id` has proof the pipeline agreed — which shipping the finished rows could never give
them. `load` reports *reproduced* or *not reproduced* and exits non-zero on a mismatch.

**A package is the estate, not a summary of it** — verbatim quotes, file paths, declaration names.
Packing prints exactly what is inside before it writes. The Neo4j store is never dumped: it is
shared with unrelated estates.

## Proposed ontology classification (no graph write)

`ascrybe ontology classify --input <private-input.json> --repository <local-git-repo> --output-dir <private-dir>`
reads pinned source and proposes existing type(s), `no_existing_type`, `insufficient_evidence`, or
`out_of_scope`. It never changes observations, ontology generations, or selected heads. The input
names `kind` (`code`, `claim`, `document`), one scoped subject (`kind`, `node_id`, `projection_id`,
`provenance`, `scope`), one or more `sources` (relative `path`, 40-hex `commit_sha`, Git `blob_oid`,
1-indexed `start_line`/`end_line`, exact `text`, SHA-256 of that text as `content_sha256`, `role`),
and a `taxonomy` (`ontology_version_digest` = SHA-256 of Ascrybe's canonical serialization of
`concepts`, each with `id`, `label`, `definition`, `boundary`). The command checks the text and blob against the named Git repository at the pin;
credentials and returned packets never belong in this public checkout. Put the output **outside**
this repository. Source can include relevant imported implementation and interpreter spans, with
exact pin/line/digest, to settle a classification. Adding context creates a **new packet identity**;
it never quietly changes a previous classification.

The runtime config's optional `ontology_classification` field selects the Pi LLM role and an
optional SystemOne accelerator. This exact example runs the selected `evaluation_judge` role when
Jev is absent/unusable and calls pinned Jev when the named credential is present:

```json
"ontology_classification": {
  "llm_role": "evaluation_judge",
  "llm_max_input_bytes": 100000,
  "system_one": { "model": "typesafe/jev-1.13", "credential_env": "OPENROUTER_API_KEY" }
}
```

Omit `system_one` for LLM-only. Omit the whole field in a legacy config: classification uses
`models.code_claims` as the selected LLM, and existing mapping behavior stays unchanged. Never put
a credential value in the config. An unavailable accelerator records a fallback reason and attempt;
a missing selected LLM returns `pending`, not a label. Oversized inputs are never truncated: a
packet over Jev's limit routes whole to the selected LLM; a packet over that LLM's configured byte
ceiling returns `needs_context`. Provider usage, actual model versions, probability distributions
**when Jev supplies them**, and configuration identity are in the private result receipt. LLM
outputs never acquire invented probabilities. The evaluation manifest is **unrated** unless that
exact config and split have been separately measured.

An explicit `no_existing_type` also writes a deduplicated, **proposed** candidate to
`<private-dir>/ontology-gaps.jsonl`. Inspect its returned `gap_id`, then run
`ascrybe ontology analyze-gap --output-dir <private-dir> --gap-id <id>`. The selected LLM proposes
one of `novel_concept`, `missing_context`, `ambiguous_definition`, or `out_of_scope`; none accepts an
ontology version. Existing generations remain as-is until a separately accepted ontology revision
and explicit reclassification.

## Proposed ontology discovery (no graph write)

`ascrybe ontology discover --corpus <private-corpus.json> --repositories <private-repos.json> --output-dir <private-dir>`
asks the selected LLM to propose a vocabulary **from the source itself**: schemes, and concepts with
a definition, inclusion and exclusion, aliases, relations, gaps and unresolved questions. No concept
or category names are supplied. Everything is `proposed`; nothing is accepted, and no graph,
generation or head changes.

Each concept has a **semantic category** that fixes how a subject can be an instance of it:
`responsibility` (code or configuration `implements` it), `type` (`is_a`), `strategy` (a concrete
decision `selects` it), `policy` (a governed material is `subject_to` it), `theme` (an asset
`exemplifies` it) or `practice` (`follows` or `implements`). Any subject may also `define`,
`constrain` or `describe` a concept without being an instance. A concept may narrow which subject
kinds can be instances and state invariants; both are part of its definition. A predicate the
category does not admit is rejected and listed, never relabelled. A document never `implements`, a
passage that mentions something only `describes` it, and an asset named in a document is marked as
referenced, not read: the document does not establish ownership or permission.

Concept fields keep two things apart: the definition, inclusion, exclusion and `invariants` say what
the concept itself is, while `domain` and `instance_conditions` say what an instance must be. Text that
states a rule defines it; what the rule governs is `subject_to` it; one subject never both defines a
concept and is its instance. `polarity` judges the whole assertion, not the source's negation words. An
answer that relates a subject and also marks it unmatched is refused and recorded as
`contradictory_answer`, not reinterpreted. Comment lines in code are observed text whose claim stands
as a `comment_claim`: a comment cannot make code implement anything, and a concept evidenced at
several standings reads `mixed`. A subject that shares an identifier with another excerpt in the
collection is grounded with that excerpt's matching lines as context (never as a source of quotes).

Every quote is located in the pinned excerpt and stored as the exact source text with its lines,
characters and the matching method (`exact`, or tolerant of whitespace, Markdown marks or a
recased first letter). A quote that matches nowhere, or in more than one place, is rejected.
Coverage is reported, never forced: each excerpt and each subject is related to the vocabulary, or
carries `no_matching_concept`, `insufficient_context` or `out_of_scope` with a reason, or is shown as
unexplained. An excerpt the synthesis leaves silent gets one focused call that may propose a
concept (one well-supported excerpt is enough) or record why none fits. Subjects still unresolved are
carried in each collection's queue and re-examined on every later anchored update, not only the changed ones.

Acceptance blockers come only from the checks implemented: opposite claims (one affirmed, one
denied) about the same subject, or about subjects that are the same only by name, which stays a
possible conflict until a person resolves identity. A member quote that overlaps a cited
counterexample is listed for review as a citation check. No other contradiction is detected.

The corpus holds one to three `collections` (a `collection_id`, 2–24 `artifacts`, and
`held_out_artifact_ids` withheld from synthesis but still grounded). Each artifact has an
`artifact_id`, a `kind` (`code`, `structured_source`, `document_claim`, `third_party_reference`),
the source fields from classification above (`repository` key, `path`, `commit_sha`, `blob_oid`, line
span, exact `text`, `content_sha256`) and optional `graph_node_ids` (bind only a node from a projection
built at that same commit). The corpus also records `source_identity`, an
`outbound_review` of `{ "status": "approved_for_selected_llm", "policy": "…" }` (you screen
personal and financial data out first), `unsupported` binary files named with
`code: "DISCOVERY_BINARY_UNSUPPORTED"` and `state: "inventoried_not_interpreted"`, and any `withheld`
artifacts. `--repositories` maps each `repository` key to a local Git checkout; every excerpt is
checked against its pin before a call.

A concept has a stable **accession**, a **version** that changes only when its definition changes,
and evidence **occurrences** that record where it is quoted. Pass `--prior <output-dir>/generations/<id>.json`
after a source change: an unchanged collection is carried with its subjects and no model call; a
changed collection keeps every prior concept, re-locates each quoted passage that still exists
exactly, lists a passage that changed or was deleted as stale evidence (the concept stays, its
grounding is recomputed), adds concepts only for new meaning, and lists any proposed revise, drop,
merge or split as a pending change instead of applying it.

The output directory keeps a call journal of numbered attempts with each full answer. Rerunning the
same corpus replays recorded answers with no new calls. An answer that arrived but could not be read
is a recorded failed attempt and is retried on the next run, at most three attempts. A call that was
sent but has no recorded outcome — a timeout, a cancelled run — halts every later run with
`DISCOVERY_ACCEPTED_UNKNOWN`: it may have been accepted and billed. A person who decides to send it
again records that with `ascrybe ontology resolve-unknown --journal <file> --request-digest <digest> --decided-by <name> --reason <text>`;
the prepared line stays immutable with its outcome unknown and cost null, a `proceed_despite_unknown` event records
execution permission only (not an outcome), the replacement is a new numbered attempt that names the one it
replaces, and the receipt counts the unknown-outcome attempt. Check whether the lost call's answer can be
recovered before authorizing a replacement.

`ascrybe ontology view --generation <output-dir>/generations/<id>.json --port <n>` serves that
generation read-only on `127.0.0.1`: vocabulary first, with each concept's instances, denials,
defining and describing sources, quoted evidence, relations and pending decisions, an excerpt view
of every subject and its coverage, and a review of blockers and coverage. The page opens on the **Graph** view: one evidence chain at a time, drawn from the
assertions and proposed links that were actually sealed (a statement or decision, the concept it defines or
selects, a proposed link to a source-side concept, and the source construct that implements it). A stage with no
located assertion is shown as unknown; nothing is inferred from sharing a file or a word. Selecting a node or a
line shows what the relation means, the exact pinned excerpts, and three separate facts: whether the quoted text
was found at its pin, whether anyone has reviewed it (this viewer records no decisions, so everything reads
"not reviewed"), and what kind of evidence it is (a document says it, source declares it, a comment says it).
The same data is served at `/api/graph`. The `.view-model.json`
beside each generation is the same renderer contract. The **Map** tab draws one column per scheme the
generation proposed with its typed relations; **Revisions** lists, against the prior generation, what was
carried, added or proposed as a same-concept/refinement candidate, which supporting passages no longer
exist at the pin (a definition can outlive its support: its currentness reads `support_stale`), the
unresolved queue, and the declared processing bounds. Surplus beyond a declared bound is listed under
rejected output with its content, never silently dropped.

## Read-only fork-planning view (local only)

`ascrybe fork-view --overlay <private-scenario.json> --graph-manifest <private-graph-source.json> --port 8780`
serves `http://127.0.0.1:8780/`. Omit `--graph-manifest` while an offline graph is being built: the
plan remains browsable, and **Observed layer pending** is prominent. Omit `--overlay` to see the
explicit empty state. Nothing is deployed, provisioned, accepted, or promoted; the process binds
loopback only and exposes no Neo4j credential to the browser. Use a separate port from the served
estate dashboard.

The private overlay (`estate-map/fork-planning-overlay/v1`) declares bounded `components` and
`decisions`. Each component identifies one platform, service, datastore, or provider, its explicit
`graph_refs` (exact `node_id` or exact `{kind,namespace}`), current claim and source refs with
`standing: claimed|source_read|graph_observed|unknown`, separately linked approved decision IDs,
proposed treatment and its cited source, evidence freshness, provider unknown/stale state, needed
work, dependencies, affected components, and **independent** `implementation_verified` boolean.
An approved decision is not implementation verification. A `source_read` observation (such as a
build script or config value) differs from an untested `predicted_consequence` (such as what a
produced archive might contain). `related_by_shared_root_cause` is not a dependency edge. Preserve
`coverage_status` rows for matrix surfaces not inspected; unknown provider state never becomes
absence. Missing graph refs mean pending, never proof of absence. Every real source reference
includes path, commit and date. Keep this overlay
**outside the public repository**; the checked-in fixture under `tests/fixtures/` is invented.

The optional private graph-source manifest (`estate-map/fork-planning-graph-source/v1`) declares
`projection_id`, absolute `nodes_path`, `edges_path` for offline projection JSONL, and SHA-256
of each file (`nodes_sha256`, `edges_sha256`). Optional `content_digest` and
`code_graph_digest` are compared when the overlay declares expected values. The view verifies
file digests and binds only exact, bounded component refs; a projection/content mismatch shows
the planned layer but attaches **no** observed facts. Shared `Repository` refs must say
`association: "repository_locator"`: they locate multiple planning components in one repository,
never prove a native extracted fact for each component. `association: "source_locator"` does the
same for a generic file/Module row; matching a file is not proof its build target, provider link,
or deployment was extracted. Only `association: "exact_component"` is a native component fact. An overlay with no `expected_projection_id` likewise cannot pretend to have a
matched graph. “Graph observed” reports projected code data, not a deployment or behavior proof.
The operator can press **Check graph** when a matching private artifact arrives.

## Where things live

| | |
|---|---|
| [concepts](docs/concepts.md) | planes, roles, assertions, adjudication frames, refusal |
| [architecture](docs/architecture.md) | the five stages, what each costs, generations and promotion |
| [query surface](docs/query-surface.md) | both read boundaries, bounded views, the contract |
| [operating](docs/operating.md) | configuration, staging, promotion, cost control, packaging |
| [evaluation](docs/evaluation.md) | the harness, and what it does **not** measure |

`ascrybe --help` lists every verb. Commands that act on Ascrybe itself rather than on an estate —
`npm run verify`, `npm run verify:falsifiers` — are in [CONTRIBUTING.md](CONTRIBUTING.md).
