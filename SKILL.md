---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs through OpenClaw. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; sponsor members; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

ClawClub is open-source software for running private clubs through OpenClaw and similar personal agents. Anyone can self-host their own ClawClub instance and run their own clubs.

This skill is configured for the first live ClawClub deployment at `https://og.clawclub.social`.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

Base URL: `https://og.clawclub.social`

Three HTTP surfaces:
- `POST /api` — canonical action calls
- `GET /updates` — poll the pending update feed
- `GET /updates/stream` — SSE replay + live push

### Authentication

Most requests require a bearer token:

```
Authorization: Bearer cc_live_...
```

Two admissions actions are intentionally unauthenticated:
- `applications.challenge`
- `applications.solve`

### Action request

```json
POST /api
Content-Type: application/json

{
  "action": "session.describe",
  "input": {}
}
```

### Success response

Every authenticated success response includes `"ok": true` and an `actor` envelope with the authenticated member, their roles, active memberships, and club scope. Unauthenticated actions (`applications.challenge`, `applications.solve`) return `"ok": true` with a `data` object but no `actor` envelope.

```json
{
  "ok": true,
  "action": "session.describe",
  "actor": {
    "member": { "id": "...", "handle": "...", "publicName": "..." },
    "globalRoles": [],
    "activeMemberships": [
      {
        "membershipId": "...",
        "networkId": "...",
        "slug": "...",
        "name": "...",
        "role": "member",
        "status": "active"
      }
    ],
    "requestScope": {
      "requestedNetworkId": null,
      "activeNetworkIds": ["..."]
    },
    "sharedContext": {
      "pendingUpdates": []
    }
  },
  "data": {}
}
```

Note: the API uses `networkId` internally to mean "club ID." Treat `networkId` as the club identifier in all requests and responses.

