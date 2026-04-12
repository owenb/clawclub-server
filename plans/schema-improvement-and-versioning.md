# Schema Behavior Metadata + Stale-Client Handshake

## Status

Design finalized. Combined plan that rolls two related changes into a single pass, because they share files (`src/schema-endpoint.ts`, `SKILL.md`, `package.json`, the schema snapshot) and because together they form a coherent "contract refresh" story: the schema gains real behavior metadata, and clients get a clean signal when that contract drifts.

## What we are doing and why

### Two changes, one pass

**Change 1 — Schema behavior metadata.** The generated `/api/schema` carries the wire contract but only thin behavioral guidance. `SKILL.md` carries the rest by hand. That split lets server-authoritative facts drift (business error codes, scope rules, non-obvious gotchas) because the code and the markdown can move independently. We fix it by adding three small, typed fields to `ActionDefinition` and populating them on the highest-value actions.

**Change 2 — Stale-client handshake.** After a deploy that changes the agent-facing contract, an agent holding a cached schema silently operates on stale information. Failures show up as `invalid_input` on a renamed field or "missing capability" on a new action, with no signal that the cache is the real problem. We fix it by exposing `schemaHash` as a response header and letting clients echo it back; on mismatch, the server rejects with a clean `409 stale_client` and a prose recovery message.

### Why combine them

1. Both changes touch `src/schema-endpoint.ts`, `SKILL.md`, `package.json`, and `test/snapshots/api-schema.json`. One pass means one snapshot regeneration and one version bump.
2. Change 1 *will* change `schemaHash`. That is exactly the event Change 2 exists to handle. Shipping them together gives a self-documenting first rollout: every existing agent gets a clean refresh signal the moment the new schema metadata lands.
3. The SKILL.md edit is coherent: we add the handshake paragraph, trim the action menu and pure-server-truth "Common surprises" bullets, and leave the client-behavior sections alone — all in one editing pass.

### Scope boundary we are holding

We are **narrowly scoped** on the metadata side. We are not introducing a large typed metadata hierarchy, not moving workflows into JSON, not moving clarification heuristics into the server contract. Three optional fields on `ActionDefinition`, nothing more:

- `businessErrors?: Array<{ code: string; meaning: string; recovery: string }>`
- `scopeRules?: string[]`
- `notes?: string[]`

Plus richer prose descriptions where existing ones are thin. That is the entire metadata surface change. Everything about client UX, tone, privacy, workflows, and clarification heuristics stays in `SKILL.md`.

## Non-goals

- Not encoding clarification heuristics (`clarifyBeforeCall`), workflows, or client-side UX as structured server metadata.
- Not exposing internal quality-gate prompt text.
- Not gating `/api/schema`, `/skill`, or `/updates/stream` on the handshake (all three are recovery-adjacent; gating them deadlocks recovery).
- Not forcing handshake participation. Missing `ClawClub-Schema-Seen` is tolerated forever.
- Not adding structured fields to the error envelope. All stale-client recovery info lives in `error.message` as prose.
- Not chasing SKILL.md drift with a dedicated hash. SKILL.md changes cause behavioral drift, not outright failures; they propagate naturally.
- Not hot-reloading schema or skill. Both are captured at module load.
- Not rewriting SKILL.md top-to-bottom. We trim specific sections and add one paragraph.

## Final design

### Part A — Schema behavior metadata

**New fields on `ActionDefinition`** (in `src/schemas/registry.ts`):

```ts
export type SchemaBusinessError = {
  code: string;
  meaning: string;
  recovery: string;
};

export type ActionDefinition = {
  // ... existing fields ...
  businessErrors?: SchemaBusinessError[];
  scopeRules?: string[];
  notes?: string[];
};
```

All three are optional. Actions that do not need them simply omit them and nothing appears in the schema payload for that action. No empty arrays, no null placeholders.

**Schema endpoint passthrough** (in `src/schema-endpoint.ts`):

The existing `SchemaAction` type gets three optional fields with identical shape. When assembling `actions[]`, pass them through from the registry when present:

```ts
const action: SchemaAction = {
  action: def.action,
  domain: def.domain,
  description: def.description,
  auth: def.auth,
  safety: def.safety,
  ...(def.authorizationNote ? { authorizationNote: def.authorizationNote } : {}),
  ...(def.businessErrors ? { businessErrors: def.businessErrors } : {}),
  ...(def.scopeRules ? { scopeRules: def.scopeRules } : {}),
  ...(def.notes ? { notes: def.notes } : {}),
  input: inputJsonSchema,
  output: outputJsonSchema,
};
```

