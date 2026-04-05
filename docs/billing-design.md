# ClawClub Billing Design

Date: 2026-04-05 (v4 — final)

## Overview

ClawClub is the merchant of record for all member payments. ClawClub is a UK limited company. All prices are in USD.

Members pay for club memberships via **Stripe Checkout** (one subscription per club). Operators pay an annual platform fee, set their own membership prices, and receive monthly payouts via Stripe Connect after a hold period.

**Core principle:** Operators are accountable for who they admit. If a member turns out to be a bad actor, the operator bears the financial consequences. This incentivises careful admissions — interviews, vetting, and curation — which is the platform's first and most important line of defense.

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
- **Annual billing only.** Each member has their own annual cycle starting from their join date.
- Members pay via **Stripe Checkout** (3DS on initial payment).
- Members see "ClawClub" as the merchant and the club name in the line item description.
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

These rates are configurable per club. ClawClub may negotiate different terms with specific operators, including reduced per-member costs for clubs with lower usage patterns.

### Free clubs

Free clubs exist entirely outside of Stripe. No billing involvement. Membership is tracked in the ClawClub database only. An operator running a free-only club still pays the $299/year platform fee. If their entire membership fits within the 10 included comp seats (or additional purchased comp seats), there are no member-side payments at all.

### Discount codes

- Created by the **operator**, for their own club.
- **First year only.** On renewal, the member pays the full undiscounted price. This prevents permanently negative-margin members.
- Discounts reduce the price the member pays in the first year.
- **The discount comes out of the operator's share, not ClawClub's.** ClawClub still takes its full cut (30% or $29 floor, calculated on the **original undiscounted price**).
- Example: $100/year club, 50% discount code. Member pays $50 in year one. ClawClub takes $30 (30% of $100). Operator gets $20 instead of $70. On renewal, member pays $100 and the normal split resumes.
- A deep enough discount can make the operator's share negative for the first year (offset against their balance).
- **No free trials.** Discount codes are the only promotional mechanism.

## Comp seats

- The $299 operator fee includes **10 lifetime comp seats**.
- The operator chooses which members receive comps.
- Additional comp seats: **$29/seat/year**.
- Comped members have identical access to paid members inside the club.
- Comped members have no Stripe subscription. Access is managed entirely in the ClawClub database via `create_comped_subscription()`.

## Operator balance and payouts

### Balance model

Each operator has a running **balance** in ClawClub's internal ledger, tracked **per club**. The balance is affected by:

- **Credits:** Member subscription payments (operator's share after ClawClub's cut).
- **Debits:** Chargeback losses, chargeback fees ($25 per chargeback), prorated cross-platform refunds, and the annual operator fee (if deducted from balance).

The operator sees an aggregate balance across all their clubs, but the ledger tracks per-club positions for reserve calculations and club closure settlement.

### Payout schedule

- **120-day hold on all revenue.** Operator revenue from a member payment becomes eligible for payout 120 days after the transaction date.
- This covers the standard credit card dispute window from the payment date. If a chargeback comes in during the hold period, ClawClub deducts it from pending funds — no money has left the platform.
- After the 120-day hold, eligible funds are paid out **monthly, in arrears.**

**Important caveat: future-service disputes.** For annual memberships, card networks may allow disputes up to 120 days from the **service date**, not the payment date. This means a dispute could arrive after the 120-day hold expires. The rolling reserve (below) covers this tail risk.

**Operator pitch:** "Your first payouts arrive roughly 4 months after your first paid members join, then monthly after that as the rolling window catches up. This is comparable to how the App Store pays developers."

### Rolling reserve

ClawClub retains a **rolling reserve of 10%** of each payout. Each reserved amount is held for **12 months from the original transaction date**, then released automatically to the operator. This means:

- The reserve is always sized proportionally to recent revenue.
- Older funds cycle out as their risk window closes.
- The reserve never accumulates indefinitely — it rolls.
- On **club closure**, once all memberships have expired and all 12-month reserve windows have elapsed, the remaining reserve is returned as a final settlement.

### Monthly payout formula

