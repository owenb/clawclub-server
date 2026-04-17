# Pen Testing And Internet-Launch Security Plan

Line references in this document are as of the current workspace on `2026-04-16`. Verify them before acting; they will drift as the code changes.

## Context

This server is public at `https://clubs.clawclub.social` and is currently relying on Railway plus the application itself for most defenses.

That matters because Railway gives useful edge/network protections, but not a real application firewall:

- Railway public networking provides TLS, edge routing, request metadata like `X-Real-IP` and `X-Railway-Request-Id`, and network-level rate/connection limits. See [Railway public networking](https://docs.railway.com/networking/public-networking) and [Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits).
- Railway explicitly says it mitigates attacks at layer 4 and below, but does **not** provide application-layer protection or WAF functionality. Their own recommendation is to put Cloudflare in front if that is needed.
- Railway private networking is good for service-to-service traffic and should be used for anything that is not meant to be public. See [Railway private networking](https://docs.railway.com/networking/private-networking).

So the correct mental model is:

- Railway helps with TLS and basic network resilience.
- The app still needs to defend itself against abuse, bot traffic, credential theft, auth bypass attempts, cost-amplification, and data exfiltration.
- Anything public on this host will be enumerated and attacked.

## Threat Model

Assume all of these happen:

- Anonymous internet attackers fuzz every route, header, body shape, and method.
- Botnets try mass account creation, invitation-code brute force, and application spam.
- Attackers obtain one normal bearer token and then try horizontal privilege escalation.
- Attackers obtain one superadmin token and then attempt full platform takeover.
- Attackers try denial-of-service with slow requests, connection floods, stream floods, and expensive authenticated actions.
- Attackers try to turn OpenAI-backed paths into a spend amplifier.
- Attackers inspect `/api/schema` and `/skill` to map the whole surface area before they touch anything else.

## Current Posture

### Good News

The codebase already has some real hardening in place:

- Request bodies are capped at `1 MB` and rejected early in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:55).
- The HTTP server sets request, header, keep-alive, and per-socket limits in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:805).
- Input parsing is strict and action envelopes reject unexpected top-level keys in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:734).
- Bearer tokens and invitation codes are random and only stored as SHA-256 hashes in [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts:28) and [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql:1506).
- Invitation validation is mostly enumeration-safe today: malformed, unknown, revoked, used, expired, wrong-club, wrong-email, and wrong-secret cases all collapse to the same `invalid_invitation_code` response in [src/clubs/unified.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/unified.ts:405).
- Most database access is parameterized; I did not find obvious user-controlled SQL string interpolation in the main request path.
- Anonymous club applications already have proof-of-work on submission in [src/clubs/unified.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/unified.ts:809).
- `npm audit --omit=dev` reports `0` known production dependency vulnerabilities as of `2026-04-16`.

### Current Gaps

These are the main issues to address before treating the deployment as internet-hard:

- The current LLM legality/completeness gates should be treated as unsafe until proven otherwise. User-controlled text is interpolated verbatim into the gate prompt in [src/gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/gate.ts:268), [src/gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/gate.ts:282), and [src/gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/gate.ts:370), and the verdict parser trusts a free-form `PASS` string in [src/gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/gate.ts:327). The admissions gate has the same shape problem in [src/admissions-gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/admissions-gate.ts:43).
- CORS is fully open with `Access-Control-Allow-Origin: *` in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:410).
- The only IP-based rate limit is for anonymous `clubs.join`, and today it is exactly `10/hour/IP`, stored in process memory only, in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:67), [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:302), and [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:760). There is no current per-minute cap and no per-email cap.
- The current limiter reads `X-Forwarded-For` in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:288), while Railway’s public-networking specs page documents `X-Real-IP` as the client-IP header. Verify actual staging behavior and align the code and tests to what Railway really forwards.
- Anonymous `clubs.join` currently lets an attacker farm durable bearer tokens at effectively zero cost: it creates an active member and mints a bearer token in [src/clubs/unified.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/unified.ts:691), before any email proof and before any proof-of-work. The PoW gate only appears later on `clubs.applications.submit` in [src/clubs/unified.ts](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/unified.ts:809).
- Unauthenticated callers can still get per-action request shapes through `requestTemplate` on malformed requests before auth runs in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:746) and [src/schemas/registry.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/registry.ts:304).
- Authenticated expensive actions are not centrally rate-limited. This includes LLM gating in [src/gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/gate.ts:370), admissions gating in [src/admissions-gate.ts](/Users/owen/Work/ClawClub/clawclub-server/src/admissions-gate.ts:34), and semantic search in [src/schemas/entities.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/entities.ts:684) and [src/schemas/membership.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/membership.ts:494).
- Member-writable text fields are very large in several places: `250,000` characters for generic strings and DM messages in [src/schemas/fields.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/fields.ts:146) and [src/schemas/fields.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/fields.ts:193). Those limits are too high for abuse resistance and LLM cost control.
- The JSON body parser only limits bytes, not structure cost, in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:74). There is no depth limit, no total-key limit, and several user-input arrays have no explicit `.max(...)` cap, for example in [src/schemas/fields.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/fields.ts:270) and [src/schemas/notifications.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/notifications.ts:91).
- `/api/schema` intentionally publishes the full action registry, including superadmin actions, in [src/schema-endpoint.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schema-endpoint.ts:93). That is not a bug by itself, but it means obscurity is not available as a defense.
- `/api/schema` and `/skill` are also unauthenticated and currently unthrottled in [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:665) and [src/server.ts](/Users/owen/Work/ClawClub/clawclub-server/src/server.ts:681), so they are recon and bandwidth-amplification surfaces.
- The container runs as root in [Dockerfile](/Users/owen/Work/ClawClub/clawclub-server/Dockerfile:1).
- The runtime DB model is intentionally high-trust: `db/init.sql` states “single database, single schema, no RLS” and gives ownership to `clawclub_app` in [db/init.sql](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql:1). If the app is compromised, the database is effectively compromised too.
- Worker health ports are unauthenticated JSON endpoints in [src/workers/runner.ts](/Users/owen/Work/ClawClub/clawclub-server/src/workers/runner.ts:183). They are fine on private networking and a mistake if exposed publicly.

