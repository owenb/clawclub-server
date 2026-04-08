# ClawClub Club Operator Agreement

**DRAFT -- Not yet reviewed by legal counsel**

**ClawClub Ltd** (company number [TBD]), a company incorporated in England and Wales ("**ClawClub**", "**we**", "**us**", "**our**")

This Club Operator Agreement ("**Agreement**") sets out the terms on which an individual or entity ("**Operator**", "**you**", "**your**") may create and operate a club on the ClawClub platform. By creating a club or accepting these terms, you agree to be bound by this Agreement in its entirety.

**Effective date:** [TBD]

---

## 1. Definitions

1.1 **"Available Balance"** means the aggregate balance in the Operator's Connected Account, as reported by Stripe, that is eligible for payout.

1.2 **"Chargeback Fee"** means the fee of twenty-five United States dollars (US $25) charged per dispute, as set out in Clause 11.

1.3 **"Club"** means an operator-managed community hosted on the Platform.

1.4 **"Comp Seat"** means a complimentary membership seat allocated by the Operator pursuant to Clause 8.

1.5 **"Connected Account"** means a Stripe Connect Express account held by the Operator for the purpose of receiving the Operator Share of membership revenue.

1.6 **"Discount Code"** means a promotional code created by the Operator pursuant to Clause 7.

1.7 **"Dispute"** means a chargeback, inquiry, or other payment dispute initiated by a Member's card issuer or payment provider in respect of a Membership Fee.

1.8 **"Destination Charge"** means a charge processed by ClawClub as merchant of record where the Operator Share is transferred to the Operator's Connected Account at the time of charge, using Stripe's destination charge mechanism.

1.9 **"Governing Law"** has the meaning given in Clause 28.

1.10 **"Legality Gate"** means the automated content moderation system described in Clause 14.

1.11 **"Ledger"** means the append-only event ledger maintained by ClawClub for recording all financial events associated with a Club.

1.12 **"Member"** means a natural person who holds an active membership in a Club.

1.13 **"Membership Fee"** means the annual fee payable by a Member for membership of a Club, as set by the Operator pursuant to Clause 6.

1.14 **"Operator Share"** means the portion of the Membership Fee payable to the Operator after deduction of the Platform Share, calculated in accordance with Clause 6.

1.15 **"Payout Threshold"** means the minimum balance of fifty United States dollars (US $50) required before a payout is issued to the Operator, as described in Clause 9.

1.16 **"Platform"** means the ClawClub software platform, including all APIs, websites, and related services.

1.17 **"Platform Fee"** means the annual fee of two hundred and ninety-nine United States dollars (US $299) payable by the Operator pursuant to Clause 4.

1.18 **"Platform Share"** means ClawClub's share of the Membership Fee, being the greater of thirty per cent (30%) of the Membership Fee or twenty-nine United States dollars (US $29), calculated on the pre-tax amount.

1.19 **"Schedule"** means a schedule appended to this Agreement, each of which forms part of this Agreement.

1.20 **"Stripe"** means Stripe, Inc. and its affiliates.

1.21 **"Stripe Tax"** means the tax calculation and collection service provided by Stripe.

---

## 2. Operator Eligibility

2.1 The Operator must be a natural person aged eighteen (18) years or older, or a duly incorporated legal entity with the capacity to enter into binding agreements.

2.2 The Operator must provide accurate and complete information during registration and must promptly update such information if it changes.

2.3 The Operator must be eligible to hold a Stripe Connect Express account in their jurisdiction. ClawClub is not responsible for any restrictions imposed by Stripe on the Operator's Connected Account.

2.4 ClawClub reserves the right to refuse or revoke Operator status at any time, at its sole discretion, where it reasonably believes the Operator does not meet the eligibility criteria or poses a risk to the Platform.

---

## 3. The Platform

3.1 ClawClub is the **merchant of record** for all Member payments. "ClawClub" appears on Members' bank and card statements. The Operator is not the seller, merchant, or billing entity for any Member payment.

3.2 ClawClub provides the Platform infrastructure, including hosting, API services, LLM inference, content moderation, billing and payment processing, dispute handling, and Member support for billing-related inquiries.

3.3 The Operator acknowledges that ClawClub uses Stripe destination charges to process Member payments. At the time of each charge, the Operator Share is transferred directly to the Operator's Connected Account, and the Platform Share is retained by ClawClub.

