# Locations as Synchronicity Enrichment — Implementation Plan

This plan adds **member locations** (homes and travel plans) to ClawClub. It is the result of a long design conversation that went through several wrong turns before arriving at the right framing. Read the **Why this exists** and **Must-hold invariants** sections first — they explain the central design call that shapes everything else.

This is a v1 implementation plan ready for handoff. It mirrors the format of `docs/gifts_and_open_loops_implementation_plan.md` and incorporates every cross-cutting lesson from that feature's review (must-hold invariants, blast radius, build order discipline, append-only versioning).

## Why this exists

ClawClub members live in multiple places, travel constantly, relocate, and have complex relationships with geography. Today the platform has no concept of where members are or where they're going. We want to fix that, but **not** by building a "match people because they're in the same city" feature.

The central design call, made during the design conversation:

> **Location is not a matching primitive. It is enrichment data.**

The synchronicity engine does **not** generate "co-location" matches. Members are matched on substance — what they offer, what they need, what they're working on, what they have in common. Location is then attached to those matches as additional context that makes the introduction more actionable. *"Maria looks like a strong biotech connection — and you'll both be in Tokyo April 14–18"* is a much better signal than either *"you're both in Tokyo"* (which means nothing in a 50-member club and is noise in a 10,000-member club) or *"Maria looks like a strong biotech connection"* alone.

The 10,000-member-club thought experiment is what made this clear. In a small club, "who lives in Tokyo" is mildly interesting. In a big club, hundreds of members live in Tokyo and surfacing them all is useless flood. What members want is *why* they should meet someone, with location as one of several enriching details, not as the reason itself.

This feature gives us:
- A versioned, append-only data layer for member locations (homes and travel plans)
- API actions for members to declare and read location data
- Synchronicity worker integration that attaches location overlap to existing match payloads as enrichment
- Substrate for the future Club Mind reasoning layer to read as part of per-club context

It does **not** add a new match kind, a new worker trigger, or any "find people in the same city" surface area.

## Must-hold invariants

These are the cross-cutting truths every change has to respect. They're written here so the implementer can satisfy them by design, not discover them by failing tests.

1. **Location is enrichment, not a match trigger.** The synchronicity worker NEVER writes a row to `signal_background_matches` with `match_kind = 'co_location'` (or any equivalent location-only match kind). That match kind does not exist in this design. Locations are read by the worker only during signal payload assembly, and only attached as additional context to matches that already exist for substantive reasons.

2. **Append-only versioning.** No row in `member_location_versions` is ever updated. Every change — creating a location, editing a location, removing a location — is a new row in the table. The current state of any logical location is computed by selecting the highest `version_no` for that `location_id`. The codebase pattern to mirror is `member_global_role_versions` (single table, snapshot per version), not `entities` + `entity_versions` (two tables).

3. **`location_id` is the stable identifier; `id` is the version's primary key.** All API responses surface `locationId` as the stable identifier members use across versions. The version row's own `id` is internal, used only by `supersedes_location_version_id` to chain history.

4. **Version chain integrity.** All versions in a chain (sharing the same `location_id`) MUST have the same `member_id` and the same `type`. A member can never give a location to another member, and a home can never become a travel plan or vice versa. Enforced at the repository layer (read the latest version, compare to the new version's input) — the schema doesn't enforce it because there's no entity row to constrain against.

5. **City normalization is consistent across writes and reads.** All inserts compute `city_normalized` using a single normalization function in the application layer. All matching queries use `city_normalized`, not `city`. The display form `city` is preserved for showing back to members ("São Paulo" stays "São Paulo" in the UI; "sao paulo" is what we match on).

6. **Country is required and ISO 3166-1 alpha-2.** The application layer normalizes whatever the agent passes (`"GB"`, `"gb"`, `"United Kingdom"`) to the canonical two-letter uppercase code, or rejects it with a clear error. The schema enforces format via a CHECK constraint. This is the disambiguator that distinguishes London, GB from London, CA.

7. **Region is optional but uses ISO 3166-2 codes when provided.** Free text fallback is allowed but discouraged. The application layer uppercases. Matching is tolerant: if either side has a null region, regions are not compared.

8. **Dates only, no times, no timezones.** The `starts_on` and `ends_on` columns are Postgres `date`, not `timestamptz`. They are interpreted in the city's local timezone, but we don't store the timezone because we don't need it. *"Owen is in Tokyo April 14–18"* means those four calendar days in Tokyo's sense, full stop. Overlap is calendar-day inclusive on both ends.

9. **Travel requires `ends_on`. Home doesn't.** Enforced by CHECK constraint. A travel plan with no end date is conceptually a home, and members should declare it as such. A home can have a null `ends_on` (still living there) and a null `starts_on` (don't remember when I moved in).

10. **Reads from another member's locations require a shared club.** Same pattern as `profile.get` for another member: the actor must share at least one club with the target member where both have active membership. Enforced by SQL filter at the repository layer, not handler-side. There is no public location lookup.

11. **The synchronicity worker reads `live_member_locations`, not the raw versions table.** The view encodes "latest version per chain, status = active". All worker queries go through the view. Direct queries against `member_location_versions` are limited to the repository layer (writing versions, building chains).

12. **Location context in match payloads is bounded.** Maximum 5 location overlap entries per match payload. Maximum 90-day forward window from `current_date`. Past locations don't appear in payloads (they're useful for the Club Mind reasoning layer but not for active match enrichment).

