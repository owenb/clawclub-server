# ClawClub Billing Design

Date: 2026-04-05

## Overview

ClawClub is the merchant of record for all member payments. Club operators do not handle billing directly — ClawClub collects subscription revenue, manages chargebacks, and pays operators from an internal balance. Operators pay an annual platform fee and are accountable for who they admit.

ClawClub is a UK-based business. VAT applies.

## Pricing model

### Operator fee

- **$299/year** to run a club on ClawClub.
- Includes **10 complimentary member seats** (comps). These are lifetime seats — the allocation persists as long as the club exists and the operator fee is current. An operator with only comped members has no member-side Stripe subscriptions; the $299 fee covers everything.
- Additional comp seats can be purchased at **$29/seat/year**.
- Renews annually. Can be auto-deducted from the operator's balance if sufficient funds are available.
- If the operator does not renew, the club is **frozen after a 7-day grace period**. No new members can join; existing members retain access until their own subscriptions expire.

### Member pricing

- All prices are in **USD** and are **tax-exclusive**. VAT (or applicable local sales tax) is charged on top at the rate required by the member's jurisdiction.
- **Minimum membership price: $29/year.**
- Club operators set the price. They can set it at $29 (the minimum) or any amount above.
- **Annual billing only.** Each member has their own annual cycle starting from their join date.
- Members pay via **Stripe Checkout** (handles SCA/3DS automatically).
- Members see "ClawClub" as the merchant and the club name in the line item description.
- **No free trials.** Operators can offer discount codes (see below).
- **Price grandfathering:** Whatever price a member joins at, they keep for as long as they remain subscribed. If an operator raises the price, existing members renew at their original price. New members pay the new price.

### Platform revenue split

ClawClub takes **30% of the membership price or $29, whichever is greater.** This is calculated on the **pre-tax** amount. Tax is purely pass-through — ClawClub collects it and remits it. Neither ClawClub nor the operator "earns" the tax portion.

Examples:
- $29/year club: ClawClub takes $29 (floor), operator gets $0.
- $50/year club: ClawClub takes $29 (floor, since 30% = $15 < $29), operator gets $21.
- $100/year club: ClawClub takes $30 (30% > $29), operator gets $70.
- $200/year club: ClawClub takes $60 (30%), operator gets $140.

The $29 floor kicks in for any club priced below ~$97/year. Above that, the 30% rate applies.

These rates are configurable per club. ClawClub may negotiate different terms with specific operators on a case-by-case basis, including offering reduced per-member costs for clubs with lower usage patterns.

### Free clubs

Free clubs exist entirely outside of Stripe. No billing involvement. Membership is tracked in the ClawClub database only. An operator running a free-only club still pays the $299/year platform fee. If their entire membership fits within the 10 included comp seats (or additional purchased comp seats), there are no member-side subscriptions at all.

### Discount codes

- Created by the **operator**, for their own club.
- Discounts reduce the price the member pays.
- **The discount comes out of the operator's share, not ClawClub's.** ClawClub still takes its full cut (30% or $29 floor, calculated on the **original undiscounted price**).
- Example: $100/year club, 50% discount code. Member pays $50. ClawClub takes $30 (30% of $100). Operator gets $20 instead of $70.
- A discount code can reduce the total price below ClawClub's floor. In that case, the operator's share goes negative for that member (offset against their balance). Operators should be aware of this when setting deep discounts.
- **No free trials.** Discount codes are the only promotional mechanism.

## Comp seats

- The $299 operator fee includes **10 lifetime comp seats**.
- The operator chooses which members receive comps.
- Additional comp seats can be purchased at **$29/seat/year**.
- Comped members have identical access to paid members inside the club.
- Comped members have no Stripe subscription. Access is managed entirely in the ClawClub database.

## Operator balance and payouts

### Balance model

Each operator has a running **balance** in ClawClub's internal ledger. The balance is affected by:

- **Credits:** Member subscription payments (operator's share after ClawClub's cut).
- **Debits:** Chargeback losses, chargeback fees ($25 per chargeback), proactive refunds from cross-platform bans, and the annual operator fee (if deducted from balance).

### Payout schedule

- **120-day hold on all transactions.** Operator revenue from a member payment becomes eligible for payout 120 days after the transaction date.
- This covers the standard credit card dispute window from the **payment date**. Most chargebacks during this period are caught before any money leaves the platform.
- After the 120-day hold, eligible funds are paid out **monthly**.
- This is comparable to how Apple pays App Store developers — the hold exists because the dispute window exists.

**Important caveat: future-service disputes.** For annual subscriptions (one upfront payment for a year of service), card networks may allow disputes up to 120 days from the **service date**, not the payment date. This means a member could dispute months after the 120-day hold has expired. The rolling reserve (below) exists to cover this residual tail risk.

**Operator pitch:** "Your first payouts arrive roughly 4 months after your first paid members join, then monthly after that as the rolling window catches up."

In practice, most operators will start with their 10 free comp seats and build a member base gradually. By the time they have meaningful paid member revenue, the 120-day window for their earliest members is already closing.

### Rolling reserve

In addition to the 120-day hold, ClawClub retains a **rolling reserve of 10%** of all payouts. This reserve covers:

- Late disputes filed against the service date (past the 120-day payment-date window).
- Disputes on renewal charges, which lack 3DS liability shift (see below).
- Any edge cases where a dispute arrives after funds have been released.

The reserve is held indefinitely while the club is active. When an operator **closes their club and all memberships have expired or been cancelled**, the reserve is returned to them. This is the final settlement.

### Reserve threshold

- If the operator's balance (excluding rolling reserve) drops below **$200**, payouts are **frozen** and the operator is notified.
- This ensures a minimum buffer exists on top of the rolling reserve.
- If the balance remains below $200 or goes negative, ClawClub reaches out to the operator. If unresolved, the club is suspended until the operator tops up.

### Operator visibility

- Operators see their balance in **real time**, including pending (within 120-day hold) and available (past 120 days) amounts.
- Full monthly statements are provided showing: members joined, revenue collected, ClawClub's cut, chargebacks, chargeback fees, refunds, and net payout.
- No surprises.

## Chargeback handling

### Stripe's 0.75% threshold

Stripe flags accounts with dispute activity above **0.75%** as excessive, and this includes won disputes. This is the hard constraint the entire chargeback design must respect — not the 10% survival rate we initially modeled.

The 120-day payout hold, fraud prevention layers, and per-operator monitoring all exist to keep the **platform-wide** dispute rate well below 0.75%.

### Per-operator circuit breaker

Because Stripe measures disputes at the **platform level** (not per operator), one bad operator can drag the entire platform into monitoring. To protect against this:

- The circuit breaker only activates after an operator has had **at least 20 paid members billed** (minimum volume floor). Below this threshold, chargebacks are handled normally (fee deducted, member banned) but the club is not auto-suspended.
- Once the volume floor is met, any operator whose members exceed a **0.5% dispute rate** (measured over a trailing 12-month window) has their club suspended for review.
- This fires before the platform-wide 0.75% threshold is reached.
- Suspension means no new members can join. Existing members retain access. Payouts are frozen.
- ClawClub investigates and either reinstates or terminates the operator.
- Below the 20-member threshold, ClawClub relies on manual review — any dispute on a small club is flagged for the ClawClub team to investigate.

### ClawClub's role

ClawClub handles all chargeback administration on behalf of operators. This is part of the platform value proposition. However, the financial liability sits with the operator — ClawClub marks up the chargeback fee and deducts it from the operator's balance.

### Per-chargeback cost to operator

- Stripe dispute fee: $15
- ClawClub markup: $10
- **Total chargeback fee: $25**, deducted from operator balance.
- Plus the full refunded amount is deducted from the operator's balance.
- Because of the 120-day payout hold, in most cases this money has not yet been paid out, so the deduction is against pending funds — not money ClawClub needs to recover.

