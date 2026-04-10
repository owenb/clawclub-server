# Plan: Club-Scoped Member Profiles

## Context for the implementing agent

This plan has been through multiple rounds of design review and one round of implementation. It supersedes any prior version. Breaking the API is allowed and encouraged. No backward compatibility needed. The only constraint is that the existing database can be migrated.

This is an open-source project that must be correct at scale — hundreds of thousands of members under concurrent load. Every invariant is structural, enforced by foreign keys, unique constraints, triggers, and transaction boundaries.

## What we're doing

Members can belong to multiple clubs. Today, every member has one global profile. After this change, profile content is per-club. A member gets a separate profile in each club and can edit them independently.

## The design principle: identity is global, presentation is per-club

**Global identity** stays on the `members` table: `public_name`, `handle`, and `display_name`. These appear on cross-club surfaces (DMs, entity authorship, activity feeds, auth envelopes) where there is no club context.

**Club-scoped content** lives in a versioned table keyed to the membership: `tagline`, `summary`, `what_i_do`, `known_for`, `services_summary`, `website_url`, `links`, and the `profile` JSON blob.

`display_name` is identity, not content. The old system versioned it in `member_profile_versions` alongside bio and tagline. It belongs on the `members` row. After migration, `member_profile_versions` stops receiving reads or writes and can be dropped in a later cleanup migration.

---

## The four correctness invariants

### 1. Membership = profile. No exceptions, no windows.

The membership row IS the profile root. `member_club_profile_versions` has a FK to `club_memberships(id)`. Version 1 is created in the **same transaction** as the membership, as a required parameter of membership creation. There is no state where a membership exists without at least version 1. Every query can INNER JOIN to the versions table. No LEFT JOINs needed. No null-version handling. No "profile exists, no content yet" concept in the API.

### 2. The versions table is append-only and structurally consistent.

Two DB triggers enforce this:
- A `BEFORE INSERT` trigger validates that `member_id` and `club_id` match the referenced membership.
- A `BEFORE UPDATE` trigger rejects all updates. Rows are immutable once inserted. Edits append new versions.

No application convention needed. The DB rejects incorrect or mutated rows.

### 3. LLM-generated drafts are persisted once, used on every attempt.

The result is stored on the admission row as `generated_profile_draft` using a conditional write (`WHERE generated_profile_draft IS NULL`). First writer wins. Concurrent callers and retries all use the stored draft. The LLM output that reaches the profile is deterministic.

### 4. Identity and content are separate API primitives.

`members.updateIdentity` handles `handle` and `displayName` — global, no club context, no quality gate. `profile.update` handles club-scoped content only — `clubId` always required, quality gate applies. No conditional logic, no overlap.

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

Version rows FK to the membership. `member_id` and `club_id` are denormalized for query efficiency; triggers enforce correctness and immutability.

```sql
CREATE TABLE member_club_profile_versions (
    id                   short_id DEFAULT new_id() NOT NULL,
    membership_id        short_id NOT NULL,
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
    CONSTRAINT member_club_profile_versions_membership_fkey
        FOREIGN KEY (membership_id) REFERENCES club_memberships(id),
    CONSTRAINT member_club_profile_versions_member_fkey
        FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_club_profile_versions_club_fkey
        FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT member_club_profile_versions_created_by_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX member_club_profile_versions_membership_idx
    ON member_club_profile_versions (membership_id, version_no DESC);
CREATE INDEX member_club_profile_versions_member_club_idx
    ON member_club_profile_versions (member_id, club_id, version_no DESC);
CREATE INDEX member_club_profile_versions_club_member_idx
    ON member_club_profile_versions (club_id, member_id, version_no DESC);
CREATE INDEX member_club_profile_versions_search_idx
    ON member_club_profile_versions USING gin (search_vector);
```

### Trigger: denormalization consistency (BEFORE INSERT)

Validates `member_id` and `club_id` match the referenced membership.

