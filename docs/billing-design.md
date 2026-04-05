# ClawClub Billing Design

Date: 2026-04-05 (v3 — full rewrite)

## Overview

ClawClub is the merchant of record for all member payments. ClawClub is a UK limited company. All prices are in USD.

Members fund a **ClawClub wallet** via Stripe Checkout (with 3DS on every top-up). Club memberships are paid from the wallet — no per-club card charges ever hit the member's card. This design virtually eliminates the chargeback surface: the only disputable transaction is a wallet top-up, not a club membership.

Operators pay an annual platform fee, set their own membership prices, and receive monthly payouts via Stripe Connect after a hold period. Operators are accountable for who they admit to their clubs.

## Pricing model

### Operator fee

- **$299/year** to run a club on ClawClub.
- Includes **10 complimentary member seats** (comps). These are lifetime seats — the allocation persists as long as the club exists and the operator fee is current.
- Additional comp seats: **$29/seat/year**.
- Renews annually. Can be auto-deducted from the operator's balance if sufficient funds are available; otherwise charged to their card on file.
- If the operator does not renew, the club is **frozen after a 7-day grace period**. No new members can join; existing members retain access until their own memberships expire.

### Member pricing

- All prices are in **USD** and are **tax-exclusive**. VAT (or applicable local sales tax) is charged on top at the rate required by the member's jurisdiction.
- **Minimum membership price: $29/year.**
- Club operators set the price. They can set it at $29 or any amount above.
- **Annual memberships only.** Each member has their own annual cycle starting from their join date.
- **No free trials.**
- **Price grandfathering:** Whatever price a member joins at, they keep for as long as they remain subscribed. If an operator raises the price, existing members renew at their original price. New members pay the new price.

### Platform revenue split

ClawClub takes **30% of the membership price or $29, whichever is greater.** This is calculated on the **pre-tax** amount. Tax is purely pass-through — ClawClub collects it and remits it to the relevant authority. Neither ClawClub nor the operator "earns" the tax portion.

Examples:
- $29/year club: ClawClub takes $29 (floor), operator gets $0.
- $50/year club: ClawClub takes $29 (floor; 30% = $15, below floor), operator gets $21.
- $100/year club: ClawClub takes $30 (30% > $29), operator gets $70.
- $200/year club: ClawClub takes $60 (30%), operator gets $140.

The $29 floor kicks in for any club priced below ~$97/year. Above that, the 30% rate applies.

These rates are configurable per club. ClawClub may negotiate different terms with specific operators on a case-by-case basis, including offering reduced per-member costs for clubs with lower usage patterns.

### Free clubs

Free clubs exist entirely outside of Stripe. No billing involvement. Membership is tracked in the ClawClub database only. An operator running a free-only club still pays the $299/year platform fee. If their entire membership fits within the 10 included comp seats (or additional purchased comp seats), there are no member-side payments at all.

### Discount codes

- Created by the **operator**, for their own club.
- **First year only.** On renewal, the member pays the full undiscounted price. This prevents permanently negative-margin members.
- Discounts reduce the price the member pays in the first year.
- **The discount comes out of the operator's share, not ClawClub's.** ClawClub still takes its full cut (30% or $29 floor, calculated on the **original undiscounted price**).
- Example: $100/year club, 50% discount code. Member pays $50 in year one. ClawClub takes $30 (30% of $100). Operator gets $20 instead of $70. On renewal, member pays $100 and the normal split resumes.
- A deep enough discount can make the operator's share negative for the first year (offset against their balance). Operators should be aware of this when setting discounts.
- **No free trials.** Discount codes are the only promotional mechanism.

## Comp seats

- The $299 operator fee includes **10 lifetime comp seats**.
- The operator chooses which members receive comps.
- Additional comp seats: **$29/seat/year**.
- Comped members have identical access to paid members inside the club.
- Comped members have no wallet deductions or Stripe involvement. Access is managed entirely in the ClawClub database.

## The wallet model

### How it works

Members do not pay per-club with a card. Instead:

1. Member tops up their **ClawClub wallet** via Stripe Checkout. Every top-up goes through **3DS authentication**.
2. The wallet balance is denominated in USD.
3. When a member joins a paid club, the annual fee (plus applicable tax) is **deducted from their wallet balance**.
4. If the wallet balance is insufficient to join a club, the member is prompted to top up.
5. On annual renewal, the fee is auto-deducted from the wallet. If the balance is insufficient, the member's card is auto-charged for exactly the renewal amount (labelled "ClawClub wallet top-up" — still not a per-club charge). This auto-charge goes through 3DS.
6. If the auto-charge fails, the member enters a 7-day grace period (see renewal below).

