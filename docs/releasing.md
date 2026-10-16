# Releasing

A release must preserve the query contract, skill bundle, artifact schemas, and reproducible projection identity.

| Surface | Release obligation |
| --- | --- |
| Query contract | Update the declared contract when commands, arguments, or the data model change |
| Skill bundle | Build and verify instructions against the current contract |
| Artifact schemas | Introduce an explicit new schema when meaning changes; do not relabel existing custody |
| Projection identity | Restage when digest-bearing behavior changes; never silently promote a different graph |

## Gate and review

Run the [public verification battery](verification.md), build and verify the skill bundle, and complete the [whole-tree privacy review](before-a-pr.md). Confirm which gates CI actually runs rather than inferring coverage from a green status.

Public documentation changes require an explicit ledger rebind after committing the documents. Private run records stay in external custody; a release must neither publish nor rewrite them. Never merge private history into the public repository.

Configuration fields a paid provider can reinterpret must be pinned intentionally. A null setting may delegate behavior to a provider default; it is not proof of stable cost or behavior. No model spend, service change, or graph promotion is implied by a release check.

## Publication

Use a reviewed pull request to the canonical public branch. Release notes name the query-contract version, any artifact-schema changes, and required regeneration of existing custody. Obtain operator approval before publication.

`package.json` remains private: installation is from a clone, not an npm publication. Generated projections, run payloads, secrets, and machine configuration do not belong in a release. Retain custody manifests and validation logs outside the public tree.
