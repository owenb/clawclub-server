# ClawClub Security Hardening Report

Date: 2026-04-16.
Scope: ClawClub server at `https://clubs.clawclub.social`, current working tree.
Audience: Owen, and anyone he shares this with before the broad internet launch.

This is a findings report. The sister document `PEN_TESTING.md` is the launch plan. This one explains *what is wrong*, *where it lives in the code*, *how an attacker uses it*, and *what "fixed" looks like*, in plain English. Line numbers are accurate as of today and will drift — verify before acting.

Method: I checked the major claims in this document against the current tree, spot-checked the relevant tests, cross-checked `plans/BUGS.md` for already-known overlapping defects, and used official vendor docs only for infrastructure/model-behavior claims that are external to the repo. Where I am making a judgment call rather than reporting a hard fact from code, I say so explicitly.

## 1. Bottom line up front

The server is not currently safe to leave exposed to a motivated adversary. The most likely failure modes are not classic SQL injection or remote code execution — they are:

- Free minting of authenticated identities, which defeats every downstream rate limit and audit signal.
- A forgeable content-moderation gate that can be talked into approving anything.
- An admissions gate where a compromised clubadmin can rewrite the system prompt.
- Spend amplification through authenticated OpenAI-backed actions, with only alerts rather than hard dollar limits between you and a very expensive weekend.
- An all-or-nothing database privilege model that means any app-layer compromise is a database compromise.

Five items in particular are "catastrophic and fast" if exploited. The other ten are "bad but recoverable." They are all listed below.

## 2. The top five, in plain English

These are the five that, if attacked successfully, hurt you quickly and meaningfully, and the order in which they should be fixed.

### 2.1 Anyone can mint durable bearer tokens for free

**Severity: critical. Structural.**

The `clubs.join` action is public and unauthenticated. It accepts an email address, creates a real member row with that email, and hands back a real bearer token — all before any email verification and before any proof of work. The PoW gate only runs later, on `clubs.applications.submit`, and by then the attacker already has the token.

Where:

- `src/clubs/unified.ts:726` — `createAnonymousMember`
- `src/clubs/unified.ts:730` — `issueBearerToken` called immediately after
- `src/clubs/unified.ts:928-954` — PoW enforcement, on a *different* action

The attack is trivial. Rent residential proxies or run a botnet. Hit `clubs.join` at the allowed rate (10/hour/IP today) from thousands of IPs. Collect tens of thousands of real tokens. Now every per-token rate limit in the system is meaningless, because token cost is effectively zero.

What the attacker does with those tokens:

- Fans out authenticated actions across tokens to multiply aggregate rate beyond any single-abuser limit.
- Burns OpenAI budget through LLM-gated actions.
- Submits applications in bulk, with PoW priced at cents per submission via GPU farms or paid CAPTCHA solvers.
- Bloats the member and token tables with junk identities.
- Probes authorization logic from inside the wall. Most auth bugs are easier to find and exploit from an authenticated position than from outside.

The worst part is the cascade. Every downstream defense in the system — per-token quotas, per-member daily budgets, audit signals, abuse scores — silently assumes that tokens cost something to obtain. Until that is true, none of those defenses do the work they look like they do.

Fix, concretely:

- `clubs.join` records a pending application keyed by email; it does not create a member and does not mint a token.
- The server emails a one-time code or link to that address.
- The caller returns with the code; only then do you create the member row and mint the token.
- Rate-limit the verification step by IP (keyed by `/64` for IPv6, see §2.4), by email, and by email domain.
- Block or severely rate-limit known disposable-email providers.
- Decide explicitly how to treat tokens already minted under the old flow. My recommendation is not to grandfather them silently forever: mark pre-fix anonymous-join tokens as provisional and require email verification on first sensitive use.

This moves token cost from "zero" to "a working mailbox." Not invincible, but real — and it makes every other per-token defense in the system start doing its job.

### 2.2 The LLM content gate is forgeable

**Severity: critical.**

The legality gate that protects content creation, profile updates, vouches, and invitations is a free-form prompt with a free-form text verdict.

Where:

