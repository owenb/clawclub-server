# Plan: Club-Scoped Member Profiles

## Context for the reviewing agent

This plan has been through multiple rounds of design review. The owner has explicitly confirmed that breaking the API is allowed and encouraged if it produces a cleaner design. There is no need for backward compatibility, bridge behavior, staged rollouts, or dual response types. The only constraint is that the existing database can be migrated.

## What we're doing

Members can belong to multiple clubs. Today, every member has one global profile. After this change, profile content is per-club. A member gets a separate profile in each club and can edit them independently.

## The design principle: identity is global, presentation is per-club

**Global identity** stays on the `members` table: `public_name`, `handle`, and a new `display_name` column. These appear on cross-club surfaces (DMs, entity authorship, activity feeds, auth envelopes) where there is no club context.

**Club-scoped content** moves to a new versioned table: `tagline`, `summary`, `what_i_do`, `known_for`, `services_summary`, `website_url`, `links`, and the `profile` JSON blob.

`display_name` is identity, not content. The old system versioned it in `member_profile_versions` alongside bio and tagline. We're moving it to the `members` row because it appears on cross-club surfaces, and keeping a second versioned table alive just to version one field is pointless. After migration, `member_profile_versions` stops receiving reads or writes and can be dropped in a later cleanup migration.

---

## Database changes

### Add `display_name` to `members`

```sql
ALTER TABLE members ADD COLUMN display_name text;
UPDATE members SET display_name = COALESCE(
    (SELECT display_name FROM current_member_profiles WHERE member_id = members.id),
    public_name
);
ALTER TABLE members ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE members ADD CONSTRAINT members_display_name_check
    CHECK (length(btrim(display_name)) > 0);
```

### New table: `member_club_profile_versions`

```sql
CREATE TABLE member_club_profile_versions (
    id                   short_id DEFAULT new_id() NOT NULL,
    member_id            short_id NOT NULL,
    club_id              short_id NOT NULL,
    version_no           integer NOT NULL,
    tagline              text,
    summary              text,
    what_i_do            text,
    known_for            text,
    services_summary     text,
    website_url          text,
    links                jsonb DEFAULT '[]' NOT NULL,
    profile              jsonb DEFAULT '{}' NOT NULL,
    search_vector        tsvector,
    created_at           timestamptz DEFAULT now() NOT NULL,
    created_by_member_id short_id,
    generation_source    text NOT NULL DEFAULT 'manual',
    CONSTRAINT member_club_profile_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_club_profile_versions_member_club_version_unique
        UNIQUE (member_id, club_id, version_no),
    CONSTRAINT member_club_profile_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_club_profile_versions_generation_source_check
        CHECK (generation_source IN ('manual', 'migration_backfill', 'admission_generated', 'membership_seed')),
    CONSTRAINT member_club_profile_versions_member_fkey
        FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_club_profile_versions_club_fkey
        FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT member_club_profile_versions_created_by_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX member_club_profile_versions_member_club_idx
    ON member_club_profile_versions (member_id, club_id, version_no DESC);
CREATE INDEX member_club_profile_versions_club_member_idx
    ON member_club_profile_versions (club_id, member_id, version_no DESC);
CREATE INDEX member_club_profile_versions_search_idx
    ON member_club_profile_versions USING gin (search_vector);
```

### Search vector trigger

