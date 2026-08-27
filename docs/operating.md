# Operating

## Configuration

One runtime config per estate, machine-local and never committed:

```
ascrybe.config.json            the default estate
<estate>.ascrybe.config.json   any additional estate
```

Both are matched by a `.gitignore` glob; the tracked `ascrybe.config.example.json` is deliberately
not. That glob and the files it protects must move in the same commit — changing one without the
other leaves live configs untracked, which is how a machine-local file reaches a public repository.

**Credentials are named, never valued.** The config declares the environment variable names for
the Neo4j connection; the values live in `.env` and nothing reads them into an artifact.

**Model roles pin a reasoning level.** `thinking: null` is not a setting — it means the flag is
never passed and the provider's default decides. The same null config cost $0.0124 per window one
week and $0.0657 the next, when a vendor default moved. A test refuses an unset level.

## Building a graph

```bash
npm run map:project -- --claim-map-shards <path> --code-graph <path>            # stage only
npm run map:project -- --claim-map-shards <path> --code-graph <path> --promote  # stage and promote
```

Staging writes a new generation to the `working` head. Promotion advances `selected` through a
compare-and-set against the expected current head, so a concurrent promote fails rather than
silently winning.

**Promotion changes what the dashboard serves.** Say so out loud before doing it.

**Restage if digest-bearing code moved.** A generation staged before a change to anything inside
the digested projection body — including the counts it reports — is no longer what the current
commit produces. Promoting it leaves a served graph nobody can rebuild from a checkout.

Retention keeps the selected generation and one predecessor. Older ones are **regenerable, not
recoverable**: rebuilding one means checking out the code that produced it.

## Estates in one database

Every estate shares one Neo4j, isolated by `projection_id`. Heads are addressed per estate
(`<estate>:selected`), and retention is scoped to one estate *and* protects every head in the
database — the first version scoped only the read, and would have deleted another estate's graph.

## The dashboard

```bash
npm run map:dashboard          # foreground
systemctl --user restart ascrybe-dashboard.service   # the LAN service
```

It binds the host and port in the config's `dashboard` block. It reads the `selected` head live,
so promoting a generation changes what it serves without a restart — but a config change needs
one.

## Cost control

Only the documentary claim extraction costs money, and it is priced per window of document text.
Three things bound it:

- **Scope.** Documents whose adjudication frame is `none` are withheld from the paid read by
  default, and further exclusions are declared by category in the config. Withheld documents are
  still extracted structurally and still become nodes; only the paid read skips them.
- **Reasoning level.** Pinned per role. For schema-constrained extraction, `off` measured 82%
  cheaper with substantively the same claims.
- **Concurrency.** Retries are deliberately suppressed as unsafe, so a rate-limited window is lost
  rather than retried. Raise concurrency for throughput, but watch the lost-window count: coverage
  bought back as speed is a bad trade that shows up nowhere else.

Measure before committing to a corpus-sized run. A slice sampled across size deciles in proportion
to bytes costs a few dollars and replaces an estimate with a rate.
