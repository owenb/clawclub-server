---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post status updates; create opportunities or events; send DMs; sponsor someone for admission; apply to join a club; or consume the realtime activity, notification, and DM stream. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete behavioral specification. Read it in full.

ClawClub is open-source software for running private clubs. Anyone can self-host their own ClawClub instance. This skill works with any ClawClub server — the base URL is provided when the skill is configured.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

Where you see {baseUrl} it means the domain you read this SKILL file at.

Configure a **base URL** and **bearer token** for the target ClawClub server.

> **CRITICAL — fetch the schema before making any other call.** `GET {baseUrl}/api/schema` is the authoritative contract for every action's input fields, enum values, response shapes, and error codes. This file lists *which* actions exist and *why* to use them, but it deliberately does NOT restate field names or enum values — those live in the schema and only the schema. Guessing them from prior knowledge, this file, or another ClawClub instance WILL produce `invalid_input` errors (e.g. using `approved` when the enum is `accepted`, or passing `clubId` in a header instead of `input`). The fetch is cheap, cached per session via `schemaHash`, and non-negotiable.
>
> **Do this first, before `session.getContext`, before any admin or admissions call, before anything.** If the human asks you to perform an action and you have not yet fetched the schema in this session, fetch it now.

**Calling actions.** Every action in this skill is dispatched via a single endpoint: `POST {baseUrl}/api` with a JSON body of the form `{"action": "<name>", "input": {...}}`, and (if authenticated) an `Authorization: Bearer <token>` header. There is no per-action URL — `POST /api/admissions.public.requestChallenge` will 404. All action parameters (including `clubId`) go inside `input`, never as headers or query strings. The schema's `transport` block has the full envelope details.

The schema includes a `schemaHash`. Cache per base URL for the current session. If the hash changes on a subsequent fetch, replace your cache.

> **Contract handshake.** Every response includes a `ClawClub-Schema-Hash` header. Cache the latest hash you've seen and send it back as `ClawClub-Schema-Seen` on every `POST /api`. If the server's schema has changed since your cache was populated, it will reject the request with `409 stale_client` and an `error.message` that tells you exactly what to do. Read that message literally and follow the steps in order. Auto-retry is only safe for read-only actions or mutations that include a `clientKey`. For other mutations, confirm with the human before retrying so you do not duplicate a side effect. Sending the header is optional, but participating agents get clean recovery behavior when the contract drifts.

### Checking for new state

1. **Quick DM check** — `messages.getInbox` with `unreadOnly: true`
2. **Piggyback head of the notification queue** — inspect `actor.sharedContext.notifications` on any authenticated response
3. **Periodic activity poll** — `activity.list` with `after={lastCursor}`
4. **Notification worklist drain** — `notifications.list` with `{ limit, after }` until `nextAfter === null`
5. **Real-time** — `GET {baseUrl}/stream?after=latest`

> **Club admins:** new admission submissions appear automatically as derived `admission.submitted` notifications in the worklist (items 2 and 4 above, or the real-time stream) — no need to poll `clubadmin.admissions.list` on a schedule. When one appears, use the notification's `ref.admissionId` directly with `clubadmin.admissions.get`.

After processing:
- call `messages.acknowledge` with `threadId` to mark a DM thread read
- call `notifications.acknowledge` with `state: "processed"` or `"suppressed"` for materialized notifications
- activity items advance only via the activity cursor and are not explicitly acknowledged

If `actor.sharedContext.notificationsTruncated` is `true`, or the `ready` frame on `/stream` says `notificationsTruncated: true`, call `notifications.list` to drain the rest of the worklist. `notifications_dirty` is invalidation-only — it tells you to re-read state, not that the payload arrived on the stream. `Last-Event-ID` only resumes activity; after reconnect, call `messages.getInbox` to catch up on DM state.

---

## Action routing

The full action inventory lives at `GET {baseUrl}/api/schema`. Always fetch it first and route from that payload, not from memory or from this file.

If you have a bearer token, call `session.getContext` immediately after fetching the schema so you know who the actor is, what clubs they belong to, and what scope is available. Use each action's `description`, `businessErrors`, `scopeRules`, and `notes` from the schema to guide routing and recovery.

---

## How someone joins a club

All paths into a club go through the unified admissions model. There are two origins:

**Path 1: Member-sponsored (an existing member sponsors an outsider)**
1. An existing member uses `admissions.sponsorCandidate` to recommend the outsider
2. A club admin reviews via `clubadmin.admissions.list` and advances via `clubadmin.admissions.setStatus`
3. On acceptance, the system auto-creates the member, private contacts, profile, and membership
4. A club admin issues a bearer token via `clubadmin.admissions.issueAccessToken` and delivers it out-of-band

**Path 2: Self-applied (no account, or cross-club from an existing membership)**

There are two flavors of self-apply with the same gate semantics, the same retry behavior, and the same one-hour challenge lifetime. This section is the canonical playbook for both.

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
5. Solve the PoW. Use the `difficulty` returned by the server, not a hardcoded constant. The canonical rule is: `sha256(challengeId + ":" + nonce)` must end in `difficulty` hex zeros. The server may tolerate a leading-zero compatibility fallback for buggy clients, but agents must still target trailing zeros.
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

Do not tell the user the PoW failed if you received `needs_revision` or `attemptsRemaining`. Those fields mean the server accepted the nonce, evaluated the application, and counted the submission. The problem is the application content, not the proof.

1. Read `feedback` literally. It is the revision brief from the gate.
2. Map it back to the admission-policy checklist.
3. Fix only the missing items. Do not ask the user to redraft the application from scratch.
4. Reuse the same `challengeId` and the same `nonce`. Do not re-solve the PoW unless the server explicitly returns `invalid_proof`.
5. Mention `attemptsRemaining` to the user before retrying.
6. Resubmit against the same `challengeId`.

Current implementation behavior: PoW verification is stateless — canonically it checks that `sha256(challengeId + ":" + nonce)` ends in `difficulty` hex zeros — so the same nonce remains valid for as long as the same challenge does. You can resubmit with the same nonce and skip re-solving the puzzle. The server currently also accepts a leading-zero compatibility fallback, but that is defensive tolerance for buggy clients, not the rule agents should implement.

**Failure modes**

| Result / error | What to do |
| --- | --- |
| `needs_revision` | The PoW already passed. Patch only the gaps from `feedback`, reuse the same nonce, resubmit against the same challenge |
| `challenge_expired` (410) | Request a fresh challenge |
| `attempts_exhausted` | Request a fresh challenge and start over |
| `invalid_proof` (400) | Re-solve the PoW with a fresh nonce; do not change the application |
| `challenge_consumed` (409) | Rare concurrency case — request a fresh challenge |
| `gate_unavailable` (503) | Infrastructure problem, not a content problem. Retry the same submit 2-3 times over ~60 seconds with the **same nonce and same application** — do not rewrite the draft and do not re-solve the PoW. **Does not burn an attempt** — the server records the attempt only after the gate returns. If still unavailable after the retries, surface the outage to the user; the challenge stays valid until `expiresAt`, so you can resubmit later without losing the drafted answers or the solved nonce. |

**Solving the PoW**

Prefer a Node.js worker-thread solver over shell loops. Use the `difficulty` returned by the challenge response — do not hardcode it. The solver below targets the canonical trailing-zero rule.

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

Relay what the server actually said. The `accepted` response includes a `message` field — surface it to the user verbatim. Do not fabricate, paraphrase, or imply a status, interview, or next step the server didn't return; the server's `message` is authoritative.

---

# Agent behavior

Treat conversation as the interface. Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction.

## Core behaviors

- **First call of every session: `GET {baseUrl}/api/schema`.** Non-negotiable. Field names, enum values, and required parameters live there and nowhere else. Skipping this step is the single most common cause of `invalid_input` errors. See "How to connect" for the rationale.
- Note {baseUrl} = whatever URL / domain you read this SKILL file at
- Then call `session.getContext` to resolve the actor, memberships, and club scope
- Clarify missing information before creating or updating anything when the intent is not already specific enough to publish or send
- Keep output concise and high-signal
- Use club context when composing DMs or posts
- If a human asks to join a club without a bearer token, guide them through the self-applied admission flow
- If a club admin asks to review applicants, use the `clubadmin.*` actions (check `isOwner` or `role: 'clubadmin'` in `session.getContext`)
- If a club admin wants to inspect one specific application, use `clubadmin.admissions.get` directly instead of list-and-filter

## Club awareness

Discover clubs from `session.getContext`, not from hardcoded values. If the human belongs to one club, default to it. If multiple, ask which one. Never silently cross-post.

## Membership privacy

- Do not reveal which clubs another member belongs to unless visible through shared club context
- Do not leak membership across clubs
- When in doubt, keep membership private

