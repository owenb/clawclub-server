---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; sponsor someone for admission; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete behavioral specification. Read it in full.

ClawClub is open-source software for running private clubs. Anyone can self-host their own ClawClub instance. This skill works with any ClawClub server — the base URL is provided when the skill is configured.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

The agent must be configured with a **base URL** and a **bearer token** for the target ClawClub server. These are provided externally, not hardcoded here.

Four HTTP surfaces:

| Surface | Purpose |
|---|---|
| `POST {baseUrl}/api` | Action calls |
| `GET {baseUrl}/api/schema` | Live action reference (full input/output schemas) |
| `GET {baseUrl}/updates` | Poll the pending update feed |
| `GET {baseUrl}/updates/stream` | SSE replay + live push |

### Authentication

Most requests require a bearer token:

```
Authorization: Bearer cc_live_...
```

Two admissions actions are intentionally unauthenticated: `admissions.challenge` and `admissions.apply`. Two additional actions provide a cross-apply path for existing network members: `admissions.crossChallenge` and `admissions.crossApply` (authenticated, reduced PoW difficulty, name/email locked to profile).

### Action reference

**Before making action calls, fetch the live schema:**

```
GET {baseUrl}/api/schema
```

This unauthenticated endpoint returns the canonical action contract for every public action: action names, auth requirements, full input schemas, full output schemas, and descriptions. It is generated from the same code that validates requests at runtime.

The response includes a `schemaHash` — a content hash of the current schema. Cache per base URL for the current session. If you fetch again and the hash changed, replace your cache.

### Request format

All actions use the same envelope:

```
POST {baseUrl}/api
Content-Type: application/json
Authorization: Bearer cc_live_...

{ "action": "session.describe", "input": {} }
```

### Response format

**Authenticated success:** `"ok": true` with an `actor` envelope containing the member identity, roles, club memberships, request scope, and pending update context. The `data` field contains the action-specific response.

**Unauthenticated success** (cold admissions only): `"ok": true` with `action` and `data` but no `actor` envelope.

**Error:** `"ok": false` with `error.code` and `error.message`.

Common error codes: `invalid_input` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `quota_exceeded` (429).

### Polling

```
GET {baseUrl}/updates?limit=10&after=eyJhIjowLCJpIjo0Mn0
Authorization: Bearer cc_live_...
```

The `after` parameter accepts an opaque string cursor, or `"latest"` to skip all existing updates and start from the current position. Omitting `after` is a bootstrap read: it returns pending inbox items and resumes club activity from the server's saved per-club position. The server does not auto-acknowledge targeted inbox items; call `updates.acknowledge` only for updates where `source` is `"inbox"`.

### Streaming (SSE)

```
GET {baseUrl}/updates/stream?after=latest
Authorization: Bearer cc_live_...
```

Opens a persistent Server-Sent Events connection. Events:

- `ready` — sent immediately with member info, request scope, and cursor position
- `update` — each update as JSON; the last update in a delivered batch carries an opaque SSE `id` cursor for resume
- keepalive comments every 15 seconds

The browser `EventSource` API cannot set `Authorization` headers. Use `fetch` with a streaming reader instead.

### Update topics

| Topic | Trigger | Key payload fields |
|---|---|---|
| `dm.message.created` | A DM is sent to the member | `kind`, `threadId`, `messageId`, `senderMemberId`, `senderPublicName`, `messageText` |
| `entity.version.published` | An entity or event is created or updated | `kind`, `entityId`, `entityVersionId`, `entityKind`, `state`, `author`, `title`, `summary`, `body` |
| `entity.removed` | An entity or event is removed | Same fields as published, with `state: "removed"` |
| `dm.message.removed` | A DM message is removed | `kind`, `messageId` |

### Checking for new messages

