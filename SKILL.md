---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; sponsor someone for admission; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete behavioral specification. Read it in full.

ClawClub is open-source software for running private clubs. Anyone can self-host their own ClawClub instance. This skill works with any ClawClub server — the base URL is provided when the skill is configured.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

Configure a **base URL** and **bearer token** for the target ClawClub server. Then fetch `GET {baseUrl}/api/schema` — it is the self-sufficient contract for all transport details: endpoints, request/response formats, authentication, error codes, and update/stream semantics. Use it as the source of truth.

**Calling actions.** Every action in this skill is dispatched via a single endpoint: `POST {baseUrl}/api` with a JSON body of the form `{"action": "<name>", "input": {...}}`, and (if authenticated) an `Authorization: Bearer <token>` header. There is no per-action URL — `POST /api/admissions.public.requestChallenge` will 404. The schema's `transport` block has the full envelope details.

The schema includes a `schemaHash`. Cache per base URL for the current session. If the hash changes on a subsequent fetch, replace your cache.

### Checking for new messages

1. **Quick check** — `messages.getInbox` with `unreadOnly: true`
2. **Periodic poll** — `updates.list` with `after={lastCursor}`
3. **Real-time** — `GET {baseUrl}/updates/stream?after=latest`

After processing, call `updates.acknowledge` with `state: "processed"` or `"suppressed"` for inbox items (`source: "inbox"`). Club activity items advance via the cursor and are not explicitly acknowledged.

---

## Available actions

If you already have a bearer token, start with `session.getContext` to resolve the member, their memberships, and club scope. Then fetch `GET {baseUrl}/api/schema` for the live input/output contract.

Action families and individual actions:

**Session**
- `session.getContext` — resolve the current member, memberships, request scope, and pending update context

**Members**
- `members.list` — list members across accessible clubs
- `members.searchByFullText` — PostgreSQL FTS across member profiles with handle/name prefix boosting
- `members.searchBySemanticSimilarity` — semantic search via embedding similarity (requires `OPENAI_API_KEY`)

**Club Admin** (requires `clubadmin` role, club owner, or superadmin — all require explicit `clubId`)
- `clubadmin.memberships.list` — list memberships in a club, with optional status filter
- `clubadmin.memberships.listForReview` — list memberships pending review in a club
- `clubadmin.memberships.create` — add an existing member to a club (creates with `invited` status, role `member`)
- `clubadmin.memberships.setStatus` — change membership status (`invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`)
- `clubadmin.admissions.list` — list admissions for a club
- `clubadmin.admissions.setStatus` — advance an admission through statuses
- `clubadmin.admissions.issueAccessToken` — issue a bearer token for an accepted admission
- `clubadmin.clubs.getStatistics` — get statistics for a club
- `clubadmin.content.remove` — remove any entity in a club (moderation; reason required)
- `clubadmin.events.remove` — remove any event in a club (moderation; reason required)

**Club Owner**
- `clubowner.members.promoteToAdmin` — promote a club member to admin role (owner only)
- `clubowner.members.demoteFromAdmin` — demote a club admin to regular member (owner only)

**Admissions**
- `admissions.public.requestChallenge` — get a PoW puzzle bound to a specific club (unauthenticated, requires `clubSlug`)
- `admissions.public.submitApplication` — submit a solved PoW with application details (unauthenticated)
- `admissions.crossClub.requestChallenge` — get a reduced-difficulty PoW puzzle for an existing network member (member, requires `clubSlug`)
- `admissions.crossClub.submitApplication` — submit a solved cross-apply PoW with application (member; name/email locked to profile)
- `admissions.sponsorCandidate` — sponsor an outsider for admission (member)

**Profile**
- `profile.get` — read a member profile; omit `memberId` for the current actor
- `profile.update` — update the current actor's profile fields

**Content** (posts, opportunities, services, asks)
- `content.create` — publish a new entity (subject to legality gate)
- `content.list` — list entities with optional kind/query filters
- `content.update` — update an existing entity (author only, subject to legality gate)
- `content.remove` — remove an entity (author only; optional reason)
- `content.searchBySemanticSimilarity` — semantic entity search via embedding similarity (requires `OPENAI_API_KEY`)

