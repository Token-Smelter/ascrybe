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

## Mapping an estate

Five stages. Only the fourth costs money.

```bash
ascrybe extract  <estate-root> <out>          # read the estate into facts
ascrybe merge    <extract-dir> <out>          # reconcile facts into one code graph
ascrybe remap    --work <dir> --sha <commit>  # resolve the code plane and its referents
ascrybe claims   ...                          # the paid documentary read
ascrybe project  --claim-map-shards <dir> --code-graph <adjacency.json> --promote
```

The first three are deterministic and free. `claims` is the only stage that calls a model, and it
is priced per window of document text — measure on a slice before committing to a corpus.

`project` stages an immutable generation and, with `--promote`, advances the `selected` head that
readers see. **Promotion changes what the dashboard serves; say so out loud before doing it.**

Everything a stage refuses is counted and named. A missing claim is always attributable to a
window, a refusal, or a documented cap — never to silence.

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
will not invent a skills directory in a project that has no convention for one (pass `--skills-dir`
to say where), will not delete a directory it cannot identify as a previous install of this skill,
and will not report success until each installed entry point loads from its new home and refuses an
empty config. It writes `INSTALL.json` recording which Ascrybe commit produced the copy — the
contract digest can say a bundle describes a different surface, but not which build it came from.

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