At the end of each month:

1. Identify all revenue where the 120-day hold has expired.
2. Subtract any pending dispute holds, chargeback debits, or fees.
3. Calculate 10% rolling reserve withholding on the eligible amount.
4. Release any rolling reserve amounts that have passed their 12-month hold date (add back to available balance).
5. Check that the remaining balance (excluding rolling reserve) is above the **$200 reserve threshold**.
6. If above threshold: transfer the payout amount to the operator's Connect account.
7. If below threshold: freeze payouts and notify the operator.
8. Generate monthly statement with full breakdown.

### Reserve threshold

- If the operator's available balance (after rolling reserve) drops below **$200**, payouts are **frozen** and the operator is notified.
- This ensures a minimum buffer exists on top of the rolling reserve.
- If the balance remains below $200 or goes negative, ClawClub reaches out. If unresolved, the club is suspended until the operator tops up.

### Operator visibility

- Operators see their balance in **real time**: pending (within 120-day hold), reserved (within 12-month rolling reserve), and available (eligible for payout).
- Full monthly statements showing: members joined, revenue collected, ClawClub's cut, chargebacks, chargeback fees, reserve held, reserve released, and net payout.
- No surprises.

## Chargeback handling

### Design philosophy

Chargebacks are an unavoidable cost of being merchant of record. Rather than trying to eliminate them (impossible), ClawClub uses a layered approach:

1. **Prevent** most disputes from being filed (dispute prevention tools, renewal reminders, easy cancellation).
2. **Shift liability** where possible (3DS on initial payment).
3. **Absorb** the financial impact through holds and reserves.
4. **Pass the cost** to the operator who approved the member.

### Stripe's 0.75% threshold

Stripe flags accounts with dispute activity above **0.75%** as excessive, and this includes won disputes. This is the hard constraint the entire chargeback design must respect. The dispute prevention tools, fraud ladder, and per-operator monitoring all exist to keep the **platform-wide** dispute rate well below 0.75%.

### Dispute prevention tools

ClawClub uses **every available Stripe dispute prevention tool** from day one, even if they cost more:

- **Enhanced Issuer Network / Visa CE 3.0 (Compelling Evidence):** Shares transaction evidence with card issuers so they can auto-resolve disputes before they become formal. Automatically resolved disputes **do not count** toward the dispute rate and **do not incur** a dispute fee. This is the single highest-value tool.
- **Stripe Radar:** Fraud detection on incoming payments. Flags high-risk charges before they complete.

### 3DS liability shift

Stripe Checkout enforces Strong Customer Authentication (3DS) on the **initial payment**. For "unauthorized transaction" chargebacks — the most common dispute type — 3DS shifts liability to the card issuer, not ClawClub.

**Renewal charges are less protected.** Annual renewals are merchant-initiated transactions (MIT). They run off-session with no customer challenge and **no 3DS liability shift**. This is an accepted risk because:
- A member active for a year is less likely to dispute.
- The 120-day hold and rolling reserve cover the financial exposure.
- Renewal reminders with easy cancellation reduce friendly fraud (the main renewal dispute driver).
- The chargeback cost is passed to the operator regardless.

### Per-operator circuit breaker

Because Stripe measures disputes at the **platform level**, one bad operator can drag the entire account into monitoring.

- For operators with **fewer than 200 paid members billed**: any dispute triggers **manual review** by the ClawClub team. No automatic action — the numbers are too small for rate-based rules to be meaningful.
- For operators with **200+ paid members billed**: a **0.5% dispute rate** (trailing 12-month window) triggers **payout pause**. The club continues operating — members keep access, operator keeps running — but money stops flowing until ClawClub reviews.
- After review, ClawClub either reinstates payouts or terminates the operator.

**Payout pause, not club suspension**, is the first intervention. This matches industry practice (Patreon, Stripe Managed Risk). Suspending a club punishes members and damages the operator's community. Pausing payouts protects ClawClub financially while keeping the club functional. Suspension is a last resort for unresolved cases.

### Per-chargeback cost to operator

