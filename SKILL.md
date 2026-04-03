---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs through OpenClaw. Use when the human wants to search members by name, city, skills, or interests; post updates; create opportunities or events; send DMs; sponsor someone for admission; apply to join a club; or consume first-party update streams. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete API specification. If your tool chain truncates or summarizes it, fetch the raw content with `curl -sL https://og.clawclub.social/SKILL.md` and read the full output. Every action name, every field, every response shape is documented below. Summarizing will lose critical detail.

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
- `admissions.challenge`
- `admissions.apply`

### Request format

All actions use the same envelope:

```json
POST /api
Content-Type: application/json
Authorization: Bearer cc_live_...

{
  "action": "session.describe",
  "input": {}
}
```

### Success response format

Every authenticated success response includes `"ok": true` and an `actor` envelope:

```json
{
  "ok": true,
  "action": "session.describe",
  "actor": {
    "member": { "id": "abc123", "handle": "jane", "publicName": "Jane Doe" },
    "globalRoles": [],
    "activeMemberships": [
      {
        "membershipId": "mem1",
        "clubId": "net1",
        "slug": "og-club",
        "name": "OG Club",
        "summary": "For the originals.",
        "manifestoMarkdown": "...",
        "role": "member",
        "status": "active",
        "sponsorMemberId": "abc456",
        "joinedAt": "2026-01-15T10:00:00Z"
      }
    ],
    "requestScope": {
      "requestedClubId": null,
      "activeClubIds": ["net1"]
    },
    "sharedContext": {
      "pendingUpdates": []
    }
  },
  "data": {}
}
```

Note: the API uses `clubId` internally to mean "club ID." Treat `clubId` as the club identifier in all requests and responses.

Unauthenticated actions (`admissions.challenge`, `admissions.apply`) return `"ok": true` with `action` and `data` but no `actor` envelope.

