# Billing Sync Contract

The product exposes 8 `superadmin.billing.*` actions that an external billing system calls to synchronise billing state into the product. All actions require superadmin auth and are idempotent.

## Environment

`BILLING_ENABLED` (boolean, default `false`)

- **`false`**: all clubs are free. No `payment_pending` memberships can be created (admission acceptance always comps). The 8 sync actions still function (they operate on product state regardless).
- **`true`**: paid pricing allowed via `superadmin.billing.setClubPrice` only. There is no product-side `clubadmin.pricing.set` action — all price changes flow through the billing sync surface. Archive and ownership transfer of paid clubs are blocked except through the billing sync surface.

**Startup behaviour:**
- **dev/test**: if paid clubs exist but `BILLING_ENABLED=false`, log a warning.
- **production** (`NODE_ENV=production`): if paid clubs or `payment_pending` memberships exist but `BILLING_ENABLED=false`, fail startup.

## Actions

### 1. `superadmin.billing.activateMembership`

Transitions a `payment_pending` membership to `active` and creates a subscription record.

**Input:** `{ membershipId: string, paidThrough: string (ISO date) }`

**Idempotency:** If the membership is already `active` with a subscription whose `current_period_end >= paidThrough`, no-op. If `active` with an earlier `current_period_end`, updates it forward. If in any terminal state (`expired`, `banned`, `removed`, `revoked`, `rejected`), returns error.

**Side effects:** Creates a subscription row `(membership_id, payer_member_id=member_id, status='active', amount=club_price, current_period_end=paidThrough)`. Does NOT set `is_comped`.

### 2. `superadmin.billing.renewMembership`

Updates subscription `current_period_end` on an active membership.

**Input:** `{ membershipId: string, newPaidThrough: string (ISO date) }`

**Idempotency:** Only moves `current_period_end` forward. If `newPaidThrough <= current_period_end`, no-op. If membership is not `active`, returns error.

**Side effects:** Updates existing subscription `current_period_end`. If membership was `cancelled`, transitions back to `active` (renewal recovered).

### 3. `superadmin.billing.markRenewalPending`

Transitions an `active` membership to `renewal_pending` (payment failed, 7-day grace).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `renewal_pending`, no-op. If in any state other than `active`, returns error.

**Side effects:** Inserts a new `membership_state_versions` row. Updates subscription status to `past_due`.

### 4. `superadmin.billing.expireMembership`

Transitions a membership to `expired` (terminal, access revoked).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `expired`, no-op. Succeeds from `active`, `renewal_pending`, `cancelled`, `payment_pending`. Returns error from other terminal states.

**Side effects:** Sets `left_at` via trigger. Updates subscription status to `ended`.

### 5. `superadmin.billing.cancelAtPeriodEnd`

Transitions an `active` membership to `cancelled` (access until period end).

**Input:** `{ membershipId: string }`

**Idempotency:** If already `cancelled`, no-op. If not `active`, returns error.

**Side effects:** Inserts a new `membership_state_versions` row. Does NOT change subscription status (Stripe keeps it `active` until period end; the product relies on `current_period_end` for access gating).

### 6. `superadmin.billing.banMember`

Bans a member platform-wide and transitions all their memberships to `banned`.

**Input:** `{ memberId: string, reason: string }`

**Idempotency:** If `members.state` is already `banned`, no-op. If member is `deleted`, returns error.

**Side effects:** Sets `members.state = 'banned'`. Iterates all non-terminal memberships and transitions each to `banned`. Updates all live subscriptions to `ended`.

### 7. `superadmin.billing.setClubPrice`

Sets or clears the membership price for a club.

**Input:** `{ clubId: string, amount: number | null, currency: string }`

**Idempotency:** If the club already has the same price and currency, no-op. Creates a new `club_versions` row (the product's standard versioned-update pattern).

**Side effects:** Updates `clubs.membership_price_amount` and `clubs.membership_price_currency` via the club versioning trigger. `null` amount = free club.

### 8. `superadmin.billing.archiveClub`

Archives a paid club (after the billing system has settled balances).

**Input:** `{ clubId: string }`

**Idempotency:** If already archived, no-op.

**Side effects:** Sets `clubs.archived_at`. Same as the existing `superadmin.clubs.archive` but bypasses the paid-club guard.

## Product-side guards (when `BILLING_ENABLED=true`)

| Mutation | Guard |
|---|---|
| `superadmin.clubs.archive` on paid club | Rejected: "Paid clubs must be archived through the billing system" |
| `superadmin.clubs.assignOwner` on paid club | Rejected: "Ownership transfer of paid clubs is not supported" |

There is no `clubadmin.pricing.set` action in the product. All price changes are company-initiated via `superadmin.billing.setClubPrice`.

When `BILLING_ENABLED=false`, all three mutations also reject non-null prices / paid clubs, since no billing system is available to handle them.

## `billing.status` response shape

**Auth:** member

**Input:** `{ clubId: string }`

**Response:**
```json
{
  "membershipId": "...",
  "state": "active",
  "isComped": false,
  "paidThrough": "2027-04-07T00:00:00Z",
  "approvedPrice": { "amount": 100, "currency": "USD" }
}
```

Returns only product-local state. No checkout URLs, no balance, no Stripe data. Returns `null` if the member has no membership in the specified club.

## Paid-club mutation flow

Price changes, archival, and ownership transfer for paid clubs are company-initiated:

1. Company layer validates (Stripe objects, balance settlement, etc.)
2. Company layer calls `superadmin.billing.setClubPrice` / `superadmin.billing.archiveClub`
3. Product updates its state

The product never initiates these mutations for paid clubs.
