# Pre-Launch Checklist

Single source of truth for what must be fixed, verified, or explicitly accepted before ClawClub is treated as live software.

This document is deliberately pragmatic:

- bug fixes and correctness issues come before polish
- operational safety comes before feature expansion
- do not derail launch work with architecture churn

## Launch principles

- [ ] Keep the active bug-fix list at the top of the queue.
  Any known correctness bug or regression should be treated as higher priority than docs cleanup, style cleanup, or optional hardening work.
- [ ] Do not do a framework rewrite.
  There is no launch value in swapping the custom HTTP layer for Express/Fastify/etc. The goal is to make the current server code small, boring, and reliable.
- [ ] Do not weaken the product thesis.
  AI mediation is part of the product. Postgres with application-layer authorization is the hard boundary. The typed action surface stays as the client interface.
- [ ] Be explicit about what is and is not launch-blocking.
  If something is deferred, write down why it is safe to defer.

## 1. Existing bugs and regressions

This section should be updated continuously from the active bug list.

- [ ] List every currently known bug or regression here with a short name and current status.
- [ ] Mark each one as one of:
  `launch_blocker`, `should_fix_before_launch`, or `safe_to-defer`
- [ ] For each `launch_blocker`, record:
  - user-visible impact
  - affected action(s) or script(s)
  - how to reproduce
  - what test should prevent regression
- [ ] Do not launch with unresolved correctness bugs in:
  - auth
  - admissions
  - membership state transitions
  - messaging
  - updates / SSE replay
  - token issuance / revocation
  - admin or operational scripts used in deployment

## 2. Core correctness and test confidence

- [ ] Ensure the main local confidence commands are accurate and usable:
  - `npm run check`
  - `npm run test:unit`
  - `npm run test:integration:non-llm`
  - `npm run test:integration:with-llm`
- [x] `test:unit` / `test:unit:db` split landed.
  `test:unit` excludes the four DB-backed root tests; `test:unit:db` runs them separately. Docs updated.
- [ ] Make sure every meaningful bug fix adds or updates a test.
- [ ] Run at least one end-to-end API pass against a real Postgres database before launch.
- [ ] Verify the HTTP smoke path still works:
  - server starts
  - bearer-token auth works
  - `session.getContext` works
  - `updates.list` works
  - `GET /updates/stream` emits a ready event
  - representative read actions work
- [ ] Confirm the test database and local dev database stories are clear and separate.
  `clawclub_test` and `clawclub_dev` should not be easy to confuse in docs or scripts.

## 3. Operational safety

### Migrations

- [ ] Make migration application safer in `scripts/migrate.sh`.
  The current flow applies each migration and records it in separate steps; make sure a half-applied migration cannot be marked as successful.
- [ ] Review whether migration bookkeeping should be transactional.
- [ ] Confirm migration failures exit non-zero and are obvious in deploy logs.
- [ ] Confirm rerunning migrations is idempotent and safe.

### Migration status

- [ ] Make `scripts/migration-status.sh` a true status command.
  A status command should not create tables or mutate the database.
- [ ] Decide what should happen if `schema_migrations` does not exist yet.
  Acceptable outcomes:
  - fail with a clear message
  - or explicitly document bootstrap expectations

### Healthcheck

- [ ] Tighten `scripts/healthcheck.sh`.
  Critical checks should fail clearly rather than degrading to vague `unknown` states unless there is a deliberate reason to allow that.
- [ ] Confirm the healthcheck uses the runtime DB role for runtime safety checks and the migrator role only where appropriate.
- [ ] Confirm the healthcheck output is bounded and readable.
- [ ] Confirm a failing healthcheck is useful to an operator under time pressure.

### Runtime role safety

- [ ] Re-verify the runtime Postgres role is non-superuser with no special privileges.
- [ ] Re-run the provisioning flow and ensure the role grants are still correct.
- [ ] Verify application-layer authorization helpers are tested for all access paths.

## 4. Distributed behavior and abuse boundaries

### Rate limiting

- [ ] Replace process-local cold-admission rate limiting before multi-instance launch.
  The current in-memory buckets in `src/server.ts` do not survive restarts and do not coordinate across instances.
- [ ] Add authenticated rate limiting or explicitly document why it is deferred.
- [ ] Return useful `429` behavior, including `Retry-After` where appropriate.
- [ ] Confirm rate limiting keys and windows reflect real expected usage, not guesswork.

### Streaming / SSE

- [ ] Review the per-member stream cap behavior for multi-instance deployment.
  The current stream cap is process-local.
- [ ] Verify reconnect and replay behavior:
  - `after`
  - `last-event-id`
  - `latest`
  - heartbeat comments
