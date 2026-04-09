# Locations as Synchronicity Substrate — Implementation Plan v3

This is v3 of the location feature plan. v2 had five real defects that a code review surfaced; v3 fixes all of them. Read **What changed from v2**, **Why this exists**, and **Must-hold invariants** before anything else.

## What changed from v2

Five fixes, all tightenings rather than architectural changes:

1. **Peer-readable archived history is closed.** `includeArchived` and `includePast` now only work on self-reads. When listing another member's locations, both flags are forced to `false` at the repo layer regardless of what the agent passes. Other members see only currently-live, currently-relevant data. This is a new invariant (#19).

2. **`clientKey` provides full retry safety, not just create-time idempotency.** A new chain-scoped unique index `(location_id, client_key) WHERE client_key IS NOT NULL` covers update and remove versions too. Same key + same chain + same intent returns the existing version. Same key + different intent returns 409. Invariant 17 is updated to reflect actual coverage.

3. **Boost computation always runs when there are pending matches.** v2's "skip when global pool ≤ batch size" optimization was wrong because throttling is per-recipient, not global — multiple matches targeting the same member compete for that member's daily/weekly cap even when the global pool is small. Invariant 4 is rewritten: the boost query is unconditionally run on every cycle, but it's a single bounded batched query so the cost is negligible.

4. **The boost SQL is fixed.** v2's sketch derived "imminent" from the source row's date range, which meant any ongoing home would always satisfy "imminent" even when the actual overlap with the other member's travel was 80 days out. v3 computes the *overlap window* correctly via `GREATEST(s.starts_on, t.starts_on, CURRENT_DATE)` and checks imminence against that clamped value.

