# Kill untyped member-writable JSON surface

**Status:** Confirmed. Execute as written.
**Audit date:** 2026-04-15 (production dump, read-only)
**Blocks:** `plans/content-quality-gate-redesign.md` — gate redesign resumes after this ships.

## Why this exists

The public content surface currently has three untyped member-writable JSON columns that bypass every schema guarantee:

- `entity_versions.content` — accepted on `content.create`/`content.update` as `z.record(z.string(), z.unknown())`, returned in every content response, included in the embedding source text.
- `member_club_profile_versions.links` — accepted on `profile.update` as `z.array(z.unknown())`, returned in every profile response, flattened into the embedding source text.
- `member_club_profile_versions.profile` — accepted on `profile.update` as `z.record(z.string(), z.unknown())`, returned in every profile response. Not embedded.

Despite being named or treated as "metadata," they are de-facto public product surface with no contract. The quality gate redesign exposed this — you cannot gate a JSON blob whose shape isn't fixed.

The rule being adopted across the codebase: **any member-writable field must have an explicit contract — typed schema, validation, rendering semantics, indexing semantics, gating semantics. Untyped JSON blobs on public surface are forbidden.** Internal audit/workflow JSON on non-public tables is a separate class and stays untouched.

## Audit findings (prod dump, 2026-04-15)

Small live dataset: 20 non-deleted entities, 15 live member-club profiles.

### `entity_versions.content`

- 2 of 20 entities have non-empty content. Both are `post` kind.
- The only top-level key in production is `replyToEntityId`.
- Zero content-only entities — every non-empty row also has title/summary/body.
- `replyToEntityId` has **zero matches** in the source tree. No handler, no schema, no repository, no test reads or writes it. Those 2 rows are fossil data that got in through the `wireOptionalRecord` JSON bypass — they are the audit trail of the exact problem we are solving.

### `member_club_profile_versions.links`

- 9 of 15 profiles have non-empty links (60% usage). Avg 0.93 links per profile.
- Shapes are mixed: 10 object items, 4 raw string items.
- Object keys found in prod: `url` (10×), `type` (2×), `handle` (1×). **No `label` key exists anywhere in prod.**
- Representative samples:
  - `["https://www.linkedin.com/in/hector-pearson/"]`
  - `[{"url": "https://x.com/ag_riti", "type": "X", "handle": "@ag_riti"}]`
  - `[{"url": "https://x.com/KilianSolutions"}]`
  - `["https://linkedin.com/in/ciaranmoore91", "https://x.com/cicici__ci", "https://instagram.com/_______ciaran"]`
  - `[{"url": "https://pieterma.es", "type": "website"}]`

### `member_club_profile_versions.profile`

- 5 of 15 profiles have non-empty JSON.
- Keys found in prod: `location`, `applicantName`, `clubName`, `socials`, `admissionHighlights`, `background`, `club`, `clubSpecificNotes`, `energy`, `knownForStatement`, `name`, `socialsProvided`.
- All 5 rows are admissions-review leakage — application-generated profile drafts that stashed review-time commentary into the profile schema. None of the keys is profile display data. `applicantName` and `clubName` duplicate existing typed fields. `admissionHighlights`/`clubSpecificNotes`/`knownForStatement` belong in an admissions audit trail. `location` is the only key with any profile legitimacy, but only 5 rows and no UI exists for it.

### Legacy `entities.parent_entity_id`

- Declared dead in `plans/threaded-public-content.md:400` after migration 005 moved threading to the `content_threads` table: *"parent_entity_id remains on the table but is no longer used for public content threading. It can be dropped in a later cleanup migration."*
- FK `entities_parent_fkey` and index `entities_parent_idx` still exist.
- Referenced by views `public.live_entities` (line 1450) and `public.live_events` (line 1479).
- Drop it in the same migration — everything that survives this pass must earn its place.

## Decisions (locked)

1. **`entity_versions.content` → kill completely.** No backfill. No replacement. If a specific kind later needs structured data, it gets typed first-class columns or a per-kind extension table — never a revived JSON bucket.

2. **`member_club_profile_versions.links` → typify as `{ url: string, label: string | null }[]`.** URL validated, label max 100 chars, array max 20 items. Migration normalizes every existing shape.

3. **`member_club_profile_versions.profile` → kill completely.** No backfill. No replacement. The 5 rows of admissions leakage get dropped with the column.

4. **`entities.parent_entity_id` → drop the column, FK, and index.** Dependent views recreated without it.

5. **Internal-only metadata columns → untouched.** `entities.metadata`, `club_memberships.metadata`, `member_bearer_tokens.metadata`, `notifications` payload, `entity_embeddings.metadata`, etc. are server-set audit/workflow data, not member-writable public surface. They stay.

## Migration 012 spec