Deterministic key order is already handled by `sortKeysDeep` inside `schemaHash` computation — the new fields flow through that path unchanged.

### Part B — Handshake headers

Three headers, two concerns cleanly separated.

| Header | Direction | Purpose |
|---|---|---|
| `ClawClub-Version: <package.json version>` | Response (every response) | Observability only. Bumps on every commit per `CLAUDE.md`. **Never compared.** |
| `ClawClub-Schema-Hash: <schemaHash>` | Response (every response) | The value the handshake compares on. Changes only when `transport` or `actions` in the schema registry change. |
| `ClawClub-Schema-Seen: <schemaHash>` | Request (`POST /api` only) | The latest hash the agent has observed. Sent by participating agents. Missing is tolerated. |

**The hash is the existing `schemaHash`.** Nothing new is computed. `src/schema-endpoint.ts` already produces a 16-char truncated SHA256 over `sortKeysDeep({ transport, actions })`. The server reads it once at boot:

```ts
const SCHEMA_HASH: string = getSchemaPayload().schemaHash;
```

One constant, computed once per process lifetime. Because Part A adds fields under `actions[]`, the hash value will differ from the current production hash on first deploy — which is the correct "self-documenting rollout" behavior: every previously-cached agent sees a mismatch and refreshes once.

### Enforcement rules

**Scope:** Only `POST /api`. `/api/schema`, `/skill`, `/updates/stream`, `GET /`, and `OPTIONS` are unaffected by the handshake — they emit the response headers but never reject on `ClawClub-Schema-Seen`.

**Placement:** The check runs in the `POST /api` handler, immediately after the `Content-Type` gate passes and **before** `readJsonBody` is called. This ordering ensures:

1. Malformed bodies (`invalid_json`), oversized bodies (`payload_too_large`), and canonical-shape `invalid_input` errors cannot win over `stale_client`. A stale agent is exactly the kind of client likely to send a body that fails shape validation (field renamed, new required field missing), and the goal is to tell them their cache is stale, not that their payload is malformed.
2. No side effects run. The check is long before `dispatcher.dispatch`.
3. No wasted body parsing on mismatch.

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
| Header absent | Allowed through (tolerance is permanent, not a rollout phase). |
| Header present, empty string | Treated as absent. Allowed through. |
| Header present, matches `SCHEMA_HASH` | Allowed through. |
| Header present, does not match | `409 Conflict`, `error.code = "stale_client"`, `error.message = STALE_CLIENT_MESSAGE`. |

### Status code: `409 Conflict`

`426 Upgrade Required` is reserved for HTTP protocol upgrades and requires an `Upgrade` header. `409 Conflict` matches "resolvable state conflict" semantics and is more idiomatic in this codebase. Clients will dispatch on `error.code`, not status.

### Error message: plain English prose, no structured fields

The entire recovery protocol lives in `error.message`. No new fields on the error envelope, no `recoverySteps` array. One prose string that a zero-context agent can follow literally:

```
The ClawClub API schema has changed since your agent last fetched it. Your cached schema is out of date, which can cause invalid_input errors and missing capabilities. To recover, do the following and then retry this request:

1. GET /api/schema and replace your cached schema.
2. GET /skill and replace your cached skill document.
3. Retry the original request.

Auto-retry is only safe for read-only actions or mutations that include a clientKey. For other mutations, confirm with the human before retrying so you do not duplicate a side effect.
```

Keeping recovery in `error.message` means zero changes to `src/schemas/transport.ts`, `src/contract.ts`'s `AppError`, or the integration harness's `strictify` on error envelopes. Purely additive.

### CORS: `Access-Control-Expose-Headers`

Custom response headers are invisible to browser JavaScript unless explicitly exposed. We add:

```
Access-Control-Expose-Headers: ClawClub-Version, ClawClub-Schema-Hash
```

Server-side clients don't care, but this avoids a silent trap for any future browser-JS client.

### SSE path must be updated explicitly

The SSE handler calls `response.writeHead(200, { ... })` directly with a hard-coded headers object and does **not** go through the shared `writeCompressed`/`writeJson` writers. Any default header added to those writers silently misses the SSE path. We explicitly add `ClawClub-Version` and `ClawClub-Schema-Hash` to the SSE headers block.

We do **not** gate the SSE connect path on `ClawClub-Schema-Seen`. Streams are long-lived and read-only and self-heal on deploy-restart.

### `stale_client` in `transportErrorCodes`

`src/schema-endpoint.ts` contains a static `transportErrorCodes` array returned as part of the `transport` block. We add `{ code: 'stale_client', status: 409, meaning: '...' }` to it so agents that read the schema see the new code documented alongside `invalid_input`, `rate_limited`, etc. This contributes to the `schemaHash` change on first deploy — correct behavior.

