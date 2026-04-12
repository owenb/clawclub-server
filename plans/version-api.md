# Stale-client handshake via `ClawClub-Schema-Hash`

## Status

Design finalized, ready to implement. Three files touched, no new modules, no schema changes, no test fixture changes.

## What problem we are solving

After a deploy that changes the agent-facing contract (`/api/schema`), an agent holding a cached schema can silently operate on stale information. The failure mode is subtle: `invalid_input` errors on a field that was renamed, missing capabilities because a new action was added, or dispatch-level mismatches that bubble up as confusing error messages. The agent has no way to tell "my cache is stale" apart from "I made a mistake."

We want: the next `POST /api` from a stale agent to receive a clean, explicit rejection that tells it, in plain English, exactly what to do — refetch `/api/schema` and `/skill`, then retry — rather than a mystery error.

We do **not** want: churn on every deploy, false-positive refreshes for commits that don't change the contract, deadlocks on recovery paths, or silent breakage of browser JS clients and long-lived SSE streams.

## Non-goals

To keep scope honest, the following are explicit non-goals:

- **Not covering SKILL.md drift as a rejection trigger.** SKILL.md changes cause behavioral drift but not outright failures. They propagate naturally as agents start new sessions or hit unrelated rejections. Chasing them with a dedicated hash creates false-positive churn for typo fixes and clarifications.
- **Not gating `/api/schema`, `/skill`, or `/updates/stream`.** The first two are the recovery targets; gating them deadlocks recovery. The third is a long-lived read-only stream that self-heals on deploy-restart.
- **Not forcing participation.** Missing `ClawClub-Schema-Seen` is tolerated forever. The value is in the explicit-mismatch path, not in punishing silence.
- **Not solving cross-instance ping-pong** during rolling deploys. Railway currently runs a single container; the handshake is robust under that model. If multi-instance is introduced later, brief inconsistencies across instances during rollout could cause one extra refresh cycle per agent. Acceptable.
- **Not adding structured fields to the error body.** All recovery information lives in `error.message` as prose.
- **Not hot-reloading SKILL.md or the schema.** Both are read at module load; `SCHEMA_HASH` is captured once at boot. Deploy restarts the process. No runtime invalidation.

## Final design

### Headers

Three headers, two concerns cleanly separated.

| Header | Direction | Purpose |
|---|---|---|
| `ClawClub-Version: <package.json version>` | Response (every response) | Observability only. Bumps on every commit per `CLAUDE.md`. **Never compared.** |
| `ClawClub-Schema-Hash: <schemaHash>` | Response (every response) | The value the handshake compares on. Changes only when `transport` or `actions` in the schema registry change. |
| `ClawClub-Schema-Seen: <schemaHash>` | Request (`POST /api` only) | The latest hash the agent has observed. Sent by participating agents. Missing is tolerated. |

### The hash is the existing `schemaHash`. Nothing new is computed.

`src/schema-endpoint.ts:193` already computes:

```ts
const hashInput = sortKeysDeep({ transport, actions });
const schemaHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 16);
```

This 16-char string:
- Is already in the `/api/schema` response body at `data.schemaHash`.
- Is already documented in `SKILL.md` as the per-session cache key.
- Covers exactly the contract surface whose drift causes real failures.
- Is stable across unrelated commits (test changes, dev scripts, internal refactors).
- Is stable across `package.json` version bumps.

We reuse it directly as the handshake comparison key. The server reads it once at boot:

```ts
const SCHEMA_HASH: string = getSchemaPayload().schemaHash;
```

One constant, computed once per process lifetime. No new module, no new file, no refactoring.

### Enforcement rules

**Scope:** Only `POST /api`. All other routes (`/api/schema`, `/skill`, `/updates/stream`, `/`, `OPTIONS`) are unaffected by the handshake — they emit the response headers but never reject on `ClawClub-Schema-Seen`.

**Placement:** The check runs in `src/server.ts` in the `POST /api` handler, immediately after the `Content-Type` gate passes and **before** `readJsonBody` is called. This ordering ensures:

1. Malformed bodies (`invalid_json`), oversized bodies (`payload_too_large`), and top-level-shape errors (`invalid_input`) cannot win over `stale_client`. If the client's cache is stale, they get told so — regardless of whether their request body would have parsed.
2. No side effects run. The check is long before `dispatcher.dispatch`, so no action ever executes with a stale client view.
3. No wasted work. Body parsing is skipped on mismatch.