## P0: Must Do Before Broad Internet Launch

### 1. Treat The Current LLM Gate As Unsafe

The current gate is useful product behavior and weak abuse friction. It is not strong enough to be treated as a security boundary.

Why:

- User-controlled text is inserted verbatim into an unstructured prompt.
- The verdict is accepted from free-form model text.
- `gpt-5.4-nano` is a small, instruction-following model, so jailbreak reliability does not need to be perfect for the gate to fail operationally.

Required hardening:

- Move verdicts to structured output: typed JSON or tool-call output with an enum status and validated schema.
- Wrap the artifact inside a distinct untrusted block such as XML-style tags and instruct the model that content inside it is never an instruction.
- Add deterministic pre-checks before the LLM where possible, especially for simple disallowed patterns and hard length/shape failures.
- Add a second-pass verifier prompt that checks the first-pass verdict for policy contradiction without seeing the raw artifact again.
- Build a jailbreak corpus and fuzz every LLM-gated action in CI and staging.
- Treat any non-trivial jailbreak pass rate as a launch blocker.

### 2. Put An Actual Edge In Front Of The API

Preferred:

- Put Cloudflare in front of Railway.
- Enable WAF, bot management, rate limits, geo/IP reputation rules, and managed DDoS.
- Terminate on Cloudflare, forward only HTTPS to Railway.

Even with Cloudflare in front:

- Let the edge handle anonymous per-IP throttling, geo/risk policy, request filtering, and bot suppression.
- Keep app-side controls for authenticated per-token quotas, per-member quotas, invitation abuse checks, and OpenAI spend caps. The edge cannot enforce those correctly because it does not know your actor model.
- If Cloudflare is in front, lock the Railway origin so only Cloudflare can reach it, or use an authenticated tunnel or mTLS equivalent. Otherwise attackers can bypass Cloudflare and spoof trusted headers directly at the origin.
- The server now always prefers the leftmost `X-Forwarded-For` value and falls back to the socket remote address. No env switch. If Cloudflare or another edge is introduced where `CF-Connecting-IP` or `True-Client-IP` is the canonical client header, change `getClientIp` in `src/server.ts` to read that header first — don't re-introduce an env-var toggle.

If Cloudflare is not an option:

- Add some other reverse proxy/WAF layer with centralized rate limiting.
- Do **not** rely on Railway alone for app-layer abuse protection.

### 3. Split Runtime DB Privilege From Migration Privilege

The current model is convenient but high-risk.

Do this in parallel with the edge work, not after it.

Before broad launch, aim for:

- A privileged migration role that owns schema changes.
- A separate runtime application role with only the DML and function rights the server needs.
- No schema ownership for the runtime role.
- A separate migration job or one-shot container using `MIGRATION_DATABASE_URL`; do not have the API container run migrations on boot with the runtime role.
- Separate worker roles where practical. Splitting the API role but leaving all workers on a broad shared role only partially reduces blast radius.