## What populates first (metadata)

Populate guidance fields on the highest-value actions only. Do not try to fill every action. Missing fields are fine.

### session.*

- `session.getContext`
  - `notes`: `["Useful session info lives in the response envelope's actor block, not in data."]`
  - Richer description if the current one is thin.

### messages.*

- `messages.send`
  - `scopeRules`:
    - `"DMs are not club-scoped. Do not ask the user to pick a club before calling messages.send."`
    - `"The shared-club requirement is only an eligibility check, not a scope constraint on the thread."`
  - `notes`: `["clientKey scope is per-member global, not per-club."]`

### content.*

- `content.create`
  - `businessErrors`:
    - `{ code: "quota_exceeded", meaning: "Member has hit the unified daily content quota.", recovery: "Inform the user and try again later. Check quotas.getUsage for remaining budget." }`
    - `{ code: "illegal_content", meaning: "Content failed the legality gate.", recovery: "Relay the reason to the user, help them revise, and resubmit." }`
    - `{ code: "gate_unavailable", meaning: "The legality gate is temporarily unavailable.", recovery: "Retry with exponential backoff up to a small number of attempts; surface the failure if it persists." }`
  - `notes`:
    - `"Publishes immediately. There is no draft-save state."`
    - `"Private 1:1 communication belongs on messages.send, not content.create."`

- `content.update` — same `businessErrors` shape.
- `content.remove` — no businessErrors needed; minimal.

### events.*

- `events.create`
  - `businessErrors`: same legality-gate triple as `content.create` where applicable.
  - `scopeRules`: `clubId` semantics if they differ from content.

### admissions.public.* (cold path)

- `admissions.public.requestChallenge`
  - `notes`: anything about challenge lifetime that isn't already in the existing rich description.

- `admissions.public.submitApplication`
  - `businessErrors`:
    - `{ code: "needs_revision", meaning: "The application did not clear the completeness gate, but the challenge is still valid.", recovery: "Patch only the items named in feedback and resubmit against the same challengeId. Do not request a new challenge." }`
    - `{ code: "attempts_exhausted", meaning: "Maximum submission attempts reached for this challenge.", recovery: "Request a new challenge and start over." }`
    - `{ code: "challenge_expired", meaning: "The challenge expired before submission.", recovery: "Request a new challenge." }`
    - `{ code: "invalid_proof", meaning: "The proof-of-work did not validate.", recovery: "Re-solve the PoW against the challenge and resubmit." }`
    - `{ code: "challenge_consumed", meaning: "The challenge has already been accepted.", recovery: "Stop retrying. The admission is final." }`
    - `{ code: "gate_unavailable", meaning: "The legality gate is temporarily unavailable.", recovery: "Retry with backoff; surface the failure if it persists." }`
  - `notes`: `["When status is accepted, the server's message field should be relayed to the user verbatim."]`

### admissions.sponsorCandidate

- `businessErrors`: include `gate_unavailable` and any sponsor-specific rejection codes that exist.
- `notes`: `["Sponsor reasons should be concrete and firsthand; generic or fabricated reasons will be rejected by the gate."]`

### vouches.*

- `vouches.create`
  - `businessErrors`:
    - `{ code: "self_vouch", meaning: "A member cannot vouch for themselves.", recovery: "Not retryable. Do not prompt the user." }`
    - `{ code: "duplicate_vouch", meaning: "This vouch already exists.", recovery: "Not retryable; treat the existing vouch as the canonical record." }`
    - `{ code: "gate_unavailable", meaning: "The quality gate is temporarily unavailable.", recovery: "Retry with backoff." }`
  - `notes`: `["Reasons should be specific and firsthand. Generic reasons will be rejected."]`

### profile.update

- `businessErrors`: legality/quality gate codes, same pattern.

### clubadmin.*

- Every `clubadmin.*` action with club scope:
  - `scopeRules`: `["clubadmin actions require an explicit clubId. The server does not infer it from session context."]`

### quotas.getUsage

- `notes`: default quota values and the clubadmin/owner multiplier if still accurate, stated concisely.

### updates.*

- `notes`: anything non-obvious about cursor semantics or stream resumption that isn't already in the description.

## What changes in `SKILL.md`

### Sections to remove or heavily trim