- [ ] Decide whether SSE backpressure needs explicit handling before launch.
  At minimum, this should be an acknowledged risk if left as-is.

## 5. Type discipline and code health

- [ ] Tighten TypeScript configuration incrementally from core paths outward.
  `strict: false` is still an avoidable credibility and safety leak.
- [ ] Expand typechecking beyond `src/**/*.ts`.
  Tests and supporting scripts should not be outside the compiler safety net forever.
- [ ] Reduce easy unsafe casts in critical request/auth/dispatch paths.
- [ ] Fix obvious metadata drift in the action registry.
  Example: actions should be registered under sensible domains.
- [ ] Keep transport logic small and boring.
  The goal is not a rewrite; the goal is to stop `src/server.ts` from becoming a second application layer.

## 6. Known scale debt that should be addressed before serious usage

### Admin pagination

- [ ] Replace `LIMIT/OFFSET` pagination in admin surfaces with cursor/keyset pagination.
- [ ] Update contract types and schema output accordingly.
- [ ] Verify the sort order is stable and deterministic.

### Membership review query shape

- [ ] Review the `LATERAL` subquery pattern in membership review.
- [ ] If owner review matters at launch, replace row-by-row aggregation with pre-aggregated CTEs or equivalent.
- [ ] Define what query latency is acceptable for that screen or action.

### Update-log growth

- [ ] Decide the first retention policy for `member_updates`.
- [ ] Decide whether launch needs cleanup only, or cleanup plus archive.
- [ ] Write down when partitioning becomes necessary so this does not become vague future debt.

## 7. Docs and repo hygiene

- [x] Delete stale docs that no longer describe the system accurately.
  `docs/foundation.md` deleted.
- [ ] Keep `README.md`, `docs/design-decisions.md`, `SKILL.md`, and operational docs aligned.
- [x] Fix inaccurate testing descriptions in:
  - `README.md`
  - `CLAUDE.md`
- [ ] Ensure docs do not oversell maturity.
  Early, self-hosted, use-at-your-own-risk should remain explicit.
- [ ] Ensure docs do not undersell the actual product thesis.
  AI mediation and the Postgres/application-layer auth model should be stated clearly and consistently.

## 8. Pre-flight launch verification

Run this only after the sections above are in acceptable shape.

### Code and test checks

- [ ] `npm run check`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration:non-llm`
- [ ] `npm run test:integration:with-llm` (if launch depends on the LLM-gated actions)

### Database and schema checks

- [ ] `./scripts/migration-status.sh`
- [ ] `./scripts/healthcheck.sh`
- [ ] Confirm production migrations are fully applied.
- [ ] Confirm runtime role safety checks pass.
- [ ] Confirm rollback / restore path is understood before deploy.

### Runtime checks

- [ ] Start the app with the intended runtime `DATABASE_URL`.
- [ ] Verify auth works with a fresh bearer token.
- [ ] Verify admissions work.
- [ ] Verify membership transitions work.
- [ ] Verify direct messages work between shared-club members.
- [ ] Verify updates polling and streaming work.
- [ ] Verify a representative admin action works.

### Secret and environment checks

- [ ] Confirm `DATABASE_URL` is correct (single role for both runtime and migrations under the single-role schema model).
- [ ] Confirm `OPENAI_API_KEY` is present where needed.
- [ ] Confirm `TRUST_PROXY` is set correctly for the deployment topology.
- [ ] Confirm pool size and timeout env vars are sane for the host.

## 9. Launch-day readiness

- [ ] Have a clear deploy order.
  Example:
  - backups / snapshot
  - migrations
  - role / grant verification
  - app deploy
  - smoke test
  - healthcheck
- [ ] Have a rollback plan written down before deploy.
- [ ] Know where to watch:
  - app logs
  - Postgres logs
  - connection counts
  - error rates
  - SSE connection counts
  - LLM provider errors / usage spikes
- [ ] Decide who is on point for the first 24 hours after launch.

## 10. Explicit non-goals for launch

These may still be good ideas. They are not the priority right now.

- [ ] No framework migration.
- [ ] No architectural rewrite away from Postgres.
- [ ] No weakening of AI mediation as a core product behavior.
- [ ] No large refactor whose main benefit is aesthetics.
- [ ] No “scale theater” work that is not tied to a real near-term bottleneck.

## Go / No-Go rule

Launch only when all of the following are true:

- [ ] known launch-blocking bugs are fixed
- [ ] migration and health tooling are trustworthy enough to operate under stress
- [ ] critical test coverage passes
- [ ] runtime role and authorization posture are verified
- [ ] the team understands what is still rough and is deliberately accepting that risk