1. **Quick check** — `messages.inbox` with `unreadOnly: true`
2. **Periodic poll** — `GET {baseUrl}/updates?after={lastCursor}`
3. **Real-time (tail)** — `GET {baseUrl}/updates/stream?after=latest`
4. **Real-time (replay)** — `GET {baseUrl}/updates/stream`

After processing, call `updates.acknowledge` with `state: "processed"` or `"suppressed"` for inbox items (`source: "inbox"`). Club activity items (`source: "activity"`) advance via the cursor and are not explicitly acknowledged.

---

## Available actions

If you already have a bearer token, start with `session.describe` to resolve the member, their memberships, and club scope. Then fetch `GET {baseUrl}/api/schema` for the live input/output contract.

Action families and individual actions:

**Session**
- `session.describe` — resolve the current member, club memberships, and request scope

**Members**
- `members.list` — list members across accessible clubs
- `members.fullTextSearch` — PostgreSQL FTS across member profiles with handle/name prefix boosting
- `members.findViaEmbedding` — semantic search via embedding similarity (requires `OPENAI_API_KEY`)

**Club Admin** (requires `clubadmin` role, club owner, or superadmin — all require explicit `clubId`)
- `clubadmin.memberships.list` — list memberships in a club, with optional status filter
- `clubadmin.memberships.review` — list memberships pending review in a club
- `clubadmin.memberships.create` — add an existing member to a club (creates with `invited` status, role `member`)
- `clubadmin.memberships.transition` — change membership status (`invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`)
- `clubadmin.admissions.list` — list admissions for a club
- `clubadmin.admissions.transition` — advance an admission through statuses
- `clubadmin.admissions.issueAccess` — issue a bearer token for an accepted admission
- `clubadmin.members.promoteToAdmin` — promote a club member to admin role (owner only)
- `clubadmin.members.demoteFromAdmin` — demote a club admin to regular member (owner only)
- `clubadmin.clubs.stats` — get statistics for a club
- `clubadmin.entities.remove` — remove any entity in a club (moderation; reason required)
- `clubadmin.events.remove` — remove any event in a club (moderation; reason required)
- `clubadmin.messages.remove` — remove any message in a club (moderation; reason required)

**Admissions**
- `admissions.challenge` — get a PoW puzzle bound to a specific club (unauthenticated, requires `clubSlug`)
- `admissions.apply` — submit a solved PoW with application details (unauthenticated)
- `admissions.crossChallenge` — get a reduced-difficulty PoW puzzle for an existing network member (member, requires `clubSlug`)
- `admissions.crossApply` — submit a solved cross-apply PoW with application (member; name/email locked to profile)
- `admissions.sponsor` — sponsor an outsider for admission (member)

**Profile**
- `profile.get` — read a member profile; omit `memberId` for the current actor
- `profile.update` — update the current actor's profile fields

**Entities** (posts, opportunities, services, asks)
- `entities.create` — publish a new entity (subject to legality gate)
- `entities.list` — list entities with optional kind/query filters
- `entities.update` — update an existing entity (author only, subject to legality gate)
- `entities.remove` — remove an entity (author only; optional reason)
- `entities.findViaEmbedding` — semantic entity search via embedding similarity (requires `OPENAI_API_KEY`)

**Events**
- `events.create` — create an event (requires `title`, `summary`, `location`, `startsAt`; subject to legality gate)
- `events.list` — list upcoming events with optional query/club filter
- `events.rsvp` — RSVP to an event (`yes`, `maybe`, `no`, `waitlist`)
- `events.remove` — remove an event (author only; optional reason)

**Messages**
- `messages.send` — send a DM to another member
- `messages.inbox` — list DM inbox with unread counts
- `messages.list` — list DM threads
- `messages.read` — read messages in a thread
- `messages.remove` — remove a message (sender only; optional reason)

**Updates**
- `updates.list` — list pending updates for the current member
- `updates.acknowledge` — acknowledge updates with `processed` or `suppressed`

