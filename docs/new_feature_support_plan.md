# Support Feature Design

Status: **approved design, not yet implemented**
Last updated: 2026-04-04

## Problem

Members need to contact the club owner when they have a problem. Owners need to escalate to platform support staff when they can't resolve it themselves. There is no mechanism for either today.

## Two flows

| Flow | Initiator | Responder | Thread kind |
|------|-----------|-----------|-------------|
| Member to club owner | Any club member | Current club owner | `support` |
| Owner to platform support | Club owner | Assigned platform support contact | `escalation` |

Both are request/response workflows with status tracking, not open-ended conversations.

## Architectural decision: separate tables

Support is implemented as its own domain with dedicated tables, RLS, repository queries, unread logic, and admin surfaces. It does **not** reuse or extend the DM system, and it does **not** introduce a "group chat" primitive.

### Why not reuse DMs?

The DM system is structurally 1:1. Every layer assumes exactly two participants:

- **Storage:** `dm_threads` stores participants as two fixed columns (`created_by_member_id`, `counterpart_member_id`), not a join table. The unique index is pair-based using `LEAST/GREATEST`.
- **Access control:** `actor_can_access_thread()` checks `current_actor_member_id() IN (created_by_member_id, counterpart_member_id)`. RLS policies do the same.
- **Views:** `current_dm_thread_participants` is a synthetic UNION over those two columns. `current_dm_inbox_threads` computes a viewer-relative `counterpart_member_id` that only works because there is exactly one "other person."
- **Application layer:** `sendDirectMessage()` assumes one recipient and shared-club scope. Contract types (`DirectMessageThreadSummary`) are counterpart-centric. Notification fanout is single-recipient.
- **Admin:** `adminListThreads()` derives participants from the conversation-only participant view.

Support breaks this model: visibility is role-derived (requester, owner, assignee, support pool), support contacts may not be club members, notifications are assignee-targeted not broadcast, and status/escalation/reassignment are workflow state not chat state.

Attempting to reuse DMs would require narrowing every existing policy/view/function to `kind = 'conversation'` (risky migration touching working code) and then building parallel infrastructure for support. The only thing shared would be the physical tables -- everything on top would be separate anyway.

### Why not build group chat first?

Group chat would be a new messaging architecture: participant join table, new access model, new RLS, new notification fanout, new unread aggregation, new contract types, new admin queries, new redaction semantics. That is not a small extension of DMs -- it is a second messaging system.

Even after building it, support still would not fit cleanly. Support is a workflow, not a symmetric participant conversation:

- Visibility is role-derived, not participant-derived.
- Notifications are assignee-targeted, not broadcast to all participants.
- Support contacts may have zero club memberships.
- Status, escalation, and reassignment are workflow concerns, not chat concerns.
- Owner auth must come from `current_club_owners`, not from a participant role field.

Group chat would only solve "multiple people can post in one thread" while all of support's real complexity (the workflow and access control) would still need to be built on top. Building group chat as a prerequisite for support means paying for two features to ship one. If group chat is needed later for its own reasons (club sub-groups, committees), it should be designed for group chat requirements at that time.

### What "DMs stay untouched" means

Existing DM storage, RLS, views, and query paths stay untouched. Shared cross-cutting infrastructure (e.g. `member_updates`) may gain support-specific extensions in a future version if there is a concrete requirement (such as a unified inbox), but not in v1.

## Schema

### `app.support_threads`

| Column | Type | Notes |
|--------|------|-------|
| `id` | short_id PK | |
| `club_id` | short_id FK NOT NULL | Originating club |
| `kind` | enum `('support', 'escalation')` | |
| `status` | enum `('open', 'resolved')` | NOT NULL |
| `subject` | text | Optional free-text description |
| `requester_member_id` | short_id FK NOT NULL | Who opened the thread |
| `assignee_member_id` | short_id FK NOT NULL | Current responder (always set) |
| `escalated_from_thread_id` | short_id FK self-ref, nullable | Links escalation to its source support thread |
| `metadata` | jsonb DEFAULT '{}' | |
| `created_at` | timestamptz NOT NULL | |
| `resolved_at` | timestamptz | |
| `resolved_by_member_id` | short_id FK | |

No `archived_at` in v1. No `closed` state. Lifecycle is `open` -> `resolved` only. If archive or additional states are needed, they are additive changes.

