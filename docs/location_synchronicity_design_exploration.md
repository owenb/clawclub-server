# Location Synchronicity — Design Exploration

This is an exploration document, not an implementation plan. The purpose is to think through every dimension of the location feature before committing to a build. It should be readable by another AI for consideration and pushback. File-by-file changes, exact SQL, and test specifications come later, in a separate v1 implementation plan.

## What we're trying to do

The platform should notice when members of the same club find themselves in the same place at the same time and surface meaningful synchronicity matches around that. The killer experience is *"you and Maria will both be in Tokyo April 14–18 — want me to introduce you?"* — magic that nobody else is doing in this space and which the existing vector engine cannot produce because location is structured spatiotemporal data, not semantic text.

But the simple "two travelers in the same city" framing undersells the feature. Real members of ClawClub are not all rooted in one city. They have multiple homes, they travel constantly, they relocate. A genuine location feature has to model the full range of how modern members exist in space and time.

## The fundamental problem

Location data is **multi-dimensional** (members can have multiple connections to multiple places) and **time-varying** (those connections change over time). Most platforms model location as a single static field on the user profile and call it done. That's wrong for ClawClub because:

- Some members live in two or three cities simultaneously
- Some members are nomads with no fixed base
- Some members are temporarily abroad for sabbaticals or extended stays
- Some members travel constantly with discrete trips
- Some members are rooted but visit a few favorite cities annually
- Members move — their "home" changes
- A member's "presence" in a city this week is different from their "home" in a city for the past five years

A correct data model has to handle all of these without forcing members into one of them.

## Modes of being

Before designing the data model, here are the member archetypes the system has to support:

1. **Pure rooted.** One home city, never travels. Rare in this audience but exists.
2. **Rooted with occasional trips.** One home, a handful of trips per year.
3. **Multi-base.** Splits time between two or more cities (London + NYC, or Lisbon + Berlin + Tokyo). Each base is "home."
4. **Frequent traveler.** Has a base but is constantly on trips. The base is real but the calendar is mostly travel.
5. **Nomad.** No fixed base. Always somewhere new for weeks at a time. No row in the system would correctly be called "home."
6. **Temporarily relocated.** Has a long-term home but is on a 6-month sabbatical or assignment elsewhere. During the assignment, they're effectively living in the second city without actually moving.
7. **Recently moved.** Used to live in city X, now lives in city Y. The transition needs to be representable.

Any model that can't represent all seven of these cleanly is too narrow. The system should be able to express "I split my time between Lisbon and NYC, and I'll be in Tokyo for two weeks in April" without contortion.

## Data model exploration

Three options I considered.

### Option A: Travel plans only, no separate "home" concept

Treat everything as a "presence" with a date range. A home is just a presence with no end date. A multi-base member has multiple ongoing presences. A nomad has a sequence of bounded presences with no overlap.

- **Pro:** unified model, one table, one set of API actions, one matching algorithm.
- **Con:** semantically blurry. "I live here" and "I'm visiting here" are different things to the member and to the matching logic ("you're visiting their home" is a different match type from "you and they are both visiting"). A unified model collapses that distinction and the agent has to reconstruct it.

### Option B: Separate `home_locations` and `travel_plans` tables

Two tables, two concepts, two API surfaces.

- **Pro:** semantically clear. Home and travel are different things to members. The matching logic can reason about them differently.
- **Con:** more tables, more actions, the matching engine has to query and unify them.

### Option C: One `member_locations` table with a `type` discriminator

One table containing both kinds, with a `type` column (`'home' | 'travel'`). Both have date ranges (home's `ends_at` is nullable for ongoing, travel's `ends_at` is required). The API can have two separate action surfaces (`member.home.*` and `member.travel.*`) that both read/write the same underlying table.

- **Pro:** unified storage and matching, but separated semantics at the API and SKILL.md layer. Members and agents see two clean concepts; the engine sees one queryable substrate.
- **Pro:** future-proofs for new presence types we haven't thought of (`'considering_relocating_to'`?, `'temporary_assignment'`?).
- **Con:** the type column can be ambiguous in the matching logic ("is a 6-month sabbatical a home or travel?"). Need clear rules.

**Recommendation: Option C.** The unified table is the right substrate, but the API and SKILL.md frame it as two distinct concepts because that's how members actually think about it.

