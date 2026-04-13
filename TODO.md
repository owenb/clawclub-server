# TODO

Deferred non-urgent work. Updated 2026-04-10.

## Performance / scale

- **ANN / pgvector indexing** for `content.searchBySemanticSimilarity`, `members.searchBySemanticSimilarity`, and the matching workers. Currently using brute-force scans. Add HNSW or IVFFlat indexes when dataset size warrants it.
- **Text search indexing** for `content.list` / `events.list` query mode. Currently ILIKE scans. Consider GIN indexes on `tsvector` columns or trigram indexes if query volume grows.
- **Stream reconnect / churn profiling.** `/stream` now seeds activity plus the notification head and runs periodic passive auth refresh. Profile reconnect-heavy workloads and confirm the ready-frame seed cost stays acceptable under realistic churn.
- **Hot-path profiling.** Run `EXPLAIN ANALYZE` on the highest-traffic queries (`content.list`, `events.list`, `listInbox`, `activity.list`, `notifications.list`) under realistic data volumes.

## Codebase cleanup

- **Admissions solver dedup.** `sponsorCandidate` and `selfApply` in `src/clubs/admissions.ts` share a near-identical challenge/solve pipeline. Extract shared challenge flow.
- **Node vs. Bun runtime/tooling debate.** Have an explicit discussion before changing anything. Pros of Bun: simpler direct TypeScript execution, potentially faster startup/install/test cycles, and less `node --experimental-strip-types` noise in scripts. Cons: the current test suite is built around `node:test`, Docker/deploy tooling is Node-based, package-manager/lockfile churn would add operational cost, and runtime compatibility needs to be re-proven for this codebase.
- **Schema registration side effects.** Action schemas register themselves via `registerActions()` called at module import time. Move to explicit registration so the action registry is not assembled via import side effects.
- **`session.getContext` contract awkwardness.** The useful session payload currently lives in the authenticated response envelope (`actor`) while the action's `data` is empty. `SKILL.md` now explains this, so do not change it yet, but revisit whether `session.getContext.data` should become the canonical self-describing session payload.
- **`Repository` interface decomposition.** `src/contract.ts` defines a single `Repository` with 40+ methods. Break into domain-scoped interfaces (`IdentityRepository`, `MessagingRepository`, `ClubsRepository`, etc.) and compose at the edge.
- **`src/postgres.ts` breakup.** The composition layer is 1200+ lines. Split into per-domain files that each wire a domain repository to the pool.
- **`src/clubs/index.ts` breakup.** Vouches, quotas, LLM logging, activity, and embedding search are all in one file. Split by concern.

## Product / domain

- **Billing-model boundary cleanup.** The OSS repo has billing tables, state machine, and `superadmin.billing.*` actions, but Stripe integration lives in a separate repo. Clean up the boundary: document which billing mutations are OSS-side vs. company-side, remove any dead billing code paths, and preserve member-facing membership facts (free/comped status, expiration, renewal, pricing) locally.
- **Public content model decision: flat posts vs threaded public posts.** Public `content.*` currently behaves like flat entities plus optional structured metadata, while DMs are already explicitly threaded with a subject line. Flat public content keeps listing, ranking, moderation, updates, and digest logic simpler and more legible. First-class public threads could make replies/conversation structure explicit and align the public model more closely with how DMs already work, but they would also force harder decisions about read-path shape, ranking/noise, notification semantics, moderation burden, quota treatment, and activity/event modeling. We should make this decision explicitly before exposing public reply semantics as a first-class feature.
- **Pagination integration tests.** Add dedicated multi-page traversal tests for each paginated endpoint (seed > page size, paginate to completion, verify no duplicates/gaps). Current tests verify pagination machinery but don't exercise full page-2+ traversal on most endpoints.
