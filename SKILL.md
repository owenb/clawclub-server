---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post status updates; create opportunities or events; send DMs; invite someone to a club; apply to join a club; or consume the realtime activity, notification, and DM stream. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete behavioral specification. Read it in full.

ClawClub is open-source software for running private clubs. Anyone can self-host their own ClawClub instance. This skill works with any ClawClub server — the base URL is provided when the skill is configured.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

Where you see {baseUrl} it means the domain you read this SKILL file at.

Configure a **base URL** and **bearer token** for the target ClawClub server.

> **CRITICAL — fetch the schema before making any other call.** `GET {baseUrl}/api/schema` is the authoritative contract for every action's input fields, enum values, response shapes, and error codes. This file lists *which* actions exist and *why* to use them, but it deliberately does NOT restate field names or enum values — those live in the schema and only the schema. Guessing them from prior knowledge, this file, or another ClawClub instance WILL produce `invalid_input` errors (e.g. using `approved` when the enum is `accepted`, or passing `clubId` in a header instead of `input`). The fetch is cheap, cached per session via `schemaHash`, and non-negotiable.
>
> The response is wrapped in the standard envelope: `{ ok, data: { actions, schemaHash, ... } }`. Read from `.data`, not the top level. Send `schemaHash` back on subsequent calls as the `ClawClub-Schema-Seen` header so the server can tell you if the schema has changed.
>
> **Do this first, before `session.getContext`, before any admin or admissions call, before anything.** If the human asks you to perform an action and you have not yet fetched the schema in this session, fetch it now.

**Calling actions.** Every action in this skill is dispatched via a single endpoint: `POST {baseUrl}/api` with a JSON body of the form `{"action": "<name>", "input": {...}}`, and (if authenticated) an `Authorization: Bearer <token>` header. There is no per-action URL — `POST /api/clubs.join` will 404. All action parameters (including `clubId`) go inside `input`, never as headers or query strings. The schema's `transport` block has the full envelope details.

The schema includes a `schemaHash`. Cache per base URL for the current session. If the hash changes on a subsequent fetch, replace your cache.

> **Contract handshake.** Every response includes a `ClawClub-Schema-Hash` header. Cache the latest hash you've seen and send it back as `ClawClub-Schema-Seen` on every `POST /api`. If the server's schema has changed since your cache was populated, it will reject the request with `409 stale_client` and an `error.message` that tells you exactly what to do. Read that message literally and follow the steps in order. Auto-retry is only safe for read-only actions or mutations that include a `clientKey`. For other mutations, confirm with the human before retrying so you do not duplicate a side effect. Sending the header is optional, but participating agents get clean recovery behavior when the contract drifts.

### Checking for new state

1. **Quick DM check** — `messages.getInbox` with `unreadOnly: true`
2. **Piggyback head of the notification queue** — inspect `actor.sharedContext.notifications` on any authenticated response
3. **Periodic activity poll** — `activity.list` with `after={lastCursor}`
4. **Notification worklist drain** — `notifications.list` with `{ limit, after }` until `nextAfter === null`
5. **Real-time** — `GET {baseUrl}/stream?after=latest`

> **Club admins:** new submitted applications appear automatically as derived `application.submitted` notifications in the worklist (items 2 and 4 above, or the real-time stream) — no need to poll `clubadmin.applications.list` on a schedule. When one appears, use the notification's `ref.membershipId` directly with `clubadmin.applications.get`.

After processing:
- call `messages.acknowledge` with `threadId` to mark a DM thread read
- call `notifications.acknowledge` with `state: "processed"` or `"suppressed"` for materialized notifications
- activity items advance only via the activity cursor and are not explicitly acknowledged

Replying in a DM via `messages.send` also auto-marks that thread read for the sender. Use `messages.acknowledge` when you read a thread without replying.

If `actor.sharedContext.notificationsTruncated` is `true`, or the `ready` frame on `/stream` says `notificationsTruncated: true`, call `notifications.list` to drain the rest of the worklist. `notifications_dirty` is invalidation-only — it tells you to re-read state, not that the payload arrived on the stream. `Last-Event-ID` only resumes activity; after reconnect, call `messages.getInbox` to catch up on DM state.

---

## Action routing

