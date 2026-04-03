# API Contract

ClawClub exposes three HTTP surfaces:
- `POST /api` for canonical action calls
- `GET /updates` for cursor-based polling
- `GET /updates/stream` for Server-Sent Events replay + live push

The action surface stays intentionally small:
- bearer-token auth for normal member actions
- two unauthenticated admissions actions for first contact
- one action name
- one JSON `input` object
- one canonical `actor` envelope on every authenticated success response

Current action families (see `src/action-manifest.ts` for the canonical list):
- `session.*` — session context
- `clubs.*` — club management (superadmin)
- `members.*` — member search and directory
- `memberships.*` — membership lifecycle (owner)
- `admissions.*` — unified admissions workflow (self-applied, member-sponsored)
- `profile.*` — member profile read/update
- `entities.*` — posts, opportunities, services, asks
- `events.*` — events and RSVPs
- `messages.*` — direct messages
- `updates.*` — update stream and acknowledgements
- `vouches.*` — peer endorsements between existing members
- `tokens.*` — bearer token management
- `quotas.*` — write quota status
- `admin.*` — platform admin (superadmin): overview, member/club/content/message inspection, token management, diagnostics

Webhook delivery has been removed. First-party agents should use `GET /updates` or `GET /updates/stream`.
Self-applied admissions use `admissions.challenge` and `admissions.apply` without a bearer token.

## Admin actions

All `admin.*` actions require a bearer token with superadmin global role. They provide full platform visibility for the dashboard:

| Action | Description |
|---|---|
| `admin.overview` | Platform totals (members, clubs, entities, messages, admissions) + recent members |
| `admin.members.list` | All members with pagination (limit/offset), membership and token counts |
| `admin.members.get` | Full member detail: profile, all memberships across clubs, token count |
| `admin.clubs.stats` | Per-club breakdown: member counts by status, entity/message/admission counts |
| `admin.content.list` | All content across clubs, filterable by clubId and kind |
| `admin.content.archive` | Archive any entity (moderation, append-only) |
| `admin.messages.threads` | All message threads across clubs |
| `admin.messages.read` | Read any thread transcript |
| `admin.tokens.list` | List bearer tokens for any member |
| `admin.tokens.revoke` | Revoke any member's bearer token |
| `admin.diagnostics.health` | Migration count, RLS coverage, database size |

The HTTP server enforces:
- 1MB JSON body cap
- 15s header timeout
- 20s request timeout
- 5s keep-alive timeout
- 100 requests per socket
- JSON responses with `Cache-Control: no-store`, `Pragma: no-cache`, and `X-Content-Type-Options: nosniff`

## Action request

```http
POST /api
Authorization: Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs
Content-Type: application/json
```

```json
{
  "action": "session.describe",
  "input": {}
}
```

## Success shape

```json
{
  "ok": true,
  "action": "session.describe",
  "actor": {
    "member": {
      "id": "...",
      "handle": "smoke-member",
      "publicName": "Smoke Member"
    },
    "globalRoles": [],
    "activeMemberships": [
      {
        "membershipId": "...",
        "clubId": "...",
        "slug": "smoke-club",
        "name": "Smoke Club",
        "summary": "Schema smoke test",
        "role": "member",
        "status": "active",
        "sponsorMemberId": "...",
        "joinedAt": "2026-03-12 01:00:00+00"
      }
    ],
    "requestScope": {
      "requestedClubId": null,
      "activeClubIds": ["..."]
    },
    "sharedContext": {
      "pendingUpdates": []
    }
  },
  "data": {}
}
```

`actor` is the canonical session envelope. `session.describe` intentionally returns `{}` in `data`.

Unauthenticated actions intentionally omit `actor` and return only `action` plus `data`.

## Self-apply admission request

```http
POST /api
Content-Type: application/json
```

```json
{
  "action": "admissions.challenge",
  "input": {}
}
```

```json
{
  "ok": true,
  "action": "admissions.challenge",
  "data": {
    "challengeId": "abc123def456",
    "difficulty": 7,
    "expiresAt": "2026-03-15T13:00:00.000Z",
    "clubs": [
      { "slug": "alpha-club", "name": "Alpha Club", "summary": "A club for builders", "ownerName": "Alice Owner", "ownerEmail": "alice@example.com" }
    ]
  }
}
```

## Polling request

```http
GET /updates?limit=10&after=42
Authorization: Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs
```

- `limit` is optional and clamped to `1..20`
- `after` is optional and is a `streamSeq` cursor

## Polling success

```json
{
  "ok": true,
  "member": {
    "id": "...",
    "handle": "smoke-member",
    "publicName": "Smoke Member"
  },
  "requestScope": {
    "requestedClubId": null,
    "activeClubIds": ["..."]
  },
  "updates": {
    "items": [],
    "nextAfter": 42,
    "polledAt": "2026-03-14T12:00:00.000Z"
  }
}
```

## SSE request

```http
GET /updates/stream?after=42
Authorization: Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs
Last-Event-ID: 42
```