### Sketch of the table

```
member_locations
  id
  member_id              -- the member this presence belongs to
  type                   -- 'home' | 'travel'
  city                   -- normalized city name (text)
  country                -- ISO 3166-1 alpha-2 country code
  region                 -- optional, for "London, UK" vs "London, ON" disambiguation
  starts_at              -- when this presence begins (nullable for "I've always lived here")
  ends_at                -- when it ends (nullable for ongoing home)
  visibility             -- 'private' | 'shared_clubs' (default) — see Privacy section
  note                   -- optional free text ("happy to meet for coffee")
  created_at
  updated_at
```

Constraints:
- `type = 'travel'` requires both `starts_at` and `ends_at` (a trip without an end date is a home).
- `type = 'home'` allows `starts_at` and `ends_at` to be null (ongoing home with unknown start).
- `ends_at >= starts_at` when both are present.
- `city` and `country` are required.

A nomad has no `home` rows and a series of `travel` rows. A multi-base member has two or three `home` rows, all with `ends_at = null`. A relocator updates by setting their old home's `ends_at = the move date` and inserting a new home row with the new city.

### Alternative I considered and rejected: structured data on the member profile

Putting locations as a structured field on member profiles would tightly couple location lifecycle to profile versioning, which is wrong. Locations change much more often than profiles and are operational data, not self-description. Keeping them in their own table is cleaner.

### City normalization (real and annoying)

Two members in "Tokyo" should match each other. But:

- "Tokyo" vs "tokyo" — case
- "Tokyo" vs "Tōkyō" — diacritics
- "Tokyo" vs "Tokyo, Japan" — qualifier in the city field
- "London" (UK) vs "London, Ontario" — disambiguation by country
- "NYC" vs "New York" vs "New York City" — colloquial vs official
- "Bay Area" — not a city at all, but members might write it

Options:

1. **Free text + agent-side normalization.** SKILL.md instructs the agent to normalize before submitting: title case, no diacritics, official English name, no qualifiers in the city field (use `region` if needed), use ISO country codes. Brittle but simple, no external dependencies.
2. **Geocoding API** (Google Places, OSM Nominatim). Best matching, but adds an external dependency, latency, and cost. Returns canonical place IDs.
3. **Predefined city list.** Maintain a list of cities the system understands. Agent picks from the list. Works for top 200 cities, doesn't scale.
4. **Place IDs from Google Places.** Most accurate, most external dependency.

**Recommendation for v1: Option 1 (agent-side normalization).** Document conventions in SKILL.md. Worst case some matches are missed because of typos — better than building external API integration before we know the feature is loved. Geocoding is a v2 upgrade.

The country field is the key disambiguator. London + GB and London + CA are not the same city. The matching joins on `(city, country)` exact match.

## Match types — what the engine surfaces

Five distinct synchronicity scenarios. I'll describe each in plain English, then think about how the engine should rank and surface them.

1. **Travelers crossing.** Both members have travel plans to the same city at overlapping dates. *"You and Maria will both be in Tokyo April 14–18."* This is the most magical case — two people who didn't plan to meet, ending up in the same place by independent decision. The platonic synchronicity match.

2. **Visiting their home.** Member A has a travel plan to a city; Member B lives there. *"You'll be in Tokyo next week, where Yuki lives. He's offered to show people around (gift)."* High value: A gets a host, B gets a visitor. The "visit my home" framing also connects naturally to the gift system if B has standing offers about hosting people.

3. **Their visit to your home.** Inverse of #2. Member A lives in a city; Member B has a travel plan there. *"Bob will be in your city (London) next month."* A gets to be a host. Opt-in to introduce.

4. **Same home discovered.** Both members have a home in the same city, and the engine hasn't surfaced this match before. *"Sarah also lives in Lisbon — you didn't know."* Magic the first time only. After both members have been notified once, this isn't synchronicity anymore — it's just a fact. Don't keep re-surfacing.

5. **Long stay overlap.** A member is on a long-term temporary assignment (6-month sabbatical, semester abroad, work secondment) in a city where another member is. Functionally similar to #4 but the visit is bounded. *"Bob has been in Lisbon for the past three weeks and will be there for two more — you're a local."*