- **"Available actions"** — replace with one line: "The server emits a machine-readable action inventory at `GET /api/schema`. Always fetch it first; never rely on cached knowledge of action names."
- **"Common surprises" bullets that are pure server truth** — e.g., "`session.getContext` returns `data: {}` but actor is in the envelope", "`clientKey` is per-member global", "`needs_revision` means the challenge is still valid". These now live in `notes` on the relevant actions. Remove from SKILL.md.
- **"`clubId` behavior"** — replace with a one-line pointer: "Per-action `clubId` semantics are documented in each action's `scopeRules` in the schema."
- **Default quotas** — now lives in `quotas.getUsage.notes`. Remove the duplicate from SKILL.md.

### Sections to keep unchanged

- How to connect (base URL, bearer token)
- "Fetch schema first" as a client workflow requirement
- "How someone joins a club" — the full admissions playbook and PoW solver reference implementation. This is procedural client behavior; prose is the right format.
- "When to clarify first" — client-side UX heuristics, DM-vs-public disambiguation.
- Agent behavior, privacy posture, tone, response style.
- Club awareness, membership privacy rules, interaction patterns.

### Section to add

A new short subsection under "How to connect," after the existing schema-cache paragraph:

> **Contract handshake.** Every response includes a `ClawClub-Schema-Hash` header. Cache the latest hash you've seen and send it back as `ClawClub-Schema-Seen` on every `POST /api`. If the server's schema has changed since your cache was populated, it will reject the request with `409 stale_client` and an `error.message` that tells you exactly what to do — read it literally and follow the steps in order. Auto-retry is only safe for read-only actions or mutations that include a `clientKey`. For other mutations, confirm with the human before retrying so you do not duplicate a side effect. Sending the header is opt-in — omitting it is tolerated — but participating agents get clean, actionable errors when the schema drifts instead of confusing `invalid_input` responses.

## Implementation plan

### 1. `src/schemas/registry.ts`

Add the `SchemaBusinessError` type and extend `ActionDefinition` with three optional fields. Keep them together in the public metadata region of the type definition, not mixed into the wire/parse/handle internals.

### 2. `src/schema-endpoint.ts`

Three edits:

**Edit A — extend `SchemaAction`** with `businessErrors?`, `scopeRules?`, `notes?` (same shapes as on `ActionDefinition`).

**Edit B — pass the fields through** when building `actions[]`. Use conditional spread so missing fields don't serialize as `undefined`.

**Edit C — add `stale_client` to `transportErrorCodes`.** One line:

```ts
{ code: 'stale_client', status: 409, meaning: 'The client\'s cached schema is out of date. Refetch /api/schema and /skill, then retry.' },
```

Do not touch `schemaHash` computation logic — the new action fields and new transport error code flow through `sortKeysDeep` unchanged, and the hash will naturally update. That is the intended behavior.

### 3. Populate metadata in schema modules

For each module listed in "What populates first," add `businessErrors`, `scopeRules`, `notes` to the action definitions where applicable. Files:

- `src/schemas/session.ts`
- `src/schemas/messages.ts` (or wherever `messages.send` is defined)
- `src/schemas/entities.ts` (content.*)
- `src/schemas/events.ts`
- `src/schemas/admissions-cold.ts`
- `src/schemas/membership.ts` (admissions.sponsorCandidate, vouches.*)
- `src/schemas/profile.ts`
- `src/schemas/clubadmin.ts`
- `src/schemas/quotas.ts` (wherever `quotas.getUsage` lives)
- `src/schemas/updates.ts`

While in these files, also enrich any action descriptions that are visibly thinner than the admissions-cold.ts style. Keep descriptions to one or two sentences; put behavioral depth in `notes`/`businessErrors`/`scopeRules`.

### 4. `src/server.ts`

Five edits, all additive.

**Edit A — capture the hash and message at module load.** After the existing `SKILL_MD` assembly block, add:

```ts
const SCHEMA_HASH: string = getSchemaPayload().schemaHash;

const STALE_CLIENT_MESSAGE = `The ClawClub API schema has changed since your agent last fetched it. Your cached schema is out of date, which can cause invalid_input errors and missing capabilities. To recover, do the following and then retry this request:

1. GET /api/schema and replace your cached schema.
2. GET /skill and replace your cached skill document.
3. Retry the original request.

Auto-retry is only safe for read-only actions or mutations that include a clientKey. For other mutations, confirm with the human before retrying so you do not duplicate a side effect.`;
```

`getSchemaPayload` is already imported. The constant must execute after schema-module side effects complete (they do, via transitive imports through `./dispatch.ts`). Verify with `npm run test:unit` — fallback is lazy init on first request.

**Edit B — add headers to `writeCompressed` defaults.** In the shared headers object inside `writeCompressed`:

```ts
const headers: Record<string, string> = {
  'content-type': contentType,
  'x-content-type-options': 'nosniff',
  'clawclub-version': PACKAGE_VERSION,
  'clawclub-schema-hash': SCHEMA_HASH,
  ...extraHeaders,
};
```