```sql
CREATE FUNCTION member_club_profile_versions_check_membership() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    m_member_id short_id;
    m_club_id   short_id;
BEGIN
    SELECT member_id, club_id INTO m_member_id, m_club_id
    FROM club_memberships WHERE id = NEW.membership_id;

    IF m_member_id IS NULL THEN
        RAISE EXCEPTION 'membership_id % not found', NEW.membership_id;
    END IF;
    IF NEW.member_id <> m_member_id OR NEW.club_id <> m_club_id THEN
        RAISE EXCEPTION 'member_id/club_id mismatch: version has (%, %) but membership has (%, %)',
            NEW.member_id, NEW.club_id, m_member_id, m_club_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_club_profile_versions_check_membership_trigger
    BEFORE INSERT ON member_club_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION member_club_profile_versions_check_membership();
```

### Trigger: append-only enforcement (BEFORE UPDATE)

Rejects all updates. Rows are immutable once inserted.

```sql
CREATE FUNCTION reject_row_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'updates not allowed on %', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER member_club_profile_versions_no_update
    BEFORE UPDATE ON member_club_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION reject_row_update();
```

The `reject_row_update` function is generic and reusable for any append-only table.

### Trigger: search vector (BEFORE INSERT)

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

CREATE TRIGGER member_club_profile_versions_search_vector_insert
    BEFORE INSERT ON member_club_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION member_club_profile_versions_search_vector_trigger();
```

Note: `BEFORE INSERT` only — the table is append-only, so `ON UPDATE` is dead code.

### Add `generated_profile_draft` to `admissions`

```sql
ALTER TABLE admissions ADD COLUMN generated_profile_draft jsonb;
```

Stores the LLM-generated club profile fields as JSONB. Structure matches `ClubProfileFields`: `{ tagline, summary, whatIDo, knownFor, servicesSummary, websiteUrl, links, profile }`. Written once via conditional UPDATE (`WHERE generated_profile_draft IS NULL`), read at acceptance time, never modified after.

### Latest-version view

```sql
CREATE VIEW current_member_club_profiles AS
    SELECT DISTINCT ON (member_id, club_id) *
    FROM member_club_profile_versions
    ORDER BY member_id, club_id, version_no DESC, created_at DESC;
```

### Backfill

With fewer than 10 members this all runs in one migration transaction.

```sql
INSERT INTO member_club_profile_versions (
    membership_id, member_id, club_id, version_no,
    tagline, summary, what_i_do, known_for, services_summary,
    website_url, links, profile,
    created_by_member_id, generation_source
)
SELECT
    cm.id, cm.member_id, cm.club_id, 1,
    cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
    cmp.website_url, cmp.links, cmp.profile,
    cm.member_id, 'migration_backfill'
FROM club_memberships cm
LEFT JOIN current_member_profiles cmp ON cmp.member_id = cm.member_id
WHERE cm.left_at IS NULL
ON CONFLICT (member_id, club_id, version_no) DO NOTHING;
```

We use `club_memberships WHERE left_at IS NULL`. Billing access is a separate concern from profile existence.

### Club-scoped embeddings

Drop and recreate `member_profile_embeddings` with `club_id`:

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

### Update `ai_embedding_jobs`

```sql
DELETE FROM ai_embedding_jobs WHERE subject_kind = 'member_profile_version';
ALTER TABLE ai_embedding_jobs DROP CONSTRAINT ai_embedding_jobs_subject_kind_check;
ALTER TABLE ai_embedding_jobs ADD CONSTRAINT ai_embedding_jobs_subject_kind_check
    CHECK (subject_kind IN ('member_club_profile_version', 'entity_version'));
