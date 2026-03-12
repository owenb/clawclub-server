# Pressure-Test Notes

This pass focused on the first places where the original SQL foundation was still too loose for the agreed product rules.

## Gaps found

### 1. Access scope was implied, not named
The first schema had active memberships and subscriptions, but no single database-level read surface for:
- memberships that are active
- and currently entitled to search/post inside a network

That matters because the central agent/server needs one deterministic scope primitive before any API work starts.

### 2. RSVP writes were not append-only
`event_rsvps` originally allowed exactly one row per event/member pair.
That made “current RSVP” easy, but it pushed updates toward overwriting the same row instead of appending a new fact.

Given the stated immutability/versioning stance, RSVP history needed the same treatment as profiles and entities.

### 3. Sponsor permanence was a policy, not an invariant
The product rules say the sponsor is fixed and permanent.
The original schema stored the sponsor, but nothing stopped later updates from changing it.

That is exactly the kind of invariant worth protecting in the database.

## What changed

### Accessible memberships
Added:
- `app.live_subscriptions`
- `app.accessible_network_memberships`

This gives the future API/server one canonical scope source:
- active memberships
- plus active/trialing live subscriptions
- with owner access allowed even without a subscription row

### Append-only RSVPs
`event_rsvps` now carries:
- `version_no`
- `supersedes_rsvp_id`
- `created_by_member_id`

And there is now a `app.current_event_rsvps` view for normal reads.

This keeps RSVP history while still making “show me the current list” easy.

### Sponsor immutability guard
Added a small trigger guard preventing updates to:
- `network_id`
- `member_id`
- `sponsor_member_id`
- `joined_at`

That keeps the identity facts of a membership stable while still allowing status changes like pause/leave/remove.

## Why this is still minimal

These changes do **not** add new top-level primitives.
They just harden the existing model where the agreed rules were already clear.

Still intentionally left to application logic for now:
- shared-network DM permission checks
- ambiguous-search clarification flow
- owner-editable prompting policy
- delivery judgment / alerting heuristics
- embedding generation and ranking
- account erasure execution workflow

## Result

The schema now has a cleaner handoff point to a thin one-endpoint server:
- one canonical access view
- immutable sponsor facts
- append-only RSVP history
- “current” views for normal reads
