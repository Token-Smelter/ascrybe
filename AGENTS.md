# Ascrybe — start here

Ascrybe maps a software estate into a queryable graph, keeping what a deterministic extractor
**observed** in the code apart from what a document **claims** about it.

## Which door

**Using Ascrybe** — mapping an estate, querying it, sending a graph to someone:
**[USAGE.md](USAGE.md)**. That is the default, and it is the whole of what you need. Run
`ascrybe --help` for the verb list.

**Changing Ascrybe** — editing this repository's own code, tests, or gates:
**[CONTRIBUTING.md](CONTRIBUTING.md)**. It carries the invariants, the verification battery, and
the pull-request discipline. Read it only if you are working on the platform; none of it applies
to using the tool.

The line those two documents draw is the same one the command surface draws: `ascrybe <verb>` does
something to an **estate**, `npm run <script>` does something to **Ascrybe**.

## The one rule that has no door

**This repository is public. The estates it maps are not.** Nothing describing a mapped repository
belongs here — not in code, fixtures, documentation examples, analysis, screenshots, commit
messages, or pull request descriptions. A real module, plugin, route, or feature-directory name is
that estate's information, and naming one to explain a change publishes it as surely as committing
the file would.

Use invented names in every example. Before opening a pull request, grep the diff for the estates
you map. If a real name seems load-bearing to an explanation, rewrite the explanation.

See [docs/before-a-pr.md](docs/before-a-pr.md).