These five scenarios all fall out of one underlying SQL primitive: **find pairs of members in the same (city, country) at overlapping times**. The differences are interpretive — they depend on the `type` of each member's row in the overlap.

### The "is this match worth surfacing" problem

Not every overlap is magical. Two people who both live in London "matching" because they live in London is not synchronicity — it's geography. The ranker should:

- **Boost:** travelers crossing in a non-home city for either party (the most synchronistic case)
- **Boost:** visit-your-home matches (high practical value, host opportunity)
- **Allow once:** same-home discovery (only the first time the pair is detected)
- **Suppress:** matches between two members who have already been introduced (DM thread exists)
- **Suppress:** matches that are too far in the future (six months out is not actionable)
- **Throttle:** any individual member should receive at most maybe 2–3 location matches per week to avoid flood

The throttling reuses the existing `signal_background_matches` delivery throttle infrastructure.

### One match kind, one payload

Don't create five different match kinds. Use one new kind: `co_location`. The payload describes the specifics:

```json
{
  "matchKind": "co_location",
  "payload": {
    "city": "Tokyo",
    "country": "JP",
    "overlapStartsAt": "2026-04-14",
    "overlapEndsAt": "2026-04-18",
    "yourPresenceType": "travel",
    "otherPresenceType": "home",
    "yourPresenceId": "...",
    "otherPresenceId": "..."
  }
}
```

The agent reads this and constructs natural language based on the type combination:
- both `travel`: *"you and X will both be in Tokyo April 14–18"*
- you `travel`, other `home`: *"X lives in Tokyo, where you'll be April 14–18"*
- you `home`, other `travel`: *"X will visit your city Tokyo April 14–18"*
- both `home`: *"X also lives in Tokyo"* (only ever delivered once)

One match kind, four framings, all derived from payload metadata. Same delivery pipeline, same throttling, same signal infrastructure.

## Privacy model — the most important section

Location data is sensitive in ways content posts are not. Where you sleep, where you'll be next week, when your home is empty. Get this wrong and the platform is dangerous. The privacy model has to be the foundation, not an afterthought.

### The fundamental rule: locations are private to the engine, never directly visible

Members **never see another member's raw location data via the API**. Not their home, not their trips, not even what city they're in right now. The only thing that ever surfaces is a **matched and mutually-acknowledged synchronicity**, delivered through the standard signal pipeline, with consent before any direct contact.

This is a much stronger guarantee than "locations are visible to people in your shared clubs." The risks of the latter:

- Stalking. A member discovers another member's home city and uses that to find them in person.
- Burglary signaling. Knowing when a member is away from home (because they posted a trip) signals their home is empty.
- Creep behavior. Watching someone's travel patterns over time builds a profile of their movements.

The "engine-only" model eliminates all of these because there's no API surface that ever returns raw location data for someone else. The closest a member ever gets to knowing where another member is is *"the engine matched you and Maria in Tokyo April 14–18, want to be introduced?"* — and even that match goes to both of them simultaneously, with consent required from both before anything more.

### What members CAN read

- Their own locations. Always.
- Match outputs from the engine. Same as today's matches — they're delivered as signals through `updates.list`, with payload describing the synchronicity.

### What members CANNOT read

- Another member's home cities, even members in the same club.
- Another member's travel plans, past, present, or future.
- A search like "who in this club lives in Lisbon" — does not exist.
- A match that the other party hasn't acknowledged yet (unless we want both to be notified simultaneously — see below).

### The acknowledgment question

Two design options for how a co-location match gets surfaced:

**Option α: Both notified simultaneously.** When the engine detects a match, it writes signals for both members. Both see *"you and X will both be in Tokyo April 14–18 — want me to introduce you?"* in the same update window. Each can independently say yes/no. If both say yes, a DM thread is opened. If either says no, the other never knows the match happened.

**Option β: One notified first.** Some asymmetric model where one member sees the match first and has to opt in before the other is notified.

Option α is simpler, more symmetric, and avoids any "you have a secret admirer" creepiness. Both parties find out at the same moment. The risk is that Maria sees *"you and Owen will both be in Tokyo"* and thinks "ugh, no thanks" — Owen learns nothing about Maria's existence in this scenario, which is correct but means the engine produced a match neither party benefited from.