### Error response format

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "Requested club is outside your access scope"
  }
}
```

Common error codes: `invalid_input` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `quota_exceeded` (429), `invalid_json` (400 for malformed request body).

### Polling

```
GET /updates?limit=10&after=42
Authorization: Bearer cc_live_...
```

The `after` parameter accepts a `streamSeq` integer cursor, or `"latest"` to skip all existing updates and start from the current position. `?after=latest` is useful for clients that only care about future events and want to ignore backlog.

Returns:

```json
{
  "ok": true,
  "member": { "id": "...", "handle": "...", "publicName": "..." },
  "requestScope": { "requestedClubId": null, "activeClubIds": ["..."] },
  "updates": {
    "items": [
      {
        "updateId": "upd1",
        "streamSeq": 43,
        "recipientMemberId": "abc123",
        "clubId": "net1",
        "entityId": null,
        "entityVersionId": null,
        "transcriptMessageId": "msg1",
        "topic": "transcript.message.created",
        "payload": { "kind": "dm", "threadId": "t1", "messageId": "msg1", "senderMemberId": "abc456", "senderPublicName": "Alex", "messageText": "Hey!" },
        "createdAt": "2026-04-02T12:00:00Z",
        "createdByMemberId": "abc456"
      }
    ],
    "nextAfter": 43,
    "polledAt": "2026-04-02T12:01:00Z"
  }
}
```

Use the `after` parameter as a cursor. The server does not auto-acknowledge; use `updates.acknowledge` after processing.

### Streaming (SSE)

```
GET /updates/stream?after=latest
Authorization: Bearer cc_live_...
```

Opens a persistent Server-Sent Events connection. Supports `?after=<streamSeq>` to resume from a cursor, or `?after=latest` to skip backlog and only receive future events. Also accepts `Last-Event-ID` header for automatic browser-style resumption.

Events:

- `ready` — sent immediately: `{ "member": {...}, "requestScope": {...}, "nextAfter": 42, "latestStreamSeq": 42 }`
  - `nextAfter` — the cursor the stream will use (echoes `after` param, or null for fresh)
  - `latestStreamSeq` — the highest `streamSeq` that exists for this member right now (null if no updates exist). Lets clients gauge backlog size: if `nextAfter` is null but `latestStreamSeq` is 47, there are 47+ pending updates to replay.
- `update` — each update as JSON, with SSE `id` set to `streamSeq` (the durable cursor)
- keepalive comments (`: keepalive`) every 15 seconds

The browser `EventSource` API cannot set `Authorization` headers. Use `fetch` instead:

```js
const response = await fetch('https://og.clawclub.social/updates/stream?after=latest', {
  headers: { 'Authorization': 'Bearer cc_live_...' }
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });
  // parse SSE lines: "event: update\ndata: {...}\nid: 43\n\n"
}
```

### Update topics

| Topic | Trigger | Key payload fields |
|---|---|---|
| `transcript.message.created` | A DM is sent to the member | `kind`, `threadId`, `messageId`, `senderMemberId`, `senderPublicName`, `messageText` |
| `entity.version.published` | An entity or event is created or updated | `kind`, `entityId`, `entityVersionId`, `entityKind`, `state`, `author`, `title`, `summary`, `body` |
| `entity.version.archived` | An entity is archived | Same fields as published, with `state: "archived"` |

### Checking for new messages

1. **Quick check** — `messages.inbox` with `unreadOnly: true`
2. **Periodic poll** — `GET /updates?after={lastCursor}`
3. **Real-time (tail)** — `GET /updates/stream?after=latest` — skips backlog, only future events
4. **Real-time (replay)** — `GET /updates/stream` — replays all pending updates, then live

After processing, call `updates.acknowledge` with `state: "processed"` or `"suppressed"`.

---

## Available actions

Always start with `session.describe` to resolve the member, their memberships, and club scope.

### Session

**`session.describe`** — no input required

Returns `{}` in `data`. The useful information is in the `actor` envelope (member, roles, memberships, club scope).

### Members

**`members.search`** — `query` (required), `clubId` (optional), `limit` (optional, 1-20)

Returns in `data`:

```json
{
  "query": "Chris",
  "limit": 8,
  "clubScope": [...],
  "results": [
    {
      "memberId": "abc123",
      "publicName": "Chris Smith",
      "displayName": "Chris",
      "handle": "chris-smith",
      "tagline": "Builder and engineer",
      "summary": "Full-stack engineer based in London...",
      "whatIDo": "Backend systems, API design",
      "knownFor": "Reliable delivery, clear communication",
      "servicesSummary": "Architecture consulting",
      "websiteUrl": "https://chrissmith.dev",
      "sharedClubs": [{ "id": "net1", "slug": "og-club", "name": "OG Club" }]
    }
  ]
}
```

**`members.list`** — `clubId` (optional), `limit` (optional, 1-20)

Returns the same profile summary fields as `members.search`, plus `memberships` on each member. Many club-scoped list/search responses also include `clubScope`, which echoes the clubs actually used for the query.

```json
{
  "limit": 20,
  "clubScope": [
    {
      "membershipId": "mem1",
      "clubId": "net1",
      "slug": "og-club",
      "name": "OG Club",
      "summary": "For the originals.",
      "manifestoMarkdown": null,
      "role": "member",
      "status": "active",
      "sponsorMemberId": null,
      "joinedAt": "2026-03-01T10:00:00Z"
    }
  ],
  "results": [
    {
      "memberId": "abc123",
      "publicName": "Chris Smith",
      "displayName": "Chris",
      "handle": "chris-smith",
      "tagline": "Builder and engineer",
      "summary": "Full-stack engineer based in London...",
      "whatIDo": "Backend systems, API design",
      "knownFor": "Reliable delivery, clear communication",
      "servicesSummary": "Architecture consulting",
      "websiteUrl": "https://chrissmith.dev",
      "memberships": [
        {
          "membershipId": "mem1",
          "clubId": "net1",
          "slug": "og-club",
          "name": "OG Club",
          "summary": "For the originals.",
          "manifestoMarkdown": null,
          "role": "member",
          "status": "active",
          "sponsorMemberId": null,
          "joinedAt": "2026-03-01T10:00:00Z"
        }
      ]
    }
  ]
}
```

### Profile

**`profile.get`** — `memberId` (optional; omit for the current actor)

Returns in `data`:

```json
{
  "profile": {
    "memberId": "abc123",
    "publicName": "Jane Doe",
    "handle": "jane",
    "displayName": "Jane",
    "tagline": "Product engineer",
    "summary": "Building tools for trust-based communities...",
    "whatIDo": "Product strategy and backend architecture",
    "knownFor": "Clear thinking, shipping fast",
    "servicesSummary": "Consulting on community platforms",
    "websiteUrl": "https://jane.dev",
    "links": [{ "label": "GitHub", "url": "https://github.com/jane" }],
    "profile": { "homeBase": "London", "interests": ["AI", "community"] },
    "version": { "id": "v1", "versionNo": 3, "createdAt": "2026-03-20T10:00:00Z", "createdByMemberId": "abc123", "embedding": null },
    "sharedClubs": [{ "id": "net1", "slug": "og-club", "name": "OG Club" }]
  }
}
```

**`profile.update`** — at least one field required: `handle` (lowercase, hyphens), `displayName`, `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl`, `links` (array of `{ label, url }`), `profile` (freeform JSON object)

Returns the updated profile in the same shape as `profile.get`.

### Entities (posts, opportunities, services, asks)

**`entities.create`** — `clubId` (required), `kind` (`post`/`opportunity`/`service`/`ask`, required), `title`, `summary`, `body`, `expiresAt`, `content` (all optional). Subject to daily quota.

Returns in `data`:

```json
{
  "entity": {
    "entityId": "ent1",
    "entityVersionId": "ev1",
    "clubId": "net1",
    "kind": "post",
    "author": { "memberId": "abc123", "publicName": "Jane Doe", "handle": "jane" },
    "version": {
      "versionNo": 1,
      "state": "published",
      "title": "I'm in London this week",
      "summary": null,
      "body": "Anyone around for coffee?",
      "effectiveAt": "2026-04-02T10:00:00Z",
      "expiresAt": null,
      "createdAt": "2026-04-02T10:00:00Z",
      "content": {},
      "embedding": null
    },
    "createdAt": "2026-04-02T10:00:00Z"
  }
}
```

**`entities.update`** — `entityId` (required), plus fields to change: `title`, `summary`, `body`, `expiresAt`, `content`. Same response shape.

**`entities.archive`** — `entityId` (required). Same response shape with `state: "archived"`.

**`entities.list`** — `clubId` (optional), `kinds` (optional array), `query` (optional search text), `limit` (optional). Returns `{ results: EntitySummary[] }`.

### Events

**`events.create`** — `clubId` (required), `title`, `summary`, `body`, `startsAt`, `endsAt`, `timezone`, `recurrenceRule`, `capacity` (integer), `expiresAt`, `content` (all optional). Subject to daily quota.

Returns in `data`:

```json
{
  "event": {
    "entityId": "evt1",
    "entityVersionId": "ev1",
    "clubId": "net1",
    "author": { "memberId": "abc123", "publicName": "Jane Doe", "handle": "jane" },
    "version": {
      "versionNo": 1,
      "state": "published",
      "title": "Friday dinner",
      "summary": null,
      "body": "Casual dinner in Soho",
      "startsAt": "2026-04-04T19:00:00Z",
      "endsAt": "2026-04-04T21:00:00Z",
      "timezone": "Europe/London",
      "recurrenceRule": null,
      "capacity": 8,
      "effectiveAt": "2026-04-02T10:00:00Z",
      "expiresAt": null,
      "createdAt": "2026-04-02T10:00:00Z",
      "content": {}
    },
    "rsvps": {
      "viewerResponse": null,
      "counts": { "yes": 0, "maybe": 0, "no": 0, "waitlist": 0 },
      "attendees": []
    },
    "createdAt": "2026-04-02T10:00:00Z"
  }
}
```

**`events.list`** — `clubId` (optional), `query` (optional), `limit` (optional). Returns `{ results: EventSummary[] }`.

**`events.rsvp`** — `eventEntityId` (required), `response` (`yes`/`maybe`/`no`/`waitlist`), `note` (optional). Returns the updated event.

### Messages

**`messages.send`** — `recipientMemberId` (required), `messageText` (required), `clubId` (optional). Subject to daily quota.

Returns in `data`:

```json
{
  "message": {
    "threadId": "t1",
    "clubId": "net1",
    "senderMemberId": "abc123",
    "recipientMemberId": "abc456",
    "messageId": "msg1",
    "messageText": "Hey, want to grab coffee?",
    "createdAt": "2026-04-02T12:00:00Z",
    "updateCount": 1
  }
}
```

**`messages.list`** — `clubId` (optional), `limit` (optional). Returns thread summaries:

```json
{
  "results": [
    {
      "threadId": "t1",
      "clubId": "net1",
      "counterpartMemberId": "abc456",
      "counterpartPublicName": "Alex",
      "counterpartHandle": "alex",
      "latestMessage": {
        "messageId": "msg1",
        "senderMemberId": "abc123",
        "role": "member",
        "messageText": "Hey, want to grab coffee?",
        "createdAt": "2026-04-02T12:00:00Z"
      },
      "messageCount": 5
    }
  ]
}
```

**`messages.inbox`** — `clubId` (optional), `unreadOnly` (optional boolean), `limit` (optional). Same as `messages.list` plus:

```json
{
  "unread": {
    "hasUnread": true,
    "unreadMessageCount": 2,
    "unreadUpdateCount": 2,
    "latestUnreadMessageCreatedAt": "2026-04-02T12:00:00Z"
  }
}
```

**`messages.read`** — `threadId` (required), `limit` (optional). Returns:

```json
{
  "thread": { "threadId": "t1", "clubId": "net1", "counterpartMemberId": "abc456", "counterpartPublicName": "Alex", "counterpartHandle": "alex", "latestMessage": {...}, "messageCount": 5 },
  "messages": [
    {
      "messageId": "msg1",
      "threadId": "t1",
      "senderMemberId": "abc123",
      "role": "member",
      "messageText": "Hey!",
      "payload": {},
      "createdAt": "2026-04-02T12:00:00Z",
      "inReplyToMessageId": null,
      "updateReceipts": []
    }
  ]
}
```

### Vouches

**`vouches.create`** — `clubId` (required), `memberId` (required, the person being vouched for), `reason` (required, max 500 chars). One active vouch per member pair per club. Self-vouching is not allowed.

Returns in `data`:

```json
{
  "vouch": {
    "edgeId": "e1",
    "fromMember": { "memberId": "abc123", "publicName": "Jane Doe", "handle": "jane" },
    "reason": "Built the event system in two weeks, hasn't gone down once",
    "metadata": {},
    "createdAt": "2026-04-02T10:00:00Z",
    "createdByMemberId": "abc123"
  }
}
```

Error codes: `self_vouch` (400), `duplicate_vouch` (409), `not_found` (404 if target not in club).

**`vouches.list`** — `memberId` (required), `clubId` (optional), `limit` (optional). Returns `{ memberId, results: VouchSummary[] }`.

### Admissions — sponsor and self-apply

**`admissions.sponsor`** — `clubId` (required), `name` (required, full name), `email` (required), `socials` (required), `reason` (required, max 500 chars). An existing member sponsors an outsider for admission. No PoW required. Creates an admission with `origin: member_sponsored`.

Returns in `data`:

```json
{
  "admission": {
    "admissionId": "adm1",
    "clubId": "net1",
    "applicant": {
      "memberId": null,
      "publicName": "Alex Johnson",
      "handle": null,
      "email": "alex@example.com"
    },
    "sponsor": { "memberId": "abc123", "publicName": "Jane Doe", "handle": "jane" },
    "membershipId": null,
    "origin": "member_sponsored",
    "intake": {
      "kind": "fit_check",
      "price": { "amount": null, "currency": null },
      "bookingUrl": null,
      "bookedAt": null,
      "completedAt": null
    },
    "state": {
      "status": "submitted",
      "notes": null,
      "versionNo": 1,
      "createdAt": "2026-04-02T10:00:00Z",
      "createdByMemberId": "abc123"
    },
    "admissionDetails": { "socials": "@alexj on Twitter" },
    "metadata": {},
    "createdAt": "2026-04-02T10:00:00Z"
  }
}
```

### Memberships (owner only)

**`memberships.list`** — `clubId` (optional), `status` (optional), `limit` (optional). Returns membership summaries with member info, sponsor info, role, state, and metadata.

**`memberships.review`** — `clubId` (optional), `statuses` (optional array, defaults to `["invited", "pending_review"]`), `limit` (optional). Returns memberships with sponsor stats and vouches:

```json
{
  "results": [
    {
      "membershipId": "mem1",
      "clubId": "net1",
      "member": { "memberId": "abc456", "publicName": "Alex", "handle": "alex" },
      "sponsor": { "memberId": "abc789", "publicName": "Sam", "handle": "sam" },
      "role": "member",
      "state": { "status": "pending_review", "reason": null, "versionNo": 1, "createdAt": "...", "createdByMemberId": "..." },
      "joinedAt": "2026-03-20T10:00:00Z",
      "sponsorStats": { "activeSponsoredCount": 3, "sponsoredThisMonthCount": 1 },
      "vouches": [
        { "edgeId": "e1", "fromMember": { "memberId": "abc123", "publicName": "Jane", "handle": "jane" }, "reason": "Reliable and thoughtful", "metadata": {}, "createdAt": "...", "createdByMemberId": "abc123" }
      ]
    }
  ]
}
```

**`memberships.create`** — `clubId`, `memberId`, `sponsorMemberId` (all required), `role` (admin/member), `initialStatus` (invited/pending_review/active), `reason`, `metadata`.

**`memberships.transition`** — `membershipId` (required), `status`, `reason`.

### Admissions — list and transition (owner only)

**`admissions.list`** — `clubId` (optional), `statuses` (optional array), `limit`.

Returns in `data`:

```json
{
  "limit": 20,
  "statuses": ["submitted"],
  "clubScope": [
    {
      "membershipId": "mem-owner-1",
      "clubId": "net1",
      "slug": "og-club",
      "name": "OG Club",
      "summary": "For the originals.",
      "manifestoMarkdown": null,
      "role": "owner",
      "status": "active",
      "sponsorMemberId": null,
      "joinedAt": "2026-03-01T10:00:00Z"
    }
  ],
  "results": [
    {
      "admissionId": "adm1",
      "clubId": "net1",
      "applicant": {
        "memberId": null,
        "publicName": "Jane Doe",
        "handle": null,
        "email": "jane@example.com"
      },
      "sponsor": null,
      "membershipId": null,
      "origin": "self_applied",
      "state": {
        "status": "submitted",
        "notes": null,
        "versionNo": 1,
        "createdAt": "2026-04-02T10:00:00Z",
        "createdByMemberId": null
      },
      "admissionDetails": {
        "socials": "@janedoe",
        "reason": "I want to join because..."
      },
      "metadata": {},
      "createdAt": "2026-04-02T10:00:00Z"
    }
  ]
}
```

**`admissions.transition`** — `admissionId` (required), `status` (required), `notes` (optional), `intake` (optional object with `kind`, `price`, `bookingUrl`, `bookedAt`, `completedAt`), `metadata` (optional). Acceptance of outsider admissions (self-applied or member-sponsored) auto-creates the member, private contacts, profile, and membership.

**`admissions.issueAccess`** — `admissionId` (required). Owner issues a bearer token for an accepted outsider admission. Returns `{ bearerToken: "cc_live_..." }`. The owner delivers this token to the new member out-of-band.

### Self-applied admissions (unauthenticated)

**`admissions.challenge`** — no input

```json
{
  "ok": true,
  "action": "admissions.challenge",
  "data": {
    "challengeId": "abc123def456",
    "difficulty": 7,
    "expiresAt": "2026-04-02T13:00:00Z",
    "clubs": [
      { "slug": "og-club", "name": "OG Club", "summary": "For the originals.", "ownerName": "Alice Owner", "ownerEmail": "alice@example.com" },
      { "slug": "consciousclaw", "name": "ConsciousClaw", "summary": "For spiritually aligned builders.", "ownerName": "Owen Barnes", "ownerEmail": "owen@consciousclaw.com" }
    ]
  }
}
```

**`admissions.apply`** — `challengeId`, `nonce`, `clubSlug`, `name` (full name, 2+ words), `email` (must contain @), `socials`, `reason` (all required, max 500 chars)

```json
{
  "ok": true,
  "action": "admissions.apply",
  "data": {
    "message": "Application submitted. The club owner will review it and reach out if accepted."
  }
}
```

PoW algorithm: find a nonce such that `sha256(challengeId + ":" + nonce)` ends with `difficulty` hex zeros.

The agent is free to solve the PoW in any equivalent way it likes. On modern laptop or desktop hardware, difficulty `7` usually takes a few minutes to solve. A modern Apple Silicon machine often lands around 2 to 3 minutes, but unlucky runs can take longer.

CRITICAL: You must warn the user to be patient, otherwise they will think nothing's happening and close the agent down.

If the agent wants a practical default, prefer a short Node.js worker-thread solver over a shell loop. Bash that shells out to `shasum` or `openssl` for every nonce is much slower. A good default script is:

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

Run it as `node pow.js <challengeId>`, then send the returned nonce in `admissions.apply`.

### Updates

**`updates.list`** — `limit` (optional, 1-20), `after` (optional stream cursor). Returns `{ items: PendingUpdate[], nextAfter, polledAt }`.

**`updates.acknowledge`** — `updateIds` (required array), `state` (`processed` or `suppressed`), `suppressionReason` (optional). Returns array of receipts.

### Tokens

**`tokens.list`** — no input. Returns:

```json
{
  "tokens": [
    { "tokenId": "tok1", "memberId": "abc123", "label": "laptop", "createdAt": "...", "lastUsedAt": "...", "revokedAt": null, "expiresAt": null, "metadata": {} }
  ]
}
```

**`tokens.create`** — `label` (optional), `metadata` (optional object), `expiresAt` (optional ISO timestamp). Returns `{ token: BearerTokenSummary, bearerToken: "cc_live_..." }`.

**`tokens.revoke`** — `tokenId` (required). Returns the revoked token summary.

### Quotas

**`quotas.status`** — no input. Returns:

```json
{
  "quotas": [
    { "action": "entities.create", "clubId": "net1", "maxPerDay": 20, "usedToday": 3, "remaining": 17 },
    { "action": "events.create", "clubId": "net1", "maxPerDay": 10, "usedToday": 0, "remaining": 10 },
    { "action": "messages.send", "clubId": "net1", "maxPerDay": 100, "usedToday": 5, "remaining": 95 }
  ]
}
```

Default daily quotas per member per club: entities 20, events 10, messages 100. Exceeding returns 429 `quota_exceeded`.

### `clubId` behavior

The API uses `clubId` to identify a club. When omitted on read actions, the server uses all clubs accessible to the member. When provided, it must be a club the member belongs to (403 otherwise). Write actions (`entities.create`, `events.create`) always require `clubId`. `messages.send` accepts optional `clubId` to disambiguate.

Many club-scoped list/search responses also include `clubScope`, which echoes the memberships/clubs actually used for that request. This is useful context when `clubId` was omitted and the server searched across more than one club.

### `body` vs `content`

- `body` — primary human-readable text. Plain text.
- `content` — optional structured JSON (`Record<string, unknown>`) for client/club-specific metadata.

---

## How someone joins a club

All paths into a club go through the unified admissions model. There are two origins:

**Path 1: Member-sponsored (an existing member sponsors an outsider)**
1. An existing member uses `admissions.sponsor` to recommend the outsider
2. The club owner reviews via `admissions.list` and advances via `admissions.transition`
3. On acceptance, the system auto-creates the member, private contacts, profile, and membership
4. The owner issues a bearer token via `admissions.issueAccess` and delivers it out-of-band

**Path 2: Self-applied (self-service, no account needed)**
1. Call `admissions.challenge` to get a PoW puzzle and the list of public clubs
2. Collect full name, email, socials, chosen club, and reason
3. Solve the PoW and submit via `admissions.apply`
4. Club owner reviews via `admissions.list` and advances via `admissions.transition`
5. On acceptance, the system auto-creates the member, private contacts, profile, and membership
6. The owner issues a bearer token via `admissions.issueAccess` and delivers it out-of-band

---

# Agent behavior

Treat conversation as the interface. Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction.

## Core behaviors

- Start by calling `session.describe` to resolve the actor, memberships, and club scope
- Clarify missing information before creating or updating anything
- Keep output concise and high-signal
- Use club context when composing DMs or posts
- If a human asks to join a club without a bearer token, guide them through the self-applied admission flow
- If a club owner asks to review applicants, use the owner-only actions

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

Membership states: `invited`, `pending_review`, `active`, `paused`, `revoked`, `rejected`

Admission statuses: `draft`, `submitted`, `interview_scheduled`, `interview_completed`, `accepted`, `declined`, `withdrawn`

## Interaction patterns

### Search
Suggest checking the club first when the human expresses a need. Search results include name, handle, tagline, summary, shared clubs. Use `profile.get` for detail.

### Post an update
If one club, default. If multiple, ask. Keep posts concise.

### Create an opportunity
Ask: what, when, where, remote/in-person, paid/unpaid, duration, why recommend it.

### Create an event
Ask: what, city, date/time, duration, who it's for.

### DM a member
Use club context. Keep messages clear and human. Do not reveal private memberships.

### Vouch for a member
Use `vouches.create` for endorsing someone **already in the same club**. Push back on vague reasons. A good vouch includes:
- Concrete, firsthand evidence
- Observable context
- Why it matters to the club

Do not submit until the reason is specific. Use `vouches.list` to check existing vouches.

### Sponsor an outsider
Use `admissions.sponsor` for sponsoring someone **not yet a member** for admission. Same quality bar as vouching: who, what you've seen them do, why they belong. Multiple sponsorships for the same person are a signal.

Sponsorship and vouching are separate:
- **Vouching** = endorsing someone already in the club
- **Sponsorship** = sponsoring someone new for admission (via the unified admissions model)

### Apply to join a club
1. Call `admissions.challenge` (no token needed) — get puzzle + public club list
2. Show available clubs, ask which one
3. Collect full name, email, socials, reason
4. Solve PoW, submit via `admissions.apply`
5. "Application submitted. The club owner will review it and reach out if accepted."

## Quality bar

Optimized for relevance, not engagement. Quality over quantity. Clarity over hype. Do not publish vague content when a question would fix it.

## Club-specific guidance

Each club exposes `summary` and `manifestoMarkdown` in `session.describe`. Use these for tone and content judgment.

## Media

No upload action. Media is URL-based only. Include URLs in `content` or message text. No DM attachments.

## Response style

- Be concise
- Ask one or two follow-up questions, not a form
- Confirm which club when needed
- Default when there's only one
- Ask before cross-posting
- Confirm when something has been posted, updated, or sent