### Why the wallet model

The wallet collapses the entire chargeback surface to **wallet top-ups only**:

- **No per-club card charges exist.** There is nothing club-specific to dispute on a bank statement.
- **"Unauthorized" disputes** on top-ups are covered by the 3DS liability shift — the card issuer bears the loss, not ClawClub.
- **"Not as described" disputes** are extremely difficult to argue. The transaction is "I loaded credit into my account." The member received exactly what they paid for: account credit.
- **"Service not received" disputes** don't apply — the credit was received and spent. Club membership is an internal platform matter, not a card transaction.
- **Renewal disputes are also mitigated.** Unlike the previous design where renewals were merchant-initiated transactions without 3DS, wallet auto-top-ups on renewal go through Stripe Checkout with full 3DS authentication.

### Wallet balance is refundable

**Unused wallet balance is refundable on request.** Under the UK Consumer Rights Act 2015, this is likely required for prepaid service credit. Rather than fighting it, we make it a feature: "Request a refund of unused credit at any time."

This **strengthens** the chargeback position: the member has a legitimate refund path and no reason to dispute. Friendly fraud ("I forgot I subscribed") is addressed by offering a real refund instead of forcing the member to go through their bank.

Only unused balance is refundable — credit that has already been spent on an active membership cannot be refunded through this path (the no-refund policy on active memberships still applies).

### Legal considerations

The wallet model requires a legal opinion on:

- **Electronic Money Regulations 2011 (UK):** Is the wallet balance "e-money" (regulated) or "prepayment for services" (less regulated)? The balance is non-transferable, non-withdrawable (except via refund), and usable only for ClawClub memberships. This points toward prepayment for services, not e-money. But a solicitor must confirm.
- **Consumer Rights Act 2015 (UK):** The refundable-balance policy is designed to satisfy consumer protection requirements. Legal review should confirm this is sufficient.
- **Operator ToS enforceability:** The terms around admission accountability, chargeback fee pass-through, and payout holds must be enforceable under English law.

### Stripe implementation

Stripe has a built-in **Customer Balance** feature. Top-ups are regular Checkout charges. Invoices and deductions draw from the balance automatically. This is not a custom ledger bolted onto Stripe — it's a supported product.

## Operator balance and payouts

### Balance model

Each operator has a running **balance** in ClawClub's internal ledger, tracked **per club**. The balance is affected by:

- **Credits:** Member membership payments (operator's share after ClawClub's cut).
- **Debits:** Chargeback losses, chargeback fees ($25 per chargeback), and the annual operator fee (if deducted from balance).

The operator sees an aggregate balance across all their clubs, but the ledger tracks per-club positions for reserve calculations and club closure settlement.

### Payout schedule

- **120-day hold on all revenue.** Operator revenue from a member payment becomes eligible for payout 120 days after the transaction date.
- This covers the standard credit card dispute window from the payment date. If a chargeback comes in during the hold period, ClawClub deducts it from pending funds — no money has left the platform.
- After the 120-day hold, eligible funds are paid out **monthly, in arrears.**

**Important caveat: future-service disputes.** For annual memberships, card networks may allow disputes up to 120 days from the **service date**, not the payment date. This means a dispute could arrive after the 120-day hold expires. The rolling reserve (below) covers this tail risk. However, with the wallet model, this risk is substantially reduced because the disputable transaction is a wallet top-up (not a service), making future-service dispute grounds much weaker.

**Operator pitch:** "Your first payouts arrive roughly 4 months after your first paid members join, then monthly after that as the rolling window catches up. This is comparable to how the App Store pays developers."

### Rolling reserve

ClawClub retains a **rolling reserve of 10%** of each payout. Each reserved amount is held for **12 months from the original transaction date**, then released automatically to the operator. This means:

- The reserve is always sized proportionally to recent revenue.
- Older funds cycle out as their risk window closes.
- The reserve never accumulates indefinitely — it rolls.
- On **club closure**, once all memberships have expired and all 12-month reserve windows have elapsed, the remaining reserve is returned to the operator as a final settlement.

