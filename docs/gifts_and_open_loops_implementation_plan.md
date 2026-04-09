# Gifts and Open Loops — Implementation Plan v3

This plan supersedes v2. It incorporates a second code review that surfaced three real issues v2 left unresolved:

1. **Reopen didn't retrigger matching.** The v2 worker would never produce new matches for a reopened loop because `reopenLoop` didn't emit any activity. Fixed by explicit activity emission on reopen (invariant 11).
2. **`offer_to_ask` cleanup was one-directional.** Closing an ask only expired matches where the ask was the `source_id`, but most `offer_to_ask` matches have the offer as source and the ask in `payload.matchedAskEntityId`. Fixed by expiring/deleting in both directions (invariant 12).
3. **Closed loops lingered in the update feed.** Already-delivered-but-unread signals kept appearing after the loop was closed. Fixed by filtering `updates.list` on loop state (invariant 13).

v3 also resolves an internal contradiction in v2 about semantic search: it now filters all closed loops regardless of caller (including the author).

Read the **Must-hold invariants** section first — those are the cross-cutting truths every change has to respect.

## Why this exists

ClawClub needs two related changes:

1. **A new `gift` content kind**, distinct from `service`. Services are paid professional offerings; gifts are free, given without expectation of payment. Members will bring different gifts to different clubs (clairvoyance in a spiritual club, code reviews in a tech club). Gifts are scoped per-club because they're entities, not a global member attribute.

2. **An `open_loop` primitive on entities** so the synchronicity engine knows what's still active vs what the member has explicitly resolved. Today the engine has TTL-based delivery throttling but no concept of *relevance* persistence. An ask that doesn't get matched in 5 days silently expires from circulation even if the member is still actively looking. Open loops fix this: an ask, gift, service, or opportunity stays a live match candidate indefinitely, and the member explicitly calls `closeLoop` when they're done.

These ship together because the gift kind needs the loop primitive to be useful, and the build is small enough to do as one piece.

## Must-hold invariants

These are the cross-cutting truths the implementer must satisfy. Every change in this plan exists to enforce one of these. If something else needs changing to keep one of these true, change it.

1. **Gift participates in offer matching.** When a `gift` entity is published, the synchronicity worker treats it like a `service` or `opportunity` — finds matching asks and writes `offer_to_ask` matches. Without this, gifts are creatable but inert. *Today the worker only checks `kind === 'service' || kind === 'opportunity'` at `src/workers/synchronicity.ts:274`.*

2. **Loopable kinds always have `open_loop` set; non-loopable never do.** Enforced by a `CHECK` constraint at the database level so raw SQL inserts (seeds, tests, future code paths) can't accidentally produce nulls for asks/gifts/services/opportunities or set non-null values for posts/events/comments/complaints. The application layer setting it isn't enough — the repo has direct-SQL inserts in seeds and tests that will silently bypass an app-layer default.

3. **Close and reopen only operate on currently-published, non-removed loopable entities.** Removed entities can't be closed or reopened. Mirror the existing `updateEntity` SQL filter pattern: `cev.state = 'published'` AND `e.deleted_at IS NULL` AND author check, all in the WHERE clause.

4. **Author auth is enforced via SQL filter, not handler check.** The existing `entitiesUpdate` handler at `src/schemas/entities.ts:142` has dead code: it does an SQL author-filter and then a handler-side `403`-on-author-mismatch branch that is unreachable because the SQL returns null first. `closeLoop`/`reopenLoop` must follow the same SQL-filter pattern but **not** add the dead 403 branch. If the entity doesn't belong to the actor, return `null` from the repo and `404 not_found` from the handler. The 403 test the v1 plan proposed will not pass.

5. **Reopen must allow rematch.** The `signal_background_matches` unique constraint is `(match_kind, source_id, target_member_id)` (`db/init.sql:1160`), and `createMatch` does `ON CONFLICT DO NOTHING`. So if a loop was matched once and then closed (matches transitioned to `delivered` or `expired`), reopening doesn't help — the worker's next pass will silently skip every recipient because the unique constraint is occupied. **Reopen must `DELETE` historical match rows** so the slate is clean. Closing still expires; reopening deletes. Note: the DELETE criteria are the same set described in invariant 12 (both source direction AND matchedAskEntityId direction for asks), not just `source_id = entity_id`. **Only do the delete when reopen causes an actual `false → true` transition** — idempotent no-op reopens should not delete anything. See Phase 2 for the read-then-update-then-conditionally-delete pattern.

6. **`open_loop` is checked at trigger time AND at delivery time.** A loop closed after activity emission can otherwise still generate a match (trigger phase) or deliver an already-pending one (delivery phase). Both `processEntityTriggers` (around `src/workers/synchronicity.ts:234`) and `deliverOneMatch` (around line 666) need open-loop guards. The trigger guard is in addition to the existing `e.deleted_at is null` check; the delivery guard is in addition to the existing `isEntityPublished` check.