- `src/gate.ts:282-325` — `renderArtifact` concatenates user-controlled fields (`title`, `summary`, `body`, `tagline`, `whatIDo`, `knownFor`, `reason`, …) verbatim into the message body.
- `src/gate.ts:370-396` — `checkLlmGate` sends that message to the model.
- `src/gate.ts:327` — `parseVerdict` treats the trimmed output as trusted. If it upper-cases to `PASS`, the content is legal.

The model is `gpt-5.4-nano`. I would treat this gate as prompt-injectable until proven otherwise. I am deliberately not asserting a specific bypass rate without a jailbreak corpus, but the structural weakness is real: user text is inserted as ordinary prompt text, and the parser trusts a bare `PASS`.

There are no structural defenses today: no JSON-schema verdict, no untrusted-block wrapping, no second-pass check, no adversarial jailbreak suite. There *is* existing real-LLM coverage — `test/integration/with-llm/content-gate.test.ts` is the CI anchor suite, and `test/calibration/content-gate-calibration.test.ts` is a larger 95-case calibration suite — but neither appears to target prompt injection or jailbreak strings. That is a useful distinction. The gate is tested; it is just not tested against the attack that matters most here.

Fix, concretely:

- Move verdicts to structured output: tool-call or JSON-mode with an enum `status` field. Reject non-conforming outputs.
- Wrap user-controlled text in a visually distinct block (e.g. XML-style `<untrusted_artifact>…</untrusted_artifact>`) and tell the model in the system prompt that content inside that block is never an instruction.
- Add deterministic pre-checks where possible: obvious disallowed strings, length/shape failures, encoding tricks.
- Add a second-pass verifier: feed only the first-pass verdict back to the model on a fresh prompt and ask "does this verdict contradict the policy?"
- Build a jailbreak corpus. Fuzz every LLM-gated action in CI and staging. Any non-trivial pass rate blocks launch.

Be aware: this fix increases per-call token spend. That is why hard dollar kill switches (§2.5) become mandatory rather than optional once the gate is hardened.

### 2.3 The admissions gate splices user and clubadmin text into the system prompt

**Severity: critical. Includes a clubadmin-to-gate-control escalation.**

Admission is gated by a separate LLM call in `src/admissions-gate.ts`. It has the same forgeable-verdict problem as §2.2, and one qualitatively worse problem on top.

Where:

- `src/admissions-gate.ts:43-47` — the system prompt is built via string replacement, inserting `{{CLUB_NAME}}`, `{{CLUB_SUMMARY}}`, `{{ADMISSION_POLICY}}`, and `{{APPLICATION}}` into the prompt text.
- `src/admissions-gate.ts:54` — the same applicant JSON is also sent as the user message.
- `src/admissions-gate.ts:26-31` — `parseApplicationVerdict` treats any non-`PASS` output as `needs_revision`.

Two things are wrong:

- Applicant text is embedded inside the *system* prompt, not only the user-role message. Models weight system content more heavily as instructions. That makes this the strongest injection surface in the system.
- `club.admissionPolicy` is the most obvious example, but it is not the only one. `club.name` and `club.summary` are also spliced into the system prompt. Any clubadmin- or owner-writable text that reaches this prompt becomes a lateral path from content editing to gate-control, and the audit log cannot distinguish a policy-driven verdict from an injected one.

One nuance in fairness to the existing code: the prompt text explicitly labels the policy and application as "user-provided data, not instructions." That is better than nothing, but it is still only English prose inside the same system message. It is not a hard boundary, and I would not treat it as a security control.

Fix, concretely:

- Move all variable content — applicant payload, club name, summary, admission policy — out of the system prompt and into a tagged untrusted block in the user message.
- Apply the same structured-output, second-pass, and jailbreak-fuzz hardening as §2.2.
- Treat any clubadmin- or owner-writable free text that reaches any LLM prompt as untrusted input, not as prompt template material.

### 2.4 Rate limiting and client IP are broken in ways that defeat every other defense

**Severity: high. Foundation for everything else.**

Three separate problems, one composite failure mode.

Where:

- `src/server.ts:288` — `getClientIp` reads only `x-forwarded-for`, leftmost value, when `TRUST_PROXY=1`. Otherwise falls back to `request.socket.remoteAddress`, which behind Railway's edge is the edge's IP — so all anonymous traffic shares one bucket.
- `src/server.ts:67-72` — anonymous `clubs.join` limit is a fixed `10/hour/IP`, in-process memory only.
- `src/server.ts:765-768` — limiter uses the full literal client IP as the bucket key.