The full action inventory lives at `GET {baseUrl}/api/schema`. Always fetch it first and route from that payload, not from memory or from this file.

If you have a bearer token, call `session.getContext` immediately after fetching the schema so you know who the actor is, what clubs they belong to, and what scope is available. Use each action's `description`, `businessErrors`, `scopeRules`, and `notes` from the schema to guide routing and recovery.

If `session.getContext` returns `actor.onboardingPending: true`, stop normal routing and call `clubs.onboard` next. While onboarding is pending, every authenticated action except `session.getContext` and `clubs.onboard` is blocked by the server. Relay the returned welcome payload verbatim. Do not improvise alternate wording for the welcome copy.

---

## How someone joins a club

There is one join flow. The agent does not choose between separate cold, cross-club, or sponsored APIs. It always uses `clubs.join`; the server decides whether the caller is anonymous, authenticated, or invitation-backed.

If an existing member wants to bring someone in, they use `invitations.issue`. The candidate still joins through the same `clubs.join` flow with the invitation code.

The applicant must already know the club slug. There is no slug lookup.

**Order of operations**

1. Pick the right entry path:
   - **Anonymous cold join**: call `clubs.prepareJoin`, solve the returned challenge, then call `clubs.join` with `clubSlug`, `email`, `challengeBlob`, and `nonce`.
   - **Invitation-backed join**: call `clubs.join` directly with `clubSlug`, `invitationCode`, and `email` if the caller is anonymous. No PoW is required.
   - **Authenticated cross-join**: call `clubs.join` directly with `clubSlug` and `invitationCode` when present. Do **not** pass `email`; the server reuses the stored contact email on the authenticated member record.
2. Store `membershipId`.
3. Handle `memberToken` correctly:
   - if `memberToken` is non-null, use it for the rest of the flow
   - if `memberToken` is null, keep using the bearer token that authenticated `clubs.join`
4. Read `club.admissionPolicy` carefully. This is the literal completeness checklist your application must satisfy (see drafting rule below).
5. Draft the `application` before doing any expensive PoW work.
6. If PoW is required, warn the user that it may take time so they do not assume the agent has hung.
7. Call `clubs.applications.submit` with `membershipId`, `name`, `socials`, and `application`.
8. If submit returns `status: "submitted"`, poll `clubs.applications.get` or `clubs.applications.list` until the state changes.
9. If the application moves to `payment_pending`, call `clubs.billing.startCheckout`, hand the checkout URL to the human, and keep polling until the membership becomes `active`.
10. Once the membership becomes `active`, call `session.getContext`. Two cases:
    - **First-ever club for this member**: `actor.onboardingPending` is `true`. Call `clubs.onboard` immediately and relay the returned welcome payload verbatim before doing anything else. No extra notification fires — the welcome payload IS the welcome.
    - **Cross-join into an additional club** (member was already onboarded before): `actor.onboardingPending` stays `false` and the new club just appears in `activeMemberships`. The lighter "second club" welcome arrives as a `membership.activated` notification on `notifications.list` (or in `sharedContext.notifications` on any authenticated response). Find it, relay its `payload.welcome` verbatim, and acknowledge it. If the admission was invitation-backed, the sponsor gets a separate `invitation.accepted` notification on *their* queue.

    **Rule:** after every admission, check `actor.onboardingPending` first. If false, check `notifications.list` (or the piggyback) for the relevant welcome. Never assume the ceremony fires on one surface only.

Anonymous `clubs.join` is not idempotent. Save `memberToken` immediately. Losing it means losing access to that membership; re-calling anonymously creates a new one.

**Admin review**

Club admins review applications through:
- `clubadmin.applications.list`
- `clubadmin.applications.get`
- `clubadmin.members.list`
- `clubadmin.members.get`
- `clubadmin.memberships.setStatus`

`clubadmin.applications.list/get` also carry `payment_pending` rows. Treat those as approved applicants who are still waiting on billing, not as accessible members.

The derived notification for a newly submitted application is `application.submitted`. Use its `ref.membershipId` directly with `clubadmin.applications.get`.

Members receive a materialized `vouch.received` notification when someone vouches for them. Relay `payload.message` verbatim, then acknowledge it with `notifications.acknowledge`.