13. **`buildSignalPayload` is the only place that reads locations for enrichment.** Not the candidate-generation path (`processEntityTriggers`, `processIntroRecompute`). Not the throttling path. Not the freshness check. Locations don't influence which matches get produced or delivered — only what data is attached to matches that are being delivered for other reasons.

## Decisions and reasoning

These are the choices the design conversation arrived at and why. The implementer should not second-guess them without checking with the design owner.

- **Single-table versioned design (Pattern B), not two-table entity-plus-versions (Pattern A).** The codebase has both patterns. Owen explicitly chose the simpler one even though it duplicates `member_id` and `type` across every version row. Locations don't change often, so the duplication cost is negligible, and we save a join on every read. Mirror `member_global_role_versions`, not `entities`/`entity_versions`.

- **Eight API actions, not unified.** Two parallel action groups (`member.travel.*` and `member.home.*`), each with `add` / `update` / `remove` / `list`. Eight one-line actions. Could be collapsed into a unified `member.locations.*` set with a `type` parameter, but separate actions are clearer for the agent and for SKILL.md guidance. Members think about "my home" and "my trips" as different concepts; the API mirrors that.

- **Update creates a new version, even for trivial changes.** Owen confirmed: "we have an append-only model in our database." Fixing a typo in the city name creates a new version row. No special "trivial change" path. The slight storage cost is worth the audit/reasoning value — the Club Mind will eventually find historical patterns useful (*"Owen has been refining where he says he lives over the past six months — something might be shifting"*).

- **Remove creates an archive marker version, doesn't delete.** Same reasoning. The history of "I used to plan to go to Tokyo April 14-18 but I cancelled" is preserved as a chain ending in an archived version. Hard delete is reserved for the future `member.delete` flow, which removes everything for a departing member.

- **Travel and home use different "remove" semantics.** Travel removal creates a single archive marker version. Home removal sets `ends_on = current_date` AND archives — preserving the historical "I moved out on this date" record while marking the chain inactive. A future `home.update` to set just `ends_on` (without archiving) is the way to mark "moved" without archiving the history.

- **No quotas in v1.** Locations aren't entities and don't go through `QUOTA_ENTITY_KINDS`. We don't expect spam. If abuse appears in production, add a generous daily cap (20–30 location adds per day per member) at that point.

- **No legality gate on location adds.** The optional `note` field is free text, but it's much more constrained than entity bodies and the use case is benign ("happy to meet for coffee"). If we observe abuse via the note field, add gating later. Not blocking v1.

- **City normalization is application-layer, not database-layer.** Postgres `unaccent` extension would let us do this with a generated column, but it's a deployment surface area we'd rather avoid. A small TypeScript helper does the work at insert time and stores both `city` (display) and `city_normalized` (matching). Identical normalization at query time. The function is the source of truth and any change to it requires a backfill.

- **No geocoding in v1, but design for it later.** No external API integration with Google Places, OSM Nominatim, or anything else. The agent normalizes via SKILL.md guidance: title case, ISO country code, ISO region code when known. v2 can add a geocoding layer that produces canonical place IDs without changing the schema substantively (add a nullable `place_id` column, populate it lazily).

- **Region is the disambiguator for ambiguous cities.** "London, GB" vs "London, CA" is solved by `country`. "London, GB" (the city) vs "London, ON" (Canadian city in Ontario)... wait, both are GB and CA respectively. But "Springfield" exists in 20+ US states. For those, we need `region` (ISO 3166-2 code like `US-IL` for Illinois). The agent passes region when ambiguity matters; matching is tolerant when one side omits it (better to match than to miss).

- **Location context payload uses overlap kinds derived from types.** Four kinds: `crossing` (both travel), `visiting_their_home` (source travel, target home), `they_visit_your_home` (source home, target travel), `same_home` (both home). The agent reads the kind and constructs natural language. The worker computes the kind from the types — no string passed by callers.

- **The same overlap can appear in multiple match payloads simultaneously.** If Owen and Maria are both in Tokyo April 14–18, AND they're matched for a biotech ask AND for an introduction AND for a service offer, the same Tokyo overlap appears in all three signal payloads. That's fine and intentional — each signal is independent and the agent might describe the overlap differently in each context.

## Build order

The order matters because some changes depend on invariants set by earlier ones. Don't split Phase 1 across commits — the schema and the types must agree, and a half-done state breaks the build.

### Phase 1: Schema, enums, and types (atomic)

1. New enums: `member_location_type` (`'home' | 'travel'`) and `member_location_status` (`'active' | 'archived'`).
2. New table: `member_location_versions` with all columns, constraints, and indexes (see schema below).
3. New views: `current_member_locations` (latest version per chain) and `live_member_locations` (latest version per chain, status = active).
4. New TypeScript types in `src/contract.ts`: `MemberLocationType`, `MemberLocationStatus`, `MemberLocation`, `CreateLocationInput`, `UpdateLocationInput`, etc.
5. New zod response shape in `src/schemas/responses.ts`: `memberLocation`.
6. New wire/parse helpers in `src/schemas/fields.ts`: `wireIsoDate`, `parseIsoDate`, `wireCountryCode`, `parseCountryCode`, `wireCityName`, `parseCityName`, `wireRegionCode`, `parseRegionCode`.
7. Repository capability declarations in `src/contract.ts`: `createMemberLocation`, `updateMemberLocation`, `archiveMemberLocation`, `listMemberLocations`, `loadLocationOverlapForMatch`.
8. **Type-check passes.** `npx tsc --noEmit` should be clean before moving on.

### Phase 2: Repository implementation