**Check logic:**

```ts
const schemaSeen = request.headers['clawclub-schema-seen'];
if (typeof schemaSeen === 'string' && schemaSeen.length > 0 && schemaSeen !== SCHEMA_HASH) {
  throw new AppError(409, 'stale_client', STALE_CLIENT_MESSAGE);
}
```

**Behavior matrix:**

| Condition | Result |
|---|---|
| Header absent | Allowed through. Warn-only forever. No rejection. |
| Header present, empty string | Treated as absent. Allowed through. |
| Header present, matches `SCHEMA_HASH` | Allowed through. |
| Header present, does not match `SCHEMA_HASH` | Rejected: `409 Conflict`, `error.code = "stale_client"`, `error.message = STALE_CLIENT_MESSAGE`. |

### Status code: `409 Conflict`

Rejected alternatives:

- **`426 Upgrade Required`** — RFC 9110 §15.5.22 reserves this for HTTP protocol upgrades and requires the response to carry an `Upgrade` header. Not applicable.
- **`412 Precondition Failed`** — Defensible, but less common in this codebase's style.

`409 Conflict` (RFC 9110 §15.5.10) fits "resolvable state conflict" and matches the existing error-code style in the transport. The status is mostly a hint; clients will dispatch on `error.code = "stale_client"`.

### The error message is plain English, in `error.message`

We deliberately chose not to add structured fields (`currentSchemaHash`, `recoverySteps`) to the error envelope. The rationale, and the trade-offs, are in the "Decisions" section below.

The entire recovery protocol lives in `error.message` as prose the agent reads and follows literally:

```
The ClawClub API schema has changed since your agent last fetched it. Your cached schema is out of date, which can cause invalid_input errors and missing capabilities. To recover, do the following and then retry this request:

1. GET /api/schema and replace your cached schema.
2. GET /skill and replace your cached skill document.
3. Retry the original request.

Auto-retry is only safe for read-only actions or mutations that include a clientKey. For other mutations, confirm with the human before retrying so you do not duplicate a side effect.
```

This text is written so that an agent with **zero prior knowledge of the handshake** can recover from the error by reading the message alone. No reference to `stale_client`, no assumption that the agent knows about `ClawClub-Schema-Hash`. Just instructions.

A participating agent will additionally see the new `ClawClub-Schema-Hash` response header on its refetch of `/api/schema` and update its cache from there. That is one extra GET compared to including the hash in the error body. We do not care about this round-trip.

### CORS: `Access-Control-Expose-Headers`

Custom response headers are invisible to browser JavaScript unless listed in `Access-Control-Expose-Headers`. Currently `src/server.ts:368` sets only `access-control-allow-origin: *`, which is enough to *send* responses cross-origin but not enough to let JS read the new headers.

We add:

```
Access-Control-Expose-Headers: ClawClub-Version, ClawClub-Schema-Hash
```

Server-side agents (Node, Python, curl) do not care, but without this header any future browser-JS client silently fails to read the handshake values. Adding it now costs nothing and avoids a trap.

### SSE: headers must be added explicitly

The SSE path at `src/server.ts:437` calls `response.writeHead(200, { ... })` directly with a hard-coded headers object. It does **not** go through `writeCompressed` / `writeJson`. Any default response header added to the shared writers will silently miss the SSE path. We explicitly add `ClawClub-Version` and `ClawClub-Schema-Hash` to the SSE headers block.

We do **not** gate the SSE connect path on `ClawClub-Schema-Seen`. The stream is long-lived and read-only; gating it would kill sessions that self-heal on deploy-restart anyway. Per the scope rules above, only `POST /api` enforces.

## Decisions we made along the way and why

### Decision: reuse `schemaHash`, don't invent a new hash

**Earlier draft:** compute a new `contractHash = sha256(schemaHash + ':' + sha256(SKILL_MD_NORMALIZED))` at boot, where `SKILL_MD_NORMALIZED` is the served SKILL.md with the dynamic version line stripped.

**Why we cut it:**