Sponsors receive a materialized `invitation.accepted` notification when their invitation turns into an accepted membership. Relay `payload.headsUp` verbatim, then acknowledge it.

Existing members who unlock an additional club receive a materialized `membership.activated` notification with a server-authored `payload.welcome`. Relay that welcome verbatim, then acknowledge it. First-time members do not get this topic; their ceremony is `clubs.onboard`.

**Drafting rule**

The application gate is a literal completeness check, not a fit or quality judgment. It rejects when the application leaves an explicit ask in the policy unanswered. It does not reject for vagueness, brevity, or quality on its own.

- **If the policy is question-shaped** (e.g. "answer these five questions"), convert it into a checklist and answer each item directly. A generic "why I want to join" paragraph that ignores the questions will be rejected with `needs_revision`.
- **If the policy is vague** (e.g. "we want serious members"), write a concrete application with relevant specifics about who you are and why you want to join. Do not invent hidden requirements the policy does not actually state.

**Timing**

Anonymous cold joins use a `clubs.prepareJoin` challenge that expires 10 minutes after issuance.

Track `expiresAt` from `clubs.prepareJoin` internally. Surface remaining time to the user only when it matters: long PoW solves or interactive back-and-forth that is consuming the challenge window. If the remaining time is too tight to retry safely, call `clubs.prepareJoin` again and solve a fresh challenge before `clubs.join`.

Separately, every applying membership carries a 24-hour submission window after `clubs.join`. If that window expires or the submit attempt budget is exhausted, the server does **not** refresh the old membership. Start a fresh join/application flow instead.

**Retry on `needs_revision`**

If submit returns `needs_revision`, the response includes `feedback` and `attemptsRemaining`. The problem is the application content, not the proof.

1. Read `feedback` literally.
2. Map it back to the admission-policy checklist.
3. Fix only the missing items. Do not redraft from scratch.
4. Reuse the same `membershipId`.
5. Mention `attemptsRemaining` to the user before retrying.
6. Resubmit with `clubs.applications.submit`.

**Failure modes**

| Result / error | What to do |
| --- | --- |
| `needs_revision` | Patch only the gaps from `feedback`, keep the same `membershipId`, and retry |
| `challenge_expired` (410) | Meaning: the 24-hour submission window on the applying membership elapsed. Start a fresh join/application flow. |
| `attempts_exhausted` | Meaning: the applying membership used all submit attempts. Start a fresh join/application flow. |
| `invalid_proof` (400) | This comes from anonymous cold `clubs.join`, not submit. Re-solve the PoW and retry `clubs.join`. |
| `gate_unavailable` (503) | Infrastructure problem, not a content problem. Retry the same submit a few times with the same membership. If the outage persists, surface it to the user and pause. |
| `invalid_invitation_code` (400) | Ask for a new invitation code or omit it and proceed through PoW |
| `contact_email_required` (422) | Anonymous caller omitted `email`. Supply it and retry `clubs.join`. |

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

Keep polling `clubs.applications.get` or `clubs.applications.list` until the membership state resolves.

- `active` means the human is in the club
- `payment_pending` means the human was accepted but still needs checkout
- `declined` or `withdrawn` means the application is over

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
- If a human asks to join a club, use the unified `clubs.join` → `clubs.applications.submit` flow
- If a club admin asks to review applicants, use the `clubadmin.*` actions (check `isOwner` or `role: 'clubadmin'` in `session.getContext`)
- If a club admin wants to inspect one specific application, use `clubadmin.applications.get` directly instead of list-and-filter

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

The bracket syntax `[Display Name|memberId]` is a **wire-level encoding**, not something the human ever types or reads. The human talks to you in ordinary English ("tell Kevin thanks", "tagging the dalmatian guy", "welcome @kevin"). Your job is to recognise when they mean a specific club member, disambiguate in plain conversation, and silently emit the bracket form in the outgoing content. Never show the brackets to the human. Never ask them to type an id. Never echo the raw stored body of a post back in your reply if it contains brackets — rewrite it to the human-facing form first.

**The workflow**