Same pattern as the existing trigger on `member_profile_versions` ([db/init.sql:203-223](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql#L203)), but without `display_name` since that's now global. Search queries should `OR` against `members.public_name` / `members.display_name` separately for name matching.

```sql
CREATE FUNCTION member_club_profile_versions_search_vector_trigger() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        coalesce(NEW.tagline, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.what_i_do, '') || ' ' ||
        coalesce(NEW.known_for, '') || ' ' ||
        coalesce(NEW.services_summary, '')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_club_profile_versions_search_vector_update
    BEFORE INSERT OR UPDATE ON member_club_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION member_club_profile_versions_search_vector_trigger();
```

### Latest-version view

```sql
CREATE VIEW current_member_club_profiles AS
    SELECT DISTINCT ON (member_id, club_id) *
    FROM member_club_profile_versions
    ORDER BY member_id, club_id, version_no DESC, created_at DESC;
```

### Backfill club profiles

Copy the current global profile into every active membership. With fewer than 10 members this runs in the same migration transaction.

```sql
INSERT INTO member_club_profile_versions (
    member_id, club_id, version_no,
    tagline, summary, what_i_do, known_for, services_summary,
    website_url, links, profile,
    created_by_member_id, generation_source
)
SELECT
    cm.member_id, cm.club_id, 1,
    cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
    cmp.website_url, cmp.links, cmp.profile,
    cm.member_id, 'migration_backfill'
FROM club_memberships cm
LEFT JOIN current_member_profiles cmp ON cmp.member_id = cm.member_id
WHERE cm.left_at IS NULL;
```

We use `club_memberships WHERE left_at IS NULL`, not `accessible_club_memberships`. Whether a member can *access* their club is a billing question. Whether a profile *exists* for them is a data question.

### Club-scoped embeddings

The current `member_profile_embeddings` table has a FK to `member_profile_versions` and a unique constraint on `(member_id, model, dimensions, source_version, chunk_index)` with no `club_id` ([db/init.sql:1092](/Users/owen/Work/ClawClub/clawclub-server/db/init.sql#L1092)). With fewer than 10 members, drop and recreate with the correct schema:

```sql
DROP TABLE member_profile_embeddings;

CREATE TABLE member_profile_embeddings (
    id                  short_id DEFAULT new_id() NOT NULL,
    member_id           short_id NOT NULL,
    club_id             short_id NOT NULL,
    profile_version_id  short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    chunk_index         integer NOT NULL DEFAULT 0,
    source_text         text NOT NULL,
    source_hash         text NOT NULL,
    embedding           vector(1536) NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT member_profile_embeddings_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_embeddings_unique
        UNIQUE (member_id, club_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT member_profile_embeddings_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT member_profile_embeddings_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_profile_embeddings_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT member_profile_embeddings_version_fkey
        FOREIGN KEY (profile_version_id) REFERENCES member_club_profile_versions(id) ON DELETE CASCADE
);
CREATE INDEX member_profile_embeddings_member_idx ON member_profile_embeddings (member_id);
CREATE INDEX member_profile_embeddings_version_idx ON member_profile_embeddings (profile_version_id);
CREATE INDEX member_profile_embeddings_club_member_idx ON member_profile_embeddings (club_id, member_id);
```

After the migration, enqueue embedding jobs for all backfilled club profiles:

```sql
INSERT INTO ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
SELECT 'member_club_profile_version', mcpv.id, 'text-embedding-3-small', 1536, 'v1'
FROM current_member_club_profiles mcpv
ON CONFLICT DO NOTHING;
```

### Update `ai_embedding_jobs`

The existing check constraint allows `'member_profile_version'` and `'entity_version'`. Old `member_profile_version` jobs may still exist in the table. The migration must clean them up before changing the constraint, and must not enqueue new-style jobs until the worker code can process them.

```sql
-- Delete any stale member_profile_version jobs (they reference the old table)
DELETE FROM ai_embedding_jobs WHERE subject_kind = 'member_profile_version';

-- Update the constraint to accept the new kind
ALTER TABLE ai_embedding_jobs DROP CONSTRAINT ai_embedding_jobs_subject_kind_check;
ALTER TABLE ai_embedding_jobs ADD CONSTRAINT ai_embedding_jobs_subject_kind_check
    CHECK (subject_kind IN ('member_club_profile_version', 'entity_version'));
```

**Deploy-order constraint:** The migration enqueues `member_club_profile_version` jobs at the end (see "Backfill club profiles" above). The embedding worker must be updated to understand this new `subject_kind` in the same deploy. If the old worker code is still running when the migration completes, old workers will not claim the new jobs because the claim query filters by known `subject_kind` values. But to avoid a window where jobs pile up unprocessed, the embedding worker changes (implementation step 9) should ship in the same deploy as the migration. Do not enqueue the jobs in a separate later step.

### Migration file

All of the above goes in a single numbered SQL migration under `db/migrations/`. The existing migration infrastructure ([scripts/migrate.sh](/Users/owen/Work/ClawClub/clawclub-server/scripts/migrate.sh)) runs files in order with `--single-transaction`.

### Update `db/init.sql`

`init.sql` must be updated to the target schema. Remove the old `member_profile_versions` table, `current_member_profiles` view, and search trigger. Add the new objects. This file is used by `reset-dev.sh`, the integration test harness, and fresh installs.

---

## API changes

### Delete `profile.get`

Remove it. Replace with `profile.list`. No bridge, no compatibility shim.

### `profile.list` (replaces `profile.get`)

One action, one response shape, always.

**Input:**
```typescript
{
  memberId?: string   // omit for self
  clubId?: string     // omit to get all visible clubs
}
```

**Output:**
```typescript
{
  memberId: string
  publicName: string
  handle: string | null
  displayName: string
  profiles: ClubProfile[]
}
```

Where `ClubProfile` is:
```typescript
{
  club: { clubId: string, slug: string, name: string }
  tagline: string | null
  summary: string | null
  whatIDo: string | null
  knownFor: string | null
  servicesSummary: string | null
  websiteUrl: string | null
  links: unknown[]
  profile: Record<string, unknown>
  version: {
    id: string
    versionNo: number
    createdAt: string
    createdByMemberId: string | null
  }
}
```

**Visibility rules:**
- For self: return club profiles for all clubs in the actor's current membership scope.
- For another member: return club profiles only for clubs shared between actor and target (via `accessible_club_memberships`).
- If `clubId` is provided: filter to that one club.
- Zero visible profiles for self: return identity with `profiles: []` (not 404). This happens during payment-pending windows.
- Zero shared clubs with another member: return 404.
- Shared clubs but no profile rows: return identity with `profiles: []`.

Identity fields are at the top level, never repeated inside each club profile.

### `profile.update`

**Identity keys** (global, write to `members`):
- `handle`
- `displayName`

**Club-scoped keys** (write to `member_club_profile_versions`):
- `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl`, `links`, `profile`

**Validation rules:**
| Input contains | `clubId` | Result |
|---|---|---|
| Any club-scoped key (even if value is `null`) | Required | Write club profile version |
| Only identity keys | Optional, ignored | Write to `members` |
| Both identity and club keys | Required | Both writes in one transaction |
| No updatable keys at all | n/a | `400 invalid_input` |

**Response:** Always the same `memberProfileEnvelope` shape as `profile.list`. The response reflects the actor's current visible state after the write — identity fields plus all visible club profiles.
- If `clubId` was provided: `profiles` contains the updated club profile plus any other visible club profiles.
- If `clubId` was omitted (identity-only update): `profiles` contains all visible club profiles with the updated identity fields.

The response is always a truthful snapshot of current state. An agent that caches the response will have correct data regardless of what was updated.

**Quality gate:** `profile.update` currently goes through the `'profile-update'` quality gate ([src/schemas/profile.ts:78](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/profile.ts#L78)). This should continue to apply when club-scoped fields are present.

### `clubId` required on list and search

`members.list` ([src/schemas/membership.ts:172](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/membership.ts#L172)), `members.searchByFullText` ([src/schemas/membership.ts:95](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/membership.ts#L95)), and `members.searchBySemanticSimilarity` currently accept `clubId` as optional. Make it required on all three. Once profiles diverge, a multi-club query can't populate one `tagline`/`summary` slot per member. If an agent needs to search across clubs, it makes separate calls per club.

**Full-text search** ([src/identity/profiles.ts:199](/Users/owen/Work/ClawClub/clawclub-server/src/identity/profiles.ts#L199)):
- Switch to `member_club_profile_versions.search_vector`, joined on `club_id`.
- `OR` against `members.public_name` / `members.display_name` for name matching.

**Semantic/vector search** ([src/identity/profiles.ts:255](/Users/owen/Work/ClawClub/clawclub-server/src/identity/profiles.ts#L255)):
- Add `AND mpe.club_id = $clubId` to the embedding join.

**Member list** ([src/identity/memberships.ts:219](/Users/owen/Work/ClawClub/clawclub-server/src/identity/memberships.ts#L219)):
- Switch to `current_member_club_profiles` joined on both `member_id` and `club_id`.

**Similarity functions** ([src/workers/similarity.ts](/Users/owen/Work/ClawClub/clawclub-server/src/workers/similarity.ts)):
- `loadProfileVector(pool, memberId)` becomes `loadProfileVector(pool, memberId, clubId)`.
- `findSimilarMembers` and `findMembersMatchingEntity` — already have `clubId`, add the club filter to the embedding join.

**Synchronicity matcher** ([src/workers/synchronicity.ts](/Users/owen/Work/ClawClub/clawclub-server/src/workers/synchronicity.ts)):
- Already club-scoped. Each match type passes `clubId` into the similarity functions. Once those filter embeddings by club, matching automatically uses the right profile vector. Strictly more accurate than before.

---

## Response types

### Delete `memberProfile`

The old single-profile response type is removed entirely. Everything uses the envelope.

### `clubProfile`

```typescript
export const clubProfile = z.object({
  club: z.object({ clubId: z.string(), slug: z.string(), name: z.string() }),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(z.unknown()),
  profile: z.record(z.string(), z.unknown()),
  version: z.object({
    id: z.string(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
});
```

### `memberProfileEnvelope`

Used by `profile.list`, `profile.update`, and `superadmin.members.get`.

```typescript
export const memberProfileEnvelope = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  profiles: z.array(clubProfile),
});
```

### `memberSearchResult` and `clubMemberSummary`

These keep the same shape. The data source changes from global profile to club-scoped profile for the specific club being listed/searched.

### `adminMemberDetail`

Replace `profile: memberProfile | null` with the `memberProfileEnvelope` shape. Superadmin sees all club profiles.

---

## Membership creation and profile seeding

Every path that creates a membership must ensure a club profile exists. Write a shared helper:

```typescript
async function ensureClubProfileSeeded(
  client: DbClient,
  memberId: string,
  clubId: string,
  source: {
    generationSource: 'admission_generated' | 'membership_seed',
    preGeneratedFields?: ClubProfileFields | null,
  },
): Promise<void>
```

**Behavior:**
- If a club profile already exists for `(member_id, club_id)`, do nothing. Handles rejoins.
- If `preGeneratedFields` is provided (admission path), write those as version 1.
- Otherwise: copy from the member's most recent club profile (by `created_at`) in any other club. If none, seed with null text fields, `[]` links, `{}` profile.
- Enqueue an embedding job for the new version.

### Paths that must call this

1. **Admission acceptance** ([src/postgres.ts:555](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts#L555)) — pass `preGeneratedFields` from the LLM call.
2. **`clubadmin.memberships.create`** ([src/identity/memberships.ts:286](/Users/owen/Work/ClawClub/clawclub-server/src/identity/memberships.ts#L286)) — `generation_source: 'membership_seed'`.
3. **`superadmin.memberships.create`** ([src/identity/memberships.ts:572](/Users/owen/Work/ClawClub/clawclub-server/src/identity/memberships.ts#L572)) — same.
4. **Club creation** ([src/identity/clubs.ts:76](/Users/owen/Work/ClawClub/clawclub-server/src/identity/clubs.ts#L76)) — owner's clubadmin membership.
5. **Owner reassignment** ([src/identity/clubs.ts:132](/Users/owen/Work/ClawClub/clawclub-server/src/identity/clubs.ts#L132)) — if new owner needs a membership.

---

## LLM profile generation on admission

When a member is accepted into a club, the system generates their initial club profile from their admission application. Synchronous. If the LLM is unavailable, the admission is not accepted.

### Transaction boundary constraint

`transitionAdmission` ([src/clubs/admissions.ts:217](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L217)) commits the admission status in its own transaction. The member/membership creation in [src/postgres.ts:573](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts#L573) runs outside that transaction. The LLM call cannot go between these — if it fails, the admission is stuck as accepted with no profile.

### Solution: generate before transitioning

The handler knows `nextStatus === 'accepted'`, so it:

1. Loads the admission details and club context (read-only queries).
2. Calls the LLM to generate club profile fields.
3. If the LLM fails, returns an error. Admission stays in its previous state.
4. If the LLM succeeds, holds the generated fields in memory.
5. Proceeds with the normal `transitionAdmission` call.
6. Creates member/membership as today.
7. Calls `ensureClubProfileSeeded` with the pre-generated fields.

### Retry safety

The existing three-layer retry check ([src/postgres.ts:579-617](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts#L579)) finds existing memberships via `source_admission_id` and skips `createMembership`. If the membership was created but the profile write failed, a retry would skip seeding entirely.

**Fix:** call `ensureClubProfileSeeded` unconditionally after the membership is confirmed to exist, whether just created or found via retry. The helper's idempotency check makes this safe.

**Already-accepted retry:** If the admin retries after the admission was already committed as accepted (step 5 succeeded, step 7 failed on prior attempt), `transitionAdmission` would create a duplicate `accepted` version ([src/clubs/admissions.ts:272](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L272)). Add a guard: if the admission is already `accepted`, skip the transition but still run the LLM call (unless a club profile already exists for the member+club). This way the retry produces the same admission-derived profile that the first attempt would have. The `ensureClubProfileSeeded` idempotency check prevents double-writing if the profile was already created.

### Admission data available

`admission_details` stores `{ socials: string, application: string }` — populated in [src/clubs/admissions.ts:409](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L409) (cold path) and [src/clubs/admissions.ts:703](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L703) (cross-apply path). Club context from the `clubs` table: `name`, `summary`, `admission_policy`.

### Prompt design

Input: club name, summary, admission policy, applicant name, application text, socials.

Instructions:
- Extract information suitable for a public profile in this club.
- Output club-scoped fields only: `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl`, `links`, `profile`.
- Do not invent facts not in the application.
- Do not include email or private contact details.
- If evidence is weak for a field, leave it null.
- Do not output name, handle, or display name.

Use `CLAWCLUB_OPENAI_MODEL` from [src/ai.ts](/Users/owen/Work/ClawClub/clawclub-server/src/ai.ts). **Never change the model name.**

---

## Superadmin changes

`superadmin.members.get` ([src/schemas/superadmin.ts:126](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/superadmin.ts#L126)) returns the `memberProfileEnvelope` shape with all club profiles, regardless of the actor's club scope.

---

## Surfaces that stay global

- **Auth envelopes** ([src/schemas/transport.ts:25](/Users/owen/Work/ClawClub/clawclub-server/src/schemas/transport.ts#L25)) — `member.publicName` from `members` table.
- **DMs** ([src/postgres.ts:769](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts#L769)) — counterpart names from `members.public_name` and `members.handle`.
- **Entity/event authorship** ([src/clubs/entities.ts:84](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/entities.ts#L84)) — author name from `members.public_name`.
- **Admission records** ([src/clubs/admissions.ts:515](/Users/owen/Work/ClawClub/clawclub-server/src/clubs/admissions.ts#L515)) — applicant name/email from `members` and `member_private_contacts`.
- **Activity feed payloads** — names inline in JSONB, historical snapshots.

---

## Tooling and dev infrastructure

- **`db/init.sql`** — target schema: new tables, remove old `member_profile_versions`/view/trigger.
- **`db/seeds/dev.sql`** — seed `members.display_name` and `member_club_profile_versions`.
- **`scripts/bootstrap.sh`** ([scripts/bootstrap.sh:51](/Users/owen/Work/ClawClub/clawclub-server/scripts/bootstrap.sh#L51)) — set `members.display_name`. No club profile (no club exists at bootstrap time).
- **`test/integration/harness.ts`** ([test/integration/harness.ts:205](/Users/owen/Work/ClawClub/clawclub-server/test/integration/harness.ts#L205)) — seed `display_name` and club profile versions.
- **`scripts/smoke-test.sh`**, **`scripts/pressure-test.sh`** — update if they insert old profile rows.
- **`SKILL.md`** — document `profile.list`, `profile.update`, `clubId` requirements.

---

## Implementation sequence

1. **Database migration** — `members.display_name`, new table, view, trigger, embeddings table, backfill, embedding jobs. Update `init.sql`.

2. **Dev seeds and harness** — `dev.sql`, `bootstrap.sh`, `harness.ts`. Get local dev and tests running.

3. **Repository helpers** — `ensureClubProfileSeeded`, `listMemberClubProfiles`, `updateClubProfile`, `updateMemberIdentity`.

4. **`profile.list`** — new action. Delete `profile.get`.

5. **`profile.update`** — conditional `clubId` validation, split global/club writes, return `memberProfileEnvelope`.

6. **Admission acceptance** — LLM generation before transition, `ensureClubProfileSeeded` with pre-generated fields, retry guard for already-accepted admissions.

7. **Other membership creation paths** — hook `ensureClubProfileSeeded` into clubadmin create, superadmin create, club creation, owner reassignment.

8. **Search and discovery** — `clubId` required on `members.list`, `members.searchByFullText`, `members.searchBySemanticSimilarity`. Switch queries to club-scoped tables.

9. **Embedding worker** — read from `member_club_profile_versions`, write with `club_id`.

10. **Similarity and synchronicity** — `clubId` on `loadProfileVector`, club filter on embedding joins.

11. **Superadmin** — `adminGetMember` returns `memberProfileEnvelope`.

12. **Docs** — `SKILL.md`.

---

## Testing

### Migration test (unit-db)

Set up members with old global profiles and multiple memberships. Apply the migration SQL. Assert:
- `members.display_name` is backfilled correctly.
- One `member_club_profile_versions` row per active (non-left) membership.
- `version_no = 1` and `generation_source = 'migration_backfill'`.
- Content matches the old global profile.

### Integration tests (through HTTP API)

#### Profile read

- **`profile.list` returns all visible club profiles.** Member in 2 clubs with different profiles. Call without `clubId`. Assert both profiles returned with correct club refs.

- **`profile.list` with `clubId` returns one.** Pass `clubId`. Assert exactly one profile in the array.

#### Profile update

- **Club profile divergence.** Member in DogClub and CatClub. Update DogClub tagline. Assert DogClub tagline changed, CatClub tagline unchanged.

- **Identity updates remain global.** Update `displayName`. Assert the change is visible in all club profiles via `profile.list`.

- **`profile.update` identity-only, no `clubId`.** Assert success. Assert `profiles` contains all visible club profiles with the updated identity fields.

- **`profile.update` with club fields, with `clubId`.** Assert success, `profiles` has one element with updated content.

- **`profile.update` with club fields but no `clubId`.** Assert 400.

#### Profile visibility isolation

These tests are critical. A member must never see another member's profile in a club they don't share.

- **Cross-club profile isolation via `profile.list`.** Alice is in DogClub and CatClub. Bob is only in DogClub. Alice sets DogClub tagline to "dog trainer" and CatClub tagline to "cat photographer." Bob calls `profile.list` for Alice. Assert: Bob sees exactly one profile (DogClub) with tagline "dog trainer". The CatClub profile is **completely absent** — not null, not redacted.

- **Cross-club isolation via `profile.list` with `clubId`.** Bob calls `profile.list` for Alice with `clubId` = CatClub. Assert: 404.

- **No shared clubs returns 404.** Alice is only in CatClub, Bob only in DogClub. Bob calls `profile.list` for Alice. Assert: 404.

- **Isolation holds after profile update.** Alice and Bob share DogClub. Alice updates her CatClub profile. Bob calls `profile.list` for Alice. Assert: only DogClub, no CatClub content leaked.

- **Superadmin bypasses isolation.** Superadmin calls `superadmin.members.get` for Alice. Assert: sees all club profiles including clubs the superadmin is not in.

#### Membership and seeding

- **Admission acceptance seeds club profile.** Create admission with application text. Accept. Assert club profile exists with `generation_source = 'admission_generated'` and content derived from application.

- **Admission acceptance fails if LLM unavailable.** Assert admission stays in pre-acceptance state and no member/membership was created.

- **Other membership paths seed profiles.** `clubadmin.memberships.create` to add existing member to new club. Assert club profile seeded.

- **Rejoin reuses old profile.** Member leaves club, rejoins. Old profile history intact, no duplicate seed.

- **Zero-profile self.** `profile.list` for self returns identity with `profiles: []`.

#### Discovery and search

- **`members.list` requires `clubId`.** Call without `clubId`. Assert 400.

- **`members.list` uses club-scoped profile.** Call with `clubId`. Assert profile fields match that club's profile.

- **FTS is club-scoped.** Update DogClub profile with distinctive term. Search DogClub: found. Search CatClub: not found.

- **FTS requires `clubId`.** Call without `clubId`. Assert 400.

#### Admin

- **Superadmin member detail returns all club profiles.** Assert `profiles` array has entries for every club.