File: `db/migrations/012_kill_untyped_json_surface.sql`

### Ordered steps

Follow these steps in order. The ordering is load-bearing — several CLAUDE.md pitfalls apply.

1. **Drop dependent views** that reference `parent_entity_id` or `entity_versions.content`:
   - `public.live_events` (depends on `live_entities`, drop first)
   - `public.live_entities`
   - Any other view that transitively selects either column — check via `pg_depend` / `pg_views`. Do not use `DROP VIEW ... CASCADE` blindly; enumerate the views so they can be reliably recreated at the end.

2. **Drop the immutability trigger** on `member_club_profile_versions`:
   ```sql
   DROP TRIGGER member_club_profile_versions_immutable ON public.member_club_profile_versions;
   ```
   The trigger fires `BEFORE DELETE OR UPDATE ... FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation()` and will block the in-place links rewrite. This is a controlled one-time exception, identical to the unified-join migration pattern.

3. **Normalize `links`** in place. Mapping (source shape → target shape):

   | Source | Target |
   |---|---|
   | `"https://..."` (raw string item) | `{"url": $s, "label": null}` |
   | `{"url": $u}` | `{"url": $u, "label": null}` |
   | `{"url": $u, "type": $t}` | `{"url": $u, "label": $t}` |
   | `{"url": $u, "handle": $h}` | `{"url": $u, "label": $h}` |
   | `{"url": $u, "type": $t, "handle": $h}` | `{"url": $u, "label": $h}` (handle wins) |
   | `{"url": $u, "label": $l, ...}` (already typed) | `{"url": $u, "label": $l}` (idempotent) |
   | anything else | `RAISE EXCEPTION` — fail loud, do not silently drop |

   After the rewrite, assert every item is `{url, label}`:
   ```sql
   DO $$
   DECLARE bad_count integer;
   BEGIN
     SELECT count(*) INTO bad_count
     FROM public.member_club_profile_versions, jsonb_array_elements(links) AS item
     WHERE jsonb_typeof(item) <> 'object'
        OR NOT (item ? 'url')
        OR NOT (item ? 'label');
     IF bad_count > 0 THEN
       RAISE EXCEPTION 'links normalization left % malformed items', bad_count;
     END IF;
   END $$;
   ```

4. **Recreate the immutability trigger** on `member_club_profile_versions` before any other table changes touch it. Use the exact same definition as `db/init.sql:2731`.

5. **Drop the dead columns**:
   ```sql
   ALTER TABLE public.entity_versions              DROP COLUMN content;
   ALTER TABLE public.member_club_profile_versions DROP COLUMN profile;
   ```

6. **Drop `parent_entity_id`** and its FK/index:
   ```sql
   ALTER TABLE public.entities DROP CONSTRAINT entities_parent_fkey;
   DROP INDEX public.entities_parent_idx;
   ALTER TABLE public.entities DROP COLUMN parent_entity_id;
   ```

7. **Recreate the views** dropped in step 1, now without `parent_entity_id` or `content` projections. Preserve all other columns exactly.

8. **Schema_migrations bookkeeping** via the standard `scripts/migrate.sh` path.

### Synthetic pre-migration test data (required)

Per CLAUDE.md: empty-DB migration tests are not migration tests. Before running against a real prod-shaped database, build a scratch DB with the pre-migration schema and seed it with every link shape the migration must handle:

```
# from CLAUDE.md "Migration tests MUST use representative pre-migration data"
1. git show <pre-migration-commit>:db/init.sql > /tmp/init_pre.sql
2. Create a fresh scratch DB, provision clawclub_app, apply /tmp/init_pre.sql
3. Record migrations 001..011 as already applied in public.schema_migrations
4. INSERT synthetic fixtures below
5. Run scripts/migrate.sh against the scratch DB
6. Query the results and verify every rewrite matches the mapping table
```

Required synthetic rows (all on live, non-archived entities/profiles):

- A profile with `links = '[]'::jsonb` (empty → unchanged)
- A profile with `links = '["https://example.com"]'::jsonb` (raw string only)
- A profile with `links = '[{"url":"https://example.com"}]'::jsonb` (url only)
- A profile with `links = '[{"url":"https://x.com/foo","type":"X"}]'::jsonb` (type only)
- A profile with `links = '[{"url":"https://x.com/foo","handle":"@foo"}]'::jsonb` (handle only)
- A profile with `links = '[{"url":"https://x.com/foo","type":"X","handle":"@foo"}]'::jsonb` (both — verify handle wins)
- A profile with mixed items: `'[{"url":"https://a"},"https://b"]'::jsonb`
- A profile with already-typed items: `'[{"url":"https://a","label":"alpha"}]'::jsonb` (idempotency — must be preserved exactly)
- A profile with 10+ items to exercise array-level handling
- An entity with `content = '{"replyToEntityId":"xxx"}'::jsonb` (to exercise drop on populated rows, matching the real prod data)
- A profile with `profile = '{"location":"London","applicantName":"x"}'::jsonb` (to exercise drop on populated rows)
- An entity with `parent_entity_id IS NOT NULL` (if such rows exist in prod; migration 005's assertions suggest they shouldn't, but confirm)