Option β is more cautious but adds complexity (asymmetric state machine on each match) and a possible creepy edge case (what does Owen see?).

**Recommendation: Option α.** Symmetric, simple, and the standard delivery pipeline already supports it. Both members get the signal. Either can ignore. Connection requires both to actively opt in.

### The legality gate on location notes

The optional `note` field on a location row is free text — *"happy to meet for coffee"*, *"prefer local guides"*, *"in town for a wedding"*. Free text from members runs through the legality gate at content creation today. Location notes should also go through the gate: same model, same prompt, same blocking on illegal content.

### Visibility levels still exist as a UX courtesy, but with weaker meaning than usual

Even though locations are never directly readable by other members, having a `visibility` column lets a paranoid member opt into an even stricter mode:

- `private`: the engine itself doesn't use this row for matching at all. The member has noted their location for their own records, but doesn't want even the synchronicity engine reasoning over it. Useful for safety-focused members.
- `shared_clubs` (default): the engine uses the row for matching against other members of clubs the member is in. Other members never see the raw row, only the synchronicity output.
- `public` (probably skip in v1): would mean the engine considers this row across all clubs, even ones the member isn't in. Risky surface area. Don't ship.

The default is `shared_clubs`. The `private` setting is for members who want to log their own travel without the engine doing anything with it.

### Audit and right to deletion

Members can read all their own location rows via `member.travel.list` / `member.home.list`. They can delete any row at any time via the corresponding `remove` action. Deletion is hard delete from the table — we don't keep tombstones for location data because there's no audit value and there is privacy cost. (Past matches that referenced the row stay in `signal_background_matches` with their payload, but the row itself is gone.)

## API surface

Six actions, in two clean groups. The split mirrors how members actually think about the two concepts.

### Travel actions

- **`member.travel.add({ city, country, region?, startsAt, endsAt, note?, visibility? })`** — declare a new trip. Both `startsAt` and `endsAt` required. Returns the new row.
- **`member.travel.remove({ travelId })`** — delete a trip (cancellation).
- **`member.travel.list({})`** — list your own current and upcoming trips. Past trips probably hidden by default; opt-in flag to include them.

No `update` action. Update = remove + add. Keeps the action surface tight.

### Home actions

- **`member.home.add({ city, country, region?, startsAt?, note?, visibility? })`** — declare a home. `startsAt` optional (you might not remember when you moved). No `endsAt` — that gets set later if you move.
- **`member.home.remove({ homeId })`** — declare you no longer live there. Sets `ends_at = now()` rather than hard deleting (so the engine knows when this home ended). Or hard delete — see the audit/right-to-deletion principle above. I lean toward hard delete for privacy; the past match payloads are sufficient history.
- **`member.home.list({})`** — list your own current homes. Includes any with `ends_at IS NULL` or `ends_at > now()`.

Six actions total. Both groups read your own data only — no `memberId` parameter to read someone else's locations. That capability does not exist.

### What about the matching results?

The matches themselves come through the existing signal/update infrastructure. No new "location matches" listing action. The agent reads matches via `updates.list` like today, sees `co_location` in the payload, and constructs the natural-language summary.

## Trigger model — when does the worker do the work

The synchronicity worker reacts to four events:

1. **A new travel plan is added** → check overlaps with all other members' homes and travel plans in shared clubs whose date ranges intersect this trip.
2. **A new home is added** → check overlaps with all other members' future travel plans in shared clubs that intersect this home (no end date or end date in the future).
3. **A trip or home is removed** → expire any pending matches that referenced it. Also delete historical match rows so they don't block dedupe (see "Match dedupe and reopen" below — same trap as gifts/loops).
4. **A member joins a new club** → optionally backfill: check the new member's locations against existing members in the new club. Could be heavy. Defer to the existing periodic backstop sweep model rather than computing it at join time.

For #1 and #2, the work is a SQL window-overlap query against `member_locations` for all other members in clubs the actor shares. Indexes on `(city, country, type, ends_at)` and `(member_id)` make this cheap.

### Match dedupe and reopen — learning from the gifts/loops review

The gifts/loops review flagged that the `signal_background_matches` unique constraint `(match_kind, source_id, target_member_id)` plus `ON CONFLICT DO NOTHING` creates a dedupe trap. Same trap applies here.