1. **City normalization helper** in a new file `src/clubs/locations.ts` (or wherever fits the codebase pattern). Single source of truth function `normalizeCity(city: string): string` and `normalizeCountry(country: string): string`.
2. **`createMemberLocation`**: generates a new `location_id` (short_id), inserts version 1 with `version_no = 1`, `supersedes_location_version_id = null`, normalized city/country, computed status. Returns the new version mapped to the API shape.
3. **`updateMemberLocation`**: takes `locationId` + actor + patch fields. Reads the current live version of the chain (via `live_member_locations`), verifies actor ownership (`member_id = $actor`) — return null if not found or not owned. Computes the new version: same `location_id`, `member_id`, `type` (these can never change); patched fields applied to the rest; `version_no = current.version_no + 1`; `supersedes_location_version_id = current.id`. Inserts the new version row. Returns mapped version.
4. **`archiveMemberLocation`**: same pattern as update, but the new version always sets `status = 'archived'`. For homes, also sets `ends_on = COALESCE(provided_endedOn, CURRENT_DATE)` if `ends_on` is currently null.
5. **`listMemberLocations`**: reads from `live_member_locations` filtered by `member_id`, optionally by `type`. Optional `includePast` flag controls whether locations with `ends_on < current_date` are included (default false). Optional `includeArchived` flag controls whether to read from `current_member_locations` instead of `live_member_locations` (default false). When reading another member's locations, an additional filter joins through `accessible_club_memberships` to verify a shared club.
6. **`loadLocationOverlapForMatch`**: the read-side enrichment helper. Takes `(sourceMemberId, targetMemberId)`. Runs the overlap query (see below). Returns up to 5 overlaps. Used only by `buildSignalPayload`. Detail SQL:

```sql
SELECT
  s.location_id   AS source_location_id,
  s.type          AS source_type,
  s.starts_on     AS source_starts_on,
  s.ends_on       AS source_ends_on,
  t.location_id   AS target_location_id,
  t.type          AS target_type,
  t.starts_on     AS target_starts_on,
  t.ends_on       AS target_ends_on,
  s.city          AS city,
  s.country       AS country,
  s.region        AS region
FROM live_member_locations s
JOIN live_member_locations t
  ON s.city_normalized = t.city_normalized
 AND s.country = t.country
 AND (s.region IS NULL OR t.region IS NULL OR s.region = t.region)
WHERE s.member_id = $1
  AND t.member_id = $2
  AND COALESCE(s.starts_on, '-infinity'::date) <= COALESCE(t.ends_on, 'infinity'::date)
  AND COALESCE(s.ends_on,   'infinity'::date)  >= COALESCE(t.starts_on, '-infinity'::date)
  AND COALESCE(s.ends_on,   'infinity'::date)  >= CURRENT_DATE
  AND COALESCE(t.ends_on,   'infinity'::date)  >= CURRENT_DATE
  AND COALESCE(s.starts_on, '-infinity'::date) <= (CURRENT_DATE + interval '90 days')::date
ORDER BY
  GREATEST(COALESCE(s.starts_on, '-infinity'::date), COALESCE(t.starts_on, '-infinity'::date)) ASC
LIMIT 5
```

Note the asymmetry: the source/target naming corresponds to the match, not to the locations. Both directions of overlap need to be computed when called, but for one specific recipient — so the query is parameterized once per match.

### Phase 3: API actions

Six action files, all in a new module `src/schemas/locations.ts`. The module follows the existing pattern (one file per action group, register at the bottom). Each action is small.

1. `member.travel.add` — auth: member; safety: mutating; no quality gate; takes `{ city, country, region?, startsOn, endsOn, note? }`; returns `{ location: memberLocation }`.
2. `member.travel.update` — auth: member; safety: mutating; takes `{ locationId, city?, country?, region?, startsOn?, endsOn?, note? }`; returns `{ location: memberLocation }`.
3. `member.travel.remove` — auth: member; safety: mutating; takes `{ locationId }`; returns `{ location: memberLocation }`.
4. `member.travel.list` — auth: member; safety: read_only; takes `{ memberId?, includePast?, includeArchived? }`; returns `{ locations: memberLocation[] }`.
5. `member.home.add` — auth: member; safety: mutating; takes `{ city, country, region?, startsOn?, note? }`; returns `{ location: memberLocation }`.
6. `member.home.update` — auth: member; safety: mutating; takes `{ locationId, city?, country?, region?, startsOn?, note? }`; returns `{ location: memberLocation }`.
7. `member.home.remove` — auth: member; safety: mutating; takes `{ locationId, endedOn? }`; returns `{ location: memberLocation }`.
8. `member.home.list` — auth: member; safety: read_only; takes `{ memberId?, includeArchived? }`; returns `{ locations: memberLocation[] }`.

Validation rules at the parse layer:

- `startsOn` and `endsOn` must match `^\d{4}-\d{2}-\d{2}$` (the new `parseIsoDate` helper).
- `country` is normalized to uppercase and validated against `^[A-Z]{2}$` (the new `parseCountryCode`).
- `city` is trimmed, length-bounded (max 200 chars), non-empty after trim.
- `region` is optional, trimmed, uppercased, length-bounded (max 10 chars), no format check (allow ISO 3166-2 codes and free text).
- `note` is optional, trimmed, length-bounded (max 1000 chars).
- For `travel.add` and `travel.update` (when `endsOn` is being set or already set on the chain), the parser allows it; the repository enforces "travel must have ends_on" via the CHECK constraint plus a runtime check before insert.