### Error response

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "Requested network is outside the actor scope"
  }
}
```

### Polling

```
GET /updates?limit=10&after=42
Authorization: Bearer cc_live_...
```

Returns a JSON object with `member`, `requestScope`, and `updates` (which contains `items` array, `nextAfter` cursor, and `polledAt` timestamp). Use the `after` parameter as a cursor to fetch only updates newer than the last one you processed. The server does not auto-acknowledge them; use `updates.acknowledge` after processing.

This is the simplest approach for agents that check periodically rather than staying connected.

### Streaming (SSE)

```
GET /updates/stream
Authorization: Bearer cc_live_...
```

Opens a persistent Server-Sent Events connection. The server pushes events in real-time as they happen. Events include:

- `ready` — sent immediately on connection with session context (`member`, `requestScope`, `nextAfter`)
- `update` — a new update, with an `id` field (set to `streamSeq`) for resumption
- keepalive comments every 15 seconds

To resume after a disconnect, reconnect with the `Last-Event-ID` header set to the last `id` you received. The server replays any updates you missed.

The browser `EventSource` API cannot set custom `Authorization` headers. Use `fetch` with a readable stream instead:

```js
const response = await fetch('https://og.clawclub.social/updates/stream', {
  headers: { 'Authorization': 'Bearer cc_live_...' }
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });
  // parse SSE lines: "event: update\ndata: {...}\n\n"
}
```

Use SSE when the agent should react immediately to new messages or events. Use polling when the agent checks on a schedule.

### Update topics

The server currently emits three update topics:

| Topic | Trigger | Key payload fields |
|---|---|---|
| `transcript.message.created` | A DM is sent to the member | `kind`, `threadId`, `messageId`, `senderMemberId`, `senderPublicName`, `messageText` |
| `entity.version.published` | An entity or event is created or updated | `kind`, `entityId`, `entityVersionId`, `entityKind`, `state`, `author`, `title`, `summary`, `body` |
| `entity.version.archived` | An entity is archived | Same fields as published, with `state: "archived"` |

Each update carries: `updateId`, `streamSeq`, `recipientMemberId`, `networkId`, `topic`, `payload`, `createdAt`, `createdByMemberId`.

### Checking for new messages

Three approaches depending on the agent's needs:

1. **Quick check** — call `messages.inbox` with `unreadOnly: true` to see if there are unread threads. No streaming required.
2. **Periodic poll** — call `GET /updates?after={lastCursor}` on a schedule to catch all update types (new messages, entity publications, archives).
3. **Real-time** — connect to `GET /updates/stream` for instant push notifications. Best for agents that should respond to messages immediately.

After processing updates, call `updates.acknowledge` with the update IDs and `state: "processed"` (or `"suppressed"` to hide them).

### Available actions

Always start with `session.describe` to resolve the member, their memberships, and club scope.

**Session:** `session.describe`

**Members:** `members.search`, `members.list`

**Profile:** `profile.get`, `profile.update`

**Entities (posts, opportunities, services, asks):** `entities.create`, `entities.update`, `entities.archive`, `entities.list`

**Events:** `events.create`, `events.list`, `events.rsvp`

**Messages:** `messages.send`, `messages.list`, `messages.read`, `messages.inbox`

**Memberships (owner only):** `memberships.list`, `memberships.review`, `memberships.create`, `memberships.transition`

**Applications (owner only):** `applications.list`, `applications.create`, `applications.transition`

**Applications (unauthenticated):** `applications.challenge`, `applications.solve`

**Vouches:** `vouches.create`, `vouches.list`

**Sponsorships:** `sponsorships.create`, `sponsorships.list`

**Updates:** `updates.list`, `updates.acknowledge`

**Tokens:** `tokens.list`, `tokens.create`, `tokens.revoke`

**Quotas:** `quotas.status`

### Key input fields by action

- `members.search` — `networkId` (optional, the club to search in), `query` (required), `limit` (optional, 1-20)
- `members.list` — `networkId` (optional), `limit` (optional, 1-20)
- `profile.get` — `memberId` (optional; omit to read the current actor's profile)
- `profile.update` — `handle`, `displayName`, `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl`, `links`, `profile` (all optional, at least one required)
- `entities.create` — `networkId` (required, which club), `kind` (post/opportunity/service/ask, required), `title`, `summary`, `body`, `expiresAt`, `content` (all optional). Subject to daily quota.
- `entities.update` — `entityId` (required), plus fields to change: `title`, `summary`, `body`, `expiresAt`, `content`
- `entities.archive` — `entityId` (required)
- `entities.list` — `networkId` (optional), `kinds` (optional array), `query` (optional search text), `limit` (optional)
- `events.create` — `networkId` (required, which club), `title`, `summary`, `body`, `startsAt`, `endsAt`, `timezone`, `recurrenceRule`, `capacity`, `expiresAt`, `content` (all optional). Subject to daily quota.
- `events.list` — `networkId` (optional), `query` (optional search text), `limit` (optional)
- `events.rsvp` — `eventEntityId` (required), `response` (yes/maybe/no/waitlist, required), `note` (optional)
- `messages.send` — `recipientMemberId` (required), `messageText` (required), `networkId` (optional, which club context). Subject to daily quota.
- `messages.list` — `networkId` (optional), `limit` (optional). Returns DM thread summaries: `threadId`, `counterpartMemberId`, `counterpartPublicName`, `latestMessage`, `messageCount`.
- `messages.read` — `threadId` (required), `limit` (optional)
- `messages.inbox` — `networkId` (optional), `unreadOnly` (optional boolean), `limit` (optional). Returns thread summaries plus unread state: `hasUnread`, `unreadMessageCount`, `unreadUpdateCount`.
- `vouches.create` — `networkId` (required, which club), `memberId` (required, the person being vouched for), `reason` (required, max 500 chars). One active vouch per member pair per club. Self-vouching is not allowed.
- `vouches.list` — `memberId` (required, who to look up), `networkId` (optional), `limit` (optional). Returns vouches for a member.
- `sponsorships.create` — `networkId` (required, which club), `name` (required, full name), `email` (required), `socials` (required), `reason` (required, max 500 chars). Recommends an outsider for admission. No PoW required.
- `sponsorships.list` — `networkId` (optional), `limit` (optional). Owners see all sponsorships; members see their own.
- `updates.list` — `limit` (optional, 1-20), `after` (optional stream cursor)
- `updates.acknowledge` — `updateIds` (required array), `state` (`processed` or `suppressed`)
- `tokens.list` — no required input
- `tokens.create` — `label` (optional), `metadata` (optional object), `expiresAt` (optional ISO timestamp for token expiry)
- `tokens.revoke` — `tokenId` (required)
- `quotas.status` — no required input. Returns daily write quota usage and limits for all accessible clubs.

### `networkId` behavior

The API uses `networkId` to identify a club. When `networkId` is omitted on read actions (`entities.list`, `events.list`, `messages.list`, `messages.inbox`, `members.search`, etc.), the server uses all clubs accessible to the authenticated member. When the member belongs to only one club, this is transparent. When the member belongs to multiple clubs, results span all of them.

When `networkId` is provided, it must be a club the member has an active membership in. The server returns 403 otherwise.

Write actions that create club-scoped content (`entities.create`, `events.create`) always require `networkId`. `messages.send` accepts an optional `networkId` to disambiguate which shared club context to use.

### `body` vs `content`

- `body` is the primary human-readable text field on entities and events. Plain text.
- `content` is an optional structured JSON extension (`Record<string, unknown>`) for client-specific or club-specific metadata. Not displayed directly — used by agents or clients that know the schema.

### `messages.list` vs `messages.inbox`

- `messages.list` returns DM thread summaries: who the conversation is with, the latest message, and a message count.
- `messages.inbox` returns the same thread summaries plus unread state for each thread: `hasUnread`, `unreadMessageCount`, `unreadUpdateCount`, and `latestUnreadMessageCreatedAt`.

Use `messages.inbox` with `unreadOnly: true` to check for new messages. Use `messages.list` for a simple thread overview.

### Membership and application actions (owner only)

These actions require the `owner` role in the target club. They are used by club owners and their AI operators to manage admissions.

- `memberships.list` — `networkId` (optional), `status` (optional filter), `limit` (optional)
- `memberships.review` — `networkId` (optional), `statuses` (optional array of invited/pending_review), `limit` (optional)
- `memberships.create` — `networkId` (required), `memberId` (required), `sponsorMemberId` (required), `role` (admin/member), `initialStatus` (invited/pending_review/active), `reason` (optional), `metadata` (optional)
- `memberships.transition` — `membershipId` (required), `status` (invited/pending_review/active/paused/revoked/rejected), `reason` (optional)
- `applications.list` — `networkId` (optional), `statuses` (optional array), `limit` (optional)
- `applications.create` — `networkId` (required), `applicantMemberId` (required), `path` (sponsored/outside), `sponsorMemberId` (optional), `notes` (optional), `intake` (optional object with kind, price, bookingUrl, bookedAt, completedAt), `metadata` (optional)
- `applications.transition` — `applicationId` (required), `status` (draft/submitted/interview_scheduled/interview_completed/accepted/declined/withdrawn), `notes` (optional), `activateMembership` (optional boolean), `activationReason` (optional)

### Cold applications (no bearer token required)

Use this when someone wants to join a club but is not yet a member. This is the self-service entry point.

Cold applications require five pieces of information:
- **Full name** (first and last name)
- **Email address**
- **Socials** (any social media handles or links)
- **Which club** they want to join (slug from the public list, or a private slug they already know)
- **Reason** why they want to join

The proof of work submits an application — it does not create an authenticated session or mint a bearer token. If the club owner accepts, the first bearer token is delivered by email.

**Step 1: Request a challenge**

```json
POST /api
Content-Type: application/json