This is one of the highest-value blast-radius reductions in the whole plan.

### 4. Expose Only The API Service

- Keep only the main API service on Railway public networking.
- Keep Postgres, background workers, admin-only jobs, and health ports on Railway private networking only.
- Verify there is no public TCP proxy for Postgres.
- Verify no worker service has public networking enabled.
- Add a deployment assertion, not just documentation, that worker services do not have public networking enabled.

### 5. Fix Client IP Handling And Centralize Rate Limiting

- Stop treating the current in-memory limiter as enough.
- Update the app to extract the canonical client IP from the header Railway actually guarantees.
- Add an integration test that runs behind a reverse-proxy fixture and proves the app keys limits by real client IP.
- Move rate limiting to shared state, not process memory. Use Redis if you add it, or Postgres if you want fewer moving parts.
- Make limits work across restarts and across multiple replicas.
- Key IPv6 clients by `/64`, not by the full literal address. Full-address IPv6 rate limiting is trivially bypassed by address rotation.

Starting point for limits:

- `clubs.join` anonymous: `5/min/IP`, `20/hour/IP`, `5/day/email hash`.
- `clubs.applications.submit`: `5/10min/membership`, `20/day/member`.
- `messages.send`: `20/min/token`, burst cap `5/10s/token`.
- LLM-gated writes: `10/min/token`, `100/day/member`.
- Semantic search: `30/min/token`, plus per-member daily spend caps.
- `/stream`: keep `3/member`, add `10/IP`, and add a global circuit breaker for total open streams.
- Superadmin actions: separate, much tighter limits plus IP allowlisting if possible.
- Add hard global daily spend caps and per-action spend caps for OpenAI-backed paths. Alerts are not enough; the system must stop spending automatically when the budget is exhausted.

### 6. Change The Anonymous Join Flow

Current behavior is too generous for internet launch, and the core problem is stronger than simple spam:

- An attacker can farm durable bearer tokens at effectively zero cost.
- Anonymous join creates a member.
- It issues a bearer token immediately.
- It only requires proof-of-work later, on application submission.

Recommended change:

- Do not mint a real member bearer token until the email is verified or an invitation is proven.
- Create a short-lived pre-application record first.
- Send an email verification link or one-time code.
- Only after verification should the flow create the durable member identity and access token.

If email verification is not ready, at minimum:

- Increase friction for cold joins.
- Add stronger IP/email/device rate limits.
- Consider invitation-only launch for the first public phase.

### 7. Remove Narrow Enumeration Oracles

- Stop returning per-action `requestTemplate` details to unauthenticated callers.
- At minimum, suppress `requestTemplate` unless the caller is already authenticated or the action is intentionally public.
- Audit every pre-auth error path for action-shape leakage, account-existence leakage, and invitation-state leakage.

### 8. Lock Down CORS And Add Security Headers

- If this API is not intended for arbitrary browser-based third-party origins, remove `*`.
- Replace it with an allowlist of exact first-party origins.
- Add `Vary: Origin` when CORS is selective.
- Add `Strict-Transport-Security`, `Referrer-Policy`, `X-Frame-Options`, and `Permissions-Policy`.
- Keep `X-Content-Type-Options: nosniff`.
- Preserve `Cache-Control: no-store` on authenticated responses and add `Vary: Authorization` if any CDN or reverse proxy ever caches dynamic API traffic.

Note: this is bearer-token auth, not cookie auth, so CSRF is not the main problem. The main problem is unnecessary cross-origin browser readability.

### 9. Reduce Text Limits, JSON Complexity, And LLM Input Size

The `250,000`-character field caps are too high for safe public launch.

Recommended starting caps:

- DM message text: `4,000` or `8,000`.
- Title: `200`.
- Summary: `1,000`.
- Content body: `10,000` to `20,000`.
- Profile free-text fields: `1,000` each.
- `clientKey`: `128`.

Also:

- Tighten both the wire schemas and the parse schemas. Right now the large caps exist in both places in [src/schemas/fields.ts](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/fields.ts:146).
- Add JSON complexity caps before Zod parsing: maximum nesting depth, maximum total keys, and maximum array length.
- Add explicit `.max(N)` bounds on all user-input arrays.
- Hard-cap the payload size that is sent to OpenAI regardless of storage limits.
- Reject or truncate over-budget content before LLM calls.
- Log per-action token usage and alert on spikes.

### 10. Harden The Container

- Run as a non-root user.
- Use a slimmer runtime image if possible.
- Drop build tools and unused packages from the runtime image.
- Prefer read-only filesystem where practical.
- Keep only the binaries the app actually needs.

