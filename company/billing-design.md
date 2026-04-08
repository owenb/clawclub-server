# ClawClub Billing Design

Date: 2026-04-07 (v5)

## Overview

ClawClub is the merchant of record for all member payments. ClawClub is a UK limited company. All prices are in USD.

Members pay for club memberships via **Stripe Checkout** (one subscription per club). Operators pay an annual platform fee, set their own membership prices, and receive monthly payouts via Stripe Connect destination charges.

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

ClawClub takes **30% of the membership price or $29, whichever is greater.** This is calculated on the **pre-tax** amount. Tax is purely pass-through — it is collected and remitted via Stripe Tax. Neither ClawClub nor the operator "earns" the tax portion.

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
- **Maximum discount: the operator's share cannot go below $0.** The discount is capped at the operator's share of the membership price. On a $100/year club where ClawClub takes $30, the maximum discount is 70% ($70 off — the operator's entire share). On a $29/year club where ClawClub takes $29, no discounts are possible (operator share is already $0).
- Example: $100/year club, 50% discount code. Member pays $50 in year one. ClawClub takes $30 (30% of $100). Operator gets $20 instead of $70. On renewal, member pays $100 and the normal split resumes.
- ClawClub enforces this cap when the operator creates a discount code. Discounts that would push the operator share below $0 are rejected.
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

The operator sees an aggregate balance across all their clubs, but the ledger tracks per-club positions for payout calculations and club closure settlement.

### Append-only event ledger

The operator balance is **never stored or mutated directly**. It is always derived from an append-only sequence of immutable ledger events. Every financial action creates a new event; nothing is updated or deleted.

Ledger event types:

| Event type | Description | Effect |
|---|---|---|
| `member_payment` | Member paid for a club membership | +operator share |
| `platform_fee` | ClawClub's cut of a membership payment | Informational (already deducted from operator share) |
| `chargeback_hold` | Dispute opened, provisional hold | -(disputed amount + $25 fee), provisional |
| `chargeback_hold_released` | Dispute won, hold released | +(disputed amount), $25 fee remains debited |
| `chargeback_confirmed` | Dispute lost, hold becomes permanent | No additional debit (already held) |
| `refund_cascade` | Prorated refund from cross-platform ban | -prorated refund amount (capped at operator earnings from that member) |
| `payout` | Transfer to operator's Connect account | -payout amount |
| `operator_fee` | Annual $299 fee deducted from balance | -$299 |
| `comp_seat_fee` | Additional comp seat purchase | -$29 per seat |
| `operator_requested_refund` | Operator requested a refund for a removed member | -operator share only (see refund formula below) |
| `discount_shortfall` | Operator share went to $0 due to discount | Informational (no negative entries — see discount cap) |

The operator's **gross position** is the sum of all events, but the **payout-eligible balance** requires checking for provisional dispute holds — see derived balances below. Monthly statements are generated by filtering events for the statement period. Audits trace any balance to its constituent events.

**Reversal rule:** Events are never modified. Corrections are recorded as new events that offset the original (e.g., `chargeback_hold_released` offsets `chargeback_hold`).

**Operator-requested refund formula:** When an operator requests a refund for a removed member, ClawClub refunds the member the full Membership Fee (plus tax). The refund is settled as follows:
- ClawClub reverses its Platform Share (ClawClub absorbs this).
- ClawClub reverses the tax portion (pass-through, returned to the member).
- The Operator Share is deducted from the operator's balance via an `operator_requested_refund` event.
- The operator only loses their share — never more.

### Derived balances

Two derived balances are computed from the ledger:

- **Available:** Sum of all `member_payment` events minus `chargeback_confirmed`, `refund_cascade`, `operator_requested_refund`, `payout`, `operator_fee`, `comp_seat_fee` events, minus provisional holds. This is the amount eligible for payout (subject to the $50 threshold).
- **Provisional holds:** Sum of `chargeback_hold` events not yet resolved by a `chargeback_hold_released` or `chargeback_confirmed`. Excluded from all payout calculations.

The monthly statement shows both pools. The operator dashboard shows them in real time.

### Payout schedule

- **Monthly, in arrears, from day one.** Operator revenue from a member payment is eligible for payout in the next monthly cycle. No hold period.
- Eligible funds are paid out **monthly, in arrears.**

**Operator pitch:** "You get paid monthly. That's it."

### Monthly payout formula

At the end of each month:

1. Sum all operator revenue (member payments minus ClawClub's cut).
2. Subtract any pending dispute holds, chargeback debits, or fees.
3. Check that the available balance is above the **$50 payout threshold**.
4. If above threshold: transfer the **amount above $50** to the operator's Connect account, retaining $50 as a floor.
5. If at or below threshold: no payout issued, funds accumulate.
6. Generate monthly statement with full breakdown.

### Chargeback recovery via connected account

When a chargeback occurs, the $25 fee and disputed amount are debited from the operator's balance. Because destination charges route the operator's share directly to their Connect account, Stripe's negative-balance mechanism handles recovery: the debit is applied to the connected account and recovered from future incoming transfers. If the operator has no future revenue to cover the debit, Stripe debits the connected account's bank account (if configured) or ClawClub absorbs the loss.

### ClawClub absorbs unrecoverable tail losses

If a dispute arrives and the operator has no current or future balance to cover it (e.g., club has closed, operator has been paid out, no new revenue), **ClawClub absorbs the loss**. The platform fee and revenue share are priced to include this insurance. The operator's liability is limited to their current and future balance — ClawClub does not pursue operators for unrecoverable tail losses except in cases of fraud or wilful misconduct.

### Payout threshold

- Payouts are only issued when the operator's available balance exceeds **$50**. Below that, funds accumulate until the threshold is met.
- If the balance goes **negative** due to exceptional circumstances (multiple simultaneous disputes), ClawClub reaches out. If unresolved, the club is suspended until the balance is restored.

### Operator visibility

- Operators see their balance in **real time**: available (eligible for payout) and provisional holds (disputed amounts under review, shown separately with an explanation).
- Full monthly statements showing: members joined, revenue collected, ClawClub's cut, chargebacks, chargeback fees, and net payout.
- No surprises.

## Chargeback handling

### Design philosophy

Chargebacks are an unavoidable cost of being merchant of record. Rather than trying to eliminate them (impossible), ClawClub uses a layered approach:

1. **Prevent** most disputes from being filed (dispute prevention tools, renewal reminders, easy cancellation).
2. **Shift liability** where possible (3DS on initial payment).
3. **Pass the cost** to the operator who approved the member.
4. **Absorb** unrecoverable losses as a platform cost of doing business.

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
- The $25 fee and disputed amount are recovered via Stripe's negative-balance mechanism on the operator's connected account — debited from future incoming transfers.

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
4. Each refunded club's operator has the prorated refund amount deducted from their balance, **capped at the total revenue the operator earned from that member**. An operator can never go negative or owe ClawClub money because of a member they admitted. If the prorated refund exceeds what the operator earned from that member, ClawClub absorbs the difference.
5. The member cannot rejoin any club.

**Why proactive refunds:** If we cancel memberships without refunding, the member will dispute those charges too — creating additional chargebacks that count toward Stripe's 0.75% threshold. Proactive refunds are cheaper than additional disputes.

**Why operators bear the refund cost:** Every operator in the chain approved that member. This is not punishing innocent bystanders — it holds every operator accountable for their own admission decisions. If they had vetted more carefully, the scammer would not have been in their club. This incentivises all operators to take admissions seriously, not just the one who got chargebacked. Operators agree to these terms when they join the platform.

**Why the cap:** An operator should never end up owing ClawClub money. If a member joined a $29 club (operator earned $0), the operator owes nothing in the cascade. ClawClub absorbs the refund cost in that case. The cap ensures the cascade is punitive but fair — operators lose what they gained, never more.

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

### Destination charges

ClawClub uses **Stripe Connect destination charges** with `application_fee_amount`. When a member pays for a club membership:

1. The charge is created on the **platform account** (ClawClub).
2. `application_fee_amount` is set to ClawClub's platform share (30% or $29 floor).
3. The remainder (operator's share) is automatically routed to the operator's **connected account** at charge time.
4. Stripe handles the split atomically — no manual transfers, no scheduling, no balance tracking on ClawClub's side.

This is Stripe's recommended model for marketplaces. ClawClub appears on the bank statement. The operator receives their share in their connected account, subject to their payout schedule.

**Why destination charges over separate charges and transfers:** Destination charges split revenue at charge time with a single API call. Separate charges and transfers require ClawClub to collect all money, track balances, schedule transfers, handle transfer failures, and reconcile — significantly more engineering for the same outcome. Destination charges also handle refund reversals automatically: when ClawClub refunds a charge, Stripe reverses the corresponding transfer from the connected account.

### Stripe objects

| ClawClub concept | Stripe object | Notes |
|---|---|---|
| Member | Customer | One per ClawClub user |
| Paid club | Product | One per club, metadata includes club ID |
| Club price point | Price | One per price point per club. Immutable — see price versioning |
| Club membership | Subscription | One per member per paid club, with `application_fee_amount` and `transfer_data[destination]` |
| Club operator | Connected Account (Express) | One per operator, covers all their clubs |
| Operator payout | Automatic via Connect payout schedule | Monthly, managed by Stripe on the connected account |
| Member checkout | Checkout Session | 3DS on initial payment, destination charge parameters included |
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
- Tax collected is pass-through. Tax is calculated and collected via Stripe Tax. Tax does not appear in operator balances or payout calculations.
- As a UK limited company, ClawClub is VAT-registered and charges VAT. Stripe Tax handles jurisdiction-specific rates for international members.

### Key design choices

- **One subscription per member per club.** Each club membership is independent — its own annual cycle, renewal, and cancellation.
- **USD only.** Avoids multi-currency complexity.
- **Annual only.** Eliminates mixed-interval complications. Gives ClawClub capital upfront.
- **Destination charges for revenue split.** Stripe splits the payment at charge time. ClawClub's platform share stays on the platform. The operator's share goes to their connected account. Simple, standard, Stripe-recommended for marketplaces.
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
3. If paid: member is directed to a Stripe Checkout session. They pay the full annual fee plus applicable tax. 3DS is enforced. The charge is a destination charge — ClawClub's platform share is collected as `application_fee_amount`, and the operator's share is routed to their connected account.
4. On successful payment, membership is activated immediately.
5. A ledger entry is created: club, operator, amount, tax, ClawClub's cut, operator share, status.

### Annual renewal

- Each membership renews on its own anniversary at the **grandfathered price** (the price the member originally joined at, excluding any first-year discount which reverts to full price).
- **14 days before renewal:** email reminder with a prominent one-click cancel button.
- Stripe handles automatic renewal via the stored payment method (merchant-initiated, no 3DS — see accepted risks above). The same destination charge parameters apply to renewal invoices.
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

1. Sum all operator revenue for the period (member payments minus ClawClub's cut, as routed to their connected account).
2. Subtract any pending dispute holds, chargeback debits, and fees.
3. Check available balance is above $50 payout threshold.
4. If above: payout the amount above $50 from the connected account, retain $50 as floor.
5. If at or below: no payout issued, funds accumulate.
6. Generate monthly statement with full breakdown.

### Annual renewal

1. $299 is deducted from operator's balance (if sufficient) or charged to their card.
2. Comp seat allocation continues.
3. Additional comp seats renew at $29/seat/year.

### Club suspension

Triggered by:
- Operator fee not renewed (7-day grace, then freeze).
- Balance goes negative and is not restored after outreach.
- Per-operator circuit breaker escalation (payout pause first, suspension only if unresolved).

Frozen club: existing members retain access until memberships expire, but no new members can join.

### Club closure

An operator can voluntarily close their club:
- All memberships are cancelled (no future renewals). Existing members retain access until their paid period expires.
- No refunds for remaining service — this is covered in the member ToS. Members with remaining service who are unhappy must contact ClawClub support.
- Once all memberships have expired and the final monthly payout cycle has completed, the **remaining balance is paid out** to the operator as a final settlement.
- The operator's Connect account remains active until the final payout.

## Membership access state machine

The ClawClub database — not Stripe — is the **source of truth for access.** Stripe is for billing only.

Member states within a club:

```
pending_approval  ->  active (paid or comped)
                  ->  rejected

active            ->  renewal_pending (renewal payment failed, 7-day grace)
                  ->  cancelled (member left; access until period end)
                  ->  removed (operator removed)
                  ->  banned (lost dispute; all clubs cancelled, prorated refunds issued)

renewal_pending   ->  active (payment recovered)
                  ->  expired (grace period elapsed, access revoked)

cancelled         ->  expired (period ends, access revoked)

expired           ->  (terminal state within this club)
banned            ->  (terminal state, platform-wide, permanent)
```

Comp members are `active` with a `comped` flag. They do not pass through payment states.

Webhooks from Stripe (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `charge.dispute.created`) sync billing events into the ledger. The state machine drives all access decisions.

**Implementation note:** The current database grants access via `membership_has_live_subscription()` which reads `app.subscriptions.status` and only recognises `trialing` or `active`. The membership states above (`renewal_pending`, `cancelled`, `banned`) are **not** the same as Stripe subscription statuses — they are ClawClub-specific states. Implementing this design requires:
- A new **membership state** field separate from the Stripe subscription status. The membership state machine (above) drives access decisions. Stripe subscription status is synced via webhooks but is not the access-control field.
- Access-granting states: `active`, `renewal_pending` (grace period), `cancelled` (until period end).
- Access-revoking states: `expired`, `banned`, `removed`.
- The existing `create_comped_subscription()` function already handles comp access.
- This is a schema migration that decouples access control from Stripe subscription state.

## Terms of Service requirements

**Operator ToS:**
- Operators are financially responsible for members they admit. If a member disputes, the operator bears the cost.
- Chargeback fees ($25) are deducted from operator balance regardless of dispute outcome (won or lost).
- On a lost dispute, the disputed amount is permanently deducted. On a won dispute, the provisional hold is released but the $25 fee stands.
- Cross-platform bans may result in prorated refunds deducted from their balance for members they admitted, capped at the revenue earned from that member.
- Club payouts may be paused if dispute rate exceeds 0.5% (at 200+ members).
- Payouts are monthly, in arrears. No hold period. Full operator share paid out (no rolling reserve during normal operations).
- ClawClub is merchant of record; operators receive payouts via Stripe Connect, not direct payments.
- On club closure, remaining balance paid out after final payout cycle completes.

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

### Why not a 120-day hold on operator revenue

**Explored in depth across four design iterations (v1-v4) and rejected.** The original billing design used "separate charges and transfers" — ClawClub collects all money, holds it for 120 days, then manually transfers the operator's share. This was designed to protect against chargebacks by ensuring funds had not left the platform before the dispute window closed.

Rejected because:
- **Stripe's actual limit is 90 days.** Stripe Connect limits payout schedule holds to 90 days, not 120. The 120-day hold was never achievable via Stripe's built-in payout scheduling — it would have required ClawClub to build its own transfer scheduling system.
- **The hold never covered the actual risk window.** For annual subscriptions (ongoing service), card networks allow disputes up to 120 days from the **service date**, not the payment date. A member who pays on January 1 for a year of service could dispute in November (120 days before the December 31 service end). No payment-date-anchored hold covers this. The hold created a false sense of security.
- **Separate charges and transfers require significantly more engineering.** Webhook listeners for transfer scheduling, balance tracking across hold states, four-pool balance partitioning (pending, provisional, held, available), `hold_expires_at` metadata on every ledger event, reconciliation of failed transfers, and a 16-month settlement window on club closure. Destination charges eliminate all of this with a single `application_fee_amount` parameter.
- **The actual dispute risk is very low.** Annual billing (one charge per year per club), interviewed/vetted members, 3DS on initial payment, curated communities with operator accountability, and Stripe's dispute prevention tools (Enhanced Issuer Network / CE 3.0) combine to make the realistic dispute rate very low. Pricing a 120-day hold into the operator experience (delayed payouts, complex balance states, "you get paid 4 months after each member joins") is not justified by the risk.
- **Operator experience cost.** A 4-month delay on first payout is a significant friction point for operator onboarding. "You get paid monthly" is a fundamentally better pitch than "you get paid 4 months after each member joins."

The current model uses destination charges with immediate revenue splitting. ClawClub absorbs unrecoverable tail losses — if a late dispute hits and the operator has no balance, ClawClub eats it. The platform fee and revenue share are priced to include this insurance.

### Why destination charges over separate charges and transfers

Destination charges split revenue at charge time with a single API call. Separate charges and transfers require ClawClub to collect all money, track balances, schedule transfers, handle transfer failures, and reconcile. Destination charges also handle refund reversals automatically: when ClawClub refunds a charge, Stripe reverses the corresponding transfer from the connected account. This is Stripe's recommended model for marketplaces.

### Why payout pause before club suspension

Industry practice (Patreon, Stripe Managed Risk) uses payout pauses and reserves as risk interventions, not immediate club freezes. Suspending a club punishes members and damages the operator's community. Pausing payouts protects ClawClub financially while keeping the club functional.

### Why the circuit breaker has a volume floor

At 0.5%, a single dispute triggers the breaker for any club with fewer than 200 members — which is most clubs in v1. Below 200 members, disputes trigger manual review instead. Above 200, the rate becomes statistically meaningful and automatic payout pause applies.

### Why cross-platform refund cascade on lost dispute

A lost dispute bans the member and cancels all their clubs. Proactive refunds prevent additional chargebacks on those clubs (which would count toward Stripe's 0.75% threshold). Without proactive refunds, the banned member could dispute each remaining club individually — multiplying the damage.

The refund cost is charged to each operator who admitted the member, **capped at what the operator earned from that member**. This ensures operators never owe ClawClub money from a cascade. An operator who earned $0 from a $29-club member owes nothing. ClawClub absorbs any remainder. We further bound the loss by prorating refunds to remaining service period.

### Why the $299 operator fee exists

Three purposes:
1. **Revenue**: covers hosting, LLM inference, and embeddings for included comp seats.
2. **Chargeback buffer**: acts as a deposit absorbing residual losses.
3. **Quality filter**: ensures only serious operators launch clubs. ClawClub is a premium product.

### Why the $29 per-member floor

LLM inference, embeddings, and hosting have a real per-member cost. $29/year is the estimated minimum to sustain the platform and make a profit per member. The 30% rate on higher-priced clubs provides additional margin.

### Why first-year-only discounts with a cap

Perpetual discounts via price grandfathering could create permanently negative-margin members. First-year-only discounts (matching Patreon's model) prevent this. Additionally, discounts are capped so the operator's share never goes below $0 — ClawClub will not finance operator promotions or carry unsecured operator debt.

### Why not a single multi-item subscription per member

Stripe caps subscriptions at 20 items. Stripe's customer portal cannot update (add/remove items on) multi-item subscriptions — only cancel them. Each club has different pricing and different operators. Independent subscriptions are cleaner.

### Why anonymous accounts are allowed

Club operators serve diverse communities. Some members want anonymity. Requiring identity verification at signup would be a significant barrier. Verification is triggered only when the risk ladder detects suspicious behaviour. This keeps onboarding frictionless for legitimate users while still catching bad actors.

### Why not crypto payouts to operators

Wallet management complexity, volatility risk, tax reporting ambiguity, and operator onboarding friction. Stripe Connect provides clean payout rails with built-in tax reporting (1099s).