7. **Closed loops are visible only to the author, and only via `content.list` with `includeClosed: true`.** `content.list` already accepts `actorMemberId` via the handler context — but the SQL at `src/clubs/entities.ts:307` doesn't currently use it for any filtering. When `includeClosed: true`, the SQL must filter to the actor's own entities only: `WHERE (open_loop IS NULL OR open_loop = true OR e.author_member_id = $actor)`. Without the actor filter, `includeClosed: true` is a privacy leak — any member can list everyone's closed asks/gifts/services in shared clubs.

  **Semantic search is different: it always excludes closed loops, even from the author.** `findEntitiesViaEmbedding` at `src/clubs/index.ts:459` filters out all closed loops unconditionally (`AND (e.open_loop IS NULL OR e.open_loop = true)`). No `actorMemberId` parameter needed for this filter, no `includeClosed` flag. Rationale: search returns "currently relevant content." If an author wants to find their own closed history, they use `content.list` with `includeClosed: true`. Keeps search behavior simple and privacy-safe by default.

8. **`admissions.getMine` returns a member-safe shape, not the admin shape.** The admin shape at `src/postgres.ts:492-525` includes `state.notes`, `metadata`, `intake.*`, `sponsor.*`, `admissionDetails`, `membershipId`, `applicantEmail`, and other fields that should not be reflected back to applicants. Define a **new** member-safe response shape with only the fields the member legitimately needs to see: their own application text, status, club identity, timestamps. Do not reuse `AdmissionRecord` from the admin path.

9. **Synchronicity helpers must filter `expires_at` consistently with `live_entities`.** `content.list` goes through the `live_entities` view, which filters out expired content. But `findAskMatchingOffer` (`src/workers/similarity.ts:151`) and the embedding-search path bypass `live_entities` and join `entities` directly. So an "open" loop with a passed `expires_at` would silently disappear from listings while still being matchable and searchable. Add `(expires_at IS NULL OR expires_at > now())` to the matching helpers' candidate queries when they touch loopable entities. (Note: gifts default to no `expires_at`, so this is mostly a hygiene fix, not a daily-driver bug. But the inconsistency is a footgun.)

10. **`entity_kind` is a Postgres enum, not text.** Adding `gift` requires `ALTER TYPE entity_kind ADD VALUE 'gift'`, not a string-only change. The current enum at `db/init.sql:60` is `('post', 'opportunity', 'service', 'ask', 'event', 'comment', 'complaint')`. The API-facing enum at `src/schemas/fields.ts:14` is a separate, narrower set — also needs updating. Both must agree.

11. **Reopen retriggers matching via explicit activity emission.** The synchronicity worker reacts to `club_activity` rows with topic `entity.version.published` (around `src/workers/synchronicity.ts:198-308`). Reopen does not create a new entity version — so by default it produces no activity row and the worker never revisits the reopened entity. Clearing historical match rows (invariant 5) is necessary but not sufficient: the slate is clean but no scan is ever triggered. **`reopenEntityLoop` must insert a `club_activity` row for the current published version of the entity, with topic `entity.version.published`**, after the state transition and the historical match delete. The worker's existing trigger pipeline then picks it up on its next pass and re-runs matching. Mirror the insert pattern used when an entity is originally published (check how `createEntity` and the entity-update path emit their activity rows, and reuse the same shape). Emit this activity row only on actual `false → true` transitions — no-op reopens emit nothing.

12. **`offer_to_ask` cleanup follows both match directions.** When an ask is closed, the matches to expire/delete are in two shapes:
    - Matches where `source_id = entityId` and `match_kind = 'ask_to_member'` (the ask looking for members).
    - Matches where `match_kind = 'offer_to_ask'` and `payload->>'matchedAskEntityId' = entityId` (offers that were matched to this ask — the ask is on the *target* side of the match, not the source).

    v2's SQL only covered the first shape (`source_id = $entityId AND match_kind IN ('ask_to_member', 'offer_to_ask')`), so stale `offer_to_ask` matches for closed asks survived closure and could still be delivered. The worker already has the ask-edit expiry pattern with this exact shape around `src/workers/synchronicity.ts:163` — copy it. Apply to both close (expire) and reopen (delete). For gifts/services/opportunities being closed, only the `source_id` direction exists, but the SQL for the payload direction is harmless (no rows match) so it's safe to always include both clauses.

13. **Closed loops disappear from `updates.list` immediately.** `updates.list` (`src/postgres.ts:938`) assembles a merged feed from `signal_deliveries`, club activity, and DM inbox entries. When a signal for `ask_to_member` or `offer_to_ask` was delivered before the loop closed and the recipient has not yet polled, that signal currently survives in the feed — the loop is "closed" on the producer side but still surfaces as if it were live. That violates the "closed loops stop being surfaced" promise. The fix: `updates.list` joins `signal_deliveries` to its source entity (via the delivery's source entity reference, typically `signal_deliveries.source_entity_id` or extracted from the delivery payload — verify against the worker's insertion code in `src/workers/synchronicity.ts`) and adds `AND (e.open_loop IS NULL OR e.open_loop = true)` to the WHERE clause for those signal kinds. For `offer_to_ask` specifically, *both* the source (offer) and the matchedAskEntityId (ask) need to be live-loop — if either has closed, the signal is filtered out.

## Decisions and reasoning

- **`gift` is a separate content kind, not a member profile attribute.** Gifts are per-club because members bring different gifts to different clubs. Entities are already per-club. Reusing the entity infrastructure (creation, embedding, matching, listing, removal) is much smaller than building a parallel profile-attribute system.

- **Loop semantics apply only to ongoing kinds.** Loopable set: `{ask, gift, service, opportunity}`. Posts have no lifecycle. Events have an inherent end date via `events.starts_at`/`events.ends_at`. Comments and complaints are out of scope for this primitive.