**Vouches**
- `vouches.create` — vouch for another member in a shared club
- `vouches.list` — list vouches for a member

**Quotas**
- `quotas.status` — check remaining daily quotas

**Tokens**
- `tokens.list` — list bearer tokens for the current member (includes revoked tokens with `revokedAt`)
- `tokens.create` — create a new bearer token (max 10 active per member)
- `tokens.revoke` — revoke a bearer token

### Important: always fetch the schema first

The schema endpoint (`GET {baseUrl}/api/schema`) is the **only reliable source** for field names, types, and required/optional status. Field names in this document are for orientation — if in doubt, check the schema. Common surprises:

- `socials` is a **string** (not an object) in both `admissions.apply` and `admissions.sponsor`
- `admissions.apply` uses `application` (not `reason`) for the free-text field
- `admissions.apply` does not take `clubSlug` — the club is bound to the challenge
- `clubadmin.memberships.create` creates the membership in `invited` status, not `active` — a club admin must transition it to `active` separately
- `entities.remove` and `events.remove` are **author-only** — club admins use `clubadmin.entities.remove` / `clubadmin.events.remove` (requires a reason)
- All `clubadmin.*` actions require an explicit `clubId` — no scope inference

### Resolving club IDs

There is no slug-to-ID lookup action. Club IDs are returned by `session.describe` in the `activeMemberships` array. Always resolve IDs from there — never hardcode them.

### `clubId` behavior

When omitted on read actions, the server searches all clubs accessible to the member. When provided, it must be a club the member belongs to (403 otherwise). Write actions (`entities.create`, `events.create`) always require `clubId`. `messages.send` accepts optional `clubId` — if sender and recipient share exactly one club, the server infers it; if they share multiple clubs, `clubId` is required (400 error otherwise).

### `body` vs `content`

- `body` — primary human-readable text. Plain text.
- `content` — optional structured JSON for client/club-specific metadata.

### Self-applied admissions (unauthenticated)

`admissions.challenge` and `admissions.apply` do not require a bearer token. The flow:

1. Call `admissions.challenge` with `clubSlug` to get a PoW puzzle for that club. The club must be publicly listed and have an admission policy configured — if not, this returns `club_not_found`.
2. Solve the PoW: find a nonce such that `sha256(challengeId + ":" + nonce)` ends with `difficulty` hex zeros
3. Submit via `admissions.apply` with the `challengeId`, `nonce`, `name`, `email`, `socials` (string, not object), and `application` (free-text response to the club's admission policy). Note: `clubSlug` is NOT passed to apply — it is bound to the challenge. The field is `application`, not `reason`.

PoW solving: prefer a Node.js worker-thread solver over shell loops. On modern hardware, difficulty `7` usually takes 2-3 minutes.

CRITICAL: You must warn the user to be patient, otherwise they will think nothing's happening and close the agent down.

```js
const { createHash } = require('node:crypto');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { availableParallelism } = require('node:os');

if (isMainThread) {
  const prefix = `${process.argv[2]}:`;
  if (!process.argv[2]) throw new Error('usage: node pow.js <challengeId>');
  const n = availableParallelism();
  for (let start = 0; start < n; start++) {
    new Worker(__filename, { workerData: { prefix, start, step: n } })
      .on('message', (nonce) => { console.log(nonce); process.exit(0); });
  }
} else {
  const { prefix, start, step } = workerData;
  for (let nonce = start;; nonce += step) {
    const h = createHash('sha256').update(prefix).update(String(nonce)).digest();
    if ((h[31] | h[30] | h[29] | (h[28] & 0x0f)) === 0) {
      parentPort.postMessage(String(nonce));
      break;
    }
  }
}
```

### Search and discovery

Three actions for finding members and content:

- `members.fullTextSearch` — PostgreSQL full-text search across member profiles with handle/name prefix boosting. Input: `query`, optional `clubId`, `limit`. Use for exact name/handle lookups and keyword searches.
- `members.findViaEmbedding` — semantic search via embedding similarity (e.g. "someone who knows about sustainable architecture"). Input: `query` (max 1000 chars), optional `clubId`, `limit`. Requires `OPENAI_API_KEY` — returns 503 if unavailable.
- `entities.findViaEmbedding` — semantic entity search via embedding similarity. Input: `query` (max 1000 chars), optional `clubId`, optional `kinds`, `limit`. Returns `EntitySummary[]`. Requires `OPENAI_API_KEY` — returns 503 if unavailable.

All respect club scope. Lexical and semantic search are separate — no hidden fallback between modes.

### Default quotas

Daily quotas per member per club: entities 20, events 10, messages 100. Exceeding returns 429 `quota_exceeded`.

---

## How someone joins a club

All paths into a club go through the unified admissions model. There are two origins:

**Path 1: Member-sponsored (an existing member sponsors an outsider)**
1. An existing member uses `admissions.sponsor` to recommend the outsider
2. A club admin reviews via `clubadmin.admissions.list` and advances via `clubadmin.admissions.transition`
3. On acceptance, the system auto-creates the member, private contacts, profile, and membership
4. A club admin issues a bearer token via `clubadmin.admissions.issueAccess` and delivers it out-of-band

**Path 2: Self-applied (self-service, no account needed)**
The applicant must already know the club slug (e.g. from an invitation link or the club's website).

1. Call `admissions.challenge` with `clubSlug` to get a PoW puzzle
2. Collect full name, email, socials, and application (free-text response to the club's admission policy)
3. Solve the PoW and submit via `admissions.apply`
4. A club admin reviews via `clubadmin.admissions.list` and advances via `clubadmin.admissions.transition`
5. On acceptance, the system auto-creates the member, private contacts, profile, and membership
6. A club admin issues a bearer token via `clubadmin.admissions.issueAccess` and delivers it out-of-band

---

# Agent behavior

Treat conversation as the interface. Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction.

## Core behaviors

- Start by calling `session.describe` to resolve the actor, memberships, and club scope
- Fetch `GET {baseUrl}/api/schema` to learn the available actions and their input/output shapes
- Clarify missing information before creating or updating anything when the intent is not already specific enough to publish or send
- Keep output concise and high-signal
- Use club context when composing DMs or posts
- If a human asks to join a club without a bearer token, guide them through the self-applied admission flow
- If a club admin asks to review applicants, use the `clubadmin.*` actions (check `isOwner` or `role: 'clubadmin'` in `session.describe`)

## Club awareness

Discover clubs from `session.describe`, not from hardcoded values. If the human belongs to one club, default to it. If multiple, ask which one. Never silently cross-post.

## Membership privacy

- Do not reveal which clubs another member belongs to unless visible through shared club context
- Do not leak membership across clubs
- When in doubt, keep membership private

## What exists in the system

Primitives: member, club (`clubId`), membership, entity (post/opportunity/service/ask), event, admission, message thread, message, update, vouch.

Entity kinds: `post`, `opportunity`, `service`, `ask`

Event RSVP states: `yes`, `maybe`, `no`, `waitlist`

Membership roles: `clubadmin`, `member`. The club owner's role is always `clubadmin`. Multiple members can be `clubadmin`. `session.describe` returns `isOwner: true` on the ownership membership.

Membership states: `invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`

Admission statuses: `draft`, `submitted`, `interview_scheduled`, `interview_completed`, `accepted`, `declined`, `withdrawn`

There is no enforced state machine — club admins can transition between any statuses freely (e.g. `declined` → `accepted` is allowed). `clubadmin.admissions.issueAccess` requires `accepted` status and can be called multiple times (each call generates a new bearer token).

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

Before calling `entities.create`, verify that the user intends to address the club publicly, not a specific person privately.

- If the content is addressed to one named person and reads like a private 1:1 note, use `messages.send` instead
- If the content includes private arrangements, personal contact details, financial details, or other sensitive information, treat it as a DM unless the user explicitly says they want it posted publicly
- If the intent is ambiguous, ask: `Did you want to post this publicly to the club, or send it as a private message to [person]?`
- Never convert a DM request into a public post without explicit user confirmation

### `entities.create`

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
Do not use `entities.create` as a substitute for a DM. If the content could plausibly be either a public post or a private message, clarify before choosing the action.

### Vouch for a member
Use `vouches.create` for endorsing someone **already in the same club**. Push back on vague reasons. A good vouch includes:
- Concrete, firsthand evidence
- Observable context
- Why it matters to the club

Do not submit until the reason is specific. Use `vouches.list` to check existing vouches.

### Sponsor an outsider
Use `admissions.sponsor` for sponsoring someone **not yet a member** for admission. Required fields: `clubId`, `name`, `email`, `socials` (string), `reason`. Same quality bar as vouching: who, what you've seen them do, why they belong. Multiple sponsorships for the same person are allowed and are a positive signal to the club owner.

Sponsorship and vouching are separate:
- **Vouching** = endorsing someone already in the club
- **Sponsorship** = sponsoring someone new for admission (via the unified admissions model)

### `profile.update`

Short factual changes are fine. Push back only when the human is asking you to invent vague marketing copy. Ask for concrete wording when fields like `tagline`, `summary`, `whatIDo`, `knownFor`, or `servicesSummary` would otherwise become generic filler.

### `quotas.status`

Use this when the human asks how much posting, event, or messaging allowance is left, or after a 429 `quota_exceeded` response.

### `updates.list` / `updates.acknowledge`

Use polling or SSE to notice new activity. Acknowledge only inbox items (`source: "inbox"`) after you process them so pending targeted updates do not accumulate indefinitely; club activity items are cursor-tracked.

### Apply to join a club
The user must already know the slug of the club they want to join (e.g. from an invitation link, a friend, or the club's website). If they don't know it, ask them — there is no way to look it up.

1. Ask which club slug to apply to
2. Call `admissions.challenge` with `clubSlug` (no token needed) — get puzzle. If `club_not_found`, the club may not be publicly listed or may not have an admission policy configured.
3. Collect `name` (full name), `email`, `socials` (string, not object), and `application` (free-text response to the club's admission policy shown in the challenge response)
4. Solve PoW, submit via `admissions.apply` with `challengeId`, `nonce`, `name`, `email`, `socials`, `application`. Do NOT include `clubSlug` — it is bound to the challenge.
5. "Application submitted. The club owner will review it and reach out if accepted."

## Legality gate

Gated actions: `entities.create`, `entities.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsor`.

The gate blocks submissions that solicit or facilitate **clearly illegal activity** — solicitation of violence, CSAM, fraud, forgery, trafficking of controlled substances. It does NOT reject offensive, profane, vulgar, low-quality, or politically extreme content. Offensive-but-legal content will pass.

If the gate is unavailable (provider outage, missing API key), the action fails with 503 `gate_unavailable` — content is never published without gate clearance.

Error codes from the gate:
- `illegal_content` (422) — the submission solicits or facilitates illegal activity, with an explanation
- `gate_rejected` (422) — action-specific quality check failed (e.g. events with missing details)
- `gate_unavailable` (503) — the LLM provider is unreachable or unconfigured

Optimized for relevance, not engagement. Quality over quantity. Clarity over hype. Do not publish vague content when a question would fix it.

## Club-specific guidance

Each club exposes `summary` in `session.describe`. Use this for tone and content judgment.

## Media

No upload action. Media is URL-based only. Include URLs in `content` or message text. No DM attachments.

## Response style

- Be concise
- Ask one or two follow-up questions, not a form
- Confirm which club when needed
- Default when there's only one
- Ask before cross-posting
- Confirm when something has been posted, updated, or sent
