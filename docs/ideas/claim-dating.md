# Claim dating and public evaluations

Claim authorship should come from the supporting source lines at the pinned Git commit, never from extraction or import time. This is a proposal, not implemented behavior.

## Date contract

Run `git blame` at the source pin over each claim's cited line range. Record the latest authored date and contributing commit SHAs; an earliest authored date can expose ranges assembled over time. Keep authorship, source-pin time, and extraction time separate.

| Source condition | Authored date | Reason |
| --- | --- | --- |
| Complete Git history for cited lines | Latest contributing authored date | Git blame evidence |
| Shadow repository created from a folder snapshot | `UNKNOWN` | `snapshot_import` |
| Shallow history that cannot establish authorship | `UNKNOWN` | `shallow_history` |
| Missing historical objects | `UNKNOWN` | `missing_history` |
| Uncommitted source | `UNKNOWN` | `uncommitted_source` |

`UNKNOWN` is an explicit enum value, not a guessed timestamp. A shadow repository's import commit dates the import, not the writing. Git author timestamps are source metadata, not independently verified wall-clock truth.

An invented dispatch guide might claim that the Parcel service retries failed deliveries. Date that claim from its supporting lines, not from the day the guide was mapped. These dates can inform staleness signals, conflicting-claim ordering, change views, and comparisons between older documentation and newer code; recency alone does not establish truth.

## Public evaluations

Map Ascrybe's own public source to build reproducible public evaluations. Publish source pins, expectations, results, and measured costs with invented examples where needed. Keep evaluations derived from private estates in private state. Publishing an evaluation must not imply that a proposed dating feature already exists or that an unrun evaluation passed.