- **`open_loop` is nullable, not boolean-with-default.** A nullable column lets us cleanly distinguish "loop concept doesn't apply" (post/event/comment/complaint) from "loop is open" (`true`) and "loop is closed" (`false`). A `CHECK` constraint enforces the kind/value relationship at the DB level so all insert paths are forced to comply.

- **Naming: `openLoop` field, `content.closeLoop` and `content.reopenLoop` actions.** Two separate actions instead of one `setLoopState` because the verb is clearer for agents and easier to spec in SKILL.md. Owen's call.

- **Never insist on a fixed number of gifts.** Earlier drafts proposed "exactly three gifts." Owen overruled — most members will struggle to think of even one, and forcing more produces filler. SKILL.md guidance encourages but never enforces a count.

- **Option A for the gift onboarding flow.** Gifts are captured in the application text during application (so the reviewing admin sees them), and turned into real `gift` entities by the agent at the new member's first session via `admissions.getMine`. Owen explicitly chose this over the simpler "ask fresh at first session" path.

- **`admissions.getMine` is also useful for club admins.** Owen's framing: "let them retrieve their admission anytime and so can the club owner." Member-side via the new action. Club-side via existing `clubadmin.admissions.list` which already returns all statuses by default (`src/postgres.ts:482` uses `($2::text[] is null or ca.status::text = any($2::text[]))` — no filter when `statuses` is null). No enhancement needed there.

- **`closeLoop` and `reopenLoop` are author-only.** No moderation surface in this round. If we need clubadmins to close other members' loops later, mirror the `clubadmin.content.remove` pattern.

- **No reason field on `closeLoop`.** Keep simple. Add later if needed.

- **No legality gate on `closeLoop` / `reopenLoop`.** They don't create new user-facing content, just flip state on an entity that was gated at creation.

- **Idempotent close/reopen.** Closing an already-closed loop succeeds. Reopening an already-open loop succeeds. Standard idempotent semantics. **Side effects only fire on actual state transitions.** A no-op reopen (already open) does not delete match history, does not emit a retrigger activity row. A no-op close (already closed) does not expire matches a second time. See Phase 2 for the read-then-transition-then-act pattern.

- **Reopen emits a `club_activity` row.** v2 originally said no — v3 reverses this. Without an activity emission, the worker never revisits the reopened entity (see invariant 11). The emission uses the existing `entity.version.published` topic for the current version, so no new worker code path is needed, only a new insertion site in the repo layer.

- **Semantic search never returns closed loops.** Not even to the author. The author can use `content.list` with `includeClosed: true` to find their own closed history. This resolves a v2 contradiction where invariant 7 and Phase 4 gave different answers.

- **`expires_at` defaults to null for all kinds (already true).** No change needed at the schema layer; gifts will inherit the existing nullable default. SKILL.md tells the agent not to set `expires_at` on loopable kinds unless the user explicitly says it's time-bounded.

## Build order

The order matters because some changes depend on invariants set by earlier ones, and a half-done state breaks the build.

### Phase 1: Lock invariants in the schema and types

This phase ships as a single coordinated change. Don't split it across commits — doing so leaves the repo in a state where the type system disagrees with the schema.

1. **Postgres enum** (`db/init.sql:60`): `ALTER TYPE entity_kind ADD VALUE 'gift'` — or, since this is greenfield with `reset-dev.sh`, just add `'gift'` to the literal enum definition.

2. **`entities` table** (`db/init.sql:502`): add column.
   ```sql
   open_loop boolean,
   CONSTRAINT entities_open_loop_kind_check CHECK (
     (kind IN ('ask', 'gift', 'service', 'opportunity') AND open_loop IS NOT NULL)
     OR (kind NOT IN ('ask', 'gift', 'service', 'opportunity') AND open_loop IS NULL)
   )
   ```
   The CHECK constraint is the enforcement mechanism for invariant 2. It applies to *every* insert path including raw SQL in seeds and tests. Without it, raw inserts will silently produce nulls for loopable kinds and the worker filters will hide them.

3. **Backfill seeds** (`db/seeds/dev.sql` around line 401, plus any test fixtures that insert raw entity rows). Every raw INSERT into `entities` for kind in (`ask`, `service`, `opportunity`) must set `open_loop = true`. Existing `gift` rows don't exist yet. After this change, the CHECK constraint will reject any raw insert that violates the invariant — so this is also where you discover everywhere else that needs updating. Search the repo for `INSERT INTO entities` and audit each call site.

4. **API enum** (`src/schemas/fields.ts:14`): add `'gift'` to the `entityKind` z.enum. Also update `parseEntityKinds` default at line 284 to include `'gift'`.

5. **Contract types** (`src/contract.ts:404`): add `'gift'` to the `EntityKind` union. Add `openLoop: boolean | null` to `EntitySummary` (line 407-429).

6. **Response zod** (`src/schemas/responses.ts:209`): add `openLoop: z.boolean().nullable()` to the `entitySummary` schema.

7. **`EntityRow` and `mapEntityRow`** (`src/clubs/entities.ts:40`, `60`, `82`): add `open_loop` to `EntityRow`, include `e.open_loop` in `ENTITY_SELECT`, surface it as `openLoop` in `mapEntityRow`.