If Owen adds a Tokyo trip → matches are created with `source_id = owen_trip_id` for each potential overlap target. If the trip is later removed and re-added (different ID, no problem) — but if the trip is *updated*... well, we said no update action, so this edge case doesn't exist for trips. For homes, if the home is updated (date adjustment), we'd hit the trap. Mitigation: any update to a home that affects date range issues a remove + add internally, which produces a new row with a new ID.

Or even simpler: don't expose `update` for either. Members remove and re-add. This is friction but avoids a class of bugs.

### Trigger-time AND delivery-time validity

Same lesson from gifts/loops. If a trip is removed after the match is created but before delivery, the delivery has to recheck and skip. Add a `co_location` validity check in the delivery loop that confirms both presence rows still exist and still overlap.

## Edge cases — the long list

From thinking through this in detail. Each one is a real situation that will happen in production.

1. **Past travel plans.** Members might add trips that have already happened (for record). The matcher only triggers on plans where `ends_at > now()`. Past plans don't generate new matches but stay in the table for member's own history.

2. **Recurring travel.** *"I'm in NYC every other week."* Don't model recurrence in v1. Members add discrete trips. Recurrence is v2 if useful.

3. **Open-ended travel.** *"I'm going to Tokyo for a few weeks, not sure when I'll leave."* Travel rows require `ends_at`. Member estimates a date and updates it (remove + re-add) as plans firm up. Or we relax the constraint and allow open-ended travel — a trip with no end date. Tradeoff: more flexible but harder to match cleanly. **I'd require ends_at for v1** and let members set it generously and update.

4. **Multi-stop trips.** *"London → Paris → Berlin in April."* Member adds three rows, one per city. Each gets matched independently. Fine.

5. **Permanent moves.** Member moves from London to Lisbon. Member calls `home.remove(londonHomeId)` then `home.add(lisbon)`. Two actions. Could add a `home.move({ from, to, on })` convenience action but defer.

6. **Address-level privacy.** Smallest unit is city + country (+ optional region for disambiguation). No streets, no neighborhoods, no addresses. Ever. v2 might add neighborhood for big cities, but only if there's a clear safe path.

7. **Time zones and date granularity.** `starts_at` and `ends_at` are timestamps (timestamptz). For the *"Tokyo April 12–18"* case, the agent submits midnight UTC on each date or end-of-day to be inclusive. Day-granularity is enough for overlap matching. No need for hour-precise timing.

8. **Same-day overlap.** Both arrive on the day Maria leaves. Inclusive boundaries: this counts as an overlap. The agent can describe it as *"you arrive the day Maria leaves — narrow window."*

9. **Backfilling on add.** When a trip is added, the worker has to check it against potentially many other members' overlapping presences. The work is bounded by how many members in shared clubs have presences in that city. Index the `(city, country)` lookup heavily.

10. **Trip cancellation expires matches.** Member removes a trip. Pending matches that referenced it get expired immediately. Already-delivered matches stay in the feed but the agent should ideally know to mark them stale (this is a "closed loop" style problem — see lesson from gifts/loops).

11. **Multiple homes in the same city.** Probably one home row per (member, city, country, type). Add a unique constraint? Or just allow duplicates and tolerate weirdness? Lean toward the constraint for simplicity.

12. **Country missing or unknown.** Country is required (NOT NULL). Agent infers from city or asks. ISO codes are unambiguous.

13. **The "ghost trip" problem.** A member adds a trip and then forgets to actually go. The match still triggers. Mitigation: confirm the trip is happening before delivering the match. *"You said you'd be in Tokyo April 14–18 — still happening?"* Could be a SKILL.md guidance for the agent on the day before delivery. Or just live with the occasional ghost match — they're low-stakes.

14. **Members in totally different time zones.** No issue; the data is in UTC, the agent presents in member's local time.

15. **Home without start date.** Allowed. Member has been there for "a while," doesn't matter. The matcher just checks overlap with `coalesce(starts_at, '-infinity')`.

16. **Massive overlap windows.** Two members with multi-month presences in the same city. Match once, not every day. Once the match is delivered, dedupe by (kind, source_id, target).

17. **The matched member leaves the club.** Pending matches involving them get expired when the synchronicity worker checks accessibility (existing pattern).