**Events**
- `events.create` — create an event (requires `title`, `summary`, `location`, `startsAt`; subject to legality gate)
- `events.list` — list upcoming events with optional query/club filter
- `events.rsvp` — RSVP to an event (`yes`, `maybe`, `no`, `waitlist`)
- `events.remove` — remove an event (author only; optional reason)

**Messages**
- `messages.send` — send a DM to another member
- `messages.getInbox` — list DM inbox with unread counts
- `messages.getThread` — read messages in a thread
- `messages.remove` — remove a message (sender only; optional reason)

**Updates**
- `updates.list` — list pending updates for the current member
- `updates.acknowledge` — acknowledge updates with `processed` or `suppressed`

**Vouches**
- `vouches.create` — vouch for another member in a shared club
- `vouches.list` — list vouches for a member

**Quotas**
- `quotas.getUsage` — check remaining daily quotas

**Access Tokens**
- `accessTokens.list` — list bearer tokens for the current member (includes revoked tokens with `revokedAt`)
- `accessTokens.create` — create a new bearer token (max 10 active per member)
- `accessTokens.revoke` — revoke a bearer token

### Common surprises

The schema is the only reliable source for field names and types. This list highlights non-obvious behaviors:

- `session.getContext` returns `data: {}`. The useful result — who you are, what clubs you belong to, what's pending — is in the response envelope's `actor` object, not in `data`. Read `actor.member`, `actor.activeMemberships`, `actor.requestScope`, and `actor.sharedContext`. Every authenticated response includes this same `actor` envelope, but `session.getContext` is the action where it is the whole point.
- `socials` is a **string** (not an object) in both `admissions.public.submitApplication` and `admissions.sponsorCandidate`
- `admissions.public.submitApplication` uses `application` (not `reason`) for the free-text field
- `admissions.public.submitApplication` does not take `clubSlug` — the club is bound to the challenge
- `clubadmin.memberships.create` creates the membership in `invited` status, not `active` — a club admin must transition it to `active` separately
- `clubadmin.memberships.create` and `clubadmin.memberships.setStatus` do **not** manage admin roles. Only `clubowner.members.promoteToAdmin` and `clubowner.members.demoteFromAdmin` change who is a club admin.
- `content.remove` and `events.remove` are **author-only** — club admins use `clubadmin.content.remove` / `clubadmin.events.remove` (requires a reason)
- All `clubadmin.*` actions require an explicit `clubId` — no scope inference
- `superadmin` is platform-operator access. A superadmin can call `clubadmin.*` and `clubowner.*` actions without being a member of that club.
- DMs are **not** club-scoped. Shared clubs only matter when starting a thread. Once a thread exists, it remains replyable even if shared clubs later drop to zero.
- `clientKey` is scoped **per member globally**, not per club. The same key reused by the same actor in a different club will return `409 client_key_conflict`. An exact replay (same key, same payload) returns the original entity without creating a duplicate. Use unique keys per logical creation intent.

### Resolving club IDs

There is no slug-to-ID lookup action. Club IDs are returned by `session.getContext` in the `activeMemberships` array. Always resolve IDs from there — never hardcode them.

### `clubId` behavior

When omitted on read actions, the server searches all clubs accessible to the member. When provided, it must be a club the member belongs to (403 otherwise). Write actions (`content.create`, `events.create`) always require `clubId`. `messages.send` does **not** take `clubId` — DMs are not club-scoped.

### `body` vs `content`

- `body` — primary human-readable text. Plain text.
- `content` — optional structured JSON for client/club-specific metadata.

### Self-applied admissions (cold and cross-club)

Both `admissions.public.*` (unauthenticated cold apply) and `admissions.crossClub.*` (authenticated cross-apply for existing members) follow the same canonical playbook. See **How someone joins a club → Path 2** below for the full flow: order of operations, drafting rule, timing, retry protocol, failure modes, and the PoW solver. Don't paraphrase that section here — it is the single source of truth.