This single change propagates through `writeJson`, the schema endpoint, the skill endpoint, the root HTML, the 404/415 responses, and all `POST /api` success and error responses.

**Edit C — add headers to the SSE `writeHead` block.** The SSE path writes headers directly and bypasses the shared writers. Add `'clawclub-version': PACKAGE_VERSION` and `'clawclub-schema-hash': SCHEMA_HASH` to that block explicitly.

**Edit D — extend CORS expose.** Alongside the existing `access-control-allow-origin: *`:

```ts
response.setHeader('access-control-expose-headers', 'ClawClub-Version, ClawClub-Schema-Hash');
```

The preflight `access-control-allow-headers: *` already permits clients to send `ClawClub-Schema-Seen`, so no additional preflight edit is needed.

**Edit E — the mismatch check in `POST /api`.** After the `Content-Type` gate passes and **before** `readJsonBody` is called:

```ts
const schemaSeen = request.headers['clawclub-schema-seen'];
if (typeof schemaSeen === 'string' && schemaSeen.length > 0 && schemaSeen !== SCHEMA_HASH) {
  throw new AppError(409, 'stale_client', STALE_CLIENT_MESSAGE);
}
```

Placement matters: this must run before body parsing so that malformed / oversized / canonical-shape-invalid bodies cannot win over `stale_client`. The throw lands in the existing `catch (error)` block which already serializes `AppError` into the standard error envelope — no changes to `AppError` or the error writer.

### 5. `SKILL.md`

One editing pass with four kinds of change:

1. **Insert** the contract-handshake paragraph under "How to connect," after the existing schema-cache paragraph.
2. **Remove** the "Available actions" inventory and replace with a one-line pointer to `/api/schema`.
3. **Remove** or trim "Common surprises" bullets that are pure server truth now living in `notes`:
   - `session.getContext` envelope/data split
   - `clientKey` per-member global scope
   - `needs_revision` challenge-not-consumed semantics
   - Anything else that now has a home in `notes`/`businessErrors`/`scopeRules`.
4. **Remove** the "Default quotas" and "`clubId` behavior" sections, replaced by short pointers to the schema.

Do not touch:
- "How someone joins a club" (full admissions playbook, PoW solver code)
- "When to clarify first"
- Agent behavior, privacy, tone, response style
- Club awareness, membership privacy rules, interaction patterns

### 6. `package.json`

Bump patch version once (e.g. `0.2.18` → `0.2.19`). Both changes land in a single commit; one bump.

### 7. `test/snapshots/api-schema.json`

Will need regeneration. The snapshot changes because:
- Every action's `businessErrors` / `scopeRules` / `notes` (when present) is now in the output.
- `transportErrorCodes` has a new `stale_client` entry.
- `schemaHash` changes as a result of both of the above.

Regenerate however the codebase currently regenerates it. Review the diff to confirm the changes are exactly the additions above and nothing else.

### 8. Tests

**Unit (`test/unit/server.test.ts`), new cases:**

1. `POST /api` with matching `ClawClub-Schema-Seen` → 200.
2. `POST /api` with missing `ClawClub-Schema-Seen` → 200 (tolerance).
3. `POST /api` with empty-string header → 200 (treated as missing).
4. `POST /api` with mismatched header → 409, `error.code === 'stale_client'`, `error.message` contains the literal substrings `"GET /api/schema"` and `"GET /skill"` (guardrail against future watering-down).
5. `ClawClub-Version` present on `GET /`, `GET /skill`, `GET /api/schema`, `POST /api` success, `POST /api` error, `OPTIONS`.
6. `ClawClub-Schema-Hash` present on the same set.
7. SSE response headers contain both `ClawClub-Version` and `ClawClub-Schema-Hash`.
8. `OPTIONS` preflight response contains `Access-Control-Expose-Headers: ClawClub-Version, ClawClub-Schema-Hash`.
9. `GET /api/schema` with mismatched `ClawClub-Schema-Seen` still returns 200 (not gated).
10. `GET /updates/stream` with mismatched `ClawClub-Schema-Seen` still connects (not gated).

**Unit (new file or existing schema endpoint test), metadata shape:**

11. `/api/schema` response contains `businessErrors` for `content.create` with `quota_exceeded`, `illegal_content`, `gate_unavailable` entries.
12. `/api/schema` response contains `scopeRules` for `messages.send` with a bullet mentioning DMs are not club-scoped.
13. `/api/schema` response contains `notes` for `admissions.public.submitApplication` referencing the accepted-message-verbatim rule.
14. Actions without guidance do not emit empty `businessErrors: []` / `scopeRules: []` / `notes: []` (omission, not empty arrays).