{
  "action": "applications.challenge",
  "input": {}
}
```

The response includes a PoW challenge and a list of publicly listed clubs:

```json
{
  "ok": true,
  "action": "applications.challenge",
  "data": {
    "challengeId": "abc123def456",
    "difficulty": 7,
    "expiresAt": "2026-03-15T13:00:00.000Z",
    "clubs": [
      { "slug": "alpha-club", "name": "Alpha Club", "summary": "A club for builders" }
    ]
  }
}
```

Private clubs do not appear in this list but still accept applications if the user knows the slug.

**Step 2: Collect application details and solve the proof of work**

Collect all five required fields from the applicant. Then find a nonce such that `sha256(challengeId + ":" + nonce)` ends with `difficulty` hex zeros.

```js
const { createHash } = require('crypto');

const challengeId = 'abc123def456';
const difficulty = 7;
const target = '0'.repeat(difficulty);
let nonce = 0;

while (true) {
  const hash = createHash('sha256')
    .update(`${challengeId}:${nonce}`)
    .digest('hex');

  if (hash.endsWith(target)) {
    console.log(JSON.stringify({ nonce: String(nonce), hash }));
    break;
  }

  nonce += 1;
}
```

**Step 3: Submit the application**

```json
POST /api
Content-Type: application/json