### Monthly payout formula

At the end of each month:

1. Identify all revenue where the 120-day hold has expired.
2. Subtract any pending dispute holds, chargeback debits, or fees.
3. Calculate 10% rolling reserve withholding on the eligible amount.
4. Check that the remaining balance (excluding rolling reserve) is above the **$200 reserve threshold**.
5. If above threshold: transfer the payout amount to the operator's Connect account.
6. If below threshold: freeze payouts and notify the operator.
7. Release any rolling reserve amounts that have passed their 12-month hold date (add back to available balance).

### Reserve threshold

- If the operator's available balance (after rolling reserve) drops below **$200**, payouts are **frozen** and the operator is notified.
- This ensures a minimum buffer exists on top of the rolling reserve.
- If the balance remains below $200 or goes negative, ClawClub reaches out. If unresolved, the club is suspended until the operator tops up.

### Operator visibility

- Operators see their balance in **real time**: pending (within 120-day hold), reserved (within 12-month rolling reserve), and available (eligible for payout).
- Full monthly statements showing: members joined, revenue collected, ClawClub's cut, chargebacks, chargeback fees, reserve held, reserve released, and net payout.
- No surprises.

## Chargeback handling

### The wallet advantage

With the wallet model, the chargeback problem is fundamentally different from a per-club billing model:

- The only disputable transaction is a **wallet top-up**, not a club membership.
- 3DS is enforced on **every** wallet charge (including renewal auto-top-ups), so "unauthorized" disputes trigger the liability shift on the issuer.
- The remaining dispute grounds ("not as described", "service not received") are very weak for a simple account credit transaction.
- Members can request refunds of unused wallet balance at any time, removing the primary motivation for friendly fraud.

### Stripe's 0.75% threshold

Stripe flags accounts with dispute activity above **0.75%** as excessive, including won disputes. The wallet model's reduced chargeback surface makes staying well below this threshold realistic. As additional protection, ClawClub integrates Stripe's dispute prevention tools (see below).

### Dispute prevention tools

ClawClub uses **every available Stripe dispute prevention tool** from day one:

- **Enhanced Issuer Network / Visa CE 3.0 (Compelling Evidence):** Shares transaction evidence with card issuers so they can auto-resolve disputes before they become formal. Automatically resolved disputes **do not count** toward the dispute rate and **do not incur** a dispute fee.
- **Stripe Radar:** Fraud detection on incoming payments. Flags high-risk top-ups before they complete.
- **3DS on all wallet charges:** Liability shift for unauthorized transactions.

These tools have a cost but are worth it — preventing a dispute from ever being filed is vastly more valuable than winning or absorbing one after the fact.

### Per-operator circuit breaker

Because Stripe measures disputes at the **platform level**, one bad operator can drag the entire account into monitoring.

- For operators with **fewer than 200 paid members billed**: any dispute triggers **manual review** by the ClawClub team. No automatic suspension.
- For operators with **200+ paid members billed**: a **0.5% dispute rate** (trailing 12-month window) triggers **payout pause**. The club continues operating — members keep access, operator keeps running — but money stops flowing until ClawClub reviews.
- This fires before the platform-wide 0.75% threshold is reached.
- After review, ClawClub either reinstates payouts or terminates the operator.

Payout pause (not club suspension) is the first intervention. This matches industry practice (Patreon, Stripe Managed Risk) and is less destructive than freezing club growth.

### Per-chargeback cost to operator

- Stripe dispute fee: $15
- ClawClub markup: $10
- **Total chargeback fee: $25**, deducted from operator balance.
- The disputed amount is also deducted from the operator's balance.
- Because of the 120-day hold, in most cases this money has not yet been paid out.

### Dispute ledger states

Disputes have a lifecycle. The operator ledger tracks each phase:

- **`dispute_opened`**: Stripe has debited the disputed amount. A provisional hold is placed on the operator's balance for the disputed amount + $25 chargeback fee. This amount is excluded from payout calculations.
- **`dispute_won`**: Stripe returns the disputed amount (but keeps their $15 fee). The provisional hold is released. The $25 chargeback fee is **still charged** to the operator — ClawClub absorbed admin cost and the $15 non-refundable Stripe fee.
- **`dispute_lost`**: The provisional hold becomes a permanent debit. The $25 fee is finalized. The member ban (below) is triggered.

