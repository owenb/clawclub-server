# Billing Sync API

ClawClub supports paid club memberships through an external billing integration. The product itself has no payment provider — it exposes 8 `superadmin.billing.*` actions that a billing system calls to synchronise membership, subscription, and club state.

This document describes the sync surface, its behaviour, and how to integrate with it.

## How it works

1. An operator sets a price on their club (via the billing system calling `superadmin.billing.setClubPrice`).
2. When a member is admitted to a paid club, the product creates a `payment_pending` membership.
3. The billing system collects payment and calls `superadmin.billing.activateMembership` to grant access.
4. On renewal, failure, cancellation, or expiry, the billing system calls the corresponding sync action.
5. The product manages access control based on the membership state and subscription record.

The product never initiates payment or contacts a payment provider. It is a state machine that the billing system drives.

## Configuration

### `BILLING_ENABLED`

Environment variable, boolean, default `false`.

- **`false`**: all clubs are free. Admission acceptance always creates comped memberships. No `payment_pending` memberships can be created. The sync actions still function if called.
- **`true`**: paid pricing is allowed via `superadmin.billing.setClubPrice`. Paid-club mutations (archive, ownership transfer) are blocked except through the billing sync surface.

### Startup check

- **dev/test**: if paid clubs or `payment_pending` memberships exist but `BILLING_ENABLED=false`, a warning is logged.
- **production** (`NODE_ENV=production`): the server fails to start.

The check runs inside `createServer()` via the `ready` promise. Callers should `await ready` before accepting traffic.

## Actions

All actions require `superadmin` auth and are idempotent.

### `superadmin.billing.activateMembership`

Transitions a `payment_pending` membership to `active` and creates a subscription record.

**Input:** `{ membershipId: string, paidThrough: string }`

`paidThrough` is an ISO 8601 date — the end of the paid period.

**Idempotency:**
- Already `active` with `current_period_end >= paidThrough`: no-op.
- Already `active` with earlier `current_period_end`: updates it forward.
- Terminal state (`expired`, `banned`, `removed`, `revoked`, `rejected`): error.

**Side effects:** Creates a subscription row with `status='active'`, `amount` from the membership's `approved_price_amount`, and `current_period_end` from `paidThrough`. Does not set `is_comped`.

### `superadmin.billing.renewMembership`

Extends a subscription's `current_period_end`.

**Input:** `{ membershipId: string, newPaidThrough: string }`

**Idempotency:** Only moves `current_period_end` forward. If `newPaidThrough <= current_period_end`, no-op.

**Side effects:** If the membership was `cancelled` or `renewal_pending`, transitions back to `active`. Creates a subscription if none exists.

### `superadmin.billing.markRenewalPending`

Transitions an `active` membership to `renewal_pending` (payment failed, 7-day grace period).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `renewal_pending`, no-op. If not `active`, error.

**Side effects:** Updates subscription status to `past_due`. The `accessible_memberships` view grants 7-day grace from the state transition timestamp.

### `superadmin.billing.expireMembership`

Transitions a membership to `expired` (terminal, access revoked).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `expired`, no-op. Succeeds from `active`, `renewal_pending`, `cancelled`, `payment_pending`. Error from other terminal states.

**Side effects:** Sets `left_at` via trigger. Updates subscription status to `ended`.

### `superadmin.billing.cancelAtPeriodEnd`

Transitions an `active` membership to `cancelled` (access continues until period end).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `cancelled`, no-op. If not `active`, error.

**Side effects:** Does NOT change subscription status. The subscription remains `active` with its existing `current_period_end`. Access is gated by the subscription's period end date.

### `superadmin.billing.banMember`

Bans a member platform-wide and transitions all their memberships to `banned`.

**Input:** `{ memberId: string, reason: string }`

**Idempotency:** If `members.state` is already `banned`, no-op. If `deleted`, error.

**Side effects:** Sets `members.state = 'banned'`. Iterates all non-terminal memberships and transitions each to `banned`. Updates all live subscriptions to `ended`.

### `superadmin.billing.setClubPrice`

Sets or clears the membership price for a club.

**Input:** `{ clubId: string, amount: number | null, currency: string }`

`amount = null` makes the club free. `currency` defaults to `'USD'`.

**Idempotency:** If the club already has the same price and currency, no-op.

**Side effects:** Creates a new `club_versions` row. The club versioning trigger syncs the price to the `clubs` table. Future admissions to this club will create `payment_pending` memberships (if `amount` is non-null) or comped memberships (if `null`).

### `superadmin.billing.archiveClub`

Archives a club, bypassing the paid-club guard.

**Input:** `{ clubId: string }`

**Idempotency:** If already archived, no-op.

**Side effects:** Sets `clubs.archived_at`. The normal `superadmin.clubs.archive` action rejects paid clubs — this action is the billing-authorised path.

## Paid-club guards

When `BILLING_ENABLED=true`, the product blocks certain mutations on paid clubs to ensure they flow through the billing system:

| Mutation | Behaviour |
|---|---|
| `superadmin.clubs.archive` on a paid club | Rejected (use `superadmin.billing.archiveClub`) |
| `superadmin.clubs.assignOwner` on a paid club | Rejected (ownership transfer not supported for paid clubs) |

There is no product-side action for setting a club's price. All price changes come through `superadmin.billing.setClubPrice`.

## `billing.getMembershipStatus`

A member-facing read action (not part of the sync surface).

**Auth:** member

**Input:** `{ clubId: string }`

**Response:**
```json
{
  "membership": {
    "membershipId": "...",
    "state": "active",
    "isComped": false,
    "paidThrough": "2027-04-07T00:00:00Z",
    "approvedPrice": { "amount": 100, "currency": "USD" }
  }
}
```

Returns `null` if the member has no membership in the specified club. Returns only product-local state — no payment provider data.

## Membership lifecycle for paid clubs

```
admission accepted
  ↓
payment_pending  ──→  activateMembership  ──→  active
                                                 ↓
                                    cancelAtPeriodEnd  ──→  cancelled
                                    markRenewalPending ──→  renewal_pending
                                                              ↓
                                                 renewMembership  ──→  active
                                                 expireMembership ──→  expired
                                    
  any non-terminal  ──→  expireMembership  ──→  expired
  any non-terminal  ──→  banMember         ──→  banned (all clubs)
```

For free/comped clubs, admission acceptance creates `active` + `is_comped` memberships directly. The sync surface is not involved.
