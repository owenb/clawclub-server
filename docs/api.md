# Thin API Skeleton

This is the first application layer on top of the SQL-first foundation.

It is intentionally small:
- one HTTP endpoint: `POST /api`
- one bearer-scoped actor resolution step
- a small set of actor-scoped actions (`session.describe`, `members.search`, profile flows, and entity flows)
- no ORM
- no embedding generation or vector ranking yet
- small embedding projection placeholders now exist for current profile/entity versions so later indexing can plug in without reshaping reads
- no public/web UI assumptions

## Why it exists already

The database can now answer the hard structural questions, but a few rules clearly belong in app logic:
- bearer token -> actor identity
- "which networks may this actor use right now?"
- per-request network scope checks
- action routing for an agent-native interface

That makes a tiny action endpoint worthwhile before any broader CRUD surface exists.

## Auth mode in this skeleton

Bearer auth now uses `app.member_bearer_tokens`.

Each token has:
- a compact short id (`app.short_id`)
- a hashed secret (`sha256`) stored in the database
- optional label / metadata
- revocation and last-used timestamps

The wire token format is:

```text
cc_live_<token_id>_<secret>
```

Only the token hash is persisted. The bearer token itself is shown once at creation time.

## Endpoint shape

### Request

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

### Success response

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
    }
  },
  "data": {
    "member": {
      "id": "...",
      "handle": "smoke-member",
      "publicName": "Smoke Member"
    },
    "accessibleNetworks": [
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
    ]
  }
}
```

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

## Supported actions

### `session.describe`
Returns:
- the current member
- all currently accessible networks from `app.accessible_network_memberships`

This is the intended first call for the OpenClaw skill so it can learn:
- which networks are in scope
- what each network is called
- the member's role in each network

### `members.search`
Inputs:
- `query` (required)
- `networkId` (optional)
- `limit` (optional, clamped to `1..20`)

Behavior:
- if `networkId` is provided, it must be inside the actor's accessible scope
- otherwise the search runs across all accessible networks
- results include only shared networks already in scope
- matching is currently structured text search only

Search fields in this pass:
- `members.public_name`
- `members.handle`
- `current_member_profiles.display_name`
- `what_i_do`
- `known_for`
- `services_summary`

### `profile.get`
Inputs:
- `memberId` (optional; defaults to the actor)

Behavior:
- reads the latest version from `app.current_member_profiles`
- only returns a profile when the actor shares at least one currently accessible network with the target member
- uses stable `memberId` as the lookup key; handles remain optional mutable aliases returned in the payload, not canonical identifiers for writes

### `profile.update`
Inputs:
- `displayName` (optional for updates; falls back to current value or `members.public_name`)
- `handle` (optional, nullable)
- `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl` (optional, nullable)
- `links` (optional array)
- `profile` (optional object)

Behavior:
- updates only the authenticated member's own profile
- appends a new row to `app.member_profile_versions` instead of overwriting the current row
- may update `members.handle` in the same transaction
- returns `409 handle_conflict` if the requested handle is already taken

## Running it

```bash
npm run api:start
```

Then call it with curl:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer cc_live_23456789abcd_23456789abcdefghjkmnpqrs' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

Create a token with:

```bash
node --experimental-strip-types src/token-cli.ts <member_id> [label]
```

Drain pending deliveries with the tiny worker CLI:

```bash
export CLAWCLUB_BEARER_TOKEN=<token>
node --experimental-strip-types src/delivery-worker.ts --worker-key local-dev --max-runs 10
```

It just loops over the existing `deliveries.execute` action until the executor reports `idle` or the per-run safety cap is reached.

That prints the bearer token once plus an `insert` statement for `app.member_bearer_tokens`.

## Delivery surface notes

Webhook signing is now usable end-to-end:
- sender-side execution resolves `sharedSecretRef` through the server default resolver
- supported refs in this pass: `env:NAME` and `op://vault/item/field`
- signed requests carry:
  - `x-clawclub-signature-timestamp`
  - `x-clawclub-signature-v1`
- receiver-side verification helpers live in `src/delivery-signing.ts`

Minimal receiver pattern:

```ts
import { readClawClubSignatureHeaders, verifyClawClubDeliverySignature } from './src/delivery-signing.ts';

const rawBody = requestBodyString;
const { timestamp, signature } = readClawClubSignatureHeaders(request.headers as Record<string, string>);
const result = verifyClawClubDeliverySignature({
  secret: process.env.CLAWCLUB_WEBHOOK_SECRET!,
  body: rawBody,
  timestamp,
  signature,
});

if (!result.ok) {
  // reject request and log result.reason
}
```

`deliveries.list` now returns a slightly more useful receipt view for humans/agents trying to debug notification flow:
- `endpointId`
- `attemptCount`
- `lastError`

`deliveries.retry` lets the recipient requeue a **failed** or **canceled** delivery as a fresh `pending` receipt against the same endpoint.
It does not mutate the original row; the original receipt remains as history.
The retry is still fully scope-checked server-side from bearer auth + network membership.

## Next likely actions

Only after real use proves the need:
- add delivery worker execution / webhook dispatch and richer retry/backoff policy
- add entity creation/versioning actions on top of the schema's `entities` + `entity_versions` model
- add event creation + RSVP actions as a separate but adjacent flow
- add DM shared-network validation actions
- add embedding-backed ranking behind the same action envelope