After running the migration, assert each row has the expected post-migration shape. Any rewrite that fails must `RAISE EXCEPTION` — never silently drop data.

### Pre-cutover prod queries

Before pushing the migration to prod, re-run the audit queries against the current prod DB (not the dump) and confirm no new shapes have appeared. Per CLAUDE.md, read-only prod queries are allowed via superadmin tooling; no direct writes.

## Application code changes

### Wire schemas

**`src/schemas/entities.ts`:**
- Remove `content: wireOptionalRecord` from the `content.create` wire input (around line 181).
- Remove `content: z.record(z.string(), z.unknown()).optional()` from the `content.update` wire input (around line 282).
- Remove corresponding `content: parseOptionalRecord` from parse inputs (around lines 197 and 295).
- Remove `content` from the `CreateInput` and `UpdateInput` type definitions.
- Update `validateCreatePayload` (line 95): drop the `hasContent` branch; the rule becomes "require at least one of title/summary/body, or (for kind=event) a valid event sub-object."

**`src/schemas/profile.ts`:**
- Replace `links: wireLinks` with a typed array:
  ```ts
  links: z.array(z.object({
    url: z.string().url().max(500),
    label: z.string().max(100).nullable(),
  })).max(20).optional()
  ```
- Remove `profile: wireProfileObject` entirely.
- Parse schema: mirror the wire, trim the URL, trim the label (null on empty).

**`src/schemas/fields.ts`:**
- `wireLinks` and `wireProfileObject` are only used by `profile.ts` — delete both after the profile schema change lands.
- `wireOptionalRecord` / `parseOptionalRecord` are still used by `accessTokens.create.metadata` (line 98 of `platform.ts`) and `clubadmin.memberships.create.metadata` (line 195 of `clubadmin.ts`). Those are internal/admin metadata, not member public surface — **leave them untouched**.
- `wireRequiredRecord` — grep usages before removing; if nothing else uses it after this change, delete it.

### Response schemas

**`src/schemas/responses.ts`:**
- `contentEntity.version.content` (line 293) — remove the field entirely.
- `clubProfile.links` (line 237) — change from `z.array(z.unknown())` to the typed `{url, label}[]` shape.
- `clubProfile.profile` (line 238) — remove the field entirely.
- Grep for any other response schema that projects these fields; remove similarly.

### Handlers and repositories

Grep scope for `content` usage on entity versions: the earlier audit found 13 files that mention content in some form — not all are affected, but trace each one:

- `src/clubs/entities.ts`:
  - Entity insert path (~line 666): remove `content: JSON.stringify(input.content ?? {})`.
  - Entity update path (~line 754): remove the `content` merge case.
- `src/workers/embedding.ts`: update the entity embedding build to pass the new shape (no `content` field).
- `src/embedding-source.ts`:
  - `buildEntitySourceText` (line 85): delete the `Content:` section entirely and remove `content` from `EntitySourceInput`.
  - `buildEventSourceText` (line 111): same treatment.
  - `buildProfileSourceText` (line 49): update the `links` flattening block to produce `label ?? url` per item (since we now have a typed shape; items with null label fall back to the URL itself).
- Profile handlers (grep for `profile.update` handler — likely in `src/clubs/` or a `profile/` module): remove all write/read of the `profile` column; keep `links` but treat it as the typed shape (no casting, no coercion).
- Any response builder that projects `version.content` or `clubProfile.profile` or raw `links` items: fix to match the new shape.
- `src/http-smoke.ts` and `scripts/smoke-test.sh`: update any content/profile/links exercise to use the new API shapes.

### `db/init.sql`

**Per CLAUDE.md ordering**: do NOT edit `init.sql` until the migration has been tested and verified against synthetic pre-migration data. `init.sql` reflects the target state after migrations run.

When it's time to update:
- `entity_versions`: remove `content jsonb` column.
- `member_club_profile_versions`: remove `profile jsonb`; `links jsonb` stays but its contract is now documented as the typed shape.
- `entities`: remove `parent_entity_id`.
- Drop FK `entities_parent_fkey` and index `entities_parent_idx`.
- Update views `live_entities` (line 1450) and `live_events` (line 1479) to remove both `parent_entity_id` and `content` projections.
- Check for any other view or function that references the dropped columns.

### `db/seeds/dev.sql`

Update any seed rows that populate `content`, `profile`, or untyped `links` shapes. Reset-dev must pass cleanly post-migration.