- Stripe dispute fee: $15
- ClawClub markup: $10
- **Total chargeback fee: $25**, deducted from operator balance.
- The disputed amount is also deducted from the operator's balance.
- Because of the 120-day hold, in most cases this money has not yet been paid out.

**Rationale:** The operator approved this member. If they had conducted more careful interviews and vetting, the scammer would not have been admitted. The chargeback cost is the price of that admission decision. This is explicit in the operator ToS.

### Dispute ledger states

Disputes have a lifecycle. The operator ledger tracks each phase:

- **`dispute_opened`**: Stripe has debited the disputed amount. A provisional hold is placed on the operator's balance for the disputed amount + $25 chargeback fee. This amount is excluded from payout calculations.
- **`dispute_won`**: Stripe returns the disputed amount (but keeps their $15 fee). The provisional hold is released. The $25 chargeback fee is **still charged** to the operator — ClawClub absorbed admin cost and the $15 non-refundable Stripe fee.
- **`dispute_lost`**: The provisional hold becomes a permanent debit. The $25 fee is finalized. The member ban and cross-platform refund cascade is triggered.

### Cross-platform ban (on lost dispute)

When a dispute is **lost** (resolved against ClawClub):

1. The member is **permanently banned** from the entire ClawClub platform.
2. **All** other club memberships are **immediately cancelled**.
3. ClawClub **proactively refunds** the other clubs, **prorated to remaining service period**. A member banned 10 months into their year triggers only 2 months of prorated refunds on their other clubs.
4. Each refunded club's operator has the prorated refund amount deducted from their balance.
5. The member cannot rejoin any club.

**Why proactive refunds:** If we cancel memberships without refunding, the member will dispute those charges too — creating additional chargebacks that count toward Stripe's 0.75% threshold. Proactive refunds are cheaper than additional disputes.

**Why operators bear the refund cost:** Every operator in the chain approved that member. This is not punishing innocent bystanders — it holds every operator accountable for their own admission decisions. If they had vetted more carefully, the scammer would not have been in their club. This incentivises all operators to take admissions seriously, not just the one who got chargebacked. Operators agree to these terms when they join the platform.

## Fraud prevention

Layered approach, from lightest to heaviest touch:

1. **Club admission gate.** Every member must be approved by the club operator. This is the primary defense. We actively encourage operators to conduct interviews and vet applicants.
2. **3DS on initial payment.** Liability shift for "unauthorized" disputes on the first charge.
3. **Renewal reminders.** 14 days before annual renewal, members receive an email with a prominent one-click cancel button. This eliminates the most common source of friendly fraud: "I forgot I subscribed." Low effort, highest ROI.
4. **Spending ladder.** Rapid multi-club joins (e.g., 3+ paid clubs in a short window) trigger a flag for review. Fraudsters tend to maximise access quickly.
5. **Retroactive identity verification.** If an account looks suspicious, ClawClub sends a **Stripe Identity** verification link. The member must complete selfie + government ID verification to continue. This can be triggered at any point — it is not required at signup. Anonymous accounts are welcome by default.
6. **Dispute prevention tools.** Stripe's Enhanced Issuer Network / Visa CE 3.0 auto-resolves disputes before they become formal. Auto-resolved disputes don't count toward the rate.
7. **Chargeback penalties.** $25 fee per chargeback passed to operator. Incentivises careful admissions.
8. **Cross-platform ban and prorated refund cascade.** Permanent ban on lost dispute. All other memberships cancelled and prorated refunds issued, costs charged to each operator.
9. **Per-operator payout pause.** 0.5% dispute rate (at 200+ members) triggers payout freeze and review.

### Identity verification details

Stripe Identity is used as a **risk-triggered tool**, not a universal gate:

- Triggered by the spending ladder, or manual ClawClub review.
- Member uploads a government-issued ID and takes a live selfie. Stripe matches them and verifies document authenticity.
- Cost is per-verification (~$1.50). Only charged when triggered, not for every member.
- Most fraudsters abandon the flow when asked for real ID — the deterrence value exceeds the verification accuracy.
- **Future product opportunity:** "Verified clubs" where operators can require identity verification at admission. This is not v1, but the infrastructure will be in place.

