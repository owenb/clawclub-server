# ClawClub Company Billing Layer — Implementation Plan

Date: 2026-04-07 (v2 — destination charges)

## Context

The open-source ClawClub product is a community platform with a membership state machine and an HTTP API. It knows nothing about Stripe, ledgers, or marketplace economics. It exposes 8 `superadmin.billing.*` sync actions that an external billing system calls to update membership, subscription, and club state.

This document is the implementation plan for the **private company billing layer** — a separate repo and database that handles all Stripe integration, financial accounting, and marketplace economics for ClawClub Ltd (the business).

### Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│  ClawClub Product (OSS)         │     │  Company Billing Layer (private) │
│                                 │     │                                  │
│  Product DB (Railway)           │◄────│  Calls superadmin.billing.* API  │
│  - members, clubs, memberships  │     │                                  │
│  - subscriptions (thin)         │     │  Company DB (Neon)               │
│  - access control               │     │  - Stripe ID mappings            │
│                                 │     │  - Append-only ledger            │
│  HTTP API                       │     │  - Payouts, fees, discounts      │
│  - superadmin.billing.*         │     │                                  │
│  - billing.getMembershipStatus   │     │  Stripe                          │
│                                 │     │  - Checkout, Connect, Webhooks   │
│                                 │     │  - Destination charges           │
└─────────────────────────────────┘     └──────────────────────────────────┘
```

### Stripe integration model: destination charges

Revenue is split at charge time. When a member pays $100 for a club:
- Stripe calculates the total (including tax via Stripe Tax)
- ClawClub's `application_fee_amount` ($30, being 30% of $100) stays on the platform
- The operator's share ($70) goes directly to their Connect Express account
- Tax collected is handled separately by Stripe Tax

This is Stripe's recommended model for marketplaces. No manual transfers, no hold periods, no balance tracking for fund routing.

### References

- Product sync surface: `docs/billing-sync-contract.md`
- Business rules: `docs/billing-design.md` (v5)
- Operator agreement: `docs/operator-agreement.md`
- Product schema: `db/init.sql`

---

## Phase 1: Company DB schema

### Database

- Local development: `clawclub_billing_dev` on localhost Postgres
- Production: Neon (separate from the product DB on Railway)
- Schema namespace: `billing`

### Tables

All tables use `text` for product entity IDs (soft references — no cross-database FKs). Timestamps are `timestamptz`. Monetary amounts are `numeric(12,2)`.

#### `billing.stripe_customers`

Maps ClawClub members to Stripe Customer objects. One per member, created lazily at first checkout.

```sql
CREATE TABLE billing.stripe_customers (
  member_id           text NOT NULL PRIMARY KEY,
  stripe_customer_id  text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

#### `billing.stripe_products`

Maps clubs to Stripe Product objects. One per club, created when the club gets a price.

```sql
CREATE TABLE billing.stripe_products (
  club_id             text NOT NULL PRIMARY KEY,
  stripe_product_id   text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

#### `billing.stripe_prices`

Maps club price points to Stripe Price objects. Immutable — new row when price changes. Old prices retained for grandfathered members.

```sql
CREATE TABLE billing.stripe_prices (
  id                  serial PRIMARY KEY,
  club_id             text NOT NULL,
  stripe_price_id     text NOT NULL UNIQUE,
  amount              numeric(12,2) NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',
  is_current          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_prices_club_current_idx
  ON billing.stripe_prices (club_id) WHERE is_current = true;
```

#### `billing.stripe_subscriptions`

Maps product memberships to Stripe Subscription objects. One row per paid membership.

```sql
CREATE TABLE billing.stripe_subscriptions (
  membership_id           text NOT NULL PRIMARY KEY,
  member_id               text NOT NULL,
  club_id                 text NOT NULL,
  stripe_subscription_id  text NOT NULL UNIQUE,
  stripe_price_id         text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

#### `billing.connect_profiles`

Maps club owners to Stripe Connect Express accounts. One per operator.

```sql
CREATE TABLE billing.connect_profiles (
  member_id           text NOT NULL PRIMARY KEY,
  stripe_connect_id   text NOT NULL UNIQUE,
  onboarding_status   text NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN ('pending', 'complete')),
  payout_paused       boolean NOT NULL DEFAULT false,
  payout_pause_reason text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

#### `billing.club_platform_fees`

Tracks the $299/year operator fee per club.

```sql
CREATE TABLE billing.club_platform_fees (
  club_id                 text NOT NULL PRIMARY KEY,
  payer_member_id         text NOT NULL,
  stripe_subscription_id  text,
  status                  text NOT NULL DEFAULT 'active',
  comp_seats_included     integer NOT NULL DEFAULT 10,
  additional_comp_seats   integer NOT NULL DEFAULT 0,
  current_period_end      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
```

#### `billing.discount_codes`

Operator-created discount codes. First-year-only.

```sql
CREATE TABLE billing.discount_codes (
  id                   serial PRIMARY KEY,
  club_id              text NOT NULL,
  code                 text NOT NULL,
  discount_percent     integer NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  stripe_coupon_id     text,
  max_uses             integer,
  current_uses         integer NOT NULL DEFAULT 0,
  expires_at           timestamptz,
  archived_at          timestamptz,
  created_by_member_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, code)
);
```

#### `billing.ledger_events`

Append-only financial ledger. Every financial event is a row. Balance derived by summing events.

With destination charges, the ledger is primarily for **accounting and reporting** — Stripe handles the actual money movement. The ledger records what happened for statements, dispute tracking, and balance visibility.

```sql
CREATE TYPE billing.ledger_event_type AS ENUM (
  'member_payment', 'platform_fee',
  'chargeback_hold', 'chargeback_hold_released', 'chargeback_confirmed',
  'refund_cascade',
  'operator_fee', 'comp_seat_fee',
  'operator_requested_refund', 'discount_shortfall'
);

CREATE TABLE billing.ledger_events (
  id                    serial PRIMARY KEY,
  club_id               text NOT NULL,
  operator_member_id    text NOT NULL,
  member_id             text,
  membership_id         text,
  event_type            billing.ledger_event_type NOT NULL,
  amount                numeric(12,2) NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  resolved_by_event_id  integer REFERENCES billing.ledger_events(id),
  stripe_event_id       text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement
CREATE FUNCTION billing.ledger_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing.ledger_events is append-only: % not allowed', TG_OP; END;
$$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON billing.ledger_events
  FOR EACH ROW EXECUTE FUNCTION billing.ledger_immutable_guard();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON billing.ledger_events
  FOR EACH ROW EXECUTE FUNCTION billing.ledger_immutable_guard();

CREATE INDEX ledger_events_club_operator_idx
  ON billing.ledger_events (club_id, operator_member_id, created_at);
CREATE INDEX ledger_events_membership_idx
  ON billing.ledger_events (membership_id) WHERE membership_id IS NOT NULL;
```

Note: no `hold_expires_at` column. No `payout` event type. No `tail_holdback` events. Stripe handles money movement via destination charges and Connect payouts. The ledger tracks revenue, fees, chargebacks, and refunds for accounting.

#### `billing.processed_webhooks`

Stripe webhook deduplication.

```sql
CREATE TABLE billing.processed_webhooks (
  stripe_event_id   text PRIMARY KEY,
  event_type        text NOT NULL,
  processed_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## Phase 2: Service token and product API client

### Service token

Create a superadmin bearer token for the product API. Store as environment variable.

```
CLAWCLUB_SERVICE_TOKEN=cc_live_xxxxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyy
CLAWCLUB_API_URL=http://127.0.0.1:8787
```

### Product API client

Thin HTTP client wrapping the product's action-dispatch API with typed methods for all 8 sync actions plus `billing.getMembershipStatus`. See `docs/billing-sync-contract.md` for exact input/output schemas and idempotency rules.

---

## Phase 3: Stripe integration — first payment path

The minimum viable billing loop: a member can pay and get access.

### 3a. Club setup

When an operator makes a club paid:

1. Create Stripe Product for the club → store in `billing.stripe_products`
2. Create Stripe Price on the Product → store in `billing.stripe_prices`
3. Call `productClient.setClubPrice(clubId, amount, currency)` → product records the price

### 3b. Connect onboarding

Before the operator can receive revenue, they need a Connect Express account:

1. Operator's agent calls company API: `POST /billing/connect/onboard`
2. Create Stripe Connect Express account → `billing.connect_profiles`
3. Return Stripe-hosted onboarding URL (name, DOB, address, bank details, tax ID)
4. Operator completes the form (5-10 minutes, Stripe handles KYC)
5. Webhook `account.updated` → update `onboarding_status = 'complete'`

### 3c. Checkout flow

When a member needs to pay (membership is `payment_pending`):

1. Member's agent calls company API: `POST /billing/checkout { membershipId }`
2. Company looks up or creates Stripe Customer → `billing.stripe_customers`
3. Look up the operator's Connect account ID for destination
4. Create Stripe Checkout Session:
   ```
   mode: 'subscription'
   customer: stripeCustomerId
   line_items: [{ price: currentStripePriceId, quantity: 1 }]
   subscription_data:
     metadata: { membership_id, club_id, member_id }
     application_fee_percent: 30  (or application_fee_amount for the $29 floor)
     transfer_data: { destination: operatorConnectAccountId }
   payment_method_types: ['card']
   automatic_tax: { enabled: true }
   ```
5. Return Checkout Session URL

**Revenue split at checkout creation:**
- If `amount * 0.30 >= 29`: use `application_fee_percent: 30`
- If `amount * 0.30 < 29`: use `application_fee_amount: 2900` (in cents, the $29 floor)

### 3d. Webhook: `checkout.session.completed`

Stitches Stripe IDs. Does NOT activate membership.

1. Check `billing.processed_webhooks` — skip if already processed
2. Store in `billing.stripe_subscriptions`:
   - `membership_id`, `member_id`, `club_id` from subscription metadata
   - `stripe_subscription_id`, `stripe_price_id`, `status`, `current_period_end`
3. Insert into `billing.processed_webhooks`

### 3e. Webhook: `invoice.paid`

The canonical money-moved event. Activates the membership and records the ledger entry.

1. Check `billing.processed_webhooks` — skip if already processed
2. Look up `membership_id` from `billing.stripe_subscriptions` via `stripe_subscription_id`
3. Calculate the split:
   - `platform_share = max(amount * 0.30, 29)`
   - `operator_share = amount - platform_share`
4. Write `billing.ledger_events`:
   - `member_payment`: `+operator_share` (already in operator's Connect account via destination charge)
   - `platform_fee`: `+platform_share` (informational — already on platform)
5. Determine first payment vs renewal:
   - **First payment:** call `productClient.activateMembership(membershipId, periodEnd)`
   - **Renewal:** call `productClient.renewMembership(membershipId, newPeriodEnd)`
6. Insert into `billing.processed_webhooks`

### 3f. Webhook: `invoice.payment_failed`

1. Look up `membership_id` via `billing.stripe_subscriptions`
2. Call `productClient.markRenewalPending(membershipId)` → product grants 7-day grace

### 3g. Webhook: `customer.subscription.deleted`

1. Look up `membership_id` via `billing.stripe_subscriptions`
2. Call `productClient.expireMembership(membershipId)`
3. Update `billing.stripe_subscriptions.status = 'canceled'`

---

## Phase 4: Cancellation and operator-requested refunds

### Member cancellation

1. Member's agent calls company API: `POST /billing/cancel { membershipId }`
2. Stripe: `stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true })`
3. Update `billing.stripe_subscriptions.cancel_at_period_end = true`
4. Call `productClient.cancelAtPeriodEnd(membershipId)`
5. Access continues until `current_period_end`. Stripe fires `customer.subscription.deleted` at period end → phase 3g handles it.

### Operator-requested refund

1. Operator calls company API: `POST /billing/refund { membershipId }`
2. Stripe refund: `stripe.refunds.create({ charge, reverse_transfer: true, refund_application_fee: true })`
   - `reverse_transfer: true` reverses the destination transfer from the operator's Connect account
   - `refund_application_fee: true` reverses ClawClub's application fee
3. Write ledger event: `operator_requested_refund`
4. Cancel Stripe subscription
5. Call `productClient.expireMembership(membershipId)`

---

## Phase 5: Operator fee collection ($299/year)

### Initial fee

1. Operator decides to run a paid club → company creates a Stripe Subscription for $299/year charged to the operator's card
2. Store in `billing.club_platform_fees`
3. 10 comp seats included

### Annual renewal

- Stripe auto-renews
- `invoice.paid` → update `billing.club_platform_fees.current_period_end`
- `invoice.payment_failed` → 7-day grace, then freeze club (call `productClient.archiveClub`)

### Comp seat management

- Company tracks allocation: `comp_seats_included + additional_comp_seats`
- When operator comps a member, company checks quota
- Additional seats: $29/seat/year (separate Stripe line item or manual charge)
- Product only knows `is_comped = true` — quota is company-side

---

## Phase 6: Discount codes

1. Operator creates discount: `POST /billing/discounts { clubId, code, discountPercent }`
2. Validate cap: `discountPercent` must not push operator share below $0
3. Create Stripe Coupon (`percent_off`, `duration: 'once'` for first year)
4. Store in `billing.discount_codes`
5. At checkout: apply Coupon to Checkout Session. Stripe handles the reduced first-year charge.
6. On `invoice.paid`: ledger records platform share based on **original undiscounted price**, not the discounted amount. The discount comes out of the operator's share.
7. On renewal: Stripe charges full price (coupon expired). Normal split resumes.

---

## Phase 7: Dispute handling (manual v1)

### Webhook: `charge.dispute.created`

1. Look up `membership_id` via the charge's subscription
2. Write `chargeback_hold` ledger event: `-(disputed_amount + 25)` (provisional)
3. Notify operator
4. Stripe automatically debits the dispute amount from the operator's Connect account (or creates negative balance)
5. Check circuit breaker: if operator's dispute rate >= 0.5% at 200+ members → pause payouts

### Webhook: `charge.dispute.closed`

**Won:**
1. Write `chargeback_hold_released` ledger event: `+disputed_amount`
2. $25 fee remains debited
3. Stripe returns funds to Connect account

**Lost:**
1. Write `chargeback_confirmed` ledger event (hold becomes permanent)
2. $25 fee finalized
3. Call `productClient.banMember(memberId, reason)`
4. Cancel all Stripe subscriptions for the banned member
5. **No automated refund cascade in v1** — manual review

### Circuit breaker

- Per-operator: query ledger for `chargeback_hold` vs `member_payment` counts in trailing 12 months
- < 200 members: any dispute → flag for manual review
- >= 200 members: >= 0.5% rate → set `billing.connect_profiles.payout_paused = true`
- Paused operator: Stripe Connect payout schedule can be set to `manual` to prevent automatic payouts
- Resolution: manual review → reinstate or terminate

---

## Phase 8: Balance and statements

### Operator balance

With destination charges, the operator's money is in their Connect account (managed by Stripe). The company ledger tracks the **accounting view** — what they earned, what was debited.

`GET /billing/balance?clubId=...` returns:

```json
{
  "totalEarned": 3500.00,
  "totalDebits": 125.00,
  "provisionalHolds": 0,
  "netPosition": 3375.00
}
```

Derived from ledger events. This is an accounting summary, not a "balance you control." The actual money is in the operator's Stripe account.

### Monthly statements

`GET /billing/statements?clubId=...&period=2026-03` returns ledger events for the period with aggregates: members joined, revenue, platform share, chargebacks, fees.

---

## Phase 9: Company API endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /billing/checkout` | member | Create Stripe Checkout Session, return URL |
| `POST /billing/cancel` | member | Cancel subscription at period end |
| `GET /billing/status` | member | Rich billing status (wraps product billing.getMembershipStatus + Stripe data) |
| `POST /billing/connect/onboard` | club owner | Start Stripe Connect Express onboarding |
| `GET /billing/balance` | club owner | Accounting summary |
| `GET /billing/statements` | club owner | Monthly statement |
| `POST /billing/pricing` | club owner | Set/change club price |
| `POST /billing/discounts` | club owner | Create discount code |
| `GET /billing/discounts` | club owner | List discount codes |
| `POST /billing/refund` | club owner | Refund a removed member |
| `POST /billing/archive` | club owner | Request club closure |
| `POST /webhooks/stripe` | Stripe signature | Webhook handler |

Auth for member/owner endpoints: validate the bearer token by calling `session.getContext` on the product API and checking the actor context.

---

## Environment variables

```
# Product connection
CLAWCLUB_API_URL=http://127.0.0.1:8787
CLAWCLUB_SERVICE_TOKEN=cc_live_...

# Company database
COMPANY_DATABASE_URL=postgresql://localhost/clawclub_billing_dev

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Operational
PORT=8788
NODE_ENV=development
```

---

## Implementation order

| Phase | What | Dependencies |
|---|---|---|
| 1 | Company DB schema | None |
| 2 | Service token + product API client | Phase 1 |
| 3 | Connect onboarding + Checkout → invoice.paid → activateMembership | Phases 1-2, Stripe test keys |
| 4 | Cancellation + operator refunds | Phase 3 |
| 5 | Operator fee ($299) + comp seat quotas | Phase 3 |
| 6 | Discount codes | Phase 3 |
| 7 | Dispute handling (manual v1) | Phase 3 |
| 8 | Balance + statements | Phase 3 |
| 9 | Company API endpoints | All above |

**Phase 3 is the proof point.** Once a member can pay via Stripe Checkout with destination charges and get access in the product, the architecture is validated.

---

## Testing strategy

### Integration tests

- Use Stripe test mode with test card numbers
- Spin up product server + company service
- Full loop: set price → Connect onboard → checkout → simulate `invoice.paid` → verify product access
- Cancellation: cancel → verify `cancelled` → simulate period end → verify `expired`
- Dispute: simulate `charge.dispute.created` → verify ledger hold → simulate resolution

### Stripe test mode

- `stripe trigger` CLI to simulate webhook events
- Test card `4242424242424242` for successful payments
- Test card `4000000000000341` for declined payments
- `stripe listen --forward-to localhost:8788/webhooks/stripe` for local webhook forwarding

---

## What is NOT in this plan

- Automated cross-platform ban cascade refunds (manual in v1)
- Stripe Identity (risk-triggered verification)
- Spending ladder / fraud automation
- Renewal reminder emails
- Multi-currency
- Monthly billing
- Service token scoping (use dedicated superadmin token for now)
- Payout scheduling (Stripe Connect handles automatic payouts to operators)