**Integration smoke (`src/http-smoke.ts`):**

15. Read `ClawClub-Schema-Hash` from the first response, send it as `ClawClub-Schema-Seen` on a subsequent `POST /api`, assert 200.
16. Send a deliberately wrong `ClawClub-Schema-Seen`, assert 409 + `stale_client` + the prose message.

**Integration (`test/integration/non-llm/smoke.test.ts`):**

17. Optional end-to-end case exercising the match + mismatch flow through the real harness.

**Snapshot:**

18. `test/snapshots/api-schema.json` is regenerated and reviewed. Diff should contain only the new metadata, the `stale_client` transport error code, and the resulting `schemaHash` change.

## What does not change

- `src/schemas/transport.ts` — `errorEnvelope` is untouched; we emit only `{ok:false, error:{code, message}}`.
- `src/contract.ts` — `AppError(statusCode, code, message)` already supports our call.
- `db/init.sql`, `db/migrations/` — no database changes.
- `test/integration/harness.ts` — the harness does not send `ClawClub-Schema-Seen`, so missing-header tolerance keeps all existing integration tests passing unchanged.
- Existing test fixtures — no updates beyond the schema snapshot.
- No new modules, no refactors.

## Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| `getSchemaPayload()` at module load hits a load-order bug | Low | Verify with `npm run test:unit` after Edit A. Fallback: lazy init on first request. |
| SSE path silently misses new headers | Medium | Explicit edit to the SSE `writeHead` block. Unit test asserts both headers on the SSE response. |
| Browser JS can't read new response headers | Low (no browser JS clients today) | `Access-Control-Expose-Headers` added. |
| Metadata typos in populated actions (e.g. wrong error code spelling) | Low–Medium | Unit tests assert representative business errors by literal code strings. Snapshot diff review catches drift. |
| Thinning SKILL.md removes content that still matters | Medium | The thinning is surgical: only action menu, `clubId` behavior, quota defaults, and Common-Surprises-that-now-live-in-notes. Everything else stays. Review the diff carefully. |
| First-deploy `schemaHash` change causes a flood of `stale_client` rejections | Expected, not a risk | This is the intended self-documenting rollout. All participating agents refresh once and continue. |
| Missing-header tolerance accidentally flipped strict in a future refactor | Low | Documented as permanent design in this plan and in `SKILL.md`. |
| Duplicate or contradictory guidance between `notes` and SKILL.md after thinning | Medium | Acceptance checklist includes a review step to diff SKILL.md against populated `notes` for overlaps. |
| Stale client auto-retries a non-idempotent mutation after refresh and double-posts | Medium | `STALE_CLIENT_MESSAGE` and SKILL.md handshake paragraph explicitly call out the `clientKey` retry-safety rule. |

## Acceptance checklist

Before marking the feature shipped:

**Schema metadata:**
- [ ] `ActionDefinition` has `businessErrors?`, `scopeRules?`, `notes?` fields.
- [ ] `/api/schema` output passes these through on actions that declare them.
- [ ] Actions without guidance omit the fields entirely (no empty arrays).
- [ ] `content.create`, `content.update`, `events.create`, `vouches.create`, `profile.update`, `admissions.public.submitApplication`, `admissions.sponsorCandidate` all have at least one `businessErrors` entry where applicable.
- [ ] `messages.send` has `scopeRules` describing DM-vs-club-scope.
- [ ] `clubadmin.*` scope-sensitive actions have `scopeRules` requiring explicit `clubId`.
- [ ] `session.getContext` has a `notes` entry about the actor envelope.
- [ ] Thin action descriptions have been enriched where obvious.

**Handshake headers:**
- [ ] `SCHEMA_HASH` is read once at module load and matches the value in `/api/schema` body.
- [ ] `ClawClub-Version` appears on every HTTP response (including SSE, 404, 415, and error responses).
- [ ] `ClawClub-Schema-Hash` appears on every HTTP response (including SSE, 404, 415, and error responses).
- [ ] `Access-Control-Expose-Headers` lists both headers on the main CORS response.
- [ ] `stale_client` appears in `transportErrorCodes` in `/api/schema`.

**Handshake enforcement:**
- [ ] `POST /api` with matching `ClawClub-Schema-Seen` succeeds.
- [ ] `POST /api` with missing header succeeds.
- [ ] `POST /api` with empty header succeeds.
- [ ] `POST /api` with mismatched header returns 409 with `error.code = "stale_client"` and the full prose message.
- [ ] The rejection happens before `readJsonBody` runs — no side effects, no `invalid_json` or `payload_too_large` winning over `stale_client`.
- [ ] `/api/schema`, `/skill`, and `/updates/stream` never reject on mismatch.