### Dispute ledger states

Disputes have a lifecycle. When Stripe opens a dispute, they debit the disputed amount immediately — before a resolution is reached. The operator ledger must track this:

- **`dispute_opened`**: Stripe has debited the disputed amount. A provisional hold is placed on the operator's balance for the disputed amount + $25 chargeback fee. This amount is excluded from payout calculations.
- **`dispute_lost`**: The dispute is resolved against ClawClub. The provisional hold becomes a permanent debit. The $25 fee is finalized. Cross-platform ban and refund cascade is triggered.
- **`dispute_won`**: The dispute is resolved in ClawClub's favour. Stripe returns the disputed amount (but keeps their $15 fee). The provisional hold is released. The $25 chargeback fee is still charged to the operator (ClawClub absorbed admin cost and the $15 Stripe fee is not returned). No cross-platform ban is triggered.

This prevents operator balances and monthly statements from double-counting or misstating exposure during the dispute resolution period.

### Cross-platform ban

When a member chargebacks **any** club:

1. The member is **permanently banned** from the entire ClawClub platform.
2. **All** of their other club memberships are **immediately cancelled**.
3. ClawClub **proactively refunds** the remaining clubs. This avoids additional chargebacks (which would count against ClawClub's dispute ratio with Stripe) but means the refund cost is real.
4. Each refunded club's operator has the refund amount deducted from their balance.
5. Refunds are prorated to the remaining service period — not the full annual amount. A member who chargebacks 10 months into their year only triggers 2 months of prorated refunds on their other clubs.

**Rationale:** Every operator in the chain approved that member's admission. The refund loss is the cost of that approval decision. This is not punishing innocent bystanders — it holds every operator accountable for their own admissions. This incentivizes all operators to take admissions seriously. Operators agree to these terms when they join the platform.

### 3DS liability shift

Stripe Checkout enforces Strong Customer Authentication (3DS) automatically on the **initial payment**. For "unauthorized transaction" chargebacks (the most common type), 3DS shifts liability to the card issuer, not ClawClub. This significantly reduces exposure on first-year charges.

**Renewal charges are less protected.** Annual renewals are merchant-initiated transactions (MIT) — they run off-session with no customer challenge and **no 3DS liability shift**. This means ClawClub bears full chargeback liability on renewal charges. The risk is accepted because:
- A member who has been active for a year is less likely to dispute.
- The 120-day hold and rolling reserve cover the financial exposure.
- The chargeback fee ($25) is passed to the operator regardless.
- Requiring re-authentication on every renewal would add significant friction and likely increase involuntary churn (members who miss the email and lapse).

## Fraud prevention

Layered approach, from lightest to heaviest touch:

1. **Club admission gate.** Every member must be approved by the club operator. This is the first line of defense against bad actors.
2. **Spending ladder.** Rapid multi-club joins (e.g., 3+ paid clubs in a short window) trigger a flag for review. Fraudsters tend to maximize access quickly.
3. **Retroactive identity verification.** If any part of an account looks suspicious, ClawClub sends a **Stripe Identity** verification link. The member must complete selfie + ID document verification to continue. This can be triggered at any time, not just at signup.
4. **Chargeback penalties.** $25 fee per chargeback discourages operators from being lax with admissions.
5. **Cross-platform ban.** One chargeback = permanent ban + all subscriptions cancelled. Strong deterrent.
6. **Per-operator circuit breaker.** Operators whose members exceed 0.5% dispute rate are suspended.

## Stripe architecture

### Stripe objects

| ClawClub concept | Stripe object | Notes |
|---|---|---|
| Member | Customer | One per ClawClub user |
| Paid club | Product | One per club, metadata includes club ID |
| Club price point | Price | One per price point per club. Prices are immutable in Stripe — see price versioning below |
| Club membership | Subscription | One per member per paid club, independent annual cycles |
| Club operator | Connected Account (Express) | One per operator, covers all their clubs |
| Operator payout | Transfer | Monthly lump sum to connected account (after 120-day hold) |
| Member checkout | Checkout Session | Handles payment, 3DS, card storage |
| Suspicious member | Identity Verification Session | Triggered retroactively when needed |
| Tax | Stripe Tax | Automatic tax calculation and collection at checkout |

### Price versioning

Stripe prices are **immutable** — you cannot change the amount on an existing Price object. When an operator changes their club's membership price:

1. A **new Price** is created on the same Product.
2. The old Price is **not archived** — existing subscribers remain on it (price grandfathering).
3. New members and renewals of members who explicitly opt into the new price use the new Price.
4. The ClawClub database tracks which Price each member is on, along with the platform split terms that were in effect when they joined.
5. Old Prices are only archived when no active subscriptions reference them.

### Tax handling

- ClawClub uses **Stripe Tax** to automatically calculate and collect VAT/sales tax at checkout.
- Prices are **tax-exclusive** — tax is added on top at the applicable rate.
- The platform revenue split (30% or $29 floor) is calculated on the **pre-tax** amount.
- Tax collected is pass-through: ClawClub collects it and remits it to the relevant tax authority. It does not appear in operator balances or payout calculations.
- As a UK business, ClawClub charges VAT. Stripe Tax handles jurisdiction-specific rates for international members.

### Key design choices

- **One subscription per member per club.** Each club membership is independent — its own annual cycle, its own renewal, its own cancellation. This is simpler for a model where each club has different pricing and different operators.
- **USD only.** All prices in US dollars. Avoids multi-currency subscription complexity.
- **Annual only.** Eliminates mixed-interval complications and simplifies payout calculations.
- **Connect for payouts only.** Stripe Connect is used exclusively for transferring money to operators after the 120-day hold. It is not used for destination charges or per-transaction splits. All billing goes through ClawClub's platform Stripe account. Connect provides: operator identity verification (KYC), payout infrastructure, operator dashboard, and 1099 tax reporting.
- **Platform is merchant of record.** ClawClub's name appears on the member's bank statement. ClawClub handles all billing support, disputes, and refunds.

### Operator onboarding to Connect

- Operators do not need a Connect account until they expect their first payout from paid members.
- Express accounts — Stripe hosts the KYC/identity onboarding flow and provides operators with a dashboard.
- One Connect account per operator regardless of how many clubs they run.
- Individuals and businesses are both supported by Express accounts.

## Member lifecycle

### Joining a paid club

1. Member requests to join a club.
2. Club operator approves the member (or assigns a comp seat).
3. If paid: member is directed to a Stripe Checkout session. They pay the full annual fee plus applicable tax.
4. On successful payment, membership is activated immediately.
5. A ledger entry is created: club, operator, amount, tax collected, ClawClub's cut, operator share, hold expiry date (transaction date + 120 days), status.

### Annual renewal

- Each membership renews on its own anniversary at the price the member originally joined at (grandfathering).
- Stripe handles automatic renewal via the stored payment method.
- If renewal fails (card expired, insufficient funds), the member has a **7-day grace period**.
- During the grace period, a warning is returned with every API interaction in that club.
- After 7 days, membership is revoked.

### Leaving a club

- Members can cancel at any time.
- **No refunds.** Cancellation means the subscription will not renew next year. The member retains access for the remainder of their paid year.

### Being removed from a club

- Operators can remove members at any time.
- **No refunds** unless the operator explicitly requests one (which would be deducted from their balance).

## Operator lifecycle

### Starting a club

1. Operator pays $299/year via Stripe Checkout.
2. Club is created with 10 comp seats.
3. If the operator wants paid memberships, they set a price ($29/year minimum) and are onboarded to Stripe Connect Express when their first payout approaches.

### Monthly payout cycle

1. At month end, ClawClub identifies all operator revenue where the 120-day hold has expired.
2. Statement is generated: members billed, revenue collected, ClawClub's cut, chargebacks, fees, refunds, hold status.
3. Net amount of eligible (post-hold) funds is transferred to the operator's Connect account (if balance is above reserve threshold).

### Annual renewal

1. $299 is deducted from the operator's balance (if sufficient) or charged to their card.
2. Comp seat allocation is maintained.
3. Additional comp seats renew at $29/seat.

### Club suspension

Triggered by:
- Operator fee not renewed (7-day grace, then freeze).
- Balance drops below $200 and is not topped up after outreach.
- Operator's member dispute rate exceeds 0.5%.

Frozen club: existing members retain access until their subscriptions expire, but no new members can join and no new charges are created.

### Club closure

An operator can voluntarily close their club. When this happens:
- All memberships are cancelled (no renewals). Existing members retain access until their paid period expires.
- No refunds are issued for remaining service — this is covered in the member ToS.
- Members with remaining service who are unhappy must take it up with ClawClub support. This is a known friction point that must be addressed in the ToS.
- Once all memberships have expired and any pending dispute windows have closed, the operator's **rolling reserve is returned**.
- The operator's Connect account remains active until the final reserve payout.

## Membership access state machine

The ClawClub database — not Stripe — is the **source of truth for access.** Stripe is for billing only.

Member states within a club:

```
pending_approval  →  active (paid or comped)
                  →  rejected

active            →  past_due (payment failed, 7-day grace)
                  →  cancelled (member left, access until period end)
                  →  removed (operator removed, immediate or period end)
                  →  banned (chargeback, immediate, platform-wide)

past_due          →  active (payment recovered)
                  →  expired (grace period elapsed, access revoked)

cancelled         →  expired (period ends, access revoked)

expired           →  (terminal state)
banned            →  (terminal state, platform-wide)
```

Comp members are `active` with a `comped` flag. They do not pass through payment states.

Webhooks from Stripe (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `charge.dispute.created`) sync billing events into the ledger, but the state machine drives all access decisions.

**Implementation note:** The current database uses `membership_has_live_subscription()` which only grants access for `trialing` or `active` subscription states. Implementing this billing design will require updating the access function to also grant access during `past_due` (grace period), `cancelled` (access until period end), and for `comped` members. This is a schema/function migration that must ship with the billing feature.

## Terms of Service requirements

The following must be explicit in operator and member ToS:

**Operator ToS:**
- Operators are financially responsible for members they admit.
- Chargeback fees ($25) and refunded amounts are deducted from operator balance.
- Cross-platform bans may result in prorated refunds deducted from their balance for members they admitted.
- Club is suspended if balance remains below threshold or dispute rate exceeds 0.5%.
- ClawClub is merchant of record; operators receive payouts after a 120-day hold period.
- Payouts are monthly, in arrears, after the hold period.

**Member ToS:**
- No refunds. Cancellation stops future renewal but does not refund the current year.
- A chargeback on any club results in permanent platform-wide ban and cancellation of all memberships.
- ClawClub may require identity verification at any time.
- Price is locked at join-time and does not change on renewal unless the member explicitly opts in.

## What the operator gets

For their $299/year and the platform's share of member revenue, operators get:

- Hosting and infrastructure (the ClawClub platform).
- LLM inference costs covered.
- 10 complimentary member seats.
- Full billing and payment processing handled.
- Chargeback administration handled (though the operator bears the financial cost).
- Analytics.
- Support.

Operators handle: curating and approving members, non-technical support queries about the club, setting pricing, and managing discount codes.

There is no custom branding. ClawClub is the product; clubs exist within it.

## Decisions and alternatives considered

### Why ClawClub is merchant of record (not the operator)

We explored a model where operators handle their own billing (ClawClub just facilitates via Connect, operators are the merchant). This would push chargeback liability to operators entirely. We rejected it because:
- Members joining multiple clubs would deal with multiple payment processors/merchants — terrible UX.
- Operators (typically individual hobbyists) don't want to manage billing.
- ClawClub loses control over the member billing experience.

The tradeoff is that ClawClub bears chargeback risk, which we mitigate through the 120-day hold, fraud prevention layers, and per-operator circuit breakers.

### Why 120-day payout hold plus rolling reserve (not shorter tiers)

We considered a tiered system where trusted operators get shorter hold periods (60 days, 30 days). We chose a flat 120 days for everyone because:
- It covers the standard credit card dispute window from the payment date.
- It's simple — one rule for all operators.
- It eliminates the need to build and manage a trust-scoring system.
- The App Store precedent makes it explainable.
- Operators start with 10 free members, so the hold period is less painful in practice — meaningful paid revenue arrives after the club is established.

The 10% rolling reserve exists because the 120-day hold alone is not sufficient. For annual subscriptions (future service), card networks may allow disputes up to 120 days from the service date, not the payment date. A member could dispute well after the 120-day payment hold expires. The rolling reserve covers this tail risk without requiring a longer hold that would be unacceptable to operators.

### Why not per-transaction splits via Connect

We initially designed a system where Stripe Connect would automatically split each payment between ClawClub and the operator (destination charges or application fees). We moved away from this because:
- Decoupling billing from payouts gives ClawClub full control over the balance, hold period, and chargeback absorption.
- Monthly lump-sum payouts from an internal ledger are simpler to reason about, audit, and explain to operators.
- It avoids the problem of Stripe transfers not being automatically reversed on refunds.

### Why not a single multi-item subscription per member

We considered one subscription per member with one item per paid club (consolidated billing). Rejected because:
- Stripe caps subscriptions at 20 items.
- Stripe's customer portal cannot update (add/remove items on) multi-item subscriptions — only cancel them.
- Each club has a different operator and different pricing. Independent subscriptions per club are cleaner for the ledger and payout calculations.
- With annual-only billing and independent join dates, there is no consolidation benefit.

### Why annual-only billing

Simplifies everything: no mixed-interval invoice splitting, predictable revenue per member, one charge per club per year, simpler payout calculations. Monthly billing can be revisited later.

### Why the $299 operator fee exists

It serves three purposes simultaneously:
1. **Revenue**: covers the cost of running the club (hosting, LLM inference, embeddings) for the included comp seats.
2. **Chargeback buffer**: acts as a deposit that absorbs any residual chargeback losses that slip through.
3. **Quality filter**: ensures only serious operators launch clubs. This is intentional — ClawClub is a premium product.

### Why the $29 per-member floor

LLM inference, embeddings, and hosting have a real per-member cost. $29/year is the estimated minimum to sustain the platform and make a profit per member. The 30% rate on higher-priced clubs provides margin that subsidizes the platform. Even at $29, profitability depends on actual usage patterns.

### Why cross-platform refunds on chargeback

A chargeback from a member in one club triggers prorated refunds across all their clubs. Every operator who admitted that member shares accountability. Proactive refunds prevent additional chargebacks which would count against ClawClub's dispute rate with Stripe. We bound the loss by prorating refunds to the remaining service period rather than refunding the full annual amount.

### Why not crypto payouts

Considered as an operator payout mechanism. Rejected: wallet management complexity, volatility risk, tax reporting ambiguity, and operator onboarding friction. Stripe Connect provides clean payout rails with built-in tax reporting.

### Why the 10% chargeback assumption was revised

We initially designed the financial model to survive a 10% chargeback rate. Review revealed that Stripe flags accounts at **0.75%** dispute activity (including won disputes) and may terminate accounts above that. The 10% model was solving the wrong threshold. We redesigned around keeping the platform-wide rate well below 0.75% through the 120-day hold (eliminating post-payout exposure), per-operator circuit breakers (0.5% cap), and layered fraud prevention.