**Indexes:**

- Partial unique: one open support thread per requester per club
  ```
  UNIQUE (club_id, requester_member_id)
  WHERE kind = 'support' AND status = 'open'
  ```
- No escalation uniqueness constraint. An owner may escalate multiple unrelated support threads.

### `app.support_messages`

| Column | Type | Notes |
|--------|------|-------|
| `id` | short_id PK | |
| `thread_id` | short_id FK NOT NULL | |
| `sender_member_id` | short_id FK, nullable | NULL for system-generated messages |
| `role` | enum `('member', 'agent', 'system')` | |
| `message_text` | text | |
| `payload` | jsonb DEFAULT '{}' | |
| `created_at` | timestamptz NOT NULL | |

**Invariant:** Every thread always has at least one message. `support.open` and `support.escalate` insert the initial message in the same transaction as the thread. This guarantees `support_thread_reads.last_read_message_id` always has a valid target.

### `app.support_thread_reads`

| Column | Type | Notes |
|--------|------|-------|
| `id` | short_id PK | |
| `thread_id` | short_id FK NOT NULL | |
| `member_id` | short_id FK NOT NULL | The reader |
| `last_read_message_id` | short_id FK NOT NULL | High-water mark |
| `last_read_at` | timestamptz NOT NULL | Audit only |
| UNIQUE | `(thread_id, member_id)` | One cursor per reader per thread |