## Embedding rebuild (post-migration)

After the migration ships and code is deployed:

- Rebuild entity embeddings for all entities (source text no longer includes `content` → `source_hash` changes on every row).
- Rebuild profile embeddings for all profiles with links (flattened `links` string will change because the typed shape produces different output for some rows).

Prod is ~35 total rows (20 entities + 15 profiles) — rebuild is trivial. Either add a one-off script under `scripts/` that iterates and re-embeds, or trigger via the existing embedding worker. Document which path was taken in the commit message.

## Test updates

### Integration tests

- Any test that passes `content: {...}` on `content.create` or `content.update` — remove the argument. Tests write via title/summary/body going forward.
- Any test that asserts on a response `content` field — delete the assertion.
- Any test that passes untyped `links` shapes on `profile.update` — convert to the typed `{url, label}[]` shape.
- Any test that passes `profile: {...}` on `profile.update` — remove the argument. If the test was asserting something was persisted back, decide whether to drop the test or replace with a meaningful assertion against a real profile field.

### Unit tests

- Any unit test on the `validateCreatePayload` `hasContent` branch — delete.
- Any unit test that serializes an entity version with `content` — update.
- Any unit test that serializes a club profile with `profile` — update.

### Snapshot

- `test/snapshots/api-schema.json` regenerates after the wire schema changes. Check the diff is clean (no unexpected removals elsewhere).

## Verification checklist

Do not consider the work complete until every item below passes:

1. Migration 012 tested against synthetic pre-migration data covering every link-shape variant in the mapping table. All expected rewrites verified. All unexpected shapes raised.
2. `scripts/migrate.sh` applies the migration cleanly from the pre-migration schema.
3. `db/init.sql` updated to reflect target state.
4. `scripts/reset-dev.sh` rebuilds from the updated `init.sql` without errors.
5. `npx tsc --noEmit` passes.
6. `npm run test:unit` passes.
7. `npm run test:unit:db` passes.
8. `npm run test:integration:non-llm` passes.
9. `npm run test:integration:with-llm` passes. (Requires `.env.local` with `OPENAI_API_KEY`.)
10. Local smoke test via the API: create a post, update a profile with typed links, read them back. Manually confirmed.
11. Pre-cutover prod shape audit (re-run the audit queries against a current prod snapshot) — no unexpected shapes the migration doesn't cover.
12. `package.json` patch version bumped once, at commit time.

## Out of scope

- The quality gate redesign itself. That plan (`plans/content-quality-gate-redesign.md`) is paused pending this cleanup and will be revised to v5 after this ships.
- Removing unrelated JSON columns on internal-only tables (`club_memberships.metadata`, `member_bearer_tokens.metadata`, `entity_embeddings.metadata`, `notifications.payload`, etc.). Those are internal audit/workflow data, not public member-writable surface.
- Adding a typed `location` column to profiles. Only 5 rows have location data in prod and there is no UI for it. Revisit when a real feature needs it.
- Renaming or restructuring any other part of the entity/profile schema.

## Pitfalls recap (from CLAUDE.md)

- **Test migrations against synthetic pre-migration data, not empty DBs.** Data-rewrite logic that passes an empty-DB test is not tested — it has to meet real rows.
- **Drop the `member_club_profile_versions_immutable` trigger before the `links` rewrite, recreate it immediately after.** `FOR EACH ROW BEFORE UPDATE` triggers block in-place column rewrites. This is a controlled one-time exception.
- **Drop views that reference a column before dropping the column, then recreate the views at the end of the migration.** Do not rely on `CASCADE`.
- **Run migrations through `scripts/migrate.sh`**, never `psql -f` by hand. The script wraps in `--single-transaction ON_ERROR_STOP=1`, which is the real deploy path.
- **Edit `db/init.sql` only after the migration is verified.** Migration first, init.sql after.
- **Never edit a shipped migration.** Migration 012 is still local/unmerged during this work, so it is fair game to iterate on. Once merged, it is immutable.
- **Bump the patch version in `package.json` once at commit time.**
- **Never `git push` without explicit per-push user approval.** Commit locally, hand back for the user to review and approve the push.
- **Never skip hooks** (`--no-verify`, `--no-gpg-sign`, etc.) unless explicitly requested. Fix the underlying hook failure.
- **Never use destructive git commands on the working tree.** Uncommitted work from concurrent agents may be present.

## Handoff

Once all verification items pass, commit locally and stop. Do not push. Report:

- Migration 012 path and a one-paragraph summary of what it does.
- The list of application files touched.
- Test output summary (which suites ran, any skipped).
- The two embedding-rebuild counts (entities rebuilt, profiles rebuilt).
- Any surprises encountered during synthetic-data testing.

The user will review and authorize the push separately.