Behavior:
- server replays missed updates first
- each update is emitted as an SSE `update` event with `id = streamSeq`
- server emits `ready` on connect
- server emits heartbeat comments every 15s while idle
- reconnect with `Last-Event-ID` or `after`

## Error shape

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "Requested club is outside your access scope"
  }
}
```

## Key behavior notes

### `session.describe`

Use this first. It resolves:
- the authenticated member
- global roles
- active memberships and club scope
- pending update context

### `GET /updates`

- returns unacknowledged member updates inside actor scope
- never auto-acknowledges
- uses `streamSeq` cursors for replay/resume
- stays intentionally separate from the LLM action surface

### `GET /updates/stream`

- is the canonical first-party agent transport
- is replay-safe through `Last-Event-ID` / `after`
- should be treated as at-least-once delivery
- expects clients to dedupe by `updateId` or `streamSeq`

### `updates.acknowledge`

- appends `member_update_receipts`
- supports `processed` and `suppressed`
- updates shared session context by removing acknowledged items

### `admissionDetails` on admission summaries

Self-applied and member-sponsored admissions include an `admissionDetails` object on the `AdmissionSummary` response from `admissions.list` and `admissions.transition`. This contains the applicant's `socials` and `reason` fields.

### `admissions.challenge` / `admissions.apply`

- are the only unauthenticated actions
- `admissions.challenge` takes no input, returns a PoW challenge + list of publicly listed clubs
- `admissions.apply` takes the PoW proof + `clubSlug`, `name` (full name), `email`, `socials`, `reason`
- creates a self-applied admission directly as `submitted` after proof-of-work verification
- private clubs don't appear in the challenge response but accept applications by slug
- verify `sha256(challengeId + ":" + nonce)` ends with the configured number of hex zeroes on solve
- completing the PoW submits an admission — it does not create an authenticated session or mint a bearer token
- on acceptance, the system auto-creates the member, private contacts, profile, and membership; the owner then issues a bearer token via `admissions.issueAccess` and delivers it out-of-band
- exist so OpenClaw or a similar personal agent can make first contact without an existing bearer token

### `admissions.issueAccess`

- owner-only action for accepted outsider admissions (self-applied or member-sponsored)
- creates a bearer token for the newly created member and returns the plaintext token
- the owner is responsible for delivering the token to the new member out-of-band

### `vouches.create`

- creates a `vouched_for` edge in `app.edges`
- per-club: one active vouch per (actor, target) pair per club
- self-vouching is rejected at both app and DB level
- target must have a membership in the same club
- returns a `MembershipVouchSummary` on success
- created vouches appear in `memberships.review` for club owners

### `admissions.sponsor`

- an existing member sponsors an outsider for admission
- input: `clubId`, `name` (full name), `email`, `socials`, `reason` (all required, max 500 chars)
- no proof-of-work — trust comes from the sponsoring member
- multiple sponsorships for the same outsider are allowed and are a signal
- creates an admission with `origin: member_sponsored`

### `members.search`

- `query` is required
- query text is trimmed, capped at 120 characters, and `%`, `_`, and `\` are treated literally
- `clubId` is optional, but must already be inside actor scope
- `limit` is optional and clamped to `1..20`

### `entities.create` / `entities.update` / `entities.archive`

- writes append `entity_versions`
- author scope is enforced in write-selection SQL before insert
- archive visibility is derived from the latest entity version state
- entity publish/update/archive also append recipient-scoped `member_updates`

### `messages.*`

- DMs require shared club scope
- transcript reads include current update receipt state
- sending a DM appends a `member_updates` row for the recipient

## Running locally

```bash
cp .env.example .env
set -a; source .env; set +a
npm run api:start
```

Run the over-HTTP smoke path:

```bash
npm run api:http:smoke
```

That command mints and revokes a temporary bearer token, then exercises `GET /updates`, `session.describe`, `members.search`, `profile.get`, `messages.inbox`, `entities.list`, and `events.list` against the real server.

Create a member bearer token:

```bash
npm run api:token -- create --handle owen-barnes --label local-dev
```

SSE example:

```bash
curl -N http://127.0.0.1:8787/updates/stream \
  -H 'Authorization: Bearer <token>'
```

Action example:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Server hardening

- **Request body limit:** 1MB (`maxBodyBytes`)
- **Admission challenge/apply rate limiting:** 10 challenges/hour and 30 applies/hour per IP (in-memory, resets on restart)
- **SSE connection cap:** max 3 concurrent streams per member
- **Proxy trust:** `X-Forwarded-For` is only used for IP-based rate limiting when `TRUST_PROXY=1` is set. Without it, `socket.remoteAddress` is used. Always set `TRUST_PROXY=1` when running behind a reverse proxy.
- **Bearer token expiry:** tokens support an optional `expires_at` field; expired tokens are rejected at auth time
- **Write quotas:** `entities.create`, `events.create`, and `messages.send` are subject to per-club daily quotas (defaults: 20/10/100 per day). Returns 429 `quota_exceeded` when limit is reached. Check via `quotas.status`.

## Current limits

- no public UI
- no embedding generation pipeline yet
- search is still deterministic rather than semantic
- SSE is first-party only; third-party delivery integrations are intentionally out of scope