8. **`CreateEntityInput`** (`src/contract.ts` near the EntityKind definitions): no new field (the application layer derives `openLoop` from `kind`, doesn't take it as input). Just confirm the type doesn't need to change.

9. **Superadmin schema usage** (`src/schemas/superadmin.ts:482`): if it has a hardcoded entity-kind union, update it.

10. **Schema snapshot**: if the project has a snapshot/checked-in `api/schema` artifact (check `test/integration/smoke.test.ts:244` and surrounding), regenerate it. The smoke test is likely asserting on the kind list.

11. **Type-check**: `npx tsc --noEmit`. Should pass before moving on.

### Phase 2: Repository layer (entity create + close/reopen + list)

1. **`createEntity`** (`src/clubs/entities.ts:115`): when inserting into `entities`, set `open_loop = true` if `input.kind` is in the loopable set, else `NULL`. The CHECK constraint will catch any miss.

2. **New repo method `closeEntityLoop`**: takes `{ actorMemberId, accessibleClubIds, entityId }`. Transaction with three steps: read current state, update, conditionally expire matches.

   **Step 1** — read current state (to enforce "side effects only on transitions"):
   ```sql
   SELECT e.open_loop AS prev_open_loop
   FROM entities e
   JOIN current_entity_versions cev ON cev.entity_id = e.id
   WHERE e.id = $entityId
     AND cev.state = 'published'
     AND e.deleted_at IS NULL
     AND e.author_member_id = $actorMemberId
     AND e.club_id = ANY($accessibleClubIds::text[])
     AND e.open_loop IS NOT NULL
   ```
   If no row, return `null` (handler maps to 404). The `open_loop IS NOT NULL` predicate enforces invariant 3 at the row level (can't close a non-loopable entity).

   **Step 2** — update state:
   ```sql
   UPDATE entities SET open_loop = false WHERE id = $entityId
   RETURNING id
   ```

   **Step 3** — only if `prev_open_loop = true` (actual `true → false` transition), expire pending matches in both directions (invariant 12):
   ```sql
   UPDATE signal_background_matches
   SET state = 'expired'
   WHERE state = 'pending'
     AND (
       (source_id = $entityId AND match_kind IN ('ask_to_member', 'offer_to_ask'))
       OR (match_kind = 'offer_to_ask' AND payload->>'matchedAskEntityId' = $entityId)
     )
   ```
   On `prev_open_loop = false` (no-op close on already-closed loop), skip the expiry entirely and still return success (idempotent).

   Return the updated entity summary after re-selecting it through the existing `mapEntityRow` path.

3. **New repo method `reopenEntityLoop`**: same pattern as close — read, update, then conditionally act. Takes `{ actorMemberId, accessibleClubIds, entityId }`. Transaction with four steps.

   **Step 1** — read current state (auth + transition check):
   ```sql
   SELECT e.open_loop AS prev_open_loop, e.club_id, e.kind::text AS kind,
          cev.id AS current_version_id
   FROM entities e
   JOIN current_entity_versions cev ON cev.entity_id = e.id
   WHERE e.id = $entityId
     AND cev.state = 'published'
     AND e.deleted_at IS NULL
     AND e.author_member_id = $actorMemberId
     AND e.club_id = ANY($accessibleClubIds::text[])
     AND e.open_loop IS NOT NULL
   ```
   If no row, return `null` (404).

   **Step 2** — update state:
   ```sql
   UPDATE entities SET open_loop = true WHERE id = $entityId RETURNING id
   ```

   **Step 3** — only if `prev_open_loop = false` (actual `false → true` transition), `DELETE` historical match rows in both directions (invariants 5 and 12):
   ```sql
   DELETE FROM signal_background_matches
   WHERE
     (source_id = $entityId AND match_kind IN ('ask_to_member', 'offer_to_ask'))
     OR (match_kind = 'offer_to_ask' AND payload->>'matchedAskEntityId' = $entityId)
   ```
   This frees the unique constraint so the worker's next pass can produce fresh matches against the same recipients.

   **Step 4** — only if `prev_open_loop = false`, emit a `club_activity` row that the synchronicity worker will pick up (invariant 11). Use the same insert shape that the initial publish path uses — topic `entity.version.published`, pointing at `current_version_id` from step 1, with `entity_id`, `club_id`, and `actor_member_id` set accordingly. **Find the canonical insert site** by searching for `entity.version.published` in `src/clubs/` (likely in `createEntity` or the entity-version creation helper) and mirror its shape exactly; don't hand-roll an inconsistent variant. This row does *not* correspond to a new entity version — it's a second activity row for the same version, purely to re-trigger the worker.

   **No-op reopen path** — if `prev_open_loop = true`, skip steps 3 and 4 entirely. Return the entity summary as-is.

4. **`listEntities`** (`src/clubs/entities.ts:307`): add `actorMemberId: string` and `includeClosed: boolean` to the input type. Update the SQL to add a closed-loop filter:
   ```sql
   AND (
     le.open_loop IS NULL                           -- non-loopable kinds always pass
     OR le.open_loop = true                         -- open loops always pass
     OR ($actor IS NOT NULL AND e.author_member_id = $actor AND $includeClosed)  -- closed loops only for own author
   )
   ```
   This makes invariant 7 a SQL-enforced property of `listEntities`, not a handler-layer check. Note: the join already goes through `live_entities` which exposes `open_loop` via the view definition — update the view in `db/init.sql:1398` to include `e.open_loop AS open_loop`.

5. **`findEntitiesViaEmbedding`** (`src/clubs/index.ts:459`): add an unconditional closed-loop filter (no `actorMemberId` parameter, no `includeClosed` flag — invariant 7 second paragraph):
   ```sql
   AND (e.open_loop IS NULL OR e.open_loop = true)
   ```
   Also add the `expires_at` filter for invariant 9:
   ```sql
   AND (e.expires_at IS NULL OR e.expires_at > now())
   ```
   (The exact column reference depends on whether the query selects from `entities` or `entity_versions` — match what the surrounding query does.)

6. **`updates.list` feed filter** (`src/postgres.ts:938` area): implement invariant 13. The feed assembler currently joins `signal_deliveries` and surfaces all non-acknowledged deliveries. For signals of kind `ask_to_member` and `offer_to_ask`, filter out rows whose source entity (or matched ask, for `offer_to_ask`) has `open_loop = false`.

   Concrete steps:
   - Identify where the signal source entity is referenced in `signal_deliveries`. If there's a dedicated column (e.g. `source_entity_id`) use it directly. If the reference lives in the payload (`payload->>'sourceEntityId'` or similar), check the worker's insertion code in `src/workers/synchronicity.ts` around the `signal.ask_match` / `signal.offer_match` emission to find the canonical key.
   - In `updates.list`, `LEFT JOIN entities e_src ON e_src.id = <source ref>` for signal rows. Add `AND (e_src.open_loop IS NULL OR e_src.open_loop = true)` to the WHERE.
   - For `offer_to_ask` specifically, `LEFT JOIN entities e_ask ON e_ask.id = payload->>'matchedAskEntityId'` and add the same filter. Both the offer (source) and the ask (matchedAskEntityId) must be in an open-loop state; closing either hides the signal.
   - The filter applies only to signal kinds `ask_match` / `offer_match`. Other signals (`introduction`, `event_suggestion`) are unaffected — gate the join on the topic or on `match_kind IS NOT NULL`.

   This is a query-time filter, not a state mutation. No writes to `signal_deliveries`.

### Phase 3: Worker changes

1. **Add `gift` to the offer-side branch** (`src/workers/synchronicity.ts:274`):
   ```typescript
   } else if (kind === 'service' || kind === 'opportunity' || kind === 'gift') {
   ```

2. **Trigger-time `open_loop` guard** (`src/workers/synchronicity.ts:234`): when looking up the entity for matching, fetch `open_loop` and skip the entity if it's `false`:
   ```sql
   SELECT e.kind::text AS kind, e.author_member_id, cev.id AS current_version_id, e.open_loop
   FROM entities e
   JOIN current_entity_versions cev ON cev.entity_id = e.id
   WHERE e.id = $1 AND cev.state = 'published'
   ```
   Then in the handler, after `if (!entity) continue;`, add `if (entity.open_loop === false) continue;` (only skip if explicitly closed; null and true both proceed).

3. **`findAskMatchingOffer`** (`src/workers/similarity.ts:151`): add `e.open_loop = true` filter to the candidate query (target asks must be open). Also add `(cev.expires_at IS NULL OR cev.expires_at > now())` for invariant 9. Both must hold for an ask to be a candidate.

4. **`findMembersMatchingEntity`** (`src/workers/similarity.ts:80`): the source entity (the new ask) is loaded from the trigger, but the queries here only join member profiles — no entity filter needed beyond what the trigger already does. Confirm.

5. **Delivery-time `open_loop` guard** (`src/workers/synchronicity.ts:666` area): in `deliverOneMatch`, alongside the existing `isEntityPublished` check for `ask_to_member` and `offer_to_ask`, add an `is_open` check:
   ```typescript
   if (match.match_kind === 'ask_to_member' || match.match_kind === 'offer_to_ask') {
     const stillOpen = await isEntityLoopOpen(client, match.source_id);
     if (!stillOpen) { await expireAndCommit(client, match.id); return 'expired'; }
   }
   ```
   New helper:
   ```typescript
   async function isEntityLoopOpen(queryable, entityId): Promise<boolean> {
     const result = await queryable.query(
       `SELECT open_loop FROM entities WHERE id = $1`,
       [entityId],
     );
     // Loopable kind with open_loop = true: open. Otherwise: not open.
     return result.rows[0]?.open_loop === true;
   }
   ```
   For `offer_to_ask`, also re-check the matched ask via `payload.matchedAskEntityId`.

### Phase 4: Action surface

1. **`content.create`** (`src/schemas/entities.ts`): no wire/parse changes needed for `kind` since `entityKind` was updated in Phase 1. The handler already passes `kind` through to `createEntity`, which now sets `open_loop`. Just verify.

2. **`content.update`** (`src/schemas/entities.ts:106`): update path doesn't touch `open_loop`. Confirm — kind is immutable, body/title/etc don't affect loop state.

3. **`content.list`** (`src/schemas/entities.ts:234`): add `includeClosed` to wire and parse. Pass through to `listEntities`. The handler already has `actorMemberId` in `ctx.actor.member.id`; pass it through. Default `includeClosed` to `false`.

4. **`content.searchBySemanticSimilarity`** (`src/schemas/entities.ts:312`): no changes to the wire/parse layer are required for closed-loop filtering. `findEntitiesViaEmbedding` now unconditionally excludes closed loops regardless of caller (invariant 7 second paragraph). Authors who want to find their own closed history use `content.list` with `includeClosed: true`. The one thing to verify: if `actorMemberId` is already plumbed through for other reasons (e.g. club access checks), leave it; if it isn't, don't add it just for this feature.

5. **New action `content.closeLoop`**: see file `src/schemas/entities.ts`. Wire/parse takes `entityId`. Handler calls `closeEntityLoop` repo method. On `null` return, throws `404 not_found`. **Do not** add a 403 branch — the SQL already filters by author (invariant 4).

6. **New action `content.reopenLoop`**: mirror of `closeLoop`. Same author auth via SQL filter. On null, 404. No 403 branch.

7. **Register the new actions** at the bottom of `src/schemas/entities.ts`:
   ```typescript
   registerActions([entitiesCreate, entitiesUpdate, entitiesRemove, entitiesList, entitiesFindViaEmbedding, entitiesCloseLoop, entitiesReopenLoop]);
   ```

### Phase 5: `admissions.getMine`

1. **New file `src/schemas/admissions-self.ts`** with action `admissions.getMine`. Member-auth, read-only.

2. **Member-safe response shape** (defined inline or as a new type — do **not** reuse the admin shape):
   ```typescript
   const memberAdmissionRecord = z.object({
     admissionId: z.string(),
     clubId: z.string(),
     clubSlug: z.string(),
     clubName: z.string(),
     status: admissionStatus,
     applicationText: z.string().nullable(),  // the free-text the applicant wrote
     submittedAt: z.string().nullable(),
     acceptedAt: z.string().nullable(),
   });
   ```
   Explicitly excluded: `notes`, `metadata`, `sponsor`, `intake`, `membershipId`, `versionNo`, `createdByMemberId`, `admissionDetails` (other than the application text), `applicantEmail` (member already has their own email).

3. **Repo method `getAdmissionsForMember`**: takes `{ memberId, clubId? }`. Joins `current_admissions` filtered by `applicant_member_id = $memberId` (or whatever the FK is — verify against the schema). Optionally filtered by `club_id`. Returns rows mapped to `memberAdmissionRecord`.

   **Timestamp aggregation rules** — `submittedAt` and `acceptedAt` don't fall out of `current_admissions` alone, they need explicit aggregation over `admission_versions`:
   - `submittedAt` = `created_at` of the *earliest* `admission_versions` row for this admission (the first time it existed — whether that's the cold-apply submission or a sponsor nomination).
   - `acceptedAt` = `created_at` of the *most recent* `admission_versions` row with `status = 'accepted'`, or `null` if never accepted.

   Either compute these in the repo SQL with correlated subqueries / window functions, or select the full version history and fold in application code. Either is fine — just pick one and be consistent. If the underlying schema makes either rule awkward (e.g. admissions get accepted, then retracted, then re-accepted), surface the ambiguity to Owen rather than guessing.

4. **Where the application text lives**: based on the admin shape at `src/postgres.ts:492-525`, the free-text the applicant wrote is in `admission_details` (jsonb) — likely under a key like `application` or `reason`. Verify the cold-application action (`src/schemas/admissions-cold.ts`) to see the canonical key, then extract just that key for the member-safe shape. **Do not return the entire `admission_details` blob** — only the application text field.

5. **Register in `src/dispatch.ts`**: add `import './schemas/admissions-self.ts';` to the import block around line 48.

### Phase 6: Quotas and snapshot

1. **`QUOTA_ENTITY_KINDS`** (`src/clubs/index.ts:213`): add `'gift'` to the `'content.create'` array:
   ```typescript
   'content.create': ['post', 'opportunity', 'service', 'ask', 'gift'],
   ```
   Without this, gift creations don't count toward the daily quota and don't appear in `quotas.getUsage` reporting.

2. **Schema snapshot**: regenerate if the project has one. Look for a checked-in `schema.json` or similar. Run any snapshot-update script.

### Phase 7: Tests

Tests are written *to the invariants*, not just to the surface area. Each invariant gets at least one test that would fail if the invariant were broken.

**`test/integration/content.test.ts`:**

- Create `kind: "gift"` → succeeds, `openLoop` is `true` in the response (invariant 2).
- Create `kind: "post"` → succeeds, `openLoop` is `null` (invariant 2).
- Direct SQL insert into `entities` of `kind = 'ask'` with `open_loop = NULL` → fails the CHECK constraint (invariant 2).
- Direct SQL insert into `entities` of `kind = 'post'` with `open_loop = true` → fails the CHECK constraint (invariant 2).
- `content.closeLoop` on a gift → succeeds, idempotent, no longer in default `content.list`.
- `content.closeLoop` on a closed gift → idempotent success.
- `content.closeLoop` on a `post` → 404 (invariant 3 — `open_loop IS NOT NULL` filter fails).
- `content.closeLoop` on a removed gift → 404 (invariant 3).
- `content.closeLoop` on another member's gift → 404 (invariant 4 — *not* 403; the author SQL filter returns null first).
- `content.list` defaults exclude closed loops.
- `content.list` with `includeClosed: true` returns the actor's own closed loops.
- `content.list` with `includeClosed: true` does **not** return another member's closed loops in the same club (invariant 7 — privacy regression test).
- `content.searchBySemanticSimilarity` does not return closed loops to non-author callers.
- `content.list` always includes `post` entities regardless of the closed-loop filter (because `open_loop IS NULL` passes).

**Synchronicity / matching tests:**

- New gift entity triggers `offer_to_ask` matches against existing asks (invariant 1 — would fail in v1 because gifts weren't in the offer branch).
- Closed gift no longer triggers `offer_to_ask` matching at trigger time (invariant 6).
- Pending match is not delivered if its source entity has been closed since the match was created (invariant 6).
- A gift that gets a match, then is closed (matches expired), then is reopened, can match the same recipient again on the next worker pass (invariants 5 and 11 — would fail in v2 because reopen didn't emit an activity row).
- **Reopen end-to-end:** ask A gets matched to member M, closed, reopened, and then on the next worker pass ask A produces a new `ask_to_member` match to M. This is the regression test for invariant 11 — would fail in v2 because no activity row was emitted and the worker never revisited the ask.
- **Idempotent no-op reopen:** reopening an already-open loop does *not* emit a new activity row and does *not* delete any matches. Verify by counting `club_activity` rows before and after.
- **offer_to_ask cleanup on ask close:** offer O is published, matches ask A (creates an `offer_to_ask` row with `source_id = O`, `payload.matchedAskEntityId = A`, state `pending`). Ask A is closed. The `offer_to_ask` row transitions to `expired` (regression test for invariant 12 — would fail in v2 because the close SQL only looked at `source_id = A`).
- **offer_to_ask cleanup on ask reopen:** same setup, but after close, reopen ask A. The `offer_to_ask` row is *deleted* (not just re-expired), so the worker's next pass can create a fresh one. Regression test for invariants 5 and 12.
- An ask with a passed `expires_at` is not returned as a candidate by `findAskMatchingOffer` (invariant 9).

**`updates.list` feed filter tests (invariant 13):**

- Signal is delivered to member M for ask A (unacknowledged). Ask A is closed. `updates.list` called by M no longer returns that signal.
- Signal is delivered to member M for offer O matched to ask A (unacknowledged). Ask A (the *matched* ask, not the offer) is closed. `updates.list` called by M no longer returns that signal. Regression test for the "both sides of `offer_to_ask` must be open" clause in invariant 13.
- Same setup, but offer O is the one closed instead of ask A. Also filtered out.
- Non-signal update rows (club activity, DM inbox) are unaffected by the loop-state filter.
- Reopening a closed loop whose signals were filtered out: the historical delivered signal is *not* resurfaced (the recipient already missed the window; new matches will be produced by the worker on the next pass per invariant 11).

**Semantic search tests (invariant 7 second paragraph):**

- Author searches for their own closed loop via `content.searchBySemanticSimilarity` → does *not* return it. This is the regression test that resolves the v2 contradiction.
- Author searches for their own *open* loop → returns it as expected.

**`test/integration/admissions-self.test.ts` (new file):**

- `admissions.getMine` returns the member's own admission records.
- `admissions.getMine` with `clubId` filters to one club.
- The response shape contains only the member-safe fields — explicitly assert it does not include `notes`, `metadata`, `sponsor`, `intake`, `membershipId`, or the full `admissionDetails` blob (invariant 8 — privacy regression test).
- A member cannot read another member's admissions (no `memberId` parameter accepted).
- The application text (with gifts in it) is included in the response.

## Out of scope

- **WHY field on entities.** Deferred. See `docs/new_feature_dreaming.md` — has real privacy implications, separate design conversation.
- **`member.tell()`.** Deferred. Needs more design work.
- **Location and travel synchronicity.** Next feature, separate plan.
- **Reasoning layer / Club Mind worker.** Bigger architectural decision, separate plan.
- **Clubadmin closing other members' loops.** Defer until we have a moderation use case.
- **Reason field on closeLoop.** Defer until we know members want it.
- **`content.update` modifying loop state.** No — loop state is changed only via the dedicated `closeLoop`/`reopenLoop` actions to keep the audit and the SQL author-filter discipline clean.

## SKILL.md updates (Claude will apply these on Owen's command)

These edits go to `SKILL.md` and get applied by Claude (the conversational agent), not the implementing agent. Drafted here so they can be reviewed alongside the rest of the plan.

### 1. Add to the Content action group (around `SKILL.md:70`)

```
- `content.closeLoop` — close an open loop on an ongoing ask/gift/service/opportunity (author only)
- `content.reopenLoop` — reopen a previously-closed loop (author only)
```

### 2. Add to the Admissions action group (around `SKILL.md:64`)

```
- `admissions.getMine` — read your own admission record(s) (application text, status, club, timestamps)
```

### 3. Replace the entity kinds line (`SKILL.md:236`)

**Current:**
> Entity kinds: `post`, `opportunity`, `service`, `ask`

**Replace with:**
> Entity kinds: `post`, `ask`, `gift`, `service`, `opportunity` (see "Content kinds" below for what each one means and when to use it).

### 4. Insert a new "Content kinds" subsection right after `## What exists in the system` (after `SKILL.md:246`)

```markdown
## Content kinds

Five kinds via `content.create`. Pick the right one:

- **`post`** — a generic update or article share. No lifecycle, no loop. Use when nothing else fits.
- **`ask`** — a request for help, intro, or advice. Open loop by default — stays an active match candidate until the member calls `closeLoop`.
- **`gift`** — a free offering, given without expectation of payment. *"I'll spend an hour with any first-time founder stuck on incorporating."* Distinct from `service` because there's no money involved. Open loop by default.
- **`service`** — a paid professional offering, often with a rate. *"Fractional CTO advisory, $X/hour."* Distinct from `gift` because money is involved. Open loop by default.
- **`opportunity`** — a structured opening someone could apply for or take. Job posting, residency, fellowship, board seat. Open loop by default.

Events are a separate primitive (`events.create`), not a content kind.
```

### 5. Insert a new "Open loops" subsection in `## Interaction patterns`

```markdown
### Open loops

Some content kinds — `ask`, `gift`, `service`, `opportunity` — represent ongoing things that the synchronicity engine should keep watching until the member says they're done. These are *open loops*. The engine treats open loops as live match candidates indefinitely. Closed loops are excluded from listings and from matching.

When the member is done — they found the person, they filled the role, they're no longer offering the gift — call `content.closeLoop(entityId)`. The entity stays in the database but stops being surfaced. If the member changes their mind, `content.reopenLoop(entityId)` puts it back in circulation and lets the engine generate fresh matches.

Posts have no loop concept. Calling `closeLoop` on a post returns 404.

When the member tells you something like *"I found the person for that ask"* or *"I'm not offering that anymore,"* offer to close the loop. Don't close loops without confirmation — push back gently if the member is uncertain.

By default `content.list` excludes closed loops. Pass `includeClosed: true` to show the member their own closed history. (Other members' closed loops are never visible regardless of this flag.)
```

### 6. Insert a new "Gifts" subsection in `## Interaction patterns`

```markdown
### Gifts

Gifts are a content kind. They're free offerings, distinct from `service` (which is paid professional). The same person might bring different gifts to different clubs — clairvoyance in a spiritual club, code reviews in a tech club. Gifts are scoped per-club because they're entities.

When a member joins a new club, encourage them to think of one or two specific, meaningful gifts. **Never insist on a number** — most people will struggle to think of even one, and forcing more produces filler. *"Even one specific, meaningful gift is more valuable than a list of vague ones."*

A good gift is concrete and actionable: *"I'll spend an hour with any first-time founder stuck on incorporating"* — not *"networking"* or *"advice"* or *"support."* Push back on vague gifts.

Each gift is posted as `content.create` with `kind: "gift"`. Gifts are open loops by default and stay alive until the member calls `closeLoop`. Don't set an `expiresAt` on gifts unless the member explicitly says it's time-bounded.
```

### 7. Update the application flow guidance (current `SKILL.md:200` and `SKILL.md:322`)

Both the upper "Path 2: Self-applied" and the lower "Apply to join a club" sections get the same change to step 3 (or equivalent step):

> Collect `name`, `email`, `socials`, and `application`. The application text should contain (a) the free-text response to the club's admission policy, and (b) one or more gifts the applicant intends to bring to the community, listed under a `Gifts I bring:` heading at the end. Don't insist on a fixed number of gifts — see "Gifts" under Interaction patterns.

### 8. Insert a new subsection for the post-admission gift flow in `## Interaction patterns`

```markdown
### First session after admission: turn application gifts into entities

When a member starts their first session in a club they were just admitted to, call `admissions.getMine` filtered by `clubId` for that club. Use the most recent admission record for that specific club — don't pull arbitrary old records.

Look for the gifts the applicant listed under the `Gifts I bring:` heading in the application text. For each gift, confirm with the member: *"You mentioned you wanted to offer [gift] when you applied. Should I post that as a gift to [club]?"* — and on confirmation, post it as `content.create` with `kind: "gift"` and `clubId` set to the new club.

This turns their stated commitment into real, matchable content. If the member has changed their mind about a gift, drop it. If they want to add a new one, take it. The application is a starting point, not a contract.

If the member listed no gifts in their application, prompt them gently: *"What's one thing you'd be happy to give freely to this community?"* — see "Gifts" for the framing.
```

## Open questions for Owen (not blocking the implementer)

These are decisions that affect either future iteration or marketing copy, not the code in this plan:

1. Do we want a `content.list` filter for "only my closed loops" specifically (for "show me everything I've resolved this month")? Could be a future small addition. Not in scope here.

2. Should we add a soft cap on gifts per member per club (e.g., 10) to prevent flooding? Probably not for v1 — quotas already cap creation rate, and the SKILL.md guidance discourages spamming. Watch for abuse and add later if needed.

## v3 resolved decisions (previously open)

The v2 plan left these as open questions for Owen. v3 records the answers so the implementer has no ambiguity:

- **Does `reopenLoop` produce a `club_activity` row?** **Yes** — it must (invariant 11). Without it, the worker never revisits the reopened entity and reopen is functionally inert. v2 incorrectly deferred this; v3 treats it as a required side-effect of a `false → true` transition. Close does *not* emit a `club_activity` row — only reopen does, because close doesn't need the worker to do anything (the delivery-time guards in invariant 6 handle it).

- **Should closing a loop hide already-delivered but unread signals from `updates.list`?** **Yes** (invariant 13). "Stops being surfaced" has to mean the feed stops showing it too, otherwise closed loops linger as ghosts in people's unread inboxes.

- **Should semantic search return the author's own closed loops?** **No** (invariant 7, second paragraph). Keeps search behavior simple and privacy-safe by default. Authors who want their own history use `content.list` with `includeClosed: true`.