```

Then enqueue embedding jobs for all backfilled profiles:

```sql
INSERT INTO ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
SELECT 'member_club_profile_version', mcpv.id, 'text-embedding-3-small', 1536, 'v1'
FROM current_member_club_profiles mcpv
ON CONFLICT DO NOTHING;
```

**Deploy-order constraint:** The embedding worker must handle `member_club_profile_version` in the same deploy as this migration.

### Migration file

All of the above goes in a single numbered SQL migration under `db/migrations/`.

### Update `db/init.sql`

Target schema. Remove old `member_profile_versions` table/view/trigger. Add everything above.

---

## Membership creation: always creates version 1

Every membership creation path takes initial profile fields as a **required parameter** and inserts both the membership row and version 1 in the **same transaction**. There is no separate seeding step. There is no helper to call after. The transaction either commits both or neither.

### What callers provide as initial profile fields

- **Admission acceptance:** The stored `generated_profile_draft` from the admission row (LLM-generated).
- **Admin/superadmin adding a member:** Copy from the member's most recent club profile (by `created_at`) in any other club. If none, empty fields (null text, `[]` links, `{}` profile).
- **Club creation (owner membership):** Empty fields.
- **Owner reassignment:** Copy from the member's most recent club profile, or empty.

### The five membership creation paths

Each path already runs in a transaction. The version 1 INSERT is added inside that same transaction, immediately after the membership INSERT.

1. **`createMembership`** ([src/identity/memberships.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/memberships.ts)) — takes a required `initialProfile: { fields: ClubProfileFields, generationSource: string }` parameter. Inserts version 1 after the membership INSERT, inside the existing `withTransaction`.

2. **`createMembershipAsSuperadmin`** ([src/identity/memberships.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/memberships.ts)) — same pattern.

3. **Admission acceptance** ([src/postgres.ts](/Users/owen/Work/ClawClub/clawclub-server/src/postgres.ts)) — calls `createMembership` with `initialProfile` populated from the stored admission draft.

4. **`createClub`** ([src/identity/clubs.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/clubs.ts)) — creates owner membership with empty profile fields.

5. **`assignClubOwner`** ([src/identity/clubs.ts](/Users/owen/Work/ClawClub/clawclub-server/src/identity/clubs.ts)) — ensures new owner membership with profile fields copied from another club or empty.

### Rejoin behavior

When a member leaves and rejoins, `club_memberships` has a unique constraint on `(club_id, member_id)` — the row is reused. The old version history is preserved. The rejoin path does not go through `createMembership` — it transitions the membership state. No new version 1 is created. The existing versions remain.

### Concurrent creation

Only one `createMembership` call can succeed for a given `(member_id, club_id)` because of the unique constraint on `club_memberships(club_id, member_id)`. Since version 1 is inside the same transaction, there is no race.

---

## API changes

### Delete `profile.get`

Remove it. Replace with `profile.list`.

### `profile.list`

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

`version` is always present — never null. Every membership has at least version 1.

**Visibility rules:**
- For self: return club profiles for current memberships (`left_at IS NULL`). A member does not see profiles for clubs they have left, even though the version history is preserved for future rejoins.
- For another member: return club profiles only in clubs shared between actor and target (via `accessible_club_memberships`).
- If `clubId` is provided: filter to that one club.
- Zero shared clubs with another member: return 404.

All queries INNER JOIN to `current_member_club_profiles`. No LEFT JOINs, no null handling.

### `members.updateIdentity` (new action)

Global identity updates. No club context. No quality gate.

**Input:**
```typescript
{
  handle?: string
  displayName?: string
}
```

At least one field required. Otherwise 400.

**Output:**
```typescript
{
  memberId: string
  publicName: string
  handle: string | null
  displayName: string
}
```

### `profile.update` (club-scoped content only)

**Input:**
```typescript
{
  clubId: string                    // always required
  tagline?: string | null
  summary?: string | null
  whatIDo?: string | null
  knownFor?: string | null
  servicesSummary?: string | null
  websiteUrl?: string | null
  links?: unknown[]
  profile?: Record<string, unknown>
}
```

`clubId` always required. At least one content field must be present. Otherwise 400. Quality gate: `'profile-update'`.

**Output:** `memberProfileEnvelope` — identity plus all visible club profiles after the write.

### `clubId` required on list and search

`members.list`, `members.searchByFullText`, `members.searchBySemanticSimilarity` — `clubId` required on all three.

All queries INNER JOIN to `current_member_club_profiles` on `(member_id, club_id)`. Members always have at least version 1, so INNER JOIN never drops rows.

**Full-text search:** `member_club_profile_versions.search_vector`, joined on `club_id`. `OR` against `members.public_name` / `members.display_name` for name matching.

**Semantic/vector search:** `AND mpe.club_id = $clubId` on embedding join.

**Similarity functions:** `loadProfileVector(pool, memberId, clubId)`. `findSimilarMembers` and `findMembersMatchingEntity` add club filter.

**Synchronicity matcher:** Already club-scoped. Once similarity functions filter by club, matching automatically uses the right profile vector.

---

## Response types

### Delete `memberProfile`

### `memberIdentity` (new)

```typescript
export const memberIdentity = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
});
```

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

`version` is always present. Not nullable.

### `memberProfileEnvelope`

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

Keep shape. Data source changes to club-scoped profile.

### `adminMemberDetail`

Replace `profile: memberProfile | null` with `memberProfileEnvelope`. Superadmin sees all club profiles.

---

## LLM profile generation on admission

### Generate and persist the draft

The handler knows `nextStatus === 'accepted'`, so it:

1. Reads `admissions.generated_profile_draft`. If already populated, uses the stored draft (skip to step 5).
2. Loads admission details and club context (read-only queries).
3. Calls the LLM to generate club profile fields. If the LLM fails, returns an error — admission stays in its previous state.
4. Stores the result using a conditional write:
   ```sql
   UPDATE admissions SET generated_profile_draft = $1
   WHERE id = $2 AND generated_profile_draft IS NULL
   ```
   If this returns 0 rows affected, another concurrent caller already stored a draft. Re-read the stored draft and use it. First writer wins.
5. Proceeds with `transitionAdmission` (commits admission status).
6. Creates member/membership with version 1 from the stored draft (all in one transaction via `createMembership`).

### Why this is correct

- **Deterministic.** The conditional `WHERE generated_profile_draft IS NULL` ensures first-writer-wins. All subsequent reads get that same draft.
- **Concurrent-safe.** Two admins click accept simultaneously. Both call the LLM. Both attempt the conditional write. One wins. The loser re-reads the winner's draft. Both proceed with the same content.
- **Retry-safe.** The draft is stored before the transition. Retry finds it populated, skips the LLM, uses the stored content.
- **LLM not on the retry path.** If the draft is stored, the LLM is never called again for that admission.

### Already-accepted retry

1. Handler sees admission is already `accepted`. Skips the transition.
2. `generated_profile_draft` is already stored. Uses it.
3. Finds existing member/membership via three-layer retry check.
4. Membership exists → version 1 exists (created atomically). If so, no-op.
5. If membership was created but the transaction that would have written version 1 failed (edge case — the membership INSERT committed but version INSERT didn't in the same tx), retry creates the membership again via the idempotent path, which includes version 1.

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

`superadmin.members.get` returns `memberProfileEnvelope` with all club profiles regardless of actor scope.

---

## Surfaces that stay global

- **Auth envelopes** — `member.publicName` from `members` table.
- **DMs** — counterpart names from `members.public_name` and `members.handle`.
- **Entity/event authorship** — author name from `members.public_name`.
- **Admission records** — applicant name/email from `members` and `member_private_contacts`.
- **Activity feed payloads** — names inline in JSONB, historical snapshots.

---

## Tooling and dev infrastructure

- **`db/init.sql`** — target schema. Remove old `member_profile_versions`/view/trigger.
- **`db/seeds/dev.sql`** — seed `members.display_name` and `member_club_profile_versions` with `membership_id`.
- **`scripts/bootstrap.sh`** — set `members.display_name`. No profile (no club at bootstrap time).
- **`test/integration/harness.ts`** — seed `display_name` and club profile versions with correct `membership_id`. Every `seedClubMember` call must include initial profile fields.
- **`scripts/smoke-test.sh`**, **`scripts/pressure-test.sh`** — update if they insert old profile rows.
- **`SKILL.md`** — document `profile.list`, `profile.update`, `members.updateIdentity`, `clubId` requirements.

---

## Implementation sequence

1. **Database migration** — `members.display_name`, `member_club_profile_versions` with `membership_id` FK and three triggers (consistency, append-only, search vector), `generated_profile_draft` on admissions, embeddings table, backfill, embedding jobs. Update `init.sql`.

2. **Dev seeds and harness** — `dev.sql`, `bootstrap.sh`, `harness.ts`. Every membership seed includes version 1.

3. **Membership creation** — add required `initialProfile` parameter to `createMembership` and `createMembershipAsSuperadmin`. Insert version 1 inside the same transaction. Update `createClub` and `assignClubOwner` to provide initial profile fields.

4. **`profile.list`** — new action. Delete `profile.get`. INNER JOIN to `current_member_club_profiles`.

5. **`members.updateIdentity`** — new action. No club context, no quality gate.

6. **`profile.update`** — club-scoped only. `clubId` always required. Quality gate.

7. **Admission acceptance** — check/generate/store draft (conditional write), pass stored draft as `initialProfile` to `createMembership`.

8. **Search and discovery** — `clubId` required on `members.list`, `members.searchByFullText`, `members.searchBySemanticSimilarity`. INNER JOIN to club-scoped tables.

9. **Embedding worker** — read from `member_club_profile_versions`, write with `club_id`. Must ship in same deploy as step 1.

10. **Similarity and synchronicity** — `clubId` on `loadProfileVector`, club filter on embedding joins.

11. **Superadmin** — `adminGetMember` returns `memberProfileEnvelope`.

12. **Docs** — `SKILL.md`.

---

## Testing

Non-LLM tests in `test/integration/non-llm/`. LLM tests in `test/integration/with-llm/`. All use `TestHarness` with real HTTP API and real Postgres.

### Migration test (unit-db)

- `members.display_name` backfilled correctly.
- One `member_club_profile_versions` row per active membership with correct `membership_id`.
- `version_no = 1`, `generation_source = 'migration_backfill'`.
- Content matches old global profile.

### Non-LLM integration tests

#### Profile read

- **`profile.list` returns all visible club profiles.** Member in 2 clubs with different profiles. Assert both returned with correct content.
- **`profile.list` with `clubId` returns one.**
- **`profile.list` excludes left clubs.** Member leaves a club. Assert that club's profile is no longer in self-read results.

#### Identity update

- **`members.updateIdentity` updates handle.** Assert visible in `profile.list`.
- **`members.updateIdentity` updates displayName.** Assert visible across all clubs.
- **`members.updateIdentity` with no fields.** Assert 400.
- **`members.updateIdentity` does not go through quality gate.**

#### Profile update

- **Club profile divergence.** Update DogClub tagline. Assert CatClub unchanged.
- **`profile.update` with `clubId`.** Assert response contains all visible club profiles.
- **`profile.update` without `clubId`.** Assert 400.
- **`profile.update` with no content fields.** Assert 400.
- **Rapid sequential edits.** Assert version_no increments correctly.

#### Visibility isolation

- **Cross-club isolation.** Alice in DogClub + CatClub, Bob only in DogClub. Bob sees only DogClub — CatClub completely absent.
- **Cross-club isolation with `clubId`.** Bob requests Alice's CatClub profile. Assert 404.
- **No shared clubs.** Assert 404.
- **Isolation holds after update.** Alice updates CatClub, Bob still only sees DogClub.
- **Superadmin bypasses isolation.**

#### Membership and seeding

- **New membership always has version 1.** Create membership. Immediately call `profile.list`. Assert version is present (not null), `version_no = 1`.
- **`clubadmin.memberships.create` creates version 1 atomically.** Assert `generation_source = 'membership_seed'`.
- **Seed copies from most recent profile.**
- **Seed is empty when no other profiles exist.**
- **Club creation seeds owner profile with version 1.**
- **Rejoin preserves history.** Leave club, rejoin. Old versions intact, no duplicate version 1.
- **Concurrent membership creation.** Two requests create the same (member, club) simultaneously. Assert exactly one membership and one version 1 exist (unique constraint prevents duplicates).

#### DB-level enforcement

- **Denormalization trigger rejects mismatched member_id/club_id.** Insert version with wrong member_id for the membership. Assert DB error.
- **Append-only trigger rejects updates.** Attempt to UPDATE a version row's tagline. Assert DB error.

#### Discovery and search

- **`members.list` requires `clubId`.** Assert 400.
- **`members.list` uses club-scoped profile.** Different taglines in DogClub and CatClub; assert correct per club.
- **FTS is club-scoped.** Found in DogClub, not CatClub.
- **FTS matches on global name.**
- **FTS requires `clubId`.** Assert 400.

#### Admin

- **Superadmin member detail returns all club profiles.**

### With-LLM integration tests

#### Happy path

- **Full application generates meaningful profile.** Assert `generation_source = 'admission_generated'`, summary not empty, no email leakage.
- **Draft stored on admission row.** After acceptance, assert `admissions.generated_profile_draft` is populated.
- **Profile readable via `profile.list`.**
- **Version 1 exists immediately after acceptance.** Assert `version_no = 1`, not null.

#### Incomplete input

- **Minimal application ("hi").** Assert acceptance succeeds, most fields null.
- **Empty application with only socials.**
- **Special characters and unicode.**
- **Very long application text.**

#### Cross-apply

- **Cross-apply generates club-specific profile.** New profile from new application, old profile unchanged.

#### Content quality

- **No private contact info.**
- **Profile respects club context.**

#### Draft persistence and retry

- **Draft stored before acceptance.** Assert `generated_profile_draft` populated even if admission not yet transitioned.
- **Retry uses stored draft.** Accept. Delete version row (simulate partial failure). Retry. Assert same content restored, LLM not called again.
- **Retry with LLM down.** Store draft on first attempt. Make LLM unavailable. Retry. Assert acceptance succeeds from stored draft.
- **Concurrent acceptance uses same draft.** (If testable.) Two concurrent accept calls. Assert both produce the same profile content.

---

## Plain English assessment

This design has four structural invariants, each enforced at the database level.

**Membership = profile.** Version 1 is created in the same transaction as the membership. The transaction commits both or neither. There is no state where a membership exists without a profile. Every query can INNER JOIN. No LEFT JOINs. No null handling. No "ensure" helpers. No windows.

**Append-only and consistent.** Two triggers on the versions table: one rejects all UPDATEs (rows are immutable once inserted), one validates that denormalized `member_id`/`club_id` match the referenced membership on INSERT. The DB rejects incorrect or mutated rows regardless of what application code does.

**LLM draft persisted once.** A conditional write (`WHERE generated_profile_draft IS NULL`) ensures first-writer-wins on the admission row. Concurrent callers and retries all use the same stored draft. The profile content is deterministic. The LLM is never on the retry path.

**Identity and content separated.** Two actions, two concerns, zero overlap. `members.updateIdentity` is global and ungated. `profile.update` is club-scoped and gated. No conditional `clubId` logic. No ambiguity.

The system is correct under concurrent load, correct on retry, and correct at scale. Every invariant is enforced by the database, not by application convention.