3.4 There is no custom branding. ClawClub is the product; Clubs exist within it. The Operator may not represent to Members or third parties that they are the merchant of record or that the Club operates independently of ClawClub.

3.5 ClawClub may modify, suspend, or discontinue any feature of the Platform at any time, provided that material changes affecting Operator revenue or obligations shall be communicated with reasonable notice pursuant to Clause 27.

---

## 4. Platform Fee

4.1 The Operator shall pay an annual Platform Fee of **two hundred and ninety-nine United States dollars (US $299)** to operate a Club on the Platform.

4.2 The Platform Fee includes **ten (10) Comp Seats** as described in Clause 8.

4.3 The Platform Fee is payable in advance on the anniversary of the Club's creation date. Payment shall be made via Stripe Checkout or, where the Operator's Connected Account holds sufficient funds, ClawClub may deduct the Platform Fee from the Operator's Connected Account balance with the Operator's prior consent.

4.4 If the Operator fails to pay the Platform Fee within seven (7) days of the due date (the "**Grace Period**"), the Club shall be frozen. During the freeze: no new Members may join, but existing Members retain access until their individual memberships expire. The freeze shall be lifted upon payment of the outstanding Platform Fee.

4.5 The Platform Fee is **non-refundable**, except where required by applicable law.

---

## 5. Operator's Duties and Responsibilities

5.1 The Operator's primary duty is the **curation of Club membership**. The Operator is responsible for vetting, interviewing, and approving all applicants. ClawClub strongly encourages Operators to conduct meaningful admission processes, including interviews where appropriate.

5.2 The Operator is **financially accountable** for the Members they admit. If a Member files a Dispute, the Operator bears the financial consequences as set out in Clause 11. This accountability is the cornerstone of the Platform's trust and safety model.

5.3 The Operator shall:

   (a) respond to admission requests in a timely manner;

   (b) maintain an active presence in the Club;

   (c) comply with all applicable laws and regulations in their jurisdiction;

   (d) not engage in, facilitate, or condone any illegal activity within the Club;

   (e) cooperate with ClawClub in the investigation of any Dispute, fraud allegation, or Member complaint; and

   (f) not misrepresent the nature of the Club, its membership, or its relationship with ClawClub.

5.4 The Operator is responsible for non-technical Member support (community issues, admission decisions, content disputes between Members). ClawClub handles billing-related Member support.

---

## 6. Membership Pricing

6.1 All Membership Fees are denominated in **United States dollars (USD)** and are **tax-exclusive**. Applicable VAT, sales tax, or other indirect taxes are calculated and collected via Stripe Tax at the rate required by the Member's jurisdiction. The obligation to remit such taxes depends on the applicable jurisdiction and the relevant regulatory requirements; ClawClub uses Stripe Tax to facilitate calculation, collection, and, where applicable, remittance.

6.2 The **minimum Membership Fee** is **twenty-nine United States dollars (US $29) per year**.

6.3 The Operator sets the Membership Fee for their Club. The Operator may set the fee at US $29 or any amount above US $29.

6.4 All memberships are billed **annually**. Each Member has their own annual billing cycle commencing on their join date.

6.5 ClawClub takes the **Platform Share**: the greater of **thirty per cent (30%)** of the Membership Fee or **twenty-nine United States dollars (US $29)**, calculated on the pre-tax amount. The remainder is the **Operator Share**.

6.6 **Price grandfathering:** The Membership Fee at which a Member joins is the price they pay for as long as they remain subscribed. If the Operator increases the Membership Fee, existing Members continue to renew at their original price. New Members pay the new price. First-year Discount Codes revert to the full undiscounted price on renewal.

6.7 The Platform Share and Operator Share rates set out in this Clause 6 are the standard rates. ClawClub may negotiate different terms with specific Operators. Any such variation shall be documented in writing.

6.8 See **Schedule 1** for a summary of fees and revenue splits.

---

## 7. Discount Codes

7.1 The Operator may create Discount Codes for their Club. Discount Codes reduce the Membership Fee payable by the Member in the **first year only**. On renewal, the Member pays the full undiscounted Membership Fee (subject to price grandfathering under Clause 6.6).

7.2 **The discount comes out of the Operator Share, not the Platform Share.** ClawClub takes its full Platform Share calculated on the original undiscounted Membership Fee.