### 11. Protect The Admin Plane

Superadmin token compromise is catastrophic because superadmin can inspect platform data and mint access tokens.

Minimum controls:

- Require MFA on Railway, GitHub, and any secret manager.
- Make superadmin tokens short-lived by default.
- Keep admin token creation rare and auditable.
- If the admin dashboard is a browser app on Vercel or another public frontend host, do not pretend that “VPN-only” admin access exists unless the browser is talking to a backend you control that then talks privately to this API. Pick one architecture and document it explicitly.
- Prefer moving superadmin operations behind a separate admin backend or private service boundary rather than exposing raw superadmin tokens to browser storage.
- Alert on every `superadmin.*` action.

## P1: Strongly Recommended Soon After Launch

- Add structured audit logging for every request: timestamp, route, action, status, latency, memberId, clubId, IP hash, user-agent hash, `X-Railway-Request-Id`, response size, and LLM token usage when present.
- Define log hygiene rules: never log bearer tokens, invitation codes, raw DM bodies, full application text, email addresses unless explicitly required, or raw OpenAI prompt payloads. Set a retention period and owners for review and deletion.
- Add anomaly alerts for spikes in `401`, `403`, `429`, `500`, `clubs.join`, `messages.send`, semantic search calls, and superadmin actions.
- Add a kill switch for anonymous joins.
- Add a kill switch for semantic search and other OpenAI-backed endpoints.
- Add replay and abuse dashboards by IP, member, club, and token.
- Add secret scanning in CI and verify `.env`/`.env.local` were never committed in history. Rotate immediately if they ever were.
- Add a secret-rotation runbook, not just scanning: who rotates the OpenAI key, DB password, and superadmin tokens; how to invalidate old tokens; and how to confirm the system is clean afterward.
- Add rate limits or caching policy for `/api/schema` and `/skill` so they cannot be used as cheap bandwidth amplification surfaces.
- Add container scanning in CI with something like Trivy.
- Add static analysis in CI with Semgrep or CodeQL.

## P2: Architectural Hardening

- Split public API and admin API into separate services.
- Put the admin service behind stronger network controls than the public API.
- Move high-cost or high-risk actions behind queues where that improves control.
- Consider more formal row-level isolation if the data model ever becomes multi-tenant enough that a single query bug should not expose cross-club data.
- Add device or session fingerprinting for abuse scoring if spam becomes a real problem.

## What Attackers Will Actually Try

### Recon And Route Discovery

They will fetch:

- `/`
- `/skill`
- `/api/schema`
- invalid methods on every path
- random guessed paths

Mitigation:

- Assume the full action list is public.
- Do not rely on hidden names.
- Keep transport errors boring and generic.
- If needed later, publish a public schema without superadmin action details.
- Remember there are multiple schema oracles today: the full schema endpoint and narrow `requestTemplate` error responses.

### Bearer Token Theft And Replay

They will try:

- brute force
- replay of leaked tokens
- use of revoked tokens
- using a normal token to reach admin data

Mitigation:

- Token entropy and hashing are already solid.
- Current auth checks are DB-side `id + token_hash` lookups, not app-side secret string comparisons. Keep that property. If secret comparison ever moves into application code, use timing-safe comparison.
- Add short expiries by default for sensitive tokens.
- Add better revoke UX and aggressive monitoring.
- Log token creation, use, and revocation.
- Alert on impossible-travel or sudden IP changes for the same token if that becomes practical.

### Invitation Code Brute Force

They will hammer `clubs.join` with guessed invitation codes.

Mitigation:

- Keep strict per-IP and per-email limits.
- Add counters specifically for invitation failures.
- Alert on repeated invalid invitation attempts.
- Consider temporary IP cooling-off after repeated failures.
- Invitation codes currently have high entropy because they are `12` base-32ish ID chars plus `24` secret chars in [src/token.ts](/Users/owen/Work/ClawClub/clawclub-server/src/token.ts:46). Keep lifetime and rate limits strong enough that brute-force remains infeasible within the code lifetime.

### Anonymous Account Farming

They will mass-create applications with disposable emails or emails they do not control.

Mitigation:

- Email verification before durable account/token issuance.
- Rate limits by IP and email hash.
- Disposable email blocklists if needed.
- Early-abuse scoring before creating a full member record.
- Do not treat proof-of-work as a CAPTCHA. PoW only raises cost linearly; a GPU farm or paid-solver setup can still push large volumes if the rest of the abuse controls are weak.

### IDOR And Authorization Bugs

They will try every object ID they can see: members, memberships, messages, entities, invitations, notifications.