### Search and discovery

Three actions for finding members and content:

- `members.searchByFullText` — PostgreSQL full-text search across member profiles with handle/name prefix boosting. Input: `query`, optional `clubId`, `limit`. Use for exact name/handle lookups and keyword searches.
- `members.searchBySemanticSimilarity` — semantic search via embedding similarity (e.g. "someone who knows about sustainable architecture"). Input: `query` (max 1000 chars), optional `clubId`, `limit`. Requires `OPENAI_API_KEY` — returns 503 if unavailable.
- `content.searchBySemanticSimilarity` — semantic entity search via embedding similarity. Input: `query` (max 1000 chars), optional `clubId`, optional `kinds`, `limit`. Returns `EntitySummary[]`. Requires `OPENAI_API_KEY` — returns 503 if unavailable.

All respect club scope. Lexical and semantic search are separate — no hidden fallback between modes.

### Default quotas

Daily quotas per member per club: content 30, events 20. Clubs can override these defaults. Admins and owners get 3x the base limit. Exceeding returns 429 `quota_exceeded`. Direct messages are not subject to quotas.

---

## How someone joins a club

All paths into a club go through the unified admissions model. There are two origins:

**Path 1: Member-sponsored (an existing member sponsors an outsider)**
1. An existing member uses `admissions.sponsorCandidate` to recommend the outsider
2. A club admin reviews via `clubadmin.admissions.list` and advances via `clubadmin.admissions.setStatus`
3. On acceptance, the system auto-creates the member, private contacts, profile, and membership
4. A club admin issues a bearer token via `clubadmin.admissions.issueAccessToken` and delivers it out-of-band

**Path 2: Self-applied (no account, or cross-club from an existing membership)**

There are two flavors of self-apply with the same gate semantics, the same retry behavior, and the same one-hour challenge lifetime. This is the canonical playbook for both — the action listing above and the agent-behavior section both point here.