7.3 The maximum discount is capped such that the **Operator Share cannot fall below zero**. If the Operator Share of the original Membership Fee is zero (e.g., on a US $29/year Club), no Discount Codes may be created.

7.4 ClawClub enforces the cap in Clause 7.3 at the time of Discount Code creation. Discount Codes that would result in a negative Operator Share are rejected.

7.5 **Example:** For a Club with a US $100/year Membership Fee, ClawClub takes US $30 (30%). The Operator Share is US $70. The maximum discount is 70% (US $70 off). A 50% Discount Code means the Member pays US $50 in year one. ClawClub takes US $30. The Operator receives US $20. On renewal, the Member pays US $100 and the normal split resumes.

---

## 8. Complimentary Members

8.1 The Platform Fee includes **ten (10) lifetime Comp Seats**. These seats persist for as long as the Club exists and the Platform Fee remains current.

8.2 The Operator designates which Members receive Comp Seats. Comped Members have identical access to paid Members within the Club.

8.3 Comped Members have no Stripe subscription. Their access is managed entirely within the ClawClub database.

8.4 Additional Comp Seats may be purchased at **twenty-nine United States dollars (US $29) per seat per year**, payable at the same time as the Platform Fee.

---

## 9. Revenue Splitting and Payouts

### Revenue splitting via destination charges

9.1 ClawClub processes all Member payments as **Destination Charges** via Stripe. At the time each charge is processed:

   (a) the **Platform Share** is retained by ClawClub; and

   (b) the **Operator Share** is transferred to the Operator's Connected Account.

9.2 Revenue splitting occurs at charge time. There is no hold period, pending balance, or reserve on the Operator's incoming revenue. The Operator Share is available in the Operator's Connected Account from the moment the charge succeeds.

### Payouts from the Connected Account

9.3 Funds in the Operator's Connected Account accumulate and are paid out to the Operator's bank account by Stripe on a **monthly** cycle, in accordance with Stripe's standard payout schedule for Express accounts.

9.4 The **Payout Threshold** is **fifty United States dollars (US $50)**. If the Operator's Available Balance is below the Payout Threshold at the time of the monthly payout cycle, no payout is issued and funds continue to accumulate until the threshold is met.

9.5 The Operator shall maintain a valid Connected Account in good standing with Stripe. If the Connected Account is suspended, restricted, or closed by Stripe, ClawClub is not responsible for any delay or loss of funds.

### Ledger

9.6 ClawClub maintains an append-only event Ledger for each Club. The Ledger records all financial events, including but not limited to: Member payments, Platform Share deductions, Operator Share transfers, Disputes, Chargeback Fees, refund cascades, operator fee deductions, and payouts.

9.7 Ledger events are **immutable**. Corrections are recorded as new events that offset the original (e.g., a dispute reversal offsets the original dispute hold).

### Monthly statements

9.8 ClawClub shall provide the Operator with a monthly statement showing: Members joined, revenue collected, Platform Share, Operator Share transferred, Disputes, Chargeback Fees, refunds, and net position.

### Operator visibility

9.9 The Operator may view their financial position in real time via the Platform, including the balance of their Connected Account and a full history of Ledger events.

9.10 See **Schedule 2** for an illustrative payout timeline.

---

## 10. Operator's Financial Position

10.1 The Operator's financial position is determined by the balance of their Connected Account as reported by Stripe, together with the Ledger maintained by ClawClub.

10.2 The Operator's Connected Account balance may be affected by:

   (a) incoming Operator Share transfers from Destination Charges (credits);

   (b) Dispute debits and Chargeback Fees (Clause 11);

   (c) prorated refund cascade debits (Clause 12);

   (d) operator-requested refund debits (Clause 15);

   (e) Platform Fee deductions (where the Operator has consented to balance deduction under Clause 4.3); and

   (f) Comp Seat fee deductions (Clause 8.4).

10.3 If the Operator's Connected Account balance becomes **negative** as a result of Disputes, Chargeback Fees, or refund cascades, the negative balance shall be recovered by Stripe from future incoming Operator Share transfers. The Operator acknowledges that Stripe may hold future transfers until the negative balance is cleared.

10.4 If the negative balance persists and there is no reasonable prospect of recovery from future revenue (e.g., the Club has no active paying Members), ClawClub shall make reasonable efforts to contact the Operator to resolve the matter. If the negative balance is not resolved within thirty (30) days, ClawClub may suspend the Club pursuant to Clause 17.