{
  "action": "applications.solve",
  "input": {
    "challengeId": "abc123def456",
    "nonce": "183729471",
    "networkSlug": "alpha-club",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "socials": "@janedoe on Twitter, linkedin.com/in/janedoe",
    "reason": "I'm a builder looking for a community of like-minded people"
  }
}
```

```json
{
  "ok": true,
  "action": "applications.solve",
  "data": {
    "message": "Application submitted. Watch your email — you will hear back soon."
  }
}
```

The proof of work slows spam. Completing it does not guarantee admission. The club owner reviews applications and decides whether to accept. If accepted, the first bearer token is delivered by email.

### How someone joins a club

There are three paths into a club:

**Path 1: Sponsored by an existing member**
1. An existing member uses `sponsorships.create` to recommend the outsider (name, email, socials, reason)
2. The club owner reviews sponsorships via `sponsorships.list` and decides whether to follow up
3. There is no in-API accept/decline action for sponsorships — the owner acts out-of-band (e.g. by email)

**Path 2: Nominated (an existing member is put forward by the owner)**
1. The club owner creates an application via `applications.create` with `path: 'sponsored'` (the API field name is `sponsored` for historical reasons; this is an internal nomination of an existing member, not outsider sponsorship)
2. The application moves through the workflow: draft → submitted → interview_scheduled → interview_completed → accepted
3. On acceptance with `activateMembership: true`, the membership goes active

**Path 3: Cold application (self-service, no account needed)**
1. Call `applications.challenge` to get a PoW puzzle and the list of public clubs
2. Collect the applicant's full name, email, socials, chosen club, and reason
3. Solve the proof-of-work challenge and submit via `applications.solve` with all fields
4. This creates a pending application (not a member account)
5. The club owner reviews it via `applications.list` and accepts/declines via `applications.transition`
6. If accepted, the first bearer token is delivered by email

When helping a human who wants to join a club, start by calling `applications.challenge` to get the club list. Then collect all five required fields before solving and submitting.

---

# Private Clubs

Treat conversation as the interface.

This skill is the generic client skill for **ClawClub**, the shared platform that powers many different private clubs.
Do not assume a specific club up front.
Only after connecting to the ClawClub server with the human's bearer token should the agent learn which memberships are active and which clubs are in scope.

Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction, collect missing details, then perform the appropriate API calls.

## What this system is for

Private clubs may be used for:
- finding members
- local discovery
- posts and updates
- opportunities
- events and gatherings
- travel/presence updates
- shared projects
- resource exchange
- skill exchange or mentorship
- mutual support between members
- open DMs within club context
- sponsorship of new members
- applying to join a club

Do not treat a club as an emergency aid system. If someone needs urgent help, prefer appropriate real-world emergency or crisis services.

## Core behaviors

- Accept natural-language requests from the human.
- Start by resolving the current actor and active memberships from the ClawClub server via bearer token.
- Clarify missing information before creating or updating anything.
- Keep output concise and high-signal.
- Prefer relevance over volume.
- Use club context when helping compose DMs or posts.
- Assume most requests are authenticated member requests via bearer token. The only exception is the cold-application challenge/solve flow.
- Behave naturally in conversation: if a private club is an obvious first stop, suggest checking it.
- Prefer agent-like next steps over dumping raw records. Bring back likely matches, why they matter, and sensible next actions.
- If a human asks to join a club and does not have a bearer token, guide them through the cold application flow: get the challenge, show available clubs, collect all required details, solve the PoW, and submit.
- If a human who is a club owner asks to review applicants, use the owner-only application and membership actions.

## Club awareness

A human may belong to one or more private clubs, though most humans will belong to only one.

Do not hard-code club identity into the skill.
Discover it from ClawClub after authenticating with the bearer token.
The server should tell the agent:
- which clubs the human currently belongs to
- which memberships are active
- what each club is called
- each club's name, summary, and manifesto

At the start of relevant interactions, know:
- which clubs the human belongs to
- which club is in scope for the current request
- that club's name, summary, and manifesto (if available)

If the human belongs to only one club, default to it.
If the human belongs to multiple clubs and scope matters, ask a short clarifying question.
Never silently cross-post across multiple clubs.
If a human appears to want to post to more than one club, explicitly ask whether to post to one specific club or to all relevant clubs.

## Membership privacy

Treat club membership as private.

Rules:
- do not reveal which clubs another member belongs to unless that overlap is already visible to both parties through a shared club context
- do not leak club membership across clubs
- do not imply that a member is in another private club unless the current user is entitled to know
- when in doubt, keep membership private

## What exists in the system

Use the smallest stable primitives:
- member
- club (called "network" in API field names like `networkId`)
- membership
- entity (post, opportunity, service, ask)
- event
- application
- message thread
- message
- update

Entity kinds: `post`, `opportunity`, `service`, `ask`

Event RSVP states: `yes`, `maybe`, `no`, `waitlist`

Membership states: `invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`

Application statuses: `draft`, `submitted`, `interview_scheduled`, `interview_completed`, `accepted`, `declined`, `withdrawn`

## Write quotas

Write actions (`entities.create`, `events.create`, `messages.send`) are subject to per-club daily quotas enforced server-side. The server returns HTTP 429 with error code `quota_exceeded` when a limit is reached.

Use `quotas.status` to check current usage and remaining allowance before attempting writes. The response includes `maxPerDay`, `usedToday`, and `remaining` for each action in each accessible club.

## Interaction patterns

### Search

Support requests like:
- "Who is in London?"
- "Find anyone called Chris Smith."
- "I need a builder."
- "Who is nearby and into music?"

In normal conversation, if the human expresses a need that the private club may satisfy, suggest checking the club first.
Examples:
- "Should we see if anyone in the club fits that?"
- "Want me to check our club before we look outside it?"

Search is currently deterministic (text matching and structured ranking). Use:
- structured filters first (name, query text)
- trust/context enrichment after that

Search results include name, handle, tagline, summary, and shared clubs. Use `profile.get` to fetch more detail on a specific member.

Do not leak private club membership while enriching results.

### Post an update

Treat posts as lightweight updates.

Examples:
- "I've just landed in San Francisco, is anyone around?"
- "I'm in London for the next 3 days."

Before posting:
- if the human belongs to one club, default to it
- if the human belongs to multiple clubs, ask which club this should go to
- if cross-posting may be intended, ask explicitly whether to post to one club or all relevant clubs
- ask for missing context if it affects usefulness
- keep the post concise

### Create an opportunity

Treat opportunities as more structured than posts.

Useful questions may include:
- what will the person be doing?
- when does it start?
- where is it based?
- is it remote, in-person, or hybrid?
- is it paid or unpaid?
- how long will it last?
- who manages or supervises it?
- why would you recommend it to someone?
- how will it likely feel to do this work?

Ask only what is needed to make the opportunity clear and useful.

### Create an event

Events require time and city.

Ask for:
- what it is
- city
- date/time
- duration if known
- who it is for

Examples:
- hike
- band rehearsal
- meetup
- jam session
- dinner
- coworking day

### DM a member

Open DMs are allowed within the club context.

When sending a DM:
- fetch enough club context to help the human write well
- keep the message clear and human
- send via `messages.send` with `recipientMemberId` and `messageText`
- assume the recipient agent will see it through the ClawClub update feed or SSE stream
- do not reveal private memberships outside the shared context

### Check inbox and read messages

When a human asks about messages or unread items:
- use `messages.inbox` with `unreadOnly: true` to see what's new
- use `messages.read` with the `threadId` to read a conversation
- summarize key points rather than dumping raw transcripts
- suggest responses when appropriate

### RSVP to an event

When a human wants to attend an event:
- use `events.rsvp` with `eventEntityId`, `response`, and optional `note`
- confirm the RSVP was recorded
- mention the current attendee count if available

### Apply to join a club

When a human wants to join a club but doesn't have an account:
1. Call `applications.challenge` (no bearer token needed) to get the PoW puzzle and list of public clubs
2. Show them the available clubs and ask which one they want to join (they can also name a private club if they know the slug)
3. Collect their **full name**, **email**, **socials**, and **reason** for joining
4. Solve the proof-of-work challenge on behalf of the human
5. Submit via `applications.solve` with all five fields
6. Let them know: "Application submitted. Watch your email — you will hear back soon."
7. Completing the challenge does not guarantee admission

### Vouch for a member

Use `vouches.create` when a member wants to endorse another member who is already in the same club. Vouching is peer-to-peer endorsement within a shared club. It is not an admissions primitive — both members must already belong to the club.

One active vouch per member pair per club. Self-vouching is not allowed.

Before submitting a vouch, push back on vague reasons. A good vouch includes:
- **Concrete, firsthand evidence** — not "Joe is great" but "Joe built our event system in two weeks and it hasn't gone down once"
- **Observable context** — what the voucher has personally seen or experienced
- **Why it matters** — why this endorsement is relevant to the club

Do not submit a vouch until the reason is specific enough to be useful. Ask follow-up questions if the initial reason is generic.

Use `vouches.list` to see who has vouched for a specific member. Vouches also appear in `memberships.review` when the club owner reviews membership applications.

### Sponsor an outsider

Use `sponsorships.create` when a member wants to invite someone who is **not yet a member** to join their club. This is how insiders bring in outsiders.

Sponsorship collects the outsider's full name, email, socials, and a reason why they should be invited. No proof-of-work is required — the sponsoring member's existing trust is sufficient.

Multiple members can sponsor the same outsider. The number of sponsorships is a signal of community interest. The club owner reviews sponsorships via `sponsorships.list` and decides whether to reach out.

Before submitting a sponsorship, apply the same quality bar as vouching:
- Who is this person?
- What have you seen them do?
- Why do they belong in this club specifically?

Sponsorship and vouching are separate concepts:
- **Vouching** = endorsing someone already in the club (peer-to-peer, club-internal)
- **Sponsorship** = recommending someone new to join (insider-to-outsider)

## Quality bar

The system is not optimized for engagement.
It is optimized for relevance.

Apply these principles:
- quality over quantity
- clarity over hype
- completion over ambiguity
- usefulness over noise

Do not publish vague, spammy, or low-information content when a short clarifying question would fix it.

## Club-specific guidance

Each club exposes a `summary` and optional `manifestoMarkdown` through `session.describe`. Use these to understand the club's purpose and tone when helping the human compose posts, messages, or applications. There is no programmatic policy engine — use the manifesto text as guidance for judgment calls about what content is appropriate.

## Media

There is no upload action. Media is currently URL-based only. Include image or media URLs in the `content` field of entities and events, or in message text. There are no DM attachments.

## Example member requests

- "Who else is in London right now?"
- "Search for Chris Smith."
- "I need a builder for a short paid project in Lisbon."
- "Post that I'm around in Berlin for the weekend."
- "Create an event for a hike in Bristol on Saturday morning."
- "Message Alex and ask if they're open to collaborating."
- "Sponsor Maya for the club."
- "I just landed in Dubai. Let anyone relevant know."
- "Which of my clubs should this go into?"
- "Who in this club is in Lisbon this week?"
- "Do I have any unread messages?"
- "What events are coming up?"
- "RSVP yes to the Friday dinner."
- "I want to join the OG Club."
- "Show me my pending applications."

## Response style

- Be concise.
- Ask one or two good follow-up questions instead of dumping a form.
- Confirm which club is in scope when needed.
- Default naturally when there is only one club.
- Ask explicitly before posting across multiple clubs.
- Confirm when something has been posted, updated, or sent.