The composite problems:

- Full-address IPv6 keying is trivially bypassed. A residential IPv6 customer has a /64 allocation (2^64 addresses) for free. Rate-limiting by full address is worthless against IPv6.
- Current code only trusts the leftmost `X-Forwarded-For`. The existing unit test (`test/unit/server.test.ts:876-927`) proves that `X-Forwarded-For` is ignored when `trustProxy` is off, but there is no corresponding test that the chosen header is correct for Railway or Cloudflare. Railway's public-networking docs document `X-Real-IP`; Cloudflare's docs recommend origin apps prefer `CF-Connecting-IP` or `True-Client-IP` over `X-Forwarded-For`.
- The in-memory limiter does not survive restarts or scale across replicas. A rolling deploy resets every bucket.
- If Cloudflare is ever added in front of Railway, the right header becomes `CF-Connecting-IP`, and trusting anything else means attackers can bypass Cloudflare by hitting the origin directly.

One important update since the earlier drafts: Railway's February 2026 incident report says all customer workloads are now behind a Fastly WAF with automated DDoS detection and mitigation. Railway's standing docs still say they do not provide application-layer protection and still recommend Cloudflare for WAF functionality. My reading of those together is:

- Railway now provides a baseline platform-managed Fastly layer.
- That layer is a bonus, not a customer-configurable edge.
- It does not replace the app-aware controls in this report.

If we do **not** use Cloudflare, that is not automatically reckless. It just means all of the logic-aware defenses have to live in our code and data plane: email verification before token minting, shared-state rate limits, `/64` keying for IPv6, spend caps, semantic-search throttles, and so on. Railway/Fastly may catch volumetric abuse, but it cannot know that `clubs.join` is our most dangerous unauthenticated write endpoint.

Fix, concretely:

- Decide the deployment topology explicitly: direct-to-Railway, Cloudflare-to-Railway, or something else. The canonical client-IP header follows from that.
- If we stay direct-to-Railway, treat Railway's Fastly layer as baseline filtering only and ship the app-layer controls in this document as the real abuse defenses.
- If we add Cloudflare, do not treat a DNS change as sufficient. Cloudflare's own guidance is to protect the origin with allowlisting, Authenticated Origin Pulls, Tunnel, or equivalent. Otherwise the edge is decorative.
- Key IPv6 clients by `/64`, not full address.
- Move rate limits to shared state (Redis or Postgres). Decide fail-open vs fail-closed per endpoint before shipping — I'd say fail-closed on `clubs.join`, `superadmin.*`, and LLM-gated writes; fail-open with local fallback on read paths.
- Record today's `TRUST_PROXY` value in prod. If it's off, every anonymous caller currently shares one bucket; if it's on, `X-Forwarded-For` spoofing works.

### 2.5 No hard dollar kill switch on OpenAI spend

**Severity: high. Alerts are not a control.**

Every LLM-gated action costs money. There is no mechanism that stops spending automatically when a daily budget is exhausted. There are no documented per-action dollar caps either.

At current `gpt-5.4-nano` pricing, no single moderation call is ruinous by itself. The risk is unbounded repetition plus token farming, not one giant prompt. An attacker with farmed tokens (§2.1) can still turn LLM-gated writes into uncontrolled background spend long before an alert wakes a human. Once the gate is hardened (§2.2), per-request cost goes up, so hard caps become more important, not less.

Also, the existing daily content quota is not a spend control. `src/dispatch.ts:503-520` runs the legality gate before execution, while `src/postgres.ts:711-731` enforces the `content.create` quota inside repository execution. So quota limits successful writes; they do not prevent the LLM call itself from happening.

This and §3.5 are really one design problem: no paid operation should run until a full pre-flight has completed.

Fix, concretely:

- A hard daily dollar cap, enforced in the application. When exhausted, every LLM-gated action refuses with a specific error, and a kill-switch flag is set.
- A per-action dollar cap so one request cannot consume the day's budget on its own.
- A conservative monthly cap at the OpenAI org level, as a last-resort backstop.
- Move quota enforcement for spend-sensitive actions ahead of the LLM call if you want quota to serve as a cost control rather than only a write control.
- A synthetic load test in the validation runbook that verifies the kill switch actually trips.

