# Foundation Notes

## Why this shape

The network has two strong axes:

1. **Global personhood**
   - one member identity across all networks
   - one profile history
   - one set of delivery endpoints

2. **Network-local trust and activity**
   - membership is scoped per network
   - sponsor is fixed per membership
   - content lives inside a network
   - subscriptions, vouches, complaints, alerts, and search scope are network-bound

That leads to a split between global tables (`members`, `member_profile_versions`, `delivery_endpoints`) and network tables (`networks`, `network_memberships`, `entities`, `deliveries`, etc.).

The first hardening pass adds two especially important read surfaces:
- `app.accessible_network_memberships` for deterministic permission scope
- `app.current_event_rsvps` for current reads over append-only RSVP history

## Versioning stance

Content is modeled as:

- a stable row (`members`, `entities`)
- append-only versions (`member_profile_versions`, `entity_versions`)

The system should normally read through the “current/latest” views.
Older versions remain available for admin/debug/audit.

## Intentional non-goals in this first pass

- no ORM
- no HTTP server yet
- no RLS policies yet
- no trigger-heavy business logic unless the database is clearly the right place
- no premature project/job/service subtype tables

## Where flexibility lives

Structured columns exist only where they clearly improve correctness or filtering:

- membership status/role
- subscription periods/status
- entity kind/state/time windows
- event fields like recurrence and capacity
- delivery state
- transcript roles
- location links

Everything else can evolve inside JSONB fields.

## Expected read patterns

- latest profile for a member
- accessible memberships for a member across networks
- latest live entities in a network by kind
- current RSVP list for an event, with history available underneath
- expiring asks/opportunities/events
- pending deliveries per endpoint
- transcript provenance for entity versions
- profile/entity embeddings for ranking

## Expected write patterns

- append a new profile version
- create a new entity and first version
- append a new entity version on edit
- append a new RSVP version when someone changes their response
- create transcript rows during a guided interaction
- link created content back to the source transcript message
- queue deliveries after publish/update
- record vouches and complaints as network-scoped facts

## Policy kept out of SQL for now

These are important, but not worth freezing into the first migration:

- sponsor monthly quota limits
- notification judgment rules
- owner-editable prompting/collection policies
- semantic search clarification flow
- shared-network DM permission checks
- export/eject tooling

The schema is designed so those can be enforced cleanly later without reshaping the core tables.