## Stripe architecture

### Stripe objects

| ClawClub concept | Stripe object | Notes |
|---|---|---|
| Member | Customer | One per ClawClub user |
| Paid club | Product | One per club, metadata includes club ID |
| Club price point | Price | One per price point per club. Immutable — see price versioning |
| Club membership | Subscription | One per member per paid club, independent annual cycles |
| Club operator | Connected Account (Express) | One per operator, covers all their clubs |
| Operator payout | Transfer | Monthly lump sum after hold + reserve |
| Member checkout | Checkout Session | 3DS on initial payment |
| Identity check | Identity Verification Session | Triggered by risk ladder |
| Tax | Stripe Tax | Automatic VAT/sales tax at checkout |
| Fraud screening | Radar | On all payments |
| Dispute prevention | Enhanced Issuer Network / CE 3.0 | Auto-resolves disputes pre-filing |

### Price versioning

Stripe Prices are **immutable** — you cannot change the amount on an existing Price. When an operator changes their club's membership price:

1. A **new Price** is created on the same Product.
2. The old Price is **not archived** — existing members remain on it (price grandfathering).
3. New members joining after the price change get the new Price.
4. The ClawClub database tracks which Price each member is on, along with the platform split terms in effect when they joined.
5. Old Prices are only archived when no active memberships reference them.

### Tax handling

- ClawClub uses **Stripe Tax** to automatically calculate and collect VAT/sales tax at checkout.
- Prices are **tax-exclusive** — tax is added on top at the applicable rate.
- The platform revenue split (30% or $29 floor) is calculated on the **pre-tax** amount.
- Tax collected is pass-through: ClawClub collects and remits to the relevant authority. Tax does not appear in operator balances or payout calculations.
- As a UK limited company, ClawClub is VAT-registered and charges VAT. Stripe Tax handles jurisdiction-specific rates for international members.

### Key design choices

- **One subscription per member per club.** Each club membership is independent — its own annual cycle, renewal, and cancellation.
- **USD only.** Avoids multi-currency complexity.
- **Annual only.** Eliminates mixed-interval complications. Gives ClawClub capital upfront.
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
3. If paid: member is directed to a Stripe Checkout session. They pay the full annual fee plus applicable tax. 3DS is enforced.
4. On successful payment, membership is activated immediately.
5. A ledger entry is created: club, operator, amount, tax, ClawClub's cut, operator share, 120-day hold expiry, status.

### Annual renewal

- Each membership renews on its own anniversary at the **grandfathered price** (the price the member originally joined at, excluding any first-year discount which reverts to full price).
- **14 days before renewal:** email reminder with a prominent one-click cancel button.
- Stripe handles automatic renewal via the stored payment method (merchant-initiated, no 3DS — see accepted risks above).
- If renewal fails (card expired, insufficient funds): **7-day grace period**. Member retains access but a warning is returned with every API interaction in that club. Operator sees the member's status as "renewal pending."
- After 7 days without payment: membership is revoked.

### Leaving a club

- Members can cancel at any time.
- **No refunds.** Cancellation means the subscription will not renew next year. The member retains access for the remainder of their paid year.

### Being removed from a club

- Operators can remove members at any time.
- **No refunds** unless the operator explicitly requests one (deducted from their balance).

## Operator lifecycle

### Starting a club

1. Operator pays $299/year via Stripe Checkout.
2. Club is created with 10 comp seats.
3. Operator sets a membership price ($29/year minimum) if they want paid members.
4. Operator is onboarded to Stripe Connect Express when their first payout approaches.

### Monthly payout cycle

1. Identify all revenue where the 120-day hold has expired.
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
- Per-operator circuit breaker escalation (payout pause first, suspension only if unresolved).

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

active            →  renewal_pending (renewal payment failed, 7-day grace)
                  →  cancelled (member left; access until period end)
                  →  removed (operator removed)
                  →  banned (lost dispute; all clubs cancelled, prorated refunds issued)

