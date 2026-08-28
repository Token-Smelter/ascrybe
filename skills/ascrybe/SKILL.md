---
name: ascrybe
summary: Read-only interrogation of a versioned software-estate graph through the packaged Ascrybe CLI.
surface_contract: ascrybe/query-surface/v4
description: Use when asked to inspect a software estate, find claims or entities, traverse dependencies, retrieve evidence or provenance, compare selected versus working projections, or explain what the estate map says. Read-only, bounded, projection-scoped. Never writes graph state and never connects to Neo4j directly.
---

# Ascrybe agent query surface

Two read-only boundaries over the same projection. Use one; never reach past them.

**Check the surface before trusting these instructions.** This file is a copy and copies drift:

```bash
ascrybe query contract
```

Its `contract` must equal this skill's `surface_contract` (`ascrybe/query-surface/v4`). If it
does not, the installed skill documents a different build — reinstall it from
`skills/ascrybe/SKILL.md` in the ascrybe checkout rather than working around the
difference. The `digest` covers the command set, every command's arguments, **and the data model** — node
kinds and relation roles. A kind added or a relation re-roled changes it, which is what a skill
describing the graph's contents needs: adding Assertion nodes changed nothing about the commands,
so a digest over commands alone would have reported a match while this prose described a graph
that no longer existed.

```bash
# Closed command set — machine-readable affordances, guided traversal
ascrybe query <command> [options]

# Bounded Cypher — one validated read-only query, best for joins and aggregation
ascrybe cypher --query '<cypher>' [--parameters '<json>'] [--view selected|working]
```

The runtime environment supplies Neo4j credentials through the environment-variable names declared in `ascrybe.config.json`. Never print those values. Never connect to Neo4j directly.

**Which surface.** Commands when you are exploring and want `next_queries` to lead you, or when you
need `read-span`, `provenance`, or `consumers` semantics. Cypher when the answer is a join,
a filter, a count, or a set — one query beats four traversal turns, and measured on a sealed
12-question study it cut graph-arm tokens 25% and additive-arm tokens 36% at equal-or-better
correctness.

## Cypher surface

```bash
ascrybe cypher --query 'MATCH (n:EstateNode {projection_id: $projection_id, kind: "Plugin"}) RETURN n.label AS plugin, n.structural_children AS children ORDER BY children DESC LIMIT 10'
```

Data model — one generation, scoped by the gateway-supplied `$projection_id`:

```text
(:EstateNode {projection_id, node_id, kind, label, search_text (lowercase),
              plane, degree, structural_degree, structural_children, structural_descendants,
              properties_json})
-[:ESTATE_EDGE {projection_id, edge_id, relation, role, parent_end, properties_json}]->

kinds      Plugin Capability Envelope Module Symbol Route Table CodeFact Claim Evidence
           Document AdjudicationReceipt ObligationResult Referent SourceCommit Project
           Assertion DocumentSection Diagram DiagramRelation CatalogEntry ToolRegistration
role       structural (contains declares_symbol provides_capability publishes_envelope
                       exposes_route registers_route member_of observed_in)
           flow       (emits consumes imports depends_on requires_capability calls_capability
                       subscribes_envelope publishes_to uses_infra)
           annotation (documented_in about identifies realized_by supported_by derived_from
                       adjudicated_by evidenced_by has_obligation_result
                       asserted_in read_from relates_assertion)
plane      entity | observation | documentary | adjudication
```

`properties_json` is a JSON string, stored pretty-printed; filter it with `CONTAINS` using the
spacing `"key": "value"` and parse the returned value.

## The documentary plane

Documents do not only mention entities — they **assert** things, and what a document asserts is
weaker evidence than what a producer witnessed. Both are in the graph and they must not be
confused.

```text
Document          a file. DocumentSection is one heading: section_path is the author's outline
                  ("Design / Constraints / Known limitations"), which survives line numbers moving.
Diagram           one mermaid/plantuml fence, kept verbatim. 78% of drawn identifiers name nothing
                  in the estate, so the drawing existing is the fact; its endpoints are shorthand.
DiagramRelation   one drawn edge, with the author's own label as written.
Assertion         what a document claims. subject_kind is `relation` (a drawn edge), `unresolved`
                  (a reference nothing has grounded), or a relation between two other Assertions —
                  which is how the corpus disagrees with itself.
```

**This plane is a hierarchy, so descend it rather than filtering the commit.** A section is
contained by the section above it and a top-level section by its document; a diagram by the
section it sits in; a drawn edge by the fence it was read from. So `node` on a Document returns
its own sections, and descending from a section reaches the diagrams inside it:

```bash
ascrybe query node --id "doc:design/features/some-feature.md"
```

Earlier generations hung every one of these off the SourceCommit instead, which made a Document
drill straight to its claims and to none of its own structure. If you see that shape, the
projection predates the fix and `contains` edges are absent — check `contract` against this
skill's `surface_contract` before trusting the traversal.

Every Assertion carries `document_mode` (what kind of document said it) and
`adjudication_frame` — what could refute it:

| frame | meaning |
|---|---|
| `code` | a specification: the implementation could contradict it |
| `code_and_supersession` | a decision: code, or a later decision |
| `execution` | a plan or report: was the thing actually done? |
| `world` | research: refutable, but not from inside this estate |
| `external_system` | a ticket or KB entry: answers to a system this map does not hold |
| `none` | a log, or archived material: no current standing |

**Never treat a drawn edge as an observed relation.** `from_text` and `to_text` are the identifiers
as the document wrote them; grounding, when it exists, is a separate receipted edge and never
rewrites them. An assertion whose endpoints ground to nothing is honest, not broken.

```bash
# What does the corpus contradict about itself?
ascrybe cypher --query '
MATCH (r:EstateNode {projection_id: $projection_id, kind: "Assertion"})
WHERE r.properties_json CONTAINS ""predicate": "direct_conflict""
MATCH (r)-[:ESTATE_EDGE {projection_id: $projection_id, relation: "relates_assertion"}]->(a:EstateNode {projection_id: $projection_id})
RETURN r.label AS conflict, collect(a.label) AS claims'

# What does one document assert, and could any of it be refuted by code?
ascrybe cypher --parameters '{"doc":"design/features/normative-plane/DESIGN.md"}' --query '
MATCH (a:EstateNode {projection_id: $projection_id, kind: "Assertion"})
  -[:ESTATE_EDGE {projection_id: $projection_id, relation: "asserted_in"}]->
  (d:EstateNode {projection_id: $projection_id}) WHERE d.label = $doc
RETURN a.label AS claim, a.properties_json AS detail LIMIT 50'
```
Flow edges carry `witnesses: [{repo, file, line}]` — that is the exact citation for an emit or
consume fact. Edges derived from a wildcard subscription carry `resolution_kind:
"wildcard_subscription"` and `match_pattern`; they are **not** literal flow facts, so exclude them
when a question asks for literal ones. `documented_in` edges carry `match_basis`
(`exact` | `normalized`) and `surface`.

Gateway rules: single statement, must `RETURN`, no writes (`CREATE`/`MERGE`/`SET`/`DELETE`), no
`CALL` procedures (`CALL { }` subqueries are fine), every `EstateNode` pattern must include
`{projection_id: $projection_id}`, results capped at 200 rows with a disclosed `truncated` flag.
Refusals are typed JSON on stderr — read `detail.messages` (Neo4j's own complaint, with the
offending column) and correct the statement; do not retry it unchanged.

**Read `columns`, never positional order.** The row cap wraps your query in `CALL { … } RETURN *`,
which returns aliases alphabetically, not in your `RETURN` order. Zip `columns` with each row.
A variable-length pattern puts the range before the property map: `-[r:ESTATE_EDGE*1..2
{projection_id: $projection_id}]->`.

### Worked recipes

```bash
# Every plugins/** file with a literal emit or consume fact for one envelope, with its line
ascrybe cypher --parameters '{"kind":"acceptance.brew_requested"}' --query '
MATCH (e:EstateNode {projection_id: $projection_id, kind: "Envelope"}) WHERE e.label = $kind
MATCH (m:EstateNode {projection_id: $projection_id})-[r:ESTATE_EDGE {projection_id: $projection_id}]->(e)
WHERE r.relation IN ["emits","consumes"] AND m.label STARTS WITH "plugins/"
  AND NOT r.properties_json CONTAINS "wildcard_subscription"
RETURN DISTINCT r.relation AS direction, m.label AS file, r.properties_json AS witnesses'

# What a plugin composes, by tier
ascrybe cypher --parameters '{"plugin":"task-orchestration"}' --query '
MATCH (p:EstateNode {projection_id: $projection_id, kind: "Plugin"}) WHERE p.label = $plugin
MATCH (p)-[r:ESTATE_EDGE {projection_id: $projection_id, role: "structural"}]->(c:EstateNode {projection_id: $projection_id})
RETURN r.relation AS relation, c.kind AS kind, count(*) AS n ORDER BY n DESC'

# Blast radius: what depends on a module, two hops out
ascrybe cypher --parameters '{"file":"plugins/task-orchestration/server/index.mjs"}' --query '
MATCH (m:EstateNode {projection_id: $projection_id}) WHERE m.label = $file
MATCH (d:EstateNode {projection_id: $projection_id})-[r:ESTATE_EDGE*1..2 {projection_id: $projection_id}]->(m)
WHERE all(e IN r WHERE e.role = "flow")
RETURN DISTINCT d.kind AS kind, d.label AS dependent LIMIT 100'
```