## Interaction patterns

### Search
Suggest checking the club first when the human expresses a need. Use `profile.list` for detail.

### Post an update
If one club, default. If multiple, ask. Keep posts concise.

### Create an opportunity
Ask: what, when, where, remote/in-person, paid/unpaid, duration, why recommend it.

## Mentions

Both public posts and DMs support literal `@handle` mentions inside plain-text fields (`title`, `summary`, `body` for `content.create` / `content.update`; `messageText` for `messages.send`). The server resolves each mention at write time and **re-hydrates the mentioned member's current identity on every read**, so recipients always see the latest `publicName` and `handle` — even if the mentioned member has renamed since the content was written.

**Use mentions silently** whenever it is crystal clear which specific member the human is referring to. No confirmation prompt, just write the `@handle` inline. If the human is replying to Alice's post and says "tell her thanks", `@alice-hound` is the right call and you should just do it.

**Do NOT guess.** If the human says "tell Kevin I'm in" and you are not 100% sure *which* Kevin — maybe there are multiple Kevins in the club, maybe they mean someone who is not a member at all — leave the name as plain text (`Kevin`). Resolve the ambiguity with a members search first, or just write the name in plain text and let the human correct you. Writing the wrong `@kevin-spots` misroutes the message, which is worse than not mentioning anyone.

The server enforces scope: mentioned handles must belong to active members with access to the target club (for public content) or the conversation (for DMs). Unresolvable handles return `invalid_mentions` with the literal offending handles echoed back in the error message — relay the error to the human, do not retry with a fabricated handle.

On read, mention-bearing responses include a per-field `mentions` array with `memberId` + `authoredHandle` spans plus a deduplicated top-level `included.membersById` bundle. Use `memberId` for any follow-up action input (it is the stable identity). Treat `authoredHandle` as preserved author text — it may differ from the current handle at `included.membersById[memberId].handle` if the mentioned member has since renamed. Never copy `authoredHandle` into a structured input field that expects a member ID.

```json
{
  "entity": {
    "version": {
      "body": "Thanks @alice-hound for the intro.",
      "mentions": {
        "title": [], "summary": [],
        "body": [{ "memberId": "mem_8kg5", "authoredHandle": "alice-hound", "start": 7, "end": 19 }]
      }
    }
  },
  "included": {
    "membersById": {
      "mem_8kg5": { "memberId": "mem_8kg5", "publicName": "Alice Hound", "displayName": "Alice Hound", "handle": "alice-hound" }
    }
  }
}
```

Mentions inside URLs like `https://github.com/@alice` and inside email addresses like `alice@example.com` are never parsed as mentions — boundary rules skip them automatically.

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
- `gift` — ask what is being offered, who it is for, and how someone should take you up on it
- `event` — ask for the title plus an `event` payload with at least location and start time; include end time, timezone, and capacity when relevant

If the user is vague, ask one or two focused questions before posting.

### Create an event
Treat this as publish-ready, not draft-save. Ask for: what it is called, when it starts, where it happens, enough description for someone to decide whether to attend, and timezone if the time could be ambiguous.

### DM a member
Keep messages clear and human. Do not reveal which clubs the recipient belongs to. Never send a message to the user themselves.
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

Use this when the human asks how much public-content allowance is left, or after a 429 `quota_exceeded` response.

### `activity.list` / `notifications.list` / `notifications.acknowledge`

Use `activity.list` for the club-wide activity log and `notifications.list` for the personal FIFO notification worklist. `notifications.acknowledge` only applies to materialized notifications; derived admissions notifications resolve automatically and are never acknowledged directly. Use `/stream` for activity, DM, and invalidation frames, then re-read through the canonical actions when needed.

### Apply to join a club

If the user has no token, this is a cold apply. If the user is already a member of any club and wants to join another, this is a cross-club apply. The flow, drafting rule, retry protocol, and PoW solver are documented in one place: **How someone joins a club → Path 2**. Follow that section literally — especially the drafting rule, since the admission gate is a literal completeness check and a generic "why I want to join" paragraph will fail.

## Legality gate

Some mutating actions go through a legality or quality gate. The schema documents which actions are gated and what business error codes they can return.

Treat gate feedback as authoritative server feedback. Relay it literally, help the user revise when appropriate, and only retry when it is safe to do so. A gate outage is an infrastructure problem, not a content problem.

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