See [Unread/notification model](#unreadnotification-model) below for how this table drives unread state.

### `app.platform_contacts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | short_id PK | |
| `member_id` | short_id FK NOT NULL | |
| `role` | enum `('support')` | Extensible later |
| `active` | boolean NOT NULL DEFAULT true | |
| `created_at` | timestamptz NOT NULL | |
| `deactivated_at` | timestamptz | |
| UNIQUE | `(member_id, role)` | |

Superadmin-managed via `admin.contacts.*` actions.

## Access control

### Security-definer functions

**`app.current_actor_is_support_contact()`** -- returns true if the current actor is an active platform support contact.

**`app.actor_can_access_support_thread(target_thread_id)`** -- returns true if the current actor is any of:

- The requester (`requester_member_id`)
- The assignee (`assignee_member_id`)
- The current owner of the thread's club (via `current_club_owners`, NOT `club_memberships.role`)
- An active support contact (for `kind = 'escalation'` threads only)
- A superadmin

**`app.get_support_thread_profiles(target_thread_id)`** -- returns member identity (id, public_name, handle) for the requester and assignee. Security-definer so that support contacts who are not club members can still resolve profile fields.

### RLS policies

| Table | Operation | Rule |
|-------|-----------|------|
| `support_threads` | SELECT | `actor_can_access_support_thread(id)` |
| `support_threads` | INSERT | `requester_member_id = current_actor` AND `status = 'open'` |
| `support_threads` | UPDATE | `actor_can_access_support_thread(id)` |
| `support_messages` | SELECT | `actor_can_access_support_thread(thread_id)` |
| `support_messages` | INSERT | `actor_can_access_support_thread(thread_id)` AND (`sender_member_id = current_actor` OR `role = 'system'`) |
| `support_thread_reads` | SELECT | `actor_can_access_support_thread(thread_id)` |
| `support_thread_reads` | INSERT/UPDATE | `member_id = current_actor` AND `actor_can_access_support_thread(thread_id)` |
| `platform_contacts` | ALL | superadmin only |

### Owner authorization

All support actions that check "is this person the club owner" query `current_club_owners` directly. They never check `club_memberships.role`. This sidesteps the known bug where `club_memberships.role` can be stale after ownership reassignment (see `test/integration/admin.test.ts:376`).

## Assignee semantics

`assignee_member_id` is always set on every thread. It means "the person currently responsible for responding."

| Thread kind | Assignee set to | When |
|---|---|---|
| `support` | Current club owner (from `current_club_owners`) | At thread creation by `support.open` |
| `escalation` | Least-loaded active support contact (fewest open escalation threads) | At thread creation by `support.escalate` |

### Ownership transfer

When `clubs.assignOwner` changes club ownership, open `kind = 'support'` threads are NOT automatically reassigned. The old owner remains the assignee on existing threads (they have context on the conversation). The new owner can see the queue via the `current_club_owners` check in `actor_can_access_support_thread`, so they have visibility, but existing threads continue with the original responder.

`support.reassign` in v1 only applies to `kind = 'escalation'` threads (superadmin moves between support contacts). Reassignment of `kind = 'support'` threads is deferred.

## Unread/notification model

### v1 is polling-only

There is no integration with `member_updates` in v1. No push notifications, no unified inbox badge. The client polls `support.list` to check for unread activity. If a unified "you have N unread things" experience is needed later, that is when we evaluate bridging to `member_updates` (and whether a `support_message_id` FK column is justified).

### Read cursors

Unread state is derived from the gap between a member's read cursor and the thread's latest message.

**`support_thread_reads`** stores one cursor per member per thread. The cursor is `last_read_message_id` -- the most recent message the member has seen. `last_read_at` is for audit only and is NOT used for unread computation.

**Unread count** for a thread is:

```
messages in the thread that sort after the cursor message
```

Where sort order is `(created_at, id)` -- the thread's natural message ordering. This avoids fragility from timestamp collisions.

If no cursor row exists for a member/thread pair, all messages are unread.

### When cursors are advanced

| Event | Whose cursor | Advanced to |
|-------|-------------|-------------|
| `support.read` is called | The caller's | Latest message in the thread at read time |
| `support.reply` is sent | The sender's | The newly created message |
| `support.open` creates a thread | The requester's | The initial message |
| `support.escalate` creates a thread | The escalating owner's | The initial message |

`support.reply` advances the sender's cursor so their own message does not appear unread to them. This happens in the same transaction as the message insert.

### `support.read` is mutating

Unlike `messages.read` (which is read-only), `support.read` upserts the caller's read cursor. It should be marked as `safety: 'mutating'` in the action definition, not `safety: 'read_only'`. This is a deliberate design choice -- the alternative (a separate `support.markRead` action) adds API surface without meaningful benefit, since reading a support thread should always mark it as read.

## Actions

### Support actions (`src/schemas/support.ts`)

| Action | Auth | Safety | Description |
|--------|------|--------|-------------|
| `support.open` | member | mutating | Creates a `kind='support'` thread. Sets `assignee_member_id` to the current club owner (from `current_club_owners`). Inserts the initial message. Creates read cursors for the requester. Rejects if the member already has an open support thread in the club. |
| `support.reply` | member | mutating | Sends a message to a support/escalation thread. Must be requester or assignee (or current club owner for support threads, or active support contact for escalation threads). Message `role` determined server-side: `'agent'` if sender is a responder/assignee, `'member'` if requester. Advances the sender's read cursor in the same transaction. |
| `support.read` | member | mutating | Returns the thread, its participants (requester + assignee profiles), and messages. Upserts the caller's read cursor to the latest message. Gated by `actor_can_access_support_thread`. |
| `support.list` | member | read_only | Lists support/escalation threads visible to the actor, with unread counts. Filterable by `status`, `kind`, `clubId`. See [List scopes](#list-scopes) below. |
| `support.resolve` | member | mutating | Only assignee or current club owner (for support) or support contact (for escalation) can resolve. Sets `status = 'resolved'`, `resolved_at`, `resolved_by_member_id`. Inserts a `role='system'` message. |
| `support.escalate` | member | mutating | Only the current club owner (verified via `current_club_owners`) can escalate. Creates a `kind='escalation'` thread. Sets `assignee_member_id` to the least-loaded active support contact. Sets `escalated_from_thread_id`. Inserts the initial message with context from the source thread. Creates read cursors for the escalating owner. Rejects if no active support contacts exist. |
| `support.reassign` | superadmin | mutating | Escalation threads only. Changes `assignee_member_id` to a different active support contact. Inserts a `role='system'` message. |

### List scopes

`support.list` serves different views depending on who is calling. The scopes are:

| Scope | Who | What they see |
|-------|-----|---------------|
| Requester | Any member | Threads where `requester_member_id = actor`. Their own support requests. |
| Assignee | Any member | Threads where `assignee_member_id = actor`. Threads they are personally responsible for. |
| Current-owner queue | Club owners | All `kind='support'` threads in clubs the actor currently owns (via `current_club_owners`). This catches threads assigned to a previous owner after ownership transfer. |
| Support-contact queue | Active support contacts | All `kind='escalation'` threads. Filterable to assigned-only or all. |

These are not mutually exclusive. A club owner who is also a support contact will see results from multiple scopes. The API should expose a `scope` filter parameter (or return a unified list with the actor's relationship to each thread indicated).

The key point: the current-owner queue is NOT `WHERE assignee_member_id = actor`. It is `WHERE club_id IN (clubs actor currently owns)`. This ensures new owners see threads still assigned to the previous owner.

### Admin actions (extend `src/schemas/admin.ts`)

| Action | Auth | Description |
|--------|------|-------------|
| `admin.contacts.list` | superadmin | Lists all platform contacts |
| `admin.contacts.add` | superadmin | Adds a member as a platform support contact |
| `admin.contacts.deactivate` | superadmin | Soft-deletes a platform contact (sets `active = false`, `deactivated_at`) |

## Contract types

```
SupportThreadSummary
  threadId: string
  clubId: string
  kind: 'support' | 'escalation'
  status: 'open' | 'resolved'
  subject: string | null
  requester: { memberId, publicName, handle }
  assignee: { memberId, publicName, handle }
  escalatedFromThreadId: string | null
  createdAt: string
  resolvedAt: string | null
  resolvedByMemberId: string | null
  latestMessage: { messageId, senderMemberId (nullable), role, messageText, createdAt } | null
  messageCount: number

SupportQueueEntry extends SupportThreadSummary
  unread: { hasUnread: boolean, unreadMessageCount: number }

SupportMessageEntry
  messageId: string
  threadId: string
  senderMemberId: string | null
  role: 'member' | 'agent' | 'system'
  messageText: string | null
  payload: Record<string, unknown>
  createdAt: string

PlatformContact
  contactId: string
  memberId: string
  publicName: string
  handle: string | null
  role: 'support'
  active: boolean
  createdAt: string
```

Requester and assignee are explicit fields, not a viewer-relative `counterpartMemberId`. Profile data is resolved via the `get_support_thread_profiles` security-definer function.

## Explicitly out of scope for v1

| Feature | Rationale | Path to v2 |
|---------|-----------|------------|
| Redaction | Low risk -- support threads are low-volume between known parties. Resolve + escalate offline if needed. | Add `'support_message'` to `app.redactions.target_kind`, filter in support repository queries. |
| Quotas | No concrete abuse scenario yet. | Rate-limit `support.open` only (not replies). Exempt support contacts. |
| `member_updates` integration | No unified inbox requirement yet. Polling is sufficient for v1 support volumes. | Add `support_message_id` FK to `member_updates`, update CHECK constraint, bridge to `pending_member_updates`. |
| Real-time delivery | v1 is polling-only. | WebSocket/SSE push for support notifications, driven by `member_updates` integration. |
| `closed` status | `open` -> `resolved` is sufficient. | Additive enum change if admin-close or auto-close is needed. |
| `archived_at` | No archive workflow defined yet. | Add column when soft-hide/admin-archive is needed. |
| Reassignment of support threads | Owner continuity is the right default. New owner has visibility via queue. | Add `support.reassign` for `kind='support'` if needed. |
| Ownership transfer cascade | Open support threads keep the old owner as assignee. New owner sees the queue. | Automatic reassignment on `clubs.assignOwner` if manual handoff proves insufficient. |

## File changes (estimated)

| File | Change |
|------|--------|
| `db/migrations/007X_platform_contacts.sql` | New table, helper function, RLS |
| `db/migrations/007Y_support_tables.sql` | `support_threads`, `support_messages`, `support_thread_reads`, enums, indexes, security-definer functions, RLS |
| `src/schemas/support.ts` | New -- 7 action definitions |
| `src/schemas/admin.ts` | Add `admin.contacts.*` |
| `src/postgres/support.ts` | New -- support repository queries |
| `src/postgres/admin.ts` | Add platform contacts queries |
| `src/contract.ts` | Add support + platform contact types |
| `src/schemas/transport.ts` | Add support response shapes |
| `src/dispatch.ts` | Import + register support actions |
| `test/integration/support.test.ts` | New -- support integration tests |

Existing DM code (`src/postgres/messages.ts`, `src/schemas/messages.ts`, DM views, DM RLS policies) is not modified.