- `schemaHash` already exists, is already served in the `/api/schema` body, and is already documented in `SKILL.md` as the session cache key. Inventing a second fingerprint is duplication.
- Gating on SKILL.md changes causes false-positive refreshes for typo fixes and clarifications. SKILL.md changes cause behavioral drift, not outright failures — agents still work, they just might not reflect the latest guidance. That drift propagates naturally on next session start.
- Schema changes (field rename, new action, type change) cause strictly-worse failures (`invalid_input`, missing capabilities). This is the failure mode the handshake exists to catch. `schemaHash` covers it exactly.
- Avoiding a new hash also avoids the entire import-graph problem (below). `schema-endpoint.ts` already owns `schemaHash`; `server.ts` just reads it.

**Trade-off accepted:** SKILL.md-only commits do not trigger refreshes. Agents will operate on stale SKILL.md guidance until they reconnect or hit an unrelated schema rejection. This is fine — the worst case is behavioral drift, not breakage.

### Decision: two separate response headers (`Version` and `Schema-Hash`)

**Earlier draft:** a single header carrying `package.json` version, used for both display and comparison.

**Why we split them:**

- `CLAUDE.md` requires a patch bump on every commit. Railway auto-deploys on every push to `main`. If the comparison key is `package.json` version, every deploy — even ones that touch only internals, tests, or unrelated files — forces every connected agent to refetch. Multiple times a day during active work.
- `package.json` version is useful for logs, `/` HTML, operator telemetry. Keeping it as a response header preserves that observability without coupling it to the rejection path.
- `schemaHash` is the right comparison key (see previous decision).

**Result:** `ClawClub-Version` is the human-observable version, `ClawClub-Schema-Hash` is the machine-comparable contract key. Orthogonal concerns, orthogonal headers.

### Decision: `409 Conflict`, not `426 Upgrade Required`

**Earlier draft:** use `426 Upgrade Required` on the semantic grounds that "the client needs to upgrade its contract version."

**Why we changed it:** RFC 9110 §15.5.22 defines `426` specifically for HTTP protocol upgrades (HTTP/1 → HTTP/2 etc.) and requires the response to include an `Upgrade` header. That is not what this is. The HTTP protocol is fine — the agent's cached *application-level* contract is stale.

`409 Conflict` (RFC 9110 §15.5.10) is defined as "the request could not be completed due to a conflict with the current state of the target resource" and explicitly anticipates that the client may be able to resolve the conflict and resubmit. That matches the semantics exactly.

`412 Precondition Failed` was also considered — framing `ClawClub-Schema-Seen` as a precondition is defensible — but `409` is more idiomatic and the error code (`stale_client`) is what agents will actually dispatch on.

### Decision: only gate `POST /api`

**Earlier draft considered:** gating `/updates/stream` at connect-time, and even `/api/schema` + `/skill`.

**Why we gate only `POST /api`:**

- **`/api/schema`** — gating it creates a recovery deadlock. The client fetches it *to recover*. If the server rejects the fetch because the client's hash is stale, there is no way out.
- **`/skill`** — same logic.
- **`/updates/stream`** — long-lived and read-only. It terminates naturally on deploy-restart (Railway restarts the process, streams die, agents reconnect). Gating at connect-time would kill sessions that are about to self-heal; gating mid-stream is impossible with SSE anyway. And stale streams read updates but don't mutate state, so they're strictly less dangerous than stale `POST /api` calls.
- **`GET /`** — the HTML landing page, never called by agents.
- **`OPTIONS`** — CORS preflight, no state.

Only `POST /api` actually mutates state, and it's the only place where a stale schema causes real failures. Gate it and nothing else.

### Decision: check runs *before* `readJsonBody`, not after

**Earlier draft:** place the check after body parse and top-level shape validation, reusing the existing validation flow.

**Why we moved it:** The product goal is "stale agents get `stale_client` instead of confusing errors." Placing the check after body parse means `payload_too_large`, `invalid_json`, and canonical-shape `invalid_input` errors can win first — defeating the goal for exactly the failure modes the handshake is supposed to clarify. A stale agent is quite likely to send a body that fails canonical-shape validation (field renamed, new required field missing); in that case we want to tell them their cache is stale, not that their payload is malformed.

Moving the check up by ~20 lines (after `Content-Type` gate, before `readJsonBody`) fixes this. It also skips unnecessary body parsing on mismatch.

**Minor cost accepted:** `stale_client` rejections do not have `action` available for logging, because the body isn't parsed yet. The error code itself is sufficient telemetry; this is a non-issue.

### Decision: no structured fields in the error body

**Earlier draft:** add `currentSchemaHash` and `recoverySteps` fields to the error envelope so participating agents can update their cache from the rejection alone (saving one round-trip).