### Member consequences on lost dispute

When a dispute is **lost** (resolved against ClawClub):

1. The member is **permanently banned** from the ClawClub platform.
2. The member is **blocked from joining any new clubs**.
3. Their **existing memberships continue until expiry** — they already paid (via wallet), and they are receiving the service. There is no grounds for "service not received" disputes on other clubs because nothing was cancelled.
4. **No cascade refunds.** The loss is contained to the one disputed transaction.
5. The member **cannot renew** any membership. When their current memberships lapse, they are permanently off the platform.

**Rationale:** The previous design proactively refunded all other clubs on a chargeback, creating loss amplification. The wallet model eliminates the need for this: since club memberships are internal wallet deductions (not card charges), there is nothing for the member to dispute on other clubs. Letting memberships run out naturally contains the loss to the single disputed wallet top-up.

## Fraud prevention

Layered approach, from lightest to heaviest touch:

1. **Club admission gate.** Every member must be approved by the club operator. This is the first line of defense.
2. **3DS on every wallet charge.** Liability shift for unauthorized transactions. Unlike the previous per-club subscription model, this applies to renewals too (renewal auto-top-ups go through Checkout).
3. **Spending ladder.** Rapid multi-club joins (e.g., 3+ paid clubs in a short window) or large wallet top-ups trigger a flag for review. Fraudsters tend to maximize access quickly.
4. **Retroactive identity verification.** If an account looks suspicious, ClawClub sends a **Stripe Identity** verification link. The member must complete selfie + government ID verification to continue spending. This can be triggered at any point — it is not required at signup. Anonymous accounts are welcome by default.
5. **Renewal reminders.** 14 days before annual renewal, members receive an email with a prominent one-click cancel button. This eliminates the most common source of friendly fraud: "I forgot I subscribed." Low effort, high ROI.
6. **Refundable wallet balance.** Members can request a refund of unused credit at any time. This removes the motivation for chargebacks as a refund mechanism.
7. **Dispute prevention tools.** Stripe's Enhanced Issuer Network / Visa CE 3.0 auto-resolves disputes before they become formal.
8. **Chargeback penalties.** $25 fee per chargeback discourages operators from being lax with admissions.
9. **Platform ban on lost dispute.** Permanent ban, no new joins, existing memberships lapse naturally.
10. **Per-operator payout pause.** 0.5% dispute rate (at 200+ members) triggers payout freeze and review.

### Identity verification details

Stripe Identity is used as a **risk-triggered tool**, not a universal gate:

- Triggered by the spending ladder, large wallet top-ups, or manual ClawClub review.
- Member uploads a government-issued ID and takes a live selfie. Stripe matches them and verifies document authenticity.
- Cost is per-verification (~$1.50). Only charged when triggered, not for every member.
- Most fraudsters abandon the flow when asked for real ID — the deterrence value exceeds the verification accuracy.
- **Future product opportunity:** "Verified clubs" where operators can require identity verification at admission. This is not v1, but the infrastructure will be in place.

## Stripe architecture

### Stripe objects

| ClawClub concept | Stripe object | Notes |
|---|---|---|
| Member | Customer (with Customer Balance) | One per ClawClub user. Balance holds wallet funds |
| Wallet top-up | Checkout Session → Payment Intent | 3DS on every top-up. Credited to Customer Balance |
| Paid club | Product | One per club, metadata includes club ID |
| Club price point | Price | One per price point per club. Immutable — see price versioning |
| Club membership | Subscription (billing from Customer Balance) | One per member per paid club, annual cycle |
| Club operator | Connected Account (Express) | One per operator, covers all their clubs |
| Operator payout | Transfer | Monthly lump sum after hold + reserve |
| Identity check | Identity Verification Session | Triggered by risk ladder |
| Tax | Stripe Tax | Automatic VAT/sales tax at checkout |
| Fraud screening | Radar | On all wallet top-ups |
| Dispute prevention | Enhanced Issuer Network / CE 3.0 | Auto-resolves disputes pre-filing |

### Price versioning

Stripe Prices are **immutable** — you cannot change the amount on an existing Price. When an operator changes their club's membership price:

1. A **new Price** is created on the same Product.
2. The old Price is **not archived** — existing members remain on it (price grandfathering).
3. New members joining after the price change get the new Price.
4. The ClawClub database tracks which Price each member is on, along with the platform split terms in effect when they joined.
5. Old Prices are only archived when no active memberships reference them.