10.5 If the Operator's Connected Account carries a negative balance and no future revenue is expected (e.g., the Club is closed and all memberships have expired), **ClawClub absorbs the loss**. ClawClub shall not pursue the Operator for unrecoverable negative balances except in cases of fraud or wilful misconduct.

---

## 11. Disputes and Chargebacks

### General

11.1 ClawClub, as merchant of record, handles all Disputes. The Operator shall cooperate fully with ClawClub in responding to Disputes, including providing any information or evidence requested.

11.2 The Operator is **financially responsible** for Disputes arising from Members they admitted. This responsibility reflects the Operator's duty to vet and approve Members carefully (Clause 5).

### Chargeback Fee

11.3 A **Chargeback Fee of twenty-five United States dollars (US $25)** is charged per Dispute, regardless of outcome. The Chargeback Fee is ClawClub's policy and is not a pass-through of any third-party fee.

11.4 The Chargeback Fee is debited from the Operator's Connected Account. If the Connected Account has insufficient funds, the fee creates or increases a negative balance that is recovered from future incoming transfers (Clause 10.3).

### Dispute lifecycle

11.5 When a Dispute is opened:

   (a) the disputed amount plus the Chargeback Fee (US $25) is debited from the Operator's Connected Account by Stripe, or creates a negative balance to be recovered from future incoming transfers;

   (b) a `chargeback_hold` event is recorded in the Ledger.