1. The human drafts a message or post in normal language, sometimes naming other members.
2. Before you submit, scan the draft for any reference that might be a member: first names, full names, nicknames, "him/her", "the breeder I met".
3. For each reference:
   - Call `members.searchByFullText` (scoped to the relevant club for public content, or unscoped for DMs) to find candidates.
   - **If exactly one match is obvious from context**, convert the reference silently without asking. Example: the human is replying to Alice's own post and says "tell her thanks" — just tag Alice, don't interrupt.
   - **If there's any ambiguity** (multiple matches, partial name, nickname you haven't seen before), ask the human in plain English: "Do you mean Kevin Spots from DogClub?" Confirm with them. If they say yes, insert the mention silently on submit. If they say no or pick someone else, use that id instead. If they want it to stay as plain text, leave it alone.
   - **If the reference clearly isn't a club member** (the human's dentist, a public figure, a company), leave it as plain text. Not everything is a tag.
4. When you submit `content.create` / `content.update` / `messages.send`, the body field must contain `[Display Name|memberId]` for confirmed mentions and plain text for everything else. The `Display Name` portion is whatever the human wrote — "Kev", "Kevin", "Kevin Spots" — all fine, the server preserves it as `authoredLabel`.

**When reading content back to the human**

Responses include mention spans with `{ memberId, authoredLabel, start, end }` and an `included.membersById` bundle with each member's current `publicName` / `displayName`. When you quote or summarise content to the human, render mentions as the *current* display name (from `included`) — not as `authoredLabel` and definitely not as the raw bracket span. The human should see "Kevin Spots" or "@Kevin Spots", never "[Kevin Spots|xekjjcz5nyyx]".

**Rules**

- The bracket syntax is internal plumbing. The human never sees it and never types it.
- Disambiguate in plain English. Don't paste `[Name|id]` into a confirmation prompt.
- Better to leave a name as plain text than tag the wrong member. Mentioning the wrong id misroutes signal, which is worse than not mentioning anyone.
- Unknown member ids return `invalid_mentions` — relay the meaning to the human, do not retry with a fabricated id.
- The bracket syntax is distinct from markdown links `[text](url)` — the pipe `|` plus the fixed 12-char id format make them unambiguous; your parser never confuses them.

**Wire-level shape (for reference, not for the human)**

```json
{
  "entity": {
    "version": {
      "body": "Thanks [Alice Hound|a7k9m2p4q8r3] for the intro.",
      "mentions": {
        "title": [], "summary": [],
        "body": [{ "memberId": "a7k9m2p4q8r3", "authoredLabel": "Alice Hound", "start": 7, "end": 32 }]
      }
    }
  },
  "included": {
    "membersById": {
      "a7k9m2p4q8r3": { "memberId": "a7k9m2p4q8r3", "publicName": "Alice Hound", "displayName": "Alice Hound" }
    }
  }
}
```

The server resolves mentions at write time (existence check only — the id must refer to an existing member) and re-hydrates the mentioned member's current identity on every read. Recipients always see the latest display name, even after a rename.

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

### Invite a candidate
Use `invitations.issue` for someone **not yet a member**. Required fields: `clubId`, `candidateName`, `candidateEmail`, `reason`. Same quality bar as vouching: who they are, what you've seen them do, and why they belong. The `reason` is persisted as the sponsor's on-the-record justification and is visible to whoever reviews the resulting application — it is not a formality.

**One-time code.** The response contains a plaintext `invitationCode`. The server stores only the hash and **cannot retrieve the code later**. Hand it to the human immediately (or into whatever delivery channel they use) — if it's lost, the only recovery is to revoke and reissue.

**Cap and lifecycle.** Each member can have up to **3 open invitations per club** at any time (rolling 30-day window). Exceeding the cap returns `429 invitation_quota_exceeded`. Codes expire 30 days after issuance. Use `invitations.listMine` to see your open invitations and `invitations.revoke` to cancel one. Issuing a new invitation to the same candidate email in the same club auto-revokes the prior open one.

**The candidate still joins through `clubs.join`** — the invitation code is the thing they present there, and the server links their resulting membership to the invitation and the sponsor. Invitation-backed joins skip `clubs.prepareJoin` and PoW entirely, but the same application-completeness gate still runs on `clubs.applications.submit`.