### Tax handling

- ClawClub uses **Stripe Tax** to automatically calculate and collect VAT/sales tax.
- Prices are **tax-exclusive** — tax is added on top at the applicable rate.
- The platform revenue split (30% or $29 floor) is calculated on the **pre-tax** amount.
- Tax collected is pass-through: ClawClub collects and remits to the relevant authority. Tax does not appear in operator balances or payout calculations.
- As a UK limited company, ClawClub is VAT-registered and charges VAT. Stripe Tax handles jurisdiction-specific rates for international members.

### Key design choices

- **Wallet-funded memberships.** No per-club card charges. Dramatically reduces chargeback surface.
- **One subscription per member per club.** Each club membership is independent — its own annual cycle, renewal, and cancellation.
- **USD only.** Avoids multi-currency complexity.
- **Annual only.** Eliminates mixed-interval complications.
- **Connect for payouts only.** Not used for destination charges or per-transaction splits. Provides: operator KYC, payout infrastructure, operator dashboard, and tax reporting (1099s for US operators).
- **Platform is merchant of record.** "ClawClub" appears on bank statements.

### Operator onboarding to Connect

- Operators do not need a Connect account until they expect their first payout.
- Express accounts — Stripe hosts KYC/identity onboarding and provides operators with a dashboard.
- One Connect account per operator regardless of how many clubs they run.
- Individuals and businesses are both supported.

## Member lifecycle

### Joining a paid club

1. Member requests to join a club.
2. Club operator approves the member (or assigns a comp seat).
3. If paid: check wallet balance. If sufficient, deduct the annual fee (plus tax). If insufficient, direct member to a Stripe Checkout session to top up their wallet, then deduct.
4. Membership is activated immediately on successful payment.
5. A ledger entry is created: club, operator, amount, tax, ClawClub's cut, operator share, 120-day hold expiry, status.

### Annual renewal

- Each membership renews on its own anniversary at the **grandfathered price** (the price the member originally joined at, excluding any first-year discount).
- **14 days before renewal:** email reminder with balance status and a one-click cancel button.
- On renewal date: deduct from wallet balance. If insufficient, auto-charge the member's card for exactly the renewal amount via Stripe Checkout (3DS authenticated, labelled "ClawClub wallet top-up").
- If auto-charge fails: **7-day grace period**. Member retains access but a warning is returned with every API interaction in that club. Operator sees the member's status as "renewal pending — insufficient balance."
- After 7 days without payment: membership is revoked.

### Leaving a club

- Members can cancel at any time.
- **No refunds on active memberships.** Cancellation means the subscription will not renew next year. The member retains access for the remainder of their paid year.
- **Unused wallet balance is refundable on request** — this is separate from membership refunds.

### Being removed from a club

