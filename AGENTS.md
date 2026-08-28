# Ascrybe

Maps a software estate into a queryable Neo4j graph, keeping what a deterministic extractor
**observed** in code separate from what a document **claims** about it.

## Hard constraint — check on every task

This repository is public. The estates it maps are not.

Do not write anything describing a mapped repository into this repository — not in code, fixtures,
documentation examples, analysis, screenshots, commit messages, or pull request descriptions. A
real module, plugin, route, or feature-directory name is that estate's information, and naming one
to explain a change publishes it as surely as committing the file would.

- Use invented names in every example.
- Before opening a pull request, grep the diff for names of estates mapped on this machine.
- If a real name seems load-bearing to an explanation, rewrite the explanation.

Detail: [docs/before-a-pr.md](docs/before-a-pr.md)

## Routing — read one, not both

| If the task is | Read |
|---|---|
| Mapping, querying, promoting, or packaging an estate | **[USAGE.md](USAGE.md)** |
| Changing Ascrybe's own code, tests, docs, or gates | **[CONTRIBUTING.md](CONTRIBUTING.md)** |

Default to `USAGE.md`. Do not load `CONTRIBUTING.md` for a usage task — its invariants, gate
battery, and pull-request discipline do not apply to using the tool, and following them wastes the
run.

## Command surface

- `ascrybe <verb>` acts on an **estate**. Run `ascrybe --help` for the verbs.
- `npm run <script>` acts on **this repository** — the gate battery and dependency install.

Do not add an estate verb as an npm script, or a repository chore as an `ascrybe` verb.
`tests/documentation-command-surface.test.mjs` fails either way, and also fails if a document
teaches the npm spelling of a verb the CLI owns.

## Before reporting a task complete

- `node scripts/test-fast.mjs` passes. It is hermetic: no secret, no database, no model call.
- The diff names no mapped estate.
- Any claim you make about a number is one you ran, not one you expect.
