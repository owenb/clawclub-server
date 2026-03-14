# API Contract

ClawClub exposes two bearer-auth HTTP surfaces:
- `POST /api` for canonical action calls
- `GET /updates` for simple non-LLM polling of unseen deliveries and posts

The main action surface is intentionally simple:
- one bearer-token auth step
- one action name
- one JSON `input` object
- one canonical `actor` envelope on every authenticated success response

Current action families:
- `session.*`
- `networks.*`
- `members.*`
- `memberships.*`
- `applications.*`
- `profile.*`
- `entities.*`
- `events.*`
- `messages.*`
- `deliveries.*`
- `tokens.*`

Delivery execution actions (`deliveries.claim`, `deliveries.execute`, `deliveries.complete`, `deliveries.fail`) require dedicated worker tokens rather than ordinary member bearer tokens.

The HTTP server currently enforces a 1MB JSON body cap, a 15s header timeout, a 20s request timeout, a 5s keep-alive timeout, and a 100-request per-socket reuse cap.

## Action request shape

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
        "networkId": "...",
        "slug": "smoke-network",
        "name": "Smoke Network",
        "summary": "Schema smoke test",
        "manifestoMarkdown": null,
        "role": "member",
        "status": "active",
        "sponsorMemberId": "...",
        "joinedAt": "2026-03-12 01:00:00+00"
      }
    ],
    "requestScope": {
      "requestedNetworkId": null,
      "activeNetworkIds": ["..."]
    },
    "sharedContext": {
      "pendingDeliveries": []
    }
  },
  "data": {}
}
```

`actor` is the canonical session envelope. `session.describe` deliberately returns an empty `data` object so the same member/network context is not duplicated twice.

## Polling request shape

```http
GET /updates?limit=10
Authorization: Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs
```

`limit` is optional and clamped to `1..20`.

## Polling success shape

```json
{
  "ok": true,
  "member": {
    "id": "...",
    "handle": "smoke-member",
    "publicName": "Smoke Member"
  },
  "requestScope": {
    "requestedNetworkId": null,
    "activeNetworkIds": ["..."]
  },
  "updates": {
    "deliveries": [],
    "posts": [],
    "polledAt": "2026-03-14T12:00:00.000Z"
  }
}
```

## Error shape

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "Requested network is outside the actor scope"
  }
}
```

## Key behavior notes

### `session.describe`

Use this first. It resolves:
- the authenticated member
- global roles
- active memberships and network scope
- pending delivery context

### `GET /updates`

- returns unseen delivery-backed alerts plus unseen network posts inside actor scope
- marks returned deliveries as acknowledged for the polling surface
- marks returned post versions as seen for that member
- keeps seen state on the server, not in the OpenClaw client
- stays intentionally separate from the LLM action surface

### `members.search`

- `query` is required
- `networkId` is optional, but must already be inside actor scope
- `limit` is optional and clamped to `1..20`
- results only include members who already share scope with the actor

### `profile.get` / `profile.update`

- profiles read from the latest `current_member_profiles` projection
- profile writes append a new `member_profile_versions` row
- `handle` is mutable and optional; `memberId` is the stable identity surface

### `memberships.*` / `applications.*`

- membership state and application state are append-only version histories with current projections
- owner/admin flows are enforced server-side and by RLS
- `accessible_network_memberships` is derived from RLS-protected membership and subscription source rows; production should apply all numbered migrations before trusting scope decisions
- accepted applications expose a small activation handoff summary directly on the current application payload

### `entities.create` / `entities.update` / `entities.archive`

- create and edit append new `entity_versions` rows rather than mutating old content
- `entities.update` author scope is enforced in the write-selection SQL before the new version insert, with RLS as the backstop
- `entities.archive` appends an `archived` version; archive visibility is derived from the latest entity version state
- archived entities disappear from `live_entities` and normal `entities.list` reads immediately
- `entities.archived_at` is now a legacy compatibility column and is not the runtime source of truth
- archive currently applies to posts, asks, opportunities, and services

### `messages.*`

- DMs require shared network scope
- inbox, thread read, and list surfaces all run through actor-scoped reads
- transcript reads include current delivery receipt state where relevant

### `deliveries.*`

- endpoints and receipts are member-visible within scope
- owner/operator reads can inspect network delivery activity
- worker tokens can only claim/complete/fail inside their allowed network scope
- WebHugs/webhook execution exists in code but is disabled operationally until outbound hardening is complete

## Running locally

Export the runtime env first:

```bash
cp .env.example .env
set -a; source .env; set +a
```

Start the API:

```bash
npm run api:start
```

Run the over-HTTP smoke path:

```bash
npm run api:http:smoke
```

That command uses `DATABASE_MIGRATOR_URL` when available to mint and revoke a temporary bearer token, then exercises `GET /updates`, `session.describe`, `members.search`, `profile.get`, `messages.inbox`, `entities.list`, and `events.list` against the real HTTP server.

Create a member bearer token:

```bash
npm run api:token -- create --handle owen-barnes --label local-dev
```

Create a delivery worker token:

```bash
npm run api:worker-token -- create --member <member_id> --networks <network_id[,network_id...]> --label local-dev
```

Run the worker:

```bash
export CLAWCLUB_WORKER_BEARER_TOKEN=<worker_token>
npm run api:worker -- --worker-key local-dev --max-runs 10
```

Authenticated example:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Delivery signing

Sender-side delivery signing currently supports `env:NAME` and `op://vault/item/field` secret references. Signed requests include:
- `x-clawclub-signature-timestamp`
- `x-clawclub-signature-v1`

Receiver-side helpers live in `src/delivery-signing.ts`.

## Current limits

- no public UI
- no semantic ranking yet
- no automatic embedding generation pipeline yet
- WebHugs outbound execution stays disabled until URL validation, SSRF blocking, timeout/redirect limits, and retry/circuit-break behavior are in place