- Operators can remove members at any time.
- **No refunds** unless the operator explicitly requests one (deducted from their balance and credited back to the member's wallet).

## Operator lifecycle

### Starting a club

1. Operator pays $299/year via Stripe Checkout.
2. Club is created with 10 comp seats.
3. Operator sets a membership price ($29/year minimum) if they want paid members.
4. Operator is onboarded to Stripe Connect Express when their first payout approaches.

### Monthly payout cycle

1. At month end, identify all revenue where the 120-day hold has expired.
2. Subtract pending dispute holds, chargeback debits, and fees.
3. Withhold 10% rolling reserve (held for 12 months from transaction date).
4. Release any reserve amounts past their 12-month hold.
5. Check available balance is above $200 threshold.
6. If above: transfer net payout to operator's Connect account.
7. If below: freeze payouts and notify operator.
8. Generate monthly statement with full breakdown.

### Annual renewal

1. $299 is deducted from operator's balance (if sufficient) or charged to their card.
2. Comp seat allocation continues.
3. Additional comp seats renew at $29/seat/year.

### Club suspension

Triggered by:
- Operator fee not renewed (7-day grace, then freeze).
- Available balance drops below $200 and is not topped up after outreach.
- Per-operator circuit breaker triggers payout pause (at 200+ members, 0.5% dispute rate).

Frozen club: existing members retain access until memberships expire, but no new members can join.

### Club closure

An operator can voluntarily close their club:
- All memberships are cancelled (no future renewals). Existing members retain access until their paid period expires.
- No refunds for remaining service — this is covered in the member ToS. Members with remaining service who are unhappy must contact ClawClub support.
- Once all memberships have expired and all 12-month rolling reserve windows have elapsed, the **remaining reserve is returned** to the operator as a final settlement.
- The operator's Connect account remains active until the final payout.

## Membership access state machine

The ClawClub database — not Stripe — is the **source of truth for access.** Stripe is for billing only.

Member states within a club:

```
pending_approval  →  active (paid or comped)
                  →  rejected

active            →  renewal_pending (insufficient wallet balance, 7-day grace)
                  →  cancelled (member left; access until period end)
                  →  removed (operator removed)
                  →  banned (lost dispute; access continues until period end, no renewal)

renewal_pending   →  active (payment recovered)
                  →  expired (grace period elapsed, access revoked)

cancelled         →  expired (period ends, access revoked)

banned            →  expired (period ends, access revoked, platform-wide, permanent)

expired           →  (terminal state within this club)
```

Comp members are `active` with a `comped` flag. They do not pass through payment states.

Webhooks from Stripe (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `charge.dispute.created`) sync billing events into the ledger. The state machine drives all access decisions.

**Implementation note:** The current database grants access via `membership_has_live_subscription()` which only recognises `trialing` or `active` subscription states. Implementing this design requires updating the access function to also grant access during `renewal_pending` (grace period), `cancelled` (access until period end), and `banned` (access until period end, no renewal). The current `create_comped_subscription()` function already handles comp access by creating local subscription rows.

## Terms of Service requirements

**Operator ToS:**
- Operators are financially responsible for members they admit.
- Chargeback fees ($25) are deducted from operator balance regardless of dispute outcome.
- Disputed amounts are provisionally held from balance during resolution; permanently deducted on loss.
- Club payouts may be paused if dispute rate exceeds 0.5% (at 200+ members).
- Payouts are monthly, in arrears, after a 120-day hold, with a 10% rolling reserve held for 12 months.
- ClawClub is merchant of record; operators receive payouts, not direct payments.
- On club closure, rolling reserve is returned after all memberships and reserve windows expire.

**Member ToS:**
- No refunds on active memberships. Cancellation stops future renewal; access continues until period end.
- Unused wallet balance is refundable on request.
- A lost dispute on any transaction results in a permanent platform-wide ban. Existing memberships continue until expiry but cannot be renewed.
- ClawClub may require identity verification at any time.
- Price is locked at join-time (excluding first-year discounts, which revert to full price on renewal).

## What the operator gets

For $299/year and the platform's share of member revenue:

- Hosting and infrastructure (the ClawClub platform).
- LLM inference and embedding costs covered.
- 10 complimentary member seats.
- Full billing and payment processing handled.
- Chargeback administration handled (operator bears the financial cost).
- Analytics.
- Support.

Operators handle: curating and approving members, non-technical member support, setting pricing, and managing discount codes.

There is no custom branding. ClawClub is the product; clubs exist within it.

## Decisions and alternatives considered

### Why the wallet model (not per-club card charges)

The original design had one Stripe Subscription per member per club, each creating a direct card charge. This exposed ClawClub to chargebacks on every club membership transaction, with especially high risk on renewals (merchant-initiated, no 3DS liability shift).

The wallet model moves all card charges to a single, generic "ClawClub wallet top-up" with 3DS on every charge. Club memberships are internal balance deductions, not card transactions. This:
- Eliminates per-club dispute surface entirely.
- Ensures 3DS liability shift on every card charge, including renewals (which trigger a wallet auto-top-up through Checkout, not a merchant-initiated charge).
- Makes "not as described" and "service not received" disputes nearly impossible to argue — the member paid for account credit and received it.
- Gives members a legitimate refund path (wallet balance refund), reducing friendly fraud.

### Why members can request wallet balance refunds

UK Consumer Rights Act 2015 likely requires this for prepaid service credit. Rather than fight it, we make it a feature. This also strengthens the chargeback position: if a member has a sanctioned refund path, disputing through their bank is harder to justify to the issuer.

### Why no cascade refunds on chargeback

The original design proactively refunded all of a banned member's other club memberships, creating loss amplification across multiple operators. With the wallet model, this is unnecessary:
- Club memberships are wallet deductions, not card charges. There is nothing for the member to dispute on other clubs.
- Letting existing memberships run out naturally contains the loss to the single disputed wallet top-up.
- The member is banned and cannot renew, so access ends at period expiry.

This was the single biggest risk reduction in the design iteration.

### Why ClawClub is merchant of record (not the operator)

We explored operators handling their own billing, which would push chargeback liability entirely to them. Rejected because:
- Members joining multiple clubs would deal with multiple merchants — terrible UX.
- Operators (typically individual hobbyists) don't want to manage billing.
- ClawClub loses control over the member experience.

The wallet model makes the MoR position much safer than the original per-club-charge design.

### Why 120-day hold plus rolling reserve

The 120-day hold covers the standard dispute window from the payment date. The 10% rolling reserve (held for 12 months per transaction, then released) covers the residual tail risk from future-service disputes, which can be filed up to 120 days from the service date. Together they provide layered protection without requiring an unacceptably long hold.

We considered tiered hold periods based on operator trust. Rejected in favour of a flat 120 days for simplicity — no trust-scoring system to build.

### Why payout pause instead of club suspension as first intervention

Industry practice (Patreon, Stripe Managed Risk) uses payout pauses and reserves as risk interventions, not immediate club freezes. Suspending a club punishes members and damages the operator's community. Pausing payouts protects ClawClub financially while keeping the club functional. Suspension is a last resort.

### Why the circuit breaker has a volume floor

At 0.5%, a single dispute triggers suspension for any club with fewer than 200 members. Since most v1 clubs will be small, automatic suspension on the first dispute would be disproportionate. Below 200 members, disputes trigger manual review instead. Above 200, the 0.5% rate becomes statistically meaningful and automatic payout pause applies.

### Why first-year-only discounts

The original design allowed discount codes to apply in perpetuity (via price grandfathering). This could create permanently negative-margin members if the discount was deep enough to push the operator's share below zero while ClawClub still took its cut on the undiscounted price. First-year-only discounts (matching Patreon's model) prevent this — full price resumes on renewal.