**SKILL.md:**
- [ ] Handshake paragraph added under "How to connect."
- [ ] "Available actions" section replaced with schema pointer.
- [ ] "`clubId` behavior," "Default quotas," and duplicated "Common surprises" bullets removed.
- [ ] "How someone joins a club" and "When to clarify first" sections untouched.
- [ ] Client-behavior sections (privacy, tone, response style) untouched.

**Tests / snapshot / version:**
- [ ] All existing tests pass with zero fixture updates (snapshot excepted).
- [ ] `test/snapshots/api-schema.json` regenerated; diff contains only intended additions.
- [ ] New unit test coverage lands (match / missing / empty / mismatch / header presence / SSE / OPTIONS / metadata passthrough).
- [ ] `http-smoke.ts` exercises success and mismatch paths.
- [ ] `package.json` patch version bumped once.

## Order of operations

1. Edit `src/schemas/registry.ts` — add `SchemaBusinessError` type and the three optional fields on `ActionDefinition`.
2. Edit `src/schema-endpoint.ts` — extend `SchemaAction`, pass the fields through, add `stale_client` to `transportErrorCodes`.
3. Populate `businessErrors` / `scopeRules` / `notes` on the high-value actions across `src/schemas/*.ts`.
4. Run `npx tsc --noEmit` and `npm run test:unit`. Fix any type errors.
5. Edit `src/server.ts` — all five handshake edits in one pass.
6. Run `npm run test:unit` again. Verify module-load order of `SCHEMA_HASH` works.
7. Regenerate `test/snapshots/api-schema.json`. Review the diff.
8. Add the new unit tests (handshake + metadata shape).
9. Add the `http-smoke` handshake cases.
10. Edit `SKILL.md` — insert handshake paragraph, trim action menu, trim pure-server-truth common-surprises bullets, trim `clubId` behavior and quota defaults.
11. Bump `package.json` patch version.

12. Run `npm run test:integration:non-llm`. If anything close to dispatch or error handling changed, run the full integration suite.
13. Commit.

Do not split this into multiple commits. The metadata additions and the handshake are designed to land together so the first post-deploy `schemaHash` change is a single clean event, not two.

## Open questions to verify during implementation

1. **Module-load safety of `getSchemaPayload()`.** Confirmed after Edit A with `npm run test:unit`. If it fails, switch to lazy computation closed over the server factory.
2. **Exact error code names populated in `businessErrors`.** Some codes above are educated guesses (`quota_exceeded`, `illegal_content`, `gate_unavailable`, `self_vouch`, `duplicate_vouch`, `needs_revision`, `attempts_exhausted`, `challenge_expired`, `invalid_proof`, `challenge_consumed`). Verify each against the actual error codes thrown in the corresponding action handlers before populating. If a guessed code doesn't exist in code, either don't populate it or fix it to match reality — do not invent codes the server doesn't emit.
3. **Which module owns `quotas.getUsage`.** Locate and populate `notes` with default quota values, or skip if the defaults are no longer accurate.
4. **SKILL.md trimming scope.** Before deleting any bullet, confirm it's either (a) now in a populated `notes` field or (b) pure duplication of schema truth. Anything that's client-side heuristic stays.
5. **Header name casing.** Node normalizes request headers to lowercase; send headers as lowercase (`'clawclub-schema-hash'`) to match existing codebase convention (`'x-content-type-options'`, `'cache-control'`). Use the capitalized form (`ClawClub-Schema-Hash`) only in `Access-Control-Expose-Headers` metadata and user-facing documentation.

## End state

After this work:

- `/api/schema` tells an agent what the server does, what it accepts, what can go wrong in business terms, how to recover, and what scope rules apply.
- `SKILL.md` tells an agent how to behave as a ClawClub client in conversation — bootstrap, privacy, tone, workflows, and UX heuristics — and documents the contract-handshake protocol for cache freshness.
- When the schema drifts, participating agents get a clean `409 stale_client` with a self-contained prose recovery message instead of confusing `invalid_input` errors.
- Non-participating agents are unaffected: they continue to work exactly as before.

## Additional thoughts (Codex)

This combined plan is in the right place. The narrowed metadata surface is disciplined, the handshake design is simple, and the boundary between schema truth and client behavior is much cleaner than the larger earlier proposal.

Three implementation guardrails are worth keeping in mind:

1. Keep `notes` strictly server-truth. It is the easiest field to overuse. Good entries are things like the `session.getContext` actor-envelope gotcha, `clientKey` scope, and admissions retry semantics. Bad entries are UX heuristics or conversational advice that belongs in `SKILL.md`.

2. Prefer one shared helper for default response headers, even if the SSE path still needs an explicit call site. The plan already calls out the SSE special case; a small helper that returns the common `ClawClub-Version` / `ClawClub-Schema-Hash` header pair will reduce future drift between normal responses and any later manually-written paths.

3. Be conservative about metadata volume. The high-value win is documenting the handful of actions that repeatedly cause agent mistakes. It is fine for most actions to have none of `businessErrors`, `scopeRules`, or `notes`. Resist the urge to "fill every action" just because the fields exist.

One small doc-level suggestion: in the implementation section, the file reference for `quotas.getUsage` likely belongs to the current platform schema module rather than a dedicated `src/schemas/quotas.ts` file if that file does not exist in this branch. The plan intent is correct; the path may need adjusting at implementation time.

I would keep the rest of the design as written. In particular, keeping workflows and clarification heuristics in `SKILL.md` while moving only server-truth metadata into `/api/schema` is the right long-term split.

## Additional thoughts (Claude)

Agree with all four of Codex's points. A few more guardrails worth making explicit so a coding agent doesn't improvise on them:

1. **Concrete test for "is this a `notes` entry or a SKILL.md sentence?"** If the statement describes something the server *does* or *enforces*, it is server truth and belongs in `notes` (or `businessErrors` / `scopeRules` if it fits one of those). If the statement describes something the *agent should do* in conversation with a user, it is client behavior and belongs in `SKILL.md`. Example: "The `accepted.message` field is what the server returns on success" is server truth — the fact. "Relay `accepted.message` to the user verbatim" is an agent instruction — but it is about how the agent should treat the server's output, which is still server-contract-adjacent and fine in `notes`. Rule of thumb: if rewording the note starts requiring words like "ask the user," "confirm," "clarify," "if ambiguous," it is UX guidance and should move to `SKILL.md`.

2. **Snapshot diff review is the single most important guardrail in this whole plan.** When regenerating `test/snapshots/api-schema.json`, the diff must contain exactly (a) new `businessErrors` / `scopeRules` / `notes` on the specific actions the plan names, (b) the new `stale_client` entry in `transportErrorCodes`, and (c) a new `schemaHash` value. If the diff shows anything else — an unrelated description change, a field reordering, a removed action, a type change — stop and investigate before accepting the snapshot. The snapshot is the primary guardrail against accidentally regressing the schema surface while the coding agent is inside schema modules.

3. **Cross-check every guessed error code with a grep before populating it.** The plan lists codes like `quota_exceeded`, `illegal_content`, `gate_unavailable`, `needs_revision`, `challenge_consumed`, `self_vouch`, `duplicate_vouch`, etc. Some of these are educated guesses. Before adding any code to `businessErrors`, grep `src/` for the exact string and confirm it is thrown by the relevant handler. If it is not — either the code uses a different name, or the error does not exist — fix the plan to match reality. Do not invent codes the server does not emit. A `businessErrors` entry that claims a code exists when it doesn't is worse than no entry at all.

4. **Don't refactor while you're in schema modules.** The metadata population pass touches a lot of files (`src/schemas/session.ts`, `messages.ts`, `entities.ts`, `events.ts`, etc.). It will be tempting to "clean up" neighboring code, rename a variable, tighten a description unrelated to the task. Resist. This is a purely additive metadata pass. If you notice something that needs refactoring, leave it for a follow-up.

5. **On the shared header helper (Codex point 2):** yes, but keep it small. Something like `getDefaultResponseHeaders()` returning `{ 'clawclub-version': PACKAGE_VERSION, 'clawclub-schema-hash': SCHEMA_HASH }` is the right size. Do not build a header-composition framework. Two call sites (`writeCompressed` defaults, SSE `writeHead` block) is the entire surface.

6. **The mismatch unit test's literal-substring assertion is load-bearing.** Test case 4 asserts that `error.message` contains the literal substrings `"GET /api/schema"` and `"GET /skill"`. Do not relax this assertion. Its only job is to guarantee that a future refactor cannot water down the recovery message into something a zero-context agent cannot follow. If the substrings become inconvenient, the fix is to keep them in the message, not to loosen the test.

7. **If unit tests are flaky on the SSE header assertion, do not skip it.** The SSE path bypasses the shared writers and is exactly where a future drift will happen silently. If the test harness makes it awkward to inspect SSE response headers, invest the small effort to make it possible — even a single direct assertion on the `writeHead` call args is enough.

Everything else in the plan stands as written.