Auth:
- All `member.*.list` with no `memberId` returns the actor's own.
- All `member.*.list` with `memberId` requires shared club membership (handled in repo).
- All mutating actions on a `locationId` require ownership (handled by SQL filter in repo, return null → 404 in handler).

**No 403 branches in handlers.** Same lesson as gifts/loops invariant 4 from `docs/gifts_and_open_loops_implementation_plan.md`. The SQL filters return null when the actor doesn't own the location; the handler returns 404 `not_found`. Never write a handler-side `if (location.member_id !== ctx.actor.member.id) throw 403` — it's unreachable code.

**No 8 separate action variables in 8 separate `ActionDefinition` declarations is too verbose.** Define them inline if it's cleaner. Mirror the style of `src/schemas/entities.ts`.

### Phase 4: Worker integration (the only synchronicity change)

This is the smallest change of any phase, and it's the entire payoff for the synchronicity engine.

1. **One new helper** in `src/workers/synchronicity.ts` (or `similarity.ts` — wherever `loadEntityInfo` and `loadMemberInfo` already live):

```typescript
async function loadLocationOverlap(
  pool: Pool,
  sourceMemberId: string,
  targetMemberId: string,
): Promise<LocationOverlap[]>
```

The implementation runs the SQL in Phase 2 step 6. Returns at most 5 entries.

2. **Modify `buildSignalPayload`** at `src/workers/synchronicity.ts` (around line 823 based on prior reading). For each match kind branch (`ask_to_member`, `offer_to_ask`, `member_to_member`, `event_to_member`), determine the source and target members for that kind, call `loadLocationOverlap(pool, source, target)`, and attach the result as `locationContext` in the payload object.

Source/target mapping per match kind:
- `ask_to_member`: source = `entity.authorMemberId` (the ask author), target = `match.targetMemberId` (the matched member). The matched member is the one looking at the signal; the ask author is the one they're being shown.
- `offer_to_ask`: source = `entity.authorMemberId` of the offer (the gift/service/opportunity author), target = `match.targetMemberId` (the ask author who will receive this signal). The offer author is the one being introduced.
- `member_to_member`: source = `match.sourceId` (the other member), target = `match.targetMemberId` (the recipient).
- `event_to_member`: source = the event's author, target = `match.targetMemberId`.

The payload addition:

```typescript
return {
  kind: 'ask_match',
  askEntityId: match.sourceId,
  askAuthor: ...,
  matchScore: match.score,
  locationContext: overlaps.map(o => ({
    city: o.city,
    country: o.country,
    region: o.region,
    overlapStartsOn: maxDate(o.sourceStartsOn, o.targetStartsOn),
    overlapEndsOn: minDate(o.sourceEndsOn, o.targetEndsOn),
    sourceType: o.sourceType,
    targetType: o.targetType,
    overlapKind: deriveOverlapKind(o.sourceType, o.targetType),
  })),
};
```

Where `overlapKind` is one of `'crossing'`, `'visiting_their_home'`, `'they_visit_your_home'`, `'same_home'`, computed from the source/target type pair.

If `overlaps.length === 0`, omit `locationContext` from the payload entirely (don't include an empty array — keeps payloads small for the common case where there's no overlap).

3. **No new triggers, no new match kinds, no new throttling.** That's the entire worker change.

### Phase 5: Quota, dispatch, snapshot, schemas

1. **Dispatch import.** Add `import './schemas/locations.ts';` to `src/dispatch.ts` (around line 48 in the import block) so the new actions get registered when the module loads.
2. **Quota.** No change to `QUOTA_ENTITY_KINDS`. Locations are not entities and don't fall under content quotas. (If we want quotas later, that's a separate mechanism.)
3. **Schema snapshot.** If the project has a checked-in API schema artifact (look for `schema.json` or similar; check `test/integration/smoke.test.ts` for assertions), regenerate it after the new actions are registered.
4. **Superadmin schema.** Check `src/schemas/superadmin.ts` for any hardcoded entity-kind unions or action lists that might need updating. Locations don't add a new entity kind, so this should be a no-op, but verify.
5. **Contract `Repository` capability list.** Add the five new capability methods to whatever capability enum exists in `src/contract.ts` so the dispatch layer knows they're available.

### Phase 6: Tests

Tests are written **to the must-hold invariants**, not just to the API surface. Each invariant gets at least one regression test that would fail if the invariant were broken.

**New file: `test/integration/locations.test.ts`.**

Coverage:

- **Travel add round-trip.** Create a travel plan; list returns it; the response shape contains all expected fields.
- **Travel add validation.** `endsOn` < `startsOn` is rejected. Invalid country code is rejected. Empty city is rejected. Travel without `endsOn` is rejected.
- **Home add with no startsOn.** Should succeed. `endsOn` is null. Listed back as ongoing.
- **Update creates a new version.** After update, `live_member_locations` shows the new state. The raw `member_location_versions` table has two rows for the chain. `version_no` is 2. `supersedes_location_version_id` points to version 1's id.
- **Update preserves location_id.** The `locationId` returned after update is the same as before.
- **Update cannot change member_id or type.** Repository should reject (or simply not allow these fields in the update input).
- **Update creates a version even for trivial changes** (invariant 2 / append-only). Edit just the note text; verify a new version row exists.
- **Remove creates an archive marker version, doesn't delete.** After remove, the chain has one more version; the latest version has `status = 'archived'`; `live_member_locations` no longer returns the chain; `current_member_locations` does (with status = archived).
- **Home remove sets `ends_on`.** When a home is removed without an explicit `endedOn`, the new version has `ends_on = current_date`. With explicit `endedOn`, it uses that date. Either way, the historical chain is preserved.
- **List defaults exclude past travel.** A travel plan whose `ends_on` is in the past is not returned by `member.travel.list` unless `includePast: true`.
- **List defaults exclude archived.** Archived chains don't appear unless `includeArchived: true`.
- **List of another member's locations requires shared club.** A member who shares no clubs with the target gets 403 (or empty result, depending on existing patterns).
- **List of another member's locations works in shared club.** Returns their non-archived current locations.
- **City normalization works.** Inserting "Tokyo", "tokyo", and "TOKYO" produces three different display values but the same `city_normalized`. A query against the normalized column finds all three.
- **Diacritic normalization.** "São Paulo" and "Sao Paulo" produce the same `city_normalized`. The display form is preserved as input.
- **Country normalization.** "gb", "GB", and "United Kingdom" — the first two normalize to "GB"; the last is rejected with a clear error message saying to pass the ISO code.
- **Region disambiguates.** Two travel plans both with city = "Springfield", country = "US" — one with region = "US-IL", one with region = "US-MA". They are distinct records and don't match each other in the overlap query.
- **Region tolerance.** A location with region = "US-IL" and another with region = null (also Springfield, US) DO match in the overlap query (better to match than to miss when ambiguity isn't fully specified).

**Synchronicity worker tests** in a new section of `test/integration/llm-gated.test.ts` or a new `test/integration/synchronicity-locations.test.ts`:

- **Match payload includes `locationContext` when there's an overlap.** Set up two members with overlapping Tokyo presences; create an ask_to_member match between them; verify the delivered signal payload contains `locationContext` with the right city, dates, and overlapKind.
- **Match payload excludes `locationContext` when there's no overlap.** Same setup but with non-overlapping locations; verify the payload has no `locationContext` field (or an empty array, depending on what the implementer chooses — the SKILL.md should match).
- **Location context respects 90-day forward window.** A travel plan starting 100 days from now is not in the payload.
- **Location context excludes past locations.** A travel plan whose `ends_on` is yesterday is not in the payload.
- **Location context max 5 entries.** Set up six overlapping locations (somehow — maybe several travel plans by the same member to the same city) and verify the payload contains exactly 5.
- **Same-home overlap appears as `same_home` overlapKind.** Both members have a home in Lisbon → payload contains a `locationContext` entry with `overlapKind: 'same_home'`.
- **Travel + home overlap.** Member A has a Tokyo trip; member B has a Tokyo home. The match payload from A's perspective shows `overlapKind: 'visiting_their_home'`. From B's perspective: `overlapKind: 'they_visit_your_home'`.
- **Locations don't generate new matches.** Add a travel plan; verify no new rows appear in `signal_background_matches` as a direct consequence (no `co_location` match kind, no rows where the source is a location).
- **`buildSignalPayload` doesn't fail when one member has no locations.** Common case — most members won't have any.

## File-by-file changes

### `db/init.sql`

Add the enums in the type definitions section (alongside `entity_kind`, `member_state`, etc., around line 50-70):

```sql
-- Locations
CREATE TYPE member_location_type   AS ENUM ('home', 'travel');
CREATE TYPE member_location_status AS ENUM ('active', 'archived');
```

Add the table in the appropriate section. Since locations belong to members, place it near the members section, after `member_global_role_versions` (around line 130-180):

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

    -- Time (dates only, interpreted in city local timezone)
    starts_on                       date,
    ends_on                         date,

    -- Optional content
    note                            text,

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

CREATE INDEX member_location_versions_member_idx
    ON member_location_versions (member_id, location_id);
CREATE INDEX member_location_versions_chain_version_idx
    ON member_location_versions (location_id, version_no DESC);
CREATE INDEX member_location_versions_place_idx
    ON member_location_versions (city_normalized, country);
CREATE INDEX member_location_versions_dates_idx
    ON member_location_versions (starts_on, ends_on);
```

Add the views in the views section (alongside `current_entity_versions`, `live_entities`, etc., around line 1380-1421):

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

Add type definitions near the existing entity definitions:

```typescript
export type MemberLocationType = 'home' | 'travel';
export type MemberLocationStatus = 'active' | 'archived';

export type MemberLocation = {
  locationId: string;
  memberId: string;
  type: MemberLocationType;
  city: string;
  country: string;
  region: string | null;
  startsOn: string | null;  // ISO date
  endsOn: string | null;    // ISO date
  note: string | null;
  status: MemberLocationStatus;
  versionNo: number;
  createdAt: string;
};

export type CreateMemberLocationInput = {
  authorMemberId: string;
  type: MemberLocationType;
  city: string;
  country: string;
  region: string | null;
  startsOn: string | null;
  endsOn: string | null;
  note: string | null;
};

export type UpdateMemberLocationInput = {
  actorMemberId: string;
  locationId: string;
  patch: {
    city?: string;
    country?: string;
    region?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
    note?: string | null;
  };
};

export type ArchiveMemberLocationInput = {
  actorMemberId: string;
  locationId: string;
  endedOn?: string | null;  // for home archive only
};

export type ListMemberLocationsInput = {
  actorMemberId: string;
  targetMemberId: string;
  type?: MemberLocationType;
  includePast?: boolean;
  includeArchived?: boolean;
};

export type LocationOverlapKind =
  | 'crossing'
  | 'visiting_their_home'
  | 'they_visit_your_home'
  | 'same_home';

export type LocationOverlap = {
  city: string;
  country: string;
  region: string | null;
  overlapStartsOn: string;
  overlapEndsOn: string;
  sourceType: MemberLocationType;
  targetType: MemberLocationType;
  overlapKind: LocationOverlapKind;
};
```

Add the repository capability methods to whatever interface declares them:

```typescript
createMemberLocation(input: CreateMemberLocationInput): Promise<MemberLocation>;
updateMemberLocation(input: UpdateMemberLocationInput): Promise<MemberLocation | null>;
archiveMemberLocation(input: ArchiveMemberLocationInput): Promise<MemberLocation | null>;
listMemberLocations(input: ListMemberLocationsInput): Promise<MemberLocation[]>;
loadLocationOverlapForMatch(
  sourceMemberId: string,
  targetMemberId: string,
): Promise<LocationOverlap[]>;
```

### `src/schemas/responses.ts`

Add a new zod schema:

```typescript
export const memberLocationType = z.enum(['home', 'travel']);
export const memberLocationStatus = z.enum(['active', 'archived']);

export const memberLocation = z.object({
  locationId: z.string(),
  memberId: z.string(),
  type: memberLocationType,
  city: z.string(),
  country: z.string(),
  region: z.string().nullable(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  note: z.string().nullable(),
  status: memberLocationStatus,
  versionNo: z.number(),
  createdAt: z.string(),
});
```

### `src/schemas/fields.ts`

Add the new wire/parse helpers near the existing date helpers:

```typescript
/** Wire: ISO 8601 date (YYYY-MM-DD), no time component */
export const wireIsoDate = z.string()
  .describe('ISO 8601 date (YYYY-MM-DD). No time component.');

/** Parse: validates strict YYYY-MM-DD format */
export const parseIsoDate = safeString.pipe(z.string().trim())
  .refine(s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')),
    'Must be ISO 8601 date YYYY-MM-DD');

/** Wire: country (ISO 3166-1 alpha-2). Server uppercases. */
export const wireCountryCode = z.string()
  .describe('ISO 3166-1 alpha-2 country code, e.g. "GB", "US", "JP". Server uppercases.');

/** Parse: uppercases and validates two-letter format */
export const parseCountryCode = safeString.pipe(z.string().trim())
  .transform(s => s.toUpperCase())
  .refine(s => /^[A-Z]{2}$/.test(s),
    'Must be ISO 3166-1 alpha-2 country code (e.g. "GB", "US", "JP")');

/** Wire: city name. Server normalizes. */
export const wireCityName = z.string().max(200)
  .describe('City name. Server normalizes for matching but preserves display form.');

/** Parse: trims, length-bounds, rejects empty */
export const parseCityName = safeString.pipe(z.string().trim().min(1).max(200));

/** Wire: region (optional, ISO 3166-2 preferred but free text allowed). */
export const wireRegionCode = z.string().max(10).nullable().optional()
  .describe('Optional ISO 3166-2 region code (e.g. "GB-LND", "US-IL") for disambiguating ambiguous cities. Server uppercases.');

/** Parse: trims, uppercases, length-bounds */
export const parseRegionCode = safeString.pipe(z.string().trim().max(10))
  .transform(s => s === '' ? null : s.toUpperCase())
  .nullable()
  .optional();
```

### `src/clubs/locations.ts` (new file)

The repository implementation for member locations. Mirrors the structure of `src/clubs/entities.ts`. Includes:

- Normalization helpers (`normalizeCity`, `normalizeCountry`, `normalizeRegion`).
- `mapLocationRow(row)` for converting DB rows to API shapes.
- `LOCATION_SELECT` constant for the standard column list.
- `createMemberLocation` — generates new `location_id` and `id`, inserts version 1.
- `updateMemberLocation` — reads current live version via `live_member_locations`, verifies ownership, computes new version, inserts. Returns null on not-found-or-not-owned.
- `archiveMemberLocation` — same as update but new version always sets `status = 'archived'`. For homes, also sets `ends_on` if currently null.
- `listMemberLocations` — reads from `live_member_locations` (or `current_member_locations` if `includeArchived`), filtered by member + type. For other-member reads, joins through `accessible_club_memberships` to verify shared club access (return empty array, not 403, when no shared club exists — same pattern as `getMemberProfile`).
- `loadLocationOverlapForMatch` — runs the overlap query (Phase 2 step 6 SQL), returns up to 5 overlaps with derived `overlapKind`.

```typescript
function deriveOverlapKind(sourceType: MemberLocationType, targetType: MemberLocationType): LocationOverlapKind {
  if (sourceType === 'travel' && targetType === 'travel') return 'crossing';
  if (sourceType === 'travel' && targetType === 'home') return 'visiting_their_home';
  if (sourceType === 'home' && targetType === 'travel') return 'they_visit_your_home';
  return 'same_home';
}
```

### `src/schemas/locations.ts` (new file)

The action definitions. Eight actions, each small. Mirror the structure of `src/schemas/entities.ts`. Register at the bottom:

```typescript
registerActions([
  travelAdd, travelUpdate, travelRemove, travelList,
  homeAdd, homeUpdate, homeRemove, homeList,
]);
```

For each action: wire schema (input/output), parse schema, handler. The handler calls the corresponding repo method, throws 404 on null, returns the location wrapped in the response envelope.

### `src/dispatch.ts`

Add to the import block (around line 47-62):

```typescript
import './schemas/locations.ts';
```

That's the only change to dispatch.

### `src/postgres.ts`

The Postgres-backed repository implementation needs to add the five new methods:
- `createMemberLocation`
- `updateMemberLocation`
- `archiveMemberLocation`
- `listMemberLocations`
- `loadLocationOverlapForMatch`

Each delegates to functions in `src/clubs/locations.ts` (just like the entity methods delegate to `src/clubs/entities.ts`).

### `src/workers/synchronicity.ts`

Two changes:

1. **Import `loadLocationOverlapForMatch`** from `src/clubs/locations.ts`. Or, since the worker uses raw queries elsewhere, write a worker-local helper that runs the same SQL. Either is fine; the helper-in-locations.ts approach is cleaner because it keeps the SQL in one place.

2. **Modify `buildSignalPayload`** (around line 823) to call the helper for each match kind and attach `locationContext` to the payload object. See Phase 4 step 2 above for the exact mapping. Roughly:

```typescript
async function buildSignalPayload(pools, match) {
  // ... existing logic to determine source and target ...

  let locationContext: LocationOverlap[] | undefined;
  if (sourceMemberId && targetMemberId) {
    const overlaps = await loadLocationOverlap(pools.db, sourceMemberId, targetMemberId);
    if (overlaps.length > 0) {
      locationContext = overlaps;
    }
  }

  if (match.matchKind === 'ask_to_member') {
    return {
      kind: 'ask_match',
      askEntityId: ...,
      askAuthor: ...,
      matchScore: match.score,
      ...(locationContext && { locationContext }),
    };
  }
  // ... etc for other match kinds ...
}
```

The conditional spread keeps the payload clean for the common case where there's no overlap.

### `db/seeds/dev.sql`

Optional but useful: add a few seeded location rows for the test members so that running the dev server immediately demonstrates the feature. For each test member (Owen, Alice, Bob, Charlie), add 1-2 home rows and 1-2 travel rows to varied cities. Pick dates that produce some overlaps for matching demos.

### `test/integration/locations.test.ts` (new file)

See Phase 6 for the test list. Use `TestHarness` and the existing patterns from `test/integration/profiles.test.ts` or `test/integration/content.test.ts`.

### `test/integration/smoke.test.ts`

If this file asserts on the list of registered actions or the schema snapshot, update the assertions to include the new location actions.

## SKILL.md updates

These are applied separately by Claude (the conversational agent), not the implementing agent. Drafted here for review alongside the rest of the plan.

### 1. Add to the available actions list

Insert a new action group after the **Profile** group (around line 65-67):

```
**Locations**
- `member.travel.add` — declare an upcoming trip (city, country, dates)
- `member.travel.update` — update the details of a planned trip
- `member.travel.remove` — cancel or archive a trip
- `member.travel.list` — list your own (or another member's) travel plans in shared clubs
- `member.home.add` — declare a home base (members can have multiple)
- `member.home.update` — update the details of a home
- `member.home.remove` — mark a home as ended (for moves), preserving history
- `member.home.list` — list your own (or another member's) home bases in shared clubs
```

### 2. Insert a new "Locations" subsection in `## Interaction patterns`

```markdown
### Locations: homes and travel

ClawClub supports two kinds of location data: **homes** (where members live, possibly multiple) and **travel** (upcoming trips with dates). Both are stored as versioned, append-only history — when a member moves house or updates a trip, the old version is preserved as history rather than deleted.

**Location is enrichment, not a reason to introduce people.** The synchronicity engine never matches people because they live in the same city or are visiting the same place. It matches them on substance — what they offer, what they need, what they're working on. Location is then attached to those matches as additional context that makes the introduction more actionable: *"Maria looks like a strong biotech connection — and you'll both be in Tokyo April 14–18."*

When a member mentions they're traveling somewhere, or they live in a particular city, or they're moving — capture that as a location row. Don't ask members for location data unprompted; collect it when it comes up naturally.

**City normalization.** Always pass cities in their canonical English title-case form ("Tokyo", not "tokyo" or "TOKYO"). Always pass `country` as the ISO 3166-1 alpha-2 code ("GB" not "United Kingdom", "US" not "USA", "JP" not "Japan"). For ambiguous cities (Springfield in 20+ US states, Athens in Greece vs Georgia, Paris in France vs Texas), pass `region` as the ISO 3166-2 code when known ("US-IL" for Springfield, Illinois). The server normalizes for matching but preserves your input as the display form.

**Dates only, no times.** Travel plans use `startsOn` and `endsOn` as ISO dates (YYYY-MM-DD). Don't pass timestamps or timezones. *"April 14–18 in Tokyo"* means those four calendar days, full stop.

**Travel must have an end date.** If a member says "I'm going to Tokyo for a few weeks, not sure when I'll leave," ask for an estimate and tell them they can update it later. If a trip really has no end date, that's a home, not a trip.

**Home `startsOn` is optional.** If a member doesn't remember when they moved in, leave it null.

**Removing vs ending homes.** When a member moves house, use `member.home.remove` with `endedOn` set to the move date. This preserves the historical record ("Owen lived in London until April 2024") which is valuable context for the synchronicity engine. Don't try to "delete" the old home — there's no such operation. Removal always preserves history.
```

### 3. Insert a "Location context in signals" subsection in `## Interaction patterns`

```markdown
### Location context in match signals

When the synchronicity engine delivers a match (an introduction, an ask match, an offer match), the signal payload may include a `locationContext` array with overlap details between the actor and the matched member. Each overlap entry has:

- `city`, `country`, `region` — the place
- `overlapStartsOn`, `overlapEndsOn` — the calendar overlap window
- `sourceType`, `targetType` — `'home'` or `'travel'` for each side
- `overlapKind` — one of:
  - `crossing` (both members will be traveling there)
  - `visiting_their_home` (the matched member is visiting your home city)
  - `they_visit_your_home` (you'll be visiting the matched member's home city)
  - `same_home` (you both live there)

Use this context to enrich the way you present the match to the member. For example, an introduction signal with `overlapKind: 'crossing'` and city Tokyo April 14–18 should be framed as *"…and you'll both be in Tokyo April 14–18, in case you want to meet in person."* A `visiting_their_home` overlap should be framed as *"…they live in Lisbon, where you'll be next week — they might be a great host."*

The location context is supporting information, not the reason for the match. Always lead with the substantive reason (the ask, the gift, the shared interest) and mention location only as additional color.

When `locationContext` is absent or empty, don't mention location in the introduction at all — most matches won't have location overlap.
```

### 4. Update `## What exists in the system`

Add to the primitives line (around line 234):

> Primitives: member, club (`clubId`), membership, entity (post/opportunity/service/ask/gift), event, admission, message thread, message, update, vouch, **member location (home or travel)**.

## Out of scope

These are deliberately not included in v1. Some are future features; some are decisions to keep simple.

- **No `co_location` match kind.** Location is enrichment, not a primary match. This is the central design call (invariant 1) and the implementer should not add a co-location match kind under any circumstances.
- **No location-based search across the platform.** No `location.search` or `members.findInCity` or equivalent. If a member wants to know who's in Tokyo, they call `member.travel.list` and `member.home.list` for specific other members they're already interested in.
- **No geocoding.** No external API for canonical place IDs. Agent-side normalization via SKILL.md guidance is sufficient for v1.
- **No address-level data.** City, country, optional region. No streets, no neighborhoods, no GPS coordinates. Ever in v1.
- **No real-time location tracking.** Members declare plans; the system doesn't track where they actually are.
- **No quotas on location actions.** They're not entities; they don't go through `QUOTA_ENTITY_KINDS`. Add a separate quota mechanism in v2 if abuse appears.
- **No legality gate on location adds.** The optional note field is free text but the use case is benign. Add gating if abuse appears.
- **No recurring travel.** "I'm in NYC every other week" is a member-managed sequence of discrete trips, not a recurrence rule.
- **No multi-stop trips as a single object.** A London → Paris → Berlin trip is three location rows.
- **No automatic timezone awareness.** Dates are local-to-the-city by convention. The application doesn't store or compute timezones.
- **No backfill of location overlaps for existing matches.** When the feature ships, only matches generated *after* deploy will have `locationContext` in their payloads. Old delivered signals stay as they were.
- **No `member.location.search` action even for the actor's own data.** If you want filtered results, the future enhancement is `member.travel.list({ city, country, after, before })` — but for v1, list everything and filter client-side. Keep the API minimal.

## Open questions for the implementer

These are decisions left to the implementer (or noted as design notes). They don't change the must-hold invariants.

1. **`country` validation: regex vs hardcoded ISO list.** The plan uses a CHECK constraint `country ~ '^[A-Z]{2}$'` which accepts any two uppercase letters, including "XX" or "ZZ" which aren't real codes. Tighter would be a CHECK constraint listing all valid ISO 3166-1 alpha-2 codes. The agent's normalization is the practical defense; the regex is just a sanity check. **I'd leave the regex as-is for v1** unless the implementer feels strongly. Members or agents passing fake codes get garbage-in/garbage-out behavior, not a security issue.

2. **`current_member_locations` view tie-breaker.** The view orders by `version_no DESC`. Adding `created_at DESC` as a secondary sort handles the (impossible-in-practice) case where two versions have the same `version_no`. The plan includes it; minor consistency hardening.

3. **Should `member.travel.list` and `member.home.list` be combined into one `member.locations.list({ type? })` action?** The plan keeps them separate for clarity. Eight actions instead of six. Owen's preference. Not a v2 question — design is final.

4. **Performance of the overlap query.** The query is run once per match delivery, against `live_member_locations` for two specific members. With indexes on `(member_id, location_id)` and `(city_normalized, country)`, this should be cheap (each member has at most a handful of locations). If profiling shows it's slow, the fix is probably `EXPLAIN ANALYZE` and a smarter index.

5. **Test data for the synchronicity worker tests.** The tests need to set up two members with overlapping locations AND a substantive reason to be matched (an ask, a profile similarity). The implementer should leverage `TestHarness` and existing match-test patterns. If the tests are flaky because of worker timing, follow the pattern in the existing synchronicity tests for triggering and waiting.

6. **What does the agent see for an introduction signal with `locationContext` but no other compelling substance?** The current intro path uses profile vector similarity. If two members happen to have low similarity but ARE in the same city, the engine still won't introduce them — locations aren't a match trigger. But if the engine produces a borderline intro for substantive reasons AND there's a location overlap, the location context might be the thing that pushes the agent to actually deliver the introduction message instead of suppressing it as weak. This is SKILL.md framing, not implementation; the SKILL.md update above covers it.

---

Once this lands, the next features in the queue are `member.tell()` (the directional nudge to the synchronicity engine) and the Club Mind reasoning layer v0. Both will benefit from having location data as substrate, and the reasoning layer in particular will read `live_member_locations` directly as part of per-club context. The data model is designed to support that integration without further schema changes.
