# Evaluation

**Opinion: the current question set no longer measures whether the graph helps.** It measures
something, and that something has been at ceiling since run 6. This document says so plainly
because a harness whose limits are undocumented gets quoted as if it had none.

## How it works

Three arms answer the same questions in isolated, fresh contexts against the same estate at the
same pinned commit:

| arm | has |
|---|---|
| `filesystem` | the repository, and ordinary file tools |
| `graph` | the query surface, and no file access |
| `both` | both |

Answers are scored against sealed keys by an exact-normalized scorer, not a model. The study is
re-sealed and re-pinned after any runner or projection change; a stale pin fails preflight rather
than running.

## What three runs actually showed

| run | filesystem | graph | both | both − fs |
|---|---|---|---|---|
| 6 cypher-wildcard | 0.667 | 1.000 | 1.000 | +0.333 |
| 7 regression | 0.583 | 0.958 | 1.000 | +0.417 |
| 8 hypergraph | 0.542 | 0.958 | 1.000 | +0.458 |

Read the delta column alone and the graph looks like it is improving. It is not. **The graph and
`both` arms are saturated and have been since run 6; the rising delta is the control arm drifting
down.** Per question, the filesystem arm is a coin flip on 7 of 12: A02 went 1.00 → 0.00 → 0.50,
J03 went 1.00 → 0.00 → 0.00. Five questions it always gets right, and the rest are noise at two
repetitions.

So on correctness this set has stopped discriminating, and a difference of one question moves the
headline number by 0.042.

## What is still moving

Citation exactness, and it moves across questions rather than in one:

| run | `both` | `graph` |
|---|---|---|
| 6 | 0.676 | 0.325 |
| 7 | 0.748 | 0.340 |
| 8 | **0.853** | **0.409** |

Run 7 → 8 was 4 questions up and 2 down for `both`, 5 up and 1 down for `graph`, with 6 unchanged
in each. That is a plausible effect of adding sections and assertions — the arm gets something
exact to cite. Suggestive, not established, at two repetitions.

One measure has held steady throughout and is worth more attention than it gets: **`confidently_wrong`
is 0.000 on the graph and `both` arms in all three runs**, against 0.055–0.103 on filesystem.

## What the harness does not measure

- **Whether the answer was in the graph to begin with.** Questions were written by the same people
  who built the producers. A question set that assumes the answer is present measures retrieval,
  not usefulness.
- **Anything at n > 12 questions × 2 repetitions.** The intervals are wide enough that the
  correctness numbers above are compatible with no effect at all.
- **Cost of being wrong.** Every arm is scored on the same footing whether it abstained or
  asserted confidently, apart from the one rate above.

## What would replace it

Objectives drawn from real work in the estate, each with a verifier that does not know how the
answer is meant to be found, and a cost. Then the question is not "did the arm retrieve the
fact" but "did having the graph change what it cost to do the work". That is deferred, not done,
and until it exists the numbers here should be quoted with the ceiling stated.

## Cost

A run is roughly $17 at twelve questions, three arms, two repetitions, with a reasoning arm. That
is the reason not to re-run it for reassurance: at ceiling, a repeat measures the control arm's
variance and charges for it.