renewal_pending   →  active (payment recovered)
                  →  expired (grace period elapsed, access revoked)

cancelled         →  expired (period ends, access revoked)

expired           →  (terminal state within this club)
banned            →  (terminal state, platform-wide, permanent)
```

Comp members are `active` with a `comped` flag. They do not pass through payment states.

Webhooks from Stripe (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `charge.dispute.created`) sync billing events into the ledger. The state machine drives all access decisions.

**Implementation note:** The current database grants access via `membership_has_live_subscription()` which only recognises `trialing` or `active` subscription states. Implementing this design requires:
- Adding `renewal_pending` and `cancelled` as access-granting states (with expiry logic).
- Adding a `banned` state that immediately revokes access.
- The existing `create_comped_subscription()` function already handles comp access.
- This is a schema and function migration that must ship with the billing feature.

## Terms of Service requirements

**Operator ToS:**
- Operators are financially responsible for members they admit. If a member disputes, the operator bears the cost.
- Chargeback fees ($25) are deducted from operator balance regardless of dispute outcome (won or lost).
- On a lost dispute, the disputed amount is permanently deducted. On a won dispute, the provisional hold is released but the $25 fee stands.
- Cross-platform bans may result in prorated refunds deducted from their balance for members they admitted.
- Club payouts may be paused if dispute rate exceeds 0.5% (at 200+ members).
- Payouts are monthly, in arrears, after a 120-day hold, with a 10% rolling reserve held for 12 months per transaction.
- ClawClub is merchant of record; operators receive payouts, not direct payments.
- On club closure, rolling reserve is returned after all memberships and reserve windows expire.

**Member ToS:**
- No refunds on active memberships. Cancellation stops future renewal; access continues until period end.
- A lost dispute on any transaction results in a permanent platform-wide ban, cancellation of all memberships, and prorated refunds.
- ClawClub may require identity verification at any time.
- Price is locked at join-time (excluding first-year discounts, which revert to full price on renewal).

## What the operator gets

For $299/year and the platform's share of member revenue:

- Hosting and infrastructure (the ClawClub platform).
- LLM inference and embedding costs covered.
- 10 complimentary member seats.
- Full billing and payment processing handled.
- Chargeback administration handled (operator bears the financial cost because they approved the member).
- Analytics.
- Support.

Operators handle: curating and approving members (their most important job), non-technical member support, setting pricing, and managing discount codes.

There is no custom branding. ClawClub is the product; clubs exist within it.

## Decisions and alternatives considered

### Why ClawClub is merchant of record (not the operator)

**Explored and rejected: operator handles own billing.** This would push chargeback liability entirely to operators and let ClawClub become a pure platform provider. Rejected because:
- Members joining multiple clubs would deal with multiple merchants — terrible UX.
- Operators (typically individual hobbyists) don't want to manage billing. The pitch is "go to the beach, we handle everything."
- ClawClub loses control over the member experience.
- Revenue is capped at platform fees — no percentage of membership revenue.

The MoR model is more complex but captures more value and delivers a better experience for both operators and members.

### Why not a wallet model

**Explored in depth and rejected.** We designed a wallet model where members top up a ClawClub balance and club memberships deduct from it. This would have reduced the chargeback surface to wallet top-ups only. Rejected because:
- Stripe's Customer Balance does not natively support card-funded wallet top-ups drawn down by subscriptions. We would have needed a fully custom reconciliation layer.
- Auto-renewal via wallet required either interactive Checkout (not automatic) or off-session charges (losing the 3DS guarantee that was the wallet's main benefit).
- A disputed wallet top-up doesn't map cleanly to a single operator for ledger purposes — one top-up can fund multiple clubs across multiple operators.
- UK Electronic Money Regulations 2011 create regulatory uncertainty for stored-value balances. Getting a legal opinion before launch would have been a gating dependency with no fallback.

The per-club subscription model with dispute prevention tools achieves acceptable chargeback risk without these complications.

### Why not operator-as-merchant with ClawClub billing tools

**Explored and rejected.** ClawClub would sell seats to operators and let them charge members however they want (Stripe, crypto, etc.). Simplest for ClawClub — no MoR, no chargebacks. Rejected because:
- Puts all billing burden on the operator. Most are hobbyists who don't want to manage Stripe.
- Multi-club members deal with multiple merchants.
- ClawClub can't take a percentage of membership revenue — only flat platform fees.
- Less compelling pitch: "pay us, then figure out billing yourself" vs "pay us, go to the beach."

### Why annual-only billing

Simplifies everything: no mixed-interval invoice splitting, predictable revenue per member, one charge per club per year, simpler payout calculations. Gives ClawClub capital upfront. Monthly billing can be revisited later.

### Why USD only

Avoids multi-currency subscription complexity. Multiple currencies would require one subscription per member per currency. USD-only is the simplest starting point.

### Why 120-day hold plus rolling reserve

The 120-day hold covers the standard dispute window from the payment date. The 10% rolling reserve (held for 12 months per transaction, then released) covers the residual tail risk from future-service disputes, which card networks may allow up to 120 days from the service date. Together they provide layered protection without requiring an unacceptably long hold.

We considered tiered hold periods based on operator trust. Rejected in favour of a flat 120 days for simplicity — no trust-scoring system to build. The App Store precedent makes it explainable.

### Why payout pause before club suspension

Industry practice (Patreon, Stripe Managed Risk) uses payout pauses and reserves as risk interventions, not immediate club freezes. Suspending a club punishes members and damages the operator's community. Pausing payouts protects ClawClub financially while keeping the club functional.

### Why the circuit breaker has a volume floor

At 0.5%, a single dispute triggers the breaker for any club with fewer than 200 members — which is most clubs in v1. Below 200 members, disputes trigger manual review instead. Above 200, the rate becomes statistically meaningful and automatic payout pause applies.

### Why cross-platform refund cascade on lost dispute

A lost dispute bans the member and cancels all their clubs. Proactive refunds prevent additional chargebacks on those clubs (which would count toward Stripe's 0.75% threshold). Without proactive refunds, the banned member could dispute each remaining club individually — multiplying the damage.

The refund cost is charged to each operator who admitted the member. This is fair because every operator in the chain approved that person. It incentivises all operators to take admissions seriously. We bound the loss by prorating refunds to remaining service period.

### Why the $299 operator fee exists

Three purposes:
1. **Revenue**: covers hosting, LLM inference, and embeddings for included comp seats.
2. **Chargeback buffer**: acts as a deposit absorbing residual losses.
3. **Quality filter**: ensures only serious operators launch clubs. ClawClub is a premium product.

### Why the $29 per-member floor

LLM inference, embeddings, and hosting have a real per-member cost. $29/year is the estimated minimum to sustain the platform and make a profit per member. The 30% rate on higher-priced clubs provides additional margin.

### Why first-year-only discounts

Perpetual discounts via price grandfathering could create permanently negative-margin members if the discount pushes the operator's share below zero. First-year-only discounts (matching Patreon's model) prevent this.

### Why not per-transaction splits via Stripe Connect

Decoupling billing from payouts gives ClawClub full control over the hold period, reserve, and chargeback absorption. Monthly lump-sum payouts from an internal ledger are simpler to audit and explain. Stripe transfers do not auto-reverse on refund, so manual reconciliation would be needed anyway.

### Why not a single multi-item subscription per member

Stripe caps subscriptions at 20 items. Stripe's customer portal cannot update (add/remove items on) multi-item subscriptions — only cancel them. Each club has different pricing and different operators. Independent subscriptions are cleaner.

### Why anonymous accounts are allowed

Club operators serve diverse communities. Some members want anonymity. Requiring identity verification at signup would be a significant barrier. Verification is triggered only when the risk ladder detects suspicious behaviour. This keeps onboarding frictionless for legitimate users while still catching bad actors.

### Why not crypto payouts to operators

Wallet management complexity, volatility risk, tax reporting ambiguity, and operator onboarding friction. Stripe Connect provides clean payout rails with built-in tax reporting (1099s).