18. **Member deletes account.** All their location rows get deleted via the existing member-deletion path. Pending matches involving them get expired.

19. **Match payload references presence IDs.** If the rows are hard-deleted (e.g., trip cancellation), the payload IDs become dangling. Make the payload self-sufficient: include city, country, dates, and types in the payload itself, not just IDs. Then the row going away doesn't break the signal.

20. **Member opts out of location matching entirely.** A `privacy.location_matching_enabled` boolean on the member could opt them out of everything. Their rows are stored but the worker skips them. v2 if needed.

## Things this depends on

- **Gifts and loops shipping first.** The gifts/loops infrastructure sets up several patterns this feature reuses (match kind in `signal_background_matches`, the dedupe trap and how to avoid it, the trigger-time + delivery-time guard pattern, the "expire on remove" cleanup discipline, the legality gate on free-text fields). Building location after gifts/loops means we inherit the lessons learned and the existing test patterns.
- **The synchronicity worker as the home for the match-generation logic.** Same worker, new function, new match kind. No new background process.
- **The existing signal delivery pipeline.** Co-location matches go through `signal_background_matches` → `signal_deliveries` → `updates.list` like everything else. No new delivery infrastructure.

## Things this enables next

Worth flagging because they shape some design choices:

- **The Club Mind reasoning layer (when it ships).** Location data is rich substrate for the LLM-based reasoning layer. *"Five members in CatClub will all be in Lisbon in April"* is an emergent pattern the vector engine can't see, the basic co-location matcher can't see (because it's pairwise, not n-ary), but the Club Mind can. Building the location data substrate now means the Club Mind has more to reason over when it lands.
- **Gift × location matches.** *"You'll be in Lisbon next week, where Sarah lives. She has a standing gift offering to host visitors."* This requires the location feature AND the gifts feature to both exist. It's not a separate primitive — it falls out naturally when both are present and the agent reads them together at delivery time.
- **`member.tell()` × location.** *"Owen mentioned he wants to explore moving to Lisbon. Three CatClub members live there."* Combines a tell signal with location data to surface a matching opportunity. Falls out naturally when both exist.
- **Recurring travel and trip discovery.** v2 could let members declare "I'm in NYC every other week" as a recurrence rule. Or pull from calendar integration.
- **Locality-based clubs.** A future club kind organized around a city (e.g., a "Lisbon" club) could use the home table directly for membership eligibility.

## Open questions (only Owen can answer)

These are decisions that affect the design but I don't want to commit to without his read.

1. **`Option α` for symmetric notification — is that the right model?** Both members notified simultaneously, both have to opt in. Alternative is asymmetric (one sees first). Strong recommend on Option α but it's a real product call.

2. **Hard-delete vs soft-delete on location row removal.** Privacy says hard-delete (no trace). Audit/recovery says soft-delete (keep with `deleted_at`). For locations specifically, I lean **hard-delete** because the privacy cost outweighs the audit benefit. Confirm.

3. **Visibility default — `shared_clubs`?** The "engine-only" privacy model means the visibility setting is more about whether the engine considers the row at all than about who can see it directly. `shared_clubs` is the natural default but you could argue for `private` (engine-considered) if you want members to explicitly opt into matching.

4. **Should there be a `member.locations.disable` action that opts a member out of all location matching for a period?** *"Don't surface me to anyone for the next month."* Useful for members in a sensitive period (recovering from illness, going through a divorce, in a stalking situation). Could be a v1 feature or v2.

5. **City normalization — is agent-side normalization plus SKILL.md conventions enough for v1?** Or do we want to ship with a geocoding API integration from day one for canonical place IDs? I lean v1 = agent normalization, v2 = geocoding. Cost matters here even though you said it's not a constraint.

6. **What's the right delivery throttle for `co_location` matches per member?** Today's throttles: ask/offer = 1/day, intros = 2/week. Co-location is more like intros (relationship-forming) than asks (tactical). I'd say **2/week**. But during heavy travel weeks a member might want to know about all overlaps, not just two. Could be a per-member preference later.

7. **Should past trips be visible in `member.travel.list` by default?** I lean no — the default is current/upcoming. Past trips behind a flag. Members rarely care about their own travel history; the feature is forward-looking.

8. **The "same-home discovery" match (#4) — surface once and never again, or never surface at all?** The argument for "never" is that two members in the same home city is geography, not synchronicity. The argument for "once" is that some members genuinely don't know about each other's home overlap and the discovery is valuable. I lean **once per pair, ever**, with explicit dedupe state.

9. **Region as a free-text disambiguator vs structured.** I have `region` in the schema as optional text for "London, UK" vs "London, ON". Could instead use ISO 3166-2 codes (like `GB-LND` or `CA-ON`). More structured but more friction. Lean text for v1.

10. **Quotas on location actions.** Today's quotas count entity creations toward 30/day. Should location adds count similarly, or be uncapped, or have a separate quota? Locations are not content. I'd say a separate, generous quota (maybe 20/day) just to prevent runaway abuse, but they don't draw from the content quota.

## What's NOT in this design

To avoid scope creep, the things deliberately out of scope:

- **No address-level data.** City + country only. No streets, no neighborhoods, no GPS coordinates.
- **No real-time location tracking.** Members declare their plans; the system does not track where they are.
- **No "currently here" continuous broadcasting.** Member doesn't need to "check in" anywhere. Travel plans are advance declarations.
- **No public location feed.** No "show me everyone in Tokyo this week" surface — that's exactly the kind of API that breaks the privacy model.
- **No location-based notifications outside of synchronicity matches.** No "X just arrived in Tokyo" alerts. The engine does the matching, the matches go through the standard signal pipeline, that's the only output.
- **No calendar integration for trip auto-import.** v2 maybe.
- **No travel plans that span multiple cities as a single object.** A multi-stop trip is multiple `travel` rows.
- **No `update` actions on either travel or home.** Use remove + add. Avoids a whole class of dedupe and version bugs.
- **No backfill on club join.** Defer to the existing periodic backstop sweep.
- **No location history beyond what the table holds.** Past trips stay in the table; expired homes either stay (with `ends_at` set) or are hard-deleted.

## Summary

The proposal in one paragraph:

A unified `member_locations` table holds both travel plans and homes, distinguished by a `type` column. Members declare their presence via two clean API surfaces (`member.travel.*` and `member.home.*`). The synchronicity worker reacts to new locations by running a SQL window-overlap query against other members' presences in shared clubs and writes `co_location` matches into the existing `signal_background_matches` table. Both members of a matched pair get the signal simultaneously through the standard delivery pipeline; either can opt in to be introduced. **Raw location data is never visible to other members via any API** — the engine reads it for matching, and only the matched output is ever surfaced. Cities are agent-normalized text plus ISO country codes for v1; geocoding integration is a v2 upgrade. The data model and patterns are designed to extend naturally into the Club Mind reasoning layer when that ships, providing rich spatiotemporal substrate the vector engine cannot generate.

## What would convince me this is wrong

Genuine failure modes I'd want a reviewer to push on:

- **The "engine-only" privacy model is unworkable in practice** because members actually do want to see who's in their city without waiting for a match. If most members ask their agent *"who from CatClub lives in Lisbon?"* and we have to say *"that's not a thing,"* the feature might feel broken.
- **The unified `member_locations` table with a type discriminator turns out to be confusing in the matching logic** — too many edge cases where home vs travel needs different handling.
- **City normalization without geocoding produces too many missed matches** — members type "Tokyo" and "Tokyo, Japan" and "東京" and we miss all the cross-matches. If this is real in production, geocoding has to come earlier than v2.
- **Travel plans without an end date are actually common enough** that requiring `ends_at` is wrong — we should allow open-ended trips.
- **The match payload should include more metadata** — not just city/country/dates but also the matched members' standing gifts, recent posts, etc. — to give the agent richer context for the introduction message. Or the opposite: payload should be ID-first and minimal, agents fetch details. (The existing match payloads in the synchronicity worker are ID-first, so consistency argues for the same here.)
- **Symmetric notification (Option α) might feel creepy in practice** — Maria gets *"you and Owen will both be in Tokyo"* without ever opting in to share that Owen exists to her. Even though Owen doesn't see anything about Maria unless she accepts, the simple fact of the engine making this match might feel intrusive to some members. The alternative is asymmetric (one notified first, only proceed if they want), which is more cautious but adds complexity.

These are the places where the design might be wrong and where I'd want a reviewer to push back hard.