Mitigation:

- Keep adding authz-matrix integration tests across clubs, roles, and membership states.
- Add negative tests for every new action, not just happy paths.
- Treat `superadmin.*` as a separate plane and test it separately.

### Enumeration And Error Shaping

They will use differences in error codes, status codes, and response timing to infer:

- whether an email already maps to an account
- whether an invitation exists
- whether an invitation was used, revoked, or expired
- whether a token format is valid vs. simply unknown

Mitigation:

- Keep invitation validation on a uniform `invalid_invitation_code` error shape.
- Audit every join, login, invitation, and token-validation path for distinguishable messages and timing.
- Prefer one boring response over a more informative but enumerable one unless the product value is high enough to justify it.

### Spam And Cost-Amplification

They will use stolen or farmed tokens to:

- spam DMs
- spam content
- hammer semantic search
- trigger LLM gates repeatedly

Mitigation:

- Per-token/member/day quotas.
- Per-club quotas where that makes sense.
- Rate limits on expensive reads, not just writes.
- Hard LLM input caps.
- Automatic budget kill switches for OpenAI-backed actions.

### Stream And Connection Exhaustion

They will open lots of `/stream` connections or keep sockets hanging.

Mitigation:

- Keep the current server timeouts.
- Add per-IP and total open-stream caps.
- Add reverse-proxy connection limits at the edge.
- Monitor DB pool saturation and stream counts.

### Stored XSS In Downstream Clients

This server stores user text. Even if the API itself is not rendering HTML, future web clients can still get burned.

Mitigation:

- Treat all member-generated text as untrusted.
- Escape or sanitize on render in every client.
- Include stored-XSS payloads in end-to-end tests whenever a first-party web UI exists.

### Worker And Internal Endpoint Exposure

They will scan for extra ports.

Mitigation:

- Only expose the API service.
- Keep worker health ports private.
- Verify Railway service settings, not just application code.

## Validation Runbook

### Automated Checks In CI

- `npm audit --omit=dev`
- unit and integration tests
- secret scan
- container scan
- static analysis

### New Security Tests To Add

- Reverse-proxy IP extraction test using Railway-style headers.
- Trusted-proxy-chain tests for each supported topology: direct Railway, Cloudflare-to-Railway, and any future admin-backend path.
- Distributed/shared rate-limit tests.
- IPv6 `/64` limiter tests.
- Abuse tests for anonymous join, invalid invitation codes, DM spam, semantic search spam, and LLM-gated write spam.
- Jailbreak and prompt-injection tests for every LLM-gated action and the admissions gate.
- Enumeration tests that confirm join/invitation/token failures stay uniform where intended.
- Large-body and large-text tests that verify expensive actions reject over-budget content before LLM calls.
- JSON depth, key-count, and array-length rejection tests.
- Superadmin alerting and audit-log coverage tests.
- Worker-public-exposure deployment checklist test or script.
- Embedding-backed query tests that prove club scoping is always present and cannot be accidentally omitted in future repository code.

### External Pen Test On A Staging Deployment

Run against a staging environment that matches production topology:

- Route and method fuzzing.
- Authz matrix and IDOR checks.
- Invalid token, revoked token, expired token, and malformed token tests.
- Invitation brute force simulation.
- Anonymous join farming simulation.
- `messages.send` spam simulation.
- `/stream` connection flood simulation.
- Semantic search and LLM spend-amplification simulation.
- TLS and response-header verification.
- Port scan to confirm only the intended service is public.

## Launch Checklist

- Edge/WAF in front of Railway.
- Only API service is public.
- Real client IP extraction verified in staging.
- Shared rate limiting in place.
- Anonymous join no longer mints durable tokens before email or invitation proof.
- Text limits reduced.
- LLM input budgets enforced.
- CORS narrowed.
- Security headers added.
- Container no longer runs as root.
- Runtime DB role no longer owns the schema.
- Superadmin actions fully audited and alerted.
- Kill switches documented and tested.
- Secret scanning and rotation procedure documented.

## Bottom Line

If you launch exactly the current architecture to the public internet, the most likely failures are not classic SQL injection or remote code execution.

The likely failures are:

- bot-driven anonymous application farming
- spend amplification through authenticated OpenAI-backed actions
- spam and stream abuse from stolen or throwaway tokens
- blast-radius problems if the app layer is ever compromised

The right launch posture is:

- put a real edge in front of Railway
- centralize rate limiting
- verify email before durable anonymous access
- reduce expensive input sizes
- harden the container and DB privileges
- treat `/api/schema` as public reconnaissance and secure everything accordingly