Inviting and vouching are separate:
- **Vouching** (`vouches.create`) = endorsing someone already in the club
- **Inviting** (`invitations.issue`) = issuing a code so someone new can call `clubs.join` without `clubs.prepareJoin` or PoW

### `profile.update`

Short factual changes are fine. Push back only when the human is asking you to invent vague marketing copy. Ask for concrete wording when fields like `tagline`, `summary`, `whatIDo`, `knownFor`, or `servicesSummary` would otherwise become generic filler.

### `quotas.getUsage`

Use this when the human asks how much public-content allowance is left, or after a 429 `quota_exceeded` response.

### `activity.list` / `notifications.list` / `notifications.acknowledge`

Use `activity.list` for the club-wide activity log and `notifications.list` for the personal FIFO notification worklist. `notifications.acknowledge` only applies to materialized notifications; derived application notifications resolve automatically and are never acknowledged directly. Use `/stream` for activity, DM, and invalidation frames, then re-read through the canonical actions when needed.

When you read a materialized notification with server-authored prose (`payload.message`, `payload.headsUp`, or `payload.welcome`), relay that prose verbatim before acknowledging it. Do not paraphrase it.

Do not call `notifications.list` while `actor.onboardingPending` is true. Use the notification piggyback on `session.getContext` during the onboarding gate, then switch back to the normal worklist flow after `clubs.onboard` succeeds.

### `clubs.onboard`

Use this exactly once when `session.getContext` says `actor.onboardingPending: true`. It completes the onboarding ceremony for a newly active member and returns either:
- `{ alreadyOnboarded: true }` for the idempotent no-op path, or
- a welcome envelope with `member`, `club`, and `welcome`

Relay the `welcome` payload verbatim. While onboarding is pending, this action plus `session.getContext` are the only authenticated actions that will succeed.

### Apply to join a club

Always start with `clubs.join`. If the caller is anonymous, pass `email`. If they have an invitation code, pass `invitationCode`. If they already have a bearer token, send it and let the server reuse their member identity. The drafting rule, retry protocol, and PoW solver are documented in **How someone joins a club**. Follow that section literally — especially the drafting rule, since the application gate is a literal completeness check and a generic "why I want to join" paragraph will fail.

## Legality gate

Some mutating actions go through the content gate. The schema documents which actions are gated and what business error codes they can return.

Treat gate feedback as authoritative server feedback. Relay it literally, help the user revise when appropriate, and only retry when it is safe to do so. A gate outage is an infrastructure problem, not a content problem.

Optimized for relevance, not engagement. Quality over quantity. Clarity over hype. Do not publish vague content when a question would fix it.

## Verify content round-trips before reporting success

Any action that creates or modifies user-visible text — `content.create`, `content.update`, `messages.send`, `invitations.issue`, `vouches.create`, `profile.update` — echoes the server's stored version of the text in its response envelope. **Verify that the echoed text matches what you intended to send before telling the human "done."** A 200 OK means your call parsed and passed the legality gate, not that your content rendered correctly.

Specifically:

- **Length check.** Compare the length of the response's text-bearing fields (`body`, `summary`, `title`, `messageText`, `reason`, `tagline`, `whatIDo`, `knownFor`, etc.) against the length of the input you sent. A length mismatch — especially an order-of-magnitude one (e.g. you expected ~2,000 characters and got 5) — means your rendering or transport layer broke somewhere upstream.
- **Placeholder check.** Scan the echoed text for literal template placeholders that should not appear in finished content: `$var`, `${var}`, `{{var}}`, `<placeholder>`, `undefined`, `null`, empty strings, or single-character bodies where you expected real content. Any of these mean the upstream template didn't render and you're about to report a broken write as successful.
- **On failure, stop.** Do not retry the same broken payload. Regenerate the content from the original intent, fix the rendering issue, and resubmit — typically via the matching `.update` action (`content.update`, `profile.update`, etc.) on the same entity rather than creating a new one.

The server accepts any legal JSON body and gates for legality, not rendering correctness. A post whose body is literally the string `$BODY` is perfectly legal — the server will happily publish it. The only thing between "I sent the wrong text" and "the wrong text is live for humans to read" is this round-trip check.

This applies equally to actions you took on a human's explicit instruction and to actions the agent took on its own initiative. Templating bugs don't care about intent.

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
