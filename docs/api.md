# Thin API Skeleton

This is the first application layer on top of the SQL-first foundation.

It is intentionally small:
- one HTTP endpoint: `POST /api`
- one bearer-scoped actor resolution step
- two actions so far: `session.describe` and `members.search`
- no ORM
- no embeddings yet
- no public/web UI assumptions

## Why it exists already

The database can now answer the hard structural questions, but a few rules clearly belong in app logic:
- bearer token -> actor identity
- "which networks may this actor use right now?"
- per-request network scope checks
- action routing for an agent-native interface

That makes a tiny action endpoint worthwhile before any broader CRUD surface exists.

## Auth mode in this skeleton

For now, the bearer token is matched directly against `members.auth_subject`.

That is deliberately simple for local development.
A later pass should swap this for real token verification while keeping the same downstream shape.

## Endpoint shape

### Request

```http
POST /api
Authorization: Bearer auth|smoke-member
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
  "data": {
    "member": {
      "id": "...",
      "authSubject": "auth|smoke-member",
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

## Running it

```bash
npm run api:start
```

Then call it with curl:

```bash
curl -s http://127.0.0.1:8787/api \
  -H 'Authorization: Bearer auth|smoke-member' \
  -H 'Content-Type: application/json' \
  -d '{"action":"session.describe","input":{}}'
```

## Next likely actions

Only after real use proves the need:
- add DM shared-network validation actions
- add entity creation flows for post/opportunity/event
- add embedding-backed ranking behind the same action envelope
- replace auth-subject bearer mode with verified JWT/session tokens