## 3. Serious but not critical

These will hurt if exploited, but are lower severity than the top five or depend on the top five having already been compromised.

### 3.1 `requestTemplate` leaks action shapes pre-auth

Where: `src/server.ts:746-756` attaches `requestTemplate` to 400 error responses, derived from `getAction(body.action)`. `src/schemas/registry.ts:304` is the generator. `test/integration/non-llm/smoke.test.ts:234-280` explicitly asserts this behavior, including the generic template on missing or unknown actions.

Any caller — authenticated or not — can POST `{"action": "superadmin.actor.masquerade", "input": {}}` and read back the full input schema for that action. This is a narrow oracle separate from `/api/schema` and cheaper to probe action-by-action.

My opinion: this matters more than `/api/schema`. `/api/schema` is an intentional product feature for agents. The bug here is that privileged action shapes leak through error paths that do not respect authorization.

Fix: strip `requestTemplate` on any action whose required `auth` tier is above the caller's current tier. Not just unauthenticated — an authenticated member should not be able to probe superadmin action shapes this way either.

### 3.2 Database privilege is all-or-nothing

Where: `db/init.sql:1` states single database, single schema, no RLS, with ownership to `clawclub_app`. `Dockerfile:11` runs `npm run db:migrate && node ...` inside the API container. `src/workers/runner.ts:171` reads the same `DATABASE_URL` for background workers.

Any app-layer compromise is a full database compromise. There is no runtime/migration split, and workers run on the same broad role as the API.

In blast-radius terms, this is one of the highest-leverage fixes in the whole report even if it is not the first exploit an attacker uses. I would run it in parallel with the first launch blockers, not after them.

Fix:

- Migration role that owns schema. Runtime role with DML and function rights only, no ownership.
- Run migrations from a separate one-shot job container using `MIGRATION_DATABASE_URL`, not from the API container's startup command.
- Workers get their own narrower role where practical — read job queues, write embeddings, nothing else.

### 3.3 JSON body has no structural cost limits

Where: `src/server.ts:74-159` caps bytes at 1 MB, then `JSON.parse` is called. There is no depth limit, no total-key limit, no array-length limit. At least one user-input array is unbounded on max length, for example `src/schemas/notifications.ts:91` on `notificationIds`.

An attacker well inside the 1 MB byte budget can still send pathological JSON: very deep nesting, huge object fan-out, or very large arrays. Exact parser cost depends on shape, but the important point is simple: the byte cap is not a parse-cost cap.

Fix: depth ≤ 32, total keys ≤ ~1000, explicit `.max(N)` on every user-controlled `z.array` in input schemas, and a server-side recursive walk that rejects bodies that exceed complexity limits before dispatch.

### 3.4 Text field caps are far too high

Where: `src/schemas/fields.ts:146,153,162,169,193,197` — `250,000` characters on generic strings, DM messages, and patch fields. Both the wire schema and the parse schema share this limit. Also, `src/schemas/fields.ts:179` shows `parseRequiredString` has no `.max(...)` at all, and `plans/BUGS.md` correctly notes that this flows into fields like `invitations.issue.reason`, `event.location`, and several admin/billing reason strings.

At 250k chars, a single DM is *not* a ten-dollar OpenAI call at current `gpt-5.4-nano` pricing; that would overstate the cost badly. The real problem is different: these caps create avoidable latency, memory pressure, storage bloat, log-safety problems, and spend amplification when large fields do flow into an LLM. The caps were set for expressiveness, not abuse resistance.

Also note that not every long field reaches OpenAI today. `wireApplicationText`, for example, is already capped at 4000 chars. That is good. The problem is that the shared generic string primitives are still permissive enough that a future feature can accidentally inherit a launch-scale abuse surface by default.

Fix (suggested starting points): DM text 4k–8k, title 200, summary 1000, content body 10k–20k, profile free-text 1000, `clientKey` 128. Introduce bounded builders for required strings instead of one uncapped `parseRequiredString`. Tighten both the wire and parse schemas. Hard-cap payloads sent to OpenAI regardless of storage limits.

### 3.5 Some write paths can burn LLM budget before full authorization resolves