11.6 If a Dispute is **won** (resolved in ClawClub's favour):

   (a) the disputed amount is returned to the Operator's Connected Account by Stripe;

   (b) the Chargeback Fee of US $25 is **not refunded** -- it remains debited to cover administrative costs;

   (c) a `chargeback_hold_released` event is recorded in the Ledger.

11.7 If a Dispute is **lost** (resolved against ClawClub):

   (a) the debited amount becomes a permanent loss to the Operator;

   (b) a `chargeback_confirmed` event is recorded in the Ledger;

   (c) the cross-platform ban and refund cascade described in Clause 12 is triggered.

### Recovery mechanism

11.8 Where the Operator's Connected Account has insufficient funds to cover the disputed amount and Chargeback Fee, Stripe debits the Connected Account, creating a negative balance. This negative balance is recovered automatically from future incoming Operator Share transfers. The Operator acknowledges that future revenue may be reduced or withheld until the negative balance is cleared.

11.9 If the Operator has no future revenue and the negative balance cannot be recovered, ClawClub absorbs the loss in accordance with Clause 10.5.

### Per-operator circuit breaker

11.10 ClawClub monitors Dispute rates at the operator level to protect the Platform's standing with payment processors.

11.11 For Operators with **fewer than two hundred (200) paid Members billed**: any Dispute triggers manual review by the ClawClub team. No automatic action is taken.

11.12 For Operators with **two hundred (200) or more paid Members billed**: a Dispute rate exceeding **0.5%** (measured over a trailing twelve-month window) triggers an automatic **payout pause**. During a payout pause, the Club continues to operate and Members retain access, but Stripe payouts from the Operator's Connected Account are suspended pending ClawClub's review.

11.13 Following review under Clause 11.12, ClawClub may:

   (a) reinstate payouts;

   (b) impose additional conditions; or

   (c) terminate the Operator pursuant to Clause 17.

### Dispute prevention

11.14 ClawClub employs dispute prevention tools including, but not limited to, Stripe's Enhanced Issuer Network / Visa Compelling Evidence 3.0, Stripe Radar, and 3D Secure authentication on initial payments. The Operator acknowledges that these tools reduce but do not eliminate Dispute risk.

---

## 12. Cross-Platform Ban and Refund Cascade

12.1 When a Dispute is **lost** (Clause 11.7), the following actions are taken automatically:

   (a) the Member is **permanently banned** from the entire ClawClub Platform;

   (b) all other Club memberships held by the Member are **immediately cancelled**;

   (c) ClawClub **proactively refunds** each affected Club's membership, prorated to the remaining service period; and

   (d) the Member may not rejoin any Club.

12.2 The prorated refund amount for each affected Club is debited from the relevant Operator's Connected Account (or creates a negative balance recovered from future transfers), **capped at the total Operator Share revenue earned from that Member in that Club**. An Operator can never owe ClawClub money as a result of a refund cascade. If the prorated refund exceeds the Operator Share earned from the Member, ClawClub absorbs the difference.

12.3 **Rationale:** Proactive refunds prevent the banned Member from filing additional Disputes against their other Club memberships, which would multiply the damage to the Platform's Dispute rate. Every Operator who admitted the Member bears the cost of their own admission decision.

---

## 13. Fraud Prevention and Identity Verification

13.1 ClawClub employs a layered fraud prevention approach, including but not limited to:

   (a) the Club admission gate (Operator vetting);

   (b) 3D Secure authentication on initial payments;

   (c) renewal reminders with easy cancellation;

   (d) a spending ladder that flags rapid multi-club joins for review;

   (e) retroactive identity verification via Stripe Identity;

   (f) Stripe's dispute prevention tools;

   (g) the Chargeback Fee (Clause 11.3);

   (h) the cross-platform ban and refund cascade (Clause 12); and

   (i) the per-operator circuit breaker (Clause 11.10).

13.2 ClawClub may, at any time, require a Member to complete identity verification (government-issued identification and live selfie) via Stripe Identity. A Member who fails to complete verification when requested may have their membership suspended or terminated.

13.3 The Operator acknowledges that the admission gate is the Platform's first and most important line of defence against fraud. Diligent vetting by the Operator materially reduces Dispute and fraud risk for the entire Platform.

---

## 14. Content Moderation

14.1 All content posted to public areas of the Platform (entities, events, profiles, and other public-facing content) is subject to the **Legality Gate**, an automated content moderation system powered by large language model inference. Content that fails the Legality Gate is rejected before publication.

14.2 **Direct messages between Members are private.** ClawClub does not apply the Legality Gate to private messages and does not monitor, read, or moderate the content of direct messages, except where required by applicable law or in response to a valid legal process.

14.3 The Operator is responsible for the culture and conduct within their Club but is not required to moderate individual messages. ClawClub's content moderation is automated and operates at the platform level.

14.4 ClawClub reserves the right to remove any content from the Platform that violates applicable law, regardless of whether it was flagged by the Legality Gate.

---

## 15. Member Cancellations and Refunds

15.1 Members may cancel their membership at any time. Cancellation stops the next annual renewal. The Member retains access for the remainder of their paid period. **No refunds are issued** on cancellation.

15.2 Operators may remove Members from their Club at any time. **No refund is issued** unless the Operator explicitly requests one.

15.3 Where the Operator requests a refund for a removed Member, ClawClub refunds the Member the full Membership Fee (plus tax). The refund is settled as follows:

   (a) ClawClub reverses its Platform Share (ClawClub absorbs this cost);

   (b) ClawClub reverses the tax portion (returned to the Member);

   (c) the Operator Share is debited from the Operator's Connected Account (or recovered from future transfers) via an `operator_requested_refund` Ledger event; and

   (d) the Operator loses only their Operator Share -- never more.

---

## 16. Club Transfers

16.1 Clubs are **not transferable** by default. The Operator may not sell, assign, or transfer their Club or this Agreement to another person or entity without the prior written consent of ClawClub.

16.2 ClawClub may, at its sole discretion, facilitate a Club transfer in exceptional circumstances. Any transfer shall be subject to terms determined by ClawClub at the time.

---

## 17. Club Suspension and Termination

17.1 ClawClub may **suspend** a Club (preventing new Members from joining while existing Members retain access) in the following circumstances:

   (a) the Operator fails to pay the Platform Fee within the Grace Period (Clause 4.4);

   (b) the Operator's Connected Account carries a negative balance that is not resolved within thirty (30) days (Clause 10.4);

   (c) the per-operator circuit breaker is triggered and the matter is not resolved to ClawClub's satisfaction (Clause 11.12); or

   (d) ClawClub reasonably believes the Operator is in material breach of this Agreement.

17.2 ClawClub may **terminate** a Club (permanently closing it and revoking the Operator's right to operate on the Platform) where:

   (a) suspension has not resolved the underlying issue within a reasonable period;

   (b) the Operator has engaged in fraud, wilful misconduct, or illegal activity;

   (c) the Operator's conduct poses a material risk to the Platform's standing with payment processors; or

   (d) ClawClub determines, at its reasonable discretion, that continued operation of the Club is detrimental to the Platform.

17.3 On termination:

   (a) no new Members may join the Club;

   (b) existing memberships are cancelled (no future renewals), but Members retain access until their individual paid periods expire;

   (c) the Operator's Connected Account remains active until the final payout cycle after all memberships have expired; and

   (d) any remaining balance in the Operator's Connected Account is paid out in accordance with Clause 18.4.

17.4 ClawClub shall provide the Operator with written notice of suspension or termination, including the reasons therefor, except where immediate action is necessary to prevent harm to the Platform.

---

## 18. Voluntary Club Closure

18.1 The Operator may voluntarily close their Club at any time by providing written notice to ClawClub.

18.2 Upon voluntary closure:

   (a) no new Members may join the Club;

   (b) all existing memberships are cancelled (no future renewals); and

   (c) existing Members retain access until their individual paid periods expire.

18.3 **No refunds** are issued to Members for the remaining service period upon voluntary closure. Members with remaining paid access who are dissatisfied must contact ClawClub support.

18.4 The Operator's Connected Account remains active after closure. Revenue from any remaining active memberships continues to be split and transferred via Destination Charges in accordance with Clause 9. After the last membership expires and the next monthly payout cycle runs, the final payout is issued to the Operator, subject to the settlement of any outstanding negative balance, Disputes, or fees.

18.5 Once the final payout has been issued and no outstanding obligations remain, ClawClub shall notify the Operator that the closure is complete.

---

## 19. Intellectual Property

19.1 ClawClub retains all intellectual property rights in the Platform, including but not limited to software, APIs, trademarks, trade names, and documentation.

19.2 The Operator retains all intellectual property rights in the content they create and publish on the Platform. By publishing content on the Platform, the Operator grants ClawClub a non-exclusive, worldwide, royalty-free licence to host, display, and distribute such content solely for the purpose of operating the Platform.

19.3 The Operator shall not use ClawClub's trademarks, logos, or brand assets except as expressly authorised by ClawClub in writing.

19.4 Members retain all intellectual property rights in the content they create. ClawClub's licence to Member content is governed by the Member Terms of Service.

---

## 20. Confidentiality

20.1 Each party shall keep confidential all non-public information disclosed by the other party in connection with this Agreement ("**Confidential Information**"), and shall not disclose Confidential Information to any third party without the prior written consent of the disclosing party.

20.2 Confidential Information does not include information that:

   (a) is or becomes publicly available other than through a breach of this Clause;

   (b) was known to the receiving party prior to disclosure;

   (c) is independently developed by the receiving party without reference to the Confidential Information; or

   (d) is required to be disclosed by law, regulation, or valid legal process, provided the receiving party gives the disclosing party reasonable notice where permitted.

20.3 The obligations under this Clause 20 survive termination of this Agreement for a period of two (2) years.

---

## 21. Data Protection and Security

21.1 Each party shall comply with all applicable data protection laws, including but not limited to the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.

21.2 ClawClub processes personal data of Members as a data controller for the purposes of operating the Platform, billing, and fraud prevention. The Operator processes personal data of Members as a data controller for the purposes of managing their Club.

21.3 Where the Operator processes personal data obtained through the Platform, the Operator shall:

   (a) process such data only for the purposes of operating their Club;

   (b) implement appropriate technical and organisational security measures;

   (c) not transfer personal data outside the United Kingdom or European Economic Area without appropriate safeguards; and

   (d) promptly notify ClawClub of any data breach affecting Members.

21.4 ClawClub shall implement and maintain appropriate technical and organisational security measures to protect personal data processed through the Platform.

---

## 22. Limitation of Liability

22.1 Nothing in this Agreement excludes or limits either party's liability for:

   (a) death or personal injury caused by negligence;

   (b) fraud or fraudulent misrepresentation; or

   (c) any other liability that cannot be excluded or limited by applicable law.

22.2 Subject to Clause 22.1, ClawClub's total aggregate liability to the Operator under or in connection with this Agreement, whether in contract, tort (including negligence), breach of statutory duty, or otherwise, shall not exceed the total Platform Fees paid by the Operator in the twelve (12) months preceding the event giving rise to the claim.

22.3 Subject to Clause 22.1, neither party shall be liable to the other for any indirect, consequential, special, or incidental loss or damage, including but not limited to loss of profits, loss of revenue, loss of business, loss of goodwill, or loss of data, however arising.

22.4 ClawClub shall not be liable for:

   (a) the actions or omissions of Members;

   (b) the outcome of any Dispute;

   (c) any suspension, restriction, or closure of the Operator's Connected Account by Stripe;

   (d) any delay in payouts caused by Stripe or third-party payment processors; or

   (e) any loss arising from the Operator's failure to comply with this Agreement.

---

## 23. Insolvency

23.1 Either party may terminate this Agreement immediately by written notice if the other party:

   (a) becomes insolvent or is unable to pay its debts as they fall due;

   (b) enters into any arrangement or composition with its creditors;

   (c) has a receiver, administrator, or liquidator appointed over any of its assets;

   (d) passes a resolution for winding up (other than for the purposes of a solvent amalgamation or reconstruction); or

   (e) is subject to any analogous event in any jurisdiction.

23.2 In the event of ClawClub's insolvency, funds held in the Operator's Connected Account are the Operator's property and are not part of ClawClub's estate. ClawClub does not hold or custody the Operator's funds; the Operator Share is transferred to the Operator's Connected Account at the time of charge (Clause 9.1).

---

## 24. Force Majeure

24.1 Neither party shall be liable for any failure or delay in performing its obligations under this Agreement to the extent that such failure or delay is caused by a Force Majeure Event.

24.2 A "**Force Majeure Event**" means any event beyond the reasonable control of the affected party, including but not limited to: natural disasters, epidemics, pandemics, war, terrorism, civil unrest, strikes, government action, failure of telecommunications or power supply, or failure of third-party services (including Stripe).

24.3 The affected party shall:

   (a) promptly notify the other party of the Force Majeure Event and its expected duration;

   (b) use reasonable endeavours to mitigate the effects of the Force Majeure Event; and

   (c) resume performance as soon as reasonably practicable after the Force Majeure Event ceases.

24.4 If a Force Majeure Event continues for more than ninety (90) days, either party may terminate this Agreement by written notice.

---

## 25. Dispute Resolution

25.1 The parties shall attempt in good faith to resolve any dispute arising out of or in connection with this Agreement through **negotiation** within thirty (30) days of one party notifying the other of the dispute.

25.2 If the dispute is not resolved through negotiation within the period specified in Clause 25.1, either party may refer the dispute to mediation administered by the **Centre for Effective Dispute Resolution (CEDR)** in accordance with CEDR's model mediation procedure. The mediation shall take place in London, England.

25.3 If the dispute is not resolved through mediation within sixty (60) days of the referral (or such longer period as the parties may agree), either party may commence proceedings in the courts of England and Wales in accordance with Clause 28.

25.4 Nothing in this Clause 25 prevents either party from seeking interim or injunctive relief from a court of competent jurisdiction at any time.

---

## 26. Term and Renewal

26.1 This Agreement commences on the date the Operator creates a Club on the Platform or accepts these terms (whichever is earlier) and continues for an initial term of one (1) year.

26.2 This Agreement **automatically renews** for successive one-year terms unless:

   (a) the Operator provides written notice of non-renewal at least thirty (30) days before the end of the then-current term;

   (b) ClawClub provides written notice of non-renewal at least sixty (60) days before the end of the then-current term; or

   (c) this Agreement is terminated earlier in accordance with its terms.

26.3 Upon expiry or termination, the provisions of this Agreement that by their nature should survive (including Clauses 10, 11, 12, 19, 20, 21, 22, 23, 25, and 28) shall continue in full force and effect.

---

## 27. Variation

27.1 ClawClub may vary the terms of this Agreement by providing the Operator with at least **thirty (30) days' written notice** of the proposed changes.

27.2 If the Operator does not agree to the proposed changes, the Operator may terminate this Agreement by providing written notice within the thirty-day notice period. The existing terms shall apply until the effective date of termination.

27.3 Continued operation of a Club after the effective date of the variation constitutes acceptance of the revised terms.

27.4 Changes to fees (Platform Fee, Chargeback Fee, Platform Share, or Payout Threshold) shall not take effect until the start of the Operator's next renewal term, unless the Operator expressly consents to earlier application.

---

## 28. Governing Law and Jurisdiction

28.1 This Agreement and any dispute or claim arising out of or in connection with it (including non-contractual disputes or claims) shall be governed by and construed in accordance with the laws of **England and Wales**.

28.2 The courts of **England and Wales** shall have exclusive jurisdiction to settle any dispute or claim arising out of or in connection with this Agreement, subject to the dispute resolution procedure set out in Clause 25.

---

## 29. Entire Agreement

29.1 This Agreement (including the Schedules) constitutes the entire agreement between the parties in respect of its subject matter and supersedes all prior agreements, understandings, and representations, whether written or oral.

29.2 The Operator acknowledges that they have not relied on any representation, warranty, or undertaking not expressly set out in this Agreement.

29.3 Nothing in this Clause 29 excludes liability for fraud or fraudulent misrepresentation.

---

## Schedule 1: Fee Summary

| Item | Amount | Notes |
|---|---|---|
| Platform Fee (annual) | US $299 | Includes 10 Comp Seats. Non-refundable. |
| Additional Comp Seats | US $29/seat/year | Payable with Platform Fee. |
| Minimum Membership Fee | US $29/year | Set by Operator; cannot be below this floor. |
| Platform Share | 30% of Membership Fee or US $29, whichever is greater | Calculated on pre-tax amount. Retained by ClawClub at charge time via Destination Charge. |
| Operator Share | Membership Fee minus Platform Share | Transferred to Operator's Connected Account at charge time via Destination Charge. |
| Chargeback Fee | US $25 per Dispute | Regardless of outcome. ClawClub policy, not a Stripe pass-through. |
| Payout Threshold | US $50 | Minimum Connected Account balance for monthly payout. |
| Tax | Calculated and collected via Stripe Tax | Tax-exclusive pricing. Remittance obligations depend on jurisdiction. |

**Revenue split examples:**

| Membership Fee | Platform Share | Operator Share | Notes |
|---|---|---|---|
| US $29/year | US $29 (floor) | US $0 | Floor applies. |
| US $50/year | US $29 (floor) | US $21 | Floor applies (30% = $15, below floor). |
| US $100/year | US $30 (30%) | US $70 | Percentage applies (30% > $29). |
| US $200/year | US $60 (30%) | US $140 | Percentage applies. |

The US $29 floor applies for any Club priced below approximately US $97/year. Above that threshold, the 30% rate applies.

---

## Schedule 2: Payout Timeline Example

The following example illustrates the payout timeline for an Operator under the Destination Charge model.

### Assumptions

- Club membership fee: US $100/year
- Platform Share: US $30 (30%)
- Operator Share: US $70
- Operator has a Connected Account in good standing
- Monthly payout cycle by Stripe

### Timeline

| Event | Date | Effect on Operator's Connected Account |
|---|---|---|
| Member A joins | 1 January | +US $70 (Operator Share transferred at charge time) |
| Member B joins | 15 January | +US $70 |
| Member C joins | 3 February | +US $70 |
| **End-of-January payout** | 31 January | Stripe pays out US $140 to Operator's bank (US $70 + $70, above $50 threshold) |
| Member D joins | 10 March | +US $70 |
| Dispute opened (Member B) | 12 March | -US $95 debited (US $70 disputed amount + US $25 Chargeback Fee) |
| **End-of-February payout** | 28 February | Stripe pays out US $70 (Member C's share, above $50 threshold) |
| **End-of-March payout** | 31 March | Connected Account balance: US $70 (Member D) - US $95 (dispute) = -US $25. No payout; negative balance carries forward. |
| Member E joins | 5 April | +US $70. Balance recovers to +US $45. Below threshold; no payout yet. |
| Dispute resolved (won) | 20 April | +US $70 returned (disputed amount). US $25 Chargeback Fee remains. Balance: US $45 + $70 = US $115. |
| **End-of-April payout** | 30 April | Stripe pays out US $65 (US $115 - $50 retained floor) to Operator's bank. |

### Key observations

1. **No hold period.** The Operator Share reaches the Connected Account at the time of each charge. Revenue is available immediately.
2. **Disputes debit the Connected Account directly.** Stripe debits the Operator's Connected Account for the disputed amount and Chargeback Fee. If the account has insufficient funds, a negative balance is created and recovered from future incoming transfers.
3. **Monthly payouts by Stripe.** Funds accumulate in the Connected Account and are paid out monthly, subject to the US $50 threshold.
4. **Dispute resolution.** On a won dispute, the disputed amount is returned. The US $25 Chargeback Fee is never refunded. On a lost dispute, the debit is permanent and the cross-platform ban and refund cascade (Clause 12) is triggered.
5. **Club closure.** On voluntary closure, memberships expire naturally. Revenue continues to be split via Destination Charges for any remaining active memberships. After the last membership expires and the final monthly payout cycle runs, the Operator receives their final payout. No extended holdback period applies.

---

*End of Agreement*