## Commands

```text
projection-status
stats [--view selected|working]
concepts [--limit N] [--view ...]
overview [--view selected|working] [--limit N]
search --term TEXT [--kinds Claim,Referent,...] [--limit N] [--view ...]
node --id ID [--limit N] [--expand structural|all] [--view ...]
neighbors --id ID [--relation exact_relation] [--direction in|out|both] [--limit N] [--view ...]
consumers --id ENVELOPE_ID [--limit N] [--view ...]
path --from ID --to ID [--depth N] [--view ...]
provenance --id ID [--depth N] [--limit N] [--view ...]
read-span --id CODEFACT_ID [--before N] [--after N] [--view ...]
```

## Operating rules

1. Default to the selected projection. Query `working` only when the user asks about in-progress state.
2. Begin broad questions with `concepts` (what the estate is about, by exact counts), then
   `overview` or `search` only to obtain an ID. Follow the returned machine-readable
   `next_queries`: use `neighbors` for bounded directed traversal and `consumers` for an Envelope's
   grouped publishers and consumers before issuing another keyword search.
3. Every edge carries a `role` — `structural` (composition, with a `parent_end`), `flow` (peer
   dependency or message traffic), or `annotation` (documentary, evidence, identity, adjudication) —
   and every node a `plane` with `structural_children` and `structural_descendants`. `overview`
   descends structural edges from the estate anchor; `node` returns structural and flow neighbours
   as rows and every relation as a counted `bundles` entry whose `next_queries` unfold it with
   `neighbors`. `--expand all` returns every relation as rows, annotation last. A bundle count is
   the complete number; `neighbors` rows are the bounded page.
4. `concepts` ranks documents by claim count and entities by documentation and structural
   connections. These are counts, not topic models: never describe them as themes the system
   inferred.
5. `read-span` is anchored to a returned CodeFact ID and exact pinned Git bytes; it never accepts a
   path. A refusal is evidence that the source location is unavailable, not permission to guess.
6. Use `provenance` before making a claim about why a verdict or relation exists.
7. Preserve the returned projection ID, source commit, truncation flag, and node IDs in the answer.
8. A truncated response is not a complete-set result. Narrow the query or explicitly report the bound.
9. `supported` is only the recorded evidence-tier verdict. Do not upgrade it to behavioral proof unless the returned receipt names executed evidence.
10. Never infer identity from labels or surfaces. Follow `identifies` or other receipt-backed graph edges.
11. Do not mutate, annotate, correct, or promote projections. This first agent surface is read-only.

## Three-arm evaluation workflow

Use `node tools/eval/cli.mjs --config /absolute/external-config.json` only for a prepared,
external study. The harness runs the same model with the same turn budget in fresh filesystem,
graph, and additive filesystem+graph contexts, then treats `both_minus_filesystem` as its primary
effect while retaining `graph_minus_filesystem` and `both_minus_graph` as diagnostics.

The configuration's results directory must be outside the repository. Before any paid model call,
the controller creates its external journal and pins the target commit, selected complete
projection, question/key digests, model settings, graph mode, benchmark policy, raw and resolved
runtime-config digests, behavioral-source closure digest, harness digest, and arm-tool-schema digest.
A coverage claim uses external claim-map and remap code-graph artifacts
only when their recomputed identities match the selected projection; the remap's exact extractor
stream supplies its coverage facts, and information it does not preserve is `unavailable` rather
than inferred. Every fsynced journal record is hash-chained; terminal finalization binds the
pre-final journal, sealed bundle, runtime-config, behavioral-source closure, harness, and tool schemas.
`--resume` checks those immutable inputs and bindings. It reuses a complete schema-valid score, or a complete schema-valid arm execution while running only its missing score step; corrupt or mismatched records are refused.

Model calls use one bounded retry/backoff policy for arm and blind-judge paths. Only typed transient
or model-unavailable failures retry; malformed final answers, tool misuse, deterministic validation,
and scoring disagreement remain recorded terminal outcomes. A `model_unavailable` result means the
eligible retry budget was exhausted, not that a query or answer was merely invalid. The study bundle
is evidence about these bounded read-only surfaces, not evidence that the projection or service was
changed.
