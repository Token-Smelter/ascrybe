# Query surface

Two read-only boundaries over one projection. Use one; never reach past them.

## Checking the surface before trusting a document

```bash
ascrybe query contract
```

The `contract` command returns the command set, every command's arguments, **and the data model** —
node kinds and relation roles — plus a digest over all of it. A skill or client holding a declared
expectation compares it and refuses to proceed on a mismatch.

The data model belongs in that digest for a reason: adding `Assertion` nodes changed nothing about
the command set, so a digest over commands alone reported a matching contract while the prose
described a graph that no longer existed.

Current version: `ascrybe/query-surface/v4`.

## Commands

| command | answers |
|---|---|
| `projection-status` | which generation is selected, which is staged |
| `stats`, `concepts` | what the estate is made of, ranked by exact counts |
| `overview` | the estate anchor and its structural descent |
| `search` | find a node by name, path, or statement |
| `node` | one node with its neighbours and counted bundles |
| `neighbors`, `consumers` | bounded traversal by relation and direction |
| `path` | how two nodes connect |
| `provenance` | what justifies a claim, walking justification edges only |
| `read-span` | the exact bytes behind a fact |

Every result carries `next_queries` — the affordances available from where you are — so traversal
is guided rather than guessed.

## Bounded views say what they bounded

Any view that returns rows is bounded twice: by a total limit, and by a **per-kind quota** so one
dominant kind cannot consume the budget. A document with 233 claims and one section spent every
available row on claims, and the section survived only on a ranking tiebreak.

The quota is a caller parameter (`--kind-quota`), not a constant, because how much of a
homogeneous mass to unfold is a judgement about a particular graph. What is withheld is named per
kind on the response, and the counted bundles always carry the true totals. A bounded view that
does not say what it bounded reads as a complete one.

## The Cypher gateway

For questions the command set does not shape:

```bash
ascrybe cypher --query 'MATCH (n:EstateNode {projection_id: $projection_id}) RETURN count(n) AS n'
```

It refuses write and admin keywords after stripping strings and comments, refuses procedure calls
while allowing `CALL { }` subqueries, requires `$projection_id` on every `EstateNode` pattern, and
caps rows. `$projection_id` is supplied by the gateway, never by the caller — which is what keeps
a query from reading across generations.

## Errors are typed

Failures return a code, not prose to parse: `ESTATE_QUERY_NODE_MISSING`,
`ESTATE_QUERY_PROJECTION_MISSING`, `ESTATE_CYPHER_UNSCOPED`. A missing node is refused loudly
rather than answered with an empty result, because an empty graph and an absent node look
identical once drawn.

## Packaging

`ascrybe skill bundle` builds a self-contained copy of this surface — the two entry points, their
transitive import closure, and instructions with no machine-specific paths. `ascrybe skill verify`
compares an installed bundle's declared contract and digest against the live surface, which
catches the case a version check alone misses: same commands, changed data model.

The bundle names the environment variable it needs and never carries a credential.