5. **`same_home` overlaps don't get the synchronicity boost.** Two members who both live in the same city are experiencing permanent geography, not magical timing. Boosting them would recreate the "Tokyo flood" problem in ranking form. v3 excludes home × home overlaps from the boost computation entirely (boost = 1.0 always for same_home). The agent-facing read helper still returns same_home overlaps so the agent can mention them as context — they're just not used to reorder delivery. This is a new invariant (#20).

The architecture from v2 is unchanged. v3 fixes correctness and tightens privacy.

## Why this exists

ClawClub members live in multiple places, travel constantly, relocate, and have complex relationships with geography. The platform needs to understand where members are, where they're going, and where they've been. But "understand" cuts two ways and we need to be careful about which way.

The wrong shape: a "match people because they're in the same city" feature. In a 50-member club it's mildly interesting; in a 10,000-member club it's useless flood. Members don't want introductions to the hundreds of other people in Tokyo. They want to know *why* they should meet someone, with location as one of several details that shape *which* introductions happen *when*.

The right shape: **location is a probability multiplier on substantive matches, not a match trigger.** The synchronicity worker still produces matches the same way it does today — based on substance (asks, gifts, profile similarity, shared interests). But when *synchronistic* location overlap exists between a matched pair (a trip about to happen, a host visit, calendar timing), the worker treats that pair as significantly more likely to be worth delivering. Two members with mediocre substantive similarity who happen to be in Tokyo at the same time can outrank two members with high substantive similarity who never overlap geographically. The match wouldn't have happened without the substance, but timing decides which substantive matches actually get surfaced.

This feature gives us:
- A versioned, append-only data layer for member locations (homes and travel plans)
- API actions for members to declare and read location data
- A new lightweight action for live location-overlap lookup (`member.locationContext.get`)
- Synchronicity worker integration that uses *synchronistic* location overlap as a delivery prioritization factor (not permanent geographical overlap, not match triggering)
- Substrate for the future Club Mind reasoning layer to read as part of per-club context

It does **not**:
- Add a new match kind
- Add a new candidate-generation trigger
- Denormalize any location data into signal payloads (which would go stale)
- Boost permanent home × home overlaps (they're geography, not synchronicity)
- Expose another member's archived or historical location data via the API

## The two architectural calls (carried over from v2)

These two decisions were made on the back of the v1 review and remain unchanged.

### Call 1: Location enrichment is read-side, not payload-denormalized

The synchronicity worker does **not** write location data into signal payloads. v1 had `buildSignalPayload` stuffing `locationContext` into the payload at delivery time, which created a staleness problem (cancelled trips persisted in unread signals). v2 and v3 fix this by leaving `buildSignalPayload` untouched and providing a new action — `member.locationContext.get({ otherMemberId, clubId? })` — that the agent calls on demand to fetch live overlap data. Every read goes to live data; staleness is impossible.

### Call 2: Location is a delivery prioritization factor

Owen's words: *"if two people are in the same city, then their probability that we should send a message goes up exponentially. I don't think we can avoid building this properly."* So location influences the worker's behavior, but only at the prioritization phase, not at candidate generation. The combination of Calls 1 and 2 gives us: location data influences the worker's behavior (Call 2) without ever being denormalized into signal payloads (Call 1). Two reads, two purposes, no shared state, no staleness possible.

## Must-hold invariants

These are the cross-cutting truths every change has to respect. Several invariants changed from v2 — the changes are flagged inline.

1. **Location is not a match trigger.** The worker NEVER writes a row to `signal_background_matches` with `match_kind = 'co_location'`. That match kind does not exist. Locations play no role in candidate generation — `processEntityTriggers`, `processProfileTriggers`, `processIntroRecompute`, `processBackstopSweep`, and `processMemberAccessibilityTriggers` never read `member_location_versions`.

2. **Location IS a delivery prioritization factor for synchronistic overlaps.** When `deliverMatches` runs, it computes a location boost factor for each candidate pending match and re-sorts candidates by adjusted score. Pairs with imminent or near-term *synchronistic* overlap can outrank pairs with better raw substantive scores. Permanent home × home overlap does NOT contribute (see invariant 20).

3. **Boost computation is fresh, never stored.** No `location_boost` column on `signal_background_matches`. The boost is recomputed every delivery cycle from `live_member_locations`, against `CURRENT_DATE`. Locations change; cached boosts go stale.

4. **(REVISED in v3.)** **Boost computation runs unconditionally on every delivery cycle when there are any pending matches.** v2 had a "skip when global pool ≤ batch size" optimization that was wrong because per-recipient throttling can make ordering matter even within a small pool. The boost query is a single batched lookup bounded to the candidate pool size (≈60 rows worst case), against indexed tables. The cost is negligible, so it always runs. Owen's "do the work only if it needs to" is satisfied because the work is bounded to the candidate pool, not to total location data — pairs with no locations or no overlap return 1.0 cheaply.

5. **Signal payloads NEVER contain denormalized location data.** Not city, not dates, not overlap kind, not `locationContext`. Payloads remain ID-first.

6. **`buildSignalPayload` is untouched by this feature.** It does not import any location helpers. It does not call any location queries. It does not add any new fields to the payload object.

7. **Append-only versioning.** No row in `member_location_versions` is ever updated. Every change is a new row.

8. **`location_id` is the stable identifier; `id` is the version's primary key.** All API responses surface `locationId` as the stable identifier members use across versions.

9. **Version chain integrity.** All versions in a chain (sharing the same `location_id`) MUST have the same `member_id` and the same `type`. Enforced at the repository layer.

10. **City normalization is consistent across writes and reads.** All inserts compute `city_normalized` using a single normalization function. All matching queries use `city_normalized`, not `city`. The display form `city` is preserved for showing back to members.

11. **Country is required and ISO 3166-1 alpha-2.** The application layer normalizes; the schema enforces format via a CHECK constraint.

12. **Region is optional but uses ISO 3166-2 codes when provided.** Matching is tolerant: if either side has a null region, regions are not compared.

13. **Dates only, no times, no timezones.** The `starts_on` and `ends_on` columns are Postgres `date`. They are calendar dates without timezone information.

14. **Travel requires `ends_on`. Home doesn't.** Enforced by CHECK constraint.

15. **Reads from another member's locations require a shared club.** Same pattern as `profile.get` for another member. Enforced by SQL filter at the repository layer. Returns an empty array (not 403, not 404) when no shared club exists.

16. **Author auth is enforced via SQL filter, not handler check.** Same lesson as gifts/loops invariant 4. SQL author-filter for `update`/`remove`. Returns null at the repo level, 404 at the handler. No dead 403 branches.

17. **(REVISED in v3.)** **All location mutations support `clientKey` for idempotent retries via a chain-scoped unique index.** The schema has TWO unique indexes on `client_key`:
    - `(member_id, client_key) WHERE client_key IS NOT NULL AND version_no = 1` — enforces one chain per (member, key) for create.
    - `(location_id, client_key) WHERE client_key IS NOT NULL` — enforces one version per (chain, key) for update and remove.
    
    The repo logic on `update` and `remove`: if `clientKey` is provided, check for an existing version with `(location_id, client_key)` before inserting. If found and the payload matches, return it. If found and the payload differs, return 409. If not found, insert the new version.

18. **Location notes go through the legality gate.** The `note` field is free text visible to other members in shared clubs, with the same exposure profile as a post body.

19. **(NEW in v3.)** **Other-member location reads return only currently-live, currently-relevant data.** When `member.travel.list` or `member.home.list` is called with `memberId` set to another member, the `includeArchived` and `includePast` flags are forced to `false` at the repository layer regardless of what the caller passes. Historical and archived data is visible only to the location's owner. The synchronicity engine and the future Club Mind reasoning layer can read historical data via direct database queries (they don't go through these member-facing actions), but no member-facing API surface ever exposes another member's cancelled trips, ended homes, or archived versions.

20. **(NEW in v3.)** **`same_home` overlaps don't contribute to the boost factor.** Permanent home × home geography is not synchronicity. The boost SQL excludes pairs where both rows have `type = 'home'`. The agent-facing read helper (`loadLocationOverlap`, used by `member.locationContext.get`) STILL returns `same_home` overlaps so the agent can describe them in introductions ("you both live in Tokyo") — they're appropriate context. They're just not used by the worker to reorder delivery. The boost only fires on:
    - `crossing` (travel × travel) — both members visiting the same place at overlapping times
    - `visiting_their_home` (travel × home) — one visiting where the other lives
    - `they_visit_your_home` (home × travel) — inverse of the above
    
    Plus, of course, the time-based imminent / near tiers within those kinds.

## Decisions and reasoning

These are the choices the design conversation arrived at and why. The implementer should not second-guess them without checking.

- **Location is enrichment of existing matches, not its own match kind (Owen's central design call).** A 10,000-member club where "who's in Tokyo" is surfaced to everyone is useless flood.

- **Location influences delivery ordering for synchronistic overlaps only (Owen's Call 2 + v3 same_home exclusion).** *"If two people are in the same city, then their probability that we should send a message goes up exponentially."* But "in the same city" here means *crossing in synchronistic timing*, not "both happen to live there." Two locals don't experience synchronicity from sharing a city — they experience it from a visit, a trip, a host opportunity. v3 makes this explicit by excluding same_home from the boost.

- **Boost is computed fresh, never stored.** Locations change; cached boosts go stale.

- **Signal payloads stay ID-first (Owen's Call 1).** Read-side fetch via `member.locationContext.get` dissolves the staleness problem.

- **Single-table versioned design (Pattern B), not two-table.** Owen's call. Mirrors `member_global_role_versions`.

- **Eight + one API actions, not unified.** Two parallel groups (`member.travel.*` and `member.home.*`) plus the read-side `member.locationContext.get`.

- **Update creates a new version, even for trivial changes.** Owen's call: append-only model.

- **Remove creates an archive marker version, doesn't delete.** Hard delete is reserved for `member.delete`.

- **Travel and home use different "remove" semantics.** Home removal sets `ends_on` to preserve the historical move-out date.

- **`home.update` accepts `endsOn`** (so members can record "I moved out on date X" without archiving).

- **`home.list` supports `includePast`** so ended homes are observable to the owner. (Other members never see them — see invariant 19.)

- **(NEW in v3.)** **Other-member reads silently restrict `includeArchived` and `includePast`.** v3 addresses a privacy hole in v2 where peers could pull each other's full historical movement data. The API doesn't reject the flags when used on other-member reads — it silently forces them to `false`. This is more permissive than rejection (the agent doesn't have to know which mode it's in) and matches the pattern of "other members see only currently-relevant data" without surfacing the privacy boundary as an error.

- **No quotas in v1.** Locations aren't entities. Add a separate quota mechanism in v2 if abuse appears.

- **Location notes go through the legality gate** for consistency with other free-text fields visible to other members.

- **City normalization is application-layer.** No Postgres `unaccent` extension dependency.

- **No geocoding in v1, but design for it later.** Schema is structured to add a nullable `place_id` column later without breakage.

- **`parseIsoDate` validates strictly via round-trip** to reject impossible dates like "2026-02-30" that `Date.parse` would silently normalize.

- **`clientKey` covers all mutations via two unique indexes.** v2 only protected creates. v3 adds a chain-scoped index that protects updates and removes. Required for retry safety because append-only mutations would otherwise create duplicate version rows under network race.

- **(NEW in v3.)** **Boost computation always runs.** v2's "skip when no global contention" optimization was wrong because per-recipient throttling can make ordering matter even when the global pool is small. v3 always computes; the cost is bounded and small.

- **(NEW in v3.)** **`same_home` excluded from boost.** Permanent geography isn't synchronicity. Owen's "exponentially" framing was about magical timing, not about two members happening to share a permanent address.

## Build order

Don't split Phase 1.

### Phase 1: Schema, enums, and types (atomic)

1. Two new enums: `member_location_type` and `member_location_status`.
2. New table `member_location_versions` with all columns, constraints, and **both clientKey indexes** (the chain-scoped one is new in v3).
3. New views: `current_member_locations` and `live_member_locations`.
4. New TypeScript types in `src/contract.ts`.
5. New zod response shapes in `src/schemas/responses.ts`.
6. New wire/parse helpers in `src/schemas/fields.ts` (including the round-trip-validated `parseIsoDate`).
7. Repository capability declarations in `src/contract.ts`.
8. **Type-check passes.**

### Phase 2: Repository implementation

1. **Normalization helpers** in `src/clubs/locations.ts`.
2. **`createMemberLocation`**: generates a new `location_id`, inserts version 1. `clientKey` idempotency uses the version-1 unique index — same key + same payload returns existing chain; same key + different payload returns 409.
3. **`updateMemberLocation`**: SQL filter by member ownership, computes new version, inserts. **`clientKey` idempotency uses the chain-scoped unique index** — if a version with `(location_id, client_key)` already exists and the payload matches, return it; if it exists and the payload differs, throw 409. Returns null on not-found-or-not-owned.
4. **`archiveMemberLocation`**: same pattern with chain-scoped clientKey support. Sets `status = 'archived'`. For homes, sets `ends_on = COALESCE(provided_endedOn, CURRENT_DATE)` if currently null.
5. **`listMemberLocations`**: reads from `live_member_locations` (or `current_member_locations` if `includeArchived`). **(REVISED in v3.)** When `actorMemberId !== targetMemberId`, force `includeArchived = false` and `includePast = false` regardless of caller input. For other-member reads, joins through `accessible_club_memberships` to verify shared club. Returns empty array if no shared club.
6. **`loadLocationOverlap(memberAId, memberBId)`**: the read-side helper used by `member.locationContext.get`. Returns up to 5 overlap entries sorted by upcoming start date. **Includes same_home overlaps.** Each entry has the derived `overlapKind` field.
7. **`loadLocationBoostBatch(input)`**: the worker prioritization helper. **Excludes same_home overlaps** from the computation. Takes a list of `(matchId, sourceMemberId, targetMemberId)` tuples. Returns a `Map<matchId, number>` where each entry is the boost factor for that match. The boost SQL is in the file-by-file section below — **read it carefully**, the v2 SQL was wrong.

Boost factor logic:
- If any synchronistic (non-same-home) overlap window starts within `SYNCHRONICITY_LOCATION_IMMINENT_DAYS` of today (default 14): boost = `SYNCHRONICITY_LOCATION_IMMINENT_BOOST` (default 0.3)
- Else if any synchronistic overlap starts within `SYNCHRONICITY_LOCATION_NEAR_DAYS` (default 90): boost = `SYNCHRONICITY_LOCATION_NEAR_BOOST` (default 0.6)
- Else: 1.0

Lower is better in this codebase (cosine distance), so 0.3 multiplier is the strong "exponential" boost Owen wanted.

### Phase 3: API actions

Nine actions in a new module `src/schemas/locations.ts`.

1. `member.travel.add` — auth: member; safety: mutating; quality gate: location-note; takes `{ city, country, region?, startsOn, endsOn, note?, clientKey? }`; returns `{ location: memberLocation }`.
2. `member.travel.update` — auth: member; safety: mutating; gate: location-note; takes `{ locationId, city?, country?, region?, startsOn?, endsOn?, note?, clientKey? }`; returns `{ location: memberLocation }`.
3. `member.travel.remove` — auth: member; safety: mutating; takes `{ locationId, clientKey? }`; returns `{ location: memberLocation }`.
4. `member.travel.list` — auth: member; safety: read_only; takes `{ memberId?, includePast?, includeArchived? }`; returns `{ locations: memberLocation[] }`. **`includePast` and `includeArchived` are silently restricted to self-reads in the repo.**
5. `member.home.add` — auth: member; safety: mutating; gate: location-note; takes `{ city, country, region?, startsOn?, note?, clientKey? }`; returns `{ location: memberLocation }`.
6. `member.home.update` — auth: member; safety: mutating; gate: location-note; takes `{ locationId, city?, country?, region?, startsOn?, endsOn?, note?, clientKey? }`; returns `{ location: memberLocation }`.
7. `member.home.remove` — auth: member; safety: mutating; takes `{ locationId, endedOn?, clientKey? }`; returns `{ location: memberLocation }`.
8. `member.home.list` — auth: member; safety: read_only; takes `{ memberId?, includePast?, includeArchived? }`; returns `{ locations: memberLocation[] }`. **Same self-read restriction.**
9. **`member.locationContext.get`** — auth: member; safety: read_only; takes `{ otherMemberId, clubId? }`; returns `{ overlaps: locationOverlap[] }`. Calls `loadLocationOverlap`. Returns at most 5 overlaps sorted by upcoming start date. **Includes same_home overlaps** (the agent uses them as context). Empty array if no shared club or no overlap.

Validation rules at the parse layer (unchanged from v2):
- `startsOn` and `endsOn` round-trip via `parseIsoDate`
- `country` normalized to uppercase, validated against `^[A-Z]{2}$`
- `city` trimmed, length-bounded (max 200 chars), non-empty after trim
- `region` optional, trimmed, uppercased, length-bounded (max 10 chars)
- `note` optional, trimmed, length-bounded (max 1000 chars)
- `member.travel.add` requires both `startsOn` and `endsOn`

Auth pattern: SQL filters return null when not owned; handlers return 404. No 403 branches.

### Phase 4: Worker prioritization integration

This is the entire worker change.

1. **No changes to candidate generation paths.** `processEntityTriggers`, `processProfileTriggers`, `processIntroRecompute`, `processBackstopSweep`, `processMemberAccessibilityTriggers` — none touch locations.

2. **No changes to `buildSignalPayload`.** Payloads remain ID-first. No `locationContext` field. The function does not import any location helpers.

3. **Modify `deliverMatches`** (currently around line 540 of `src/workers/synchronicity.ts`):
   - Read a candidate pool 3x larger than `DELIVERY_BATCH_SIZE` (still bounded for sanity).
   - **(REVISED in v3.)** Always compute boosts when there are any candidates. No skip-when-no-contention check — the cost is small and per-recipient throttling makes the ordering meaningful even when global contention is absent.
   - Resolve source members for entity-source match kinds via a single batch entity lookup (`source_id` is already a member ID for `member_to_member`; for `ask_to_member` / `offer_to_ask` / `event_to_member` it's an entity ID and the source member is the entity author).
   - Call `loadLocationBoostBatch` once with the resolved candidate list to get a boost factor map.
   - Compute adjusted score = `raw_score * boost_factor` for each candidate.
   - Re-sort by adjusted score (ascending — lower is better in this codebase).
   - Take the top `DELIVERY_BATCH_SIZE` after re-sort.
   - Pass each to `deliverOneMatch` exactly as today.

4. The `deliverOneMatch` function itself is unchanged. Throttling, freshness, validity, and payload assembly all work as today. Only the *order* of pickup changed when there's anything to prioritize.

5. **No changes to `signal_background_matches` schema.** No `location_boost` column. Boosts are not persisted.

6. New env vars (with defaults):
   - `SYNCHRONICITY_LOCATION_IMMINENT_DAYS` = 14
   - `SYNCHRONICITY_LOCATION_NEAR_DAYS` = 90
   - `SYNCHRONICITY_LOCATION_IMMINENT_BOOST` = 0.3
   - `SYNCHRONICITY_LOCATION_NEAR_BOOST` = 0.6

### Phase 5: Quota, dispatch, snapshot, schemas

1. **Dispatch import.** Add `import './schemas/locations.ts';` to `src/dispatch.ts` (around line 48).
2. **Quota.** No change to `QUOTA_ENTITY_KINDS`. Locations are not entities.
3. **Schema snapshot.** Regenerate if the project has a checked-in API schema artifact.
4. **Superadmin schema.** Verify no changes needed.
5. **Contract `Repository` capability list.** Add the six new capability methods.
6. **Quality gate registration.** Add a new gate name `location-note` (or reuse an existing one) for the location actions that include free-text notes.

### Phase 6: Tests

Tests are written **to the must-hold invariants**.

**`test/integration/locations.test.ts` (new file)** — covers data layer, CRUD, and the privacy boundary:

- Travel add round-trip; field validation; empty city / invalid country / missing endsOn rejected.
- Home add with no startsOn; ongoing home (ends_on null) listed back correctly.
- Update creates a new version; raw `member_location_versions` table has 2 rows; `version_no` is 2; `supersedes_location_version_id` correct.
- Update preserves `locationId`.
- Update cannot change `member_id` or `type` (repo rejects).
- Trivial update (note text change) still creates a new version row (invariant 7 / append-only).
- `home.update` accepts `endsOn` and creates a new version reflecting the change.
- Remove creates archive marker; chain has one more version; latest version has `status = 'archived'`; `live_member_locations` no longer returns the chain.
- Home remove sets `ends_on` to provided date or `CURRENT_DATE`; historical chain preserved.
- `home.list` for self with `includePast: true` returns ended homes.
- List defaults exclude past travel; `includePast: true` includes them — for self-reads only.
- **(NEW in v3.)** Privacy regression: list of another member's locations with `includeArchived: true` returns ONLY currently-active rows. Archived rows do not appear regardless of the flag.
- **(NEW in v3.)** Privacy regression: list of another member's locations with `includePast: true` does NOT return ended homes or past trips. Past data does not appear regardless of the flag.
- **(NEW in v3.)** Privacy regression: setup creates a member with two cancelled trips and an ended home; another member in the same club queries with maximum permissive flags; verify the response contains zero historical entries.
- List of another member's locations requires shared club; returns empty array if no shared club (not 403, not 404).
- City normalization: "Tokyo" / "tokyo" / "TOKYO" produce different displays but same `city_normalized`.
- Diacritic normalization: "São Paulo" and "Sao Paulo" produce same `city_normalized`.
- Country normalization: "gb" → "GB" accepted; "United Kingdom" rejected with clear error.
- Region disambiguation: two Springfields in different US states are distinct in matching.
- Region tolerance: a location with `region` set and one without DO match each other.
- **(NEW in v3.)** `clientKey` chain-scoped idempotency: retrying `member.travel.update` with the same `clientKey` and same payload returns the existing version, no duplicate row created. Verify by counting rows in `member_location_versions` for that chain before and after the retry.
- **(NEW in v3.)** `clientKey` chain-scoped 409: retrying `member.travel.update` with the same `clientKey` and a *different* payload returns 409 client_key_conflict.
- **(NEW in v3.)** `clientKey` retry safety on `remove`: same key + same intent returns existing archive version, no duplicate.
- `clientKey` create idempotency: same key + same payload at create time returns existing chain.
- `parseIsoDate` rejects "2026-02-30" (the impossible-date round-trip test).
- Location note goes through legality gate; rejected for illegal content.

**`test/integration/synchronicity-locations.test.ts` (new file)** — covers worker prioritization, the new action, and the boost SQL:

- `member.locationContext.get` returns overlap data when two members have overlapping locations in shared club.
- `member.locationContext.get` returns empty array when no overlap exists.
- `member.locationContext.get` requires shared club; returns empty array otherwise.
- `member.locationContext.get` derives correct `overlapKind` for all four cases (`crossing`, `visiting_their_home`, `they_visit_your_home`, `same_home`).
- `member.locationContext.get` is bounded to 5 overlaps.
- **(NEW in v3.)** `member.locationContext.get` returns same_home overlaps (verifies the agent-facing helper does NOT exclude them).
- Worker prioritization: with two pending matches of similar substantive score, the one with imminent location overlap is delivered first.
- Worker prioritization: a pair with mediocre score and imminent overlap can outrank a pair with better score and no overlap (the "exponential boost" test).
- **(NEW in v3.)** **same_home boost regression**: two members both have permanent home in Lisbon (same_home overlap). They have a pending substantive match. A second pending match between two other members has slightly better substantive score and no location overlap. Verify the second match is delivered first, NOT the same_home pair. This proves same_home doesn't fire the boost.
- **(NEW in v3.)** **Boost SQL window correctness**: member A has an ongoing home in Tokyo. Member B has a travel plan to Tokyo 80 days in the future. Verify the boost is the "near" tier (0.6), not the "imminent" tier (0.3). v2's SQL would have wrongly applied the imminent boost because it derived imminence from member A's home start (in the past) rather than the actual overlap window (80 days out).
- **(NEW in v3.)** **Boost computation always runs**: configure a small candidate pool that's well below `DELIVERY_BATCH_SIZE`. Verify the boost batch helper is still called (via spy/log). The "skip when no contention" optimization that was in v2 is gone.
- **(NEW in v3.)** **Per-recipient contention**: 3 candidate matches, all targeting the same member, well below batch size. Verify boost ordering still affects which one delivers first under per-recipient throttling.
- Locations don't generate new matches: adding a travel plan does not produce any new rows in `signal_background_matches` (invariant 1).
- Boost computation handles members with no locations: returns 1.0 cheaply.
- Signal payloads do not contain `locationContext` (invariant 5/6 — payload-level regression test).

## File-by-file changes

### `db/init.sql`

Add the enums in the type definitions section (around line 50-70):

```sql
-- Locations
CREATE TYPE member_location_type   AS ENUM ('home', 'travel');
CREATE TYPE member_location_status AS ENUM ('active', 'archived');
```

Add the table near `member_global_role_versions` (around line 130-180):

```sql
CREATE TABLE member_location_versions (
    id                              short_id DEFAULT new_id() NOT NULL,
    location_id                     short_id NOT NULL,
    member_id                       short_id NOT NULL,
    type                            member_location_type NOT NULL,

    -- Place
    city                            text NOT NULL,
    city_normalized                 text NOT NULL,
    country                         text NOT NULL,
    region                          text,

    -- Time (calendar dates, no timezone, no time component)
    starts_on                       date,
    ends_on                         date,

    -- Optional content
    note                            text,

    -- Idempotency for retries
    client_key                      text,

    -- Version chain
    version_no                      integer NOT NULL,
    supersedes_location_version_id  short_id,

    -- Lifecycle
    status                          member_location_status NOT NULL DEFAULT 'active',

    -- Audit
    created_at                      timestamptz DEFAULT now() NOT NULL,
    created_by_member_id            short_id NOT NULL,

    CONSTRAINT member_location_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_location_versions_chain_version_unique UNIQUE (location_id, version_no),
    CONSTRAINT member_location_versions_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_location_versions_creator_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id),
    CONSTRAINT member_location_versions_supersedes_fkey FOREIGN KEY (supersedes_location_version_id) REFERENCES member_location_versions(id),
    CONSTRAINT member_location_versions_travel_dates_check CHECK (
        type <> 'travel' OR ends_on IS NOT NULL
    ),
    CONSTRAINT member_location_versions_date_order_check CHECK (
        starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on
    ),
    CONSTRAINT member_location_versions_country_format_check CHECK (
        country ~ '^[A-Z]{2}$'
    ),
    CONSTRAINT member_location_versions_city_nonempty_check CHECK (
        length(btrim(city)) > 0 AND length(btrim(city_normalized)) > 0
    )
);

-- Idempotency: create-time uniqueness on (member_id, client_key) for version 1
CREATE UNIQUE INDEX member_location_versions_create_idempotent_idx
    ON member_location_versions (member_id, client_key)
    WHERE client_key IS NOT NULL AND version_no = 1;

-- v3: Idempotency for update/remove via chain-scoped uniqueness on (location_id, client_key)
CREATE UNIQUE INDEX member_location_versions_chain_idempotent_idx
    ON member_location_versions (location_id, client_key)
    WHERE client_key IS NOT NULL;

CREATE INDEX member_location_versions_member_idx
    ON member_location_versions (member_id, location_id);
CREATE INDEX member_location_versions_chain_version_idx
    ON member_location_versions (location_id, version_no DESC);
CREATE INDEX member_location_versions_place_idx
    ON member_location_versions (city_normalized, country);
CREATE INDEX member_location_versions_dates_idx
    ON member_location_versions (starts_on, ends_on);
```

Add the views in the views section (alongside `live_entities`):

```sql
-- ── Member locations ──────────────────────────────────────

CREATE VIEW current_member_locations AS
    SELECT DISTINCT ON (location_id) *
    FROM member_location_versions
    ORDER BY location_id, version_no DESC, created_at DESC;

CREATE VIEW live_member_locations AS
    SELECT * FROM current_member_locations WHERE status = 'active';
```

### `src/contract.ts`

Same type definitions as v2. The `clientKey` field on `UpdateMemberLocationInput` and `ArchiveMemberLocationInput` is unchanged in shape — what changes is how the repo enforces it.

### `src/schemas/responses.ts`

Same as v2.

### `src/schemas/fields.ts`

Same as v2 (including the round-trip-validated `parseIsoDate`).

### `src/clubs/locations.ts` (new file)

The repository implementation. Changes from v2:

**`updateMemberLocation` and `archiveMemberLocation` get chain-scoped clientKey idempotency:**

```typescript
async function updateMemberLocation(
  pool: Pool,
  input: UpdateMemberLocationInput,
): Promise<MemberLocation | null> {
  return withTransaction(pool, async (client) => {
    // 1. Read current live version of the chain, verify ownership
    const current = await client.query<...>(
      `SELECT id, version_no, member_id, type, city, country, region, starts_on, ends_on, note
       FROM live_member_locations
       WHERE location_id = $1 AND member_id = $2`,
      [input.locationId, input.actorMemberId],
    );
    if (!current.rows[0]) return null;
    const currentRow = current.rows[0];

    // 2. (NEW in v3) clientKey chain-scoped idempotency
    if (input.clientKey) {
      const existing = await client.query<...>(
        `SELECT * FROM member_location_versions
         WHERE location_id = $1 AND client_key = $2`,
        [input.locationId, input.clientKey],
      );
      if (existing.rows[0]) {
        const existingRow = existing.rows[0];
        // Verify payload matches
        if (payloadsMatch(currentRow, input.patch, existingRow)) {
          return mapLocationRow(existingRow);
        }
        throw new AppError(409, 'client_key_conflict',
          'clientKey was already used on this location with a different payload');
      }
    }

    // 3. Compute and insert the new version (existing logic)
    // ...
  });
}
```

The `archiveMemberLocation` follows the same pattern.

**`listMemberLocations` enforces the v3 privacy invariant:**

```typescript
async function listMemberLocations(
  pool: Pool,
  input: ListMemberLocationsInput,
): Promise<MemberLocation[]> {
  // (NEW in v3) Force archived/past flags off for other-member reads
  const isSelfRead = input.actorMemberId === input.targetMemberId;
  const includeArchived = isSelfRead && (input.includeArchived ?? false);
  const includePast = isSelfRead && (input.includePast ?? false);

  // Choose view based on includeArchived
  const view = includeArchived ? 'current_member_locations' : 'live_member_locations';

  // Build the query with member access filter and includePast filter
  const result = await pool.query<...>(
    `SELECT * FROM ${view}
     WHERE member_id = $1
       AND ($2::text IS NULL OR type = $2::member_location_type)
       AND (
         $1 = $3                                              -- self-read: any member_id allowed
         OR EXISTS (                                          -- other-member: shared club
           SELECT 1 FROM club_memberships cm1
           JOIN club_memberships cm2 ON cm1.club_id = cm2.club_id
           WHERE cm1.member_id = $1
             AND cm2.member_id = $3
             AND cm1.status = 'active'
             AND cm2.status = 'active'
         )
       )
       AND ($4::boolean OR ends_on IS NULL OR ends_on >= CURRENT_DATE)
     ORDER BY type, starts_on DESC NULLS LAST`,
    [input.targetMemberId, input.type ?? null, input.actorMemberId, includePast],
  );

  return result.rows.map(mapLocationRow);
}
```

Note that `includeArchived` and `includePast` were forced to false BEFORE the SQL ran, so the SQL faithfully applies the active/current filters when called for another member, regardless of what the caller passed.

**`loadLocationOverlap` (single-pair, agent-facing) — includes same_home:**

```sql
SELECT
  s.city, s.country, s.region,
  s.type AS source_type,
  t.type AS target_type,
  GREATEST(
    COALESCE(s.starts_on, '-infinity'::date),
    COALESCE(t.starts_on, '-infinity'::date),
    CURRENT_DATE
  ) AS overlap_starts_on,
  LEAST(
    COALESCE(s.ends_on, 'infinity'::date),
    COALESCE(t.ends_on, 'infinity'::date)
  ) AS overlap_ends_on
FROM live_member_locations s
JOIN live_member_locations t
  ON s.city_normalized = t.city_normalized
 AND s.country = t.country
 AND (s.region IS NULL OR t.region IS NULL OR s.region = t.region)
WHERE s.member_id = $1
  AND t.member_id = $2
  -- date overlap exists
  AND COALESCE(s.starts_on, '-infinity'::date) <= COALESCE(t.ends_on, 'infinity'::date)
  AND COALESCE(s.ends_on, 'infinity'::date) >= COALESCE(t.starts_on, '-infinity'::date)
  -- overlap extends into the future or is currently active
  AND COALESCE(s.ends_on, 'infinity'::date) >= CURRENT_DATE
  AND COALESCE(t.ends_on, 'infinity'::date) >= CURRENT_DATE
  -- (NOTE: no exclusion of same_home here — agent uses same_home as context)
ORDER BY overlap_starts_on ASC
LIMIT 5
```

Then derive `overlapKind` in TypeScript:

```typescript
function deriveOverlapKind(source: MemberLocationType, target: MemberLocationType): LocationOverlapKind {
  if (source === 'travel' && target === 'travel') return 'crossing';
  if (source === 'travel' && target === 'home') return 'visiting_their_home';
  if (source === 'home' && target === 'travel') return 'they_visit_your_home';
  return 'same_home';
}
```

**`loadLocationBoostBatch` (worker-facing) — corrected SQL with same_home exclusion:**

```sql
WITH match_pairs AS (
  SELECT * FROM unnest(
    $1::text[],  -- match_ids
    $2::text[],  -- source_member_ids
    $3::text[]   -- target_member_ids
  ) AS t(match_id, source_id, target_id)
),
pair_overlaps AS (
  -- Compute the actual overlap window for each match pair, clamped to today
  SELECT
    mp.match_id,
    GREATEST(
      COALESCE(s.starts_on, '-infinity'::date),
      COALESCE(t.starts_on, '-infinity'::date),
      CURRENT_DATE
    ) AS overlap_starts,
    LEAST(
      COALESCE(s.ends_on, 'infinity'::date),
      COALESCE(t.ends_on, 'infinity'::date)
    ) AS overlap_ends
  FROM match_pairs mp
  JOIN live_member_locations s ON s.member_id = mp.source_id
  JOIN live_member_locations t ON t.member_id = mp.target_id
   AND t.city_normalized = s.city_normalized
   AND t.country = s.country
   AND (t.region IS NULL OR s.region IS NULL OR t.region = s.region)
  WHERE
    -- date overlap exists
    COALESCE(s.starts_on, '-infinity'::date) <= COALESCE(t.ends_on, 'infinity'::date)
    AND COALESCE(s.ends_on, 'infinity'::date) >= COALESCE(t.starts_on, '-infinity'::date)
    -- overlap extends into the future or is currently active
    AND COALESCE(s.ends_on, 'infinity'::date) >= CURRENT_DATE
    AND COALESCE(t.ends_on, 'infinity'::date) >= CURRENT_DATE
    -- (v3) exclude same_home overlaps from boost computation
    AND NOT (s.type = 'home' AND t.type = 'home')
),
boost_per_match AS (
  SELECT
    match_id,
    -- Use the SOONEST overlap start to determine tier
    -- (overlap_starts is already clamped to CURRENT_DATE for currently-active overlaps)
    CASE
      WHEN MIN(overlap_starts) <= (CURRENT_DATE + ($4 || ' days')::interval)::date THEN $6::float  -- imminent boost
      WHEN MIN(overlap_starts) <= (CURRENT_DATE + ($5 || ' days')::interval)::date THEN $7::float  -- near boost
      ELSE 1.0::float
    END AS boost
  FROM pair_overlaps
  GROUP BY match_id
)
SELECT
  mp.match_id,
  COALESCE(bpm.boost, 1.0::float) AS boost
FROM match_pairs mp
LEFT JOIN boost_per_match bpm ON bpm.match_id = mp.match_id
```

**Why this is correct:** The `pair_overlaps` CTE computes the actual overlap window between source and target locations, clamped to `CURRENT_DATE` for already-active overlaps. The `MIN(overlap_starts)` in `boost_per_match` finds the soonest synchronistic overlap window for the pair (across all matching location pairs, since members can have multiple homes/trips). The imminent/near tier check uses that soonest overlap start, not the source row's start date — so an ongoing home overlapping with travel 80 days out correctly produces `overlap_starts = today + 80` and falls into the `near` tier. The `NOT (s.type = 'home' AND t.type = 'home')` filter ensures permanent home × home overlaps don't contribute.

### `src/schemas/locations.ts` (new file)

Same nine actions as v2. Register at the bottom.

### `src/dispatch.ts`

Add `import './schemas/locations.ts';` to the import block.

### `src/postgres.ts`

The Postgres-backed repository implementation needs the six new methods, each delegating to functions in `src/clubs/locations.ts`.

### `src/workers/synchronicity.ts`

Three changes in `deliverMatches`:

1. **Read a 3x candidate pool.** Change `LIMIT $1` from `DELIVERY_BATCH_SIZE` to `DELIVERY_BATCH_SIZE * 3`.

2. **(REVISED in v3.) Always compute boosts when there are candidates.** No skip-when-no-contention check. The cost is bounded by the candidate pool size and is small.

3. **Compute boosts and re-sort.** Resolve source members for entity-source kinds via batch entity lookup, call `loadLocationBoostBatch`, multiply each candidate's score by its boost, re-sort, take top `DELIVERY_BATCH_SIZE`, pass each to `deliverOneMatch`.

```typescript
async function deliverMatches(pools: WorkerPools): Promise<number> {
  await expireStaleMatches(pools.db);

  const candidateResult = await pools.db.query<{
    id: string; match_kind: string; source_id: string; target_member_id: string; score: number;
  }>(
    `select id, match_kind, source_id, target_member_id, score
     from signal_background_matches
     where state = 'pending'
       and (expires_at is null or expires_at > now())
     order by score asc, created_at asc
     limit $1`,
    [DELIVERY_BATCH_SIZE * 3],
  );
  if (candidateResult.rows.length === 0) return 0;

  // (REVISED in v3) Always compute boosts. The cost is bounded and per-recipient
  // throttling makes ordering matter even when global pool is small.
  const resolved = await resolveSourceMembers(pools.db, candidateResult.rows);
  const boosts = await loadLocationBoostBatch(pools.db, resolved.map(r => ({
    matchId: r.id,
    sourceMemberId: r.sourceMemberId,
    targetMemberId: r.target_member_id,
  })));

  const adjusted = candidateResult.rows.map(row => ({
    ...row,
    adjustedScore: row.score * (boosts.get(row.id) ?? 1.0),
  }));
  adjusted.sort((a, b) => a.adjustedScore - b.adjustedScore);
  const toDeliver = adjusted.slice(0, DELIVERY_BATCH_SIZE);

  let delivered = 0;
  for (const candidate of toDeliver) {
    const result = await deliverOneMatch(pools, candidate.id);
    if (result === 'delivered') delivered++;
  }
  return delivered;
}
```

`resolveSourceMembers` is a small helper that takes the candidate rows and returns one entry per row with the source member ID resolved (entity author lookup for `ask_to_member` / `offer_to_ask` / `event_to_member`; direct from `source_id` for `member_to_member`).

**`buildSignalPayload` is unchanged.** No location data in the payload.

### `db/seeds/dev.sql`

Optional: add seeded location rows for the test members so the dev server immediately demonstrates the feature. Include at least one same_home pair and one travel-crossing pair so the boost tests have data to work against.

### `test/integration/locations.test.ts` (new file)

See Phase 6 for the test list.

### `test/integration/synchronicity-locations.test.ts` (new file)

See Phase 6 for the test list. The new v3 tests are flagged inline.

### `test/integration/smoke.test.ts`

Update assertions if they reference the action list or schema snapshot.

## SKILL.md updates

Applied separately by Claude (the conversational agent), not the implementing agent. Drafted here for review.

### 1. Add to the available actions list

Insert a new action group after the **Profile** group:

```
**Locations**
- `member.travel.add` — declare an upcoming trip (city, country, dates, optional note)
- `member.travel.update` — update the details of a planned trip
- `member.travel.remove` — cancel or archive a trip
- `member.travel.list` — list your own (or another member's) travel plans in shared clubs
- `member.home.add` — declare a home base (members can have multiple)
- `member.home.update` — update the details of a home (city, dates, etc.)
- `member.home.remove` — mark a home as ended (for moves), preserving history
- `member.home.list` — list your own (or another member's) home bases in shared clubs
- `member.locationContext.get` — fetch live location overlap with another specific member, used to enrich introduction messages
```

### 2. Insert "Locations: homes and travel" subsection in `## Interaction patterns`

```markdown
### Locations: homes and travel

ClawClub supports two kinds of location data: **homes** (where members live, possibly multiple) and **travel** (upcoming trips with dates). Both are stored as versioned, append-only history — when a member moves house or updates a trip, the old version is preserved as history rather than deleted.

**Location is enrichment, not a reason to introduce people.** The synchronicity engine never matches people *because* they live in the same city or are visiting the same place. Substantive matching (asks, gifts, profile similarity) is what creates introductions. But synchronistic location overlap — a trip about to happen, a host visit, calendar timing — *does* affect which substantive matches get prioritized for delivery. Two people with mediocre substance and imminent shared travel can outrank two people with better substance and no overlap. Permanent shared geography (both members live in Tokyo) does NOT trigger this boost — that's geography, not synchronicity.

When a member mentions they're traveling somewhere, or they live in a particular city, or they're moving — capture that as a location row. Don't ask members for location data unprompted; collect it when it comes up naturally.

**City normalization.** Always pass cities in their canonical English title-case form ("Tokyo", not "tokyo" or "TOKYO"). Always pass `country` as the ISO 3166-1 alpha-2 code ("GB" not "United Kingdom", "US" not "USA", "JP" not "Japan"). For ambiguous cities (Springfield in 20+ US states, Athens in Greece vs Georgia, Paris in France vs Texas), pass `region` as the ISO 3166-2 code when known ("US-IL" for Springfield, Illinois). The server normalizes for matching but preserves your input as the display form.

**Dates only, no times.** Travel plans use `startsOn` and `endsOn` as ISO dates (YYYY-MM-DD). Don't pass timestamps or timezones. *"April 14–18 in Tokyo"* means those four calendar days, full stop.

**Travel must have an end date.** If a member says "I'm going to Tokyo for a few weeks, not sure when I'll leave," ask for an estimate and tell them they can update it later. If a trip really has no end date, that's a home, not a trip.

**Home `startsOn` is optional.** If a member doesn't remember when they moved in, leave it null.

**Removing vs ending homes.** When a member moves house, use `member.home.remove` with `endedOn` set to the move date. This preserves the historical record ("Owen lived in London until April 2024") which is valuable context for the synchronicity engine. Don't try to "delete" the old home — there's no such operation. Removal always preserves history.

**Privacy of historical data.** When you call `member.travel.list` or `member.home.list` for ANOTHER member, you only see their currently-active locations. Their cancelled trips, ended homes, and archived versions are not visible to you regardless of any flags. This is enforced by the server. When you list YOUR OWN locations, `includePast: true` and `includeArchived: true` work as expected — you can see your own full history.
```

### 3. Insert "Surfacing matches with location context" subsection in `## Interaction patterns`

```markdown
### Surfacing matches with location context

When you receive a match signal from `updates.list` (an introduction, an ask match, an offer match) and you're about to surface it to the member, consider whether to enrich it with location context.

The signal payload itself does NOT contain location data. To get current location overlap, call `member.locationContext.get({ otherMemberId: <the matched member> })`. This returns up to 5 overlap entries with city, dates, and an `overlapKind`:

- `crossing` — both members will be traveling to the same place at overlapping times
- `visiting_their_home` — the matched member lives in a city you'll be visiting
- `they_visit_your_home` — the matched member will be visiting your home city
- `same_home` — you both live in the same place

Use this context to enrich the introduction message. For `crossing` overlap in Tokyo April 14–18: *"Maria looks like a strong biotech connection — she has experience with X. And you'll both be in Tokyo April 14–18, in case you want to meet in person."* For `same_home` overlap in Lisbon: *"And you both live in Lisbon — you might already cross paths."* The framing should always lead with substance and use location as context.

**You don't have to call `member.locationContext.get` for every match.** Only call it when you're actually going to surface the match to the member and want to weave location into the message.

**The synchronicity engine already prioritizes synchronistic-overlap matches for delivery.** When a match arrives in your update feed, the engine has already weighted it by location overlap (among other factors) in the delivery decision — *but only for synchronistic overlap kinds (crossing, visiting_their_home, they_visit_your_home), not for permanent same_home overlap*. The fact that you're seeing a match doesn't necessarily mean there's location overlap — look up the context separately if you want to mention it.
```

### 4. Update `## What exists in the system`

Add to the primitives line (around line 234):

> Primitives: member, club (`clubId`), membership, entity (post/opportunity/service/ask/gift), event, admission, message thread, message, update, vouch, **member location (home or travel)**.

## Out of scope

- **No `co_location` match kind.** Location is enrichment, not a primary match.
- **No location data in signal payloads.** Read-side fetch via `member.locationContext.get`.
- **No location-based search across the platform.** No `location.search` or `members.findInCity`.
- **No geocoding.** Agent-side normalization via SKILL.md guidance.
- **No address-level data.** City, country, optional region only.
- **No real-time location tracking.**
- **No quotas on location actions in v1.**
- **No recurring travel.** Discrete trips only.
- **No multi-stop trips as a single object.** A London → Paris → Berlin trip is three location rows.
- **No automatic timezone awareness.** Dates are calendar dates without timezone.
- **No backfill of location prioritization for existing pending matches.** Only delivery cycles after deploy use the prioritization.
- **No peer access to historical location data.** Other members never see archived or past locations regardless of flags.
- **No same_home boost.** Permanent shared geography doesn't fire the synchronicity boost; it's still surfaced to the agent as context, just not used to reorder delivery.

## Open questions for the implementer

1. **`country` validation: regex vs hardcoded ISO list.** Plan uses CHECK constraint `country ~ '^[A-Z]{2}$'` which accepts any two uppercase letters including invalid ones. Tighter would be a CHECK against the full ISO list. Agent normalization is the practical defense; regex is sanity. **Leave as-is** unless implementer feels strongly.

2. **Boost factor tuning.** Default values are guesses. Real values come from watching the worker in production with seeded data. The implementer should not block on tuning these; they're env-vars and changeable.

3. **Resolving entity-source kinds in the boost computation.** The plan says one batch entity lookup before computing boosts. The implementer might prefer to do this resolution inside the boost SQL itself by joining `signal_background_matches` to `entities` with a CASE on `match_kind`. Either approach is fine; pick whichever is cleaner.

4. **Concurrency.** If two delivery workers run concurrently, they might compute boosts on overlapping candidate pools and race on `deliverOneMatch`. This already happens with the current design (the per-recipient advisory lock in `deliverOneMatch` serializes per-member). The boost computation doesn't introduce new race conditions because it's read-only and the actual delivery decision is locked. Confirm during implementation.

5. **Test data for the worker prioritization tests.** The "exponential boost" test, the "same_home doesn't boost" test, and the "v2 SQL bug regression" test all need carefully constructed setups. Use `TestHarness` and existing match-test patterns.

---

The next features in the queue after this lands are `member.tell()` (the directional nudge to the synchronicity engine) and the Club Mind reasoning layer v0. Both will benefit from having location data as substrate, and the reasoning layer in particular will read `live_member_locations` directly as part of per-club context. The data model is designed to support that integration without further schema changes.