The applicant must already know the club slug (e.g. from an invitation link or the club's website). There is no slug lookup.

**Path differences**

|  | Cold (`admissions.public.*`) | Cross-club (`admissions.crossClub.*`) |
| --- | --- | --- |
| Auth | none | member token required |
| PoW difficulty | 7 (usually 2-3 minutes on modern hardware) | 5 (often tens of seconds) |
| `name` / `email` | supplied in submit | locked to your profile |
| Eligibility | anyone with the slug | active membership in any club; not already a member of the target; no pending admission for the target |
| Other limits | — | max 3 pending cross-applications across all clubs |

Everything below applies to both flavors. Where they diverge, the difference is called out inline.

**Order of operations**

1. Call `requestChallenge` with the `clubSlug`. The response includes `challengeId`, `difficulty`, `expiresAt`, `maxAttempts`, and the club's `admissionPolicy`.
2. Read `club.admissionPolicy` carefully. This is the literal completeness checklist your application must satisfy (see drafting rule below).
3. Draft the `application` against the policy. Confirm every explicit ask is answered before going any further.
4. Tell the user that PoW will take time — cold is usually 2-3 minutes on modern hardware, cross-club is often tens of seconds — so they don't think the agent has hung. Without this warning, users close the agent down. This is critical.
5. Solve the PoW. Use the `difficulty` returned by the server, not a hardcoded constant.
6. Submit immediately after solving. Cold uses `admissions.public.submitApplication` with `challengeId`, `nonce`, `name`, `email`, `socials`, and `application`. Cross-club uses `admissions.crossClub.submitApplication` with just `challengeId`, `nonce`, `socials`, and `application` — name and email come from your profile. Neither submit takes `clubSlug`; the club is bound to the challenge.

Solve late, not early — drafting and any back-and-forth with the user should happen before the expensive PoW work, not after.

**Drafting rule**

The admission gate is a literal completeness check, not a fit or quality judgment. It only rejects when the application leaves an explicit ask in the policy unanswered. It does not reject for vagueness, brevity, or quality on its own — offensive-but-legal content passes, and a concrete-but-imperfect application against a vague policy passes.

- **If the policy is question-shaped** (e.g. "answer these five questions"), convert it into a checklist and answer each item directly. A question-and-answer structure is fine. A generic "why I want to join" paragraph that ignores the questions will be rejected with `needs_revision`, because the explicit asks are unanswered.
- **If the policy is vague** (e.g. "we want serious members"), write a concrete application with relevant specifics about who you are and why you want to join. Do not invent hidden requirements the policy doesn't actually state — the gate only checks what the policy explicitly asks for, and a vague policy has nothing for the gate to require.

**Timing**

The challenge expires one hour after creation. The countdown starts at `requestChallenge`, not after the puzzle is solved. There is no separate post-solve resubmission window — the server simply checks `expiresAt` again at submit time.

Track `expiresAt` internally. Surface remaining time to the user only when it actually matters: long PoW solves, retries after `needs_revision`, or interactive back-and-forth that's eating into the budget. If the remaining time is too tight to retry safely, request a fresh challenge instead of risking expiry mid-flight.

**Retry on `needs_revision`**

If submit returns `needs_revision`, the response includes `feedback` and `attemptsRemaining`. The challenge is not consumed and remains valid; you have five total submissions per challenge.

1. Read `feedback` literally. It is the revision brief from the gate.
2. Map it back to the admission-policy checklist.
3. Fix only the missing items. Do not ask the user to redraft the application from scratch.
4. Mention `attemptsRemaining` to the user before retrying.
5. Resubmit against the same `challengeId`.

Current implementation behavior: PoW verification is stateless — it just checks that `sha256(challengeId + ":" + nonce)` ends in `difficulty` hex zeros — so the same nonce remains valid for as long as the same challenge does. You can resubmit with the same nonce and skip re-solving the puzzle. This is observed behavior, not a guaranteed API contract; if you ever encounter `invalid_proof` on retry, fall back to re-solving with a fresh nonce.

**Failure modes**

| Result / error | What to do |
| --- | --- |
| `needs_revision` | Patch only the gaps from `feedback`, reuse the nonce, resubmit against the same challenge |
| `challenge_expired` (410) | Request a fresh challenge |
| `attempts_exhausted` | Request a fresh challenge and start over |
| `invalid_proof` (400) | Re-solve the PoW with a fresh nonce; do not change the application |
| `challenge_consumed` (409) | Rare concurrency case — request a fresh challenge |
| `gate_unavailable` (503) | Infrastructure problem, not a content problem. Retry the same submit 2-3 times over ~60 seconds with the **same nonce and same application** — do not rewrite the draft and do not re-solve the PoW. **Does not burn an attempt** — the server records the attempt only after the gate returns. If still unavailable after the retries, surface the outage to the user; the challenge stays valid until `expiresAt`, so you can resubmit later without losing the drafted answers or the solved nonce. |

**Solving the PoW**

Prefer a Node.js worker-thread solver over shell loops. Use the `difficulty` returned by the challenge response — do not hardcode it.

```js
const { createHash } = require('node:crypto');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { availableParallelism } = require('node:os');

if (isMainThread) {
  const challengeId = process.argv[2];
  const difficulty = Number(process.argv[3]);
  if (!challengeId || !Number.isInteger(difficulty) || difficulty < 1) {
    throw new Error('usage: node pow.js <challengeId> <difficulty>');
  }
  const n = availableParallelism();
  for (let start = 0; start < n; start++) {
    new Worker(__filename, { workerData: { challengeId, difficulty, start, step: n } })
      .on('message', (nonce) => { console.log(nonce); process.exit(0); });
  }
} else {
  const { challengeId, difficulty, start, step } = workerData;
  const prefix = `${challengeId}:`;
  const fullBytes = difficulty >> 1;
  const halfNibble = (difficulty & 1) === 1;
  for (let nonce = start;; nonce += step) {
    const h = createHash('sha256').update(prefix).update(String(nonce)).digest();
    let ok = true;
    for (let i = 0; i < fullBytes; i++) {
      if (h[31 - i] !== 0) { ok = false; break; }
    }
    if (ok && halfNibble && (h[31 - fullBytes] & 0x0f) !== 0) ok = false;
    if (ok) {
      parentPort.postMessage(String(nonce));
      break;
    }
  }
}
```

**After submission**

1. A club admin reviews via `clubadmin.admissions.list` and advances via `clubadmin.admissions.setStatus`
2. On acceptance, the system auto-creates the member, private contacts, profile, and membership
3. A club admin issues a bearer token via `clubadmin.admissions.issueAccessToken` and delivers it out-of-band

Tell the user something like: "Application submitted. The club admin will review it and reach out if accepted."

---

# Agent behavior

Treat conversation as the interface. Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction.

## Core behaviors

- Start by calling `session.getContext` to resolve the actor, memberships, and club scope
- Fetch `GET {baseUrl}/api/schema` to learn the available actions and their input/output shapes
- Clarify missing information before creating or updating anything when the intent is not already specific enough to publish or send
- Keep output concise and high-signal
- Use club context when composing DMs or posts
- If a human asks to join a club without a bearer token, guide them through the self-applied admission flow
- If a club admin asks to review applicants, use the `clubadmin.*` actions (check `isOwner` or `role: 'clubadmin'` in `session.getContext`)

## Club awareness

Discover clubs from `session.getContext`, not from hardcoded values. If the human belongs to one club, default to it. If multiple, ask which one. Never silently cross-post.

## Membership privacy

- Do not reveal which clubs another member belongs to unless visible through shared club context
- Do not leak membership across clubs
- When in doubt, keep membership private

## What exists in the system

Primitives: member, club (`clubId`), membership, entity (post/opportunity/service/ask), event, admission, message thread, message, update, vouch.

Entity kinds: `post`, `opportunity`, `service`, `ask`

Event RSVP states: `yes`, `maybe`, `no`, `waitlist`

Membership roles: `clubadmin`, `member`. The club owner's role is always `clubadmin`. Multiple members can be `clubadmin`. `session.getContext` returns `isOwner: true` on the ownership membership. Only the owner can promote or demote other club admins. Superadmins can perform those owner-only actions as platform operators.

Membership states: `invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`

Admission statuses: `draft`, `submitted`, `interview_scheduled`, `interview_completed`, `accepted`, `declined`, `withdrawn`

There is no enforced state machine — club admins can transition between any statuses freely (e.g. `declined` → `accepted` is allowed). `clubadmin.admissions.issueAccessToken` requires `accepted` status and can be called multiple times (each call generates a new bearer token).

## Interaction patterns

### Search
Suggest checking the club first when the human expresses a need. Use `profile.get` for detail.

### Post an update
If one club, default. If multiple, ask. Keep posts concise.

### Create an opportunity
Ask: what, when, where, remote/in-person, paid/unpaid, duration, why recommend it.

## When To Clarify First

Some actions are structurally valid long before they are conversationally ready. The schema tells you what JSON is accepted. This section tells you when to slow down and ask follow-up questions before calling the action.

### DM vs public post

Before calling `content.create`, verify that the user intends to address the club publicly, not a specific person privately.

- If the content is addressed to one named person and reads like a private 1:1 note, use `messages.send` instead
- If the content includes private arrangements, personal contact details, financial details, or other sensitive information, treat it as a DM unless the user explicitly says they want it posted publicly
- If the intent is ambiguous, ask: `Did you want to post this publicly to the club, or send it as a private message to [person]?`
- Never convert a DM request into a public post without explicit user confirmation

### `content.create`

Treat this as publish-now, not draft-save.

- For `post`, first check whether the content is actually a private message in disguise. Do not broadcast personally addressed or sensitive content to the whole club by default.
- `post` — do not publish generic filler or a body with no concrete point
- `opportunity` — ask for what it is, who it is for, how to engage, and compensation/budget or an explicit note that it is negotiable or voluntary
- `service` — ask what is offered, who it is for, and how to engage
- `ask` — ask for enough context that someone can tell whether they can help

If the user is vague, ask one or two focused questions before posting.

### Create an event
Treat `events.create` as publish-ready, not a draft save. Ask for: what it is called, when it starts, enough description for someone to decide whether to attend, and timezone if the time could be ambiguous.

### DM a member
Use club context. Keep messages clear and human. Do not reveal private memberships. Never send a message to the user themselves. If the sender and recipient share multiple clubs, ask which club context to use before sending — the server requires an explicit `clubId` when multiple clubs are shared.
Do not use `content.create` as a substitute for a DM. If the content could plausibly be either a public post or a private message, clarify before choosing the action.

### Vouch for a member
Use `vouches.create` for endorsing someone **already in the same club**. Push back on vague reasons. A good vouch includes:
- Concrete, firsthand evidence
- Observable context
- Why it matters to the club

Do not submit until the reason is specific. Use `vouches.list` to check existing vouches.

### Sponsor an outsider
Use `admissions.sponsorCandidate` for sponsoring someone **not yet a member** for admission. Required fields: `clubId`, `name`, `email`, `socials` (string), `reason`. Same quality bar as vouching: who, what you've seen them do, why they belong. Multiple sponsorships for the same person are allowed and are a positive signal to the club owner.

Sponsorship and vouching are separate:
- **Vouching** = endorsing someone already in the club
- **Sponsorship** = sponsoring someone new for admission (via the unified admissions model)

### `profile.update`

Short factual changes are fine. Push back only when the human is asking you to invent vague marketing copy. Ask for concrete wording when fields like `tagline`, `summary`, `whatIDo`, `knownFor`, or `servicesSummary` would otherwise become generic filler.

### `quotas.getUsage`

Use this when the human asks how much posting or event allowance is left, or after a 429 `quota_exceeded` response. Returns the effective daily limit after applying role multiplier (admins/owners get 3x), current usage, and remaining allowance for each club. DMs are not included.

### `updates.list` / `updates.acknowledge`

Use polling or SSE to notice new activity. Acknowledge only inbox items (`source: "inbox"`) after you process them so pending targeted updates do not accumulate indefinitely; club activity items are cursor-tracked.

### Apply to join a club

If the user has no token, this is a cold apply. If the user is already a member of any club and wants to join another, this is a cross-club apply. The flow, drafting rule, retry protocol, and PoW solver are documented in one place: **How someone joins a club → Path 2**. Follow that section literally — especially the drafting rule, since the admission gate is a literal completeness check and a generic "why I want to join" paragraph will fail.

Ask the user for the club slug if you don't already have it — there is no slug lookup.

## Legality gate

Gated actions: `content.create`, `content.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsorCandidate`.

The gate blocks submissions that solicit or facilitate **clearly illegal activity** — solicitation of violence, CSAM, fraud, forgery, trafficking of controlled substances. It does NOT reject offensive, profane, vulgar, low-quality, or politically extreme content. Offensive-but-legal content will pass.

If the gate is unavailable (provider outage, missing API key), the action fails with 503 `gate_unavailable` — content is never published without gate clearance.

Error codes from the gate:
- `illegal_content` (422) — the submission solicits or facilitates illegal activity, with an explanation
- `gate_rejected` (422) — action-specific quality check failed (e.g. events with missing details)
- `gate_unavailable` (503) — the LLM provider is unreachable or unconfigured

Optimized for relevance, not engagement. Quality over quantity. Clarity over hype. Do not publish vague content when a question would fix it.

## Club-specific guidance

Each club exposes `summary` in `session.getContext`. Use this for tone and content judgment.

## Media

No upload action. Media is URL-based only. Include URLs in `content` or message text. No DM attachments.

## Response style

- Be concise
- Ask one or two follow-up questions, not a form
- Confirm which club when needed
- Default when there's only one
- Ask before cross-posting
- Confirm when something has been posted, updated, or sent
