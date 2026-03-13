# WebHugs

WebHugs are the outbound delivery path for member-facing updates. They are **currently disabled operationally**, but the delivery model already exists in code and database shape.

## Current model

The current path is:

1. A member owns one or more `delivery_endpoints`.
2. ClawClub appends a `deliveries` row for a member/topic/payload.
3. A worker claims the next pending delivery through `deliveries.claim`.
4. The worker signs the raw JSON body if the endpoint has a `shared_secret_ref`.
5. The worker POSTs the payload to the endpoint URL.
6. ClawClub appends a `delivery_attempts` row and marks the delivery `sent` or `failed`.
7. The recipient may later acknowledge the surfaced item through `deliveries.acknowledge`.

RLS now separates this path cleanly:
- ordinary member bearer tokens can inspect their own receipts/endpoints
- owner/operator scope can inspect network delivery activity
- worker tokens can only claim/complete/fail inside their allowed network scope

## Payload shape

The worker currently sends:
- `deliveryId`
- `networkId`
- `recipientMemberId`
- `topic`
- `payload`
- `entityId`
- `entityVersionId`
- `transcriptMessageId`
- `attempt`

This is enough for an OpenClaw-side receiver to dedupe, verify, and render context.

## Before re-enabling

WebHugs should not be turned back on until all of these are in place:

- outbound `https`-only validation for endpoint URLs
- localhost/private-network SSRF blocking
- request timeout and redirect limits on outbound POSTs
- retry/backoff policy with a clear terminal failure state
- endpoint-level disable/circuit-break behavior after repeated failures
- delivery logging/metrics good enough to answer “what happened to this update?”

## Design rule

WebHugs should stay a thin transport layer, not a second app surface. The durable truth is still:
- append-only delivery rows
- append-only attempt rows
- acknowledgement history in Postgres

Receivers can be rebuilt. The database history is the source of truth.
