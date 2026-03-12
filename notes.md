# Notes

## Naming
- Use **sponsor** for the member who brings someone into the network and is accountable for them.
- Use **vouching** for lightweight endorsements that any member can make.

## Product direction
- Design the data model so new use cases can emerge over time.
- Members should be able to post to a wall/feed, but with limits to keep signal high.
- OpenClaw agents will often post on the user's behalf.
- There should be a searchable member directory/database accessible through OpenClaw.
- Example query: "Can you search for anyone in the database called Chris Smith?"
- Webhook delivery to each member's OpenClaw is a key feature and must be central to the design.
- Owen expects to host most OpenClaw instances initially.
- Users should be able to eject/export their OpenClaw and move it to self-hosting or another host.
- Principle: no lock-in; Owen should not own/control member data in a way that traps them.
- Conversation is the interface; no direct writes to the database.
- Open DMs are allowed between members in this private network.
- No introduction gate is needed for DMs because member context can be retrieved alongside messages.
- A user may belong to multiple private networks.
- Most users will probably belong to only one network, but the model should support many.
- Users should have one identity, one description, one website, and one auth token across networks.
- No split personalities across networks.
- Members may pay multiple monthly subscriptions to join multiple networks.
- For now, Owen is the head of each network.
- Each network may have its own membership agreement / manifesto.
- Network membership should be private by default.
- It is acceptable to reveal shared membership overlap only where both members already share the same network context.
- Members can search only within networks where they are active members (sponsored in and actively subscribed).
- Members must not see anything at all in networks they are not members of.
- There is no public content anywhere in the system.

## Messaging / DMs
- DMs are always person-to-person.
- Two members may DM only if they share at least one network.
- When a DM appears to the recipient, it should show all networks they have in common.
- Do not reveal any other non-overlapping networks either party belongs to.
- Store all chat transcripts for debugging and traceability.
- Ideally associate created entities back to the originating conversation/transcript row.
- References should point back to the exact immutable version a user saw.

## Search / alerts
- Push back on ambiguous search terms before querying embeddings. Example: "builder" could mean a house builder or software builder.
- Search should be scoped deterministically to the member's active networks only.
- For searches like "find me a builder", clarify intent first, then search member profiles and services.
- Opportunities are not the right result type for that query.
- For "tell me about Chris Smith", search across everything relevant the member has ever done, but show current/latest information by default.
- Alerts should be judged intelligently rather than only by static settings.
- For now, err on the side of more alerts than fewer alerts.
- There are two layers of filtering: the central network agent decides whether to send an alert to the member's OpenClaw, and the member's OpenClaw agent decides whether to surface it to the human.
- Hard alert settings may be added, but early versions can rely on judgment.
- Do not alert just because someone joined a network; alert only when the new member is relevant, and explain why.

## Opportunity / service / ask model
- Do not assume jobs are full-time or paid.
- Opportunities are where you're giving someone the chance to work, either paid or volunteering.
- Services are separate: offerings like therapy, massage, etc., usually with prices.
- Asks are separate again: e.g. "I need a musician for my band."
- Do not use resumes/CVs as a core primitive.
- Members are pre-screened before joining the network.
- Sponsor accountability matters if a member later causes issues.
- Separate entity types make sense: **post**, **opportunity**, **service**, **ask**, and **event**.
- Opportunities need more structure than posts.
- Events must have dates/times and locations.
- For opportunities, useful questions include:
  - what will the person be doing?
  - how will they likely be feeling in this role?
  - who supervises or manages them?
  - why would you recommend this to someone?
- These richer questions are not always required, but they are high-value.
- Services should support remote/online as well as location-based delivery.
- Asks should default to max one month validity unless a shorter natural expiry is obvious.
- Expired opportunities/services/asks/events should auto-hide or become inactive automatically.

## Versioning / IDs / history
- Everything should be immutable and versioned: updates create new rows rather than overwriting old ones.
- Everything is archived, not deleted; if deletions exist at all, they should be soft deletes.
- Users should normally only see the latest version.
- Older versions are for system/admin/debug use only; ordinary users never see them.
- Drafts probably do not need versioning, but if versioning drafts makes implementation cleaner, it is acceptable.
- Entities may be edited freely for now; quotas/cooldowns may be added later to stop agent loops.
- Re-embed immediately on every new version.
- New versions should become visible immediately.
- Plan from the start for full account deletion without breaking referential integrity.
- When someone leaves, keep their name visible in history but mark them as deleted.
- Keep EU right-to-be-forgotten considerations in mind.
- Prefer short agent-friendly IDs: 12-character half-numeric random IDs rather than UUIDs.

## Events / location
- Support recurring events from day one.
- Support RSVPs.
- Support max capacities.
- RSVP lists are visible within the network.
- Treat **Home Base** and **Current City** separately.

## Trust / graph
- Anyone may vouch for anyone else in the same network.
- Every vouch must include a reason.
- Sponsor is the highest vouch.
- Sponsor is permanent and cannot be changed, even if the member later leaves.
- Stop at sponsor + vouch for reputation/trust; do not add more reputation systems for now.
- Record the graph structure carefully so future membership-fee/MLM-style calculations would be possible later if desired.

## Billing / subscriptions
- Every network is paid by default.
- Owen may set a member's fee to zero.
- Sponsors should be able to pay for other members.
- Support per-network subscriptions.
- Future referral-based membership fee reductions may be added later; design the graph so this remains possible.

## Moderation / complaints
- There should be a complaint procedure.
- Complaints come to Owen.
- Owen will inspect chat logs if needed.
- Because the network is private and agent-mediated, moderation pressure is expected to be lower.

## Server / security / architecture
- Use one central network agent.
- The central agent identifies the member by bearer token and deterministically scopes all access to the networks they belong to.
- Permission scoping should be hard logic, not only model judgment.
- Consider Supabase with Row Level Security for defense in depth.
- If the central agent is compromised, it should still not be able to access information beyond what the compromised member token is allowed to see.
- Shared skill for all private networks.
- The skill should connect to the server, discover which networks the user belongs to, and receive information about each network's purpose and rules.

## Data philosophy
- Do not ask for job title, position, or status. Those are not interesting here.
- Member profiles should instead capture what they do, what they want to be known as, and what services they offer.
- No public content; all content is private to the relevant network(s).

## Configuration philosophy
- Prompting/collection logic should not be rigidly hard-coded.
- Owen wants these rules/questions editable in text files, similar to `SOUL.md`.
- The owner should be able to change what the agent asks and what quality bar applies without changing core code.

## Data direction
- Use a hybrid model: structured core data + flexible JSON + embeddings.
- Avoid rigid schema everywhere, but keep enough structure for reliable filtering and matching.
- Think in graph terms, but use Postgres rather than a dedicated graph database for now.
- Embeddings should be used across profiles, services, offers/opportunities, posts, and linked writings/content.
- Search flow: structured filters + embedding ranking + trust/vouch context + external content enrichment + DM/webhook follow-up.
- Identity is global; membership is network-specific.
- Sponsor, quotas, covenant acceptance, billing/subscription state, and most activity should be scoped per network.