### Why annual-only billing

Simplifies everything: no mixed-interval invoice splitting, predictable revenue per member, one wallet deduction per club per year, simpler payout calculations. Also encourages commitment and gives ClawClub capital upfront. Monthly billing can be revisited later.

### Why USD only

Avoids multi-currency wallet complexity. A multi-currency wallet would require separate balances per currency or conversion logic. USD-only is the simplest starting point.

### Why the $299 operator fee exists

Three purposes simultaneously:
1. **Revenue**: covers hosting, LLM inference, and embeddings for included comp seats.
2. **Chargeback buffer**: acts as a deposit absorbing residual losses.
3. **Quality filter**: ensures only serious operators launch clubs. ClawClub is a premium product.

### Why the $29 per-member floor

LLM inference, embeddings, and hosting have a real per-member cost. $29/year is the estimated minimum to sustain the platform. The 30% rate on higher-priced clubs provides additional margin. Profitability at $29 depends on actual usage patterns.

### Why not per-transaction splits via Stripe Connect

Decoupling billing from payouts gives ClawClub full control over the wallet balance, hold period, reserve, and chargeback absorption. Monthly lump-sum payouts from an internal ledger are simpler to audit and explain. It avoids the problem of Stripe transfers not auto-reversing on refunds.

### Why not a single multi-item subscription per member

Stripe caps subscriptions at 20 items. Stripe's customer portal cannot add/remove items on multi-item subscriptions. Each club has different pricing and different operators. Independent memberships are cleaner for the ledger.

### Why not crypto payouts to operators

Wallet management complexity, volatility risk, tax reporting ambiguity, and operator onboarding friction. Stripe Connect provides clean payout rails with built-in tax reporting.

### Why anonymous accounts are allowed

Club operators serve diverse communities. Some members want anonymity. Requiring identity verification at signup would be a significant barrier. Instead, verification is triggered only when the risk ladder detects suspicious behaviour. This keeps onboarding frictionless for legitimate users while still catching bad actors.

### Why the 10% chargeback assumption was dropped

We initially designed the financial model to survive a 10% chargeback rate. Review revealed Stripe flags accounts at 0.75% dispute activity (including won disputes). The 10% model was solving the wrong threshold. The wallet model, dispute prevention tools, and layered fraud approach are designed to keep the platform-wide rate well below 0.75%.