Where: `src/dispatch.ts:503-520` parses input and runs `preGate` before the LLM gate, but its built-in pre-gate auth check only covers a directly supplied `clubId`. `src/schemas/entities.ts:237-253` validates `content.create` inputs and mentions but does not resolve `threadId` to an authorized club before the gate. `src/schemas/entities.ts:374-387` validates `content.update` patches but does not verify authorship before the gate. The stronger checks land later in `handle` / repository code.

This is already tracked in `plans/BUGS.md`, and it belongs in the hardening report too. The risk is not remote code execution; it is spend abuse and information leakage. An authenticated member can sometimes force the legality gate to run on content they cannot actually write to, then receive the gate's feedback or at least burn your budget.

Fix: do not solve this by adding more security logic to optional repository hooks. `preflightCreateEntityMentions` and `preflightUpdateEntityMentions` are currently optional calls, which means omission or a thin mock can silently skip the check. Promote ownership resolution / paid-operation pre-flight to non-optional interface surface, or move it into dispatch-level infrastructure where it cannot be skipped. The design rule should be broader than these two endpoints: authorization, ownership resolution, quota, and rate-limit checks should all complete before any paid operation, including LLM and embedding calls.

### 3.6 CORS is wide open, security headers are missing

Where: `src/server.ts:410` sets `Access-Control-Allow-Origin: *`. Default response headers at `src/server.ts:255-259` include `ClawClub-Version` and `ClawClub-Schema-Hash` but no HSTS, no frame options, no referrer policy, no permissions policy.

Bearer-auth means CSRF is not the main risk; the main risk is unnecessary cross-origin readability and missing transport hardening.

My opinion: I would not hold the launch solely on CORS if tokens never live in cookies. I *would* still fix this before putting a CDN or admin frontend in front of the service, because missing `Vary` and cache semantics become much more dangerous once an edge starts caching.