**Why we cut it:**

- Adding fields to the error envelope requires extending `src/schemas/transport.ts` (`errorEnvelope`) and possibly `src/contract.ts` (`AppError`).
- The integration harness at `test/integration/harness.ts:416-422` `strictify`'s every error response, rejecting unknown keys. Extending the envelope means every integration test could break on the new field if fixtures are mis-updated. It is a real cost — not infinite, but non-trivial.
- The savings are one round-trip per rejection. The rejected agent is about to fetch `/api/schema` and `/skill` anyway. One extra GET is cheap.
- A participating agent will see `ClawClub-Schema-Hash` on the refetched `/api/schema` response header and cache it from there. No structured error field needed.

**By keeping `error.message` as the sole recovery channel:** zero schemas change, zero test fixtures change, zero AppError changes, zero transport.ts changes. Three-file implementation. The entire feature becomes additive in the simplest possible way.

**Trade-off accepted:** Non-participating agents (those not yet echoing `ClawClub-Schema-Seen`) get the exact same message as participating ones. That's fine — the message is self-contained and tells them what to do regardless of whether they were part of the handshake.

### Decision: missing header is tolerated forever (not just during rollout)

**Earlier draft:** treat tolerance as a temporary rollout phase, flip to strict enforcement after a release cycle.

**Why we keep tolerance permanent:**

- There is no value in rejecting an agent that doesn't participate. A non-participating agent will hit `invalid_input` on a drifted field soon enough, which is a louder and more useful error signal than `stale_client` on a client that never opted in.
- Strict enforcement breaks every external client on the day of the flip, including well-behaved clients that simply haven't been updated yet.
- Keeping it warn-only forever means the feature is purely additive: agents that opt in get cleaner errors on schema drift; agents that don't get exactly the status quo.

### Decision: hash read once at module load, not lazily

**Consideration:** Is `getSchemaPayload()` safe to call at `server.ts` module-load time?

- `src/server.ts:8` imports `buildDispatcher` from `./dispatch.ts`.
- `./dispatch.ts` transitively imports all schema-registration modules via side effects.
- Those imports complete before `server.ts`'s top-level constants execute.
- `getSchemaPayload()` reads the registry lazily inside `buildSchema()`; by the time we call it at module-load, the registry is fully populated.

**We'll verify this with a `npm run test:unit` run after wiring it in.** If there's any load-order surprise, the trivial fallback is to compute `SCHEMA_HASH` lazily on first request instead of at module load. Either placement is fine; module-load is simpler and cheaper.

### Decision: no new module, no refactor

**Earlier draft:** extract a new `src/contract-fingerprint.ts` module owning `PACKAGE_VERSION`, normalized SKILL.md text, and hash helpers, to avoid an import cycle between `server.ts` and `schema-endpoint.ts`.

