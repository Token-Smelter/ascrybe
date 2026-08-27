# Concepts

Ascrybe answers two questions about a software estate: **what is there**, and **on what warrant do
we say so**. The second is the reason the model is shaped the way it is. Most of what follows
exists to keep a thing somebody wrote from being confused with a thing somebody observed.

## Planes: what kind of fact a node is

Every node kind sits in exactly one plane, declared in `tools/estate-graph-roles.mjs`. The plane
says what would have to be true for the node to be wrong.

| plane | kinds | a node here is wrong if |
|---|---|---|
| `entity` | 15 | the thing does not exist in the estate |
| `observation` | 6 | the extractor misread the bytes it witnessed |
| `documentary` | 6 | the document does not say that |
| `adjudication` | 4 | the judgement was reached incorrectly |

The distinction that matters most is **observation versus documentary**. A `CodeFact` is a
declaration a deterministic extractor witnessed in a file. A `Claim` is something a document
asserts. Both are in the graph and they are never merged, because a specification saying a module
retries and the module actually retrying are different facts, and the interesting question is
whether they agree.

## Roles: what kind of edge a relation is

Every relation has exactly one role, from the same registry.

| role | count | meaning |
|---|---|---|
| `structural` | 15 | containment — one end owns the other, named by `parent_end` |
| `flow` | 14 | something moves or depends: calls, publishes, consumes |
| `annotation` | 17 | one thing says something about another |

`parent_end` is the field that makes containment drawable. Without it a client sees `contains`
between two nodes and cannot tell which one holds the other, because direction alone does not say:
`observed_in` runs child-to-parent and `contains` runs parent-to-child.

Roles are what let a bounded view stay legible. A view that unfolds structure and folds annotation
into counted bundles shows shape; unfolding everything shows a hairball.

## Assertions: the two-level model

An **observation** needs no warrant beyond the witness — the extractor read the bytes and the
bytes are quoted. An **assertion** is different: somebody claimed something, and the claim is only
as good as who claimed it and what could refute it. Every assertion carries three things.

- **subject** — what it is about: an entity, a relation, another assertion, or an `unresolved`
  reference that grounds to nothing yet. An assertion about an assertion is how a corpus
  disagrees with itself.
- **source** — the document, the line, and the `section_path`, so the citation survives the line
  numbers moving.
- **nature** — the producer, the modality (does it prescribe or describe), the document mode, and
  the adjudication frame.

**Grounding never rewrites an assertion.** If a document says `OrderSvc` and the estate calls it
`order-service`, the verbatim identifier stays verbatim forever and the resolution is a
separate, receipted record. Collapsing them at write time destroys the finding.

## Adjudication frames: what could refute this

A boolean "adjudicable" conflated two different questions — whether a claim can be checked against
code, and whether it can be checked at all. The frame separates them.

| frame | a document of this kind | refuted by |
|---|---|---|
| `code` | a specification | the implementation contradicting it |
| `code_and_supersession` | a decision | code, or a later decision |
| `execution` | a plan or report | whether the thing was actually done |
| `world` | research | evidence, but not from inside this estate |
| `external_system` | a ticket or KB entry | a system this map does not hold |
| `none` | a log, or archived material | nothing — it has no current standing |

`none` is not a failure to classify. It is a finding: the document asserts nothing that anything
could contradict. Ascrybe uses it to decide what is worth paying a model to read.

## Refusal

A refusal is a recorded outcome, never a silent absence. When a container cannot be resolved, a
quote cannot be re-found in its window, or a reference grounds to nothing, the graph records the
refusal and its reason rather than dropping the row. Two defects in this repository's own history
came from silent fallbacks: 320 assertions lost their document edge without anything counting
them, and 23,206 documentary facts attached to a commit because the code had nowhere to say they
had a real parent.

The rule this produced: **an omission must fail, not default.** Where something must be declared,
not declaring it is an error rather than a quiet fallback to whatever seems reasonable.
