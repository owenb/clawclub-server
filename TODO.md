# TODO

Deferred non-urgent work. Updated 2026-04-08.

## Performance / scale

- **ANN / pgvector indexing** for `content.searchBySemanticSimilarity`, `members.searchBySemanticSimilarity`, and the matching workers. Currently using brute-force scans. Add HNSW or IVFFlat indexes when dataset size warrants it.
- **Text search indexing** for `content.list` / `events.list` query mode. Currently ILIKE scans. Consider GIN indexes on `tsvector` columns or trigram indexes if query volume grows.
- **`/updates/stream` scope reuse.** SSE polling computes `clubIds` once at connection time (from `auth.actor.memberships`). If a member's club access changes mid-stream, the scope is stale until reconnect. Consider periodic scope refresh or membership-change eviction.
- **Hot-path profiling.** Run `EXPLAIN ANALYZE` on the highest-traffic queries (`content.list`, `events.list`, `listInbox`, `listMemberUpdates`) under realistic data volumes.

## Codebase cleanup

- **Admissions solver dedup.** `sponsorCandidate` and `selfApply` in `src/clubs/admissions.ts` share a near-identical challenge/solve pipeline. Extract shared challenge flow.
- **Schema registration side effects.** Action schemas register themselves via `registerActions()` called at module import time. Move to explicit registration so the action registry is not assembled via import side effects.
- **`session.getContext` contract awkwardness.** The useful session payload currently lives in the authenticated response envelope (`actor`) while the action's `data` is empty. `SKILL.md` now explains this, so do not change it yet, but revisit whether `session.getContext.data` should become the canonical self-describing session payload.
- **`Repository` interface decomposition.** `src/contract.ts` defines a single `Repository` with 40+ methods. Break into domain-scoped interfaces (`IdentityRepository`, `MessagingRepository`, `ClubsRepository`, etc.) and compose at the edge.
- **`src/postgres.ts` breakup.** The composition layer is 1200+ lines. Split into per-domain files that each wire a domain repository to the pool.
- **`src/clubs/index.ts` breakup.** Vouches, quotas, LLM logging, activity, and embedding search are all in one file. Split by concern.

## Product / domain

- **Billing-model boundary cleanup.** The OSS repo has billing tables, state machine, and `superadmin.billing.*` actions, but Stripe integration lives in a separate repo. Clean up the boundary: document which billing mutations are OSS-side vs. company-side, remove any dead billing code paths, and preserve member-facing membership facts (free/comped status, expiration, renewal, pricing) locally.
- **Pagination integration tests.** Add dedicated multi-page traversal tests for each paginated endpoint (seed > page size, paginate to completion, verify no duplicates/gaps). Current tests verify pagination machinery but don't exercise full page-2+ traversal on most endpoints.