**Why we cut it:** the cycle concern only existed because an earlier draft had `schema-endpoint.ts` computing `contractHash` using `SKILL_MD_BODY` from `server.ts`. Now that we reuse the existing `schemaHash` directly, there is no new computation, no cycle, and no need for a shared module. `server.ts` reads `schemaHash` from `schema-endpoint.ts` (same direction as today's `getSchemaPayload` import).

A pre-existing minor duplication remains: both `server.ts:14` and `schema-endpoint.ts:23` read `package.json` independently. This is unrelated to the handshake and we are **explicitly not** cleaning it up as part of this change. Scope discipline.

## Implementation plan

Three files. In order:

### 1. `src/server.ts`

Five edits, all additive.

**Edit A — capture the hash at module load.** After line 34 (after `SKILL_MD` is assembled), add:

```ts
const SCHEMA_HASH: string = getSchemaPayload().schemaHash;
```

This line must come after the existing `getSchemaPayload` import at line 12 and after `SKILL_MD` is built (so it can share the same module-load-time block).

The prose `STALE_CLIENT_MESSAGE` is also declared here as a top-level `const`, so the `POST /api` handler can reference it by name:

```ts
const STALE_CLIENT_MESSAGE = `The ClawClub API schema has changed since your agent last fetched it. Your cached schema is out of date, which can cause invalid_input errors and missing capabilities. To recover, do the following and then retry this request:

1. GET /api/schema and replace your cached schema.
2. GET /skill and replace your cached skill document.
3. Retry the original request.

Auto-retry is only safe for read-only actions or mutations that include a clientKey. For other mutations, confirm with the human before retrying so you do not duplicate a side effect.`;
```

**Edit B — add headers to `writeCompressed` defaults.** In the `headers` object at line 201:

```ts
const headers: Record<string, string> = {
  'content-type': contentType,
  'x-content-type-options': 'nosniff',
  'clawclub-version': PACKAGE_VERSION,
  'clawclub-schema-hash': SCHEMA_HASH,
  ...extraHeaders,
};
```

This single change covers: `writeJson` (line 219, delegates to `writeCompressed`), the schema endpoint response (line 545), the SKILL.md response (line 559), the root HTML response (line 574), the 404 response (line 579), the 415 response (line 592), all `POST /api` success responses (line 648), and all `POST /api` error responses (line 654 / 666).

**Edit C — add headers to the SSE `writeHead` block.** At line 437, the SSE path writes headers directly:

```ts
response.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-cache, max-age=0',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'clawclub-version': PACKAGE_VERSION,
  'clawclub-schema-hash': SCHEMA_HASH,
});
```

This path bypasses `writeCompressed` and must be updated explicitly.

**Edit D — extend CORS.** At line 368:

```ts
response.setHeader('access-control-allow-origin', '*');
response.setHeader('access-control-expose-headers', 'ClawClub-Version, ClawClub-Schema-Hash');
```

The existing preflight block at line 371-376 does not need changes — `access-control-allow-headers: *` already permits the client to send `ClawClub-Schema-Seen`. We do not need to add `ClawClub-Version` or `ClawClub-Schema-Hash` to the OPTIONS 204 body itself; the expose-headers list in the preflight response is what actually lets the browser read those headers on subsequent responses.

**Edit E — the mismatch check in `POST /api`.** In the `POST /api` handler, after the `Content-Type` gate passes at line 600 and **before** `readJsonBody` is called at line 602:

```ts
const schemaSeen = request.headers['clawclub-schema-seen'];
if (typeof schemaSeen === 'string' && schemaSeen.length > 0 && schemaSeen !== SCHEMA_HASH) {
  throw new AppError(409, 'stale_client', STALE_CLIENT_MESSAGE);
}
```

The throw lands in the existing `catch (error)` block at line 652, which already serializes `AppError` into the standard error envelope at line 654-661. No changes to `AppError` or the error writer.

### 2. `SKILL.md`

One new short subsection added under "How to connect," after the existing schema-cache paragraph at line 22. It tells participating agents:

1. The server emits `ClawClub-Schema-Hash` on every response.
2. Cache the latest value seen, and send it as `ClawClub-Schema-Seen` on every `POST /api`.
3. On `409 stale_client`, read `error.message` and follow it literally.
4. Cross-reference the existing `clientKey` guidance at line 125 as the retry-safety rule: only auto-retry actions that are either read-only or idempotent via `clientKey`.

Missing header is explicitly described as tolerated — participation is opt-in and adds value on mismatch, not on silence.

Exact wording of the new paragraph (to be inserted after the existing schema-cache line):

> **Contract handshake.** Every response includes a `ClawClub-Schema-Hash` header. Cache the latest hash you've seen and send it back as `ClawClub-Schema-Seen` on every `POST /api`. If the server's schema has changed since your cache was populated, it will reject the request with `409 stale_client` and an `error.message` that tells you exactly what to do — read it literally and follow the steps in order. Auto-retry is only safe for read-only actions or mutations that include a `clientKey` (see "Common surprises" below). For other mutations, confirm with the human before retrying so you do not duplicate a side effect. Sending the header is opt-in — omitting it is tolerated — but participating agents get clean, actionable errors when the schema drifts instead of confusing `invalid_input` responses.

### 3. `package.json`

Patch version bump per the `CLAUDE.md` hard rule. Currently `0.2.18` → `0.2.19`.

## What does not change

- **`src/schema-endpoint.ts`** — untouched. `schemaHash` is already computed and already in the `/api/schema` body.
- **`src/schemas/transport.ts`** — untouched. `errorEnvelope` already accepts `{ok:false, error:{code, message}}`, which is all we emit.
- **`src/contract.ts`** — untouched. `AppError(statusCode, code, message)` already supports our call.
- **`db/init.sql`, `db/migrations/`** — no database changes.
- **`test/snapshots/api-schema.json`** — the `/api/schema` body is unchanged, so no snapshot regeneration.
- **`test/integration/harness.ts`** — the harness does not send `ClawClub-Schema-Seen`, so missing-header-tolerance keeps all existing tests passing unchanged.
- **All existing test fixtures** — no updates.

## Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `getSchemaPayload()` at module load hits a load-order bug | Low | Verify with `npm run test:unit` after wiring. Fallback: compute lazily on first request. |
| Existing tests assert strict header sets that break with new additions | Low | Verified: unit tests only check `content-type`; integration harness `strictify`s response bodies not headers; snapshot test diffs `/api/schema` body only. No known strict header assertions. |
| Integration harness rejects new error envelope fields | N/A | We are adding zero new fields. `errorEnvelope` is unchanged. |
| SSE path silently misses new headers | Medium | Explicit edit to the SSE `writeHead` block (Edit C). Manual test: connect stream, inspect response headers. |
| Browser JS can't read the new response headers | Low (no browser JS clients today) | `Access-Control-Expose-Headers` added in Edit D. |
| Header casing bug (`clawclub-schema-seen` vs `ClawClub-Schema-Seen`) | Low | Node.js HTTP normalizes request headers to lowercase. Existing code at `src/server.ts:151` reads `request.headers.authorization` as lowercase. Same convention. |
| Missing-header tolerance gets accidentally flipped to strict in a future refactor | Low | Documented as permanent design in this plan and in `SKILL.md`. |
| Stale client auto-retries a non-idempotent mutation after refresh and double-posts | Medium | `SKILL.md` paragraph explicitly says auto-retry is only safe for read-only or `clientKey`-guarded actions. Aligns with existing `clientKey` documentation. |
| Rolling deploys briefly run multiple server instances with different hashes | Low (single container on Railway today) | Known limitation. Would cause one extra refresh cycle per agent during rollout. Re-evaluate if multi-instance lands. |
| Gzip path interacts with the new headers | None | Headers are set in the `headers` object before `response.writeHead` is called; gzip branch at line 207 adds `content-encoding` and `vary` to the same object. No interaction. |

## Tests to add

Because the plan is purely additive and the existing test suite does not exercise these headers, we should add minimal coverage explicitly for the new behavior. None of these are required for the feature to work — existing tests all pass unchanged — but they would prevent regressions.

**Unit (`test/unit/server.test.ts`), new cases:**

1. `POST /api` with matching `ClawClub-Schema-Seen` → 200, normal dispatch.
2. `POST /api` with missing `ClawClub-Schema-Seen` → 200, normal dispatch (missing-header tolerance).
3. `POST /api` with empty-string `ClawClub-Schema-Seen` → 200 (treated as missing).
4. `POST /api` with mismatched `ClawClub-Schema-Seen` → 409, `error.code === 'stale_client'`, `error.message` contains the literal substrings `"GET /api/schema"` and `"GET /skill"` (so nobody accidentally waters the message down in a future refactor).
5. `ClawClub-Version` present on a variety of response types (`GET /`, `GET /skill`, `GET /api/schema`, `POST /api` success, `POST /api` error, `OPTIONS`).
6. `ClawClub-Schema-Hash` present on the same set.
7. SSE `response.headers` contains both `ClawClub-Version` and `ClawClub-Schema-Hash`.
8. `OPTIONS` preflight response contains `Access-Control-Expose-Headers: ClawClub-Version, ClawClub-Schema-Hash`.
9. `GET /api/schema` with mismatched `ClawClub-Schema-Seen` still returns 200 (not gated — this is a recovery path).
10. `GET /updates/stream` with mismatched `ClawClub-Schema-Seen` still connects successfully (not gated).

**Integration smoke (`src/http-smoke.ts`):**

11. Read `ClawClub-Schema-Hash` from the first response, send it as `ClawClub-Schema-Seen` on a subsequent `POST /api`, assert 200.
12. Send a deliberately wrong `ClawClub-Schema-Seen`, assert 409 + `stale_client` + the prose message.

**Integration (`test/integration/non-llm/smoke.test.ts`):**

13. Optional: one end-to-end case exercising the same flow through the real harness, not the unit-test fake.

## Acceptance checklist

Before marking the feature shipped:

- [ ] `SCHEMA_HASH` is read once at module load and matches the value in `/api/schema` body.
- [ ] `ClawClub-Version` appears on every HTTP response (including SSE, 404, 415, and error responses).
- [ ] `ClawClub-Schema-Hash` appears on every HTTP response (including SSE, 404, 415, and error responses).
- [ ] `Access-Control-Expose-Headers` lists both headers on the main CORS response.
- [ ] `POST /api` with matching `ClawClub-Schema-Seen` succeeds.
- [ ] `POST /api` with missing `ClawClub-Schema-Seen` succeeds (tolerance).
- [ ] `POST /api` with mismatched `ClawClub-Schema-Seen` returns 409 with `error.code = "stale_client"` and the full prose message.
- [ ] The rejection happens before `readJsonBody` runs — no side effects, no `invalid_json` or `payload_too_large` errors winning over `stale_client`.
- [ ] `/api/schema`, `/skill`, and `/updates/stream` never reject on mismatch.
- [ ] `SCHEMA_HASH` does not change when only `package.json` version bumps (verified by reading `schemaHash` before and after a patch bump without schema changes).
- [ ] `SCHEMA_HASH` changes when an action is added, renamed, or has its input/output schema modified.
- [ ] `SKILL.md` documents the handshake and explicitly references the `clientKey` retry-safety rule.
- [ ] All existing tests pass with zero fixture updates.
- [ ] New test coverage for match/missing/mismatch/SSE/OPTIONS lands.
- [ ] `http-smoke.ts` exercises both the success and the mismatch paths.
- [ ] `package.json` patch version bumped.
- [ ] `CLAUDE.md` and `SKILL.md` remain consistent on the schema-cache semantics (no contradictions between the existing `schemaHash` guidance and the new handshake paragraph).

## Order of operations during implementation

1. Edit `src/server.ts` (all five edits in one pass).
2. Run `npm run check` (type check) and `npm run test:unit` to verify module-load order and that nothing existing breaks.
3. Edit `SKILL.md` to add the new paragraph.
4. Bump `package.json`.
5. Add the new unit tests.
6. Add the `http-smoke` handshake cases.
7. Run the full test suite (`npm run test:integration:non-llm` at minimum; full suite if changes are close to dispatch).
8. Commit.

## Open questions to verify before / during implementation

1. **Module-load safety of `getSchemaPayload()`.** Confirmed with `npm run test:unit` after Edit A. If it fails, switch to lazy computation (first-request initialization with a cached `SCHEMA_HASH` closed over `createServer`).

2. **Error code naming.** `stale_client` is proposed. Alternatives considered: `stale_schema`, `schema_changed`, `outdated_client`. `stale_client` is the clearest because the problem is the client's cache, not the schema itself (which is current). Unless convention in the codebase demands otherwise, keep `stale_client`.

3. **Whether to add `stale_client` to any canonical error-code list.** `src/schema-endpoint.ts:139-153` contains a `transportErrorCodes` array returned in `/api/schema`. We should add `{ code: 'stale_client', status: 409 }` to this list so agents that read the schema see the code documented alongside `invalid_input`, `rate_limited`, etc. This is a tiny edit but does touch `schema-endpoint.ts` — which we claimed we wouldn't modify. The edit is a one-line addition to an existing static array and does not affect `schemaHash` computation (the hash covers the `transport` block which includes this array, so `schemaHash` will change on first deploy of this feature — which is correct: agents with cached schemas from before this feature existed should refresh once). Acceptable.

4. **Header name canonicalization on send vs receive.** Node writes headers as provided, but receives them lowercased. We send `'clawclub-version'` lowercase for consistency with existing headers in the codebase (`'x-content-type-options'`, `'cache-control'`, etc.) and read via `request.headers['clawclub-schema-seen']` (already lowercase). Documentation and `Access-Control-Expose-Headers` use the capitalized form (`ClawClub-Version`) because that's how they'll be displayed to humans and in CORS metadata. HTTP headers are case-insensitive so both work; we just need internal consistency.

## Amendment to "what does not change"

One clarification from Open Question 3 above: `src/schema-endpoint.ts` gets a **one-line** addition to the `transportErrorCodes` array so `stale_client` is documented alongside the other transport errors. This will cause `schemaHash` itself to change on the deploy that introduces this feature (because the hash covers the `transport` block). That is the *correct* behavior: every agent currently holding a pre-feature cache should refresh once on first `POST /api` after the deploy. A clean, self-documenting rollout.

So the accurate count is: **four files** — `src/server.ts`, `src/schema-endpoint.ts` (one line), `SKILL.md`, `package.json`. Still no new modules, no refactors, no schema-type changes, no fixture updates.