Fix: allowlist exact first-party origins, add `Vary: Origin`, add `Strict-Transport-Security`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`. Keep `X-Content-Type-Options: nosniff`. Add `Vary: Authorization` and `Cache-Control: no-store` on authenticated responses if any CDN ever caches.

### 3.7 Admin plane is effectively browser-exposed today

The admin dashboard is a Next.js app on Vercel (per project notes and user confirmation), which calls superadmin-gated endpoints on this server. That means Vercel and the browser are in the trust boundary today by default. The current security plan says "consider moving superadmin behind a VPN-only path." Those two facts are in conflict: a browser SPA on Vercel cannot talk to a VPN-only API directly.

There is a second concrete constraint here. `/stream` authenticates only via the `Authorization` header (`src/server.ts:434-439`), and the schema explicitly documents that "Browser EventSource cannot set Authorization headers; use fetch with a streaming reader" (`src/schema-endpoint.ts:138`). So a browser admin client has three options:

- keep superadmin tokens in browser code and use `fetch` streaming from the browser,
- put tokens in the query string for `/stream`, which I would reject outright because it leaks into logs/history,
- or proxy through a backend that holds the admin credential.

My recommendation is to stop treating this as an open choice and adopt the backend-proxy architecture:

- The Vercel SPA proxies through its own backend. That backend lives behind VPN/mTLS and talks to this API privately. Superadmin tokens never touch the browser.

The current browser-direct posture is workable for a tiny internal tool, but it is the wrong long-term posture for a public-facing production admin plane. The remaining design question is where that backend lives: a Railway-side private service is my preferred answer, but a Vercel server-side runtime can also work if you treat it as a privileged service and secure the hop with signed service auth plus origin restrictions. That hosting choice is part of the trust model, not an implementation detail.

### 3.8 Container runs as root

Where: `Dockerfile:1-11` — no `USER` directive. Default is root.

A code-execution bug inside Node gets root in the container. Not by itself a path to the host on a modern runtime, but every privilege you don't need is a privilege an attacker gets for free.

Fix: `USER node` (already present in `node:22-slim`), read-only filesystem where practical, drop unused packages (`postgresql-client` stays because of `db:migrate` — which, per §3.2, should move to a separate job anyway).

## 4. Lower-severity but worth naming

These are real but either smaller in blast radius, dependent on a higher-severity item, or easier to stall on.

### 4.1 `/api/schema` and `/skill` are unauthenticated and unrate-limited

Where: `src/server.ts:668` and `:684`. Both GETs return full payloads with no throttle.

Recon is free for attackers, and Railway bills you for bandwidth. Either rate-limit by IP or cache aggressively at the edge.

I would not spend energy trying to hide these endpoints completely. The API is intentionally agent-readable. The right move is to make the public metadata cheap for you and expensive for the attacker.

### 4.2 `/stream` is a DB pool amplifier

Where: `src/server.ts:425-620` — each open stream runs a perpetual loop of `listClubActivity` and `listInboxSince`. Cap is 3/member, but at any significant member count this is hundreds of concurrent DB operations in a hot loop. DB pool saturation, not socket count, is the real constraint.

Severity rises sharply if §2.1 is unfixed. The stream cap is per member, not per real human, so farmed tokens multiply the DB-pool cost directly.

Add the DB pool to the stream-exhaustion monitoring. Consider increasing the poll interval and reducing per-iteration query cost.

### 4.3 Embedding search relies on a `WHERE` clause per query

Where: `src/schemas/entities.ts:709-711` scopes semantic search to `ctx.actor.memberships` or `requireAccessibleClub`. The `entity_embeddings` table is shared across clubs. A future query path that forgets the club filter leaks cross-club content via vector similarity.

Structural fix: make the repository method require a `NonEmpty<string[]>` of club IDs in its type signature, so omitting scope is a compile error. Add an authz test that asserts cross-club leakage is impossible even with a crafted query.

### 4.4 Container's `/` endpoint leaks the running version

Where: `src/server.ts:689-694` — serves an HTML page with `<h1>ClawClub Version ${PACKAGE_VERSION}</h1>`, unauthenticated.

Free version oracle. Put it behind a known-client gate or drop it.

### 4.5 Advisory-lock collisions

Where: `src/clubs/unified.ts:619,620,716,1221` and `src/workers/synchronicity.ts:634` use `pg_advisory_xact_lock(hashtext(...))`. `hashtext` is 32-bit; collisions are probabilistic under load.

Not a security bug, but under attack-induced load it will serialize unrelated operations and look like a mystery latency spike. Worth being named so it is not misdiagnosed.

### 4.6 Main LLM gates fail closed on provider outage, but not on injection

Where: `src/gate.ts:371-374` returns `{ status: 'skipped', reason: 'no_api_key' }` if `OPENAI_API_KEY` is unset, `src/dispatch.ts:223-236` converts `skipped` and `failed` into `503 gate_unavailable`, and `src/clubs/unified.ts:996-997` does the same for the application gate. `test/unit/app.test.ts:3609-3630` covers the failed-provider path for the main dispatcher.

This is one place where the current code is better than the earlier draft of this report implied: the main gate and the admissions gate are operationally fail-closed today when the provider is missing or errors. That is not the same thing as adversarial fail-closed. A successful prompt injection still returns `PASS` and the request proceeds; see §2.2 and §2.3. Keep the outage-path invariant, but do not mistake it for security against jailbreaks.

What is still missing is an explicit regression test for both outage paths: `skipped/no_api_key` and `failed/provider_error`.

### 4.7 Worker health endpoints

Where: `src/workers/runner.ts:183-191` creates an HTTP server that returns JSON health info, unauthenticated.

Fine on a private network, a mistake if exposed. Add a deployment-time assertion that workers never have public networking enabled on Railway — not just documentation saying "don't."

### 4.8 Enumeration timing

The invitation validation path collapses every failure mode to `invalid_invitation_code` (`src/clubs/unified.ts:446-479`, plus the anonymous pre-check at `:703-723`). Good. But timing can still differ between "token ID not found" and "token ID found but secret mismatched." Test with timing tools, not just by inspecting responses.

### 4.9 Log hygiene is undefined

There is no documented rule about what must not be logged. Bearer tokens, invitation codes, raw DM bodies, full application text, email addresses, raw OpenAI prompt payloads are all candidates for accidental leakage. Retention is undefined.

Fix: explicit log-hygiene policy, a retention period, and an owner for reviewing logs before any third party sees them.

### 4.10 Secret-rotation runbook

No documented procedure exists for rotating the OpenAI key, the database password, or superadmin tokens. Secret scanning in CI helps prevent leaks; a runbook is what makes you actually safe after one happens.

### 4.11 Semantic search is another unmetered OpenAI cost surface

Where: `src/schemas/entities.ts:684-748` and `src/schemas/membership.ts:494-520` call `embedQueryText(...)` for semantic search, but there is no dedicated quota or rate limit on these embedding-backed reads.

This matters because it is easy to focus only on the legality gate when thinking about OpenAI spend. An authenticated attacker with farmed tokens can also burn money through repeated semantic-search queries. The per-request cost is smaller, but the surface is broader and "read-only" endpoints tend to get less scrutiny.

Fix: use short-window rate limits for responsiveness and abuse control, then tie aggregate spend protection back to the same hard budget / kill-switch infrastructure as §2.5. I would not copy the content-write quota model directly onto semantic search.

## 5. What is already good

Worth saying out loud, so nobody "fixes" something that does not need fixing.

- Bearer tokens and invitation codes are generated with real entropy and stored only as SHA-256 hashes. 24 secret characters over a 31-char alphabet is ~119 bits of secret entropy, which is plenty. (`src/token.ts:1-80`.)
- The request envelope is strict: unexpected top-level keys are rejected (`src/server.ts:734-758`), and `input` must be an object.
- The HTTP server sets sensible timeouts and per-socket limits (`src/server.ts:805-809`).
- Request bodies are capped at 1 MB at the byte level and rejected early (`src/server.ts:74-159`). The byte cap is real; the structural gap is a separate issue in §3.3.
- Invitation-validation error shape is uniform (`src/clubs/unified.ts:446-479`, plus the anonymous pre-check at `:703-723`). Timing still needs verification — but the shape is good.
- The main content gate and the admissions gate currently fail closed on provider unavailability (`src/dispatch.ts:223-236`, `src/clubs/unified.ts:996-997`). Note that this is operational fail-closed, not adversarial fail-closed; prompt-injection risk remains the headline problem in §2.2 and §2.3.
- There is already meaningful gate-test infrastructure: a real-LLM CI anchor suite in `test/integration/with-llm/content-gate.test.ts` and a larger 95-case calibration suite in `test/calibration/content-gate-calibration.test.ts`. The missing piece is adversarial/jailbreak coverage, not total absence of tests.
- Database access is parameterized; no user-controlled SQL string interpolation was found in the main request path.
- SSE event payloads are `JSON.stringify`'d (`src/server.ts:275`), which prevents SSE injection via newlines in user text.
- `npm audit --omit=dev` reports zero known production dependency vulnerabilities as of today.

## 6. Implementation horizon

This is more useful as a schedule than as a 23-item total order.

### Before launch

1. Fix anonymous `clubs.join` — email verification before durable token issuance, plus an explicit plan for pre-fix tokens. (§2.1)
2. Harden the LLM content gate — structured output, untrusted-block, second-pass verifier, jailbreak fuzz. (§2.2)
3. Harden the admissions gate — move all variable content out of the system prompt, apply the same hardening. (§2.3)
4. Hard OpenAI dollar kill switches. (§2.5)
5. Decide the edge topology. If we stay direct-to-Railway, explicitly accept that app-layer defenses are doing the real work; if we add Cloudflare, make origin protection real instead of decorative. (§2.4)
6. Real shared-state rate limiting, keyed by `/64` for IPv6, with explicit fail-open vs fail-closed decisions. (§2.4 part b)
7. Strip `requestTemplate` from responses to callers not authorized for the probed action. (§3.1)
8. Build a non-optional pre-flight gate for all paid operations: authorization, ownership resolution, quota, and rate-limit checks complete before any LLM or embedding call. (§2.5, §3.5, §4.11)
9. Add JSON depth/key-count/array caps. (§3.3)
10. Tighten text field caps, including uncapped `parseRequiredString` consumers, and cap OpenAI input independent of storage limits. (§3.4)

### Within first week

1. Move the admin plane to a backend-proxy architecture and document the current Vercel/browser trust boundary. (§3.7)
2. Add semantic-search rate limits and hook aggregate spend into the same budget infrastructure as §2.5. (§4.11)
3. CORS allowlist + security headers. (§3.6)
4. Rate-limit `/api/schema`. (§4.1)
5. Rate-limit `/skill`. (§4.1)
6. Add DB-pool monitoring and explicit scale assumptions to `/stream`. (§4.2)
7. Enforce structural club-scoping on embedding queries. (§4.3)
8. Hide the version oracle on `/`. (§4.4)
9. Add outage-path regression tests for both `skipped/no_api_key` and `failed/provider_error`. (§4.6)

### Within first month

1. Run the API container as non-root. (§3.8)
2. Ship a log-hygiene policy. (§4.9)
3. Ship a secret-rotation runbook. (§4.10)

Parallel track in the same launch window: split DB privilege — migration role, runtime role, worker roles, migrations run from a separate job. (§3.2)

The only items I would personally refuse to launch without are the "Before launch" list plus active progress on the DB-privilege split.

## 7. Validation

Before declaring any item fixed:

- Add an integration test that exercises the failure mode and asserts the new control blocks it.
- For the LLM gate work, extend the existing real-LLM anchor suite and calibration suite with jailbreak cases; do not build a second disconnected test harness.
- For the LLM gate work, a jailbreak corpus must stay green in CI.
- For rate limiting, tests must run behind a reverse-proxy fixture with Railway-style and Cloudflare-style headers, and assert correct `/64` bucketing.
- For OpenAI kill switches, a synthetic-load test must actually drive spend to the cap and confirm requests refuse.
- For the Cloudflare origin lock, a staging test must confirm that direct-to-Railway requests bypassing Cloudflare are rejected.
- For the `requestTemplate` fix, add a regression test that unauthenticated and member-level callers cannot learn superadmin input shapes from 400 responses.
- For the paid-operation pre-flight work, add tests that prove unauthorized `threadId` / `entityId` writes and quota-blocked writes fail before any LLM call is made.
- After all P0 items ship, an external pen test on a staging environment that matches production topology. Not just automated scanning — humans trying to break things.

## 8. Things explicitly out of scope of this report

- Social-engineering attacks on Owen, admins, or clubadmins. Real risk, separate discipline.
- Physical, endpoint, and laptop-security controls for people with admin credentials.
- The business question of whether invitation-only launch for the first public phase is strategically right. Security-wise it would buy time; that is a product call.
- Anything about the admin dashboard repository, which is not in this working tree.

## 9. External sources used to sanity-check this report

These links support the infrastructure and model-behavior claims above. The code findings still matter more than the external docs; the docs are here to keep the non-code advice honest.

- Railway public networking docs: [Public networking](https://docs.railway.com/networking/public-networking). Railway documents client-IP forwarding via `X-Real-IP` on public ingress.
- Railway network limits/docs: [Specs & limits](https://docs.railway.com/networking/public-networking/specs-and-limits). Railway's standing docs still frame their protection as network-layer and still recommend Cloudflare if you need WAF functionality.
- Railway incident report: [Improving reliability and reducing risk after our February DDoS incident](https://blog.railway.com/p/ddos-incident-review-and-prevention-plan). Railway says all customer workloads are now behind Fastly's WAF with automated DDoS mitigation after the February 2026 incident.
- Railway private networking docs: [How private networking works](https://docs.railway.com/networking/private-networking/how-it-works). Railway states private-network traffic stays inside Railway infrastructure and is not exposed to the public internet.
- Cloudflare origin header docs: [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/). Cloudflare documents `CF-Connecting-IP` as the client IP seen by the origin and recommends origin apps/logs prefer `CF-Connecting-IP` or `True-Client-IP` over `X-Forwarded-For`.
- Cloudflare origin-protection docs: [Protect your origin server](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/) and [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/). Cloudflare documents the difference between putting its edge in front of an origin and actually preventing direct origin access.
- OpenAI structured output docs: [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs). OpenAI documents strict JSON-schema output (`strict: true`) as the structured-output mechanism to prefer when the caller needs a machine-validated shape.
- OpenAI model docs: [GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano). OpenAI documents current `gpt-5.4-nano` capabilities, including structured-output support and current pricing, which matters for the spend-cap discussion.

---

If you read only one sentence of this document: the anonymous-join hole is the foundation crack. Fix it first, because every other per-token defense you have or will build assumes it is already fixed, and right now it isn't.
